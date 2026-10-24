#!/usr/bin/env node
/**
 * Chunked import client — SPEC-0003 §2.6 producer side.
 *
 * Drives the async chunked import channel: splits a local repository's
 * history into self-contained-per-window packs (topo-ordered commit windows,
 * the SPEC §2.6 shape), uploads them through the Worker-relayed chunk
 * endpoint, starts the import with a validated manifest, and polls until the
 * server lands the refs.
 *
 * Zero npm dependencies: plain `git` plumbing + Node's global fetch/crypto.
 * Node >= 18 required.
 *
 * HOW THE WINDOWS WORK
 * --------------------
 *   git rev-list --topo-order --reverse <refs…>     # oldest → newest
 *   tips = every Nth commit + every ref tip          # §2.7's window shape
 *
 * Window i packs `reachable(tip_i) \ reachable(tip_{i-1})` via
 * `git pack-objects --revs --stdin` (non-thin: every delta base is inside
 * the pack), so window i's objects reference only each other or objects
 * already indexed from windows 1..i-1 — the server's per-chunk connectivity
 * anti-check accepts exactly that. Each chunk's manifest entry carries the
 * window tip as `tip`: the server creates a temporary ref at it, which makes
 * the engine's own connectivity verdict the chunk's verdict. The final
 * window packs everything the ref tips still need (annotated tag objects
 * included) relative to the last window tip.
 *
 * USAGE
 * -----
 *   node scripts/import-client.mjs --repo /path/to/source.git \
 *        --url https://your-host.example \
 *        --target owner/repo \
 *        --token <API token with write:repository scope> \
 *        [--window 500] [--head main] [--api /api/v1]
 *
 * The tool holds one chunk in memory at a time; with the server default cap
 * (512 MiB) budget accordingly. If a window pack exceeds the server's chunk
 * cap, rerun with a smaller --window.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(code = 2) {
  console.error(`usage: node scripts/import-client.mjs --repo <path> --url <base> --target <owner/repo>
                 --token <api-token> [--window 500] [--head <branch>] [--api /api/v1] [--yes]`);
  process.exit(code);
}

const args = process.argv.slice(2);
const opt = { window: 500, api: "/api/v1", head: null, yes: false };
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  switch (key) {
    case "--repo": opt.repo = args[++i]; break;
    case "--url": opt.url = args[++i]?.replace(/\/+$/, ""); break;
    case "--target": opt.target = args[++i]; break;
    case "--token": opt.token = args[++i]; break;
    case "--window": opt.window = Number.parseInt(args[++i], 10); break;
    case "--head": opt.head = args[++i]; break;
    case "--api": opt.api = args[++i]; break;
    case "--yes": opt.yes = true; break;
    default: usage();
  }
}
if (!opt.repo || !opt.url || !opt.target || !opt.token || !Number.isInteger(opt.window) || opt.window < 1) usage();
if (!/^[^/\s]+\/[^/\s]+$/.test(opt.target)) usage();

const apiBase = `${opt.url}${opt.api}`;
const [owner, repo] = opt.target.split("/");

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

async function git(...argv) {
  const { stdout } = await run("git", ["-C", opt.repo, ...argv], { maxBuffer: 1 << 28 });
  return stdout;
}

/** All heads+tags as {ref, oid} — %(objectname) is the TAG object oid for
 *  annotated tags, exactly what the manifest.refs map must declare. */
async function listRefs() {
  const out = await git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags");
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const sp = line.lastIndexOf(" ");
      return { ref: line.slice(0, sp), oid: line.slice(sp + 1) };
    });
}

/** One window's pack via pack-objects; returns {bytes, sha1} where sha1 is
 *  the pack trailer digest (= git's own pack name). revLines are revision
 *  arguments (`<tip>`, `^<prev>`, ref names). Empty windows (0 objects,
 *  32-byte header+trailer-only pack) return null — nothing to upload. */
async function buildWindow(revLines) {
  const child = run("git", ["-C", opt.repo, "pack-objects", "--revs", "--stdout"], {
    maxBuffer: Infinity,
    encoding: "buffer",
  });
  // pack-objects --revs reads the revision arguments from stdin.
  child.child.stdin.end(revLines.join("\n") + "\n");
  const pack = (await child).stdout;
  if (pack.length <= 32) return null; // header+trailer only: the window added nothing
  const sha1 = createHash("sha1").update(pack).digest("hex");
  return { bytes: pack, sha1, size: pack.length };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function api(method, path, { token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(token !== undefined ? { authorization: `token ${token}` } : {}),
      ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return raw ? res : res.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// the flow (§2.6): create → upload chunks → start → poll
// ---------------------------------------------------------------------------

const refs = await listRefs();
if (refs.length === 0) {
  console.error("source repository has no refs to import");
  process.exit(1);
}

const commits = (await git("rev-list", "--topo-order", "--reverse", ...refs.map((r) => r.ref)))
  .split("\n")
  .filter((line) => line.trim() !== "");
console.log(`source: ${commits.length} commits across ${refs.length} refs`);

// Window tips: every Nth commit (topo-reverse) + every ref tip not already
// present, deduped in order. Any tip order stays connectivity-correct (each
// window is a delta against the union of the previous ones); topo order just
// keeps windows disjoint.
const tipSet = new Set();
const tips = [];
commits.forEach((oid, i) => {
  if ((i + 1) % opt.window === 0 && !tipSet.has(oid)) {
    tipSet.add(oid);
    tips.push(oid);
  }
});
for (const r of refs) {
  if (!tipSet.has(r.oid)) {
    tipSet.add(r.oid);
    tips.push(r.oid);
  }
}

const head = opt.head ?? (await git("symbolic-ref", "--short", "HEAD")).trim();
if (!refs.some((r) => r.ref === `refs/heads/${head}`)) {
  console.error(`--head ${head} is not a branch of the source repository`);
  process.exit(1);
}

console.log(`plan: ${tips.length} window(s) of ≤ ${opt.window} commits, head=${head}`);
if (!opt.yes) {
  process.stdout.write("proceed? [yN] ");
  const answer = await new Promise((resolve) => process.stdin.once("data", (d) => resolve(String(d).trim().toLowerCase())));
  if (answer !== "y" && answer !== "yes") process.exit(1);
}

// 1. create — the response carries the ONE-TIME import token.
const created = await api("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/imports`, {
  token: opt.token,
  body: "{}",
});
const importId = created.import_id;
const importToken = created.import_token;
const chunkCap = created.chunk_size_cap;
console.log(`import ${importId} created (chunk cap ${(chunkCap / (1024 * 1024)).toFixed(0)} MiB)`);

// 2. upload the windows, oldest first.
const manifestChunks = [];
let finalTip = null;
for (let i = 0; i < tips.length; i++) {
  const prev = i > 0 ? tips[i - 1] : null;
  const last = i === tips.length - 1;
  // The final window covers everything the REF TIPS still need relative to
  // the last commit-window tip (annotated tag objects ride ref names). Its
  // `tip` must be an object the pack actually carries: the first ref tip NOT
  // reachable from the previous tip (all-ancestral refs mean an empty final
  // pack, which pack-objects' 32-byte output makes `buildWindow` skip).
  if (last && prev !== null && finalTip === null) {
    for (const r of refs) {
      const covered = await run("git", ["-C", opt.repo, "merge-base", "--is-ancestor", r.oid, prev])
        .then(() => true)
        .catch(() => false);
      if (!covered) {
        finalTip = r.oid;
        break;
      }
    }
  }
  const revLines = last ? [...refs.map((r) => r.ref)] : [tips[i]];
  if (prev !== null) revLines.push(`^${prev}`);
  const pack = await buildWindow(revLines);
  if (pack === null) continue; // window added nothing (e.g. tip == prev tip)
  if (pack.size > chunkCap) {
    console.error(
      `window ${i} produced ${(pack.size / (1024 * 1024)).toFixed(0)} MiB > server cap ${(chunkCap / (1024 * 1024)).toFixed(0)} MiB — rerun with a smaller --window`,
    );
    process.exit(1);
  }
  await api("PUT", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/imports/${importId}/chunks/${manifestChunks.length}`, {
    headers: {
      "x-import-token": importToken,
      "content-type": "application/octet-stream",
      "content-length": String(pack.size),
      "x-chunk-sha1": pack.sha1,
    },
    body: pack.bytes,
    raw: true,
  });
  console.log(
    `chunk ${manifestChunks.length}: ${i + 1}/${tips.length} windows, ${pack.size} bytes, sha1 ${pack.sha1}`,
  );
  manifestChunks.push({ n: manifestChunks.length, bytes: pack.size, sha1: pack.sha1, tip: last ? (finalTip ?? refs[0].oid) : tips[i] });
}

if (manifestChunks.length === 0) {
  console.error("nothing to import (every window was empty)");
  await api("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/imports/${importId}/abort`, {
    token: opt.token,
    body: "{}",
  });
  process.exit(1);
}

// 3. start — the server validates the manifest against the uploads and
// enqueues one indexing message per chunk.
const manifest = {
  head,
  refs: Object.fromEntries(refs.map((r) => [r.ref, r.oid])),
  chunks: manifestChunks,
  totalBytes: manifestChunks.reduce((sum, c) => sum + c.bytes, 0),
};
const started = await api("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/imports/${importId}/start`, {
  token: opt.token,
  body: JSON.stringify(manifest),
});
console.log(`import started: ${started.queued_chunks.length} chunk(s) queued`);

// 4. poll to done/failed.
for (;;) {
  await sleep(2000);
  const status = await api("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/imports/${importId}`, {
    token: opt.token,
  });
  const done = (status.manifest?.chunks ?? []).filter((c) => c.status === "done").length;
  console.log(`state=${status.state} chunks=${done}/${manifest.chunks.length} bytes=${status.total_bytes}`);
  if (status.state === "done") {
    console.log(`import complete: clone at ${opt.url}/${owner}/${repo}.git`);
    break;
  }
  if (status.state === "failed") {
    console.error(`import failed: ${status.error}`);
    if (status.manifest) {
      for (const c of status.manifest.chunks) {
        if (c.status === "failed") console.error(`  chunk ${c.n}: ${c.error ?? "failed"}`);
      }
      console.error("fix the cause, re-upload the failed chunk if needed, and POST start again to resume.");
    }
    process.exit(1);
  }
}

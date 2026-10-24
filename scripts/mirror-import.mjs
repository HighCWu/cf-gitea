#!/usr/bin/env node
/**
 * mirror-import.mjs — the SPEC-0009 import-from-URL producer (the mirror-clone
 * client). Mirrors an external git URL into an empty cf-gitea repository by
 * driving the SPEC-0003 §2.6 async chunked import channel with real git:
 *
 *   git clone --mirror <source>            # full ref copy into a temp dir
 *   git rev-list --topo-order --reverse    # oldest → newest commit walk
 *   git pack-objects --revs --stdout       # one self-contained (non-thin)
 *                                          # pack per byte-budgeted window
 *   POST   /api/v1/repos/{o}/{r}/imports   # {import_id, import_token,
 *                                          #  chunk_size_cap, upload}
 *   PUT    <upload>.{n}                    # relay chunk upload (import token,
 *                                          #  Content-Length, X-Chunk-Sha1)
 *   POST   …/imports/{id}/start            # manifest {head, refs, chunks,
 *                                          #  totalBytes}; server validates
 *   GET    …/imports/{id}                  # poll until done | failed
 *   git ls-remote <target>                 # acceptance check: refs match
 *
 * WINDOW SHAPE (same contract as scripts/import-client.mjs, byte-budgeted
 * instead of commit-counted): window i packs reachable(tip_i) \
 * reachable(tip_{i-1}) — a disjoint slice of the topo-ordered commit walk —
 * plus final window(s) carrying everything the *ref tips* still need
 * (annotated tag objects, non-commit ref targets) relative to the last
 * boundary. Packs are non-thin, so window i's deltas reference only in-pack
 * objects or objects already indexed from windows 1..i-1: exactly what the
 * server's per-chunk connectivity verdict (temp ref at the chunk tip) accepts,
 * in any delivery order. A single commit that alone exceeds the budget cannot
 * be split; the run warns and lets the server's chunk cap be the authority.
 *
 * SOURCE AUTH: --source-token is injected as `http.extraHeader=Authorization:
 * Bearer …` git config for the clone — never spliced into the URL (SPEC-0009
 * §2.2 posture). Source URLs must be https:// (local paths / file:// are
 * accepted under --dry-run only, which talks to no server).
 *
 * RESUME: chunk uploads authenticate with the ONE-TIME import token (shown
 * once at create, §3.1). Save it (--import-token on a later run) to re-upload
 * missing/failed chunks. Without it, resume can still finish an import whose
 * staged chunks all match a rebuilt plan, or recover by aborting the old
 * import and starting a fresh one (full re-upload).
 *
 * Zero npm dependencies: plain git plumbing + Node's global fetch/crypto.
 * Node >= 18. One window pack is held in memory at a time (≤ the chunk cap;
 * lower --window-bytes on constrained machines).
 *
 * USAGE
 * -----
 *   node scripts/mirror-import.mjs --source <https-git-url> \
 *        --target <our-origin-base-url> --user <owner> --token <PAT> \
 *        [--name <repo>] [--source-token <tok>] [--branch-filter <glob>]
 *        [--window-bytes 512m] [--head <branch>] [--timeout 3600]
 *        [--resume <import_id>] [--import-token <imp_…>] [--dry-run]
 *        [--out <file>] [--pack-dir <dir>] [--api /api/v1] [--keep-temp] [--yes]
 *
 * Exit codes: 0 success · 1 failure (clone/plan/upload/poll/verify) ·
 * 2 usage · 130 interrupted (the import is aborted best-effort on Ctrl-C).
 */
/* global fetch, AbortSignal -- Web globals provided by Node >= 18 (no node: module exports them) */
import { execFile, spawn } from "node:child_process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { URL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// limits mirrored from the server (apps/worker/src/repos/imports/service.ts)
// ---------------------------------------------------------------------------

const MAX_REFS = 10_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Server default chunk cap (512 MiB) — also the default window budget. */
const DEFAULT_WINDOW_BYTES = 512 * 1024 * 1024;

const CLONE_TIMEOUT_MS = 30 * 60 * 1000;
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const API_TIMEOUT_MS = 60 * 1000;
const CHUNK_PUT_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(code = 2) {
  console.error(`usage: node scripts/mirror-import.mjs --source <https-git-url> --target <base-url>
                 --user <owner> --token <pat> [--name <repo>] [--source-token <tok>]
                 [--branch-filter <glob>] [--window-bytes 512m] [--head <branch>]
                 [--timeout 3600] [--resume <import_id>] [--import-token <imp_…>]
                 [--dry-run] [--out <file>] [--pack-dir <dir>] [--api /api/v1]
                 [--keep-temp] [--yes]`);
  process.exit(code);
}

function parseBytes(raw) {
  const m = /^(\d+)([kmg])?$/i.exec(String(raw).trim());
  if (!m) return null;
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]?.toLowerCase()] ?? 1;
  const value = Number(m[1]) * mult;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const args = process.argv.slice(2);
const opt = {
  api: "/api/v1",
  windowBytes: DEFAULT_WINDOW_BYTES,
  timeoutSec: 3600,
  dryRun: false,
  keepTemp: false,
  yes: false,
};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  const value = () => {
    if (i + 1 >= args.length) usage();
    return args[++i];
  };
  switch (key) {
    case "--source": opt.source = value(); break;
    case "--target": opt.target = value().replace(/\/+$/, ""); break;
    case "--user": opt.user = value(); break;
    case "--name": opt.name = value(); break;
    case "--token": opt.token = value(); break;
    case "--source-token": opt.sourceToken = value(); break;
    case "--branch-filter": opt.branchFilter = value(); break;
    case "--window-bytes": {
      const parsed = parseBytes(value());
      if (parsed === null) {
        console.error("error: --window-bytes must be a positive byte count (e.g. 512m)");
        process.exit(2);
      }
      opt.windowBytes = parsed;
      break;
    }
    case "--head": opt.head = value(); break;
    case "--timeout": opt.timeoutSec = Number(value()); break;
    case "--resume": opt.resume = Number(value()); break;
    case "--import-token": opt.importToken = value(); break;
    case "--dry-run": opt.dryRun = true; break;
    case "--out": opt.out = value(); break;
    case "--pack-dir": opt.packDir = value(); break;
    case "--api": opt.api = value(); break;
    case "--keep-temp": opt.keepTemp = true; break;
    case "--yes": opt.yes = true; break;
    case "-h": case "--help":
      console.log("see scripts/mirror-import.README.md");
      process.exit(0);
      break;
    default: usage();
  }
}

const needsServer = !opt.dryRun;
if (needsServer && (!opt.target || !opt.user || !opt.token)) usage();
if (!opt.source) usage();
if (opt.resume !== undefined && (opt.dryRun || !Number.isInteger(opt.resume) || opt.resume < 1)) usage();
if (!Number.isFinite(opt.timeoutSec) || opt.timeoutSec <= 0) usage();

// Source URL rules (SPEC-0009 §2.2 posture): credentials only ever arrive via
// --source-token, never in the URL; https only — except under --dry-run,
// which talks to no server and accepts a local path / file:// fixture.
let sourceUrl;
try {
  sourceUrl = new URL(opt.source);
} catch {
  sourceUrl = null; // bare local path (dry-run fixture case)
}
if (sourceUrl !== null && (sourceUrl.username !== "" || sourceUrl.password !== "")) {
  console.error("error: credentials in the source URL are rejected — pass --source-token instead");
  process.exit(2);
}
if (needsServer && (sourceUrl === null || sourceUrl.protocol !== "https:")) {
  console.error("error: --source must be an https:// git URL (local paths are only valid with --dry-run)");
  process.exit(2);
}
if (opt.sourceToken !== undefined && opt.sourceToken.includes("\n")) {
  console.error("error: --source-token must be a single-line value");
  process.exit(2);
}

const repoName =
  opt.name ??
  (sourceUrl !== null ? sourceUrl.pathname : opt.source).split("/").filter(Boolean).pop()?.replace(/\.git$/, "");
if (!repoName || !/^[A-Za-z0-9_.-]{1,100}$/.test(repoName) || repoName.startsWith(".")) {
  console.error("error: cannot derive a repository name from the source — pass --name <repo>");
  process.exit(2);
}
const apiBase = `${opt.target ?? ""}${opt.api}`;
const fmtMiB = (b) => `${(b / 2 ** 20).toFixed(2)} MiB`;

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

let tempDir = null;
const liveChildren = new Set();

/** git environment: never prompt (a hanging credential prompt is the classic
 *  CLI hang), and ignore replace refs so the walk sees the true history
 *  (refs/replace/* is still transferred as a plain ref). */
function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" };
}

/** Run a git plumbing command. `stdinData` is written to the child's stdin
 *  and the pipe closed (rev-list --stdin reads revisions from it) — execFile's
 *  async `input` option is not honored, so the child handle is driven here. */
async function git(gitDir, argv, { timeoutMs = GIT_TIMEOUT_MS, allowFailure = false, stdinData } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-C", gitDir, ...argv],
      { maxBuffer: 1 << 28, timeout: timeoutMs, env: gitEnv() },
      (error, stdout, stderr) => {
        if (error === undefined || error === null) {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        if (allowFailure) {
          resolve(null);
          return;
        }
        const tail = String(stderr ?? "").trim().split("\n").slice(-4).join("\n");
        const failure = new Error(`git ${argv[0]} failed: ${tail || error.message}`, { cause: error });
        reject(failure);
      },
    );
    if (stdinData !== undefined) child.stdin.end(stdinData);
  });
}

/** One window's pack via `pack-objects --revs --stdout` (non-thin: every
 *  delta base is inside the pack). revLines are revision arguments (`<tip>`,
 *  `^<exclusion>`, ref names). Returns null for an empty window (header +
 *  trailer only, ≤ 32 bytes) — nothing to upload. */
async function buildPack(gitDir, revLines) {
  const child = spawn("git", ["-C", gitDir, "pack-objects", "--revs", "--stdout"], {
    env: gitEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  liveChildren.add(child);
  const parts = [];
  let stderr = "";
  child.stdout.on("data", (chunk) => parts.push(chunk));
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git pack-objects failed (exit ${code}): ${stderr.trim()}`));
    });
  });
  child.stdin.end(revLines.join("\n") + "\n");
  try {
    await done;
  } finally {
    liveChildren.delete(child);
  }
  const buf = Buffer.concat(parts);
  if (buf.length <= 32) return null; // header+trailer only: the window added nothing
  // Pack digest, git's own convention: sha1 over everything BEFORE the
  // 20-byte trailer — the value `git index-pack` names the pack after.
  const sha1 = createHash("sha1").update(buf.subarray(0, buf.length - 20)).digest("hex");
  return { buf, sha1, bytes: buf.length };
}

// ---------------------------------------------------------------------------
// ref enumeration + window planning
// ---------------------------------------------------------------------------

/** Simple branch glob: `*` (no `/`), `**` (anything), `?` (one non-`/`).
 *  Comma-separated patterns are alternations. Matched against the bare
 *  branch name (`main`, `release/1.x`). */
function branchFilterMatcher(glob) {
  const regexes = glob
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pattern) => {
      let re = "";
      for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "*") {
          if (pattern[i + 1] === "*") {
            re += ".*";
            i++;
          } else re += "[^/]*";
        } else if (c === "?") re += "[^/]";
        else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
      return new RegExp(`^${re}$`);
    });
  return (branch) => regexes.some((re) => re.test(branch));
}

/** All refs under refs/ (the mirror clone carries the source's whole
 *  namespace) as {ref, oid}. %(objectname) is the TAG object oid for
 *  annotated tags — what manifest.refs must declare. --branch-filter only
 *  narrows refs/heads/*; every other namespace rides along (mirror parity). */
async function listRefs(gitDir, filter) {
  const out = (await git(gitDir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/"])).stdout;
  const refs = out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const sp = line.lastIndexOf(" ");
      return { ref: line.slice(0, sp), oid: line.slice(sp + 1) };
    });
  if (filter === undefined) return refs;
  const match = branchFilterMatcher(filter);
  return refs.filter(({ ref }) => !ref.startsWith("refs/heads/") || match(ref.slice("refs/heads/".length)));
}

/** manifest.head — the server adopts it as the default branch, so it must
 *  name an included branch (validateManifest requires refs/heads/<head>). */
async function resolveHead(gitDir, refs, explicit) {
  const branches = refs.filter((r) => r.ref.startsWith("refs/heads/"));
  const branchName = (r) => r.ref.slice("refs/heads/".length);
  let head = null;
  if (explicit !== undefined) {
    if (!branches.some((r) => branchName(r) === explicit)) {
      throw new Error(`--head ${explicit} is not an included branch of the source`);
    }
    head = explicit;
  } else {
    const symref = (await git(gitDir, ["symbolic-ref", "--short", "HEAD"], { allowFailure: true }))?.stdout?.trim();
    if (symref && branches.some((r) => branchName(r) === symref)) {
      head = symref;
    } else if (branches.length > 0) {
      head = branchName(branches[0]);
      console.error(`note: source HEAD is not an included branch; defaulting head to ${head}`);
    }
  }
  if (head === null) {
    throw new Error("no branch remains to import — the import channel requires at least one branch (refs/heads/*)");
  }
  return head;
}

/** The topo-ordered, oldest-first commit walk over every included ref.
 *  Ref names ride stdin (argv would hit length limits on ref-heavy repos). */
async function listCommits(gitDir, refs) {
  const out = (
    await git(gitDir, ["rev-list", "--topo-order", "--reverse", "--stdin"], {
      stdinData: refs.map((r) => r.ref).join("\n") + "\n",
    })
  ).stdout;
  return out.split("\n").filter((line) => line.trim() !== "");
}

/** True when `candidate` is reachable from `from` (a cheap merge-base probe;
 *  exit 0 = ancestor, non-zero → allowFailure resolves null). */
async function isAncestor(gitDir, candidate, from) {
  return (await git(gitDir, ["merge-base", "--is-ancestor", candidate, from], { allowFailure: true })) !== null;
}

// ---------------------------------------------------------------------------
// window building (topo-ordered, byte-budgeted, self-contained)
// ---------------------------------------------------------------------------

/**
 * Build the packs for one commit range [start, end) of the topo-reverse walk
 * (positive rev = last commit of the range, negative = last commit before
 * it). If the pack exceeds `budget` and the range spans >1 commit, the range
 * bisects and both halves rebuild — so every emitted window is within budget
 * unless a SINGLE commit alone exceeds it (un-splittable; warn and pass
 * through — the server's chunk cap is the hard authority).
 */
async function buildCommitRange(gitDir, commits, start, end, budget) {
  const revLines = [commits[end - 1]];
  if (start > 0) revLines.push(`^${commits[start - 1]}`);
  const pack = await buildPack(gitDir, revLines);
  if (pack === null) return [];
  if (pack.bytes > budget && end - start > 1) {
    console.error(`window [${start},${end}) packed ${fmtMiB(pack.bytes)} > budget ${fmtMiB(budget)} — bisecting`);
    const mid = (start + end) >> 1;
    const lo = await buildCommitRange(gitDir, commits, start, mid, budget);
    const hi = await buildCommitRange(gitDir, commits, mid, end, budget);
    return [...lo, ...hi];
  }
  if (pack.bytes > budget) {
    console.error(
      `warning: single commit ${commits[end - 1].slice(0, 12)} packs ${fmtMiB(pack.bytes)} > budget ` +
        `${fmtMiB(budget)} — cannot split; the server chunk cap decides`,
    );
  }
  return [{ ...pack, tip: commits[end - 1] }];
}

/**
 * The final window(s): everything the ref tips still need relative to the
 * last boundary — annotated tag objects, non-commit ref targets, commits past
 * the boundary. Split by ref subsets when oversize (each subset is itself a
 * connected delta). The chunk tip must be a commit IN the pack: pick the
 * first included ref tip not already reachable from the exclusion boundary.
 */
async function buildFinalWindows(gitDir, refs, excludeTip, budget) {
  const revLines = refs.map((r) => r.ref);
  if (excludeTip !== null) revLines.push(`^${excludeTip}`);
  const pack = await buildPack(gitDir, revLines);
  if (pack === null) return [];
  if (pack.bytes > budget && refs.length > 1) {
    console.error(`final window packed ${fmtMiB(pack.bytes)} > budget — splitting by ref subsets`);
    const half = Math.ceil(refs.length / 2);
    const lo = await buildFinalWindows(gitDir, refs.slice(0, half), excludeTip, budget);
    const hi = await buildFinalWindows(gitDir, refs.slice(half), excludeTip, budget);
    return [...lo, ...hi];
  }
  let tip = null;
  for (const r of refs) {
    const candidate = r.ref.startsWith("refs/heads/")
      ? r.oid
      : (
          await git(gitDir, ["rev-parse", "--verify", "--quiet", `${r.ref}^{commit}`], { allowFailure: true })
        )?.stdout?.trim() || null;
    if (candidate !== null && (excludeTip === null || !(await isAncestor(gitDir, candidate, excludeTip)))) {
      tip = candidate;
      break;
    }
  }
  if (tip === null) {
    tip = refs[0].oid; // degenerate: fully-excluded tips; the server only needs 40-hex
    console.error("warning: no in-window commit tip for the final window — using the first ref tip");
  }
  if (pack.bytes > budget) {
    console.error(`warning: final window packs ${fmtMiB(pack.bytes)} > budget — cannot split further (single ref)`);
  }
  return [{ ...pack, tip }];
}

/**
 * Build every window of the plan, feeding each pack to `onPack` as it is
 * produced (one window in memory at a time). Returns the manifest body:
 * {head, refs, chunks: [{n, bytes, sha1, tip}], totalBytes} — exactly the
 * server's strict manifest schema (SPEC-0003 §2.6).
 */
async function buildManifest(gitDir, { refs, head, commits, budget }, onPack) {
  const chunks = [];
  let totalBytes = 0;
  const emit = async (pack) => {
    const chunk = { n: chunks.length, bytes: pack.bytes, sha1: pack.sha1, tip: pack.tip };
    await onPack(pack, chunk);
    chunks.push(chunk);
    totalBytes += pack.bytes;
  };
  if (commits.length > 0) {
    const w = Math.max(1, Math.floor(budget / perCommitBytes));
    for (let start = 0; start < commits.length; start += w) {
      const end = Math.min(start + w, commits.length);
      for (const pack of await buildCommitRange(gitDir, commits, start, end, budget)) await emit(pack);
    }
  }
  const lastTip = commits.length > 0 ? commits[commits.length - 1] : null;
  for (const pack of await buildFinalWindows(gitDir, refs, lastTip, budget)) await emit(pack);
  return { head, refs: Object.fromEntries(refs.map((r) => [r.ref, r.oid])), chunks, totalBytes };
}

// ---------------------------------------------------------------------------
// HTTP (SPEC-0003 §2.6 shapes)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function httpFetch(method, url, { headers = {}, body, timeoutMs = API_TIMEOUT_MS } = {}) {
  return fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
}

/** JSON API call with the Gitea `Authorization: token` scheme, small retry on
 *  transient transport/5xx/429 failures. 4xx other than 429 never retries. */
async function api(method, path, { body, timeoutMs, retries = 2 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    let res;
    try {
      res = await httpFetch(method, `${apiBase}${path}`, {
        headers: {
          authorization: `token ${opt.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        timeoutMs,
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`${method} ${path} → ${res.status}`);
      continue;
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} → ${res.status}: non-JSON response`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${method} ${path} failed`);
}

/** One relay PUT (import-token authenticated, Content-Length from the buffer,
 *  X-Chunk-Sha1 = pack trailer digest — start cross-checks the manifest
 *  against it). Retried: an overwrite PUT of the same chunk n is idempotent. */
async function putChunk(n, pack) {
  const url = `${opt.target}${uploadPathTemplate.replace("{n}", String(n))}`;
  let lastError = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    let res;
    try {
      res = await httpFetch("PUT", url, {
        headers: {
          "x-import-token": importState.importToken,
          "content-type": "application/octet-stream",
          "x-chunk-sha1": pack.sha1,
        },
        body: pack.buf,
        timeoutMs: CHUNK_PUT_TIMEOUT_MS,
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`chunk PUT ${n} → ${res.status}`);
      continue;
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`chunk PUT ${n} → ${res.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  }
  throw lastError instanceof Error ? lastError : new Error(`chunk PUT ${n} failed`);
}

// ---------------------------------------------------------------------------
// process state, interrupt handling, cleanup
// ---------------------------------------------------------------------------

const importState = { id: null, importToken: null, terminal: false };
let uploadPathTemplate = null;
let perCommitBytes = 1;

function importPath(action = "") {
  const base = `/repos/${encodeURIComponent(opt.user)}/${encodeURIComponent(repoName)}/imports`;
  return importState.id === null ? base : `${base}/${importState.id}${action}`;
}

let interrupted = false;
function onInterrupt(signal) {
  if (interrupted) {
    console.error(`\n${signal} again — exiting without cleanup`);
    process.exit(130);
  }
  interrupted = true;
  console.error(`\n${signal} received — aborting import (best-effort) and cleaning up…`);
  void (async () => {
    if (importState.id !== null && !importState.terminal) {
      try {
        await api("POST", importPath("/abort"), { timeoutMs: 10_000, retries: 0 });
        console.error(`import ${importState.id} aborted`);
      } catch (error) {
        console.error(`abort request failed (import left for the server sweep): ${error.message}`);
      }
    }
    await cleanup();
    process.exit(130);
  })();
}
process.on("SIGINT", () => onInterrupt("SIGINT"));
process.on("SIGTERM", () => onInterrupt("SIGTERM"));

async function cleanup() {
  if (tempDir === null) return;
  if (opt.keepTemp) console.error(`temp kept: ${tempDir}`);
  else await rm(tempDir, { recursive: true, force: true }).catch(() => {});
}

/** Best-effort abort after a hard failure, so the target repo does not stay
 *  'migrating' (the server's 24 h heartbeat sweep is the backstop). */
async function abortQuietly() {
  if (importState.id === null || importState.terminal || interrupted) return;
  try {
    await api("POST", importPath("/abort"), { timeoutMs: 10_000, retries: 0 });
    console.error(`import ${importState.id} aborted; the repository is ready/empty again`);
  } catch {
    console.error(`abort failed — POST ${apiBase}${importPath("/abort")} manually, or wait for the sweep`);
  }
}

// ---------------------------------------------------------------------------
// verification — the acceptance check (SPEC-0009: mirror == source refs)
// ---------------------------------------------------------------------------

async function verifyAgainstTarget(manifest) {
  const credentials = Buffer.from(`${opt.user}:${opt.token}`).toString("base64");
  const config = ["-c", `http.extraHeader=Authorization: Basic ${credentials}`];
  const urls = [`${opt.target}/${opt.user}/${repoName}.git`, `${opt.target}/${opt.user}/${repoName}`];
  let out = null;
  let lastError = null;
  for (const url of urls) {
    try {
      out = (
        await run("git", [...config, "ls-remote", "--symref", url], {
          maxBuffer: 1 << 26,
          timeout: GIT_TIMEOUT_MS,
          env: gitEnv(),
        })
      ).stdout;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (out === null) {
    throw new Error(
      `ls-remote against the target failed: ${String(lastError?.stderr ?? lastError).trim().slice(0, 400)}`,
    );
  }

  const remoteRefs = new Map();
  let remoteHead = null;
  for (const line of out.split("\n").filter((l) => l.trim() !== "")) {
    const [left, right] = line.split("\t");
    if (right === "HEAD") {
      // --symref prints the symref line ("ref: refs/heads/x HEAD") first; the
      // oid line for HEAD follows it and is informational only.
      if (left.startsWith("ref:")) remoteHead = left.slice("ref:".length).trim();
      continue;
    }
    remoteRefs.set(right, left);
  }
  for (const ref of [...remoteRefs.keys()]) {
    // ls-remote advertises peeled tag targets (`refs/tags/x^{}`) — annotation
    // lines, not refs.
    if (ref.endsWith("^{}")) remoteRefs.delete(ref);
  }

  const problems = [];
  for (const [ref, oid] of Object.entries(manifest.refs)) {
    const actual = remoteRefs.get(ref);
    if (actual === undefined) problems.push(`missing ref on target: ${ref}`);
    else if (actual !== oid) problems.push(`oid mismatch for ${ref}: source ${oid} vs target ${actual}`);
  }
  for (const extra of [...remoteRefs.keys()].filter((ref) => manifest.refs[ref] === undefined)) {
    console.error(`warning: target carries a non-manifest ref: ${extra}`);
  }
  const wantHead = `refs/heads/${manifest.head}`;
  if (remoteHead !== wantHead) {
    problems.push(`HEAD mismatch: target ${remoteHead ?? "(none)"} vs manifest ${wantHead}`);
  }

  if (problems.length > 0) {
    console.error("verify: FAIL");
    for (const problem of problems) console.error(`  ${problem}`);
    return false;
  }
  console.log(`verify: PASS — ${Object.keys(manifest.refs).length} ref(s) match the source, HEAD → ${wantHead}`);
  return true;
}

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

async function pollUntilDone(totalChunks) {
  const deadline = Date.now() + opt.timeoutSec * 1000;
  let lastDone = -1;
  let lastState = "";
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`poll timed out after ${opt.timeoutSec}s (import ${importState.id} left ${lastState || "indexing"})`);
    }
    await sleep(POLL_INTERVAL_MS);
    const status = await api("GET", importPath());
    importState.terminal = status.state === "done" || status.state === "failed";
    const chunks = status.manifest?.chunks ?? [];
    const done = chunks.filter((c) => c.status === "done").length;
    if (status.state !== lastState || done !== lastDone) {
      console.log(`state=${status.state} chunks=${done}/${totalChunks} bytes=${status.total_bytes}`);
      lastState = status.state;
      lastDone = done;
    }
    for (const chunk of chunks) {
      if (chunk.status === "failed") console.error(`  chunk ${chunk.n} failed: ${chunk.error ?? "(no error text)"}`);
    }
    if (status.state === "done") return;
    if (status.state === "failed") {
      throw new Error(status.error ? `import failed: ${status.error}` : "import failed");
    }
  }
}

/** start → poll → verify → cleanup → exit. The manifest is exactly what the
 *  client built (the server re-validates it against the staged uploads). */
async function startPollVerify(manifest) {
  const started = await api("POST", importPath("/start"), { body: manifest });
  console.log(
    `import started: ${started.queued_chunks.length}/${manifest.chunks.length} chunk(s) queued ` +
      `(polling, cap ${opt.timeoutSec}s)`,
  );
  await pollUntilDone(manifest.chunks.length);
  const ok = await verifyAgainstTarget(manifest);
  await cleanup();
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `mirror-import: ${opt.source}\n  → ${opt.target ?? "(no target)"}/${opt.user ?? ""}/${repoName}` +
      `${opt.dryRun ? " (dry-run: no server calls)" : ""}`,
  );

  let staged = {};
  let budget = opt.windowBytes;
  let resumeStaged = false;

  // ---- resume dispatch (before the clone: done/indexing/failed need only
  // the server's manifest — fetching the source would be pure waste) ----
  if (opt.resume !== undefined) {
    importState.id = opt.resume;
    const status = await api("GET", importPath());
    console.log(
      `resuming import ${status.import_id}: state=${status.state} staged=${Object.keys(status.staged).length} ` +
        `cap=${fmtMiB(status.chunk_size_cap)}`,
    );
    budget = Math.min(budget, status.chunk_size_cap);

    if (status.state === "done") {
      importState.terminal = true;
      if (status.manifest === null) throw new Error("done import has no manifest");
      const ok = await verifyAgainstTarget(status.manifest);
      await cleanup();
      process.exit(ok ? 0 : 1);
    }
    if (status.state === "indexing" || status.state === "finalizing" || status.state === "failed") {
      // Re-start is the SPEC's own remedy: it re-enqueues exactly the
      // missing/failed chunk set (their bytes are still on the server — only
      // an abort purges). Consumer fields (status/error/attempts) are
      // stripped: the manifest schema is strict.
      if (status.manifest === null) {
        throw new Error("import failed before start — uploads are refused in failed state; start a fresh import");
      }
      const manifest = {
        head: status.manifest.head,
        refs: status.manifest.refs,
        chunks: status.manifest.chunks.map((c) => ({ n: c.n, bytes: c.bytes, sha1: c.sha1, tip: c.tip })),
        totalBytes: status.manifest.total_bytes,
      };
      const started = await api("POST", importPath("/start"), { body: manifest });
      console.log(`re-started: ${started.queued_chunks.length} chunk(s) (re)queued`);
      await pollUntilDone(manifest.chunks.length);
      const ok = await verifyAgainstTarget(manifest);
      await cleanup();
      process.exit(ok ? 0 : 1);
    }
    if (status.state !== "staged") throw new Error(`cannot resume from state ${status.state}`);
    resumeStaged = true;
    staged = status.staged;
    if (opt.importToken !== undefined) {
      // The one-time upload token from the original create: re-uploads of
      // missing/mismatched chunks are possible again.
      importState.importToken = opt.importToken;
      uploadPathTemplate = `${opt.api}/repos/${encodeURIComponent(opt.user)}/${encodeURIComponent(repoName)}/imports/${importState.id}/chunks/{n}`;
    }
  }

  // ---- clone ----
  tempDir = await mkdtemp(path.join(tmpdir(), "mirror-import-"));
  const gitDir = path.join(tempDir, "src.git");
  const cloneArgs = ["clone", "--mirror", "--quiet"];
  if (opt.sourceToken !== undefined) {
    // Header injection via git config — the token never appears in any URL
    // (argv, remote config, or logs).
    cloneArgs.unshift("-c", `http.extraHeader=Authorization: Bearer ${opt.sourceToken}`);
  }
  cloneArgs.push("--", opt.source, gitDir);
  console.log("clone --mirror …");
  await git(".", cloneArgs, { timeoutMs: CLONE_TIMEOUT_MS });

  // ---- enumerate ----
  const refs = await listRefs(gitDir, opt.branchFilter);
  if (refs.length === 0) throw new Error("source has no refs to mirror (after filtering)");
  if (refs.length > MAX_REFS) {
    throw new Error(`${refs.length} refs exceed the ${MAX_REFS}-ref manifest cap — narrow with --branch-filter`);
  }
  const head = await resolveHead(gitDir, refs, opt.head);
  const commits = await listCommits(gitDir, refs);
  console.log(
    `source: ${refs.length} ref(s), ${commits.length} commit(s), head=${head}` +
      `${opt.branchFilter !== undefined ? `, branch-filter=${opt.branchFilter}` : ""}`,
  );

  // ---- size probe: bytes/commit calibrates the byte-budgeted windows ----
  if (commits.length > 0) {
    const probeK = Math.min(commits.length, 200);
    const probe = await buildPack(gitDir, [commits[probeK - 1]]);
    if (probe !== null) perCommitBytes = Math.max(1, Math.ceil(probe.bytes / probeK));
  }

  // ---- server: create the import unless resuming a staged one ----
  if (opt.dryRun) {
    console.log(`dry-run: window budget ${fmtMiB(budget)} (probe ${(perCommitBytes / 1024).toFixed(1)} KiB/commit)`);
  } else if (!resumeStaged) {
    const created = await api("POST", importPath());
    importState.id = created.import_id;
    importState.importToken = created.import_token;
    uploadPathTemplate = created.upload;
    budget = Math.min(budget, created.chunk_size_cap);
    console.log(
      `import ${created.import_id} created (chunk cap ${fmtMiB(created.chunk_size_cap)}, ` +
        `window budget ${fmtMiB(budget)}, probe ${(perCommitBytes / 1024).toFixed(1)} KiB/commit)`,
    );
    console.error(
      `note: to resume an interrupted run with re-uploads, save the one-time import token shown above ` +
        `and pass --resume ${created.import_id} --import-token <imp_…>`,
    );
  }

  // ---- confirm ----
  const estWindows =
    (commits.length > 0 ? Math.ceil(commits.length / Math.max(1, Math.floor(budget / perCommitBytes))) : 0) + 1;
  console.log(`plan: ~${estWindows} window(s) of ≤ ${fmtMiB(budget)}, head=${head}, ${refs.length} ref(s)`);
  if (!opt.yes) {
    process.stdout.write("proceed? [yN] ");
    const answer = await new Promise((resolve) => {
      process.stdin.once("data", (d) => resolve(String(d).trim().toLowerCase()));
      process.stdin.once("end", () => resolve("n"));
    });
    if (answer !== "y" && answer !== "yes") {
      console.error("aborted by user");
      await cleanup();
      process.exit(1);
    }
  }

  // ---- build (and upload / locally index) ----
  let plan = { refs, head, commits, budget };

  if (opt.dryRun) {
    // Dry-run verifies the windowing + manifest halves standalone: every pack
    // is indexed into a scratch repo (the server's per-chunk shape: install
    // pack, temp ref at the chunk tip), then fsck + per-branch commit counts
    // must match the source exactly.
    const scratchDir = path.join(tempDir, "scratch.git");
    await git(".", ["init", "--bare", "--quiet", scratchDir], { timeoutMs: 60_000 });
    if (opt.packDir !== undefined) await mkdir(opt.packDir, { recursive: true });

    const manifest = await buildManifest(gitDir, plan, async (pack, chunk) => {
      if (opt.packDir !== undefined) {
        await writeFile(path.join(opt.packDir, `chunk-${String(chunk.n).padStart(4, "0")}.pack`), pack.buf);
      }
      const indexed = (
        await git(scratchDir, ["index-pack", "--stdin"], { stdinData: pack.buf })
      ).stdout
        .trim()
        .split(/\s+/)
        .pop();
      if (indexed !== pack.sha1) throw new Error(`index-pack named the pack ${indexed}, expected ${pack.sha1}`);
      await git(scratchDir, ["update-ref", `refs/import/chunk-${chunk.n}`, chunk.tip]);
      console.log(`window ${chunk.n}: ${fmtMiB(chunk.bytes)}, tip ${chunk.tip.slice(0, 12)} — indexed ok`);
    });

    if (manifest.chunks.length === 0) throw new Error("nothing to import (every window was empty)");
    for (const r of refs) await git(scratchDir, ["update-ref", r.ref, r.oid]);
    await git(scratchDir, ["fsck", "--no-progress"], { timeoutMs: GIT_TIMEOUT_MS });
    for (const r of refs.filter((x) => x.ref.startsWith("refs/heads/"))) {
      const sourceCount = (await git(gitDir, ["rev-list", "--count", r.ref])).stdout.trim();
      const scratchCount = (await git(scratchDir, ["rev-list", "--count", r.ref])).stdout.trim();
      if (sourceCount !== scratchCount) {
        throw new Error(`commit count mismatch for ${r.ref}: source ${sourceCount} vs reassembled ${scratchCount}`);
      }
    }
    console.log(
      `dry-run verification: ${manifest.chunks.length} window(s), ${fmtMiB(manifest.totalBytes)} — ` +
        `fsck clean, per-branch commit counts match`,
    );
    const json = JSON.stringify(manifest, null, 2) + "\n";
    if (opt.out !== undefined) {
      await writeFile(opt.out, json);
      console.log(`manifest written to ${opt.out}`);
    } else {
      console.log(`manifest (what POST …/start would receive):\n${json}`);
    }
    await cleanup();
    process.exit(0);
  }

  // Resume against a staged import WITHOUT the import token: re-uploads are
  // impossible, so check whether the rebuilt plan is already fully staged.
  if (opt.resume !== undefined && importState.importToken === null) {
    const rebuilt = await buildManifest(gitDir, plan, async () => {});
    const allStaged = rebuilt.chunks.every((c) => {
      const put = staged[String(c.n)];
      return put !== undefined && put.sha1 === c.sha1 && put.bytes === c.bytes;
    });
    if (!allStaged) {
      console.error(
        "resume: some chunks are missing or differ from the plan, and without the one-time import token " +
          "they cannot be re-uploaded — recovering by aborting this import and starting a fresh one (full re-upload)",
      );
      await api("POST", importPath("/abort"), { timeoutMs: 30_000 });
      importState.terminal = true; // the aborted import is done-with
      importState.id = null; // importPath() must return the create path again
      const created = await api("POST", importPath());
      importState.id = created.import_id;
      importState.importToken = created.import_token;
      uploadPathTemplate = created.upload;
      budget = Math.min(opt.windowBytes, created.chunk_size_cap);
      staged = {};
      plan = { refs, head, commits, budget };
      console.log(`fresh import ${importState.id} created (chunk cap ${fmtMiB(created.chunk_size_cap)})`);
    } else {
      console.log(`all ${rebuilt.chunks.length} planned chunk(s) are staged — going straight to start`);
      await startPollVerify(rebuilt);
    }
  }

  // The normal build-and-upload path (also resume-with-token: staged chunks
  // whose sha1+bytes match the rebuilt plan are skipped, everything else is
  // re-uploaded — a PUT overwrite is idempotent).
  const manifest = await buildManifest(gitDir, plan, async (pack, chunk) => {
    const put = staged[String(chunk.n)];
    if (put !== undefined && put.sha1 === chunk.sha1 && put.bytes === chunk.bytes) {
      console.log(`chunk ${chunk.n}: already staged (${fmtMiB(chunk.bytes)}, sha1 ${chunk.sha1.slice(0, 12)}…) — skipped`);
      return;
    }
    if (put !== undefined) {
      console.error(
        `note: chunk ${chunk.n} differs from the staged upload (sha1 ${put.sha1.slice(0, 12)}…) — ` +
          `re-uploading (the source may have moved since the first run)`,
      );
    }
    const t0 = Date.now();
    await putChunk(chunk.n, pack);
    console.log(`chunk ${chunk.n}: ${fmtMiB(chunk.bytes)} in ${((Date.now() - t0) / 1000).toFixed(1)}s, sha1 ${chunk.sha1}`);
  });

  if (manifest.chunks.length === 0) throw new Error("nothing to import (every window was empty)");
  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_MANIFEST_BYTES) {
    throw new Error(`manifest exceeds the ${MAX_MANIFEST_BYTES}-byte cap — narrow the ref set`);
  }
  await startPollVerify(manifest);
}

main().catch(async (error) => {
  console.error(`[fatal] ${error instanceof Error ? error.message : String(error)}`);
  await abortQuietly();
  await cleanup();
  process.exit(1);
});

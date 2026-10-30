// P2-8 (v1.3.2 board) — protocol-v2 partial clone + unborn ls-refs, proven
// against a REAL git client over the engine's full HTTP surface running in
// plain Node (the check-cache-unreachable.mjs seam, extended to a live
// node:http listener so `git clone --filter=...` drives routing, the auth
// gate, and the DO serve path end-to-end). Run with tsx:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-protocol-v2-partial.mjs
// Exits non-zero when any check fails.
//
// What is proven (byte shapes observed on stock git 2.43.0 upload-pack,
// 2026-10-30):
//   1. the v2 advertisement carries `ls-refs=unborn` and `fetch=shallow
//      filter` — byte-exact lines;
//   2. `git clone --filter=blob:none` over HTTP succeeds; the clone holds
//      commits+trees but NO blobs (rev-list --missing=print marks the blobs
//      `?`), and the client records the promisor filter;
//   3. the lazy round works: `git checkout` fetches the promised blobs from
//      the SAME server (the relaxed want gate: under a filter a want needs
//      only has-object — upstream's own v2 gate, observed on git 2.43.0),
//      the content round-trips, fsck passes;
//   4. `git clone --filter=blob:limit=<n>`: a blob of size <= <n> ships, a
//      larger one is promised (git's strict-> boundary), and the limit
//      round's lazy fetch still delivers the oversized wanted blob (the
//      want-blob carve-out);
//   5. an unborn HEAD (empty repo): ls-refs with `unborn`+`symrefs` answers
//      `unborn HEAD symref-target:<head>` byte-exactly, the same request
//      without both arguments answers flush-only, and `git clone` of the
//      empty repo succeeds;
//   6. filter specs outside the blob family stay fail-closed (ERR pkt).
//
// `cloudflare:workers` shim: mod.ts's import graph (src/repo.ts) extends
// DurableObject at module scope — the inert base class (no cell runtime).
import { register } from "node:module";

const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

// mod.ts's stagePack uses the workers FixedLengthStream — provide the minimal
// contract over a TransformStream (same shim as check-correctness-tier.mjs).
class FixedLengthStreamShim {
  constructor(expected) {
    let written = 0;
    const ts = new TransformStream({
      transform: (chunk, c) => {
        written += chunk.length;
        if (written > expected) {
          c.error(new Error(`exceeded the fixed length (${written} > ${expected})`));
          return;
        }
        c.enqueue(chunk);
      },
      flush: (c) => {
        if (written !== expected) c.error(new Error(`fixed length mismatch: wrote ${written}, expected ${expected}`));
      },
    });
    this.writable = ts.writable;
    this.readable = ts.readable;
  }
}
globalThis.FixedLengthStream = FixedLengthStreamShim;

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

let planned = 0;
const failures = [];
async function check(n, name, fn) {
  planned++;
  try {
    await fn();
    console.log(`CHECK ${n} PASS: ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`CHECK ${n} FAIL: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const pkt = (s) => Buffer.from((s.length + 4).toString(16).padStart(4, "0") + s);
const FLUSH = Buffer.from("0000");
const DELIM = Buffer.from("0001");

// ---- fixtures (pre-server: blocking exec is safe here) ------------------------

const WORK = mkdtempSync(join(tmpdir(), "pv2-partial-"));
function seedRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const run = (cmd) =>
    execFileSync("git", cmd, { cwd: dir, stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 26 });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "small.txt"), "0123456789"); // 10 bytes: ships under blob:limit=100
  run(["add", "-A"]);
  run(["commit", "-qm", "one"]);
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(6000, 7)); // 6000 bytes: promised under blob:limit=100
  run(["add", "-A"]);
  run(["commit", "-qm", "two"]);
  return run(["rev-parse", "HEAD"]).toString().trim();
}

const SEED = join(WORK, "seed");
const tip = seedRepo(SEED);
const smallBlob = execFileSync("git", ["-C", SEED, "rev-parse", "HEAD~1:small.txt"]).toString().trim();
const bigBlob = execFileSync("git", ["-C", SEED, "rev-parse", "HEAD:big.bin"]).toString().trim();

// ---- the engine in Node: a real cell behind the real handler ------------------

const { GitStore } = await import("../src/git/store.ts");
const { NodeSql, loadGitRepoIntoStore } = await import("./helpers/lib.mjs");
const { RepoCell } = await import("../src/repo.ts");
const { createDurableGit } = await import("../src/mod.ts");

function makeCell(fixtureDir, repoName) {
  const t = { transactions: 0 };
  const db = new DatabaseSync(":memory:");
  t.sql = new NodeSql(db);
  t.store = new GitStore(t.sql);
  t.store.setMeta("repo", repoName);
  if (fixtureDir) loadGitRepoIntoStore(t, fixtureDir);
  const cell = new RepoCell(
    { storage: { sql: t.sql, transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } },
    {}
  );
  cell.env = {};
  cell.ctx = { storage: { transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } };
  return { t, cell };
}

const seeded = makeCell(SEED, "r0");
const empty = makeCell(null, "empty");

const registry = {
  get: async () => ({ priv: false, ver: 1 }),
  upsert: async () => {},
  setConfig: async () => {},
  remove: async () => {},
  list: async () => [],
};
const env = {
  REGISTRY: { getByName: () => registry },
  REPO: {
    getByName: (name) => ({
      fetch: (req) => (name === "empty" ? empty.cell : seeded.cell).fetch(req),
    }),
  },
};
const handler = createDurableGit({ ui: false });
const ctx = { waitUntil: () => {} };

// node:http -> engine fetch(): a listener on an EPHEMERAL port (a sibling may
// hold any fixed port; listen(0) never collides). PV2_TRACE=1 logs the wire.
const TRACE = process.env.PV2_TRACE === "1";
const server = createServer(async (nodeReq, nodeRes) => {
  if (TRACE) console.error(`[wire] ${nodeReq.method} ${nodeReq.url}`);
  const chunks = [];
  for await (const c of nodeReq) chunks.push(c);
  const body = Buffer.concat(chunks);
  const req = new Request(`http://127.0.0.1:${PORT}${nodeReq.url}`, {
    method: nodeReq.method,
    headers: nodeReq.headers,
    body: nodeReq.method === "GET" || nodeReq.method === "HEAD" ? undefined : body,
  });
  let res;
  try {
    res = await handler.fetch(req, env, ctx);
  } catch (err) {
    nodeRes.writeHead(500);
    nodeRes.end(String(err));
    return;
  }
  const ab = Buffer.from(await res.arrayBuffer());
  const headers = Object.fromEntries(res.headers);
  if (!headers["content-length"]) headers["content-length"] = String(ab.length);
  nodeRes.writeHead(res.status, headers);
  nodeRes.end(ab);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const GITC = ["-c", "credential.helper=", "-c", "advice.detachedHead=false", "-c", "protocol.version=2"];

// git via ASYNC spawn — NEVER execFileSync once the server is listening: the
// server lives in THIS process's event loop, and a blocking exec deadlocks it
// (git waits for responses the blocked loop can never produce).
async function git(args, opts = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", [...GITC, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 1 << 26,
      ...opts,
    });
    const out = [];
    child.stdout.on("data", (c) => out.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString());
      } else {
        reject(new Error(`git ${args.join(" ")} exited ${code} (stderr inherited above)`));
      }
    });
  });
}

// ---- checks -------------------------------------------------------------------

await check(1, "v2 advertisement: byte-exact ls-refs=unborn and fetch=shallow filter lines", async () => {
  const res = await fetch(`${BASE}/r0.git/info/refs?service=git-upload-pack`, { headers: { "git-protocol": "version=2" } });
  const raw = Buffer.from(await res.arrayBuffer());
  const want = Buffer.concat([
    pkt("version 2\n"),
    pkt("agent=dgit/0.3\n"),
    pkt("ls-refs=unborn\n"),
    pkt("fetch=shallow filter\n"),
    FLUSH,
  ]);
  if (!raw.equals(want)) throw new Error(`advert bytes drift:\n got ${JSON.stringify(raw.toString("latin1"))}\nwant ${JSON.stringify(want.toString("latin1"))}`);
});

await check(2, "git clone --filter=blob:none succeeds; blobs promised; commits+trees shipped", async () => {
  const dir = join(WORK, "clone-none");
  await git(["clone", "-q", "--filter=blob:none", "--no-checkout", `${BASE}/r0.git`, dir]);
  const filter = (await git(["-C", dir, "config", "remote.origin.partialclonefilter"])).trim();
  if (filter !== "blob:none") throw new Error(`the client did not record the promisor filter: '${filter}'`);
  const listing = await git(["-C", dir, "rev-list", "--objects", "--all", "--missing=print"]);
  const missing = listing.split("\n").filter((l) => l.startsWith("?")).map((l) => l.slice(1).split(" ")[0]);
  const present = listing.split("\n").filter((l) => !l.startsWith("?")).map((l) => l.split(" ")[0]);
  if (!missing.includes(bigBlob) || !missing.includes(smallBlob)) throw new Error(`blobs not all promised: missing=${missing.join(",")}`);
  if (missing.some((o) => o === tip)) throw new Error("the tip commit is wrongly promised");
  if (present.length < 2) throw new Error(`commits/trees did not ship: present=${present.length}`);
  // the trees ARE present (the client learns the promised oids from them)
  const treeOid = (await git(["-C", dir, "rev-parse", "HEAD^{tree}"])).trim();
  if (missing.includes(treeOid)) throw new Error("HEAD's tree is wrongly promised");
});

await check(3, "the lazy round: checkout fetches the promised blobs; content round-trips; fsck", async () => {
  const dir = join(WORK, "clone-none");
  await git(["-C", dir, "checkout", "main"]);
  const small = await git(["-C", dir, "cat-file", "-p", smallBlob]);
  if (small !== "0123456789") throw new Error(`small blob content drift: '${small}'`);
  const bigHex = await git(["-C", dir, "cat-file", "-p", bigBlob]);
  const big = Buffer.from(bigHex, "binary");
  if (big.length !== 6000 || big[0] !== 7) throw new Error(`big blob content drift: ${big.length} bytes`);
  await git(["-C", dir, "fsck", "--strict"]);
});

await check(4, "git clone --filter=blob:limit=100: small blob ships, big blob promised; lazy fetch delivers it", async () => {
  const dir = join(WORK, "clone-limit");
  await git(["clone", "-q", "--filter=blob:limit=100", "--no-checkout", `${BASE}/r0.git`, dir]);
  const filter = (await git(["-C", dir, "config", "remote.origin.partialclonefilter"])).trim();
  if (filter !== "blob:limit=100") throw new Error(`the promisor filter recorded as '${filter}'`);
  const sizes = await git(["-C", dir, "cat-file", "--batch-check", "--batch-all-objects"]);
  if (!sizes.includes("blob 10")) throw new Error(`the 10-byte blob (<= limit) did not ship:\n${sizes}`);
  if (sizes.includes("blob 6000")) throw new Error("the 6000-byte blob (> limit) shipped despite blob:limit=100");
  // the lazy round: the OVERSIZED blob is directly wanted — git's
  // USER_REQUESTED carve-out ships it regardless of the filter
  await git(["-C", dir, "checkout", "main"]);
  const sizesAfter = await git(["-C", dir, "cat-file", "--batch-check", "--batch-all-objects"]);
  if (!sizesAfter.includes("blob 6000")) throw new Error(`the lazy fetch did not deliver the oversized wanted blob:\n${sizesAfter}`);
  await git(["-C", dir, "fsck", "--strict"]);
});

await check(5, "unborn HEAD: ls-refs unborn+symrefs answers `unborn HEAD symref-target:<head>` byte-exactly; without either argument, flush-only", async () => {
  const v2ls = (args) =>
    Buffer.concat([pkt("command=ls-refs\n"), pkt("agent=git/2.43.0\n"), DELIM, ...args.map((a) => pkt(`${a}\n`)), FLUSH]);
  const post = async (body) =>
    await fetch(`${BASE}/empty.git/git-upload-pack`, {
      method: "POST",
      headers: { "git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request" },
      body,
    });
  const born = Buffer.from(await (await post(v2ls(["peel", "symrefs", "unborn", "ref-prefix refs/heads/", "ref-prefix refs/tags/"]))).arrayBuffer());
  const wantBorn = Buffer.concat([pkt("unborn HEAD symref-target:refs/heads/main\n"), FLUSH]);
  if (!born.equals(wantBorn)) throw new Error(`unborn reply drift:\n got ${JSON.stringify(born.toString("latin1"))}\nwant ${JSON.stringify(wantBorn.toString("latin1"))}`);
  const noUnborn = Buffer.from(await (await post(v2ls(["peel", "symrefs", "ref-prefix refs/heads/"]))).arrayBuffer());
  if (!noUnborn.equals(FLUSH)) throw new Error(`symrefs-without-unborn on an empty repo must answer flush-only, got ${JSON.stringify(noUnborn.toString("latin1"))}`);
});

await check(6, "git clone of the empty repo succeeds over v2 (the unborn advertisement is what git parses)", async () => {
  const dir = join(WORK, "clone-empty");
  await git(["clone", `${BASE}/empty.git`, dir]);
  const branch = (await git(["-C", dir, "symbolic-ref", "HEAD"])).trim();
  if (branch !== "refs/heads/main") throw new Error(`the unborn HEAD's symref target did not reach the client: HEAD -> ${branch}`);
});

await check(7, "filter specs outside the blob family stay fail-closed (ERR pkt)", async () => {
  const v2f = (spec) =>
    Buffer.concat([
      pkt("command=fetch\n"),
      pkt("agent=git/2.43.0\n"),
      DELIM,
      pkt("no-progress\n"),
      pkt(`filter ${spec}\n`),
      pkt(`want ${tip}\n`),
      pkt("done\n"),
      FLUSH,
    ]);
  for (const spec of ["sparse:oid=HEAD", "tree:0", "combine:blob:none+blob:limit=1"]) {
    const res = await fetch(`${BASE}/r0.git/git-upload-pack`, {
      method: "POST",
      headers: { "git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request" },
      body: v2f(spec),
    });
    const text = Buffer.from(await res.arrayBuffer()).toString("latin1");
    if (!text.includes("ERR upload-pack: unsupported fetch argument 'filter'")) throw new Error(`'${spec}' was not rejected: ${JSON.stringify(text.slice(0, 120))}`);
  }
});

server.close();
rmSync(WORK, { recursive: true, force: true });

if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} protocol-v2 partial-clone checks passed`);

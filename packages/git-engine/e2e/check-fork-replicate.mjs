// SPEC-0001b §5.3 fork-replication gate (M-F3) — run with tsx, the same
// mechanism as check-merge-*.mjs (see e2e/README.md):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-fork-replicate.mjs
// Exits non-zero on the first violated assertion.
//
// What makes this honest:
// - The PARENT is populated through the REAL Worker receive machinery
//   (walkPack + DeltaResolver + writeIdx + the beginReceive/putIndexRows/
//   finalizeReceive lease RPCs) over REAL `git pack-objects` packs — including
//   a THIN second push whose delta bases resolve through lookupObjects, the
//   exact shape a `git push` produces.
// - The replication loop is the production body (src/fork/replicate.ts) run
//   against an in-memory R2 (one shared bucket, both prefixes) — the same
//   structural surface the queue consumer gets from real RepoCell stubs.
// - Parity is judged by REAL GIT: the fork serves an upload-pack clone whose
//   pack `git index-pack --fix-thin` accepts, `git fsck --strict` passes, and
//   whose per-tip `git rev-list --count` matches the fixture. Plus the in-
//   store reachable-set walk (parent == fork) and R2 byte equality.
// - Crash injection kills the consumer mid-loop (between adopt pages, tiny
//   row pages forcing split packs); the re-run must complete with identical
//   final state, and the crashed state must be un-servable (no refs) with the
//   §5.3 importing gates closed.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitStore } from "../src/git/store.ts";
import { PACK_CHUNK } from "../src/git/packstore.ts";
import {
  beginReceive,
  beginForkImport,
  adoptForkPacks,
  commitApiChange,
  executeMerge,
  finalizeForkImport,
  finalizeReceive,
  listCatalogPage,
  lookupObjects,
  putIndexRows,
  releaseReceive,
} from "../src/control-plane.ts";
import { uploadPack } from "../src/git/protocol.ts";
import { walkPack } from "../src/receive/scan.ts";
import { DeltaResolver } from "../src/receive/delta.ts";
import { writeIdx } from "../src/receive/idx.ts";
import { copyObject, replicateForkCatalog } from "../src/fork/replicate.ts";
import { ZERO_OID } from "../src/git/util.ts";
import { parseCommit, parseTag, parseTree, isGitlinkMode } from "../src/git/objects.ts";
import { NodeSql, assert } from "./helpers/lib.mjs";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`ok: ${name}`);
  } else {
    fail++;
    console.log(`FAIL: ${name}`);
  }
}

// ---- in-memory R2 (one bucket, every repo's prefix; both DOs + the consumer
// see the same binding, exactly like wrangler.jsonc's single REPO_PACKS) ------
class MemR2 {
  constructor() {
    this.map = new Map();
  }
  async put(key, value) {
    let bytes;
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      bytes = new Uint8Array(value);
    } else if (value instanceof ReadableStream) {
      const chunks = [];
      const reader = value.getReader();
      for (;;) {
        const { done, value: v } = await reader.read();
        if (done) break;
        chunks.push(v);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        bytes.set(c, off);
        off += c.length;
      }
    } else {
      throw new Error(`MemR2.put: unsupported value ${value?.constructor?.name}`);
    }
    this.map.set(key, bytes);
    return { key, size: bytes.length };
  }
  async get(key, opts) {
    const bytes = this.map.get(key);
    if (!bytes) return null;
    let slice = bytes;
    let size = bytes.length;
    if (opts?.range) {
      const r = opts.range;
      if (typeof r.suffix === "number") {
        slice = bytes.subarray(bytes.length - r.suffix);
        size = r.suffix;
      } else {
        const from = r.offset ?? 0;
        const to = r.length != null ? from + r.length : bytes.length;
        slice = bytes.subarray(from, to);
        size = Math.max(0, to - from);
      }
    }
    return {
      size,
      body: new ReadableStream({
        start: (ctrl) => {
          ctrl.enqueue(slice);
          ctrl.close();
        },
      }),
      arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
    };
  }
  async delete(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.map.delete(k);
  }
}

// ---- test cells (a RepoCell minus the RPC transport: real GitStore + the real
// control-plane functions over a real BEGIN/COMMIT transaction) ---------------
function makeCell(bucket, storageKey) {
  const db = new DatabaseSync(":memory:");
  const sql = new NodeSql(db);
  const store = new GitStore(sql);
  store.setR2(bucket, storageKey);
  const t = { store, sql, transactions: 0, storageKey };
  t.host = {
    store,
    storage: {
      transactionSync: (fn) => {
        t.transactions++;
        sql.db.exec("BEGIN");
        try {
          const r = fn();
          sql.db.exec("COMMIT");
          return r;
        } catch (err) {
          sql.db.exec("ROLLBACK");
          throw err;
        }
      },
      setAlarm: () => Promise.resolve(),
    },
    deletePackObjects: async () => {},
    readPackTail: async (r2Key, len) => {
      const obj = await bucket.get(r2Key, { range: { suffix: len } });
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    },
  };
  return t;
}

// ---- the Worker receive flow (mod.ts receivePack, minus HTTP framing) --------
async function workerReceive(t, bucket, packBytes, commands) {
  // stagePack's streaming hash: the pack NAME is the trailer SHA-1 over
  // everything before the 20-byte trailer (known BEFORE the scan — putIndexRows
  // keys rows under it from the first batch)
  assert(packBytes.length >= 32, "pack too small");
  const bodySha = createHash("sha1").update(packBytes.subarray(0, packBytes.length - 20)).digest("hex");
  const trailer = Buffer.from(packBytes.subarray(packBytes.length - 20)).toString("hex");
  assert(bodySha === trailer, "pack checksum mismatch (fixture pack is corrupt)");
  const packName = `pack-${bodySha}`;
  const begin = await beginReceive(t.host, {
    commands,
    capabilities: [],
    packBytesHint: packBytes.length,
    storageKey: t.storageKey,
  });
  assert(begin.tag === "ok", `beginReceive: ${JSON.stringify(begin)}`);
  await bucket.put(begin.stagingKey, packBytes);
  const staged = await bucket.get(begin.stagingKey);
  const resolver = new DeltaResolver(
    {
      selfPackKey: begin.stagingKey,
      lookupObjects: async (oids) => lookupObjects(t.host, begin.leaseToken, oids),
      readEntryBytes: async (key, off, len) => {
        const region = await bucket.get(key, { range: { offset: off, length: len } });
        if (!region) throw new Error(`missing R2 object ${key}`);
        return new Uint8Array(await region.arrayBuffer());
      },
      putRows: async (rows) => putIndexRows(t.host, begin.leaseToken, packName, rows),
    },
    { cacheBytes: 16 * 1024 * 1024 }
  );
  const walked = await walkPack(
    { body: staged.body, size: staged.size },
    (entry) => resolver.onEntry(entry),
    { onHeader: (count) => resolver.init(count) }
  );
  assert(walked.packSha1 === bodySha, "walkPack trailer hash != staging hash");
  const resolved = await resolver.finish();
  assert(!resolved.incomplete, `pack incomplete (missing ${resolved.firstMissing})`);
  const packKey = `repos/${t.storageKey}/packs/${packName}.pack`;
  const idxKey = `repos/${t.storageKey}/packs/${packName}.idx`;
  const idxChunks = [];
  const idxBytes = await writeIdx(
    (chunk) => {
      idxChunks.push(chunk);
      return Promise.resolve();
    },
    {
      oids: resolved.oids,
      oidEntry: resolved.oidEntry,
      entryCrcs: resolved.entryCrcs,
      entryOffsets: resolved.entryOffsets,
      packSha1: bodySha,
    }
  );
  await bucket.put(idxKey, Buffer.concat(idxChunks));
  // copy-before-finalize ordering (staging → packs/). The STAGING object stays
  // alive until finalizeReceive sweeps it — the DO-side ancestry walk in
  // validatePush reads the fresh rows through it (primePack), exactly like
  // mod.ts's flow.
  await copyObject(bucket, begin.stagingKey, packKey);
  const fin = await finalizeReceive(t.host, {
    leaseToken: begin.leaseToken,
    expectedRefsVersion: begin.refsVersion,
    commands,
    newTips: commands.map((c) => (c.next === ZERO_OID ? null : c.next)),
    pack: {
      packKey,
      packSha1: bodySha,
      packBytes: packBytes.length,
      objectCount: resolved.objects,
      idxBytes,
    },
    unpackError: null,
    packIncomplete: false,
  });
  assert(fin.tag === "committed", `finalizeReceive: ${JSON.stringify(fin)}`);
  return { packName };
}

// ---- git fixture helpers -------------------------------------------------------
function git(dir, cmd) {
  return execSync(`git -C ${dir} -c user.email=f@f -c user.name=F ${cmd}`, {
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "inherit"],
  });
}
function gitTry(dir, cmd) {
  try {
    git(dir, cmd);
    return true;
  } catch {
    return false;
  }
}
function fixtureRefs(dir) {
  const out = execSync(`git -C ${dir} for-each-ref --format="%(refname) %(objectname)"`).toString().trim();
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const sp = line.lastIndexOf(" ");
      return { name: line.slice(0, sp), oid: line.slice(sp + 1) };
    });
}
function buildFixture(dir) {
  execSync(`git init -q -b main ${dir}`);
  const w = (p, c) => writeFileSync(join(dir, p), c);
  w("a.txt", "one\n");
  git(dir, "add -A");
  git(dir, "commit -qm c1");
  // delta-friendly repeated lines: the phase-2 pushes produce real deltas
  mkdirSync(join(dir, "lib"), { recursive: true });
  w("lib/mod.js", "export const x = 1;\n".repeat(400));
  w("big.bin", execSync("head -c 300000 /dev/urandom"));
  git(dir, "add -A");
  git(dir, "commit -qm c2");
  git(dir, "tag -a v1.0 -m 'tag one'");
  git(dir, "tag light1");
  git(dir, "checkout -qb feature");
  w("lib/mod.js", "export const x = 1;\n".repeat(400) + "export const y = 2;\n");
  git(dir, "add -A");
  git(dir, "commit -qm f1");
  git(dir, "checkout -q main");
  w("a.txt", "one\ntwo\n");
  git(dir, "add -A");
  git(dir, "commit -qm c3");
}
/** `git pack-objects --stdout` over all refs (--all walks ref tips incl. tag
 * objects), excluding the given oids via stdin revs (^<oid> per line). */
function packFixture(dir, excludeOids, thin) {
  const stdin = excludeOids.map((o) => `^${o}\n`).join("");
  return execSync(`git -C ${dir} pack-objects --stdout --revs --all ${thin ? "--thin" : ""}`, {
    input: stdin,
    maxBuffer: 1 << 28,
  });
}

// ---- reachable-set walk (in-store parity oracle) --------------------------------
async function reachableSet(store) {
  const seen = new Set();
  const stack = store.refs().map((r) => r.oid);
  const head = store.resolveHead();
  if (head) stack.push(head);
  while (stack.length) {
    const oid = stack.pop();
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    const meta = store.typeAndSize(oid);
    if (!meta) throw new Error(`object missing in store: ${oid}`);
    const obj = await store.get(oid);
    assert(obj, `unreadable object ${oid}`);
    if (obj.type === "commit") {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === "tag") {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === "tree") {
      for (const e of parseTree(obj.data)) {
        if (!isGitlinkMode(e.mode)) stack.push(e.oid);
      }
    }
  }
  return seen;
}

// ---- upload-pack clone (real-git parity oracle) -----------------------------------
function pktLine(s) {
  return Buffer.from((Buffer.byteLength(s) + 4).toString(16).padStart(4, "0") + s);
}
const FLUSH = Buffer.from("0000");
async function serveClonePack(store, tips) {
  const body = Buffer.concat([
    ...tips.map((t, i) => pktLine(i === 0 ? `want ${t} agent=test` : `want ${t}`)),
    FLUSH,
    pktLine("done\n"),
  ]);
  const res = await uploadPack(store, new Uint8Array(body), () => {});
  const buf = Buffer.from(await res.arrayBuffer());
  // v0 without side-band: NAK pkt-line preamble, then the raw pack
  let off = 0;
  while (off + 4 <= buf.length) {
    if (buf.slice(off, off + 4).toString("latin1") === "PACK") return buf.subarray(off);
    const len = parseInt(buf.slice(off, off + 4).toString(), 16);
    off += Number.isFinite(len) && len > 0 ? len : 4;
  }
  throw new Error("upload-pack produced no pack");
}
function materialize(packBuf, dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  execSync(`git init -q ${dir}`);
  const packFile = join(dir, "in.pack");
  writeFileSync(packFile, packBuf);
  execSync(`git -C ${dir} index-pack --stdin --fix-thin < "${packFile}"`, { maxBuffer: 1 << 28 });
  return dir;
}
function fsckClean(dir) {
  return gitTry(dir, "fsck --strict");
}
function objectListing(dir) {
  return execSync(`git -C ${dir} cat-file --batch-all-objects --batch-check`, { maxBuffer: 1 << 28 })
    .toString()
    .trim()
    .split("\n")
    .sort()
    .join("\n");
}
function revCounts(dir, tips) {
  const out = {};
  for (const t of tips) out[t] = execSync(`git -C ${dir} rev-list --count ${t}`).toString().trim();
  return out;
}

// ================================ the checks =====================================

const work = mkdtempSync(join(tmpdir(), "fork-e2e-"));
const bucket = new MemR2();
try {
  // -- fixture + parent population through the real receive path --
  const fixture = join(work, "fixture");
  buildFixture(fixture);
  const phase1Tips = fixtureRefs(fixture);
  const parent = makeCell(bucket, "r_parent");

  // push 1: complete pack of the phase-1 world
  {
    const pack = packFixture(fixture, [], false);
    const cmds = phase1Tips.map((r) => ({ old: ZERO_OID, next: r.oid, ref: r.name }));
    await workerReceive(parent, bucket, new Uint8Array(pack), cmds);
    check("push 1 committed (complete pack through the real receive path)", true);
  }
  // phase 2: more history, then a THIN incremental push (delta bases resolve
  // through lookupObjects against pack 1 — the shape a real `git push` sends)
  writeFileSync(join(fixture, "lib/mod.js"), "export const x = 1;\n".repeat(400) + "export const y = 2;\nexport const z = 3;\n");
  git(fixture, "add -A");
  git(fixture, "commit -qm c4");
  git(fixture, "tag -a v2.0 -m 'tag two'");
  const phase2Refs = fixtureRefs(fixture);
  {
    const pack = packFixture(fixture, phase1Tips.map((r) => r.oid), true);
    check("push 2 pack built (thin)", pack.length > 0);
    const cmds = phase2Refs
      .filter((r) => !phase1Tips.some((p) => p.name === r.name))
      .map((r) => ({ old: ZERO_OID, next: r.oid, ref: r.name }))
      .concat(
        ["refs/heads/main", "refs/heads/feature"].map((name) => ({
          old: phase1Tips.find((p) => p.name === name).oid,
          next: phase2Refs.find((r) => r.name === name).oid,
          ref: name,
        }))
      );
    await workerReceive(parent, bucket, new Uint8Array(pack), cmds);
    check("push 2 committed (thin pack, cross-pack delta bases)", true);
  }
  const parentRefs = parent.store.refs().map((r) => ({ name: r.name, oid: r.oid }));
  check(
    "parent holds every fixture ref",
    JSON.stringify(parentRefs.map((r) => [r.name, r.oid]).sort()) === JSON.stringify(phase2Refs.map((r) => [r.name, r.oid]).sort())
  );
  const parentCatalogPacks = parent.store.packs.activeCatalogAfter("", 100).map((p) => p.packKey).sort();
  check("parent catalog has 2 active r2 packs", parentCatalogPacks.length === 2);

  // -- §5.3 paging shape: row budget splits packs, cursor covers every row --
  {
    const total = parent.sql.db.prepare("SELECT COUNT(*) AS n FROM pack_objects").get().n;
    let cursor = "";
    let rows = 0;
    let pages = 0;
    let sawSplit = false;
    for (;;) {
      const page = listCatalogPage(parent.host, cursor, 5);
      pages++;
      for (const p of page.packs) {
        rows += p.rows.length;
        if (!p.rowsComplete) sawSplit = true;
      }
      if (!page.more) break;
      cursor = page.nextAfter;
    }
    check("paged listing covers every index row", rows === total);
    check("paged listing splits oversized packs across pages", sawSplit);
    check("paged listing needed multiple pages", pages > 1);
  }

  // -- fork 1: the full replication loop, default page size --
  const parentApi = {
    listCatalogPage: (after, limit) => listCatalogPage(parent.host, after, limit),
    listRefs: async () => ({
      head: parent.store.resolveHead() ? parent.store.head() : null,
      refs: parent.store.refs().map((r) => ({ name: r.name, target: r.oid })),
    }),
  };
  const forkApi = (t) => ({
    beginForkImport: (k) => beginForkImport(t.host, k),
    adoptForkPacks: (page) => adoptForkPacks(t.host, page),
    finalizeForkImport: (input) => finalizeForkImport(t.host, input),
  });
  const fork1 = makeCell(bucket, "r_fork1");
  const rep = await replicateForkCatalog(parentApi, forkApi(fork1), bucket, {
    parentStorageKey: "r_parent",
    forkStorageKey: "r_fork1",
  });
  check("replication reports every pack", rep.packs === 2);
  check("finalize bumped refs_version", Number(rep.refsVersion) >= 1);
  check(
    "fork refs byte-identical to parent",
    JSON.stringify(fork1.store.refs().map((r) => [r.name, r.oid]).sort()) === JSON.stringify(parentRefs.map((r) => [r.name, r.oid]).sort())
  );
  check("fork HEAD == parent HEAD", fork1.store.head() === parent.store.head());
  check("fork importing cleared", fork1.store.getMeta("importing") === "0");
  check(
    "fork catalog keys == parent keys",
    JSON.stringify(fork1.store.packs.activeCatalogAfter("", 100).map((p) => p.packKey).sort()) === JSON.stringify(parentCatalogPacks)
  );
  check(
    "fork catalog rows are kind='fork' + active + r2",
    fork1.store.packs.activeCatalogAfter("", 100).every((p) => p.kind === "fork" && p.state === "active" && p.location === "r2")
  );
  // R2 byte parity (the streamed copy path)
  let bytesEqual = true;
  for (const pk of parentCatalogPacks) {
    for (const ext of [".pack", ".idx"]) {
      const a = bucket.map.get(`repos/r_parent/packs/${pk}${ext}`);
      const b = bucket.map.get(`repos/r_fork1/packs/${pk}${ext}`);
      if (!a || !b || Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) bytesEqual = false;
    }
  }
  check("fork R2 bytes byte-identical to parent (streamed copy)", bytesEqual);
  // in-store reachable parity
  const parentReach = await reachableSet(parent.store);
  const fork1Reach = await reachableSet(fork1.store);
  check(
    "fork reachable set == parent reachable set",
    parentReach.size === fork1Reach.size && [...parentReach].every((o) => fork1Reach.has(o))
  );

  // -- real-git clone parity: the fork SERVES a byte-valid clone --
  const tips = parentRefs.map((r) => r.oid);
  const parentPack = await serveClonePack(parent.store, tips);
  const forkPack = await serveClonePack(fork1.store, tips);
  check("fork clone pack starts with PACK magic", forkPack.slice(0, 4).toString("latin1") === "PACK");
  const cloneParent = materialize(parentPack, join(work, "clone-parent"));
  const cloneFork = materialize(forkPack, join(work, "clone-fork"));
  check("git fsck --strict clean on parent clone", fsckClean(cloneParent));
  check("git fsck --strict clean on fork clone", fsckClean(cloneFork));
  check("fork clone object listing == parent clone listing", objectListing(cloneFork) === objectListing(cloneParent));
  const countsFixture = revCounts(fixture, tips);
  check("fork clone rev-list counts == fixture (per tip)", JSON.stringify(revCounts(cloneFork, tips)) === JSON.stringify(countsFixture));
  check("parent clone rev-list counts == fixture (per tip)", JSON.stringify(revCounts(cloneParent, tips)) === JSON.stringify(countsFixture));

  // -- fork 2: crash injection + tiny pages (split-pack stress) + re-run --
  const fork2 = makeCell(bucket, "r_fork2");
  let crashed = false;
  try {
    await replicateForkCatalog(parentApi, forkApi(fork2), bucket, {
      parentStorageKey: "r_parent",
      forkStorageKey: "r_fork2",
      rowsPerPage: 2,
      afterPage: (_page, n) => {
        if (n === 2) {
          crashed = true;
          throw new Error("consumer died mid-replication (injected)");
        }
      },
    });
  } catch (err) {
    check("crash injection fired mid-loop", crashed && String(err.message).includes("injected"));
  }
  check("crashed fork is un-servable (no refs)", fork2.store.refs().length === 0);
  check("crashed fork still gated (importing=1)", fork2.store.getMeta("importing") === "1");
  // the §5.3 gates while importing
  const anyTip = parentRefs[0].oid;
  const g1 = await beginReceive(fork2.host, {
    commands: [{ old: ZERO_OID, next: anyTip, ref: "refs/heads/x" }],
    capabilities: [],
    packBytesHint: null,
    storageKey: "r_fork2",
  });
  check("beginReceive during import -> importing", g1.tag === "importing");
  const g2 = await commitApiChange(fork2.host, { ref: "refs/heads/x", expectedOldOid: ZERO_OID, newOid: anyTip });
  check("commitApiChange during import -> importing", g2.tag === "importing");
  const g3 = await executeMerge(fork2.host, {
    style: "merge",
    base: "refs/heads/main",
    head: "refs/heads/feature",
    expectedBaseOid: ZERO_OID,
    message: "x",
    author: { name: "a", email: "a@a", time: 0 },
    committer: { name: "a", email: "a@a", time: 0 },
    extraRefUpdates: [],
  });
  check("executeMerge during import -> importing", g3.tag === "importing");
  // re-run to completion (idempotent re-run over partial rows)
  const rep2 = await replicateForkCatalog(parentApi, forkApi(fork2), bucket, {
    parentStorageKey: "r_parent",
    forkStorageKey: "r_fork2",
    rowsPerPage: 2,
  });
  check("re-run completes after crash", rep2.refs === parentRefs.length);
  check(
    "re-run: fork2 refs == parent refs",
    JSON.stringify(fork2.store.refs().map((r) => [r.name, r.oid]).sort()) === JSON.stringify(parentRefs.map((r) => [r.name, r.oid]).sort())
  );
  const fork2Reach = await reachableSet(fork2.store);
  check("re-run: fork2 reachable set == parent", fork2Reach.size === parentReach.size && [...parentReach].every((o) => fork2Reach.has(o)));
  check("re-run: importing cleared", fork2.store.getMeta("importing") === "0");
  const fork2Pack = await serveClonePack(fork2.store, tips);
  const cloneFork2 = materialize(fork2Pack, join(work, "clone-fork2"));
  check("re-run: fork2 clone listing == parent clone listing", objectListing(cloneFork2) === objectListing(cloneParent));
  // post-finalize: pushes work again
  const after = await beginReceive(fork2.host, {
    commands: [{ old: ZERO_OID, next: anyTip, ref: "refs/heads/post-import" }],
    capabilities: [],
    packBytesHint: null,
    storageKey: "r_fork2",
  });
  check("beginReceive after finalize -> ok (gate lifted)", after.tag === "ok");
  if (after.tag === "ok") await releaseReceive(fork2.host, { leaseToken: after.leaseToken, sweep: true });

  // -- sqlite-location rehydration (small-pack path; no production writer yet) --
  // phase 3 commit → push 3 → convert pack 3 to location='sqlite' (bytes into
  // pack_data chunks, R2 .pack deleted; the .idx sidecar stays in R2 per the
  // documented design) → replicate to fork 3
  writeFileSync(join(fixture, "c5.txt"), "five\n");
  git(fixture, "add -A");
  git(fixture, "commit -qm c5");
  const phase3Refs = fixtureRefs(fixture);
  let sqlitePackKey = "";
  {
    const pack = packFixture(fixture, phase2Refs.map((r) => r.oid), false);
    const mainTip = phase3Refs.find((r) => r.name === "refs/heads/main").oid;
    const cmds = [
      { old: phase2Refs.find((r) => r.name === "refs/heads/main").oid, next: mainTip, ref: "refs/heads/main" },
    ];
    const r = await workerReceive(parent, bucket, new Uint8Array(pack), cmds);
    check("push 3 committed", true);
    // convert pack 3 to sqlite location
    sqlitePackKey = r.packName;
    const packBytes = bucket.map.get(`repos/r_parent/packs/${sqlitePackKey}.pack`);
    bucket.map.delete(`repos/r_parent/packs/${sqlitePackKey}.pack`);
    parent.sql.db.prepare("UPDATE pack_catalog SET location = 'sqlite' WHERE pack_key = ?").run(sqlitePackKey);
    for (let seq = 0; seq * PACK_CHUNK < packBytes.length; seq++) {
      parent.sql.db
        .prepare("INSERT INTO pack_data (pack_key, seq, data) VALUES (?, ?, ?)")
        .run(sqlitePackKey, seq, packBytes.subarray(seq * PACK_CHUNK, (seq + 1) * PACK_CHUNK));
    }
    // the parent still serves every object (sqlite read path)
    const meta = parent.store.typeAndSize(mainTip);
    check("parent reads the sqlite-located pack", meta !== null);
    const page1 = listCatalogPage(parent.host, "", 8192);
    check("listCatalogPage flags hasLocalPacks", page1.hasLocalPacks === true);
    const localEntry = page1.packs.find((p) => p.packKey === sqlitePackKey);
    check(
      "sqlite pack rides inline packData",
      Boolean(localEntry?.packData) && Buffer.compare(Buffer.from(localEntry.packData), Buffer.from(packBytes)) === 0
    );
  }
  const fork3 = makeCell(bucket, "r_fork3");
  const rep3 = await replicateForkCatalog(parentApi, forkApi(fork3), bucket, {
    parentStorageKey: "r_parent",
    forkStorageKey: "r_fork3",
  });
  check("replication with a sqlite pack reports all packs", rep3.packs === 3);
  check(
    "fork3 refs == post-phase-3 fixture refs",
    JSON.stringify(fork3.store.refs().map((r) => [r.name, r.oid]).sort()) === JSON.stringify(phase3Refs.map((r) => [r.name, r.oid]).sort())
  );
  const fork3Pack = await serveClonePack(fork3.store, phase3Refs.map((r) => r.oid));
  const cloneFork3 = materialize(fork3Pack, join(work, "clone-fork3"));
  check("fork3 (rehydrated sqlite pack) fsck --strict clean", fsckClean(cloneFork3));
  const phase3Tips = phase3Refs.map((r) => r.oid);
  check(
    "fork3 clone counts == fixture",
    JSON.stringify(revCounts(cloneFork3, phase3Tips)) === JSON.stringify(revCounts(fixture, phase3Tips))
  );
  check("rehydrated pack lands as r2 on the fork", fork3.store.packs.activeCatalogAfter("", 100).every((p) => p.location === "r2"));

  // -- negatives --
  const neg1 = await beginForkImport(parent.host, "r_parent2");
  check("beginForkImport on a non-empty repo -> invalid", neg1.tag === "invalid");
  const negFork1 = await beginForkImport(fork1.host, "r_fork1");
  check("re-begin on a FINALIZED (non-empty) fork -> invalid", negFork1.tag === "invalid");
  const fork4 = makeCell(bucket, "r_fork4");
  const negBegin = await beginForkImport(fork4.host, "r_fork4");
  check("beginForkImport on an empty fork -> ok", negBegin.tag === "ok");
  // adopt BEFORE any bytes were copied: the tail verification must fail closed
  const stalePage = listCatalogPage(parent.host, "", 8192);
  const negAdopt = await adoptForkPacks(fork4.host, stalePage);
  check("adoptForkPacks without copied bytes -> invalid (fail closed)", negAdopt.tag === "invalid");
  const negFinal = await finalizeForkImport(fork4.host, { refs: [], head: null });
  check("finalizeForkImport with nothing staged commits an empty fork", negFinal.tag === "ok");
  check("empty-parent fork: no refs, importing cleared", fork4.store.refs().length === 0 && fork4.store.getMeta("importing") === "0");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed (workdir ${work})`);
  process.exit(fail > 0 ? 1 : 0);
} finally {
  rmSync(work, { recursive: true, force: true });
}

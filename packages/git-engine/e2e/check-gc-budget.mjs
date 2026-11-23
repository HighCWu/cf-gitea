// The M2 GC's migration budget + in-service observability (the receive-busy
// cost map's α arm). Run with tsx, the same mechanism as check-gc.mjs:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-gc-budget.mjs
// Exits non-zero when any check fails.
//
// What makes this honest: the REAL RepoCell alarm path (gc-pending stamp →
// bindR2 → gc() → blockConcurrencyWhile → runGc) over a real GitStore
// (node:sqlite) with an in-memory R2 bucket — the same harness shape as
// check-gc.mjs's cell cadence check, with the missing DO base shimmed inert
// and `ctx.blockConcurrencyWhile` shimmed to direct invocation (a
// single-threaded test has no other work to block; the production semantics
// — nothing interleaves with the body — hold trivially).
//
// Covers:
//   budget  a pack store within the migration budget (ONE compaction window,
//           GC_MIGRATION_MAX_PACK_OBJECTS / GC_MIGRATION_MAX_PACK_BYTES) still
//           runs the legacy wholesale migration end-to-end: reachable packed
//           objects duplicated loose, packs reset — the reachable closure
//           byte-identical before and after. Small repos keep today's
//           behavior exactly.
//   budget  a pack store beyond the budget (either arm: pack_objects row
//           count, or recorded pack bytes) skips BEFORE any walking: the
//           catalog rows survive untouched, removed=0, and the reachable
//           closure is byte-identical (the skip is a deferral, not a
//           mutation — compaction + the M3.4 lifecycle pass remain the
//           reorganization path for pack-native repos).
//   budget  the byte arm's boundary: exactly the budget still runs (the
//           predicate is strictly greater), one byte over skips.
//   lease   a live receive lease skips with the same posture as before
//           (removed=0, packs untouched), now with the reason on the log.
//   logs    the in-service evidence lines: one start line carrying the
//           object counts (objects / packObjects / packBytes), one done line
//           carrying removed/kept/skipped/durationMs — the busy-503 log's
//           "new code in service" shape: the next incident reads the GC's
//           entry, exit and duration straight from the tail.

const { DatabaseSync } = await import("node:sqlite");
const { register } = await import("node:module");

// repo.ts extends DurableObject at module scope — same inert shim as
// check-gc.mjs (the cell IS constructed here, over the shimmed base).
const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

const { GitStore } = await import("../src/git/store.ts");
const { NodeSql, assert, assertEq } = await import("./helpers/lib.mjs");
const { RepoCell, GC_MIGRATION_MAX_PACK_OBJECTS, GC_MIGRATION_MAX_PACK_BYTES } = await import("../src/repo.ts");
const { serializeTree, serializeCommit } = await import("../src/commit/serialize.ts");
const { hashObject, parseTree, TYPE_NUM } = await import("../src/git/objects.ts");
const { parseCommit } = await import("../src/git/objects.ts");
const { sha1hex } = await import("../src/git/util.ts");
const { packR2Key } = await import("../src/git/r2keys.ts");
const { Crc32 } = await import("../src/receive/idx.ts");
const pako = (await import("pako")).default;

const te = new TextEncoder();
const STORAGE = "test-storage";
const PACK_BIG = "pack-" + "b".repeat(40);

let planned = 0;
const failures = [];
async function check(name, fn) {
  planned++;
  try {
    await fn();
    console.log(`ok: ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Harness: real-tx store + fake R2 bucket + a RepoCell over shimmed ctx
// ---------------------------------------------------------------------------

function fakeBucket(objects) {
  return {
    async put(key, value) {
      objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
      return objects.get(key);
    },
    async get(key, req) {
      const data = objects.get(key);
      if (!data) return null;
      const off = req?.range?.offset ?? 0;
      const want = req?.range?.length ?? data.length;
      const len = Math.min(want, data.length - off);
      const slice = data.subarray(off, off + len);
      const ab = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
      return { arrayBuffer: async () => ab };
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list({ prefix }) {
      const out = [];
      for (const k of objects.keys()) {
        if (k.startsWith(prefix)) out.push({ key: k });
      }
      return { objects: out, truncated: false };
    },
  };
}

/** A real cell whose alarm path drives the private gc() exactly as
 *  production does (gc-pending stamp → alarm → gc → runGc under
 *  blockConcurrencyWhile — shimmed to direct invocation). `logs` captures
 *  the cell's console lines for the in-service evidence pins. */
function makeCell() {
  const db = new DatabaseSync(":memory:");
  const sql = new NodeSql(db);
  const tx = (fn) => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  const objects = new Map();
  const bucket = fakeBucket(objects);
  const cell = new RepoCell({ storage: { sql, transactionSync: tx } }, {});
  cell.env = { REPO_PACKS: bucket };
  cell.store.setR2(bucket, STORAGE); // packed reads (the migration's store.get)
  cell.ctx = {
    storage: { transactionSync: tx, setAlarm: () => Promise.resolve() },
    blockConcurrencyWhile: (fn) => fn(),
  };
  cell.store.setMeta("repo", STORAGE);
  cell.store.setMeta("storage_key", STORAGE);
  const logs = [];
  return { cell, objects, logs };
}

/** Capture the cell's console lines across one async body. */
async function withLogs(logs, fn) {
  const origLog = console.log;
  console.log = (...args) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
}

/** Stamp gc-pending and run the alarm's M2 consumer (the production trigger). */
async function runAlarmGc(cell, logs = []) {
  await withLogs(logs, async () => {
    cell.store.setMeta("gc-pending", "1");
    await cell.alarm();
  });
}

// ---------------------------------------------------------------------------
// Fixture: a real two-commit reachable closure + fabricated pack volume
// (pack builder copied from check-gc.mjs — real packfiles, real offsets)
// ---------------------------------------------------------------------------

function encodeEntryHeader(typeNum, size) {
  const bytes = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

function concatParts(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function buildPack(objects) {
  const chunks = [];
  const head = new Uint8Array(12);
  head.set(te.encode("PACK"), 0);
  const dv = new DataView(head.buffer);
  dv.setUint32(4, 2);
  dv.setUint32(8, objects.length);
  chunks.push(head);
  let pos = 12;
  const rows = [];
  objects.forEach((o) => {
    const start = pos;
    const comp = pako.deflate(o.data);
    const prefix = encodeEntryHeader(TYPE_NUM[o.type], o.data.length);
    for (const p of [prefix, comp]) {
      chunks.push(p);
      pos += p.length;
    }
    const r = {
      oid: hashObject(o.type, o.data),
      offset: start,
      dataOff: pos - comp.length,
      dataLen: comp.length,
      type: o.type,
      size: o.data.length,
      entrySize: o.data.length,
      baseOid: null,
      crc32: 0,
    };
    const crc = new Crc32();
    crc.update(prefix);
    crc.update(comp);
    r.crc32 = crc.get();
    rows.push(r);
  });
  const sha = sha1hex(concatParts(chunks));
  chunks.push(new Uint8Array(20)); // trailer placeholder (not read in these checks)
  return { bytes: concatParts(chunks), rows };
}

/** The reachable closure: root commit + child, each with its own blob+tree.
 *  `via` — "loose" (store.put) or "packed" (one real pack + index rows +
 *  the pack bytes in R2). */
function seedClosure(store, objects, via) {
  const b1 = te.encode("alpha content one\n");
  const b2 = te.encode("alpha content two\n");
  const tree1 = serializeTree([{ mode: "100644", oid: hashObject("blob", b1), name: "a.txt" }]);
  const tree2 = serializeTree([{ mode: "100644", oid: hashObject("blob", b2), name: "a.txt" }]);
  const c1 = serializeCommit({ tree: tree1.oid, parents: [], author: PERSON, committer: PERSON, message: "root" });
  const c2 = serializeCommit({
    tree: tree2.oid,
    parents: [c1.oid],
    author: PERSON,
    committer: PERSON,
    message: "child",
  });
  const all = [
    { type: "blob", data: b1 },
    { type: "blob", data: b2 },
    { type: "tree", data: tree1.data },
    { type: "tree", data: tree2.data },
    { type: "commit", data: c1.data },
    { type: "commit", data: c2.data },
  ];
  if (via === "loose") {
    for (const o of all) store.put(hashObject(o.type, o.data), o.type, o.data);
  } else {
    const { bytes, rows } = buildPack(all);
    const key = "pack-" + sha1hex(te.encode("closure-pack"));
    objects.set(packR2Key(STORAGE, key), bytes);
    objects.set(`${packR2Key(STORAGE, key)}.idx`, te.encode(`idx-${key}`));
    store.packs.putRows(key, rows);
    store.packs.recordPack(key, bytes.length, 64);
  }
  store.setRef("refs/heads/main", c2.oid);
  store.setHead("refs/heads/main");
}

const PERSON = { name: "t", email: "t@t", time: 1700000000, tz: "+0000" };

/** The reachable closure read back as type:hex pairs (fsck-shape), for the
 *  byte-identical before/after comparison. */
async function closureSnapshot(store) {
  const out = new Map();
  const stack = store.refs().map((r) => r.oid);
  const head = store.resolveHead();
  if (head) stack.push(head);
  while (stack.length) {
    const oid = stack.pop();
    if (out.has(oid)) continue;
    const obj = await store.get(oid);
    if (!obj) throw new Error(`fsck walk: object ${oid} unreadable`);
    out.set(oid, `${obj.type}:${Buffer.from(obj.data).toString("hex")}`);
    if (obj.type === "commit") {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === "tree") {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    }
  }
  return out;
}

/** `n` fabricated unreachable blob rows (distinct oids, index-only — no pack
 *  bytes needed: the budget predicate counts rows, not reachability). */
function seedFabricatedRows(store, n, label) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      oid: sha1hex(te.encode(`${label} ${i}`)),
      offset: 12,
      dataOff: 0,
      dataLen: 16,
      type: "blob",
      size: 8,
      entrySize: 16,
      baseOid: null,
      crc32: 0,
    });
  }
  store.packs.putRows(PACK_BIG, rows);
}

const catalogRows = (store) => store.packs.countObjects();

async function assertClosureIntact(store, pre) {
  const post = await closureSnapshot(store);
  assertEq(post.size, pre.size, "the reachable oid set survived");
  for (const [oid, v] of pre) assertEq(post.get(oid), v, `object ${oid} byte-identical`);
}

// ---------------------------------------------------------------------------
// budget: below the line the legacy migration still runs end-to-end
// ---------------------------------------------------------------------------

await check("budget: a small packed repo still runs the legacy wholesale migration (control) — packs reset, closure byte-identical", async () => {
  const { cell, objects } = makeCell();
  seedClosure(cell.store, objects, "packed");
  const pre = await closureSnapshot(cell.store);
  const tip = cell.store.getRef("refs/heads/main");
  assert(catalogRows(cell.store) > 0, "pack rows present before");

  await runAlarmGc(cell);

  // the legacy semantics, unchanged: every pack row migrated loose + reset
  assertEq(catalogRows(cell.store), 0, "packs reset (the legacy conversion ran)");
  await assertClosureIntact(cell.store, pre);
  assertEq(cell.store.getRef("refs/heads/main"), tip, "main tip intact");
});

// ---------------------------------------------------------------------------
// budget: over the object arm the GC skips before any walking
// ---------------------------------------------------------------------------

await check("budget: pack_objects rows beyond GC_MIGRATION_MAX_PACK_OBJECTS skip the wholesale migration — catalog intact, closure byte-identical", async () => {
  const { cell, objects } = makeCell();
  seedClosure(cell.store, objects, "loose");
  seedFabricatedRows(cell.store, GC_MIGRATION_MAX_PACK_OBJECTS + 1, "obj arm");
  const pre = await closureSnapshot(cell.store);
  const rowsBefore = catalogRows(cell.store);
  assertEq(rowsBefore, GC_MIGRATION_MAX_PACK_OBJECTS + 1, "fixture is over the object arm");

  await runAlarmGc(cell);

  assertEq(catalogRows(cell.store), rowsBefore, "every pack row survived (no migration, no reset)");
  assertEq(cell.store.getMeta("gc-pending"), "0", "the stamp is consumed (at-most-once, as before)");
  await assertClosureIntact(cell.store, pre);
});

// ---------------------------------------------------------------------------
// budget: the byte arm + its boundary (strictly greater; at the line it runs)
// ---------------------------------------------------------------------------

await check("budget: recorded pack bytes beyond GC_MIGRATION_MAX_PACK_BYTES skip; exactly the budget still runs", async () => {
  // over the line: skip, catalog intact
  {
    const { cell, objects } = makeCell();
    seedClosure(cell.store, objects, "loose");
    seedFabricatedRows(cell.store, 2, "byte arm");
    cell.store.packs.recordPack(PACK_BIG, GC_MIGRATION_MAX_PACK_BYTES + 1, 64);
    assert(cell.store.packs.totalPackBytes() > GC_MIGRATION_MAX_PACK_BYTES, "fixture is over the byte arm");
    const rowsBefore = catalogRows(cell.store);
    const pre = await closureSnapshot(cell.store);

    await runAlarmGc(cell);

    assertEq(catalogRows(cell.store), rowsBefore, "over the byte arm: catalog intact");
    await assertClosureIntact(cell.store, pre);
  }
  // exactly at the line: the legacy migration runs (predicate is strict >)
  {
    const { cell, objects } = makeCell();
    seedClosure(cell.store, objects, "loose");
    seedFabricatedRows(cell.store, 2, "byte arm");
    cell.store.packs.recordPack(PACK_BIG, GC_MIGRATION_MAX_PACK_BYTES, 64); // total == budget
    assertEq(cell.store.packs.totalPackBytes(), GC_MIGRATION_MAX_PACK_BYTES, "fixture sits exactly at the budget");

    await runAlarmGc(cell);

    assertEq(catalogRows(cell.store), 0, "at the budget: the legacy migration ran (packs reset)");
  }
});

// ---------------------------------------------------------------------------
// lease: a live receive lease skips with its reason on the log, packs intact
// ---------------------------------------------------------------------------

await check("lease: a live receive lease skips with packs untouched (unchanged posture, now logged)", async () => {
  const { cell, objects } = makeCell();
  seedClosure(cell.store, objects, "packed");
  cell.store.createLease("livetoken", "receive", Date.now() + 60_000, "{}");
  const rowsBefore = catalogRows(cell.store);
  const pre = await closureSnapshot(cell.store);

  await runAlarmGc(cell);

  assertEq(catalogRows(cell.store), rowsBefore, "packs untouched under the live lease");
  await assertClosureIntact(cell.store, pre);
  assertEq(cell.store.getLease("livetoken")?.kind, "receive", "the lease survives (the sweep only reaps expired rows)");
});

// ---------------------------------------------------------------------------
// logs: the in-service evidence lines
// ---------------------------------------------------------------------------

await check("logs: the alarm GC emits one start line (objects/packObjects/packBytes) and one done line (removed/kept/durationMs) — the busy-503 evidence shape", async () => {
  const { cell, objects, logs } = makeCell();
  seedClosure(cell.store, objects, "packed");
  logs.length = 0;
  await runAlarmGc(cell, logs);

  const start = logs.find((l) => l.includes("[gc test-storage] start:"));
  const done = logs.find((l) => l.includes("[gc test-storage] done:"));
  assert(start, `start line emitted: ${JSON.stringify(logs)}`);
  assert(done, `done line emitted: ${JSON.stringify(logs)}`);
  assert(/objects=\d+/.test(start), `start names the object count: ${start}`);
  assert(/packObjects=\d+/.test(start), `start names the pack object count: ${start}`);
  assert(/packBytes=\d+/.test(start), `start names the pack bytes: ${start}`);
  assert(/removed=\d+/.test(done), `done names removed: ${done}`);
  assert(/kept=\d+/.test(done), `done names kept: ${done}`);
  assert(/durationMs=\d+/.test(done), `done names the duration: ${done}`);

  // the budget skip carries its reason on the done line
  logs.length = 0;
  seedFabricatedRows(cell.store, GC_MIGRATION_MAX_PACK_OBJECTS + 1, "log arm");
  await runAlarmGc(cell, logs);
  const skippedDone = logs.find((l) => l.includes("[gc test-storage] done:"));
  assert(skippedDone && /skipped=migration_budget/.test(skippedDone), `the budget skip names its reason: ${skippedDone}`);
});

await check("logs: the receive-lease skip carries its reason on a dedicated line", async () => {
  const { cell, objects, logs } = makeCell();
  seedClosure(cell.store, objects, "packed");
  cell.store.createLease("livetoken2", "receive", Date.now() + 60_000, "{}");
  logs.length = 0;
  await runAlarmGc(cell, logs);
  const skip = logs.find((l) => l.includes("[gc test-storage] skipped:"));
  assert(skip, `lease skip logged: ${JSON.stringify(logs)}`);
  assert(/receive lease/.test(skip), `the skip names the receive lease: ${skip}`);
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} checks passed`);

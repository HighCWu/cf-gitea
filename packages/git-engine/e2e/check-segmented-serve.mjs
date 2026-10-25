// SPEC-0011 §4.1 M3.2 — the segmented (multi-pack union) serve path under
// read leases, over a REAL GitStore (node:sqlite, real BEGIN/COMMIT — see
// helpers/lib.mjs) with the REAL uploadPack DO arm streaming through a
// range-aware in-memory R2 bucket stub. Run with tsx:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-segmented-serve.mjs
//
// The seam under test is PackStore.chunk()'s R2 Range GET — the "segment" of
// §4.1. The stub records EVERY GET (key, offset, requested length) into the
// same event log the store's createLease spy writes to (plan insert + every
// renewal), so ordering facts — renew-then-read, lease-before-read — are
// asserted against one timeline, the counting-stub pattern of
// check-cache-unreachable.mjs applied to the DO arm's byte seam. A seam guard
// runs inside every GET and fails the check unless exactly one live read lease
// covers the pack being read.
//
// Covers:
//   §4.1  per-entry BOUNDED Range GETs (each <= SERVE_SEGMENT_BYTES,
//         PACK_CHUNK-aligned) and per-segment CONFIRMED renewal — the gate
//         fires before every R2 GET (never on LRU/SQLite hits), renews per
//         PACK past the margin, and rejection is fail-stop.
//   §3.3  renewal ordering at the byte seam: every renewal is immediately
//         followed by the segment GET it authorizes; the plan insert precedes
//         every GET (lease-before-read).
//   §2/§6.3(b) mixed-generation plans are legal: a plan whose payload spans a
//         RETIRED (generation N) pack and an ACTIVE (generation N+1) pack
//         serves both; each location is leased and per-pack renewal
//         authorizes both; a pack that leaves the readable set rejects.
//   §7 fault A/C posture, DO-arm edition: a mid-stream flip to RECLAIMABLE
//         aborts the stream before the flush tail (terminate-and-retry, never
//         a false success) and releases the lease.
//   paths  the gate rides BOTH DO serve arms (cold walk path and
//         warmFullClone) and both emission shapes (sorted multi-pack union and
//         unsorted small-pack); loose-only repos stay guard-free (§3.1).
const { DatabaseSync } = await import("node:sqlite");

const { GitStore } = await import("../src/git/store.ts");
const { NodeSql, assert, assertEq } = await import("./helpers/lib.mjs");
const { uploadPack, serveReadGate } = await import("../src/git/protocol.ts");
const { planFetch, renewAndAuthorizeRead, releaseReadLease } = await import("../src/read-leases.ts");
const { SERVE_SEGMENT_BYTES, PACK_CHUNK } = await import("../src/git/packstore.ts");
const { packR2Key } = await import("../src/git/r2keys.ts");
const { serializeTree, serializeCommit } = await import("../src/commit/serialize.ts");
const { hashObject } = await import("../src/git/objects.ts");
const pako = (await import("pako")).default;

const te = new TextEncoder();
const FLUSH_BYTES = "0000";
const MiB = 1024 * 1024;
const STORAGE = "test-storage";

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

const PACK_A = "pack-" + "a".repeat(40);
const PACK_B = "pack-" + "b".repeat(40);
const FOREIGN = "pack-" + "f".repeat(40);

/** A GitStore whose plan/renew transactions are REAL SQLite transactions,
 * with createLease spied into `events` (plan insert AND every renewal —
 * renewAndAuthorizeRead extends through the same upsert). */
function makeT(events) {
  const db = new DatabaseSync(":memory:");
  const sql = new NodeSql(db);
  const t = { db, sql, events };
  t.store = new GitStore(sql, {
    tx: (fn) => {
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  });
  const orig = t.store.createLease.bind(t.store);
  t.store.createLease = (...args) => {
    events.push({ t: "lease", planId: args[0], expiresAt: args[2] });
    return orig(...args);
  };
  return t;
}

/** The gate's lease state from a manual planFetch (unit checks). */
function leaseOf(plan) {
  assert(plan.tag === "leased", "plan leased");
  return { planId: plan.planId, expiresAt: plan.expiresAt };
}

// ---------------------------------------------------------------------------
// The range-aware R2 stub + the fixture repo (multi-pack union, real entries)
// ---------------------------------------------------------------------------

/** One fake R2-backed pack object: `count` REAL zlib blob entries, the i-th
 * placed inside chunk i (1 MiB stride) so every entry read is an LRU miss —
 * a distinct chunk per entry means one R2 Range GET and one gate call each.
 * Rows are exactly what receive's putIndexRows lands (dataOff past the entry
 * header; entrySize = the uncompressed size PackWriter re-headers with). */
function buildPackObject(count) {
  const bytes = new Uint8Array(count * MiB);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const data = new Uint8Array(96);
    crypto.getRandomValues(data);
    data[0] = i;
    const comp = pako.deflate(data);
    const header = encodeEntryHeader(3, data.length); // 3 = OBJ blob
    const entryStart = i * MiB + 16;
    bytes.set(header, entryStart);
    bytes.set(comp, entryStart + header.length);
    rows.push({
      oid: hashObject("blob", data),
      offset: entryStart,
      dataOff: entryStart + header.length,
      dataLen: comp.length,
      type: "blob",
      size: data.length,
      entrySize: data.length,
      baseOid: null,
      crc32: 0,
    });
  }
  return { bytes, rows };
}

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

/** The in-memory bucket: every Range GET is recorded into `events` and passed
 * through the seam guard BEFORE the bytes move; `onGet` scripts mid-stream
 * side effects (the fault-C flip) after the segment is served. */
function fakeBucket(t, objects, keyToPack) {
  const counts = new Map();
  return {
    async get(key, req) {
      const data = objects.get(key);
      if (!data) return null;
      const off = req?.range?.offset ?? 0;
      const want = req?.range?.length ?? data.length;
      const len = Math.min(want, data.length - off);
      const nth = (counts.get(key) ?? 0) + 1;
      counts.set(key, nth);
      seamGuard(t, keyToPack, key);
      t.events.push({ t: "get", key, packKey: keyToPack.get(key), offset: off, length: want });
      if (t.onGet) t.onGet(keyToPack.get(key), nth);
      const slice = data.subarray(off, off + len);
      const ab = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
      return { arrayBuffer: async () => ab };
    },
  };
}

/** §4.1 at the I/O seam: a segment GET may only run under exactly one live
 * read lease whose protected set names the pack being read. */
function seamGuard(t, keyToPack, r2Key) {
  const packKey = keyToPack.get(r2Key);
  if (!packKey) throw new Error(`seam guard: GET of unregistered key ${r2Key}`);
  const rows = t.sql
    .exec("SELECT payload FROM leases WHERE kind = 'read'")
    .toArray();
  if (rows.length !== 1) throw new Error(`seam guard: ${rows.length} live read leases at a segment GET (want exactly 1)`);
  const payload = JSON.parse(rows[0].payload);
  if (!payload.packKeys.includes(packKey)) {
    throw new Error(`seam guard: GET of ${packKey} is not protected by the plan`);
  }
}

/** The union fixture: commit + tree LOOSE, 12 blobs packed across TWO packs
 * (6 chunk-spread entries each). `packBytesEach` above the raw-chunk window
 * engages the sorted multi-pack emission; below it, the unsorted path. */
function seedUnionRepo(t, objects, keyToPack, packBytesEach, { retiredA = false } = {}) {
  const entries = [];
  for (const packKey of [PACK_A, PACK_B]) {
    const { bytes, rows } = buildPackObject(6);
    const r2Key = packR2Key(STORAGE, packKey);
    objects.set(r2Key, bytes);
    keyToPack.set(r2Key, packKey);
    t.store.packs.putRows(packKey, rows);
    for (const r of rows) entries.push({ mode: "100644", oid: r.oid, name: `f${entries.length}.txt` });
  }
  const tree = serializeTree(entries);
  t.store.put(tree.oid, "tree", tree.data);
  const person = { name: "t", email: "t@t", time: 1700000000000 };
  const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "segmented serve fixture" });
  t.store.put(commit.oid, "commit", commit.data);
  t.store.setRef("refs/heads/main", commit.oid);
  t.store.setHead("refs/heads/main");
  for (const packKey of [PACK_A, PACK_B]) {
    t.store.packs.recordPack(packKey, packBytesEach, 256);
    if (retiredA && packKey === PACK_A) {
      t.store.sql.exec("UPDATE pack_catalog SET state = 'retired' WHERE pack_key = ?", PACK_A);
    }
  }
  return commit;
}

function uploadPackRequest(commitOid) {
  const pkt = (s) => Buffer.from((s.length + 4).toString(16).padStart(4, "0") + s);
  return Buffer.concat([pkt(`want ${commitOid} side-band-64k\n`), Buffer.from(FLUSH_BYTES), pkt("done\n")]);
}

async function drainCapture(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let err = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch (e) {
    err = e;
  }
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return { bytes: out, err };
}

/** A clock that advances `stepMs` on EVERY call — installed around a drain so
 * gate checks deterministically cross the renew margin mid-stream (the margin
 * is relative to the lease's own mint time, so a constant offset cannot force
 * renewals). 17s steps: the 30s margin is crossed within two segments while
 * every renewal stays grantable (each renewal's internal `now` lags its check
 * by one step, and 3 steps = 51s < the 60s TTL it extends), so renewals fire
 * every couple of segments and keep succeeding for the whole stream. */
function stepClock(stepMs) {
  const real = Date.now;
  let cur = real();
  Date.now = () => {
    cur += stepMs;
    return cur;
  };
  return () => {
    Date.now = real;
  };
}

/** Fresh fixture wiring: store + events + R2 objects. */
function newFixture(packBytesEach, opts = {}) {
  const events = [];
  const objects = new Map();
  const keyToPack = new Map();
  const t = makeT(events);
  const commit = seedUnionRepo(t, objects, keyToPack, packBytesEach, opts);
  t.store.setR2(fakeBucket(t, objects, keyToPack), STORAGE);
  return { t, events, commit };
}

// ---------------------------------------------------------------------------
// Unit: the gate itself (serveReadGate over a real lease row)
// ---------------------------------------------------------------------------

await check("§4.1 unit: inside confirmed coverage the gate spends NOTHING (no renewal before the segment)", async () => {
  const events = [];
  const t = makeT(events);
  for (const k of [PACK_A]) t.store.packs.recordPack(k, 4096, 256);
  const plan = planFetch(t.store, { generation: "g" });
  const before = t.sql.exec("SELECT expires_at FROM leases").toArray()[0].expires_at;
  const gate = serveReadGate(t.store, leaseOf(plan));
  gate(PACK_A, 0, PACK_CHUNK); // must not throw, must not renew
  assertEq(t.sql.exec("SELECT expires_at FROM leases").toArray()[0].expires_at, before, "confirmed expiry untouched");
  assertEq(events.length, 1, "only the plan insert — no renewal transaction");
  releaseReadLease(t.store, plan.planId);
});

await check("§4.1 unit: past the margin the gate renews PER PACK and extends the confirmed expiry BEFORE returning", async () => {
  const events = [];
  const t = makeT(events);
  for (const k of [PACK_A, PACK_B]) t.store.packs.recordPack(k, 4096, 256);
  const plan = planFetch(t.store, { generation: "g", ttlMs: 1000 });
  const before = t.sql.exec("SELECT expires_at FROM leases").toArray()[0].expires_at;
  await new Promise((r) => setTimeout(r, 15)); // coverage drops inside the margin
  const gate = serveReadGate(t.store, leaseOf(plan));
  gate(PACK_A, 4 * PACK_CHUNK, PACK_CHUNK); // segment 4 of PACK_A
  const after = t.sql.exec("SELECT expires_at FROM leases").toArray()[0].expires_at;
  assert(after > before, `expiry extended before the read could start: ${after} > ${before}`);
  assertEq(events.length, 2, "insert + exactly the one renewal");
  releaseReadLease(t.store, plan.planId);
});

await check("§3.3 unit: rejection postures at the segment seam are fail-stop (faults A and C)", async () => {
  const events = [];
  const t = makeT(events);
  for (const k of [PACK_A, PACK_B]) t.store.packs.recordPack(k, 4096, 256);
  const planA = planFetch(t.store, { generation: "g", ttlMs: 30 });
  await new Promise((r) => setTimeout(r, 40)); // DO processing delayed past expiry
  let threw = null;
  try {
    serveReadGate(t.store, leaseOf(planA))(PACK_A, 0, PACK_CHUNK);
  } catch (e) {
    threw = e;
  }
  assert(threw && /expired/.test(threw.message), `fault A rejected the segment: ${threw?.message}`);

  const plan = planFetch(t.store, { generation: "g", ttlMs: 1000 });
  t.store.sql.exec("UPDATE pack_catalog SET state = 'reclaimable' WHERE pack_key = ?", PACK_B);
  threw = null;
  try {
    serveReadGate(t.store, leaseOf(plan))(PACK_B, 0, PACK_CHUNK);
  } catch (e) {
    threw = e;
  }
  assert(threw && /no longer readable/.test(threw.message), `fault C (irreversible RECLAIMABLE) rejected: ${threw?.message}`);
  threw = null;
  try {
    serveReadGate(t.store, leaseOf(plan))(FOREIGN, 0, PACK_CHUNK);
  } catch (e) {
    threw = e;
  }
  assert(threw && /not protected/.test(threw.message), `foreign pack rejected: ${threw?.message}`);
  releaseReadLease(t.store, plan.planId);
});

await check("§6.3(b) unit: mixed-generation plan — retired (gen N) + active (gen N+1) both leased, per-pack renewal authorizes BOTH", async () => {
  const events = [];
  const t = makeT(events);
  for (const k of [PACK_A, PACK_B]) t.store.packs.recordPack(k, 4096, 256);
  t.store.sql.exec("UPDATE pack_catalog SET state = 'retired' WHERE pack_key = ?", PACK_A);
  const plan = planFetch(t.store, { generation: "gen-2", ttlMs: 1000 });
  assertEq(plan.packKeys, [PACK_A, PACK_B], "the protected set spans both generations");
  const lease = leaseOf(plan);
  const retired = renewAndAuthorizeRead(t.store, lease.planId, PACK_A, { offset: 0, length: PACK_CHUNK });
  assertEq(retired.tag, "authorized", "retired pack serves its existing reader (§2)");
  const active = renewAndAuthorizeRead(t.store, lease.planId, PACK_B, { offset: 0, length: PACK_CHUNK });
  assertEq(active.tag, "authorized", "active pack authorized");
  t.store.sql.exec("UPDATE pack_catalog SET state = 'reclaimable' WHERE pack_key = ?", PACK_B);
  const flipped = renewAndAuthorizeRead(t.store, lease.planId, PACK_B, null);
  assertEq(flipped.tag, "rejected", "a generation-N+1 pack that left the readable set rejects");
  releaseReadLease(t.store, lease.planId);
});

// ---------------------------------------------------------------------------
// Integration: the REAL uploadPack DO arm over the segmented fixture
// ---------------------------------------------------------------------------

await check("§4.1 integration (cold, sorted union): lease-before-read, per-segment renewal ordering, seam guard, bounded GETs", async () => {
  const { t, events, commit } = newFixture(9 * MiB); // 18 MiB catalog: sorted multi-pack emission
  const restore = stepClock(17_000);
  let out;
  try {
    out = await drainCapture(await Promise.resolve(uploadPack(t.store, uploadPackRequest(commit.oid))));
  } finally {
    restore();
  }
  assert(out.err === null, `stream completed cleanly: ${out.err?.message}`);
  assert(
    new TextDecoder().decode(out.bytes).endsWith(FLUSH_BYTES),
    "structural success tail (flush) intact"
  );
  assertEq(events[0].t, "lease", "the plan insert precedes every event (lease-before-read)");
  const gets = events.filter((e) => e.t === "get");
  assertEq(gets.length, 12, "one bounded Range GET per packed entry (6 per pack, all LRU misses)");
  const renewals = events.filter((e) => e.t === "lease" && e !== events[0]);
  assert(renewals.length >= 2, `the stepping clock crossed the margin mid-stream: ${renewals.length} renewals`);
  for (let i = 0; i < events.length; i++) {
    if (events[i].t === "lease" && i > 0) {
      assert(events[i + 1] && events[i + 1].t === "get", `renewal at ${i} is immediately followed by the segment GET it authorizes (renew-then-read)`);
      assert(events[i + 1].packKey !== undefined, "the renewed segment's pack is resolved at the seam");
    }
  }
  const payload = JSON.parse(t.sql.exec("SELECT payload FROM leases").toArray()[0]?.payload ?? "null");
  assertEq(payload, null, "released once the last R2 read completed (§3.4)");
  for (const g of gets) {
    assert(g.length <= SERVE_SEGMENT_BYTES, `segment bound respected: ${g.length} <= ${SERVE_SEGMENT_BYTES}`);
    assert(g.offset % PACK_CHUNK === 0, `segment GET is PACK_CHUNK-aligned (offset ${g.offset})`);
  }
});

await check("§4.1 integration (mixed generations): one plan serves a RETIRED and an ACTIVE pack; every segment of both is leased", async () => {
  const { t, events, commit } = newFixture(9 * MiB, { retiredA: true });
  const restore = stepClock(17_000);
  let out;
  try {
    out = await drainCapture(await Promise.resolve(uploadPack(t.store, uploadPackRequest(commit.oid))));
  } finally {
    restore();
  }
  assert(out.err === null, `stream completed cleanly: ${out.err?.message}`);
  assert(new TextDecoder().decode(out.bytes).endsWith(FLUSH_BYTES), "flush tail intact");
  const gets = events.filter((e) => e.t === "get");
  const packsServed = new Set(gets.map((g) => g.packKey));
  assertEq([...packsServed].sort(), [PACK_A, PACK_B], "both catalog generations' packs were streamed");
  assert(gets.length === 12, "every entry of both packs read through gated segments");
  const renewals = events.filter((e) => e.t === "lease" && e !== events[0]);
  assert(renewals.length >= 2, "per-pack renewals fired mid-stream across the union");
  assertEq(t.sql.exec("SELECT COUNT(*) AS n FROM leases").toArray()[0].n, 0, "released after the last read");
});

await check("§7 fault C integration: a mid-stream flip to RECLAIMABLE aborts before the flush — terminate-and-retry, never false success", async () => {
  const { t, events, commit } = newFixture(9 * MiB);
  t.onGet = (packKey, nth) => {
    if (packKey === PACK_B && nth === 1) {
      // the flip lands AFTER B's first segment was legally served under the
      // live lease; every later B segment must now be refused at its gate
      t.store.sql.exec("UPDATE pack_catalog SET state = 'reclaimable' WHERE pack_key = ?", PACK_B);
    }
  };
  const restore = stepClock(17_000);
  let out;
  try {
    out = await drainCapture(await Promise.resolve(uploadPack(t.store, uploadPackRequest(commit.oid))));
  } finally {
    restore();
  }
  assert(out.err !== null, "the stream errored — the flip was consulted at a segment gate");
  assert(
    /read lease rejected|no longer readable/.test(out.err.message),
    `the error is the gate's rejection: ${out.err.message}`
  );
  assert(
    !new TextDecoder().decode(out.bytes).endsWith(FLUSH_BYTES),
    "no success-completing tail was ever emitted (Property A)"
  );
  const bGets = events.filter((e) => e.t === "get" && e.packKey === PACK_B).length;
  // at most two skip-cadence checks can elapse after the flip before the next
  // renewal-class check consults the catalog and refuses — B serves at most
  // its first three segments, then no read ever touches it again
  assert(bGets >= 1 && bGets <= 3, `B served its pre-flip segment(s) only, then no read ever touched it again (${bGets} gets)`);
  assertEq(t.sql.exec("SELECT COUNT(*) AS n FROM leases").toArray()[0].n, 0, "the error path released the lease");
});

await check("§4.1 integration (warm path): warmFullClone's segments ride the same per-segment gate", async () => {
  const { t, events, commit } = newFixture(9 * MiB);
  // clone #1 (cold walk) populates + stamps the reachable set
  const out1 = await drainCapture(await Promise.resolve(uploadPack(t.store, uploadPackRequest(commit.oid))));
  assert(out1.err === null && new TextDecoder().decode(out1.bytes).endsWith(FLUSH_BYTES), "cold clone completed");
  assertEq(t.store.reachableCacheValid(), true, "the reachable cache is stamped — clone #2 takes warmFullClone");
  events.length = 0;
  const restore = stepClock(17_000);
  let out2;
  try {
    out2 = await drainCapture(await Promise.resolve(uploadPack(t.store, uploadPackRequest(commit.oid))));
  } finally {
    restore();
  }
  assert(out2.err === null, `warm clone completed cleanly: ${out2.err?.message}`);
  assert(new TextDecoder().decode(out2.bytes).endsWith(FLUSH_BYTES), "warm flush tail intact");
  assertEq(events[0].t, "lease", "warm path plans + leases before any read");
  const gets = events.filter((e) => e.t === "get");
  assert(gets.length === 12, "every packed entry re-read through gated segments (8-chunk LRU < 12 chunks)");
  const renewals = events.filter((e) => e.t === "lease" && e !== events[0]);
  assert(renewals.length >= 2, "warm-path renewals fired mid-stream");
  for (let i = 0; i < events.length; i++) {
    if (events[i].t === "lease" && i > 0) {
      assert(events[i + 1] && events[i + 1].t === "get", "warm renew-then-read ordering");
    }
  }
  assertEq(t.sql.exec("SELECT COUNT(*) AS n FROM leases").toArray()[0].n, 0, "released after the last read");
});

await check("§4.1 integration (unsorted small pack): the unsorted emission path gates its segments too", async () => {
  const { t, events, commit } = newFixture(1 * MiB); // 2 MiB catalog: below the raw-chunk window, unsorted emission
  const out = await drainCapture(await Promise.resolve(uploadPack(t.store, uploadPackRequest(commit.oid))));
  assert(out.err === null, `completed: ${out.err?.message}`);
  assert(new TextDecoder().decode(out.bytes).endsWith(FLUSH_BYTES), "flush tail intact");
  const gets = events.filter((e) => e.t === "get");
  assert(gets.length === 12, "both packs' entries read (unsorted walk order still gated per segment)");
  for (const g of gets) {
    assert(g.length <= SERVE_SEGMENT_BYTES && g.offset % PACK_CHUNK === 0, "bounded aligned segments on the unsorted path");
  }
  assertEq(t.sql.exec("SELECT COUNT(*) AS n FROM leases").toArray()[0].n, 0, "released after the last read");
});

await check("§3.1 integration (loose-only): no dependency, no lease, no R2 — the serve runs guard-free", async () => {
  const events = [];
  const t = makeT(events);
  const objects = new Map();
  const keyToPack = new Map();
  t.store.setR2(fakeBucket(t, objects, keyToPack), STORAGE); // empty objects: any GET would fail the seam guard
  const data = te.encode("loose-only fixture");
  const oid = hashObject("blob", data);
  t.store.put(oid, "blob", data);
  const tree = serializeTree([{ mode: "100644", oid, name: "f.txt" }]);
  t.store.put(tree.oid, "tree", tree.data);
  const person = { name: "t", email: "t@t", time: 1700000000000 };
  const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "loose-only" });
  t.store.put(commit.oid, "commit", commit.data);
  t.store.setRef("refs/heads/main", commit.oid);
  t.store.setHead("refs/heads/main");
  const out = await drainCapture(await Promise.resolve(uploadPack(t.store, uploadPackRequest(commit.oid))));
  assert(out.err === null, `completed: ${out.err?.message}`);
  assert(new TextDecoder().decode(out.bytes).endsWith(FLUSH_BYTES), "flush tail intact");
  assertEq(events.length, 0, "no lease row was ever written (planId \"\" = no guard)");
  assertEq(events.filter((e) => e.t === "get").length, 0, "no R2 interaction");
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} segmented-serve checks passed`);

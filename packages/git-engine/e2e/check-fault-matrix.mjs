// SPEC-0011 §7.2 M3.5 — the fault-injection matrix rows 1-5, completion tail.
// Rows are asserted against the LANDED checks where they already hold (cited
// in the SPEC-0011 §9 M3.5 record); this script adds the missing slices over
// a REAL GitStore (node:sqlite, real BEGIN/COMMIT — see helpers/lib.mjs), the
// REAL uploadPack DO arm streaming through a range-aware in-memory R2 bucket
// stub, and the REAL runCompaction/runGcPass. Run with tsx:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-fault-matrix.mjs
//
// Row audit → what lives here vs landed:
//   row 1 (fetch × compaction concurrency): landed check-compaction §2/§5.4
//         proves a pre-compaction plan keeps reading (compaction runs to
//         completion, then the reader continues) and check-gc §7.1 runs GC
//         mid-stream — but no landed check interleaves a REAL compaction
//         publish INTO an in-flight segmented fetch. Added here: the publish
//         lands between segment GETs of the live stream (onGet hook), both
//         succeed, the seam guard stays armed across the publish, and the
//         closure is byte-identical.
//   row 2 (slow-client throttled fetch during GC): landed check-read-leases
//         §4.2/§3.4 pins release-exactly-at-the-last-R2-read for a slow client
//         (no GC running); check-gc §7.1 runs GC mid-stream but with a fast
//         drain. Added here: a GC pass runs MID-TRANSFER of a paced fetch —
//         every flip blocked by the live lease, bytes untouched, transfer
//         completes — and the early-release overlap (row 12's assertion,
//         landed only as a unit posture) is pinned on the same timeline: GC
//         reclaims WHILE the response is still draining and the drain still
//         delivers its flush tail.
//   row 3 (lease expiry mid-stream): landed as units — check-read-leases
//         §3.3 fault A (expired renewal rejected) and the fast-path
//         rejected-renewal termination (synthetic reject), check-segmented-
//         serve §3.3 unit (expired gate throws) and fault-C mid-stream flip.
//         Added here: a REAL mid-stream expiry on the segmented path — a
//         deterministic clock crossing the TTL between segments, the
//         confirmed renewal REJECTED, the reader abandoning the plan: stream
//         errors BEFORE the flush tail, lease released, never false success.
//   row 4 (compaction crash before publish): LANDED — check-compaction §5.3
//         (orphan swept by payload + catalog state, catalog byte-unchanged,
//         next round succeeds). The one assertion the row names that it did
//         not make — "fetches unaffected" — is appended to that landed check.
//   row 5 (compaction crash after publish, mid-delete): LANDED in outcome —
//         check-gc §2's crash-mid-R2-delete and delete-failing-whole checks
//         pin the idempotent-retry convergence, but on a SQL-fabricated
//         retired row. Added here: the full composition — a REAL compaction
//         publish lands, the first GC delete pass crashes mid-R2-batch, the
//         retry converges, the successor stays ACTIVE and serves.
const { DatabaseSync } = await import("node:sqlite");

const { GitStore } = await import("../src/git/store.ts");
const { NodeSql, assert, assertEq } = await import("./helpers/lib.mjs");
const { uploadPack } = await import("../src/git/protocol.ts");
const { runCompaction } = await import("../src/compaction.ts");
const { runGcPass } = await import("../src/gc.ts");
const { SERVE_SEGMENT_BYTES, PACK_CHUNK } = await import("../src/git/packstore.ts");
const { packR2Key, idxR2Key } = await import("../src/git/r2keys.ts");
const { serializeTree, serializeCommit } = await import("../src/commit/serialize.ts");
const { hashObject, parseTree, TYPE_NUM } = await import("../src/git/objects.ts");
const { fromHex, sha1hex } = await import("../src/git/util.ts");
const { Crc32 } = await import("../src/receive/idx.ts");
const pako = (await import("pako")).default;

const te = new TextEncoder();
const FLUSH_BYTES = "0000";
const MiB = 1024 * 1024;
const STORAGE = "test-storage";
const PACK_A = "pack-" + "a".repeat(40);
const PACK_B = "pack-" + "b".repeat(40);
const PACK_C = "pack-" + "c".repeat(40);
const PACK_D = "pack-" + "d".repeat(40);

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
// Harness (check-segmented-serve + check-gc shapes): real-tx store, event log,
// range-aware R2 stub with the seam guard, onGet scripting hook
// ---------------------------------------------------------------------------

function makeT(events) {
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
  const t = { db, sql, events, tx };
  t.store = new GitStore(sql, { tx });
  const orig = t.store.createLease.bind(t.store);
  t.store.createLease = (...args) => {
    events.push({ t: "lease", kind: args[1], planId: args[0], expiresAt: args[2] });
    return orig(...args);
  };
  return t;
}

function liveReadLeaseCount(t) {
  return t.sql.exec("SELECT COUNT(*) AS n FROM leases WHERE kind = 'read'").one().n;
}

function catalogStates(t) {
  return Object.fromEntries(
    t.sql.exec("SELECT pack_key, state FROM pack_catalog").toArray().map((r) => [r.pack_key, r.state])
  );
}

/** The bucket: every GET recorded + seam-guarded while armed; onGet scripts
 * mid-emission side effects (the interleaved publish / mid-transfer GC). */
function fakeBucket(t, objects) {
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
      const packKey = packKeyOfR2Key(key);
      if (t.seamGuardArmed) seamGuard(t, packKey, key);
      t.events.push({ t: "get", key, packKey, offset: off, length: want });
      if (t.onGet) await t.onGet(packKey, nth);
      const slice = data.subarray(off, off + len);
      const ab = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
      return { arrayBuffer: async () => ab };
    },
  };
}

/** pack-<sha1> from `repos/<key>/packs/pack-<sha1>.pack` (any storage key). */
function packKeyOfR2Key(r2Key) {
  const m = /\/packs\/(pack-[0-9a-f]{40})\.pack$/.exec(r2Key);
  return m ? m[1] : null;
}

/** §4.1 at the I/O seam: a segment GET only runs under exactly one live read
 * lease whose protected set names the pack being read. Armed during drains. */
function seamGuard(t, packKey, r2Key) {
  if (!packKey) throw new Error(`seam guard: GET of unregistered key ${r2Key}`);
  const rows = t.sql.exec("SELECT payload FROM leases WHERE kind = 'read'").toArray();
  if (rows.length !== 1) throw new Error(`seam guard: ${rows.length} live read leases at a segment GET (want exactly 1)`);
  const payload = JSON.parse(rows[0].payload);
  if (!payload.packKeys.includes(packKey)) {
    throw new Error(`seam guard: GET of ${packKey} is not protected by the plan`);
  }
}

/** One REAL blob entry placed inside chunk i (1 MiB stride) so every entry
 * read is an LRU miss — one R2 Range GET and one gate call each. */
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

/** The union fixture: commit + tree LOOSE, 12 blobs packed across TWO packs
 * (6 chunk-spread entries each, 9 MiB recorded bytes each → 18 MiB catalog:
 * above the raw-chunk window, the sorted multi-pack emission path). */
function seedUnionRepo(t, objects) {
  const entries = [];
  for (const packKey of [PACK_A, PACK_B]) {
    const { bytes, rows } = buildPackObject(6);
    objects.set(packR2Key(STORAGE, packKey), bytes);
    t.store.packs.putRows(packKey, rows);
    for (const r of rows) entries.push({ mode: "100644", oid: r.oid, name: `f${entries.length}.txt` });
  }
  const tree = serializeTree(entries);
  t.store.put(tree.oid, "tree", tree.data);
  const person = { name: "t", email: "t@t", time: 1700000000000 };
  const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "fault matrix fixture" });
  t.store.put(commit.oid, "commit", commit.data);
  t.store.setRef("refs/heads/main", commit.oid);
  t.store.setHead("refs/heads/main");
  for (const packKey of [PACK_A, PACK_B]) t.store.packs.recordPack(packKey, 9 * MiB, 256);
  t.store.setMeta("repo", STORAGE);
  t.store.setMeta("storage_key", STORAGE);
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

/** A clock advancing `step()` ms on EVERY call — the test mutates the step
 * mid-stream (17 s steps keep renewals grantable; a 120 s step blows through
 * the whole TTL) so the expiry lands deterministically BETWEEN segments. */
function stepClock(stepMs) {
  const real = Date.now;
  let cur = real();
  const state = { step: stepMs };
  Date.now = () => {
    cur += state.step;
    return cur;
  };
  state.restore = () => {
    Date.now = real;
  };
  return state;
}

/** fsck-equivalent walk: every object reachable from the refs, resolved
 * THROUGH the store, as "type:hex" (the pre/post closure comparator). */
async function closureSnapshot(store) {
  const out = new Map();
  const stack = store.refs().map((r) => r.oid);
  while (stack.length) {
    const oid = stack.pop();
    if (out.has(oid)) continue;
    const obj = await store.get(oid);
    if (!obj) throw new Error(`fsck walk: object ${oid} unreadable`);
    out.set(oid, `${obj.type}:${Buffer.from(obj.data).toString("hex")}`);
    if (obj.type === "commit") {
      const m = new TextDecoder().decode(obj.data);
      stack.push(...[...m.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((x) => x[1]));
      stack.push(m.match(/^tree ([0-9a-f]{40})$/m)[1]);
    } else if (obj.type === "tree") {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The §7.2 row-5 fixture (check-gc shape): four REAL packs over a two-commit
// history — the shape a real compaction publish retires.
// ---------------------------------------------------------------------------

function literalDelta(baseSize, target) {
  const out = [];
  const varint = (n) => {
    do {
      let b = n & 0x7f;
      n = Math.floor(n / 128);
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
  };
  varint(baseSize);
  varint(target.length);
  for (let i = 0; i < target.length; i += 127) {
    const chunk = target.subarray(i, Math.min(i + 127, target.length));
    out.push(chunk.length);
    for (const b of chunk) out.push(b);
  }
  return new Uint8Array(out);
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
    let payload;
    let prefix;
    if (o.kind === "full") {
      const comp = pako.deflate(o.data);
      prefix = [encodeEntryHeader(TYPE_NUM[o.type], o.data.length)];
      payload = comp;
      rows.push({
        oid: hashObject(o.type, o.data),
        offset: start,
        dataOff: 0,
        dataLen: comp.length,
        type: o.type,
        size: o.data.length,
        entrySize: o.data.length,
        baseOid: null,
        crc32: 0,
      });
    } else {
      const delta = literalDelta(o.baseData.length, o.target);
      const comp = pako.deflate(delta);
      prefix = [encodeEntryHeader(7, delta.length), fromHex(o.baseOid)];
      payload = comp;
      rows.push({
        oid: hashObject(o.type, o.target),
        offset: start,
        dataOff: 0,
        dataLen: comp.length,
        type: o.type,
        size: o.target.length,
        entrySize: delta.length,
        baseOid: o.baseOid,
        crc32: 0,
      });
    }
    for (const p of prefix) {
      chunks.push(p);
      pos += p.length;
    }
    chunks.push(payload);
    pos += payload.length;
    const r = rows[rows.length - 1];
    r.dataOff = pos - payload.length;
    const crc = new Crc32();
    for (const p of [...prefix, payload]) crc.update(p);
    r.crc32 = crc.get();
  });
  const sha = sha1hex(concatParts(chunks));
  chunks.push(fromHex(sha)); // trailer
  return { bytes: concatParts(chunks), rows, sha };
}

function seedFourPackRepo(store, objects) {
  const b1 = te.encode("alpha content one\n");
  const b2 = te.encode("beta content two\n");
  const b3 = te.encode("gamma content three\n");
  const person = { name: "t", email: "t@t", time: 1700000000000 };

  const tree1 = serializeTree([
    { mode: "100644", oid: hashObject("blob", b1), name: "b1.txt" },
    { mode: "100644", oid: hashObject("blob", b2), name: "b2.txt" },
  ]);
  const tree2 = serializeTree([
    { mode: "100644", oid: hashObject("blob", b1), name: "b1.txt" },
    { mode: "100644", oid: hashObject("blob", b2), name: "b2.txt" },
    { mode: "100644", oid: hashObject("blob", b3), name: "b3.txt" },
  ]);
  const commit1 = serializeCommit({ tree: tree1.oid, parents: [], author: person, committer: person, message: "c1" });
  const commit2 = serializeCommit({ tree: tree2.oid, parents: [commit1.oid], author: person, committer: person, message: "c2" });

  const specs = [
    [PACK_A, [{ kind: "full", type: "blob", data: b1 }, { kind: "full", type: "blob", data: b2 }, { kind: "full", type: "tree", data: tree1.data }]],
    [PACK_B, [{ kind: "full", type: "blob", data: b3 }]],
    [
      PACK_C,
      [
        { kind: "full", type: "commit", data: commit1.data },
        { kind: "ref", type: "commit", target: commit2.data, baseOid: commit1.oid, baseData: commit1.data },
      ],
    ],
    [PACK_D, [{ kind: "ref", type: "tree", target: tree2.data, baseOid: tree1.oid, baseData: tree1.data }]],
  ];
  const oids = { tree1: tree1.oid, tree2: tree2.oid, commit1: commit1.oid, commit2: commit2.oid };
  for (const [packKey, entries] of specs) {
    const { bytes, rows } = buildPack(entries);
    objects.set(packR2Key(STORAGE, packKey), bytes);
    objects.set(idxR2Key(STORAGE, packKey), te.encode(`idx-sidecar-${packKey}`));
    store.packs.putRows(packKey, rows);
    store.packs.recordPack(packKey, bytes.length, 256);
  }
  store.setRef("refs/heads/main", commit2.oid);
  store.setRef("refs/heads/feature", commit1.oid);
  store.setHead("refs/heads/main");
  store.setMeta("repo", STORAGE);
  store.setMeta("storage_key", STORAGE);
  return oids;
}

/** The GC host over a test store + the bucket's object map; `failDeletes`
 * scripts the R2-delete crash windows ("partial": delete the FIRST key of the
 * batch, then die — the exact crash-after-publish-mid-delete state). */
function gcHostOf(t, objects) {
  const host = {
    store: t.store,
    storage: { transactionSync: t.tx, setAlarm: () => Promise.resolve() },
    failDeletes: null,
    async deletePackObjects(keys) {
      const mode = host.failDeletes;
      if (mode === "all") throw new Error("simulated R2 delete failure (whole)");
      if (mode === "partial") {
        if (keys.length) objects.delete(keys[0]); // the crash ate the first object
        host.failDeletes = null;
        throw new Error("simulated isolate death mid-R2-delete");
      }
      for (const k of keys) objects.delete(k);
    },
    listPackObjects: async (prefix) => {
      const out = [];
      for (const k of objects.keys()) if (k.startsWith(prefix)) out.push(k);
      return out;
    },
  };
  return host;
}

function compactionHostOf(t, objects) {
  return {
    store: t.store,
    storage: { transactionSync: t.tx, setAlarm: () => Promise.resolve() },
    putPackObject: async (key, data) => {
      objects.set(key, data);
    },
    deletePackObjects: async (keys) => {
      for (const k of keys) objects.delete(k);
    },
  };
}

// ---------------------------------------------------------------------------
// Row 1: fetch × compaction concurrency — the publish interleaves INTO the
// in-flight segmented fetch; both succeed; never a false success.
// ---------------------------------------------------------------------------

await check("§7.2 row 1 (fetch × compaction concurrency): a REAL publish lands MID-STREAM between segment GETs — both succeed, seam guard holds across the publish, closure byte-identical", async () => {
  const events = [];
  const objects = new Map();
  const t = makeT(events);
  const commit = seedUnionRepo(t, objects);
  t.store.setR2(fakeBucket(t, objects), STORAGE);
  const pre = await closureSnapshot(t.store);

  // the interleaved action: a REAL compaction publish, run INSIDE the
  // emission's segment-GET seam (guarded against re-entrancy — the merge's
  // own R2 reads must not recurse into the hook)
  let cx = null;
  let fired = false;
  t.onGet = async () => {
    if (fired) return;
    fired = true;
    const hook = t.onGet;
    t.onGet = null;
    try {
      cx = await runCompaction(compactionHostOf(t, objects), { force: true });
    } finally {
      t.onGet = hook;
    }
  };

  t.seamGuardArmed = true;
  let out;
  try {
    out = await drainCapture(await Promise.resolve(uploadPack(t.store, uploadPackRequest(commit.oid))));
  } finally {
    t.seamGuardArmed = false;
    t.onGet = null;
  }

  // both succeeded: compaction published AND the fetch completed cleanly
  assert(cx && cx.tag === "compacted", `the interleaved compaction published: ${cx && cx.tag}`);
  assert(out.err === null, `the concurrent fetch completed: ${out.err?.message}`);
  assert(new TextDecoder().decode(out.bytes).endsWith(FLUSH_BYTES), "the success tail (flush) is intact — never a false success");

  // the publish's catalog effect: successor ACTIVE, inputs RETIRED (still
  // serving — the stream read straight through the publish)
  const succ = cx.outputPackKey;
  assertEq(catalogStates(t)[succ], "active", "successor ACTIVE");
  assertEq(catalogStates(t)[PACK_A], "retired", "input A RETIRED");
  assertEq(catalogStates(t)[PACK_B], "retired", "input B RETIRED");
  assert(objects.get(packR2Key(STORAGE, succ)), "successor bytes in R2");

  // the stream genuinely interleaved: the publish ran after some segment GETs
  // and the stream kept making gated GETs afterwards (seam guard armed across
  // the publish proves every one of them was lease-protected)
  const publishAt = events.findIndex((e) => e.t === "lease" && e.kind === "compaction");
  assert(publishAt > 0, "the compaction lease was taken mid-stream");
  const getsAfter = events.filter((e, i) => i > publishAt && e.t === "get").length;
  assert(getsAfter >= 1, `the stream kept reading gated segments after the publish (${getsAfter})`);
  assertEq(liveReadLeaseCount(t), 0, "released at the last R2 read");

  // never a wrong success: the closure the reader streamed is the closure
  // that still serves (publish re-points identical content)
  const post = await closureSnapshot(t.store);
  assertEq(post.size, pre.size, "the reachable oid set survived the interleaving");
  for (const [oid, v] of pre) assertEq(post.get(oid), v, `object ${oid} identical`);

  // and a fresh clone over the post-publish catalog completes too
  const fresh = await drainCapture(await Promise.resolve(uploadPack(t.store, uploadPackRequest(commit.oid))));
  assert(fresh.err === null && new TextDecoder().decode(fresh.bytes).endsWith(FLUSH_BYTES), "post-publish clone completes with its flush tail");
});

// ---------------------------------------------------------------------------
// Row 2: slow-client (throttled) fetch during GC — the lease outlives the
// transfer window that matters (release = last R2 read, not response end);
// GC is blocked mid-transfer and reclaims only after release, while bytes
// still drain (row 12's early-release overlap asserted on the same timeline).
// ---------------------------------------------------------------------------

await check("§7.2 rows 2+12 (slow-client fetch during GC): a GC pass MID-TRANSFER is fully lease-blocked; release lands at the last R2 read; GC reclaims WHILE the response still drains and the drain still delivers its flush tail", async () => {
  const events = [];
  const objects = new Map();
  const t = makeT(events);
  const commit = seedUnionRepo(t, objects);
  t.store.setR2(fakeBucket(t, objects), STORAGE);
  const pre = await closureSnapshot(t.store);

  // the throttled client's world: inputs RETIRED before the fetch (a real
  // publish), so the GC pass has flip candidates while the transfer runs
  const cx = await runCompaction(compactionHostOf(t, objects), { force: true });
  assertEq(cx.tag, "compacted", "inputs retired before the fetch");
  const succ = cx.outputPackKey;

  // mid-transfer GC: blocked by the live lease, bytes untouched
  let gc = null;
  let fired = false;
  t.onGet = async () => {
    if (fired) return;
    fired = true;
    const hook = t.onGet;
    t.onGet = null;
    try {
      gc = await runGcPass(gcHostOf(t, objects));
    } finally {
      t.onGet = hook;
    }
  };

  t.seamGuardArmed = true;
  let out;
  try {
    out = await drainCapture(await Promise.resolve(uploadPack(t.store, uploadPackRequest(commit.oid))));
  } finally {
    t.seamGuardArmed = false;
    t.onGet = null;
  }

  assert(out.err === null, `the throttled fetch completed: ${out.err?.message}`);
  assert(new TextDecoder().decode(out.bytes).endsWith(FLUSH_BYTES), "flush tail intact");
  assert(gc, "the GC pass ran mid-transfer");
  assertEq(gc.flippedToReclaimable, [], "zero flips while the slow client held the lease");
  assertEq(gc.blockedByLeases.sort(), [PACK_A, PACK_B].sort(), "every retired pack blocked by the in-flight reader's lease");
  assertEq(gc.pending, true, "pending work reported");
  assertEq(liveReadLeaseCount(t), 0, "released once the last R2 read completed (not at response end)");

  // row 12's overlap on the same timeline: the response's flush tail was
  // already buffered when the last R2 read completed — GC reclaims WHILE the
  // client is still draining, and the drain still finishes correctly.
  // (Re-run the interleaving with the reclaim hooking the flush observation.)
  const events2 = [];
  const objects2 = new Map();
  const t2 = makeT(events2);
  const commit2 = seedUnionRepo(t2, objects2);
  t2.store.setR2(fakeBucket(t2, objects2), STORAGE);
  const pre2 = await closureSnapshot(t2.store); // fresh random blobs: compare against THIS phase's closure
  const cx2 = await runCompaction(compactionHostOf(t2, objects2), { force: true });
  const succ2 = cx2.outputPackKey;

  const res = await uploadPack(t2.store, uploadPackRequest(commit2.oid));
  const reader = res.body.getReader();
  let reclaimedDuringDrain = false;
  let sawFlushAfterReclaim = false;
  let done = false;
  for (;;) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    const isFlush = new TextDecoder().decode(r.value) === FLUSH_BYTES;
    if (isFlush && liveReadLeaseCount(t2) === 0) {
      // the last R2 read completed BEFORE this final frame drained — reclaim
      // now, while the response is still open
      const after = await runGcPass(gcHostOf(t2, objects2));
      assertEq(after.flippedToReclaimable.sort(), [PACK_A, PACK_B].sort(), "the retired inputs flipped once the reader released");
      assertEq(after.deleted.sort(), [PACK_A, PACK_B].sort(), "and were reclaimed to DELETED");
      assertEq(catalogStates(t2)[succ2], "active", "the successor survives");
      reclaimedDuringDrain = true;
    } else if (reclaimedDuringDrain && isFlush) {
      sawFlushAfterReclaim = true;
    }
  }
  assert(done, "the response drained to completion after the mid-drain reclaim");
  assert(reclaimedDuringDrain, "GC reclaimed while the HTTP response was still draining (release = last R2 read)");
  assert(objects2.get(packR2Key(STORAGE, PACK_A)) === undefined, "reclaimed bytes are gone while the client still read buffered frames");
  assert(new TextDecoder().decode(out.bytes).endsWith(FLUSH_BYTES), "the first (blocked-GC) transfer's flush tail stands");
  void sawFlushAfterReclaim;
  const post = await closureSnapshot(t2.store);
  assertEq(post.size, pre2.size, "closure intact across reclaim-during-drain");
  for (const [oid, v] of pre2) assertEq(post.get(oid), v, `object ${oid} identical`);
});

// ---------------------------------------------------------------------------
// Row 3: lease expiry mid-stream — a REAL clock crossing the TTL between
// segments; the confirmed renewal is rejected (fault A) and the reader
// abandons the plan (terminate-and-retry, never a false success).
// ---------------------------------------------------------------------------

await check("§7.2 row 3 (lease expiry mid-stream): the clock crosses the TTL between segments — the inline renewal is REJECTED, the stream errors BEFORE the flush tail, the abandoned plan is released", async () => {
  const events = [];
  const objects = new Map();
  const t = makeT(events);
  const commit = seedUnionRepo(t, objects);
  t.store.setR2(fakeBucket(t, objects), STORAGE);

  // 17 s steps keep the per-segment renewals grantable (check-segmented-serve
  // shape); once the first renewal has fired, the step blows up to 120 s —
  // the next segment's gate crosses the whole TTL and the renewal rejects
  const clock = stepClock(17_000);
  t.onGet = async () => {
    const renewals = events.filter((e) => e.t === "lease" && e !== events[0]).length;
    if (renewals >= 1) clock.step = 120_000;
  };

  let out;
  try {
    out = await drainCapture(await Promise.resolve(uploadPack(t.store, uploadPackRequest(commit.oid))));
  } finally {
    clock.restore();
    t.onGet = null;
  }

  // the reader abandoned the plan: error before any success tail
  assert(out.err !== null, "the stream errored — an expired lease is never ridden to completion");
  assert(
    /read lease rejected|expired/.test(out.err.message),
    `the error is the gate's rejection: ${out.err.message}`
  );
  assert(
    !new TextDecoder().decode(out.bytes).endsWith(FLUSH_BYTES),
    "no success-completing tail was ever emitted (Property A)"
  );
  // the expiry genuinely landed MID-STREAM: renewals fired before the blow-up
  const renewals = events.filter((e) => e.t === "lease" && e !== events[0]).length;
  assert(renewals >= 1, `the lease was renewed inline before expiring (${renewals} renewals)`);
  const gets = events.filter((e) => e.t === "get");
  assert(gets.length >= 1, "segments were served before the expiry");
  assertEq(liveReadLeaseCount(t), 0, "the error path released the abandoned lease");
  // bounded segments were still respected on the way there
  for (const g of gets) {
    assert(g.length <= SERVE_SEGMENT_BYTES, `segment bound respected pre-expiry: ${g.length} <= ${SERVE_SEGMENT_BYTES}`);
    assert(g.offset % PACK_CHUNK === 0, "segments PACK_CHUNK-aligned");
  }
});

// ---------------------------------------------------------------------------
// Row 5: compaction crash after publish, mid-delete — the REAL publish lands,
// the GC delete dies mid-R2-batch, the idempotent retry converges; the
// successor stays ACTIVE and serves (composition over a real publish, which
// the landed check-gc §2 crash checks assert only on a fabricated retired row).
// ---------------------------------------------------------------------------

await check("§7.2 row 5 (crash after publish, mid-delete): REAL publish → the first GC delete crashes mid-R2-batch → the retry converges idempotently; successor ACTIVE and serving; closure identical", async () => {
  const objects = new Map();
  const events = [];
  const t = makeT(events);
  const oids = seedFourPackRepo(t.store, objects);
  t.store.setR2(fakeBucket(t, objects), STORAGE);
  const pre = await closureSnapshot(t.store);

  // the publish (crash window 1 is landed: check-compaction §5.3) — successor
  // ACTIVE, all four inputs RETIRED with a verifiable supersession chain
  const cx = await runCompaction(compactionHostOf(t, objects), { force: true });
  assertEq(cx.tag, "compacted", "the publish landed");
  const succ = cx.outputPackKey;
  for (const k of [PACK_A, PACK_B, PACK_C, PACK_D]) {
    assertEq(catalogStates(t)[k], "retired", `${k} RETIRED after the real publish`);
  }

  // the crash window: the FIRST GC delete pass dies mid-R2-batch. Per-pack
  // deletes are independent: the pass records the crashed pack as awaiting
  // its ack and continues, so the other three reclaim in the same pass.
  const host = gcHostOf(t, objects);
  host.failDeletes = "partial";
  const crashed = await runGcPass(host);
  assertEq(crashed.flippedToReclaimable.sort(), [PACK_A, PACK_B, PACK_C, PACK_D].sort(), "all four flipped RETIRED→RECLAIMABLE before the crash");
  assertEq(crashed.awaitingDeleteAck.length, 1, "exactly one pack's delete died mid-batch");
  const crashedKey = crashed.awaitingDeleteAck[0];
  assertEq(crashed.deleted.length, 3, "the three un-crashed packs reclaimed in the same pass");
  assert(!crashed.deleted.includes(crashedKey), "the crashed pack is not among the deleted");
  assertEq(catalogStates(t)[crashedKey], "reclaimable", "the crashed row STILL RECLAIMABLE (removal is ack-gated)");
  assertEq(objects.get(packR2Key(STORAGE, crashedKey)), undefined, "the crash ate the crashed pack's object");
  assert(objects.get(idxR2Key(STORAGE, crashedKey)), "its idx survived the crash — the partial delete IS the crash state");
  assertEq(catalogStates(t)[succ], "active", "the published successor is untouched by the crash");
  assert(objects.get(packR2Key(STORAGE, succ)), "successor bytes in place");

  // the idempotent retry: deleting the already-deleted object is a no-op, the
  // remaining bytes go, the ack lands, the row is removed — converged (the
  // crashed pass already carried the three un-crashed packs to DELETED)
  const retry = await runGcPass(host);
  assertEq(retry.deleted, [crashedKey], "the retry reclaims exactly the crashed pack");
  assertEq(retry.pending, false, "the catalog converged");
  for (const k of [PACK_A, PACK_B, PACK_C, PACK_D]) {
    assertEq(catalogStates(t)[k], undefined, `${k} row gone after the retry`);
    assertEq(objects.get(packR2Key(STORAGE, k)), undefined, `${k} bytes gone after the retry`);
    assertEq(objects.get(idxR2Key(STORAGE, k)), undefined, `${k} idx gone after the retry`);
  }

  // the published successor survives and serves: closure identical, flush tail
  const post = await closureSnapshot(t.store);
  assertEq(post.size, pre.size, "the reachable oid set survived publish + crash + retry");
  for (const [oid, v] of pre) assertEq(post.get(oid), v, `object ${oid} identical`);
  const out = await drainCapture(await Promise.resolve(uploadPack(t.store, uploadPackRequest(oids.commit2))));
  assert(out.err === null, `post-convergence fetch completed: ${out.err?.message}`);
  assert(new TextDecoder().decode(out.bytes).endsWith(FLUSH_BYTES), "the post-convergence fetch's flush tail is intact");
  void crashedKey;
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} fault-matrix checks passed`);

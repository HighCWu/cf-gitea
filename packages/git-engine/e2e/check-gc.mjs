// SPEC-0011 §2 M3.4 — pack GC over a REAL GitStore (node:sqlite, real
// BEGIN/COMMIT transactions — see helpers/lib.mjs) with a range-aware
// in-memory R2 bucket stub (with list support for the clone-cache drain),
// the same harness shape as check-compaction.mjs. Run with tsx:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-gc.mjs
//
// Covers (SPEC-0011 §2 + §4.2 + the §7.1 closing counter-example):
//   §2    the full lifecycle ACTIVE→RETIRED(publish)→RECLAIMABLE(zero live
//         read leases)→DELETED(R2 DELETE ack) with a live lease BLOCKING
//         each gated transition; RETIRED keeps serving existing readers
//         through the successor while blocked; idempotent re-scan (the
//         sweeper converges by catalog state, never by assumption).
//   §2    the successor premise: a RETIRED row whose `superseded_by` does
//         not verify (missing/non-ACTIVE successor) is left RETIRED
//         (premiseUnsafe) and flips once the premise holds — publish
//         atomicity makes this unreachable in practice; the sweeper
//         verifies instead of assuming.
//   §2    RECLAIMABLE is irreversible: a late renewal for a RECLAIMABLE or
//         DELETED pack is REJECTED (fault C's never-grant-both, pinned at
//         the GC boundary too — including the defensive delete-phase
//         re-check when a lease somehow names a reclaimable row).
//   §2    crash windows of the delete: a delete that fails whole leaves the
//         row RECLAIMABLE with bytes in place (awaitingDeleteAck); a delete
//         that dies MID-batch (pack gone, idx not) converges idempotently
//         on the retry; the catalog row is removed only after the ack.
//   §4.2  clone-cache GC, lease-drain-only (OQ4 STILL OPEN — version-window
//         retention vs lease-drain-only deferred): the CURRENT version's
//         entry is never collected; a STALE entry with a live cache lease is
//         kept (drain-gated); after release it is deleted; foreign key
//         shapes are never touched.
//   §7.1  the closing counter-example ATTEMPT: a real uploadPack stream
//         interleaved with GC passes — every individual step succeeds
//         (compaction publish, GC flips, R2 deletes, row removals) and yet
//         the concurrent reader under lease NEVER sees a deleted pack: the
//         mid-stream GC is blocked by the live lease, the stream completes
//         with its flush tail, and deletion proceeds only after release.
//         The suite must FAIL to construct it — and does.
//   RPC   the real RepoCell surface (shimmed DO base): gcNow (no-R2 skip,
//         manual round), the alarm cadence (stamp gating, pending re-arm,
//         convergence consumption, the post-compaction stamp).
const { DatabaseSync } = await import("node:sqlite");
const { register } = await import("node:module");

// repo.ts extends DurableObject at module scope — same inert shim as
// check-compaction.mjs (no cell is constructed by the import itself).
const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

const { GitStore } = await import("../src/git/store.ts");
const { NodeSql, assert, assertEq } = await import("./helpers/lib.mjs");
const { uploadPack, serveReadGate } = await import("../src/git/protocol.ts");
const { planFetch, renewAndAuthorizeRead, releaseReadLease } = await import("../src/read-leases.ts");
const { runCompaction } = await import("../src/compaction.ts");
const { runGcPass, GC_RETRY_MS } = await import("../src/gc.ts");
const { cloneCacheKey, idxR2Key, packR2Key } = await import("../src/git/r2keys.ts");
const { serializeTree, serializeCommit } = await import("../src/commit/serialize.ts");
const { hashObject, parseTree, TYPE_NUM } = await import("../src/git/objects.ts");
const { fromHex, sha1hex } = await import("../src/git/util.ts");
const { Crc32 } = await import("../src/receive/idx.ts");
const pako = (await import("pako")).default;

const te = new TextEncoder();
const FLUSH_BYTES = "0000";
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
// Harness: real-tx store + fake R2 bucket (put/get/range/delete/list)
// ---------------------------------------------------------------------------

function makeT() {
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
  const t = { db, sql, tx };
  t.store = new GitStore(sql, { tx });
  /** A SECOND store over the same database, bound to a bucket over `objects`:
   * cold caches, so byte reads exercise the real R2 seam. */
  t.freshStore = (objects) => {
    const cold = new GitStore(sql, { tx });
    cold.setR2(fakeBucket(objects), STORAGE);
    return cold;
  };
  return t;
}

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

/** The GC host over a test store + the bucket's object map. `failDeletes`
 * (a knob for the crash windows) is consulted per call:
 *   "all"      — throw without deleting anything (delete failed whole)
 *   "partial"  — delete the FIRST key, then throw (crash mid-batch)
 *   "all-then-partial" — first call throws whole, second dies mid-batch
 * cleared by assigning null. */
function gcHostOf(t, objects) {
  t.store.setR2(fakeBucket(objects), STORAGE);
  const host = {
    store: t.store,
    storage: { transactionSync: t.tx, setAlarm: () => Promise.resolve() },
    failDeletes: null,
    async deletePackObjects(keys) {
      const mode = host.failDeletes;
      if (mode === "all") throw new Error("simulated R2 delete failure (whole)");
      if (mode === "all-then-partial" || mode === "partial") {
        if (keys.length) objects.delete(keys[0]); // the crash ate the first object
        host.failDeletes = mode === "partial" ? null : "partial";
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

/** The compaction host (M3.3) over the same store + object map. */
function compactionHostOf(t, objects) {
  t.store.setR2(fakeBucket(objects), STORAGE);
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
// Fixture: real objects, real packfiles (copied from check-compaction.mjs)
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
    let prefix;
    let payload;
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

/** Seed the four-pack fixture repo (two refs over a two-commit history). */
function seedRepo(store, objects) {
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
  const commit2 = serializeCommit({
    tree: tree2.oid,
    parents: [commit1.oid],
    author: person,
    committer: person,
    message: "c2",
  });

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

/** Seed `n` single-blob ACTIVE packs (distinct content), insertion order —
 * the window/threshold filler for chained-compaction scenarios. */
function seedTinyPacks(store, objects, n, label = "tiny pack") {
  const keys = [];
  for (let i = 0; i < n; i++) {
    const data = te.encode(`${label} ${i} payload\n`);
    const { bytes, rows } = buildPack([{ kind: "full", type: "blob", data }]);
    const key = "pack-" + sha1hex(bytes);
    keys.push(key);
    objects.set(packR2Key(STORAGE, key), bytes);
    store.packs.putRows(key, rows);
    store.packs.recordPack(key, bytes.length, 256);
  }
  return keys;
}

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

function catalogStates(t) {
  return Object.fromEntries(
    t.sql.exec("SELECT pack_key, state FROM pack_catalog").toArray().map((r) => [r.pack_key, r.state])
  );
}

function liveReadLeaseCount(t) {
  return t.sql.exec("SELECT COUNT(*) AS n FROM leases WHERE kind = 'read' AND expires_at > 0").one().n;
}

function uploadPackRequest(commitOid) {
  const pkt = (s) => Buffer.from((s.length + 4).toString(16).padStart(4, "0") + s);
  return Buffer.concat([pkt(`want ${commitOid} side-band-64k\n`), Buffer.from(FLUSH_BYTES), pkt("done\n")]);
}

// ---------------------------------------------------------------------------
// §2 the full lifecycle, lease-gated at every transition
// ---------------------------------------------------------------------------

await check("§2 lifecycle: ACTIVE→RETIRED(publish, reader keeps reading)→RECLAIMABLE(lease-blocked, then zero leases)→DELETED(R2 ack, row gone); idempotent re-scan", async () => {
  const t = makeT();
  const objects = new Map();
  t.store.setR2(fakeBucket(objects), STORAGE);
  const oids = seedRepo(t.store, objects);
  const pre = await closureSnapshot(t.store);

  // the EXISTING reader: plan+lease BEFORE the compaction (protects A–D)
  const plan = planFetch(t.store, { generation: t.store.refsVersion() });
  assertEq(plan.tag, "leased", "pre-compaction plan leased");

  // ACTIVE→RETIRED (publish) is NOT lease-gated — retired serves existing
  // readers; the publish re-points identical content and the reader rides it
  const cx = await runCompaction(compactionHostOf(t, objects), { force: true });
  assertEq(cx.tag, "compacted", "compaction published under the live lease");
  const succ = cx.outputPackKey;
  assertEq(catalogStates(t)[succ], "active", "successor ACTIVE");
  for (const k of [PACK_A, PACK_B, PACK_C, PACK_D]) {
    assertEq(catalogStates(t)[k], "retired", `${k} RETIRED after publish`);
    assert(objects.get(packR2Key(STORAGE, k)), `${k} bytes still in R2 (retired serves readers)`);
  }
  const renewed = await renewAndAuthorizeRead(t.store, plan.planId, PACK_D, { offset: 0, length: 1024 });
  assertEq(renewed.tag, "authorized", "the existing reader's member renewal authorized post-publish");

  // RETIRED→RECLAIMABLE scan with the lease live: EVERY flip blocked
  const host = gcHostOf(t, objects);
  const blockedPass = await runGcPass(host);
  assertEq(blockedPass.tag, "collected", "pass ran");
  assertEq(blockedPass.flippedToReclaimable, [], "zero flips while a live lease protects the packs");
  assertEq(blockedPass.blockedByLeases.sort(), [PACK_A, PACK_B, PACK_C, PACK_D].sort(), "every retired pack blocked by the lease");
  assertEq(blockedPass.pending, true, "pending work reported");
  for (const k of [PACK_A, PACK_B, PACK_C, PACK_D]) {
    assertEq(catalogStates(t)[k], "retired", `${k} still RETIRED (blocked)`);
    assert(objects.get(packR2Key(STORAGE, k)), `${k} bytes untouched while blocked`);
  }

  // the blocked reader can still READ: a cold raw read of a retired pack
  // under the confirmed-expiry gate serves real bytes
  const cold = t.freshStore(objects);
  const expected = await t.store.packs.readRaw(PACK_D, 0, 64);
  const served = await cold.packs.readRaw(PACK_D, 0, expected.length, serveReadGate(cold, {
    planId: plan.planId,
    expiresAt: renewed.expiresAt,
  }));
  assertEq(Buffer.from(served).toString("hex"), Buffer.from(expected).toString("hex"), "retired bytes servable cold under the gate");

  // the reader finishes (release-on-last-read): the drain gate opens
  releaseReadLease(t.store, plan.planId);
  assertEq(liveReadLeaseCount(t), 0, "the read lease is released");

  // RECLAIMABLE flip now proceeds. One pass carries a pack through BOTH
  // transitions when nothing blocks, so the delete is faulted ("all") to pin
  // RECLAIMABLE as a real resting state between passes:
  host.failDeletes = "all";
  const flipPass = await runGcPass(host);
  assertEq(flipPass.flippedToReclaimable.sort(), [PACK_A, PACK_B, PACK_C, PACK_D].sort(), "all four flipped RETIRED→RECLAIMABLE");
  assertEq(flipPass.deleted, [], "no deletion: every delete failed (no ack)");
  assertEq(flipPass.awaitingDeleteAck.sort(), [PACK_A, PACK_B, PACK_C, PACK_D].sort(), "the failed deletes reported");
  assertEq(flipPass.pending, true, "flipped rows still pended their acks");
  for (const k of [PACK_A, PACK_B, PACK_C, PACK_D]) {
    assertEq(catalogStates(t)[k], "reclaimable", `${k} RECLAIMABLE`);
    assert(objects.get(packR2Key(STORAGE, k)), `${k} bytes still in R2 (reclaimable ≠ deleted)`);
  }
  const late = await renewAndAuthorizeRead(t.store, plan.planId, PACK_D, { offset: 0, length: 1 });
  assertEq(late.tag, "rejected", "renewal after release REJECTED (no future reads — §3.4)");
  // and no NEW plan can protect a RECLAIMABLE pack: the readable set shrank
  // to the successor — RECLAIMABLE is irreversible, nothing re-protects it
  const fresh = planFetch(t.store, { generation: t.store.refsVersion() });
  assertEq(fresh.tag, "leased", "a new plan leases over the readable set");
  assertEq(fresh.packKeys, [succ], "RECLAIMABLE packs are excluded from new plans");
  releaseReadLease(t.store, fresh.planId);

  // RECLAIMABLE→DELETED: R2 delete acks, THEN the rows vanish
  host.failDeletes = null;
  const delPass = await runGcPass(host);
  assertEq(delPass.deleted.sort(), [PACK_A, PACK_B, PACK_C, PACK_D].sort(), "all four reclaimed RECLAIMABLE→DELETED");
  assertEq(delPass.pending, false, "the catalog converged");
  for (const k of [PACK_A, PACK_B, PACK_C, PACK_D]) {
    assertEq(catalogStates(t)[k], undefined, `${k} catalog row GONE (deleted = row gone)`);
    assertEq(objects.get(packR2Key(STORAGE, k)), undefined, `${k} R2 bytes deleted`);
    assertEq(objects.get(idxR2Key(STORAGE, k)), undefined, `${k} idx sidecar deleted`);
  }
  assertEq(catalogStates(t)[succ], "active", "the successor survives GC, ACTIVE");
  assert(objects.get(packR2Key(STORAGE, succ)), "successor bytes in R2");
  // a post-GC plan protects only the successor; the deleted pack rejects
  const postPlan = planFetch(t.store, { generation: t.store.refsVersion() });
  assertEq(postPlan.packKeys, [succ], "post-GC plans protect only the successor");
  const postDel = await renewAndAuthorizeRead(t.store, postPlan.planId, PACK_D, { offset: 0, length: 1 });
  assertEq(postDel.tag, "rejected", "renewal for a DELETED pack rejected");
  releaseReadLease(t.store, postPlan.planId);

  // the repo still serves: the closure is intact through the successor and a
  // NEW plan (post-GC) completes a full clone with its flush tail
  const post = await closureSnapshot(t.store);
  assertEq(post.size, pre.size, "the reachable oid set survived GC");
  for (const [oid, v] of pre) assertEq(post.get(oid), v, `object ${oid} identical after GC`);
  const out = await (async () => {
    const res = await uploadPack(t.store, uploadPackRequest(oids.commit2));
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
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return { bytes, err };
  })();
  assert(out.err === null, `post-GC clone completed: ${out.err?.message}`);
  assert(new TextDecoder().decode(out.bytes).endsWith(FLUSH_BYTES), "post-GC clone's flush tail intact");

  // idempotent re-scan: a pass over a converged catalog no-ops
  const idle = await runGcPass(host);
  assertEq(idle.flippedToReclaimable, [], "re-scan flips nothing");
  assertEq(idle.deleted, [], "re-scan deletes nothing");
  assertEq(idle.pending, false, "re-scan reports convergence");
});

// ---------------------------------------------------------------------------
// §2 the successor premise: verify, never assume
// ---------------------------------------------------------------------------

await check("§2 successor premise: a RETIRED row whose superseded_by does not verify stays RETIRED (premiseUnsafe) and flips once the premise holds", async () => {
  const t = makeT();
  const objects = new Map();
  t.store.setR2(fakeBucket(objects), STORAGE);
  seedRepo(t.store, objects);
  const host = gcHostOf(t, objects);

  // fabricate the unverifiable state: retired with a successor row that does
  // not exist (publish atomicity makes this unreachable for real rows; the
  // sweeper must not reclaim on the assumption it was a real publish)
  t.store.sql.exec("UPDATE pack_catalog SET state = 'retired', superseded_by = ? WHERE pack_key = ?", "pack-" + "ff".repeat(20), PACK_B);
  const pass = await runGcPass(host);
  assertEq(pass.flippedToReclaimable, [], "no flip without a verifiable successor");
  assertEq(pass.premiseUnsafe, [PACK_B], "the row surfaced as premiseUnsafe");
  assertEq(pass.pending, true, "pending until the premise holds");
  assertEq(catalogStates(t)[PACK_B], "retired", "stayed RETIRED");
  assert(objects.get(packR2Key(STORAGE, PACK_B)), "bytes untouched");

  // the premise lands (a committed publish would have written this row):
  // the next scan flips — and, nothing else blocking, the same pass carries
  // the pack through to DELETED (convergence by state)
  t.store.packs.recordPack("pack-" + "ff".repeat(20), 128, 64, "compact");
  const pass2 = await runGcPass(host);
  assertEq(pass2.flippedToReclaimable, [PACK_B], "flipped once the successor premise verifies");
  assertEq(pass2.deleted, [PACK_B], "the unblocked pass carried it through to DELETED");
  assertEq(pass2.premiseUnsafe, [], "no lingering premise failure");
  assertEq(catalogStates(t)[PACK_B], undefined, "row gone");
  assertEq(objects.get(packR2Key(STORAGE, PACK_B)), undefined, "bytes gone");
});

await check("§2 chained compactions: a pack whose successor was ITSELF retired stays premise-safe — the walk follows the chain to the ACTIVE terminal and everything reclaims", async () => {
  const t = makeT();
  const objects = new Map();
  t.store.setR2(fakeBucket(objects), STORAGE);
  const oids = seedRepo(t.store, objects);
  const pre = await closureSnapshot(t.store);
  const cxHost = compactionHostOf(t, objects);

  // two REAL compaction rounds: 10 ACTIVE packs → round 1 merges the oldest
  // 8 into S1 → round 2 merges S1 + the 2 remaining into S2. The first
  // round's inputs now chain A→S1→S2(active).
  seedTinyPacks(t.store, objects, 6);
  const r1 = await runCompaction(cxHost, { force: true });
  assertEq(r1.tag, "compacted", "round 1 ran");
  const r2 = await runCompaction(cxHost, { force: true });
  assertEq(r2.tag, "compacted", "round 2 ran");
  assertEq(r2.inputs.includes(r1.outputPackKey), true, "round 2 merged round 1's successor (the chain exists)");
  assertEq(t.store.packs.activePackCount(), 1, "one ACTIVE pack remains (S2)");

  const host = gcHostOf(t, objects);
  const pass = await runGcPass(host);
  assertEq(pass.flippedToReclaimable.length, r1.inputs.length + r2.inputs.length, "every retired pack flipped — the chain walk verified each one transitively");
  assertEq(pass.premiseUnsafe, [], "no premise failure across the chain");
  assertEq(pass.deleted.length, r1.inputs.length + r2.inputs.length, "and everything reclaimed");
  assertEq(pass.pending, false, "converged");
  for (const k of [...r1.inputs, ...r2.inputs]) {
    assertEq(catalogStates(t)[k], undefined, `${k} reclaimed through the chain`);
    assertEq(objects.get(packR2Key(STORAGE, k)), undefined, `${k} bytes gone`);
  }
  assertEq(catalogStates(t)[r2.outputPackKey], "active", "the chain's terminal ACTIVE pack survives");

  // the content moved A→S1→S2 through REAL publishes: the closure is intact
  // and the repo serves
  const post = await closureSnapshot(t.store);
  for (const [oid, v] of pre) assertEq(post.get(oid), v, `object ${oid} identical across chained reclamation`);
  const res = await uploadPack(t.store, uploadPackRequest(oids.commit2));
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
  assert(err === null, `post-chain clone completed: ${err?.message}`);
});

// ---------------------------------------------------------------------------
// §2 delete crash windows: idempotent retry converges; ack before row removal
// ---------------------------------------------------------------------------

await check("§2 crash mid-R2-delete: pack deleted, idx not, row STILL RECLAIMABLE — the next pass's idempotent retry converges (bytes gone, row gone)", async () => {
  const t = makeT();
  const objects = new Map();
  t.store.setR2(fakeBucket(objects), STORAGE);
  seedRepo(t.store, objects);
  const host = gcHostOf(t, objects);

  // reach RECLAIMABLE with no leases
  t.store.sql.exec("UPDATE pack_catalog SET state = 'retired', superseded_by = ? WHERE pack_key = ?", PACK_A, PACK_B);
  const flip = await runGcPass(host);
  assertEq(flip.flippedToReclaimable, [PACK_B], "flipped");
  assertEq(flip.deleted, [PACK_B], "the same pass reclaimed the rest of the lifecycle");
  assertEq(catalogStates(t)[PACK_B], undefined, "row gone");

  // now the crash window on a SECOND pack: delete dies MID-batch (the pack
  // object is gone, the idx is not, the row removal never ran)
  t.store.sql.exec("UPDATE pack_catalog SET state = 'retired', superseded_by = ? WHERE pack_key = ?", PACK_A, PACK_C);
  host.failDeletes = "partial";
  const crashed = await runGcPass(host);
  assertEq(crashed.flippedToReclaimable, [PACK_C], "flipped before the crash");
  assertEq(crashed.awaitingDeleteAck, [PACK_C], "the crashed delete surfaced as awaiting the ack");
  assertEq(crashed.deleted, [], "no ack, no reclaim");
  assertEq(catalogStates(t)[PACK_C], "reclaimable", "row STILL RECLAIMABLE (removal is ack-gated)");
  assertEq(objects.get(packR2Key(STORAGE, PACK_C)), undefined, "the crash ate the pack object");
  assert(objects.get(idxR2Key(STORAGE, PACK_C)), "the idx survived the crash — partial delete is the crash state");

  // the retry: deleting the missing pack again is a no-op (idempotent), the
  // idx goes, the ack lands, the row is removed — converged
  host.failDeletes = null;
  const retry = await runGcPass(host);
  assertEq(retry.deleted, [PACK_C], "the retry reclaimed");
  assertEq(objects.get(packR2Key(STORAGE, PACK_C)), undefined, "pack bytes gone after the retry");
  assertEq(objects.get(idxR2Key(STORAGE, PACK_C)), undefined, "idx bytes gone after the retry");
  assertEq(catalogStates(t)[PACK_C], undefined, "row removed only after the ack (retry converged)");
});

await check("§2 delete failing whole: the row stays RECLAIMABLE with bytes in place; the retry reclaims; a leased RECLAIMABLE row is never deleted (never grant both)", async () => {
  const t = makeT();
  const objects = new Map();
  t.store.setR2(fakeBucket(objects), STORAGE);
  seedRepo(t.store, objects);
  const host = gcHostOf(t, objects);

  t.store.sql.exec("UPDATE pack_catalog SET state = 'retired', superseded_by = ? WHERE pack_key = ?", PACK_A, PACK_B);
  host.failDeletes = "all";
  const failed = await runGcPass(host);
  assertEq(failed.flippedToReclaimable, [PACK_B], "flipped");
  assertEq(failed.awaitingDeleteAck, [PACK_B], "the failed delete reported");
  assertEq(failed.deleted, [], "nothing reclaimed");
  assertEq(failed.pending, true, "pending the retry");
  assertEq(catalogStates(t)[PACK_B], "reclaimable", "row STILL RECLAIMABLE (never removed without the ack)");
  assert(objects.get(packR2Key(STORAGE, PACK_B)), "pack bytes in place");
  assert(objects.get(idxR2Key(STORAGE, PACK_B)), "idx bytes in place");

  // the retry (no fault) converges
  host.failDeletes = null;
  const retry = await runGcPass(host);
  assertEq(retry.deleted, [PACK_B], "the retry reclaimed");
  assertEq(catalogStates(t)[PACK_B], undefined, "row gone");
  assertEq(objects.get(packR2Key(STORAGE, PACK_B)), undefined, "bytes gone");

  // the defensive delete-phase re-check: a live lease naming an (illegitimately)
  // RECLAIMABLE row blocks the delete — the system never grants both the
  // renewal and the delete (fault C, structural at the GC boundary)
  t.store.sql.exec("UPDATE pack_catalog SET state = 'retired', superseded_by = ? WHERE pack_key = ?", PACK_A, PACK_D);
  const lease = planFetch(t.store, { generation: t.store.refsVersion() }); // protects the still-readable D
  assertEq(lease.tag, "leased", "plan leased");
  t.store.sql.exec("UPDATE pack_catalog SET state = 'reclaimable' WHERE pack_key = ?", PACK_D);
  const guarded = await runGcPass(host);
  assertEq(guarded.blockedByLeases, [PACK_D], "the leased RECLAIMABLE row blocked the delete");
  assertEq(guarded.deleted, [], "nothing deleted");
  assertEq(catalogStates(t)[PACK_D], "reclaimable", "row kept");
  assert(objects.get(packR2Key(STORAGE, PACK_D)), "bytes kept");
  const renewal = await renewAndAuthorizeRead(t.store, lease.planId, PACK_D, { offset: 0, length: 1 });
  assertEq(renewal.tag, "rejected", "and the renewal for that same row is REJECTED — never both");
  releaseReadLease(t.store, lease.planId);
});

// ---------------------------------------------------------------------------
// §4.2 clone-cache GC — lease-drain-only (OQ4 still open)
// ---------------------------------------------------------------------------

await check("§4.2 clone-cache drain: current-version entry never collected; stale entry kept while its stream's lease is live, deleted after release; foreign shapes untouched", async () => {
  const t = makeT();
  const objects = new Map();
  t.store.setR2(fakeBucket(objects), STORAGE);
  seedRepo(t.store, objects);
  const host = gcHostOf(t, objects);

  const current = t.store.reachableVersion();
  const currentKey = cloneCacheKey(STORAGE, current);
  const staleKey = cloneCacheKey(STORAGE, "ab".repeat(20));
  const foreignKey = `repos/${STORAGE}/clone-cache/not-a-version-hash.pack`;
  const payload = te.encode("clone cache pack bytes");
  objects.set(currentKey, payload);
  objects.set(staleKey, payload);
  objects.set(foreignKey, te.encode("foreign"));
  objects.set(`repos/${STORAGE}/packs/keep.pack`, te.encode("a pack — different prefix, not listed"));

  // an in-flight stream on the STALE entry holds a cache lease (a push landed
  // mid-clone: the version it serves is no longer current)
  const plan = planFetch(t.store, { generation: current, packKeys: [staleKey], cache: true });
  assertEq(plan.tag, "leased", "cache plan leased");

  const pass = await runGcPass(host);
  assertEq(pass.cacheEntriesLeased, [staleKey], "the stale entry kept: a live lease reads it");
  assertEq(pass.cacheEntriesDeleted, [], "nothing deleted yet");
  assertEq(pass.pending, true, "the undrained entry keeps the sweep armed");
  assertEq(Buffer.from(objects.get(staleKey)).toString(), Buffer.from(payload).toString(), "stale bytes present");
  assertEq(Buffer.from(objects.get(currentKey)).toString(), Buffer.from(payload).toString(), "current-version entry kept (hot — new plans name it)");
  assertEq(Buffer.from(objects.get(foreignKey)).toString(), "foreign", "foreign key shape untouched");

  // overlap safety is not even needed in the common case: the delete waits
  // for the drain
  releaseReadLease(t.store, plan.planId);
  const drained = await runGcPass(host);
  assertEq(drained.cacheEntriesDeleted, [staleKey], "the drained stale entry deleted");
  assertEq(objects.get(staleKey), undefined, "stale bytes gone");
  assertEq(Buffer.from(objects.get(currentKey)).toString(), Buffer.from(payload).toString(), "current entry STILL kept");
  assertEq(drained.pending, false, "converged");
});

// ---------------------------------------------------------------------------
// §7.1 the closing counter-example — the attempt
// ---------------------------------------------------------------------------

await check("§7.1 counter-example attempt FAILS: compaction + GC + R2 deletes all succeed, and the concurrent reader under lease never sees a deleted pack", async () => {
  const t = makeT();
  const objects = new Map();
  t.store.setR2(fakeBucket(objects), STORAGE);
  const oids = seedRepo(t.store, objects);
  const pre = await closureSnapshot(t.store);
  const host = gcHostOf(t, objects);

  // step 1 (succeeds): compaction publishes — inputs RETIRED, successor ACTIVE
  const cx = await runCompaction(compactionHostOf(t, objects), { force: true });
  assertEq(cx.tag, "compacted", "compaction publish committed");
  const succ = cx.outputPackKey;

  // step 2: a CONCURRENT reader starts a real fetch (uploadPack DO arm) and
  // reads its first bytes — plan+lease atomic, lease-before-first-byte
  const res = await uploadPack(t.store, uploadPackRequest(oids.commit2));
  const reader = res.body.getReader();
  const first = await reader.read();
  assert(first.done === false && first.value.length > 0, "the reader is mid-stream (first bytes emitted)");
  assertEq(liveReadLeaseCount(t), 1, "the in-flight plan's read lease is live");

  // step 3 (succeeds as far as it may): the GC pass runs MID-STREAM and is
  // blocked by the lease — no flip, no delete, every byte still in R2
  const midStream = await runGcPass(host);
  assertEq(midStream.flippedToReclaimable, [], "GC could not flip the packs the reader depends on");
  assertEq(midStream.deleted, [], "GC could not delete anything");
  assertEq(midStream.blockedByLeases.sort(), [PACK_A, PACK_B, PACK_C, PACK_D].sort(), "every dependency blocked by the live lease");
  for (const k of [PACK_A, PACK_B, PACK_C, PACK_D]) {
    assert(objects.get(packR2Key(STORAGE, k)), `concurrent reader's pack ${k} still in R2 mid-stream`);
  }

  // step 4: the reader keeps reading THROUGH the blocked GC (per-segment
  // gate stays authorized) and completes: full data, checksum trailer, flush
  const chunks = [first.value];
  let streamErr = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch (e) {
    streamErr = e;
  }
  assert(streamErr === null, `the concurrent fetch completed: ${streamErr?.message}`);
  let length = 0;
  for (const c of chunks) length += c.length;
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  assert(new TextDecoder().decode(bytes).endsWith(FLUSH_BYTES), "the success tail is intact — a complete, protocol-valid fetch");
  assertEq(liveReadLeaseCount(t), 0, "the serve path released at the last R2 read");

  // steps 5–7 (all succeed): only now do the transitions proceed — flip,
  // delete-ack, row removal, one unblocked pass — every individual
  // transaction a success
  const flip = await runGcPass(host);
  assertEq(flip.flippedToReclaimable.length, 4, "RETIRED→RECLAIMABLE after the drain");
  assertEq(flip.deleted.length, 4, "RECLAIMABLE→DELETED after the acks");
  assertEq(flip.pending, false, "the lifecycle converged");
  const idle = await runGcPass(host);
  assertEq(idle.flippedToReclaimable, [], "the re-scan confirms convergence");
  for (const k of [PACK_A, PACK_B, PACK_C, PACK_D]) {
    assertEq(catalogStates(t)[k], undefined, `${k} legally GC'd`);
    assertEq(objects.get(packR2Key(STORAGE, k)), undefined, `${k} bytes legally gone`);
  }
  assertEq(catalogStates(t)[succ], "active", "the successor (the packs' identical content) remains");

  // THE COUNTER-EXAMPLE FAILS TO CONSTRUCT: every system step succeeded, the
  // reader ran concurrently with GC — and it never observed a deleted pack
  // (every one of its reads returned real bytes; its success tail proves the
  // output complete). The post-hoc closure walk confirms the repo state the
  // reader saw is the state that still serves.
  const post = await closureSnapshot(t.store);
  for (const [oid, v] of pre) assertEq(post.get(oid), v, `object ${oid} identical before and after the whole interleaving`);
});

// ---------------------------------------------------------------------------
// The DO surface: gcNow + the alarm cadence (compaction's stamp pattern)
// ---------------------------------------------------------------------------

await check("RepoCell: gcNow (no-R2 skip, manual round) and the alarm cadence (stamp gating, pending re-arm, convergence consumption, post-compaction stamp)", async () => {
  const { RepoCell } = await import("../src/repo.ts");
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
  const alarms = [];
  const cellStorage = {
    transactionSync: tx,
    setAlarm: (at) => {
      alarms.push(at);
      return Promise.resolve();
    },
  };
  const cell = new RepoCell({ storage: { sql, transactionSync: tx } }, {});
  cell.env = { REPO_PACKS: bucket };
  cell.ctx = { storage: cellStorage };

  const oids = seedRepo(cell.store, objects);

  // no-R2 posture: the manual RPC skips (a RECLAIMABLE row removal requires
  // the delete ack — a host without a bucket must never reach it)
  const savedBucket = cell.env.REPO_PACKS;
  cell.env.REPO_PACKS = undefined;
  const noR2 = await cell.gcNow();
  assertEq(noR2.tag, "skipped", "no R2 backend: gcNow skips");
  assertEq(noR2.reason, "no_r2_backend", "skip reason names the missing backend");
  cell.env.REPO_PACKS = savedBucket;

  // no stamp: the alarm's GC consumer does nothing (no pass, no re-arm)
  alarms.length = 0;
  await cell.alarm();
  assertEq(alarms.length, 0, "no stamp — no GC pass, no re-arm");

  // compaction settles → the stamp lands (post-compaction GC pass) and arms
  const manual = await cell.compactNow({ force: true });
  assertEq(manual.tag, "compacted", "compaction via the cell");
  assert(cell.store.getMeta("gc_wanted_at"), "compaction stamped gc_wanted_at");
  assertEq(alarms.length, 1, "the stamp armed the alarm");
  assert(Math.abs(alarms[0] - (Date.now() + GC_RETRY_MS)) < 5000, "armed on the retry cadence");

  // the alarm pass runs but a live read lease blocks the flip: pending → the
  // stamp is kept and the sweep re-arms (the periodic sweep)
  const plan = planFetch(cell.store, { generation: cell.store.refsVersion() });
  assertEq(plan.tag, "leased", "reader leased");
  alarms.length = 0;
  await cell.alarm();
  assertEq(cell.store.packs.catalogRowsInState("retired").length, manual.inputs.length, "the pass could not flip the leased inputs");
  assert(cell.store.getMeta("gc_wanted_at"), "pending: the stamp is kept");
  assertEq(alarms.length, 1, "pending: the sweep re-armed");

  // the reader drains (release; the next alarm also reaps expired rows first)
  releaseReadLease(cell.store, plan.planId);
  alarms.length = 0;
  await cell.alarm();
  assertEq(cell.store.packs.catalogRowsInState("retired").length, 0, "the freed pass flipped everything");
  assertEq(cell.store.packs.catalogRowsInState("reclaimable").length, 0, "…and reclaimed it");
  for (const k of manual.inputs) {
    assertEq(catalogStates(cell.store)[k], undefined, `${k} DELETED through the alarm path`);
    assertEq(objects.get(packR2Key(STORAGE, k)), undefined, `${k} bytes gone`);
  }
  assertEq(cell.store.getMeta("gc_wanted_at"), "", "converged: the stamp is consumed");
  assertEq(alarms.length, 0, "convergence does not re-arm");

  // the manual round over a converged catalog
  const idle = await cell.gcNow();
  assertEq(idle.tag, "collected", "manual pass ran");
  assertEq(idle.flippedToReclaimable, [], "nothing to flip");
  assertEq(idle.pending, false, "nothing pending");

  // and the repo still clones end-to-end after the whole cadence
  const out = await (async () => {
    const res = await uploadPack(cell.store, uploadPackRequest(oids.commit2));
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
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return { bytes, err };
  })();
  assert(out.err === null, `post-cadence clone completed: ${out.err?.message}`);
  assert(new TextDecoder().decode(out.bytes).endsWith(FLUSH_BYTES), "flush tail intact");
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} checks passed`);

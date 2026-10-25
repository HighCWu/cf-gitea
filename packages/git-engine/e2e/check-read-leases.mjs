// SPEC-0011 §3 M3.1 — DO read-lease gate over a REAL GitStore (node:sqlite
// backend, real BEGIN/COMMIT transactions — see helpers/lib.mjs) plus the real
// serve-path pieces (uploadPack's DO arm and the fast path's re-framing loop),
// driven the same way as check-migrations.mjs / check-cache-unreachable.mjs.
// Run with tsx:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-read-leases.mjs
//
// Covers (SPEC-0011 §3.1-§3.5 + the M3.1-testable slice of the §7 matrix):
//   §3.1  planFetch registers the read lease in ONE transaction with the
//         catalog read (no register-after-check window — proven by rollback:
//         a failure after the insert leaves NO row), the protected set is the
//         READABLE catalog (active + retired, never reclaimable), loose-only
//         plans take no row.
//   §3.3  renewal extends the confirmed expiry; plan-level renewal re-evaluates
//         EVERY dependency; expired -> rejected (fault A: renewal-late);
//         RECLAIMABLE is irreversible -> per-pack and plan-level renewal for a
//         reclaimable pack rejected (fault C: the system never grants both the
//         renewal and the delete); packs outside the set rejected.
//   §3.4  release drops the row, is idempotent, and a post-release renewal is
//         rejected (no future reads); the GC substrate (hasLiveReadLeaseFor)
//         tracks liveness for the M3.4 RETIRED->RECLAIMABLE gate.
//   §3.2  fault B: DO restart (file-backed SQLite, closed and reopened)
//         preserves unexpired leases — renewal still authorized, GC still
//         blocked; the expiry sweep reclaims dead read leases.
//   §4    DO-arm integration: the lease row exists BEFORE the first emitted
//         byte (lease-before-read), release fires at the last read (drain
//         completes after release, flush tail intact), cancel and mid-stream
//         emission failure release + error (never false success). Fast-path
//         loop: release exactly at the LAST R2 read (a slow client holds the
 //         lease; buffered bytes need no protection), inline renewal past the
//         margin, rejected renewal terminates without the success tail.
//   RPC   the real RepoCell surface (shimmed DO base): planCloneStream miss /
//         leased (+ cache payload), renewAndAuthorizeRead, releaseReadLease.
//   CONTENT the content-path coverage (closes the M3.2 as-built record's known
//         gap — reads OUTSIDE the two upload-pack arms): readBlob acquires +
//         releases the lease around the read (counting stub); a concurrent GC
//         pass at the R2 seam is flip-blocked by the live lease (§6.6) and the
//         drained drain reclaims after release (post-reclaim read refuses
//         whole); fault A/C — a lease aged into the margin + a mid-read
//         reclaim rejects the gate and fails the RPC whole; ls-refs peels and
//         listRefs peels run under one lease; loose-only repos stay guard-free.
const { DatabaseSync } = await import("node:sqlite");
const { register } = await import("node:module");

// repo.ts extends DurableObject at module scope — same inert shim as
// check-cache-unreachable.mjs (no cell is constructed by the import itself).
const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

const { GitStore } = await import("../src/git/store.ts");
const { NodeSql, assert, assertEq } = await import("./helpers/lib.mjs");
const { uploadPack, streamingCloneResponse } = await import("../src/git/protocol.ts");
const { sweepExpiredLeases } = await import("../src/control-plane.ts");
const { planFetch, renewAndAuthorizeRead, releaseReadLease, hasLiveReadLeaseFor, READ_LEASE_TTL_MS } =
  await import("../src/read-leases.ts");
const { serializeTree, serializeCommit } = await import("../src/commit/serialize.ts");
const { hashObject } = await import("../src/git/objects.ts");

const te = new TextEncoder();
const FLUSH_BYTES = "0000";

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

/** A store whose plan/renew transactions are REAL SQLite transactions, counted
 * (RepoCell passes ctx.storage.transactionSync — same shape). */
function makeT() {
  const db = new DatabaseSync(":memory:");
  const sql = new NodeSql(db);
  const t = { db, sql, begins: 0, rollbacks: 0 };
  t.store = new GitStore(sql, {
    tx: (fn) => {
      t.begins++;
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (err) {
        t.rollbacks++;
        db.exec("ROLLBACK");
        throw err;
      }
    },
  });
  return t;
}

const PACK_A = "pack-" + "a".repeat(40); // active
const PACK_B = "pack-" + "b".repeat(40); // retired
const PACK_C = "pack-" + "c".repeat(40); // reclaimable

/** Seed the catalog with one pack per lifecycle state (the RETIRED/
 * RECLAIMABLE writers are M3.3/M3.4 — the states are fabricated exactly the
 * way check-migrations.mjs fabricates legacy databases). */
function seedCatalog(t) {
  for (const key of [PACK_A, PACK_B, PACK_C]) t.store.packs.recordPack(key, 4096, 256);
  t.store.sql.exec("UPDATE pack_catalog SET state = 'retired' WHERE pack_key = ?", PACK_B);
  t.store.sql.exec("UPDATE pack_catalog SET state = 'reclaimable' WHERE pack_key = ?", PACK_C);
}

function readLeaseRows(t) {
  return t.sql.exec(
    "SELECT lease_token, kind, expires_at, payload FROM leases WHERE kind = 'read' ORDER BY lease_token"
  ).toArray();
}

async function drain(res) {
  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// §3.1 planFetch — atomic plan+lease
// ---------------------------------------------------------------------------

await check("§3.1 planFetch: lease registered in ONE transaction with the catalog read", async () => {
  const t = makeT();
  seedCatalog(t);
  const beginsBefore = t.begins;
  const plan = planFetch(t.store, { generation: "gen-1" });
  assertEq(plan.tag, "leased", "plan leased");
  assert(plan.planId.length >= 16, "plan id minted");
  assertEq(plan.packKeys, [PACK_A, PACK_B], "protected set = readable catalog (active + retired, sorted)");
  assertEq(t.begins - beginsBefore, 1, "exactly one transaction wrapped the catalog read + insert");
  const rows = readLeaseRows(t);
  assertEq(rows.length, 1, "one read-lease row");
  assertEq(rows[0].kind, "read", "kind = read");
  const payload = JSON.parse(rows[0].payload);
  assertEq(payload.v, 1, "payload v1");
  assertEq(payload.packKeys, [PACK_A, PACK_B], "payload carries the protected pack key set");
  assertEq(payload.generation, "gen-1", "payload carries the plan generation id");
  assert(payload.cache === undefined, "catalog plans are not cache leases");
  assert(Math.abs(rows[0].expires_at - (Date.now() + READ_LEASE_TTL_MS)) < 5000, "expiry = now + TTL");
});

await check("§3.1 atomicity is real: a failure AFTER the insert rolls the plan back", async () => {
  const t = makeT();
  seedCatalog(t);
  const orig = t.store.createLease.bind(t.store);
  let calls = 0;
  t.store.createLease = (...args) => {
    calls++;
    orig(...args); // land the insert, THEN blow up inside the same transaction
    throw new Error("isolate death mid-plan");
  };
  let threw = false;
  try {
    planFetch(t.store, { generation: "gen-1" });
  } catch {
    threw = true;
  }
  assert(threw, "planFetch propagated the failure");
  assertEq(calls, 1, "the insert was attempted");
  assertEq(t.rollbacks, 1, "the transaction rolled back");
  assertEq(readLeaseRows(t).length, 0, "NO lease row survived — no register-without-check window");
});

await check("§3.1 loose-only plan: nothing to protect — no row, guard-free plan id", async () => {
  const t = makeT(); // empty catalog
  const plan = planFetch(t.store, { generation: "gen-0" });
  assertEq(plan.tag, "leased", "still leased");
  assertEq(plan.planId, "", "empty plan id = no lease guard");
  assertEq(plan.packKeys, [], "no protected packs");
  assertEq(readLeaseRows(t).length, 0, "no row written");
});

// ---------------------------------------------------------------------------
// §3.3 renewal — inline, extend, reject postures
// ---------------------------------------------------------------------------

await check("§3.3 renewal extends the confirmed expiry (and only the expiry)", async () => {
  const t = makeT();
  seedCatalog(t);
  const plan = planFetch(t.store, { generation: "g", ttlMs: 1000 });
  const before = readLeaseRows(t)[0].expires_at;
  await new Promise((r) => setTimeout(r, 15));
  const r = renewAndAuthorizeRead(t.store, plan.planId, null);
  assertEq(r.tag, "authorized", "authorized");
  assert(r.expiresAt > before, `expiry extended: ${r.expiresAt} > ${before}`);
  const after = readLeaseRows(t)[0];
  assertEq(after.expires_at, r.expiresAt, "the row carries the confirmed expiry");
  assertEq(JSON.parse(after.payload).packKeys, plan.packKeys, "payload unchanged");
});

await check("§3.3 plan-level renewal re-evaluates EVERY dependency (fault C: reclaim kills the plan)", async () => {
  const t = makeT();
  seedCatalog(t);
  const plan = planFetch(t.store, { generation: "g" });
  t.store.sql.exec("UPDATE pack_catalog SET state = 'reclaimable' WHERE pack_key = ?", PACK_B);
  const r = renewAndAuthorizeRead(t.store, plan.planId, null);
  assertEq(r.tag, "rejected", "rejected");
  assert(/no longer readable/.test(r.reason), `reason names the dependency: ${r.reason}`);
});

await check("§3.3 per-pack renewal: foreign pack rejected; reclaimable pack rejected (irreversible); active pack authorized", async () => {
  const t = makeT();
  seedCatalog(t);
  const plan = planFetch(t.store, { generation: "g" });
  t.store.sql.exec("UPDATE pack_catalog SET state = 'reclaimable' WHERE pack_key = ?", PACK_B);
  const foreign = renewAndAuthorizeRead(t.store, plan.planId, "pack-" + "f".repeat(40));
  assertEq(foreign.tag, "rejected", "foreign pack rejected");
  assert(/not protected/.test(foreign.reason), `reason: ${foreign.reason}`);
  const reclaimable = renewAndAuthorizeRead(t.store, plan.planId, PACK_B);
  assertEq(reclaimable.tag, "rejected", "reclaimable pack renewal rejected — never granted after the flip");
  assert(/no longer readable/.test(reclaimable.reason), `reason: ${reclaimable.reason}`);
  const active = renewAndAuthorizeRead(t.store, plan.planId, PACK_A);
  assertEq(active.tag, "authorized", "still-readable pack authorized");
});

await check("§3.3 expired lease -> rejected (fault A: renewal-late, GC pre-empted)", async () => {
  const t = makeT();
  seedCatalog(t);
  const plan = planFetch(t.store, { generation: "g", ttlMs: 30 });
  await new Promise((r) => setTimeout(r, 40)); // DO processing delayed past expiry
  const r = renewAndAuthorizeRead(t.store, plan.planId, null);
  assertEq(r.tag, "rejected", "rejected");
  assert(/expired/.test(r.reason), `reason: ${r.reason}`);
});

await check("§3.3 cache leases (§4.2): membership checked, catalog gate skipped", async () => {
  const t = makeT();
  const key = "repos/r0/clone-cache/deadbeef.pack"; // NOT a catalog row
  const plan = planFetch(t.store, { generation: "v1", packKeys: [key], cache: true });
  const ok = renewAndAuthorizeRead(t.store, plan.planId, key);
  assertEq(ok.tag, "authorized", "cache pack authorized without a catalog row");
  const foreign = renewAndAuthorizeRead(t.store, plan.planId, "repos/r0/clone-cache/other.pack");
  assertEq(foreign.tag, "rejected", "a different cache key is not protected");
  const payload = JSON.parse(readLeaseRows(t)[0].payload);
  assertEq(payload.cache, true, "payload marks the cache posture");
});

// ---------------------------------------------------------------------------
// §3.4 release — last read, not the HTTP lifetime; GC substrate
// ---------------------------------------------------------------------------

await check("§3.4 release drops the row; a post-release renewal is REJECTED (no future reads)", async () => {
  const t = makeT();
  seedCatalog(t);
  const plan = planFetch(t.store, { generation: "g" });
  assertEq(releaseReadLease(t.store, plan.planId).tag, "released", "released");
  assertEq(readLeaseRows(t).length, 0, "row gone");
  const r = renewAndAuthorizeRead(t.store, plan.planId, PACK_A);
  assertEq(r.tag, "rejected", "post-release read refused — release means no future reads");
});

await check("§3.4 release is idempotent (terminate/cancel/sweep races are benign)", async () => {
  const t = makeT();
  seedCatalog(t);
  const plan = planFetch(t.store, { generation: "g" });
  assertEq(releaseReadLease(t.store, plan.planId).tag, "released", "first release");
  assertEq(releaseReadLease(t.store, plan.planId).tag, "released", "second release");
  assertEq(releaseReadLease(t.store, "nonexistent").tag, "released", "unknown plan");
});

await check("§6.6 GC substrate: hasLiveReadLeaseFor tracks live protection (M3.4 consumes this)", async () => {
  const t = makeT();
  seedCatalog(t);
  const plan = planFetch(t.store, { generation: "g" });
  assert(hasLiveReadLeaseFor(t.store, [PACK_B], Date.now()), "live lease blocks its packs");
  assert(!hasLiveReadLeaseFor(t.store, [PACK_C], Date.now()), "non-protected pack unblocked");
  releaseReadLease(t.store, plan.planId);
  assert(!hasLiveReadLeaseFor(t.store, [PACK_B], Date.now()), "released -> nothing blocked");
  const plan2 = planFetch(t.store, { generation: "g", ttlMs: 20 });
  await new Promise((r) => setTimeout(r, 30));
  assert(!hasLiveReadLeaseFor(t.store, [PACK_A], Date.now()), "EXPIRED lease protects nothing (GC may proceed)");
  void plan2;
});

// ---------------------------------------------------------------------------
// §3.2 durability — DO restart (fault B) + the expiry sweep
// ---------------------------------------------------------------------------

await check("§3.2 fault B: DO restart preserves unexpired leases (renewal + GC block survive)", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "read-lease-restart-"));
  const file = join(dir, "repo.sqlite");
  try {
    const db1 = new DatabaseSync(file);
    const sql1 = new NodeSql(db1);
    const store1 = new GitStore(sql1);
    for (const key of [PACK_A]) store1.packs.recordPack(key, 4096, 256);
    const plan = planFetch(store1, { generation: "g" });
    const before = readLeaseRows({ sql: sql1 });
    db1.close(); // the isolate died
    const db2 = new DatabaseSync(file);
    const sql2 = new NodeSql(db2);
    const store2 = new GitStore(sql2); // the DO restarts: journal is current, no-op open
    assertEq(store2.schemaState.applied, [], "restart open applies no migrations");
    const after = readLeaseRows({ sql: sql2 });
    assertEq(after, before, "the lease row survived byte-identical");
    assert(hasLiveReadLeaseFor(store2, [PACK_A], Date.now()), "unexpired lease still blocks deletion");
    const r = renewAndAuthorizeRead(store2, plan.planId, null);
    assertEq(r.tag, "authorized", "renewal still authorized after the restart");
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check("§3.2 the expiry sweep reclaims dead read leases (live receive rows untouched)", async () => {
  const t = makeT();
  seedCatalog(t);
  const plan = planFetch(t.store, { generation: "g", ttlMs: 20 });
  t.store.createLease("rx-live", "receive", Date.now() + 60_000, "{}");
  await new Promise((r) => setTimeout(r, 30));
  const host = {
    store: t.store,
    storage: { transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() },
    deletePackObjects: async () => {},
  };
  await sweepExpiredLeases(host);
  assertEq(readLeaseRows(t).length, 0, "expired read lease swept");
  assert(t.store.getLease("rx-live") !== null, "live receive lease untouched");
  void plan;
});

// ---------------------------------------------------------------------------
// §4 DO-arm integration — real uploadPack over the store
// ---------------------------------------------------------------------------

/** A real fixture repo: commit -> tree -> n blobs, all LOOSE (emission reads
 * SQLite), plus one catalog pack so the plan's protected set is non-empty.
 * n=70 pushes emission past one 64-object pull so mid-stream states exist. */
function seedCloneRepo(t, n = 70) {
  const entries = [];
  for (let i = 0; i < n; i++) {
    // INCOMPRESSIBLE content: a compressible pack collapses into one 32KB
    // sideband frame and the stream would finish in a single pull — the
    // mid-stream states below need emission to span several pulls
    const data = new Uint8Array(2048);
    crypto.getRandomValues(data);
    data[0] = i & 0xff;
    const oid = hashObject("blob", data);
    t.store.put(oid, "blob", data);
    entries.push({ mode: "100644", oid, name: `f${String(i).padStart(4, "0")}.txt` });
  }
  const tree = serializeTree(entries);
  t.store.put(tree.oid, "tree", tree.data);
  const person = { name: "t", email: "t@t", time: 1700000000000 };
  const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "read-leases fixture" });
  t.store.put(commit.oid, "commit", commit.data);
  t.store.setRef("refs/heads/main", commit.oid);
  t.store.setHead("refs/heads/main");
  t.store.packs.recordPack(PACK_A, 4096, 256);
  return commit;
}

function uploadPackRequest(commitOid) {
  const pkt = (s) => Buffer.from((s.length + 4).toString(16).padStart(4, "0") + s);
  return Buffer.concat([pkt(`want ${commitOid} side-band-64k\n`), Buffer.from(FLUSH_BYTES), pkt("done\n")]);
}

await check("§4 DO arm: the lease row exists BEFORE the first emitted byte (lease-before-read)", async () => {
  const t = makeT();
  const commit = seedCloneRepo(t);
  const res = await uploadPack(t.store, uploadPackRequest(commit.oid));
  assertEq(res.status, 200, "serve ok");
  assertEq(readLeaseRows(t).length, 1, "plan+lease registered before any read");
  const payload = JSON.parse(readLeaseRows(t)[0].payload);
  assertEq(payload.packKeys, [PACK_A], "the plan's dependency set is protected");
  const rows = await drain(res); // consume: emission + release happen mid-drain
  const text = new TextDecoder().decode(rows);
  assert(text.endsWith(FLUSH_BYTES), "structural success tail (flush) intact");
  assertEq(readLeaseRows(t).length, 0, "released once the last R2 read completed");
});

await check("§4 DO arm: mid-stream cancellation releases the lease", async () => {
  const t = makeT();
  const commit = seedCloneRepo(t);
  const res = await uploadPack(t.store, uploadPackRequest(commit.oid));
  const reader = res.body.getReader();
  // drain the preamble chunks until emission's first pull has run (a big
  // sideband frame = objects emitted; the lease must still be LIVE here —
  // assert it, so the cancel below is not vacuous). The fixture's 70
  // incompressible blobs span several 32KB frames across two pulls, so the
  // queue is non-empty and the finishing pull cannot have run yet.
  for (;;) {
    const { done, value } = await reader.read();
    assert(!done, "stream not finished mid-lease");
    if (value.length >= 1024) break; // an emission frame, not the small preamble frames
  }
  await new Promise((r) => setTimeout(r, 20));
  assertEq(readLeaseRows(t).length, 1, "lease live mid-stream (first pull emitted, not finished)");
  await reader.cancel().catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  assertEq(readLeaseRows(t).length, 0, "cancel released the lease (no future reads)");
});

await check("§4 DO arm: emission failure releases + errors the stream (Property A, never false success)", async () => {
  const t = makeT();
  // a packed object whose pack has NO R2 backend bound: the entry resolves in
  // the index but the bytes are unreadable — emission must die loudly
  const data = te.encode("packed-but-unreadable");
  const oid = hashObject("blob", data);
  t.store.packs.putRows(PACK_A, [
    { oid, offset: 0, dataOff: 12, dataLen: data.length + 12, type: "blob", size: data.length, entrySize: data.length + 12, baseOid: null, crc32: 0 },
  ]);
  t.store.packs.recordPack(PACK_A, 4096, 256);
  t.store.setRef("refs/heads/main", oid);
  t.store.setHead("refs/heads/main");
  const res = await uploadPack(t.store, uploadPackRequest(oid));
  let errored = false;
  try {
    await drain(res);
  } catch {
    errored = true;
  }
  assert(errored, "the stream errored — no successful fetch over an unreadable dependency");
  assertEq(readLeaseRows(t).length, 0, "the error path released the lease");
});

// ---------------------------------------------------------------------------
// §4.2 fast-path re-framing loop — real streamingCloneResponse over a MANUAL
// R2-body source (the loop's pull pace is fully under the test's control, so
// every mid-state below is deterministic, not timing-dependent).
// ---------------------------------------------------------------------------

/** A controllable R2 body: the test enqueues chunks / closes it explicitly. */
function manualBody() {
  const controllerHolder = {};
  const body = new ReadableStream({
    start(c) {
      controllerHolder.c = c;
    },
  });
  return { body, controller: controllerHolder.c };
}

const DEC = new TextDecoder();

await check("§4.2/§3.4 fast path: release exactly at the LAST R2 read — a slow client holds the lease", async () => {
  const released = [];
  const { body, controller } = manualBody();
  const res = streamingCloneResponse(body, 2, true, false, {
    planId: "fast-1",
    expiresAt: Date.now() + 60_000,
    renew: async () => ({ tag: "authorized", expiresAt: Date.now() + 60_000 }),
    release: async () => {
      released.push(Date.now());
      return { tag: "released" };
    },
  });
  const reader = res.body.getReader();
  const first = await reader.read(); // pull 1 frames the NAK, then PENDS on the R2 body
  assertEq(DEC.decode(first.value), "0008NAK\n", "v0 NAK frame first (pkt-framed)");
  assertEq(released.length, 0, "no release before the reads complete");
  controller.enqueue(te.encode("chunk-one"));
  const second = await reader.read(); // the first R2 chunk, sideband-framed
  assert(second.value.length > 4 && DEC.decode(second.value) !== FLUSH_BYTES, "data chunk delivered");
  await new Promise((r) => setTimeout(r, 50)); // slow client: HTTP response still open
  assertEq(released.length, 0, "NOT released at the HTTP pace — the last R2 read has not happened");
  controller.enqueue(te.encode("chunk-two"));
  const third = await reader.read(); // second R2 chunk
  assert(DEC.decode(third.value) !== FLUSH_BYTES, "second data chunk delivered");
  assertEq(released.length, 0, "still protected: one more read may come");
  controller.close(); // the R2 body ends — the NEXT read is the last R2 read
  const last = await reader.read(); // pull: reads (done) -> release -> flush
  assertEq(DEC.decode(last.value), FLUSH_BYTES, "the success tail (flush) is the final chunk");
  assertEq(released.length, 1, "released exactly once, AT the last R2 read");
});

await check("§4.2/§3.3 fast path: inline renewal past the margin, BEFORE the segment", async () => {
  const order = [];
  const { body, controller } = manualBody();
  const res = streamingCloneResponse(body, 1, true, false, {
    planId: "fast-2",
    expiresAt: Date.now() + 10, // inside the renew margin already
    renew: async () => {
      order.push("renew");
      return { tag: "authorized", expiresAt: Date.now() + 60_000 };
    },
    release: async () => {
      order.push("release");
      return { tag: "released" };
    },
  });
  const reader = res.body.getReader();
  const first = await reader.read();
  assertEq(order, ["renew"], "renewed before the first segment was pulled");
  controller.enqueue(te.encode("payload"));
  const second = await reader.read();
  assert(DEC.decode(second.value).endsWith("payload"), "data framed after the renewal");
  controller.close();
  const last = await reader.read();
  assertEq(DEC.decode(last.value), FLUSH_BYTES, "flush tail intact");
  assertEq(order, ["renew", "release"], "release after the last read; no further renewal");
  void first;
});

await check("§3.3 fast path fault A/C: a REJECTED renewal terminates the stream — never a false success", async () => {
  const order = [];
  const { body } = manualBody();
  const res = streamingCloneResponse(body, 1, true, false, {
    planId: "fast-3",
    expiresAt: Date.now() + 10, // inside the margin: the loop must renew before pulling
    renew: async () => {
      order.push("renew-rejected");
      return { tag: "rejected", reason: "lease expired (GC pre-empted)" };
    },
    release: async () => {
      order.push("release");
      return { tag: "released" };
    },
  });
  const reader = res.body.getReader();
  let errored = false;
  let sawFlush = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (DEC.decode(value) === FLUSH_BYTES) sawFlush = true;
    }
  } catch {
    errored = true;
  }
  assert(errored, "the stream errored — the response can never complete after a rejected renewal");
  assert(!sawFlush, "no success tail was ever emitted");
  assertEq(order, ["renew-rejected", "release"], "renewal attempted inline; the abandoned lease was released");
});

// ---------------------------------------------------------------------------
// The real RepoCell RPC surface (shimmed DO base, fake ctx/env)
// ---------------------------------------------------------------------------

await check("RepoCell RPCs: planCloneStream miss/leased, renewAndAuthorizeRead, releaseReadLease", async () => {
  const { RepoCell } = await import("../src/repo.ts");
  const t = makeT();
  const person = { name: "t", email: "t@t", time: 1700000000000 };
  const blob = te.encode("clone-cache fixture blob");
  const blobOid = hashObject("blob", blob);
  t.store.put(blobOid, "blob", blob);
  const tree = serializeTree([{ mode: "100644", oid: blobOid, name: "f.txt" }]);
  t.store.put(tree.oid, "tree", tree.data);
  const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "fast path fixture" });
  t.store.put(commit.oid, "commit", commit.data);
  t.store.setRef("refs/heads/main", commit.oid);
  t.store.setHead("refs/heads/main");

  const cell = new RepoCell(
    { storage: { sql: t.sql, transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } },
    {}
  );
  // the shimmed base class does not wire env/ctx — the production runtime does
  cell.env = { REPO_PACKS: undefined };
  cell.ctx = { storage: { transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } };

  const miss = await cell.planCloneStream("r0", [blobOid]); // a want that is not ALL tips
  assertEq(miss.tag, "miss", "non-exact-clone shape misses");
  assertEq(readLeaseRows(t).length, 0, "no lease for a miss");

  const plan = await cell.planCloneStream("r0", [commit.oid]); // exact full clone
  assertEq(plan.tag, "leased", "exact full clone leases");
  assert(/\/clone-cache\//.test(plan.key), `versioned cache key: ${plan.key}`);
  assert(plan.planId.length >= 16, "plan id minted");
  const payload = JSON.parse(readLeaseRows(t)[0].payload);
  assertEq(payload.packKeys, [plan.key], "the cache key is the protected set");
  assertEq(payload.cache, true, "cache posture recorded (§4.2: no catalog row to gate)");

  const renew = await cell.renewAndAuthorizeRead(plan.planId, plan.key, null);
  assertEq(renew.tag, "authorized", "RPC renewal authorized");
  const after = JSON.parse(readLeaseRows(t)[0].payload);
  assertEq(after.packKeys, payload.packKeys, "payload preserved across renewal");

  assertEq((await cell.releaseReadLease(plan.planId)).tag, "released", "RPC release");
  assertEq(readLeaseRows(t).length, 0, "row gone after the RPC release");
});

// ---------------------------------------------------------------------------
// Content-path coverage (SPEC-0011 §3 outside the two upload-pack arms —
// closes the gap the M3.2 as-built record named: "content-path reads outside
// upload-pack (UI blobs, ls-refs peels) remain lease-free"). The typed content
// RPCs (readBlob et al) and the ls-refs arm run under `withContentLease` /
// the ls-refs lease: planFetch over the readable catalog + the M3.2 per-read
// gate, released at completion.
// ---------------------------------------------------------------------------

const PACK_S = "pack-" + "s".repeat(40); // the active successor (the premise terminus)
const { deflateSync } = await import("node:zlib");
const { serializeTag, emptyTree } = await import("../src/commit/serialize.ts");

/**
 * A fixture repo whose BLOB is genuinely R2-backed: the index row names PACK_A
 * and the (still-compressed) region bytes exist only in the stub bucket —
 * a content read of it must cross the gated R2 seam. Commit/tree stay loose
 * (SQLite reads — no gate). PACK_A is RETIRED with an ACTIVE successor PACK_S
 * (a fabricated compaction publish), so the GC flip's successor premise
 * VERIFIES and the flip decision actually reaches the lease gate.
 */
function seedContentRepo(t) {
  const body = Buffer.from(`content-path fixture payload ${"x".repeat(512)}`);
  const region = deflateSync(body);
  const oid = hashObject("blob", new Uint8Array(body));
  t.store.packs.putRows(PACK_A, [
    { oid, offset: 0, dataOff: 0, dataLen: region.length, type: "blob", size: body.length, entrySize: region.length, baseOid: null, crc32: 0 },
  ]);
  t.store.packs.recordPack(PACK_A, region.length, 256);
  const tree = serializeTree([{ mode: "100644", oid, name: "f.txt" }]);
  t.store.put(tree.oid, "tree", tree.data);
  const person = { name: "t", email: "t@t", time: 1700000000000, tz: "+0000" };
  const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "content fixture" });
  t.store.put(commit.oid, "commit", commit.data);
  t.store.setRef("refs/heads/main", commit.oid);
  t.store.setHead("refs/heads/main");
  t.store.packs.recordPack(PACK_S, 4096, 256);
  t.store.sql.exec("UPDATE pack_catalog SET state = 'retired', superseded_by = ? WHERE pack_key = ?", PACK_S, PACK_A);
  return { oid, body, region, commit };
}

/** An R2 bucket stub serving the packed region; `onGet` runs at the seam
 * (after the gate, "during" the R2 read) — the concurrent-GC hook. */
function stubBucket(region, onGet) {
  const deleted = [];
  return {
    deleted,
    get: async () => {
      if (onGet) await onGet();
      return { arrayBuffer: async () => region.buffer.slice(region.byteOffset, region.byteOffset + region.length) };
    },
    delete: async (keys) => {
      deleted.push(...keys);
    },
    list: async () => ({ objects: [], truncated: false }),
  };
}

/** A RepoCell over the store with the stub bucket bound (rpcBind's name
 * source is meta.repo — set here the way the first fetch() would). */
function contentCell(t, bucket) {
  const { RepoCell } = RepoCellModule;
  const cell = new RepoCell(
    { storage: { sql: t.sql, transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } },
    {}
  );
  cell.env = { REPO_PACKS: bucket };
  cell.ctx = { storage: { transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } };
  t.store.setMeta("repo", "r0");
  return cell;
}

// lazy: repo.ts (and its DurableObject base) is imported once, below
let RepoCellModule;

await check("content path: readBlob acquires + releases the read lease around the read (counting stub)", async () => {
  RepoCellModule = await import("../src/repo.ts");
  const t = makeT();
  const fx = seedContentRepo(t);
  const cell = contentCell(t, stubBucket(fx.region));
  const events = [];
  const origCreate = cell.store.createLease.bind(cell.store);
  const origDelete = cell.store.deleteLease.bind(cell.store);
  cell.store.createLease = (tok, kind, exp, payload) => {
    events.push(`create:${kind}`);
    origCreate(tok, kind, exp, payload);
  };
  cell.store.deleteLease = (tok) => {
    events.push("delete");
    origDelete(tok);
  };
  const blob = await cell.readBlob("main", "f.txt");
  assert(blob !== null, "blob served");
  assertEq(Buffer.from(blob.data).toString(), fx.body.toString(), "blob bytes intact through the gated seam");
  assertEq(events, ["create:read", "delete"], "exactly one read lease: acquired before, released at completion");
  assertEq(readLeaseRows(t).length, 0, "nothing left at the end — GC is decoupled from the response lifetime");
});

await check("content path vs concurrent GC: a RETIRED pack being read is flip-blocked — the read succeeds whole", async () => {
  const t = makeT();
  const fx = seedContentRepo(t);
  let midReadGc = null;
  const bucket = stubBucket(fx.region, async () => {
    // the concurrent GC pass lands AT the R2 seam, mid-read: the content
    // lease is live, so the RETIRED→RECLAIMABLE flip must be blocked
    midReadGc = await cell.gcNow();
  });
  const cell = contentCell(t, bucket);
  const blob = await cell.readBlob("main", "f.txt");
  assert(blob !== null, "the read completed despite the concurrent GC pass");
  assertEq(Buffer.from(blob.data).toString(), fx.body.toString(), "bytes intact — never a torn read");
  assert(midReadGc !== null, "the GC pass ran mid-read");
  assertEq(midReadGc.tag, "collected", "the pass ran");
  assertEq(midReadGc.flippedToReclaimable, [], "§6.6 GC isolation: the live lease blocked the flip");
  assert(midReadGc.blockedByLeases.includes(PACK_A), `the pack is lease-blocked: ${JSON.stringify(midReadGc.blockedByLeases)}`);
  assertEq(t.store.packs.catalogStateOf(PACK_A), "retired", "still retired (still in the readable set)");
  assertEq(readLeaseRows(t).length, 0, "the lease released at completion");
  // drain: with no reader left the pass flips, deletes (R2 ack first) and removes
  const drained = await cell.gcNow();
  assertEq(drained.flippedToReclaimable, [PACK_A], "the drain flips the drained pack");
  assertEq(drained.deleted, [PACK_A], "the drain reclaims it (delete ack, then row)");
  // post-reclaim content read: a whole "not found" refusal, never partial bytes.
  // A FRESH cell (a new request): the previous read's in-memory object cache
  // legitimately still holds the content it read under the lease — immutable
  // objects, no staleness — so the storage-level refusal is asserted cold.
  const fresh = contentCell(t, stubBucket(new Uint8Array(0)));
  const after = await fresh.readBlob("main", "f.txt");
  assertEq(after, null, "post-reclaim read refuses whole (the object is genuinely gone)");
});

await check("content path fault A/C: lease past its renew margin + mid-renewal reclaim → the gate REJECTS, the RPC fails whole", async () => {
  const t = makeT();
  const fx = seedContentRepo(t);
  const cell = contentCell(t, stubBucket(fx.region));
  // Fault A's shape is a delayed DO: after the lease row lands, the clock
  // jumps 40 s — the in-memory confirmed expiry (now+60s at registration)
  // crosses the 30 s renew margin, so the first gated read must renew INLINE
  // before it starts. (The skew activates AFTER registration, so the confirmed
  // expiry stays a real now+60s: exactly the stall the fault describes.)
  const realNow = Date.now;
  let skewInstalled = false;
  const origCreate = cell.store.createLease.bind(cell.store);
  cell.store.createLease = (tok, kind, exp, payload) => {
    origCreate(tok, kind, exp, payload);
    if (!skewInstalled) {
      skewInstalled = true;
      Date.now = () => realNow() + 40_000;
    }
  };
  // the renewal's lease lookup flips the pack first: fault C's never-grant-both
  let flipped = false;
  const origGetLease = cell.store.getLease.bind(cell.store);
  cell.store.getLease = (tok) => {
    if (!flipped) {
      flipped = true;
      t.store.sql.exec("UPDATE pack_catalog SET state = 'reclaimable' WHERE pack_key = ?", PACK_A);
    }
    return origGetLease(tok);
  };
  let threw = "";
  try {
    await cell.readBlob("main", "f.txt");
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  } finally {
    Date.now = realNow;
  }
  assert(skewInstalled, "the lease row was registered (the skew window opened)");
  assert(/read lease rejected/.test(threw), `the gate's rejection failed the request whole: ${threw}`);
  assert(/no longer readable/.test(threw), `RECLAIMABLE is irreversible — renewal refused: ${threw}`);
  assertEq(readLeaseRows(t).length, 0, "the abandoned lease was released (the wrapper's finally)");
});

await check("content path: ls-refs peels and listRefs peels run under the lease (the M3.2 record's ls-refs-peels gap)", async () => {
  const t = makeT();
  // annotated-tag fixture: commit + tag loose, catalog non-empty (a real plan)
  const person = { name: "t", email: "t@t", time: 1700000000000, tz: "+0000" };
  const tree = emptyTree();
  t.store.put(tree.oid, "tree", tree.data);
  const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "tag fixture" });
  t.store.put(commit.oid, "commit", commit.data);
  const tag = serializeTag({ object: commit.oid, type: "commit", tag: "v1", tagger: person, message: "one" });
  t.store.put(tag.oid, "tag", tag.data);
  t.store.setRef("refs/heads/main", commit.oid);
  t.store.setRef("refs/tags/v1", tag.oid);
  t.store.setHead("refs/heads/main");
  t.store.packs.recordPack(PACK_A, 4096, 256);

  // the ls-refs arm: one lease around the whole response, peel served
  const pkt = (s) => Buffer.from((s.length + 4).toString(16).padStart(4, "0") + s);
  const req = Buffer.concat([pkt("command=ls-refs"), Buffer.from("0001"), pkt("peel"), pkt("symrefs"), Buffer.from(FLUSH_BYTES)]);
  const events = [];
  const origCreate = t.store.createLease.bind(t.store);
  const origDelete = t.store.deleteLease.bind(t.store);
  t.store.createLease = (tok, kind, exp, payload) => {
    events.push(`create:${kind}`);
    origCreate(tok, kind, exp, payload);
  };
  t.store.deleteLease = (tok) => {
    events.push("delete");
    origDelete(tok);
  };
  const res = await uploadPack(t.store, req);
  const text = new TextDecoder().decode(await drain(res));
  assert(text.includes(` peeled:${commit.oid}`), `the peel line is served: ${text.split("\n").find((l) => l.includes("refs/tags/"))}`);
  assertEq(events, ["create:read", "delete"], "ls-refs took and released exactly one read lease");

  // the typed RPC arm (listRefs — the worker serveHead/mirror/imports peel path)
  events.length = 0;
  const cell = contentCell(t, stubBucket(new Uint8Array(0)));
  const cellOrigCreate = cell.store.createLease.bind(cell.store);
  const cellOrigDelete = cell.store.deleteLease.bind(cell.store);
  cell.store.createLease = (tok, kind, exp, payload) => {
    events.push(`create:${kind}`);
    cellOrigCreate(tok, kind, exp, payload);
  };
  cell.store.deleteLease = (tok) => {
    events.push("delete");
    cellOrigDelete(tok);
  };
  const refs = await cell.listRefs();
  const tagEntry = refs.refs.find((r) => r.name === "refs/tags/v1");
  assert(tagEntry && tagEntry.peeled === commit.oid, "listRefs peels the annotated tag");
  assertEq(events, ["create:read", "delete"], "listRefs took and released exactly one read lease");
});

await check("content path: loose-only repo (empty catalog) takes no lease and no gate — guard-free", async () => {
  const t = makeT(); // no catalog rows: planFetch short-circuits
  const person = { name: "t", email: "t@t", time: 1700000000000, tz: "+0000" };
  const blob = te.encode("loose-only blob");
  const oid = hashObject("blob", blob);
  t.store.put(oid, "blob", blob);
  const tree = serializeTree([{ mode: "100644", oid, name: "f.txt" }]);
  t.store.put(tree.oid, "tree", tree.data);
  const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "loose fixture" });
  t.store.put(commit.oid, "commit", commit.data);
  t.store.setRef("refs/heads/main", commit.oid);
  t.store.setHead("refs/heads/main");
  const cell = contentCell(t, stubBucket(new Uint8Array(0)));
  const events = [];
  const origCreate = cell.store.createLease.bind(cell.store);
  const origDelete = cell.store.deleteLease.bind(cell.store);
  cell.store.createLease = (tok, kind, exp, payload) => {
    events.push(`create:${kind}`);
    origCreate(tok, kind, exp, payload);
  };
  cell.store.deleteLease = (tok) => {
    events.push("delete");
    origDelete(tok);
  };
  const out = await cell.readBlob("main", "f.txt");
  assert(out !== null && Buffer.from(out.data).toString() === "loose-only blob", "served guard-free");
  assertEq(events, [], "nothing R2-backed exists — no lease row, no gate");
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} engine checks passed`);

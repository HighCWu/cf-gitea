// SPEC-0011 §5 M3.3 — pack compaction over a REAL GitStore (node:sqlite, real
// BEGIN/COMMIT transactions — see helpers/lib.mjs) with a range-aware
// in-memory R2 bucket stub, the same harness shape as check-segmented-serve.mjs.
// Run with tsx:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-compaction.mjs
//
// The fixture packs carry REAL entries of every shape the merge must handle:
// verbatim fulls, REF deltas (same-pack and CROSS-pack), an OFS delta, and a
// delta whose base is LOOSE (outside the merged set — the re-inflate-whole
// path). Correctness is judged by an fsck-equivalent walk: every object
// reachable from the refs, resolved through the store, byte-identical before
// and after compaction.
//
// Covers:
//   §5.2  merge correctness (object set identical pre/post; catalog publish
//         rows — successor ACTIVE kind='compact', inputs RETIRED with
//         superseded_by, zero index rows left naming a retired input; delta
//         retention counters), determinism (identical stores → identical
//         successor SHA-1 + bytes), the bounded input window (oldest-N with
//         the newest untouched) and the pack-count trigger (≤ threshold
//         skips; force bypasses only the threshold).
//   §5.3  crash windows: publish-crash orphan (R2 written, catalog
//         unpublished → the expired-lease sweep deletes the orphan by
//         payload + catalog state and the catalog is byte-unchanged) and
//         crash-after-publish (the published successor is KEPT; only the
//         stale lease row dies). The old packs are never deleted (M3.4's).
//   §5.4/§2 RETIRED serves existing readers: a plan taken BEFORE the
//         compaction keeps reading — successor renewals authorized
//         (non-member ACTIVE), member RETIRED renewals authorized, raw
//         retired-pack reads still servable cold, foreign/reclaimed packs
//         rejected — and a full clone over the mixed-generation catalog
//         (retired inputs + successor) completes with its flush tail.
//   §5.1  lease exclusion: a live receive lease blocks compaction; a live
//         compaction lease excludes a second round; expiry frees both. The
//         DO surface: the real RepoCell RPC (compactNow, incl. the
//         no-R2-backend skip) and the ALARM consumer ("crons enqueue,
//         consumers work" — compaction_wanted_at + threshold runs a round,
//         deferred rounds re-arm and keep the stamp).
const { DatabaseSync } = await import("node:sqlite");
const { register } = await import("node:module");

// repo.ts extends DurableObject at module scope — same inert shim as
// check-read-leases.mjs (no cell is constructed by the import itself).
const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

const { GitStore } = await import("../src/git/store.ts");
const { NodeSql, assert, assertEq } = await import("./helpers/lib.mjs");
const { uploadPack, serveReadGate } = await import("../src/git/protocol.ts");
const { sweepExpiredLeases } = await import("../src/control-plane.ts");
const { planFetch, renewAndAuthorizeRead, releaseReadLease } = await import("../src/read-leases.ts");
const {
  runCompaction,
  COMPACTION_ACTIVE_PACK_THRESHOLD,
  COMPACTION_WINDOW_PACKS,
} = await import("../src/compaction.ts");
const { packR2Key, idxR2Key } = await import("../src/git/r2keys.ts");
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
// Harness: real-tx store + fake R2 bucket
// ---------------------------------------------------------------------------

/** A store whose transactions are REAL SQLite transactions (the publish txn's
 * atomicity is exercised honestly). */
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
   * cold caches, so post-compaction byte reads exercise the real R2 seam
   * instead of a warm LRU. */
  t.freshStore = (objects) => {
    const cold = new GitStore(sql, { tx });
    cold.setR2(fakeBucket(objects), STORAGE);
    return cold;
  };
  return t;
}

/** The in-memory bucket: Range GETs for the store's chunk reads, put for the
 * merge output, delete for the orphan sweep. */
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
  };
}

/** The compaction/lease host over a test store + the bucket's object map.
 * The store must ALREADY be bound to a bucket over the same map (reads happen
 * during seeding/pre-walks) — re-binding here is idempotent. */
function hostOf(t, objects) {
  t.store.setR2(fakeBucket(objects), STORAGE);
  const host = {
    store: t.store,
    storage: { transactionSync: t.tx, setAlarm: () => Promise.resolve() },
    putPackObject: async (key, data) => {
      objects.set(key, data);
    },
    deletePackObjects: async (keys) => {
      for (const k of keys) objects.delete(k);
    },
  };
  return host;
}

// ---------------------------------------------------------------------------
// Fixture: real objects, real packfiles (full / REF / OFS / loose-base delta)
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

/** git's ofs-delta negative-offset encoding (decodable by scan.ts's decoder). */
function encodeOfs(delta) {
  let n = delta;
  const bytes = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) {
    n -= 1;
    bytes.unshift(0x80 | (n & 0x7f));
    n = Math.floor(n / 128);
  }
  return new Uint8Array(bytes);
}

/** A minimal valid delta: src-size + tgt-size varints + literal-insert ops.
 * The engine's applyDelta resolves it against the real base bytes. */
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

/**
 * Build a real packfile: entries in order; REF entries may reference an oid
 * from ANOTHER pack (cross-pack delta, exactly what thin-pack receives leave
 * behind) and OFS entries reference an in-pack entry index. Returns the pack
 * bytes and the IndexRows receive's putIndexRows would have landed.
 */
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
      const baseRow = o.kind === "ofs" ? rows[o.baseIndex] : null;
      if (o.kind === "ref") {
        prefix = [encodeEntryHeader(7, delta.length), fromHex(o.baseOid)];
      } else {
        prefix = [encodeEntryHeader(6, delta.length), encodeOfs(start - baseRow.offset)];
      }
      payload = comp;
      rows.push({
        oid: hashObject(o.type, o.target),
        offset: start,
        dataOff: 0,
        dataLen: comp.length,
        type: o.type,
        size: o.target.length,
        entrySize: delta.length,
        baseOid: o.kind === "ref" ? o.baseOid : baseRow.oid, // ofs resolves eagerly, like the scan
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

/** Seed the four-pack fixture repo (plus one loose delta base) and return the
 * key oids. `store` is the GitStore; pack bytes land in `objects` (the
 * bucket's backing map — the store must be bound to a bucket over it). */
function seedRepo(store, objects) {
  const b1 = te.encode("alpha content one\n");
  const b2 = te.encode("beta content two\n");
  const b3 = te.encode("gamma content three\n");
  const b4 = te.encode("delta content four\n");
  const looseBase = te.encode("loose base for pack D's thin delta\n");
  const g1 = te.encode("g-one packed in D\n");
  const g2 = te.encode("g-two resolved through the loose base\n");
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

  // pack A: fulls. pack B: CROSS-pack REF delta over A's tree1 + full + OFS.
  // pack C: commit delta chain. pack D: delta over the LOOSE base.
  const specs = [
    [PACK_A, [{ kind: "full", type: "blob", data: b1 }, { kind: "full", type: "blob", data: b2 }, { kind: "full", type: "tree", data: tree1.data }]],
    [
      PACK_B,
      [
        { kind: "ref", type: "tree", target: tree2.data, baseOid: tree1.oid, baseData: tree1.data },
        { kind: "full", type: "blob", data: b3 },
        { kind: "ofs", type: "blob", target: b4, baseIndex: 1, baseData: b3 },
      ],
    ],
    [
      PACK_C,
      [
        { kind: "full", type: "commit", data: commit1.data },
        { kind: "ref", type: "commit", target: commit2.data, baseOid: commit1.oid, baseData: commit1.data },
      ],
    ],
    [
      PACK_D,
      [
        { kind: "full", type: "blob", data: g1 },
        { kind: "ref", type: "blob", target: g2, baseOid: hashObject("blob", looseBase), baseData: looseBase },
      ],
    ],
  ];
  const oids = { tree1: tree1.oid, tree2: tree2.oid, commit1: commit1.oid, commit2: commit2.oid, looseBase: hashObject("blob", looseBase) };
  for (const [packKey, entries] of specs) {
    const { bytes, rows } = buildPack(entries);
    objects.set(packR2Key(STORAGE, packKey), bytes);
    store.packs.putRows(packKey, rows);
    store.packs.recordPack(packKey, bytes.length, 256);
  }
  // the loose base lives OUTSIDE every pack (thin-pack leftover shape)
  store.put(oids.looseBase, "blob", looseBase);
  store.setRef("refs/heads/main", commit2.oid);
  store.setRef("refs/heads/feature", commit1.oid);
  store.setHead("refs/heads/main");
  store.setMeta("repo", STORAGE);
  store.setMeta("storage_key", STORAGE);
  return oids;
}

/** fsck-equivalent walk: every object reachable from the refs, resolved
 * THROUGH the store (pack index → bytes), as "type:hex" — the pre/post
 * comparison that judges merge correctness. */
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

function catalogRows(t) {
  return t.sql
    .exec("SELECT pack_key, kind, state, location, object_count, superseded_by FROM pack_catalog ORDER BY seq")
    .toArray();
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

function uploadPackRequest(commitOid) {
  const pkt = (s) => Buffer.from((s.length + 4).toString(16).padStart(4, "0") + s);
  return Buffer.concat([pkt(`want ${commitOid} side-band-64k\n`), Buffer.from(FLUSH_BYTES), pkt("done\n")]);
}

// ---------------------------------------------------------------------------
// §5.2 merge correctness + the catalog publish
// ---------------------------------------------------------------------------

await check("§5.2 merge: the successor serves the exact pre-compaction closure; publish rows record the §2 transition", async () => {
  const t = makeT();
  const objects = new Map();
  t.store.setR2(fakeBucket(objects), STORAGE); // bound before any packed read
  seedRepo(t.store, objects);
  const pre = await closureSnapshot(t.store);
  const preCount = t.store.objectCount();
  assertEq(preCatalogStates(t), ["active", "active", "active", "active"], "pre: every pack ACTIVE");

  const host = hostOf(t, objects);
  const result = await runCompaction(host, { force: true });
  assertEq(result.tag, "compacted", `compaction ran: ${JSON.stringify(result)}`);
  assertEq(result.inputs, [PACK_A, PACK_B, PACK_C, PACK_D], "the window covered the four packs, catalog order");
  assertEq(result.objects, 10, "ten packed objects merged (the loose base is not a pack row)");
  assertEq(result.verbatim, 9, "6 fulls + 3 in-set deltas copied verbatim");
  assertEq(result.reInflated, 1, "only the loose-base delta re-inflated whole");
  assert(/^[0-9a-f]{40}$/.test(result.outputPackKey.slice(5)), "successor named by its own SHA-1");

  // fsck-equivalent: the closure is byte-identical across the transition
  const post = await closureSnapshot(t.store);
  assertEq([...pre.keys()].sort(), [...post.keys()].sort(), "the reachable oid set is unchanged");
  for (const [oid, v] of pre) assertEq(post.get(oid), v, `object ${oid} identical pre/post`);
  assertEq(t.store.objectCount(), preCount, "object count unchanged");

  // catalog: successor ACTIVE kind='compact'; inputs RETIRED with superseded_by
  const rows = catalogRows(t);
  assertEq(rows.length, 5, "one successor row appended");
  const succ = rows[rows.length - 1];
  assertEq(succ.pack_key, result.outputPackKey, "successor keyed by the deterministic stem");
  assertEq(succ.kind, "compact", "successor kind='compact'");
  assertEq(succ.state, "active", "successor ACTIVE");
  assertEq(succ.location, "r2", "successor always r2 (§5.2: compaction never emits sqlite)");
  assertEq(succ.object_count, 10, "successor count = merged rows");
  for (const r of rows.slice(0, 4)) {
    assertEq(r.state, "retired", `input ${r.pack_key} RETIRED`);
    assertEq(r.superseded_by, result.outputPackKey, `input ${r.pack_key} superseded by the successor`);
  }

  // index rows: every merged row re-pointed onto the successor; no row names
  // a retired input any more
  assertEq(
    t.sql.exec("SELECT COUNT(*) AS n FROM pack_objects WHERE pack_key = ?", result.outputPackKey).one().n,
    10,
    "all ten rows re-pointed at the successor"
  );
  assertEq(
    t.sql
      .exec(
        `SELECT COUNT(*) AS n FROM pack_objects WHERE pack_key IN (${[PACK_A, PACK_B, PACK_C, PACK_D].map(() => "?").join(",")})`,
        PACK_A,
        PACK_B,
        PACK_C,
        PACK_D
      )
      .one().n,
    0,
    "no row names a retired input"
  );
  // the three in-set deltas keep their base oids; the loose-base delta
  // re-inflated whole and ships as a FULL entry (baseOid null)
  assertEq(
    t.sql
      .exec("SELECT COUNT(*) AS n FROM pack_objects WHERE pack_key = ? AND base_oid IS NOT NULL", result.outputPackKey)
      .one().n,
    3,
    "the three in-set deltas ship as deltas (bases within the successor)"
  );

  // R2 layout unchanged: pack + idx sidecar, pack trailer = its own SHA-1
  const packBytes = objects.get(packR2Key(STORAGE, result.outputPackKey));
  assert(packBytes, "successor pack bytes in R2 at the unchanged packs/ layout");
  assert(objects.get(idxR2Key(STORAGE, result.outputPackKey)), "idx sidecar written");
  assert(result.outputIdxBytes > 0, "idx bytes recorded");
  assertEq(
    Buffer.from(packBytes.slice(-20)).toString("hex"),
    result.outputPackKey.slice(5),
    "the pack's trailer is its own name's SHA-1"
  );
  assertEq(result.outputPackBytes, packBytes.length, "catalog pack_bytes = the stored bytes");

  // and every object resolves THROUGH the store post-compaction (cold caches,
  // real R2 seam)
  const cold = t.freshStore(objects);
  for (const oid of post.keys()) {
    const obj = await cold.get(oid);
    assert(obj, `post-compaction read of ${oid}`);
  }
});

function preCatalogStates(t) {
  return catalogRows(t).map((r) => r.state);
}

await check("§5.2 determinism: identical stores merge to the identical successor (same SHA-1, same bytes)", async () => {
  const run = async () => {
    const t = makeT();
    const objects = new Map();
    t.store.setR2(fakeBucket(objects), STORAGE);
    seedRepo(t.store, objects);
    const host = hostOf(t, objects);
    const result = await runCompaction(host, { force: true });
    assertEq(result.tag, "compacted", "compacted");
    return {
      key: result.outputPackKey,
      pack: Buffer.from(objects.get(packR2Key(STORAGE, result.outputPackKey))).toString("hex"),
      idx: Buffer.from(objects.get(idxR2Key(STORAGE, result.outputPackKey))).toString("hex"),
    };
  };
  const a = await run();
  const b = await run();
  assertEq(a.key, b.key, "the successor's SHA-1 (and its pack-<sha1> name) is reproducible");
  assertEq(a.pack, b.pack, "pack bytes identical");
  assertEq(a.idx, b.idx, "idx bytes identical");
});

// ---------------------------------------------------------------------------
// §5.3 crash windows
// ---------------------------------------------------------------------------

await check("§5.3 crash before publish: the written-but-unpublished output is an ORPHAN the sweep converges; catalog byte-unchanged", async () => {
  const t = makeT();
  const objects = new Map();
  t.store.setR2(fakeBucket(objects), STORAGE); // bound before any packed read
  seedRepo(t.store, objects);
  const preCatalog = JSON.parse(JSON.stringify(catalogRows(t)));
  const preRows = t.sql.exec("SELECT COUNT(*) AS n FROM pack_objects").one().n;
  const host = hostOf(t, objects);

  // the isolate dies inside the publish: transactionSync never returns and
  // NOTHING else runs (deleteLease included — stubbed to a no-op so the
  // crashed state is faithful)
  const realTx = host.storage.transactionSync;
  host.storage.transactionSync = () => {
    throw new Error("simulated isolate death inside the publish txn");
  };
  const realDeleteLease = t.store.deleteLease.bind(t.store);
  t.store.deleteLease = () => {};
  let threw = null;
  try {
    await runCompaction(host, { force: true });
  } catch (err) {
    threw = err;
  }
  t.store.deleteLease = realDeleteLease;
  host.storage.transactionSync = realTx;
  assert(threw, "the crash surfaced as a throw (transport class)");

  // the crashed state: catalog untouched, an unexpired compaction lease with
  // the output named in its payload, orphan bytes in R2
  assertEq(JSON.parse(JSON.stringify(catalogRows(t))), preCatalog, "catalog byte-unchanged by the crashed publish");
  assertEq(t.sql.exec("SELECT COUNT(*) AS n FROM pack_objects").one().n, preRows, "index rows untouched");
  const lease = t.sql.exec("SELECT lease_token, payload, expires_at FROM leases WHERE kind = 'compaction'").toArray()[0];
  assert(lease, "the crashed round's lease row survives (the crashed isolate ran nothing)");
  const payload = JSON.parse(lease.payload);
  assert(payload.outputPackKey && payload.outputPackR2Key && payload.outputIdxR2Key, "the payload names the output keys");
  assert(objects.get(payload.outputPackR2Key), "the orphan pack bytes exist pre-sweep");
  assert(objects.get(payload.outputIdxR2Key), "the orphan idx bytes exist pre-sweep");

  // expiry + sweep: the orphan converges BY payload + catalog state (no row
  // for the output → delete), the catalog stays untouched
  t.sql.exec("UPDATE leases SET expires_at = 1 WHERE kind = 'compaction'");
  await sweepExpiredLeases(host);
  assertEq(objects.get(payload.outputPackR2Key), undefined, "orphan pack bytes swept");
  assertEq(objects.get(payload.outputIdxR2Key), undefined, "orphan idx bytes swept");
  assertEq(JSON.parse(JSON.stringify(catalogRows(t))), preCatalog, "catalog still byte-unchanged after the sweep");
  assertEq(t.sql.exec("SELECT COUNT(*) AS n FROM leases").one().n, 0, "the stale lease row is gone");

  // and the repo is immediately compactable again (converged, not wedged)
  const retry = await runCompaction(host, { force: true });
  assertEq(retry.tag, "compacted", "the next round succeeds after the orphan sweep");
});

await check("§5.3 crash after publish: the published successor is KEPT — only the stale lease row dies; old packs never deleted", async () => {
  const t = makeT();
  const objects = new Map();
  t.store.setR2(fakeBucket(objects), STORAGE); // bound before any packed read
  seedRepo(t.store, objects);
  const host = hostOf(t, objects);
  const result = await runCompaction(host, { force: true });
  assertEq(result.tag, "compacted", "compacted");
  const inputs = result.inputs;
  const inputBytes = inputs.map((k) => [packR2Key(STORAGE, k), Buffer.from(objects.get(packR2Key(STORAGE, k))).toString("hex")]);

  // the crash-after-publish-before-release state: a stale compaction lease
  // naming a LIVE output (reconstructed faithfully — the publish committed,
  // the release never ran)
  t.store.createLease(
    "stale-compaction",
    "compaction",
    Date.now() - 1,
    JSON.stringify({
      v: 1,
      storageKey: STORAGE,
      inputs,
      outputPackKey: result.outputPackKey,
      outputPackR2Key: packR2Key(STORAGE, result.outputPackKey),
      outputIdxR2Key: idxR2Key(STORAGE, result.outputPackKey),
    })
  );
  await sweepExpiredLeases(host);
  assert(objects.get(packR2Key(STORAGE, result.outputPackKey)), "the PUBLISHED successor's bytes survive the sweep");
  assert(objects.get(idxR2Key(STORAGE, result.outputPackKey)), "its idx survives too");
  assertEq(t.sql.exec("SELECT COUNT(*) AS n FROM leases").one().n, 0, "the stale lease row is gone");
  assertEq(
    t.sql.exec("SELECT state FROM pack_catalog WHERE pack_key = ?", result.outputPackKey).toArray()[0]?.state,
    "active",
    "the successor stays ACTIVE"
  );
  // M3.3 never deletes: every input's R2 bytes are exactly where they were
  for (const [key, hex] of inputBytes) {
    assertEq(Buffer.from(objects.get(key)).toString("hex"), hex, `input bytes never deleted: ${key}`);
  }
});

// ---------------------------------------------------------------------------
// §2 / §5.4 RETIRED serves existing readers
// ---------------------------------------------------------------------------

await check("§2/§5.4 a plan taken BEFORE compaction keeps reading — through the successor — and mixed-generation clones complete", async () => {
  const t = makeT();
  const objects = new Map();
  t.store.setR2(fakeBucket(objects), STORAGE); // bound before any packed read
  const oids = seedRepo(t.store, objects);
  const host = hostOf(t, objects);

  // the existing reader: plan+lease BEFORE the compaction (protected set =
  // the readable catalog A–D)
  const plan = planFetch(t.store, { generation: t.store.refsVersion() });
  assertEq(plan.tag, "leased", "pre-compaction plan leased");
  assertEq(plan.packKeys.sort(), [PACK_A, PACK_B, PACK_C, PACK_D], "the plan protects the pre-compaction readable set");

  const retiredRaw = await t.store.packs.readRaw(PACK_D, 0, 64);
  const result = await runCompaction(host, { force: true });
  assertEq(result.tag, "compacted", "compaction ran under the live plan");

  // the successor is ACTIVE and NOT in the plan's payload: authorized anyway
  // (active packs are never reclaimable — the re-point made it the reader's
  // dependency location)
  const succ = await renewAndAuthorizeRead(t.store, plan.planId, result.outputPackKey, { offset: 0, length: 1024 });
  assertEq(succ.tag, "authorized", "the successor pack (non-member, ACTIVE) authorized for the existing reader");
  // member packs that are now RETIRED stay authorized and servable — cold
  // (a fresh store over the same DB: no warm LRU, the real R2 seam)
  const retired = await renewAndAuthorizeRead(t.store, plan.planId, PACK_D, { offset: 0, length: 1024 });
  assertEq(retired.tag, "authorized", "member RETIRED pack authorized (§2: retired serves existing readers)");
  const cold = t.freshStore(objects);
  const raw = await cold.packs.readRaw(PACK_D, 0, retiredRaw.length, serveReadGate(cold, {
    planId: plan.planId,
    expiresAt: retired.expiresAt,
  }));
  assertEq(Buffer.from(raw).toString("hex"), Buffer.from(retiredRaw).toString("hex"), "retired input bytes still servable under the gate");

  // fences hold: a foreign pack and a reclaimed member both reject
  const foreign = await renewAndAuthorizeRead(t.store, plan.planId, "pack-" + "ff".repeat(20), { offset: 0, length: 1 });
  assertEq(foreign.tag, "rejected", "foreign pack rejected");
  assert(/not protected/.test(foreign.reason), `foreign reason: ${foreign.reason}`);
  t.store.sql.exec("UPDATE pack_catalog SET state = 'reclaimable' WHERE pack_key = ?", PACK_B);
  const flipped = await renewAndAuthorizeRead(t.store, plan.planId, PACK_B, { offset: 0, length: 1 });
  assertEq(flipped.tag, "rejected", "a member that left the readable set rejects (RECLAIMABLE is irreversible)");
  t.store.sql.exec("UPDATE pack_catalog SET state = 'retired' WHERE pack_key = ?", PACK_B);

  // a plan-level renewal still passes: every payload dependency (A–D) is
  // retired-but-readable
  const planLevel = await renewAndAuthorizeRead(t.store, plan.planId, null);
  assertEq(planLevel.tag, "authorized", "plan-level renewal: retired inputs remain readable dependencies");

  // and a full clone over the mixed-generation catalog completes with its
  // success tail (a NEW plan spans the retired inputs + the successor)
  const out = await drainCapture(await Promise.resolve(uploadPack(t.store, uploadPackRequest(oids.commit2))));
  assert(out.err === null, `clone completed: ${out.err?.message}`);
  assert(new TextDecoder().decode(out.bytes).endsWith(FLUSH_BYTES), "the clone's flush tail is intact");
  const post = await closureSnapshot(t.store);
  assert(post.get(oids.commit2), "the cloned tip resolves post-compaction");
  releaseReadLease(t.store, plan.planId);
});

// ---------------------------------------------------------------------------
// §5.1 trigger + exclusion + the bounded window
// ---------------------------------------------------------------------------

/** Seed `n` single-blob ACTIVE packs (distinct content within a label),
 * insertion order. `label` keeps packs across calls content-distinct — pack
 * keys are content-derived, so identical bytes would no-op at recordPack. */
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
  store.setMeta("repo", STORAGE);
  store.setMeta("storage_key", STORAGE);
  return keys;
}

await check("§5.1 trigger + window: >threshold compacts the OLDEST bounded window (newest untouched); ≤threshold skips; force bypasses only the threshold", async () => {
  const t = makeT();
  const objects = new Map();
  t.store.setR2(fakeBucket(objects), STORAGE);
  const keys = seedTinyPacks(t.store, objects, COMPACTION_ACTIVE_PACK_THRESHOLD + 2); // 10
  const host = hostOf(t, objects);

  const result = await runCompaction(host); // no force: the trigger is met
  assertEq(result.tag, "compacted", "above the threshold a plain round runs");
  assertEq(result.inputs.length, COMPACTION_WINDOW_PACKS, "the window is bounded at WINDOW_PACKS");
  assertEq(result.inputs, keys.slice(0, COMPACTION_WINDOW_PACKS), "the window takes the OLDEST packs, catalog order");
  const states = Object.fromEntries(catalogRows(t).map((r) => [r.pack_key, r.state]));
  for (const k of result.inputs) assertEq(states[k], "retired", `merged input ${k} retired`);
  for (const k of keys.slice(COMPACTION_WINDOW_PACKS)) {
    assertEq(states[k], "active", `untouched pack ${k} stays ACTIVE`);
  }
  assertEq(t.store.packs.activePackCount(), 3, "10 packs -> window of 8 -> 3 ACTIVE (successor + 2 untouched)");

  // converged below the threshold: a plain round skips, force does not
  const skipped = await runCompaction(host);
  assertEq(skipped.tag, "skipped", "below the threshold a plain round skips");
  assertEq(skipped.reason, "below_threshold", "skip reason names the trigger");
  const forced = await runCompaction(host, { force: true });
  assertEq(forced.tag, "compacted", "force bypasses the threshold only");
  assertEq(forced.inputs.length, 3, "the remaining three packs form the next window");
  assertEq(t.store.packs.activePackCount(), 1, "3 -> 1 ACTIVE (the new successor)");

  // one pack alone merges nothing
  const loner = await runCompaction(host, { force: true });
  assertEq(loner.tag, "skipped", "a single pack is not a window");
  assertEq(loner.reason, "window_too_small", "skip reason names the window bound");
});

await check("§5.1 exclusion: a live receive lease blocks compaction; a live compaction lease excludes a second round; expiry frees both", async () => {
  const t = makeT();
  const objects = new Map();
  t.store.setR2(fakeBucket(objects), STORAGE); // bound before any packed read
  seedRepo(t.store, objects);
  const host = hostOf(t, objects);
  const before = JSON.parse(JSON.stringify(catalogRows(t)));

  t.store.createLease("rx-live", "receive", Date.now() + 60_000, "{}");
  const blocked = await runCompaction(host, { force: true });
  assertEq(blocked.tag, "deferred", "a live receive lease defers compaction (§5.1)");
  assertEq(blocked.reason, "receive_lease_live", "deferral names the receive exclusion");
  assertEq(JSON.parse(JSON.stringify(catalogRows(t))), before, "catalog untouched while deferred");

  t.sql.exec("UPDATE leases SET expires_at = 1 WHERE lease_token = 'rx-live'");
  t.store.createLease("cx-live", "compaction", Date.now() + 60_000, JSON.stringify({ v: 1, storageKey: STORAGE, inputs: [] }));
  const concurrent = await runCompaction(host, { force: true });
  assertEq(concurrent.tag, "deferred", "a live compaction lease excludes a second round");
  assertEq(concurrent.reason, "compaction_in_flight", "deferral names the compaction exclusion");

  t.sql.exec("UPDATE leases SET expires_at = 1 WHERE lease_token = 'cx-live'");
  const freed = await runCompaction(host, { force: true });
  assertEq(freed.tag, "compacted", "expiry frees the round");
});

// ---------------------------------------------------------------------------
// The DO surface: the real RepoCell RPC + the alarm consumer
// ---------------------------------------------------------------------------

await check("RepoCell: compactNow RPC (no-R2 skip, receive exclusion) and the alarm consumer (threshold round, deferred re-arm, stamp consumption)", async () => {
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
  // the shimmed base class does not wire env/ctx — the production runtime does
  cell.env = { REPO_PACKS: bucket };
  cell.ctx = { storage: cellStorage };

  // fixture THROUGH the cell's own store; pack bytes land in the bucket map
  const oids = seedRepo(cell.store, objects);
  void oids;

  // the no-backend posture: an unbound bucket skips with a named reason
  const savedBucket = cell.env.REPO_PACKS;
  cell.env.REPO_PACKS = undefined;
  const noR2 = await cell.compactNow({ force: true });
  assertEq(noR2.tag, "skipped", "no R2 backend: skipped");
  assertEq(noR2.reason, "no_r2_backend", "skip reason names the missing backend");
  cell.env.REPO_PACKS = savedBucket;

  // the cell RPC honors the receive exclusion
  cell.store.createLease("rx-cell", "receive", Date.now() + 60_000, "{}");
  const blocked = await cell.compactNow({ force: true });
  assertEq(blocked.tag, "deferred", "the cell RPC defers to a live receive lease");
  assertEq(blocked.reason, "receive_lease_live", "deferral reason");
  cell.store.sql.exec("UPDATE leases SET expires_at = 1 WHERE lease_token = 'rx-cell'");

  // the manual round lands
  const manual = await cell.compactNow({ force: true });
  assertEq(manual.tag, "compacted", "the manual RPC compacts");
  assertEq(
    cell.store.sql.exec("SELECT state FROM pack_catalog WHERE pack_key = ?", manual.outputPackKey).toArray()[0]?.state,
    "active",
    "successor ACTIVE through the cell path"
  );

  // the alarm consumer, threshold round: stamp + above-threshold catalog ->
  // one bounded round runs; the successor from the manual round is now the
  // oldest ACTIVE pack and joins the window
  seedTinyPacks(cell.store, objects, COMPACTION_ACTIVE_PACK_THRESHOLD + 2); // active: 1 + 10 = 11
  cell.store.setMeta("compaction_wanted_at", String(Date.now()));
  alarms.length = 0;
  await cell.alarm();
  assertEq(cell.store.packs.activePackCount(), 4, "the alarm ran one bounded round (11 -> 4 ACTIVE)");
  assertEq(
    cell.store.getMeta("compaction_wanted_at"),
    "",
    "the stamp is consumed once the catalog converged below the threshold"
  );
  assertEq(alarms.length, 0, "convergence does not re-arm");

  // a deferred alarm round (live receive lease) keeps the stamp and re-arms
  seedTinyPacks(cell.store, objects, 6, "more pack"); // active: 4 + 6 = 10 > threshold
  cell.store.setMeta("compaction_wanted_at", String(Date.now()));
  cell.store.createLease("rx-alarm", "receive", Date.now() + 60_000, "{}");
  alarms.length = 0;
  await cell.alarm();
  assert(cell.store.getMeta("compaction_wanted_at"), "the stamp survives a deferred round");
  assertEq(alarms.length, 1, "the deferred round re-arms the alarm (retry backoff)");
  assert(alarms[0] > Date.now(), "the re-arm is in the future");

  // expiry frees the next alarm round: it compacts and consumes the stamp
  cell.store.sql.exec("UPDATE leases SET expires_at = 1 WHERE lease_token = 'rx-alarm'");
  alarms.length = 0;
  await cell.alarm(); // sweep + threshold round (10 -> 3 ACTIVE)
  assertEq(cell.store.packs.activePackCount(), 3, "the freed alarm round compacts (10 -> 3)");
  assertEq(cell.store.getMeta("compaction_wanted_at"), "", "the stamp is consumed by the compacting round");

  // a below-threshold stamp is consumed without a round or a re-arm
  cell.store.setMeta("compaction_wanted_at", String(Date.now()));
  alarms.length = 0;
  await cell.alarm();
  assertEq(cell.store.getMeta("compaction_wanted_at"), "", "below the threshold the stamp is consumed");
  assertEq(alarms.length, 0, "no re-arm below the threshold");
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} compaction checks passed`);

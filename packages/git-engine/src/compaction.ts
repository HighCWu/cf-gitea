/**
 * Pack compaction (SPEC-0011 §5, milestone M3.3): merge a bounded window of
 * ACTIVE packs into one successor pack, publish it in ONE DO SQLite
 * transaction (new row ACTIVE + superseded inputs → RETIRED), and leave
 * reclamation to GC (M3.4). Concurrent with live fetches and pushes without
 * violating SPEC-0001's copy-before-finalize induction premise:
 *
 * - Nothing is ever DELETED here. The publish only re-points index rows and
 *   flips catalog states, so every object stays readable across the
 *   ACTIVE→RETIRED transition — retired inputs keep their bytes and serve
 *   existing readers (§2) THROUGH the successor's identical content, and a
 *   receive finalize's dependency-premise check (`store.has(tip)` inside its
 *   commit transaction) holds at every instant because the re-point is atomic
 *   (§5.4: the premise is "dependency packs still available", and publish
 *   never makes a dependency unavailable — the window before a receive lease
 *   exists is covered by the same argument).
 * - Crash windows (§5.3): the R2 write strictly precedes the publish txn, so
 *   "written but unpublished" is an ORPHAN — sweepable, never assumed: the
 *   compaction lease payload names the output keys and the expiry sweep
 *   (control-plane.ts) deletes them only when the catalog still has no row
 *   for the output. The old packs are never deletable before their successor
 *   publishes — and never deletable here at all (deletion is M3.4's).
 * - Exclusion (§5.1/§5.2): the compaction lease refuses to start while a
 *   receive lease is live (the store's existing receive check,
 *   `hasActiveReceiveLease`) and while another compaction lease is live; a
 *   receive that begins DURING a compaction is safe the other way round — it
 *   writes its OWN pack name (INSERT OR IGNORE never moves rows), so the
 *   publish's guarded re-points cannot steal its rows, and its finalize's
 *   premise check reads a consistent catalog at every instant.
 *
 * Trigger (§5.1): a pack-count threshold over the ACTIVE catalog, consumed by
 * the DO alarm ("crons enqueue, consumers work" — finalizeReceive stamps
 * `compaction_wanted_at`, the alarm runs a round when the threshold is met),
 * plus the manual RPC entry point (`RepoCell.compactNow`) for tests and
 * benches. The Worker cron side needs no entry: the DO alarm IS the consumer.
 */
import { PackWriter } from "./git/pack";
import { OidSet } from "./git/oidset";
import { idxR2Key, packName, packR2Key } from "./git/r2keys";
import type { GitStore } from "./git/store";
import { Sha1, concat, toHex } from "./git/util";
import { Crc32, writeIdx } from "./receive/idx";
import type { IndexRow } from "./control-plane";

// ---------------------------------------------------------------------------
// Trigger + lease constants (Q1's conservative start — bench-informed numbers
// replace them when the M3.5 benches land; each choice is load-bearing and
// documented).
// ---------------------------------------------------------------------------

/**
 * Compaction becomes WANTED when a repo holds more than this many ACTIVE
 * packs. Rationale for 8: (a) every object miss fans out per pack on the
 * serve path, so fetch cost grows linearly past a handful of packs — 8 is
 * where the walk is measurably worse than one pack, but far from pathological;
 * (b) conservative by mandate (Q1: start conservative, let benches tighten);
 * (c) deliberately ABOVE the invariants suite's seven-pack fixture so existing
 * engine checks are never perturbed by a background compaction; (d) with the
 * window constants below, a repo hovering at the threshold converges in one
 * round (9 ACTIVE → merge 8 → 2 ACTIVE). GC (M3.4) and the benches revisit.
 */
export const COMPACTION_ACTIVE_PACK_THRESHOLD = 8;

/**
 * Max packs merged per round (§5.2 step 2's bounded input window): one
 * compaction never touches every pack — whatever the catalog holds, a round's
 * input is a subset, and its blast radius (merge working set + publish-txn
 * statement count) is bounded by these constants, not by repo size. Kept at
 * the threshold so a just-triggered repo can converge in one round.
 */
export const COMPACTION_WINDOW_PACKS = 8;

/**
 * Max total input pack bytes per round. Bounds the merge's memory working set
 * (the successor's bytes are assembled in-isolate and stay ≈ the inputs',
 * since every entry is re-emitted verbatim unless its delta base is missing):
 * 32 MiB keeps output + the 1 MiB raw-chunk windows + the object cache
 * comfortably inside the 128 MiB isolate bound.
 */
export const COMPACTION_WINDOW_BYTES = 32 * 1024 * 1024;

/**
 * Max total indexed objects per round. Bounds the publish transaction's
 * statement count — one guarded re-point UPDATE per merged object — to at
 * most ~50k statements (a fraction of a second of CPU, well under the 5-minute
 * cap) and keeps `transactionSync` short for concurrent RPCs.
 */
export const COMPACTION_WINDOW_OBJECTS = 50_000;

/**
 * Compaction lease TTL. Unlike receive/read leases there is NO renewal: a
 * compaction is ONE DO invocation — bounded by the window constants to stay
 * far under this — so the lease either completes and is released, or the
 * invocation died and the expiry sweep converges the orphan within this
 * window. Concurrent invocations (a second RPC racing an in-flight one at an
 * await point) are excluded by the live lease.
 */
export const COMPACTION_LEASE_TTL_MS = 10 * 60 * 1000;

/** A round merges nothing below this input count — repacking one pack merges
 * nothing. `force` runs respect it too. */
export const COMPACTION_MIN_INPUT_PACKS = 2;

/** How long after a deferred round (or between convergence rounds) the alarm
 * retries. */
export const COMPACTION_RETRY_MS = 30 * 1000;

/** The compaction lease payload (`kind = 'compaction'`): the inputs the round
 * selected, and — once computed — the output keys the orphan sweep converges
 * on (§5.3: prefix + catalog state, never assumption). */
export interface CompactionLeasePayload {
  v: 1;
  /** the storage key the output R2 keys were derived from */
  storageKey: string;
  /** the input window's pack keys */
  inputs: string[];
  /** the successor pack's catalog key (`pack-<sha1>`) and its R2 keys, set
   * once the merge finished — BEFORE the R2 write, so every crash window
   * sweeps by payload + catalog state */
  outputPackKey?: string;
  outputPackR2Key?: string;
  outputIdxR2Key?: string;
}

/** What a compaction round needs from its host (RepoCell contributes the DO
 * storage + the R2 bucket; tests contribute fakes). */
export interface CompactionHost {
  store: GitStore;
  /** transactionSync (the publish txn) + setAlarm (round re-arm) */
  storage: {
    transactionSync<T>(fn: () => T): T;
    setAlarm(at: number | Date): Promise<void>;
  };
  /** Write one R2 object (the successor pack bytes and its idx sidecar). */
  putPackObject(r2Key: string, data: Uint8Array): Promise<void>;
  /** Best-effort R2 deletes (the sweep's orphan reclamation). */
  deletePackObjects(keys: string[]): Promise<void>;
}

export interface CompactionRunOptions {
  /** Manual entry points (tests/benches) may bypass the pack-count threshold;
   * every other gate (leases, window bounds) still applies. */
  force?: boolean;
}

export type CompactionResult =
  | {
      tag: "compacted";
      /** the successor pack's catalog key (`pack-<sha1>`, deterministic) */
      outputPackKey: string;
      outputPackBytes: number;
      outputIdxBytes: number;
      /** merged object count (= the successor's indexed rows) */
      objects: number;
      /** the retired inputs, catalog order */
      inputs: string[];
      /** entries re-emitted verbatim (full copies + delta copies) */
      verbatim: number;
      /** entries re-inflated whole (delta base outside the merged set) */
      reInflated: number;
    }
  | { tag: "deferred"; reason: "receive_lease_live" | "compaction_in_flight" | "lease_lost" }
  | { tag: "skipped"; reason: string; activePacks: number };

/**
 * Run ONE compaction round (SPEC-0011 §5.2). Never throws for application
 * outcomes (tagged unions, per the control-plane RPC discipline); a throw is
 * a transport/engine bug. The lease is released on every exit path.
 */
export async function runCompaction(host: CompactionHost, opts: CompactionRunOptions = {}): Promise<CompactionResult> {
  const { store } = host;
  const now = Date.now();

  // --- §5.1 exclusion: live receives first, then concurrent compactions ----
  if (store.hasActiveLease("receive", now)) {
    return { tag: "deferred", reason: "receive_lease_live" };
  }
  if (store.hasActiveLease("compaction", now)) {
    return { tag: "deferred", reason: "compaction_in_flight" };
  }

  // --- §5.1 trigger: pack-count threshold over the ACTIVE catalog ----------
  const activePacks = store.packs.activePackCount();
  if (!opts.force && activePacks <= COMPACTION_ACTIVE_PACK_THRESHOLD) {
    return { tag: "skipped", reason: "below_threshold", activePacks };
  }

  // --- §5.2 step 2: the bounded input window (oldest ACTIVE packs) ---------
  const window = store.packs.activeCatalogWindow(
    COMPACTION_WINDOW_PACKS,
    COMPACTION_WINDOW_BYTES,
    COMPACTION_WINDOW_OBJECTS
  );
  if (window.length < COMPACTION_MIN_INPUT_PACKS) {
    return { tag: "skipped", reason: "window_too_small", activePacks };
  }
  const inputs = window.map((r) => r.packKey);

  const storageKey = store.getMeta("storage_key") ?? store.getMeta("repo") ?? "";
  const leaseToken = crypto.randomUUID().replaceAll("-", "");
  const payload: CompactionLeasePayload = { v: 1, storageKey, inputs };
  const expiresAt = Date.now() + COMPACTION_LEASE_TTL_MS;
  store.createLease(leaseToken, "compaction", expiresAt, JSON.stringify(payload));

  try {
    // --- §5.2 step 3: merge (dedupe by OID; deltas kept where their base
    // ships earlier in the successor), write the pack + its idx to R2 ------
    const merge = await mergeWindow(store, inputs);
    const outPackKey = packName(merge.packSha1);
    const outPackR2Key = packR2Key(storageKey, outPackKey);
    const outIdxR2Key = idxR2Key(storageKey, outPackKey);

    // the payload now names the output: from this instant every crash sweep
    // converges by payload + catalog state (§5.3)
    store.updateLeasePayload(
      leaseToken,
      JSON.stringify({
        ...payload,
        outputPackKey: outPackKey,
        outputPackR2Key: outPackR2Key,
        outputIdxR2Key: outIdxR2Key,
      } satisfies CompactionLeasePayload)
    );

    await host.putPackObject(outPackR2Key, merge.packBytes);
    await host.putPackObject(outIdxR2Key, merge.idxBytes);

    // --- §5.2 step 4: publish in ONE transaction (new row ACTIVE, inputs →
    // RETIRED, index rows re-pointed); the lease must still be ours --------
    const published = host.storage.transactionSync(() => {
      const lease = store.getLease(leaseToken);
      if (!lease || lease.kind !== "compaction" || lease.expiresAt <= Date.now()) return false;
      store.packs.publishCompaction(
        { packKey: outPackKey, packBytes: merge.packBytes.length, idxBytes: merge.idxBytes.length },
        merge.rows,
        inputs
      );
      return true;
    });
    if (!published) {
      // the lease was swept/expired mid-merge (an isolate pause past the
      // TTL): publish nothing — an unpublished output is an orphan by
      // definition and the sweep owns it now
      return { tag: "deferred", reason: "lease_lost" };
    }

    return {
      tag: "compacted",
      outputPackKey: outPackKey,
      outputPackBytes: merge.packBytes.length,
      outputIdxBytes: merge.idxBytes.length,
      objects: merge.rows.length,
      inputs,
      verbatim: merge.verbatim,
      reInflated: merge.reInflated,
    };
  } finally {
    store.deleteLease(leaseToken);
  }
}

// ---------------------------------------------------------------------------
// The merge (§5.2 step 3)
// ---------------------------------------------------------------------------

interface MergeOutcome {
  /** the successor's indexed rows, in emission order, with their source pack
   * (the publish re-point's guard) */
  rows: (IndexRow & { srcPack: string })[];
  /** pack bytes INCLUDING the 20-byte trailer */
  packBytes: Uint8Array;
  idxBytes: Uint8Array;
  /** the pack's own SHA-1 (its deterministic name) */
  packSha1: string;
  verbatim: number;
  reInflated: number;
}

/**
 * Merge the window's objects into one self-contained packfile.
 *
 * Dedupe by OID is structural: pack_objects keys rows by oid (PRIMARY KEY),
 * so each object exists under exactly one pack — the union of the window's
 * rows is already duplicate-free, and "keep newest" is vacuous (one version
 * exists).
 *
 * Emission (deterministic — a pure function of the row set + stored bytes, so
 * the successor's SHA-1 and its `pack-<sha1>` name are reproducible):
 *  1. Full entries first (oid-ascending), copied VERBATIM (stored compressed
 *     bytes, no recompression).
 *  2. Then delta entries in dependency rounds — a delta is emitted, also
 *     VERBATIM as a ref-delta, only once its base is ALREADY EMITTED (rounds
 *     walk oid-ascending, so the order is a pure function of the set).
 *     Cross-pack bases merge naturally: a pack-B delta over a pack-A object
 *     ships once A's object is in. This is §5.2's "keep base deltas".
 *  3. Anything left (base OUTSIDE the window — a thin-pack leftover resolved
 *     from loose storage or a pack outside the round; defensively also a
 *     cycle the store would reject at read time) is re-inflated WHOLE via
 *     store.get — the successor stays self-contained, as a stored pack must
 *     (thin packs are a transport shape, not a storage shape).
 *
 * Input reads run WITHOUT a read gate on purpose: compaction is the
 * GC-adjacent actor, nothing retires packs under it (only compaction
 * publishes RETIRED), and its inputs are ACTIVE by construction.
 */
async function mergeWindow(store: GitStore, inputs: string[]): Promise<MergeOutcome> {
  // gather the window's rows (oid-unique by the PRIMARY KEY), paged
  const src = new Map<string, IndexRow & { srcPack: string }>();
  for (const packKey of inputs) {
    let after = "";
    for (;;) {
      const page = store.packs.indexRowsAfter(packKey, after, 512);
      if (!page.length) break;
      for (const row of page) {
        src.set(row.oid, { ...row, srcPack: packKey });
        after = row.oid;
      }
    }
  }

  // emission order: full entries, then dependency rounds, then leftovers —
  // all oid-ascending within each class, so the total order is deterministic
  const oids = [...src.keys()].sort();
  const full = oids.filter((o) => src.get(o)!.baseOid === null);
  const emitted = new Set<string>(full);
  const order = [...full];
  let pending = oids.filter((o) => src.get(o)!.baseOid !== null);
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    const still: string[] = [];
    for (const oid of pending) {
      const base = src.get(oid)!.baseOid!;
      if (emitted.has(base)) {
        emitted.add(oid);
        order.push(oid);
        progressed = true;
      } else {
        still.push(oid);
      }
    }
    pending = still;
  }
  // leftovers: their base never became emittable during the rounds. Sorted
  // in with the rest, they re-inflate whole UNLESS an earlier tail entry
  // turned out to be their (already-emitted) base.
  order.push(...pending);

  // emit the packfile, tracking per-entry regions for the index rows
  const parts: Uint8Array[] = [];
  let pos = 0;
  const sha = new Sha1();
  const write = (chunk: Uint8Array): void => {
    parts.push(chunk);
    pos += chunk.length;
    sha.update(chunk);
  };
  const writer = new PackWriter(write);
  writer.header(order.length);

  const rows: (IndexRow & { srcPack: string })[] = [];
  let verbatim = 0;
  let reInflated = 0;
  for (const oid of order) {
    const s = src.get(oid)!;
    const startIdx = parts.length;
    const offset = pos;
    let type = s.type;
    let size = s.size;
    let entrySize = s.entrySize;
    let baseOid = s.baseOid;
    if (baseOid === null) {
      // verbatim full copy: the stored region is exactly the compressed
      // object stream
      const stored = await store.packs.readRaw(s.srcPack, s.dataOff, s.dataLen);
      writer.rawFull(type, entrySize, stored);
      verbatim++;
    } else if (emitted.has(baseOid)) {
      // verbatim delta copy, re-addressed as a ref-delta: dataOff skips the
      // source entry header AND its base-addressing bytes (the scan records
      // the compressed delta stream's start), so the same stored bytes serve
      // either source addressing (REF or ofs)
      const stored = await store.packs.readRaw(s.srcPack, s.dataOff, s.dataLen);
      writer.rawDelta(entrySize, baseOid, stored);
      verbatim++;
    } else {
      // base outside the merged set (or a pathological chain): re-inflate
      // whole — a stored pack must be self-contained; thin packs are a
      // transport shape, not a storage shape
      const obj = await store.get(oid);
      if (!obj) throw new Error(`compaction: object ${oid} vanished from the window`);
      writer.object(obj.type, obj.data);
      type = obj.type;
      size = obj.data.length;
      entrySize = obj.data.length;
      baseOid = null;
      reInflated++;
    }
    // the entry's raw bytes = the chunks written since it started; the stored
    // region begins after the entry header (and after the 20-byte base oid
    // for a verbatim delta — the writer's second chunk); the CRC covers the
    // raw entry, exactly like the receive scan's per-entry CRC
    const entry = parts.slice(startIdx);
    const crc = new Crc32();
    for (const p of entry) crc.update(p);
    const headerLen = entry[0].length + (entry.length > 2 ? entry[1].length : 0);
    rows.push({
      oid,
      offset,
      dataOff: offset + headerLen,
      dataLen: entry[entry.length - 1].length,
      type,
      size,
      entrySize,
      baseOid,
      crc32: crc.get(),
      srcPack: s.srcPack,
    });
  }
  // the content digest is exactly what PackWriter.finish() emits as the
  // trailer — snapshot it BEFORE finish(), because the trailer chunk passes
  // back through `write` and would pollute a post-finish digest
  const packSha1 = toHex(sha.digest());
  writer.finish();
  const packBytes = concat(parts);

  // idx v2 sidecar — the R2 layout is pack + idx (fork replication copies the
  // sidecar whenever idx_bytes > 0, so a successor without one would diverge)
  const oidSet = new OidSet(rows.length);
  const entryCrcs = new Uint32Array(rows.length);
  const entryOffsets = new Float64Array(rows.length);
  const oidEntry: number[] = [];
  rows.forEach((r, i) => {
    oidSet.markHex(r.oid);
    entryCrcs[i] = r.crc32;
    entryOffsets[i] = r.offset;
    oidEntry.push(i);
  });
  const idxChunks: Uint8Array[] = [];
  await writeIdx((chunk) => {
    idxChunks.push(chunk);
  }, {
    oids: oidSet,
    oidEntry,
    entryCrcs,
    entryOffsets,
    packSha1,
  });
  const idxBytes = concat(idxChunks);

  return { rows, packBytes, idxBytes, packSha1, verbatim, reInflated };
}

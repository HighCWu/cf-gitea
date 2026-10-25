import pako from "pako";
import { ObjType } from "./objects";
import { applyDelta } from "./pack";
import { packR2Key } from "./r2keys";
import { concat } from "./util";
import type { IndexRow, LookupObjectHit, LookupObjectResult } from "../control-plane";
import { ObjCache, ObjRec } from "../receive/objcache";
import { REPO_PACK_BASELINE_SQL, replayRepoSchema, schemaSealedError } from "./migrations";

export const PACK_CHUNK = 1024 * 1024;
/** Size threshold from SPEC-0001 §3/§8: packs at least this large exist only in
 * R2; smaller packs MAY live in DO SQLite (pack_data) for latency — the
 * pack_catalog `location` column carries that decision. Since Step 1 every
 * received pack is staged in R2 by the Worker regardless of size; this bound
 * remains the small-pack local-store rule for later milestones. */
export const R2_PACK_MIN_BYTES = 16 * 1024 * 1024;
/** real Workers isolates have a hard 128MB total; self-hosted celld nodes run multi-GB heaps */
const TIGHT_MEMORY = typeof caches !== "undefined";
/**
 * Decoded pack chunks kept hot for readRaw. The clone loop reads one object
 * per call in walk order, so without this every object re-SELECTs and
 * re-decodes a whole 1MB row. A handful of 1MB chunks covers any delta chain
 * and the locality of the walk.
 */
const RAW_CHUNK_CACHE = TIGHT_MEMORY ? 4 : 8;
/**
 * Hard cap on delta base-chain length when resolving an object. git's default
 * pack depth is 50; 50000 leaves enormous headroom for legitimately deep packs
 * while a crafted unbounded chain is rejected instead of looping forever. The
 * base walk is iterative (not recursive) and separately cycle-checked via a
 * seen-set, so this bounds chain length rather than guarding stack depth.
 */
const MAX_DELTA_DEPTH = 50000;
/**
 * pako output-chunk size. The default (64 KiB) is large enough that V8 keeps
 * every inflate's backing store in its array-buffer arena, so streaming a pack
 * one Inflate per object commits arena proportional to the object count — a
 * 53MB pack peaked near 250MB of buffers this way. 16 KiB chunks are collected
 * promptly, holding inflate memory to a bounded working set regardless of pack
 * size.
 */
const INFLATE_CHUNK = 16 * 1024;
const inflateAll = (data: Uint8Array): Uint8Array => {
  const inf = new pako.Inflate({ chunkSize: INFLATE_CHUNK });
  inf.push(data, true);
  if (inf.err) throw new Error(`inflate failed: ${inf.msg}`);
  return inf.result as Uint8Array;
};

export interface PackedEntry {
  oid: string;
  /** the pack catalog's key (= R2 object stem, `pack-<sha1>`) */
  packKey: string;
  offset: number;
  dataOff: number;
  dataLen: number;
  type: ObjType;
  size: number;
  entrySize: number;
  baseOid: string | null;
}

export type ExternalResolver = (oid: string) => ObjRec | null;

/**
 * Loose objects bigger than this are not shipped to the Worker by
 * `lookupObjects` (their presence still holds for connectivity; the content
 * would stress the RPC for no realistic thin-pack base). Mirrors the
 * Worker-side handover bounds (receive/scan.ts).
 */
export const LOOSE_LOOKUP_CAP = 64 * 1024 * 1024;
/**
 * Index rows land in bounded batches from the Worker (SPEC-0001a §3 Step 2).
 * workerd caps a DO SQL statement at ~100 bound variables (celld's stock
 * SQLite allows more); 8 rows x 10 cols = 80 stays under that on both.
 */
const ROW_BATCH_ROWS = 8;

/**
 * Pack lifecycle states (docs/design/m3-design-inputs.md). Only 'active' is
 * written today; the RETIRED/RECLAIMABLE machinery is M3 compaction.
 */
export type PackState = "active" | "retired" | "reclaimable" | "deleted";

/**
 * One pack_catalog row (SPEC-0001 §4, renamed from dgit's `pack_meta` at the
 * Step 4 schema alignment — the shape diverged materially, and integer pack
 * ids leaked engine internals into keys). `packKey` is `pack-<sha1>` (the R2
 * object stem, deterministic); `seq` is the `next_pack_seq` catalog order
 * (never an R2 name); `state`/`superseded_by` are reserved for M3.
 */
export interface PackCatalogRow {
  packKey: string;
  seq: number;
  /** 'receive' today, 'compact' from M3 */
  kind: string;
  state: PackState;
  /** 'r2' | 'sqlite' (SPEC-0001a §8 correction 2) */
  location: "r2" | "sqlite";
  objectCount: number;
  packBytes: number;
  idxBytes: number;
  createdAt: number;
  supersededBy: string | null;
}

/**
 * Pack-native object database: received packfiles are stored verbatim — since
 * SPEC-0001a §3 the Worker stages them straight into R2, SCANS them, and
 * pushes the resulting index rows here (`putIndexRows`); the DO never reads
 * pack bytes on the receive path. The bytes of an R2-backed pack live at the
 * key built by src/git/r2keys.ts from the repo's storage key and the pack
 * name (`repos/<storage_key>/packs/<packName>.pack`); only the index ever
 * lives in SQLite for such a pack, so pack data escapes the per-DO storage
 * ceiling. This is what lets large repos fit and stream.
 */
export class PackStore {
  /** LRU of decoded pack chunks, keyed "packKey:seq" (SQLite row or R2 range). */
  private chunks = new Map<string, Uint8Array>();
  /**
   * R2 pack backend for this repo, or null when no bucket is bound (celld /
   * Workers without the binding). Received packs store their bytes in R2 and
   * keep only the index in SQLite. Keys are derived from the persisted
   * storage key via r2keys.ts — no repo name is involved.
   */
  private r2: { bucket: R2Bucket; storageKey: string } | null = null;
  /** Cached backend ('r2' | 'sqlite') per pack key, from pack_catalog.location. */
  private backend = new Map<string, "r2" | "sqlite">();
  /**
   * R2 object key override per pack key. The one legal non-derived state: a
   * receive in flight, whose bytes are still the Worker's STAGING object (the
   * catalog row does not exist until finalize, after the copy). recordPack
   * clears the override; the derived packs/ key takes over.
   */
  private r2KeyOverrides = new Map<string, string>();

  constructor(
    private sql: SqlStorage,
    private extern: ExternalResolver,
    /** Sealed posture (SPEC-0011 §8): the schema journal refused this
     * database — touch nothing, fail every data access with the sealed
     * diagnostic until an explicit wipe unseals. */
    private sealed = false
  ) {
    this.init();
  }

  /** The distinct sealed-posture diagnostic (mirror of GitStore.assertOpen). */
  private assertOpen(): void {
    if (this.sealed) throw schemaSealedError("pack store sealed with its GitStore");
  }

  /** Bind (or clear) the R2 backend. Idempotent; the DO is per-repo so this is
   * set on each request from the persisted storage key. */
  setR2(bucket: R2Bucket | undefined, storageKey: string): void {
    this.r2 = bucket ? { bucket, storageKey } : null;
  }

  /**
   * The R2 object key holding a pack's bytes: the staging override while a
   * receive is in flight, else the r2keys.ts derivation
   * `repos/<storage_key>/packs/<packName>.pack`. There is no legacy fallback —
   * pre-Step-3 keys (`raw/<repo>/<id>`) belonged to a schema generation the
   * Step 4 cutover wipes.
   */
  r2KeyOf(packKey: string): string {
    const override = this.r2KeyOverrides.get(packKey);
    if (override) return override;
    if (!this.r2) throw new Error(`pack ${packKey}: no R2 backend bound for key derivation`);
    return packR2Key(this.r2.storageKey, packKey);
  }

  /** Storage backend of a pack. Cached; falls back to a pack_catalog lookup. */
  private backendOf(packKey: string): "r2" | "sqlite" {
    const hit = this.backend.get(packKey);
    if (hit) return hit;
    const rows = this.sql
      .exec<{ location: string }>("SELECT location FROM pack_catalog WHERE pack_key = ?", packKey)
      .toArray();
    // default 'r2': every post-Step-1 pack is R2-backed (the Worker stages
    // it); a 'sqlite' location is recorded explicitly by the small-pack path
    const b = rows[0]?.location === "sqlite" ? "sqlite" : "r2";
    this.backend.set(packKey, b);
    return b;
  }

  /** Create this store's tables (idempotent). The DDL is the migration
   * baseline's PackStore half — one copy lives in migrations.ts (the GitStore
   * constructor runs the journal before this store is constructed, so on any
   * normal open these statements no-op). A sealed store creates nothing. */
  private init(): void {
    if (this.sealed) return;
    this.sql.exec(REPO_PACK_BASELINE_SQL);
  }

  wipe(): void {
    this.sealed = false; // the explicit wipe recovers a sealed store
    for (const t of ["pack_catalog", "pack_data", "pack_objects", "fork_import"]) {
      this.sql.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    this.chunks.clear(); // pack keys are content-derived, but caches hold chunk bytes
    this.backend.clear();
    this.r2KeyOverrides.clear();
    // the journal now over-reports (its rows claim schema this wipe just
    // dropped) — replayRepoSchema clears it and re-applies the idempotent
    // migration list, rebuilding the pack tables AND the journal truthfully
    // (SPEC-0011 §8: wipes return to schema head through the replay
    // primitive, never through the unrecognized-state machinery)
    replayRepoSchema(this.sql);
  }

  /** Drop all packs and start empty (small-repo gc migrates objects out first). */
  reset(): void {
    this.wipe();
  }

  /**
   * The pack_catalog sequence (meta `next_pack_seq`, SPEC-0001 §4): catalog
   * ordering only — it never appears in an R2 key (SPEC-0001a §3 Step 3).
   * Reads GitStore's meta table directly (same SQLite database); only ever
   * called after GitStore.init has created it.
   */
  private nextPackSeq(): number {
    const rows = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'next_pack_seq'").toArray();
    const next = (Number(rows[0]?.value ?? "0") || 0) + 1;
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('next_pack_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(next)
    );
    return next;
  }

  /** Pack keys of the currently R2-backed packs (for GC to delete their R2 bytes). */
  r2PackKeys(): string[] {
    this.assertOpen();
    return this.sql
      .exec<{ pack_key: string }>("SELECT pack_key FROM pack_catalog WHERE location = 'r2'")
      .toArray()
      .map((r) => r.pack_key);
  }

  /** Delete the R2 raw objects for the given packs (no-op without a binding). */
  async deleteR2Packs(packKeys: string[]): Promise<void> {
    if (!this.r2 || !packKeys.length) return;
    const keys = packKeys.map((name) => packR2Key(this.r2!.storageKey, name));
    for (let i = 0; i < keys.length; i += 100) {
      try {
        await this.r2.bucket.delete(keys.slice(i, i + 100));
      } catch {
        // best effort: an undeleted raw object is unreferenced garbage
      }
    }
  }

  countObjects(): number {
    this.assertOpen();
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pack_objects").one().n;
  }

  /** Total stored bytes across all indexed packs (0 when pack-empty). */
  totalPackBytes(): number {
    this.assertOpen();
    return this.sql.exec<{ n: number }>("SELECT COALESCE(SUM(pack_bytes), 0) AS n FROM pack_catalog").one().n;
  }

  /**
   * Bytes of pack storage the raw-chunk LRU keeps hot. A pack no larger than
   * this fits entirely in cache, so readRaw never re-decodes a chunk no matter
   * what order objects are emitted in — sorting for read locality is pure
   * overhead below this threshold.
   */
  rawCacheWindow(): number {
    return RAW_CHUNK_CACHE * PACK_CHUNK;
  }

  lookup(oid: string): PackedEntry | null {
    this.assertOpen();
    const rows = this.sql
      .exec<{
        pack_key: string; offset: number; data_off: number; data_len: number;
        type: ObjType; size: number; entry_size: number; base_oid: string | null;
      }>(
        "SELECT pack_key, offset, data_off, data_len, type, size, entry_size, base_oid FROM pack_objects WHERE oid = ?",
        oid
      )
      .toArray();
    const r = rows[0];
    if (!r) return null;
    return {
      oid, packKey: r.pack_key, offset: r.offset, dataOff: r.data_off, dataLen: r.data_len,
      type: r.type, size: r.size, entrySize: r.entry_size, baseOid: r.base_oid,
    };
  }

  typeAndSize(oid: string): { type: ObjType; size: number } | null {
    this.assertOpen();
    const rows = this.sql
      .exec<{ type: ObjType; size: number }>("SELECT type, size FROM pack_objects WHERE oid = ?", oid)
      .toArray();
    return rows[0] ?? null;
  }

  /** Distinct delta-base oids: a second reference edge gc must not sever. */
  baseOids(): string[] {
    this.assertOpen();
    return this.sql
      .exec<{ base_oid: string }>("SELECT DISTINCT base_oid FROM pack_objects WHERE base_oid IS NOT NULL")
      .toArray()
      .map((r) => r.base_oid);
  }

  findOidPrefix(prefix: string): string[] {
    this.assertOpen();
    return this.sql
      .exec<{ oid: string }>("SELECT oid FROM pack_objects WHERE oid LIKE ? LIMIT 2", prefix + "%")
      .toArray()
      .map((r) => r.oid);
  }

  /**
   * Raw stored (still-compressed) bytes of a pack region. Chunk rows are
   * fetched one at a time: a wide range in a single SELECT can exceed the
   * runtime's result-set size cap (celld materializes blob rows as JSON).
   */
  async readRaw(packKey: string, off: number, len: number): Promise<Uint8Array> {
    this.assertOpen();
    const first = Math.floor(off / PACK_CHUNK);
    const last = Math.floor((off + len - 1) / PACK_CHUNK);
    const out = new Uint8Array(len);
    for (let seq = first; seq <= last; seq++) {
      const chunk = await this.chunk(packKey, seq);
      const chunkStart = seq * PACK_CHUNK;
      const from = Math.max(off, chunkStart);
      const to = Math.min(off + len, chunkStart + chunk.length);
      if (to > from) out.set(chunk.subarray(from - chunkStart, to - chunkStart), from - off);
    }
    return out;
  }

  /**
   * One decoded pack chunk, through the LRU. For a SQLite-backed pack this is a
   * `pack_data` row; for an R2-backed pack it is an aligned ~1 MiB range GET
   * against the pack's R2 object, so sorted sequential reads (a clone) issue
   * ~one GET per chunk instead of one per object. Chunks are immutable once
   * written — a pack is inserted once and only ever removed wholesale (wipe/
   * reset, or the sweep paths, both of which clear the cache), so a hit can
   * never be stale.
   */
  private async chunk(packKey: string, seq: number): Promise<Uint8Array> {
    const key = `${packKey}:${seq}`;
    const hit = this.chunks.get(key);
    if (hit) {
      this.chunks.delete(key); // reinsert: most-recently-used goes last
      this.chunks.set(key, hit);
      return hit;
    }
    let chunk: Uint8Array;
    if (this.backendOf(packKey) === "r2") {
      if (!this.r2) throw new Error(`pack ${packKey}: R2 backend not bound`);
      const key = this.r2KeyOf(packKey);
      const obj = await this.r2.bucket.get(key, {
        range: { offset: seq * PACK_CHUNK, length: PACK_CHUNK },
      });
      if (!obj) throw new Error(`pack ${packKey}: missing R2 object ${key}`);
      chunk = new Uint8Array(await obj.arrayBuffer());
    } else {
      const rows = this.sql
        .exec<{ data: ArrayBuffer }>(
          "SELECT data FROM pack_data WHERE pack_key = ? AND seq = ?",
          packKey,
          seq
        )
        .toArray();
      if (!rows.length) throw new Error(`pack ${packKey}: missing chunk ${seq}`);
      chunk = new Uint8Array(rows[0].data);
    }
    this.chunks.set(key, chunk);
    while (this.chunks.size > RAW_CHUNK_CACHE) {
      this.chunks.delete(this.chunks.keys().next().value as string);
    }
    return chunk;
  }

  /**
   * Inflate + delta-resolve an object out of pack storage. A crafted pack can
   * chain deltas arbitrarily deep or in a cycle, so the base chain is walked
   * ITERATIVELY (not recursively) through cheap index lookups first — bounding
   * the chain length and detecting cycles before a single delta is inflated —
   * then applied from the base upward, holding at most two inflated buffers at
   * a time. This caps both stack depth and peak memory regardless of input.
   */
  async getObject(oid: string, cache: ObjCache): Promise<ObjRec | null> {
    const cached = cache.get(oid);
    if (cached) return cached;
    const first = this.lookup(oid);
    if (!first) return null;

    // walk to the base via lookups only: collect the delta entries, resolve
    // where the chain bottoms out (a full entry, a cached object, or a thin
    // base from another pack / loose storage).
    const chain: PackedEntry[] = [];
    const seen = new Set<string>();
    let base: ObjRec | null = null;
    let cur: PackedEntry = first;
    for (;;) {
      if (seen.has(cur.oid)) throw new Error(`cyclic delta chain at ${cur.oid}`);
      seen.add(cur.oid);
      if (!cur.baseOid) {
        base = { type: cur.type, data: inflateAll(await this.readRaw(cur.packKey, cur.dataOff, cur.dataLen)) };
        break;
      }
      if (chain.length >= MAX_DELTA_DEPTH) throw new Error(`delta chain exceeds depth ${MAX_DELTA_DEPTH} at ${oid}`);
      chain.push(cur);
      const cachedBase = cache.get(cur.baseOid);
      if (cachedBase) { base = cachedBase; break; }
      const next = this.lookup(cur.baseOid);
      if (!next) {
        const ext = this.extern(cur.baseOid);
        if (!ext) throw new Error(`missing delta base ${cur.baseOid} for ${cur.oid}`);
        base = ext;
        break;
      }
      cur = next;
    }

    // apply deltas from the base upward (chain is target..base order)
    let obj = base;
    for (let i = chain.length - 1; i >= 0; i--) {
      const d = chain[i];
      const delta = inflateAll(await this.readRaw(d.packKey, d.dataOff, d.dataLen));
      obj = { type: base.type, data: applyDelta(obj.data, delta) };
      cache.put(d.oid, obj);
    }
    if (!chain.length) cache.put(oid, obj);
    return obj;
  }

  // ---- Worker-pushed index rows (SPEC-0001a §3 Step 2) ----------------------
  //
  // The Worker scans and resolves the pack; only these control-plane writes
  // remain. Rows land BEFORE finalize; the pack_catalog row is recorded by
  // finalize's commit transaction, so rows without one are crash debris the
  // sweeps reclaim — the same story the DO-side ingest had.

  /**
   * Batched insert of Worker-resolved rows, keyed by the pack's NAME
   * (`pack-<sha1>`, built by r2keys.ts and carried to the DO in the lease
   * payload). `INSERT OR IGNORE` keeps a duplicate oid's FIRST location —
   * including within one batch; an identical repack re-pushing the same bytes
   * is a no-op by the same token (content-addressed rows).
   */
  putRows(packKey: string, rows: IndexRow[]): void {
    this.assertOpen();
    for (let i = 0; i < rows.length; i += ROW_BATCH_ROWS) {
      const slice = rows.slice(i, i + ROW_BATCH_ROWS);
      const values = slice.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",");
      const args: (string | number | null)[] = [];
      for (const r of slice) {
        args.push(r.oid, packKey, r.offset, r.dataOff, r.dataLen, r.type, r.size, r.entrySize, r.baseOid, r.crc32);
      }
      this.sql.exec(
        `INSERT OR IGNORE INTO pack_objects (oid, pack_key, offset, data_off, data_len, type, size, entry_size, base_oid, crc32) VALUES ${values}`,
        ...args
      );
    }
    // the freshly written rows are readable through the same connection; the
    // per-pack caches only hold chunk/key/backend state, which is unaffected
  }

  /**
   * Prime the per-pack caches BEFORE the catalog row exists: rows land via
   * putIndexRows while the pack bytes are still the Worker's staging object,
   * and DO-side reads over those rows (the ancestry walk in validatePush)
   * must hit the staging key, not a missing catalog row. recordPack clears
   * the override — the bytes are identical, so cached chunks stay valid
   * across the re-point.
   */
  primePack(packKey: string, stagingR2Key: string): void {
    this.backend.set(packKey, "r2");
    this.r2KeyOverrides.set(packKey, stagingR2Key);
  }

  /**
   * Record the pack_catalog row (finalize's commit transaction) — implemented
   * in the fork-replication section below (same class; the `kind` parameter
   * defaults to 'receive' for the receive path).
   */

  /** Delete every index/data row of one pack (lease sweeps, abandoned
   * receives). Cache state is cleared because chunk keys overlap by prefix. */
  sweepPackRows(packKey: string): void {
    this.assertOpen();
    this.sql.exec("DELETE FROM pack_objects WHERE pack_key = ?", packKey);
    this.sql.exec("DELETE FROM pack_data WHERE pack_key = ?", packKey);
    this.sql.exec("DELETE FROM pack_catalog WHERE pack_key = ?", packKey);
    this.chunks.clear();
    this.backend.delete(packKey);
    this.r2KeyOverrides.delete(packKey);
  }

  /** Reclaim rows whose pack never reached pack_catalog — the debris of a
   * receive that died between putIndexRows and finalize. `keepPackKey` (the
   * current lease's pack, still being written) is preserved. */
  sweepOrphanRows(keepPackKey: string | null): void {
    this.assertOpen();
    const orphans = this.sql
      .exec<{ pack_key: string }>(
        `SELECT pack_key FROM (
           SELECT DISTINCT pack_key FROM pack_data WHERE pack_key NOT IN (SELECT pack_key FROM pack_catalog)
           UNION
           SELECT DISTINCT pack_key FROM pack_objects WHERE pack_key NOT IN (SELECT pack_key FROM pack_catalog)
         ) WHERE pack_key != ?`,
        keepPackKey ?? "-"
      )
      .toArray()
      .map((r) => r.pack_key);
    for (const key of orphans) this.sweepPackRows(key);
  }

  /**
   * Resolve oids against the pack index for the Worker (lookupObjects RPC):
   * aligned with the input, null where the object is not packed (the caller
   * falls back to loose storage). One indexed probe per oid — workerd's SQLite
   * rejects multi-placeholder IN lists, and a batch is bounded by the RPC's
   * 512-oid cap anyway, so flat per-oid probes stay microseconds each. The
   * full R2 key resolves through the per-pack override/derivation chain.
   */
  lookupPacked(oids: string[]): (LookupObjectHit | null)[] {
    this.assertOpen();
    return oids.map((oid) => {
      const rows = this.sql
        .exec<{
          pack_key: string; offset: number; data_off: number; data_len: number;
          type: ObjType; base_oid: string | null;
        }>(
          "SELECT pack_key, offset, data_off, data_len, type, base_oid FROM pack_objects WHERE oid = ?",
          oid
        )
        .toArray();
      const r = rows[0];
      if (!r) return null;
      return {
        found: true,
        packKey: this.r2KeyOf(r.pack_key),
        offset: r.offset,
        dataOff: r.data_off,
        dataLen: r.data_len,
        type: r.type,
        baseOid: r.base_oid,
      };
    });
  }

  /** Keyset page of a pack's indexed oids (validatePush builds the reachable
   * set for a cached fast-forward from the rows alone — no pack bytes). */
  packOidsAfter(packKey: string, after: string, limit: number): string[] {
    this.assertOpen();
    return this.sql
      .exec<{ oid: string }>(
        "SELECT oid FROM pack_objects WHERE pack_key = ? AND oid > ? ORDER BY oid LIMIT ?",
        packKey, after, limit
      )
      .toArray()
      .map((r) => r.oid);
  }

  // ---- fork replication reads (SPEC-0001b §5.3) ------------------------------
  // The parent side of catalog replication: paged reads over the ACTIVE pack
  // catalog and the per-pack index rows, plus the small-pack bytes a sqlite
  // location hides from every other DO. Control data only — pack bytes for
  // 'r2' packs are streamed by the Worker consumer straight from R2.

  /** Keyset page of ACTIVE catalog rows in pack_key order. Non-active states
   * ('retired'/'reclaimable'/'deleted') are compaction debris whose objects
   * the active set already holds — a fork copy must never resurrect them. */
  activeCatalogAfter(afterPackKey: string, limit: number): PackCatalogRow[] {
    this.assertOpen();
    return this.sql
      .exec<{
        pack_key: string; seq: number; kind: string; state: string; location: string;
        object_count: number; pack_bytes: number; idx_bytes: number; created_at: number;
        superseded_by: string | null;
      }>(
        `SELECT pack_key, seq, kind, state, location, object_count, pack_bytes, idx_bytes, created_at, superseded_by
           FROM pack_catalog
          WHERE state = 'active' AND pack_key > ?
          ORDER BY pack_key
          LIMIT ?`,
        afterPackKey,
        limit
      )
      .toArray()
      .map((r) => ({
        packKey: r.pack_key,
        seq: r.seq,
        kind: r.kind,
        state: r.state as PackState,
        location: r.location === "sqlite" ? "sqlite" : "r2",
        objectCount: r.object_count,
        packBytes: r.pack_bytes,
        idxBytes: r.idx_bytes,
        createdAt: r.created_at,
        supersededBy: r.superseded_by,
      }));
  }

  /** Whether another ACTIVE pack exists after `afterPackKey` (the `more` probe
   * of listCatalogPage's last page). */
  hasActiveCatalogAfter(afterPackKey: string): boolean {
    this.assertOpen();
    return (
      this.sql
        .exec("SELECT 1 FROM pack_catalog WHERE state = 'active' AND pack_key > ? LIMIT 1", afterPackKey)
        .toArray()
        .length > 0
    );
  }

  /**
   * Pack keys servable to in-flight read plans (SPEC-0011 §2/§3): ACTIVE plus
   * RETIRED — retired packs serve EXISTING readers, and a plan registered in
   * the same instant a compaction retires its inputs is exactly such a reader.
   * RECLAIMABLE and DELETED rows are excluded: a new plan must never depend on
   * a pack whose bytes may already be (or become) gone. This is the dependency
   * set `planFetch` protects and the gate `renewAndAuthorizeRead` re-checks —
   * both in the same serialized control domain (one SELECT inside the
   * caller's transaction).
   */
  readableCatalogKeys(): string[] {
    this.assertOpen();
    return this.sql
      .exec<{ pack_key: string }>(
        "SELECT pack_key FROM pack_catalog WHERE state IN ('active', 'retired') ORDER BY pack_key"
      )
      .toArray()
      .map((r) => r.pack_key);
  }

  /** One ACTIVE catalog row by exact key (listCatalogPage's split-pack
   * continuation fetches the row it is mid-way through). */
  activeCatalogRow(packKey: string): PackCatalogRow | null {
    this.assertOpen();
    const rows = this.sql
      .exec<{
        pack_key: string; seq: number; kind: string; state: string; location: string;
        object_count: number; pack_bytes: number; idx_bytes: number; created_at: number;
        superseded_by: string | null;
      }>(
        `SELECT pack_key, seq, kind, state, location, object_count, pack_bytes, idx_bytes, created_at, superseded_by
           FROM pack_catalog
          WHERE state = 'active' AND pack_key = ?`,
        packKey
      )
      .toArray();
    const r = rows[0];
    if (!r) return null;
    return {
      packKey: r.pack_key,
      seq: r.seq,
      kind: r.kind,
      state: r.state as PackState,
      location: r.location === "sqlite" ? "sqlite" : "r2",
      objectCount: r.object_count,
      packBytes: r.pack_bytes,
      idxBytes: r.idx_bytes,
      createdAt: r.created_at,
      supersededBy: r.superseded_by,
    };
  }

  /** Full-shape keyset page of one pack's index rows (listCatalogPage's row
   * slices; the same columns receive's putIndexRows landed). */
  indexRowsAfter(packKey: string, afterOid: string, limit: number): IndexRow[] {
    this.assertOpen();
    return this.sql
      .exec<{
        oid: string; offset: number; data_off: number; data_len: number;
        type: ObjType; size: number; entry_size: number; base_oid: string | null; crc32: number;
      }>(
        `SELECT oid, offset, data_off, data_len, type, size, entry_size, base_oid, crc32
           FROM pack_objects
          WHERE pack_key = ? AND oid > ?
          ORDER BY oid
          LIMIT ?`,
        packKey,
        afterOid,
        limit
      )
      .toArray()
      .map((r) => ({
        oid: r.oid,
        offset: r.offset,
        dataOff: r.data_off,
        dataLen: r.data_len,
        type: r.type,
        size: r.size,
        entrySize: r.entry_size,
        baseOid: r.base_oid,
        crc32: r.crc32,
      }));
  }

  /** The stored bytes of a sqlite-location pack, reassembled from its 1 MiB
   * pack_data chunks (listCatalogPage's inline `packData`). No R2-backed pack
   * ever takes this path. */
  sqlitePackBytes(packKey: string): Uint8Array {
    this.assertOpen();
    const rows = this.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM pack_data WHERE pack_key = ? ORDER BY seq", packKey)
      .toArray();
    return concat(rows.map((r) => new Uint8Array(r.data)));
  }

  /** Index rows actually keyed under one pack (an oid's row lives under the
   * FIRST pack that indexed it — INSERT OR IGNORE — so a copy's count is the
   * recomputed one, exactly what recordPack writes). */
  countPackRows(packKey: string): number {
    this.assertOpen();
    return this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM pack_objects WHERE pack_key = ?", packKey)
      .one().n;
  }

  // ---- fork import staging (SPEC-0001b §5.3 step 4) --------------------------
  // adoptForkPacks stages each completed pack here; finalizeForkImport turns
  // staging into pack_catalog rows in the ONE transaction that also writes
  // refs — a crash before finalize leaves servable nothing (no catalog, no
  // refs) and the idempotent re-run restages everything.

  /** Record a completed pack for finalize. REPLACE: an idempotent re-run
   * restages the same pack with recomputed values. */
  stageForkPack(packKey: string, objectCount: number, packBytes: number, idxBytes: number): void {
    this.assertOpen();
    this.sql.exec(
      `INSERT INTO fork_import (pack_key, object_count, pack_bytes, idx_bytes, staged_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(pack_key) DO UPDATE SET object_count = excluded.object_count, pack_bytes = excluded.pack_bytes, idx_bytes = excluded.idx_bytes, staged_at = excluded.staged_at`,
      packKey,
      objectCount,
      packBytes,
      idxBytes,
      Date.now()
    );
  }

  stagedForkPacks(): { packKey: string; objectCount: number; packBytes: number; idxBytes: number }[] {
    this.assertOpen();
    return this.sql
      .exec<{ pack_key: string; object_count: number; pack_bytes: number; idx_bytes: number }>(
        "SELECT pack_key, object_count, pack_bytes, idx_bytes FROM fork_import ORDER BY pack_key"
      )
      .toArray()
      .map((r) => ({ packKey: r.pack_key, objectCount: r.object_count, packBytes: r.pack_bytes, idxBytes: r.idx_bytes }));
  }

  /** Clear the staging table (beginForkImport's fresh start and finalize's
   * commit). Must run inside the caller's transaction where atomicity matters. */
  clearForkStaging(): void {
    this.assertOpen();
    this.sql.exec("DELETE FROM fork_import");
  }

  /**
   * Record the pack_catalog row (finalize's commit transaction). The count is
   * the actual indexed-row count, not the pack header's declaration. The catalog
   * key IS the R2 object stem (`pack-<sha1>`); the sequence comes from
   * the formal `next_pack_seq` meta key. kind='receive' (M3 adds 'compact',
   * fork replication records 'fork'), state='active' (M3 adds the
   * RETIRED/RECLAIMABLE transitions), location='r2' (the <16 MiB sqlite
   * location is a later-milestone writer).
   */
  recordPack(packKey: string, packBytes: number, idxBytes: number, kind: string = "receive"): void {
    this.assertOpen();
    const count = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM pack_objects WHERE pack_key = ?", packKey)
      .one().n;
    this.sql.exec(
      `INSERT INTO pack_catalog (pack_key, seq, kind, state, location, object_count, pack_bytes, idx_bytes, created_at, superseded_by)
       VALUES (?, ?, ?, 'active', 'r2', ?, ?, ?, ?, NULL)
       ON CONFLICT(pack_key) DO NOTHING`,
      packKey, this.nextPackSeq(), kind, count, packBytes, idxBytes, Date.now()
    );
    this.backend.set(packKey, "r2");
    this.r2KeyOverrides.delete(packKey);
  }

  // ---- invariants catalog read ----------------------------------------------
  // The Worker invariants checker's listPackCatalog RPC is the only consumer.
  // Unlike the fork replication's active-only pages above, this read spans
  // EVERY lifecycle state: the checker must SEE superseded/reclaimable rows
  // to leave their (possibly already-deleted) objects unflagged.

  /** Keyset page of catalog rows in pack_key order (the primary key), every
   * state included. `afterPackKey` null starts the listing. */
  catalogPage(afterPackKey: string | null, limit: number): PackCatalogRow[] {
    this.assertOpen();
    return this.sql
      .exec<{
        pack_key: string; seq: number; kind: string; state: string; location: string;
        object_count: number; pack_bytes: number; idx_bytes: number; created_at: number;
        superseded_by: string | null;
      }>(
        `SELECT pack_key, seq, kind, state, location, object_count, pack_bytes, idx_bytes, created_at, superseded_by
           FROM pack_catalog
          WHERE pack_key > ?
          ORDER BY pack_key
          LIMIT ?`,
        afterPackKey ?? "",
        limit
      )
      .toArray()
      .map((r) => ({
        packKey: r.pack_key,
        seq: r.seq,
        kind: r.kind,
        state: r.state as PackState,
        location: r.location === "sqlite" ? "sqlite" : "r2",
        objectCount: r.object_count,
        packBytes: r.pack_bytes,
        idxBytes: r.idx_bytes,
        createdAt: r.created_at,
        supersededBy: r.superseded_by,
      }));
  }
}


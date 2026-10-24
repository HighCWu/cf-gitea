import pako from "pako";
import { ObjType } from "./objects";
import { applyDelta } from "./pack";
import type { IndexRow, LookupObjectHit, LookupObjectResult } from "../control-plane";
import { ObjCache, ObjRec } from "../receive/objcache";

export const PACK_CHUNK = 1024 * 1024;
/** Size threshold from SPEC-0001 §3/§8: packs at least this large exist only in
 * R2; smaller packs MAY live in DO SQLite (pack_data) for latency — the Step 4
 * pack_catalog location column carries that decision. Since Step 1 every
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
  packId: number;
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
 * Pack-native object database: received packfiles are stored verbatim — since
 * SPEC-0001a §3 the Worker stages them straight into R2, SCANS them, and
 * pushes the resulting index rows here (`putIndexRows`); the DO never reads
 * pack bytes on the receive path (pack_meta.r2_key records
 * `repos/<storage_key>/packs/<name>.pack`; legacy packs under
 * `raw/<repo>/<packId>`), else in SQLite chunk rows (the fallback / celld
 * path). Only the index ever lives in SQLite for an R2-backed pack, so pack
 * data escapes the per-DO storage ceiling. This is what lets large repos fit
 * and stream.
 */
export class PackStore {
  /** LRU of decoded pack chunks, keyed "packId:seq" (SQLite row or R2 range). */
  private chunks = new Map<string, Uint8Array>();
  /**
   * R2 raw-pack backend for this repo, or null when no bucket is bound (celld /
   * Workers without the binding). Received packs store their bytes in R2 and
   * keep only the index in SQLite; pre-existing SQLite packs keep working
   * (backend is recorded per pack).
   */
  private r2: { bucket: R2Bucket; repo: string } | null = null;
  /** Cached backend ('sql' | 'r2') per pack id, from pack_meta.store. */
  private backend = new Map<number, "sql" | "r2">();
  /** Cached R2 object key per pack id, from pack_meta.r2_key (receive packs
   * live at repos/<storage_key>/packs/<name>.pack per SPEC-0001 §3; legacy
   * packs fall back to rawKey). */
  private r2Keys = new Map<number, string>();

  constructor(private sql: SqlStorage, private extern: ExternalResolver) {
    this.init();
  }

  /** Bind (or clear) the R2 backend. Idempotent; the DO is per-repo so this is
   * set on each request from the repo name. */
  setR2(bucket: R2Bucket | undefined, repo: string): void {
    this.r2 = bucket ? { bucket, repo } : null;
  }

  private rawKey(packId: number): string {
    return `raw/${this.r2!.repo}/${packId}`;
  }

  /** The R2 object key holding a pack's bytes. `recordPack` primes the cache
   * before pack_meta exists; recorded keys (receive packs) win over the legacy
   * raw/<repo>/<packId> derivation. */
  r2KeyOf(packId: number): string {
    const cached = this.r2Keys.get(packId);
    if (cached) return cached;
    const rows = this.sql
      .exec<{ r2_key: string | null }>("SELECT r2_key FROM pack_meta WHERE pack_id = ?", packId)
      .toArray();
    const key = rows[0]?.r2_key || this.rawKey(packId);
    this.r2Keys.set(packId, key);
    return key;
  }

  /** Storage backend of a pack. Cached; falls back to a pack_meta lookup. */
  private backendOf(packId: number): "sql" | "r2" {
    const hit = this.backend.get(packId);
    if (hit) return hit;
    const rows = this.sql
      .exec<{ store: string }>("SELECT store FROM pack_meta WHERE pack_id = ?", packId)
      .toArray();
    const b = rows[0]?.store === "r2" ? "r2" : "sql";
    this.backend.set(packId, b);
    return b;
  }

  private init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pack_meta (
        pack_id INTEGER PRIMARY KEY,
        size INTEGER NOT NULL,
        count INTEGER NOT NULL,
        created INTEGER NOT NULL,
        store TEXT NOT NULL DEFAULT 'sql'
      );
      CREATE TABLE IF NOT EXISTS pack_data (
        pack_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (pack_id, seq)
      );
      CREATE TABLE IF NOT EXISTS pack_objects (
        oid TEXT PRIMARY KEY,
        pack_id INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        data_off INTEGER NOT NULL,
        data_len INTEGER NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        entry_size INTEGER NOT NULL,
        base_oid TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pack_objects_loc ON pack_objects(pack_id, offset);
    `);
    // back-fill the store column on repos whose pack_meta predates the R2 backend:
    // every such pack is SQLite-backed, which the 'sql' default records
    const cols = this.sql.exec<{ name: string }>("PRAGMA table_info(pack_meta)").toArray();
    if (!cols.some((c) => c.name === "store")) {
      this.sql.exec("ALTER TABLE pack_meta ADD COLUMN store TEXT NOT NULL DEFAULT 'sql'");
    }
    // back-fill the R2 key column (SPEC-0001a §3 Step 1): receive packs record
    // their repos/<storage_key>/packs/<name> object; legacy rows are null and
    // resolve through rawKey
    if (!cols.some((c) => c.name === "r2_key")) {
      this.sql.exec("ALTER TABLE pack_meta ADD COLUMN r2_key TEXT");
    }
    // back-fill the idx CRC column (SPEC-0001a §3 Step 2): the Worker scan
    // supplies per-entry CRC-32 for idx v2; rows written before Step 2 are 0
    const objCols = this.sql.exec<{ name: string }>("PRAGMA table_info(pack_objects)").toArray();
    if (!objCols.some((c) => c.name === "crc32")) {
      this.sql.exec("ALTER TABLE pack_objects ADD COLUMN crc32 INTEGER NOT NULL DEFAULT 0");
    }
  }

  wipe(): void {
    for (const t of ["pack_meta", "pack_data", "pack_objects"]) {
      this.sql.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    this.chunks.clear(); // pack ids restart from 1: cached rows would be stale
    this.backend.clear();
    this.r2Keys.clear();
  }

  /** Drop all packs and start empty (small-repo gc migrates objects out first). */
  reset(): void {
    this.wipe();
    this.init();
  }

  /** Pack ids of the currently R2-backed packs (for GC to delete their R2 bytes). */
  r2PackIds(): number[] {
    return this.sql
      .exec<{ pack_id: number }>("SELECT pack_id FROM pack_meta WHERE store = 'r2'")
      .toArray()
      .map((r) => r.pack_id);
  }

  /** Delete the R2 raw objects for the given pack ids (no-op without a binding). */
  async deleteR2Packs(packIds: number[]): Promise<void> {
    if (!this.r2 || !packIds.length) return;
    const keys = packIds.map((id) => this.r2KeyOf(id));
    for (let i = 0; i < keys.length; i += 100) {
      try {
        await this.r2.bucket.delete(keys.slice(i, i + 100));
      } catch {
        // best effort: an undeleted raw object is unreferenced garbage
      }
    }
  }

  countObjects(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pack_objects").one().n;
  }

  /** Total stored bytes across all indexed packs (0 when pack-empty). */
  totalPackBytes(): number {
    return this.sql.exec<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM pack_meta").one().n;
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
    const rows = this.sql
      .exec<{
        pack_id: number; offset: number; data_off: number; data_len: number;
        type: ObjType; size: number; entry_size: number; base_oid: string | null;
      }>(
        "SELECT pack_id, offset, data_off, data_len, type, size, entry_size, base_oid FROM pack_objects WHERE oid = ?",
        oid
      )
      .toArray();
    const r = rows[0];
    if (!r) return null;
    return {
      oid, packId: r.pack_id, offset: r.offset, dataOff: r.data_off, dataLen: r.data_len,
      type: r.type, size: r.size, entrySize: r.entry_size, baseOid: r.base_oid,
    };
  }

  typeAndSize(oid: string): { type: ObjType; size: number } | null {
    const rows = this.sql
      .exec<{ type: ObjType; size: number }>("SELECT type, size FROM pack_objects WHERE oid = ?", oid)
      .toArray();
    return rows[0] ?? null;
  }

  /** Distinct delta-base oids: a second reference edge gc must not sever. */
  baseOids(): string[] {
    return this.sql
      .exec<{ base_oid: string }>("SELECT DISTINCT base_oid FROM pack_objects WHERE base_oid IS NOT NULL")
      .toArray()
      .map((r) => r.base_oid);
  }

  findOidPrefix(prefix: string): string[] {
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
  async readRaw(packId: number, off: number, len: number): Promise<Uint8Array> {
    const first = Math.floor(off / PACK_CHUNK);
    const last = Math.floor((off + len - 1) / PACK_CHUNK);
    const out = new Uint8Array(len);
    for (let seq = first; seq <= last; seq++) {
      const chunk = await this.chunk(packId, seq);
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
  private async chunk(packId: number, seq: number): Promise<Uint8Array> {
    const key = `${packId}:${seq}`;
    const hit = this.chunks.get(key);
    if (hit) {
      this.chunks.delete(key); // reinsert: most-recently-used goes last
      this.chunks.set(key, hit);
      return hit;
    }
    let chunk: Uint8Array;
    if (this.backendOf(packId) === "r2") {
      if (!this.r2) throw new Error(`pack ${packId}: R2 backend not bound`);
      const key = this.r2KeyOf(packId);
      const obj = await this.r2.bucket.get(key, {
        range: { offset: seq * PACK_CHUNK, length: PACK_CHUNK },
      });
      if (!obj) throw new Error(`pack ${packId}: missing R2 object ${key}`);
      chunk = new Uint8Array(await obj.arrayBuffer());
    } else {
      const rows = this.sql
        .exec<{ data: ArrayBuffer }>(
          "SELECT data FROM pack_data WHERE pack_id = ? AND seq = ?",
          packId,
          seq
        )
        .toArray();
      if (!rows.length) throw new Error(`pack ${packId}: missing chunk ${seq}`);
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
        base = { type: cur.type, data: inflateAll(await this.readRaw(cur.packId, cur.dataOff, cur.dataLen)) };
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
      const delta = inflateAll(await this.readRaw(d.packId, d.dataOff, d.dataLen));
      obj = { type: base.type, data: applyDelta(obj.data, delta) };
      cache.put(d.oid, obj);
    }
    if (!chain.length) cache.put(oid, obj);
    return obj;
  }

  // ---- Worker-pushed index rows (SPEC-0001a §3 Step 2) ----------------------
  //
  // The Worker scans and resolves the pack; only these control-plane writes
  // remain. Rows land BEFORE finalize; pack_meta is recorded by finalize's
  // commit transaction, so rows without a pack_meta entry are crash debris the
  // sweeps reclaim — the same story the DO-side ingest had.

  /** Next free pack id (allocation is lease-serialized: one receive lease). */
  nextPackId(): number {
    return (this.sql.exec<{ m: number | null }>("SELECT MAX(pack_id) AS m FROM pack_meta").one().m ?? 0) + 1;
  }

  /** Batched insert of Worker-resolved rows. `INSERT OR IGNORE` keeps a
   * duplicate oid's FIRST location — including within one batch. */
  putRows(packId: number, rows: IndexRow[]): void {
    for (let i = 0; i < rows.length; i += ROW_BATCH_ROWS) {
      const slice = rows.slice(i, i + ROW_BATCH_ROWS);
      const values = slice.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",");
      const args: (string | number | null)[] = [];
      for (const r of slice) {
        args.push(r.oid, packId, r.offset, r.dataOff, r.dataLen, r.type, r.size, r.entrySize, r.baseOid, r.crc32);
      }
      this.sql.exec(
        `INSERT OR IGNORE INTO pack_objects (oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid, crc32) VALUES ${values}`,
        ...args
      );
    }
    // the freshly written rows are readable through the same connection; the
    // per-pack caches only hold chunk/key/backend state, which is unaffected
  }

  /** Prime the per-pack backend caches BEFORE pack_meta exists: rows land via
   * putIndexRows while the pack bytes are still the Worker's staging object,
   * and DO-side reads over those rows (isAncestor's ancestry walk) must hit
   * the right R2 key, not fall back to the 'sql' backend. recordPack re-primes
   * to the final packs/ key; the bytes are identical, so cached chunks stay
   * valid across the re-point. */
  primePack(packId: number, r2Key: string): void {
    this.backend.set(packId, "r2");
    this.r2Keys.set(packId, r2Key);
  }

  /** Record the pack catalog row (finalize's commit transaction). The count is
   * the actual indexed-row count, not the pack header's declaration. */
  recordPack(packId: number, sizeBytes: number, r2Key: string): void {
    const count = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM pack_objects WHERE pack_id = ?", packId)
      .one().n;
    this.sql.exec(
      "INSERT INTO pack_meta (pack_id, size, count, created, store, r2_key) VALUES (?, ?, ?, ?, 'r2', ?)",
      packId, sizeBytes, count, Date.now(), r2Key
    );
    this.primePack(packId, r2Key);
  }

  /** Delete every index/data row of one pack id (lease sweeps, abandoned
   * receives). Cache state is cleared because ids can be reallocated. */
  sweepPackRows(packId: number): void {
    this.sql.exec("DELETE FROM pack_objects WHERE pack_id = ?", packId);
    this.sql.exec("DELETE FROM pack_data WHERE pack_id = ?", packId);
    this.chunks.clear();
    this.backend.delete(packId);
    this.r2Keys.delete(packId);
  }

  /** Reclaim rows whose pack id never reached pack_meta — the debris of a
   * receive that died between putIndexRows and finalize. `keepPackId` (the
   * current lease's pack, still being written) is preserved. */
  sweepOrphanRows(keepPackId: number | null): void {
    const orphans = this.sql
      .exec<{ pack_id: number }>(
        `SELECT pack_id FROM (
           SELECT DISTINCT pack_id FROM pack_data WHERE pack_id NOT IN (SELECT pack_id FROM pack_meta)
           UNION
           SELECT DISTINCT pack_id FROM pack_objects WHERE pack_id NOT IN (SELECT pack_id FROM pack_meta)
         ) WHERE pack_id != ?`,
        keepPackId ?? -1
      )
      .toArray()
      .map((r) => r.pack_id);
    for (const id of orphans) this.sweepPackRows(id);
  }

  /**
   * Resolve oids against the pack index for the Worker (lookupObjects RPC):
   * aligned with the input, null where the object is not packed (the caller
   * falls back to loose storage). One indexed probe per oid — workerd's SQLite
   * rejects multi-placeholder IN lists, and a batch is bounded by the RPC's
   * 512-oid cap anyway, so flat per-oid probes stay microseconds each. The R2
   * key resolves through the per-pack cache.
   */
  lookupPacked(oids: string[]): (LookupObjectHit | null)[] {
    return oids.map((oid) => {
      const rows = this.sql
        .exec<{
          pack_id: number; offset: number; data_off: number; data_len: number;
          type: ObjType; base_oid: string | null;
        }>(
          "SELECT pack_id, offset, data_off, data_len, type, base_oid FROM pack_objects WHERE oid = ?",
          oid
        )
        .toArray();
      const r = rows[0];
      if (!r) return null;
      return {
        found: true,
        packKey: this.r2KeyOf(r.pack_id),
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
  packOidsAfter(packId: number, after: string, limit: number): string[] {
    return this.sql
      .exec<{ oid: string }>(
        "SELECT oid FROM pack_objects WHERE pack_id = ? AND oid > ? ORDER BY oid LIMIT ?",
        packId, after, limit
      )
      .toArray()
      .map((r) => r.oid);
  }
}

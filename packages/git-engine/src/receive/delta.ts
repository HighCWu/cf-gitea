/**
 * Receive pass 2 (SPEC-0001a §3 Step 2): delta resolution + index rows +
 * connectivity anti-check.
 *
 * Driven by the scanner's single streaming walk (receive/scan.ts): git clients
 * always write a delta after its base, so the overwhelming majority of
 * REF_DELTA/ofs-delta entries resolve EAGERLY in file order — base content
 * comes from a byte-budgeted LRU (ObjCache) with zero extra I/O. Entries whose
 * base is not yet resolved (forward references, huge delta streams) land in a
 * straggler pool that a fixpoint loop drains afterwards; their bytes are
 * re-read with bounded R2 range GETs. Bases outside the pack (thin pushes)
 * resolve through batched `lookupObjects` RPCs — the anti-check replacing the
 * old `push_edges` SQL — and foreign pack entries are materialized by reading
 * their stored bytes from R2 directly.
 *
 * Every resolved object streams an IndexRow to the DO (`putIndexRows`) in
 * bounded batches, and every non-blob object's referenced children are
 * anti-checked against the pack's own oid set plus the object database — the
 * Worker-side equivalent of the `packComplete` check that used to run on SQL
 * scratch tables. Chain walks are iterative with a seen-set (cycle detection)
 * and a depth cap; range reads and lookup batches run under budgets so a
 * crafted pack cannot blow the subrequest limit silently.
 */
import { applyDelta } from "../git/pack";
import {
  ObjType,
  TYPE_NUM,
  NUM_TYPE,
  parseCommit,
  parseTag,
  parseTree,
  isGitlinkMode,
} from "../git/objects";
import { OidSet } from "../git/oidset";
import type { IndexRow } from "../control-plane";
import { ObjCache, ObjRec } from "./objcache";
import { hashObjectAsync, inflateAll, type DeltaEntry, type FullEntry, type PackEntry } from "./scan";

/**
 * full entries up to this size are kept as delta-base candidates — they are
 * likely bases. (Same constant the DO's ingest used; the ObjCache budget
 * bounds total memory, this bounds one object's share of it.)
 */
export const CACHE_ENTRY_LIMIT = (typeof caches !== "undefined" ? 2 : 4) * 1024 * 1024;
/**
 * Hard cap on delta base-chain length when resolving an object. git's default
 * pack depth is 50; 50000 leaves enormous headroom for legitimately deep packs
 * while a crafted unbounded chain is rejected instead of looping forever. The
 * base walk is iterative and separately cycle-checked via a seen-set.
 */
const MAX_DELTA_DEPTH = 50000;
/**
 * A non-blob full entry bigger than this cannot be parsed for connectivity
 * within safe memory; the push is rejected as unverifiable instead of
 * admitting a ref whose closure was never checked. (A tree this large would
 * hold millions of entries in one object — not produced by git.)
 */
const FULL_REREAD_CAP = 256 * 1024 * 1024;
/** lookupObjects / anti-check batch size (oids per RPC) */
const LOOKUP_BATCH = 512;
/** Default R2 range GETs the straggler/foreign resolution may spend. */
export const RANGE_BUDGET = 256;
/** IndexRows buffered per putIndexRows RPC */
const ROW_BATCH = 4096;

/** One `lookupObjects` hit (mirrors the control-plane shape). */
export interface ForeignObject {
  found: true;
  packKey: string;
  offset: number;
  dataOff: number;
  dataLen: number;
  type: ObjType;
  baseOid: string | null;
  /** loose objects carry their content; packed hits are R2-read by the Worker */
  data?: Uint8Array;
}

export interface DeltaHost {
  /** the R2 key range reads hit for this pack's own bytes (the staging object) */
  selfPackKey: string;
  lookupObjects(oids: string[]): Promise<(ForeignObject | { found: false })[]>;
  readEntryBytes(packKey: string, off: number, len: number): Promise<Uint8Array>;
  putRows(rows: IndexRow[]): Promise<{ tag: "ok" } | { tag: "lease_mismatch" }>;
  onLookup?(oids: number): void;
  onRangeGet?(): void;
}

export interface ResolverOptions {
  /** ObjCache budget in bytes (env INGEST_CACHE_MB) */
  cacheBytes: number;
  /** R2 range GETs the straggler/foreign resolution may spend (default RANGE_BUDGET) */
  rangeBudget?: number;
  /** screen every object with SHA-1DC (env SHA1DC === "1") */
  collisionDetect?: boolean;
  onProgress?: (msg: string) => void;
}

export interface ResolveResult {
  /** every object oid of the pack, in resolution order (idx emission input) */
  oids: OidSet;
  /** resolution-order index -> entry index (idx emission input) */
  oidEntry: number[];
  /** CRC-32 per entry (idx emission input) */
  entryCrcs: Uint32Array;
  /** pack offset per entry (idx emission input) */
  entryOffsets: Float64Array;
  /** true when the connectivity anti-check found a referenced object missing */
  incomplete: boolean;
  /** the first missing child oid, when incomplete */
  firstMissing: string | null;
  /** unique objects resolved (= oids.size) */
  objects: number;
}

export class DeltaResolver {
  /** oids in RESOLUTION order — the idx's emission set */
  oids: OidSet;
  incomplete = false;
  firstMissing: string | null = null;
  /** IndexRows emitted so far */
  rowsEmitted = 0;

  private host: DeltaHost;
  private opts: ResolverOptions;
  private cache: ObjCache;

  // per-entry arrays, sized once at init(count); only resolved entries have
  // type/base set (0/null = unresolved)
  private entryOid = new Int32Array(0);
  private entryType = new Uint8Array(0);
  private entryBase: (string | null)[] = [];
  private entryDataOff = new Float64Array(0);
  private entryDataLen = new Float64Array(0);
  private entryCrcs = new Uint32Array(0);
  private entryOffsets = new Float64Array(0);
  private offsets = new Float64Array(0);
  private nextEntry = 0;
  /** resolution-order index -> entry index */
  private oidEntry: number[] = [];

  private stragglers: DeltaEntry[] = [];
  private externals = new Set<string>();
  private unparsedFulls: FullEntry[] = [];
  /** every oid the pack's non-blob objects reference (dedup set) */
  private childSet: OidSet | null = null;

  private rowBuf: IndexRow[] = [];
  private rowWrites: Promise<void> = Promise.resolve();
  private rangeGets = 0;

  constructor(host: DeltaHost, opts: ResolverOptions) {
    this.host = host;
    this.opts = opts;
    this.cache = new ObjCache(opts.cacheBytes);
    this.oids = new OidSet(4096);
  }

  /** Called by the walk once the pack header is parsed; sizes the per-entry arrays. */
  init(count: number): void {
    this.entryOid = new Int32Array(count).fill(-1);
    this.entryType = new Uint8Array(count);
    this.entryBase = new Array(count).fill(null);
    this.entryDataOff = new Float64Array(count);
    this.entryDataLen = new Float64Array(count);
    this.entryCrcs = new Uint32Array(count);
    this.entryOffsets = new Float64Array(count);
    this.offsets = new Float64Array(count);
    this.oids = new OidSet(Math.max(count, 4096));
  }

  /** The scanner's per-entry visitor. */
  async onEntry(entry: PackEntry): Promise<void> {
    const i = entry.index;
    this.entryCrcs[i] = entry.crc32;
    this.entryOffsets[i] = entry.offset;
    this.entryDataOff[i] = entry.dataOff;
    this.entryDataLen[i] = entry.dataLen;
    this.offsets[i] = entry.offset;
    this.nextEntry = i + 1;
    if (entry.kind === "full") await this.onFull(entry);
    else await this.onDelta(entry);
  }

  private async onFull(entry: FullEntry): Promise<void> {
    this.registerOid(entry.oid, entry.index, TYPE_NUM[entry.objType], null);
    this.putRow({
      oid: entry.oid,
      offset: entry.offset,
      dataOff: entry.dataOff,
      dataLen: entry.dataLen,
      type: entry.objType,
      size: entry.entrySize,
      entrySize: entry.entrySize,
      baseOid: null,
      crc32: entry.crc32,
    });
    if (entry.content && entry.content.length <= CACHE_ENTRY_LIMIT) {
      this.cache.put(entry.oid, { type: entry.objType, data: entry.content });
    }
    if (entry.objType !== "blob") {
      // blobs are leaves; non-blob objects feed the connectivity anti-check.
      // Anything too big to hand over buffered is re-read (bounded) in finish().
      if (entry.content) this.noteChildren(entry.objType, entry.content, entry.oid);
      else this.unparsedFulls.push(entry);
    }
  }

  private async onDelta(entry: DeltaEntry): Promise<void> {
    if (entry.refBase !== null) {
      if (this.oids.hasHex(entry.refBase)) {
        await this.tryResolve(entry);
      } else {
        // external (thin-pack) base: batch-lookup after the walk
        this.externals.add(entry.refBase);
        this.stragglers.push(entry);
      }
      return;
    }
    const baseIdx = this.entryAtOffset(entry.ofsBase);
    if (baseIdx < 0) {
      throw new Error(`delta base offset ${entry.ofsBase} does not point at an entry`);
    }
    if (this.entryOid[baseIdx] < 0) {
      // the base is an earlier delta that did not resolve eagerly: fixpoint
      this.stragglers.push(entry);
      return;
    }
    await this.tryResolve(entry);
  }

  /**
   * Resolve one delta entry against its base (cache hit, in-pack chain walk
   * over range GETs, or an external base materialized in finish()). Returns
   * false when the base is not available yet.
   */
  private async tryResolve(entry: DeltaEntry): Promise<boolean> {
    let baseHex: string;
    let base: ObjRec | undefined;
    if (entry.refBase !== null) {
      if (this.oids.hasHex(entry.refBase)) {
        baseHex = entry.refBase; // in-pack base
      } else {
        // external (thin-pack) base: finish() batch-looked it up and cached
        // the materialized content; until then this entry stays a straggler
        base = this.cache.get(entry.refBase);
        if (!base) return false;
        baseHex = entry.refBase;
      }
    } else {
      const baseIdx = this.entryAtOffset(entry.ofsBase);
      const oidIdx = baseIdx >= 0 ? this.entryOid[baseIdx] : -1;
      if (oidIdx < 0) return false; // base itself unresolved
      baseHex = this.oids.atHex(oidIdx);
    }
    if (!base) {
      base = this.cache.get(baseHex);
      if (!base) {
        const bIdx = this.oids.indexOfHex(baseHex);
        if (bIdx < 0) return false;
        base = await this.materialize(this.oidEntry[bIdx]);
      }
    }
    const raw = entry.data ?? inflateAll(await this.rangeRead(entry.dataOff, entry.dataLen));
    await this.applyEntry(entry, baseHex, base, raw);
    return true;
  }

  private async applyEntry(entry: DeltaEntry, baseHex: string, base: ObjRec, raw: Uint8Array): Promise<void> {
    const data = applyDelta(base.data, raw);
    const oid = await hashObjectAsync(base.type, data, this.opts.collisionDetect ?? false);
    this.registerOid(oid, entry.index, TYPE_NUM[base.type], baseHex);
    this.putRow({
      oid,
      offset: entry.offset,
      dataOff: entry.dataOff,
      dataLen: entry.dataLen,
      type: base.type,
      size: data.length,
      entrySize: entry.entrySize,
      baseOid: baseHex,
      crc32: entry.crc32,
    });
    if (data.length <= CACHE_ENTRY_LIMIT) this.cache.put(oid, { type: base.type, data });
    this.noteChildren(base.type, data, oid);
    if (this.opts.onProgress && this.rowsEmitted % 100000 === 0) {
      this.opts.onProgress(`Resolving deltas: ${this.rowsEmitted}\n`);
    }
  }

  private registerOid(oid: string, entryIdx: number, typeNum: number, baseHex: string | null): void {
    if (!this.oids.addHex(oid)) throw new Error(`duplicate object in pack: ${oid}`);
    this.entryOid[entryIdx] = this.oids.indexOfHex(oid);
    this.entryType[entryIdx] = typeNum;
    this.entryBase[entryIdx] = baseHex;
    this.oidEntry.push(entryIdx);
  }

  /** Entry index whose pack offset is `off`, or -1 (offsets are strictly ascending). */
  private entryAtOffset(off: number): number {
    let lo = 0;
    let hi = this.nextEntry - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.offsets[mid];
      if (v === off) return mid;
      if (v < off) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private oidHexOfEntry(entryIdx: number): string {
    return this.oids.atHex(this.entryOid[entryIdx]);
  }

  /**
   * Inflate + delta-resolve an in-pack entry whose content left the cache.
   * The base chain is walked ITERATIVELY through the in-memory index —
   * bounding chain length and detecting cycles before any delta is inflated —
   * then applied from the base upward, caching along the way so repeated
   * misses stay cheap. Missing bytes are fetched with budgeted range GETs.
   */
  private async materialize(entryIdx: number): Promise<ObjRec> {
    const chain: number[] = [];
    const seen = new Set<number>();
    let cur = entryIdx;
    let base: ObjRec;
    for (;;) {
      if (seen.has(cur)) throw new Error(`cyclic delta chain at ${this.oidHexOfEntry(cur)}`);
      seen.add(cur);
      const cached = this.cache.get(this.oidHexOfEntry(cur));
      if (cached) {
        base = cached;
        break;
      }
      const typeNum = this.entryType[cur];
      if (typeNum === 0) throw new Error(`unresolved delta base ${this.oidHexOfEntry(cur)}`);
      if (!this.entryBase[cur]) {
        // full entry: its compressed region inflates straight to content
        const data = inflateAll(await this.rangeRead(this.entryDataOff[cur], this.entryDataLen[cur]));
        base = { type: this.numToType(typeNum), data };
        this.cache.put(this.oidHexOfEntry(cur), base);
        break;
      }
      if (chain.length >= MAX_DELTA_DEPTH) {
        throw new Error(`delta chain exceeds depth ${MAX_DELTA_DEPTH} at ${this.oidHexOfEntry(cur)}`);
      }
      chain.push(cur);
      const bHex = this.entryBase[cur]!;
      const bIdx = this.oids.indexOfHex(bHex);
      if (bIdx < 0) throw new Error(`missing delta base ${bHex}`);
      cur = this.oidEntry[bIdx];
    }
    let obj = base;
    for (let i = chain.length - 1; i >= 0; i--) {
      const d = chain[i];
      const delta = inflateAll(await this.rangeRead(this.entryDataOff[d], this.entryDataLen[d]));
      obj = { type: base.type, data: applyDelta(obj.data, delta) };
      this.cache.put(this.oidHexOfEntry(d), obj);
    }
    return obj;
  }

  private numToType(num: number): ObjType {
    return NUM_TYPE[num] ?? "blob";
  }

  /**
   * Materialize a foreign (cross-pack or loose) base object. Packed entries
   * chain through further `lookupObjects` hits — iterative, cycle-checked,
   * depth-capped — and their stored bytes are read from R2 by the Worker.
   */
  private async materializeForeign(hit: ForeignObject): Promise<ObjRec> {
    const chain: ForeignObject[] = [];
    const seen = new Set<string>();
    let cur = hit;
    let base: ObjRec;
    for (;;) {
      const key = `${cur.packKey}@${cur.offset}`;
      if (seen.has(key)) throw new Error("cyclic delta chain across packs");
      seen.add(key);
      if (chain.length >= MAX_DELTA_DEPTH) {
        throw new Error(`delta chain exceeds depth ${MAX_DELTA_DEPTH} across packs`);
      }
      if (cur.data) {
        // loose hit: the DO shipped the content inline
        base = { type: cur.type, data: cur.data };
        break;
      }
      if (!cur.baseOid) {
        base = { type: cur.type, data: inflateAll(await this.readForeign(cur)) };
        break;
      }
      chain.push(cur);
      const next = await this.lookupOne(cur.baseOid);
      if (!next.found) throw new Error(`missing delta base ${cur.baseOid}`);
      cur = next;
    }
    let obj = base;
    for (let i = chain.length - 1; i >= 0; i--) {
      const delta = inflateAll(await this.readForeign(chain[i]));
      obj = { type: base.type, data: applyDelta(obj.data, delta) };
    }
    return obj;
  }

  private async lookupOne(oid: string): Promise<ForeignObject | { found: false }> {
    this.host.onLookup?.(1);
    const res = await this.host.lookupObjects([oid]);
    return res[0];
  }

  private async readForeign(hit: ForeignObject): Promise<Uint8Array> {
    if (hit.data) return hit.data;
    this.host.onRangeGet?.();
    return this.host.readEntryBytes(hit.packKey, hit.dataOff, hit.dataLen);
  }

  /** Budgeted range read of this pack's own stored bytes (the staging object). */
  private async rangeRead(off: number, len: number): Promise<Uint8Array> {
    if (++this.rangeGets > (this.opts.rangeBudget ?? RANGE_BUDGET)) {
      throw new Error("delta resolution exceeded its range-read budget");
    }
    this.host.onRangeGet?.();
    return this.host.readEntryBytes(this.host.selfPackKey, off, len);
  }

  // ---- connectivity anti-check --------------------------------------------

  /**
   * Record the oids a resolved non-blob object references. Children are
   * anti-checked at finish(): membership in the pack's own oid set is free,
   * everything else goes out in batched lookupObjects calls. Parse failures
   * mark the pack unverifiable — a ref must never commit past an object whose
   * closure could not be checked.
   */
  private noteChildren(type: ObjType, data: Uint8Array, owner: string): void {
    let refs: string[];
    try {
      refs = referencedOids(type, data);
    } catch {
      if (!this.incomplete) {
        this.incomplete = true;
        this.firstMissing = owner;
      }
      return;
    }
    if (!refs.length) return;
    if (!this.childSet) this.childSet = new OidSet(4096);
    for (const r of refs) this.childSet.addHex(r);
  }

  private async flushChildren(): Promise<void> {
    if (this.incomplete || !this.childSet) return;
    const survivors: string[] = [];
    for (let i = 0; i < this.childSet.size; i++) {
      const oid = this.childSet.atHex(i);
      if (!this.oids.hasHex(oid)) survivors.push(oid);
    }
    for (let i = 0; i < survivors.length; i += LOOKUP_BATCH) {
      const batch = survivors.slice(i, i + LOOKUP_BATCH);
      this.host.onLookup?.(batch.length);
      const res = await this.host.lookupObjects(batch);
      for (let j = 0; j < batch.length; j++) {
        if (!res[j].found) {
          this.incomplete = true;
          this.firstMissing = batch[j];
          return;
        }
      }
    }
  }

  // ---- row batching ---------------------------------------------------------

  private putRow(row: IndexRow): void {
    this.rowBuf.push(row);
    this.rowsEmitted++;
    if (this.rowBuf.length >= ROW_BATCH) this.flushRows();
  }

  /** Chained so rows cross the RPC boundary strictly in emission order. */
  private flushRows(): void {
    if (!this.rowBuf.length) return;
    const rows = this.rowBuf;
    this.rowBuf = [];
    this.rowWrites = this.rowWrites.then(async () => {
      const res = await this.host.putRows(rows);
      if (res.tag === "lease_mismatch") throw new Error("receive lease lost during indexing");
    });
  }

  // ---- fixpoint -------------------------------------------------------------

  /**
   * Finish the resolution: re-read the huge non-blob fulls for connectivity,
   * batch-lookup external (thin) bases, then drain the straggler pool to a
   * fixpoint. Throws with the historical wording when deltas remain
   * unresolvable; returns the idx/connectivity inputs otherwise.
   */
  async finish(): Promise<ResolveResult> {
    for (const f of this.unparsedFulls) {
      if (this.incomplete) break;
      if (f.objType === "blob") continue;
      if (f.entrySize > FULL_REREAD_CAP) {
        this.incomplete = true;
        this.firstMissing ??= f.oid;
        continue;
      }
      const data = inflateAll(await this.rangeRead(f.dataOff, f.dataLen));
      this.noteChildren(f.objType, data, f.oid);
    }

    if (this.externals.size) {
      const wanted = [...this.externals];
      for (let i = 0; i < wanted.length; i += LOOKUP_BATCH) {
        const batch = wanted.slice(i, i + LOOKUP_BATCH);
        this.host.onLookup?.(batch.length);
        const res = await this.host.lookupObjects(batch);
        for (let j = 0; j < batch.length; j++) {
          const hit = res[j];
          if (!hit.found) continue; // unfound externals fail the straggler below
          let rec: ObjRec | null = null;
          if (hit.data) rec = { type: hit.type, data: hit.data };
          else if (hit.packKey) rec = await this.materializeForeign(hit);
          if (rec) this.cache.put(batch[j], rec);
        }
      }
      this.externals.clear();
    }

    let pending = this.stragglers;
    this.stragglers = [];
    while (pending.length) {
      const still: DeltaEntry[] = [];
      for (const entry of pending) {
        if (!(await this.tryResolve(entry))) still.push(entry);
      }
      if (still.length === pending.length) {
        throw new Error(`cannot resolve ${still.length} delta object(s): missing base`);
      }
      pending = still;
    }

    await this.flushRows();
    await this.rowWrites;
    await this.flushChildren();
    return {
      oids: this.oids,
      oidEntry: this.oidEntry,
      entryCrcs: this.entryCrcs,
      entryOffsets: this.entryOffsets,
      incomplete: this.incomplete,
      firstMissing: this.firstMissing,
      objects: this.oids.size,
    };
  }
}

/** The child oids a non-blob object references (blobs are leaves). */
function referencedOids(type: ObjType, data: Uint8Array): string[] {
  if (type === "commit") {
    const c = parseCommit(data);
    return [c.tree, ...c.parents];
  }
  if (type === "tag") {
    const t = parseTag(data);
    return t.object ? [t.object] : [];
  }
  if (type === "tree") {
    const out: string[] = [];
    for (const e of parseTree(data)) if (!isGitlinkMode(e.mode)) out.push(e.oid);
    return out;
  }
  return [];
}

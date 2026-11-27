import { fromHex, toHex } from "../git/util";

/**
 * `.idx` v2 binary reader & cache (SPEC-0024 M4.2 / D1):
 * Parses standard Git pack index v2 (`\xfftOc` v2) from R2 without duplicating
 * pack_objects rows into DO SQLite, supporting 64-bit large offsets (`>= 2^31`).
 */
const IDX_MAGIC = 0xff744f63;
const IDX_HEADER_BYTES = 8 + 256 * 4;
const IDX_V2_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const UINT32_SPAN = 0x1_0000_0000;

export interface IdxV2Hit {
  index: number;
  offset: number;
  crc32: number;
}

export interface IdxV2PackHit extends IdxV2Hit {
  packKey: string;
}

export interface IdxV2View {
  objectCount: number;
  packSha1: string;
  idxSha1: string;
  byteLength: number;
  lookupOid(oidHex: string): IdxV2Hit | null;
  sortedOidAt(index: number): string;
  allSortedOids(): string[];
}

function compareOidBytes(table: Uint8Array, tableOff: number, needle: Uint8Array): number {
  for (let i = 0; i < 20; i++) {
    const a = table[tableOff + i]!;
    const b = needle[i]!;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** Parse and validate a standard Git `.idx` v2 buffer. */
export function parseIdxV2(bytes: Uint8Array): IdxV2View {
  if (bytes.byteLength < IDX_HEADER_BYTES + 40) {
    throw new Error(`idx v2: truncated buffer (${bytes.byteLength} bytes)`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, false);
  if (magic !== IDX_MAGIC) throw new Error(`idx v2: bad magic 0x${magic.toString(16)}`);
  const version = dv.getUint32(4, false);
  if (version !== 2) throw new Error(`idx v2: unsupported version ${version}`);

  let prevFanout = 0;
  for (let i = 0; i < 256; i++) {
    const c = dv.getUint32(8 + i * 4, false);
    if (c < prevFanout) throw new Error(`idx v2: non-monotonic fanout at bucket ${i}`);
    prevFanout = c;
  }
  const objectCount = prevFanout;
  const oidsOff = IDX_HEADER_BYTES;
  const crcsOff = oidsOff + objectCount * 20;
  const offsetsOff = crcsOff + objectCount * 4;
  const largeTableStart = offsetsOff + objectCount * 4;
  const minTotal = largeTableStart + 40;
  if (bytes.byteLength < minTotal) {
    throw new Error(`idx v2: truncated payload (${bytes.byteLength} < ${minTotal})`);
  }

  let maxLargeIdx = -1;
  for (let i = 0; i < objectCount; i++) {
    const w = dv.getUint32(offsetsOff + i * 4, false);
    if ((w & 0x80000000) !== 0) {
      const idx = w & 0x7fffffff;
      if (idx > maxLargeIdx) maxLargeIdx = idx;
    }
  }
  const expectedLargeCount = maxLargeIdx + 1;
  const trailerOff = bytes.byteLength - 40;
  const actualLargeBytes = trailerOff - largeTableStart;
  if (actualLargeBytes < expectedLargeCount * 8 || actualLargeBytes % 8 !== 0) {
    throw new Error(`idx v2: large offset table size mismatch (${actualLargeBytes})`);
  }

  const packSha1 = toHex(bytes.subarray(trailerOff, trailerOff + 20));
  const idxSha1 = toHex(bytes.subarray(trailerOff + 20, trailerOff + 40));

  const readOffset = (index: number): number => {
    const w = dv.getUint32(offsetsOff + index * 4, false);
    if ((w & 0x80000000) === 0) return w;
    const largeIdx = w & 0x7fffffff;
    const p = largeTableStart + largeIdx * 8;
    const hi = dv.getUint32(p, false);
    const lo = dv.getUint32(p + 4, false);
    return hi * UINT32_SPAN + lo;
  };

  return {
    objectCount,
    packSha1,
    idxSha1,
    byteLength: bytes.byteLength,
    lookupOid(oidHex: string): IdxV2Hit | null {
      if (oidHex.length !== 40) return null;
      const needle = fromHex(oidHex);
      const bucket = needle[0]!;
      let lo = bucket === 0 ? 0 : dv.getUint32(8 + (bucket - 1) * 4, false);
      let hi = dv.getUint32(8 + bucket * 4, false) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const cmp = compareOidBytes(bytes, oidsOff + mid * 20, needle);
        if (cmp === 0) {
          return {
            index: mid,
            offset: readOffset(mid),
            crc32: dv.getUint32(crcsOff + mid * 4, false),
          };
        }
        if (cmp < 0) lo = mid + 1;
        else hi = mid - 1;
      }
      return null;
    },
    sortedOidAt(index: number): string {
      if (index < 0 || index >= objectCount) throw new RangeError(`idx v2 index out of range: ${index}`);
      return toHex(bytes.subarray(oidsOff + index * 20, oidsOff + (index + 1) * 20));
    },
    allSortedOids(): string[] {
      const out = new Array<string>(objectCount);
      for (let i = 0; i < objectCount; i++) {
        out[i] = toHex(bytes.subarray(oidsOff + i * 20, oidsOff + (i + 1) * 20));
      }
      return out;
    },
  };
}

const idxCache = new Map<string, IdxV2View>();
let idxCacheBytes = 0;

function touchIdxCache(key: string, view: IdxV2View): void {
  const existing = idxCache.get(key);
  if (existing) {
    idxCache.delete(key);
    idxCacheBytes -= existing.byteLength;
  }
  if (view.byteLength > IDX_V2_CACHE_MAX_BYTES) return;
  idxCache.set(key, view);
  idxCacheBytes += view.byteLength;
  while (idxCacheBytes > IDX_V2_CACHE_MAX_BYTES) {
    const firstKey = idxCache.keys().next().value;
    if (!firstKey) break;
    const first = idxCache.get(firstKey);
    idxCache.delete(firstKey);
    idxCacheBytes -= first?.byteLength ?? 0;
  }
}

export function clearIdxV2Cache(): void {
  idxCache.clear();
  idxCacheBytes = 0;
}

/** Load and parse one `.idx` v2 object from R2 with bounded in-isolate LRU caching. */
export async function loadPackIdxV2(bucket: R2Bucket, idxKey: string): Promise<IdxV2View | null> {
  const hit = idxCache.get(idxKey);
  if (hit) {
    touchIdxCache(idxKey, hit);
    return hit;
  }
  const obj = await bucket.get(idxKey);
  if (!obj) return null;
  const view = parseIdxV2(new Uint8Array(await obj.arrayBuffer()));
  touchIdxCache(idxKey, view);
  return view;
}

/** Look up a set of OIDs across multiple pack `.idx` v2 sidecars in R2. */
export async function lookupOidsInPackIdxs(
  bucket: R2Bucket,
  packs: ReadonlyArray<{ packKey: string; idxKey: string }>,
  oids: readonly string[]
): Promise<Map<string, IdxV2PackHit>> {
  const result = new Map<string, IdxV2PackHit>();
  if (!packs.length || !oids.length) return result;
  const remaining = new Set(oids);
  for (const p of packs) {
    if (remaining.size === 0) break;
    const view = await loadPackIdxV2(bucket, p.idxKey);
    if (!view) continue;
    for (const oid of remaining) {
      const hit = view.lookupOid(oid);
      if (hit) {
        result.set(oid, { packKey: p.packKey, ...hit });
        remaining.delete(oid);
      }
    }
  }
  return result;
}

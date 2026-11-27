import { NUM_TYPE, TYPE_NUM, type ObjType } from "./objects";
import { fromHex, toHex } from "./util";

/**
 * `.pref` Pack Ref-Index sidecar format (SPEC-0024 M4.1, modeled on `git-on-cloudflare` refIndex):
 * Allows Worker-side closure planning to walk commit/tree/tag references without inflating
 * pack objects or querying DO SQLite `reachable`.
 *
 * Layout (big-endian integers):
 *   magic        4B   "PREF" (0x50524546)
 *   version      4B   1
 *   objectCount  4B   N
 *   packBytes    8B   uint64 pack length
 *   packSha1    20B   raw pack trailer SHA-1
 *   idxSha1     20B   raw idx content SHA-1 (zeroes if unknown)
 *   typeCodes    N B  ObjType code (1..4) in ascending OID order matching `.idx` v2
 *   refStarts   (N+1)*4B  CSR uint32 offsets (in 20-byte OID slots) into `rawRefs`
 *   rawRefs     refCount*20B  flat 20-byte binary OIDs referenced by each object
 */
export const PACK_REF_MAGIC = 0x50524546;
export const PACK_REF_VERSION = 1;
export const PACK_REF_HEADER_BYTES = 4 + 4 + 4 + 8 + 20 + 20;

const OID_BYTES = 20;
const OID_HEX_BYTES = 40;
const UINT32_SPAN = 0x1_0000_0000;
const TREE_PREFIX = [0x74, 0x72, 0x65, 0x65, 0x20]; // "tree "
const PARENT_PREFIX = [0x70, 0x61, 0x72, 0x65, 0x6e, 0x74, 0x20]; // "parent "
const OBJECT_PREFIX = [0x6f, 0x62, 0x6a, 0x65, 0x63, 0x74, 0x20]; // "object "
const TYPE_PREFIX = [0x74, 0x79, 0x70, 0x65, 0x20]; // "type "

export interface PackRefEntryInput {
  oid: string;
  type: ObjType;
  refs: Uint8Array;
}

export interface PackRefIndexView {
  objectCount: number;
  packBytes: number;
  packSha1: string;
  idxSha1: string;
  typeCodes: Uint8Array;
  refStartsBytes: Uint8Array;
  refStartsView: DataView;
  rawRefs: Uint8Array;
  typeAt(sortedIndex: number): ObjType;
  refsAt(sortedIndex: number): string[];
  rawRefsAt(sortedIndex: number): Uint8Array;
}

function hexNibble(ch: number): number {
  if (ch >= 0x30 && ch <= 0x39) return ch - 0x30;
  if (ch >= 0x61 && ch <= 0x66) return ch - 0x61 + 10;
  if (ch >= 0x41 && ch <= 0x46) return ch - 0x41 + 10;
  return -1;
}

function hasHexOid(buf: Uint8Array, start: number, end: number): boolean {
  if (start + OID_HEX_BYTES > end) return false;
  for (let i = 0; i < OID_HEX_BYTES; i++) {
    if (hexNibble(buf[start + i]!) < 0) return false;
  }
  return true;
}

function writeHexOid(buf: Uint8Array, start: number, out: Uint8Array, outOff: number): void {
  for (let i = 0; i < OID_BYTES; i++) {
    const hi = hexNibble(buf[start + i * 2]!);
    const lo = hexNibble(buf[start + i * 2 + 1]!);
    if (hi < 0 || lo < 0) throw new Error("pref: invalid hex object id");
    out[outOff + i] = (hi << 4) | lo;
  }
}

function lineHasPrefix(buf: Uint8Array, start: number, end: number, prefix: readonly number[]): boolean {
  if (start + prefix.length > end) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[start + i] !== prefix[i]) return false;
  }
  return true;
}

function asciiEqualsAt(buf: Uint8Array, start: number, end: number, expected: string): boolean {
  if (start + expected.length > end) return false;
  for (let i = 0; i < expected.length; i++) {
    if (buf[start + i] !== expected.charCodeAt(i)) return false;
  }
  return true;
}

function forEachHeaderLine(payload: Uint8Array, visit: (start: number, end: number) => void): void {
  let pos = 0;
  while (pos < payload.byteLength) {
    const start = pos;
    while (pos < payload.byteLength && payload[pos] !== 0x0a) pos++;
    const end = pos > start && payload[pos - 1] === 0x0d ? pos - 1 : pos;
    if (end === start) break;
    visit(start, end);
    pos++;
  }
}

function extractCommitRefs(payload: Uint8Array): Uint8Array {
  let treeHex = -1;
  let parents = 0;
  forEachHeaderLine(payload, (start, end) => {
    if (treeHex < 0 && lineHasPrefix(payload, start, end, TREE_PREFIX)) {
      const hex = start + TREE_PREFIX.length;
      if (hasHexOid(payload, hex, end)) treeHex = hex;
      return;
    }
    if (lineHasPrefix(payload, start, end, PARENT_PREFIX)) {
      const hex = start + PARENT_PREFIX.length;
      if (hasHexOid(payload, hex, end)) parents++;
    }
  });
  const out = new Uint8Array(((treeHex >= 0 ? 1 : 0) + parents) * OID_BYTES);
  let off = 0;
  if (treeHex >= 0) {
    writeHexOid(payload, treeHex, out, off);
    off += OID_BYTES;
  }
  forEachHeaderLine(payload, (start, end) => {
    if (!lineHasPrefix(payload, start, end, PARENT_PREFIX)) return;
    const hex = start + PARENT_PREFIX.length;
    if (!hasHexOid(payload, hex, end)) return;
    writeHexOid(payload, hex, out, off);
    off += OID_BYTES;
  });
  return out;
}

function extractTagRefs(payload: Uint8Array): Uint8Array {
  let objHex = -1;
  let validType = false;
  forEachHeaderLine(payload, (start, end) => {
    if (objHex < 0 && lineHasPrefix(payload, start, end, OBJECT_PREFIX)) {
      const hex = start + OBJECT_PREFIX.length;
      if (hasHexOid(payload, hex, end)) objHex = hex;
      return;
    }
    if (lineHasPrefix(payload, start, end, TYPE_PREFIX)) {
      const vs = start + TYPE_PREFIX.length;
      if (
        asciiEqualsAt(payload, vs, end, "commit") ||
        asciiEqualsAt(payload, vs, end, "tree") ||
        asciiEqualsAt(payload, vs, end, "blob") ||
        asciiEqualsAt(payload, vs, end, "tag")
      ) {
        validType = true;
      }
    }
  });
  if (objHex < 0 || !validType) return new Uint8Array(0);
  const out = new Uint8Array(OID_BYTES);
  writeHexOid(payload, objHex, out, 0);
  return out;
}

function isGitlink(buf: Uint8Array, start: number, end: number): boolean {
  return end - start === 6 && asciiEqualsAt(buf, start, end, "160000");
}

function extractTreeRefs(payload: Uint8Array): Uint8Array {
  let count = 0;
  let pos = 0;
  while (pos < payload.length) {
    const modeStart = pos;
    while (pos < payload.length && payload[pos] !== 0x20) pos++;
    if (pos >= payload.length) break;
    const modeEnd = pos;
    pos++;
    while (pos < payload.length && payload[pos] !== 0x00) pos++;
    const oidStart = pos + 1;
    if (oidStart + OID_BYTES > payload.length) break;
    if (!isGitlink(payload, modeStart, modeEnd)) count++;
    pos = oidStart + OID_BYTES;
  }
  const out = new Uint8Array(count * OID_BYTES);
  let outOff = 0;
  pos = 0;
  while (pos < payload.length && outOff < out.length) {
    const modeStart = pos;
    while (pos < payload.length && payload[pos] !== 0x20) pos++;
    if (pos >= payload.length) break;
    const modeEnd = pos;
    pos++;
    while (pos < payload.length && payload[pos] !== 0x00) pos++;
    const oidStart = pos + 1;
    if (oidStart + OID_BYTES > payload.length) break;
    if (!isGitlink(payload, modeStart, modeEnd)) {
      out.set(payload.subarray(oidStart, oidStart + OID_BYTES), outOff);
      outOff += OID_BYTES;
    }
    pos = oidStart + OID_BYTES;
  }
  return out;
}

/** Extract flat 20-byte child/target OIDs referenced by an inflated Git object. */
export function extractObjectRefBytes(type: ObjType, payload: Uint8Array): Uint8Array {
  if (type === "commit") return extractCommitRefs(payload);
  if (type === "tree") return extractTreeRefs(payload);
  if (type === "tag") return extractTagRefs(payload);
  return new Uint8Array(0);
}

/** Encode a binary `.pref` sidecar for `entries`, automatically sorting them by ascending OID. */
export function encodePackRefIndex(input: {
  entries: PackRefEntryInput[];
  packBytes: number;
  packSha1: string;
  idxSha1?: string;
}): Uint8Array {
  const sorted = [...input.entries].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const n = sorted.length;
  let refCount = 0;
  for (const e of sorted) {
    if (e.refs.byteLength % OID_BYTES !== 0) {
      throw new Error(`pref: unaligned ref bytes for ${e.oid}`);
    }
    refCount += e.refs.byteLength / OID_BYTES;
  }
  const totalBytes = PACK_REF_HEADER_BYTES + n + (n + 1) * 4 + refCount * OID_BYTES;
  const out = new Uint8Array(totalBytes);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let pos = 0;

  dv.setUint32(pos, PACK_REF_MAGIC, false);
  pos += 4;
  dv.setUint32(pos, PACK_REF_VERSION, false);
  pos += 4;
  dv.setUint32(pos, n, false);
  pos += 4;
  const hi = Math.floor(input.packBytes / UINT32_SPAN);
  const lo = input.packBytes >>> 0;
  dv.setUint32(pos, hi, false);
  dv.setUint32(pos + 4, lo, false);
  pos += 8;
  out.set(fromHex(input.packSha1), pos);
  pos += OID_BYTES;
  out.set(input.idxSha1 ? fromHex(input.idxSha1) : new Uint8Array(OID_BYTES), pos);
  pos += OID_BYTES;

  for (let i = 0; i < n; i++) {
    out[pos++] = TYPE_NUM[sorted[i]!.type];
  }
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    dv.setUint32(pos, cursor, false);
    pos += 4;
    cursor += sorted[i]!.refs.byteLength / OID_BYTES;
  }
  dv.setUint32(pos, cursor, false);
  pos += 4;
  for (let i = 0; i < n; i++) {
    const refs = sorted[i]!.refs;
    if (refs.byteLength > 0) {
      out.set(refs, pos);
      pos += refs.byteLength;
    }
  }
  return out;
}

/** Parse and validate a binary `.pref` sidecar. */
export function parsePackRefIndex(bytes: Uint8Array, expectedPackSha1?: string): PackRefIndexView {
  if (bytes.byteLength < PACK_REF_HEADER_BYTES + 4) {
    throw new Error(`pref: truncated sidecar (${bytes.byteLength} bytes)`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, false);
  if (magic !== PACK_REF_MAGIC) throw new Error(`pref: invalid magic 0x${magic.toString(16)}`);
  const version = dv.getUint32(4, false);
  if (version !== PACK_REF_VERSION) throw new Error(`pref: unsupported version ${version}`);
  const objectCount = dv.getUint32(8, false);
  const packBytes = dv.getUint32(12, false) * UINT32_SPAN + dv.getUint32(16, false);
  const packSha1 = toHex(bytes.subarray(20, 40));
  const idxSha1 = toHex(bytes.subarray(40, 60));
  if (expectedPackSha1 && packSha1 !== expectedPackSha1) {
    throw new Error(`pref: stale checksum (got ${packSha1}, expected ${expectedPackSha1})`);
  }

  const typeStart = PACK_REF_HEADER_BYTES;
  const startsStart = typeStart + objectCount;
  const rawRefsStart = startsStart + (objectCount + 1) * 4;
  if (rawRefsStart > bytes.byteLength) throw new Error("pref: truncated index tables");
  const typeCodes = bytes.subarray(typeStart, startsStart);
  const refStartsBytes = bytes.subarray(startsStart, rawRefsStart);
  const refStartsView = new DataView(
    refStartsBytes.buffer,
    refStartsBytes.byteOffset,
    refStartsBytes.byteLength
  );

  let prev = 0;
  for (let i = 0; i <= objectCount; i++) {
    const cur = refStartsView.getUint32(i * 4, false);
    if (cur < prev) throw new Error("pref: non-monotonic refStarts");
    prev = cur;
  }
  const totalRefs = refStartsView.getUint32(objectCount * 4, false);
  const expectedLen = rawRefsStart + totalRefs * OID_BYTES;
  if (bytes.byteLength !== expectedLen) {
    throw new Error(`pref: length mismatch (got ${bytes.byteLength}, expected ${expectedLen})`);
  }
  const rawRefs = bytes.subarray(rawRefsStart, expectedLen);

  return {
    objectCount,
    packBytes,
    packSha1,
    idxSha1,
    typeCodes,
    refStartsBytes,
    refStartsView,
    rawRefs,
    typeAt(sortedIndex: number): ObjType {
      const code = typeCodes[sortedIndex]!;
      const t = NUM_TYPE[code];
      if (!t) throw new Error(`pref: invalid object type code ${code} at ${sortedIndex}`);
      return t;
    },
    refsAt(sortedIndex: number): string[] {
      const s = refStartsView.getUint32(sortedIndex * 4, false);
      const e = refStartsView.getUint32((sortedIndex + 1) * 4, false);
      const out: string[] = [];
      for (let i = s; i < e; i++) {
        out.push(toHex(rawRefs.subarray(i * OID_BYTES, (i + 1) * OID_BYTES)));
      }
      return out;
    },
    rawRefsAt(sortedIndex: number): Uint8Array {
      const s = refStartsView.getUint32(sortedIndex * 4, false);
      const e = refStartsView.getUint32((sortedIndex + 1) * 4, false);
      return rawRefs.subarray(s * OID_BYTES, e * OID_BYTES);
    },
  };
}

function binarySearchOid(sortedOids: readonly string[], target: string): number {
  let lo = 0;
  let hi = sortedOids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cur = sortedOids[mid]!;
    if (cur === target) return mid;
    if (cur < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Pure in-memory reachability closure over `.pref` sidecars without inflating pack objects.
 */
export function walkClosureWithPref(
  packs: Array<{ sortedOids: readonly string[]; pref: PackRefIndexView }>,
  wants: readonly string[],
  excluded?: ReadonlySet<string>
): Set<string> {
  const result = new Set<string>();
  const stack: string[] = [];
  for (const w of wants) {
    if (!excluded?.has(w) && !result.has(w)) {
      result.add(w);
      stack.push(w);
    }
  }
  while (stack.length > 0) {
    const oid = stack.pop()!;
    for (const pack of packs) {
      const idx = binarySearchOid(pack.sortedOids, oid);
      if (idx < 0) continue;
      for (const child of pack.pref.refsAt(idx)) {
        if (!excluded?.has(child) && !result.has(child)) {
          result.add(child);
          stack.push(child);
        }
      }
      break;
    }
  }
  return result;
}

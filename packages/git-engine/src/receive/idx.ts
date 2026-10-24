/**
 * idx v2 emission (SPEC-0001a §3 Step 2): byte-equivalent to `git index-pack`.
 *
 * File layout (all integers big-endian):
 *   magic "\377tOc", version 2, 256 fanout u32 (cumulative object counts by
 *   first oid byte), N sorted 20-byte oids, N CRC-32 u32 of each raw packed
 *   entry, N pack offsets u32 (MSB set marks an index into the 64-bit offset
 *   table), the 64-bit offset table, the 20-byte pack checksum, and the
 *   20-byte SHA-1 of everything before it.
 *
 * The whole file is streamed through `sink` in bounded chunks — peak memory is
 * the sorted oid index (4N bytes) plus the hex strings — never a materialized
 * idx. Offsets >= 2^31 land in the large-offset table so packs past 2 GiB stay
 * indexable, exactly as git writes them.
 */
import { fromHex, Sha1 } from "../git/util";
import { OidSet } from "../git/oidset";

/** Standard IEEE CRC-32 (zlib polynomial), the checksum git stores per entry. */
export class Crc32 {
  private value = 0xffffffff;

  update(data: Uint8Array): this {
    let v = this.value;
    for (let i = 0; i < data.length; i++) {
      v = CRC_TABLE[(v ^ data[i]) & 0xff] ^ (v >>> 8);
    }
    this.value = v;
    return this;
  }

  get(): number {
    return (this.value ^ 0xffffffff) >>> 0;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export interface IdxInput {
  /** every object of the pack, in resolution order */
  oids: OidSet;
  /** resolution-order index -> entry index (parallel to `oids`) */
  oidEntry: number[];
  /** CRC-32 per ENTRY (indexed by entry index, as produced by the scan) */
  entryCrcs: Uint32Array;
  /** pack offset per ENTRY */
  entryOffsets: Float64Array;
  /** the pack's own SHA-1 trailer, hex */
  packSha1: string;
}

const EMIT_CHUNK = 64 * 1024;

/**
 * Stream the idx v2 for a fully-resolved pack through `sink`. Returns the
 * total byte length written. The per-oid columns are emitted in sorted-oid
 * order; each row reads its crc/offset through `oidEntry` back into entry
 * order, where the scan recorded them.
 */
export async function writeIdx(
  sink: (chunk: Uint8Array) => Promise<void> | void,
  input: IdxInput
): Promise<number> {
  const { oids, oidEntry, entryCrcs, entryOffsets, packSha1 } = input;
  const n = oids.size;
  const hexes: string[] = new Array(n);
  for (let i = 0; i < n; i++) hexes[i] = oids.atHex(i);
  // idx rows are in ascending oid order; hex strings compare byte-wise
  const sorted: number[] = new Array(n);
  for (let i = 0; i < n; i++) sorted[i] = i;
  sorted.sort((a, b) => (hexes[a] < hexes[b] ? -1 : hexes[a] > hexes[b] ? 1 : 0));

  // fanout: cumulative counts by first byte
  const fanout = new Uint32Array(256);
  for (let i = 0; i < n; i++) fanout[parseInt(hexes[i].slice(0, 2), 16)]++;
  for (let i = 1; i < 256; i++) fanout[i] += fanout[i - 1];

  // offsets >= 2^31 are MSB-flagged into a 64-bit side table
  const large: number[] = [];
  const offsetWord = (off: number): number =>
    off < 0x80000000 ? off : 0x80000000 | (large.push(off) - 1);

  const sha = new Sha1();
  let buf = new Uint8Array(EMIT_CHUNK);
  let fill = 0;
  let total = 0;
  // writes chain so the sink sees chunks strictly in order; the scratch
  // buffer is copied out synchronously, so push() can never race a flush
  let writing: Promise<void> = Promise.resolve();
  const flush = (): void => {
    if (!fill) return;
    const chunk = buf.slice(0, fill);
    sha.update(chunk);
    total += fill;
    fill = 0;
    writing = writing.then(() => sink(chunk));
  };
  const push = (byte: number): void => {
    if (fill === buf.length) flush();
    buf[fill++] = byte;
  };
  const pushU32 = (v: number): void => {
    push((v >>> 24) & 0xff);
    push((v >>> 16) & 0xff);
    push((v >>> 8) & 0xff);
    push(v & 0xff);
  };

  // header: magic + version
  push(0xff);
  push(0x74); // t
  push(0x4f); // O
  push(0x63); // c
  pushU32(2);
  for (let i = 0; i < 256; i++) pushU32(fanout[i]);
  for (let i = 0; i < n; i++) {
    const bytes = fromHex(hexes[sorted[i]]);
    for (let j = 0; j < 20; j++) push(bytes[j]);
  }
  for (let i = 0; i < n; i++) {
    const entry = oidEntry[sorted[i]];
    pushU32(entryCrcs[entry]);
  }
  for (let i = 0; i < n; i++) {
    const entry = oidEntry[sorted[i]];
    pushU32(offsetWord(entryOffsets[entry]));
  }
  for (const off of large) {
    pushU32(Math.floor(off / 0x100000000));
    pushU32(off >>> 0);
  }
  const packBytes = fromHex(packSha1);
  for (let i = 0; i < 20; i++) push(packBytes[i]);
  flush();
  await writing;

  // the idx checksum is the SHA-1 of everything before it
  const checksum = sha.digest();
  await sink(checksum);
  total += 20;
  return total;
}

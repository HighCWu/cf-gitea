/**
 * A zero-dependency bzip2 ENCODER — the conda family's `repodata.json.bz2`
 * arm (SPEC-0016 §7 conda row, wall 3's reopen trigger). Go's stdlib has
 * no bzip2 writer (upstream rides github.com/dsnet/compress through
 * conda.go:170-183), so this module is written FROM THE FORMAT SPEC with
 * the landed decoder (./bz2.ts, the Go compress/bzip2 port) as the
 * in-repo reference. Byte-identity with bzip2(1) is NOT a goal — the
 * format's own decoder freedom is exercised (block split points, table
 * count/assignment) — correctness is, and it is self-checking: every
 * block CRC and the combined stream CRC ride the same functions the
 * decoder verifies, and the battery round-trips every arm through BOTH
 * the landed decoder and system bzip2 (the goldens cross-checked with
 * `bzip2 -d` at authoring time; see bz2-encode.test.ts).
 *
 * Pipeline per block (the bzip2 stack in encode order):
 *   RLE1 (runs of 4..255 → 4 bytes + count; the pair split cap 255, the
 *   900k·level block cut BETWEEN pairs) → BWT over the RLE bytes (a
 *   prefix-doubling suffix array of the DOUBLED block — the rotation
 *   order; O(n log n) time, O(n) space, n ≤ 900000; see bwtBlock below)
 *   → MTF over the sorted
 *   column with the zero-runs RUNA/RUNB coded (bijective base 2) → the
 *   symbol stream split into 2..6 table groups (libbz2's nMTF thresholds,
 *   50-symbol selector blocks, ≤ ceil(selectors/groups) per table), one
 *   length-limited Huffman table per group (lengths capped at 20 by the
 *   frequency-halving loop; zero-frequency symbols still get valid
 *   lengths, so every transmitted table is a complete canonical code) →
 *   canonical code assignment (hbAssignCodes: codes of each length to
 *   the symbols in ascending order — the invariant the landed decoder's
 *   hbCreateDecodeTables relies on) → the delta-coded 5-bit length
 *   streams, the unary-coded selector MTF, the two-level symbol map.
 *
 * Resource posture: whole-buffer in, whole-buffer out (the same order as
 * the landed decoder's walk and the repodata payloads' tens-of-KB); the
 * suffix-array pass holds 4 Int32Arrays of the DOUBLED block size (≤ 1.8M
 * entries, 28.8 MB) on top of the buffers the caller already owns.
 */

// ---------------------------------------------------------------------------
// The CRC — the same non-reflected 0x04C11DB7 table the decoder verifies
// with (bz2.ts's BZ_CRC_TABLE; duplicated here because bz2.ts exports
// neither the table nor its folding helper and stays untouched).
// ---------------------------------------------------------------------------

const BZ_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  const poly = 0x04c11db7;
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80000000) !== 0 ? ((crc << 1) ^ poly) >>> 0 : (crc << 1) >>> 0;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

/** Fold one byte into the RUNNING (pre-complement) CRC state. */
function crcFoldByte(crc: number, byte: number): number {
  return ((BZ_CRC_TABLE[(crc >>> 24) ^ byte] ?? 0) ^ ((crc << 8) >>> 0)) >>> 0;
}

/** Fold `byte` repeated `count` times (an RLE1 pair's source bytes). */
function crcFoldRun(crc: number, byte: number, count: number): number {
  for (let i = 0; i < count; i++) crc = crcFoldByte(crc, byte);
  return crc;
}

// ---------------------------------------------------------------------------
// The bit writer — MSB-first over a growable byte buffer. The pending
// accumulator stays float-exact: between calls ≤ 7 bits ride in `acc`
// (< 2^7), so a 32-bit write peaks at 2^7 · 2^32 < 2^53; bytes peel off
// the top one at a time.
// ---------------------------------------------------------------------------

class BzBitWriter {
  private out: Uint8Array;
  private len = 0;
  private acc = 0;
  private count = 0;

  constructor(capacity: number) {
    this.out = new Uint8Array(Math.max(64, capacity));
  }

  /** The low `n` bits of `value`, MSB-first (n ≤ 32). */
  writeBits(value: number, n: number): void {
    this.acc = this.acc * 2 ** n + value;
    this.count += n;
    while (this.count >= 8) {
      const shift = this.count - 8;
      const byte = Math.floor(this.acc / 2 ** shift);
      this.acc -= byte * 2 ** shift;
      this.count -= 8;
      this.push(byte);
    }
  }

  /** Pad the partial byte with zero bits (the stream footer). */
  alignToByte(): void {
    if (this.count > 0) {
      this.push(this.acc * 2 ** (8 - this.count));
      this.acc = 0;
      this.count = 0;
    }
  }

  private push(byte: number): void {
    if (this.len === this.out.byteLength) {
      const grown = new Uint8Array(this.out.byteLength * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.len++] = byte;
  }

  bytes(): Uint8Array {
    return this.out.slice(0, this.len);
  }
}

// ---------------------------------------------------------------------------
// The BWT — the block's RLE bytes sorted as ROTATIONS (the order the
// bzip2 inverse walks, libbz2 semantics). The rotation order is computed
// through a suffix array of the DOUBLED block B·B: rotation i is the
// length-n prefix of suffix i of B·B, and any two UNEQUAL rotations
// differ within their n bytes — so the suffix order of B·B restricted to
// start positions 0..n-1 IS the rotation matrix's row order (a plain
// B$-sentinel sort is NOT: its early $ termination resolves
// rotation-prefix pairs by position instead of by the cyclic
// wraparound, which silently breaks the inverse's T-chain). Rotations
// that are fully equal (periodic blocks) tie arbitrarily in the sort —
// equal rotations share the last-column byte, so the column and the
// inverse are unaffected. Suffix array: prefix doubling with two stable
// counting sorts per round (the classic Larsson-Sadakane radix) —
// O(n log n) time over the 2n doubled text, O(n) space; the rounds stop
// as soon as every rank is distinct.
// ---------------------------------------------------------------------------

function suffixArrayWithSentinel(bytes: Uint8Array): Int32Array {
  const n = bytes.length;
  const total = n + 1; // the explicit sentinel position n
  const sa = new Int32Array(total);
  const rank = new Int32Array(total);
  const newRank = new Int32Array(total);
  const order = new Int32Array(total); // suffixes bucketed by second key
  const cnt = new Int32Array(Math.max(total, 257) + 1);

  // Round 0: counting sort by the first byte; the sentinel sorts as
  // value 0, every byte b as b + 1.
  for (let v = 0; v < 257; v++) cnt[v] = 0;
  for (let i = 0; i < n; i++) cnt[bytes[i]! + 1] = (cnt[bytes[i]! + 1] ?? 0) + 1;
  cnt[0] = (cnt[0] ?? 0) + 1;
  let sum = 0;
  for (let v = 0; v < 257; v++) {
    const c = cnt[v]!;
    cnt[v] = sum;
    sum += c;
  }
  for (let i = 0; i < total; i++) {
    const v = i === n ? 0 : bytes[i]! + 1;
    sa[cnt[v]!] = i;
    cnt[v] = cnt[v]! + 1;
  }
  rank[sa[0]!] = 0;
  for (let i = 1; i < total; i++) {
    const prev = sa[i - 1]!;
    const cur = sa[i]!;
    const prevKey = prev === n ? 0 : bytes[prev]! + 1;
    const curKey = cur === n ? 0 : bytes[cur]! + 1;
    rank[cur] = rank[prev]! + (prevKey !== curKey ? 1 : 0);
  }

  // Doubling rounds: reorder by (rank[i], rank[i+k]) — bucket by the
  // second key (empty keys, i + k ≥ total, first), then a stable counting
  // sort by the first key; re-rank; stop when all ranks are distinct.
  for (let k = 1; rank[sa[total - 1]!]! < total - 1; k <<= 1) {
    let p = 0;
    for (let i = Math.max(total - k, 0); i < total; i++) order[p++] = i;
    for (let i = 0; i < total; i++) {
      const s = sa[i]!;
      if (s >= k) order[p++] = s - k;
    }
    for (let v = 0; v < total; v++) cnt[v] = 0;
    for (let i = 0; i < total; i++) cnt[rank[i]!] = (cnt[rank[i]!] ?? 0) + 1;
    sum = 0;
    for (let v = 0; v < total; v++) {
      const c = cnt[v]!;
      cnt[v] = sum;
      sum += c;
    }
    for (let i = 0; i < total; i++) {
      const s = order[i]!;
      sa[cnt[rank[s]!]!] = s;
      cnt[rank[s]!] = cnt[rank[s]!]! + 1;
    }
    newRank[sa[0]!] = 0;
    for (let i = 1; i < total; i++) {
      const prev = sa[i - 1]!;
      const cur = sa[i]!;
      const same =
        rank[prev] === rank[cur] &&
        (prev + k < total ? rank[prev + k]! : -1) === (cur + k < total ? rank[cur + k]! : -1);
      newRank[cur] = newRank[prev]! + (same ? 0 : 1);
    }
    rank.set(newRank);
  }
  return sa;
}

/** The block's BWT: the sorted-rotation last column + the origin row. */
function bwtBlock(rle: Uint8Array): { column: Uint8Array; origPtr: number } {
  const n = rle.length;
  const doubled = new Uint8Array(2 * n);
  doubled.set(rle, 0);
  doubled.set(rle, n);
  const sa = suffixArrayWithSentinel(doubled);
  const column = new Uint8Array(n);
  let origPtr = -1;
  let row = 0;
  for (let i = 0; i < sa.length; i++) {
    const start = sa[i]!;
    if (start >= n) continue; // the second-copy rows repeat every rotation
    if (start === 0) origPtr = row; // the rotation equal to the block itself
    column[row] = rle[(start + n - 1) % n] ?? 0;
    row++;
  }
  if (origPtr < 0 || row !== n) throw new Error("bzip2 encode: BWT row walk incomplete");
  return { column, origPtr };
}

// ---------------------------------------------------------------------------
// MTF + the RUNA/RUNB second-stage RLE over the sorted column.
// ---------------------------------------------------------------------------

const BZ_RUNA = 0;
const BZ_RUNB = 1;

function mtfEncodeRle2(
  column: Uint8Array,
  seqToUnseq: Uint8Array,
  nInUse: number,
): { symbols: Uint16Array; count: number; alphaSize: number } {
  const alphaSize = nInUse + 2; // RUNA + RUNB + the used bytes + EOB
  const list = seqToUnseq.slice(0, nInUse);
  const pos = new Int32Array(256).fill(-1);
  for (let i = 0; i < nInUse; i++) pos[list[i]!] = i;

  const symbols = new Uint16Array(column.length + 1);
  let m = 0;
  let run = 0;
  // Bijective base 2: RUNA adds 2^k, RUNB adds 2^(k+1) at position k —
  // the exact inverse of the decoder's repeat accumulator.
  const flushRun = (): void => {
    while (run > 0) {
      if (run % 2 === 1) {
        symbols[m++] = BZ_RUNA;
        run = (run - 1) / 2;
      } else {
        symbols[m++] = BZ_RUNB;
        run = (run - 2) / 2;
      }
    }
  };
  for (let i = 0; i < column.length; i++) {
    const byte = column[i]!;
    const j = pos[byte]!;
    if (j === 0) {
      run++;
      continue;
    }
    flushRun();
    symbols[m++] = j + 1; // the MTF index rides symbol v = j + 1 (0 never
    // appears as a plain symbol — the decoder relies on that)
    for (let t = j; t > 0; t--) list[t] = list[t - 1]!;
    list[0] = byte;
    for (let t = j; t > 0; t--) pos[list[t]!] = t;
    pos[byte] = 0;
  }
  flushRun();
  symbols[m++] = alphaSize - 1; // EOB
  return { symbols, count: m, alphaSize };
}

// ---------------------------------------------------------------------------
// Length-limited Huffman code lengths + canonical code assignment.
// ---------------------------------------------------------------------------

/** Huffman code lengths over ALL alphaSize weights (zero-frequency
 *  symbols included — every transmitted table must be a complete
 *  canonical code, so unused symbols carry valid lengths too). */
function huffmanLengthsOnce(weights: Int32Array): Uint8Array {
  const leaves = weights.length;
  const nodes = 2 * leaves - 1;
  const weight = Int32Array.from(weights);
  const parent = new Int32Array(nodes).fill(-1);
  const alive = new Uint8Array(nodes);
  for (let i = 0; i < leaves; i++) alive[i] = 1;
  for (let next = leaves; next < nodes; next++) {
    let first = -1;
    let second = -1;
    for (let i = 0; i < next; i++) {
      if (alive[i] === 0) continue;
      if (first < 0 || weight[i]! < weight[first]!) {
        second = first;
        first = i;
      } else if (second < 0 || weight[i]! < weight[second]!) {
        second = i;
      }
    }
    alive[first] = 0;
    alive[second] = 0;
    weight[next] = weight[first]! + weight[second]!;
    parent[first] = next;
    parent[second] = next;
    alive[next] = 1;
  }
  const lengths = new Uint8Array(leaves);
  for (let i = 0; i < leaves; i++) {
    let depth = 0;
    for (let node = i; parent[node]! >= 0; node = parent[node]!) depth++;
    lengths[i] = depth;
  }
  return lengths;
}

/** The lengths, capped at the format's 20: rescale the weights and
 *  rebuild until the deepest code fits (all-equal weights bottom out at
 *  the balanced-tree depth ≤ ceil(log2(alphaSize)) ≤ 9, so this halts). */
function huffmanLengths(freqs: Int32Array, maxLen: number): Uint8Array {
  const scaled = Int32Array.from(freqs);
  for (;;) {
    const lengths = huffmanLengthsOnce(scaled);
    let deepest = 0;
    for (const length of lengths) if (length > deepest) deepest = length;
    if (deepest <= maxLen) return lengths;
    for (let i = 0; i < scaled.length; i++) scaled[i] = (scaled[i]! + 1) >> 1;
  }
}

/** libbz2's hbAssignCodes: codes of each length to the symbols in
 *  ascending order — the canonical form the decoder rebuilds tables
 *  from (lengths alone on the wire). */
function canonicalCodes(lengths: Uint8Array): Int32Array {
  const codes = new Int32Array(lengths.length);
  let code = 0;
  for (let len = 1; len <= 20; len++) {
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      if (lengths[symbol] === len) codes[symbol] = code++;
    }
    code <<= 1;
  }
  return codes;
}

// ---------------------------------------------------------------------------
// The per-block writer: magic, CRC, the symbol map, the tables, the
// entropy-coded symbol stream.
// ---------------------------------------------------------------------------

const BZ_BLOCK_MAGIC_HI = 0x314159; // pi — the block marker, top 24 bits
const BZ_BLOCK_MAGIC_LO = 0x265359; // …bottom 24 bits
const BZ_FINAL_MAGIC_HI = 0x177245; // sqrt(pi) — the stream footer
const BZ_FINAL_MAGIC_LO = 0x385090;
const BZ_MAX_CODE_LENGTH = 20;
const BZ_SELECTOR_STRIDE = 50; // the table switches every 50 symbols
/** libbz2's nMTF → nGroups ladder (compress.c sendMTFValues). */
function tableCountFor(symbolCount: number): number {
  if (symbolCount < 200) return 2;
  if (symbolCount < 600) return 3;
  if (symbolCount < 1200) return 4;
  if (symbolCount < 2400) return 5;
  return 6;
}

interface BzTable {
  lengths: Uint8Array;
  codes: Int32Array;
}

function buildTable(freqs: Int32Array): BzTable {
  const lengths = huffmanLengths(freqs, BZ_MAX_CODE_LENGTH);
  return { lengths, codes: canonicalCodes(lengths) };
}

function writeBlock(w: BzBitWriter, rle: Uint8Array, origPtr: number, blockCrc: number): void {
  w.writeBits(BZ_BLOCK_MAGIC_HI, 24);
  w.writeBits(BZ_BLOCK_MAGIC_LO, 24);
  w.writeBits(blockCrc, 32);
  w.writeBits(0, 1); // not randomized
  w.writeBits(origPtr, 24);

  // The two-level 16x16 symbol map.
  const used = new Uint8Array(256);
  let nInUse = 0;
  for (const byte of rle) {
    if (used[byte] === 0) {
      used[byte] = 1;
      nInUse++;
    }
  }
  let rangeBits = 0;
  const rangeMask: number[] = [];
  for (let range = 0; range < 16; range++) {
    let mask = 0;
    for (let symbol = 0; symbol < 16; symbol++) {
      if (used[16 * range + symbol] !== 0) mask |= 1 << (15 - symbol);
    }
    if (mask !== 0) {
      rangeBits |= 1 << (15 - range);
      rangeMask.push(mask);
    }
  }
  w.writeBits(rangeBits, 16);
  for (const mask of rangeMask) w.writeBits(mask, 16);

  const seqToUnseq = new Uint8Array(nInUse);
  let next = 0;
  for (let byte = 0; byte < 256; byte++) {
    if (used[byte] !== 0) seqToUnseq[next++] = byte;
  }

  const { symbols, count, alphaSize } = mtfEncodeRle2(rle, seqToUnseq, nInUse);
  const nSelectors = Math.max(1, Math.ceil(count / BZ_SELECTOR_STRIDE));
  const nGroups = Math.min(6, Math.max(2, tableCountFor(count), Math.ceil(nSelectors / 6)));
  const selectorsPerGroup = Math.ceil(nSelectors / nGroups);

  // Per-group symbol frequencies (each group owns ~selectorsPerGroup
  // 50-symbol selector blocks).
  const groupFreqs: Int32Array[] = [];
  for (let g = 0; g < nGroups; g++) groupFreqs.push(new Int32Array(alphaSize));
  for (let s = 0; s < nSelectors; s++) {
    const group = Math.min(Math.floor(s / selectorsPerGroup), nGroups - 1);
    const from = s * BZ_SELECTOR_STRIDE;
    const to = Math.min(from + BZ_SELECTOR_STRIDE, count);
    for (let i = from; i < to; i++) groupFreqs[group]![(symbols[i] ?? 0)] = (groupFreqs[group]![(symbols[i] ?? 0)] ?? 0) + 1;
  }
  // A group with a single distinct symbol cannot build a ≥2-leaf tree with
  // meaningful lengths — fall back to the whole-block frequencies.
  const globalFreqs = new Int32Array(alphaSize);
  for (let i = 0; i < count; i++) globalFreqs[(symbols[i] ?? 0)] = (globalFreqs[(symbols[i] ?? 0)] ?? 0) + 1;
  const tables: BzTable[] = [];
  for (let g = 0; g < nGroups; g++) {
    let distinct = 0;
    for (const f of groupFreqs[g]!) if (f > 0) distinct++;
    tables.push(buildTable(distinct >= 2 ? groupFreqs[g]! : globalFreqs));
  }

  // The selector list, MTF + unary coded.
  w.writeBits(nGroups, 3);
  w.writeBits(nSelectors, 15);
  const order = new Uint8Array(nGroups);
  for (let g = 0; g < nGroups; g++) order[g] = g;
  for (let s = 0; s < nSelectors; s++) {
    const group = Math.min(Math.floor(s / selectorsPerGroup), nGroups - 1);
    let pick = 0;
    while (order[pick] !== group) pick++;
    for (let i = 0; i < pick; i++) w.writeBits(1, 1);
    w.writeBits(0, 1);
    for (let i = pick; i > 0; i--) order[i] = order[i - 1]!;
    order[0] = group;
  }

  // The code lengths: a 5-bit base then 1/0 delta pairs (10 = longer,
  // 11 = shorter, 0 = next symbol — the decoder's walk verbatim).
  for (let g = 0; g < nGroups; g++) {
    const lengths = tables[g]!.lengths;
    let current = lengths[0]!;
    w.writeBits(current, 5);
    for (let symbol = 0; symbol < alphaSize; symbol++) {
      while (current < lengths[symbol]!) {
        w.writeBits(2, 2);
        current++;
      }
      while (current > lengths[symbol]!) {
        w.writeBits(3, 2);
        current--;
      }
      w.writeBits(0, 1);
    }
  }

  // The symbol stream: table floor(i / 50), canonical codes MSB-first.
  let table = tables[0]!;
  for (let i = 0; i < count; i++) {
    if (i % BZ_SELECTOR_STRIDE === 0) {
      const group = Math.min(Math.floor(i / BZ_SELECTOR_STRIDE / selectorsPerGroup), nGroups - 1);
      table = tables[group]!;
    }
    const symbol = symbols[i]!;
    w.writeBits(table.codes[symbol]!, table.lengths[symbol]!);
  }
}

// ---------------------------------------------------------------------------
// The stream: "BZh" + level, blocks, the footer, the combined CRC.
// ---------------------------------------------------------------------------

export interface Bzip2CompressOptions {
  /** The block size in 100k units, 1..9 (default 9 — the bzip2(1)
   *  default; repodata payloads fit one block). */
  level?: number;
}

/**
 * Compress a whole buffer into one bzip2 stream. The input splits into
 * ≤ level·100000-byte RLE1 blocks cut BETWEEN run pairs; every block's
 * CRC folds the original bytes it expands to, and the combined stream
 * CRC is the decoder-verified rotate-left-1 XOR chain.
 */
export function bzip2Compress(bytes: Uint8Array, options?: Bzip2CompressOptions): Uint8Array {
  const level = options?.level ?? 9;
  if (!Number.isInteger(level) || level < 1 || level > 9) {
    throw new Error(`bzip2 compress: level must be an integer 1..9, got ${String(options?.level)}`);
  }
  const blockSize = level * 100000;

  const w = new BzBitWriter(64 + Math.floor(bytes.byteLength / 2));
  w.writeBits(0x425a, 16); // "BZ"
  w.writeBits(0x68, 8); // 'h'
  w.writeBits(0x30 + level, 8); // '1'..'9'
  let fileCrc = 0;

  // The RLE1 walk: runs of 1..255 (libbz2's pair cap) encode as either
  // 4 bytes + count (0..251 extra) or the ≤ 3 literal bytes; blocks cut
  // between pairs so a pair never straddles the 900k·level boundary.
  const rle = new Uint8Array(blockSize);
  let rleLen = 0;
  let blockCrc = 0xffffffff; // the running CRC over this block's source bytes
  let i = 0;
  const closeBlock = (): void => {
    if (rleLen === 0) return;
    const { column, origPtr } = bwtBlock(rle.subarray(0, rleLen));
    writeBlock(w, column, origPtr, (~blockCrc) >>> 0);
    fileCrc = ((((fileCrc << 1) | (fileCrc >>> 31)) ^ (~blockCrc >>> 0)) >>> 0);
    rleLen = 0;
    blockCrc = 0xffffffff;
  };
  const commitPair = (byte: number, run: number): void => {
    const encoded = run >= 4 ? 5 : run;
    if (rleLen + encoded > blockSize) closeBlock();
    if (run >= 4) {
      rle[rleLen++] = byte;
      rle[rleLen++] = byte;
      rle[rleLen++] = byte;
      rle[rleLen++] = byte;
      rle[rleLen++] = run - 4;
    } else {
      for (let t = 0; t < run; t++) rle[rleLen++] = byte;
    }
    blockCrc = crcFoldRun(blockCrc, byte, run);
  };
  while (i < bytes.byteLength) {
    const byte = bytes[i++]!;
    let run = 1;
    while (i < bytes.byteLength && bytes[i] === byte && run < 255) {
      run++;
      i++;
    }
    commitPair(byte, run);
  }
  closeBlock();

  w.writeBits(BZ_FINAL_MAGIC_HI, 24);
  w.writeBits(BZ_FINAL_MAGIC_LO, 24);
  w.writeBits(fileCrc, 32);
  w.alignToByte();
  return w.bytes();
}

/**
 * A zero-dependency zstd DECODER for the Conda `.conda` upload arm
 * (SPEC-0016 §7 conda row, wall 2 ADOPTED — see the conda.ts module
 * header). The platform has no zstd surface at compatibility_date
 * 2026-10-23 (the DecompressionStream format union is exactly
 * "gzip" | "deflate" | "deflate-raw"; a workerd probe rejects zstd), while
 * upstream accepts the format fully (modules/packages/conda/metadata.go
 * ParsePackageConda:101-130 rides Go's archive/zip + klauspost/compress'
 * zstd reader — a format Go's stdlib has neither for, so there was NO
 * Go-stdlib reference to port).
 *
 * The port follows the Zstandard Compression Format spec (the v0.4.3 doc
 * shipped in zstd 1.5.7, the release conda's own tooling emits) with
 * facebook/zstd's C decoder as the algorithm reference for every
 * bit-level walk (decompress/zstd_decompress_block.c,
 * decompress/huf_decompress.c, common/fse_decompress.c,
 * common/entropy_common.c at v1.5.7): decode-only, whole-buffer, with the
 * reference's simplifications kept for parity:
 *
 *  - DICTIONARIES are REJECTED — a nonzero Dictionary_ID fails the frame
 *    (conda's `.conda` members are plain frames; klauspost/compress needs
 *    an explicit decoder option to accept them too);
 *  - LEGACY frames (magic below 0xFD2FB528, the pre-0.8 formats) are
 *    REJECTED — the reference decoder itself needs opt-in legacy support
 *    for them and conda never produces them;
 *  - SKIPPABLE frames (magic 0x184D2A50..5F) are SKIPPED — the format's
 *    pass-through arm;
 *  - CONCATENATED frames decode in sequence (frame boundaries rest the
 *    entropy tables and the repeat offsets — frames are independent);
 *  - every frame with Content_Checksum_flag is VERIFIED against the low
 *    32 bits of an XXH-64 over the decoded content (implemented here in
 *    32-bit-halves arithmetic, no dependency — the checksum is the loud
 *    correctness gate on real fixtures, the role the bzip2 CRCs play for
 *    ./bz2.ts);
 *  - windowLog above 27 fails the frame ("frame requires too much
 *    memory" — the reference streaming decoder's default
 *    ZSTD_WINDOWLOG_LIMIT_DEFAULT posture) and the decoded output is
 *    capped at 1 GiB (an upload blob is ≤ 512 MiB and the conda parse
 *    consumes ≤ 32 MiB of the inner tar, so anything past the cap is
 *    hostile);
 *
 * Decode pipeline (the reference walks, in decode order):
 *   Frame header (FHD → window / dict-ID / FCS) → blocks: Raw copy, RLE
 *   fill, Compressed → literals section (Raw / RLE / Huffman
 *   Compressed+Treeless over the weight-derived X1 table, 1 or 4
 *   interleaved backward bit-streams behind a 6-byte jump table) →
 *   sequences section (the LL/OF/ML FSE tables — predefined, RLE,
 *   FSE-distributed or repeated — then one backward bit-stream carrying
 *   the interleaved state transitions and the extra length/offset bits,
 *   read in the reference's exact order: offset bits, match-length bits,
 *   literals-length bits, then the LL → ML → OF state updates) →
 *   sequence execution (literal copy + match copy; the match copy walks
 *   BYTE-BY-BYTE forward when offset < length — the overlap-copy trap:
 *   a chunked buffer.set silently corrupts overlapping matches).
 *
 * Resource posture: whole-buffer in, whole-buffer out (the same order as
 * the landed bz2 decoder and the `.conda` members' tens-of-KB tar
 * payloads); the FSE/Huffman tables are ≤ 2^9 + 2^12 entries per
 * section, the output is preallocated from Frame_Content_Size when
 * declared, and every table/stream walk is bounded by the format's own
 * limits (accuracy logs ≤ 9, 11-bit Huffman, 128 KB blocks) so a hostile
 * stream cannot drive a walk past them.
 */

/** The one error class for every malformed zstd stream (the caller maps
 *  it onto the service's invalid-archive arm). */
export class ZstdError extends Error {
  constructor(detail: string) {
    super(`zstd stream invalid: ${detail}`);
    this.name = "ZstdError";
  }
}

// ---------------------------------------------------------------------------
// XXH-64 — implemented here (no dependency), 32-bit-halves arithmetic over
// the standard algorithm (xxhash.c at v1.5.7): four accumulators over
// 32-byte stripes, then the length fold, the tail lanes and the avalanche.
// Used for the frame checksum when Content_Checksum_flag is set.
// ---------------------------------------------------------------------------

/** A 64-bit value as [hi, lo] unsigned 32-bit halves. */
type U64 = [number, number];

const XXH_P1: U64 = [0x9e3779b1, 0x85ebca87];
const XXH_P2: U64 = [0xc2b2ae3d, 0x27d4eb4f];
const XXH_P3: U64 = [0x165667b1, 0x9e3779f9];
const XXH_P4: U64 = [0x85ebca77, 0xc2b2ae63];
const XXH_P5: U64 = [0x27d4eb2f, 0x165667c5];

/** a + b mod 2^64. */
function u64Add(a: U64, b: U64): U64 {
  const lo = (a[1] + b[1]) >>> 0;
  const carry = lo < a[1] ? 1 : 0; // unsigned wrap detection
  return [(a[0] + b[0] + carry) >>> 0, lo];
}

/** a - b mod 2^64. */
function u64Sub(a: U64, b: U64): U64 {
  const lo = (a[1] - b[1]) >>> 0;
  const borrow = a[1] < b[1] ? 1 : 0;
  return [(a[0] - b[0] - borrow) >>> 0, lo];
}

/** a * b mod 2^64 via 16-bit limbs (every intermediate < 2^53 — exact). */
function u64Mul(a: U64, b: U64): U64 {
  const a0 = a[1] & 0xffff;
  const a1 = a[1] >>> 16;
  const a2 = a[0] & 0xffff;
  const a3 = a[0] >>> 16;
  const b0 = b[1] & 0xffff;
  const b1 = b[1] >>> 16;
  const b2 = b[0] & 0xffff;
  const b3 = b[0] >>> 16;
  const c0 = a0 * b0;
  // Math.floor(/ 2^16) — NOT >>> 16: t1/t2 exceed 32 bits and >>> would
  // truncate them to uint32 before shifting.
  const t1 = Math.floor(c0 / 65536) + a0 * b1 + a1 * b0;
  const t2 = Math.floor(t1 / 65536) + a0 * b2 + a1 * b1 + a2 * b0;
  const t3 = Math.floor(t2 / 65536) + a0 * b3 + a1 * b2 + a2 * b1 + a3 * b0;
  const lo = ((c0 & 0xffff) | ((t1 & 0xffff) << 16)) >>> 0;
  // hi = bits 32-63: t2's low limb at bits 32-47, t3's low limb at 48-63
  // (each t's high limb already flowed into the next; bits above 63 drop).
  const hi = ((t2 & 0xffff) | ((t3 & 0xffff) << 16)) >>> 0;
  return [hi, lo];
}

/** x rotl n (0 ≤ n < 64) over the halves. */
function u64Rotl(x: U64, n: number): U64 {
  const hi = x[0];
  const lo = x[1];
  if (n === 0) return [hi, lo];
  if (n === 32) return [lo, hi];
  if (n < 32) {
    return [
      ((hi << n) | (lo >>> (32 - n))) >>> 0,
      ((lo << n) | (hi >>> (32 - n))) >>> 0,
    ];
  }
  const s = n - 32;
  return [
    ((lo << s) | (hi >>> (32 - s))) >>> 0,
    ((hi << s) | (lo >>> (32 - s))) >>> 0,
  ];
}

/** x >> n (logical, 0 ≤ n < 64) over the halves. */
function u64Shr(x: U64, n: number): U64 {
  const hi = x[0];
  const lo = x[1];
  if (n === 0) return [hi, lo];
  if (n === 32) return [0, hi];
  if (n < 32) return [hi >>> n, ((lo >>> n) | (hi << (32 - n))) >>> 0];
  return [0, hi >>> (n - 32)];
}

function u64ReadLe(bytes: Uint8Array, offset: number): U64 {
  const lo =
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0;
  const hi =
    ((bytes[offset + 4] ?? 0) |
      ((bytes[offset + 5] ?? 0) << 8) |
      ((bytes[offset + 6] ?? 0) << 16) |
      ((bytes[offset + 7] ?? 0) << 24)) >>>
    0;
  return [hi, lo];
}

function u32ReadLe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function highestBit(byte: number): number {
  return 31 - Math.clz32(byte & 0xff);
}

function xxhRound(acc: U64, lane: U64): U64 {
  // XXH64_round: acc += lane * P2; acc = rotl(acc, 31); acc *= P1.
  return u64Mul(u64Rotl(u64Add(acc, u64Mul(lane, XXH_P2)), 31), XXH_P1);
}

/** XXH-64 over the whole buffer, seed 0 — the frame checksum input
 *  (xxhash.c XXH64(): the four stripe accumulators, the merge rounds, the
 *  8/4/1-byte tails and the avalanche, in the C's exact operation order). */
export function xxh64(bytes: Uint8Array): U64 {
  const len = bytes.byteLength;
  let v1: U64 = u64Add(XXH_P1, XXH_P2); // seed 0 + P1 + P2
  let v2: U64 = [XXH_P2[0], XXH_P2[1]]; // seed 0 + P2
  let v3: U64 = [0, 0]; // seed 0
  let v4: U64 = u64Sub([0, 0], XXH_P1); // seed 0 - P1
  let offset = 0;
  let final: U64;

  if (len >= 32) {
    const limit = len - 32;
    while (offset <= limit) {
      v1 = xxhRound(v1, u64ReadLe(bytes, offset));
      v2 = xxhRound(v2, u64ReadLe(bytes, offset + 8));
      v3 = xxhRound(v3, u64ReadLe(bytes, offset + 16));
      v4 = xxhRound(v4, u64ReadLe(bytes, offset + 24));
      offset += 32;
    }
    let h: U64 = u64Add(
      u64Add(u64Rotl(v1, 1), u64Rotl(v2, 7)),
      u64Add(u64Rotl(v3, 12), u64Rotl(v4, 18)),
    );
    h = xxhMergeRound(h, v1);
    h = xxhMergeRound(h, v2);
    h = xxhMergeRound(h, v3);
    h = xxhMergeRound(h, v4);
    final = h;
  } else {
    final = u64Add([0, 0], XXH_P5); // seed + P5
  }
  let h64: U64 = u64Add(final, [0, len >>> 0]);

  while (offset + 8 <= len) {
    const lane = xxhRound([0, 0], u64ReadLe(bytes, offset));
    h64 = u64Add(u64Mul(u64Rotl(u64Xor(h64, lane), 27), XXH_P1), XXH_P4);
    offset += 8;
  }
  while (offset + 4 <= len) {
    const lane: U64 = [0, u32ReadLe(bytes, offset)];
    h64 = u64Add(u64Mul(u64Rotl(u64Xor(h64, u64Mul(lane, XXH_P1)), 23), XXH_P2), XXH_P3);
    offset += 4;
  }
  while (offset < len) {
    // The single-byte lane folds through PRIME64_5 (XXH64_finalize).
    h64 = u64Mul(u64Rotl(u64Xor(h64, u64Mul([0, bytes[offset] ?? 0], XXH_P5)), 11), XXH_P1);
    offset++;
  }
  // Avalanche: h ^= h >> 33; h *= P2; h ^= h >> 29; h *= P3; h ^= h >> 32.
  let x = u64Xor(h64, u64Shr(h64, 33));
  x = u64Mul(x, XXH_P2);
  x = u64Xor(x, u64Shr(x, 29));
  x = u64Mul(x, XXH_P3);
  x = u64Xor(x, u64Shr(x, 32));
  return x;
}

/** XXH64_mergeRound: h ^= round(0, val); h = h * P1 + P4. */
function xxhMergeRound(h: U64, val: U64): U64 {
  return u64Add(u64Mul(u64Xor(h, xxhRound([0, 0], val)), XXH_P1), XXH_P4);
}

/** XOR over the halves. */
function u64Xor(a: U64, b: U64): U64 {
  return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0];
}

// ---------------------------------------------------------------------------
// The bit readers.
//
// BACKWARD (Huffman + FSE streams — the reference's BIT_DStream): the
// stream window is a little-endian byte range; the last byte's highest
// set bit is the final 1-bit marker, and `remaining` counts the useful
// bits BELOW it (the marker itself is not part of the stream — the
// reference's bitsConsumed starts above it). read(k) takes the k bits
// just below the frontier — the bit nearest the frontier becomes the
// value's MSB — which the reference's (container << consumed) >> (64-k)
// implements. A read past the stream start zero-fills the missing low
// bits and pushes `remaining` negative (the weight-FSE termination
// signal); exact consumption (remaining == 0) is the end check.
//
// FORWARD (FSE table descriptions — the reference's MEM_readLE32 windows):
// little-endian bit order, the bit at `pos` is the next read's LSB; bytes
// at or past the section end read as zero (the reference zero-pads short
// headers) and the consumed size is validated against the section after
// the parse.
// ---------------------------------------------------------------------------

class BitReaderBackward {
  private readonly bytes: Uint8Array;
  private readonly start: number;
  private readonly size: number;
  private remaining: number; // useful bits below the frontier; negative = overdrawn
  private acc = 0; // bits [base, remaining) — a double, kept ≤ 2^47 (exact)
  private base = 0; // acc's low-end bit index within the stream

  constructor(bytes: Uint8Array, start: number, end: number) {
    this.bytes = bytes;
    this.start = start;
    this.size = end - start;
    if (this.size === 0) throw new ZstdError("empty bitstream");
    const last = bytes[end - 1] ?? 0;
    if (last === 0) throw new ZstdError("corrupted bitstream (final byte is zero)");
    this.remaining = 8 * (this.size - 1) + highestBit(last); // below the marker
    this.reload();
  }

  /** acc = bits [base, remaining) clamped to the window start. */
  private reload(): void {
    const base = Math.max(0, (this.remaining - 40) & ~7);
    let value = 0;
    const firstByte = base >> 3;
    const lastByte = Math.min((this.remaining - 1) >> 3, this.size - 1);
    // Little-endian build: byte 0 is the least significant, so the
    // accumulator folds from the highest window byte down.
    for (let i = lastByte; i >= firstByte; i--) {
      value = value * 256 + (this.bytes[this.start + i] ?? 0);
    }
    if (this.remaining > base) {
      value = Math.floor(value / 2 ** (base & 7)) % 2 ** (this.remaining - base);
    } else {
      value = 0;
    }
    this.acc = value;
    this.base = base;
  }

  /** The next k bits (k ≤ 32), backward, WITHOUT advancing the frontier
 *  (the reference's BIT_lookBits — the Huffman table index is a peek;
 *  the symbol's own nbBits are consumed separately). */
  peekBits(k: number): number {
    if (k > 32) throw new ZstdError("oversized backward bit peek");
    if (k > this.remaining - this.base) this.reload();
    const have = this.remaining - this.base;
    if (k > have) {
      // Zero-extended past the stream start: the real bits stay HIGH in
      // the result (the frontier-adjacent bit is the MSB, the reference's
      // (container << consumed) >> (64-k) shape) — zeros fill below.
      return this.acc * 2 ** (k - have);
    }
    const shift = have - k;
    return Math.floor(this.acc / 2 ** shift) % 2 ** k;
  }

  /** The next k bits (k ≤ 32), backward. Missing low bits read as zero. */
  readBits(k: number): number {
    if (k > 32) throw new ZstdError("oversized backward bit read");
    if (k > this.remaining - this.base) this.reload();
    const have = this.remaining - this.base;
    if (k > have) {
      // Zero-extended read past the stream start (real bits HIGH, zeros
      // below — the reference's top-aligned container shape); the deficit
      // makes `remaining` negative (the overflow signal).
      const value = this.acc * 2 ** (k - have);
      this.remaining -= k;
      this.base = Math.min(this.base, this.remaining);
      return value;
    }
    const shift = have - k;
    const value = Math.floor(this.acc / 2 ** shift) % 2 ** k;
    this.remaining -= k;
    return value;
  }

  /** Exact end: every useful bit consumed, nothing overdrawn. */
  atExactEnd(): boolean {
    return this.remaining === 0;
  }

  /** The useful bits left (negative once overdrawn). */
  bitsLeft(): number {
    return this.remaining;
  }
}

class BitReaderForward {
  private readonly bytes: Uint8Array;
  private readonly end: number; // exclusive byte bound (zero-fill past it)
  private bitPos: number;

  constructor(bytes: Uint8Array, startByte: number, endByte: number) {
    this.bytes = bytes;
    this.end = endByte;
    this.bitPos = startByte * 8;
  }

  /** The next n bits (n ≤ 24), little-endian bit order. */
  readBits(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const pos = this.bitPos + i;
      const byteIndex = pos >> 3;
      const byte = byteIndex < this.end ? (this.bytes[byteIndex] ?? 0) : 0;
      value = (value | (((byte >> (pos & 7)) & 1) << i)) >>> 0;
    }
    this.bitPos += n;
    return value;
  }

  get bytePosition(): number {
    return this.bitPos >> 3;
  }

  /** The consumed bit count (for the byte-rounded description length). */
  bitPosition(): number {
    return this.bitPos;
  }
}

// ---------------------------------------------------------------------------
// FSE — the table description parse (entropy_common.c FSE_readNCount_body),
// the decode-table build (fse_decompress.c FSE_buildDTable_internal: the
// step-spread with the "less than 1" symbols parked at the table's top,
// then the sorted-range nbBits/baseline rows) and the two-state weight
// decode (fse_decompress.c FSE_decompress_usingDTable_generic).
// ---------------------------------------------------------------------------

const FSE_MAX_ACCURACY = 15; // FSE_TABLELOG_ABSOLUTE_MAX

interface FseTable {
  accuracyLog: number;
  /** Per state: the decoded symbol and the next-state row. */
  symbols: Uint8Array;
  newStateBase: Int32Array;
  transitionBits: Uint8Array;
}

/**
 * Parse a normalized counter out of a forward bitstream
 * (FSE_readNCount_body). `counts` is filled with 0 (absent) / -1 ("less
 * than 1") per symbol. Returns the description's byte length plus the
 * highest present symbol and the accuracy log.
 */
function fseReadNormalizedCounts(
  bytes: Uint8Array,
  start: number,
  end: number,
  counts: Int16Array,
): { length: number; maxSymbol: number; accuracyLog: number } {
  counts.fill(0);
  const maxSymbolBound = counts.length - 1;
  const br = new BitReaderForward(bytes, start, end);
  const accuracyLog = br.readBits(4) + 5;
  if (accuracyLog > FSE_MAX_ACCURACY) throw new ZstdError("FSE accuracy log too large");
  let remaining = (1 << accuracyLog) + 1;
  let threshold = 1 << accuracyLog;
  let nbBits = accuracyLog + 1;
  let symbol = 0;
  let previousZero = false;

  for (;;) {
    if (previousZero) {
      // The 2-bit repeat flags: each 0b11 chains 3 more zero symbols.
      let repeats = 0;
      for (;;) {
        const flag = br.readBits(2);
        repeats += flag;
        if (flag < 3) break;
      }
      symbol += repeats;
      previousZero = false;
      if (symbol > maxSymbolBound) break; // post-loop checks answer the error
      continue; // the zeros are already in `counts`
    }
    // The low/high bit-count trick (entropy_common.c): a value below
    // `max` fits in nbBits-1 bits; the wide field adjusts by -max when
    // its top bit is set.
    const max = 2 * threshold - 1 - remaining;
    let count: number;
    const lowField = br.readBits(nbBits - 1);
    if (lowField < max) {
      count = lowField;
    } else {
      const highField = lowField | (br.readBits(1) << (nbBits - 1));
      count = highField >= threshold ? highField - max : highField;
    }
    count--; // the extra accuracy: a decoded value of 0 means probability -1
    if (count >= 0) {
      remaining -= count;
    } else {
      remaining += count; // count == -1: "less than 1" costs one point
    }
    counts[symbol] = count;
    symbol++;
    previousZero = count === 0;
    if (remaining < threshold) {
      if (remaining <= 1) break;
      nbBits = highestBit(remaining) + 1;
      threshold = 1 << (nbBits - 1);
    }
    if (symbol > maxSymbolBound) break;
  }
  if (remaining !== 1) {
    throw new ZstdError("FSE distribution does not sum to the accuracy log");
  }
  const maxSymbol = Math.min(symbol - 1, maxSymbolBound);
  // The description consumes a whole number of bytes (the C's
  // ip += (bitCount+7)>>3): any partial last byte is padding, and the
  // next stream (weights or sequences) starts at the byte boundary.
  const length = Math.ceil((br.bitPosition() - start * 8) / 8);
  if (length > end - start) throw new ZstdError("FSE description overruns its section");
  return { length, maxSymbol, accuracyLog };
}

/** Build the FSE decode table (FSE_buildDTable_internal). */
function fseBuildTable(
  counts: Int16Array,
  maxSymbol: number,
  accuracyLog: number,
): FseTable {
  const tableSize = 1 << accuracyLog;
  const symbols = new Uint8Array(tableSize);
  const symbolNext = new Int32Array(counts.length);
  let highThreshold = tableSize - 1;
  for (let s = 0; s <= maxSymbol; s++) {
    const count = counts[s] ?? 0;
    if (count === -1) {
      // "Less than 1" symbols park at the table's top, retreating.
      symbols[highThreshold--] = s;
      symbolNext[s] = 1;
    } else {
      symbolNext[s] = count;
    }
  }
  // Spread the positive counts in step order, skipping the parked area.
  const step = ((tableSize >> 1) + (tableSize >> 3) + 3) | 0;
  const tableMask = tableSize - 1;
  let position = 0;
  for (let s = 0; s <= maxSymbol; s++) {
    const count = counts[s] ?? 0;
    for (let i = 0; i < count; i++) {
      symbols[position] = s;
      do {
        position = (position + step) & tableMask;
      } while (position > highThreshold);
    }
  }
  if (position !== 0) throw new ZstdError("FSE distribution does not fill the table");
  // The state rows (the doc's sorted-range rule): nbBits from the running
  // per-symbol counter, baseline = the scaled counter value.
  const newStateBase = new Int32Array(tableSize);
  const transitionBits = new Uint8Array(tableSize);
  for (let u = 0; u < tableSize; u++) {
    const symbol = symbols[u] ?? 0;
    const nextState = symbolNext[symbol] ?? 0;
    symbolNext[symbol] = nextState + 1;
    const nbBits = accuracyLog - highestBit(nextState);
    transitionBits[u] = nbBits;
    newStateBase[u] = (nextState << nbBits) - tableSize;
  }
  return { accuracyLog, symbols, newStateBase, transitionBits };
}

/** Build a table straight from a distribution (the predefined codes). */
function fseTableFromCounts(counts: number[], accuracyLog: number): FseTable {
  const normalized = new Int16Array(counts.length);
  normalized.set(counts);
  return fseBuildTable(normalized, counts.length - 1, accuracyLog);
}

/**
 * The two-state FSE walk over the Huffman weights
 * (FSE_decompress_usingDTable_generic's tail semantics): states alternate
 * starting with state1; the walk ends when a state update reads past the
 * stream start (remaining negative) — the other state's symbol still
 * decodes and the loop stops there.
 */
function hufDecodeWeightsFse(
  weights: Uint8Array,
  maxWeights: number,
  bytes: Uint8Array,
  start: number,
  size: number,
): number {
  const counts = new Int16Array(256);
  const parsed = fseReadNormalizedCounts(bytes, start, start + size, counts);
  if (parsed.accuracyLog > 6) throw new ZstdError("Huffman weight FSE accuracy too large");
  const table = fseBuildTable(counts, parsed.maxSymbol, parsed.accuracyLog);
  const br = new BitReaderBackward(bytes, start + parsed.length, start + size);
  let state1 = br.readBits(table.accuracyLog);
  let state2 = br.readBits(table.accuracyLog);
  let count = 0;
  for (;;) {
    if (count >= maxWeights) throw new ZstdError("too many Huffman weights");
    weights[count++] = table.symbols[state1] ?? 0;
    state1 = (table.newStateBase[state1] ?? 0) + br.readBits(table.transitionBits[state1] ?? 0);
    // Only a true over-read ends the walk (the C's reload-overflow test):
    // an exact-to-zero update keeps going — the next update zero-fills,
    // over-reads, and its state's symbol still decodes.
    if (br.bitsLeft() < 0) {
      if (count >= maxWeights) throw new ZstdError("too many Huffman weights");
      weights[count++] = table.symbols[state2] ?? 0;
      break;
    }
    if (count >= maxWeights) throw new ZstdError("too many Huffman weights");
    weights[count++] = table.symbols[state2] ?? 0;
    state2 = (table.newStateBase[state2] ?? 0) + br.readBits(table.transitionBits[state2] ?? 0);
    if (br.bitsLeft() < 0) {
      if (count >= maxWeights) throw new ZstdError("too many Huffman weights");
      weights[count++] = table.symbols[state1] ?? 0;
      break;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Huffman literals — the weight parse (entropy_common.c HUF_readStats_body:
// the direct 4-bit representation or the FSE-compressed form, the implied
// last weight, the rank-1 validity gate), the X1 table build
// (huf_decompress.c HUF_readDTableX1_wksp: symbols sorted by weight then
// symbol order, each weight-w symbol taking 2^(w-1) consecutive slots with
// nbBits = tableLog + 1 - w), and the backward stream decode (1 stream, or
// 4 behind a 6-byte jump table).
// ---------------------------------------------------------------------------

const HUF_TABLELOG_MAX = 11;
const MIN_LITERALS_FOR_4_STREAMS = 6;

interface HufTable {
  tableLog: number;
  /** 2^tableLog slots: the symbol and its code length per slot. */
  symbols: Uint8Array;
  nbBits: Uint8Array;
}

/**
 * Parse the Huffman tree description into the X1 table. Returns the
 * description's byte length (it sits between the literals header and the
 * coded streams).
 */
function hufReadTable(
  bytes: Uint8Array,
  start: number,
  size: number,
): { length: number; table: HufTable } {
  if (size === 0) throw new ZstdError("empty Huffman tree description");
  const headerByte = bytes[start] ?? 0;
  const weights = new Uint8Array(256);
  let weightCount: number;
  let length: number;
  if (headerByte >= 128) {
    // Direct 4-bit representation (2 weights per byte, high nibble first).
    weightCount = headerByte - 127;
    length = 1 + ((weightCount + 1) >> 1);
    if (length > size) throw new ZstdError("truncated Huffman tree description");
    for (let n = 0; n < weightCount; n++) {
      const byte = bytes[start + 1 + (n >> 1)] ?? 0;
      weights[n] = (n & 1) === 0 ? byte >> 4 : byte & 15;
    }
  } else {
    // FSE-compressed weights: headerByte is the weight-stream size
    // (the C's iSize — the FSE walk is bounded by exactly those bytes).
    const weightsSize = headerByte;
    length = 1 + weightsSize;
    if (length > size) throw new ZstdError("truncated Huffman tree description");
    weightCount = hufDecodeWeightsFse(weights, 255, bytes, start + 1, weightsSize);
  }

  // Weight stats + the implied last weight (the clean power-of-2 rule).
  let weightTotal = 0;
  const rankStats = new Uint32Array(HUF_TABLELOG_MAX + 2);
  for (let n = 0; n < weightCount; n++) {
    const w = weights[n] ?? 0;
    if (w > HUF_TABLELOG_MAX) throw new ZstdError("Huffman weight out of range");
    rankStats[w] = (rankStats[w] ?? 0) + 1;
    weightTotal += (1 << w) >> 1;
  }
  if (weightTotal === 0) throw new ZstdError("empty Huffman tree");
  const tableLog = highestBit(weightTotal) + 1;
  if (tableLog > HUF_TABLELOG_MAX) throw new ZstdError("Huffman tree too deep");
  const rest = (1 << tableLog) - weightTotal;
  const lastWeight = highestBit(rest) + 1;
  if ((1 << highestBit(rest)) !== rest) {
    throw new ZstdError("Huffman tree does not complete to a power of 2");
  }
  weights[weightCount] = lastWeight;
  rankStats[lastWeight] = (rankStats[lastWeight] ?? 0) + 1;
  weightCount++;
  if ((rankStats[1] ?? 0) < 2 || ((rankStats[1] ?? 0) & 1) !== 0) {
    throw new ZstdError("invalid Huffman rank-1 population");
  }

  // The X1 table: present symbols sorted by weight (ties by symbol order);
  // each weight-w symbol takes 2^(w-1) consecutive slots from slot 0.
  const present: number[] = [];
  for (let n = 0; n < weightCount; n++) {
    if ((weights[n] ?? 0) > 0) present.push(n);
  }
  present.sort((a, b) => (weights[a] ?? 0) - (weights[b] ?? 0) || a - b);
  const tableSize = 1 << tableLog;
  const tableSymbols = new Uint8Array(tableSize);
  const tableBits = new Uint8Array(tableSize);
  let slot = 0;
  let cursor = 0;
  for (let w = 1; w <= tableLog; w++) {
    const nbBits = tableLog + 1 - w;
    const slotLength = (1 << w) >> 1;
    while (cursor < present.length && (weights[present[cursor] ?? 0] ?? 0) === w) {
      const symbol = present[cursor++] ?? 0;
      tableSymbols.fill(symbol, slot, slot + slotLength);
      tableBits.fill(nbBits, slot, slot + slotLength);
      slot += slotLength;
    }
  }
  if (slot !== tableSize) throw new ZstdError("Huffman table did not fill completely");
  return { length, table: { tableLog, symbols: tableSymbols, nbBits: tableBits } };
}

/** Decode one Huffman bitstream into out[outStart, outEnd). The stream
 *  must end exactly consumed (BIT_endOfDStream). */
function hufDecodeStream(
  table: HufTable,
  bytes: Uint8Array,
  start: number,
  size: number,
  out: Uint8Array,
  outStart: number,
  outEnd: number,
): void {
  const br = new BitReaderBackward(bytes, start, start + size);
  let cursor = outStart;
  while (cursor < outEnd) {
    // Peek the table index (tableLog bits), then consume only the
    // symbol's own code length — the reference's look/skip split.
    const slot = br.peekBits(table.tableLog);
    out[cursor++] = table.symbols[slot] ?? 0;
    br.readBits(table.nbBits[slot] ?? 0);
  }
  if (!br.atExactEnd()) throw new ZstdError("Huffman stream not fully consumed");
}

// ---------------------------------------------------------------------------
// The literals section (ZSTD_decodeLiteralsBlock).
// ---------------------------------------------------------------------------

const LITERALS_TYPE_RAW = 0;
const LITERALS_TYPE_RLE = 1;
const LITERALS_TYPE_COMPRESSED = 2;
const LITERALS_TYPE_TREELESS = 3;

interface LiteralsSection {
  literals: Uint8Array;
  /** The section's total byte length (header + tree + streams). */
  length: number;
  /** The table for later treeless arms (unchanged for raw/RLE). */
  table: HufTable | null;
}

/**
 * Decode one compressed block's literals section. `previousTable` carries
 * the treeless arm's table (null before the first compressed-literals
 * block — corruption per the spec).
 */
function decodeLiteralsSection(
  bytes: Uint8Array,
  start: number,
  size: number,
  blockSizeMax: number,
  previousTable: HufTable | null,
): LiteralsSection {
  const b0 = bytes[start] ?? 0;
  const type = b0 & 3;
  const sizeFormat = (b0 >> 2) & 3;
  let headerSize: number;
  let regeneratedSize: number;

  if (type === LITERALS_TYPE_RAW || type === LITERALS_TYPE_RLE) {
    if (sizeFormat === 0 || sizeFormat === 2) {
      headerSize = 1;
      regeneratedSize = b0 >> 3;
    } else if (sizeFormat === 1) {
      headerSize = 2;
      regeneratedSize = ((b0 >> 4) | ((bytes[start + 1] ?? 0) << 4)) & 0xfff;
    } else {
      headerSize = 3;
      regeneratedSize =
        ((b0 >> 4) | ((bytes[start + 1] ?? 0) << 4) | ((bytes[start + 2] ?? 0) << 12)) & 0xfffff;
    }
    if (regeneratedSize > blockSizeMax) throw new ZstdError("literals exceed the block maximum");
    const dataStart = start + headerSize;
    if (dataStart + (type === LITERALS_TYPE_RAW ? regeneratedSize : 1) > start + size) {
      throw new ZstdError("literals overrun the block");
    }
    const literals = new Uint8Array(regeneratedSize);
    if (type === LITERALS_TYPE_RAW) {
      literals.set(bytes.subarray(dataStart, dataStart + regeneratedSize));
    } else {
      literals.fill(bytes[dataStart] ?? 0);
    }
    return {
      literals,
      length: headerSize + (type === LITERALS_TYPE_RAW ? regeneratedSize : 1),
      table: previousTable,
    };
  }

  // Compressed / Treeless: both sizes ride the header.
  let compressedSize: number;
  if (sizeFormat === 0 || sizeFormat === 1) {
    headerSize = 3;
    const header =
      (b0 | ((bytes[start + 1] ?? 0) << 8) | ((bytes[start + 2] ?? 0) << 16)) >>> 0;
    regeneratedSize = (header >> 4) & 0x3ff;
    compressedSize = (header >> 14) & 0x3ff;
  } else if (sizeFormat === 2) {
    headerSize = 4;
    const header =
      (b0 |
        ((bytes[start + 1] ?? 0) << 8) |
        ((bytes[start + 2] ?? 0) << 16) |
        ((bytes[start + 3] ?? 0) << 24)) >>>
      0;
    regeneratedSize = (header >> 4) & 0x3fff;
    compressedSize = (header >>> 18) & 0x3fff;
  } else {
    headerSize = 5;
    regeneratedSize =
      ((b0 >> 4) |
        ((bytes[start + 1] ?? 0) << 4) |
        ((bytes[start + 2] ?? 0) << 12) |
        ((bytes[start + 3] ?? 0) << 20)) &
      0x3ffff;
    compressedSize =
      (((bytes[start + 3] ?? 0) >>> 6) | ((bytes[start + 4] ?? 0) << 2)) & 0x3ffff;
  }
  if (regeneratedSize > blockSizeMax) throw new ZstdError("literals exceed the block maximum");
  if (compressedSize === 0) throw new ZstdError("empty compressed literals");
  if (headerSize + compressedSize > size) throw new ZstdError("compressed literals overrun the block");

  const literals = new Uint8Array(regeneratedSize);
  const dataStart = start + headerSize;
  let table: HufTable | null;
  let treeLength: number;
  if (type === LITERALS_TYPE_COMPRESSED) {
    const parsed = hufReadTable(bytes, dataStart, compressedSize);
    table = parsed.table;
    treeLength = parsed.length;
  } else {
    if (type !== LITERALS_TYPE_TREELESS || previousTable === null) {
      throw new ZstdError("treeless literals without a previous Huffman table");
    }
    table = previousTable;
    treeLength = 0;
  }
  const streamsSize = compressedSize - treeLength;
  if (sizeFormat === 0) {
    // Single stream.
    hufDecodeStream(table, bytes, dataStart + treeLength, streamsSize, literals, 0, regeneratedSize);
  } else {
    // 4 interleaved streams behind a 6-byte jump table (2-byte LE sizes
    // for streams 1-3; stream 4 runs to the section's end).
    if (regeneratedSize < MIN_LITERALS_FOR_4_STREAMS) {
      throw new ZstdError("4-stream literals below the minimum size");
    }
    if (streamsSize < 10) throw new ZstdError("4-stream literals too small");
    const jumpStart = dataStart + treeLength;
    const l1 = (bytes[jumpStart] ?? 0) | ((bytes[jumpStart + 1] ?? 0) << 8);
    const l2 = (bytes[jumpStart + 2] ?? 0) | ((bytes[jumpStart + 3] ?? 0) << 8);
    const l3 = (bytes[jumpStart + 4] ?? 0) | ((bytes[jumpStart + 5] ?? 0) << 8);
    const s1Start = jumpStart + 6;
    const s2Start = s1Start + l1;
    const s3Start = s2Start + l2;
    const s4Start = s3Start + l3;
    const s4Size = streamsSize - 6 - l1 - l2 - l3;
    if (s4Size < 1 || s4Start + s4Size > dataStart + compressedSize) {
      throw new ZstdError("Huffman jump table overruns the literals");
    }
    const segmentSize = (regeneratedSize + 3) >> 2;
    const seg1End = segmentSize;
    const seg2End = seg1End + segmentSize;
    const seg3End = seg2End + segmentSize;
    hufDecodeStream(table, bytes, s1Start, l1, literals, 0, seg1End);
    hufDecodeStream(table, bytes, s2Start, l2, literals, seg1End, seg2End);
    hufDecodeStream(table, bytes, s3Start, l3, literals, seg2End, seg3End);
    hufDecodeStream(table, bytes, s4Start, s4Size, literals, seg3End, regeneratedSize);
  }
  return { literals, length: headerSize + compressedSize, table };
}

// ---------------------------------------------------------------------------
// The sequences section (ZSTD_decodeSeqHeaders + ZSTD_decodeSequence +
// ZSTD_execSequence). The per-symbol base/extra-bit tables are the
// reference's (zstd_decompress_internal.h); OF_base = 2^code - 3 for
// codes ≥ 2 — the repeat codes ride their own branches.
// ---------------------------------------------------------------------------

const MAX_LL = 35;
const MAX_ML = 52;
const MAX_OFF = 31;
const LL_FSE_LOG = 9;
const ML_FSE_LOG = 9;
const OFF_FSE_LOG = 8;

const LL_BITS = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11,
  12, 13, 14, 15, 16,
]);
const LL_BASE = new Uint32Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64,
  128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
]);
const ML_BITS = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
]);
const ML_BASE = new Uint32Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051,
  4099, 8195, 16387, 32771, 65539,
]);
const OF_BITS = new Uint8Array(Array.from({ length: MAX_OFF + 1 }, (_, code) => code));
const OF_BASE = new Uint32Array(
  Array.from({ length: MAX_OFF + 1 }, (_, code) => (code < 2 ? code : (1 << code) - 3)),
);

const LL_DEFAULT_NORM = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
  -1, -1, -1, -1,
];
const ML_DEFAULT_NORM = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1,
  -1, -1, -1, -1, -1,
];
const OF_DEFAULT_NORM = [
  1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1,
];

/** One sequence table: the FSE rows plus the per-symbol base/extra bits. */
interface SeqTable {
  fse: FseTable;
  extraBits: Uint8Array;
  baseline: Uint32Array;
}

function makeSeqTable(fse: FseTable, extraBits: Uint8Array, baseline: Uint32Array): SeqTable {
  return { fse, extraBits, baseline };
}

/** The three predefined tables (module-level, built once, immutable). */
const LL_PREDEF = makeSeqTable(fseTableFromCounts(LL_DEFAULT_NORM, 6), LL_BITS, LL_BASE);
const ML_PREDEF = makeSeqTable(fseTableFromCounts(ML_DEFAULT_NORM, 6), ML_BITS, ML_BASE);
const OF_PREDEF = makeSeqTable(fseTableFromCounts(OF_DEFAULT_NORM, 5), OF_BITS, OF_BASE);

const SEQ_MODE_PREDEFINED = 0;
const SEQ_MODE_RLE = 1;
const SEQ_MODE_FSE = 2;
const SEQ_MODE_REPEAT = 3;

/**
 * Decode one sequence table (ZSTD_buildSeqTable). Returns the table and
 * the consumed byte count.
 */
function decodeSeqTable(
  mode: number,
  bytes: Uint8Array,
  start: number,
  end: number,
  maxSymbol: number,
  maxAccuracy: number,
  predefined: SeqTable,
  extraBits: Uint8Array,
  baseline: Uint32Array,
  previous: SeqTable | null,
): { table: SeqTable; length: number } {
  if (mode === SEQ_MODE_PREDEFINED) return { table: predefined, length: 0 };
  if (mode === SEQ_MODE_RLE) {
    const symbol = bytes[start] ?? 0;
    if (symbol > maxSymbol) throw new ZstdError("RLE sequence symbol out of range");
    // One row: fixed symbol, zero transition bits — the state never moves.
    const fse: FseTable = {
      accuracyLog: 0,
      symbols: Uint8Array.of(symbol),
      newStateBase: Int32Array.of(0),
      transitionBits: Uint8Array.of(0),
    };
    return { table: makeSeqTable(fse, extraBits, baseline), length: 1 };
  }
  if (mode === SEQ_MODE_REPEAT) {
    if (previous === null) throw new ZstdError("repeat sequence mode without a previous table");
    return { table: previous, length: 0 };
  }
  if (mode !== SEQ_MODE_FSE) throw new ZstdError("unknown sequence mode");
  // FSE_Compressed_Mode.
  const counts = new Int16Array(maxSymbol + 1);
  const parsed = fseReadNormalizedCounts(bytes, start, end, counts);
  if (parsed.accuracyLog > maxAccuracy) throw new ZstdError("sequence FSE accuracy too large");
  return {
    table: makeSeqTable(fseBuildTable(counts, parsed.maxSymbol, parsed.accuracyLog), extraBits, baseline),
    length: parsed.length,
  };
}

/** The per-frame entropy state (tables + repeat offsets — frames are
 *  independent, so this is created fresh per frame and passed down). */
interface FrameEntropy {
  hufTable: HufTable | null;
  llTable: SeqTable | null;
  mlTable: SeqTable | null;
  ofTable: SeqTable | null;
  reps: number[];
}

/**
 * Decode a compressed block's sequences and execute them against the
 * frame output buffer (ZSTD_decompressSequences + ZSTD_execSequence).
 * `output` holds the frame's bytes decoded so far; this block appends at
 * `outputStart`. Returns the section's byte length and the appended
 * output size.
 */
function decodeAndExecuteSequences(
  bytes: Uint8Array,
  start: number,
  size: number,
  literals: Uint8Array,
  output: Uint8Array,
  outputStart: number,
  windowSize: number,
  blockSizeMax: number,
  frame: FrameEntropy,
): { length: number; appended: number } {
  const end = start + size;
  let cursor = start;

  // Number_of_Sequences (1-3 bytes, the 0xFF form adds 0x7F00).
  const b0 = bytes[cursor++] ?? 0;
  let nbSeq: number;
  if (b0 < 128) {
    nbSeq = b0;
  } else if (b0 < 255) {
    nbSeq = ((b0 - 0x80) << 8) | (bytes[cursor++] ?? 0);
  } else {
    nbSeq = ((bytes[cursor] ?? 0) | ((bytes[cursor + 1] ?? 0) << 8)) + 0x7f00;
    cursor += 2;
  }

  if (nbSeq === 0) {
    if (cursor !== end) throw new ZstdError("extraneous data after an empty sequences section");
    return { length: cursor - start, appended: 0 };
  }

  // Symbol compression modes (LL | OF | ML, top to bottom; reserved low
  // bits must be zero).
  const modesByte = bytes[cursor++] ?? 0;
  if ((modesByte & 3) !== 0) throw new ZstdError("reserved sequence mode bits set");
  const llMode = modesByte >> 6;
  const ofMode = (modesByte >> 4) & 3;
  const mlMode = (modesByte >> 2) & 3;

  // Table order: LL, OF, ML.
  const llParsed = decodeSeqTable(llMode, bytes, cursor, end, MAX_LL, LL_FSE_LOG, LL_PREDEF, LL_BITS, LL_BASE, frame.llTable);
  cursor += llParsed.length;
  const ofParsed = decodeSeqTable(ofMode, bytes, cursor, end, MAX_OFF, OFF_FSE_LOG, OF_PREDEF, OF_BITS, OF_BASE, frame.ofTable);
  cursor += ofParsed.length;
  const mlParsed = decodeSeqTable(mlMode, bytes, cursor, end, MAX_ML, ML_FSE_LOG, ML_PREDEF, ML_BITS, ML_BASE, frame.mlTable);
  cursor += mlParsed.length;
  frame.llTable = llParsed.table;
  frame.ofTable = ofParsed.table;
  frame.mlTable = mlParsed.table;

  // The backward bitstream carries the states + extra bits to the end.
  const br = new BitReaderBackward(bytes, cursor, end);

  // Initial states: LL, OF, ML (each its own accuracyLog).
  let llState = br.readBits(llParsed.table.fse.accuracyLog);
  let ofState = br.readBits(ofParsed.table.fse.accuracyLog);
  let mlState = br.readBits(mlParsed.table.fse.accuracyLog);

  const reps = frame.reps;
  let literalCursor = 0;
  let outPos = outputStart;

  const appendLiterals = (count: number): void => {
    if (literalCursor + count > literals.byteLength) {
      throw new ZstdError("sequence consumes more literals than present");
    }
    if (outPos + count > output.byteLength) {
      throw new ZstdError("literal output overruns the output buffer");
    }
    output.set(literals.subarray(literalCursor, literalCursor + count), outPos);
    literalCursor += count;
    outPos += count;
  };

  const appendMatch = (offset: number, length: number): void => {
    if (offset > outPos) throw new ZstdError("sequence offset before the output start");
    if (offset > windowSize) throw new ZstdError("sequence offset exceeds the window size");
    if (outPos + length > output.byteLength) {
      throw new ZstdError("match output overruns the output buffer");
    }
    // THE OVERLAP-COPY TRAP: offset < length self-references the bytes
    // just written — copy byte-by-byte forward (ZSTD_safecopy semantics;
    // a chunked set() corrupts overlapping matches).
    let src = outPos - offset;
    for (let i = 0; i < length; i++) {
      output[outPos++] = output[src++] ?? 0;
    }
  };

  for (let seqIndex = 0; seqIndex < nbSeq; seqIndex++) {
    const isLast = seqIndex === nbSeq - 1;
    const llCode = llParsed.table.fse.symbols[llState] ?? 0;
    const mlCode = mlParsed.table.fse.symbols[mlState] ?? 0;
    const ofCode = ofParsed.table.fse.symbols[ofState] ?? 0;
    const ll0 = (llParsed.table.baseline[llCode] ?? 0) === 0;

    // Bit order: offset bits, then match-length bits, then
    // literals-length bits — then the LL → ML → OF state updates.
    let offset: number;
    if (ofCode > 1) {
      offset = (ofParsed.table.baseline[ofCode] ?? 0) + br.readBits(ofCode);
      reps[2] = reps[1] as number;
      reps[1] = reps[0] as number;
      reps[0] = offset;
    } else if (ofCode === 0) {
      offset = reps[ll0 ? 1 : 0] as number;
      reps[1] = reps[ll0 ? 0 : 1] as number;
      reps[0] = offset;
    } else {
      const value = 1 + (ll0 ? 1 : 0) + br.readBits(1);
      const repeat = value === 3 ? (reps[0] as number) - 1 : (reps[value] as number);
      if (repeat <= 0) throw new ZstdError("invalid repeat offset (zero)");
      if (value !== 1) reps[2] = reps[1] as number;
      reps[1] = reps[0] as number;
      reps[0] = repeat;
      offset = repeat;
    }

    let matchLength = mlParsed.table.baseline[mlCode] ?? 0;
    if ((mlParsed.table.extraBits[mlCode] ?? 0) > 0) {
      matchLength += br.readBits(mlParsed.table.extraBits[mlCode] ?? 0);
    }
    let literalLength = llParsed.table.baseline[llCode] ?? 0;
    if ((llParsed.table.extraBits[llCode] ?? 0) > 0) {
      literalLength += br.readBits(llParsed.table.extraBits[llCode] ?? 0);
    }

    if (!isLast) {
      llState =
        (llParsed.table.fse.newStateBase[llState] ?? 0) +
        br.readBits(llParsed.table.fse.transitionBits[llState] ?? 0);
      mlState =
        (mlParsed.table.fse.newStateBase[mlState] ?? 0) +
        br.readBits(mlParsed.table.fse.transitionBits[mlState] ?? 0);
      ofState =
        (ofParsed.table.fse.newStateBase[ofState] ?? 0) +
        br.readBits(ofParsed.table.fse.transitionBits[ofState] ?? 0);
      if (llState < 0 || llState >= 1 << llParsed.table.fse.accuracyLog) {
        throw new ZstdError("LL FSE state out of range");
      }
      if (mlState < 0 || mlState >= 1 << mlParsed.table.fse.accuracyLog) {
        throw new ZstdError("ML FSE state out of range");
      }
      if (ofState < 0 || ofState >= 1 << ofParsed.table.fse.accuracyLog) {
        throw new ZstdError("OF FSE state out of range");
      }
    }

    if (literalLength > 0) appendLiterals(literalLength);
    if (matchLength > 0) appendMatch(offset, matchLength);
  }

  if (!br.atExactEnd()) throw new ZstdError("sequence bitstream not fully consumed");

  // Leftover literals append after the last sequence.
  if (literalCursor < literals.byteLength) {
    appendLiterals(literals.byteLength - literalCursor);
  }
  const appended = outPos - outputStart;
  if (appended > blockSizeMax) throw new ZstdError("block output exceeds the block maximum");
  return { length: cursor - start, appended };
}

// ---------------------------------------------------------------------------
// The frame walk (ZSTD_getFrameHeader + ZSTD_decompressFrame).
// ---------------------------------------------------------------------------

const WINDOWLOG_LIMIT = 27; // ZSTD_WINDOWLOG_LIMIT_DEFAULT — the memory gate
const OUTPUT_CAP = 1 << 30; // 1 GiB — the hostile-stream gate
const ZSTD_BLOCK_MAX = 128 * 1024;
const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_LO = 0x184d2a50;
const SKIPPABLE_MAGIC_HI = 0x184d2a5f;

const BLOCK_TYPE_RAW = 0;
const BLOCK_TYPE_RLE = 1;
const BLOCK_TYPE_COMPRESSED = 2;

/**
 * Decompress one zstd frame starting at `start`. Returns the frame's
 * content and its total byte length (header + blocks + checksum).
 */
function decodeFrame(bytes: Uint8Array, start: number): { content: Uint8Array; length: number } {
  let cursor = start;
  if (u32ReadLe(bytes, cursor) !== ZSTD_MAGIC) throw new ZstdError("bad frame magic");
  cursor += 4;

  // Frame_Header_Descriptor.
  const fhd = bytes[cursor++] ?? 0;
  if ((fhd & 0x08) !== 0) throw new ZstdError("reserved frame header bit set");
  const checksumFlag = (fhd >> 2) & 1;
  const singleSegment = (fhd >> 5) & 1;
  const fcsFlag = fhd >> 6;
  const dictFlag = fhd & 3;

  // Window_Descriptor (absent for single-segment frames).
  let windowSize: number;
  if (!singleSegment) {
    const wlByte = bytes[cursor++] ?? 0;
    const windowLog = (wlByte >> 3) + 10; // ZSTD_WINDOWLOG_ABSOLUTEMIN
    if (windowLog > WINDOWLOG_LIMIT) {
      throw new ZstdError("frame requires too much memory (windowLog above 27)");
    }
    const windowBase = 1 << windowLog;
    windowSize = windowBase + ((windowBase >> 3) * (wlByte & 7));
  } else {
    windowSize = 0; // resolved from the frame content size below
  }

  // Dictionary_ID — REJECTED (the module header's posture).
  if (dictFlag !== 0) throw new ZstdError("dictionary frames are not supported");

  // Frame_Content_Size.
  let frameContentSize = -1;
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  if (fcsSize === 1) {
    frameContentSize = bytes[cursor] ?? 0;
  } else if (fcsSize === 2) {
    frameContentSize = ((bytes[cursor] ?? 0) | ((bytes[cursor + 1] ?? 0) << 8)) + 256;
  } else if (fcsSize === 4) {
    frameContentSize = u32ReadLe(bytes, cursor);
  } else if (fcsSize === 8) {
    const lo = u32ReadLe(bytes, cursor);
    const hi = u32ReadLe(bytes, cursor + 4);
    if (hi !== 0 || lo > OUTPUT_CAP) {
      throw new ZstdError("frame content size beyond the output cap");
    }
    frameContentSize = lo;
  }
  cursor += fcsSize;
  if (singleSegment) {
    windowSize = Math.max(frameContentSize < 0 ? 0 : frameContentSize, 1 << 10);
  }
  if (frameContentSize >= 0 && frameContentSize > OUTPUT_CAP) {
    throw new ZstdError("declared frame content size beyond the output cap");
  }

  const blockSizeMax = Math.min(windowSize, ZSTD_BLOCK_MAX);
  const frame: FrameEntropy = { hufTable: null, llTable: null, mlTable: null, ofTable: null, reps: [1, 4, 8] };

  // The output buffer: preallocated from the FCS, otherwise grown.
  let output: Uint8Array;
  let outputLength = 0;
  if (frameContentSize >= 0) {
    output = new Uint8Array(frameContentSize);
  } else {
    output = new Uint8Array(Math.max(64 * 1024, blockSizeMax));
  }
  const ensureOutput = (needed: number): void => {
    if (needed <= output.byteLength) return;
    if (needed > OUTPUT_CAP) throw new ZstdError("decoded output beyond the output cap");
    let grown = output.byteLength;
    while (grown < needed) grown *= 2;
    grown = Math.min(grown, OUTPUT_CAP);
    const next = new Uint8Array(grown);
    next.set(output);
    output = next;
  };

  // Blocks.
  let lastBlock = false;
  while (!lastBlock) {
    const header = u32ReadLe(bytes, cursor) & 0xffffff;
    cursor += 3;
    lastBlock = (header & 1) !== 0;
    const blockType = (header >> 1) & 3;
    const blockSize = header >> 3;
    if (blockType === 3) throw new ZstdError("reserved block type");
    if (blockSize > blockSizeMax) throw new ZstdError("block exceeds the block maximum");
    // An RLE block's content is ONE byte (Block_Size is the regenerated
    // count); raw/compressed blocks carry Block_Size content bytes.
    const contentSize = blockType === BLOCK_TYPE_RLE ? 1 : blockSize;
    if (cursor + contentSize > bytes.byteLength) throw new ZstdError("block overruns the input");

    if (blockType === BLOCK_TYPE_RAW) {
      ensureOutput(outputLength + blockSize);
      output.set(bytes.subarray(cursor, cursor + blockSize), outputLength);
      outputLength += blockSize;
      cursor += blockSize;
      continue;
    }
    if (blockType === BLOCK_TYPE_RLE) {
      ensureOutput(outputLength + blockSize);
      output.fill(bytes[cursor] ?? 0, outputLength, outputLength + blockSize);
      outputLength += blockSize;
      cursor += 1;
      continue;
    }

    // Compressed block: literals section, then sequences + execution.
    if (blockType !== BLOCK_TYPE_COMPRESSED) throw new ZstdError("unknown block type");
    if (blockSize < 2) throw new ZstdError("compressed block too small");
    if (frameContentSize < 0) ensureOutput(outputLength + blockSizeMax);
    const blockEnd = cursor + blockSize;
    const literals = decodeLiteralsSection(bytes, cursor, blockSize, blockSizeMax, frame.hufTable);
    frame.hufTable = literals.table;
    const sequences = decodeAndExecuteSequences(
      bytes,
      cursor + literals.length,
      blockEnd - cursor - literals.length,
      literals.literals,
      output,
      outputLength,
      windowSize,
      blockSizeMax,
      frame,
    );
    outputLength += sequences.appended;
    cursor = blockEnd;
  }

  if (frameContentSize >= 0 && outputLength !== frameContentSize) {
    throw new ZstdError("decoded size does not match the frame content size");
  }

  // Content checksum: the low 32 bits of XXH-64 over the decoded content.
  if (checksumFlag) {
    const stored = u32ReadLe(bytes, cursor);
    cursor += 4;
    const digest = xxh64(output.subarray(0, outputLength));
    if ((digest[1] >>> 0) !== stored) throw new ZstdError("frame checksum mismatch");
  }

  return { content: output.subarray(0, outputLength), length: cursor - start };
}

/**
 * Decompress a whole zstd stream (and any concatenated continuations).
 * Throws ZstdError on every malformed or checksum-failing input.
 */
export function zstdDecompress(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  let sawFrame = false;
  while (cursor < bytes.byteLength) {
    const magic = u32ReadLe(bytes, cursor);
    if (magic >= SKIPPABLE_MAGIC_LO && magic <= SKIPPABLE_MAGIC_HI) {
      // Skippable frame: magic + 4-byte size + user data, passed over.
      if (cursor + 8 > bytes.byteLength) throw new ZstdError("truncated skippable frame");
      const frameSize = u32ReadLe(bytes, cursor + 4);
      cursor += 8 + frameSize;
      if (cursor > bytes.byteLength) throw new ZstdError("truncated skippable frame");
      continue;
    }
    const frame = decodeFrame(bytes, cursor);
    chunks.push(frame.content);
    cursor += frame.length;
    sawFrame = true;
  }
  if (!sawFrame) throw new ZstdError("empty zstd stream");
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

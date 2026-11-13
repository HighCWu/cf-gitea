/**
 * A zero-dependency xz (XZ Utils format) DECODER — census B-58's codec tail.
 * Upstream accepts `control.tar.xz` members in a .deb upload
 * (modules/packages/debian/metadata.go:119-125 rides Go's
 * github.com/ulikunitz/xz Reader), while the platform has no xz surface at
 * compatibility_date 2026-10-23 (the DecompressionStream format union is
 * exactly "gzip" | "deflate" | "deflate-raw"). This module implements the
 * walk from the XZ file format spec (1.1.x, the form xz 5.4.x emits) with
 * the LZMA2 in-band chunk protocol and the classic LZMA range decoder
 * behind it (the algorithm family the LZMA SDK / liblzma reference
 * implement).
 *
 * The SERVE arm never touches this module: `Packages.xz` is an ENCODER-side
 * artifact (upstream builds it with the xz Writer at index-build time,
 * services/packages/debian/repository.go:184-187/:220, and serves the stored
 * bytes) — see ./xz-encode.ts. Decoding exists only for the upload
 * acceptance, so the reference simplifications mirror the landed zstd/bz2
 * decoder posture (whole-buffer in, whole-buffer out; loud rejections):
 *
 *  - FILTER CHAINS are limited to the single LZMA2 filter (id 0x21) —
 *    dpkg-deb/apt never wrap a control archive in BCJ/delta filters (those
 *    target executables); a chain of 2+ filters fails the block header;
 *  - CHECK TYPES: none (0x00), CRC32 (0x01), CRC64 (0x04) and SHA-256
 *    (0x0A) are verified; every other check id fails the stream header
 *    (no producer in the ecosystem's fixtures emits them — a recorded
 *    divergence, rejected loudly);
 *  - the index is cross-checked against the blocks actually decoded
 *    (record count, unpadded size, uncompressed size), the footer's
 *    backward size and flags are verified, and declared block sizes in the
 *    block header are verified — the format's own integrity gates, the
 *    role the bzip2 CRCs play for ./bz2.ts;
 *  - the LZMA2 chunk protocol per the spec: 0x00 ends the stream (required
 *    — the xz spec mandates the end marker), 0x01/0x02 are uncompressed
 *    chunks (dict reset / none), 0x80-0x9F LZMA chunks without reset,
 *    0xA0-0xBF LZMA chunks with a state reset (props UNCHANGED — no byte
 *    in the stream), 0xC0-0xDF state reset + a fresh props byte, and
 *    0xE0-0xFF those plus a dictionary reset; the first LZMA chunk must
 *    carry props; each chunk's range coder must consume exactly its
 *    declared compressed size;
 *  - the dict is effectively the block's own output window: every xz block
 *    starts an independent filter chain (liblzma semantics), so a match
 *    distance beyond the bytes decoded so far in the block fails the
 *    stream (the tolerated permissiveness: a mid-block dict reset does not
 *    mask pre-reset bytes — real encoders never emit one);
 *  - the decoded output is capped at the caller's budget (the debian upload
 *    passes the same 32 MiB control-archive gate upstream enforces with
 *    io.LimitReader on the DECODED stream, metadata.go:141-143) — the
 *    decompression-bomb gate rides the format, not the compressed size.
 *
 * Resource posture: whole-buffer in, whole-buffer out (the landed bz2/zstd
 * order; the control.tar member is tens of KiB). The LZMA decode walks one
 * preallocated Int32Array probability table (≤ ~14k words) and writes
 * matches straight into the block's output buffer — no separate ring
 * dictionary is needed because the whole block window lives in memory.
 */

import { crc32 } from "./distro-common";

/** The one error class for every malformed xz stream (the caller maps it
 *  onto the service's invalid-archive arm). */
export class XzError extends Error {
  constructor(detail: string) {
    super(`xz stream invalid: ${detail}`);
    this.name = "XzError";
  }
}

// ---------------------------------------------------------------------------
// CRC64 (the XZ Utils variant: the reflected ECMA-182 polynomial
// 0xC96C5795D7870F42, init all-ones, xorout all-ones, little-endian byte
// order). JS numbers cannot hold the 64-bit state, so the table is generated
// once with BigInt arithmetic and stored as lo/hi 32-bit halves.
// ---------------------------------------------------------------------------

const CRC64_POLY = 0xc96c5795d7870f42n;

function buildCrc64Tables(): { lo: Uint32Array; hi: Uint32Array } {
  const lo = new Uint32Array(256);
  const hi = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = BigInt(i);
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1n ? (c >> 1n) ^ CRC64_POLY : c >> 1n;
    }
    lo[i] = Number(c & 0xffffffffn) >>> 0;
    hi[i] = Number(c >> 32n) >>> 0;
  }
  return { lo, hi };
}

const CRC64_TABLES = buildCrc64Tables();

/** Fold one byte into a running CRC64 held as [lo, hi] 32-bit halves. */
function crc64Fold(lo: number, hi: number, byte: number): [number, number] {
  const idx = (lo ^ byte) & 0xff;
  const tableLo = CRC64_TABLES.lo[idx] ?? 0;
  const tableHi = CRC64_TABLES.hi[idx] ?? 0;
  const shiftedLo = (lo >>> 8) | ((hi & 0xff) << 24);
  const shiftedHi = hi >>> 8;
  return [(shiftedLo ^ tableLo) >>> 0, (shiftedHi ^ tableHi) >>> 0];
}

function crc64Bytes(bytes: Uint8Array): Uint8Array {
  let lo = 0xffffffff;
  let hi = 0xffffffff;
  for (const byte of bytes) {
    [lo, hi] = crc64Fold(lo, hi, byte);
  }
  lo = ~lo >>> 0;
  hi = ~hi >>> 0;
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, lo, true);
  view.setUint32(4, hi, true);
  return out;
}

// ---------------------------------------------------------------------------
// The LZMA range decoder (11-bit probability model).
// ---------------------------------------------------------------------------

const PROB_TOP = 1 << 11;
const PROB_INIT = PROB_TOP >> 1;
const PROB_MOVE = 5;
const RC_NORMALIZE_LOW = 1 << 24;

class RangeDecoder {
  range = 0xffffffff;
  code = 0;
  position = 0;
  private readonly bytes: Uint8Array;
  private readonly end: number;

  constructor(bytes: Uint8Array, start: number, end: number) {
    this.bytes = bytes;
    this.end = end;
    if (start + 5 > end) throw new XzError("range coder truncated header");
    if ((bytes[start] ?? 0) !== 0) throw new XzError("range coder first byte not zero");
    this.position = start + 1;
    let code = 0;
    for (let i = 0; i < 4; i++) {
      code = ((code << 8) | (bytes[this.position] ?? 0)) | 0;
      this.position += 1;
    }
    this.code = code >>> 0;
  }

  private normalize(): void {
    while (this.range < RC_NORMALIZE_LOW) {
      if (this.position >= this.end) throw new XzError("range coder past end of chunk");
      this.range = ((this.range << 8) | 0) >>> 0;
      this.code = (((this.code << 8) | (this.bytes[this.position] ?? 0)) | 0) >>> 0;
      this.position += 1;
    }
  }

  decodeBit(probs: Int32Array, index: number): number {
    const prob = probs[index] ?? 0;
    const bound = (this.range >>> 11) * prob;
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      probs[index] = prob + ((PROB_TOP - prob) >>> PROB_MOVE);
      bit = 0;
    } else {
      this.range -= bound;
      this.code = (this.code - bound) >>> 0;
      probs[index] = prob - (prob >>> PROB_MOVE);
      bit = 1;
    }
    this.normalize();
    return bit;
  }

  /** The bit-tree walk, most significant bit first (classic decodeBitTree). */
  decodeTree(numBits: number, base: number, probs: Int32Array): number {
    let symbol = 1;
    for (let i = 0; i < numBits; i++) {
      symbol = (symbol << 1) + this.decodeBit(probs, base + symbol);
    }
    return symbol - (1 << numBits);
  }

  /** The reverse bit-tree walk, least significant bit first. */
  decodeReverseTree(numBits: number, base: number, probs: Int32Array): number {
    let symbol = 0;
    let scale = 1;
    for (let i = 0; i < numBits; i++) {
      const bit = this.decodeBit(probs, base + scale);
      symbol |= bit << i;
      scale = (scale << 1) + bit;
    }
    return symbol;
  }

  /** The direct-bits arm (no probability model), most significant first. */
  decodeDirectBits(numBits: number): number {
    let result = 0;
    for (let i = 0; i < numBits; i++) {
      this.range = (this.range >>> 1) >>> 0;
      this.code = (this.code - this.range) >>> 0;
      const masked = 0 - (this.code >>> 31);
      this.code = (this.code + (this.range & masked)) >>> 0;
      if (this.code === this.range) throw new XzError("range coder direct-bits overflow");
      this.normalize();
      result = (result << 1) + (masked + 1);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// The LZMA decoder proper — the probability table and the symbol walk.
// ---------------------------------------------------------------------------

const NUM_STATES = 12;
const MATCH_MIN_LEN = 2;
const NUM_LEN_TO_POS_STATES = 4;
const END_POS_MODEL_INDEX = 14;
const NUM_ALIGN_BITS = 4;
const ALIGN_SIZE = 1 << NUM_ALIGN_BITS;
const EOPM_DISTANCE = 0xffffffff;
/** One length coder: choice + choice2 + low(16 posStates x 8) + mid(128) + high(256). */
const LEN_CODER_SIZE = 2 + 128 + 128 + 256;

/**
 * The probability-table layout (this decoder's own offsets — allocation is
 * always at the lc+lp ≤ 4 maximum so a fresh props byte never reallocates):
 * literal (0x300 << 4), normal length coder, rep length coder, the
 * posState-indexed IsMatch/IsRep0Long matrices (12 states x 16 posStates —
 * the LzmaSpec.cpp `IsMatch[(state << kNumPosBitsMax) + posState]` layout,
 * the desync bug class if flattened to state-only), the four 12-entry
 * rep-decision sections, the 6-bit posSlot trees (4 len contexts), the
 * spec-pos trees (bounded by the slot-14 geometry the reverse walks reach),
 * the 4-bit align tree.
 */
const BASE_LITERAL = 0;
const LITERAL_SIZE = 0x300 << 4;
const BASE_LEN_NORMAL = BASE_LITERAL + LITERAL_SIZE;
const BASE_LEN_REP = BASE_LEN_NORMAL + LEN_CODER_SIZE;
const BASE_IS_MATCH = BASE_LEN_REP + LEN_CODER_SIZE;
const BASE_IS_MATCH_SIZE = NUM_STATES << 4;
const BASE_IS_REP = BASE_IS_MATCH + BASE_IS_MATCH_SIZE;
const BASE_IS_REP_G0 = BASE_IS_REP + NUM_STATES;
const BASE_IS_REP_G1 = BASE_IS_REP_G0 + NUM_STATES;
const BASE_IS_REP_G2 = BASE_IS_REP_G1 + NUM_STATES;
const BASE_IS_REP0_LONG = BASE_IS_REP_G2 + NUM_STATES;
const BASE_IS_REP0_LONG_SIZE = NUM_STATES << 4;
const BASE_POS_SLOT = BASE_IS_REP0_LONG + BASE_IS_REP0_LONG_SIZE;
const BASE_SPEC_POS = BASE_POS_SLOT + NUM_LEN_TO_POS_STATES * 64;
const BASE_ALIGN = BASE_SPEC_POS + 128;
const PROBS_TOTAL = BASE_ALIGN + ALIGN_SIZE;

const LZMA_STATE_LITERAL = (state: number): number => (state < 4 ? 0 : state < 10 ? state - 3 : state - 6);
const LZMA_STATE_MATCH = (state: number): number => (state < 7 ? 7 : 10);
const LZMA_STATE_REP = (state: number): number => (state < 7 ? 8 : 11);
const LZMA_STATE_SHORTREP = (state: number): number => (state < 7 ? 9 : 11);

/** One LZMA instance: the state the LZMA2 chunks carry across (unless reset). */
class LzmaDecoder {
  readonly probs = new Int32Array(PROBS_TOTAL);
  private state = 0;
  private readonly reps = [0, 0, 0, 0];
  private lc = 0;
  private lp = 0;
  private pb = 0;
  private lpMask = 0;
  private pbMask = 0;

  resetState(): void {
    this.probs.fill(PROB_INIT);
    this.state = 0;
    this.reps[0] = 0;
    this.reps[1] = 0;
    this.reps[2] = 0;
    this.reps[3] = 0;
  }

  setProps(propsByte: number): void {
    if (propsByte >= 9 * 5 * 5) throw new XzError("lzma props byte out of range");
    const lc = propsByte % 9;
    const rest = Math.floor(propsByte / 9);
    const lp = rest % 5;
    const pb = Math.floor(rest / 5);
    if (lc + lp > 4) throw new XzError("lzma props lc+lp above 4");
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    this.lpMask = (1 << lp) - 1;
    this.pbMask = (1 << pb) - 1;
  }

  /**
   * Decode symbols until `limit` bytes of `output` are produced. `output`
   * is the BLOCK's window (fresh per block), so positions are block-relative
   * and a distance is valid only if it reaches back into decoded bytes.
   */
  decode(rc: RangeDecoder, output: Uint8Array, start: number, limit: number): number {
    let pos = start;
    while (pos < limit) {
      const posState = pos & this.pbMask;
      if (rc.decodeBit(this.probs, BASE_IS_MATCH + (this.state << 4) + posState) === 0) {
        // Literal.
        const prevByte = pos > 0 ? (output[pos - 1] ?? 0) : 0;
        const litBase = BASE_LITERAL + 0x300 * (((pos & this.lpMask) << this.lc) + (prevByte >> (8 - this.lc)));
        let symbol = 1;
        if (this.state >= 7) {
          const dist0 = this.reps[0] ?? 0;
          if (dist0 >= pos) throw new XzError("matched-literal distance before start");
          let matchByte = output[pos - (dist0 + 1)] ?? 0;
          do {
            const matchBit = (matchByte >> 7) & 1;
            matchByte = (matchByte << 1) & 0xff;
            const bit = rc.decodeBit(this.probs, litBase + ((1 + matchBit) << 8) + symbol);
            symbol = (symbol << 1) + bit;
            if (bit !== matchBit) break; // the spec's early break — the remaining bits walk the plain tree
          } while (symbol < 0x100);
        }
        while (symbol < 0x100) {
          symbol = (symbol << 1) + rc.decodeBit(this.probs, litBase + symbol);
        }
        output[pos] = symbol & 0xff;
        pos += 1;
        this.state = LZMA_STATE_LITERAL(this.state);
        continue;
      }
      // Match family.
      let distance: number;
      let lengthValue: number;
      if (rc.decodeBit(this.probs, BASE_IS_REP + this.state) === 0) {
        // Simple match: shift the rep list, decode distance fresh.
        this.reps[3] = this.reps[2] ?? 0;
        this.reps[2] = this.reps[1] ?? 0;
        this.reps[1] = this.reps[0] ?? 0;
        lengthValue = this.decodeLength(rc, BASE_LEN_NORMAL, posState);
        const lenCtx = Math.min(lengthValue, NUM_LEN_TO_POS_STATES - 1);
        const posSlot = rc.decodeTree(6, BASE_POS_SLOT + lenCtx * 64, this.probs);
        if (posSlot < 4) {
          distance = posSlot;
        } else {
          const numDirectBits = (posSlot >> 1) - 1;
          // Multiplication, not `<<`: int32 shift wraps negative for the
          // slot-62/63 bases (3 << 30) — JS doubles carry the 32-bit value.
          distance = (2 | (posSlot & 1)) * (1 << numDirectBits);
          if (posSlot < END_POS_MODEL_INDEX) {
            distance += rc.decodeReverseTree(numDirectBits, BASE_SPEC_POS + distance - posSlot, this.probs);
          } else {
            distance += rc.decodeDirectBits(numDirectBits - NUM_ALIGN_BITS) << NUM_ALIGN_BITS;
            distance += rc.decodeReverseTree(NUM_ALIGN_BITS, BASE_ALIGN, this.probs);
          }
        }
        if (distance === EOPM_DISTANCE) throw new XzError("end-of-prop-marker inside lzma2");
        this.reps[0] = distance;
        this.state = LZMA_STATE_MATCH(this.state);
      } else if (rc.decodeBit(this.probs, BASE_IS_REP_G0 + this.state) === 0) {
        if (rc.decodeBit(this.probs, BASE_IS_REP0_LONG + (this.state << 4) + posState) === 0) {
          // Short rep: one byte at rep0.
          const dist0 = this.reps[0] ?? 0;
          if (dist0 >= pos) throw new XzError("shortrep distance before start");
          output[pos] = output[pos - (dist0 + 1)] ?? 0;
          pos += 1;
          this.state = LZMA_STATE_SHORTREP(this.state);
          continue;
        }
        distance = this.reps[0] ?? 0;
        lengthValue = this.decodeLength(rc, BASE_LEN_REP, posState);
        this.state = LZMA_STATE_REP(this.state);
      } else {
        if (rc.decodeBit(this.probs, BASE_IS_REP_G1 + this.state) === 0) {
          const tmp = this.reps[1] ?? 0;
          this.reps[1] = this.reps[0] ?? 0;
          this.reps[0] = tmp;
        } else if (rc.decodeBit(this.probs, BASE_IS_REP_G2 + this.state) === 0) {
          const tmp = this.reps[2] ?? 0;
          this.reps[2] = this.reps[1] ?? 0;
          this.reps[1] = this.reps[0] ?? 0;
          this.reps[0] = tmp;
        } else {
          const tmp = this.reps[3] ?? 0;
          this.reps[3] = this.reps[2] ?? 0;
          this.reps[2] = this.reps[1] ?? 0;
          this.reps[1] = this.reps[0] ?? 0;
          this.reps[0] = tmp;
        }
        distance = this.reps[0] ?? 0;
        lengthValue = this.decodeLength(rc, BASE_LEN_REP, posState);
        this.state = LZMA_STATE_REP(this.state);
      }
      const length = MATCH_MIN_LEN + lengthValue;
      if (distance >= pos) throw new XzError("match distance before start");
      if (pos + length > limit) throw new XzError("match copy past chunk end");
      let src = pos - (distance + 1);
      for (let i = 0; i < length; i++) {
        output[pos] = output[src] ?? 0;
        pos += 1;
        src += 1;
      }
    }
    return pos;
  }

  /**
   * The length decoder (choice/choice2 + low/mid/high trees). Returns the
   * raw tree value (0..7 low, 8..15 mid, 16..271 high); the caller adds
   * MATCH_MIN_LEN for the copy length (lengths 2..273).
   */
  private decodeLength(rc: RangeDecoder, base: number, posState: number): number {
    if (rc.decodeBit(this.probs, base) === 0) {
      return rc.decodeTree(3, base + 2 + posState * 8, this.probs);
    }
    if (rc.decodeBit(this.probs, base + 1) === 0) {
      return 8 + rc.decodeTree(3, base + 2 + 128 + posState * 8, this.probs);
    }
    return 16 + rc.decodeTree(8, base + 2 + 256, this.probs);
  }
}

// ---------------------------------------------------------------------------
// LZMA2 — the in-band chunk protocol on top of LZMA (one block's stream).
// ---------------------------------------------------------------------------

/** Decode one LZMA2 stream; returns the output and the offset just past its
 *  end marker (the block's padding+check follow from there). The LZMA
 *  lc/lp/pb props arrive IN-BAND per the chunk control byte's reset bits
 *  (the ulikunitz/xz header2.go ladder — upstream Gitea's own Go xz
 *  library): 0x80-0x9F no reset, 0xA0-0xBF state reset ONLY (no props byte
 *  in the stream), 0xC0-0xDF state reset + a fresh props byte, 0xE0-0xFF
 *  those plus a dictionary reset (a no-op for this whole-block window). The
 *  first LZMA chunk must therefore be a 0xC0-class one. */
function decodeLzma2Stream(
  input: Uint8Array,
  dataStart: number,
  dataEnd: number,
  declaredUncompressedSize: number | null,
  outputBudget: number,
): { output: Uint8Array; endPos: number } {
  const lzma = new LzmaDecoder();
  let propsSet = false;
  let output = new Uint8Array(declaredUncompressedSize ?? 4096);
  let outPos = 0;
  let cursor = dataStart;
  for (;;) {
    if (cursor >= dataEnd) throw new XzError("lzma2 stream truncated before end marker");
    const control = input[cursor] ?? 0;
    if (control === 0x00) {
      cursor += 1;
      break;
    }
    if (control <= 0x02) {
      // Uncompressed chunk (0x01 resets the dict — a no-op for this window).
      if (cursor + 3 > dataEnd) throw new XzError("uncompressed chunk header truncated");
      const size = (((input[cursor + 1] ?? 0) << 8) | (input[cursor + 2] ?? 0)) + 1;
      if (cursor + 3 + size > dataEnd) throw new XzError("uncompressed chunk truncated");
      if (outPos + size > output.byteLength) {
        if (declaredUncompressedSize !== null) throw new XzError("block output above declared size");
        if (outPos + size > outputBudget) throw new XzError("decoded output above the budget");
        const grown = new Uint8Array(Math.min(Math.max(output.byteLength * 2, outPos + size), outputBudget));
        grown.set(output.subarray(0, outPos));
        output = grown;
      }
      output.set(input.subarray(cursor + 3, cursor + 3 + size), outPos);
      outPos += size;
      cursor += 3 + size;
      continue;
    }
    // LZMA chunk. Reset bits (control >> 5) & 3: 0 no reset, 1 state reset
    // (props UNCHANGED), 2 state reset + fresh props byte, 3 those plus a
    // dictionary reset.
    if ((control & 0x80) === 0) throw new XzError(`invalid lzma2 control byte 0x${control.toString(16)}`);
    if (cursor + 5 > dataEnd) throw new XzError("lzma chunk header truncated");
    const uncompressedSize = ((control & 0x1f) << 16) + (((input[cursor + 1] ?? 0) << 8) | (input[cursor + 2] ?? 0)) + 1;
    const compressedSize = (((input[cursor + 3] ?? 0) << 8) | (input[cursor + 4] ?? 0)) + 1;
    cursor += 5;
    if (!propsSet && control < 0xc0) {
      throw new XzError("lzma chunk before any props byte");
    }
    if (control >= 0xc0) {
      if (cursor >= dataEnd) throw new XzError("lzma chunk props byte truncated");
      lzma.setProps(input[cursor] ?? 0);
      propsSet = true;
      cursor += 1;
    }
    if ((control & 0x60) !== 0) {
      lzma.resetState();
    }
    if (outPos + uncompressedSize > output.byteLength) {
      if (declaredUncompressedSize !== null) throw new XzError("block output above declared size");
      if (outPos + uncompressedSize > outputBudget) throw new XzError("decoded output above the budget");
      const grown = new Uint8Array(Math.min(Math.max(output.byteLength * 2, outPos + uncompressedSize), outputBudget));
      grown.set(output.subarray(0, outPos));
      output = grown;
    }
    const chunkEnd = cursor + compressedSize;
    if (chunkEnd > dataEnd) throw new XzError("lzma chunk data truncated");
    const rc = new RangeDecoder(input, cursor, chunkEnd);
    const endPos = lzma.decode(rc, output, outPos, outPos + uncompressedSize);
    if (endPos !== outPos + uncompressedSize) throw new XzError("lzma chunk short decode");
    if (rc.position !== chunkEnd) throw new XzError("lzma chunk range coder leftover");
    outPos = endPos;
    cursor = chunkEnd;
  }
  if (declaredUncompressedSize !== null && outPos !== declaredUncompressedSize) {
    throw new XzError("block output below declared size");
  }
  return { output: output.subarray(0, outPos), endPos: cursor };
}

// ---------------------------------------------------------------------------
// The xz container walk.
// ---------------------------------------------------------------------------

const STREAM_MAGIC = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);

export interface XzDecodeOptions {
  /** The decompression-bomb gate (the debian upload passes 32 MiB). */
  maxOutputBytes?: number;
}

const CHECK_TYPE_SIZE: Record<number, number> = { 0x00: 0, 0x01: 4, 0x04: 8, 0x0a: 32 };

function readVarint(input: Uint8Array, p: { value: number }, end: number): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (p.value >= end) throw new XzError("varint truncated");
    const byte = input[p.value] ?? 0;
    p.value += 1;
    if (shift >= 63) throw new XzError("varint too large");
    value += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
}

async function verifyCheck(checkType: number, output: Uint8Array, check: Uint8Array): Promise<void> {
  switch (checkType) {
    case 0x00:
      return;
    case 0x01: {
      const expected = new DataView(check.buffer, check.byteOffset, 4).getUint32(0, true);
      if (crc32(output) !== expected) throw new XzError("block crc32 check mismatch");
      return;
    }
    case 0x04: {
      const actual = crc64Bytes(output);
      for (let i = 0; i < 8; i++) {
        if ((actual[i] ?? 0) !== (check[i] ?? 0)) throw new XzError("block crc64 check mismatch");
      }
      return;
    }
    case 0x0a: {
      const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", output as unknown as BufferSource));
      for (let i = 0; i < 32; i++) {
        if ((actual[i] ?? 0) !== (check[i] ?? 0)) throw new XzError("block sha256 check mismatch");
      }
      return;
    }
    default:
      throw new XzError(`unsupported check type 0x${checkType.toString(16)}`);
  }
}

function expectBytes(input: Uint8Array, p: number, expected: Uint8Array, detail: string): void {
  for (let i = 0; i < expected.byteLength; i++) {
    if ((input[p + i] ?? 0) !== (expected[i] ?? 0)) throw new XzError(detail);
  }
}

/**
 * Decode an xz stream (concatenated streams decode in sequence; trailing
 * non-magic bytes are ignored the way `xz -d` tolerates trailing garbage).
 * The whole-buffer posture mirrors the landed bz2/zstd decoders.
 */
export async function xzDecode(input: Uint8Array, options: XzDecodeOptions = {}): Promise<Uint8Array> {
  const maxOutput = options.maxOutputBytes ?? Number.MAX_SAFE_INTEGER;
  const parts: Uint8Array[] = [];
  let totalOutput = 0;
  let p = 0;
  let sawStream = false;

  stream: for (;;) {
    // ---- Stream header ----
    if (p + 12 > input.byteLength) {
      if (sawStream) break; // trailing garbage tolerance ends the walk
      throw new XzError("stream header truncated");
    }
    if (sawStream) {
      // After a completed stream, a non-magic tail is trailing garbage —
      // tolerated the way `xz -d` tolerates it (it never looks like a
      // stream header, so the walk stops; a real header decodes onward).
      let isMagic = true;
      for (let i = 0; i < STREAM_MAGIC.byteLength; i++) {
        if ((input[p + i] ?? 0) !== (STREAM_MAGIC[i] ?? 0)) {
          isMagic = false;
          break;
        }
      }
      if (!isMagic) break;
    }
    expectBytes(input, p, STREAM_MAGIC, "not an xz stream");
    const flags0 = input[p + 6] ?? 0;
    const checkType = input[p + 7] ?? 0;
    if (flags0 !== 0x00) throw new XzError("reserved stream flag set");
    if (CHECK_TYPE_SIZE[checkType] === undefined) {
      throw new XzError(`unsupported check type 0x${checkType.toString(16)}`);
    }
    const headerCrc = new DataView(input.buffer, input.byteOffset + p + 8, 4).getUint32(0, true);
    if (headerCrc !== crc32(input.subarray(p + 6, p + 8))) throw new XzError("stream header crc mismatch");
    p += 12;
    sawStream = true;

    // ---- Blocks, then the index ----
    const records: { unpaddedSize: number; uncompressedSize: number }[] = [];
    for (;;) {
      const headerSizeByte = input[p] ?? 0;
      if (headerSizeByte === 0x00) {
        // ---- Index ----
        const indexStart = p;
        const q = { value: p + 1 };
        const count = readVarint(input, q, input.byteLength);
        if (count !== records.length) throw new XzError("index record count mismatch");
        for (let i = 0; i < count; i++) {
          const unpaddedSize = readVarint(input, q, input.byteLength);
          const uncompressedSize = readVarint(input, q, input.byteLength);
          const expected = records[i];
          if (expected === undefined || unpaddedSize !== expected.unpaddedSize || uncompressedSize !== expected.uncompressedSize) {
            throw new XzError("index record mismatch");
          }
        }
        p = q.value;
        p += (4 - ((p - indexStart) % 4)) % 4;
        const indexCrc = new DataView(input.buffer, input.byteOffset + p, 4).getUint32(0, true);
        if (indexCrc !== crc32(input.subarray(indexStart, p))) throw new XzError("index crc mismatch");
        p += 4;
        // ---- Stream footer: CRC32 | Backward Size (4) | Flags (2) | "YZ" (2) ----
        // (the CRC covers Backward Size + Stream Flags only — the magic
        // bytes sit OUTSIDE the check; fixture-verified against xz 5.4.5)
        if (p + 12 > input.byteLength) throw new XzError("stream footer truncated");
        const footerCrc = new DataView(input.buffer, input.byteOffset + p, 4).getUint32(0, true);
        if (footerCrc !== crc32(input.subarray(p + 4, p + 10))) throw new XzError("stream footer crc mismatch");
        const backwardSize = new DataView(input.buffer, input.byteOffset + p + 4, 4).getUint32(0, true) + 1;
        if (backwardSize * 4 !== p - indexStart) throw new XzError("index backward size mismatch");
        if ((input[p + 8] ?? 0) !== flags0 || (input[p + 9] ?? 0) !== checkType) {
          throw new XzError("stream footer flags mismatch");
        }
        expectBytes(input, p + 10, new Uint8Array([0x59, 0x5a]), "stream footer magic mismatch");
        p += 12;
        break; // this stream is done — a concatenated one may follow
      }

      // ---- Block header ----
      const headerRealSize = (headerSizeByte + 1) * 4;
      if (headerSizeByte > 0xf3 || p + headerRealSize + 4 > input.byteLength) {
        throw new XzError("block header truncated");
      }
      const headerCrcBlock = new DataView(input.buffer, input.byteOffset + p + headerRealSize - 4, 4).getUint32(0, true);
      if (headerCrcBlock !== crc32(input.subarray(p, p + headerRealSize - 4))) throw new XzError("block header crc mismatch");
      const q = { value: p + 1 };
      const headerEnd = p + headerRealSize - 4; // the CRC occupies the last 4 bytes
      const blockFlags = input[q.value] ?? 0;
      q.value += 1;
      if ((blockFlags & 0x3c) !== 0) throw new XzError("reserved block header bits set");
      // Bits 0-1 = filter count - 1; bit 6 = Compressed Size present;
      // bit 7 = Uncompressed Size present (the xz block_header_decoder.c
      // layout — these roles are NOT the other way around).
      const numFilters = (blockFlags & 0x03) + 1;
      const declaredCompressedSize = (blockFlags & 0x40) !== 0 ? readVarint(input, q, headerEnd) : null;
      const declaredUncompressedSize = (blockFlags & 0x80) !== 0 ? readVarint(input, q, headerEnd) : null;
      if (numFilters !== 1) throw new XzError(`filter chains of ${numFilters} not supported`);
      const filterId = readVarint(input, q, headerEnd);
      if (filterId !== 0x21) throw new XzError(`filter id 0x${filterId.toString(16)} not supported (lzma2 only)`);
      const propsSize = readVarint(input, q, headerEnd);
      if (propsSize !== 1) throw new XzError("lzma2 filter props size must be 1");
      // The LZMA2 filter's property byte is the DICTIONARY SIZE (the LZMA
      // lc/lp/pb props arrive in-band with the first LZMA2 chunk). Validate
      // the dict encoding (0 = 4 GiB, else the two-exponent form ≤ 2^32) and
      // ignore the value — this decoder's window is the whole block buffer.
      const dictSizeByte = input[q.value] ?? 0;
      if (dictSizeByte > 40) throw new XzError("lzma2 dict-size property above the encoding range");
      q.value += 1;
      for (let i = q.value; i < headerEnd; i++) {
        if ((input[i] ?? 0) !== 0) throw new XzError("block header padding not zero");
      }
      if (declaredUncompressedSize !== null && declaredUncompressedSize > maxOutput - totalOutput) {
        throw new XzError("decoded output above the budget");
      }
      p = headerEnd + 4; // past the header CRC

      // ---- Compressed data (one LZMA2 stream), padding, check ----
      const dataStart = p;
      const dataEnd = declaredCompressedSize !== null ? dataStart + declaredCompressedSize : input.byteLength;
      if (dataEnd > input.byteLength) throw new XzError("block data truncated");
      const decoded = decodeLzma2Stream(input, dataStart, dataEnd, declaredUncompressedSize, maxOutput - totalOutput);
      const blockOutput = decoded.output;
      if (blockOutput.byteLength + totalOutput > maxOutput) throw new XzError("decoded output above the budget");
      const lzma2Length = decoded.endPos - dataStart;
      if (declaredCompressedSize !== null && lzma2Length !== declaredCompressedSize) {
        throw new XzError("lzma2 stream size mismatch");
      }
      let cursor = dataStart + lzma2Length;
      const padding = (4 - (lzma2Length % 4)) % 4;
      for (let i = 0; i < padding; i++) {
        if ((input[cursor + i] ?? 0) !== 0) throw new XzError("block padding not zero");
      }
      cursor += padding;
      const checkSize = CHECK_TYPE_SIZE[checkType] ?? 0;
      if (cursor + checkSize > input.byteLength) throw new XzError("block check truncated");
      await verifyCheck(checkType, blockOutput, input.subarray(cursor, cursor + checkSize));
      // Unpadded Size = header + compressed data + check (the padding is the
      // only excluded part — fixture-verified against xz 5.4.5 output).
      records.push({ unpaddedSize: headerRealSize + lzma2Length + checkSize, uncompressedSize: blockOutput.byteLength });
      parts.push(blockOutput);
      totalOutput += blockOutput.byteLength;
      p = cursor + checkSize;
    }

    // A concatenated stream may follow; the loop re-enters at the header.
    if (p >= input.byteLength) break;
  }

  if (parts.length === 1) return parts[0] ?? new Uint8Array(0);
  const full = new Uint8Array(totalOutput);
  let offset = 0;
  for (const part of parts) {
    full.set(part, offset);
    offset += part.byteLength;
  }
  return full;
}

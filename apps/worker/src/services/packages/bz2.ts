/**
 * A zero-dependency bzip2 DECODER for the Composer `.tar.bz2` upload arm
 * (SPEC-0016 §7 composer row) — the platform has no bzip2 surface at
 * compatibility_date 2026-10-23 (the DecompressionStream format union is
 * exactly "gzip" | "deflate" | "deflate-raw"; a workerd probe rejects
 * bzip2/bz2/x-bzip2 with "The compression format must be either 'deflate',
 * 'deflate-raw' or 'gzip'"), while upstream accepts the format fully
 * (modules/packages/composer/metadata.go:146-149 dispatches pkgExtTarBz2
 * through Go's compress/bzip2.NewReader + the tar walk).
 *
 * The port follows Go's compress/bzip2 decoder (bzip2.go, huffman.go,
 * move_to_front.go at go1.25.1 — the exact library upstream imports)
 * rather than libbz2: decode-only, whole-buffer, with Go's own
 * simplifications kept for parity:
 *
 *  - RANDOMIZED blocks are REJECTED ("deprecated randomized block") —
 *    Go's stdlib answers StructuralError("deprecated randomized files")
 *    for the rand bit, so upstream itself cannot read them either (the
 *    encoder stopped emitting randomized blocks in bzip2 0.9.5, 1999);
 *  - CONCATENATED streams ("BZh" again after the final magic) decode in
 *    sequence like Go's reader (pbzip2-style output, not produced by the
 *    bzip2(1) tool);
 *  - every BLOCK CRC and the combined stream CRC are VERIFIED (the format
 *    is self-checking — a decode bug fails loudly on real fixtures);
 *  - the Huffman trees are canonical (codes of each length go to the
 *    symbols in ascending order — libbz2's hbAssignCodes), so decode
 *    tables reconstruct from the transmitted lengths alone; corrupt
 *    walks are bounded by the max-length over-run guard and the CRCs.
 *
 * Decode pipeline per block (the bzip2 stack, all O(n)):
 *   Huffman (2-6 selectable canonical trees, selector list MTF + unary
 *   coded, table switch every 50 symbols) → RUNA/RUNB run accumulation →
 *   move-to-front undo → inverse Burrows-Wheeler transform (the
 *   "single array" method: counting sort into the C array, the P vector
 *   in tt's upper bits — SRC-RR-124 §4.2) → the RLE1 undo (four equal
 *   bytes + one count byte, Go's lazy repeat walk) with the block CRC
 *   over the emitted bytes.
 *
 * Resource posture: one Uint32Array of the block size (≤ 900k entries,
 * 3.6 MB) per block — the same order as the landed zip/tar.gz arms'
 * whole-buffer inflation; block/selector/length/repeat bounds mirror the
 * format's own limits (blockSize, 18002 selectors, lengths 1..20, the
 * 2M repeat cap) so a hostile stream cannot drive the walk past them.
 */

/** The one error class for every malformed bzip2 stream (the caller maps
 *  it onto the service's invalid-archive arm). */
export class Bzip2Error extends Error {
  constructor(detail: string) {
    super(`bzip2 stream invalid: ${detail}`);
    this.name = "Bzip2Error";
  }
}

// ---------------------------------------------------------------------------
// The bit reader — MSB-first consumption over the byte array (Go's
// bitReader; a 56-bit-exact float accumulator replaces the uint64 shift:
// reads top up the accumulator whole bytes until `count` ≥ n, take the
// TOP n bits, leave the suffix; count never exceeds n + 7 ≤ 55).
// ---------------------------------------------------------------------------

class BzBitReader {
  private acc = 0; // the unconsumed suffix, ≤ 2^55 — exact in a double
  private count = 0; // the suffix's bit count
  private pos = 0; // the next byte index to pull

  constructor(private readonly bytes: Uint8Array) {}

  /** The next `n` bits (n ≤ 48), MSB-first. */
  readBits(n: number): number {
    if (n > 48) throw new Bzip2Error("oversized bit read");
    while (this.count < n) {
      if (this.pos >= this.bytes.byteLength) throw new Bzip2Error("unexpected end of stream");
      this.acc = this.acc * 256 + (this.bytes[this.pos++] ?? 0);
      this.count += 8;
    }
    const shift = this.count - n;
    const value = Math.floor(this.acc / 2 ** shift);
    this.acc -= value * 2 ** shift;
    this.count = shift;
    return value;
  }

  readBit(): number {
    return this.readBits(1);
  }

  /** Discard the partial byte at the stream footer (Go's "skip ahead to
   *  byte boundary"): after a 48-bit marker + a 32-bit CRC the buffered
   *  suffix is at most 7 bits, so dropping it lands on the next byte. */
  alignToByte(): void {
    this.acc = 0;
    this.count = 0;
  }

  atEnd(): boolean {
    return this.pos >= this.bytes.byteLength;
  }

  byteAt(index: number): number {
    return this.bytes[index] ?? 0;
  }

  get position(): number {
    return this.pos;
  }
}

// ---------------------------------------------------------------------------
// The bzip2 CRC (CRC-32 with REVERSED shifts — polynomial 0x04C11DB7
// MSB-first, the mirror image of hash/crc32's reflected table; Go's
// bzip2.go init()).
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

/** updateCRC (bzip2.go:494): `crc = table[byte(crc>>24) ^ v] ^ (crc << 8)`
 *  under a pre/post complement. */
function bzUpdateCrc(bytes: Uint8Array, from: number, to: number): number {
  let crc = 0xffffffff; // ~0 — updateCRC's initial ^val
  for (let i = from; i < to; i++) {
    crc = ((BZ_CRC_TABLE[(crc >>> 24) ^ (bytes[i] ?? 0)] ?? 0) ^ ((crc << 8) >>> 0)) >>> 0;
  }
  return ~crc >>> 0;
}

// ---------------------------------------------------------------------------
// Canonical Huffman decode tables (libbz2's hbCreateDecodeTables limits:
// codes of each length assigned to the symbols in ascending order —
// hbAssignCodes — so the transmission carries lengths only).
// ---------------------------------------------------------------------------

interface BzHuffTable {
  readonly minLen: number;
  readonly maxLen: number;
  readonly firstCode: Int32Array; // per length: the first canonical code
  readonly limit: Int32Array; // per length: the last canonical code
  readonly offset: Int32Array; // per length: perm's offset (symbols of shorter lengths)
  readonly perm: Uint16Array; // symbols in code-assignment order: (length, symbol)
}

const BZ_MAX_CODE_LENGTH = 20;

function bzBuildHuffTable(lengths: Uint8Array): BzHuffTable {
  const count = new Int32Array(BZ_MAX_CODE_LENGTH + 1);
  let minLen = BZ_MAX_CODE_LENGTH + 1;
  let maxLen = 0;
  for (const length of lengths) {
    if (length < 1 || length > BZ_MAX_CODE_LENGTH) throw new Bzip2Error("Huffman length out of range");
    count[length] = (count[length] ?? 0) + 1;
    if (length < minLen) minLen = length;
    if (length > maxLen) maxLen = length;
  }

  const firstCode = new Int32Array(BZ_MAX_CODE_LENGTH + 1);
  const limit = new Int32Array(BZ_MAX_CODE_LENGTH + 1);
  const offset = new Int32Array(BZ_MAX_CODE_LENGTH + 1);
  let code = 0;
  let offsetAcc = 0;
  for (let length = minLen; length <= maxLen; length++) {
    const cnt = count[length] ?? 0;
    firstCode[length] = code;
    limit[length] = code + cnt - 1;
    offset[length] = offsetAcc;
    offsetAcc += cnt;
    code = (code + cnt) << 1;
  }

  const perm = new Uint16Array(lengths.length);
  let pp = 0;
  for (let length = minLen; length <= maxLen; length++) {
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      if (lengths[symbol] === length) perm[pp++] = symbol;
    }
  }
  return { minLen, maxLen, firstCode, limit, offset, perm };
}

function bzHuffDecode(table: BzHuffTable, br: BzBitReader): number {
  let length = table.minLen;
  let vec = br.readBits(length);
  while (vec > (table.limit[length] ?? Infinity)) {
    length++;
    if (length > table.maxLen) throw new Bzip2Error("Huffman code over-run");
    vec = (vec << 1) | br.readBit();
  }
  // The within-length slot indexes the assignment-ordered perm through the
  // shorter-lengths offset (libbz2's adjusted-base arithmetic, spelled out).
  return table.perm[(table.offset[length] ?? 0) + vec - (table.firstCode[length] ?? 0)] ?? 0;
}

// ---------------------------------------------------------------------------
// The move-to-front list (Go's moveToFrontDecoder — simple copy; the
// referenced index is almost always < 64 so the locality wins).
// ---------------------------------------------------------------------------

class BzMtf {
  constructor(private readonly list: Uint8Array) {}

  decode(n: number): number {
    const b = this.list[n] ?? 0;
    for (let i = n; i > 0; i--) this.list[i] = this.list[i - 1] ?? 0;
    this.list[0] = b;
    return b;
  }

  first(): number {
    return this.list[0] ?? 0;
  }
}

// ---------------------------------------------------------------------------
// One block's decode (Go's readBlock + the RLE1 undo of readFromBlock).
// ---------------------------------------------------------------------------

const BZ_BLOCK_MAGIC = 0x314159265359; // pi — the block marker
const BZ_FINAL_MAGIC = 0x177245385090; // sqrt(pi) — the stream footer
const BZ_MAX_SELECTORS = 2 + Math.floor(900000 / 50); // 18002 — the libbz2 bound
const BZ_MAX_REPEAT = 2 * 1024 * 1024; // the overflow cap from the bzip2 source (Go's)

function bzDecodeBlock(br: BzBitReader, blockSize: number): { output: Uint8Array; crc: number } {
  const wantCrc = br.readBits(32);
  if (br.readBit() !== 0) {
    throw new Bzip2Error("deprecated randomized block (Go's compress/bzip2 rejects it too)");
  }
  const origPtr = br.readBits(24);

  // The symbol map: a two-level 16x16 bitmap over the byte values.
  const rangeUsed = br.readBits(16);
  const seqToUnseq = new Uint8Array(256);
  let nInUse = 0;
  for (let range = 0; range < 16; range++) {
    if ((rangeUsed & (1 << (15 - range))) !== 0) {
      const bits = br.readBits(16);
      for (let symbol = 0; symbol < 16; symbol++) {
        if ((bits & (1 << (15 - symbol))) !== 0) {
          seqToUnseq[nInUse++] = 16 * range + symbol;
        }
      }
    }
  }
  if (nInUse === 0) throw new Bzip2Error("no symbols in block");

  // 2..6 Huffman trees; the per-50-symbol selectors are MTF + unary coded.
  const nGroups = br.readBits(3);
  if (nGroups < 2 || nGroups > 6) throw new Bzip2Error("invalid number of Huffman trees");
  const nSelectors = br.readBits(15);
  if (nSelectors === 0) throw new Bzip2Error("no tree selectors given");
  if (nSelectors > BZ_MAX_SELECTORS) throw new Bzip2Error("too many tree selectors");
  const selectorMtf = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectors; i++) {
    let c = 0;
    while (br.readBit() !== 0) {
      c++;
      if (c >= nGroups) throw new Bzip2Error("tree index too large");
    }
    selectorMtf[i] = c;
  }
  const order = new Uint8Array(nGroups);
  for (let i = 0; i < nGroups; i++) order[i] = i;
  const selectors = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectors; i++) {
    const pick = selectorMtf[i] ?? 0;
    const value = order[pick] ?? 0;
    for (let j = pick; j > 0; j--) order[j] = order[j - 1] ?? 0;
    order[0] = value;
    selectors[i] = value;
  }

  // Per-tree code lengths: a 5-bit base then 1/0 delta pairs.
  const alphaSize = nInUse + 2; // the two RUN metasymbols + EOB ride on top
  const mtf = new BzMtf(seqToUnseq.slice(0, nInUse));
  const tables: BzHuffTable[] = [];
  for (let g = 0; g < nGroups; g++) {
    let length = br.readBits(5);
    const lengths = new Uint8Array(alphaSize);
    for (let j = 0; j < alphaSize; j++) {
      for (;;) {
        if (length < 1 || length > BZ_MAX_CODE_LENGTH) throw new Bzip2Error("Huffman length out of range");
        if (br.readBit() === 0) break;
        if (br.readBit() === 0) length++;
        else length--;
      }
      lengths[j] = length;
    }
    tables.push(bzBuildHuffTable(lengths));
  }

  // The entropy decode: symbols 0/1 are RUNA/RUNB, alphaSize-1 is EOB,
  // the rest go through the MTF list at v-1 (the front of the list is
  // never referenced as 0 — Go's comment: it always rides a run).
  const tt = new Uint32Array(blockSize); // byte in the low 8 bits, the BWT P in the upper
  const cftab = new Int32Array(256);
  let bufIndex = 0;
  let selectorIndex = 1;
  let decoded = 0;
  let table = tables[selectors[0] ?? 0];
  if (table === undefined) throw new Bzip2Error("tree selector out of range");
  let repeat = 0;
  let repeatPower = 0;
  for (;;) {
    if (decoded === 50) {
      if (selectorIndex >= nSelectors) throw new Bzip2Error("insufficient selector indices");
      const next = tables[selectors[selectorIndex++] ?? 0];
      if (next === undefined) throw new Bzip2Error("tree selector out of range");
      table = next;
      decoded = 0;
    }
    const v = bzHuffDecode(table, br);
    decoded++;
    if (v < 2) {
      // RUNA/RUNB: the run length accumulates in base 2 (RUNA adds
      // 2^k, RUNB adds 2^(k+1)); Go's cap guards the accumulator.
      if (repeat === 0) repeatPower = 1;
      repeat += repeatPower << v;
      repeatPower <<= 1;
      if (repeat > BZ_MAX_REPEAT) throw new Bzip2Error("repeat count too large");
      continue;
    }
    if (repeat > 0) {
      if (repeat > blockSize - bufIndex) throw new Bzip2Error("repeats past end of block");
      const b = mtf.first();
      for (let i = 0; i < repeat; i++) {
        tt[bufIndex] = b;
        cftab[b] = (cftab[b] ?? 0) + 1;
        bufIndex++;
      }
      repeat = 0;
    }
    if (v === alphaSize - 1) break; // EOB
    const b = mtf.decode(v - 1);
    if (bufIndex >= blockSize) throw new Bzip2Error("data exceeds block size");
    tt[bufIndex] = b;
    cftab[b] = (cftab[b] ?? 0) + 1;
    bufIndex++;
  }
  if (origPtr >= bufIndex) throw new Bzip2Error("origPtr out of bounds");

  // Inverse BWT, the single-array method (Go's inverseBWT — SRC-RR-124
  // §4.2): the C array becomes cumulative first-occurrence offsets, the
  // P vector lands in tt's upper bits, then the linked-list walk emits.
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    sum += cftab[i] ?? 0;
    cftab[i] = sum - (cftab[i] ?? 0);
  }
  for (let i = 0; i < bufIndex; i++) {
    const b = (tt[i] ?? 0) & 0xff;
    const slot = cftab[b] ?? 0;
    tt[slot] = ((tt[slot] ?? 0) | (i << 8)) >>> 0;
    cftab[b] = slot + 1;
  }
  let tPos = (tt[origPtr] ?? 0) >> 8;

  // The RLE stage between BWT and output: undo it into a flat buffer.
  const rle = new Uint8Array(bufIndex);
  for (let i = 0; i < bufIndex; i++) {
    const packed = tt[tPos] ?? 0;
    rle[i] = packed & 0xff;
    tPos = packed >> 8;
  }

  // The RLE1 undo (Go's readFromBlock state machine, batched): any four
  // equal bytes are followed by a count byte holding the EXTRA repeats.
  // The RLE can EXPAND (4 + 255 from 5), so size it in one pass, fill in
  // the next — the identical walk, counting instead of emitting.
  let expanded = 0;
  let lastByte = -1;
  let byteRepeats = 0;
  let repeats = 0;
  for (let i = 0; i < bufIndex; i++) {
    const b = rle[i] ?? 0;
    if (byteRepeats === 3) {
      repeats = b;
      byteRepeats = 0;
      continue;
    }
    if (repeats > 0) {
      expanded += repeats;
      repeats = 0;
      lastByte = -1;
    }
    byteRepeats = lastByte === b ? byteRepeats + 1 : 0;
    lastByte = b;
    expanded++;
  }
  // A block whose RLE stream ends on a count byte leaves the repeats
  // pending — Go drains them through later reads before the CRC check,
  // so they belong to THIS block's output (the tar end-blocks' zero runs
  // end exactly this way).
  if (repeats > 0) expanded += repeats;
  const output = new Uint8Array(expanded);
  let out = 0;
  lastByte = -1;
  byteRepeats = 0;
  repeats = 0;
  for (let i = 0; i < bufIndex; i++) {
    const b = rle[i] ?? 0;
    if (byteRepeats === 3) {
      repeats = b;
      byteRepeats = 0;
      continue;
    }
    if (repeats > 0) {
      for (let r = 0; r < repeats; r++) output[out++] = lastByte;
      repeats = 0;
      lastByte = -1;
    }
    byteRepeats = lastByte === b ? byteRepeats + 1 : 0;
    lastByte = b;
    output[out++] = b;
  }
  if (repeats > 0) {
    for (let r = 0; r < repeats; r++) output[out++] = lastByte;
  }
  const crc = bzUpdateCrc(output, 0, output.byteLength);
  if (crc !== wantCrc) throw new Bzip2Error("block checksum mismatch");
  return { output, crc };
}

// ---------------------------------------------------------------------------
// The stream walk (Go's setup/read): "BZh" + level, then 48-bit markers
// until the footer; the combined CRC is rotl-1 XOR per block; a "BZ"
// continuation after the footer starts the next stream (Go's reader).
// ---------------------------------------------------------------------------

/**
 * Decompress one whole bzip2 stream (and any concatenated continuations).
 * Throws Bzip2Error on every malformed or CRC-failing input.
 */
export function bzip2Decompress(bytes: Uint8Array): Uint8Array {
  const br = new BzBitReader(bytes);
  const chunks: Uint8Array[] = [];
  let fileCrc = 0;
  let needMagic = true;
  let done = false;
  while (!done) {
    if (needMagic) {
      if (br.readBits(16) !== 0x425a) throw new Bzip2Error("bad magic value"); // "BZ"
      needMagic = false;
    }
    if (br.readBits(8) !== 0x68) throw new Bzip2Error("non-Huffman entropy encoding"); // 'h'
    const level = br.readBits(8);
    if (level < 0x31 || level > 0x39) throw new Bzip2Error("invalid compression level");
    const blockSize = 100000 * (level - 0x30);

    for (;;) {
      const marker = br.readBits(48);
      if (marker === BZ_BLOCK_MAGIC) {
        const { output, crc } = bzDecodeBlock(br, blockSize);
        // The combined stream CRC: rotate-left-1 then XOR (Go's read()).
        fileCrc = (((fileCrc << 1) | (fileCrc >>> 31)) ^ crc) >>> 0;
        chunks.push(output);
        continue;
      }
      if (marker !== BZ_FINAL_MAGIC) throw new Bzip2Error("bad magic value found");
      if (br.readBits(32) !== fileCrc) throw new Bzip2Error("file checksum mismatch");
      br.alignToByte();
      if (br.atEnd()) {
        done = true;
        break;
      }
      // A concatenated continuation stream would start with "BZ" — its
      // combined CRC restarts (Go's setup() zeroes fileCRC).
      if (br.byteAt(br.position) === 0x42 && br.byteAt(br.position + 1) === 0x5a) {
        needMagic = true;
        fileCrc = 0;
        break;
      }
      throw new Bzip2Error("bad magic value in continuation file");
    }
  }

  const total = chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

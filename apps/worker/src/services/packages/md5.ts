/**
 * A zero-dependency incremental MD5 (RFC 1321) — census B-58's digest arm.
 * Workers' WebCrypto supports only SHA-1/-256/-512 (the landed three-digest
 * posture in blobs.ts), while upstream's package blobs carry a fourth column:
 * `hash_md5` (models/packages/blob.go, our schema's nullable twin with the
 * same UNIQUE index) that the debian Packages `MD5sum:` line
 * (services/packages/debian/repository.go:206), the Release `MD5Sum:` section
 * (:336-352) and the `by-hash/md5sum` fetch (routers/api/packages/debian/
 * debian.go:87-88) all read, and conan's snapshot render (services/packages/
 * conan/conan.go serveSnapshot) publishes as the client-side checksum.
 *
 * The hash is a fixed 4-word Merkle-Damgard walk — the same class of
 * bit-level work as the tree's hand-built zstd/bz2 decoders, well within
 * workerd's CPU budget for package-sized payloads. Incremental (feed chunks,
 * then digest) so the upload path can ride a streaming pass without
 * buffering the whole blob.
 *
 * Correctness is self-checking: the battery cross-checks system `md5sum`
 * goldens, and the debian/conan batteries verify the rendered digests against
 * the same tooling at authoring time.
 */

/** The per-round additive constants, K[i] = floor(2^32 * abs(sin(i+1))), precomputed. */
const K = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

/** Per-operation shift amounts. */
const S = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

/** One incremental MD5 instance. Not thread-safe; one blob pass owns one. */
export class Md5 {
  private readonly state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  /** Total bytes folded, kept as two 32-bit words for the 64-bit length field. */
  private lengthLow = 0;
  private lengthHigh = 0;
  private finished = false;

  /** Fold one chunk into the running digest (any byte length). */
  update(chunk: Uint8Array): this {
    if (this.finished) throw new Error("md5 already finished");
    let offset = 0;
    const length = chunk.byteLength;
    // Bump the 64-bit byte counter (mod 2^64 via the two-word carry; the sum
    // of two sub-2^32 values is exact in IEEE doubles, so the carry is exact).
    const next = this.lengthLow + length;
    this.lengthHigh = (this.lengthHigh + Math.floor(next / 0x100000000)) | 0;
    this.lengthLow = next >>> 0;
    // Drain the pending partial block first.
    if (this.blockLength > 0) {
      const need = 64 - this.blockLength;
      const take = Math.min(need, length);
      this.block.set(chunk.subarray(offset, offset + take), this.blockLength);
      this.blockLength += take;
      offset += take;
      if (this.blockLength === 64) {
        this.compressBlock();
        this.blockLength = 0;
      }
    }
    // Whole aligned blocks straight out of the chunk (no copy).
    const aligned = (length - offset) & ~63;
    for (let i = 0; i < aligned; i += 64) {
      this.compressBlock(chunk.subarray(offset + i, offset + i + 64));
    }
    offset += aligned;
    // Stash the tail.
    if (offset < length) {
      this.block.set(chunk.subarray(offset), 0);
      this.blockLength = length - offset;
    }
    return this;
  }

  /** The 16-byte little-endian digest. */
  digestBytes(): Uint8Array {
    if (!this.finished) this.finish();
    const out = new Uint8Array(16);
    for (let i = 0; i < 4; i++) {
      const word = this.state[i] ?? 0;
      out[i * 4] = word & 0xff;
      out[i * 4 + 1] = (word >>> 8) & 0xff;
      out[i * 4 + 2] = (word >>> 16) & 0xff;
      out[i * 4 + 3] = (word >>> 24) & 0xff;
    }
    return out;
  }

  /** The hex digest — the form the blob rows and every index line carry. */
  digestHex(): string {
    let hex = "";
    for (const byte of this.digestBytes()) {
      hex += byte.toString(16).padStart(2, "0");
    }
    return hex;
  }

  private finish(): void {
    // Append 0x80, pad to 56 mod 64, then the 64-bit little-endian bit length.
    const padStart = this.blockLength;
    this.block[padStart] = 0x80;
    const bitLow = (this.lengthLow << 3) >>> 0;
    const bitHigh = ((this.lengthHigh << 3) | (this.lengthLow >>> 29)) >>> 0;
    if (padStart < 56) {
      this.block.fill(0, padStart + 1, 64);
    } else {
      this.block.fill(0, padStart + 1, 64);
      this.compressBlock();
      this.block.fill(0, 0, 56);
    }
    const view = new DataView(this.block.buffer);
    view.setUint32(56, bitLow, true);
    view.setUint32(60, bitHigh, true);
    this.compressBlock();
    this.finished = true;
  }

  private compressBlock(bytes?: Uint8Array): void {
    const m = new Uint32Array(16);
    if (bytes === undefined) {
      const view = new DataView(this.block.buffer, this.block.byteOffset, 64);
      for (let i = 0; i < 16; i++) m[i] = view.getUint32(i * 4, true);
    } else {
      for (let i = 0; i < 16; i++) {
        const o = i * 4;
        m[i] = (bytes[o] ?? 0) | ((bytes[o + 1] ?? 0) << 8) | ((bytes[o + 2] ?? 0) << 16) | ((bytes[o + 3] ?? 0) << 24);
      }
    }
    let [a, b, c, d] = [this.state[0] ?? 0, this.state[1] ?? 0, this.state[2] ?? 0, this.state[3] ?? 0];
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const x = m[g] ?? 0;
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + (f | 0) + (K[i] ?? 0) + x) | 0;
      const shifted = (sum << (S[i] ?? 0)) | (sum >>> (32 - (S[i] ?? 0)));
      b = (b + shifted) | 0;
      a = tmp;
    }
    this.state[0] = (this.state[0]! + a) | 0;
    this.state[1] = (this.state[1]! + b) | 0;
    this.state[2] = (this.state[2]! + c) | 0;
    this.state[3] = (this.state[3]! + d) | 0;
  }
}

/** One-shot MD5 over whole bytes. */
export function md5Hex(bytes: Uint8Array): string {
  return new Md5().update(bytes).digestHex();
}

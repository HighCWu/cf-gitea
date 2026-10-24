/**
 * Digest + timing-safe comparison — SPEC-0002 §2.7.
 *
 * Token digests are sha256 hex at rest (SPEC-0002 §3 hashing decision).
 * Comparison uses Workers' `crypto.subtle.timingSafeEqual` on the raw
 * 32-byte digests — never on hex strings (whose length differences would
 * leak and whose compare would not be constant-time).
 */

const HEX_ALPHABET = "0123456789abcdef";

export function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  return crypto.subtle.digest("SHA-256", data).then((digest) => bytesToHex(new Uint8Array(digest)));
}

/**
 * Constant-time comparison of two sha256 hex digests. Inputs of unequal
 * length return false without comparing (length itself is not secret: both
 * sides are 64-hex digests in normal operation).
 */
export function timingSafeDigestEqual(digestHexA: string, digestHexB: string): Promise<boolean> {
  const a = hexToBytes(digestHexA);
  const b = hexToBytes(digestHexB);
  if (a === null || b === null || a.length !== b.length) return Promise.resolve(false);
  return Promise.resolve(crypto.subtle.timingSafeEqual(a, b));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX_ALPHABET[byte >> 4];
    out += HEX_ALPHABET[byte & 0x0f];
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = HEX_ALPHABET.indexOf(hex[i * 2] as string);
    const lo = HEX_ALPHABET.indexOf(hex[i * 2 + 1] as string);
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/**
 * Opaque token format — SPEC-0002 §3 "Token format decision".
 *
 * `cfg_<8hex>_<32base32>`: a 12-char public prefix (`cfg_` + 8 hex, the
 * collision-retried unique lookup key), `_`, and 32 chars of base32 over the
 * unambiguous alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — 160 bits of
 * secret entropy, identical to upstream's 20 random bytes. Full length 45.
 *
 * The resolver also accepts the imported 40-hex Gitea shape by taking the
 * first 12 hex chars as the lookup prefix (SPEC-0002 §3 ingest note); the
 * only upstream length gate is `len >= 8` (access_token.go:91).
 */

/** Base32 alphabet without I/L/O/U-adjacent ambiguity; matches upstream's
 *  two-factor generator alphabet (models/auth/twofactor.go:70–75). */
export const BASE32_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const HEX_CHARS = "0123456789abcdef";
const PREFIX_HEX_BYTES = 4; // 8 hex chars
const SECRET_BYTES = 20; // 160 bits → exactly 32 base32 chars
const TOTAL_RANDOM_BYTES = PREFIX_HEX_BYTES + SECRET_BYTES;

/** Length of the public lookup prefix: `cfg_` + 8 hex. */
export const TOKEN_PREFIX_LENGTH = 4 + 8;
/** Full minted token length: prefix + `_` + 32 base32 chars. */
export const TOKEN_VALUE_LENGTH = TOKEN_PREFIX_LENGTH + 1 + 32;
/** Upstream lookup gate: shorter values are treated as unknown credentials. */
export const MIN_TOKEN_LENGTH = 8;

export interface GeneratedToken {
  /** Full opaque value, shown to the caller exactly once. */
  value: string;
  /** `cfg_<8hex>` public lookup prefix. */
  prefix: string;
}

/** Generate a fresh token from runtime randomness (WebCrypto). */
export function generateToken(): GeneratedToken {
  const bytes = crypto.getRandomValues(new Uint8Array(TOTAL_RANDOM_BYTES));
  return tokenFromRandomBytes(bytes);
}

/** Deterministic token construction from exactly 24 bytes (tests / vectors). */
export function tokenFromRandomBytes(bytes: Uint8Array): GeneratedToken {
  if (bytes.length !== TOTAL_RANDOM_BYTES) {
    throw new Error(`token generation needs exactly ${TOTAL_RANDOM_BYTES} random bytes`);
  }
  let hex = "";
  for (let i = 0; i < PREFIX_HEX_BYTES; i++) {
    hex += HEX_CHARS[(bytes[i] as number) >> 4];
    hex += HEX_CHARS[(bytes[i] as number) & 0x0f];
  }
  return { value: `cfg_${hex}_${base32Encode(bytes.subarray(PREFIX_HEX_BYTES))}`, prefix: `cfg_${hex}` };
}

/**
 * Lookup prefix for a presented credential: the first 12 chars. Accepts both
 * the `cfg_` shape and the imported 40-hex shape; values shorter than the
 * upstream gate are rejected (`null` → unknown credential).
 */
export function tokenLookupPrefix(value: string): string | null {
  if (value.length < MIN_TOKEN_LENGTH) return null;
  return value.slice(0, TOKEN_PREFIX_LENGTH);
}

/** True when the value has our exact minted shape (`cfg_<8hex>_<32base32>`). */
export function isCfGiteaTokenShape(value: string): boolean {
  if (!value.startsWith("cfg_") || value.length !== TOKEN_VALUE_LENGTH) return false;
  for (let i = 4; i < 12; i++) {
    if (!HEX_CHARS.includes(value[i] as string)) return false;
  }
  for (let i = 13; i < value.length; i++) {
    if (!BASE32_ALPHABET.includes(value[i] as string)) return false;
  }
  return value[12] === "_";
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

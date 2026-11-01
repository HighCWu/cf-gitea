/**
 * COSE key handling + WebCrypto verification for the WebAuthn ceremonies —
 * the byte-level primitives the verify ladders share (zero-dependency; the
 * verify surface is WebCrypto's own).
 *
 * Scope (the mission's): ES256 (COSE alg -7, the universal authenticator
 * default) and RS256 (-257). Everything else fails closed at REGISTRATION —
 * a credential whose key we cannot verify can never complete a login, so
 * enrolling it would be a stored lockout, not a feature gap (documented
 * divergence: go-webauthn accepts EdDSA/P-384/etc. at enroll; Gitea never
 * restricts the alg set — recorded in the SPEC header).
 *
 * The userHandle codec rides here too: upstream's WebAuthnID() is
 * `binary.PutVarint(u.User.ID)` into an 8-byte buffer
 * (modules/auth/webauthn/webauthn.go:62-66) — Go's zigzag LEB128. The
 * passkey arm decodes the assertion's userHandle back to the users.id the
 * same way.
 */

import { CborError, decodeCborItem } from "./webauthn-cbor";

// ---------------------------------------------------------------------------
// Byte/string codecs (base64url is the WebAuthn wire encoding everywhere)
// ---------------------------------------------------------------------------

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  // Base64url without padding; re-pad for atob (the JS decoder requires a
  // multiple of 4). Reject characters outside the url-safe alphabet — a
  // malformed field is a failed ceremony, never a lenient parse.
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid base64url");
  let padded = value.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4 !== 0) padded += "=";
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------------------
// The userHandle varint (Go binary.PutVarint — zigzag LEB128)
// ---------------------------------------------------------------------------

/** Upstream WebAuthnID (webauthn.go:62-66): PutVarint into an 8-byte buffer —
 *  the varint bytes, zero-padded to 8. */
export function webAuthnIdForUser(userId: number): Uint8Array {
  const out = new Uint8Array(8);
  let ux = BigInt(userId) << 1n;
  if (userId < 0) ux = ~ux;
  let i = 0;
  while (ux >= 0x80n) {
    out[i++] = Number(ux & 0x7fn) | 0x80;
    ux >>= 7n;
  }
  out[i] = Number(ux);
  return out;
}

/** binary.Varint's decode: zigzag LEB128 from the front (padding tolerated —
 *  upstream decodes the same 8-byte buffer). Returns null when malformed. */
export function userIdFromWebAuthnId(bytes: Uint8Array): number | null {
  let ux = 0n;
  let shift = 0n;
  for (let i = 0; i < Math.min(bytes.length, 10); i++) {
    const b = bytes[i]!;
    ux |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if ((b & 0x80) === 0) {
      // Zigzag decode.
      const value = (ux >> 1n) ^ -(ux & 1n);
      const num = Number(value);
      return Number.isSafeInteger(num) ? num : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// COSE keys (RFC 9052) — parse from the attested credential data
// ---------------------------------------------------------------------------

/** COSE key common parameters (RFC 9052 §7). */
const COSE_KTY = 1;
const COSE_ALG = 3;
/** EC2 key parameters. */
const COSE_CRV = -1;
const COSE_X = -2;
const COSE_Y = -3;
/** RSA key parameters. */
const COSE_N = -1;
const COSE_E = -2;

/** COSE key types. */
const KTY_EC2 = 2;
const KTY_RSA = 3;
/** Curves / algorithms in scope. */
const CRV_P256 = 1;
const ALG_ES256 = -7;
const ALG_RS256 = -257;

export type CoseKey =
  | { kty: "EC2"; x: Uint8Array; y: Uint8Array }
  | { kty: "RSA"; n: Uint8Array; e: Uint8Array };

/** The COSE alg the key carries (the packed self-attestation check compares
 *  it against the attStmt's alg). */
export function coseKeyAlg(key: CoseKey): number {
  return key.kty === "EC2" ? ALG_ES256 : ALG_RS256;
}

/**
 * Parse a COSE_Key from the front of `bytes` (the attested-credential-data
 * tail). Returns the key and the end offset — authenticator data continues
 * with the extensions map when the ED flag is set, and the exact end is how
 * the length walk validates the whole structure.
 */
export function parseCoseKey(bytes: Uint8Array, offset: number): { key: CoseKey; end: number } {
  const decoded = decodeCborItem(bytes, offset);
  if (!(decoded.value instanceof Map)) throw new CborError("COSE key is not a map");
  const map = decoded.value;
  const kty = map.get(COSE_KTY);
  const alg = map.get(COSE_ALG);
  if (kty === KTY_EC2 && alg === ALG_ES256) {
    const crv = map.get(COSE_CRV);
    const x = map.get(COSE_X);
    const y = map.get(COSE_Y);
    if (crv !== CRV_P256 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
      throw new CborError("unsupported EC2 key (curve or coordinates)");
    }
    return { key: { kty: "EC2", x, y }, end: decoded.offset };
  }
  if (kty === KTY_RSA && alg === ALG_RS256) {
    const n = map.get(COSE_N);
    const e = map.get(COSE_E);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) {
      throw new CborError("malformed RSA key parameters");
    }
    return { key: { kty: "RSA", n, e }, end: decoded.offset };
  }
  const kindText = typeof kty === "number" || typeof kty === "string" ? String(kty) : "non-scalar";
  const algText = typeof alg === "number" || typeof alg === "string" ? String(alg) : "non-scalar";
  throw new CborError(`unsupported COSE key (kty=${kindText} alg=${algText})`);
}

/** Import the key for WebCrypto signature VERIFICATION. */
export async function importCoseKey(key: CoseKey): Promise<CryptoKey> {
  const jwk =
    key.kty === "EC2"
      ? { kty: "EC", crv: "P-256", x: base64UrlEncode(key.x), y: base64UrlEncode(key.y), ext: true }
      : { kty: "RSA", n: base64UrlEncode(key.n), e: base64UrlEncode(key.e), ext: true };
  const algorithm =
    key.kty === "EC2" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  return crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
}

/** Verify a signature over `data` — ECDSA/SHA-256 for ES256,
 *  RSASSA-PKCS1-v1_5/SHA-256 for RS256. WebCrypto takes ECDSA signatures in
 *  raw r||s form — exactly what authenticators emit, so no DER dance. */
export async function coseVerify(key: CryptoKey, coseKey: CoseKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const algorithm = coseKey.kty === "EC2" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  return crypto.subtle.verify(algorithm, key, signature, data);
}

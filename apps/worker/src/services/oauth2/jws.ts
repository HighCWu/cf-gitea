/**
 * The OAuth2 JWS primitive (SPEC specs/oauth2-provider.md §2.4/§2.10 — W1):
 * compact-JWS sign/verify over native WebCrypto, ZERO dependencies — the
 * same primitive family the repo already proves in production paths
 * (RSASSA-PKCS1-v1_5 in services/actions/secrets.ts's OIDC signer, HMAC in
 * the same module's runtime JWT, ECDSA in WebCrypto's crypto.subtle).
 *
 * ALGORITHM TABLE (upstream's accepted set, CreateJWTSigningKey
 * modules/setting/oauth2.go:240-295): HS256/384/512, RS256/384/512,
 * ES256/384/512, EdDSA. EdDSA is REJECTED-UNTIL-proven (SPEC §2.10 recorded
 * divergence (c): workerd's Ed25519 exists but has zero house precedent and
 * it is a non-default upstream config arm — the table validates the full
 * upstream set and fails closed on it with the recorded-deferrence error).
 *
 * PARITY NOTES:
 *   - SignToken (token.go:60-66) stamps `iat` and lets PreProcessToken set
 *     the `kid` header (asymmetric keys only — hmacSigningKey.PreProcessToken
 *     is a no-op, jwtsigningkey.go:69-74). signJws mirrors both: `kid` rides
 *     the header only when the caller passes one; `iat` is stamped when the
 *     caller asks (the token shapes are W2's).
 *   - ParseToken (token.go:37-56) REJECTS any token whose header `alg`
 *     differs from the configured signing method — no algorithm confusion
 *     (SPEC §4.10). verifyJws pins the expected alg before verification.
 *   - Claim validation rides golang-jwt v5's default validator upstream
 *     (exp-if-present, nbf-if-present, ZERO leeway — leeway is never
 *     configured). verifyJws implements exactly that and nothing more;
 *     the API-path's stricter `exp >= now && iat <= now` check
 *     (services/auth/oauth2.go:53) is a separate export (assertApiTimeBounds)
 *     because upstream itself runs it as a SECOND, independent gate — the
 *     asymmetry is the pin (SPEC open question 3).
 *   - ES* signatures: JOSE stores the raw r||s concatenation, which is
 *     exactly what WebCrypto's ECDSA sign/verify consume — no DER wrapping
 *     on either side (pinned in-suite against RFC 7515 appendix A.3's fixed
 *     vector).
 *   - Header byte-parity: golang-jwt marshals the header map with Go's
 *     sorted-key JSON, so the compact token spells
 *     {"alg":...,"kid":...,"typ":"JWT"} — signJws emits the same member
 *     order (cosmetic but free).
 */

/** The JWS `alg` values this provider can be configured with. */
export type JwsAlgorithm =
  | "HS256"
  | "HS384"
  | "HS512"
  | "RS256"
  | "RS384"
  | "RS512"
  | "ES256"
  | "ES384"
  | "ES512";

/** The configured-alg set, default first (modules/setting/oauth2.go:108:
 *  `[oauth2] JWT_SIGNING_ALGORITHM` default RS256). */
export const SIGNING_ALGORITHMS: readonly JwsAlgorithm[] = [
  "RS256",
  "HS256",
  "HS384",
  "HS512",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
];

export const DEFAULT_SIGNING_ALGORITHM: JwsAlgorithm = "RS256";

/** Validate a configured algorithm against the upstream set; `EdDSA` and
 *  anything else fail closed. The error text mirrors upstream's
 *  ErrInvalidAlgorithmType (jwtsigningkey.go:16-20). */
export function assertSigningAlgorithm(value: string): JwsAlgorithm {
  if (value === "EdDSA") {
    throw new Error(
      "JWT signing algorithm is not supported: EdDSA (rejected-until-proven on Workers — SPEC specs/oauth2-provider.md §2.10 divergence (c))",
    );
  }
  if (!(SIGNING_ALGORITHMS as readonly string[]).includes(value)) {
    throw new Error(`JWT signing algorithm is not supported: ${value}`);
  }
  return value as JwsAlgorithm;
}

interface AlgParams {
  family: "HMAC" | "RSASSA-PKCS1-v1_5" | "ECDSA";
  hash: "SHA-256" | "SHA-384" | "SHA-512";
  /** ECDSA only (the WebCrypto named curve matching the digest). */
  namedCurve?: "P-256" | "P-384" | "P-521";
}

/** alg → WebCrypto parameters (the table above, resolved). */
export function algorithmParams(alg: JwsAlgorithm): AlgParams {
  const suffix = alg.slice(2) as "256" | "384" | "512";
  const hash: AlgParams["hash"] = `SHA-${suffix}`;
  switch (alg[0]) {
    case "H":
      return { family: "HMAC", hash };
    case "R":
      return { family: "RSASSA-PKCS1-v1_5", hash };
    case "E":
      return {
        family: "ECDSA",
        hash,
        namedCurve: suffix === "256" ? "P-256" : suffix === "384" ? "P-384" : "P-521",
      };
  }
  throw new Error(`JWT signing algorithm is not supported: ${alg}`);
}

/** The sign/verify operation algorithm (EcdsaParams/RsaSsaParams/HmacParams
 *  — the digest rides EVERY operation for ECDSA/RSA; HMAC's comes from the
 *  key but restating it is harmless and explicit). Structurally
 *  SubtleCryptoSignAlgorithm. */
function operationAlgorithm(alg: JwsAlgorithm): { name: string; hash: string } {
  const params = algorithmParams(alg);
  return params.family === "ECDSA" ? { name: "ECDSA", hash: params.hash } : { name: params.family, hash: params.hash };
}

/** The JOSE header shape this provider emits / accepts. */
export interface JwsHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

/** base64url-nopad (RFC 4648 §5, the JOSE spelling) — exported for the
 *  sibling key module's kid derivation (the same recipe). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const std = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function encoder(): TextEncoder {
  return new TextEncoder();
}

// ---------------------------------------------------------------------------
// Key import (from JWK material — the keystore rows' native shape)
// ---------------------------------------------------------------------------

/** Import a SIGNING key. HMAC takes the raw secret string (the Actions
 *  row's hex secret / an HS deployment's general_token_signing_secret, or
 *  the client secret for the id_token arm — see keys.ts). Asymmetric takes
 *  the private JWK (the keystore row's material). */
export async function importSigningKey(alg: JwsAlgorithm, keyMaterial: string | JsonWebKey): Promise<CryptoKey> {
  const params = algorithmParams(alg);
  if (typeof keyMaterial === "string") {
    if (params.family !== "HMAC") {
      throw new Error("oauth2: asymmetric signing keys import from a JWK, not raw bytes");
    }
    return crypto.subtle.importKey("raw", encoder().encode(keyMaterial), { name: "HMAC", hash: params.hash }, false, [
      "sign",
    ]);
  }
  if (params.family === "HMAC") {
    throw new Error("oauth2: HMAC signing keys import from the raw secret, not a JWK");
  }
  // Import params per WebCrypto: RSA takes RsaHashedImportParams {name,
  // hash}; ECDSA takes EcKeyImportParams {name, namedCurve} (the digest is
  // supplied per-operation at sign/verify, never at import).
  const importAlgorithm =
    params.family === "ECDSA" ? { name: "ECDSA", namedCurve: params.namedCurve! } : { name: params.family, hash: params.hash };
  return crypto.subtle.importKey("jwk", stripTransportMembers(keyMaterial), importAlgorithm, false, ["sign"]);
}

/** Import a VERIFY key: the public half of the JWK (private members
 *  stripped — the same JWK the JWKS publishes), or the raw HMAC secret. */
export async function importVerifyKey(alg: JwsAlgorithm, keyMaterial: string | JsonWebKey): Promise<CryptoKey> {
  const params = algorithmParams(alg);
  if (typeof keyMaterial === "string") {
    if (params.family !== "HMAC") {
      throw new Error("oauth2: asymmetric verify keys import from a JWK, not raw bytes");
    }
    return crypto.subtle.importKey("raw", encoder().encode(keyMaterial), { name: "HMAC", hash: params.hash }, false, [
      "verify",
    ]);
  }
  if (params.family === "HMAC") {
    throw new Error("oauth2: HMAC verify keys import from the raw secret, not a JWK");
  }
  const importAlgorithm =
    params.family === "ECDSA" ? { name: "ECDSA", namedCurve: params.namedCurve! } : { name: params.family, hash: params.hash };
  return crypto.subtle.importKey("jwk", stripTransportMembers(keyMaterial), importAlgorithm, false, ["verify"]);
}

/** The wire-irrelevant JWK transport members: workerd validates `key_ops`
 *  against the requested usages on import (an exported private JWK carries
 *  ["sign","verify"], which a public-half import must not inherit), and the
 *  JWKS publish never spells them. */
function stripTransportMembers(jwk: JsonWebKey): JsonWebKey {
  const { key_ops: _keyOps, ext: _ext, ...rest } = jwk;
  return rest;
}

/** The public JWK of a private one — the private members stripped (d/p/q/
 *  dp/dq/qi for RSA) plus the transport members (key_ops/ext). The JWKS
 *  publishes exactly this shape. */
export function publicJwkOf(privateJwk: JsonWebKey): JsonWebKey {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...pub } = privateJwk;
  return stripTransportMembers(pub);
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

/** SignToken's compact-JWS half (token.go:60-66 + PreProcessToken): header
 *  {alg, kid?, typ:"JWT"} in golang-jwt's sorted-key order, payload = the
 *  claims verbatim (the caller stamps exp/iat/gnt/tt/… — those shapes are
 *  W2's). `iat` stamping mirrors SignToken's `IssuedAt = now` arm; pass
 *  `nowSec` to enable it (unix seconds). */
export async function signJws(options: {
  alg: JwsAlgorithm;
  key: CryptoKey;
  claims: object;
  kid?: string;
  nowSec?: number;
}): Promise<string> {
  const header: JwsHeader = { alg: options.alg };
  if (options.kid !== undefined) {
    header.kid = options.kid;
  }
  header.typ = "JWT";
  const payload =
    options.nowSec === undefined
      ? { ...options.claims }
      : { ...options.claims, iat: options.nowSec };
  const signingInput = `${base64UrlEncode(encoder().encode(JSON.stringify(header)))}.${base64UrlEncode(
    encoder().encode(JSON.stringify(payload)),
  )}`;
  const signature = await crypto.subtle.sign(operationAlgorithm(options.alg), options.key, encoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export interface VerifiedJws {
  header: JwsHeader;
  claims: Record<string, unknown>;
}

/**
 * ParseToken's port (token.go:37-56): the header `alg` MUST equal the
 * expected algorithm (reject before any key work — no algorithm confusion),
 * the signature verifies constant-time via crypto.subtle.verify, and the
 * golang-jwt-v5 default claim validator applies: `exp` when present and
 * `now >= exp` ⇒ expired; `nbf` when present and `now < nbf` ⇒ not yet
 * valid; ZERO leeway both ways; `iat` is NOT validated here (v5 requires
 * WithIssuedAt() for that and ParseToken does not pass it — the API path's
 * separate iat gate is assertApiTimeBounds below).
 *
 * `skipClaimValidation` exists for the raw-signature arms (tests, the RFC
 * 7515 fixed vector — whose exp is 2011) and decodes claims either way.
 */
export async function verifyJws(options: {
  alg: JwsAlgorithm;
  key: CryptoKey;
  token: string;
  nowSec?: number;
  skipClaimValidation?: boolean;
}): Promise<VerifiedJws> {
  const parts = options.token.split(".");
  const [headerB64, payloadB64, signatureB64] = parts;
  if (parts.length !== 3 || headerB64 === undefined || payloadB64 === undefined || signatureB64 === undefined) {
    throw new Error("invalid token");
  }
  let header: JwsHeader;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64))) as JwsHeader;
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as Record<string, unknown>;
  } catch {
    throw new Error("invalid token");
  }
  // ParseToken's keyfunc (token.go:44-46): the alg pins BEFORE verification.
  if (header.alg !== options.alg) {
    throw new Error(`unexpected signing algo: ${String(header.alg)}`);
  }
  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(signatureB64);
  } catch {
    throw new Error("invalid token");
  }
  const ok = await crypto.subtle.verify(
    operationAlgorithm(options.alg),
    options.key,
    signature,
    encoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) {
    throw new Error("invalid token");
  }
  if (!options.skipClaimValidation) {
    const now = options.nowSec ?? Math.floor(Date.now() / 1000);
    const exp = claims.exp;
    if (typeof exp === "number" && now >= exp) {
      throw new Error("token is expired");
    }
    const nbf = claims.nbf;
    if (typeof nbf === "number" && now < nbf) {
      throw new Error("token is not valid yet");
    }
  }
  return { header, claims };
}

/**
 * The API-path time gate (services/auth/oauth2.go:53, GetOAuthAccessToken-
 * ScopeAndUserID): `token.ExpiresAt.Before(now) || token.IssuedAt.After(now)`
 * ⇒ reject — strict clock parity, ZERO leeway in either direction (SPEC
 * §2.4/§4.7). NOTE the deliberate boundary differences from verifyJws's
 * golang-jwt arm: here `exp == now` still passes (`Before` is strict) and
 * `iat == now` passes (`After` is strict) — both ports are verbatim; the
 * verifier's stricter arm runs first in any real pipeline, so the
 * asymmetry is unobservable exactly as upstream.
 */
export function assertApiTimeBounds(claims: Record<string, unknown>, nowSec: number): void {
  const exp = claims.exp;
  const iat = claims.iat;
  if (typeof exp === "number" && exp < nowSec) {
    throw new Error("token is expired");
  }
  if (typeof iat === "number" && iat > nowSec) {
    throw new Error("token issued in the future");
  }
}

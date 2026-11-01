/**
 * The WebAuthn ceremony core — challenge state, options builders, and the
 * two verify ladders (registration attestation / login assertion), the port
 * of upstream's go-webauthn dependency surface reduced to what Gitea
 * actually exercises (routers/web/auth/webauthn.go + routers/web/user/
 * setting/security/webauthn.go at the pin).
 *
 * ## The ceremony-state carrier (our equivalent of upstream's session-held
 *    SessionData — the module the mission pins for this decision)
 *
 * Upstream holds ceremony state in the SERVER-SIDE session: BeginRegistration
 * parks `webauthn.SessionData` under `webauthnRegistration`, BeginLogin under
 * `webauthnAssertion`, BeginDiscoverableLogin under `webauthnPasskeyAssertion`
 * (webauthn.go:65-67, 195-199, 65-67), and the pre-login identity rides
 * `twofaUid` + `twofaRemember` (auth.go handleTwoFactorRequired). Our
 * substrate has the same constraint the OAuth2 dance hit (the identity.ts
 * module header): D1 session rows REQUIRE a signed-in user, and the assertion
 * ceremony runs BEFORE the session exists — that is the point of 2FA. The
 * as-built carrier is a short-lived HMAC-SIGNED cookie `gitea_webauthn`
 * (the `gitea_oauth2_state` anonymous-carrier pattern, hardened):
 *
 *   value = base64url(JSON state) + "." + base64url(HMAC-SHA256(payload, key))
 *
 * The key is the SHARED `general_token_signing_secret` keystore row (the
 * [oauth2] JWT_SECRET role — the same material the container-registry HMAC
 * and the Actions tokens key off). Tampering breaks the MAC; forging
 * requires the server secret; the challenge is 32 crypto-random bytes so a
 * known-state replay can never be planted. Kinds (`k`):
 *
 *   pending — the login gate's pre-auth identity (upstream twofaUid/
 *             twofaRemember): {uid, rem, to}; NO challenge — the assertion
 *             GET issues its own.
 *   assert  — the login challenge (upstream webauthnAssertion): challenge +
 *             the allowed-credential allowlist.
 *   passkey — the discoverable-login challenge (upstream
 *             webauthnPasskeyAssertion): challenge, no allowlist, no uid.
 *   reg     — the registration challenge (upstream webauthnRegistration +
 *             webauthnName): challenge + the reserved nickname, uid-bound.
 *
 * TTLs: challenge kinds 60 s (go-webauthn's TimeoutDefault, what the options'
 * `timeout` tells the browser); pending 600 s (the oauth2 dance carrier's
 * Max-Age — a login completes in seconds, the bound only caps a stale
 * carrier). Single-use: every consuming arm CLEARS the cookie (upstream's
 * `defer ctx.Session.Delete(...)` twin); for counter-credential replays the
 * sign-count CAS in webauthn-store.ts makes rejection DURABLE (the replayed
 * count cannot re-pass the monotonic ladder after the first verify moved it)
 * — zero-counter credentials keep upstream's exact semantics (count 0 means
 * "no replay detection possible", the go-webauthn clone-warning ladder's own
 * arm).
 *
 * ## The verify ladders (go-webauthn FinishRegistration/ValidateLogin)
 *
 * Registration (CreateCredential): parse → clientData type/challenge/origin →
 * rpIdHash → UP (+UV — Gitea registers with UserVerification required,
 * security/webauthn.go:68) → attestation format ("none" empty-statement, or
 * "packed" SELF-attestation verified against the credential's own key;
 * everything else rejects — Gitea's AttestationPreference is never-verify,
 * webauthn.go:34, and real authenticators answer none/self under it) →
 * attested credential data (aaguid, credential id, COSE key).
 * Assertion (ValidateLogin): parse → rawId↔id match → credential lookup (the
 * caller's store read) → clientData → rpIdHash → UP (upstream 400s without
 * it, webauthn.go:121-124/234-235) → signature over authData‖SHA256(
 * clientDataJSON) → the sign-count ladder (≤ stored ⇒ clone detected ⇒ the
 * caller 403s, webauthn.go:133-137/245-249).
 *
 * Deriving the RP from the REQUEST (not app.ini): upstream's config is
 * RPDisplayName=AppName, RPID=AppDomain, RPOrigins=[FullyQualifiedOrigin(
 * AppURL)] (modules/auth/webauthn/webauthn.go:29-44); a Worker has no app.ini
 * — the request URL's origin/hostname are the per-request equivalents
 * (documented adaptation; rpId is a registrable domain suffix, ports never
 * appear in it).
 */

import { CborError, decodeCbor, decodeCborItem, type CborValue } from "./webauthn-cbor";
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesEqual,
  coseKeyAlg,
  coseVerify,
  importCoseKey,
  parseCoseKey,
  sha256,
  type CoseKey,
} from "./webauthn-cose";

// ---------------------------------------------------------------------------
// Errors — the ladders' failure arms, each mapping to the upstream status
// ---------------------------------------------------------------------------

/** A ceremony failure. `arm` names the upstream arm the caller answers:
 *  "forbidden" (403 — the failed-parse/failed-validate ladder of
 *  webauthn.go:94-99/114-119/226-231/236-241), "bad-request" (400 — the
 *  missing-UP/user arms), "conflict" (409 — the settings name arms),
 *  "server-error" (500 — the ServerError arms: not-in-session, unknown
 *  attestation, store failures). */
export class WebAuthnError extends Error {
  readonly arm: "forbidden" | "bad-request" | "conflict" | "server-error";
  constructor(arm: WebAuthnError["arm"], message: string) {
    super(message);
    this.name = "WebAuthnError";
    this.arm = arm;
  }
}

// ---------------------------------------------------------------------------
// The ceremony-state cookie (module header — the carrier design)
// ---------------------------------------------------------------------------

export const WEBAUTHN_COOKIE_NAME = "gitea_webauthn";

/** The CHALLENGE states' separate carrier. Upstream holds the pending
 *  identity (`twofaUid`) and the challenge (`webauthnAssertion`) as two
 *  keys of one server session; our two cookie names are that split — and it
 *  is LOAD-BEARING: issuing a login challenge must not clobber the pending
 *  identity the POST still needs (both would otherwise share one name and
 *  the second Set-Cookie would overwrite the first). `pending` and `reg`
 *  ride the identity name (they never coexist with each other); `assert`
 *  and `passkey` share the challenge name (upstream clobbers its own
 *  session keys the same way). */
export const WEBAUTHN_CHALLENGE_COOKIE_NAME = "gitea_webauthn_challenge";

/** Which carrier a kind rides (module header). */
export function ceremonyCookieName(kind: CeremonyKind): string {
  return kind === "assert" || kind === "passkey" ? WEBAUTHN_CHALLENGE_COOKIE_NAME : WEBAUTHN_COOKIE_NAME;
}

/** The shared keystore row — services/actions/secrets.ts:73's constant, the
 *  [oauth2] JWT_SECRET / GetGeneralTokenSigningSecret piece. Declared
 *  locally to keep this module's graph leaf-only (the link-account-router
 *  assetsBinding precedent); the value is the same material. */
export const KEYSTORE_SECRET_ROW = "general_token_signing_secret";

const CHALLENGE_TTL_MS = 60_000; // go-webauthn TimeoutDefault
const PENDING_TTL_MS = 600_000; // the gitea_oauth2_state Max-Age precedent

export type CeremonyKind = "pending" | "assert" | "passkey" | "reg";

/** The signed state — module header's field set, fixed wire order. */
export interface CeremonyState {
  v: 1;
  k: CeremonyKind;
  /** users.id (all kinds except passkey, where it is 0 — no identity yet). */
  uid: number;
  /** The challenge, base64url ("" for `pending` — no challenge yet). */
  ch: string;
  /** Unix-seconds expiry. */
  exp: number;
  /** reg: the reserved credential nickname. */
  name?: string;
  /** assert: the allowlist — the user's enrolled credential ids, base64url. */
  ac?: string[];
  /** pending: the login form's remember decision. */
  rem?: boolean;
  /** pending: the validated redirect target (safeRedirectTarget's output). */
  to?: string;
}

function encodeState(state: CeremonyState): string {
  const ordered: Record<string, unknown> = { v: state.v, k: state.k, uid: state.uid, ch: state.ch, exp: state.exp };
  if (state.name !== undefined) ordered.name = state.name;
  if (state.ac !== undefined) ordered.ac = state.ac;
  if (state.rem !== undefined) ordered.rem = state.rem;
  if (state.to !== undefined) ordered.to = state.to;
  return JSON.stringify(ordered);
}

function decodeState(raw: string): CeremonyState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1) return null;
    const kind = record.k;
    if (kind !== "pending" && kind !== "assert" && kind !== "passkey" && kind !== "reg") return null;
    const uid = record.uid;
    const ch = record.ch;
    const exp = record.exp;
    if (typeof uid !== "number" || !Number.isInteger(uid) || typeof ch !== "string" || typeof exp !== "number") {
      return null;
    }
    const state: CeremonyState = { v: 1, k: kind, uid, ch, exp };
    if (typeof record.name === "string") state.name = record.name;
    if (Array.isArray(record.ac) && record.ac.every((item) => typeof item === "string")) {
      state.ac = record.ac;
    }
    if (typeof record.rem === "boolean") state.rem = record.rem;
    if (typeof record.to === "string") state.to = record.to;
    return state;
  } catch {
    return null;
  }
}

async function hmacKey(d1: D1Database): Promise<CryptoKey> {
  // The shared secret row — read, and on a cold instance generate-once-save-
  // back (insert-on-conflict-do-nothing + read-back, the actions/container
  // keystore posture). Cached per isolate with the D1 identity key.
  if (hmacKeyCache.d1 === d1 && hmacKeyCache.promise !== null) return hmacKeyCache.promise;
  const promise = (async (): Promise<CryptoKey> => {
    const readHex = (value: string): string => {
      const parsed = JSON.parse(value) as { tokenSigningSecret?: unknown };
      if (typeof parsed.tokenSigningSecret === "string" && parsed.tokenSigningSecret !== "") {
        return parsed.tokenSigningSecret;
      }
      throw new Error("webauthn: keystore secret row is malformed");
    };
    const { drizzle } = await import("drizzle-orm/d1");
    const { systemKeystore } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const db = drizzle(d1);
    const row = await db.select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_SECRET_ROW)).get();
    let secretHex: string;
    if (row !== undefined) {
      secretHex = readHex(row.value);
    } else {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      let generated = "";
      for (const b of bytes) generated += b.toString(16).padStart(2, "0");
      const now = new Date();
      await db
        .insert(systemKeystore)
        .values({ name: KEYSTORE_SECRET_ROW, value: JSON.stringify({ v: 1, tokenSigningSecret: generated }), createdAt: now, updatedAt: now })
        .onConflictDoNothing();
      const winner = await db.select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_SECRET_ROW)).get();
      if (winner === undefined) throw new Error("webauthn: keystore secret row missing after insert (D1 write failed?)");
      secretHex = readHex(winner.value);
    }
    const bytes = new Uint8Array(secretHex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(secretHex.slice(i * 2, i * 2 + 2), 16);
    return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  })();
  hmacKeyCache.d1 = d1;
  hmacKeyCache.promise = promise;
  promise.catch(() => {
    if (hmacKeyCache.d1 === d1) {
      hmacKeyCache.d1 = null;
      hmacKeyCache.promise = null;
    }
  });
  return promise;
}

const hmacKeyCache: { d1: D1Database | null; promise: Promise<CryptoKey> | null } = { d1: null, promise: null };

/** TEST-ONLY: drop the module-level HMAC-key cache (an isolate restart). */
export function resetWebAuthnKeyCacheForTests(): void {
  hmacKeyCache.d1 = null;
  hmacKeyCache.promise = null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mint the cookie VALUE (`payload.signature`) — the caller sets it with
 *  {@link webAuthnSetCookie}. */
export async function signCeremonyState(d1: D1Database, state: Omit<CeremonyState, "v" | "exp">): Promise<string> {
  const key = await hmacKey(d1);
  const ttl = state.k === "pending" ? PENDING_TTL_MS : CHALLENGE_TTL_MS;
  const full: CeremonyState = { ...state, v: 1, exp: Math.floor(Date.now() / 1000 + ttl / 1000) };
  const payload = base64UrlEncode(new TextEncoder().encode(encodeState(full)));
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Verify + decode a cookie value. ANY failure (malformed, tampered, wrong
 *  kind, expired) answers null — never a partial state. */
export async function verifyCeremonyState(
  d1: D1Database,
  value: string | null | undefined,
  kind: CeremonyKind,
): Promise<CeremonyState | null> {
  if (value === null || value === undefined) return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  let key: CryptoKey;
  try {
    key = await hmacKey(d1);
  } catch {
    return null;
  }
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(signature), new TextEncoder().encode(payload));
  } catch {
    return null;
  }
  if (!valid) return null;
  let state: CeremonyState | null;
  try {
    state = decodeState(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    return null;
  }
  if (state === null || state.k !== kind) return null;
  if (state.exp * 1000 <= Date.now()) return null;
  return state;
}

/** The Set-Cookie directive — the session cookie's flag set (HttpOnly,
 *  Secure, SameSite=Lax) on the kind's carrier (ceremonyCookieName's split)
 *  with the 60 s Max-Age (the state self-expires with the ceremony). */
export function webAuthnSetCookie(value: string, kind: CeremonyKind): string {
  return `${ceremonyCookieName(kind)}=${encodeURIComponent(value)}; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax`;
}

/** The PENDING carrier's directive — the 600 s Max-Age (the oauth2 dance
 *  carrier's bound: a login completes in seconds, the cap only retires a
 *  stale pre-auth identity). The ui/session.ts login gate sets it. */
export function webAuthnPendingSetCookie(value: string): string {
  return `${WEBAUTHN_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

export function webAuthnClearCookie(kind: CeremonyKind): string {
  return `${ceremonyCookieName(kind)}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** First cookie value for `kind`'s carrier, URI-decoded; null when absent. */
export function webAuthnCookieValue(req: Request, kind: CeremonyKind): string | null {
  const name = ceremonyCookieName(kind);
  const header = req.headers.get("cookie");
  if (header === null) return null;
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    if (pair.slice(0, at).trim() === name) {
      const raw = pair.slice(at + 1).trim();
      if (raw === "") return null;
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The RP derivation (module header — the request-origin adaptation)
// ---------------------------------------------------------------------------

export interface RelyingParty {
  /** The rpId — the request hostname (ports never appear in an RP ID). */
  id: string;
  /** The display name (upstream setting.AppName). */
  name: string;
  /** The exact origin the clientData must carry. */
  origin: string;
}

export function relyingPartyFromRequest(req: Request, appName: string): RelyingParty {
  const url = new URL(req.url);
  return { id: url.hostname, name: appName, origin: url.origin };
}

// ---------------------------------------------------------------------------
// Authenticator data (WebAuthn L2 §6.1)
// ---------------------------------------------------------------------------

export interface AuthenticatorFlags {
  up: boolean;
  uv: boolean;
  be: boolean;
  bs: boolean;
  at: boolean;
  ed: boolean;
}

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: AuthenticatorFlags;
  signCount: number;
  /** Present when the AT flag is set (registration). */
  aaguid?: Uint8Array;
  credentialId?: Uint8Array;
  coseKey?: CoseKey;
  /** The raw bytes — the assertion signature's first half. */
  raw: Uint8Array;
}

/**
 * Parse authenticator data: rpIdHash(32) ‖ flags(1) ‖ signCount(4 BE) then,
 * with AT, the attested credential data (aaguid(16) ‖ credIdLen(2 BE) ‖
 * credId ‖ COSE key) and, with ED, the extensions map. Every walk step
 * validates the remaining length; the structure must consume the buffer
 * exactly.
 */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw new WebAuthnError("forbidden", "authenticator data shorter than the fixed header");
  const rpIdHash = bytes.slice(0, 32);
  const flagByte = bytes[32]!;
  const flags: AuthenticatorFlags = {
    up: (flagByte & 0x01) !== 0,
    uv: (flagByte & 0x04) !== 0,
    be: (flagByte & 0x08) !== 0,
    bs: (flagByte & 0x10) !== 0,
    at: (flagByte & 0x40) !== 0,
    ed: (flagByte & 0x80) !== 0,
  };
  const signCount =
    bytes[33]! * 0x1000000 + bytes[34]! * 0x10000 + bytes[35]! * 0x100 + bytes[36]!;
  const result: AuthenticatorData = { rpIdHash, flags, signCount, raw: bytes };
  let cursor = 37;
  if (flags.at) {
    if (cursor + 18 > bytes.length) throw new WebAuthnError("forbidden", "attested credential data truncated");
    result.aaguid = bytes.slice(cursor, cursor + 16);
    cursor += 16;
    const credLen = bytes[cursor]! * 0x100 + bytes[cursor + 1]!;
    cursor += 2;
    if (cursor + credLen > bytes.length) throw new WebAuthnError("forbidden", "credential id truncated");
    result.credentialId = bytes.slice(cursor, cursor + credLen);
    cursor += credLen;
    try {
      const key = parseCoseKey(bytes, cursor);
      result.coseKey = key.key;
      cursor = key.end;
    } catch (error) {
      if (error instanceof CborError) throw new WebAuthnError("forbidden", `COSE key: ${error.message}`);
      throw error;
    }
  }
  if (flags.ed) {
    try {
      const extensions = decodeCborItem(bytes, cursor);
      if (!(extensions.value instanceof Map)) throw new CborError("extensions not a map");
      cursor = extensions.offset;
    } catch (error) {
      if (error instanceof CborError) throw new WebAuthnError("forbidden", `extensions: ${error.message}`);
      throw error;
    }
  }
  if (cursor !== bytes.length) throw new WebAuthnError("forbidden", "authenticator data has trailing bytes");
  return result;
}

// ---------------------------------------------------------------------------
// clientDataJSON (WebAuthn L2 §5.8.1)
// ---------------------------------------------------------------------------

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

function parseClientData(clientDataJson: Uint8Array, expectedType: string, expectedChallenge: string, expectedOrigin: string): ClientData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(clientDataJson));
  } catch {
    throw new WebAuthnError("forbidden", "clientDataJSON is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WebAuthnError("forbidden", "clientDataJSON is not an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== expectedType) {
    throw new WebAuthnError("forbidden", `clientData type ${String(record.type)} (want ${expectedType})`);
  }
  if (typeof record.challenge !== "string" || !constantTimeEqual(record.challenge, expectedChallenge)) {
    throw new WebAuthnError("forbidden", "clientData challenge mismatch");
  }
  if (typeof record.origin !== "string" || record.origin !== expectedOrigin) {
    throw new WebAuthnError("forbidden", "clientData origin mismatch");
  }
  return { type: record.type, challenge: record.challenge, origin: record.origin };
}

// ---------------------------------------------------------------------------
// The wire request bodies (ParseCredentialCreationResponse /
// ParseCredentialRequestResponse — exactly what the vendored frontend's
// user-auth-webauthn.ts POSTs)
// ---------------------------------------------------------------------------

export interface ParsedCreationResponse {
  rawId: Uint8Array;
  attestationObject: Uint8Array;
  clientDataJSON: Uint8Array;
  transports: string[] | null;
}

export function parseCreationResponse(body: unknown): ParsedCreationResponse {
  const record = bodyRecord(body, "forbidden");
  const response = bodyRecord(record.response, "forbidden");
  const type = record.type;
  if (type !== "public-key") throw new WebAuthnError("forbidden", `credential type ${String(type)} (want public-key)`);
  const rawId = decodeB64(record.rawId, "rawId");
  const id = record.id;
  if (typeof id !== "string" || id !== base64UrlEncode(rawId)) {
    throw new WebAuthnError("forbidden", "id and rawId do not match");
  }
  const attestationObject = decodeB64(response.attestationObject, "attestationObject");
  const clientDataJSON = decodeB64(response.clientDataJSON, "clientDataJSON");
  const transports =
    Array.isArray(response.transports) && response.transports.every((t) => typeof t === "string")
      ? response.transports
      : null;
  return { rawId, attestationObject, clientDataJSON, transports };
}

export interface ParsedAssertionResponse {
  rawId: Uint8Array;
  userHandle: Uint8Array | null;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}

export function parseAssertionResponse(body: unknown): ParsedAssertionResponse {
  const record = bodyRecord(body, "forbidden");
  const response = bodyRecord(record.response, "forbidden");
  if (record.type !== "public-key") throw new WebAuthnError("forbidden", `credential type ${String(record.type)} (want public-key)`);
  const rawId = decodeB64(record.rawId, "rawId");
  const id = record.id;
  if (typeof id !== "string" || id !== base64UrlEncode(rawId)) {
    throw new WebAuthnError("forbidden", "id and rawId do not match");
  }
  const userHandle = response.userHandle === undefined || response.userHandle === null || response.userHandle === ""
    ? null
    : decodeB64(response.userHandle, "userHandle");
  return {
    rawId,
    userHandle,
    authenticatorData: decodeB64(response.authenticatorData, "authenticatorData"),
    clientDataJSON: decodeB64(response.clientDataJSON, "clientDataJSON"),
    signature: decodeB64(response.signature, "signature"),
  };
}

function bodyRecord(value: unknown, arm: WebAuthnError["arm"]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebAuthnError(arm, "request body field is not an object");
  }
  return value as Record<string, unknown>;
}

function decodeB64(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || value === "") throw new WebAuthnError("forbidden", `field ${field} missing or not base64url`);
  try {
    return base64UrlDecode(value);
  } catch {
    throw new WebAuthnError("forbidden", `field ${field} is not base64url`);
  }
}

// ---------------------------------------------------------------------------
// The options builders (BeginRegistration / BeginLogin /
// BeginDiscoverableLogin's public-key payloads)
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 60_000; // go-webauthn TimeoutDefault — mirrors the state TTL

export interface CredentialOptionsUser {
  id: Uint8Array;
  name: string;
  displayName: string;
}

/** PublicKeyCredentialCreationOptions — the shape the vendored JS's
 *  webAuthnRegisterRequest consumes (options.publicKey.challenge/user.id/
 *  excludeCredentials[].id are base64url it decodes). */
export function buildCreationOptions(
  rp: RelyingParty,
  user: CredentialOptionsUser,
  challenge: Uint8Array,
  excludeCredentialIds: Uint8Array[],
): { publicKey: Record<string, unknown> } {
  return {
    publicKey: {
      rp: { id: rp.id, name: rp.name },
      user: { id: base64UrlEncode(user.id), name: user.name, displayName: user.displayName },
      challenge: base64UrlEncode(challenge),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      timeout: TIMEOUT_MS,
      excludeCredentials: excludeCredentialIds.map((id) => ({ type: "public-key", id: base64UrlEncode(id) })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none",
    },
  };
}

/** PublicKeyCredentialRequestOptions — the login (2FA) shape:
 *  allowCredentials = the user's enrolled ids, userVerification "preferred"
 *  (upstream VerificationPreferred, webauthn.go:189 — "discouraged would
 *  hide credProtect protected credentials"). */
export function buildRequestOptions(
  rp: RelyingParty,
  challenge: Uint8Array,
  allowCredentialIds: Uint8Array[],
): { publicKey: Record<string, unknown> } {
  return {
    publicKey: {
      challenge: base64UrlEncode(challenge),
      timeout: TIMEOUT_MS,
      rpId: rp.id,
      allowCredentials: allowCredentialIds.map((id) => ({ type: "public-key", id: base64UrlEncode(id) })),
      userVerification: "preferred",
    },
  };
}

/** The passkey (discoverable) shape: NO allowCredentials, userVerification
 *  "required" (upstream WithUserVerification(VerificationRequired),
 *  webauthn.go:59). */
export function buildDiscoverableRequestOptions(rp: RelyingParty, challenge: Uint8Array): { publicKey: Record<string, unknown> } {
  return {
    publicKey: {
      challenge: base64UrlEncode(challenge),
      timeout: TIMEOUT_MS,
      rpId: rp.id,
      userVerification: "required",
    },
  };
}

// ---------------------------------------------------------------------------
// The registration ladder (FinishRegistration → CreateCredential)
// ---------------------------------------------------------------------------

export interface VerifiedRegistration {
  credentialId: Uint8Array;
  coseKey: CoseKey;
  publicKeyRaw: Uint8Array;
  attestationType: string;
  aaguid: Uint8Array;
  signCount: number;
  transports: string[] | null;
  userPresent: boolean;
  userVerified: boolean;
}

/**
 * The attestation verification. `expected` carries the ceremony binding (the
 * state's challenge, the request-derived RP, and UV required — Gitea's
 * authenticatorSelection). Throws WebAuthnError on every reject arm.
 */
export async function verifyRegistration(
  parsed: ParsedCreationResponse,
  expected: { challenge: string; rp: RelyingParty; requireUserVerification: boolean },
): Promise<VerifiedRegistration> {
  parseClientData(parsed.clientDataJSON, "webauthn.create", expected.challenge, expected.rp.origin);

  let attestation: Map<CborValue, CborValue>;
  try {
    const decoded = decodeCbor(parsed.attestationObject);
    if (!(decoded instanceof Map)) throw new CborError("attestationObject is not a map");
    attestation = decoded;
  } catch (error) {
    if (error instanceof CborError) throw new WebAuthnError("forbidden", `attestationObject: ${error.message}`);
    throw error;
  }
  const fmt = attestation.get("fmt");
  const attStmt = attestation.get("attStmt");
  const authDataBytes = attestation.get("authData");
  if (typeof fmt !== "string" || !(attStmt instanceof Map) || !(authDataBytes instanceof Uint8Array)) {
    throw new WebAuthnError("forbidden", "attestationObject missing fmt/attStmt/authData");
  }
  const authData = parseAuthenticatorData(authDataBytes);

  // The RP ID hash — SHA-256 of the rpId string.
  const expectedRpIdHash = await sha256(new TextEncoder().encode(expected.rp.id));
  if (!bytesEqual(authData.rpIdHash, expectedRpIdHash)) {
    throw new WebAuthnError("forbidden", "authenticator data RP ID hash mismatch");
  }
  if (!authData.flags.up) throw new WebAuthnError("forbidden", "user-presence flag not set");
  if (expected.requireUserVerification && !authData.flags.uv) {
    throw new WebAuthnError("forbidden", "user-verification flag not set");
  }
  if (!authData.flags.at || authData.credentialId === undefined || authData.coseKey === undefined || authData.aaguid === undefined) {
    throw new WebAuthnError("forbidden", "no attested credential data");
  }

  // The attestation format: "none" (empty statement) or "packed" SELF-
  // attestation (no cert chain, signature over authData‖clientHash with the
  // credential's own key — module header). Everything else rejects: Gitea
  // never verifies attestation, so any certified-statement format would
  // fail upstream's own verification too.
  let attestationType: string;
  if (fmt === "none") {
    if (attStmt.size !== 0) throw new WebAuthnError("forbidden", "none attestation carries a statement");
    attestationType = "none";
  } else if (fmt === "packed") {
    if (attStmt.has("x5c")) throw new WebAuthnError("forbidden", "packed attestation with a certificate chain is not accepted");
    const alg = attStmt.get("alg");
    const sig = attStmt.get("sig");
    if (typeof alg !== "number" || !(sig instanceof Uint8Array)) {
      throw new WebAuthnError("forbidden", "packed attestation missing alg/sig");
    }
    if (alg !== coseKeyAlg(authData.coseKey)) throw new WebAuthnError("forbidden", "packed attestation alg mismatch");
    const clientHash = await sha256(parsed.clientDataJSON);
    const signed = new Uint8Array(authData.raw.length + clientHash.length);
    signed.set(authData.raw, 0);
    signed.set(clientHash, authData.raw.length);
    const imported = await importCoseKey(authData.coseKey);
    const ok = await coseVerify(imported, authData.coseKey, sig, signed);
    if (!ok) throw new WebAuthnError("forbidden", "packed self-attestation signature invalid");
    attestationType = "self";
  } else {
    throw new WebAuthnError("server-error", `unsupported attestation format ${fmt}`);
  }

  return {
    credentialId: authData.credentialId,
    coseKey: authData.coseKey,
    // The key's canonical re-encoding (the COSE map bytes we parsed) — the
    // stored verification material.
    publicKeyRaw: encodeCoseKey(authData.coseKey),
    attestationType,
    aaguid: authData.aaguid,
    signCount: authData.signCount,
    transports: parsed.transports,
    userPresent: authData.flags.up,
    userVerified: authData.flags.uv,
  };
}

// ---------------------------------------------------------------------------
// The assertion ladder (ValidateLogin)
// ---------------------------------------------------------------------------

export interface StoredCredential {
  credentialId: Uint8Array;
  coseKey: CoseKey;
  signCount: number;
}

export interface VerifiedAssertion {
  userPresent: boolean;
  userVerified: boolean;
  backupEligible: boolean;
  backupState: boolean;
  signCount: number;
  /** The go-webauthn clone-warning arm: the counter did not advance. */
  cloneDetected: boolean;
}

/**
 * The assertion verification for a LOADED credential (the caller resolves
 * rawId → row first; the login arm through the session-bound user, the
 * passkey arm through the userHandle). The sign-count ladder (module
 * header) runs AFTER the signature check — a replay of a COUNTER credential
 * fails the monotonic comparison and flags the clone; the CAS in the store
 * makes that durable.
 */
export async function verifyAssertion(
  parsed: ParsedAssertionResponse,
  stored: StoredCredential,
  expected: { challenge: string; rp: RelyingParty; expectedUserHandle?: Uint8Array },
): Promise<VerifiedAssertion> {
  if (!bytesEqual(parsed.rawId, stored.credentialId)) {
    throw new WebAuthnError("forbidden", "assertion rawId does not match the credential");
  }
  if (expected.expectedUserHandle !== undefined && (parsed.userHandle === null || !bytesEqual(parsed.userHandle, expected.expectedUserHandle))) {
    throw new WebAuthnError("forbidden", "userHandle mismatch");
  }
  parseClientData(parsed.clientDataJSON, "webauthn.get", expected.challenge, expected.rp.origin);
  const authData = parseAuthenticatorData(parsed.authenticatorData);
  const expectedRpIdHash = await sha256(new TextEncoder().encode(expected.rp.id));
  if (!bytesEqual(authData.rpIdHash, expectedRpIdHash)) {
    throw new WebAuthnError("forbidden", "authenticator data RP ID hash mismatch");
  }
  if (!authData.flags.up) throw new WebAuthnError("bad-request", "user-presence flag not set");

  const clientHash = await sha256(parsed.clientDataJSON);
  const signed = new Uint8Array(authData.raw.length + clientHash.length);
  signed.set(authData.raw, 0);
  signed.set(clientHash, authData.raw.length);
  const imported = await importCoseKey(stored.coseKey);
  const ok = await coseVerify(imported, stored.coseKey, parsed.signature, signed);
  if (!ok) throw new WebAuthnError("forbidden", "assertion signature invalid");

  // The clone-warning ladder (go-webauthn Authenticator semantics): when
  // EITHER side of the counter is nonzero the counter must strictly
  // increase; ≤ stored flags the clone (the caller 403s — upstream's
  // CloneWarning arm). Zero counters on both sides mean the authenticator
  // keeps none — no replay signal exists, upstream's own posture.
  let cloneDetected = false;
  if (authData.signCount !== 0 || stored.signCount !== 0) {
    cloneDetected = authData.signCount <= stored.signCount;
  }
  return {
    userPresent: authData.flags.up,
    userVerified: authData.flags.uv,
    backupEligible: authData.flags.be,
    backupState: authData.flags.bs,
    signCount: authData.signCount,
    cloneDetected,
  };
}

// ---------------------------------------------------------------------------
// The COSE canonical encoder (store side — the stored public_key bytes)
// ---------------------------------------------------------------------------

/** Re-encode a parsed COSE key to its canonical CBOR map form — the bytes
 *  the store persists and re-parses at every login. WebAuthn's COSE keys
 *  use integer keys; canonical CBOR orders integer map keys ascending, and
 *  the layouts below match what authenticators emit for ES256/RS256. */
export function encodeCoseKey(key: CoseKey): Uint8Array {
  const entries: Array<[number, Uint8Array | number]> =
    key.kty === "EC2"
      ? [
          [1, 2], // kty: EC2
          [3, -7], // alg: ES256
          [-1, 1], // crv: P-256
          [-2, key.x],
          [-3, key.y],
        ]
      : [
          [1, 3], // kty: RSA
          [3, -257], // alg: RS256
          [-1, key.n],
          [-2, key.e],
        ];
  // Canonical CBOR: map keys in ascending byte order. For these integer
  // keys (1, 3, -1, -2, -3) ascending NUMERIC order equals the CTAP2
  // canonical form (negative ints sort by encoded value).
  const ordered = [...entries].sort((a, b) => a[0] - b[0]);
  const chunks: Uint8Array[] = [];
  chunks.push(new Uint8Array([0xa0 | 5])); // major 5, length 5
  for (const [k, v] of ordered) {
    if (k >= 0) chunks.push(encodeHead(0, k));
    else chunks.push(encodeHead(1, -1 - k)); // negative int: -(n+1) = k
    if (typeof v === "number") {
      chunks.push(k === 3 ? encodeHead(1, -1 - v) : encodeHead(0, v));
    } else {
      chunks.push(encodeHead(2, v.length));
      chunks.push(v);
    }
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function encodeHead(major: number, value: number): Uint8Array {
  const m = major << 5;
  if (value < 24) return new Uint8Array([m | value]);
  if (value < 0x100) return new Uint8Array([m | 24, value]);
  if (value < 0x10000) return new Uint8Array([m | 25, value >> 8, value & 0xff]);
  return new Uint8Array([m | 26, (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

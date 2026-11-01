/**
 * The two_factor store seam + the enrollment/gate flows — the port of
 * upstream models/auth/twofactor.go (the TwoFactor model and its helpers),
 * routers/web/user/setting/security/2fa.go (enrollment, regenerate,
 * disable) and routers/web/auth/2fa.go's verify arms, over migration 0059's
 * `two_factor` table (the landed drizzle `twoFactor`).
 *
 * ## Recorded divergences (each carries its pin cite)
 *
 *   - SECRET AT REST: upstream AES-encrypts the secret with
 *     md5(SECRET_KEY) and stores base64 (twofactor.go:93-106); ours stores
 *     the base32 secret in the clear — the landed schema's own decision
 *     (schema.ts `twoFactor.secret`: "the TOTP shared secret (base32)"; D1
 *     is the source of truth and no [security] SECRET_KEY var exists to
 *     encrypt with). Documented here once; do not re-litigate per call.
 *   - REPLAY GUARD: upstream stores the last-used PASSCODE STRING and
 *     refuses a second redemption of the same string
 *     (twofactor.go:127-143, the conditional UPDATE over
 *     `last_used_passcode`); ours consumes the matched PERIOD
 *     (`last_used_passcode_period`, the landed column) with a monotonic
 *     `period < matched` guard — strictly stronger (an OLDER window's code
 *     is rejected too, RFC 6238 §5.2's own recommendation) and the exact
 *     shape the schema comment pins. ValidateAndConsumeTOTP's
 *     read-validate-write TOCTOU closes the same way: the UPDATE is the
 *     serialization point, a lost race is a rejection.
 *   - PENDING STATE: upstream parks the pre-auth principal in its
 *     server-side session (`twofaUid`/`twofaRemember`, auth.go:352-354)
 *     and the enrollment secret alongside (`twofaSecret`/`twofaUri`,
 *     security/2fa.go:145-152); our `sessions` rows carry no arbitrary
 *     keys, so BOTH travel in a signed ticket cookie instead —
 *     HMAC-SHA256 over a compact JSON payload keyed by the shared
 *     `general_token_signing_secret` system_keystore row (the landed
 *     instance secret that plays upstream's JWT_SECRET/SECRET_KEY role;
 *     operator-only rotation, the oauth2 keys.ts posture — outstanding
 *     tickets die with it, a user mid-flow just re-authenticates). Same
 *     trust shape as upstream's session cookie: possession of the
 *     unguessable signed value IS the authority to continue the flow.
 *   - WebAuthn: `HasTwoFactorOrWebAuthn` (twofactor.go:189-197) reduces to
 *     the TOTP half — no webauthn_credential store exists yet; the gate
 *     and the login flow's webauthn redirect arm are the next unit's.
 *   - AUDIT: upstream emits UserAuthenticationFailTwoFactor /
 *     UserTwoFactorEnable / UserTwoFactorDisable / UserTwoFactorRegenerate
 *     (2fa.go:88, security/2fa.go:62,100,282); the action ids are
 *     unregistered in the landed audit registry — NOT emitted, the
 *     account-link unload precedent (user-settings-security.tsx header).
 *   - The DISABLE arm requires a live code (the mission's mandate):
 *     upstream's form is a bare confirm dialog (security/twofa.tmpl);
 *     ours also demands a TOTP passcode or the scratch token, verified
 *     WITHOUT consuming/burning either (the disable must not spend a
 *     scratch code the user may still need). The divergence lives in the
 *     caller's form; this seam just verifies.
 */

import { and, eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { systemKeystore, twoFactor } from "../db/schema";
import {
  base32Encode,
  generateScratchSalt,
  generateScratchToken,
  hashScratchToken,
  verifyScratchTokenHash,
  verifyTotpPeriod,
} from "./totp";

/** One two_factor row (upstream's TwoFactor model; the D1 projection). */
export type TwoFactorRow = typeof twoFactor.$inferSelect;

// ---------------------------------------------------------------------------
// The existence/store reads (twofactor.go:159-174)
// ---------------------------------------------------------------------------

/** `HasTwoFactorByUID` — the login gate's predicate and the security
 *  page's `TOTPEnrolled` (security.go:73-78). */
export async function hasTwoFactorByUid(d1: D1Database, userId: number): Promise<boolean> {
  const row = await drizzle(d1)
    .select({ id: twoFactor.id })
    .from(twoFactor)
    .where(eq(twoFactor.userId, userId))
    .get();
  return row !== undefined;
}

/** `GetTwoFactorByUID` — null is ErrTwoFactorNotEnrolled's arm. */
export async function getTwoFactorByUid(d1: D1Database, userId: number): Promise<TwoFactorRow | null> {
  return (await drizzle(d1).select().from(twoFactor).where(eq(twoFactor.userId, userId)).get()) ?? null;
}

// ---------------------------------------------------------------------------
// Enrollment material (security/2fa.go twofaGenerateSecretAndQr, sans QR)
// ---------------------------------------------------------------------------

/** `totp.Generate(SecretSize: 40)` — 40 crypto-random bytes as base32 (64
 *  chars, no padding). */
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(40)));
}

/**
 * The otpauth:// URI — pquerna/otp v1.5.0's `Key.String()` bytes for
 * upstream's Generate call (totp/totp.go): path
 * `/{issuer}:{accountName}`, query keys SORTED with every key and value
 * `url.PathEscape`d (internal/encode.go — spaces as %20, not +), and ALL
 * of algorithm=SHA1, digits=6, issuer, period=30, secret set (v1.5.0 sets
 * the defaults explicitly). The QR code upstream also renders is NOT
 * ported (a barcode/PNG encoder is no trivial dependency — the recorded
 * no-QR divergence); authenticator apps accept the URI pasted directly.
 */
export function otpauthUri(secret: string, issuer: string, accountName: string): string {
  const pathEscape = (value: string): string => value.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]/g, (ch) => encodeURIComponent(ch));
  const query: Array<[string, string]> = [
    ["algorithm", "SHA1"],
    ["digits", "6"],
    ["issuer", issuer],
    ["period", "30"],
    ["secret", secret],
  ];
  const encoded = query
    .map(([k, v]) => `${pathEscape(k)}=${pathEscape(v)}`)
    .sort()
    .join("&");
  return `otpauth://totp/${pathEscape(issuer)}:${pathEscape(accountName)}?${encoded}`;
}

/**
 * Upstream's issuer: `setting.AppName + " (" + setting.AppDomain + ")"`,
 * ':' stripped (security/2fa.go:117). AppName is upstream's default
 * "Gitea" (no APP_NAME var landed); AppDomain derives from APP_URL's host
 * (our ROOT_URL-role var) — an unset/unparsable APP_URL degrades to the
 * bare app name.
 */
export function twofaIssuer(appUrl: string | undefined): string {
  let domain = "";
  if (appUrl !== undefined && appUrl !== "") {
    try {
      domain = new URL(appUrl).host;
    } catch {
      domain = "";
    }
  }
  return (domain === "" ? "Gitea" : `Gitea (${domain})`).replaceAll(":", "");
}

// ---------------------------------------------------------------------------
// The pending-state ticket (the session-stash analog — see the header)
// ---------------------------------------------------------------------------

/** The ticket cookie's name — `gitea_session` stays the AUTHENTICATED
 *  session's cookie; the pre-auth pending state must never be mistaken
 *  for one. */
export const TWOFA_COOKIE_NAME = "gitea_twofa";

/** The pending state's TTL — upstream's pre-auth session lives the server
 *  store's lifetime (24 h default); 24 h here, armed at mint. */
export const PENDING_TICKET_TTL_MS = 24 * 60 * 60 * 1000;

export type PendingTwofaTicket =
  | {
      /** The login gate's parked principal (upstream's `twofaUid` +
       *  `twofaRemember` + the redirect_to cookie — fused into one signed
       *  payload). */
      kind: "gate";
      userId: number;
      remember: boolean;
      redirectTo: string;
    }
  | {
      /** The enrollment stash (upstream's `twofaSecret` — the shown QR
       *  secret that the verify must match). */
      kind: "enroll";
      secret: string;
    };

/** The wire payload — the ticket plus its issued-at (epoch ms, the TTL's
 *  arm). An intersection (not an interface-extends: PendingTwofaTicket is
 *  a union). */
type TicketPayload = PendingTwofaTicket & { iat: number };

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacSha256Hex(keyHex: string, message: string): Promise<Uint8Array> {
  const keyBytes = new Uint8Array(keyHex.length / 2);
  for (let i = 0; i < keyBytes.length; i++) keyBytes[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

/** The shared instance-secret row (the `[security] SECRET_KEY` role here) —
 *  re-declared from services/oauth2/keys.ts to keep the modules decoupled:
 *  reading it must NOT trigger the Actions keystore's generate side effects
 *  (the keys.ts header's own decoupling note). Same row, same 32-random-
 *  bytes-hex payload, same insert-or-nothing + read-back arbitration. */
const GENERAL_TOKEN_SIGNING_SECRET_ROW = "general_token_signing_secret";

const signingSecretCache = new Map<string, Promise<string>>();

/** TEST-ONLY: drop the module-level signing-secret cache (the keys.ts
 *  resetSecretCaches precedent — simulates an isolate restart). */
export function resetTwofaSigningSecretCache(): void {
  signingSecretCache.clear();
}

async function loadSigningSecret(d1: D1Database): Promise<string> {
  const cached = signingSecretCache.get(GENERAL_TOKEN_SIGNING_SECRET_ROW);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<string> => {
    const db = drizzle(d1);
    const row = await db
      .select()
      .from(systemKeystore)
      .where(eq(systemKeystore.name, GENERAL_TOKEN_SIGNING_SECRET_ROW))
      .get();
    if (row !== undefined) return parseSigningSecretRow(row.value);
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    let secretHex = "";
    for (const b of secretBytes) secretHex += b.toString(16).padStart(2, "0");
    const now = new Date();
    await db
      .insert(systemKeystore)
      .values({ name: GENERAL_TOKEN_SIGNING_SECRET_ROW, value: JSON.stringify({ v: 1, tokenSigningSecret: secretHex }), createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    const rowAfter = await db
      .select()
      .from(systemKeystore)
      .where(eq(systemKeystore.name, GENERAL_TOKEN_SIGNING_SECRET_ROW))
      .get();
    if (rowAfter === undefined) {
      throw new Error("twofa: signing-secret row missing after insert (D1 write failed?)");
    }
    return parseSigningSecretRow(rowAfter.value);
  })();
  signingSecretCache.set(GENERAL_TOKEN_SIGNING_SECRET_ROW, promise);
  return promise;
}

function parseSigningSecretRow(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("twofa: signing-secret row is not valid JSON", { cause: error });
  }
  const secret = (parsed as { tokenSigningSecret?: unknown }).tokenSigningSecret;
  if (typeof secret !== "string" || secret === "") {
    throw new Error("twofa: signing-secret row malformed");
  }
  return secret;
}

/**
 * Mint the signed ticket cookie value: `base64url(payload).base64url(hmac)`.
 * The HMAC key is the shared instance secret; the payload is the compact
 * JSON of the ticket plus its issued-at.
 */
export async function mintPendingTicket(d1: D1Database, ticket: PendingTwofaTicket, now?: Date): Promise<string> {
  const payload: TicketPayload = { ...ticket, iat: (now ?? new Date()).getTime() };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${base64UrlEncode(await hmacSha256Hex(await loadSigningSecret(d1), body))}`;
}

/**
 * Verify a presented ticket of exactly `kind` — HMAC re-check in constant
 * time, then the TTL. Any malformed/mismatched/expired presentation is
 * null (the callers' not-in-a-2FA-session arm). A ticket of the OTHER kind
 * is null too — the two flows never cross-authenticate.
 */
export async function verifyPendingTicket(
  d1: D1Database,
  value: string,
  kind: PendingTwofaTicket["kind"],
  options?: { now?: Date },
): Promise<PendingTwofaTicket | null> {
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const body = value.slice(0, dot);
  const mac = base64UrlDecode(value.slice(dot + 1));
  if (mac === null) return null;
  const expected = await hmacSha256Hex(await loadSigningSecret(d1), body);
  if (mac.length !== expected.length || !crypto.subtle.timingSafeEqual(mac, expected)) {
    return null;
  }
  const jsonBytes = base64UrlDecode(body);
  if (jsonBytes === null) return null;
  let payload: TicketPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(jsonBytes)) as TicketPayload;
  } catch {
    return null;
  }
  if (payload.kind !== kind) return null;
  if (payload.iat + PENDING_TICKET_TTL_MS <= (options?.now ?? new Date()).getTime()) return null;
  if (payload.kind === "gate") {
    return { kind: "gate", userId: payload.userId, remember: payload.remember, redirectTo: payload.redirectTo };
  }
  return { kind: "enroll", secret: payload.secret };
}

/** The ticket's Set-Cookie directive — the §2.3 flag set (HttpOnly, Secure,
 *  SameSite=Lax, Path=/) with the TTL as Max-Age. */
export function twofaSetCookie(value: string): string {
  return `${TWOFA_COOKIE_NAME}=${value}; Path=/; Max-Age=${String(Math.floor(PENDING_TICKET_TTL_MS / 1000))}; HttpOnly; Secure; SameSite=Lax`;
}

/** The clear directive — Max-Age=0, same flags. */
export function clearTwofaSetCookie(): string {
  return `${TWOFA_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Read `gitea_twofa` from the request's Cookie header (first match wins),
 *  null when absent/empty — the sessionCookieValue shape. */
export function twofaCookieValue(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (header === null) return null;
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    if (pair.slice(0, at).trim() === TWOFA_COOKIE_NAME) {
      const value = pair.slice(at + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The row mutations (the flow arms)
// ---------------------------------------------------------------------------

export type EnrollmentOutcome =
  | { outcome: "already-enrolled" }
  | { outcome: "no-pending-secret" }
  | { outcome: "invalid-passcode" }
  | { outcome: "enrolled"; scratchToken: string };

/**
 * `EnrollTwoFactorPost`'s store half (security/2fa.go:195-286): verify the
 * passcode against the PENDING secret (the shown QR/URI secret — the
 * ticket), then insert the row with a fresh scratch token and retire the
 * pending stash. Outcomes map upstream's arms:
 *   - already-enrolled ← the pre-check `t != nil` (and the unique-constraint
 *     race, the FIXME's tolerated arm);
 *   - no-pending-secret ← the session-stash miss (`twofa_failed_get_secret`);
 *   - invalid-passcode ← `totp.Validate` false (`passcode_invalid`; the
 *     pending stash SURVIVES — upstream re-shows the same secret);
 *   - enrolled ← the success arm; the scratch token is the once-shown
 *     recovery key (only its salt+hash are stored).
 * The verify does NOT consume the passcode (upstream enrolls on
 * `totp.Validate`, not ValidateAndConsumeTOTP).
 */
export async function applyTwofaEnrollment(
  d1: D1Database,
  userId: number,
  passcode: string,
  pendingTicketValue: string | null,
  options?: { now?: Date },
): Promise<EnrollmentOutcome> {
  if (await hasTwoFactorByUid(d1, userId)) return { outcome: "already-enrolled" };
  const ticket =
    pendingTicketValue === null ? null : await verifyPendingTicket(d1, pendingTicketValue, "enroll", options);
  if (ticket === null || ticket.kind !== "enroll") return { outcome: "no-pending-secret" };
  const matched = await verifyTotpPeriod(passcode, ticket.secret, (options?.now ?? new Date()).getTime() / 1000);
  if (matched === null) return { outcome: "invalid-passcode" };

  const scratchToken = generateScratchToken();
  const scratchSalt = generateScratchSalt();
  const scratchHash = await hashScratchToken(scratchToken, scratchSalt);
  const nowUnix = Math.floor((options?.now ?? new Date()).getTime() / 1000);
  try {
    await drizzle(d1).insert(twoFactor).values({
      userId,
      secret: ticket.secret,
      scratchSalt,
      scratchHash,
      lastUsedPasscodePeriod: 0,
      createdUnix: nowUnix,
      updatedUnix: nowUnix,
    });
  } catch {
    // The unique index lost the race — another request enrolled this user
    // mid-flight (upstream's FIXME: "it's entirely possible that another
    // request has beaten us … tolerate the error").
    return { outcome: "already-enrolled" };
  }
  return { outcome: "enrolled", scratchToken };
}

/**
 * `ValidateAndConsumeTOTP` (twofactor.go:127-143) over the PERIOD guard:
 * verify in the ±1 window, then ONE conditional UPDATE —
 * `SET last_used_passcode_period = matched WHERE id = ? AND
 * last_used_passcode_period < matched` — so a replay (or a concurrent
 * duplicate) matches zero rows and is rejected, the write serializing the
 * racers exactly like upstream's row lock. False for an invalid passcode
 * AND for a replay.
 */
export async function validateAndConsumeTotp(
  d1: D1Database,
  row: TwoFactorRow,
  passcode: string,
  options?: { now?: Date },
): Promise<boolean> {
  const now = options?.now ?? new Date();
  const matched = await verifyTotpPeriod(passcode, row.secret, now.getTime() / 1000);
  if (matched === null) return false;
  const updated = await drizzle(d1)
    .update(twoFactor)
    .set({ lastUsedPasscodePeriod: matched, updatedUnix: Math.floor(now.getTime() / 1000) })
    .where(and(eq(twoFactor.id, row.id), lt(twoFactor.lastUsedPasscodePeriod, matched)))
    .run();
  return (updated.meta.changes ?? 0) > 0;
}

/** `VerifyScratchToken` over the row's salt/hash pair. */
export async function verifyScratchToken(row: TwoFactorRow, token: string): Promise<boolean> {
  return verifyScratchTokenHash(row.scratchHash, token, row.scratchSalt);
}

/**
 * `GenerateScratchToken` + `UpdateTwoFactor` (twofactor.go:68-76, the
 * regenerate and scratch-burn arms): a fresh token, new salt, re-derived
 * hash — the returned token is shown ONCE.
 */
export async function regenerateScratchToken(d1: D1Database, row: TwoFactorRow, options?: { now?: Date }): Promise<string> {
  const token = generateScratchToken();
  const salt = generateScratchSalt();
  await drizzle(d1)
    .update(twoFactor)
    .set({
      scratchSalt: salt,
      scratchHash: await hashScratchToken(token, salt),
      updatedUnix: Math.floor((options?.now ?? new Date()).getTime() / 1000),
    })
    .where(eq(twoFactor.id, row.id));
  return token;
}

export type DisableOutcome =
  | { outcome: "not-enrolled" }
  | { outcome: "invalid-code" }
  | { outcome: "disabled" };

/**
 * `DisableTwoFactor` (security/2fa.go:69-104) with the mission's
 * code requirement: `code` must verify as a TOTP passcode in the ±1 window
 * OR as the scratch token — either way WITHOUT consuming it (the disable
 * must not spend the user's last scratch code). `not-enrolled` is the
 * pre-check arm; the delete is keyed (id, userId) like
 * `DeleteTwoFactorByID` (twofactor.go:177-187).
 */
export async function applyTwofaDisable(
  d1: D1Database,
  userId: number,
  code: string,
  options?: { now?: Date },
): Promise<DisableOutcome> {
  const row = await getTwoFactorByUid(d1, userId);
  if (row === null) return { outcome: "not-enrolled" };
  const now = options?.now ?? new Date();
  const period = await verifyTotpPeriod(code, row.secret, now.getTime() / 1000);
  const codeOk = period !== null || (await verifyScratchToken(row, code));
  if (!codeOk) return { outcome: "invalid-code" };
  const deleted = await drizzle(d1)
    .delete(twoFactor)
    .where(and(eq(twoFactor.id, row.id), eq(twoFactor.userId, userId)))
    .run();
  if ((deleted.meta.changes ?? 0) === 0) {
    // The concurrent-disable race — upstream's "we must have been disabled
    // by another request" arm answers the SUCCESS flash either way.
  }
  return { outcome: "disabled" };
}

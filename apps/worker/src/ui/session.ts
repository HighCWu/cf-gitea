/**
 * Web sessions (SPEC-0010): PAT login, the `gitea_session` cookie, upstream
 * rotation + reuse-detection semantics, and the top-level routes
 *
 *   GET  /login   — the form (renders anonymous; a valid session redirects)
 *   POST /login   — verify PAT → mint the sessions row → Set-Cookie
 *   POST /logout  — delete the row (id + digest match), clear the cookie
 *
 * Both routes are TOP-LEVEL (§2.1): the dispatcher needs no route-table
 * change — they are not repo-scoped (segments.length < 2), fall through to
 * `app.fetch`, and this router claims them. Registration (orchestrator-owned
 * `src/index.ts`, next to the uiRouter mount):
 * `app.route("/", sessionRouter);` — order vs the uiRouter mount is
 * immaterial (neither claims the other's paths).
 *
 * Upstream is the vendored pin: cookie name `gitea_session`
 * (modules/setting/session.go:36,61), remember-me tokens as `id:secret`
 * pairs with sha256-at-rest and rotation (services/auth/auth_token.go:33-121
 * — CheckAuthToken is ported one-for-one in `verifySession`),
 * SetSiteCookie's HttpOnly hardcode (modules/web/middleware/cookie.go:57-78),
 * and the 303-See-Other redirect default (services/context/base.go:157).
 * Documented divergences: upstream splits the roles across `gitea_session`
 * (server store) + `gitea_remember` (auth token); we collapse both into ONE
 * `gitea_session` cookie carrying the `id:secret` pair — Workers isolates
 * have no server-side memory, D1 is the store playing the `auth_token` table
 * role verbatim (§2.3) — and our web login lives at `/login` (upstream:
 * `/user/login`, §2.1).
 *
 * ## §2.9 boundary
 *
 * Sessions never authorize `/api/v1` or git-HTTP: `resolveAuth`
 * (src/auth/middleware.ts) and the git gate (src/git-http/acl.ts) read only
 * `Authorization` headers and stay byte-identical. Nothing here touches
 * them; a request carrying only the cookie is anonymous on both surfaces.
 */

import { Hono, type Context } from "hono";
import { and, eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { D1FailureLimiter } from "../auth/failure-limiter";
import { sha256Hex, timingSafeDigestEqual } from "../auth/digest";
import {
  limiterCheckFailOpen,
  limiterRecordFailureFailOpen,
  limiterResetFailOpen,
} from "../auth/middleware";
import { ScopeSet } from "../auth/scopes";
import { TokenService } from "../auth/token-service";
import { sessions, users } from "../db/schema";
import { assetsBinding, assetsNotBuilt } from "./index";
import { locale } from "./locale";
import { AssetBuildError, loadManifest } from "./manifest";
import { renderLoginPage } from "./pages/login";
import { shellAssetsFromManifest, type UiContext } from "./ui-context";

// ---------------------------------------------------------------------------
// Constants (§2.3 — upstream defaults, resolved per open question 2)
// ---------------------------------------------------------------------------

/** The cookie name — upstream `COOKIE_NAME` default
 *  (modules/setting/session.go:36,61). */
export const SESSION_COOKIE_NAME = "gitea_session";

/** Row TTL at mint, extended by exactly this on every rotation (§2.3):
 *  an actively used session keeps living, an idle one dies after 24 h
 *  regardless of the cookie's persistence (upstream store `Maxlifetime`
 *  default 86400). */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Rotation trigger (§2.4 step 5): a secret older than this is rotated on
 *  the next valid presentation. */
export const ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The stale-cookie grace (§2.4 step 3): a cookie carrying the PREVIOUS
 *  secret authenticates nothing but survives this long after a rotation —
 *  upstream's own "must not authenticate" comment
 *  (services/auth/auth_token.go:55-57). */
export const STALE_GRACE_MS = 60 * 1000;

/** `last_seen_at` write throttle (§3): at most once per hour per session —
 *  web-session liveness is day-relevant audit data at bounded cost (≤ 24
 *  writes per session per day), tighter than the PAT `last_used_at` 24 h
 *  throttle (SPEC-0002 §2.7). */
export const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;

/** Cookie `Max-Age` with `remember`: 31 days (upstream `LOGIN_REMEMBER_DAYS`
 *  default, setting/security.go:146). Without `remember` the cookie is a
 *  session cookie — no `Max-Age`, dies with the browser. */
export const REMEMBER_MAX_AGE_SECONDS = 31 * 24 * 60 * 60;

/** Public row id length — upstream `util.CryptoRandomString(10)`
 *  (services/auth/auth_token.go:100). Not secret. */
const SESSION_ID_LENGTH = 10;

/** Secret entropy: 32 crypto-random bytes, hex — byte-for-byte upstream's
 *  `generateTokenAndHash` (auth_token.go:113-121). */
const SECRET_BYTES = 32;

// ---------------------------------------------------------------------------
// Random ids + secrets (crypto only — AGENTS.md Workers rules)
// ---------------------------------------------------------------------------

/** Upstream `CryptoRandomString`'s alphabet (modules/util/util.go:74-77). */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Rejection sampling over whole bytes keeps the alphabet uniform the way
 *  upstream's `rand.Int` is (256 % 62 != 0, so raw modulo would bias). */
function cryptoRandomId(length: number): string {
  let out = "";
  while (out.length < length) {
    const buf = crypto.getRandomValues(new Uint8Array((length - out.length) * 2));
    for (const byte of buf) {
      if (byte >= 248) continue; // 248 = 4 × 62: uniform remapped range
      out += ID_ALPHABET[byte % ID_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += (byte >> 4).toString(16);
    out += (byte & 0x0f).toString(16);
  }
  return out;
}

/** A fresh 256-bit secret, hex (never stored in the clear — §3). */
function generateSessionSecret(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

// ---------------------------------------------------------------------------
// Cookie surface (§2.3)
// ---------------------------------------------------------------------------

/**
 * The `gitea_session` Set-Cookie directive. Flags are not negotiable at
 * runtime (§4.9): HttpOnly always (SetSiteCookie hardcodes it,
 * cookie.go:57-78), Secure always (our origins are https), SameSite=Lax
 * (session.go:39 default — §2.8 layer 1), Path=/ (CookiePath default).
 * `remember` toggles ONLY cookie persistence: `Max-Age=2678400` vs a
 * session cookie (§2.3). The value is the `id:secret` pair; like upstream
 * it is unsigned — its security rests on 256 bits of entropy plus the
 * sha256-at-rest compare.
 */
export function sessionSetCookie(value: string, remember: boolean): string {
  const parts = [`${SESSION_COOKIE_NAME}=${value}`, "Path=/"];
  if (remember) parts.push(`Max-Age=${String(REMEMBER_MAX_AGE_SECONDS)}`);
  parts.push("HttpOnly", "Secure", "SameSite=Lax");
  return parts.join("; ");
}

/** The clear directive — `Max-Age=0`, same flags (§2.7). */
export function clearSessionSetCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Read `gitea_session` from the request's Cookie header (first match
 *  wins). `null` when the header or the cookie is absent/empty — a request
 *  without the cookie is anonymous with ZERO D1 session reads (§2.4). */
export function sessionCookieValue(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (header === null) return null;
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    if (pair.slice(0, at).trim() === SESSION_COOKIE_NAME) {
      const value = pair.slice(at + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

/** The `id:secret` halves of a cookie value, or `null` when malformed
 *  (missing colon, empty halves — upstream's ErrAuthTokenInvalidFormat,
 *  auth_token.go:40-43). */
function parseCookieValue(value: string): { id: string; secret: string } | null {
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1) return null;
  return { id: value.slice(0, colon), secret: value.slice(colon + 1) };
}

// ---------------------------------------------------------------------------
// Session service (§2.4 + §3 — D1 through Drizzle only)
// ---------------------------------------------------------------------------

/** The session's principal, as the viewer seam (§2.5) consumes it. */
export interface SessionUser {
  readonly id: number;
  readonly username: string;
  readonly isAdmin: boolean;
}

export type SessionVerification =
  | {
      outcome: "anonymous";
      /** The response must clear the cookie (§2.4 steps 1-4). The stale
       *  in-grace branch is the exception: no Set-Cookie of any kind —
       *  writing a fresh value would race the rotation still in flight
       *  (§2.4 step 3). */
      clearCookie: boolean;
      /** Background work the caller must settle (the expired-row lazy GC,
       *  §2.4 step 2 — `waitUntil` where a context exists). */
      background: Promise<unknown>[];
    }
  | {
      outcome: "authenticated";
      user: SessionUser;
      /** The rotation's fresh `id:secret` for the response, or `null` (not
       *  due, or a concurrent request rotated first — changes == 0, §2.4
       *  step 5: send nothing, the old cookie stays valid for this
       *  response). */
      setCookie: string | null;
      /** Background work: the throttled `last_seen_at` touch when due (§3). */
      background: Promise<unknown>[];
    };

/**
 * Verify a presented `gitea_session` value — the port of upstream
 * `CheckAuthToken` (services/auth/auth_token.go:33-69): format + lookup
 * (one D1 read, `sessions ⋈ users` on the primary key), expiry, digest
 * compare with reuse detection, doer status, then rotation. Never throws
 * for auth outcomes; a D1 failure propagates to the caller's fail-closed
 * 500 (§4.8 — a transient error must not masquerade as a logout).
 */
export async function verifySession(
  d1: D1Database,
  value: string,
  options?: { now?: Date },
): Promise<SessionVerification> {
  const now = options?.now ?? new Date();

  const parsed = parseCookieValue(value);
  if (parsed === null) return { outcome: "anonymous", clearCookie: true, background: [] };

  const db = drizzle(d1);
  // Step 1: lookup by id (primary key — one row read).
  const row = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, parsed.id))
    .get();
  if (row === undefined) return { outcome: "anonymous", clearCookie: true, background: [] };

  // Step 2: hard expiry → anonymous, row deleted lazily, cookie cleared (§3 GC).
  if (row.session.expiresAt.getTime() <= now.getTime()) {
    const background = db.delete(sessions).where(eq(sessions.id, parsed.id)).run();
    return { outcome: "anonymous", clearCookie: true, background: [background] };
  }

  // Step 3: digest compare; mismatch is the reuse-detection branch,
  // upstream-verbatim (auth_token.go:55-65).
  const digest = await sha256Hex(parsed.secret);
  if (!(await timingSafeDigestEqual(row.session.sha256Digest, digest))) {
    // Recently rotated, cookie in flight: it must not authenticate, but the
    // row survives and NOTHING is written back to the cookie.
    const withinGrace = row.session.rotatedAt.getTime() + STALE_GRACE_MS > now.getTime();
    const previous = row.session.previousSha256Digest;
    if (withinGrace && previous !== null && (await timingSafeDigestEqual(previous, digest))) {
      return { outcome: "anonymous", clearCookie: false, background: [] };
    }
    // Any other mismatch is stolen-and-rotated or forged: delete the row,
    // locking out the attacker's rotated copy and the victim alike
    // (upstream's compromise response). Synchronous — the lockout must be
    // durable before the response goes out.
    await db.delete(sessions).where(eq(sessions.id, parsed.id)).run();
    return { outcome: "anonymous", clearCookie: true, background: [] };
  }

  // Step 4: the joined doer must be an active individual user — upstream's
  // Session.Verify rejects non-individual doers
  // (services/auth/session.go:53-57) and prohibited accounts never hold
  // authority (§2.2 step 4).
  if (row.user.status !== "active" || row.user.type !== "user") {
    return { outcome: "anonymous", clearCookie: true, background: [] };
  }

  // Step 5: rotation — when the secret is ≥ 24 h old, mint a fresh one and
  // conditionally update (upstream's UpdateAuthTokenByID(…, oldHash) guard,
  // auth_token.go:71-92). `changes == 0` (a concurrent request rotated
  // first) → skip, send nothing; the 60 s grace covers any true in-flight
  // window (§4.4).
  let setCookie: string | null = null;
  if (now.getTime() - row.session.rotatedAt.getTime() >= ROTATION_INTERVAL_MS) {
    setCookie = await rotateSession(d1, parsed.id, row.session.sha256Digest, { now });
  }

  // Throttled `last_seen_at` touch (§3) — background work for the caller.
  const background: Promise<unknown>[] = [];
  if (now.getTime() - row.session.lastSeenAt.getTime() >= LAST_SEEN_THROTTLE_MS) {
    background.push(db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, parsed.id)).run());
  }

  return {
    outcome: "authenticated",
    user: { id: row.user.id, username: row.user.username, isAdmin: row.user.isAdmin },
    setCookie,
    background,
  };
}

/**
 * The rotation step, isolated so the CAS guard is directly assertable
 * (§2.4 step 5): mints a fresh secret and conditionally updates
 * `sha256_digest` → new, `previous_sha256_digest` → old, `rotated_at` →
 * now, `expires_at` → now + 24 h — WHERE the stored digest is still the one
 * the caller verified (upstream `UpdateAuthTokenByID(…, oldHash)`). Returns
 * the fresh `id:secret` cookie value, or `null` when the CAS lost
 * (`changes == 0` — a concurrent request rotated first: send nothing, the
 * 60 s grace covers the in-flight window, §4.4).
 */
export async function rotateSession(
  d1: D1Database,
  id: string,
  verifiedDigest: string,
  options?: { now?: Date },
): Promise<string | null> {
  const now = options?.now ?? new Date();
  const secret = generateSessionSecret();
  const updated = await drizzle(d1)
    .update(sessions)
    .set({
      sha256Digest: await sha256Hex(secret),
      previousSha256Digest: verifiedDigest,
      rotatedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    })
    .where(and(eq(sessions.id, id), eq(sessions.sha256Digest, verifiedDigest)))
    .run();
  return (updated.meta.changes ?? 0) > 0 ? `${id}:${secret}` : null;
}

/**
 * Mint a session row for `userId` and return the cookie value
 * (`id:secret`, §2.2 step 5). The row starts unrotated
 * (`previous_sha256_digest` NULL, `rotated_at` = now) with the 24 h TTL.
 */
export async function mintSession(d1: D1Database, userId: number, options?: { now?: Date }): Promise<string> {
  const now = options?.now ?? new Date();
  const id = cryptoRandomId(SESSION_ID_LENGTH);
  const secret = generateSessionSecret();
  await drizzle(d1)
    .insert(sessions)
    .values({
      id,
      userId,
      sha256Digest: await sha256Hex(secret),
      previousSha256Digest: null,
      rotatedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      lastSeenAt: now,
    })
    .run();
  return `${id}:${secret}`;
}

/**
 * The §2.4 authority decision for LOGOUT — read-only, no side effects. A
 * forged logout must not become a lockout lever: reuse-detection deletion
 * is the PAGE verification's job (§2.4 step 3 owns mismatch deletion), and
 * §2.7/§5 pin that a forged-cookie logout leaves rows untouched. So this
 * lookup decides "valid session" (current digest matches, active individual
 * doer) without deleting, rotating, or touching `last_seen_at`; a stale
 * in-grace previous cookie is anonymous exactly like §2.4 ("must not
 * authenticate"). Returns the doer slice, or `null` for every
 * not-authenticated outcome.
 */
export async function lookupValidSession(
  d1: D1Database,
  value: string,
  options?: { now?: Date },
): Promise<SessionUser | null> {
  const now = options?.now ?? new Date();
  const parsed = parseCookieValue(value);
  if (parsed === null) return null;
  const row = await drizzle(d1)
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, parsed.id))
    .get();
  if (row === undefined) return null;
  if (row.session.expiresAt.getTime() <= now.getTime()) return null;
  const digest = await sha256Hex(parsed.secret);
  if (!(await timingSafeDigestEqual(row.session.sha256Digest, digest))) return null;
  if (row.user.status !== "active" || row.user.type !== "user") return null;
  return { id: row.user.id, username: row.user.username, isAdmin: row.user.isAdmin };
}

/**
 * Logout's delete (§2.7): the row is removed by id AND matching digest —
 * an id-only delete would let anyone who learns a victim's `id` force
 * logouts. `false` = no row matched (nothing touched; reuse detection owns
 * mismatch deletion, §2.4 step 3).
 */
export async function deleteSessionBySecret(d1: D1Database, value: string): Promise<boolean> {
  const parsed = parseCookieValue(value);
  if (parsed === null) return false;
  const digest = await sha256Hex(parsed.secret);
  const result = await drizzle(d1)
    .delete(sessions)
    .where(and(eq(sessions.id, parsed.id), eq(sessions.sha256Digest, digest)))
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** The POST /login GC sweep (§2.4 step 2, §3): expired rows die here in
 *  `waitUntil` — upstream runs DeleteExpiredAuthTokens on its sign-in paths
 *  (routers/web/auth/auth.go:86,382). No cron exists (§3). */
export async function sweepExpiredSessions(d1: D1Database, now?: Date): Promise<void> {
  await drizzle(d1).delete(sessions).where(lt(sessions.expiresAt, now ?? new Date())).run();
}

// ---------------------------------------------------------------------------
// CSRF layer 2 (§2.8): the server-side Origin check every non-GET UI route
// carries — our write surface is API-less and hand-written, so the check
// ships with the route, not as a retrofit.
// ---------------------------------------------------------------------------

/** Plain 403 for a cross-origin write (the gate's plain-text error shape). */
function crossOriginRejected(): Response {
  return new Response("cross-origin request rejected\n", {
    status: 403,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/**
 * Verify the `Origin` header (falling back to `Referer`) against the request
 * origin; a MISMATCH is rejected with 403 plain text (§2.8 layer 2). Absent
 * headers are not evidence of a cross-origin request — modern browsers send
 * Origin on every POST, SameSite=Lax (§2.3 layer 1) already keeps the cookie
 * off cross-site navigations, and non-browser clients are not CSRF agents.
 */
export function sameOriginGuard(req: Request): Response | null {
  const origin = new URL(req.url).origin;
  const originHeader = req.headers.get("origin");
  if (originHeader !== null) {
    return originHeader === origin ? null : crossOriginRejected();
  }
  const referer = req.headers.get("referer");
  if (referer !== null) {
    try {
      return new URL(referer).origin === origin ? null : crossOriginRejected();
    } catch {
      return crossOriginRejected();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route handlers (§2.1/§2.2/§2.7)
// ---------------------------------------------------------------------------

type RouteContext = Context<{ Bindings: Env }>;

/** IP extraction follows the gate's convention (acl.ts:155-158). */
function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * `ctx.waitUntil` where an execution context exists (production always has
 * one); `router.fetch`-style invocations without one (tests) settle the
 * promise detached rather than blocking the response — callers that need to
 * observe the work pass a capturing execution context explicitly.
 */
function backgroundSink(c: RouteContext): (promise: Promise<unknown>) => void {
  try {
    const ctx = c.executionCtx;
    return (promise) => {
      ctx.waitUntil(promise);
    };
  } catch {
    return (promise) => void promise.catch(() => {});
  }
}

/** 303 See Other — upstream's redirect default (base.go:157). */
function seeOther(location: string, setCookie?: string): Response {
  const headers: Record<string, string> = { location };
  if (setCookie !== undefined) headers["set-cookie"] = setCookie;
  return new Response(null, { status: 303, headers });
}

/** 429 + Retry-After in the gate's plain-text shape (`respond.ts
 *  rateLimited`) — SPEC-0010 §2.2 pins the machine-readable status for the
 *  web surface (the gate's git-HTTP shape answers 403; here an active block
 *  makes the form pointless and a 200 page would hide the block). */
function loginRateLimited(retryAfterSeconds: number): Response {
  return new Response("too many authentication failures, retry later\n", {
    status: 429,
    headers: {
      "content-type": "text/plain;charset=utf-8",
      "x-content-type-options": "nosniff",
      "retry-after": String(Math.max(1, retryAfterSeconds)),
    },
  });
}

/**
 * `?redirect_to=` is honored ONLY when path-absolute and same-origin
 * (`/^\/[^/]/` — no `//`, no scheme, §2.2 step 6); everything else
 * redirects to `/`. Control characters are refused outright (defence in
 * depth behind the header API, which already rejects CRLF).
 */
export function safeRedirectTarget(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "/";
  if (raw.length < 2 || !raw.startsWith("/") || raw[1] === "/") return "/";
  for (let i = 0; i < raw.length; i++) {
    if ((raw.charCodeAt(i) ?? 32) < 32) return "/";
  }
  return raw;
}

interface LoginForm {
  /** The PAT (`password` field; `token` accepted as an alias, §2.2). */
  password: string | null;
  /** Optional owner cross-check, case-insensitive (§2.2). */
  userName: string | null;
  remember: boolean;
  /** The form's hidden `redirect_to` (validated only at use time). */
  redirectTo: string | null;
}

const MAX_FORM_BYTES = 8192;

/** Parse the `application/x-www-form-urlencoded` login body (§2.2). A
 *  missing/oversized/malformed body parses as absent fields — the failure
 *  renders and counts against the limiter like any other. */
async function parseLoginForm(req: Request): Promise<LoginForm> {
  const contentType = req.headers.get("content-type") ?? "";
  const length = Number(req.headers.get("content-length") ?? "0");
  if (!contentType.startsWith("application/x-www-form-urlencoded") || length > MAX_FORM_BYTES) {
    return { password: null, userName: null, remember: false, redirectTo: null };
  }
  let params: URLSearchParams;
  try {
    // The content-length cap above bounds this read (a login form is
    // bytes-small; the limiter caps how often it happens).
    params = new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
  } catch {
    return { password: null, userName: null, remember: false, redirectTo: null };
  }
  return {
    password: params.get("password") ?? params.get("token"),
    userName: params.get("user_name"),
    remember: (params.get("remember") ?? "") !== "",
    redirectTo: params.get("redirect_to"),
  };
}

/** Assemble the page context the way `uiPage` does (§2.3.4: a missing
 *  manifest fails fast with the 503 before any page work happens). */
async function pageContext(
  c: RouteContext,
  viewer: UiContext["viewer"],
): Promise<{ ctx: UiContext } | { response: Response }> {
  const url = new URL(c.req.url);
  try {
    const manifest = await loadManifest(assetsBinding(c.env), url.origin);
    return { ctx: { viewer, origin: url.origin, assets: shellAssetsFromManifest(manifest) } };
  } catch (error) {
    if (error instanceof AssetBuildError) return { response: assetsNotBuilt(error) };
    throw error;
  }
}

/** GET /login — the form in the anonymous shell (§2.1: renders anonymous; a
 *  valid session redirects to `/`, carrying a rotation cookie if one was
 *  minted during the check). The §2.4 directives travel on every outcome:
 *  a dead cookie is cleared here too. */
async function loginPage(c: RouteContext): Promise<Response> {
  const sink = backgroundSink(c);
  let setCookie: string | null = null;
  const value = sessionCookieValue(c.req.raw);
  if (value !== null) {
    const verification = await verifySession(c.env.DB, value);
    for (const work of verification.background) sink(work);
    if (verification.outcome === "authenticated") {
      return seeOther("/", verification.setCookie ?? undefined);
    }
    if (verification.clearCookie) setCookie = clearSessionSetCookie();
  }
  const assembled = await pageContext(c, { kind: "anonymous" });
  if ("response" in assembled) return assembled.response;
  const redirectTo = new URL(c.req.url).searchParams.get("redirect_to");
  const html = renderLoginPage({ ctx: assembled.ctx, redirectTo, error: null });
  if (setCookie === null) return c.html(html, 200);
  return c.html(html, 200, { "set-cookie": setCookie });
}

/** The failure re-render (200 + inline error, §2.2) with one limiter
 *  failure recorded — `recorded` is awaited so the §5 tests can count it
 *  deterministically. */
async function renderLoginFailure(
  c: RouteContext,
  redirectTo: string | null,
  error: string,
  recorded: Promise<unknown>,
): Promise<Response> {
  const assembled = await pageContext(c, { kind: "anonymous" });
  if ("response" in assembled) {
    void recorded.catch(() => {});
    return assembled.response;
  }
  await recorded.catch(() => {});
  return c.html(renderLoginPage({ ctx: assembled.ctx, redirectTo, error }), 200);
}

/** POST /login (§2.2) — rate-limit first, verify the PAT, capability-gate
 *  the minting token, refuse prohibited accounts, mint + Set-Cookie, reset
 *  the limiter + GC sweep in waitUntil, then the validated redirect. Every
 *  failure re-renders the form at 200 with an inline error and counts one
 *  limiter failure (upstream web logins re-render with a flash message, not
 *  an HTTP error status — §2.2; the limiter is where the consequence lives,
 *  §4.11). */
async function loginSubmit(c: RouteContext): Promise<Response> {
  // §2.8 layer 2 — the login POST is a non-GET UI route.
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;

  const now = new Date();
  const ip = clientIp(c.req.raw);
  const limiter = new D1FailureLimiter(c.env.DB);
  const sink = backgroundSink(c);

  // Step 1: the shared per-IP budget across every auth surface (SPEC-0002
  // §2.7 window; deliberate — §2.2 step 1). Fails open (ef2c049): a broken
  // limiter must not turn the login POST into a 500 — the credential
  // verification below stays the real gate.
  const verdict = await limiterCheckFailOpen(limiter, ip, now);
  if (verdict.blocked) return loginRateLimited(verdict.retryAfterSeconds);

  const form = await parseLoginForm(c.req.raw);
  const invalid = (): Promise<Response> =>
    renderLoginFailure(
      c,
      form.redirectTo,
      locale.login_error_invalid_token,
      limiterRecordFailureFailOpen(limiter, ip, now),
    );

  // Step 2: verify the PAT unchanged (prefix lookup + sha256 + timing-safe
  // compare + expiry, src/auth/token-service.ts:165-188). Unknown,
  // malformed, and expired credentials are indistinguishable (§4.11).
  if (form.password === null || form.password === "") return invalid();
  const verified = await new TokenService(c.env.DB).verify(form.password, { now });
  if (verified === null) return invalid();
  // The optional `user_name` must match the token owner case-insensitively;
  // a mismatch is a login failure that reveals nothing (§2.2).
  if (form.userName !== null && form.userName.trim().toLowerCase() !== verified.user.usernameLower) {
    return invalid();
  }

  // Step 3: capability gate on the minting PAT — the session carries the
  // USER's web identity (scope-less, §2.2 step 3), so the PAT must itself
  // pass the gate's authenticated read path; a `no-token-scope` or
  // public-only PAT must not mint a session that reads more than the token
  // could (the gate masks limited-owner repos from public-only tokens,
  // acl.ts decide + SPEC-0002 §4.1).
  const scope = ScopeSet.parseLenient(verified.token.scopes);
  if (!scope.has("read:repository") || scope.publicOnly) {
    return renderLoginFailure(
      c,
      form.redirectTo,
      locale.login_error_scope,
      limiterRecordFailureFailOpen(limiter, ip, now),
    );
  }

  // Step 4: prohibited account → no session, no row, no cookie (upstream
  // refusing login for prohibit-login users, githttp.go:194-197 semantics).
  if (verified.user.status !== "active") {
    return renderLoginFailure(
      c,
      form.redirectTo,
      locale.login_error_prohibited,
      limiterRecordFailureFailOpen(limiter, ip, now),
    );
  }

  // Step 5: mint row + cookie in one response; limiter reset + expired-row
  // sweep in waitUntil (§2.2 step 5).
  const cookieValue = await mintSession(c.env.DB, verified.user.id, { now });
  sink(limiterResetFailOpen(limiter, ip));
  sink(sweepExpiredSessions(c.env.DB, now));

  // Step 6: the validated redirect (§2.2 step 6, §4.6).
  return seeOther(safeRedirectTarget(form.redirectTo), sessionSetCookie(cookieValue, form.remember));
}

/** POST /logout (§2.7) — POST-only (a GET logout is a link-preview/prefetch
 *  footgun; none is offered). Run §2.4 verification; on a VALID session
 *  delete the row by id AND matching digest; on anything else leave rows
 *  alone (reuse detection owns mismatch deletion). Either way the cookie is
 *  cleared (Max-Age=0, same flags) and the response redirects to `/` —
 *  idempotent: logging out without a session is a clean redirect. */
async function logout(c: RouteContext): Promise<Response> {
  // §2.8 layer 2 — logout is a non-GET UI route.
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;

  const value = sessionCookieValue(c.req.raw);
  if (value !== null) {
    // Read-only §2.4 decision (see lookupValidSession — a forged logout
    // must not delete rows); the (id, digest) delete covers only a valid
    // presentation.
    const valid = await lookupValidSession(c.env.DB, value);
    if (valid !== null) await deleteSessionBySecret(c.env.DB, value);
  }
  return seeOther("/", clearSessionSetCookie());
}

// ---------------------------------------------------------------------------
// The router (§2.1) — mounted by the dispatcher next to the uiRouter:
//   app.route("/", sessionRouter);
// ---------------------------------------------------------------------------

export const sessionRouter = new Hono<{ Bindings: Env }>();

sessionRouter.get("/login", (c) => loginPage(c));
sessionRouter.post("/login", (c) => loginSubmit(c));
sessionRouter.post("/logout", (c) => logout(c));

/**
 * Auth middleware — SPEC-0002 §2.5 (chain design) and §2.6 (behavior matrix).
 *
 * `resolveAuth` parses credentials (`token`/`Bearer`/Basic token forms),
 * resolves the doer, attaches `c.var.auth`, enforces the account-status
 * option check, and maps every failure to the exact upstream API error
 * shapes. The `require*` helpers and `sudo()` are the post-auth route
 * middlewares upstream chains after `apiAuth` (api.go §2.5 table).
 *
 * Error bodies are the upstream `APIError` JSON: `{"message", "url"}` where
 * `url` is the instance swagger URL (`AppURL + "api/swagger"`). The TWO
 * documented exceptions are bare `{"message"}` 403s — upstream's
 * `ctx.JSON(http.StatusForbidden, gin.H{"message": ...})` without the
 * APIError wrapper (api.go:135-138 sudo-non-admin, api.go:889-893
 * prohibited-account).
 */

import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../db/schema";
import { configuredPasswordHashAlgo, enableBasicAuthentication, type PasswordConfigEnv } from "../api/config";
import type { AuthEnv, AuthInfo, AuthToken, AuthUser } from "./auth-context";
import { basicAuthTokenCandidate, parseAuthorizationHeader } from "./httpauth";
import { D1FailureLimiter, type RateLimitHook, type RateLimitVerdict } from "./failure-limiter";
import { requiredScopeNames, type ScopeCategory, ScopeSet, type ScopeLevel, SCOPE_ALL } from "./scopes";
import { TokenService } from "./token-service";
import { authUserFromRow, userSignInPassword } from "./password-auth";
import { getTwoFactorByUid } from "./two-factor";
import { consumeTotpWithAttemptLimit, emitTwofaFailureAudit } from "./totp-attempts";
import { hasCredentialsForUser } from "../web/webauthn-store";
import { oauth2FeatureEnabled, resolveOAuth2AccessTokenCredential, type ResolvedOAuth2Credential } from "../services/oauth2/token";

/** Message used for every bad/expired/revoked credential (api.go:862–875). */
const INVALID_CREDENTIAL_MESSAGE = "invalid username, password or token";

/**
 * The OTP lock's wire body — basic.go:186's `ErrUserAuthMessage("too many
 * failed OTP attempts, try again later")` VERBATIM: api.go:884 renders an
 * ErrAsUserAuthMessage message through ctx.APIError(401, msg), so this is
 * the ONE OTP text that reaches the API wire (the per-account lock arm of
 * c54ec52f0f's ValidateAndConsumeTOTP limiter — the invalid-OTP text next
 * to it (:188) stays OFF the wire, api.go:884's fallback).
 */
const TOO_MANY_OTP_ATTEMPTS_MESSAGE = "too many failed OTP attempts, try again later";

/** Unpinned by SPEC-0002 §2.7 (only status + Retry-After are specified). */
const RATE_LIMITED_MESSAGE = "too many authentication failures, retry later";

/** Upstream `rejectPublicOnly` / `contextAuthenticatedUser` 403 body (api.go:251–256). */
export const PUBLIC_ONLY_FORBIDDEN_MESSAGE = "this endpoint is not available for public-only tokens";

/** Upstream `user_model.ErrUserRedirectNotExist.Error()` (redirect.go:27–29) —
 *  the masked 404 body `userAssignment` answers with (services/context/user.go:62). */
export function userRedirectDoesNotExist(username: string): string {
  return `user redirect does not exist [name: ${username}]`;
}

/** The must-change-password gate's target path — upstream
 *  `setting.AppSubURL+"/user/settings/change_password"` (api.go:887). The
 *  literal is local to this module (the auth layer must not import from
 *  ui/session.ts, which carries the WEB twin); both cite the same pin. */
const MUST_CHANGE_PASSWORD_PATH = "/user/settings/change_password";

/** The `users.must_change_password` read for the api.go:886-893 arm — one
 *  PK probe per credentialed request (the comment at the arm). */
async function doerMustChangePassword(db: D1Database, userId: number): Promise<boolean> {
  const row = await drizzle(db)
    .select({ mustChangePassword: users.mustChangePassword })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row?.mustChangePassword === true;
}

/** The arm's exact wire answer — api.go:888-891's literal bare `{message}`
 *  403. One builder so both mount paths (the token post-auth block and the
 *  Basic-password ok branch) cannot drift. */
function mustChangePasswordResponse(c: Context<AuthEnv>): Response {
  return c.json(
    {
      message: `You must change your password. Change it at: ${new URL(c.req.url).origin}${MUST_CHANGE_PASSWORD_PATH}`,
    },
    403,
  );
}

/** The `users.visibility` enum (SPEC-0003 §2.5.6 / upstream VisibleType). */
export type UserVisibility = "public" | "limited" | "private";

export interface ResolveAuthOptions {
  /** Override the failure-limit backend (defaults to the D1 limiter). */
  failureLimiter?: (env: Env) => RateLimitHook;
}

/**
 * The OAuth2 vars the Bearer-dots dispatch reads — the widened alias (the
 * FederationEnv posture: Omit + optional members) so the dispatch works
 * before AND after W4's wrangler plumbing types the vars.
 */
type OAuth2DispatchEnv = Omit<Env, "OAUTH2_ENABLED" | "OAUTH2_SIGNING_ALGORITHM"> & {
  /** Strict polarity: ONLY the exact string "false" disables. */
  OAUTH2_ENABLED?: string;
  /** Default RS256 (modules/setting/oauth2.go:108). */
  OAUTH2_SIGNING_ALGORITHM?: string;
};

// --- API error helpers ------------------------------------------------------

/** Instance swagger URL — upstream `setting.API.SwaggerURL = AppURL + "api/swagger"`. */
export function swaggerUrl(c: Context<AuthEnv>): string {
  return new URL(c.req.url).origin + "/api/swagger";
}

/** Upstream `APIError` JSON shape (`gitea/services/context/api.go:64–67`). */
export function apiErrorResponse(c: Context<AuthEnv>, status: ContentfulStatusCode, message: string): Response {
  return c.json({ message, url: swaggerUrl(c) }, status);
}

/** Upstream `APIErrorNotFound` (api.go:922–927): existence is not disclosed. */
export function apiErrorNotFound(c: Context<AuthEnv>): Response {
  return apiErrorResponse(c, 404, "not found");
}

// --- Failure-limiter fail-open (production finding ef2c049) ------------------
//
// The failure limiter is brute-force protection, not an authz gate: its D1
// backend throws intermittently under concurrency, and the unguarded calls
// turned that into a 500 — a rate limiter 500-ing the very request it
// guards. Every credential-path limiter call site (resolveAuth, git-HTTP
// ACL, LFS auth, UI login) routes through these never-throwing wrappers: a
// backend failure logs one line and the request proceeds. Credential
// VERIFICATION stays deliberately fail-closed (SPEC-0002 §4.5); only the
// limiter's availability is relaxed.

/** Never-throwing `limiter.check` — an unblocked verdict on backend failure. */
export async function limiterCheckFailOpen(
  limiter: RateLimitHook,
  ip: string,
  now: Date,
): Promise<RateLimitVerdict> {
  try {
    return await limiter.check(ip, now);
  } catch (err) {
    console.error(`failure-limiter: check failed for ip=${ip}; failing open`, err);
    return { blocked: false, retryAfterSeconds: 0 };
  }
}

/** Never-throwing `limiter.recordFailure` — the count update is dropped. */
export function limiterRecordFailureFailOpen(limiter: RateLimitHook, ip: string, now: Date): Promise<void> {
  return limiter.recordFailure(ip, now).catch((err: unknown) => {
    console.error(`failure-limiter: recordFailure failed for ip=${ip}; dropping the count`, err);
  });
}

/** Never-throwing `limiter.reset` — a stale counter survives until its window expires. */
export function limiterResetFailOpen(limiter: RateLimitHook, ip: string): Promise<void> {
  return limiter.reset(ip).catch((err: unknown) => {
    console.error(`failure-limiter: reset failed for ip=${ip}; ignoring`, err);
  });
}

// --- resolveAuth ------------------------------------------------------------

/**
 * The auth middleware. Behavior matrix (SPEC-0002 §2.6):
 * - no credentials            → anonymous doer, request proceeds
 * - invalid/expired/revoked   → 401 `{"message":"invalid username, password or token"}`
 * - valid token               → doer + scope attached to `c.var.auth`
 * - blocked IP with creds     → 429 + `Retry-After` (failure limiter)
 * - prohibited account        → 403 upstream prohibited message
 */
export function resolveAuth(options: ResolveAuthOptions = {}): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const now = new Date();
    const service = new TokenService(c.env.DB);
    const limiter = options.failureLimiter ? options.failureLimiter(c.env) : new D1FailureLimiter(c.env.DB);
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";

    const header = c.req.header("Authorization");
    const parsed = header === undefined ? null : parseAuthorizationHeader(header);
    const bearerCredential = parsed?.bearerToken?.token ?? null;
    const credential = bearerCredential ?? (parsed?.basicAuth ? basicAuthTokenCandidate(parsed.basicAuth) : null);

    if (parsed === null || credential === null) {
      // Malformed Authorization parses as *no credentials* → anonymous doer
      // (SPEC-0002 §4.1); routes decide anon-allowance.
      c.set("auth", { user: null, token: null, scope: null, isBasicAuth: false });
      await next();
      return;
    }

    // Failure limiting guards the credential-testing path only: anonymous
    // requests carry nothing to brute-force. Fails open (ef2c049): a broken
    // limiter must not 500 the request it guards.
    const verdict = await limiterCheckFailOpen(limiter, ip, now);
    if (verdict.blocked) {
      return c.json({ message: RATE_LIMITED_MESSAGE, url: swaggerUrl(c) }, 429, {
        "Retry-After": String(verdict.retryAfterSeconds),
      });
    }

    // THE OAUTH2 DISPATCH (SPEC specs/oauth2-provider.md §2.7): a DOTTED
    // credential is OAuth2-grant shape on BOTH carriers — the Bearer header
    // (services/auth/oauth2.go:110-128, the token extraction takes
    // Bearer/query) AND the HTTP Basic pair (basic.go:59-81's
    // VerifyAuthToken runs GetOAuthAccessTokenScopeAndUserID FIRST on the
    // Basic-carried token — BOTH the username-as-token and the
    // password-as-token shapes of parseAuthBasic, basic.go:44-59 — before
    // falling back to the PAT lookup). This is the shape git-credential-
    // oauth / GCM store: the JWT as the Basic password. verifyJws pins the
    // instance alg, assertApiTimeBounds applies the strict exp/iat bounds,
    // and the grant lookup resolves the doer + the access scope — feeding
    // the landed apiScopeGate UNCHANGED (§2.7: the token resolves to
    // (doer, scope) before the gate reads it, exactly like a PAT).
    // isBasicAuth stays `parsed.basicAuth !== null` — a Basic-carried grant
    // remains basic auth for the reqBasicAuth routes, exactly upstream's
    // Basic method answering. Upstream's actions-JWT arm of the dotted
    // dispatch is not ported (no Actions-user API identity; the recorded
    // divergence note in resolveOAuth2AccessTokenCredential's header).
    const oauth2Env: OAuth2DispatchEnv = c.env;
    const oauth2Resolved =
      credential.includes(".")
        ? await resolveOAuth2AccessTokenCredential(c.env.DB, credential, {
            enabled: oauth2FeatureEnabled(oauth2Env),
            configuredAlgorithm: oauth2Env.OAUTH2_SIGNING_ALGORITHM,
            now,
          })
        : null;
    const verified: { token: AuthToken; user: AuthUser } | null =
      oauth2Resolved !== null ? oauth2CredentialAuth(oauth2Resolved) : await service.verify(credential, { now });
    if (verified === null) {
      // THE BASIC PASSWORD ARM (SPEC-0002 §6.2 API-Basic row; upstream
      // services/auth/basic.go:135-146): the token arms missed, the
      // credential arrived via HTTP Basic, and EnableBasicAuth holds
      // (census B-87: the ENABLE_BASIC_AUTHENTICATION var, default TRUE —
      // service.go:179 MustBool(true)) → the full password sign-in with the
      // raw (username, password) pair. The arm fails CLOSED into the same
      // generic 401 (basic.go:142-146 → api.go:862-869's "invalid username,
      // password or token") except the WebAuthn hard-reject, whose message
      // IS the wire body (ErrUserAuthMessage → api.go:866-868).
      if (parsed?.basicAuth !== undefined && parsed?.basicAuth !== null) {
        // THE KNOB (basic.go:139-141): with EnableBasicAuth OFF the password
        // method is NOT APPLICABLE — `return nil, nil`, the request proceeds
        // ANONYMOUS exactly like no credentials at all (the endpoint's own
        // auth requirement answers; public routes serve). NEVER the generic
        // 401 here: upstream never tests the pair, so the failure limiter is
        // not touched either. Basic-carried TOKENS verified above and stay
        // unaffected (the gate sits AFTER the VerifyAuthToken arm).
        const basicAuthEnv: PasswordConfigEnv = c.env;
        if (!enableBasicAuthentication(basicAuthEnv)) {
          c.set("auth", { user: null, token: null, scope: null, isBasicAuth: false });
          await next();
          return;
        }
        // Census B-87: the sign-in ladder reads the deploy config exactly
        // like upstream (authenticate.go's UserSignIn runs under the loaded
        // settings) — the configured PASSWORD_HASH_ALGO drives the
        // rehash-on-login's comparison AND rewrite target; unset stays the
        // landed pbkdf2 default.
        const outcome = await basicPasswordArm(
          c.env.DB,
          parsed.basicAuth,
          c.req.header("X-Gitea-OTP") ?? "",
          now,
          { configuredHashSpec: configuredPasswordHashAlgo(basicAuthEnv).specification },
        );
        if (outcome.kind === "webauthn-enrolled") {
          // Upstream logs nothing extra here; the message is ErrUserAuthMessage's.
          await limiterRecordFailureFailOpen(limiter, ip, now);
          return apiErrorResponse(c, 401, "basic authorization is not allowed while WebAuthn enrolled");
        }
        if (outcome.kind === "ok") {
          // THE MUST-CHANGE ARM rides the Basic path too (api.go:886-893's
          // verify runs for EVERY authenticated request — Basic doers
          // included; the post-auth block below covers only the token-arm
          // flow). The arm holds the FULL users row, so no extra read.
          if (outcome.user.mustChangePassword) return mustChangePasswordResponse(c);
          const auth: AuthInfo = {
            user: authUserFromRow(outcome.user),
            // A password-Basic doer holds NO token row (upstream
            // GetDoerTokenScope misses the ExtDoerData arm and
            // GetAccessScope answers AccessTokenScopeAll via the
            // LoginMethod check, basic.go:189-197) — the synthetic row
            // carries `all` so the scope gate renders it identically.
            token: {
              id: -1,
              userId: outcome.user.id,
              name: "basic-password",
              prefix: "",
              scopes: SCOPE_ALL,
              expiresAt: null,
              lastUsedAt: null,
              createdAt: now,
            },
            scope: ScopeSet.parseLenient(SCOPE_ALL),
            isBasicAuth: true,
          };
          c.set("auth", auth);
          // No last_used touch (the PAT path only, as below) + the limiter
          // reset (the house semantics on every verified-credential arm).
          await runBackground(c, limiterResetFailOpen(limiter, ip));
          await next();
          return;
        }
        // The generic failure class (password wrong/unset, user unknown,
        // unsupported-hash — the controlled cause logged, SPEC §6.3-3).
        if (outcome.kind === "unsupported-hash") {
          console.error(`basic-auth: ${outcome.message}`);
        }
        if (outcome.kind === "totp-fail" || outcome.kind === "totp-locked") {
          // basic.go:182's audit row rides the failure 401 for EVERY
          // non-valid result — upstream's RecordAs sits BEFORE the
          // TooManyAttempts split (basic.go:182-188), so the locked arm
          // records too. The "invalid provided OTP" text stays OFF the
          // wire (api.go:884's generic fallback swallows every
          // non-ErrUserAuthMessage error). The row's address is the
          // auditClientIp derivation, NOT the limiter's `ip` above: that
          // value is the RATE-LIMIT bucket key, whose "unknown" sentinel is
          // a legitimate identity for an unaddressable client — but an
          // audit row's ipAddress is a client ADDRESS or null (the
          // AuditEventInput contract; upstream's RemoteHost is always the
          // socket peer), so an absent header records null here, never the
          // sentinel string. Same header, distinct semantics, derivations
          // kept separate on purpose. (The emitter — the shared
          // totp-attempts.ts family shape — is itself best-effort.)
          void emitTwofaFailureAudit(c.env.DB, { id: outcome.userId, username: outcome.username }, c.req.raw, "api");
        }
        if (outcome.kind === "totp-locked") {
          // basic.go:186's ErrUserAuthMessage IS the wire body (api.go:884
          // renders ErrAsUserAuthMessage verbatim through ctx.APIError) —
          // the ONE OTP text that surfaces on the API. The IP limiter still
          // records the attempt: a locked account's try remains a failed
          // credential on the wire (the 401 must not depend on the limiter
          // backend's health).
          await limiterRecordFailureFailOpen(limiter, ip, now);
          return apiErrorResponse(c, 401, TOO_MANY_OTP_ATTEMPTS_MESSAGE);
        }
      }
      // The 401 must not depend on the limiter backend's health.
      await limiterRecordFailureFailOpen(limiter, ip, now);
      return apiErrorResponse(c, 401, INVALID_CREDENTIAL_MESSAGE);
    }

    const auth: AuthInfo = {
      user: verified.user,
      token: verified.token,
      // Stored scopes are pre-normalized; parseLenient fails closed on any
      // corrupted value.
      scope: ScopeSet.parseLenient(verified.token.scopes),
      isBasicAuth: parsed.basicAuth !== null,
    };

    // Post-auth option checks — upstream `verifyAuthWithOptionsAPI`
    // (api.go:877–894); no activation case exists yet, so the
    // prohibited-account gate and the must-change-password gate apply. Both
    // bodies are upstream's BARE `{message}` JSON (api.go:889–893's literal
    // ctx.JSON — no APIError `url` field). The placement is upstream's own:
    // verifyAuthWithOptionsAPI is mounted `m.AfterRouting` straight after
    // `apiAuth(buildAuthGroup())` (api.go:958-961) — the post-auth path,
    // ahead of every route handler and scope gate.
    if (verified.user.status === "prohibited") {
      return c.json(
        { message: "This account is prohibited from signing in, please contact your site administrator." },
        403,
      );
    }
    // api.go:886-893's NeedChangePassword branch: `You must change your
    // password. Change it at: ` + `httplib.MakeAbsoluteURL(ctx,
    // setting.AppSubURL+"/user/settings/change_password")` — the request's
    // absolute origin (the same request-origin posture swaggerUrl carries,
    // recorded divergence from the configured AppURL). Upstream derives the
    // need via `CheckSignedInUser` (routers/common/auth.go:71) whose
    // impersonation carve-out is API-inapplicable (no sessions here) and
    // whose bot carve-out cannot trip (the users.type enum has no bot
    // value) — a plain flag check on the doer's row is the whole
    // derivation. The PK read is this arm's cost: AuthUser (auth-context.ts,
    // outside this unit's ownership) does not project the column, so the
    // uniform read covers the PAT and OAuth2-grant carriers on the one code
    // path (the Basic-password carrier checks its full row at its own
    // branch, above).
    if (await doerMustChangePassword(c.env.DB, verified.user.id)) {
      return mustChangePasswordResponse(c);
    }

    c.set("auth", auth);

    // Throttled `last_used_at` (24 h) and failure-counter reset run in the
    // background (SPEC-0002 §2.7). The PAT touch is the PAT path ONLY — an
    // OAuth2 grant credential must not write personal_access_tokens rows
    // (upstream's UpdateAccessToken sits in the dotless arm,
    // services/auth/oauth2.go:141-144).
    if (oauth2Resolved === null) {
      await runBackground(c, service.needsLastUsedTouch(verified.token, now)
        ? service.touchLastUsed(verified.token.id, now)
        : Promise.resolve());
    }
    await runBackground(c, limiterResetFailOpen(limiter, ip));

    await next();
  };
}

/**
 * The OAuth2 grant credential as an AuthInfo carrier: the grant IS the
 * token-row analogue (id = grant id, scopes = GrantAdditionalScopes), so
 * the scope-gate 403 body renders `token scope=<grant scope>` exactly like
 * upstream's ExtDoerData-backed GetDoerTokenScope (user_extdata.go) —
 * `all` for OIDC-only grants, the normalized access words otherwise.
 */
function oauth2CredentialAuth(resolved: ResolvedOAuth2Credential): { token: AuthToken; user: AuthUser } {
  return {
    token: {
      id: resolved.grantId,
      userId: resolved.grant.userId,
      name: "oauth2-grant",
      prefix: "",
      scopes: resolved.scope,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: resolved.grant.createdAt,
    },
    user: {
      id: resolved.user.id,
      username: resolved.user.username,
      usernameLower: resolved.user.usernameLower,
      email: resolved.user.email,
      displayName: resolved.user.displayName,
      location: resolved.user.location,
      website: resolved.user.website,
      description: resolved.user.description,
      isAdmin: resolved.user.isAdmin,
      status: resolved.user.status,
      createdAt: resolved.user.createdAt,
      type: resolved.user.type,
      visibility: resolved.user.visibility,
      numStars: resolved.user.numStars,
      lastLoginAt: resolved.user.lastLoginAt,
    },
  };
}

/** Attach background work to `ctx.waitUntil` (AGENTS.md). Outside the
 *  Workers fetch pipeline (direct-invocation tests) there is no execution
 *  context, so the promise is awaited to keep results deterministic. */
function runBackground(c: Context<AuthEnv>, promise: Promise<void>): Promise<void> {
  try {
    c.executionCtx.waitUntil(promise);
    return Promise.resolve();
  } catch {
    return promise;
  }
}

// --- the Basic password arm ---------------------------------------------------

/**
 * The outcome taxonomy of the API Basic password attempt. `failed` and
 * `unsupported-hash` (whose message goes to the log, never the wire) render
 * the generic 401; `webauthn-enrolled` carries the wire message;
 * `totp-fail` carries the audit-row coordinates (basic.go:182) and renders
 * the generic 401; `totp-locked` (c54ec52f0f's limiter — the per-account
 * failed-attempt counter upstream's ValidateAndConsumeTOTP spans) carries
 * the same audit coordinates and renders basic.go:186's ErrUserAuthMessage
 * VERBATIM (api.go:884 renders ErrAsUserAuthMessage messages — the ONE OTP
 * text that reaches the API wire).
 */
export type BasicPasswordOutcome =
  | { kind: "ok"; user: typeof users.$inferSelect }
  | { kind: "webauthn-enrolled" }
  | { kind: "totp-fail"; userId: number; username: string }
  | { kind: "totp-locked"; userId: number; username: string }
  | { kind: "unsupported-hash"; message: string }
  | { kind: "failed" };

/**
 * basic.go:139-161 — UserSignIn(uname, passwd) then the 2FA ladder:
 * WebAuthn-enrolled hard-rejects (the ErrUserAuthMessage body), a
 * TOTP-enrolled user must present `X-Gitea-OTP` and the passcode is
 * ATOMICALLY CONSUMED (a captured OTP cannot replay within its window).
 * Failures here are upstream's generic auth-error class, except the
 * WebAuthn reject. Context-free (db + the OTP passcode as parameters) so
 * the git-HTTP arm reuses it outside a Hono context (git-http/acl.ts).
 * `options.configuredHashSpec` is the caller's env-resolved
 * PASSWORD_HASH_ALGO specification (census B-87's consumption half — see
 * PasswordSignInOptions.configuredHashSpec): the sign-in's rehash-on-login
 * compares against AND rewrites under the configured spec. Omitted, the
 * landed pbkdf2 default stands.
 *
 * c54ec52f0f's lift: the passcode validates under the per-account
 * failed-attempt limiter — the shared `consumeTotpWithAttemptLimit`
 * tri-state (the ValidateAndConsumeTOTP mirror: empty passcode never
 * consumes, 5 failures lock for 15 min renewed per failure, success
 * clears). The locked verdict splits `totp-locked` out of `totp-fail` so
 * each surface renders its own TooManyAttempts shape.
 */
export async function basicPasswordArm(
  db: D1Database,
  basic: { username: string; password: string },
  otpPasscode: string,
  now: Date,
  options?: { configuredHashSpec?: string },
): Promise<BasicPasswordOutcome> {
  const signIn = await userSignInPassword(db, basic.username, basic.password, {
    configuredHashSpec: options?.configuredHashSpec,
  });
  if (!signIn.ok) {
    if (signIn.failure.kind === "unsupported-hash") {
      return { kind: "unsupported-hash", message: signIn.failure.error.message };
    }
    return { kind: "failed" };
  }
  const user = signIn.user;

  // basic.go:148-156 — WebAuthn-enrolled → hard reject.
  if (await hasCredentialsForUser(db, user.id)) {
    return { kind: "webauthn-enrolled" };
  }

  // basic.go:158-160 + validateTOTP (:169-193) — TOTP-enrolled → the
  // X-Gitea-OTP passcode, consumed atomically UNDER the failed-attempt
  // limiter (the tri-state splits the locked arm out before any
  // validation, exactly upstream's attempts >= totpMaxAttempts check).
  const twofa = await getTwoFactorByUid(db, user.id);
  if (twofa !== null) {
    const result = await consumeTotpWithAttemptLimit(db, twofa, otpPasscode, now);
    if (result === "too-many") {
      return { kind: "totp-locked", userId: user.id, username: user.username };
    }
    if (result === "invalid") {
      return { kind: "totp-fail", userId: user.id, username: user.username };
    }
  }

  return { kind: "ok", user };
}

// --- post-auth route middlewares ---------------------------------------------

/** Upstream `reqToken` (api.go:305–311). */
export function requireToken(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!c.get("auth")?.user) {
      return apiErrorResponse(c, 401, "token is required");
    }
    return next();
  };
}

/**
 * Upstream `tokenRequiresScopes(category...)` (api.go:271–305): the
 * enforcement level comes from the HTTP method (POST/PUT/PATCH/DELETE ⇒
 * write, else read); the 403 message is byte-identical, including Go's
 * `%v` slice formatting (`required=[read:user write:repository]`).
 * Requests without an attached token scope pass — `requireToken` is what
 * rejects anonymous callers.
 */
export function requireScope(...categories: ScopeCategory[]): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (auth?.scope === null || auth?.scope === undefined) {
      return next();
    }
    const level: ScopeLevel = isWriteMethod(c.req.method) ? "write" : "read";
    const required = requiredScopeNames(level, categories);
    if (!auth.scope.has(...required)) {
      const tokenScope = auth.token?.scopes ?? "";
      return apiErrorResponse(
        c,
        403,
        `token does not have at least one of required scope(s), required=[${required.join(" ")}], token scope=${tokenScope}`,
      );
    }
    return next();
  };
}

function isWriteMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

/** Upstream `reqSiteAdmin` (api.go:343–347). */
export function requireSiteAdmin(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!c.get("auth")?.user?.isAdmin) {
      return apiErrorResponse(c, 403, "user should be the site admin");
    }
    return next();
  };
}

/**
 * Upstream `DoerTokenAllowsOwner` (models/user/user_extdata.go:122–124):
 * a public-only token credential may resolve only PUBLIC owners — the
 * `publicOnly` restriction bit rides the attached token's scope set, exactly
 * like upstream's `extDoerToken.publicOnly` (a non-token or anonymous doer
 * never carries the bit and always passes).
 */
export function doerTokenAllowsOwner(
  scope: ScopeSet | null | undefined,
  ownerVisibility: UserVisibility,
): boolean {
  return scope?.publicOnly !== true || ownerVisibility === "public";
}

/** The `users.visibility` column by case-folded name, or null for no row. */
async function userVisibilityByName(db: D1Database, usernameLower: string): Promise<UserVisibility | null> {
  const row = await drizzle(db)
    .select({ visibility: users.visibility })
    .from(users)
    .where(eq(users.usernameLower, usernameLower))
    .get();
  return row?.visibility ?? null;
}

/**
 * Upstream `context.UserAssignmentAPI()` (services/context/user.go:32–35):
 * resolve the `:username` route target (case-insensitive; the doer short-
 * circuit keeps a display-cased self-visit stable). Unknown users are 404s
 * that do not disclose existence. Sets `c.var.contextUser`.
 *
 * Carries upstream's `userAssignment` public-only arm (user.go:61–64): a
 * public-only token visiting a limited/private target — THEMSELVES included,
 * the check is over the resolved row — answers the masked
 * `ErrUserRedirectNotExist` 404.
 */
export function requireContextUser(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const username = c.req.param("username") ?? "";
    const service = new TokenService(c.env.DB);
    const auth = c.get("auth");
    let user: AuthUser | null;
    if (auth?.user !== null && auth?.user !== undefined && auth.user.usernameLower === username.toLowerCase()) {
      user = auth.user;
    } else {
      user = await service.getUserByName(username);
    }
    if (user === null) {
      return apiErrorNotFound(c);
    }
    if (!doerTokenAllowsOwner(auth?.scope, await userVisibilityByName(c.env.DB, user.usernameLower) ?? "public")) {
      return apiErrorResponse(c, 404, userRedirectDoesNotExist(username));
    }
    c.set("contextUser", user);
    return next();
  };
}

/** Upstream `reqSelfOrAdmin` (api.go:371–378). */
export function requireSelfOrAdmin(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    const contextUser = c.get("contextUser");
    const isSiteAdmin = auth?.user?.isAdmin ?? false;
    const isSelf = auth?.user !== null && auth?.user !== undefined && auth.user.id === contextUser?.id;
    if (!isSiteAdmin && !isSelf) {
      return apiErrorResponse(c, 403, "doer should be the site admin or be same as the contextUser");
    }
    return next();
  };
}

/**
 * Upstream `reqBasicOrRevProxyAuth` (api.go:331–339) without the reverse-
 * proxy alternative (no reverse-proxy auth in cf-gitea, SPEC-0002 §4.6.9):
 * token CRUD requires the credential to have arrived via HTTP Basic.
 */
export function requireBasicAuth(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!c.get("auth")?.isBasicAuth) {
      return apiErrorResponse(c, 401, "auth required");
    }
    return next();
  };
}

/**
 * Upstream `sudo()` (api.go:111–146): admin-only impersonation via `?sudo=`
 * or the `Sudo` header. The doer is swapped to the case-insensitively
 * resolved target, keeping the *admin token's* scope attached (api.go:129–139
 * — `user.ExtDoerData = ctx.Doer.ExtDoerData`), so the impersonated request
 * can never exceed the authenticating token's scopes. Unknown targets are
 * 404s; non-admins get the exact upstream 403 message.
 */
export function sudo(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const target = c.req.query("sudo") || c.req.header("Sudo");
    if (target === undefined || target === "") {
      return next();
    }
    const auth = c.get("auth");
    if (!auth?.user?.isAdmin) {
      // Upstream's BARE `{message}` JSON (api.go:135-138's literal
      // ctx.JSON — no APIError `url` field).
      return c.json({ message: "Only administrators allowed to sudo." }, 403);
    }
    const service = new TokenService(c.env.DB);
    const impersonated = await service.getUserByName(target);
    if (impersonated === null) {
      return apiErrorNotFound(c);
    }
    // Swap the doer; token + scope stay (they belong to the admin's credential).
    c.set("auth", { ...auth, user: impersonated });
    return next();
  };
}

/**
 * Upstream `rejectPublicOnly()` (api.go:249–257): a token carrying the
 * `public-only` restriction bit (`IsPublicOnlyDoer` — anonymous and
 * non-token credentials never carry it) is refused with the exact upstream
 * 403 body. Upstream chains it onto specific route groups only (the
 * placements are enumerated where this is mounted); it must never be
 * blanket-applied.
 *
 * With `methods` the gate is scoped to those HTTP methods — upstream arms
 * like `Post(rejectPublicOnly(), …)` on a path whose sibling GET stays
 * public-only-visible (POST /user/repos, api.go:1181 — GET /user/repos is
 * NOT gated).
 */
export function rejectPublicOnly(...methods: string[]): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (methods.length > 0 && !methods.includes(c.req.method)) {
      return next();
    }
    const auth = c.get("auth");
    if (auth?.scope?.publicOnly !== true) {
      return next();
    }
    return apiErrorResponse(c, 403, PUBLIC_ONLY_FORBIDDEN_MESSAGE);
  };
}

/**
 * The `userAssignment` public-only arm (services/context/user.go:61–64) as a
 * mount-shaped middleware for the `/api/v1/users/{username}` resolve paths:
 * upstream chains `context.UserAssignmentAPI()` onto those groups
 * (api.go:1074 — GetInfo/heatmap/repos/projects/tokens/feeds plus the
 * keys/gpg_keys/followers/following/starred/subscriptions group, 1715
 * packages, 1722 orgs), while our directory routes resolve the context user
 * themselves — so the arm mounts above them. A public-only token resolving a
 * limited/private target answers the masked `ErrUserRedirectNotExist` 404
 * (existence never disclosed). Unknown targets fall through — the route
 * owns its own miss 404 — and the `search` segment is skipped: upstream
 * registers the static `/users/search` route inside the same tree before
 * the `/{username}` param group (static-over-param precedence), so
 * `userAssignment` never runs for that shape.
 */
export function rejectPublicOnlyUserAssignment(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const username = c.req.param("username") ?? "";
    if (username === "" || username.toLowerCase() === "search") {
      return next();
    }
    const auth = c.get("auth");
    if (auth?.scope?.publicOnly !== true) {
      return next();
    }
    const visibility = await userVisibilityByName(c.env.DB, username.toLowerCase());
    if (visibility !== null && !doerTokenAllowsOwner(auth.scope, visibility)) {
      return apiErrorResponse(c, 404, userRedirectDoesNotExist(username));
    }
    return next();
  };
}

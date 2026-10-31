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
 * `url` is the instance swagger URL (`AppURL + "api/swagger"`).
 */

import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../db/schema";
import type { AuthEnv, AuthInfo, AuthToken, AuthUser } from "./auth-context";
import { basicAuthTokenCandidate, parseAuthorizationHeader } from "./httpauth";
import { D1FailureLimiter, type RateLimitHook, type RateLimitVerdict } from "./failure-limiter";
import { requiredScopeNames, type ScopeCategory, ScopeSet, type ScopeLevel } from "./scopes";
import { TokenService } from "./token-service";
import { oauth2FeatureEnabled, resolveOAuth2AccessTokenCredential, type ResolvedOAuth2Credential } from "../services/oauth2/token";

/** Message used for every bad/expired/revoked credential (api.go:862–875). */
const INVALID_CREDENTIAL_MESSAGE = "invalid username, password or token";

/** Unpinned by SPEC-0002 §2.7 (only status + Retry-After are specified). */
const RATE_LIMITED_MESSAGE = "too many authentication failures, retry later";

/** Upstream `rejectPublicOnly` / `contextAuthenticatedUser` 403 body (api.go:251–256). */
export const PUBLIC_ONLY_FORBIDDEN_MESSAGE = "this endpoint is not available for public-only tokens";

/** Upstream `user_model.ErrUserRedirectNotExist.Error()` (redirect.go:27–29) —
 *  the masked 404 body `userAssignment` answers with (services/context/user.go:62). */
export function userRedirectDoesNotExist(username: string): string {
  return `user redirect does not exist [name: ${username}]`;
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

    // THE OAUTH2 DISPATCH (SPEC specs/oauth2-provider.md §2.7): a dotted
    // BEARER credential is OAuth2-grant shape (services/auth/oauth2.go:
    // 110-128 — the token extraction takes Bearer/query; a Basic-carried
    // JWT stays the PAT lookup like upstream's Basic method). verifyJws
    // pins the instance alg, assertApiTimeBounds applies the strict
    // exp/iat bounds, and the grant lookup resolves the doer + the access
    // scope — feeding the landed apiScopeGate UNCHANGED (§2.7: the token
    // resolves to (doer, scope) before the gate reads it, exactly like a
    // PAT). Upstream's actions-JWT arm of the dotted dispatch is not
    // ported (no Actions-user API identity; the recorded divergence note
    // in resolveOAuth2AccessTokenCredential's header).
    const oauth2Env: OAuth2DispatchEnv = c.env;
    const oauth2Resolved =
      bearerCredential !== null && bearerCredential.includes(".")
        ? await resolveOAuth2AccessTokenCredential(c.env.DB, bearerCredential, {
            enabled: oauth2FeatureEnabled(oauth2Env),
            configuredAlgorithm: oauth2Env.OAUTH2_SIGNING_ALGORITHM,
            now,
          })
        : null;
    const verified: { token: AuthToken; user: AuthUser } | null =
      oauth2Resolved !== null ? oauth2CredentialAuth(oauth2Resolved) : await service.verify(credential, { now });
    if (verified === null) {
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
    // (api.go:877–894); no activation/password cases exist yet, so only the
    // prohibited-account gate applies.
    if (verified.user.status === "prohibited") {
      return apiErrorResponse(
        c,
        403,
        "This account is prohibited from signing in, please contact your site administrator.",
      );
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
      return apiErrorResponse(c, 403, "Only administrators allowed to sudo.");
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

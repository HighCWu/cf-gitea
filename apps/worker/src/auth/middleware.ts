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

import type { AuthEnv, AuthInfo, AuthUser } from "./auth-context";
import { basicAuthTokenCandidate, parseAuthorizationHeader } from "./httpauth";
import { D1FailureLimiter, type RateLimitHook } from "./failure-limiter";
import { requiredScopeNames, type ScopeCategory, ScopeSet, type ScopeLevel } from "./scopes";
import { TokenService } from "./token-service";

/** Message used for every bad/expired/revoked credential (api.go:862–875). */
const INVALID_CREDENTIAL_MESSAGE = "invalid username, password or token";

/** Unpinned by SPEC-0002 §2.7 (only status + Retry-After are specified). */
const RATE_LIMITED_MESSAGE = "too many authentication failures, retry later";

export interface ResolveAuthOptions {
  /** Override the failure-limit backend (defaults to the D1 limiter). */
  failureLimiter?: (env: Env) => RateLimitHook;
}

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
    const credential = parsed?.bearerToken?.token ?? (parsed?.basicAuth ? basicAuthTokenCandidate(parsed.basicAuth) : null);

    if (parsed === null || credential === null) {
      // Malformed Authorization parses as *no credentials* → anonymous doer
      // (SPEC-0002 §4.1); routes decide anon-allowance.
      c.set("auth", { user: null, token: null, scope: null, isBasicAuth: false });
      await next();
      return;
    }

    // Failure limiting guards the credential-testing path only: anonymous
    // requests carry nothing to brute-force.
    const verdict = await limiter.check(ip, now);
    if (verdict.blocked) {
      return c.json({ message: RATE_LIMITED_MESSAGE, url: swaggerUrl(c) }, 429, {
        "Retry-After": String(verdict.retryAfterSeconds),
      });
    }

    const verified = await service.verify(credential, { now });
    if (verified === null) {
      await limiter.recordFailure(ip, now);
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
    // background (SPEC-0002 §2.7).
    await runBackground(c, service.needsLastUsedTouch(verified.token, now)
      ? service.touchLastUsed(verified.token.id, now)
      : Promise.resolve());
    await runBackground(c, limiter.reset(ip));

    await next();
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
 * Upstream `context.UserAssignmentAPI()` (services/context/user.go:32–35):
 * resolve the `:username` route target (case-insensitive; the doer short-
 * circuit keeps a display-cased self-visit stable). Unknown users are 404s
 * that do not disclose existence. Sets `c.var.contextUser`.
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

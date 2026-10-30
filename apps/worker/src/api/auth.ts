import type { Context, MiddlewareHandler } from "hono";

import type { AuthUser } from "../auth";
import { ApiError } from "./errors";
import type { ApiEnv } from "./env";
import type { User } from "./models/user";
import { authUserToApiUser } from "./services/user";

/**
 * Seam between `/api/v1` routes and token authentication (SPEC-0002 owns the
 * real semantics: token issuance, scopes, the 401/403/404 ACL matrix).
 *
 * The middleware below owns the wire-level concern — reading
 * `Authorization: token <token>` — and hands the extracted token to the
 * resolver; the resolver owns identity lookup. Wave 3 swaps in the real
 * resolver via `createApiRouter({ auth })`, or replaces the middleware factory
 * itself — one function change at the `createApiRouter` call site either way.
 */
export interface AuthResolver {
  /** Resolve an API token to a user, or null when the token is unknown/invalid. */
  resolveToken(token: string): Promise<User | null>;
}

/**
 * Extract the token from `Authorization: token <token>` (the contract's
 * AuthorizationHeaderToken security scheme; the deprecated `access_token`/`token`
 * query params are NOT implemented — removal upstream was announced for 1.23).
 * Scheme match is case-insensitive with flexible spacing — a deliberate
 * RFC 7235-conformant superset of upstream's exact `"token "` prefix match.
 * Returns null for absent headers and foreign schemes (Basic, Bearer, ...).
 */
export function extractTokenHeader(authorization: string | undefined): string | null {
  if (authorization === undefined) {
    return null;
  }
  const match = /^token\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

/**
 * Convert a SPEC-0002 verified user (the `AuthUser` context type) into the
 * contract `User` — BY DELEGATION to the canonical row-derived converter
 * (`authUserToApiUser`, services/user.ts → `apiUserFromRow`,
 * services/repository.ts). The api review's drift-1 fix: the dedicated body
 * this function used to inline hardcoded avatar_url/html_url to "",
 * visibility to "public", type to "User" and language to "en-US"; now every
 * consumer of the auth-shape User (GET /user, the webhook `sender`, every
 * `Viewer.requester`) renders the same row truth as GET /users/{username}.
 * `rowToUser` (auth/token-service.ts) carries the render-relevant columns
 * onto AuthUser where the row is in hand; `origin` is request-scoped and
 * comes from the caller's `c.req.url`.
 *
 * `origin` is optional only for the two legacy bridges that predate the
 * seam (routes/packages.ts's credential viewer, ui/index.ts's repo-search
 * bridge) — both consume the rendered User as a Viewer-requester SLICE
 * (login/is_admin predicates), never as a wire payload; without an origin
 * the URLs render root-relative. Request-path callers MUST pass it.
 */
export function toApiUser(u: AuthUser, origin?: string): User {
  return authUserToApiUser(u, origin ?? "");
}

/**
 * Identity precedence inside the api middlewares: (1) the SPEC-0002
 * `resolveAuth` middleware mounted at `/api/v1/*` already verified the
 * credential against D1 — its `c.var.auth` result wins when present;
 * (2) standalone router usage (tests, embedding) falls back to the injected
 * resolver parsing the header itself. Arm (1) is a REQUEST path, so the
 * row-truth conversion gets the request origin (the avatar/html URLs derive
 * from it — `viewerOf`'s same `new URL(c.req.url).origin` rule,
 * services/repository.ts); arm (2)'s resolver returns an already-rendered
 * contract `User`, nothing to convert.
 */
function identityFrom(c: Context<ApiEnv>, resolver: AuthResolver): Promise<User | null> {
  const ctxAuth = c.get("auth");
  if (ctxAuth !== undefined) {
    return Promise.resolve(
      ctxAuth.user === null ? null : toApiUser(ctxAuth.user, new URL(c.req.url).origin),
    );
  }
  const token = extractTokenHeader(c.req.header("Authorization"));
  return token === null ? Promise.resolve(null) : resolver.resolveToken(token);
}

/**
 * Token auth middleware for routes that require a signed-in caller (upstream
 * `reqToken`). Absent/foreign-scheme header or unknown token → 401 with
 * Gitea's exact body — upstream messages both cases "token is required"
 * (gitea/routers/api/v1/api.go reqToken + ctx.APIError): auth failures are
 * silent and reqToken rejects unconditionally. The resolved user lands in
 * `c.get("authUser")`.
 */
export function createTokenAuthMiddleware(resolver: AuthResolver): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const user = await identityFrom(c, resolver);
    if (user === null) {
      throw new ApiError(401, "token is required");
    }
    c.set("authUser", user);
    await next();
  };
}

/**
 * Optional token auth for anonymous-capable routes. Upstream's API Contexter
 * parses `Authorization: token <token>` on EVERY route to establish
 * `ctx.Doer` (routers/api/v1/api.go — `reqToken` only rejects unsigned
 * callers), so reads of public resources are anonymous while a valid token
 * upgrades the response (visibility, embedded permissions block). A present
 * but unknown token degrades to anonymous (silent auth failure, same rule as
 * `createTokenAuthMiddleware`); the resolved user lands in `c.get("authUser")`.
 */
export function createOptionalTokenAuthMiddleware(resolver: AuthResolver): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const user = await identityFrom(c, resolver);
    if (user !== null) {
      c.set("authUser", user);
    }
    await next();
  };
}

/** The stub identity returned for accepted dev/test tokens. */
export const STUB_USER: User = {
  id: 1,
  login: "cf-gitea-stub",
  username: "cf-gitea-stub",
  email: "stub@cf-gitea.invalid",
  full_name: "cf-gitea Stub User",
  avatar_url: "https://avatar.invalid/cf-gitea-stub",
  html_url: "https://gitea.invalid/cf-gitea-stub",
  language: "en-US",
  location: "",
  website: "",
  description: "",
  active: true,
  is_admin: false,
  prohibit_login: false,
  restricted: false,
  login_name: "",
  source_id: 0,
  followers_count: 0,
  following_count: 0,
  starred_repos_count: 0,
  created: "2026-01-01T00:00:00Z",
  last_login: "2026-01-01T00:00:00Z",
  type: "User",
  visibility: "public",
};

/**
 * Dev/test resolver: accepts ANY well-formed token (or, when `acceptedTokens`
 * is given, only those) and resolves it to the fixed stub user. Never wire
 * this into production — Wave 3's SPEC-0002 middleware replaces it.
 */
export function createStubAuthResolver(acceptedTokens?: Iterable<string>): AuthResolver {
  const allowed = acceptedTokens === undefined ? null : new Set(acceptedTokens);
  return {
    resolveToken(token) {
      const accepted = allowed === null || allowed.has(token);
      return Promise.resolve(accepted ? STUB_USER : null);
    },
  };
}

import type { MiddlewareHandler } from "hono";

import { ApiError } from "./errors";
import type { ApiEnv } from "./env";
import type { User } from "./models/user";

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
 * Token auth middleware for routes that require a signed-in caller (upstream
 * `reqToken`). Absent/foreign-scheme header or unknown token → 401 with
 * Gitea's exact body — upstream messages both cases "token is required"
 * (gitea/routers/api/v1/api.go reqToken + ctx.APIError): auth failures are
 * silent and reqToken rejects unconditionally. The resolved user lands in
 * `c.get("authUser")`.
 */
export function createTokenAuthMiddleware(resolver: AuthResolver): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const token = extractTokenHeader(c.req.header("Authorization"));
    const user = token === null ? null : await resolver.resolveToken(token);
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
    const token = extractTokenHeader(c.req.header("Authorization"));
    if (token !== null) {
      const user = await resolver.resolveToken(token);
      if (user !== null) {
        c.set("authUser", user);
      }
    }
    await next();
  };
}

/** The stub identity returned for accepted dev/test tokens. */
export const STUB_USER: User = {
  id: 1,
  login: "cf-gitea-stub",
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

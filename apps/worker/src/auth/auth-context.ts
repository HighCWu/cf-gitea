/**
 * Auth context types — the shape `resolveAuth` attaches to `c.var.auth`
 * (SPEC-0002 §2.5). Data-only: enforcement primitives live in middleware.ts
 * and scopes.ts.
 */

import type { ScopeSet } from "./scopes";

export interface AuthUser {
  id: number;
  /** Display-cased username. */
  username: string;
  /** Case-folded login key. */
  usernameLower: string;
  email: string | null;
  displayName: string | null;
  /** The profile trio (usability F-1/R-1) — carried from the users row so
   *  every User projection (incl. the auth middleware's own converter)
   *  renders them; null = unset (renders ""). */
  location: string | null;
  website: string | null;
  description: string | null;
  /** Site admin — gates sudo/admin routes (upstream `IsAdmin`). */
  isAdmin: boolean;
  status: "active" | "prohibited";
  createdAt: Date;
  /**
   * The row's render-relevant columns (parity drift 1, api review): carried
   * by `rowToUser` so the api middlewares' contract conversion
   * (`authUserToApiUser`, api/services/user.ts) renders the doer through the
   * CANONICAL row-derived converter — real type/visibility/star counter in
   * GET /user, the webhook `sender`, and every `Viewer.requester` — instead
   * of the hardcoded defaults the dedicated auth serializer used to emit.
   * Optional because the only production constructor is `rowToUser` (always
   * sets them); hand-built AuthUser slices (predicate-only bridges) omit
   * them and the adapter then renders the documented defaults.
   */
  type?: "user" | "org";
  visibility?: "public" | "limited" | "private";
  numStars?: number;
  /** The row's `last_login_at` — the last SESSION MINT instant (upstream
   *  `LastLoginUnix`, models/user/user.go:124; bumped by mintSession, the
   *  port of upstream's sign-in family — routers/web/auth/auth.go:427-430,
   *  services/auth/auth.go:52). Rendered authed-gated by the API serializer
   *  (convert/user.go:118). Optional for the same reason as the other
   *  render-relevant carry: hand-built AuthUser slices omit it and the
   *  adapter renders Go zero time (upstream's zero TimeStamp). */
  lastLoginAt?: Date | null;
}

export interface AuthToken {
  id: number;
  userId: number;
  name: string;
  /** `cfg_<8hex>` public lookup prefix. */
  prefix: string;
  /** Normalized, comma-joined scope string. */
  scopes: string;
  /** cf-gitea extension; null = never expires. */
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/**
 * Request auth state. `user` null = anonymous doer (routes decide
 * anon-allowance, SPEC-0002 §2.5.3). `token` non-null means the request is
 * token-authenticated; `scope` is its parsed (normalized) scope set and
 * stays attached to the doer through `sudo()` impersonation.
 */
export interface AuthInfo {
  user: AuthUser | null;
  token: AuthToken | null;
  scope: ScopeSet | null;
  /** Credential arrived via HTTP Basic (token-as-username or token-as-password). */
  isBasicAuth: boolean;
}

/** Hono environment for the auth module and the routes that consume it. */
export interface AuthEnv {
  Bindings: Env;
  Variables: {
    /** Set by `resolveAuth`; middleware fail closed when unset. */
    auth: AuthInfo;
    /** Set by `requireContextUser` (the `:username` route target). */
    contextUser: AuthUser;
  };
}

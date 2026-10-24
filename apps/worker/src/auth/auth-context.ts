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
  /** Site admin — gates sudo/admin routes (upstream `IsAdmin`). */
  isAdmin: boolean;
  status: "active" | "prohibited";
  createdAt: Date;
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

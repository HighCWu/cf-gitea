import type { AuthUser } from "../auth";
import type { User } from "./models/user";

/**
 * Env for every `/api/v1` route: the Worker bindings plus the context
 * variables the auth middleware populates.
 */
export interface ApiEnv {
  Bindings: Env;
  Variables: {
    /** User resolved from the presented token (see src/api/auth.ts). */
    authUser: User;
    /**
     * Set by the SPEC-0002 `resolveAuth` middleware mounted at `/api/v1/*` in
     * the Worker entry: when present, its (already D1-verified) result is the
     * source of identity for the api middlewares — the injected-resolver path
     * only applies when the router runs standalone (tests/embedding).
     */
    auth?: { user: AuthUser | null };
  };
}

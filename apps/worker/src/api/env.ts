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
  };
}

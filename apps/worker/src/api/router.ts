import { OpenAPIHono } from "@hono/zod-openapi";

import {
  createOptionalTokenAuthMiddleware,
  createStubAuthResolver,
  createTokenAuthMiddleware,
  type AuthResolver,
} from "./auth";
import type { ApiEnv } from "./env";
import { giteaErrorHandler } from "./errors";
import { registerHookRoutes } from "./routes/hooks";
import { registerLabelRoutes } from "./routes/labels";
import { registerMarkdownRoutes } from "./routes/markdown";
import { registerMilestoneRoutes } from "./routes/milestones";
import { registerOrgRoutes } from "./routes/org-repos";
import { registerRepoRoutes } from "./routes/repo";
import { registerStatusRoutes } from "./routes/statuses";
import { registerUserReposRoutes } from "./routes/user-repos";
import { registerUserRoute } from "./routes/user";
import { registerUsersRoutes } from "./routes/users";
import { registerVersionRoute } from "./routes/version";

export interface ApiRouterOptions {
  /**
   * Token → user resolution backing the auth middleware. Default: the stub
   * resolver (dev/tests only). Wave 3 (SPEC-0002) passes the real resolver
   * here — or replaces `createTokenAuthMiddleware` — at this single seam.
   */
  auth?: AuthResolver;
}

/**
 * Build the mountable `/api/v1` application (SPEC-0004). Wave 3 mounts it on
 * the Worker app at `/api/v1`; all route paths here are relative to that
 * mount point, exactly like the vendored swagger's path keys relative to its
 * `basePath`.
 */
export function createApiRouter(options: ApiRouterOptions = {}): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>();

  // Every error becomes Gitea's exact {message, url} body (handlers and
  // middleware just throw ApiError).
  app.onError(giteaErrorHandler);

  const requireAuth = createTokenAuthMiddleware(options.auth ?? createStubAuthResolver());
  const optionalAuth = createOptionalTokenAuthMiddleware(options.auth ?? createStubAuthResolver());
  registerVersionRoute(app);
  registerUserRoute(app, requireAuth);
  registerUsersRoutes(app, optionalAuth);
  registerUserReposRoutes(app, requireAuth, optionalAuth);
  registerRepoRoutes(app, requireAuth, optionalAuth);
  registerStatusRoutes(app, requireAuth, optionalAuth);
  registerLabelRoutes(app, requireAuth, optionalAuth);
  registerMilestoneRoutes(app, requireAuth, optionalAuth);
  registerHookRoutes(app, requireAuth);
  registerOrgRoutes(app, requireAuth, optionalAuth);
  registerMarkdownRoutes(app, requireAuth);

  return app;
}

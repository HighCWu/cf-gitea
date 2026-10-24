import { OpenAPIHono } from "@hono/zod-openapi";

import {
  createOptionalTokenAuthMiddleware,
  createStubAuthResolver,
  createTokenAuthMiddleware,
  type AuthResolver,
} from "./auth";
import type { ApiEnv } from "./env";
import { giteaErrorHandler } from "./errors";
import { registerCollaboratorRoutes } from "./routes/collaborators";
import { registerFollowRoutes } from "./routes/follows";
import { registerHookRoutes } from "./routes/hooks";
import { registerIdentityRoutes } from "./routes/identity";
import { registerImportRoutes } from "./routes/imports";
import { registerIssueRoutes } from "./routes/issues";
import { registerLabelRoutes } from "./routes/labels";
import { registerMarkdownRoutes } from "./routes/markdown";
import { registerMilestoneRoutes } from "./routes/milestones";
import { registerOrgRoutes } from "./routes/org-repos";
import { registerOrgProfileRoutes } from "./routes/orgs";
import { registerPullRoutes } from "./routes/pulls";
import { registerReleaseRoutes } from "./routes/releases";
import { registerRepoRoutes } from "./routes/repo";
import { registerStatusRoutes } from "./routes/statuses";
import { registerSubscriptionRoutes } from "./routes/subscription";
import { registerTopicRoutes } from "./routes/topics";
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
  // Identity self-service (committed with the bdf8546 batch, registered here):
  // /user/followers, /user/following/{username} writes, and the key-list
  // stubs — all doer-scoped, so requireAuth only.
  registerIdentityRoutes(app, requireAuth);
  registerUsersRoutes(app, optionalAuth);
  // Follow listings under /users/{username}/… (userListFollowers /
  // userListFollowing / userCheckFollowing) — requireAuth per the upstream
  // reqToken() at the whole /users group.
  registerFollowRoutes(app, requireAuth);
  registerUserReposRoutes(app, requireAuth, optionalAuth);
  // Issue routes register BEFORE the repo-metadata routes: the static
  // `/repos/issues/search` path must win over the same-shape
  // `/repos/{owner}/{repo}` param route (upstream registers
  // `m.Get("/issues/search", …)` before the `/{username}/{reponame}` group —
  // static-over-param precedence, routers/api/v1/api.go).
  registerIssueRoutes(app, requireAuth, optionalAuth);
  // PR routes ride the issue services; `/repos/{owner}/{repo}/pulls/{index}`
  // (one segment) and `…/pulls/{base}/{head}` (two segments) never collide,
  // and the static `/repos/issues/search` above still wins its precedence
  // battle before the `{owner}` params.
  registerPullRoutes(app, requireAuth, optionalAuth);
  registerRepoRoutes(app, requireAuth, optionalAuth);
  // Repo-scoped families of the B7/D1 wave (each registers only deeper
  // `/repos/{owner}/{repo}/<family>` paths, so none of them can shadow the
  // static `/repos/issues/search` guarded above or be shadowed by the
  // `/repos/{owner}/{repo}` metadata routes):
  //   - topics (repoListTopics/repoUpdateTopics),
  //   - collaborators + assignees (requireAuth — upstream reqToken),
  //   - releases (repoListReleases … repoDeleteRelease),
  //   - subscription (userCurrentCheck/Put/DeleteSubscription — requireAuth).
  registerTopicRoutes(app, requireAuth, optionalAuth);
  registerCollaboratorRoutes(app, requireAuth);
  registerReleaseRoutes(app, requireAuth, optionalAuth);
  registerSubscriptionRoutes(app, requireAuth);
  registerStatusRoutes(app, requireAuth, optionalAuth);
  registerLabelRoutes(app, requireAuth, optionalAuth);
  registerMilestoneRoutes(app, requireAuth, optionalAuth);
  registerHookRoutes(app, requireAuth);
  registerOrgRoutes(app, requireAuth, optionalAuth);
  // Org profile + members surface (routes/orgs.ts — orgGet/orgEdit, the
  // members and public_members families): same doer/optional split as the
  // org-repos group above.
  registerOrgProfileRoutes(app, requireAuth, optionalAuth);
  registerMarkdownRoutes(app, requireAuth);
  // SPEC-0003 §2.6 import channel: plain Hono routes OUTSIDE the generated
  // OpenAPI document (the SPEC declares the surface here, swagger-shaped in
  // 0004 — see routes/imports.ts). Registration order is irrelevant: the
  // paths are import-family-specific and collide with nothing above.
  registerImportRoutes(app, requireAuth);

  return app;
}

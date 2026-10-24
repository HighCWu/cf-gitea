import { OpenAPIHono } from "@hono/zod-openapi";

import {
  createOptionalTokenAuthMiddleware,
  createStubAuthResolver,
  createTokenAuthMiddleware,
  type AuthResolver,
} from "./auth";
import type { ApiEnv } from "./env";
import { giteaErrorHandler } from "./errors";
import { registerArchiveRoutes } from "./routes/archive";
import { registerBranchRoutes } from "./routes/branches";
import { registerCollaboratorRoutes } from "./routes/collaborators";
import { registerCommitRoutes } from "./routes/commits";
import { registerContentsRoutes } from "./routes/contents";
import { registerDiffPatchRoutes } from "./routes/diffpatch";
import { registerFollowRoutes } from "./routes/follows";
import { registerGitRoutes } from "./routes/git";
import { registerHookRoutes } from "./routes/hooks";
import { registerIdentityRoutes } from "./routes/identity";
import { registerImportRoutes } from "./routes/imports";
import { registerIssueRoutes } from "./routes/issues";
import { registerLabelRoutes } from "./routes/labels";
import { registerLanguageRoutes } from "./routes/languages";
import { registerMarkdownRoutes } from "./routes/markdown";
import { registerMilestoneRoutes } from "./routes/milestones";
import { registerOrgRoutes } from "./routes/org-repos";
import { registerOrgProfileRoutes } from "./routes/orgs";
import { registerPullAutoMergeRoutes } from "./routes/pull-automerge";
import { registerPullRoutes } from "./routes/pulls";
import { registerReleaseAssetRoutes } from "./routes/release-assets";
import { registerReleaseRoutes } from "./routes/releases";
import { registerRepoRoutes } from "./routes/repo";
import { registerStarredRoutes } from "./routes/starred";
import { registerStatusRoutes } from "./routes/statuses";
import { registerTagRoutes } from "./routes/tags";
import { registerSubscriptionRoutes } from "./routes/subscription";
import { registerTopicRoutes } from "./routes/topics";
import { registerUserReposRoutes } from "./routes/user-repos";
import { registerUserRoute } from "./routes/user";
import { registerUserSettingsRoutes } from "./routes/user-settings";
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
  // Batch-8 git-surface families (REG-MERGE-2): branches, tags, raw git
  // objects, contents (the read union + the file-change writes) and the
  // commit family. All are deeper `/repos/{owner}/{repo}/<family>` paths, so
  // none shadows the static `/repos/issues/search` guarded above or the
  // `/repos/{owner}/{repo}` metadata routes; the shared doer/optional split
  // matches upstream (reads optional, writes reqToken).
  registerBranchRoutes(app, requireAuth, optionalAuth);
  registerTagRoutes(app, requireAuth, optionalAuth);
  registerGitRoutes(app, requireAuth, optionalAuth);
  registerContentsRoutes(app, requireAuth, optionalAuth);
  // The commit family owns `commits/{sha}/pull` (repoGetCommitPullRequest)
  // inline. The PULL-ASSETS wave's duplicate pure-D1 variant
  // (routes/commit-pull.ts) was dropped at its landing review (ceb1106) —
  // this registration is the only repoGetCommitPullRequest.
  registerCommitRoutes(app, requireAuth, optionalAuth);
  // Release attachment list + upload (the PULL-ASSETS wave's tier-1 pair;
  // rides the releases module's family paths — registered after the release
  // routes like any deeper family).
  registerReleaseAssetRoutes(app, requireAuth, optionalAuth);
  // User-account stragglers: the signed-in settings read/patch and the star
  // family (upstream reqToken's the whole /user group — requireAuth only).
  registerUserSettingsRoutes(app, requireAuth);
  registerStarredRoutes(app, requireAuth);
  // Tier-1 tail families (REG-MERGE-3, committed 6e3c322): the archive
  // download, the diffpatch apply, the languages listing and the scheduled
  // auto-merge cancellation. All are deeper `/repos/{owner}/{repo}/<family>`
  // paths that shadow nothing registered above. pull-automerge is
  // METHOD-disjoint from registerPullRoutes (DELETE on
  // `pulls/{index}/merge` vs the POST/GET family there), so registration
  // order between the two is irrelevant.
  registerArchiveRoutes(app, requireAuth, optionalAuth);
  registerDiffPatchRoutes(app, requireAuth);
  registerLanguageRoutes(app, requireAuth, optionalAuth);
  registerPullAutoMergeRoutes(app, requireAuth);
  // TODO(REG-MERGE-4): forks (routes/forks.ts + services/forks.ts +
  // repos/fork-task.ts) was still mid-flight (untracked working-tree files)
  // at this merge — register registerForkRoutes(app, requireAuth,
  // optionalAuth) once its wave lands; the compat suite's loud guard will
  // demand its scenarios.

  return app;
}

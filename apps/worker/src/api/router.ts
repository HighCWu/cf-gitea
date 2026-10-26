import { OpenAPIHono } from "@hono/zod-openapi";

import {
  createOptionalTokenAuthMiddleware,
  createStubAuthResolver,
  createTokenAuthMiddleware,
  type AuthResolver,
} from "./auth";
import type { ApiEnv } from "./env";
import { giteaErrorHandler } from "./errors";
import { registerAvatarRoutes } from "./routes/avatars";
import { registerAccountAggregatesRoutes } from "./routes/account-aggregates";
import { registerAdminDegenerateRoutes } from "./routes/admin-degenerate";
import { registerAdminOrgExtrasRoutes } from "./routes/admin-org-extras";
import { registerDeployKeyRoutes } from "./routes/deploy-keys";
import { registerSecretsVariablesRoutes } from "./routes/secrets-variables";
import { registerBlockRoutes } from "./routes/blocks";
import { registerPushMirrorRoutes } from "./routes/push-mirrors";
import { registerTagProtectionRoutes } from "./routes/tag-protections";
import { registerWikiRoutes } from "./routes/wiki";
import { registerGitHookRoutes } from "./routes/git-hooks";
import { registerProjectsRepoRoutes } from "./routes/projects-repo";
import { registerProjectsOrgRoutes } from "./routes/projects-org";
import { registerProjectsUserRoutes } from "./routes/projects-user";
import { registerOAuth2AppRoutes } from "./routes/oauth2-apps";
import { registerAdminBadgeRoutes } from "./routes/admin-badges";
import { registerRepoLicenseRoutes } from "./routes/repo-licenses";
import { registerGenerateRepoRoute } from "./routes/generate-repo";
import { registerActivityFeedRoutes } from "./routes/activity-feeds";
import { registerAdminT2Routes } from "./routes/admin-t2";
import { registerArchiveRoutes } from "./routes/archive";
import { registerBranchProtectionRoutes } from "./routes/branch-protections";
import { registerBranchRoutes } from "./routes/branches";
import { registerCollaboratorRoutes } from "./routes/collaborators";
import { registerCommitRoutes } from "./routes/commits";
import { registerContentsRoutes } from "./routes/contents";
import { registerDiffPatchRoutes } from "./routes/diffpatch";
import { registerFollowRoutes } from "./routes/follows";
import { registerMirrorRoutes } from "./routes/mirror";
import { registerForkRoutes } from "./routes/forks";
import { registerGitRoutes } from "./routes/git";
import { registerHookRoutes } from "./routes/hooks";
import { registerHookScopeRoutes } from "./routes/hooks-scopes";
import { registerHookDeliveryRoute } from "./routes/hook-delivery";
import { registerIdentityRoutes } from "./routes/identity";
import { registerImportRoutes } from "./routes/imports";
import { registerIssueRoutes } from "./routes/issues";
import { registerIssueTablesT2Routes } from "./routes/issue-tables-t2";
import { registerIssueAttachmentRoutes } from "./routes/issue-attachments";
import { registerIssueT2Routes } from "./routes/issue-t2";
import { registerIssueWriteT2Routes } from "./routes/issue-write-t2";
import { registerLabelRoutes } from "./routes/labels";
import { registerLabelsT2Routes } from "./routes/labels-t2";
import { registerLanguageRoutes } from "./routes/languages";
import { registerMarkdownRoutes } from "./routes/markdown";
import { registerMilestoneRoutes } from "./routes/milestones";
import { registerMiscT2Routes } from "./routes/misc-t2";
import { registerMiscT3Routes } from "./routes/misc-t3";
import { registerNotificationsRoutes } from "./routes/notifications";
import { registerOrgRoutes } from "./routes/org-repos";
import { registerOrgTeamsRoutes } from "./routes/org-teams";
import { registerOrgProfileRoutes } from "./routes/orgs";
import { registerPullAutoMergeRoutes } from "./routes/pull-automerge";
import { registerPullRoutes } from "./routes/pulls";
import { registerPullReviewRoutes } from "./routes/pull-reviews";
import { registerReleaseAssetRoutes } from "./routes/release-assets";
import { registerReleaseRoutes } from "./routes/releases";
import { registerRepoExtrasT2Routes } from "./routes/repo-extras-t2";
import { registerRepoRoutes } from "./routes/repo";
import { registerSocialT2Routes } from "./routes/social-t2";
import { registerStarredRoutes } from "./routes/starred";
import { registerStatusRoutes } from "./routes/statuses";
import { registerTagRoutes } from "./routes/tags";
import { registerSubscriptionRoutes } from "./routes/subscription";
import { registerTopicItemRoutes } from "./routes/topic-items";
import { registerTopicRoutes } from "./routes/topics";
import { registerUserReposRoutes } from "./routes/user-repos";
import { registerUserReadT2Routes } from "./routes/user-read-t2";
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
  registerMirrorRoutes(app, requireAuth); // SPEC-0009 mirror family (repo-scoped non-contract pairs + the declared contract route POST /repos/migrate, 0fe6b04)
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
  // Tier-2 PR reviews: the review family + reviewer requests (type=4 rows,
  // upstream-shaped) + the four review events (migration 0018).
  registerPullReviewRoutes(app, requireAuth, optionalAuth);
  registerRepoRoutes(app, requireAuth, optionalAuth);
  // Tier-2 repo extras: transfer accept/reject, topic search, repo
  // permissions, reviewers/issue-config, pull-review comment threads,
  // file-contents GET/POST, release-attachment trio.
  registerRepoExtrasT2Routes(app, requireAuth, optionalAuth);
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
  // Tier-2 org label family: org-scoped CRUD reusing the repo-family
  // edit/delete cascades (upstream owner-independent UpdateLabel).
  registerLabelsT2Routes(app, requireAuth, optionalAuth);
  registerMilestoneRoutes(app, requireAuth, optionalAuth);
  registerHookRoutes(app, requireAuth);
  registerOrgRoutes(app, requireAuth, optionalAuth);
  // Org profile + members surface (routes/orgs.ts — orgGet/orgEdit, the
  // members and public_members families): same doer/optional split as the
  // org-repos group above.
  registerOrgProfileRoutes(app, requireAuth, optionalAuth);
  // Tier-2 org teams: team CRUD/membership/repo-access (migration 0015,
  // SPEC-0007's deferred core; owners bridge = org_members.role).
  registerOrgTeamsRoutes(app, requireAuth, optionalAuth);
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
  // SPEC-0013 M3: the branch_protections API family over the landed rules
  // (recompute instrument wired at create/replace/delete).
  registerBranchProtectionRoutes(app, requireAuth);
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
  // Tier-2 admin surface: user search/create/edit/delete, org create,
  // rename, admin repo create. Every op site-admin gated (upstream
  // reqSiteAdmin); PAT-only deviations documented in the module header.
  registerAdminT2Routes(app, requireAuth);
  // Inventory batches: hooks scope families (org/user/admin over the landed
  // webhooks store) + the degenerate-but-honest admin five.
  registerHookScopeRoutes(app, requireAuth);
  registerAdminDegenerateRoutes(app, requireAuth);
  // Inventory batch 4: the avatar upload/delete trio over the R2 avatar
  // store (avatars/u_<id> + avatars/<storage_key>).
  registerAvatarRoutes(app, requireAuth);
  // Inventory batch 1: tokens family, times/stopwatch aggregates, GPG
  // verify, org-repo alias + bulk delete, repo signing keys.
  registerAccountAggregatesRoutes(app, requireAuth);
  registerAdminOrgExtrasRoutes(app, requireAuth, optionalAuth);
  // Inventory batch 5: repo deploy keys + deploy tokens (migration 0020).
  registerDeployKeyRoutes(app, requireAuth);
  // Inventory batch 3: actions secrets + variables (repo/org/user scopes,
  // migration 0021 — storage+API surface; the Actions runtime stays
  // SPEC-0012-gated).
  registerSecretsVariablesRoutes(app, requireAuth);
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
  // Fork family (REG-MERGE-4, trio committed 8fb87a2): the 202-async
  // createFork POST and the listForks listing, backed by the repo-fork
  // queue consumer. Deeper `/repos/{owner}/{repo}/forks` paths — shadows
  // nothing registered above; listForks reads optional, create reqToken,
  // matching upstream's reqToken/optional split.
  registerForkRoutes(app, requireAuth, optionalAuth);
  // Tier-2 issue-family extras (reactions, subscriptions, pins, deadline,
  // lock, the deprecated nested comment pair). All are deeper
  // `/repos/{owner}/{repo}/issues|pulls/…` paths that shadow nothing above;
  // reads optional, writes reqToken — the upstream split.
  registerIssueT2Routes(app, requireAuth, optionalAuth);
  // Tier-2 issue writes: label detach + the pin trio (pin/unpin/move). Same
  // deep paths as the family above; writes reqToken per upstream.
  registerIssueWriteT2Routes(app, requireAuth);
  // Tier-2 issue tables: assignees/dependencies/blocks/stopwatch/tracked
  // times over migration 0012 — writes reqToken, reads ride optionalAuth
  // where the contract allows anonymous listing.
  registerIssueTablesT2Routes(app, requireAuth, optionalAuth);
  // Tier-2 issue attachments: issue + comment asset families (inline
  // multipart or relay PUT/GET pair), R2 under repos/<key>/attachments/.
  registerIssueAttachmentRoutes(app, requireAuth, optionalAuth);
  // Tier-2 table-free misc reads: option templates (gitignore/label/license),
  // published settings, /markup, /token lifecycle. Anonymous except the
  // auth'd trio, mirroring upstream api.go routing.
  registerMiscT2Routes(app, requireAuth);
  // Tier-3 misc stragglers: signing-key 404 (no key configured — upstream
  // behavior) + the doer-scoped key/gpg list/get/delete honest stubs.
  registerMiscT3Routes(app, requireAuth);
  // Tier-2 user reads: heatmap + current-following check.
  registerUserReadT2Routes(app, requireAuth, optionalAuth);
  // Tier-2 notifications: derived threads over issue/comment activity; all
  // seven ops reqToken (upstream reqToken on the whole tag).
  registerNotificationsRoutes(app, requireAuth);
  // Tier-2 social listings (stargazers, subscribers, watched/starred repos
  // by user, the doer's following list). The repo listings ride optionalAuth
  // (upstream repoAssignment); the /user + /users listings requireAuth.
  registerSocialT2Routes(app, requireAuth, optionalAuth);
  // Tier-2 topic items (PUT/DELETE topics/{topic}) — METHOD-disjoint from
  // registerTopicRoutes (PUT/DELETE on `topics` vs `topics/{topic}`), so
  // registration order between the two is irrelevant.
  registerTopicItemRoutes(app, requireAuth);
  // Tier-2 webhook delivery item (GET hooks/{id}/deliveries/{uuid}) — deeper
  // than the landed deliveries list; requireAuth like the whole hook family.
  registerHookDeliveryRoute(app, requireAuth);
  // Wave-22 inventory batches: push mirrors (migration 0023; the sync op
  // enqueues on the mirror lane), tag protections (0025; the create/delete
  // arms of routes/tags.ts + the git-http push gate enforce the patterns),
  // and the user/org block surface (0022; storage+API now, visibility
  // enforcement is the mapped follow-up). The wiki family rides a sibling
  // engine cell (specs/wiki.md) — reads optionalAuth, writes reqToken.
  registerPushMirrorRoutes(app, requireAuth);
  registerTagProtectionRoutes(app, requireAuth);
  registerBlockRoutes(app, requireAuth);
  registerWikiRoutes(app, requireAuth, optionalAuth);
  // Server-side git hooks: degenerate sample surface + R2-persisted edits
  // (githooks/<repo_id>/<hook_name>) — static-over-param keeps the literal
  // /hooks/git ahead of hooks.ts's /hooks/{id}. reqToken+repo-admin gates
  // documented in RUNTIME_ONLY_RESPONSES.
  registerGitHookRoutes(app, requireAuth);
  // Inventory batch 6 stage 1: repo-scoped project boards (projects,
  // columns, column-issues, workflows — migration 0024; stages 2-3 add the
  // org/user scopes over the same service). Reads ride optionalAuth where
  // the contract allows; writes reqToken.
  registerProjectsRepoRoutes(app, requireAuth, optionalAuth);
  // Batch 6 stage 2: the org scope over the same store — orgAssignment
  // 404/307 chain, unit-access 404-never-403, workflows owner-only.
  registerProjectsOrgRoutes(app, requireAuth, optionalAuth);
  // Batch 6 stage 3 (FINAL): the user scope — doer-owned ids (reqToken-only
  // writes, no unit-access chain), /users/{username} UserAssignmentAPI
  // matrix. Batch 6 complete: 64 ops, three scopes, one store.
  registerProjectsUserRoutes(app, requireAuth, optionalAuth);
  // Wave-23 long-tail: OAuth2 app CRUD (migration 0026; CRUD-only — the
  // authorize/token flow is web-UI territory), admin badges + repo licenses
  // + template generate (0027; license detection is glue-only until the
  // detector wave populates), and the activity feeds over the action table
  // (0028, specs/activity-feeds.md — 10 action types wired at the emitters).
  registerOAuth2AppRoutes(app, requireAuth);
  registerAdminBadgeRoutes(app, requireAuth);
  registerRepoLicenseRoutes(app, optionalAuth);
  registerGenerateRepoRoute(app, requireAuth);
  registerActivityFeedRoutes(app, requireAuth, optionalAuth);

  return app;
}

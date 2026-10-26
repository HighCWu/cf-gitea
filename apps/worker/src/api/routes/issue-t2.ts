import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { IssueNotExistError } from "../../issues/errors";
import type { IssueRow } from "../../issues/service";
import {
  changeIssueDeadline,
  commentHasContentSupport,
  deleteComment,
  findIssueByRepoAndIndex,
  issueApiUrl,
  issueErrorToApiError,
  toApiComment,
  toApiIssue,
  updateCommentBody,
} from "../services/issues";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  ALLOWED_REACTIONS,
  checkIssueSubscription,
  createIssueReaction,
  deleteIssueReaction,
  findRepoComment,
  listIssueSubscribers,
  listPinnedIssues,
  listTargetReactions,
  lockIssue,
  reactionUsers,
  setIssueSubscription,
  unlockIssue,
  usersById,
} from "../services/issue-extras";
import { commentSchema, issueListSchema, issueSchema } from "../models/issue";
import { pullRequestListSchema } from "../models/pull";
import { userListSchema } from "../models/user";
import { watchInfoSchema } from "../models/watch";
import type { WatchInfo } from "../models/watch";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { BLOCKED_USER_MESSAGE, isUserBlockedBy } from "../services/blocks";
import { canWriteRepository } from "../services/repo-access";
import {
  apiRepositoryUrl,
  canViewRepositoryWithTeams,
  findRepositoryByPath,
  findUserByName,
  viewerOf,
} from "../services/repository";
import type { RepositoryWithOwner, UserRow, Viewer } from "../services/repository";
import { findPullRequestByIndex, toApiPullRequest } from "../services/pulls";
import { toApiUser } from "../services/user";

/**
 * Tier-2 issue-family routes (SPEC-0004 appendix A category d rows that ride
 * the ALREADY-MIGRATED issue tables — 0002's reactions / issue_subscriptions /
 * issue_pins plus the issues row's own lock/deadline columns):
 *   - the DEPRECATED nested comment pair `issues/{index}/comments/{id}`
 *     PATCH/DELETE (issueEditCommentDeprecated / issueDeleteCommentDeprecated
 *     — the global `issues/comments/{id}` routes are landed), upstream
 *     routers/api/v1/repo/issue.go;
 *   - the reaction trio on the issue and on the comment (issue_reaction.go);
 *   - the issue subscription family (issue_subscription.go);
 *   - the pinned lists (issue_pin.go ListPinnedIssues / ListPinnedPullRequests);
 *   - the deadline POST (issue.go UpdateIssueDeadline);
 *   - the lock/unlock pair (issue_lock.go).
 *
 * Auth mirrors upstream registration (api.go:1605–1680): reads anonymous-
 * capable on visible repositories; writes reqToken (requireAuth); the lock
 * group's reqAdmin collapses into the landed writer matrix
 * (canWriteRepository — repo owner / site admin / write collaborator).
 * Runtime-only codes the handlers can still emit (undeclared, NOT added to
 * the orchestrator RUNTIME_ONLY_RESPONSES tables by this batch — the landed
 * convention):
 *   - reactions POST/DELETE with a content outside the allowed set → 403
 *     (ErrForbiddenIssueReaction);
 *   - subscription PUT/DELETE for a non-self target without admin → 403
 *     (upstream's own undeclared arm);
 *   - deadline POST with an unparseable due_date → 400 (the
 *     ApplyAPIDeadlineTimestamp quirk routes/issues.ts documents).
 *
 * Divergences: reaction permission collapses CanSelfChangeOrAccessContent to
 * "signed-in + visible" (any reader may react); the CREATE arms run upstream's
 * ErrBlockedUser probe (services/issue/reaction.go:20-21 for the issue,
 * :41-42 for the comment — wired by the blocks-enforcement sweep, 403 "user
 * is blocked" via issue_reaction.go:202/417's ErrBlockedUser unwrap, placed
 * ahead of the allowed-set check like upstream's probe-before-CreateReaction
 * order); the lock reason is accepted
 * and not stored (no lock_reason column — services/issue-extras.ts header);
 * the nested comment pair enforces comment.IssueID == issue.ID (upstream
 * resolves the issue by index first); the archived-repo gate is NOT wired on
 * the nested pair (upstream registers no mustNotBeArchived there either —
 * the landed global comment routes do; a documented asymmetry we mirror).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const emptyResponse = { description: "empty" } as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const issueIndexParams = {
  ...ownerRepoParams,
  index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of the issue" }),
} as const;

const nestedCommentParams = {
  ...issueIndexParams,
  id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the comment" }),
} as const;

const commentIdParams = {
  ...ownerRepoParams,
  id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the comment" }),
} as const;

const pageLimitQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

/** The reaction body (EditReactionOption): content is the emoji short-code. */
const editReactionOptionSchema = z.object({
  content: z.string().optional().openapi({ description: "The reaction content (e.g., emoji or reaction type)" }),
});

const editDeadlineOptionSchema = z.object({
  due_date: z
    .string()
    .nullable()
    .optional()
    .openapi({ format: "date-time", description: "The updated due date; null or empty removes the deadline" }),
});

const lockIssueOptionSchema = z.object({
  lock_reason: z.string().optional().openapi({ description: "An optional reason for locking the issue" }),
});

const reactionSchema = z.object({
  user: z.unknown().nullable().optional(),
  content: z.string().optional(),
  created_at: z.string().optional().openapi({ format: "date-time" }),
});

const reactionListSchema = z.array(reactionSchema);

// ---------------------------------------------------------------------------
// Route declarations
// ---------------------------------------------------------------------------

const editNestedCommentRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/issues/{index}/comments/{id}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Edit a comment (deprecated)",
    description: "Deprecated — the global `issues/comments/{id}` route is the canonical surface.",
    operationId: "issueEditCommentDeprecated",
    request: {
      params: z.object(nestedCommentParams),
      body: { content: { "application/json": { schema: z.object({ body: z.string() }) } } },
    },
    responses: {
      200: { description: "Comment", content: { "application/json": { schema: commentSchema } } },
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const deleteNestedCommentRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}/comments/{id}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Delete a comment (deprecated)",
    description: "Deprecated — the global `issues/comments/{id}` route is the canonical surface.",
    operationId: "issueDeleteCommentDeprecated",
    request: { params: z.object(nestedCommentParams) },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const getIssueReactionsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/{index}/reactions",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "Get a list reactions of an issue",
    operationId: "issueGetIssueReactions",
    request: { params: z.object(issueIndexParams), ...pageLimitQuery },
    responses: {
      200: { description: "ReactionList", content: { "application/json": { schema: reactionListSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const postIssueReactionRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/issues/{index}/reactions",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Add a reaction to an issue",
    operationId: "issuePostIssueReaction",
    request: {
      params: z.object(issueIndexParams),
      body: { required: false, content: { "application/json": { schema: editReactionOptionSchema } } },
    },
    responses: {
      200: { description: "Reaction (already existed)", content: { "application/json": { schema: reactionSchema } } },
      201: { description: "Reaction (created)", content: { "application/json": { schema: reactionSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const deleteIssueReactionRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}/reactions",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Remove a reaction from an issue",
    operationId: "issueDeleteIssueReaction",
    request: {
      params: z.object(issueIndexParams),
      body: { required: false, content: { "application/json": { schema: editReactionOptionSchema } } },
    },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const getCommentReactionsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/comments/{id}/reactions",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "Get a list of reactions from a comment of an issue",
    operationId: "issueGetCommentReactions",
    request: { params: z.object(commentIdParams), ...pageLimitQuery },
    responses: {
      200: { description: "ReactionList", content: { "application/json": { schema: reactionListSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const postCommentReactionRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/issues/comments/{id}/reactions",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Add a reaction to a comment of an issue",
    operationId: "issuePostCommentReaction",
    request: {
      params: z.object(commentIdParams),
      body: { required: false, content: { "application/json": { schema: editReactionOptionSchema } } },
    },
    responses: {
      200: { description: "Reaction (already existed)", content: { "application/json": { schema: reactionSchema } } },
      201: { description: "Reaction (created)", content: { "application/json": { schema: reactionSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const deleteCommentReactionRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/comments/{id}/reactions",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Remove a reaction from a comment of an issue",
    operationId: "issueDeleteCommentReaction",
    request: {
      params: z.object(commentIdParams),
      body: { required: false, content: { "application/json": { schema: editReactionOptionSchema } } },
    },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const issueSubscriptionsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/{index}/subscriptions",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "Get users who subscribed on an issue",
    operationId: "issueSubscriptions",
    request: { params: z.object(issueIndexParams), ...pageLimitQuery },
    responses: {
      200: { description: "UserList", content: { "application/json": { schema: userListSchema } } },
      404: notFoundResponse,
    },
  });

const issueCheckSubscriptionRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/{index}/subscriptions/check",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Check if user is subscribed to an issue",
    operationId: "issueCheckSubscription",
    request: { params: z.object(issueIndexParams) },
    responses: {
      200: { description: "WatchInfo", content: { "application/json": { schema: watchInfoSchema } } },
      404: notFoundResponse,
    },
  });

const issueAddSubscriptionRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/repos/{owner}/{repo}/issues/{index}/subscriptions/{user}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Add user to issue subscribers",
    operationId: "issueAddSubscription",
    request: {
      params: z.object({
        ...issueIndexParams,
        user: z.string().min(1).openapi({ description: "user to subscribe" }),
      }),
    },
    responses: {
      200: emptyResponse,
      201: emptyResponse,
      304: emptyResponse,
      404: notFoundResponse,
    },
  });

const issueDeleteSubscriptionRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}/subscriptions/{user}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Remove user from issue subscribers",
    operationId: "issueDeleteSubscription",
    request: {
      params: z.object({
        ...issueIndexParams,
        user: z.string().min(1).openapi({ description: "user to unsubscribe" }),
      }),
    },
    responses: {
      200: emptyResponse,
      201: emptyResponse,
      304: emptyResponse,
      404: notFoundResponse,
    },
  });

const listPinnedIssuesRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/pinned",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "List a repo's pinned issues",
    operationId: "repoListPinnedIssues",
    request: { params: z.object(ownerRepoParams) },
    responses: {
      200: { description: "IssueList", content: { "application/json": { schema: issueListSchema } } },
      404: notFoundResponse,
    },
  });

const listPinnedPullsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/pulls/pinned",
    middleware: [optionalAuth],
    tags: ["pull"],
    summary: "List a repo's pinned pull requests",
    operationId: "repoListPinnedPullRequests",
    request: { params: z.object(ownerRepoParams) },
    responses: {
      200: { description: "PullRequestList", content: { "application/json": { schema: pullRequestListSchema } } },
      404: notFoundResponse,
    },
  });

const editDeadlineRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/issues/{index}/deadline",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Set an issue deadline. If set to null, the deadline is deleted.",
    operationId: "issueEditIssueDeadline",
    request: {
      params: z.object(issueIndexParams),
      body: { required: false, content: { "application/json": { schema: editDeadlineOptionSchema } } },
    },
    responses: {
      201: { description: "Issue", content: { "application/json": { schema: issueSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const lockIssueRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/repos/{owner}/{repo}/issues/{index}/lock",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Lock an issue",
    operationId: "issueLockIssue",
    request: {
      params: z.object(issueIndexParams),
      body: { required: false, content: { "application/json": { schema: lockIssueOptionSchema } } },
    },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const unlockIssueRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}/lock",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Unlock an issue",
    operationId: "issueUnlockIssue",
    request: { params: z.object(issueIndexParams) },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

// ---------------------------------------------------------------------------
// Shared guards + plumbing
// ---------------------------------------------------------------------------

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
function pathId(raw: string): number {
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Repo resolution + visibility — the anti-enumeration 404. */
async function requireVisibleRepoPair(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
    throw new ApiError(404, "not found");
  }
  return { viewer, found };
}

/** Issue-by-index lookup answering the upstream ErrIssueNotExist 404. */
async function requireIssue(c: Context<ApiEnv>, found: RepositoryWithOwner, rawIndex: string): Promise<IssueRow> {
  const index = pathId(rawIndex);
  const issue = await findIssueByRepoAndIndex(c.env.DB, found.repo.id, index);
  if (issue === null) {
    throw issueErrorToApiError(new IssueNotExistError({ repoId: found.repo.id, index }));
  }
  return issue;
}

/** The signed-in doer id (requireAuth guarantees the identity; the id-less
 *  corner is the silent-auth-failure 401). */
function requireDoerId(c: Context<ApiEnv>): number {
  const id = c.get("authUser")?.id;
  if (id === undefined) {
    throw new ApiError(401, "token is required");
  }
  return id;
}

/** The reaction content from the (optional) body — absent → "", never in the
 *  allowed set → the 403. */
function reactionContent(form: { content?: string } | undefined): string {
  return form?.content ?? "";
}

/** The Reaction render: the acting user projection (missing rows render the
 *  null halo — upstream's deleted-user arm), content, created_at. */
function toApiReaction(row: { userId: number; type: string; createdAt: Date | null }, byId: Map<number, UserRow>, viewer: Viewer) {
  const user = byId.get(row.userId);
  return {
    user: user === undefined ? null : toApiUser(viewer, user),
    content: row.type,
    created_at: row.createdAt === null ? undefined : row.createdAt.toISOString(),
  };
}

/** One page slice of a reaction list (page/limit from parseListOptions). */
function pageSlice<T>(rows: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

export function registerIssueT2Routes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // The deprecated nested comment pair — the landed global semantics plus the
  // comment-belongs-to-this-issue check (upstream resolves the issue by index
  // first; a comment from a sibling issue answers the 404).
  // -------------------------------------------------------------------------
  app.openapi(editNestedCommentRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const commentId = pathId(c.req.valid("param").id);
    const row = await findRepoComment(c.env.DB, found.repo.id, commentId);
    if (row === null || row.issue.id !== issue.id) {
      throw issueErrorToApiError(new IssueNotExistError({ repoId: found.repo.id, index: issue.index }));
    }
    const doer = c.get("authUser");
    const isPoster = row.comment.posterId !== null && doer?.id === row.comment.posterId;
    if (!isPoster && !(await canWriteRepository(c, found))) {
      // Upstream EditIssueCommentDeprecated: bare Status(403), empty message.
      throw new ApiError(403, "");
    }
    if (!commentHasContentSupport(row.comment.type)) {
      // Upstream editIssueComment: unsupported types answer the empty 204.
      return c.body(null, 204);
    }
    const form = c.req.valid("json");
    if (form.body !== (row.comment.content ?? "")) {
      await updateCommentBody(c.env.DB, row.comment.id, form.body, new Date());
      row.comment = { ...row.comment, content: form.body };
    }
    return c.json(await toApiComment(c.env.DB, viewer, found, row.issue, row.comment), 200);
  });

  app.openapi(deleteNestedCommentRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const commentId = pathId(c.req.valid("param").id);
    const row = await findRepoComment(c.env.DB, found.repo.id, commentId);
    if (row === null || row.issue.id !== issue.id) {
      throw issueErrorToApiError(new IssueNotExistError({ repoId: found.repo.id, index: issue.index }));
    }
    const doer = c.get("authUser");
    const isPoster = row.comment.posterId !== null && doer?.id === row.comment.posterId;
    if (!isPoster && !(await canWriteRepository(c, found))) {
      throw new ApiError(403, "");
    }
    if (!commentHasContentSupport(row.comment.type)) {
      // Upstream deleteIssueComment answers StatusBadRequest (undeclared).
      throw new ApiError(400, "comment type does not support content");
    }
    await deleteComment(c.env.DB, row.comment, new Date());
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // Reactions on the issue.
  // -------------------------------------------------------------------------
  app.openapi(getIssueReactionsRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const listOptions = parseListOptions(new URL(c.req.url));
    const rows = await listTargetReactions(c.env.DB, issue.id, 0);
    setPaginationHeaders(c, rows.length, listOptions);
    const byId = usersById(await reactionUsers(c.env.DB, rows));
    return c.json(pageSlice(rows, listOptions.page, listOptions.limit).map((row) => toApiReaction(row, byId, viewer)), 200);
  });

  app.openapi(postIssueReactionRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    // CreateIssueReaction's blocked set (services/issue/reaction.go:20-21):
    // the issue poster + the repo owner.
    const { status, body } = await reactionChange(c, issue, 0, c.req.valid("json"), [
      issue.posterId ?? null,
      found.repo.ownerId,
    ]);
    return c.json(body, status);
  });

  app.openapi(deleteIssueReactionRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const content = reactionContent(c.req.valid("json"));
    if (!ALLOWED_REACTIONS.has(content)) {
      throw new ApiError(403, "no permission to change reaction");
    }
    await deleteIssueReaction(c.env.DB, { userId: requireDoerId(c), issueId: issue.id, commentId: 0, type: content });
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // Reactions on the comment (the comment must belong to THIS repo —
  // GetCommentWithRepoID).
  // -------------------------------------------------------------------------
  app.openapi(getCommentReactionsRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const commentId = pathId(c.req.valid("param").id);
    const row = await findRepoComment(c.env.DB, found.repo.id, commentId);
    if (row === null) {
      throw new ApiError(404, "not found");
    }
    const listOptions = parseListOptions(new URL(c.req.url));
    const rows = await listTargetReactions(c.env.DB, row.issue.id, row.comment.id);
    setPaginationHeaders(c, rows.length, listOptions);
    const byId = usersById(await reactionUsers(c.env.DB, rows));
    return c.json(pageSlice(rows, listOptions.page, listOptions.limit).map((entry) => toApiReaction(entry, byId, viewer)), 200);
  });

  app.openapi(postCommentReactionRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const commentId = pathId(c.req.valid("param").id);
    const row = await findRepoComment(c.env.DB, found.repo.id, commentId);
    if (row === null) {
      throw new ApiError(404, "not found");
    }
    // CreateCommentReaction's blocked set (services/issue/reaction.go:41-42):
    // the issue poster + the repo owner + the COMMENT poster.
    const { status, body } = await reactionChange(c, row.issue, row.comment.id, c.req.valid("json"), [
      row.issue.posterId ?? null,
      found.repo.ownerId,
      row.comment.posterId ?? null,
    ]);
    return c.json(body, status);
  });

  app.openapi(deleteCommentReactionRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const commentId = pathId(c.req.valid("param").id);
    const row = await findRepoComment(c.env.DB, found.repo.id, commentId);
    if (row === null) {
      throw new ApiError(404, "not found");
    }
    const content = reactionContent(c.req.valid("json"));
    if (!ALLOWED_REACTIONS.has(content)) {
      throw new ApiError(403, "no permission to change reaction");
    }
    await deleteIssueReaction(c.env.DB, {
      userId: requireDoerId(c),
      issueId: row.issue.id,
      commentId: row.comment.id,
      type: content,
    });
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // Subscriptions.
  // -------------------------------------------------------------------------
  app.openapi(issueSubscriptionsRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const listOptions = parseListOptions(new URL(c.req.url));
    const rows = await listIssueSubscribers(c.env.DB, issue.id);
    setPaginationHeaders(c, rows.length, listOptions);
    return c.json(pageSlice(rows, listOptions.page, listOptions.limit).map((row) => toApiUser(viewer, row)), 200);
  });

  app.openapi(issueCheckSubscriptionRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const watching = await checkIssueSubscription(c.env.DB, requireDoerId(c), issue);
    const origin = new URL(c.req.url).origin;
    const info: WatchInfo = {
      subscribed: watching,
      ignored: !watching,
      reason: null,
      created_at: issue.createdAt === null ? undefined : issue.createdAt.toISOString(),
      url: `${issueApiUrl(found, origin, issue.index)}/subscriptions`,
      repository_url: apiRepositoryUrl(found, origin),
    };
    return c.json(info, 200);
  });

  // PUT/DELETE …/subscriptions/{user} — setIssueSubscription(ctx, watch):
  // target miss → 404; only the target user themself (or a site admin) may
  // change the row (otherwise → the runtime-only 403); unchanged → 200,
  // changed → 201. The declared 304 stays unserved (upstream's legacy arm).
  app.openapi(issueAddSubscriptionRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const { user: username } = c.req.valid("param");
    const target = await subscriptionTarget(c, username);
    const current = await checkIssueSubscription(c.env.DB, target.id, issue);
    if (current === true) {
      return c.body(null, 200);
    }
    await setIssueSubscription(c.env.DB, { userId: target.id, issueId: issue.id, watching: true }, new Date());
    return c.body(null, 201);
  });

  app.openapi(issueDeleteSubscriptionRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const { user: username } = c.req.valid("param");
    const target = await subscriptionTarget(c, username);
    const current = await checkIssueSubscription(c.env.DB, target.id, issue);
    if (current === false) {
      return c.body(null, 200);
    }
    await setIssueSubscription(c.env.DB, { userId: target.id, issueId: issue.id, watching: false }, new Date());
    return c.body(null, 201);
  });

  // -------------------------------------------------------------------------
  // Pinned lists — the pin rows split by is_pull, pin_order ASC.
  // -------------------------------------------------------------------------
  app.openapi(listPinnedIssuesRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const rows = await listPinnedIssues(c.env.DB, found.repo.id, false);
    const rendered = [];
    for (const issue of rows) {
      rendered.push(await toApiIssue(c.env.DB, viewer, found, issue));
    }
    return c.json(rendered, 200);
  });

  app.openapi(listPinnedPullsRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const rows = await listPinnedIssues(c.env.DB, found.repo.id, true);
    const rendered = [];
    for (const issue of rows) {
      const pair = await findPullRequestByIndex(c.env.DB, found.repo.id, issue.index);
      if (pair === null) {
        continue;
      }
      rendered.push(await toApiPullRequest(c.env.DB, viewer, found, issue, pair.pullRequest, "list"));
    }
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // Deadline (UpdateIssueDeadline): writer-only 403 "Not repo writer"; the
  // null/absent due_date clears; the change rides changeIssueDeadline's
  // system-comment batch; the re-read serves the 201 body.
  // -------------------------------------------------------------------------
  app.openapi(editDeadlineRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    if (!(await canWriteRepository(c, found))) {
      throw new ApiError(403, "Not repo writer");
    }
    const form = c.req.valid("json");
    let deadline: Date | null;
    if (form.due_date === null || form.due_date === undefined || form.due_date === "") {
      deadline = null;
    } else {
      const parsed = new Date(form.due_date);
      if (Number.isNaN(parsed.getTime())) {
        // Upstream ApplyAPIDeadlineTimestamp: "invalid date format: X" — the
        // undeclared 400 (routes/issues.ts documents the same quirk).
        throw new ApiError(400, `invalid date format: ${form.due_date}`);
      }
      deadline = parsed;
    }
    const previous = issue.deadlineAt ?? null;
    if (deadline?.getTime() !== previous?.getTime()) {
      await changeIssueDeadline(c.env.DB, issue, deadline, previous, requireDoerId(c), new Date());
    }
    const updated = await findIssueByRepoAndIndex(c.env.DB, found.repo.id, issue.index);
    return c.json(await toApiIssue(c.env.DB, viewer, found, updated ?? issue), 201);
  });

  // -------------------------------------------------------------------------
  // Lock / unlock (issue_lock.go): the writer gate carries the upstream
  // messages; already-(un)locked is the silent no-op; the reason is accepted
  // and not stored (no column — the module header).
  // -------------------------------------------------------------------------
  app.openapi(lockIssueRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    if (!(await canWriteRepository(c, found))) {
      throw new ApiError(403, "no permission to lock this issue");
    }
    if (!issue.isLocked) {
      await lockIssue(c.env.DB, issue.id, requireDoerId(c), new Date());
    }
    return c.body(null, 204);
  });

  app.openapi(unlockIssueRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    if (!(await canWriteRepository(c, found))) {
      throw new ApiError(403, "no permission to unlock this issue");
    }
    if (issue.isLocked) {
      await unlockIssue(c.env.DB, issue.id, requireDoerId(c), new Date());
    }
    return c.body(null, 204);
  });
}

/** The subscription target user (upstream GetUserByName → 404 miss) with the
 *  self-or-admin gate on the caller (the runtime-only 403 arm). */
async function subscriptionTarget(c: Context<ApiEnv>, username: string): Promise<UserRow> {
  const target = await findUserByName(c.env.DB, username);
  if (target === null) {
    throw new ApiError(404, "not found");
  }
  const doer = c.get("authUser");
  if (doer?.id !== target.id && doer?.is_admin !== true) {
    throw new ApiError(403, `${doer?.login ?? "caller"} is not permitted to change subscriptions for ${username}`);
  }
  return target;
}

/** POST semantics: 201 created / 200 already-exists, both with the Reaction
 *  body rendered from the DOER (upstream renders ctx.Doer directly).
 *  `blockedByIds` is the CreateIssueReaction/CreateCommentReaction blocked
 *  set (services/issue/reaction.go:20-21, 41-42): a doer blocked by any of
 *  them answers ErrBlockedUser — changeIssueReaction/PostIssueReaction's
 *  `errors.Is(err, user_model.ErrBlockedUser)` unwrap answers 403 "user is
 *  blocked" (issue_reaction.go:202, 417). Upstream's probe runs BEFORE
 *  CreateReaction's invalid-content check, so it precedes the allowed-set
 *  403 here; the isUserBlockedBy site-admin short-circuit is upstream's
 *  `blockee.IsAdmin`. The DELETE arms carry no upstream probe (the blocked
 *  check lives in the create services only). */
async function reactionChange(
  c: Context<ApiEnv>,
  issue: IssueRow,
  commentId: number,
  form: { content?: string },
  blockedByIds: Array<number | null>,
): Promise<{ status: 200 | 201; body: { user: unknown; content: string; created_at: string } }> {
  const doer = c.get("authUser");
  const blockedBy = blockedByIds.filter((id): id is number => id !== null && id !== doer?.id);
  if (await isUserBlockedBy(c.env.DB, { id: requireDoerId(c), isAdmin: doer?.is_admin === true }, ...blockedBy)) {
    throw new ApiError(403, BLOCKED_USER_MESSAGE);
  }
  const content = reactionContent(form);
  if (!ALLOWED_REACTIONS.has(content)) {
    throw new ApiError(403, "no permission to change reaction");
  }
  const userId = requireDoerId(c);
  const change = await createIssueReaction(c.env.DB, { userId, issueId: issue.id, commentId, type: content }, new Date());
  return {
    status: change === "created" ? 201 : 200,
    body: {
      user: c.get("authUser") ?? null,
      content,
      created_at: new Date().toISOString(),
    },
  };
}

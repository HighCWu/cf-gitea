import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { issues, pullRequests } from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import { IssueError, IssueNotExistError, MilestoneNotExistError } from "../../issues/errors";
import { IssuesService, type IssueRow, type PullRequestRow } from "../../issues/service";
import type { HookEventType } from "../../issues/webhooks";
import { emitIssueEvent, issueEventIdentity, issueEventPayload, type IssueEventIdentity } from "../../services/issue-events";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  commentListSchema,
  commentSchema,
  createIssueCommentOptionSchema,
  createIssueOptionSchema,
  editIssueCommentOptionSchema,
  editIssueOptionSchema,
  issueLabelsOptionSchema,
  issueListSchema,
  issueSchema,
  timelineCommentListSchema,
  type Issue,
  type TimelineComment,
} from "../models/issue";
import { issueLabelSchema } from "../models/issue";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { toApiLabel } from "../services/labels";
import {
  changeIssueBody,
  changeIssueDeadline,
  changeIssueMilestone,
  changeIssueRef,
  changeIssueTitle,
  commentHasContentSupport,
  commentNotExistError,
  deleteComment,
  deleteIssueCascade,
  findIssueByRepoAndIndex,
  findRepoCommentById,
  issueErrorToApiError,
  issueLabelRows,
  labelIdsByGlobalNames,
  labelIdsByRepoNames,
  listIssueComments,
  listIssueTimeline,
  listRepoComments,
  listRepoIssues,
  milestoneIdsByGlobalNames,
  milestoneIdsByRepoEntries,
  parseQueryTime,
  parseStateFilter,
  parseTypeFilter,
  searchIssuesGlobally,
  toApiComment,
  toApiIssue,
  toTimelineComment,
  updateCommentBody,
  userIdForFilter,
  userNotExistError,
  userRowByName,
  visibleRepoIds,
} from "../services/issues";
import { parseMilestoneDeadline } from "../services/milestones";
import { toApiPullRequest } from "../services/pulls";
import {
  apiRepositoryUrl,
  canViewRepository,
  findRepositoryById,
  findRepositoryByPath,
  repositoryPermissions,
  viewerOf,
  type RepositoryWithOwner,
} from "../services/repository";

/**
 * Tier-1 `issue`-tagged issue-block routes (SPEC-0004 §2.4 rows:
 * issueListIssues / issueCreateIssue / issueGetIssue / issueEditIssue /
 * issueDelete / issueGetRepoComments / issueGetComment / issueEditComment /
 * issueDeleteComment / issueGetComments / issueCreateComment / issueGetLabels /
 * issueAddLabel / issueReplaceLabels / issueClearLabels /
 * issueGetCommentsAndTimeline / issueSearchIssues — 9 paths, 17 operations;
 * behavior per SPEC-0005 §2.2).
 *
 * Auth: reads are anonymous-capable on public repos (upstream `repoAssignment`
 * only); writes require a token (`reqToken` — SPEC-0002 write:issue); DELETE
 * issue additionally carries upstream `reqAdmin`, whose ACL matrix lands with
 * SPEC-0002 — requireAuth stands in (the hooks-routes convention). Repo
 * resolution follows the anti-enumeration rule (missing/invisible → the same
 * 404 "not found"); a wrong issue index answers the upstream
 * ErrIssueNotExist message (`issue does not exist [id: 0, …]`) and a wrong
 * comment id the ErrCommentNotExist one.
 *
 * Declared responses mirror the vendored contract exactly. RUNTIME-ONLY codes
 * the handlers can still emit (undeclared; the orchestrator-owned
 * RUNTIME_ONLY_RESPONSES tables in suite.ts / check-openapi.mjs are not
 * extended by this batch):
 *   - POST issues:                  400 (invalid due_date format — upstream
 *                                   ApplyAPIDeadlineTimestamp "invalid date
 *                                   format: X"; undeclared in the contract)
 *   - PATCH issues/{index}:         409 (stale content_version CAS — upstream
 *                                   EditIssue → StatusConflict "the issue is
 *                                   already changed"), 400 (invalid due_date;
 *                                   Go bind would 422)
 *   - POST …/comments, POST/PUT …/labels: 400 (Go-bind / mixed id+name array
 *                                   equivalents — upstream 422/400 undeclared)
 *   - PATCH …/comments/{id}:        204-family edit of a system comment
 *                                   (upstream returns empty 204)
 *   - DELETE …/comments/{id}:       400 (system comments have no deletable
 *                                   content — upstream StatusBadRequest)
 * The 412 issues-disabled family is DECLARED (per contract) but unreachable
 * today: every D1 repository has the issues unit enabled (no has_issues
 * column yet — the Repository converter hardcodes has_issues: true).
 *
 * Webhook triggers (SPEC-0005 §3.5): issues opened (POST) / edited (title,
 * body) / closed+reopened (PATCH state) and the comment family (POST
 * comments → issue_comment / pull_request_comment created; PATCH+DELETE
 * …/comments/{id} → edited with `changes.body.from` / deleted with no
 * `changes` — upstream UpdateComment:420-461 / DeleteComment:493-541), through
 * the SHARED issue-family seam emitIssueEvent
 * (src/services/issue-events.ts) — the same fan-out the UI new-issue write
 * path runs (issueEventIdentity below is that module's identity assembly).
 * The label family (POST/PUT/DELETE …/labels) emits `issue_label` /
 * `pull_request_label` through the same seam — see emitLabelEvent (the
 * `issue.IsPull` discriminant picks the event type, per upstream
 * services/webhook/notifier.go IssueChangeLabels:572 / IssueClearLabels:46).
 * The PATCH milestone change emits `issue_milestone` / `pull_request_milestone`
 * the same way — emitMilestoneEvent (IssueChangeMilestone:618-647; action
 * milestoned/demilestoned, no `changes` block).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const repoArchivedResponse = {
  description: "repoArchivedError",
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

/** Global comment id (separate id space from the per-repo issue index). */
const commentIdParams = {
  ...ownerRepoParams,
  id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the comment" }),
} as const;

const pageLimitQuery = {
  page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
  limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
} as const;

const rfc3339Query = (description: string) =>
  z.string().optional().openapi({ format: "date-time", description });

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
function pathId(raw: string): number {
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Body bind hook for the one operation with a declared 422 (POST issues):
 *  upstream's Go bind answers malformed/invalid bodies with 422
 *  (bind → APIErrorValidation); the generic text stands in for Go's
 *  per-field message. The operations without a declared 422 keep hono's
 *  default 400 (documented in the file header). */
const createIssueBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** Tri-state pointer rule: absent and JSON-null both mean "unchanged". */
function patchField<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

/** Data-layer typed errors → ApiError with the pinned status/message. */
function asApiError(error: unknown): never | undefined {
  if (error instanceof IssueError) {
    throw issueErrorToApiError(error);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/** Shared repo resolution — the anti-enumeration 404 (SPEC-0004 §2.4). */
async function requireVisibleRepo(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !canViewRepository(viewer, found.repo)) {
    throw new ApiError(404, "not found");
  }
  return { viewer, found };
}

/** `mustNotBeArchived` (routers/api/v1/api.go:816) — 423 with that message. */
function assertNotArchived(found: RepositoryWithOwner): void {
  if (found.repo.isArchived) {
    throw new ApiError(423, "repo is archived");
  }
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

/** Poster-or-writer rule of EditIssue/EditIssueComment (CanWriteIssuesOrPulls
 *  reduced to the landed permission matrix: poster, repo owner, or admin). */
function canEditIssue(c: Context<ApiEnv>, found: RepositoryWithOwner, posterId: number | null): boolean {
  const requester = c.get("authUser");
  if (requester === undefined) {
    return false;
  }
  if (posterId !== null && requester.id === posterId) {
    return true;
  }
  const permissions = repositoryPermissions(viewerOf(c), found.repo);
  return permissions.admin === true || permissions.push === true;
}

// ---------------------------------------------------------------------------
// Webhook triggers (SPEC-0005 §3.5) — the delivery mechanics live in the
// SHARED issue-family seam (src/services/issue-events.ts, moved here verbatim
// so the UI new-issue write path fans out identically); this module keeps
// only the API-request identity assembly.
// ---------------------------------------------------------------------------

/** Issue-event bundle: the webhook `repository` object + doer sender. */
function issueEventContext(c: Context<ApiEnv>, found: RepositoryWithOwner): IssueEventIdentity {
  return issueEventIdentity(viewerOf(c), found, c.get("authUser"));
}

/** The single PR row of an issue (upstream `issue.LoadPullRequest`). */
async function findPullRequestRowByIssueId(d1: D1Database, issueId: number): Promise<PullRequestRow | null> {
  const rows = await drizzle(d1).select().from(pullRequests).where(eq(pullRequests.issueId, issueId)).limit(1).all();
  return rows[0] ?? null;
}

/** The shared PullRequestPayload wrapper for the label/milestone events — the
 *  same field set the landed pulls.ts emissions use (§2.7, hook.go:484 minus
 *  the null-only `requested_reviewer`/`review` fields, before/after omitted;
 *  `changes` only when the notifier sets one). */
function pullRequestEventPayload(
  action: string,
  apiPullRequest: Awaited<ReturnType<typeof toApiPullRequest>>,
  index: number,
  repository: unknown,
  sender: unknown,
  options: { changes?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    action,
    number: index,
    ...(options.changes === undefined ? {} : { changes: options.changes }),
    pull_request: apiPullRequest,
    repository,
    sender,
    commit_id: "",
  };
}

/**
 * The comment edit/delete webhook: `issue_comment` / `pull_request_comment`
 * picked by the upstream `issue.IsPull` discriminant (services/webhook/
 * notifier.go UpdateComment:420-461 — action=edited with
 * `changes.body.from` = the pre-edit content; DeleteComment:493-541 —
 * action=deleted with NO `changes` block; CreateIssueComment:463-489 already
 * emits from the POST route inline). The payload is the created emission's
 * shape (§2.7 IssueCommentPayload, hook.go:297-314, minus the nullable
 * `pull_request` field that emission already omits — documented deviation);
 * `changes` renders upstream's `ChangesPayload.body` minimally, the landed
 * issue title/body emissions' convention (the Go struct's non-omitempty
 * `added_labels`/`removed_labels` nil-slice nulls are not copied).
 */
async function emitCommentEvent(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  issue: IssueRow,
  comment: Awaited<ReturnType<typeof toApiComment>>,
  action: "edited" | "deleted",
  options: { changes?: Record<string, { from: string }> } = {},
): Promise<void> {
  const event = issueEventContext(c, found);
  await emitIssueEvent(c, {
    repoId: found.repo.id,
    ownerId: event.ownerId,
    eventType: issue.isPull ? "pull_request_comment" : "issue_comment",
    payload: {
      action,
      issue: await toApiIssue(c.env.DB, viewerOf(c), found, issue),
      comment,
      ...(options.changes === undefined ? {} : { changes: options.changes }),
      repository: event.repository,
      sender: event.sender,
      is_pull: issue.isPull,
    },
  });
}

/**
 * The label attach/replace/clear webhook: `issue_label` / `pull_request_label`
 * picked by the upstream `issue.IsPull` discriminant (services/webhook/
 * notifier.go IssueChangeLabels:572-605 and IssueClearLabels:46-73). The
 * payload is the shared Issue/PullRequest wrapper with NO `changes` block —
 * upstream's label notifiers set none. The pull arm renders upstream's
 * ToPayloadPullRequest through toApiPullRequest; a missing PR row skips the
 * emission (upstream's LoadPullRequest failure logs and returns before
 * PrepareWebhooks).
 */
async function emitLabelEvent(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  issue: IssueRow,
  action: "label_updated" | "label_cleared",
): Promise<void> {
  const event = issueEventContext(c, found);
  if (issue.isPull) {
    const pr = await findPullRequestRowByIssueId(c.env.DB, issue.id);
    if (pr === null) {
      return;
    }
    await emitIssueEvent(c, {
      repoId: found.repo.id,
      ownerId: event.ownerId,
      eventType: "pull_request_label",
      payload: pullRequestEventPayload(
        action,
        await toApiPullRequest(c.env.DB, viewerOf(c), found, issue, pr, "single"),
        issue.index,
        event.repository,
        event.sender,
      ),
    });
    return;
  }
  await emitIssueEvent(c, {
    repoId: found.repo.id,
    ownerId: event.ownerId,
    eventType: "issue_label",
    payload: issueEventPayload(action, await toApiIssue(c.env.DB, viewerOf(c), found, issue), issue.index, event.repository, event.sender),
  });
}

/**
 * The milestone set/clear webhook: `issue_milestone` / `pull_request_milestone`
 * picked by the upstream `issue.IsPull` discriminant (services/webhook/
 * notifier.go IssueChangeMilestone:618-647). action=milestoned when the issue
 * now carries a milestone, demilestoned on the clear (structs/hook.go:422-425
 * — NOT entered/exited); the payload is the shared Issue/PullRequest wrapper
 * with NO `changes` block — upstream's milestone notifier sets none. The pull
 * arm renders ToPayloadPullRequest through toApiPullRequest; a missing PR row
 * skips the emission (the label events' LoadPullRequest degradation).
 */
async function emitMilestoneEvent(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  issue: IssueRow,
  action: "milestoned" | "demilestoned",
): Promise<void> {
  const event = issueEventContext(c, found);
  if (issue.isPull) {
    const pr = await findPullRequestRowByIssueId(c.env.DB, issue.id);
    if (pr === null) {
      return;
    }
    await emitIssueEvent(c, {
      repoId: found.repo.id,
      ownerId: event.ownerId,
      eventType: "pull_request_milestone",
      payload: pullRequestEventPayload(
        action,
        await toApiPullRequest(c.env.DB, viewerOf(c), found, issue, pr, "single"),
        issue.index,
        event.repository,
        event.sender,
      ),
    });
    return;
  }
  await emitIssueEvent(c, {
    repoId: found.repo.id,
    ownerId: event.ownerId,
    eventType: "issue_milestone",
    payload: issueEventPayload(action, await toApiIssue(c.env.DB, viewerOf(c), found, issue), issue.index, event.repository, event.sender),
  });
}

/** `IssueLabelsOption` id/name resolution (prepareForReplaceOrAdd): integers
 *  are ids, strings are names; a mixed array is the runtime 400, unknown
 *  names silently drop (GetLabelIDsInRepoByNames). */
async function resolveLabelOptionIds(
  d1: D1Database,
  repoId: string,
  entries: Array<number | string> | undefined,
): Promise<number[]> {
  if (entries === undefined) {
    return [];
  }
  const ids: number[] = [];
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "number") {
      ids.push(entry);
    } else {
      names.push(entry);
    }
  }
  if (ids.length > 0 && names.length > 0) {
    throw new ApiError(400, "labels should be an array of strings or integers");
  }
  if (names.length > 0) {
    ids.push(...(await labelIdsByRepoNames(d1, repoId, names)));
  }
  return ids;
}

/** `q`/`labels`/`milestones` comma-split form parsing. */
function csvParam(params: URLSearchParams, name: string): string[] {
  const raw = params.get(name)?.trim() ?? "";
  if (raw === "") return [];
  return raw.split(",");
}

// ---------------------------------------------------------------------------
// Route declarations — response sets mirror the vendored contract per operation.
// ---------------------------------------------------------------------------

const listIssuesRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "List a repository's issues",
    operationId: "issueListIssues",
    request: {
      params: z.object(ownerRepoParams),
      query: z.object({
        state: z.string().optional().openapi({ description: "whether issue is open or closed" }),
        labels: z
          .string()
          .optional()
          .openapi({
            description:
              "comma separated list of label names. Fetch only issues that have any of this label names. Non existent labels are discarded.",
          }),
        q: z.string().optional().openapi({ description: "search string" }),
        type: z.string().optional().openapi({ description: "filter by type (issues / pulls) if set" }),
        milestones: z
          .string()
          .optional()
          .openapi({
            description:
              "comma separated list of milestone names or ids. It uses names and fall back to ids. Fetch only issues that have any of this milestones. Non existent milestones are discarded",
          }),
        since: rfc3339Query("Only show items updated after the given time. This is a timestamp in RFC 3339 format"),
        before: rfc3339Query("Only show items updated before the given time. This is a timestamp in RFC 3339 format"),
        created_by: z.string().optional().openapi({ description: "Only show items which were created by the given user" }),
        assigned_by: z.string().optional().openapi({ description: "Only show items for which the given user is assigned" }),
        mentioned_by: z.string().optional().openapi({ description: "Only show items in which the given user was mentioned" }),
        page: pageLimitQuery.page,
        limit: pageLimitQuery.limit,
      }),
    },
    responses: {
      200: { description: "IssueList", content: { "application/json": { schema: issueListSchema } } },
      404: notFoundResponse,
    },
  });

const createIssueRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/issues",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Create an issue. If using deadline only the date will be taken into account, and time of day ignored.",
    operationId: "issueCreateIssue",
    request: {
      params: z.object(ownerRepoParams),
      body: { content: { "application/json": { schema: createIssueOptionSchema } } },
    },
    responses: {
      201: { description: "Issue", content: { "application/json": { schema: issueSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      412: errorResponse,
      422: validationErrorResponse,
      423: repoArchivedResponse,
    },
  });

const getIssueRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/{index}",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "Get an issue",
    operationId: "issueGetIssue",
    request: { params: z.object(issueIndexParams) },
    responses: {
      200: { description: "Issue", content: { "application/json": { schema: issueSchema } } },
      404: notFoundResponse,
    },
  });

const editIssueRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/issues/{index}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Edit an issue. If using deadline only the date will be taken into account, and time of day ignored.",
    operationId: "issueEditIssue",
    request: {
      params: z.object(issueIndexParams),
      body: { content: { "application/json": { schema: editIssueOptionSchema } } },
    },
    responses: {
      201: { description: "Issue", content: { "application/json": { schema: issueSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      412: errorResponse,
      423: repoArchivedResponse,
    },
  });

const deleteIssueRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Delete an issue",
    operationId: "issueDelete",
    request: { params: z.object(issueIndexParams) },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      423: repoArchivedResponse,
    },
  });

const listRepoCommentsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/comments",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "List all comments in a repository",
    operationId: "issueGetRepoComments",
    request: {
      params: z.object(ownerRepoParams),
      query: z.object({
        since: rfc3339Query("if provided, only comments updated since the provided time are returned."),
        before: rfc3339Query("if provided, only comments updated before the provided time are returned."),
        page: pageLimitQuery.page,
        limit: pageLimitQuery.limit,
      }),
    },
    responses: {
      200: { description: "CommentList", content: { "application/json": { schema: commentListSchema } } },
      404: notFoundResponse,
    },
  });

const getCommentRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/comments/{id}",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "Get a comment",
    operationId: "issueGetComment",
    request: { params: z.object(commentIdParams) },
    responses: {
      200: { description: "Comment", content: { "application/json": { schema: commentSchema } } },
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const editCommentRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/issues/comments/{id}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Edit a comment",
    operationId: "issueEditComment",
    request: {
      params: z.object(commentIdParams),
      body: { content: { "application/json": { schema: editIssueCommentOptionSchema } } },
    },
    responses: {
      200: { description: "Comment", content: { "application/json": { schema: commentSchema } } },
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      423: repoArchivedResponse,
    },
  });

const deleteCommentRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/comments/{id}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Delete a comment",
    operationId: "issueDeleteComment",
    request: { params: z.object(commentIdParams) },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const listIssueCommentsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/{index}/comments",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "List all comments on an issue",
    operationId: "issueGetComments",
    request: {
      params: z.object(issueIndexParams),
      query: z.object({
        since: rfc3339Query("if provided, only comments updated since the specified time are returned."),
        before: rfc3339Query("if provided, only comments updated before the provided time are returned."),
      }),
    },
    responses: {
      200: { description: "CommentList", content: { "application/json": { schema: commentListSchema } } },
      404: notFoundResponse,
    },
  });

const createCommentRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/issues/{index}/comments",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Add a comment to an issue",
    operationId: "issueCreateComment",
    request: {
      params: z.object(issueIndexParams),
      body: { content: { "application/json": { schema: createIssueCommentOptionSchema } } },
    },
    responses: {
      201: { description: "Comment", content: { "application/json": { schema: commentSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      423: repoArchivedResponse,
    },
  });

const issueLabelsListResponse = {
  description: "LabelList",
  content: { "application/json": { schema: z.array(issueLabelSchema) } },
} as const;

const listIssueLabelsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/{index}/labels",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "Get an issue's labels",
    operationId: "issueGetLabels",
    request: { params: z.object(issueIndexParams) },
    responses: {
      200: issueLabelsListResponse,
      404: notFoundResponse,
    },
  });

const addIssueLabelsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/issues/{index}/labels",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Add a label to an issue",
    operationId: "issueAddLabel",
    request: {
      params: z.object(issueIndexParams),
      body: { content: { "application/json": { schema: issueLabelsOptionSchema } } },
    },
    responses: {
      200: issueLabelsListResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      423: repoArchivedResponse,
    },
  });

const replaceIssueLabelsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/repos/{owner}/{repo}/issues/{index}/labels",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Replace an issue's labels",
    operationId: "issueReplaceLabels",
    request: {
      params: z.object(issueIndexParams),
      body: { content: { "application/json": { schema: issueLabelsOptionSchema } } },
    },
    responses: {
      200: issueLabelsListResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      423: repoArchivedResponse,
    },
  });

const clearIssueLabelsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}/labels",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Remove all labels from an issue",
    operationId: "issueClearLabels",
    request: { params: z.object(issueIndexParams) },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      423: repoArchivedResponse,
    },
  });

const timelineRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/{index}/timeline",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "List all comments and events on an issue",
    operationId: "issueGetCommentsAndTimeline",
    request: {
      params: z.object(issueIndexParams),
      query: z.object({
        since: rfc3339Query("if provided, only comments updated since the specified time are returned."),
        before: rfc3339Query("if provided, only comments updated before the provided time are returned."),
        page: pageLimitQuery.page,
        limit: pageLimitQuery.limit,
      }),
    },
    responses: {
      200: { description: "TimelineList", content: { "application/json": { schema: timelineCommentListSchema } } },
      404: notFoundResponse,
    },
  });

const searchIssuesRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/issues/search",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "Search for issues across the repositories that the user has access to",
    operationId: "issueSearchIssues",
    request: {
      query: z.object({
        state: z.string().optional().openapi({ description: "whether issue is open or closed" }),
        labels: z
          .string()
          .optional()
          .openapi({
            description:
              "comma separated list of label names. Fetch only issues that have any of this label names. Non existent labels are discarded.",
          }),
        milestones: z
          .string()
          .optional()
          .openapi({
            description:
              "comma separated list of milestone names. Fetch only issues that have any of this milestones. Non existent milestones are discarded",
          }),
        q: z.string().optional().openapi({ description: "search issue by title or contents" }),
        type: z.string().optional().openapi({ description: "filter by type (issues / pulls) if set" }),
        since: rfc3339Query("Only show items updated after the given time. This is a timestamp in RFC 3339 format"),
        before: rfc3339Query("Only show items updated before the given time. This is a timestamp in RFC 3339 format"),
        assigned: z.boolean().optional().openapi({ description: "Filter (issues / pulls) assigned to the authenticated user" }),
        created: z.boolean().optional().openapi({ description: "Filter (issues / pulls) created by the authenticated user" }),
        mentioned: z.boolean().optional().openapi({ description: "Filter (issues / pulls) mentioning the authenticated user" }),
        review_requested: z
          .boolean()
          .optional()
          .openapi({ description: "Filter pulls where the authenticated user's review was requested" }),
        reviewed: z.boolean().optional().openapi({ description: "Filter pulls reviewed by the authenticated user" }),
        owner: z.string().optional().openapi({ description: "filter by owner" }),
        team: z.string().optional().openapi({ description: "filter by team (requires owner organization)" }),
        created_by: z.string().optional().openapi({ description: "Only show items which were created by the given user" }),
        page: pageLimitQuery.page,
        limit: pageLimitQuery.limit,
      }),
    },
    responses: {
      200: { description: "IssueList", content: { "application/json": { schema: issueListSchema } } },
      400: errorResponse,
      422: validationErrorResponse,
    },
  });

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function registerIssueRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issues (issueListIssues)
  // -------------------------------------------------------------------------
  app.openapi(listIssuesRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const url = new URL(c.req.url);
    const since = parseQueryTime(url.searchParams.get("since"));
    const before = parseQueryTime(url.searchParams.get("before"));
    const listOptions = parseListOptions(url);

    // created_by → poster filter; unknown login is the upstream 422.
    let posterId: number | null | undefined;
    const createdBy = (url.searchParams.get("created_by") ?? "").trim();
    if (createdBy !== "") {
      posterId = await userIdForFilter(c.env.DB, createdBy);
      if (posterId === null) {
        throw userNotExistError(createdBy);
      }
    }
    // assigned_by/mentioned_by: no assignee/mention tracking exists yet, so
    // the filters match the empty set (upstream filters the same empty set).
    if ((url.searchParams.get("assigned_by") ?? "").trim() !== "" || (url.searchParams.get("mentioned_by") ?? "").trim() !== "") {
      posterId = -1;
    }

    const { items, total } = await listRepoIssues(c.env.DB, found.repo.id, {
      isClosed: parseStateFilter(url.searchParams.get("state")),
      isPull: parseTypeFilter(url.searchParams.get("type")),
      keyword: (url.searchParams.get("q") ?? "").trim(),
      labelIds: await labelIdsByRepoNames(c.env.DB, found.repo.id, csvParam(url.searchParams, "labels")),
      milestoneIds: await milestoneIdsByRepoEntries(c.env.DB, found.repo.id, csvParam(url.searchParams, "milestones")),
      since,
      before,
      posterId,
      page: listOptions.page,
      limit: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const rendered = await Promise.all(items.map((issue) => toApiIssue(c.env.DB, viewer, found, issue)));
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/issues (issueCreateIssue) — 201
  // -------------------------------------------------------------------------
  app.openapi(
    createIssueRoute(requireAuth),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const form = c.req.valid("json");
      const service = new IssuesService(c.env.DB);
      const requester = c.get("authUser");
      const event = issueEventContext(c, found);

      // Writer-gated deadline (upstream gates on CanWrite(TypeIssues); the
      // token identity stands in for the ACL matrix). ApplyAPIDeadlineTimestamp
      // port — 400 "invalid date format" on bad input (runtime-only status).
      let deadlineAt: Date | null = null;
      const rawDueDate = patchField(form.due_date);
      if (rawDueDate !== undefined && rawDueDate !== "") {
        deadlineAt = parseMilestoneDeadline(rawDueDate);
      }

      let issue: IssueRow;
      try {
        issue = await service.createIssue({
          repoId: found.repo.id,
          title: form.title,
          content: form.body ?? null,
          posterId: requester.id,
          milestoneId: form.milestone === undefined || form.milestone === 0 ? null : form.milestone,
          labelIds: form.labels ?? [],
          ref: form.ref ?? "",
        });
      } catch (error) {
        asApiError(error);
        throw error;
      }
      if (deadlineAt !== null) {
        // Upstream stores the deadline on the issue pre-insert (no system
        // comment on the create path).
        const updated = await drizzle(c.env.DB)
          .update(issues)
          .set({ deadlineAt })
          .where(eq(issues.id, issue.id))
          .returning();
        issue = updated[0] ?? issue;
      }
      if (form.closed === true) {
        try {
          issue = await service.closeIssue(issue.id, { actorId: requester.id });
        } catch (error) {
          asApiError(error);
          throw error;
        }
      }

      const rendered = await toApiIssue(c.env.DB, viewer, found, issue);
      // Webhooks: opened (always), then closed (form.closed) — the upstream
      // NewIssue → CloseIssue notification order.
      await emitIssueEvent(c, {
        repoId: found.repo.id,
        ownerId: event.ownerId,
        eventType: "issues",
        payload: issueEventPayload("opened", rendered, issue.index, event.repository, event.sender),
      });
      if (form.closed === true) {
        await emitIssueEvent(c, {
          repoId: found.repo.id,
          ownerId: event.ownerId,
          eventType: "issues",
          payload: issueEventPayload("closed", rendered, issue.index, event.repository, event.sender),
        });
      }
      return c.json(rendered, 201);
    },
    createIssueBodyHook,
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issues/comments (issueGetRepoComments)
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issues/comments/{id} (issueGetComment) —
  // the GLOBAL comment id; system comments answer the empty 204.
  // -------------------------------------------------------------------------
  // PATCH /repos/{owner}/{repo}/issues/comments/{id} (issueEditComment)
  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/issues/comments/{id} (issueDeleteComment)
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issues/comments (issueGetRepoComments) — the
  // static path must register before /issues/{index} (route precedence).
  // -------------------------------------------------------------------------
  app.openapi(listRepoCommentsRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const url = new URL(c.req.url);
    const since = parseQueryTime(url.searchParams.get("since"));
    const before = parseQueryTime(url.searchParams.get("before"));
    const listOptions = parseListOptions(url);
    const { items, total } = await listRepoComments(c.env.DB, found.repo.id, since, before, listOptions.page, listOptions.limit);
    setPaginationHeaders(c, total, listOptions);
    const rendered = await Promise.all(items.map(({ comment, issue }) => toApiComment(c.env.DB, viewer, found, issue, comment)));
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issues/comments/{id} (issueGetComment) —
  // the GLOBAL comment id; system comments answer the empty 204.
  // -------------------------------------------------------------------------
  app.openapi(getCommentRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const commentId = pathId(c.req.valid("param").id);
    const row = await findRepoCommentById(c.env.DB, found.repo.id, commentId);
    if (row === null) {
      throw commentNotExistError(commentId);
    }
    if (row.comment.type !== CommentType.Comment) {
      // Upstream GetIssueComment: non-Comment types render 204 (no content).
      return c.body(null, 204);
    }
    return c.json(await toApiComment(c.env.DB, viewer, found, row.issue, row.comment), 200);
  });

  // -------------------------------------------------------------------------
  // PATCH /repos/{owner}/{repo}/issues/comments/{id} (issueEditComment)
  // -------------------------------------------------------------------------
  app.openapi(editCommentRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    assertNotArchived(found);
    const commentId = pathId(c.req.valid("param").id);
    const row = await findRepoCommentById(c.env.DB, found.repo.id, commentId);
    if (row === null) {
      throw commentNotExistError(commentId);
    }
    if (!canEditIssue(c, found, row.comment.posterId)) {
      // Upstream answers a bare Status(403); the envelope carries an empty message.
      throw new ApiError(403, "");
    }
    if (!commentHasContentSupport(row.comment.type)) {
      // Upstream editIssueComment: unsupported types answer the empty 204.
      return c.body(null, 204);
    }
    const form = c.req.valid("json");
    if (form.body !== (row.comment.content ?? "")) {
      // Upstream editIssueComment (routers/api/v1/repo/issue_comment.go:569-577)
      // updates and notifies only on an actual content change, carrying the
      // pre-edit content into the notifier (UpdateComment:420-461's
      // `changes.body.from`).
      const oldContent = row.comment.content ?? "";
      await updateCommentBody(c.env.DB, row.comment.id, form.body, new Date());
      row.comment = { ...row.comment, content: form.body };
      // Webhook: comment edited — the `issue.IsPull` discriminant picks
      // issue_comment / pull_request_comment.
      await emitCommentEvent(
        c,
        found,
        row.issue,
        await toApiComment(c.env.DB, viewer, found, row.issue, row.comment),
        "edited",
        { changes: { body: { from: oldContent } } },
      );
    }
    return c.json(await toApiComment(c.env.DB, viewer, found, row.issue, row.comment), 200);
  });

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/issues/comments/{id} (issueDeleteComment)
  // -------------------------------------------------------------------------
  app.openapi(deleteCommentRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    assertNotArchived(found);
    const commentId = pathId(c.req.valid("param").id);
    const row = await findRepoCommentById(c.env.DB, found.repo.id, commentId);
    if (row === null) {
      throw commentNotExistError(commentId);
    }
    if (!canEditIssue(c, found, row.comment.posterId)) {
      throw new ApiError(403, "");
    }
    if (!commentHasContentSupport(row.comment.type)) {
      // Upstream deleteIssueComment answers StatusBadRequest (undeclared).
      throw new ApiError(400, "comment type does not support content");
    }
    // Render before the delete (upstream DeleteComment:493-541 serializes the
    // in-memory comment) — toApiComment reads only the poster row, so the
    // render stays valid across the deletion; the issue object the payload
    // embeds is re-read fresh (upstream reloads the issue too, picking up the
    // decremented num_comments).
    const rendered = await toApiComment(c.env.DB, viewer, found, row.issue, row.comment);
    const removed = await deleteComment(c.env.DB, row.comment, new Date());
    // Webhook: comment deleted (DeleteComment:517) — no `changes` block.
    if (removed) {
      await emitCommentEvent(c, found, row.issue, rendered, "deleted");
    }
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issues/{index} (issueGetIssue)
  // -------------------------------------------------------------------------
  app.openapi(getIssueRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    return c.json(await toApiIssue(c.env.DB, viewer, found, issue), 200);
  });

  // -------------------------------------------------------------------------
  // PATCH /repos/{owner}/{repo}/issues/{index} (issueEditIssue) — 201 quirk
  // -------------------------------------------------------------------------
  app.openapi(editIssueRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    assertNotArchived(found);
    let issue = await requireIssue(c, found, c.req.valid("param").index);
    if (!canEditIssue(c, found, issue.posterId)) {
      // Upstream answers a bare Status(403); the contract's forbidden family
      // is the {message, url} envelope — sent empty-messageed.
      throw new ApiError(403, "");
    }
    const form = c.req.valid("json");
    const service = new IssuesService(c.env.DB);
    const requester = c.get("authUser");
    if (requester === undefined) {
      throw new ApiError(401, "token is required"); // unreachable behind requireAuth
    }
    // The contract User model declares optional fields; a resolved identity
    // always carries its numeric id (the resolver rows are D1-backed).
    const actorId = requester.id ?? 0;
    const now = new Date();
    const event = issueEventContext(c, found);

    // Fail-fast stale version check (upstream rejects BEFORE mutating); the
    // DB-level CAS in ChangeContent covers the concurrent window.
    const requestedVersion = patchField(form.content_version);
    if (requestedVersion !== undefined && requestedVersion !== issue.contentVersion) {
      throw new ApiError(409, "the issue is already changed");
    }

    const title = patchField(form.title);
    if (title !== undefined && title.length > 0 && title !== issue.title) {
      const oldTitle = issue.title;
      const updated = await changeIssueTitle(c.env.DB, issue, title, actorId, now);
      if (updated !== null) {
        issue = updated;
      }
      await emitIssueEvent(c, {
        repoId: found.repo.id,
        ownerId: event.ownerId,
        eventType: "issues",
        payload: issueEventPayload("edited", await toApiIssue(c.env.DB, viewer, found, issue), issue.index, event.repository, event.sender, {
          changes: { title: { from: oldTitle } },
        }),
      });
    }

    const body = patchField(form.body);
    if (body !== undefined && body !== (issue.content ?? "")) {
      const oldContent = issue.content ?? "";
      const updated = await changeIssueBody(c.env.DB, issue, body, requestedVersion ?? issue.contentVersion, now);
      if (updated === null) {
        // Lost the concurrent CAS race — upstream ErrIssueAlreadyChanged.
        throw new ApiError(409, "the issue is already changed");
      }
      issue = updated;
      await emitIssueEvent(c, {
        repoId: found.repo.id,
        ownerId: event.ownerId,
        eventType: "issues",
        payload: issueEventPayload("edited", await toApiIssue(c.env.DB, viewer, found, issue), issue.index, event.repository, event.sender, {
          changes: { body: { from: oldContent } },
        }),
      });
    }

    const ref = patchField(form.ref);
    if (ref !== undefined) {
      await changeIssueRef(c.env.DB, issue, ref, actorId, now);
      issue = { ...issue, ref };
    }

    // Deadline: unset_due_date removes; due_date sets (writer-gated upstream).
    if (patchField(form.unset_due_date) === true && issue.deadlineAt !== null) {
      await changeIssueDeadline(c.env.DB, issue, null, issue.deadlineAt, actorId, now);
      issue = { ...issue, deadlineAt: null };
    } else {
      const dueDate = patchField(form.due_date);
      if (dueDate !== undefined && dueDate !== "") {
        const parsed = parseMilestoneDeadline(dueDate);
        if (parsed === null || parsed.getTime() !== issue.deadlineAt?.getTime()) {
          await changeIssueDeadline(c.env.DB, issue, parsed, issue.deadlineAt, actorId, now);
          issue = { ...issue, deadlineAt: parsed };
        }
      }
    }

    // Milestone: only on actual change (upstream guards with !=).
    const milestone = patchField(form.milestone);
    if (milestone !== undefined && milestone !== issue.milestoneId) {
      const newMilestoneId = milestone === 0 ? null : milestone;
      if (newMilestoneId !== null) {
        const row = await service.getMilestone(newMilestoneId);
        if (row === null || row.repoId !== found.repo.id) {
          throw issueErrorToApiError(new MilestoneNotExistError({ id: newMilestoneId, repoId: found.repo.id }));
        }
      }
      const oldMilestoneId = issue.milestoneId;
      await changeIssueMilestone(c.env.DB, issue, newMilestoneId, oldMilestoneId, actorId, now);
      issue = { ...issue, milestoneId: newMilestoneId };
      // Webhook: IssueChangeMilestone (notifier.go:618) — milestoned when the
      // issue now carries one, demilestoned on the clear; the IsPull
      // discriminant picks issue_milestone / pull_request_milestone.
      await emitMilestoneEvent(c, found, issue, newMilestoneId !== null ? "milestoned" : "demilestoned");
    }

    // form.assignee(s): upstream replaces the assignee set — no
    // issue_assignees table yet; ignored (file-header deviation note).

    // State: close/reopen through the CAS-guarded service (the merged-PR
    // guard is a PR-surface concern; no PR rows are creatable yet).
    const state = patchField(form.state);
    if (state === "closed" && !issue.isClosed) {
      try {
        issue = await service.closeIssue(issue.id, { actorId });
      } catch (error) {
        asApiError(error);
        throw error;
      }
      await emitIssueEvent(c, {
        repoId: found.repo.id,
        ownerId: event.ownerId,
        eventType: "issues",
        payload: issueEventPayload("closed", await toApiIssue(c.env.DB, viewer, found, issue), issue.index, event.repository, event.sender),
      });
    } else if (state === "open" && issue.isClosed) {
      try {
        issue = await service.reopenIssue(issue.id, { actorId });
      } catch (error) {
        asApiError(error);
        throw error;
      }
      await emitIssueEvent(c, {
        repoId: found.repo.id,
        ownerId: event.ownerId,
        eventType: "issues",
        payload: issueEventPayload("reopened", await toApiIssue(c.env.DB, viewer, found, issue), issue.index, event.repository, event.sender),
      });
    }

    return c.json(await toApiIssue(c.env.DB, viewer, found, issue), 201);
  });

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/issues/{index} (issueDelete)
  // -------------------------------------------------------------------------
  app.openapi(deleteIssueRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepo(c, c.req.valid("param"));
    assertNotArchived(found);
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    // Upstream reqAdmin lands with the SPEC-0002 ACL matrix (header note).
    await deleteIssueCascade(c.env.DB, issue);
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issues/{index}/comments (issueGetComments)
  // -------------------------------------------------------------------------
  app.openapi(listIssueCommentsRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const url = new URL(c.req.url);
    const since = parseQueryTime(url.searchParams.get("since"));
    const before = parseQueryTime(url.searchParams.get("before"));
    const rows = await listIssueComments(c.env.DB, issue.id, since, before);
    // Upstream sets X-Total-Count but does not paginate this endpoint.
    c.header("X-Total-Count", String(rows.length));
    const rendered = await Promise.all(rows.map((comment) => toApiComment(c.env.DB, viewer, found, issue, comment)));
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/issues/{index}/comments (issueCreateComment) — 201
  // -------------------------------------------------------------------------
  app.openapi(
    createCommentRoute(requireAuth),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const issue = await requireIssue(c, found, c.req.valid("param").index);
      const form = c.req.valid("json");
      const service = new IssuesService(c.env.DB);
      const requester = c.get("authUser");
      const comment = await service.addComment({ issueId: issue.id, posterId: requester.id, content: form.body });
      const rendered = await toApiComment(c.env.DB, viewer, found, issue, comment);
      // Webhook: created (issue_comment; PR comments map to
      // pull_request_comment with the same payload shape, §2.7).
      const eventType: HookEventType = issue.isPull ? "pull_request_comment" : "issue_comment";
      const event = issueEventContext(c, found);
      await emitIssueEvent(c, {
        repoId: found.repo.id,
        ownerId: event.ownerId,
        eventType,
        payload: {
          action: "created",
          issue: await toApiIssue(c.env.DB, viewer, found, issue),
          comment: rendered,
          repository: event.repository,
          sender: event.sender,
          is_pull: issue.isPull,
        },
      });
      return c.json(rendered, 201);
    },
    // 422 is NOT declared for this operation — malformed bodies take hono's
    // default 400 (documented in the file header).
    ({ success }: { success: boolean }) => {
      if (!success) {
        throw new ApiError(400, "invalid request body");
      }
      return undefined;
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issues/{index}/labels (issueGetLabels)
  // -------------------------------------------------------------------------
  app.openapi(listIssueLabelsRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const rows = await issueLabelRows(c.env.DB, issue.id);
    return c.json(rows.map((row) => toApiLabel(row, apiRepositoryUrl(found, viewer.origin))), 200);
  });

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/issues/{index}/labels (issueAddLabel) — ADD
  // semantics; 200 with the resulting label list (never 201).
  // -------------------------------------------------------------------------
  app.openapi(
    addIssueLabelsRoute(requireAuth),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const issue = await requireIssue(c, found, c.req.valid("param").index);
      const form = c.req.valid("json");
      const labelIds = await resolveLabelOptionIds(c.env.DB, found.repo.id, form.labels);
      const service = new IssuesService(c.env.DB);
      try {
        for (const labelId of labelIds) {
          await service.setLabel(issue.id, labelId, { ownerOrgId: null });
        }
      } catch (error) {
        asApiError(error);
        throw error;
      }
      // Webhook: IssueChangeLabels (notifier.go:572) — upstream's service
      // layer notifies unconditionally after AddLabels, with no `changes`.
      await emitLabelEvent(c, found, issue, "label_updated");
      const rows = await issueLabelRows(c.env.DB, issue.id);
      return c.json(rows.map((row) => toApiLabel(row, apiRepositoryUrl(found, viewer.origin))), 200);
    },
    ({ success }: { success: boolean }) => {
      if (!success) {
        throw new ApiError(400, "invalid request body");
      }
      return undefined;
    },
  );

  // -------------------------------------------------------------------------
  // PUT /repos/{owner}/{repo}/issues/{index}/labels (issueReplaceLabels) —
  // REPLACE semantics (verb semantics: PUT=replace/POST=add/DELETE=clear).
  // -------------------------------------------------------------------------
  app.openapi(
    replaceIssueLabelsRoute(requireAuth),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const issue = await requireIssue(c, found, c.req.valid("param").index);
      const form = c.req.valid("json");
      const labelIds = await resolveLabelOptionIds(c.env.DB, found.repo.id, form.labels);
      const service = new IssuesService(c.env.DB);
      try {
        await service.replaceLabels(issue.id, labelIds, { ownerOrgId: null });
      } catch (error) {
        asApiError(error);
        throw error;
      }
      // Webhook: IssueChangeLabels (notifier.go:572) — ReplaceLabels notifies
      // unconditionally too (services/issue/label.go:79-87).
      await emitLabelEvent(c, found, issue, "label_updated");
      const rows = await issueLabelRows(c.env.DB, issue.id);
      return c.json(rows.map((row) => toApiLabel(row, apiRepositoryUrl(found, viewer.origin))), 200);
    },
    ({ success }: { success: boolean }) => {
      if (!success) {
        throw new ApiError(400, "invalid request body");
      }
      return undefined;
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/issues/{index}/labels (issueClearLabels)
  // -------------------------------------------------------------------------
  app.openapi(clearIssueLabelsRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepo(c, c.req.valid("param"));
    assertNotArchived(found);
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const service = new IssuesService(c.env.DB);
    try {
      await service.replaceLabels(issue.id, [], { ownerOrgId: null });
    } catch (error) {
      asApiError(error);
      throw error;
    }
    // Webhook: IssueClearLabels (notifier.go:46) — ClearLabels notifies
    // unconditionally (services/issue/label.go:16-27), even on an empty set.
    await emitLabelEvent(c, found, issue, "label_cleared");
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issues/{index}/timeline
  // (issueGetCommentsAndTimeline) — the mixed stream: ALL comment rows in
  // id order, rendered as TimelineComment with the per-type metadata our
  // comment rows carry (close/reopen, change_title, labels, milestones,
  // refs, assignees, xref columns).
  // -------------------------------------------------------------------------
  app.openapi(timelineRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const url = new URL(c.req.url);
    const since = parseQueryTime(url.searchParams.get("since"));
    const before = parseQueryTime(url.searchParams.get("before"));
    const listOptions = parseListOptions(url);
    const rows = await listIssueTimeline(c.env.DB, issue.id, since, before, listOptions.page, listOptions.limit);
    const rendered: TimelineComment[] = [];
    for (const comment of rows) {
      if (comment.type === CommentType.Code) {
        continue; // upstream drops code comments from the timeline
      }
      rendered.push(await toTimelineComment(c.env.DB, viewer, found, issue, comment));
    }
    // Upstream counts the FILTERED list (SetTotalCountHeader(len(apiComments))).
    setPaginationHeaders(c, rendered.length, listOptions);
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // GET /repos/issues/search (issueSearchIssues) — cross-repo.
  // -------------------------------------------------------------------------
  app.openapi(searchIssuesRoute(optionalAuth), async (c) => {
    const viewer = viewerOf(c);
    const url = new URL(c.req.url);
    const since = parseQueryTime(url.searchParams.get("since"));
    const before = parseQueryTime(url.searchParams.get("before"));
    const listOptions = parseListOptions(url);

    // Repo filter (SearchIssuesRepoIDs): owner narrows to that owner's
    // visible repos; unknown owner is the declared 400; team needs the tier-2
    // teams surface (a team filter alone is the upstream 400; with an owner
    // it matches nothing — no teams exist).
    const ownerName = (url.searchParams.get("owner") ?? "").trim();
    const teamName = (url.searchParams.get("team") ?? "").trim();
    if (teamName !== "" && ownerName === "") {
      throw new ApiError(400, "owner organisation is required for filtering on team");
    }
    let ownerLower: string | null = null;
    if (ownerName !== "") {
      const ownerRow = await userRowByName(c.env.DB, ownerName);
      if (ownerRow === null) {
        throw new ApiError(400, `user does not exist [name: ${ownerName}]`);
      }
      ownerLower = ownerRow.usernameLower;
    }
    const repoIds = await visibleRepoIds(c.env.DB, viewer, ownerLower);

    const createdBy = (url.searchParams.get("created_by") ?? "").trim();
    let posterId: number | null | undefined;
    if (createdBy !== "") {
      posterId = await userIdForFilter(c.env.DB, createdBy);
      if (posterId === null) {
        throw userNotExistError(createdBy);
      }
    }
    const requester = c.get("authUser");
    if (requester !== undefined) {
      if (url.searchParams.get("created") === "true") {
        posterId = requester.id;
      }
      // assigned/mentioned/review_requested/reviewed: the corresponding
      // tables do not exist yet — the filters match the empty set.
      for (const flag of ["assigned", "mentioned", "review_requested", "reviewed"]) {
        if (url.searchParams.get(flag) === "true") {
          posterId = -1;
        }
      }
    }

    const { items, total } = await searchIssuesGlobally(c.env.DB, repoIds, {
      isClosed: parseStateFilter(url.searchParams.get("state")),
      isPull: parseTypeFilter(url.searchParams.get("type")),
      keyword: (url.searchParams.get("q") ?? "").trim(),
      labelIds: await labelIdsByGlobalNames(c.env.DB, csvParam(url.searchParams, "labels")),
      milestoneIds: await milestoneIdsByGlobalNames(c.env.DB, csvParam(url.searchParams, "milestones")),
      since,
      before,
      posterId,
      page: listOptions.page,
      limit: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const rendered: Issue[] = [];
    for (const issue of items) {
      const pair = await findRepositoryById(c.env.DB, issue.repoId);
      if (pair === null) {
        continue;
      }
      rendered.push(await toApiIssue(c.env.DB, viewer, pair, issue));
    }
    return c.json(rendered, 200);
  });
}

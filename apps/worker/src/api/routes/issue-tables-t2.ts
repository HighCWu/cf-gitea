import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  comments,
  issueAssignees,
  issueDependencies,
  issuePins,
  issueStopwatches,
  issues,
  repositories,
  trackedTimes,
  users,
} from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import { IssueNotExistError } from "../../issues/errors";
import type { IssueRow } from "../../issues/service";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { issueListSchema, issueSchema } from "../models/issue";
import type { Issue } from "../models/issue";
import { canWriteRepository, isRepositoryAdmin } from "../services/repo-access";
import { findCollaborator } from "../services/repo-collaborators";
import {
  GO_ZERO_TIME,
  apiUserFromRow,
  canViewRepository,
  findRepositoryByPath,
  findRepositoryById,
  findUserByName,
  viewerOf,
} from "../services/repository";
import type { RepositoryRow, RepositoryWithOwner, Viewer } from "../services/repository";
import {
  findIssueByRepoAndIndex,
  issueErrorToApiError,
  parseQueryTime,
  toApiIssue,
} from "../services/issues";

/**
 * Tier-2 issue TABLE-family routes — the operations the issue-write wave
 * deferred until their tables existed (SPEC-0004 appendix A category d,
 * issue tag): the issue assignees trio, the dependency/blocks family, the
 * stopwatch trio and the tracked-times quartet, plus the repository-tagged
 * pin-cap probe `repoNewPinAllowed`. Backed by the migration-0012 tables
 * (`issue_assignees`, `issue_dependency`, `tracked_time`, `stopwatch` —
 * mirrors of upstream's own tables, see src/db/schema.ts).
 *
 * Upstream citations (submodule pin fc4936884584):
 *   - assignees: routers/api/v1/repo/issue_assignee.go AddIssueAssignees:23 /
 *     DeleteIssueAssignees:70 / CheckIssueAssignee:115 over
 *     updateIssueAssignees:185, checkAssignableUser:164,
 *     services/issue/assignee.go AddAssignees:206 / RemoveAssignees:249,
 *     validateAssignee:172, models/issues/assignees.go toggleIssueAssignee:96
 *     (the type-9 comment), models/perm/access/repo_permission.go
 *     CanBeAssigned:588. Registered reqToken+mustNotBeArchived (api.go:1604)
 *     except the GET check (api.go:1607 — anonymous).
 *   - dependencies/blocks: routers/api/v1/repo/issue_dependency.go
 *     GetIssueDependencies:22 / CreateIssueDependency:138 /
 *     RemoveIssueDependency:199 / GetIssueBlocks:260 / CreateIssueBlocking:358
 *     / RemoveIssueBlocking:415 over createIssueDependency:511 /
 *     removeIssueDependency:537 / getFormIssue:471, models/issues/
 *     dependency.go CreateIssueDependency:124 / RemoveIssueDependency:157,
 *     models/issues/comment.go createIssueDependencyComment:997 (type-19/20
 *     comments on BOTH issues), models/issues/issue.go
 *     BlockedByDependencies:670 / BlockingDependencies:691. Dependencies
 *     POST/DELETE carry reqToken+mustNotBeArchived (api.go:1654); blocks
 *     POST/DELETE reqToken only (api.go:1658); both GETs anonymous.
 *   - stopwatch: routers/api/v1/repo/issue_stopwatch.go StartIssueStopwatch:17
 *     / StopIssueStopwatch:70 / DeleteIssueStopwatch:122 over
 *     prepareIssueForStopwatch:174, models/issues/stopwatch.go
 *     CreateIssueStopwatch:172 (ONE running stopwatch per user; a start on
 *     another issue first FINISHES the old one) / FinishIssueStopwatch:125
 *     (writes the tracked_time + the stop_tracking (13) comment) /
 *     CancelStopwatch:208 (cancel_tracking (15) comment, no time banked).
 *     Group-level reqToken (api.go:1630).
 *   - tracked times: routers/api/v1/repo/issue_tracked_time.go
 *     ListTrackedTimes:23 / AddTime:164 / ResetIssueTime:248 / DeleteTime:310
 *     over models/issues/tracked_time.go AddTime:164 /
 *     DeleteIssueUserTimes:249 / DeleteTime:267 (SOFT deletes —
 *     `tracked_time.deleted`; the reset's zero-sum guard keys on the SUM,
 *     :250) and services/convert/issue.go ToTrackedTime:158.
 *     Group-level reqToken (api.go:1622).
 *   - repoNewPinAllowed: routers/api/v1/repo/issue_pin.go
 *     AreNewIssuePinsAllowed:254 over IsNewPinAllowed — genuinely the
 *     pin-cap query (per issue/pull half vs `setting.Repository.Issue.
 *     MaxPinned`), which the landed issue-write-t2 pin routes already model.
 *
 * Auth: writes behind requireAuth (upstream reqToken); the four reads
 * (issueCheckAssignee, both dependency/blocks lists, repoNewPinAllowed)
 * optional per their registration. In-handler writer gates mirror upstream:
 *   - assignees POST/DELETE and the stopwatch/times writes: CanWriteIssuesOrPulls
 *     (and CanUseTimetracker, which collapses onto it) are bare
 *     `ctx.Status(403)` arms — ApiError(403, "") like the landed bare-403s;
 *   - dependencies/blocks writes hide existence: target-write /
 *     dependency-read failures are APIErrorNotFound() → 404 "not found".
 *
 * Collapsed gates (no settings/units modules — upstream defaults):
 *   - timetracker ENABLED (instance EnableTimetracking + issues-unit
 *     EnableTimetracker default true, models/repo/issue.go:27-41): the "time
 *     tracking disabled" 400 arms stay DECLARED (per contract) but are
 *     unreachable, the landed 412 precedent;
 *   - dependencies ENABLED (IssuesConfig.EnableDependencies default true,
 *     models/repo/issue.go:57): the IsDependenciesEnabled 404s collapse away;
 *   - CanUseTimetracker = writer (AllowOnlyContributorsToTrackTime default
 *     true), services/context/repo.go:270.
 *
 * Runtime-only codes the handlers can emit that the vendored contract omits
 * (declared set stays the contract's; NOT added to the orchestrator's
 * RUNTIME_ONLY_RESPONSES tables — the landed convention):
 *   - assignees POST/DELETE on an archived repo → 423 (mustNotBeArchived,
 *     api.go:1605-1606 — the contract documents no 423 for these two);
 *   - duplicate/circular dependency → 500 with upstream's model-error text
 *     (APIErrorInternal, createIssueDependency:530-534);
 *   - removing a non-existent dependency → 500 with upstream's text
 *     (APIErrorInternal, removeIssueDependency:556-560).
 *
 * Deviations (English, per AGENTS.md):
 *   - RemoveIssueDependency/RemoveIssueBlocking answer 200; upstream sends
 *     `ctx.JSON(http.StatusCreated, …)` (issue_dependency.go:256/468) — a
 *     handler/contract drift upstream carries against its own swagger; the
 *     frozen contract wins here.
 *   - cross-repo dependencies (AllowCrossRepositoryDependencies default
 *     true, service.go:210) resolve the body's owner/repo through the
 *     visibility matrix; a blocker the viewer cannot read renders, per
 *     upstream's intent, as the redacted `{title: "HIDDEN"}` issue for
 *     non-writers and the confidential subset (repository meta + number +
 *     title + state) for writers (issue_dependency.go:103-129). Upstream's
 *     exact zero-render differs (it re-converts a synthesized row through
 *     toIssue); we render the redacted subset deterministically.
 *   - the stop-tracking (13) comment's `time_id` back-reference has no home
 *     column in the landed comments table (append-only schema) — the seconds
 *     travel in the comment content, the entry lives in tracked_time.
 *   - GET …/times embeds the full issue in every entry (upstream
 *     ToTrackedTime after LoadAttributes); the `user` query filter behaves
 *     upstream-exact including the cantSetUser scoping (:108-119).
 */

// ---------------------------------------------------------------------------
// Wire schemas local to this family
// ---------------------------------------------------------------------------

/** `#/definitions/TrackedTime` (modules/structs/issue_track.go). */
const trackedTimeSchema = z.object({
  id: z.number().int().optional().openapi({ format: "int64", description: "ID is the unique identifier for the tracked time entry" }),
  /** Deprecated by upstream; always rendered (ToTrackedTime sets it). */
  issue_id: z.number().int().optional().openapi({ format: "int64", description: "deprecated (only for backwards compatibility)" }),
  issue: issueSchema.optional(),
  /** Seconds. */
  time: z.number().int().optional().openapi({ format: "int64", description: "Time in seconds" }),
  created: z.string().optional().openapi({ format: "date-time" }),
  /** Deprecated by upstream; always rendered. */
  user_id: z.number().int().optional().openapi({ format: "int64", description: "deprecated (only for backwards compatibility)" }),
  user_name: z.string().optional().openapi({ description: "username of the user" }),
});

const trackedTimeListSchema = z.array(trackedTimeSchema);

/** `#/definitions/NewIssuePinsAllowed`. */
const newIssuePinsAllowedSchema = z.object({
  issues: z.boolean().optional(),
  pull_requests: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Response shorthands (the issue-write-t2 file-local set)
// ---------------------------------------------------------------------------

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

const issueResponse = {
  description: "Issue",
  content: { "application/json": { schema: issueSchema } },
} as const;

const issueListResponse = {
  description: "IssueList",
  content: { "application/json": { schema: issueListSchema } },
} as const;

const trackedTimeResponse = {
  description: "TrackedTime",
  content: { "application/json": { schema: trackedTimeSchema } },
} as const;

const trackedTimeListResponse = {
  description: "TrackedTimeList",
  content: { "application/json": { schema: trackedTimeListSchema } },
} as const;

const newIssuePinsAllowedResponse = {
  description: "RepoNewIssuePinsAllowed",
  content: { "application/json": { schema: newIssuePinsAllowedSchema } },
} as const;

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const issueIndexParams = {
  ...ownerRepoParams,
  index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of the issue" }),
} as const;

const pageLimitQuery = {
  page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
  limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
} as const;

/** `IssueAssigneesOption` — the login list (no required fields upstream). */
const issueAssigneesOption = z.object({
  assignees: z.array(z.string()).optional().openapi({ description: "assignees to add/remove" }),
});

/** `IssueMeta` — locates the other issue of a dependency edge. */
const issueMetaOption = z.object({
  index: z.number().int().optional().openapi({ type: "integer", format: "int64", description: "index of the issue" }),
  owner: z.string().optional().openapi({ description: "owner of the issue's repo" }),
  repo: z.string().optional().openapi({ description: "name of the issue's repo" }),
});

/** `AddTimeOption`. */
const addTimeOption = z.object({
  /** Seconds (upstream allows negative — no bound check exists). */
  time: z.number().int().openapi({ type: "integer", format: "int64", description: "time in seconds" }),
  created: z.string().datetime({ offset: true }).optional().openapi({ description: "when the time was spent" }),
  user_name: z.string().optional().openapi({ description: "username of the user who spent the time working on the issue (optional)" }),
});

// ---------------------------------------------------------------------------
// Route declarations
// ---------------------------------------------------------------------------

const addAssigneesRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/issues/{index}/assignees",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Add assignees to an issue",
    operationId: "issueAddAssignees",
    request: {
      params: z.object({ ...issueIndexParams }),
      body: { content: { "application/json": { schema: issueAssigneesOption } }, required: true },
    },
    responses: {
      201: issueResponse,
      400: errorResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const removeAssigneesRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}/assignees",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Remove assignees from an issue",
    operationId: "issueRemoveAssignees",
    request: {
      params: z.object({ ...issueIndexParams }),
      body: { content: { "application/json": { schema: issueAssigneesOption } }, required: true },
    },
    responses: {
      200: issueResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const checkAssigneeRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/{index}/assignees/{assignee}",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "Check if a user can be assigned to an issue",
    operationId: "issueCheckAssignee",
    request: {
      params: z.object({
        ...issueIndexParams,
        assignee: z.string().min(1).openapi({ description: "username of the user to check for being an assignee" }),
      }),
    },
    responses: {
      204: emptyResponse,
      400: errorResponse,
      404: notFoundResponse,
    },
  });

const listDependenciesRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/{index}/dependencies",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "List an issue's dependencies, i.e all issues that block this issue.",
    operationId: "issueListIssueDependencies",
    request: {
      params: z.object({ ...issueIndexParams }),
      query: z.object({ ...pageLimitQuery }),
    },
    responses: {
      200: issueListResponse,
      404: notFoundResponse,
    },
  });

const createDependencyRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/issues/{index}/dependencies",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Make the issue in the url depend on the issue in the form.",
    operationId: "issueCreateIssueDependencies",
    request: {
      params: z.object({ ...issueIndexParams }),
      body: { content: { "application/json": { schema: issueMetaOption } }, required: true },
    },
    responses: {
      201: issueResponse,
      404: notFoundResponse,
      423: repoArchivedResponse,
    },
  });

const removeDependencyRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}/dependencies",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Remove an issue dependency",
    operationId: "issueRemoveIssueDependencies",
    request: {
      params: z.object({ ...issueIndexParams }),
      body: { content: { "application/json": { schema: issueMetaOption } }, required: true },
    },
    responses: {
      200: issueResponse,
      404: notFoundResponse,
      423: repoArchivedResponse,
    },
  });

const listBlocksRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/{index}/blocks",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "List issues that are blocked by this issue",
    operationId: "issueListBlocks",
    request: {
      params: z.object({ ...issueIndexParams }),
      query: z.object({ ...pageLimitQuery }),
    },
    responses: {
      200: issueListResponse,
      404: notFoundResponse,
    },
  });

const createBlockingRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/issues/{index}/blocks",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Block the issue given in the body by the issue in path",
    operationId: "issueCreateIssueBlocking",
    request: {
      params: z.object({ ...issueIndexParams }),
      body: { content: { "application/json": { schema: issueMetaOption } }, required: true },
    },
    responses: {
      201: issueResponse,
      404: notFoundResponse,
    },
  });

const removeBlockingRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}/blocks",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Unblock the issue given in the body by the issue in path",
    operationId: "issueRemoveIssueBlocking",
    request: {
      params: z.object({ ...issueIndexParams }),
      body: { content: { "application/json": { schema: issueMetaOption } }, required: true },
    },
    responses: {
      200: issueResponse,
      404: notFoundResponse,
    },
  });

const startStopwatchRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/issues/{index}/stopwatch/start",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Start stopwatch on an issue.",
    operationId: "issueStartStopWatch",
    request: {
      params: z.object({
        ...issueIndexParams,
        index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of the issue to create the stopwatch on" }),
      }),
    },
    responses: {
      201: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      409: { description: "Cannot start a stopwatch again if it already exists" },
    },
  });

const stopStopwatchRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/issues/{index}/stopwatch/stop",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Stop an issue's existing stopwatch.",
    operationId: "issueStopStopWatch",
    request: {
      params: z.object({
        ...issueIndexParams,
        index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of the issue to stop the stopwatch on" }),
      }),
    },
    responses: {
      201: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      409: { description: "Cannot stop a non-existent stopwatch" },
    },
  });

const deleteStopwatchRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}/stopwatch/delete",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Delete an issue's existing stopwatch.",
    operationId: "issueDeleteStopWatch",
    request: {
      params: z.object({
        ...issueIndexParams,
        index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of the issue to stop the stopwatch on" }),
      }),
    },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      409: { description: "Cannot cancel a non-existent stopwatch" },
    },
  });

const listTrackedTimesRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/issues/{index}/times",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "List an issue's tracked times",
    operationId: "issueTrackedTimes",
    request: {
      params: z.object({ ...issueIndexParams }),
      query: z.object({
        user: z.string().optional().openapi({ description: "optional filter by user (available for issue managers)" }),
        since: z.string().optional().openapi({ format: "date-time", description: "Only show times updated after the given time. This is a timestamp in RFC 3339 format" }),
        before: z.string().optional().openapi({ format: "date-time", description: "Only show times updated before the given time. This is a timestamp in RFC 3339 format" }),
        ...pageLimitQuery,
      }),
    },
    responses: {
      200: trackedTimeListResponse,
      404: notFoundResponse,
    },
  });

const addTimeRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/issues/{index}/times",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Add tracked time to a issue",
    operationId: "issueAddTime",
    request: {
      params: z.object({ ...issueIndexParams }),
      body: { content: { "application/json": { schema: addTimeOption } }, required: true },
    },
    responses: {
      200: trackedTimeResponse,
      400: errorResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const resetTimeRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}/times",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Reset a tracked time of an issue",
    operationId: "issueResetTime",
    request: {
      params: z.object({ ...issueIndexParams }),
    },
    responses: {
      204: emptyResponse,
      400: errorResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const deleteTimeRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}/times/{id}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Delete specific tracked time",
    operationId: "issueDeleteTime",
    request: {
      params: z.object({
        ...issueIndexParams,
        id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of time to delete" }),
      }),
    },
    responses: {
      204: emptyResponse,
      400: errorResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const newPinAllowedRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/new_pin_allowed",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Returns if new Issue Pins are allowed",
    operationId: "repoNewPinAllowed",
    request: {
      params: z.object({ ...ownerRepoParams }),
    },
    responses: {
      200: newIssuePinsAllowedResponse,
      404: notFoundResponse,
    },
  });

// ---------------------------------------------------------------------------
// Shared guards + plumbing (the issue-write-t2 file-local set)
// ---------------------------------------------------------------------------

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
function pathId(raw: string): number {
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Numeric rendering of the text registry id (services/issues.ts rule). */
function repoIdNumber(id: string): number {
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Go zero time for unset timestamps (convert's AsTimePtr of 0 → the zero). */
function isoOrGoZero(date: Date | null): string {
  return date === null ? GO_ZERO_TIME : date.toISOString();
}

/** Repo resolution + visibility — the anti-enumeration 404. */
async function requireVisibleRepoPair(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !canViewRepository(viewer, found.repo)) {
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

/**
 * The CanWriteIssuesOrPulls / CanUseTimetracker collapse — bare 403 like
 * upstream's `ctx.Status(http.StatusForbidden)` arms (empty message).
 * The two upstream checks share one predicate here: CanUseTimetracker adds
 * only the always-true timetracker-enabled clause (module header).
 */
async function assertIssueWriter(c: Context<ApiEnv>, found: RepositoryWithOwner): Promise<void> {
  if (!(await canWriteRepository(c, found))) {
    throw new ApiError(403, "");
  }
}

/** `mustNotBeArchived` (routers/api/v1/api.go:816) — 423 with that message. */
function assertNotArchived(found: RepositoryWithOwner): void {
  if (found.repo.isArchived) {
    throw new ApiError(423, "repo is archived");
  }
}

/** APIErrorNotFound() → 404 "not found" (services/context/api.go:137-142). */
function notFoundError(): ApiError {
  return new ApiError(404, "not found");
}

/** `ErrUserNotExist` text; the status is the caller's arm (404 via
 *  APIErrorAuto's ErrNotExist unwrap, 422 for the assignee-name binding). */
function userNotExistError(name: string, status: 404 | 422): ApiError {
  return new ApiError(status, `user does not exist [uid: 0, name: ${name}]`);
}

/** `util.SecToHours` port (modules/util/sec_to_time.go:15-40). */
function secToHours(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const unit = (value: number, name: string): string =>
    value === 1 ? `1 ${name} ` : value > 1 ? `${value} ${name}s ` : "";
  let out = `${unit(hours, "hour")}${unit(minutes, "minute")}`;
  if (out === "" && totalSeconds > 0) {
    out = unit(totalSeconds, "second");
  }
  return out.replace(/ $/, "");
}

// ---------------------------------------------------------------------------
// Assignees (models/issues/assignees.go + services/issue/assignee.go)
// ---------------------------------------------------------------------------

/** Assignee rows joined with their user rows, insertion (rowid) order —
 *  upstream LoadAssignees' natural-order user join (assignees.go:36-46). */
async function assigneeUserRows(d1: D1Database, issueId: number) {
  const rows = await drizzle(d1)
    .select({ user: users })
    .from(issueAssignees)
    .innerJoin(users, eq(users.id, issueAssignees.assigneeId))
    .where(eq(issueAssignees.issueId, issueId))
    .orderBy(asc(issueAssignees.id))
    .all();
  return rows.map((row) => row.user);
}

/**
 * CanBeAssigned (models/perm/access/repo_permission.go:588-598) collapsed
 * onto the landed ACL: write access to any unit, or read on the pulls unit
 * — a public repo grants every real user read; a private repo grants the
 * owner, site admins and collaborators (any mode — upstream pulls-unit
 * read covers read-mode collaborators too). Org rows are refused by the
 * caller (requireAssignable).
 */
async function canBeAssigned(d1: D1Database, found: RepositoryWithOwner, user: { id: number; isAdmin: boolean }): Promise<boolean> {
  if (found.repo.visibility === "public") {
    return true;
  }
  if (user.isAdmin) {
    return true;
  }
  if (found.repo.ownerId !== null && found.repo.ownerId === user.id) {
    return true;
  }
  return (await findCollaborator(d1, found.repo.id, user.id)) !== null;
}

/** validateAssignee (services/issue/assignee.go:172-183): an org row is
 *  CanBeAssigned's InvalidArgument → 400; the rest is the access error →
 *  403 (ErrUserDoesNotHaveAccessToRepo via APIErrorAuto, ErrPermissionDenied). */
async function requireAssignable(d1: D1Database, found: RepositoryWithOwner, user: { id: number; isAdmin: boolean; type: string }): Promise<void> {
  if (user.type === "org") {
    throw new ApiError(400, `organization can't be added as assignee [user_id: ${user.id}, repo_id: ${repoIdNumber(found.repo.id)}]`);
  }
  if (!(await canBeAssigned(d1, found, user))) {
    throw new ApiError(403, `user doesn't have access to repo [user_id: ${user.id}, repo_name: ${found.repo.slug}]`);
  }
}

/**
 * `GetDoerUserIDsByNames` (user.go:1237) — resolve the login list
 * case-insensitively; the FIRST miss aborts with the upstream 422
 * (updateIssueAssignees:201-209 answers the ErrNotExist text explicitly).
 */
async function resolveAssigneesByName(d1: D1Database, names: string[]) {
  const resolved = [];
  for (const name of names) {
    const user = await findUserByName(d1, name);
    if (user === null) {
      throw userNotExistError(name, 422);
    }
    resolved.push(user);
  }
  return resolved;
}

/**
 * The type-9 (assignees) comment + the num_comments fold, mirroring
 * toggleIssueAssignee (assignees.go:115-140): one comment per toggle with
 * the assignee id and the removed flag, poster = doer — one batch per
 * toggle (the guarded edge write has already committed by the time this
 * runs, so the per-toggle transaction is the honest grouping).
 */
async function writeAssigneeComment(d1: D1Database, issue: IssueRow, assigneeId: number, removed: boolean, actorId: number, now: Date): Promise<void> {
  await drizzle(d1).batch([
    drizzle(d1).insert(comments).values({
      type: CommentType.Assignees,
      posterId: actorId,
      issueId: issue.id,
      assigneeId,
      removedAssignee: removed ? 1 : 0,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
  ]);
}

/**
 * AddAssignees (services/issue/assignee.go:206-247) reduced: per NEW
 * assignee — the guarded insert (AddAssigneeIfNotAssigned) + the type-9
 * comment. Already-assigned users produce NO comment; a non-assignable
 * user aborts with the upstream 400/403 (validateAssignee) before its own
 * insert — earlier inserts of the same call stand (upstream's tx rolls the
 * whole add back; we keep the committed prefix, see header deviations).
 */
async function addIssueAssignees(
  d1: D1Database,
  issue: IssueRow,
  assignees: Array<{ id: number; isAdmin: boolean; type: string }>,
  found: RepositoryWithOwner,
  actorId: number,
  now: Date,
): Promise<void> {
  for (const user of assignees) {
    await requireAssignable(d1, found, user);
    const existing = await drizzle(d1)
      .select({ id: issueAssignees.id })
      .from(issueAssignees)
      .where(and(eq(issueAssignees.issueId, issue.id), eq(issueAssignees.assigneeId, user.id)))
      .limit(1)
      .then((rows) => rows[0]);
    if (existing !== undefined) {
      continue; // AddAssigneeIfNotAssigned: already assigned, nothing to do
    }
    const inserted = await drizzle(d1)
      .insert(issueAssignees)
      .values({ issueId: issue.id, assigneeId: user.id })
      .onConflictDoNothing()
      .returning({ id: issueAssignees.id });
    if (inserted.length === 0) {
      continue; // a concurrent add won the unique index — same skip
    }
    await writeAssigneeComment(d1, issue, user.id, false, actorId, now);
  }
}

/**
 * RemoveAssignees (services/issue/assignee.go:249-286) reduced: per
 * assigned user — the delete + the type-9 removal comment. Users not
 * assigned are skipped silently (isAssigned → continue).
 */
async function removeIssueAssignees(d1: D1Database, issue: IssueRow, assignees: Array<{ id: number }>, actorId: number, now: Date): Promise<void> {
  for (const user of assignees) {
    const removed = await drizzle(d1)
      .delete(issueAssignees)
      .where(and(eq(issueAssignees.issueId, issue.id), eq(issueAssignees.assigneeId, user.id)))
      .returning({ id: issueAssignees.id });
    if (removed.length === 0) {
      continue;
    }
    await writeAssigneeComment(d1, issue, user.id, true, actorId, now);
  }
}

/**
 * The issue wire with the assignee/assignees block filled (convert.ToIssue
 * issue.go:105-113 — the first assignee duplicated into `assignee`; empty
 * → both null). The landed toApiIssue renders null (its TODO); only THIS
 * family's responses carry the enrichment until the issues.ts owner folds
 * it in.
 */
async function toApiIssueWithAssignees(d1: D1Database, viewer: Viewer, found: RepositoryWithOwner, issue: IssueRow): Promise<Issue> {
  const [base, assigneeRows] = await Promise.all([toApiIssue(d1, viewer, found, issue), assigneeUserRows(d1, issue.id)]);
  if (assigneeRows.length === 0) {
    return base;
  }
  const rendered = assigneeRows.map((row) => apiUserFromRow(row, viewer));
  return { ...base, assignee: rendered[0] ?? null, assignees: rendered };
}

// ---------------------------------------------------------------------------
// Dependencies (models/issues/dependency.go + issue_dependency.go router)
// ---------------------------------------------------------------------------

/** The dependency edge shape: `target` (path issue) depends on
 *  `dependency` (form issue); both carry their repo pair. */
interface DependencySide {
  issue: IssueRow;
  repo: RepositoryWithOwner;
}

/**
 * `getFormIssue` (issue_dependency.go:471-495): same-repo fast path on the
 * exact owner/repo strings, else the cross-repo resolution (allowed — the
 * upstream default); a missing repo is the ErrRepoNotExist 404, an
 * invisible one the APIErrorNotFound 404, a missing issue the
 * ErrIssueNotExist 404.
 */
async function dependencySideFromMeta(
  c: Context<ApiEnv>,
  viewer: Viewer,
  found: RepositoryWithOwner,
  form: { index?: number; owner?: string; repo?: string },
): Promise<DependencySide> {
  if (form.owner === found.repo.ownerNamespace && form.repo === found.repo.slug) {
    const issue = await findIssueByRepoAndIndex(c.env.DB, found.repo.id, form.index ?? 0);
    if (issue === null) {
      throw issueErrorToApiError(new IssueNotExistError({ repoId: found.repo.id, index: form.index ?? 0 }));
    }
    return { issue, repo: found };
  }
  const foreign = await findRepositoryByPath(c.env.DB, form.owner ?? "", form.repo ?? "");
  if (foreign === null) {
    throw new ApiError(404, `repository does not exist [id: 0, uid: 0, owner_name: ${form.owner ?? ""}, name: ${form.repo ?? ""}]`);
  }
  if (!canViewRepository(viewer, foreign.repo)) {
    throw notFoundError();
  }
  const issue = await findIssueByRepoAndIndex(c.env.DB, foreign.repo.id, form.index ?? 0);
  if (issue === null) {
    throw issueErrorToApiError(new IssueNotExistError({ repoId: foreign.repo.id, index: form.index ?? 0 }));
  }
  return { issue, repo: foreign };
}

/**
 * The two type-19/20 dependency comments (createIssueDependencyComment,
 * models/issues/comment.go:997-1026): one on each issue, each carrying the
 * OTHER issue as `dependent_issue_id`, poster = doer, both num_comments
 * folds. One batch.
 */
async function dependencyComments(d1: D1Database, a: IssueRow, b: IssueRow, add: boolean, actorId: number, now: Date): Promise<void> {
  const type = add ? CommentType.AddDependency : CommentType.RemoveDependency;
  await drizzle(d1).batch([
    drizzle(d1).insert(comments).values({
      type,
      posterId: actorId,
      issueId: a.id,
      dependentIssueId: b.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, a.id)),
    drizzle(d1).insert(comments).values({
      type,
      posterId: actorId,
      issueId: b.id,
      dependentIssueId: a.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, b.id)),
  ] as const);
}

/**
 * CreateIssueDependency (models/issues/dependency.go:124-156): the edge
 * `(target depends on dependency)` with the duplicate and circular guards
 * — both APIErrorInternal 500s upstream (runtime-undeclared arms). The
 * edge insert and the two comments ride ONE batch (upstream: one tx).
 */
async function createDependencyEdge(d1: D1Database, actorId: number, target: IssueRow, dependency: IssueRow, now: Date): Promise<void> {
  const existing = await drizzle(d1)
    .select({ id: issueDependencies.id })
    .from(issueDependencies)
    .where(and(eq(issueDependencies.issueId, target.id), eq(issueDependencies.dependencyId, dependency.id)))
    .limit(1)
    .then((rows) => rows[0]);
  if (existing !== undefined) {
    throw new ApiError(500, `issue dependency does already exist [issue id: ${target.id}, dependency id: ${dependency.id}]`);
  }
  const circular = await drizzle(d1)
    .select({ id: issueDependencies.id })
    .from(issueDependencies)
    .where(and(eq(issueDependencies.issueId, dependency.id), eq(issueDependencies.dependencyId, target.id)))
    .limit(1)
    .then((rows) => rows[0]);
  if (circular !== undefined) {
    throw new ApiError(500, `circular dependencies exists (two issues blocking each other) [issue id: ${target.id}, dependency id: ${dependency.id}]`);
  }
  const type = CommentType.AddDependency;
  await drizzle(d1).batch([
    drizzle(d1).insert(issueDependencies).values({
      userId: actorId,
      issueId: target.id,
      dependencyId: dependency.id,
      createdAt: now,
    }),
    drizzle(d1).insert(comments).values({
      type,
      posterId: actorId,
      issueId: target.id,
      dependentIssueId: dependency.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, target.id)),
    drizzle(d1).insert(comments).values({
      type,
      posterId: actorId,
      issueId: dependency.id,
      dependentIssueId: target.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, dependency.id)),
  ] as const);
}

/**
 * RemoveIssueDependency (dependency.go:157-183): the guarded delete (0
 * rows is the APIErrorInternal 500 upstream) + the two removal comments.
 */
async function removeDependencyEdge(d1: D1Database, target: IssueRow, dependency: IssueRow, actorId: number, now: Date): Promise<void> {
  const removed = await drizzle(d1)
    .delete(issueDependencies)
    .where(and(eq(issueDependencies.issueId, target.id), eq(issueDependencies.dependencyId, dependency.id)))
    .returning({ id: issueDependencies.id });
  if (removed.length === 0) {
    throw new ApiError(500, `issue dependency does not exist [issue id: ${target.id}, dependency id: ${dependency.id}]`);
  }
  await dependencyComments(d1, target, dependency, false, actorId, now);
}

/**
 * The createIssueDependency/removeIssueDependency gates
 * (issue_dependency.go:511-561) in upstream order, collapsed:
 *   1. target repo archived → 404 (dependencies-enabled is always true —
 *      module header; the archived arm is unreachable behind
 *      mustNotBeArchived on the deps routes and live for FOREIGN targets
 *      on the blocks routes);
 *   2. target write (CanWriteIssuesOrPulls on the target's repo) → 404;
 *   3. dependency read → 404 (same repo: already proven by visibility).
 */
async function assertDependencyGates(c: Context<ApiEnv>, viewer: Viewer, target: DependencySide, dependency: DependencySide): Promise<void> {
  if (target.repo.repo.isArchived) {
    throw notFoundError();
  }
  if (!(await canWriteRepository(c, target.repo))) {
    throw notFoundError();
  }
  if (dependency.repo.repo.id !== target.repo.repo.id && !canViewRepository(viewer, dependency.repo.repo)) {
    throw notFoundError();
  }
}

/** One edge entry: the other issue with its repo row. */
interface EdgeEntry {
  issue: IssueRow;
  repo: RepositoryRow;
}

/**
 * The blockers of `issue` — edges `(issue, blocker)` read from the
 * dependency side, each joined with the blocker's repo row
 * (BlockedByDependencies, issue.go:670-688), upstream order: this repo's
 * blockers first, then created_unix DESC (:681-683).
 */
async function blockerRows(d1: D1Database, issue: IssueRow): Promise<EdgeEntry[]> {
  const edges = await drizzle(d1)
    .select({ dependencyId: issueDependencies.dependencyId })
    .from(issueDependencies)
    .where(eq(issueDependencies.issueId, issue.id))
    .all();
  return edgeIssueRows(d1, edges.map((edge) => edge.dependencyId), issue.repoId);
}

/**
 * The issues `issue` BLOCKS — edges `(dependent, issue)` read from the
 * dependent side (BlockingDependencies, issue.go:691-708), same order.
 */
async function blockedRows(d1: D1Database, issue: IssueRow): Promise<EdgeEntry[]> {
  const edges = await drizzle(d1)
    .select({ issueId: issueDependencies.issueId })
    .from(issueDependencies)
    .where(eq(issueDependencies.dependencyId, issue.id))
    .all();
  return edgeIssueRows(d1, edges.map((edge) => edge.issueId), issue.repoId);
}

/** Issue rows by id with their repos, in the upstream list order. */
async function edgeIssueRows(d1: D1Database, ids: number[], homeRepoId: string): Promise<EdgeEntry[]> {
  if (ids.length === 0) {
    return [];
  }
  const issueRows = await drizzle(d1).select().from(issues).where(inArray(issues.id, ids)).all();
  const repoIds = [...new Set(issueRows.map((row) => row.repoId))];
  const repoRows = await drizzle(d1).select().from(repositories).where(inArray(repositories.id, repoIds)).all();
  const repos = new Map(repoRows.map((repo) => [repo.id, repo]));
  return issueRows
    .map((row) => ({ issue: row, repo: repos.get(row.repoId) }))
    .filter((entry): entry is EdgeEntry => entry.repo !== undefined)
    .sort((a, b) => {
      const aRank = a.issue.repoId === homeRepoId ? 0 : repoIdNumber(a.issue.repoId);
      const bRank = b.issue.repoId === homeRepoId ? 0 : repoIdNumber(b.issue.repoId);
      if (aRank !== bRank) {
        return aRank - bRank;
      }
      return (b.issue.createdAt?.getTime() ?? 0) - (a.issue.createdAt?.getTime() ?? 0);
    });
}

/**
 * One dependency-list entry: same-repo or foreign-readable → the full
 * issue; foreign-unreadable → the header-notes redaction (HIDDEN for
 * non-writers, the confidential subset for writers).
 */
async function renderBlocker(
  c: Context<ApiEnv>,
  viewer: Viewer,
  found: RepositoryWithOwner,
  row: EdgeEntry,
  canWrite: boolean,
): Promise<Issue> {
  if (row.repo.id === found.repo.id) {
    return toApiIssue(c.env.DB, viewer, found, row.issue);
  }
  if (canViewRepository(viewer, row.repo)) {
    const pair = await findRepositoryById(c.env.DB, row.repo.id);
    if (pair !== null) {
      return toApiIssue(c.env.DB, viewer, pair, row.issue);
    }
  }
  if (canWrite) {
    // The confidential subset (issue_dependency.go:112-127).
    return {
      number: row.issue.index,
      title: row.issue.title,
      state: row.issue.isClosed ? "closed" : "open",
      repository: {
        id: repoIdNumber(row.repo.id),
        name: row.repo.slug,
        owner: row.repo.ownerNamespace,
        full_name: `${row.repo.ownerNamespace}/${row.repo.slug}`,
      },
    };
  }
  // The HIDDEN redaction (issue_dependency.go:105-110).
  return { title: "HIDDEN" };
}

// ---------------------------------------------------------------------------
// Stopwatch + tracked time (models/issues/stopwatch.go / tracked_time.go)
// ---------------------------------------------------------------------------

/** The doer's running stopwatch — at most one row per user exists
 *  (CreateIssueStopwatch, stopwatch.go:172-206). */
async function stopwatchOfUser(d1: D1Database, userId: number): Promise<{ id: number; issueId: number; createdAt: Date } | null> {
  const row = await drizzle(d1)
    .select({ id: issueStopwatches.id, issueId: issueStopwatches.issueId, createdAt: issueStopwatches.createdAt })
    .from(issueStopwatches)
    .where(eq(issueStopwatches.userId, userId))
    .limit(1)
    .then((rows) => rows[0]);
  return row ?? null;
}

/** The doer's stopwatch ON ONE ISSUE (getStopwatch, stopwatch.go:31-37). */
async function stopwatchOfIssue(d1: D1Database, userId: number, issueId: number): Promise<{ id: number; createdAt: Date } | null> {
  const row = await drizzle(d1)
    .select({ id: issueStopwatches.id, createdAt: issueStopwatches.createdAt })
    .from(issueStopwatches)
    .where(and(eq(issueStopwatches.userId, userId), eq(issueStopwatches.issueId, issueId)))
    .limit(1)
    .then((rows) => rows[0]);
  return row ?? null;
}

/**
 * finishIssueStopwatch (stopwatch.go:145-169): insert the tracked_time for
 * the elapsed seconds, the stop_tracking (13) comment with the SecToHours
 * content, the fold, and the stopwatch delete — one batch. DEVIATION: the
 * comment's time_id back-reference has no landed column (module header).
 */
async function finishStopwatch(d1: D1Database, issue: IssueRow, userId: number, stopwatch: { id: number; createdAt: Date }, now: Date): Promise<void> {
  const elapsed = Math.max(0, Math.floor((now.getTime() - stopwatch.createdAt.getTime()) / 1000));
  await drizzle(d1).batch([
    drizzle(d1).insert(trackedTimes).values({
      issueId: issue.id,
      userId,
      seconds: elapsed,
      createdAt: now,
    }),
    drizzle(d1).insert(comments).values({
      type: CommentType.StopTracking,
      posterId: userId,
      issueId: issue.id,
      content: secToHours(elapsed),
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
    drizzle(d1).delete(issueStopwatches).where(eq(issueStopwatches.id, stopwatch.id)),
  ] as const);
}

async function findIssueById(d1: D1Database, id: number): Promise<IssueRow | null> {
  const row = await drizzle(d1).select().from(issues).where(eq(issues.id, id)).limit(1).then((rows) => rows[0]);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function registerIssueTablesT2Routes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>, optionalAuth: MiddlewareHandler<ApiEnv>): void {
  // -------------------------------------------------------------------------
  // POST …/issues/{index}/assignees (issueAddAssignees) — writer-only,
  // archived-gated; per-name resolution (422), assignability (400 org /
  // 403 access); new assignees get the type-9 comment; 201 with the issue.
  // -------------------------------------------------------------------------
  app.openapi(addAssigneesRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    assertNotArchived(found);
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    await assertIssueWriter(c, found);
    const names = c.req.valid("json").assignees ?? [];
    const assignees = await resolveAssigneesByName(c.env.DB, names);
    await addIssueAssignees(c.env.DB, issue, assignees, found, requireDoerId(c), new Date());
    const reloaded = await findIssueByRepoAndIndex(c.env.DB, found.repo.id, issue.index);
    return c.json(await toApiIssueWithAssignees(c.env.DB, viewer, found, reloaded ?? issue), 201);
  });

  // -------------------------------------------------------------------------
  // DELETE …/issues/{index}/assignees (issueRemoveAssignees) — the removal
  // twin: assigned users drop with the type-9 removal comment; 200.
  // -------------------------------------------------------------------------
  app.openapi(removeAssigneesRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    assertNotArchived(found);
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    await assertIssueWriter(c, found);
    const names = c.req.valid("json").assignees ?? [];
    const assignees = await resolveAssigneesByName(c.env.DB, names);
    await removeIssueAssignees(c.env.DB, issue, assignees, requireDoerId(c), new Date());
    const reloaded = await findIssueByRepoAndIndex(c.env.DB, found.repo.id, issue.index);
    return c.json(await toApiIssueWithAssignees(c.env.DB, viewer, found, reloaded ?? issue), 200);
  });

  // -------------------------------------------------------------------------
  // GET …/issues/{index}/assignees/{assignee} (issueCheckAssignee) — an
  // assignABILITY probe (not current-assignment): 204 assignable, 400 org,
  // 404 unknown/invisible user.
  // -------------------------------------------------------------------------
  app.openapi(checkAssigneeRoute(optionalAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    await requireIssue(c, found, c.req.valid("param").index);
    const user = await findUserByName(c.env.DB, c.req.valid("param").assignee);
    if (user === null) {
      throw userNotExistError(c.req.valid("param").assignee, 404);
    }
    await requireAssignable(c.env.DB, found, user);
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // GET …/issues/{index}/dependencies (issueListIssueDependencies) — the
  // blockers of the issue, upstream order, paginated + counted; unreadable
  // foreign blockers redact per the module header.
  // -------------------------------------------------------------------------
  app.openapi(listDependenciesRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const rows = await blockerRows(c.env.DB, issue);
    const { page, limit } = parseListOptions(new URL(c.req.url));
    setPaginationHeaders(c, rows.length, { page, limit });
    const canWrite = await canWriteRepository(c, found);
    const rendered: Issue[] = [];
    for (const row of rows.slice((page - 1) * limit, page * limit)) {
      rendered.push(await renderBlocker(c, viewer, found, row, canWrite));
    }
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // POST …/issues/{index}/dependencies (issueCreateIssueDependencies) —
  // the path issue DEPENDS ON the form issue; 201 with the path issue.
  // -------------------------------------------------------------------------
  app.openapi(createDependencyRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    assertNotArchived(found);
    const target: DependencySide = { issue: await requireIssue(c, found, c.req.valid("param").index), repo: found };
    const dependency = await dependencySideFromMeta(c, viewer, found, c.req.valid("json"));
    await assertDependencyGates(c, viewer, target, dependency);
    await createDependencyEdge(c.env.DB, requireDoerId(c), target.issue, dependency.issue, new Date());
    const reloaded = await findIssueByRepoAndIndex(c.env.DB, found.repo.id, target.issue.index);
    return c.json(await toApiIssue(c.env.DB, viewer, found, reloaded ?? target.issue), 201);
  });

  // -------------------------------------------------------------------------
  // DELETE …/issues/{index}/dependencies (issueRemoveIssueDependencies) —
  // the detach twin; 200 (upstream sends 201 — header deviation).
  // -------------------------------------------------------------------------
  app.openapi(removeDependencyRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    assertNotArchived(found);
    const target: DependencySide = { issue: await requireIssue(c, found, c.req.valid("param").index), repo: found };
    const dependency = await dependencySideFromMeta(c, viewer, found, c.req.valid("json"));
    await assertDependencyGates(c, viewer, target, dependency);
    await removeDependencyEdge(c.env.DB, target.issue, dependency.issue, requireDoerId(c), new Date());
    const reloaded = await findIssueByRepoAndIndex(c.env.DB, found.repo.id, target.issue.index);
    return c.json(await toApiIssue(c.env.DB, viewer, found, reloaded ?? target.issue), 200);
  });

  // -------------------------------------------------------------------------
  // GET …/issues/{index}/blocks (issueListBlocks) — the issues BLOCKED BY
  // the path issue, same order; upstream paginates in memory and sets NO
  // total/link headers (issue_dependency.go:313-355) — mirrored.
  // -------------------------------------------------------------------------
  app.openapi(listBlocksRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const rows = await blockedRows(c.env.DB, issue);
    const { page, limit } = parseListOptions(new URL(c.req.url));
    const rendered: Issue[] = [];
    for (const row of rows.slice((page - 1) * limit, page * limit)) {
      // Upstream SKIPS unreadable foreign blockers here (no redaction).
      if (row.repo.id !== found.repo.id && !canViewRepository(viewer, row.repo)) {
        continue;
      }
      const pair = row.repo.id === found.repo.id ? found : await findRepositoryById(c.env.DB, row.repo.id);
      if (pair === null) {
        continue;
      }
      rendered.push(await toApiIssue(c.env.DB, viewer, pair, row.issue));
    }
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // POST …/issues/{index}/blocks (issueCreateIssueBlocking) — the PATH
  // issue BLOCKS the form issue: the edge is (form issue depends on path
  // issue); 201 with the PATH issue's wire (issue_dependency.go:411).
  // -------------------------------------------------------------------------
  app.openapi(createBlockingRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const dependency: DependencySide = { issue: await requireIssue(c, found, c.req.valid("param").index), repo: found };
    const target = await dependencySideFromMeta(c, viewer, found, c.req.valid("json"));
    await assertDependencyGates(c, viewer, target, dependency);
    await createDependencyEdge(c.env.DB, requireDoerId(c), target.issue, dependency.issue, new Date());
    return c.json(await toApiIssue(c.env.DB, viewer, found, dependency.issue), 201);
  });

  // -------------------------------------------------------------------------
  // DELETE …/issues/{index}/blocks (issueRemoveIssueBlocking) — the detach
  // twin; 200 with the path issue (upstream sends 201 — header deviation).
  // -------------------------------------------------------------------------
  app.openapi(removeBlockingRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const dependency: DependencySide = { issue: await requireIssue(c, found, c.req.valid("param").index), repo: found };
    const target = await dependencySideFromMeta(c, viewer, found, c.req.valid("json"));
    await assertDependencyGates(c, viewer, target, dependency);
    await removeDependencyEdge(c.env.DB, target.issue, dependency.issue, requireDoerId(c), new Date());
    return c.json(await toApiIssue(c.env.DB, viewer, found, dependency.issue), 200);
  });

  // -------------------------------------------------------------------------
  // POST …/issues/{index}/stopwatch/start (issueStartStopWatch) — one
  // running stopwatch per user: a start on another issue first FINISHES it
  // (tracked time + stop comment); a re-start here is the 409.
  // -------------------------------------------------------------------------
  app.openapi(startStopwatchRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    await assertIssueWriter(c, found);
    const doerId = requireDoerId(c);
    const now = new Date();
    const running = await stopwatchOfUser(c.env.DB, doerId);
    if (running !== null && running.issueId === issue.id) {
      throw new ApiError(409, "cannot start a stopwatch again if it already exists");
    }
    if (running !== null) {
      // CreateIssueStopwatch: finish the other issue's stopwatch first.
      const other = await findIssueById(c.env.DB, running.issueId);
      if (other !== null) {
        await finishStopwatch(c.env.DB, other, doerId, running, now);
      } else {
        await drizzle(c.env.DB).delete(issueStopwatches).where(eq(issueStopwatches.id, running.id));
      }
    }
    await drizzle(c.env.DB).batch([
      drizzle(c.env.DB).insert(issueStopwatches).values({ issueId: issue.id, userId: doerId, createdAt: now }),
      drizzle(c.env.DB).insert(comments).values({
        type: CommentType.StartTracking,
        posterId: doerId,
        issueId: issue.id,
        content: "",
        createdAt: now,
        updatedAt: now,
      }),
      drizzle(c.env.DB).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
    ] as const);
    return c.body(null, 201);
  });

  // -------------------------------------------------------------------------
  // POST …/issues/{index}/stopwatch/stop (issueStopStopWatch) — stop the
  // (user, issue) stopwatch, banking the elapsed tracked time; the
  // non-existent arm is the 409.
  // -------------------------------------------------------------------------
  app.openapi(stopStopwatchRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    await assertIssueWriter(c, found);
    const doerId = requireDoerId(c);
    const stopwatch = await stopwatchOfIssue(c.env.DB, doerId, issue.id);
    if (stopwatch === null) {
      throw new ApiError(409, "cannot stop a non-existent stopwatch");
    }
    await finishStopwatch(c.env.DB, issue, doerId, stopwatch, new Date());
    return c.body(null, 201);
  });

  // -------------------------------------------------------------------------
  // DELETE …/issues/{index}/stopwatch/delete (issueDeleteStopWatch) —
  // discard the stopwatch WITHOUT banking the time (the cancel_tracking
  // comment); the non-existent arm is the 409.
  // -------------------------------------------------------------------------
  app.openapi(deleteStopwatchRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    await assertIssueWriter(c, found);
    const doerId = requireDoerId(c);
    const now = new Date();
    const stopwatch = await stopwatchOfIssue(c.env.DB, doerId, issue.id);
    if (stopwatch === null) {
      throw new ApiError(409, "cannot cancel a non-existent stopwatch");
    }
    await drizzle(c.env.DB).batch([
      drizzle(c.env.DB).delete(issueStopwatches).where(eq(issueStopwatches.id, stopwatch.id)),
      drizzle(c.env.DB).insert(comments).values({
        type: CommentType.CancelTracking,
        posterId: doerId,
        issueId: issue.id,
        content: "",
        createdAt: now,
        updatedAt: now,
      }),
      drizzle(c.env.DB).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
    ] as const);
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // GET …/issues/{index}/times (issueTrackedTimes) — the issue's tracked
  // times with the user filter's rights collapse (cantSetUser,
  // issue_tracked_time.go:108-119) and the since/before RFC3339 filters;
  // deleted entries stay hidden.
  // -------------------------------------------------------------------------
  app.openapi(listTrackedTimesRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const doerId = requireDoerId(c);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);

    const qUser = (url.searchParams.get("user") ?? "").trim();
    let userFilter = 0;
    if (qUser !== "") {
      const user = await findUserByName(c.env.DB, qUser);
      if (user === null) {
        throw userNotExistError(qUser, 404);
      }
      userFilter = user.id;
    }
    const since = parseQueryTime(url.searchParams.get("since"));
    const before = parseQueryTime(url.searchParams.get("before"));

    // cantSetUser: only site admins and repo writers may filter by another
    // user; non-writers are scoped to their own rows.
    const cantSetUser =
      viewer.requester?.is_admin !== true && userFilter !== doerId && !(await canWriteRepository(c, found));
    if (cantSetUser) {
      if (userFilter === 0) {
        userFilter = doerId;
      } else {
        throw new ApiError(403, "query by user not allowed; not enough rights");
      }
    }

    const conditions = [eq(trackedTimes.issueId, issue.id), eq(trackedTimes.deleted, false)];
    if (userFilter !== 0) {
      conditions.push(eq(trackedTimes.userId, userFilter));
    }
    if (since !== null) {
      conditions.push(gte(trackedTimes.createdAt, new Date(since * 1000)));
    }
    if (before !== null) {
      conditions.push(lt(trackedTimes.createdAt, new Date(before * 1000)));
    }

    const rows = await drizzle(c.env.DB)
      .select({ time: trackedTimes, userName: users.username })
      .from(trackedTimes)
      .leftJoin(users, eq(users.id, trackedTimes.userId))
      .where(and(...conditions))
      .orderBy(asc(trackedTimes.id))
      .all();
    setPaginationHeaders(c, rows.length, { page, limit });
    const rendered = await Promise.all(
      rows.slice((page - 1) * limit, page * limit).map(async (row) => ({
        id: row.time.id,
        issue_id: row.time.issueId,
        issue: await toApiIssue(c.env.DB, viewer, found, issue),
        time: row.time.seconds,
        created: isoOrGoZero(row.time.createdAt),
        user_id: row.time.userId,
        user_name: row.userName ?? "",
      })),
    );
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // POST …/issues/{index}/times (issueAddTime) — manual entry; the
  // user_name override needs repo admin or site admin (AddTime:217-228);
  // writes the add_time_manual (14) comment with the `|<seconds>` marker
  // content (tracked_time.go:185-193).
  // -------------------------------------------------------------------------
  app.openapi(addTimeRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const doerId = requireDoerId(c);
    // CanUseTimetracker (repo.go:270): the "time tracking disabled" 400 is
    // unreachable while the timetracker has no settings module; the writer
    // arm is the live bare 403 (AddTime:213).
    if (!(await canWriteRepository(c, found)) && viewer.requester?.is_admin !== true) {
      throw new ApiError(403, "");
    }
    const body = c.req.valid("json");
    let userId = doerId;
    if ((body.user_name ?? "") !== "" && (viewer.requester?.is_admin === true || (await isRepositoryAdmin(c, found)))) {
      const user = await findUserByName(c.env.DB, body.user_name ?? "");
      if (user === null) {
        throw userNotExistError(body.user_name ?? "", 404);
      }
      userId = user.id;
    }
    const now = new Date();
    const created = body.created !== undefined && body.created !== null ? new Date(body.created) : now;
    const result = await drizzle(c.env.DB).batch([
      drizzle(c.env.DB)
        .insert(trackedTimes)
        .values({ issueId: issue.id, userId, seconds: body.time, createdAt: created })
        .returning({ id: trackedTimes.id }),
      drizzle(c.env.DB).insert(comments).values({
        type: CommentType.AddTimeManual,
        posterId: doerId,
        issueId: issue.id,
        content: `|${body.time}`,
        createdAt: now,
        updatedAt: now,
      }),
      drizzle(c.env.DB).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
    ] as const);
    const insertedId = result[0][0]?.id;
    const userRow = await findUserRowById(c.env.DB, userId);
    return c.json(
      {
        id: insertedId,
        issue_id: issue.id,
        issue: await toApiIssue(c.env.DB, viewer, found, issue),
        time: body.time,
        created: created.toISOString(),
        user_id: userId,
        user_name: userRow?.username ?? "",
      },
      200,
    );
  });

  // -------------------------------------------------------------------------
  // DELETE …/issues/{index}/times (issueResetTime) — soft-deletes the
  // DOER'S OWN entries (not everyone's, ResetIssueTime:297); the zero-sum
  // arm answers the upstream 404 (DeleteIssueUserTimes' ErrNotExist,
  // tracked_time.go:250).
  // -------------------------------------------------------------------------
  app.openapi(resetTimeRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const doerId = requireDoerId(c);
    // CanUseTimetracker collapse — the bare 403 (ResetIssueTime:293).
    if (!(await canWriteRepository(c, found)) && viewerOf(c).requester?.is_admin !== true) {
      throw new ApiError(403, "");
    }
    const ownFilter = and(
      eq(trackedTimes.issueId, issue.id),
      eq(trackedTimes.userId, doerId),
      eq(trackedTimes.deleted, false),
    );
    const own = await drizzle(c.env.DB).select({ seconds: trackedTimes.seconds }).from(trackedTimes).where(ownFilter).all();
    const removedSeconds = own.reduce((sum, row) => sum + row.seconds, 0);
    if (removedSeconds === 0) {
      // Upstream keys the guard on the SUM (removedTime == 0), not the row
      // count — a lone 0-second entry answers 404 and deletes nothing.
      throw new ApiError(404, "tracked_time does not exist");
    }
    await drizzle(c.env.DB).batch([
      drizzle(c.env.DB).update(trackedTimes).set({ deleted: true }).where(ownFilter),
      drizzle(c.env.DB).insert(comments).values({
        type: CommentType.DeleteTimeManual,
        posterId: doerId,
        issueId: issue.id,
        content: `|${removedSeconds}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      drizzle(c.env.DB).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
    ] as const);
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // DELETE …/issues/{index}/times/{id} (issueDeleteTime) — soft-delete ONE
  // entry; only its owner or a site admin (DeleteTime:375-379); the
  // type-26 comment is posted by the ENTRY'S owner (upstream Doer: t.User).
  // -------------------------------------------------------------------------
  app.openapi(deleteTimeRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index);
    const doerId = requireDoerId(c);
    // CanUseTimetracker collapse — the bare 403 (DeleteTime:361).
    if (!(await canWriteRepository(c, found)) && viewer.requester?.is_admin !== true) {
      throw new ApiError(403, "");
    }
    const id = pathId(c.req.valid("param").id);
    const row = await drizzle(c.env.DB)
      .select()
      .from(trackedTimes)
      .where(and(eq(trackedTimes.issueId, issue.id), eq(trackedTimes.id, id)))
      .limit(1)
      .then((rows) => rows[0]);
    if (row === undefined) {
      // db.ErrNotExist{Resource: "tracked_time", ID} — the id-less form
      // drops the [id: …] suffix (models/db/error.go:53-64).
      throw new ApiError(404, id === 0 ? "tracked_time does not exist" : `tracked_time does not exist [id: ${id}]`);
    }
    if (row.deleted) {
      throw new ApiError(404, "tracked time was already deleted");
    }
    if (viewer.requester?.is_admin !== true && row.userId !== doerId) {
      throw new ApiError(403, "");
    }
    const now = new Date();
    await drizzle(c.env.DB).batch([
      drizzle(c.env.DB).update(trackedTimes).set({ deleted: true }).where(eq(trackedTimes.id, row.id)),
      drizzle(c.env.DB).insert(comments).values({
        type: CommentType.DeleteTimeManual,
        posterId: row.userId,
        issueId: issue.id,
        content: `|${row.seconds}`,
        createdAt: now,
        updatedAt: now,
      }),
      drizzle(c.env.DB).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
    ] as const);
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/new_pin_allowed (repoNewPinAllowed) — the
  // pin-cap probe: count per issue/pull half vs the MaxPinned default the
  // landed pin routes model. Anonymous per upstream (api.go:1546).
  // -------------------------------------------------------------------------
  app.openapi(newPinAllowedRoute(optionalAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const rows = await drizzle(c.env.DB)
      .select({ isPull: issues.isPull })
      .from(issuePins)
      .innerJoin(issues, eq(issues.id, issuePins.issueId))
      .where(eq(issuePins.repoId, found.repo.id))
      .all();
    const countIssues = rows.filter((row) => !row.isPull).length;
    const countPulls = rows.length - countIssues;
    return c.json({ issues: countIssues < MAX_PINNED_PER_TYPE, pull_requests: countPulls < MAX_PINNED_PER_TYPE }, 200);
  });
}

/** `setting.Repository.Issue.MaxPinned` default (repository.go:223) — the
 *  landed issue-write-t2 pin routes enforce the same cap. */
const MAX_PINNED_PER_TYPE = 3;

async function findUserRowById(d1: D1Database, id: number) {
  const row = await drizzle(d1)
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .then((rows) => rows[0]);
  return row ?? null;
}

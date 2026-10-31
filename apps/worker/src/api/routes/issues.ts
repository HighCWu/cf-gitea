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
import { canWriteRepository, isRepositoryAdmin } from "../services/repo-access";
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
import { assertNotBlockedForIssueContent, assertNotBlockedForIssueCreate } from "../services/blocks";
import { toApiLabel } from "../services/labels";
import {
  changeIssueBody,
  changeIssueDeadline,
  changeIssueMilestone,
  changeIssueRef,
  commentHasContentSupport,
  commentNotExistError,
  deleteComment,
  deleteIssueCascade,
  findIssueByRepoAndIndex,
  findRepoCommentById,
  issueDeleteEmission,
  issueErrorToApiError,
  issueLabelApiUrlBase,
  issueLabelRows,
  labelIdsByGlobalNames,
  labelIdsByOrgNames,
  labelIdsByRepoNames,
  labelNamesByIds,
  listIssueComments,
  listIssueTimeline,
  listRepoComments,
  listRepoIssues,
  milestoneIdsByGlobalNames,
  milestoneIdsByRepoEntries,
  parseQueryTime,
  parseStateFilter,
  parseTypeFilter,
  prefetchCommentPosters,
  prefetchIssueRenderContext,
  prefetchTimelineContext,
  searchIssuesGlobally,
  toApiComment,
  toApiIssue,
  toApiIssueWithAssignees,
  toTimelineComment,
  updateCommentBody,
  userIdForFilter,
  userNotExistError,
  userRowByName,
  visibleRepoIds,
} from "../services/issues";
import {
  assertIssueRowUnit,
  assertIssuesOrPullsUnit,
  assertIssuesUnitReadable,
  narrowIssueListType,
  type IssuePullUnits,
} from "../services/issue-unit-gates";
import { parseMilestoneDeadline } from "../services/milestones";
import { pullRequestDiffShortStat } from "../services/pull-engine";
import { toApiPullRequest } from "../services/pulls";
import {
  apiUserFromRow,
  canViewRepositoryWithTeams,
  findRepositoriesByIds,
  findRepositoryByPath,
  formBool,
  repositoryPermissions,
  viewerOf,
  type RepositoryWithOwner,
  type UserRow,
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
 *                                   Go bind would 422), 422/400 (unknown
 *                                   assignee login / org assignee — the
 *                                   shared UpdateAssignees resolution;
 *                                   upstream's issues-PATCH arm maps neither
 *                                   and would 500, issue.go:780-783)
 *   - POST …/comments:              422 (Go-bind Required on the comment
 *                                   body, structs/issue_comment.go:37) and
 *   - PATCH …/comments/{id}:        422 (same rule on the edit arm, :45) —
 *                                   both declared runtime-only (the contract
 *                                   omits them); malformed JSON still takes
 *                                   hono's 400
 *   - POST/PUT …/labels:            400 (mixed id+name array equivalents —
 *                                   upstream 400 undeclared)
 *   - PATCH …/comments/{id}:        204-family edit of a system comment
 *                                   (upstream returns empty 204)
 *   - DELETE …/comments/{id}:       400 (system comments have no deletable
 *                                   content — upstream StatusBadRequest)
 * UNIT gates (SPEC parity: the mustEnableIssuesOrPulls group middleware,
 * api.go:1674 + api.go:720-746): every route under /repos/{owner}/{repo}/
 * issues/* answers the bare 404 "not found" once the repo's issues AND pulls
 * units are both unreadable (services/issue-unit-gates.ts — the enabled
 * state rides the repo_settings has_issues/has_pull_requests flags), mounted
 * inside requireVisibleRepo below so it runs at upstream's exact chain
 * position (after repo resolution, before the handler). The in-handler
 * narrowing rides the same units: the list `type` filter collapses/404s per
 * unit readability (issue.go:375-390), every issue-by-index lookup 404s on
 * an issue whose own unit is unreadable (getRepoIssueByIndexForDoer,
 * issue.go:998-1009), and the global-comment GET narrows on its issue's unit
 * (issue_comment.go:440). POST issues additionally carries the route-level
 * `reqRepoReader(unit.TypeIssues)` arm (api.go:1576) AFTER the archived 423,
 * upstream's order. The repo-level /labels and /milestones groups carry NO
 * unit gate upstream (api.go:1675-1688) — reads stay 200 on unit-less repos.
 * The 412 family stays DECLARED-but-unreachable for POST/PATCH issues (the
 * merged-PR arm is PATCH's only live 412).
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
 * milestoned/demilestoned, no `changes` block). The PATCH assignee replace
 * (the shared replaceIssueAssignees service, EditIssue → UpdateAssignees,
 * issue.go:772-779) emits `issue_assign` / `pull_request_assign` the same
 * way — emitAssignEvent (IssueChangeAssignee:161-202; ONE assigned/unassigned
 * event per actually-changed assignee, the one-element
 * changes.added_assignees/removed_assignees side, no events on a no-op).
 *
 * Org labels on org-owned repos (pin survey fc49368845): upstream lets an
 * org's labels ride the repo's issues — the attach/replace arms
 * (prepareForReplaceOrAdd, routers/api/v1/repo/issue_label.go:304-370)
 * resolve NAMES the repo does not carry against the owner org (:342-359, the
 * pin's 7448b49aac repo-wins semantics) and ids validate repo-or-owner-org
 * scoped here (upstream's id branch reads the unscoped GetLabelsByIDs,
 * models/issues/label.go:317-327 — it silently drops unknown ids and
 * over-accepts foreign-repo ids at this pin; our miss is the landed scoped
 * 404, the same shape as the DELETE arm's GetLabelInRepoOrOrgByID,
 * label.go:344-354 — deliberate divergence). Attached org rows render the
 * org API URL (convert.ToLabel's org branch, services/convert/issue.go:
 * 269-280). The repo label ADMIN list does NOT union (repo/label.go:52,58) —
 * surveyed in services/labels.ts listRepoLabels.
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

/** Body bind hook for the operations with a declared 422 (POST issues plus
 *  the comment create/edit arms): upstream's Go bind answers malformed or
 *  Required-failing bodies with 422 (api.go:838-845 → APIErrorValidation);
 *  the generic text stands in for Go's per-field message. The operations
 *  without a declared 422 keep hono's default 400 (file header). */
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

/** Shared repo resolution — the anti-enumeration 404 (SPEC-0004 §2.4) —
 *  closed by the issues-group UNIT gate at upstream's chain position: the
 *  `mustEnableIssuesOrPulls` middleware wraps this whole subtree after
 *  repoAssignment (api.go:1674, api.go:720-746), so a repo whose issues and
 *  pulls units are both unreadable 404s every route here before any handler
 *  body runs. The resolved units ride along for the handler-level narrowing. */
async function requireVisibleRepo(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
    throw new ApiError(404, "not found");
  }
  const units = await assertIssuesOrPullsUnit(c.env.DB, found);
  return { viewer, found, units };
}

/** `mustNotBeArchived` (routers/api/v1/api.go:816) — 423 with that message. */
function assertNotArchived(found: RepositoryWithOwner): void {
  if (found.repo.isArchived) {
    throw new ApiError(423, "repo is archived");
  }
}

/** Issue-by-index lookup answering the upstream ErrIssueNotExist 404, then
 *  `getRepoIssueByIndexForDoer`'s unit narrowing (issue.go:998-1009): an
 *  issue whose own unit (issues vs pulls) is unreadable is the same bare 404
 *  — a plain issue hides on a pulls-fallback repo. */
async function requireIssue(c: Context<ApiEnv>, found: RepositoryWithOwner, rawIndex: string, units: IssuePullUnits): Promise<IssueRow> {
  const index = pathId(rawIndex);
  const issue = await findIssueByRepoAndIndex(c.env.DB, found.repo.id, index);
  if (issue === null) {
    throw issueErrorToApiError(new IssueNotExistError({ repoId: found.repo.id, index }));
  }
  assertIssueRowUnit(units, issue.isPull);
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
      // Upstream renders the comment payload issue through the SHARED
      // ToAPIIssue on BOTH arms (UpdateComment:447, DeleteComment:523 —
      // LoadAssignees, the real set), so the default wire render.
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
 * upstream's label notifiers set none. BOTH arms render the payload issue
 * through the SHARED converter — upstream's issue arm is convert.ToAPIIssue
 * (IssueChangeLabels:598-604) and its pull arm ToPayloadPullRequest
 * (IssueChangeLabels:601-606, IssueClearLabels:63-69; pull.go:31-34) — so the
 * assignee block is the real set, the wire render (ToAPIIssue LoadAssignees,
 * services/convert/issue.go:105-112), exactly like the detach twin
 * emitLabelDetachEvent. The pull arm rides toApiPullRequest's "payload" mode
 * (the head repo shows regardless of the doer — pull.go:33-37, :197); a
 * missing PR row skips the emission (upstream's LoadPullRequest failure logs
 * and returns before PrepareWebhooks).
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
    // The diff-stat trio rides the same conversion (the single converter's
    // GetDiffShortStat block runs on EVERY single AND payload render,
    // convert/pull.go:230-254; the omit arms — no merge base, truncated
    // walk, engine failure :247-250 — stay omitted).
    const diffStats = await pullRequestDiffShortStat(c, found, pr);
    await emitIssueEvent(c, {
      repoId: found.repo.id,
      ownerId: event.ownerId,
      eventType: "pull_request_label",
      payload: pullRequestEventPayload(
        action,
        await toApiPullRequest(c.env.DB, viewerOf(c), found, issue, pr, "payload", diffStats === null ? undefined : { diffStats }),
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
    payload: issueEventPayload(
      action,
      // Upstream renders the label payload issue through the SHARED ToAPIIssue
      // (IssueChangeLabels:600 / IssueClearLabels:74 — LoadAssignees, the real
      // set), so the default wire render — no emission pin.
      await toApiIssue(c.env.DB, viewerOf(c), found, issue),
      issue.index,
      event.repository,
      event.sender,
    ),
  });
}

/**
 * The milestone set/clear webhook: `issue_milestone` / `pull_request_milestone`
 * picked by the upstream `issue.IsPull` discriminant (services/webhook/
 * notifier.go IssueChangeMilestone:618-647). action=milestoned when the issue
 * now carries a milestone, demilestoned on the clear (structs/hook.go:422-425
 * — NOT entered/exited); the payload is the shared Issue/PullRequest wrapper
 * with NO `changes` block — upstream's milestone notifier sets none. The pull
 * arm renders ToPayloadPullRequest through toApiPullRequest's "payload" mode
 * (the head repo shows regardless of the doer — pull.go:33-37, :197); a
 * missing PR row skips the emission (the label events' LoadPullRequest
 * degradation).
 */
export async function emitMilestoneEvent(
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
    // The diff-stat trio rides the same conversion (the single converter's
    // GetDiffShortStat block runs on EVERY single AND payload render,
    // convert/pull.go:230-254; the omit arms — no merge base, truncated
    // walk, engine failure :247-250 — stay omitted).
    const diffStats = await pullRequestDiffShortStat(c, found, pr);
    await emitIssueEvent(c, {
      repoId: found.repo.id,
      ownerId: event.ownerId,
      eventType: "pull_request_milestone",
      payload: pullRequestEventPayload(
        action,
        await toApiPullRequest(c.env.DB, viewerOf(c), found, issue, pr, "payload", diffStats === null ? undefined : { diffStats }),
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
    payload: issueEventPayload(
      action,
      // Upstream renders the milestone payload issue through the SHARED
      // ToAPIIssue (IssueChangeMilestone:650 — LoadAssignees, the real set),
      // so the default wire render.
      await toApiIssue(c.env.DB, viewerOf(c), found, issue),
      issue.index,
      event.repository,
      event.sender,
    ),
  });
}

/**
 * The assignee set/clear webhook: `issue_assign` / `pull_request_assign`
 * picked by the upstream `issue.IsPull` discriminant (services/webhook/
 * notifier.go IssueChangeAssignee:161-202 — action=assigned, flipping to
 * unassigned with `changes.removed_assignees` on the removed arm :163-168;
 * the IsPull arm :169-187 emits HookEventPullRequestAssign :186 with the
 * PullRequestPayload, the issue arm :188-202 HookEventIssueAssign :200 with
 * the IssuePayload; HookEventIssueAssign/HookEventPullRequestAssign are
 * modules/webhook/type.go:16/:21). ONE event per actually-changed assignee,
 * in the post-write notify position upstream's UpdateAssignees holds
 * (services/issue/assignee.go:155-166) — the shared replaceIssueAssignees
 * core invokes the emitter once per change, removals before adds.
 * `changes` carries the ONE-ELEMENT added_assignees/removed_assignees side
 * (ChangesPayload, hook.go:486-489 — the lists are omitempty, only the
 * changed side is set); both payloads carry the non-omitempty `commit_id: ""`
 * (hook.go:435 IssuePayload / :484 PullRequestPayload).
 *
 * The pull arm renders upstream's ToPayloadPullRequest through
 * toApiPullRequest's "payload" mode (the head repo shows regardless of the
 * doer — pull.go:33-37, :197); a missing PR row skips the emission (the
 * label/milestone pull-arm degradation). The issue arm renders the POST-
 * change assignee set (upstream ToAPIIssue LoadAssignees) through the
 * service's canonical enriched render — since the assignee fold, that IS
 * `toApiIssue`'s wire render and this call is its named alias
 * (services/issues.ts toApiIssueWithAssignees).
 */
export async function emitAssignEvent(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  issue: IssueRow,
  assignee: UserRow,
  removed: boolean,
): Promise<void> {
  const event = issueEventContext(c, found);
  const changes = removed
    ? { removed_assignees: [apiUserFromRow(assignee, viewerOf(c))] }
    : { added_assignees: [apiUserFromRow(assignee, viewerOf(c))] };
  const action = removed ? "unassigned" : "assigned";
  if (issue.isPull) {
    const pr = await findPullRequestRowByIssueId(c.env.DB, issue.id);
    if (pr === null) {
      return;
    }
    // The diff-stat trio rides the same conversion (the single converter's
    // GetDiffShortStat block runs on EVERY single AND payload render,
    // convert/pull.go:230-254; the omit arms — no merge base, truncated
    // walk, engine failure :247-250 — stay omitted).
    const diffStats = await pullRequestDiffShortStat(c, found, pr);
    await emitIssueEvent(c, {
      repoId: found.repo.id,
      ownerId: event.ownerId,
      eventType: "pull_request_assign",
      payload: pullRequestEventPayload(
        action,
        await toApiPullRequest(c.env.DB, viewerOf(c), found, issue, pr, "payload", diffStats === null ? undefined : { diffStats }),
        issue.index,
        event.repository,
        event.sender,
        { changes },
      ),
    });
    return;
  }
  await emitIssueEvent(c, {
    repoId: found.repo.id,
    ownerId: event.ownerId,
    eventType: "issue_assign",
    payload: {
      action,
      number: issue.index,
      changes,
      issue: await toApiIssueWithAssignees(c.env.DB, viewerOf(c), found, issue),
      repository: event.repository,
      sender: event.sender,
      commit_id: "",
    },
  });
}

/**
 * `IssueLabelsOption` id/name resolution (prepareForReplaceOrAdd,
 * routers/api/v1/repo/issue_label.go:304-370): integers are ids, strings are
 * names; a mixed array is the runtime 400, unknown names silently drop
 * (GetLabelIDsInRepoByNames). On ORG-owned repos the names the repo does not
 * carry fall through to the owner org (:342-359 — the pin's 7448b49aac
 * repo-wins rule: a name carried by both attaches the repo label only); ids
 * pass through to the service's scoped validation (repo rows, plus owner-org
 * rows on org-owned repos — see ownerOrgIdOf).
 */
async function resolveLabelOptionIds(
  d1: D1Database,
  found: RepositoryWithOwner,
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
    const repoLabelIds = await labelIdsByRepoNames(d1, found.repo.id, names);
    ids.push(...repoLabelIds);
    if (found.owner.type === "org") {
      // The unmatched-name set: upstream re-reads the repo-matched names
      // (GetLabelsByIDs(ctx, repoLabelIDs, "name"), issue_label.go:343)
      // and resolves only the remainder against the org.
      const repoMatched = await labelNamesByIds(d1, repoLabelIds);
      const orgNames = names.filter((name) => !repoMatched.has(name));
      ids.push(...(await labelIdsByOrgNames(d1, found.owner.id, [...new Set(orgNames)])));
    }
  }
  return ids;
}

/**
 * The owner-org scope of issue-label mutations — the `ownerIsOrg`
 * discriminant of GetLabelInRepoOrOrgByID (models/issues/label.go:348):
 * null on user-owned repos, the owner user-row id on org-owned ones (the
 * IssuesService then accepts that org's labels alongside repo labels).
 */
function ownerOrgIdOf(found: RepositoryWithOwner): number | null {
  return found.owner.type === "org" ? found.owner.id : null;
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
      422: validationErrorResponse,
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
      422: validationErrorResponse,
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
        // The five doer-flags parse through upstream's FormBool — Go form
        // coercion never 400s, so the schema stays a LENIENT string with
        // the contract's `boolean` type overridden onto the generated
        // document (the repo-search formBoolParam precedent,
        // routes/repo.ts:111-115). A strict z.boolean() here rejected
        // `?mentioned=true` with a ZodError 400 the moment the flag grew a
        // real filter (the pre-wiring stubs never exercised it).
        assigned: z.string().optional().openapi({ type: "boolean", description: "Filter (issues / pulls) assigned to the authenticated user" }),
        created: z.string().optional().openapi({ type: "boolean", description: "Filter (issues / pulls) created by the authenticated user" }),
        mentioned: z.string().optional().openapi({ type: "boolean", description: "Filter (issues / pulls) mentioning the authenticated user" }),
        review_requested: z
          .string()
          .optional()
          .openapi({ type: "boolean", description: "Filter pulls where the authenticated user's review was requested" }),
        reviewed: z.string().optional().openapi({ type: "boolean", description: "Filter pulls reviewed by the authenticated user" }),
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
    const { viewer, found, units } = await requireVisibleRepo(c, c.req.valid("param"));
    const url = new URL(c.req.url);
    const since = parseQueryTime(url.searchParams.get("since"));
    const before = parseQueryTime(url.searchParams.get("before"));
    const listOptions = parseListOptions(url);

    // created_by/assigned_by/mentioned_by all resolve through
    // getUserIDForFilter (routers/api/v1/repo/issue.go:398-406, 469-479):
    // an unknown login is the APIErrorAuto(ErrUserNotExist) 404, resolved in
    // upstream's order (created → assigned → mentioned).
    let posterId: number | null | undefined;
    // assigned_by rides the issue_assignees subquery (issue_search.go:373-
    // 383's numeric arm — the service-half seam, services/issues.ts).
    // mentioned_by rides the landed issue_user carrier the same way
    // (applyMentionedCondition, issue_search.go:395-399 — :449-451 sets
    // MentionID when the resolved id is > 0): the service's mentionedId
    // filter over is_mentioned rows.
    let assigneeId: number | null | undefined;
    let mentionedId: number | null | undefined;
    for (const filter of ["created_by", "assigned_by", "mentioned_by"] as const) {
      const name = (url.searchParams.get(filter) ?? "").trim();
      if (name === "") continue;
      const id = await userIdForFilter(c.env.DB, name);
      if (id === null) {
        throw userNotExistError(name);
      }
      if (filter === "created_by") {
        posterId = id;
      } else if (filter === "assigned_by") {
        assigneeId = id;
      } else {
        mentionedId = id;
      }
    }

    const { items, total } = await listRepoIssues(c.env.DB, found.repo.id, {
      isClosed: parseStateFilter(url.searchParams.get("state")),
      // The `type` narrowing of ListIssues (issue.go:375-390): an explicit
      // type against an unreadable unit is the bare 404; without one the
      // filter collapses to the single readable side.
      isPull: narrowIssueListType(units, parseTypeFilter(url.searchParams.get("type"))),
      keyword: (url.searchParams.get("q") ?? "").trim(),
      labelIds: await labelIdsByRepoNames(c.env.DB, found.repo.id, csvParam(url.searchParams, "labels")),
      milestoneIds: await milestoneIdsByRepoEntries(c.env.DB, found.repo.id, csvParam(url.searchParams, "milestones")),
      since,
      before,
      posterId,
      assigneeId,
      mentionedId,
      page: listOptions.page,
      limit: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    // The query-shape audit's A2: the per-issue enrichment selects (poster,
    // labels, pin order, milestone, PR row) batch into one inArray read per
    // entity kind for the page, handed to the render through the preload —
    // the response shape is unchanged.
    const renderContext = await prefetchIssueRenderContext(c.env.DB, items);
    const rendered = await Promise.all(items.map((issue) => toApiIssue(c.env.DB, viewer, found, issue, { context: renderContext })));
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
      // The route-level `reqRepoReader(unit.TypeIssues)` arm (api.go:1576,
      // AFTER mustNotBeArchived): creation demands the issues unit itself,
      // even though the group gate passed via the pulls fallback.
      await assertIssuesUnitReadable(c.env.DB, found);
      const form = c.req.valid("json");
      const service = new IssuesService(c.env.DB, c.env);
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
      // NewIssue's blocked arm (services/issue/issue.go:33-34 via
      // routers/api/v1/repo/issue.go:625): the poster must not be blocked
      // by the repo owner — 403 "user is blocked". The assignee half of
      // upstream's condition is unreachable: this route drops
      // form.assignee(s) (the file-header deviation), so the sub-arm rides
      // the create-assignee support when it lands.
      await assertNotBlockedForIssueCreate(
        c.env.DB,
        { id: requester.id ?? 0, isAdmin: requester.is_admin === true },
        found.repo.ownerId,
      );
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

      // ONE render serves the 201 body AND the opened/closed payloads below:
      // this route drops form.assignee(s) (the file-header deviation), so a
      // fresh issue's assignee set is ALWAYS empty and the wire render's
      // null/null is exactly what upstream's ToAPIIssue (NewIssue:305) would
      // emit for the same fresh issue — the identities coincide by
      // construction. A future create-assignee wave must split the paths.
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
    // The query-shape audit's A7: the per-comment poster select batches into
    // ONE inArray read for the page (upstream's comments.LoadPosters is the
    // same fix); the response shape is unchanged.
    const posters = await prefetchCommentPosters(c.env.DB, items.map((row) => row.comment));
    const rendered = await Promise.all(
      items.map(({ comment, issue }) => toApiComment(c.env.DB, viewer, found, issue, comment, { posters })),
    );
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issues/comments/{id} (issueGetComment) —
  // the GLOBAL comment id; system comments answer the empty 204.
  // -------------------------------------------------------------------------
  app.openapi(getCommentRoute(optionalAuth), async (c) => {
    const { viewer, found, units } = await requireVisibleRepo(c, c.req.valid("param"));
    const commentId = pathId(c.req.valid("param").id);
    const row = await findRepoCommentById(c.env.DB, found.repo.id, commentId);
    if (row === null) {
      throw commentNotExistError(commentId);
    }
    // Upstream GetIssueComment narrows the comment's ISSUE unit after the
    // lookup (issue_comment.go:440 CanReadIssuesOrPulls → APIErrorNotFound):
    // a comment on a hidden plain issue is the same bare 404.
    assertIssueRowUnit(units, row.issue.isPull);
    if (row.comment.type !== CommentType.Comment) {
      // Upstream GetIssueComment: non-Comment types render 204 (no content).
      return c.body(null, 204);
    }
    return c.json(await toApiComment(c.env.DB, viewer, found, row.issue, row.comment), 200);
  });

  // -------------------------------------------------------------------------
  // PATCH /repos/{owner}/{repo}/issues/comments/{id} (issueEditComment)
  // The trailing body hook is EditIssueCommentOption's `binding:"Required"`
  // rule (structs/issue_comment.go:45) — the bind middleware answers an
  // empty/absent body with 422 before the handler runs, the same declared
  // runtime-only 422 as the create arm.
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
      // UpdateComment's blocked arm (services/issue/comments.go:106-108
      // via routers/api/v1/repo/issue_comment.go:574): the doer blocked by
      // the issue poster or the repo owner answers 403 "user is blocked"
      // unless a repo admin — reached only on an actual content change,
      // exactly where upstream calls UpdateComment.
      const editor = c.get("authUser");
      await assertNotBlockedForIssueContent(
        c.env.DB,
        { id: editor.id ?? 0, isAdmin: editor.is_admin === true },
        await isRepositoryAdmin(c, found),
        row.issue.posterId,
        found.repo.ownerId,
      );
      // Upstream editIssueComment (routers/api/v1/repo/issue_comment.go:569-577)
      // updates and notifies only on an actual content change, carrying the
      // pre-edit content into the notifier (UpdateComment:420-461's
      // `changes.body.from`).
      const oldContent = row.comment.content ?? "";
      await updateCommentBody(c.env.DB, row.comment.id, form.body, new Date(), editor.id ?? null); // actorId: the revision attributes its editor
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
  }, createIssueBodyHook);

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
    const { viewer, found, units } = await requireVisibleRepo(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index, units);
    return c.json(await toApiIssue(c.env.DB, viewer, found, issue), 200);
  });

  // -------------------------------------------------------------------------
  // PATCH /repos/{owner}/{repo}/issues/{index} (issueEditIssue) — 201 quirk
  // -------------------------------------------------------------------------
  app.openapi(editIssueRoute(requireAuth), async (c) => {
    const { viewer, found, units } = await requireVisibleRepo(c, c.req.valid("param"));
    assertNotArchived(found);
    let issue = await requireIssue(c, found, c.req.valid("param").index, units);
    if (!canEditIssue(c, found, issue.posterId)) {
      // Upstream answers a bare Status(403); the contract's forbidden family
      // is the {message, url} envelope — sent empty-messageed.
      throw new ApiError(403, "");
    }
    const form = c.req.valid("json");
    const service = new IssuesService(c.env.DB, c.env);
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
      // ChangeIssueTitle's blocked arm (services/issue/issue.go:104-106):
      // a doer blocked by the issue poster or the repo owner answers
      // 403 "user is blocked" unless they are a repo admin
      // (access_model.IsUserRepoAdmin — the permission matrix's admin flag).
      await assertNotBlockedForIssueContent(
        c.env.DB,
        { id: actorId, isAdmin: requester.is_admin === true },
        await isRepositoryAdmin(c, found),
        issue.posterId,
        found.repo.ownerId,
      );
      const oldTitle = issue.title;
      // The IssuesService fold carries the IssueChangeTitle mail receiver
      // (services/mailer/notify.go:80-90 — upstream fires it from
      // ChangeTitle, issue.go:127).
      const updated = await service.changeTitle(issue, title, actorId, now);
      if (updated !== null) {
        issue = updated;
      }
      await emitIssueEvent(c, {
        repoId: found.repo.id,
        ownerId: event.ownerId,
        eventType: "issues",
        payload: issueEventPayload(
          "edited",
          // Upstream renders the title-edit payload issue through the SHARED
          // ToAPIIssue (IssueChangeTitle:238 — LoadAssignees, the real set),
          // so the default wire render.
          await toApiIssue(c.env.DB, viewer, found, issue),
          issue.index,
          event.repository,
          event.sender,
          {
            changes: { title: { from: oldTitle } },
          },
        ),
      });
    }

    const body = patchField(form.body);
    if (body !== undefined && body !== (issue.content ?? "")) {
      // ChangeContent's blocked arm (services/issue/content.go:21-23) —
      // the same doer-blocked-by-poster-or-owner / repo-admin-bypass rule
      // as the title arm above.
      await assertNotBlockedForIssueContent(
        c.env.DB,
        { id: actorId, isAdmin: requester.is_admin === true },
        await isRepositoryAdmin(c, found),
        issue.posterId,
        found.repo.ownerId,
      );
      const oldContent = issue.content ?? "";
      const updated = await changeIssueBody(c.env.DB, issue, body, requestedVersion ?? issue.contentVersion, now, actorId);
      if (updated === null) {
        // Lost the concurrent CAS race — upstream ErrIssueAlreadyChanged.
        throw new ApiError(409, "the issue is already changed");
      }
      issue = updated;
      await emitIssueEvent(c, {
        repoId: found.repo.id,
        ownerId: event.ownerId,
        eventType: "issues",
        payload: issueEventPayload(
          "edited",
          // Upstream renders the body-edit payload issue through the SHARED
          // ToAPIIssue (IssueChangeContent:410 — LoadAssignees, the real set),
          // so the default wire render.
          await toApiIssue(c.env.DB, viewer, found, issue),
          issue.index,
          event.repository,
          event.sender,
          {
            changes: { body: { from: oldContent } },
          },
        ),
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

    // form.assignee(s): upstream REPLACES the assignee set the GitHub way
    // (EditIssue → UpdateAssignees, issue.go:772-779 → services/issue/
    // assignee.go:94-166): writer-gated (`canWrite && (Assignees != nil ||
    // Assignee != nil)`, :772), the requested names validated pre-write by
    // the shared service (the blocked arm assignee.go:169-170 answers 403
    // "user is blocked"; CanBeAssigned the 400/403 family), then the
    // removals+adds ride the landed issue_assignees table with one type-9
    // comment per toggle; an empty array clears the set. ONE assign webhook
    // fires per actually-changed assignee, removals before adds (upstream's
    // post-tx notify loops, assignee.go:155-166 → IssueChangeAssignee,
    // notifier.go:161-202). Error mapping divergence: upstream's issues-PATCH
    // arm maps only ErrBlockedUser (:780-783) — an unknown login would fall
    // into APIErrorInternal (a 500); we answer the pulls-PATCH mapping's 422
    // "Assignee does not exist: …" (pull.go:688), the same 422 the landed
    // /assignees routes reply (documented, the shared service's resolution).
    if (
      (repositoryPermissions(viewerOf(c), found.repo).admin === true ||
        repositoryPermissions(viewerOf(c), found.repo).push === true) &&
      ((form.assignees !== undefined && form.assignees !== null) || (form.assignee !== undefined && form.assignee !== null))
    ) {
      // The IssuesService fold fans the IssueChangeAssignee mail receiver in
      // beside the webhook emitter (services/mailer/notify.go:119-127).
      await service.changeAssignees(
        found,
        issue,
        [...(form.assignees ?? []), ...(form.assignee ? [form.assignee] : [])],
        { id: actorId, isAdmin: requester.is_admin === true },
        (user, removed) => emitAssignEvent(c, found, issue, user, removed),
      );
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

    // State: the merged precondition first — upstream (repo/issue.go:810-817)
    // 412s ANY state arm on a merged PR (the guard runs before the requested
    // value is examined, so both "closed" and "open" attempts answer 412),
    // then the CAS-guarded close/reopen transitions.
    const state = patchField(form.state);
    if (state !== undefined && issue.isPull) {
      const pullRequest = await findPullRequestRowByIssueId(c.env.DB, issue.id);
      if (pullRequest !== null && pullRequest.hasMerged) {
        throw new ApiError(412, "cannot change state of this pull request, it was already merged");
      }
    }
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
        // Upstream renders the close payload issue through the SHARED ToAPIIssue
        // (IssueChangeStatus:274 — LoadAssignees, the real set), so the default
        // wire render.
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
        // Upstream renders the reopen payload issue through the SHARED
        // ToAPIIssue (IssueChangeStatus:274 — the same issue-arm converter),
        // so the default wire render.
        payload: issueEventPayload("reopened", await toApiIssue(c.env.DB, viewer, found, issue), issue.index, event.repository, event.sender),
      });
    }

    return c.json(await toApiIssue(c.env.DB, viewer, found, issue), 201);
  });

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/issues/{index} (issueDelete)
  // -------------------------------------------------------------------------
  app.openapi(deleteIssueRoute(requireAuth), async (c) => {
    const { found, units } = await requireVisibleRepo(c, c.req.valid("param"));
    assertNotArchived(found);
    const issue = await requireIssue(c, found, c.req.valid("param").index, units);
    // Upstream reqAdmin lands with the SPEC-0002 ACL matrix (header note).
    // The bucket rides along: attachment objects go storage-first (see the
    // cascade's doc comment). The emission context threads the request into
    // the cascade's delete webhook half (upstream DeleteIssue,
    // notifier.go:313-341 — the `action=deleted` Issue/PR payload).
    await deleteIssueCascade(c.env.DB, c.env.REPO_PACKS, issue, issueDeleteEmission(c));
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issues/{index}/comments (issueGetComments)
  // -------------------------------------------------------------------------
  app.openapi(listIssueCommentsRoute(optionalAuth), async (c) => {
    const { viewer, found, units } = await requireVisibleRepo(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index, units);
    const url = new URL(c.req.url);
    const since = parseQueryTime(url.searchParams.get("since"));
    const before = parseQueryTime(url.searchParams.get("before"));
    const rows = await listIssueComments(c.env.DB, issue.id, since, before);
    // Upstream sets X-Total-Count but does not paginate this endpoint.
    c.header("X-Total-Count", String(rows.length));
    // The query-shape audit's A7: the per-comment poster select batches into
    // ONE inArray read for the thread; the response shape is unchanged.
    const posters = await prefetchCommentPosters(c.env.DB, rows);
    const rendered = await Promise.all(rows.map((comment) => toApiComment(c.env.DB, viewer, found, issue, comment, { posters })));
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/issues/{index}/comments (issueCreateComment) — 201
  // -------------------------------------------------------------------------
  app.openapi(
    createCommentRoute(requireAuth),
    async (c) => {
      const { viewer, found, units } = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const issue = await requireIssue(c, found, c.req.valid("param").index, units);
      // CreateIssueComment's locked arm (issue_comment.go:381): a locked
      // issue denies comments from a doer with no write grant and no site
      // admin flag — ctx.Locale.TrString("repo.issues.comment_on_locked").
      // canWriteRepository is the landed CanWriteIssuesOrPulls+IsAdmin
      // equivalent (owner/collaborator-write/team-write and the site admin
      // all fold into its push-grade answer).
      if (issue.isLocked && !(await canWriteRepository(c, found))) {
        throw new ApiError(403, "You cannot comment on a locked issue.");
      }
      const form = c.req.valid("json");
      // The mail-notify arm (SPEC email-outbound §8.4's fold): the env arms
      // the hub — CreateIssueComment's fan-out (notify.go:31-51) fires from
      // the service's addComment, upstream-shaped; fail-closed without it.
      const service = new IssuesService(c.env.DB, c.env);
      const requester = c.get("authUser");
      // CreateIssueComment's blocked arm (services/issue/comments.go:63-65
      // via routers/api/v1/repo/issue_comment.go:387): the doer blocked by
      // the issue poster or the repo owner answers 403 "user is blocked"
      // unless a repo admin (IsUserRepoAdmin).
      await assertNotBlockedForIssueContent(
        c.env.DB,
        { id: requester.id ?? 0, isAdmin: requester.is_admin === true },
        await isRepositoryAdmin(c, found),
        issue.posterId,
        found.repo.ownerId,
      );
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
          // Upstream renders the created-comment payload issue through the
          // SHARED ToAPIIssue (CreateIssueComment:482 — LoadAssignees, the
          // real set), so the default wire render.
          issue: await toApiIssue(c.env.DB, viewer, found, issue),
          comment: rendered,
          repository: event.repository,
          sender: event.sender,
          is_pull: issue.isPull,
        },
      });
      return c.json(rendered, 201);
    },
    // The Go bind's Required on the comment body (structs/issue_comment.go:37)
    // answers 422 at runtime — declared here and documented as a
    // RUNTIME_ONLY_RESPONSES entry in the contract check (the vendored
    // swagger documents {201,403,404,423} only).
    createIssueBodyHook,
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issues/{index}/labels (issueGetLabels)
  // -------------------------------------------------------------------------
  app.openapi(listIssueLabelsRoute(optionalAuth), async (c) => {
    const { viewer, found, units } = await requireVisibleRepo(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index, units);
    const rows = await issueLabelRows(c.env.DB, issue.id);
    return c.json(rows.map((row) => toApiLabel(row, issueLabelApiUrlBase(row, found, viewer.origin))), 200);
  });

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/issues/{index}/labels (issueAddLabel) — ADD
  // semantics; 200 with the resulting label list (never 201).
  // -------------------------------------------------------------------------
  app.openapi(
    addIssueLabelsRoute(requireAuth),
    async (c) => {
      const { viewer, found, units } = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const issue = await requireIssue(c, found, c.req.valid("param").index, units);
      const form = c.req.valid("json");
      const labelIds = await resolveLabelOptionIds(c.env.DB, found, form.labels);
      const service = new IssuesService(c.env.DB);
      try {
        for (const labelId of labelIds) {
          await service.setLabel(issue.id, labelId, { ownerOrgId: ownerOrgIdOf(found) });
        }
      } catch (error) {
        asApiError(error);
        throw error;
      }
      // Webhook: IssueChangeLabels (notifier.go:572) — upstream's service
      // layer notifies unconditionally after AddLabels, with no `changes`.
      await emitLabelEvent(c, found, issue, "label_updated");
      const rows = await issueLabelRows(c.env.DB, issue.id);
      return c.json(rows.map((row) => toApiLabel(row, issueLabelApiUrlBase(row, found, viewer.origin))), 200);
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
      const { viewer, found, units } = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const issue = await requireIssue(c, found, c.req.valid("param").index, units);
      const form = c.req.valid("json");
      const labelIds = await resolveLabelOptionIds(c.env.DB, found, form.labels);
      const service = new IssuesService(c.env.DB);
      try {
        await service.replaceLabels(issue.id, labelIds, { ownerOrgId: ownerOrgIdOf(found) });
      } catch (error) {
        asApiError(error);
        throw error;
      }
      // Webhook: IssueChangeLabels (notifier.go:572) — ReplaceLabels notifies
      // unconditionally too (services/issue/label.go:79-87).
      await emitLabelEvent(c, found, issue, "label_updated");
      const rows = await issueLabelRows(c.env.DB, issue.id);
      return c.json(rows.map((row) => toApiLabel(row, issueLabelApiUrlBase(row, found, viewer.origin))), 200);
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
    const { found, units } = await requireVisibleRepo(c, c.req.valid("param"));
    assertNotArchived(found);
    const issue = await requireIssue(c, found, c.req.valid("param").index, units);
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
    const { viewer, found, units } = await requireVisibleRepo(c, c.req.valid("param"));
    const issue = await requireIssue(c, found, c.req.valid("param").index, units);
    const url = new URL(c.req.url);
    const since = parseQueryTime(url.searchParams.get("since"));
    const before = parseQueryTime(url.searchParams.get("before"));
    const listOptions = parseListOptions(url);
    const rows = await listIssueTimeline(c.env.DB, issue.id, since, before, listOptions.page, listOptions.limit);
    // The query-shape audit's A5: the timeline rendered each row with 1..5
    // serial selects (poster + old/new milestone + label + assignee); the
    // page now prefetches ONE inArray read per entity kind (the timeline's
    // per-comment entity kinds the issue-list context does not carry) and
    // renders through toTimelineComment's optional preload — the response
    // shape is unchanged, and the per-row fallback stays intact for
    // omitted-preload callers.
    const timelineContext = await prefetchTimelineContext(c.env.DB, rows);
    const rendered: TimelineComment[] = await Promise.all(
      rows
        .filter((comment) => comment.type !== CommentType.Code) // upstream drops code comments
        .map((comment) => toTimelineComment(c.env.DB, viewer, found, issue, comment, timelineContext)),
    );
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
        // SearchIssuesRepoIDs returns ErrUserNotExist; the search route maps
        // the ErrNotExist family to the declared 400 with the verbatim text
        // (routers/common/issue_filter.go:48-52 + repo/issue.go:144-150).
        throw new ApiError(400, `user does not exist [uid: 0, name: ${ownerName}]`);
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
    // The global search's assigned_by rides the same issue_assignees
    // subquery (issue_search.go:373-383's numeric arm — the shared
    // IssueListFilters seam); mentioned_by rides the landed issue_user
    // carrier (applyMentionedCondition, issue_search.go:395-399).
    const assignedBy = (url.searchParams.get("assigned_by") ?? "").trim();
    let assigneeId: number | null | undefined;
    if (assignedBy !== "") {
      assigneeId = await userIdForFilter(c.env.DB, assignedBy);
      if (assigneeId === null) {
        throw userNotExistError(assignedBy);
      }
    }
    let mentionedId: number | null | undefined;
    const mentionedBy = (url.searchParams.get("mentioned_by") ?? "").trim();
    if (mentionedBy !== "") {
      mentionedId = await userIdForFilter(c.env.DB, mentionedBy);
      if (mentionedId === null) {
        throw userNotExistError(mentionedBy);
      }
    }
    const requester = c.get("authUser");
    if (requester !== undefined) {
      // ctx.FormBool(value-rule) parsing — 1/t/T/true/TRUE/True/on/on/On
      // are true, everything else (and garbage) false, never an error.
      if (formBool(url.searchParams, "created")) {
        posterId = requester.id;
      }
      // assigned/review_requested/reviewed: the corresponding surfaces do
      // not exist yet (the assignee flag's route wiring is its own wave's
      // item; no review store) — the filters match the empty set.
      for (const flag of ["assigned", "review_requested", "reviewed"]) {
        if (formBool(url.searchParams, flag)) {
          posterId = -1;
        }
      }
      // The `mentioned` doer-flag (issue.go:223-225, gated on IsSigned —
      // anonymous callers keep it unfiltered): the doer's
      // applyMentionedCondition arm, real rows now.
      if (formBool(url.searchParams, "mentioned")) {
        mentionedId = requester.id;
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
      assigneeId,
      mentionedId,
      page: listOptions.page,
      limit: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    // The query-shape audit's A6: the per-issue repo re-resolution batches
    // into ONE inArray read for the page's distinct repo ids (a missing pair
    // keeps the per-row skip), and the issue render batches like the
    // repo-scoped list above; the render parallelizes over the page.
    const pairsById = await findRepositoriesByIds(c.env.DB, [...new Set(items.map((issue) => issue.repoId))]);
    const renderContext = await prefetchIssueRenderContext(c.env.DB, items);
    const rendered = await Promise.all(
      items.map(async (issue) => {
        const pair = pairsById.get(issue.repoId);
        return pair === undefined ? null : toApiIssue(c.env.DB, viewer, pair, issue, { context: renderContext });
      }),
    );
    return c.json(rendered.filter((item): item is Issue => item !== null), 200);
  });
}

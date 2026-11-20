/**
 * Tier-1 PR-block routes (SPEC-0004 §2.4 rows repoListPullRequests /
 * repoCreatePullRequest / repoGetPullRequest / repoEditPullRequest /
 * repoGetPullRequestByBaseHead / repoDownloadPullDiffOrPatch /
 * repoGetPullRequestCommits / repoGetPullRequestFiles /
 * repoPullRequestIsMerged / repoMergePullRequest / repoMergeUpstream —
 * 8 paths, 11 operations; behavior per SPEC-0005 §2.4/§3.4).
 *
 * Engine semantics (services/pull-engine.ts): POST validates the base/head
 * branch existence (engine reads) and writes `refs/pull/N/head` through the
 * receive-less commitApiChange (SPEC-0001b §4.4 mapping); a failed D1
 * creation after the ref landed deletes the row again (upstream cleanup
 * order, services/pull/pull.go:157). A CROSS-REPO head (`owner:branch` — the
 * fork flow) gates the doer's READ of the head repo, computes the merge base
 * in the HEAD cell (upstream GetCompareInfo runs the same computation in the
 * head repo, services/git/compare.go:73-89) and carries the head's divergent
 * closure into the base cell first — commitApiChange refuses an oid the cell
 * lacks, and every downstream PR read walks the base cell. GET …/{index} runs the LAZY
 * mergeability check (a `checking` row fires checkMergeability and CAS-writes
 * the result), renders the real mergeability trio (mergeable/base.sha/
 * merge_base) and feeds PATCH's merged precondition. The diff/patch/commits/
 * files reads compose `merge_base...refs/pull/N/head` (0001b §10.8 — the API
 * service owns the composition). POST …/merge requires the mergeable state
 * (405 otherwise — the not-mergeable semantics of the contract's 405), refuses
 * WIP titles and already-merged rows with 405, and refuses the auto-merge
 * schedule with the declared 409. POST /merge-upstream syncs a FORK's branch
 * with its base (the fork machinery landed — services/pull-engine.ts
 * mergeUpstream: the write/fork/read gates, "up-to-date"/"fast-forward"/
 * "merge" outcomes, the divergence walk in the fork cell).
 *
 * `GET …/pulls/{index}.{diffType}` is a DOT-SUFFIX path (SPEC-0004 §4): the
 * contract path is declared doc-only via the registry (hono's `:a.:b` two-
 * param segment does not route), and a plain pre-handler on the one-segment
 * pulls path intercepts `^(\d+)\.(diff|patch)$` before the `{index}` route.
 *
 * Auth: reads are anonymous-capable on public repos (upstream group carries
 * `reqRepoReader(TypeCode)`); POST/PATCH require a token (SPEC-0002
 * `write:repository`); the ACL matrix lands with SPEC-0002 — requireAuth
 * stands in (the hooks-routes convention). Repo resolution follows the
 * anti-enumeration 404; a wrong index answers the upstream
 * ErrPullRequestNotExist message (`pull request does not exist [id: 0, …]`).
 * Upstream PATCH has NO mustNotBeArchived (unlike POST) — 423 is not
 * declared here and never emitted; the PATCH precondition family is the 412
 * "cannot change state of this pull request, it was already merged".
 *
 * RUNTIME-ONLY code the handlers can still emit (undeclared; the
 * orchestrator-owned RUNTIME_ONLY_RESPONSES tables are not extended by this
 * batch): POST pulls 400 (invalid due_date format — upstream
 * ApplyAPIDeadlineTimestamp "invalid date format: X"); POST merge 403
 * ("User not allowed to merge PR" — the write-scope stand-in, plus the
 * SPEC-0013 merge-whitelist arm when a protection rule covers the base
 * branch). The SPEC-0013 §3.3 protection gate answers the 405 family with
 * the upstream message texts verbatim ("Does not have enough approvals",
 * "There are requested changes", "There are official review requests",
 * "The head branch is behind the base branch") — the ErrNotReadyToMerge
 * Error() render rule (modules/util/error.go:56–58).
 *
 * The PATCH `base` retarget stays engine-gated upstream (branch existence +
 * ChangeTargetBranch) and is still ignored this wave (the assignee fields
 * are LIVE — see the UpdateAssignees wiring note in the second header).
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context, MiddlewareHandler } from "hono";
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import { issues, milestones, PRStatus, pullRequests, teams, users } from "../../db/schema";
import { emitIssueEvent } from "../../services/issue-events";
import { IssueError, MilestoneNotExistError } from "../../issues/errors";
import { CommentType } from "../../issues/comment-types";
import { IssuesService, type IssueRow, type PullRequestRow } from "../../issues/service";
import { MAX_PUSH_COMMITS_IN_COMMENT } from "../../services/webhooks-push";
import { emitWebhookDeliveries, type HookEventType } from "../../issues/webhooks";
import type { WebhookDeliveryMessage } from "../../webhooks/consumer";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  createPullRequestOptionSchema,
  editPullRequestOptionSchema,
  mergePullRequestOptionSchema,
  mergeUpstreamRequestSchema,
  mergeUpstreamResponseSchema,
  pullRequestListSchema,
  pullRequestSchema,
  type PullRequest,
} from "../models/pull";
import { changedFileListSchema, commitListSchema } from "../models/git";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { ActionType, recordAction, type ActionDraft } from "../services/activity-feeds";
import { isUserBlockedBy } from "../services/blocks";
import { collaboratorModeOf } from "../services/repo-collaborators";
import { changeIssueBody, changeIssueDeadline, changeIssueMilestone, hasWorkInProgressPrefix, issueErrorToApiError, issueNoDependenciesLeft, addIssueAssignees, resolveCreateAssigneeUsers } from "../services/issues";
import { assertPullsUnit } from "../services/issue-unit-gates";
import { parseMilestoneDeadline } from "../services/milestones";
import {
  existingRepoLabelIds,
  findPullRequestByBaseHeadInfo,
  findPullRequestByIndex,
  findUnmergedPullRequest,
  listRepoPullRequests,
  prefetchPullRequestRenderContext,
  pullRequestAlreadyExistsError,
  pullRequestNotExistError,
  pullRequestCodeOwnersReview,
  resolveHeadRepo,
  toApiPullRequest,
} from "../services/pulls";
import {
  changePullRequestTargetBranch,
  composeMergeMessage,
  createPullHeadRef,
  carryForkHeadIntoBase,
  crossRepoCreateMergeBase,
  ensurePullRequestChecked,
  mergePullRequest as mergePullRequestEngine,
  mergeableOfRow,
  mergeUpstream as mergeUpstreamEngine,
  pullGateGitInputs,
  pullRequestDiff,
  pullRequestDiffShortStat,
} from "../services/pull-engine";
import { branchRef, engineCell, engineReads, isFullObjectId, pullHeadRef, refTipMap, tagRef } from "../services/engine";
import { renderUnifiedDiff, renderPatch, toApiCommit, toChangedFiles, usernamesByEmail } from "../services/git-models";
import {
  apiUserFromRow,
  canViewRepository,
  canViewRepositoryWithTeams,
  doerRepoAccessMode,
  findRepositoryById,
  findRepositoryByPath,
  repositoryPermissions,
  toApiRepository,
  viewerOf,
  type RepositoryWithOwner,
  type UserRow,
  type Viewer,
} from "../services/repository";
import { toApiUser } from "../services/user";
import { canWriteRepository } from "../services/repo-access";
import { loadRepoSettings } from "../services/repo-settings";
import { PullReviewsService } from "../services/pull-reviews";
import { canBypassBranchProtection, checkPullBranchProtections, findRule, isUserMergeWhitelisted, parseRuleConfig, principalAccessOf } from "../../services/branch-protection";
import { createScheduledAutoMergeComment, disableAutoMergeIfNotWriter, insertScheduledAutoMergeRow } from "../../services/pull-automerge";
import { emitMilestoneEvent } from "./issues";
import { requestedReviewersOf } from "./pull-reviews";

/**
 * Tier-1 PR-block routes (SPEC-0004 §2.4 rows repoListPullRequests /
 * repoCreatePullRequest / repoGetPullRequest / repoEditPullRequest /
 * repoGetPullRequestByBaseHead — 3 paths, 5 operations; behavior per
 * SPEC-0005 §2.4). DECLARED-BUT-DEFERRED with the engine wave
 * (specs/0001b): `GET …/pulls/{index}.{diffType}`, `…/pulls/{index}/commits`,
 * `…/pulls/{index}/files` and the `…/pulls/{index}/merge` family — all need
 * engine RPCs (diff builder, merge-base, merge execution).
 *
 * Auth: reads are anonymous-capable on public repos (upstream group carries
 * `reqRepoReader(TypeCode)`); POST/PATCH require a token (SPEC-0002
 * `write:repository`); the ACL matrix lands with SPEC-0002 — requireAuth
 * stands in (the hooks-routes convention). Repo resolution follows the
 * anti-enumeration 404; a wrong index answers the upstream
 * ErrPullRequestNotExist message (`pull request does not exist [id: 0, …]`).
 * Upstream PATCH has NO mustNotBeArchived (unlike POST) — 423 is not
 * declared here and never emitted; the PATCH precondition family is the 412
 * "cannot change state of this pull request, it was already merged".
 *
 * Declared responses mirror the vendored contract exactly. RUNTIME-ONLY code
 * the handler can still emit (undeclared; the orchestrator-owned
 * RUNTIME_ONLY_RESPONSES tables in suite.ts / check-openapi.mjs are not
 * extended by this batch — same treatment as the issues block):
 *   - POST pulls: 400 (invalid due_date format — upstream
 *     ApplyAPIDeadlineTimestamp "invalid date format: X"; undeclared in the
 *     contract), 500 (an INVALID REVIEWER on the create arms —
 *     ErrNotValidReviewRequest is unmapped in repoCreatePullRequest's
 *     :547-555 error ladder, so the failure answers APIErrorInternal with
 *     the exact error text AFTER the PR row committed, upstream's
 *     committed-prefix wart; the standalone requested_reviewers route maps
 *     the same family to 422 — the two upstream mappings differ). The other
 *     400/409/412/422 codes on PATCH are DECLARED. The PATCH retarget adds
 *     500 (ErrBranchesEqual is likewise unmapped at pull.go:764-769 —
 *     "branches are equal [head: %sm base: %s]", the upstream typo verbatim).
 *
 * Engine boundary (documented, this wave): POST accepts the create per
 * upstream shape WITHOUT the base/head branch-existence check (an engine
 * read) and GET resolves `mergeable` through pr.Mergeable(ctx) semantics
 * (pull-engine.ts mergeableOfRow — a still-checking row renders FALSE, the
 * pin's non-nullable bool: structs/pull.go:65, models/issues/pull.go:767-775),
 * `base.sha: ""` and `head.sha` from the pull_requests cache. The PATCH
 * `base` retarget is LIVE: the gate (skip on merged/empty/same-base,
 * pull.go:748), the branch-existence 404, ChangeTargetBranch's mapped
 * errors (pull.go:757-770) and the PullRequestChangeTargetBranch webhook
 * ride the engine's landed retarget (changePullRequestTargetBranch).
 * The PATCH assignee fields
 * are LIVE: upstream REPLACES the assignee set (UpdateAssignees,
 * pull.go:674-694) and the machinery rides the landed issue_assignees table
 * (replacePullAssignees below; the blocks-enforcement sweep wired
 * pull.go:687's ErrBlockedUser 403 arm and the create-side pull.go:64-65
 * arm here). The label/-milestone WEBHOOK sub-events stay the tier-2
 * surfaces'; this file emits the webhook family only.
 *
 * Webhook triggers (SPEC-0005 §3.5): pull_request opened (POST) / edited
 * (title, body, with `changes{title{from}, body{from}}`) / closed+reopened
 * (PATCH state), through emitWebhookDeliveries — see emitPullWebhook. The
 * label/-milestone sub-events ride their tier-2 surfaces;
 * pull_request_assign is emitted HERE since the PATCH assignee replace went
 * live (emitPullAssignWebhook, one event per changed assignee) and the
 * create arms emit it too (the create-carried assignees, NewPullRequest's
 * :191-193 notify); pull_request_review_request rides the create's
 * reviewer/team arms (the :169-181 loops) — review_request events land
 * BEFORE the opened webhook, upstream's NewPullRequest order.
 *
 * Activity feeds (specs/activity-feeds.md §3.3 tail): the PR-lifecycle
 * `action` rows (create/close/reopen/merge_pull_request) ride the same
 * emitPullWebhook seam through the shared recordAction fan-out — see the
 * activity-feed hook below. Assignee changes write NO row (upstream has no
 * assign ActionType).
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

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const pullIndexParams = {
  ...ownerRepoParams,
  index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of the pull request to get" }),
} as const;

const baseHeadParams = {
  ...ownerRepoParams,
  base: z.string().min(1).openapi({ description: "base of the pull request to get" }),
  head: z.string().min(1).openapi({ description: "head of the pull request to get" }),
} as const;

const pageLimitQuery = {
  page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
  limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
} as const;

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
function pathId(raw: string): number {
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Body bind hook for the operations with a declared 422 (Go bind parity). */
const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** Tri-state pointer rule: absent and JSON-null both mean "unchanged". */
function patchField<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

/** The stat/files boolean query flags (default TRUE — ParseCommitOptions). */
function formBoolDefault(url: URL, key: string): boolean {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return true;
  return ["1", "t", "T", "true", "TRUE", "True", "on"].includes(raw);
}

/**
 * The contract's X-* header family (CommitList / ChangedFileList are the only
 * two responses declaring it — SPEC-0004 §2.5). The count is CALLER-SUPPLIED
 * per route and documents which: the commit walks pass the so-far window (the
 * engine's listLog reports no total — the approximation lives at those
 * routes), while /pulls/{index}/files passes the TRUE list length (the
 * handler holds the whole list — pull.go:1573).
 */
function setCommitListHeaders(c: Context<ApiEnv>, opts: { page: number; limit: number }, countSoFar: number, hasMore: boolean): void {
  c.header("X-Total-Count", String(countSoFar));
  c.header("X-Page", String(opts.page));
  c.header("X-PerPage", String(opts.limit));
  c.header("X-PageCount", String(Math.max(Math.ceil(countSoFar / opts.limit), opts.page > 1 ? opts.page : 1)));
  c.header("X-HasMore", hasMore ? "true" : "false");
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
 *  closed by the pulls-group UNIT gate at upstream's chain position: the
 *  `/pulls` subtree registers `mustAllowPulls, reqRepoReader(unit.TypeCode)`
 *  after repoAssignment (api.go:1478; the guard api.go:697-722), so a mirror,
 *  an ARCHIVED repo, or a repo whose pulls unit is disabled 404s every route
 *  here before any handler body — including POST's `mustNotBeArchived` 423
 *  family, which the group gate shadows (archived ⇒ 404 "not found"). The
 *  code-unit read (`reqRepoReader(unit.TypeCode)`) is vacuous in our
 *  reduction: every repo carries a seeded code unit row and the visibility
 *  predicate above already IS that read (services/issue-unit-gates.ts). */
async function requireVisibleRepo(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
    throw new ApiError(404, "not found");
  }
  await assertPullsUnit(c.env.DB, found);
  return { viewer, found };
}

/** `mustNotBeArchived` (routers/api/v1/api.go:816) — 423 with that message. */
function assertNotArchived(found: RepositoryWithOwner): void {
  if (found.repo.isArchived) {
    throw new ApiError(423, "repo is archived");
  }
}

/**
 * parseCompareInfo's head-repo READ gate (routers/api/v1/repo/pull.go:1063-1074):
 * `GetDoerRepoPermission(ctx, headRepo, ctx.Doer).CanRead(unit.TypeCode)` — a
 * head repo the doer cannot read answers APIErrorNotFound, the same
 * anti-enumeration 404 as an absent row (both collapse here). The landed
 * team-aware visibility predicate is the CanRead port.
 */
async function requireReadableHeadRepo(c: Context<ApiEnv>, headRepoId: string): Promise<RepositoryWithOwner> {
  const headPair = await findRepositoryById(c.env.DB, headRepoId);
  if (headPair === null || !(await canViewRepositoryWithTeams(c.env.DB, viewerOf(c), headPair.repo))) {
    throw new ApiError(404, "not found");
  }
  return headPair;
}

/** PR-by-index lookup answering the upstream ErrPullRequestNotExist 404. */
async function requirePullRequest(c: Context<ApiEnv>, found: RepositoryWithOwner, rawIndex: string): Promise<{ issue: IssueRow; pullRequest: PullRequestRow }> {
  const index = pathId(rawIndex);
  const row = await findPullRequestByIndex(c.env.DB, found.repo.id, index);
  if (row === null) {
    throw pullRequestNotExistError(found.repo.id, index);
  }
  return row;
}

/** Poster-or-writer rule of EditPullRequest (CanWrite(TypePullRequests)). */
function canEditPullRequest(c: Context<ApiEnv>, found: RepositoryWithOwner, posterId: number | null): boolean {
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
// Webhook triggers (SPEC-0005 §3.5) — the guarded waitUntil pattern of
// routes/issues.ts: the delivery-row insert runs INLINE after the mutation
// committed (upstream CreateHookTask is synchronous too); only the Queue
// producer ({deliveryId} batch) hangs off the executionCtx-guarded
// waitUntil — in-process callers (tests via app.request) have no
// executionCtx, skip the enqueue, and leave the rows `pending` (the durable
// source of truth; the consumer's idempotent CAS makes a later enqueue a
// safe replay). Failures are logged, never propagated.
// ---------------------------------------------------------------------------

/** The `WEBHOOK_DELIVERY` Queue producer, when the binding is wired. */
function webhookDeliveryQueue(
  env: ApiEnv["Bindings"],
): { sendBatch(messages: { body: WebhookDeliveryMessage }[]): Promise<unknown> } | null {
  const candidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  if (candidate === undefined || candidate === null) return null;
  const queue = candidate as { sendBatch?: (messages: { body: WebhookDeliveryMessage }[]) => Promise<unknown> };
  return typeof queue.sendBatch === "function" ? { sendBatch: queue.sendBatch.bind(queue) } : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function emitPullWebhook(
  c: Context<ApiEnv>,
  input: { repoId: string; ownerId: number | null; eventType: HookEventType; payload: unknown },
): Promise<void> {
  let execCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    execCtx = c.executionCtx;
  } catch {
    execCtx = undefined; // in-process caller (tests): no execution context
  }
  const queue = webhookDeliveryQueue(c.env);
  try {
    await emitWebhookDeliveries(c.env.DB, { ...input, refName: null }, {
      enqueue:
        queue !== null && execCtx !== undefined
          ? (deliveryIds) => {
              execCtx.waitUntil(
                queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))).then(undefined, (error: unknown) => {
                  console.error(`[pulls] delivery enqueue failed (${input.eventType}): ${errorMessage(error)}`);
                }),
              );
            }
          : undefined,
    });
  } catch (error) {
    console.error(`[pulls] webhook fan-out failed (${input.eventType}): ${errorMessage(error)}`);
  }
  await recordPullAction(c.env, input);
}

// ---------------------------------------------------------------------------
// Activity-feed hook (specs/activity-feeds.md §3.3 tail): the PR-family
// actions upstream's actionNotifier writes (services/feed/notifier.go), one
// recordAction fan-out per emission, the landed emitters' pattern
// (services/issue-events.ts / repo-events.ts — caught-and-logged, awaited
// inline so tests and readers see the rows when the response lands).
// NewPullRequest → create_pull_request "index|title" (:129-153);
// IssueChangeStatus → close/reopen_pull_request "index|" (:69-95, the
// `issue.IsPull` variants); MergePullRequest → merge_pull_request
// "index|title" (:263-275). The merge reaches this seam as a pull_request
// "closed" payload whose rendered PR carries merged=true — the
// payload-derived merge discriminant (upstream's merge path fires the
// MergePullRequest notifier ONLY, never IssueChangeStatus, so a merge must
// not also write a close row). Everything else in this family — edited,
// pull_request_assign — writes NO action upstream: the ActionType enum has
// no assign type (action.go:38-65) and feed/notifier.go has no assignee
// method (SPEC §3.3).
// ---------------------------------------------------------------------------

/** Structural read of one rendered §2.7 payload field (payload is `unknown`). */
function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
}

function payloadNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function payloadString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

/** The PR-family action draft for one emission, or null when the event
 *  carries no upstream action. Fields derive from the rendered payload
 *  (SPEC §3.2): act_user = sender.id, is_private = repository.private,
 *  index = the payload `number`, title = pull_request.title. */
function pullActionDraft(input: { repoId: string; eventType: HookEventType; payload: unknown }): ActionDraft | null {
  const payload = payloadRecord(input.payload);
  if (payload === null) return null;
  const actUserId = payloadNumber(payloadRecord(payload.sender), "id");
  if (actUserId === undefined) return null;
  const isPrivate = payloadRecord(payload.repository)?.private === true;
  if (input.eventType !== "pull_request") return null;
  const number = payloadNumber(payload, "number");
  if (number === undefined) return null;
  const pull = payloadRecord(payload.pull_request);
  const title = payloadString(pull, "title") ?? "";
  switch (payload.action) {
    case "opened":
      return { actUserId, repoId: input.repoId, opType: ActionType.CreatePullRequest, isPrivate, content: `${number}|${title}` };
    case "closed":
      if (pull?.merged === true) {
        return { actUserId, repoId: input.repoId, opType: ActionType.MergePullRequest, isPrivate, content: `${number}|${title}` };
      }
      return { actUserId, repoId: input.repoId, opType: ActionType.ClosePullRequest, isPrivate, content: `${number}|` };
    case "reopened":
      return { actUserId, repoId: input.repoId, opType: ActionType.ReopenPullRequest, isPrivate, content: `${number}|` };
    default:
      return null;
  }
}

/** Best-effort action-row write — caught, logged, never propagated (the
 *  webhook fan-out posture; a lost insert is a feed gap, not an API error). */
async function recordPullAction(env: ApiEnv["Bindings"], input: { repoId: string; eventType: HookEventType; payload: unknown }): Promise<void> {
  const draft = pullActionDraft(input);
  if (draft === null) return;
  try {
    await recordAction(env.DB, draft);
  } catch (error) {
    console.error(`[pulls] action row failed (${input.eventType}): ${errorMessage(error)}`);
  }
}

/** The shared PullRequestPayload wrapper (§2.7, modules/structs/hook.go:484). */
function pullRequestPayload(
  action: string,
  apiPullRequest: PullRequest,
  index: number,
  repository: unknown,
  sender: unknown,
  options: { changes?: Record<string, unknown>; commitId?: string } = {},
): Record<string, unknown> {
  return {
    action,
    number: index,
    ...(options.changes === undefined ? {} : { changes: options.changes }),
    pull_request: apiPullRequest,
    repository,
    sender,
    commit_id: options.commitId ?? "",
  };
}

// ---------------------------------------------------------------------------
// The PATCH assignee replace (upstream UpdateAssignees — services/issue/
// assignee.go:94-166; made live by the blocks-enforcement sweep so
// EditPullRequest's blocked arm at pull.go:687 is reachable). The write
// half is the SHARED replaceIssueAssignees service (services/issues.ts) —
// the issues-PATCH arm rides the same implementation; this side keeps only
// its emitter. Assignee changes emit pull_request_assign webhooks only —
// NO `action` row exists upstream (no assign ActionType; feed/notifier.go
// has no assignee method).
// ---------------------------------------------------------------------------

/**
 * The pulls-side UpdateAssignees arm: the shared write core with this
 * route's per-changed-assignee pull_request_assign delivery — `changes`
 * carries the one-element added/removed side (only the changed side is set,
 * the lists are omitempty, hook.go:486-489); the pull_request object renders
 * the POST-change set (upstream's ToAPIPullRequest LoadAssignees) in payload
 * mode through emitPullAssignWebhook (IssueChangeAssignee's ToPayloadPullRequest,
 * notifier.go:182).
 */
async function replacePullAssignees(c: Context<ApiEnv>, found: RepositoryWithOwner, issue: IssueRow, names: string[]): Promise<void> {
  const doer = c.get("authUser");
  // The IssuesService fold fans the IssueChangeAssignee mail receiver in
  // beside the webhook emitter (services/mailer/notify.go:119-127).
  await new IssuesService(c.env.DB, c.env).changeAssignees(
    found,
    issue,
    names,
    { id: doer?.id ?? 0, isAdmin: doer?.is_admin === true },
    async (user, removed) => {
      await emitPullAssignWebhook(
        c,
        found,
        issue,
        removed ? "unassigned" : "assigned",
        removed
          ? { removed_assignees: [toApiUser(viewerOf(c), user)] }
          : { added_assignees: [toApiUser(viewerOf(c), user)] },
      );
    },
  );
}

/** The pull_request_assign delivery (emitPullWebhook with the assign
 *  action + changes side). */
async function emitPullAssignWebhook(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  issue: IssueRow,
  action: "assigned" | "unassigned",
  changes: Record<string, unknown>,
): Promise<void> {
  const pair = await findPullRequestByIndex(c.env.DB, found.repo.id, issue.index);
  if (pair === null) return;
  // The assignee webhook payload renders the head repo regardless of the
  // doer (IssueChangeAssignee → ToPayloadPullRequest, notifier.go:182) —
  // payload mode, not the API-response "single" render. The diff-stat trio
  // rides the same conversion (the single converter's GetDiffShortStat block
  // runs on EVERY single AND payload render, convert/pull.go:245-269; the
  // omit arms — no merge base, truncated walk, engine failure :247-250 —
  // stay omitted).
  const diffStats = await pullRequestDiffShortStat(c, found, pair.pullRequest);
  const rendered = await toApiPullRequest(
    c.env.DB,
    viewerOf(c),
    found,
    pair.issue,
    pair.pullRequest,
    "payload",
    diffStats === null ? undefined : { diffStats },
  );
  await emitPullWebhook(c, {
    repoId: found.repo.id,
    ownerId: found.repo.ownerId,
    eventType: "pull_request_assign",
    payload: pullRequestPayload(action, rendered, issue.index, toApiRepository(viewerOf(c), found), c.get("authUser"), {
      changes,
    }),
  });
}

// ---------------------------------------------------------------------------
// Route declarations — response sets mirror the vendored contract per operation.
// ---------------------------------------------------------------------------

const listPullsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/pulls",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "List a repo's pull requests",
    operationId: "repoListPullRequests",
    request: {
      params: z.object(ownerRepoParams),
      query: z.object({
        base_branch: z.string().optional().openapi({ description: "Filter by target base branch of the pull request" }),
        state: z.string().optional().openapi({ description: "State of pull request", enum: ["open", "closed", "all"] }),
        sort: z
          .string()
          .optional()
          .openapi({
            description: "Type of sort",
            enum: ["oldest", "recentupdate", "recentclose", "leastupdate", "mostcomment", "leastcomment", "priority"],
          }),
        milestone: z.string().optional().openapi({ type: "integer", format: "int64", description: "ID of the milestone" }),
        labels: z.string().optional().openapi({ description: "Label IDs (int64s; upstream sends a repeated multi-form parameter, the comma-separated form is accepted)" }),
        poster: z.string().optional().openapi({ description: "Filter by pull request author" }),
        page: pageLimitQuery.page,
        limit: pageLimitQuery.limit,
      }),
    },
    responses: {
      200: { description: "PullRequestList", content: { "application/json": { schema: pullRequestListSchema } } },
      404: notFoundResponse,
    },
  });

const createPullRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/pulls",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Create a pull request",
    operationId: "repoCreatePullRequest",
    request: {
      params: z.object(ownerRepoParams),
      body: { content: { "application/json": { schema: createPullRequestOptionSchema } } },
    },
    responses: {
      201: { description: "PullRequest", content: { "application/json": { schema: pullRequestSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      409: errorResponse,
      422: validationErrorResponse,
      423: repoArchivedResponse,
    },
  });

const getPullRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/pulls/{index}",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get a pull request",
    operationId: "repoGetPullRequest",
    request: { params: z.object(pullIndexParams) },
    responses: {
      200: { description: "PullRequest", content: { "application/json": { schema: pullRequestSchema } } },
      404: notFoundResponse,
    },
  });

const editPullRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/pulls/{index}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Update a pull request. If using deadline only the date will be taken into account, and time of day ignored.",
    operationId: "repoEditPullRequest",
    request: {
      params: z.object(pullIndexParams),
      body: { content: { "application/json": { schema: editPullRequestOptionSchema } } },
    },
    responses: {
      201: { description: "PullRequest", content: { "application/json": { schema: pullRequestSchema } } },
      400: errorResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      409: errorResponse,
      412: errorResponse,
      422: validationErrorResponse,
    },
  });

const getPullByBaseHeadRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/pulls/{base}/{head}",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get a pull request by base and head",
    operationId: "repoGetPullRequestByBaseHead",
    request: { params: z.object(baseHeadParams) },
    responses: {
      200: { description: "PullRequest", content: { "application/json": { schema: pullRequestSchema } } },
      404: notFoundResponse,
    },
  });

/**
 * The github-flow CREATE arm's FIRST type-29 push comment — upstream's
 * NewPullRequest creates it for BOTH flows with one call (services/pull/
 * pull.go:145): `CreatePushPullComment(ctx, issue.Poster, pr,
 * git.BranchPrefix+pr.BaseBranch, pr.GetGitHeadRefName(), false)`. The
 * create shape derived at that pin mirrors the agit flow's landed
 * `createAgitFirstPushComment` (api/services/agit.ts — a reverse import
 * would cycle, so the minimal walk+insert shape is ported here):
 *
 *   - oldRef is the BASE BRANCH REF (`refs/heads/<base>`, modules/git/
 *     ref.go BranchPrefix) — never empty, never ZERO_OID — so the walk
 *     resolves the base branch's live tip; newRef is `refs/pull/N/head`
 *     (GetGitHeadRefName, models/issues/pull.go:406), landed moments
 *     earlier by this route's createPullHeadRef (upstream's PushToBaseRepo
 *     runs at pull.go:138-140, ahead of the comment in the same tx).
 *   - The doer is `issue.Poster` — at create the PR poster IS the pusher.
 *   - isForcePush is the LITERAL false: the force arm never runs at create
 *     — no merge-base walk, no `{is_force_push, [old, new]}` marker
 *     comment, no old-comment reconcile (comment.go:24-45's force branch).
 *   - The walk is the normal-push shape over the resolved tips:
 *     `rev-list --reverse -n limit baseTip..headTip` (comment.go:43-45 over
 *     GetCommitIDsBetweenReverse, modules/git/compare.go:48-55) — the PR's
 *     own commits, oldest-first, capped at the newest
 *     MAX_PUSH_COMMITS_IN_COMMENT — and an EMPTY walk (a head that adds
 *     nothing beyond its base) creates NO comment (shouldCreate=false,
 *     comment.go:44-45).
 *   - NO `PullRequestPushCommits` mail: the create pin fires none — the
 *     notify rides only the shared push path (pull.go:406-411, the update
 *     callers).
 *
 * Upstream's comment failure FAILS the whole NewPullRequest (pull.go:145-147
 * → the RemoveRef cleanup at :155-160); the route's recorded degradation
 * posture keeps the created PR and logs (the same posture every landed
 * create-tail leg documents). Never throws.
 */
async function createGithubFirstPushComment(c: Context<ApiEnv>, found: RepositoryWithOwner, pr: PullRequestRow, posterId: number | null): Promise<void> {
  try {
    const cell = engineCell(c.env, found.repo);
    const start = branchRef(pr.baseBranch);
    const end = pullHeadRef(pr.index);
    const collected: string[] = [];
    for (let page = 0; page < 2; page += 1) {
      const result = await cell.listCommitsRange(start, end, MAX_PUSH_COMMITS_IN_COMMENT, page);
      if (result === null) {
        console.error(`[pulls] ${found.repo.ownerNamespace}/${found.repo.slug}: push-comment walk ${start}..${end} failed`);
        return;
      }
      for (const commit of result.commits) collected.push(commit.oid);
      if (!result.more) break;
    }
    const commitIds = collected.slice(-MAX_PUSH_COMMITS_IN_COMMENT);
    if (commitIds.length === 0) return; // upstream shouldCreate=false — nothing beyond the base
    await new IssuesService(c.env.DB, c.env).addComment({
      issueId: pr.issueId,
      type: CommentType.PullRequestPush,
      posterId,
      content: JSON.stringify({ is_force_push: false, commit_ids: commitIds }),
      now: new Date(),
    });
  } catch (error) {
    console.error(
      `[pulls] ${found.repo.ownerNamespace}/${found.repo.slug}: the create arm's first push comment failed (the PR stands): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function registerPullRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/pulls/{index}.{diffType}
  // (repoDownloadPullDiffOrPatch) — raw text diff/patch over the PR range.
  // The contract's DOT-SUFFIX path cannot route through hono's param
  // conversion (`:index.:diffType` does not bind params), so the path is
  // declared DOC-ONLY through the registry and a plain pre-handler on the
  // one-segment pulls path intercepts `^(\d+)\.(diff|patch)$`, falling through
  // to the openapi `{index}` route otherwise.
  // -------------------------------------------------------------------------
  const pullDiffDocRoute = createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/pulls/{index}.{diffType}",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get a pull request diff",
    operationId: "repoDownloadPullDiffOrPatch",
    request: {
      params: z.object({
        ...ownerRepoParams,
        index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of the pull request to get" }),
        diffType: z.string().min(1).openapi({ type: "string", enum: ["diff", "patch"], description: "type of diff" }),
        binary: z.string().optional().openapi({ type: "boolean", description: "whether to include binary file changes" }),
      }),
    },
    responses: {
      200: { description: "string", content: { "text/plain": { schema: z.string() } } },
      404: notFoundResponse,
    },
  });
  app.openAPIRegistry.registerPath(pullDiffDocRoute);

  const handlePullDiff = async (c: Context<ApiEnv>, owner: string, repo: string, rawIndex: string, diffType: string): Promise<Response> => {
    const { found } = await requireVisibleRepo(c, { owner, repo });
    const { pullRequest } = await requirePullRequest(c, found, rawIndex);
    const checked = await ensurePullRequestChecked(c, found, pullRequest);
    const { files, mergeBase, head } = await pullRequestDiff(c, found, checked);
    void mergeBase;
    if (diffType === "patch") {
      const headCommit = (await engineReads(c.env, found.repo).readCommit(head)) ?? null;
      if (headCommit === null) {
        throw new ApiError(404, "not found");
      }
      return c.text(renderPatch(headCommit, files), 200);
    }
    return c.text(renderUnifiedDiff(files), 200);
  };

  app.get("/repos/:owner/:repo/pulls/:segment", async (c, next) => {
    const match = /^(\d+)\.(diff|patch)$/.exec(c.req.param("segment") ?? "");
    if (match === null) {
      return next();
    }
    const { owner, repo } = c.req.param();
    return handlePullDiff(c, owner, repo, match[1] as string, match[2] as string);
  });

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/pulls (repoListPullRequests)
  // -------------------------------------------------------------------------
  app.openapi(listPullsRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const url = new URL(c.req.url);
    const listOptions = parseListOptions(url);

    // labels: int64 ids — upstream `FormStrings("labels")` is a repeated
    // query parameter (collectionFormat multi); hono's validator cannot
    // round-trip repeated arrays, so the comma-separated form is accepted
    // too (documented in the model). A non-integer entry is
    // StringsToInt64s' error path: APIErrorInternal → the declared 500 with
    // an empty message.
    const labelIds: number[] = [];
    for (const raw of (url.searchParams.get("labels") ?? "").split(",")) {
      const part = raw.trim();
      if (part === "") continue;
      if (!/^-?\d+$/.test(part)) {
        throw new ApiError(500, "");
      }
      labelIds.push(Number.parseInt(part, 10));
    }

    // poster: unknown login is the upstream 400 (plain ErrUserNotExist text).
    let posterId = 0;
    const posterName = (url.searchParams.get("poster") ?? "").trim();
    if (posterName !== "") {
      const row = await drizzle(c.env.DB)
        .select({ id: users.id })
        .from(users)
        .where(eq(users.usernameLower, posterName.toLowerCase()))
        .limit(1)
        .then((rows) => rows[0]);
      if (row === undefined) {
        throw new ApiError(400, `user does not exist [uid: 0, name: ${posterName}]`);
      }
      posterId = row.id;
    }

    const milestone = pathId(url.searchParams.get("milestone") ?? "");

    const { items, total } = await listRepoPullRequests(c.env.DB, found.repo.id, {
      state: url.searchParams.get("state") ?? "",
      sort: (url.searchParams.get("sort") ?? "").trim(),
      labelIds,
      milestoneId: milestone,
      posterId,
      baseBranch: (url.searchParams.get("base_branch") ?? "").trim(),
      page: listOptions.page,
      limit: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    // The query-shape audit's A3 (the heaviest list): the per-PR enrichment
    // (issue posters/labels/pins/milestones via the B1 PR-row pass-through,
    // mergers, fork head-repo pairs + the A9 batched grant resolution) batches
    // into a constant number of page-scoped reads; response unchanged.
    const renderContext = await prefetchPullRequestRenderContext(c.env.DB, viewer, found, items);
    const rendered = await Promise.all(
      items.map(({ issue, pullRequest }) => toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "list", undefined, { context: renderContext })),
    );
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/pulls (repoCreatePullRequest) — 201
  // -------------------------------------------------------------------------
  app.openapi(
    createPullRoute(requireAuth),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const form = c.req.valid("json");
      // The notify env hop (specs/email-outbound.md §10.3): the service's
      // createPullRequest emit rides it (the NewPullRequest receiver,
      // services/mailer/notify.go:88-93); the arm no-ops unless
      // MAIL_ENABLED === "true".
      const service = new IssuesService(c.env.DB, c.env);
      const requester = c.get("authUser");

      // Upstream fail-fast: head == base has nothing to merge (422).
      if (form.head === form.base) {
        throw new ApiError(422, "Invalid PullRequest: There are no changes between the head and the base");
      }

      // parseCompareInfo: the base resolves inside this repo (owner-qualified
      // forms must name this repo), the head resolves through resolveHeadRepo
      // — the plain form is a branch of this repo, the `owner:branch` /
      // `owner/name:branch` fork forms name the head REPO. A cross-repo head
      // (the fork flow) adds three arms over the same-repo shape:
      //   - the doer must READ the head repo (requireReadableHeadRepo —
      //     pull.go:1063-1074; the row-miss and the unreadable-repo arms share
      //     the anti-enumeration 404),
      //   - the branch existence read runs against the HEAD cell (upstream
      //     opens headGitRepo, pull.go:1078-1089),
      //   - the create compare runs cross-repo (below).
      // Divergence (updated at 9ecb3e5): our bare `owner:branch` form now
      // searches the FORK EDGE FIRST (the FindHeadRepo port in
      // services/pulls.ts — name-free, rename-immune by construction), with
      // the path acceptance (owner, base slug) as FALLBACK; upstream's
      // missing-fork answer is 400 "the user %s does not have a fork of the
      // base repository" (compare.go:152-192) — ours stays the flat 404 (the
      // a16f60e anti-enumeration deviation). A non-fork head repo found by
      // the fallback is accepted where upstream's bare form would 400 — the
      // same acceptance upstream's explicit `owner/name:branch` form grants;
      // the fork edge wins over a same-slug non-fork (upstream-true order).
      let baseBranch = form.base;
      if (baseBranch.includes(":")) {
        const colon = baseBranch.indexOf(":");
        const baseOwner = baseBranch.slice(0, colon);
        if (baseOwner.toLowerCase() !== found.repo.ownerNamespace) {
          throw new ApiError(404, "not found");
        }
        baseBranch = baseBranch.slice(colon + 1);
      }
      const head = await resolveHeadRepo(c.env.DB, found, form.head);
      const headPair = head.headRepoId === found.repo.id ? found : await requireReadableHeadRepo(c, head.headRepoId);

      const reads = engineReads(c.env, found.repo);
      // parseCompareInfo resolves base and head (pull.go:1104-1113 via
      // UnstableGuessRefByShortName: branch → tag → existing commit) and the
      // create route then refuses everything that is not a BRANCH with the
      // 422 (pull.go:423-425): a tag, or an oid GetCommit RESOLVES, answers
      // the 422 — the oid check is existence-based (an unknown oid fails the
      // guess → the family 404s below). The extra probe runs only for a
      // non-branch 40-hex input, never on the branch path.
      const baseTips = refTipMap(await reads.listRefs());
      const headReads = headPair.repo.id === found.repo.id ? reads : engineReads(c.env, headPair.repo);
      const headTips = headPair.repo.id === found.repo.id ? baseTips : refTipMap(await headReads.listRefs());
      const baseBranchResolves = baseTips.get(branchRef(baseBranch)) !== undefined;
      const headBranchResolves = headTips.get(branchRef(head.headBranch)) !== undefined;
      const baseOidResolves =
        !baseBranchResolves && baseTips.get(tagRef(baseBranch)) === undefined && isFullObjectId(baseBranch)
          ? (await reads.readCommit(baseBranch)) !== null
          : false;
      const headOidResolves =
        !headBranchResolves && headTips.get(tagRef(head.headBranch)) === undefined && isFullObjectId(head.headBranch)
          ? (await headReads.readCommit(head.headBranch)) !== null
          : false;
      if (
        (!baseBranchResolves && (baseTips.get(tagRef(baseBranch)) !== undefined || baseOidResolves)) ||
        (!headBranchResolves && (headTips.get(tagRef(head.headBranch)) !== undefined || headOidResolves))
      ) {
        throw new ApiError(422, "Invalid PullRequest: base and head must be branches");
      }
      const baseTip = await reads.readCommit(branchRef(baseBranch));
      const headTip = await headReads.readCommit(branchRef(head.headBranch));
      if (baseTip === null) {
        // parseCompareInfo's base miss → APIErrorNotFound
        throw new ApiError(404, "not found");
      }
      if (headTip === null) {
        throw new ApiError(404, `Head branch does not exist [name: ${head.headBranch}]`);
      }

      // GetUnmergedPullRequest duplicate check → 409 (issue_id = the INDEX).
      const existing = await findUnmergedPullRequest(c.env.DB, head.headRepoId, found.repo.id, head.headBranch, baseBranch);
      if (existing !== null) {
        throw pullRequestAlreadyExistsError(existing);
      }

      // Milestone validation (GetMilestoneByRepoID, pull.go:477-482): the
      // create route answers a miss with the BARE 404 (ctx.APIErrorNotFound)
      // — NOT the issues-block typed message, which stays the PATCH/issues
      // convention — and it runs BEFORE the deadline parse below (both-bad →
      // 404 not 400, upstream's 477→524 order). The service's inner
      // validateMilestone stays as the probe→batch race guard (its typed
      // error re-renders bare at the create catch).
      const milestoneId = form.milestone === undefined || form.milestone === 0 ? null : form.milestone;
      if (milestoneId !== null) {
        const milestoneRow = await drizzle(c.env.DB)
          .select({ id: milestones.id })
          .from(milestones)
          .where(and(eq(milestones.id, milestoneId), eq(milestones.repoId, found.repo.id)))
          .limit(1)
          .get();
        if (milestoneRow === undefined) {
          throw new ApiError(404, "not found");
        }
      }

      // Labels: unknown ids silently dropped (GetLabelsInRepoByIDs), unlike
      // POST /issues which 404s them.
      const labelIds = await existingRepoLabelIds(c.env.DB, found.repo.id, form.labels ?? []);

      // ApplyAPIDeadlineTimestamp port — 400 "invalid date format" on bad
      // input (runtime-only status, same as the issues block). Upstream
      // parses it AFTER the milestone lookup (pull.go:524-528), so a
      // both-bad request answers the milestone's 404 (the order above).
      let deadlineAt: Date | null = null;
      if (form.due_date !== undefined && form.due_date !== null && form.due_date !== "") {
        deadlineAt = parseMilestoneDeadline(form.due_date);
      }

      // loadAssigneeUserIDs (pull.go:527 — the shared create resolver, the
      // issues-create arm's twin): the pre-write resolution of
      // form.assignee/assignees — NOT writer-gated on this route (unlike
      // the issues create, issue.go:606-622; any PR creator's assignees
      // resolve, pull.go:526-528 is unconditional). The create wrapper's
      // 422s fire BEFORE any row is written (services/issues.ts
      // resolveCreateAssigneeUsers — orgs never resolve,
      // GetDoerUsersByNames' type filter). The ARG order mirrors upstream's
      // call — loadAssigneeUserIDs(ctx, form.Assignee, form.Assignees):
      // the singular rides FIRST (upstream's Set then randomizes, so this
      // is the deterministic analogue of its input order).
      const createAssignees = await resolveCreateAssigneeUsers(c.env.DB, found, [
        ...(form.assignee !== undefined && form.assignee !== null && form.assignee !== "" ? [form.assignee] : []),
        ...(form.assignees ?? []),
      ]);

      // parseReviewersByNames (pull.go:539 → pull_review.go:826-865): names
      // or emails resolved BEFORE NewPullRequest — the first miss 404s
      // ("user doesn't exist: X") with NO row written. The team loop runs
      // ONLY on an org-owned repo (`ctx.Repo.Repository.Owner.
      // IsOrganization()`, :857): a user-owned repo's team_reviewers are
      // silently ignored (upstream skips the loop entirely).
      const createReviewers: UserRow[] = [];
      for (const name of form.reviewers ?? []) {
        const row = name.includes("@")
          ? (await drizzle(c.env.DB).select().from(users).where(eq(users.email, name)).limit(1).all())[0]
          : (await drizzle(c.env.DB).select().from(users).where(eq(users.usernameLower, name.toLowerCase())).limit(1).all())[0];
        if (row === undefined) {
          throw new ApiError(404, `user doesn't exist: ${name}`);
        }
        createReviewers.push(row);
      }
      const createTeamReviewers: Array<typeof teams.$inferSelect> = [];
      if (found.owner.type === "org") {
        for (const name of form.team_reviewers ?? []) {
          const team = (
            await drizzle(c.env.DB)
              .select()
              .from(teams)
              .where(and(eq(teams.orgId, found.owner.id), eq(teams.lowerName, name.toLowerCase())))
              .limit(1)
              .all()
          )[0];
          if (team === undefined) {
            throw new ApiError(404, `team doesn't exist: ${name}`);
          }
          createTeamReviewers.push(team);
        }
      }

      let issue: IssueRow;
      let pr: PullRequestRow;
      // NewPullRequest's blocked arm (services/pull/pull.go:66-70 via
      // repoCreatePullRequest's APIErrorAuto → 403, pull.go:532-535 at the
      // 640cd615c4 shape): the POSTER blocked by the repo owner — OR by any
      // REQUESTED ASSIGNEE (the condition's second half, upstream `||`
      // order: owner first) — refuses before any row is written.
      // 640cd615c4 split the two answers into translatable wraps over the
      // SAME ErrBlockedUser PermissionDenied error: owner-block renders
      // repo.creation_blocked_by_owner, assignee-block
      // repo.creation_blocked_by_assignee — both stay 403 with the locale
      // message as the body. The isUserBlockedBy site-admin short-circuit is
      // upstream's `blockee.IsAdmin`.
      if (await isUserBlockedBy(c.env.DB, { id: requester.id ?? 0, isAdmin: requester.is_admin === true }, found.repo.ownerId ?? -1)) {
        throw new ApiError(403, "Cannot create an issue or pull request because you are blocked by the repository owner.");
      }
      for (const user of createAssignees) {
        if (await isUserBlockedBy(c.env.DB, { id: requester.id ?? 0, isAdmin: requester.is_admin === true }, user.id)) {
          throw new ApiError(403, "Cannot create an issue or pull request because you are blocked by an assignee.");
        }
      }

      // NewPullRequest's creation gate (services/pull/pull.go:74-90 at
      // 640cd615c4): the PR unit's CreationRestriction option is checked
      // FIRST (CheckCreationRestriction, services/issue/creation.go:14-28 —
      // the zero/default arm admits any READER; the Member/Writer arms are
      // the new "Restrict to collaborators" repo-unit option, NOT yet carried
      // by our repo settings — handoff REPIN-REPO-SETTINGS), then the
      // fallback ladder: a writer of the base repo's pull-requests unit (or
      // the AGit flow — unreachable on this API route) creates directly;
      // everyone else must hold the HEAD repo's code WRITE
      // (issues_model.Errors().MustHeadRepoCodeWriter → 403 with its exact
      // message through APIErrorAuto, pull.go:532-535). This replaces the
      // pre-640cd615c4 read-access collaborator gate (HasAccessToRepoCodeUnit
      // → ErrMustCollaborator) upstream deleted.
      if (!(await canWriteRepository(c, found))) {
        if (headPair.repo.id === found.repo.id) {
          throw new ApiError(403, "user must have write access to the head repository's code");
        }
        const headAccess = await principalAccessOf(c.env.DB, headPair.repo, requester);
        if (!headAccess.write) {
          throw new ApiError(403, "user must have write access to the head repository's code");
        }
      }

      // The cross-repo create compare (GetCompareInfo, upstream pull.go:516
      // stores the result as pr.MergeBase): the merge base computes IN THE
      // HEAD CELL — the fork holds the base's full history (SPEC-0001b §5.2;
      // services/git/compare.go:73-89 runs the same computation in the head
      // repo after fetching the base commit into it) — and the head closure
      // is carried into the BASE cell so refs/pull/N/head's landing, the lazy
      // mergeability check, the diff range and the merge execution all resolve
      // there (commitApiChange refuses an oid the cell lacks). Runs for EVERY
      // head since 2a5c34c379: the create compare parses `base...head` and a
      // NULL merge base answers the 422
      // "Invalid PullRequest: base and head have no common history"
      // (pull.go:417-420) — unrelated histories can no longer open a PR
      // (the PullRequestStatusUnrelated status only arises for rows whose
      // branches diverge AFTER creation). The carries are engine writes, so a
      // 403/409/404/422 request moves no bytes.
      let mergeBaseOid: string | null;
      if (headPair.repo.id !== found.repo.id) {
        mergeBaseOid = await crossRepoCreateMergeBase(c, found, headPair, baseBranch, baseTip.oid, headTip.oid);
      } else {
        const mb = await reads.mergeBase(baseTip.oid, headTip.oid);
        mergeBaseOid = mb !== null && mb.tag === "ok" ? mb.base : null;
      }
      if (mergeBaseOid === null) {
        throw new ApiError(422, "Invalid PullRequest: base and head have no common history");
      }
      if (headPair.repo.id !== found.repo.id) {
        await carryForkHeadIntoBase(c, found, headPair, head.headBranch, headTip.oid);
      }
      try {
        ({ issue, pullRequest: pr } = await service.createPullRequest({
          repoId: found.repo.id,
          headRepoId: head.headRepoId,
          baseBranch,
          headBranch: head.headBranch,
          title: form.title,
          content: form.body ?? null,
          posterId: requester.id,
          milestoneId,
          labelIds,
          allowMaintainerEdit: form.allow_maintainer_edit ?? true, // DefaultAllowMaintainerEdit (repo_unit default)
          headSha: headTip.oid,
          mergeBase: mergeBaseOid,
          // The xref scan's AppURL (B-46): the request origin rewrites
          // AppURL-prefixed full URLs into short refs (references.go:330-339)
          // — PR create shares NewIssueWithIndex's AddCrossReferences tail.
          appUrl: new URL(c.req.url).origin,
        }));
      } catch (error) {
        // The create route's milestone miss renders the BARE 404
        // (pull.go:477-482's APIErrorNotFound) even on the probe→batch race —
        // the typed rendering stays the PATCH/issues-block convention.
        if (error instanceof MilestoneNotExistError) {
          throw new ApiError(404, "not found");
        }
        asApiError(error);
        throw error;
      }

      // The base-repo head ref: a receive-less CAS write (commitApiChange,
      // SPEC-0001b §4.4 mapping). Failure after the D1 commit deletes the row
      // again (upstream's cleanup order, services/pull/pull.go:157). A fork
      // head's already-carried objects stay behind unreferenced — the GC
      // sweep reclaims them, the same posture as upstream's leftover
      // temp-fetch objects.
      try {
        await createPullHeadRef(c, found, pr.index, headTip.oid);
      } catch (error) {
        await drizzle(c.env.DB).delete(issues).where(eq(issues.id, issue.id));
        await drizzle(c.env.DB).delete(pullRequests).where(eq(pullRequests.id, pr.id));
        throw error;
      }
      if (deadlineAt !== null) {
        const updated = await drizzle(c.env.DB)
          .update(issues)
          .set({ deadlineAt })
          .where(eq(issues.id, issue.id))
          .returning();
        issue = updated[0] ?? issue;
      }

      // NewPullRequest's assignee half (services/pull/pull.go:71-82, inside
      // the tx): the rows + type-9 comments land through the /assignees
      // trio's AddAssignees core — the fresh PR issue has no pre-assignment
      // (the skip is unreachable) and the blocked/assignable arms are
      // pre-checked above. Upstream writes the assignees INSIDE the tx
      // BEFORE PushToBaseRepo; this landed create is not one transaction,
      // so the rows land after the committed row + head-ref prefix (the
      // same documented posture).
      const addedAssignees = await addIssueAssignees(c.env.DB, found, issue, createAssignees, {
        id: requester.id ?? 0,
        isAdmin: requester.is_admin === true,
      });

      // The FIRST type-29 push comment — upstream's NewPullRequest writes it
      // for BOTH flows inside the create tx AFTER the assignees and the
      // flow's ref arm, BEFORE the codeowners/webhook arms (services/pull/
      // pull.go:145 → :149-152 codeowners → :187 opened). Landed here —
      // after the head ref (createPullHeadRef, our PushToBaseRepo) and the
      // assignees — with the create shape's specifics (the helper's
      // docstring carries the cites). The agit flow's create arm lands the
      // same comment through its own tail (api/services/agit.ts).
      await createGithubFirstPushComment(c, found, pr, issue.posterId ?? null);

      // NewPullRequest's reviewer arms (services/pull/pull.go:169-181):
      // `issue_service.ReviewRequest` / `TeamReviewRequest` run AFTER the tx
      // committed — BEFORE the opened webhook (:187). The landed standalone
      // ladder's validation gates ride the SAME service arms; on the create
      // path upstream maps NONE of the ErrNotValidReviewRequest family
      // (repoCreatePullRequest's :547-555 arm list has no entry) — the
      // failure answers the APIErrorInternal 500 with the exact error text,
      // the PR row ALREADY COMMITTED (upstream's committed-prefix wart:
      // the 500 races a created PR, both upstream's and ours).
      const reviews = new PullReviewsService(c.env.DB, c.env);
      const doerId = requester.id ?? 0;
      // NewPullRequest's CODEOWNERS arm (services/pull/pull.go:149-152, the
      // pullRequestCodeOwnersReview ladder): the changed files' code owners
      // get review-REQUEST rows BEFORE the explicit reviewer arms — upstream
      // writes them inside the create tx (:151-153) and announces them first
      // (ReviewRequestNotify, :166); the landed arm runs on the committed
      // row with the same ordering (rows → announce → explicit loops), the
      // same failure direction (an error 500s the create — the committed-
      // prefix wart above; upstream's tx additionally rolls the PR back).
      const codeOwnerRequests = await pullRequestCodeOwnersReview(c.env, c.env.DB, found, issue, pr, doerId);
      // The review_request payloads share ONE ToPayloadPullRequest render
      // (upstream re-converts per notifier call, notifier.go:793-815 — the
      // shared render is the cheaper adapter; the payload mode carries the
      // head repo past the doer's visibility, convert/pull.go:46-50).
      let reviewPayloadRender: Awaited<ReturnType<typeof toApiPullRequest>> | null = null;
      let reviewRepositoryRender: ReturnType<typeof toApiRepository> | null = null;
      if (codeOwnerRequests.length > 0 || createReviewers.length > 0 || createTeamReviewers.length > 0) {
        const reviewDiffStats = await pullRequestDiffShortStat(c, found, pr);
        reviewPayloadRender = await toApiPullRequest(c.env.DB, viewer, found, issue, pr, "payload", reviewDiffStats === null ? undefined : { diffStats: reviewDiffStats });
        reviewRepositoryRender = toApiRepository(viewerOf(c), found);
      }
      const reviewRequestEvent = (requestedReviewer: unknown): void | Promise<void> =>
        emitIssueEvent(c, {
          repoId: found.repo.id,
          ownerId: found.repo.ownerId,
          eventType: "pull_request_review_request",
          payload: {
            action: "review_requested",
            number: issue.index,
            pull_request: reviewPayloadRender,
            ...(requestedReviewer === null ? {} : { requested_reviewer: requestedReviewer }),
            repository: reviewRepositoryRender,
            sender: c.get("authUser"),
            commit_id: "",
          },
        });
      // ReviewRequestNotify's announce order (:206-219): the auto arm's
      // webhooks fire FIRST, one per landed user request and one per team
      // request (the team arm's requested_reviewer omission is the module's
      // recorded webhook convention).
      for (const request of codeOwnerRequests) {
        await reviewRequestEvent(request.kind === "user" ? apiUserFromRow(request.user, viewer) : null);
      }
      for (const reviewer of createReviewers) {
        if (reviewer.type === "org") {
          throw new ApiError(500, `Organization can't be added as reviewer [user_id: ${doerId}, repo_id: ${found.repo.id}]`);
        }
        // permReviewer.CanAccessAny(read, TypePullRequests) (review_request.
        // go:82-86) — the reviewer's read arm rides the same team-aware
        // predicate the standalone route ladder uses (SPEC-0007 §3.5): the
        // SYNC visibility matrix first, then the grant reads. (The ladder's
        // exact shape — canViewRepository, NOT the async
        // canViewRepositoryWithTeams: an un-awaited promise is truthy and
        // would admit every reviewer.)
        const reviewerViewer: Viewer = { origin: viewer.origin, requester: apiUserFromRow(reviewer, viewer) };
        const canRead =
          canViewRepository(reviewerViewer, found.repo) ||
          (await doerRepoAccessMode(c.env.DB, found.repo, reviewer.id)) !== "none" ||
          (await collaboratorModeOf(c.env.DB, found.repo.id, reviewer.id)) !== "none";
        if (!canRead) {
          throw new ApiError(500, `Reviewer can't read [user_id: ${doerId}, repo_id: ${found.repo.id}]`);
        }
        if (issue.posterId !== null && reviewer.id === issue.posterId) {
          throw new ApiError(500, `poster of pr can't be reviewer [user_id: ${doerId}, repo_id: ${found.repo.id}]`);
        }
        // canDoerChangeReviewRequests is poster-true on the create path
        // (review_request.go:97 → the Doer-can't-choose arm is unreachable;
        // lastReview is null on a fresh PR).
        const requested = await reviews.addReviewRequest(found, issue, pr, reviewer, doerId);
        if (requested !== null) {
          await reviewRequestEvent(apiUserFromRow(reviewer, viewer));
        }
      }
      for (const team of createTeamReviewers) {
        const requested = await reviews.addTeamReviewRequest(issue, pr, team, doerId);
        if (requested !== null) {
          // requested_reviewer omitted on the team arm (the module-header
          // deviation the standalone lane documents).
          await reviewRequestEvent(null);
        }
      }

      // Upstream converts TWICE at the create route: the 201 body serializes
      // convert.ToAPIPullRequest (pull.go:558) while pull_service.NewPullRequest
      // (pull.go:544) already fired webhookNotifier.NewPullRequest, whose opened
      // payload is a SEPARATE conversion — ToPayloadPullRequest (notifier.go:368).
      // The split mirrors that: the API response keeps the doer-gated "single"
      // render, the opened payload gets its own "payload" render (head.repo
      // reaches the receivers regardless of the doer, convert/pull.go:46-50).
      // BOTH conversions fill the diff-stat trio — the single converter's
      // GetDiffShortStat block is NOT gated on isPayload (convert/pull.go:245-269),
      // and the fresh PR's merge base is servable: NewPullRequest resolves
      // pr.MergeBase synchronously at create (services/pull/pull.go:96 →
      // checkPullRequestBranchMergeable, patch.go:83-91 / merge_tree.go:107).
      // One engine resolution feeds both renders (upstream recomputes the stat
      // per conversion — the shared read is the cheaper adapter); the omit
      // arms (no merge base, truncated walk, engine failure :247-250) omit
      // from both.
      const diffStats = await pullRequestDiffShortStat(c, found, pr);
      const extras = diffStats === null ? undefined : { diffStats };
      const rendered = await toApiPullRequest(c.env.DB, viewer, found, issue, pr, "single", extras);
      const payloadRendered = await toApiPullRequest(c.env.DB, viewer, found, issue, pr, "payload", extras);
      // Webhook: pull_request opened.
      await emitPullWebhook(c, {
        repoId: found.repo.id,
        ownerId: found.repo.ownerId,
        eventType: "pull_request",
        payload: pullRequestPayload("opened", payloadRendered, issue.index, toApiRepository(viewerOf(c), found), c.get("authUser")),
      });
      // NewPullRequest's post-tx assignee notify (services/pull/pull.go:
      // 191-193 → IssueChangeAssignee): ONE assign webhook per actually-
      // added assignee, AFTER opened (upstream order :187/:191; the landed
      // create carries no labels/milestone notify arm — unchanged).
      for (const user of addedAssignees) {
        await emitPullAssignWebhook(c, found, issue, "assigned", { added_assignees: [toApiUser(viewerOf(c), user)] });
      }
      // Upstream's create 201 renders the converter's LoadRequestedReviewers
      // (pull.go:558 → convert/pull.go:137) — the review requests created
      // above render in the response, the same consult the GET rides.
      return c.json({ ...rendered, requested_reviewers: await requestedReviewersOf(c.env.DB, issue.id, viewer) }, 201);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/pulls/{index} (repoGetPullRequest) — runs the
  // LAZY mergeability check (SPEC-0005 §3.4: a `checking` row fires the
  // read-only engine check and CAS-writes the row) and renders the real
  // mergeable/base.sha pair. The REVIEW-CONSULT (the pull-reviews wave):
  // `requested_reviewers` renders from the review-REQUEST rows
  // (services/convert/pull.go:137 LoadRequestedReviewers) instead of the
  // converter's `[]` default, and the diff-stat trio
  // (`additions`/`deletions`/`changed_files`) from the GetDiffShortStat port
  // (pullRequestDiffShortStat over convert/pull.go:260-269 — upstream's
  // single converter fills the stats on EVERY single render; the omit arms —
  // no merge base, truncated engine walk, engine failure — mirror its error
  // log :247-250). The same trio mounts on the create 201 body + its opened
  // payload (pull.go:558, :31-34), the edit 201 body + its payload renders
  // (:799, the notifiers), the by-basehead render (:300) and the merge
  // closed payload (notifier.go:715) — every toAPIPullRequest conversion
  // site, like upstream's single converter.
  // -------------------------------------------------------------------------
  app.openapi(getPullRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const { issue, pullRequest } = await requirePullRequest(c, found, c.req.valid("param").index);
    const checked = await ensurePullRequestChecked(c, found, pullRequest);
    const baseSha = (await engineReads(c.env, found.repo).readCommit(branchRef(checked.baseBranch)))?.oid;
    const diffStats = await pullRequestDiffShortStat(c, found, checked);
    const rendered = await toApiPullRequest(c.env.DB, viewer, found, issue, checked, "single", {
      mergeable: mergeableOfRow(checked, hasWorkInProgressPrefix(issue.title)),
      ...(baseSha === undefined ? {} : { baseSha }),
      ...(diffStats === null ? {} : { diffStats }),
    });
    const requestedReviewers = await requestedReviewersOf(c.env.DB, issue.id, viewer);
    return c.json({ ...rendered, requested_reviewers: requestedReviewers }, 200);
  });

  // -------------------------------------------------------------------------
  // PATCH /repos/{owner}/{repo}/pulls/{index} (repoEditPullRequest) — 201 quirk
  // -------------------------------------------------------------------------
  app.openapi(
    editPullRoute(requireAuth),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      // Upstream registers NO mustNotBeArchived on this PATCH — 423 not emitted.
      let { issue, pullRequest } = await requirePullRequest(c, found, c.req.valid("param").index);
      if (!canEditPullRequest(c, found, issue.posterId)) {
        // Upstream answers a bare Status(403); the envelope carries an empty message.
        throw new ApiError(403, "");
      }
      // The diff-stat trio resolves AT MOST ONCE per PATCH, lazily on the
      // first render that needs it: upstream recomputes GetDiffShortStat per
      // conversion — the single converter fills the trio on EVERY single AND
      // payload render (convert/pull.go:245-269), the edit route's 201 body
      // (:799) and its notifiers' payloads (IssueChangeTitle webhook/notifier.go:225,
      // IssueChangeContent :397, IssueChangeStatus :260) included — and the
      // shared memo is the cheaper adapter. The laziness keeps the engine
      // read off the failing arms (403/409/412 never convert). The omit arms
      // (no merge base, truncated walk, engine failure :247-250) omit from
      // every render of this request.
      let diffStatsMemo: { additions: number; deletions: number; changedFiles: number } | null | undefined;
      const diffStatsExtras = async (): Promise<{ diffStats: { additions: number; deletions: number; changedFiles: number } } | undefined> => {
        if (diffStatsMemo === undefined) {
          diffStatsMemo = await pullRequestDiffShortStat(c, found, pullRequest);
        }
        return diffStatsMemo === null ? undefined : { diffStats: diffStatsMemo };
      };
      const form = c.req.valid("json");
      const service = new IssuesService(c.env.DB, c.env);
      const requester = c.get("authUser");
      if (requester === undefined) {
        throw new ApiError(401, "token is required"); // unreachable behind requireAuth
      }
      const actorId = requester.id ?? 0;
      const now = new Date();
      const isWriter = repositoryPermissions(viewerOf(c), found.repo).admin === true || repositoryPermissions(viewerOf(c), found.repo).push === true;

      // Fail-fast stale version check (upstream rejects BEFORE mutating; the
      // DB-level CAS in ChangeContent covers the concurrent window).
      const requestedVersion = patchField(form.content_version);
      if (requestedVersion !== undefined && requestedVersion !== issue.contentVersion) {
        throw new ApiError(409, "the issue is already changed");
      }

      const title = patchField(form.title);
      if (title !== undefined && title.length > 0 && title !== issue.title) {
        const oldTitle = issue.title;
        // The IssuesService fold carries the IssueChangeTitle mail receiver
        // (services/mailer/notify.go:80-90 — upstream fires it from
        // ChangeTitle, issue.go:127). The xref scan's AppURL rides the
        // request origin (B-46 — the ChangeIssueTitle tail,
        // models/issues/issue_update.go:217).
        const updated = await service.changeTitle(issue, title, actorId, now, new URL(c.req.url).origin);
        if (updated !== null) {
          issue = updated;
        }
        // The edited payload is upstream's ToPayloadPullRequest render
        // (IssueChangeTitle, webhook/notifier.go:225) — payload mode.
        await emitPullWebhook(c, {
          repoId: found.repo.id,
          ownerId: found.repo.ownerId,
          eventType: "pull_request",
          payload: pullRequestPayload(
            "edited",
            await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "payload", await diffStatsExtras()),
            issue.index,
            toApiRepository(viewerOf(c), found),
            c.get("authUser"),
            { changes: { title: { from: oldTitle } } },
          ),
        });
      }

      const body = patchField(form.body);
      if (body !== undefined && body !== (issue.content ?? "")) {
        const oldContent = issue.content ?? "";
        // The xref scan's AppURL rides the request origin (B-46 — the
        // ChangeIssueContent tail, models/issues/issue_update.go:345).
        const updated = await changeIssueBody(c.env.DB, issue, body, requestedVersion ?? issue.contentVersion, now, actorId, new URL(c.req.url).origin);
        if (updated === null) {
          // Lost the concurrent CAS race — upstream ErrIssueAlreadyChanged.
          throw new ApiError(409, "the issue is already changed");
        }
        issue = updated;
        // IssueChangeContent's payload render (webhook/notifier.go:397).
        await emitPullWebhook(c, {
          repoId: found.repo.id,
          ownerId: found.repo.ownerId,
          eventType: "pull_request",
          payload: pullRequestPayload(
            "edited",
            await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "payload", await diffStatsExtras()),
            issue.index,
            toApiRepository(viewerOf(c), found),
            c.get("authUser"),
            { changes: { body: { from: oldContent } } },
          ),
        });
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

      // form.assignee(s): upstream REPLACES the assignee set (EditPullRequest
      // → UpdateAssignees, pull.go:674-694) — the landed issue_assignees
      // table makes the fields live (the old issues-PATCH ignore is
      // superseded; the blocks-enforcement sweep wires pull.go:687's blocked
      // arm here, which needs the surface). Writer-gated upstream
      // (CanWrite(TypePullRequests)) with `Assignees != nil ||
      // len(Assignee) > 0`; an empty array clears the set. The final
      // findPullRequestByIndex refetch below re-renders the post-change set.
      if (
        isWriter &&
        ((form.assignees !== undefined && form.assignees !== null) ||
          (form.assignee !== undefined && form.assignee !== null && form.assignee.length > 0))
      ) {
        await replacePullAssignees(c, found, issue, [...(form.assignees ?? []), ...(form.assignee ? [form.assignee] : [])]);
      }

      // form.base: the retarget (pull.go:748-772) — the GATE skips silently
      // on a merged PR, an empty/absent base, and base == the current base
      // (all three PATCH-succeed with the field ignored, upstream-true);
      // then the branch-existence probe answers 404 `new base '%s' not
      // exist` BEFORE ChangeTargetBranch, whose mapped errors ride the
      // engine's landed retarget (changePullRequestTargetBranch — the same
      // service the web merge-box calls) re-pointed at the API's error
      // texts via errorFlavor. Upstream then fires the
      // PullRequestChangeTargetBranch webhook (:772 — action "edited" +
      // changes.ref.from = the OLD base).
      const retarget = patchField(form.base);
      if (!pullRequest.hasMerged && retarget !== undefined && retarget !== null && retarget !== "" && retarget !== pullRequest.baseBranch) {
        const branchExists = refTipMap(await engineReads(c.env, found.repo).listRefs()).get(branchRef(retarget)) !== undefined;
        if (!branchExists) {
          throw new ApiError(404, `new base '${retarget}' not exist`);
        }
        const oldRetargetBase = pullRequest.baseBranch;
        // The service carries the whole upstream tail (pull.go:226-358): the
        // CAS + RecalculateReviewsOfficial + the type-25 ChangeTargetBranch
        // comment (oldRef/newRef — no num_comments bump) + the push-comments
        // delete/recreate — all keyed on the doer (the tail's CreateComment
        // attribution; the doer-less web caller predates the tail).
        await changePullRequestTargetBranch(c, found, issue, pullRequest, {
          targetBranch: retarget,
          now,
          errorFlavor: "api",
          doerId: actorId,
        });
        pullRequest = { ...pullRequest, baseBranch: retarget };
        // DisableAutoMergeIfNotWriter (pull.go:337, reason "base_changed"):
        // a NON-writer's retarget cancels the scheduled auto-merge; a
        // writer's stays (pull.go:375 — the new base may have made it
        // mergeable). Upstream runs the check inside the retarget tx
        // (UpdateColsIfNotMerged's winner half); ours rides the landed
        // non-transactional doer-tail posture — a crash between leaves the
        // schedule for the cron re-probe to settle.
        await disableAutoMergeIfNotWriter(
          c.env.DB,
          issue,
          { id: requester.id ?? 0, username: requester.login ?? "", isAdmin: requester.is_admin ?? null },
          found.repo,
          now,
          "base_changed",
        );
        // PullRequestChangeTargetBranch (webhook/notifier.go:726-748):
        // action "edited" with changes.ref.from = the old base.
        await emitPullWebhook(c, {
          repoId: found.repo.id,
          ownerId: found.repo.ownerId,
          eventType: "pull_request",
          payload: pullRequestPayload(
            "edited",
            await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "payload", await diffStatsExtras()),
            issue.index,
            toApiRepository(viewerOf(c), found),
            c.get("authUser"),
            { changes: { ref: { from: oldRetargetBase } } },
          ),
        });
      }

      // Milestone: only on actual change (upstream guards with != and writer).
      const milestone = patchField(form.milestone);
      if (isWriter && milestone !== undefined && milestone !== 0 && milestone !== issue.milestoneId) {
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
        // Upstream's milestone notifier fires from the shared issue service —
        // the pulls-PATCH arm is the same mutation and must not stay silent
        // (the EMIT-5 wave's flagged gap; same action discriminant).
        await emitMilestoneEvent(c, found, issue, newMilestoneId !== null ? "milestoned" : "demilestoned");
      }

      // Labels: writer-gated REPLACE semantics (ReplaceIssueLabels); unknown
      // ids silently dropped (GetLabelsInRepoByIDs).
      if (isWriter && form.labels !== undefined && form.labels !== null) {
        const labelIds = await existingRepoLabelIds(c.env.DB, found.repo.id, form.labels);
        try {
          await service.replaceLabels(issue.id, labelIds, { ownerOrgId: null });
        } catch (error) {
          asApiError(error);
          throw error;
        }
      }

      // State: the merged precondition first (412), then the CAS transitions.
      const state = patchField(form.state);
      if (state !== undefined) {
        if (pullRequest.hasMerged) {
          throw new ApiError(412, "cannot change state of this pull request, it was already merged");
        }
        if (state === "closed" && !issue.isClosed) {
          try {
            issue = await service.closeIssue(issue.id, { actorId });
          } catch (error) {
            asApiError(error);
            throw error;
          }
          // IssueChangeStatus's payload render (webhook/notifier.go:260).
          await emitPullWebhook(c, {
            repoId: found.repo.id,
            ownerId: found.repo.ownerId,
            eventType: "pull_request",
            payload: pullRequestPayload(
              "closed",
              await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "payload", await diffStatsExtras()),
              issue.index,
              toApiRepository(viewerOf(c), found),
              c.get("authUser"),
            ),
          });
        } else if (state === "open" && issue.isClosed) {
          try {
            issue = await service.reopenIssue(issue.id, { actorId });
          } catch (error) {
            asApiError(error);
            throw error;
          }
          // IssueChangeStatus's payload render (webhook/notifier.go:260).
          await emitPullWebhook(c, {
            repoId: found.repo.id,
            ownerId: found.repo.ownerId,
            eventType: "pull_request",
            payload: pullRequestPayload(
              "reopened",
              await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "payload", await diffStatsExtras()),
              issue.index,
              toApiRepository(viewerOf(c), found),
              c.get("authUser"),
            ),
          });
        }
      }

      // allow_maintainer_edit: the D1 column exists — apply the update
      // (upstream SetAllowEdits, reduced to the PATCH gate's writer check).
      const allowMaintainerEdit = patchField(form.allow_maintainer_edit);
      if (allowMaintainerEdit !== undefined && allowMaintainerEdit !== pullRequest.allowMaintainerEdit) {
        await drizzle(c.env.DB)
          .update(pullRequests)
          .set({ allowMaintainerEdit })
          .where(eq(pullRequests.id, pullRequest.id));
        pullRequest = { ...pullRequest, allowMaintainerEdit };
      }

      // Refetch the issue row for the authoritative render (upstream refetches too).
      const fresh = await findPullRequestByIndex(c.env.DB, found.repo.id, pullRequest.index);
      if (fresh !== null) {
        issue = fresh.issue;
        pullRequest = fresh.pullRequest;
      }
      // The edit route's 201 carries the trio like the GET — the refetched row
      // converts through the same single converter (pull.go:799 — upstream
      // answers StatusCreated here too, with the in-source TODO "this should
      // be 200, not 201" above :799).
      return c.json(await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "single", await diffStatsExtras()), 201);
    },
    bindValidationHook,
  );



  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/pulls/{index}/commits (repoGetPullRequestCommits)
  // — the PR range walk (CommitList carries the contract's X-* header family;
  // the newest-first git-log order + newest-side pagination, see the handler).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/pulls/{index}/commits",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get commits for a pull request",
      operationId: "repoGetPullRequestCommits",
      request: {
        params: z.object(pullIndexParams),
        query: z.object({
          page: pageLimitQuery.page,
          limit: pageLimitQuery.limit,
          verification: z.string().optional().openapi({ type: "boolean", description: "include verification for every commit (default true)" }),
          files: z.string().optional().openapi({ type: "boolean", description: "include a list of affected files for every commit (default true)" }),
        }),
      },
      responses: {
        200: { description: "CommitList", content: { "application/json": { schema: commitListSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { found } = await requireVisibleRepo(c, c.req.valid("param"));
      const { pullRequest } = await requirePullRequest(c, found, c.req.valid("param").index);
      const checked = await ensurePullRequestChecked(c, found, pullRequest);
      const listOptions = parseListOptions(new URL(c.req.url));
      const url = new URL(c.req.url);
      const statFlag = formBoolDefault(url, "stat");
      const filesFlag = formBoolDefault(url, "files");

      const reads = engineReads(c.env, found.repo);
      const range = await pullRequestDiff(c, found, checked);
      // Upstream serves the PR commit list in git-log order, NEWEST first,
      // and pages from that side (page 1 = the newest `limit` commits —
      // compare.go's ShowPrettyFormatLogToList over merge_base..head). The
      // engine's listCommitsRange is oldest-first with oldest-side page
      // semantics (SPEC-0001b §4.1), so the handler walks one bounded window
      // (the upstream full-list bound; X-Total-Count stays the module's
      // so-far approximation), reverses it, and slices the requested page
      // out of the reversed order — the push-payload reversal precedent
      // (webhooks-push.ts).
      const rangeCommits =
        checked.mergeBase === null
          ? { commits: [], more: false }
          : ((await reads.listCommitsRange(checked.mergeBase, range.head, PULL_COMMITS_BOUND)) ?? { commits: [], more: false });
      const newestFirst = [...rangeCommits.commits].reverse();
      const start = (listOptions.page - 1) * listOptions.limit;
      const commits = newestFirst.slice(start, start + listOptions.limit);
      // Past-the-bound pages stay empty; `more` (the engine's walk-truncation
      // flag) keeps the next Link relation alive through the last in-bound
      // page like the previous per-page walk did.
      const hasMore = start + listOptions.limit < newestFirst.length || rangeCommits.more;
      // X-Total-Count approximation: commits SO FAR (module doc on
      // setCommitListHeaders); the Link header gets a next relation when the
      // walk reports more.
      const soFar = (listOptions.page - 1) * listOptions.limit + commits.length;
      setPaginationHeaders(c, soFar + (hasMore ? 1 : 0), listOptions);
      setCommitListHeaders(c, listOptions, soFar, hasMore);

      const usernames = await usernamesByEmail(c.env.DB, commits);
      const viewer = viewerOf(c);
      const rendered = await Promise.all(
        commits.map(async (commit) =>
          toApiCommit(c.env.DB, reads, viewer, found, commit, usernames, { stat: statFlag, files: filesFlag }),
        ),
      );
      return c.json(rendered, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/pulls/{index}/files (repoGetPullRequestFiles)
  // — ChangedFileList over the range diff (the other X-* header family).
  //
  // Query surface per upstream (pull.go:1518-1545 + the swagger):
  //   - `skip-to` (the upstream param NAME — pull.go:1541 reads
  //     FormString("skip-to")) starts the list AT the named file:
  //     `git diff --skip-to=` semantics (gitdiff.go:1331-1333) — files from
  //     that path onward, an unmatching name yielding the empty list. The
  //     X-Total-Count stays the FULL file count (upstream computes it from a
  //     separate shortstat walk WITHOUT SkipTo, pull.go:1553-1561), and the
  //     page window slices the SKIPPED list (pull.go:1563-1570).
  //   - `whitespace` is NOT declared: upstream passes it to the diff
  //     generator (WhitespaceBehavior, pull.go:1536; the -w/-b/
  //     --ignore-space-at-eol flag table, gitdiff.go:1704-1706), but our
  //     engine diff seam (readDiff, SPEC-0001b §3) computes plain hunks only
  //     — no whitespace modes exist to honor. The old declare-and-ignore was
  //     a silent lie; the reduction is now honest (an engine-side gap, not a
  //     route-side one).
  //
  // X-Total-Count is the TRUE total — the handler holds the whole file list,
  // so the count is `files.length` (upstream SetTotalCountHeader over
  // totalNumberOfFiles, pull.go:1573); the old `(page-1)*limit+len`
  // soFar inflated the header on page > 1. When the engine's diff window is
  // budget-truncated (MAX_DIFF_FILES — SPEC-0001b §3) the count is that
  // window, the same caveat the ChangedFileList itself carries.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/pulls/{index}/files",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get changed files for a pull request",
      operationId: "repoGetPullRequestFiles",
      request: {
        params: z.object(pullIndexParams),
        query: z.object({
          "skip-to": z.string().optional().openapi({ description: "skip to given file" }),
          page: pageLimitQuery.page,
          limit: pageLimitQuery.limit,
        }),
      },
      responses: {
        200: { description: "ChangedFileList", content: { "application/json": { schema: changedFileListSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { found } = await requireVisibleRepo(c, c.req.valid("param"));
      const { pullRequest } = await requirePullRequest(c, found, c.req.valid("param").index);
      const checked = await ensurePullRequestChecked(c, found, pullRequest);
      const listOptions = parseListOptions(new URL(c.req.url));
      const range = await pullRequestDiff(c, found, checked);
      const files = toChangedFiles(
        range.files,
        found,
        viewerOf(c).origin,
        range.head,
      );
      const skipTo = c.req.valid("query")["skip-to"] ?? "";
      const from = skipTo === "" ? 0 : files.findIndex((f) => f.filename === skipTo);
      const skipped = files.slice(from === -1 ? files.length : from);
      setCommitListHeaders(c, listOptions, files.length, files.length > listOptions.page * listOptions.limit);
      const start = (listOptions.page - 1) * listOptions.limit;
      return c.json(skipped.slice(start, start + listOptions.limit), 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/pulls/{index}/merge (repoPullRequestIsMerged)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/pulls/{index}/merge",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Check if a pull request has been merged",
      operationId: "repoPullRequestIsMerged",
      request: { params: z.object(pullIndexParams) },
      responses: {
        204: { description: "empty" },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { found } = await requireVisibleRepo(c, c.req.valid("param"));
      const { pullRequest } = await requirePullRequest(c, found, c.req.valid("param").index);
      if (!pullRequest.hasMerged) {
        throw new ApiError(404, "not found");
      }
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/pulls/{index}/merge (repoMergePullRequest)
  // — 200 empty on success, 201 empty when the call scheduled the auto
  // merge (merge_when_checks_succeed, pull.go:994-1007) with the 409 the
  // already-scheduled conflict; the 405 family is the not-mergeable
  // semantics (SPEC-0004 §2.5), 409 also the lost base-ref CAS.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/pulls/{index}/merge",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Merge a pull request",
      operationId: "repoMergePullRequest",
      request: {
        params: z.object(pullIndexParams),
        body: { content: { "application/json": { schema: mergePullRequestOptionSchema } } },
      },
      responses: {
        200: { description: "empty" },
        201: { description: "empty" },
        403: forbiddenResponse,
        404: notFoundResponse,
        405: { description: "empty" },
        409: errorResponse,
        // The deps-blocked merge (ErrDependenciesLeft's ErrUnprocessableContent
        // wrap → apiErrorAuto, check.go:46 + services/context/api.go:120-123 —
        // the b1c5fedd17-window 422 fix).
        422: errorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const { found } = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      if (!(await canWriteRepository(c, found))) {
        throw new ApiError(403, "User not allowed to merge PR");
      }
      const { issue, pullRequest } = await requirePullRequest(c, found, c.req.valid("param").index);
      const form = c.req.valid("json");
      const requester = c.get("authUser");
      if (requester === undefined) {
        throw new ApiError(401, "token is required"); // unreachable behind requireAuth
      }

      // SPEC-0013 §3.3 — the protection gate. IsUserAllowedToMerge
      // (services/pull/merge.go:671–691) runs FIRST (before the 405 family,
      // like upstream): no rule → the write check above already passed; a
      // rule → the merge whitelist. Failure stays the existing 403 text.
      const rule = await findRule(c.env.DB, found.repo.id, pullRequest.baseBranch);
      if (rule !== null) {
        const access = await principalAccessOf(c.env.DB, found.repo, requester);
        if (!(await isUserMergeWhitelisted(c.env.DB, parseRuleConfig(rule.rules), access))) {
          throw new ApiError(403, "User not allowed to merge PR");
        }
      }

      // CheckPullMergeable (405 family): merged, the manual-mark style gate,
      // WIP, not-mergeable — the same order the Auto check type (the schedule
      // arm below) runs at the pin, only the branch-protection failure
      // skipped (check.go:181-184); the full General re-check runs at consume
      // time (automerge.go:227).
      if (pullRequest.hasMerged) {
        throw new ApiError(405, "The PR is already merged");
      }
      // The manual mark, hoisted once: the Do value is its own check TYPE
      // (pull.go:884-892 — Manually overrides the MWCS Auto choice), so the
      // arms below skip or serve it by this flag, never by re-comparing the
      // narrowed union.
      const manualMark = form.do === "manually-merged";
      // The manual mark's style gate — MergedManually's FIRST gate
      // (merge.go:759-761): IsMergeStyleAllowed(ManuallyMerged) = the PR
      // unit's AllowManualMerge, the zero value FALSE upstream's
      // DefaultPullRequestsConfig never sets (repo_unit.go:139-155). The API
      // answers the refusal through APIErrorAuto (pull.go:918-922):
      // ErrInvalidMergeStyle unwraps to ErrInvalidArgument (merge.go:231-233)
      // → 400 with the error's own text; our repo id is the stored string,
      // rendered verbatim in the same bracket shape.
      if (manualMark) {
        const settings = await loadRepoSettings(c.env.DB, found.repo.id);
        if (!settings.prUnit.AllowManualMerge) {
          throw new ApiError(400, `merge strategy is not allowed or is invalid [repo_id: ${found.repo.id}, strategy: manually-merged]`);
        }
        // MergedManually's commit resolution (merge.go:761-771): GetCommit on
        // a missing/empty ref → NewInvalidArgumentErrorf("commit not found in
        // base repository") — the same errorForUser 400. The in-branch
        // verification rides the engine's manual arm (api/services/
        // pull-engine.ts), which the request now reaches with the style
        // allowed.
        if (form.merge_commit_id === undefined || form.merge_commit_id === "") {
          throw new ApiError(400, "commit not found in base repository");
        }
      }
      // The Manually check type early-returns BEFORE the WIP arm
      // (check.go:160-163 — merged/closed/permission only), so a WIP title
      // never blocks the mark.
      if (!manualMark && hasWorkInProgressPrefix(issue.title)) {
        throw new ApiError(405, "Work in progress PRs cannot be merged");
      }

      // The mergeable precondition runs the LAZY check on a `checking` row
      // (same self-healing pass as the GET): not-mergeable after the check →
      // the upstream 405 "Please try again later". The Manually type skips it
      // entirely (the mark needs no mergeable state — it exists to close out
      // conflicted work), so its arms run on the raw row.
      const checked = manualMark ? pullRequest : await ensurePullRequestChecked(c, found, pullRequest);
      if (!manualMark && checked.hasMerged) {
        throw new ApiError(405, "The PR is already merged");
      }
      // An ANCESTOR PR (head already contained in base) is upstream the
      // PullRequestStatusAncestor STATUS (issues/pull.go:117), not HasMerged:
      // IsStatusMergeable is false for it (issues/pull.go:456-459 — the
      // Mergeable||Empty pair), so CheckPullMergeable raises
      // ErrNotMergeableState at the `!IsStatusMergeable() && (type != Auto ||
      // !IsFilesConflicted() && !IsChecking())` arm (check.go:169) and
      // the API route answers it 405 "Please try again later" (api
      // pull.go:904-905). The arm sits BEFORE the deps gate (check.go:169 <
      // :214-216), so the ancestor answer wins over the deps text; the MWCS
      // schedule arm below carries the same condition for its own gate.
      if (!manualMark && checked.status === PRStatus.Ancestor) {
        throw new ApiError(405, "Please try again later");
      }

      // The STATE arm precedes the deps gate below — upstream's
      // CheckPullMergeable order (check.go:169 < :214-216): a non-mergeable
      // PR answers ErrNotMergeableState's 405 "Please try again later"
      // (pull.go:904-905) even with open dependencies, NOT the deps text.
      // The arm is Check-TYPE aware since b1c5fedd17: the Auto type (MWCS)
      // WAITS OUT conflicted and checking rows — `!IsStatusMergeable() &&
      // (type != Auto || !IsFilesConflicted() && !IsChecking())`, with
      // IsFilesConflicted = status == Conflict (models/issues/pull.go:
      // 692-695) — so a conflicted MWCS request reaches the schedule arm
      // below. Empty keeps its carve-out — since this window it lives
      // INSIDE IsStatusMergeable (models/issues/pull.go:456-459:
      // Mergeable||Empty): it passes here and either schedules through the
      // MWCS arm below (its inner gate admits it) or falls to the direct
      // path's trailing gate, which rejects it.
      const autoType = form.merge_when_checks_succeed === true;
      if (
        !manualMark &&
        checked.status !== PRStatus.Mergeable &&
        checked.status !== PRStatus.Empty &&
        !(autoType && (checked.status === PRStatus.Conflict || checked.status === PRStatus.Checking))
      ) {
        throw new ApiError(405, "Please try again later");
      }

      // The open-dependency gate — CheckPullMergeable's FINAL arm
      // (check.go:214-216), never bypassed by force_merge (the deps check
      // sits outside the protection-failure escape) and NEVER skipped for the
      // Auto type (only the branch-protection failure is, check.go:180-185) —
      // so it runs AFTER the state arm above (check.go:169 < :214-216 —
      // a conflicted PR's merge attempt answers the state 405, not this
      // text) and BEFORE the schedule arm below, exactly like the upstream
      // handlers' single CheckPullMergeable call that precedes
      // ScheduleAutoMerge (api pull.go:895/961; web pull.go:1040/1100). The
      // manually-merged mark never reaches it (check.go:160-163 — the
      // route's manual arm above already gated the style). The engine
      // re-runs the same gate at its core (api/services/pull-engine.ts), so
      // the direct merge path answers it twice-identically. The b1c5fedd17
      // window RETIRED this port's old divergence: ErrDependenciesLeft is
      // now `util.ErrorWrap(util.ErrUnprocessableContent, ...)` (check.go:
      // 46) and the API ladder's fallthrough renders user-mapped errors
      // (APIErrorInternal → apiErrorAuto → ErrorUnwrapForUser,
      // services/context/api.go:120-123) — so a deps-blocked merge answers
      // 422 "is blocked by an open dependency" upstream, and this gate
      // carries that exact status + message instead of the pre-window 405
      // with the web flash string.
      if (!manualMark && !(await issueNoDependenciesLeft(c.env.DB, issue.id))) {
        throw new ApiError(422, "is blocked by an open dependency");
      }

      // THE SCHEDULE ARM (api pull.go:955-968): merge_when_checks_succeed
      // schedules the auto merge — success → the bare 201 Created
      // (ctx.Status, EMPTY body), a standing row → the 409 carrying
      // ErrAlreadyScheduledToAutoMerge's text (models/pull/automerge.go:43-
      // 45, through APIErrorAuto's ErrAlreadyExist mapping — same 409 the
      // pre-window explicit arm answered). NO delete-first on EITHER handler
      // since b1c5fedd17 (the web reset is gone too). The Auto-type state
      // gate is CheckPullMergeable's conflict-waiting arm (check.go:169):
      // `!IsStatusMergeable() && (type != Auto || !IsFilesConflicted() &&
      // !IsChecking())` — an Empty PR schedules too, and CONFLICTED/CHECKING
      // rows schedule as well (auto merge waits them out). The type-34
      // comment (CreateAutoMergeComment's scheduled half — now carrying the
      // style string, automerge.go:76) and the first check enqueue
      // (StartPullRequestCheckOnView, automerge.go:81) complete the
      // upstream service's transaction tail. The manual mark never reaches
      // it: upstream returns at the mark (pull.go:917-921) before the
      // schedule branch, so Manually overrides MWCS when both flags ride one
      // body.
      if (!manualMark && form.merge_when_checks_succeed === true) {
        // The state arm above already admitted Conflict/Checking for the
        // Auto type; this inner restatement is the same predicate narrowed
        // to the arm (Error/Ancestor/Unrelated were refused there).
        if (checked.status !== PRStatus.Mergeable && checked.status !== PRStatus.Empty && checked.status !== PRStatus.Conflict && checked.status !== PRStatus.Checking) {
          throw new ApiError(405, "Please try again later");
        }
        const message = await composeMergeMessage(c, found, issue, checked, {
          style: form.do,
          mergeTitleField: form.merge_title_field ?? "",
          mergeMessageField: form.merge_message_field,
        });
        const now = new Date();
        const scheduled = await insertScheduledAutoMergeRow(c.env.DB, {
          issueId: issue.id,
          doerId: requester.id ?? 0,
          sha: checked.headSha ?? "",
          style: form.do,
          message,
          deleteBranchAfterMerge: form.delete_branch_after_merge === true,
        }, now);
        if (scheduled === null) {
          throw new ApiError(409, `pull request is already scheduled to auto merge when checks succeed [pull_id: ${String(issue.id)}]`);
        }
        // The type-34 comment's content is the STYLE string (b1c5fedd17 —
        // automerge.go:76 passes string(style) into CreateAutoMergeComment).
        await createScheduledAutoMergeComment(c.env.DB, issue.id, requester.id ?? 0, now, form.do);
        if (c.env.REPO_TASKS !== undefined) {
          try {
            await c.env.REPO_TASKS.send({ kind: "auto-merge-check", issueId: issue.id });
          } catch (error) {
            console.error(`[pulls] auto-merge check enqueue failed (issue ${issue.id}): ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return c.body(null, 201);
      }

      if (!manualMark && checked.status !== PRStatus.Mergeable) {
        throw new ApiError(405, "Please try again later");
      }

      // SPEC-0013 §3.3 — CheckPullBranchProtections (merge.go:694–742) after
      // the mergeable precondition, with the commits-behind count the check
      // surfaced. "Manually merged" skips the checks entirely
      // (check.go:160-163). A failure answers 405 with the upstream message
      // text VERBATIM; `force_merge` clears it only through
      // CanBypassBranchProtection (check.go:185-203).
      if (rule !== null && !manualMark) {
        const ruleConfig = parseRuleConfig(rule.rules);
        // The B-53 arms' merge-time git view (census B-53) — threaded only
        // when an arm is armed, upstream's own laziness (both arms return
        // before any walk when disarmed, services/issue/pull.go:149-151).
        const git =
          ruleConfig.blockOnCodeownerReviews || ruleConfig.protectedFilePatterns.trim() !== ""
            ? await pullGateGitInputs(c.env, found, pullRequest, c.env.DB)
            : undefined;
        const failure = await checkPullBranchProtections(c.env.DB, rule, {
          issueId: issue.id,
          commitsBehind: checked.commitsBehind ?? 0,
          headSha: checked.headSha,
          git,
          posterId: issue.posterId ?? 0,
        });
        if (failure !== null) {
          const bypass =
            form.force_merge === true &&
            (await canBypassBranchProtection(
              c.env.DB,
              ruleConfig,
              await principalAccessOf(c.env.DB, found.repo, requester),
            ));
          if (!bypass) {
            throw new ApiError(405, failure);
          }
        }
      }

      // The composed commit message (findings F2): a trimmed
      // merge_title_field wins, else the style's default; a non-empty
      // merge_message_field appends (pull.go:928-953, merge.go:112-148 —
      // composeMergeMessage). manually-merged skips it: upstream returns at
      // pull.go:918-925 before composing and the mark touches no commit.
      const message = manualMark
        ? ""
        : await composeMergeMessage(c, found, issue, checked, {
            style: form.do,
            mergeTitleField: form.merge_title_field ?? "",
            mergeMessageField: form.merge_message_field,
          });
      const { commitOid } = await mergePullRequestEngine(c, found, issue, checked, {
        style: form.do,
        message,
        deleteBranchAfterMerge: form.delete_branch_after_merge === true,
        mergeCommitId: form.merge_commit_id,
        doerId: requester.id ?? 0,
        now: new Date(),
      });

      // Webhook: pull_request closed with merged=true (the merged trio set) —
      // upstream's MergePullRequest notifier renders ToPayloadPullRequest
      // (webhook/notifier.go:689-721, payload @715 with HookIssueClosed @718;
      // services/pull Merge fires it and the route answers a bare StatusOK, so
      // this payload is the path's ONLY PR render): payload mode.
      // Flavor note (unit TAILS2, 2026-11-04): auto-merge landings dispatch
      // notify.AutoMergePullRequest upstream (merge.go:403-406), but the
      // webhook receiver is a pure redirect into MergePullRequest
      // (webhook/notifier.go:684-687) — payload/secret flavor IDENTICAL for
      // auto-merges, so this emit reads no wasAutoMerged stamp; the split
      // (ActionAutoMergePullRequest) lives only in the mail/feed notifiers,
      // recorded not ported (mail arm staged: services/mail/notify.ts's
      // merge-arm doc).
      const merged = await findPullRequestByIndex(c.env.DB, found.repo.id, checked.index);
      if (merged !== null) {
        // The merge notifier's ToPayloadPullRequest carries the diff-stat trio
        // like every payload conversion (convert/pull.go:245-269 is not gated
        // on isPayload); the omit arms (:247-250) stay omitted — the checked
        // row's persisted merge base serves the pre-merge contribution.
        const diffStats = await pullRequestDiffShortStat(c, found, merged.pullRequest);
        const rendered = await toApiPullRequest(
          c.env.DB,
          viewerOf(c),
          found,
          merged.issue,
          merged.pullRequest,
          "payload",
          diffStats === null ? undefined : { diffStats },
        );
        await emitPullWebhook(c, {
          repoId: found.repo.id,
          ownerId: found.repo.ownerId,
          eventType: "pull_request",
          payload: pullRequestPayload("closed", rendered, merged.issue.index, toApiRepository(viewerOf(c), found), requester, {
            commitId: commitOid ?? "",
          }),
        });
      }
      return c.body(null, 200);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/merge-upstream (repoMergeUpstream) — the fork
  // sync (api.go:1314 reqToken + mustNotBeArchived + reqRepoWriter(TypeCode)
  // → repo/branch.go:1301-1354 → services/repository/merge_upstream.go).
  // The stale "forks cannot exist yet" 404-everywhere stub is superseded —
  // forks landed (census R20, services/forks.ts) and the service rides the
  // fork machinery (services/pull-engine.ts mergeUpstream: the write gate,
  // the fork/base/read gates, the divergence walk in the fork cell, and the
  // fast-forward / reverse-PR-merge arms).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/merge-upstream",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Sync a fork's branch with the upstream repository",
      operationId: "repoMergeUpstream",
      request: {
        params: z.object(ownerRepoParams),
        body: { content: { "application/json": { schema: mergeUpstreamRequestSchema } } },
      },
      responses: {
        200: { description: "MergeUpstreamResponse", content: { "application/json": { schema: mergeUpstreamResponseSchema } } },
        400: errorResponse,
        404: notFoundResponse,
        409: errorResponse,
      },
    }),
    async (c) => {
      // NOT requireVisibleRepo: upstream mounts merge-upstream OUTSIDE the
      // pulls group (api.go:1314 — reqToken + mustNotBeArchived +
      // reqRepoWriter, no mustAllowPulls), so an ARCHIVED repo answers the
      // pinned 423 here, not the pulls-subtree 404 (requireVisibleRepo's
      // assertPullsUnit hides archived on the /pulls subtree — the group
      // gate this route does not ride). The visibility 404 keeps the
      // anti-enumeration posture.
      const viewer = viewerOf(c);
      const found = await findRepositoryByPath(c.env.DB, c.req.valid("param").owner, c.req.valid("param").repo);
      if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
        throw new ApiError(404, "not found");
      }
      // mustNotBeArchived (api.go:816-821) — 423 "repo is archived", the
      // middleware family ahead of the write gate (upstream order).
      assertNotArchived(found);
      const form = c.req.valid("json");
      const result = await mergeUpstreamEngine(c, found, { branch: form.branch, ffOnly: form.ff_only === true });
      return c.json({ merge_type: result.mergeStyle }, 200);
    },
    bindValidationHook,
  );
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/pulls/{base}/{head} (repoGetPullRequestByBaseHead)
  // — the pure D1 lookup on the base/head columns; the fork form
  // `owner:branch` resolves the head repo through resolveHeadRepo (404 when
  // the head repo row is absent). The render is the SAME single converter as
  // the index GET (pull.go:300 vs :211), so the diff-stat trio rides it too
  // (pullRequestDiffShortStat; the omit arms mirror :247-250).
  // -------------------------------------------------------------------------
  app.openapi(getPullByBaseHeadRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const { base, head } = c.req.valid("param");
    const resolved = await resolveHeadRepo(c.env.DB, found, head);
    const row = await findPullRequestByBaseHeadInfo(c.env.DB, found.repo.id, resolved.headRepoId, base, resolved.headBranch);
    if (row === null) {
      throw new ApiError(404, "not found"); // upstream APIErrorNotFound
    }
    const diffStats = await pullRequestDiffShortStat(c, found, row.pullRequest);
    return c.json(
      await toApiPullRequest(c.env.DB, viewer, found, row.issue, row.pullRequest, "single", diffStats === null ? undefined : { diffStats }),
      200,
    );
  });
}

/** The PR-commits walk window (upstream lists the full range; the handler
 *  pages the reversed window — the compare route's bound family). */
const PULL_COMMITS_BOUND = 250;

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
 * schedule with the declared 409. POST /merge-upstream answers 404: forks
 * cannot exist yet (SPEC-0003 primitives pending).
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

import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context, MiddlewareHandler } from "hono";
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import { comments, issues, issueAssignees, milestones, PRStatus, pullRequests, users } from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import { IssueError, MilestoneNotExistError } from "../../issues/errors";
import { IssuesService, type IssueRow, type PullRequestRow } from "../../issues/service";
import { emitWebhookDeliveries, type HookEventType } from "../../issues/webhooks";
import type { WebhookDeliveryMessage } from "../../webhooks/consumer";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  createPullRequestOptionSchema,
  editPullRequestOptionSchema,
  mergePullRequestOptionSchema,
  mergeUpstreamRequestSchema,
  pullRequestListSchema,
  pullRequestSchema,
  type PullRequest,
} from "../models/pull";
import { changedFileListSchema, commitListSchema } from "../models/git";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { ActionType, recordAction, type ActionDraft } from "../services/activity-feeds";
import { BLOCKED_USER_MESSAGE, isUserBlockedBy } from "../services/blocks";
import { changeIssueBody, changeIssueDeadline, changeIssueMilestone, changeIssueTitle, hasWorkInProgressPrefix, issueErrorToApiError } from "../services/issues";
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
  resolveHeadRepo,
  toApiPullRequest,
} from "../services/pulls";
import {
  createPullHeadRef,
  carryForkHeadIntoBase,
  crossRepoCreateMergeBase,
  ensurePullRequestChecked,
  mergePullRequest as mergePullRequestEngine,
  mergeableOfRow,
  mergeUpstream as mergeUpstreamEngine,
  pullRequestDiff,
} from "../services/pull-engine";
import { branchRef, engineReads, isFullObjectId, refTipMap, tagRef } from "../services/engine";
import { findCollaborator } from "../services/repo-collaborators";
import { renderUnifiedDiff, renderPatch, toApiCommit, toChangedFiles, usernamesByEmail } from "../services/git-models";
import {
  canViewRepositoryWithTeams,
  findRepositoryById,
  findRepositoryByPath,
  findUserByName,
  repositoryPermissions,
  toApiRepository,
  viewerOf,
  type RepositoryWithOwner,
  type UserRow,
} from "../services/repository";
import { toApiUser } from "../services/user";
import { canWriteRepository } from "../services/repo-access";
import { canBypassBranchProtection, checkPullBranchProtections, findRule, isUserMergeWhitelisted, parseRuleConfig, principalAccessOf } from "../../services/branch-protection";
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
 *     contract). The other 400/409/412/422 codes on PATCH are DECLARED.
 *
 * Engine boundary (documented, this wave): POST accepts the create per
 * upstream shape WITHOUT the base/head branch-existence check (an engine
 * read) and GET renders `mergeable: null` (unknown), `base.sha: ""` and
 * `head.sha` from the pull_requests cache — validated/converted at the
 * mergeability wave (SPEC-0005 §3.4). The PATCH `base` retarget is likewise
 * engine-gated upstream and is ignored this wave. The PATCH assignee fields
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
 * live (emitPullAssignWebhook, one event per changed assignee).
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
 * two responses declaring it — SPEC-0004 §2.5). X-Total-Count carries the
 * commits/files SO FAR (the engine's range walk reports no total; the
 * approximation is documented in the routes).
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

/** Shared repo resolution — the anti-enumeration 404 (SPEC-0004 §2.4). */
async function requireVisibleRepo(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
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
// assignee.go:175-247; made live by the blocks-enforcement sweep so
// EditPullRequest's blocked arm at pull.go:687 is reachable). The write
// halves mirror the landed issue-tables-t2 machinery (the type-9 assignee
// comment per toggle, the guarded insert); the label/-milestone WEBHOOK
// sub-events stay the tier-2 surfaces'. Assignee changes emit
// pull_request_assign webhooks only — NO `action` row exists upstream
// (no assign ActionType; feed/notifier.go has no assignee method).
// ---------------------------------------------------------------------------

/** `GetDoerUserIDsByNames` reduced to the PATCH arm (user.go:1237): resolve
 *  case-insensitively; the FIRST miss aborts with pull.go:688's exact 422 —
 *  `fmt.Sprintf("Assignee does not exist: [name: %s]", err)` renders the
 *  ErrUserNotExist text INSIDE the wrapper. */
async function resolveAssigneeNames(d1: D1Database, names: string[]): Promise<UserRow[]> {
  const resolved: UserRow[] = [];
  const seen = new Set<number>();
  for (const name of new Set(names)) {
    const user = await findUserByName(d1, name);
    if (user === null) {
      throw new ApiError(422, `Assignee does not exist: [name: user does not exist [uid: 0, name: ${name}]]`);
    }
    if (!seen.has(user.id)) {
      seen.add(user.id);
      resolved.push(user);
    }
  }
  return resolved;
}

/** validateAssignee (services/issue/assignee.go:168-183): the blocked arm
 *  FIRST (the blocks-enforcement wiring), then CanBeAssigned collapsed onto
 *  the landed ACL (the issue-tables-t2 port: a public repo grants every real
 *  user; otherwise owner / site admin / collaborator). The org row and the
 *  access miss answer the landed family's 400/403 — upstream's PATCH route
 *  maps neither (they fall into APIErrorInternal, pull.go:691-692); the
 *  landed issue-tables-t2 arm's statuses stand here too (documented
 *  divergence). */
async function validatePullAssignee(
  d1: D1Database,
  found: RepositoryWithOwner,
  doer: { id: number; isAdmin: boolean },
  user: UserRow,
): Promise<void> {
  if (user.type === "org") {
    throw new ApiError(400, `organization can't be added as assignee [user_id: ${user.id}, repo_id: ${found.repo.id}]`);
  }
  if (await isUserBlockedBy(d1, { id: doer.id, isAdmin: doer.isAdmin }, user.id)) {
    throw new ApiError(403, BLOCKED_USER_MESSAGE);
  }
  const assignable =
    found.repo.visibility === "public" ||
    user.isAdmin ||
    (found.repo.ownerId !== null && found.repo.ownerId === user.id) ||
    (await findCollaborator(d1, found.repo.id, user.id)) !== null;
  if (!assignable) {
    throw new ApiError(403, `user doesn't have access to repo [user_id: ${user.id}, repo_name: ${found.repo.slug}]`);
  }
}

/** The type-9 (assignees) comment + the num_comments fold — the
 *  issue-tables-t2 writeAssigneeComment port (toggleIssueAssignee,
 *  models/issues/assignees.go:115-140). */
async function writePullAssigneeComment(
  d1: D1Database,
  issue: IssueRow,
  assigneeId: number,
  removed: boolean,
  actorId: number,
  now: Date,
): Promise<void> {
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

/** UpdateAssignees (services/issue/assignee.go:175-247) over the landed
 *  tables: resolve + validate EVERY unique name first (the blocked/access
 *  arms fire before any write, upstream's pre-tx validateAssignee loop),
 *  then the removals (toBeRemovedAssignees — the current set minus the
 *  requested one, each with its removal comment), then the adds
 *  (AddAssigneeIfNotAssigned — the already-assigned skip, the guarded
 *  insert, the add comment). Emits ONE pull_request_assign webhook per
 *  actually-changed assignee after the writes (upstream's post-tx notify
 *  loops, assignee.go:236-247/274-286 → webhook/notifier.go
 *  IssueChangeAssignee:161-202; changes.added_assignees/removed_assignees,
 *  hook.go:486-489). */
async function replacePullAssignees(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  issue: IssueRow,
  names: string[],
): Promise<void> {
  const doer = c.get("authUser");
  const actorId = doer?.id ?? 0;
  const doerSlice = { id: actorId, isAdmin: doer?.is_admin === true };
  const now = new Date();
  const requested = await resolveAssigneeNames(c.env.DB, names);
  for (const user of requested) {
    await validatePullAssignee(c.env.DB, found, doerSlice, user);
  }

  const current = await drizzle(c.env.DB)
    .select({ user: users })
    .from(issueAssignees)
    .innerJoin(users, eq(users.id, issueAssignees.assigneeId))
    .where(eq(issueAssignees.issueId, issue.id))
    .orderBy(asc(issueAssignees.id))
    .all()
    .then((rows) => rows.map((row) => row.user));
  const requestedIds = new Set(requested.map((user) => user.id));

  const added: UserRow[] = [];
  const removed: UserRow[] = [];
  // Removals first (upstream's tx order), then adds with the skip.
  for (const user of current) {
    if (requestedIds.has(user.id)) continue;
    const deleted = await drizzle(c.env.DB)
      .delete(issueAssignees)
      .where(and(eq(issueAssignees.issueId, issue.id), eq(issueAssignees.assigneeId, user.id)))
      .returning({ id: issueAssignees.id });
    if (deleted.length === 0) continue;
    removed.push(user);
    await writePullAssigneeComment(c.env.DB, issue, user.id, true, actorId, now);
  }
  for (const user of requested) {
    const existing = await drizzle(c.env.DB)
      .select({ id: issueAssignees.id })
      .from(issueAssignees)
      .where(and(eq(issueAssignees.issueId, issue.id), eq(issueAssignees.assigneeId, user.id)))
      .limit(1)
      .then((rows) => rows[0]);
    if (existing !== undefined) continue; // AddAssigneeIfNotAssigned: already assigned, nothing to do
    const inserted = await drizzle(c.env.DB)
      .insert(issueAssignees)
      .values({ issueId: issue.id, assigneeId: user.id })
      .onConflictDoNothing()
      .returning({ id: issueAssignees.id });
    if (inserted.length === 0) continue; // a concurrent add won the unique index
    added.push(user);
    await writePullAssigneeComment(c.env.DB, issue, user.id, false, actorId, now);
  }

  // The per-changed-assignee pull_request_assign webhook: `changes` carries
  // the one-element added/removed side (only the changed side is set, the
  // lists are omitempty); the pull_request object renders the POST-change
  // set (upstream's ToAPIPullRequest LoadAssignees), re-read from the
  // issue row (the render path refetches through findPullRequestByIndex at
  // the handler tail; here the converter reads the live rows).
  for (const user of removed) {
    await emitPullAssignWebhook(c, found, issue, "unassigned", { removed_assignees: [toApiUser(viewerOf(c), user)] });
  }
  for (const user of added) {
    await emitPullAssignWebhook(c, found, issue, "assigned", { added_assignees: [toApiUser(viewerOf(c), user)] });
  }
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
  // payload mode, not the API-response "single" render.
  const rendered = await toApiPullRequest(c.env.DB, viewerOf(c), found, pair.issue, pair.pullRequest, "payload");
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
    // mergers, fork head-repo pairs + one grant per distinct head) batches
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
      const service = new IssuesService(c.env.DB);
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

      let issue: IssueRow;
      let pr: PullRequestRow;
      // NewPullRequest's blocked arm (services/pull/pull.go:64-65 via
      // repoCreatePullRequest's `errors.Is(err, user_model.ErrBlockedUser)`
      // → 403 `err.Error()`, pull.go:547): the POSTER blocked by the repo
      // owner refuses before any row is written. Upstream's second probe
      // half — the poster blocked by any REQUESTED ASSIGNEE — rides the
      // create-request assignee resolution (pull.go:526), which the landed
      // create drops (the issues.ts create-request deviation); it becomes
      // reachable when that support lands. The isUserBlockedBy site-admin
      // short-circuit is upstream's `blockee.IsAdmin`.
      if (await isUserBlockedBy(c.env.DB, { id: requester.id ?? 0, isAdmin: requester.is_admin === true }, found.repo.ownerId ?? -1)) {
        throw new ApiError(403, BLOCKED_USER_MESSAGE);
      }

      // The cross-repo create compare (GetCompareInfo, upstream pull.go:520
      // stores the result as pr.MergeBase): the merge base computes IN THE
      // HEAD CELL — the fork holds the base's full history (SPEC-0001b §5.2;
      // services/git/compare.go:73-89 runs the same computation in the head
      // repo after fetching the base commit into it) — and the head closure
      // is carried into the BASE cell so refs/pull/N/head's landing, the lazy
      // mergeability check, the diff range and the merge execution all resolve
      // there (commitApiChange refuses an oid the cell lacks). Runs only for
      // cross-repo heads and after every validation: the carries are engine
      // writes, so a 403/409/404 request moves no bytes.
      let mergeBaseOid: string | null = null;
      if (headPair.repo.id !== found.repo.id) {
        mergeBaseOid = await crossRepoCreateMergeBase(c, found, headPair, baseBranch, baseTip.oid, headTip.oid);
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

      // Upstream converts TWICE at the create route: the 201 body serializes
      // convert.ToAPIPullRequest (pull.go:558) while pull_service.NewPullRequest
      // (pull.go:544) already fired webhookNotifier.NewPullRequest, whose opened
      // payload is a SEPARATE conversion — ToPayloadPullRequest (notifier.go:368).
      // The split mirrors that: the API response keeps the doer-gated "single"
      // render, the opened payload gets its own "payload" render (head.repo
      // reaches the receivers regardless of the doer, convert/pull.go:33-37).
      const rendered = await toApiPullRequest(c.env.DB, viewer, found, issue, pr, "single");
      const payloadRendered = await toApiPullRequest(c.env.DB, viewer, found, issue, pr, "payload");
      // Webhook: pull_request opened.
      await emitPullWebhook(c, {
        repoId: found.repo.id,
        ownerId: found.repo.ownerId,
        eventType: "pull_request",
        payload: pullRequestPayload("opened", payloadRendered, issue.index, toApiRepository(viewerOf(c), found), c.get("authUser")),
      });
      return c.json(rendered, 201);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/pulls/{index} (repoGetPullRequest) — runs the
  // LAZY mergeability check (SPEC-0005 §3.4: a `checking` row fires the
  // read-only engine check and CAS-writes the row) and renders the real
  // mergeable/base.sha pair. The REVIEW-CONSULT (the pull-reviews wave):
  // `requested_reviewers` renders from the review-REQUEST rows
  // (services/convert/pull.go:124 LoadRequestedReviewers) instead of the
  // converter's `[]` default — the PR-detail read arm only, like the
  // mergeability extras.
  // -------------------------------------------------------------------------
  app.openapi(getPullRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const { issue, pullRequest } = await requirePullRequest(c, found, c.req.valid("param").index);
    const checked = await ensurePullRequestChecked(c, found, pullRequest);
    const baseSha = (await engineReads(c.env, found.repo).readCommit(branchRef(checked.baseBranch)))?.oid;
    const rendered = await toApiPullRequest(c.env.DB, viewer, found, issue, checked, "single", {
      mergeable: mergeableOfRow(checked),
      ...(baseSha === undefined ? {} : { baseSha }),
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
      const form = c.req.valid("json");
      const service = new IssuesService(c.env.DB);
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
        const updated = await changeIssueTitle(c.env.DB, issue, title, actorId, now);
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
            await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "payload"),
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
        const updated = await changeIssueBody(c.env.DB, issue, body, requestedVersion ?? issue.contentVersion, now);
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
            await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "payload"),
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

      // form.base: the retarget is engine-gated upstream (branch existence +
      // ChangeTargetBranch); deferred with the engine wave (file header).

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
              await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "payload"),
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
              await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "payload"),
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
      return c.json(await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "single"), 201);
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
          skip_to: z.string().optional().openapi({ description: "skip to given file" }),
          whitespace: z.string().optional().openapi({ type: "string", enum: ["ignore-all", "ignore-change", "ignore-eol", "show-all"], description: "whitespace behaviour" }),
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
      const soFar = (listOptions.page - 1) * listOptions.limit + files.length;
      setCommitListHeaders(c, listOptions, soFar, files.length > listOptions.page * listOptions.limit);
      const start = (listOptions.page - 1) * listOptions.limit;
      return c.json(files.slice(start, start + listOptions.limit), 200);
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
  // — 200 empty on success; the 405 family is the not-mergeable semantics
  // (SPEC-0004 §2.5), 409 the lost base-ref CAS.
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
        403: forbiddenResponse,
        404: notFoundResponse,
        405: { description: "empty" },
        409: errorResponse,
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

      // CheckPullMergeable (405 family): merged, WIP, not-mergeable. The
      // auto-merge schedule gate runs first (upstream checks
      // MergeWhenChecksSucceed before the mergeable state).
      if (pullRequest.hasMerged) {
        throw new ApiError(405, "The PR is already merged");
      }
      if (form.merge_when_checks_succeed === true) {
        // the auto-merge schedule is not modeled (no scheduled-merge table)
        throw new ApiError(409, "scheduled auto-merge is not supported");
      }
      if (hasWorkInProgressPrefix(issue.title)) {
        throw new ApiError(405, "Work in progress PRs cannot be merged");
      }

      // The mergeable precondition runs the LAZY check on a `checking` row
      // (same self-healing pass as the GET): not-mergeable after the check →
      // the upstream 405 "Please try again later".
      const checked = await ensurePullRequestChecked(c, found, pullRequest);
      if (checked.hasMerged || checked.status === PRStatus.Ancestor) {
        throw new ApiError(405, "The PR is already merged");
      }
      if (checked.status !== PRStatus.Mergeable) {
        throw new ApiError(405, "Please try again later");
      }

      // SPEC-0013 §3.3 — CheckPullBranchProtections (merge.go:694–742) after
      // the mergeable precondition, with the commits-behind count the check
      // surfaced. "Manually merged" skips the checks entirely
      // (check.go:162–165). A failure answers 405 with the upstream message
      // text VERBATIM; `force_merge` clears it only through
      // CanBypassBranchProtection (check.go:192–207).
      if (rule !== null && form.do !== "manually-merged") {
        const failure = await checkPullBranchProtections(c.env.DB, rule, {
          issueId: issue.id,
          commitsBehind: checked.commitsBehind ?? 0,
        });
        if (failure !== null) {
          const bypass =
            form.force_merge === true &&
            (await canBypassBranchProtection(
              c.env.DB,
              parseRuleConfig(rule.rules),
              await principalAccessOf(c.env.DB, found.repo, requester),
            ));
          if (!bypass) {
            throw new ApiError(405, failure);
          }
        }
      }

      const { commitOid } = await mergePullRequestEngine(c, found, issue, checked, {
        style: form.do,
        title: form.merge_title_field ?? "",
        message: form.merge_message_field ?? "",
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
      const merged = await findPullRequestByIndex(c.env.DB, found.repo.id, checked.index);
      if (merged !== null) {
        const rendered = await toApiPullRequest(c.env.DB, viewerOf(c), found, merged.issue, merged.pullRequest, "payload");
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
  // POST /repos/{owner}/{repo}/merge-upstream (repoMergeUpstream) — 404:
  // forks cannot exist yet (SPEC-0003 fork primitives pending); the write
  // gate still runs so private-repo enumeration stays the 404 it already is.
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
        // the MergeUpstreamResponse shape is declared in models/pull.ts and
        // carried for the fork wave; forks cannot exist yet, so this handler
        // never reaches 200 (the declared empty family)
        200: { description: "MergeUpstreamResponse" },
        400: errorResponse,
        404: notFoundResponse,
        409: errorResponse,
      },
    }),
    async (c) => {
      const { found } = await requireVisibleRepo(c, c.req.valid("param"));
      c.req.valid("json"); // bind (fast-forward_only accepted per upstream shape)
      await mergeUpstreamEngine(c, found);
      return c.body(null, 200); // unreachable — mergeUpstreamEngine throws
    },
    bindValidationHook,
  );
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/pulls/{base}/{head} (repoGetPullRequestByBaseHead)
  // — the pure D1 lookup on the base/head columns; the fork form
  // `owner:branch` resolves the head repo through resolveHeadRepo (404 when
  // the head repo row is absent).
  // -------------------------------------------------------------------------
  app.openapi(getPullByBaseHeadRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const { base, head } = c.req.valid("param");
    const resolved = await resolveHeadRepo(c.env.DB, found, head);
    const row = await findPullRequestByBaseHeadInfo(c.env.DB, found.repo.id, resolved.headRepoId, base, resolved.headBranch);
    if (row === null) {
      throw new ApiError(404, "not found"); // upstream APIErrorNotFound
    }
    return c.json(await toApiPullRequest(c.env.DB, viewer, found, row.issue, row.pullRequest, "single"), 200);
  });
}

/** The PR-commits walk window (upstream lists the full range; the handler
 *  pages the reversed window — the compare route's bound family). */
const PULL_COMMITS_BOUND = 250;

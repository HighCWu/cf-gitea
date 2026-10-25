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
 * order, services/pull/pull.go:157). GET …/{index} runs the LAZY
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
 * ("User not allowed to merge PR" — the write-scope stand-in requires a
 * token but no per-user merge whitelist exists yet).
 *
 * The PATCH `base` retarget stays engine-gated upstream (branch existence +
 * ChangeTargetBranch) and is still ignored this wave (same treatment as the
 * issue PATCH's assignee fields).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context, MiddlewareHandler } from "hono";
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import { issues, PRStatus, pullRequests, users } from "../../db/schema";
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
import { changeIssueBody, changeIssueDeadline, changeIssueMilestone, changeIssueTitle, hasWorkInProgressPrefix, issueErrorToApiError } from "../services/issues";
import { parseMilestoneDeadline } from "../services/milestones";
import {
  existingRepoLabelIds,
  findPullRequestByBaseHeadInfo,
  findPullRequestByIndex,
  findUnmergedPullRequest,
  listRepoPullRequests,
  pullRequestAlreadyExistsError,
  pullRequestNotExistError,
  resolveHeadRepo,
  toApiPullRequest,
} from "../services/pulls";
import {
  createPullHeadRef,
  ensurePullRequestChecked,
  mergePullRequest as mergePullRequestEngine,
  mergeableOfRow,
  mergeUpstream as mergeUpstreamEngine,
  pullRequestDiff,
} from "../services/pull-engine";
import { branchRef, engineReads } from "../services/engine";
import { renderUnifiedDiff, renderPatch, toApiCommit, toChangedFiles, usernamesByEmail } from "../services/git-models";
import { canViewRepository, findRepositoryByPath, repositoryPermissions, toApiRepository, viewerOf, type RepositoryWithOwner } from "../services/repository";
import { canWriteRepository } from "../services/repo-access";
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
 * engine-gated upstream and is ignored this wave (same treatment as the
 * issue PATCH's assignee fields).
 *
 * Webhook triggers (SPEC-0005 §3.5): pull_request opened (POST) / edited
 * (title, body, with `changes{title{from}, body{from}}`) / closed+reopened
 * (PATCH state), through emitWebhookDeliveries — see emitPullWebhook. The
 * sub-events (pull_request_label/-milestone/-assign) ride their tier-2
 * surfaces.
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
}

/** The shared PullRequestPayload wrapper (§2.7, modules/structs/hook.go:484). */
function pullRequestPayload(
  action: string,
  apiPullRequest: PullRequest,
  index: number,
  repository: unknown,
  sender: unknown,
  options: { changes?: Record<string, { from: string }>; commitId?: string } = {},
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
    const rendered = await Promise.all(items.map(({ issue, pullRequest }) => toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "list")));
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
      // forms must name this repo — forks cannot exist yet), the head
      // resolves through resolveHeadRepo (`owner:branch` fork form). Branch
      // EXISTENCE is an engine read (SPEC-0005 §3.4 creation flow step 1).
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

      const reads = engineReads(c.env, found.repo);
      const baseTip = await reads.readCommit(branchRef(baseBranch));
      const headTip = head.headRepoId === found.repo.id ? await reads.readCommit(branchRef(head.headBranch)) : null;
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

      // Milestone validation (GetMilestoneByRepoID miss → the typed 404, the
      // issues-block convention).
      const milestoneId = form.milestone === undefined || form.milestone === 0 ? null : form.milestone;

      // Labels: unknown ids silently dropped (GetLabelsInRepoByIDs), unlike
      // POST /issues which 404s them.
      const labelIds = await existingRepoLabelIds(c.env.DB, found.repo.id, form.labels ?? []);

      // ApplyAPIDeadlineTimestamp port — 400 "invalid date format" on bad
      // input (runtime-only status, same as the issues block).
      let deadlineAt: Date | null = null;
      if (form.due_date !== undefined && form.due_date !== null && form.due_date !== "") {
        deadlineAt = parseMilestoneDeadline(form.due_date);
      }

      let issue: IssueRow;
      let pr: PullRequestRow;
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
        }));
      } catch (error) {
        asApiError(error);
        throw error;
      }

      // The base-repo head ref: a receive-less CAS write (commitApiChange,
      // SPEC-0001b §4.4 mapping). Failure after the D1 commit deletes the row
      // again (upstream's cleanup order, services/pull/pull.go:157).
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

      const rendered = await toApiPullRequest(c.env.DB, viewer, found, issue, pr, "single");
      // Webhook: pull_request opened.
      await emitPullWebhook(c, {
        repoId: found.repo.id,
        ownerId: found.repo.ownerId,
        eventType: "pull_request",
        payload: pullRequestPayload("opened", rendered, issue.index, toApiRepository(viewerOf(c), found), c.get("authUser")),
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
        await emitPullWebhook(c, {
          repoId: found.repo.id,
          ownerId: found.repo.ownerId,
          eventType: "pull_request",
          payload: pullRequestPayload(
            "edited",
            await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "single"),
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
        await emitPullWebhook(c, {
          repoId: found.repo.id,
          ownerId: found.repo.ownerId,
          eventType: "pull_request",
          payload: pullRequestPayload(
            "edited",
            await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "single"),
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

      // form.assignee(s): upstream replaces the assignee set — no
      // issue_assignees table yet; ignored (issues-PATCH convention).
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
          await emitPullWebhook(c, {
            repoId: found.repo.id,
            ownerId: found.repo.ownerId,
            eventType: "pull_request",
            payload: pullRequestPayload(
              "closed",
              await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "single"),
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
          await emitPullWebhook(c, {
            repoId: found.repo.id,
            ownerId: found.repo.ownerId,
            eventType: "pull_request",
            payload: pullRequestPayload(
              "reopened",
              await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "single"),
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
  // — the PR range walk (CommitList carries the contract's X-* header family).
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
      const rangeCommits =
        checked.mergeBase === null ? { commits: [], more: false } : ((await reads.listCommitsRange(checked.mergeBase, range.head, listOptions.limit, listOptions.page - 1)) ?? { commits: [], more: false });
      const commits = rangeCommits.commits;
      // X-Total-Count approximation: commits SO FAR (module doc on
      // setCommitListHeaders); the Link header gets a next relation when the
      // walk reports more.
      const soFar = (listOptions.page - 1) * listOptions.limit + commits.length;
      setPaginationHeaders(c, soFar + (rangeCommits.more ? 1 : 0), listOptions);
      setCommitListHeaders(c, listOptions, soFar, rangeCommits.more);

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
      const requester = c.get("authUser");
      if (requester === undefined) {
        throw new ApiError(401, "token is required"); // unreachable behind requireAuth
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

      const { commitOid } = await mergePullRequestEngine(c, found, issue, checked, {
        style: form.do,
        title: form.merge_title_field ?? "",
        message: form.merge_message_field ?? "",
        deleteBranchAfterMerge: form.delete_branch_after_merge === true,
        mergeCommitId: form.merge_commit_id,
        doerId: requester.id ?? 0,
        now: new Date(),
      });

      // Webhook: pull_request closed with merged=true (the merged trio set).
      const merged = await findPullRequestByIndex(c.env.DB, found.repo.id, checked.index);
      if (merged !== null) {
        const rendered = await toApiPullRequest(c.env.DB, viewerOf(c), found, merged.issue, merged.pullRequest, "single");
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
  // `owner:branch` resolves the head repo (404 — forks cannot exist yet).
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

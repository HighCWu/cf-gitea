import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context, MiddlewareHandler } from "hono";
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import { issues, pullRequests, users } from "../../db/schema";
import { IssueError, MilestoneNotExistError } from "../../issues/errors";
import { IssuesService, type IssueRow, type PullRequestRow } from "../../issues/service";
import { emitWebhookDeliveries, type HookEventType } from "../../issues/webhooks";
import type { WebhookDeliveryMessage } from "../../webhooks/consumer";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  createPullRequestOptionSchema,
  editPullRequestOptionSchema,
  pullRequestListSchema,
  pullRequestSchema,
  type PullRequest,
} from "../models/pull";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { changeIssueBody, changeIssueDeadline, changeIssueMilestone, changeIssueTitle, issueErrorToApiError } from "../services/issues";
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
  canViewRepository,
  findRepositoryByPath,
  repositoryPermissions,
  toApiRepository,
  viewerOf,
  type RepositoryWithOwner,
} from "../services/repository";

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
): { sendBatch(messages: WebhookDeliveryMessage[]): Promise<unknown> } | null {
  const candidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  if (candidate === undefined || candidate === null) return null;
  const queue = candidate as { sendBatch?: (messages: WebhookDeliveryMessage[]) => Promise<unknown> };
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
                queue.sendBatch(deliveryIds.map((deliveryId) => ({ deliveryId }))).then(undefined, (error: unknown) => {
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

      // parseCompareInfo reduced to the D1 registry: the base resolves inside
      // this repo (owner-qualified forms must name this repo — forks cannot
      // exist yet), the head resolves through resolveHeadRepo (`owner:branch`
      // fork form). Branch EXISTENCE is an engine read — accepted per
      // upstream shape, validated at the mergeability wave (file header).
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
        }));
      } catch (error) {
        asApiError(error);
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
  // GET /repos/{owner}/{repo}/pulls/{index} (repoGetPullRequest)
  // -------------------------------------------------------------------------
  app.openapi(getPullRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const { issue, pullRequest } = await requirePullRequest(c, found, c.req.valid("param").index);
    return c.json(await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "single"), 200);
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

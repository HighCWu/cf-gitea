import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { asc, count, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { actionRunners } from "../../db/schema";
import { deleteRunner, getOrCreateActiveRunnerToken, getRunnerById, type RunnerRow } from "../../services/actions/model";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { repositorySchema } from "../models/repository";
import { userSchema } from "../models/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { viewerOf } from "../services/repository";
import {
  RUNNER_IDLE_MS,
  RUNNER_OFFLINE_MS,
  listWorkflowJobsWire,
  listWorkflowRunsWire,
  runnerMissMessage,
  setRunnerDisabled,
  toApiRunner,
  workflowJobFiltersFromQuery,
  workflowRunFiltersFromQuery,
} from "../services/secrets-variables";

/**
 * The ADMIN Actions family — the `/admin/actions` group (7 contract
 * operations, `routers/api/v1/api.go:1856-1867`), the board's P1-12 landing
 * (slice 5 of 5 of the P1-7 remainder). The admin-t2 batch had
 * declared-undeclared this family when "no runner tables" existed
 * (`routes/admin-t2.ts`'s header reduction) — the `action_runners` +
 * `action_runner_tokens` stores landed with SPEC-0012 M1b and the P1-7
 * runner family made the shared runner mapping serve, so the reduction's
 * premise is stale and this module is the pure registration:
 *
 *   - `GET    /admin/actions/runners`                        (getAdminRunners)
 *   - `POST   /admin/actions/runners/registration-token`     (adminCreateRunnerRegistrationToken)
 *   - `GET    /admin/actions/runners/{runner_id}`            (getAdminRunner)
 *   - `DELETE /admin/actions/runners/{runner_id}`            (deleteAdminRunner)
 *   - `PATCH  /admin/actions/runners/{runner_id}`            (updateAdminRunner)
 *   - `GET    /admin/actions/runs`                           (listAdminWorkflowRuns)
 *   - `GET    /admin/actions/jobs`                           (listAdminWorkflowJobs)
 *
 * Upstream anchors, per family:
 *
 *   - RUNNERS CRUD — `admin.ListRunners/CreateRegistrationToken/GetRunner/
 *     DeleteRunner/UpdateRunner` (`routers/api/v1/admin/runners.go:14-126`,
 *     the board's "admin/actions.go" cite decomposed: the runs/jobs
 *     listings live in `admin/action.go`) — every one delegates to the
 *     shared mapping with ownerID=0/repoID=0 over
 *     `shared.GetRegistrationToken/ListRunners/getRunnerByID/DeleteRunner/
 *     UpdateRunner` (`shared/runners.go:25-141`). The
 *     ADMIN polarity (the org/repo twins' arms inverted):
 *       * the LIST opts carry NO scope pair — `FindRunnerOptions.ToConds`
 *         (runner.go:245-276) rides neither branch, so EVERY runner lists
 *         (repo-scoped, owner-scoped and global — the instance-wide census;
 *         the same `shared/runners.go:36` doc line);
 *       * the LOOKUP is ID-only and `EditableInContext(0, 0)` returns TRUE
 *         unconditionally (runner.go:158-165 — "administrators can edit all
 *         runners"), so the twins' foreign-scope 404 "No permission…" arm
 *         DOES NOT EXIST here — the only 404 is GetRunnerByID's not-exist
 *         text (`runnerMissMessage`, rendered whole through
 *         util.ErrorUnwrapForUser);
 *       * the REGISTRATION TOKEN is the GLOBAL (0, '') scope
 *         (`GetOrCreateActiveRunnerToken(ctx, 0, 0)`, shared/runners.go:25-33
 *         via admin.CreateRegistrationToken) — the token the UI admin
 *         runners page displays (`ui/pages/admin-actions-runners.tsx`'s
 *         loader, the b5923ed precedent).
 *   - RUNS/JOBS LISTS — `admin.ListWorkflowRuns/ListWorkflowJobs`
 *     (`admin/action.go:12-103`) delegate to `shared.ListRuns/ListJobs`
 *     (`shared/action.go`) with ownerID=0/repoID=0/nil: no scope cond, and
 *     `FindUserActionsAccessibleOwnerRepoIDsSubQuery(0, doer)` is NIL
 *     (repo_list.go:805-810 — ownerID <= 0 is unrestricted; the site-admin
 *     arm agrees) so every run/job of every repo lists. The store order is
 *     ToOrders' non-repo arm — the global `id` DESC (run_list.go:142-153).
 *
 * The storage + wire mapping ride the P1-7/P1-8 service primitives verbatim
 * (`services/secrets-variables.ts`'s Runners + runs/jobs sections —
 * imported, not modified; the siblings own that file this window). Only the
 * admin-scope lookups live here: the service's `listRunnerRows`/
 * `findRunnerInContext` are scope-pinned by design (exact (ownerId, repoId)
 * equality), which is the TWINS' polarity, not the admin's.
 *
 * WIRING (`api.go:1824-1867`): the whole /admin group runs
 * `tokenRequiresScopes(admin) → reqToken() → reqSiteAdmin() →
 * rejectPublicOnly()`. Landed seams (the admin-t2 restatement):
 *   - reqToken → the shared requireAuth middleware (401 `token is required`;
 *     runtime-only, the contract documents no 401 in the admin tag);
 *   - reqSiteAdmin (api.go:343-347) → requireSiteAdmin below, 403
 *     `user should be the site admin` — ALSO runtime-only here: upstream's
 *     own swagger comments for these 7 ops document NO 403 (the same
 *     doc-comment gap its adminCronList sibling lacks — the
 *     `/admin/cron/{task}` RUNTIME_ONLY entry is the declared precedent),
 *     and the frozen contract carries {200,400,404…} only, so the 403 is
 *     exercised in the suite, never declared;
 *   - tokenRequiresScopes → mounted tree-wide (auth-parity H1) —
 *     src/api/router.ts's apiScopeGate carries the /admin row;
 *   - rejectPublicOnly → the src/index.ts arm at /api/v1/admin/*.
 *
 * HANDOFF (the tier2-extras convention): the routes are relative to the
 * /api/v1 mount; the orchestrator registers them in src/api/router.ts with
 * `registerAdminActionsRoutes(app, requireAuth)` (beside
 * registerAdminT2Routes — the paths are disjoint, mount order is free).
 */

// ---------------------------------------------------------------------------
// Wire schemas (route-local: the module owns its contract shapes — the same
// shapes routes/secrets-variables.ts declares for the scope twins; duplicated
// per the route-local convention, since the shapes are this module's own
// contract surface and the twins' file is sibling-owned).
// ---------------------------------------------------------------------------

/** `#/definitions/ActionRunnerLabel` (structs/repo_actions.go:225-229) —
 *  convert.ToActionRunner renders every agent label as type "custom" with
 *  the slice index as id (convert.go:800-808). */
const actionRunnerLabelSchema = z.object({
  id: z.number().int().openapi({ format: "int64", description: "the label's slice index" }),
  name: z.string().openapi({ description: "the label's name" }),
  type: z.string().openapi({ description: "the label's type" }),
});

/** `#/definitions/ActionRunner` (structs/repo_actions.go:232-241) — `status`
 *  is the coarse "online"/"offline" string, `busy` the fine ACTIVE rank
 *  (convert.go:798-814). */
const actionRunnerSchema = z.object({
  id: z.number().int().openapi({ format: "int64" }),
  name: z.string(),
  status: z.string().openapi({ description: "online or offline" }),
  busy: z.boolean(),
  disabled: z.boolean(),
  ephemeral: z.boolean(),
  labels: z.array(actionRunnerLabelSchema),
});

/** `#/definitions/ActionRunnersResponse` (structs/repo_actions.go:252-255). */
const actionRunnersResponseSchema = z.object({
  runners: z.array(actionRunnerSchema),
  total_count: z.number().int().openapi({ format: "int64" }),
});

/** The registration-token body (shared/runners.go:19-23) — the Go struct
 *  serializes as {"token": …}. */
const registrationTokenSchema = z.object({
  token: z.string().openapi({ description: "the registration token" }),
});

/** `#/definitions/EditActionRunnerOption` (structs/repo_actions.go:244-249) —
 *  the pointer field is NOT binder-Required (the bind succeeds on a missing
 *  field); shared/runners.go:130-133's own nil check answers the 422. */
const editActionRunnerOptionSchema = z.object({
  disabled: z.boolean().optional().openapi({ description: "Disable the runner" }),
});

/** `#/definitions/PullRequestMinimalHeadRepo` (repo_actions.go:186-193). */
const pullRequestMinimalHeadRepoSchema = z.object({
  id: z.number().int().openapi({ format: "int64" }),
  url: z.string().openapi({ description: "the repo's API URL" }),
  name: z.string().openapi({ description: "the repo's name" }),
});

/** `#/definitions/PullRequestMinimalHead` (repo_actions.go:176-184). */
const pullRequestMinimalHeadSchema = z.object({
  ref: z.string().openapi({ description: "the branch name" }),
  sha: z.string().openapi({ description: "the commit sha" }),
  repo: pullRequestMinimalHeadRepoSchema,
});

/** `#/definitions/PullRequestMinimal` (repo_actions.go:169-174). */
const pullRequestMinimalSchema = z.object({
  id: z.number().int().openapi({ format: "int64" }),
  number: z.number().int().openapi({ format: "int64" }),
  url: z.string().openapi({ description: "the PR's API URL" }),
  head: pullRequestMinimalHeadSchema,
  base: pullRequestMinimalHeadSchema,
});

/** `#/definitions/ActionWorkflowRun` (repo_actions.go:110-157) — omitempty
 *  fields optional; `repository_id`/`head_repository` mirror the converter's
 *  never-set fields (optional, never rendered); `previous_attempt_url` is
 *  deliberately non-optional (a nil renders as null, convert.go:300-307). */
const actionWorkflowRunSchema = z.object({
  id: z.number().int().openapi({ format: "int64" }),
  url: z.string(),
  previous_attempt_url: z.string().nullable().openapi({ description: "the API URL of the previous attempt of this run, null when the current attempt is 1" }),
  html_url: z.string(),
  jobs_url: z.string(),
  logs_url: z.string(),
  artifacts_url: z.string(),
  cancel_url: z.string(),
  rerun_url: z.string(),
  display_title: z.string(),
  path: z.string(),
  event: z.string(),
  run_attempt: z.number().int().openapi({ format: "int64", description: "1-based attempt; 0 is a legacy-only sentinel for pre-attempt runs" }),
  run_number: z.number().int().openapi({ format: "int64" }),
  repository_id: z.number().int().optional().openapi({ format: "int64" }),
  head_sha: z.string(),
  head_branch: z.string().optional(),
  status: z.string(),
  actor: userSchema.optional(),
  trigger_actor: userSchema.optional(),
  repository: repositorySchema.optional(),
  head_repository: repositorySchema.optional(),
  conclusion: z.string().optional(),
  pull_requests: z.array(pullRequestMinimalSchema),
  created_at: z.string().openapi({ format: "date-time" }),
  updated_at: z.string().openapi({ format: "date-time" }),
  started_at: z.string().openapi({ format: "date-time" }),
  completed_at: z.string().openapi({ format: "date-time" }),
});

/** `#/definitions/ActionWorkflowRunsResponse` (repo_actions.go:218-222). */
const actionWorkflowRunsResponseSchema = z.object({
  workflow_runs: z.array(actionWorkflowRunSchema),
  total_count: z.number().int().openapi({ format: "int64" }),
});

/** `#/definitions/ActionWorkflowStep` (repo_actions.go:170-179) — `number`
 *  is the step's LIST index (the converter's loop counter, convert.go:552). */
const actionWorkflowStepSchema = z.object({
  name: z.string(),
  number: z.number().int().openapi({ format: "int64" }),
  status: z.string(),
  conclusion: z.string().optional(),
  started_at: z.string().openapi({ format: "date-time" }),
  completed_at: z.string().openapi({ format: "date-time" }),
});

/** `#/definitions/ActionWorkflowJob` (repo_actions.go:190-215) — omitempty
 *  fields optional. */
const actionWorkflowJobSchema = z.object({
  id: z.number().int().openapi({ format: "int64" }),
  url: z.string(),
  html_url: z.string(),
  run_id: z.number().int().openapi({ format: "int64" }),
  run_url: z.string(),
  name: z.string(),
  labels: z.array(z.string()),
  run_attempt: z.number().int().openapi({ format: "int64" }),
  head_sha: z.string(),
  head_branch: z.string().optional(),
  status: z.string(),
  conclusion: z.string().optional(),
  runner_id: z.number().int().optional().openapi({ format: "int64" }),
  runner_name: z.string().optional(),
  steps: z.array(actionWorkflowStepSchema),
  created_at: z.string().openapi({ format: "date-time" }),
  started_at: z.string().openapi({ format: "date-time" }),
  completed_at: z.string().openapi({ format: "date-time" }),
});

/** `#/definitions/ActionWorkflowJobsResponse` (repo_actions.go:224-228). */
const actionWorkflowJobsResponseSchema = z.object({
  jobs: z.array(actionWorkflowJobSchema),
  total_count: z.number().int().openapi({ format: "int64" }),
});

// ---------------------------------------------------------------------------
// Shared response/param fragments.
// ---------------------------------------------------------------------------

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

/** The runs list's filter set (admin/action.go:60-90's parameters + the
 *  runtime exclude_pull_requests the shared handler reads). */
const runsListQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
    event: z.string().optional().openapi({ description: "workflow event name" }),
    branch: z.string().optional().openapi({ description: "workflow branch" }),
    status: z.string().optional().openapi({ description: "workflow status (requested, pending, queued, in_progress, failure, success, skipped)" }),
    actor: z.string().optional().openapi({ description: "triggered by user" }),
    head_sha: z.string().optional().openapi({ description: "triggering sha of the workflow run" }),
    exclude_pull_requests: z.string().optional().openapi({ type: "boolean", description: "if true, the `pull_requests` field on each returned run is emptied" }),
  }),
} as const;

/** The jobs list's filter set (admin/action.go:20-39's parameters). */
const jobsListQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
    status: z.string().optional().openapi({ description: "workflow status (requested, pending, queued, in_progress, failure, success, skipped)" }),
    sort: z.string().optional().openapi({ description: 'sort jobs by attribute. Supported values are "id". Default is "id"' }),
    order: z.string().optional().openapi({ description: 'sort order, either "asc" (ascending) or "desc" (descending). Default is "asc"' }),
  }),
} as const;

const runnerIdParams = {
  runner_id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the runner" }),
} as const;

/** The runner list's `disabled` filter — the contract types it boolean; the
 *  wire is a query STRING parsed with FormOptionalBool's semantics
 *  (base_form.go:71-79). */
const runnerListQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
    disabled: z.string().optional().openapi({ type: "boolean", description: "filter by disabled status (true or false)" }),
  }),
} as const;

/** PathParamInt64 (services/context/base_path.go:35-38) — a strict parse
 *  whose failure arm is 0, so a non-numeric runner_id becomes the 404 miss
 *  for id 0, exactly upstream (the scope twins' verbatim helper). */
function pathParamInt64(raw: string): number {
  return /^-?\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
}

/** FormOptionalBool (services/context/base_form.go:71-79): absent/empty =
 *  no filter; strconv.ParseBool's true spellings ("1","t","T","true",
 *  "TRUE","True") or case-insensitive "on" = true; everything else parses
 *  as false (the ignored error arm). */
function formOptionalBool(url: URL, key: string): boolean | null {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") {
    return null;
  }
  return /^(1|t|T|true|TRUE|True)$/.test(raw) || raw.toLowerCase() === "on";
}

// ---------------------------------------------------------------------------
// Auth seam — the /admin group's reqSiteAdmin (see the module header).
// ---------------------------------------------------------------------------

/**
 * `reqSiteAdmin` (routers/api/v1/api.go:343-347): a resolved doer who is not
 * a site admin gets the exact upstream 403 message. Mounted AFTER requireAuth
 * (the upstream chain's order: reqToken then reqSiteAdmin). Runtime-only
 * response code — the contract documents no 403 on these 7 ops (header note).
 */
function requireSiteAdmin(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (c.get("authUser")?.is_admin !== true) {
      throw new ApiError(403, "user should be the site admin");
    }
    await next();
  };
}

// ---------------------------------------------------------------------------
// The ADMIN-polarity runner list + lookup (the scope twins' helpers are
// scope-pinned; the admin arms live here per the module header).
// ---------------------------------------------------------------------------

/**
 * The FindRunnerOptions default order (runner.go:315) at the ADMIN scope —
 * the computed status rank first, then is_disabled, last_online desc, and
 * the id tiebreaker. Mirrors the service's module-private runnerStatusOrder
 * (services/secrets-variables.ts:563-567) — duplicated because the service
 * file is sibling-owned and the helper is not exported; byte-equivalent
 * (the same COALESCE'd 0 sentinel so never-seen runners rank offline).
 */
function runnerStatusOrder(now: Date) {
  const offlineThreshold = Math.floor(now.getTime() / 1000) - Math.floor(RUNNER_OFFLINE_MS / 1000);
  const idleThreshold = Math.floor(now.getTime() / 1000) - Math.floor(RUNNER_IDLE_MS / 1000);
  return sql`CASE WHEN COALESCE(${actionRunners.lastOnline}, 0) <= ${offlineThreshold} THEN 2 WHEN COALESCE(${actionRunners.lastActive}, 0) <= ${idleThreshold} THEN 1 ELSE 0 END`;
}

/**
 * shared.ListRunners at the ADMIN scope (shared/runners.go:41-66 with
 * ownerID=0/repoID=0): FindRunnerOptions.ToConds' scope branches never ride
 * (runner.go:245-276), so EVERY runner lists — repo-scoped, owner-scoped and
 * global — with the optional disabled filter, upstream's default order, and
 * the paginated total. `disabled` mirrors FormOptionalBool: null = absent.
 */
async function listAdminRunnerRows(
  d1: D1Database,
  disabled: boolean | null,
  page: number,
  limit: number,
  now: Date = new Date(),
): Promise<{ rows: RunnerRow[]; total: number }> {
  const where = disabled === null ? undefined : eq(actionRunners.isDisabled, disabled);
  const totals = await drizzle(d1).select({ value: count() }).from(actionRunners).where(where);
  const rows = await drizzle(d1)
    .select()
    .from(actionRunners)
    .where(where)
    .orderBy(runnerStatusOrder(now), asc(actionRunners.isDisabled), desc(actionRunners.lastOnline), asc(actionRunners.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return { rows, total: totals[0]?.value ?? 0 };
}

/**
 * GetRunnerByID at the ADMIN scope: the ID-only lookup with NO scope pin —
 * `EditableInContext(0, 0)` returns TRUE unconditionally
 * (runner.go:158-165), so unlike the scope twins there is NO foreign arm:
 * the only 404 is the not-exist text. A null row throws it.
 */
async function findAdminRunner(d1: D1Database, runnerId: number): Promise<RunnerRow> {
  const row = await getRunnerById(d1, runnerId);
  if (row === null) {
    throw new ApiError(404, runnerMissMessage(runnerId));
  }
  return row;
}

/** The handlers' shared authUser view (requireSiteAdmin has run). */
function adminContext(c: Context<ApiEnv>): { d1: D1Database; url: URL } {
  return { d1: c.env.DB, url: new URL(c.req.url) };
}

// ---------------------------------------------------------------------------
// The routes.
// ---------------------------------------------------------------------------

export function registerAdminActionsRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // =========================================================================
  // RUNNERS CRUD + REGISTRATION TOKEN (5) — the admin bindings of
  // shared/runners.go (api.go:1857-1863).
  // =========================================================================

  // -------------------------------------------------------------------------
  // GET /admin/actions/runners (getAdminRunners)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/actions/runners",
      middleware: [requireAuth, requireSiteAdmin()],
      tags: ["admin"],
      summary: "Get all runners",
      operationId: "getAdminRunners",
      request: { ...runnerListQuery },
      responses: {
        200: {
          description: "RunnerList",
          content: { "application/json": { schema: actionRunnersResponseSchema } },
        },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { d1, url } = adminContext(c);
      const opts = parseListOptions(url);
      const { rows, total } = await listAdminRunnerRows(d1, formOptionalBool(url, "disabled"), opts.page, opts.limit);
      setPaginationHeaders(c, total, opts);
      return c.json({ runners: rows.map((row) => toApiRunner(row, new Date())), total_count: total }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/actions/runners/registration-token
  // (adminCreateRunnerRegistrationToken)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/admin/actions/runners/registration-token",
      middleware: [requireAuth, requireSiteAdmin()],
      tags: ["admin"],
      summary: "Get a global actions runner registration token",
      operationId: "adminCreateRunnerRegistrationToken",
      request: {},
      responses: {
        200: {
          description: "RegistrationToken",
          content: { "application/json": { schema: registrationTokenSchema } },
        },
      },
    }),
    async (c) => {
      // shared.GetRegistrationToken(ctx, 0, 0) (shared/runners.go:25-33) —
      // the GLOBAL scope's active token, created on the first call and
      // reused until a reset (runner_token.go:127-134); the TEXT repoId's
      // '' sentinel is the landed global encoding.
      const token = await getOrCreateActiveRunnerToken(c.env.DB, 0, "");
      return c.json({ token: token.token }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/actions/runners/{runner_id} (getAdminRunner)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/actions/runners/{runner_id}",
      middleware: [requireAuth, requireSiteAdmin()],
      tags: ["admin"],
      summary: "Get a global runner",
      operationId: "getAdminRunner",
      request: {
        params: z.object(runnerIdParams),
      },
      responses: {
        200: {
          description: "Runner",
          content: { "application/json": { schema: actionRunnerSchema } },
        },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { d1 } = adminContext(c);
      const runnerId = pathParamInt64(c.req.valid("param").runner_id);
      const row = await findAdminRunner(d1, runnerId);
      return c.json(toApiRunner(row, new Date()), 200);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/actions/runners/{runner_id} (deleteAdminRunner)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/admin/actions/runners/{runner_id}",
      middleware: [requireAuth, requireSiteAdmin()],
      tags: ["admin"],
      summary: "Delete a global runner",
      operationId: "deleteAdminRunner",
      request: {
        params: z.object(runnerIdParams),
      },
      responses: {
        204: { description: "runner has been deleted" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { d1 } = adminContext(c);
      const runnerId = pathParamInt64(c.req.valid("param").runner_id);
      const row = await findAdminRunner(d1, runnerId);
      await deleteRunner(d1, row.id);
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/actions/runners/{runner_id} (updateAdminRunner)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "patch",
      path: "/admin/actions/runners/{runner_id}",
      middleware: [requireAuth, requireSiteAdmin()],
      tags: ["admin"],
      summary: "Update a global runner",
      operationId: "updateAdminRunner",
      request: {
        params: z.object(runnerIdParams),
        body: { content: { "application/json": { schema: editActionRunnerOptionSchema } } },
      },
      responses: {
        200: {
          description: "Runner",
          content: { "application/json": { schema: actionRunnerSchema } },
        },
        400: errorResponse,
        404: notFoundResponse,
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const { d1 } = adminContext(c);
      const form = c.req.valid("json");
      const runnerId = pathParamInt64(c.req.valid("param").runner_id);
      // Upstream order: the runner lookup's 404 fires BEFORE the Disabled-nil
      // 422 (shared/runners.go:124-133 — a missing runner 404s even with {}).
      const row = await findAdminRunner(d1, runnerId);
      if (form.disabled === undefined) {
        throw new ApiError(422, "[Disabled]: Required");
      }
      await setRunnerDisabled(d1, row, form.disabled);
      // UpdateRunner tail-calls GetRunner (shared/runners.go:140) — the
      // re-read renders the post-write row.
      const updated = await findAdminRunner(d1, runnerId);
      return c.json(toApiRunner(updated, new Date()), 200);
    },
  );

  // =========================================================================
  // RUNS/JOBS LISTS (2) — admin.ListWorkflowRuns/ListWorkflowJobs
  // (admin/action.go:12-103) over shared.ListRuns/ListJobs with (0, 0, nil)
  // — no scope cond, the unrestricted accessibility subquery
  // (api.go:1864-1866).
  // =========================================================================

  // -------------------------------------------------------------------------
  // GET /admin/actions/runs (listAdminWorkflowRuns)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/actions/runs",
      middleware: [requireAuth, requireSiteAdmin()],
      tags: ["admin"],
      summary: "Lists all runs",
      operationId: "listAdminWorkflowRuns",
      request: { ...runsListQuery },
      responses: {
        200: {
          description: "WorkflowRunsList",
          content: { "application/json": { schema: actionWorkflowRunsResponseSchema } },
        },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { d1, url } = adminContext(c);
      const opts = parseListOptions(url);
      const filters = await workflowRunFiltersFromQuery(d1, url, { ownerId: 0, repoId: "" });
      const { totalCount, runs } = await listWorkflowRunsWire(
        d1,
        viewerOf(c),
        filters,
        opts.page,
        opts.limit,
        formOptionalBool(url, "exclude_pull_requests") === true,
        // ownerID == 0 → the accessibility subquery is nil (repo_list.go:806)
        // — every repo's runs list, the admin's unrestricted census.
        null,
      );
      setPaginationHeaders(c, totalCount, opts);
      return c.json({ workflow_runs: runs, total_count: totalCount }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/actions/jobs (listAdminWorkflowJobs)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/actions/jobs",
      middleware: [requireAuth, requireSiteAdmin()],
      tags: ["admin"],
      summary: "Lists all jobs",
      operationId: "listAdminWorkflowJobs",
      request: { ...jobsListQuery },
      responses: {
        200: {
          description: "WorkflowJobsList",
          content: { "application/json": { schema: actionWorkflowJobsResponseSchema } },
        },
        400: errorResponse,
        404: notFoundResponse,
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const { d1, url } = adminContext(c);
      const opts = parseListOptions(url);
      const { statuses, order } = workflowJobFiltersFromQuery(url);
      const { totalCount, jobs } = await listWorkflowJobsWire(
        d1,
        viewerOf(c),
        { ownerId: 0, repoId: "", statuses },
        order,
        opts.page,
        opts.limit,
        // ownerID == 0 → the accessibility subquery is nil (repo_list.go:806).
        null,
      );
      setPaginationHeaders(c, totalCount, opts);
      return c.json({ jobs, total_count: totalCount }, 200);
    },
  );
}

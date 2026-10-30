import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { and, asc, count, desc, eq, inArray, like, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import {
  actionLogChunks,
  actionRunAttempts,
  actionRunJobs,
  actionRuns,
  actionRunners,
  actionTaskSteps,
  actionTasks,
  issues,
  pullRequests,
  repositories,
  users,
} from "../../db/schema";
import type { RunJobRow, RunRow } from "../../services/actions/model";
import { insertActionRun } from "../../services/actions/model";
import { loadRepoActionsConfig, saveRepoActionsConfig } from "../../services/actions/config";
import type { RepositoryWithOwner, UserRow } from "../services/repository";
import { GO_ZERO_TIME, apiUserFromRow, toApiRepository, viewerOf } from "../services/repository";
import { canWriteRepository, isRepositoryAdmin, requireVisibleRepo } from "../services/repo-access";
import { loadRepoSettings } from "../services/repo-settings";
import { engineReads } from "../services/engine";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { parseListOptions, setPaginationHeaders } from "../pagination";

/**
 * The repo-level Actions extras — the board's P1-9 row (residuals v1.3.2 row
 * 9): the `/actions/workflows` family (list / get / runs / disable / enable /
 * dispatch, routers/api/v1/api.go:1255-1262, handlers
 * routers/api/v1/repo/action.go:859-1238) plus the `/actions/jobs` pair
 * (getWorkflowJob, action.go:1702-1752; downloadActionsRunJobLogs,
 * routers/api/v1/repo/actions_run.go:15-51 over
 * routers/common/actions.go:98-132). Eight operations over the LANDED
 * actions stores: the git-tree workflow reader rides the engine reads (the
 * repo-actions-workflow/repo-actions-runs UI modules' WORKFLOW_DIRS walk),
 * the disable/enable store IS the LANDED ActionsConfig (`repo_units.config`
 * — services/actions/config.ts), the dispatch inserts through the LANDED
 * `insertActionRun` seam, and job logs read the LANDED DBFS chunk/R2 store
 * (the repo-actions-logs UI module's read arms).
 *
 * FAMILY/FILE — the /api/v1 actions family lives in
 * routes/secrets-variables.ts (secrets/variables/runners), but that file is
 * a sibling unit's exclusive property this window (P1-8, the runs/jobs
 * listing trio), so THIS is a NEW family file following its conventions
 * (OpenAPIHono + createRoute + a register*Routes(app, requireAuth) one-liner).
 * HANDOFF to the orchestrator — the one-line registration in api/router.ts
 * beside registerSecretsVariablesRoutes:
 *
 *   registerRepoActionsRoutes(app, requireAuth);
 *
 * The connect-RPC mount (services/actions/routes.ts) is a different family
 * entirely (the /api/actions runner protocol, SPEC-0012 §2.1/§2.2) — its
 * header scopes it to those procedures; these /api/v1 ops do not belong
 * there.
 *
 * UPSTREAM GATE PRECISION (runtime-only codes, undeclared per the
 * secrets-variables family convention; every code declared below IS in the
 * vendored contract for its operation):
 *   - every op: 401 (the group's reqToken — api.go:1262/1266);
 *   - read arms (list/get/runs/job/job-logs): 403 — reqRepoReader(TypeActions)
 *     (api.go:1262/1266, api.go:403-410): the doer must read the actions UNIT
 *     (an enabled actions unit) or be a repo/site admin — "user should have
 *     specific read permission or be a repo admin or a site admin";
 *   - write arms (disable/enable/dispatch): 403 — reqRepoWriter(TypeActions)
 *     (api.go:393-400): `CanWrite(unit) || repoAdmin || siteAdmin` —
 *     "user should have a permission to write to a repo"; ours is
 *     `(repo write grant && unit enabled) || repo admin`.
 * The repo 404 rides requireVisibleRepo (missing and invisible are the same
 * 404, the family's convention).
 *
 * PER-OP WIRE (structs/repo_actions.go):
 *   - ActionWorkflow (:59-80): state "active"|"disabled_manually" over the
 *     ActionsConfig list (convert.go:611-614); name is the YAML `name:` when
 *     the file parses with one (convert.go:626-633), else the file name;
 *     created/updated carry the COMMIT AUTHOR time (convert.go:616-622);
 *     deleted_at is never set — Go-zero.
 *   - ActionWorkflowResponse (:83-86): {workflows, total_count}; a repo
 *     without any workflow dir answers 200/0 (ListWorkflows' `("", nil, nil)`
 *     arm, workflows.go:92-95) — only a missing default branch 500s
 *     (GetBranchCommit, convert.go:656-658).
 *   - ActionWorkflowRun (:107-148) + the WorkflowRunsList (:172-176):
 *     {total_count, workflow_runs}; status/conclusion by ToActionsStatus /
 *     ToRunActionsStatus (convert.go:441-478); previous_attempt_url is
 *     EXPLICIT null unless attempt > 1 (convert.go:289-306); pull_requests is
 *     always rendered (empty unless the loadPullRequestsForRun arms hit);
 *     repository_id/head_repository are never assigned by the converter
 *     (omitempty-omitted); head_branch omits for non-branch refs
 *     (ref.go:126-141's "" return); actor/trigger_actor omit when the
 *     trigger user row is missing.
 *   - ActionWorkflowJob (:202-224): urls per toActionWorkflowJob
 *     (convert.go:569-590); steps render from the LANDED action_task_steps
 *     rows (runner-reported, M1b); runner_id/runner_name only when an
 *     effective task exists (EffectiveTaskID, run_job.go:158-163).
 *   - RunDetails (:258-262) — the dispatch's return_run_details=true body.
 *
 * DECLARED SETS mirror the vendored contract minus the dead codes (each
 * documented): workflows list/get declare {200,403,404,500} of the
 * contract's {200,400,403,404,422,500} — the 400/422 arms have no read path
 * in either implementation (no body, no binding); runs declares
 * {200,400,403,404}; disable/enable {204,403,404} of
 * {204,400,403,404,422} (+ a dead 409 on enable — EnableOrDisableWorkflow
 * has no conflict path, workflow.go:30-52); dispatch
 * {200,204,403,404,422} of {200,204,400,403,404,422} — the 400 is dead (the
 * Go binder's failures are 422s, api.go:838-847); jobs pair {200,404} of
 * {200,400,404} — the 400s are dead (PathParamInt64 junk parses to 0 and
 * lands in the 404 miss, services/context/base_path.go:35-38).
 *
 * DOCUMENTED REDUCTIONS (each cites its upstream arm):
 *   - The workflow-tree walk lists ONE level (the engine's listTree arm;
 *     the repo-actions-runs/repo-actions-workflow UI modules' same note —
 *     upstream's ListWorkflows descends recursively
 *     (ListEntriesRecursiveFast, workflows.go:97-108)).
 *   - The M3-free workflow parse (the dispatch-inputs UI module's light
 *     check): YAML `name:`/`on:`/`jobs:` read with the landed `yaml`
 *     package; the full act/jobparser port (job-level transform, expression
 *     machinery, ValidateWorkflowStatic's needs graph) is M3 — the dispatch
 *     stores per-job single-job YAML payloads built by re-dumping the raw
 *     job mapping (the staged shape dispatch.test.ts pins).
 *   - The dispatch's run index comes from max(index)+1 (the repo_counters
 *     run_index sequence is M3, SPEC-0012 §4.5 — the model header's note);
 *     the UNIQUE(repo_id, index) index arbitrates a lost race with a 500.
 *   - scoped_workflow_source_repo_id > 0 answers 404 (the scoped-workflow
 *     source family is C10/post-M3; isScopedRun is never written — the
 *     dispatch-inputs UI module's same documented reduction).
 *   - The dispatch's form-urlencoded inputs arm (action.go:1148-1153) is not
 *     ported — the contract's body is JSON; upstream's chi binder accepts
 *     both, our zod route declares JSON.
 *   - The binder's Required 422 renders the Go field name — "Ref: Required"
 *     (api.go:842's `%s: %s` rendering; the secrets family's "Data:
 *     Required" pin); the handler's own `opt.Ref == ""` 422
 *     ("ref is required parameter", action.go:1141-1144) is dead for JSON
 *     bodies (the binder's Required rejects empty strings) and is not
 *     separately reachable.
 *   - The enable/disable/dispatch audit events (RecordWorkflowToggle,
 *     workflow.go:47-52; the dispatch's RecordAs, workflow.go:189) have no
 *     landed audit-actions registry entries (services/audit.ts carries the
 *     org/repo families only) — the events ride the audit-families wave.
 */

// ---------------------------------------------------------------------------
// Shared gates
// ---------------------------------------------------------------------------

/** The actions-unit read gate (reqRepoReader(TypeActions) — api.go:403-410):
 *  unit enabled for a plain repo reader; repo/site admins pass regardless. */
async function requireActionsReader(c: Context<ApiEnv>, pair: RepositoryWithOwner): Promise<void> {
  if (await isRepositoryAdmin(c, pair)) {
    return;
  }
  const settings = await loadRepoSettings(c.env.DB, pair.repo.id);
  if (settings.hasActions) {
    return;
  }
  throw new ApiError(403, "user should have specific read permission or be a repo admin or a site admin");
}

/** The actions-unit write gate (reqRepoWriter(TypeActions) — api.go:393-400):
 *  a repo write grant ON an enabled unit, or a repo/site admin. */
async function requireActionsWriter(c: Context<ApiEnv>, pair: RepositoryWithOwner): Promise<void> {
  if (await isRepositoryAdmin(c, pair)) {
    return;
  }
  const settings = await loadRepoSettings(c.env.DB, pair.repo.id);
  if (settings.hasActions && (await canWriteRepository(c, pair))) {
    return;
  }
  throw new ApiError(403, "user should have a permission to write to a repo");
}

// ---------------------------------------------------------------------------
// Wire schemas (route-local: the module owns its contract shapes)
// ---------------------------------------------------------------------------

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
};

const workflowIdParams = {
  ...ownerRepoParams,
  workflow_id: z.string().min(1).openapi({ description: "id of the workflow" }),
};

const jobIdParams = {
  ...ownerRepoParams,
  job_id: z.string().min(1).openapi({ description: "id of the job" }),
};

const errorResponse = {
  description: "APIError is error format response",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const notFoundResponse = {
  description: "APIError is error format response",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

/** `#/definitions/ActionWorkflow` (structs/repo_actions.go:59-80). */
export const actionWorkflowSchema = z.object({
  id: z.string().openapi({ description: "ID is the unique identifier for the workflow" }),
  name: z.string().openapi({ description: "Name is the name of the workflow" }),
  path: z.string().openapi({ description: "Path is the file path of the workflow" }),
  state: z.string().openapi({ description: "State indicates if the workflow is active or disabled" }),
  created_at: z.string().openapi({ format: "date-time" }),
  updated_at: z.string().openapi({ format: "date-time" }),
  url: z.string().openapi({ description: "URL is the API URL for this workflow" }),
  html_url: z.string().openapi({ description: "HTMLURL is the web URL for viewing the workflow" }),
  badge_url: z.string().openapi({ description: "BadgeURL is the URL for the workflow badge" }),
  deleted_at: z.string().openapi({ format: "date-time" }),
});

/** `ActionWorkflowResponse` (:83-86). */
export const actionWorkflowListSchema = z.object({
  workflows: z.array(actionWorkflowSchema),
  total_count: z.number().int().openapi({ format: "int64" }),
});

/**
 * The canonical User/Repository wire renders (apiUserFromRow/toApiRepository)
 * nested into the run wire. Declared `unknown` — the response CODES are what
 * the contract check reads; the payload shapes are the shared serializers'
 * output, exercised byte-for-byte by the tests.
 */
const userWire = z.unknown();
const repositoryWire = z.unknown();

/** `PullRequestMinimalHeadRepo` (:129-133). */
const prMinimalHeadRepoSchema = z.object({
  id: z.number().int().openapi({ format: "int64" }),
  url: z.string(),
  name: z.string(),
});

/** `PullRequestMinimalHead` (:123-127). */
const prMinimalHeadSchema = z.object({
  ref: z.string(),
  sha: z.string(),
  repo: prMinimalHeadRepoSchema,
});

/** `PullRequestMinimal` (:115-121). */
const prMinimalSchema = z.object({
  id: z.number().int().openapi({ format: "int64" }),
  number: z.number().int().openapi({ format: "int64" }),
  url: z.string(),
  head: prMinimalHeadSchema,
  base: prMinimalHeadSchema,
});

type PrMinimalWire = z.infer<typeof prMinimalSchema>;

/**
 * Upstream `Repository.id` is int64; the D1 registry keys repositories with
 * text ids. Numeric text ids pass through; anything else renders the
 * documented 0 (the repositoryIdNumber seam — the secrets-variables
 * module's private twin).
 */
function repoIdNumber(id: string): number {
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** `ActionWorkflowRun` (:107-148). */
export const actionWorkflowRunSchema = z.object({
  id: z.number().int().openapi({ format: "int64" }),
  url: z.string(),
  previous_attempt_url: z.string().nullable(),
  html_url: z.string(),
  jobs_url: z.string(),
  logs_url: z.string(),
  artifacts_url: z.string(),
  cancel_url: z.string(),
  rerun_url: z.string(),
  display_title: z.string(),
  path: z.string(),
  event: z.string(),
  run_attempt: z.number().int().openapi({ format: "int64" }),
  run_number: z.number().int().openapi({ format: "int64" }),
  head_sha: z.string(),
  head_branch: z.string().optional(),
  status: z.string(),
  actor: userWire.optional(),
  trigger_actor: userWire.optional(),
  repository: repositoryWire.optional(),
  conclusion: z.string().optional(),
  pull_requests: z.array(prMinimalSchema),
  created_at: z.string().openapi({ format: "date-time" }),
  updated_at: z.string().openapi({ format: "date-time" }),
  started_at: z.string().openapi({ format: "date-time" }),
  completed_at: z.string().openapi({ format: "date-time" }),
});

export type ActionWorkflowRunWire = z.infer<typeof actionWorkflowRunSchema>;

/** `ActionWorkflowRunsResponse` (:172-176) — entries key `workflow_runs`. */
export const workflowRunsListSchema = z.object({
  total_count: z.number().int().openapi({ format: "int64" }),
  workflow_runs: z.array(actionWorkflowRunSchema),
});

/** `ActionWorkflowStep` (:190-199). */
const actionWorkflowStepSchema = z.object({
  name: z.string(),
  number: z.number().int().openapi({ format: "int64" }),
  status: z.string(),
  conclusion: z.string().optional(),
  started_at: z.string().openapi({ format: "date-time" }),
  completed_at: z.string().openapi({ format: "date-time" }),
});

/** `ActionWorkflowJob` (:202-224). */
export const actionWorkflowJobSchema = z.object({
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
  runner_id: z.number().int().openapi({ format: "int64" }).optional(),
  runner_name: z.string().optional(),
  steps: z.array(actionWorkflowStepSchema),
  created_at: z.string().openapi({ format: "date-time" }),
  started_at: z.string().openapi({ format: "date-time" }),
  completed_at: z.string().openapi({ format: "date-time" }),
});

export type ActionWorkflowJobWire = z.infer<typeof actionWorkflowJobSchema>;

/** `RunDetails` (:258-262). */
export const runDetailsSchema = z.object({
  workflow_run_id: z.number().int().openapi({ format: "int64" }),
  run_url: z.string(),
  html_url: z.string(),
});

/** `CreateActionWorkflowDispatch` (:50-56) — the Go binder's Required 422s
 *  are the HANDLER's arm here (the zod schema stays permissive, the
 *  secrets-variables family's shape). */
const createActionWorkflowDispatchSchema = z.object({
  ref: z.string().optional().openapi({ description: "Required: The ref can be a branch, tag, or a commit SHA." }),
  inputs: z.record(z.string(), z.string()).optional().openapi({ description: "Inputs to the workflow (map of string to string)" }),
});

// ---------------------------------------------------------------------------
// The status mapping (convert.go:441-478 over models/actions/status.go:15-25)
// ---------------------------------------------------------------------------

const STATUS_SUCCESS = 1;
const STATUS_FAILURE = 2;
const STATUS_CANCELLED = 3;
const STATUS_SKIPPED = 4;
const STATUS_WAITING = 5;
const STATUS_RUNNING = 6;
const STATUS_BLOCKED = 7;
const STATUS_CANCELLING = 8;
const STATUS_PENDING = 9;

/** ToActionsStatus (convert.go:458-478). */
export function toActionsStatus(status: number): { action: string; conclusion: string } {
  switch (status) {
    case STATUS_WAITING:
      return { action: "queued", conclusion: "" };
    case STATUS_BLOCKED:
      return { action: "pending", conclusion: "" };
    case STATUS_PENDING:
      return { action: "requested", conclusion: "" };
    case STATUS_RUNNING:
    case STATUS_CANCELLING:
      return { action: "in_progress", conclusion: "" };
    default:
      switch (status) {
        case STATUS_SUCCESS:
          return { action: "completed", conclusion: "success" };
        case STATUS_CANCELLED:
          return { action: "completed", conclusion: "cancelled" };
        case STATUS_FAILURE:
          return { action: "completed", conclusion: "failure" };
        case STATUS_SKIPPED:
          return { action: "completed", conclusion: "skipped" };
        default:
          return { action: "completed", conclusion: "" };
      }
  }
}

/** ToRunActionsStatus (convert.go:451-456): a blocked run that still needs
 *  approval renders "waiting" with no conclusion. */
export function toRunActionsStatus(run: Pick<RunRow, "needApproval">, status: number): { action: string; conclusion: string } {
  if (status === STATUS_BLOCKED && run.needApproval) {
    return { action: "waiting", conclusion: "" };
  }
  return toActionsStatus(status);
}

// ---------------------------------------------------------------------------
// The workflow-tree reader (ListWorkflows over the engine's one-level listTree)
// ---------------------------------------------------------------------------

/** setting.Actions.WorkflowDirs' default (actions.go:52 — the runs-list/
 *  workflow-file UI modules' twin constant). */
const WORKFLOW_DIRS = [".gitea/workflows", ".github/workflows"];

interface WorkflowEntry {
  dir: string;
  name: string;
}

/**
 * listWorkflowsInDirs (workflows.go:75-95) at one commit: the .yml/.yaml
 * blobs of the FIRST existing workflow dir. `null` = no dir exists (the
 * `("", nil, nil)` arm — the LIST answers 200/0; the single-workflow lookup
 * answers the 404).
 */
async function listWorkflowEntries(
  reads: Pick<ReturnType<typeof engineReads>, "listTree">,
  commitOid: string,
): Promise<WorkflowEntry[] | null> {
  for (const dir of WORKFLOW_DIRS) {
    const tree = await reads.listTree(commitOid, dir);
    if (tree !== null) {
      const entries: WorkflowEntry[] = [];
      for (const entry of tree.entries) {
        if (entry.type !== "blob") continue;
        if (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml")) continue;
        entries.push({ dir, name: entry.name });
      }
      return entries;
    }
  }
  return null;
}

/** The workflow-id's last segment (the store's path-spelled-id tolerance —
 *  the repo-actions-workflow module's divergence note). */
function baseSegment(id: string): string {
  const at = id.lastIndexOf("/");
  return at < 0 ? id : id.slice(at + 1);
}

// ---------------------------------------------------------------------------
// URL builders (repo.APIURL/HTMLURL — models/repo/repo.go:344-365)
// ---------------------------------------------------------------------------

function repoHtmlUrl(origin: string, pair: RepositoryWithOwner): string {
  return `${origin}/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}`;
}

function repoApiUrl(origin: string, pair: RepositoryWithOwner): string {
  return `${origin}/api/v1/repos/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}`;
}

/** util.PathEscapeSegments (modules/util/path.go): escape each '/'-component,
 *  keep the separators — the workflow-dir paths stay path-shaped. */
function escapeSegment(segment: string): string {
  return segment
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

/**
 * getActionWorkflowEntry (convert.go:593-651): the workflow wire over one
 * tree entry. `commitAuthorWhen` is the AUTHOR time of the listing commit
 * (convert.go:616-622's documented "timestamp of the latest commit" arm);
 * the yaml name is read when the content parses.
 */
export function workflowWire(input: {
  origin: string;
  pair: RepositoryWithOwner;
  defaultBranch: string;
  entry: WorkflowEntry;
  commitAuthorWhen: Date;
  content: string | null;
  disabledWorkflows: readonly string[];
}): z.infer<typeof actionWorkflowSchema> {
  const { origin, pair, defaultBranch, entry, commitAuthorWhen, content, disabledWorkflows } = input;
  const htmlUrl = repoHtmlUrl(origin, pair);
  const apiUrl = repoApiUrl(origin, pair);

  let name = entry.name;
  if (content !== null) {
    try {
      const parsed: unknown = yamlParse(content);
      if (parsed !== null && typeof parsed === "object" && parsed instanceof Map === false) {
        const record = parsed as Record<string, unknown>;
        // Only use the name when specified in the workflow file
        // (convert.go:629-632 — non-empty string).
        if (typeof record.name === "string" && record.name !== "") {
          name = record.name;
        }
      }
    } catch {
      // the parse-fail log arm (convert.go:633-635) — the file name stays
    }
  }

  const state = disabledWorkflows.includes(entry.name) ? "disabled_manually" : "active";
  const when = commitAuthorWhen.toISOString();
  return {
    id: entry.name,
    name,
    path: `${entry.dir}/${entry.name}`,
    state,
    created_at: when,
    updated_at: when,
    url: `${apiUrl}/actions/workflows/${escapeSegment(entry.name)}`,
    html_url: `${htmlUrl}/src/branch/${escapeSegment(defaultBranch)}/${escapeSegment(entry.dir)}/${escapeSegment(entry.name)}`,
    badge_url: `${htmlUrl}/actions/workflows/${escapeSegment(entry.name)}/badge.svg?branch=${encodeURIComponent(defaultBranch)}`,
    deleted_at: GO_ZERO_TIME,
  };
}

/** The default-branch tip + its workflow entries — the read both the single
 *  lookup and the listing share. `null` commit = the GetBranchCommit miss
 *  (the caller's 500; an empty repo has no default branch commit). */
interface DefaultBranchWorkflows {
  commitOid: string;
  authorWhen: Date;
  entries: WorkflowEntry[] | null;
}

async function defaultBranchWorkflows(
  reads: ReturnType<typeof engineReads>,
  pair: RepositoryWithOwner,
): Promise<DefaultBranchWorkflows> {
  const commit = await reads.readCommit(pair.repo.defaultBranch);
  if (commit === null) {
    throw new Error(`ListActionWorkflows: GetBranchCommit ${pair.repo.defaultBranch} failed`);
  }
  return {
    commitOid: commit.oid,
    authorWhen: new Date(commit.author.time * 1000),
    entries: await listWorkflowEntries(reads, commit.oid),
  };
}

/**
 * GetActionWorkflow (convert.go:672-679) + getActionWorkflowFromCommit
 * (:712-724): the entry by name (entry.Name() == workflowID) with its
 * content read; `null` = the `workflow %q not found` arm.
 */
async function findWorkflowEntry(
  reads: ReturnType<typeof engineReads>,
  pair: RepositoryWithOwner,
  workflowId: string,
): Promise<{ commitOid: string; authorWhen: Date; entry: WorkflowEntry; content: string } | null> {
  const at = await defaultBranchWorkflows(reads, pair);
  const wanted = baseSegment(workflowId);
  if (at.entries === null) return null;
  for (const entry of at.entries) {
    if (entry.name !== wanted) continue;
    const blob = await reads.readBlob(at.commitOid, `${entry.dir}/${entry.name}`);
    if (blob === null) continue;
    return { commitOid: at.commitOid, authorWhen: at.authorWhen, entry, content: new TextDecoder().decode(blob.data) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The ActionWorkflowRun / ActionWorkflowJob converters
// ---------------------------------------------------------------------------

/** git.RefName.BranchName (ref.go:126-141): the refs/heads/ prefix stripped,
 *  ANYTHING ELSE renders "" (the omitempty drops head_branch). */
function branchNameOf(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
}

function isoOrNull(value: Date | null | undefined): string {
  return value === null || value === undefined ? GO_ZERO_TIME : value.toISOString();
}

/** The canonical User wire (apiUserFromRow) for a user row — the nested
 *  render both actor slots use (convert.ToUser). */
function userWireOf(row: UserRow, origin: string): unknown {
  return apiUserFromRow(row, { origin, requester: null });
}

async function userRowOrNull(d1: D1Database, userId: number): Promise<UserRow | null> {
  if (userId <= 0) return null;
  const rows = await drizzle(d1).select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

/** loadPullRequestsForRun (convert.go:351-396) over the landed tables: the
 *  pull_request-family events resolve the PR by the ref's index; push
 *  resolves open PRs on the pushed branch (GetUnmergedPullRequestsByHeadInfo's
 *  four conditions, models/issues/pull_list.go:64-70, over the
 *  pullRequests+issues join); other events render `[]`. */
async function pullRequestsForRun(
  d1: D1Database,
  run: RunRow,
  origin: string,
  baseRepoIdNumber: number,
  repoApiUrlValue: string,
): Promise<PrMinimalWire[]> {
  const db = drizzle(d1);
  const event = run.event;
  const isPrEvent = event === "pull_request" || event === "pull_request_comment";
  const isPrReviewEvent =
    event === "pull_request_review" ||
    event === "pull_request_approved" ||
    event === "pull_request_rejected" ||
    event === "pull_request_review_comment";
  const byIndex = /^refs\/pull\/(\d+)\/head$/.exec(run.ref);
  let rows: Array<typeof pullRequests.$inferSelect> = [];
  if ((isPrEvent || isPrReviewEvent) && byIndex !== null) {
    rows = await db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.baseRepoId, run.repoId), eq(pullRequests.index, Number(byIndex[1]))))
      .all();
  } else if (event === "push") {
    const branch = branchNameOf(run.ref);
    if (branch === "") return [];
    const joined = await db
      .select({ pr: pullRequests })
      .from(pullRequests)
      .innerJoin(issues, eq(issues.id, pullRequests.issueId))
      .where(
        and(
          eq(pullRequests.headRepoId, run.repoId),
          eq(pullRequests.headBranch, branch),
          eq(pullRequests.hasMerged, false),
          eq(pullRequests.flow, 1), // PullRequestFlowGithub
          eq(issues.isClosed, false),
        ),
      )
      .all();
    rows = joined.map((j) => j.pr);
  } else {
    return [];
  }

  const result: PrMinimalWire[] = [];
  for (const pr of rows) {
    const baseRepoRows = await db.select().from(repositories).where(eq(repositories.id, pr.baseRepoId)).limit(1);
    const baseRepo = baseRepoRows[0];
    const headRepoRows = await db.select().from(repositories).where(eq(repositories.id, pr.headRepoId)).limit(1);
    // headRepo nil falls back to the base repo (convert.go:406-408).
    const headRepo = headRepoRows[0] ?? baseRepo;
    if (baseRepo === undefined || headRepo === undefined) continue;
    const repoUrl = (repo: typeof baseRepo) =>
      `${origin}/api/v1/repos/${encodeURIComponent(repo.ownerNamespace)}/${encodeURIComponent(repo.slug)}`;
    result.push({
      id: pr.id,
      number: pr.index,
      url: `${repoApiUrlValue}/pulls/${pr.index}`,
      head: {
        ref: pr.headBranch,
        sha: pr.headSha ?? run.commitSha,
        repo: { id: repoIdNumber(headRepo.id), url: repoUrl(headRepo), name: headRepo.slug },
      },
      base: {
        ref: pr.baseBranch,
        sha: pr.mergeBase ?? "",
        repo: { id: baseRepoIdNumber, url: repoUrl(baseRepo), name: baseRepo.slug },
      },
    });
  }
  return result;
}

/** The run wire over one row (+ its latest attempt), ToActionWorkflowRun
 *  (convert.go:276-348). */
export async function actionWorkflowRunWire(input: {
  d1: D1Database;
  origin: string;
  pair: RepositoryWithOwner;
  run: RunRow;
  attempt: typeof actionRunAttempts.$inferSelect | null;
  excludePullRequests: boolean;
}): Promise<ActionWorkflowRunWire> {
  const { d1, origin, pair, run, attempt, excludePullRequests } = input;
  const apiUrl = repoApiUrl(origin, pair);
  const runUrl = `${apiUrl}/actions/runs/${run.id}`;

  let runAttempt = 0;
  let status = run.status;
  let startedAt = isoOrNull(run.started);
  let completedAt = isoOrNull(run.stopped);
  let triggerUserId = run.triggerUserId;
  let previousAttemptUrl: string | null = null;
  if (attempt !== null) {
    runAttempt = attempt.attempt;
    status = attempt.status;
    startedAt = isoOrNull(attempt.started);
    completedAt = isoOrNull(attempt.stopped);
    triggerUserId = attempt.triggerUserId;
    if (attempt.attempt > 1) {
      previousAttemptUrl = `${runUrl}/attempts/${attempt.attempt - 1}`;
    }
  }
  const { action, conclusion } = toRunActionsStatus(run, status);

  const pullRequestsValue: PrMinimalWire[] = excludePullRequests
    ? []
    : await pullRequestsForRun(d1, run, origin, repoIdNumber(pair.repo.id), apiUrl);

  const actorRow = await userRowOrNull(d1, run.triggerUserId);
  const triggerRow = triggerUserId === run.triggerUserId ? actorRow : await userRowOrNull(d1, triggerUserId);
  const actor = actorRow === null ? undefined : userWireOf(actorRow, origin);
  const triggerActor = triggerRow === null ? undefined : userWireOf(triggerRow, origin);

  const settings = await loadRepoSettings(d1, pair.repo.id);
  const repository = toApiRepository({ origin, requester: null }, pair, settings);

  const headBranch = branchNameOf(run.ref);
  return {
    id: run.id,
    url: runUrl,
    previous_attempt_url: previousAttemptUrl,
    html_url: `${repoHtmlUrl(origin, pair)}/actions/runs/${run.id}`,
    jobs_url: `${runUrl}/jobs`,
    logs_url: `${runUrl}/logs`,
    artifacts_url: `${runUrl}/artifacts`,
    cancel_url: `${runUrl}/cancel`,
    rerun_url: `${runUrl}/rerun`,
    display_title: run.title,
    path: `${run.workflowId}@${run.ref}`,
    event: run.event,
    run_attempt: runAttempt,
    run_number: run.index,
    head_sha: run.commitSha,
    ...(headBranch !== "" ? { head_branch: headBranch } : {}),
    status: action,
    ...(actor !== undefined ? { actor } : {}),
    ...(triggerActor !== undefined ? { trigger_actor: triggerActor } : {}),
    repository,
    ...(conclusion !== "" ? { conclusion } : {}),
    pull_requests: pullRequestsValue,
    created_at: run.created.toISOString(),
    updated_at: run.updated.toISOString(),
    started_at: startedAt,
    completed_at: completedAt,
  };
}

// ---------------------------------------------------------------------------
// The shared resolution seams
// ---------------------------------------------------------------------------

async function latestAttemptOf(d1: D1Database, run: RunRow): Promise<typeof actionRunAttempts.$inferSelect | null> {
  if (run.latestAttemptId <= 0) return null;
  const rows = await drizzle(d1).select().from(actionRunAttempts).where(eq(actionRunAttempts.id, run.latestAttemptId)).limit(1);
  return rows[0] ?? null;
}

/** The URL's id segment → the row id (digits parse; junk → 0 — the
 *  PathParamInt64 convention, base_path.go:35-38; 0 misses the lookup). */
function parsePathId(raw: string): number {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
}

/** convertToInternal (shared/action.go:100-123) — the query `status` values
 *  to the store's enum set; `null` = the invalid-argument 400 arm. */
export function statusFilterToInternal(status: string): number[] | null {
  switch (status) {
    case "pending":
    case "waiting":
    case "requested":
    case "action_required":
      return [STATUS_BLOCKED, STATUS_PENDING];
    case "queued":
      return [STATUS_WAITING];
    case "in_progress":
      return [STATUS_RUNNING];
    case "completed":
      return [STATUS_SUCCESS, STATUS_FAILURE, STATUS_SKIPPED, STATUS_CANCELLED];
    case "failure":
      return [STATUS_FAILURE];
    case "success":
      return [STATUS_SUCCESS];
    case "skipped":
    case "neutral":
      return [STATUS_SKIPPED];
    case "cancelled":
    case "timed_out":
      return [STATUS_CANCELLED];
    default:
      return null;
  }
}

/** FormOptionalBool's spelling of the query booleans (base_form.go:71-79):
 *  exactly "true" parses true; every other spelling parses FALSE upstream's
 *  own way — except absent (undefined = no flag). */
function formBool(url: URL, key: string): boolean {
  return url.searchParams.get(key) === "true";
}

// ---------------------------------------------------------------------------
// The dispatch service (DispatchActionWorkflow, workflow.go:64-190, M3-free)
// ---------------------------------------------------------------------------

export type DispatchOutcome =
  | { outcome: "not-found"; message: string }
  | { outcome: "forbidden"; message: string }
  | { outcome: "invalid"; message: string }
  | { outcome: "dispatched"; runId: number };

interface ParsedDispatchInput {
  name: string;
  description: string;
  required: boolean;
  default: string;
  type: string;
}

interface DispatchWorkflowParse {
  name: string;
  dispatchInputs: ParsedDispatchInput[];
  jobs: Array<{ jobId: string; name: string; needs: string[]; runsOn: string[]; payload: string }>;
}

/** The `_invalid:`-tagged throw — the yaml/structure failures surface as the
 *  422 invalid-workflow arm (the caller strips the tag). */
class InvalidWorkflowError extends Error {}

function asMap(value: unknown): Map<unknown, unknown> | null {
  return value instanceof Map ? value : null;
}

/**
 * The M3-free workflow read (the dispatch-inputs UI module's light check):
 * the workflow name, the workflow_dispatch inputs (declaration order) and
 * the raw job mappings (re-dumped single-job payloads). Throws
 * InvalidWorkflowError for an unparseable document, a non-mapping root or a
 * `jobs:` that is not a mapping.
 */
export function parseDispatchWorkflow(content: string): DispatchWorkflowParse {
  let parsed: unknown;
  try {
    // mapAsMap: input names keep DECLARATION order (the dispatch-inputs
    // module's note); merge keys resolve by the parser.
    parsed = yamlParse(content, { mapAsMap: true });
  } catch (error) {
    throw new InvalidWorkflowError(error instanceof Error ? error.message : String(error));
  }
  const root = asMap(parsed);
  if (root === null) {
    throw new InvalidWorkflowError("not a mapping");
  }
  const workflowName = typeof root.get("name") === "string" ? (root.get("name") as string) : "";

  const jobsNode = asMap(root.get("jobs"));
  if (jobsNode === null) {
    throw new InvalidWorkflowError("jobs is not a mapping");
  }

  const jobs: DispatchWorkflowParse["jobs"] = [];
  for (const [jobKey, jobValue] of jobsNode) {
    if (typeof jobKey !== "string") continue;
    const jobMap = asMap(jobValue);
    if (jobMap === null) continue;
    const rawNeeds = jobMap.get("needs");
    const needs = typeof rawNeeds === "string" ? [rawNeeds] : Array.isArray(rawNeeds) ? rawNeeds.map(String) : [];
    const rawRunsOn = jobMap.get("runs-on");
    const runsOn = typeof rawRunsOn === "string" ? [rawRunsOn] : Array.isArray(rawRunsOn) ? rawRunsOn.map(String) : [];
    const rawName = jobMap.get("name");
    jobs.push({
      jobId: jobKey,
      name: typeof rawName === "string" && rawName !== "" ? rawName : jobKey,
      needs,
      runsOn,
      // The staged single-job payload (the module header's reduction): the
      // raw job mapping re-dumped under its key — the real jobparser
      // transform is M3.
      payload: yamlStringify({ name: workflowName, jobs: { [jobKey]: jobMap } }),
    });
  }

  // WorkflowDispatchConfig (actionslib model/workflow.go:139-178): the `on:`
  // mapping's workflow_dispatch entry, its inputs in DECLARATION order. A
  // workflow without the trigger parses fine — the CALLER answers the
  // has-no-workflow_dispatch 422 (workflow.go:141-146).
  const dispatchInputs: ParsedDispatchInput[] = [];
  const on: unknown = root.get("on");
  let entry: unknown = null;
  let hasTrigger = false;
  if (Array.isArray(on)) {
    hasTrigger = on.includes("workflow_dispatch");
  } else if (typeof on === "string") {
    hasTrigger = on === "workflow_dispatch";
  } else {
    const onMap = asMap(on);
    if (onMap !== null && onMap.get("workflow_dispatch") !== undefined) {
      hasTrigger = true;
      entry = onMap.get("workflow_dispatch");
    }
  }
  if (hasTrigger && entry !== null && entry !== undefined) {
    const entryMap = asMap(entry);
    if (entryMap !== null) {
      const inputsNode = asMap(entryMap.get("inputs"));
      if (inputsNode !== null) {
        for (const [inputName, raw] of inputsNode) {
          if (typeof inputName !== "string") continue;
          const inputMap = asMap(raw);
          dispatchInputs.push({
            name: inputName,
            description: inputMap !== null && typeof inputMap.get("description") === "string" ? (inputMap.get("description") as string) : "",
            required: inputMap !== null && inputMap.get("required") === true,
            default: inputMap !== null && typeof inputMap.get("default") === "string" ? (inputMap.get("default") as string) : "",
            type: inputMap !== null && typeof inputMap.get("type") === "string" ? (inputMap.get("type") as string) : "",
          });
        }
      }
    }
  }
  return { name: workflowName, dispatchInputs: hasTrigger ? dispatchInputs : [], jobs };
}

/** ParseYamlBool (modules/util/util.go:25-27). */
function parseYamlBool(s: string): boolean {
  return s === "true" || s === "True" || s === "TRUE";
}

/** coerceDispatchInputTypes (workflow.go:192-198): the boolean-typed inputs
 *  parse their string values (the event payload carries real booleans). */
function coerceDispatchInputTypes(dispatchInputs: readonly ParsedDispatchInput[], inputs: Map<string, unknown>): void {
  for (const cfg of dispatchInputs) {
    if (cfg.type !== "boolean") continue;
    const value = inputs.get(cfg.name);
    if (typeof value === "string") {
      inputs.set(cfg.name, parseYamlBool(value));
    }
  }
}

/** dispatchEventInputs (workflow.go:210-216): exprparser.CoerceToString's
 *  scalar arms — booleans render lowercase, numbers plain, strings as-is. */
function dispatchEventInputs(inputs: Map<string, unknown>): Record<string, string> {
  const eventInputs: Record<string, string> = {};
  for (const [name, value] of inputs) {
    if (typeof value === "boolean") eventInputs[name] = value ? "true" : "false";
    else eventInputs[name] = String(value);
  }
  return eventInputs;
}

/**
 * DispatchActionWorkflow (workflow.go:64-190) — the M3-free port: the
 * disabled check, the ref resolution, the workflow-content read, the light
 * validation, the dispatch-config gate, the inputs merge and the
 * insertActionRun insert. The caller resolved the repo row + gates.
 */
export async function dispatchActionWorkflow(input: {
  d1: D1Database;
  reads: ReturnType<typeof engineReads>;
  origin: string;
  pair: RepositoryWithOwner;
  doerId: number;
  workflowId: string;
  ref: string;
  scopedWorkflowSourceRepoId: number;
  bodyInputs: Record<string, string> | undefined;
}): Promise<DispatchOutcome> {
  const { d1, reads, origin, pair, doerId, workflowId, ref, scopedWorkflowSourceRepoId, bodyInputs } = input;
  if (workflowId === "") {
    return { outcome: "not-found", message: `workflow "${workflowId}" not found` };
  }
  if (ref === "") {
    return { outcome: "not-found", message: `ref "${ref}" doesn't exist` };
  }
  if (scopedWorkflowSourceRepoId > 0) {
    // The scoped arm's source walk is C10/post-M3 (the module header's
    // reduction) — the not-found answer the dispatch-inputs module records.
    return { outcome: "not-found", message: `workflow "${workflowId}" not found` };
  }

  // The disabled check runs FIRST (workflow.go:83-98) — against the request
  // id exactly as upstream compares cfg.DisabledWorkflows entries.
  const cfg = await loadRepoActionsConfig(d1, pair.repo.id);
  if (cfg.disabledWorkflows.includes(workflowId)) {
    return { outcome: "forbidden", message: "workflow is disabled" };
  }

  // The ref resolution (workflow.go:101-120): refs/tags/* → tag,
  // refs/heads/* → branch, anything else AS A BRANCH — a bare name that
  // only exists as a tag misses (upstream's own spoof test: ref "spoof"
  // against refs/tags/refs/heads/spoof answers 404,
  // actions_trigger_test.go:989-999). Tags dispatch by their FULL ref.
  let refName: string;
  if (ref.startsWith("refs/tags/") || ref.startsWith("refs/heads/")) {
    refName = ref;
  } else {
    refName = `refs/heads/${ref}`;
  }
  const refs = await reads.listRefs();
  const tips = new Map<string, string>();
  if (refs !== null) {
    for (const r of refs.refs) tips.set(r.name, r.target);
  }
  const commitSha = tips.get(refName);
  if (commitSha === undefined) {
    return { outcome: "not-found", message: `ref "${ref}" doesn't exist` };
  }
  const runTargetCommit = await reads.readCommit(commitSha);
  if (runTargetCommit === null) {
    return { outcome: "not-found", message: `ref "${ref}" doesn't exist` };
  }

  // resolveDispatchWorkflowContent (repo-level arm, workflow.go:222+): the
  // workflow file at the TARGET commit; a miss is the not-found arm.
  const entries = await listWorkflowEntries(reads, runTargetCommit.oid);
  const wanted = baseSegment(workflowId);
  const entry = entries?.find((e) => e.name === wanted);
  if (entry === undefined) {
    return { outcome: "not-found", message: `workflow "${workflowId}" not found` };
  }
  const blob = await reads.readBlob(runTargetCommit.oid, `${entry.dir}/${entry.name}`);
  if (blob === null) {
    return { outcome: "not-found", message: `workflow "${workflowId}" not found` };
  }
  const content = new TextDecoder().decode(blob.data);

  // ValidateWorkflowStatic + ReadWorkflow (workflow.go:127-140) — the light
  // YAML check; then the dispatch-config gate (workflow.go:141-146).
  let parsed: DispatchWorkflowParse;
  try {
    parsed = parseDispatchWorkflow(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { outcome: "invalid", message: `invalid workflow "${workflowId}": ${detail}` };
  }
  if (parsed.dispatchInputs.length === 0 && !workflowHasDispatchTrigger(content)) {
    return {
      outcome: "invalid",
      message: `workflow "${workflowId}" has no workflow_dispatch event trigger`,
    };
  }

  // The inputs merge (the handler's processInputs closure, action.go:1154-1163
  // — the JSON arm): provided values, else the declared defaults.
  const inputsWithDefaults = new Map<string, unknown>();
  for (const cfgInput of parsed.dispatchInputs) {
    const provided = bodyInputs?.[cfgInput.name];
    inputsWithDefaults.set(cfgInput.name, provided !== undefined ? provided : cfgInput.default);
  }
  coerceDispatchInputTypes(parsed.dispatchInputs, inputsWithDefaults);

  // The run row (workflow.go:122-125): title = the commit's message title,
  // event/triggerEvent workflow_dispatch, status waiting; index = the
  // M3-free max+1 (the module header's reduction).
  const db = drizzle(d1);
  const indexRows = await db
    .select({ maxIndex: actionRuns.index })
    .from(actionRuns)
    .where(eq(actionRuns.repoId, pair.repo.id))
    .orderBy(desc(actionRuns.index))
    .limit(1);
  const nextIndex = (indexRows[0]?.maxIndex ?? 0) + 1;

  const settings = await loadRepoSettings(d1, pair.repo.id);
  const senderRow = await userRowOrNull(d1, doerId);
  const eventPayload = JSON.stringify({
    workflow: workflowId,
    ref,
    repository: toApiRepository({ origin, requester: null }, pair, settings),
    inputs: dispatchEventInputs(inputsWithDefaults),
    sender: senderRow === null ? null : apiUserFromRow(senderRow, { origin, requester: null }),
  });

  const { run } = await insertActionRun(
    d1,
    {
      repoId: pair.repo.id,
      // repo.OwnerID — the owner row's id (the repositories.ownerId column
      // is nullable; the resolved owner row is not).
      ownerId: pair.owner.id,
      workflowId,
      index: nextIndex,
      triggerUserId: doerId,
      ref: refName,
      commitSha: runTargetCommit.oid,
      event: "workflow_dispatch",
      eventPayload,
      triggerEvent: "workflow_dispatch",
      title: runTargetCommit.subject,
    },
    parsed.jobs.map((job) => ({
      jobId: job.jobId,
      name: job.name,
      needs: job.needs,
      runsOn: job.runsOn,
      workflowPayload: new TextEncoder().encode(job.payload),
    })),
  );

  return { outcome: "dispatched", runId: run.id };
}

/** The raw `on:` scan the dispatch-config gate uses (the parsed inputs are
 *  keyed on the trigger's presence — the gate answers when the workflow
 *  parses but declares no workflow_dispatch trigger at all). */
function workflowHasDispatchTrigger(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = yamlParse(content, { mapAsMap: true });
  } catch {
    return false; // already answered as invalid
  }
  if (parsed === null || typeof parsed !== "object" || parsed instanceof Map === false) return false;
  const root = parsed as Map<string, unknown>;
  const on = root.get("on");
  if (Array.isArray(on)) return on.includes("workflow_dispatch");
  if (typeof on === "string") return on === "workflow_dispatch";
  if (on instanceof Map) return on.get("workflow_dispatch") !== undefined;
  return false;
}

// ---------------------------------------------------------------------------
// The ActionWorkflowJob converter (toActionWorkflowJob, convert.go:545-590)
// ---------------------------------------------------------------------------

async function actionWorkflowJobWire(input: {
  d1: D1Database;
  origin: string;
  pair: RepositoryWithOwner;
  run: RunRow;
  job: RunJobRow;
}): Promise<ActionWorkflowJobWire> {
  const { d1, origin, pair, run, job } = input;
  const apiUrl = repoApiUrl(origin, pair);
  const { action, conclusion } = toRunActionsStatus(run, job.status);

  let runnerId = 0;
  let runnerName = "";
  const steps: ActionWorkflowJobWire["steps"] = [];
  const taskID = job.taskId > 0 ? job.taskId : job.sourceTaskId;
  if (taskID !== 0) {
    const taskRows = await drizzle(d1).select().from(actionTasks).where(eq(actionTasks.id, taskID)).limit(1);
    const task = taskRows[0];
    if (task !== undefined) {
      runnerId = task.runnerId;
      if (runnerId > 0) {
        const runnerRows = await drizzle(d1)
          .select({ name: actionRunners.name })
          .from(actionRunners)
          .where(eq(actionRunners.id, runnerId))
          .limit(1);
        runnerName = runnerRows[0]?.name ?? "";
      }
      const stepRows = await drizzle(d1)
        .select()
        .from(actionTaskSteps)
        .where(eq(actionTaskSteps.taskId, task.id))
        .orderBy(asc(actionTaskSteps.index))
        .all();
      for (const step of stepRows) {
        const stepStatus = toActionsStatus(step.status);
        steps.push({
          name: step.name,
          number: step.index,
          status: stepStatus.action,
          ...(stepStatus.conclusion !== "" ? { conclusion: stepStatus.conclusion } : {}),
          started_at: isoOrNull(step.started),
          completed_at: isoOrNull(step.stopped),
        });
      }
    }
  }

  const headBranch = branchNameOf(run.ref);
  // runs_on is a JSON string array column — narrow by inspection (the
  // dispatch.ts idiom), never an empty-shape assertion.
  let labels: string[] = [];
  try {
    const parsed: unknown = JSON.parse(job.runsOn);
    if (Array.isArray(parsed)) labels = parsed.map(String);
  } catch {
    labels = [];
  }
  return {
    id: job.id,
    url: `${apiUrl}/actions/jobs/${job.id}`,
    html_url: `${repoHtmlUrl(origin, pair)}/actions/runs/${run.id}/jobs/${job.id}`,
    run_id: job.runId,
    run_url: `${apiUrl}/actions/runs/${job.runId}`,
    name: job.name,
    labels,
    run_attempt: job.attempt,
    head_sha: run.commitSha,
    ...(headBranch !== "" ? { head_branch: headBranch } : {}),
    status: action,
    ...(conclusion !== "" ? { conclusion } : {}),
    ...(runnerId > 0 ? { runner_id: runnerId } : {}),
    ...(runnerName !== "" ? { runner_name: runnerName } : {}),
    steps,
    created_at: job.created.toISOString(),
    started_at: isoOrNull(job.started),
    completed_at: isoOrNull(job.stopped),
  };
}

// ---------------------------------------------------------------------------
// The log bytes (the M1b store's read half — the repo-actions-logs module's
// storage arms; kept in sync by shape, no ui imports)
// ---------------------------------------------------------------------------

function sealedLogKey(logFilename: string): string {
  return `actions/logs/${logFilename}`;
}

async function readTaskLogRawBytes(
  env: ApiEnv["Bindings"],
  task: { id: number; logInStorage: boolean; logFilename: string },
): Promise<Uint8Array | null> {
  if (task.logInStorage) {
    const obj = await env.REPO_PACKS.get(sealedLogKey(task.logFilename));
    if (obj === null) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }
  const rows = await drizzle(env.DB)
    .select({ bytes: actionLogChunks.bytes })
    .from(actionLogChunks)
    .where(eq(actionLogChunks.taskId, task.id))
    .orderBy(asc(actionLogChunks.seq));
  const chunks = rows.map((r) => logBytes(r.bytes));
  const total = chunks.reduce((sum, b) => sum + b.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const b of chunks) {
    bytes.set(b, at);
    at += b.length;
  }
  return bytes;
}

/** drizzle's blob mode types the column `unknown` — narrow by inspection
 *  (the dispatch.ts/logs.ts idiom). */
function logBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("actions: blob column did not return bytes");
}

// ---------------------------------------------------------------------------
// The attachment filename (FileNameJoinFields over PathBaseStem —
// modules/util/filename.go:23-52 + path.go:32-34)
// ---------------------------------------------------------------------------

/** PathNameValidator's invalid chars (path.go:25). */
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/gi;

function pathBaseStem(s: string): string {
  const base = s.slice(s.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

function fileNameJoinFields(fields: Array<string | number>): string {
  const stemNameLimit = 210;
  const parts: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = String(fields[i]).replace(INVALID_FILENAME_CHARS, "_");
    if (i < fields.length - 1) {
      let stem = field.replaceAll(".", "_").replaceAll("-", "_");
      const estimatedRemainingLen = (fields.length - 1 - i) * 3;
      const estimatedLimit = stemNameLimit - estimatedRemainingLen;
      const currentLen = parts.join("-").length;
      if (currentLen + stem.length > estimatedLimit) {
        stem = `${stem.slice(0, Math.max(0, estimatedLimit - currentLen - 2))}__`;
      }
      parts.push(stem);
    } else {
      parts.push(field); // the extname field, unprocessed
    }
  }
  const last = parts.pop() ?? "";
  return `${parts.join("-")}${last}`;
}

function jobLogFilename(runWorkflowId: string, jobName: string, taskId: number): string {
  return fileNameJoinFields([pathBaseStem(runWorkflowId), jobName, taskId, ".log"]);
}

// ---------------------------------------------------------------------------
// The content-disposition port (content_disposition.go:25-65 — the
// attachments-serving module's shape; kept local, no src/web imports)
// ---------------------------------------------------------------------------

function getSafeName(name: string): { safe: string; encoded: boolean } {
  let safe = "";
  let encoded = false;
  for (const rune of name) {
    const code = rune.codePointAt(0) ?? 0;
    if ((code < 0x20 || code > 0x7e) && code !== 0x09) {
      encoded = true;
      safe += "_";
    } else {
      safe += rune;
    }
  }
  return { safe, encoded };
}

function formatMediaTypeFilename(t: string, filename: string): string {
  if (!filename.includes('"') && !filename.includes("\\")) {
    return `${t}; filename=${filename}`;
  }
  let quoted = "";
  for (const character of filename) {
    if (character === '"' || character === "\\") quoted += "\\";
    quoted += character;
  }
  return `${t}; filename="${quoted}"`;
}

function encodeContentDisposition(t: string, filename: string): string {
  const { safe, encoded } = getSafeName(filename);
  const result = formatMediaTypeFilename(t, safe);
  if (!encoded) {
    return result;
  }
  return result + formatMediaTypeFilename(t, filename).slice(t.length);
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

export function registerRepoActionsRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/actions/workflows (ActionsListRepositoryWorkflows)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/actions/workflows",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "List repository workflows",
      operationId: "ActionsListRepositoryWorkflows",
      request: {
        params: z.object(ownerRepoParams),
      },
      responses: {
        200: {
          description: "The workflows",
          content: { "application/json": { schema: actionWorkflowListSchema } },
        },
        403: errorResponse,
        404: notFoundResponse,
        500: errorResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireActionsReader(c, pair);
      const reads = engineReads(c.env, { ownerNamespace: pair.repo.ownerNamespace, slug: pair.repo.slug });
      const at = await defaultBranchWorkflows(reads, pair);
      const cfg = await loadRepoActionsConfig(c.env.DB, pair.repo.id);
      const origin = new URL(c.req.url).origin;
      const workflows = [];
      if (at.entries !== null) {
        for (const entry of at.entries) {
          const blob = await reads.readBlob(at.commitOid, `${entry.dir}/${entry.name}`);
          workflows.push(
            workflowWire({
              origin,
              pair,
              defaultBranch: pair.repo.defaultBranch,
              entry,
              commitAuthorWhen: at.authorWhen,
              content: blob === null ? null : new TextDecoder().decode(blob.data),
              disabledWorkflows: cfg.disabledWorkflows,
            }),
          );
        }
      }
      return c.json({ workflows, total_count: workflows.length }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/actions/workflows/{workflow_id} (ActionsGetWorkflow)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Get a workflow",
      operationId: "ActionsGetWorkflow",
      request: {
        params: z.object(workflowIdParams),
      },
      responses: {
        200: {
          description: "The workflow",
          content: { "application/json": { schema: actionWorkflowSchema } },
        },
        403: errorResponse,
        404: notFoundResponse,
        500: errorResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireActionsReader(c, pair);
      const workflowId = c.req.valid("param").workflow_id;
      const reads = engineReads(c.env, { ownerNamespace: pair.repo.ownerNamespace, slug: pair.repo.slug });
      const found = await findWorkflowEntry(reads, pair, workflowId);
      if (found === null) {
        throw new ApiError(404, `workflow "${workflowId}" not found`);
      }
      const cfg = await loadRepoActionsConfig(c.env.DB, pair.repo.id);
      const wire = workflowWire({
        origin: new URL(c.req.url).origin,
        pair,
        defaultBranch: pair.repo.defaultBranch,
        entry: found.entry,
        commitAuthorWhen: found.authorWhen,
        content: found.content,
        disabledWorkflows: cfg.disabledWorkflows,
      });
      return c.json(wire, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs
  // (ActionsListWorkflowRuns)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "List runs for a workflow",
      operationId: "ActionsListWorkflowRuns",
      request: {
        params: z.object(workflowIdParams),
        query: z.object({
          event: z.string().optional().openapi({ description: "workflow event name" }),
          branch: z.string().optional().openapi({ description: "workflow branch" }),
          status: z.string().optional().openapi({ description: "workflow status (requested, pending, queued, in_progress, failure, success, skipped)" }),
          actor: z.string().optional().openapi({ description: "triggered by user" }),
          head_sha: z.string().optional().openapi({ description: "triggering sha of the workflow run" }),
          exclude_pull_requests: z.string().optional().openapi({ description: "if true, the `pull_requests` field on each returned run is emptied" }),
          scoped_workflow_source_repo_id: z.string().optional().openapi({ description: "For a scoped workflow, the ID of the source repository providing it; omit or 0 for a repo-level workflow." }),
          // Declared strings — the QUERY wire carries text; the handler's
          // parseListOptions applies upstream's FormInt clamp semantics
          // (junk/absent → the defaults), never a 400.
          page: z.string().optional().openapi({ description: "page number of results to return (1-based)" }),
          limit: z.string().optional().openapi({ description: "page size of results" }),
        }),
      },
      responses: {
        200: {
          description: "The runs",
          content: { "application/json": { schema: workflowRunsListSchema } },
        },
        400: errorResponse,
        403: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireActionsReader(c, pair);
      const workflowId = c.req.valid("param").workflow_id;
      const url = new URL(c.req.url);

      // The status filter parses BEFORE anything else answers (shared/
      // action.go:151-156 — the invalid value is a 400 regardless of data).
      const statuses: number[] = [];
      for (const value of url.searchParams.getAll("status")) {
        const values = statusFilterToInternal(value);
        if (values === null) {
          throw new ApiError(400, `invalid status ${value}`);
        }
        statuses.push(...values);
      }

      const actorParam = url.searchParams.get("actor") ?? "";
      let triggerUserId = 0;
      if (actorParam !== "") {
        const rows = await drizzle(c.env.DB)
          .select({ id: users.id })
          .from(users)
          .where(eq(users.usernameLower, actorParam.toLowerCase()))
          .limit(1);
        const row = rows[0];
        if (row === undefined) {
          throw new ApiError(404, `user does not exist [uid: 0, name: ${actorParam}]`);
        }
        triggerUserId = row.id;
      }

      // The scoped filter (action.go:1003-1004 + shared/action.go:139-142):
      // a non-zero source id selects scoped runs; 0/absent is repo-level.
      const scopedRaw = url.searchParams.get("scoped_workflow_source_repo_id") ?? "0";
      const scopedId = /^\d+$/.test(scopedRaw) ? Number.parseInt(scopedRaw, 10) : 0;

      // The store id match: upstream compares `workflow_id = ?` exactly; the
      // landed producers wrote PATH-spelled ids (the repo-actions-workflow
      // module's divergence note) — both spellings match, upstream's bare
      // name stays the primary arm.
      const storeId = baseSegment(workflowId);
      const workflowMatch = or(eq(actionRuns.workflowId, storeId), like(actionRuns.workflowId, `%/${storeId}`));

      // The existence probe (action.go:1009-1032): existing runs prove the
      // workflow valid — historical files list without a git lookup; a
      // never-run repo-level workflow falls back to the tree walk.
      const db = drizzle(c.env.DB);
      const probe = await db
        .select({ id: actionRuns.id })
        .from(actionRuns)
        .where(and(eq(actionRuns.repoId, pair.repo.id), workflowMatch, eq(actionRuns.isScopedRun, scopedId > 0)))
        .limit(1);
      if (probe[0] === undefined && scopedId === 0) {
        const reads = engineReads(c.env, { ownerNamespace: pair.repo.ownerNamespace, slug: pair.repo.slug });
        const found = await findWorkflowEntry(reads, pair, workflowId);
        if (found === null) {
          throw new ApiError(404, `workflow "${workflowId}" not found`);
        }
      }

      // shared.ListRuns (shared/action.go:131-228) at (0, repoID, workflowID)
      // — the filters over the landed columns; repo-scoped order is
      // `index DESC` (run_list.go:142-149).
      const conditions = [eq(actionRuns.repoId, pair.repo.id), workflowMatch, eq(actionRuns.isScopedRun, scopedId > 0)];
      const eventParam = url.searchParams.get("event") ?? "";
      if (eventParam !== "") conditions.push(eq(actionRuns.triggerEvent, eventParam));
      const branchParam = url.searchParams.get("branch") ?? "";
      if (branchParam !== "") conditions.push(eq(actionRuns.ref, `refs/heads/${branchParam}`));
      if (statuses.length > 0) conditions.push(inArray(actionRuns.status, statuses));
      if (triggerUserId > 0) conditions.push(eq(actionRuns.triggerUserId, triggerUserId));
      const headShaParam = url.searchParams.get("head_sha") ?? "";
      if (headShaParam !== "") conditions.push(eq(actionRuns.commitSha, headShaParam));

      const opts = parseListOptions(url);
      const where = and(...conditions);
      const [rows, totals] = await Promise.all([
        db
          .select()
          .from(actionRuns)
          .where(where)
          .orderBy(desc(actionRuns.index))
          .limit(opts.limit)
          .offset((opts.page - 1) * opts.limit)
          .all(),
        db.select({ value: count() }).from(actionRuns).where(where).all(),
      ]);
      const total = Number(totals[0]?.value ?? 0);

      const excludePullRequests = formBool(url, "exclude_pull_requests");
      const origin = new URL(c.req.url).origin;
      const entries = await Promise.all(
        rows.map(async (run) =>
          actionWorkflowRunWire({
            d1: c.env.DB,
            origin,
            pair,
            run,
            attempt: await latestAttemptOf(c.env.DB, run),
            excludePullRequests,
          }),
        ),
      );
      setPaginationHeaders(c, total, opts);
      return c.json({ total_count: total, workflow_runs: entries }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable
  // (ActionsDisableWorkflow) — the LANDED ActionsConfig store
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "put",
      path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Disable a workflow",
      operationId: "ActionsDisableWorkflow",
      request: {
        params: z.object(workflowIdParams),
      },
      responses: {
        204: { description: "No Content" },
        403: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireActionsWriter(c, pair);
      const workflowId = c.req.valid("param").workflow_id;
      const reads = engineReads(c.env, { ownerNamespace: pair.repo.ownerNamespace, slug: pair.repo.slug });
      // EnableOrDisableWorkflow (workflow.go:30-35): the workflow lookup
      // first — a miss is the 404.
      const found = await findWorkflowEntry(reads, pair, workflowId);
      if (found === null) {
        throw new ApiError(404, `workflow "${workflowId}" not found`);
      }
      const cfg = await loadRepoActionsConfig(c.env.DB, pair.repo.id);
      // DisableWorkflow (repo_unit_actions.go:103-109) — append-if-absent.
      if (!cfg.disabledWorkflows.includes(found.entry.name)) {
        cfg.disabledWorkflows = [...cfg.disabledWorkflows, found.entry.name];
      }
      const saved = await saveRepoActionsConfig(c.env.DB, pair.repo.id, cfg);
      if (saved === "missing") {
        throw new Error("ActionsDisableWorkflow: UpdateRepoUnitConfig missed the actions unit row");
      }
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable
  // (ActionsEnableWorkflow)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "put",
      path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Enable a workflow",
      operationId: "ActionsEnableWorkflow",
      request: {
        params: z.object(workflowIdParams),
      },
      responses: {
        204: { description: "No Content" },
        403: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireActionsWriter(c, pair);
      const workflowId = c.req.valid("param").workflow_id;
      const reads = engineReads(c.env, { ownerNamespace: pair.repo.ownerNamespace, slug: pair.repo.slug });
      const found = await findWorkflowEntry(reads, pair, workflowId);
      if (found === null) {
        throw new ApiError(404, `workflow "${workflowId}" not found`);
      }
      const cfg = await loadRepoActionsConfig(c.env.DB, pair.repo.id);
      // EnableWorkflow (repo_unit_actions.go:95-97) — SliceRemoveAll.
      cfg.disabledWorkflows = cfg.disabledWorkflows.filter((name) => name !== found.entry.name);
      const saved = await saveRepoActionsConfig(c.env.DB, pair.repo.id, cfg);
      if (saved === "missing") {
        throw new Error("ActionsEnableWorkflow: UpdateRepoUnitConfig missed the actions unit row");
      }
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
  // (ActionsDispatchWorkflow)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Create a workflow dispatch event",
      operationId: "ActionsDispatchWorkflow",
      request: {
        params: z.object(workflowIdParams),
        query: z.object({
          return_run_details: z.string().optional().openapi({ description: "Whether the response should include the workflow run ID and URLs." }),
          scoped_workflow_source_repo_id: z.string().optional().openapi({ description: "For a scoped workflow, the ID of the source repository providing it; omit or 0 for a repo-level workflow." }),
        }),
        body: {
          content: { "application/json": { schema: createActionWorkflowDispatchSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "The run details (return_run_details=true)",
          content: { "application/json": { schema: runDetailsSchema } },
        },
        204: { description: "No Content, if return_run_details is missing or false" },
        403: errorResponse,
        404: notFoundResponse,
        422: { description: "validationError", content: { "application/json": { schema: apiErrorSchema } } },
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireActionsWriter(c, pair);
      const workflowId = c.req.valid("param").workflow_id;
      const opt = c.req.valid("json");
      // The Go binder's Required 422 (api.go:838-847 — "<Field>: Required",
      // the secrets family's pin shape); the handler's own empty-ref arm is
      // the same code (the module header's note).
      if (opt.ref === undefined || opt.ref === "") {
        throw new ApiError(422, "Ref: Required");
      }
      const url = new URL(c.req.url);
      const scopedRaw = url.searchParams.get("scoped_workflow_source_repo_id") ?? "0";
      const scopedId = /^\d+$/.test(scopedRaw) ? Number.parseInt(scopedRaw, 10) : 0;

      const viewer = viewerOf(c);
      const outcome = await dispatchActionWorkflow({
        d1: c.env.DB,
        reads: engineReads(c.env, { ownerNamespace: pair.repo.ownerNamespace, slug: pair.repo.slug }),
        origin: viewer.origin,
        pair,
        doerId: viewer.requester?.id ?? 0,
        workflowId,
        ref: opt.ref,
        scopedWorkflowSourceRepoId: scopedId,
        bodyInputs: opt.inputs,
      });
      if (outcome.outcome === "not-found") {
        throw new ApiError(404, outcome.message);
      }
      if (outcome.outcome === "forbidden") {
        throw new ApiError(403, outcome.message);
      }
      if (outcome.outcome === "invalid") {
        throw new ApiError(422, outcome.message);
      }

      // FormBool (base_form.go): absent/false → 204 (action.go:1168-1171);
      // true → the RunDetails body (action.go:1173-1178).
      if (!formBool(url, "return_run_details")) {
        return c.body(null, 204);
      }
      return c.json(
        {
          workflow_run_id: outcome.runId,
          run_url: `${repoApiUrl(viewer.origin, pair)}/actions/runs/${outcome.runId}`,
          html_url: `${repoHtmlUrl(viewer.origin, pair)}/actions/runs/${outcome.runId}`,
        },
        200,
      );
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/actions/jobs/{job_id} (getWorkflowJob)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/actions/jobs/{job_id}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Gets a specific workflow job for a workflow run",
      operationId: "getWorkflowJob",
      request: {
        params: z.object(jobIdParams),
      },
      responses: {
        200: {
          description: "WorkflowJob",
          content: { "application/json": { schema: actionWorkflowJobSchema } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireActionsReader(c, pair);
      const jobId = parsePathId(c.req.valid("param").job_id);
      const db = drizzle(c.env.DB);
      const jobRows = await db.select().from(actionRunJobs).where(eq(actionRunJobs.id, jobId)).limit(1);
      const job = jobRows[0];
      // !has || job.RepoID != ctx.Repo.Repository.ID → APIErrorNotFound's
      // bare "not found" body (action.go:1725-1728, api.go:137-142).
      if (job === undefined || job.repoId !== pair.repo.id) {
        throw new ApiError(404, "not found");
      }
      const runRows = await db.select().from(actionRuns).where(eq(actionRuns.id, job.runId)).limit(1);
      const run = runRows[0];
      if (run === undefined) {
        throw new Error(`getWorkflowJob: job ${job.id} is missing its run`);
      }
      const origin = new URL(c.req.url).origin;
      const wire = await actionWorkflowJobWire({ d1: c.env.DB, origin, pair, run, job });
      return c.json(wire, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs
  // (downloadActionsRunJobLogs) — the LANDED DBFS log store
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Downloads the job logs for a workflow run",
      operationId: "downloadActionsRunJobLogs",
      request: {
        params: z.object(jobIdParams),
      },
      responses: {
        200: { description: "output blob content" },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireActionsReader(c, pair);
      const jobId = parsePathId(c.req.valid("param").job_id);
      const db = drizzle(c.env.DB);
      // GetRunJobByRepoAndID (run_job.go:218-228) — repo-scoped; the miss is
      // APIErrorAuto's 404 with the wrapped not-exist text.
      const jobRows = await db.select().from(actionRunJobs).where(eq(actionRunJobs.id, jobId)).limit(1);
      const job = jobRows[0];
      if (job === undefined || job.repoId !== pair.repo.id) {
        throw new ApiError(404, `run job with id ${jobId}: resource does not exist`);
      }
      // LoadRun (common/actions.go:104-106) — a missing run row is a 500.
      const runRows = await db.select().from(actionRuns).where(eq(actionRuns.id, job.runId)).limit(1);
      const run = runRows[0];
      if (run === undefined) {
        throw new Error(`DownloadActionsRunJobLogs: LoadRun ${job.runId} failed`);
      }
      // EffectiveTaskID (run_job.go:158-163): TaskID > 0 else SourceTaskID;
      // zero → "job not started" (not-exist → 404).
      const taskID = job.taskId > 0 ? job.taskId : job.sourceTaskId;
      if (taskID === 0) {
        throw new ApiError(404, "job not started");
      }
      const taskRows = await db.select().from(actionTasks).where(eq(actionTasks.id, taskID)).limit(1);
      const task = taskRows[0];
      if (task === undefined) {
        throw new ApiError(404, `GetTaskByID: task with id ${taskID}: resource does not exist`);
      }
      if (task.logExpired) {
        throw new ApiError(404, "logs have been cleaned up");
      }
      const bytes = await readTaskLogRawBytes(c.env, task);
      if (bytes === null) {
        throw new Error(`DownloadActionsRunJobLogs: unable to open task logs: ${task.logFilename}`);
      }
      const filename = jobLogFilename(run.workflowId, job.name, task.id);
      const base = filename.slice(filename.lastIndexOf("/") + 1);
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-length": String(bytes.length),
          "content-disposition": encodeContentDisposition("attachment", base),
          "access-control-expose-headers": "Content-Disposition",
          "cache-control": "max-age=0, private, must-revalidate",
        },
      });
    },
  );
}

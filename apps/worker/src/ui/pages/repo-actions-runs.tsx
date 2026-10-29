/**
 * The repo ACTIONS tab's RUNS LIST — the census C1 arm (docs/research/
 * actions-ui-census.md): `GET /{owner}/{repo}/actions` full page plus the
 * `?run_ids=` partial-refresh fragment the client timer polls, over the
 * M1a control-plane store. The run/job queries live beside this page per
 * the census's "page (+ data helper + tests)" ownership row;
 * services/actions/model.ts is CONSUMED read-only (the status constants).
 *
 * Upstream pin (VERIFIED at fc4936884584a41931906553d96c2601d750e6ef):
 *   - handler: routers/web/repo/actions/actions.go `List` (:86-144) over
 *     `actionRunListData` (:512-532) — prepareWorkflowList (:624-638),
 *     prepareFullPageRuns (:477-510), preparePartialRefreshRuns (:640-656),
 *     prepareCommon (:658-682: RunErrors/refresh meta/workflow names),
 *     prepareFullPageTemplate (:684-713: actors/branches/status list/cur
 *     filters), prepareOtherWorkflows (:146-171), loadIsRefDeleted (:732-758);
 *   - templates: repo/actions/list.tmpl (the shell: sidebar + filter menu +
 *     runs list + pager), runs_list.tmpl (the rows AND the fragment —
 *     `data-global-init="initActionRunsList"` +
 *     `data-action-runs-refresh-link/-interval`, rows `data-morph-whole`),
 *     sidebar.tmpl, no_workflows.tmpl, repo/icons/action_status.tmpl;
 *   - model: models/actions/run_list.go (FindRunOptions/ToConds :97-130,
 *     orders :142-153 `index DESC`, GetStatusInfoList :162-174, GetActors
 *     :214-223), run.go (Link :95, RefLink :121, PrettyRef :130, RefTooltip
 *     :141, Duration :183), run_job.go (AggregateJobStatus :642-688),
 *     utils.go (calculateDuration :73-90), status.go (the 10-value enum,
 *     IsDone :63, LocaleString :41);
 *   - route group web.go:1606-1608: `optSignIn, RepoAssignment,
 *     repo.MustBeNotEmpty, reqRepoActionsReader, actions.MustEnableActions`
 *     — the READ page needs NO sign-in (a public repo renders for
 *     anonymous, optSignIn), only the not-empty repo and the readable
 *     Actions unit (our store's `repo_settings.has_actions` reduction —
 *     the C8 gate's polarity without the settings admin arm).
 *
 * ## The status rollup (the M1a seam)
 *
 * Upstream's runs list renders the run row's own `status` column, kept in
 * sync by the notifier as jobs advance. Our M1a has no emitter yet (M3) —
 * the dispatch claim path (services/actions/dispatch.ts) mutates ONLY the
 * job rows — so the loader joins each run's latest-attempt jobs and derives
 * the displayed status through the `AggregateJobStatus` port (upstream's
 * own precedence: all-skipped → skipped, all-success-or-skipped → success,
 * cancelling > running > waiting > blocked > pending(→running) > cancelled
 * > failure). A run with no latest-attempt jobs keeps its column value.
 * The `?status=` filter applies to the ROLLED-UP status (upstream filters
 * the column in SQL — deviated here so the filter matches what the rows
 * show; revisit when M3's emitter re-syncs the column and the filter can
 * drop to the indexed `(repo_id, status)` path).
 *
 * ## Documented reductions (§6 method — every one cites its upstream arm)
 *
 * - Workflow sidebar: display names parse with the landed `yaml` package
 *   (the helm registry's import — top-level `name:` key, else the file
 *   name, WorkflowInfo.DisplayName actions.go:59-64). The full
 *   act/jobparser validation pass (ErrMsg texts, the required/`uses:`
 *   checks) is M3's dispatch arm — the sidebar's error icon rides a LIGHT
 *   check only (unparseable YAML, a non-mapping root, or a root without a
 *   `jobs:` mapping; the invalid_workflow_helper text with the parser's
 *   message).
 * - RunErrors (actions.go:534-589) ports ONLY the no-matching-online-runner
 *   arm (waiting non-caller jobs vs the repo/owner/global runners whose
 *   lastOnline is inside RunnerOfflineTime = 1 min, runner.go:76 — the
 *   upstream error text verbatim). The invalid-workflow-payload and
 *   reusable-`uses:` arms need M3's jobparser — they never fire here.
 * - The row kebab menu (runs_list.tmpl:55-73) renders nothing: all three
 *   items point at unlanded routes (the run view / workflow file is C2's,
 *   the cancel/delete POSTs are C5's) — the dead-link rule.
 * - The status-badge modal + kebab entry (list.tmpl:79-95,115-161) and the
 *   badge.svg endpoint (census C1's tail) are NOT this module — neither
 *   renders (the badge route is unlanded; the census leaves it to review).
 * - The dispatch banner (workflow_dispatch.tmpl) rides POST /actions/run —
 *   M3's producer arm; it renders nothing (census open question 4).
 * - The sidebar's Management section (job-queue link, sidebar.tmpl:54-62)
 *   renders nothing — `/actions/job_queue` is C6's route (the dead-link
 *   rule; it lands with C6).
 * - Scoped-workflow groups (sidebar.tmpl:17-34) defer with C10 (SPEC-0012
 *   keeps scoped workflows post-M3); the `scoped_workflow_source_repo_id`
 *   param parses (junk → 0 — FormInt64) and rides the filter links' shape.
 * - The workflow DISABLED red label (sidebar.tmpl:12-14) and the
 *   disable/enable kebab item (list.tmpl:88-92) ride the repo ActionsConfig
 *   store — unlanded (the census's POST /disable /enable tail); neither
 *   renders.
 * - Trigger-user ghost fallback: upstream's LoadTriggerUser re-resolves a
 *   missing user onto the Ghost row (run_list.go:38-42); ours renders the
 *   unlinked "Ghost" text (no ghost user row exists in the store).
 * - RunBranches reads the GIT refs (listRefs branch names, sorted) —
 *   upstream reads its `branch` TABLE (run_list.go:176-188) which we do not
 *   keep; the list is the same "existing branches" shape.
 * - Actors order: viewer self on top (MakeSelfOnTop), then display-name
 *   order (the GetOrderByName reduction — upstream orders by the
 *   full-name-or-name SQL case).
 * - Pager: base/paginate reduces to the landed Older/Newer shape (the
 *   admin-family precedent) over `?page=`/`?limit=` (ToCorrectPageSize:
 *   default 30, cap 50 — services/convert/utils.go:15-22 over the
 *   setting.API defaults, modules/setting/api.go:18-19).
 * - Durations render Go's time.Duration.String() shape ("45s", "1h0m0s") —
 *   the template prints the raw duration; our stamps are second-granular.
 * - The status filter list (list.tmpl:49-56) is the en-US GetStatusInfoList
 *   (8 statuses, unknown excluded — run_list.go:162-174).
 * - The RUNNING status icon renders octicon-sync + the official bundle's
 *   rotate-clockwise class: upstream's gitea-running body is stroke-based,
 *   which the extracted-path Icon cannot express (the allowlist's
 *   single-`<path d>` contract).
 * - The workflow dir walk lists the workflow dir's TOP LEVEL (the engine's
 *   one-level listTree); upstream's recursive walk descends
 *   subdirectories — the nested-workflow-file case is deferred with the
 *   per-dir fan note.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { renderToString } from "hono/jsx/dom/server";
import { parse as yamlParse } from "yaml";

import { actionRunJobs, actionRunners, actionRuns, users } from "../../db/schema";
import {
  ACTION_STATUS_BLOCKED,
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_CANCELLING,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_PENDING,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SKIPPED,
  ACTION_STATUS_SUCCESS,
  ACTION_STATUS_WAITING,
} from "../../services/actions/model";
import { TimeSince } from "../components/file-list";
import type { EngineClient } from "../engine";
import type { IconName } from "../icons";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";

/** The run rows/actions rows the loader selects (drizzle's select shape). */
type RunRow = typeof actionRuns.$inferSelect;
type RunJobRow = typeof actionRunJobs.$inferSelect;

// ---------------------------------------------------------------------------
// Status enum helpers (models/actions/status.go — the 10-value enum)
// ---------------------------------------------------------------------------

const STATUS_NAMES: Record<number, string> = {
  0: "unknown",
  [ACTION_STATUS_SUCCESS]: "success",
  [ACTION_STATUS_FAILURE]: "failure",
  [ACTION_STATUS_CANCELLED]: "cancelled",
  [ACTION_STATUS_SKIPPED]: "skipped",
  [ACTION_STATUS_WAITING]: "waiting",
  [ACTION_STATUS_RUNNING]: "running",
  [ACTION_STATUS_BLOCKED]: "blocked",
  [ACTION_STATUS_CANCELLING]: "cancelling",
  [ACTION_STATUS_PENDING]: "pending",
};

/** Status.String (status.go:32-34); an out-of-range value degrades to
 *  "unknown" (the StatusUnknown fallback). */
export function statusName(status: number): string {
  return STATUS_NAMES[status] ?? "unknown";
}

/** The en-US status display strings (actions.status.* — LocaleString). */
export const STATUS_DISPLAY: Record<string, string> = {
  unknown: "Unknown",
  waiting: "Waiting",
  running: "Running",
  success: "Success",
  failure: "Failure",
  cancelled: "Canceled",
  cancelling: "Canceling",
  skipped: "Skipped",
  blocked: "Blocked",
  pending: "Pending",
};

/** IsDone (status.go:63-65) — the four terminal statuses. */
export function isDoneStatus(status: number): boolean {
  return (
    status === ACTION_STATUS_SUCCESS ||
    status === ACTION_STATUS_FAILURE ||
    status === ACTION_STATUS_CANCELLED ||
    status === ACTION_STATUS_SKIPPED
  );
}

/**
 * AggregateJobStatus (models/actions/run_job.go:642-688) — the
 * order-independent job-status fold. The fail-fast matrix arm
 * (hasFailFastMatrixFailure) is v1-inert: our M1a carries no matrix
 * siblings (isMatrixDeferred stays false through the staged inserts), so a
 * hasCancelled+hasFailure run answers Cancelled exactly as upstream's
 * non-matrix path does.
 */
export function aggregateJobStatus(jobs: Array<Pick<RunJobRow, "status" | "continueOnError">>): number {
  if (jobs.length === 0) {
    return 0; // StatusUnknown — upstream's empty-jobs arms are all false
  }
  let allSuccessOrSkipped = true;
  let allSkipped = true;
  let hasFailure = false;
  let hasCancelled = false;
  let hasCancelling = false;
  let hasWaiting = false;
  let hasRunning = false;
  let hasBlocked = false;
  let hasPending = false;
  for (const job of jobs) {
    // A failed job with continue-on-error:true does not fail the workflow run.
    const isContinuedFailure = job.continueOnError && job.status === ACTION_STATUS_FAILURE;
    allSuccessOrSkipped =
      allSuccessOrSkipped &&
      (job.status === ACTION_STATUS_SUCCESS || job.status === ACTION_STATUS_SKIPPED || isContinuedFailure);
    allSkipped = allSkipped && job.status === ACTION_STATUS_SKIPPED;
    hasFailure = hasFailure || (job.status === ACTION_STATUS_FAILURE && !job.continueOnError);
    hasCancelled = hasCancelled || job.status === ACTION_STATUS_CANCELLED;
    hasCancelling = hasCancelling || job.status === ACTION_STATUS_CANCELLING;
    hasWaiting = hasWaiting || job.status === ACTION_STATUS_WAITING;
    hasRunning = hasRunning || job.status === ACTION_STATUS_RUNNING;
    hasBlocked = hasBlocked || job.status === ACTION_STATUS_BLOCKED;
    hasPending = hasPending || job.status === ACTION_STATUS_PENDING;
  }
  if (allSkipped) return ACTION_STATUS_SKIPPED;
  if (allSuccessOrSkipped) return ACTION_STATUS_SUCCESS;
  if (hasCancelling) return ACTION_STATUS_CANCELLING;
  if (hasRunning) return ACTION_STATUS_RUNNING;
  if (hasWaiting) return ACTION_STATUS_WAITING;
  if (hasBlocked) return ACTION_STATUS_BLOCKED;
  if (hasPending) return ACTION_STATUS_RUNNING; // only pending jobs left = still in progress
  if (hasCancelled) return ACTION_STATUS_CANCELLED;
  if (hasFailure) return ACTION_STATUS_FAILURE;
  return 0; // shouldn't happen
}

/**
 * calculateDuration (models/actions/utils.go:73-90) in seconds: a terminal
 * status with a missing/regressive `stopped` falls back to the row's
 * `updated` (when it does not predate `started`); a non-terminal status
 * measures from `started` to now (the caller passes the route clock).
 * `previousDuration` rides only legacy attempt-less runs (run.go:183-192).
 */
export function calculateDurationSeconds(
  started: number | null,
  stopped: number | null,
  status: number,
  fallbackEnd: number | null,
  nowSeconds: number,
  previousDuration = 0,
): number {
  if (started === null || started === 0) {
    return Math.max(previousDuration, 0);
  }
  let seconds: number;
  if (isDoneStatus(status)) {
    let end = stopped;
    if (end === null || end < started) {
      if (fallbackEnd !== null && fallbackEnd >= started) {
        end = fallbackEnd;
      } else {
        return 0;
      }
    }
    seconds = end - started;
  } else {
    seconds = Math.max(nowSeconds - started, 0);
  }
  return Math.max(seconds + previousDuration, 0);
}

/** Go time.Duration.String() for whole seconds ("45s", "1m0s", "1h0m0s") —
 *  the template prints the raw duration and our stamps are second-granular. */
export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(Math.max(totalSeconds, 0) / 3600);
  const m = Math.floor((Math.max(totalSeconds, 0) % 3600) / 60);
  const s = Math.max(totalSeconds, 0) % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Ref helpers (models/actions/run.go:120-147 — the RefLink/PrettyRef/
// RefTooltip arms over git.RefName)
// ---------------------------------------------------------------------------

export type RunRefKind = "branch" | "tag" | "pull" | "commit" | "other";

export function runRefKind(ref: string): RunRefKind {
  if (ref.startsWith("refs/heads/")) return "branch";
  if (ref.startsWith("refs/tags/")) return "tag";
  if (/^refs\/pull\/\d+\/(head|merge)$/.test(ref)) return "pull";
  if (/^[0-9a-f]{40}$/.test(ref)) return "commit";
  return "other";
}

/** RefName.ShortName — the typed namespaces' trailing segment. */
export function refShortName(ref: string): string {
  const kind = runRefKind(ref);
  if (kind === "branch") return ref.slice("refs/heads/".length);
  if (kind === "tag") return ref.slice("refs/tags/".length);
  if (kind === "pull") return ref.split("/")[2] ?? ref;
  return ref;
}

/** RefLink (run.go:121-127): pulls → /pulls/N, everything else →
 *  /src/{RefWebLinkPath} (branch/…, tag/…, a sha → commit/… — the /src
 *  family's suffix forms). */
export function refLinkOf(repoLink: string, ref: string): string {
  const kind = runRefKind(ref);
  if (kind === "pull") return `${repoLink}/pulls/${ref.split("/")[2]}`;
  if (kind === "branch") return `${repoLink}/src/branch/${ref.slice("refs/heads/".length)}`;
  if (kind === "tag") return `${repoLink}/src/tag/${ref.slice("refs/tags/".length)}`;
  if (kind === "commit") return `${repoLink}/src/commit/${ref}`;
  return `${repoLink}/src/${ref}`;
}

/** PrettyRef (run.go:130-138): "#N" for pull refs, else the short name. */
export function prettyRefOf(ref: string): string {
  if (runRefKind(ref) === "pull") return `#${ref.split("/")[2]}`;
  return refShortName(ref);
}

/** RefTooltip (run.go:141-147): the payload's PR title when the run was
 *  triggered by a pull-request event, else the short name. The payload
 *  parse is defensive — a malformed payload degrades to the short name. */
export function refTooltipOf(ref: string, eventPayload: string): string {
  try {
    const parsed = JSON.parse(eventPayload) as { pull_request?: { title?: string } };
    const title = parsed.pull_request?.title;
    if (typeof title === "string" && title !== "") return title;
  } catch {
    // not JSON — the short-name arm
  }
  return refShortName(ref);
}

// ---------------------------------------------------------------------------
// The query parse (prepareWorkflowList, actions.go:624-638 — Go FormInt64/
// FormInt semantics: junk/absent → 0; `page` floors at 1; ToCorrectPageSize)
// ---------------------------------------------------------------------------

/** Upstream setting.API defaults (modules/setting/api.go:18-19). */
export const ACTIONS_RUNS_PAGE_SIZE_DEFAULT = 30;
export const ACTIONS_RUNS_PAGE_SIZE_MAX = 50;

export interface ActionRunListQuery {
  workflow: string;
  scopedWorkflowSourceRepoId: number;
  actor: number;
  status: number;
  branch: string;
  page: number;
  limit: number;
  /** The `run_ids` token list — numeric tokens only (FormStringInt64s). */
  refreshRunIds: number[];
  /** `run_ids` PRESENT (even empty) — the fragment arm's discriminator
   *  (actions.go:632: `ctx.Req.Form.Has("run_ids")`). */
  partialRefresh: boolean;
}

export function parseActionRunQuery(params: URLSearchParams): ActionRunListQuery {
  const intParam = (key: string): number => {
    const raw = params.get(key) ?? "";
    if (raw === "") return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const limitRaw = intParam("limit");
  const limit = limitRaw <= 0 ? ACTIONS_RUNS_PAGE_SIZE_DEFAULT : Math.min(limitRaw, ACTIONS_RUNS_PAGE_SIZE_MAX);
  const refreshRunIds = (params.get("run_ids") ?? "")
    .split(",")
    .map((token) => Number.parseInt(token, 10))
    .filter((n) => !Number.isNaN(n));
  return {
    workflow: params.get("workflow") ?? "",
    scopedWorkflowSourceRepoId: intParam("scoped_workflow_source_repo_id"),
    actor: intParam("actor"),
    status: intParam("status"),
    branch: params.get("branch") ?? "",
    page: Math.max(intParam("page"), 1),
    limit,
    refreshRunIds,
    partialRefresh: params.has("run_ids"),
  };
}

// ---------------------------------------------------------------------------
// The workflow listing (modules/actions/workflows.go:75-115 over the engine)
// ---------------------------------------------------------------------------

/** WorkflowInfo (actions.go:46-50) reduced to the sidebar's three fields. */
export interface ActionsWorkflowInfo {
  entryName: string;
  displayName: string;
  /** The invalid_workflow_helper message — null when the file parsed. */
  errMsg: string | null;
}

const WORKFLOW_DIRS = [".gitea/workflows", ".github/workflows"]; // setting.Actions.WorkflowDirs default (actions.go:52)

/**
 * ListWorkflows over the engine: the FIRST workflow dir that exists on the
 * default branch (upstream's SubTree miss-continues), its .yml/.yaml
 * entries (the dir's top level — the recursive walk's common case; nested
 * subdirectories defer with the module-header note), each content-parsed
 * for the display name + the light validity check. An unresolvable ref or
 * a missing dir answers [] — the engine's null-on-failure ladder feeding
 * the no-workflows arm.
 */
export async function listWorkflowsFromEngine(engine: EngineClient, defaultBranch: string): Promise<ActionsWorkflowInfo[]> {
  let dir: string | null = null;
  let entries: Array<{ name: string; type: string }> = [];
  for (const candidate of WORKFLOW_DIRS) {
    const tree = await engine.listTree(defaultBranch, candidate);
    if (tree !== null) {
      dir = candidate;
      entries = tree.entries;
      break;
    }
  }
  if (dir === null) return [];
  const infos: ActionsWorkflowInfo[] = [];
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    if (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml")) continue;
    const blob = await engine.readBlob(defaultBranch, `${dir}/${entry.name}`);
    if (blob === null) {
      // An unreadable body renders under the file name with no error icon —
      // upstream's GetContentFromEntry error is a ServerError, but the
      // engine's null is the availability ladder, not a server fault.
      infos.push({ entryName: entry.name, displayName: entry.name, errMsg: null });
      continue;
    }
    infos.push(workflowInfoFromContent(entry.name, new TextDecoder().decode(blob.data)));
  }
  return infos;
}

/**
 * One workflow file's parse (actions.go:206-234's shape): the display name
 * is the top-level `name:` key, else the file name (DisplayName :59-64);
 * the light validation arm — unparseable YAML, a non-mapping root, or a
 * root without a `jobs:` mapping — carries the invalid_workflow_helper
 * text (the full jobparser pass is M3's, the module header).
 */
export function workflowInfoFromContent(entryName: string, content: string): ActionsWorkflowInfo {
  const invalid = (detail: string): ActionsWorkflowInfo => ({
    entryName,
    displayName: entryName,
    errMsg: `Workflow config file is invalid. Please check your config file: ${detail}`,
  });
  let parsed: unknown;
  try {
    parsed = yamlParse(content);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("not a mapping");
  }
  const root = parsed as Record<string, unknown>;
  if (!("jobs" in root) || root.jobs === null || typeof root.jobs !== "object" || Array.isArray(root.jobs)) {
    return invalid("jobs is not a mapping");
  }
  const name = root.name;
  return { entryName, displayName: typeof name === "string" && name !== "" ? name : entryName, errMsg: null };
}

// ---------------------------------------------------------------------------
// The loader (List's prepare* chain over M1a's store)
// ---------------------------------------------------------------------------

/** The shared actions locale chrome (upstream keys cited inline). */
export const repoActionsRunsLocale = {
  actions: "Actions", // "actions.actions" (the page Title, actions.go:87)
  all_workflows: "All Workflows", // "actions.runs.all_workflows"
  other_workflows: "Other workflows", // "actions.runs.other_workflows"
  other_workflows_tooltip:
    "Workflows that were executed in this repository but do not exist on the default branch.", // "actions.runs.other_workflows_tooltip"
  actor: "Actor", // "actions.runs.actor"
  actors_no_select: "All actors", // "actions.runs.actors_no_select"
  status: "Status", // "actions.runs.status"
  status_no_select: "All status", // "actions.runs.status_no_select"
  branch: "Branch", // "actions.runs.branch"
  branches_no_select: "All branches", // "actions.runs.branches_no_select"
  commit: "Commit", // "actions.runs.commit"
  pushed_by: "pushed by", // "actions.runs.pushed_by"
  scheduled: "Scheduled", // "actions.runs.scheduled"
  empty_commit_message: "(empty commit message)", // "actions.runs.empty_commit_message"
  no_results: "No results matched.", // "actions.runs.no_results"
  no_runs: "The workflow has no runs yet.", // "actions.runs.no_runs"
  no_workflows: "There are no workflows yet.", // "actions.runs.no_workflows"
  no_workflows_quick_start_prefix: "Don't know how to start with Gitea Actions? See", // "actions.runs.no_workflows.quick_start"
  no_workflows_quick_start_link_text: "the quick start guide", // the %s anchor's text
  no_workflows_documentation_prefix: "For more information on Gitea Actions, see", // "actions.runs.no_workflows.documentation"
  no_workflows_documentation_link_text: "the documentation", // the %s anchor's text
  workflow_runs_one: "workflow run", // "actions.runs.workflow_run_count_1"
  workflow_runs_n: "workflow runs", // "actions.runs.workflow_run_count_n"
  ghost: "Ghost", // user_model.GhostUserName
} as const;

/** The status-filter dropdown's entries (GetStatusInfoList — the 8 statuses
 *  in upstream's order, unknown excluded). */
export const STATUS_INFO_LIST: Array<{ status: number; statusName: string; displayedStatus: string }> = (
  [
    ACTION_STATUS_SUCCESS,
    ACTION_STATUS_FAILURE,
    ACTION_STATUS_CANCELLED,
    ACTION_STATUS_SKIPPED,
    ACTION_STATUS_WAITING,
    ACTION_STATUS_RUNNING,
    ACTION_STATUS_BLOCKED,
    ACTION_STATUS_CANCELLING,
  ] as const
).map((status) => ({
  status,
  statusName: statusName(status),
  displayedStatus: STATUS_DISPLAY[statusName(status)] ?? "Unknown",
}));

/** One rendered run row's data (the runs_list.tmpl row's template scope). */
export interface ActionsRunView {
  id: number;
  index: number;
  /** The stored title; empty renders empty_commit_message. */
  title: string;
  link: string;
  workflowId: string;
  status: number;
  commitSha: string;
  scheduleId: number;
  triggerUser: { username: string; displayName: string; homeLink: string } | null;
  ref: string;
  prettyRef: string;
  refLink: string;
  refTooltip: string;
  isRefDeleted: boolean;
  updatedUnix: number;
  durationText: string;
  /** The RunErrors arm's message (null = no alert icon). */
  errorMessage: string | null;
}

/** The full-page block — everything the shell needs beyond the rows
 *  (prepareOtherWorkflows + prepareFullPageTemplate); null on the fragment
 *  arm (upstream renders the fragment template without the shell's
 *  ctx.Data). */
export interface RepoActionsRunsPageBlock {
  workflows: ActionsWorkflowInfo[];
  otherWorkflows: string[];
  actors: Array<{ id: number; displayName: string; homeLink: string }>;
  runBranches: string[];
  curActor: number;
  curStatus: number;
  curBranch: string;
  curWorkflowRepoId: number;
  hasWorkflowsOrRuns: boolean;
  canWriteActions: boolean;
  canWriteCode: boolean;
}

export interface RepoActionsRunsData {
  runs: ActionsRunView[];
  isFiltered: boolean;
  workflowNames: Record<string, string>;
  curWorkflow: string;
  refreshLink: string;
  refreshIntervalMs: number;
  total: number;
  page: number;
  pageSize: number;
  more: boolean;
  pageBlock: RepoActionsRunsPageBlock | null;
}

/** The loader's inputs (the handler assembles; tests inject a fake engine). */
export interface RepoActionsRunsInput {
  d1: D1Database;
  engine: EngineClient;
  repo: RepoRow;
  query: ActionRunListQuery;
  /** `pathname + search` — the RefreshLink's base (upstream
   *  AppSubURL + RequestURI; we have no sub-url, census open question 8). */
  requestUri: string;
  canWriteActions: boolean;
  /** The route clock (seconds) — the running-duration arm + the runner
   *  freshness check; the hand-rolled-clock convention. */
  nowSeconds: number;
}

/** RunnerOfflineTime (models/actions/runner.go:76) — the online window. */
const RUNNER_OFFLINE_SECONDS = 60;

/**
 * The runs-list load — upstream `List`'s prepare chain reduced to two arms:
 *
 *  - partialRefresh: the ids' rows within THIS repo (GetRunsByRepoAndID,
 *    run.go:299-306 — the repo guard is the isolation), re-ordered in the
 *    REQUEST's id order with misses dropped (actions.go:646-655); the
 *    status filter and pagination do not apply (the client morphs exactly
 *    these rows).
 *  - full page: the SQL filters (workflow/actor/ref — ToConds :97-130),
 *    `index DESC` order (ToOrders :142-153), the rollup-then-status-filter
 *    pass (the module header's M1a seam), then the page slice; total = the
 *    filtered length.
 *
 * Both arms then run prepareCommon: the RunErrors pass (the
 * no-matching-online-runner arm), the refresh meta (interval 3s with an
 * active run else 12s; 0 with no rows), and the workflow display names —
 * the workflows ARE re-listed on the fragment (upstream's own TODO
 * complains about the same cost, actions.go:107-109 — fidelity kept).
 */
export async function loadRepoActionsRunsData(input: RepoActionsRunsInput): Promise<RepoActionsRunsData> {
  const { d1, engine, repo, query, requestUri, canWriteActions, nowSeconds } = input;
  const db = drizzle(d1);
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const isFiltered = query.actor > 0 || query.status !== 0 || query.branch !== "";

  // prepareWorkflowTemplate's arm: the default branch's workflow files.
  const workflows = await listWorkflowsFromEngine(engine, repo.defaultBranch);
  const workflowNames: Record<string, string> = {};
  for (const wf of workflows) {
    workflowNames[wf.entryName] = wf.displayName;
  }

  let runRows: RunRow[];
  if (query.partialRefresh) {
    // preparePartialRefreshRuns: ids ∩ repo, request order, misses dropped.
    if (query.refreshRunIds.length === 0) {
      runRows = [];
    } else {
      const rows = await db
        .select()
        .from(actionRuns)
        .where(and(eq(actionRuns.repoId, repo.id), inArray(actionRuns.id, query.refreshRunIds)));
      const byId = new Map(rows.map((row) => [row.id, row]));
      runRows = query.refreshRunIds.flatMap((id) => {
        const row = byId.get(id);
        return row ? [row] : [];
      });
    }
  } else {
    // prepareFullPageRuns' SQL filters (ToConds): repo + workflow + actor +
    // ref; the status filter rides the ROLLUP (the module header) — so the
    // matching set is fetched unpaginated, filtered in JS, then sliced.
    const conds = [eq(actionRuns.repoId, repo.id)];
    if (query.workflow !== "") conds.push(eq(actionRuns.workflowId, query.workflow));
    if (query.actor > 0) conds.push(eq(actionRuns.triggerUserId, query.actor));
    if (query.branch !== "") conds.push(eq(actionRuns.ref, `refs/heads/${query.branch}`));
    runRows = await db
      .select()
      .from(actionRuns)
      .where(and(...conds))
      .orderBy(desc(actionRuns.index));
  }

  // The rollup: latest-attempt jobs per run (GetLatestAttemptJobsByRuns —
  // rows whose runAttemptId is the run's latestAttemptId), then
  // AggregateJobStatus. Runs keep their column value with no attempt jobs.
  const attemptIdByRun = new Map(runRows.map((row) => [row.id, row.latestAttemptId]));
  const attemptIds = [...new Set(attemptIdByRun.values())].filter((id) => id > 0);
  const jobsByRun = new Map<number, RunJobRow[]>();
  if (runRows.length > 0 && attemptIds.length > 0) {
    const jobRows = await db
      .select()
      .from(actionRunJobs)
      .where(
        and(
          inArray(
            actionRunJobs.runId,
            runRows.map((row) => row.id),
          ),
          inArray(actionRunJobs.runAttemptId, attemptIds),
        ),
      );
    for (const job of jobRows) {
      if (attemptIdByRun.get(job.runId) !== job.runAttemptId) continue;
      const bucket = jobsByRun.get(job.runId);
      if (bucket === undefined) {
        jobsByRun.set(job.runId, [job]);
      } else {
        bucket.push(job);
      }
    }
  }
  const rolledUp = new Map<number, number>();
  for (const row of runRows) {
    const jobs = jobsByRun.get(row.id);
    rolledUp.set(row.id, jobs !== undefined && jobs.length > 0 ? aggregateJobStatus(jobs) : row.status);
  }

  // The status filter applies to the ROLLED-UP status (the module header).
  const statusFiltered = query.status !== 0 && !query.partialRefresh ? runRows.filter((row) => rolledUp.get(row.id) === query.status) : runRows;

  // Pagination over the filtered set (full page only — the fragment
  // re-renders exactly the requested rows).
  const total = statusFiltered.length;
  const start = (query.page - 1) * query.limit;
  const pageRows = query.partialRefresh ? statusFiltered : statusFiltered.slice(start, start + query.limit);
  const more = !query.partialRefresh && total > start + query.limit;

  // prepareCommon's trigger-user join (LoadTriggerUser) — one IN read;
  // a missing user degrades to the unlinked Ghost text (the reduction).
  const triggerIds = [...new Set(pageRows.map((row) => row.triggerUserId).filter((id) => id > 0))];
  const usersById = new Map<number, { username: string; displayName: string }>();
  if (triggerIds.length > 0) {
    const userRows = await db
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, triggerIds));
    for (const user of userRows) {
      usersById.set(user.id, {
        username: user.username,
        displayName: user.displayName !== null && user.displayName !== "" ? user.displayName : user.username,
      });
    }
  }

  // loadIsRefDeleted: branch names from the git refs (the reduction —
  // upstream reads its branch table); a run's refs/heads/X with no X is
  // deleted.
  const refs = await engine.listRefs();
  const branchNames = new Set(
    (refs?.refs ?? []).flatMap((ref) => (ref.name.startsWith("refs/heads/") ? [ref.name.slice("refs/heads/".length)] : [])),
  );

  // The RunErrors pass — ONLY the no-matching-online-runner arm (the
  // module header): waiting, non-reusable-caller, non-matrix-deferred jobs
  // of still-unresolved runs vs the fresh runners (repo + owner + global
  // scopes, lastOnline inside RunnerOfflineTime, not disabled).
  const runErrors = new Map<number, string>();
  const activeIds = new Set(
    pageRows.filter((row) => !isDoneStatus(rolledUp.get(row.id) ?? row.status)).map((row) => row.id),
  );
  if (activeIds.size > 0) {
    const freshCutoffSeconds = nowSeconds - RUNNER_OFFLINE_SECONDS;
    const runnerRows = await db
      .select({ agentLabels: actionRunners.agentLabels })
      .from(actionRunners)
      .where(and(eq(actionRunners.isDisabled, false), sql`${actionRunners.lastOnline} > ${freshCutoffSeconds}`));
    const onlineLabelSets = runnerRows.map((runner) => JSON.parse(runner.agentLabels) as string[]);
    for (const row of pageRows) {
      if (!activeIds.has(row.id)) continue;
      for (const job of jobsByRun.get(row.id) ?? []) {
        if (job.status !== ACTION_STATUS_WAITING || job.isReusableCaller || job.isMatrixDeferred) continue;
        const runsOn = JSON.parse(job.runsOn) as string[];
        const hasOnlineRunner =
          onlineLabelSets.length > 0 &&
          onlineLabelSets.some((labels) => {
            const lower = new Set(labels.map((label) => label.toLowerCase()));
            return runsOn.length > 0 && runsOn.every((label) => lower.has(label.toLowerCase()));
          });
        if (!hasOnlineRunner) {
          runErrors.set(row.id, `No matching online runner with label: ${runsOn.join(",")}`);
          break;
        }
      }
    }
  }

  // fillRefreshMeta (actions.go:591-609): the interval over the PAGE's
  // rows, the link = the request URI + the rows' ids (QueryBuild replaces
  // any previous run_ids).
  const hasActiveRuns = pageRows.some((row) => {
    const status = rolledUp.get(row.id) ?? row.status;
    return status === ACTION_STATUS_WAITING || status === ACTION_STATUS_RUNNING || status === ACTION_STATUS_BLOCKED;
  });
  const refreshIntervalMs = pageRows.length === 0 ? 0 : hasActiveRuns ? 3000 : 12000;
  const refreshUri = new URL(requestUri, "https://actions.local");
  refreshUri.searchParams.set("run_ids", pageRows.map((row) => String(row.id)).join(","));
  const refreshLink = `${refreshUri.pathname}${refreshUri.search}`;

  const runs: ActionsRunView[] = pageRows.map((row) => {
    const status = rolledUp.get(row.id) ?? row.status;
    const durationSeconds = calculateDurationSeconds(
      row.started !== null ? Math.floor(row.started.getTime() / 1000) : null,
      row.stopped !== null ? Math.floor(row.stopped.getTime() / 1000) : null,
      status,
      row.updated !== null ? Math.floor(row.updated.getTime() / 1000) : null,
      nowSeconds,
      row.latestAttemptId === 0 ? row.previousDuration : 0,
    );
    const triggerUser = usersById.get(row.triggerUserId) ?? null;
    return {
      id: row.id,
      index: row.index,
      title: row.title,
      link: `${repoLink}/actions/runs/${row.id}`,
      workflowId: row.workflowId,
      status,
      commitSha: row.commitSha,
      scheduleId: row.scheduleId,
      triggerUser:
        triggerUser === null
          ? null
          : {
              username: triggerUser.username,
              displayName: triggerUser.displayName,
              homeLink: `/${triggerUser.username}`,
            },
      ref: row.ref,
      prettyRef: prettyRefOf(row.ref),
      refLink: refLinkOf(repoLink, row.ref),
      refTooltip: refTooltipOf(row.ref, row.eventPayload),
      isRefDeleted: runRefKind(row.ref) === "branch" && !branchNames.has(refShortName(row.ref)),
      updatedUnix: row.updated !== null ? Math.floor(row.updated.getTime() / 1000) : 0,
      durationText: formatDuration(durationSeconds),
      errorMessage: runErrors.get(row.id) ?? null,
    };
  });

  // ---- the full-page block (prepareOtherWorkflows + prepareFullPageTemplate)
  let pageBlock: RepoActionsRunsPageBlock | null = null;
  if (!query.partialRefresh) {
    // prepareOtherWorkflows: distinct repo-level run workflow ids not in the
    // listed set (GetRepoRunWorkflowIDs — is_scoped_run=false, v1 always).
    const otherWorkflows = (
      await db.selectDistinct({ workflowId: actionRuns.workflowId }).from(actionRuns).where(eq(actionRuns.repoId, repo.id))
    )
      .map((row) => row.workflowId)
      .filter((id) => id !== "" && !(id in workflowNames))
      .sort();

    // GetActors: the runs' distinct trigger users (viewer self on top —
    // MakeSelfOnTop; then display-name order — the GetOrderByName
    // reduction).
    const actorIds = (
      await db
        .selectDistinct({ triggerUserId: actionRuns.triggerUserId })
        .from(actionRuns)
        .where(eq(actionRuns.repoId, repo.id))
    )
      .map((row) => row.triggerUserId)
      .filter((id) => id > 0);
    const actorRows =
      actorIds.length > 0
        ? await db
            .select({ id: users.id, username: users.username, displayName: users.displayName })
            .from(users)
            .where(inArray(users.id, actorIds))
        : [];
    const actors = actorRows
      .map((row) => ({
        id: row.id,
        displayName: row.displayName !== null && row.displayName !== "" ? row.displayName : row.username,
        homeLink: `/${row.username}`,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    // GetRunBranches: the git branch names sorted (the module-header
    // reduction — upstream reads its branch table).
    const runBranches = [...branchNames].sort((a, b) => a.localeCompare(b));

    const canWriteCode = canWriteActions; // the code unit is not toggleable in our store (the reduction)
    const hasWorkflowsOrRuns = workflows.length > 0 || otherWorkflows.length > 0 || total > 0;
    pageBlock = {
      workflows,
      otherWorkflows,
      actors,
      runBranches,
      curActor: query.actor,
      curStatus: query.status,
      curBranch: query.branch,
      curWorkflowRepoId: query.scopedWorkflowSourceRepoId,
      hasWorkflowsOrRuns,
      canWriteActions,
      canWriteCode,
    };
  }

  return {
    runs,
    isFiltered,
    workflowNames,
    curWorkflow: query.workflow,
    refreshLink,
    refreshIntervalMs,
    total,
    page: query.page,
    pageSize: query.limit,
    more,
    pageBlock,
  };
}

// ---------------------------------------------------------------------------
// The status icon (repo/icons/action_status.tmpl — the SSR arm)
// ---------------------------------------------------------------------------

/** action_status.tmpl's map: the icon per status name (+ the circle-fill
 *  variant the runs list uses). The RUNNING arm renders gitea-running
 *  upstream — a stroke-based body our extracted-path Icon cannot express,
 *  so octicon-sync with the official bundle's rotate-clockwise class is the
 *  documented stand-in (the module header). */
export function actionStatusIcon(name: string, variant: "plain" | "circle-fill"): { name: IconName; className: string } {
  switch (name) {
    case "success":
      return {
        name: variant === "circle-fill" ? "octicon-check-circle-fill" : "octicon-check",
        className: "tw-text-green",
      };
    case "skipped":
      return { name: "octicon-skip", className: "tw-text-text-light" };
    case "cancelled":
      return { name: "octicon-stop", className: "tw-text-text-light" };
    case "waiting":
      return { name: "octicon-dot-fill", className: "tw-text-yellow" };
    case "pending":
      return { name: "octicon-circle", className: "tw-text-text-light" };
    case "blocked":
      return { name: "octicon-blocked", className: "tw-text-yellow" };
    case "running":
      return { name: "octicon-sync", className: "tw-text-yellow rotate-clockwise" };
    case "cancelling":
      return { name: "octicon-stop", className: "tw-text-yellow" };
    default: // failure, unknown
      return { name: variant === "circle-fill" ? "octicon-x-circle-fill" : "octicon-x", className: "tw-text-red" };
  }
}

// ---------------------------------------------------------------------------
// The render (list.tmpl / runs_list.tmpl / sidebar.tmpl / no_workflows.tmpl)
// ---------------------------------------------------------------------------

/** The runs_list rows + the container attrs (the fragment IS this markup —
 *  runs_list.tmpl:1-5's data-global-init contract). */
function RunsList(props: { repoLink: string; data: RepoActionsRunsData }) {
  const { data } = props;
  return (
    <div
      class="flex-divided-list items-with-main run-list"
      data-global-init="initActionRunsList"
      data-action-runs-refresh-link={data.refreshLink}
      data-action-runs-refresh-interval={String(data.refreshIntervalMs)}
    >
      {data.runs.length === 0 ? (
        <div class="empty-placeholder">
          <Icon name="octicon-no-entry" size={48} />
          <h2>{data.isFiltered ? repoActionsRunsLocale.no_results : repoActionsRunsLocale.no_runs}</h2>
        </div>
      ) : null}
      {data.runs.map((run) => {
        const statusString = statusName(run.status);
        const icon = actionStatusIcon(statusString, "circle-fill");
        const workflowDisplayName = data.workflowNames[run.workflowId];
        const title = run.title !== "" ? run.title : repoActionsRunsLocale.empty_commit_message;
        return (
          <div id={`action-run-item-${run.id}`} class="item tw-items-center" data-status={statusString} data-morph-whole>
            <div class="item-leading">
              <span data-tooltip-content={STATUS_DISPLAY[statusString] ?? "Unknown"}>
                <Icon name={icon.name} class={icon.className} />
              </span>
            </div>
            <div class="item-main">
              <div class="item-title">
                <a href={run.link}>{title}</a>
              </div>
              <div class="item-body">
                <span>
                  <b>
                    {data.curWorkflow === ""
                      ? `${workflowDisplayName !== undefined ? workflowDisplayName : run.workflowId} `
                      : ""}
                    #{run.index}
                  </b>
                  :
                </span>{" "}
                {run.scheduleId !== 0 ? (
                  <>{repoActionsRunsLocale.scheduled}</>
                ) : (
                  <>
                    {repoActionsRunsLocale.commit}{" "}
                    <a href={`${props.repoLink}/commit/${run.commitSha}`}>{run.commitSha.slice(0, 10)}</a>{" "}
                    {repoActionsRunsLocale.pushed_by}{" "}
                    {run.triggerUser !== null ? (
                      <a href={run.triggerUser.homeLink}>{run.triggerUser.displayName}</a>
                    ) : (
                      <>{repoActionsRunsLocale.ghost}</>
                    )}
                  </>
                )}
                {run.errorMessage !== null ? (
                  <span class="flex-text-inline" data-tooltip-content={run.errorMessage}>
                    <Icon name="octicon-alert" class="tw-text-red" />
                  </span>
                ) : null}
              </div>
            </div>
            <div class="run-list-item-trailing">
              {run.isRefDeleted ? (
                <span class="ui label run-list-ref gt-ellipsis tw-line-through" data-tooltip-content={run.refTooltip}>
                  {run.prettyRef}
                </span>
              ) : (
                <a class="ui label run-list-ref gt-ellipsis" href={run.refLink} data-tooltip-content={run.refTooltip}>
                  {run.prettyRef}
                </a>
              )}
              <div class="run-list-item-right">
                <div class="run-list-meta">
                  <Icon name="octicon-calendar" />
                  <TimeSince unixSeconds={run.updatedUnix} tz="+0000" />
                </div>
                <div class="run-list-meta">
                  <Icon name="octicon-stopwatch" />
                  {run.durationText}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The filter bar's href helper — every dropdown item carries the FULL
 *  filter set with exactly its own slot rewritten (list.tmpl:27-77's
 *  five-param query shape). */
function filterHref(
  basePath: string,
  cur: { workflow: string; workflowRepoId: number; actor: number; status: number; branch: string },
  patch: Partial<{ actor: number; status: number; branch: string }>,
): string {
  const params = new URLSearchParams();
  params.set("workflow", cur.workflow);
  params.set("scoped_workflow_source_repo_id", String(cur.workflowRepoId));
  params.set("actor", String(patch.actor ?? cur.actor));
  params.set("status", String(patch.status ?? cur.status));
  params.set("branch", patch.branch ?? cur.branch);
  return `${basePath}?${params.toString()}`;
}

/** The sidebar (sidebar.tmpl:1-52 reduced — the scoped groups defer with
 *  C10, the Management section lands with C6; the module header). */
function ActionsSidebar(props: { repoLink: string; data: RepoActionsRunsData }) {
  const block = props.data.pageBlock;
  if (block === null) return null;
  const carried = {
    workflow: props.data.curWorkflow,
    workflowRepoId: block.curWorkflowRepoId,
    actor: block.curActor,
    status: block.curStatus,
    branch: block.curBranch,
  };
  // CurWorkflowIsListed (actions.go:169) — the scoped arm is deferred, so
  // the Other-workflows disclosure opens exactly when the selected
  // workflow is one of the orphans.
  const curWorkflowIsListed = props.data.curWorkflow === "" || block.workflows.some((wf) => wf.entryName === props.data.curWorkflow);
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <a class={props.data.curWorkflow === "" ? "item active" : "item"} href={filterHref(`${props.repoLink}/actions`, carried, {})}>
          {repoActionsRunsLocale.all_workflows}
        </a>
        {block.workflows.map((wf) => (
          <a
            key={wf.entryName}
            class={props.data.curWorkflow === wf.entryName ? "item flex-text-block active" : "item flex-text-block"}
            href={filterHref(`${props.repoLink}/actions`, carried, {})}
          >
            <span class="gt-ellipsis" data-tooltip-content={wf.displayName}>
              {wf.displayName}
            </span>
            {wf.errMsg !== null ? (
              <span class="flex-text-inline tw-shrink-0" data-tooltip-content={wf.errMsg}>
                <Icon name="octicon-alert" class="tw-text-red" />
              </span>
            ) : null}
          </a>
        ))}
        {block.otherWorkflows.length > 0 ? (
          <details class="item" open={!curWorkflowIsListed}>
            <summary data-tooltip-content={repoActionsRunsLocale.other_workflows_tooltip}>
              <span class="flex-text-block">
                {repoActionsRunsLocale.other_workflows}
                <span class="ui label">{block.otherWorkflows.length}</span>
              </span>
            </summary>
            <div class="menu items-full-width">
              {block.otherWorkflows.map((name) => (
                <a
                  key={name}
                  class={props.data.curWorkflow === name ? "item active" : "item"}
                  href={filterHref(`${props.repoLink}/actions`, { ...carried, workflow: name, workflowRepoId: 0 }, {})}
                >
                  <span class="gt-ellipsis" data-tooltip-content={name}>
                    {name}
                  </span>
                </a>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** The filter menu (list.tmpl:17-96 reduced — the kebab arm renders nothing,
 *  the module header). */
function RunsFilterMenu(props: { repoLink: string; data: RepoActionsRunsData }) {
  const block = props.data.pageBlock;
  if (block === null) return null;
  const cur = {
    workflow: props.data.curWorkflow,
    workflowRepoId: block.curWorkflowRepoId,
    actor: block.curActor,
    status: block.curStatus,
    branch: block.curBranch,
  };
  const basePath = `${props.repoLink}/actions`;
  return (
    <div class="ui secondary filter menu flex-text-block tw-m-0">
      {/* Actor (list.tmpl:19-36) — the avatar thumbnails render as the
          display names (the avatar store's reduction; the tooltip-free
          text shape the landed twins use). */}
      <div class={block.actors.length === 0 ? "ui disabled dropdown jump item" : "ui dropdown jump item"}>
        <span class="text">{repoActionsRunsLocale.actor}</span>
        <Icon name="octicon-triangle-down" class="dropdown icon" />
        <div class="menu">
          <a class={block.curActor === 0 ? "item selected" : "item"} href={filterHref(basePath, cur, { actor: 0 })}>
            {repoActionsRunsLocale.actors_no_select}
          </a>
          {block.actors.map((actor) => (
            <a key={actor.id} class={block.curActor === actor.id ? "item selected" : "item"} href={filterHref(basePath, cur, { actor: actor.id })}>
              {actor.displayName}
            </a>
          ))}
        </div>
      </div>
      {/* Status (list.tmpl:38-58). */}
      <div class="ui dropdown jump item">
        <span class="text">{repoActionsRunsLocale.status}</span>
        <Icon name="octicon-triangle-down" class="dropdown icon" />
        <div class="menu">
          <a class={block.curStatus === 0 ? "item selected" : "item"} href={filterHref(basePath, cur, { status: 0 })}>
            {repoActionsRunsLocale.status_no_select}
          </a>
          {STATUS_INFO_LIST.map((info) => {
            const icon = actionStatusIcon(info.statusName, "plain");
            return (
              <a key={info.status} class={block.curStatus === info.status ? "item selected" : "item"} href={filterHref(basePath, cur, { status: info.status })}>
                <span class="flex-text-inline tw-gap-2">
                  <Icon name={icon.name} class={icon.className} />
                  {info.displayedStatus}
                </span>
              </a>
            );
          })}
        </div>
      </div>
      {/* Branch (list.tmpl:60-77) — data-test-id rides upstream's arm. */}
      <div class={block.runBranches.length === 0 ? "ui disabled dropdown jump item" : "ui dropdown jump item"} data-test-id="filter-branch">
        <span class="text">{repoActionsRunsLocale.branch}</span>
        <Icon name="octicon-triangle-down" class="dropdown icon" />
        <div class="menu">
          <a class={block.curBranch === "" ? "item selected" : "item"} href={filterHref(basePath, cur, { branch: "" })}>
            {repoActionsRunsLocale.branches_no_select}
          </a>
          {block.runBranches.map((branch) => (
            <a key={branch} class={block.curBranch === branch ? "item selected" : "item"} href={filterHref(basePath, cur, { branch })}>
              {branch}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The Older/Newer pager (base/paginate's landed reduction — the admin
 *  family's shape) carrying the full filter set. */
function RunsListPagination(props: { basePath: string; data: RepoActionsRunsData }) {
  const block = props.data.pageBlock;
  if (block === null) return null;
  if (props.data.page <= 1 && !props.data.more) return null;
  const href = (page: number): string => {
    const params = new URLSearchParams();
    params.set("workflow", props.data.curWorkflow);
    params.set("scoped_workflow_source_repo_id", String(block.curWorkflowRepoId));
    params.set("actor", String(block.curActor));
    params.set("status", String(block.curStatus));
    params.set("branch", block.curBranch);
    params.set("page", String(page));
    return `${props.basePath}?${params.toString()}`;
  };
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.data.page > 1 ? (
          <a class="item navigation" href={href(props.data.page - 1)}>
            <span class="navigation_label">Newer</span>
          </a>
        ) : null}
        {props.data.more ? (
          <a class="item navigation" href={href(props.data.page + 1)}>
            <span class="navigation_label">Older</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The full document (list.tmpl): the shell + the flex-container with the
 *  sidebar and the main column, or the no_workflows empty state. The
 *  fragment arm renders RunsList alone (renderRepoActionsRunsFragment). */
export function RepoActionsRunsPage(props: { ctx: UiContext; data: RepoActionsRunsData }) {
  const { ctx } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoActionsRunsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const block = props.data.pageBlock;
  return (
    <BaseLayout ctx={ctx} title={repoActionsRunsLocale.actions} pageClass="repository actions" activeTab="actions">
      <div class="ui container">
        {block === null || !block.hasWorkflowsOrRuns ? (
          <div class="empty-placeholder">
            <Icon name="octicon-no-entry" size={48} />
            <h2>{repoActionsRunsLocale.no_workflows}</h2>
            {block?.canWriteActions && block.canWriteCode ? (
              <p>
                {repoActionsRunsLocale.no_workflows_quick_start_prefix}{" "}
                <a target="_blank" rel="noopener noreferrer" href="https://docs.gitea.com/usage/actions/quickstart/">
                  {repoActionsRunsLocale.no_workflows_quick_start_link_text}
                </a>
                .
              </p>
            ) : null}
            <p>
              {repoActionsRunsLocale.no_workflows_documentation_prefix}{" "}
              <a target="_blank" rel="noopener noreferrer" href="https://docs.gitea.com/usage/actions/overview/">
                {repoActionsRunsLocale.no_workflows_documentation_link_text}
              </a>
              .
            </p>
          </div>
        ) : (
          <div class="flex-container">
            <ActionsSidebar repoLink={repoLink} data={props.data} />
            <div class="flex-container-main">
              <div class="ui top attached header flex-left-right">
                <strong>
                  {props.data.total}{" "}
                  {props.data.total === 1 ? repoActionsRunsLocale.workflow_runs_one : repoActionsRunsLocale.workflow_runs_n}
                </strong>
                <RunsFilterMenu repoLink={repoLink} data={props.data} />
              </div>
              <div class="ui attached segment">
                <RunsList repoLink={repoLink} data={props.data} />
                <RunsListPagination basePath={`${repoLink}/actions`} data={props.data} />
              </div>
            </div>
          </div>
        )}
      </div>
    </BaseLayout>
  );
}

/** The full-document render (render.tsx's pattern — index.ts stays pure TS). */
export function renderRepoActionsRunsPage(ctx: UiContext, data: RepoActionsRunsData): string {
  return renderPage(<RepoActionsRunsPage ctx={ctx} data={data} />);
}

/** The partial-refresh fragment: runs_list.tmpl ALONE — the morph root the
 *  client timer's GET returns (upstream ctx.HTML(200, "repo/actions/
 *  runs_list"), actions.go:115). */
export function renderRepoActionsRunsFragment(data: RepoActionsRunsData, repoLink: string): string {
  return renderToString(<RunsList repoLink={repoLink} data={data} />);
}

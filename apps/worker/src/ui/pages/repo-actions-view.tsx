/**
 * The repo Actions RUN-VIEWER subtree — the census C2 arm
 * (docs/research/actions-ui-census.md): the SSR mount shell + the
 * `ViewResponse` JSON the official bundle's Vue app lives on, over the M1a
 * tables (services/actions/model.ts's current exports; this module adds its
 * own reads beside them — the re-issue precedent, each with a dedup note for
 * the M1b landing).
 *
 * Upstream pin (VERIFIED at fc4936884584a41931906553d96c2601d750e6ef):
 *
 *   - Routes (web.go:1566-1608's `/actions` group; group middleware
 *     `optSignIn, context.RepoAssignment, repo.MustBeNotEmpty,
 *     reqRepoActionsReader, actions.MustEnableActions`):
 *       GET+POST /actions/runs/{run}                 actions.View / ViewPost
 *       GET+POST /actions/runs/{run}/attempts/{n}    same pair
 *       GET+POST /actions/runs/{run}/jobs/{n}        same pair
 *       POST     /actions/runs/{run}/cancel          actions.Cancel (writer)
 *     The rerun/rerun-failed/approve/delete tails are the census C5
 *     remainder: rerun's attempt creation + job re-emission is
 *     emitter-dependent and NOT this module's (the census C5 flag), so those
 *     routes stay unclaimed → the engine's 404.
 *
 *   - The mount shell (templates/repo/actions/view.tmpl +
 *     view_component.tmpl): upstream SSRs ONLY
 *     `<div id="repo-action-view" data-job-id data-actions-view-url +
 *     ~60 data-locale-*>` inside `.page-content.repository` over the repo
 *     header — every string the Vue app shows is injected here as a data
 *     attribute (the census's posture fact 2: the page is 100%
 *     official-bundle JS; this module is one shell + one JSON endpoint, not
 *     a UI port).
 *
 *   - The JSON contract (view.go:291-417 ViewResponse + ViewRequest): the
 *     POST twin of the same URL carries `{logCursors:[{step,cursor,expanded}]}`
 *     and answers the full state tree (run/attempts/jobs/commit/pullRequest/
 *     jobSummaries/artifacts + currentJob + logs). The census pins it as one
 *     of the two byte-shape contracts that deserve goldens on day one — the
 *     test matrix pins the field list against view.go's struct.
 *
 * ## Gates
 *
 * The tab-region posture (NOT the settings family's admin gate): upstream's
 * group middleware lets ANONYMOUS viewers read a public repo's runs
 * (optSignIn + RequireUnitReader(TypeActions) → NotFound on no-read). Our
 * reduction: the `resolveRepositoryForViewer` grant IS the unit read (the
 * pull-files posture — this store has no unit ACL), and `MustEnableActions`
 * is `repo_settings.has_actions` (DEFAULT false → the 404 shell, the C8
 * settings arm's same flag). The WRITE booleans
 * (canCancel/canApprove/canRerun/canDeleteArtifact and the cancel arm's
 * RequireUnitWriter gate) reduce to the landed `canWriteRepository` grant
 * through `sessionRepoGrant`/`canWriteRepo` (the file-editor precedent) —
 * anonymous false naturally, so the cancel arm 404-shells anonymous exactly
 * like upstream's RequireUnitWriter NotFound (no login redirect: a fetch
 * arm).
 *
 * ## Data (§3.2 — the M1a store + module-local reads)
 *
 * The M1a service (services/actions/model.ts) is consumed where its exports
 * fit (the status constants, the row types, `canMatchLabels` for the
 * waiting-detail's runner arm, `increaseTaskVersion` for the cancel wake).
 * Every READ this page needs (run by id/index/latest, attempts, jobs,
 * artifacts meta, job summaries, trigger users) lives module-local with the
 * upstream ordering verbatim — M1b is extending model.ts in flight, so
 * nothing outside its current surface is imported; the landing dedup notes
 * sit on each helper.
 *
 * The `state.currentJob.steps` + `logs.stepsLog` arms (the census C3 unit,
 * landed over M1b's log store): `convertToViewModel` (view.go:835-917) is
 * ported whole — FullSteps' pre/post synthesis (modules/actions/task_state.go),
 * the cancelling overlay, the waiting→pending wire flip, the per-cursor
 * `validCursor` guards, and the log-expired arm — reading the steps through
 * M1b's `getTaskStepsByTaskId` and the log rows through M1b's
 * `readTaskLogs` (the read seam M1b's report named). A job without a task
 * (EffectiveTaskID() == 0, e.g. waiting) still gets the empty arrays —
 * view.go's explicit `make([]…, 0)` shell, exactly the response upstream
 * gives it.
 *
 * ## Documented divergences (§6 method — each cites its upstream arm)
 *
 * - `repoId` is the store's TEXT repositories.id string, not upstream's
 *   int64 — the M1a sentinel adaptation (schema.ts SPEC-0012 block; the
 *   runner protocol's wire.ts already ships string repo ids).
 * - `titleHTML` reuses the landed markdown pipeline
 *   (renderMarkdownToHtml, SPEC-0008 §3.4) over the first message line
 *   (upstream RenderCommitMessage's Cut) instead of re-porting
 *   PostProcessCommitMessage — the census open question 3's own
 *   recommendation. Block-level markdown in a title renders (upstream's
 *   post-process-only arm keeps it literal); the pipeline carries the
 *   backtick/code and link arms.
 * - `pullRequest` arms 1-2 (a `refs/pull/N/head` ref, a pull_request event
 *   payload) are ported; upstream's arm 3 (the open-PR-by-head-branch
 *   lookup, GetUnmergedPullRequestsByHeadInfo) needs the pulls service'
 *   head index and is deferred with C5's PR-nav wave — the field stays
 *   absent for push runs (omitempty upstream too).
 * - The summary ref cache (getViewSummaryRefInfo's 10 s TTL over the 1 s
 *   poll) is not ported — the instance cache module has no Workers analog
 *   here; the branch-existence read rides the landed engine `listRefs` RPC
 *   per response (cheap DO hop; the census's polling cost note).
 * - `SortMatrixGroupsByName` is a no-op on v1 rows (matrix expansion is M3;
 *   contiguous same-jobId groups are singletons), so jobs ride the id order
 *   verbatim.
 * - The cancel port (cancelActionRun below) is the v1 reduction of
 *   CancelRun: the `always()`-condition job exemption needs the workflow
 *   YAML parse (jobparser — M1b/M3 territory) and the reusable-caller
 *   cascade is unread in v1 rows; the commit-status/notifier legs have no
 *   platform analog. The runner handshake (HasCancellingSupport + the
 *   1-minute report timeout, StopTask) IS ported.
 * - Artifact `previewLink` carries the upstream computation and is LIVE
 *   (the C4 flip): pages/repo-actions-artifacts.ts is the census C4 module —
 *   the preview page (artifact_preview.tmpl port) + the signed raw-content
 *   serving the link composes from. The route arms that mount them
 *   (`/{owner}/{repo}/actions/artifacts/{id}/preview[/*]` and the root
 *   `/-/actions/artifacts/{id}/{expires}/{signature}/*`) live in the
 *   orchestrator-owned ui/index.ts — C4's landing reports them, and the
 *   flip rides the same landing (the dead-link rule: the link must never
 *   point at an unclaimed route).
 * - The GET resolves the run through the FULL ID-vs-index disambiguation
 *   (resolveCurrentRunForView — index URLs 302 onto the canonical id URL);
 *   the POST twins resolve ID-based ONLY (getCurrentRunByPathParam —
 *   ViewPost/Cancel share it upstream; the deliberate asymmetry: only the
 *   GET redirects).
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { engineReads } from "../../api/services/engine";
import { renderMarkdownToHtml } from "../../api/services/markdown";
import {
  actionArtifacts,
  actionRunAttempts,
  actionRunJobSummaries,
  actionRunJobs,
  actionRuns,
  actionRunners,
  actionTasks,
  users,
} from "../../db/schema";
import {
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_CANCELLING,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_WAITING,
  canMatchLabels,
  increaseTaskVersion,
  type RunAttemptRow,
  type RunJobRow,
  type RunRow,
  type TaskRow,
} from "../../services/actions/model";
import { getTaskStepsByTaskId, readTaskLogs, type TaskStepRow } from "../../services/actions/update";
import { avatarLinkWithSize, defaultAvatarLink, type AvatarChainUser } from "../../services/avatars";
import { BaseLayout, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";

type D1 = D1Database;

// ---------------------------------------------------------------------------
// The mount shell's locale (view_component.tmpl's data-locale-* set — every
// string the SPA shows, injected as an attribute; each key cites its upstream
// locale key, read from options/locale/locale_en-US.json at the pin)
// ---------------------------------------------------------------------------

export const repoActionsViewLocale = {
  approve: "Approve", // "repo.diff.review.approve"
  cancel: "Cancel workflow run", // "actions.runs.cancel"
  rerun: "Re-run", // "rerun"
  rerunAll: "Re-run all jobs", // "rerun_all"
  rerunFailed: "Re-run failed jobs", // "rerun_failed"
  latest: "Latest", // "actions.runs.latest"
  latestAttempt: "Latest attempt", // "actions.runs.latest_attempt"
  attempt: "Attempt", // "actions.runs.attempt"
  runsScheduled: "Scheduled", // "actions.runs.scheduled"
  runsCommit: "Commit", // "actions.runs.commit"
  runsPushedBy: "pushed by", // "actions.runs.pushed_by"
  summary: "Summary", // "actions.runs.summary"
  allJobs: "All jobs", // "actions.runs.all_jobs"
  jobSummaries: "Job summaries", // "actions.runs.job_summaries"
  expandCallerJobs: "Show jobs of this reusable workflow caller", // "actions.runs.expand_caller_jobs"
  collapseCallerJobs: "Hide jobs of this reusable workflow caller", // "actions.runs.collapse_caller_jobs"
  triggeredVia: "Triggered via %s", // "actions.runs.triggered_via"
  rerunTriggered: "Re-run triggered", // "actions.runs.rerun_triggered"
  backToPullRequest: "Back to pull request", // "actions.runs.back_to_pull_request"
  backToWorkflow: "Back to workflow", // "actions.runs.back_to_workflow"
  statusLabel: "Status", // "actions.runs.status"
  totalDuration: "Total duration", // "actions.runs.total_duration"
  runDetails: "Run Details", // "actions.runs.run_details"
  workflowFile: "Workflow file", // "actions.runs.workflow_file"
  workflowFileNoPermission: "No permission to view the workflow file", // "actions.runs.workflow_file_no_permission"
  statusUnknown: "Unknown", // "actions.status.unknown"
  statusWaiting: "Waiting", // "actions.status.waiting"
  statusRunning: "Running", // "actions.status.running"
  statusCancelling: "Canceling", // "actions.status.cancelling"
  statusSuccess: "Success", // "actions.status.success"
  statusFailure: "Failure", // "actions.status.failure"
  statusCancelled: "Canceled", // "actions.status.cancelled"
  statusSkipped: "Skipped", // "actions.status.skipped"
  statusBlocked: "Blocked", // "actions.status.blocked"
  statusPending: "Pending", // "actions.status.pending"
  artifactsTitle: "Artifacts", // "artifacts"
  artifactExpired: "Expired", // "expired"
  artifactExpiresAt: "Expires at %s", // "artifact_expires_at"
  artifactExpiredAt: "Expired at %s", // "artifact_expired_at"
  confirmDeleteArtifact: "Are you sure you want to delete the artifact '%s'?", // "confirm_delete_artifact"
  showTimestamps: "Show timestamps", // "show_timestamps"
  showLogSeconds: "Show seconds", // "show_log_seconds"
  showFullScreen: "Show full screen", // "show_full_screen"
  downloadLogs: "Download logs", // "download_logs"
  downloadFile: "Download file", // "repo.download_file"
  copyOutput: "Copy output", // "copy_output"
  logsAlwaysAutoScroll: "Always auto scroll logs", // "actions.logs.always_auto_scroll"
  logsAlwaysExpandRunning: "Always expand running logs", // "actions.logs.always_expand_running"
  workflowDependencies: "Workflow Dependencies", // "actions.runs.workflow_dependencies"
  graphJobsCount1: "%d job", // "actions.runs.graph_jobs_count_1"
  graphJobsCountN: "%d jobs", // "actions.runs.graph_jobs_count_n"
  graphDependenciesCount1: "%d dependency", // "actions.runs.graph_dependencies_count_1"
  graphDependenciesCountN: "%d dependencies", // "actions.runs.graph_dependencies_count_n"
  graphSuccessRate: "%s success", // "actions.runs.graph_success_rate"
  graphZoomIn: "Zoom in (Ctrl/Cmd + scroll on graph)", // "actions.runs.graph_zoom_in"
  graphZoomMax: "Already at 100% zoom", // "actions.runs.graph_zoom_max"
  graphZoomOut: "Zoom out (Ctrl/Cmd + scroll on graph)", // "actions.runs.graph_zoom_out"
  graphResetView: "Reset view", // "actions.runs.graph_reset_view"
} as const;

/** The currentJob detail strings (view.go's describePendingJobDetail /
 *  Status.LocaleString arms — the JSON side's strings). */
export const repoActionsViewDetailLocale = {
  needApproval: "Need approval to run workflows for fork pull request.", // "actions.need_approval_desc"
  waitingForDependentJobs: "Waiting for the following jobs to complete: %s", // "actions.runs.waiting_for_dependent_jobs"
  noRunnerOnline: "No runner is online to pick up this job.", // "actions.runs.no_runner_online"
  noMatchingOnlineRunner: "No matching online runner with label: %s", // "actions.runs.no_matching_online_runner_helper"
  waitingForAvailableRunner: "Waiting for a matching runner to become available.", // "actions.runs.waiting_for_available_runner"
} as const;

/** The 10-value status → wire-string map (models/actions/status.go's
 *  statusNames). */
const STATUS_NAMES: Record<number, string> = {
  0: "unknown",
  1: "success",
  2: "failure",
  3: "cancelled",
  4: "skipped",
  5: "waiting",
  6: "running",
  7: "blocked",
  8: "cancelling",
  9: "pending",
};

/** Status.String() — the wire spelling every status field carries. */
export function actionStatusName(status: number): string {
  return STATUS_NAMES[status] ?? "unknown";
}

/** Status.IsDone — the four terminal statuses (module-local twin of
 *  services/actions/update.ts's isDoneStatus; the dedup note rides M1b's
 *  model.ts landing — the UI keeps a private twin so the page's service
 *  imports stay on model.ts's frozen surface only). */
export function isDoneStatusValue(status: number): boolean {
  return status === 1 /* success */ || status === 2 /* failure */ || status === 3 /* cancelled */ || status === 4 /* skipped */;
}

/** Status.LocaleString — the display spelling the currentJob detail uses
 *  (TrString over "actions.status." + name; the mount locale's capitalized
 *  English forms). */
export function actionStatusDisplay(status: number): string {
  switch (actionStatusName(status)) {
    case "unknown":
      return repoActionsViewLocale.statusUnknown;
    case "waiting":
      return repoActionsViewLocale.statusWaiting;
    case "running":
      return repoActionsViewLocale.statusRunning;
    case "cancelling":
      return repoActionsViewLocale.statusCancelling;
    case "success":
      return repoActionsViewLocale.statusSuccess;
    case "failure":
      return repoActionsViewLocale.statusFailure;
    case "cancelled":
      return repoActionsViewLocale.statusCancelled;
    case "skipped":
      return repoActionsViewLocale.statusSkipped;
    case "blocked":
      return repoActionsViewLocale.statusBlocked;
    default:
      return repoActionsViewLocale.statusPending;
  }
}

// ---------------------------------------------------------------------------
// Duration formatting (calculateDuration + Go time.Duration.String — the
// `duration` fields' spellings, e.g. "1h23m45s" / "5s" / "2h0m0s")
// ---------------------------------------------------------------------------

/** calculateDuration (models/actions/utils.go:73-90): 0 without a start;
 *  done runs count start→stop (the updated column is the fallback end when
 *  the stop is zero/backwards); live ones count start→now truncated to
 *  seconds. Millisecond arithmetic — our columns are unix seconds, so no
 *  sub-second spill ever reaches the formatter. */
export function calculateDurationMs(
  started: Date | null,
  stopped: Date | null,
  status: number,
  fallbackEnd: Date,
): number {
  if (started === null) return 0;
  const startMs = started.getTime();
  if (isDoneStatusValue(status)) {
    const stoppedMs = stopped?.getTime() ?? null;
    if (stoppedMs === null || stoppedMs < startMs) {
      const fallbackMs = fallbackEnd.getTime();
      if (fallbackMs < startMs) return 0;
      return fallbackMs - startMs;
    }
    return stoppedMs - startMs;
  }
  return Math.max(Date.now() - startMs, 0);
}

/** Go time.Duration.String() over whole milliseconds: `s` always (integer
 *  seconds), `m`/`h` only when non-zero, fractions per Go's magnitude
 *  precision (our second-grain timestamps never produce one — prec 0). */
export function goDurationString(ms: number): string {
  if (ms <= 0) return "0s";
  let totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  totalSeconds = (totalSeconds - seconds) / 60;
  const minutes = totalSeconds % 60;
  const hours = (totalSeconds - minutes) / 60;
  let out = `${seconds}s`;
  if (minutes > 0 || hours > 0) out = `${minutes}m${out}`;
  if (hours > 0) out = `${hours}h${out}`;
  return out;
}

/** Run/attempt/job Duration().String() — calculateDuration over the row's
 *  started/stopped/updated triple. */
function rowDurationString(
  started: Date | null,
  stopped: Date | null,
  status: number,
  updated: Date,
): string {
  return goDurationString(calculateDurationMs(started, stopped, status, updated));
}

// ---------------------------------------------------------------------------
// Module-local reads over the M1a tables (each cites its upstream model
// function; the M1b dedup note: these are the re-issued reads the landing
// should fold into model.ts — the census C2 ownership row's re-issue
// precedent)
// ---------------------------------------------------------------------------

/** GetRunByRepoAndID (models/actions/run.go:287-297). */
export async function getRunByRepoAndId(d1: D1, repoId: string, runId: number): Promise<RunRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(actionRuns)
    .where(and(eq(actionRuns.id, runId), eq(actionRuns.repoId, repoId)))
    .limit(1);
  return rows[0] ?? null;
}

/** GetRunByRepoAndIndex (run.go:308-314) — the legacy index-based URL arm. */
export async function getRunByRepoAndIndex(d1: D1, repoId: string, index: number): Promise<RunRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(actionRuns)
    .where(and(eq(actionRuns.repoId, repoId), eq(actionRuns.index, index)))
    .limit(1);
  return rows[0] ?? null;
}

/** GetLatestRun (run.go:317-326) — the "latest" run segment, `index` DESC. */
export async function getLatestRun(d1: D1, repoId: string): Promise<RunRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(actionRuns)
    .where(eq(actionRuns.repoId, repoId))
    .orderBy(desc(actionRuns.index))
    .limit(1);
  return rows[0] ?? null;
}

/** GetRunJobByRunAndID (run_job.go:230-240) — the run-scoped job lookup. */
export async function getRunJobByRunAndId(d1: D1, runId: number, jobId: number): Promise<RunJobRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(actionRunJobs)
    .where(and(eq(actionRunJobs.id, jobId), eq(actionRunJobs.runId, runId)))
    .limit(1);
  return rows[0] ?? null;
}

/** GetRunJobByRepoAndID (run_job.go:207-217) — the ID-vs-index probe's
 *  job arm. */
export async function getRunJobByRepoAndId(d1: D1, repoId: string, jobId: number): Promise<RunJobRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(actionRunJobs)
    .where(and(eq(actionRunJobs.id, jobId), eq(actionRunJobs.repoId, repoId)))
    .limit(1);
  return rows[0] ?? null;
}

/** GetRunAttemptByRunIDAndAttemptNum (run_attempt.go:89-98). */
export async function getRunAttemptByRunIdAndAttemptNum(
  d1: D1,
  runId: number,
  attemptNum: number,
): Promise<RunAttemptRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(actionRunAttempts)
    .where(and(eq(actionRunAttempts.runId, runId), eq(actionRunAttempts.attempt, attemptNum)))
    .limit(1);
  return rows[0] ?? null;
}

/** GetRunAttemptByRepoAndID (run_attempt.go:78-84). */
export async function getRunAttemptByRepoAndId(d1: D1, repoId: string, attemptId: number): Promise<RunAttemptRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(actionRunAttempts)
    .where(and(eq(actionRunAttempts.repoId, repoId), eq(actionRunAttempts.id, attemptId)))
    .limit(1);
  return rows[0] ?? null;
}

/** GetLatestAttempt (run.go:224-231) — null for legacy runs. */
export async function getLatestAttemptOfRun(d1: D1, run: RunRow): Promise<RunAttemptRow | null> {
  if (run.latestAttemptId === 0) return null;
  return getRunAttemptByRepoAndId(d1, run.repoId, run.latestAttemptId);
}

/** ListRunAttemptsByRunID (run_attempt_list.go:30-36) — attempt number DESC
 *  (newest first, the dropdown's order). */
export async function listRunAttemptsByRunId(d1: D1, runId: number): Promise<RunAttemptRow[]> {
  return drizzle(d1)
    .select()
    .from(actionRunAttempts)
    .where(eq(actionRunAttempts.runId, runId))
    .orderBy(desc(actionRunAttempts.attempt));
}

/** GetRunJobsByRunAndAttemptID (run_job.go:305-311) — id ASC. runAttemptId 0
 *  addresses the legacy pre-attempt rows (never written in v1). */
export async function getRunJobsByRunAndAttemptId(d1: D1, runId: number, runAttemptId: number): Promise<RunJobRow[]> {
  return drizzle(d1)
    .select()
    .from(actionRunJobs)
    .where(and(eq(actionRunJobs.runId, runId), eq(actionRunJobs.runAttemptId, runAttemptId)))
    .orderBy(asc(actionRunJobs.id));
}

/** GetLatestAttemptJobsByRun (run_job.go:268-278) — the disambiguation's
 *  index-ordinal arm. */
export async function getLatestAttemptJobsByRun(d1: D1, run: RunRow): Promise<RunJobRow[]> {
  if (run.latestAttemptId > 0) return getRunJobsByRunAndAttemptId(d1, run.id, run.latestAttemptId);
  return getRunJobsByRunAndAttemptId(d1, run.id, 0);
}

/** ListUploadedArtifactsMetaByRunAttempt (artifact.go:231-241): the
 *  GROUP BY artifact_name roll-up — min(id), sum(file_size), max(status),
 *  max(expired_unix) — over confirmed (2) + expired (4) rows of exactly one
 *  attempt (0 = legacy). */
export interface ActionArtifactMeta {
  id: number;
  artifactName: string;
  fileSize: number;
  status: number;
  expiredUnix: number;
}

export async function listUploadedArtifactsMetaByRunAttempt(
  d1: D1,
  repoId: string,
  runId: number,
  runAttemptId: number,
): Promise<ActionArtifactMeta[]> {
  const rows = await drizzle(d1)
    .select({
      id: sql<string | null>`min(${actionArtifacts.id})`,
      artifactName: actionArtifacts.artifactName,
      fileSize: sql<string | null>`sum(${actionArtifacts.fileSize})`,
      status: sql<string | null>`max(${actionArtifacts.status})`,
      expiredUnix: sql<string | null>`max(${actionArtifacts.expiredUnix})`,
    })
    .from(actionArtifacts)
    .where(
      and(
        eq(actionArtifacts.repoId, repoId),
        eq(actionArtifacts.runId, runId),
        eq(actionArtifacts.runAttemptId, runAttemptId),
        inArray(actionArtifacts.status, [2, 4]), // UploadConfirmed | Expired
      ),
    )
    .groupBy(actionArtifacts.artifactName);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    artifactName: row.artifactName,
    fileSize: Number(row.fileSize ?? 0),
    status: Number(row.status ?? 0),
    expiredUnix: Number(row.expiredUnix ?? 0),
  }));
}

/** ListActionRunJobSummaries (run_job_summary.go:197-212) — job_id ASC,
 *  step_index ASC; jobId > 0 scopes to the single job (the job view's
 *  per-poll scoping). */
export interface ActionRunJobSummaryRow {
  jobId: number;
  stepIndex: number;
  content: string;
  contentType: string;
}

export async function listActionRunJobSummaries(
  d1: D1,
  repoId: string,
  runId: number,
  runAttemptId: number,
  jobId: number,
): Promise<ActionRunJobSummaryRow[]> {
  const where =
    jobId > 0
      ? and(
          eq(actionRunJobSummaries.repoId, repoId),
          eq(actionRunJobSummaries.runId, runId),
          eq(actionRunJobSummaries.runAttemptId, runAttemptId),
          eq(actionRunJobSummaries.jobId, jobId),
        )
      : and(
          eq(actionRunJobSummaries.repoId, repoId),
          eq(actionRunJobSummaries.runId, runId),
          eq(actionRunJobSummaries.runAttemptId, runAttemptId),
        );
  return drizzle(d1)
    .select({
      jobId: actionRunJobSummaries.jobId,
      stepIndex: actionRunJobSummaries.stepIndex,
      content: actionRunJobSummaries.content,
      contentType: actionRunJobSummaries.contentType,
    })
    .from(actionRunJobSummaries)
    .where(where)
    .orderBy(asc(actionRunJobSummaries.jobId), asc(actionRunJobSummaries.stepIndex));
}

/** The users projection the display/avatar arms read — one IN query for the
 *  run's trigger user + the attempts' trigger users (LoadTriggerUser's
 *  batched shape). */
export interface ViewUserRow {
  id: number;
  username: string;
  displayName: string | null;
  fullName: string | null;
  avatarEmail: string | null;
  useCustomAvatar: boolean;
}

export async function getUsersByIds(d1: D1, ids: number[]): Promise<Map<number, ViewUserRow>> {
  const unique = [...new Set(ids.filter((id) => id > 0))];
  const map = new Map<number, ViewUserRow>();
  if (unique.length === 0) return map;
  const rows = await drizzle(d1)
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      fullName: users.fullName,
      avatarEmail: users.avatarEmail,
      useCustomAvatar: users.useCustomAvatar,
    })
    .from(users)
    .where(inArray(users.id, unique));
  for (const row of rows) map.set(row.id, row);
  return map;
}

/** GetDisplayName (models/user/user.go:485-495) — the landed
 *  fullName-or-username reduction (DEFAULT_SHOW_FULL_NAME is default-off
 *  upstream; the display name column carries the render name here). A
 *  missing row (the trigger user deleted) renders empty, upstream's ghost
 *  shape without the ghost user. */
export function userDisplayName(user: ViewUserRow | undefined): string {
  if (user === undefined) return "";
  const fullName = (user.displayName ?? user.fullName ?? "").trim();
  return fullName !== "" ? fullName : user.username;
}

/** HomeLink (user.go:342-344) — the relative "/{username}". */
function userHomeLink(user: ViewUserRow | undefined): string {
  return user === undefined ? "" : `/${user.username}`;
}

/** AvatarLinkWithSize(ctx, 16) over the landed avatar chain (the
 *  activity-author-data precedent); a missing user row links the bundled
 *  default exactly like upstream's ghost arm. */
export async function userAvatarLink(
  bucket: R2Bucket | undefined,
  user: ViewUserRow | undefined,
  size: number,
): Promise<string> {
  if (user === undefined || bucket === undefined) return defaultAvatarLink();
  const chainUser: AvatarChainUser = {
    id: user.id,
    username: user.username,
    email: null,
    avatarEmail: user.avatarEmail,
    useCustomAvatar: user.useCustomAvatar,
  };
  return avatarLinkWithSize(bucket, chainUser, size);
}

// ---------------------------------------------------------------------------
// The URL resolution port (resolveCurrentRunForView + getCurrentRunJobsByPathParam,
// view.go:75-260 + 1097-1160) — the ID-first vs legacy index disambiguation
// ---------------------------------------------------------------------------

/** MaxJobNumPerRun (run_job.go:29) — job ordinals above it can only be IDs,
 *  so those URLs skip the index interpretation. */
export const MAX_JOB_NUM_PER_RUN = 256;

/** PathParamInt64 (routers/base.go): digits parse, junk parses to 0 — the
 *  negative arm too (a negative parses and misses the lookups). */
export function parsePathParamInt64(raw: string): number {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
}

export type ResolvedRunForView =
  | { outcome: "not-found" }
  | { outcome: "redirect"; location: string }
  | { outcome: "run"; run: RunRow };

/**
 * getCurrentRunByPathParam (view.go:60-73) — the POST twins' resolution
 * (ViewPost / Cancel both ride getCurrentRunJobsByPathParam, which uses THIS
 * lookup, not resolveCurrentRunForView): "latest" resolves the index-newest
 * run, everything else resolves by ROW ID only — a legacy index URL POSTs
 * resolve as IDs or 404 (the deliberate GET/POST asymmetry: only the GET
 * disambiguates-and-redirects).
 */
export async function resolveRunByPath(d1: D1, repoId: string, runRaw: string): Promise<RunRow | null> {
  if (runRaw === "latest") return getLatestRun(d1, repoId);
  const runId = parsePathParamInt64(runRaw);
  return getRunByRepoAndId(d1, repoId, runId);
}

/**
 * resolveCurrentRunForView (view.go:75-260): the URL's {run} segment is
 * ambiguous between the row id and the per-repo run number. `latest` and
 * `?by_id=1` resolve ID-based; `?by_index=1` forces the legacy
 * interpretation; the job-less paths use a best-effort ID-first fallback
 * (an index hit on an id miss REDIRECTS to the canonical id URL); job-bearing
 * paths probe the job id first and prefer the ID-based reading when both are
 * valid.
 *
 * `jobRaw` carries the URL's {job} segment ("" on the job-less shapes);
 * `repoLink` is `/{owner}/{repo}` for the redirect targets.
 */
export async function resolveRunForView(
  d1: D1,
  repoId: string,
  runRaw: string,
  jobRaw: string,
  byId: boolean,
  byIndex: boolean,
  repoLink: string,
): Promise<ResolvedRunForView> {
  if (runRaw === "latest" || byId) {
    const run =
      runRaw === "latest"
        ? await getLatestRun(d1, repoId)
        : await getRunByRepoAndId(d1, repoId, parsePathParamInt64(runRaw));
    return run === null ? { outcome: "not-found" } : { outcome: "run", run };
  }

  const runNum = parsePathParamInt64(runRaw);
  if (runNum <= 0) return { outcome: "not-found" };

  if (jobRaw === "") {
    // Job-less: best-effort ID-first (view.go:98-117).
    if (!byIndex) {
      const runById = await getRunByRepoAndId(d1, repoId, runNum);
      if (runById !== null) return { outcome: "run", run: runById };
    }
    const runByIndex = await getRunByRepoAndIndex(d1, repoId, runNum);
    if (runByIndex !== null) {
      return { outcome: "redirect", location: `${repoLink}/actions/runs/${runByIndex.id}` };
    }
    return { outcome: "not-found" };
  }

  const jobNum = parsePathParamInt64(jobRaw);
  // jobNum cannot be negative through the digits-only parse (upstream's
  // `jobNum < 0` NotFound arm is unreachable here); values ≥ MaxJobNumPerRun
  // are treated as IDs directly (view.go:135-138).
  if (jobNum >= MAX_JOB_NUM_PER_RUN) {
    const run = await getRunByRepoAndId(d1, repoId, runNum);
    return run === null ? { outcome: "not-found" } : { outcome: "run", run };
  }

  let runById: RunRow | null = null;
  if (!byIndex) {
    // Probe the repo-scoped job ID; accept only when it belongs to runNum.
    const job = await getRunJobByRepoAndId(d1, repoId, jobNum);
    if (job !== null) {
      const jobRun = await getRunByRepoAndId(d1, job.repoId, job.runId);
      if (jobRun !== null && jobRun.id === runNum) runById = jobRun;
    }
  }

  // The legacy index-based interpretation.
  let runByIndex: RunRow | null = null;
  let targetJobByIndex: RunJobRow | null = null;
  const indexRun = await getRunByRepoAndIndex(d1, repoId, runNum);
  if (indexRun !== null) {
    const indexJobs = await getLatestAttemptJobsByRun(d1, indexRun);
    if (jobNum < indexJobs.length) {
      runByIndex = indexRun;
      targetJobByIndex = indexJobs[jobNum] ?? null;
    }
  }

  if (runById === null && runByIndex === null) return { outcome: "not-found" };
  if (runById !== null && runByIndex === null) return { outcome: "run", run: runById };
  if (runById === null && runByIndex !== null && targetJobByIndex !== null) {
    return {
      outcome: "redirect",
      location: `${repoLink}/actions/runs/${runByIndex.id}/jobs/${targetJobByIndex.id}`,
    };
  }
  // Both valid: prefer the ID-based interpretation (view.go:240-244).
  return runById === null ? { outcome: "not-found" } : { outcome: "run", run: runById };
}

export interface ResolvedRunAttemptJobs {
  attempt: RunAttemptRow | null;
  jobs: RunJobRow[];
}

/**
 * getCurrentRunJobsByPathParam (view.go:1099-1160): resolve the attempt to
 * display (explicit path param > the job's own attempt > the latest) and
 * the attempt's jobs. The run-scoped job lookup missing is upstream's
 * ServerError arm (a job URL whose job row vanished between resolution and
 * load — reachable at /runs/{id}/jobs/{foreign-or-stale-≥256}); the port
 * throws into the app's 500 chrome (view.go:1119), same for a missing
 * explicit attempt number (view.go:1133).
 */
export async function resolveRunAttemptAndJobs(
  d1: D1,
  run: RunRow,
  attemptRaw: string,
  jobRaw: string,
): Promise<ResolvedRunAttemptJobs> {
  let selectedJob: RunJobRow | null = null;
  if (jobRaw !== "") {
    const jobParam = parsePathParamInt64(jobRaw);
    if (jobParam > 0) {
      selectedJob = await getRunJobByRunAndId(d1, run.id, jobParam);
      if (selectedJob === null) {
        throw new Error(`actions: GetRunJobByRunAndID missing job ${jobParam} for run ${run.id}`);
      }
    }
  }

  let attempt: RunAttemptRow | null;
  const attemptNum = attemptRaw === "" ? 0 : parsePathParamInt64(attemptRaw);
  if (attemptNum > 0) {
    attempt = await getRunAttemptByRunIdAndAttemptNum(d1, run.id, attemptNum);
    if (attempt === null) {
      throw new Error(`actions: GetRunAttemptByRunIDAndAttemptNum missing attempt ${attemptNum} for run ${run.id}`);
    }
  } else if (selectedJob !== null && selectedJob.runAttemptId > 0) {
    attempt = await getRunAttemptByRepoAndId(d1, selectedJob.repoId, selectedJob.runAttemptId);
    if (attempt === null) {
      throw new Error(`actions: GetRunAttemptByRepoAndID missing attempt ${selectedJob.runAttemptId}`);
    }
  } else {
    attempt = await getLatestAttemptOfRun(d1, run);
  }

  const resolvedAttemptId = attempt === null ? 0 : attempt.id;
  const jobs = await getRunJobsByRunAndAttemptId(d1, run.id, resolvedAttemptId);
  return { attempt, jobs };
}

/** getRunViewLink (view.go:1090-1095): the latest attempt (or a legacy null)
 *  links the bare run URL; a historical attempt links /attempts/{n}. */
export function runViewLink(runLink: string, run: RunRow, attempt: RunAttemptRow | null): string {
  if (attempt === null || run.latestAttemptId === attempt.id) return runLink;
  return `${runLink}/attempts/${attempt.attempt}`;
}

// ---------------------------------------------------------------------------
// The ViewResponse contract (view.go:291-530 — the field list the test
// matrix pins against)
// ---------------------------------------------------------------------------

export interface ViewStepLogInput {
  step: number;
  cursor: number;
  expanded: boolean;
}

export interface ViewRunAttemptItem {
  attempt: number;
  status: string;
  done: boolean;
  link: string;
  current: boolean;
  latest: boolean;
  triggeredAt: number;
  triggerUserName: string;
  triggerUserLink: string;
  triggerUserAvatar: string;
}

export interface ViewJobItem {
  id: number;
  link: string;
  jobId?: string;
  name: string;
  status: string;
  canRerun: boolean;
  duration: string;
  needs?: string[];
  parentJobID: number;
  isReusableCaller: boolean;
  callUses?: string;
}

export interface ViewJobSummaryItem {
  jobId: number;
  jobName: string;
  summaryHTML: string;
}

export interface ViewArtifactsItem {
  name: string;
  size: number;
  status: string;
  expiresUnix: number;
  previewLink?: string;
}

/** ViewJobStep (view.go:401-405) — the currentJob steps' shape. */
export interface ViewJobStep {
  summary: string;
  duration: string;
  status: string;
}

/** ViewStepLogLine (view.go:413-417) — timestamp is float seconds (upstream
 *  UnixNano()/1e9). */
export interface ViewStepLogLine {
  index: number;
  message: string;
  timestamp: number;
}

/** ViewStepLog (view.go:407-411) — the advanced cursor + the new lines. */
export interface ViewStepLog {
  step: number;
  cursor: number;
  lines: ViewStepLogLine[];
}

export interface ViewResponse {
  artifacts: ViewArtifactsItem[];
  state: {
    run: {
      repoId: string;
      link: string;
      viewLink: string;
      index: number;
      title: string;
      titleHTML: string;
      status: string;
      canCancel: boolean;
      canApprove: boolean;
      canRerun: boolean;
      canRerunFailed: boolean;
      canDeleteArtifact: boolean;
      done: boolean;
      workflowID: string;
      workflowLink: string;
      canViewWorkflowFile: boolean;
      isSchedule: boolean;
      runAttempt: number;
      attempts: ViewRunAttemptItem[];
      jobs: ViewJobItem[];
      commit: {
        shortSHA: string;
        link: string;
        pusher: { displayName: string; link: string; avatarLink?: string };
        branch: { name: string; link: string; isDeleted: boolean };
      };
      pullRequest?: { index: string; link: string };
      duration: string;
      triggeredAt: number;
      triggerEvent: string;
      jobSummaries?: ViewJobSummaryItem[];
    };
    currentJob: {
      title: string;
      detail: string;
      steps: ViewJobStep[];
    };
  };
  logs: {
    stepsLog: ViewStepLog[];
  };
}

// ---------------------------------------------------------------------------
// The C3 arm: the currentJob steps + the log cursors (view.go:835-917's
// convertToViewModel over FullSteps, modules/actions/task_state.go — the
// census C3 unit's read arms, riding M1b's log store)
// ---------------------------------------------------------------------------

/** "Logs have been purged because they were too old."
 *  ("actions.runs.expire_log_message" — the log-expired arm's one line). */
export const EXPIRED_LOG_MESSAGE = "Logs have been purged because they were too old.";

/** The step shape the view arms read: the stored rows verbatim plus the two
 *  synthesized boundary steps, each carrying only the fields FullSteps
 *  assigns (upstream constructs the pre/post steps as fresh structs —
 *  zero-valued Updated is the duration fallback's OFF state). */
interface FullStep {
  name: string;
  logIndex: number;
  logLength: number;
  started: Date | null;
  stopped: Date | null;
  status: number;
  /** Null on the synthesized steps (upstream's zero TimeStamp). */
  updated: Date | null;
}

function toFullStep(step: TaskStepRow): FullStep {
  return {
    name: step.name,
    logIndex: step.logIndex,
    logLength: step.logLength,
    started: step.started,
    stopped: step.stopped,
    status: step.status,
    updated: step.updated,
  };
}

/** Status.HasRun (status.go:58-60) — success or failure. */
function statusHasRun(status: number): boolean {
  return status === 1 /* success */ || status === 2 /* failure */;
}

/** fullStepsOfEmptySteps (task_state.go:97-127): a task with no parsed steps
 *  renders exactly "Set up job" + "Complete job" carrying the task's own
 *  log range; a done task colors both (success → both success, else
 *  cancelled). */
function fullStepsOfEmptySteps(task: TaskRow): FullStep[] {
  const preStep: FullStep = {
    name: "Set up job",
    logIndex: 0,
    logLength: task.logLength,
    started: task.started,
    stopped: task.stopped,
    status: ACTION_STATUS_RUNNING,
    updated: null,
  };
  const postStep: FullStep = {
    name: "Complete job",
    logIndex: task.logLength,
    logLength: 0,
    started: task.stopped,
    stopped: task.stopped,
    status: ACTION_STATUS_WAITING,
    updated: null,
  };
  if (isDoneStatusValue(task.status)) {
    preStep.status = task.status;
    postStep.status = task.status === 1 /* success */ ? 1 : ACTION_STATUS_CANCELLED;
  }
  return [preStep, postStep];
}

/** FullSteps (task_state.go:16-95) — the stored steps bracketed by the
 *  synthesized "Set up job" / "Complete job" boundary steps. A
 *  runner-reported layout (steps[0].IsReport(), stage != 0) rides verbatim —
 *  the runner reports its own setup and cleanup. */
export function fullStepsOfTask(task: TaskRow, steps: TaskStepRow[]): FullStep[] {
  if (steps.length === 0) return fullStepsOfEmptySteps(task);
  if (steps[0]!.stage !== 0) return steps.map(toFullStep);

  // firstStep: the first step that has run or is running (preStep excluded —
  // it does not exist yet); lastHasRunStep: the last step that has run — its
  // Stopped becomes postStep's Started once nothing is left to run.
  let firstStep: TaskStepRow | null = null;
  let lastHasRun: TaskStepRow | null = null;
  let logIndex = 0;
  for (const step of steps) {
    if (firstStep === null && (statusHasRun(step.status) || step.status === ACTION_STATUS_RUNNING)) {
      firstStep = step;
    }
    if (statusHasRun(step.status)) lastHasRun = step;
    logIndex += step.logLength;
  }

  const preStep: FullStep = {
    name: "Set up job",
    logIndex: 0,
    logLength: task.logLength,
    started: task.started,
    stopped: null,
    status: ACTION_STATUS_RUNNING,
    updated: null,
  };
  // No step has run or is running: preStep IS the task.
  if (firstStep === null) {
    preStep.stopped = task.stopped;
    preStep.status = task.status;
  } else {
    preStep.logLength = firstStep.logIndex;
    preStep.stopped = firstStep.started;
    preStep.status = 1; // success
  }
  logIndex += preStep.logLength;
  const lastHasRunStep = lastHasRun !== null ? toFullStep(lastHasRun) : preStep;

  const postStep: FullStep = {
    name: "Complete job",
    logIndex: 0,
    logLength: 0,
    started: null,
    stopped: null,
    status: ACTION_STATUS_WAITING,
    updated: null,
  };
  // Nothing left to run, or the last run step failed: postStep has started.
  const lastStored = steps[steps.length - 1]!;
  if (lastHasRunStep.status === ACTION_STATUS_FAILURE || isDoneStatusValue(lastStored.status)) {
    postStep.logIndex = logIndex;
    postStep.logLength = task.logLength - postStep.logIndex;
    postStep.started = lastHasRunStep.stopped;
    postStep.status = ACTION_STATUS_RUNNING;
  }
  if (isDoneStatusValue(task.status)) {
    postStep.status = task.status;
    postStep.stopped = task.stopped;
  }
  return [preStep, ...steps.map(toFullStep), postStep];
}

/** ActionTaskStep.Duration() (task_step.go:36-38) over the step's own
 *  timestamps. Synthesized steps carry updated = null — upstream's zero
 *  TimeStamp, whose fallback arm can never fire, so the fallback epoch
 *  below (0 < started always) returns 0 exactly like upstream. */
function fullStepDurationMs(step: FullStep): number {
  return calculateDurationMs(step.started, step.stopped, step.status, step.updated ?? new Date(0));
}

/**
 * convertToViewModel (view.go:835-917): the steps list plus the log lines
 * each EXPANDED cursor's step still needs. The cursor protocol: `cursor`
 * counts the step's lines the client already holds; the answer reports
 * `cursor + len(lines)` and the 1-based line indexes — a `validCursor`
 * miss (the step's next line not stored yet) answers the SAME cursor with
 * empty lines so the client retries.
 */
export async function convertToViewModel(
  env: Env,
  cursors: ViewStepLogInput[],
  task: TaskRow,
  steps: TaskStepRow[],
): Promise<{ steps: ViewJobStep[]; logs: ViewStepLog[] }> {
  const full = fullStepsOfTask(task, steps);

  const viewSteps = full.map((v) => {
    let status = v.status;
    // The cancelling overlay: running steps read cancelling with their task.
    if (task.status === ACTION_STATUS_CANCELLING && status === ACTION_STATUS_RUNNING) {
      status = ACTION_STATUS_CANCELLING;
    }
    // Waiting renders as "pending" in the steps list (view.go:849's Iif).
    const wire = status === ACTION_STATUS_WAITING ? 9 : status; // StatusPending
    return {
      summary: v.name,
      duration: goDurationString(fullStepDurationMs(v)),
      status: actionStatusName(wire),
    };
  });

  const logs: ViewStepLog[] = [];
  for (const cursor of cursors) {
    if (!cursor.expanded || cursor.step < 0 || cursor.step >= full.length) continue;
    const step = full[cursor.step]!;

    // The log-expired arm: one consistent line on the first fetch only.
    if (task.logExpired) {
      if (cursor.cursor === 0) {
        logs.push({
          step: cursor.step,
          cursor: 1,
          lines: [
            {
              index: 1,
              message: EXPIRED_LOG_MESSAGE,
              // "doesn't mean anything" upstream — the task's updated stands in.
              timestamp: task.updated.getTime() / 1000,
            },
          ],
        });
      }
      continue;
    }

    const lines: ViewStepLogLine[] = [];
    const index = step.logIndex + cursor.cursor;
    // Upstream's third guard bounds by len(task.LogIndexes) — "task data
    // older than step data". One LogIndexes entry per stored row makes our
    // row-count column the same bound (update.ts's UpdateLog advances both
    // atomically), and our read seam is ROW-indexed (logs.ts's header), so
    // no byte-offset decode is needed here.
    const validCursor = cursor.cursor >= 0 && cursor.cursor < step.logLength && index < task.logLength;

    if (validCursor) {
      const length = step.logLength - cursor.cursor;
      const logRows = await readTaskLogs(env, task, index, length);
      for (let i = 0; i < logRows.length; i++) {
        const row = logRows[i]!;
        lines.push({
          index: cursor.cursor + i + 1, // start at 1
          message: row.content,
          timestamp: row.time.getTime() / 1000,
        });
      }
    }

    logs.push({ step: cursor.step, cursor: cursor.cursor + lines.length, lines });
  }

  return { steps: viewSteps, logs };
}

/** The builder's resolved inputs (the handler's one-time computation). */
export interface BuildViewResponseInput {
  /** The request env (the avatar bucket + the engine cell for the branch
   *  existence read). */
  env: Env;
  repo: RepoRow;
  /** The landed repo write grant (CanWrite(TypeActions) reduction — the
   *  module header; the handler computes it once via canWriteRepo). */
  canWriteActions: boolean;
  /** Whether a viewer is signed in (ctx.IsSigned — the artifact preview
   *  arm's first gate). */
  isSigned: boolean;
  /** The POST twin's logCursors body (the C3 arm's tail requests). */
  logCursors?: ViewStepLogInput[];
  /** The URL's path params (the strings the mount/JSON armed from). */
  attemptRaw: string;
  jobRaw: string;
}

export type BuildViewResponseOutcome =
  | { outcome: "not-found" }
  | { outcome: "response"; response: ViewResponse };

/**
 * The ViewPost port: fillViewRunResponseSummary + fillViewRunResponseCurrentJob's
 * shell over one resolved (run, attempt, jobs) triple.
 */
export async function buildViewResponse(
  d1: D1,
  run: RunRow,
  resolved: ResolvedRunAttemptJobs,
  input: BuildViewResponseInput,
): Promise<BuildViewResponseOutcome> {
  const { repo } = input;
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const runLink = `${repoLink}/actions/runs/${run.id}`;
  const attempt = resolved.attempt;
  const jobs = resolved.jobs;
  const runAttemptId = attempt === null ? 0 : attempt.id;
  const effectiveStatus = attempt === null ? run.status : attempt.status;
  const done = isDoneStatusValue(effectiveStatus);
  const isCancelling = effectiveStatus === ACTION_STATUS_CANCELLING;
  // Latest when the run has no attempts (legacy) or the viewed attempt is
  // the run's latest (view.go:372-373).
  const isLatestAttempt = run.latestAttemptId === 0 || runAttemptId === run.latestAttemptId;

  // One users read covers the run's trigger user + every attempt's trigger
  // user (LoadTriggerUser's joined shape).
  const attemptRows = await listRunAttemptsByRunId(d1, run.id);
  const usersById = await getUsersByIds(d1, [
    run.triggerUserId,
    ...attemptRows.map((a) => a.triggerUserId),
  ]);
  const triggerUser = usersById.get(run.triggerUserId);
  const pusherAvatar = await userAvatarLink(input.env.REPO_PACKS, triggerUser, 16);

  // --- the run block (fillViewRunResponseSummary, view.go:542-707) ----------

  const canCancel = isLatestAttempt && !done && !isCancelling && input.canWriteActions;
  const canApprove =
    isLatestAttempt && run.needApproval && !isDoneStatusValue(run.status) && input.canWriteActions; // IsAwaitingApproval
  const canRerun = isLatestAttempt && done && jobs.length > 0 && input.canWriteActions;
  const canRerunFailed =
    canRerun &&
    jobs.some((job) => job.status === ACTION_STATUS_FAILURE || job.status === ACTION_STATUS_CANCELLED);

  const titleHTML = renderMarkdownToHtml({
    text: firstMessageLine(run.title),
    mode: "markdown",
    context: `${repo.ownerNamespace}/${repo.slug}`,
    wiki: false,
    origin: "",
  });

  const workflowLink =
    isLatestAttempt || run.isScopedRun
      ? `${repoLink}/actions/?workflow=${encodeURIComponent(run.workflowId)}`
      : "";
  const isSchedule = run.scheduleId > 0;

  const viewLink = runViewLink(runLink, run, attempt);

  const attempts: ViewRunAttemptItem[] = [];
  for (const attemptRow of attemptRows) {
    const attemptUser = usersById.get(attemptRow.triggerUserId);
    attempts.push({
      attempt: attemptRow.attempt,
      status: actionStatusName(attemptRow.status),
      done: isDoneStatusValue(attemptRow.status),
      link: runViewLink(runLink, run, attemptRow),
      current: attemptRow.id === runAttemptId,
      latest: attemptRow.id === run.latestAttemptId,
      triggeredAt: Math.floor(attemptRow.created.getTime() / 1000),
      triggerUserName: userDisplayName(attemptUser),
      triggerUserLink: userHomeLink(attemptUser),
      triggerUserAvatar: await userAvatarLink(input.env.REPO_PACKS, attemptUser, 16),
    });
  }

  // Jobs (the resolved attempt's rows, id ASC — SortMatrixGroupsByName is a
  // v1 no-op, the module header).
  const jobItems: ViewJobItem[] = jobs.map((job) => ({
    id: job.id,
    link: `${runLink}/jobs/${job.id}`,
    ...(job.jobId !== "" ? { jobId: job.jobId } : {}),
    name: job.name,
    status: actionStatusName(job.status),
    canRerun,
    duration: rowDurationString(job.started, job.stopped, job.status, job.updated),
    ...(parsedStringArray(job.needs).length > 0 ? { needs: parsedStringArray(job.needs) } : {}),
    parentJobID: job.parentJobId,
    isReusableCaller: job.isReusableCaller,
    ...(job.callUses !== "" ? { callUses: job.callUses } : {}),
  }));

  // The commit + ref summary (viewSummaryBranchFromRun / viewPullRequestFromRun
  // minus the deferred head-PR arm — the module header).
  const refSummary = await resolveRefSummary(input, run, repoLink, triggerUser, pusherAvatar);
  const duration = rowDurationString(
    attempt === null ? run.started : attempt.started,
    attempt === null ? run.stopped : attempt.stopped,
    effectiveStatus,
    attempt === null ? run.updated : attempt.updated,
  );
  const triggeredAt = Math.floor((attempt === null ? run.created : attempt.created).getTime() / 1000);

  // Job summaries — per-step markdown rows grouped per job (view.go:690-707):
  // each step renders independently so an unclosed construct cannot bleed
  // into the next; a workflow-level summary (jobId 0) names the workflow.
  const jobSummaries: ViewJobSummaryItem[] = [];
  const summaryRows = await listActionRunJobSummaries(
    d1,
    repo.id,
    run.id,
    runAttemptId,
    parsePathParamInt64(input.jobRaw),
  );
  if (summaryRows.length > 0) {
    const jobNameById = new Map<number, string>([[0, run.workflowId]]);
    for (const job of jobs) jobNameById.set(job.id, job.name);
    const renderSummary = (content: string): string =>
      renderMarkdownToHtml({
        text: content,
        mode: "markdown",
        context: `${repo.ownerNamespace}/${repo.slug}`,
        wiki: false,
        origin: "",
      });
    for (const row of summaryRows) {
      if (row.contentType !== "text/markdown") continue; // JobSummaryContentTypeMarkdown
      const last = jobSummaries[jobSummaries.length - 1];
      if (last === undefined || last.jobId !== row.jobId) {
        jobSummaries.push({
          jobId: row.jobId,
          jobName: jobNameById.get(row.jobId) ?? "",
          summaryHTML: renderSummary(row.content),
        });
      } else {
        last.summaryHTML += renderSummary(row.content);
      }
    }
  }

  // Artifacts (ListUploadedArtifactsMetaByRunAttempt — the GROUP BY roll-up);
  // the preview link stays empty until C4's preview route lands (the module
  // header's dead-link note).
  const artifactRows = await listUploadedArtifactsMetaByRunAttempt(d1, repo.id, run.id, runAttemptId);
  const artifacts: ViewArtifactsItem[] = artifactRows.map((art) => ({
    name: art.artifactName,
    size: art.fileSize,
    status: art.status === 4 /* ArtifactStatusExpired */ ? "expired" : "completed",
    expiresUnix: art.expiredUnix,
    ...(artifactPreviewLinkEnabled && input.isSigned && isArtifactPreviewSizeAllowed(art.fileSize)
      ? { previewLink: `${repoLink}/actions/artifacts/${art.id}/preview` }
      : {}),
  }));

  // --- the currentJob block (fillViewRunResponseCurrentJob's shell) ---------

  const jobParam = parsePathParamInt64(input.jobRaw);
  let current: RunJobRow | undefined;
  if (jobParam > 0) {
    current = jobs.find((job) => job.id === jobParam);
    if (current === undefined) return { outcome: "not-found" }; // view.go:735-737's NotFound arm
  }

  // IsAwaitingApproval reads the RUN's status (run.go:84-86), not the
  // attempt's — the canApprove + detail arms share it.
  const runAwaitingApproval = run.needApproval && !isDoneStatusValue(run.status);
  let currentTitle = "";
  let currentDetail = "";
  if (current !== undefined) {
    currentTitle = current.name;
    currentDetail = actionStatusDisplay(current.status);
    if (runAwaitingApproval) {
      currentDetail = repoActionsViewDetailLocale.needApproval;
    } else {
      const pendingDetail = await describePendingJobDetail(d1, current, jobs);
      if (pendingDetail !== "") currentDetail = pendingDetail;
    }
  }

  // The C3 arm: the effective task (EffectiveTaskID, run_job.go:158-163)
  // feeds FullSteps + the log cursors. No task (a waiting job's taskId 0, or
  // a stale id whose row vanished — upstream's GetTaskByID error arm aside)
  // keeps the empty arrays, view.go's make([]…, 0) shell.
  let stepViews: ViewJobStep[] = [];
  let stepLogs: ViewStepLog[] = [];
  if (current !== undefined) {
    const effectiveTaskId = current.taskId > 0 ? current.taskId : current.sourceTaskId;
    if (effectiveTaskId > 0) {
      const taskRows = await drizzle(d1)
        .select()
        .from(actionTasks)
        .where(eq(actionTasks.id, effectiveTaskId))
        .limit(1);
      const task = taskRows[0];
      if (task !== undefined) {
        const stepRows = await getTaskStepsByTaskId(d1, task.id);
        const model = await convertToViewModel(input.env, input.logCursors ?? [], task, stepRows);
        stepViews = model.steps;
        stepLogs = model.logs;
      }
    }
  }

  const response: ViewResponse = {
    artifacts,
    state: {
      run: {
        repoId: repo.id,
        link: runLink,
        viewLink,
        index: run.index,
        title: run.title,
        titleHTML,
        status: actionStatusName(effectiveStatus),
        canCancel,
        canApprove,
        canRerun,
        canRerunFailed,
        canDeleteArtifact: done && input.canWriteActions,
        done,
        workflowID: run.workflowId,
        workflowLink,
        // Scoped runs read their source repo here (canViewScopedWorkflowFile);
        // v1 rows never carry isScopedRun (the parity columns are unread).
        canViewWorkflowFile: true,
        isSchedule,
        runAttempt: attempt === null ? 0 : attempt.attempt,
        attempts,
        jobs: jobItems,
        commit: refSummary.commit,
        ...(refSummary.pullRequest !== null ? { pullRequest: refSummary.pullRequest } : {}),
        duration,
        triggeredAt,
        triggerEvent: run.triggerEvent,
        ...(jobSummaries.length > 0 ? { jobSummaries } : {}),
      },
      currentJob: {
        title: currentTitle,
        detail: currentDetail,
        // The C3 arm: FullSteps over the effective task's rows; the empty
        // array (never null) when the job has no task.
        steps: stepViews,
      },
    },
    logs: { stepsLog: stepLogs },
  };
  return { outcome: "response", response };
}

/** The commit block + the pull-request arm (ViewCommit + the ref summary
 *  pair, view.go:424-494 + 673-684). */
async function resolveRefSummary(
  input: BuildViewResponseInput,
  run: RunRow,
  repoLink: string,
  triggerUser: ViewUserRow | undefined,
  pusherAvatar: string,
): Promise<{
  commit: ViewResponse["state"]["run"]["commit"];
  pullRequest: ViewResponse["state"]["run"]["pullRequest"] | null;
}> {
  const shortSHA = run.commitSha.slice(0, 10); // base.ShortSha — TruncateRunes(10)
  const pusher = {
    displayName: userDisplayName(triggerUser),
    link: userHomeLink(triggerUser),
    avatarLink: pusherAvatar,
  };

  // viewSummaryBranchFromRun (view.go:436-494): a pull_request payload's
  // head names "owner:branch"; otherwise the run's own ref (PrettyRef) with
  // the deleted-branch marker from the engine's refs read.
  const prPayload = parsePullRequestEventPayload(run.event, run.eventPayload);
  let branch: ViewResponse["state"]["run"]["commit"]["branch"];
  if (prPayload !== null && prPayload.head !== null && prPayload.head.ref !== "") {
    let name = prPayload.head.name ?? shortRefName(prPayload.head.ref);
    if (
      prPayload.head.name === undefined &&
      prPayload.head.repoFullName !== null &&
      prPayload.head.repoFullName !== "" &&
      String(prPayload.head.repoId ?? "") !== String(run.repoId) &&
      !name.includes(":")
    ) {
      const ownerName = prPayload.head.repoFullName.includes("/")
        ? (prPayload.head.repoFullName.split("/")[0] ?? "")
        : prPayload.head.repoFullName;
      if (ownerName !== "") name = `${ownerName}:${name}`;
    }
    let link = "";
    if (prPayload.head.repoLink !== "" && prPayload.head.ref !== "") {
      link = `${prPayload.head.repoLink}/src/${refWebLinkPath(prPayload.head.ref)}`;
    }
    branch = { name, link, isDeleted: false };
  } else {
    const refName = run.ref;
    const isPull = refName.startsWith("refs/pull/");
    const pullIndex = isPull ? refName.slice("refs/pull/".length).replace(/\/head$/, "") : "";
    const branchName = shortRefName(refName);
    branch = {
      // PrettyRef: "#N" for pull refs, the ShortName otherwise.
      name: isPull ? `#${pullIndex}` : branchName,
      // RefLink: the PR page for pull refs, /src/{RefWebLinkPath} otherwise.
      link: isPull ? `${repoLink}/pulls/${pullIndex}` : `${repoLink}/src/${refWebLinkPath(refName)}`,
      isDeleted: false,
    };
    if (!isPull && refName.startsWith("refs/heads/")) {
      // IsBranchExist (view.go:491-493) — one engine refs read answers the
      // deleted-branch marker (the module header's no-cache note).
      const reads = engineReads(input.env, input.repo);
      const refs = await reads.listRefs();
      const exists = (refs?.refs ?? []).some((ref) => ref.name === refName);
      branch.isDeleted = !exists;
    }
  }

  const commit = {
    shortSHA,
    link: `${repoLink}/commit/${run.commitSha}`,
    pusher,
    branch,
  };

  // viewPullRequestFromRun (view.go:424-434 + 455-460): a pull ref names
  // "#N" and links the PR page; a pull_request payload's index rides too.
  let pullRequest: ViewResponse["state"]["run"]["pullRequest"] | null = null;
  if (run.ref.startsWith("refs/pull/")) {
    const index = run.ref.slice("refs/pull/".length).replace(/\/head$/, "");
    pullRequest = { index: `#${index}`, link: `${repoLink}/pulls/${index}` };
  } else if (prPayload !== null && prPayload.index > 0) {
    pullRequest = { index: `#${prPayload.index}`, link: `${repoLink}/pulls/${prPayload.index}` };
  }
  return { commit, pullRequest };
}

/** GetPullRequestEventPayload's reduction (run.go:184-192): the pull_request
 *  (and pull_request_review) event payload's head summary — only the fields
 *  the two view arms read. */
interface PrPayloadSummary {
  index: number;
  head: {
    name: string | null;
    ref: string;
    repoId: string | number | null;
    repoFullName: string | null;
    repoLink: string;
  } | null;
}

function parsePullRequestEventPayload(event: string, eventPayload: string): PrPayloadSummary | null {
  if (!event.startsWith("pull_request")) return null; // IsPullRequest + IsPullRequestReview
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventPayload === "" ? "{}" : eventPayload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const rawIndex = record["number"];
  // GetPullRequestEventPayload reads the payload's own pull_request object;
  // the head fields the view arms read live under .head (+ .head.repo).
  const prRecord =
    typeof record["pull_request"] === "object" && record["pull_request"] !== null
      ? (record["pull_request"] as Record<string, unknown>)
      : record;
  const headRecord =
    typeof prRecord["head"] === "object" && prRecord["head"] !== null
      ? (prRecord["head"] as Record<string, unknown>)
      : null;
  const headRepo =
    headRecord !== null && typeof headRecord["repo"] === "object" && headRecord["repo"] !== null
      ? (headRecord["repo"] as Record<string, unknown>)
      : null;
  const headRef = typeof headRecord?.["ref"] === "string" ? headRecord["ref"] : "";
  const headName = typeof headRecord?.["label"] === "string" ? headRecord["label"] : null;
  const headRepoIdRaw = headRepo?.["id"];
  const headRepoId = typeof headRepoIdRaw === "string" || typeof headRepoIdRaw === "number" ? headRepoIdRaw : null;
  let repoLink = "";
  if (headRepo !== null) {
    // head.Repository.Link (relative) with the HTMLURL fallback — the same
    // pair view.go:483-489 reads.
    if (typeof headRepo["owner"] === "object" && headRepo["owner"] !== null) {
      const ownerName = (headRepo["owner"] as Record<string, unknown>)["login"];
      if (typeof headRepo["name"] === "string" && typeof ownerName === "string") {
        repoLink = `/${ownerName}/${headRepo["name"]}`;
      }
    }
    if (repoLink === "" && typeof headRepo["html_url"] === "string" && headRepo["html_url"] !== "") {
      try {
        repoLink = new URL(headRepo["html_url"]).pathname;
      } catch {
        repoLink = "";
      }
    }
  }
  return {
    index: typeof rawIndex === "number" ? rawIndex : 0,
    head:
      headRef === "" && headRepo === null
        ? null
        : {
            name: headName,
            ref: headRef,
            repoId: headRepoId,
            repoFullName: typeof headRepo?.["full_name"] === "string" ? headRepo["full_name"] : null,
            repoLink,
          },
  };
}

/** git.RefName.ShortName's reduction for the two ref families the view
 *  reads (branches and tags; a plain commit sha stays verbatim). */
function shortRefName(ref: string): string {
  for (const prefix of ["refs/heads/", "refs/tags/"]) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

/** git.RefName.RefWebLinkPath (modules/git/ref.go:238-247) — the exact port:
 *  branches/tags prefix their segment, a valid object id prefixes "commit",
 *  ANY other ref spelling (e.g. a bare PR head branch name) carries NO type
 *  and returns the empty string (the link composes "/src/" bare). */
function refWebLinkPath(ref: string): string {
  const escapeSegments = (name: string): string =>
    name
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  if (ref.startsWith("refs/heads/")) return `branch/${escapeSegments(ref.slice("refs/heads/".length))}`;
  if (ref.startsWith("refs/tags/")) return `tag/${escapeSegments(ref.slice("refs/tags/".length))}`;
  if (/^[0-9a-f]{40,64}$/.test(ref)) return `commit/${ref}`; // IsStringValidObjectID
  return "";
}

/** RenderCommitMessage's first-line cut (util_render.go:50-57). */
function firstMessageLine(message: string): string {
  return message.trim().split("\n", 1)[0]?.trim() ?? "";
}

/** isArtifactPreviewSizeAllowed (view_artifact.go:179-182) — the default
 *  10 MiB cap (setting.Actions.ArtifactPreviewMaxSize), negative = unlimited
 *  (our constant is positive; the unlimited posture is upstream's env arm). */
export const ARTIFACT_PREVIEW_MAX_SIZE = 10 * 1024 * 1024;

export function isArtifactPreviewSizeAllowed(size: number): boolean {
  return size <= ARTIFACT_PREVIEW_MAX_SIZE;
}

/** The C4 gate, FLIPPED: the preview page + raw serving live in
 *  pages/repo-actions-artifacts.ts (the census C4 module); the mounting
 *  route arms are the orchestrator's ui/index.ts edit C4's landing reports.
 *  The link and the routes must land together (the dead-link rule). */
const artifactPreviewLinkEnabled = true;

/** pendingNeeds (view.go:889-908): the needs entries whose same-parent jobs
 *  are missing or unfinished. */
function pendingNeeds(current: RunJobRow, jobs: RunJobRow[]): string[] {
  const needs = parsedStringArray(current.needs);
  const pending: string[] = [];
  for (const need of needs) {
    const siblings = jobs.filter(
      (job) => job.parentJobId === current.parentJobId && job.jobId === need,
    );
    const allDone = siblings.length > 0 && siblings.every((job) => isDoneStatusValue(job.status));
    if (!allDone) pending.push(need);
  }
  return pending;
}

/** describePendingJobDetail (view.go:836-884): why a pending/waiting job has
 *  not started — a pending job names its unfinished needs; a waiting caller
 *  distinguishes no-runner-online / no-label-match / busy-runner. The
 *  online set rides FindRunnerOptions{IsOnline: true} — last_online inside
 *  RunnerOfflineTime (runner.go:76, one minute); disabled rows never enter. */
const RUNNER_OFFLINE_MS = 60_000;

async function describePendingJobDetail(d1: D1, current: RunJobRow, jobs: RunJobRow[]): Promise<string> {
  if (current.status === 9 /* pending */) {
    const pending = pendingNeeds(current, jobs);
    if (pending.length > 0) {
      return repoActionsViewDetailLocale.waitingForDependentJobs.replace("%s", pending.join(", "));
    }
    return "";
  }
  // A caller waits on its called jobs, never on a runner (view.go:860).
  if (current.status === ACTION_STATUS_WAITING && !current.isReusableCaller) {
    const runners = await drizzle(d1)
      .select()
      .from(actionRunners)
      .where(eq(actionRunners.isDisabled, false));
    const nowMs = Date.now();
    const online = runners.filter(
      (runner) => runner.lastOnline !== null && nowMs - runner.lastOnline.getTime() < RUNNER_OFFLINE_MS,
    );
    if (online.length === 0) return repoActionsViewDetailLocale.noRunnerOnline;
    const runsOn = parsedStringArray(current.runsOn);
    const matching = online.find((runner) =>
      canMatchLabels(JSON.parse(runner.agentLabels) as string[], runsOn),
    );
    if (matching === undefined) {
      return repoActionsViewDetailLocale.noMatchingOnlineRunner.replace("%s", runsOn.join(", "));
    }
    return repoActionsViewDetailLocale.waitingForAvailableRunner;
  }
  return "";
}

/** The urlencoded JSON array column reader (needs/runs_on — upstream
 *  `xorm:"JSON TEXT"`). */
function parsedStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw === "" ? "[]" : raw);
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    // fall through
  }
  return [];
}

// ---------------------------------------------------------------------------
// The ViewRequest POST body (view.go:282-290 — the client's refresh polling
// arm; the cursors ride the C3 arm's per-step tail requests)
// ---------------------------------------------------------------------------

export function parseViewRequest(body: string): { logCursors: ViewStepLogInput[] } {
  if (body.trim() === "") return { logCursors: [] };
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const cursors = (parsed as Record<string, unknown>)["logCursors"];
      if (Array.isArray(cursors)) {
        return {
          logCursors: cursors
            .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
            .map((entry) => ({
              step: typeof entry["step"] === "number" ? entry["step"] : 0,
              cursor: typeof entry["cursor"] === "number" ? entry["cursor"] : 0,
              expanded: entry["expanded"] === true,
            })),
        };
      }
    }
  } catch {
    // A malformed body is upstream's form-binding miss — an empty request.
  }
  return { logCursors: [] };
}

/** The POST twin's bounded body read (the forms.ts posture: the
 *  content-length cap bounds the arrayBuffer read — the streaming rule is
 *  about unbounded bodies; a non-JSON or oversized body reads as the empty
 *  request, upstream's form-binding miss). 64 KiB: the cursors array is one
 *  entry per step of one job. */
export const VIEW_REQUEST_MAX_BYTES = 64 * 1024;

export async function readViewRequest(req: Request): Promise<{ logCursors: ViewStepLogInput[] }> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > VIEW_REQUEST_MAX_BYTES) return { logCursors: [] };
  try {
    return parseViewRequest(new TextDecoder().decode(await req.arrayBuffer()));
  } catch {
    return { logCursors: [] };
  }
}

// ---------------------------------------------------------------------------
// The cancel arm (the census C5-adjacent POST — CancelRun's v1 reduction;
// the module header's divergence list)
// ---------------------------------------------------------------------------

export type CancelActionRunOutcome = { outcome: "cancelled"; cancelledJobs: number };

/** taskReportTimeout (task.go:65) — a runner that stopped reporting for a
 *  minute never acknowledges the cancellation; skip the handshake. */
const TASK_REPORT_TIMEOUT_MS = 60_000;

/**
 * CancelRun's v1 reduction (services/actions/cancel.go:26-90):
 *   1. cancellableJobs: every not-done job (the `always()`-condition
 *      exemption needs the workflow YAML parse — M1b/M3; the force arm and
 *      the unstarted-run shortcut collapse into the same not-done filter on
 *      v1 rows);
 *   2. per job: no task → CAS the job to cancelled (`task_id = 0` guards
 *      the claim race, cancelOneJob run_job.go:804-819); a task → the
 *      StopTask handshake (runner HasCancellingSupport + the report timeout
 *      decide cancelling vs cancelled, task.go:447-511);
 *   3. settle: re-aggregate the attempt + run from the refreshed jobs
 *      (refreshRunStatus's attempt/run mirror, run_job.go:567-600 — the
 *      M1b substitute arm, re-issued here; dedup note on landing);
 *   4. wake: a landed cancelled job bumps the dispatch counter when waiting
 *      work remains (UpdateRunJob's done-arm bump, run_job.go:504-527).
 * The commit-status/notifier legs have no platform analog (module header).
 */
export async function cancelActionRun(
  d1: D1,
  run: RunRow,
  jobs: RunJobRow[],
  now: Date = new Date(),
): Promise<CancelActionRunOutcome> {
  const db = drizzle(d1);
  let cancelledJobs = 0;

  for (const job of jobs) {
    if (isDoneStatusValue(job.status)) continue;

    if (job.taskId === 0) {
      // cancelOneJob's no-task arm: mark Cancelled behind the task_id = 0 CAS.
      const updated = await db
        .update(actionRunJobs)
        .set({ status: ACTION_STATUS_CANCELLED, stopped: now, updated: now })
        .where(and(eq(actionRunJobs.id, job.id), eq(actionRunJobs.taskId, 0)))
        .returning({ id: actionRunJobs.id });
      if (updated.length > 0) cancelledJobs++;
      continue;
    }

    // StopTask (task.go:447-511): the cancelling handshake.
    const taskRows = await db.select().from(actionTasks).where(eq(actionTasks.id, job.taskId)).limit(1);
    const task = taskRows[0];
    if (task === undefined || isDoneStatusValue(task.status)) continue;

    let stopStatus = ACTION_STATUS_CANCELLED;
    if (task.runnerId > 0) {
      const runnerRows = await db.select().from(actionRunners).where(eq(actionRunners.id, task.runnerId)).limit(1);
      const runner = runnerRows[0];
      if (
        runner !== undefined &&
        runner.hasCancellingSupport &&
        now.getTime() - task.updated.getTime() < TASK_REPORT_TIMEOUT_MS
      ) {
        stopStatus = ACTION_STATUS_CANCELLING;
      }
    }

    if (stopStatus === ACTION_STATUS_CANCELLING) {
      await db.batch([
        db
          .update(actionRunJobs)
          .set({ status: ACTION_STATUS_CANCELLING, updated: now })
          .where(eq(actionRunJobs.id, job.id)),
        // NoAutoTime: the task's updated stays at the runner's last contact
        // so re-cancels do not defer the timeout.
        db.update(actionTasks).set({ status: ACTION_STATUS_CANCELLING }).where(eq(actionTasks.id, task.id)),
      ]);
      cancelledJobs++;
      continue;
    }

    // The direct-cancel arm: task + job stop together (StopTask's final
    // branch; the steps' stoppage ride M1b's step writer — v1 rows carry no
    // workflow-parsed steps yet).
    await db.batch([
      db
        .update(actionTasks)
        .set({ status: ACTION_STATUS_CANCELLED, stopped: now, updated: now })
        .where(eq(actionTasks.id, task.id)),
      db
        .update(actionRunJobs)
        .set({ status: ACTION_STATUS_CANCELLED, stopped: now, updated: now })
        .where(eq(actionRunJobs.id, job.id)),
    ]);
    cancelledJobs++;
  }

  if (cancelledJobs > 0) {
    // Wake idle runners only when waiting work remains (UpdateRunJob's
    // done-arm bump).
    const waiting = await db
      .select({ id: actionRunJobs.id })
      .from(actionRunJobs)
      .where(
        and(
          eq(actionRunJobs.repoId, run.repoId),
          eq(actionRunJobs.status, ACTION_STATUS_WAITING),
          eq(actionRunJobs.taskId, 0),
        ),
      )
      .limit(1);
    if (waiting.length > 0) {
      await increaseTaskVersion(d1, run.ownerId, run.repoId);
    }
  }

  // The settle: re-aggregate from the stored jobs (refreshRunStatus's
  // attempt/run mirror — SettleRunAfterCancel's no-jobs arm rides the same
  // recompute on v1 rows, which always carry the attempt).
  await settleRunAfterCancel(d1, run, now);

  return { outcome: "cancelled", cancelledJobs };
}

/** refreshRunStatus + SettleRunAfterCancel (run_job.go:567-600 + 796-801):
 *  recompute the attempt's aggregate from its jobs, mirror it onto the run
 *  (the latest attempt propagates; the started/stopped mirrors follow
 *  UpdateRunAttempt's rules). A settle that finds no jobs carries the
 *  cancelled noJobsStatus — SettleRunAfterCancel's arm. */
export async function settleRunAfterCancel(d1: D1, run: RunRow, now: Date = new Date()): Promise<void> {
  const db = drizzle(d1);
  const jobs = await db
    .select({ status: actionRunJobs.status, continueOnError: actionRunJobs.continueOnError })
    .from(actionRunJobs)
    .where(eq(actionRunJobs.runId, run.id));

  if (run.latestAttemptId > 0) {
    const attemptRows = await db
      .select()
      .from(actionRunAttempts)
      .where(eq(actionRunAttempts.id, run.latestAttemptId))
      .limit(1);
    const attempt = attemptRows[0];
    if (attempt !== undefined) {
      const next = jobs.length === 0 ? ACTION_STATUS_CANCELLED : aggregateStatus(jobs);
      const cols: { status: number; started?: Date | null; stopped?: Date | null } = { status: next };
      if (attempt.started === null && next === ACTION_STATUS_RUNNING) cols.started = now;
      if (attempt.stopped === null && isDoneStatusValue(next)) cols.stopped = now;
      if (attempt.stopped !== null && !isDoneStatusValue(next)) cols.stopped = null;
      await db.update(actionRunAttempts).set({ ...cols, updated: now }).where(eq(actionRunAttempts.id, attempt.id));
    }
  }

  // The run mirrors its latest attempt (falling back to the job aggregate
  // for legacy rows — refreshRunStatus's tail).
  const runRows = await db.select().from(actionRuns).where(eq(actionRuns.id, run.id)).limit(1);
  const storedRun = runRows[0];
  if (storedRun === undefined) return;
  let runStatus: number;
  let started = storedRun.started;
  let stopped = storedRun.stopped;
  if (storedRun.latestAttemptId > 0) {
    const latestRows = await db
      .select()
      .from(actionRunAttempts)
      .where(eq(actionRunAttempts.id, storedRun.latestAttemptId))
      .limit(1);
    const latest = latestRows[0];
    if (latest === undefined) return;
    runStatus = latest.status;
    started = latest.started;
    stopped = latest.stopped;
  } else {
    runStatus = jobs.length === 0 ? ACTION_STATUS_CANCELLED : aggregateStatus(jobs);
    if (started === null && runStatus === ACTION_STATUS_RUNNING) started = now;
    if (stopped === null && isDoneStatusValue(runStatus)) stopped = now;
  }
  await db.update(actionRuns).set({ status: runStatus, started, stopped, updated: now }).where(eq(actionRuns.id, storedRun.id));
}

/** AggregateJobStatus (run_job.go:642-687) minus the fail-fast matrix arm
 *  (v1 rows carry no deferred matrix payload — the arm's guard can never
 *  fire; the M1b dedup note: services/actions/update.ts aggregateJobStatus
 *  is the same port for the service side). */
function aggregateStatus(jobs: Array<Pick<RunJobRow, "status" | "continueOnError">>): number {
  let allSuccessOrSkipped = jobs.length !== 0;
  let allSkipped = jobs.length !== 0;
  let hasFailure = false;
  let hasCancelled = false;
  let hasCancelling = false;
  let hasWaiting = false;
  let hasRunning = false;
  let hasBlocked = false;
  let hasPending = false;
  for (const job of jobs) {
    const isContinuedFailure = job.continueOnError && job.status === ACTION_STATUS_FAILURE;
    allSuccessOrSkipped =
      allSuccessOrSkipped &&
      (job.status === 1 /* success */ || job.status === 4 /* skipped */ || isContinuedFailure);
    allSkipped = allSkipped && job.status === 4;
    hasFailure = hasFailure || (job.status === ACTION_STATUS_FAILURE && !job.continueOnError);
    hasCancelled = hasCancelled || job.status === ACTION_STATUS_CANCELLED;
    hasCancelling = hasCancelling || job.status === ACTION_STATUS_CANCELLING;
    hasWaiting = hasWaiting || job.status === ACTION_STATUS_WAITING;
    hasRunning = hasRunning || job.status === ACTION_STATUS_RUNNING;
    hasBlocked = hasBlocked || job.status === 7;
    hasPending = hasPending || job.status === 9;
  }
  if (allSkipped) return 4;
  if (allSuccessOrSkipped) return 1;
  if (hasCancelling) return ACTION_STATUS_CANCELLING;
  if (hasRunning) return ACTION_STATUS_RUNNING;
  if (hasWaiting) return ACTION_STATUS_WAITING;
  if (hasBlocked) return 7;
  if (hasPending) return ACTION_STATUS_RUNNING;
  if (hasCancelled) return ACTION_STATUS_CANCELLED;
  if (hasFailure) return ACTION_STATUS_FAILURE;
  return 0;
}

// ---------------------------------------------------------------------------
// The mount shell render (view.tmpl + view_component.tmpl)
// ---------------------------------------------------------------------------

/** The mount page's data (view.go:294-326's ctx.Data set). */
export interface RepoActionsViewPageData {
  /** The URL's {job} segment as PathParamInt64 (0 on the summary view —
   *  upstream's "it can be 0 when no job" comment). */
  jobId: number;
  /** data-actions-view-url: the POST twin's URL (view.go:311-324). */
  actionsViewUrl: string;
  /** The browser tab title (view.go:299-306's join). */
  title: string;
}

/** The mount div (view_component.tmpl:1-64) — the id + the two data
 *  attributes + the data-locale-* set, upstream's exact attribute order. */
export function RepoActionViewMount(props: { data: RepoActionsViewPageData }) {
  const locale = repoActionsViewLocale;
  return (
    <div
      id="repo-action-view"
      data-job-id={String(props.data.jobId)}
      data-actions-view-url={props.data.actionsViewUrl}
      data-locale-approve={locale.approve}
      data-locale-cancel={locale.cancel}
      data-locale-rerun={locale.rerun}
      data-locale-rerun-all={locale.rerunAll}
      data-locale-rerun-failed={locale.rerunFailed}
      data-locale-latest={locale.latest}
      data-locale-latest-attempt={locale.latestAttempt}
      data-locale-attempt={locale.attempt}
      data-locale-runs-scheduled={locale.runsScheduled}
      data-locale-runs-commit={locale.runsCommit}
      data-locale-runs-pushed-by={locale.runsPushedBy}
      data-locale-summary={locale.summary}
      data-locale-all-jobs={locale.allJobs}
      data-locale-job-summaries={locale.jobSummaries}
      data-locale-expand-caller-jobs={locale.expandCallerJobs}
      data-locale-collapse-caller-jobs={locale.collapseCallerJobs}
      data-locale-triggered-via={locale.triggeredVia}
      data-locale-rerun-triggered={locale.rerunTriggered}
      data-locale-back-to-pull-request={locale.backToPullRequest}
      data-locale-back-to-workflow={locale.backToWorkflow}
      data-locale-status-label={locale.statusLabel}
      data-locale-total-duration={locale.totalDuration}
      data-locale-run-details={locale.runDetails}
      data-locale-workflow-file={locale.workflowFile}
      data-locale-workflow-file-no-permission={locale.workflowFileNoPermission}
      data-locale-status-unknown={locale.statusUnknown}
      data-locale-status-waiting={locale.statusWaiting}
      data-locale-status-running={locale.statusRunning}
      data-locale-status-cancelling={locale.statusCancelling}
      data-locale-status-success={locale.statusSuccess}
      data-locale-status-failure={locale.statusFailure}
      data-locale-status-cancelled={locale.statusCancelled}
      data-locale-status-skipped={locale.statusSkipped}
      data-locale-status-blocked={locale.statusBlocked}
      data-locale-status-pending={locale.statusPending}
      data-locale-artifacts-title={locale.artifactsTitle}
      data-locale-artifact-expired={locale.artifactExpired}
      data-locale-artifact-expires-at={locale.artifactExpiresAt}
      data-locale-artifact-expired-at={locale.artifactExpiredAt}
      data-locale-confirm-delete-artifact={locale.confirmDeleteArtifact}
      data-locale-show-timestamps={locale.showTimestamps}
      data-locale-show-log-seconds={locale.showLogSeconds}
      data-locale-show-full-screen={locale.showFullScreen}
      data-locale-download-logs={locale.downloadLogs}
      data-locale-download-file={locale.downloadFile}
      data-locale-copy-output={locale.copyOutput}
      data-locale-logs-always-auto-scroll={locale.logsAlwaysAutoScroll}
      data-locale-logs-always-expand-running={locale.logsAlwaysExpandRunning}
      data-locale-workflow-dependencies={locale.workflowDependencies}
      data-locale-graph-jobs-count-1={locale.graphJobsCount1}
      data-locale-graph-jobs-count-n={locale.graphJobsCountN}
      data-locale-graph-dependencies-count-1={locale.graphDependenciesCount1}
      data-locale-graph-dependencies-count-n={locale.graphDependenciesCountN}
      data-locale-graph-success-rate={locale.graphSuccessRate}
      data-locale-graph-zoom-in={locale.graphZoomIn}
      data-locale-graph-zoom-max={locale.graphZoomMax}
      data-locale-graph-zoom-out={locale.graphZoomOut}
      data-locale-graph-reset-view={locale.graphResetView}
    />
  );
}

/** The full-document render (view.tmpl: `.page-content.repository` over the
 *  repo header — BaseLayout renders both from ctx.repo — and the mount div;
 *  there is no actions tab strip yet, so no activeTab). */
export function renderRepoActionsViewPage(ctx: UiContext, data: RepoActionsViewPageData): string {
  return renderPage(
    <BaseLayout ctx={ctx} title={data.title} pageClass="repository">
      <RepoActionViewMount data={data} />
    </BaseLayout>,
  );
}

/** The mount page's data (view.go:294-326): the browser-tab title
 *  (`job - run - workflow`, the job name riding only when a job arm resolves
 *  one — the lookup miss silently skipped) and the PathParamInt64'd job id.
 *  `actionsViewUrl` is set by the handler from the resolved run link. */
export async function loadRepoActionsViewPageData(
  d1: D1,
  run: RunRow,
  jobId: number,
): Promise<RepoActionsViewPageData> {
  const titleParts: string[] = [run.title, run.workflowId];
  if (jobId > 0) {
    const job = await getRunJobByRunAndId(d1, run.id, jobId);
    if (job !== null && job.name !== "") titleParts.unshift(job.name);
  }
  return {
    jobId,
    actionsViewUrl: "",
    title: titleParts.join(" - "),
  };
}

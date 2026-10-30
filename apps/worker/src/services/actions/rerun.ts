/**
 * The rerun service (SPEC-0012's C5 run-mutation remainder — the board's
 * P1-2, docs/residuals-v1.3.2.md) — ported from services/actions/rerun.go
 * (upstream pin fc493688) at the M1 store's stage.
 *
 * THE M3-BOUNDARY VERDICT (the question the dispatch brief poses): rerun is
 * NOT emitter territory on the write side. Upstream's rerun never re-parses
 * the workflow from the repo and never rides the push-event parser —
 * buildRerunPlan (rerun.go:151-186) clones the LATEST ATTEMPT's stored job
 * rows (their WorkflowPayload/JobID/Needs/RunsOn ride over verbatim through
 * cloneRunJobForAttempt, rerun.go:534-572) into a NEW ActionRunAttempt, so a
 * manual rerun can synthesize the new job rows directly from the existing
 * rows. The M3-dependent arms are exactly three, and all three are guarded
 * upstream by data v1 rows never carry:
 *
 *   1. `if:` re-decision (decideJobIf, rerun.go:306) — the OQ-1 expression
 *      evaluator; v1 rows never carry a decided-if state (the M1a staged
 *      insert writes waiting/pending rows directly, model.ts insertActionRun),
 *      so the rerun writes the same waiting/pending shapes.
 *   2. run/job concurrency (EvaluateRunConcurrencyFillModel, rerun.go:218;
 *      PrepareToStartRunWithConcurrency, rerun.go:227) — guarded by
 *      `plan.run.RawConcurrency != ""` (rerun.go:209) and the job twin
 *      (rerun.go:312); v1 rows carry rawConcurrency '' everywhere, so the
 *      blocked arm (shouldBlock, rerun.go:233) is unreachable and the new
 *      attempt starts Waiting.
 *   3. the reusable-caller cascade + deferred-matrix collapse
 *      (collectResetCallerDescendants / collectMatrixCollapse, rerun.go:516,
 *      638) — v1 rows never carry isReusableCaller/isMatrixDeferred (SPEC
 *      §1.4 unread columns), so the skip-clone sets stay empty.
 *
 * The M3 surface that REMAINS for rerun after this unit: none on the write
 * path — the post-commit notify/commit-status/emitter tails (rerun.go:388-396,
 * EmitJobsIfReadyByRun) ride M3's notifier/status work as they do for every
 * other producer, and the `if:`/concurrency/matrix arms above arm themselves
 * when M3 lands (the guards here are the ports' insertion points).
 *
 * The ARTIFACT-INHERITANCE mechanism (the board's v1.3.1 addition: "a rerun's
 * artifacts must resolve to the new attempt") is upstream's
 * GetArtifactAttemptIDs (models/actions/run_attempt.go:104-148): artifacts
 * carry run_attempt_id of the attempt whose job uploaded them; a PARTIAL
 * rerun (rerun-failed / one job) clones the succeeded jobs as PASS-THROUGH
 * rows whose source_task_id points at the original task (rerun.go:326-331),
 * and a reader walks attempts newest-first, inheriting until the first
 * attempt that passed NO job through (run_attempt.go:122-133) — a FULL rerun
 * resets every job (source_task_id 0), so the chain stops at the new attempt.
 * getArtifactAttemptIds below is that port; the runner-facing artifact
 * protocols' single seam is services/actions/artifacts.ts'
 * readableArtifactAttemptIds (its v2 note cites this exact landing).
 */

import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionArtifacts, actionRunAttempts, actionRunJobs, actionRuns } from "../../db/schema";
import { loadRepoActionsConfig } from "./config";
import {
  ACTION_STATUS_PENDING,
  ACTION_STATUS_WAITING,
  increaseTaskVersion,
  type D1,
  type RunAttemptRow,
  type RunJobRow,
  type RunRow,
} from "./model";
import { aggregateJobStatus, isDoneStatus, isRunningStatus } from "./update";

/** MAX_RERUN_ATTEMPTS' default (modules/setting/actions.go:17
 *  defaultMaxRerunAttempts = 50, :54 the assignment; our wrangler carries no
 *  [actions] override, so the default IS the value). */
export const MAX_RERUN_ATTEMPTS = 50;

/** GetFailedJobsForRerun (rerun.go:26-36): the failed OR cancelled jobs —
 *  both are what the "Re-run failed jobs" button re-runs. */
export function getFailedJobsForRerun(jobs: RunJobRow[]): RunJobRow[] {
  return jobs.filter(
    (job) => job.status === 2 /* StatusFailure */ || job.status === 3 /* StatusCancelled */,
  );
}

/** The service's rejection arms, each citing its upstream validate/plan arm.
 *  The web handler maps run-not-done + workflow-disabled through
 *  checkRunRerunAllowed's JSONError (view.go:921-942), the rest through
 *  handleWorkflowRerunError (view.go:1018-1028: AlreadyExist → 409,
 *  InvalidArgument → 400, else ServerError). */
export type RerunRejection =
  /** validateRerun rerun.go:72-74 — InvalidArgument "this workflow run is not done". */
  | "run-not-done"
  /** rerun.go:75-79 — repo required / run not in repo (internal misuse). */
  | "repo-mismatch"
  /** rerun.go:81-85 — a target job outside the run. */
  | "job-not-in-run"
  /** rerun.go:86-88 — trigger user required (internal misuse). */
  | "trigger-user-required"
  /** rerun.go:100-102 — cfg.IsWorkflowDisabled(run.WorkflowID). */
  | "workflow-disabled"
  /** rerun.go:104-114 — the latest attempt is already at MAX_RERUN_ATTEMPTS. */
  | "max-attempts"
  /** buildRerunPlan rerun.go:160-162 ("latest attempt not found") — the
   *  500-class arm upstream; unreachable on v1 rows (every insert writes
   *  attempt 1), ported for fidelity. */
  | "latest-attempt-missing"
  /** buildRerunPlan rerun.go:168-170 ("no template jobs"). */
  | "no-template-jobs"
  /** rerun.go:421-425 — a target job id missing from the latest attempt. */
  | "job-missing-from-latest-attempt"
  /** execRerunPlan rerun.go:236-238 — the (run_id, attempt) unique race
   *  (ErrAlreadyExist → the 409 arm). */
  | "attempt-already-exists";

export type RerunResult =
  | { ok: true; attempt: RunAttemptRow; jobs: RunJobRow[] }
  | { ok: false; reason: RerunRejection; message: string };

function rejected(reason: RerunRejection, message: string): RerunResult {
  return { ok: false, reason, message };
}

/** GetRunAttemptByRunIDAndAttemptNum (run_attempt.go:89-98) + the unique-race
 *  probe execRerunPlan's insert-catch runs. */
async function getAttemptByRunIdAndAttemptNum(
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

/** ListRunAttemptsByRunID (run_attempt_list.go:36-39) — attempt number DESC
 *  (newest first; GetArtifactAttemptIDs' inheritance walk rides this order). */
async function listRunAttemptsByRunId(d1: D1, runId: number): Promise<RunAttemptRow[]> {
  return drizzle(d1)
    .select()
    .from(actionRunAttempts)
    .where(eq(actionRunAttempts.runId, runId))
    .orderBy(asc(actionRunAttempts.attempt))
    .then((rows) => rows.reverse());
}

/** GetRunJobsByRunAndAttemptID (run_job.go:305-311) — id ASC. */
async function getRunJobsByRunAndAttemptId(
  d1: D1,
  runId: number,
  runAttemptId: number,
): Promise<RunJobRow[]> {
  return drizzle(d1)
    .select()
    .from(actionRunJobs)
    .where(and(eq(actionRunJobs.runId, runId), eq(actionRunJobs.runAttemptId, runAttemptId)))
    .orderBy(asc(actionRunJobs.id));
}

// ---------------------------------------------------------------------------
// validateRerun (rerun.go:71-117)
// ---------------------------------------------------------------------------

export async function validateRerun(
  d1: D1,
  repoId: string,
  run: RunRow,
  triggerUserId: number,
  jobsToRerun: RunJobRow[],
): Promise<RerunResult | null> {
  if (!isDoneStatus(run.status)) {
    return rejected("run-not-done", "this workflow run is not done"); // rerun.go:72-74
  }
  if (repoId === "" || run.repoId !== repoId) {
    return rejected("repo-mismatch", `run ${run.id} does not belong to repo ${repoId}`); // rerun.go:75-79
  }
  for (const job of jobsToRerun) {
    if (job.runId !== run.id) {
      return rejected("job-not-in-run", `job ${job.id} does not belong to workflow run ${run.id}`); // rerun.go:81-85
    }
  }
  if (triggerUserId <= 0) {
    return rejected("trigger-user-required", "trigger user is required"); // rerun.go:86-88
  }
  // The workflow-disabled arm (rerun.go:89-102). The scoped-run twin
  // (IsScopedWorkflowOptedOut, rerun.go:91-99) is scoped-workflows substrate
  // that does not exist here (SPEC §1.4; v1 rows never carry isScopedRun) —
  // the plain DisableWorkflow map is the only readable arm.
  const cfg = await loadRepoActionsConfig(d1, run.repoId);
  if (cfg.disabledWorkflows.includes(run.workflowId)) {
    return rejected("workflow-disabled", `workflow ${run.workflowId} is disabled`); // rerun.go:100-102
  }
  // The attempts cap (rerun.go:104-114): legacy runs (latestAttemptId == 0)
  // conceptually have only attempt 1 and can never be at the cap.
  if (run.latestAttemptId > 0) {
    const latest = await drizzle(d1)
      .select()
      .from(actionRunAttempts)
      .where(eq(actionRunAttempts.id, run.latestAttemptId))
      .limit(1);
    const attempt = latest[0];
    if (attempt !== undefined && attempt.attempt >= MAX_RERUN_ATTEMPTS) {
      return rejected(
        "max-attempts",
        `workflow run has reached the maximum of ${MAX_RERUN_ATTEMPTS} attempts`, // rerun.go:111-113
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The attempt-awareness backfills
// ---------------------------------------------------------------------------

/** createOriginalAttemptForLegacyRun (rerun.go:577-633) — a run whose rows
 *  pre-date the attempts model gets its real attempt=1 before the plan is
 *  built: the attempt row (the run's status/timestamps carried over —
 *  NoAutoTime upstream, explicit columns here), the jobs' attempt linkage
 *  with ordinal attempt_job_ids, the artifacts' run_attempt_id backfill, and
 *  run.latest_attempt_id. Unreachable on v1 rows (insertActionRun always
 *  writes attempt 1 + latest_attempt_id), ported for fidelity and for the
 *  hand-inserted fixture rows the harness may produce. */
async function createOriginalAttemptForLegacyRun(d1: D1, run: RunRow): Promise<void> {
  const db = drizzle(d1);
  const jobs = await getRunJobsByRunAndAttemptId(d1, run.id, 0);
  if (jobs.length === 0) {
    throw new Error(`actions: run ${run.id} has no jobs (rerun.go:583-585)`);
  }
  const inserted = await db
    .insert(actionRunAttempts)
    .values({
      repoId: run.repoId,
      runId: run.id,
      attempt: 1,
      triggerUserId: run.triggerUserId,
      status: run.status,
      created: run.created, // NoAutoTime (rerun.go:604)
      updated: run.updated,
    })
    .returning();
  const attempt = inserted[0];
  if (attempt === undefined) throw new Error("actions: legacy attempt insert returned no row");
  for (const [i, job] of jobs.entries()) {
    await db
      .update(actionRunJobs)
      .set({ runAttemptId: attempt.id, attempt: 1, attemptJobId: i + 1, updated: new Date() })
      .where(eq(actionRunJobs.id, job.id)); // rerun.go:611-619
  }
  await db
    .update(actionArtifacts)
    .set({ runAttemptId: attempt.id })
    .where(and(eq(actionArtifacts.runId, run.id), eq(actionArtifacts.runAttemptId, 0))); // rerun.go:621-627
  await db
    .update(actionRuns)
    .set({ latestAttemptId: attempt.id, updated: new Date() })
    .where(eq(actionRuns.id, run.id)); // rerun.go:629-631
  run.latestAttemptId = attempt.id;
}

/** The M1a staged-insert rows carry attempt_job_id = 0 (model.ts
 *  insertActionRun predates the column's writer; upstream's modern insertRun
 *  allocates GetNextAttemptJobID per job, run.go:204-221, and its legacy
 *  backfill does the ordinal shape, rerun.go:615). The rerun plan keys the
 *  rerun set by attempt_job_id (rerun.go:407, 433), so the template attempt's
 *  rows are made attempt-aware first — the same idempotent backfill intent as
 *  createOriginalAttemptForLegacyRun, applied to the latest attempt. */
async function backfillTemplateAttemptJobIds(
  d1: D1,
  templateAttemptId: number,
  templateJobs: RunJobRow[],
): Promise<RunJobRow[]> {
  if (!templateJobs.some((job) => job.attemptJobId === 0)) return templateJobs;
  const db = drizzle(d1);
  const now = new Date();
  for (const [i, job] of templateJobs.entries()) {
    if (job.attemptJobId !== 0) continue; // a modern row keeps its id
    await db
      .update(actionRunJobs)
      .set({ attemptJobId: i + 1, updated: now })
      .where(and(eq(actionRunJobs.id, job.id), eq(actionRunJobs.attemptJobId, 0)));
  }
  return getRunJobsByRunAndAttemptId(d1, templateJobs[0]!.runId, templateAttemptId);
}

// ---------------------------------------------------------------------------
// expandRerunJobIDs (rerun.go:401-490)
// ---------------------------------------------------------------------------

/** expandRerunJobIDs: the user-selected jobs grow to include all transitive
 *  downstream dependents (same parent scope, needs referencing the current
 *  job — rerun.go:441-454), escalating through reusable-caller ancestors so
 *  their siblings are checked too (rerun.go:456-469) and pruning ancestors
 *  already covered by a rerun-set member (rerun.go:471-485). v1 rows carry
 *  parent_job_id = 0 always (the reusable-workflow family is unread, SPEC
 *  §1.4), so the escalation arms are vacuous — ported for parity. An empty
 *  jobsToRerun selects the whole attempt (rerun.go:403-412). */
function expandRerunJobIds(
  templateJobs: RunJobRow[],
  jobsToRerun: RunJobRow[],
): { rerunSet: Set<number>; ancestorSet: Set<number> } | null {
  if (jobsToRerun.length === 0) {
    return { rerunSet: new Set(templateJobs.map((job) => job.attemptJobId)), ancestorSet: new Set() };
  }
  const byRowId = new Map(templateJobs.map((job) => [job.id, job]));
  const byAttemptJobId = new Map(templateJobs.map((job) => [job.attemptJobId, job]));
  for (const job of jobsToRerun) {
    if (!byRowId.has(job.id)) return null; // rerun.go:421-425
  }
  const rerunSet = new Set<number>();
  const ancestorSet = new Set<number>();
  const queue = jobsToRerun.map((job) => byRowId.get(job.id)!);
  for (const job of queue) rerunSet.add(job.attemptJobId);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const candidate of templateJobs) {
      if (candidate.parentJobId !== cur.parentJobId) continue;
      if (rerunSet.has(candidate.attemptJobId) || ancestorSet.has(candidate.attemptJobId)) continue;
      const needs = JSON.parse(candidate.needs) as string[];
      if (!needs.includes(cur.jobId)) continue;
      rerunSet.add(candidate.attemptJobId);
      queue.push(candidate);
    }
    if (cur.parentJobId === 0) continue; // rerun.go:457-459
    const parent = byRowId.get(cur.parentJobId);
    if (parent === undefined) continue;
    if (rerunSet.has(parent.attemptJobId) || ancestorSet.has(parent.attemptJobId)) continue;
    ancestorSet.add(parent.attemptJobId);
    queue.push(parent);
  }

  // rerun.go:471-485 — drop ancestors whose own chain already carries a
  // rerun-set member.
  for (const atId of [...ancestorSet]) {
    let cur = byAttemptJobId.get(atId);
    while (cur !== undefined && cur.parentJobId !== 0) {
      const parent = byRowId.get(cur.parentJobId);
      if (parent === undefined) break;
      if (rerunSet.has(parent.attemptJobId)) {
        ancestorSet.delete(atId);
        break;
      }
      cur = parent;
    }
  }
  return { rerunSet, ancestorSet };
}

// ---------------------------------------------------------------------------
// The exec (execRerunPlan, rerun.go:195-399)
// ---------------------------------------------------------------------------

/** EffectiveTaskID (run_job.go:158-163) — the pass-through rows' history
 *  pointer (rerun.go:327). */
function effectiveTaskId(job: RunJobRow): number {
  return job.taskId > 0 ? job.taskId : job.sourceTaskId;
}

/**
 * RerunWorkflowRunJobs (rerun.go:53-69) — rerun the given jobs of a run's
 * LATEST attempt. An EMPTY jobsToRerun means rerunning the whole run
 * (rerun.go:39; the rerun-all button and the API rerun endpoint pass the
 * full list, which the empty-expansion covers the same way). The attempt
 * caps, disabled-workflow and done-run validations run first
 * (validateRerun); the rerun-set jobs reset to waiting (pending when they
 * have needs — rerun.go:289-292, insertRunJob's status shape at
 * run.go:199-202), every other job clones through as PASS-THROUGH keeping
 * its terminal status, timing, and source task (rerun.go:325-332); the run's
 * latest_attempt_id moves to the new attempt and an awaiting-approval run is
 * approved by the act of rerunning (rerun.go:242-248). The dispatch wake
 * (increaseTaskVersion) fires only when a dispatchable waiting job exists
 * (rerun.go:350-352, 372-376 — insertActionRun's twin shape).
 */
export async function rerunWorkflowRunJobs(
  d1: D1,
  repoId: string,
  run: RunRow,
  triggerUserId: number,
  jobsToRerun: RunJobRow[],
): Promise<RerunResult> {
  const invalid = await validateRerun(d1, repoId, run, triggerUserId, jobsToRerun);
  if (invalid !== null) return invalid;

  if (run.latestAttemptId === 0) {
    await createOriginalAttemptForLegacyRun(d1, run); // rerun.go:58-63
  }

  const db = drizzle(d1);
  const now = new Date();

  // buildRerunPlan (rerun.go:151-186): the template attempt + its jobs.
  const latestAttemptRows = await db
    .select()
    .from(actionRunAttempts)
    .where(eq(actionRunAttempts.id, run.latestAttemptId))
    .limit(1);
  const templateAttempt = latestAttemptRows[0];
  if (templateAttempt === undefined) {
    return rejected("latest-attempt-missing", "latest attempt not found"); // rerun.go:160-162
  }
  let templateJobs = await getRunJobsByRunAndAttemptId(d1, run.id, templateAttempt.id);
  if (templateJobs.length === 0) {
    return rejected("no-template-jobs", "no template jobs"); // rerun.go:168-170
  }
  templateJobs = await backfillTemplateAttemptJobIds(d1, templateAttempt.id, templateJobs);

  const expanded = expandRerunJobIds(templateJobs, jobsToRerun);
  if (expanded === null) {
    return rejected(
      "job-missing-from-latest-attempt",
      `job does not exist in the latest attempt`, // rerun.go:423 (job %q carries the YAML key)
    );
  }
  const { rerunSet } = expanded;
  // The reusable-caller skip-clone + deferred-matrix collapse sets
  // (collectResetCallerDescendants / collectMatrixCollapse, rerun.go:516,
  // 638) are empty on v1 rows — the unread-column disclosure in the module
  // header. Every template row clones.

  // execRerunPlan's pre-transaction construction (rerun.go:201-221): the new
  // attempt waits; the concurrency fill (rerun.go:209-221) and
  // PrepareToStartRunWithConcurrency's blocked arm (rerun.go:227-233,
  // clear_tasks.go:137-150) need the raw-concurrency data v1 rows never
  // carry — shouldBlock stays false.
  const newAttemptNum = templateAttempt.attempt + 1;
  const shouldBlock = false;

  const existing = await getAttemptByRunIdAndAttemptNum(d1, run.id, newAttemptNum);
  if (existing !== null) {
    return rejected(
      "attempt-already-exists",
      `workflow run attempt ${newAttemptNum} for run ${run.id} already exists`, // rerun.go:236-238
    );
  }

  const insertedAttemptRows = await db
    .insert(actionRunAttempts)
    .values({
      repoId: run.repoId,
      runId: run.id,
      attempt: newAttemptNum,
      triggerUserId,
      status: ACTION_STATUS_WAITING,
      created: now,
      updated: now,
    })
    .returning()
    .catch(async (err: unknown): Promise<RunAttemptRow[]> => {
      // The unique race (rerun.go:235-240): re-probe before surfacing.
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        const row = await getAttemptByRunIdAndAttemptNum(d1, run.id, newAttemptNum);
        return row !== null ? [row] : [];
      }
      throw err;
    });
  const newAttempt = insertedAttemptRows[0];
  if (newAttempt === undefined) {
    return rejected(
      "attempt-already-exists",
      `workflow run attempt ${newAttemptNum} for run ${run.id} already exists`,
    );
  }

  // The run moves to the new attempt; rerunning IS an explicit approval
  // (rerun.go:242-248).
  const runCols: { latestAttemptId: number; updated: Date; needApproval?: boolean; approvedBy?: number } = {
    latestAttemptId: newAttempt.id,
    updated: now,
  };
  if (run.needApproval) {
    runCols.needApproval = false;
    runCols.approvedBy = triggerUserId;
  }
  await db.update(actionRuns).set(runCols).where(eq(actionRuns.id, run.id));
  run.latestAttemptId = newAttempt.id;

  // Clone the template jobs (rerun.go:258-354) — id order, chunked two per
  // statement (the store's 100-bind idiom, model.ts insertActionRun).
  const cloneValues = templateJobs.map((templateJob) => {
    const isRerun = rerunSet.has(templateJob.attemptJobId);
    const needs = JSON.parse(templateJob.needs) as string[];
    const base = {
      runId: templateJob.runId,
      runAttemptId: newAttempt.id,
      repoId: templateJob.repoId,
      ownerId: templateJob.ownerId,
      commitSha: templateJob.commitSha,
      isForkPullRequest: templateJob.isForkPullRequest,
      name: templateJob.name,
      attempt: newAttempt.attempt,
      workflowPayload: templateJob.workflowPayload, // slices.Clone (rerun.go:544)
      jobId: templateJob.jobId,
      attemptJobId: templateJob.attemptJobId, // template-matched identity (rerun.go:546)
      needs: templateJob.needs,
      runsOn: templateJob.runsOn,
      continueOnError: templateJob.continueOnError,
      isMatrixDeferred: templateJob.isMatrixDeferred,
      deferredMatrixPayload: templateJob.deferredMatrixPayload,
      status: templateJob.status, // cloneRunJobForAttempt (rerun.go:552) — the pass-through rows keep their terminal status
      rawConcurrency: templateJob.rawConcurrency,
      concurrencyGroup: templateJob.concurrencyGroup,
      concurrencyCancel: templateJob.concurrencyCancel,
      tokenPermissions: templateJob.tokenPermissions,
      maxParallel: templateJob.maxParallel,
      isReusableCaller: templateJob.isReusableCaller,
      callUses: templateJob.callUses,
      reusableWorkflowContent: templateJob.reusableWorkflowContent,
      reusableWorkflowRef: templateJob.reusableWorkflowRef,
      callSecrets: templateJob.callSecrets,
      callPayload: templateJob.callPayload,
      isExpanded: templateJob.isExpanded,
      parentJobId: templateJob.parentJobId, // remap is vacuous on v1 rows (parentJobId always 0)
      workflowSourceRepoId: templateJob.workflowSourceRepoId,
      workflowSourceCommitSha: templateJob.workflowSourceCommitSha,
      started: templateJob.started, // the pass-through timing (rerun.go:330-331); the reset arm clears it
      stopped: templateJob.stopped,
      created: now,
      updated: now,
    };
    if (isRerun) {
      // rerun.go:287-304 — the reset arm. decideJobIf (rerun.go:306) is the
      // OQ-1 evaluator (module header): the v1 rows carry no decided-if
      // state and the staged insert writes waiting/pending directly — the
      // same shape here. The job-level concurrency fill (rerun.go:312-321)
      // is guarded by rawConcurrency '' and skipped.
      const status =
        shouldBlock ? 7 /* StatusBlocked */ : ACTION_STATUS_WAITING; // rerun.go:289
      return {
        ...base,
        status: status === ACTION_STATUS_WAITING && needs.length > 0 ? ACTION_STATUS_PENDING : status,
        taskId: 0,
        sourceTaskId: 0,
        started: null,
        stopped: null,
        concurrencyGroup: "", // rerun.go:297-299
        concurrencyCancel: false,
        isConcurrencyEvaluated: false,
        // rerun.go:301-304 — the reusable-caller reset (vacuous on v1 rows).
        isExpanded: templateJob.isReusableCaller ? false : templateJob.isExpanded,
        callPayload: templateJob.isReusableCaller ? "" : templateJob.callPayload,
      };
    }
    // rerun.go:325-332 — the pass-through arm: history rides the template's
    // effective task; the ancestor timing-clear (rerun.go:329-331) is
    // reusable-caller-only and vacuous on v1 rows.
    return {
      ...base,
      taskId: 0,
      sourceTaskId: effectiveTaskId(templateJob),
    };
  });

  const newJobs: RunJobRow[] = [];
  const CLONE_CHUNK = 2;
  for (let i = 0; i < cloneValues.length; i += CLONE_CHUNK) {
    const chunk = cloneValues.slice(i, i + CLONE_CHUNK);
    if (chunk.length === 0) continue;
    const rows = await db.insert(actionRunJobs).values(chunk).returning();
    newJobs.push(...rows);
  }

  // The attempt aggregate + the run mirror (rerun.go:367-369 —
  // AggregateJobStatus over the NEW attempt's jobs + UpdateRunAttempt
  // ('status'); the propagation is run_attempt.go:150-190's UpdateRunAttempt
  // port, scoped to this attempt's rows — update.ts's refreshRunStatus
  // twin aggregates ALL of the run's job rows (v1's one-attempt shape,
  // run_job.go:552-571's port lost the attempt filter) and is HANDOFFED to
  // its owner; rerun cannot ride it once attempt 2 rows exist).
  await updateAttemptStatusAndMirrorRun(d1, run, newAttempt, newJobs);

  // The dispatch wake (rerun.go:350-352, 372-376): only a dispatchable
  // (waiting, non-reusable-caller) job bumps the version.
  const hasWaitingJobs = newJobs.some(
    (job) => job.status === ACTION_STATUS_WAITING && !job.isReusableCaller,
  );
  if (hasWaitingJobs) {
    await increaseTaskVersion(d1, run.ownerId, run.repoId);
  }

  // Post-commit (rerun.go:388-396): notifyAndEmitFinishedJobs,
  // CreateCommitStatusForRunJobs, NotifyWorkflowJobsAndRunsStatusUpdate and
  // EmitJobsIfReadyByRun ride M3's notifier/status/emitter work (module
  // header) — the same tails every other producer defers.

  return { ok: true, attempt: newAttempt, jobs: newJobs };
}

// ---------------------------------------------------------------------------
// The attempt aggregate + run mirror (rerun.go:367-369 + UpdateRunAttempt,
// run_attempt.go:150-190)
// ---------------------------------------------------------------------------

/** UpdateRunAttempt(ctx, attempt, "status") (run_attempt.go:150-190): the
 *  started/stopped flips follow the status write, then the LATEST attempt
 *  propagates its status + timing onto the run (an older attempt only
 *  updates itself — the warn-and-skip arm). */
async function updateAttemptStatusAndMirrorRun(
  d1: D1,
  run: RunRow,
  attempt: RunAttemptRow,
  attemptJobs: RunJobRow[],
): Promise<void> {
  const db = drizzle(d1);
  const now = new Date();
  const next = aggregateJobStatus(attemptJobs.map((job) => ({ status: job.status, continueOnError: job.continueOnError })));
  const cols: { status: number; started?: Date | null; stopped?: Date | null } = { status: next };
  if (attempt.started === null && isRunningStatus(next)) cols.started = now; // run_attempt.go:151-154
  if (attempt.stopped === null && isDoneStatus(next)) cols.stopped = now; // run_attempt.go:155-158
  if (attempt.stopped !== null && !isDoneStatus(next)) cols.stopped = null; // run_attempt.go:159-162
  await db.update(actionRunAttempts).set({ ...cols, updated: now }).where(eq(actionRunAttempts.id, attempt.id));

  if (run.latestAttemptId !== attempt.id) return; // run_attempt.go:181-184's warn-and-skip
  await db
    .update(actionRuns)
    .set({ status: next, started: cols.started ?? attempt.started, stopped: cols.stopped ?? attempt.stopped, updated: now })
    .where(eq(actionRuns.id, run.id)); // run_attempt.go:186-189
}

// ---------------------------------------------------------------------------
// The artifact-inheritance chain (models/actions/run_attempt.go:104-148)
// ---------------------------------------------------------------------------

/** findPassThroughAttemptIDs (run_attempt.go:139-148): the attempts that were
 *  a partial rerun — only such attempts clone jobs carrying a source task
 *  (the DISTINCT run_attempt_id projection over source_task_id <> 0). */
async function findPassThroughAttemptIds(d1: D1, attemptIds: number[]): Promise<number[]> {
  if (attemptIds.length === 0) return [];
  const rows = await drizzle(d1)
    .selectDistinct({ runAttemptId: actionRunJobs.runAttemptId })
    .from(actionRunJobs)
    .where(
      and(
        ne(actionRunJobs.sourceTaskId, 0), // source_task_id <> 0
        inArray(actionRunJobs.runAttemptId, attemptIds),
      ),
    );
  return rows.map((row) => row.runAttemptId);
}

/** GetArtifactAttemptIDs (run_attempt.go:104-134): the attempts whose
 *  artifacts the job may read, NEWEST FIRST, always including its own. A
 *  partial rerun inherits the attempts it re-ran from (its pass-through jobs
 *  never re-upload); a full rerun starts over (the walk stops at the first
 *  attempt that passed no job through). */
export async function getArtifactAttemptIds(d1: D1, job: RunJobRow): Promise<number[]> {
  if (job.attempt <= 1 || job.runAttemptId === 0) {
    return [job.runAttemptId]; // run_attempt.go:105-107
  }
  const attempts = await listRunAttemptsByRunId(d1, job.runId); // attempt DESC
  const candidateIds = attempts
    .filter((a) => a.attempt > 1 && a.attempt <= job.attempt)
    .map((a) => a.id); // run_attempt.go:113-116
  const passThroughIds = new Set(await findPassThroughAttemptIds(d1, candidateIds));
  const ids: number[] = [];
  for (const attempt of attempts) {
    if (attempt.attempt > job.attempt) continue;
    ids.push(attempt.id);
    if (!passThroughIds.has(attempt.id)) break; // stops at the first non-pass-through attempt
  }
  return ids;
}

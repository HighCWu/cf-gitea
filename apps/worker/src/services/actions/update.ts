/**
 * The UpdateTask + UpdateLog ingestion services (SPEC-0012 §2.2, M1b) —
 * ported from routers/api/actions/runner/runner.go:220-359,
 * models/actions/task.go:447-647 (UpdateTaskByState / StopTask),
 * task_step.go (applyState / validateReportedSteps / updateReportedSteps)
 * and models/actions/run_job.go:642-687 (AggregateJobStatus / the
 * attempt-run status mirror).
 *
 * THE STAGED SHAPE: the M3 job emitter (needs-graph re-resolution,
 * `if:` evaluation) and the commit-status family are NOT here — M1b ports
 * their LIFECYCLE side effects that the runner protocol must not skip:
 * the attempt+run aggregate recompute (refreshRunStatus, the M1b substitute
 * for the emitter's run-status leg), the tasks_version wake bumps (run_job.go
 * 504-527), and the ephemeral-runner removal (UpdateTask's IsDone arm).
 * StopTask's terminal arm carries the same hook family on its path (the
 * UpdateRunJob version bump, the UpdateTask ephemeral removal, and — for the
 * sweep callers that pass the storage env — the clear_tasks.go log transfer),
 * plus the stranded-claim finalizer for the claim window the transactional
 * upstream claim cannot have (see finalizeStrandedTasksOfJob).
 * M3 replaces the aggregate arm with EmitJobsIfReadyByRun.
 */

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  actionLogChunks,
  actionRunAttempts,
  actionRunJobs,
  actionRunners,
  actionRuns,
  actionTaskOutputs,
  actionTaskSteps,
  actionTasks,
} from "../../db/schema";
import type { RunJobRow, TaskRow } from "./model";
import { decodeLogIndexes, encodeLogIndexes, nextChunkSeq, readLogs, renderLogAppend, sealLogsToStorage } from "./logs";
import {
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_CANCELLING,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SKIPPED,
  ACTION_STATUS_SUCCESS,
  ACTION_STATUS_WAITING,
  ellipsisDisplayString,
  increaseTaskVersion,
  isLiveTaskStatus,
  RUNNERV1_RESULT,
  statusToResult,
} from "./model";
import type { StepState, TaskState, UpdateLogRequest, UpdateTaskRequest } from "./wire";

type D1 = D1Database;

// ---------------------------------------------------------------------------
// Status helpers (models/actions/status.go)
// ---------------------------------------------------------------------------

/** Status.IsDone — the four terminal statuses. */
export function isDoneStatus(status: number): boolean {
  return (
    status === ACTION_STATUS_SUCCESS ||
    status === ACTION_STATUS_FAILURE ||
    status === ACTION_STATUS_CANCELLED ||
    status === ACTION_STATUS_SKIPPED
  );
}

/** Status.IsRunning. */
export function isRunningStatus(status: number): boolean {
  return status === ACTION_STATUS_RUNNING;
}

/** StatusFromResult (status.go:118-129). */
export function statusFromResult(result: number): number {
  switch (result) {
    case RUNNERV1_RESULT.SUCCESS:
      return ACTION_STATUS_SUCCESS;
    case RUNNERV1_RESULT.FAILURE:
      return ACTION_STATUS_FAILURE;
    case RUNNERV1_RESULT.CANCELLED:
      return ACTION_STATUS_CANCELLED;
    case RUNNERV1_RESULT.SKIPPED:
      return ACTION_STATUS_SKIPPED;
    default:
      return 0; // StatusUnknown
  }
}

/**
 * AggregateJobStatus (run_job.go:642-687) minus the fail-fast matrix arm
 * (matrix expansion is M3 — `GetFailFast` reads the deferred matrix payload
 * no v1 row carries; the arm's guard `IsMatrixSiblingOf` can never fire).
 */
export function aggregateJobStatus(jobs: Array<Pick<RunJobRow, "status" | "continueOnError">>): number {
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
    // A failed job with continue-on-error:true does not fail the workflow run.
    const isContinuedFailure = job.continueOnError && job.status === ACTION_STATUS_FAILURE;
    allSuccessOrSkipped =
      allSuccessOrSkipped && (job.status === ACTION_STATUS_SUCCESS || job.status === ACTION_STATUS_SKIPPED || isContinuedFailure);
    allSkipped = allSkipped && job.status === ACTION_STATUS_SKIPPED;
    hasFailure = hasFailure || (job.status === ACTION_STATUS_FAILURE && !job.continueOnError);
    hasCancelled = hasCancelled || job.status === ACTION_STATUS_CANCELLED;
    hasCancelling = hasCancelling || job.status === ACTION_STATUS_CANCELLING;
    hasWaiting = hasWaiting || job.status === ACTION_STATUS_WAITING;
    hasRunning = hasRunning || job.status === ACTION_STATUS_RUNNING;
    hasBlocked = hasBlocked || job.status === 7;
    hasPending = hasPending || job.status === 9;
  }
  if (allSkipped) return ACTION_STATUS_SKIPPED;
  if (allSuccessOrSkipped) return ACTION_STATUS_SUCCESS;
  if (hasCancelling) return ACTION_STATUS_CANCELLING;
  if (hasRunning) return ACTION_STATUS_RUNNING;
  if (hasWaiting) return ACTION_STATUS_WAITING;
  if (hasBlocked) return 7;
  if (hasPending) return ACTION_STATUS_RUNNING; // a run with only pending jobs left is still in progress
  if (hasCancelled) return ACTION_STATUS_CANCELLED;
  if (hasFailure) return ACTION_STATUS_FAILURE;
  return 0;
}

/**
 * refreshRunStatus (run_job.go:567-600): recompute the attempt's aggregate
 * from its jobs; the latest attempt propagates to the run (status + started/
 * stopped mirrors, UpdateRunAttempt's rules). The M1b substitute for the
 * emitter's run-status leg (module header).
 */
export async function refreshRunStatus(d1: D1, repoId: string, runId: number, runAttemptId: number): Promise<void> {
  const db = drizzle(d1);
  const now = new Date();
  const jobs = await db
    .select({ status: actionRunJobs.status, continueOnError: actionRunJobs.continueOnError })
    .from(actionRunJobs)
    .where(eq(actionRunJobs.runId, runId));

  if (runAttemptId > 0) {
    const attemptRows = await db
      .select()
      .from(actionRunAttempts)
      .where(and(eq(actionRunAttempts.repoId, repoId), eq(actionRunAttempts.id, runAttemptId)))
      .limit(1);
    const attempt = attemptRows[0];
    if (attempt !== undefined) {
      const next = aggregateJobStatus(jobs);
      const cols: { status: number; started?: Date | null; stopped?: Date | null } = { status: next };
      if (attempt.started === null && isRunningStatus(next)) {
        cols.started = now;
      }
      if (attempt.stopped === null && isDoneStatus(next)) {
        cols.stopped = now;
      }
      if (attempt.stopped !== null && !isDoneStatus(next)) {
        cols.stopped = null;
      }
      await db
        .update(actionRunAttempts)
        .set({ ...cols, updated: now })
        .where(eq(actionRunAttempts.id, attempt.id));
    }
  }

  // The run mirrors its LATEST attempt (UpdateRunAttempt's propagation).
  const runRows = await db
    .select()
    .from(actionRuns)
    .where(and(eq(actionRuns.repoId, repoId), eq(actionRuns.id, runId)))
    .limit(1);
  const run = runRows[0];
  if (run === undefined) {
    return;
  }
  let runStatus: number;
  let started: Date | null = run.started;
  let stopped: Date | null = run.stopped;
  if (run.latestAttemptId > 0) {
    const latestRows = await db.select().from(actionRunAttempts).where(eq(actionRunAttempts.id, run.latestAttemptId)).limit(1);
    const latest = latestRows[0];
    if (latest === undefined) {
      return;
    }
    runStatus = latest.status;
    started = latest.started;
    stopped = latest.stopped;
  } else {
    runStatus = aggregateJobStatus(jobs);
    if (jobs.length === 0) {
      runStatus = 0;
    }
    if (started === null && isRunningStatus(runStatus)) {
      started = now;
    }
    if (stopped === null && isDoneStatus(runStatus)) {
      stopped = now;
    }
  }
  await db.update(actionRuns).set({ status: runStatus, started, stopped, updated: now }).where(eq(actionRuns.id, run.id));
}

/** hasWaitingJobsToPick (run_job.go:449-455) — only bump when waiting work
 *  remains. Exported for the sweeps' cancel/stop arms, whose job-status
 *  writes carry the same UpdateRunJob hook upstream. */
export async function hasWaitingJobsToPick(d1: D1, repoId: string): Promise<boolean> {
  const db = drizzle(d1);
  const rows = await db
    .select({ id: actionRunJobs.id })
    .from(actionRunJobs)
    .where(and(eq(actionRunJobs.repoId, repoId), eq(actionRunJobs.status, ACTION_STATUS_WAITING), eq(actionRunJobs.taskId, 0)))
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Steps (task_step.go)
// ---------------------------------------------------------------------------

export type TaskStepRow = typeof actionTaskSteps.$inferSelect;

/** WorkflowStepIndex (task_step.go:51-59). */
export function workflowStepIndex(step: Pick<TaskStepRow, "index" | "stage" | "number">): number {
  const stage = step.stage;
  if (stage === 0) {
    return step.index;
  }
  if (stage === 4 /* STEP_STAGE_MAIN */) {
    return step.number;
  }
  return -1;
}

/** applyState (task_step.go:71-87) — mutate a step row per the reported state. */
function applyStepState(step: TaskStepRow, state: StepState | undefined, now: Date): void {
  let result: number = RUNNERV1_RESULT.UNSPECIFIED;
  if (state !== undefined) {
    result = state.result;
    step.logIndex = state.logIndex;
    step.logLength = state.logLength;
    if (step.started === null && state.startedAt !== undefined) {
      step.started = now;
    }
  }
  if (result !== RUNNERV1_RESULT.UNSPECIFIED) {
    step.status = statusFromResult(result);
    step.stopped = step.stopped ?? now;
  } else if (step.started !== null) {
    step.status = ACTION_STATUS_RUNNING;
  }
}

/** stop (task_step.go:90-97) — finish a step that outlived its task. */
function stopStep(step: TaskStepRow, status: number, now: Date): void {
  if (isDoneStatus(step.status)) {
    return;
  }
  step.status = status;
  step.started = step.started ?? now;
  step.stopped = now;
}

const MAX_REPORTED_STEPS = 1000;

/** validateReportedSteps (task_step.go:107-124). Null when invalid — the
 *  caller ignores the reported steps with a warning (task.go:488-491). */
export function validateReportedSteps(steps: StepState[]): Array<{ stage: number; number: number }> | null {
  if (steps.length > MAX_REPORTED_STEPS) {
    return null;
  }
  const seen = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const v = steps[i];
    if (v === undefined) {
      return null;
    }
    if (v.stage <= 0) {
      return null; // a stage added later is shown by its name
    }
    if (v.id !== i || v.number < 0 || v.logIndex < 0 || v.logLength < 0) {
      return null;
    }
    const key = `${v.stage}:${v.number}`;
    if (seen.has(key)) {
      return null;
    }
    seen.add(key);
  }
  return steps.map((v) => ({ stage: v.stage, number: v.number }));
}

/** IsReported (task_step.go:46-48). */
function isReportedStep(step: Pick<TaskStepRow, "stage">): boolean {
  return step.stage !== 0;
}

async function getTaskSteps(d1: D1, taskId: number): Promise<TaskStepRow[]> {
  const db = drizzle(d1);
  return db.select().from(actionTaskSteps).where(eq(actionTaskSteps.taskId, taskId)).orderBy(actionTaskSteps.index);
}

/** GetTaskStepsByTaskID (task_step.go:65-68) — the job-summary step
 *  validation and the M1c UI read through this. */
export async function getTaskStepsByTaskId(d1: D1, taskId: number): Promise<TaskStepRow[]> {
  return getTaskSteps(d1, taskId);
}

async function persistStep(d1: D1, step: TaskStepRow): Promise<void> {
  await drizzle(d1)
    .update(actionTaskSteps)
    .set({
      name: step.name,
      status: step.status,
      logIndex: step.logIndex,
      logLength: step.logLength,
      stage: step.stage,
      number: step.number,
      started: step.started,
      stopped: step.stopped,
      updated: new Date(),
    })
    .where(eq(actionTaskSteps.id, step.id));
}

/**
 * updateReportedSteps (task_step.go:128-185): replace the steps with the
 * ones the runner reported; a same-layout report updates in place and a
 * step keeps its times/status when re-reported at the same position.
 */
async function updateReportedSteps(d1: D1, task: TaskRow, reported: StepState[], now: Date): Promise<void> {
  const db = drizzle(d1);
  const stored = await getTaskSteps(d1, task.id);

  let sameLayout = stored.length === reported.length;
  for (let i = 0; sameLayout && i < reported.length; i++) {
    const step = stored[i];
    const rep = reported[i];
    if (step === undefined || rep === undefined) {
      sameLayout = false;
      break;
    }
    sameLayout = isReportedStep(step) && step.stage === rep.stage && step.number === rep.number;
  }

  if (sameLayout) {
    for (let i = 0; i < stored.length; i++) {
      const step = stored[i];
      const rep = reported[i];
      if (step === undefined || rep === undefined) {
        continue;
      }
      step.name = ellipsisDisplayString(rep.name, 255);
      applyStepState(step, rep, now);
      if (isDoneStatus(task.status)) {
        stopStep(step, task.status, now);
      }
      await persistStep(d1, step);
    }
    return;
  }

  const known = new Map<string, TaskStepRow>();
  for (const step of stored) {
    if (isReportedStep(step)) {
      known.set(`${step.stage}:${step.number}`, step);
    }
  }
  await db.delete(actionTaskSteps).where(eq(actionTaskSteps.taskId, task.id));
  const nowDate = new Date();
  const rows = reported.map((v, i) => {
    const key = `${v.stage}:${v.number}`;
    const old = known.get(key);
    const step: TaskStepRow = {
      id: 0,
      name: ellipsisDisplayString(v.name, 255),
      taskId: task.id,
      index: i,
      repoId: task.repoId,
      status: ACTION_STATUS_WAITING,
      logIndex: v.logIndex,
      logLength: v.logLength,
      stage: v.stage,
      number: v.number,
      started: old?.started ?? null,
      stopped: old?.stopped ?? null,
      created: nowDate,
      updated: nowDate,
    };
    if (old !== undefined) {
      step.status = old.status;
    }
    applyStepState(step, v, now);
    if (isDoneStatus(task.status)) {
      stopStep(step, task.status, now);
    }
    return step;
  });
  if (rows.length > 0) {
    // 13 columns × N rows vs D1's 100-bind cap → 7 rows per statement.
    const stepValues = rows.map((s) => ({
      name: s.name,
      taskId: s.taskId,
      index: s.index,
      repoId: s.repoId,
      status: s.status,
      logIndex: s.logIndex,
      logLength: s.logLength,
      stage: s.stage,
      number: s.number,
      started: s.started,
      stopped: s.stopped,
      created: s.created,
      updated: s.updated,
    }));
    const STEP_CHUNK = 7;
    for (let i = 0; i < stepValues.length; i += STEP_CHUNK) {
      await db.insert(actionTaskSteps).values(stepValues.slice(i, i + STEP_CHUNK));
    }
  }
}

// ---------------------------------------------------------------------------
// UpdateTaskByState (models/actions/task.go:481-565)
// ---------------------------------------------------------------------------

export interface UpdateTaskByStateResult {
  task: TaskRow;
  /** The stored step rows after the state application (the job-summary
   *  step validation + UI read these). */
  steps: TaskStepRow[];
}

/**
 * UpdateTaskByState: the state machine. A final task is a no-op ("the state
 * is final, do nothing"); a non-unspecified result finishes the task/job
 * (the cancelling-preservation arm included); otherwise only `updated`
 * advances so the zombie sweep does not kill a live task.
 */
export async function updateTaskByState(d1: D1, runnerId: number, state: TaskState): Promise<UpdateTaskByStateResult> {
  const db = drizzle(d1);
  const now = new Date();
  const stepStates = new Map<number, StepState>();
  for (const v of state.steps) {
    stepStates.set(v.id, v);
  }
  let reportedSteps = state.reportedSteps;
  if (validateReportedSteps(reportedSteps) === null) {
    reportedSteps = [];
  }

  const taskRows = await db.select().from(actionTasks).where(eq(actionTasks.id, state.id)).limit(1);
  const task = taskRows[0];
  if (task === undefined) {
    throw new Error("task does not exist");
  }
  if (runnerId !== task.runnerId) {
    throw new Error("invalid runner for task");
  }

  if (!isDoneStatus(task.status)) {
    if (state.result !== RUNNERV1_RESULT.UNSPECIFIED) {
      if (task.status === ACTION_STATUS_CANCELLING) {
        // The runner may report SUCCESS/FAILURE for the cleanup phase;
        // preserve user intent.
        task.status = ACTION_STATUS_CANCELLED;
      } else {
        task.status = statusFromResult(state.result);
      }
      task.stopped = now;
      await db
        .update(actionTasks)
        .set({ status: task.status, stopped: now, updated: now })
        .where(eq(actionTasks.id, task.id));

      // The job mirrors the task's finish (UpdateRunJob's status/stopped cols).
      await db
        .update(actionRunJobs)
        .set({ status: task.status, stopped: now, updated: now })
        .where(and(eq(actionRunJobs.id, task.jobId), eq(actionRunJobs.repoId, task.repoId)));
    } else {
      // Force-update updated so the task is not judged a zombie.
      await db.update(actionTasks).set({ updated: now }).where(eq(actionTasks.id, task.id));
    }
  }

  const steps = await getTaskSteps(d1, task.id);

  if (reportedSteps.length > 0) {
    await updateReportedSteps(d1, task, reportedSteps, now);
  } else if (!steps.some(isReportedStep)) {
    // The indexes of the steps of the workflow file still match the stored
    // steps — apply the per-step states (v1: steps arrive runner-reported
    // or not at all; the workflow-parse arm is M3).
    for (const step of steps) {
      applyStepState(step, stepStates.get(step.index), now);
      await persistStep(d1, step);
    }
  }

  return { task, steps: await getTaskSteps(d1, task.id) };
}

/** DeleteEphemeralRunner (runner.go:378-393) — no-op unless ephemeral. */
async function deleteEphemeralRunner(d1: D1, runnerId: number): Promise<void> {
  const db = drizzle(d1);
  const rows = await db.select().from(actionRunners).where(eq(actionRunners.id, runnerId)).limit(1);
  const runner = rows[0];
  if (runner !== undefined && runner.ephemeral) {
    await db.delete(actionRunners).where(eq(actionRunners.id, runnerId));
  }
}

// ---------------------------------------------------------------------------
// Outputs (task_output.go + runner.go:231-254)
// ---------------------------------------------------------------------------

/** InsertTaskOutputIfNotExist — upsert-if-absent (the UNIQUE arbitrates). */
export async function insertTaskOutputIfNotExist(d1: D1, taskId: number, key: string, value: string): Promise<void> {
  await drizzle(d1)
    .insert(actionTaskOutputs)
    .values({ taskId, outputKey: key, outputValue: value })
    .onConflictDoNothing();
}

/** FindTaskOutputKeyByTaskID — ALL stored keys (the runner resends the rest). */
export async function findTaskOutputKeyByTaskID(d1: D1, taskId: number): Promise<string[]> {
  const rows = await drizzle(d1)
    .select({ key: actionTaskOutputs.outputKey })
    .from(actionTaskOutputs)
    .where(eq(actionTaskOutputs.taskId, taskId));
  return rows.map((r) => r.key);
}

// ---------------------------------------------------------------------------
// UpdateTask (runner.go:220-285)
// ---------------------------------------------------------------------------

export interface UpdateTaskOutcome {
  stateId: number;
  /** task.Status.AsResult() — the task's ACTUAL status spelled as a result. */
  result: number;
  sentOutputs: string[];
}

/**
 * The UpdateTask handler service: state machine → outputs (≤255-byte keys /
 * ≤1 MiB values, skipped not fatal) → sentOutputs (all stored keys) → the
 * lifecycle side effects (run aggregate, tasks_version wake, ephemeral
 * removal).
 */
export async function updateTask(d1: D1, runnerId: number, req: UpdateTaskRequest): Promise<UpdateTaskOutcome> {
  if (req.state === undefined) {
    throw new Error("state is required");
  }
  const db = drizzle(d1);
  // The job's PRE-report status — the state machine flips the job row, so
  // reading it afterwards would always see done and skip the arms below.
  const preTaskRows = await db.select().from(actionTasks).where(eq(actionTasks.id, req.state.id)).limit(1);
  const preTask = preTaskRows[0];
  let preJobWasDone = true;
  if (preTask !== undefined) {
    const preJobRows = await db.select().from(actionRunJobs).where(eq(actionRunJobs.id, preTask.jobId)).limit(1);
    preJobWasDone = preJobRows[0] !== undefined && isDoneStatus(preJobRows[0].status);
  }
  const { task } = await updateTaskByState(d1, runnerId, req.state);

  for (const [k, v] of Object.entries(req.outputs)) {
    if (new TextEncoder().encode(k).length > 255) {
      continue; // logged-and-skipped upstream (the runner resends the rest)
    }
    if (new TextEncoder().encode(v).length > 1024 * 1024) {
      continue;
    }
    // It's ok not to return errors: the runner resends the outputs.
    await insertTaskOutputIfNotExist(d1, task.id, k, v).catch(() => {});
  }
  const sentOutputs = await findTaskOutputKeyByTaskID(d1, task.id).catch(() => []);

  const jobRows = await db.select().from(actionRunJobs).where(eq(actionRunJobs.id, task.jobId)).limit(1);
  const job = jobRows[0];
  if (job === undefined) {
    throw new Error(`actions: job ${task.jobId} for task ${task.id} vanished`);
  }

  // The lifecycle writes (M1b's emitter substitute — module header):
  // the attempt/run aggregate, the tasks_version wake, ephemeral removal.
  await refreshRunStatus(d1, job.repoId, job.runId, job.runAttemptId);
  if (!preJobWasDone && isDoneStatus(task.status)) {
    // Only bump when waiting work remains (run_job.go:513-527).
    if (await hasWaitingJobsToPick(d1, job.repoId)) {
      await increaseTaskVersion(d1, job.ownerId, job.repoId);
    }
    await deleteEphemeralRunner(d1, task.runnerId);
  }

  return {
    stateId: req.state.id,
    result: statusToResult(task.status),
    sentOutputs,
  };
}

// ---------------------------------------------------------------------------
// StopTask + the zombie sweep (models/actions/task.go:568-632)
// ---------------------------------------------------------------------------

/** The taskReportTimeout (task.go:65) — a cancelling task's handshake bound. */
const TASK_REPORT_TIMEOUT_MS = 60 * 1000;

/**
 * The stopTasks sweep's log transfer (clear_tasks.go:177-187): seal the dead
 * task's hot chunk rows into the R2 object, THEN flip log_in_storage and
 * drop the rows (the object is durable first — the updateLog seal's
 * ordering). Upstream's sweep transfers a stopped task's logs regardless of
 * any retention setting, and a transfer failure is warn-and-continue there
 * ("Cannot transfer logs of task %v") — callers swallow the throw the same
 * way. The runner-driven twin is updateLog's NoMore seal; this is the
 * sweep-driven one (the runner never said NoMore — it is gone).
 */
export async function archiveStoppedTaskLogs(
  env: Env,
  task: Pick<TaskRow, "id" | "logInStorage" | "logFilename">,
): Promise<void> {
  if (task.logInStorage || task.logFilename === "") {
    return; // already sealed, or the claim crashed before the filename landed
  }
  await sealLogsToStorage(env, task.id, task.logFilename);
  await drizzle(env.DB).batch([
    drizzle(env.DB)
      .update(actionTasks)
      .set({ logInStorage: true, updated: new Date() })
      .where(eq(actionTasks.id, task.id)),
    drizzle(env.DB).delete(actionLogChunks).where(eq(actionLogChunks.taskId, task.id)),
  ]);
}

/**
 * The stranded-claim finalizer. Upstream claims inside ONE transaction
 * (claimJobForRunner's db.WithTx, models/actions/task.go:341-414 — task
 * insert, log filename, steps, conditional job update all commit or
 * nothing), so a crash mid-claim leaves nothing behind. Ours inserts the
 * task row and only then CASes the job (the documented M1a window), so a
 * crash or isolate eviction between the two strands an orphan RUNNING task
 * whose job is still waiting — and an ephemeral runner holding the orphan
 * then fails pickTask's one-task-per-lifetime check forever. Upstream's
 * closest mechanism is the zombie sweep's terminalization of untouched
 * RUNNING tasks; this finalizer keys the same terminalization on the job:
 * when a terminal stop lands for the job, every other LIVE task row of that
 * job is finalized with the job's stop status — the task-terminal-with-job
 * invariant the transaction guarantees upstream — its steps stop, its hot
 * logs archive when storage is supplied, and its ephemeral runner is
 * auto-deleted (upstream's UpdateTask hook, task.go:452-464, fires per task
 * row).
 */
async function finalizeStrandedTasksOfJob(d1: D1, task: TaskRow, effective: number, now: Date, env?: Env): Promise<void> {
  const db = drizzle(d1);
  const stranded = await db
    .select()
    .from(actionTasks)
    .where(and(eq(actionTasks.jobId, task.jobId), ne(actionTasks.id, task.id)));
  for (const orphan of stranded) {
    if (!isLiveTaskStatus(orphan.status)) {
      continue;
    }
    await db
      .update(actionTasks)
      .set({ status: effective, stopped: now, updated: now })
      .where(eq(actionTasks.id, orphan.id));
    const orphanSteps = await getTaskSteps(d1, orphan.id);
    for (const step of orphanSteps) {
      stopStep(step, effective, now);
      await persistStep(d1, step);
    }
    await deleteEphemeralRunner(d1, orphan.runnerId);
    if (env !== undefined) {
      await archiveStoppedTaskLogs(env, orphan).catch(() => {});
    }
  }
}

/**
 * StopTask (task.go:568-632): force-finish a task. The cancelling arm
 * negotiates (runner capability + report freshness) unless the runner is
 * gone; the terminal arm stops the task, job, and its steps outright and
 * carries the three piggybacks upstream's model hooks hang on that path:
 * the tasks_version wake when waiting siblings remain (StopTask →
 * UpdateRunJob → run_job.go:511-530), the ephemeral-runner auto-delete
 * (StopTask → UpdateTask → task.go:452-464), and — when the caller supplies
 * the storage env, as the sweeps do — the dead task's log transfer
 * (clear_tasks.go:177-187). `env` is optional because upstream's other
 * StopTask callers (cancelOneJob, run_job.go:818-829) do NOT transfer logs;
 * only the sweeps do.
 */
export async function stopTask(d1: D1, taskId: number, status: number, env?: Env): Promise<void> {
  if (!isDoneStatus(status) && status !== ACTION_STATUS_CANCELLING) {
    throw new Error(`cannot stop task with status ${status}`);
  }
  const db = drizzle(d1);
  const now = new Date();

  const taskRows = await db.select().from(actionTasks).where(eq(actionTasks.id, taskId)).limit(1);
  const task = taskRows[0];
  if (task === undefined) {
    throw new Error("task does not exist");
  }
  if (isDoneStatus(task.status)) {
    return;
  }

  let effective = status;
  if (effective === ACTION_STATUS_CANCELLING) {
    const runnerRows = await db.select().from(actionRunners).where(eq(actionRunners.id, task.runnerId)).limit(1);
    const runner = runnerRows[0];
    if (runner === undefined) {
      effective = ACTION_STATUS_CANCELLED;
    } else if (!runner.hasCancellingSupport) {
      effective = ACTION_STATUS_CANCELLED;
    } else if (task.updated.getTime() + TASK_REPORT_TIMEOUT_MS < now.getTime()) {
      // A runner that stopped reporting will never acknowledge the
      // cancellation either; skip the handshake.
      effective = ACTION_STATUS_CANCELLED;
    }
  }

  if (effective === ACTION_STATUS_CANCELLING) {
    await db
      .update(actionRunJobs)
      .set({ status: ACTION_STATUS_CANCELLING, updated: now })
      .where(and(eq(actionRunJobs.id, task.jobId), eq(actionRunJobs.repoId, task.repoId)));
    await db.update(actionTasks).set({ status: ACTION_STATUS_CANCELLING }).where(eq(actionTasks.id, task.id));
    return;
  }

  task.status = effective;
  task.stopped = now;
  await db
    .update(actionRunJobs)
    .set({ status: effective, stopped: now, updated: now })
    .where(and(eq(actionRunJobs.id, task.jobId), eq(actionRunJobs.repoId, task.repoId)));
  await db.update(actionTasks).set({ status: effective, stopped: now, updated: now }).where(eq(actionTasks.id, task.id));

  const steps = await getTaskSteps(d1, task.id);
  for (const step of steps) {
    stopStep(step, effective, now);
    await persistStep(d1, step);
  }

  // The stranded orphans first (they share the job; the aggregate below
  // reads job rows, which are already terminal).
  await finalizeStrandedTasksOfJob(d1, task, effective, now, env);

  const jobRows = await db.select().from(actionRunJobs).where(eq(actionRunJobs.id, task.jobId)).limit(1);
  const job = jobRows[0];
  if (job !== undefined) {
    // Piggyback (run_job.go:511-530): the job's terminal status leaves
    // waiting siblings pickable — bump so idle runners whose tasksVersion
    // equals latestVersion re-poll; only when waiting work remains.
    if (await hasWaitingJobsToPick(d1, job.repoId)) {
      await increaseTaskVersion(d1, job.ownerId, job.repoId);
    }
    await refreshRunStatus(d1, job.repoId, job.runId, job.runAttemptId);
  }

  // Piggyback (task.go:452-464): the task flipped done, so an ephemeral
  // runner's lifetime ends with it.
  await deleteEphemeralRunner(d1, task.runnerId);

  if (env !== undefined) {
    await archiveStoppedTaskLogs(env, task).catch(() => {});
  }
}

/** FindOldTasksToExpire (task.go:645-650) — the log-retention scan. */
export async function findOldTasksToExpire(d1: D1, olderThan: Date, limit: number): Promise<TaskRow[]> {
  const db = drizzle(d1);
  const rows = await db
    .select()
    .from(actionTasks)
    .where(
      and(
        sql`${actionTasks.stopped} IS NOT NULL AND ${actionTasks.stopped} < ${Math.floor(olderThan.getTime() / 1000)}`,
        eq(actionTasks.logExpired, false),
      ),
    )
    .limit(limit);
  return rows;
}

// ---------------------------------------------------------------------------
// UpdateLog (runner.go:288-359)
// ---------------------------------------------------------------------------

export interface UpdateLogOutcome {
  ackIndex: number;
}

/** The connect AlreadyExists answer spelling UpdateLog's archive-guard maps to. */
export class ConnectLikeAlreadyExists extends Error {}

/**
 * The UpdateLog handler service — the ack protocol, byte-for-byte:
 *   trim already-acked rows → archived-guard (AlreadyExists on appends past
 *   the seal) → the bail branch (no new rows and not a legal finalize) →
 *   the append batch (one chunk row per call + the task-column advance,
 *   atomic in one D1 batch) → the seal (R2 merge, then flip + drop).
 */
export async function updateLog(env: Env, runnerId: number, req: UpdateLogRequest): Promise<UpdateLogOutcome> {
  const d1 = env.DB;
  const db = drizzle(d1);

  const taskRows = await db.select().from(actionTasks).where(eq(actionTasks.id, req.taskId)).limit(1);
  const task = taskRows[0];
  if (task === undefined) {
    throw new Error("get task: task does not exist");
  }
  if (runnerId !== task.runnerId) {
    throw new Error("invalid runner for task");
  }
  const ack = task.logLength;

  // Trim rows the runner already had acked.
  let rows = req.rows;
  if (req.index <= ack && rows.length + req.index > ack) {
    rows = rows.slice(ack - req.index);
  }

  // Ack a re-sent finalize idempotently. Appending new rows past the seal errors.
  if (task.logInStorage) {
    if (rows.length > 0) {
      throw new ConnectLikeAlreadyExists("log file has been archived");
    }
    return { ackIndex: ack };
  }

  // Bail unless we have new rows or a NoMore to finalize. Even with NoMore,
  // bail when the runner has outrun the server — archiving a log with a gap
  // is worse than asking it to retry.
  if (rows.length === 0 && (!req.noMore || req.index > ack)) {
    return { ackIndex: ack };
  }

  // Render the append bytes (even with zero rows: the empty-log bootstrap
  // still advances nothing but must allow the seal below). The wire rows'
  // protobuf timestamps spell Dates for the line format.
  const { bytes, sizes } = renderLogAppend(
    rows.map((row) => ({
      time: row.time !== undefined ? new Date(row.time.seconds * 1000 + Math.floor(row.time.nanos / 1e6)) : undefined,
      content: row.content,
    })),
  );

  if (rows.length > 0) {
    // One chunk row per call (SPEC §4.3), inserted in the SAME batch as the
    // task-column advance — the DBFS hole-guard is subsumed by atomicity
    // (a torn append is impossible; logSize always matches the chunk family).
    const now = new Date();
    const indexes = decodeOrEmpty(task.logIndexes);
    for (const n of sizes) {
      indexes.push(task.logSize);
      task.logSize += n;
    }
    task.logLength += rows.length;
    await db.batch([
      db.insert(actionLogChunks).values({
        taskId: task.id,
        seq: nextChunkSeq(task.id),
        bytes,
      }),
      db
        .update(actionTasks)
        .set({
          logLength: task.logLength,
          logSize: task.logSize,
          logIndexes: encodeLogIndexes(indexes),
          updated: now,
        })
        .where(eq(actionTasks.id, task.id)),
    ]);
  }

  const result: UpdateLogOutcome = { ackIndex: task.logLength };

  if (req.noMore) {
    // Seal: merge the chunk family into the R2 object FIRST; only after the
    // object is durable flip log_in_storage and drop the rows (upstream's
    // TransferLogs → UpdateTask → remove() ordering, runner.go:343-356).
    await sealLogsToStorage(env, task.id, task.logFilename);
    await db.batch([
      db
        .update(actionTasks)
        .set({ logInStorage: true, updated: new Date() })
        .where(eq(actionTasks.id, task.id)),
      db.delete(actionLogChunks).where(eq(actionLogChunks.taskId, task.id)),
    ]);
  }

  return result;
}

function decodeOrEmpty(value: unknown): number[] {
  if (!(value instanceof Uint8Array) || value.length === 0) {
    return [];
  }
  return decodeLogIndexes(value);
}

// ---------------------------------------------------------------------------
// The logs-download read seam (the /api/v1 job-logs endpoint + the M1c UI
// log panel read through this; upstream ReadLogs, modules/actions/log.go)
// ---------------------------------------------------------------------------

export async function readTaskLogs(
  env: Env,
  task: Pick<TaskRow, "id" | "logInStorage" | "logFilename">,
  offset: number,
  limit: number,
): Promise<Array<{ time: Date; content: string }>> {
  return readLogs(env, task.logInStorage, task.logFilename, task.id, offset, limit);
}

/** The job rows of a run (the aggregate's input; used by retention + tests). */
export async function jobsOfRun(d1: D1, runId: number): Promise<RunJobRow[]> {
  return drizzle(d1).select().from(actionRunJobs).where(inArray(actionRunJobs.runId, [runId]));
}

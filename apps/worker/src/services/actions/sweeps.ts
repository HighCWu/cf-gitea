/**
 * The always-on Actions sweeps (SPEC-0012 §4.5, the parity-review §5 items):
 * upstream's stop_endless_tasks, cancel_abandoned_jobs and the ephemeral
 * half of Cleanup — the arms the first wave left un-ported. Sources at the
 * pin fc493688:
 *   - services/actions/clear_tasks.go:32-39 (StopEndlessTasks), :195-214
 *     (CancelAbandonedJobs), :151-193 (stopTasks — the shared stop loop with
 *     the per-task stop status and the log transfer),
 *   - services/cron/tasks_actions.go:38-55 (the registrations:
 *     stop_endless_tasks @every 30m, cancel_abandoned_jobs @every 6h, both
 *     RunAtStart, enabled default — no retention knob, always-on exactly
 *     like the already-ported stop_zombie_tasks),
 *   - modules/setting/actions.go:133-135 (ENDLESS_TASK_TIMEOUT 3h,
 *     ABANDONED_JOB_TIMEOUT 24h; ZOMBIE_TASK_TIMEOUT 10m lives in
 *     retention.ts),
 *   - models/actions/run_job.go:806-829 (cancelOneJob — the direct-cancel
 *     CAS arm the abandoned sweep rides for unclaimed jobs),
 *   - services/actions/cleanup.go:144-165 (CleanupEphemeralRunners — the
 *     pass this module decouples from the retention arming; upstream runs it
 *     unconditionally inside every nightly Cleanup).
 *
 * THE PLATFORM MAPPING (AGENTS.md: crons enqueue, consumers do the work) is
 * the ratified producer/consumer shape the retention.ts zombie arm rides:
 * each sweep is an indexed LIMIT-1 existence PROBE + at most ONE
 * `{kind: …}` message on REPO_TASKS; the REPO_TASKS consumer runs the sweep
 * with its own queue budget. None of these arms is var-gated (upstream's
 * are always-on), none deletes user data (the §2 data-deletion invariant's
 * scope is the retention/demo families), and a quiet instance sends zero
 * messages. Cadence is the ratified Info divergence: the producers ride the
 * standing cron entries (step/hourly — the dispatcher blocks are a HANDOFF
 * insertion, see the module report), not upstream's exact @every 30m / 6h /
 * @midnight schedules; both sweeps are idempotent "older than X" passes, so
 * the difference is kill latency, not behavior.
 *
 * STAGED (the update.ts header's posture): upstream's sweep tails
 * (notifyAndEmitFinishedJobs, CreateCommitStatusForRunJobs) are the M3
 * emitter/commit-status family; cancelReusableCaller's descendant cascade
 * is the M3 reusable-workflow machinery (no v1 row carries parent_job_id >
 * 0, so the flat cancel covers every row that exists today). The runs'
 * aggregate recompute (refreshRunStatus) and the tasks_version wake (the
 * UpdateRunJob hook) are live — the runner protocol must not skip them.
 */

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionRunJobs, actionRunners, actionTasks } from "../../db/schema";
import {
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_CANCELLING,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_RUNNING,
  increaseTaskVersion,
} from "./model";
import { cleanupEphemeralRunners, type ActionsRetentionEnv } from "./retention";
import { hasWaitingJobsToPick, refreshRunStatus, stopTask } from "./update";

/** ENDLESS_TASK_TIMEOUT (modules/setting/actions.go:134, default 3h). */
export const ENDLESS_TASK_TIMEOUT_MS = 3 * 60 * 60 * 1000;
/** ABANDONED_JOB_TIMEOUT (modules/setting/actions.go:135, default 24h). */
export const ABANDONED_JOB_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** The live (non-terminal) task statuses (models/actions/status.go IsDone's
 *  complement over the task-reachable set; the ephemeral keep-set's arms). */
const LIVE_TASK_STATUSES = [5, 6, 7, 8]; // waiting | running | blocked | cancelling

// ---------------------------------------------------------------------------
// StopEndlessTasks (clear_tasks.go:32-39 + the shared stopTasks loop)
// ---------------------------------------------------------------------------

/**
 * StopEndlessTasks: RUNNING tasks whose START passed the endless timeout
 * stop as FAILURE (the shared stopTasks picks the stop status per task and
 * only a CANCELLING task stops as CANCELLED — an endless task is RUNNING by
 * definition, clear_tasks.go:160-163). RUNNING-only is deliberate upstream:
 * the threshold is the task's start, so a CANCELLING task mid post-cancel
 * cleanup must not be killed here (the zombie sweep covers a stalled one,
 * keying off the last update instead — clear_tasks.go:32-34's comment).
 * Note the two sweeps key on DIFFERENT columns: endless on `started` (a
 * task may stream `updated` forever), zombie on `updated` — neither covers
 * the other's blind spot. When `env` is supplied, stopTask's piggyback also
 * transfers each dead task's logs (clear_tasks.go:177-187).
 */
export async function stopEndlessTasks(
  d1: D1Database,
  options: { timeoutMs?: number; env?: Env } = {},
): Promise<number> {
  const db = drizzle(d1);
  const cutoff = new Date(Date.now() - (options.timeoutMs ?? ENDLESS_TASK_TIMEOUT_MS));
  const endless = await db
    .select({ id: actionTasks.id })
    .from(actionTasks)
    .where(
      and(
        eq(actionTasks.status, ACTION_STATUS_RUNNING),
        lt(actionTasks.started, cutoff),
      ),
    );
  let stopped = 0;
  for (const task of endless) {
    try {
      await stopTask(d1, task.id, ACTION_STATUS_FAILURE, options.env);
      stopped += 1;
    } catch {
      // the sweep never fails on one task (stopTasks' log.Warn + continue)
    }
  }
  return stopped;
}

// ---------------------------------------------------------------------------
// CancelAbandonedJobs (clear_tasks.go:195-214 + run_job.go:806-829)
// ---------------------------------------------------------------------------

/**
 * CancelAbandonedJobs: waiting/blocked/pending jobs unclaimed for the
 * abandoned timeout are cancelled, so a job emitted for a runner label
 * nobody serves cannot hold its run in RUNNING forever. Per-job shape is
 * cancelOneJob (run_job.go:806-829): an unclaimed job (task_id = 0 — every
 * row these statuses reach at v1) cancels outright behind the
 * `task_id = 0` CAS, so a runner claiming in the same instant wins and the
 * cancellation no-ops; a claimed row (defensively — the join of these
 * statuses with task_id != 0 cannot exist while the claim invariant holds)
 * goes through stopTask's CANCELLING handshake instead. STAGED: the reusable
 * caller cascade and the finished-jobs notify are M3 (module header); the
 * UpdateRunJob hook's live halves — the tasks_version wake when waiting
 * work remains and the run-aggregate recompute — ride here per cancelled
 * job, exactly as upstream's UpdateRunJob fires them.
 */
export async function cancelAbandonedJobs(
  d1: D1Database,
  options: { timeoutMs?: number } = {},
): Promise<number> {
  const db = drizzle(d1);
  const cutoff = new Date(Date.now() - (options.timeoutMs ?? ABANDONED_JOB_TIMEOUT_MS));
  const abandoned = await db
    .select()
    .from(actionRunJobs)
    .where(
      and(
        inArray(actionRunJobs.status, [5, 7, 9]), // waiting | blocked | pending
        lt(actionRunJobs.updated, cutoff),
      ),
    );
  let cancelled = 0;
  for (const job of abandoned) {
    const now = new Date();
    if (job.taskId === 0) {
      // cancelOneJob's direct arm, behind the just-claimed CAS.
      const updated = await db
        .update(actionRunJobs)
        .set({ status: ACTION_STATUS_CANCELLED, stopped: now, updated: now })
        .where(and(eq(actionRunJobs.id, job.id), eq(actionRunJobs.taskId, 0)))
        .returning({ id: actionRunJobs.id });
      if (updated.length === 0) {
        continue; // a runner claimed it between the find and the CAS
      }
    } else {
      // cancelOneJob's claimed arm: the graceful handshake decides.
      try {
        await stopTask(d1, job.taskId, ACTION_STATUS_CANCELLING);
      } catch {
        continue; // the task row vanished — nothing to cancel
      }
    }
    // The UpdateRunJob hook's live halves (run_job.go:503-530): the
    // terminal status wakes idle runners only when pickable work remains,
    // and the run aggregate re-reads its jobs.
    if (await hasWaitingJobsToPick(d1, job.repoId)) {
      await increaseTaskVersion(d1, job.ownerId, job.repoId);
    }
    await refreshRunStatus(d1, job.repoId, job.runId, job.runAttemptId);
    cancelled += 1;
  }
  return cancelled;
}

// ---------------------------------------------------------------------------
// The ephemeral-runner cleanup, decoupled from the retention arming
// (cleanup.go:144-165; the sweep body — cleanupEphemeralRunners — stays in
// retention.ts where it landed; this module owns its always-on wiring)
// ---------------------------------------------------------------------------

/**
 * CleanupEphemeralRunners is upstream's unconditional nightly pass
 * (cleanup.go:34-47 runs it inside every Cleanup), but our only invocation
 * sat inside runRetentionSweep — reachable ONLY when a retention var armed
 * the hourly producer — so a default deployment never swept crashed
 * ephemeral runners. Upstream-faithful decoupling: the same always-on,
 * probe-gated producer/consumer shape as the zombie arm (it deletes no user
 * data — it removes runner rows whose every task is terminal, the exact
 * rows upstream's sweep removes nightly).
 */

/** The REPO_TASKS message the ephemeral-cleanup producer enqueues (0 or 1). */
export interface ActionsEphemeralCleanupMessage {
  kind: "actions-ephemeral-cleanup";
}

export function isActionsEphemeralCleanupMessage(value: unknown): value is ActionsEphemeralCleanupMessage {
  return (
    typeof value === "object" && value !== null && (value as ActionsEphemeralCleanupMessage).kind === "actions-ephemeral-cleanup"
  );
}

/** The consumer arm's whole work for one `{kind: "actions-ephemeral-cleanup"}`
 *  message — re-exported here so the REPO_TASKS dispatcher's actions-sweep
 *  arms all import from this module (the body is retention.ts's port of
 *  cleanup.go:149-163). Idempotent across redeliveries. */
export { cleanupEphemeralRunners };

// ---------------------------------------------------------------------------
// The producers (the retention.ts zombie-producer shape: probe-gated,
// zero sends on a quiet instance, "crons enqueue — consumers work")
// ---------------------------------------------------------------------------

/** The env slice the producers touch (retention.ts's ActionsRetentionEnv —
 *  the same narrow {DB, REPO_TASKS} shape the dispatcher passes). */
export type ActionsSweepsEnv = ActionsRetentionEnv;

function sweepsQueue(env: ActionsSweepsEnv): { db: D1Database; queue: Queue } {
  const db = env.DB;
  const queue = env.REPO_TASKS;
  if (db === undefined || queue === undefined) {
    // Unbound is a config bug — fail loud (the demo/audit posture).
    throw new Error("DB/REPO_TASKS not bound (wrangler.jsonc); the actions sweeps producer cannot enqueue");
  }
  return { db, queue };
}

/** The REPO_TASKS message the endless producer enqueues (0 or 1). */
export interface ActionsEndlessStopMessage {
  kind: "actions-endless";
}

export function isActionsEndlessStopMessage(value: unknown): value is ActionsEndlessStopMessage {
  return typeof value === "object" && value !== null && (value as ActionsEndlessStopMessage).kind === "actions-endless";
}

/** The REPO_TASKS message the abandoned producer enqueues (0 or 1). */
export interface ActionsAbandonedCancelMessage {
  kind: "actions-abandoned";
}

export function isActionsAbandonedCancelMessage(value: unknown): value is ActionsAbandonedCancelMessage {
  return typeof value === "object" && value !== null && (value as ActionsAbandonedCancelMessage).kind === "actions-abandoned";
}

/**
 * The endless producer: ONE indexed LIMIT-1 probe for a RUNNING task started
 * past the endless timeout; a miss logs-and-skips. Returns 0 or 1.
 */
export async function enqueueDueEndlessTaskStops(
  env: ActionsSweepsEnv,
  options: { now?: Date; timeoutMs?: number } = {},
): Promise<number> {
  const { db, queue } = sweepsQueue(env);
  const timeoutMs = options.timeoutMs ?? ENDLESS_TASK_TIMEOUT_MS;
  const cutoff = new Date((options.now ?? new Date()).getTime() - timeoutMs);
  const endless = await drizzle(db)
    .select({ id: actionTasks.id })
    .from(actionTasks)
    .where(and(eq(actionTasks.status, ACTION_STATUS_RUNNING), lt(actionTasks.started, cutoff)))
    .limit(1);
  if (endless.length === 0) {
    return 0;
  }
  await queue.sendBatch([{ body: { kind: "actions-endless" } satisfies ActionsEndlessStopMessage }]);
  console.log(`[actions-endless] enqueued 1 endless stop (task ${endless[0]?.id})`);
  return 1;
}

/**
 * The abandoned producer: ONE indexed LIMIT-1 probe for a
 * waiting/blocked/pending job quiet past the abandoned timeout. Returns 0
 * or 1.
 */
export async function enqueueDueAbandonedJobCancels(
  env: ActionsSweepsEnv,
  options: { now?: Date; timeoutMs?: number } = {},
): Promise<number> {
  const { db, queue } = sweepsQueue(env);
  const timeoutMs = options.timeoutMs ?? ABANDONED_JOB_TIMEOUT_MS;
  const cutoff = new Date((options.now ?? new Date()).getTime() - timeoutMs);
  const abandoned = await drizzle(db)
    .select({ id: actionRunJobs.id })
    .from(actionRunJobs)
    .where(and(inArray(actionRunJobs.status, [5, 7, 9]), lt(actionRunJobs.updated, cutoff)))
    .limit(1);
  if (abandoned.length === 0) {
    return 0;
  }
  await queue.sendBatch([{ body: { kind: "actions-abandoned" } satisfies ActionsAbandonedCancelMessage }]);
  console.log(`[actions-abandoned] enqueued 1 abandoned cancel (job ${abandoned[0]?.id})`);
  return 1;
}

/**
 * The ephemeral-cleanup producer: ONE probe for an ephemeral runner whose
 * task set holds no live status (the exact deletable predicate
 * cleanupEphemeralRunners applies — the keep-set is the live-task join).
 * No time window (the predicate is state-based, not age-based). Returns 0
 * or 1.
 */
export async function enqueueDueEphemeralCleanup(env: ActionsSweepsEnv): Promise<number> {
  const { db, queue } = sweepsQueue(env);
  const deletable = await drizzle(db)
    .select({ id: actionRunners.id })
    .from(actionRunners)
    .where(
      and(
        eq(actionRunners.ephemeral, true),
        sql`NOT EXISTS (SELECT 1 FROM action_tasks WHERE ${actionTasks.runnerId} = ${actionRunners.id} AND ${actionTasks.status} IN (${sql.join(
          LIVE_TASK_STATUSES.map((s) => sql`${s}`),
          sql`, `,
        )}))`,
      ),
    )
    .limit(1);
  if (deletable.length === 0) {
    return 0;
  }
  await queue.sendBatch([
    { body: { kind: "actions-ephemeral-cleanup" } satisfies ActionsEphemeralCleanupMessage },
  ]);
  console.log(`[actions-ephemeral-cleanup] enqueued 1 cleanup (runner ${deletable[0]?.id})`);
  return 1;
}

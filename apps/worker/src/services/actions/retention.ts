/**
 * The retention/zombie sweep arms (SPEC-0012 §4.4/§4.5/§5.6, M1b) — ported from
 * services/actions/cleanup.go (Cleanup / CleanupArtifacts /
 * CleanupExpiredLogs / CleanupEphemeralRunners) and clear_tasks.go
 * (StopZombieTasks).
 *
 * The retention knobs are the §4.4 strict-polarity trio
 * (ACTIONS_{ARTIFACT,LOG,RUN}_RETENTION_DAYS, upstream defaults 90/365/400,
 * verified at the pin: modules/setting/actions.go:15-21 + 79-82) — the sweep
 * functions take them as PARAMETERS, and the wiring is the SPEC-0012 §4.5
 * hourly-producer block: `enqueueDueActionsRetention` (called from the
 * scheduled dispatcher's hourly entry, services/demo-sweep.ts) arms only when
 * at least one var parses as a positive integer (strict polarity — unset/
 * garbage/zero/negative stay OFF, fail-closed: a default deployment's hourly
 * tick is a silent no-op, the demoModeEnabled/audit posture), probes for due
 * work, and enqueues at most ONE `{kind: "actions-retention"}` message; the
 * REPO_TASKS consumer arm (src/repos/purge.ts) invokes the sweep with the
 * parsed values via runActionsRetention.
 *
 * Arm semantics per arm (the values ride the MESSAGE, so the consumer runs
 * exactly what the producer armed — no re-reading vars consume-side):
 *   - artifact arm: CleanupArtifacts is UNCONDITIONAL upstream (cleanup.go:50)
 *     — it only touches rows explicitly expired at upload or pending-delete
 *     (user/API-initiated), so once an operator armed the family (any var set)
 *     the arm runs; the var's day-count matters at UPLOAD time (the expiry
 *     ceiling, artifact.go:94-107) and for the gate only.
 *   - log arm: CleanupExpiredLogs skips on `<= 0` upstream (cleanup.go:107ff)
 *     — runs only when ACTIONS_LOG_RETENTION_DAYS armed, with the parsed days.
 *   - run arm: CleanupOldRuns (@midnight cleanup_action_runs,
 *     cron/tasks_actions.go:77-87) skips on `<= 0` — runs only when
 *     ACTIONS_RUN_RETENTION_DAYS armed, with the parsed days.
 *   - ephemeral runners: NOT here anymore — upstream runs
 *     CleanupEphemeralRunners unconditionally inside every nightly Cleanup
 *     (cleanup.go:36), which is hygiene rather than retention, so the pass
 *     moved to the always-on probe-gated sweep arm (sweeps.ts,
 *     `{kind: "actions-ephemeral-cleanup"}`) and no longer rides the armed
 *     retention messages.
 *
 * The zombie arm is NOT retention: StopZombieTasks is upstream's own
 * always-on `stop_zombie_tasks` cron (@every 5m, RunAtStart, enabled default
 * — cron/tasks_actions.go:26-35, no retention knob), so it rides the 10-minute
 * step entry as an unconditional PROBE-GATED producer block
 * (`enqueueDueZombieStops` — the SPEC-0016 §4.4 packages ratification shape:
 * upstream's own job, zero sends unless a stale running/cancelling task
 * exists) with its own `{kind: "actions-zombie"}` consumer arm.
 *
 * Retention arithmetic (artifact.go:94-107): expired_unix 0 = keep forever;
 * an explicit expiry clamps to the retention ceiling. Log expiry flips
 * log_expired and removes the bytes (R2 when sealed, chunk rows when hot);
 * run cleanup deletes a finished run's whole row family + its blobs.
 */

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  actionArtifacts,
  actionRunAttempts,
  actionRunJobSummaries,
  actionRunJobs,
  actionRunners,
  actionRuns,
  actionTaskOutputs,
  actionTaskSteps,
  actionTasks,
} from "../../db/schema";
import type { ArtifactRow } from "./artifacts";
import {
  ARTIFACT_STATUS_PENDING_DELETION,
  ARTIFACT_STATUS_UPLOAD_CONFIRMED,
  listNeedExpiredArtifacts,
  listPendingDeleteArtifacts,
  setArtifactDeleted,
  setArtifactExpired,
} from "./artifacts";
import { removeLogs } from "./logs";
import { ACTION_STATUS_CANCELLED, ACTION_STATUS_CANCELLING, ACTION_STATUS_FAILURE, ACTION_STATUS_SKIPPED, ACTION_STATUS_SUCCESS, isLiveTaskStatus } from "./model";
import { findOldTasksToExpire, stopTask } from "./update";

export interface RetentionOptions {
  artifactRetentionDays: number;
  logRetentionDays: number;
  runRetentionDays: number;
}

/** Upstream's defaults (modules/setting/actions.go:15-21, 79-82): 90/365/400.
 *  NOT a silent fallback: the producer arms per-var and the message carries
 *  exactly the armed values, so these constants are documentation + the
 *  operator's reference (an operator who wants upstream behavior sets the
 *  three vars to these values — see wrangler.jsonc.example). */
export const RETENTION_DEFAULTS: RetentionOptions = {
  artifactRetentionDays: 90,
  logRetentionDays: 365,
  runRetentionDays: 400,
};

/**
 * Cleanup's retention arms (cleanup.go:34-47 MINUS CleanupEphemeralRunners,
 * which is NOT retention and moved to the always-on sweeps module — see
 * sweeps.ts; upstream runs the ephemeral pass unconditionally inside every
 * nightly Cleanup, so ours runs probe-gated on its own message kind instead
 * of only when a retention var armed the producer). The REQUIRED triple (no
 * Partial-with-defaults merge — omitting an arm must be a compile error, not
 * a silent 90/365/400 deletion): `0` = the arm stays off (upstream's `<= 0`
 * unlimited polarity for the log arm; the artifact arm always runs within an
 * armed message — see the header).
 */
export async function runRetentionSweep(env: Env, opts: RetentionOptions): Promise<void> {
  await cleanupArtifacts(env);
  await cleanupExpiredLogs(env, opts.logRetentionDays);
}

/**
 * CleanupArtifacts (cleanup.go:50-95): confirmed rows past expiry flip to
 * EXPIRED with the R2 delete (best-effort, "go on" upstream); pending-
 * deletion rows flip to DELETED with the R2 delete, in batches.
 */
export async function cleanupArtifacts(env: Env): Promise<void> {
  const expired = await listNeedExpiredArtifacts(env.DB);
  for (const artifact of expired) {
    await setArtifactExpired(env.DB, artifact.id);
    await deleteArtifactObject(env, artifact);
  }

  const BATCH = 100;
  for (;;) {
    const pending = await listPendingDeleteArtifacts(env.DB, BATCH);
    for (const artifact of pending) {
      await setArtifactDeleted(env.DB, artifact.id);
      await deleteArtifactObject(env, artifact);
    }
    if (pending.length < BATCH) {
      break;
    }
  }
}

async function deleteArtifactObject(env: Env, artifact: ArtifactRow): Promise<void> {
  // storage_path may be empty for rows that never merged — R2 delete on a
  // bare id would silently no-op, but skip the call anyway.
  if (artifact.storagePath === "") {
    return;
  }
  try {
    await env.REPO_PACKS.delete(artifact.storagePath);
  } catch {
    // "go on" upstream (cleanup.go:66-68)
  }
}

/** CleanupExpiredLogs (cleanup.go:107-143): RemoveLogs + log_expired flip. */
export async function cleanupExpiredLogs(env: Env, logRetentionDays: number): Promise<void> {
  if (logRetentionDays <= 0) {
    return;
  }
  const olderThan = new Date(Date.now() - logRetentionDays * 24 * 60 * 60 * 1000);
  const BATCH = 100;
  for (;;) {
    const tasks = await findOldTasksToExpire(env.DB, olderThan, BATCH);
    for (const task of tasks) {
      try {
        await removeLogs(env, task.logInStorage, task.logFilename, task.id);
      } catch {
        // do not return error here, go on
      }
      await drizzle(env.DB)
        .update(actionTasks)
        .set({ logIndexes: new Uint8Array(0), logExpired: true, updated: new Date() })
        .where(eq(actionTasks.id, task.id));
    }
    if (tasks.length < BATCH) {
      break;
    }
  }
}

/**
 * CleanupEphemeralRunners (cleanup.go:149-163): delete ephemeral runners
 * whose only tasks are all finished (the live-task statuses — waiting/
 * running/blocked/cancelling — keep them).
 */
export async function cleanupEphemeralRunners(d1: D1Database): Promise<void> {
  const db = drizzle(d1);
  const keepers = await db
    .select({ id: actionRunners.id })
    .from(actionRunners)
    .innerJoin(actionTasks, eq(actionTasks.runnerId, actionRunners.id))
    .where(and(eq(actionRunners.ephemeral, true), inArray(actionTasks.status, [5, 6, 7, 8])));
  const keepIds = new Set(keepers.map((c) => c.id));
  const ephemeral = await db.select({ id: actionRunners.id }).from(actionRunners).where(eq(actionRunners.ephemeral, true));
  for (const runner of ephemeral) {
    if (!keepIds.has(runner.id)) {
      await db.delete(actionRunners).where(eq(actionRunners.id, runner.id));
    }
  }
}

// ---------------------------------------------------------------------------
// The zombie arm (§5.6): StopTask over stale running tasks
// ---------------------------------------------------------------------------

/** The zombie timeout (modules/setting/actions.go:133-135, default 10 min). */
export const ZOMBIE_TASK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * StopZombieTasks → stopTasks (§5.6's consumer arm; clear_tasks.go:26-30 +
 * 151-193): running/cancelling tasks whose `updated` went quiet past the
 * zombie timeout stop, with the stop status picked PER TASK — FAILURE for a
 * stalled RUNNING task, CANCELLED for a stalled CANCELLING one
 * (clear_tasks.go:160-163: `stopStatus = StatusFailure; if task.Status ==
 * StatusCancelling { stopStatus = StatusCancelled }`). The user intent of a
 * cancelled job whose runner died mid-cleanup must not record as a failure
 * (which would propagate through AggregateJobStatus's hasFailure arm onto
 * the run). When `env` is supplied the sweep also transfers each dead
 * task's logs (clear_tasks.go:177-187 — the piggyback rides stopTask).
 */
export async function stopZombieTasks(
  d1: D1Database,
  options: { timeoutMs?: number; env?: Env } = {},
): Promise<number> {
  const db = drizzle(d1);
  const cutoff = new Date(Date.now() - (options.timeoutMs ?? ZOMBIE_TASK_TIMEOUT_MS));
  const stale = await db
    .select({ id: actionTasks.id, status: actionTasks.status })
    .from(actionTasks)
    .where(
      and(
        inArray(actionTasks.status, [6, 8]), // running | cancelling
        lt(actionTasks.updated, cutoff),
      ),
    );
  let stopped = 0;
  for (const task of stale) {
    const stopStatus = task.status === ACTION_STATUS_CANCELLING ? ACTION_STATUS_CANCELLED : ACTION_STATUS_FAILURE;
    try {
      await stopTask(d1, task.id, stopStatus, options.env);
      stopped += 1;
    } catch {
      // the sweep never fails on one task (stopTasks' log.Warn + continue)
    }
  }
  return stopped;
}

/**
 * CleanupOldRuns (cleanup.go:265-330's shape, bounded): finished runs older
 * than the run-retention window lose their whole row family + blobs.
 */
export async function cleanupOldRuns(env: Env, runRetentionDays: number, limit = 50): Promise<number> {
  if (runRetentionDays <= 0) {
    return 0;
  }
  const olderThan = Math.floor((Date.now() - runRetentionDays * 24 * 60 * 60 * 1000) / 1000);
  const db = drizzle(env.DB);
  const runs = await db
    .select()
    .from(actionRuns)
    .where(
      and(
        inArray(actionRuns.status, [ACTION_STATUS_SUCCESS, ACTION_STATUS_FAILURE, ACTION_STATUS_CANCELLED, ACTION_STATUS_SKIPPED]),
        lt(actionRuns.created, new Date(olderThan * 1000)),
      ),
    )
    .limit(limit);
  let deleted = 0;
  for (const run of runs) {
    await deleteRun(env, run.repoId, run.id);
    deleted += 1;
  }
  return deleted;
}

/** DeleteRun (cleanup.go:169-263): rows + logs + artifacts of one run. */
export async function deleteRun(env: Env, repoId: string, runId: number): Promise<void> {
  const db = drizzle(env.DB);
  const jobs = await db.select().from(actionRunJobs).where(and(eq(actionRunJobs.repoId, repoId), eq(actionRunJobs.runId, runId)));
  const jobIds = jobs.map((j) => j.id);
  const tasks = jobIds.length > 0
    ? await db.select().from(actionTasks).where(and(eq(actionTasks.repoId, repoId), inArray(actionTasks.jobId, jobIds)))
    : [];

  const artifacts = await db
    .select()
    .from(actionArtifacts)
    .where(and(eq(actionArtifacts.repoId, repoId), eq(actionArtifacts.runId, runId)));

  await db.batch([
    db.delete(actionRunAttempts).where(and(eq(actionRunAttempts.repoId, repoId), eq(actionRunAttempts.runId, runId))),
    db.delete(actionRunJobs).where(and(eq(actionRunJobs.repoId, repoId), eq(actionRunJobs.runId, runId))),
    ...tasks.flatMap((t) => [
      db.delete(actionTaskSteps).where(eq(actionTaskSteps.taskId, t.id)),
      db.delete(actionTaskOutputs).where(eq(actionTaskOutputs.taskId, t.id)),
    ]),
    db.delete(actionTasks).where(and(eq(actionTasks.repoId, repoId), inArray(actionTasks.jobId, jobIds.length > 0 ? jobIds : [-1]))),
    db.delete(actionArtifacts).where(and(eq(actionArtifacts.repoId, repoId), eq(actionArtifacts.runId, runId))),
    db.delete(actionRunJobSummaries).where(and(eq(actionRunJobSummaries.repoId, repoId), eq(actionRunJobSummaries.runId, runId))),
    db.delete(actionRuns).where(and(eq(actionRuns.repoId, repoId), eq(actionRuns.id, runId))),
  ]);

  // Files last (the DB rows are gone; deletes are best-effort).
  for (const task of tasks) {
    try {
      await removeLogs(env, task.logInStorage, task.logFilename, task.id);
    } catch {
      // go on
    }
  }
  for (const art of artifacts) {
    if (art.storagePath !== "") {
      try {
        await env.REPO_PACKS.delete(art.storagePath);
      } catch {
        // don't return any error since the database records have been deleted
      }
    }
  }
}

// isLiveTaskStatus re-export for the sweep's callers (the ephemeral keep-set).
export { isLiveTaskStatus };

// ---------------------------------------------------------------------------
// The cron/queue wiring (SPEC-0012 §4.5): the hourly producer block + the
// REPO_TASKS consumer runner, and the step-entry zombie producer + its
// consumer runner — the demo-sweep/audit producer-consumer shape.
// ---------------------------------------------------------------------------

/**
 * The env slice the producer arms touch (the AuditRetentionEnv posture): the
 * three retention vars are OPTIONAL here so the unarmed case stays
 * structurally expressible (gate-off tests drive unset/garbage); the
 * generated Env (wrangler.jsonc.example declares them) satisfies it.
 */
export type ActionsRetentionEnv = Partial<Pick<Env, "DB" | "REPO_TASKS">> & {
  ACTIONS_ARTIFACT_RETENTION_DAYS?: string;
  ACTIONS_LOG_RETENTION_DAYS?: string;
  ACTIONS_RUN_RETENTION_DAYS?: string;
};

/**
 * Strict-polarity parse (the auditRetentionDaysFromEnv rule): a positive
 * integer string → that many days; absent/garbage/zero/negative → null
 * (disarmed — a typo must never arm a deletion sweep, §6.8). Upstream's `<= 0`
 * means "unlimited", our unset means OFF — the divergence is the deliberate
 * fail-closed gate (upstream's cleanup is always-on with the defaults; ours
 * deletes only where an operator set a var).
 */
export function retentionDaysFromEnv(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const days = Number.parseInt(raw, 10);
  return days > 0 ? days : null;
}

/** The REPO_TASKS message the hourly producer enqueues (0 or 1). A member is
 *  present ONLY when its var armed — the consumer runs exactly what the
 *  producer armed (the artifact member is carried for traceability even
 *  though CleanupArtifacts itself is day-less). */
export interface ActionsRetentionMessage {
  kind: "actions-retention";
  artifactRetentionDays?: number;
  logRetentionDays?: number;
  runRetentionDays?: number;
}

export function isActionsRetentionMessage(value: unknown): value is ActionsRetentionMessage {
  return typeof value === "object" && value !== null && (value as ActionsRetentionMessage).kind === "actions-retention";
}

/**
 * The hourly retention producer (SPEC-0012 §4.5): DISARMED (return 0 before
 * any I/O) unless at least one of the three strict-polarity vars parses
 * positive; then ONE indexed LIMIT-1 probe per armed arm (log: expired
 * unsealed tasks; run: finished runs past the window; artifact: confirmed
 * rows past expiry or pending-delete) and, only when armed work exists, ONE
 * `{kind: "actions-retention"}` message on REPO_TASKS carrying the parsed
 * values. SELECT + enqueue ONLY — the sweep runs in the consumer with its own
 * queue budget (AGENTS.md: crons enqueue, consumers do the work). No CAS
 * claim on purpose (the demo/audit posture): the sweep is idempotent, so a
 * duplicate message is absorbed as a near-no-op. Returns 0 or 1.
 */
export async function enqueueDueActionsRetention(
  env: ActionsRetentionEnv,
  options: { now?: Date } = {},
): Promise<number> {
  // THE GATE — before the first D1 read, before the first queue send, before
  // any log line: a var-less deployment's hourly tick is a silent no-op.
  const artifactDays = retentionDaysFromEnv(env.ACTIONS_ARTIFACT_RETENTION_DAYS);
  const logDays = retentionDaysFromEnv(env.ACTIONS_LOG_RETENTION_DAYS);
  const runDays = retentionDaysFromEnv(env.ACTIONS_RUN_RETENTION_DAYS);
  if (artifactDays === null && logDays === null && runDays === null) return 0;
  const db = env.DB;
  const queue = env.REPO_TASKS;
  if (db === undefined || queue === undefined) {
    // Armed but unbound is a config bug — fail loud (the demo/audit posture).
    throw new Error("DB/REPO_TASKS not bound (wrangler.jsonc); the actions retention producer cannot enqueue");
  }
  const now = options.now ?? new Date();
  const d1 = drizzle(db);

  // Probes (one indexed LIMIT-1 per armed arm — the audit producer's
  // existence-probe shape; a miss logs-and-skips so quiet ticks stay silent).
  const due: { artifact: boolean; log: boolean; run: boolean } = { artifact: false, log: false, run: false };
  if (artifactDays !== null) {
    // The exact listNeedExpiredArtifacts predicate (status = UPLOAD_CONFIRMED,
    // expired_unix in (0, now)) — the probe must match the sweep's arm.
    const expired = await d1
      .select({ id: actionArtifacts.id })
      .from(actionArtifacts)
      .where(
        and(
          sql`${actionArtifacts.expiredUnix} > 0`,
          lt(actionArtifacts.expiredUnix, Math.floor(now.getTime() / 1000)),
          eq(actionArtifacts.status, ARTIFACT_STATUS_UPLOAD_CONFIRMED),
        ),
      )
      .limit(1);
    const pending =
      expired.length > 0
        ? []
        : await d1
            .select({ id: actionArtifacts.id })
            .from(actionArtifacts)
            .where(eq(actionArtifacts.status, ARTIFACT_STATUS_PENDING_DELETION))
            .limit(1);
    due.artifact = expired.length > 0 || pending.length > 0;
  }
  if (logDays !== null) {
    const cut = new Date(now.getTime() - logDays * 24 * 60 * 60 * 1000);
    const old = await findOldTasksToExpire(db, cut, 1);
    due.log = old.length > 0;
  }
  if (runDays !== null) {
    const olderThan = new Date((Math.floor(now.getTime() / 1000) - runDays * 24 * 60 * 60) * 1000);
    const old = await d1
      .select({ id: actionRuns.id })
      .from(actionRuns)
      .where(
        and(
          inArray(actionRuns.status, [ACTION_STATUS_SUCCESS, ACTION_STATUS_FAILURE, ACTION_STATUS_CANCELLED, ACTION_STATUS_SKIPPED]),
          lt(actionRuns.created, olderThan),
        ),
      )
      .limit(1);
    due.run = old.length > 0;
  }
  if (!due.artifact && !due.log && !due.run) {
    console.log(
      `[actions-retention] 0 due (artifact=${artifactDays === null ? "off" : artifactDays + "d"} log=${
        logDays === null ? "off" : logDays + "d"
      } run=${runDays === null ? "off" : runDays + "d"})`,
    );
    return 0;
  }
  const message: ActionsRetentionMessage = { kind: "actions-retention" };
  if (artifactDays !== null) message.artifactRetentionDays = artifactDays;
  if (logDays !== null) message.logRetentionDays = logDays;
  if (runDays !== null) message.runRetentionDays = runDays;
  await queue.sendBatch([{ body: message satisfies ActionsRetentionMessage }]);
  console.log(
    `[actions-retention] enqueued 1 sweep (artifact=${artifactDays === null ? "off" : artifactDays + "d"} log=${
      logDays === null ? "off" : logDays + "d"
    } run=${runDays === null ? "off" : runDays + "d"} due artifact=${due.artifact} log=${due.log} run=${due.run})`,
  );
  return 1;
}

/**
 * The retention consumer runner: the REPO_TASKS arm's whole work for one
 * `{kind: "actions-retention"}` message — upstream's TWO @midnight jobs in
 * message order: Cleanup (cleanup.go:24-47 — artifacts, logs at the armed
 * window, ephemeral runners) then CleanupOldRuns (cleanup.go:265ff) at the
 * armed window. Unarmed arms ride as 0 (= the upstream skip polarity), so the
 * consumer deletes exactly what the producer armed. Idempotent across
 * redeliveries; a throw retries the message.
 */
export async function runActionsRetention(env: Env, message: ActionsRetentionMessage): Promise<void> {
  await runRetentionSweep(env, {
    artifactRetentionDays: message.artifactRetentionDays ?? 0,
    logRetentionDays: message.logRetentionDays ?? 0,
    runRetentionDays: message.runRetentionDays ?? 0,
  });
  await cleanupOldRuns(env, message.runRetentionDays ?? 0);
}

// ---------------------------------------------------------------------------
// The zombie producer/consumer wiring (§5.6's cron arm) — upstream's
// `stop_zombie_tasks` (@every 5m, enabled default, cron/tasks_actions.go:26-35)
// mapped onto the 10-minute step entry, probe-gated like the packages cleanup
// producer (SPEC-0016 §4.4's ratified always-on-job shape: it is NOT
// retention, deletes no user data, and sends only when a stale task exists).
// ---------------------------------------------------------------------------

/** The REPO_TASKS message the step-entry producer enqueues (0 or 1). */
export interface ActionsZombieStopMessage {
  kind: "actions-zombie";
}

export function isActionsZombieStopMessage(value: unknown): value is ActionsZombieStopMessage {
  return typeof value === "object" && value !== null && (value as ActionsZombieStopMessage).kind === "actions-zombie";
}

/**
 * The zombie producer: UNCONDITIONAL (upstream's stop_zombie_tasks has no
 * retention knob and is enabled by default) but PROBE-GATED — one indexed
 * LIMIT-1 read for a running/cancelling task quiet past the zombie timeout;
 * a miss logs-and-skips. Zero sends on a quiet instance (the §6.8 posture
 * applied to sends, not to arming). Returns 0 or 1.
 */
export async function enqueueDueZombieStops(
  env: ActionsRetentionEnv,
  options: { now?: Date; zombieTimeoutMs?: number } = {},
): Promise<number> {
  const db = env.DB;
  const queue = env.REPO_TASKS;
  if (db === undefined || queue === undefined) {
    // Unbound is a config bug — fail loud (the demo/audit posture).
    throw new Error("DB/REPO_TASKS not bound (wrangler.jsonc); the actions zombie producer cannot enqueue");
  }
  const timeoutMs = options.zombieTimeoutMs ?? ZOMBIE_TASK_TIMEOUT_MS;
  const cutoff = new Date((options.now ?? new Date()).getTime() - timeoutMs);
  const stale = await drizzle(db)
    .select({ id: actionTasks.id })
    .from(actionTasks)
    .where(and(inArray(actionTasks.status, [6, 8]), lt(actionTasks.updated, cutoff))) // running | cancelling
    .limit(1);
  if (stale.length === 0) {
    return 0;
  }
  await queue.sendBatch([{ body: { kind: "actions-zombie" } satisfies ActionsZombieStopMessage }]);
  console.log(`[actions-zombie] enqueued 1 zombie stop (stale task ${stale[0]?.id})`);
  return 1;
}

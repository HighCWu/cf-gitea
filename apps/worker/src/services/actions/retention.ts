/**
 * The retention/zombie sweep arms (SPEC-0012 §4.4/§5.6, M1b) — ported from
 * services/actions/cleanup.go (Cleanup / CleanupArtifacts /
 * CleanupExpiredLogs / CleanupEphemeralRunners).
 *
 * The retention knobs are the §4.4 strict-polarity trio
 * (ACTIONS_{ARTIFACT,LOG,RUN}_RETENTION_DAYS, upstream defaults 90/365/400,
 * 0 = upstream's unlimited) — this module takes them as PARAMETERS so the
 * scheduled dispatcher's caller (outside this unit's ownership) supplies
 * them from env once the vars land; the sweep is callable from tests and
 * from a repo-tasks consumer unchanged.
 *
 * Retention arithmetic (artifact.go:94-107): expired_unix 0 = keep forever;
 * an explicit expiry clamps to the retention ceiling. Log expiry flips
 * log_expired and removes the bytes (R2 when sealed, chunk rows when hot);
 * run cleanup deletes a finished run's whole row family + its blobs.
 */

import { and, eq, inArray, lt } from "drizzle-orm";
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
import { listNeedExpiredArtifacts, listPendingDeleteArtifacts, setArtifactDeleted, setArtifactExpired } from "./artifacts";
import { removeLogs } from "./logs";
import { ACTION_STATUS_CANCELLED, ACTION_STATUS_FAILURE, ACTION_STATUS_SKIPPED, ACTION_STATUS_SUCCESS, isLiveTaskStatus } from "./model";
import { findOldTasksToExpire, stopTask } from "./update";

export interface RetentionOptions {
  artifactRetentionDays: number;
  logRetentionDays: number;
  runRetentionDays: number;
}

/** Upstream's defaults (modules/setting/actions.go:19-21): 90/365/400. */
export const RETENTION_DEFAULTS: RetentionOptions = {
  artifactRetentionDays: 90,
  logRetentionDays: 365,
  runRetentionDays: 400,
};

/** Cleanup (cleanup.go:34-47): artifacts → logs → ephemeral runners. */
export async function runRetentionSweep(env: Env, opts: Partial<RetentionOptions>): Promise<void> {
  const options = { ...RETENTION_DEFAULTS, ...opts };
  await cleanupArtifacts(env);
  await cleanupExpiredLogs(env, options.logRetentionDays);
  await cleanupEphemeralRunners(env.DB);
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
 * StopZombieTasks (§5.6's consumer arm): running tasks whose `updated` went
 * quiet past the zombie timeout stop as FAILURE — upstream's zombie sweep
 * ("it will update ActionTask.Updated to avoid the task being judged as a
 * zombie task", the other side of UpdateTaskByState's touch).
 */
export async function stopZombieTasks(d1: D1Database, zombieTimeoutMs = ZOMBIE_TASK_TIMEOUT_MS): Promise<number> {
  const db = drizzle(d1);
  const cutoff = new Date(Date.now() - zombieTimeoutMs);
  const stale = await db
    .select({ id: actionTasks.id })
    .from(actionTasks)
    .where(
      and(
        inArray(actionTasks.status, [6, 8]), // running | cancelling
        lt(actionTasks.updated, cutoff),
      ),
    );
  let stopped = 0;
  for (const task of stale) {
    try {
      await stopTask(d1, task.id, ACTION_STATUS_FAILURE);
      stopped += 1;
    } catch {
      // the sweep never fails on one task
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

/**
 * The always-on sweeps suite (the parity-review §5 items): the zombie stop's
 * per-task terminal status (a stalled CANCELLING task stops CANCELLED, not
 * FAILURE — clear_tasks.go:160-163), the ported stop_endless_tasks
 * (RUNNING-only, keyed on `started`, 3h) and cancel_abandoned_jobs
 * (waiting/blocked/pending, 24h, behind the just-claimed CAS), the decoupled
 * ephemeral-runner cleanup (probe-gated, NOT retention-armed), and the
 * producers' zero-send-on-quiet posture.
 *
 * Real local D1 + R2 (workerd, @cloudflare/vitest-plugin); the only stubs
 * are the recording queue (the retention.test.ts spyQueue shape) and the
 * unbound-config tripwire.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionLogChunks, actionRunJobs, actionRunners, actionRuns, actionTasks, actionTasksVersions } from "../../db/schema";
import {
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_CANCELLING,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SUCCESS,
  createRunner,
} from "./model";
import { cleanupEphemeralRunners } from "./retention";
import {
  ABANDONED_JOB_TIMEOUT_MS,
  ENDLESS_TASK_TIMEOUT_MS,
  cancelAbandonedJobs,
  enqueueDueAbandonedJobCancels,
  enqueueDueEphemeralCleanup,
  enqueueDueEndlessTaskStops,
  stopEndlessTasks,
} from "./sweeps";
import { stopZombieTasks } from "./retention";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const CLEANUP_TABLES = [
  "action_runners",
  "action_runs",
  "action_run_jobs",
  "action_run_attempts",
  "action_tasks",
  "action_tasks_versions",
  "action_log_chunks",
];

beforeEach(async () => {
  for (const table of CLEANUP_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

/** Recording Queue (retention.test.ts's spyQueue shape). */
function spyQueue(): Queue & { sendBodies: unknown[]; bodies: unknown[][] } {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue = {
    sendBodies: [] as unknown[],
    bodies: [] as unknown[][],
    send: (body: unknown) => {
      queue.sendBodies.push(body);
      return Promise.resolve({ metadata });
    },
    sendBatch: (messages: MessageSendRequest[]) => {
      queue.bodies.push(messages.map((m) => m.body));
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve(metadata.metrics),
  };
  return queue;
}

const producerEnv = (queue: Queue = spyQueue()): { DB: D1Database; REPO_TASKS: Queue } => ({
  DB: env.DB,
  REPO_TASKS: queue,
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

async function seedRun(options: { status?: number } = {}): Promise<number> {
  const rows = await db()
    .insert(actionRuns)
    .values({
      repoId: "sweeps-repo",
      ownerId: 1,
      index: Math.floor(Math.random() * 1_000_000) + 1,
      status: options.status ?? ACTION_STATUS_RUNNING,
      created: new Date(),
      updated: new Date(),
    })
    .returning({ id: actionRuns.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("run seed failed");
  return id;
}

async function seedJob(options: {
  status: number;
  updated: Date;
  runId?: number;
  jobId?: string;
  taskId?: number;
}): Promise<{ id: number; runId: number }> {
  const runId = options.runId ?? (await seedRun());
  const rows = await db()
    .insert(actionRunJobs)
    .values({
      runId,
      repoId: "sweeps-repo",
      ownerId: 1,
      jobId: options.jobId ?? `job-${Math.random().toString(16).slice(2)}`,
      attempt: 1,
      workflowPayload: new TextEncoder().encode("jobs: {}"),
      status: options.status,
      taskId: options.taskId ?? 0,
      created: new Date(),
      updated: options.updated,
    })
    .returning({ id: actionRunJobs.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("job seed failed");
  return { id, runId };
}

async function seedTask(options: {
  status: number;
  updated?: Date;
  started?: Date | null;
  jobId?: number;
  runnerId?: number;
  logFilename?: string;
}): Promise<number> {
  const rows = await db()
    .insert(actionTasks)
    .values({
      jobId: options.jobId ?? 1,
      repoId: "sweeps-repo",
      ownerId: 1,
      status: options.status,
      runnerId: options.runnerId ?? 0,
      started: options.started ?? null,
      stopped: null,
      tokenHash: `hash-${Math.random().toString(16).slice(2)}`,
      logFilename: options.logFilename ?? "",
      created: new Date(Date.now() - 6 * HOUR),
      updated: options.updated ?? new Date(),
    })
    .returning({ id: actionTasks.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("task seed failed");
  return id;
}

// ---------------------------------------------------------------------------
// The zombie stop's per-task terminal status (clear_tasks.go:160-163)
// ---------------------------------------------------------------------------

describe("stopZombieTasks — the stop status is picked PER TASK", () => {
  it("a stalled CANCELLING task stops CANCELLED, not FAILURE (the user intent survives)", async () => {
    const id = await seedTask({ status: ACTION_STATUS_CANCELLING, updated: new Date(Date.now() - 20 * MINUTE) });
    await expect(stopZombieTasks(env.DB)).resolves.toBe(1);
    const task = await db().select().from(actionTasks).where(eq(actionTasks.id, id)).get();
    expect(task?.status).toBe(ACTION_STATUS_CANCELLED);
    expect(task?.stopped).not.toBeNull();
  });

  it("a stalled RUNNING task still stops FAILURE", async () => {
    const id = await seedTask({ status: ACTION_STATUS_RUNNING, updated: new Date(Date.now() - 20 * MINUTE) });
    await expect(stopZombieTasks(env.DB)).resolves.toBe(1);
    const task = await db().select().from(actionTasks).where(eq(actionTasks.id, id)).get();
    expect(task?.status).toBe(ACTION_STATUS_FAILURE);
  });

  it("with the storage env the dead task's hot log seals and the chunk rows drop (clear_tasks.go:177-187)", async () => {
    const id = await seedTask({
      status: ACTION_STATUS_RUNNING,
      updated: new Date(Date.now() - 20 * MINUTE),
      logFilename: "sweeps-repo/ff/1.log",
    });
    await db().insert(actionLogChunks).values({ taskId: id, seq: 0, bytes: new TextEncoder().encode("2026-01-01T00:00:00.0000000Z line\n") });
    await stopZombieTasks(env.DB, { env });
    const task = await db().select().from(actionTasks).where(eq(actionTasks.id, id)).get();
    expect(task?.logInStorage).toBe(true);
    expect(await db().select().from(actionLogChunks).where(eq(actionLogChunks.taskId, id))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// StopEndlessTasks (clear_tasks.go:32-39) — RUNNING-only, keyed on `started`
// ---------------------------------------------------------------------------

describe("stopEndlessTasks", () => {
  it("a RUNNING task streaming `updated` forever stops FAILURE past the 3h start threshold", async () => {
    const id = await seedTask({
      status: ACTION_STATUS_RUNNING,
      started: new Date(Date.now() - 4 * HOUR),
      updated: new Date(), // fresh — the zombie sweep must NOT be what catches this
    });
    await expect(stopEndlessTasks(env.DB)).resolves.toBe(1);
    const task = await db().select().from(actionTasks).where(eq(actionTasks.id, id)).get();
    expect(task?.status).toBe(ACTION_STATUS_FAILURE);
  });

  it("a task inside the window is untouched", async () => {
    const id = await seedTask({ status: ACTION_STATUS_RUNNING, started: new Date(Date.now() - 1 * HOUR), updated: new Date() });
    await expect(stopEndlessTasks(env.DB)).resolves.toBe(0);
    const task = await db().select().from(actionTasks).where(eq(actionTasks.id, id)).get();
    expect(task?.status).toBe(ACTION_STATUS_RUNNING);
  });

  it("a CANCELLING task mid post-cancel cleanup is NEVER endless-stopped (RUNNING-only upstream)", async () => {
    const id = await seedTask({
      status: ACTION_STATUS_CANCELLING,
      started: new Date(Date.now() - 4 * HOUR),
      updated: new Date(),
    });
    await expect(stopEndlessTasks(env.DB)).resolves.toBe(0);
    const task = await db().select().from(actionTasks).where(eq(actionTasks.id, id)).get();
    expect(task?.status).toBe(ACTION_STATUS_CANCELLING);
  });

  it("an endless-stopped task's hot log seals when the storage env rides (the stopTask piggyback)", async () => {
    const id = await seedTask({
      status: ACTION_STATUS_RUNNING,
      started: new Date(Date.now() - 4 * HOUR),
      updated: new Date(),
      logFilename: "sweeps-repo/ff/2.log",
    });
    await db().insert(actionLogChunks).values({ taskId: id, seq: 0, bytes: new TextEncoder().encode("2026-01-01T00:00:00.0000000Z line\n") });
    await stopEndlessTasks(env.DB, { env });
    const task = await db().select().from(actionTasks).where(eq(actionTasks.id, id)).get();
    expect(task?.logInStorage).toBe(true);
    expect(await db().select().from(actionLogChunks).where(eq(actionLogChunks.taskId, id))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CancelAbandonedJobs (clear_tasks.go:195-214 + run_job.go:806-829)
// ---------------------------------------------------------------------------

describe("cancelAbandonedJobs", () => {
  it("a waiting job unclaimed for 24h cancels with stopped set; the run aggregate follows", async () => {
    const runId = await seedRun({ status: ACTION_STATUS_RUNNING });
    const { id } = await seedJob({ status: 5, updated: new Date(Date.now() - 25 * HOUR), runId });
    await expect(cancelAbandonedJobs(env.DB)).resolves.toBe(1);
    const job = await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, id)).get();
    expect(job?.status).toBe(ACTION_STATUS_CANCELLED);
    expect(job?.stopped).not.toBeNull();
    // The aggregate recompute (the UpdateRunJob hook's live half): the run's
    // only job is cancelled → the run settles CANCELLED.
    const run = await db().select().from(actionRuns).where(eq(actionRuns.id, runId)).get();
    expect(run?.status).toBe(ACTION_STATUS_CANCELLED);
  });

  it("blocked and pending jobs cancel too (the three-status find)", async () => {
    const blocked = await seedJob({ status: 7, updated: new Date(Date.now() - 25 * HOUR) });
    const pending = await seedJob({ status: 9, updated: new Date(Date.now() - 25 * HOUR) });
    await expect(cancelAbandonedJobs(env.DB)).resolves.toBe(2);
    expect((await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, blocked.id)).get())?.status).toBe(ACTION_STATUS_CANCELLED);
    expect((await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, pending.id)).get())?.status).toBe(ACTION_STATUS_CANCELLED);
  });

  it("a fresh waiting job is untouched", async () => {
    const { id } = await seedJob({ status: 5, updated: new Date(Date.now() - 1 * HOUR) });
    await expect(cancelAbandonedJobs(env.DB)).resolves.toBe(0);
    expect((await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, id)).get())?.status).toBe(5);
  });

  it("the CAS spares a job a runner claimed between the find and the cancel", async () => {
    // Simulate the race: the sweep's find sees waiting/24h-quiet, then the
    // runner's claim lands (task_id set) before the cancel's UPDATE — the
    // `task_id = 0` CAS must drop the row.
    const { id } = await seedJob({ status: 5, updated: new Date(Date.now() - 25 * HOUR), taskId: 0 });
    await db().update(actionRunJobs).set({ taskId: 42 }).where(eq(actionRunJobs.id, id)); // claim landed
    await expect(cancelAbandonedJobs(env.DB)).resolves.toBe(0);
    const job = await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, id)).get();
    expect(job?.status).toBe(5); // still waiting — the claimant owns it now
  });

  it("the version wake fires only when pickable work remains (the UpdateRunJob hook's gate)", async () => {
    const kept = await seedJob({ status: 5, updated: new Date() }); // fresh waiting sibling
    const abandoned = await seedJob({ status: 5, updated: new Date(Date.now() - 25 * HOUR) });
    await db().update(actionRunJobs).set({ repoId: "sweeps-repo" }).where(eq(actionRunJobs.id, abandoned.id));
    await cancelAbandonedJobs(env.DB);
    expect((await db().select().from(actionTasksVersions).where(eq(actionTasksVersions.repoId, "sweeps-repo")))[0]?.version ?? 0).toBeGreaterThan(0);

    // Now with NO remaining waiting work: the last abandoned job cancels
    // without a bump (the hasWaitingJobsToPick gate).
    await db().delete(actionRunJobs).where(eq(actionRunJobs.id, kept.id));
    await db().delete(actionTasksVersions);
    const last = await seedJob({ status: 5, updated: new Date(Date.now() - 25 * HOUR) });
    await cancelAbandonedJobs(env.DB);
    expect((await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, last.id)).get())?.status).toBe(ACTION_STATUS_CANCELLED);
    expect(await db().select().from(actionTasksVersions)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The ephemeral-runner cleanup, decoupled from the retention arming
// ---------------------------------------------------------------------------

describe("the ephemeral-cleanup arm (probe-gated, never retention-gated)", () => {
  async function seedEphemeral(withLiveTask: boolean): Promise<number> {
    const runner = await createRunner(env.DB, {
      uuid: crypto.randomUUID(),
      name: "eph",
      version: "v1",
      ownerId: 0,
      repoId: "",
      agentLabels: [],
      ephemeral: true,
      hasCancellingSupport: false,
    });
    await seedTask({
      status: withLiveTask ? ACTION_STATUS_RUNNING : ACTION_STATUS_SUCCESS,
      runnerId: runner.id,
      jobId: 1,
    });
    return runner.id;
  }

  it("an ephemeral runner whose tasks are all terminal probes ONE message", async () => {
    await seedEphemeral(false);
    const queue = spyQueue();
    await expect(enqueueDueEphemeralCleanup(producerEnv(queue))).resolves.toBe(1);
    expect(queue.bodies).toEqual([[{ kind: "actions-ephemeral-cleanup" }]]);
  });

  it("an ephemeral runner holding a live task is kept — zero sends", async () => {
    await seedEphemeral(true);
    const queue = spyQueue();
    await expect(enqueueDueEphemeralCleanup(producerEnv(queue))).resolves.toBe(0);
    expect(queue.sendBodies.length === 0 && queue.bodies.length === 0).toBe(true);
  });

  it("no ephemeral runners at all — zero sends (the default deployment's quiet tick)", async () => {
    const queue = spyQueue();
    await expect(enqueueDueEphemeralCleanup(producerEnv(queue))).resolves.toBe(0);
    expect(queue.sendBodies.length === 0 && queue.bodies.length === 0).toBe(true);
  });

  it("the consumer (cleanupEphemeralRunners via the re-export) deletes the finished ephemeral runner", async () => {
    const id = await seedEphemeral(false);
    await cleanupEphemeralRunners(env.DB);
    expect(await db().select().from(actionRunners).where(eq(actionRunners.id, id))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The endless + abandoned producers
// ---------------------------------------------------------------------------

describe("the endless/abandoned producers (probe-gated, unbound fails loud)", () => {
  it("endless: a RUNNING task past the 3h start threshold probes ONE actions-endless message", async () => {
    await seedTask({ status: ACTION_STATUS_RUNNING, started: new Date(Date.now() - ENDLESS_TASK_TIMEOUT_MS - HOUR), updated: new Date() });
    const queue = spyQueue();
    await expect(enqueueDueEndlessTaskStops(producerEnv(queue))).resolves.toBe(1);
    expect(queue.bodies).toEqual([[{ kind: "actions-endless" }]]);
  });

  it("endless: a quiet instance sends nothing", async () => {
    await seedTask({ status: ACTION_STATUS_RUNNING, started: new Date(), updated: new Date() });
    const queue = spyQueue();
    await expect(enqueueDueEndlessTaskStops(producerEnv(queue))).resolves.toBe(0);
    expect(queue.sendBodies.length === 0 && queue.bodies.length === 0).toBe(true);
  });

  it("abandoned: a 24h-quiet waiting job probes ONE actions-abandoned message", async () => {
    await seedJob({ status: 5, updated: new Date(Date.now() - ABANDONED_JOB_TIMEOUT_MS - HOUR) });
    const queue = spyQueue();
    await expect(enqueueDueAbandonedJobCancels(producerEnv(queue))).resolves.toBe(1);
    expect(queue.bodies).toEqual([[{ kind: "actions-abandoned" }]]);
  });

  it("abandoned: a quiet instance sends nothing", async () => {
    await seedJob({ status: 5, updated: new Date() });
    const queue = spyQueue();
    await expect(enqueueDueAbandonedJobCancels(producerEnv(queue))).resolves.toBe(0);
    expect(queue.sendBodies.length === 0 && queue.bodies.length === 0).toBe(true);
  });

  it("unbound REPO_TASKS is a config bug — fails loud before any send", async () => {
    await expect(enqueueDueEndlessTaskStops({ DB: env.DB })).rejects.toThrow("not bound");
    await expect(enqueueDueAbandonedJobCancels({ DB: env.DB })).rejects.toThrow("not bound");
    await expect(enqueueDueEphemeralCleanup({ DB: env.DB })).rejects.toThrow("not bound");
  });
});

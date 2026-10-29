/**
 * SPEC-0012 §4.4/§4.5/§5.6 — the retention-var wiring: the strict-polarity
 * trio (ACTIONS_{ARTIFACT,LOG,RUN}_RETENTION_DAYS) gating the hourly
 * producer, the parsed-values message contract, the REPO_TASKS consumer arm
 * (runActionsRetention), and the probe-gated zombie producer/consumer pair.
 *
 * The producer envs here are NARROW SLICES ({DB, REPO_TASKS} + explicit
 * vars) — never the ambient test env — so the armed/disarmed batteries stay
 * deterministic whatever the surrounding wrangler config injects (the
 * demo-sweep.test.ts scheduledEnv-pin lesson applied at the source).
 * Real local D1 (workerd, @cloudflare/vitest-plugin) for the armed halves;
 * the only stubs are the recording queue and the gate-off D1 tripwire.
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { actionArtifacts, actionRuns, actionTasks } from "../../db/schema";
import { handleRepoTasks } from "../../repos/purge";
import { ACTION_STATUS_FAILURE, ACTION_STATUS_RUNNING, ACTION_STATUS_SUCCESS } from "./model";
import {
  enqueueDueActionsRetention,
  enqueueDueZombieStops,
  isActionsRetentionMessage,
  isActionsZombieStopMessage,
  retentionDaysFromEnv,
  runActionsRetention,
  stopZombieTasks,
  type ActionsRetentionEnv,
} from "./retention";
import { handleScheduledCron } from "../demo-sweep";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60;

/** Recording Queue — counts send/sendBatch AND captures every body (the
 *  sync.test.ts recordingQueue shape). */
function spyQueue(): Queue & { sends: number; sendBodies: unknown[]; bodies: unknown[][] } {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue = {
    sends: 0,
    sendBodies: [] as unknown[],
    bodies: [] as unknown[][],
    send: (body: unknown) => {
      queue.sends += 1;
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

/** The gate-off tripwire: throws on the FIRST property touch, so any read by
 *  disarmed code fails the test naming what was touched. */
function d1ThatThrows(): D1Database {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`D1 touched while the actions-retention gate is off: .${String(prop)}`);
      },
    },
  ) as D1Database;
}

/** The producer env: explicit vars over the real bindings — the narrow slice
 *  keeps ambient config out of the battery. */
const producerEnv = (vars: Record<string, string>, queue: Queue = spyQueue()): ActionsRetentionEnv => ({
  DB: env.DB,
  REPO_TASKS: queue,
  ...vars,
});

async function seedTask(options: { status: number; updated?: Date; stopped?: Date | null; logExpired?: boolean }): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(actionTasks)
    .values({
      jobId: 1,
      repoId: "retention-repo",
      ownerId: 1,
      status: options.status,
      tokenHash: `hash-${Math.random().toString(16).slice(2)}`,
      stopped: options.stopped === undefined ? null : options.stopped,
      logExpired: options.logExpired ?? false,
      created: new Date(Date.now() - 500 * DAY * 1000),
      updated: options.updated ?? new Date(),
    })
    .returning({ id: actionTasks.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("task seed failed");
  return id;
}

async function seedRun(options: { status: number; created: Date }): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(actionRuns)
    .values({
      repoId: "retention-repo",
      ownerId: 1,
      index: Math.floor(Math.random() * 1_000_000) + 1,
      status: options.status,
      created: options.created,
      updated: options.created,
    })
    .returning({ id: actionRuns.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("run seed failed");
  return id;
}

async function seedExpiredArtifact(): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(actionArtifacts)
    .values({
      runId: 1,
      repoId: "retention-repo",
      artifactName: "dist",
      artifactPath: "dist/",
      status: 2, // UPLOAD_CONFIRMED
      expiredUnix: Math.floor(Date.now() / 1000) - 60,
      created: new Date(),
      updated: new Date(),
      storagePath: "", // no R2 object behind this fixture
    })
    .returning({ id: actionArtifacts.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("artifact seed failed");
  return id;
}

/** Fabricated MessageBatch with ack/retry recorders (purge.test.ts shape). */
function fabricatedBatch(bodies: { id: string; body: unknown }[]) {
  const acked: string[] = [];
  const retried: string[] = [];
  const batch = {
    queue: "repo-tasks",
    messages: bodies.map(({ id, body }) => ({
      id,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => {
        acked.push(id);
      },
      retry: () => {
        retried.push(id);
      },
    })),
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: () => {
      retried.push("all");
    },
    ackAll: () => {
      acked.push("all");
    },
  };
  return { batch: batch as unknown as MessageBatch<unknown>, acked, retried };
}

const cronController = (cron: string): ScheduledController => ({ cron }) as ScheduledController;

beforeEach(async () => {
  // Storage resets between tests — re-apply the schema, then clear the data
  // tables this suite touches (system_keystore is deployment material, not
  // test state — see artifacts.test.ts's note; this file never reads it).
  await applyAuthD1Migrations();
  for (const table of ["action_artifacts", "action_runs", "action_tasks"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// ---------------------------------------------------------------------------
// The strict-polarity parse + gate
// ---------------------------------------------------------------------------

describe("retentionDaysFromEnv (the §4.4 strict polarity)", () => {
  it("parses positive integer strings; everything else disarms", () => {
    expect(retentionDaysFromEnv("90")).toBe(90);
    expect(retentionDaysFromEnv("1")).toBe(1);
    expect(retentionDaysFromEnv(undefined)).toBeNull();
    expect(retentionDaysFromEnv("")).toBeNull();
    expect(retentionDaysFromEnv("0")).toBeNull(); // zero disarms (upstream's unlimited polarity is NOT the default here)
    expect(retentionDaysFromEnv("-5")).toBeNull();
    expect(retentionDaysFromEnv("90.5")).toBeNull();
    expect(retentionDaysFromEnv("off")).toBeNull();
    expect(retentionDaysFromEnv("true")).toBeNull();
    expect(retentionDaysFromEnv(" 90")).toBeNull(); // no trim — the exact string or nothing
  });
});

describe("enqueueDueActionsRetention (the hourly producer, SPEC-0012 §4.5)", () => {
  it("with no var set: zero reads (tripwire), zero sends, before any I/O", async () => {
    const queue = spyQueue();
    await expect(
      enqueueDueActionsRetention({ DB: d1ThatThrows(), REPO_TASKS: queue }),
    ).resolves.toBe(0);
    expect(queue.sends + queue.bodies.length).toBe(0);
  });

  it("with only garbage/zero vars: still disarmed — zero reads (tripwire)", async () => {
    const queue = spyQueue();
    await expect(
      enqueueDueActionsRetention({
        DB: d1ThatThrows(),
        REPO_TASKS: queue,
        ACTIONS_ARTIFACT_RETENTION_DAYS: "off",
        ACTIONS_LOG_RETENTION_DAYS: "0",
        ACTIONS_RUN_RETENTION_DAYS: "-1",
      }),
    ).resolves.toBe(0);
    expect(queue.sends + queue.bodies.length).toBe(0);
  });

  it("armed but unbound is a config bug — fails loud before any send", async () => {
    await expect(enqueueDueActionsRetention({ ACTIONS_LOG_RETENTION_DAYS: "365" })).rejects.toThrow("not bound");
  });

  it("armed (log var) + expired task: ONE message carrying exactly the armed values", async () => {
    await seedTask({ status: ACTION_STATUS_SUCCESS, stopped: new Date(Date.now() - 400 * DAY * 1000) });
    const queue = spyQueue();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const enqueued = await enqueueDueActionsRetention(producerEnv({ ACTIONS_LOG_RETENTION_DAYS: "365" }, queue));
    expect(enqueued).toBe(1);
    expect(queue.bodies).toEqual([[{ kind: "actions-retention", logRetentionDays: 365 }]]);
    const message = (queue.bodies[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(message.artifactRetentionDays).toBeUndefined();
    expect(message.runRetentionDays).toBeUndefined();
    // The producer logs the armed tick (§3.1 step-4 posture).
    expect(consoleLog.mock.calls.some((args) => String(args[0]).includes("[actions-retention] enqueued 1 sweep"))).toBe(true);
  });

  it("armed (run var) + old finished run: enqueues with the parsed run window only", async () => {
    await seedRun({ status: ACTION_STATUS_SUCCESS, created: new Date(Date.now() - 500 * DAY * 1000) });
    const queue = spyQueue();
    const enqueued = await enqueueDueActionsRetention(producerEnv({ ACTIONS_RUN_RETENTION_DAYS: "400" }, queue));
    expect(enqueued).toBe(1);
    expect(queue.bodies).toEqual([[{ kind: "actions-retention", runRetentionDays: 400 }]]);
  });

  it("armed (artifact var) + expired artifact: enqueues with the parsed artifact value", async () => {
    await seedExpiredArtifact();
    const queue = spyQueue();
    const enqueued = await enqueueDueActionsRetention(producerEnv({ ACTIONS_ARTIFACT_RETENTION_DAYS: "90" }, queue));
    expect(enqueued).toBe(1);
    expect(queue.bodies).toEqual([[{ kind: "actions-retention", artifactRetentionDays: 90 }]]);
  });

  it("armed but nothing due: zero sends, one compact 0-due line", async () => {
    // An armed arm with no work stays silent on the queue (the audit probe
    // posture) — the 0-due log line is the tick's only trace.
    await seedTask({ status: ACTION_STATUS_SUCCESS, stopped: new Date() }); // fresh task: inside the window
    const queue = spyQueue();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const enqueued = await enqueueDueActionsRetention(producerEnv({ ACTIONS_LOG_RETENTION_DAYS: "365" }, queue));
    expect(enqueued).toBe(0);
    expect(queue.sends + queue.bodies.length).toBe(0);
    expect(consoleLog.mock.calls.some((args) => String(args[0]).includes("[actions-retention] 0 due"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The consumer runner (the purge.ts arm's work)
// ---------------------------------------------------------------------------

describe("runActionsRetention (the REPO_TASKS consumer arm)", () => {
  it("log arm: expires the old task's log exactly per the carried window", async () => {
    const id = await seedTask({
      status: ACTION_STATUS_SUCCESS,
      stopped: new Date(Date.now() - 400 * DAY * 1000),
      logExpired: false,
    });
    await runActionsRetention(env, { kind: "actions-retention", logRetentionDays: 365 });
    const task = await drizzle(env.DB).select().from(actionTasks).where(eq(actionTasks.id, id)).get();
    expect(task?.logExpired).toBe(true);
  });

  it("an unarmed log arm (no logRetentionDays) NEVER expires logs — fail-closed per arm", async () => {
    const id = await seedTask({
      status: ACTION_STATUS_SUCCESS,
      stopped: new Date(Date.now() - 400 * DAY * 1000),
      logExpired: false,
    });
    await runActionsRetention(env, { kind: "actions-retention", runRetentionDays: 400 });
    const task = await drizzle(env.DB).select().from(actionTasks).where(eq(actionTasks.id, id)).get();
    expect(task?.logExpired).toBe(false);
  });

  it("run arm: deletes the old finished run; a message without the run window never deletes", async () => {
    const oldId = await seedRun({ status: ACTION_STATUS_SUCCESS, created: new Date(Date.now() - 500 * DAY * 1000) });
    const recentId = await seedRun({ status: ACTION_STATUS_SUCCESS, created: new Date(Date.now() - 5 * DAY * 1000) });

    // The armed arm deletes exactly the expired run.
    await runActionsRetention(env, { kind: "actions-retention", runRetentionDays: 400 });
    expect(await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, oldId)).get()).toBeUndefined();
    expect(await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, recentId)).get()).toBeDefined();

    // A second old run + an UNARMED message: the run survives.
    const old2 = await seedRun({ status: ACTION_STATUS_FAILURE, created: new Date(Date.now() - 500 * DAY * 1000) });
    await runActionsRetention(env, { kind: "actions-retention", logRetentionDays: 365 });
    expect(await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, old2)).get()).toBeDefined();
  });

  it("the artifact arm runs within ANY armed message (upstream Cleanup is unconditional) and flips expired rows", async () => {
    const id = await seedExpiredArtifact();
    // Only the LOG var armed — the artifact arm still sweeps the expired row.
    await runActionsRetention(env, { kind: "actions-retention", logRetentionDays: 365 });
    const artifact = await drizzle(env.DB).select().from(actionArtifacts).where(eq(actionArtifacts.id, id)).get();
    expect(artifact?.status).toBe(4); // EXPIRED
  });

  it("redelivery is absorbed idempotently (the same message runs twice)", async () => {
    const id = await seedTask({
      status: ACTION_STATUS_SUCCESS,
      stopped: new Date(Date.now() - 400 * DAY * 1000),
      logExpired: false,
    });
    const message = { kind: "actions-retention" as const, logRetentionDays: 365 };
    await runActionsRetention(env, message);
    await runActionsRetention(env, message);
    const task = await drizzle(env.DB).select().from(actionTasks).where(eq(actionTasks.id, id)).get();
    expect(task?.logExpired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The zombie pair (§5.6's cron arm)
// ---------------------------------------------------------------------------

describe("enqueueDueZombieStops + stopZombieTasks (the step-entry arm)", () => {
  it("probe-gated: a stale running task enqueues ONE actions-zombie message", async () => {
    await seedTask({ status: ACTION_STATUS_RUNNING, updated: new Date(Date.now() - 20 * 60 * 1000) });
    const queue = spyQueue();
    const enqueued = await enqueueDueZombieStops({ DB: env.DB, REPO_TASKS: queue });
    expect(enqueued).toBe(1);
    expect(queue.bodies).toEqual([[{ kind: "actions-zombie" }]]);
  });

  it("a quiet instance sends nothing (fresh or non-running tasks)", async () => {
    await seedTask({ status: ACTION_STATUS_RUNNING, updated: new Date() }); // fresh
    await seedTask({ status: ACTION_STATUS_SUCCESS, updated: new Date(Date.now() - 60 * 60 * 1000) }); // done, old
    const queue = spyQueue();
    await expect(enqueueDueZombieStops({ DB: env.DB, REPO_TASKS: queue })).resolves.toBe(0);
    expect(queue.sends + queue.bodies.length).toBe(0);
  });

  it("the consumer stops the stale task as FAILURE", async () => {
    const id = await seedTask({ status: ACTION_STATUS_RUNNING, updated: new Date(Date.now() - 20 * 60 * 1000) });
    await expect(stopZombieTasks(env.DB)).resolves.toBe(1);
    const task = await drizzle(env.DB).select().from(actionTasks).where(eq(actionTasks.id, id)).get();
    expect(task?.status).toBe(ACTION_STATUS_FAILURE);
  });
});

// ---------------------------------------------------------------------------
// The dispatch + scheduled wiring
// ---------------------------------------------------------------------------

describe("handleRepoTasks dispatch arms (the purge.ts consumer)", () => {
  it("routes actions-retention and actions-zombie to their runners and acks them", async () => {
    const { batch, acked, retried } = fabricatedBatch([
      { id: "retention", body: { kind: "actions-retention", logRetentionDays: 365 } },
      { id: "zombie", body: { kind: "actions-zombie" } },
      { id: "garbage", body: { hello: true } },
    ]);
    await handleRepoTasks(batch, env);
    // The two typed arms ran (empty tables — both are no-op sweeps) and
    // acked; the garbage body fell to the malformed-purge drop (acked).
    expect(acked.sort()).toEqual(["garbage", "retention", "zombie"]);
    expect(retried).toEqual([]);
  });

  it("a throwing retention sweep retries THAT message (the arm's catch never rejects the batch)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { batch, acked, retried } = fabricatedBatch([{ id: "retention", body: { kind: "actions-retention" } }]);
    // The typed arm's try/catch converts the tripwire throw into a retry —
    // handleRepoTasks itself still resolves (the mirror arm's contract).
    await handleRepoTasks(batch, { ...env, DB: d1ThatThrows() });
    expect(retried).toEqual(["retention"]);
    expect(acked).toEqual([]);
    expect(consoleError.mock.calls.some((args) => String(args[0]).includes("[repo-tasks] actions-retention retention retrying"))).toBe(true);
  });
});

describe("handleScheduledCron wiring (the dispatcher blocks)", () => {
  it("hourly: the armed actions-retention producer rides the 0 * * * * entry", async () => {
    await seedTask({ status: ACTION_STATUS_SUCCESS, stopped: new Date(Date.now() - 400 * DAY * 1000) });
    const tasksQueue = spyQueue();
    const mirrorQueue = spyQueue();
    await handleScheduledCron(
      cronController("0 * * * *"),
      {
        DB: env.DB,
        REPO_TASKS: tasksQueue,
        MIRROR_SYNC_QUEUE: mirrorQueue,
        DEMO_MODE: "false",
        AUDIT_RETENTION_DAYS: "off",
        ACTIONS_LOG_RETENTION_DAYS: "365",
      } as unknown as Env,
    );
    const retentionMessages = tasksQueue.bodies.flat().filter(isActionsRetentionMessage);
    expect(retentionMessages).toEqual([{ kind: "actions-retention", logRetentionDays: 365 }]);
    // The hourly entry never dispatches the mirror producers.
    expect(mirrorQueue.sends + mirrorQueue.bodies.length).toBe(0);
  });

  it("hourly with the trio unset: a tripwire DB survives the whole invocation (the §2 posture for the actions family)", async () => {
    const tasksQueue = spyQueue();
    const mirrorQueue = spyQueue();
    await expect(
      handleScheduledCron(
        cronController("0 * * * *"),
        {
          DB: d1ThatThrows(),
          REPO_TASKS: tasksQueue,
          MIRROR_SYNC_QUEUE: mirrorQueue,
          DEMO_MODE: "false",
          AUDIT_RETENTION_DAYS: "off",
        } as unknown as Env,
      ),
    ).resolves.toBeUndefined();
    expect(tasksQueue.sends + tasksQueue.bodies.length).toBe(0);
  });

  it("step entry: the probe-gated zombie producer rides the */10 entry", async () => {
    await seedTask({ status: ACTION_STATUS_RUNNING, updated: new Date(Date.now() - 20 * 60 * 1000) });
    const tasksQueue = spyQueue();
    const mirrorQueue = spyQueue();
    await handleScheduledCron(
      cronController("*/10 * * * *"),
      { DB: env.DB, REPO_TASKS: tasksQueue, MIRROR_SYNC_QUEUE: mirrorQueue } as unknown as Env,
    );
    expect(tasksQueue.bodies.flat().filter(isActionsZombieStopMessage)).toEqual([{ kind: "actions-zombie" }]);
    // No demo/retention work ever rides the step entry.
    expect(tasksQueue.bodies.flat().filter(isActionsRetentionMessage)).toEqual([]);
  });

  it("step entry on a quiet instance: zero sends", async () => {
    const tasksQueue = spyQueue();
    const mirrorQueue = spyQueue();
    await handleScheduledCron(
      cronController("*/10 * * * *"),
      { DB: env.DB, REPO_TASKS: tasksQueue, MIRROR_SYNC_QUEUE: mirrorQueue } as unknown as Env,
    );
    expect(tasksQueue.sends + tasksQueue.bodies.length).toBe(0);
  });
});

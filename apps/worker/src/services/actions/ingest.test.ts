/**
 * The M1b ingestion suite (SPEC-0012 §6.3, service layer): UpdateTask's
 * state machine (the terminal arms, the cancelling-preservation, the
 * no-op-on-done, reported steps, outputs + resend keys), the run/attempt
 * aggregate mirror, UpdateLog's ack protocol (trim/gap/seal/AlreadyExists)
 * over the real R2 seal, the log line format round trip, StopTask's arms,
 * the job-summary caps, and the version-wake bump.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  actionTasksVersions,
  repositories,
  repoUnits,
  users,
} from "../../db/schema";
import { createRunner, insertActionRun, newRunnerTokenWithValue } from "./model";
import {
  aggregateJobStatus,
  stopTask,
  updateTask,
  updateLog,
  updateTaskByState,
  validateReportedSteps,
} from "./update";
import { encodeLogIndexes, decodeLogIndexes, formatLog, formatTimestamp, parseLog, readLogs } from "./logs";
import {
  JobSummaryAggregateExceededError,
  deleteJobSummary,
  listJobSummaries,
  normalizeJobSummaryContentType,
  upsertJobSummary,
} from "./summaries";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const CLEANUP_TABLES = [
  "action_runners",
  "action_runner_tokens",
  "action_runs",
  "action_run_jobs",
  "action_run_attempts",
  "action_tasks",
  "action_task_steps",
  "action_task_outputs",
  "action_tasks_versions",
  "action_artifacts",
  "action_run_job_summaries",
  "action_log_chunks",
  "secrets",
  "action_variables",
  "repo_units",
  "repositories",
  "users",
];

beforeEach(async () => {
  for (const table of CLEANUP_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The keystore object is deliberately NOT wiped (deployment material —
  // the module-level cache outlives tests in one isolate; see
  // artifacts.test.ts's note). Only the data namespaces wipe.
  const chunks = await env.REPO_PACKS.list({ prefix: "actions/tmp/" });
  if (chunks.objects.length > 0) {
    await env.REPO_PACKS.delete(chunks.objects.map((o) => o.key));
  }
  const artifacts = await env.REPO_PACKS.list({ prefix: "actions/artifacts/" });
  if (artifacts.objects.length > 0) {
    await env.REPO_PACKS.delete(artifacts.objects.map((o) => o.key));
  }
  const logs = await env.REPO_PACKS.list({ prefix: "actions/logs/" });
  if (logs.objects.length > 0) {
    await env.REPO_PACKS.delete(logs.objects.map((o) => o.key));
  }
});

const db = () => drizzle(env.DB);

const WORKFLOW_PAYLOAD = new TextEncoder().encode("name: ci\njobs:\n  build:\n    steps:\n      - run: echo hi\n");

interface Seed {
  runId: number;
  ownerId: number;
}

async function seed(options: { jobs: Array<{ jobId: string; needs?: string[]; runsOn?: string[] }> }): Promise<Seed> {
  const username = `ingest-owner-${Math.random().toString(16).slice(2, 8)}`;
  const owner = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning({ id: users.id });
  const ownerSeed = owner[0];
  if (ownerSeed === undefined) throw new Error("owner seed failed");
  const ownerId = ownerSeed.id;
  const repoId = `ingest-repo-${Math.random().toString(16).slice(2, 8)}`;
  const slug = `repo-${Math.random().toString(16).slice(2, 8)}`;
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: "ingest-owner",
    ownerId,
    slug,
    visibility: "public",
  });
  await db().insert(repoUnits).values({ repoId, type: "actions" });
  const { run } = await insertActionRun(
    env.DB,
    {
      repoId,
      ownerId,
      workflowId: ".gitea/workflows/ci.yml",
      index: 1,
      triggerUserId: ownerId,
      ref: "refs/heads/main",
      commitSha: "c".repeat(40),
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
    },
    options.jobs.map((j) => ({
      jobId: j.jobId,
      needs: j.needs ?? [],
      runsOn: j.runsOn ?? ["ubuntu-latest"],
      workflowPayload: WORKFLOW_PAYLOAD,
    })),
  );
  return { runId: run.id, ownerId };
}

/** A runner row + a claimed task for one job (the claim CAS's shape). */
async function claimTask(seedInfo: Seed, jobId: string): Promise<{ runnerId: number; taskId: number; jobId: number }> {
  const runner = await createRunner(env.DB, {
    uuid: crypto.randomUUID(),
    name: "ingest-runner",
    version: "test",
    ownerId: 0,
    repoId: "",
    agentLabels: ["ubuntu-latest"],
    ephemeral: false,
    hasCancellingSupport: false,
  });
  const jobRows = await db().select().from(actionRunJobs).where(eq(actionRunJobs.jobId, jobId));
  const job = jobRows[0];
  if (job === undefined) throw new Error("job missing");
  const now = new Date();
  const taskRows = await db()
    .insert(actionTasks)
    .values({
      jobId: job.id,
      attempt: 1,
      runnerId: runner.id,
      status: 6,
      started: now,
      repoId: job.repoId,
      ownerId: job.ownerId,
      commitSha: job.commitSha,
      // 64 hex chars — UNIQUE per task (the salted digest's shape).
      tokenHash: crypto.randomUUID().replaceAll("-", "").repeat(2),
      tokenSalt: "s",
      tokenLastEight: "ingest01",
      logFilename: `ingest-owner/repo/${(Math.floor(Math.random() * 255) + 1).toString(16).padStart(2, "0")}/t.log`,
      created: now,
      updated: now,
    })
    .returning();
  const task = taskRows[0];
  if (task === undefined) throw new Error("task insert failed");
  await db()
    .update(actionRunJobs)
    .set({ taskId: task.id, status: 6, started: now })
    .where(eq(actionRunJobs.id, job.id));
  return { runnerId: runner.id, taskId: task.id, jobId: job.id };
}

async function taskRow(taskId: number) {
  const rows = await db().select().from(actionTasks).where(eq(actionTasks.id, taskId));
  const row = rows[0];
  if (row === undefined) throw new Error("task row missing");
  return row;
}

async function jobRowById(id: number) {
  const rows = await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, id));
  const row = rows[0];
  if (row === undefined) throw new Error("job row missing");
  return row;
}

// ---------------------------------------------------------------------------
// UpdateTask — the state machine (models/actions/task.go:481-565)
// ---------------------------------------------------------------------------

describe("updateTaskByState — the state machine", () => {
  it("a non-terminal report touches updated only (the zombie-stay-alive arm)", async () => {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seedInfo, "build");
    const before = await taskRow(claim.taskId);

    await updateTaskByState(env.DB, claim.runnerId, {
      id: claim.taskId,
      result: 0,
      startedAt: undefined,
      stoppedAt: undefined,
      steps: [],
      reportedSteps: [],
    });

    const after = await taskRow(claim.taskId);
    expect(after.status).toBe(6);
    expect(after.stopped).toBeNull();
    expect(after.updated.getTime()).toBeGreaterThanOrEqual(before.updated.getTime());
  });

  it("a terminal result finishes the task + job and aggregates run + attempt", async () => {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seedInfo, "build");

    const outcome = await updateTask(env.DB, claim.runnerId, {
      state: { id: claim.taskId, result: 1, startedAt: undefined, stoppedAt: undefined, steps: [], reportedSteps: [] },
      outputs: {},
    });

    expect(outcome.result).toBe(1); // task.Status.AsResult()
    const task = await taskRow(claim.taskId);
    expect(task.status).toBe(1); // success
    expect(task.stopped).not.toBeNull();
    const job = await jobRowById(claim.jobId);
    expect(job.status).toBe(1);
    expect(job.stopped).not.toBeNull();
    const attemptRows = await db().select().from(actionRunAttempts).where(eq(actionRunAttempts.runId, seedInfo.runId));
    expect(attemptRows[0]?.status).toBe(1);
    const runRows = await db().select().from(actionRuns).where(eq(actionRuns.id, seedInfo.runId));
    expect(runRows[0]?.status).toBe(1);
    expect(runRows[0]?.stopped).not.toBeNull();
  });

  it("a cancelling task reporting SUCCESS/FAILURE lands CANCELLED (user intent preserved)", async () => {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seedInfo, "build");
    await db().update(actionTasks).set({ status: 8 }).where(eq(actionTasks.id, claim.taskId));

    await updateTaskByState(env.DB, claim.runnerId, {
      id: claim.taskId,
      result: 1, // the runner's cleanup phase "succeeded"
      startedAt: undefined,
      stoppedAt: undefined,
      steps: [],
      reportedSteps: [],
    });
    expect((await taskRow(claim.taskId)).status).toBe(3); // cancelled
  });

  it("a done task is a no-op (the state is final, do nothing)", async () => {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seedInfo, "build");
    const stopped = new Date(Date.now() - 60_000);
    await db().update(actionTasks).set({ status: 1, stopped }).where(eq(actionTasks.id, claim.taskId));

    await updateTaskByState(env.DB, claim.runnerId, {
      id: claim.taskId,
      result: 2, // would flip to failure if not guarded
      startedAt: undefined,
      stoppedAt: undefined,
      steps: [],
      reportedSteps: [],
    });
    const task = await taskRow(claim.taskId);
    expect(task.status).toBe(1);
    // The timestamp columns store seconds — compare at that granularity.
    expect(task.stopped?.getTime()).toBe(Math.floor(stopped.getTime() / 1000) * 1000);
  });

  it("a foreign runner is refused (invalid runner for task)", async () => {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seedInfo, "build");
    await expect(
      updateTaskByState(env.DB, claim.runnerId + 999, {
        id: claim.taskId,
        result: 1,
        startedAt: undefined,
        stoppedAt: undefined,
        steps: [],
        reportedSteps: [],
      }),
    ).rejects.toThrow("invalid runner for task");
  });

  it("an ephemeral runner is deleted when its task finishes (UpdateTask's IsDone arm)", async () => {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seedInfo, "build");
    await db().update(actionRunners).set({ ephemeral: true }).where(eq(actionRunners.id, claim.runnerId));

    await updateTask(env.DB, claim.runnerId, {
      state: { id: claim.taskId, result: 1, startedAt: undefined, stoppedAt: undefined, steps: [], reportedSteps: [] },
      outputs: {},
    });
    const rows = await db().select().from(actionRunners).where(eq(actionRunners.id, claim.runnerId));
    expect(rows).toHaveLength(0);
  });

  it("finishing bumps the tasks_version only when waiting work remains", async () => {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }, { jobId: "deploy" }] });
    const claim = await claimTask(seedInfo, "build");
    const sum = (rows: Array<{ version: number }>) => rows.reduce((acc, r) => acc + r.version, 0);
    const versionsBefore = await db().select().from(actionTasksVersions);

    await updateTask(env.DB, claim.runnerId, {
      state: { id: claim.taskId, result: 1, startedAt: undefined, stoppedAt: undefined, steps: [], reportedSteps: [] },
      outputs: {},
    });
    const versionsAfter = await db().select().from(actionTasksVersions);
    // insertActionRun already bumped every scope — the wake bump raises the
    // VERSION VALUES, not the row count (deploy is still waiting).
    expect(sum(versionsAfter)).toBeGreaterThan(sum(versionsBefore));

    // Second finish with nothing waiting: no bump.
    const before = versionsAfter.map((v) => v.version);
    const claim2 = await claimTask(seedInfo, "deploy");
    await updateTask(env.DB, claim2.runnerId, {
      state: { id: claim2.taskId, result: 1, startedAt: undefined, stoppedAt: undefined, steps: [], reportedSteps: [] },
      outputs: {},
    });
    const after = await db().select().from(actionTasksVersions);
    expect(after.map((v) => v.version)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// UpdateTask — outputs + resend keys (runner.go:231-254)
// ---------------------------------------------------------------------------

describe("updateTask — outputs", () => {
  it("stores outputs under the caps and reports ALL stored keys (the resend contract)", async () => {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seedInfo, "build");

    const outcome = await updateTask(env.DB, claim.runnerId, {
      state: { id: claim.taskId, result: 0, startedAt: undefined, stoppedAt: undefined, steps: [], reportedSteps: [] },
      outputs: { "first": "1", "second": "2" },
    });
    expect(outcome.sentOutputs.sort()).toEqual(["first", "second"]);

    // Upsert-if-absent: re-reporting the same key keeps the ORIGINAL value.
    await updateTask(env.DB, claim.runnerId, {
      state: { id: claim.taskId, result: 0, startedAt: undefined, stoppedAt: undefined, steps: [], reportedSteps: [] },
      outputs: { first: "overwritten" },
    });
    const rows = await db().select().from(actionTaskOutputs).where(eq(actionTaskOutputs.taskId, claim.taskId));
    const first = rows.find((r) => r.outputKey === "first");
    expect(first?.outputValue).toBe("1");
  });

  it("skips oversized keys and values (logged-and-skipped, not fatal)", async () => {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seedInfo, "build");

    const outcome = await updateTask(env.DB, claim.runnerId, {
      state: { id: claim.taskId, result: 0, startedAt: undefined, stoppedAt: undefined, steps: [], reportedSteps: [] },
      outputs: {
        ["k".repeat(256)]: "value", // key > 255 bytes
        ok: "v".repeat(1024 * 1024 + 1), // value > 1 MiB
        good: "kept",
      },
    });
    expect(outcome.sentOutputs).toEqual(["good"]);
  });
});

// ---------------------------------------------------------------------------
// UpdateTask — reported steps (task_step.go)
// ---------------------------------------------------------------------------

describe("updateTaskByState — reported steps", () => {
  it("replaces the steps with the runner-reported layout and keeps times across re-reports", async () => {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seedInfo, "build");

    await updateTaskByState(env.DB, claim.runnerId, {
      id: claim.taskId,
      result: 0,
      startedAt: undefined,
      stoppedAt: undefined,
      steps: [],
      reportedSteps: [
        { id: 0, result: 0, startedAt: { seconds: 100, nanos: 0 }, stoppedAt: undefined, logIndex: 0, logLength: 5, name: "Set up", stage: 1, number: 0 },
        { id: 1, result: 1, startedAt: { seconds: 200, nanos: 0 }, stoppedAt: { seconds: 300, nanos: 0 }, logIndex: 5, logLength: 7, name: "Build", stage: 4, number: 1 },
      ],
    });

    let steps = await db().select().from(actionTaskSteps).where(eq(actionTaskSteps.taskId, claim.taskId));
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => ({ stage: s.stage, number: s.number, status: s.status }))).toEqual([
      { stage: 1, number: 0, status: 6 }, // started, not finished → running
      { stage: 4, number: 1, status: 1 }, // finished → success
    ]);

    // Same layout: the rows update IN PLACE (ids stable).
    const idsBefore = steps.map((s) => s.id);
    await updateTaskByState(env.DB, claim.runnerId, {
      id: claim.taskId,
      result: 1,
      startedAt: undefined,
      stoppedAt: undefined,
      steps: [],
      reportedSteps: [
        { id: 0, result: 1, startedAt: { seconds: 100, nanos: 0 }, stoppedAt: { seconds: 400, nanos: 0 }, logIndex: 0, logLength: 9, name: "Set up", stage: 1, number: 0 },
        { id: 1, result: 1, startedAt: { seconds: 200, nanos: 0 }, stoppedAt: { seconds: 300, nanos: 0 }, logIndex: 5, logLength: 7, name: "Build", stage: 4, number: 1 },
      ],
    });
    steps = await db().select().from(actionTaskSteps).where(eq(actionTaskSteps.taskId, claim.taskId));
    expect(steps.map((s) => s.id)).toEqual(idsBefore);
    expect(steps.find((s) => s.number === 0)?.status).toBe(1);
    expect(steps.find((s) => s.number === 0)?.stopped).not.toBeNull();
  });

  it("refuses invalid reports (the validator arms)", () => {
    expect(validateReportedSteps([{ id: 0, result: 0, startedAt: undefined, stoppedAt: undefined, logIndex: 0, logLength: 0, name: "", stage: 0, number: 0 }])).toBeNull();
    expect(
      validateReportedSteps([
        { id: 0, result: 0, startedAt: undefined, stoppedAt: undefined, logIndex: 0, logLength: 0, name: "", stage: 4, number: 1 },
        { id: 1, result: 0, startedAt: undefined, stoppedAt: undefined, logIndex: 0, logLength: 0, name: "", stage: 4, number: 1 },
      ]),
    ).toBeNull(); // duplicate stage/number
    expect(
      validateReportedSteps([{ id: 1, result: 0, startedAt: undefined, stoppedAt: undefined, logIndex: 0, logLength: 0, name: "", stage: 4, number: 0 }]),
    ).toBeNull(); // id != index
    expect(
      validateReportedSteps([{ id: 0, result: 0, startedAt: undefined, stoppedAt: undefined, logIndex: -1, logLength: 0, name: "", stage: 4, number: 0 }]),
    ).toBeNull(); // negative log range
  });
});

// ---------------------------------------------------------------------------
// UpdateLog — the ack protocol (runner.go:288-359)
// ---------------------------------------------------------------------------

describe("updateLog — the ack protocol", () => {
  async function claimedWithLog(): Promise<{ taskId: number; runnerId: number; logFilename: string }> {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seedInfo, "build");
    const task = await taskRow(claim.taskId);
    return { taskId: claim.taskId, runnerId: claim.runnerId, logFilename: task.logFilename };
  }

  it("appends rows, advances the log math, and acks the new length", async () => {
    const ctx = await claimedWithLog();
    const ack = await updateLog(env, ctx.runnerId, {
      taskId: ctx.taskId,
      index: 0,
      rows: [
        { time: { seconds: 1700000000, nanos: 0 }, content: "first" },
        { time: { seconds: 1700000001, nanos: 0 }, content: "second\nline" },
      ],
      noMore: false,
    });
    expect(ack.ackIndex).toBe(2);
    const task = await taskRow(ctx.taskId);
    expect(task.logLength).toBe(2);
    expect(task.logSize).toBeGreaterThan(0);
    expect(task.logInStorage).toBe(false);
    const chunks = await db().select().from(actionLogChunks).where(eq(actionLogChunks.taskId, ctx.taskId));
    expect(chunks).toHaveLength(1);

    // The bytes carry the upstream line format: escaped newline included.
    const bytes = chunks[0]?.bytes;
    const text = new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array());
    expect(text).toContain(" first\n");
    expect(text).toContain("second\\nline\n");
    expect(parseLog(text.split("\n")[0] ?? "").content).toBe("first");
  });

  it("trims re-sent rows against the ack (the overlapping-resend arm)", async () => {
    const ctx = await claimedWithLog();
    await updateLog(env, ctx.runnerId, {
      taskId: ctx.taskId,
      index: 0,
      rows: [
        { time: { seconds: 1, nanos: 0 }, content: "a" },
        { time: { seconds: 2, nanos: 0 }, content: "b" },
      ],
      noMore: false,
    });
    // The runner resends rows 1..2 (index 1) plus a NEW row: only "c" lands.
    const ack = await updateLog(env, ctx.runnerId, {
      taskId: ctx.taskId,
      index: 1,
      rows: [
        { time: { seconds: 2, nanos: 0 }, content: "b" },
        { time: { seconds: 3, nanos: 0 }, content: "c" },
      ],
      noMore: false,
    });
    expect(ack.ackIndex).toBe(3);
    const task = await taskRow(ctx.taskId);
    expect(task.logLength).toBe(3);
    const text = await hotText(ctx.taskId);
    expect(text).toContain(" a\n");
    expect(text).toContain(" c\n");
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("bails when there is nothing new and no legal finalize", async () => {
    const ctx = await claimedWithLog();
    const ack = await updateLog(env, ctx.runnerId, { taskId: ctx.taskId, index: 2, rows: [], noMore: false });
    expect(ack.ackIndex).toBe(0); // the runner has outrun the server — plain bail
    const ack2 = await updateLog(env, ctx.runnerId, { taskId: ctx.taskId, index: 0, rows: [], noMore: false });
    expect(ack2.ackIndex).toBe(0);
  });

  it("refuses a finalize that would archive a gap (index > ack)", async () => {
    const ctx = await claimedWithLog();
    const ack = await updateLog(env, ctx.runnerId, { taskId: ctx.taskId, index: 5, rows: [], noMore: true });
    expect(ack.ackIndex).toBe(0);
    expect((await taskRow(ctx.taskId)).logInStorage).toBe(false);
  });

  it("seals on no_more: R2 object written, log_in_storage flipped, chunks dropped", async () => {
    const ctx = await claimedWithLog();
    await updateLog(env, ctx.runnerId, {
      taskId: ctx.taskId,
      index: 0,
      rows: [
        { time: { seconds: 1, nanos: 0 }, content: "hello" },
        { time: { seconds: 2, nanos: 0 }, content: "world" },
      ],
      noMore: true,
    });
    const task = await taskRow(ctx.taskId);
    expect(task.logInStorage).toBe(true);
    const chunks = await db().select().from(actionLogChunks).where(eq(actionLogChunks.taskId, ctx.taskId));
    expect(chunks).toHaveLength(0);
    const obj = await env.REPO_PACKS.get(`actions/logs/${task.logFilename}`);
    expect(obj).not.toBeNull();
    const text = await obj?.text();
    expect(text?.split("\n").filter((l) => l !== "")).toHaveLength(2);
    expect(text).toContain(" world\n");

    // The sealed log reads back through the ReadLogs analog.
    const rows = await readLogs(env, true, task.logFilename, ctx.taskId, 0, -1);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.content).toBe("world");
  });

  it("acks a re-sent finalize idempotently; appends past the seal error AlreadyExists", async () => {
    const ctx = await claimedWithLog();
    await updateLog(env, ctx.runnerId, {
      taskId: ctx.taskId,
      index: 0,
      rows: [{ time: { seconds: 1, nanos: 0 }, content: "only" }],
      noMore: true,
    });

    const ack = await updateLog(env, ctx.runnerId, { taskId: ctx.taskId, index: 1, rows: [], noMore: true });
    expect(ack.ackIndex).toBe(1);

    await expect(
      updateLog(env, ctx.runnerId, {
        taskId: ctx.taskId,
        index: 1,
        rows: [{ time: { seconds: 9, nanos: 0 }, content: "late" }],
        noMore: false,
      }),
    ).rejects.toThrow("log file has been archived");
  });

  it("bootstraps an empty log on a zero-row finalize (the empty object lands)", async () => {
    const ctx = await claimedWithLog();
    const ack = await updateLog(env, ctx.runnerId, { taskId: ctx.taskId, index: 0, rows: [], noMore: true });
    expect(ack.ackIndex).toBe(0);
    const task = await taskRow(ctx.taskId);
    expect(task.logInStorage).toBe(true);
    const obj = await env.REPO_PACKS.get(`actions/logs/${task.logFilename}`);
    expect(obj).not.toBeNull();
    expect(obj?.size).toBe(0);
  });

  it("refuses a foreign runner (invalid runner for task)", async () => {
    const ctx = await claimedWithLog();
    await expect(
      updateLog(env, ctx.runnerId + 42, { taskId: ctx.taskId, index: 0, rows: [], noMore: false }),
    ).rejects.toThrow("invalid runner for task");
  });

  async function hotText(taskId: number): Promise<string> {
    const chunks = await db().select().from(actionLogChunks).where(eq(actionLogChunks.taskId, taskId));
    let text = "";
    for (const c of chunks) {
      text += new TextDecoder().decode(c.bytes instanceof Uint8Array ? c.bytes : new Uint8Array());
    }
    return text;
  }
});

// ---------------------------------------------------------------------------
// The log line format + the varint index (modules/actions/log.go, utils.go)
// ---------------------------------------------------------------------------

describe("the log line format", () => {
  it("formats and parses the RFC3339 7-digit-fraction line", () => {
    const time = new Date("2026-10-29T12:34:56.789Z");
    const line = formatLog(time, "hello world");
    expect(line.startsWith("2026-10-29T12:34:56.7890000Z ")).toBe(true);
    const parsed = parseLog(line);
    expect(parsed.content).toBe("hello world");
    expect(parsed.time.getTime()).toBe(time.getTime());
    expect(formatTimestamp(time)).toBe("2026-10-29T12:34:56.7890000Z");
  });

  it("escapes embedded newlines and truncates at 64 KiB bytes", () => {
    expect(formatLog(new Date(0), "a\nb")).toMatch(/ a\\nb$/);
    const big = "x".repeat(70_000);
    const line = formatLog(new Date(0), big);
    const content = line.slice(line.indexOf(" ") + 1);
    expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(64 * 1024);
  });

  it("round-trips the varint LogIndexes (the zigzag encoding)", () => {
    const values = [0, 1, -1, 127, 128, -128, 65535, 1_000_000, -1_000_000, 2_147_483_647];
    expect(decodeLogIndexes(encodeLogIndexes(values))).toEqual(values);
  });
});

// ---------------------------------------------------------------------------
// Aggregate + StopTask
// ---------------------------------------------------------------------------

describe("aggregateJobStatus + stopTask", () => {
  it("aggregates exactly upstream's table (run_job.go:642-687)", () => {
    const j = (status: number, continueOnError = false) => ({ status, continueOnError });
    expect(aggregateJobStatus([])).toBe(0);
    expect(aggregateJobStatus([j(1)])).toBe(1);
    expect(aggregateJobStatus([j(1), j(4)])).toBe(1); // success+skipped = success
    expect(aggregateJobStatus([j(4)])).toBe(4); // all skipped
    expect(aggregateJobStatus([j(1), j(2)])).toBe(2); // failure wins
    expect(aggregateJobStatus([j(1), j(3)])).toBe(3);
    expect(aggregateJobStatus([j(1), j(6)])).toBe(6); // still running
    expect(aggregateJobStatus([j(1), j(2, true)])).toBe(1); // continued failure counts as success
    expect(aggregateJobStatus([j(5)])).toBe(5);
  });

  it("StopTask: cancelling negotiates by runner capability, terminal forces", async () => {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seedInfo, "build");

    // No cancelling support → straight CANCELLED.
    await stopTask(env.DB, claim.taskId, 8);
    expect((await taskRow(claim.taskId)).status).toBe(3);
    expect((await jobRowById(claim.jobId)).status).toBe(3);

    // A fresh task with a capable runner: cancelling handshake lands 8.
    const seed2 = await seed({ jobs: [{ jobId: "cancel-me" }] });
    const claim2 = await claimTask(seed2, "cancel-me");
    await db().update(actionRunners).set({ hasCancellingSupport: true }).where(eq(actionRunners.id, claim2.runnerId));
    await stopTask(env.DB, claim2.taskId, 8);
    expect((await taskRow(claim2.taskId)).status).toBe(8);
    expect((await jobRowById(claim2.jobId)).status).toBe(8);

    // A terminal stop force-finishes and mirrors job + run.
    await stopTask(env.DB, claim2.taskId, 2);
    expect((await taskRow(claim2.taskId)).status).toBe(2);
    const runRows = await db().select().from(actionRuns).where(eq(actionRuns.id, seed2.runId));
    expect(runRows[0]?.status).toBe(2);
  });

  it("StopTask refuses a non-terminal, non-cancelling status", async () => {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seedInfo, "build");
    await expect(stopTask(env.DB, claim.taskId, 6)).rejects.toThrow("cannot stop task");
  });
});

// ---------------------------------------------------------------------------
// Job summaries (run_job_summary.go)
// ---------------------------------------------------------------------------

describe("job summaries", () => {
  it("normalizes the content type (the markdown-only gate)", () => {
    expect(normalizeJobSummaryContentType("")).toBe("text/markdown");
    expect(normalizeJobSummaryContentType("application/octet-stream")).toBe("text/markdown");
    expect(normalizeJobSummaryContentType("text/markdown; charset=utf-8")).toBe("text/markdown");
    expect(normalizeJobSummaryContentType("text/html")).toBeNull();
    expect(normalizeJobSummaryContentType("not a media type")).toBeNull();
  });

  it("upserts, clears on empty via delete, and enforces the aggregate cap", async () => {
    const seedInfo = await seed({ jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seedInfo, "build");
    // A MAIN-stage step row so the summary validation has a target.
    await db().insert(actionTaskSteps).values({
      name: "step",
      taskId: claim.taskId,
      index: 0,
      repoId: "x",
      stage: 4,
      number: 0,
      created: new Date(),
      updated: new Date(),
    });

    const d1 = env.DB;
    const jobRowNow = await jobRowById(claim.jobId);
    await upsertJobSummary(d1, jobRowNow.repoId, jobRowNow.runId, jobRowNow.runAttemptId, claim.jobId, 0, "text/markdown", new TextEncoder().encode("# hi"));
    let summaries = await listJobSummaries(d1, jobRowNow.repoId, jobRowNow.runId, jobRowNow.runAttemptId, claim.jobId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.content).toBe("# hi");
    expect(summaries[0]?.contentSize).toBe(4);

    // Upsert replaces.
    await upsertJobSummary(d1, jobRowNow.repoId, jobRowNow.runId, jobRowNow.runAttemptId, claim.jobId, 0, "text/markdown", new TextEncoder().encode("# replaced"));
    summaries = await listJobSummaries(d1, jobRowNow.repoId, jobRowNow.runId, jobRowNow.runAttemptId, claim.jobId);
    expect(summaries[0]?.content).toBe("# replaced");

    // Aggregate cap: a second near-1 MiB step trips it.
    await expect(
      upsertJobSummary(
        d1,
        jobRowNow.repoId,
        jobRowNow.runId,
        jobRowNow.runAttemptId,
        claim.jobId,
        1,
        "text/markdown",
        new Uint8Array(1024 * 1024).fill(0x61),
      ),
    ).rejects.toBeInstanceOf(JobSummaryAggregateExceededError);

    // Empty content is a no-op; the DELETE arm clears.
    await upsertJobSummary(d1, jobRowNow.repoId, jobRowNow.runId, jobRowNow.runAttemptId, claim.jobId, 2, "text/markdown", new Uint8Array(0));
    await deleteJobSummary(d1, jobRowNow.repoId, jobRowNow.runId, jobRowNow.runAttemptId, claim.jobId, 0);
    summaries = await listJobSummaries(d1, jobRowNow.repoId, jobRowNow.runId, jobRowNow.runAttemptId, claim.jobId);
    expect(summaries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The registration-token helper stays importable (the M1a surface M1b rides)
// ---------------------------------------------------------------------------

describe("token plumbing sanity", () => {
  it("mints an active scoped token", async () => {
    const row = await newRunnerTokenWithValue(env.DB, 0, "", "sanity-token");
    expect(row.isActive).toBe(true);
  });
});

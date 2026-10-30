/**
 * The rerun service suite (SPEC-0012's C5 remainder — the board's P1-2):
 * services/actions/rerun.go ported at the M1 store's stage. Pins: rerun-all
 * (the new attempt + per-attempt job reset + the run linkage),
 * rerun-failed's pass-through split (the succeeded jobs keep status/timing/
 * source task), the artifact-inheritance chain (run_attempt.go:104-148 —
 * a partial rerun's attempts inherit; a full rerun starts over), the
 * downstream-needs expansion, the approval arm, and every validation arm
 * with its upstream message.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import {
  actionArtifacts,
  actionRunAttempts,
  actionRunJobs,
  actionRuns,
  actionTasksVersions,
  repositories,
  repoUnits,
  users,
} from "../../db/schema";
import {
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_PENDING,
  ACTION_STATUS_SUCCESS,
  ACTION_STATUS_WAITING,
  insertActionRun,
} from "./model";
import { parseRepoActionsConfig, saveRepoActionsConfig } from "./config";
import { getArtifactAttemptIds, getFailedJobsForRerun, MAX_RERUN_ATTEMPTS, rerunWorkflowRunJobs } from "./rerun";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const CLEANUP_TABLES = [
  "action_runs",
  "action_run_jobs",
  "action_run_attempts",
  "action_tasks",
  "action_artifacts",
  "action_tasks_versions",
  "repo_units",
  "repositories",
  "users",
];

beforeEach(async () => {
  for (const table of CLEANUP_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

const REPO_ID = "repo-rerun";
const WORKFLOW_ID = ".github/workflows/ci.yml";
const PAYLOAD = new TextEncoder().encode("jobs: {}\n");
const USER_ID = 7;
const T0 = new Date(1_700_000_000 * 1000);

async function seedRepo(): Promise<string> {
  await db().insert(users).values({
    id: USER_ID,
    username: "alice",
    usernameLower: "alice",
    status: "active",
    createdAt: T0,
  });
  await db().insert(repositories).values({
    id: REPO_ID,
    storageKey: `r_${REPO_ID}`,
    ownerNamespace: "alice",
    ownerId: USER_ID,
    slug: "demo",
    visibility: "public",
  });
  await db().insert(repoUnits).values({ repoId: REPO_ID, type: "actions" });
  return REPO_ID;
}

async function seedRun(
  index: number,
  jobs: Array<{ jobId: string; needs?: string[] }>,
): Promise<{ runId: number; attemptId: number; jobIds: number[] }> {
  const { run, attempt, jobRows } = await insertActionRun(
    env.DB,
    {
      repoId: REPO_ID,
      ownerId: USER_ID,
      workflowId: WORKFLOW_ID,
      index,
      triggerUserId: USER_ID,
      ref: "refs/heads/main",
      commitSha: "ccccdddddddddddddddddddddddddddddddddddd",
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
    },
    jobs.map((job) => ({ jobId: job.jobId, needs: job.needs, workflowPayload: PAYLOAD })),
  );
  return { runId: run.id, attemptId: attempt.id, jobIds: jobRows.map((j) => j.id) };
}

/** Force the run + its attempt onto a done status and the attempt's jobs onto
 *  per-job terminal shapes (taskId/started/stopped for the pass-through
 *  pins). */
async function finishRun(
  runId: number,
  attemptId: number,
  runStatus: number,
  jobs: Array<{ id: number; status: number; taskId?: number; started?: Date; stopped?: Date }>,
): Promise<void> {
  await db().update(actionRuns).set({ status: runStatus }).where(eq(actionRuns.id, runId));
  await db().update(actionRunAttempts).set({ status: runStatus }).where(eq(actionRunAttempts.id, attemptId));
  for (const job of jobs) {
    await db()
      .update(actionRunJobs)
      .set({
        status: job.status,
        ...(job.taskId !== undefined ? { taskId: job.taskId } : {}),
        started: job.started ?? null,
        stopped: job.stopped ?? null,
      })
      .where(eq(actionRunJobs.id, job.id));
  }
}

async function jobsOfRun(runId: number) {
  return db().select().from(actionRunJobs).where(eq(actionRunJobs.runId, runId));
}

async function attemptsOfRun(runId: number) {
  return db().select().from(actionRunAttempts).where(eq(actionRunAttempts.runId, runId));
}

async function runRow(runId: number) {
  const rows = await db().select().from(actionRuns).where(eq(actionRuns.id, runId));
  return rows[0]!;
}

describe("GetFailedJobsForRerun (rerun.go:26-36)", () => {
  it("selects the failed AND cancelled jobs only", () => {
    const mk = (id: number, status: number) => ({ id, status }) as never;
    const jobs = [
      mk(1, ACTION_STATUS_SUCCESS),
      mk(2, ACTION_STATUS_FAILURE),
      mk(3, ACTION_STATUS_CANCELLED),
      mk(4, 4 /* skipped */),
      mk(5, ACTION_STATUS_WAITING),
    ];
    const failed = getFailedJobsForRerun(jobs);
    expect(failed.map((job) => job.id)).toEqual([2, 3]);
  });
});

describe("rerun-all (RerunWorkflowRunJobs with the empty set — rerun.go:39, 403-412)", () => {
  it("creates attempt 2, resets EVERY job (waiting; needs → pending), and moves latest_attempt_id", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }, { jobId: "test", needs: ["build"] }]);
    await finishRun(seeded.runId, seeded.attemptId, ACTION_STATUS_FAILURE, [
      { id: seeded.jobIds[0]!, status: ACTION_STATUS_SUCCESS, taskId: 42, started: T0, stopped: new Date(T0.getTime() + 1000) },
      { id: seeded.jobIds[1]!, status: ACTION_STATUS_FAILURE },
    ]);

    const result = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The new attempt linkage: attempt 2, latest_attempt_id moved, the run's
    // id/index unchanged (a rerun is a new ATTEMPT, not a new run).
    expect(result.attempt.attempt).toBe(2);
    expect(result.attempt.runId).toBe(seeded.runId);
    const run = await runRow(seeded.runId);
    expect(run.latestAttemptId).toBe(result.attempt.id);
    expect(run.index).toBe(1);
    expect((await attemptsOfRun(seeded.runId)).length).toBe(2);

    // The new jobs: every job resets — the needs-less one waits, the
    // dependent one pends (rerun.go:289-292); taskId/sourceTaskId cleared,
    // timing cleared, the template's attempt_job_id carries over.
    const jobs = await jobsOfRun(seeded.runId);
    const attempt2Jobs = jobs.filter((job) => job.runAttemptId === result.attempt.id);
    expect(attempt2Jobs).toHaveLength(2);
    const newBuild = attempt2Jobs.find((job) => job.jobId === "build")!;
    const newTest = attempt2Jobs.find((job) => job.jobId === "test")!;
    expect(newBuild.status).toBe(ACTION_STATUS_WAITING);
    expect(newBuild.taskId).toBe(0);
    expect(newBuild.sourceTaskId).toBe(0);
    expect(newBuild.started).toBeNull();
    expect(newBuild.stopped).toBeNull();
    expect(newTest.status).toBe(ACTION_STATUS_PENDING);
    // The attempt_job_id backfill (the M1a rows carry 0; rerun.go:615's
    // ordinal shape) — ordinals 1..n by row id, reused by the clones.
    expect(newBuild.attemptJobId).toBe(1);
    expect(newTest.attemptJobId).toBe(2);

    // The OLD rows are untouched: attempt 1 keeps its terminal rows.
    const attempt1Jobs = jobs.filter((job) => job.runAttemptId === seeded.attemptId);
    expect(attempt1Jobs).toHaveLength(2);
    const oldBuild = attempt1Jobs.find((job) => job.jobId === "build")!;
    expect(oldBuild.status).toBe(ACTION_STATUS_SUCCESS);
    expect(oldBuild.taskId).toBe(42);
    const attempt1 = (await db().select().from(actionRunAttempts).where(eq(actionRunAttempts.id, seeded.attemptId)))[0]!;
    expect(attempt1.status).toBe(ACTION_STATUS_FAILURE);

    // The attempt aggregate + the run mirror (rerun.go:367-369):
    const attempt2Row = (await db().select().from(actionRunAttempts).where(eq(actionRunAttempts.id, result.attempt.id)))[0]!;
    expect(attempt2Row.status).toBe(ACTION_STATUS_WAITING);
    expect(run.status).toBe(ACTION_STATUS_WAITING);
  });

  it("bumps the dispatch counter when waiting work remains (rerun.go:372-376)", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }]);
    await finishRun(seeded.runId, seeded.attemptId, ACTION_STATUS_FAILURE, [
      { id: seeded.jobIds[0]!, status: ACTION_STATUS_FAILURE },
    ]);
    const before = (await db().select().from(actionTasksVersions).where(eq(actionTasksVersions.repoId, REPO_ID)))[0]!;
    const result = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID, []);
    expect(result.ok).toBe(true);
    const after = (await db().select().from(actionTasksVersions).where(eq(actionTasksVersions.repoId, REPO_ID)))[0]!;
    expect(after.version).toBe(before.version + 1);
  });

  it("rerunning IS an explicit approval (rerun.go:243-245)", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }]);
    await db().update(actionRuns).set({ needApproval: true }).where(eq(actionRuns.id, seeded.runId));
    await finishRun(seeded.runId, seeded.attemptId, ACTION_STATUS_FAILURE, [
      { id: seeded.jobIds[0]!, status: ACTION_STATUS_FAILURE },
    ]);
    const result = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID, []);
    expect(result.ok).toBe(true);
    const run = await runRow(seeded.runId);
    expect(run.needApproval).toBe(false);
    expect(run.approvedBy).toBe(USER_ID);
  });
});

describe("rerun-failed (GetFailedJobsForRerun's set — view.go:1002-1008)", () => {
  it("resets ONLY the failed/cancelled jobs; the succeeded job passes through with its history", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [
      { jobId: "build" },
      { jobId: "test", needs: ["build"] },
      { jobId: "deploy", needs: ["test"] },
    ]);
    await finishRun(seeded.runId, seeded.attemptId, ACTION_STATUS_FAILURE, [
      { id: seeded.jobIds[0]!, status: ACTION_STATUS_SUCCESS, taskId: 42, started: T0, stopped: new Date(T0.getTime() + 1000) },
      { id: seeded.jobIds[1]!, status: ACTION_STATUS_FAILURE, taskId: 43, started: T0, stopped: new Date(T0.getTime() + 2000) },
      { id: seeded.jobIds[2]!, status: ACTION_STATUS_CANCELLED },
    ]);

    const templateJobs = await jobsOfRun(seeded.runId);
    const failedJobs = getFailedJobsForRerun(
      templateJobs.filter((job) => job.runAttemptId === seeded.attemptId),
    );
    expect(failedJobs.map((job) => job.jobId).sort()).toEqual(["deploy", "test"]);

    const result = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID, failedJobs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const attempt2Jobs = (await jobsOfRun(seeded.runId)).filter((job) => job.runAttemptId === result.attempt.id);
    expect(attempt2Jobs).toHaveLength(3); // every job clones — nothing is skipped

    // The rerun-set jobs reset (rerun.go:289-292): a job with a non-empty
    // needs list pends; deploy's needs ["test"] pend it too.
    const newTest = attempt2Jobs.find((job) => job.jobId === "test")!;
    const newDeploy = attempt2Jobs.find((job) => job.jobId === "deploy")!;
    expect(newTest.status).toBe(ACTION_STATUS_PENDING); // needs build
    expect(newDeploy.status).toBe(ACTION_STATUS_PENDING); // needs test
    expect(newTest.sourceTaskId).toBe(0);
    expect(newTest.started).toBeNull();

    // The pass-through job (rerun.go:325-332): terminal status, timing and
    // the source task preserved; taskId cleared.
    const newBuild = attempt2Jobs.find((job) => job.jobId === "build")!;
    expect(newBuild.status).toBe(ACTION_STATUS_SUCCESS);
    expect(newBuild.taskId).toBe(0);
    expect(newBuild.sourceTaskId).toBe(42); // EffectiveTaskID (run_job.go:158-163)
    expect(newBuild.started).toEqual(T0);
    expect(newBuild.stopped).toEqual(new Date(T0.getTime() + 1000));
  });
});

describe("the artifact-inheritance chain (run_attempt.go:104-148 — the board's v1.3.1 addition)", () => {
  it("a partial rerun's attempts read through: rerun-set jobs and pass-through jobs both reach the succeeded artifacts", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }, { jobId: "test", needs: ["build"] }]);
    await finishRun(seeded.runId, seeded.attemptId, ACTION_STATUS_FAILURE, [
      { id: seeded.jobIds[0]!, status: ACTION_STATUS_SUCCESS, taskId: 42 },
      { id: seeded.jobIds[1]!, status: ACTION_STATUS_FAILURE },
    ]);
    // The succeeded job's artifact (uploaded under attempt 1).
    await db().insert(actionArtifacts).values({
      runId: seeded.runId,
      runAttemptId: seeded.attemptId,
      repoId: REPO_ID,
      ownerId: USER_ID,
      artifactName: "dist",
      artifactPath: "dist/",
      fileSize: 10,
      status: 2 /* upload-confirmed */,
      created: T0,
      updated: T0,
    });

    const templateJobs = (await jobsOfRun(seeded.runId)).filter((job) => job.runAttemptId === seeded.attemptId);
    const failedJobs = getFailedJobsForRerun(templateJobs);
    const result = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID, failedJobs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Attempt 1's own job reads only its own attempt (run_attempt.go:105-107).
    expect(await getArtifactAttemptIds(env.DB, templateJobs[0]!)).toEqual([seeded.attemptId]);

    // BOTH attempt-2 jobs reach attempt 1's artifacts: attempt 2 is a
    // pass-through attempt (its build clone carries the source task), so the
    // newest-first walk continues past it (run_attempt.go:122-133).
    const attempt2Jobs = (await jobsOfRun(seeded.runId)).filter((job) => job.runAttemptId === result.attempt.id);
    const newBuild = attempt2Jobs.find((job) => job.jobId === "build")!;
    const newTest = attempt2Jobs.find((job) => job.jobId === "test")!;
    expect(await getArtifactAttemptIds(env.DB, newBuild)).toEqual([result.attempt.id, seeded.attemptId]);
    expect(await getArtifactAttemptIds(env.DB, newTest)).toEqual([result.attempt.id, seeded.attemptId]);
  });

  it("a FULL rerun starts over: the chain stops at the new attempt (source_task_id 0 rows)", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }, { jobId: "test", needs: ["build"] }]);
    await finishRun(seeded.runId, seeded.attemptId, ACTION_STATUS_FAILURE, [
      { id: seeded.jobIds[0]!, status: ACTION_STATUS_SUCCESS, taskId: 42 },
      { id: seeded.jobIds[1]!, status: ACTION_STATUS_FAILURE },
    ]);
    await db().insert(actionArtifacts).values({
      runId: seeded.runId,
      runAttemptId: seeded.attemptId,
      repoId: REPO_ID,
      ownerId: USER_ID,
      artifactName: "dist",
      artifactPath: "dist/",
      fileSize: 10,
      status: 2,
      created: T0,
      updated: T0,
    });

    const result = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Attempt 2 passed no job through (every row reset, source_task_id 0) —
    // the walk stops there (run_attempt.go:128-131).
    const attempt2Jobs = (await jobsOfRun(seeded.runId)).filter((job) => job.runAttemptId === result.attempt.id);
    for (const job of attempt2Jobs) {
      expect(await getArtifactAttemptIds(env.DB, job)).toEqual([result.attempt.id]);
    }
  });
});

describe("the downstream-needs expansion (rerun.go:441-454 — the job-level rerun's reach)", () => {
  it("rerunning a job re-runs its transitive dependents; a leaf rerun stays a leaf", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [
      { jobId: "a" },
      { jobId: "b", needs: ["a"] },
      { jobId: "c", needs: ["b"] },
    ]);
    await finishRun(seeded.runId, seeded.attemptId, ACTION_STATUS_FAILURE, [
      { id: seeded.jobIds[0]!, status: ACTION_STATUS_FAILURE },
      { id: seeded.jobIds[1]!, status: ACTION_STATUS_CANCELLED },
      { id: seeded.jobIds[2]!, status: ACTION_STATUS_CANCELLED },
    ]);

    const templateJobs = (await jobsOfRun(seeded.runId)).filter((job) => job.runAttemptId === seeded.attemptId);
    const jobA = templateJobs.find((job) => job.jobId === "a")!;

    // Rerunning the ROOT pulls the whole chain.
    const root = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID, [jobA]);
    expect(root.ok).toBe(true);
    if (root.ok) {
      const attempt2Jobs = (await jobsOfRun(seeded.runId)).filter((job) => job.runAttemptId === root.attempt.id);
      for (const job of attempt2Jobs) {
        expect([ACTION_STATUS_WAITING, ACTION_STATUS_PENDING]).toContain(job.status); // nothing pass-through
      }
    }

    // Rerunning the LEAF resets only the leaf (a/b clone pass-through).
    const run = await runRow(seeded.runId);
    const latestJobs = (await jobsOfRun(seeded.runId)).filter((job) => job.runAttemptId === run.latestAttemptId);
    const byJobKey = (key: string) => latestJobs.find((job) => job.jobId === key)!;
    await finishRun(seeded.runId, run.latestAttemptId, ACTION_STATUS_FAILURE, [
      { id: byJobKey("a").id, status: ACTION_STATUS_FAILURE },
      { id: byJobKey("b").id, status: ACTION_STATUS_CANCELLED },
      { id: byJobKey("c").id, status: ACTION_STATUS_CANCELLED },
    ]);
    const rerunC = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID, [byJobKey("c")]);
    expect(rerunC.ok).toBe(true);
    if (rerunC.ok) {
      const attempt3Jobs = (await jobsOfRun(seeded.runId)).filter((job) => job.runAttemptId === rerunC.attempt.id);
      expect(attempt3Jobs.find((job) => job.jobId === "c")!.status).toBe(ACTION_STATUS_PENDING); // c needs b (rerun.go:290-292)
      expect(attempt3Jobs.find((job) => job.jobId === "a")!.status).toBe(ACTION_STATUS_FAILURE); // pass-through
      expect(attempt3Jobs.find((job) => job.jobId === "b")!.status).toBe(ACTION_STATUS_CANCELLED); // pass-through
    }
  });
});

describe("validateRerun's arms (rerun.go:71-117) + the plan guards", () => {
  it("rejects a not-done run (rerun.go:72-74)", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }]);
    const result = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID, []);
    expect(result).toMatchObject({ ok: false, reason: "run-not-done", message: "this workflow run is not done" });
  });

  it("rejects a disabled workflow (rerun.go:100-102)", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }]);
    await finishRun(seeded.runId, seeded.attemptId, ACTION_STATUS_SUCCESS, [
      { id: seeded.jobIds[0]!, status: ACTION_STATUS_SUCCESS },
    ]);
    await saveRepoActionsConfig(env.DB, REPO_ID, {
      ...parseRepoActionsConfig(null),
      disabledWorkflows: [WORKFLOW_ID],
    });
    const result = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID, []);
    expect(result).toMatchObject({
      ok: false,
      reason: "workflow-disabled",
      message: `workflow ${WORKFLOW_ID} is disabled`,
    });
  });

  it("rejects the rerun at MAX_RERUN_ATTEMPTS (rerun.go:104-114, setting/actions.go:17)", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }]);
    await finishRun(seeded.runId, seeded.attemptId, ACTION_STATUS_FAILURE, [
      { id: seeded.jobIds[0]!, status: ACTION_STATUS_FAILURE },
    ]);
    // Seed attempts 2..50 directly (the cap probe reads the LATEST attempt's
    // number) and point the run + its jobs at the last one.
    let latestId = seeded.attemptId;
    for (let attempt = 2; attempt <= MAX_RERUN_ATTEMPTS; attempt++) {
      const inserted = await db()
        .insert(actionRunAttempts)
        .values({ repoId: REPO_ID, runId: seeded.runId, attempt, triggerUserId: USER_ID, status: ACTION_STATUS_FAILURE, created: T0, updated: T0 })
        .returning();
      latestId = inserted[0]!.id;
    }
    await db().update(actionRuns).set({ latestAttemptId: latestId }).where(eq(actionRuns.id, seeded.runId));
    await db().update(actionRunJobs).set({ runAttemptId: latestId }).where(eq(actionRunJobs.runId, seeded.runId));

    const result = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID, []);
    expect(result).toMatchObject({
      ok: false,
      reason: "max-attempts",
      message: `workflow run has reached the maximum of ${MAX_RERUN_ATTEMPTS} attempts`,
    });
  });

  it("rejects a job from another run (rerun.go:81-85)", async () => {
    await seedRepo();
    const first = await seedRun(1, [{ jobId: "build" }]);
    const second = await seedRun(2, [{ jobId: "other" }]);
    await finishRun(first.runId, first.attemptId, ACTION_STATUS_FAILURE, [
      { id: first.jobIds[0]!, status: ACTION_STATUS_FAILURE },
    ]);
    const foreignJob = (await jobsOfRun(second.runId))[0]!;
    const result = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(first.runId), USER_ID, [foreignJob]);
    expect(result).toMatchObject({ ok: false, reason: "job-not-in-run" });
  });

  it("rejects when the latest attempt carries no jobs (rerun.go:168-170)", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }]);
    await finishRun(seeded.runId, seeded.attemptId, ACTION_STATUS_FAILURE, [
      { id: seeded.jobIds[0]!, status: ACTION_STATUS_FAILURE },
    ]);
    await db().delete(actionRunJobs).where(eq(actionRunJobs.runId, seeded.runId));
    const result = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID, []);
    expect(result).toMatchObject({ ok: false, reason: "no-template-jobs", message: "no template jobs" });
  });

  it("rejects a pre-existing next attempt as the 409-class conflict (rerun.go:236-238)", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }]);
    await finishRun(seeded.runId, seeded.attemptId, ACTION_STATUS_FAILURE, [
      { id: seeded.jobIds[0]!, status: ACTION_STATUS_FAILURE },
    ]);
    await db()
      .insert(actionRunAttempts)
      .values({ repoId: REPO_ID, runId: seeded.runId, attempt: 2, triggerUserId: USER_ID, status: ACTION_STATUS_WAITING, created: T0, updated: T0 });
    const result = await rerunWorkflowRunJobs(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID, []);
    expect(result).toMatchObject({
      ok: false,
      reason: "attempt-already-exists",
      message: `workflow run attempt 2 for run ${seeded.runId} already exists`,
    });
  });

  it("rejects a repo mismatch (rerun.go:75-79)", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }]);
    await finishRun(seeded.runId, seeded.attemptId, ACTION_STATUS_FAILURE, [
      { id: seeded.jobIds[0]!, status: ACTION_STATUS_FAILURE },
    ]);
    const result = await rerunWorkflowRunJobs(env.DB, "repo-other", await runRow(seeded.runId), USER_ID, []);
    expect(result).toMatchObject({ ok: false, reason: "repo-mismatch" });
  });
});

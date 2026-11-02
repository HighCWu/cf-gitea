/**
 * The approve service suite (SPEC-0012's C5 run-mutation arm — the
 * run-viewer's approve POST): services/actions/approve.go ported at the
 * v1 stage. Pins: the flip + needs-less BLOCKED release (the needs-carrying
 * job stays for the emitter), the wake + re-aggregate tails, the
 * awaiting-approval skip arms (both polarities), and the repo-mismatch
 * rejection.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { actionRunAttempts, actionRunJobs, actionRuns, actionTasksVersions, repositories, repoUnits, users } from "../../db/schema";
import { ACTION_STATUS_BLOCKED, ACTION_STATUS_FAILURE, ACTION_STATUS_SUCCESS, ACTION_STATUS_WAITING, insertActionRun } from "./model";
import { approveRun, isAwaitingApproval } from "./approve";

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

const REPO_ID = "repo-approve";
const WORKFLOW_ID = ".github/workflows/ci.yml";
const PAYLOAD = new TextEncoder().encode("jobs: {}\n");
const USER_ID = 7;
const APPROVER_ID = 11;
const T0 = new Date(1_700_000_000 * 1000);

async function seedRepo(): Promise<string> {
  await db().insert(users).values([
    { id: USER_ID, username: "alice", usernameLower: "alice", status: "active", createdAt: T0 },
    { id: APPROVER_ID, username: "bob", usernameLower: "bob", status: "active", createdAt: T0 },
  ]);
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
      event: "pull_request",
      eventPayload: "{}",
      triggerEvent: "pull_request",
    },
    jobs.map((job) => ({ jobId: job.jobId, needs: job.needs, workflowPayload: PAYLOAD })),
  );
  return { runId: run.id, attemptId: attempt.id, jobIds: jobRows.map((j) => j.id) };
}

async function runRow(runId: number) {
  const rows = await db().select().from(actionRuns).where(eq(actionRuns.id, runId));
  return rows[0]!;
}

describe("isAwaitingApproval (run.go:84-86)", () => {
  it("is needApproval && !IsDone on both polarities", () => {
    expect(isAwaitingApproval({ needApproval: true, status: ACTION_STATUS_BLOCKED })).toBe(true);
    expect(isAwaitingApproval({ needApproval: true, status: ACTION_STATUS_SUCCESS })).toBe(false);
    expect(isAwaitingApproval({ needApproval: false, status: ACTION_STATUS_BLOCKED })).toBe(false);
  });
});

describe("approveRun (approve.go:25-187 at the v1 stage)", () => {
  it("flips the flag, records the approver, and releases the needs-less BLOCKED job", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }]);
    // The fork-PR posture: the run awaits approval, its jobs sit BLOCKED
    // (the insert's blocked shape).
    await db().update(actionRuns).set({ needApproval: true }).where(eq(actionRuns.id, seeded.runId));
    await db().update(actionRunAttempts).set({ status: ACTION_STATUS_BLOCKED }).where(eq(actionRunAttempts.id, seeded.attemptId));
    await db().update(actionRunJobs).set({ status: ACTION_STATUS_BLOCKED }).where(eq(actionRunJobs.id, seeded.jobIds[0]!));

    const outcome = await approveRun(env.DB, REPO_ID, await runRow(seeded.runId), APPROVER_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.approved).toBe(true);
    expect(outcome.run.needApproval).toBe(false);
    expect(outcome.run.approvedBy).toBe(APPROVER_ID);

    // The release: the needs-less BLOCKED job waits for the runner poll.
    const job = (await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, seeded.jobIds[0]!)))[0]!;
    expect(job.status).toBe(ACTION_STATUS_WAITING);
    // The re-aggregate: the attempt + the run mirror the release.
    const attempt = (await db().select().from(actionRunAttempts).where(eq(actionRunAttempts.id, seeded.attemptId)))[0]!;
    expect(attempt.status).toBe(ACTION_STATUS_WAITING);
    const run = await runRow(seeded.runId);
    expect(run.status).toBe(ACTION_STATUS_WAITING);
  });

  it("leaves needs-carrying BLOCKED jobs for the emitter (approve.go:77)", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }, { jobId: "deploy", needs: ["build"] }]);
    await db().update(actionRuns).set({ needApproval: true }).where(eq(actionRuns.id, seeded.runId));
    for (const id of seeded.jobIds) {
      await db().update(actionRunJobs).set({ status: ACTION_STATUS_BLOCKED }).where(eq(actionRunJobs.id, id));
    }
    await db().update(actionRunAttempts).set({ status: ACTION_STATUS_BLOCKED }).where(eq(actionRunAttempts.id, seeded.attemptId));

    const outcome = await approveRun(env.DB, REPO_ID, await runRow(seeded.runId), APPROVER_ID);
    expect(outcome.ok).toBe(true);
    const jobs = await db().select().from(actionRunJobs).where(eq(actionRunJobs.runId, seeded.runId));
    const byKey = new Map(jobs.map((job) => [job.jobId, job]));
    expect(byKey.get("build")?.status).toBe(ACTION_STATUS_WAITING);
    expect(byKey.get("deploy")?.status).toBe(ACTION_STATUS_BLOCKED);
  });

  it("bumps the dispatch counter only when a job released", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }]);
    await db().update(actionRuns).set({ needApproval: true }).where(eq(actionRuns.id, seeded.runId));
    await db().update(actionRunJobs).set({ status: ACTION_STATUS_BLOCKED }).where(eq(actionRunJobs.id, seeded.jobIds[0]!));

    const before = (await db().select().from(actionTasksVersions).where(eq(actionTasksVersions.repoId, REPO_ID)))[0]!;
    await approveRun(env.DB, REPO_ID, await runRow(seeded.runId), APPROVER_ID);
    const after = (await db().select().from(actionTasksVersions).where(eq(actionTasksVersions.repoId, REPO_ID)))[0]!;
    expect(after.version).toBe(before.version + 1);

    // The skip arm (approve.go:36-38): a second approve is a no-op — no
    // further wake, the approver columns keep the FIRST approver.
    await approveRun(env.DB, REPO_ID, await runRow(seeded.runId), USER_ID);
    const settled = (await db().select().from(actionTasksVersions).where(eq(actionTasksVersions.repoId, REPO_ID)))[0]!;
    expect(settled.version).toBe(after.version);
    const run = await runRow(seeded.runId);
    expect(run.approvedBy).toBe(APPROVER_ID);
  });

  it("skips a run that does not await approval — both polarities (approve.go:36-38)", async () => {
    await seedRepo();
    const neverAwaited = await seedRun(1, [{ jobId: "build" }]);
    const outcomeA = await approveRun(env.DB, REPO_ID, await runRow(neverAwaited.runId), APPROVER_ID);
    expect(outcomeA.ok).toBe(true);
    if (!outcomeA.ok) return;
    expect(outcomeA.approved).toBe(false);
    expect(outcomeA.run.approvedBy).toBe(0);

    // A DONE run that still carries the flag skips too (IsAwaitingApproval's
    // !IsDone half) — and writes nothing.
    const done = await seedRun(2, [{ jobId: "build" }]);
    await db().update(actionRuns).set({ needApproval: true, status: ACTION_STATUS_FAILURE }).where(eq(actionRuns.id, done.runId));
    const outcomeB = await approveRun(env.DB, REPO_ID, await runRow(done.runId), APPROVER_ID);
    expect(outcomeB.ok).toBe(true);
    if (!outcomeB.ok) return;
    expect(outcomeB.approved).toBe(false);
    const untouched = await runRow(done.runId);
    expect(untouched.approvedBy).toBe(0);
    expect(untouched.needApproval).toBe(true);
    expect(untouched.status).toBe(ACTION_STATUS_FAILURE);
  });

  it("rejects a run outside the caller's repo (approve.go:32's repo-scoped read)", async () => {
    await seedRepo();
    const seeded = await seedRun(1, [{ jobId: "build" }]);
    const outcome = await approveRun(env.DB, "repo-other", await runRow(seeded.runId), APPROVER_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("repo-mismatch");
    // Nothing wrote.
    const run = await runRow(seeded.runId);
    expect(run.needApproval).toBe(false);
  });
});

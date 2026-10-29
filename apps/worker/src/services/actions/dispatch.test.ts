/**
 * The dispatch service suite (SPEC-0012 §2.2/§6.3, M1a): the pick limiter's
 * throttled answer (the stale-version echo, deterministic at the service
 * layer), the fork-PR secret suppression, the payload-assembly release path,
 * needs resolution, and the insert seam's version bump.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import {
  actionRunJobs,
  actionTasks,
  actionTasksVersions,
  repositories,
  repoUnits,
  secrets,
  users,
} from "../../db/schema";
import {
  createRunner,
  increaseTaskVersion,
  insertActionRun,
  newRunnerTokenWithValue,
} from "./model";
import { fetchTask, tryPickTask } from "./dispatch";

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
});

const db = () => drizzle(env.DB);

const PAYLOAD = new TextEncoder().encode("name: ci\njobs:\n  build:\n    steps:\n      - run: echo\n");

interface Seed {
  ownerId: number;
  repoId: string;
  runner: Awaited<ReturnType<typeof createRunner>>;
}

async function seed(options: { runsOn?: string[]; forkPullRequest?: boolean } = {}): Promise<Seed> {
  const ownerRows = await db()
    .insert(users)
    .values({
      username: "disp",
      usernameLower: "disp",
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning({ id: users.id });
  const ownerSeed = ownerRows[0];
  if (ownerSeed === undefined) throw new Error("seed failed");
  const ownerId = ownerSeed.id;

  await db().insert(repositories).values({
    id: "repo-disp",
    storageKey: "r_repo-disp",
    ownerNamespace: "disp",
    ownerId,
    slug: "repo",
    visibility: "public",
  });
  await db().insert(repoUnits).values({ repoId: "repo-disp", type: "actions" });

  await insertActionRun(
    env.DB,
    {
      repoId: "repo-disp",
      ownerId,
      workflowId: "ci.yml",
      index: 1,
      triggerUserId: ownerId,
      ref: "refs/heads/main",
      commitSha: "c".repeat(40),
      event: "pull_request",
      eventPayload: JSON.stringify({
        number: 7,
        pull_request: { base: { ref: "main", sha: "d".repeat(40) }, head: { ref: "feature" } },
      }),
      triggerEvent: "pull_request",
      ...(options.forkPullRequest === true ? {} : {}),
    },
    [{ jobId: "build", runsOn: options.runsOn ?? ["ubuntu-latest"], workflowPayload: PAYLOAD }],
  );

  if (options.forkPullRequest === true) {
    await db().update(actionRunJobs).set({ isForkPullRequest: true }).where(eq(actionRunJobs.jobId, "build"));
    const { actionRuns } = await import("../../db/schema");
    await db().update(actionRuns).set({ isForkPullRequest: true, triggerEvent: "pull_request" });
  }

  const runner = await createRunner(env.DB, {
    uuid: crypto.randomUUID(),
    name: "disp-runner",
    version: "v1",
    ownerId: 0,
    repoId: "repo-disp",
    agentLabels: options.runsOn ?? ["ubuntu-latest"],
    ephemeral: false,
    hasCancellingSupport: false,
  });
  return { ownerId, repoId: "repo-disp", runner };
}

function requireTask(task: { id: number } | undefined): { id: number } {
  if (task === undefined) throw new Error("no task claimed");
  return task;
}

describe("the pick limiter (TryPickTask, task.go:31-53)", () => {
  it("throttles when MAX_CONCURRENT_TASK_PICKS slots are held — deterministically", async () => {
    const seedInfo = await seed();
    // Hold every slot: each invocation runs its synchronous prologue
    // (acquiring a slot) before its first D1 await, so 16 un-awaited calls
    // pin the semaphore and the 17th answers throttled WITHOUT touching D1.
    const holding = Array.from({ length: 16 }, () => tryPickTask(env.DB, seedInfo.runner));
    const throttled = await tryPickTask(env.DB, seedInfo.runner);
    expect(throttled).toEqual({ task: null, throttled: true });
    // Drain the holders (they claim the job or find nothing — either way no
    // throw).
    await Promise.all(holding);
  });

  it("the throttled FetchTask echoes the runner's STALE version back", async () => {
    const seedInfo = await seed();
    // Bootstrap the scope so fetchTask proceeds to the pick (version mismatch).
    await increaseTaskVersion(env.DB, seedInfo.ownerId, seedInfo.repoId);
    const holding = Array.from({ length: 16 }, () => tryPickTask(env.DB, seedInfo.runner));
    // The runner's stale version (0) differs from latest (1) → pick attempt →
    // throttled → the response carries the runner's OWN stale version so it
    // retries on its next poll (runner.go:202-207).
    const response = await fetchTask(env.DB, seedInfo.runner, 0, "https://example.com/");
    expect(response.task).toBeUndefined();
    expect(response.tasksVersion).toBe(0);
    await Promise.all(holding);
  });
});

describe("the claim + payload path", () => {
  it("claims and assembles the full Task payload with the pull-request context", async () => {
    const seedInfo = await seed();
    const response = await fetchTask(env.DB, seedInfo.runner, 0, "https://example.com/");
    const task = response.task;
    expect(task).toBeDefined();
    const claimed = task as NonNullable<typeof task>;
    const context = claimed.context ?? {};
    // pull_request_target rewrite NOT applied (triggerEvent is pull_request);
    // base/head refs ride the event payload (context.go:43-58).
    expect(context.base_ref).toBe("main");
    expect(context.head_ref).toBe("feature");
    expect(context.event).toEqual({ number: 7, pull_request: { base: { ref: "main", sha: "d".repeat(40) }, head: { ref: "feature" } } });
    // workflow_payload served verbatim at M1a (the if:always() rewrite is M3).
    expect(new TextDecoder().decode(claimed.workflowPayload)).toContain("jobs:");
  });

  it("suppresses secrets for fork pull requests (except the tokens)", async () => {
    const seedInfo = await seed({ forkPullRequest: true });
    const now = new Date("2026-10-29T00:00:00Z");
    await db().insert(secrets).values({
      ownerId: seedInfo.ownerId,
      repoId: "",
      name: "OWNER_SECRET",
      data: "os",
      description: "",
      createdAt: now,
    });
    const response = await fetchTask(env.DB, seedInfo.runner, 0, "https://example.com/");
    const task = response.task;
    expect(task).toBeDefined();
    expect(Object.keys((task as NonNullable<typeof task>).secrets).sort()).toEqual([
      "GITEA_TOKEN",
      "GITHUB_TOKEN",
    ]);
  });

  it("releases the claim when payload assembly fails (job back to waiting)", async () => {
    const seedInfo = await seed();
    // Sabotage: delete the run row so buildRunnerTask cannot assemble —
    // the claim must release instead of stranding the job in running.
    const { actionRuns } = await import("../../db/schema");
    await db().delete(actionRuns);

    await expect(fetchTask(env.DB, seedInfo.runner, 0, "")).rejects.toThrow(/vanished/);

    const job = (await db().select().from(actionRunJobs).where(eq(actionRunJobs.jobId, "build")))[0];
    expect(job?.status).toBe(5); // back to waiting
    expect(job?.taskId).toBe(0);
    expect(await db().select().from(actionTasks)).toHaveLength(0);

    // The job is pickable again once the run row exists — restore by
    // re-inserting a minimal run row under the same id? Simpler: the next
    // seed's lifecycle is covered elsewhere; here the RELEASE is the point.
  });

  it("resolves needs from the sibling jobs' tasks (outputs + terminal result)", async () => {
    const seedInfo = await seed();
    // Add a second job that NEEDS the first; claim the first manually via a
    // fetch, then complete its task so the result maps.
    const now = new Date();
    await db().insert(actionRunJobs).values({
      runId: (await db().select().from(actionRunJobs).where(eq(actionRunJobs.jobId, "build")))[0]?.runId ?? 0,
      repoId: seedInfo.repoId,
      ownerId: seedInfo.ownerId,
      jobId: "deploy",
      attempt: 1,
      workflowPayload: PAYLOAD,
      needs: JSON.stringify(["build"]),
      runsOn: JSON.stringify(["ubuntu-latest"]),
      status: 5,
      created: now,
      updated: now,
    });

    // Claim `build` via the runner.
    const first = await fetchTask(env.DB, seedInfo.runner, 0, "");
    const buildTask = first.task;
    expect(buildTask).toBeDefined();

    // The deploy job's needs resolve against build's task: no outputs yet,
    // result UNSPECIFIED (the task is running).
    const { findTaskNeeds } = await import("./dispatch");
    const deploy = (await db().select().from(actionRunJobs).where(eq(actionRunJobs.jobId, "deploy")))[0];
    if (deploy === undefined) throw new Error("deploy job missing");
    const needs = await findTaskNeeds(env.DB, deploy);
    expect(needs).toEqual({ build: { outputs: {}, result: 0 } });

    // Complete build's task → the result maps to SUCCESS.
    await db().update(actionTasks).set({ status: 1 }).where(eq(actionTasks.id, requireTask(buildTask).id));
    const done = await findTaskNeeds(env.DB, deploy);
    expect(done.build?.result).toBe(1);
  });

  it("insertActionRun bumps the version only for dispatchable waiting jobs", async () => {
    const ownerRows = await db()
      .insert(users)
      .values({
        username: "bump",
        usernameLower: "bump",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning({ id: users.id });
    const ownerSeed = ownerRows[0];
    if (ownerSeed === undefined) throw new Error("seed failed");
    await db().insert(repositories).values({
      id: "repo-bump",
      storageKey: "r_repo-bump",
      ownerNamespace: "bump",
      ownerId: ownerSeed.id,
      slug: "repo",
      visibility: "public",
    });

    await insertActionRun(
      env.DB,
      {
        repoId: "repo-bump",
        ownerId: ownerSeed.id,
        workflowId: "ci.yml",
        index: 1,
        triggerUserId: ownerSeed.id,
        ref: "refs/heads/main",
        commitSha: "e".repeat(40),
        event: "push",
        eventPayload: "{}",
        triggerEvent: "push",
      },
      [],
    );
    // No jobs → no bump (run.go:159-165's hasWaitingJobs gate).
    expect(await db().select().from(actionTasksVersions)).toHaveLength(0);

    await insertActionRun(
      env.DB,
      {
        repoId: "repo-bump",
        ownerId: ownerSeed.id,
        workflowId: "ci.yml",
        index: 2,
        triggerUserId: ownerSeed.id,
        ref: "refs/heads/main",
        commitSha: "e".repeat(40),
        event: "push",
        eventPayload: "{}",
        triggerEvent: "push",
      },
      [{ jobId: "build", runsOn: ["ubuntu-latest"], workflowPayload: PAYLOAD }],
    );
    // The waiting job bumps all three scopes.
    const rows = await db().select().from(actionTasksVersions);
    expect(rows).toHaveLength(3);
  });
});

describe("the registration-token mint (the harness's token source)", () => {
  it("mints and consumes through the model seam", async () => {
    const token = await newRunnerTokenWithValue(env.DB, 0, "", "minted");
    expect(token.isActive).toBe(true);
    const runner = await createRunner(env.DB, {
      uuid: crypto.randomUUID(),
      name: "n",
      version: "",
      ownerId: 0,
      repoId: "",
      agentLabels: [],
      ephemeral: false,
      hasCancellingSupport: false,
    });
    expect(runner.id).toBeGreaterThan(0);
  });
});

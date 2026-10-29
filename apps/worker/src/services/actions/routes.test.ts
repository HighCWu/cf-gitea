/**
 * The /api/actions runner-protocol suite (SPEC-0012 §6.2/§6.3, M1a) — the
 * fake-runner harness (the ratified E2E oracle) drives the REAL mounted app
 * over HTTP in workerd:
 *
 *   ping echo → register (minted token; the reusable-token posture; the
 *   invalidated-token answer) → declare (labels/version persist; the
 *   X-Gitea-Actions-Capabilities header) → FetchTask's version-counter
 *   semantics (first fetch bootstraps 0→1, no-task answers carry the latest
 *   version, unauthenticated/unknown-runner 401s) → the claim round-trip
 *   (a seeded waiting job is picked with the full Task payload, the job CAS
 *   flips, a second runner gets nothing).
 */

import { applyD1Migrations, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import {
  actionRunJobs,
  actionRunners,
  actionRuns,
  actionTasks,
  actionTasksVersions,
  repositories,
  repoUnits,
  users,
} from "../../db/schema";
import {
  insertActionRun,
  newRunnerTokenWithValue,
  verifyRunnerToken,
} from "./model";
import { FakeRunner } from "./fake-runner";

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
const BASE_URL = "https://example.com";

const makeRunner = (): FakeRunner =>
  new FakeRunner({
    baseUrl: BASE_URL,
    fetch: (...args: Parameters<typeof SELF.fetch>) => SELF.fetch(...args),
  });

// vitest's expect.* builders type as `any` — sink them through unknown once.
const containing = (text: string): unknown => expect.stringContaining(text);
const anyNumber = (): unknown => expect.any(Number);
const anyString = (): unknown => expect.any(String);
const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);

/** FakeRunner.runner with the undefined case thrown (the tests always run a
 *  registered runner when they touch this). */
function requireRunner(runner: FakeRunner) {
  const registered = runner.runner;
  if (registered === undefined) throw new Error("runner not registered");
  return registered;
}

function requireUuid(registered: FakeRunner["runner"]): string {
  if (registered === undefined) throw new Error("runner not registered");
  return registered.uuid;
}

function requireTaskId(claimed: { id: number } | undefined): number {
  if (claimed === undefined) throw new Error("no task claimed");
  return claimed.id;
}

const WORKFLOW_PAYLOAD = new TextEncoder().encode(
  'name: ci\njobs:\n  build:\n    if: always()\n    steps:\n      - run: echo hi\n',
);

async function seedRepoWithJob(options: {
  repoId: string;
  slug: string;
  runsOn: string[];
  jobId?: string;
  needs?: string[];
  withUnit?: boolean;
}): Promise<{ runId: number; jobIndex: number }> {
  const owner = await db()
    .insert(users)
    .values({
      username: `owner-${options.repoId}`,
      usernameLower: `owner-${options.repoId}`,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning({ id: users.id });
  const ownerSeed = owner[0];
  if (ownerSeed === undefined) throw new Error("owner seed failed");
  const ownerId = ownerSeed.id;
  await db().insert(repositories).values({
    id: options.repoId,
    storageKey: `r_${options.repoId}`,
    ownerNamespace: "owner",
    ownerId,
    slug: options.slug,
    visibility: "public",
  });
  if (options.withUnit !== false) {
    await db().insert(repoUnits).values({ repoId: options.repoId, type: "actions" });
  }
  const { run } = await insertActionRun(
    env.DB,
    {
      repoId: options.repoId,
      ownerId,
      workflowId: ".gitea/workflows/ci.yml",
      index: 1,
      triggerUserId: ownerId,
      ref: "refs/heads/main",
      commitSha: "a".repeat(40),
      event: "push",
      eventPayload: JSON.stringify({ ref: "refs/heads/main", number: 1 }),
      triggerEvent: "push",
      title: "ci",
    },
    [
      {
        jobId: options.jobId ?? "build",
        needs: options.needs ?? [],
        runsOn: options.runsOn,
        workflowPayload: WORKFLOW_PAYLOAD,
      },
    ],
  );
  return { runId: run.id, jobIndex: 0 };
}

async function jobRow(jobId: string) {
  const rows = await db().select().from(actionRunJobs).where(eq(actionRunJobs.jobId, jobId));
  const row = rows[0];
  if (row === undefined) throw new Error("job row missing");
  return row;
}

// ---------------------------------------------------------------------------
// Ping
// ---------------------------------------------------------------------------

describe("POST /api/actions/ping.v1.PingService/Ping", () => {
  it("echoes the upstream greeting", async () => {
    const runner = makeRunner();
    await expect(runner.ping("world")).resolves.toBe("Hello, world!");
    await expect(runner.ping("")).resolves.toBe("Hello, !");
  });

  it("answers a foreign content-type with the connect 500/unknown shape", async () => {
    const response = await SELF.fetch(`${BASE_URL}/api/actions/ping.v1.PingService/Ping`, {
      method: "POST",
      headers: { "content-type": "application/x-unknown" },
      body: new Uint8Array([0]),
    });
    // The connect spec: an unrecognized Content-Type on a unary procedure
    // answers HTTP 415 (the JSON body is informational).
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ code: "internal", message: containing("unsupported content-type") });
  });
});

// ---------------------------------------------------------------------------
// Register — the reusable-token posture
// ---------------------------------------------------------------------------

describe("POST /api/actions/runner.v1.RunnerService/Register", () => {
  it("registers a runner with a minted token and returns the polling token once", async () => {
    await newRunnerTokenWithValue(env.DB, 0, "", "reg-token");
    const runner = makeRunner();
    const registered = await runner.register({
      token: "reg-token",
      name: "fleet-1",
      version: "act-runner v1",
      labels: ["ubuntu-latest"],
    });
    expect(registered).toMatchObject({
      id: anyNumber(),
      uuid: anyString(),
      token: matching(/^[0-9a-f]{40}$/),
      name: "fleet-1",
      version: "act-runner v1",
      labels: ["ubuntu-latest"],
      ephemeral: false,
    });

    // The row persists with the salted digest — never the plaintext.
    const rows = await db().select().from(actionRunners).where(eq(actionRunners.uuid, requireUuid(registered)));
    const row = rows[0];
    if (row === undefined) throw new Error("runner row missing");
    const registeredRunner = requireRunner(runner);
    expect(await verifyRunnerToken(row.tokenHash, row.tokenSalt, registeredRunner.token)).toBe(true);
    expect(JSON.stringify(row)).not.toContain(registeredRunner.token);
  });

  it("one active token registers a FLEET (reusable-until-reset)", async () => {
    await newRunnerTokenWithValue(env.DB, 0, "", "fleet-token");
    const firstRunner = makeRunner();
    const secondRunner = makeRunner();
    const first = await firstRunner.register({ token: "fleet-token", name: "a" });
    const second = await secondRunner.register({ token: "fleet-token", name: "b" });
    expect(first?.id).not.toBe(second?.id);
  });

  it("answers the upstream error messages for bad tokens", async () => {
    await newRunnerTokenWithValue(env.DB, 0, "", "real-token");
    await newRunnerTokenWithValue(env.DB, 0, "", "real-token-v2"); // reset → first inactive

    // Unknown token.
    const unknown = makeRunner();
    await expect(unknown.register({ token: "nope", name: "n" })).rejects.toMatchObject({
      code: "unknown",
      message: "runner registration token not found",
    });

    // Reset token (inactive).
    const stale = makeRunner();
    await expect(stale.register({ token: "real-token", name: "n" })).rejects.toMatchObject({
      code: "unknown",
      message: "runner registration token has been invalidated, please use the latest one",
    });
    const fresh = await stale.register({ token: "real-token-v2", name: "n" });
    expect(fresh).toMatchObject({ name: "n" });

    // Missing token/name → "missing runner token, name".
    const empty = makeRunner();
    await expect(empty.register({ token: "real-token-v2", name: "" })).rejects.toMatchObject({
      message: "missing runner token, name",
    });
  });

  it("rejects tokens whose owner/repo rows vanished", async () => {
    await seedRepoWithJob({ repoId: "gone-repo", slug: "gone", runsOn: ["x"], withUnit: false });
    await db().delete(repositories).where(eq(repositories.id, "gone-repo"));
    await newRunnerTokenWithValue(env.DB, 0, "gone-repo", "orphan");
    await expect(makeRunner().register({ token: "orphan", name: "n" })).rejects.toMatchObject({
      message: "repository of the token not found",
    });
  });

  it("ellipsizes names past 255 runes", async () => {
    await newRunnerTokenWithValue(env.DB, 0, "", "long-name");
    const longRunner = makeRunner();
    const registered = await longRunner.register({ token: "long-name", name: "x".repeat(300) });
    expect(Array.from(registered?.name ?? "")).toHaveLength(255);
  });
});

// ---------------------------------------------------------------------------
// Declare — the capabilities header + label update
// ---------------------------------------------------------------------------

describe("POST /api/actions/runner.v1.RunnerService/Declare", () => {
  it("persists labels/version and advertises the server capabilities header", async () => {
    await newRunnerTokenWithValue(env.DB, 0, "", "reg");
    const runner = makeRunner();
    await runner.register({ token: "reg", name: "d1", labels: ["old"] });

    const declared = await runner.declare({
      version: "v2",
      labels: ["ubuntu-latest", "with-gpu"],
      capabilities: ["cancelling"],
    });
    const registeredRunner = requireRunner(runner);
    expect(declared).toMatchObject({ id: registeredRunner.id, version: "v2", labels: ["ubuntu-latest", "with-gpu"] });
    expect(runner.serverCapabilities).toBe("job-summary");

    const rows = await db().select().from(actionRunners).where(eq(actionRunners.id, registeredRunner.id));
    const row = rows[0];
    if (row === undefined) throw new Error("runner row missing");
    expect(JSON.parse(row.agentLabels)).toEqual(["ubuntu-latest", "with-gpu"]);
    expect(row.version).toBe("v2");
    expect(row.hasCancellingSupport).toBe(true);
    // The declared runner carries NO plaintext token (the model struct's
    // Token field is xorm:"-" upstream — the response spells it empty).
    expect(declared?.token ?? "").toBe("");
  });

  it("requires the runner headers (unauthenticated 401 shape)", async () => {
    await newRunnerTokenWithValue(env.DB, 0, "", "reg");
    const runner = makeRunner();
    await runner.register({ token: "reg", name: "d2" });

    // No uuid/token headers at all.
    const bare = makeRunner();
    bare.runner = { id: 0, uuid: "", token: "", name: "", status: 0, agentLabels: [], customLabels: [], version: "", labels: [], ephemeral: false };
    await expect(bare.declare({})).rejects.toMatchObject({ code: "unauthenticated" });

    // A WRONG polling token.
    const impostor = makeRunner();
    impostor.runner = { ...requireRunner(runner), token: "0".repeat(40) };
    await expect(impostor.declare({})).rejects.toMatchObject({ code: "unauthenticated" });

    // An unknown UUID.
    const ghost = makeRunner();
    ghost.runner = { ...requireRunner(runner), uuid: "00000000-0000-0000-0000-000000000000" };
    await expect(ghost.declare({})).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

// ---------------------------------------------------------------------------
// FetchTask — the version-counter semantics
// ---------------------------------------------------------------------------

describe("POST /api/actions/runner.v1.RunnerService/FetchTask", () => {
  it("bootstraps the version 0→1 on the first fetch and answers no task", async () => {
    await newRunnerTokenWithValue(env.DB, 0, "", "reg");
    const runner = makeRunner();
    await runner.register({ token: "reg", name: "f1", labels: ["ubuntu-latest"] });

    const first = await runner.fetchTask(0);
    expect(first.task).toBeUndefined();
    expect(first.tasksVersion).toBe(1);

    const rows = await db().select().from(actionTasksVersions);
    expect(rows).toContainEqual(expect.objectContaining({ ownerId: 0, repoId: "", version: 1 }));

    // A synchronized runner (version == latest) gets the plain no-task answer.
    const second = await runner.fetchTask(first.tasksVersion);
    expect(second.task).toBeUndefined();
    expect(second.tasksVersion).toBe(1);
  });

  it("answers the claim payload with context/secrets/vars and flips the job CAS", async () => {
    await db().insert(users).values({
      username: "vars-owner",
      usernameLower: "vars-owner",
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const ownerRow = await db().select({ id: users.id }).from(users).where(eq(users.username, "vars-owner"));
    const ownerSeed = ownerRow[0];
    if (ownerSeed === undefined) throw new Error("owner seed failed");
    const ownerId = ownerSeed.id;

    await db().insert(repositories).values({
      id: "repo-fetch",
      storageKey: "r_repo-fetch",
      ownerNamespace: "vars-owner",
      ownerId,
      slug: "repo",
      visibility: "private",
    });
    await db().insert(repoUnits).values({ repoId: "repo-fetch", type: "actions" });

    const { actionVariables, secrets } = await import("../../db/schema");
    const now = new Date("2026-10-29T00:00:00Z");
    await db().insert(actionVariables).values([
      { ownerId: 0, repoId: "", name: "GLOBAL_VAR", data: "g", description: "", createdAt: now, updatedAt: now },
      { ownerId, repoId: "", name: "OWNER_VAR", data: "o", description: "", createdAt: now, updatedAt: now },
      { ownerId: 0, repoId: "repo-fetch", name: "REPO_VAR", data: "r", description: "", createdAt: now, updatedAt: now },
    ]);
    await db().insert(secrets).values([
      { ownerId, repoId: "", name: "OWNER_SECRET", data: "os", description: "", createdAt: now },
      { ownerId: 0, repoId: "repo-fetch", name: "REPO_SECRET", data: "rs", description: "", createdAt: now },
    ]);

    await insertActionRun(
      env.DB,
      {
        repoId: "repo-fetch",
        ownerId,
        workflowId: ".gitea/workflows/ci.yml",
        index: 1,
        triggerUserId: ownerId,
        ref: "refs/heads/main",
        commitSha: "b".repeat(40),
        event: "push",
        eventPayload: JSON.stringify({ ref: "refs/heads/main" }),
        triggerEvent: "push",
      },
      [{ jobId: "build", runsOn: ["ubuntu-latest"], workflowPayload: WORKFLOW_PAYLOAD }],
    );

    await newRunnerTokenWithValue(env.DB, 0, "repo-fetch", "reg-repo");
    const runner = makeRunner();
    await runner.register({ token: "reg-repo", name: "f2", labels: ["ubuntu-latest"] });

    const claimed = await runner.poll();
    expect(claimed).toBeDefined();
    const task = claimed!;
    expect(task.id).toBeGreaterThan(0);
    expect(new TextDecoder().decode(task.workflowPayload)).toContain("jobs:");

    const context = task.context ?? {};
    expect(context).toMatchObject({
      repository: "vars-owner/repo",
      repository_owner: "vars-owner",
      event_name: "push",
      job: "build",
      run_number: "1",
      run_attempt: "1",
      ref: "refs/heads/main",
      ref_type: "branch",
      ref_name: "main",
      secret_source: "Actions",
      server_url: "https://example.com/",
      api_url: "https://example.com/api/v1",
      workflow: ".gitea/workflows/ci.yml",
      token: anyString(),
    });
    // Level precedence: repo > owner > global.
    expect(task.vars).toEqual({ GLOBAL_VAR: "g", OWNER_VAR: "o", REPO_VAR: "r" });
    expect(task.secrets).toMatchObject({ OWNER_SECRET: "os", REPO_SECRET: "rs" });
    expect(task.secrets.GITHUB_TOKEN).toBeTruthy();
    expect(task.secrets.GITEA_TOKEN).toBe(task.secrets.GITHUB_TOKEN);
    expect(task.needs).toEqual({});

    // The job CAS flipped: one running task row, job claimed, run untouched
    // beyond the waiting status.
    const job = await jobRow("build");
    expect(job.taskId).toBe(task.id);
    expect(job.status).toBe(6); // StatusRunning
    const taskRows = await db().select().from(actionTasks).where(eq(actionTasks.id, task.id));
    const taskRow = taskRows[0];
    if (taskRow === undefined) throw new Error("task row missing");
    expect(taskRow.status).toBe(6);
    expect(taskRow.logFilename).toBe(`vars-owner/repo/${(task.id % 256).toString(16).padStart(2, "0")}/${task.id}.log`);
    const ghToken = task.secrets.GITHUB_TOKEN ?? "";
    expect(ghToken).not.toBe("");
    expect(await verifyRunnerToken(taskRow.tokenHash, taskRow.tokenSalt, ghToken)).toBe(true);

    // The version bumped when the job was inserted: the runner's cached
    // version now matches, and a second fetch finds nothing.
    const again = await runner.poll();
    expect(again).toBeUndefined();
  });

  it("a runner with a stale version retries (no-task answer carries the LATEST version)", async () => {
    await seedRepoWithJob({ repoId: "repo-stale", slug: "stale", runsOn: ["ubuntu-latest"] });
    await newRunnerTokenWithValue(env.DB, 0, "repo-stale", "reg-stale");
    const runner = makeRunner();
    await runner.register({ token: "reg-stale", name: "stale-r", labels: ["ubuntu-latest"] });

    // Someone else's runner claims the only job.
    const other = makeRunner();
    await other.register({ token: "reg-stale", name: "claimer", labels: ["ubuntu-latest"] });
    expect(await other.poll()).toBeDefined();

    // This runner polls with the STALE version 0: mismatch → pick attempt
    // (nothing left) → the answer carries the LATEST version, not the stale
    // one (the stale echo itself is the THROTTLED path, deterministic-tested
    // in dispatch.test.ts).
    const response = await runner.fetchTask(0);
    expect(response.task).toBeUndefined();
    expect(response.tasksVersion).toBeGreaterThan(0);
  });

  it("refuses label-mismatched and disabled runners, and repo scoping holds", async () => {
    await seedRepoWithJob({ repoId: "repo-scope", slug: "scoped", runsOn: ["windows"] });

    // Wrong labels → no claim.
    await newRunnerTokenWithValue(env.DB, 0, "repo-scope", "reg-wrong");
    const wrong = makeRunner();
    await wrong.register({ token: "reg-wrong", name: "wrong", labels: ["ubuntu-latest"] });
    const wrongFetch = await wrong.fetchTask(0);
    expect(wrongFetch.task).toBeUndefined();

    // Right labels → claim.
    const right = makeRunner();
    await right.register({ token: "reg-wrong", name: "right", labels: ["windows"] });
    expect(await right.poll()).toBeDefined();

    // Repo-scoped runners see nothing outside their repo: this runner's own
    // repo holds only a macos-labeled job (label-mismatched for it), while
    // repo-other holds a matching windows job — a broken scope would claim
    // the latter.
    await seedRepoWithJob({ repoId: "repo-other", slug: "other", runsOn: ["windows"] });
    await seedRepoWithJob({ repoId: "repo-unrelated", slug: "unrelated", runsOn: ["macos-latest"] });
    await newRunnerTokenWithValue(env.DB, 0, "repo-unrelated", "reg-unrelated");
    const scoped = makeRunner();
    await scoped.register({ token: "reg-unrelated", name: "scoped", labels: ["windows"] });
    expect(await scoped.poll()).toBeUndefined();
  });

  it("disables cleanly: a disabled runner polls to no task", async () => {
    await seedRepoWithJob({ repoId: "repo-disabled", slug: "disabled", runsOn: ["ubuntu-latest"] });
    await newRunnerTokenWithValue(env.DB, 0, "repo-disabled", "reg-dis");
    const runner = makeRunner();
    await runner.register({ token: "reg-dis", name: "disabled", labels: ["ubuntu-latest"] });
    await db()
      .update(actionRunners)
      .set({ isDisabled: true })
      .where(eq(actionRunners.id, runner.runner!.id));
    const response = await runner.fetchTask(0);
    expect(response.task).toBeUndefined();
  });

  it("races two runners onto one job — exactly one claim wins (the CAS)", async () => {
    await seedRepoWithJob({ repoId: "repo-cas", slug: "cas", runsOn: ["ubuntu-latest"] });
    await newRunnerTokenWithValue(env.DB, 0, "repo-cas", "reg-cas");
    const a = makeRunner();
    const b = makeRunner();
    await a.register({ token: "reg-cas", name: "race-a", labels: ["ubuntu-latest"] });
    await b.register({ token: "reg-cas", name: "race-b", labels: ["ubuntu-latest"] });

    const [ra, rb] = await Promise.all([a.fetchTask(0), b.fetchTask(0)]);
    const claims = [ra.task, rb.task].filter((t) => t !== undefined);
    expect(claims).toHaveLength(1);

    const job = await jobRow("build");
    expect([ra.task?.id ?? 0, rb.task?.id ?? 0]).toContain(job.taskId);
    const taskRows = await db().select().from(actionTasks);
    expect(taskRows).toHaveLength(1);
  });

  it("the ephemeral lifecycle: one task per lifetime, then removal", async () => {
    await seedRepoWithJob({ repoId: "repo-eph", slug: "eph", runsOn: ["ubuntu-latest"] });
    await newRunnerTokenWithValue(env.DB, 0, "repo-eph", "reg-eph");
    const runner = makeRunner();
    await runner.register({ token: "reg-eph", name: "eph", labels: ["ubuntu-latest"], ephemeral: true });

    const claimed = await runner.poll();
    expect(claimed).toBeDefined();

    // While the task lives, the ephemeral runner gets nothing (it retries) —
    // bump the version so the poll attempts a pick and hits the gate.
    const { increaseTaskVersion } = await import("./model");
    await increaseTaskVersion(env.DB, 0, "repo-eph");
    expect(await runner.poll()).toBeUndefined();

    // The task finishes → the runner is removed; the NEXT poll errors.
    await db()
      .update(actionTasks)
      .set({ status: 1, stopped: new Date() })
      .where(eq(actionTasks.id, requireTaskId(claimed)));
    await increaseTaskVersion(env.DB, 0, "repo-eph");
    await expect(runner.poll()).rejects.toMatchObject({
      code: "unknown",
      message: "runner has been removed",
    });
    const rows = await db().select().from(actionRunners).where(eq(actionRunners.id, requireRunner(runner).id));
    expect(rows).toHaveLength(0);
  });

  it("supports the ephemeral-runner declaration in Register", async () => {
    await newRunnerTokenWithValue(env.DB, 0, "", "reg-eph-flag");
    const ephRunner = makeRunner();
    const registered = await ephRunner.register({
      token: "reg-eph-flag",
      name: "eph-flag",
      ephemeral: true,
      capabilities: ["cancelling"],
    });
    expect(registered?.ephemeral).toBe(true);
    const rows = await db().select().from(actionRunners).where(eq(actionRunners.id, registered?.id ?? 0));
    expect(rows[0]?.hasCancellingSupport).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The M1b procedures authenticate, then answer unimplemented
// ---------------------------------------------------------------------------

describe("the M1b procedures (UpdateTask/UpdateLog)", () => {
  it("authenticate via the interceptor, then answer unimplemented", async () => {
    await newRunnerTokenWithValue(env.DB, 0, "", "reg-m1b");
    const runner = makeRunner();
    await runner.register({ token: "reg-m1b", name: "m1b" });

    await expect(runner.fetchTask(0)).resolves.toBeDefined(); // auth works

    const response = await SELF.fetch(`${BASE_URL}/api/actions/runner.v1.RunnerService/UpdateTask`, {
      method: "POST",
      headers: {
        "content-type": "application/proto",
        "x-runner-uuid": requireRunner(runner).uuid,
        "x-runner-token": requireRunner(runner).token,
      },
      body: new Uint8Array([0]),
    });
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ code: "unimplemented", message: containing("M1b") });

    // The heartbeat ran (the interceptor debounced last_online forward).
    const rows = await db().select().from(actionRunners).where(eq(actionRunners.id, requireRunner(runner).id));
    expect(rows[0]?.lastOnline).not.toBeNull();
  });

  it("the runs row family persisted through the seeding seam", async () => {
    const { runId } = await seedRepoWithJob({ repoId: "repo-rows", slug: "rows", runsOn: ["ubuntu-latest"] });
    const runs = await db().select().from(actionRuns).where(eq(actionRuns.id, runId));
    const run = runs[0];
    if (run === undefined) throw new Error("run row missing");
    expect(run.index).toBe(1);
    expect(run.status).toBe(5); // waiting
    expect(run.latestAttemptId).toBeGreaterThan(0);
  });

  it("survives a RunnerProtocolError shape check for a bad body", async () => {
    await newRunnerTokenWithValue(env.DB, 0, "", "reg-badbody");
    const runner = makeRunner();
    await runner.register({ token: "reg-badbody", name: "badbody" });
    const response = await SELF.fetch(`${BASE_URL}/api/actions/runner.v1.RunnerService/FetchTask`, {
      method: "POST",
      headers: {
        "content-type": "application/proto",
        "x-runner-uuid": requireRunner(runner).uuid,
        "x-runner-token": requireRunner(runner).token,
      },
      body: new Uint8Array([0xff]), // garbage wire bytes
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "invalid_argument", message: containing("decode") });
  });
});

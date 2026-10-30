/**
 * The actions model suite (SPEC-0012 §4.1/§6.3, M1a): the registration-token
 * lifecycle (reset deactivates SAME-SCOPE only — the corrected semantics),
 * the tasks_version cascade + self-heal, the token digest model, the
 * heartbeat debounce windows, and the label matcher.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import {
  actionRunnerTokens,
  actionRunJobs,
  actionRunners,
  actionTasksVersions,
  users,
  repositories,
  repoUnits,
} from "../../db/schema";
import {
  canMatchLabels,
  createRunner,
  cryptoRandomToken,
  ellipsisDisplayString,
  getLatestRunnerToken,
  getOrCreateActiveRunnerToken,
  getRunnerTokenByValue,
  getTasksVersionByScope,
  hashRunnerToken,
  increaseTaskVersion,
  newRunnerTokenWithValue,
  scopeRepoCondition,
  shouldPersistLastActive,
  shouldPersistLastOnline,
  statusToResult,
  verifyRunnerToken,
} from "./model";

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

async function seedUser(username: string): Promise<number> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning({ id: users.id });
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  return row.id;
}

async function seedRepo(id: string, ownerNamespace: string, ownerId: number | null, slug: string, withActionsUnit = true): Promise<string> {
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    ownerId,
    slug,
    visibility: "public",
  });
  if (withActionsUnit) {
    await db().insert(repoUnits).values({ repoId: id, type: "actions" });
  }
  return id;
}

describe("runner token lifecycle (runner_token.go port)", () => {
  it("stores the token RAW and finds it by the presented string", async () => {
    const row = await newRunnerTokenWithValue(env.DB, 0, "", "tok-global-1");
    expect(row.token).toBe("tok-global-1");
    expect(row.isActive).toBe(true);
    const found = await getRunnerTokenByValue(env.DB, "tok-global-1");
    expect(found?.id).toBe(row.id);
  });

  it("reset deactivates SAME-SCOPE tokens and leaves other scopes active", async () => {
    const owner = await seedUser("org-one");
    const repo = await seedRepo("repo-1", "org-one", owner, "repo-one");

    // One active token per scope.
    await newRunnerTokenWithValue(env.DB, 0, "", "global-old");
    await newRunnerTokenWithValue(env.DB, owner, "", "owner-old");
    await newRunnerTokenWithValue(env.DB, 0, repo, "repo-old");

    // Reset the REPO scope — the SPEC's corrected semantics: create-new +
    // deactivate-old, one transaction, other scopes untouched.
    await newRunnerTokenWithValue(env.DB, 0, repo, "repo-new");
    expect((await getRunnerTokenByValue(env.DB, "repo-old"))?.isActive).toBe(false);
    expect((await getRunnerTokenByValue(env.DB, "repo-new"))?.isActive).toBe(true);
    expect((await getRunnerTokenByValue(env.DB, "global-old"))?.isActive).toBe(true);
    expect((await getRunnerTokenByValue(env.DB, "owner-old"))?.isActive).toBe(true);

    // Reset the GLOBAL scope — the repo token stays active.
    await newRunnerTokenWithValue(env.DB, 0, "", "global-new");
    expect((await getRunnerTokenByValue(env.DB, "repo-new"))?.isActive).toBe(true);
    expect((await getRunnerTokenByValue(env.DB, "global-old"))?.isActive).toBe(false);

    // The repo-scoped token row carries ownerId 0 (the normalizeTokenScope
    // rule: a repo token never carries an owner).
    const all = await db()
      .select()
      .from(actionRunnerTokens)
      .where(and(eq(actionRunnerTokens.repoId, repo), eq(actionRunnerTokens.isActive, true)));
    expect(all).toHaveLength(1);
    expect(all[0]?.ownerId).toBe(0);
  });

  it("getLatestRunnerToken orders by id DESC within the scope", async () => {
    const owner = await seedUser("org-two");
    await newRunnerTokenWithValue(env.DB, owner, "", "first");
    await newRunnerTokenWithValue(env.DB, owner, "", "second");
    const latest = await getLatestRunnerToken(env.DB, owner, "");
    expect(latest?.token).toBe("second");
  });

  it("getOrCreateActiveRunnerToken reuses the active latest, mints after reset", async () => {
    const owner = await seedUser("org-three");
    const first = await getOrCreateActiveRunnerToken(env.DB, owner, "");
    const again = await getOrCreateActiveRunnerToken(env.DB, owner, "");
    expect(again.id).toBe(first.id);

    // Reset (deactivate) directly, then the next call mints a fresh one.
    await db()
      .update(actionRunnerTokens)
      .set({ isActive: false })
      .where(eq(actionRunnerTokens.id, first.id));
    const fresh = await getOrCreateActiveRunnerToken(env.DB, owner, "");
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.isActive).toBe(true);
  });
});

describe("the token digest model (SPEC-0002 sha256-hex at rest, salted)", () => {
  it("hashes deterministically and verifies constant-time", async () => {
    const digest = await hashRunnerToken("token", "salt");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashRunnerToken("token", "salt")).toBe(digest);
    expect(await hashRunnerToken("token", "other")).not.toBe(digest);
    expect(await verifyRunnerToken(digest, "salt", "token")).toBe(true);
    expect(await verifyRunnerToken(digest, "salt", "wrong")).toBe(false);
  });

  it("mints 40-hex-char tokens from 20 random bytes", () => {
    const token = cryptoRandomToken(20);
    expect(token).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("tasks_version (tasks_version.go port)", () => {
  it("reads 0 for a missing scope row", async () => {
    expect(await getTasksVersionByScope(env.DB, 0, "")).toBe(0);
  });

  it("bumps global → owner → repo in cascade", async () => {
    const owner = await seedUser("org-four");
    const repo = await seedRepo("repo-4", "org-four", owner, "repo-four");
    await seedRepo("repo-other", "org-four", owner, "repo-other");

    await increaseTaskVersion(env.DB, owner, repo);

    expect(await getTasksVersionByScope(env.DB, 0, "")).toBe(1); // global
    expect(await getTasksVersionByScope(env.DB, owner, "")).toBe(1); // owner
    expect(await getTasksVersionByScope(env.DB, 0, repo)).toBe(1); // repo
    expect(await getTasksVersionByScope(env.DB, 0, "repo-other")).toBe(0); // untouched

    await increaseTaskVersion(env.DB, owner, repo);
    expect(await getTasksVersionByScope(env.DB, 0, repo)).toBe(2);

    // A global-only bump (ownerless scope: IncreaseTaskVersion(0,0)).
    await increaseTaskVersion(env.DB, 0, "");
    expect(await getTasksVersionByScope(env.DB, 0, "")).toBe(3);
    expect(await getTasksVersionByScope(env.DB, owner, "")).toBe(2);
  });

  it("self-heals a missing scope row at version 1 on bump", async () => {
    await increaseTaskVersion(env.DB, 0, "");
    expect(await getTasksVersionByScope(env.DB, 0, "")).toBe(1);
    const rows = await db().select().from(actionTasksVersions);
    expect(rows).toHaveLength(1);
  });
});

describe("heartbeat debounce (interceptor.go:72-84 constants)", () => {
  const now = new Date("2026-10-29T12:00:00Z");
  it("persists last_online only past the 30 s window", () => {
    expect(shouldPersistLastOnline(null, now)).toBe(true);
    expect(shouldPersistLastOnline(new Date(now.getTime() - 29_999), now)).toBe(false);
    expect(shouldPersistLastOnline(new Date(now.getTime() - 30_000), now)).toBe(true);
  });
  it("persists last_active only past the 5 s window", () => {
    expect(shouldPersistLastActive(null, now)).toBe(true);
    expect(shouldPersistLastActive(new Date(now.getTime() - 4_999), now)).toBe(false);
    expect(shouldPersistLastActive(new Date(now.getTime() - 5_000), now)).toBe(true);
  });
});

describe("label matching (CanMatchLabels)", () => {
  it("refuses empty runs-on and demands every label", () => {
    expect(canMatchLabels(["ubuntu"], [])).toBe(false);
    expect(canMatchLabels(["ubuntu"], ["ubuntu"])).toBe(true);
    expect(canMatchLabels(["Ubuntu-Latest"], ["ubuntu-latest"])).toBe(true); // case-insensitive
    expect(canMatchLabels(["ubuntu"], ["ubuntu", "gpu"])).toBe(false);
  });
});

describe("status → result mapping", () => {
  it("maps the four terminal statuses and leaves the rest unspecified", () => {
    expect(statusToResult(1)).toBe(1);
    expect(statusToResult(2)).toBe(2);
    expect(statusToResult(3)).toBe(3);
    expect(statusToResult(4)).toBe(4);
    expect(statusToResult(5)).toBe(0); // waiting
    expect(statusToResult(6)).toBe(0); // running
    expect(statusToResult(0)).toBe(0);
  });

  it("maps CANCELLING to CANCELLED (AsResult, status.go:109) — the UpdateTask echo during cleanup", () => {
    // While a cancelled job is in its post-cancel cleanup phase the task
    // holds CANCELLING; upstream's UpdateTask response spells it
    // task.Status.AsResult() (runner.go:278-284) = RESULT_CANCELLED, and
    // `needs`-result consumers read the same mapping.
    expect(statusToResult(8)).toBe(3);
  });
});

describe("display helpers", () => {
  it("ellipsizes past the rune limit without splitting surrogate pairs", () => {
    expect(ellipsisDisplayString("short", 255)).toBe("short");
    const long = "x".repeat(300);
    const clipped = ellipsisDisplayString(long, 255);
    expect(Array.from(clipped)).toHaveLength(255);
    expect(clipped.endsWith("…")).toBe(true);
    const emoji = "🦊".repeat(10);
    expect(Array.from(ellipsisDisplayString(emoji, 5))).toHaveLength(5);
  });
});

describe("runner rows", () => {
  it("keep the plaintext token out of persistence", async () => {
    const owner = await seedUser("org-five");
    const { createRunner } = await import("./model");
    const runner = await createRunner(env.DB, {
      uuid: "uuid-1",
      name: "n",
      version: "v",
      ownerId: owner,
      repoId: "",
      agentLabels: ["a"],
      ephemeral: false,
      hasCancellingSupport: false,
    });
    expect(runner.token).toMatch(/^[0-9a-f]{40}$/);
    const persisted = await db().select().from(actionRunners).where(eq(actionRunners.id, runner.id));
    const row = persisted[0];
    if (row === undefined) throw new Error("runner row missing");
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(runner.token);
    expect(await verifyRunnerToken(row.tokenHash, row.tokenSalt, runner.token)).toBe(true);
  });
});

describe("the dispatch scan's scope condition (task.go:279-286)", () => {
  async function seedJob(repoId: string, ownerId: number, jobId: string): Promise<void> {
    const now = new Date("2026-01-02T00:00:00Z");
    await db().insert(actionRunJobs).values({
      runId: 1,
      repoId,
      ownerId,
      jobId,
      workflowPayload: new TextEncoder().encode("name: ci\n"),
      status: 5, // waiting
      created: now,
      updated: now,
    });
  }

  it("an owner scope rides the repo_unit subquery — scoped repos only", async () => {
    const ownerId = await seedUser("cond-org");
    const otherOwner = await seedUser("cond-other");
    await seedRepo("repo-c1", "cond-org", ownerId, "c1");
    await seedRepo("repo-c2", "cond-org", ownerId, "c2");
    await seedRepo("repo-cx", "cond-org", ownerId, "cx", false); // unit off → out of scope
    await seedRepo("repo-co", "cond-other", otherOwner, "co"); // other owner → out of scope
    const runner = await createRunner(env.DB, {
      uuid: "uuid-cond",
      name: "cond-runner",
      version: "v",
      ownerId,
      repoId: "",
      agentLabels: ["a"],
      ephemeral: false,
      hasCancellingSupport: false,
    });
    const cond = scopeRepoCondition(env.DB, runner);
    if (cond === undefined) throw new Error("owner runner must scope");
    await seedJob("repo-c1", ownerId, "j1");
    await seedJob("repo-c2", ownerId, "j2");
    await seedJob("repo-cx", ownerId, "jx");
    await seedJob("repo-co", otherOwner, "jo");

    const rows = await db().select({ jobId: actionRunJobs.jobId }).from(actionRunJobs).where(cond);
    expect(rows.map((r) => r.jobId).sort()).toEqual(["j1", "j2"]);
  });

  it("a repo runner scopes to its repo and a global runner gets no scope leg", async () => {
    const ownerId = await seedUser("cond-two");
    await seedRepo("repo-r1", "cond-two", ownerId, "r1");
    await seedRepo("repo-r2", "cond-two", ownerId, "r2");
    await seedJob("repo-r1", ownerId, "jr1");
    await seedJob("repo-r2", ownerId, "jr2");

    const repoRunner = await createRunner(env.DB, {
      uuid: "uuid-repo",
      name: "repo-runner",
      version: "v",
      ownerId: 0,
      repoId: "repo-r1",
      agentLabels: ["a"],
      ephemeral: false,
      hasCancellingSupport: false,
    });
    const repoCond = scopeRepoCondition(env.DB, repoRunner);
    if (repoCond === undefined) throw new Error("repo runner must scope");
    const repoRows = await db().select({ jobId: actionRunJobs.jobId }).from(actionRunJobs).where(repoCond);
    expect(repoRows.map((r) => r.jobId)).toEqual(["jr1"]);

    const globalRunner = await createRunner(env.DB, {
      uuid: "uuid-global",
      name: "global-runner",
      version: "v",
      ownerId: 0,
      repoId: "",
      agentLabels: ["a"],
      ephemeral: false,
      hasCancellingSupport: false,
    });
    expect(scopeRepoCondition(env.DB, globalRunner)).toBeUndefined();
  });
});

/**
 * The workflow-file redirect arm's tests (the F-row tail GET #2 — the
 * module header's upstream pins): the resolution posture (ID-based +
 * "latest"), the 303 target shape (`/src/commit/{sha}/{dir}/{file}` — the
 * matched ENTRY's real path), the base-segment workflow-id match over both
 * store spellings, the dir-walk fallback (.gitea → .github), the 404 arms
 * (missing run, missing dirs, no matching entry) and the ServerError-class
 * throws (a deleted commit, a scoped run whose source row vanished), and
 * the scoped arm's source-repo redirect. Module-loader tests (the pre-mount
 * house pattern) over a stubbed engine read slice.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { actionRuns, repositories } from "../../db/schema";
import { insertActionRun } from "../../services/actions/model";
import { resolveActionsRunWorkflowFile, type WorkflowFileReads } from "./repo-actions-workflow";

/** The stringContaining escape hatch (the routes.test.ts precedent — the
 *  vitest asymmetric-matcher factories return `any`). */
const containing = (text: string): unknown => expect.stringContaining(text);

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const CLEANUP_TABLES = ["action_runs", "action_run_jobs", "action_run_attempts", "action_tasks_versions", "repositories", "users"];

beforeEach(async () => {
  for (const table of CLEANUP_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

const SHA = "ccccdddddddddddddddddddddddddddddddddddd";
const PAYLOAD = new TextEncoder().encode("name: ci\njobs:\n  build:\n    steps:\n      - run: echo hi\n");
const REPO_LINK = "/alice/demo";

/** The engine stub: one existing dir (default .gitea/workflows, override to
 *  exercise the fallback), its entries, and the commit read. */
function stubEngine(opts: {
  dirs?: Record<string, Array<{ name: string; type: string }>>;
  commitExists?: boolean;
}): WorkflowFileReads & { commitIds: string[] } {
  const dirs = opts.dirs ?? {
    ".gitea/workflows": [{ name: "ci.yml", type: "blob" }],
  };
  const commitIds: string[] = [];
  return {
    commitIds,
    readCommit: (id?: string) => {
      commitIds.push(id ?? "HEAD");
      return Promise.resolve(opts.commitExists === false ? null : { oid: id ?? SHA });
    },
    listTree: (ref?: string, path?: string) => {
      void ref;
      const hit = path !== undefined ? dirs[path] : undefined;
      return Promise.resolve(hit === undefined ? null : { oid: "tree0", entries: hit });
    },
  };
}

async function seedRepo(): Promise<string> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, is_empty, created_at) VALUES ('repo-demo', 'repo-demo', 'alice', 1, 'demo', 'main', 'public', 0, unixepoch())",
  ).run();
  const rows = await db().select().from(repositories).where(eq(repositories.id, "repo-demo"));
  const repo = rows[0];
  if (repo === undefined) throw new Error("fixture repository missing");
  return repo.id;
}

async function seedRun(repoId: string, opts: { workflowId: string; index?: number } = { workflowId: "ci.yml" }): Promise<number> {
  const { run } = await insertActionRun(env.DB, {
    repoId,
    ownerId: 1,
    workflowId: opts.workflowId,
    index: opts.index ?? 1,
    triggerUserId: 1,
    ref: "refs/heads/main",
    commitSha: SHA,
    event: "push",
    eventPayload: "{}",
    triggerEvent: "push",
  }, [{ jobId: "build", runsOn: ["ubuntu-latest"], workflowPayload: PAYLOAD }]);
  return run.id;
}

// --- the plain arm (view.go:242-268) -----------------------------------------

describe("resolveActionsRunWorkflowFile (ViewWorkflowFile)", () => {
  let repoId: string;

  beforeEach(async () => {
    repoId = await seedRepo();
  });

  it("303-redirects to the matched entry's src/commit path (bare workflow id)", async () => {
    const runId = await seedRun(repoId, { workflowId: "ci.yml" });
    const engine = stubEngine({});
    const outcome = await resolveActionsRunWorkflowFile(env.DB, engine, { id: repoId, ownerNamespace: "alice", slug: "demo", isEmpty: false }, String(runId), REPO_LINK);
    expect(engine.commitIds).toEqual([SHA]); // GetCommit on the run's SHA
    expect(outcome).toEqual({
      outcome: "redirect",
      location: `/alice/demo/src/commit/${SHA}/.gitea/workflows/ci.yml`,
    });
  });

  it("matches path-spelled workflow ids on the base segment (the store-spelling divergence)", async () => {
    const runId = await seedRun(repoId, { workflowId: ".github/workflows/ci.yml" });
    const engine = stubEngine({});
    const outcome = await resolveActionsRunWorkflowFile(env.DB, engine, { id: repoId, ownerNamespace: "alice", slug: "demo", isEmpty: false }, String(runId), REPO_LINK);
    expect(outcome).toEqual({
      outcome: "redirect",
      location: `/alice/demo/src/commit/${SHA}/.gitea/workflows/ci.yml`,
    });
  });

  it("falls back to .github/workflows when .gitea/workflows is absent (SubTree's miss-continues)", async () => {
    const runId = await seedRun(repoId, { workflowId: "deploy.yaml" });
    const engine = stubEngine({ dirs: { ".github/workflows": [{ name: "ci.yml", type: "blob" }, { name: "deploy.yaml", type: "blob" }] } });
    const outcome = await resolveActionsRunWorkflowFile(env.DB, engine, { id: repoId, ownerNamespace: "alice", slug: "demo", isEmpty: false }, String(runId), REPO_LINK);
    expect(outcome).toEqual({
      outcome: "redirect",
      location: `/alice/demo/src/commit/${SHA}/.github/workflows/deploy.yaml`,
    });
  });

  it("resolves the 'latest' literal", async () => {
    await seedRun(repoId, { workflowId: "ci.yml", index: 1 });
    const engine = stubEngine({});
    const outcome = await resolveActionsRunWorkflowFile(env.DB, engine, { id: repoId, ownerNamespace: "alice", slug: "demo", isEmpty: false }, "latest", REPO_LINK);
    expect(outcome.outcome).toBe("redirect");
  });

  it("404s a missing run, a workflow-less repo tree, and a non-matching entry", async () => {
    const repo = { id: repoId, ownerNamespace: "alice", slug: "demo", isEmpty: false };
    await expect(resolveActionsRunWorkflowFile(env.DB, stubEngine({}), repo, "999999", REPO_LINK)).resolves.toEqual({ outcome: "not-found" });

    const runId = await seedRun(repoId, { workflowId: "gone.yml" });
    await expect(
      resolveActionsRunWorkflowFile(env.DB, stubEngine({}), repo, String(runId), REPO_LINK),
    ).resolves.toEqual({ outcome: "not-found" });

    const runId2 = await seedRun(repoId, { workflowId: "other.yml", index: 2 });
    await expect(
      resolveActionsRunWorkflowFile(env.DB, stubEngine({ dirs: {} }), repo, String(runId2), REPO_LINK),
    ).resolves.toEqual({ outcome: "not-found" });
  });

  it("throws (the ServerError arm) when the run's commit is gone", async () => {
    const runId = await seedRun(repoId, { workflowId: "ci.yml" });
    const outcome = await resolveActionsRunWorkflowFile(
      env.DB,
      stubEngine({ commitExists: false }),
      { id: repoId, ownerNamespace: "alice", slug: "demo", isEmpty: false },
      String(runId),
      REPO_LINK,
    );
    expect(outcome).toMatchObject({ outcome: "throw", reason: containing("GetCommit") });
  });
});

// --- the scoped arm (view.go:1421-1448, documented-unreachable in v1) ---------

describe("the scoped-run arm (viewScopedWorkflowFile)", () => {
  let repoId: string;

  beforeEach(async () => {
    repoId = await seedRepo();
  });

  it("redirects into the SOURCE repo at the workflow commit", async () => {
    const runId = await seedRun(repoId, { workflowId: "shared.yml" });
    await db()
      .update(actionRuns)
      .set({ isScopedRun: true, workflowRepoId: repoId, workflowCommitSha: SHA })
      .where(eq(actionRuns.id, runId));
    const engine = stubEngine({ dirs: { ".gitea/workflows": [{ name: "shared.yml", type: "blob" }] } });
    const outcome = await resolveActionsRunWorkflowFile(env.DB, engine, { id: repoId, ownerNamespace: "alice", slug: "demo", isEmpty: false }, String(runId), REPO_LINK);
    expect(outcome).toEqual({
      outcome: "redirect",
      location: `/alice/demo/src/commit/${SHA}/.gitea/workflows/shared.yml`,
    });
  });

  it("throws when the source repo row is gone (GetRepositoryByID → ServerError)", async () => {
    const runId = await seedRun(repoId, { workflowId: "shared.yml" });
    await db().update(actionRuns).set({ isScopedRun: true, workflowRepoId: "repo-vanished", workflowCommitSha: SHA }).where(eq(actionRuns.id, runId));
    const outcome = await resolveActionsRunWorkflowFile(env.DB, stubEngine({}), { id: repoId, ownerNamespace: "alice", slug: "demo", isEmpty: false }, String(runId), REPO_LINK);
    expect(outcome).toMatchObject({ outcome: "throw", reason: containing("GetRepositoryByID") });
  });
});

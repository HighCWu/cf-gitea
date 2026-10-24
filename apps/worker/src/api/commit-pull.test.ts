/**
 * Tier-1 commit → PR resolution on real D1 (SPEC-0004 §2.4 row
 * repoGetCommitPullRequest — the LAST pure-D1 tier-1 row; upstream
 * routers/api/v1/repo/commits.go GetCommitPullRequest). Pins: the
 * `pull_requests.head_sha` join scoped to the base repo (the documented
 * divergence from upstream's `merged_commit_id` lookup — see
 * services/commit-pull.ts), the exact upstream ErrPullRequestNotExist 404
 * body, the anti-enumeration repo 404s, anonymous-capable reads on public
 * repos, and the single-converter render (merged trio, head.sha from the
 * cached ref target, checking-status mergeable null).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { issues, pullRequests, repositories, users } from "../db/schema";
import { IssuesService } from "../issues/service";
import { createOptionalTokenAuthMiddleware, createStubAuthResolver, createTokenAuthMiddleware } from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { registerCommitPullRoute } from "./routes/commit-pull";

const TOKEN = "stub-token";
const ERROR_URL = "https://example.com/api/swagger";
const COMMIT_SHA = "1a8823cd1a9549fde083f992f6b9b87a7ab74fb3";

function makeApp(): (path: string, init?: RequestInit) => Promise<Response> {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerCommitPullRoute(
    app,
    createOptionalTokenAuthMiddleware(createStubAuthResolver()),
  );
  return (path, init) => Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["labels", "issues", "pull_requests", "repo_counters", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  await drizzle(env.DB).insert(repositories).values({
    id: "8101",
    storageKey: "r_8101",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "joined",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await drizzle(env.DB).insert(repositories).values({
    id: "8102",
    storageKey: "r_8102",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "private",
    visibility: "private",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await new IssuesService(env.DB).ensureRepoCounters("8101");
  await new IssuesService(env.DB).ensureRepoCounters("8102");
});

async function seedPull(
  repoId: string,
  options: { headSha?: string; title?: string } = {},
): Promise<{ index: number; prId: number }> {
  const { issue, pullRequest } = await new IssuesService(env.DB).createPullRequest({
    repoId,
    title: options.title ?? "commit pull",
    content: "seeded by commit-pull.test.ts",
    posterId: 1,
    headRepoId: repoId,
    baseBranch: "main",
    headBranch: "topic",
    headSha: options.headSha ?? null,
  });
  return { index: issue.index, prId: pullRequest.id };
}

describe("GET /repos/{owner}/{repo}/commits/{sha}/pull (repoGetCommitPullRequest)", () => {
  it("resolves the PR whose head_sha carries the commit", async () => {
    const seeded = await seedPull("8101", { headSha: COMMIT_SHA });
    const res = await makeApp()(`/repos/cf-gitea-stub/joined/commits/${COMMIT_SHA}/pull`);
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.number).toBe(seeded.index);
    expect(body.state).toBe("open");
    expect(body.title).toBe("commit pull");
    expect(body.merged).toBe(false);
    expect(body.merge_commit_sha).toBeNull();
    expect(body.merged_by).toBeNull();
    // checking-status row → mergeable unknown (the documented null render)
    expect(body.mergeable).toBeNull();
    expect(body.html_url).toBe(`https://example.com/cf-gitea-stub/joined/pulls/${String(seeded.index)}`);
    expect(body.url).toBe(`https://example.com/cf-gitea-stub/joined/pulls/${String(seeded.index)}`);
    expect(body.diff_url).toBe(`https://example.com/cf-gitea-stub/joined/pulls/${String(seeded.index)}.diff`);
    const head = body.head as Record<string, unknown>;
    expect(head.sha).toBe(COMMIT_SHA);
    expect(head.ref).toBe(`refs/pull/${String(seeded.index)}/head`);
    expect(head.label).toBe("topic");
  });

  it("renders the merged trio for a merged PR row", async () => {
    const { issue, pullRequest } = await new IssuesService(env.DB)
      .createPullRequest({
        repoId: "8101",
        title: "merged commit pull",
        posterId: 1,
        headRepoId: "8101",
        baseBranch: "main",
        headBranch: "merged-topic",
        headSha: COMMIT_SHA,
      });
    await drizzle(env.DB)
      .update(pullRequests)
      .set({ hasMerged: true, mergedCommitId: "f001d2ba5e", mergerId: 1, mergedAt: new Date("2026-03-04T05:06:07Z") })
      .where(eq(pullRequests.id, pullRequest.id));
    await drizzle(env.DB).update(issues).set({ isClosed: true }).where(eq(issues.id, issue.id));
    const res = await makeApp()(`/repos/cf-gitea-stub/joined/commits/${COMMIT_SHA}/pull`);
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.merged).toBe(true);
    expect(body.state).toBe("closed");
    expect(body.number).toBe(issue.index);
    expect(body.merge_commit_sha).toBe("f001d2ba5e");
    expect(body.merged_at).toBe("2026-03-04T05:06:07.000Z");
    expect((body.merged_by as Record<string, unknown>).login).toBe("cf-gitea-stub");
  });

  it("404s with the upstream ErrPullRequestNotExist body when no PR carries the sha", async () => {
    const res = await makeApp()(`/repos/cf-gitea-stub/joined/commits/${COMMIT_SHA}/pull`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      message:
        "pull request does not exist [id: 0, issue_id: 0, head_repo_id: 0, base_repo_id: 8101, head_branch: , base_branch: ]",
      url: ERROR_URL,
    });
  });

  it("scopes the join to the base repo (another repo's head sha does not match)", async () => {
    await seedPull("8101", { headSha: COMMIT_SHA });
    await seedPull("8102", { headSha: "deadbeef" + "0".repeat(32) });
    const res = await makeApp()("/repos/cf-gitea-stub/joined/commits/deadbeef00000000000000000000000000000000/pull");
    expect(res.status).toBe(404);
  });

  it("404s an unknown or invisible repo (anti-enumeration)", async () => {
    expect((await makeApp()(`/repos/cf-gitea-stub/missing/commits/${COMMIT_SHA}/pull`)).status).toBe(404);
    expect((await makeApp()(`/repos/cf-gitea-stub/private/commits/${COMMIT_SHA}/pull`)).status).toBe(404);
  });

  it("answers anonymous callers on a public repo", async () => {
    await seedPull("8101", { headSha: COMMIT_SHA });
    const res = await makeApp()(`/repos/cf-gitea-stub/joined/commits/${COMMIT_SHA}/pull`);
    expect(res.status).toBe(200);
  });

  it("serves a token caller on a private repo", async () => {
    await seedPull("8102", { headSha: COMMIT_SHA });
    const res = await makeApp()(`/repos/cf-gitea-stub/private/commits/${COMMIT_SHA}/pull`, {
      headers: { Authorization: `token ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.number).toBeGreaterThan(0);
  });
});

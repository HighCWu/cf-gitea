/**
 * Tier-2 user-tag reads on real D1 (SPEC-0004 appendix A table-free rows):
 * routes/user-read-t2.ts — GET /users/{username}/heatmap (computed from the
 * EXISTING issues + comments tables; upstream aggregates its action table,
 * the documented deviation in the route module header) and GET
 * /user/following/{username} (the current-user half of the landed follow
 * family). Standalone mounts per the tier2-extras.test.ts convention; the
 * routes ARE registered in router.ts by the orchestrator after this batch.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { comments, issues, users } from "../../db/schema";
import {
  createOptionalTokenAuthMiddleware,
  createTokenAuthMiddleware,
  STUB_USER,
  type AuthResolver,
} from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerUserReadT2Routes } from "./user-read-t2";
import { followUser } from "../services/follows";

const NOW = new Date("2026-02-03T04:05:06Z");
const REPO_ID = "7300";

const TOKEN = "stub-token"; // the seed user (id 1)
const TOKEN_NEIGHBOR = "neighbor-token";
const TOKEN_ADMIN = "admin-token";

let neighborId = 0;
let adminId = 0;

function resolver(): AuthResolver {
  return {
    resolveToken: (token) => {
      if (token === TOKEN) return Promise.resolve(STUB_USER);
      if (token === TOKEN_NEIGHBOR) {
        return Promise.resolve({ ...STUB_USER, id: neighborId, login: "neighbor" });
      }
      if (token === TOKEN_ADMIN) {
        return Promise.resolve({ ...STUB_USER, id: adminId, login: "root", is_admin: true });
      }
      return Promise.resolve(null);
    },
  };
}

function familyApp(register: (app: OpenAPIHono<ApiEnv>) => void) {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  register(app);
  return async (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

const authed = (init?: RequestInit, token = TOKEN): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `token ${token}`);
  return { ...init, headers };
};

const userReadSend = familyApp((app) =>
  registerUserReadT2Routes(
    app,
    createTokenAuthMiddleware(resolver()),
    createOptionalTokenAuthMiddleware(resolver()),
  ),
);

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  const { applyRepoExtrasDdl } = await import("../testing/repo-ddl");
  await applyRepoExtrasDdl();
});

beforeEach(async () => {
  for (const table of ["comments", "issues", "follows", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  neighborId = (
    await drizzle(env.DB)
      .insert(users)
      .values({ username: "neighbor", usernameLower: "neighbor", status: "active", createdAt: NOW })
      .returning({ id: users.id })
      .all()
  )[0]!.id;
  adminId = (
    await drizzle(env.DB)
      .insert(users)
      .values({ username: "root", usernameLower: "root", isAdmin: true, status: "active", createdAt: NOW })
      .returning({ id: users.id })
      .all()
  )[0]!.id;
});

/** One issue row by the given poster at the given time (raw insert — the
 *  heatmap reads timestamps directly, no repo_counters involvement). The
 *  (repo_id, index) pair is UNIQUE, so each row takes the next index. */
let nextIssueIndex = 0;
async function seedIssue(posterId: number, createdAt: Date): Promise<number> {
  const row = await drizzle(env.DB)
    .insert(issues)
    .values({ repoId: REPO_ID, index: ++nextIssueIndex, posterId, title: "seed", createdAt })
    .returning({ id: issues.id })
    .all();
  return row[0]!.id;
}

async function seedComment(issueId: number, posterId: number, createdAt: Date): Promise<void> {
  await drizzle(env.DB)
    .insert(comments)
    .values({ type: 0, issueId, posterId, content: "seed", createdAt });
}

// ---------------------------------------------------------------------------
// GET /users/{username}/heatmap
// ---------------------------------------------------------------------------

describe("GET /users/{username}/heatmap (user-read-t2)", () => {
  it("buckets the subject's issue+comment creations into ascending 15-minute buckets", async () => {
    // t0 and t0+5min share a bucket; t0+16min is the next one; the neighbor's
    // activity is not the subject's.
    const t0 = new Date("2026-02-03T04:05:06Z");
    const issueId = await seedIssue(1, t0);
    await seedComment(issueId, 1, new Date(t0.getTime() + 5 * 60_000));
    await seedComment(issueId, 1, new Date(t0.getTime() + 16 * 60_000));
    await seedComment(issueId, neighborId, t0);

    const response = await userReadSend("/users/cf-gitea-stub/heatmap");
    expect(response.status).toBe(200);
    const heatmap: Array<{ timestamp: number; contributions: number }> = await response.json();
    const bucket0 = Math.floor(t0.getTime() / 1000 / 900) * 900;
    expect(heatmap).toEqual([
      { timestamp: bucket0, contributions: 2 }, // issue + first comment
      { timestamp: bucket0 + 900, contributions: 1 }, // +16min comment
    ]);
  });

  it("is anonymous-capable on public subjects and 404s unknown users", async () => {
    await seedIssue(1, NOW);
    expect((await userReadSend("/users/cf-gitea-stub/heatmap")).status).toBe(200);
    expect((await userReadSend("/users/ghost/heatmap")).status).toBe(404);
  });

  it("private subjects expose activity only to themself and site admins (empty list otherwise)", async () => {
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.id, 1));
    await seedIssue(1, NOW);

    const anon = await userReadSend("/users/cf-gitea-stub/heatmap");
    expect(anon.status).toBe(200);
    const anonHeatmap: Array<unknown> = await anon.json();
    expect(anonHeatmap).toEqual([]);

    const self = await userReadSend("/users/cf-gitea-stub/heatmap", authed(undefined, TOKEN));
    const selfHeatmap: Array<unknown> = await self.json();
    expect(selfHeatmap).toHaveLength(1);

    const admin = await userReadSend("/users/cf-gitea-stub/heatmap", authed(undefined, TOKEN_ADMIN));
    const adminHeatmap: Array<unknown> = await admin.json();
    expect(adminHeatmap).toHaveLength(1);
  });

  it("applies the trailing (366+7)-day window", async () => {
    await seedIssue(1, new Date(Date.now() - 400 * 86_400_000)); // outside
    await seedIssue(1, new Date(Date.now() - 30 * 86_400_000)); // inside
    const response = await userReadSend("/users/cf-gitea-stub/heatmap");
    const heatmap: Array<{ contributions: number }> = await response.json();
    expect(heatmap).toHaveLength(1);
    expect(heatmap[0]?.contributions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /user/following/{username}
// ---------------------------------------------------------------------------

describe("GET /user/following/{username} (user-read-t2)", () => {
  it("204 when the doer follows the target, 404 otherwise (and for missing targets)", async () => {
    expect((await userReadSend("/user/following/neighbor", authed())).status).toBe(404);
    await followUser(env.DB, 1, neighborId);
    expect((await userReadSend("/user/following/neighbor", authed())).status).toBe(204);
    // Followed in the other direction means nothing for this check.
    await followUser(env.DB, neighborId, 1);
    expect((await userReadSend("/user/following/neighbor", authed(undefined, TOKEN_NEIGHBOR))).status).toBe(404);
    expect((await userReadSend("/user/following/ghost", authed())).status).toBe(404);
  });

  it("requires a token (runtime-only 401, undeclared in the vendored contract)", async () => {
    expect((await userReadSend("/user/following/neighbor")).status).toBe(401);
  });
});

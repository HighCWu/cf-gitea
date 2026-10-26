import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { repositories, userBlocking, users } from "../../db/schema";
import { STUB_USER, createStubAuthResolver, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerForkRoutes } from "./forks";

/**
 * The createFork blocked-user arm on real D1 — the focused standalone mount
 * for the blocks-enforcement batch (the full fork flow lives in
 * src/api/compat/suite.test.ts). Pins ForkRepository's check
 * (services/repository/fork.go:64-66: `IsUserBlockedBy(doer, BaseRepo.
 * Owner.ID)` → ErrBlockedUser) surfaced through the API handler's
 * APIErrorAuto permission-denied unwrap as 403 "user is blocked"
 * (routers/api/v1/repo/fork.go CreateFork), positioned ahead of the
 * already-forked probe exactly like upstream (fork.go:64 vs :70), with the
 * IsUserBlockedBy site-admin bypass (models/user/block.go:42-44).
 */

const TOKEN = "stub-token"; // resolves to STUB_USER (id 1)
const ERROR_URL = "https://example.com/api/swagger";

let adminDoer = false;
let blockerId = 0;

function resolver(): AuthResolver {
  return {
    resolveToken: (token) => {
      if (token === TOKEN) {
        return adminDoer
          ? Promise.resolve({ ...STUB_USER, is_admin: true })
          : createStubAuthResolver().resolveToken(token);
      }
      return Promise.resolve(null);
    },
  };
}

const makeApp = () => {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerForkRoutes(app, createTokenAuthMiddleware(resolver()), createTokenAuthMiddleware(resolver()));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
};

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  adminDoer = false;
  for (const table of ["repo_counters", "repo_settings", "repo_collaborators", "user_blocking", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  blockerId = (
    await drizzle(env.DB)
      .insert(users)
      .values({ username: "recluse", usernameLower: "recluse", status: "active", createdAt: new Date() })
      .returning({ id: users.id })
      .all()
  )[0]!.id;
  await drizzle(env.DB).insert(repositories).values({
    id: "7301",
    storageKey: "r_7301",
    ownerNamespace: "recluse",
    ownerId: blockerId,
    slug: "source",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
});

describe("POST /repos/{owner}/{repo}/forks: the ForkRepository blocked arm", () => {
  it("403s a doer blocked by the source owner (fork.go:64-66 via CreateFork's APIErrorAuto)", async () => {
    await drizzle(env.DB).insert(userBlocking).values({ blockerId, blockeeId: 1, note: "", createdAt: new Date() });
    const res = await makeApp()("/repos/recluse/source/forks", {
      method: "POST",
      headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
  });

  it("a site-admin doer bypasses the block (IsUserBlockedBy's IsAdmin arm)", async () => {
    adminDoer = true;
    await drizzle(env.DB).insert(userBlocking).values({ blockerId, blockeeId: 1, note: "", createdAt: new Date() });
    const res = await makeApp()("/repos/recluse/source/forks", {
      method: "POST",
      headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(202);
  });

  it("202s once no blocking row relates the pair (the arm lifts with the block)", async () => {
    await drizzle(env.DB).insert(userBlocking).values({ blockerId, blockeeId: 1, note: "", createdAt: new Date() });
    await drizzle(env.DB).delete(userBlocking).all();
    const res = await makeApp()("/repos/recluse/source/forks", {
      method: "POST",
      headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(202);
  });
});

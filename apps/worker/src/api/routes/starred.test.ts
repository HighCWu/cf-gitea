/**
 * The PUT /user/starred/{owner}/{repo} blocked arm on real D1 — the focused
 * standalone mount for the blocks-enforcement sweep (the full star family
 * lives in src/api/tier2-extras.test.ts). Pins StarRepo's check
 * (models/repo/star.go:34-35: `IsUserBlockedBy(doer, repo.OwnerID)` →
 * ErrBlockedUser) surfaced through the API handler's unwrap as 403 "user is
 * blocked" (routers/api/v1/user/star.go Star, star.go:179), positioned
 * BEFORE the already-starring no-op exactly like upstream (the probe is the
 * star=true branch's first statement), with the IsUserBlockedBy site-admin
 * bypass (models/user/block.go:42-44). DELETE carries no upstream arm —
 * upstream Unstar calls StarRepo with star=false, whose branch never probes.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { repositories, stars, userBlocking, users } from "../../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerStarredRoutes } from "./starred";

const ERROR_URL = "https://example.com/api/swagger";

/** Seeded D1 users the resolver authenticates as (`token u<id>`). */
const seededUsers = new Map<number, { id: number; username: string; isAdmin: boolean }>();

async function seedUser(username: string, options: { isAdmin?: boolean } = {}): Promise<{ id: number; username: string }> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: options.isAdmin ?? false,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin: options.isAdmin ?? false });
  return { id: user.id, username: user.username };
}

function apiUser(user: { id: number; username: string; isAdmin: boolean }): User {
  return {
    id: user.id,
    login: user.username,
    email: `${user.username.toLowerCase()}@example.com`,
    full_name: "",
    avatar_url: "",
    html_url: "",
    language: "en-US",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: user.isAdmin,
    prohibit_login: false,
    restricted: false,
    login_name: "",
    source_id: 0,
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    created: "2026-01-01T00:00:00Z",
    last_login: "0001-01-01T00:00:00Z",
    type: "User",
    visibility: "public",
  };
}

const resolver: AuthResolver = {
  resolveToken(token) {
    const match = /^u(\d+)$/.exec(token);
    const user = match === null ? undefined : seededUsers.get(Number(match[1]));
    if (match === null || user === undefined) return Promise.resolve(null);
    return Promise.resolve(apiUser(user));
  },
};

const makeApp = () => {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerStarredRoutes(app, createTokenAuthMiddleware(resolver));
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
  seededUsers.clear();
  for (const table of ["stars", "user_blocking", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("PUT /user/starred/{owner}/{repo}: the StarRepo blocked arm", () => {
  /** The recluse-owned source repo; returns the pair of user ids. */
  async function seedRepo(): Promise<{ ownerId: number; doerId: number }> {
    const owner = await seedUser("recluse");
    const doer = await seedUser("stargazer");
    await drizzle(env.DB).insert(repositories).values({
      id: "7302",
      storageKey: "r_7302",
      ownerNamespace: "recluse",
      ownerId: owner.id,
      slug: "source",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: new Date("2026-02-03T04:05:06Z"),
    });
    return { ownerId: owner.id, doerId: doer.id };
  }

  const block = (blockerId: number, blockeeId: number) =>
    drizzle(env.DB).insert(userBlocking).values({ blockerId, blockeeId, note: "", createdAt: new Date() });

  const putStar = (doerId: number) =>
    makeApp()("/user/starred/recluse/source", { method: "PUT", headers: { Authorization: `token u${doerId}` } });

  it("403s \"user is blocked\" when the doer is blocked by the repo owner (star.go:34-35 via Star at star.go:179)", async () => {
    const { ownerId, doerId } = await seedRepo();
    await block(ownerId, doerId);
    const res = await putStar(doerId);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
    expect(await drizzle(env.DB).select().from(stars).all()).toHaveLength(0);
  });

  it("the probe precedes the already-starring no-op — a repeat star with a fresh block 403s (star.go:32-35 order)", async () => {
    const { ownerId, doerId } = await seedRepo();
    await putStar(doerId);
    expect(await drizzle(env.DB).select().from(stars).all()).toHaveLength(1);
    await block(ownerId, doerId);
    const res = await putStar(doerId);
    expect(res.status).toBe(403);
    expect(await drizzle(env.DB).select().from(stars).all()).toHaveLength(1);
  });

  it("a site-admin doer bypasses the block (IsUserBlockedBy's blockee.IsAdmin short-circuit)", async () => {
    const { ownerId } = await seedRepo();
    const admin = await seedUser("root", { isAdmin: true });
    await block(ownerId, admin.id);
    const res = await makeApp()("/user/starred/recluse/source", {
      method: "PUT",
      headers: { Authorization: `token u${admin.id}` },
    });
    expect(res.status).toBe(204);
  });

  it("204s once no blocking row relates the pair (the arm lifts with the block)", async () => {
    const { ownerId, doerId } = await seedRepo();
    await block(ownerId, doerId);
    await env.DB.prepare("DELETE FROM user_blocking").run();
    const res = await putStar(doerId);
    expect(res.status).toBe(204);
    expect(await drizzle(env.DB).select().from(stars).all()).toHaveLength(1);
  });

  it("DELETE carries no upstream arm — the unstar stays 204 while blocked (star.go's star=false branch never probes)", async () => {
    const { ownerId, doerId } = await seedRepo();
    await drizzle(env.DB).insert(stars).values({ userId: doerId, repoId: "7302", createdAt: new Date() });
    await block(ownerId, doerId);
    const res = await makeApp()("/user/starred/recluse/source", {
      method: "DELETE",
      headers: { Authorization: `token u${doerId}` },
    });
    expect(res.status).toBe(204);
    expect(await drizzle(env.DB).select().from(stars).all()).toHaveLength(0);
  });
});

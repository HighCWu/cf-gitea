/**
 * The PUT /repos/{owner}/{repo}/subscription blocked arm on real D1 — the
 * focused standalone mount for the blocks-enforcement sweep (the full
 * subscription family lives in src/api/subscription.test.ts). Pins
 * WatchRepoAuto's check (models/repo/watch.go:170-171:
 * `IsUserBlockedBy(doer, repo.OwnerID)` → ErrBlockedUser on the doWatch=true
 * path, AFTER the !doWatch arms) surfaced through the API handler's unwrap as
 * 403 "user is blocked" (routers/api/v1/user/watch.go Watch, watch.go:174),
 * with the IsUserBlockedBy site-admin bypass (models/user/block.go:42-44).
 * DELETE carries no upstream arm — the unwatch branch runs before the probe.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { repositories, repoWatchers, userBlocking, users } from "../../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerSubscriptionRoutes } from "./subscription";

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
  registerSubscriptionRoutes(app, createTokenAuthMiddleware(resolver));
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
  for (const table of ["repo_watchers", "user_blocking", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("PUT /repos/{owner}/{repo}/subscription: the WatchRepoAuto blocked arm", () => {
  /** The recluse-owned source repo; returns the pair of user ids. */
  async function seedRepo(): Promise<{ ownerId: number; doerId: number }> {
    const owner = await seedUser("recluse");
    const doer = await seedUser("watcher");
    await drizzle(env.DB).insert(repositories).values({
      id: "7303",
      storageKey: "r_7303",
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

  const putSubscription = (doerId: number) =>
    makeApp()("/repos/recluse/source/subscription", { method: "PUT", headers: { Authorization: `token u${doerId}` } });

  it("403s \"user is blocked\" when the doer is blocked by the repo owner (watch.go:170-171 via Watch at watch.go:174)", async () => {
    const { ownerId, doerId } = await seedRepo();
    await block(ownerId, doerId);
    const res = await putSubscription(doerId);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
    expect(await drizzle(env.DB).select().from(repoWatchers).all()).toHaveLength(0);
  });

  it("a site-admin doer bypasses the block (IsUserBlockedBy's blockee.IsAdmin short-circuit)", async () => {
    const { ownerId } = await seedRepo();
    const admin = await seedUser("root", { isAdmin: true });
    await block(ownerId, admin.id);
    const res = await makeApp()("/repos/recluse/source/subscription", {
      method: "PUT",
      headers: { Authorization: `token u${admin.id}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.subscribed).toBe(true);
  });

  it("200s once no blocking row relates the pair (the arm lifts with the block)", async () => {
    const { ownerId, doerId } = await seedRepo();
    await block(ownerId, doerId);
    await env.DB.prepare("DELETE FROM user_blocking").run();
    const res = await putSubscription(doerId);
    expect(res.status).toBe(200);
    expect(await drizzle(env.DB).select().from(repoWatchers).all()).toHaveLength(1);
  });

  it("DELETE carries no upstream arm — the unwatch stays 204 while blocked (the !doWatch arms run before the probe)", async () => {
    const { ownerId, doerId } = await seedRepo();
    await drizzle(env.DB).insert(repoWatchers).values({ repoId: "7303", userId: doerId, createdAt: new Date() });
    await block(ownerId, doerId);
    const res = await makeApp()("/repos/recluse/source/subscription", {
      method: "DELETE",
      headers: { Authorization: `token u${doerId}` },
    });
    expect(res.status).toBe(204);
    expect(await drizzle(env.DB).select().from(repoWatchers).all()).toHaveLength(0);
  });
});

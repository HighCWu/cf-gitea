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
import { eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";

import { repositories, stars, userBlocking, users } from "../../db/schema";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { findRepositoryByPath, toApiRepository } from "../services/repository";
import { toApiUser } from "../services/user";
import { registerSocialT2Routes } from "./social-t2";
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

/**
 * The maintained `repositories.num_stars` counter (migration 0030) — the
 * StarRepo transactional halves (models/repo/star.go:42-50 insert + bump,
 * :56-64 delete + decrement, one WithTx upstream / one D1 batch here),
 * rendered as the API `stars_count` (services/convert/repository.go:219
 * `Stars: repo.NumStars`).
 */
describe("repositories.num_stars maintenance (migration 0030)", () => {
  /** The recluse-owned source repo (the first describe's seed, local to this
   *  block — returns the pair of user ids). */
  async function seedCounterRepo(): Promise<{ ownerId: number; doerId: number }> {
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

  async function numStars(): Promise<number> {
    const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "7302")).get();
    if (row === undefined) throw new Error("repo seed failed");
    return row.numStars;
  }

  it("PUT star bumps the counter; the repeat PUT is the star.go:38-40 no-op and moves nothing", async () => {
    const { doerId } = await seedCounterRepo();
    await putStar(doerId);
    expect(await numStars()).toBe(1);
    expect(await drizzle(env.DB).select().from(stars).all()).toHaveLength(1);
    await putStar(doerId);
    expect(await numStars()).toBe(1);
    expect(await drizzle(env.DB).select().from(stars).all()).toHaveLength(1);
  });

  it("DELETE unstar decrements; the repeat DELETE (no edge) moves nothing and the column never crosses 0", async () => {
    const { doerId } = await seedCounterRepo();
    await putStar(doerId);
    await makeApp()("/user/starred/recluse/source", { method: "DELETE", headers: { Authorization: `token u${doerId}` } });
    expect(await numStars()).toBe(0);
    // The repeat DELETE: upstream's `if !staring { return nil }` arm.
    await makeApp()("/user/starred/recluse/source", { method: "DELETE", headers: { Authorization: `token u${doerId}` } });
    expect(await numStars()).toBe(0);
    expect(await drizzle(env.DB).select().from(stars).all()).toHaveLength(0);
  });

  it("the blocked PUT never counts (the 403 arm precedes any write) — red→green: num_stars stays 0", async () => {
    const { ownerId, doerId } = await seedCounterRepo();
    await block(ownerId, doerId);
    const res = await putStar(doerId);
    expect(res.status).toBe(403);
    expect(await numStars()).toBe(0);
  });

  it("a pre-0030 edge (backfilled counter 0 beneath a seeded star) unstarring floors at 0, never negative", async () => {
    const { doerId } = await seedCounterRepo();
    // The migration-0030 backfill shape: an edge whose counter column is the
    // ALTER default 0 (seeded directly, bypassing the route arm).
    await drizzle(env.DB).insert(stars).values({ userId: doerId, repoId: "7302", createdAt: new Date() });
    expect(await numStars()).toBe(0);
    const res = await makeApp()("/user/starred/recluse/source", {
      method: "DELETE",
      headers: { Authorization: `token u${doerId}` },
    });
    expect(res.status).toBe(204);
    expect(await numStars()).toBe(0); // MAX(num_stars - 1, 0), not -1
  });

  it("renders as stars_count (convert/repository.go:219 — Stars: repo.NumStars)", async () => {
    const { doerId } = await seedCounterRepo();
    await putStar(doerId);
    const pair = await findRepositoryByPath(env.DB, "recluse", "source");
    if (pair === null) throw new Error("repo seed failed");
    const rendered = toApiRepository({ origin: "https://example.com", requester: null }, pair);
    expect(rendered.stars_count).toBe(1);
    expect(rendered.watchers_count).toBe(0); // untouched by the star arm
  });
});

/**
 * The maintained `users.num_stars` counter (migration 0031) — the per-USER
 * twin of the block above, the star.go:48/62 UPDATEs inside StarRepo's
 * WithTx, rendered as the payload `starred_repos_count`
 * (modules/structs/user.go:60 `StarredRepos`; models/user/user.go:155).
 */
describe("users.num_stars maintenance (migration 0031)", () => {
  /** The recluse-owned source repo (the seed shape of the blocks above). */
  async function seedCounterRepo(): Promise<{ doerId: number }> {
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
    return { doerId: doer.id };
  }

  const putStar = (doerId: number) =>
    makeApp()("/user/starred/recluse/source", { method: "PUT", headers: { Authorization: `token u${doerId}` } });

  const deleteStar = (doerId: number) =>
    makeApp()("/user/starred/recluse/source", { method: "DELETE", headers: { Authorization: `token u${doerId}` } });

  async function userStars(userId: number): Promise<number> {
    const row = await drizzle(env.DB).select().from(users).where(eq(users.id, userId)).get();
    if (row === undefined) throw new Error("user seed failed");
    return row.numStars;
  }

  it("PUT star bumps the starrer's tally (star.go:48); the repeat PUT is the no-op arm and moves nothing", async () => {
    const { doerId } = await seedCounterRepo();
    expect(await userStars(doerId)).toBe(0);
    await putStar(doerId);
    expect(await userStars(doerId)).toBe(1);
    await putStar(doerId);
    expect(await userStars(doerId)).toBe(1);
    expect(await drizzle(env.DB).select().from(stars).all()).toHaveLength(1);
  });

  it("DELETE unstar decrements (star.go:62); the repeat DELETE moves nothing and the column never crosses 0", async () => {
    const { doerId } = await seedCounterRepo();
    await putStar(doerId);
    await deleteStar(doerId);
    expect(await userStars(doerId)).toBe(0);
    await deleteStar(doerId); // upstream's `if !staring { return nil }` arm
    expect(await userStars(doerId)).toBe(0);
    expect(await drizzle(env.DB).select().from(stars).all()).toHaveLength(0);
  });

  it("a pre-0031 edge (backfilled counter 0 beneath a seeded star) unstarring floors at 0, never negative", async () => {
    const { doerId } = await seedCounterRepo();
    // The migration-0031 backfill shape: an edge whose user counter is the
    // ALTER default 0 (seeded directly, bypassing the route arm).
    await drizzle(env.DB).insert(stars).values({ userId: doerId, repoId: "7302", createdAt: new Date() });
    expect(await userStars(doerId)).toBe(0);
    const res = await deleteStar(doerId);
    expect(res.status).toBe(204);
    expect(await userStars(doerId)).toBe(0); // MAX(num_stars - 1, 0), not -1
  });

  it("the blocked PUT (403) precedes any write — the starrer's tally stays 0", async () => {
    const { doerId } = await seedCounterRepo();
    const owner = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "recluse")).get();
    if (owner === undefined) throw new Error("user seed failed");
    await drizzle(env.DB)
      .insert(userBlocking)
      .values({ blockerId: owner.id, blockeeId: doerId, note: "", createdAt: new Date() });
    const res = await putStar(doerId);
    expect(res.status).toBe(403);
    expect(await userStars(doerId)).toBe(0);
  });

  it("renders as starred_repos_count (structs/user.go:60 — StarredRepos, the maintained NumStars)", async () => {
    const { doerId } = await seedCounterRepo();
    await putStar(doerId);
    const row = await drizzle(env.DB).select().from(users).where(eq(users.id, doerId)).get();
    if (row === undefined) throw new Error("user seed failed");
    const rendered = toApiUser({ origin: "https://example.com", requester: null }, row);
    expect(rendered.starred_repos_count).toBe(1);
  });
});

/**
 * GET /user/starred's pagination TOTAL — upstream renders the loaded doer's
 * RAW counter for BOTH headers (star.go:117-118 — SetLinkHeader +
 * SetTotalCountHeader over `ctx.Doer.NumStars`), not a live count over the
 * star table. Ours is the maintained `users.num_stars` column (migration
 * 0031). Red→green: the pre-refactor total was the FILTERED count from
 * listStarredRepositories, which diverges from the column exactly where an
 * edge's counter sits at the pre-0031 backfill 0 — upstream renders the
 * stored field there too (a total below the listed page).
 */
describe("GET /user/starred: the total is the raw users.num_stars (star.go:117-118)", () => {
  /** The recluse-owned public pair the list paginates over. */
  async function seedListFixture(): Promise<{ doerId: number }> {
    const owner = await seedUser("recluse");
    const doer = await seedUser("stargazer");
    for (const id of ["7301", "7302"]) {
      await drizzle(env.DB).insert(repositories).values({
        id,
        storageKey: `r_${id}`,
        ownerNamespace: "recluse",
        ownerId: owner.id,
        slug: `source-${id}`,
        visibility: "public",
        refsVersion: 1,
        backend: "self-hosted",
        createdAt: new Date("2026-02-03T04:05:06Z"),
      });
    }
    return { doerId: doer.id };
  }

  const putStar = (doerId: number, slug: string) =>
    makeApp()(`/user/starred/recluse/${slug}`, { method: "PUT", headers: { Authorization: `token u${doerId}` } });

  const listStarred = (doerId: number) =>
    makeApp()("/user/starred", { headers: { Authorization: `token u${doerId}` } });

  it("star 2 repos → unstar one → the header total follows the maintained column (2 → 1)", async () => {
    const { doerId } = await seedListFixture();
    await putStar(doerId, "source-7301");
    await putStar(doerId, "source-7302");
    const first = await listStarred(doerId);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Total-Count")).toBe("2");

    await makeApp()("/user/starred/recluse/source-7301", {
      method: "DELETE",
      headers: { Authorization: `token u${doerId}` },
    });
    const res = await listStarred(doerId);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("1");
    const body: Array<Record<string, unknown>> = await res.json();
    expect(body.map((entry) => entry.name)).toEqual(["source-7302"]);
  });

  it("the header is the STORED column, not a live count — a seeded edge beneath the backfilled 0 counter renders total 0 beside a listed page (upstream renders the loaded NumStars field)", async () => {
    const { doerId } = await seedListFixture();
    // The migration-0031 backfill shape: the edge exists, the counter sits at
    // the ALTER default 0 (seeded directly, bypassing the star route arms).
    await drizzle(env.DB).insert(stars).values({ userId: doerId, repoId: "7302", createdAt: new Date() });
    const res = await listStarred(doerId);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("0"); // the column, verbatim
    const body: Array<Record<string, unknown>> = await res.json();
    expect(body).toHaveLength(1); // the body stays the filtered page, like upstream's
  });
});

/**
 * GET /users/{username}/starred's pagination TOTAL — upstream anchors it on
 * the TARGET user's RAW counter (star.go:85-86 over `ctx.ContextUser.NumStars`)
 * while the body's visibility anchor stays the DOER. Ours renders the
 * findUserByName row's `users.num_stars` column. Mounted here additively — the
 * route lives in routes/social-t2.ts; its family harness (tier2-extras.test.ts)
 * is sibling territory.
 */
describe("GET /users/{username}/starred: the total is the TARGET's raw users.num_stars (star.go:85-86)", () => {
  const socialSend = (() => {
    const app = new OpenAPIHono<ApiEnv>();
    app.onError(giteaErrorHandler);
    registerSocialT2Routes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
    return async (path: string, init?: RequestInit): Promise<Response> =>
      app.fetch(new Request(`https://example.com${path}`, init), env);
  })();

  /** recluse owns the public repo; stargazer is the doer; neighbor the target. */
  async function seedTargetFixture(): Promise<{ doerId: number }> {
    const owner = await seedUser("recluse");
    const doer = await seedUser("stargazer");
    await seedUser("neighbor");
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
    return { doerId: doer.id };
  }

  it("the total is the named user's stored counter — not the doer's and not a live count (star.go:85-86 over ContextUser.NumStars)", async () => {
    const { doerId } = await seedTargetFixture();
    // The TARGET's edge is seeded beneath the backfilled 0 counter; the DOER
    // separately stars the same repo through the route arm (doer counter → 1).
    const neighbor = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "neighbor")).get();
    if (neighbor === undefined) throw new Error("user seed failed");
    await drizzle(env.DB).insert(stars).values({ userId: neighbor.id, repoId: "7302", createdAt: new Date() });
    await makeApp()("/user/starred/recluse/source", { method: "PUT", headers: { Authorization: `token u${doerId}` } });

    const res = await socialSend("/users/neighbor/starred", {
      headers: { Authorization: `token u${doerId}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("0"); // neighbor's column, not the doer's 1
    const body: Array<Record<string, unknown>> = await res.json();
    expect(body.map((entry) => entry.name)).toEqual(["source"]); // the filtered page, doer visibility
  });
});

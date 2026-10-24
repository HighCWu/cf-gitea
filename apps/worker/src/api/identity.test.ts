/**
 * The identity self-service routes on real D1 (SPEC-0004 appendix A, the
 * follow-self appendix row + the key listings):
 * `GET /user/followers` (userCurrentListFollowers), `PUT/DELETE
 * /user/following/{username}` (userCurrentPutFollow / userCurrentDeleteFollow)
 * and the no-key-store stubs `GET /users/{username}/keys` (userListKeys) +
 * `GET /users/{username}/gpg_keys` (userListGPGKeys). Same bootstrap as
 * follows.test.ts: org migrations + the raw `follows` DDL (the table has no
 * generated migration yet — services/follows.ts header), edges seeded and
 * probed through raw D1.
 *
 * Covered upstream shapes: the doer-anchored follower listing (visibility
 * cond included); FollowUser's silent no-ops (self / already following) and
 * the UserAssignmentAPI 404; UnfollowUser's idempotent 204; the key listings'
 * empty arrays over both a user and an org target (type-blind §4.11) with
 * runtime pagination headers. All five routes reqToken upstream (401
 * runtime-only for anonymous).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "./auth";
import contract from "../compat/contract/v1-swagger.generated.json";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import type { User } from "./models/user";
import { registerIdentityRoutes } from "./routes/identity";
import { FOLLOWS_DDL_STATEMENTS, followUser, isFollowing, unfollowUser } from "./services/follows";
import { OrgService } from "../services/orgs/orgs";
import { applyOrgsDdl, resetOrgTables } from "../services/orgs/testing";

beforeAll(async () => {
  await applyOrgsDdl();
  for (const statement of FOLLOWS_DDL_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM follows").run();
  await resetOrgTables();
  seededUsers.clear();
});

const db = () => drizzle(env.DB);

const USER_FIELDS = Object.keys(contract.definitions.User.properties);

/** Seeded D1 users the test resolver can authenticate as (`token u<id>`). */
const seededUsers = new Map<number, { id: number; username: string; isAdmin: boolean }>();

interface SeededUser {
  id: number;
  username: string;
}

async function seedUser(username: string, options: { isAdmin?: boolean } = {}): Promise<SeededUser> {
  const rows = await db()
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

const authHeaders = (userId: number): Record<string, string> => ({ Authorization: `token u${userId}` });

/** API `User` projection the resolver returns (the auth middleware's shape). */
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

/** Local mount of exactly the orchestrator one-liner's seam. */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerIdentityRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

/** Raw edge probe (the table's Drizzle twin does not exist yet). */
function edgeCount(userId: number, followId: number): Promise<number> {
  return env.DB.prepare("SELECT count(*) AS n FROM follows WHERE user_id = ? AND follow_id = ?")
    .bind(userId, followId)
    .first<{ n: number }>()
    .then((row) => row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** bob follows alice; carol follows nobody; `acme` is alice's org. */
async function seedFollowGraph(): Promise<{
  alice: SeededUser;
  bob: SeededUser;
  carol: SeededUser;
  orgId: number;
}> {
  const alice = await seedUser("alice");
  const bob = await seedUser("bob");
  const carol = await seedUser("carol");
  const org = await new OrgService(env.DB).createOrg({
    name: "acme",
    ownerId: alice.id,
    now: new Date("2026-01-02T00:00:00Z"),
  });
  await followUser(env.DB, bob.id, alice.id); // bob → alice
  return { alice, bob, carol, orgId: org.id };
}

// ---------------------------------------------------------------------------
// GET /user/followers (userCurrentListFollowers)
// ---------------------------------------------------------------------------

describe("GET /user/followers (userCurrentListFollowers)", () => {
  it("lists the authenticated user's followers in contract User shapes", async () => {
    const seed = await seedFollowGraph();
    const response = await router()("/user/followers", { headers: authHeaders(seed.alice.id) });
    expect(response.status).toBe(200);
    const body: Array<Record<string, unknown>> = await response.json();
    for (const entry of body) {
      expect(Object.keys(entry).every((key) => USER_FIELDS.includes(key))).toBe(true);
    }
    // alice's only follower is bob (orgs never appear among followers).
    expect(body.map((entry) => entry.login)).toEqual(["bob"]);
    expect(response.headers.get("X-Total-Count")).toBe("1");
  });

  it("paginates with the runtime headers", async () => {
    const seed = await seedFollowGraph();
    await followUser(env.DB, seed.carol.id, seed.alice.id);
    const response = await router()("/user/followers?limit=1", { headers: authHeaders(seed.alice.id) });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Total-Count")).toBe("2");
    const link = response.headers.get("Link") ?? "";
    expect(link).toContain('rel="next"');
    expect(link).toContain('rel="last"');
  });

  it("200s an empty list and 401s anonymous callers (runtime-only; upstream reqToken)", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    const empty = await send("/user/followers", { headers: authHeaders(seed.carol.id) });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
    expect((await send("/user/followers")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PUT /user/following/{username} (userCurrentPutFollow)
// ---------------------------------------------------------------------------

describe("PUT /user/following/{username} (userCurrentPutFollow)", () => {
  it("204s and creates the edge; a repeat follow stays a single edge", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    const first = await send(`/user/following/${seed.carol.username}`, { method: "PUT", headers: authHeaders(seed.alice.id) });
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    expect(await edgeCount(seed.alice.id, seed.carol.id)).toBe(1);
    const repeat = await send(`/user/following/${seed.carol.username}`, { method: "PUT", headers: authHeaders(seed.alice.id) });
    expect(repeat.status).toBe(204);
    expect(await edgeCount(seed.alice.id, seed.carol.id)).toBe(1);
  });

  it("204s a self-follow as the upstream silent no-op (no edge)", async () => {
    const seed = await seedFollowGraph();
    const response = await router()(`/user/following/${seed.alice.username}`, {
      method: "PUT",
      headers: authHeaders(seed.alice.id),
    });
    expect(response.status).toBe(204);
    expect(await edgeCount(seed.alice.id, seed.alice.id)).toBe(0);
  });

  it("follows an org target through the type-blind assignment (the listing includes it)", async () => {
    const seed = await seedFollowGraph();
    const response = await router()("/user/following/acme", { method: "PUT", headers: authHeaders(seed.bob.id) });
    expect(response.status).toBe(204);
    expect(await isFollowing(env.DB, seed.bob.id, seed.orgId)).toBe(true);
  });

  it("404s a missing target and 401s anonymous callers", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    const missing = await send("/user/following/ghost", { method: "PUT", headers: authHeaders(seed.alice.id) });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: "https://example.com/api/swagger" });
    expect((await send("/user/following/ghost", { method: "PUT" })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DELETE /user/following/{username} (userCurrentDeleteFollow)
// ---------------------------------------------------------------------------

describe("DELETE /user/following/{username} (userCurrentDeleteFollow)", () => {
  it("204s and removes an existing edge; a not-followed target stays 204", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    await followUser(env.DB, seed.alice.id, seed.bob.id);
    const removed = await send(`/user/following/${seed.bob.username}`, { method: "DELETE", headers: authHeaders(seed.alice.id) });
    expect(removed.status).toBe(204);
    expect(await edgeCount(seed.alice.id, seed.bob.id)).toBe(0);
    const notFollowed = await send(`/user/following/${seed.carol.username}`, {
      method: "DELETE",
      headers: authHeaders(seed.alice.id),
    });
    expect(notFollowed.status).toBe(204);
  });

  it("204s a self-unfollow as the upstream silent no-op", async () => {
    const seed = await seedFollowGraph();
    const response = await router()(`/user/following/${seed.alice.username}`, {
      method: "DELETE",
      headers: authHeaders(seed.alice.id),
    });
    expect(response.status).toBe(204);
  });

  it("404s a missing target and 401s anonymous callers", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    expect((await send("/user/following/ghost", { method: "DELETE", headers: authHeaders(seed.alice.id) })).status).toBe(404);
    expect((await send("/user/following/ghost", { method: "DELETE" })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /users/{username}/keys + /gpg_keys (userListKeys / userListGPGKeys)
// ---------------------------------------------------------------------------

describe("GET /users/{username}/keys + /gpg_keys (the no-key-store stubs)", () => {
  it("renders the declared empty array for a user and an org target alike", async () => {
    await seedFollowGraph();
    const send = router();
    const viewer = authHeaders((await seedUser("viewer")).id);
    for (const path of ["/users/alice/keys", "/users/alice/gpg_keys", "/users/acme/keys", "/users/acme/gpg_keys"]) {
      const response = await send(path, { headers: viewer });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    }
  });

  it("sends the runtime pagination headers with total 0 and accepts the declared fingerprint filter", async () => {
    await seedFollowGraph();
    const response = await router()("/users/alice/keys?fingerprint=AA:BB&limit=1", {
      headers: authHeaders((await seedUser("s1")).id),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Total-Count")).toBe("0");
  });

  it("404s a missing target and 401s anonymous callers", async () => {
    await seedFollowGraph();
    const send = router();
    const viewerId = (await seedUser("s2")).id;
    for (const path of ["/users/ghost/keys", "/users/ghost/gpg_keys"]) {
      expect((await send(path, { headers: authHeaders(viewerId) })).status).toBe(404);
      expect((await send(path)).status).toBe(401);
    }
  });
});

// Service-level no-op guards (the routes' 204 halves) — pinned here so the
// contract shapes cannot regress into edge writes.
describe("follow service no-op guards", () => {
  it("followUser/unfollowUser leave no self edge and are idempotent", async () => {
    const seed = await seedFollowGraph();
    await followUser(env.DB, seed.alice.id, seed.alice.id);
    expect(await edgeCount(seed.alice.id, seed.alice.id)).toBe(0);
    await unfollowUser(env.DB, seed.alice.id, seed.orgId); // never followed
    expect(await edgeCount(seed.alice.id, seed.orgId)).toBe(0);
  });

  it("unfollowUser removes an existing edge", async () => {
    const seed = await seedFollowGraph();
    await followUser(env.DB, seed.alice.id, seed.bob.id);
    await unfollowUser(env.DB, seed.alice.id, seed.bob.id);
    expect(await isFollowing(env.DB, seed.alice.id, seed.bob.id)).toBe(false);
  });
});

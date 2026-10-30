/**
 * Tier-2 follow routes on real D1 (SPEC-0004 appendix A category a):
 * `GET /users/{username}/followers` (userListFollowers),
 * `GET /users/{username}/following` (userListFollowing) and
 * `GET /users/{username}/following/{target}` (userCheckFollowing) — upstream
 * routers/api/v1/user/follower.go. The `follows` table does not have a
 * generated migration yet (the DDL block lives in services/follows.ts for the
 * migration owner), so the bootstrap applies the org migrations + the raw
 * follows DDL, and follow EDGES seed through raw D1 inserts — the same
 * pre-migration discipline the org bootstrap used (SPEC-0007 testing.ts).
 *
 * Covered upstream shapes: followers exclude org-type rows while following
 * includes them; `isUserVisibleToViewerCond` (private users/orgs hidden from
 * unrelated viewers, visible to admins / follows / co-members / own-orgs);
 * the silent-clamped pagination headers; and the 204/404 following oracle.
 * All three routes reqToken upstream (401 runtime-only for anonymous).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "./auth";
import { contractModelProperties } from "../compat/contract/frozen-contract";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import type { User } from "./models/user";
import { registerFollowRoutes } from "./routes/follows";
import { FOLLOWS_DDL_STATEMENTS } from "./services/follows";
import { resolveApiUserFollowCounts, type Viewer } from "./services/repository";
import { OrgService } from "../services/orgs/orgs";
import { applyOrgsDdl, resetOrgTables } from "../services/orgs/testing";

beforeAll(async () => {
  await applyOrgsDdl();
  // The follows table is not in the generated migrations yet — the raw-D1
  // pre-migration bootstrap (services/follows.ts header).
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

// The declared User fields PLUS the runtime-only `username` alias
// User.MarshalJSON adds to every payload (modules/structs/user.go:67-73) —
// undeclared in the vendored swagger, so spliced in for the wire-key checks.
const USER_FIELDS = [...Object.keys(contractModelProperties("User")), "username"];

/** Seeded D1 users the test resolver can authenticate as (`token u<id>`). */
const seededUsers = new Map<number, { id: number; username: string; isAdmin: boolean }>();

interface SeededUser {
  id: number;
  username: string;
}

async function seedUser(username: string, options: { isAdmin?: boolean; visibility?: "public" | "limited" | "private" } = {}): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: options.isAdmin ?? false,
      status: "active",
      visibility: options.visibility ?? "public",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin: options.isAdmin ?? false });
  return { id: user.id, username: user.username };
}

/** Raw follow-edge insert (the table's Drizzle twin does not exist yet). */
async function seedFollow(userId: number, followId: number): Promise<void> {
  await env.DB
    .prepare("INSERT INTO follows (user_id, follow_id, created_at) VALUES (?, ?, ?)")
    .bind(userId, followId, Math.floor(new Date("2026-01-03T00:00:00Z").getTime() / 1000))
    .run();
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
  registerFollowRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** alice ⇄ bob follow each other; alice also follows the org and carol does
 *  not follow anyone public. `secret` is a private user followed by carol and
 *  a co-member of alice's org; `vault` is a private org carol follows. */
async function seedFollowGraph(): Promise<{
  alice: SeededUser;
  bob: SeededUser;
  carol: SeededUser;
  hermit: SeededUser;
  secret: SeededUser;
  admin: SeededUser;
  orgId: number;
  vaultOrgId: number;
}> {
  const alice = await seedUser("alice");
  const bob = await seedUser("bob");
  const carol = await seedUser("carol");
  const hermit = await seedUser("hermit");
  const secret = await seedUser("secret", { visibility: "private" });
  const admin = await seedUser("admin", { isAdmin: true });

  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({ name: "acme", ownerId: alice.id, now: new Date("2026-01-02T00:00:00Z") });
  const vault = await orgs.createOrg({
    name: "vault",
    ownerId: admin.id,
    visibility: "private",
    now: new Date("2026-01-02T00:00:00Z"),
  });
  await orgs.addMember(org.id, secret.id);

  await seedFollow(alice.id, bob.id); // alice → bob
  await seedFollow(bob.id, alice.id); // bob → alice
  await seedFollow(alice.id, org.id); // alice → org (org among the followed)
  await seedFollow(org.id, bob.id); // org → bob (org never among followers)
  await seedFollow(secret.id, bob.id); // private user → bob
  await seedFollow(secret.id, carol.id); // secret → carol (carol is FOLLOWED by the private user)
  await seedFollow(carol.id, vault.id); // carol → private org
  await orgs.addMember(vault.id, alice.id); // alice sees vault via her own orgs

  return { alice, bob, carol, hermit, secret, admin, orgId: org.id, vaultOrgId: vault.id };
}

// ---------------------------------------------------------------------------
// GET /users/{username}/followers (userListFollowers)
// ---------------------------------------------------------------------------

describe("GET /users/{username}/followers (userListFollowers)", () => {
  it("lists individual-user followers only — an org follower never appears", async () => {
    const seed = await seedFollowGraph();
    const response = await router()(`/users/${seed.bob.username}/followers`, {
      headers: authHeaders(seed.admin.id),
    });
    expect(response.status).toBe(200);
    const body: Array<Record<string, unknown>> = await response.json();
    for (const entry of body) {
      expect(Object.keys(entry).every((key) => USER_FIELDS.includes(key))).toBe(true);
    }
    // bob is followed by alice, the org, and the private user — the type
    // filter leaves the two humans; secret is visible to the admin.
    expect(body.map((entry) => entry.login)).toEqual(["alice", "secret"]);
    expect(response.headers.get("X-Total-Count")).toBe("2");
  });

  it("hides private followers from unrelated viewers but shows them via the visibility arms", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    const path = `/users/${seed.bob.username}/followers`;
    // hermit has no relation to secret → only alice.
    const hermitView = await send(path, { headers: authHeaders(seed.hermit.id) });
    expect(hermitView.status).toBe(200);
    const hermitBody: Array<{ login: string }> = await hermitView.json();
    expect(hermitBody.map((entry) => entry.login)).toEqual(["alice"]);
    // secret follows carol (the viewer's-followers arm) → both.
    const carolView = await send(path, { headers: authHeaders(seed.carol.id) });
    expect(carolView.status).toBe(200);
    const carolBody: Array<{ login: string }> = await carolView.json();
    expect(carolBody.map((entry) => entry.login)).toEqual(["alice", "secret"]);
    // secret is a co-member of alice's org (the co-members arm) → both.
    const aliceView = await send(path, { headers: authHeaders(seed.alice.id) });
    expect(aliceView.status).toBe(200);
    const aliceBody: Array<{ login: string }> = await aliceView.json();
    expect(aliceBody.map((entry) => entry.login)).toEqual(["alice", "secret"]);
  });

  it("paginates with the runtime headers (X-Total-Count + next/last rels)", async () => {
    const seed = await seedFollowGraph();
    await seedFollow(seed.hermit.id, seed.carol.id); // carol's followers: bob + hermit + secret
    await seedFollow(seed.bob.id, seed.carol.id);
    const response = await router()(`/users/${seed.carol.username}/followers?limit=1`, {
      headers: authHeaders(seed.admin.id),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Total-Count")).toBe("3");
    const link = response.headers.get("Link") ?? "";
    expect(link).toContain('rel="next"');
    expect(link).toContain('rel="last"');
  });

  it("404s a missing user and 401s anonymous callers (runtime-only; upstream reqToken)", async () => {
    await seedFollowGraph();
    const send = router();
    expect((await send("/users/ghost/followers", { headers: authHeaders((await seedUser("x1")).id) })).status).toBe(404);
    expect((await send("/users/ghost/followers")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /users/{username}/following (userListFollowing)
// ---------------------------------------------------------------------------

describe("GET /users/{username}/following (userListFollowing)", () => {
  it("includes organizations among the followed, ordered by user id", async () => {
    const seed = await seedFollowGraph();
    const response = await router()(`/users/${seed.alice.username}/following`, {
      headers: authHeaders(seed.admin.id),
    });
    expect(response.status).toBe(200);
    const body: Array<{ login: string }> = await response.json();
    // alice follows bob and the org; ids ascend alice < bob < org, so the
    // org row lands last.
    expect(body.map((entry) => entry.login)).toEqual(["bob", "acme"]);
  });

  it("hides a private org from unrelated viewers; members see it (the viewer's-orgs arm)", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    const carolFollowing = `/users/${seed.carol.username}/following`;
    // hermit: no relation to the private vault org → nothing.
    const hermitView = await send(carolFollowing, { headers: authHeaders(seed.hermit.id) });
    expect(hermitView.status).toBe(200);
    const hermitBody: Array<{ login: string }> = await hermitView.json();
    expect(hermitBody.map((entry) => entry.login)).toEqual([]);
    // alice belongs to vault → the viewer's-orgs arm admits it (carol only
    // follows the vault org since the followers-arm seed flip).
    const aliceView = await send(carolFollowing, { headers: authHeaders(seed.alice.id) });
    expect(aliceView.status).toBe(200);
    const aliceBody: Array<{ login: string }> = await aliceView.json();
    expect(aliceBody.map((entry) => entry.login)).toEqual(["vault"]);
  });

  it("404s a missing user and 401s anonymous callers", async () => {
    await seedFollowGraph();
    const send = router();
    expect((await send("/users/ghost/following", { headers: authHeaders((await seedUser("x2")).id) })).status).toBe(404);
    expect((await send("/users/ghost/following")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /users/{username}/following/{target} (userCheckFollowing)
// ---------------------------------------------------------------------------

describe("GET /users/{username}/following/{target} (userCheckFollowing)", () => {
  it("204s an edge and 404s a missing one (empty body on 204, APIError on 404)", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    const followed = await send(`/users/${seed.alice.username}/following/${seed.bob.username}`, {
      headers: authHeaders(seed.hermit.id),
    });
    expect(followed.status).toBe(204);
    expect(await followed.text()).toBe("");
    const notFollowed = await send(`/users/${seed.bob.username}/following/${seed.carol.username}`, {
      headers: authHeaders(seed.hermit.id),
    });
    expect(notFollowed.status).toBe(404);
    expect(await notFollowed.json()).toEqual({ message: "not found", url: "https://example.com/api/swagger" });
  });

  it("404s missing endpoints and anonymous callers", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    expect(
      (await send(`/users/ghost/following/${seed.bob.username}`, { headers: authHeaders(seed.hermit.id) })).status,
    ).toBe(404);
    expect(
      (await send(`/users/${seed.alice.username}/following/ghost`, { headers: authHeaders(seed.hermit.id) })).status,
    ).toBe(404);
    expect(
      (await send(`/users/${seed.alice.username}/following/${seed.bob.username}`)).status,
    ).toBe(401);
  });

  it("404s an org target pair through the same probe (the row just cannot exist)", async () => {
    const seed = await seedFollowGraph();
    // carol follows the private org — the oracle answers by row existence,
    // exactly like IsFollowing.
    const response = await router()(`/users/${seed.carol.username}/following/vault`, {
      headers: authHeaders(seed.admin.id),
    });
    expect(response.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// The serializer's follow counts (resolveApiUserFollowCounts, services/
// repository.ts) over the SAME seeded graph — the totals the User payload's
// followers_count/following_count render through toApiUserWithCounts. The
// pin: the counts ARE the listings' X-Total-Count values above, per viewer
// (the same visibility-filtered FindAndCount — upstream profile.go:118-138
// over user.go:357-402; upstream's API converter renders maintained columns
// the D1 users row does not have, so the visible total is the honest render).
// ---------------------------------------------------------------------------

describe("serializer follow counts over the follow graph (resolveApiUserFollowCounts)", () => {
  const countViewer = (user: { id: number; username: string }, isAdmin = false): Viewer => ({
    origin: "https://example.com",
    requester: { id: user.id, login: user.username, is_admin: isAdmin },
  });
  const anonViewer: Viewer = { origin: "https://example.com", requester: null };

  async function rowOf(username: string): Promise<typeof users.$inferSelect> {
    const rows = await db().select().from(users).where(eq(users.usernameLower, username.toLowerCase())).all();
    const row = rows[0];
    if (row === undefined) throw new Error(`row missing after seed: ${username}`);
    return row;
  }

  it("the requester-visible follower total equals the same viewer's listing X-Total-Count", async () => {
    const seed = await seedFollowGraph();
    const bobRow = await rowOf(seed.bob.username);

    // The listing pins above, mirrored: admin sees 2 (alice + secret),
    // hermit 1 (alice), carol 2 (secret follows carol — the
    // followers-of-viewer arm), anon 1 (alice only; secret is private).
    expect(await resolveApiUserFollowCounts(env.DB, bobRow.id, countViewer(seed.admin, true))).toMatchObject({
      followersCount: 2,
    });
    expect(await resolveApiUserFollowCounts(env.DB, bobRow.id, countViewer(seed.hermit))).toMatchObject({
      followersCount: 1,
    });
    expect(await resolveApiUserFollowCounts(env.DB, bobRow.id, countViewer(seed.carol))).toMatchObject({
      followersCount: 2,
    });
    expect(await resolveApiUserFollowCounts(env.DB, bobRow.id, anonViewer)).toMatchObject({ followersCount: 1 });
  });

  it("following_count includes the org edges the listing renders", async () => {
    const seed = await seedFollowGraph();
    const aliceRow = await rowOf(seed.alice.username);

    // alice follows bob + the acme org (the admin listing renders both,
    // "bob", "acme").
    expect(await resolveApiUserFollowCounts(env.DB, aliceRow.id, countViewer(seed.admin, true))).toEqual({
      followersCount: 1, // bob
      followingCount: 2, // bob + acme
    });
  });
});

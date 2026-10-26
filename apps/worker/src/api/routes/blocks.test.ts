import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import {
  follows,
  issueAssignees,
  issues,
  orgMembers,
  repoCollaborators,
  repoTransfer,
  repoWatchers,
  stars,
  userBlocking,
  users,
  repositories,
} from "../../db/schema";
import {
  assertNotBlockedForIssueContent,
  assertNotBlockedForIssueCreate,
  isUserBlockedBy,
} from "../services/blocks";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import contract from "../../compat/contract/v1-swagger.generated.json";
import { registerBlockRoutes } from "./blocks";

/**
 * The user + org block octet (routes/blocks.ts + services/blocks.ts) on real
 * D1 (migration 0022's `user_blocking`). Every DECLARED contract code of the
 * eight ops is exercised, and every upstream validation arm is pinned with
 * its exact runtime body:
 *   - 404 "user does not exist [uid: 0, name: X]" (unknown blockee, all
 *     username routes — ErrUserNotExist via APIErrorAuto);
 *   - 400 "cannot block an organization" (org blockee — including an org
 *     targeting itself);
 *   - 400 "cannot block the user" (self-block, re-block of a live pair, an
 *     org targeting its own member);
 *   - 400 "cannot unblock the user" (unblocking a pair that is not blocked);
 *   - 403 "Must be an organization owner" (reqOrgOwnership on ALL FOUR org
 *     routes, reads included — api.go:1778-1786);
 *   - 401 "token is required" (reqToken — a RUNTIME-ONLY code, asserted as
 *     behavior per the module header).
 *
 * The BlockUser cascade is verified row-by-row: follows (both directions),
 * stars / watches / collaborations / issue assignments scoped to the other
 * party's repos, and pending transfers between the pair — with unrelated
 * rows (a third user's follow/star) surviving.
 *
 * The contract self-check ("declared surface") mounts the routes on a
 * THROWAWAY standalone OpenAPIHono (the orchestrator owns router.ts) and
 * verifies every operationId/method/path exists in the frozen contract with
 * our declared codes a subset of the contract's — the wave's
 * self-verification gate, kept as a permanent regression test.
 */

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "user_blocking",
    "follows",
    "stars",
    "repo_watchers",
    "issue_assignees",
    "repo_collaborators",
    "repo_transfer",
    "issues",
    "repositories",
    "org_members",
    "user_redirects",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  seededUsers.clear();
});

const db = () => drizzle(env.DB);

const ERROR_URL = "https://example.com/api/swagger";

// ---------------------------------------------------------------------------
// Auth rig — the `u<id>` token scheme (hooks-scopes.test.ts's pattern):
// tokens bind to seeded D1 users, so the ownership gates read what the seeds
// wrote. Ids are NEVER hardcoded — every test reads the seeded ids back.
// ---------------------------------------------------------------------------

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

const seededUsers = new Map<number, SeededUser>();

async function seedUser(username: string, isAdmin = false, type: "user" | "org" = "user"): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin,
      type,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  if (type === "user") seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin });
  return { id: user.id, username: user.username, isAdmin };
}

/** API `User` projection the resolver returns (the auth middleware's shape). */
function apiUser(user: SeededUser): User {
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

const authHeaders = (userId: number): Record<string, string> => ({
  Authorization: `token u${userId}`,
  "Content-Type": "application/json",
});

/** Local mount of exactly the orchestrator one-liner's seam (the
 *  deploy-keys/secrets-variables convention; paths strip /api/v1). */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerBlockRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const get = (path: string, userId?: number): Promise<Response> =>
  router()(path, { headers: userId === undefined ? {} : authHeaders(userId) });

const put = (path: string, userId: number): Promise<Response> =>
  router()(path, { method: "PUT", headers: authHeaders(userId) });

const del = (path: string, userId: number): Promise<Response> =>
  router()(path, { method: "DELETE", headers: authHeaders(userId) });

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** The canonical user world: alice (the blocking user), bob + carol (plain
 *  second/third users), the site admin. */
async function seedWorld(): Promise<{
  alice: SeededUser;
  bob: SeededUser;
  carol: SeededUser;
  admin: SeededUser;
}> {
  const alice = await seedUser("alice");
  const bob = await seedUser("bob");
  const carol = await seedUser("carol");
  const admin = await seedUser("site-admin", true);
  return { alice, bob, carol, admin };
}

/** An org user row (orgs ARE users rows — SPEC-0007 §3.2); org rows are
 *  seeded raw because the token resolver only maps individual users. */
async function seedOrgRow(name: string): Promise<SeededUser> {
  return seedUser(name, false, "org");
}

async function seedMembership(orgId: number, userId: number, role: "owner" | "member"): Promise<void> {
  await db().insert(orgMembers).values({ orgId, userId, role, createdAt: new Date("2026-01-01T00:00:00Z") });
}

let repoSeq = 8700;

/** One user-owned repo (public). */
async function seedRepo(owner: SeededUser): Promise<{ slug: string; repoId: string }> {
  const repoId = String(repoSeq++);
  const slug = `repo${repoId}`;
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: owner.username,
    ownerId: owner.id,
    slug,
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  return { slug, repoId };
}

async function blockingRow(blockerId: number, blockeeId: number) {
  return db()
    .select()
    .from(userBlocking)
    .where(eq(userBlocking.blockerId, blockerId))
    .all()
    .then((rows) => rows.find((row) => row.blockeeId === blockeeId));
}

// ---------------------------------------------------------------------------
// Declared surface — the throwaway-app contract self-check (never router.ts)
// ---------------------------------------------------------------------------

const BLOCK_OPS: Array<[operationId: string, method: string, path: string]> = [
  ["userListBlocks", "get", "/user/blocks"],
  ["userCheckUserBlock", "get", "/user/blocks/{username}"],
  ["userBlockUser", "put", "/user/blocks/{username}"],
  ["userUnblockUser", "delete", "/user/blocks/{username}"],
  ["organizationListBlocks", "get", "/orgs/{org}/blocks"],
  ["organizationCheckUserBlock", "get", "/orgs/{org}/blocks/{username}"],
  ["organizationBlockUser", "put", "/orgs/{org}/blocks/{username}"],
  ["organizationUnblockUser", "delete", "/orgs/{org}/blocks/{username}"],
];

describe("blocks declared surface vs frozen contract", () => {
  it("every op exists in the contract and declares only contract codes", () => {
    const app = new OpenAPIHono<ApiEnv>();
    registerBlockRoutes(app, createTokenAuthMiddleware(resolver));
    const spec = app.getOpenAPIDocument({
      openapi: "3.0.3",
      info: { title: "Gitea API", version: "test" },
    }) as unknown as { paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>> };

    for (const [operationId, method, path] of BLOCK_OPS) {
      const contractOp = (contract.paths as Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>>)[path]?.[method];
      if (contractOp === undefined) {
        throw new Error(`contract missing ${method.toUpperCase()} ${path}`);
      }
      expect(contractOp.operationId).toBe(operationId);

      const specOp = spec.paths[path]?.[method];
      if (specOp === undefined) {
        throw new Error(`spec missing ${method.toUpperCase()} ${path}`);
      }
      expect(specOp.operationId).toBe(operationId);

      const contractCodes = new Set(Object.keys(contractOp.responses));
      for (const code of Object.keys(specOp.responses ?? {})) {
        expect(contractCodes.has(code), `${operationId} declares undeclared code ${code}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// User scope — blocker = the authenticated doer
// ---------------------------------------------------------------------------

describe("user blocks", () => {
  it("block → list → check round trip", async () => {
    const { alice, bob, carol } = await seedWorld();

    const blocked = await put("/api/v1/user/blocks/bob", alice.id);
    expect(blocked.status).toBe(204);

    const list = await get("/api/v1/user/blocks", alice.id);
    expect(list.status).toBe(200);
    expect(list.headers.get("X-Total-Count")).toBe("1");
    const body = await list.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: bob.id, login: "bob" });
    // carol is not blocked → absent from the list
    expect(body.some((u) => u.id === carol.id)).toBe(false);

    const check = await get("/api/v1/user/blocks/bob", alice.id);
    expect(check.status).toBe(204);

    const checkMiss = await get("/api/v1/user/blocks/carol", alice.id);
    expect(checkMiss.status).toBe(404);
    expect(await checkMiss.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("unknown blockee → 404 with the exact ErrUserNotExist body on every username route", async () => {
    const { alice } = await seedWorld();
    const notFoundBody = { message: "user does not exist [uid: 0, name: nobody]", url: ERROR_URL };

    const putRes = await put("/api/v1/user/blocks/nobody", alice.id);
    expect(putRes.status).toBe(404);
    expect(await putRes.json()).toEqual(notFoundBody);

    const deleteRes = await del("/api/v1/user/blocks/nobody", alice.id);
    expect(deleteRes.status).toBe(404);
    expect(await deleteRes.json()).toEqual(notFoundBody);

    const checkRes = await get("/api/v1/user/blocks/nobody", alice.id);
    expect(checkRes.status).toBe(404);
    expect(await checkRes.json()).toEqual(notFoundBody);
  });

  it("self-block, re-block, and org-blockee → the exact 400 arms", async () => {
    const { alice } = await seedWorld();
    await seedOrgRow("acme");

    const self = await put(`/api/v1/user/blocks/alice`, alice.id);
    expect(self.status).toBe(400);
    expect(await self.json()).toEqual({ message: "cannot block the user", url: ERROR_URL });

    await put("/api/v1/user/blocks/bob", alice.id);
    const reBlock = await put("/api/v1/user/blocks/bob", alice.id);
    expect(reBlock.status).toBe(400);
    expect(await reBlock.json()).toEqual({ message: "cannot block the user", url: ERROR_URL });

    const orgBlockee = await put("/api/v1/user/blocks/acme", alice.id);
    expect(orgBlockee.status).toBe(400);
    expect(await orgBlockee.json()).toEqual({ message: "cannot block an organization", url: ERROR_URL });
  });

  it("unblock: 204 once, then the not-blocked 400 (upstream is not idempotent)", async () => {
    const { alice } = await seedWorld();

    const coldDelete = await del("/api/v1/user/blocks/bob", alice.id);
    expect(coldDelete.status).toBe(400);
    expect(await coldDelete.json()).toEqual({ message: "cannot unblock the user", url: ERROR_URL });

    await put("/api/v1/user/blocks/bob", alice.id);
    const done = await del("/api/v1/user/blocks/bob", alice.id);
    expect(done.status).toBe(204);

    const check = await get("/api/v1/user/blocks/bob", alice.id);
    expect(check.status).toBe(404);

    const again = await del("/api/v1/user/blocks/bob", alice.id);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ message: "cannot unblock the user", url: ERROR_URL });
  });

  it("stores the ?note= query param on the blocking row", async () => {
    const { alice, bob } = await seedWorld();
    const res = await put("/api/v1/user/blocks/bob?note=spam%20logs", alice.id);
    expect(res.status).toBe(204);
    const row = await blockingRow(alice.id, bob.id);
    expect(row?.note).toBe("spam logs");
  });

  it("list paginates with upstream clamping + Link/X-Total-Count headers", async () => {
    const { alice } = await seedWorld();
    await seedUser("dave");
    await put("/api/v1/user/blocks/bob", alice.id);
    await put("/api/v1/user/blocks/carol", alice.id);
    await put(`/api/v1/user/blocks/dave`, alice.id);

    const page = await get("/api/v1/user/blocks?page=2&limit=2", alice.id);
    expect(page.status).toBe(200);
    expect(page.headers.get("X-Total-Count")).toBe("3");
    const link = page.headers.get("Link") ?? "";
    expect(link).toContain('rel="prev"');
    expect(link).toContain('rel="first"');
    const body = await page.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1); // third row only
  });

  it("401s anonymous callers (RUNTIME-ONLY reqToken code)", async () => {
    await seedWorld();
    const res = await get("/api/v1/user/blocks");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "token is required", url: ERROR_URL });
  });

  it("runs the upstream cascade on block and leaves unrelated rows alone", async () => {
    const { alice, bob, carol } = await seedWorld();
    const aliceRepo = await seedRepo(alice);
    const bobRepo = await seedRepo(bob);

    // The pair's relations (both directions of the upstream cascade):
    await db().insert(follows).values([
      { userId: alice.id, followId: bob.id, createdAt: new Date() },
      { userId: bob.id, followId: alice.id, createdAt: new Date() },
    ]);
    await db().insert(stars).values([
      { userId: bob.id, repoId: aliceRepo.repoId, createdAt: new Date() }, // bob stars alice's repo
      { userId: alice.id, repoId: bobRepo.repoId, createdAt: new Date() }, // alice stars bob's repo
    ]);
    await db().insert(repoWatchers).values({ repoId: aliceRepo.repoId, userId: bob.id, createdAt: new Date() });
    // The maintained counters mirror the live edges (what the route arms
    // counted up to this block): aliceRepo carries bob's + carol's stars and
    // bob's watch, bobRepo alice's star.
    await db().update(repositories).set({ numStars: 2, numWatches: 1 }).where(eq(repositories.id, aliceRepo.repoId));
    await db().update(repositories).set({ numStars: 1 }).where(eq(repositories.id, bobRepo.repoId));
    await db().insert(repoCollaborators).values({ repoId: aliceRepo.repoId, userId: bob.id });
    const issue = await db()
      .insert(issues)
      .values({ repoId: aliceRepo.repoId, index: 1, title: "t" })
      .returning()
      .all();
    await db().insert(issueAssignees).values({ issueId: issue[0]!.id, assigneeId: bob.id });
    await db().insert(repoTransfer).values({ repoId: bobRepo.repoId, doerId: bob.id, newOwnerId: alice.id });

    // Unrelated rows that must SURVIVE:
    await db().insert(follows).values({ userId: alice.id, followId: carol.id, createdAt: new Date() });
    await db().insert(stars).values({ userId: carol.id, repoId: aliceRepo.repoId, createdAt: new Date() });

    const res = await put("/api/v1/user/blocks/bob", alice.id);
    expect(res.status).toBe(204);

    expect(await db().select().from(follows).all()).toEqual([
      expect.objectContaining({ userId: alice.id, followId: carol.id }),
    ]);
    expect(await db().select().from(stars).all()).toEqual([
      expect.objectContaining({ userId: carol.id, repoId: aliceRepo.repoId }),
    ]);
    expect(await db().select().from(repoWatchers).all()).toEqual([]);
    expect(await db().select().from(repoCollaborators).all()).toEqual([]);
    expect(await db().select().from(issueAssignees).all()).toEqual([]);
    expect(await db().select().from(repoTransfer).all()).toEqual([]);
    expect(await blockingRow(alice.id, bob.id)).toBeDefined();

    // The cascade moves the counters with the edges (upstream decrements
    // THROUGH StarRepo(false)/WatchRepoAuto(false) per repo — block.go:
    // 172-175 → star.go:59, block.go:206-209 → watch.go:153): aliceRepo
    // keeps only carol's star and loses the watch, bobRepo drops to 0.
    const repoRows = await db().select().from(repositories).all();
    expect(repoRows.find((row) => row.id === aliceRepo.repoId)).toMatchObject({ numStars: 1, numWatches: 0 });
    expect(repoRows.find((row) => row.id === bobRepo.repoId)).toMatchObject({ numStars: 0, numWatches: 0 });
  });

  it("the cascade floors the counters at 0 when edges predate the backfill (the migration-0030 drift insurance)", async () => {
    const { alice, bob } = await seedWorld();
    const aliceRepo = await seedRepo(alice);
    // Edges seeded directly beneath the ALTER's backfilled 0 counters —
    // exactly the pre-0030 row shape.
    await db().insert(stars).values({ userId: bob.id, repoId: aliceRepo.repoId, createdAt: new Date() });
    await db().insert(repoWatchers).values({ repoId: aliceRepo.repoId, userId: bob.id, createdAt: new Date() });
    const res = await put("/api/v1/user/blocks/bob", alice.id);
    expect(res.status).toBe(204);
    const row = await db().select().from(repositories).where(eq(repositories.id, aliceRepo.repoId)).get();
    expect(row).toMatchObject({ numStars: 0, numWatches: 0 }); // floored, never negative
  });

  it("the cascade moves the per-USER tallies too — each starrer loses one num_stars (migration 0031: block.go:172-175 → star.go:62)", async () => {
    const { alice, bob, carol } = await seedWorld();
    const aliceRepo = await seedRepo(alice);
    const bobRepo = await seedRepo(bob);
    await db().insert(stars).values([
      { userId: bob.id, repoId: aliceRepo.repoId, createdAt: new Date() }, // bob stars alice's repo
      { userId: alice.id, repoId: bobRepo.repoId, createdAt: new Date() }, // alice stars bob's repo
      { userId: carol.id, repoId: aliceRepo.repoId, createdAt: new Date() }, // unrelated pair — survives
    ]);
    // The maintained tallies mirror the live edges (what the route arms
    // counted up to this block): one star each.
    for (const id of [alice.id, bob.id, carol.id]) {
      await db().update(users).set({ numStars: 1 }).where(eq(users.id, id));
    }
    const res = await put("/api/v1/user/blocks/bob", alice.id);
    expect(res.status).toBe(204);
    const rows = await db().select().from(users).all();
    expect(rows.find((row) => row.id === alice.id)).toMatchObject({ numStars: 0 }); // her edge on bob's repo removed
    expect(rows.find((row) => row.id === bob.id)).toMatchObject({ numStars: 0 }); // his edge on alice's repo removed
    expect(rows.find((row) => row.id === carol.id)).toMatchObject({ numStars: 1 }); // untouched by the cascade
  });
});

// ---------------------------------------------------------------------------
// Org scope — blocker = the org, doer gated by reqOrgOwnership (all four ops)
// ---------------------------------------------------------------------------

describe("org blocks", () => {
  /** acme with an owner (token-mapped), a plain member, and an outside user. */
  async function seedOrgWorld(): Promise<{ orgId: number; owner: SeededUser; member: SeededUser; outsider: SeededUser; admin: SeededUser }> {
    const owner = await seedUser("acme-owner");
    const member = await seedUser("acme-member");
    const outsider = await seedUser("outsider");
    const admin = await seedUser("site-admin", true);
    const org = await seedOrgRow("acme");
    await seedMembership(org.id, owner.id, "owner");
    await seedMembership(org.id, member.id, "member");
    return { orgId: org.id, owner, member, outsider, admin };
  }

  it("owner doer: block → list → check → unblock round trip", async () => {
    const { owner } = await seedOrgWorld();
    await seedUser("bob");

    const blocked = await put("/api/v1/orgs/acme/blocks/bob", owner.id);
    expect(blocked.status).toBe(204);

    const list = await get("/api/v1/orgs/acme/blocks", owner.id);
    expect(list.status).toBe(200);
    expect(list.headers.get("X-Total-Count")).toBe("1");
    const body = await list.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ login: "bob" });

    const check = await get("/api/v1/orgs/acme/blocks/bob", owner.id);
    expect(check.status).toBe(204);

    const unblocked = await del("/api/v1/orgs/acme/blocks/bob", owner.id);
    expect(unblocked.status).toBe(204);
    expect((await get("/api/v1/orgs/acme/blocks/bob", owner.id)).status).toBe(404);
  });

  it("reqOrgOwnership gates ALL FOUR ops (reads included) with the exact 403", async () => {
    const { member } = await seedOrgWorld();
    await seedUser("bob");

    const list = await get("/api/v1/orgs/acme/blocks", member.id);
    expect(list.status).toBe(403);
    expect(await list.json()).toEqual({ message: "Must be an organization owner", url: ERROR_URL });

    const check = await get("/api/v1/orgs/acme/blocks/bob", member.id);
    expect(check.status).toBe(403);

    const putRes = await put("/api/v1/orgs/acme/blocks/bob", member.id);
    expect(putRes.status).toBe(403);

    const delRes = await del("/api/v1/orgs/acme/blocks/bob", member.id);
    expect(delRes.status).toBe(403);
  });

  it("401s anonymous callers and 404s unknown orgs", async () => {
    await seedOrgWorld();
    const alice = await seedUser("alice");
    expect((await get("/api/v1/orgs/acme/blocks")).status).toBe(401);
    const missing = await get("/api/v1/orgs/ghost/blocks", alice.id);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("org arm 400s: the org itself, its own member, an unknown blockee, a cold unblock", async () => {
    const { owner } = await seedOrgWorld();

    const self = await put("/api/v1/orgs/acme/blocks/acme", owner.id);
    expect(self.status).toBe(400);
    expect(await self.json()).toEqual({ message: "cannot block an organization", url: ERROR_URL });

    const memberBlock = await put("/api/v1/orgs/acme/blocks/acme-member", owner.id);
    expect(memberBlock.status).toBe(400);
    expect(await memberBlock.json()).toEqual({ message: "cannot block the user", url: ERROR_URL });

    const unknown = await put("/api/v1/orgs/acme/blocks/nobody", owner.id);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ message: "user does not exist [uid: 0, name: nobody]", url: ERROR_URL });

    const cold = await del("/api/v1/orgs/acme/blocks/acme-member", owner.id);
    expect(cold.status).toBe(400);
    expect(await cold.json()).toEqual({ message: "cannot unblock the user", url: ERROR_URL });
  });

  it("org re-block hits the same 400 as the user scope", async () => {
    const { owner } = await seedOrgWorld();
    await seedUser("bob");
    await put("/api/v1/orgs/acme/blocks/bob", owner.id);
    const reBlock = await put("/api/v1/orgs/acme/blocks/bob", owner.id);
    expect(reBlock.status).toBe(400);
    expect(await reBlock.json()).toEqual({ message: "cannot block the user", url: ERROR_URL });
  });

  it("a site-admin doer passes the ownership gate (upstream IsAdmin arm)", async () => {
    const { admin } = await seedOrgWorld();
    await seedUser("bob");
    const res = await put("/api/v1/orgs/acme/blocks/bob", admin.id);
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// The enforcement probes (the wave-blocks-enforcement service surface):
// IsUserBlockedBy (models/user/block.go:41-45) and the two composed issue
// arms the landed route families call.
// ---------------------------------------------------------------------------

describe("enforcement probes (services/blocks.ts)", () => {
  it("isUserBlockedBy: multi-blocker probe with the site-admin blockee bypass (block.go:41-45)", async () => {
    const { alice, bob, admin } = await seedWorld();
    await put("/api/v1/user/blocks/bob", alice.id); // alice blocks bob

    // bob (the blockee) is blocked by alice — any-order probe
    expect(await isUserBlockedBy(env.DB, { id: bob.id, isAdmin: false }, alice.id, 999)).toBe(true);
    expect(await isUserBlockedBy(env.DB, { id: bob.id, isAdmin: false }, 999, alice.id)).toBe(true);
    // and by nobody else
    expect(await isUserBlockedBy(env.DB, { id: bob.id, isAdmin: false }, 999)).toBe(false);
    // a site-admin blockee is never blocked-by (the IsAdmin short-circuit)
    expect(await isUserBlockedBy(env.DB, { id: admin.id, isAdmin: true }, alice.id)).toBe(false);
    // no blocker ids → false
    expect(await isUserBlockedBy(env.DB, { id: bob.id, isAdmin: false })).toBe(false);
  });

  it("assertNotBlockedForIssueCreate throws only when the doer is blocked by the repo owner (issue.go:33-34)", async () => {
    const { alice, bob, admin } = await seedWorld();
    await put("/api/v1/user/blocks/bob", alice.id); // alice blocks bob

    await expect(assertNotBlockedForIssueCreate(env.DB, { id: bob.id, isAdmin: false }, alice.id)).rejects.toMatchObject({
      status: 403,
      message: "user is blocked",
    });
    // no repo owner → no probe
    await expect(assertNotBlockedForIssueCreate(env.DB, { id: bob.id, isAdmin: false }, null)).resolves.toBeUndefined();
    // the site-admin doer bypasses
    await expect(assertNotBlockedForIssueCreate(env.DB, { id: admin.id, isAdmin: true }, alice.id)).resolves.toBeUndefined();
  });

  it("assertNotBlockedForIssueContent: 403 blocked-by-poster-or-owner, repo-admin bypass (comments.go:63-65/106-108, issue.go:104-106, content.go:21-23)", async () => {
    const { alice, bob, carol } = await seedWorld();
    await put("/api/v1/user/blocks/bob", alice.id); // alice blocks bob

    // blocked by the issue poster → throws
    await expect(
      assertNotBlockedForIssueContent(env.DB, { id: bob.id, isAdmin: false }, false, alice.id, carol.id),
    ).rejects.toMatchObject({ status: 403, message: "user is blocked" });
    // blocked by the repo owner → throws
    await expect(
      assertNotBlockedForIssueContent(env.DB, { id: bob.id, isAdmin: false }, false, carol.id, alice.id),
    ).rejects.toMatchObject({ status: 403, message: "user is blocked" });
    // repo admin bypasses even while blocked
    await expect(
      assertNotBlockedForIssueContent(env.DB, { id: bob.id, isAdmin: false }, true, alice.id, alice.id),
    ).resolves.toBeUndefined();
    // clear path resolves
    await expect(
      assertNotBlockedForIssueContent(env.DB, { id: carol.id, isAdmin: false }, false, alice.id, alice.id),
    ).resolves.toBeUndefined();
  });
});

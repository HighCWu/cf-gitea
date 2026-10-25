/**
 * The three non-repository webhook scopes on real D1 (batch 2 of the
 * remaining-API inventory — organization, user, admin; behavior ports
 * gitea/routers/api/v1/{org/hook.go,user/hook.go,admin/hooks.go} over the
 * shared utils/hook.go bodies). Seeds `users` (orgs through the landed
 * OrgService) + `webhooks` rows through Drizzle, mounts the module on a local
 * OpenAPIHono with the REAL auth middlewares (the same seam the orchestrator's
 * `registerHookScopeRoutes(app, requireAuth)` one-liner passes — the `u<id>`
 * token scheme binds tokens to the seeded D1 rows, so the org-ownership and
 * site-admin gates read the same rows the writes did), and asserts the
 * upstream ports exactly: the owner-scoped id isolation (org hooks never
 * answer another org's or the owner's own user ids), the global-scope
 * `repo_id=0 AND owner_id=0` NULL adaptation, the `type` filter of
 * adminListHooks, the reqOrgOwnership / reqSiteAdmin 403 messages, and the
 * contract Hook field set on every arm.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { users, webhooks } from "../../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerHookScopeRoutes } from "./hooks-scopes";
import { OrgService } from "../../services/orgs/orgs";
import contract from "../../compat/contract/v1-swagger.generated.json";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["webhook_deliveries", "webhooks", "org_members", "user_redirects", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  seededUsers.clear();
});

const db = () => drizzle(env.DB);

const HOOK_FIELDS = Object.keys(contract.definitions.Hook.properties).sort();
const ERROR_URL = "https://example.com/api/swagger";

// ---------------------------------------------------------------------------
// Auth rig — the `u<id>` token scheme (orgs.test.ts's pattern): tokens bind
// to seeded D1 users, so the ownership gates read what the seeds wrote.
// ---------------------------------------------------------------------------

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

const seededUsers = new Map<number, SeededUser>();

async function seedUser(username: string, isAdmin = false): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin });
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

/** Local mount of exactly the orchestrator one-liner's seam. */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerHookScopeRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

interface OrgSeed {
  orgId: number;
  owner: SeededUser;
  member: SeededUser;
  outsider: SeededUser;
  admin: SeededUser;
}

/** The standard org: an owner, a plain member, an outsider and a site admin. */
async function seedOrg(name = "acme", visibility: "public" | "limited" | "private" = "public"): Promise<OrgSeed> {
  const owner = await seedUser(`${name}-owner`);
  const member = await seedUser(`${name}-member`);
  const outsider = await seedUser("outsider");
  const admin = await seedUser("site-admin", true);
  const org = await new OrgService(env.DB).createOrg({
    name,
    ownerId: owner.id,
    visibility,
    now: new Date("2026-01-02T00:00:00Z"),
  });
  await new OrgService(env.DB).addMember(org.id, member.id);
  return { orgId: org.id, owner, member, outsider, admin };
}

interface SeedHookInput {
  url?: string;
  type?: string;
  active?: boolean;
  ownerId?: number | null;
  repoId?: string | null;
  isSystemWebhook?: boolean;
  events?: string;
}

/** Direct row insert — the scope columns make the row org/user/global/repo. */
async function seedHook(input: SeedHookInput = {}): Promise<number> {
  const rows = await db()
    .insert(webhooks)
    .values({
      ownerId: input.ownerId ?? null,
      repoId: input.repoId ?? null,
      isSystemWebhook: input.isSystemWebhook ?? false,
      name: "seeded",
      url: input.url ?? "https://hooks.example.com/target",
      contentType: 1,
      events: input.events ?? JSON.stringify({ choose_events: true, branch_filter: "", events: { push: true } }),
      isActive: input.active ?? false,
      type: input.type ?? "gitea",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning({ id: webhooks.id })
    .all();
  const hook = rows[0];
  if (hook === undefined) throw new Error("hook seed failed");
  return hook.id;
}

const createBody = JSON.stringify({
  type: "gitea",
  config: { url: "https://hooks.example.com/ci", content_type: "json", secret: "s3cret" },
});

function expectHookFields(body: Record<string, unknown>): void {
  expect(Object.keys(body).sort()).toEqual(HOOK_FIELDS);
}

// ---------------------------------------------------------------------------
// Organization scope (orgListHooks / orgCreateHook / orgGetHook / orgEditHook
// / orgDeleteHook) — routers/api/v1/org/hook.go over utils/hook.go
// ---------------------------------------------------------------------------

describe("POST /orgs/{org}/hooks (orgCreateHook)", () => {
  it("creates for an owner with the contract Hook field set and upstream defaults (active FALSE, events [push])", async () => {
    const seed = await seedOrg();

    const res = await router()(`/orgs/acme/hooks`, { method: "POST", headers: authHeaders(seed.owner.id), body: createBody });

    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expectHookFields(body);
    expect(body).toMatchObject({
      type: "gitea",
      name: "",
      active: false, // CreateHookOption.active defaults to FALSE (SPEC-0004 §2.4)
      branch_filter: "",
      config: { url: "https://hooks.example.com/ci", content_type: "json" },
      events: ["push"], // empty events list defaults to push (updateHookEvents)
      authorization_header: "", // the stored secret never renders
    });
    expect(typeof body.id).toBe("number");

    // Storage: owner-scoped row — ownerId set, repoId NULL (upstream owner_id
    // = owner.ID, repo_id = 0).
    const stored = await db().select().from(webhooks).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      ownerId: seed.owner.id,
      repoId: null,
      url: "https://hooks.example.com/ci",
      secret: "s3cret",
      httpMethod: "POST",
    });
  });

  it("lets a site admin create (reqOrgOwnership admin bypass) but 403s a member/outsider with upstream's message", async () => {
    const seed = await seedOrg();

    const adminRes = await router()("/orgs/acme/hooks", { method: "POST", headers: authHeaders(seed.admin.id), body: createBody });
    expect(adminRes.status).toBe(201);

    const memberRes = await router()("/orgs/acme/hooks", { method: "POST", headers: authHeaders(seed.member.id), body: createBody });
    expect(memberRes.status).toBe(403);
    expect(await memberRes.json()).toEqual({ message: "Must be an organization owner", url: ERROR_URL });

    const outsiderRes = await router()("/orgs/acme/hooks", { method: "POST", headers: authHeaders(seed.outsider.id), body: createBody });
    expect(outsiderRes.status).toBe(403);
    expect(await outsiderRes.json()).toEqual({ message: "Must be an organization owner", url: ERROR_URL });
  });

  it("401s an anonymous caller and 404s a missing org", async () => {
    const seed = await seedOrg();

    const anon = await router()("/orgs/acme/hooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: createBody });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ message: "token is required", url: ERROR_URL });

    const missing = await router()("/orgs/ghost/hooks", { method: "POST", headers: authHeaders(seed.owner.id), body: createBody });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("runs the shared checkCreateHookOption validation (422 missing url, exact upstream message)", async () => {
    const seed = await seedOrg();

    const res = await router()("/orgs/acme/hooks", {
      method: "POST",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ type: "gitea", config: { content_type: "json" } }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ message: "Missing config option: url", url: ERROR_URL });
    expect(await db().select().from(webhooks).all()).toHaveLength(0);
  });
});

describe("GET /orgs/{org}/hooks (orgListHooks)", () => {
  it("lists the org's hooks id ASC with pagination headers and nothing else's", async () => {
    const seed = await seedOrg();
    const otherUser = await seedUser("hook-owner");
    const a = await seedHook({ ownerId: seed.owner.id, url: "https://one.example.com" });
    const b = await seedHook({ ownerId: seed.owner.id, url: "https://two.example.com" });
    // The owner's own USER hook, another user's hook, a repo hook and a
    // system hook never leak into the org listing (owner_id = ? alone).
    await seedHook({ ownerId: null, url: "https://unscoped.example.com" });
    await seedHook({ ownerId: otherUser.id, url: "https://user.example.com" });
    await seedHook({ repoId: "repo-x", url: "https://repo.example.com" });
    await seedHook({ isSystemWebhook: true, url: "https://system.example.com" });

    const res = await router()("/orgs/acme/hooks", { headers: authHeaders(seed.owner.id) });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((hook) => (hook.config as Record<string, string>).url)).toEqual([
      "https://one.example.com",
      "https://two.example.com",
    ]);
    expect(body.map((hook) => hook.id)).toEqual([a, b].sort((x, y) => x - y));
    for (const hook of body) expectHookFields(hook);
  });

  it("paginates with limit/page (X-Total-Count stays the full count)", async () => {
    const seed = await seedOrg();
    await seedHook({ ownerId: seed.owner.id, url: "https://one.example.com" });
    await seedHook({ ownerId: seed.owner.id, url: "https://two.example.com" });

    const res = await router()("/orgs/acme/hooks?limit=1&page=2", { headers: authHeaders(seed.owner.id) });
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(res.headers.get("Link")).toContain('rel="prev"');
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1);
    expect(((body[0]?.config ?? {}) as Record<string, string>).url).toBe("https://two.example.com");
  });

  it("404s a missing org; a private org 404s a non-member outsider but 200s the owner", async () => {
    const seed = await seedOrg("darkco", "private");
    await seedHook({ ownerId: seed.owner.id });

    const missing = await router()("/orgs/ghost/hooks", { headers: authHeaders(seed.owner.id) });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });

    const outsider = await router()("/orgs/darkco/hooks", { headers: authHeaders(seed.outsider.id) });
    expect(outsider.status).toBe(404);

    const owner = await router()("/orgs/darkco/hooks", { headers: authHeaders(seed.owner.id) });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toHaveLength(1);
  });
});

describe("GET/PATCH/DELETE /orgs/{org}/hooks/{id} (orgGetHook / orgEditHook / orgDeleteHook)", () => {
  it("gets one hook by org-scoped id and 404s another org's hook and non-integer ids", async () => {
    const seed = await seedOrg();
    const id = await seedHook({ ownerId: seed.owner.id, url: "https://one.example.com", active: true });
    const otherOwner = await seedUser("other-org-owner");
    await seedHook({ ownerId: otherOwner.id, url: "https://elsewhere.example.com" });

    const res = await router()(`/orgs/acme/hooks/${id}`, { headers: authHeaders(seed.owner.id) });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expectHookFields(body);
    expect(body).toMatchObject({ id, name: "seeded", active: true });

    for (const bad of ["9999", "abc", "0"]) {
      const miss = await router()(`/orgs/acme/hooks/${bad}`, { headers: authHeaders(seed.owner.id) });
      expect(miss.status).toBe(404);
      expect(await miss.json()).toEqual({ message: "not found", url: ERROR_URL });
    }
  });

  it("patches a partial update and keeps the unspecified fields; 404s a foreign-org id", async () => {
    const seed = await seedOrg();
    const id = await seedHook({
      ownerId: seed.owner.id,
      url: "https://old.example.com",
      events: JSON.stringify({ choose_events: true, branch_filter: "dev*", events: { push: true, issues: true } }),
    });

    const res = await router()(`/orgs/acme/hooks/${id}`, {
      method: "PATCH",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({
        active: true,
        config: { url: "https://new.example.com" },
        events: ["push", "release"], // resupplied — the rewrite is unconditional
        branch_filter: "dev*",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ id, active: true });
    expect((body.config as Record<string, string>).url).toBe("https://new.example.com");
    expect(body.events).toEqual(["push", "release"]);
    expect(body.branch_filter).toBe("dev*");

    // The PATCH quirk (utils/hook.go editHook): events + branch_filter apply
    // UNCONDITIONALLY — a PATCH without them resets to push-only and clears.
    const quirk = await router()(`/orgs/acme/hooks/${id}`, {
      method: "PATCH",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(quirk.status).toBe(200);
    const quirkBody = await quirk.json<Record<string, unknown>>();
    expect(quirkBody.name).toBe("renamed");
    expect(quirkBody.events).toEqual(["push"]);
    expect(quirkBody.branch_filter).toBe("");
  });

  it("deletes with 204, then 404s the same id; another org's id is a 404 and stays untouched", async () => {
    const seed = await seedOrg();
    const id = await seedHook({ ownerId: seed.owner.id });
    const otherOwner = await seedUser("other-org-owner");
    const foreignId = await seedHook({ ownerId: otherOwner.id });

    const del = await router()(`/orgs/acme/hooks/${id}`, { method: "DELETE", headers: authHeaders(seed.owner.id) });
    expect(del.status).toBe(204);
    expect(await db().select().from(webhooks).all()).toHaveLength(1); // the foreign row survives

    const again = await router()(`/orgs/acme/hooks/${id}`, { method: "DELETE", headers: authHeaders(seed.owner.id) });
    expect(again.status).toBe(404);

    const foreign = await router()(`/orgs/acme/hooks/${foreignId}`, { method: "DELETE", headers: authHeaders(seed.owner.id) });
    expect(foreign.status).toBe(404);
  });

  it("gates every {id} arm on ownership (403 member) and the org gate (404 missing org)", async () => {
    const seed = await seedOrg();
    const id = await seedHook({ ownerId: seed.owner.id });

    const memberGet = await router()(`/orgs/acme/hooks/${id}`, { headers: authHeaders(seed.member.id) });
    expect(memberGet.status).toBe(403);
    expect(await memberGet.json()).toEqual({ message: "Must be an organization owner", url: ERROR_URL });

    const memberDelete = await router()(`/orgs/acme/hooks/${id}`, { method: "DELETE", headers: authHeaders(seed.member.id) });
    expect(memberDelete.status).toBe(403);

    const missingGet = await router()(`/orgs/ghost/hooks/${id}`, { headers: authHeaders(seed.owner.id) });
    expect(missingGet.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// User scope (userListHooks / userCreateHook / userGetHook / userEditHook /
// userDeleteHook) — routers/api/v1/user/hook.go, the doer as owner
// ---------------------------------------------------------------------------

describe("POST /user/hooks (userCreateHook)", () => {
  it("creates for the doer with the contract Hook field set and owner-scoped storage", async () => {
    const doer = await seedUser("hook-user");

    const res = await router()("/user/hooks", { method: "POST", headers: authHeaders(doer.id), body: createBody });

    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expectHookFields(body);
    expect(body).toMatchObject({
      type: "gitea",
      active: false,
      events: ["push"],
      config: { url: "https://hooks.example.com/ci", content_type: "json" },
    });

    const stored = await db().select().from(webhooks).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ ownerId: doer.id, repoId: null });
  });

  it("requires a token (401) and validates the body through the shared core (422)", async () => {
    const doer = await seedUser("hook-user");

    const anon = await router()("/user/hooks", { method: "POST", body: createBody });
    expect(anon.status).toBe(401);

    const invalid = await router()("/user/hooks", {
      method: "POST",
      headers: authHeaders(doer.id),
      body: JSON.stringify({ type: "gitea", config: { content_type: "json" } }),
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ message: "Missing config option: url", url: ERROR_URL });
  });
});

describe("GET /user/hooks (userListHooks)", () => {
  it("lists ONLY the doer's hooks id ASC with pagination headers", async () => {
    const doer = await seedUser("hook-user");
    const neighbor = await seedUser("neighbor");
    const a = await seedHook({ ownerId: doer.id, url: "https://one.example.com" });
    const b = await seedHook({ ownerId: doer.id, url: "https://two.example.com" });
    await seedHook({ ownerId: neighbor.id, url: "https://neighbor.example.com" });
    await seedHook({ repoId: "repo-x", url: "https://repo.example.com" });
    await seedHook({ isSystemWebhook: true, url: "https://system.example.com" });

    const res = await router()("/user/hooks", { headers: authHeaders(doer.id) });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((hook) => hook.id)).toEqual([a, b].sort((x, y) => x - y));
    for (const hook of body) expectHookFields(hook);
  });

  it("401s an anonymous caller", async () => {
    await seedUser("hook-user");
    const res = await router()("/user/hooks");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "token is required", url: ERROR_URL });
  });
});

describe("GET/PATCH/DELETE /user/hooks/{id} (userGetHook / userEditHook / userDeleteHook)", () => {
  it("gets/patches/deletes the doer's own hook and 404s a neighbor's id", async () => {
    const doer = await seedUser("hook-user");
    const neighbor = await seedUser("neighbor");
    const id = await seedHook({ ownerId: doer.id, active: false });
    const neighborId = await seedHook({ ownerId: neighbor.id });

    const get = await router()(`/user/hooks/${id}`, { headers: authHeaders(doer.id) });
    expect(get.status).toBe(200);
    const body = await get.json<Record<string, unknown>>();
    expectHookFields(body);
    expect(body).toMatchObject({ id, active: false });

    const patch = await router()(`/user/hooks/${id}`, {
      method: "PATCH",
      headers: authHeaders(doer.id),
      body: JSON.stringify({ active: true, name: "mine" }),
    });
    expect(patch.status).toBe(200);
    const patched = await patch.json<Record<string, unknown>>();
    expect(patched).toMatchObject({ id, active: true, name: "mine" });
    // The unconditional subscription rewrite quirk, user arm.
    expect(patched.events).toEqual(["push"]);
    expect(patched.branch_filter).toBe("");

    const del = await router()(`/user/hooks/${id}`, { method: "DELETE", headers: authHeaders(doer.id) });
    expect(del.status).toBe(204);
    expect(await db().select().from(webhooks).all()).toHaveLength(1); // the neighbor's row survives

    // The doer's own id is gone; the neighbor's id was never visible.
    const gone = await router()(`/user/hooks/${id}`, { headers: authHeaders(doer.id) });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ message: "not found", url: ERROR_URL });
    const neighborMiss = await router()(`/user/hooks/${neighborId}`, { headers: authHeaders(doer.id) });
    expect(neighborMiss.status).toBe(404);
    const neighborDelete = await router()(`/user/hooks/${neighborId}`, { method: "DELETE", headers: authHeaders(doer.id) });
    expect(neighborDelete.status).toBe(404);
  });

  it("401s an anonymous caller on every {id} arm", async () => {
    const doer = await seedUser("hook-user");
    const id = await seedHook({ ownerId: doer.id });
    for (const [method, init] of [
      ["GET", {}],
      ["PATCH", { body: JSON.stringify({ active: true }) }],
      ["DELETE", {}],
    ] as const) {
      const res = await router()(`/user/hooks/${id}`, { method, ...init });
      expect(res.status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// Admin scope (adminListHooks / adminCreateHook / adminGetHook / adminEditHook
// / adminDeleteHook) — routers/api/v1/admin/hooks.go over webhook_system.go
// ---------------------------------------------------------------------------

describe("POST /admin/hooks (adminCreateHook)", () => {
  it("creates a global webhook for a site admin with the contract field set", async () => {
    const admin = await seedUser("root", true);

    const res = await router()("/admin/hooks", { method: "POST", headers: authHeaders(admin.id), body: createBody });

    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expectHookFields(body);
    expect(body).toMatchObject({
      type: "gitea",
      active: false,
      events: ["push"],
      config: { url: "https://hooks.example.com/ci", content_type: "json" },
    });

    // Storage: global row — ownerId + repoId both NULL (upstream 0/0);
    // is_system_webhook defaults false → a "default" global hook (AddSystemHook
    // parses the flag from config exactly like addHook does for every scope).
    const stored = await db().select().from(webhooks).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ ownerId: null, repoId: null, isSystemWebhook: false });
  });

  it("honors the is_system_webhook config key (true → system row)", async () => {
    const admin = await seedUser("root", true);
    const res = await router()("/admin/hooks", {
      method: "POST",
      headers: authHeaders(admin.id),
      body: JSON.stringify({
        type: "gitea",
        config: { url: "https://hooks.example.com/sys", content_type: "json", is_system_webhook: "true" },
      }),
    });
    expect(res.status).toBe(201);
    const stored = await db().select().from(webhooks).all();
    expect(stored[0]).toMatchObject({ ownerId: null, repoId: null, isSystemWebhook: true });
  });

  it("403s a non-site-admin with upstream's exact message and 401s an anonymous caller", async () => {
    const user = await seedUser("plain");
    await seedUser("root", true);

    const forbidden = await router()("/admin/hooks", { method: "POST", headers: authHeaders(user.id), body: createBody });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ message: "user should be the site admin", url: ERROR_URL });

    const anon = await router()("/admin/hooks", { method: "POST", body: createBody });
    expect(anon.status).toBe(401);
    expect(await db().select().from(webhooks).all()).toHaveLength(0);
  });
});

describe("GET /admin/hooks (adminListHooks)", () => {
  it("defaults to system rows only; type=default and type=all flip/unfilter the set", async () => {
    const admin = await seedUser("root", true);
    await seedHook({ isSystemWebhook: true, url: "https://sys-one.example.com" });
    await seedHook({ isSystemWebhook: true, url: "https://sys-two.example.com" });
    await seedHook({ isSystemWebhook: false, url: "https://default-one.example.com" });
    // Scoped rows never appear in the global listing regardless of type.
    await seedHook({ ownerId: admin.id, url: "https://user.example.com" });
    await seedHook({ repoId: "repo-x", url: "https://repo.example.com" });

    const urls = async (query: string) => {
      const res = await router()(`/admin/hooks${query}`, { headers: authHeaders(admin.id) });
      expect(res.status).toBe(200);
      const body = await res.json<Array<Record<string, unknown>>>();
      return body.map((hook) => (hook.config as Record<string, string>).url);
    };

    const systemUrls = ["https://sys-one.example.com", "https://sys-two.example.com"];
    expect(await urls("")).toEqual(systemUrls);
    expect(await urls("?type=system")).toEqual(systemUrls);
    expect(await urls("?type=default")).toEqual(["https://default-one.example.com"]);
    expect(await urls("?type=all")).toEqual([...systemUrls, "https://default-one.example.com"]);
    // An unlisted value behaves like "system" (upstream's switch leaves the
    // Some(true) default).
    expect(await urls("?type=bogus")).toEqual(systemUrls);
  });

  it("paginates and 403s a non-site-admin", async () => {
    const admin = await seedUser("root", true);
    const user = await seedUser("plain");
    await seedHook({ isSystemWebhook: true, url: "https://one.example.com" });
    await seedHook({ isSystemWebhook: true, url: "https://two.example.com" });

    const page = await router()("/admin/hooks?limit=1&page=2", { headers: authHeaders(admin.id) });
    expect(page.headers.get("X-Total-Count")).toBe("2");
    expect(page.headers.get("Link")).toContain('rel="prev"');
    const body = await page.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1);

    const forbidden = await router()("/admin/hooks", { headers: authHeaders(user.id) });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ message: "user should be the site admin", url: ERROR_URL });
  });
});

describe("GET/PATCH/DELETE /admin/hooks/{id} (adminGetHook / adminEditHook / adminDeleteHook)", () => {
  it("gets/patches/deletes a global webhook of either kind and 404s scoped ids", async () => {
    const admin = await seedUser("root", true);
    const systemId = await seedHook({ isSystemWebhook: true, url: "https://sys.example.com" });
    const defaultId = await seedHook({ isSystemWebhook: false, url: "https://default.example.com" });
    const ownerId = await seedHook({ ownerId: admin.id });
    const repoId = await seedHook({ repoId: "repo-x" });

    for (const id of [systemId, defaultId]) {
      const get = await router()(`/admin/hooks/${id}`, { headers: authHeaders(admin.id) });
      expect(get.status).toBe(200);
      const body = await get.json<Record<string, unknown>>();
      expectHookFields(body);
      expect(body.id).toBe(id);
    }

    const patch = await router()(`/admin/hooks/${systemId}`, {
      method: "PATCH",
      headers: authHeaders(admin.id),
      body: JSON.stringify({ active: true, config: { url: "https://moved.example.com" } }),
    });
    expect(patch.status).toBe(200);
    const patched = await patch.json<Record<string, unknown>>();
    expect(patched).toMatchObject({ id: systemId, active: true });
    expect((patched.config as Record<string, string>).url).toBe("https://moved.example.com");
    expect(patched.events).toEqual(["push"]); // unconditional rewrite quirk, admin arm

    const del = await router()(`/admin/hooks/${systemId}`, { method: "DELETE", headers: authHeaders(admin.id) });
    expect(del.status).toBe(204);
    const remaining = await db().select().from(webhooks).all();
    expect(remaining.map((row) => row.id).sort()).toEqual([defaultId, ownerId, repoId].sort());

    // Scoped ids are 404s for every {id} arm (the global-scope condition).
    for (const id of [ownerId, repoId, systemId]) {
      const miss = await router()(`/admin/hooks/${id}`, { headers: authHeaders(admin.id) });
      expect(miss.status).toBe(404);
      expect(await miss.json()).toEqual({ message: "not found", url: ERROR_URL });
      const delMiss = await router()(`/admin/hooks/${id}`, { method: "DELETE", headers: authHeaders(admin.id) });
      expect(delMiss.status).toBe(404);
    }
  });

  it("403s a non-site-admin and 401s an anonymous caller", async () => {
    const user = await seedUser("plain");
    const id = await seedHook({ isSystemWebhook: true });

    const forbidden = await router()(`/admin/hooks/${id}`, { headers: authHeaders(user.id) });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ message: "user should be the site admin", url: ERROR_URL });

    const anon = await router()(`/admin/hooks/${id}`);
    expect(anon.status).toBe(401);
  });
});

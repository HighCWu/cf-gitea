/**
 * The actions secrets/variables families (routes/secrets-variables.ts — the
 * inventory's `wave-api-secrets-variables` batch) on real D1 (migration
 * 0021's `secrets` + `action_variables`): all 23 contract ops over the
 * standalone-mount convention (the routes ARE registered in router.ts by the
 * orchestrator after this batch).
 *
 * Per-arm contract verification: every DECLARED response code of every op is
 * exercised — secrets list {200,404}, secret PUT {201,204,400,404}, secret
 * DELETE {204,400,404}, variables list/get {200,400,404}, variable create
 * {201,400,409} (+ the repo/org arms' 500), variable PUT {201,204,400,404},
 * variable DELETE {200,201,204,400,404} (the user arm without the 200). The
 * declared-but-unreachable arms (the reads' 400, the dead 201/200
 * leftovers) are pinned by the `⊆ contract` check (pnpm check:api), not
 * runtime — the module header documents each. The RUNTIME-ONLY codes stay
 * undeclared per the module header and are asserted as behavior: 401
 * (anonymous), the repo arm's reqOwner 403 (an admin-mode COLLABORATOR ranks
 * below AccessModeOwner — the precise gate this family differs from
 * deploy-keys on), the org arm's reqOrgOwnership 403, and the Go binder's
 * 422 Required texts.
 *
 * The scope encoding is pinned end-to-end: a repo row carries owner_id=0 +
 * the TEXT repo id, an owner row carries the int owner + repo_id='' — lists
 * in one scope never leak rows from another, names are stored UPPERCASE and
 * matched case-insensitively, variable values are EOL-normalized, secret
 * data never renders.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { repositories, users } from "../../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerSecretsVariablesRoutes } from "./secrets-variables";
import { OrgService } from "../../services/orgs/orgs";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["secrets", "action_variables", "repo_collaborators", "repositories", "org_members", "user_redirects", "users"]) {
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

/** Local mount of exactly the orchestrator one-liner's seam. The registry
 *  paths are relative to the /api/v1 mount, so fetched paths strip the
 *  prefix (the deploy-keys.test.ts convention). */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerSecretsVariablesRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const get = (path: string, userId?: number): Promise<Response> =>
  router()(path, { headers: userId === undefined ? {} : authHeaders(userId) });

const put = (path: string, body: unknown, userId?: number): Promise<Response> =>
  router()(path, {
    method: "PUT",
    headers: userId === undefined ? { "Content-Type": "application/json" } : authHeaders(userId),
    body: JSON.stringify(body),
  });

const post = (path: string, body: unknown, userId?: number): Promise<Response> =>
  router()(path, {
    method: "POST",
    headers: userId === undefined ? { "Content-Type": "application/json" } : authHeaders(userId),
    body: JSON.stringify(body),
  });

const del = (path: string, userId?: number): Promise<Response> =>
  router()(path, { method: "DELETE", headers: userId === undefined ? {} : authHeaders(userId) });

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** The canonical user world: alice (the repo owner by login match), bob (a
 *  plain second user), the site admin. */
async function seedWorld(): Promise<{ alice: SeededUser; bob: SeededUser; admin: SeededUser }> {
  const alice = await seedUser("alice");
  const bob = await seedUser("bob");
  const admin = await seedUser("site-admin", true);
  return { alice, bob, admin };
}

let repoSeq = 8600;

/** One user-owned repo (public, not archived). */
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

interface OrgSeed {
  orgId: number;
  owner: SeededUser;
  member: SeededUser;
  outsider: SeededUser;
  admin: SeededUser;
}

/** The standard org: an owner, a plain member, an outsider and a site admin.
 *  The org admin's name is org-scoped so a test seeding BOTH helpers (the
 *  isolation suite) never collides on users.username_lower. */
async function seedOrg(name = "acme", visibility: "public" | "limited" | "private" = "public"): Promise<OrgSeed> {
  const owner = await seedUser(`${name}-owner`);
  const member = await seedUser(`${name}-member`);
  const outsider = await seedUser(`${name}-outsider`);
  const admin = await seedUser(`${name}-site-admin`, true);
  const org = await new OrgService(env.DB).createOrg({
    name,
    ownerId: owner.id,
    visibility,
    now: new Date("2026-01-02T00:00:00Z"),
  });
  await new OrgService(env.DB).addMember(org.id, member.id);
  return { orgId: org.id, owner, member, outsider, admin };
}

interface SecretWire {
  name: string;
  description: string;
  created_at: string;
}

interface VariableWire {
  owner_id: number;
  repo_id: number;
  name: string;
  data: string;
  description: string;
}

const messageOf = async (res: Response): Promise<string> => (await jsonBody<{ message: string }>(res)).message;

async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

// ---------------------------------------------------------------------------
// REPO SCOPE — secrets (repoListActionsSecrets / updateRepoSecret /
// deleteRepoSecret)
// ---------------------------------------------------------------------------

describe("repo secrets (GET/PUT/DELETE /repos/{owner}/{repo}/actions/secrets)", () => {
  it("PUT 201 creates, 204 updates; the list renders name/description/created_at and never the data", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    const created = await put(`/api/v1/repos/alice/${slug}/actions/secrets/DEPLOY_KEY`, { data: "s3cr3t", description: "ci key" }, alice.id);
    expect(created.status).toBe(201);
    expect(await created.text()).toBe("");

    // The lookup uppercases — the same secret under any case is an UPDATE.
    // An absent description carries Go's zero value: the update CLEARS it
    // (UpdateSecret overwrites description unconditionally, secret.go:137-152).
    const updated = await put(`/api/v1/repos/alice/${slug}/actions/secrets/deploy_key`, { data: "s3cr3t-v2" }, alice.id);
    expect(updated.status).toBe(204);

    const list = await get(`/api/v1/repos/alice/${slug}/actions/secrets`, alice.id);
    expect(list.status).toBe(200);
    const body = (await jsonBody<SecretWire[]>(list));
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe("DEPLOY_KEY");
    expect(body[0]!.description).toBe("");
    expect(body[0]!.created_at).toBe(new Date(body[0]!.created_at).toISOString());
    expect(JSON.stringify(body)).not.toContain("s3cr3t");
  });

  it("the list is name-ordered and paginated (X-Total-Count + Link)", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    for (const name of ["BETA", "ALPHA", "GAMMA"]) {
      expect((await put(`/api/v1/repos/alice/${slug}/actions/secrets/${name}`, { data: "v" }, alice.id)).status).toBe(201);
    }
    const res = await get(`/api/v1/repos/alice/${slug}/actions/secrets?page=1&limit=2`, alice.id);
    expect(res.status).toBe(200);
    const body = (await jsonBody<SecretWire[]>(res));
    expect(body.map((s) => s.name)).toEqual(["ALPHA", "BETA"]);
    expect(res.headers.get("X-Total-Count")).toBe("3");
    expect(res.headers.get("Link")).toContain('rel="next"');
  });

  it("DELETE 204 removes; a miss takes the empty-name ErrSecretNotFound text", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    await put(`/api/v1/repos/alice/${slug}/actions/secrets/TOKEN`, { data: "v" }, alice.id);
    const gone = await del(`/api/v1/repos/alice/${slug}/actions/secrets/token`, alice.id);
    expect(gone.status).toBe(204);
    const miss = await del(`/api/v1/repos/alice/${slug}/actions/secrets/TOKEN`, alice.id);
    expect(miss.status).toBe(404);
    const body = await jsonBody<{ message: string; url: string }>(miss);
    expect(body.message).toBe("secret was not found [name: ]");
    expect(body.url).toBe(ERROR_URL);
  });

  it("400: the ValidateName arms — pattern, forbidden prefix, reserved CI", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    const badPattern = await put(`/api/v1/repos/alice/${slug}/actions/secrets/has-hyphen`, { data: "v" }, alice.id);
    expect(badPattern.status).toBe(400);
    expect(await messageOf(badPattern)).toBe(
      "name must start with a letter or underscore and contain only letters, numbers, and underscores",
    );
    const giteaPrefix = await put(`/api/v1/repos/alice/${slug}/actions/secrets/gitea_token`, { data: "v" }, alice.id);
    expect(giteaPrefix.status).toBe(400);
    expect(await messageOf(giteaPrefix)).toBe("name cannot start with 'GITEA_' or 'GITHUB_'");
    const githubPrefix = await put(`/api/v1/repos/alice/${slug}/actions/secrets/GITHUB_TOKEN`, { data: "v" }, alice.id);
    expect(githubPrefix.status).toBe(400);
    const reserved = await put(`/api/v1/repos/alice/${slug}/actions/secrets/ci`, { data: "v" }, alice.id);
    expect(reserved.status).toBe(400);
    expect(await messageOf(reserved)).toBe("'CI' is a reserved name");
  });

  it("400: secret data counts BYTES against SecretDataMaxLength (65536)", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    // 65536 two-byte runes = 131072 bytes — over. 32768 of them = 65536 — fits.
    const ok = await put(`/api/v1/repos/alice/${slug}/actions/secrets/EDGE`, { data: "é".repeat(32768) }, alice.id);
    expect(ok.status).toBe(201);
    const tooLong = await put(`/api/v1/repos/alice/${slug}/actions/secrets/EDGE`, { data: "é".repeat(32769) }, alice.id);
    expect(tooLong.status).toBe(400);
    expect(await messageOf(tooLong)).toBe("data too long");
  });

  it("422 (runtime-only): the Go binder's Required text on a missing data", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    const res = await put(`/api/v1/repos/alice/${slug}/actions/secrets/NOPE`, { description: "no data" }, alice.id);
    expect(res.status).toBe(422);
    expect(await messageOf(res)).toBe("Data: Required");
  });

  it("403 (runtime-only): reqOwner — an admin-mode COLLABORATOR ranks below AccessModeOwner", async () => {
    const { alice, bob, admin } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    await env.DB.prepare("INSERT INTO repo_collaborators (repo_id, user_id, mode) VALUES (?, ?, 'admin')").bind(repoId, bob.id).run();
    const res = await put(`/api/v1/repos/alice/${slug}/actions/secrets/KEY`, { data: "v" }, bob.id);
    expect(res.status).toBe(403);
    expect(await messageOf(res)).toBe("user should be the owner of the repo");
    expect((await del(`/api/v1/repos/alice/${slug}/actions/secrets/KEY`, bob.id)).status).toBe(403);
    expect((await get(`/api/v1/repos/alice/${slug}/actions/secrets`, bob.id)).status).toBe(403);
    // …while the owner passes and the site admin passes (the explicit arm).
    expect((await put(`/api/v1/repos/alice/${slug}/actions/secrets/KEY`, { data: "v" }, alice.id)).status).toBe(201);
    expect((await put(`/api/v1/repos/alice/${slug}/actions/secrets/KEY2`, { data: "v" }, admin.id)).status).toBe(201);
  });

  it("404: the anti-enumeration repo miss (unknown repo, unknown owner)", async () => {
    const { alice } = await seedWorld();
    await seedRepo(alice);
    expect((await get("/api/v1/repos/alice/missing/actions/secrets", alice.id)).status).toBe(404);
    expect((await put("/api/v1/repos/ghost/repo1/actions/secrets/KEY", { data: "v" }, alice.id)).status).toBe(404);
    expect((await del("/api/v1/repos/alice/missing/actions/secrets/KEY", alice.id)).status).toBe(404);
  });

  it("401 (runtime-only): reqToken rejects anonymous callers", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    expect((await get(`/api/v1/repos/alice/${slug}/actions/secrets`)).status).toBe(401);
    expect((await put(`/api/v1/repos/alice/${slug}/actions/secrets/KEY`, { data: "v" })).status).toBe(401);
    expect((await del(`/api/v1/repos/alice/${slug}/actions/secrets/KEY`)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// REPO SCOPE — variables (getRepoVariablesList / getRepoVariable /
// createRepoVariable / updateRepoVariable / deleteRepoVariable)
// ---------------------------------------------------------------------------

describe("repo variables (/repos/{owner}/{repo}/actions/variables)", () => {
  it("POST 201 creates; GET renders the full ActionVariable (owner_id 0, numeric repo_id, UPPER name, EOL-normalized data)", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const created = await post(`/api/v1/repos/alice/${slug}/actions/variables/build_num`, { value: "1\r\n2", description: "counter" }, alice.id);
    expect(created.status).toBe(201);
    expect(await created.text()).toBe("");

    const got = await get(`/api/v1/repos/alice/${slug}/actions/variables/BUILD_NUM`, alice.id);
    expect(got.status).toBe(200);
    expect((await jsonBody<VariableWire>(got))).toEqual({
      owner_id: 0,
      repo_id: Number(repoId),
      name: "BUILD_NUM",
      data: "1\n2",
      description: "counter",
    });
  });

  it("POST 409 on an existing name (checked case-insensitively)", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    await post(`/api/v1/repos/alice/${slug}/actions/variables/DUP`, { value: "v" }, alice.id);
    const res = await post(`/api/v1/repos/alice/${slug}/actions/variables/dup`, { value: "v2" }, alice.id);
    expect(res.status).toBe(409);
    expect(await messageOf(res)).toBe("variable name already exists");
  });

  it("POST 400: the ValidateName arms and the RUNE-counted data cap", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    expect((await post(`/api/v1/repos/alice/${slug}/actions/variables/9bad`, { value: "v" }, alice.id)).status).toBe(400);
    const tooLong = await post(`/api/v1/repos/alice/${slug}/actions/variables/BIG`, { value: "é".repeat(65537) }, alice.id);
    expect(tooLong.status).toBe(400);
    expect(await messageOf(tooLong)).toBe("data too long");
    // 65536 runes fits exactly — the cap is runes, unlike secrets' bytes.
    expect((await post(`/api/v1/repos/alice/${slug}/actions/variables/EDGE`, { value: "é".repeat(65536) }, alice.id)).status).toBe(201);
  });

  it("422 (runtime-only): the Go binder's Required text on a missing value", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    const res = await post(`/api/v1/repos/alice/${slug}/actions/variables/NOPE`, { description: "no value" }, alice.id);
    expect(res.status).toBe(422);
    expect(await messageOf(res)).toBe("Value: Required");
  });

  it("GET 404 on a miss ('variable not found'); the list is name-ordered with X-Total-Count", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    const miss = await get(`/api/v1/repos/alice/${slug}/actions/variables/ABSENT`, alice.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("variable not found");

    for (const name of ["ZED", "MID"]) {
      await post(`/api/v1/repos/alice/${slug}/actions/variables/${name}`, { value: "v" }, alice.id);
    }
    const res = await get(`/api/v1/repos/alice/${slug}/actions/variables`, alice.id);
    expect(res.status).toBe(200);
    expect(((await jsonBody<VariableWire[]>(res))).map((v) => v.name)).toEqual(["MID", "ZED"]);
    expect(res.headers.get("X-Total-Count")).toBe("2");
  });

  it("PUT 204 updates value and clears an absent description; the rename arm moves the row", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    await post(`/api/v1/repos/alice/${slug}/actions/variables/OLD`, { value: "v1", description: "will vanish" }, alice.id);
    const renamed = await put(`/api/v1/repos/alice/${slug}/actions/variables/old`, { name: "NEW", value: "v2" }, alice.id);
    expect(renamed.status).toBe(204);
    expect((await get(`/api/v1/repos/alice/${slug}/actions/variables/OLD`, alice.id)).status).toBe(404);
    const moved = (await jsonBody<VariableWire>(await get(`/api/v1/repos/alice/${slug}/actions/variables/new`, alice.id)));
    expect(moved.name).toBe("NEW");
    expect(moved.data).toBe("v2");
    expect(moved.description).toBe("");
  });

  it("PUT 404 on a miss; PUT 400 on a rename onto an invalid name", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    await post(`/api/v1/repos/alice/${slug}/actions/variables/V`, { value: "v" }, alice.id);
    const miss = await put(`/api/v1/repos/alice/${slug}/actions/variables/ABSENT`, { value: "v" }, alice.id);
    expect(miss.status).toBe(404);
    const badRename = await put(`/api/v1/repos/alice/${slug}/actions/variables/V`, { name: "bad-name", value: "v" }, alice.id);
    expect(badRename.status).toBe(400);
    expect(await messageOf(badRename)).toBe(
      "name must start with a letter or underscore and contain only letters, numbers, and underscores",
    );
  });

  it("DELETE 204 removes; 404 on a miss", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    await post(`/api/v1/repos/alice/${slug}/actions/variables/GONE`, { value: "v" }, alice.id);
    expect((await del(`/api/v1/repos/alice/${slug}/actions/variables/gone`, alice.id)).status).toBe(204);
    const miss = await del(`/api/v1/repos/alice/${slug}/actions/variables/GONE`, alice.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("variable not found");
  });

  it("404 unknown repo across all five ops; 401 anonymous (the group gates)", async () => {
    const { alice } = await seedWorld();
    await seedRepo(alice);
    expect((await get("/api/v1/repos/alice/missing/actions/variables", alice.id)).status).toBe(404);
    expect((await post("/api/v1/repos/alice/missing/actions/variables/V", { value: "v" }, alice.id)).status).toBe(404);
    expect((await get("/api/v1/repos/alice/missing/actions/variables/V", alice.id)).status).toBe(404);
    expect((await put("/api/v1/repos/alice/missing/actions/variables/V", { value: "v" }, alice.id)).status).toBe(404);
    expect((await del("/api/v1/repos/alice/missing/actions/variables/V", alice.id)).status).toBe(404);
    const { slug } = await seedRepo(alice);
    expect((await get(`/api/v1/repos/alice/${slug}/actions/variables`)).status).toBe(401);
    expect((await post(`/api/v1/repos/alice/${slug}/actions/variables/V`, { value: "v" })).status).toBe(401);
    expect((await get(`/api/v1/repos/alice/${slug}/actions/variables/V`)).status).toBe(401);
    expect((await put(`/api/v1/repos/alice/${slug}/actions/variables/V`, { value: "v" })).status).toBe(401);
    expect((await del(`/api/v1/repos/alice/${slug}/actions/variables/V`)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// ORG SCOPE (8 ops) — the reqOrgOwnership gate + owner-scope storage
// ---------------------------------------------------------------------------

describe("org secrets and variables (/orgs/{org}/actions/...)", () => {
  it("secrets: PUT 201/204, list 200, DELETE 204/404 — all behind org ownership", async () => {
    const org = await seedOrg();
    const base = "/api/v1/orgs/acme/actions/secrets";
    expect((await put(`${base}/ORG_TOKEN`, { data: "v", description: "d" }, org.owner.id)).status).toBe(201);
    expect((await put(`${base}/ORG_TOKEN`, { data: "v2" }, org.owner.id)).status).toBe(204);

    const list = await get(base, org.owner.id);
    expect(list.status).toBe(200);
    const body = (await jsonBody<SecretWire[]>(list));
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe("ORG_TOKEN");
    expect(JSON.stringify(body)).not.toContain("v2");

    expect((await del(`${base}/org_token`, org.owner.id)).status).toBe(204);
    const miss = await del(`${base}/ORG_TOKEN`, org.owner.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("secret was not found [name: ]");
  });

  it("variables: full CRUD with the owner_id=org, repo_id=0 wire shape", async () => {
    const org = await seedOrg();
    const base = "/api/v1/orgs/acme/actions/variables";
    expect((await post(`${base}/org_var`, { value: "ov", description: "d" }, org.owner.id)).status).toBe(201);
    const dup = await post(`${base}/ORG_VAR`, { value: "again" }, org.owner.id);
    expect(dup.status).toBe(409);
    expect(await messageOf(dup)).toBe("variable name already exists");

    const got = await get(`${base}/org_var`, org.owner.id);
    expect(got.status).toBe(200);
    expect((await jsonBody<VariableWire>(got))).toEqual({
      owner_id: org.orgId,
      repo_id: 0,
      name: "ORG_VAR",
      data: "ov",
      description: "d",
    });

    const list = await get(base, org.owner.id);
    expect(((await jsonBody<VariableWire[]>(list))).map((v) => v.name)).toEqual(["ORG_VAR"]);
    expect(list.headers.get("X-Total-Count")).toBe("1");

    expect((await put(`${base}/ORG_VAR`, { value: "ov2" }, org.owner.id)).status).toBe(204);
    expect(((await jsonBody<VariableWire>(await get(`${base}/ORG_VAR`, org.owner.id)))).data).toBe("ov2");

    expect((await del(`${base}/ORG_VAR`, org.owner.id)).status).toBe(204);
    const miss = await del(`${base}/ORG_VAR`, org.owner.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("variable not found");
  });

  it("403: reqOrgOwnership — a plain member (even on a public org) takes upstream's exact message", async () => {
    const org = await seedOrg();
    expect((await put("/api/v1/orgs/acme/actions/secrets/KEY", { data: "v" }, org.member.id)).status).toBe(403);
    const res = await post("/api/v1/orgs/acme/actions/variables/V", { value: "v" }, org.member.id);
    expect(res.status).toBe(403);
    expect(await messageOf(res)).toBe("Must be an organization owner");
    // …the site admin passes (the explicit reqOrgOwnership arm).
    expect((await put("/api/v1/orgs/acme/actions/secrets/KEY", { data: "v" }, org.admin.id)).status).toBe(201);
  });

  it("404: unknown org across all eight ops; the 400 validation arms still fire for owners", async () => {
    const org = await seedOrg();
    expect((await get("/api/v1/orgs/missing/actions/secrets", org.owner.id)).status).toBe(404);
    expect((await put("/api/v1/orgs/missing/actions/secrets/KEY", { data: "v" }, org.owner.id)).status).toBe(404);
    expect((await del("/api/v1/orgs/missing/actions/secrets/KEY", org.owner.id)).status).toBe(404);
    expect((await get("/api/v1/orgs/missing/actions/variables", org.owner.id)).status).toBe(404);
    expect((await get("/api/v1/orgs/missing/actions/variables/V", org.owner.id)).status).toBe(404);
    expect((await post("/api/v1/orgs/missing/actions/variables/V", { value: "v" }, org.owner.id)).status).toBe(404);
    expect((await put("/api/v1/orgs/missing/actions/variables/V", { value: "v" }, org.owner.id)).status).toBe(404);
    expect((await del("/api/v1/orgs/missing/actions/variables/V", org.owner.id)).status).toBe(404);
    const beta = await seedOrg("beta");
    expect((await put("/api/v1/orgs/beta/actions/secrets/bad-name", { data: "v" }, beta.owner.id)).status).toBe(400);
    expect((await post("/api/v1/orgs/beta/actions/variables/CI", { value: "v" }, beta.owner.id)).status).toBe(400);
  });

  it("401 anonymous (the group's reqToken)", async () => {
    await seedOrg();
    expect((await get("/api/v1/orgs/acme/actions/secrets")).status).toBe(401);
    expect((await put("/api/v1/orgs/acme/actions/secrets/KEY", { data: "v" })).status).toBe(401);
    expect((await del("/api/v1/orgs/acme/actions/secrets/KEY")).status).toBe(401);
    expect((await get("/api/v1/orgs/acme/actions/variables")).status).toBe(401);
    expect((await get("/api/v1/orgs/acme/actions/variables/V")).status).toBe(401);
    expect((await post("/api/v1/orgs/acme/actions/variables/V", { value: "v" })).status).toBe(401);
    expect((await put("/api/v1/orgs/acme/actions/variables/V", { value: "v" })).status).toBe(401);
    expect((await del("/api/v1/orgs/acme/actions/variables/V")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// USER SCOPE (7 ops) — the /user group: the doer IS the owner
// ---------------------------------------------------------------------------

describe("user secrets and variables (/user/actions/...)", () => {
  it("secrets: PUT 201/204 and DELETE 204/404 scope to the doer", async () => {
    const { alice, bob } = await seedWorld();
    expect((await put("/api/v1/user/actions/secrets/MY_KEY", { data: "v", description: "mine" }, alice.id)).status).toBe(201);
    expect((await put("/api/v1/user/actions/secrets/my_key", { data: "v2" }, alice.id)).status).toBe(204);

    const noData = await put("/api/v1/user/actions/secrets/NO_DATA", { description: "x" }, alice.id);
    expect(noData.status).toBe(422);
    expect(await messageOf(noData)).toBe("Data: Required");

    // bob's user scope is a DIFFERENT store — his reads/deletes miss.
    expect((await del("/api/v1/user/actions/secrets/MY_KEY", bob.id)).status).toBe(404);
    expect((await put("/api/v1/user/actions/secrets/MY_KEY", { data: "x" }, bob.id)).status).toBe(201);

    expect((await del("/api/v1/user/actions/secrets/MY_KEY", alice.id)).status).toBe(204);
    const miss = await del("/api/v1/user/actions/secrets/MY_KEY", alice.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("secret was not found [name: ]");
  });

  it("variables: full CRUD over the doer's scope (owner_id=doer, repo_id=0)", async () => {
    const { alice } = await seedWorld();
    expect((await post("/api/v1/user/actions/variables/my_var", { value: "uv", description: "d" }, alice.id)).status).toBe(201);
    expect((await post("/api/v1/user/actions/variables/MY_VAR", { value: "dup" }, alice.id)).status).toBe(409);

    const got = await get("/api/v1/user/actions/variables/my_var", alice.id);
    expect(got.status).toBe(200);
    expect((await jsonBody<VariableWire>(got))).toEqual({
      owner_id: alice.id,
      repo_id: 0,
      name: "MY_VAR",
      data: "uv",
      description: "d",
    });

    const list = await get("/api/v1/user/actions/variables", alice.id);
    expect(list.status).toBe(200);
    expect(((await jsonBody<VariableWire[]>(list))).map((v) => v.name)).toEqual(["MY_VAR"]);

    expect((await put("/api/v1/user/actions/variables/MY_VAR", { name: "RENAMED", value: "uv2" }, alice.id)).status).toBe(204);
    expect(((await jsonBody<VariableWire>(await get("/api/v1/user/actions/variables/RENAMED", alice.id)))).name).toBe("RENAMED");
    expect((await put("/api/v1/user/actions/variables/ABSENT", { value: "v" }, alice.id)).status).toBe(404);

    expect((await del("/api/v1/user/actions/variables/RENAMED", alice.id)).status).toBe(204);
    expect((await del("/api/v1/user/actions/variables/RENAMED", alice.id)).status).toBe(404);
  });

  it("user-scope name validation still 400s; the user scope has no secrets-list op", async () => {
    const { alice } = await seedWorld();
    expect((await post("/api/v1/user/actions/variables/github_x", { value: "v" }, alice.id)).status).toBe(400);
    expect((await put("/api/v1/user/actions/secrets/9bad", { data: "v" }, alice.id)).status).toBe(400);
    // Upstream declares no GET /user/actions/secrets — the path is un-routed
    // here too (the absence is part of the 23-op surface).
    expect((await get("/api/v1/user/actions/secrets", alice.id)).status).toBe(404);
  });

  it("401 anonymous (the /user group's reqToken)", async () => {
    await seedWorld();
    expect((await put("/api/v1/user/actions/secrets/KEY", { data: "v" })).status).toBe(401);
    expect((await del("/api/v1/user/actions/secrets/KEY")).status).toBe(401);
    expect((await get("/api/v1/user/actions/variables")).status).toBe(401);
    expect((await get("/api/v1/user/actions/variables/V")).status).toBe(401);
    expect((await post("/api/v1/user/actions/variables/V", { value: "v" })).status).toBe(401);
    expect((await put("/api/v1/user/actions/variables/V", { value: "v" })).status).toBe(401);
    expect((await del("/api/v1/user/actions/variables/V")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// SCOPE ISOLATION — the (owner_id, repo_id, name) triple keeps the three
// stores disjoint
// ---------------------------------------------------------------------------

describe("scope isolation", () => {
  it("the same name lives independently in all three scopes; deleting one leaves the siblings", async () => {
    const { alice } = await seedWorld();
    const org = await seedOrg("acme");
    const { slug, repoId } = await seedRepo(alice);

    await put(`/api/v1/repos/alice/${slug}/actions/secrets/SHARED`, { data: "repo-v" }, alice.id);
    await put("/api/v1/orgs/acme/actions/secrets/SHARED", { data: "org-v" }, org.owner.id);
    await put("/api/v1/user/actions/secrets/SHARED", { data: "user-v" }, alice.id);
    await post(`/api/v1/repos/alice/${slug}/actions/variables/SHARED`, { value: "repo-v" }, alice.id);
    await post("/api/v1/orgs/acme/actions/variables/SHARED", { value: "org-v" }, org.owner.id);
    await post("/api/v1/user/actions/variables/SHARED", { value: "user-v" }, alice.id);

    const repoSecrets = (await jsonBody<SecretWire[]>(await get(`/api/v1/repos/alice/${slug}/actions/secrets`, alice.id)));
    expect(repoSecrets.map((s) => s.name)).toEqual(["SHARED"]);
    const orgSecrets = (await jsonBody<SecretWire[]>(await get("/api/v1/orgs/acme/actions/secrets", org.owner.id)));
    expect(orgSecrets).toHaveLength(1);
    const userVars = (await jsonBody<VariableWire[]>(await get("/api/v1/user/actions/variables", alice.id)));
    expect(userVars.map((v) => [v.name, v.data, v.owner_id])).toEqual([["SHARED", "user-v", alice.id]]);

    const repoVars = (await jsonBody<VariableWire[]>(await get(`/api/v1/repos/alice/${slug}/actions/variables`, alice.id)));
    expect(repoVars.map((v) => [v.name, v.data, v.owner_id, v.repo_id])).toEqual([["SHARED", "repo-v", 0, Number(repoId)]]);
    const orgVars = (await jsonBody<VariableWire[]>(await get("/api/v1/orgs/acme/actions/variables", org.owner.id)));
    expect(orgVars.map((v) => [v.name, v.data, v.owner_id, v.repo_id])).toEqual([["SHARED", "org-v", org.orgId, 0]]);

    // Deleting one scope's row leaves the siblings intact.
    await del(`/api/v1/repos/alice/${slug}/actions/secrets/SHARED`, alice.id);
    expect(((await jsonBody<SecretWire[]>(await get("/api/v1/orgs/acme/actions/secrets", org.owner.id))))).toHaveLength(1);
    expect((await get("/api/v1/user/actions/variables/SHARED", alice.id)).status).toBe(200);
    expect((await get("/api/v1/orgs/acme/actions/variables/SHARED", org.owner.id)).status).toBe(200);
  });
});

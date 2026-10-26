/**
 * Tier-1 organization routes on real D1 (SPEC-0007 §2.2 rows 1–3):
 * `GET /user/orgs` (orgListCurrentUserOrgs), `GET /orgs/{org}/repos`
 * (orgListRepos), `POST /orgs/{org}/repos` (createOrgRepo). Seeds org rows
 * through the landed OrgService (org-as-user-row model) and repos through the
 * landed RepoService, then asserts the wire shapes against the frozen
 * contract — including the mirrored upstream quirk: the repos listing has NO
 * owner-visibility gate, so an anonymous caller receives 200 + the public
 * repos of a limited/private org, unlike `GET /orgs/{org}` (404) and unlike
 * git HTTP (401-challenge).
 *
 * Bootstrap: `applyOrgsDdl()` (src/services/orgs/testing.ts — now applies the
 * generated migrations, incl. 0005's org tables) + `resetOrgTables()`. The
 * router runs with a custom AuthResolver that maps `token u<id>` to a seeded
 * D1 user, so the doer identity and the org_members rows refer to the same
 * rows (the stub resolver's fixed id cannot own anything).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { teamMembers, teams, users } from "../db/schema";
import { RepoService } from "../repos/service";
import { OrgService, type OrgRecord } from "../services/orgs/orgs";
import { applyOrgsDdl, resetOrgTables } from "../services/orgs/testing";
import type { User } from "./models/user";
import { createApiRouter } from "./router";
import { contractModelProperties } from "../compat/contract/frozen-contract";

beforeAll(applyOrgsDdl);

beforeEach(async () => {
  await resetOrgTables();
  seededUsers.clear();
});

const db = () => drizzle(env.DB);

const ORGANIZATION_FIELDS = Object.keys(contractModelProperties("Organization")).sort();
/** Upstream-`omitempty` Repository fields absent for D1-only repos. */
const OMITTED_REPOSITORY_FIELDS = new Set([
  "default_target_branch",
  "external_tracker",
  "external_wiki",
  "parent",
  "repo_transfer",
]);
const REPOSITORY_FIELDS = Object.keys(contractModelProperties("Repository"))
  .filter((name) => !OMITTED_REPOSITORY_FIELDS.has(name))
  .sort();

const ERROR_URL = "https://example.com/api/swagger";

/** Seeded D1 users the test resolver can authenticate as (`token u<id>`). */
const seededUsers = new Map<number, { id: number; username: string; isAdmin: boolean }>();

async function seedUser(username: string, isAdmin = false): Promise<{ id: number; username: string }> {
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
  return { id: user.id, username: user.username };
}

const authHeaders = (userId: number): Record<string, string> => ({
  Authorization: `token u${userId}`,
  "Content-Type": "application/json",
});
const anonHeaders = { "Content-Type": "application/json" };

/** API `User` projection the resolver returns (mirrors the auth middleware's
 *  toApiUser; every field the routes read comes from the D1 row). */
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

const router = () => {
  const app = createApiRouter({
    auth: {
      resolveToken(token) {
        const match = /^u(\d+)$/.exec(token);
        const user = match === null ? undefined : seededUsers.get(Number(match[1]));
        if (match === null || user === undefined) return Promise.resolve(null);
        return Promise.resolve(apiUser(user));
      },
    },
  });
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
};

const orgs = (): OrgService => new OrgService(env.DB);

async function seedOrg(name: string, ownerId: number, visibility: "public" | "limited" | "private" = "public"): Promise<OrgRecord> {
  return orgs().createOrg({ name, ownerId, visibility });
}

async function seedOrgRepo(org: OrgRecord, slug: string, isPrivate = false): Promise<void> {
  await new RepoService(env.DB).create({
    owner: { id: org.id, usernameLower: org.usernameLower },
    name: slug,
    isPrivate,
  });
}

describe("GET /user/orgs (orgListCurrentUserOrgs)", () => {
  it("401s an anonymous caller (upstream reqToken; the declared 404 is unreachable)", async () => {
    const res = await router()("/user/orgs");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "token is required", url: ERROR_URL });
  });

  it("self-lists every membership — non-public ones included — ordered lower_name ASC, with the 11-field Organization set", async () => {
    const alice = await seedUser("Alice");
    // Both memberships land is_public=false (DefaultOrgMemberVisible) — the
    // self-list's private ceiling skips that filter (org_list.go:57–71).
    await seedOrg("Zeta", alice.id, "private");
    await seedOrg("Alpha", alice.id, "public");

    const res = await router()("/user/orgs", { headers: authHeaders(alice.id) });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(res.headers.get("Link")).toBeNull();
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((org) => org.name)).toEqual(["Alpha", "Zeta"]);
    for (const org of body) expect(Object.keys(org).sort()).toEqual(ORGANIZATION_FIELDS);
    expect(body[0]).toMatchObject({
      name: "Alpha",
      username: "Alpha", // deprecated alias kept faithful
      visibility: "public",
      full_name: "",
      repo_admin_change_team_access: false,
    });
    expect(body[1]).toMatchObject({ name: "Zeta", visibility: "private" });
  });

  it("lists only the caller's own memberships (another user's orgs never leak)", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    await seedOrg("Alphas", alice.id);

    const res = await router()("/user/orgs", { headers: authHeaders(bob.id) });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("0");
    expect(await res.json()).toEqual([]);
  });

  it("paginates with X-Total-Count and the Link relation family", async () => {
    const alice = await seedUser("Alice");
    await seedOrg("Alpha", alice.id);
    await seedOrg("Beta", alice.id);

    const page = await router()("/user/orgs?limit=1&page=1", { headers: authHeaders(alice.id) });
    expect(page.headers.get("X-Total-Count")).toBe("2");
    expect(page.headers.get("Link")).toContain('rel="next"');
    expect(await page.json<unknown[]>()).toHaveLength(1);

    const last = await router()("/user/orgs?limit=1&page=2", { headers: authHeaders(alice.id) });
    expect(last.headers.get("Link")).toContain('rel="prev"');
    expect((await last.json<Array<{ name: string }>>())[0]?.name).toBe("Beta");
  });
});

describe("GET /orgs/{org}/repos (orgListRepos)", () => {
  it("mirrors the upstream visibility-gate QUIRK: anonymous callers get 200 + public repos of a PRIVATE org", async () => {
    const alice = await seedUser("Alice");
    const org = await seedOrg("Stealth", alice.id, "private");
    await seedOrgRepo(org, "open-source");
    await seedOrgRepo(org, "secret-sauce", true);

    // Unlike GET /orgs/{org} (404 via HasOrgOrUserVisible) and git HTTP
    // (401-challenge), this listing has no owner-visibility gate (§4.7).
    const res = await router()("/orgs/Stealth/repos", { headers: anonHeaders });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("1");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((repo) => repo.name)).toEqual(["open-source"]);
    // full_name renders the stored (case-folded) owner namespace — the
    // registry's lookup key, pinned by the repositories.test.ts contract.
    expect(body[0]).toMatchObject({ private: false, full_name: "stealth/open-source" });
  });

  it("answers a limited org anonymously with its public repos too", async () => {
    const alice = await seedUser("Alice");
    const org = await seedOrg("Limited", alice.id, "limited");
    await seedOrgRepo(org, "shown");

    const res = await router()("/orgs/limited/repos", { headers: anonHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("1");
    expect((await res.json<Array<{ name: string }>>())[0]?.name).toBe("shown");
  });

  it("shows private rows to the org owner, a site admin, and no one else (plain members see public only)", async () => {
    const alice = await seedUser("Alice");
    const member = await seedUser("Member");
    const admin = await seedUser("Root", true);
    const org = await seedOrg("Acme", alice.id);
    await orgs().addMember(org.id, member.id); // plain member, not an owner
    await seedOrgRepo(org, "public-repo");
    await seedOrgRepo(org, "private-repo", true);

    const ownerView = await router()("/orgs/acme/repos", { headers: authHeaders(alice.id) });
    expect(ownerView.headers.get("X-Total-Count")).toBe("2");
    expect((await ownerView.json<Array<{ name: string }>>()).map((r) => r.name)).toEqual(["private-repo", "public-repo"]);

    const adminView = await router()("/orgs/acme/repos", { headers: authHeaders(admin.id) });
    expect(adminView.headers.get("X-Total-Count")).toBe("2");

    const memberView = await router()("/orgs/acme/repos", { headers: authHeaders(member.id) });
    expect(memberView.headers.get("X-Total-Count")).toBe("1");
    expect((await memberView.json<Array<{ name: string }>>()).map((r) => r.name)).toEqual(["public-repo"]);
  });

  it("renders the frozen 71-field Repository set for listed rows", async () => {
    const alice = await seedUser("Alice");
    const org = await seedOrg("Acme", alice.id);
    await seedOrgRepo(org, "visible");

    const res = await router()("/orgs/acme/repos", { headers: anonHeaders });
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(Object.keys(body[0] ?? {}).sort()).toEqual(REPOSITORY_FIELDS);
    expect(body[0]).toMatchObject({
      name: "visible",
      full_name: "acme/visible", // case-folded owner namespace (storage key), see above
      private: false,
      empty: true, // no pushes yet (refs_version 0)
      owner: { login: "Acme", type: "User" }, // the org's users row keeps display case
      permissions: { admin: false, push: false, pull: true }, // anonymous viewer
    });
  });

  it("404s missing orgs and plain-user names with the same body (GetOrgByName type gate)", async () => {
    await seedUser("Alice"); // a plain user, not an org

    for (const name of ["ghost", "Alice"]) {
      const res = await router()(`/orgs/${name}/repos`, { headers: anonHeaders });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
    }
  });

  it("paginates with X-Total-Count and Link relations", async () => {
    const alice = await seedUser("Alice");
    const org = await seedOrg("Acme", alice.id);
    await seedOrgRepo(org, "alpha");
    await seedOrgRepo(org, "beta");

    const page = await router()("/orgs/acme/repos?limit=1&page=1", { headers: anonHeaders });
    expect(page.headers.get("X-Total-Count")).toBe("2");
    expect(page.headers.get("Link")).toContain('rel="next"');
    expect((await page.json<Array<{ name: string }>>()).map((r) => r.name)).toEqual(["alpha"]);

    const last = await router()("/orgs/acme/repos?limit=1&page=2", { headers: anonHeaders });
    expect(last.headers.get("Link")).toContain('rel="prev"');
    expect((await last.json<Array<{ name: string }>>()).map((r) => r.name)).toEqual(["beta"]);
  });
});

describe("POST /orgs/{org}/repos (createOrgRepo)", () => {
  const createBody = JSON.stringify({ name: "widget", description: "ignored until the column lands" });

  it("creates with 201 + the Repository at owner permissions; the registry row is org-owned", async () => {
    const alice = await seedUser("Alice");
    const org = await seedOrg("Acme", alice.id);

    const res = await router()("/orgs/acme/repos", { method: "POST", headers: authHeaders(alice.id), body: createBody });

    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(REPOSITORY_FIELDS);
    expect(body).toMatchObject({
      name: "widget",
      full_name: "acme/widget",
      private: false,
      empty: true,
      owner: { login: "Acme" },
      permissions: { admin: true, push: true, pull: true }, // AccessModeOwner, not the generic viewer matrix
    });

    const stored = await env.DB.prepare("SELECT owner_id, owner_namespace, slug, visibility FROM repositories").first<Record<string, unknown>>();
    expect(stored).toMatchObject({ owner_id: org.id, owner_namespace: "acme", slug: "widget", visibility: "public" });
  });

  it("honors private and accepts the engine-deferred auto_init option", async () => {
    const alice = await seedUser("Alice");
    await seedOrg("Acme", alice.id);

    const res = await router()("/orgs/acme/repos", {
      method: "POST",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ name: "secret", private: true, auto_init: true, default_branch: "trunk" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ name: "secret", private: true });
    // auto_init is accepted per the contract and deferred to the engine
    // commit-builder wave (SPEC-0004 §3.4) — the repo stays empty.
    expect(body.empty).toBe(true);
  });

  it("walks upstream's guard order: missing org 404 → invisible org 404 → grant 403 (exact message)", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const member = await seedUser("Member");
    const hidden = await seedOrg("Hidden", alice.id, "private");
    await orgs().addMember(hidden.id, member.id); // member without the create grant

    // Org missing entirely.
    const missing = await router()("/orgs/ghost/repos", { method: "POST", headers: authHeaders(alice.id), body: createBody });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });

    // Private org, non-member doer: invisible ⇒ indistinguishable 404.
    const invisible = await router()("/orgs/hidden/repos", { method: "POST", headers: authHeaders(bob.id), body: createBody });
    expect(invisible.status).toBe(404);
    expect(await invisible.json()).toEqual({ message: "not found", url: ERROR_URL });

    // Visible member WITHOUT the repo-create grant (tier 1: owners only).
    const noGrant = await router()("/orgs/hidden/repos", { method: "POST", headers: authHeaders(member.id), body: createBody });
    expect(noGrant.status).toBe(403);
    expect(await noGrant.json()).toEqual({
      message: "User is not allowed to create repositories in this organization.",
      url: ERROR_URL,
    });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM repositories").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("401s anonymous callers (reqToken)", async () => {
    const res = await router()("/orgs/acme/repos", { method: "POST", headers: anonHeaders, body: createBody });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "token is required", url: ERROR_URL });
  });

  it("keeps the §3.4 team grant repo-create-only: a grant team member creates (201) yet 403s owner-only ops; the owner passes both", async () => {
    const alice = await seedUser("Alice");
    const creator = await seedUser("Creator");
    const org = await seedOrg("Acme", alice.id);
    await orgs().addMember(org.id, creator.id);
    // A can_create_org_repo team holding `creator` (raw rows — the team family
    // is exercised in the org-teams suite; only the grant arm matters here).
    const team = await db()
      .insert(teams)
      .values({ orgId: org.id, lowerName: "creators", name: "creators", authorize: "read", canCreateOrgRepo: true })
      .returning({ id: teams.id })
      .all();
    await db().insert(teamMembers).values({ orgId: org.id, teamId: team[0]!.id, userId: creator.id });

    // The grant creates…
    const granted = await router()("/orgs/acme/repos", {
      method: "POST",
      headers: authHeaders(creator.id),
      body: JSON.stringify({ name: "granted" }),
    });
    expect(granted.status).toBe(201);
    // …but confers no ownership: PATCH /orgs/{org} rides requireOrgOwnership
    // (isOrgOwner — the SPEC-0007 §3.4 follow-up narrowing).
    const hijack = await router()("/orgs/acme", {
      method: "PATCH",
      headers: authHeaders(creator.id),
      body: JSON.stringify({ description: "hijacked" }),
    });
    expect(hijack.status).toBe(403);
    expect(await hijack.json()).toEqual({ message: "Must be an organization owner", url: ERROR_URL });

    // The owner passes both arms.
    const ownerEdit = await router()("/orgs/acme", {
      method: "PATCH",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ description: "mine" }),
    });
    expect(ownerEdit.status).toBe(200);
    const ownerCreate = await router()("/orgs/acme/repos", {
      method: "POST",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ name: "owned" }),
    });
    expect(ownerCreate.status).toBe(201);
  });

  it("409s a duplicate name and 422s an invalid/reserved name (upstream messages)", async () => {
    const alice = await seedUser("Alice");
    const org = await seedOrg("Acme", alice.id);
    await seedOrgRepo(org, "widget");

    const duplicate = await router()("/orgs/acme/repos", { method: "POST", headers: authHeaders(alice.id), body: createBody });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      message: "The repository with the same name already exists.",
      url: ERROR_URL,
    });

    // Invalid names: the IsUsableRepoName port (pattern, reserved suffixes) —
    // single dots are legal, so use a real violation (space / .git suffix).
    const spaced = await router()("/orgs/acme/repos", {
      method: "POST",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ name: "bad name" }),
    });
    expect(spaced.status).toBe(422);

    const gitSuffix = await router()("/orgs/acme/repos", {
      method: "POST",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ name: "repo.git" }),
    });
    expect(gitSuffix.status).toBe(422);

    const malformed = await router()("/orgs/acme/repos", { method: "POST", headers: authHeaders(alice.id), body: "{not json" });
    expect(malformed.status).toBe(400); // hono's media-type gate, Gitea error shape
    expect((await malformed.json<{ message: string }>()).message).toBe("Malformed JSON in request body");
  });
});

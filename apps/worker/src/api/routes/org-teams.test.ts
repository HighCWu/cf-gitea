/**
 * The org teams family (routes/org-teams.ts) on real D1: all twenty contract
 * team ops — org CRUD + search (orgListTeams/orgCreateTeam/teamSearch/
 * orgGetTeam/orgEditTeam/orgDeleteTeam), membership (orgListTeamMembers/
 * orgListTeamMember/orgAddTeamMember/orgRemoveTeamMember/userListTeams),
 * repo access (orgListTeamRepos/orgListTeamRepo/orgAddTeamRepository/
 * orgRemoveTeamRepository/repoListTeams/repoCheckTeam/repoAddTeam/
 * repoDeleteTeam) and the honest-empty feeds (orgListTeamActivityFeeds).
 *
 * Standalone mount (the labels-t2.test.ts convention): the register function
 * takes the requireAuth/optionalAuth pair and is mounted on a fresh
 * OpenAPIHono with the real auth middlewares, the stub resolver mapping
 * `token u<id>` to the seeded D1 user rows, so the org_members-backed guards
 * are exercisable against the same rows they query.
 *
 * The behavior pins asserted here (the bridge duplicate-422 for `owners`,
 * the member visibility ladder, the assignTeamPermissionUnits 422s, the
 * blanked-500 rename collision, the add-membership side effect, the
 * includes-all union-on-read and the per-repo team-grant trim) are cited in
 * the route module header with upstream file:line references.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, teamMembers, teamRepoAccess, teams, users,
  protectedBranches,
} from "../../db/schema";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerOrgTeamsRoutes, TeamsService } from "./org-teams";
import { emptyRuleConfig, serializeRuleConfig } from "../../services/branch-protection";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { applyOrgsDdl, resetOrgTables } from "../../services/orgs/testing";

beforeAll(applyOrgsDdl);

beforeEach(async () => {
  // The team tables first (no dependents), then the org sweep (repositories,
  // users-without-the-reserved-'assets'-row, org_members, redirects).
  for (const table of ["protected_branches", "team_repo_access", "team_members", "teams"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await resetOrgTables();
  seededUsers.clear();
});

const db = () => drizzle(env.DB);
const NOW = new Date("2026-01-01T00:00:00Z");

/** Seeded D1 users the test resolver authenticates as (`token u<id>`). */
const seededUsers = new Map<number, { id: number; username: string; isAdmin: boolean }>();

interface SeededUser {
  id: number;
  username: string;
}

async function seedUser(username: string, isAdmin = false): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin,
      status: "active",
      createdAt: NOW,
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
  registerOrgTeamsRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

interface TeamsSeed {
  owner: SeededUser;
  member: SeededUser;
  teammate: SeededUser;
  outsider: SeededUser;
  admin: SeededUser;
  org: OrgRecord;
}

/** Owner + plain member + team-scoped member + outsider + site admin, one
 *  public org with a public repo, a private repo, a public team `docs`
 *  (containing `teammate`) and a private team `vault-team`. */
async function seedActors(): Promise<TeamsSeed> {
  const owner = await seedUser("org-owner");
  const member = await seedUser("org-member");
  const teammate = await seedUser("team-mate");
  const outsider = await seedUser("outsider");
  const admin = await seedUser("site-admin", true);
  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({ name: "acme", ownerId: owner.id });
  await orgs.addMember(org.id, member.id);
  const service = new TeamsService(env.DB);
  await seedRepo(org.id, org.usernameLower, "public-repo", "public");
  await seedRepo(org.id, org.usernameLower, "vault", "private");
  const docs = await service.createTeam(org, { name: "docs", permission: "write", visibility: "public" });
  await service.createTeam(org, { name: "vault-team", permission: "read" });
  await service.addTeamMember(docs, teammate.id);
  return { owner, member, teammate, outsider, admin, org };
}

/** Raw repo registry row (the engine is not involved in these families). */
async function seedRepo(ownerId: number, ownerNamespace: string, slug: string, visibility: "public" | "private"): Promise<string> {
  const id = `t_${slug.replace(/-/g, "_")}`;
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    ownerId,
    slug,
    visibility,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: NOW,
  });
  return id;
}

async function teamIdByName(name: string): Promise<number> {
  const row = await db().select({ id: teams.id }).from(teams).where(eq(teams.lowerName, name)).get();
  if (row === undefined) throw new Error(`team seed failed: ${name}`);
  return row.id;
}

/** getTeamById with the miss made loud (the tests seed before they read). */
async function mustTeam(service: TeamsService, id: number) {
  const team = await service.getTeamById(id);
  if (team === null) throw new Error(`team seed failed: ${id}`);
  return team;
}

// ---------------------------------------------------------------------------
// orgListTeams
// ---------------------------------------------------------------------------

describe("GET /orgs/{org}/teams (orgListTeams)", () => {
  it("lists the owner's view — every team, lower_name order, org-less bodies, pagination headers", async () => {
    const s = await seedActors();
    const send = router();
    const res = await send(`/orgs/${s.org.username}/teams`, { headers: authHeaders(s.owner.id) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("2");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((team) => team.name)).toEqual(["docs", "vault-team"]);
    expect(body[0]).toMatchObject({
      name: "docs",
      permission: "write",
      units: [],
      units_map: {},
      visibility: "public",
      includes_all_repositories: false,
      can_create_org_repo: false,
    });
    expect(body[0]).not.toHaveProperty("organization");
  });

  it("filters for a plain member: own teams UNION public+limited — never others' private teams", async () => {
    const s = await seedActors();
    const send = router();
    const res = await send(`/orgs/${s.org.username}/teams`, { headers: authHeaders(s.member.id) });
    expect(res.status).toBe(200);
    // `docs` (public) appears; `vault-team` (private, not the member's) does not.
    expect((await res.json<Array<Record<string, unknown>>>()).map((team) => team.name)).toEqual(["docs"]);
  });

  it("requires org membership (403 exact message) and 404s missing/plain-user orgs", async () => {
    const s = await seedActors();
    const send = router();
    const res = await send(`/orgs/${s.org.username}/teams`, { headers: authHeaders(s.outsider.id) });
    expect(res.status).toBe(403);
    expect((await res.json<Record<string, unknown>>()).message).toBe("Must be an organization member");
    expect((await send("/orgs/ghost/teams", { headers: authHeaders(s.owner.id) })).status).toBe(404);
    expect((await send(`/orgs/${s.outsider.username}/teams`, { headers: authHeaders(s.owner.id) })).status).toBe(404);
    expect((await send(`/orgs/${s.org.username}/teams`)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// orgCreateTeam
// ---------------------------------------------------------------------------

describe("POST /orgs/{org}/teams (orgCreateTeam)", () => {
  it("creates as the owner (201), mirrors the body, embeds the org", async () => {
    const s = await seedActors();
    const send = router();
    const res = await send(`/orgs/${s.org.username}/teams`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({
        name: "Reviewers",
        description: "code review",
        permission: "admin",
        can_create_org_repo: true,
        visibility: "limited",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      name: "Reviewers",
      description: "code review",
      permission: "admin",
      can_create_org_repo: true,
      visibility: "limited",
      units: [],
      units_map: {},
    });
    expect((body.organization as Record<string, unknown>).name).toBe("acme");
    // Case-folded uniqueness row.
    const row = await db().select().from(teams).where(eq(teams.lowerName, "reviewers")).get();
    expect(row).toMatchObject({ authorize: "admin", canCreateOrgRepo: true, numMembers: 0 });
  });

  it("fans out includes_all_repositories to the org's repos at create", async () => {
    const s = await seedActors();
    const send = router();
    const res = await send(`/orgs/${s.org.username}/teams`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ name: "all", permission: "read", includes_all_repositories: true }),
    });
    expect(res.status).toBe(201);
    const id = (await res.json<Record<string, unknown>>()).id as number;
    const rows = await db().select().from(teamRepoAccess).where(eq(teamRepoAccess.teamId, id)).all();
    expect(rows.map((row) => row.repoId).sort()).toEqual(["t_public_repo", "t_vault"]);
    expect((await db().select().from(teams).where(eq(teams.id, id)).get())?.numRepos).toBe(2);
  });

  it("422s the assignTeamPermissionUnits arms and the bridge `owners` duplicate", async () => {
    const s = await seedActors();
    const send = router();
    const post = (body: Record<string, unknown>) =>
      send(`/orgs/${s.org.username}/teams`, { method: "POST", headers: authHeaders(s.owner.id), body: JSON.stringify(body) });

    const noPermission = await post({ name: "x" });
    expect(noPermission.status).toBe(422);
    expect((await noPermission.json<Record<string, unknown>>()).message).toBe("no permission specified");

    const conflict = await post({ name: "x", permission: "read", units: ["repo.code"], units_map: { "repo.code": "read" } });
    expect(conflict.status).toBe(422);
    expect((await conflict.json<Record<string, unknown>>()).message).toBe("only one of units or units_map can be set");

    // units[] expands to the map at the blanket permission; authorize drops to none.
    const units = await post({ name: "unit-team", units: ["repo.code", "repo.wiki"], permission: "write" });
    expect(units.status).toBe(201);
    expect(await units.json<Record<string, unknown>>()).toMatchObject({
      permission: "none",
      units: ["repo.code", "repo.wiki"],
      units_map: { "repo.code": "write", "repo.wiki": "write" },
    });

    // The bridge: the org's Owners team IS the role row — the upstream
    // duplicate 422 with ErrTeamAlreadyExist's message.
    const owners = await post({ name: "owners", permission: "read" });
    expect(owners.status).toBe(422);
    expect((await owners.json<Record<string, unknown>>()).message).toBe(
      `team already exists [org_id: ${s.org.id}, name: owners]`,
    );

    // Case-insensitive duplicate of a real team.
    const dup = await post({ name: "DOCS", permission: "read" });
    expect(dup.status).toBe(422);
    expect((await dup.json<Record<string, unknown>>()).message).toBe(
      `team already exists [org_id: ${s.org.id}, name: docs]`,
    );
  });

  it("gates on org ownership (403 exact message) with the admin bypass; missing org 404", async () => {
    const s = await seedActors();
    const send = router();
    const body = JSON.stringify({ name: "x", permission: "read" });
    const memberRes = await send(`/orgs/${s.org.username}/teams`, { method: "POST", headers: authHeaders(s.member.id), body });
    expect(memberRes.status).toBe(403);
    expect((await memberRes.json<Record<string, unknown>>()).message).toBe("Must be an organization owner");
    expect(
      (await send(`/orgs/${s.org.username}/teams`, { method: "POST", headers: authHeaders(s.admin.id), body })).status,
    ).toBe(201);
    expect(
      (await send("/orgs/ghost/teams", { method: "POST", headers: authHeaders(s.admin.id), body })).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// teamSearch
// ---------------------------------------------------------------------------

describe("GET /orgs/{org}/teams/search (teamSearch)", () => {
  it("searches names case-insensitively, includes descriptions by default, honors include_desc=false", async () => {
    const s = await seedActors();
    const send = router();
    const service = new TeamsService(env.DB);
    await service.editTeam(await mustTeam(service, await teamIdByName("vault-team")), {
      description: "hidden vault access",
    });

    const byName = await send(`/orgs/${s.org.username}/teams/search?q=VAULT`, { headers: authHeaders(s.owner.id) });
    expect(byName.status).toBe(200);
    const envelope = await byName.json<{ ok: boolean; data: Array<Record<string, unknown>> }>();
    expect(envelope.ok).toBe(true);
    expect(envelope.data.map((team) => team.name)).toEqual(["vault-team"]);

    // The private team is invisible to the plain member even when matching...
    const memberView = await send(`/orgs/${s.org.username}/teams/search?q=vault`, {
      headers: authHeaders(s.member.id),
    });
    expect((await memberView.json<{ data: Array<unknown> }>().then((b) => b.data)).map((t) => t)).toEqual([]);

    // ...and include_desc=false drops the description match entirely for the owner.
    const nameOnly = await send(`/orgs/${s.org.username}/teams/search?q=hidden&include_desc=false`, {
      headers: authHeaders(s.owner.id),
    });
    expect(await nameOnly.json<{ data: Array<unknown> }>().then((b) => b.data)).toEqual([]);
    expect(byName.headers.get("x-total-count")).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// orgGetTeam / orgEditTeam / orgDeleteTeam
// ---------------------------------------------------------------------------

describe("GET /teams/{id} (orgGetTeam)", () => {
  it("serves the team with the org embedded to privileged and team-visibility-admitted doers", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    const res = await send(`/teams/${docsId}`, { headers: authHeaders(s.teammate.id) });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ name: "docs", permission: "write" });
    expect((body.organization as Record<string, unknown>).name).toBe("acme");
  });

  it("applies reqTeamReadAccess: public admits signed-in non-members; private denies with 403/404", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    const vaultId = await teamIdByName("vault-team");

    // Public team + public org: an outside signed-in user reads the metadata.
    expect((await send(`/teams/${docsId}`, { headers: authHeaders(s.outsider.id) })).status).toBe(200);
    // Private team: an org NON-member reads as a miss (anti-enumeration 404).
    expect((await send(`/teams/${vaultId}`, { headers: authHeaders(s.outsider.id) })).status).toBe(404);
    // Private team: an org member (but not a team member) gets the exact 403.
    const memberRes = await send(`/teams/${vaultId}`, { headers: authHeaders(s.member.id) });
    expect(memberRes.status).toBe(403);
    expect((await memberRes.json<Record<string, unknown>>()).message).toBe("Must be a team member");
    // The site admin bypasses everything.
    expect((await send(`/teams/${vaultId}`, { headers: authHeaders(s.admin.id) })).status).toBe(200);
    expect((await send("/teams/999999", { headers: authHeaders(s.owner.id) })).status).toBe(404);
    expect((await send(`/teams/${docsId}`)).status).toBe(401);
  });
});

describe("PATCH /teams/{id} (orgEditTeam)", () => {
  it("applies the presented fields (description, visibility, permission) and truncates long descriptions", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    const res = await send(`/teams/${docsId}`, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ description: "d".repeat(300), visibility: "limited", permission: "read", name: "Writers" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ name: "Writers", description: "d".repeat(255), visibility: "limited", permission: "read" });
    const row = await db().select().from(teams).where(eq(teams.id, docsId)).get();
    expect(row).toMatchObject({ lowerName: "writers" });
  });

  it("renames collide into the internal-error 500 (UpdateTeam → APIErrorInternal seam)", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    const res = await send(`/teams/${docsId}`, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ name: "VAULT-TEAM" }),
    });
    expect(res.status).toBe(500);
    // The untyped rename failure rides giteaErrorHandler's default branch —
    // the constant `internal server error` fallback (ef2c049: never the
    // blank or internal message on the wire).
    expect(await res.json<Record<string, unknown>>()).toEqual({
      message: "internal server error",
      url: "https://example.com/api/swagger",
    });
  });

  it("gates on org ownership (403) and 404s missing teams", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    const res = await send(`/teams/${docsId}`, {
      method: "PATCH",
      headers: authHeaders(s.member.id),
      body: JSON.stringify({ description: "nope" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json<Record<string, unknown>>()).message).toBe("Must be an organization owner");
    expect(
      (await send("/teams/999999", { method: "PATCH", headers: authHeaders(s.owner.id), body: "{}" })).status,
    ).toBe(404);
  });
});

describe("DELETE /teams/{id} (orgDeleteTeam)", () => {
  it("deletes the team, cascades its rows, and removes orphaned org memberships", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    // `member` joins `docs` through the real service (org membership already
    // exists; the team row is what ties them) so the delete's
    // removeInvalidOrgUser scan has a member to re-home.
    const service = new TeamsService(env.DB);
    await service.addTeamMember(await mustTeam(service, docsId), s.member.id);
    // A rule on the org's repo whitelisting BOTH teams (SPEC-0013 M4 — the
    // team.go:191-210 "update branch protections" block).
    const vaultId = await teamIdByName("vault-team");
    await db().insert(protectedBranches).values({
      repoId: "t_public_repo",
      ruleName: "main",
      priority: 1,
      rules: serializeRuleConfig({
        ...emptyRuleConfig(),
        whitelistTeamIds: [docsId, vaultId],
        approvalsWhitelistTeamIds: [docsId],
        bypassAllowlistTeamIds: [vaultId],
      }),
      createdAt: NOW,
      updatedAt: NOW,
    });
    const res = await send(`/teams/${docsId}`, { method: "DELETE", headers: authHeaders(s.owner.id) });
    expect(res.status).toBe(204);
    expect(await db().select().from(teams).where(eq(teams.id, docsId)).get()).toBeUndefined();
    expect(await db().select().from(teamMembers).where(eq(teamMembers.teamId, docsId)).all()).toEqual([]);
    // The rule survives with the deleted team's references scrubbed from every
    // allowlist column; the other org team's references stay.
    const rule = (await db().select().from(protectedBranches).all())[0];
    expect(rule).not.toBeUndefined();
    const config = JSON.parse(rule!.rules) as Record<string, number[]>;
    expect(config.whitelist_team_ids).toEqual([vaultId]);
    expect(config.approvals_whitelist_team_ids).toEqual([]);
    expect(config.bypass_allowlist_team_ids).toEqual([vaultId]);
    // The removed-from-team member KEEPS the org membership only while another
    // team holds them — `member` had none left, but they were never an
    // owner, so removeMember silently dropped the org membership too.
    expect(await new OrgService(env.DB).getMembership(s.org.id, s.member.id)).toBeNull();
  });

  it("hits the §4.3 last-owner guard (500, blanked message) when the only org owner loses their last team", async () => {
    const s = await seedActors();
    const send = router();
    const service = new TeamsService(env.DB);
    // The owner joins `vault-team` (AddTeamMember would also add them to the
    // org — they already are). Deleting the team leaves the owner team-less,
    // and removeInvalidOrgUser's RemoveOrgUser fires ErrLastOrgOwner.
    const vaultId = await teamIdByName("vault-team");
    await service.addTeamMember(await mustTeam(service, vaultId), s.owner.id);
    const res = await send(`/teams/${vaultId}`, { method: "DELETE", headers: authHeaders(s.owner.id) });
    expect(res.status).toBe(500);
    // Untyped guard error → the default-branch `internal server error`
    // fallback (ef2c049: never a blank/internal message on the wire).
    expect((await res.json<Record<string, unknown>>()).message).toBe("internal server error");
    // The team survived the guarded transaction.
    expect(await db().select().from(teams).where(eq(teams.id, vaultId)).get()).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Members family
// ---------------------------------------------------------------------------

describe("GET /teams/{id}/members (orgListTeamMembers)", () => {
  it("lists members ordered display_name/username with the counter total header", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    const service = new TeamsService(env.DB);
    await service.addTeamMember(await mustTeam(service, docsId), s.member.id);
    const res = await send(`/teams/${docsId}/members`, { headers: authHeaders(s.owner.id) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("2");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((u) => u.login)).toEqual(["org-member", "team-mate"]);
  });

  it("gates: org non-members 403 on a PUBLIC team (reqOrgMembership after read access); private teams deny org members with the team-member 403", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    const vaultId = await teamIdByName("vault-team");
    // Public team: the outsider passes reqTeamReadAccess, then the group's
    // reqOrgMembership answers with the exact 403.
    const outsiderRes = await send(`/teams/${docsId}/members`, { headers: authHeaders(s.outsider.id) });
    expect(outsiderRes.status).toBe(403);
    expect((await outsiderRes.json<Record<string, unknown>>()).message).toBe("Must be an organization member");
    // Private team: the org member (not in the team) fails reqTeamReadAccess
    // into denyNonTeamMember → the team-member 403.
    const memberRes = await send(`/teams/${vaultId}/members`, { headers: authHeaders(s.member.id) });
    expect(memberRes.status).toBe(403);
    expect((await memberRes.json<Record<string, unknown>>()).message).toBe("Must be a team member");
    // Private team: the anti-enumeration 404 for the org non-member.
    expect((await send(`/teams/${vaultId}/members`, { headers: authHeaders(s.outsider.id) })).status).toBe(404);
  });
});

describe("PUT/DELETE /teams/{id}/members/{username} (orgAddTeamMember/orgRemoveTeamMember)", () => {
  it("adds a member — creating the org membership as a side effect — idempotently", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    const service = new TeamsService(env.DB);
    const put = () =>
      send(`/teams/${docsId}/members/${s.outsider.username}`, { method: "PUT", headers: authHeaders(s.owner.id) });
    expect((await put()).status).toBe(204);
    const orgs = new OrgService(env.DB);
    // The side effect: the target is now an ORG member too (AddOrgUser).
    expect(await orgs.getMembership(s.org.id, s.outsider.id)).not.toBeNull();
    const team = await service.getTeamById(docsId);
    expect(team?.numMembers).toBe(2); // seedActors' teammate + the new outsider
    // Second add: silent no-op, counter unchanged.
    expect((await put()).status).toBe(204);
    expect((await service.getTeamById(docsId))?.numMembers).toBe(2);
    // Unknown user → 404; non-owner caller → 403.
    expect((await send(`/teams/${docsId}/members/ghost`, { method: "PUT", headers: authHeaders(s.owner.id) })).status).toBe(404);
    expect(
      (await send(`/teams/${docsId}/members/${s.member.username}`, { method: "PUT", headers: authHeaders(s.member.id) }))
        .status,
    ).toBe(403);
  });

  it("removes members (counter decremented; non-members the silent 204) and fires the last-owner 500", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    const service = new TeamsService(env.DB);
    const docs = await mustTeam(service, docsId);
    await service.addTeamMember(docs, s.member.id);
    const del = (username: string, caller = s.owner.id) =>
      send(`/teams/${docsId}/members/${username}`, { method: "DELETE", headers: authHeaders(caller) });
    expect((await del(s.member.username)).status).toBe(204);
    expect((await db().select().from(teams).where(eq(teams.id, docsId)).get())?.numMembers).toBe(1); // teammate remains
    // Not a member: the silent no-op 204 (upstream removeTeamMember).
    expect((await del(s.member.username)).status).toBe(204);
    // The owner is not in the team → no-op too.
    expect((await del(s.owner.username)).status).toBe(204);
    // Unknown target → 404.
    expect((await del("ghost")).status).toBe(404);

    // The §4.3 guard: the last org owner in their last team cannot be removed.
    const vaultId = await teamIdByName("vault-team");
    const vault = await mustTeam(service, vaultId);
    await service.addTeamMember(vault, s.owner.id);
    const res = await send(`/teams/${vaultId}/members/${s.owner.username}`, {
      method: "DELETE",
      headers: authHeaders(s.owner.id),
    });
    expect(res.status).toBe(500);
    // Untyped guard error → the default-branch `internal server error`
    // fallback (ef2c049).
    expect((await res.json<Record<string, unknown>>()).message).toBe("internal server error");
  });
});

describe("GET /user/teams (userListTeams)", () => {
  it("lists the doer's own teams with the org embedded; others' teams never leak", async () => {
    const s = await seedActors();
    const send = router();
    const res = await send("/user/teams", { headers: authHeaders(s.teammate.id) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("1");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ name: "docs" });
    expect((body[0]?.organization as Record<string, unknown> | undefined)?.name).toBe("acme");
    const none = await send("/user/teams", { headers: authHeaders(s.member.id) });
    expect(await none.json<unknown[]>()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Team repos family
// ---------------------------------------------------------------------------

describe("GET /teams/{id}/repos (orgListTeamRepos) — the team-grant enforcement slice", () => {
  it("trims repos the doer cannot see; a team grant unlocks the private repo", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");

    // `docs` covers nothing yet → empty for the teammate (public team, so the
    // listing itself is reachable even by the outsider).
    const empty = await send(`/teams/${docsId}/repos`, { headers: authHeaders(s.teammate.id) });
    expect(empty.status).toBe(200);
    expect(await empty.json<unknown[]>()).toEqual([]);

    // Cover the public repo with the team; an outside signed-in user (no
    // grant) sees the public repo; `vault` stays hidden — first explicitly
    // covered, then via the includes-all union of a second team.
    const service = new TeamsService(env.DB);
    const docs = await mustTeam(service, docsId);
    await service.addTeamRepo(docs, "t_public_repo");

    const outsidersView = await send(`/teams/${docsId}/repos`, { headers: authHeaders(s.outsider.id) });
    expect((await outsidersView.json<Array<Record<string, unknown>>>()).map((r) => r.name)).toEqual(["public-repo"]);

    // The teammate holds the team grant → the private repo WOULD render if
    // covered; cover it and observe the slice.
    await service.addTeamRepo(docs, "t_vault");
    const granteesView = await send(`/teams/${docsId}/repos`, { headers: authHeaders(s.teammate.id) });
    expect((await granteesView.json<Array<Record<string, unknown>>>()).map((r) => r.name).sort()).toEqual([
      "public-repo",
      "vault",
    ]);
  });

  it("unions includes_all coverage on read (repos created after the fan-out)", async () => {
    const s = await seedActors();
    const send = router();
    const service = new TeamsService(env.DB);
    const all = await service.createTeam(s.org, { name: "all", permission: "read", includes_all_repositories: true });
    // A repo created AFTER the create-time fan-out is still covered (union).
    await seedRepo(s.org.id, s.org.usernameLower, "later", "public");
    const res = await send(`/teams/${all.id}/repos`, { headers: authHeaders(s.owner.id) });
    const names = (await res.json<Array<Record<string, unknown>>>()).map((r) => r.name).sort();
    expect(names).toEqual(["later", "public-repo", "vault"]);
  });
});

describe("GET/PUT/DELETE /teams/{id}/repos/{org}/{repo} (orgListTeamRepo/orgAddTeamRepository/orgRemoveTeamRepository)", () => {
  it("serves a covered repo even with a WRONG {org} path segment (upstream ignores it)", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    const service = new TeamsService(env.DB);
    await service.addTeamRepo(await mustTeam(service, docsId), "t_public_repo");
    const res = await send(`/teams/${docsId}/repos/not-acme/public-repo`, { headers: authHeaders(s.teammate.id) });
    expect(res.status).toBe(200);
    expect((await res.json<Record<string, unknown>>()).name).toBe("public-repo");
  });

  it("404s uncovered repos and private repos the doer has no grant for", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    const service = new TeamsService(env.DB);
    await service.addTeamRepo(await mustTeam(service, docsId), "t_public_repo");
    // Covered, but private and the outsider holds no grant (public team lets
    // them pass reqTeamReadAccess; the access trim answers the 404).
    expect(
      (await send(`/teams/${docsId}/repos/acme/vault`, { headers: authHeaders(s.outsider.id) })).status,
    ).toBe(404);
    // Not covered at all.
    expect((await send(`/teams/${docsId}/repos/acme/missing`, { headers: authHeaders(s.owner.id) })).status).toBe(404);

    // The teammate's grant unlocks the covered private repo.
    const vaultId = await teamIdByName("vault-team");
    await service.addTeamRepo(await mustTeam(service, vaultId), "t_vault");
    await service.addTeamMember(await mustTeam(service, vaultId), s.member.id);
    expect((await send(`/teams/${vaultId}/repos/acme/vault`, { headers: authHeaders(s.member.id) })).status).toBe(200);
  });

  it("adds/removes coverage: manage gate 403s, plain adds are idempotent, removal no-ops uncovered", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    const service = new TeamsService(env.DB);
    const docs = await mustTeam(service, docsId);
    await service.addTeamMember(docs, s.member.id);

    // Team member (non-owner) WITHOUT the manage gate: repo_admin_change_team_access
    // is false on the org and the member holds no repo-admin grant → 403.
    const memberRes = await send(`/teams/${docsId}/repos/acme/public-repo`, {
      method: "PUT",
      headers: authHeaders(s.member.id),
    });
    expect(memberRes.status).toBe(403);
    expect((await memberRes.json<Record<string, unknown>>()).message).toBe(
      "Must have permission to manage team repository access",
    );

    // The org owner manages: 204 + coverage row.
    expect(
      (await send(`/teams/${docsId}/repos/acme/public-repo`, { method: "PUT", headers: authHeaders(s.owner.id) })).status,
    ).toBe(204);
    expect(await db().select().from(teamRepoAccess).where(eq(teamRepoAccess.teamId, docsId)).all()).toHaveLength(1);
    // Re-add: TeamAddRepository's silent no-op.
    expect(
      (await send(`/teams/${docsId}/repos/acme/public-repo`, { method: "PUT", headers: authHeaders(s.owner.id) })).status,
    ).toBe(204);

    // Unknown repo → 404; removal of an uncovered repo → silent 204; covered
    // removal → 204 + the row gone.
    expect(
      (await send(`/teams/${docsId}/repos/acme/missing`, { method: "PUT", headers: authHeaders(s.owner.id) })).status,
    ).toBe(404);
    expect(
      (await send(`/teams/${docsId}/repos/acme/vault`, { method: "DELETE", headers: authHeaders(s.owner.id) })).status,
    ).toBe(204);
    expect(
      (await send(`/teams/${docsId}/repos/acme/public-repo`, { method: "DELETE", headers: authHeaders(s.owner.id) }))
        .status,
    ).toBe(204);
    expect(await db().select().from(teamRepoAccess).where(eq(teamRepoAccess.teamId, docsId)).all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Repo-side family (/repos/{owner}/{repo}/teams)
// ---------------------------------------------------------------------------

describe("GET/PUT/DELETE /repos/{owner}/{repo}/teams (repoListTeams/repoCheckTeam/repoAddTeam/repoDeleteTeam)", () => {
  it("lists covering teams (Owners-first order is the bridge no-op), 405s user-owned repos", async () => {
    const s = await seedActors();
    const send = router();
    const service = new TeamsService(env.DB);
    const docs = await mustTeam(service, await teamIdByName("docs"));
    await service.addTeamRepo(docs, "t_public_repo");

    const res = await send(`/repos/${s.org.username}/public-repo/teams`, { headers: authHeaders(s.owner.id) });
    expect(res.status).toBe(200);
    expect((await res.json<Array<Record<string, unknown>>>()).map((t) => t.name)).toEqual(["docs"]);
    // Anonymous on a public repo: reqAnyRepoReader without reqToken.
    expect((await send(`/repos/${s.org.username}/public-repo/teams`)).status).toBe(200);
    // User-owned repo → the 405.
    const plain = await seedUser("plain-repo-owner");
    await seedRepo(plain.id, plain.username, "solo", "public");
    expect((await send(`/repos/plain-repo-owner/solo/teams`, { headers: authHeaders(plain.id) })).status).toBe(405);
    expect((await send("/repos/ghost/none/teams", { headers: authHeaders(s.owner.id) })).status).toBe(404);
  });

  it("checks coverage with the ErrTeamNotExist 404 body for unknown teams", async () => {
    const s = await seedActors();
    const send = router();
    const service = new TeamsService(env.DB);
    const docs = await mustTeam(service, await teamIdByName("docs"));
    await service.addTeamRepo(docs, "t_public_repo");

    const covered = await send(`/repos/${s.org.username}/public-repo/teams/docs`, { headers: authHeaders(s.owner.id) });
    expect(covered.status).toBe(200);
    expect((await covered.json<Record<string, unknown>>()).name).toBe("docs");
    // A real team that does not cover the repo → the shared "not found".
    const uncovered = await send(`/repos/${s.org.username}/public-repo/teams/vault-team`, {
      headers: authHeaders(s.owner.id),
    });
    expect(uncovered.status).toBe(404);
    expect((await uncovered.json<Record<string, unknown>>()).message).toBe("not found");
    // An unknown team → getTeamByParam's ErrTeamNotExist message.
    const unknown = await send(`/repos/${s.org.username}/public-repo/teams/ghost-team`, {
      headers: authHeaders(s.owner.id),
    });
    expect(unknown.status).toBe(404);
    expect((await unknown.json<Record<string, unknown>>()).message).toBe(
      `team does not exist [org_id ${s.org.id}, team_id 0, name: ghost-team]`,
    );
  });

  it("adds (422 on duplicate) and removes (422 when uncovered) behind reqAdmin + the manage gate", async () => {
    const s = await seedActors();
    const send = router();
    const put = (team: string, caller = s.owner.id) =>
      send(`/repos/${s.org.username}/public-repo/teams/${team}`, { method: "PUT", headers: authHeaders(caller) });
    const del = (team: string, caller = s.owner.id) =>
      send(`/repos/${s.org.username}/public-repo/teams/${team}`, { method: "DELETE", headers: authHeaders(caller) });

    // A plain org member fails reqAdmin first (the exact landed message).
    const forbidden = await put("docs", s.member.id);
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json<Record<string, unknown>>()).message).toBe(
      "user should be an owner or a collaborator with admin write of a repository",
    );
    // Unknown team → the ErrTeamNotExist body.
    expect((await put("ghost-team")).status).toBe(404);

    expect((await put("docs")).status).toBe(204);
    // Duplicate → the exact upstream 422 message.
    const dup = await put("docs");
    expect(dup.status).toBe(422);
    expect((await dup.json<Record<string, unknown>>()).message).toBe("team 'docs' is already added to repo");

    // Uncovered delete → 422; covered delete → 204.
    const notAdded = await del("vault-team");
    expect(notAdded.status).toBe(422);
    expect((await notAdded.json<Record<string, unknown>>()).message).toBe("team 'vault-team' was not added to repo");
    expect((await del("docs")).status).toBe(204);
    expect(await db().select().from(teamRepoAccess).where(eq(teamRepoAccess.repoId, "t_public_repo")).all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// orgListTeamActivityFeeds — honest-empty
// ---------------------------------------------------------------------------

describe("GET /teams/{id}/activities/feeds (orgListTeamActivityFeeds)", () => {
  it("answers the empty feed with zero totals behind the read guard", async () => {
    const s = await seedActors();
    const send = router();
    const docsId = await teamIdByName("docs");
    const res = await send(`/teams/${docsId}/activities/feeds`, { headers: authHeaders(s.owner.id) });
    expect(res.status).toBe(200);
    expect(await res.json<unknown[]>()).toEqual([]);
    expect(res.headers.get("x-total-count")).toBe("0");
    // The read guard applies (private team, org non-member → 404).
    const vaultId = await teamIdByName("vault-team");
    expect((await send(`/teams/${vaultId}/activities/feeds`, { headers: authHeaders(s.outsider.id) })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The §3.4 create grant is NOT ownership (SPEC-0007 §3.4 follow-up): the
// team family's owner arms ride isOrgOwner (role='owner'), not the grant.
// The grant's CREATE arm (POST /orgs/{org}/repos 201) is pinned in
// api/org-repos.test.ts's createOrgRepo describe.
// ---------------------------------------------------------------------------

/** `seedActors` plus a can_create_org_repo team holding the plain member
 *  (addTeamMember installs the org membership as its AddOrgUser side effect). */
async function seedActorWithCreateGrant(): Promise<TeamsSeed & { creatorsId: number }> {
  const s = await seedActors();
  const service = new TeamsService(env.DB);
  const creators = await service.createTeam(s.org, {
    name: "creators",
    permission: "read",
    can_create_org_repo: true,
  });
  await service.addTeamMember(creators, s.member.id);
  return { ...s, creatorsId: creators.id };
}

describe("create-grant members are not owners (org-teams owner arms narrowed)", () => {
  it("403s the grant holder on orgCreateTeam/orgEditTeam/orgAddTeamMember with the exact owner message", async () => {
    const s = await seedActorWithCreateGrant();
    const send = router();
    // orgCreateTeam's requireOrgOwnership:
    const create = await send(`/orgs/${s.org.username}/teams`, {
      method: "POST",
      headers: authHeaders(s.member.id),
      body: JSON.stringify({ name: "sneaky", permission: "read" }),
    });
    expect(create.status).toBe(403);
    expect((await create.json<Record<string, unknown>>()).message).toBe("Must be an organization owner");
    // orgEditTeam (the grant holder's OWN team passes read access, not ownership):
    const edit = await send(`/teams/${s.creatorsId}`, {
      method: "PATCH",
      headers: authHeaders(s.member.id),
      body: JSON.stringify({ description: "self-promoted" }),
    });
    expect(edit.status).toBe(403);
    expect((await edit.json<Record<string, unknown>>()).message).toBe("Must be an organization owner");
    // orgAddTeamMember:
    expect(
      (
        await send(`/teams/${s.creatorsId}/members/${s.outsider.username}`, {
          method: "PUT",
          headers: authHeaders(s.member.id),
        })
      ).status,
    ).toBe(403);
  });

  it("does not widen the team listings: the grant holder still sees the member-filtered view", async () => {
    const s = await seedActorWithCreateGrant();
    const send = router();
    // The member ladder = own teams UNION public+limited: `creators` (their
    // own private team) and `docs` (public) — but never `vault-team`. The
    // pre-narrowing owner arm would have listed every team instead.
    const res = await send(`/orgs/${s.org.username}/teams`, { headers: authHeaders(s.member.id) });
    expect(res.status).toBe(200);
    expect((await res.json<Array<Record<string, unknown>>>()).map((team) => team.name)).toEqual(["creators", "docs"]);
  });

  it("keeps the owner passing every arm (create 201, edit 200, member add 204)", async () => {
    const s = await seedActorWithCreateGrant();
    const send = router();
    expect(
      (
        await send(`/orgs/${s.org.username}/teams`, {
          method: "POST",
          headers: authHeaders(s.owner.id),
          body: JSON.stringify({ name: "owner-team", permission: "read" }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await send(`/teams/${s.creatorsId}`, {
          method: "PATCH",
          headers: authHeaders(s.owner.id),
          body: JSON.stringify({ description: "the create grant" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(`/teams/${s.creatorsId}/members/${s.outsider.username}`, {
          method: "PUT",
          headers: authHeaders(s.owner.id),
        })
      ).status,
    ).toBe(204);
  });
});

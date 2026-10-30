/**
 * The repository-service access seam on real D1: `canViewRepository` /
 * `repositoryPermissions` (and their `*WithTeams` resolvers) honoring the
 * SPEC-0007 §3.5 team grants — the enforcement slice the org-teams module
 * header deferred to this wave. Upstream access model: `perm.AccessMode`
 * ranking (gitea/models/perm/access_mode.go:17–22 — read < write < admin <
 * owner) mapped onto the API `Permission` block (read ⇒ pull, write ⇒ push,
 * admin ⇒ admin; `convert.innerToRepo`'s embedded block), the grant resolved
 * through the ONE shared predicate (`OrgService.teamRepoAccessMode` + the
 * `org_members.role='owner'` Owners-team bridge, §3.3) that the git-HTTP
 * gate consumes too (git-http/acl.ts — the modules cannot drift).
 *
 * The sync two-arg call shape is pinned as back-compatible: callers that
 * have not resolved a grant keep the reduced owner/admin matrix.
 */

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories, teamMembers, teamRepoAccess, teams, type TeamAccessMode } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { applyOrgsDdl, resetOrgTables } from "../../services/orgs/testing";
import {
  apiUserFromRow,
  canViewRepository,
  canViewRepositoryWithTeams,
  doerRepoAccessMode,
  findRepositoryByPath,
  findUserByName,
  repositoryPermissions,
  repositoryPermissionsWithTeams,
  toApiRepository,
  type Viewer,
} from "./repository";
import { saveUserProfileColumns } from "./user-settings";

beforeAll(async () => {
  await applyAuthD1Migrations();
  await applyOrgsDdl();
});

beforeEach(async () => {
  // team_repo_access has no FK (repo_id is a plain TEXT column) — sweep it
  // first; teams/team_members cascade with the users rows.
  await env.DB.prepare("DELETE FROM team_repo_access").run();
  await resetOrgTables();
});

const NOW = new Date("2026-01-01T00:00:00Z");

/** Raw repositories row (the engine is not involved in the predicate). */
async function seedRepo(
  ownerId: number,
  ownerNamespace: string,
  slug: string,
  visibility: "public" | "private",
): Promise<string> {
  const id = `t_${slug.replace(/-/g, "_")}`;
  await drizzle(env.DB).insert(repositories).values({
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

/** Team with one member, covering (or not) the given repo ids. */
async function seedTeam(
  org: OrgRecord,
  name: string,
  authorize: TeamAccessMode,
  userId: number,
  repoIds: string[],
  options: { includesAll?: boolean; unitsMap?: Record<string, string> } = {},
): Promise<number> {
  const db = drizzle(env.DB);
  const inserted = await db
    .insert(teams)
    .values({
      orgId: org.id,
      lowerName: name,
      name,
      authorize,
      includesAllRepositories: options.includesAll === true,
      unitsMap: options.unitsMap ? JSON.stringify(options.unitsMap) : null,
      visibility: "private",
    })
    .returning({ id: teams.id })
    .all();
  const teamId = inserted[0]!.id;
  await db.insert(teamMembers).values({ orgId: org.id, teamId, userId });
  for (const repoId of repoIds) {
    await db.insert(teamRepoAccess).values({ orgId: org.id, teamId, repoId });
  }
  return teamId;
}

/** Org `acme` (owner `OrgOwner`) + a private `vault` repo, resolved. */
async function seedOrgFixture(): Promise<{
  org: OrgRecord;
  owner: { id: number; username: string };
  vault: NonNullable<Awaited<ReturnType<typeof findRepositoryByPath>>>;
}> {
  const owner = await seedVerifiedUser({ username: "OrgOwner" });
  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({ name: "acme", ownerId: owner.id });
  await seedRepo(org.id, org.usernameLower, "vault", "private");
  const vault = await findRepositoryByPath(env.DB, "acme", "vault");
  if (vault === null) throw new Error("fixture repo missing");
  return { org, owner, vault };
}

const viewerFor = (user: { id: number; username: string }, isAdmin = false): Viewer => ({
  origin: "https://example.com",
  requester: {
    id: user.id,
    login: user.username,
    email: "",
    full_name: "",
    avatar_url: "",
    html_url: "",
    language: "",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: isAdmin,
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
  },
});

describe("canViewRepositoryWithTeams — a team-granted member sees a private org repo", () => {
  it("read-mode team: the grantee sees `acme/vault`; a non-member reads the anti-enumeration miss", async () => {
    const { org, vault } = await seedOrgFixture();
    const member = await seedVerifiedUser({ username: "TeamMate" });
    const outsider = await seedVerifiedUser({ username: "Outsider" });
    await seedTeam(org, "readers", "read", member.id, [vault.repo.id]);

    expect(await canViewRepositoryWithTeams(env.DB, viewerFor(member), vault.repo)).toBe(true);
    // The anti-enumeration 404 every ungated route renders.
    expect(await canViewRepositoryWithTeams(env.DB, viewerFor(outsider), vault.repo)).toBe(false);
    // The sync two-arg shape (back-compat arm) returns boolean — no await.
    expect(canViewRepository(viewerFor(outsider), vault.repo)).toBe(false);
  });

  it("covers via includes_all teams and via unit-collapsed teams (units_map write)", async () => {
    const { org, vault } = await seedOrgFixture();
    const member = await seedVerifiedUser({ username: "TeamMate" });
    // includes-all coverage, no explicit row.
    await seedTeam(org, "all", "read", member.id, [], { includesAll: true });
    expect(await canViewRepositoryWithTeams(env.DB, viewerFor(member), vault.repo)).toBe(true);

    // A second member granted only through a units-collapsed team
    // (authorize 'none', units_map write — the assignTeamPermission shape;
    // the map's strongest unit is the team's blanket mode).
    const unitsMember = await seedVerifiedUser({ username: "UnitsMate" });
    await seedTeam(org, "units", "none", unitsMember.id, [vault.repo.id], {
      unitsMap: { "repo.code": "write", "repo.wiki": "none" },
    });
    expect(await canViewRepositoryWithTeams(env.DB, viewerFor(unitsMember), vault.repo)).toBe(true);
    expect(await doerRepoAccessMode(env.DB, vault.repo, unitsMember.id)).toBe("write");
  });

  it("a team NOT covering the repo grants nothing (explicit-row scoping)", async () => {
    const { org, vault } = await seedOrgFixture();
    const member = await seedVerifiedUser({ username: "TeamMate" });
    const otherId = await seedRepo(org.id, org.usernameLower, "other", "private");
    await seedTeam(org, "readers", "read", member.id, [otherId]);
    const other = await findRepositoryByPath(env.DB, "acme", "other");
    if (other === null) throw new Error("fixture repo missing");

    expect(await canViewRepositoryWithTeams(env.DB, viewerFor(member), other.repo)).toBe(true);
    expect(await canViewRepositoryWithTeams(env.DB, viewerFor(member), vault.repo)).toBe(false);
  });

  it("the org-owner arm rides the bridge (role='owner' ⇒ mode owner); site admins stay unrestricted", async () => {
    const { owner, vault } = await seedOrgFixture();

    // The owner was NOT readable through the reduced matrix (the login arm
    // never matches an org namespace) — the bridge arm covers them upstream-
    // style (the Owners team is authorize=owner + includes-all).
    expect(await doerRepoAccessMode(env.DB, vault.repo, owner.id)).toBe("owner");
    expect(await canViewRepositoryWithTeams(env.DB, viewerFor(owner), vault.repo)).toBe(true);

    const admin = await seedVerifiedUser({ username: "Root", isAdmin: true });
    expect(await canViewRepositoryWithTeams(env.DB, viewerFor(admin, true), vault.repo)).toBe(true);
  });

  it("public repos stay readable by everyone; a 'none' team grants nothing", async () => {
    const { org } = await seedOrgFixture();
    const member = await seedVerifiedUser({ username: "TeamMate" });
    await seedRepo(org.id, org.usernameLower, "open", "public");
    const open = await findRepositoryByPath(env.DB, "acme", "open");
    if (open === null) throw new Error("fixture repo missing");
    await seedTeam(org, "nones", "none", member.id, [open.repo.id]);

    expect(await canViewRepositoryWithTeams(env.DB, viewerFor(member), open.repo)).toBe(true);
    expect(await doerRepoAccessMode(env.DB, open.repo, member.id)).toBe("none");
    // Anonymous viewer: the pure matrix, untouched.
    const anonymous: Viewer = { origin: "https://example.com", requester: null };
    expect(await canViewRepositoryWithTeams(env.DB, anonymous, open.repo)).toBe(true);
  });
});

describe("repositoryPermissionsWithTeams — the AccessMode → Permission mapping", () => {
  it("read ⇒ pull only; write ⇒ push+pull; admin ⇒ the full block", async () => {
    const owner = await seedVerifiedUser({ username: "OrgOwner" });
    const orgs = new OrgService(env.DB);
    const org = await orgs.createOrg({ name: "acme", ownerId: owner.id });
    const permissionsByMode: Record<string, Awaited<ReturnType<typeof repositoryPermissionsWithTeams>>> = {};
    for (const mode of ["read", "write", "admin"] as const) {
      const member = await seedVerifiedUser({ username: `${mode}-mate` });
      const repoId = await seedRepo(org.id, org.usernameLower, `${mode}-vault`, "private");
      await seedTeam(org, `${mode}-team`, mode, member.id, [repoId]);
      const found = await findRepositoryByPath(env.DB, "acme", `${mode}-vault`);
      if (found === null) throw new Error("fixture repo missing");
      permissionsByMode[mode] = await repositoryPermissionsWithTeams(env.DB, viewerFor(member), found.repo);
    }
    expect(permissionsByMode.read).toEqual({ admin: false, push: false, pull: true });
    expect(permissionsByMode.write).toEqual({ admin: false, push: true, pull: true });
    expect(permissionsByMode.admin).toEqual({ admin: true, push: true, pull: true });
  });

  it("the embedded toApiRepository block carries the grant when the caller resolves it", async () => {
    const { org, vault } = await seedOrgFixture();
    const member = await seedVerifiedUser({ username: "TeamMate" });
    await seedTeam(org, "writers", "write", member.id, [vault.repo.id]);

    // Without the resolved mode: the reduced matrix (private ⇒ nothing).
    expect(toApiRepository(viewerFor(member), vault).permissions).toEqual({ admin: false, push: false, pull: false });
    // With it: the write team's push.
    const mode = await doerRepoAccessMode(env.DB, vault.repo, member.id);
    expect(toApiRepository(viewerFor(member), vault, undefined, mode).permissions).toEqual({
      admin: false,
      push: true,
      pull: true,
    });
  });

  it("the sync two-arg shape is unchanged (no grant ⇒ the reduced matrix)", () => {
    const reduced = {
      id: "t_x",
      visibility: "private",
      ownerNamespace: "acme",
    } as Parameters<typeof canViewRepository>[1];
    const anonymous: Viewer = { origin: "https://example.com", requester: null };
    expect(canViewRepository(anonymous, reduced)).toBe(false);
    expect(repositoryPermissions(anonymous, reduced)).toEqual({ admin: false, push: false, pull: false });
  });
});

describe("apiUserFromRow — the profile quartet projects from the row (usability finding F-1)", () => {
  const anonymous: Viewer = { origin: "https://example.com", requester: null };

  it("populates full_name/description/website/location set through the web form's writer (saveUserProfileColumns)", async () => {
    const owner = await seedVerifiedUser({ username: "Profiled" });
    // The write arm the web form rides (POST /user/settings →
    // saveUserProfileColumns, services/user-settings.ts) — the same columns
    // the API PATCH /user/settings persists.
    await saveUserProfileColumns(env.DB, owner.id, {
      displayName: "Profiled Owner",
      description: "desc-probe-check-xyz",
      website: "https://example.com/~profiled",
      location: "The Internet",
    });
    const row = await findUserByName(env.DB, "Profiled");
    if (row === null) throw new Error("fixture user missing");

    // The API reader (GET /users/{username} via toApiUser, GET /user — both
    // delegate to this converter). Upstream toUser renders the four fields
    // straight off the row for every viewer (convert/user.go:84–93).
    const user = apiUserFromRow(row, anonymous);
    expect(user.full_name).toBe("Profiled Owner");
    expect(user.description).toBe("desc-probe-check-xyz");
    expect(user.website).toBe("https://example.com/~profiled");
    expect(user.location).toBe("The Internet");
  });

  it("the embedded Repository.owner renders the same fields (the repo listings' owner objects)", async () => {
    const owner = await seedVerifiedUser({ username: "Profiled" });
    await saveUserProfileColumns(env.DB, owner.id, {
      displayName: "Profiled Owner",
      description: "profiled's repos",
      website: "https://profiled.example.com",
      location: "The Internet",
    });
    await seedRepo(owner.id, "profiled", "widgets", "public");
    const pair = await findRepositoryByPath(env.DB, "profiled", "widgets");
    if (pair === null) throw new Error("fixture repo missing");

    const repo = toApiRepository(anonymous, pair);
    if (repo.owner === undefined) throw new Error("owner payload missing");
    expect(repo.owner.full_name).toBe("Profiled Owner");
    expect(repo.owner.description).toBe("profiled's repos");
    expect(repo.owner.website).toBe("https://profiled.example.com");
    expect(repo.owner.location).toBe("The Internet");
  });

  it("NULL profile columns still render the empty string (upstream's zero value)", async () => {
    await seedVerifiedUser({ username: "Plain" });
    const row = await findUserByName(env.DB, "Plain");
    if (row === null) throw new Error("fixture user missing");
    expect(row.description).toBeNull();
    expect(row.website).toBeNull();
    expect(row.location).toBeNull();
    expect(row.displayName).toBeNull();

    const user = apiUserFromRow(row, anonymous);
    expect(user.full_name).toBe("");
    expect(user.description).toBe("");
    expect(user.website).toBe("");
    expect(user.location).toBe("");
  });
});

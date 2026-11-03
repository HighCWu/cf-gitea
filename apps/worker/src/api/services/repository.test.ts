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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { releases, repositories, teamMembers, teamRepoAccess, teams, users, type TeamAccessMode } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { applyOrgsDdl, resetOrgTables } from "../../services/orgs/testing";
import {
  apiUserFromRow,
  canViewRepository,
  canViewRepositoryWithTeams,
  doerRepoAccessMode,
  findRepositoryByPath,
  findUserByName,
  GO_ZERO_TIME,
  repositoryOrderBy,
  repositoryPermissions,
  repositoryPermissionsWithTeams,
  searchRepositories,
  toApiRepository,
  toApiRepositoryFull,
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

describe("apiUserFromRow — the last_login authed gate (P3-7)", () => {
  const anonymous: Viewer = { origin: "https://example.com", requester: null };
  const LOGIN_AT = new Date("2026-03-04T05:06:07Z");

  /** Seed a user whose row carries a real last-login instant (the
   *  mintSession write the login POST performs — pinned in ui/session.test.ts;
   *  here the column is set directly so the RENDER is isolated from the
   *  mint). */
  async function seedWithLastLogin(username: string): Promise<{ id: number; username: string }> {
    const user = await seedVerifiedUser({ username });
    await drizzle(env.DB).update(users).set({ lastLoginAt: LOGIN_AT }).where(eq(users.id, user.id));
    return user;
  }

  it("the user themself sees the row's last_login_at instant (convert/user.go:118's authed arm)", async () => {
    const user = await seedWithLastLogin("SelfSeen");
    const row = await findUserByName(env.DB, "SelfSeen");
    if (row === null) throw new Error("fixture user missing");

    const user_ = apiUserFromRow(row, viewerFor(user));
    expect(user_.last_login).toBe("2026-03-04T05:06:07.000Z");
  });

  it("a site admin sees another user's instant (the gate's second arm)", async () => {
    await seedWithLastLogin("AdminSeen");
    const admin = await seedVerifiedUser({ username: "Root", isAdmin: true });
    const row = await findUserByName(env.DB, "AdminSeen");
    if (row === null) throw new Error("fixture user missing");

    const user_ = apiUserFromRow(row, viewerFor(admin, true));
    expect(user_.last_login).toBe("2026-03-04T05:06:07.000Z");
  });

  it("a signed stranger and an anonymous caller get Go zero time even when the column is set", async () => {
    await seedWithLastLogin("Gated");
    const stranger = await seedVerifiedUser({ username: "Stranger" });
    const row = await findUserByName(env.DB, "Gated");
    if (row === null) throw new Error("fixture user missing");

    expect(apiUserFromRow(row, viewerFor(stranger)).last_login).toBe(GO_ZERO_TIME);
    expect(apiUserFromRow(row, anonymous).last_login).toBe(GO_ZERO_TIME);
  });

  it("a NULL column (never signed in) renders Go zero time for the self viewer too — upstream's zero TimeStamp", async () => {
    await seedVerifiedUser({ username: "NeverLoggedIn" });
    const row = await findUserByName(env.DB, "NeverLoggedIn");
    if (row === null) throw new Error("fixture user missing");
    expect(row.lastLoginAt).toBeNull();

    const user_ = apiUserFromRow(row, viewerFor(row));
    expect(user_.last_login).toBe(GO_ZERO_TIME);
  });
});

// -----------------------------------------------------------------------------
// The repo wire counters (the stale-zero gap port): release_counter /
// branch_count / updated_at over the landed data, and sort=updated over the
// real column. Upstream derives all three per serialize
// (services/convert/repository.go:161-166/222/228).
// -----------------------------------------------------------------------------

describe("the repo wire counters — release_counter / branch_count / updated_at / sort=updated", () => {
  /** A release row with only the wire-relevant tri-state filled in. */
  async function seedRelease(
    repoId: string,
    publisherId: number,
    tag: string,
    flags: { isDraft?: boolean; isTag?: boolean } = {},
  ): Promise<void> {
    await drizzle(env.DB)
      .insert(releases)
      .values({
        repoId,
        publisherId,
        tagName: tag,
        lowerTagName: tag.toLowerCase(),
        isDraft: flags.isDraft ?? false,
        isTag: flags.isTag ?? false,
      });
  }

  it("release_counter counts the live non-draft, non-tag release rows (db.Count posture)", async () => {
    const owner = await seedVerifiedUser({ username: "wire_releaser" });
    const repoId = await seedRepo(owner.id, "wire_releaser", "released", "public");
    await seedRelease(repoId, owner.id, "v1.0.0");
    await seedRelease(repoId, owner.id, "v1.1.0");
    // The FindReleasesOptions{IncludeDrafts: false, IncludeTags: false}
    // exclusions (models/repo/release.go:276-281): an unpublished draft and a
    // pure tag row (SPEC-0005 §2.3) carry no release.
    await seedRelease(repoId, owner.id, "v2.0-wip", { isDraft: true });
    await seedRelease(repoId, owner.id, "just-a-tag", { isTag: true });

    const pair = await findRepositoryByPath(env.DB, "wire_releaser", "released");
    if (pair === null) throw new Error("fixture repo missing");
    const payload = await toApiRepositoryFull(env.DB, viewerFor(owner), pair);
    expect(payload.release_counter).toBe(2);

    // A producer that skipped the count (a bare pair — webhook payloads,
    // pre-carrier list paths) renders the 0 default.
    expect(toApiRepository(viewerFor(owner), { repo: pair.repo, owner: pair.owner }).release_counter).toBe(0);
  });

  it("release_counter rides the list pages as the correlated subquery (searchRepositories)", async () => {
    const owner = await seedVerifiedUser({ username: "wire_lister" });
    const withRelease = await seedRepo(owner.id, "wire_lister", "listed", "public");
    await seedRepo(owner.id, "wire_lister", "bare", "public");
    await seedRelease(withRelease, owner.id, "v9.9.9");

    const res = await searchRepositories(env.DB, viewerFor(owner), {
      keyword: "",
      topicOnly: false,
      includeDesc: false,
      uid: 0,
      exclusive: false,
      priorityOwnerId: 0,
      teamId: 0,
      starredBy: 0,
      includePrivate: false,
      isPrivate: null,
      template: null,
      archived: null,
      mode: "",
      sort: "",
      order: "",
      page: 1,
      limit: 50,
    });
    const byslug = new Map(res.items.map((item) => [item.repo.slug, item]));
    expect(byslug.get("listed")?.releaseCount).toBe(1);
    expect(byslug.get("bare")?.releaseCount).toBe(0);
  });

  it("updated_at renders the mutation stamp; a null column renders the creation instant", async () => {
    const owner = await seedVerifiedUser({ username: "wire_updater" });
    const pushed = await seedRepo(owner.id, "wire_updater", "pushed", "public");
    await seedRepo(owner.id, "wire_updater", "fresh", "public");
    // The push settle stamps exactly this column (git-http/gate.ts:
    // `.set({ ..., updatedAt: new Date() })` on both settle legs) — the
    // serializer must reflect it, not pin created_at.
    const T1 = new Date("2026-06-01T12:00:00Z");
    await drizzle(env.DB).update(repositories).set({ updatedAt: T1 }).where(eq(repositories.id, pushed));

    const pair = await findRepositoryByPath(env.DB, "wire_updater", "pushed");
    if (pair === null) throw new Error("fixture repo missing");
    expect((await toApiRepositoryFull(env.DB, viewerFor(owner), pair)).updated_at).toBe("2026-06-01T12:00:00.000Z");

    // The nullable pre-column rows (the ALTER ADD COLUMN no-default
    // constraint) render the creation instant — NOW in this harness.
    const freshPair = await findRepositoryByPath(env.DB, "wire_updater", "fresh");
    if (freshPair === null) throw new Error("fixture repo missing");
    expect((await toApiRepositoryFull(env.DB, viewerFor(owner), freshPair)).updated_at).toBe(NOW.toISOString());
  });

  it("branch_count rides the engine reads slice (refs/heads only); absent or failed reads stay 0", async () => {
    const owner = await seedVerifiedUser({ username: "wire_brancher" });
    await seedRepo(owner.id, "wire_brancher", "branched", "public");
    const pair = await findRepositoryByPath(env.DB, "wire_brancher", "branched");
    if (pair === null) throw new Error("fixture repo missing");

    // Two heads + one tag — upstream CountBranches counts BRANCH rows only
    // (is_deleted=false); the refs/heads filter mirrors the branches route.
    const engine = {
      listRefs: () =>
        Promise.resolve({
          head: "refs/heads/main",
          refs: [
            { name: "refs/heads/main", target: "aaaa" },
            { name: "refs/heads/feature", target: "bbbb" },
            { name: "refs/tags/v1", target: "cccc" },
          ],
        }),
    };
    expect(
      (await toApiRepositoryFull(env.DB, viewerFor(owner), pair, undefined, null, engine)).branch_count,
    ).toBe(2);

    // No engine slice handed in → the 0 default (lists, pre-wiring callers).
    expect((await toApiRepositoryFull(env.DB, viewerFor(owner), pair)).branch_count).toBe(0);

    // engineReads' null-on-transport-failure contract → 0, never a throw.
    const dead = { listRefs: () => Promise.resolve(null) };
    expect(
      (await toApiRepositoryFull(env.DB, viewerFor(owner), pair, undefined, null, dead)).branch_count,
    ).toBe(0);
  });

  it("sort=updated orders the real updated_at column, nulls coalescing to created_at", async () => {
    const owner = await seedVerifiedUser({ username: "wire_sorter" });
    await seedRepo(owner.id, "wire_sorter", "sortold", "public");
    const midId = await seedRepo(owner.id, "wire_sorter", "sortmid", "public");
    const newId = await seedRepo(owner.id, "wire_sorter", "sortnew", "public");
    // seedRepo stamps createdAt=NOW (2026-01-01) for all rows; the stamps
    // order mid/new ahead, and `sortold` keeps a null updated_at — the
    // coalesce keeps its sort key at the creation instant (the LEAST updated
    // row, matching upstream's never-null column semantics).
    await drizzle(env.DB).update(repositories).set({ updatedAt: new Date("2026-01-02T00:00:00Z") }).where(eq(repositories.id, midId));
    await drizzle(env.DB).update(repositories).set({ updatedAt: new Date("2026-01-03T00:00:00Z") }).where(eq(repositories.id, newId));

    const base = {
      keyword: "",
      topicOnly: false,
      includeDesc: false,
      // Owned-only (repo.go:159-161, exclusive): scopes the assertion to
      // this test's three rows — public repos from sibling tests would
      // otherwise ride in with equal (creation-instant) sort keys.
      uid: owner.id,
      exclusive: true,
      priorityOwnerId: 0,
      teamId: 0,
      starredBy: 0,
      includePrivate: false,
      isPrivate: null,
      template: null,
      archived: null,
      mode: "" as const,
      page: 1,
      limit: 50,
    };
    const asc = await searchRepositories(env.DB, viewerFor(owner), { ...base, sort: "updated", order: "asc" });
    expect(asc.items.map((item) => item.repo.slug)).toEqual(["sortold", "sortmid", "sortnew"]);
    const desc = await searchRepositories(env.DB, viewerFor(owner), { ...base, sort: "updated", order: "desc" });
    expect(desc.items.map((item) => item.repo.slug)).toEqual(["sortnew", "sortmid", "sortold"]);

    // The arm's SQL rides the COALESCE(updated_at, created_at) key — the
    // same stamp the wire renders (shape pin alongside the ordering pin).
    expect(repositoryOrderBy("updated", "asc").length).toBe(1);
  });
});

describe("the real sort columns — size/git_size/lfs_size/stars/forks (OrderByMap)", () => {
  it("each OrderByMap key orders its own landed column, both directions", async () => {
    const owner = await seedVerifiedUser({ username: "column_sorter" });
    // Three rows whose per-column values scramble the name order, so every
    // key proves it reads ITS column (not slug/id fallback):
    //   slug        alpha   beta   gamma
    //   size_kb      300    100    200   → asc: beta gamma alpha
    //   git_size      30     20     10   → asc: gamma beta alpha
    //   lfs_size       5     15     25   → asc: alpha beta gamma
    //   num_stars      2      9      4   → asc: alpha gamma beta
    //   num_forks      7      1      3   → asc: beta gamma alpha
    const alpha = await seedRepo(owner.id, "column_sorter", "alpha", "public");
    const beta = await seedRepo(owner.id, "column_sorter", "beta", "public");
    const gamma = await seedRepo(owner.id, "column_sorter", "gamma", "public");
    const db = drizzle(env.DB);
    await db.update(repositories).set({ sizeKb: 300, gitSize: 30, lfsSize: 5, numStars: 2, numForks: 7 }).where(eq(repositories.id, alpha));
    await db.update(repositories).set({ sizeKb: 100, gitSize: 20, lfsSize: 15, numStars: 9, numForks: 1 }).where(eq(repositories.id, beta));
    await db.update(repositories).set({ sizeKb: 200, gitSize: 10, lfsSize: 25, numStars: 4, numForks: 3 }).where(eq(repositories.id, gamma));

    // Owned-only (repo.go:159-161, exclusive) scopes the page to this
    // test's three rows — sibling fixtures would ride a public-only search.
    const base = {
      keyword: "",
      topicOnly: false,
      includeDesc: false,
      uid: owner.id,
      exclusive: true,
      priorityOwnerId: 0,
      teamId: 0,
      starredBy: 0,
      includePrivate: false,
      isPrivate: null,
      template: null,
      archived: null,
      mode: "" as const,
      page: 1,
      limit: 50,
    };
    const slugs = (res: { items: Array<{ repo: { slug: string } }> }) => res.items.map((item) => item.repo.slug);

    // "size ASC|DESC" over the settled KiB fold (upstream's byte key
    // divided at render, convert/repository.go:207 — monotone, same order).
    expect(slugs(await searchRepositories(env.DB, viewerFor(owner), { ...base, sort: "size", order: "asc" }))).toEqual(["beta", "gamma", "alpha"]);
    expect(slugs(await searchRepositories(env.DB, viewerFor(owner), { ...base, sort: "size", order: "desc" }))).toEqual(["alpha", "gamma", "beta"]);

    // "git_size ASC|DESC" (repo.go:204 — the settled git footprint KiB).
    expect(slugs(await searchRepositories(env.DB, viewerFor(owner), { ...base, sort: "git_size", order: "asc" }))).toEqual(["gamma", "beta", "alpha"]);
    expect(slugs(await searchRepositories(env.DB, viewerFor(owner), { ...base, sort: "git_size", order: "desc" }))).toEqual(["alpha", "beta", "gamma"]);

    // "lfs_size ASC|DESC" (repo.go:205 — the settled LFS sum KiB).
    expect(slugs(await searchRepositories(env.DB, viewerFor(owner), { ...base, sort: "lfs_size", order: "asc" }))).toEqual(["alpha", "beta", "gamma"]);
    expect(slugs(await searchRepositories(env.DB, viewerFor(owner), { ...base, sort: "lfs_size", order: "desc" }))).toEqual(["gamma", "beta", "alpha"]);

    // SearchOrderByStars(Reverse) = "num_stars ASC|DESC" (db/search.go:23-24)
    // over the settled star tally — no longer the id stand-in.
    expect(slugs(await searchRepositories(env.DB, viewerFor(owner), { ...base, sort: "stars", order: "asc" }))).toEqual(["alpha", "gamma", "beta"]);
    expect(slugs(await searchRepositories(env.DB, viewerFor(owner), { ...base, sort: "stars", order: "desc" }))).toEqual(["beta", "gamma", "alpha"]);

    // SearchOrderByForks(Reverse) = "num_forks ASC|DESC" (db/search.go:25-26).
    expect(slugs(await searchRepositories(env.DB, viewerFor(owner), { ...base, sort: "forks", order: "asc" }))).toEqual(["beta", "gamma", "alpha"]);
    expect(slugs(await searchRepositories(env.DB, viewerFor(owner), { ...base, sort: "forks", order: "desc" }))).toEqual(["alpha", "gamma", "beta"]);

    // Shape pins alongside the ordering pins: real columns ride ONE bare
    // ORDER BY expression (upstream's map entries carry no tiebreak).
    for (const key of ["size", "git_size", "lfs_size", "stars", "forks"]) {
      expect(repositoryOrderBy(key, "asc").length).toBe(1);
    }
  });

  it("the stand-in arms are gone: every row with equal keys is admissible order (no id tiebreak leakage)", async () => {
    // The former stand-in forced CAST(id)+id under equal sort keys; the real
    // column leaves ties to the engine exactly like upstream. Two rows with
    // identical values must BOTH answer regardless of which internal order
    // the engine picks — the assertion pins membership/total, not sequence.
    const owner = await seedVerifiedUser({ username: "tie_sorter" });
    await seedRepo(owner.id, "tie_sorter", "tiea", "public");
    await seedRepo(owner.id, "tie_sorter", "tieb", "public");
    const base = {
      keyword: "",
      topicOnly: false,
      includeDesc: false,
      uid: owner.id,
      exclusive: true,
      priorityOwnerId: 0,
      teamId: 0,
      starredBy: 0,
      includePrivate: false,
      isPrivate: null,
      template: null,
      archived: null,
      mode: "" as const,
      page: 1,
      limit: 50,
    };
    const tied = await searchRepositories(env.DB, viewerFor(owner), { ...base, sort: "stars", order: "asc" });
    expect(tied.total).toBe(2);
    expect(tied.items.map((item) => item.repo.slug).sort()).toEqual(["tiea", "tieb"]);
  });
});

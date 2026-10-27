/**
 * Org service on real D1 (SPEC-0007 §5, service-layer half): create/list/get
 * roundtrip with the §2.2 self-list semantics, the §4.7 anonymous-repos
 * quirk, the §3.4 repo-create grant, the §4.3 last-owner guard, the §4.11
 * type-blind-then-check resolution, and rename storage behavior (§4.4 —
 * repos untouched, redirect seam).
 *
 * Schema: landed migrations (applyAuthD1Migrations) + the DDL-in-waiting
 * (applyOrgsDdl) until the drizzle migration lands.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { canViewRepositoryWithTeams, doerRepoAccessMode, type Viewer } from "../../api/services/repository";
import { RepoService } from "../../repos/service";
import {
  LastOrgOwnerError,
  OrgMemberUserNotExistError,
  OrgNameCharsInvalidError,
  OrgNameCollisionError,
  OrgNamePatternNotAllowedError,
  OrgNameReservedError,
  OrgNameTooLongError,
  OrgNotExistError,
} from "./errors";
import { OrgService, type CreateOrgInput, type OrgRecord } from "./orgs";
import { applyOrgsDdl, resetOrgTables } from "./testing";

const service = (): OrgService => new OrgService(env.DB);
const repoService = (): RepoService => new RepoService(env.DB);

async function seedOrg(
  name: string,
  options: Partial<Omit<CreateOrgInput, "name" | "ownerId">> = {},
): Promise<OrgRecord> {
  const owner = await seedVerifiedUser({ username: `${name}-owner` });
  return service().createOrg({ name, ownerId: owner.id, ...options });
}

/** Seed a repo owned by an org through the landed repos service. */
async function seedOrgRepo(org: OrgRecord, slug: string, isPrivate = false): Promise<string> {
  const repo = await repoService().create({
    owner: { id: org.id, usernameLower: org.usernameLower },
    name: slug,
    isPrivate,
  });
  return repo.id;
}

/** The storage-level row, for asserting what actually landed. */
const rawUserRow = (lower: string): Promise<Record<string, unknown> | null> =>
  env.DB
    .prepare("SELECT id, username, type, visibility, num_members, full_name FROM users WHERE username_lower = ?")
    .bind(lower)
    .first();

const rawMemberships = async (orgId: number): Promise<{ user_id: number; role: string; is_public: number }[]> =>
  (
    await env.DB
      .prepare("SELECT user_id, role, is_public FROM org_members WHERE org_id = ? ORDER BY user_id")
      .bind(orgId)
      .all<{ user_id: number; role: string; is_public: number }>()
  ).results;

/** Viewer fixture for the repository-service predicates (the
 *  repository.test.ts `viewerFor` shape — requester resolved, not admin). */
const viewerFor = (user: { id: number; username: string }): Viewer => ({
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
    is_admin: false,
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

/** Team + membership + repo grants seeded raw, with `num_members` kept the
 *  way the landed TeamsService maintains it (one row ⇒ 1) — so a counter
 *  assertion reads the maintenance, not a seed artifact. */
async function seedTeamWithMember(
  org: OrgRecord,
  name: string,
  authorize: string,
  userId: number,
  repoIds: string[],
): Promise<number> {
  const team = await env.DB.prepare(
    "INSERT INTO teams (org_id, lower_name, name, authorize, num_members) VALUES (?, ?, ?, ?, 1) RETURNING id",
  )
    .bind(org.id, name, name, authorize)
    .first<{ id: number }>();
  const teamId = team!.id;
  await env.DB.prepare("INSERT INTO team_members (org_id, team_id, user_id) VALUES (?, ?, ?)")
    .bind(org.id, teamId, userId)
    .run();
  for (const repoId of repoIds) {
    await env.DB.prepare("INSERT INTO team_repo_access (org_id, team_id, repo_id) VALUES (?, ?, ?)")
      .bind(org.id, teamId, repoId)
      .run();
  }
  return teamId;
}

const teamCounter = (teamId: number): Promise<number | undefined> =>
  env.DB.prepare("SELECT num_members FROM teams WHERE id = ?").bind(teamId).first<{ num_members: number }>().then(
    (row) => row?.num_members,
  );

beforeAll(async () => {
  await applyAuthD1Migrations();
  await applyOrgsDdl();
});

beforeEach(resetOrgTables);

describe("createOrg + resolution roundtrip (§2.1, §3.1)", () => {
  it("writes the org-as-user row and the owner membership in one batch", async () => {
    const owner = await seedVerifiedUser({ username: "Alice" });
    const org = await service().createOrg({
      name: "Acme",
      ownerId: owner.id,
      fullName: "Acme Corp",
      description: "rockets",
      location: "Perlan",
    });

    // Row shape (§5 lifecycle): type='org', num_members=1, creator owner.
    expect(org.username).toBe("Acme");
    expect(org.usernameLower).toBe("acme");
    expect(org.visibility).toBe("public");
    expect(org.numMembers).toBe(1);
    expect(await rawUserRow("acme")).toMatchObject({ type: "org", num_members: 1, full_name: "Acme Corp" });
    const memberships = await rawMemberships(org.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ user_id: owner.id, role: "owner", is_public: 0 });
  });

  it("resolves case-insensitively and reads plain users / unknown names as null (§4.11)", async () => {
    const org = await seedOrg("Acme");
    const alice = await seedVerifiedUser({ username: "Alice" });

    expect((await service().getOrgByUsername("ACME"))?.id).toBe(org.id);
    // Type-blind row exists, then the type check rejects it — the exact
    // SPEC-0003 owner-resolution mirror: 404-shaped miss, never user-shaped.
    expect(await rawUserRow("alice")).toMatchObject({ type: "user" });
    expect(await service().getOrgByUsername("alice")).toBeNull();
    expect(await service().getOrgByUsername("ALICE")).toBeNull();
    expect(await service().getOrgByUsername("nobody")).toBeNull();
    expect(await service().getOrgById(alice.id)).toBeNull();
  });

  it("arbitrates the shared namespace on UNIQUE(username_lower) — usernames block org slugs", async () => {
    await seedVerifiedUser({ username: "Alice" });
    const err = await service().createOrg({ name: "Alice", ownerId: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgNameCollisionError);
    expect((err as OrgNameCollisionError).status).toBe(409);
    // Upstream ErrUserAlreadyExist message, case-folded name.
    expect((err as OrgNameCollisionError).message).toBe("user already exists [name: Alice]");

    await seedOrg("Acme");
    const second = await service().createOrg({ name: "ACME", ownerId: 1 }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(OrgNameCollisionError);
  });

  it("validates names with the ported IsUsableUsername rules (§4.1, §4.12)", async () => {
    const creator = (await seedVerifiedUser({ username: "Founder" })).id;
    // Upstream checks the validity pattern BEFORE the reserved list
    // (user.go:665–666), so a leading-dot name is a chars error even though
    // it is also reserved.
    const cases: [string, new (...args: never[]) => Error][] = [
      ["api", OrgNameReservedError],
      ["swagger.v1.json", OrgNameReservedError],
      ["ghost", OrgNameReservedError],
      ["invite.rss", OrgNamePatternNotAllowedError],
      ["key.gpg", OrgNamePatternNotAllowedError],
      [".well-known", OrgNameCharsInvalidError],
      ["a..b", OrgNameCharsInvalidError],
      ["-lead", OrgNameCharsInvalidError],
      ["trail.", OrgNameCharsInvalidError],
      ["has space", OrgNameCharsInvalidError],
    ];
    for (const [name, errorClass] of cases) {
      const err = await service().createOrg({ name, ownerId: creator }).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(errorClass);
      // The typed-error discriminators carry the class name.
      expect((err as Error).name, name).toBe(errorClass.name);
    }
    expect((await service().createOrg({ name: "ok.name-1", ownerId: creator })).username).toBe("ok.name-1");

    // The CreateOrgOption MaxSize(40) binding as a service sanity check.
    const long = "a".repeat(41);
    const err = await service().createOrg({ name: long, ownerId: creator }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgNameTooLongError);
  });

  it("creating on a name that is a live redirect consumes the redirect (§4.10)", async () => {
    const org = await seedOrg("OldOrg");
    await service().renameOrg(org.id, "NewOrg");
    expect(await service().lookupUserRedirect("oldorg")).toBe(org.id);

    const creator = (await seedVerifiedUser({ username: "Founder" })).id;
    const replacement = await service().createOrg({ name: "oldorg", ownerId: creator });
    expect(await service().lookupUserRedirect("oldorg")).toBeNull();
    expect(replacement.usernameLower).toBe("oldorg");
  });
});

describe("listUserOrgs (§2.2 row 1 self-list semantics)", () => {
  it("self-list skips the is_public filter and orders lower_name ASC", async () => {
    const member = await seedVerifiedUser({ username: "Carol" });
    const pub = await seedOrg("Zeta", { visibility: "public" });
    const lim = await seedOrg("Alpha", { visibility: "limited" });
    const pri = await seedOrg("Midas", { visibility: "private" });

    // Two non-public-flagged memberships on purpose (upstream default false).
    await service().addMember(pub.id, member.id, { isPublic: true });
    await service().addMember(lim.id, member.id, { isPublic: false });
    await service().addMember(pri.id, member.id, { isPublic: false });

    // Self (ceiling 'private' — the default): ALL memberships, is_public
    // ignored, ordered by lower_name (Alpha, Midas, Zeta).
    const self = await service().listUserOrgs(member.id);
    expect(self.total).toBe(3);
    expect(self.items.map((org) => org.usernameLower)).toEqual(["alpha", "midas", "zeta"]);
    expect(self.items.map((org) => org.visibility)).toEqual(["limited", "private", "public"]);
  });

  it("public-only / other-viewer ceilings degrade visibility AND membership flags", async () => {
    const member = await seedVerifiedUser({ username: "Carol" });
    const pub = await seedOrg("Pub", { visibility: "public" });
    const lim = await seedOrg("Lim", { visibility: "limited" });
    const pri = await seedOrg("Pri", { visibility: "private" });
    await service().addMember(pub.id, member.id, { isPublic: true });
    await service().addMember(lim.id, member.id, { isPublic: true });
    await service().addMember(pri.id, member.id, { isPublic: true });
    // A public org whose membership is NOT public-flagged (the
    // org_list.go:57–63 degrade drops it too).
    const secret = await seedOrg("Secret", { visibility: "public" });
    await service().addMember(secret.id, member.id, { isPublic: false });

    const pubOnly = await service().listUserOrgs(member.id, { maxVisibility: "public" });
    expect(pubOnly.items.map((org) => org.usernameLower)).toEqual(["pub"]);

    const limited = await service().listUserOrgs(member.id, { maxVisibility: "limited" });
    expect(limited.items.map((org) => org.usernameLower)).toEqual(["lim", "pub"]);

    const userships = await service().listUserOrgs(member.id);
    expect(userships.total).toBe(4);
  });

  it("paginates with SPEC-0004 §2.5 clamps (30 default / 50 max)", async () => {
    const member = await seedVerifiedUser({ username: "Carol" });
    for (let i = 0; i < 3; i++) {
      const org = await seedOrg(`org-${String(i).padStart(2, "0")}`);
      await service().addMember(org.id, member.id);
    }
    const page = await service().listUserOrgs(member.id, { page: 2, pageSize: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    expect((await service().listUserOrgs(member.id, { pageSize: 100 })).items).toHaveLength(3);
  });
});

describe("listOrgRepos (§2.2 row 2, §4.7 anonymity quirk)", () => {
  it("lists public repos of a limited/private org ANONYMOUSLY — no owner-visibility gate", async () => {
    const org = await seedOrg("Quiet", { visibility: "public" });
    const publicRepo = await seedOrgRepo(org, "open");
    await seedOrgRepo(org, "hidden", true);

    // Flip the owner to limited, then private: the git gate would 401 and
    // GET /orgs/{org} would 404, but this listing keeps serving the public
    // repo to anonymous callers — the mirrored upstream quirk.
    await service().setOrgVisibility(org.id, "limited");
    const limited = await service().listOrgRepos(org.id, { id: null });
    expect(limited.total).toBe(1);
    expect(limited.items.map((repo) => repo.id)).toEqual([publicRepo]);
    expect((await service().getOrgByUsername("Quiet"))?.visibility).toBe("limited");

    await service().setOrgVisibility(org.id, "private");
    const priv = await service().listOrgRepos(org.id, { id: null });
    expect(priv.total).toBe(1);
    expect(priv.items.map((repo) => repo.id)).toEqual([publicRepo]);
  });

  it("signed doers: private rows only via tier-1 unit access (org owner) or admin", async () => {
    const org = await seedOrg("Staff", { visibility: "private" });
    await seedOrgRepo(org, "open");
    const privateId = await seedOrgRepo(org, "hidden", true);
    const owner = await seedVerifiedUser({ username: "Boss" });
    const plain = await seedVerifiedUser({ username: "Intern" });
    await service().addMember(org.id, owner.id, { role: "owner" });
    await service().addMember(org.id, plain.id, { role: "member" });

    // Plain member: no team at tier 1 ⇒ zero unit access ⇒ public rows only.
    const memberView = await service().listOrgRepos(org.id, { id: plain.id });
    expect(memberView.total).toBe(1);
    // Owner member: the Owners-team collapse sees private rows.
    const ownerView = await service().listOrgRepos(org.id, { id: owner.id });
    expect(ownerView.total).toBe(2);
    expect(ownerView.items.map((repo) => repo.id)).toContain(privateId);
    // Admin bypass.
    expect((await service().listOrgRepos(org.id, { id: null, isAdmin: true })).total).toBe(2);
    // Unknown org id lists empty (the route 404s at getOrgByUsername first).
    expect((await service().listOrgRepos(987654, { id: null })).total).toBe(0);
  });

  it("paginates by slug ASC with totals", async () => {
    const org = await seedOrg("Pager");
    for (const slug of ["c", "a", "b"]) await seedOrgRepo(org, slug);
    const page = await service().listOrgRepos(org.id, { id: null }, { page: 2, pageSize: 2 });
    expect(page.total).toBe(3);
    expect(page.items.map((repo) => repo.slug)).toEqual(["c"]);
  });
});

describe("canCreateOrgRepo (§3.4 role='owner' equivalence)", () => {
  it("grants owners, refuses plain members and non-members", async () => {
    const org = await seedOrg("Builders");
    const creator = (await rawUserRow("builders-owner"))!.id as number;
    const plain = (await seedVerifiedUser({ username: "Intern" })).id;
    const outsider = (await seedVerifiedUser({ username: "Stranger" })).id;
    await service().addMember(org.id, plain, { role: "member" });

    expect(await service().canCreateOrgRepo(org.id, creator)).toBe(true);
    expect(await service().canCreateOrgRepo(org.id, plain)).toBe(false);
    expect(await service().canCreateOrgRepo(org.id, outsider)).toBe(false);
    // Site-admin bypass is caller-level (fork.go:97–108), not in the predicate.
  });

  it("§3.4 tier-2 team arm: a can_create_org_repo (or authorize='owner') team member can create; plain teams cannot", async () => {
    const org = await seedOrg("Creators");
    const creator = (await rawUserRow("creators-owner"))!.id as number;
    const granted = (await seedVerifiedUser({ username: "Shipper" })).id;
    const plain = (await seedVerifiedUser({ username: "Intern" })).id;
    await service().addMember(org.id, granted, { role: "member" });
    await service().addMember(org.id, plain, { role: "member" });

    const teamRow = async (name: string, authorize: string, canCreate: boolean) => {
      const inserted = await env.DB.prepare(
        "INSERT INTO teams (org_id, lower_name, name, authorize, can_create_org_repo) VALUES (?, ?, ?, ?, ?) RETURNING id",
      )
        .bind(org.id, name, name, authorize, canCreate ? 1 : 0)
        .first<{ id: number }>();
      return inserted!.id;
    };
    const creators = await teamRow("creators", "read", true);
    await env.DB.prepare("INSERT INTO team_members (org_id, team_id, user_id) VALUES (?, ?, ?)")
      .bind(org.id, creators, granted)
      .run();
    const readers = await teamRow("readers", "read", false);
    await env.DB.prepare("INSERT INTO team_members (org_id, team_id, user_id) VALUES (?, ?, ?)")
      .bind(org.id, readers, plain)
      .run();

    expect(await service().canCreateOrgRepo(org.id, granted)).toBe(true);
    expect(await service().canCreateOrgRepo(org.id, plain)).toBe(false);
    expect(await service().canCreateOrgRepo(org.id, creator)).toBe(true);
  });

  it("isOrgOwner stays narrower than the create grant (upstream IsOrganizationOwner vs CanCreateOrgRepo)", async () => {
    const org = await seedOrg("Split");
    const granted = (await seedVerifiedUser({ username: "Shipper" })).id;
    await service().addMember(org.id, granted, { role: "member" });
    const creators = await env.DB.prepare(
      "INSERT INTO teams (org_id, lower_name, name, authorize, can_create_org_repo) VALUES (?, 'creators', 'creators', 'read', 1) RETURNING id",
    )
      .bind(org.id)
      .first<{ id: number }>();
    await env.DB.prepare("INSERT INTO team_members (org_id, team_id, user_id) VALUES (?, ?, ?)")
      .bind(org.id, creators!.id, granted)
      .run();

    // The create-team arm grants repo creation but NOT ownership (org_user.go
    // 66–77 vs 98–106) — the ownership guards belong on isOrgOwner.
    expect(await service().canCreateOrgRepo(org.id, granted)).toBe(true);
    expect(await service().isOrgOwner(org.id, granted)).toBe(false);
  });
});

describe("teamRepoAccessMode (§3.5 enforcement slice — the shared predicate)", () => {
  it("ranks the covering teams' effective modes; uncovered/private-owner repos read 'none'", async () => {
    const org = await seedOrg("Vault");
    const ownerId = (await rawUserRow("vault-owner"))!.id as number;
    const repoService = new RepoService(env.DB);
    const repo = await repoService.create({
      owner: { id: org.id, usernameLower: org.usernameLower },
      name: "hidden",
      isPrivate: true,
    });

    const grant = async (user: string, mode: string, unitsMap: string | null, repoId: string) => {
      const uid = (await seedVerifiedUser({ username: user })).id;
      await service().addMember(org.id, uid);
      const team = await env.DB.prepare(
        "INSERT INTO teams (org_id, lower_name, name, authorize, units_map) VALUES (?, ?, ?, ?, ?) RETURNING id",
      )
        .bind(org.id, user, user, mode, unitsMap)
        .first<{ id: number }>();
      await env.DB.prepare("INSERT INTO team_members (org_id, team_id, user_id) VALUES (?, ?, ?)")
        .bind(org.id, team!.id, uid)
        .run();
      if (repoId !== "") {
        await env.DB.prepare("INSERT INTO team_repo_access (org_id, team_id, repo_id) VALUES (?, ?, ?)")
          .bind(org.id, team!.id, repoId)
          .run();
      }
      return uid;
    };

    const reader = await grant("reader", "read", null, repo.id);
    const writer = await grant("writer", "none", JSON.stringify({ "repo.code": "write" }), repo.id);
    const admin = await grant("adminer", "admin", null, repo.id);
    const outsider = await grant("uncovered", "read", null, ""); // team covers nothing
    const allMate = await grant("allmate", "read", null, ""); // includes-all below
    await env.DB.prepare("UPDATE teams SET includes_all_repositories = 1 WHERE org_id = ? AND lower_name = 'allmate'").bind(org.id).run();

    expect(await service().teamRepoAccessMode({ id: repo.id, ownerId: org.id }, reader)).toBe("read");
    expect(await service().teamRepoAccessMode({ id: repo.id, ownerId: org.id }, writer)).toBe("write");
    expect(await service().teamRepoAccessMode({ id: repo.id, ownerId: org.id }, admin)).toBe("admin");
    expect(await service().teamRepoAccessMode({ id: repo.id, ownerId: org.id }, allMate)).toBe("read");
    expect(await service().teamRepoAccessMode({ id: repo.id, ownerId: org.id }, outsider)).toBe("none");
    // The org owner reads 'owner' only through the bridge arm (not this
    // predicate — no owners team row exists to join through).
    expect(await service().teamRepoAccessMode({ id: repo.id, ownerId: org.id }, ownerId)).toBe("none");
    // User-owned repo / missing owner: no org to hold teams.
    const alice = await seedVerifiedUser({ username: "Alice" });
    const solo = await repoService.create({ owner: { id: alice.id, usernameLower: "alice" }, name: "solo", isPrivate: true });
    expect(await service().teamRepoAccessMode({ id: solo.id, ownerId: alice.id }, reader)).toBe("none");
    expect(await service().teamRepoAccessMode({ id: solo.id, ownerId: null }, reader)).toBe("none");
  });
});

describe("listOrgRepos — the §3.5 team-grant arm (the audit's flagged gap)", () => {
  /** Team with one member, covering the given repo ids (the grant-helper
   *  shape of the teamRepoAccessMode suite). */
  const grant = async (
    org: OrgRecord,
    user: string,
    mode: string,
    repoIds: string[],
    options: { unitsMap?: string; includesAll?: boolean } = {},
  ): Promise<number> => {
    const uid = (await seedVerifiedUser({ username: user })).id;
    await service().addMember(org.id, uid);
    const team = await env.DB.prepare(
      "INSERT INTO teams (org_id, lower_name, name, authorize, units_map, includes_all_repositories) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
      .bind(org.id, user, user, mode, options.unitsMap ?? null, options.includesAll === true ? 1 : 0)
      .first<{ id: number }>();
    await env.DB.prepare("INSERT INTO team_members (org_id, team_id, user_id) VALUES (?, ?, ?)")
      .bind(org.id, team!.id, uid)
      .run();
    for (const repoId of repoIds) {
      await env.DB.prepare("INSERT INTO team_repo_access (org_id, team_id, repo_id) VALUES (?, ?, ?)")
        .bind(org.id, team!.id, repoId)
        .run();
    }
    return uid;
  };

  it("a team member sees the granted private repo; a stranger and anonymous stay public-only", async () => {
    const org = await seedOrg("Depository");
    const open = await seedOrgRepo(org, "open");
    const hidden = await seedOrgRepo(org, "hidden", true);
    const member = await grant(org, "mate", "read", [hidden]);

    // The grant widens the member's listing to the covered private row.
    const memberView = await service().listOrgRepos(org.id, { id: member });
    expect(memberView.total).toBe(2);
    expect(memberView.items.map((repo) => repo.id).sort()).toEqual([open, hidden].sort());

    // A stranger (and anonymous) still see the public rows only.
    const stranger = (await seedVerifiedUser({ username: "Outsider" })).id;
    for (const doer of [{ id: stranger }, { id: null }]) {
      const view = await service().listOrgRepos(org.id, doer);
      expect(view.total).toBe(1);
      expect(view.items.map((repo) => repo.id)).toEqual([open]);
    }
  });

  it("covers includes-all teams and units-collapsed teams; a non-covering team grants nothing", async () => {
    const org = await seedOrg("Wide");
    const stash = await seedOrgRepo(org, "stash", true);
    await seedOrgRepo(org, "open");

    const allMate = await grant(org, "allmate", "read", [], { includesAll: true });
    // authorize 'none' with a write unit override — effective write through
    // the units_map collapse (the SQL twin's json_each arm).
    const unitsMate = await grant(org, "unitsmate", "none", [stash], {
      unitsMap: JSON.stringify({ "repo.code": "write" }),
    });
    // A write team that covers NOTHING grants no listing row.
    const uncovered = await grant(org, "uncovered", "write", []);

    for (const uid of [allMate, unitsMate]) {
      const view = await service().listOrgRepos(org.id, { id: uid });
      expect(view.items.map((repo) => repo.id)).toContain(stash);
    }
    const plain = await service().listOrgRepos(org.id, { id: uncovered });
    expect(plain.total).toBe(1);
    expect(plain.items.map((repo) => repo.id)).not.toContain(stash);
  });
});

describe("membership guards (§4.3 last-owner, §4.5 states)", () => {
  it("refuses removing the only owner with the upstream 500-mapped error", async () => {
    const org = await seedOrg("Lone");
    const ownerId = (await rawUserRow("lone-owner"))!.id as number;

    const err = await service().removeMember(org.id, ownerId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LastOrgOwnerError);
    expect((err as LastOrgOwnerError).status).toBe(500);
    expect((err as LastOrgOwnerError).message).toBe(`user is the last member of owner team [uid: ${ownerId}]`);
    // Nothing moved.
    expect(await rawMemberships(org.id)).toHaveLength(1);
    expect((await rawUserRow("lone"))?.num_members).toBe(1);

    // Same guard on the demote path (§4.3: ANY change leaving zero owners).
    const demote = await service().setMemberRole(org.id, ownerId, "member").catch((e: unknown) => e);
    expect(demote).toBeInstanceOf(LastOrgOwnerError);
  });

  it("removes and demotes freely once a second owner exists; counter tracks", async () => {
    const org = await seedOrg("Duo");
    const first = (await rawUserRow("duo-owner"))!.id as number;
    const second = (await seedVerifiedUser({ username: "Second" })).id;
    await service().addMember(org.id, second, { role: "owner" });
    expect((await rawUserRow("duo"))?.num_members).toBe(2);

    expect(await service().removeMember(org.id, first)).toBe(true);
    expect((await rawUserRow("duo"))?.num_members).toBe(1);
    expect(await rawMemberships(org.id)).toEqual([{ user_id: second, role: "owner", is_public: 0 }]);

    // Demote the remaining owner after promoting a replacement.
    const third = (await seedVerifiedUser({ username: "Third" })).id;
    await service().addMember(org.id, third);
    expect(await service().setMemberRole(org.id, third, "owner")).toBe(true);
    expect(await service().setMemberRole(org.id, second, "member")).toBe(true);
    // rawMemberships orders by user_id: Second was seeded before Third.
    expect(await rawMemberships(org.id)).toEqual([
      { user_id: second, role: "member", is_public: 0 },
      { user_id: third, role: "owner", is_public: 0 },
    ]);
  });

  it("removeMember on a never-member is a silent no-op: counter untouched, idempotent", async () => {
    const org = await seedOrg("Stable");
    const outsider = (await seedVerifiedUser({ username: "Outsider" })).id;
    expect((await rawUserRow("stable"))?.num_members).toBe(1); // creator only

    // Regression: removing a user who was NEVER a member must not decrement
    // num_members — the in-batch `(SELECT COUNT(*) …) = 0` guard is also
    // true for absent rows, so the service pre-checks the membership itself
    // (upstream RemoveOrgUser `!has → return nil`, user.go:31–35). No error,
    // false, and repeated calls stay no-ops.
    expect(await service().removeMember(org.id, outsider)).toBe(false);
    expect((await rawUserRow("stable"))?.num_members).toBe(1);

    expect(await service().removeMember(org.id, outsider)).toBe(false);
    expect(await service().removeMember(org.id, 424242)).toBe(false);
    expect((await rawUserRow("stable"))?.num_members).toBe(1);
    expect(await rawMemberships(org.id)).toHaveLength(1); // creator untouched
  });

  it("addMember is idempotent (upstream AddOrgUser silence) and validates targets", async () => {
    const org = await seedOrg("Members");
    const user = (await seedVerifiedUser({ username: "Newbie" })).id;

    expect(await service().addMember(org.id, user)).toBe(true);
    expect(await service().addMember(org.id, user)).toBe(false);
    expect((await rawUserRow("members"))?.num_members).toBe(2); // creator + one

    const missingUser = await service().addMember(org.id, 424242).catch((e: unknown) => e);
    expect(missingUser).toBeInstanceOf(OrgMemberUserNotExistError);
    const missingOrg = await service().addMember(424242, user).catch((e: unknown) => e);
    expect(missingOrg).toBeInstanceOf(OrgNotExistError);
    expect(await service().removeMember(org.id, 424242)).toBe(false); // non-member: silent no-op
  });
});

describe("removeMember revokes the team grants (the S2 sweep)", () => {
  // Every grant predicate — teamRepoAccessMode, the org-repos team arm, the
  // feeds cond, the git push gate via doerRepoAccessMode — joins team_members
  // WITHOUT re-checking org membership, so the membership delete alone leaves
  // a removed member reading and pushing. The round-trip below drives the
  // real predicates, not row counts.

  it("a member on TWO teams loses git push + API visibility on BOTH org repos immediately", async () => {
    const org = await seedOrg("Revoke");
    const mate = await seedVerifiedUser({ username: "Mate" });
    await service().addMember(org.id, mate.id);
    const alpha = await seedOrgRepo(org, "alpha", true);
    const beta = await seedOrgRepo(org, "beta", true);
    // One write-mode team per repo, the mate on both.
    await seedTeamWithMember(org, "alpha-crew", "write", mate.id, [alpha]);
    await seedTeamWithMember(org, "beta-crew", "write", mate.id, [beta]);
    const alphaRow = (await repoService().get(alpha))!;
    const betaRow = (await repoService().get(beta))!;

    // Precondition — the grants are live through the real predicates: the
    // git push gate (doerRepoAccessMode — git-http/acl.ts consults exactly
    // this) resolves write, and the API visibility resolver admits the
    // private rows.
    expect(await doerRepoAccessMode(env.DB, alphaRow, mate.id)).toBe("write");
    expect(await doerRepoAccessMode(env.DB, betaRow, mate.id)).toBe("write");
    expect(await canViewRepositoryWithTeams(env.DB, viewerFor(mate), alphaRow)).toBe(true);
    expect(await canViewRepositoryWithTeams(env.DB, viewerFor(mate), betaRow)).toBe(true);

    expect(await service().removeMember(org.id, mate.id)).toBe(true);

    // Revocation is immediate on BOTH repos: write mode (push) and the
    // private-repo view are both gone with the swept team rows.
    expect(await doerRepoAccessMode(env.DB, alphaRow, mate.id)).toBe("none");
    expect(await doerRepoAccessMode(env.DB, betaRow, mate.id)).toBe("none");
    expect(await canViewRepositoryWithTeams(env.DB, viewerFor(mate), alphaRow)).toBe(false);
    expect(await canViewRepositoryWithTeams(env.DB, viewerFor(mate), betaRow)).toBe(false);

    // The rows behind the predicates: BOTH team_members rows are gone (the
    // S2 bug left them standing), and num_members held on both sides —
    // org counter back to the creator alone, each swept team back to 0.
    const leftovers = await env.DB
      .prepare("SELECT team_id FROM team_members WHERE org_id = ? AND user_id = ?")
      .bind(org.id, mate.id)
      .all<{ team_id: number }>();
    expect(leftovers.results).toHaveLength(0);
    expect((await rawUserRow("revoke"))?.num_members).toBe(1);
    const counters = await env.DB
      .prepare("SELECT lower_name, num_members FROM teams WHERE org_id = ? ORDER BY lower_name")
      .bind(org.id)
      .all<{ lower_name: string; num_members: number }>();
    expect(counters.results).toEqual([
      { lower_name: "alpha-crew", num_members: 0 },
      { lower_name: "beta-crew", num_members: 0 },
    ]);
  });

  it("the last-owner guard holds the WHOLE sweep: an owner on a team keeps the team row and every counter", async () => {
    const org = await seedOrg("Loyal");
    const ownerId = (await rawUserRow("loyal-owner"))!.id as number;
    const teamId = await seedTeamWithMember(org, "owners-crew", "read", ownerId, []);

    const err = await service().removeMember(org.id, ownerId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LastOrgOwnerError);

    // Upstream's whole-tx rollback shape: the sweep is chained to the
    // membership delete (the same guarded-batch pattern), so a held delete
    // keeps the team row AND both counters in place.
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?")
        .bind(teamId)
        .first<{ n: number }>(),
    ).toMatchObject({ n: 1 });
    expect(await teamCounter(teamId)).toBe(1);
    expect((await rawUserRow("loyal"))?.num_members).toBe(1);
    expect(await rawMemberships(org.id)).toHaveLength(1);
  });

  it("a member on NO team: the sweep is a no-op and a team they never joined keeps its counter", async () => {
    const org = await seedOrg("Plain");
    const loner = await seedVerifiedUser({ username: "Loner" });
    const mate = await seedVerifiedUser({ username: "Mate" });
    await service().addMember(org.id, loner.id);
    await service().addMember(org.id, mate.id);
    const othersId = await seedTeamWithMember(org, "others", "read", mate.id, []);
    expect((await rawUserRow("plain"))?.num_members).toBe(3);

    expect(await service().removeMember(org.id, loner.id)).toBe(true);
    // The org counter moves (3 → 2); the counter decrement is per SWEPT
    // team, never org-wide — `others` keeps counting its own member.
    expect((await rawUserRow("plain"))?.num_members).toBe(2);
    expect(await teamCounter(othersId)).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE org_id = ?").bind(org.id).first<{ n: number }>()).toMatchObject({ n: 1 });

    // Repeat removal stays the silent no-op (the pre-check arm).
    expect(await service().removeMember(org.id, loner.id)).toBe(false);
    expect((await rawUserRow("plain"))?.num_members).toBe(2);
  });
});

describe("deleteOrg (the org-lifecycle sweep)", () => {
  it("sweeps teams, team_members and team_repo_access with the org (migration 0015 rows)", async () => {
    const org = await seedOrg("Doomed");
    const mate = await seedVerifiedUser({ username: "Mate" });
    await service().addMember(org.id, mate.id);
    await seedTeamWithMember(org, "crew", "read", mate.id, ["t_ghost"]);
    // A memberless team carrying a grant row too (org_id-swept, not
    // member-swept — team_repo_access.repo_id declares no FK).
    const empty = await env.DB
      .prepare("INSERT INTO teams (org_id, lower_name, name) VALUES (?, 'empty', 'empty') RETURNING id")
      .bind(org.id)
      .first<{ id: number }>();
    await env.DB.prepare("INSERT INTO team_repo_access (org_id, team_id, repo_id) VALUES (?, ?, 't_ghost2')")
      .bind(org.id, empty!.id)
      .run();

    expect(await service().deleteOrg(org.id)).toBe(true);
    for (const table of ["teams", "team_members", "team_repo_access", "org_members"]) {
      const row = await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`)
        .bind(org.id)
        .first<{ n: number }>();
      expect(row, table).toMatchObject({ n: 0 });
    }
    expect(await rawUserRow("doomed")).toBeNull();
    // Already-gone org: false no-op.
    expect(await service().deleteOrg(org.id)).toBe(false);
  });

  it("still refuses when the org owns repositories — and the refusal sweeps nothing", async () => {
    const org = await seedOrg("Holding");
    const mate = await seedVerifiedUser({ username: "Mate" });
    await service().addMember(org.id, mate.id);
    const teamId = await seedTeamWithMember(org, "crew", "read", mate.id, []);
    await seedOrgRepo(org, "kept", true);

    const err = await service().deleteOrg(org.id).catch((e: unknown) => e);
    // Upstream ErrUserOwnRepos, deliberately untyped (the 500-shaped guard).
    expect((err as Error).message).toBe(`organization owns repositories [uid: ${org.id}]`);
    expect(await teamCounter(teamId)).toBe(1);
    expect(await rawMemberships(org.id)).toHaveLength(2);
    expect(await rawUserRow("holding")).not.toBeNull();
  });
});

describe("renameOrg (§4.4 metadata-only + redirect seam)", () => {
  it("rewrites the namespace, leaves repos untouched, files the redirect", async () => {
    const org = await seedOrg("Acme");
    const repoId = await seedOrgRepo(org, "rocket");
    const before = await repoService().get(repoId);

    const renamed = await service().renameOrg(org.id, "AcmeLabs");

    // users row flipped; redirect old→id (the 307 owner-segment seam).
    expect(renamed.username).toBe("AcmeLabs");
    expect(renamed.usernameLower).toBe("acmelabs");
    expect(await service().lookupUserRedirect("acme")).toBe(org.id);
    expect(await service().lookupUserRedirect("acmelabs")).toBeNull();

    // The repo row keeps its identity and storage; only the denormalized
    // owner_namespace flips (upstream's owner_name rewrite) so /neworg/…
    // resolves. repo_redirects untouched (owner_id keyed).
    const after = await repoService().get(repoId);
    expect(after).toMatchObject({
      id: before?.id,
      storageKey: before?.storageKey,
      slug: before?.slug,
      visibility: before?.visibility,
      refsVersion: before?.refsVersion,
      ownerId: org.id,
      ownerNamespace: "acmelabs",
    });
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM repo_redirects").first<{ n: number }>())?.n,
    ).toBe(0);
    // Re-resolution through the new namespace works; getOrgByUsername
    // follows the users row, not a cached name.
    expect((await service().getOrgByUsername("ACMELABS"))?.id).toBe(org.id);
    expect(await service().getOrgByUsername("acme")).toBeNull();
  });

  it("case-only renames flip display case and write NO redirect (user.go:48–59)", async () => {
    const org = await seedOrg("acme");
    const renamed = await service().renameOrg(org.id, "ACME");
    expect(renamed.username).toBe("ACME");
    expect(renamed.usernameLower).toBe("acme");
    expect(await service().lookupUserRedirect("acme")).toBeNull();
  });

  it("renaming onto a live redirect consumes it; collisions refuse", async () => {
    const first = await seedOrg("First");
    await service().renameOrg(first.id, "Moved");
    expect(await service().lookupUserRedirect("first")).toBe(first.id);

    const second = await seedOrg("Second");
    const renamed = await service().renameOrg(second.id, "First"); // shadowed name
    expect(renamed.usernameLower).toBe("first");
    expect(await service().lookupUserRedirect("first")).toBeNull(); // consumed
    expect(await service().lookupUserRedirect("second")).toBe(second.id);

    await seedVerifiedUser({ username: "Alice" });
    const clash = await service().renameOrg(second.id, "alice").catch((e: unknown) => e);
    expect(clash).toBeInstanceOf(OrgNameCollisionError);

    const same = await service().renameOrg(second.id, "First");
    expect(same.username).toBe("First"); // exact no-op returns the row
  });

  it("404-shapes unknown orgs and invalid names", async () => {
    const missing = await service().renameOrg(424242, "whatever").catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(OrgNotExistError);
    expect((missing as OrgNotExistError).message).toBe("org does not exist [id: 424242, name: ]");

    const org = await seedOrg("Valid");
    const bad = await service().renameOrg(org.id, "bad..name").catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(OrgNameCharsInvalidError);
  });
});

describe("setOrgVisibility (§4.8)", () => {
  it("flips the users-row column in place", async () => {
    const org = await seedOrg("Chameleon");
    await service().setOrgVisibility(org.id, "limited");
    expect((await service().getOrgByUsername("chameleon"))?.visibility).toBe("limited");
    await service().setOrgVisibility(org.id, "private");
    expect(await rawUserRow("chameleon")).toMatchObject({ visibility: "private" });

    const missing = await service().setOrgVisibility(424242, "public").catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(OrgNotExistError);
  });
});

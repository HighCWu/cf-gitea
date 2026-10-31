/**
 * The mention resolution fixtures over the real D1 bindings.
 *
 * Derived arms (cite-marked): upstream has NO unit test for
 * `ResolveIssueMentionsByVisibility` at the pin — models/issues/
 * issue_update_test.go carries none. Every arm below cites the line it
 * pins from gitea/models/issues/issue_update.go:575-696 (fc493688): the
 * case-fold + dedupe map, the doer pre-seed, the org-prefix team branch,
 * the team_repo join + unit gate, the active-member expansion, the
 * individual read gate with the organization skip, and the empty
 * fast-paths.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repoCollaborators, repositories, teamMembers, teamRepoAccess, teams, users } from "../../db/schema";
import { resolveIssueMentionsByVisibility } from "./resolve";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const ORG_ID = 100;
const SOLO_ID = 1;
const DOER_ID = 10;
const ALICE_ID = 20;
const BOB_ID = 21;
const CAROL_ID = 30;
const DAVE_ID = 40;
const ADMIN_ID = 50;
const FROZEN_ID = 60;
const TMEMBER_ID = 80;

const ORG_REPO = "900";
const SOLO_REPO = "901";
const PRIVATE_ORG_REPO = "902";

interface FixtureUser {
  id: number;
  username: string;
  email: string;
  type?: "user" | "org";
  status?: "active" | "prohibited";
  isAdmin?: boolean;
}

const FIXTURE_USERS: FixtureUser[] = [
  { id: SOLO_ID, username: "solo", email: "solo@example.com" },
  { id: ORG_ID, username: "acme", email: "acme@example.com", type: "org" },
  { id: DOER_ID, username: "author", email: "author@example.com" },
  { id: ALICE_ID, username: "alice", email: "alice@example.com" },
  { id: BOB_ID, username: "bob", email: "bob@example.com" },
  { id: CAROL_ID, username: "carol", email: "carol@example.com" },
  { id: DAVE_ID, username: "dave", email: "dave@example.com" },
  { id: ADMIN_ID, username: "root", email: "root@example.com", isAdmin: true },
  { id: FROZEN_ID, username: "frozen", email: "frozen@example.com", status: "prohibited" },
  { id: TMEMBER_ID, username: "tmember", email: "tmember@example.com" },
];

const db = () => drizzle(env.DB);

async function dbUser(id: number) {
  const row = await db().select().from(users).where(eq(users.id, id)).get();
  if (row === undefined) throw new Error(`fixture user ${id} missing`);
  return row;
}

async function seedAll(): Promise<void> {
  for (const u of FIXTURE_USERS) {
    await db().insert(users).values({
      id: u.id,
      username: u.username,
      usernameLower: u.username.toLowerCase(),
      email: u.email,
      status: u.status ?? "active",
      type: u.type ?? "user",
      isAdmin: u.isAdmin ?? false,
      createdAt: new Date(0),
    });
  }
  await db().insert(repositories).values([
    { id: ORG_REPO, storageKey: `r_${ORG_REPO}`, ownerNamespace: "acme", ownerId: ORG_ID, slug: "repo", visibility: "public", status: "ready" },
    { id: SOLO_REPO, storageKey: `r_${SOLO_REPO}`, ownerNamespace: "solo", ownerId: SOLO_ID, slug: "repo", visibility: "public", status: "ready" },
    {
      id: PRIVATE_ORG_REPO,
      storageKey: `r_${PRIVATE_ORG_REPO}`,
      ownerNamespace: "acme",
      ownerId: ORG_ID,
      slug: "priv",
      visibility: "private",
      status: "ready",
    },
  ]);
  await db().insert(teams).values([
    { id: 1, orgId: ORG_ID, lowerName: "devs", name: "devs", authorize: "write", unitsMap: null },
    // The unit-gated team: authorize 'none' + an issues-only override (the
    // upstream team_unit collapse — issues enabled, pulls not).
    { id: 2, orgId: ORG_ID, lowerName: "unit", name: "unit", authorize: "none", unitsMap: JSON.stringify({ "repo.issues": "read" }) },
    { id: 3, orgId: ORG_ID, lowerName: "elsewhere", name: "elsewhere", authorize: "write", unitsMap: null },
  ]);
  await db().insert(teamRepoAccess).values([
    { orgId: ORG_ID, teamId: 1, repoId: ORG_REPO },
    { orgId: ORG_ID, teamId: 1, repoId: PRIVATE_ORG_REPO },
    { orgId: ORG_ID, teamId: 2, repoId: ORG_REPO },
    { orgId: ORG_ID, teamId: 3, repoId: "999" },
  ]);
  await db().insert(teamMembers).values([
    { orgId: ORG_ID, teamId: 1, userId: ALICE_ID },
    { orgId: ORG_ID, teamId: 1, userId: FROZEN_ID },
    { orgId: ORG_ID, teamId: 2, userId: BOB_ID },
    { orgId: ORG_ID, teamId: 3, userId: TMEMBER_ID },
  ]);
  await db().insert(repoCollaborators).values({ repoId: PRIVATE_ORG_REPO, userId: DAVE_ID, mode: "write" });
}

/** resolve() against the fixture repos; visibility/owner derived from the id. */
async function resolve(repoId: string, isPull: boolean, names: string[], doerId = DOER_ID): Promise<Awaited<ReturnType<typeof dbUser>>[]> {
  const repo =
    repoId === SOLO_REPO
      ? { id: repoId, ownerId: SOLO_ID, visibility: "public" as const }
      : { id: repoId, ownerId: ORG_ID, visibility: repoId === PRIVATE_ORG_REPO ? ("private" as const) : ("public" as const) };
  return resolveIssueMentionsByVisibility(env.DB, { repo, isPull, doer: await dbUser(doerId), mentions: names });
}

beforeEach(async () => {
  for (const table of ["team_repo_access", "team_members", "teams", "repo_collaborators", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await seedAll();
});

// ---------------------------------------------------------------------------
// Individual arms (issue_update.go:595-611 classify, :657-693 individuals)
// ---------------------------------------------------------------------------

describe("resolveIssueMentionsByVisibility — individual users", () => {
  it("public repo: every active non-org mention resolves, missing names drop (:657-693)", async () => {
    const rows = await resolve(ORG_REPO, false, ["alice", "carol", "nobody"]);
    expect(rows.map((r) => r.username)).toEqual(["alice", "carol"]);
  });

  it("private repo: no grant drops the user, a collaborator row keeps them (:685-691)", async () => {
    const rows = await resolve(PRIVATE_ORG_REPO, false, ["carol", "dave"]);
    expect(rows.map((r) => r.username)).toEqual(["dave"]);
  });

  it("site admin reads everything (:685-691 via repo_permission.go:472-474)", async () => {
    const rows = await resolve(PRIVATE_ORG_REPO, false, ["root"]);
    expect(rows.map((r) => r.username)).toEqual(["root"]);
  });

  it("the doer's own name is pre-seeded resolved — no self-mention (:595)", async () => {
    const rows = await resolve(ORG_REPO, false, ["author", "alice"]);
    expect(rows.map((r) => r.username)).toEqual(["alice"]);
  });

  it("organization rows are skipped as individuals (:681 user.IsOrganization)", async () => {
    const rows = await resolve(ORG_REPO, false, ["acme"]);
    expect(rows).toEqual([]);
  });

  it("login-prohibited users drop (the :673-679 is_active/prohibit_login filter, our status='active')", async () => {
    const rows = await resolve(PRIVATE_ORG_REPO, false, ["frozen"]);
    expect(rows).toEqual([]);
  });

  it("case-fold + dedupe: one row for @ALICE @alice @Alice (:597 strings.ToLower, the resolved map)", async () => {
    const rows = await resolve(ORG_REPO, false, ["ALICE", "alice", "Alice"]);
    expect(rows.map((r) => r.username)).toEqual(["alice"]);
  });

  it("empty mention list returns without touching the db (:576-578)", async () => {
    expect(await resolve(ORG_REPO, false, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Team arms (issue_update.go:601-607 the org-prefix branch, :613-655 expansion)
// ---------------------------------------------------------------------------

describe("resolveIssueMentionsByVisibility — team mentions @org/team", () => {
  it("a repo-granted team expands to its ACTIVE members, prohibited members drop (:634-652)", async () => {
    const rows = await resolve(ORG_REPO, false, ["acme/devs"]);
    expect(rows.map((r) => r.username)).toEqual(["alice"]);
  });

  it("the team key resolves case-insensitively (lower_name IN, :618)", async () => {
    const rows = await resolve(ORG_REPO, false, ["acme/DEVS"]);
    expect(rows.map((r) => r.username)).toEqual(["alice"]);
  });

  it("a wrong org prefix drops the mention (:603 names[0] != owner.LowerName)", async () => {
    const rows = await resolve(ORG_REPO, false, ["other/devs"]);
    expect(rows).toEqual([]);
  });

  it("a team without a grant on THIS repo is not expanded (the team_repo join, :615-619)", async () => {
    const rows = await resolve(ORG_REPO, false, ["acme/elsewhere"]);
    expect(rows).toEqual([]);
  });

  it("a missing team is not expanded", async () => {
    const rows = await resolve(ORG_REPO, false, ["acme/ghost"]);
    expect(rows).toEqual([]);
  });

  it("the unit gate: an issues-only team expands on an issue but NOT on a pull (:624-633 UnitEnabled)", async () => {
    const issueRows = await resolve(ORG_REPO, false, ["acme/unit"]);
    expect(issueRows.map((r) => r.username)).toEqual(["bob"]);
    const pullRows = await resolve(ORG_REPO, true, ["acme/unit"]);
    expect(pullRows).toEqual([]);
  });

  it("a plain-permission team (no overrides) rides its authorize for BOTH kinds (UnitAccessModeEx max, team.go:214)", async () => {
    const issueRows = await resolve(ORG_REPO, false, ["acme/devs"]);
    const pullRows = await resolve(ORG_REPO, true, ["acme/devs"]);
    expect(issueRows.map((r) => r.username)).toEqual(["alice"]);
    expect(pullRows.map((r) => r.username)).toEqual(["alice"]);
  });

  it("team mentions on a NON-org repo fall to the individual branch and drop (:601 repoOwnerIsOrg gate)", async () => {
    const rows = await resolve(SOLO_REPO, false, ["acme/devs"]);
    expect(rows).toEqual([]);
  });

  it("a member also named individually resolves ONCE (the resolved map, :647)", async () => {
    const rows = await resolve(ORG_REPO, false, ["alice", "acme/devs"]);
    expect(rows.map((r) => r.username)).toEqual(["alice"]);
  });

  it("team users land BEFORE the individually-checked survivors (upstream's append order, :645 vs :692)", async () => {
    const rows = await resolve(PRIVATE_ORG_REPO, false, ["acme/devs", "dave"]);
    expect(rows.map((r) => r.username)).toEqual(["alice", "dave"]);
  });

  it("the repo owner org's members come through teams, not the org name itself", async () => {
    const rows = await resolve(ORG_REPO, false, ["acme", "acme/devs"]);
    expect(rows.map((r) => r.username)).toEqual(["alice"]);
  });
});

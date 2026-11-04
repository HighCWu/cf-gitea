/**
 * The `/repos/search` four-filter matrix over the LANDED tables — the
 * filters that used to fall into the always-no-match arms (the SPEC-0005
 * "table didn't exist" justifications died when stars / repo_topics /
 * teams+team_members+team_repo_access / org_members landed):
 *
 * - `starredBy` — the pure star join (upstream repo.go:151 → repo_list.go
 *   :396-398), NO starer-profile gate; visibility is gated per repo.
 * - `team_id` — the team's granted repos (repo.go:146 → repo_list.go
 *   :451-453 through the effective-grant shape), no caller-membership gate.
 * - `topic=true` — exact topic-name equality, case-folded (repo.go:147 →
 *   repo_list.go:455-491); substring topic match without the flag;
 *   `topic=true` alone (no `q`) passes everything.
 * - `mode=collaborative` + `uid` — the Collaborate=true arm (repo.go:172-174
 *   → repo_list.go:405-449): collaborator rows + team grants + public repos
 *   of private orgs, minus the hidden-membership exclusion in public-only
 *   searches; `exclusive` collapses to owned-only; the default mode is
 *   owned-OR-collaborates.
 * - `includeDesc` — the keyword arm's `LOWER(description)` substring match
 *   (repo_list.go:484-486) over the 0068 description column, off by default.
 * - keyword ordering — the owner-prefix CASE (repo_list.go:614-618): with
 *   `priorityOwnerId` unset, an exactly-one-slash keyword floats its owner
 *   half to the top of ANY sort; the priority_owner_id arm suppresses it.
 *
 * Cross-visibility refusals are pinned per filter: an anonymous (or
 * public-only) searcher asking for another user's stars, a team's grants, or
 * a collaborator's edges gets only the repos their own visibility already
 * admits — never a private-row leak.
 *
 * The Explore surface (searchExploreRepos, services/search.ts) rides this
 * builder server-side with every filter at its neutral value, so the ported
 * keyword arm (topics included) flows straight through — pinned below.
 */

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import {
  orgMembers,
  repoCollaborators,
  repositories,
  stars,
  teamMembers,
  teamRepoAccess,
  teams,
  users,
  type TeamAccessMode,
} from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { applyOrgsDdl, resetOrgTables } from "../../services/orgs/testing";
import { replaceRepoTopics } from "./repo-topics";
import { searchExploreRepos } from "./search";
import {
  GO_ZERO_TIME,
  listOwnedRepositories,
  listUserRepositories,
  searchRepositories,
  type Viewer,
} from "./repository";

beforeAll(async () => {
  await applyAuthD1Migrations();
  await applyOrgsDdl();
});

beforeEach(async () => {
  // resetOrgTables sweeps repositories (and users, minus the reserved
  // 'assets' row); the repo-scoped side stores are newer than that sweep.
  await env.DB.prepare("DELETE FROM stars").run();
  await env.DB.prepare("DELETE FROM repo_topics").run();
  await env.DB.prepare("DELETE FROM repo_collaborators").run();
  await env.DB.prepare("DELETE FROM team_repo_access").run();
  await env.DB.prepare("DELETE FROM team_members").run();
  await env.DB.prepare("DELETE FROM teams").run();
  await env.DB.prepare("DELETE FROM org_members").run();
  await resetOrgTables();
});

const NOW = new Date("2026-01-01T00:00:00Z");

const anonymous: Viewer = { origin: "https://example.com", requester: null };

/** The `/repos/search` option base the filter suites spread over — every
 * tri-state filter at its "unset" default, no visibility narrowing. */
const searchOpts = {
  page: 1,
  limit: 50,
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
} as const;

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
    last_login: GO_ZERO_TIME,
    type: "User",
    visibility: "public",
  },
});

/** The same identity presenting a PUBLIC-ONLY token (`Viewer.publicOnlyToken`
 *  — the service-level twin of upstream `IsPublicOnlyDoer`; the route-level
 *  twin rides repositories.test.ts's real-scope SELF fetches). */
const publicOnlyViewerFor = (user: { id: number; username: string }, isAdmin = false): Viewer => ({
  ...viewerFor(user, isAdmin),
  publicOnlyToken: true,
});

/** The plain `{page, limit}` the list services take (the clamped values
 *  parseListOptions produces for an unparameterized request). */
const listOpts = { page: 1, limit: 50 };

async function seedRepo(
  ownerId: number,
  ownerNamespace: string,
  slug: string,
  visibility: "public" | "private",
  extra: { forkParent?: string; description?: string | null } = {},
): Promise<string> {
  const id = `sf_${ownerNamespace.replace(/-/g, "_")}_${slug.replace(/-/g, "_")}`;
  await drizzle(env.DB)
    .insert(repositories)
    .values({
      id,
      storageKey: `r_${id}`,
      ownerNamespace,
      ownerId,
      slug,
      visibility,
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: NOW,
      ...extra,
    });
  return id;
}

async function seedStar(userId: number, repoId: string): Promise<void> {
  await drizzle(env.DB).insert(stars).values({ userId, repoId, createdAt: NOW });
}

async function seedCollaborator(userId: number, repoId: string): Promise<void> {
  await drizzle(env.DB).insert(repoCollaborators).values({
    repoId,
    userId,
    mode: "write",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

/** An org with `ownerId` as owner plus one private-visibility org repo. */
async function seedOrg(name: string, ownerId: number): Promise<OrgRecord> {
  return new OrgService(env.DB).createOrg({ name, ownerId });
}

interface SeedTeamOptions {
  authorize?: TeamAccessMode;
  includesAllRepositories?: boolean;
  repoIds?: string[];
  memberIds?: number[];
}

async function seedTeam(org: OrgRecord, name: string, opts: SeedTeamOptions = {}): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(teams)
    .values({
      orgId: org.id,
      lowerName: name.toLowerCase(),
      name,
      authorize: opts.authorize ?? "read",
      includesAllRepositories: opts.includesAllRepositories ?? false,
      unitsMap: null,
      visibility: "private",
    })
    .returning({ id: teams.id })
    .all();
  const teamId = rows[0]!.id;
  for (const userId of opts.memberIds ?? []) {
    await drizzle(env.DB).insert(teamMembers).values({ orgId: org.id, teamId, userId });
  }
  for (const repoId of opts.repoIds ?? []) {
    await drizzle(env.DB).insert(teamRepoAccess).values({ orgId: org.id, teamId, repoId });
  }
  return teamId;
}

async function seedOrgMember(org: OrgRecord, userId: number, isPublic: boolean): Promise<void> {
  await drizzle(env.DB).insert(orgMembers).values({
    orgId: org.id,
    userId,
    isPublic,
    role: "member",
    createdAt: NOW,
  });
}

// ---------------------------------------------------------------------------
// starredBy — the pure star join
// ---------------------------------------------------------------------------

describe("search starredBy (repo_list.go:396-398, the star join)", () => {
  it("matches the starer's stars and gates visibility per searcher", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const pubId = await seedRepo(bob.id, "bob", "pub", "public");
    const privId = await seedRepo(bob.id, "bob", "priv", "private");
    await seedStar(alice.id, pubId);
    await seedStar(alice.id, privId);

    // Anonymous: alice's private star never leaks.
    const hit = await searchRepositories(env.DB, anonymous, { ...searchOpts, starredBy: alice.id });
    expect(hit.total).toBe(1);
    expect(hit.items.map((p) => p.repo.slug)).toEqual(["pub"]);

    // A third party with a signed session still gets only the public star —
    // starring a private repo grants NO access (the star join rides the base
    // visibility, upstream's AccessibleRepositoryCondition interplay).
    const carol = await seedVerifiedUser({ username: "Carol" });
    const other = await searchRepositories(env.DB, viewerFor(carol), {
      ...searchOpts,
      starredBy: alice.id,
      includePrivate: true,
    });
    expect(other.items.map((p) => p.repo.slug)).toEqual(["pub"]);

    // Even the starer herself is gated — until she holds a real edge: as a
    // collaborator on the private repo her own visibility admits it and the
    // star surfaces it.
    await seedCollaborator(alice.id, privId);
    const self = await searchRepositories(env.DB, viewerFor(alice), {
      ...searchOpts,
      starredBy: alice.id,
      includePrivate: true,
    });
    expect(self.total).toBe(2);
    expect(self.items.map((p) => p.repo.slug).sort()).toEqual(["priv", "pub"]);
  });

  it("misses when the user starred nothing", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    await seedRepo(bob.id, "bob", "pub", "public");
    const miss = await searchRepositories(env.DB, anonymous, { ...searchOpts, starredBy: alice.id });
    expect(miss.total).toBe(0);
  });

  it("has no starer-profile gate (upstream filters by the join alone)", async () => {
    // Upstream pins no private-profile no-op on `starredBy` — the raw user id
    // is joined without any `user.visibility` check (repo_list.go:396-398),
    // so a private-profile starer's VISIBLE stars still answer. The repo
    // rows themselves stay gated (the test above).
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    await seedRepo(bob.id, "bob", "pub", "public");
    await seedStar(alice.id, `sf_bob_pub`);
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.id, alice.id));

    const hit = await searchRepositories(env.DB, anonymous, { ...searchOpts, starredBy: alice.id });
    expect(hit.total).toBe(1);
    expect(hit.items.map((p) => p.repo.slug)).toEqual(["pub"]);
  });
});

// ---------------------------------------------------------------------------
// team_id — the team's granted repos
// ---------------------------------------------------------------------------

describe("search team_id (repo_list.go:451-453 through the effective-grant shape)", () => {
  it("matches the team's granted repos, gated per searcher", async () => {
    const orgOwner = await seedVerifiedUser({ username: "OrgOwner" });
    const org = await seedOrg("acme", orgOwner.id);
    const orgPubId = await seedRepo(org.id, org.usernameLower, "orgpub", "public");
    const orgVaultId = await seedRepo(org.id, org.usernameLower, "orgvault", "private");
    const member = await seedVerifiedUser({ username: "Member" });
    const stranger = await seedVerifiedUser({ username: "Stranger" });
    const teamId = await seedTeam(org, "readers", {
      memberIds: [member.id],
      repoIds: [orgPubId, orgVaultId],
    });

    // Anonymous: only the team's public repo.
    const anon = await searchRepositories(env.DB, anonymous, { ...searchOpts, teamId });
    expect(anon.items.map((p) => p.repo.slug)).toEqual(["orgpub"]);

    // The team member sees both grants.
    const memberView = await searchRepositories(env.DB, viewerFor(member), {
      ...searchOpts,
      teamId,
      includePrivate: true,
    });
    expect(memberView.items.map((p) => p.repo.slug).sort()).toEqual(["orgpub", "orgvault"]);

    // A signed non-member gets the team's repos their OWN visibility admits —
    // no caller-membership gate exists upstream (any caller may ask), but the
    // private grant stays hidden.
    const strangerView = await searchRepositories(env.DB, viewerFor(stranger), {
      ...searchOpts,
      teamId,
      includePrivate: true,
    });
    expect(strangerView.items.map((p) => p.repo.slug)).toEqual(["orgpub"]);
  });

  it("includes-all coverage matches repos with no materialized row", async () => {
    const orgOwner = await seedVerifiedUser({ username: "OrgOwner" });
    const org = await seedOrg("beta", orgOwner.id);
    // No team_repo_access row: the includes-all fan-out has not run for this
    // repo (created after the last materialization) — the union arm covers it.
    await seedRepo(org.id, org.usernameLower, "latecomer", "public");
    const teamId = await seedTeam(org, "all-access", { includesAllRepositories: true });

    const hit = await searchRepositories(env.DB, anonymous, { ...searchOpts, teamId });
    expect(hit.items.map((p) => p.repo.slug)).toEqual(["latecomer"]);
  });

  it("misses a team with no grants and an unknown team id", async () => {
    const orgOwner = await seedVerifiedUser({ username: "OrgOwner" });
    const org = await seedOrg("gamma", orgOwner.id);
    await seedRepo(org.id, org.usernameLower, "solo", "public");
    const emptyTeamId = await seedTeam(org, "empty");

    const miss = await searchRepositories(env.DB, anonymous, { ...searchOpts, teamId: emptyTeamId });
    expect(miss.total).toBe(0);

    const unknown = await searchRepositories(env.DB, anonymous, { ...searchOpts, teamId: 424242 });
    expect(unknown.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// topic=true — exact topic-name needles
// ---------------------------------------------------------------------------

describe("search topic=true (repo_list.go:455-491)", () => {
  it("matches topic names EXACTLY under topic=true, case-folded (the upstream equality quirk)", async () => {
    const owner = await seedVerifiedUser({ username: "Owner" });
    const goId = await seedRepo(owner.id, "owner", "goproj", "public");
    await replaceRepoTopics(env.DB, goId, ["golang", "web-api"]);
    await seedRepo(owner.id, "owner", "rustproj", "public");

    // Exact (case-folded) needle hits.
    const hit = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "GoLang",
      topicOnly: true,
    });
    expect(hit.items.map((p) => p.repo.slug)).toEqual(["goproj"]);

    // A PREFIX is not a hit: `topic=true` lowercases the needle and compares
    // for equality (repo_list.go:460 `builder.Eq{"topic.name", lower(v)}`).
    const prefix = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "go",
      topicOnly: true,
    });
    expect(prefix.total).toBe(0);
  });

  it("matches topics as substrings without topic=true (repo_list.go:462)", async () => {
    const owner = await seedVerifiedUser({ username: "Owner" });
    const id = await seedRepo(owner.id, "owner", "recipes", "public");
    await replaceRepoTopics(env.DB, id, ["golang"]);

    // The name has no match, the topic substring does.
    const hit = await searchRepositories(env.DB, anonymous, { ...searchOpts, keyword: "go" });
    expect(hit.items.map((p) => p.repo.slug)).toEqual(["recipes"]);

    // And the name arm still answers in the same OR.
    const byName = await searchRepositories(env.DB, anonymous, { ...searchOpts, keyword: "recipes" });
    expect(byName.items.map((p) => p.repo.slug)).toEqual(["recipes"]);
  });

  it("topic=true with NO keyword passes everything (upstream builds no block for an empty keyword)", async () => {
    const owner = await seedVerifiedUser({ username: "Owner" });
    const id = await seedRepo(owner.id, "owner", "tagged", "public");
    await replaceRepoTopics(env.DB, id, ["golang"]);
    await seedRepo(owner.id, "owner", "untagged", "public");

    const all = await searchRepositories(env.DB, anonymous, { ...searchOpts, topicOnly: true });
    expect(all.total).toBe(2);
    expect(all.items.map((p) => p.repo.slug).sort()).toEqual(["tagged", "untagged"]);
  });

  it("misses a name match without a topic under topic=true, and unions comma needles", async () => {
    const owner = await seedVerifiedUser({ username: "Owner" });
    await seedRepo(owner.id, "owner", "golang", "public"); // NAME only, no topics
    const tagged = await seedRepo(owner.id, "owner", "mixed", "public");
    await replaceRepoTopics(env.DB, tagged, ["rust"]);

    // topic=true suppresses the name arm entirely.
    const nameOnly = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "golang",
      topicOnly: true,
    });
    expect(nameOnly.total).toBe(0);

    // Comma needles: any topic match passes.
    const either = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "golang,rust",
      topicOnly: true,
    });
    expect(either.items.map((p) => p.repo.slug)).toEqual(["mixed"]);
  });
});

// ---------------------------------------------------------------------------
// includeDesc — the keyword arm's description match (repo_list.go:484-486)
// ---------------------------------------------------------------------------

describe("search includeDesc (repo_list.go:484-486)", () => {
  it("default OFF: a keyword matching only a description finds nothing", async () => {
    const owner = await seedVerifiedUser({ username: "Owner" });
    await seedRepo(owner.id, "owner", "vaultproj", "public", {
      description: "the secret recipe keeper",
    });

    // The needle appears ONLY in the description — no name, no topic hit —
    // and the flag is absent, so upstream never builds the description arm
    // (repo_list.go:484) and the keyword misses.
    const miss = await searchRepositories(env.DB, anonymous, { ...searchOpts, keyword: "recipe" });
    expect(miss.total).toBe(0);
  });

  it("includeDesc=true matches the LOWER(description) arm beside the name arms", async () => {
    const owner = await seedVerifiedUser({ username: "Owner" });
    await seedRepo(owner.id, "owner", "vaultproj", "public", {
      description: "the Secret Recipe keeper",
    });
    await seedRepo(owner.id, "owner", "unrelated", "public"); // NULL description

    // Case-folded substring (upstream lowercases the needle and wraps the
    // column in LOWER); the NULL-description sibling stays out.
    const hit = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "ReCiPe",
      includeDesc: true,
    });
    expect(hit.items.map((p) => p.repo.slug)).toEqual(["vaultproj"]);

    // The name arms still answer in the same OR — adding the flag does not
    // narrow the keyword (repo_list.go:471-486, every arm is an OR).
    const byName = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "unrelated",
      includeDesc: true,
    });
    expect(byName.items.map((p) => p.repo.slug)).toEqual(["unrelated"]);
  });

  it("comma needles each match descriptions too (the per-segment loop)", async () => {
    const owner = await seedVerifiedUser({ username: "Owner" });
    await seedRepo(owner.id, "owner", "one", "public", { description: "holds the lantern" });
    await seedRepo(owner.id, "owner", "two", "public", { description: "keeps the map" });
    await seedRepo(owner.id, "owner", "three", "public");

    // Each needle rides its own description arm (repo_list.go:482-487); a
    // needle matching nothing passes nothing.
    const both = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "lantern,nowhere,map",
      includeDesc: true,
    });
    expect(both.items.map((p) => p.repo.slug).sort()).toEqual(["one", "two"]);
  });
});

// ---------------------------------------------------------------------------
// mode=collaborative + uid — the Collaborate tri-state
// ---------------------------------------------------------------------------

describe("search uid x exclusive x mode=collaborative (repo_list.go:405-449)", () => {
  /** The full collaborate fixture: carol collaborates on alice's private
   * repo and owns one; dave reaches org repos through a team; eve belongs to
   * a private org with a public repo; frank is an unrelated signed viewer. */
  async function seedCollaborateFixture() {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const carol = await seedVerifiedUser({ username: "Carol" });
    const dave = await seedVerifiedUser({ username: "Dave" });
    const eve = await seedVerifiedUser({ username: "Eve" });
    const frank = await seedVerifiedUser({ username: "Frank" });
    const orgOwner = await seedVerifiedUser({ username: "OrgOwner" });

    await seedRepo(carol.id, "carol", "own1", "public");
    await seedRepo(alice.id, "alice", "pub1", "public");
    const alicePrivId = await seedRepo(alice.id, "alice", "priv1", "private");
    await seedCollaborator(carol.id, alicePrivId);

    const org = await seedOrg("acme", orgOwner.id);
    const orgPubId = await seedRepo(org.id, org.usernameLower, "orgpub", "public");
    const orgVaultId = await seedRepo(org.id, org.usernameLower, "orgvault", "private");
    await seedTeam(org, "readers", { memberIds: [dave.id], repoIds: [orgPubId, orgVaultId] });

    const shh = await seedOrg("shh", orgOwner.id);
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.id, shh.id));
    const pubInPrivId = await seedRepo(shh.id, shh.usernameLower, "pubinpriv", "public");
    await seedOrgMember(shh, eve.id, true);

    return { alice, carol, dave, eve, frank, org, shh, alicePrivId, orgPubId, orgVaultId, pubInPrivId };
  }

  it("the default mode is owns-OR-collaborates; collaborative drops the owns half", async () => {
    const { carol, alice } = await seedCollaborateFixture();

    const both = await searchRepositories(env.DB, viewerFor(carol), {
      ...searchOpts,
      uid: carol.id,
      includePrivate: true,
    });
    expect(both.items.map((p) => p.repo.slug).sort()).toEqual(["own1", "priv1"]);

    const collabOnly = await searchRepositories(env.DB, viewerFor(carol), {
      ...searchOpts,
      uid: carol.id,
      mode: "collaborative",
      includePrivate: true,
    });
    expect(collabOnly.items.map((p) => p.repo.slug)).toEqual(["priv1"]);
    expect(carol.id).not.toBe(alice.id);
  });

  it("exclusive collapses to owned-only (repo.go:159-161, Collaborate=Some(false))", async () => {
    const { carol } = await seedCollaborateFixture();
    const ownsOnly = await searchRepositories(env.DB, viewerFor(carol), {
      ...searchOpts,
      uid: carol.id,
      exclusive: true,
      includePrivate: true,
    });
    expect(ownsOnly.items.map((p) => p.repo.slug)).toEqual(["own1"]);
  });

  it("the team arm surfaces the team-granted org repos for a member uid", async () => {
    const { dave } = await seedCollaborateFixture();
    const hit = await searchRepositories(env.DB, viewerFor(dave), {
      ...searchOpts,
      uid: dave.id,
      mode: "collaborative",
      includePrivate: true,
    });
    expect(hit.items.map((p) => p.repo.slug).sort()).toEqual(["orgpub", "orgvault"]);
  });

  it("the public-in-private-org arm surfaces a private org's public repo for a member uid", async () => {
    const { eve } = await seedCollaborateFixture();
    const hit = await searchRepositories(env.DB, viewerFor(eve), {
      ...searchOpts,
      uid: eve.id,
      mode: "collaborative",
      includePrivate: true,
    });
    expect(hit.items.map((p) => p.repo.slug)).toEqual(["pubinpriv"]);
  });

  it("the hidden-membership exclusion drops the arm in public-only searches (repo_list.go:433-435)", async () => {
    const orgOwner = await seedVerifiedUser({ username: "OrgOwner" });
    const hidden = await seedVerifiedUser({ username: "Hidden" });
    const publicMember = await seedVerifiedUser({ username: "PublicMember" });
    const org = await seedOrg("veiled", orgOwner.id);
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.id, org.id));
    await seedRepo(org.id, org.usernameLower, "shyrepo", "public");
    await seedOrgMember(org, hidden.id, false); // hidden membership
    await seedOrgMember(org, publicMember.id, true); // public membership

    // Public-only search (private=false): the hidden member's collaboration
    // is excluded — the search must not leak it.
    const hiddenView = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      uid: hidden.id,
      mode: "collaborative",
    });
    expect(hiddenView.total).toBe(0);

    // The PUBLIC member's collaboration is excluded TOO — since the
    // owner-visibility arm (repo_list.go:380-384) landed, the public-only
    // BASE conjunct (`owner_id NOT IN (… visibility IN limited/private)`)
    // ANDs ahead of the member arms (upstream's own composition), so a
    // private-visibility org's public repo is unreachable in a public-only
    // search regardless of membership. The member arms only ever ADD rows in
    // includePrivate searches, where the hidden-membership exclusion is
    // upstream-absent as well (:433-435 rides the `!opts.Private` guard).
    const publicView = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      uid: publicMember.id,
      mode: "collaborative",
    });
    expect(publicView.total).toBe(0);
  });

  it("refuses cross-visibility: a stranger asking for carol's collaborative edges gets nothing private", async () => {
    const { carol, frank } = await seedCollaborateFixture();
    const strangerView = await searchRepositories(env.DB, viewerFor(frank), {
      ...searchOpts,
      uid: carol.id,
      mode: "collaborative",
      includePrivate: true,
    });
    expect(strangerView.total).toBe(0); // carol's only collaborate hit is alice's private repo

    const anonView = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      uid: carol.id,
      mode: "collaborative",
    });
    expect(anonView.total).toBe(0);
  });

  it("an unknown uid still matches nothing", async () => {
    const miss = await searchRepositories(env.DB, anonymous, { ...searchOpts, uid: 999999 });
    expect(miss.total).toBe(0);
  });

  it("mode=collaborative WINS over exclusive (repo.go:166-174 — the mode switch overwrites Collaborate)", async () => {
    // Upstream binds `exclusive` first (Collaborate = Some(false)) and the
    // mode switch runs after it — `mode=collaborative&exclusive=true` lands
    // Collaborate = Some(true): the collaborate arm ONLY, owned repos
    // excluded (the arm's own Neq(owner_id) predicate). Carol owns own1 and
    // collaborates on alice's priv1 — the exclusive-wins shape would answer
    // own1; the upstream shape answers priv1.
    const { carol } = await seedCollaborateFixture();
    const modeWins = await searchRepositories(env.DB, viewerFor(carol), {
      ...searchOpts,
      uid: carol.id,
      mode: "collaborative",
      exclusive: true,
      includePrivate: true,
    });
    expect(modeWins.items.map((p) => p.repo.slug)).toEqual(["priv1"]);

    // Without the mode, exclusive keeps its owned-only arm.
    const exclusiveAlone = await searchRepositories(env.DB, viewerFor(carol), {
      ...searchOpts,
      uid: carol.id,
      exclusive: true,
      includePrivate: true,
    });
    expect(exclusiveAlone.items.map((p) => p.repo.slug)).toEqual(["own1"]);
  });
});

// ---------------------------------------------------------------------------
// The !Private base arm's owner-visibility exclusion (repo_list.go:380-384)
// ---------------------------------------------------------------------------

describe("search owner-visibility exclusion (repo_list.go:380-384)", () => {
  it("a public-only search hides limited- and private-profile owners' PUBLIC repos; public owners answer", async () => {
    const publicOwner = await seedVerifiedUser({ username: "OpenOwner" });
    const limitedOwner = await seedVerifiedUser({ username: "LimitedOwner" });
    const privateOwner = await seedVerifiedUser({ username: "SecretOwner" });
    await drizzle(env.DB).update(users).set({ visibility: "limited" }).where(eq(users.id, limitedOwner.id));
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.id, privateOwner.id));
    await seedRepo(publicOwner.id, "openowner", "visible", "public");
    await seedRepo(limitedOwner.id, "limitedowner", "limpub", "public");
    await seedRepo(privateOwner.id, "secretowner", "secpub", "public");

    // Anonymous (and any `private=false` search): only the public-profile
    // owner's repo passes — the base conjunct ANDs
    // `owner_id NOT IN (… visibility IN (limited, private))`.
    const anon = await searchRepositories(env.DB, anonymous, { ...searchOpts });
    expect(anon.items.map((p) => p.repo.slug)).toEqual(["visible"]);

    // Explicit `private=false` on a signed viewer is the same arm.
    const carol = await seedVerifiedUser({ username: "Carol" });
    const forced = await searchRepositories(env.DB, viewerFor(carol), {
      ...searchOpts,
      includePrivate: false,
    });
    expect(forced.items.map((p) => p.repo.slug)).toEqual(["visible"]);
  });

  it("the exclusion is the !Private arm only — includePrivate searches surface the same repos", async () => {
    const limitedOwner = await seedVerifiedUser({ username: "LimitedOwner" });
    const viewer = await seedVerifiedUser({ username: "Viewer" });
    await seedRepo(limitedOwner.id, "limitedowner", "limpub", "public");

    const signed = await searchRepositories(env.DB, viewerFor(viewer), {
      ...searchOpts,
      includePrivate: true,
    });
    expect(signed.items.map((p) => p.repo.slug)).toEqual(["limpub"]);

    // The listing-shaped !includePrivate on /users/{username}/repos has NO
    // such exclusion upstream (GetUserRepositories, repo_list.go:823-825 —
    // bare is_private=false), which is why the arm rides the SEARCH builder
    // and not the shared visibilityConditions helper.
  });

  it("the exclusion keys on the REPO owner, never the searcher or starer profile", async () => {
    // A private-profile STARER's stars over a public-owner repo still answer
    // (the starer-profile independence pin above); likewise a private-profile
    // uid's OWN public repo is excluded from a public-only search only
    // through the owner arm — the uid block cannot resurrect it.
    const starer = await seedVerifiedUser({ username: "ShyStarer" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const pubId = await seedRepo(bob.id, "bob", "pub", "public");
    await seedStar(starer.id, pubId);
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.id, starer.id));

    const hit = await searchRepositories(env.DB, anonymous, { ...searchOpts, starredBy: starer.id });
    expect(hit.items.map((p) => p.repo.slug)).toEqual(["pub"]);
  });
});

// ---------------------------------------------------------------------------
// The signed-in public arm's owner-visibility conjunct (repo_list.go:651-658
// userAllPublicRepoCond with the SIGNED-IN limit [Private] at :667-673) and
// the DoerTokenRepoCond floors on the LIST paths (repo_list.go:757-765
// PublicRepoUnderPublicOwnerCond, :774-779 DoerTokenRepoCond, :822 its
// GetUserRepositories AND, :366-368 the ListMyRepos force-Private-false).
// ---------------------------------------------------------------------------

describe("signed-in public-arm owner exclusion (repo_list.go:667-673, limit [Private])", () => {
  it("an includePrivate search hides a private-profile owner's public repo; LIMITED owners stay visible", async () => {
    // The signed-in arm's limit is [Private] ONLY (upstream appends Limited
    // for the anonymous arm alone, :669-671): a public repo under a
    // limited-profile owner stays list-visible to a signed-in viewer, while
    // the private-profile owner's public repo drops. The anonymous control
    // (the S2 arm, limit [Limited, Private]) keeps only the open row.
    const openOwner = await seedVerifiedUser({ username: "OpenOwner" });
    const limitedOwner = await seedVerifiedUser({ username: "LimitedOwner" });
    const secretOwner = await seedVerifiedUser({ username: "SecretOwner" });
    await drizzle(env.DB).update(users).set({ visibility: "limited" }).where(eq(users.id, limitedOwner.id));
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.id, secretOwner.id));
    await seedRepo(openOwner.id, "openowner", "visible", "public");
    await seedRepo(limitedOwner.id, "limitedowner", "limpub", "public");
    await seedRepo(secretOwner.id, "secretowner", "secpub", "public");

    const carol = await seedVerifiedUser({ username: "Carol" });
    const signed = await searchRepositories(env.DB, viewerFor(carol), {
      ...searchOpts,
      includePrivate: true,
    });
    expect(signed.items.map((p) => p.repo.slug).sort()).toEqual(["limpub", "visible"]);

    const anon = await searchRepositories(env.DB, anonymous, { ...searchOpts });
    expect(anon.items.map((p) => p.repo.slug)).toEqual(["visible"]);
  });

  it("the conjunct rides the PUBLIC arm only — owner and grantee arms resurrect the row", async () => {
    // Upstream composes the owner half INSIDE the public arm of the OR
    // (:651-657); the own/collaborator/team arms are untouched, so a
    // private-profile owner's rows stay reachable through a real edge.
    const secretOwner = await seedVerifiedUser({ username: "SecretOwner" });
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.id, secretOwner.id));
    const secpubId = await seedRepo(secretOwner.id, "secretowner", "secpub", "public");
    await seedRepo(secretOwner.id, "secretowner", "vault", "private");
    const carol = await seedVerifiedUser({ username: "Carol" });

    // The owner themself: the own-arm (ownership OR) admits their rows —
    // the public row despite the narrowed public arm, the private one too
    // (the conjunct never rides the owner arm).
    const own = await searchRepositories(env.DB, viewerFor(secretOwner), {
      ...searchOpts,
      includePrivate: true,
    });
    expect(own.items.map((p) => p.repo.slug).sort()).toEqual(["secpub", "vault"]);

    // A collaborator on the public row: the grant arm admits it; the vault
    // (no grant) stays out.
    await seedCollaborator(carol.id, secpubId);
    const granted = await searchRepositories(env.DB, viewerFor(carol), {
      ...searchOpts,
      includePrivate: true,
    });
    expect(granted.items.map((p) => p.repo.slug)).toEqual(["secpub"]);
  });
});

describe("DoerTokenRepoCond list floors (repo_list.go:757-765, :774-779, :822/:366-368)", () => {
  /** shy = private-profile owner with a public + a private repo; open =
   *  public-profile owner with a public repo — the genuinely-public pair the
   *  floor admits. */
  async function seedFloorFixture() {
    const shy = await seedVerifiedUser({ username: "ShyOwner" });
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.id, shy.id));
    await seedRepo(shy.id, "shyowner", "shyrepo", "public");
    await seedRepo(shy.id, "shyowner", "vault", "private");
    const open = await seedVerifiedUser({ username: "OpenOwner" });
    await seedRepo(open.id, "openowner", "openpub", "public");
    return { shy, open };
  }

  it("listUserRepositories floors a public-only token to genuinely-public pairs — even the owner themself", async () => {
    const { shy } = await seedFloorFixture();

    // The public-only token listing its OWN repos: the token floor ANDs
    // public + public-owner (repo_list.go:822) — their public repo drops on
    // the owner-visibility half (their profile is private) and the vault on
    // the is_private half. Upstream: DoerTokenRepoCond →
    // PublicRepoUnderPublicOwnerCond, no self/admin exemption.
    const floored = await listUserRepositories(env.DB, "shyowner", publicOnlyViewerFor(shy), listOpts);
    expect(floored.total).toBe(0);
    expect(floored.items).toEqual([]);

    // The same identity with a FULL-scope viewer keeps both rows (the self
    // arm; GetUserRepositories's Private=true self reading).
    const full = await listUserRepositories(env.DB, "shyowner", viewerFor(shy), listOpts);
    expect(full.items.map((p) => p.repo.slug).sort()).toEqual(["shyrepo", "vault"]);

    // A genuinely-public owner's row passes the floor.
    const openList = await listUserRepositories(env.DB, "openowner", publicOnlyViewerFor(shy), listOpts);
    expect(openList.items.map((p) => p.repo.slug)).toEqual(["openpub"]);
  });

  it("listOwnedRepositories floors a public-only token (ListMyRepos forces Private=false, repo_list.go:366-368)", async () => {
    const { shy, open } = await seedFloorFixture();

    // The token's own list: the vault is hidden despite ownership (the
    // forced-public reading), and shyrepo is hidden by the owner half.
    const floored = await listOwnedRepositories(env.DB, publicOnlyViewerFor(shy), listOpts);
    expect(floored.total).toBe(0);
    expect(floored.items).toEqual([]);

    // Full-scope control: everything owned.
    const full = await listOwnedRepositories(env.DB, viewerFor(shy), listOpts);
    expect(full.items.map((p) => p.repo.slug).sort()).toEqual(["shyrepo", "vault"]);

    // A public-profile owner's public repo passes under the same token.
    const openFloored = await listOwnedRepositories(env.DB, publicOnlyViewerFor(open), listOpts);
    expect(openFloored.items.map((p) => p.repo.slug)).toEqual(["openpub"]);
  });

  it("the floor narrows ADMIN listers too (IsPublicOnlyDoer has no admin exemption)", async () => {
    await seedFloorFixture();
    const admin = await seedVerifiedUser({ username: "Root", isAdmin: true });

    // Full-scope admin: the unfiltered [] arm — both rows.
    const adminFull = await listUserRepositories(env.DB, "shyowner", viewerFor(admin, true), listOpts);
    expect(adminFull.items.map((p) => p.repo.slug).sort()).toEqual(["shyrepo", "vault"]);

    // The same admin with a public-only token: the floor applies anyway
    // (upstream ANDs DoerTokenRepoCond unconditionally, :822; ARC's
    // public-only early return :662-664 checks IsPublicOnlyDoer, not
    // IsAdmin) — nothing of the private-profile owner survives.
    const adminFloored = await listUserRepositories(env.DB, "shyowner", publicOnlyViewerFor(admin, true), listOpts);
    expect(adminFloored.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The priority_owner_id CASE's ELSE arm (repo_list.go:612 — ELSE owner_id)
// ---------------------------------------------------------------------------

describe("search priority CASE ELSE (repo_list.go:612)", () => {
  it("non-priority rows order by OWNER ID before the explicit sort, not a constant tie", async () => {
    // alice seeds first (lower id). sort=alpha desc alone would put zeta
    // first; the upstream ELSE (owner_id) groups non-priority rows by owner
    // id ASC — alice's row leads regardless of name. (A constant-ELSE
    // mis-port would tie both at 1 and hand the order to the alpha sort.)
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const prio = await seedVerifiedUser({ username: "Prio" });
    await seedRepo(alice.id, "alice", "alpha-name", "public");
    await seedRepo(bob.id, "bob", "zeta-name", "public");
    await seedRepo(prio.id, "prio", "mid", "public");
    expect(alice.id).toBeLessThan(bob.id);

    const ordered = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "name,mid", // both slugs match `name`; mid rides its own needle
      priorityOwnerId: prio.id,
      sort: "alpha",
      order: "desc",
    });
    expect(ordered.items.map((p) => p.repo.slug)).toEqual(["mid", "alpha-name", "zeta-name"]);
  });
});

// ---------------------------------------------------------------------------
// The Explore surface rides through
// ---------------------------------------------------------------------------

describe("searchExploreRepos rides the ported builder", () => {
  it("the explore keyword arm matches topics (the non-topicOnly topic arm)", async () => {
    const owner = await seedVerifiedUser({ username: "Owner" });
    const id = await seedRepo(owner.id, "owner", "recipes", "public");
    await replaceRepoTopics(env.DB, id, ["golang"]);
    await seedRepo(owner.id, "owner", "garden", "private");

    // Anonymous explore search (upstream `Private: ctx.Doer != nil`): the
    // topic substring arm finds the repo the NAME would never match.
    const byTopic = await searchExploreRepos(env.DB, null, {
      keyword: "golang",
      page: 1,
      limit: 20,
      sort: "",
    });
    expect(byTopic.total).toBe(1);
    expect(byTopic.items.map((p) => p.repo.slug)).toEqual(["recipes"]);
  });

  it("the explore neutral filter set stays unfiltered and visibility-gated", async () => {
    const owner = await seedVerifiedUser({ username: "Owner" });
    await seedRepo(owner.id, "owner", "open", "public");
    await seedRepo(owner.id, "owner", "secret", "private");

    const anon = await searchExploreRepos(env.DB, null, { keyword: "", page: 1, limit: 20, sort: "" });
    expect(anon.total).toBe(1);

    const self = await searchExploreRepos(env.DB, { id: owner.id, username: owner.username, isAdmin: false }, {
      keyword: "",
      page: 1,
      limit: 20,
      sort: "",
    });
    expect(self.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// keyword ordering — the owner-prefix CASE (repo_list.go:614-618)
// ---------------------------------------------------------------------------

describe("search keyword owner-prefix CASE (repo_list.go:614-618)", () => {
  it("floats the keyword's owner half to the top of the default sort", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    await seedRepo(alice.id, "alice", "zeppelin", "public");
    await seedRepo(bob.id, "bob", "zeal", "public");

    // One comma needle per arm: `ze` matches BOTH slugs (so bob/zeal is in
    // the result set — a lone `alice/ze` needle can only ever match alice's
    // repos through the pair arm) while the whole keyword still carries
    // exactly one "/", the count upstream takes over the WHOLE keyword.
    // Default sort is slug asc, so without the CASE zeal sorts first; the
    // owner float flips it.
    const floated = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "alice/ze,ze",
    });
    expect(floated.total).toBe(2);
    expect(floated.items.map((p) => p.repo.slug)).toEqual(["zeppelin", "zeal"]);

    // Upstream binds the owner half VERBATIM to a wildcard-less LIKE, which
    // SQLite folds ASCII-case — the same match as lowercase equality against
    // our lowercase-stored ownerNamespace.
    const upper = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "ALICE/Ze,ze",
    });
    expect(upper.items.map((p) => p.repo.slug)).toEqual(["zeppelin", "zeal"]);
  });

  it("priorityOwnerId wins: the else-if suppresses the owner float", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    await seedRepo(alice.id, "alice", "aardvark", "public");
    await seedRepo(bob.id, "bob", "zebra", "public");

    // Comma needles: `a` matches both slugs (zebra's tail) and `alice/a`
    // additionally rides alice's pair arm — the whole keyword still carries
    // exactly one "/". Without priority_owner_id the keyword float puts
    // alice first…
    const floated = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "alice/a,a",
    });
    expect(floated.items.map((p) => p.repo.slug)).toEqual(["aardvark", "zebra"]);

    // …but with it, upstream's arms are mutually exclusive (repo_list.go
    // :611-618 if/else-if): only the owner_id CASE applies, so bob's repo
    // leads and alice does NOT float (a double-applied CASE would tie them
    // at 0 and fall back to slug asc — aardvark first — the wrong order).
    const pinned = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "alice/a,a",
      priorityOwnerId: bob.id,
    });
    expect(pinned.total).toBe(2);
    expect(pinned.items.map((p) => p.repo.slug)).toEqual(["zebra", "aardvark"]);
  });

  it("a slash-less keyword adds no float (plain sort order stands)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    await seedRepo(alice.id, "alice", "zeppelin", "public");
    await seedRepo(bob.id, "bob", "zeal", "public");

    // Same fixture as the float pin, needle without any slash: both repos
    // match the slug arm but no CASE is prepended — default slug asc keeps
    // zeal first.
    const plain = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "ze",
    });
    expect(plain.total).toBe(2);
    expect(plain.items.map((p) => p.repo.slug)).toEqual(["zeal", "zeppelin"]);
  });

  it("the float is PREPENDED to an explicit sort, not a replacement", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    await seedRepo(alice.id, "alice", "az", "public");
    await seedRepo(bob.id, "bob", "aa", "public");

    // Explicit `sort=alpha&order=desc` alone orders owner desc: bob, alice.
    const explicit = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "a",
      sort: "alpha",
      order: "desc",
    });
    expect(explicit.items.map((p) => p.repo.slug)).toEqual(["aa", "az"]);

    // Upstream substitutes the default only when OrderBy is empty (:607) and
    // prepends the CASE to whatever stands (:617) — so the explicit sort
    // stays as the tie-breaker INSIDE the float.
    const floated = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "alice/a,a",
      sort: "alpha",
      order: "desc",
    });
    expect(floated.total).toBe(2);
    expect(floated.items.map((p) => p.repo.slug)).toEqual(["az", "aa"]);
  });
});

// ---------------------------------------------------------------------------
// The tier-1 repoSearch fixture pin — comma needles vs the whole-keyword
// one-slash pair gate (repo_list.go:477-483).
//
// The compat scenario's original needle set (`<owner>/shared,<owner>/second`)
// rode OUR pre-SEARCH per-segment pair arm — a divergence: upstream gates the
// owner/repo arm on `strings.Count(opts.Keyword, "/") == 1` over the WHOLE
// keyword, so two owner-qualified needles (two slashes) skip it, and
// owner-qualified needles never match the bare-name arms (plain lower_name
// substrings). Real Gitea answers 0 hits + no Link for that form; 3197fee's
// faithful rewrite exposed it (the compat suite went red) and REDFIX
// corrected the scenario onto bare needles. Both forms are pinned here so
// neither direction of drift (a per-segment "restoration", or an accidental
// whole-keyword over-match) can land silently.
// ---------------------------------------------------------------------------

describe("comma needles vs the whole-keyword pair gate (repo_list.go:477-483)", () => {
  it("owner-qualified comma needles (two slashes) match NOTHING — upstream's 0-hit answer", async () => {
    const owner = await seedVerifiedUser({ username: "PinOwner" });
    await seedRepo(owner.id, "pinowner", "shared", "public");
    await seedRepo(owner.id, "pinowner", "second", "public");

    // The exact pre-REDFIX fixture needle set: both repos exist and are
    // public, yet the pair arm is skipped (whole keyword carries two
    // slashes) and `instr(slug, "pinowner/shared")` is 0 for a repo NAMED
    // "shared" — upstream's needles name repos, never owner/repo pairs.
    const hits = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "pinowner/shared,pinowner/second",
    });
    expect(hits.total).toBe(0);
    expect(hits.items).toEqual([]);
  });

  it("bare comma needles OR per repo name — the corrected tier-1 fixture form (two hits)", async () => {
    const owner = await seedVerifiedUser({ username: "PinOwner2" });
    const org = await seedOrg("PinOrg", owner.id);
    await seedRepo(owner.id, "pinowner2", "shared", "public");
    await seedRepo(owner.id, "pinowner2", "second", "public");
    await seedRepo(org.id, "pinorg", "org-shared", "public");

    // Each needle is an independent lower_name substring ORed in (:474):
    // `second` matches only the second repo, `org-shared` only the org
    // repo — exactly two hits, the compat scenario's "two keyword hits,
    // first page" without touching `shared` (which neither needle names).
    const hits = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      keyword: "second,org-shared",
    });
    expect(hits.total).toBe(2);
    expect(hits.items.map((p) => p.repo.slug).sort()).toEqual(["org-shared", "second"]);
  });
});

// ---------------------------------------------------------------------------
// The RESTRICTED-USER arms (repo_list.go:661-703's restricted composition +
// SearchRepositoryCondition's :516-518 second ARC AND) over the search and
// both list routes.
//
// Upstream, a RESTRICTED doer (`user.IsRestricted`, the users.is_restricted
// column) SKIPS AccessibleRepositoryCondition's arm 1 (:665-674 runs the
// all-publics arm only for `user == nil || !user.IsRestricted ||
// user.ID <= 0`) and arm 5 (:694-700's else), getting instead — when
// `!RequireSignInViewStrict` — the `userAllPublicRepoCond` with the
// [Private, Limited] limit (:697-699): publics under PUBLIC-visibility
// owners, the ANONYMOUS arm's limit — never the signed-in [Private]-only
// one. Under RequireSignInViewStrict the restricted viewer gets NO public
// arm at all (own/granted rows only). The search ALSO ANDs the identical
// condition a second time for a restricted actor (:516-518, no admin
// exemption) — vacuous against either base when non-strict, load-bearing
// under strict. `GetUserRepositories` never calls ARC (repo_list.go
// :813-842), so /users/{u}/repos carries NO restricted delta; ListMyRepos's
// :516 AND is row-vacuous over the own arm.
//
// The `restrictedViewerFor` helper is the publicOnlyViewerFor precedent: a
// viewer whose contract `restricted` flag is set (the flag the identity
// chain will carry from the row once it lands) plus the optional instance
// strict flag and token scope — the service seam reads all three.
// ---------------------------------------------------------------------------

/** The RESTRICTED doer's viewer: `requester.restricted` (the users.
 * is_restricted column's contract field) + `requireSignInViewStrict`
 * (undefined = upstream's OFF default) + `publicOnlyToken` (the
 * :662-664 precedence seam). */
const restrictedViewerFor = (
  user: { id: number; username: string },
  opts: { isAdmin?: boolean; strict?: boolean; publicOnlyToken?: boolean } = {},
): Viewer => {
  const base = viewerFor(user, opts.isAdmin ?? false);
  return {
    ...base,
    requester: { ...base.requester!, restricted: true },
    ...(opts.publicOnlyToken ? { publicOnlyToken: true } : {}),
    ...(opts.strict ? { requireSignInViewStrict: true } : {}),
  };
};

describe("the RESTRICTED-USER arms (repo_list.go:665-674/:694-700 skips, :697-699 replacement, :516-518 AND)", () => {
  /**
   * rest = the restricted doer (owns restown/restvault, collaborates on the
   * private `granted` and the private-profile owner's `vault`, member of the
   * private-visibility org shh whose `pubinpriv` is public). plain = the
   * NON-restricted control carrying the same edges (own plainown, granted,
   * shh membership). The discriminating rows: `limpub` (a limited-profile
   * owner's public — the signed arm-1 [Private]-only limit keeps it, the
   * restricted replacement's [Private, Limited] limit drops it) and
   * `pubinpriv` (a private org's public — arm 5 keeps it for plain, SKIPPED
   * for restricted). `open` passes both; `secpub` (private-profile owner's
   * public) passes neither (arm 1's owner half). adminown (the admin's own
   * public) rides the public arms of everyone.
   */
  async function seedRestrictedFixture() {
    const openOwner = await seedVerifiedUser({ username: "OpenOwner" });
    const limitedOwner = await seedVerifiedUser({ username: "LimitedOwner" });
    await drizzle(env.DB).update(users).set({ visibility: "limited" }).where(eq(users.id, limitedOwner.id));
    const secretOwner = await seedVerifiedUser({ username: "SecretOwner" });
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.id, secretOwner.id));
    const rest = await seedVerifiedUser({ username: "RestUser" });
    await drizzle(env.DB).update(users).set({ restricted: true }).where(eq(users.id, rest.id));
    const plain = await seedVerifiedUser({ username: "PlainUser" });
    const admin = await seedVerifiedUser({ username: "RestAdmin", isAdmin: true });
    await drizzle(env.DB).update(users).set({ restricted: true }).where(eq(users.id, admin.id));

    await seedRepo(openOwner.id, "openowner", "open", "public");
    await seedRepo(limitedOwner.id, "limitedowner", "limpub", "public");
    await seedRepo(secretOwner.id, "secretowner", "secpub", "public");
    const secretVaultId = await seedRepo(secretOwner.id, "secretowner", "vault", "private");
    await seedRepo(rest.id, "restuser", "restown", "public");
    await seedRepo(rest.id, "restuser", "restvault", "private");
    const grantedId = await seedRepo(openOwner.id, "openowner", "granted", "private");
    await seedCollaborator(rest.id, grantedId);
    await seedCollaborator(plain.id, grantedId);
    await seedCollaborator(rest.id, secretVaultId);
    await seedCollaborator(admin.id, grantedId);
    await seedRepo(plain.id, "plainuser", "plainown", "public");
    await seedRepo(admin.id, "restadmin", "adminown", "public");

    const orgOwner = await seedVerifiedUser({ username: "OrgOwner" });
    const shh = await seedOrg("shh", orgOwner.id);
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.id, shh.id));
    await seedRepo(shh.id, shh.usernameLower, "pubinpriv", "public");
    await seedOrgMember(shh, rest.id, true);
    await seedOrgMember(shh, plain.id, true);

    return { rest, plain, admin };
  }

  it("a restricted viewer's includePrivate search skips arm 1 ([Private] limit) and arm 5; the plain control keeps both", async () => {
    const { rest, plain } = await seedRestrictedFixture();

    // The restricted composition: own + granted rows (the real edges
    // survive) plus the replacement publics (public-profile owners only) —
    // limpub DROPPED (limited-profile owner: the [Private, Limited] limit
    // the signed arm-1 keeps) and pubinpriv DROPPED (arm 5 skipped).
    const restricted = await searchRepositories(env.DB, restrictedViewerFor(rest), {
      ...searchOpts,
      includePrivate: true,
    });
    expect(restricted.items.map((p) => p.repo.slug).sort()).toEqual([
      "adminown",
      "granted",
      "open",
      "plainown",
      "restown",
      "restvault",
      "vault",
    ]);

    // The plain twin — same grants, same org membership — keeps limpub
    // (arm 1's [Private]-only limit) and pubinpriv (arm 5); the two
    // restricted drops are exactly the delta.
    const control = await searchRepositories(env.DB, viewerFor(plain), {
      ...searchOpts,
      includePrivate: true,
    });
    expect(control.items.map((p) => p.repo.slug).sort()).toEqual([
      "adminown",
      "granted",
      "limpub",
      "open",
      "plainown",
      "pubinpriv",
      "restown",
    ]);
  });

  it("RequireSignInViewStrict drops the replacement arm entirely (repo_list.go:697-699's else)", async () => {
    const { rest } = await seedRestrictedFixture();
    const strict = await searchRepositories(env.DB, restrictedViewerFor(rest, { strict: true }), {
      ...searchOpts,
      includePrivate: true,
    });
    // No public arm at all: open/adminown/plainown drop; only the
    // own/granted rows remain.
    expect(strict.items.map((p) => p.repo.slug).sort()).toEqual(["granted", "restown", "restvault", "vault"]);
  });

  it("the search's :516-518 second AND — vacuous non-strict, narrows the public base under strict", async () => {
    const { rest } = await seedRestrictedFixture();

    // Non-strict, private=false: the forced-public base (publics under
    // public owners) AND the restricted OR whose replacement arm EQUALS the
    // base — the base stands (the upstream :516 AND is present but inert).
    const publicSearch = await searchRepositories(env.DB, restrictedViewerFor(rest), { ...searchOpts });
    expect(publicSearch.items.map((p) => p.repo.slug).sort()).toEqual(["adminown", "open", "plainown", "restown"]);

    // Strict, private=false: no replacement arm exists, so the AND keeps
    // only the actor's own/granted PUBLICS — open drops (neither owned nor
    // granted). The load-bearing restricted search narrowing.
    const strictPublic = await searchRepositories(env.DB, restrictedViewerFor(rest, { strict: true }), {
      ...searchOpts,
    });
    expect(strictPublic.items.map((p) => p.repo.slug)).toEqual(["restown"]);
  });

  it("the owner-listing keeps its bare-public shape for a restricted viewer (GetUserRepositories never calls ARC)", async () => {
    const { rest } = await seedRestrictedFixture();
    // A restricted viewer listing a LIMITED-profile owner still sees the
    // public repo — the listing's !Private arm is bare is_private=false
    // upstream (repo_list.go:823-825), no owner-visibility conjunct,
    // restricted or not; the same row is INVISIBLE through the restricted
    // search (the arm-1 skip above).
    const limitedListing = await listUserRepositories(env.DB, "limitedowner", restrictedViewerFor(rest), listOpts);
    expect(limitedListing.items.map((p) => p.repo.slug)).toEqual(["limpub"]);

    // The self listing keeps both rows through the own arm (includePrivate
    // rides the restricted composition there; own rows are unrestricted).
    const self = await listUserRepositories(env.DB, "restuser", restrictedViewerFor(rest), listOpts);
    expect(self.items.map((p) => p.repo.slug).sort()).toEqual(["restown", "restvault"]);
  });

  it("listOwnedRepositories is ARC-stable for a restricted doer under both strict polarities", async () => {
    const { rest } = await seedRestrictedFixture();
    // ListMyRepos's :516-518 AND intersects the owner block with the
    // restricted ARC — but the ARC always contains the own arm
    // (repo_list.go:693), so the AND never drops an owned row:
    const nonStrict = await listOwnedRepositories(env.DB, restrictedViewerFor(rest), listOpts);
    expect(nonStrict.items.map((p) => p.repo.slug).sort()).toEqual(["restown", "restvault"]);
    const strict = await listOwnedRepositories(env.DB, restrictedViewerFor(rest, { strict: true }), listOpts);
    expect(strict.items.map((p) => p.repo.slug).sort()).toEqual(["restown", "restvault"]);
  });

  it("the :662-664 precedence — a restricted public-only token takes the restricted arms + the tail AND, not the early return", async () => {
    const { rest, plain } = await seedRestrictedFixture();

    // The token floor (:702's cond.And(DoerTokenRepoCond) —
    // GetUserRepositories ANDs it at :822) collapses the restricted
    // composition to
    // the genuinely-public pairs: restown survives (public repo,
    // public-profile owner), restvault dies under the AND. Upstream's
    // non-restricted early return produces the same narrowing for a plain
    // token; the restricted doer just reaches it through the tail AND
    // (no early return for them — the guard carries `&& !user.IsRestricted`).
    const floored = await listUserRepositories(
      env.DB,
      "restuser",
      restrictedViewerFor(rest, { publicOnlyToken: true }),
      listOpts,
    );
    expect(floored.items.map((p) => p.repo.slug)).toEqual(["restown"]);

    // Search (the route forces private=false for a public-only token,
    // repo_list.go:366-368 — no restricted guard, modeled by
    // includePrivate: false): STRICT the :516-518 AND narrows the
    // restricted token to its own publics — restown only.
    const strictToken = await searchRepositories(env.DB, restrictedViewerFor(rest, { strict: true, publicOnlyToken: true }), {
      ...searchOpts,
    });
    expect(strictToken.items.map((p) => p.repo.slug)).toEqual(["restown"]);

    // The NON-restricted token control under strict keeps the whole public
    // base (no :516 AND fires for it — the early return's precedence).
    const strictPlainToken = await searchRepositories(
      env.DB,
      { ...publicOnlyViewerFor(plain), requireSignInViewStrict: true },
      { ...searchOpts },
    );
    expect(strictPlainToken.items.map((p) => p.repo.slug).sort()).toEqual(["adminown", "open", "plainown", "restown"]);
  });

  it("a restricted ADMIN's search is ARC-shaped — :516-518 has no admin exemption", async () => {
    const { admin } = await seedRestrictedFixture();
    // A FULL admin sees every row (the [] base arm):
    const fullAdmin = await searchRepositories(env.DB, viewerFor(admin, true), {
      ...searchOpts,
      includePrivate: true,
    });
    expect(fullAdmin.total).toBe(10);

    // The same admin RESTRICTED: the :516-518 AND narrows to the restricted
    // composition (own ∪ grants ∪ replacement) — the admin flag never
    // restores the dropped publics (limpub/pubinpriv/secpub stay out) and
    // adds no rows the edges don't carry (the admin's only grant is
    // `granted`; `vault` is rest's edge, not the admin's).
    const restrictedAdmin = await searchRepositories(env.DB, restrictedViewerFor(admin, { isAdmin: true }), {
      ...searchOpts,
      includePrivate: true,
    });
    expect(restrictedAdmin.items.map((p) => p.repo.slug).sort()).toEqual([
      "adminown",
      "granted",
      "open",
      "plainown",
      "restown",
    ]);
  });
});

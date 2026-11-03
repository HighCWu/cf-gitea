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
import { GO_ZERO_TIME, searchRepositories, type Viewer } from "./repository";

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

    // The public member's collaboration survives the exclusion.
    const publicView = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      uid: publicMember.id,
      mode: "collaborative",
    });
    expect(publicView.items.map((p) => p.repo.slug)).toEqual(["shyrepo"]);
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

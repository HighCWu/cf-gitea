/**
 * Protected-branch rule service (SPEC-0013 §3.2) over real D1 — the match/sort
 * table (priority × plain/glob × created tie-break,
 * protected_branch_list.go:27–54 cases), the glob grammar port, the predicate
 * ports (merge whitelist / bypass / official reviewer — user and team arms),
 * the approval counting over seeded `pull_reviews` (official/stale/dismissed
 * permutations, the ignore_stale_approvals arm), the upstream-exact 405 texts
 * of checkPullBranchProtections, and the §3.4 retroactive official recompute.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { User } from "../api/models/user";
import {
  canBypassBranchProtection,
  canUserDelete,
  canUserForcePush,
  canUserPush,
  checkPullBranchProtections,
  compileRuleName,
  emptyRuleConfig,
  findRule,
  grantedApprovalsCount,
  isUserInTeams,
  isUserMergeWhitelisted,
  isUserOfficialReviewer,
  listRepoRules,
  matchedBranchNamesForRule,
  parseRuleConfig,
  principalAccessOf,
  recomputeOfficialForRule,
  ruleMatches,
  serializeRuleConfig,
  type ProtectedBranchConfig,
  type PrincipalAccess,
} from "./branch-protection";
import { protectedBranches, pullReviews, repoCollaborators, repositories, ReviewType, teamMembers, teams } from "../db/schema";
import { IssuesService } from "../issues/service";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "protected_branches",
    "pull_reviews",
    "comments",
    "pull_requests",
    "issues",
    "team_members",
    "team_repo_access",
    "teams",
    "repo_collaborators",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const [id, username, isAdmin] of [
    [1, "doer", 0],
    [2, "bob", 0],
    [3, "chief", 1],
    [4, "alice", 0], // the repo owner row
    [5, "launch-org", 0], // an org row (users.type = org)
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (?, ?, ?, ?, 'active', 'user', 0)",
    )
      .bind(id, username, username, isAdmin)
      .run();
  }
  await env.DB.prepare("UPDATE users SET type = 'org' WHERE id = 5").run();
});

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);

const OWNER = "alice";
const SLUG = "visible";

let repoSeq = 4200;

async function seedRepo(): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace: OWNER,
    slug: SLUG,
    visibility: "public",
    isArchived: false,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await service().ensureRepoCounters(id);
  return id;
}

async function seedRule(repoId: string, ruleName: string, config: Partial<ProtectedBranchConfig>, options: { priority?: number; createdAt?: Date } = {}): Promise<number> {
  const rows = await db()
    .insert(protectedBranches)
    .values({
      repoId,
      ruleName,
      priority: options.priority ?? 0,
      rules: serializeRuleConfig({ ...emptyRuleConfig(), ...config }),
      createdAt: options.createdAt ?? new Date("2026-03-01T00:00:00Z"),
      updatedAt: new Date("2026-03-01T00:00:00Z"),
    })
    .returning({ id: protectedBranches.id })
    .all();
  return rows[0]!.id;
}

async function ruleOf(repoId: string, ruleId: number) {
  const rows = await db().select().from(protectedBranches).where(eq(protectedBranches.id, ruleId)).all();
  return rows[0]!;
}

async function seedTeam(orgId: number, name: string): Promise<number> {
  const rows = await db()
    .insert(teams)
    .values({ orgId, lowerName: name.toLowerCase(), name, authorize: "write" })
    .returning({ id: teams.id })
    .all();
  return rows[0]!.id;
}

async function seedTeamMember(orgId: number, teamId: number, userId: number): Promise<void> {
  await db().insert(teamMembers).values({ orgId, teamId, userId });
}

/** One open PR (the joined rows the recompute reads). */
async function seedPull(repoId: string, baseBranch = "main"): Promise<{ issueId: number; index: number }> {
  const { issue } = await service().createPullRequest({
    repoId,
    title: "protected merge",
    posterId: 2,
    headRepoId: repoId,
    baseBranch,
    headBranch: "feature",
  });
  return { issueId: issue.id, index: issue.index };
}

async function seedReview(issueId: number, type: number, flags: { official?: boolean; stale?: boolean; dismissed?: boolean; reviewerId?: number } = {}): Promise<void> {
  await db().insert(pullReviews).values({
    type,
    reviewerId: flags.reviewerId ?? 1,
    issueId,
    content: "",
    official: flags.official ?? false,
    stale: flags.stale ?? false,
    dismissed: flags.dismissed ?? false,
    commitId: "c".repeat(40),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

const WRITE: PrincipalAccess = { userId: 1, write: true, admin: false };
const READ: PrincipalAccess = { userId: 1, write: false, admin: false };
const ADMIN: PrincipalAccess = { userId: 1, write: true, admin: true };
const asUser = (id: number, login: string, isAdmin = false): User => ({ id, login, is_admin: isAdmin });

// ---------------------------------------------------------------------------
// Match + glob grammar
// ---------------------------------------------------------------------------

describe("compileRuleName/ruleMatches (protected_branch.go:87–124)", () => {
  it("matches plain names case-insensitively and never broadly", () => {
    expect(ruleMatches(compileRuleName("main"), "main")).toBe(true);
    expect(ruleMatches(compileRuleName("Main"), "main")).toBe(true); // §4.3 EqualFold
    expect(ruleMatches(compileRuleName("main"), "mainx")).toBe(false);
    expect(ruleMatches(compileRuleName("main"), "release/main")).toBe(false);
  });

  it("keeps `*` inside one path segment and `**` across", () => {
    expect(ruleMatches(compileRuleName("release/*"), "release/1.0")).toBe(true);
    expect(ruleMatches(compileRuleName("release/*"), "release/1.0/rc")).toBe(false);
    expect(ruleMatches(compileRuleName("release/*"), "release/")).toBe(true);
    expect(ruleMatches(compileRuleName("**"), "a/b/c")).toBe(true);
    expect(ruleMatches(compileRuleName("release/**"), "release/1.0/rc")).toBe(true);
  });

  it("supports ?, [...] classes, [!...] negation and {a,b} alternation", () => {
    expect(ruleMatches(compileRuleName("feat?ure"), "featXure")).toBe(true); // ? = one non-separator char
    expect(ruleMatches(compileRuleName("feat?ure"), "featurre")).toBe(false);
    expect(ruleMatches(compileRuleName("feat?ure"), "feature")).toBe(false); // 7 chars vs the 8-char pattern
    expect(ruleMatches(compileRuleName("[rd]ev"), "dev")).toBe(true);
    expect(ruleMatches(compileRuleName("[rd]ev"), "sev")).toBe(false);
    expect(ruleMatches(compileRuleName("[!d]ev"), "rev")).toBe(true);
    expect(ruleMatches(compileRuleName("[!d]ev"), "dev")).toBe(false);
    expect(ruleMatches(compileRuleName("{release,dev}/*"), "release/1")).toBe(true);
    expect(ruleMatches(compileRuleName("{release,dev}/*"), "dev/2")).toBe(true);
    expect(ruleMatches(compileRuleName("{release,dev}/*"), "main")).toBe(false);
  });

  it("falls back to the quoted literal on invalid globs (§4.2)", () => {
    const unterminated = compileRuleName("releases/[");
    expect(ruleMatches(unterminated, "releases/1")).toBe(false);
    expect(ruleMatches(unterminated, "releases/[")).toBe(true);
    const emptyClass = compileRuleName("a[]b"); // Go RE2 rejects `[]`
    expect(ruleMatches(emptyClass, "ab")).toBe(false);
    expect(ruleMatches(emptyClass, "a[]b")).toBe(true);
    const dangling = compileRuleName("esc\\");
    expect(ruleMatches(dangling, "esc\\")).toBe(true);
  });

  it("keeps globs case-sensitive while plain names fold (§4.3)", () => {
    expect(ruleMatches(compileRuleName("Release/*"), "release/1")).toBe(false);
  });

  it("finds matched branch names (FindAllMatchedBranches)", () => {
    expect(matchedBranchNamesForRule("release/*", ["main", "release/1", "release/2/x"])).toEqual(["release/1"]);
    expect(matchedBranchNamesForRule("main", ["MAIN", "main", "mainx"])).toEqual(["MAIN", "main"]);
  });
});

// ---------------------------------------------------------------------------
// Sort + first-match resolution
// ---------------------------------------------------------------------------

describe("listRepoRules/findRule (protected_branch_list.go:27–98)", () => {
  it("sorts by priority, then plain-before-glob, then creation order", async () => {
    const repoId = await seedRepo();
    await seedRule(repoId, "release/*", {}, { priority: 0, createdAt: new Date("2026-03-02T00:00:00Z") });
    await seedRule(repoId, "main", {}, { priority: 5, createdAt: new Date("2026-03-05T00:00:00Z") });
    await seedRule(repoId, "hotfix/*", {}, { priority: 5, createdAt: new Date("2026-03-03T00:00:00Z") });
    await seedRule(repoId, "dev", {}, { priority: 5, createdAt: new Date("2026-03-03T00:00:00Z") }); // created-order tie
    const rules = await listRepoRules(env.DB, repoId);
    // priority 0 first; at priority 5 the plains sort before the glob, and
    // the plains tie-break on creation (dev 03-03 before main 03-05).
    expect(rules.map((rule) => rule.ruleName)).toEqual(["release/*", "dev", "main", "hotfix/*"]);
  });

  it("answers the first match only (priority beats a later glob)", async () => {
    const repoId = await seedRepo();
    await seedRule(repoId, "main", { requiredApprovals: 2 }, { priority: 1 });
    await seedRule(repoId, "*", { requiredApprovals: 9 }, { priority: 2 });
    const rule = await findRule(env.DB, repoId, "main");
    expect(rule?.ruleName).toBe("main");
    // `*` cannot cross `/` — a deep path stays unmatched by both rules.
    expect(await findRule(env.DB, repoId, "a/b")).toBeNull();
  });

  it("matches plain rules against case-variant branch names", async () => {
    const repoId = await seedRepo();
    await seedRule(repoId, "Main", { requiredApprovals: 1 }, {});
    const rule = await findRule(env.DB, repoId, "main");
    expect(rule?.ruleName).toBe("Main");
  });
});

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

describe("predicate ports (protected_branch.go:135–289)", () => {
  let repoId: string;
  beforeEach(async () => {
    repoId = await seedRepo();
  });

  it("canUserPush: flag + write fallback + user/team whitelist", async () => {
    const config = parseRuleConfig("{}");
    expect(await canUserPush(env.DB, config, WRITE)).toBe(false); // can_push unset
    const push = { ...config, canPush: true };
    expect(await canUserPush(env.DB, push, WRITE)).toBe(true);
    expect(await canUserPush(env.DB, push, READ)).toBe(false);
    const whitelisted = { ...push, enableWhitelist: true, whitelistUserIds: [1] };
    expect(await canUserPush(env.DB, whitelisted, WRITE)).toBe(true);
    const teamOnly = { ...push, enableWhitelist: true, whitelistTeamIds: [77] };
    expect(await canUserPush(env.DB, teamOnly, WRITE)).toBe(false);
  });

  it("canUserForcePush: flag, allowlist AND push predicate", async () => {
    const config = { ...parseRuleConfig("{}"), canPush: true, canForcePush: true };
    expect(await canUserForcePush(env.DB, config, WRITE)).toBe(true);
    const allowlisted = { ...config, enableForcePushAllowlist: true, forcePushAllowlistUserIds: [1] };
    expect(await canUserForcePush(env.DB, allowlisted, WRITE)).toBe(true);
    expect(await canUserForcePush(env.DB, allowlisted, { userId: 2, write: true, admin: false })).toBe(false);
  });

  it("canUserDelete: write + can_delete + push predicate", async () => {
    const config = { ...parseRuleConfig("{}"), canPush: true, canDelete: true };
    expect(await canUserDelete(env.DB, config, WRITE)).toBe(true);
    expect(await canUserDelete(env.DB, config, READ)).toBe(false);
    expect(await canUserDelete(env.DB, { ...config, canDelete: false }, WRITE)).toBe(false);
  });

  it("isUserMergeWhitelisted: no whitelist → write; whitelist → user/team only", async () => {
    const config = parseRuleConfig("{}");
    expect(await isUserMergeWhitelisted(env.DB, config, WRITE)).toBe(true);
    expect(await isUserMergeWhitelisted(env.DB, config, READ)).toBe(false);
    const enabled = { ...config, enableMergeWhitelist: true, mergeWhitelistUserIds: [2] };
    expect(await isUserMergeWhitelisted(env.DB, enabled, WRITE)).toBe(false); // a writer not on the whitelist
    expect(await isUserMergeWhitelisted(env.DB, enabled, { userId: 2, write: false, admin: false })).toBe(true);
  });

  it("isUserMergeWhitelisted resolves team membership through team_members", async () => {
    const teamId = await seedTeam(5, "releasers");
    await seedTeamMember(5, teamId, 1);
    const teamArm = { ...parseRuleConfig("{}"), enableMergeWhitelist: true, mergeWhitelistTeamIds: [teamId] };
    expect(await isUserMergeWhitelisted(env.DB, teamArm, WRITE)).toBe(true);
    expect(await isUserMergeWhitelisted(env.DB, teamArm, { userId: 2, write: true, admin: false })).toBe(false);
    expect(await isUserInTeams(env.DB, 1, [teamId])).toBe(true);
  });

  it("canBypassBranchProtection: admin arm vs block_admin_merge_override, then the allowlist", async () => {
    const config = parseRuleConfig("{}");
    expect(await canBypassBranchProtection(env.DB, config, ADMIN)).toBe(true);
    expect(await canBypassBranchProtection(env.DB, config, WRITE)).toBe(false);
    const blocked = { ...config, blockAdminMergeOverride: true };
    expect(await canBypassBranchProtection(env.DB, blocked, ADMIN)).toBe(false);
    const allowlisted = { ...blocked, enableBypassAllowlist: true, bypassAllowlistUserIds: [1] };
    expect(await canBypassBranchProtection(env.DB, allowlisted, WRITE)).toBe(true);
    expect(await canBypassBranchProtection(env.DB, { ...blocked, enableBypassAllowlist: true, bypassAllowlistTeamIds: [78] }, WRITE)).toBe(false);
  });

  it("isUserOfficialReviewer: null rule keeps write; whitelist arms are explicit", async () => {
    expect(await isUserOfficialReviewer(env.DB, null, WRITE)).toBe(true);
    expect(await isUserOfficialReviewer(env.DB, null, READ)).toBe(false);
    const noWhitelist = parseRuleConfig("{}");
    expect(await isUserOfficialReviewer(env.DB, noWhitelist, WRITE)).toBe(true);
    const whitelisted = { ...noWhitelist, enableApprovalsWhitelist: true, approvalsWhitelistUserIds: [2] };
    // an admin NOT on the whitelist is not an official reviewer (upstream-verbatim)
    expect(await isUserOfficialReviewer(env.DB, whitelisted, ADMIN)).toBe(false);
    expect(await isUserOfficialReviewer(env.DB, whitelisted, { userId: 2, write: false, admin: false })).toBe(true);
  });

  it("principalAccessOf maps the reduced matrix + collaborator rows", async () => {
    const repoRow = (await db().select().from(repositories).where(eq(repositories.id, repoId)).all())[0]!;
    expect(await principalAccessOf(env.DB, repoRow, null)).toEqual({ userId: 0, write: false, admin: false });
    // the owner grant → write+admin
    const ownerAccess = await principalAccessOf(env.DB, repoRow, asUser(4, OWNER));
    expect(ownerAccess.write).toBe(true);
    expect(ownerAccess.admin).toBe(true);
    // a plain unrelated user: nothing
    expect(await principalAccessOf(env.DB, repoRow, asUser(1, "doer"))).toEqual({ userId: 1, write: false, admin: false });
    // a site admin: both
    const chief = await principalAccessOf(env.DB, repoRow, asUser(3, "chief", true));
    expect(chief.write).toBe(true);
    expect(chief.admin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Approval counting + the merge-gate texts
// ---------------------------------------------------------------------------

describe("checkPullBranchProtections (merge.go:694–742) over pull_reviews", () => {
  let repoId: string;
  let pull: { issueId: number; index: number };
  beforeEach(async () => {
    repoId = await seedRepo();
    pull = await seedPull(repoId);
  });

  it("passes with a zero-requirement rule (HasEnoughApprovals :762–767)", async () => {
    const ruleId = await seedRule(repoId, "main", {});
    const rule = await ruleOf(repoId, ruleId);
    expect(await checkPullBranchProtections(env.DB, rule, { issueId: pull.issueId, commitsBehind: 0 })).toBeNull();
  });

  it("405s verbatim when approvals are short; official undismissed approvals count", async () => {
    const ruleId = await seedRule(repoId, "main", { requiredApprovals: 1 });
    const rule = await ruleOf(repoId, ruleId);
    expect(await checkPullBranchProtections(env.DB, rule, { issueId: pull.issueId, commitsBehind: 0 })).toBe("Does not have enough approvals");
    await seedReview(pull.issueId, ReviewType.Approve, { official: true });
    expect(await checkPullBranchProtections(env.DB, rule, { issueId: pull.issueId, commitsBehind: 0 })).toBeNull();
  });

  it("non-official and dismissed approvals never count; stale filters only under ignore_stale_approvals", async () => {
    const ruleId = await seedRule(repoId, "main", { requiredApprovals: 1 });
    const rule = await ruleOf(repoId, ruleId);
    await seedReview(pull.issueId, ReviewType.Approve, { official: false });
    await seedReview(pull.issueId, ReviewType.Approve, { official: true, dismissed: true });
    expect(await checkPullBranchProtections(env.DB, rule, { issueId: pull.issueId, commitsBehind: 0 })).toBe("Does not have enough approvals");

    // stale counts by DEFAULT (:775–777 — the filter arms only under ignore)
    await seedReview(pull.issueId, ReviewType.Approve, { official: true, stale: true, reviewerId: 2 });
    expect(await checkPullBranchProtections(env.DB, rule, { issueId: pull.issueId, commitsBehind: 0 })).toBeNull();

    const ignoreRuleId = await seedRule(repoId, "*", { requiredApprovals: 1, ignoreStaleApprovals: true }, { priority: 9 });
    const ignoreRule = await ruleOf(repoId, ignoreRuleId);
    expect(await grantedApprovalsCount(env.DB, pull.issueId, parseRuleConfig(ignoreRule.rules))).toBe(0);
    expect(await checkPullBranchProtections(env.DB, ignoreRule, { issueId: pull.issueId, commitsBehind: 0 })).toBe("Does not have enough approvals");
  });

  it("405s verbatim on an official undismissed reject under block_on_rejected_reviews", async () => {
    const ruleId = await seedRule(repoId, "main", { blockOnRejectedReviews: true });
    const rule = await ruleOf(repoId, ruleId);
    await seedReview(pull.issueId, ReviewType.Reject, { official: true, dismissed: true });
    expect(await checkPullBranchProtections(env.DB, rule, { issueId: pull.issueId, commitsBehind: 0 })).toBeNull(); // dismissed rejects pass
    await seedReview(pull.issueId, ReviewType.Reject, { official: true });
    expect(await checkPullBranchProtections(env.DB, rule, { issueId: pull.issueId, commitsBehind: 0 })).toBe("There are requested changes");
  });

  it("405s verbatim on an official request row under block_on_official_review_requests", async () => {
    const ruleId = await seedRule(repoId, "main", { blockOnOfficialReviewRequests: true });
    const rule = await ruleOf(repoId, ruleId);
    await seedReview(pull.issueId, ReviewType.Request, { official: false });
    expect(await checkPullBranchProtections(env.DB, rule, { issueId: pull.issueId, commitsBehind: 0 })).toBeNull();
    await seedReview(pull.issueId, ReviewType.Request, { official: true });
    expect(await checkPullBranchProtections(env.DB, rule, { issueId: pull.issueId, commitsBehind: 0 })).toBe("There are official review requests");
  });

  it("405s verbatim on the outdated arm (block_on_outdated_branch AND commits_behind > 0)", async () => {
    const ruleId = await seedRule(repoId, "main", { blockOnOutdatedBranch: true });
    const rule = await ruleOf(repoId, ruleId);
    expect(await checkPullBranchProtections(env.DB, rule, { issueId: pull.issueId, commitsBehind: 0 })).toBeNull();
    expect(await checkPullBranchProtections(env.DB, rule, { issueId: pull.issueId, commitsBehind: 3 })).toBe("The head branch is behind the base branch");
  });
});

// ---------------------------------------------------------------------------
// The §3.4 retroactive official recompute
// ---------------------------------------------------------------------------

describe("recomputeOfficialForRule (services/pull/protected_branch.go:13–47 port)", () => {
  it("flips official flags of open PRs on matching bases only, per the whitelist", async () => {
    const repoId = await seedRepo();
    const matching = await seedPull(repoId, "main");
    const other = await seedPull(repoId, "develop");
    // matching PR: an official-by-write approve (doer is not whitelisted) and
    // a not-yet-official approve by a whitelist member
    await seedReview(matching.issueId, ReviewType.Approve, { official: true, reviewerId: 1 });
    await seedReview(matching.issueId, ReviewType.Approve, { official: false, reviewerId: 2 });
    // other PR: an official-by-write approve that must stay untouched
    await seedReview(other.issueId, ReviewType.Approve, { official: true, reviewerId: 1 });

    const ruleId = await seedRule(repoId, "main", { enableApprovalsWhitelist: true, approvalsWhitelistUserIds: [2] });
    const rule = await ruleOf(repoId, ruleId);
    const repoRow = (await db().select().from(repositories).where(eq(repositories.id, repoId)).all())[0]!;

    expect(await recomputeOfficialForRule(env.DB, repoRow, rule)).toBe(2);
    const flags = await db().select().from(pullReviews).all();
    const flagOf = (issueId: number, reviewerId: number) => flags.find((row) => row.issueId === issueId && row.reviewerId === reviewerId)!.official;
    expect(flagOf(matching.issueId, 1)).toBe(false);
    expect(flagOf(matching.issueId, 2)).toBe(true);
    expect(flagOf(other.issueId, 1)).toBe(true);
  });

  it("a plain rule keeps the write arm — writers stay official", async () => {
    const repoId = await seedRepo();
    const pull = await seedPull(repoId, "main");
    await db().insert(repoCollaborators).values({ repoId, userId: 1, mode: "write", createdAt: new Date(), updatedAt: new Date() });
    await seedReview(pull.issueId, ReviewType.Approve, { official: false, reviewerId: 1 });
    const ruleId = await seedRule(repoId, "main", {});
    const rule = await ruleOf(repoId, ruleId);
    const repoRow = (await db().select().from(repositories).where(eq(repositories.id, repoId)).all())[0]!;
    expect(await recomputeOfficialForRule(env.DB, repoRow, rule)).toBe(1);
  });

  it("closes/merged PRs are outside the rewrite universe", async () => {
    const repoId = await seedRepo();
    const pull = await seedPull(repoId, "main");
    await service().closeIssue(pull.issueId, { actorId: 2 });
    await seedReview(pull.issueId, ReviewType.Approve, { official: true, reviewerId: 1 });
    const ruleId = await seedRule(repoId, "main", { enableApprovalsWhitelist: true, approvalsWhitelistUserIds: [] });
    const rule = await ruleOf(repoId, ruleId);
    const repoRow = (await db().select().from(repositories).where(eq(repositories.id, repoId)).all())[0]!;
    expect(await recomputeOfficialForRule(env.DB, repoRow, rule)).toBe(0);
  });
});

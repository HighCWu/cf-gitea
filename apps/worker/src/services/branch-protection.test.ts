/**
 * Protected-branch rule service (SPEC-0013 §3.2) over real D1 — the match/sort
 * table (priority × plain/glob × created tie-break,
 * protected_branch_list.go:27–54 cases), the glob grammar port, the predicate
 * ports (merge whitelist / bypass / official reviewer — user and team arms),
 * the approval counting over seeded `pull_reviews` (official/stale/dismissed
 * permutations, the ignore_stale_approvals arm), the upstream-exact 405 texts
 * of checkPullBranchProtections, the §3.4 retroactive official recompute, and
 * the M4 family: the save-side whitelist sanitization (UpdateProtectBranch's
 * updateUserWhitelist/updateApprovalWhitelist/updateTeamWhitelist ports), the
 * principal-deletion scrub (RemoveUserID/TeamIDFromProtectedBranch) and the
 * full canBypassBranchProtection bypass/admin-override matrix.
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
  sanitizeApprovalWhitelist,
  sanitizeRuleWhitelists,
  sanitizeTeamWhitelist,
  sanitizeUserWhitelist,
  scrubTeamFromOrgRules,
  scrubUserFromAllRules,
  serializeRuleConfig,
  type ProtectedBranchConfig,
  type PrincipalAccess,
} from "./branch-protection";
import { protectedBranches, pullReviews, repoCollaborators, repositories, ReviewType, teamMembers, teamRepoAccess, teams } from "../db/schema";
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

/** seedRepo with a per-id slug — the M4 scrub tests need several repos at
 *  once and the shared seedRepo pins one (owner, slug) pair. */
async function seedRepoDistinct(): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace: OWNER,
    slug: `visible${id}`,
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

// ---------------------------------------------------------------------------
// M4: save-side whitelist sanitization (UpdateProtectBranch :418–527)
// ---------------------------------------------------------------------------

describe("save-side whitelist sanitization (M4 — updateUserWhitelist :572-601 / updateApprovalWhitelist :549-568 / updateTeamWhitelist :605-624)", () => {
  /** alice/visibleN with an org owner row (launch-org, id 5) for the team arms. */
  async function seedOrgRepo(): Promise<string> {
    const repoId = await seedRepo();
    await db().update(repositories).set({ ownerId: 5 }).where(eq(repositories.id, repoId));
    return repoId;
  }

  const repoRowOf = async (repoId: string) => (await db().select().from(repositories).where(eq(repositories.id, repoId)).all())[0]!;

  it("keeps an unchanged list verbatim — the SliceSortedEqual short-circuit keeps even stale ids (:575-577)", async () => {
    const repoId = await seedRepo();
    const repo = await repoRowOf(repoId);
    // user 999 does not exist — an UNCHANGED list is kept untouched; the
    // deletion scrub, not the save, owns already-stored stale ids.
    expect(await sanitizeUserWhitelist(env.DB, repo, [2, 999], [999, 2])).toEqual([2, 999]);
    expect(await sanitizeTeamWhitelist(env.DB, repo, [31], [31])).toEqual([31]);
    expect(await sanitizeApprovalWhitelist(env.DB, repo, [999], [999])).toEqual([999]);
  });

  it("a changed user list keeps writers and the pseudo-ids, drops readers and vanished ids (:580-597)", async () => {
    const repoId = await seedRepo();
    await db().insert(repoCollaborators).values({ repoId, userId: 2, mode: "write", createdAt: new Date(), updatedAt: new Date() });
    const repo = await repoRowOf(repoId);
    // bob (2) is a write collaborator; alice (4) owns the repo (matrix write);
    // doer (1) has no access; 999 is vanished; the deploy-key pseudo survives.
    const kept = await sanitizeUserWhitelist(env.DB, repo, [], [2, 4, 1, 999, -3]);
    expect(kept).toEqual([2, 4, -3]);
  });

  it("the approvals whitelist keeps ANY explicit access — a read collaborator stays (:549-568)", async () => {
    const repoId = await seedRepo();
    await db().insert(repoCollaborators).values([
      { repoId, userId: 2, mode: "write", createdAt: new Date(), updatedAt: new Date() },
      { repoId, userId: 1, mode: "read", createdAt: new Date(), updatedAt: new Date() },
    ]);
    const repo = await repoRowOf(repoId);
    // The push whitelist drops the reader; the approvals list keeps them —
    // upstream's CanWrite(TypeCode) vs GetUserIDsWithAnyUnitAccess contrast.
    expect(await sanitizeUserWhitelist(env.DB, repo, [], [2, 1])).toEqual([2]);
    expect(await sanitizeApprovalWhitelist(env.DB, repo, [], [2, 1, 999])).toEqual([2, 1]);
    // A public repo's implicit pull is NOT explicit access — the owner's
    // grant is, though (repositoryPermissions' matrix admin arm).
    expect(await sanitizeApprovalWhitelist(env.DB, repo, [], [4])).toEqual([4]);
  });

  it("a changed team list keeps only teams with repo access — row or includes_all (:605-624)", async () => {
    const repoId = await seedOrgRepo();
    const granted = await seedTeam(5, "granted");
    const coversAll = await seedTeam(5, "covers-all");
    await db().update(teams).set({ includesAllRepositories: true }).where(eq(teams.id, coversAll));
    const ungranted = await seedTeam(5, "ungranted");
    await db().insert(teamRepoAccess).values({ orgId: 5, teamId: granted, repoId });
    const repo = await repoRowOf(repoId);

    const kept = await sanitizeTeamWhitelist(env.DB, repo, [], [granted, coversAll, ungranted, 777]);
    expect(kept).toEqual([granted, coversAll]); // 777: another org's id — no access, dropped
  });

  it("sanitizeRuleWhitelists routes each of the twelve lists through its upstream filter (:438-493)", async () => {
    const repoId = await seedOrgRepo();
    await db().insert(repoCollaborators).values([
      { repoId, userId: 2, mode: "write", createdAt: new Date(), updatedAt: new Date() },
      { repoId, userId: 1, mode: "read", createdAt: new Date(), updatedAt: new Date() },
    ]);
    const grantedTeam = await seedTeam(5, "granted");
    await db().insert(teamRepoAccess).values({ orgId: 5, teamId: grantedTeam, repoId });
    const repo = await repoRowOf(repoId);

    const config: ProtectedBranchConfig = {
      ...emptyRuleConfig(),
      whitelistUserIds: [2, 1, -3], // writer kept, reader dropped, pseudo kept
      forcePushAllowlistUserIds: [1], // dropped
      deletionAllowlistUserIds: [2], // kept
      mergeWhitelistUserIds: [999], // vanished, dropped
      approvalsWhitelistUserIds: [1, 2], // reader + writer both kept
      bypassAllowlistUserIds: [1], // dropped
      whitelistTeamIds: [grantedTeam, 777], // granted kept, foreign dropped
      approvalsWhitelistTeamIds: [777], // dropped
      bypassAllowlistTeamIds: [grantedTeam], // kept
    };
    const sanitized = await sanitizeRuleWhitelists(env.DB, repo, config, emptyRuleConfig());
    expect(sanitized).toBe(config); // in-place
    expect(config.whitelistUserIds).toEqual([2, -3]);
    expect(config.forcePushAllowlistUserIds).toEqual([]);
    expect(config.deletionAllowlistUserIds).toEqual([2]);
    expect(config.mergeWhitelistUserIds).toEqual([]);
    expect(config.approvalsWhitelistUserIds).toEqual([1, 2]);
    expect(config.bypassAllowlistUserIds).toEqual([]);
    expect(config.whitelistTeamIds).toEqual([grantedTeam]);
    expect(config.approvalsWhitelistTeamIds).toEqual([]);
    expect(config.bypassAllowlistTeamIds).toEqual([grantedTeam]);
  });
});

// ---------------------------------------------------------------------------
// M4: principal-deletion scrub (removeIDsFromProtectedBranch :640-693)
// ---------------------------------------------------------------------------

describe("principal-deletion scrub (M4 — RemoveUserIDFromProtectedBranch / RemoveTeamIDFromProtectedBranch)", () => {
  const ruleIdsWith = async (userId: number): Promise<[number, number]> => {
    // rules carrying the principal in EVERY allowlist column (the bypass pair
    // included — the recorded divergence from upstream's five-array sweep)
    const a = await seedRule(await seedRepoDistinct(), "main", {
      whitelistUserIds: [userId, 4],
      forcePushAllowlistUserIds: [userId],
      deletionAllowlistUserIds: [userId],
      mergeWhitelistUserIds: [userId],
      approvalsWhitelistUserIds: [userId],
      bypassAllowlistUserIds: [userId],
    });
    const b = await seedRule(await seedRepoDistinct(), "release/*", {
      whitelistUserIds: [userId],
      bypassAllowlistUserIds: [userId, 4],
    });
    return [a, b];
  };

  it("strips a deleted user from every allowlist column of every rule; a second pass is a no-op", async () => {
    const [a, b] = await ruleIdsWith(2);
    expect(await scrubUserFromAllRules(env.DB, 2)).toBe(2);
    const ruleA = parseRuleConfig((await db().select().from(protectedBranches).where(eq(protectedBranches.id, a)).all())[0]!.rules);
    expect(ruleA.whitelistUserIds).toEqual([4]);
    for (const ids of [
      ruleA.forcePushAllowlistUserIds,
      ruleA.deletionAllowlistUserIds,
      ruleA.mergeWhitelistUserIds,
      ruleA.approvalsWhitelistUserIds,
      ruleA.bypassAllowlistUserIds,
    ]) {
      expect(ids).toEqual([]);
    }
    const ruleB = parseRuleConfig((await db().select().from(protectedBranches).where(eq(protectedBranches.id, b)).all())[0]!.rules);
    expect(ruleB.whitelistUserIds).toEqual([]);
    expect(ruleB.bypassAllowlistUserIds).toEqual([4]); // the other principal survives
    // Idempotent — the second sweep rewrites nothing (the :669-683 changed-only update).
    expect(await scrubUserFromAllRules(env.DB, 2)).toBe(0);
  });

  it("refuses the pseudo-principals — they are never users and survive every scrub", async () => {
    await ruleIdsWith(-3);
    expect(await scrubUserFromAllRules(env.DB, -3)).toBe(0);
    expect(await scrubUserFromAllRules(env.DB, -2)).toBe(0);
    const rules = await db().select().from(protectedBranches).all();
    expect(rules).toHaveLength(2);
    for (const row of rules) {
      expect(parseRuleConfig(row.rules).whitelistUserIds).toContain(-3);
    }
  });

  it("the team scrub is org-scoped (team.go:196-205): the org's repos' rules only", async () => {
    const orgRepo = await seedRepoDistinct();
    await db().update(repositories).set({ ownerId: 5 }).where(eq(repositories.id, orgRepo));
    const teamId = await seedTeam(5, "devs");
    const orgRule = await seedRule(orgRepo, "main", {
      whitelistTeamIds: [teamId],
      forcePushAllowlistTeamIds: [teamId],
      deletionAllowlistTeamIds: [teamId],
      mergeWhitelistTeamIds: [teamId],
      approvalsWhitelistTeamIds: [teamId],
      bypassAllowlistTeamIds: [teamId, 4],
    });
    // A user-owned repo's rule carrying the SAME integer id is out of scope.
    const otherRepo = await seedRepoDistinct();
    const otherRule = await seedRule(otherRepo, "main", { whitelistTeamIds: [teamId] });

    expect(await scrubTeamFromOrgRules(env.DB, 5, teamId)).toBe(1);
    const orgRow = (await db().select().from(protectedBranches).where(eq(protectedBranches.id, orgRule)).all())[0]!;
    const orgConfig = parseRuleConfig(orgRow.rules);
    for (const ids of [
      orgConfig.whitelistTeamIds,
      orgConfig.forcePushAllowlistTeamIds,
      orgConfig.deletionAllowlistTeamIds,
      orgConfig.mergeWhitelistTeamIds,
      orgConfig.approvalsWhitelistTeamIds,
    ]) {
      expect(ids).toEqual([]);
    }
    expect(orgConfig.bypassAllowlistTeamIds).toEqual([4]);
    const otherRow = (await db().select().from(protectedBranches).where(eq(protectedBranches.id, otherRule)).all())[0]!;
    expect(parseRuleConfig(otherRow.rules).whitelistTeamIds).toEqual([teamId]); // untouched
    expect(await scrubTeamFromOrgRules(env.DB, 5, teamId)).toBe(0);
  });

  it("the rewrite touches only the config column — updated_at keeps the admin's last edit (:669-683)", async () => {
    const repoId = await seedRepoDistinct();
    const ruleId = await seedRule(repoId, "main", { mergeWhitelistUserIds: [2] });
    const before = (await db().select().from(protectedBranches).where(eq(protectedBranches.id, ruleId)).all())[0]!;
    await scrubUserFromAllRules(env.DB, 2);
    const after = (await db().select().from(protectedBranches).where(eq(protectedBranches.id, ruleId)).all())[0]!;
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(parseRuleConfig(after.rules).mergeWhitelistUserIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M4: the bypass/admin-override matrix (CanBypassBranchProtection :242-261)
// ---------------------------------------------------------------------------

describe("canBypassBranchProtection — the full bypass/admin-override matrix (M4)", () => {
  /** org 5 + one team with `member` (user 1) in it — the team-arm inputs. */
  async function seedBypassTeam(): Promise<number> {
    const teamId = await seedTeam(5, "bypassers");
    await seedTeamMember(5, teamId, 1);
    return teamId;
  }

  it.each([
    ["repo admin, override off → the admin arm", { admin: true, blockAdminMergeOverride: false, enableBypassAllowlist: false }, { listed: false, team: false }, true],
    ["repo admin, override on, allowlist off → refused", { admin: true, blockAdminMergeOverride: true, enableBypassAllowlist: false }, { listed: false, team: false }, false],
    ["repo admin, override on, allowlist on, admin off it → refused", { admin: true, blockAdminMergeOverride: true, enableBypassAllowlist: true }, { listed: false, team: false }, false],
    ["repo admin, override on, admin personally listed → the allowlist rescues", { admin: true, blockAdminMergeOverride: true, enableBypassAllowlist: true }, { listed: true, team: false }, true],
    ["repo admin, override on, admin's team listed → the team arm rescues", { admin: true, blockAdminMergeOverride: true, enableBypassAllowlist: true }, { listed: false, team: true }, true],
    ["non-admin, allowlist off → refused", { admin: false, blockAdminMergeOverride: true, enableBypassAllowlist: false }, { listed: false, team: false }, false],
    ["non-admin, personally listed → allowed", { admin: false, blockAdminMergeOverride: false, enableBypassAllowlist: true }, { listed: true, team: false }, true],
    ["non-admin, team-listed → allowed", { admin: false, blockAdminMergeOverride: false, enableBypassAllowlist: true }, { listed: false, team: true }, true],
    ["non-admin, allowlist on, not listed → refused", { admin: false, blockAdminMergeOverride: false, enableBypassAllowlist: true }, { listed: false, team: false }, false],
  ])("%s", async (_name, flags, allowlist, expected) => {
    const teamId = await seedBypassTeam();
    const config: ProtectedBranchConfig = {
      ...emptyRuleConfig(),
      blockAdminMergeOverride: flags.blockAdminMergeOverride,
      enableBypassAllowlist: flags.enableBypassAllowlist,
      bypassAllowlistUserIds: allowlist.listed ? [1] : [],
      bypassAllowlistTeamIds: allowlist.team ? [teamId] : [],
    };
    const access: PrincipalAccess = { userId: 1, write: true, admin: flags.admin };
    expect(await canBypassBranchProtection(env.DB, config, access)).toBe(expected);
  });

  it("the force_merge consumer contract: blocked cells keep force_merge a plain 405, cleared cells let it through (check.go:192-207)", async () => {
    // The route-level cells (pull-merge-protection.test.ts) pin the RPC arm;
    // this pins the predicate composition the RPC consults: override blocks
    // the admin EXACTLY when the allowlist cannot rescue them.
    const teamId = await seedBypassTeam();
    const override: ProtectedBranchConfig = {
      ...emptyRuleConfig(),
      blockAdminMergeOverride: true,
      enableBypassAllowlist: true,
      bypassAllowlistTeamIds: [teamId],
    };
    expect(await canBypassBranchProtection(env.DB, override, { userId: 1, write: true, admin: true })).toBe(true);
    const overrideNoRescue: ProtectedBranchConfig = { ...override, bypassAllowlistTeamIds: [] };
    expect(await canBypassBranchProtection(env.DB, overrideNoRescue, { userId: 1, write: true, admin: true })).toBe(false);
  });
});

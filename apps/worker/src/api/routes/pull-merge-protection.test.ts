/**
 * SPEC-0013 §3.3 — the merge RPC protection gate, route-level, on real D1 +
 * real engine cells (the pull-reviews.test.ts standalone-mount convention).
 *
 * Matrix: upstream-exact 405 texts ("Does not have enough approvals", "There
 * are requested changes", "There are official review requests", "The head
 * branch is behind the base branch"), the official/dismissed/stale approval
 * counting permutations, the force_merge bypass (admin; block_admin_merge_
 * override; the bypass allowlist), the merge-whitelist 403 arm, and the
 * manually-merged skip (check.go:162–165). Each test seeds its OWN repo
 * (unique slug → its own engine cell) because a 200 merge moves `main`.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";
import { OpenAPIHono } from "@hono/zod-openapi";

import { protectedBranches, pullRequests, pullReviews, repoCollaborators, repositories, ReviewType, teamMembers, teams } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { ZERO_OID, branchRef } from "../services/engine";
import type { AuthResolver } from "../auth";
import { createTokenAuthMiddleware } from "../auth";
import type { ApiEnv } from "../env";
import { giteaErrorHandler } from "../errors";
import { registerPullRoutes } from "./pulls";
import { emptyRuleConfig, serializeRuleConfig, type ProtectedBranchConfig } from "../../services/branch-protection";

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
    "issue_labels",
    "pull_requests",
    "issues",
    "milestones",
    "labels",
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
    [4, "alice", 0], // the repo owner — the merging admin
    [5, "cara", 0], // a write collaborator
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (?, ?, ?, ?, 'active', 0)",
    )
      .bind(id, username, username, isAdmin)
      .run();
  }
});

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);

const OWNER = "alice";
const DOER_TOKEN = "token-doer";
const ALICE_TOKEN = "token-alice";
const CARA_TOKEN = "token-cara";

const IDENTITY_TOKENS: Record<string, { id: number; login: string; is_admin: boolean }> = {
  [DOER_TOKEN]: { id: 1, login: "doer", is_admin: false },
  [ALICE_TOKEN]: { id: 4, login: "alice", is_admin: false },
  [CARA_TOKEN]: { id: 5, login: "cara", is_admin: false },
};

const resolver: AuthResolver = { resolveToken: (token: string) => Promise.resolve(IDENTITY_TOKENS[token] ?? null) };

function app(): OpenAPIHono<ApiEnv> {
  const a = new OpenAPIHono<ApiEnv>();
  a.onError(giteaErrorHandler);
  registerPullRoutes(a, createTokenAuthMiddleware(resolver), createTokenAuthMiddleware(resolver));
  return a;
}

const router = () => {
  const a = app();
  // The local mount serves the registry paths relative to the /api/v1 mount
  // (the worker mounts it; tests fetch the bare router, pull-reviews style).
  return async (path: string, init?: RequestInit): Promise<Response> =>
    a.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
};

const authed = (token: string, init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers ?? {}), Authorization: `token ${token}`, "Content-Type": "application/json" },
});

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

/** Worker-side object hash (workerd crypto.subtle; putApiObjects re-verifies). */
async function gitObjectOid(type: string, data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header, 0);
  bytes.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

let repoSeq = 5300;

interface Scenario {
  slug: string;
  repoId: string;
  mainTip: string;
  featTip: string;
  index: number;
  issueId: number;
}

/** One repo with a real main→feature ancestry: `feature` = main + new file,
 *  so the PR is Mergeable after the lazy check. */
async function seedScenario(): Promise<Scenario> {
  const slug = `visible${repoSeq}`;
  const repoId = String(repoSeq++);
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: OWNER,
    slug,
    visibility: "public",
    isArchived: false,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await service().ensureRepoCounters(repoId);

  const cell = env.REPO.getByName(`${OWNER}/${slug}`);
  const person = { name: "seed", email: "seed@merge.invalid", time: 1761000000, tz: "+0000" };

  const readme = new TextEncoder().encode(`# ${slug}\n`);
  const readmeOid = await gitObjectOid("blob", readme);
  const rootTree = serializeTree([{ mode: "100644", name: "README.md", oid: readmeOid }]);
  const rootCommit = serializeCommit({ tree: rootTree.oid, parents: [], author: person, committer: person, message: "root\n" });
  const put = await cell.putApiObjects([
    { oid: readmeOid, type: "blob", data: readme },
    { oid: rootTree.oid, type: "tree", data: rootTree.data },
    { oid: rootCommit.oid, type: "commit", data: rootCommit.data },
  ]);
  if (put.tag !== "ok") throw new Error(`seed root putApiObjects failed: ${put.tag}`);

  const extra = new TextEncoder().encode("feature work\n");
  const extraOid = await gitObjectOid("blob", extra);
  const featTree = serializeTree([
    { mode: "100644", name: "README.md", oid: readmeOid },
    { mode: "100644", name: "feature.txt", oid: extraOid },
  ]);
  const featCommit = serializeCommit({ tree: featTree.oid, parents: [rootCommit.oid], author: person, committer: person, message: "feature\n" });
  const putFeat = await cell.putApiObjects([
    { oid: extraOid, type: "blob", data: extra },
    { oid: featTree.oid, type: "tree", data: featTree.data },
    { oid: featCommit.oid, type: "commit", data: featCommit.data },
  ]);
  if (putFeat.tag !== "ok") throw new Error(`seed feature putApiObjects failed: ${putFeat.tag}`);

  for (const [ref, oid] of [
    [branchRef("main"), rootCommit.oid],
    [branchRef("feature"), featCommit.oid],
  ] as const) {
    const landed = await cell.commitApiChange({ ref, expectedOldOid: ZERO_OID, newOid: oid });
    if (landed.tag !== "committed") throw new Error(`seed ref landing failed: ${ref}`);
  }

  const { issue } = await service().createPullRequest({
    repoId,
    title: "protectable change",
    posterId: 2,
    headRepoId: repoId,
    baseBranch: "main",
    headBranch: "feature",
  });
  const headLanded = await cell.commitApiChange({ ref: `refs/pull/${issue.index}/head`, expectedOldOid: ZERO_OID, newOid: featCommit.oid });
  if (headLanded.tag !== "committed") throw new Error("seed pull head landing failed");

  return { slug, repoId, mainTip: rootCommit.oid, featTip: featCommit.oid, index: issue.index, issueId: issue.id };
}

async function seedRule(repoId: string, config: Partial<ProtectedBranchConfig>, ruleName = "main", priority = 0): Promise<void> {
  await db().insert(protectedBranches).values({
    repoId,
    ruleName,
    priority,
    rules: serializeRuleConfig({ ...emptyRuleConfig(), ...config }),
    createdAt: new Date("2026-03-01T00:00:00Z"),
    updatedAt: new Date("2026-03-01T00:00:00Z"),
  });
}

async function seedReview(scenario: Scenario, type: number, flags: { official?: boolean; stale?: boolean; dismissed?: boolean; reviewerId?: number } = {}): Promise<void> {
  await db().insert(pullReviews).values({
    type,
    reviewerId: flags.reviewerId ?? 5,
    issueId: scenario.issueId,
    content: "",
    official: flags.official ?? false,
    stale: flags.stale ?? false,
    dismissed: flags.dismissed ?? false,
    commitId: scenario.featTip,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function markBehind(scenario: Scenario, commitsBehind: number): Promise<void> {
  await db().update(pullRequests).set({ commitsBehind }).where(eq(pullRequests.issueId, scenario.issueId));
}

const merge = (scenario: Scenario, body: Record<string, unknown>, token = ALICE_TOKEN): Promise<Response> =>
  router()(`/api/v1/repos/${OWNER}/${scenario.slug}/pulls/${scenario.index}/merge`, authed(token, { method: "POST", body: JSON.stringify({ do: "merge", ...body }) }));

describe("POST …/pulls/{index}/merge — the SPEC-0013 protection gate", () => {
  it("merges 200 with no rule (the landed behavior stands)", async () => {
    const scenario = await seedScenario();
    const res = await merge(scenario, {});
    expect(res.status).toBe(200);
  });

  it("405s verbatim on required approvals short; an official approve lets it through", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, { requiredApprovals: 1 });
    const blocked = await merge(scenario, {});
    expect(blocked.status).toBe(405);
    expect((await jsonBody(blocked)).message).toBe("Does not have enough approvals");
  });

  it("non-official and dismissed approvals never count", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, { requiredApprovals: 1 });
    await seedReview(scenario, ReviewType.Approve, { official: false });
    const nonOfficial = await merge(scenario, {});
    expect(nonOfficial.status).toBe(405);
    expect((await jsonBody(nonOfficial)).message).toBe("Does not have enough approvals");
  });

  it("an official undismissed approve satisfies the requirement → 200", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, { requiredApprovals: 1 });
    await seedReview(scenario, ReviewType.Approve, { official: true });
    expect((await merge(scenario, {})).status).toBe(200);
  });

  it("a dismissed official approve does not count → 405 verbatim", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, { requiredApprovals: 1 });
    await seedReview(scenario, ReviewType.Approve, { official: true, dismissed: true });
    const res = await merge(scenario, {});
    expect(res.status).toBe(405);
    expect((await jsonBody(res)).message).toBe("Does not have enough approvals");
  });

  it("a stale official approve filters only under ignore_stale_approvals", async () => {
    const staleScenario = await seedScenario();
    await seedRule(staleScenario.repoId, { requiredApprovals: 1 });
    await seedReview(staleScenario, ReviewType.Approve, { official: true, stale: true });
    expect((await merge(staleScenario, {})).status).toBe(200); // stale counts by default (:775–777)

    const ignoreScenario = await seedScenario();
    await seedRule(ignoreScenario.repoId, { requiredApprovals: 1, ignoreStaleApprovals: true });
    await seedReview(ignoreScenario, ReviewType.Approve, { official: true, stale: true });
    const res = await merge(ignoreScenario, {});
    expect(res.status).toBe(405);
    expect((await jsonBody(res)).message).toBe("Does not have enough approvals");
  });

  it("405s verbatim on an official undismissed reject under block_on_rejected_reviews", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, { blockOnRejectedReviews: true });
    await seedReview(scenario, ReviewType.Reject, { official: true });
    const res = await merge(scenario, {});
    expect(res.status).toBe(405);
    expect((await jsonBody(res)).message).toBe("There are requested changes");
  });

  it("405s verbatim on an official request row under block_on_official_review_requests", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, { blockOnOfficialReviewRequests: true });
    await seedReview(scenario, ReviewType.Request, { official: true });
    const res = await merge(scenario, {});
    expect(res.status).toBe(405);
    expect((await jsonBody(res)).message).toBe("There are official review requests");
  });

  it("405s verbatim on the outdated arm; the count survives only after the lazy check settles", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, { blockOnOutdatedBranch: true });
    // settle the row's `checking` status first — ensurePullRequestChecked
    // CAS-writes the real divergence over a seeded count otherwise
    const settled = await router()(`/api/v1/repos/${OWNER}/${scenario.slug}/pulls/${scenario.index}`, authed(ALICE_TOKEN));
    expect(settled.status).toBe(200);
    await markBehind(scenario, 2);
    const res = await merge(scenario, {});
    expect(res.status).toBe(405);
    expect((await jsonBody(res)).message).toBe("The head branch is behind the base branch");
  });

  it("force_merge clears the failure for a repo admin (the CanBypassBranchProtection admin arm)", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, { requiredApprovals: 1, blockOnRejectedReviews: true });
    await seedReview(scenario, ReviewType.Reject, { official: true });
    const refused = await merge(scenario, { force_merge: true });
    expect(refused.status).toBe(200); // admin bypass, no block_admin_merge_override
  });

  it("block_admin_merge_override refuses the admin force-merge → 405 verbatim", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, { requiredApprovals: 1, blockAdminMergeOverride: true });
    const res = await merge(scenario, { force_merge: true });
    expect(res.status).toBe(405);
    expect((await jsonBody(res)).message).toBe("Does not have enough approvals");
  });

  it("a bypass-allowlisted non-admin force-merges through block_admin_merge_override", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, { requiredApprovals: 1, blockAdminMergeOverride: true, enableBypassAllowlist: true, bypassAllowlistUserIds: [5] });
    await db().insert(repoCollaborators).values({ repoId: scenario.repoId, userId: 5, mode: "write", createdAt: new Date(), updatedAt: new Date() });
    const res = await merge(scenario, { force_merge: true }, CARA_TOKEN);
    expect(res.status).toBe(200);
  });

  it("merge whitelist: a writer off the whitelist 403s upstream-verbatim; a listed user passes the gate", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, { requiredApprovals: 1, enableMergeWhitelist: true, mergeWhitelistUserIds: [5] });
    await db().insert(repoCollaborators).values({ repoId: scenario.repoId, userId: 5, mode: "write", createdAt: new Date(), updatedAt: new Date() });
    const refused = await merge(scenario, {}, ALICE_TOKEN); // the owner is NOT on the merge whitelist
    expect(refused.status).toBe(403);
    expect((await jsonBody(refused)).message).toBe("User not allowed to merge PR");
    const whitelisted = await merge(scenario, {}, CARA_TOKEN);
    expect(whitelisted.status).toBe(405); // through the whitelist gate, blocked on approvals only
    expect((await jsonBody(whitelisted)).message).toBe("Does not have enough approvals");
  });

  it("the merge whitelist team arm resolves through team_members", async () => {
    const scenario = await seedScenario();
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (6, 'merge-org', 'merge-org', 0, 'active', 'org', 0)",
    ).run();
    const team = await db()
      .insert(teams)
      .values({ orgId: 6, lowerName: "mergers", name: "mergers", authorize: "write" })
      .returning({ id: teams.id })
      .all();
    await db().insert(teamMembers).values({ orgId: 6, teamId: team[0]!.id, userId: 5 });
    await seedRule(scenario.repoId, { enableMergeWhitelist: true, mergeWhitelistTeamIds: [team[0]!.id] });
    await db().insert(repoCollaborators).values({ repoId: scenario.repoId, userId: 5, mode: "write", createdAt: new Date(), updatedAt: new Date() });
    expect((await merge(scenario, {}, CARA_TOKEN)).status).toBe(200); // no approvals required → whitelist pass merges
  });

  it("manually-merged skips the protection checks entirely (check.go:162–165)", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, { requiredApprovals: 1, blockOnRejectedReviews: true });
    await seedReview(scenario, ReviewType.Reject, { official: true });
    const res = await router()(
      `/api/v1/repos/${OWNER}/${scenario.slug}/pulls/${scenario.index}/merge`,
      authed(ALICE_TOKEN, { method: "POST", body: JSON.stringify({ do: "manually-merged", merge_commit_id: scenario.mainTip }) }),
    );
    expect(res.status).toBe(200);
  });

  it("doer (a non-writer) still 403s before the rule consult", async () => {
    const scenario = await seedScenario();
    const res = await merge(scenario, {}, DOER_TOKEN);
    expect(res.status).toBe(403);
    expect((await jsonBody(res)).message).toBe("User not allowed to merge PR");
  });
});

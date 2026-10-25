/**
 * SPEC-0013 §3.4 — the head-push stale/dismiss legs (markStaleReviewsOnPush)
 * over real D1 + real engine cells: the content-change detection (both tips
 * diffed against their merge bases), MarkReviewsAsStale/NotStale
 * (models/issues/review.go:623–635), the dismiss_stale_approvals pass with
 * the fixed comment text (services/pull/review.go:362) + the num_comments
 * discipline, and the ref filters (created/deleted refs and non-head branches
 * never ride; the changed=false empty-commit case leaves reviews alone).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";

import { comments, issues, protectedBranches, pullReviews, repositories, ReviewType } from "../db/schema";
import { CommentType } from "../issues/comment-types";
import { IssuesService } from "../issues/service";
import { ZERO_OID, branchRef } from "../api/services/engine";
import { findRepositoryById } from "../api/services/repository";
import { emptyRuleConfig, serializeRuleConfig } from "./branch-protection";
import { DISMISS_STALE_MESSAGE, markStaleReviewsOnPush, PUSH_ZERO_OID, type PushRefUpdate } from "./webhooks-push";

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
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const [id, username] of [
    [1, "doer"],
    [2, "bob"],
    [4, "alice"],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (?, ?, ?, 0, 'active', 0)",
    )
      .bind(id, username, username)
      .run();
  }
});

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);

const OWNER = "alice";

/** Worker-side object hash (workerd crypto.subtle; putApiObjects re-verifies). */
async function gitObjectOid(type: string, data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header, 0);
  bytes.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

let repoSeq = 6100;

interface Scenario {
  slug: string;
  repoId: string;
  mainTip: string;
  head1: string; // the PR's reviewed tip
  head2: string; // head1 + a new file (content changed)
  head2Empty: string; // head1's tree, new commit (content unchanged)
  index: number;
  issueId: number;
}

/** One repo: main at root; feature at head1; head2 = head1 + new.txt;
 *  head2Empty = head1's tree with a new message (empty push). */
async function seedScenario(): Promise<Scenario> {
  const slug = `push${repoSeq}`;
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
  const person = { name: "seed", email: "seed@stale.invalid", time: 1761000000, tz: "+0000" };

  const readme = new TextEncoder().encode(`# ${slug}\n`);
  const readmeOid = await gitObjectOid("blob", readme);
  const rootTree = serializeTree([{ mode: "100644", name: "README.md", oid: readmeOid }]);
  const root = serializeCommit({ tree: rootTree.oid, parents: [], author: person, committer: person, message: "root\n" });

  const featTree = serializeTree([
    { mode: "100644", name: "README.md", oid: readmeOid },
    { mode: "100644", name: "feature.txt", oid: await gitObjectOid("blob", new TextEncoder().encode("one\n")) },
  ]);
  const featTreeData = featTree.data;
  const head1 = serializeCommit({ tree: featTree.oid, parents: [root.oid], author: person, committer: person, message: "one\n" });

  const extra = new TextEncoder().encode("two\n");
  const extraOid = await gitObjectOid("blob", extra);
  const head2Tree = serializeTree([
    { mode: "100644", name: "README.md", oid: readmeOid },
    { mode: "100644", name: "feature.txt", oid: await gitObjectOid("blob", new TextEncoder().encode("one\n")) },
    { mode: "100644", name: "two.txt", oid: extraOid },
  ]);
  const head2 = serializeCommit({ tree: head2Tree.oid, parents: [head1.oid], author: person, committer: person, message: "two\n" });
  const head2Empty = serializeCommit({ tree: featTree.oid, parents: [head1.oid], author: person, committer: person, message: "empty\n" });

  const put = await cell.putApiObjects([
    { oid: readmeOid, type: "blob", data: readme },
    { oid: rootTree.oid, type: "tree", data: rootTree.data },
    { oid: root.oid, type: "commit", data: root.data },
    { oid: featTree.oid, type: "tree", data: featTreeData },
    { oid: head1.oid, type: "commit", data: head1.data },
    { oid: extraOid, type: "blob", data: extra },
    { oid: head2Tree.oid, type: "tree", data: head2Tree.data },
    { oid: head2.oid, type: "commit", data: head2.data },
    { oid: head2Empty.oid, type: "commit", data: head2Empty.data },
  ]);
  if (put.tag !== "ok") throw new Error(`seed putApiObjects failed: ${put.tag}`);

  for (const [ref, oid] of [
    [branchRef("main"), root.oid],
    [branchRef("feature"), head1.oid],
  ] as const) {
    const landed = await cell.commitApiChange({ ref, expectedOldOid: ZERO_OID, newOid: oid });
    if (landed.tag !== "committed") throw new Error(`seed ref landing failed: ${ref}`);
  }

  const { issue } = await service().createPullRequest({
    repoId,
    title: "stale-able change",
    posterId: 2,
    headRepoId: repoId,
    baseBranch: "main",
    headBranch: "feature",
  });
  const headLanded = await cell.commitApiChange({ ref: `refs/pull/${issue.index}/head`, expectedOldOid: ZERO_OID, newOid: head1.oid });
  if (headLanded.tag !== "committed") throw new Error("seed pull head landing failed");

  return { slug, repoId, mainTip: root.oid, head1: head1.oid, head2: head2.oid, head2Empty: head2Empty.oid, index: issue.index, issueId: issue.id };
}

async function seedRule(repoId: string, dismissStaleApprovals: boolean): Promise<void> {
  await db().insert(protectedBranches).values({
    repoId,
    ruleName: "main",
    priority: 0,
    rules: serializeRuleConfig({ ...emptyRuleConfig(), dismissStaleApprovals }),
    createdAt: new Date("2026-03-01T00:00:00Z"),
    updatedAt: new Date("2026-03-01T00:00:00Z"),
  });
}

async function seedApproval(scenario: Scenario, reviewerId: number, commitId: string, flags: { official?: boolean; dismissed?: boolean } = {}): Promise<void> {
  await db().insert(pullReviews).values({
    type: ReviewType.Approve,
    reviewerId,
    issueId: scenario.issueId,
    content: "",
    official: flags.official ?? true,
    stale: false,
    dismissed: flags.dismissed ?? false,
    commitId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

const pairOf = async (repoId: string) => (await findRepositoryById(env.DB, repoId))!;

/**
 * Lands the push the delta describes — the engine hands onPush APPLIED
 * updates, so the ref must really sit at `next` (readDiff resolves raw oids
 * only when they are reachable from a ref, like production's post-finalize
 * state).
 */
async function pushFeature(scenario: Scenario, from: string, to: string): Promise<void> {
  const cell = env.REPO.getByName(`${OWNER}/${scenario.slug}`);
  const landed = await cell.commitApiChange({ ref: branchRef("feature"), expectedOldOid: from, newOid: to });
  if (landed.tag !== "committed") throw new Error(`pushFeature landing failed: ${landed.tag}`);
}

describe("markStaleReviewsOnPush (SPEC-0013 §3.4, services/pull/pull.go:425–461 port)", () => {
  it("a content-changing head push stales every review, then un-stales the new-tip one", async () => {
    const scenario = await seedScenario();
    await seedApproval(scenario, 1, scenario.head1);
    await seedApproval(scenario, 2, scenario.head2); // made against the incoming tip
    await pushFeature(scenario, scenario.head1, scenario.head2);
    await markStaleReviewsOnPush(env, await pairOf(scenario.repoId), [
      { ref: "refs/heads/feature", old: scenario.head1, next: scenario.head2 },
    ]);
    const rows = await db().select().from(pullReviews).all();
    const rowOf = (reviewerId: number) => rows.find((row) => row.reviewerId === reviewerId)!;
    expect(rowOf(1).stale).toBe(true);
    expect(rowOf(2).stale).toBe(false); // MarkReviewsAsNotStale against the new tip
    expect(rowOf(1).dismissed).toBe(false); // no rule → no dismissal
  });

  it("dismiss_stale_approvals dismisses the stale approvals with the fixed comment + num_comments", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, true);
    await seedApproval(scenario, 1, scenario.head1);
    await seedApproval(scenario, 2, scenario.head2);
    const before = (await db().select().from(issues).where(eq(issues.id, scenario.issueId)).all())[0]!.numComments;
    await pushFeature(scenario, scenario.head1, scenario.head2);
    await markStaleReviewsOnPush(env, await pairOf(scenario.repoId), [
      { ref: "refs/heads/feature", old: scenario.head1, next: scenario.head2 },
    ]);
    const rows = await db().select().from(pullReviews).all();
    const rowOf = (reviewerId: number) => rows.find((row) => row.reviewerId === reviewerId)!;
    // DismissApprovalReviews (services/pull/review.go:338–380) dismisses EVERY
    // undismissed approval — including the new-tip one (its `stale` flag is
    // cleared afterwards; `dismissed` is not resurrected). A post-push
    // re-approve creates a fresh row upstream, same as here.
    expect(rowOf(1).dismissed).toBe(true);
    expect(rowOf(2).dismissed).toBe(true);
    expect(rowOf(2).stale).toBe(false);
    const dismissalComments = await db().select().from(comments).all();
    expect(dismissalComments).toHaveLength(2);
    for (const comment of dismissalComments) {
      expect(comment.type).toBe(CommentType.DismissReview);
      expect(comment.content).toBe(DISMISS_STALE_MESSAGE);
    }
    const after = (await db().select().from(issues).where(eq(issues.id, scenario.issueId)).all())[0]!.numComments;
    expect(after).toBe(before + 2);
  });

  it("a rule without dismiss_stale_approvals stales but never dismisses", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, false);
    await seedApproval(scenario, 1, scenario.head1);
    await pushFeature(scenario, scenario.head1, scenario.head2);
    await markStaleReviewsOnPush(env, await pairOf(scenario.repoId), [
      { ref: "refs/heads/feature", old: scenario.head1, next: scenario.head2 },
    ]);
    const row = (await db().select().from(pullReviews).all())[0]!;
    expect(row.stale).toBe(true);
    expect(row.dismissed).toBe(false);
    expect(await db().select().from(comments).all()).toHaveLength(0);
  });

  it("a content-preserving push (same tree) leaves the reviews untouched", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, true);
    await seedApproval(scenario, 1, scenario.head1);
    await pushFeature(scenario, scenario.head1, scenario.head2Empty);
    await markStaleReviewsOnPush(env, await pairOf(scenario.repoId), [
      { ref: "refs/heads/feature", old: scenario.head1, next: scenario.head2Empty },
    ]);
    const row = (await db().select().from(pullReviews).all())[0]!;
    expect(row.stale).toBe(false);
    expect(row.dismissed).toBe(false);
  });

  it("created/deleted refs and non-head branches never ride; PRs on other branches stay silent", async () => {
    const scenario = await seedScenario();
    await seedRule(scenario.repoId, true);
    await seedApproval(scenario, 1, scenario.head1);
    const pair = await pairOf(scenario.repoId);
    const updates: PushRefUpdate[] = [
      { ref: "refs/heads/feature", old: PUSH_ZERO_OID, next: scenario.head2 }, // created
      { ref: "refs/heads/feature", old: scenario.head1, next: PUSH_ZERO_OID }, // deleted
      { ref: "refs/heads/unrelated", old: scenario.mainTip, next: scenario.head2 }, // not a PR head
      { ref: "refs/pull/9/head", old: scenario.head1, next: scenario.head2 }, // PR ref
    ];
    await markStaleReviewsOnPush(env, pair, updates);
    const row = (await db().select().from(pullReviews).all())[0]!;
    expect(row.stale).toBe(false);
    expect(row.dismissed).toBe(false);
  });
});

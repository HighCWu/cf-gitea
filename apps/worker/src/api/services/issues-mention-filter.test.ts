/**
 * The issue-list MENTION filter on real D1 — the service half of the search
 * filters the mentions-carrier wave staged (1622f90: "the search filters —
 * the store now exists for the search owner").
 *
 * Upstream pin fc4936884584a41931906553d96c2601d750e6ef: the mention
 * condition is applyMentionedCondition (models/issues/issue_search.go:
 * 395-399) — INNER JOIN issue_user ON issue.id = issue_user.issue_id AND
 * is_mentioned = true AND uid = mentionedID, applied only when the id is
 * > 0 (:245-247). The uid is the MENTIONED user — who was @-referenced —
 * never the mention author. The condition is unit-agnostic (the carrier
 * writes on PR creates too) and composes with the other filters through
 * the session's AND chain. This suite pins exactly that row set through
 * listRepoIssues' `mentionedId` filter (the id-IN-subquery adaptation of
 * the join — the assignee arm's shape); the route wiring rides the same
 * IssueListFilters seam in routes/issues.ts + ui/pages/issues-search-aux.
 *
 * The repo-list twin, UserMentionedRepoCond (models/repo/repo_list.go:
 * 254-269 — mentioned-in PUBLIC repos), has NO consumer surface in our
 * tree: its only caller is issuePullAccessibleRepoCond
 * (issue_search.go:342-371), the web dashboard's accessible-repo condition
 * — a surface this backend does not carry (the official Gitea web UI
 * frontend talks to the API). STAGED with that exact gap; nothing to wire.
 */

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { issueUsers, issues, repositories } from "../../db/schema";
import { listRepoIssues } from "./issues";

const T0 = new Date("2026-02-03T04:05:06Z");
const REPO = "repo-1";
const BOB_ID = 2;
const CAROL_ID = 3;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["issue_user", "issues", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, status, created_at) VALUES (1, 'alice', 'alice', 'active', unixepoch())",
  ).run();
  for (const [id, name] of [
    [BOB_ID, "bob"],
    [CAROL_ID, "carol"],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO users (id, username, username_lower, status, created_at) VALUES (${id}, '${name}', '${name}', 'active', unixepoch())`,
    ).run();
  }
  await drizzle(env.DB).insert(repositories).values({
    id: REPO,
    storageKey: `r_${REPO}`,
    ownerNamespace: "alice",
    ownerId: 1,
    slug: REPO,
    visibility: "public",
    createdAt: T0,
  });
  // #1 plain issue mentioning bob; #2 no mentions; #3 mentioning bob AND
  // carol; #4 a PULL mentioning bob (the condition is unit-agnostic).
  await drizzle(env.DB)
    .insert(issues)
    .values([
      { repoId: REPO, index: 1, title: "one", posterId: 1, createdAt: T0 },
      { repoId: REPO, index: 2, title: "two", posterId: 1, createdAt: T0 },
      { repoId: REPO, index: 3, title: "three", posterId: 1, createdAt: T0 },
      { repoId: REPO, index: 4, title: "four", posterId: 1, isPull: true, createdAt: T0 },
    ]);
  // The edge seeds resolve the rows' real ids — AUTOINCREMENT high-water
  // marks move between tests (DELETE FROM keeps sqlite_sequence).
  const idOf = async (index: number): Promise<number> => {
    const row = await drizzle(env.DB).select({ id: issues.id }).from(issues).where(eq(issues.index, index)).get();
    if (row === undefined) throw new Error(`issue #${index} seed missing`);
    return row.id;
  };
  // The carrier's exact row shape (UpdateIssueUsersByMentions): the
  // (user_id, issue_id) pair with is_mentioned flipped — #2 carries alice's
  // READ-STATE-only row (is_mentioned=false, the staged mark-read arm's
  // shape) to pin that the flag alone decides the mention set.
  await drizzle(env.DB).insert(issueUsers).values([
    { userId: BOB_ID, issueId: await idOf(1), isMentioned: true },
    { userId: BOB_ID, issueId: await idOf(3), isMentioned: true },
    { userId: CAROL_ID, issueId: await idOf(3), isMentioned: true },
    { userId: BOB_ID, issueId: await idOf(4), isMentioned: true },
    { userId: 1, issueId: await idOf(2), isMentioned: false },
  ]);
});

const list = async (mentionedId: number, extra: Record<string, unknown> = {}) =>
  listRepoIssues(env.DB, REPO, {
    isClosed: null,
    isPull: null,
    keyword: "",
    labelIds: [],
    milestoneIds: [],
    since: null,
    before: null,
    mentionedId,
    page: 1,
    limit: 50,
    ...extra,
  });

describe("listRepoIssues mentionedId — applyMentionedCondition (issue_search.go:395-399)", () => {
  it("returns exactly the issues carrying the user's is_mentioned row (the uid is the mentioned user)", async () => {
    const bob = await list(BOB_ID);
    expect(bob.total).toBe(3);
    expect(bob.items.map((i) => i.index).sort()).toEqual([1, 3, 4]);
    const carol = await list(CAROL_ID);
    expect(carol.total).toBe(1);
    expect(carol.items.map((i) => i.index)).toEqual([3]);
  });

  it("only is_mentioned rows match — a read-state-only row (is_mentioned=false) never enters the set", async () => {
    // Alice's row on #2 is the flag-down shape; alice still owns nothing
    // through it (GetIssueMentionIDs reads is_mentioned=true only,
    // issue_user.go:89-96).
    const alice = await list(1);
    expect(alice.total).toBe(0);
    expect(alice.items).toEqual([]);
  });

  it("is unit-agnostic: the pull surfaces too and composes with the type filter", async () => {
    const pullsOnly = await list(BOB_ID, { isPull: true });
    expect(pullsOnly.items.map((i) => i.index)).toEqual([4]);
    const issuesOnly = await list(BOB_ID, { isPull: false });
    expect(issuesOnly.items.map((i) => i.index).sort()).toEqual([1, 3]);
  });

  it("composes with the state filter (AND chain like upstream's session joins)", async () => {
    await drizzle(env.DB).update(issues).set({ isClosed: true }).where(eq(issues.index, 3));
    const closed = await list(BOB_ID, { isClosed: true });
    expect(closed.items.map((i) => i.index)).toEqual([3]);
    const open = await list(BOB_ID, { isClosed: false });
    expect(open.items.map((i) => i.index).sort()).toEqual([1, 4]);
  });

  it("an id with no rows answers the empty set (and stays a valid page)", async () => {
    const page = await list(CAROL_ID + 100);
    expect(page.total).toBe(0);
    expect(page.items).toEqual([]);
  });

  it("omitting the filter keeps the unfiltered list (the undefined arm)", async () => {
    const page = await listRepoIssues(env.DB, REPO, {
      isClosed: null,
      isPull: null,
      keyword: "",
      labelIds: [],
      milestoneIds: [],
      since: null,
      before: null,
      page: 1,
      limit: 50,
    });
    expect(page.total).toBe(4);
  });
});

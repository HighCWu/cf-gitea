/**
 * The issue-list ASSIGNEE filter on real D1 — the service half of the E5
 * `assigned_by` drift (parity review: "`assigned_by` … always empty set —
 * upstream filters the indexer by assignee/mention ids … ours maps both to
 * 'match nothing' even though the assignee table landed").
 *
 * Upstream pin fc4936884584a41931906553d96c2601d750e6ef: ListIssues resolves
 * `assigned_by` through getUserIDForFilter (routers/api/v1/repo/issue.go:
 * 398-406, 469-479 — unknown login = 404, route-side) and the indexer's DB
 * condition is applyAssigneeCondition (models/issues/issue_search.go:373-383):
 * the numeric arm INNER JOINs issue_assignees ON issue.id AND assignee_id = ?.
 * The condition is unit-agnostic — pulls carry assignees the same way — and
 * composes with the other filters through the session's AND chain. This suite
 * pins exactly that row set through listRepoIssues' `assigneeId` filter (the
 * route wiring is the orchestrator follow-on — routes/issues.ts is another
 * unit's in-flight file).
 *
 * `mentioned_by` has its own suite now — the issue_user carrier landed
 * (1622f90) and the search filters wire it: issues-mention-filter.test.ts
 * pins the same seam shape for applyMentionedCondition (issue_search.go:
 * 395-399).
 */

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { issueAssignees, issues, repositories } from "../../db/schema";
import { listRepoIssues } from "./issues";

const T0 = new Date("2026-02-03T04:05:06Z");
const REPO = "repo-1";
const BOB_ID = 2;
const CAROL_ID = 3;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["issue_assignees", "issues", "repositories", "users"]) {
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
  // #1 plain issue assigned to bob; #2 unassigned; #3 assigned to bob AND
  // carol; #4 a PULL assigned to bob (the condition is unit-agnostic).
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
  await drizzle(env.DB).insert(issueAssignees).values([
    { issueId: await idOf(1), assigneeId: BOB_ID },
    { issueId: await idOf(3), assigneeId: BOB_ID },
    { issueId: await idOf(3), assigneeId: CAROL_ID },
    { issueId: await idOf(4), assigneeId: BOB_ID },
  ]);
});

const list = async (assigneeId: number, extra: Record<string, unknown> = {}) =>
  listRepoIssues(env.DB, REPO, {
    isClosed: null,
    isPull: null,
    keyword: "",
    labelIds: [],
    milestoneIds: [],
    since: null,
    before: null,
    assigneeId,
    page: 1,
    limit: 50,
    ...extra,
  });

describe("listRepoIssues assigneeId — applyAssigneeCondition's numeric arm (issue_search.go:373-383)", () => {
  it("returns exactly the issues carrying the user's issue_assignees row", async () => {
    const page = await list(BOB_ID);
    expect(page.total).toBe(3);
    expect(page.items.map((i) => i.index).sort()).toEqual([1, 3, 4]);
    const carol = await list(CAROL_ID);
    expect(carol.total).toBe(1);
    expect(carol.items.map((i) => i.index)).toEqual([3]);
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

  it("an id with no edges answers the empty set (and stays a valid page)", async () => {
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

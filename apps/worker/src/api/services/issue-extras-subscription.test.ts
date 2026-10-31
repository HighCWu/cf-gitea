/**
 * checkIssueSubscription's repo-watch fallback is MODE-aware — the focused
 * service suite for the mode-awareness tail (the route surface lives in
 * tier2-extras.test.ts, another unit's file).
 *
 * Upstream pin fc4936884584a41931906553d96c2601d750e6ef — CheckIssueWatch
 * (models/issues/issue_watch.go:73-89): an explicit `issue_watch` row wins
 * verbatim (:78-80); the absence reads the REPO watch through `GetWatch`
 * (models/repo/watch.go:57-69 — the absent row is the DUMMY, mode None with
 * every include true, "the dummy record must mirror the column defaults")
 * and subscribes only when `IsWatchModeWatching(w.Mode)` (watch.go:104-106,
 * mode ∉ {None, Dont}) AND the issue's unit include holds
 * (`util.Iif(issue.IsPull, w.IncludePullRequests, w.IncludeIssues)`,
 * issue_watch.go:85). The pre-mode port probed ROW EXISTENCE, so a
 * persisted Dont row — the ignore/mute state the subscription routes land
 * (Auto-unwatch, watch.go:164-165) — wrongly answered "subscribed". The
 * final participants fallback (:88) rides the second describe; the carrier
 * wave (issue_user, migration 0057) ported it and the pin reads NO mention
 * arm there — is_mentioned never subscribes through CheckIssueWatch.
 */

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { comments, issueSubscriptions, issues, repositories, repoWatchers, users } from "../../db/schema";
import { checkIssueSubscription } from "./issue-extras";
import { WatchMode } from "./repo-watchers";

const T0 = new Date("2026-02-03T04:05:06Z");
const REPO = "repo-1";
const USER_ID = 7;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["issue_subscriptions", "repo_watchers", "comments", "issues", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

/** One repo; one plain issue (#1) and one pull (#2) with resolved row ids
 *  (AUTOINCREMENT high-water marks move between tests). */
async function seedIssueFixture(): Promise<{ issueId: number; pullId: number }> {
  await drizzle(env.DB).insert(repositories).values({
    id: REPO,
    storageKey: `r_${REPO}`,
    ownerNamespace: "alice",
    ownerId: 1,
    slug: REPO,
    visibility: "public",
    createdAt: T0,
  });
  await drizzle(env.DB).insert(issues).values([
    { repoId: REPO, index: 1, title: "plain issue", posterId: 1, isPull: false, createdAt: T0 },
    { repoId: REPO, index: 2, title: "the pull", posterId: 1, isPull: true, createdAt: T0 },
  ]);
  const issueId = (
    await drizzle(env.DB).select({ id: issues.id }).from(issues).where(eq(issues.index, 1)).get()
  )!.id;
  const pullId = (
    await drizzle(env.DB).select({ id: issues.id }).from(issues).where(eq(issues.index, 2)).get()
  )!.id;
  return { issueId, pullId };
}

const check = async (issueId: number, isPull: boolean): Promise<boolean> =>
  checkIssueSubscription(env.DB, USER_ID, { id: issueId, repoId: REPO, isPull, posterId: 1 });

describe("checkIssueSubscription — the mode-aware repo-watch fallback (issue_watch.go:73-89)", () => {
  it("an explicit issue_subscriptions row wins verbatim — even against a Dont repo watch (:78-80)", async () => {
    const { issueId } = await seedIssueFixture();
    await drizzle(env.DB)
      .insert(repoWatchers)
      .values({ repoId: REPO, userId: USER_ID, mode: WatchMode.Dont, createdAt: T0 });
    await drizzle(env.DB)
      .insert(issueSubscriptions)
      .values({ userId: USER_ID, issueId, isWatching: true, createdAt: T0, updatedAt: T0 });
    expect(await check(issueId, false)).toBe(true);
  });

  it("an explicit is_watching=false row answers false even with a Normal repo watch", async () => {
    const { issueId } = await seedIssueFixture();
    await drizzle(env.DB)
      .insert(repoWatchers)
      .values({ repoId: REPO, userId: USER_ID, mode: WatchMode.Normal, createdAt: T0 });
    await drizzle(env.DB)
      .insert(issueSubscriptions)
      .values({ userId: USER_ID, issueId, isWatching: false, createdAt: T0, updatedAt: T0 });
    expect(await check(issueId, false)).toBe(false);
  });

  it("no rows at all answers false — the GetWatch dummy is mode None (watch.go:62-67)", async () => {
    const { issueId } = await seedIssueFixture();
    expect(await check(issueId, false)).toBe(false);
  });

  it("a persisted DONT row does NOT subscribe — the dummy-mirror read, not row existence (watch.go:104-106)", async () => {
    const { issueId } = await seedIssueFixture();
    await drizzle(env.DB)
      .insert(repoWatchers)
      .values({ repoId: REPO, userId: USER_ID, mode: WatchMode.Dont, createdAt: T0 });
    expect(await check(issueId, false)).toBe(false);
    expect(await check(issueId, true)).toBe(false);
  });

  it("Normal and Auto rows subscribe to both units (IsWatchModeWatching)", async () => {
    const { issueId, pullId } = await seedIssueFixture();
    await drizzle(env.DB)
      .insert(repoWatchers)
      .values({ repoId: REPO, userId: USER_ID, mode: WatchMode.Normal, createdAt: T0 });
    expect(await check(issueId, false)).toBe(true);
    expect(await check(pullId, true)).toBe(true);

    await drizzle(env.DB)
      .update(repoWatchers)
      .set({ mode: WatchMode.Auto })
      .where(eq(repoWatchers.repoId, REPO));
    expect(await check(issueId, false)).toBe(true);
    expect(await check(pullId, true)).toBe(true);
  });

  it("a CUSTOM row subscribes per its picked includes — issues yes / pulls no (:85)", async () => {
    const { issueId, pullId } = await seedIssueFixture();
    await drizzle(env.DB).insert(repoWatchers).values({
      repoId: REPO,
      userId: USER_ID,
      mode: WatchMode.Custom,
      includeIssues: true,
      includePullRequests: false,
      createdAt: T0,
    });
    expect(await check(issueId, false)).toBe(true);
    expect(await check(pullId, true)).toBe(false);
  });

  it("the mirrored CUSTOM row — pulls yes / issues no (:85)", async () => {
    const { issueId, pullId } = await seedIssueFixture();
    await drizzle(env.DB).insert(repoWatchers).values({
      repoId: REPO,
      userId: USER_ID,
      mode: WatchMode.Custom,
      includeIssues: false,
      includePullRequests: true,
      createdAt: T0,
    });
    expect(await check(issueId, false)).toBe(false);
    expect(await check(pullId, true)).toBe(true);
  });

  it("a Custom row with EVERY include off subscribes to neither unit", async () => {
    const { issueId, pullId } = await seedIssueFixture();
    await drizzle(env.DB).insert(repoWatchers).values({
      repoId: REPO,
      userId: USER_ID,
      mode: WatchMode.Custom,
      includeIssues: false,
      includePullRequests: false,
      includeReleases: false,
      createdAt: T0,
    });
    expect(await check(issueId, false)).toBe(false);
    expect(await check(pullId, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The participants fallback (issue_watch.go:88 → IsUserParticipantsOfIssue,
// issue.go:631-636 → GetParticipantIDsByIssue, issue.go:647-668) — the arm
// the carrier wave ported. NOTE the pin consults NO mention arm here: the
// issue_user is_mentioned rows never subscribe anyone through this read.
// ---------------------------------------------------------------------------

describe("checkIssueSubscription — the participants fallback (issue_watch.go:88, issue.go:647-668)", () => {
  /** One active user row (the commenters below need the INNER JOIN to
   *  resolve); `status` overrides for the prohibit arms. */
  async function seedUser(id: number, status: "active" | "prohibited" = "active"): Promise<void> {
    await drizzle(env.DB).insert(users).values({
      id,
      username: `user${id}`,
      usernameLower: `user${id}`,
      email: `user${id}@example.com`,
      status,
      createdAt: T0,
    });
  }

  async function seedComment(issueId: number, posterId: number, type: number): Promise<void> {
    await drizzle(env.DB)
      .insert(comments)
      .values({ type, posterId, issueId, content: "", createdAt: T0, updatedAt: T0 });
  }

  it("the poster is a participant with zero comments — the unconditional append (issue.go:664-666)", async () => {
    const { issueId } = await seedIssueFixture();
    expect(await checkIssueSubscription(env.DB, 1, { id: issueId, repoId: REPO, isPull: false, posterId: 1 })).toBe(
      true,
    );
  });

  it("the poster seat skips the active filter (the append sits OUTSIDE the query's active arm)", async () => {
    const { issueId } = await seedIssueFixture();
    await seedUser(1, "prohibited");
    expect(await checkIssueSubscription(env.DB, 1, { id: issueId, repoId: REPO, isPull: false, posterId: 1 })).toBe(
      true,
    );
  });

  it("a plain-comment poster participates (:650 the CommentTypeComment arm)", async () => {
    const { issueId } = await seedIssueFixture();
    await seedUser(USER_ID);
    await seedComment(issueId, USER_ID, 0); // CommentType.Comment
    expect(await check(issueId, false)).toBe(true);
  });

  it("code-comment (21) and review (22) posters participate too (:650 the in(?,?,?) set)", async () => {
    const { issueId } = await seedIssueFixture();
    await seedUser(21);
    await seedComment(issueId, 21, 21); // CommentType.Code
    expect(await checkIssueSubscription(env.DB, 21, { id: issueId, repoId: REPO, isPull: false, posterId: 1 })).toBe(
      true,
    );
    await seedUser(22);
    await seedComment(issueId, 22, 22); // CommentType.Review
    expect(await checkIssueSubscription(env.DB, 22, { id: issueId, repoId: REPO, isPull: false, posterId: 1 })).toBe(
      true,
    );
  });

  it("system-comment posters do NOT participate — a close (type 2) is not a participant comment", async () => {
    const { issueId } = await seedIssueFixture();
    await seedUser(USER_ID);
    await seedComment(issueId, USER_ID, 2); // CommentType.Close — outside the in(?,?,?) set
    expect(await check(issueId, false)).toBe(false);
  });

  it("a login-prohibited commenter does NOT participate (issue.go:653 the prohibit_login arm)", async () => {
    const { issueId } = await seedIssueFixture();
    await seedUser(USER_ID, "prohibited");
    await seedComment(issueId, USER_ID, 0);
    expect(await check(issueId, false)).toBe(false);
  });

  it("a commented participant answers true over a Dont repo watch — the fallback runs after the watch read (:84-88)", async () => {
    const { issueId } = await seedIssueFixture();
    await seedUser(USER_ID);
    await seedComment(issueId, USER_ID, 0);
    await drizzle(env.DB)
      .insert(repoWatchers)
      .values({ repoId: REPO, userId: USER_ID, mode: WatchMode.Dont, createdAt: T0 });
    expect(await check(issueId, false)).toBe(true);
  });
});

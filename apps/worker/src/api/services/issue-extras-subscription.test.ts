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
 * (Auto-unwatch, watch.go:164-165) — wrongly answered "subscribed".
 */

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { issueSubscriptions, issues, repositories, repoWatchers } from "../../db/schema";
import { checkIssueSubscription } from "./issue-extras";
import { WatchMode } from "./repo-watchers";

const T0 = new Date("2026-02-03T04:05:06Z");
const REPO = "repo-1";
const USER_ID = 7;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["issue_subscriptions", "repo_watchers", "issues", "repositories", "users"]) {
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
  checkIssueSubscription(env.DB, USER_ID, { id: issueId, repoId: REPO, isPull });

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

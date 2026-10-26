/**
 * The notification-subscriptions tails' DEFERRED MATRIX (wave-109
 * wave-polish-subscriptions-tails — pages/notification-subscriptions.tsx,
 * the ec07fb6-era two-stage module).
 *
 * ## MOUNT VERDICT (verified first, per the wave brief): NOT MOUNTED
 *
 * `parseUiRoute`'s notifications branch (src/ui/index.ts, the wave-10
 * family) claims only the `/notifications/{new,status,purge}` tails;
 * `subscriptions`/`watching` fall through to `return null` → the engine
 * answers, exactly upstream's unregistered-route 404 (the branch's own
 * comment: "The deeper tails (`subscriptions`, `watching`) are not in this
 * slice and stay unclaimed"). There is no `uiRouter` arm for either tail.
 * Upstream's arms are GET-only (web.go:1786-1787: `user.
 * NotificationSubscriptions`, `user.NotificationWatching` inside the
 * reqSignIn `/notifications` group) — no POST subscribe/unsubscribe route
 * exists at this level, so there are no write gates or cross-origin 403
 * arms to pin here.
 *
 * Per the deferred-matrix rule for unmounted modules, THIS FILE drives the
 * module's EXPORTED SEAMS directly (loaders + render + parsers) on real D1
 * over real bindings — the committed module test's discipline — and pins
 * the PARSE-CLAIM POSTURE the mount wave will replace: the claim pins at
 * the bottom assert today's `null`/`false` and carry the handoff recipe;
 * the wiring wave rewrites that one block to the mounted families.
 *
 * ADDITIVE over the committed notification-subscriptions.test.ts (grep'd
 * first): that file owns the predicate arms in isolation, the readGrant
 * pair, the state/type/label filters, the oldest/mostcomment/latest sorts,
 * the page-99 clamp, the watching keyword/single-pair arms, the
 * archived/fork/topic tri-states, the watching time+alphabetical sorts and
 * both arms' base DOM. THIS FILE adds only what that posture cannot reach:
 *
 *   - the explicit-unsubscribe EXCLUSION arms crossed against the OTHER
 *     predicate arms (repo watcher / past commenter / poster each muted by
 *     an `is_watching = 0` row — the NOT EXISTS prefix beats every arm);
 *   - the milestone-aware due-date sort pair (the effectiveDue CASE:
 *     issue-deadline-only, milestone-deadline-only via the correlated
 *     subquery, both → min, neither → the far-future sentinel) plus the
 *     recentupdate/leastupdate/leastcomment orders;
 *   - the lastEventAt fallback chain (closedAt → updatedAt for closed
 *     rows) asserted as unix values, the `?page` floor arms (junk/0 → 1)
 *     and the dangling-milestone enrichment null;
 *   - the PR state-machine render extensions (open green / WIP draft /
 *     closed red / merged purple) and the mirrored-import row's posterless
 *     event line, the zero-comment trailing absence, the label-badge href
 *     reset and the pager's filter-carrying hrefs (synthetic data — the
 *     render is pure);
 *   - the watching tails: leastupdate, the mirror/template/private
 *     tri-states, the comma-separated keyword arm, the past-the-end page
 *     (NO clamp on this arm — empty list + the Newer-only pager, the landed
 *     compare-page convention) and the orgPrivate "Internal" label;
 *   - the claim pins (route level): today's unclaimed posture for both
 *     tails, parser AND handlesUiRoute.
 *
 * ## DISCLOSED RED (real bug found — STOP + escalate, per the wave brief)
 *
 * ONE test below is RED against the landed module:
 * `EventLine`'s verb ternary (notification-subscriptions.tsx:871) checks
 * `isClosed` FIRST, so a merged PR — always closed: upstream merging runs
 * `issue_service.CloseIssue` (services/pull/pull.go:642/682/714) — renders
 * "closed {time} by {poster}" and the `merged` branch is reachable only in
 * the `!isClosed && hasMerged` state that no real flow produces. Upstream
 * `GetLastEventLabel` (models/issues/issue.go:460-468) nests the
 * `HasMerged` check INSIDE `IsClosed` and renders `repo.pulls.merged_by`
 * ("merged {time} by {poster}") for exactly those rows — which the module
 * header itself promises ("the issues-list EventLine literals PLUS the
 * merged arm … whose merged branch the landed row data already carries via
 * `pull_requests.has_merged`"). The state GLYPH orders it correctly
 * (`isClosed → hasMerged ? git-merge-purple : …`), underlining that the
 * verb ordering is the slip. The test pins the upstream-correct contract
 * and stays RED until the module fix lands (one-line reorder; the module
 * is NOT this file's ownership). Everything else in the file is green.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createRepoLabel } from "../../api/services/labels";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import {
  issueSubscriptions,
  issues,
  pullRequests,
  repoWatchers,
  repositories,
  users,
} from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { handlesUiRoute, parseUiRoute } from "../index";
import {
  loadSubscriptionsData,
  loadWatchingData,
  parseIssueSort,
  parseWatchingSort,
  renderNotificationSubscriptionsPage,
  type SubscriptionIssueItem,
  type SubscriptionsData,
} from "./notification-subscriptions";

// --- fixtures -----------------------------------------------------------------

const T0 = 1_760_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

const VIEWER = "w109wisher";
const ORIGIN = "w109origin";

/** Synthetic manifest shaped like the real Vite output (the harness
 *  fixture — deterministic, no build dependence). */
const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const asUser = (seed: { id: number; username: string }, isAdmin = false): Extract<Viewer, { kind: "user" }> => ({
  kind: "user",
  id: seed.id,
  username: seed.username.toLowerCase(),
  isAdmin,
});

/** Guard helper (the module test's style — no non-null assertions). */
function expectData<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} missing`);
  return value;
}

interface Seeded {
  viewer: { id: number; username: string };
  viewerViewer: Extract<Viewer, { kind: "user" }>;
  origin: { id: number; username: string };
  publicRepoId: string;
  privateRepoId: string;
  ownRepoId: string;
}

let seeded: Seeded | undefined;

async function seed(): Promise<Seeded> {
  if (seeded !== undefined) return seeded;
  const viewer = await seedVerifiedUser({ username: VIEWER });
  const origin = await seedVerifiedUser({ username: ORIGIN });
  const service = new RepoService(env.DB);
  const publicRepo = await service.create({ owner: { id: origin.id, usernameLower: ORIGIN }, name: "visible", isPrivate: false, status: "ready" });
  const privateRepo = await service.create({ owner: { id: origin.id, usernameLower: ORIGIN }, name: "secret", isPrivate: true, status: "ready" });
  const ownRepo = await service.create({ owner: { id: viewer.id, usernameLower: VIEWER }, name: "mine", isPrivate: false, status: "ready" });
  const db = drizzle(env.DB);
  for (const [repoId, updated] of [
    [publicRepo.id, 60],
    [privateRepo.id, 120],
    [ownRepo.id, 180],
  ] as Array<[string, number]>) {
    await db.update(repositories).set({ createdAt: at(0), updatedAt: at(updated) }).where(eq(repositories.id, repoId));
  }
  seeded = {
    viewer,
    viewerViewer: asUser(viewer),
    origin,
    publicRepoId: publicRepo.id,
    privateRepoId: privateRepo.id,
    ownRepoId: ownRepo.id,
  };
  return seeded;
}

/** The w109 viewer's issue-level subscription row (upsert — `false` is the
 *  explicit-unsubscribe arm). */
async function subscribe(issueId: number, watching: boolean): Promise<void> {
  const state = expectData(seeded, "seed");
  await drizzle(env.DB)
    .insert(issueSubscriptions)
    .values({ userId: state.viewer.id, issueId, isWatching: watching })
    .onConflictDoUpdate({
      target: [issueSubscriptions.userId, issueSubscriptions.issueId],
      set: { isWatching: watching },
    });
}

/** The w109 viewer's repo-level watch row. */
async function watchRepo(repoId: string): Promise<void> {
  const state = expectData(seeded, "seed");
  await drizzle(env.DB)
    .insert(repoWatchers)
    .values({ repoId, userId: state.viewer.id, createdAt: at(0) })
    .onConflictDoNothing();
}

function ctxFor(viewer: Extract<Viewer, { kind: "user" }>): UiContext {
  return {
    viewer,
    origin: "https://test.local",
    assets: shellAssetsFromManifest(manifest),
  };
}

/** A minimal rendered row for the pure pager-render arms (the render reads
 *  only the data object — no DB behind it). */
function fillerItem(title: string): SubscriptionIssueItem {
  return {
    issueId: 1,
    index: 1,
    title,
    isPull: false,
    isClosed: false,
    hasMerged: false,
    ownerNamespace: ORIGIN,
    slug: "visible",
    numComments: 0,
    milestone: null,
    labels: [],
    posterName: ORIGIN,
    lastEventAt: T0,
  };
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "issue_labels",
    "issue_subscriptions",
    "repo_watchers",
    "milestones",
    "pull_requests",
    "comments",
    "issues",
    "repo_settings",
    "repo_counters",
    "repo_units",
    "repo_redirects",
    "repositories",
    "personal_access_tokens",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  seeded = undefined;
});

// --- the claim pins (the mount wave's dependency) ---------------------------------

describe("w109 claim pins (the unclaimed /notifications tails — the mount wave rewrites this block)", () => {
  it("leaves subscriptions/watching unclaimed at the parser AND the handles gate today", () => {
    // The CURRENT posture (index.ts's wave-10 branch claims only
    // new/status/purge): both tails parse null → the engine's 404. When the
    // wiring wave mounts them (the module header's HANDOFF NOTE: the
    // reqSignIn group's GET arms, the loader+render recipe, the literal
    // 303-vs-clamp seam decision), THIS test flips to the mounted families:
    //   { family: "notification-subscriptions" } and
    //   { family: "notification-watching" } at the exact lowercase tails.
    expect(parseUiRoute("/notifications/subscriptions")).toBeNull();
    expect(parseUiRoute("/notifications/watching")).toBeNull();
    // Deeper tails stay engine-owned too (no per-repo subscription route
    // exists upstream in this group — web.go:1786-1787 are GET-only).
    expect(parseUiRoute("/notifications/subscriptions/extra")).toBeNull();
    expect(parseUiRoute("/notifications/watching/deeper")).toBeNull();
    // The dispatcher's two-segment gate answers the same posture.
    expect(handlesUiRoute("/notifications/subscriptions")).toBe(false);
    expect(handlesUiRoute("/notifications/watching")).toBe(false);
    // The bare mailbox arm stays claimed (the boundary the pins protect).
    expect(parseUiRoute("/notifications")).not.toBeNull();
  });
});

// --- the parsers' uncovered vocabulary ---------------------------------------------

describe("w109 parser vocabulary (the committed file pins the sibling values)", () => {
  it("parseIssueSort passes the remaining upstream orders through; junk falls to latest", () => {
    expect(parseIssueSort("recentupdate")).toBe("recentupdate");
    expect(parseIssueSort("leastupdate")).toBe("leastupdate");
    expect(parseIssueSort("leastcomment")).toBe("leastcomment");
    expect(parseIssueSort("")).toBe("latest");
  });

  it("parseWatchingSort passes the remaining landed values through; junk falls to recentupdate", () => {
    expect(parseWatchingSort("oldest")).toBe("oldest");
    expect(parseWatchingSort("leastupdate")).toBe("leastupdate");
    expect(parseWatchingSort("alphabetically")).toBe("alphabetically");
    expect(parseWatchingSort("")).toBe("recentupdate");
  });
});

// --- the subscriptions loader: exclusion + sort + stamp arms ------------------------

describe("w109 loadSubscriptionsData — the unsubscribe exclusion crossed against every arm", () => {
  it("an is_watching = 0 row excludes the issue even when a repo watch, a past comment or the poster arm would include it", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    // Three muted issues, one per competing arm; the repo watcher arm is
    // supplied repo-wide (ownRepo watch), the commenter arm by a real
    // comment, the poster arm by posting as the viewer.
    const mutedRepoWatcher = await svc.createIssue({ repoId: s.ownRepoId, title: "muted repo watcher", posterId: s.origin.id, now: at(10) });
    const mutedCommenter = await svc.createIssue({ repoId: s.ownRepoId, title: "muted commenter", posterId: s.origin.id, now: at(20) });
    const mutedPoster = await svc.createIssue({ repoId: s.ownRepoId, title: "muted poster", posterId: s.viewer.id, now: at(30) });
    const control = await svc.createIssue({ repoId: s.publicRepoId, title: "plain watched", posterId: s.origin.id, now: at(40) });

    await watchRepo(s.ownRepoId); // includes ALL three ownRepo issues…
    await subscribe(mutedRepoWatcher.id, false); // …unless muted
    await svc.addComment({ issueId: mutedCommenter.id, posterId: s.viewer.id, content: "here", now: at(21) });
    await subscribe(mutedCommenter.id, false);
    await subscribe(mutedPoster.id, false); // the poster arm, muted
    await subscribe(control.id, true);

    const data = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(""));
    // The NOT EXISTS prefix beats every disjunction arm — only the control
    // survives, and the mute is per-issue (the repo watch still carries it).
    expect(data.items.map((item) => item.title)).toEqual(["plain watched"]);
    expect(data.total).toBe(1);
  });
});

describe("w109 loadSubscriptionsData — the milestone-aware due-date CASE and the remaining orders", () => {
  it("nearduedate/farduedate sort by the effective deadline (issue vs milestone, min when both, sentinel when neither)", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const db = drizzle(env.DB);

    const issueOnly = await svc.createIssue({ repoId: s.publicRepoId, title: "issue deadline only", posterId: s.origin.id, now: at(10) });
    const milestone = await svc.createMilestone({ repoId: s.publicRepoId, name: "w109 due", deadlineAt: at(3000), now: at(0) });
    const milestoneOnly = await svc.createIssue({ repoId: s.publicRepoId, title: "milestone deadline only", posterId: s.origin.id, now: at(20), milestoneId: milestone.id });
    const both = await svc.createIssue({ repoId: s.publicRepoId, title: "both deadlines", posterId: s.origin.id, now: at(30), milestoneId: milestone.id });
    await db.update(issues).set({ deadlineAt: at(9000) }).where(eq(issues.id, both.id));
    const neither = await svc.createIssue({ repoId: s.publicRepoId, title: "no deadlines", posterId: s.origin.id, now: at(40) });
    await db.update(issues).set({ deadlineAt: at(5000) }).where(eq(issues.id, issueOnly.id));
    for (const issue of [issueOnly, milestoneOnly, both, neither]) await subscribe(issue.id, true);

    // Effective dues: milestoneOnly 3000 (the correlated milestones
    // subquery arm — the issue row's own deadline is null), both 4000 (the
    // milestone < issue min arm), issueOnly 5000 (the milestone-less arm),
    // neither the 253370764800 sentinel (both-zero arm).
    const near = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("sort=nearduedate"));
    expect(near.items.map((item) => item.title)).toEqual([
      "milestone deadline only",
      "both deadlines",
      "issue deadline only",
      "no deadlines",
    ]);
    const far = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("sort=farduedate"));
    expect(far.items.map((item) => item.title)).toEqual([
      "no deadlines",
      "issue deadline only",
      "both deadlines",
      "milestone deadline only",
    ]);
  });

  it("recentupdate/leastupdate order by updatedAt, leastcomment by the denormalized count", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const db = drizzle(env.DB);
    const stale = await svc.createIssue({ repoId: s.publicRepoId, title: "stale but late", posterId: s.origin.id, now: at(100) });
    const fresh = await svc.createIssue({ repoId: s.publicRepoId, title: "fresh but early", posterId: s.origin.id, now: at(10) });
    await db.update(issues).set({ updatedAt: at(500) }).where(eq(issues.id, stale.id));
    await db.update(issues).set({ updatedAt: at(900) }).where(eq(issues.id, fresh.id));
    await svc.addComment({ issueId: stale.id, posterId: s.origin.id, content: "one", now: at(110) });
    await svc.addComment({ issueId: stale.id, posterId: s.origin.id, content: "two", now: at(120) });
    for (const issue of [stale, fresh]) await subscribe(issue.id, true);

    const recent = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("sort=recentupdate"));
    expect(recent.items.map((item) => item.title)).toEqual(["fresh but early", "stale but late"]); // 900 > 500
    const least = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("sort=leastupdate"));
    expect(least.items.map((item) => item.title)).toEqual(["stale but late", "fresh but early"]);
    const leastComments = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("sort=leastcomment"));
    expect(leastComments.items.map((item) => item.title)).toEqual(["fresh but early", "stale but late"]); // 0 < 2
  });
});

describe("w109 loadSubscriptionsData — lastEventAt chain, page floors, dangling milestone", () => {
  it("prefers closedAt for closed rows and falls back to updatedAt when the close is unstamped", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const db = drizzle(env.DB);
    const closed = await svc.createIssue({ repoId: s.publicRepoId, title: "closed with stamp", posterId: s.origin.id, now: at(10) });
    await svc.closeIssue(closed.id, { now: at(25) });
    await subscribe(closed.id, true);

    const stamped = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(""));
    expect(expectData(stamped.items[0], "stamped row").lastEventAt).toBe(T0 + 25);

    // Unstamp the close: the chain falls to updatedAt (stamped separately
    // so the fallback value is unambiguous).
    await db.update(issues).set({ closedAt: null, updatedAt: at(80) }).where(eq(issues.id, closed.id));
    const unstamped = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(""));
    expect(expectData(unstamped.items[0], "unstamped row").lastEventAt).toBe(T0 + 80);
  });

  it("floors junk and zero pages onto page 1 (parsePageNumber before the clamp)", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    for (const [i, title] of ["first", "second"].entries()) {
      const issue = await svc.createIssue({ repoId: s.publicRepoId, title, posterId: s.origin.id, now: at(10 * (i + 1)) });
      await subscribe(issue.id, true);
    }
    for (const raw of ["junk", "0", "-3"]) {
      const data = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(`page=${raw}`));
      expect(data.page, raw).toBe(1);
      expect(data.items, raw).toHaveLength(2);
    }
  });

  it("renders a dangling milestone id as no milestone (the enrichment's null arm)", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const db = drizzle(env.DB);
    const orphan = await svc.createIssue({ repoId: s.publicRepoId, title: "orphan milestone", posterId: s.origin.id, now: at(10) });
    await db.update(issues).set({ milestoneId: 424242 }).where(eq(issues.id, orphan.id)); // no FK — the stamp lands
    await subscribe(orphan.id, true);
    const data = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(""));
    expect(expectData(data.items[0], "orphan row").milestone).toBeNull();
  });
});

// --- the render matrix: row projections ---------------------------------------------

describe("w109 render — the PR state machine extensions over loaded rows", () => {
  it("renders open-green, WIP-draft, closed-red and closed-issue glyphs; the closed verb for closed rows", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const openPull = await svc.createPullRequest({ repoId: s.publicRepoId, title: "open pull", posterId: s.origin.id, headRepoId: s.publicRepoId, baseBranch: "main", headBranch: "feature", now: at(10) });
    const wipPull = await svc.createPullRequest({ repoId: s.publicRepoId, title: "WIP: draft pull", posterId: s.origin.id, headRepoId: s.publicRepoId, baseBranch: "main", headBranch: "wip", now: at(20) });
    const closedPull = await svc.createPullRequest({ repoId: s.publicRepoId, title: "closed pull", posterId: s.origin.id, headRepoId: s.publicRepoId, baseBranch: "main", headBranch: "gone", now: at(30) });
    await svc.closeIssue(closedPull.issue.id, { now: at(35) });
    const closedIssue = await svc.createIssue({ repoId: s.publicRepoId, title: "closed thread", posterId: s.origin.id, now: at(40) });
    await svc.closeIssue(closedIssue.id, { now: at(45) });
    for (const issue of [openPull.issue, wipPull.issue, closedPull.issue, closedIssue]) await subscribe(issue.id, true);

    const data = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(""));
    const html = renderNotificationSubscriptionsPage(ctxFor(s.viewerViewer), data);
    // shared/issueicon.tmpl's full machine, exact class strings (the
    // issues-list matrix idiom).
    expect(html).toContain('class="svg octicon-git-pull-request tw-text-green"');
    expect(html).toContain('class="svg octicon-git-pull-request-draft tw-text-text-light"');
    expect(html).toContain('class="svg octicon-git-pull-request-closed tw-text-red"');
    expect(html).toContain('class="svg octicon-issue-closed tw-text-red"');
    // The closed verb (upstream repo.issues.closed_by — correct today for
    // plain rows; the merged arm is the separate RED test below). The verb
    // is anchored to the EventLine div (its class string is unique — the
    // icon wrapper carries the tw-mt suffix and the tabs are anchors), so a
    // title containing the word cannot satisfy the pin.
    expect(html).toContain('<div class="flex-text-inline">closed ');
  });

  it("RED (escalated real bug): a merged PR's event line reads 'merged {time} by {poster}'", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const db = drizzle(env.DB);
    const merged = await svc.createPullRequest({ repoId: s.publicRepoId, title: "merged pull", posterId: s.origin.id, headRepoId: s.publicRepoId, baseBranch: "main", headBranch: "done", now: at(10) });
    // The landed merge convention (issues-list.matrix's seedPullRepo):
    // merging CLOSES the issue and stamps has_merged.
    await svc.closeIssue(merged.issue.id, { now: at(20) });
    await db.update(pullRequests).set({ hasMerged: true }).where(eq(pullRequests.issueId, merged.issue.id));
    await subscribe(merged.issue.id, true);

    const data = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(""));
    const html = renderNotificationSubscriptionsPage(ctxFor(s.viewerViewer), data);
    // The glyph already orders correctly (merged-inside-closed → purple).
    expect(html).toContain('class="svg octicon-git-merge tw-text-purple"');
    // THE RED ASSERTION — upstream GetLastEventLabel (issue.go:460-468)
    // nests HasMerged inside IsClosed and emits repo.pulls.merged_by for
    // every merged PR; the landed EventLine checks isClosed first, so this
    // renders the "closed" verb today and the merged branch is dead code
    // (merge ⇒ closed — services/pull/pull.go's CloseIssue). Anchored to
    // the EventLine div so the fixture title cannot satisfy it. Disclosed
    // to the orchestrator; the module fix is a one-line verb reorder.
    expect(html).toContain('<div class="flex-text-inline">merged ');
  });

  it("renders the mirrored-import row without the 'by' tail (no poster row)", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const db = drizzle(env.DB);
    const mirrored = await svc.createIssue({ repoId: s.publicRepoId, title: "mirrored import", posterId: s.origin.id, now: at(10) });
    await db.update(issues).set({ posterId: null }).where(eq(issues.id, mirrored.id)); // poster_id is nullable
    await subscribe(mirrored.id, true);

    const data = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(""));
    expect(expectData(data.items[0], "mirrored row").posterName).toBeNull();
    const html = renderNotificationSubscriptionsPage(ctxFor(s.viewerViewer), data);
    expect(html).toContain('<div class="flex-text-inline">opened ');
    expect(html).not.toContain("by <a"); // no poster anchor anywhere on the page
  });

  it("resets every filter but the id on label-badge hrefs and drops the trailing block at zero comments", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const bug = await createRepoLabel(env.DB, s.publicRepoId, {
      name: "bug",
      exclusive: false,
      color: "#ee0701",
      description: "Something is broken",
      isArchived: false,
      now: at(0),
    });
    const quiet = await svc.createIssue({ repoId: s.publicRepoId, title: "quiet labeled", posterId: s.origin.id, labelIds: [bug.id], now: at(10) });
    await subscribe(quiet.id, true);

    const data = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(""));
    const html = renderNotificationSubscriptionsPage(ctxFor(s.viewerViewer), data);
    // The badge href resets state/type/sort to the defaults, keeping only
    // the label id (issuelist.tmpl:31's empty dashboard root echo).
    expect(html).toContain(`href="/notifications/subscriptions?labels=${bug.id}"`);
    // Zero comments → no item-trailing block at all.
    expect(html).not.toContain('class="item-trailing"');
  });

  it("carries the full filter set on the pager hrefs (synthetic data — the render is pure)", () => {
    const ctx = ctxFor({ kind: "user", id: 1, username: VIEWER, isAdmin: false });
    const filters: Omit<SubscriptionsData, "status" | "page" | "total" | "items"> = {
      state: "open",
      issueType: "pulls",
      sort: "oldest",
      labels: [5],
    };
    const page1: SubscriptionsData = { status: 1, ...filters, page: 1, total: 25, items: [fillerItem("pager filler")] };
    const html1 = renderNotificationSubscriptionsPage(ctx, page1);
    expect(html1).toContain(
      'href="/notifications/subscriptions?sort=oldest&amp;state=open&amp;issueType=pulls&amp;labels=5&amp;page=2"',
    );
    expect(html1).toContain(">Older</span>");
    expect(html1).not.toContain(">Newer</span>");

    const page2: SubscriptionsData = { status: 1, ...filters, page: 2, total: 25, items: [fillerItem("pager filler")] };
    const html2 = renderNotificationSubscriptionsPage(ctx, page2);
    // Newer drops page=1 (the canonical-href convention); page 2 of 25
    // fills both pages → no Older.
    expect(html2).toContain(
      'href="/notifications/subscriptions?sort=oldest&amp;state=open&amp;issueType=pulls&amp;labels=5"',
    );
    expect(html2).toContain(">Newer</span>");
    expect(html2).not.toContain(">Older</span>");
  });
});

// --- the watching loader tails -------------------------------------------------------

describe("w109 loadWatchingData — the remaining tri-states, leastupdate, comma keyword", () => {
  it("filters mirror/template facets by equality and orders leastupdate by updatedAt", async () => {
    const s = await seed();
    const db = drizzle(env.DB);
    await watchRepo(s.publicRepoId);
    await watchRepo(s.ownRepoId);
    await db.update(repositories).set({ isMirror: true }).where(eq(repositories.id, s.publicRepoId));
    await db.update(repositories).set({ isTemplate: true }).where(eq(repositories.id, s.ownRepoId));
    await db.update(repositories).set({ updatedAt: at(30) }).where(eq(repositories.id, s.publicRepoId));

    const mirrors = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("mirror=true"));
    expect(mirrors.items.map((item) => item.repo.slug)).toEqual(["visible"]);
    const notMirrors = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("mirror=false"));
    expect(notMirrors.items.map((item) => item.repo.slug)).toEqual(["mine"]);
    const templates = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("template=true"));
    expect(templates.items.map((item) => item.repo.slug)).toEqual(["mine"]);
    const notTemplates = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("template=false"));
    expect(notTemplates.items.map((item) => item.repo.slug)).toEqual(["visible"]);

    // mine updated 180 vs visible 30 → leastupdate puts visible first.
    const least = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("sort=leastupdate"));
    expect(least.items.map((item) => item.repo.slug)).toEqual(["visible", "mine"]);
  });

  it("filters the private facet over the grant (own private repo stays visible to its owner)", async () => {
    const s = await seed();
    const db = drizzle(env.DB);
    await watchRepo(s.publicRepoId);
    await watchRepo(s.ownRepoId);
    await db.update(repositories).set({ visibility: "private" }).where(eq(repositories.id, s.ownRepoId));

    const privates = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("private=true"));
    expect(privates.items.map((item) => item.repo.slug)).toEqual(["mine"]); // the isOwner grant arm
    const publics = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("private=false"));
    expect(publics.items.map((item) => item.repo.slug)).toEqual(["visible"]);
  });

  it("matches any comma-separated keyword part (the landed repo-search arm)", async () => {
    const s = await seed();
    await watchRepo(s.publicRepoId);
    await watchRepo(s.ownRepoId);
    for (const q of ["vis,zzz", "zzz,vis", "VIS"]) {
      const data = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams(`q=${q}`));
      expect(data.items.map((item) => item.repo.slug), q).toEqual(["visible"]);
    }
  });

  it("leaves descriptions empty for repos without a settings row", async () => {
    const s = await seed();
    await watchRepo(s.ownRepoId);
    const data = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams(""));
    expect(expectData(data.items[0], "mine row").description).toBe("");
  });
});

describe("w109 loadWatchingData — the past-the-end page (NO clamp on this arm)", () => {
  it("renders the empty list under a Newer-only pager pointing one page back", async () => {
    const s = await seed();
    await watchRepo(s.publicRepoId);
    await watchRepo(s.ownRepoId);

    // Upstream has no redirect here (notification.go's watching arm) — the
    // loader honors the page and returns whatever falls in the window.
    const data = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("page=99"));
    expect(data.page).toBe(99);
    expect(data.items).toEqual([]);
    expect(data.total).toBe(2);

    // The landed pager convention (compare.matrix's beyond-range posture):
    // Newer renders whenever page > 1, pointing one page back; the empty
    // arm's no-results line renders beside it.
    const html = renderNotificationSubscriptionsPage(ctxFor(s.viewerViewer), data);
    expect(html).toContain("No matching results found.");
    expect(html).toContain('href="/notifications/watching?page=98"');
    expect(html).toContain(">Newer</span>");
    expect(html).not.toContain(">Older</span>");
  });
});

describe("w109 render — the watching row's orgPrivate label", () => {
  it("labels a public repo under a private owner as Internal for the owner-viewer", async () => {
    const s = await seed();
    const db = drizzle(env.DB);
    await watchRepo(s.publicRepoId); // origin is a public owner → no label
    await watchRepo(s.ownRepoId);
    await db.update(users).set({ visibility: "private" }).where(eq(users.id, s.viewer.id));
    // The grant still passes for the OWNER (ownerId = userId arm), so the
    // row survives to carry the label.
    const data = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams(""));
    expect(data.items.map((item) => item.repo.slug).sort()).toEqual(["mine", "visible"]);
    const mine = expectData(data.items.find((item) => item.repo.slug === "mine"), "mine row");
    expect(mine.ownerVisibility).toBe("private");

    const html = renderNotificationSubscriptionsPage(ctxFor(s.viewerViewer), data);
    expect(html).toContain("Internal"); // orgHomeLocale.repo_internal
  });
});

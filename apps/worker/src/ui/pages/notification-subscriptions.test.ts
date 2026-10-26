/**
 * The notification-subscriptions page-module tests (the repo-migrate
 * fixture discipline): the module is UNMOUNTED — both route arms are
 * index-owned (the module header's HANDOFF NOTE carries the mapping) — so
 * the tests drive the parsers, loaders, and renders DIRECTLY, on real D1 +
 * real bindings (workerd, @cloudflare/vitest-plugin).
 *
 * The subscriptions fixtures exercise every arm of the re-issued
 * applySubscribedCondition predicate in isolation (watching row /
 * explicit unsubscribe / past commenter / poster / repo watcher) plus the
 * readGrant access condition (a watched PRIVATE repo never surfaces for a
 * non-admin; the admin bypass does see it); the watching fixtures exercise
 * the keyword arm, the facet tri-states and the visibility grant.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { createRepoLabel } from "../../api/services/labels";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import {
  issueLabels,
  issueSubscriptions,
  repoSettings,
  repoWatchers,
  repositories,
} from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  loadSubscriptionsData,
  loadWatchingData,
  notificationSubscriptionsLocale,
  parseIssueSort,
  parseIssueType,
  parseLabelsFilter,
  parseOptionalBoolParam,
  parseSubscriptionsState,
  parseWatchingKeyword,
  parseWatchingSort,
  renderNotificationSubscriptionsPage,
  SUBSCRIPTIONS_PAGE_SIZE,
  WATCHING_PAGE_SIZE,
  type SubscriptionsData,
  type WatchingData,
} from "./notification-subscriptions";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_750_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

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

/** Guard helper (the repo-migrate.test.ts style — no non-null assertions,
 *  no narrowing casts). */
function expectData<T>(data: T | undefined, what: string): T {
  if (data === undefined) throw new Error(`${what} missing`);
  return data;
}

interface Seeded {
  viewer: { id: number; username: string };
  viewerViewer: Extract<Viewer, { kind: "user" }>;
  adminViewer: Extract<Viewer, { kind: "user" }>;
  origin: { id: number; username: string };
  publicRepoId: string;
  privateRepoId: string;
  ownRepoId: string;
}

let seeded: Seeded | undefined;

async function seed(): Promise<Seeded> {
  if (seeded !== undefined) return seeded;
  const viewer = await seedVerifiedUser({ username: "wisher" });
  const origin = await seedVerifiedUser({ username: "origin" });
  const service = new RepoService(env.DB);
  const publicRepo = await service.create({ owner: { id: origin.id, usernameLower: "origin" }, name: "visible", isPrivate: false, status: "ready" });
  const privateRepo = await service.create({ owner: { id: origin.id, usernameLower: "origin" }, name: "secret", isPrivate: true, status: "ready" });
  const ownRepo = await service.create({ owner: { id: viewer.id, usernameLower: "wisher" }, name: "mine", isPrivate: false, status: "ready" });
  const db = drizzle(env.DB);
  // Deterministic created/updated stamps — the watching sorts read them.
  const stamps: Array<[string, number]> = [
    [publicRepo.id, 60],
    [privateRepo.id, 120],
    [ownRepo.id, 180],
  ];
  for (const [repoId, updated] of stamps) {
    await db.update(repositories).set({ createdAt: at(0), updatedAt: at(updated) }).where(eq(repositories.id, repoId));
  }
  seeded = {
    viewer,
    viewerViewer: asUser(viewer),
    adminViewer: asUser(viewer, true),
    origin,
    publicRepoId: publicRepo.id,
    privateRepoId: privateRepo.id,
    ownRepoId: ownRepo.id,
  };
  return seeded;
}

/** The wisher's explicit issue-level subscription row (upsert — the flip to
 *  `false` is the explicit-unsubscribe arm). */
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

/** The wisher's repo-level watch row. */
async function watchRepo(repoId: string): Promise<void> {
  const state = expectData(seeded, "seed");
  await drizzle(env.DB)
    .insert(repoWatchers)
    .values({ repoId, userId: state.viewer.id, createdAt: at(0) })
    .onConflictDoNothing();
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
    // repo_counters (the issue-index allocation row) FKs repositories —
    // the repo housekeeping trio goes before the repo rows (the
    // repo-migrate.test.ts cleanup list's shape).
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

// --- the parsers ---------------------------------------------------------------

describe("query-param parsers", () => {
  it("parseSubscriptionsState: exact lowercase tri-state, everything else → all (the upstream quirk — validation is case-insensitive but every USE is case-sensitive, so other casings observably degrade to all)", () => {
    expect(parseSubscriptionsState("open")).toBe("open");
    expect(parseSubscriptionsState("closed")).toBe("closed");
    expect(parseSubscriptionsState("all")).toBe("all");
    expect(parseSubscriptionsState("CLOSED")).toBe("all");
    expect(parseSubscriptionsState("nope")).toBe("all");
    expect(parseSubscriptionsState(null)).toBe("all");
  });

  it("parseIssueType: issues/pulls only, everything else no filter", () => {
    expect(parseIssueType("issues")).toBe("issues");
    expect(parseIssueType("pulls")).toBe("pulls");
    expect(parseIssueType("all")).toBe("all");
    expect(parseIssueType("")).toBe("all");
    expect(parseIssueType("podcasts")).toBe("all");
    expect(parseIssueType(null)).toBe("all");
  });

  it("parseIssueSort: the eight upstream values, unknown → latest", () => {
    expect(parseIssueSort("oldest")).toBe("oldest");
    expect(parseIssueSort("nearduedate")).toBe("nearduedate");
    expect(parseIssueSort("farduedate")).toBe("farduedate");
    expect(parseIssueSort("mostcomment")).toBe("mostcomment");
    expect(parseIssueSort("garbage")).toBe("latest");
    expect(parseIssueSort(null)).toBe("latest");
  });

  it("parseLabelsFilter: 0-sentinel and any invalid entry drop the filter, signs kept, dedupe", () => {
    expect(parseLabelsFilter(null)).toEqual([]);
    expect(parseLabelsFilter("")).toEqual([]);
    expect(parseLabelsFilter("0")).toEqual([]);
    expect(parseLabelsFilter("4")).toEqual([4]);
    expect(parseLabelsFilter("4,-7,4")).toEqual([4, -7]); // dedupe, exclusion sign kept
    expect(parseLabelsFilter("4,bogus")).toEqual([]); // upstream StringsToInt64s error arm
    expect(parseLabelsFilter("4,0,9")).toEqual([4, 9]); // bare 0 ignored
  });

  it("parseWatchingSort: the six landed values, stars/forks/unknown → recentupdate", () => {
    expect(parseWatchingSort("newest")).toBe("newest");
    expect(parseWatchingSort("reversealphabetically")).toBe("reversealphabetically");
    expect(parseWatchingSort("moststars")).toBe("recentupdate"); // no landed counters
    expect(parseWatchingSort("size")).toBe("recentupdate");
    expect(parseWatchingSort(null)).toBe("recentupdate");
  });

  it("parseOptionalBoolParam: strconv bool set, else null", () => {
    expect(parseOptionalBoolParam("1")).toBe(true);
    expect(parseOptionalBoolParam("TRUE")).toBe(true);
    expect(parseOptionalBoolParam("f")).toBe(false);
    expect(parseOptionalBoolParam("False")).toBe(false);
    expect(parseOptionalBoolParam("on")).toBeNull(); // FormBool accepts "on", FormOptionalBool does not
    expect(parseOptionalBoolParam("")).toBeNull();
    expect(parseOptionalBoolParam(null)).toBeNull();
  });

  it("parseWatchingKeyword trims (upstream FormTrim)", () => {
    expect(parseWatchingKeyword("  repo  ")).toBe("repo");
    expect(parseWatchingKeyword(null)).toBe("");
  });
});

// --- the subscriptions loader ----------------------------------------------------

describe("loadSubscriptionsData — the applySubscribedCondition arms", () => {
  it("collects the watching / commenter / poster / repo-watcher arms; the explicit unsubscribe always excludes", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    // publicRepo (origin's public repo) carries the issue-level arms —
    // no repo-level watch on it, so every arm stays isolated.
    const watched = await svc.createIssue({ repoId: s.publicRepoId, title: "watched row", posterId: s.origin.id, now: at(10) });
    const muted = await svc.createIssue({ repoId: s.publicRepoId, title: "explicitly muted", posterId: s.origin.id, now: at(20) });
    const commented = await svc.createIssue({ repoId: s.publicRepoId, title: "past comment", posterId: s.origin.id, now: at(30) });
    const posted = await svc.createIssue({ repoId: s.publicRepoId, title: "own posting", posterId: s.viewer.id, now: at(40) });
    const stranger = await svc.createIssue({ repoId: s.publicRepoId, title: "none of the arms", posterId: s.origin.id, now: at(60) });
    // ownRepo (the wisher's own public repo) carries the repo-watcher arm.
    const repoWatched = await svc.createIssue({ repoId: s.ownRepoId, title: "repo-level watch", posterId: s.origin.id, now: at(50) });

    await subscribe(watched.id, true);
    await subscribe(muted.id, false); // the explicit mute — the NotIn prefix wins over every arm
    await svc.addComment({ issueId: commented.id, posterId: s.viewer.id, content: "here", now: at(31) });
    await watchRepo(s.ownRepoId);

    const data = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(""));
    // latest order (created DESC, id DESC) is deterministic over the stamps.
    expect(data.items.map((item) => item.title)).toEqual([
      "repo-level watch", // the repo_watchers arm
      "own posting", // the poster arm
      "past comment", // the commenter arm
      "watched row", // the issue-subscription arm
    ]);
    expect(data.total).toBe(4);
    void muted;
    void stranger;
    void posted;
    void repoWatched;
  });

  it("never surfaces a subscribed issue in a repo the viewer cannot read (readGrant) — the admin bypass does", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const secret = await svc.createIssue({ repoId: s.privateRepoId, title: "secret subscription", posterId: s.origin.id, now: at(10) });
    const open = await svc.createIssue({ repoId: s.publicRepoId, title: "open subscription", posterId: s.origin.id, now: at(20) });
    await subscribe(secret.id, true);
    await subscribe(open.id, true);

    const viewerData = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(""));
    expect(viewerData.items.map((item) => item.title)).toEqual(["open subscription"]);

    const adminData = await loadSubscriptionsData(env.DB, s.adminViewer, new URLSearchParams(""));
    expect(adminData.items.map((item) => item.title).sort()).toEqual(["open subscription", "secret subscription"]);
  });

  it("filters by state and issueType", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const openIssue = await svc.createIssue({ repoId: s.publicRepoId, title: "open issue", posterId: s.origin.id, now: at(10) });
    await subscribe(openIssue.id, true);
    const closedIssue = await svc.createIssue({ repoId: s.publicRepoId, title: "closed issue", posterId: s.origin.id, now: at(20) });
    await subscribe(closedIssue.id, true);
    await svc.closeIssue(closedIssue.id, { now: at(25) });
    const pull = await svc.createPullRequest({
      repoId: s.publicRepoId,
      title: "subscribed pull",
      posterId: s.origin.id,
      headRepoId: s.publicRepoId,
      baseBranch: "main",
      headBranch: "feature",
      now: at(30),
    });
    await subscribe(pull.issue.id, true);

    const openData = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("state=open"));
    // The open pull IS an open thread — state=open keeps it (created DESC).
    expect(openData.items.map((item) => item.title)).toEqual(["subscribed pull", "open issue"]);
    const closedData = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("state=closed&issueType=issues"));
    expect(closedData.items.map((item) => item.title)).toEqual(["closed issue"]);
    const pulls = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("issueType=pulls"));
    expect(pulls.items.map((item) => item.title)).toEqual(["subscribed pull"]);
    const all = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("state=OPEN"));
    expect(all.total).toBe(3); // a non-lowercase casing degrades to all (the upstream quirk)
  });

  it("applies the label include/exclude filter and drops it whole on invalid input", async () => {
    const s = await seed();
    const db = drizzle(env.DB);
    const svc = new IssuesService(env.DB);
    const labeled = await svc.createIssue({ repoId: s.publicRepoId, title: "labeled", posterId: s.origin.id, now: at(10) });
    const other = await svc.createIssue({ repoId: s.publicRepoId, title: "other", posterId: s.origin.id, now: at(20) });
    await db.insert(issueLabels).values([
      { issueId: labeled.id, labelId: 11 },
      { issueId: labeled.id, labelId: 12 },
      { issueId: other.id, labelId: 13 },
    ]);
    for (const issue of [labeled, other]) await subscribe(issue.id, true);

    const include = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("labels=11,12"));
    expect(include.items.map((item) => item.title)).toEqual(["labeled"]); // ALL included labels required
    const exclude = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("labels=-11"));
    expect(exclude.items.map((item) => item.title)).toEqual(["other"]);
    const invalid = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("labels=11,bogus"));
    expect(invalid.total).toBe(2); // the whole filter dropped (upstream error arm)
  });

  it("sorts by the upstream orders and paginates with the past-the-end clamp", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const first = await svc.createIssue({ repoId: s.publicRepoId, title: "first", posterId: s.origin.id, now: at(10) });
    const second = await svc.createIssue({ repoId: s.publicRepoId, title: "second", posterId: s.origin.id, now: at(20) });
    for (const issue of [first, second]) await subscribe(issue.id, true);
    await svc.addComment({ issueId: first.id, posterId: s.origin.id, content: "one", now: at(11) });
    await svc.addComment({ issueId: first.id, posterId: s.origin.id, content: "two", now: at(12) });

    const oldest = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("sort=oldest"));
    expect(oldest.items.map((item) => item.title)).toEqual(["first", "second"]);
    const mostComment = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("sort=mostcomment"));
    expect(mostComment.items.map((item) => item.title)).toEqual(["first", "second"]);
    const latest = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(""));
    expect(latest.items.map((item) => item.title)).toEqual(["second", "first"]); // created DESC default

    // Page size + clamp: 21 issues → page 1 full, page 99 clamps to page 2.
    for (let i = 0; i < SUBSCRIPTIONS_PAGE_SIZE - 1; i += 1) {
      const issue = await svc.createIssue({ repoId: s.publicRepoId, title: `bulk ${i}`, posterId: s.origin.id, now: at(100 + i) });
      await subscribe(issue.id, true);
    }
    const page1 = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("page=1"));
    expect(page1.total).toBe(SUBSCRIPTIONS_PAGE_SIZE + 1);
    expect(page1.items).toHaveLength(SUBSCRIPTIONS_PAGE_SIZE);
    const clamped = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams("page=99"));
    expect(clamped.page).toBe(2);
    expect(clamped.items).toHaveLength(1);
  });

  it("renders the dashboard row DOM: dashboard index form, event line, milestone link, labels, comment count", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const milestone = await svc.createMilestone({ repoId: s.publicRepoId, name: "v1.0", now: at(0) });
    const bug = await createRepoLabel(env.DB, s.publicRepoId, {
      name: "bug",
      exclusive: false,
      color: "#ee0701",
      description: "Something is broken",
      isArchived: false,
      now: at(0),
    });
    const labeled = await svc.createIssue({
      repoId: s.publicRepoId,
      title: "pinned & labeled",
      posterId: s.origin.id,
      milestoneId: milestone.id,
      labelIds: [bug.id],
      now: at(10),
    });
    await subscribe(labeled.id, true);
    await svc.addComment({ issueId: labeled.id, posterId: s.origin.id, content: "noise", now: at(11) });
    const ctx: UiContext = {
      viewer: s.viewerViewer,
      origin: "https://test.local",
      assets: shellAssetsFromManifest(manifest),
    };
    const data: SubscriptionsData = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(""));
    const html = renderNotificationSubscriptionsPage(ctx, data);

    expect(html).toContain('class="page-content user notification"');
    expect(html).toContain('aria-label="Subscriptions"');
    expect(html).toContain('class="active item" href="/notifications/subscriptions"');
    expect(html).toContain('class="item" href="/notifications/watching"');
    expect(html).toContain(`href="/origin/visible/issues/${labeled.index}"`);
    expect(html).toContain("origin/visible#"); // the dashboard index form
    expect(html).toContain('class="list-item-large-title"');
    expect(html).toContain("opened"); // the event-line literal
    expect(html).toContain("/origin/visible/milestone/"); // the live milestone link
    expect(html).toContain("v1.0");
    expect(html).toContain("octicon-milestone");
    expect(html).toContain('class="labels-list"'); // the label badges render
    expect(html).toContain(">1</a>"); // the comment count
    expect(html).not.toContain("No subscriptions");
  });

  it("renders the empty arm and the state-tab actives with their canonical hrefs", async () => {
    const s = await seed();
    const ctx: UiContext = {
      viewer: s.viewerViewer,
      origin: "https://test.local",
      assets: shellAssetsFromManifest(manifest),
    };
    const empty: SubscriptionsData = await loadSubscriptionsData(env.DB, s.viewerViewer, new URLSearchParams(""));
    const emptyHtml = renderNotificationSubscriptionsPage(ctx, empty);
    expect(emptyHtml).toContain("No subscriptions");

    const filtered: SubscriptionsData = await loadSubscriptionsData(
      env.DB,
      s.viewerViewer,
      new URLSearchParams("state=closed&issueType=pulls&sort=oldest"),
    );
    const filteredHtml = renderNotificationSubscriptionsPage(ctx, filtered);
    // The active Closed tab (class precedes href in the JSX prop order);
    // the sibling tabs keep the canonical filter set with their own state
    // (`&` renders as `&amp;` — the goldens' escaping).
    expect(filteredHtml).toContain(
      'class="active item flex-text-inline" href="/notifications/subscriptions?sort=oldest&amp;state=closed&amp;issueType=pulls"',
    );
    expect(filteredHtml).toContain('href="/notifications/subscriptions?sort=oldest&amp;issueType=pulls">All</a>');
    expect(filteredHtml).toContain("octicon-issue-opened");
    expect(filteredHtml).toContain("tw-mr-2");
  });
});

// --- the watching loader ---------------------------------------------------------

describe("loadWatchingData — the WatchedByID read", () => {
  it("lists watched repos through the readGrant scope and batches descriptions", async () => {
    const s = await seed();
    const db = drizzle(env.DB);
    await db.insert(repoSettings).values({ repoId: s.publicRepoId, description: "visible description" }).onConflictDoNothing();
    await watchRepo(s.publicRepoId);
    await watchRepo(s.privateRepoId); // watched but unreadable for the non-admin
    await watchRepo(s.ownRepoId); // the isOwner grant arm

    const data: WatchingData = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams(""));
    expect(data.total).toBe(2);
    expect(data.items.map((item) => item.repo.slug).sort()).toEqual(["mine", "visible"]);
    const visible = expectData(data.items.find((item) => item.repo.slug === "visible"), "visible row");
    expect(visible.description).toBe("visible description");
    expect(visible.ownerVisibility).toBe("public");

    const admin: WatchingData = await loadWatchingData(env.DB, s.adminViewer, new URLSearchParams(""));
    expect(admin.total).toBe(3); // the isSiteAdmin grant arm sees the private watch too
  });

  it("matches the landed keyword arm and honors the facet tri-states", async () => {
    const s = await seed();
    await watchRepo(s.publicRepoId); // origin/visible
    await watchRepo(s.ownRepoId); // wisher/mine

    const keyword = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("q=vis"));
    expect(keyword.items.map((item) => item.repo.slug)).toEqual(["visible"]);
    const pair = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("q=origin/visible"));
    expect(pair.items.map((item) => item.repo.slug)).toEqual(["visible"]);
    const none = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("q=nomatch"));
    expect(none.total).toBe(0);

    const archived = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("archived=true"));
    expect(archived.total).toBe(0); // nothing archived in the fixture
    const notArchived = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("archived=false"));
    expect(notArchived.total).toBe(2);
    const forks = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("fork=true"));
    expect(forks.total).toBe(0); // no fork edges in the fixture
    const topic = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("topic=true"));
    expect(topic.total).toBe(0); // no topics table — the noMatch posture
  });

  it("sorts: recentupdate default, newest/oldest by createdAt, alphabetical by owner+slug", async () => {
    const s = await seed();
    const db = drizzle(env.DB);
    await watchRepo(s.publicRepoId);
    await watchRepo(s.ownRepoId);
    // Stagger createdAt (the seed pins both repos to at(0)) so the time
    // sorts are total: mine created at +30, visible at 0.
    await db.update(repositories).set({ createdAt: at(30) }).where(eq(repositories.id, s.ownRepoId));

    const recent = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams(""));
    expect(recent.sort).toBe("recentupdate");
    expect(recent.items.map((item) => item.repo.slug)).toEqual(["mine", "visible"]); // updated 180 vs 60
    const newest = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("sort=newest"));
    expect(newest.items.map((item) => item.repo.slug)).toEqual(["mine", "visible"]); // created 30 vs 0
    const oldest = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("sort=oldest"));
    expect(oldest.items.map((item) => item.repo.slug)).toEqual(["visible", "mine"]);
    const alpha = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("sort=alphabetically"));
    expect(alpha.items.map((item) => item.repo.slug)).toEqual(["visible", "mine"]); // origin < wisher
    const reverse = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("sort=reversealphabetically"));
    expect(reverse.items.map((item) => item.repo.slug)).toEqual(["mine", "visible"]);
  });

  it("renders the watching arm: tab strip, search form, repo rows, empty line", async () => {
    const s = await seed();
    await watchRepo(s.publicRepoId);
    const ctx: UiContext = {
      viewer: s.viewerViewer,
      origin: "https://test.local",
      assets: shellAssetsFromManifest(manifest),
    };
    const data = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("q=vis"));
    const html = renderNotificationSubscriptionsPage(ctx, data);

    expect(html).toContain('aria-label="Watching"');
    expect(html).toContain('class="item" href="/notifications/subscriptions"');
    expect(html).toContain('class="active item" href="/notifications/watching"');
    expect(html).toContain('name="q"');
    expect(html).toContain('value="vis"'); // the submitted keyword rides back
    expect(html).toContain(notificationSubscriptionsLocale.repos_placeholder);
    expect(html).toContain('href="/origin/visible"'); // the shared repo-list row
    expect(html).not.toContain("No matching results found.");

    const empty = await loadWatchingData(env.DB, s.viewerViewer, new URLSearchParams("q=zzz"));
    const emptyHtml = renderNotificationSubscriptionsPage(ctx, empty);
    expect(emptyHtml).toContain("No matching results found."); // shared/repo/list's empty arm
    expect(emptyHtml).not.toContain("navigation_label"); // the pager is absent
  });

  it("exposes the upstream page sizes", () => {
    expect(SUBSCRIPTIONS_PAGE_SIZE).toBe(20); // setting.UI.IssuePagingNum
    expect(WATCHING_PAGE_SIZE).toBe(15); // setting.UI.User.RepoPagingNum
  });
});

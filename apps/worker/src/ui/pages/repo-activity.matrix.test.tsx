/**
 * The repo activity page's matrix (pages/repo-activity.tsx mounted through
 * uiRouter — the census R14 pulse page, web.go:1628-1631 → repo.Activity,
 * routers/web/repo/activity.go:22-81). The page module's doc carries the
 * upstream citations; THIS file arms the census's four test areas:
 *
 *   - the PERIOD ARMS: the bare URL's weekly default, the daily shrink,
 *     an unknown segment rendering the weekly window with the weekly item
 *     active (activity.go:30-45's switch has no 4xx arm), and yearly's
 *     Go-AddDate window re-admitting the old closed issue;
 *   - the COUNTS rendering: the Overview bars/cards off the landed D1
 *     aggregates (issues opened/closed/active, PRs opened/merged, the
 *     draft-excluded published releases), the code sentence off the
 *     activityStats RPC (the M2a boundary: first-parent commit count,
 *     author count, the numstat add/del/files tail — the ratified
 *     commitCountInAllBranches cut omits the "to all branches" arm) and
 *     the divider lists' shapes (the merged purple row, the tag-only
 *     release's plain text, the unresolved Open row);
 *   - the CODE ARMS: the real numstat-shaped sentence tail (the counts-
 *     first "not yet" placeholder is retired with the RPC landing), and
 *     the no_git_activity empty state with the chart div withheld;
 *   - the VISIBILITY posture: anonymous-on-public 200, anonymous-on-private
 *     404 shell, the MustBeNotEmpty gate (web.go:1636) and the unborn
 *     non-empty row (activity.go:51-60's default_branch_not_exist arm) both
 *     404-shelling; plus the unit toggles dropping whole sections
 *     (hasIssues off → PR-only Overview, hasReleases off → no releases arm).
 *
 * The parse claims (repo-activity family, the raw period segment, the
 * unclaimed-vs-claimed R15 chart literals) are pinned in the FIRST describe
 * over pure
 * parseUiRoute/handlesUiRoute — no D1. Mount arms ride the releases.matrix
 * minted-session harness (per-test D1 wipe + idempotent re-seed, REAL
 * pushed content for the engine walk; the commit/row clocks are relative
 * to the real now so the handler's routeNow() windows contain them).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { issues, pullRequests, releases, repositories } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import type { RepoRow } from "../ui-context";

// The engine-seeding hooks push real packs through the receive flow (the
// wave-129 measured >=4s in-run set — the smoke test's file-local budgets).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// --- the minted-session route harness (the releases.matrix pattern) -------------

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

// --- fixtures -------------------------------------------------------------------

/** Real-seconds now: the mount arms drive the HANDLER (routeNow()), so the
 *  seeded commit times and D1 stamps are relative to the real clock — every
 *  window (daily −24h … yearly −12mo) is deterministic around these offsets. */
const NOW_S = Math.floor(Date.now() / 1000);
const day = (n: number): number => NOW_S - n * 86_400;
const hour = (n: number): number => NOW_S - n * 3_600;

const ACTMX_COMMITS: SeedCommit[] = [
  {
    // OUTSIDE the weekly/daily windows (−30d), inside yearly — the period
    // shrink's excluded arm.
    message: "actmx: old root",
    time: day(30),
    files: [{ path: "README.md", content: "actmx root\n" }],
    author: { name: "Alice Liddell", email: "alice@example.com" },
  },
  {
    // In weekly, OUTSIDE daily — the daily arm's dropped commit.
    message: "actmx: shared two days ago",
    time: day(2),
    files: [{ path: "README.md", content: "actmx root\ntwo\n" }],
    author: { name: "Bob Rove", email: "bob@nowhere.example" },
  },
  {
    // The tip — inside EVERY window including daily.
    message: "actmx: fresh tip",
    time: hour(1),
    files: [{ path: "README.md", content: "actmx root\ntwo\ntip\n" }],
    author: { name: "Alice Liddell", email: "alice@example.com" },
  },
];

/** The old-content twin: ONE commit 400 days back — outside even the yearly
 *  window (AddDate(−1,0,0) ≈ −365d), so every period renders the
 *  no_git_activity empty state. */
const ACTOLD_COMMITS: SeedCommit[] = [
  {
    message: "actold: ancient root",
    time: day(400),
    files: [{ path: "README.md", content: "actold root\n" }],
    author: { name: "Alice Liddell", email: "alice@example.com" },
  },
];

interface ActmxFixture {
  repo: RepoRow;
  issueOpenRecent: { id: number; index: number };
  issueOpenMid: { id: number; index: number };
  issueClosedOld: { id: number; index: number };
  issueDormant: { id: number; index: number };
  prOpen: { index: number };
  prMerged: { index: number };
}

/** The per-test fixture (idempotent under the storage-isolation re-seed, the
 *  releases.matrix pattern). Repo `actmx-owner/act` (main, 3 commits) with:
 *  two open issues (−1h, −2d), one OLD issue closed −1h, one dormant
 *  −30d-and-untouched issue, one open PR (−1h), one PR created −2d and
 *  merged −1h (the landed merge posture: the issue row closed at the merge
 *  stamp), a published release v1.0 (−2d) whose GIT TAG is pushed at the
 *  tip (refs/tags/v1.0 — the release row's live-link arm), a draft (−1d,
 *  excluded), a D1-only published release v0.5-ghost (−3d: no git tag — the
 *  engine boundary's N2 class; its title renders PLAIN), and a tag-only row
 *  (−1h, upstream's FillReleases counts it). */
async function seedActmxFixture(): Promise<ActmxFixture> {
  const owner = await seedVerifiedUser({ username: "actmx-owner" });
  await ensureSeededRepo({ owner: "actmx-owner", slug: "act", commits: ACTMX_COMMITS, tags: [{ name: "v1.0", commitIndex: 2 }] });
  const db = drizzle(env.DB);
  const repoRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "actmx-owner"), eq(repositories.slug, "act")))
    .get();
  if (repoRow === undefined) throw new Error("actmx repo row missing");
  if (repoRow.visibility !== "public" || repoRow.isEmpty) {
    await db.update(repositories).set({ visibility: "public", isEmpty: false }).where(eq(repositories.id, repoRow.id));
  }

  const svc = new IssuesService(env.DB);
  const at = (s: number): Date => new Date(s * 1000);
  const i1 = await svc.createIssue({ repoId: repoRow.id, title: "actmx fresh issue", posterId: owner.id, now: at(hour(1)) });
  const i2 = await svc.createIssue({ repoId: repoRow.id, title: "actmx mid issue", posterId: owner.id, now: at(day(2)) });
  const i3 = await svc.createIssue({ repoId: repoRow.id, title: "actmx old closed issue", posterId: owner.id, now: at(day(30)) });
  await svc.closeIssue(i3.id, { actorId: owner.id, now: at(hour(1)) });
  const i4 = await svc.createIssue({ repoId: repoRow.id, title: "actmx dormant issue", posterId: owner.id, now: at(day(30)) });

  const p1 = await svc.createPullRequest({
    repoId: repoRow.id,
    title: "actmx open pull",
    posterId: owner.id,
    headRepoId: repoRow.id,
    baseBranch: "main",
    headBranch: "feature",
    now: at(hour(1)),
  });
  const p2 = await svc.createPullRequest({
    repoId: repoRow.id,
    title: "actmx merged pull",
    posterId: owner.id,
    headRepoId: repoRow.id,
    baseBranch: "main",
    headBranch: "gone",
    now: at(day(2)),
  });
  // The merged PR's landed merge posture (issue-detail.matrix's direct
  // stamp): hasMerged + mergedAt on the extension row, the ISSUE closed at
  // the merge stamp — so the opened-PR arm (is_closed = false) excludes it.
  await db
    .update(pullRequests)
    .set({ hasMerged: true, mergedAt: at(hour(1)), mergerId: owner.id })
    .where(eq(pullRequests.issueId, p2.issue.id));
  await db.update(issues).set({ isClosed: true, closedAt: at(hour(1)) }).where(eq(issues.id, p2.issue.id));

  await svc.createRelease({
    repoId: repoRow.id,
    publisherId: owner.id,
    tagName: "v1.0",
    target: "main",
    title: "actmx first release",
    note: "",
    isDraft: false,
    isPrerelease: false,
    now: at(day(2)),
  });
  await svc.createRelease({
    repoId: repoRow.id,
    publisherId: owner.id,
    tagName: "v0.9-draft",
    target: "main",
    title: "actmx draft",
    note: "",
    isDraft: true,
    isPrerelease: false,
    now: at(day(1)),
  });
  // The D1-only release (the engine boundary — creating a release does not
  // create the git tag, the findings' N2 class): published −3d, inside the
  // weekly window, OUTSIDE the daily one. Its tag has no git existence, so
  // its title renders PLAIN (never a /src/tag link — the dead-link rule).
  await svc.createRelease({
    repoId: repoRow.id,
    publisherId: owner.id,
    tagName: "v0.5-ghost",
    target: "main",
    title: "actmx ghost release",
    note: "",
    isDraft: false,
    isPrerelease: false,
    now: at(day(3)),
  });
  // The tag-only row (upstream FillReleases has no is_tag filter — it
  // counts; pulse.tmpl renders it as the plain tag name, no title link).
  await db.insert(releases).values({
    repoId: repoRow.id,
    publisherId: owner.id,
    tagName: "just-a-tag",
    lowerTagName: "just-a-tag",
    title: "",
    isDraft: false,
    isTag: true,
    publishedUnix: hour(1),
  });

  // The unresolved arm's row: created BEFORE the weekly window, still open,
  // updated WITHIN it. (i1/i2 are created after the window opens — never
  // unresolved; i3 is closed; i4 sits dormant until this stamp.)
  await db.update(issues).set({ updatedAt: at(hour(2)) }).where(eq(issues.id, i4.id));

  return {
    repo: repoRow,
    issueOpenRecent: { id: i1.id, index: i1.index },
    issueOpenMid: { id: i2.id, index: i2.index },
    issueClosedOld: { id: i3.id, index: i3.index },
    issueDormant: { id: i4.id, index: i4.index },
    prOpen: { index: p1.issue.index },
    prMerged: { index: p2.issue.index },
  };
}

/** The old-content twin (freshly created per test — one engine push). */
async function seedActOld(): Promise<RepoRow> {
  await seedVerifiedUser({ username: "actold-owner" });
  await ensureSeededRepo({ owner: "actold-owner", slug: "old", commits: ACTOLD_COMMITS });
  const db = drizzle(env.DB);
  const repoRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "actold-owner"), eq(repositories.slug, "old")))
    .get();
  if (repoRow === undefined) throw new Error("actold repo row missing");
  if (repoRow.visibility !== "public" || repoRow.isEmpty) {
    await db.update(repositories).set({ visibility: "public", isEmpty: false }).where(eq(repositories.id, repoRow.id));
  }
  return repoRow;
}

/** The never-pushed empty twin (the releases fixture's RepoService arm). */
async function seedActEmpty(): Promise<RepoRow> {
  const owner = await seedVerifiedUser({ username: "actempty-owner" });
  const created = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "actempty-owner" },
    name: "empty",
    isPrivate: false,
    status: "ready",
  });
  if (created.visibility !== "public") {
    await drizzle(env.DB).update(repositories).set({ visibility: "public" }).where(eq(repositories.id, created.id));
  }
  return created;
}

/** A public-but-unborn row (isEmpty flipped false with NO push — the
 *  default-branch-miss arm's cheapest shape). */
async function seedActUnborn(): Promise<RepoRow> {
  const owner = await seedVerifiedUser({ username: "actunborn-owner" });
  const created = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "actunborn-owner" },
    name: "unborn",
    isPrivate: false,
    status: "ready",
  });
  const db = drizzle(env.DB);
  await db.update(repositories).set({ visibility: "public", isEmpty: false }).where(eq(repositories.id, created.id));
  const row = await db.select().from(repositories).where(eq(repositories.id, created.id)).get();
  if (row === undefined) throw new Error("actunborn repo row missing");
  return row;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // FK order (the issues-list.matrix wipe + the releases additions): the
  // join/write rows first, then issues, then repo_counters/repositories
  // before users (sessions cascade from users).
  for (const table of [
    "release_assets",
    "releases",
    "webhook_deliveries",
    "webhooks",
    "repo_collaborators",
    "repo_settings",
    "issue_labels",
    "issue_pins",
    "comments",
    "pull_requests",
    "issues",
    "labels",
    "milestones",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the claim pins ---------------------------------------------------------------

describe("repo-activity claim pins (parseUiRoute / handlesUiRoute)", () => {
  it("claims the bare URL (period null) and every single-segment tail raw", () => {
    expect(parseUiRoute("/octo/hello/activity")).toEqual({ family: "repo-activity", owner: "octo", repo: "hello", period: null });
    expect(parseUiRoute("/octo/hello/activity/daily")).toEqual({
      family: "repo-activity",
      owner: "octo",
      repo: "hello",
      period: "daily",
    });
    // The segment is RAW — the loader's switch (activity.go:30-45) defaults
    // unknowns to the weekly window; parse never 4xxs them.
    expect(parseUiRoute("/octo/hello/activity/bogus")).toEqual({
      family: "repo-activity",
      owner: "octo",
      repo: "hello",
      period: "bogus",
    });
    // Trailing-slash canonicalization (the parser's pre-trim).
    expect(parseUiRoute("/octo/hello/activity/weekly/")).toEqual({
      family: "repo-activity",
      owner: "octo",
      repo: "hello",
      period: "weekly",
    });
  });

  it("the three chart literals claim to the R15 family; junk tails stay unclaimed", () => {
    // web.go:1633-1646's chart group LANDED (the census's R15 row): the
    // literals + their /data tails claim to pages/repo-charts.tsx's
    // repo-charts family (the chart matrix pins the full shape set); the
    // PERIOD arm is untouched by them.
    expect(parseUiRoute("/octo/hello/activity/contributors")).toEqual({
      family: "repo-charts",
      owner: "octo",
      repo: "hello",
      kind: "contributors",
      tail: null,
    });
    expect(parseUiRoute("/octo/hello/activity/recent-commits/data")).toEqual({
      family: "repo-charts",
      owner: "octo",
      repo: "hello",
      kind: "recent-commits",
      tail: "data",
    });
    // Deeper junk tails stay unclaimed (chi registers only '' and '/data'
    // per chart group) — the engine's 404 owns them.
    expect(parseUiRoute("/octo/hello/activity/daily/extra")).toBeNull();
    expect(parseUiRoute("/octo/hello/activity/contributors/extra")).toBeNull();
    expect(parseUiRoute("/octo/hello/activity/daily/data")).toBeNull();
    expect(handlesUiRoute("/octo/hello/activity")).toBe(true);
    expect(handlesUiRoute("/octo/hello/activity/daily")).toBe(true);
    expect(handlesUiRoute("/octo/hello/activity/contributors")).toBe(true);
    expect(handlesUiRoute("/octo/hello/activity/contributors/extra")).toBe(false);
  });
});

// --- the mount arms ---------------------------------------------------------------

describe("the activity page mounts (period arms + counts + lists)", () => {
  it("the weekly default renders the full pulse: header, dropdown, Overview, code sentence, lists", async () => {
    await seedActmxFixture();
    const res = await fetchUi("/actmx-owner/act/activity");
    expect(res.status).toBe(200);
    const html = await res.text();

    // The page discriminator (activity.tmpl:2's `repository commits`) + the
    // date-range header (the AbsoluteLong pair).
    expect(html).toContain('class="page-content repository commits"');
    expect(html).toContain("activity-header");
    expect(html).toContain("Period:"); // repo.activity.period.filter_label
    expect(html).toContain("<strong>1 week</strong>"); // the weekly PeriodText
    // The seven dropdown arms (pulse.tmpl:10-16) with weekly active.
    expect(html).toContain('href="/actmx-owner/act/activity/daily"');
    expect(html).toContain('href="/actmx-owner/act/activity/yearly"');
    expect(html).toContain('class="active item" href="/actmx-owner/act/activity/weekly"');
    // The nav strip (repo/navbar.tmpl — all four items LIVE since the R15
    // chart family landed; the chart matrix pins the full four-item strip).
    expect(html).toContain("Pulse</a>");

    // Overview counts (the landed D1 aggregates): 2 open issues + 1 old
    // closed = 3 active; 1 open + 1 merged = 2 active PRs.
    expect(html).toContain("<strong>3</strong> Active Issues");
    expect(html).toContain("<strong>2</strong> Active Pull Requests");
    // The merged bar (1 merged / 2 active = 50%).
    expect(html).toContain('class="table-cell tiny tw-bg-purple" style="width: 50%"');
    // The four count cards (the TrN labels; each card's anchor ends with the
    // label text).
    expect(html).toContain("Merged Pull Request</a>");
    expect(html).toContain("Proposed Pull Request</a>");
    expect(html).toContain("Closed Issue</a>");
    expect(html).toContain("New Issues</a>");

    // The code sentence (the activityStats RPC — the M2a boundary):
    // weekly window → the −2d and −1h first-parent commits (the −30d root
    // is out), 2 authors (alice + bob).
    expect(html).toContain("Excluding merges,");
    expect(html).toContain("<strong>2 authors</strong> have pushed");
    // The ratified M2a cut: no all-branches arm — the first sentence ends
    // at "to main." (upstream's "and N commits to all branches." is the
    // omitted CommitCountInAllBranches render, pulse.tmpl:97-98).
    expect(html).toContain("to main. On main,");
    expect(html).not.toContain("to all branches");
    // The RPC's numstat tail (the counts-first placeholder is retired):
    // the window's two commits each add one README line — 1 path, +2/−0.
    expect(html).toContain("<strong>1 file</strong> has changed");
    expect(html).toContain("and there have been");
    expect(html).toContain('<strong class="tw-text-green">2 additions</strong>');
    expect(html).toContain('<strong class="tw-text-red">0 deletions</strong>.');
    // The chart div for the official bundle.
    expect(html).toContain('id="repo-activity-top-authors-chart"');

    // The divider lists: merged (purple), proposed, closed, new, unresolved.
    expect(html).toContain('id="merged-pull-requests"');
    expect(html).toContain('id="proposed-pull-requests"');
    expect(html).toContain('id="closed-issues"');
    expect(html).toContain('id="new-issues"');
    expect(html).toContain('id="unresolved-conversations"');
    expect(html).toContain('<span class="ui purple label">Merged</span>');
    expect(html).toContain('<span class="ui red label">Closed</span>');
    expect(html).toContain('<span class="ui green label">Opened</span>');
    expect(html).toContain('<span class="ui green label">Open</span>');

    // Releases: v1.0's tag IS pushed (refs/tags/v1.0, the fixture), so its
    // title links at the MOUNTED /src/tag shape (the A3 fix — the bare
    // /src/{tag} shape upstream's pulse.tmpl:128 emits rides web.go:1755's
    // deprecated catchall we don't claim, and must not be emitted); the
    // ghost release (D1-only tag) renders its title PLAIN (the dead-link
    // rule); the tag-only row is plain text; the draft is absent.
    expect(html).toContain('id="published-releases"');
    expect(html).toContain("v1.0");
    expect(html).toContain(">actmx first release</a>");
    expect(html).toContain('href="/actmx-owner/act/src/tag/v1.0"');
    expect(html).not.toContain('href="/actmx-owner/act/src/v1.0"'); // the legacy bare shape is gone
    expect(html).toContain("actmx ghost release");
    expect(html).not.toContain('href="/actmx-owner/act/src/tag/v0.5-ghost"'); // no git tag → no link
    expect(html).toContain("just-a-tag");
    expect(html).not.toContain("v0.9-draft");
    expect(html).not.toContain(">actmx draft</a>");
  });

  it("the weekly lists link every row by its arm (issues/, pulls/, src/)", async () => {
    const fx = await seedActmxFixture();
    const res = await fetchUi("/actmx-owner/act/activity/weekly");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="/actmx-owner/act/pulls/${fx.prMerged.index}"`);
    expect(html).toContain(`href="/actmx-owner/act/pulls/${fx.prOpen.index}"`);
    expect(html).toContain(`href="/actmx-owner/act/issues/${fx.issueClosedOld.index}"`);
    expect(html).toContain(`href="/actmx-owner/act/issues/${fx.issueOpenRecent.index}"`);
    expect(html).toContain(`href="/actmx-owner/act/issues/${fx.issueOpenMid.index}"`);
    expect(html).toContain(`href="/actmx-owner/act/issues/${fx.issueDormant.index}"`);
    expect(html).toContain('href="/actmx-owner/act/src/tag/v1.0"'); // the mounted shape, gated on the pushed tag (the A3 fix)
    // The dormant issue (created −30d, updated −2h by the fixture stamp) IS
    // the unresolved row; the old CLOSED issue and the in-window opens are
    // not (closed rows are excluded, fresh-created rows are after `from`).
    const unresolvedBlock = html.slice(html.indexOf('id="unresolved-conversations"'));
    expect(unresolvedBlock).toContain(`href="/actmx-owner/act/issues/${fx.issueDormant.index}"`);
    expect(unresolvedBlock).not.toContain(`href="/actmx-owner/act/issues/${fx.issueClosedOld.index}"`);
    expect(unresolvedBlock).not.toContain(`href="/actmx-owner/act/issues/${fx.issueOpenRecent.index}"`);
    // The merged PR (open-list-excluded, merged-list-present) is not in the
    // unresolved block either.
    expect(unresolvedBlock).not.toContain(`href="/actmx-owner/act/pulls/${fx.prMerged.index}"`);
  });

  it("the daily arm shrinks the window (the −2d rows drop, the −1h rows stay)", async () => {
    const fx = await seedActmxFixture();
    const res = await fetchUi("/actmx-owner/act/activity/daily");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<strong>1 day</strong>");
    expect(html).toContain('class="active item" href="/actmx-owner/act/activity/daily"');
    // In: the −1h issue + PR; the −1h tip commit (code sentence); the
    // tag-only release (−1h); the OLD issue's CLOSE stamp (−1h) keeps it on
    // the closed list even though its creation is far outside.
    expect(html).toContain(">actmx fresh issue</a>");
    expect(html).toContain(`href="/actmx-owner/act/issues/${fx.issueOpenRecent.index}"`);
    expect(html).toContain(">actmx old closed issue</a>");
    expect(html).toContain("just-a-tag");
    // Out: everything created at −2d or older.
    expect(html).not.toContain(">actmx mid issue</a>");
    expect(html).not.toContain(">actmx first release</a>");
    // Code: daily window → ONLY the −1h tip (1 commit, 1 author, +1/−0).
    expect(html).toContain("<strong>1 author</strong> has pushed");
    expect(html).toContain('<strong class="tw-text-green">1 addition</strong>');
  });

  it("an unknown period segment renders the WEEKLY window with the weekly item active (no 4xx)", async () => {
    await seedActmxFixture();
    const res = await fetchUi("/actmx-owner/act/activity/bogus");
    expect(res.status).toBe(200);
    const html = await res.text();
    // activity.go:30-45's switch has no default arm — the window AND the
    // active dropdown item are the weekly pair.
    expect(html).toContain("<strong>1 week</strong>");
    expect(html).toContain('class="active item" href="/actmx-owner/act/activity/weekly"');
    expect(html).toContain("<strong>3</strong> Active Issues"); // the weekly aggregate
    expect(html).toContain(">actmx mid issue</a>"); // the −2d row back in
  });

  it("the yearly arm re-admits the −30d rows (Go AddDate window math)", async () => {
    const fx = await seedActmxFixture();
    const res = await fetchUi("/actmx-owner/act/activity/yearly");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<strong>1 year</strong>");
    // All three commits in-window; the dormant issue rides the OPEN list
    // (created AND untouched at −30d, inside −12mo); the old closed issue
    // rides the closed list.
    expect(html).toContain(`href="/actmx-owner/act/issues/${fx.issueDormant.index}"`);
    expect(html).toContain(">actmx old closed issue</a>");
    expect(html).toContain("<strong>2 authors</strong>"); // alice + bob (alice authored two) over the yearly first-parent fold
    // The fold's numstat tail: all three commits add one README line each.
    expect(html).toContain('<strong class="tw-text-green">3 additions</strong>');
  });

  it("the no-git-activity window renders the empty state and withholds the chart div", async () => {
    await seedActOld();
    const res = await fetchUi("/actold-owner/old/activity/yearly");
    expect(res.status).toBe(200);
    const html = await res.text();
    // pulse.tmpl:84-88 — the −400d commit is outside even AddDate(−1,0,0).
    expect(html).toContain("There has been no commit activity in this period.");
    expect(html).not.toContain('id="repo-activity-top-authors-chart"');
    // The counts arms still render their D1 halves (no issues/PRs/releases
    // seeded on this twin — the Overview section itself is absent: both
    // units carry zero rows but the section renders on the unit gates...
    // they are ON here, with zero counts → the grey-bar arms).
    expect(html).toContain("<strong>0</strong> Active Pull Requests");
    expect(html).toContain("<strong>0</strong> Active Issues");
    // The grey (zero) bar arms, not the colored pair.
    expect(html).toContain('class="table-cell tiny tw-bg-grey"');
    expect(html).not.toContain("tw-bg-purple");
  });

  it("the unit toggles drop whole sections (hasIssues off, then hasReleases off)", async () => {
    const fx = await seedActmxFixture();

    await saveRepoSettings(env.DB, fx.repo.id, { hasIssues: false }, new Date());
    const resIssuesOff = await fetchUi("/actmx-owner/act/activity");
    expect(resIssuesOff.status).toBe(200);
    const htmlIssuesOff = await resIssuesOff.text();
    // The PR column survives; the issue cards/lists/unresolved arm vanish.
    expect(htmlIssuesOff).toContain("Active Pull Requests");
    expect(htmlIssuesOff).not.toContain("Active Issues");
    expect(htmlIssuesOff).not.toContain('id="closed-issues"');
    expect(htmlIssuesOff).not.toContain('id="new-issues"');
    expect(htmlIssuesOff).not.toContain('id="unresolved-conversations"');
    expect(htmlIssuesOff).toContain('id="proposed-pull-requests"');

    await saveRepoSettings(env.DB, fx.repo.id, { hasIssues: true, hasReleases: false }, new Date());
    const resReleasesOff = await fetchUi("/actmx-owner/act/activity");
    expect(resReleasesOff.status).toBe(200);
    const htmlReleasesOff = await resReleasesOff.text();
    expect(htmlReleasesOff).not.toContain('id="published-releases"');
    expect(htmlReleasesOff).not.toContain("v1.0");
    // The issue arm returns with the toggle.
    expect(htmlReleasesOff).toContain('id="new-issues"');
  });
});

// --- the visibility posture ---------------------------------------------------------

describe("the activity page's visibility posture (§2.5 + the group gates)", () => {
  it("an anonymous viewer renders the public repo's pulse (optSignIn posture)", async () => {
    await seedActmxFixture();
    const res = await fetchUi("/actmx-owner/act/activity");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("activity-header");
  });

  it("an invisible (private) repo 404-shells anonymous — existence stays hidden", async () => {
    const owner = await seedVerifiedUser({ username: "actpriv-owner" });
    const created = await new RepoService(env.DB).create({
      owner: { id: owner.id, usernameLower: "actpriv-owner" },
      name: "vault",
      isPrivate: true,
      status: "ready",
    });
    const res = await fetchUi("/actpriv-owner/vault/activity");
    expect(res.status).toBe(404);
    expect((await res.text())).toContain("page-content"); // the 404 shell, not an error leak
    expect(created.visibility).toBe("private");
  });

  it("an empty repo 404-shells (MustBeNotEmpty, web.go:1636)", async () => {
    await seedActEmpty();
    const res = await fetchUi("/actempty-owner/empty/activity");
    expect(res.status).toBe(404);
  });

  it("an unborn non-empty repo 404-shells (activity.go:51-60's default_branch_not_exist arm)", async () => {
    await seedActUnborn();
    const res = await fetchUi("/actunborn-owner/unborn/activity");
    expect(res.status).toBe(404);
  });
});

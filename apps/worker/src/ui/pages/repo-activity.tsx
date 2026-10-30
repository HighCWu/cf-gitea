/**
 * The repository ACTIVITY page — the repo navbar's "pulse" (the census's
 * R14, the gap census's impact #5; pages wave for the top-5 #5):
 *
 *   GET /{owner}/{repo}/activity            web.go:1629 → repo.Activity
 *   GET /{owner}/{repo}/activity/{period}   web.go:1630 → repo.Activity
 *                                (routers/web/repo/activity.go:22-81)
 *
 * ## Upstream shape (submodule pin fc4936884584)
 *
 * templates/repo/activity.tmpl renders the repo header + the two-column
 * flex layout (`.flex-container-nav` → repo/navbar.tmpl's vertical menu,
 * `.flex-container-main` → repo/pulse.tmpl) with page discriminator
 * `page-content repository commits` (activity.tmpl:2). The route group
 * (web.go:1628-1646) carries `optSignIn, context.RepoAssignment,
 * repo.MustBeNotEmpty, context.RequireUnitReader(TypeCode, TypeIssues,
 * TypePullRequests, TypeReleases)` — reading ANY of the four units admits
 * the group; the handler then arms each stats section on its own unit
 * (pulse.tmpl's `Permission.CanRead` guards) and 404s when the default
 * branch does not exist (activity.go:51-60 — `default_branch_not_exist`).
 *
 * The period segment picks the window (activity.go:30-45): daily −24h,
 * halfweekly −72h, weekly −168h, monthly AddDate(0,−1,0), quarterly −3
 * months, semiyearly −6 months, yearly −1 year; an UNKNOWN segment (and the
 * bare URL) renders the WEEKLY window — the switch has no 4xx arm
 * (`parseActivityPeriod` from the landed activity-author-data module is the
 * same switch verbatim; the bare route passes `null`). `PeriodText` is the
 * canonical period's locale label, so `/activity/bogus` shows the weekly
 * item active — upstream-exact.
 *
 * ## Data (§3.2 — the git counts on the M2a boundary RPC; the D1 lists stay)
 *
 * The census classifies R14 (b) NEEDS-API with "counts-only degradation
 * shippable first"; the landed cut WAS that degradation. The git-derived
 * counts now come off the engine's boundary RPC `activityStats(ref,
 * period)` (SPEC-0015 M2a — the `EngineClient` wrapper in ../engine), fed
 * the same canonical period the page already renders:
 *
 * - **Code arm** — upstream's `CodeActivityStats`
 *   (modules/git/repo_stats.go:20-28): the RPC walks the default branch's
 *   FIRST-PARENT chain with merges excluded from the fold
 *   (repo_stats.go:57-66's `log --numstat --no-merges --first-parent
 *   <branch> --since` arm), windows on COMMITTER time (git --since
 *   semantics), keys per-author counts by lowercased email
 *   (repo_stats.go:113-118), and folds the numstat-shaped totals
 *   (repo_stats.go:119-149). This retires the landed walk's ledger of
 *   reductions (the all-parents walk, the per-branch caps, the missing
 *   shortstat): `commitCount`/`authorCount` are upstream-exact and the
 *   counts-first "not yet" placeholder is GONE — `changedFiles`/
 *   `additions`/`deletions` render the real sentence tail. The RPC's
 *   per-author `authors[]` has no SSR render (upstream's pulse renders
 *   aggregates only) and its `truncated` flag (the MAX_STATS_SCAN budget
 *   exit — flagged, never null) has no upstream counterpart to render;
 *   both are ignored here.
 * - **RATIFIED CUT: CommitCountInAllBranches** — repo_stats.go:26's
 *   `rev-list --count --no-merges --branches=* --since` arm (:44-55) is
 *   NOT in the v1 RPC (SPEC-0015 M2a Open question 2, ratified: a second
 *   all-refs walk per answer is a real per-answer cost for a header
 *   nicety). Upstream's pulse renders it TWICE and ours omits both: the
 *   sentence's "and N commits to all branches." middle arm (pulse.tmpl:
 *   97-98 — ours ends the first sentence at "to {branch}.") and the
 *   empty-state gate (pulse.tmpl:84-88 gates `no_git_activity` on it —
 *   ours gates on `commitCount === 0`, the default-branch proxy the cut
 *   leaves us: identical on single-branch repos; a side-branch-only window
 *   renders the empty state where upstream would render the sentence).
 * - **Issues/PRs/releases/unresolved counters + lists** — UNCHANGED plain
 *   D1 aggregates over the landed tables: upstream derives these from D1
 *   too (models/activities/repo_activity.go's SQL, NOT git), so only the
 *   git-derived counts switched source. The postures verbatim: opened
 *   issues = created ≥ from (newlyCreatedIssues:249-253), closed issues =
 *   closed ≥ from (issuesForActivityStatement:336-346), active issues =
 *   created ≥ from OR closed ≥ from (activeIssues:255-262), opened PRs =
 *   the pull_request ⋈ issue join with `is_closed = false AND
 *   created_unix ≥ from` (pullRequestsForActivityStatement:221-239's
 *   merged=false arm), merged PRs = `has_merged AND merged_unix ≥ from`,
 *   unresolved = `is_closed = false AND created < from AND updated ≥ from`
 *   (FillUnresolvedIssues:225-239), published releases = `is_draft = false
 *   AND published_unix ≥ from` (releasesForActivityStatement:355-359).
 *   Per-arm author counts ride `count(distinct poster_id/publisher_id)`
 *   (the FillIssues/FillPullRequests/FillReleases author subqueries).
 *   List ROWS render up to ACTIVITY_LIST_CAP per arm (upstream renders the
 *   unbounded list; the counts stay exact via separate COUNT reads — the
 *   documented cap divergence). The published-releases ROW LINK: upstream's
 *   title link emits the BARE `/src/{tag}` shape (pulse.tmpl:128) and
 *   resolves it through the DEPRECATED `m.Get("/*")` catchall under `/src`
 *   (web.go:1755 — "'/*' route is deprecated, and kept for backward
 *   compatibility"), which the UI router deliberately does NOT claim (the
 *   legacy no-prefix form 404-shells — §3.3). Emitting upstream's URL
 *   without upstream's catchall 404s even for a live tag (the link-crawl
 *   A3 row, docs/usability/findings-links.md), so this page emits the
 *   MOUNTED shape `/src/tag/{tag}` — the releases list's exact arm
 *   (releases.tsx's meta tag link) — GATED on the tag's engine existence
 *   via the shared `tagTipsOf` read: a release whose tag exists in git
 *   renders the title link; a D1-only release (the documented engine
 *   boundary — creating a release does not create the tag,
 *   api/services/releases.ts) renders the title PLAIN, §2.4.1's dead-link
 *   rule winning over upstream's unconditional anchor (the releases page's
 *   documented posture for the same state).
 * - **Top-authors chart** — upstream renders it CLIENT-side
 *   (`<div id="repo-activity-top-authors-chart">`, pulse.tmpl:108; the
 *   official bundle's initRepoActivityTopAuthorsChart mounts a Vue app that
 *   fetches `/activity_author_data`). That feed IS landed (the
 *   activity-author-data family, web.go:1683-1687's parity), so the page
 *   emits the exact chart div and the official bundle hydrates the
 *   top-actors from the landed feed — the data arm supports it; no SSR
 *   substitution needed (upstream is equally empty without JS).
 *
 * ## Auth + visibility posture (§2.5)
 *
 * The page renders for every viewer who can see the repo (the shared
 * `resolveUiRequest` read — upstream's optSignIn + RepoAssignment). The
 * group's RequireUnitReader gate reduces to the visibility read: the code
 * unit has no landed toggle, so any visible repo can read at least code.
 * `MustBeNotEmpty` 404-shells empty repos (the releases family's gate) and
 * a missing default branch ref 404-shells (activity.go:51-60's NotFound
 * arm — loader null). The unit toggles degrade the SECTIONS: hasPulls off
 * drops every PR arm, hasIssues off every issue arm, hasReleases off the
 * releases arm (pulse.tmpl's per-section CanRead guards).
 *
 * ## DOM contract (pulse.tmpl at the pin) + §5.5 reductions
 *
 * `h2.activity-header` (the date range + the period dropdown), the
 * Overview attached segments (the two-column stats-table bars + the four
 * count cards), the code segment (the counts sentence + the chart div),
 * then the divider lists (`#published-releases`, `#merged-pull-requests`,
 * `#proposed-pull-requests`, `#closed-issues`, `#new-issues`,
 * `#unresolved-conversations`) with `p.desc` label rows. §5.5 deviations
 * (the releases precedent): section headers render h3 where upstream's h4
 * would skip upward past the h2; the stats-table bar cells carry
 * aria-labels (upstream's bare `<a>` cells have no accessible name); the
 * nav menu rides pages/repo-charts.tsx's shared RepoActivityNavMenu — all
 * four items LIVE since the R15 chart family landed (the pulse item active
 * here); the dropdown's triangle-down svg is unrendered (the generated icon
 * table has no octicon-triangle-down entry).
 */

import { and, asc, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Child } from "hono/jsx";

import { loadRepoSettings } from "../../api/services/repo-settings";
import { issues, pullRequests, releases } from "../../db/schema";
import { TimeSince } from "../components/file-list";
import { engineClient } from "../engine";
import type { IconName } from "../icons";
import { pathEscapeSegments } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import { parseActivityPeriod } from "./activity-author-data";
import { tagTipsOf } from "./releases";
import { RepoActivityNavMenu } from "./repo-charts";

/** Page chrome text (component-local, the tabLocale pattern — the strings
 *  cite upstream's locale keys, locale_en-US.json's repo.activity block). */
export const activityLocale = {
  page_title: "Activity", // "repo.activity"
  navbar_pulse: "Pulse", // "repo.activity.navbar.pulse"
  filter_label: "Period:", // "repo.activity.period.filter_label"
  overview: "Overview", // "repo.activity.overview"
  no_git_activity: "There has been no commit activity in this period.", // "repo.activity.no_git_activity"
  published_label: "Published", // "repo.activity.published_release_label"
  merged_label: "Merged", // "repo.activity.merged_prs_label"
  opened_pr_label: "Proposed", // "repo.activity.opened_prs_label"
  closed_label: "Closed", // "repo.activity.closed_issue_label"
  new_issue_label: "Opened", // "repo.activity.new_issue_label"
  unresolved_label: "Open", // "repo.activity.unresolved_conv_label"
} as const;

/** The period arms — the dropdown items in upstream order
 *  (pulse.tmpl:10-16); the labels are "repo.activity.period.*". */
const PERIODS = [
  { key: "daily", label: "1 day" },
  { key: "halfweekly", label: "3 days" },
  { key: "weekly", label: "1 week" },
  { key: "monthly", label: "1 month" },
  { key: "quarterly", label: "3 months" },
  { key: "semiyearly", label: "6 months" },
  { key: "yearly", label: "1 year" },
] as const;

/** The period key → its dropdown label (the PeriodText arm). */
export function periodLabel(key: string): string {
  return (PERIODS.find((p) => p.key === key) ?? PERIODS[2]).label;
}

/** Per-arm list-render cap — the counts stay exact via the separate COUNT
 *  reads; upstream renders the unbounded list (the module doc's cap). */
export const ACTIVITY_LIST_CAP = 50;

/** One list row — the render subset of an issue/PR arm. */
export interface ActivityIssueItem {
  index: number;
  title: string;
  /** True for PR rows (the unresolved arm mixes both — pulse.tmpl:222-226). */
  isPull: boolean;
  /** The row's stamp (created/closed/merged/updated per arm). */
  at: Date | null;
}

/** One published-release row (the render subset). */
export interface ActivityReleaseItem {
  tagName: string;
  title: string;
  isTag: boolean;
  publishedUnix: number;
  /** The tag's engine tip (the shared `tagTipsOf` read) — null when the tag
   *  does not exist in git (the D1-only release row): the title then renders
   *  PLAIN, never a dead `/src/tag/…` link (the module doc's A3 note). */
  tagOid: string | null;
}

/** The code arm's counts — the upstream `CodeActivityStats` render subset
 *  (repo_stats.go:20-28) minus `CommitCountInAllBranches`: the ratified
 *  SPEC-0015 M2a cut omits it from the boundary RPC, so the sentence drops
 *  the all-branches arm (the module doc's divergence note). */
export interface ActivityCodeCounts {
  /** Non-merge commits on the default branch's first-parent chain in-window
   *  (upstream `CommitCount` — the `--first-parent` walk, upstream-exact). */
  commitCount: number;
  /** Distinct author emails in the window (upstream `AuthorCount`). */
  authorCount: number;
  /** Distinct paths changed across the window's folded commits (upstream
   *  `ChangedFiles`; binary/over-cap files still contribute their path). */
  changedFiles: number;
  /** Window line-additions total (upstream `Additions`; binary/over-cap
   *  files contribute their path, not counts — numstat's `-` skip). */
  additions: number;
  /** Window line-deletions total (upstream `Deletions`). */
  deletions: number;
}

/** The issues arm (upstream ActivityStats' issue half). `activeCount` is
 *  upstream `ActiveIssueCount` — its OWN query (created ≥ from OR closed ≥
 *  from, activeIssues:255-262), NOT opened+closed: an old issue closed
 *  in-window is active + closed but never opened. */
export interface ActivityIssueStats {
  activeCount: number;
  openedCount: number;
  openedAuthors: number;
  opened: ActivityIssueItem[];
  closedCount: number;
  closedAuthors: number;
  closed: ActivityIssueItem[];
}

/** The PRs arm (upstream ActivityStats' PR half). */
export interface ActivityPullStats {
  openedCount: number;
  openedAuthors: number;
  opened: ActivityIssueItem[];
  mergedCount: number;
  mergedAuthors: number;
  merged: ActivityIssueItem[];
}

/** The releases arm (upstream ActivityStats' release half). */
export interface ActivityReleaseStats {
  publishedCount: number;
  publishedAuthors: number;
  published: ActivityReleaseItem[];
}

/** The unresolved-conversations arm (upstream UnresolvedIssues). */
export interface ActivityUnresolvedStats {
  count: number;
  items: ActivityIssueItem[];
}

/** The page's loaded data — `null` arms are the unit-off reductions; the
 *  code arm is always loaded (the group's RequireUnitReader basis). */
export interface RepoActivityData {
  period: string;
  dateFrom: Date;
  dateUntil: Date;
  code: ActivityCodeCounts;
  issues: ActivityIssueStats | null;
  pulls: ActivityPullStats | null;
  releases: ActivityReleaseStats | null;
  unresolved: ActivityUnresolvedStats | null;
}

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

/** The issues arm's three SQL arms (upstream FillIssues:174-220 + activeIssues
 *  :255-262) — rows under the cap plus the exact count/author aggregates. */
async function loadIssueArm(d1: D1Database, repoId: string, from: Date): Promise<ActivityIssueStats> {
  const db = drizzle(d1);
  const openedWhere = and(eq(issues.repoId, repoId), eq(issues.isPull, false), gte(issues.createdAt, from));
  const closedWhere = and(
    eq(issues.repoId, repoId),
    eq(issues.isPull, false),
    eq(issues.isClosed, true),
    gte(issues.closedAt, from),
  );
  const activeWhere = and(
    eq(issues.repoId, repoId),
    eq(issues.isPull, false),
    or(gte(issues.createdAt, from), gte(issues.closedAt, from)),
  );
  const [openedRows, closedRows, activeAgg, openedAgg, closedAgg] = await Promise.all([
    db
      .select({ index: issues.index, title: issues.title, at: issues.createdAt })
      .from(issues)
      .where(openedWhere)
      .orderBy(asc(issues.createdAt))
      .limit(ACTIVITY_LIST_CAP),
    db
      .select({ index: issues.index, title: issues.title, at: issues.closedAt })
      .from(issues)
      .where(closedWhere)
      .orderBy(desc(issues.closedAt))
      .limit(ACTIVITY_LIST_CAP),
    db.select({ total: sql<number>`count(*)` }).from(issues).where(activeWhere),
    db
      .select({
        total: sql<number>`count(*)`,
        authors: sql<number>`count(distinct ${issues.posterId})`,
      })
      .from(issues)
      .where(openedWhere),
    db
      .select({
        total: sql<number>`count(*)`,
        authors: sql<number>`count(distinct ${issues.posterId})`,
      })
      .from(issues)
      .where(closedWhere),
  ]);
  return {
    activeCount: activeAgg[0]?.total ?? 0,
    openedCount: openedAgg[0]?.total ?? 0,
    openedAuthors: openedAgg[0]?.authors ?? 0,
    opened: openedRows.map((row) => ({ ...row, isPull: false })),
    closedCount: closedAgg[0]?.total ?? 0,
    closedAuthors: closedAgg[0]?.authors ?? 0,
    closed: closedRows.map((row) => ({ ...row, isPull: false })),
  };
}

/** The PRs arm (upstream FillPullRequests:148-220): the pull_request ⋈ issue
 *  join over the BASE repo, merged vs opened. */
async function loadPullArm(d1: D1Database, repoId: string, from: Date): Promise<ActivityPullStats> {
  const db = drizzle(d1);
  const openedWhere = and(
    eq(pullRequests.baseRepoId, repoId),
    eq(issues.isClosed, false),
    gte(issues.createdAt, from),
  );
  const mergedWhere = and(
    eq(pullRequests.baseRepoId, repoId),
    eq(pullRequests.hasMerged, true),
    gte(pullRequests.mergedAt, from),
  );
  const [openedRows, mergedRows, openedAgg, mergedAgg] = await Promise.all([
    db
      .select({ index: issues.index, title: issues.title, at: issues.createdAt })
      .from(pullRequests)
      .innerJoin(issues, eq(pullRequests.issueId, issues.id))
      .where(openedWhere)
      .orderBy(asc(issues.createdAt))
      .limit(ACTIVITY_LIST_CAP),
    db
      .select({ index: issues.index, title: issues.title, at: pullRequests.mergedAt })
      .from(pullRequests)
      .innerJoin(issues, eq(pullRequests.issueId, issues.id))
      .where(mergedWhere)
      .orderBy(desc(pullRequests.mergedAt))
      .limit(ACTIVITY_LIST_CAP),
    db
      .select({
        total: sql<number>`count(*)`,
        authors: sql<number>`count(distinct ${issues.posterId})`,
      })
      .from(pullRequests)
      .innerJoin(issues, eq(pullRequests.issueId, issues.id))
      .where(openedWhere),
    db
      .select({
        total: sql<number>`count(*)`,
        authors: sql<number>`count(distinct ${issues.posterId})`,
      })
      .from(pullRequests)
      .innerJoin(issues, eq(pullRequests.issueId, issues.id))
      .where(mergedWhere),
  ]);
  return {
    openedCount: openedAgg[0]?.total ?? 0,
    openedAuthors: openedAgg[0]?.authors ?? 0,
    opened: openedRows.map((row) => ({ ...row, isPull: true })),
    mergedCount: mergedAgg[0]?.total ?? 0,
    mergedAuthors: mergedAgg[0]?.authors ?? 0,
    merged: mergedRows.map((row) => ({ ...row, isPull: true })),
  };
}

/** The releases arm (upstream FillReleases:324-345): published (non-draft)
 *  rows with `published_unix ≥ from`, newest first. `publishedUnix` is the
 *  plain-seconds column (§3.2), so the cutoff rides the seconds form.
 *  `tagTips` is the repo's engine tag universe (the caller's one
 *  `tagTipsOf` read) — each row's `tagOid` gates its title link (the
 *  module doc's A3 note). */
async function loadReleaseArm(
  d1: D1Database,
  repoId: string,
  fromSeconds: number,
  tagTips: Map<string, string>,
): Promise<ActivityReleaseStats> {
  const db = drizzle(d1);
  const where = and(eq(releases.repoId, repoId), eq(releases.isDraft, false), gte(releases.publishedUnix, fromSeconds));
  const [rows, agg] = await Promise.all([
    db
      .select({
        tagName: releases.tagName,
        title: releases.title,
        isTag: releases.isTag,
        publishedUnix: releases.publishedUnix,
      })
      .from(releases)
      .where(where)
      .orderBy(desc(releases.publishedUnix))
      .limit(ACTIVITY_LIST_CAP),
    db
      .select({
        total: sql<number>`count(*)`,
        authors: sql<number>`count(distinct ${releases.publisherId})`,
      })
      .from(releases)
      .where(where),
  ]);
  return {
    publishedCount: agg[0]?.total ?? 0,
    publishedAuthors: agg[0]?.authors ?? 0,
    published: rows.map((row) => ({ ...row, tagOid: tagTips.get(row.tagName) ?? null })),
  };
}

/** The unresolved-conversations arm (upstream FillUnresolvedIssues:225-239):
 *  open, created BEFORE the window, updated WITHIN it; the is_pull filter
 *  narrows to the readable unit when only one of issues/PRs is on. */
async function loadUnresolvedArm(
  d1: D1Database,
  repoId: string,
  from: Date,
  unit: "both" | "issues" | "pulls",
): Promise<ActivityUnresolvedStats> {
  const db = drizzle(d1);
  const filters = [
    eq(issues.repoId, repoId),
    eq(issues.isClosed, false),
    lt(issues.createdAt, from),
    gte(issues.updatedAt, from),
  ];
  if (unit !== "both") filters.push(eq(issues.isPull, unit === "pulls"));
  const where = and(...filters);
  const [rows, agg] = await Promise.all([
    db
      .select({ index: issues.index, title: issues.title, isPull: issues.isPull, at: issues.updatedAt })
      .from(issues)
      .where(where)
      .orderBy(desc(issues.updatedAt))
      .limit(ACTIVITY_LIST_CAP),
    db.select({ total: sql<number>`count(*)` }).from(issues).where(where),
  ]);
  return { count: agg[0]?.total ?? 0, items: rows };
}

/**
 * Load the activity page's data. `null` = the 404 family: the engine RPC
 * answered null — a transport failure (the commits-page convention: upstream
 * ServerErrors 500, the documented divergence) or the default branch does
 * not exist / tip unpeelable (activity.go:51-60's `default_branch_not_exist`
 * NotFound arm — activityStats' unresolvable-ref null covers both). The D1
 * arms are unconditionally computable once the repo resolves; the unit
 * toggles drop whole arms.
 */
export async function loadRepoActivityData(
  env: Env,
  repo: RepoRow,
  periodSegment: string | null,
  options: { now?: Date },
): Promise<RepoActivityData | null> {
  const now = options.now ?? new Date();
  const { period, from } = parseActivityPeriod(periodSegment, now);

  // The code arm — the engine boundary RPC against the default branch
  // (activity.go:63-66's canReadCode arm; the code unit has no landed
  // toggle, so it is always read). The page's CANONICAL period feeds the
  // RPC (its internal re-normalization is the identity on the seven keys),
  // so the git counts and the D1 arms share one window even for unknown
  // segments; the RPC computes its own window start off the wall clock —
  // the sub-second skew against `from` is immaterial to the counts.
  const stats = await engineClient(env, `${repo.ownerNamespace}/${repo.slug}`).activityStats(repo.defaultBranch, period);
  if (stats === null) return null; // transport failure / default_branch_not_exist — the 404 family

  // The unit-gated D1 arms (upstream's GetActivityStats issue/PR/release
  // halves are D1 SQL — models/activities/repo_activity.go — they stay on
  // the landed stores). The releases arm also rides ONE engine tag-universe
  // read (the shared tagTipsOf — the releases list's exact helper) so each
  // row's title link is gated on the tag's git existence (the A3 fix);
  // skipped entirely when the unit is off.
  const settings = await loadRepoSettings(env.DB, repo.id);
  const tagTips = settings.hasReleases ? await tagTipsOf(env, repo) : new Map<string, string>();
  const [issueStats, pullStats, releaseStats] = await Promise.all([
    settings.hasIssues ? loadIssueArm(env.DB, repo.id, from) : Promise.resolve(null),
    settings.hasPullRequests ? loadPullArm(env.DB, repo.id, from) : Promise.resolve(null),
    settings.hasReleases
      ? loadReleaseArm(env.DB, repo.id, Math.floor(from.getTime() / 1000), tagTips)
      : Promise.resolve(null),
  ]);

  // The unresolved arm needs (issues OR pulls) readable, is_pull-narrowed to
  // the readable unit when only one is on (FillUnresolvedIssues' flags).
  let unresolved: ActivityUnresolvedStats | null = null;
  if (settings.hasIssues || settings.hasPullRequests) {
    unresolved = await loadUnresolvedArm(
      env.DB,
      repo.id,
      from,
      settings.hasIssues && settings.hasPullRequests ? "both" : settings.hasPullRequests ? "pulls" : "issues",
    );
  }

  return {
    period,
    dateFrom: from,
    dateUntil: now,
    code: {
      commitCount: stats.commitCount,
      authorCount: stats.authorCount,
      changedFiles: stats.changedFiles,
      additions: stats.additions,
      deletions: stats.deletions,
    },
    issues: issueStats,
    pulls: pullStats,
    releases: releaseStats,
    unresolved,
  };
}

// ---------------------------------------------------------------------------
// The render (pulse.tmpl)
// ---------------------------------------------------------------------------

/** Upstream `DateUtils.AbsoluteLong` ("January 01, 2006" — util_date.go:28)
 *  — UTC, hand-rolled so the bytes never depend on the runtime's ICU (the
 *  formatDueDate twin). */
export function formatAbsoluteLong(date: Date): string {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** Upstream TrN's English plural (locale_en-US's _1/_n pairs). */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The users suffix ("N user(s)"). */
function usersLabel(n: number): string {
  return `${n} ${plural(n, "user", "users")}`;
}

/** The period dropdown (pulse.tmpl:3-18): the floating jump dropdown; the
 *  official bundle enhances it. The active item follows the CANONICAL period
 *  (unknown segments render weekly active — activity.go's switch). */
function PeriodDropdown(props: { repoLink: string; period: string }) {
  return (
    <div class="ui floating dropdown jump">
      <div class="ui basic compact button">
        {activityLocale.filter_label} <strong>{periodLabel(props.period)}</strong>
      </div>
      <div class="left menu">
        {PERIODS.map((p) => (
          <a
            class={p.key === props.period ? "active item" : "item"}
            href={`${props.repoLink}/activity/${p.key}`}
          >
            {p.label}
          </a>
        ))}
      </div>
    </div>
  );
}

/** The overview's one column: the stats-table bar (the closed/merged share
 *  width = the percentage arm) + the active-count line
 *  (pulse.tmpl:24-57's shape). The share cell is purple on the PR column
 *  and red on the issues column (pulse.tmpl:29/46). */
function OverviewColumn(props: {
  barHref: string;
  barLabel: string;
  barAria: string;
  barPerc: number;
  barClass: string;
  count: number;
  countOne: string;
  countMany: string;
}) {
  return (
    <div class="column">
      {props.count > 0 ? (
        <div class="stats-table">
          {props.barPerc > 0 ? (
            <a
              href={props.barHref}
              class={`table-cell tiny ${props.barClass}`}
              style={`width: ${props.barPerc}%`}
              aria-label={props.barAria}
            />
          ) : null}
          <a href={props.barHref} class="table-cell tiny tw-bg-green" aria-label={props.barLabel} />
        </div>
      ) : (
        <div class="stats-table">
          <span class="table-cell tiny tw-bg-grey" aria-label={props.barLabel} />
        </div>
      )}
      <strong>{props.count}</strong> {plural(props.count, props.countOne, props.countMany)}
    </div>
  );
}

/** The overview's count card (pulse.tmpl:59-80): icon + count + label,
 *  anchored to its divider list. */
function CountCard(props: { href: string; icon: IconName; tone: string; count: number; label: string }) {
  return (
    <a href={props.href} class="ui attached segment text center">
      <span class={props.tone}>
        <Icon name={props.icon} />
      </span>{" "}
      <strong>{props.count}</strong>
      <br />
      {props.label}
    </a>
  );
}

/** One divider list row (pulse.tmpl's p.desc rows): the colored label, the
 *  #index, the title link, the relative time. The link's arm follows the
 *  row's isPull (pulse.tmpl:222-226 — the unresolved list mixes both). */
function ActivityRow(props: { repoLink: string; label: string; labelClass: string; item: ActivityIssueItem }) {
  const kind = props.item.isPull ? "pulls" : "issues";
  return (
    <p class="desc">
      <span class={`ui ${props.labelClass} label`}>{props.label}</span>#{props.item.index}{" "}
      <a class="title" href={`${props.repoLink}/${kind}/${props.item.index}`}>
        {props.item.title}
      </a>{" "}
      <TimeSince unixSeconds={Math.floor((props.item.at?.getTime() ?? 0) / 1000)} tz="+0000" />
    </p>
  );
}

/** The divider header (pulse.tmpl's h4.divider.divertext blocks — h3 per
 *  the §5.5 heading-skip reduction). */
function DividerHeader(props: { id: string; icon: IconName; children: Child }) {
  return (
    <h3 class="divider divider-text" id={props.id}>
      <Icon name={props.icon} /> {props.children}
    </h3>
  );
}

/** The code segment (pulse.tmpl:83-112): the counts sentence + the chart
 *  div, or the no-activity empty state. The empty-state gate and the
 *  sentence's all-branches arm are upstream's `CommitCountInAllBranches`
 *  renders (pulse.tmpl:84-88 and :97-98) — both omitted under the ratified
 *  M2a cut: the gate falls to the default-branch `commitCount`, the
 *  sentence's first arm ends at "to {branch}." (upstream's locale string
 *  "to %s and" feeds the dropped middle arm). */
function CodeSegment(props: { repo: RepoRow; code: ActivityCodeCounts }) {
  if (props.code.commitCount === 0) {
    return (
      <div class="ui tw-text-center segment">
        <h4 class="ui header">{activityLocale.no_git_activity}</h4>
      </div>
    );
  }
  return (
    <div class="ui attached segment horizontal segments">
      <div class="ui attached segment text">
        Excluding merges,{" "}
        <strong>
          {props.code.authorCount} {plural(props.code.authorCount, "author", "authors")}
        </strong>{" "}
        {plural(props.code.authorCount, "has pushed", "have pushed")}{" "}
        <strong>
          {props.code.commitCount} {plural(props.code.commitCount, "commit", "commits")}
        </strong>{" "}
        to {props.repo.defaultBranch}. On {props.repo.defaultBranch},{" "}
        <strong>
          {props.code.changedFiles} {plural(props.code.changedFiles, "file", "files")}
        </strong>{" "}
        {plural(props.code.changedFiles, "has changed", "have changed")} and there have been{" "}
        <strong class="tw-text-green">
          {props.code.additions} {plural(props.code.additions, "addition", "additions")}
        </strong>{" "}
        and{" "}
        <strong class="tw-text-red">
          {props.code.deletions} {plural(props.code.deletions, "deletion", "deletions")}
        </strong>
        .
      </div>
      <div class="ui attached segment">
        {/* pulse.tmpl:108 — the official bundle's chart mount point; the
            Vue app fetches the LANDED /activity_author_data feed. */}
        <div id="repo-activity-top-authors-chart" class="tw-h-[100px]" />
      </div>
    </div>
  );
}

/** The pulse page body (pulse.tmpl at the pin). */
export function RepoActivityPage(props: { ctx: UiContext; data: RepoActivityData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoActivityPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const activePRs = data.pulls === null ? 0 : data.pulls.openedCount + data.pulls.mergedCount;
  const mergedPerc = data.pulls === null || activePRs === 0 ? 0 : Math.floor((data.pulls.mergedCount / activePRs) * 100);
  const closedPerc =
    data.issues === null || data.issues.activeCount === 0
      ? 0
      : Math.floor((data.issues.closedCount / data.issues.activeCount) * 100);
  return (
    <BaseLayout ctx={ctx} title={activityLocale.page_title} pageClass="repository commits">
      <div class="ui container flex-container">
        <div class="flex-container-nav">
          {/* repo/navbar.tmpl:2-17 — the four-item strip (pulse + the three
              R15 chart pages, all LIVE); PageIsPulse active here. */}
          <RepoActivityNavMenu repoLink={repoLink} active="pulse" />
        </div>
        <div class="flex-container-main">
          <h2 class="ui header activity-header">
            <span>
              {formatAbsoluteLong(data.dateFrom)} - {formatAbsoluteLong(data.dateUntil)}
            </span>
            <PeriodDropdown repoLink={repoLink} period={data.period} />
          </h2>

          {data.pulls !== null || data.issues !== null ? (
            <>
              <h3 class="ui top attached header">{activityLocale.overview}</h3>
              <div class="ui attached segment two column grid">
                {data.pulls !== null ? (
                  <OverviewColumn
                    barHref="#merged-pull-requests"
                    barLabel="Merged pull requests"
                    barAria="Merged pull requests share"
                    barPerc={mergedPerc}
                    barClass="tw-bg-purple"
                    count={activePRs}
                    countOne="Active Pull Request"
                    countMany="Active Pull Requests"
                  />
                ) : null}
                {data.issues !== null ? (
                  <OverviewColumn
                    barHref="#closed-issues"
                    barLabel="Closed issues"
                    barAria="Closed issues share"
                    barPerc={closedPerc}
                    barClass="tw-bg-red"
                    count={data.issues.activeCount}
                    countOne="Active Issue"
                    countMany="Active Issues"
                  />
                ) : null}
              </div>
              <div class="ui attached segment horizontal segments">
                {data.pulls !== null ? (
                  <>
                    <CountCard
                      href="#merged-pull-requests"
                      icon="octicon-git-pull-request"
                      tone="tw-text-purple"
                      count={data.pulls.mergedCount}
                      label={plural(data.pulls.mergedCount, "Merged Pull Request", "Merged Pull Requests")}
                    />
                    <CountCard
                      href="#proposed-pull-requests"
                      icon="octicon-git-branch"
                      tone="tw-text-green"
                      count={data.pulls.openedCount}
                      label={plural(data.pulls.openedCount, "Proposed Pull Request", "Proposed Pull Requests")}
                    />
                  </>
                ) : null}
                {data.issues !== null ? (
                  <>
                    <CountCard
                      href="#closed-issues"
                      icon="octicon-issue-closed"
                      tone="tw-text-red"
                      count={data.issues.closedCount}
                      label={plural(data.issues.closedCount, "Closed Issue", "Closed Issues")}
                    />
                    <CountCard
                      href="#new-issues"
                      icon="octicon-issue-opened"
                      tone="tw-text-green"
                      count={data.issues.openedCount}
                      label={plural(data.issues.openedCount, "New Issue", "New Issues")}
                    />
                  </>
                ) : null}
              </div>
            </>
          ) : null}

          <CodeSegment repo={repo} code={data.code} />

          {data.releases !== null && data.releases.publishedCount > 0 ? (
            <>
              <DividerHeader id="published-releases" icon="octicon-tag">
                {data.releases.publishedCount} {plural(data.releases.publishedCount, "Release", "Releases")} published by{" "}
                {usersLabel(data.releases.publishedAuthors)}
              </DividerHeader>
              <div class="list">
                {data.releases.published.map((row) => (
                  <p class="desc">
                    <span class="ui green label">{activityLocale.published_label}</span>
                    {row.tagName}
                    {/* pulse.tmpl:126-130: the tag name plain, then the
                        title link for non-tag rows. The link emits our
                        MOUNTED /src/tag/{tag} shape — upstream's bare
                        /src/{tag} (pulse.tmpl:128) resolves only through
                        web.go:1755's deprecated catchall the UI router does
                        not claim — and renders only when the tag exists in
                        git (row.tagOid, the releases page's exact gating);
                        a D1-only release renders the title PLAIN (§2.4.1's
                        dead-link rule, the A3 fix). */}
                    {row.isTag ? null : row.tagOid !== null ? (
                      <>
                        {" "}
                        <a class="title" href={`${repoLink}/src/tag/${pathEscapeSegments(row.tagName)}`}>
                          {row.title === "" ? row.tagName : row.title}
                        </a>
                      </>
                    ) : row.title === "" ? null : (
                      <> {row.title}</>
                    )}{" "}
                    <TimeSince unixSeconds={row.publishedUnix} tz="+0000" />
                  </p>
                ))}
              </div>
            </>
          ) : null}

          {data.pulls !== null && data.pulls.mergedCount > 0 ? (
            <>
              <DividerHeader id="merged-pull-requests" icon="octicon-git-pull-request">
                {data.pulls.mergedCount} {plural(data.pulls.mergedCount, "Pull request", "Pull requests")} merged by{" "}
                {usersLabel(data.pulls.mergedAuthors)}
              </DividerHeader>
              <div class="list">
                {data.pulls.merged.map((item) => (
                  <ActivityRow repoLink={repoLink} label={activityLocale.merged_label} labelClass="purple" item={item} />
                ))}
              </div>
            </>
          ) : null}

          {data.pulls !== null && data.pulls.openedCount > 0 ? (
            <>
              <DividerHeader id="proposed-pull-requests" icon="octicon-git-branch">
                {data.pulls.openedCount} {plural(data.pulls.openedCount, "Pull request", "Pull requests")} proposed by{" "}
                {usersLabel(data.pulls.openedAuthors)}
              </DividerHeader>
              <div class="list">
                {data.pulls.opened.map((item) => (
                  <ActivityRow repoLink={repoLink} label={activityLocale.opened_pr_label} labelClass="green" item={item} />
                ))}
              </div>
            </>
          ) : null}

          {data.issues !== null && data.issues.closedCount > 0 ? (
            <>
              <DividerHeader id="closed-issues" icon="octicon-issue-closed">
                {data.issues.closedCount} {plural(data.issues.closedCount, "Issue", "Issues")} closed from{" "}
                {usersLabel(data.issues.closedAuthors)}
              </DividerHeader>
              <div class="list">
                {data.issues.closed.map((item) => (
                  <ActivityRow repoLink={repoLink} label={activityLocale.closed_label} labelClass="red" item={item} />
                ))}
              </div>
            </>
          ) : null}

          {data.issues !== null && data.issues.openedCount > 0 ? (
            <>
              <DividerHeader id="new-issues" icon="octicon-issue-opened">
                {data.issues.openedCount} {plural(data.issues.openedCount, "Issue", "Issues")} created by{" "}
                {usersLabel(data.issues.openedAuthors)}
              </DividerHeader>
              <div class="list">
                {data.issues.opened.map((item) => (
                  <ActivityRow repoLink={repoLink} label={activityLocale.new_issue_label} labelClass="green" item={item} />
                ))}
              </div>
            </>
          ) : null}

          {data.unresolved !== null && data.unresolved.count > 0 ? (
            <>
              <DividerHeader id="unresolved-conversations" icon="octicon-comment-discussion">
                {data.unresolved.count} {plural(data.unresolved.count, "Unresolved Conversation", "Unresolved Conversations")}
              </DividerHeader>
              <div class="list">
                {data.unresolved.items.map((item) => (
                  <ActivityRow repoLink={repoLink} label={activityLocale.unresolved_label} labelClass="green" item={item} />
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </BaseLayout>
  );
}

/** The serialized page (the releases module's renderPage shape). */
export function renderRepoActivityPage(ctx: UiContext, data: RepoActivityData): string {
  return renderPage(<RepoActivityPage ctx={ctx} data={data} />);
}

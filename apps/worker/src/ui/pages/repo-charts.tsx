/**
 * The repository ACTIVITY CHART pages — the census's R15 (the three tabs
 * hanging off the landed pulse surface):
 *
 *   GET /{owner}/{repo}/activity/contributors      web.go:1635 → repo.Contributors
 *   GET /{owner}/{repo}/activity/contributors/data web.go:1636 → repo.ContributorsData
 *   GET /{owner}/{repo}/activity/code-frequency    web.go:1639 → repo.CodeFrequency
 *   GET /{owner}/{repo}/activity/code-frequency/data  web.go:1640 → repo.CodeFrequencyData
 *   GET /{owner}/{repo}/activity/recent-commits    web.go:1643 → repo.RecentCommits
 *   GET /{owner}/{repo}/activity/recent-commits/data  web.go:1644 → repo.CodeFrequencyData
 *
 * Upstream registers the chart group INSIDE the /activity group
 * (web.go:1633-1646) — chi dispatches the static literals ahead of the
 * /{period} param (web.go:1631) — gated by the same group middleware
 * (`optSignIn, context.RepoAssignment, repo.MustBeNotEmpty,
 * context.RequireUnitReader(TypeCode, TypeIssues, TypePullRequests,
 * TypeReleases)` — web.go:1647-1649) plus `reqUnitCodeReader` on the
 * subgroup (web.go:1646): reading CODE is the chart group's extra demand.
 * Ours reduces to the shared visibility read (the repo-activity precedent —
 * the code unit has no landed toggle) plus the MustBeNotEmpty 404 shell.
 *
 * ## Upstream shape (submodule pin fc4936884584)
 *
 * All three handlers render the SAME template as the pulse —
 * `tplContributors/CodeFrequency/RecentCommits = "repo/activity"`
 * (contributors.go:16, code_frequency.go:16, recent_commits.go:14), armed
 * with `PageIsActivity` + their own `PageIs{Contributors,CodeFrequency,
 * RecentCommits}` discriminator. repo/activity.tmpl then renders the repo
 * header + flex-container + repo/navbar (the tab strip) + the per-page
 * chart template (activity.tmpl:9-12). Page titles are the navbar labels
 * (`repo.activity.navbar.contributors` = "Contributors" etc.);
 * CodeFrequency and RecentCommits additionally set
 * `ctx.PageData["repoLink"]` (code_frequency.go:25, recent_commits.go:23) —
 * the `window.config.pageData` payload their Vue components read
 * (services/context/context_template.go:162 wires PageData into
 * WindowConfig; services/context/context.go:53's comment).
 *
 * ## THE CHARTS ARE CLIENT-SIDE (the census's heatmap precedent)
 *
 * The SSR page's whole job is the DOM MOUNT: upstream's
 * templates/repo/contributors.tmpl emits `#repo-contributors-chart` with
 * `data-repo-link`/`data-repo-default-branch-name` + the locale
 * `data-locale-*` attributes; code_frequency.tmpl/recent_commits.tmpl emit
 * `#repo-code-frequency-chart`/`#repo-recent-commits-chart` with the
 * loading-locale attributes only. The official bundle's initRepoContributors
 * /initRepoCodeFrequency/initRepoRecentCommits (web_src/js/features/
 * contributors.ts:3-4, code-frequency.ts:3-4, recent-commits.ts:3-4 —
 * registered globally, index.ts:149-151) find the ids, read the attributes,
 * mount the Vue components (RepoContributors.vue, RepoCodeFrequency.vue,
 * RepoRecentCommits.vue), and the components fetch the `/data` routes and
 * draw chart.js charts. Upstream is equally chart-less without JS.
 *
 * pageData mechanism divergence (the module's one): upstream carries
 * `repoLink` inside the head's `#global-window-config` JSON; our shell's
 * WindowConfig has no per-page PageData channel yet (`pageData: null`,
 * shell.tsx), so the two pages that need it emit a small page-body inline
 * assignment `window.config.pageData = {"repoLink": …}`. Order-safe: the
 * config JSON is parsed by the HEAD iife (web_src/js/iife.ts:4 →
 * bootstrap.ts:5 — the ONLY bootstrap import; the body-tail module never
 * re-assigns window.config), so an inline body script runs between the head
 * parse and the bundle's init functions. The observable state at init time
 * (window.config.pageData.repoLink set) matches upstream exactly.
 *
 * ## The /data JSON contract (pinned from the Vue fetch parsers)
 *
 * All three data routes answer the SAME engine RPC — `contributorStats(ref)`
 * (SPEC-0015 M2b, the ../engine wrapper), upstream's GetContributorStats
 * (services/repository/contributors_graph.go:80):
 *
 * - **contributors/data** (`ContributorsData`, contributors.go:28-37) — the
 *   FULL `map[string]*ContributorData` (contributors_graph.go:46-58):
 *   `{"<email>": {name, login, avatar_link, home_link, total_commits,
 *   weeks}, "total": {…}}` where each `weeks` is
 *   `{[weekMsString]: {week, additions, deletions, commits}}` — Go marshals
 *   `map[int64]*WeekData` as a string-keyed JSON object, and the inline
 *   `week` field is LOAD-BEARING (the Vue reads `.week` from the VALUES —
 *   the dist-types' own note). RepoContributors.vue:151-158 fetches
 *   `${repoLink}/activity/contributors/data`, retries on 202, destructures
 *   `total` from the map, and reads per-contributor `name/avatar_link/
 *   home_link/weeks` (the email is the map KEY; `total_commits` per
 *   contributor is recomputed client-side from the weeks).
 * - **code-frequency/data** (`CodeFrequencyData`, code_frequency.go:31-40) —
 *   `contributorStats["total"].Weeks` ALONE (code_frequency.go:39): the
 *   total's weeks object (the DayDataObject). RepoCodeFrequency.vue:57-68
 *   fetches `${repoLink}/activity/code-frequency/data` and reads
 *   `Object.values(obj)[0].week` + `.additions`/`.deletions` per bucket.
 * - **recent-commits/data** — the SAME `CodeFrequencyData` handler
 *   (web.go:1644's comment: "recent-commits also uses the same data as
 *   code-frequency"): RepoRecentCommits.vue:54-64 fetches
 *   `${repoLink}/activity/recent-commits/data`, reads `.commits` per bucket
 *   and slices the LAST 52 weeks client-side (:64's `.slice(-52)`). So the
 *   recent-commits chart needs NO engine arm of its own — upstream reuses
 *   the full-history contributor fold verbatim; the "recent" cut is the
 *   client's `.slice(-52)`. FULL CUT, no honest-absent.
 *
 * Key ordering is Go-map-faithful, explicitly: encoding/json sorts map keys
 * byte-lexicographically, so the contributors map serves "total" among the
 * sorted emails, and every weeks object serves its decimal-string keys in
 * ascending NUMERIC order. The sort must be explicit — JS objects keep
 * INSERTION order for keys above 2^32 (epoch-ms keys get no array-index
 * numeric ordering), and the order is load-bearing: RepoCodeFrequency/
 * RepoRecentCommits read `Object.values(obj)[0].week` as the chart's start
 * (RepoContributors re-sorts total.weeks numerically itself), so an
 * insertion-ordered object would start the chart mid-history. All current
 * epoch-ms keys are 13 digits, so numeric ascending equals lexicographic
 * ascending — upstream's own guarantee.
 *
 * ## The downstream decorations (SPEC-0015 §3.2)
 *
 * The engine returns GIT identities only (email-keyed, `ContributorStats
 * Author.name` = the git author name); upstream's extras are assembled HERE
 * over D1, the activity-author-data idiom: each commit email maps through
 * GetUserByEmail (contributors_graph.go:229-233 — ours: one case-insensitive
 * `users.email` read, the usernamesByEmail convention; upstream's
 * activated-email_address and noreply arms stay the documented reduction),
 * and a MAPPED email's entry is re-keyed to the user's PRIMARY address and
 * merged with the user's other commit emails (:232's `userEmail =
 * u.GetEmail()` — one user's two commit emails fold into one
 * ContributorData, weeks included). Decorated fields (:236-252's arms):
 * `name` = DisplayName() (:248), `login` = LowerName (:249), `home_link` =
 * `/{username}` RELATIVE (:251, user.go:342-344), `avatar_link` =
 * AvatarLinkWithSize(bucket, 0) ABSOLUTE (:250, MakeAbsoluteURL — the
 * activity-author-data chain verbatim); unmapped emails keep the git author
 * name (:237-239's GenerateEmailAvatarFastLink-or-ghost arm → under the
 * frozen DISABLE_GRAVATAR posture the bundled default, models/avatars/
 * avatar.go) with `login`/`home_link` empty. The `"total"` pseudo-entry
 * (name "Total", empty decorations) sums every author's weeks and
 * totalCommits (:216-219 creation + :271-288 accumulation).
 *
 * ## Postures
 *
 * - **No 202 arm** — upstream's cache-miss posture starts an ASYNC
 *   generation and answers `ErrAwaitGeneration` → 202 when the 5-second
 *   await expires (contributors_graph.go:87-99; both data handlers map it
 *   to `ctx.Status(202)` — contributors.go:31, code_frequency.go:34); the
 *   Vue retries every second. Our RPC computes
 *   synchronously under budget and never 202s (the ratified no-pre-warm
 *   posture — the SPEC's Open question 3): the chart's first fetch gets the
 *   complete-or-truncated answer directly. The engine's `truncated` flag
 *   (MAX_STATS_SCAN exit) has no upstream counterpart to marshal — the fold
 *   is then the newest window's, the ledgered divergence, flagged here
 *   only.
 * - **404 family** — the DATA routes' loader null (unresolvable ref/
 *   transport failure — the aux-JSON convention) 404-shells; upstream would
 *   ServerError 500 on the same arm (the documented divergence, the
 *   activity-author-data pattern). Empty repos 404 at the handler
 *   (MustBeNotEmpty, web.go:1648) before any RPC. The PAGES never touch git
 *   (upstream's three handlers render the template unconditionally — the
 *   IsBranchExist 404 arm lives in repo.Activity alone, activity.go:51-60),
 *   so a non-empty row with a missing default branch still mounts the chart
 *   shell; the chart's own fetch reports the failure client-side.
 * - **Headers** — `application/json;charset=utf-8` + the middleware's
 *   zero-option prod `Cache-Control: max-age=0, private, must-revalidate`
 *   (services/context/base.go:115-117, modules/httpcache/httpcache.go:31-33
 *   — the activity-author-data precedent pair; the charts refetch per page
 *   view).
 * - **DOM contract** — the four-item tab strip (repo/navbar.tmpl:2-17:
 *   Pulse + the three chart items gated on the code unit — always readable
 *   for us, all four LIVE since this family landed), the chart divs
 *   verbatim, and `page-content repository commits` (activity.tmpl:2).
 */

import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Child } from "hono/jsx";

import type { ContributorStatsResult } from "@cf-gitea/git-engine";

import { avatarLinkWithSize, defaultAvatarLink } from "../../services/avatars";
import { users } from "../../db/schema";
import { engineClient } from "../engine";
import { pathEscapeSegments } from "../page-data";
import { BaseLayout, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Locale (component-local, the activityLocale pattern — the strings cite
// locale_en-US.json's repo.activity.navbar + graphs + repo.contributors
// blocks).
// ---------------------------------------------------------------------------

export const repoChartsLocale = {
  navbar_pulse: "Pulse", // "repo.activity.navbar.pulse"
  navbar_contributors: "Contributors", // "repo.activity.navbar.contributors"
  navbar_code_frequency: "Code Frequency", // "repo.activity.navbar.code_frequency"
  navbar_recent_commits: "Recent Commits", // "repo.activity.navbar.recent_commits"
  filter_label: "Contribution type:", // "repo.contributors.contribution_type.filter_label"
  contribution_commits: "Commits", // "repo.contributors.contribution_type.commits"
  contribution_additions: "Additions", // "repo.contributors.contribution_type.additions"
  contribution_deletions: "Deletions", // "repo.contributors.contribution_type.deletions"
  loading_contributions: "Loading contributions…", // "graphs.component_loading" (graphs.contributors.what)
  loading_failed_contributions: "Could not load contributions", // "graphs.component_loading_failed"
  loading_code_frequency: "Loading code frequency…", // "graphs.code_frequency.what"
  loading_failed_code_frequency: "Could not load code frequency", // "graphs.component_loading_failed"
  loading_recent_commits: "Loading recent commits…", // "graphs.recent_commits.what"
  loading_failed_recent_commits: "Could not load recent commits", // "graphs.component_loading_failed"
  loading_info: "This might take a bit…", // "graphs.component_loading_info"
  component_failed: "An unexpected error happened.", // "graphs.component_failed_to_load"
  chart_zoom_hint: "drag: zoom, shift+drag: pan, double click: reset zoom", // "graphs.chart_zoom_hint"
} as const;

/** The chart-page kind (the tab strip's active arm + the /data shape). */
export type RepoChartKind = "contributors" | "code-frequency" | "recent-commits";

/**
 * The activity tab strip (repo/navbar.tmpl at the pin): the four-item
 * vertical menu — Pulse + the three chart items, gated upstream on
 * `$canReadCode` (navbar.tmpl:1 — the code unit toggle; ours always
 * readable, so the four items always render). `active` picks the
 * `PageIs{Pulse,Contributors,CodeFrequency,RecentCommits}` arm; one copy
 * serves the pulse page and all three chart pages.
 */
export function RepoActivityNavMenu(props: { repoLink: string; active: "pulse" | RepoChartKind }) {
  const item = (key: "pulse" | RepoChartKind, href: string, label: string) => (
    <a class={props.active === key ? "active item" : "item"} href={href}>
      {label}
    </a>
  );
  return (
    <div class="ui fluid vertical menu">
      {item("pulse", `${props.repoLink}/activity`, repoChartsLocale.navbar_pulse)}
      {item("contributors", `${props.repoLink}/activity/contributors`, repoChartsLocale.navbar_contributors)}
      {item("code-frequency", `${props.repoLink}/activity/code-frequency`, repoChartsLocale.navbar_code_frequency)}
      {item("recent-commits", `${props.repoLink}/activity/recent-commits`, repoChartsLocale.navbar_recent_commits)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The pages (the shared repo/activity shell + the three mount templates)
// ---------------------------------------------------------------------------

/** The window.config.pageData payload the two PageData-armed pages emit
 *  (services/context/context.go:53 — "PageData is used by JavaScript
 *  modules, it is `window.config.pageData`"). The escaping is
 *  serializeWindowConfig's (the `</script>` guarantee). */
export function serializeChartPageData(pageData: { repoLink: string }): string {
  return JSON.stringify(pageData)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

/** The shared page frame (repo/activity.tmpl): the repo header + the
 *  flex-container + the tab strip + the chart mount. `title` is the
 *  navbar-label page title; the mount is the per-page template's verbatim
 *  div. */
function ChartPageFrame(props: { ctx: UiContext; title: string; active: RepoChartKind; children: Child }) {
  const repo = props.ctx.repo;
  if (repo === undefined) throw new Error("ChartPageFrame requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={props.ctx} title={props.title} pageClass="repository commits">
      <div class="ui container flex-container">
        <div class="flex-container-nav">
          <RepoActivityNavMenu repoLink={repoLink} active={props.active} />
        </div>
        <div class="flex-container-main">{props.children}</div>
      </div>
    </BaseLayout>
  );
}

/** GET …/activity/contributors (repo.Contributors, contributors.go:20-26 →
 *  templates/repo/contributors.tmpl): the div + repoLink/default-branch +
 *  the contributors locale set. No PageData — upstream arms none here. */
export function RepoContributorsPage(props: { ctx: UiContext }) {
  const repo = props.ctx.repo;
  if (repo === undefined) throw new Error("RepoContributorsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <ChartPageFrame ctx={props.ctx} title={repoChartsLocale.navbar_contributors} active="contributors">
      <div
        id="repo-contributors-chart"
        data-repo-link={repoLink}
        data-repo-default-branch-name={repo.defaultBranch}
        data-locale-filter-label={repoChartsLocale.filter_label}
        data-locale-contribution-type-commits={repoChartsLocale.contribution_commits}
        data-locale-contribution-type-additions={repoChartsLocale.contribution_additions}
        data-locale-contribution-type-deletions={repoChartsLocale.contribution_deletions}
        data-locale-loading-title={repoChartsLocale.loading_contributions}
        data-locale-loading-title-failed={repoChartsLocale.loading_failed_contributions}
        data-locale-loading-info={repoChartsLocale.loading_info}
        data-locale-component-failed-to-load={repoChartsLocale.component_failed}
        data-locale-chart-zoom-hint={repoChartsLocale.chart_zoom_hint}
      />
    </ChartPageFrame>
  );
}

/** GET …/activity/code-frequency (repo.CodeFrequency, code_frequency.go:20-26
 *  → templates/repo/code_frequency.tmpl): the div + the PageData repoLink
 *  (code_frequency.go:24 — the Vue reads `window.config.pageData.repoLink`). */
export function RepoCodeFrequencyPage(props: { ctx: UiContext }) {
  const repo = props.ctx.repo;
  if (repo === undefined) throw new Error("RepoCodeFrequencyPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <ChartPageFrame ctx={props.ctx} title={repoChartsLocale.navbar_code_frequency} active="code-frequency">
      <script
        dangerouslySetInnerHTML={{
          __html: `window.config.pageData = ${serializeChartPageData({ repoLink })};`,
        }}
      />
      <div
        id="repo-code-frequency-chart"
        data-locale-loading-title={repoChartsLocale.loading_code_frequency}
        data-locale-loading-title-failed={repoChartsLocale.loading_failed_code_frequency}
        data-locale-loading-info={repoChartsLocale.loading_info}
        data-locale-component-failed-to-load={repoChartsLocale.component_failed}
      />
    </ChartPageFrame>
  );
}

/** GET …/activity/recent-commits (repo.RecentCommits, recent_commits.go:18-24
 *  → templates/repo/recent_commits.tmpl): the div + the PageData repoLink
 *  (recent_commits.go:22). The chart itself reuses the code-frequency data. */
export function RepoRecentCommitsPage(props: { ctx: UiContext }) {
  const repo = props.ctx.repo;
  if (repo === undefined) throw new Error("RepoRecentCommitsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <ChartPageFrame ctx={props.ctx} title={repoChartsLocale.navbar_recent_commits} active="recent-commits">
      <script
        dangerouslySetInnerHTML={{
          __html: `window.config.pageData = ${serializeChartPageData({ repoLink })};`,
        }}
      />
      <div
        id="repo-recent-commits-chart"
        data-locale-loading-title={repoChartsLocale.loading_recent_commits}
        data-locale-loading-title-failed={repoChartsLocale.loading_failed_recent_commits}
        data-locale-loading-info={repoChartsLocale.loading_info}
        data-locale-component-failed-to-load={repoChartsLocale.component_failed}
      />
    </ChartPageFrame>
  );
}

/** The three serialized pages (renderPage shape). */
export function renderRepoContributorsPage(ctx: UiContext): string {
  return renderPage(<RepoContributorsPage ctx={ctx} />);
}
export function renderRepoCodeFrequencyPage(ctx: UiContext): string {
  return renderPage(<RepoCodeFrequencyPage ctx={ctx} />);
}
export function renderRepoRecentCommitsPage(ctx: UiContext): string {
  return renderPage(<RepoRecentCommitsPage ctx={ctx} />);
}

// ---------------------------------------------------------------------------
// The /data JSON (the Vue parsers' pinned shapes)
// ---------------------------------------------------------------------------

/** One week bucket — upstream `WeekData` (contributors_graph.go:36-43); the
 *  field order is the Go struct's marshal order. `week` is the Sunday's
 *  Unix MILLISECOND timestamp, inlined because JSON object keys are
 *  strings (the Vue reads `.week` from the values). */
export interface ChartWeekJson {
  week: number;
  additions: number;
  deletions: number;
  commits: number;
}

/** One contributor entry — upstream `ContributorData`
 *  (contributors_graph.go:45-58); the field order is the Go marshal order. */
export interface ContributorDataJson {
  name: string;
  login: string;
  avatar_link: string;
  home_link: string;
  total_commits: number;
  weeks: Record<string, ChartWeekJson>;
}

/** The engine's weeks record re-keyed to Go's JSON shape: decimal-string
 *  keys in ASCENDING NUMERIC order, each value carrying the inline `week`
 *  (load-bearing — the Vue reads it from the VALUES). The explicit sort is
 *  load-bearing twice: JS objects keep INSERTION order for keys above 2^32
 *  (no array-index numeric ordering for epoch-ms keys), and Go's
 *  encoding/json serves map keys sorted — RepoCodeFrequency/RepoRecentCommits
 *  read `Object.values(obj)[0].week` as the chart's start, so an unsorted
 *  object would clip the history. */
function weeksToJson(weeks: ContributorStatsResult["contributors"][string]["weeks"]): Record<string, ChartWeekJson> {
  const out: Record<string, ChartWeekJson> = {};
  for (const key of Object.keys(weeks).sort((a, b) => Number(a) - Number(b))) {
    const bucket = weeks[Number(key)];
    if (bucket === undefined) continue;
    out[key] = { week: bucket.week, additions: bucket.additions, deletions: bucket.deletions, commits: bucket.commits };
  }
  return out;
}

/** Re-emit a folded weeks record in ascending numeric key order (the
 *  total-arms' folds accumulate across authors — insertion order is fold
 *  order, not chronological). */
function sortedWeeks(weeks: Record<string, ChartWeekJson>): Record<string, ChartWeekJson> {
  const out: Record<string, ChartWeekJson> = {};
  for (const key of Object.keys(weeks).sort((a, b) => Number(a) - Number(b))) {
    out[key] = weeks[key] as ChartWeekJson;
  }
  return out;
}

/** Sum one bucket into the total's fold (contributors_graph.go:292-297's
 *  total arms). */
function addWeek(total: Record<string, ChartWeekJson>, week: ChartWeekJson): void {
  const key = String(week.week);
  const slot = total[key];
  if (slot === undefined) {
    total[key] = { ...week };
  } else {
    slot.additions += week.additions;
    slot.deletions += week.deletions;
    slot.commits += week.commits;
  }
}

/** The users row slice the decoration chain reads (the
 *  activity-author-data idiom's exact subset). */
type ChartUserRow = Pick<
  typeof users.$inferSelect,
  "id" | "username" | "usernameLower" | "email" | "displayName" | "fullName" | "avatarEmail" | "useCustomAvatar"
>;

/** Upstream `u.DisplayName()` (user.go:476-482) — the activity-author-data
 *  helper's twin: the settings-form full name, else the legacy fullName,
 *  else the username. */
function chartDisplayName(row: ChartUserRow): string {
  const full = (row.displayName ?? row.fullName ?? "").trim();
  return full === "" ? row.username : full;
}

/** The engine answer plus the resolved user rows — the loaders' shared
 *  prologue. `null` = the 404 family (unresolvable ref/transport failure —
 *  the module header's posture). */
async function loadStatsWithUsers(
  env: Env,
  repo: RepoRow,
  options: { emails: (result: ContributorStatsResult) => string[] },
): Promise<{ result: ContributorStatsResult; userByEmail: Map<string, ChartUserRow> } | null> {
  const result = await engineClient(env, `${repo.ownerNamespace}/${repo.slug}`).contributorStats(repo.defaultBranch);
  if (result === null) return null;
  const emails = options.emails(result);
  const rows: ChartUserRow[] =
    emails.length === 0
      ? []
      : await drizzle(env.DB)
          .select({
            id: users.id,
            username: users.username,
            usernameLower: users.usernameLower,
            email: users.email,
            displayName: users.displayName,
            fullName: users.fullName,
            avatarEmail: users.avatarEmail,
            useCustomAvatar: users.useCustomAvatar,
          })
          .from(users)
          .where(inArray(sql`lower(${users.email})`, emails))
          .all();
  const userByEmail = new Map<string, ChartUserRow>();
  for (const row of rows) {
    if (row.email !== null) userByEmail.set(row.email.toLowerCase(), row);
  }
  return { result, userByEmail };
}

/** Decorate one author entry (contributors_graph.go:236-252's arms):
 *  mapped users get the DisplayName/login/home_link/avatar quartet;
 *  unmapped emails keep the git author name, empty login/home_link, and
 *  the default avatar (the frozen DISABLE_GRAVATAR posture — the
 *  activity-author-data ghost arm). */
async function decorateContributor(
  env: Env,
  origin: string,
  gitName: string,
  user: ChartUserRow | undefined,
  entry: ContributorDataJson,
): Promise<void> {
  entry.name = user === undefined ? gitName : chartDisplayName(user);
  entry.login = user === undefined ? "" : user.usernameLower;
  entry.home_link = user === undefined ? "" : `/${pathEscapeSegments(user.username)}`;
  const link = user === undefined ? defaultAvatarLink() : await avatarLinkWithSize(env.REPO_PACKS, user, 0);
  entry.avatar_link = new URL(link, origin).toString();
}

/**
 * Load the CONTRIBUTORS map (`ContributorsData` — the full map with the
 * "total" pseudo-entry, contributors_graph.go:41-58 + :247-252). `null` =
 * the 404 family. The email → primary-email merge folds each user's commit
 * emails into ONE entry keyed by the lowercase primary address
 * (contributors_graph.go:231-239's `userEmail = u.GetEmail()` normalization
 * — weeks and totalCommits travel with it); unmapped emails stay
 * their-own entries keyed by the commit email. Keys serve Go-map sorted
 * (encoding/json's byte-lexicographic order, "total" among them).
 */
export async function loadRepoContributorsData(
  env: Env,
  repo: RepoRow,
  options: { origin: string },
): Promise<Record<string, ContributorDataJson> | null> {
  const loaded = await loadStatsWithUsers(env, repo, {
    emails: (result) => Object.keys(result.contributors),
  });
  if (loaded === null) return null;
  const { result, userByEmail } = loaded;

  // The fold: per-user primary-email keys merge; the "total" pseudo-entry
  // accumulates every author's buckets (its decorations stay the Go zero
  // values, upstream's literal arm — name "Total", empty strings).
  const entries = new Map<string, ContributorDataJson>();
  const gitNames = new Map<string, string>(); // primary key → the git author name (first seen wins, upstream's entry-creation arm)
  const totalWeeks: Record<string, ChartWeekJson> = {};
  let totalCommits = 0;

  for (const [commitEmail, author] of Object.entries(result.contributors)) {
    const user = userByEmail.get(commitEmail.toLowerCase());
    const key = user === undefined ? commitEmail : (user.email ?? commitEmail).toLowerCase();
    const weeks = weeksToJson(author.weeks);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = { name: "", login: "", avatar_link: "", home_link: "", total_commits: 0, weeks: {} };
      entries.set(key, entry);
      gitNames.set(key, author.name);
    }
    entry.total_commits += author.totalCommits;
    for (const week of Object.values(weeks)) addWeek(entry.weeks, week);
    totalCommits += author.totalCommits;
    for (const week of Object.values(weeks)) addWeek(totalWeeks, week);
  }

  // The decorations ride the ONE avatar-chain walk per entry (the
  // activity-author-data Promise.all idiom).
  await Promise.all(
    [...entries.entries()].map(async ([key, entry]) => {
      await decorateContributor(env, options.origin, gitNames.get(key) ?? "", userByEmail.get(key), entry);
    }),
  );

  // The "total" pseudo-entry LAST in the fold, then the whole map served
  // byte-sorted (Go's map marshal) with every weeks record chronological
  // (sortedWeeks — the Vue's Object.values()[0] start read).
  entries.set("total", {
    name: "Total",
    login: "",
    avatar_link: "",
    home_link: "",
    total_commits: totalCommits,
    weeks: sortedWeeks(totalWeeks),
  });

  const out: Record<string, ContributorDataJson> = {};
  for (const key of [...entries.keys()].sort()) {
    const entry = entries.get(key) as ContributorDataJson;
    out[key] = { ...entry, weeks: sortedWeeks(entry.weeks) };
  }
  return out;
}

/**
 * Load the CODE-FREQUENCY answer — the TOTAL's weeks object alone
 * (`contributorStats["total"].Weeks`, code_frequency.go:41-43), the shape
 * recent-commits/data reuses verbatim (web.go:1647's same-handler note).
 * `null` = the 404 family. No decorations: the shape carries no identity.
 */
export async function loadChartFrequencyData(
  env: Env,
  repo: RepoRow,
): Promise<Record<string, ChartWeekJson> | null> {
  const result = await engineClient(env, `${repo.ownerNamespace}/${repo.slug}`).contributorStats(repo.defaultBranch);
  if (result === null) return null;
  const total: Record<string, ChartWeekJson> = {};
  for (const author of Object.values(result.contributors)) {
    for (const week of Object.values(weeksToJson(author.weeks))) addWeek(total, week);
  }
  return sortedWeeks(total);
}

/** The /data Response — ctx.JSON's `application/json;charset=utf-8`
 *  (services/context/base.go:115-117) plus the middleware's zero-option prod
 *  Cache-Control (modules/httpcache/httpcache.go:31-33 — the
 *  activity-author-data precedent pair). */
export function chartDataResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}

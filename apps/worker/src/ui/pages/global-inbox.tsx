/**
 * The GLOBAL INBOX pages — the signed-in user's cross-repo issue views:
 * `/issues`, `/pulls` and `/milestones` (pages wave 75; MOUNTED at
 * a8818c6, window-2e C1 — the routes live in `index.ts`; the retired
 * wiring HANDOFF is the mount record below). Upstream `user.Issues` /
 * `user.Pulls` /
 * `user.Milestones` (routers/web/user/home.go:329-348, 139-327), registered
 * in the reqSignIn top-level group (routers/web/web.go:567-573:
 * `m.Group("/issues", func() { m.Get("", user.Issues) … })` at :567-570,
 * `m.Get("/pulls", reqSignIn, user.Pulls)` at :572 and `m.Get("/milestones",
 * reqSignIn, reqMilestonesDashboardPageEnabled, user.Milestones)` at :573;
 * the gate defaults on — `Service.ShowMilestonesDashboardPage`,
 * modules/setting/service.go:166 — and is not a landed setting). Issues and
 * Pulls share ONE handler, `buildIssueOverview` (home.go:352-625) over
 * `unit.TypeIssues` / `unit.TypePullRequests`, and ONE template (`tplIssues`
 * = "user/dashboard/issues", home.go:51-52; the pulls page renders the same
 * template with `.PageIsPulls` set); milestones render
 * "user/dashboard/milestones" (home.go:325).
 *
 * ## Mount record (MOUNTED at a8818c6 — the wiring HANDOFF is retired)
 *
 * - The module is complete end-to-end: `loadOverviewIssuesData` (BOTH the
 *   /issues and /pulls arms — dispatch on `listKind`),
 *   `loadDashboardMilestonesData`, and the full-document renders
 *   `renderOverviewIssuesPage` / `renderDashboardMilestonesPage`. Each
 *   route arm is: `resolveUiSession(c)` → anonymous viewer →
 *   `respond(loginRedirect(url.pathname))` (upstream reqSignIn — the
 *   notifications-page handler's exact shape, pages/notifications.tsx's
 *   mount) → call the loader with the request's `URLSearchParams` →
 *   `respond(c.html(render…(ctx, data), 200))`. No route-side projection.
 * - The top-level literal heads `issues`, `pulls`, `milestones` are
 *   claimed by this mount (distinct from the repo-scoped
 *   `/:owner/:repo/issues|pulls|milestones` families — a
 *   different literal family, no collision); the session gate 303s
 *   anonymous requests onto the login round-trip before any loader runs.
 * - Upstream has no past-the-end redirect on any of the three pages (the
 *   pager just renders empty beyond the last page) — matched: a past-end
 *   `?page=` renders the empty-list line under an absent pager.
 * - The loaders narrow the viewer to the signed-in slice (throw on
 *   anonymous — upstream reqSignIn guarantees the route never calls them
 *   anonymously).
 *
 * ## The cross-repo scope (the survey's perm filter)
 *
 * `buildIssueOverview` scopes repos via `SearchRepoIDs`
 * (home.go:455-472): `SearchRepoOptions{Actor: doer, OwnerID: ctxUser.ID,
 * Private: true, Collaborate: optional.None, Archived: optional.Some(false)}`
 * — for the personal scope (this module; the org/team scope of
 * web.go:986-991 is a different route family) that is the repos the doer
 * OWNS ∪ collaborates on, non-archived; and for every arm but
 * `your_repositories`, `opts.AllPublic = true` (home.go:474-481) extends
 * the scope with ALL PUBLIC repos ("the doer may create issues or be
 * mentioned in any public repo"). Re-issued here as one SQL conjunct over
 * the joined `repositories` (+`users` for the public arm):
 *
 * - owned ∨ collaborated: `repositories.owner_id = doer` ∨ EXISTS over the
 *   landed `repo_collaborators` edges — the same two read paths the
 *   dashboard uses (dashboard.tsx's owner page + the collaboration table
 *   the collaborator service maintains, services/repo-collaborators.ts).
 * - the AllPublic arm reduces to the SHARED `readGrant` public shape in
 *   SQL — `visibleRepoGrantSql` (pages/notification-subscriptions.tsx,
 *   "readGrant in SQL (the dashboard posture)") verbatim minus its
 *   owner-id arm: public repo + active owner + public/limited owner
 *   visibility (git-http/acl.ts readGrant's publiclyVisible + limited
 *   arms). A site admin drops the repo-scope conjunct on the extended
 *   arms (readGrant's isSiteAdmin arm — every row grants).
 * - the non-archived conjunct applies to the whole scope (upstream's
 *   `Archived: optional.Some(false)` on the primary repo set; the
 *   AllPublic extension's archived handling is not observable in the
 *   landed projection).
 *
 * The milestones page scopes identically (home.go:158-174: the same
 * `SearchRepoOptions` shape — owned ∪ collaborated, non-archived — plus
 * `HasMilestones: true` for the sidebar repo list only; no AllPublic arm).
 *
 * ## Filters (home.go:352-625 buildIssueOverview + 139-327 Milestones)
 *
 * - `?type=` → the view arm (home.go:372-389): `your_repositories`
 *   (default), `assigned`, `created_by`, `review_requested`,
 *   `reviewed_by`, `mentioned`. The `mentioned` arm has NO landed source
 *   (upstream's `issue_users` IsMentioned table is not landed) — the parse
 *   degrades it to the default arm and the nav item is not rendered (no
 *   dead UI, §2.4.1; the parseIssueSort default-arm pattern).
 *   `review_requested` / `reviewed_by` ride the landed `pull_reviews`
 *   table (a request IS a `type=4` review row — the schema header cites
 *   review.go:697-770): requests = type 4 ∧ reviewer = doer ∧ not
 *   dismissed; reviewed = types 1/2/3 ∧ reviewer = doer. Team-request
 *   rows (`reviewer_team_id > 0`) are not matched (the team-membership
 *   join is not wired here) — documented reduction.
 * - `?state=` open|closed (default open; no "all" tab — upstream always
 *   filters one state, home.go:497-499). `?sort=` the eight upstream
 *   orders, DEFAULT `recentupdate` for the dashboard pages
 *   (home.go:368-369 `util.IfZero(…, "recentupdate")` — unlike the repo
 *   lists). `?q=` keyword reduces to the landed LIKE arms
 *   (services/issues.ts issueFilterConditions keyword shape — title ∨
 *   content, case-insensitive; upstream's indexer fuzz is not landed).
 * - `?labels=` comma ids — the subscriptions parser's exact semantics
 *   (absent/""/"0" → no filter; any unparseable entry drops the filter;
 *   negatives exclude; the applyLabelsCondition all-attached /
 *   not-attached SQL). `?poster=` / `?assignee=` usernames resolve via
 *   `GetFilterUserIDByName` (routers/web/shared/user/helper.go:60-74):
 *   "" → no filter, a username → its id, a numeric string → that id, an
 *   unknown name → match-nothing ("(none)" upstream). On the
 *   `created_by`/`assigned` arms the arm OVERRIDES the matching param
 *   (home.go:489-499 sets PosterID/AssigneeID after the param read).
 * - Milestones: `?state=`, `?q=` (case-insensitive name LIKE —
 *   BuildCaseInsensitiveLike, the landed listRepoMilestones arm),
 *   `?sort=` the template's seven values + ToOrders' `id` arm
 *   (models/issues/milestone_list.go:78-92; default/`closestduedate` =
 *   deadline ASC, name ASC; note `name` sorts name DESC — verbatim),
 *   `?repos=[a,b,]` the toggle filter. DIVERGENCE: upstream's ids are
 *   int64s under `issueReposQueryPattern` = `^\[\d+(,\d+)*,?\]$`
 *   (home.go:352); the landed `repositories.id` is a UUID string, so the
 *   parser accepts the bracket shape over non-empty id TOKENS
 *   (`^\[\S+(,\S+)*,?\]$`, ""/"0" entries skipped, the same liberal
 *   per-entry handling as home.go:189-199) and the sidebar emits our
 *   string ids in the same bracket form.
 *
 * ## DOM contracts (templates/user/dashboard/{issues,milestones,navbar}.tmpl
 *  + shared/issuelist.tmpl `listType "dashboard"` + shared/issueicon.tmpl +
 *  base/paginate.tmpl at the pin)
 *
 * - Issues/pulls: `.page-content.dashboard.issues` (issues.tmpl:4 — BOTH
 *   lists; the template carries no pulls-specific class), the
 *   `user/dashboard/navbar` reduced (below), then `.ui.container >
 *   .flex-container` with `.flex-container-nav` (the
 *   `ui.secondary.vertical.filter.menu` type arms, each anchor carrying
 *   its `<strong>count</strong>`) and `.flex-container-main.content`
 *   (issues.tmpl:34) — the `.list-header` (open/closed toggle tabs + the
 *   `list-header-search` GET form with hidden type/sort/state and the `q`
 *   input) over the shared issuelist at `listType "dashboard"` (the row's
 *   index form is `{owner}/{repo}#{index}` — issuelist.tmpl:44-45) and
 *   `base/paginate` (the landed Newer/Older shape).
 * - Milestones: `.page-content.dashboard.issues.repository.milestones`
 *   (milestones.tmpl:4), the navbar, then the flex split with the nav
 *   menu carrying the "In your repositories" total item + a `.divider` +
 *   one `.repo.name.item` per milestone-bearing repo (full-name span +
 *   the `ui.green/red.label` state-filtered count, active when in the
 *   current `?repos=` set) and `.flex-container-main` — the toggle tabs
 *   (octicon-milestone / octicon-check) + the search form (hidden
 *   type/repos/sort/state) + the rows: the `.ui.large.label` repo full
 *   name, the milestone glyph + the name linking the LANDED milestone
 *   detail page (`/{owner}/{repo}/milestone/{id}`), the completeness pair,
 *   the open/closed counts, the updated stamp and the due-date line (the
 *   repo milestones row's vocabulary — pages/milestones.tsx's locale and
 *   due-date formatter, reused — at the cross-repo projection).
 * - The navbar (dashboard/navbar.tmpl) reduces to the context-user
 *   switcher's SELF item: upstream renders the org right-menu tabs
 *   (Activities/Issues/Pulls/Milestones) ONLY for `{{if
 *   .ContextUser.IsOrganization}}` — the personal context renders the
 *   switcher alone, whose self anchor links the current page kind
 *   (navbar.tmpl:16-28). The org switcher/team filter need the org list —
 *   the dashboard.tsx degradation, not re-litigated here.
 *
 * ## Documented v1 reductions (§6 method — no dead controls, no invented data)
 *
 * - The Sort dropdown and the Labels/Poster/Assignee filter dropdowns are
 *   NOT rendered (server-rendered Fomantic dropdowns need the JS contract
 *   this module does not pin — the notification-subscriptions posture).
 *   Every value they would submit is HONORED by the loaders as plain
 *   query parameters (documented above); the canonical hrefs re-emit the
 *   active non-defaults in the upstream QueryBuild order (type, sort,
 *   state, q, labels — issues.tmpl:11).
 * - `search_mode` (the indexer's fuzzy/words modes) has no landed search
 *   engine — not parsed, not echoed (the parameter would be dead weight).
 * - The row projection is the landed dashboard issuelist (the
 *   notification-subscriptions row, which cites the same template): no
 *   commit-status chip, branch pair, tracked time, task scan, ref,
 *   project or approval counters — no landed source in this projection;
 *   the comment count renders bare (the issues-list count-only
 *   precedent).
 * - The empty list renders the muted issues-list "No results" pair (the
 *   landed list page's empty arm — a cf-gitea addition for the dashboard
 *   templates, which upstream leaves blank).
 * - Per-arm counts are computed per arm over THAT arm's own scope (each
 *   number is what clicking the arm shows). Upstream's getUserIssueStats
 *   (home.go:753-827) lets the ACTIVE arm's repo set leak into the
 *   sidebar counts via its shared SearchOptions — an upstream quirk this
 *   reduction deliberately does not carry.
 * - The milestones page's per-repo sidebar counts respect the current
 *   state + keyword (upstream CountMilestonesMap, home.go:211-219); the
 *   sidebar's "In your repositories" total ignores the `?repos=` filter
 *   (upstream totalMilestoneStats over the unfiltered repo cond,
 *   home.go:285-297) while the tabs respect it (milestoneStats).
 * - The milestones row's description block and tracked-time chip are not
 *   rendered (the repo milestones page's recorded reductions — the
 *   description renders on the landed milestone-detail page).
 */

import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { hasWorkInProgressPrefix, issueLabelRows } from "../../api/services/issues";
import type { LabelRow } from "../../issues/service";
import { ReviewType, issues, milestones, pullRequests, repositories, users } from "../../db/schema";
import { TimeSince } from "../components/file-list";
import { userLink } from "../links";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { LabelBadge } from "./issues-list";
import { formatDueDate, milestonesLocale } from "./milestones";

/** Page chrome text (component-local, the issuesLocale pattern — the
 *  strings cite upstream's locale keys, options/locale/locale_en-US.json). */
export const globalInboxLocale = {
  issues: "Issues", // "issues"
  pulls: "Pull Requests", // "pull_requests"
  milestones: "Milestones", // "milestones"
  in_your_repos: "In your repositories", // "home.issues.in_your_repos"
  assigned_to_you: "Assigned to you", // "repo.issues.filter_type.assigned_to_you"
  created_by_you: "Created by you", // "repo.issues.filter_type.created_by_you"
  review_requested: "Review requested", // "repo.issues.filter_type.review_requested"
  reviewed_by_you: "Reviewed by you", // "repo.issues.filter_type.reviewed_by_you"
  open_title: "Open", // "repo.issues.open_title"
  closed_title: "Closed", // "repo.issues.closed_title"
  search_issues: "Search issues…", // "search.issue_kind" (the /issues form placeholder)
  search_pulls: "Search pull requests…", // "search.pull_kind" (the /pulls form placeholder)
  search: "Search…", // "search.search" (the submit button — the watching form's note)
  no_results: "No results", // "repo.issues.filter_no_results" (the empty arm — cf-gitea addition)
  no_results_placeholder: "Try adjusting your search filters.", // "repo.issues.filter_no_results_placeholder"
} as const;

/** Upstream `setting.UI.IssuePagingNum` (modules/setting/ui.go:89) — all
 *  three pages page with it (home.go:497-503, 307-311). */
export const GLOBAL_INBOX_PAGE_SIZE = 20;

/** The signed-in viewer slice every loader takes (upstream reqSignIn — the
 *  route arm guarantees the kind). */
type SignedInViewer = Extract<Viewer, { kind: "user" }>;

// ---------------------------------------------------------------------------
// Query-param parsing (upstream home.go:352-389 + 497-520 + 189-207)
// ---------------------------------------------------------------------------

/**
 * The `?type=` view arm (home.go:372-389). `mentioned` has no landed
 * source (upstream's `issue_users` IsMentioned table) — it degrades to the
 * default arm exactly like an unknown value, and the nav item is not
 * rendered (module header).
 */
export type OverviewViewType = "your_repositories" | "assigned" | "created_by" | "review_requested" | "reviewed_by";

export function parseOverviewType(raw: string | null): OverviewViewType {
  switch (raw) {
    case "assigned":
    case "created_by":
    case "review_requested":
    case "reviewed_by":
      return raw;
    // "your_repositories", "mentioned" (no landed mention table — the
    // module header), unknown values — the default arm (home.go:386-389).
    default:
      return "your_repositories";
  }
}

/** The overview sorts — upstream applySorts' vocabulary
 *  (issue_search.go:86-118); the DASHBOARD default is `recentupdate`
 *  (home.go:368-369), unlike the repo lists' `latest`. */
export type OverviewSortType =
  | "latest"
  | "oldest"
  | "recentupdate"
  | "leastupdate"
  | "mostcomment"
  | "leastcomment"
  | "nearduedate"
  | "farduedate";

export function parseOverviewSort(raw: string | null): OverviewSortType {
  switch (raw) {
    case "latest":
    case "oldest":
    case "leastupdate":
    case "mostcomment":
    case "leastcomment":
    case "nearduedate":
    case "farduedate":
      return raw;
    // "recentupdate" and unknown values — the dashboard default
    // (home.go:368-369 IfZero).
    default:
      return "recentupdate";
  }
}

/**
 * `?labels=` — the subscriptions parser's exact semantics
 * (pages/notification-subscriptions.tsx parseLabelsFilter: absent/""/"0"
 * → no filter; any unparseable entry → no filter, the upstream
 * StringsToInt64s error arm; negatives exclude; dedupe; bare 0 ignored).
 */
export function parseOverviewLabels(raw: string | null): number[] {
  if (raw === null || raw === "" || raw === "0") return [];
  const ids = new Set<number>();
  for (const entry of raw.split(",")) {
    if (!/^-?\d+$/.test(entry)) return [];
    const id = Number.parseInt(entry, 10);
    if (id === 0) continue;
    ids.add(id);
  }
  return [...ids];
}

/**
 * `?state=` — anything but "closed" is open (upstream
 * `isShowClosed := FormString("state") == "closed"`, home.go:497; no "all"
 * tab on any of the three pages).
 */
export function parseInboxState(raw: string | null): "open" | "closed" {
  return raw === "closed" ? "closed" : "open";
}

/**
 * The milestones dashboard sorts — the template's seven dropdown values +
 * ToOrders' `id` arm (models/issues/milestone_list.go:78-92). The DEFAULT
 * is `closestduedate` (ToOrders' default arm: deadline ASC, name ASC — the
 * template marks it active for empty sort too). Note `name` sorts name
 * DESC upstream — carried verbatim.
 */
export type MilestonesInboxSortType =
  | "closestduedate"
  | "furthestduedate"
  | "leastcomplete"
  | "mostcomplete"
  | "mostissues"
  | "leastissues"
  | "name"
  | "id";

export function parseMilestonesInboxSort(raw: string | null): MilestonesInboxSortType {
  switch (raw) {
    case "furthestduedate":
    case "leastcomplete":
    case "mostcomplete":
    case "mostissues":
    case "leastissues":
    case "name":
    case "id":
      return raw;
    // "closestduedate" and unknown values — the default arm
    // (milestone_list.go:91-92).
    default:
      return "closestduedate";
  }
}

/**
 * `?repos=[a,b,]` — the milestones repo toggle filter. DIVERGENCE (module
 * header): upstream's int64-id pattern `^\[\d+(,\d+)*,?\]$` cannot bind
 * the landed UUID repo ids — the bracket shape is kept, over non-empty
 * tokens. Empty and "0" entries are skipped, malformed values drop the
 * whole filter (home.go:185-199's liberal handling). Empty result = no
 * filter.
 */
export function parseReposFilter(raw: string | null): string[] {
  if (raw === null || !/^\[\S+(,\S+)*,?\]$/.test(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw.slice(1, -1).split(",")) {
    if (entry === "" || entry === "0") continue;
    ids.push(entry);
  }
  return ids;
}

/** The `?repos=` value for one id set — the bracket form with the
 *  upstream trailing comma (milestones.tmpl:15-25 renders each id with a
 *  trailing %2C). */
function reposParamValue(ids: string[]): string {
  return `[${ids.map((id) => `${id},`).join("")}]`;
}

// ---------------------------------------------------------------------------
// The cross-repo scope + arm conditions (module header: the perm filter)
// ---------------------------------------------------------------------------

/**
 * The repo-scope conjunct over the joined `repositories` (+`users`) rows —
 * module header's perm filter: owned ∨ collaborated, non-archived; the
 * `allPublic` arms add the readGrant public shape (`visibleRepoGrantSql`'s
 * publiclyVisible + limited arms — notification-subscriptions.tsx) for
 * non-admin doers, and drop the conjunct entirely for the site admin
 * (readGrant's isSiteAdmin arm). Returns null when no repo restriction
 * remains (the caller then pushes nothing).
 */
function overviewRepoScopeSql(userId: number, isAdmin: boolean, allPublic: boolean): SQL | null {
  const ownedOrCollaborated = sql`(
    ${repositories.ownerId} = ${userId}
    OR EXISTS (
      SELECT 1 FROM repo_collaborators rc
      WHERE rc.repo_id = ${repositories.id} AND rc.user_id = ${userId}
    )
  )`;
  const base = sql`(${ownedOrCollaborated} AND ${repositories.isArchived} = false)`;
  if (!allPublic) return base;
  if (isAdmin) return null;
  // The readGrant public arms in SQL — public repo + active owner +
  // public-or-limited owner visibility (visibleRepoGrantSql verbatim,
  // minus its owner-id arm which `ownedOrCollaborated` already carries).
  const publiclyVisible = sql`(
    ${repositories.visibility} = 'public'
    AND ${users.status} = 'active'
    AND ${users.visibility} IN ('public', 'limited')
  )`;
  return sql`(${base} OR ${publiclyVisible})`;
}

/**
 * The arm's OWN type condition (upstream FilterMode* — home.go:489-499):
 * assigned → an `issue_assignees` edge for the doer; created_by → the
 * poster; review_requested / reviewed_by → the `pull_reviews` arms (the
 * module header's citations); your_repositories → the scope alone.
 */
function overviewTypeConditionSql(userId: number, viewType: OverviewViewType): SQL | null {
  switch (viewType) {
    case "your_repositories":
      return null;
    case "assigned":
      return sql`EXISTS (
        SELECT 1 FROM issue_assignees ia
        WHERE ia.issue_id = ${issues.id} AND ia.assignee_id = ${userId}
      )`;
    case "created_by":
      return sql`${issues.posterId} = ${userId}`;
    case "review_requested":
      return sql`EXISTS (
        SELECT 1 FROM pull_reviews pr
        WHERE pr.issue_id = ${issues.id} AND pr.reviewer_id = ${userId}
          AND pr.type = ${ReviewType.Request} AND pr.dismissed = false
      )`;
    case "reviewed_by":
      return sql`EXISTS (
        SELECT 1 FROM pull_reviews pr
        WHERE pr.issue_id = ${issues.id} AND pr.reviewer_id = ${userId}
          AND pr.type IN (${ReviewType.Approve}, ${ReviewType.Comment}, ${ReviewType.Reject})
      )`;
  }
}

/** The arms the nav renders — the pulls-only review pair gated like
 *  issues.tmpl's `{{if .PageIsPulls}}` (issues.tmpl:24-34). */
export function renderedArms(listKind: "issues" | "pulls"): OverviewViewType[] {
  return listKind === "pulls"
    ? ["your_repositories", "assigned", "created_by", "review_requested", "reviewed_by"]
    : ["your_repositories", "assigned", "created_by"];
}

/** The nav label for one arm (the locale keys above). */
function armLabel(arm: OverviewViewType): string {
  switch (arm) {
    case "your_repositories":
      return globalInboxLocale.in_your_repos;
    case "assigned":
      return globalInboxLocale.assigned_to_you;
    case "created_by":
      return globalInboxLocale.created_by_you;
    case "review_requested":
      return globalInboxLocale.review_requested;
    case "reviewed_by":
      return globalInboxLocale.reviewed_by_you;
  }
}

// ---------------------------------------------------------------------------
// Shared WHERE pieces: keyword, labels, poster/assignee, sorts
// ---------------------------------------------------------------------------

/** The keyword arm — services/issues.ts issueFilterConditions' substring
 *  pair (title ∨ content, case-insensitive; the landed search reduction).
 *  NOT LIKE: D1 caps LIKE patterns at 50 bytes, so a long `q=` needle threw
 *  D1_ERROR and the page answered a plain 500; the substring goes through
 *  instr() instead — the documented user-search precedent
 *  (services/user.ts:81-97, the org-members 943e1e9 shape), the exact pair
 *  the services/issues.ts arm now carries. The needle pre-lowers for the
 *  case-insensitive pair (the columns lower() in SQL, exactly what the
 *  LIKE wrapped). */
function keywordConditionSql(keyword: string): SQL | null {
  if (keyword === "") return null;
  const needle = keyword.toLowerCase();
  return or(
    sql`instr(lower(${issues.title}), ${needle}) > 0`,
    sql`instr(lower(coalesce(${issues.content}, '')), ${needle}) > 0`,
  ) as SQL;
}

/**
 * The labels filter — applyLabelsCondition (issue_search.go:144-174) in
 * the subscriptions page's exact SQL (positives must ALL be attached, the
 * count-equality over the unique (issue_id, label_id) index; negatives
 * must NOT be attached).
 */
function labelsConditionSql(labels: number[]): SQL[] {
  const conditions: SQL[] = [];
  const included = labels.filter((id) => id > 0);
  const excluded = labels.filter((id) => id < 0).map((id) => -id);
  if (included.length > 0) {
    conditions.push(
      sql`(SELECT count(*) FROM issue_labels il WHERE il.issue_id = ${issues.id} AND il.label_id IN (${sql.join(
        included.map((id) => sql`${id}`),
        sql`, `,
      )})) = ${included.length}`,
    );
  }
  if (excluded.length > 0) {
    conditions.push(
      sql`(SELECT count(*) FROM issue_labels il WHERE il.issue_id = ${issues.id} AND il.label_id IN (${sql.join(
        excluded.map((id) => sql`${id}`),
        sql`, `,
      )})) = 0`,
    );
  }
  return conditions;
}

/**
 * The poster/assignee username resolution — `GetFilterUserIDByName`
 * (routers/web/shared/user/helper.go:60-74): a username → its id, a
 * numeric string → that id, an unknown name → null (upstream's "(none)"
 * match-nothing arm).
 */
async function filterUserIdByName(d1: D1Database, name: string): Promise<number | null> {
  if (/^\d+$/.test(name)) return Number.parseInt(name, 10);
  const row = await drizzle(d1)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, name.toLowerCase()))
    .limit(1);
  const found = row[0];
  return found === undefined ? null : found.id;
}

/** The milestone-aware due date — the subscriptions page's effectiveDueExpr
 *  verbatim (applySorts' nearduedate/farduedate CASE, issue_search.go:101-118). */
function effectiveDueExpr(): SQL {
  const mDeadline = sql`(SELECT m.deadline_unix FROM milestones m WHERE m.id = ${issues.milestoneId})`;
  const iDeadline = sql`coalesce(${issues.deadlineAt}, 0)`;
  return sql`CASE
    WHEN ${iDeadline} = 0 AND coalesce(${mDeadline}, 0) = 0 THEN 253370764800
    WHEN coalesce(${mDeadline}, 0) = 0 THEN ${iDeadline}
    WHEN ${mDeadline} < ${iDeadline} OR ${iDeadline} = 0 THEN ${mDeadline}
    ELSE ${iDeadline} END`;
}

/** The eight upstream orders — the subscriptions page's issueSortOrder
 *  verbatim (applySorts, issue_search.go:86-127). */
function overviewSortOrder(sort: OverviewSortType): SQL[] {
  const created = sql`coalesce(${issues.createdAt}, 0)`;
  const updated = sql`coalesce(${issues.updatedAt}, 0)`;
  switch (sort) {
    case "oldest":
      return [sql`${created} ASC`, sql`${issues.id} ASC`];
    case "recentupdate":
      return [sql`${updated} DESC`, sql`${created} DESC`, sql`${issues.id} DESC`];
    case "leastupdate":
      return [sql`${updated} ASC`, sql`${created} ASC`, sql`${issues.id} ASC`];
    case "mostcomment":
      return [sql`${issues.numComments} DESC`, sql`${created} DESC`, sql`${issues.id} DESC`];
    case "leastcomment":
      return [sql`${issues.numComments} ASC`, sql`${created} DESC`, sql`${issues.id} DESC`];
    case "nearduedate":
      return [sql`${effectiveDueExpr()} ASC`, sql`${created} ASC`, sql`${issues.id} ASC`];
    case "farduedate":
      return [sql`${effectiveDueExpr()} DESC`, sql`${created} DESC`, sql`${issues.id} DESC`];
    case "latest":
      return [sql`${created} DESC`, sql`${issues.id} DESC`];
  }
}

/** The milestones dashboard orders — ToOrders verbatim
 *  (models/issues/milestone_list.go:78-92) with the id tie-break the
 *  landed sorts carry for determinism (the watching sorts' convention). */
function milestonesInboxOrder(sort: MilestonesInboxSortType): SQL[] {
  const deadline = sql`coalesce(${milestones.deadlineAt}, 0)`;
  const id = sql`${milestones.id} ASC`;
  switch (sort) {
    case "furthestduedate":
      return [sql`${deadline} DESC`, id];
    case "leastcomplete":
      return [sql`${milestones.completeness} ASC`, id];
    case "mostcomplete":
      return [sql`${milestones.completeness} DESC`, id];
    case "leastissues":
      return [sql`${milestones.numIssues} ASC`, id];
    case "mostissues":
      return [sql`${milestones.numIssues} DESC`, id];
    case "id":
      return [id];
    case "name":
      return [sql`${milestones.name} DESC`, id]; // ToOrders "name" verbatim — DESC
    case "closestduedate":
      return [sql`${deadline} ASC`, sql`${milestones.name} ASC`, id];
  }
}

// ---------------------------------------------------------------------------
// The issues/pulls overview — data (§3.2 direct reads)
// ---------------------------------------------------------------------------

/** One rendered row (the shared/issuelist `dashboard` item — the
 *  notification-subscriptions projection, cross-repo by construction). */
export interface OverviewIssueItem {
  /** The underlying issues.id (the row identity). */
  issueId: number;
  index: number;
  title: string;
  isPull: boolean;
  isClosed: boolean;
  /** The `pull_requests.has_merged` extension flag (the merged glyph +
   *  event-line arm); false for plain issues. */
  hasMerged: boolean;
  /** The repo full name's two halves (the dashboard index form). */
  ownerNamespace: string;
  slug: string;
  numComments: number;
  /** The row's milestone (issuelist.tmpl:81-86) — id + name, linked to the
   *  landed milestone-detail page. */
  milestone: { id: number; name: string } | null;
  labels: LabelRow[];
  /** Display-cased poster username; null = no poster row (mirrored
   *  imports render without the "by" tail). */
  posterName: string | null;
  /** GetLastEventTimestamp (issue.go:452-457): closed → closedAt, open →
   *  createdAt, with the updatedAt fallback for unstamped rows. */
  lastEventAt: number | null;
}

/** The issues/pulls overview render inputs. */
export interface OverviewIssuesData {
  listKind: "issues" | "pulls";
  viewType: OverviewViewType;
  state: "open" | "closed";
  sort: OverviewSortType;
  keyword: string;
  /** The active label filter ([] = none — signs kept). */
  labels: number[];
  /** The raw `?poster=` / `?assignee=` echoes (upstream
   *  FilterPosterUsername / FilterAssigneeUsername). */
  poster: string;
  assignee: string;
  page: number;
  items: OverviewIssueItem[];
  /** The ACTIVE arm's per-state tab totals (upstream OpenCount /
   *  ClosedCount, home.go:759-786). */
  openCount: number;
  closedCount: number;
  /** One count per RENDERED arm, over that arm's own scope + type
   *  condition + the current state (module header: the sidebar-count
   *  reduction). */
  armCounts: Record<OverviewViewType, number>;
  more: boolean;
}

/** The FROM shape shared by every overview query — the scope needs the
 *  owner row; the merged flag rides the 1:1 pull_requests left join (the
 *  joins are fan-out-free: unique username_lower, unique
 *  pull_requests.issue_id — so count and page agree). */
function overviewJoinedRows(db: ReturnType<typeof drizzle>) {
  return db
    .select({
      issueId: issues.id,
      index: issues.index,
      title: issues.title,
      isPull: issues.isPull,
      isClosed: issues.isClosed,
      numComments: issues.numComments,
      posterId: issues.posterId,
      milestoneId: issues.milestoneId,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
      closedAt: issues.closedAt,
      hasMerged: pullRequests.hasMerged,
      ownerNamespace: repositories.ownerNamespace,
      slug: repositories.slug,
    })
    .from(issues)
    .innerJoin(repositories, eq(repositories.id, issues.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .leftJoin(pullRequests, eq(pullRequests.issueId, issues.id));
}

/** A count(*) over the joined FROM with the given conjuncts. */
async function overviewCount(db: ReturnType<typeof drizzle>, conjuncts: SQL[]): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(issues)
    .innerJoin(repositories, eq(repositories.id, issues.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .leftJoin(pullRequests, eq(pullRequests.issueId, issues.id))
    .where(and(...conjuncts));
  return Number(rows[0]?.value ?? 0);
}

/** The WHERE conjuncts for one overview query (the module header's
 *  predicate assembly). `posterId`/`assigneeId`: undefined = no filter,
 *  null = match-nothing ("(none)"), a number = the id filter. */
function overviewConjuncts(
  viewer: SignedInViewer,
  opts: {
    listKind: "issues" | "pulls";
    viewType: OverviewViewType;
    state: "open" | "closed";
    keyword: string;
    labels: number[];
    posterId?: number | null;
    assigneeId?: number | null;
  },
): SQL[] {
  const conditions: SQL[] = [eq(issues.isPull, opts.listKind === "pulls")];
  // The scope: owned ∪ collaborated (+ public when the arm extends it).
  const scope = overviewRepoScopeSql(viewer.id, viewer.isAdmin, opts.viewType !== "your_repositories");
  if (scope !== null) conditions.push(scope);
  const typeCondition = overviewTypeConditionSql(viewer.id, opts.viewType);
  if (typeCondition !== null) conditions.push(typeCondition);
  if (opts.state === "open") conditions.push(eq(issues.isClosed, false));
  if (opts.state === "closed") conditions.push(eq(issues.isClosed, true));
  const keyword = keywordConditionSql(opts.keyword);
  if (keyword !== null) conditions.push(keyword);
  conditions.push(...labelsConditionSql(opts.labels));
  if (opts.posterId === null) conditions.push(sql`0 = 1`);
  if (typeof opts.posterId === "number") conditions.push(eq(issues.posterId, opts.posterId));
  if (opts.assigneeId === null) conditions.push(sql`0 = 1`);
  if (typeof opts.assigneeId === "number") {
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM issue_assignees ia
        WHERE ia.issue_id = ${issues.id} AND ia.assignee_id = ${opts.assigneeId}
      )`,
    );
  }
  return conditions;
}

/**
 * Load the issues/pulls overview (§3.2 — the re-issued buildIssueOverview
 * reads): one filtered page read + the ACTIVE arm's two tab counts + one
 * count per rendered arm, all over the joined FROM shape. `?poster=` /
 * `?assignee=` resolve per GetFilterUserIDByName; on the created_by /
 * assigned arms the arm overrides the matching param (home.go:489-499).
 */
export async function loadOverviewIssuesData(
  d1: D1Database,
  viewer: Viewer,
  listKind: "issues" | "pulls",
  params: URLSearchParams,
): Promise<OverviewIssuesData> {
  if (viewer.kind !== "user") throw new Error("loadOverviewIssuesData requires a signed-in viewer");
  const db = drizzle(d1);
  const viewType = parseOverviewType(params.get("type"));
  const state = parseInboxState(params.get("state"));
  const sort = parseOverviewSort(params.get("sort"));
  const keyword = (params.get("q") ?? "").trim();
  const labels = parseOverviewLabels(params.get("labels"));
  const poster = params.get("poster") ?? "";
  const assignee = params.get("assignee") ?? "";
  const page = Math.max(1, parsePageNumber(params.get("page")));

  // GetFilterUserIDByName: "" → no filter (undefined); else id | null.
  const resolveFilter = async (raw: string): Promise<number | null | undefined> => {
    if (raw === "") return undefined;
    return filterUserIdByName(d1, raw);
  };
  const posterParam = await resolveFilter(poster);
  const assigneeParam = await resolveFilter(assignee);
  // The arm overrides its own facet (home.go:489-499 — FilterModeCreate
  // sets PosterID after the param read; FilterModeAssign the AssigneeID).
  const posterId = viewType === "created_by" ? viewer.id : posterParam;
  const assigneeId = viewType === "assigned" ? viewer.id : assigneeParam;

  const [openCount, closedCount, ...armCountValues] = await Promise.all([
    overviewCount(
      db,
      overviewConjuncts(viewer, { listKind, viewType, state: "open", keyword, labels, posterId, assigneeId }),
    ),
    overviewCount(
      db,
      overviewConjuncts(viewer, { listKind, viewType, state: "closed", keyword, labels, posterId, assigneeId }),
    ),
    ...renderedArms(listKind).map((arm) =>
      overviewCount(db, overviewConjuncts(viewer, { listKind, viewType: arm, state, keyword, labels })),
    ),
  ]);
  const arms = renderedArms(listKind);
  const armCounts = Object.fromEntries(arms.map((arm, i) => [arm, armCountValues[i] ?? 0])) as Record<
    OverviewViewType,
    number
  >;

  const rows = await overviewJoinedRows(db)
    .where(and(...overviewConjuncts(viewer, { listKind, viewType, state, keyword, labels, posterId, assigneeId })))
    .orderBy(...overviewSortOrder(sort))
    .limit(GLOBAL_INBOX_PAGE_SIZE)
    .offset((page - 1) * GLOBAL_INBOX_PAGE_SIZE);

  const items: OverviewIssueItem[] = await Promise.all(
    rows.map(async (row) => ({
      issueId: row.issueId,
      index: row.index,
      title: row.title,
      isPull: row.isPull === true,
      isClosed: row.isClosed === true,
      hasMerged: row.hasMerged === true,
      ownerNamespace: row.ownerNamespace,
      slug: row.slug,
      numComments: row.numComments,
      milestone: null,
      labels: await issueLabelRows(d1, row.issueId),
      posterName: null,
      // GetLastEventTimestamp (issue.go:452-457) with the issues-list
      // fallback chain for unstamped rows.
      lastEventAt: unixOrNull(
        row.isClosed === true ? (row.closedAt ?? row.updatedAt ?? row.createdAt) : (row.createdAt ?? row.updatedAt),
      ),
    })),
  );

  // Batched milestone names + poster names for the page (the
  // subscriptions loader's enrichment).
  const milestoneIds = [...new Set(rows.flatMap((row) => (row.milestoneId === null ? [] : [row.milestoneId])))];
  const milestonesById = new Map<number, { id: number; name: string }>();
  if (milestoneIds.length > 0) {
    const milestoneRows = await db
      .select({ id: milestones.id, name: milestones.name })
      .from(milestones)
      .where(inArray(milestones.id, milestoneIds))
      .all();
    for (const milestone of milestoneRows) milestonesById.set(milestone.id, milestone);
  }
  const posterIds = [...new Set(rows.flatMap((row) => (row.posterId === null ? [] : [row.posterId])))];
  const posters = new Map<number, string>();
  if (posterIds.length > 0) {
    const posterRows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, posterIds))
      .all();
    for (const row of posterRows) posters.set(row.id, row.username);
  }
  for (const [i, row] of rows.entries()) {
    const item = items[i];
    if (item === undefined) throw new Error("overview page row vanished during enrichment");
    item.milestone = row.milestoneId === null ? null : (milestonesById.get(row.milestoneId) ?? null);
    item.posterName = row.posterId === null ? null : (posters.get(row.posterId) ?? null);
  }

  const total = state === "open" ? openCount : closedCount;
  return {
    listKind,
    viewType,
    state,
    sort,
    keyword,
    labels,
    poster,
    assignee,
    page,
    items,
    openCount,
    closedCount,
    armCounts,
    more: page * GLOBAL_INBOX_PAGE_SIZE < total,
  };
}

/** Nullable timestamp column → unix seconds (null stays null). */
function unixOrNull(date: Date | null): number | null {
  return date === null ? null : Math.floor(date.getTime() / 1000);
}

// ---------------------------------------------------------------------------
// The milestones dashboard — data (§3.2 direct reads)
// ---------------------------------------------------------------------------

/** One rendered row: the repo milestones row (pages/milestones.tsx) at the
 *  cross-repo projection — the repo's full name halves ride along. */
export interface DashboardMilestoneItem {
  row: typeof milestones.$inferSelect;
  ownerNamespace: string;
  slug: string;
  /** Open issues on the milestone (the maintained counters' subtraction). */
  openIssues: number;
  /** The stored `completeness` column, clamped to 0-100. */
  completeness: number;
  /** Open milestone with a past deadline (upstream IsOverdue). */
  overdue: boolean;
}

/** One sidebar repo entry (milestones.tmpl:14-26). */
export interface DashboardMilestoneRepo {
  repoId: string;
  ownerNamespace: string;
  slug: string;
  /** The state+keyword-filtered milestone count (upstream Counts). */
  count: number;
  /** In the current `?repos=` filter set (the active mark). */
  active: boolean;
}

/** The milestones dashboard render inputs. */
export interface DashboardMilestonesData {
  state: "open" | "closed";
  sort: MilestonesInboxSortType;
  keyword: string;
  /** The parsed `?repos=` id tokens ([] = no filter — the raw echo). */
  repoFilter: string[];
  page: number;
  /** The unfiltered-by-repos total (upstream `.Total` — the sidebar's
   *  "In your repositories" number). */
  total: number;
  /** The repos-param-filtered tab totals (upstream MilestoneStats). */
  openCount: number;
  closedCount: number;
  repoMenu: DashboardMilestoneRepo[];
  items: DashboardMilestoneItem[];
  more: boolean;
}

/**
 * Load the milestones dashboard (§3.2 — the re-issued Milestones reads):
 * the owned ∪ collaborated non-archived repo scope (module header), the
 * per-repo sidebar counts, the repos-param-filtered page + tab counts.
 */
export async function loadDashboardMilestonesData(
  d1: D1Database,
  viewer: Viewer,
  params: URLSearchParams,
  now: Date = new Date(),
): Promise<DashboardMilestonesData> {
  if (viewer.kind !== "user") throw new Error("loadDashboardMilestonesData requires a signed-in viewer");
  const db = drizzle(d1);
  const state = parseInboxState(params.get("state"));
  const sort = parseMilestonesInboxSort(params.get("sort"));
  const keyword = (params.get("q") ?? "").trim();
  const repoFilter = parseReposFilter(params.get("repos"));
  const page = Math.max(1, parsePageNumber(params.get("page")));

  // The scope ids — owned ∪ collaborated, non-archived (the visibleRepoIds
  // full-scan posture; the dashboard's owner-page read path). No users
  // join: this scope is ownership-based, the public arm does not exist on
  // the milestones page (home.go:158-174).
  const scopeRows = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(sql`(
      ${repositories.ownerId} = ${viewer.id}
      OR EXISTS (
        SELECT 1 FROM repo_collaborators rc
        WHERE rc.repo_id = ${repositories.id} AND rc.user_id = ${viewer.id}
      )
    ) AND ${repositories.isArchived} = false`)
    .orderBy(asc(repositories.ownerNamespace), asc(repositories.slug));
  const scopeIds = scopeRows.map((row) => row.id);

  // The sidebar repo menu: scope repos bearing ≥1 milestone in ANY state
  // (upstream HasMilestones: true), with the current state+keyword counts
  // (upstream CountMilestonesMap, home.go:211-219).
  // NOT LIKE: D1 caps LIKE patterns at 50 bytes, so a long `q=` needle
  // threw D1_ERROR and the page answered a plain 500 — the instr() shape
  // (services/user.ts:81-97, the org-members 943e1e9 shape), mirroring the
  // services/milestones.ts name arm. The needle pre-lowers and the name
  // lower()s in SQL, exactly what the ASCII-case-insensitive LIKE wrapped.
  const nameFilter = keyword === "" ? null : sql`instr(lower(${milestones.name}), ${keyword.toLowerCase()}) > 0`;
  const countRows =
    scopeIds.length === 0
      ? []
      : await db
          .select({ repoId: milestones.repoId, value: sql<number>`count(*)` })
          .from(milestones)
          .where(milestoneConjuncts(scopeIds, state, nameFilter))
          .groupBy(milestones.repoId)
          .all();
  const countsByRepo = new Map(countRows.map((row) => [row.repoId, Number(row.value)]));

  const menuRows =
    scopeIds.length === 0
      ? []
      : await db
          .select({
            repoId: repositories.id,
            ownerNamespace: repositories.ownerNamespace,
            slug: repositories.slug,
          })
          .from(repositories)
          .where(
            and(
              inArray(repositories.id, scopeIds),
              sql`EXISTS (SELECT 1 FROM milestones m WHERE m.repo_id = ${repositories.id})`,
            ),
          )
          .orderBy(asc(repositories.ownerNamespace), asc(repositories.slug))
          .all();
  const repoMenu: DashboardMilestoneRepo[] = menuRows.map((row) => ({
    repoId: row.repoId,
    ownerNamespace: row.ownerNamespace,
    slug: row.slug,
    count: countsByRepo.get(row.repoId) ?? 0,
    active: repoFilter.includes(row.repoId),
  }));

  // The page scope: the ids ∩ the parsed repos filter (empty parse = no
  // filter; a parse that intersects nothing matches nothing).
  const filteredIds = repoFilter.length === 0 ? scopeIds : scopeIds.filter((id) => repoFilter.includes(id));
  const [openCount, closedCount] = await Promise.all([
    milestoneCount(db, filteredIds, false, nameFilter),
    milestoneCount(db, filteredIds, true, nameFilter),
  ]);

  const rows =
    filteredIds.length === 0
      ? []
      : await db
          .select({
            row: milestones,
            ownerNamespace: repositories.ownerNamespace,
            slug: repositories.slug,
          })
          .from(milestones)
          .innerJoin(repositories, eq(repositories.id, milestones.repoId))
          .where(milestoneConjuncts(filteredIds, state, nameFilter))
          .orderBy(...milestonesInboxOrder(sort))
          .limit(GLOBAL_INBOX_PAGE_SIZE)
          .offset((page - 1) * GLOBAL_INBOX_PAGE_SIZE);

  const items: DashboardMilestoneItem[] = rows.map(({ row, ownerNamespace, slug }) => ({
    row,
    ownerNamespace,
    slug,
    openIssues: Math.max((row.numIssues ?? 0) - (row.numClosedIssues ?? 0), 0),
    completeness: Math.min(Math.max(row.completeness ?? 0, 0), 100),
    overdue: !row.isClosed && row.deadlineAt !== null && row.deadlineAt.getTime() < now.getTime(),
  }));

  const activeTotal = state === "open" ? openCount : closedCount;
  return {
    state,
    sort,
    keyword,
    repoFilter,
    page,
    total: [...countsByRepo.values()].reduce((sum, value) => sum + value, 0),
    openCount,
    closedCount,
    repoMenu,
    items,
    more: page * GLOBAL_INBOX_PAGE_SIZE < activeTotal,
  };
}

/** The milestones conjuncts: repo ids (∩) + state + the name LIKE. */
function milestoneConjuncts(repoIds: string[], state: "open" | "closed", nameFilter: SQL | null): SQL {
  const conditions: SQL[] = [inArray(milestones.repoId, repoIds), eq(milestones.isClosed, state === "closed")];
  if (nameFilter !== null) conditions.push(nameFilter);
  return and(...conditions) as SQL;
}

/** A milestones count over the repo ids with the state + name filters
 *  (upstream GetMilestonesStatsByRepoCondAndKw, home.go:299-306). */
async function milestoneCount(
  db: ReturnType<typeof drizzle>,
  repoIds: string[],
  isClosed: boolean,
  nameFilter: SQL | null,
): Promise<number> {
  if (repoIds.length === 0) return 0;
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(milestones)
    .where(milestoneConjuncts(repoIds, isClosed ? "closed" : "open", nameFilter));
  return Number(rows[0]?.value ?? 0);
}

// ---------------------------------------------------------------------------
// Components — shared chrome
// ---------------------------------------------------------------------------

/** The canonical overview URL for one filter set — upstream QueryBuild's
 *  param order (type, sort, state, q, labels — issues.tmpl:11); defaults
 *  and empties are omitted, page resets unless given (the issues-list
 *  listHref convention). */
function overviewHref(
  base: string,
  opts: {
    viewType?: OverviewViewType;
    sort?: OverviewSortType;
    state?: "open" | "closed";
    keyword?: string;
    labels?: number[];
    poster?: string;
    assignee?: string;
    page?: number;
  },
): string {
  const params = new URLSearchParams();
  if (opts.viewType !== undefined && opts.viewType !== "your_repositories") params.set("type", opts.viewType);
  if (opts.sort !== undefined && opts.sort !== "recentupdate") params.set("sort", opts.sort);
  if (opts.state === "closed") params.set("state", "closed");
  if (opts.keyword !== undefined && opts.keyword !== "") params.set("q", opts.keyword);
  if (opts.labels !== undefined && opts.labels.length > 0) params.set("labels", opts.labels.join(","));
  if (opts.poster !== undefined && opts.poster !== "") params.set("poster", opts.poster);
  if (opts.assignee !== undefined && opts.assignee !== "") params.set("assignee", opts.assignee);
  if (opts.page !== undefined && opts.page > 1) params.set("page", String(opts.page));
  const query = params.toString();
  return query === "" ? base : `${base}?${query}`;
}

/** The dashboard navbar reduced to the context-user switcher's SELF item
 *  (module header: the org right-menu tabs are org-context UI upstream —
 *  `{{if .ContextUser.IsOrganization}}` — and the switcher itself needs
 *  the org list, the dashboard.tsx degradation). The self anchor links the
 *  current page kind (navbar.tmpl:16-28's href shape), active-selected;
 *  upstream renders the avatar beside the name — no avatar pipeline, the
 *  name alone. */
export function DashboardInboxNavbar(props: { selfName: string; active: "issues" | "pulls" | "milestones" }) {
  return (
    <div class="secondary-nav tw-border-b tw-border-b-secondary">
      <div class="ui secondary stackable menu">
        <div class="item">
          <a class="active selected item" href={`/${props.active}`}>
            <span class="gt-ellipsis">{props.selfName}</span>
          </a>
        </div>
      </div>
    </div>
  );
}

/** The open/closed toggle tabs (issues.tmpl:37-49 / milestones.tmpl:34-44
 *  — the state glyphs on each tab, the PrettyNumber count + title). */
function InboxToggleTabs(props: {
  hrefOpen: string;
  hrefClosed: string;
  state: "open" | "closed";
  openCount: number;
  closedCount: number;
  openGlyph: "octicon-issue-opened" | "octicon-milestone";
  closedGlyph: "octicon-issue-closed" | "octicon-check";
}) {
  return (
    <div class="small-menu-items ui compact tiny menu list-header-toggle">
      <a class={props.state === "open" ? "item active" : "item"} href={props.hrefOpen}>
        <Icon name={props.openGlyph} /> {String(props.openCount)}
        &nbsp;{globalInboxLocale.open_title}
      </a>
      <a class={props.state === "closed" ? "item active" : "item"} href={props.hrefClosed}>
        <Icon name={props.closedGlyph} /> {String(props.closedCount)}
        &nbsp;{globalInboxLocale.closed_title}
      </a>
    </div>
  );
}

/** The list-header search form — the hidden type/sort/state (+repos on the
 *  milestones page) echoing the active filters and the `q` input
 *  (issues.tmpl:51-62 / milestones.tmpl:64-72; the shared/search/combo
 *  reduction to the input + submit, the watching form's shape). */
function InboxSearchForm(props: {
  action: string;
  placeholder: string;
  keyword: string;
  hidden: Array<[string, string]>;
}) {
  return (
    <form class="list-header-search ui form ignore-dirty" method="get" action={props.action}>
      {props.hidden.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div class="ui small action input tw-flex-1">
        <input type="search" name="q" value={props.keyword} maxlength={255} spellcheck={false} placeholder={props.placeholder} />
        <button type="submit" class="ui small icon button" aria-label={globalInboxLocale.search}>
          {globalInboxLocale.search}
        </button>
      </div>
    </form>
  );
}

/** The Newer/Older pager — the landed pagination shape (base/paginate's
 *  reduction), driven by `page * size < total`. */
function InboxPager(props: { href: (page: number) => string; page: number; more: boolean }) {
  if (props.page <= 1 && !props.more) return null;
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a class="item navigation" href={props.href(props.page - 1)}>
            <span class="navigation_label">Newer</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={props.href(props.page + 1)}>
            <span class="navigation_label">Older</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Components — the issues/pulls overview page
// ---------------------------------------------------------------------------

/** The row's subject URL — Issue.Link() (issue.go:397-404). */
function overviewIssueUrl(item: OverviewIssueItem): string {
  return `/${item.ownerNamespace}/${item.slug}/${item.isPull ? "pulls" : "issues"}/${item.index}`;
}

/** The row's state glyph — the full PR state machine over the plain-issue
 *  pair (shared/issueicon.tmpl; the subscriptions page's SubscriptionIcon
 *  shape). */
function OverviewIssueIcon(props: { item: OverviewIssueItem }) {
  const { item } = props;
  if (item.isPull) {
    if (item.isClosed) {
      return item.hasMerged ? (
        <Icon name="octicon-git-merge" class="tw-text-purple" />
      ) : (
        <Icon name="octicon-git-pull-request-closed" class="tw-text-red" />
      );
    }
    if (hasWorkInProgressPrefix(item.title)) {
      return <Icon name="octicon-git-pull-request-draft" class="tw-text-text-light" />;
    }
    return <Icon name="octicon-git-pull-request" class="tw-text-green" />;
  }
  return item.isClosed ? (
    <Icon name="octicon-issue-closed" class="tw-text-red" />
  ) : (
    <Icon name="octicon-issue-opened" class="tw-text-green" />
  );
}

/** The event line — GetLastEventLabel's arms in the landed EventLine
 *  literals (opened/closed/merged {time} by {poster}). */
function OverviewEventLine(props: { item: OverviewIssueItem }) {
  const { item } = props;
  const verb = item.isClosed ? "closed" : item.isPull && item.hasMerged ? "merged" : "opened";
  return (
    <div class="flex-text-inline">
      {verb} {item.lastEventAt !== null ? <TimeSince unixSeconds={item.lastEventAt} tz="+0000" /> : null}
      {item.posterName !== null ? (
        <>
          {" "}by <a href={userLink(item.posterName)}>{item.posterName}</a>
        </>
      ) : null}
    </div>
  );
}

/** One shared/issuelist.tmpl `.item` at `listType "dashboard"` — the
 *  `{owner}/{repo}#{index}` index form (issuelist.tmpl:44-45); the label
 *  badges keep the page's type/sort/state/q and set `labels` (upstream's
 *  badge href QueryBuilds the dashboard root link — issuelist.tmpl:31). */
function OverviewIssueRow(props: { item: OverviewIssueItem; data: OverviewIssuesData }) {
  const { item, data } = props;
  const href = overviewIssueUrl(item);
  return (
    <div class="item">
      <div class="item-leading">
        <div class="flex-text-inline tw-mt-[3px]">
          <OverviewIssueIcon item={item} />
        </div>
      </div>
      <div class="item-main">
        <div class="item-header">
          <div>
            <a class="list-item-large-title" href={href}>
              {item.title}
            </a>
            {item.labels.length > 0 ? (
              <span class="labels-list">
                {item.labels.map((label) => (
                  <a
                    key={label.id}
                    class="item"
                    href={overviewHref(`/${data.listKind}`, {
                      viewType: data.viewType,
                      sort: data.sort,
                      state: data.state,
                      keyword: data.keyword,
                      labels: [label.id],
                    })}
                  >
                    <LabelBadge label={label} />
                  </a>
                ))}
              </span>
            ) : null}
          </div>
        </div>
        <div class="item-body tw-gap-2">
          <a class="index flex-text-inline" href={href}>
            {item.ownerNamespace}/{item.slug}#{item.index}
          </a>
          <OverviewEventLine item={item} />
          {item.milestone !== null ? (
            <a
              class="milestone flex-text-inline tw-max-w-[300px]"
              href={`/${item.ownerNamespace}/${item.slug}/milestone/${item.milestone.id}`}
            >
              <Icon name="octicon-milestone" size={14} />
              <span class="gt-ellipsis">{item.milestone.name}</span>
            </a>
          ) : null}
        </div>
      </div>
      {item.numComments > 0 ? (
        <div class="item-trailing">
          <div class="tw-text-text-light">
            <a class="tw-no-underline muted flex-text-block" href={href}>
              {item.numComments}
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The type-arm nav menu (issues.tmpl:13-33) — one anchor per rendered arm
 *  with its `<strong>count</strong>`; the hrefs keep sort/state/q/labels
 *  (upstream QueryBuild $queryLink "type" X). */
function TypeNavMenu(props: { data: OverviewIssuesData }) {
  const { data } = props;
  return (
    <div class="ui secondary vertical filter menu tw-bg-transparent">
      {renderedArms(data.listKind).map((arm) => (
        <a
          key={arm}
          class={data.viewType === arm ? "active item" : "item"}
          href={overviewHref(`/${data.listKind}`, {
            viewType: arm,
            sort: data.sort,
            state: data.state,
            keyword: data.keyword,
            labels: data.labels,
            // The arm overrides its facet — the hrefs drop the stale
            // poster/assignee params when switching arms (home.go:489-499).
          })}
        >
          {armLabel(arm)} <strong>{data.armCounts[arm] ?? 0}</strong>
        </a>
      ))}
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderOverviewIssuesPage(ctx: UiContext, data: OverviewIssuesData): string {
  return renderPage(<OverviewIssuesPage ctx={ctx} data={data} />);
}

/** The issues/pulls overview page (§2.4.1 discriminator:
 *  `dashboard issues` — the ONE upstream template serves both lists). */
export function OverviewIssuesPage(props: { ctx: UiContext; data: OverviewIssuesData }) {
  const { ctx, data } = props;
  if (ctx.viewer.kind !== "user") throw new Error("OverviewIssuesPage requires a signed-in viewer");
  const title = data.listKind === "pulls" ? globalInboxLocale.pulls : globalInboxLocale.issues;
  const base = `/${data.listKind}`;
  const hrefFor = (over: Parameters<typeof overviewHref>[1]): string =>
    overviewHref(base, {
      viewType: data.viewType,
      sort: data.sort,
      state: data.state,
      keyword: data.keyword,
      labels: data.labels,
      poster: data.poster,
      assignee: data.assignee,
      ...over,
    });
  return (
    <BaseLayout ctx={ctx} title={title} pageClass="dashboard issues">
      <DashboardInboxNavbar selfName={ctx.viewer.username} active={data.listKind} />
      <div class="ui container">
        <div class="flex-container">
          <div class="flex-container-nav">
            <TypeNavMenu data={data} />
          </div>
          <div class="flex-container-main content">
            <div class="list-header">
              <InboxToggleTabs
                hrefOpen={hrefFor({ state: "open", page: 1 })}
                hrefClosed={hrefFor({ state: "closed", page: 1 })}
                state={data.state}
                openCount={data.openCount}
                closedCount={data.closedCount}
                openGlyph="octicon-issue-opened"
                closedGlyph="octicon-issue-closed"
              />
              <InboxSearchForm
                action={base}
                placeholder={
                  data.listKind === "pulls" ? globalInboxLocale.search_pulls : globalInboxLocale.search_issues
                }
                keyword={data.keyword}
                hidden={[
                  ["type", data.viewType],
                  ["sort", data.sort],
                  ["state", data.state],
                ]}
              />
            </div>
            {data.items.length === 0 ? (
              <div class="tw-text-center tw-p-8">
                <h3 class="tw-my-4">{globalInboxLocale.no_results}</h3>
                <p class="tw-text-placeholder-text">{globalInboxLocale.no_results_placeholder}</p>
              </div>
            ) : (
              <div id="issue-list" class="flex-divided-list items-with-main">
                {data.items.map((item) => (
                  <OverviewIssueRow key={item.issueId} item={item} data={data} />
                ))}
              </div>
            )}
            <InboxPager href={(page) => hrefFor({ page })} page={data.page} more={data.more} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// Components — the milestones dashboard page
// ---------------------------------------------------------------------------

/** The canonical milestones URL for one filter set — the template's param
 *  order (repos, sort, state, q — milestones.tmpl:34-38, 76); defaults and
 *  empties omitted; page resets unless given. */
function milestonesInboxHref(
  opts: {
    repos?: string[];
    sort?: MilestonesInboxSortType;
    state?: "open" | "closed";
    keyword?: string;
    page?: number;
  },
): string {
  const params = new URLSearchParams();
  if (opts.repos !== undefined && opts.repos.length > 0) params.set("repos", reposParamValue(opts.repos));
  if (opts.sort !== undefined && opts.sort !== "closestduedate") params.set("sort", opts.sort);
  if (opts.state === "closed") params.set("state", "closed");
  if (opts.keyword !== undefined && opts.keyword !== "") params.set("q", opts.keyword);
  if (opts.page !== undefined && opts.page > 1) params.set("page", String(opts.page));
  const query = params.toString();
  return query === "" ? "/milestones" : `/milestones?${query}`;
}

/** The milestones nav sidebar (milestones.tmpl:10-32): the
 *  "In your repositories" total item, a divider, then one `.repo.name.item`
 *  per milestone-bearing repo — full-name span + the state-colored count
 *  label, active when in the current `?repos=` set. Each link TOGGLES the
 *  repo's membership in the filter (upstream's include/remove loop). */
function MilestonesInboxNav(props: { data: DashboardMilestonesData }) {
  const { data } = props;
  return (
    <div class="ui secondary vertical filter menu tw-bg-transparent">
      <div class="item">
        {globalInboxLocale.in_your_repos} <strong>{data.total}</strong>
      </div>
      {data.repoMenu.length > 0 ? <div class="divider"></div> : null}
      {data.repoMenu.map((repo) => {
        const next = repo.active
          ? data.repoFilter.filter((id) => id !== repo.repoId)
          : [...data.repoFilter, repo.repoId];
        return (
          <a
            key={repo.repoId}
            class={repo.active ? "active repo name item" : "repo name item"}
            href={milestonesInboxHref({ repos: next, sort: data.sort, state: data.state, keyword: data.keyword })}
            title={`${repo.ownerNamespace}/${repo.slug}`}
          >
            <span class="tw-inline-block tw-truncate tw-w-3/4">
              {repo.ownerNamespace}/{repo.slug}
            </span>
            <div class={data.state === "closed" ? "ui red label" : "ui green label"}>{repo.count}</div>
          </a>
        );
      })}
    </div>
  );
}

/** One milestone row (milestones.tmpl:106-152) — the repo milestones row's
 *  vocabulary (pages/milestones.tsx's locale + due-date formatter,
 *  reused) at the cross-repo projection: the `.ui.large.label` repo full
 *  name, the milestone link onto the LANDED detail page, the completeness
 *  pair, the counts, the updated stamp and the due-date line. The
 *  description block and tracked-time chip are not rendered (module
 *  header). */
function DashboardMilestoneRow(props: { item: DashboardMilestoneItem }) {
  const { item } = props;
  const repoLink = `/${item.ownerNamespace}/${item.slug}`;
  return (
    <div class="item flex-relaxed-list">
      <div class="flex-left-right">
        <span class="list-item-large-title">
          <span class="ui large label">
            {item.ownerNamespace}/{item.slug}
          </span>
          <Icon name="octicon-milestone" size={16} />{" "}
          <a class="muted" href={`${repoLink}/milestone/${item.row.id}`}>
            {item.row.name}
          </a>
        </span>
        <div class="flex-text-inline">
          <span>{item.completeness}%</span>
          <progress class="list-item-title-progress" value={item.completeness} max={100} />
        </div>
      </div>
      <div class="list-item-secondary-bar">
        <div class="flex-text-block tw-flex-wrap">
          <div class="flex-text-inline">
            <Icon name="octicon-issue-opened" size={14} /> {item.openIssues} {globalInboxLocale.open_title}
          </div>
          <div class="flex-text-inline">
            <Icon name="octicon-check" size={14} /> {item.row.numClosedIssues ?? 0} {globalInboxLocale.closed_title}
          </div>
          {item.row.updatedAt !== null ? (
            <div class="flex-text-inline">
              <Icon name="octicon-clock" size={14} /> {milestonesLocale.update_ago}{" "}
              <TimeSince unixSeconds={Math.floor(item.row.updatedAt.getTime() / 1000)} tz="+0000" />
            </div>
          ) : null}
          <div class="flex-text-inline">
            {item.row.isClosed ? (
              <>
                <Icon name="octicon-clock" size={14} /> {milestonesLocale.closed_ago}
                {item.row.closedDateAt !== null ? (
                  <>
                    {" "}
                    <TimeSince unixSeconds={Math.floor(item.row.closedDateAt.getTime() / 1000)} tz="+0000" />
                  </>
                ) : null}
              </>
            ) : item.row.deadlineAt !== null ? (
              <span class={item.overdue ? "flex-text-inline tw-text-red" : "flex-text-inline"}>
                <Icon name="octicon-calendar" size={14} /> {formatDueDate(item.row.deadlineAt)}
              </span>
            ) : (
              <span class="flex-text-inline">
                <Icon name="octicon-calendar" size={14} /> {milestonesLocale.no_due_date}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderDashboardMilestonesPage(ctx: UiContext, data: DashboardMilestonesData): string {
  return renderPage(<DashboardMilestonesPage ctx={ctx} data={data} />);
}

/** The milestones dashboard page (§2.4.1 discriminator:
 *  `dashboard issues repository milestones` — milestones.tmpl:4). */
export function DashboardMilestonesPage(props: { ctx: UiContext; data: DashboardMilestonesData }) {
  const { ctx, data } = props;
  if (ctx.viewer.kind !== "user") throw new Error("DashboardMilestonesPage requires a signed-in viewer");
  return (
    <BaseLayout
      ctx={ctx}
      title={globalInboxLocale.milestones}
      pageClass="dashboard issues repository milestones"
    >
      <DashboardInboxNavbar selfName={ctx.viewer.username} active="milestones" />
      <div class="ui container">
        <div class="flex-container">
          <div class="flex-container-nav">
            <MilestonesInboxNav data={data} />
          </div>
          <div class="flex-container-main">
            <div class="list-header">
              <InboxToggleTabs
                hrefOpen={milestonesInboxHref({
                  repos: data.repoFilter,
                  sort: data.sort,
                  state: "open",
                  keyword: data.keyword,
                })}
                hrefClosed={milestonesInboxHref({
                  repos: data.repoFilter,
                  sort: data.sort,
                  state: "closed",
                  keyword: data.keyword,
                })}
                state={data.state}
                openCount={data.openCount}
                closedCount={data.closedCount}
                openGlyph="octicon-milestone"
                closedGlyph="octicon-check"
              />
              <InboxSearchForm
                action="/milestones"
                placeholder={globalInboxLocale.milestones}
                keyword={data.keyword}
                hidden={[
                  ["type", "your_repositories"],
                  ["repos", data.repoFilter.length > 0 ? reposParamValue(data.repoFilter) : ""],
                  ["sort", data.sort],
                  ["state", data.state],
                ]}
              />
            </div>
            {data.items.length === 0 ? (
              <div class="tw-text-center tw-p-8">
                <h3 class="tw-my-4">{globalInboxLocale.no_results}</h3>
                <p class="tw-text-placeholder-text">{globalInboxLocale.no_results_placeholder}</p>
              </div>
            ) : (
              <div class="flex-divided-list">
                {data.items.map((item) => (
                  <DashboardMilestoneRow key={item.row.id} item={item} />
                ))}
              </div>
            )}
            <InboxPager
              href={(page) =>
                milestonesInboxHref({
                  repos: data.repoFilter,
                  sort: data.sort,
                  state: data.state,
                  keyword: data.keyword,
                  page,
                })
              }
              page={data.page}
              more={data.more}
            />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

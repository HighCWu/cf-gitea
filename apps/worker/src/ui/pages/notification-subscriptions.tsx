/**
 * The notifications subscriptions pages — `/notifications/subscriptions` and
 * `/notifications/watching` — pages wave 52 (module only, UNMOUNTED — the
 * route arms ride the notifications route window; `index.ts` is
 * orchestrator/sibling-owned). Upstream `user.NotificationSubscriptions`
 * (routers/web/user/notification.go:222-338) + `user.NotificationWatching`
 * (notification.go:341-431), registered inside the reqSignIn
 * `/notifications` group (routers/web/web.go:1784-1792: `/subscriptions`
 * line 1786, `/watching` line 1787); both render the SAME template,
 * `templates/user/notification/notification_subscriptions.tmpl`, dispatched
 * on its `.Status` data key (1 = subscriptions arm, 2 = watching arm).
 *
 * ## HANDOFF NOTE (for the wiring wave)
 *
 * - The page module is complete end-to-end: `loadSubscriptionsData` /
 *   `loadWatchingData` (the data seams) and
 *   `renderNotificationSubscriptionsPage` (the full-document render). Each
 *   route arm is: resolve the viewer (the SPEC-0010 seam — reqSignIn, so a
 *   non-user viewer 303s `/login?redirect_to=` like the rest of the
 *   `/notifications` group) → call the arm's loader with the request's
 *   `URLSearchParams` → render. No route-side projection.
 * - Upstream's past-the-end behavior differs per arm and the module follows
 *   both: NotificationSubscriptions 303s onto `?page=last`
 *   (notification.go:330-334) — the subscriptions loader instead CLAMPS the
 *   page onto the last page and re-renders (the landed notifications page's
 *   posture, pages/notifications.tsx "past-the-end clamp"); a wiring wave
 *   wanting the literal 303 can compare
 *   `page > max(1, ceil(total / SUBSCRIPTIONS_PAGE_SIZE))` before rendering
 *   (the loader re-queries internally, so no state leaks).
 *   NotificationWatching has no redirect — a past-the-end page just renders
 *   an empty list under an absent pager — matched exactly.
 * - Anonymous viewers never reach the loaders (upstream reqSignIn); both
 *   loaders narrow the viewer to the signed-in slice.
 * - No fragment arm exists upstream for this template (unlike the
 *   notifications table's div morph) — the full-document render is the
 *   module's whole DOM surface.
 *
 * ## DOM contract (notification_subscriptions.tmpl + shared/issuelist.tmpl
 *  `listType "dashboard"` + shared/repo/search.tmpl + shared/repo/list.tmpl
 *  + shared/issueicon.tmpl + base/paginate.tmpl at the pin)
 *
 * `.page-content.user.notification` (role=main, aria-label = the page
 * title): the `ui.compact.small.menu.small-menu-items` Status tab strip
 * (template lines 4-11 — `Subscriptions` → `/notifications/subscriptions`,
 * active at Status 1; `Watching` → `/notifications/watching`, active at
 * Status 2), then the `ui.top.attached.segment` carrying the arm:
 *
 * - **Status 1** (lines 13-68): the `flex-left-right` header row — left,
 *   the `small-menu-items ui.compact.tiny.menu` all/open/closed state tabs
 *   (plain anchors carrying the octicon-issue-opened/-closed glyphs on the
 *   open/closed tabs); right, the Type (all/issues/pulls) and Sort
 *   (latest/oldest/recentupdate/leastupdate/mostcomment/leastcomment/
 *   nearduedate/farduedate) Fomantic dropdowns; then a `divider`, and the
 *   body — the bare `notification.no_subscriptions` line ("No
 *   subscriptions") on an empty set, else the shared issuelist at
 *   `listType "dashboard"` plus `base/paginate`.
 * - **Status 2** (lines 69-74): `shared/repo/search` (the GET form: the
 *   `q` input + submit, plus the Filter and Sort JS dropdowns), a
 *   `divider`, `shared/repo/list` (the repo rows) and `base/paginate`.
 *
 * The issuelist row (shared/issuelist.tmpl at `listType "dashboard"`) is the
 * landed issues-list reduction (pages/issues-list.tsx) cross-repo widened:
 * `.item-leading` state glyph (shared/issueicon.tmpl — the full PR state
 * machine incl. merged/WIP, the notifications page's ThreadIcon shape),
 * `.item-header` title link + `.labels-list` badges, `.item-body` with the
 * DASHBOARD index form (`{{$issue.Repo.FullName}}#{{$issue.Index}}` —
 * issuelist.tmpl:44-45, the only listType difference in the body) + the
 * GetLastEventTimestamp event line + the milestone link, `.item-trailing`
 * comment count. Title/index anchors are `Issue.Link()` (models/issues/
 * issue.go:397-404 — `/{owner}/{repo}/{issues|pulls}/{index}`; the
 * template's `{{$root.Link}}` fallback never fires, the method is
 * non-nil).
 *
 * ## Data — the subscribed-issues read (the audit's two seams)
 *
 * Upstream queries `issues_model.Issues`/`CountIssues` with
 * `SubscriberID: ctx.Doer.ID` (notification.go:265-285) — the
 * `applySubscribedCondition` predicate (models/issues/issue_search.go:456-485),
 * re-issued here verbatim over the LANDED tables: an explicit unsubscribe
 * row (`issue_subscriptions.is_watching = 0`) EXCLUDES the issue, and the
 * subscription disjunction is issue-level `is_watching` rows ∨ past
 * commenter ∨ issue poster ∨ repo-level watch rows (`repo_watchers` —
 * upstream's `watch.mode IN (normal, auto, custom)` collapses to row
 * presence, the landed repo-watchers model's "ignored is always false",
 * services/repo-watchers.ts header). The seams are the same joins the
 * notifications queries landed (pages/notifications.tsx's left-join shape);
 * here the arms are EXISTS subqueries instead — row-unique sources, so the
 * COUNT cannot fan out and no join bookkeeping is needed.
 *
 * The doer-scoped access condition (issue_search.go:288's
 * `issuePullAccessibleRepoCond` for non-admin doers) reduces to the SHARED
 * `readGrant` predicate in SQL — exactly dashboard.tsx's watched-list
 * posture (public/limited owner rows require an active owner; own rows
 * always grant; site admin bypasses; no team arm, the dashboard's recorded
 * scope) — so a subscribed issue in a repo the viewer can no longer read
 * never surfaces, exactly like upstream's accessible-repo condition.
 *
 * Filters (notification.go:223-263): `?page=` (max(…, 1)), `?state=` ∈
 * {all, open, closed} — exact lowercase values only, everything else (incl.
 * other casings: upstream validates case-insensitively but USES the value
 * case-sensitively, so the observable behavior degrades to all) filters
 * nothing, `?issueType=` issues → is_pull = 0, pulls →
 * is_pull = 1, anything else no filter (upstream optional.None), `?labels=`
 * a comma list of label ids ("0" = unset; ANY unparseable entry drops the
 * whole filter — upstream StringsToInt64s error arm notification.go:257-263,
 * minus the flash machinery, which is not landed). Sorts are upstream
 * applySorts (issue_search.go:74-127) verbatim, INCLUDING the
 * milestone-aware due-date CASE pair (via a correlated `milestones`
 * subquery instead of the LEFT JOIN — same rows, no join bookkeeping);
 * `latest` (created DESC, id DESC) is the default for unknown values.
 * 20 per page (`setting.UI.IssuePagingNum`, modules/setting/ui.go:89).
 *
 * ## The watching read
 *
 * `SearchRepository` with `WatchedByID: ctx.Doer.ID` +
 * `Collaborate: Some(false)` (notification.go:390-408) over the landed
 * model: the `repo_watchers` edges joined to their repositories + owners
 * (the dashboard watched-list FROM shape), the readGrant SQL above, and
 * `Collaborate` reduced to nothing (no collaborator edges — the landed
 * search service's recorded TODO(SPEC-0005), which likewise leaves nothing
 * to exclude). Keyword search is the landed repo-search keyword arm
 * verbatim (services/repository.ts — comma-separated, case-insensitive slug
 * substring + the one-slash `owner/name` pair; upstream's
 * includeDescription needs no description column — TODO(SPEC-0005)).
 * `?sort=` is the upstream switch (notification.go:347-373): newest/oldest
 * through the landed created column, recentupdate/leastupdate (the
 * DEFAULT, also for unknown values) through updated, the alphabetical pair
 * through owner+slug; the stars/forks family has no landed counters and
 * degrades to the default order — the explore mapping's recorded
 * divergence (services/search.ts exploreRepoSort). The facet params
 * (`?archived|fork|mirror|template|private=`, `?topic=`) keep upstream's
 * FormOptionalBool tri-state parsing and repo_list.go:385-523 equality
 * arms (fork through the landed `fork_parent IS NOT NULL` edge, the
 * search service's mapping; `?topic=true` matches nothing — no topics
 * table, the search service's `noMatch` posture) even though the dropdown
 * that would set them is unrendered (below). 15 per page
 * (`setting.UI.User.RepoPagingNum`, modules/setting/ui.go:144-148).
 *
 * ## Documented v1 degradations (§6 method — no dead controls)
 *
 * - The Type and Sort dropdowns (subscriptions arm) and the Filter/Sort
 *   dropdowns (watching arm) are NOT rendered: a server-rendered Fomantic
 *   dropdown needs the JS contract this module does not pin (the
 *   org-labels/explore precedent, pages/org-labels.tsx "the upstream
 *   control is a JS dropdown"). Every value they would submit is still
 *   HONORED by the loaders as plain query parameters (documented above) —
 *   only the unopenable controls are absent.
 * - The all/open/closed tabs and the Status tab strip ARE rendered live:
 *   upstream renders them as plain anchors (template lines 5-8, 17-27),
 *   no JS involved. Their hrefs keep the canonical active filter set
 *   (the issues-list `listHref` convention: defaults/empties omitted —
 *   upstream echoes raw params, same filter semantics).
 * - The subscriptions row is the landed issues-list projection (header
 *   citations): no commit-status chip, branch pair, tracked time, task
 *   scan, ref, project or approval counters (the issues-list row's shape —
 *   no landed source in this projection), no assignee avatars (no avatar
 *   pipeline), due-date chip not rendered (the sort still honors
 *   deadlines). The milestone badge LINKS (upstream issuelist.tmpl:82-85's
 *   `$issue.Repo.Link` href — the milestone detail page is landed; the
 *   plain-text note in the issues-list header predates it).
 * - The comment count renders the bare count (upstream
 *   issuelist.tmpl:155-160 pairs `octicon-comment` with it — the icon is
 *   outside the generated allowlist; the landed issues-list row's
 *   count-only precedent).
 * - Label-badge hrefs reset every filter but the badge id
 *   (`?labels={id}`): upstream's badge href (issuelist.tmpl:31) echoes the
 *   dashboard root's `q`/`type`/`state` — all empty on this page — so the
 *   effective upstream href is the same reset.
 * - The event line is the issues-list EventLine literals plus the merged
 *   arm ("merged {time} by {poster}" — upstream GetLastEventLabel,
 *   models/issues/issue.go:460-468, whose merged branch the landed row
 *   data already carries via `pull_requests.has_merged`); mirrored-import
 *   rows (no poster row) render without the "by" tail (the issues-list
 *   posture).
 * - Empty watching results render upstream's "search.no_results" line in
 *   shared/repo/list.tmpl:85-88's bare-div wrapper.
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { hasWorkInProgressPrefix, issueLabelRows } from "../../api/services/issues";
import type { LabelRow } from "../../issues/service";
import {
  issues,
  milestones,
  pullRequests,
  repoSettings,
  repoWatchers,
  repositories,
  users,
} from "../../db/schema";
import { TimeSince } from "../components/file-list";
import { userLink } from "../links";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { LabelBadge } from "./issues-list";
import { OrgRepoListItem, type OrgHomeRepoItem } from "./org-home";

/** Page chrome text (component-local, the notificationsLocale pattern —
 *  locale.ts is shared and not this wave's file). */
export const notificationSubscriptionsLocale = {
  subscriptions: "Subscriptions", // "notification.subscriptions"
  watching: "Watching", // "notification.watching"
  no_subscriptions: "No subscriptions", // "notification.no_subscriptions"
  all: "All", // "all"
  open_title: "Open", // "repo.issues.open_title"
  closed_title: "Closed", // "repo.issues.closed_title"
  repos_placeholder: "Search repos…", // "search.repo_kind" (shared/repo/search input)
  search: "Search…", // "search.search" (the submit button — upstream renders
  //  the octicon-search glyph, outside the generated allowlist; the
  //  aria-label becomes the button text, the explore form's note)
  no_results: "No matching results found.", // "search.no_results" (shared/repo/list empty arm)
} as const;

/** Upstream `setting.UI.IssuePagingNum` (modules/setting/ui.go:89) — the
 *  subscriptions arm's page size (notification.go:277). */
export const SUBSCRIPTIONS_PAGE_SIZE = 20;

/** Upstream `setting.UI.User.RepoPagingNum` (modules/setting/ui.go:145) —
 *  the watching arm's page size (notification.go:392). */
export const WATCHING_PAGE_SIZE = 15;

/** The signed-in viewer slice both loaders take (upstream reqSignIn — the
 *  route arm guarantees the kind). */
type SignedInViewer = Extract<Viewer, { kind: "user" }>;

// ---------------------------------------------------------------------------
// Query-param parsing (upstream notification.go:223-263 + 344-408)
// ---------------------------------------------------------------------------

/**
 * The subscriptions state tab (upstream FormString "state"). Upstream's
 * SliceContainsString validates {all, open, closed} case-INsensitively, but
 * every USE of the value is case-sensitive (the showClosed switch,
 * notification.go:236-241, and the template's `eq .State` active checks) —
 * so a non-lowercase match observably degrades to "all" on every surface.
 * The parser ports the observable behavior: exact tri-state, else all.
 */
export type SubscriptionsState = "all" | "open" | "closed";

export function parseSubscriptionsState(raw: string | null): SubscriptionsState {
  return raw === "open" || raw === "closed" || raw === "all" ? raw : "all";
}

/** The Type filter (`?issueType=`): issues → plain issues, pulls → PRs,
 *  anything else (incl. "all"/empty — upstream optional.None) no filter.
 *  Upstream keeps the raw echo for the unrendered dropdown's active state;
 *  the canonical hrefs below only re-emit the filtering values. */
export type IssueTypeFilter = "all" | "issues" | "pulls";

export function parseIssueType(raw: string | null): IssueTypeFilter {
  return raw === "issues" || raw === "pulls" ? raw : "all";
}

/** The subscriptions sorts — upstream applySorts' vocabulary
 *  (issue_search.go:86-118); `latest` (created DESC, id DESC) is the
 *  default arm. */
export type IssueSortType =
  | "latest"
  | "oldest"
  | "recentupdate"
  | "leastupdate"
  | "mostcomment"
  | "leastcomment"
  | "nearduedate"
  | "farduedate";

export function parseIssueSort(raw: string | null): IssueSortType {
  switch (raw) {
    case "oldest":
    case "recentupdate":
    case "leastupdate":
    case "mostcomment":
    case "leastcomment":
    case "nearduedate":
    case "farduedate":
      return raw;
    default:
      return "latest";
  }
}

/**
 * `?labels=` — comma-separated label ids (upstream FormString "labels":
 * absent/empty/"0" → no filter; ANY unparseable entry → no filter, the
 * StringsToInt64s error arm (notification.go:257-263) whose flash is not
 * landed). Valid ids keep their sign — upstream applyLabelsCondition treats
 * negatives as EXCLUSIONS (issue_search.go:149-172); duplicates dedupe
 * (upstream container.Set); bare "0" entries are ignored
 * (issue_search.go:155's comment).
 */
export function parseLabelsFilter(raw: string | null): number[] {
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

/** The watching sorts — upstream NotificationWatching's orderBy switch
 *  (notification.go:347-373). The stars/forks family maps to the default:
 *  no landed star/fork counters (the exploreRepoSort divergence). */
export type WatchingSortType =
  | "newest"
  | "oldest"
  | "recentupdate"
  | "leastupdate"
  | "alphabetically"
  | "reversealphabetically";

export function parseWatchingSort(raw: string | null): WatchingSortType {
  switch (raw) {
    case "newest":
    case "oldest":
    case "leastupdate":
    case "alphabetically":
    case "reversealphabetically":
      return raw;
    // "recentupdate", the stars/forks family, unknown values — the default
    // arm (notification.go:370-373 sets recentupdate for unknowns; the
    // counters-backed family degrades per the module header).
    default:
      return "recentupdate";
  }
}

/**
 * Upstream `FormOptionalBool` (optional.ParseBool over FormString):
 * strconv's bool set → true/false, anything else (incl. absent) → null =
 * no filter.
 */
export function parseOptionalBoolParam(raw: string | null): boolean | null {
  if (raw === null) return null;
  const value = raw.toLowerCase();
  if (value === "1" || value === "t" || value === "true") return true;
  if (value === "0" || value === "f" || value === "false") return false;
  return null;
}

/** Trimmed `?q=` (upstream FormTrim). */
export function parseWatchingKeyword(raw: string | null): string {
  return (raw ?? "").trim();
}

// ---------------------------------------------------------------------------
// The shared access predicate — readGrant in SQL (the dashboard posture)
// ---------------------------------------------------------------------------

/**
 * The repo-read grant for a signed-in non-admin doer, expressed over the
 * joined `repositories` + `users` rows: publiclyVisible ∨ isOwner ∨ the
 * limited-owner branch (git-http/acl.ts readGrant verbatim, minus the team
 * arm — the dashboard.tsx watched-list scope). Site admin sees every row
 * (readGrant's isSiteAdmin arm) — the caller drops the predicate entirely.
 */
function visibleRepoGrantSql(userId: number, isAdmin: boolean): SQL | null {
  if (isAdmin) return null;
  return sql`(${users.status} = 'active' AND ((${repositories.visibility} = 'public' AND ${users.visibility} IN ('public', 'limited')) OR ${repositories.ownerId} = ${userId}))`;
}

// ---------------------------------------------------------------------------
// The subscriptions arm (Status 1) — data
// ---------------------------------------------------------------------------

/** One rendered row (the reduced issuelist "dashboard" item — module
 *  header for the projection's citations). */
export interface SubscriptionIssueItem {
  /** The underlying issues.id (upstream's `data-issue-id` row key — not
   *  rendered here; the id is the row identity). */
  issueId: number;
  index: number;
  title: string;
  isPull: boolean;
  isClosed: boolean;
  /** The pull_requests.has_merged extension flag (the merged glyph + the
   *  merged event-line arm); false for plain issues. */
  hasMerged: boolean;
  /** The repo full name's two halves (the dashboard index form
   *  `FullName#index` and every per-row link). */
  ownerNamespace: string;
  slug: string;
  numComments: number;
  /** The row's milestone (issuelist.tmpl:81-86) — name + the live
   *  milestone-detail link target. */
  milestone: { id: number; name: string } | null;
  labels: LabelRow[];
  /** Display-cased poster username; `null` = no poster row (mirrored
   *  imports render without the "by" tail). */
  posterName: string | null;
  /** GetLastEventTimestamp (issue.go:452-457): closed → closedAt, open →
   *  createdAt, with the updatedAt fallback for unstamped rows. */
  lastEventAt: number | null;
}

/** The subscriptions render inputs. */
export interface SubscriptionsData {
  status: 1;
  state: SubscriptionsState;
  issueType: IssueTypeFilter;
  sort: IssueSortType;
  /** The active label filter ([] = none — positives include, negatives
   *  exclude; the `?labels=` parse above). */
  labels: number[];
  page: number;
  total: number;
  items: SubscriptionIssueItem[];
}

/**
 * The subscribed-issue predicate — applySubscribedCondition
 * (issue_search.go:456-485) re-issued over the landed tables: an explicit
 * `is_watching = 0` row excludes, then the disjunction (watching row ∨
 * past commenter ∨ poster ∨ repo watcher). EXISTS forms keep every source
 * row-unique, so count and page queries agree.
 */
function subscribedConditionSql(userId: number): SQL {
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM issue_subscriptions un
      WHERE un.issue_id = ${issues.id} AND un.user_id = ${userId} AND un.is_watching = 0
    )
    AND (
      EXISTS (
        SELECT 1 FROM issue_subscriptions s
        WHERE s.issue_id = ${issues.id} AND s.user_id = ${userId} AND s.is_watching = 1
      )
      OR EXISTS (
        SELECT 1 FROM comments pc
        WHERE pc.issue_id = ${issues.id} AND pc.poster_id = ${userId}
      )
      OR ${issues.posterId} = ${userId}
      OR EXISTS (
        SELECT 1 FROM repo_watchers w
        WHERE w.repo_id = ${issues.repoId} AND w.user_id = ${userId}
      )
    )
  )`;
}

/** The milestone-aware due date — applySorts' nearduedate/farduedate CASE
 *  (issue_search.go:101-118) with the LEFT JOIN inlined as a correlated
 *  `milestones` subquery; nullable columns coalesce to upstream's 0
 *  default so the arms read verbatim. */
function effectiveDueExpr(): SQL {
  const mDeadline = sql`(SELECT m.deadline_unix FROM milestones m WHERE m.id = ${issues.milestoneId})`;
  const iDeadline = sql`coalesce(${issues.deadlineAt}, 0)`;
  return sql`CASE
    WHEN ${iDeadline} = 0 AND coalesce(${mDeadline}, 0) = 0 THEN 253370764800
    WHEN coalesce(${mDeadline}, 0) = 0 THEN ${iDeadline}
    WHEN ${mDeadline} < ${iDeadline} OR ${iDeadline} = 0 THEN ${mDeadline}
    ELSE ${iDeadline} END`;
}

/** The eight upstream orders (issue_search.go:86-127 verbatim; `latest` is
 *  the default arm). */
function issueSortOrder(sort: IssueSortType): SQL[] {
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

/** The WHERE conjuncts shared by the page + count queries. */
function subscriptionsConditions(
  viewer: SignedInViewer,
  state: SubscriptionsState,
  issueType: IssueTypeFilter,
  labels: number[],
): SQL[] {
  const conditions: SQL[] = [subscribedConditionSql(viewer.id)];
  const grant = visibleRepoGrantSql(viewer.id, viewer.isAdmin);
  if (grant !== null) conditions.push(grant);
  if (state === "open") conditions.push(eq(issues.isClosed, false));
  if (state === "closed") conditions.push(eq(issues.isClosed, true));
  if (issueType === "issues") conditions.push(eq(issues.isPull, false));
  if (issueType === "pulls") conditions.push(eq(issues.isPull, true));
  // applyLabelsCondition (issue_search.go:144-174): positives must ALL be
  // attached (the count-equality over the unique (issue_id, label_id)
  // index), negatives must NOT be attached.
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

/** Batched poster display names for one page (the issues-list pattern). */
async function posterNamesFor(d1: D1Database, posterIds: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  if (posterIds.length === 0) return names;
  const rows = await drizzle(d1)
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(inArray(users.id, posterIds))
    .all();
  for (const row of rows) names.set(row.id, row.username);
  return names;
}

/** Nullable timestamp column → unix seconds (null stays null). */
function unixOrNull(date: Date | null): number | null {
  return date === null ? null : Math.floor(date.getTime() / 1000);
}

/**
 * Load one page of the viewer's subscribed issues (§3.2 — the re-issued
 * SubscriberID read): the state/type/label filters, the upstream sort, the
 * 20-row page and the filtered total for the pager. Requested pages past
 * the end clamp onto the last page and RE-QUERY (the landed notifications
 * page's posture — upstream 303s instead; the header's HANDOFF records the
 * seam). Enrichment is the issues-list loader's batching: per-row label
 * joins, then one milestones read and one posters read for the page.
 */
export async function loadSubscriptionsData(
  d1: D1Database,
  viewer: SignedInViewer,
  params: URLSearchParams,
): Promise<SubscriptionsData> {
  const state = parseSubscriptionsState(params.get("state"));
  const issueType = parseIssueType(params.get("issueType"));
  const sort = parseIssueSort(params.get("sort"));
  const labels = parseLabelsFilter(params.get("labels"));
  const db = drizzle(d1);

  const load = async (page: number): Promise<{ items: SubscriptionIssueItem[]; total: number }> => {
    const where = and(...subscriptionsConditions(viewer, state, issueType, labels));
    const countRows = await db
      .select({ value: sql<number>`count(*)` })
      .from(issues)
      .innerJoin(repositories, eq(repositories.id, issues.repoId))
      .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
      .where(where);
    const total = countRows[0]?.value ?? 0;
    const rows = await db
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
      .leftJoin(pullRequests, eq(pullRequests.issueId, issues.id))
      .where(where)
      .orderBy(...issueSortOrder(sort))
      .limit(SUBSCRIPTIONS_PAGE_SIZE)
      .offset((page - 1) * SUBSCRIPTIONS_PAGE_SIZE);

    const items: SubscriptionIssueItem[] = await Promise.all(
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
          row.isClosed === true
            ? (row.closedAt ?? row.updatedAt ?? row.createdAt)
            : (row.createdAt ?? row.updatedAt),
        ),
      })),
    );

    // Batched milestone names + poster names for the page (unique ids; the
    // issues-list pattern).
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
    const posters = await posterNamesFor(
      d1,
      rows.flatMap((row) => (row.posterId === null ? [] : [row.posterId])),
    );
    for (const [i, row] of rows.entries()) {
      const item = items[i];
      if (item === undefined) throw new Error("subscriptions page row vanished during enrichment");
      item.milestone = row.milestoneId === null ? null : (milestonesById.get(row.milestoneId) ?? null);
      item.posterName = row.posterId === null ? null : (posters.get(row.posterId) ?? null);
    }
    return { total, items };
  };

  let page = Math.max(1, parsePageNumber(params.get("page")));
  let loaded = await load(page);
  const totalPages = Math.max(1, Math.ceil(loaded.total / SUBSCRIPTIONS_PAGE_SIZE));
  if (page > totalPages) {
    page = totalPages;
    loaded = await load(page);
  }
  return { status: 1, state, issueType, sort, labels, page, total: loaded.total, items: loaded.items };
}

// ---------------------------------------------------------------------------
// The watching arm (Status 2) — data
// ---------------------------------------------------------------------------

/** One rendered repo row (the shared/repo/list reduction — the dashboard
 *  item shape). */
export interface WatchingRepoItem {
  repo: typeof repositories.$inferSelect;
  ownerVisibility: "public" | "limited" | "private";
  description: string;
}

/** The watching render inputs. */
export interface WatchingData {
  status: 2;
  keyword: string;
  sort: WatchingSortType;
  page: number;
  total: number;
  items: WatchingRepoItem[];
}

/** The watching orders — upstream's switch (notification.go:347-373) over
 *  the landed columns; time sorts carry the CAST(id) determinism
 *  tie-break, the alphabetical pair is total (full names are unique). */
function watchingSortOrder(sort: WatchingSortType): SQL[] {
  const created = sql`coalesce(${repositories.createdAt}, 0)`;
  const updated = sql`coalesce(${repositories.updatedAt}, 0)`;
  const idNumber = sql`CAST(${repositories.id} AS INTEGER)`;
  switch (sort) {
    case "newest":
      return [sql`${created} DESC`, sql`${idNumber} DESC`];
    case "oldest":
      return [sql`${created} ASC`, sql`${idNumber} ASC`];
    case "leastupdate":
      return [sql`${updated} ASC`, sql`${idNumber} ASC`];
    case "alphabetically":
      return [asc(repositories.ownerNamespace), asc(repositories.slug)];
    case "reversealphabetically":
      return [desc(repositories.ownerNamespace), desc(repositories.slug)];
    case "recentupdate":
      return [sql`${updated} DESC`, sql`${idNumber} DESC`];
  }
}

/** The landed repo-search keyword arm's shape (services/repository.ts):
 *  comma-separated parts, case-insensitive slug substring, plus the
 *  one-slash `owner/name` pair match. NOT LIKE: D1 caps LIKE patterns at
 *  50 bytes, so a long `q=` part threw D1_ERROR and the page answered a
 *  plain 500; the substrings go through instr() instead — the documented
 *  user-search precedent (services/user.ts:81-97, the org-members 943e1e9
 *  shape), the exact pair the services/repository.ts arm now carries. The
 *  needles pre-lower for the case-insensitive pair (owner_namespace/slug
 *  are stored lowercase). */
function keywordCondition(keyword: string): SQL | null {
  if (keyword === "") return null;
  const parts: SQL[] = [];
  for (const part of keyword.split(",")) {
    parts.push(sql`instr(${repositories.slug}, ${part.toLowerCase()}) > 0`);
    const slash = part.indexOf("/");
    if (slash > 0 && part.indexOf("/", slash + 1) === -1) {
      parts.push(
        and(
          sql`instr(${repositories.ownerNamespace}, ${part.slice(0, slash).toLowerCase()}) > 0`,
          sql`instr(${repositories.slug}, ${part.slice(slash + 1).toLowerCase()}) > 0`,
        ) as SQL,
      );
    }
  }
  return or(...parts) as SQL;
}

/**
 * Load one page of the viewer's watched repositories (§3.2 — the
 * WatchedByID read): the readGrant-scoped `repo_watchers` join, the landed
 * keyword arm, the upstream sort, facet tri-states, the 15-row page and
 * the total. Requested pages past the end render empty under an absent
 * pager — upstream has no redirect on this arm. Descriptions batch-read
 * from `repo_settings` (the dashboard loader pattern).
 */
export async function loadWatchingData(
  d1: D1Database,
  viewer: SignedInViewer,
  params: URLSearchParams,
): Promise<WatchingData> {
  const keyword = parseWatchingKeyword(params.get("q"));
  const sort = parseWatchingSort(params.get("sort"));
  const page = Math.max(1, parsePageNumber(params.get("page")));
  const db = drizzle(d1);

  const conditions: SQL[] = [eq(repoWatchers.userId, viewer.id)];
  const grant = visibleRepoGrantSql(viewer.id, viewer.isAdmin);
  if (grant !== null) conditions.push(grant);
  const keywordMatch = keywordCondition(keyword);
  if (keywordMatch !== null) conditions.push(keywordMatch);

  // The facet tri-states — upstream FormOptionalBool params through
  // repo_list.go's equality arms (module header); `?topic=true` matches
  // nothing (no topics table — the search service's noMatch posture).
  const archived = parseOptionalBoolParam(params.get("archived"));
  if (archived !== null) conditions.push(eq(repositories.isArchived, archived));
  const template = parseOptionalBoolParam(params.get("template"));
  if (template !== null) conditions.push(eq(repositories.isTemplate, template));
  const fork = parseOptionalBoolParam(params.get("fork"));
  if (fork === true) conditions.push(isNotNull(repositories.forkParent));
  if (fork === false) conditions.push(isNull(repositories.forkParent));
  const mirror = parseOptionalBoolParam(params.get("mirror"));
  if (mirror !== null) conditions.push(eq(repositories.isMirror, mirror));
  const isPrivate = parseOptionalBoolParam(params.get("private"));
  if (isPrivate !== null) {
    conditions.push(eq(repositories.visibility, isPrivate ? "private" : "public"));
  }
  if (parseOptionalBoolParam(params.get("topic")) === true) {
    conditions.push(sql`0 = 1`);
  }

  const where = and(...conditions);
  const countRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(repoWatchers)
    .innerJoin(repositories, eq(repositories.id, repoWatchers.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .where(where);
  const total = countRows[0]?.value ?? 0;

  const rows = await db
    .select({ repo: repositories, ownerVisibility: users.visibility })
    .from(repoWatchers)
    .innerJoin(repositories, eq(repositories.id, repoWatchers.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .where(where)
    .orderBy(...watchingSortOrder(sort))
    .limit(WATCHING_PAGE_SIZE)
    .offset((page - 1) * WATCHING_PAGE_SIZE);

  const descriptions = new Map<string, string>();
  if (rows.length > 0) {
    const settingRows = await db
      .select({ repoId: repoSettings.repoId, description: repoSettings.description })
      .from(repoSettings)
      .where(inArray(repoSettings.repoId, rows.map((row) => row.repo.id)))
      .all();
    for (const row of settingRows) descriptions.set(row.repoId, row.description);
  }

  return {
    status: 2,
    keyword,
    sort,
    page,
    total,
    items: rows.map((row) => ({
      repo: row.repo,
      ownerVisibility: row.ownerVisibility,
      description: descriptions.get(row.repo.id) ?? "",
    })),
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The row's subject URL — Issue.Link() (issue.go:397-404). */
function issueUrl(item: SubscriptionIssueItem): string {
  return `/${item.ownerNamespace}/${item.slug}/${item.isPull ? "pulls" : "issues"}/${item.index}`;
}

/** The row's state glyph (shared/issueicon.tmpl — the notifications page's
 *  ThreadIcon shape over the flat item: merged → git-merge purple, closed
 *  PR → red, open WIP → draft grey — the landed
 *  hasWorkInProgressPrefix title-prefix check —, open PR → green; issues
 *  open/closed). */
function SubscriptionIcon(props: { item: SubscriptionIssueItem }) {
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

/** The canonical subscriptions URL for one filter set (the issues-list
 *  `listHref` convention — defaults/empties omitted; page resets unless
 *  given; upstream's param order sort → state → issueType → labels,
 *  notification_subscriptions.tmpl:17). */
function subscriptionsHref(
  state: SubscriptionsState,
  sort: IssueSortType,
  issueType: IssueTypeFilter,
  labels: number[],
  page?: number,
): string {
  const params = new URLSearchParams();
  if (sort !== "latest") params.set("sort", sort);
  if (state !== "all") params.set("state", state);
  if (issueType === "issues" || issueType === "pulls") params.set("issueType", issueType);
  if (labels.length > 0) params.set("labels", labels.join(","));
  if (page !== undefined && page > 1) params.set("page", String(page));
  const query = params.toString();
  return query === "" ? "/notifications/subscriptions" : `/notifications/subscriptions?${query}`;
}

/** The event line — GetLastEventLabel's three arms in the landed EventLine
 *  literals (opened/closed/merged {time} by {poster}; the merged branch
 *  carried by `has_merged`, issue.go:460-468). */
function EventLine(props: { item: SubscriptionIssueItem }) {
  const { item } = props;
  // GetLastEventLabel nests HasMerged INSIDE IsClosed (issue.go:460-468):
  // merging closes the issue, so hasMerged must be tested FIRST or every
  // merged PR renders "closed" and the merged arm is dead code (the
  // subscriptions matrix's RED).
  const verb = item.isPull && item.hasMerged ? "merged" : item.isClosed ? "closed" : "opened";
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

/** One shared/issuelist.tmpl `.item` row at `listType "dashboard"` (the
 *  module header's projection citations). */
function SubscriptionIssueRow(props: { item: SubscriptionIssueItem }) {
  const { item } = props;
  const href = issueUrl(item);
  return (
    <div class="item">
      <div class="item-leading">
        <div class="flex-text-inline tw-mt-[3px]">
          <SubscriptionIcon item={item} />
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
                  // The badge href resets every filter but the id —
                  // upstream echoes the dashboard root's empty q/type/state
                  // around `labels={id}` (issuelist.tmpl:31; module header).
                  <a class="item" href={subscriptionsHref("all", "latest", "all", [label.id])}>
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
          <EventLine item={item} />
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

/** The Status-1 body: the state tabs (live plain anchors), then the list /
 *  empty line / pager (notification_subscriptions.tmpl:13-68). The Type and
 *  Sort dropdowns are unrendered (module header) — their values stay
 *  honored query parameters. */
function SubscriptionsArm(props: { data: SubscriptionsData }) {
  const { data } = props;
  const more = data.page * SUBSCRIPTIONS_PAGE_SIZE < data.total;
  return (
    <>
      <div class="flex-left-right">
        <div class="tw-flex">
          <div class="small-menu-items ui compact tiny menu">
            <a
              class={data.state === "all" ? "active item" : "item"}
              href={subscriptionsHref("all", data.sort, data.issueType, data.labels)}
            >
              {notificationSubscriptionsLocale.all}
            </a>
            <a
              class={data.state === "open" ? "active item flex-text-inline" : "item flex-text-inline"}
              href={subscriptionsHref("open", data.sort, data.issueType, data.labels)}
            >
              <Icon name="octicon-issue-opened" size={16} class="tw-mr-2" />
              {notificationSubscriptionsLocale.open_title}
            </a>
            <a
              class={data.state === "closed" ? "active item flex-text-inline" : "item flex-text-inline"}
              href={subscriptionsHref("closed", data.sort, data.issueType, data.labels)}
            >
              <Icon name="octicon-issue-closed" size={16} class="tw-mr-2" />
              {notificationSubscriptionsLocale.closed_title}
            </a>
          </div>
        </div>
      </div>
      <div class="divider"></div>
      {data.items.length === 0 ? (
        notificationSubscriptionsLocale.no_subscriptions
      ) : (
        <>
          <div id="issue-list" class="flex-divided-list items-with-main">
            {data.items.map((item) => (
              <SubscriptionIssueRow item={item} />
            ))}
          </div>
          {data.page > 1 || more ? (
            <div class="center page buttons">
              <div class="ui borderless pagination menu">
                {data.page > 1 ? (
                  <a
                    class="item navigation"
                    href={subscriptionsHref(data.state, data.sort, data.issueType, data.labels, data.page - 1)}
                  >
                    <span class="navigation_label">Newer</span>
                  </a>
                ) : null}
                {more ? (
                  <a
                    class="item navigation"
                    href={subscriptionsHref(data.state, data.sort, data.issueType, data.labels, data.page + 1)}
                  >
                    <span class="navigation_label">Older</span>
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

/** The watching pager href — `q`/`sort` preserved (the upstream pager keeps
 *  its params), `page` past 1. */
function watchingHref(keyword: string, sort: WatchingSortType, page: number): string {
  const params = new URLSearchParams();
  if (keyword !== "") params.set("q", keyword);
  if (sort !== "recentupdate") params.set("sort", sort);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query === "" ? "/notifications/watching" : `/notifications/watching?${query}`;
}

/** The Status-2 body: the shared/repo/search GET form (the explore
 *  reduction's exact input+submit core — the Filter/Sort dropdowns are
 *  unrendered, module header), then the repo list / empty line / pager
 *  (notification_subscriptions.tmpl:69-74). */
function WatchingArm(props: { data: WatchingData }) {
  const { data } = props;
  const more = data.page * WATCHING_PAGE_SIZE < data.total;
  return (
    <>
      <div class="ui small secondary filter menu">
        <form
          class="ui form ignore-dirty tw-w-full flex-text-block tw-flex-wrap"
          method="get"
          action="/notifications/watching"
        >
          <div class="ui small fluid action input tw-flex-1">
            <input
              type="search"
              name="q"
              value={data.keyword}
              maxlength={255}
              spellcheck={false}
              placeholder={notificationSubscriptionsLocale.repos_placeholder}
            />
            <button type="submit" class="ui small icon button" aria-label={notificationSubscriptionsLocale.search}>
              {notificationSubscriptionsLocale.search}
            </button>
          </div>
        </form>
      </div>
      <div class="divider"></div>
      {data.items.length === 0 ? (
        <div>{notificationSubscriptionsLocale.no_results}</div>
      ) : (
        <div class="flex-divided-list items-with-main">
          {data.items.map((item) => (
            <OrgRepoListItem
              key={item.repo.id}
              orgLink={`/${item.repo.ownerNamespace}`}
              item={{ repo: item.repo, description: item.description } satisfies OrgHomeRepoItem}
              orgPrivate={item.repo.visibility === "public" && item.ownerVisibility === "private"}
            />
          ))}
        </div>
      )}
      {data.page > 1 || more ? (
        <div class="center page buttons">
          <div class="ui borderless pagination menu">
            {data.page > 1 ? (
              <a class="item navigation" href={watchingHref(data.keyword, data.sort, data.page - 1)}>
                <span class="navigation_label">Newer</span>
              </a>
            ) : null}
            {more ? (
              <a class="item navigation" href={watchingHref(data.keyword, data.sort, data.page + 1)}>
                <span class="navigation_label">Older</span>
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderNotificationSubscriptionsPage(
  ctx: UiContext,
  data: SubscriptionsData | WatchingData,
): string {
  return renderPage(<NotificationSubscriptionsPage ctx={ctx} data={data} />);
}

/** The subscriptions/watching page (§2.4.1 discriminator: `user
 *  notification` — one upstream template serves both arms, dispatched on
 *  `.Status`). */
export function NotificationSubscriptionsPage(props: { ctx: UiContext; data: SubscriptionsData | WatchingData }) {
  const { ctx, data } = props;
  const isSubscriptions = data.status === 1;
  return (
    <BaseLayout
      ctx={ctx}
      title={isSubscriptions ? notificationSubscriptionsLocale.subscriptions : notificationSubscriptionsLocale.watching}
      pageClass="user notification"
    >
      <div class="ui container">
        <div class="ui compact small menu small-menu-items">
          <a class={isSubscriptions ? "active item" : "item"} href="/notifications/subscriptions">
            {notificationSubscriptionsLocale.subscriptions}
          </a>
          <a class={isSubscriptions ? "item" : "active item"} href="/notifications/watching">
            {notificationSubscriptionsLocale.watching}
          </a>
        </div>
        <div class="ui top attached segment">
          {data.status === 1 ? <SubscriptionsArm data={data} /> : <WatchingArm data={data} />}
        </div>
      </div>
    </BaseLayout>
  );
}

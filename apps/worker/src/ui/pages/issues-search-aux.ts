/**
 * The issues page's two aux JSON feeds — the parity survey's bench row 3
 * (top-10 #3), one unit, two template-free loaders + Response builders:
 *
 *   GET /{owner}/{repo}/issues/search       web.go:1359 repo.SearchRepoIssuesJSON
 *                                       (routers/web/repo/issue_list.go:196-308;
 *                                       "copied from API … only used by frontend
 *                                       to search some dependency or related
 *                                       issues" — issue_list.go:194-195)
 *   GET /{owner}/{repo}/issues/suggestions  web.go:1341 repo.IssueSuggestions
 *                                       (routers/web/repo/issue_suggestions.go:16-36
 *                                       → services/issue/suggestion.go
 *                                       GetSuggestion, the new-issue
 *                                       reference field's dropdown)
 *
 * ## Feed A — `/issues/search` (the web-scope dependency-search grammar)
 *
 * Query params the pin's handler actually reads (issue_list.go:198-260):
 *
 *     before, since   RFC3339 (parseFormTime) — parse error → 422 plain text
 *                     (issue_list.go:198-201, GetQueryBeforeSince at
 *                     services/context/utils.go:12-38)
 *     state           ""/"open"/unknown → open-only, "closed" → closed-only,
 *                     "all" → both (common.ParseIssueFilterStateIsClosed,
 *                     routers/common/issue_filter.go:16-26)
 *     q               FormTrim keyword (issue_list.go:202)
 *     milestones      comma-split (entries NOT trimmed), names first then
 *                     numeric ids, repo-scoped, misses discarded
 *                     (issue_list.go:204-232 → GetMilestoneByRepoIDANDName +
 *                     GetMilestoneByRepoID). The `db.NoConditionID` (= -1,
 *                     models/db/search.go:31) special case
 *                     (issue_list.go:280-282) is UNREACHABLE through this
 *                     route: a milestone whose id is -1 never resolves.
 *     type            "pulls" → PRs, "issues" → issues, else both
 *                     (common.ParseIssueFilterTypeIsPull,
 *                     issue_filter.go:29-31)
 *     created_by,     usernames → user ids (getUserIDForFilter,
 *     assigned_by,    issue_list.go:232-246 + 253-266); a non-existent login
 *     mentioned_by    is ctx.NotFound → the web 404 shell — NOT a JSON error
 *     project         comma-split int64s via FormStringInt64s
 *                     (services/context/base_form.go:39-42 →
 *                     modules/base/tool.go StringsToInt64s: empty entries
 *                     skipped, ONE bad entry poisons the WHOLE list to nil
 *                     = no filter); exactly [-1] → NoProjectOnly
 *                     (issue_list.go:149-154 + 271-274)
 *     page, limit     FormInt + ToCorrectPageSize (<=0 → 30, >50 → 50;
 *                     services/convert/utils.go:15-22)
 *
 *   Explicitly NOT read here (web ≠ API grammar): `labels` ("never used",
 *   issue_list.go:268-269 TODO), the `created`/`assigned`/`mentioned`
 *   booleans, `owner`/`team` and the review booleans — those belong to the
 *   API's cross-repo /repos/issues/search. Sort is FIXED
 *   SortByCreatedDesc (issue_list.go:240). The response is the FULL API
 *   issue list — `convert.ToIssueList` (issue_list.go:306) — plus
 *   `SetTotalCountHeader` (X-Total-Count +
 *   Access-Control-Expose-Headers, services/context/base.go:74-77); NO
 *   Link header (that is the API context's SetLinkHeader, not web Base's).
 *
 * ## Feed B — `/issues/suggestions` (the new-issue reference dropdown)
 *
 * One param: `q` via FormValue — NOT trimmed (issue_suggestions.go:17).
 * GetSuggestion (services/issue/suggestion.go:16-73): pageSize 5;
 * empty `q` → the 5 latest-updated threads (FindLatestUpdatedIssues,
 * models/issues/issue.go:516-524, `updated_unix DESC`, isPull filter);
 * otherwise a numeric `q` (strconv.ParseInt — "+7"/"007" parse, overflow
 * errors to 0) resolves GetIssueByIndex FIRST and is PREPENDED verbatim —
 * the index hit ignores the isPull filter — and the remaining 4 slots take
 * FindIssuesSuggestionByKeyword (issue.go:526-546): case-insensitive LIKE
 * over the TITLE only ("it only searches name", issue.go:535 — PR 33538),
 * `updated_unix DESC, index DESC`, the index hit excluded by id. Items are
 * the slim `structs.Issue{ID, Index, Title, State}` + the PR rows'
 * `PullRequestMeta{HasMerged, IsWorkInProgress}` (suggestion.go:56-68) —
 * Go marshals the struct's other members as zero values (no omitempty on
 * any field, modules/structs/issue.go:51-87), so each suggestion carries
 * the full Issue envelope with ""/null/false/0/GO_ZERO_TIME fill and — for
 * PRs — `pull_request: {merged, merged_at: null, draft, html_url: ""}`.
 *
 * ## Gates (both feeds answer the §4.5 not-found shell on refusal)
 *
 * - search sits in the "edit issues" group: reqSignIn (anonymous → the
 *   login redirect, mount-side), RepoAssignment +
 *   RepoMustNotBeArchived → NotFound (services/context/repo.go:136-142,
 *   the `isArchived` arm) and reqUnitIssuesReader → NotFound
 *   (services/context/permission.go:64-76). The landed store has no
 *   issues-unit toggles (repo_units models 'code' only), so the unit gate
 *   reduces to resolveUiRequest's visibility grant.
 * - suggestions: optSignIn (anonymous OK) + RepoAssignment +
 *   reqRepoIssuesOrPullsReader (web.go:1334-1339) — the same
 *   store-impossible reduction; the viewer's Issues/Pulls unit reads
 *   decide the isPull narrowing (issue_suggestions.go:19-27), true for
 *   every viewer until units land.
 *
 * The search feed renders through the landed API machinery (the [ok]
 * issueSearchIssues block): parseStateFilter/parseTypeFilter/parseQueryTime,
 * milestoneIdsByRepoEntries, userIdForFilter, listRepoIssues,
 * toApiIssue. mentioned_by rides the landed issue_user carrier (the
 * IssueListFilters.mentionedId filter — applyMentionedCondition,
 * issue_search.go:396-398); assigned_by rides the issue_assignees store
 * the same way (applyAssigneeCondition's numeric arm, issue_search.go:
 * 379-381 — the IssueListFilters.assigneeId filter, wired with the global
 * search's `assigned` doer-flag); project filters: exactly [-1] is a
 * no-op (every thread is projectless) and any concrete id list matches
 * nothing.
 *
 * This module holds the loaders + the JSON Response builders only; the
 * handlers live in src/ui/index.ts beside their sibling dispatchers (the
 * resolveUiRequest session/repo prologue and the reqSignIn redirect are
 * index-owned). Not a page — the branches-list-aux sibling module.
 */

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { issues, pullRequests } from "../../db/schema";

import { parseListOptions } from "../../api/pagination";
import type { Issue } from "../../api/models/issue";
import {
  hasWorkInProgressPrefix,
  listRepoIssues,
  milestoneIdsByRepoEntries,
  parseQueryTime,
  parseStateFilter,
  parseTypeFilter,
  toApiIssue,
  userIdForFilter,
  type IssueListFilters,
} from "../../api/services/issues";
import {
  findRepositoryById,
  GO_ZERO_TIME,
  type RepositoryWithOwner,
  type Viewer as ApiViewer,
} from "../../api/services/repository";
import type { IssueRow } from "../../issues/service";

// ---------------------------------------------------------------------------
// Shared module types
// ---------------------------------------------------------------------------

/** The loader's repo subset (the mount's resolved row — repo-view.ts). */
export type IssuesAuxRepo = {
  id: string;
  isArchived: boolean;
};

/** The session viewer the search feed renders for (reqSignIn's doer). */
export type IssuesAuxViewer = {
  readonly id: number;
  readonly username: string;
  readonly isAdmin: boolean;
};

/** The api-Viewer projection of the session viewer (the owner-projects
 *  projectsApiUser shape — three fields, the rest optional). */
function auxApiViewer(viewer: IssuesAuxViewer, origin: string): ApiViewer {
  return {
    origin,
    requester: { id: viewer.id, login: viewer.username, is_admin: viewer.isAdmin },
  };
}

/** ctx.JSON's content-type (services/context/base.go:114-116) plus the web
 *  middleware's zero-option prod Cache-Control (the branches-list-aux
 *  sibling's header set). */
function jsonHeaders(): HeadersInit {
  return {
    "content-type": "application/json;charset=utf-8",
    "cache-control": "max-age=0, private, must-revalidate",
  };
}

// ---------------------------------------------------------------------------
// Feed A — GET /{owner}/{repo}/issues/search (SearchRepoIssuesJSON)
// ---------------------------------------------------------------------------

/** `FormStringInt64s` (base_form.go:39-42 → tool.go:95-110): empty entries
 *  skipped; ONE unparseable entry poisons the whole list to nil. */
export function parseProjectIdsParam(raw: string | null): number[] {
  const ids: number[] = [];
  for (const entry of (raw ?? "").split(",")) {
    if (entry === "") continue;
    if (!/^-?\d+$/.test(entry)) return [];
    ids.push(Number.parseInt(entry, 10));
  }
  return ids;
}

/** strconv.ParseInt(keyword, 10, 64) — "+7"/"007" parse; overflow errors to
 *  the zero value (suggestion.go:26). Shared by the suggestions feed. */
export function parseIssueIndexKeyword(keyword: string): number {
  if (!/^[+-]?\d+$/.test(keyword)) return 0;
  const parsed = Number.parseInt(keyword, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export type ParsedIssuesSearchQuery = {
  keyword: string;
  isClosed: boolean | null;
  isPull: boolean | null;
  /** RFC3339 → unix seconds (parseFormTime), null when absent. */
  since: number | null;
  before: number | null;
  milestoneEntries: string[];
  createdByName: string;
  assignedByName: string;
  mentionedByName: string;
  /** `project` after FormStringInt64s — [] absent/poisoned (no filter),
   *  [-1] the NoProjectOnly sentinel, else the concrete id list. */
  projectIds: number[];
};

export type IssuesSearchQueryParse =
  | { ok: true; query: ParsedIssuesSearchQuery }
  | { ok: false; unprocessable: string };

/** The web route's query grammar (issue_list.go:198-266) — since/before
 *  checked BEFORE-first like GetQueryBeforeSince (utils.go:12-23). */
export function parseIssuesSearchQuery(url: URL): IssuesSearchQueryParse {
  let before: number | null;
  let since: number | null;
  try {
    before = parseQueryTime(url.searchParams.get("before"));
    since = parseQueryTime(url.searchParams.get("since"));
  } catch (error) {
    return { ok: false, unprocessable: error instanceof Error ? error.message : String(error) };
  }
  return {
    ok: true,
    query: {
      keyword: (url.searchParams.get("q") ?? "").trim(), // FormTrim (issue_list.go:202)
      isClosed: parseStateFilter(url.searchParams.get("state")),
      isPull: parseTypeFilter(url.searchParams.get("type")),
      since,
      before,
      milestoneEntries: (url.searchParams.get("milestones") ?? "").split(","), // strings.Split, no trim
      createdByName: url.searchParams.get("created_by") ?? "",
      assignedByName: url.searchParams.get("assigned_by") ?? "",
      mentionedByName: url.searchParams.get("mentioned_by") ?? "",
      projectIds: parseProjectIdsParam(url.searchParams.get("project")),
    },
  };
}

export type IssuesSearchAuxOutcome =
  | { readonly kind: "feed"; readonly issues: Issue[]; readonly total: number }
  | { readonly kind: "unprocessable"; readonly message: string }
  | { readonly kind: "notFound"; /** the refused login, or null for the gate arms */ readonly login: string | null };

/**
 * Feed A's loader. `repo`/`viewer` arrive post-gate (the mount resolved the
 * repo through resolveUiRequest's visibility grant and redirected
 * anonymous viewers; the archived arm is the caller's not-found shell).
 */
export async function loadIssuesSearchAux(
  env: Env,
  repo: IssuesAuxRepo,
  viewer: IssuesAuxViewer,
  origin: string,
  url: URL,
): Promise<IssuesSearchAuxOutcome> {
  const parsed = parseIssuesSearchQuery(url);
  if (!parsed.ok) return { kind: "unprocessable", message: parsed.unprocessable };
  const query = parsed.query;

  const pair: RepositoryWithOwner | null = await findRepositoryById(env.DB, repo.id);
  if (pair === null) return { kind: "notFound", login: null }; // §4.8 orphaned repo row

  // Milestones: names first, numeric-id fallback, repo-scoped, misses
  // discarded (issue_list.go:204-232 → milestoneIdsByRepoEntries).
  const milestoneIds = await milestoneIdsByRepoEntries(env.DB, repo.id, query.milestoneEntries);

  // User filters (getUserIDForFilter, issue_list.go:232-246): unknown
  // login → ctx.NotFound. mentioned_by rides the landed issue_user carrier
  // (issue_list.go:292-294's `mentionedByID > 0 → MentionID` — the API
  // seam's mentionedId filter, applyMentionedCondition downstream);
  // assigned_by rides the issue_assignees store the same way
  // (issue_list.go:289-291's `assignedByID > 0 → AssigneeID` — the
  // assigneeId filter, applyAssigneeCondition downstream).
  let posterId: number | null | undefined;
  let assigneeId: number | null | undefined;
  let mentionedId: number | null | undefined;
  for (const [name, role] of [
    [query.createdByName, "poster"],
    [query.assignedByName, "assignee"],
    [query.mentionedByName, "mention"],
  ] as const) {
    if (name === "") continue;
    const id = await userIdForFilter(env.DB, name);
    if (id === null) return { kind: "notFound", login: name };
    if (role === "poster") posterId = id;
    else if (role === "assignee") assigneeId = id;
    else mentionedId = id;
  }

  // Project filter (issue_list.go:267-274): [-1] alone is NoProjectOnly —
  // every thread is projectless in the landed store, so it filters nothing;
  // a concrete id list matches nothing.
  const projectVoid = query.projectIds.length > 0 && !(query.projectIds.length === 1 && query.projectIds[0] === -1);

  if (projectVoid) return { kind: "feed", issues: [], total: 0 };

  const filters: IssueListFilters = {
    isClosed: query.isClosed,
    isPull: query.isPull,
    keyword: query.keyword,
    labelIds: [], // the labels param is never read by the web handler (issue_list.go:268-269)
    milestoneIds,
    since: query.since,
    before: query.before,
    posterId,
    assigneeId,
    mentionedId,
    ...clampedPaging(url),
  };
  const page = await listRepoIssues(env.DB, repo.id, filters);
  const rendered = await Promise.all(page.items.map((issue) => toApiIssue(env.DB, auxApiViewer(viewer, origin), pair, issue)));
  return { kind: "feed", issues: rendered, total: page.total };
}

/** FormInt + ToCorrectPageSize + ListOptions (issue_list.go:235-239). */
export function clampedPaging(url: URL): { page: number; limit: number } {
  return parseListOptions(url);
}

/**
 * Feed A's Response — ctx.JSON 200 (`application/json;charset=utf-8`)
 * with SetTotalCountHeader (base.go:74-77: X-Total-Count +
 * Access-Control-Expose-Headers) and the web middleware's zero-option
 * Cache-Control; NO Link header (web Base never sets one).
 */
export function issuesSearchResponse(data: IssuesSearchAuxOutcome, notFoundHtml = ""): Response {
  switch (data.kind) {
    case "feed":
      return new Response(JSON.stringify(data.issues), {
        status: 200,
        headers: { ...jsonHeaders(), "x-total-count": String(data.total), "access-control-expose-headers": "X-Total-Count" },
      });
    case "unprocessable":
      // ctx.HTTPError(422, err.Error()) → http.Error (base.go:105-111):
      // text/plain; charset=utf-8, message + trailing newline.
      return new Response(`${data.message}\n`, {
        status: 422,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    case "notFound":
      // ctx.NotFound (the unit/archive gate + getUserIDForFilter): the web
      // not-found shell; the mount passes renderNotFound(ctx)'s html.
      return new Response(notFoundHtml, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
}

// ---------------------------------------------------------------------------
// Feed B — GET /{owner}/{repo}/issues/suggestions (IssueSuggestions)
// ---------------------------------------------------------------------------

/**
 * `structs.Issue` as GetSuggestion fills it (suggestion.go:56-68): the four
 * real fields plus the struct's zero-marshalled remainder (no omitempty,
 * modules/structs/issue.go:51-87) and the PR-only PullRequestMeta —
 * `Merged *time.Time` stays nil and `HTMLURL` empty because GetSuggestion
 * sets only HasMerged/IsWorkInProgress.
 */
export interface IssueSuggestion {
  id: number;
  url: string;
  html_url: string;
  number: number;
  user: null;
  title: string;
  body: string;
  ref: string;
  assets: null;
  labels: null;
  milestone: null;
  projects: null;
  assignee: null;
  assignees: null;
  state: "open" | "closed";
  is_locked: false;
  comments: 0;
  created_at: typeof GO_ZERO_TIME;
  updated_at: typeof GO_ZERO_TIME;
  closed_at: null;
  due_date: null;
  time_estimate: 0;
  pull_request: null | { merged: boolean; merged_at: null; draft: boolean; html_url: string };
  repository: null;
  pin_order: 0;
  content_version: 0;
}

/** The unit-permission narrowing (issue_suggestions.go:19-27): only-pulls
 *  readable → PRs only, only-issues → issues only, both/neither → no
 *  filter. Every landed viewer reads both units (repo_units models 'code'
 *  only) — the mount passes (true, true). */
export function suggestionsIsPullFilter(canReadIssues: boolean, canReadPulls: boolean): boolean | null {
  if (canReadPulls && !canReadIssues) return true;
  if (canReadIssues && !canReadPulls) return false;
  return null;
}

/** GetSuggestion (services/issue/suggestion.go:16-73) over the landed
 *  store. `repoId` is the resolved repo's row id; `isPull` the
 *  suggestionsIsPullFilter outcome; `keyword` the RAW `q` (FormValue —
 *  never trimmed). */
export async function loadIssuesSuggestionsAux(
  env: Env,
  repoId: string,
  isPull: boolean | null,
  keyword: string,
): Promise<IssueSuggestion[]> {
  const db = drizzle(env.DB);
  const pageSize = 5;
  const scope = [eq(issues.repoId, repoId)];
  if (isPull !== null) scope.push(eq(issues.isPull, isPull)); // isPullToCond

  let rows: IssueRow[];
  if (keyword === "") {
    // FindLatestUpdatedIssues (issue.go:516-524): updated_unix DESC only.
    rows = await db
      .select()
      .from(issues)
      .where(and(...scope))
      .orderBy(desc(issues.updatedAt))
      .limit(pageSize);
  } else {
    // The index-exact hit first (suggestion.go:26-38): prepended verbatim,
    // excluded from the keyword pass, one slot shorter — and NOT narrowed
    // by the isPull filter (GetIssueByIndex takes no isPull).
    let byIndex: IssueRow | undefined;
    let keywordPageSize = pageSize;
    const indexKeyword = parseIssueIndexKeyword(keyword);
    if (indexKeyword > 0) {
      byIndex = await db
        .select()
        .from(issues)
        .where(and(eq(issues.repoId, repoId), eq(issues.index, indexKeyword)))
        .limit(1)
        .then((found) => found[0]);
      if (byIndex !== undefined) {
        keywordPageSize -= 1;
      }
    }
    // FindIssuesSuggestionByKeyword (issue.go:526-546): title-only
    // case-insensitive substring (upstream BuildCaseInsensitiveLike,
    // models/db/common.go:19-25), id != excluded, updated_unix DESC then
    // index DESC. NOT LIKE: D1 caps LIKE patterns at 50 bytes, so a long
    // `?q=` needle threw D1_ERROR and the feed answered a plain 500; the
    // substring goes through instr() instead — the documented user-search
    // precedent (services/user.ts:81-97, the org-members 943e1e9 shape).
    // The needle pre-lowers for the case-insensitive pair (the column
    // lower()s in SQL, exactly what the LIKE wrapped).
    const conditions = [...scope, sql`instr(lower(${issues.title}), ${keyword.toLowerCase()}) > 0`];
    if (byIndex !== undefined) conditions.push(ne(issues.id, byIndex.id));
    rows = await db
      .select()
      .from(issues)
      .where(and(...conditions))
      .orderBy(desc(issues.updatedAt), desc(issues.index))
      .limit(keywordPageSize);
    if (byIndex !== undefined) rows = [byIndex, ...rows];
  }

  // issues.LoadPullRequests (suggestion.go:50-52): one pass over the PR
  // extension rows of the selected threads.
  const pullIds = rows.filter((row) => row.isPull).map((row) => row.id);
  const prRows =
    pullIds.length === 0
      ? new Map<number, { hasMerged: boolean }>()
      : new Map(
          (
            await db
              .select({ issueId: pullRequests.issueId, hasMerged: pullRequests.hasMerged })
              .from(pullRequests)
              .where(inArray(pullRequests.issueId, pullIds))
          ).map((row) => [row.issueId, row]),
        );

  return rows.map((row) => renderSuggestion(row, prRows.get(row.id)?.hasMerged ?? false));
}

/** The slim render (suggestion.go:54-70) with the struct's zero-marshalled
 *  envelope. `draft` is the title-prefix check (pull.go IsWorkInProgress —
 *  the landed pullRequestMetaOf's hasWorkInProgressPrefix arm). */
function renderSuggestion(issue: IssueRow, hasMerged: boolean): IssueSuggestion {
  return {
    id: issue.id,
    url: "",
    html_url: "",
    number: issue.index,
    user: null,
    title: issue.title,
    body: "",
    ref: "",
    assets: null,
    labels: null,
    milestone: null,
    projects: null,
    assignee: null,
    assignees: null,
    state: issue.isClosed ? "closed" : "open",
    is_locked: false,
    comments: 0,
    created_at: GO_ZERO_TIME,
    updated_at: GO_ZERO_TIME,
    closed_at: null,
    due_date: null,
    time_estimate: 0,
    pull_request: issue.isPull
      ? { merged: hasMerged, merged_at: null, draft: hasWorkInProgressPrefix(issue.title), html_url: "" }
      : null,
    repository: null,
    pin_order: 0,
    content_version: 0,
  };
}

/**
 * Feed B's Response — ctx.JSON 200, no X-Total-Count (IssueSuggestions
 * never sets one).
 */
export function issuesSuggestionsResponse(suggestions: IssueSuggestion[]): Response {
  return new Response(JSON.stringify(suggestions), { status: 200, headers: jsonHeaders() });
}

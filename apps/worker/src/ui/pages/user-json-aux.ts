/**
 * The /user group's two bare-JSON aux feeds — census gap #19's web-router
 * twins (one unit, both feeds the vendored frontend polls):
 *
 *   GET /user/stopwatches        web.go:766  user.GetStopwatches
 *                                (routers/web/user/stop_watch.go:16-40 — the
 *                                header badge's running-stopwatch poll,
 *                                web_src/js/features/stopwatch.ts)
 *   GET /user/search_candidates  web.go:767  user.SearchCandidates
 *                                (routers/web/user/search.go:18-35 — the
 *                                mention/user-picker typeahead feed,
 *                                web_src/js/features/comp/SearchUserBox.ts)
 *
 * Not pages — the aux-JSON family convention (the branches-list-aux /
 * search-aux siblings): this module holds the two parse helpers, the two
 * feed loaders, and the JSON Response builders ONLY; the route claims and
 * the session prologue are index-owned (LANDED at 65fbda5 — the record at
 * the bottom).
 *
 * ---------------------------------------------------------------------------
 * Feed 1 — GET /user/stopwatches (reqSignIn, web.go:766)
 * ---------------------------------------------------------------------------
 *
 * The handler (stop_watch.go:16-40) reads `page` (FormInt — passed RAW into
 * db.ListOptions, so absent/garbage → 0 → GetUserStopwatches applies NO
 * pagination at all, stopwatch.go:79's `if listOptions.Page > 0` gate; the
 * API twin's `page<=0→1` clamp does NOT exist on this arm) and `limit`
 * (ToCorrectPageSize — <=0 → API.DefaultPagingNum 30, >50 →
 * MaxResponseItems 50). It counts ALL the doer's stopwatches
 * (CountUserStopwatches — the count is unpaginated), sets the
 * SetTotalCountHeader pair, and marshals the converted `api.StopWatch`
 * ARRAY (StopWatches, modules/structs/issue_stopwatch.go:22-24 — a bare
 * JSON array, no envelope).
 *
 * ## JSON shape (the ported contract, byte-order included)
 *
 * `api.StopWatch` (issue_stopwatch.go:12-20) marshals, per row:
 *
 *     { "created": <RFC3339>, "seconds": <n>, "duration": "2 hours 5 mins",
 *       "issue_index": <n>, "issue_title": "…", "repo_owner_name": "…",
 *       "repo_name": "…" }
 *
 * — the conversion is `convert.ToStopWatches` (services/convert/issue.go:
 * 176-233), whose reads this loader re-issues in the API twin's batched
 * form (routes/account-aggregates.ts:1247-1291, the landed
 * /user/stopwatches API arm this feed REUSES verbatim): the doer's
 * `stopwatch` rows ordered by id (upstream's Find carries NO order-by —
 * stopwatch.go:78-83 — and planner order is the id order; the id sort is
 * the API twin's determinism pin), the page's issues in ONE inArray read
 * (the missing-issue row skips — issue.go:200-204's GetRepositoryByID
 * failure arm), the distinct repos in ONE findRepositoriesByIds read, ONE
 * `canViewRepositoryWithTeams` verdict per DISTINCT repo, and the
 * unreadable-repo skip (issue.go:214-217's CanReadIssuesOrPulls arm —
 * upstream defends against a stopwatch row whose repo the doer can no
 * longer read; count still counts the skipped row). `seconds` derives from
 * created_unix at read time (Stopwatch.Seconds()), `duration` is
 * `util.SecToHours` (sec_to_time.go:15-29 — the issue-tables-t2 port's
 * verbatim copy; both landed copies are module-private, the verbatim-copy
 * precedent). The consumer reads exactly repo_owner_name/repo_name/
 * issue_index/seconds off data[0] (stopwatch.ts:66-72).
 *
 * ## Arms
 *
 * - reqSignIn (web.go:766): anonymous callers are the session prologue's
 *   303-onto-/user/login arm (the repo-search-aux posture), NOT a loader
 *   concern — the dispatcher owns it; no loader code path is reachable
 *   without the resolved session user row.
 * - a vanished session doer is the dispatcher's 404 shell (the
 *   repoSearchAuxRoute bridge), never a loader arm.
 * - the empty doer (zero stopwatch rows) is the clean empty array with
 *   `x-total-count: 0`.
 *
 * ---------------------------------------------------------------------------
 * Feed 2 — GET /user/search_candidates (optExploreSignIn, web.go:767)
 * ---------------------------------------------------------------------------
 *
 * The handler (search.go:18-35) reads `q` (FormTrim) and `orgs` (FormBool —
 * the SearchUserBox's data-include-orgs flag rides the URL, SearchUserBox.ts:20)
 * and runs `user_model.SearchUsers` with `Types: [Individual]` (+ Organization
 * when orgs), `IsActive: Some(true)`, `Actor: ctx.Doer` — then marshals
 *
 *     { "data": [ api.User, … ] }
 *
 * — `convert.ToUsers(ctx, ctx.Doer, users)` (convert/user.go:61-69), each
 * row through the canonical `ToUser` render (ours: `toApiUser`, the landed
 * directory serializer). The consumer reads login/avatar_url/full_name off
 * `data` (SearchUserBox.ts:23-27).
 *
 * ## No pagination (upstream quirk, ported verbatim)
 *
 * The handler never reads `page`: `ListOptions{PageSize:
 * setting.UI.MembersPagingNum}` sets ONLY the page size (ui.go:91 → 20), and
 * SearchUsers applies pagination only `if opts.Page > 0` (models/user/
 * search.go:162-164) — Page stays 0, so the feed serves the WHOLE
 * active-and-visible match set, page size dead. No page/limit param is
 * consumed and no X-Total-Count is set (the handler discards the count).
 *
 * ## The search (search.go:23-29 → models/user/search.go) — the local twin
 *
 * The landed `searchUsers` service (api/services/user.ts) pins
 * `type = 'user'` and cannot carry the `orgs` arm, and this wave cannot edit
 * that sibling — the searchExploreUsers precedent (api/services/search.ts:27-36
 * "rather than edit the landed route/service, re-issue the predicate set")
 * governs: the WHERE re-issued here, upstream-exact —
 *
 *   - `type IN ('user')` or `IN ('user','org')` (search.go:65's
 *     builder.In over Types);
 *   - `status = 'active'` (search.go:110-112's `IsActive: Some(true)` →
 *     `is_active`; the users.status enum comment pins 'active' as upstream
 *     IsActive, schema.ts:397-401);
 *   - the keyword (FormTrim'd, lowercased — search.go:67-90) substring-
 *     matches BOTH `username_lower` AND `lower(full_name)` (the
 *     `lower_name` + `LOWER(full_name)` LIKE pair; SearchByEmail is false so
 *     no email arm). The landed API twin matches username_lower only — its
 *     header's "no such columns yet" divergence is stale for full_name
 *     (users.fullName is landed, schema.ts:424) and this feed ports the
 *     upstream pair. instr() not LIKE: D1 caps LIKE patterns at 50 bytes and
 *     %/_ in user input would need escaping — the landed
 *     parameterized-instr precedent (services/user.ts:81-97, the 943e1e9
 *     org-members shape);
 *   - the actor ceiling (search.go:173-187's BuildCanSeeUserCondition):
 *     admin → no filter; anonymous (Actor nil) → `visibility = 'public'`
 *     (the `!canViewPrivate` AND-arm, search.go:183-185); a signed-in
 *     non-admin doer → `visibility != 'private'` OR the row IS the doer OR
 *     the row is an org the doer belongs to (search.go:177's org_user
 *     membership subquery — UNREACHABLE on the landed type='user' twin, but
 *     THIS feed's orgs arm unlocks org rows, so the arm is modeled; the
 *     org_members collapse, services/follows.ts:229's viewerOrgs shape).
 *     Upstream's IsPublicOnlyDoer (user_extdata.go:105-108 — public-only
 *     API tokens) has no api-layer model yet: a session doer is never
 *     public-only, so canViewPrivate is always true on this feed;
 *     IsRestricted has no column (the landed service's note verbatim).
 *   - ORDER BY `name ASC` — SearchOrderByAlphabetically (models/db/
 *     search.go:15, literal `name ASC`) → the display-cased
 *     `users.username`. (The landed API twin ordered username_lower ASC
 *     under the same label — its own reading; this feed pins the upstream
 *     literal.)
 *
 * ## Arms
 *
 * - optExploreSignIn (web.go:355 = SignInRequired:
 *   RequireSignInViewStrict || Explore.RequireSigninView — both settings
 *   unmodeled and default-off): anonymous callers ARE SERVED, no gate (the
 *   explore-topic-search-aux dispatcher's "optSignIn — no gate" posture);
 *   the anonymous feed is the public-only candidate set with the noreply
 *   placeholder emails (apiUserFromRow's non-authed render).
 * - the empty match is the clean `{"data":[]}`.
 *
 * ---------------------------------------------------------------------------
 * MOUNT RECORD — the index.ts fold, EXECUTED at 65fbda5 (this module is
 * mounted; the recipe below is the landed claims' record)
 * ---------------------------------------------------------------------------
 *
 * 1. parseUiRoute literals, in the `/user` literal neighborhood directly
 *    BEFORE the `raw[1] === "user" && raw[2] === "settings"` chain (the
 *    notifications-family posture: upstream's /user group, web.go:757-774,
 *    registers its literals ahead of the dynamic owner/repo pairs; neither
 *    literal shadows anything — "stopwatches"/"search_candidates" under a
 *    user named "user" is upstream-shadowed identically):
 *      - `raw.length === 3 && raw[1] === "user" && raw[2] === "stopwatches"`
 *        → `{ family: "user-stopwatches-aux" }`
 *      - `raw.length === 3 && raw[1] === "user" && raw[2] ===
 *        "search_candidates"` → `{ family: "user-search-candidates-aux" }`
 *    Family union: `export interface UserJsonAuxRoute { family:
 *    "user-stopwatches-aux" | "user-search-candidates-aux"; }` — no extra
 *    fields (both literals carry no params).
 * 2. Dispatcher `userStopwatchesAuxRoute` (the repoSearchAuxRoute bridge
 *    verbatim): resolveUiSession → drift guard → `viewer.kind ===
 *    "anonymous"` → `loginRedirect(url.pathname + url.search)` (reqSignIn,
 *    web.go:766 — the 303 round-trip, never a JSON envelope) → load the D1
 *    user row by `viewer.id` (vanished row → the 404 shell) → build the
 *    api-layer Viewer through the `toApiUser` auth bridge (index.ts:8098-8113's
 *    exact object shape) → `parseUserStopwatchesQuery(url)` →
 *    `loadUserStopwatchesAux(c.env, userRow.id, apiViewer, params)` →
 *    `userStopwatchesAuxResponse(result.total, result.data)`.
 * 3. Dispatcher `userSearchCandidatesRoute`: resolveUiSession → drift guard →
 *    NO gate (optExploreSignIn — anonymous served, the sitemapRoute posture);
 *    the api-layer Viewer is `{ origin: url.origin, requester: null }` when
 *    anonymous, else the same toApiUser bridge as feed 1 →
 *    `parseUserSearchCandidatesQuery(url)` →
 *    `loadUserSearchCandidatesAux(c.env, apiViewer, params)` →
 *    `userSearchCandidatesResponse(result)`.
 * 4. Registrations (GET-only — upstream m.Get; POST answers the plain 404):
 *      uiRouter.get("/user/stopwatches", (c) => userStopwatchesAuxRoute(c));
 *      uiRouter.get("/user/search_candidates", (c) => userSearchCandidatesRoute(c));
 *
 *    NULL PINS THAT FLIP: none — no landed test pins either path as
 *    unclaimed (grepped index.test.ts + every pages/*test* — zero hits).
 */

import { and, asc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { DEFAULT_PAGING_NUM, MAX_RESPONSE_ITEMS } from "../../api/pagination";
import type { User } from "../../api/models/user";
import {
  canViewRepositoryWithTeams,
  findRepositoriesByIds,
  formBool,
  formInt64,
  formTrim,
  type Viewer,
} from "../../api/services/repository";
import { toApiUser, visibilityDoerOf, type UserVisibilityDoer } from "../../api/services/user";
import { issueStopwatches, issues, orgMembers, users } from "../../db/schema";

// ---------------------------------------------------------------------------
// Feed 1 — GET /user/stopwatches (user.GetStopwatches, stop_watch.go:16-40)
// ---------------------------------------------------------------------------

/** One `api.StopWatch` row (modules/structs/issue_stopwatch.go:12-20) — the
 *  key order is the Go struct's marshal order. */
export interface UserStopwatchAuxItem {
  created: string;
  seconds: number;
  duration: string;
  issue_index: number;
  issue_title: string;
  repo_owner_name: string;
  repo_name: string;
}

/** The query the web handler consumes (stop_watch.go:18-19). */
export interface UserStopwatchesAuxParams {
  /** Raw FormInt `page` — 0 (absent/garbage) = UNPAGED: upstream passes the
   *  value straight into db.ListOptions and GetUserStopwatches applies
   *  SetSessionPagination only `if listOptions.Page > 0` (stopwatch.go:79-81).
   *  The API twin's `<=0 → 1` clamp does not exist on this arm. */
  page: number;
  /** ToCorrectPageSize(FormInt `limit`) — <=0 → 30, >50 → 50
   *  (convert/utils.go:15-22). */
  limit: number;
}

/** Parse the /user/stopwatches query the handler reads it (stop_watch.go:18-19):
 *  FormInt page passed RAW (0 = unpaged), the ToCorrectPageSize limit clamp.
 *  (formInt64 is the strconv.ParseInt twin of FormInt for query-string
 *  values — same observable parse.) */
export function parseUserStopwatchesQuery(url: URL): UserStopwatchesAuxParams {
  const rawPage = formInt64(url.searchParams, "page");
  const rawLimit = formInt64(url.searchParams, "limit");
  return {
    page: rawPage,
    limit: rawLimit <= 0 ? DEFAULT_PAGING_NUM : Math.min(rawLimit, MAX_RESPONSE_ITEMS),
  };
}

/** `util.SecToHours` port (modules/util/sec_to_time.go:15-40) — the
 *  issue-tables-t2 / account-aggregates copy (private in both; the
 *  verbatim-copy precedent). */
function secToHours(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const unit = (value: number, name: string): string =>
    value === 1 ? `1 ${name} ` : value > 1 ? `${value} ${name}s ` : "";
  let out = `${unit(hours, "hour")}${unit(minutes, "minute")}`;
  if (out === "" && totalSeconds > 0) {
    out = unit(totalSeconds, "second");
  }
  return out.replace(/ $/, "");
}

/**
 * Feed 1 loader — GetUserStopwatches + CountUserStopwatches
 * (stopwatch.go:76-93) over the doer's `stopwatch` rows, rendered through
 * ToStopWatches' batched reads (the landed API twin's exact sequence,
 * routes/account-aggregates.ts:1247-1291 — one inArray for the page's
 * issues, one findRepositoriesByIds for their distinct repos, one
 * canViewRepositoryWithTeams verdict per DISTINCT repo; the per-row skips
 * render identically: missing issue → skip, unreadable repo → skip). The
 * count is the FULL row count (CountUserStopwatches is unpaginated —
 * skipped rows still count, upstream issue.go:203's `continue` happens
 * after the count read). Order: id ASC (the API twin's determinism pin —
 * upstream's Find carries no order-by).
 */
export async function loadUserStopwatchesAux(
  env: Env,
  doerId: number,
  viewer: Viewer,
  params: UserStopwatchesAuxParams,
): Promise<{ total: number; data: UserStopwatchAuxItem[] }> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(issueStopwatches)
    .where(eq(issueStopwatches.userId, doerId))
    .orderBy(asc(issueStopwatches.id))
    .all();
  const total = rows.length;
  // Upstream pages only when Page > 0 (stopwatch.go:79-81) — page 0 serves
  // every row regardless of the limit clamp.
  const pageRows = params.page > 0 ? rows.slice((params.page - 1) * params.limit, params.page * params.limit) : rows;

  const now = Date.now();
  const issueRows =
    pageRows.length > 0
      ? await db
          .select()
          .from(issues)
          .where(inArray(issues.id, [...new Set(pageRows.map((row) => row.issueId))]))
          .all()
      : [];
  const issuesById = new Map(issueRows.map((row) => [row.id, row]));
  const pairs = await findRepositoriesByIds(env.DB, [...new Set(issueRows.map((row) => row.repoId))]);
  const canView = new Map<string, boolean>();
  await Promise.all(
    [...pairs.values()].map(async (pair) => {
      canView.set(pair.repo.id, await canViewRepositoryWithTeams(env.DB, viewer, pair.repo));
    }),
  );

  const data: UserStopwatchAuxItem[] = [];
  for (const row of pageRows) {
    const issue = issuesById.get(row.issueId);
    if (issue === undefined) {
      continue; // GetRepositoryByID failure arm (issue.go:200-204)
    }
    const pair = pairs.get(issue.repoId);
    if (pair === undefined || canView.get(issue.repoId) !== true) {
      continue; // CanReadIssuesOrPulls skip (issue.go:214-217)
    }
    const seconds = Math.max(0, Math.floor((now - row.createdAt.getTime()) / 1000));
    data.push({
      created: row.createdAt.toISOString(),
      seconds,
      duration: secToHours(seconds),
      issue_index: issue.index,
      issue_title: issue.title,
      repo_owner_name: pair.repo.ownerNamespace,
      repo_name: pair.repo.slug,
    });
  }
  return { total, data };
}

/** The feed-1 response — the bare StopWatches JSON array (stop_watch.go:39's
 *  ctx.JSON) + SetTotalCountHeader (base.go:74-78: X-Total-Count + the
 *  Access-Control-Expose-Headers append) + ctx.JSON's
 *  `application/json;charset=utf-8` (base.go:114-120) + the web middleware's
 *  zero-option prod Cache-Control (the aux-JSON family envelope). */
export function userStopwatchesAuxResponse(total: number, data: UserStopwatchAuxItem[]): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
      "x-total-count": String(total),
      "access-control-expose-headers": "X-Total-Count",
    },
  });
}

// ---------------------------------------------------------------------------
// Feed 2 — GET /user/search_candidates (user.SearchCandidates, search.go:18-35)
// ---------------------------------------------------------------------------

/** The query the web handler consumes (search.go:20-22). */
export interface UserSearchCandidatesParams {
  /** FormTrim `q` — trimmed; empty = the unfiltered candidate universe. */
  keyword: string;
  /** FormBool `orgs` — adds UserTypeOrganization to the Types filter
   *  (search.go:20-22). */
  orgs: boolean;
}

/** Parse the /user/search_candidates query (search.go:20-22): the trimmed
 *  keyword and the orgs flag. NO page/limit exists (the no-pagination quirk
 *  in the module header). */
export function parseUserSearchCandidatesQuery(url: URL): UserSearchCandidatesParams {
  return {
    keyword: formTrim(url.searchParams, "q"),
    orgs: formBool(url.searchParams, "orgs"),
  };
}

/**
 * BuildCanSeeUserCondition (models/user/search.go:173-187) reduced to the
 * modeled axes — the landed canSeeUserCondition shape
 * (api/services/user.ts:144-154) PLUS the org-membership arm its header
 * calls "unreachable because the search pins type = 'user'": this feed's
 * orgs arm unlocks org rows, so private orgs the doer belongs to surface
 * (search.go:177's org_user subquery → the org_members collapse,
 * services/follows.ts:229's viewerOrgs shape). Upstream's IsPublicOnlyDoer /
 * IsRestricted axes are unmodeled (the landed service's note verbatim) — a
 * session doer is never public-only.
 */
function candidatesCanSeeCondition(db: DrizzleD1Database, doer: UserVisibilityDoer): SQL | undefined {
  if (doer.isAdmin && doer.id !== null) {
    // Upstream skips the whole cond for admins (search.go:176's
    // `!actor.IsAdmin` gate) and canViewPrivate is true — no filter.
    return sql`1 = 1`;
  }
  if (doer.id === null) {
    // Actor nil → the `!canViewPrivate` AND-arm (search.go:183-185).
    return eq(users.visibility, "public");
  }
  const doerOrgs = db.select({ id: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, doer.id));
  return or(
    ne(users.visibility, "private"), // In(visibility, public, limited) (search.go:179)
    eq(users.id, doer.id), // the self arm (search.go:181)
    inArray(users.id, doerOrgs), // the org-membership arm (search.go:177)
  );
}

/**
 * Feed 2 loader — SearchCandidates' SearchUsers read (search.go:23-29) over
 * the landed columns (the local twin, module header). NO pagination: the
 * handler never reads `page`, Page stays 0, and SearchUsers applies no
 * LIMIT/OFFSET (models/user/search.go:162-164) — the whole match set
 * renders, MembersPagingNum dead. Order: `name ASC`
 * (SearchOrderByAlphabetically, models/db/search.go:15) → the display-cased
 * `users.username`. Render: ToUsers → toApiUser per row (the canonical
 * directory serializer; anonymous viewers get the noreply-placeholder
 * render).
 */
export async function loadUserSearchCandidatesAux(
  env: Env,
  viewer: Viewer,
  params: UserSearchCandidatesParams,
): Promise<{ data: User[] }> {
  const doer = visibilityDoerOf(viewer);
  const db = drizzle(env.DB);
  const types: ("user" | "org")[] = params.orgs ? ["user", "org"] : ["user"];
  const conditions: SQL[] = [
    // builder.In("type", opts.Types) (search.go:65).
    inArray(users.type, types),
    // IsActive: Some(true) (search.go:27 → search.go:110-112) — the landed
    // users.status 'active' pin.
    eq(users.status, "active"),
  ];
  if (params.keyword !== "") {
    // The keyword pair (search.go:67-90): lower_name + LOWER(full_name)
    // LIKEs → parameterized instr() over the lowercased needle (the D1
    // LIKE-cap precedent). A NULL full_name matches nothing (instr(NULL,·)
    // is NULL — upstream's LIKE-on-NULL exclusion verbatim).
    const keyword = params.keyword.toLowerCase();
    conditions.push(sql`(instr(${users.usernameLower}, ${keyword}) > 0 OR instr(lower(${users.fullName}), ${keyword}) > 0)`);
  }
  const visibility = candidatesCanSeeCondition(db, doer);
  if (visibility !== undefined) {
    conditions.push(visibility);
  }

  const rows = await db
    .select()
    .from(users)
    .where(and(...conditions))
    .orderBy(asc(users.username))
    .all();
  return { data: rows.map((row) => toApiUser(viewer, row)) };
}

/** The feed-2 response — `{"data":[…]}` (search.go:34's ctx.JSON). NO
 *  X-Total-Count: the handler discards the count (search.go:23's `users, _, err`).
 *  The envelope headers are ctx.JSON's content-type + the web middleware's
 *  zero-option prod Cache-Control (the aux-JSON family envelope). */
export function userSearchCandidatesResponse(payload: { data: User[] }): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}

/**
 * The search aux JSON feeds — the parity survey's tick-10 bench row 5 (one
 * unit, two bare-JSON aux endpoints the vendored frontend polls):
 *
 *   GET /repo/search               web.go:1102  repo.SearchRepo
 *                                  (routers/web/repo/repo.go:426-546 — the
 *                                  dashboard/repo-picker repository search)
 *   GET /explore/topics/search     web.go:564   explore.TopicSearch
 *                                  (routers/web/explore/topic.go:17-46 —
 *                                  the topic-picker feed)
 *
 * ## Feed 1 — /repo/search (reqSignIn, web.go:1097-1103's group gate)
 *
 * Every query param the Go handler consumes, in handler order
 * (repo.go:427-505): `page` (FormInt, <=0 → 1), `limit`
 * (ToCorrectPageSize), `q` (FormTrim), `uid` / `priority_owner_id` /
 * `team_id` / `starredBy` (FormInt64), `topic` / `includeDesc` /
 * `exclusive` (FormBool), `private` (`IsSigned && (""
 * || FormBool)`), tri-state `template` / `archived` / `is_private`
 * (FormString != "" gates an optional.Option[bool] — absent AND
 * present-but-empty both mean "all"), `mode` (source|fork|mirror|
 * collaborative; anything else is upstream's
 * `ctx.HTTPError(422, "Invalid search mode: \"x\"")` — an HTML status
 * page, never JSON), `sort` + `order` (repo_model.OrderByMap gate —
 * 422 `Invalid sort order/order: "x"`), and `count_only` (FormBool —
 * the count fast path: ctx.SetTotalCountHeader(count) + ctx.JSONOK(),
 * context.go:243-245's `{"ok":true}` dummy, repo.go:507-515).
 *
 * ## Feed 1 JSON shape (the ported contract, byte-order included)
 *
 * `WebSearchResults` (services/repository/repository.go:43-47):
 *
 *     { "ok": true, "data": [ WebSearchRepository, … ] }
 *
 * `WebSearchRepository` (repository.go:36-41) marshals, per row:
 *
 *     { "repository": <api.Repository>,
 *       "latest_commit_status": <git_model.CommitStatus> | null,
 *       "locale_latest_commit_status": "" | "Success" | … }
 *
 * — NO omitempty on any member, so all three keys always render (null /
 * "" when the repo has no status). The embedded repository is the
 * **zero-padded** `api.Repository`: the handler populates exactly ten
 * fields (repo.go:526-541 — ID, FullName, Fork, Private, Template,
 * Mirror, Stars, HTMLURL, Link, Internal) and Go marshals the REST of
 * structs.Repository (modules/structs/repo.go:58-134, almost no
 * omitempty) as zero values — `owner: null`, `name: ""`,
 * `stars_count` (Stars' json tag!) the populated number,
 * `created_at` Go-zero `0001-01-01T00:00:00Z`, `topics: null` /
 * `licenses: null`, … The zero-padding IS the wire contract (the
 * vendored DashboardRepoList.vue spreads `...webSearchRepo.repository`
 * and reads id/link/full_name/fork/mirror/template/private/internal
 * from it — web_src/js/components/DashboardRepoList.vue:16-34,300-311);
 * this module emits the full zero-padded object in the Go struct's
 * marshal order. Field mapping for the ten: full_name =
 * `ownerNamespace/slug` (FullName(), models/repo/repo.go:339-341);
 * html_url = absolute `origin/owner/slug` (HTMLURL →
 * MakeAbsoluteURL(Link()), repo.go:344-348); link = `/owner/slug`
 * (Link(), repo.go:559-561 — AppSubURL "", PathEscape'd segments);
 * internal = public repo under a private-visibility OWNER
 * (repo.go:539 — `!IsPrivate && Owner.Visibility ==
 * api.VisibleTypePrivate`; our users.visibility "private" column);
 * stars_count = the maintained `num_stars` column.
 *
 * `latest_commit_status` is the DEFAULT-BRANCH-TIP combined status,
 * marshaled as the raw `git_model.CommitStatus` MODEL — the model
 * carries NO json tags (models/git/commit_status.go:37-57), so the
 * wire keys are the Go FIELD NAMES (`State`, `TargetURL`, … exactly
 * what DashboardRepoList.vue:309-310 reads). Both upstream resolution
 * paths materialize the same subset (services/repository/commitstatus/
 * commitstatus.go:120-186): latest-per-context statuses of the tip SHA
 * ordered id-DESC → CalcCommitStatus (models/git/commit_status.go:265-
 * 285) — RepoID/SHA from the newest row, State = states.Combine() (the
 * landed combineCommitStatusStates port), TargetURL = first non-empty.
 * Upstream renders `locale_latest_commit_status` via
 * `repo.commitstatus.<state>` locale keys (models/git/commit_status.go:
 * 217-219): Pending/Success/Error/Failure exist (options/locale/
 * locale_en-US.json); warning/skipped have NO entries, and TrString's
 * missing-key arm renders the key itself (modules/translation/i18n/
 * localestore.go:146) — mirrored verbatim.
 *
 * ## Feed 2 — /explore/topics/search (optExploreSignIn, web.go:545-565)
 *
 * Query params (topic.go:20-28): `q` (FormString — NOT trimmed,
 * unlike feed 1's FormTrim), `page` (FormInt), `limit`
 * (ToCorrectPageSize). The handler queries the `topic` TABLE
 * (db.FindAndCount, topic.go:30) with FindTopicOptions' keyword LIKE
 * (models/repo/topic.go:181-183) and `ORDER BY topic.repo_count DESC`
 * (topic.go:189), sets X-Total-Count and marshals
 * `{"topics": [TopicResponse…]}` — `api.TopicResponse`
 * (modules/structs/repo_topic.go:11-18): `id`, `topic_name`,
 * `repo_count`, `created`, `updated` (RFC3339, CreatedUnix/UpdatedUnix).
 *
 * Our store has no `topic` table (upstream's denormalized row with
 * global ids + timestamps); the landed API /topics/search
 * (routes/repo-extras-t2.ts:862-924) established the documented
 * divergence this feed re-uses: GROUP BY over `repo_topics` (the join
 * half) yields the per-topic repo_count, FNV-1a hashed ids
 * (repo-extras-t2.ts:377-384's local twin — org-repos.ts carries a
 * third copy already), and `created`/`updated` render GO_ZERO_TIME
 * (the established zero-default for unlanded timestamp columns).
 * Order pins `repo_count DESC, topic ASC` — upstream orders
 * repo_count DESC only and leaves ties to the planner; the name
 * tiebreak is our determinism.
 *
 * ## Arms
 *
 * - feed 1 is a reqSignIn route: anonymous callers are the session
 *   prologue's 303-onto-/login arm (the repo-create family's posture),
 *   NOT a loader concern — the dispatcher owns it (mount recipe below);
 * - `mode`/`sort`/`order` validation failures throw SearchAuxParamError
 *   (422 + upstream's exact message strings) — upstream
 *   `ctx.HTTPError(422, …)` renders an HTML status page, so the
 *   dispatcher maps the error to the §4.5-family error shell with
 *   status 422, never a JSON body;
 * - count_only short-circuits the row work: upstream swaps
 *   CountRepository for SearchRepository (repo.go:507-515); ours runs
 *   the same condition set with a 1-row page (the count query is
 *   identical, the page read is minimized);
 * - a repo with no default-branch tip (empty repo / unreadable cell)
 *   carries `latest_commit_status: null` — upstream's missing
 *   repoSHAs entry (commitstatus.go:150-186), the §4.9 degrade.
 *
 * ## Response envelope (both feeds)
 *
 * ctx.JSON's `application/json;charset=utf-8`
 * (services/context/base.go:114-120) + the web middleware's zero-option
 * prod Cache-Control (the branches-list-aux sibling) + SetTotalCountHeader
 * (base.go:74-78 — `X-Total-Count` plus the Access-Control-Expose-Headers
 * append). Feed 1's count_only body is exactly `{"ok":true}`.
 *
 * ## HANDOFF — mount recipe (index.ts is orchestrator-owned)
 *
 * 1. `parseUiRoute` literals, beside the wave-19 creation literals in
 *    the same `raw[1] === "repo"` chain (upstream's /repo group,
 *    web.go:1097-1103, registers ahead of the dynamic pairs):
 *      - `raw.length === 3 && raw[1] === "repo" && raw[2] === "search"`
 *        → `{ family: "repo-search-aux" }`
 *      - `raw.length === 4 && raw[1] === "explore" && raw[2] ===
 *        "topics" && raw[3] === "search"` → `{ family:
 *        "explore-topic-search-aux" }` (the /explore group,
 *        web.go:545-565 — `optExploreSignIn`, anonymous allowed).
 * 2. Dispatcher, `repo-search-aux`: the session prologue first —
 *    anonymous → 303 Location /user/login (reqSignIn, the repo-create
 *    arm); signed in →
 *    `parseRepoSearchAuxQuery(url, true)` inside try/catch —
 *    SearchAuxParamError → the §4.5-family error shell with status 422
 *    (upstream's HTML HTTPError arm); then
 *    `loadRepoSearchAux(env, { origin: new URL(request.url).origin,
 *    requester }, params)` where requester is the resolved session
 *    user row through the same conversion the optional-auth middleware
 *    feeds Viewer; `params.countOnly ? repoSearchCountOnlyResponse(total)
 *    : repoSearchAuxResponse(total, { ok: true, data })`.
 * 3. Dispatcher, `explore-topic-search-aux`: no gate;
 *    `parseTopicSearchAuxQuery(url)` (its only failure arms are
 *    impossible — q is free text, page/limit clamp) →
 *    `loadTopicSearchAux(env, params)` →
 *    `topicSearchAuxResponse(total, { topics })`.
 *
 * This module holds the two feed loaders + parse helpers + JSON
 * Response builders only; the route shapes and the session prologue
 * are index-owned (the branches-list-aux convention). Template-free —
 * not a page.
 */

import { desc, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { MAX_RESPONSE_ITEMS, parseListOptions } from "../../api/pagination";
import {
  combineCommitStatusStates,
  latestCommitStatuses,
} from "../../api/services/commit-status";
import { engineReads, refTipMap } from "../../api/services/engine";
import {
  formBool,
  formBoolValue,
  formInt64,
  formString,
  formTrim,
  GO_ZERO_TIME,
  searchRepositories,
  type RepositoryWithOwner,
  type Viewer,
} from "../../api/services/repository";
import { repoTopics, type CommitStatusRow } from "../../db/schema";

// ---------------------------------------------------------------------------
// Feed 1 — GET /repo/search (repo.SearchRepo, repo.go:426-546)
// ---------------------------------------------------------------------------

/** The zero-padded `api.Repository` of a web-search row — every key of
 *  structs.Repository (repo.go:58-134) in Go marshal order, the omitempty
 *  members omitted (Parent/Permissions/InternalTracker/ExternalTracker/
 *  ExternalWiki/RepoTransfer are nil pointers, DefaultTargetBranch ""),
 *  the ten handler-populated fields live, everything else the zero value
 *  Go emits (repo.go:526-541 + structs/repo.go:58-134). */
export interface WebSearchAuxRepository {
  id: number;
  owner: null;
  name: "";
  full_name: string;
  description: "";
  empty: false;
  private: boolean;
  fork: boolean;
  template: boolean;
  mirror: boolean;
  size: 0;
  language: "";
  languages_url: "";
  html_url: string;
  url: "";
  link: string;
  ssh_url: "";
  clone_url: "";
  original_url: "";
  website: "";
  stars_count: number;
  forks_count: 0;
  watchers_count: 0;
  branch_count: 0;
  open_issues_count: 0;
  open_pr_counter: 0;
  release_counter: 0;
  default_branch: "";
  archived: false;
  created_at: typeof GO_ZERO_TIME;
  updated_at: typeof GO_ZERO_TIME;
  archived_at: typeof GO_ZERO_TIME;
  has_code: false;
  has_issues: false;
  has_wiki: false;
  has_pull_requests: false;
  has_projects: false;
  projects_mode: "";
  has_releases: false;
  has_packages: false;
  has_actions: false;
  ignore_whitespace_conflicts: false;
  allow_merge_commits: false;
  allow_rebase: false;
  allow_rebase_explicit: false;
  allow_squash_merge: false;
  allow_fast_forward_only_merge: false;
  allow_merge_update: false;
  allow_rebase_update: false;
  allow_manual_merge: false;
  autodetect_manual_merge: false;
  default_delete_branch_after_merge: false;
  default_merge_style: "";
  default_update_style: "";
  squash_merge_commit_message: "";
  default_allow_maintainer_edit: false;
  avatar_url: "";
  internal: boolean;
  mirror_interval: "";
  object_format_name: "";
  mirror_updated: typeof GO_ZERO_TIME;
  mirror_last_sync_at: typeof GO_ZERO_TIME;
  topics: null;
  licenses: null;
}

/** The raw `git_model.CommitStatus` MODEL marshal (models/git/
 *  commit_status.go:37-57 — zero json tags, Go field names on the wire),
 *  carrying CalcCommitStatus' populated subset
 *  (commit_status.go:265-285). `Repo`/`Creator` are the xorm-ignored
 *  pointers: upstream re-arms `Repo` with the full repo model
 *  (commitstatus.go:168/184) — internals our D1 rows cannot carry, so
 *  the port renders null (the vendored frontend reads only State and
 *  TargetURL off this object, DashboardRepoList.vue:309-310). */
export interface WebSearchAuxCommitStatus {
  ID: number;
  RepoID: number;
  SHA: string;
  Index: number;
  Repo: null;
  State: string;
  TargetURL: string;
  Description: string;
  ContextHash: string;
  Context: string;
  Creator: null;
  CreatorID: number;
  CreatedUnix: number;
  UpdatedUnix: number;
}

/** `WebSearchRepository` (services/repository/repository.go:36-41) — no
 *  omitempty, so `latest_commit_status`/`locale_latest_commit_status`
 *  always render (null / "" without a status). */
export interface WebSearchAuxItem {
  repository: WebSearchAuxRepository;
  latest_commit_status: WebSearchAuxCommitStatus | null;
  locale_latest_commit_status: string;
}

/** `WebSearchResults` (repository.go:43-47). */
export interface WebSearchAuxResults {
  ok: true;
  data: WebSearchAuxItem[];
}

/** Every query param the Go handler consumes, resolved (repo.go:427-505). */
export interface RepoSearchAuxParams {
  keyword: string;
  uid: number;
  priorityOwnerId: number;
  teamId: number;
  starredBy: number;
  topicOnly: boolean;
  includeDesc: boolean;
  /** `private` resolved against the signed-in caller
   *  (repo.go:436 — `IsSigned && ("" || FormBool)`; the reqSignIn group
   *  makes IsSigned always true — the signedIn flag is the dispatcher's
   *  session prologue outcome). */
  includePrivate: boolean;
  /** `is_private` tri-state; null = all (repo.go:515-517). */
  isPrivate: boolean | null;
  /** `template` tri-state (repo.go:439-441). */
  template: boolean | null;
  /** `archived` tri-state (repo.go:519-521). */
  archived: boolean | null;
  /** `exclusive` (repo.go:443-445). */
  exclusive: boolean;
  mode: "fork" | "source" | "mirror" | "collaborative" | "";
  sort: string;
  /** Raw `order`; "" defaults to asc (repo.go:479-481). */
  order: string;
  page: number;
  limit: number;
  /** `count_only` (repo.go:507-515). */
  countOnly: boolean;
}

/** The 422 arm of the web handler — upstream `ctx.HTTPError(422, msg)`
 *  renders the HTML status page (repo.go:467-470, 490-502), so the
 *  dispatcher maps this to the §4.5-family error shell, never JSON. */
export class SearchAuxParamError extends Error {
  readonly status = 422 as const;

  constructor(message: string) {
    super(message);
    this.name = "SearchAuxParamError";
  }
}

/** repo.go:464-470 — `Invalid search mode: "x"`. */
function searchMode(raw: string): RepoSearchAuxParams["mode"] {
  switch (raw) {
    case "source":
    case "fork":
    case "mirror":
    case "collaborative":
    case "":
      return raw;
    default:
      throw new SearchAuxParamError(`Invalid search mode: "${raw}"`);
  }
}

/** repo_model.OrderByMap's keys (models/repo/search.go:9-30) — the valid
 *  `sort` values both directions share. */
const SEARCH_SORT_KEYS: readonly string[] = [
  "alpha",
  "created",
  "updated",
  "size",
  "git_size",
  "lfs_size",
  "id",
  "stars",
  "forks",
];

/** repo.go:483-502 — the OrderByMap gate: order validated only when sort
 *  is set ("" → "asc"), then the sort key; 422s carry Go-%q messages. */
function validateSortOrder(sort: string, order: string): void {
  if (sort === "") return;
  const direction = order === "" ? "asc" : order;
  if (direction !== "asc" && direction !== "desc") {
    throw new SearchAuxParamError(`Invalid sort order: "${direction}"`);
  }
  if (!SEARCH_SORT_KEYS.includes(sort)) {
    throw new SearchAuxParamError(`Invalid sort mode: "${sort}"`);
  }
}

/** Tri-state optional bool, repo.go's `FormString("x") != ""` gate
 *  (repo.go:439-441/515-521): absent AND present-but-empty are both
 *  "all". FormString returns "" for absent, so one check covers both. */
function optionalFormBool(params: URLSearchParams, key: string): boolean | null {
  const raw = formString(params, key);
  return raw === "" ? null : formBoolValue(raw);
}

/**
 * Parse the /repo/search query the handler reads it (repo.go:427-505):
 * every param, in handler order, with upstream's exact 422 arms.
 * `signedIn` is the dispatcher's session-prologue outcome (the reqSignIn
 * group guarantees it — repo.go:436's IsSigned conjunct).
 */
export function parseRepoSearchAuxQuery(url: URL, signedIn: boolean): RepoSearchAuxParams {
  const search = url.searchParams;
  const sort = formString(search, "sort");
  const order = formString(search, "order");
  validateSortOrder(sort, order);
  const { page, limit } = parseListOptions(url);
  return {
    keyword: formTrim(search, "q"),
    uid: formInt64(search, "uid"),
    priorityOwnerId: formInt64(search, "priority_owner_id"),
    teamId: formInt64(search, "team_id"),
    starredBy: formInt64(search, "starredBy"),
    topicOnly: formBool(search, "topic"),
    includeDesc: formBool(search, "includeDesc"),
    includePrivate: signedIn && (formString(search, "private") === "" || formBool(search, "private")),
    isPrivate: optionalFormBool(search, "is_private"),
    template: optionalFormBool(search, "template"),
    archived: optionalFormBool(search, "archived"),
    exclusive: formBool(search, "exclusive"),
    mode: searchMode(formString(search, "mode")),
    sort,
    order,
    page,
    limit,
    countOnly: formBool(search, "count_only"),
  };
}

/** `repositoryIdNumber` twin (api/services/repository.ts:276-279, module-
 *  private there): our TEXT repositories.id → the int64 wire number. */
function repoIdNumber(id: string): number {
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** CalcCommitStatus (models/git/commit_status.go:265-285) over the
 *  latest-per-context rows (id-DESC order — the landed
 *  latestCommitStatuses read): the newest row carries RepoID/SHA, the
 *  states combine worst-of, the first non-empty TargetURL wins. */
function calcCommitStatusShell(rows: CommitStatusRow[]): WebSearchAuxCommitStatus | null {
  const newest = rows[0];
  if (newest === undefined) return null;
  let targetUrl = "";
  for (const row of rows) {
    if (row.targetUrl !== null && row.targetUrl !== "") {
      targetUrl = row.targetUrl;
      break;
    }
  }
  return {
    ID: 0,
    RepoID: repoIdNumber(newest.repoId),
    SHA: newest.sha,
    Index: 0,
    Repo: null,
    State: combineCommitStatusStates(rows.map((row) => row.state)),
    TargetURL: targetUrl,
    Description: "",
    ContextHash: "",
    Context: "",
    Creator: null,
    CreatorID: 0,
    CreatedUnix: 0,
    UpdatedUnix: 0,
  };
}

/** The `repo.commitstatus.<state>` locale render (models/git/
 *  commit_status.go:217-219): the four landed en-US keys
 *  (options/locale/locale_en-US.json) + TrString's missing-key arm —
 *  the key itself (modules/translation/i18n/localestore.go:146) for
 *  warning/skipped, which have no entries upstream either. */
const COMMIT_STATUS_LOCALE: Record<string, string> = {
  pending: "Pending",
  success: "Success",
  error: "Error",
  failure: "Failure",
};

function localeCommitStatus(state: string): string {
  return COMMIT_STATUS_LOCALE[state] ?? `repo.commitstatus.${state}`;
}

/** The zero-padded api.Repository for one resolved row — the ten live
 *  fields (repo.go:526-541) over the struct's zero values
 *  (structs/repo.go:58-134). full_name/link/html_url mirror upstream's
 *  FullName()/Link()/HTMLURL() (models/repo/repo.go:339-348,559-561 —
 *  AppSubURL "", PathEscape'd segments, MakeAbsoluteURL against the
 *  request origin); internal is the private-visibility-owner arm
 *  (repo.go:539); stars_count is the maintained num_stars column. */
function webSearchAuxRepository(row: RepositoryWithOwner, origin: string): WebSearchAuxRepository {
  const ownerSegment = encodeURIComponent(row.repo.ownerNamespace);
  const slugSegment = encodeURIComponent(row.repo.slug);
  return {
    id: repoIdNumber(row.repo.id),
    owner: null,
    name: "",
    full_name: `${row.repo.ownerNamespace}/${row.repo.slug}`,
    description: "",
    empty: false,
    private: row.repo.visibility === "private",
    fork: row.repo.forkParent !== null,
    template: row.repo.isTemplate,
    mirror: row.repo.isMirror,
    size: 0,
    language: "",
    languages_url: "",
    html_url: `${origin}/${ownerSegment}/${slugSegment}`,
    url: "",
    link: `/${ownerSegment}/${slugSegment}`,
    ssh_url: "",
    clone_url: "",
    original_url: "",
    website: "",
    stars_count: row.repo.numStars,
    forks_count: 0,
    watchers_count: 0,
    branch_count: 0,
    open_issues_count: 0,
    open_pr_counter: 0,
    release_counter: 0,
    default_branch: "",
    archived: false,
    created_at: GO_ZERO_TIME,
    updated_at: GO_ZERO_TIME,
    archived_at: GO_ZERO_TIME,
    has_code: false,
    has_issues: false,
    has_wiki: false,
    has_pull_requests: false,
    has_projects: false,
    projects_mode: "",
    has_releases: false,
    has_packages: false,
    has_actions: false,
    ignore_whitespace_conflicts: false,
    allow_merge_commits: false,
    allow_rebase: false,
    allow_rebase_explicit: false,
    allow_squash_merge: false,
    allow_fast_forward_only_merge: false,
    allow_merge_update: false,
    allow_rebase_update: false,
    allow_manual_merge: false,
    autodetect_manual_merge: false,
    default_delete_branch_after_merge: false,
    default_merge_style: "",
    default_update_style: "",
    squash_merge_commit_message: "",
    default_allow_maintainer_edit: false,
    avatar_url: "",
    internal: row.repo.visibility === "public" && row.owner.visibility === "private",
    mirror_interval: "",
    object_format_name: "",
    mirror_updated: GO_ZERO_TIME,
    mirror_last_sync_at: GO_ZERO_TIME,
    topics: null,
    licenses: null,
  };
}

/** The default-branch-tip status of one repo row: upstream resolves the
 *  branch's tip SHA then reads its latest-per-context statuses
 *  (commitstatus.go:141-186); ours reads the tip off the cell's refs
 *  list (one listRefs RPC — upstream's FindBranchesByRepoAndBranchName
 *  batch) and reuses the landed latestCommitStatuses read, capped at
 *  MAX_RESPONSE_ITEMS contexts (upstream caps the page at 50 repos ×
 *  their contexts the same way). Null when the tip does not resolve —
 *  the empty-repo / unreadable-cell arm. */
async function latestCommitStatusOf(
  env: Env,
  row: RepositoryWithOwner,
): Promise<WebSearchAuxCommitStatus | null> {
  const refs = await engineReads(env, {
    ownerNamespace: row.repo.ownerNamespace,
    slug: row.repo.slug,
  }).listRefs();
  const tip = refTipMap(refs).get(`refs/heads/${row.repo.defaultBranch}`);
  if (tip === undefined) return null;
  const { items } = await latestCommitStatuses(env.DB, row.repo.id, tip.target, 1, MAX_RESPONSE_ITEMS);
  return calcCommitStatusShell(items);
}

/**
 * Feed 1 loader — `repo_model.SearchRepository` over the landed
 * `searchRepositories` condition port (api/services/repository.ts, the
 * /repos/search service this feed re-uses wholesale) + the per-row
 * status enrichment. `count_only` swaps the page read for a 1-row read
 * (repo.go:507-515's CountRepository swap — the conditions, not the
 * rows, produce the count).
 */
export async function loadRepoSearchAux(
  env: Env,
  viewer: Viewer,
  params: RepoSearchAuxParams,
): Promise<{ total: number; data: WebSearchAuxItem[] }> {
  const options = {
    keyword: params.keyword,
    topicOnly: params.topicOnly,
    includeDesc: params.includeDesc,
    uid: params.uid,
    exclusive: params.exclusive,
    priorityOwnerId: params.priorityOwnerId,
    teamId: params.teamId,
    starredBy: params.starredBy,
    includePrivate: params.includePrivate,
    isPrivate: params.isPrivate,
    template: params.template,
    archived: params.archived,
    mode: params.mode,
    sort: params.sort,
    order: params.order,
    page: params.page,
    limit: params.limit,
  };
  if (params.countOnly) {
    const { total } = await searchRepositories(env.DB, viewer, { ...options, page: 1, limit: 1 });
    return { total, data: [] };
  }
  const { items, total } = await searchRepositories(env.DB, viewer, options);
  const data: WebSearchAuxItem[] = [];
  for (const row of items) {
    const status = await latestCommitStatusOf(env, row);
    data.push({
      repository: webSearchAuxRepository(row, viewer.origin),
      latest_commit_status: status,
      locale_latest_commit_status: status === null ? "" : localeCommitStatus(status.State),
    });
  }
  return { total, data };
}

/** The aux JSON Response — ctx.JSON's `application/json;charset=utf-8`
 *  (services/context/base.go:114-120), the web middleware's zero-option
 *  prod Cache-Control, and SetTotalCountHeader (base.go:74-78: the
 *  X-Total-Count value + the Access-Control-Expose-Headers append). */
function auxJsonHeaders(total: number): HeadersInit {
  return {
    "content-type": "application/json;charset=utf-8",
    "cache-control": "max-age=0, private, must-revalidate",
    "x-total-count": String(total),
    "access-control-expose-headers": "X-Total-Count",
  };
}

/** The full search response (repo.go:543-546's WebSearchResults JSON). */
export function repoSearchAuxResponse(total: number, payload: WebSearchAuxResults): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: auxJsonHeaders(total) });
}

/** The count_only arm (repo.go:507-515): SetTotalCountHeader + JSONOK —
 *  context.go:243-245's exact `{"ok":true}` dummy body. */
export function repoSearchCountOnlyResponse(total: number): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: auxJsonHeaders(total) });
}

// ---------------------------------------------------------------------------
// Feed 2 — GET /explore/topics/search (explore.TopicSearch, topic.go:17-46)
// ---------------------------------------------------------------------------

/** `api.TopicResponse` (modules/structs/repo_topic.go:11-18) — the web
 *  feed renders created/updated (no omitempty upstream); our store
 *  carries no topic timestamps, so both render GO_ZERO_TIME (the
 *  documented zero-default, above). */
export interface TopicSearchAuxTopic {
  id: number;
  topic_name: string;
  repo_count: number;
  created: typeof GO_ZERO_TIME;
  updated: typeof GO_ZERO_TIME;
}

/** Every query param the Go handler consumes (topic.go:20-28). */
export interface TopicSearchAuxParams {
  /** FormString — NOT trimmed (topic.go:22; the feed-1 FormTrim is the
   *  divergence, not this). */
  keyword: string;
  page: number;
  limit: number;
}

/**
 * Parse the /explore/topics/search query (topic.go:20-28): free-text q,
 * clamped page/limit (the shared ToCorrectPageSize semantics).
 */
export function parseTopicSearchAuxQuery(url: URL): TopicSearchAuxParams {
  const { page, limit } = parseListOptions(url);
  return { keyword: formString(url.searchParams, "q"), page, limit };
}

/** The landed API /topics/search's id materialization — FNV-1a over the
 *  name (repo-extras-t2.ts:377-384; module-private there and this wave
 *  cannot edit siblings, so this is its local twin, matching
 *  org-repos.ts's existing copy). Same name → same id across both
 *  feeds. */
function topicId(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Feed 2 loader — FindTopicOptions' keyword LIKE + repo_count DESC over
 * the landed GROUP-BY-repo_topics divergence (the API /topics/search
 * read, routes/repo-extras-t2.ts:884-910). Topics are stored lowercase
 * (services/repo-topics.ts:63), so the lowercased keyword LIKE is the
 * upstream ASCII-case-insensitive match. `repo_count DESC` first
 * (models/repo/topic.go:189), topic-name tiebreak (our determinism —
 * upstream leaves ties to the planner).
 */
export async function loadTopicSearchAux(
  env: Env,
  params: TopicSearchAuxParams,
): Promise<{ total: number; topics: TopicSearchAuxTopic[] }> {
  const keyword = params.keyword.toLowerCase();
  const filter = keyword === "" ? undefined : `%${keyword}%`;
  const where = filter === undefined ? sql`1 = 1` : like(repoTopics.topic, filter);
  const db = drizzle(env.DB);
  const grouped = db
    .select({ topic: repoTopics.topic })
    .from(repoTopics)
    .where(where)
    .groupBy(repoTopics.topic)
    .as("topics_total");
  const totalRow = await db.select({ n: sql<number>`count(*)` }).from(grouped).get();
  const rows = await db
    .select({ topic: repoTopics.topic, repoCount: sql<number>`count(*)` })
    .from(repoTopics)
    .where(where)
    .groupBy(repoTopics.topic)
    .orderBy(desc(sql`count(*)`), repoTopics.topic)
    .limit(params.limit)
    .offset((params.page - 1) * params.limit)
    .all();
  const topics: TopicSearchAuxTopic[] = rows.map((row) => ({
    id: topicId(row.topic),
    topic_name: row.topic,
    repo_count: Number(row.repoCount),
    created: GO_ZERO_TIME,
    updated: GO_ZERO_TIME,
  }));
  return { total: totalRow?.n ?? 0, topics };
}

/** The topics feed response (topic.go:40-46's `{"topics": [...]}` JSON
 *  + SetTotalCountHeader; the aux envelope above). */
export function topicSearchAuxResponse(
  total: number,
  payload: { topics: TopicSearchAuxTopic[] },
): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: auxJsonHeaders(total) });
}

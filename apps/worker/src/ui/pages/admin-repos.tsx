/**
 * The ADMIN REPOSITORIES list page — `/-/admin/repos` — the wave-admin-pages
 * bench row (the parity survey row docs/compat/ui-parity-survey.md:549's
 * repos remainder), TWO-STAGE UNMOUNTED: this file ships the module only;
 * `index.ts` is orchestrator-held, so the route rides the next window — the
 * HANDOFF NOTE at the bottom. Sibling scope: `admin-users.tsx` (this wave)
 * hosts the shared family chrome and owns the users list; `admin-orgs.tsx`
 * owns the orgs list; the landed dashboard/monitor family owns `/-/admin`
 * and `/-/admin/monitor/*` — none of those files is touched here.
 *
 * ## Upstream surface (at the pin)
 *
 * `templates/admin/repo/list.tmpl` (112 lines) served by `admin.Repos`
 * (routers/web/admin/repos.go:30-40) through the shared
 * `explore.RenderRepoSearch` (routers/web/explore/repo.go:36-144 — the
 * function's own doc comment names the admin page as a consumer), route
 * `GET /-/admin/repos` (web.go:831-835's `/repos` group), behind the shared
 * admin gate (web.go:779 — anonymous → the login redirect, a signed-in
 * non-admin → the 404 shell; the ROUTE stage's posture). The handler's
 * option set: `Private: true` (the admin sees ALL repositories),
 * `PageSize: setting.UI.Admin.RepoPagingNum` = 50
 * (modules/setting/ui.go:139), `OnlyShowRelevant: false`; the sort rides
 * `?sort=` against `repo_model.OrderByFlatMap` (models/repo/search.go:36-53)
 * with `setting.UI.ExploreDefaultSort` = "recentupdate" as the fallback
 * (repo.go:59-69); the facets are the optional-bool tri-states of
 * shared/repo/search.tmpl (archived/fork/mirror/template/private).
 *
 * ## Row projection (repo/list.tmpl:45-92 at the pin → the landed columns)
 *
 *   ID        repositories.id (sortable: oldest/newest)
 *   Owner     the owner's user row → /{username} + the gold octicon-lock
 *             when the owner's visibility is private (the
 *             admin/shared/owner.tmpl rule, verbatim bytes via the
 *             admin-users.tsx embedded-icon seam)
 *   Name      /{ownerNamespace}/{slug} link + the basic labels: Archived
 *             (isArchived), Private (visibility), Internal (public repo of a
 *             private-visibility owner — list.tmpl:55-61's rule), Template
 *             (isTemplate); the SHA256 label arm (list.tmpl:65-67) is
 *             unreachable — every landed repo is sha1 (no object-format
 *             column); the mirror/fork glyphs render via the embedded
 *             octicon-mirror/octicon-repo-forked bytes (list.tmpl:68-72)
 *             (sortable: alphabetically/reversealphabetically — no
 *             data-sortt-default on this template's headers)
 *   Watchers  numWatches (the maintained counter)
 *   Stars     numStars (sortable: moststars/feweststars)
 *   Forks     numForks (sortable: mostforks/fewestforks)
 *   Issues    numIssues (the maintained counter excludes pulls, like
 *             upstream's NumIssues)
 *   Size      FormatByteSize(sizeKb * 1024) — the column stores settled KiB
 *             ("the floored KB value the API serves", schema.ts:124-136);
 *             upstream FormatByteSize takes BYTES (sortable:
 *             gitsize/reversegitsize, list.tmpl:32-35)
 *   Updated   updatedAt (nullable — an untouched row renders the empty cell)
 *   Created   createdAt
 *   LFS Size  OMITTED — no landed column exists (repositories carries only
 *             the combined sizeKb; the GitSize/LFSSize split has no source),
 *             and the column has no upstream empty arm to borrow — a
 *             zero-filled or dash column would fabricate data (the
 *             explore.tsx "no D1 sources" omission rule); the header's
 *             lfssize sorter dies with it
 *   (Op)      OMITTED — the column holds ONLY the delete-modal button
 *             (list.tmpl:82-87, 99-109) targeting POST /-/admin/repos/delete
 *             (web.go:834) — an UNLANDED write; per-row ACTION writes are out
 *             of this wave's scope and a rendered button would be dead (the
 *             dead-link rule §2.4.1, the users page's details/edit omission)
 *
 * The header's "Unadopted Repositories" button (list.tmpl:6 →
 * /-/admin/repos/unadopted) targets an UNLANDED page → omitted.
 *
 * ## Live search/filter/sort arms (query passthrough, shared/repo/search.tmpl)
 *
 * Upstream's `data-global-init="initRepositorySearch"` dropdowns reduce to
 * `<details>` disclosures inside ONE no-JS GET form (the settings-secrets
 * reduction; the radio/submit shape is the users page's):
 *   - `q` — the landed keyword arm (comma-separated substrings on the slug +
 *     the owner/name pair form, services/repository.ts:931-951).
 *   - `archived` / `template` / `private` — the landed tri-state columns
 *     (both directions live: isArchived/isTemplate/visibility,
 *     services/repository.ts:878-893).
 *   - `fork=1` / `mirror=1` — live through the service's mode arm
 *     (forkParent IS NOT NULL / isMirror, repository.ts:894-903). The "not"
 *     arms (fork=0, mirror=0) are OMITTED — the mode vocabulary cannot
 *     express a single negated facet (mode "source" ≡ not-fork AND
 *     not-mirror, a different predicate) and a radio that filters nothing
 *     would be dead.
 *   - `sort` — the twelve dropdown values plus the header pairs
 *     (gitsize/reversegitsize; the lfssize pair dies with its column), all
 *     mapped onto the landed `searchRepositories` sort keys; the values the
 *     D1 registry cannot truly order yet (recentupdate/leastupdate/
 *     moststars/feweststars/mostforks/fewestforks/size/gitsize/lfssize and
 *     reverses) ride the service's DOCUMENTED id-order stand-ins
 *     (services/repository.ts:709-717 — "Sorts backed by columns the D1
 *     registry does not have yet resolve to id order"; the same convention
 *     explore.tsx:70-78 records). Unknown values fold to the page default
 *     "recentupdate" (repo.go:66-69's fallback arm).
 *
 * ## Data (§3.2 — the landed service, never a self-fetch)
 *
 * `searchRepositories` (services/repository.ts:871-983 — the /repos/search
 * service) IS the admin-shaped arm: the admin viewer short-circuits its
 * visibility ladder to "all rows" (repository.ts:768-773 — is_admin → no
 * conditions, exactly upstream's Private:true scope), and the keyword,
 * tri-state facets, mode arm, sort/order and pagination all map 1:1. The
 * loader builds the service Viewer from the session viewer (requester
 * {login, is_admin}; the ROUTE gate guarantees the admin — a non-admin
 * caller of the loader would simply get the service's own visibility
 * ladder, never a leak). This is the searchExploreRepos reuse shape
 * (services/search.ts:101-131) with upstream's admin option set.
 *
 * ## HANDOFF NOTE (the route — this module has NO route)
 *
 * See admin-users.tsx's handoff for the shared recipe; this page's claim in
 * the landed admin literal family block (ui/index.ts:2562-2572):
 *
 *   `if (tail.length === 1 && tail[0] === "repos") return { family:
 *    "admin-repos" };` — static literal BEFORE any dynamic arm; the handler
 *   is adminPagePrologue(c) → loadAdminReposData(c.env.DB, p.ctx.viewer,
 *   searchParams) → renderAdminReposPage(p.ctx, data) at 200.
 *
 * The AdminFamilyNav import marks this page's item active via
 * `active="repos"`. Survey row to flip on landing:
 * docs/compat/ui-parity-survey.md:549.
 */

import { searchRepositories, type RepositoryWithOwner, type Viewer as ApiViewer } from "../../api/services/repository";

import { formatByteSize, parsePageNumber } from "../page-data";
import { renderPage } from "../shell";
import {
  AdminEmbeddedSvg,
  AdminFamilyPagination,
  AdminFamilyShell,
  SortHeader,
  formatAdminDate,
} from "./admin-users";
import type { Viewer } from "../viewer";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const adminReposLocale = {
  /** The page Title (repos.go:31 — ctx.Tr "admin.repositories"). */
  repositories: "Repositories", // "admin.repositories"
  repo_manage_panel: "Repository Management", // "admin.repos.repo_manage_panel" (list.tmpl:4)
  total: "Total: %d", // "admin.total" (list.tmpl:4)
  search_placeholder: "Search repos…", // "search.repo_kind" (shared/repo/search.tmpl's combo)
  search: "Search…", // "search.search" (the combo's submit — the explore text-button reduction)
  filter_title: "Filter", // "filter_title" (shared/repo/search.tmpl:10)
  filter_clear: "Clear Filter", // "filter.clear" (shared/repo/search.tmpl:12)
  filter_archived: "Archived", // "filter.is_archived"
  filter_not_archived: "Not Archived", // "filter.not_archived"
  filter_forked: "Forked", // "filter.is_fork" (the not arm is omitted — the module header)
  filter_mirrored: "Mirrored", // "filter.is_mirror" (the not arm is omitted — the module header)
  filter_template: "Template", // "filter.is_template"
  filter_not_template: "Not Template", // "filter.not_template"
  filter_private: "Private", // "filter.private"
  filter_public: "Public", // "filter.public"
  sort: "Sort", // "repo.issues.filter_sort"
  sort_newest: "Newest", // "repo.issues.filter_sort.latest"
  sort_oldest: "Oldest", // "repo.issues.filter_sort.oldest"
  sort_alphabetically: "Alphabetically", // "repo.issues.label.filter_sort.alphabetically"
  sort_reverse_alphabetically: "Reverse alphabetically", // "repo.issues.label.filter_sort.reverse_alphabetically"
  sort_recentupdate: "Most recently updated", // "repo.issues.filter_sort.recentupdate"
  sort_leastupdate: "Least recently updated", // "repo.issues.filter_sort.leastupdate"
  sort_moststars: "Most stars", // "repo.issues.filter_sort.moststars"
  sort_feweststars: "Fewest stars", // "repo.issues.filter_sort.feweststars"
  sort_mostforks: "Most forks", // "repo.issues.filter_sort.mostforks"
  sort_fewestforks: "Fewest forks", // "repo.issues.filter_sort.fewestforks"
  sort_size: "Smallest size", // "repo.issues.label.filter_sort.by_size"
  sort_reverse_size: "Largest size", // "repo.issues.label.filter_sort.reverse_by_size"
  col_id: "ID", // list.tmpl:16
  col_owner: "Owner", // "admin.repos.owner" (list.tmpl:17)
  col_name: "Name", // "admin.repos.name" (list.tmpl:19)
  col_watchers: "Watchers", // "repo.watchers" (list.tmpl:22)
  col_stars: "Stars", // "repo.stars" (list.tmpl:24)
  col_forks: "Forks", // "repo.forks" (list.tmpl:27)
  col_issues: "Issues", // "admin.repos.issues" (list.tmpl:31)
  col_size: "Size", // "admin.repos.size" (list.tmpl:33)
  col_updated: "Updated", // "admin.auths.updated" (list.tmpl:40)
  col_created: "Created", // "admin.users.created" (list.tmpl:41)
  archived: "Archived", // "repo.desc.archived" (list.tmpl:53)
  private: "Private", // "repo.desc.private" (list.tmpl:56)
  internal: "Internal", // "repo.desc.internal" (list.tmpl:59)
  template: "Template", // "repo.desc.template" (list.tmpl:63)
  no_results: "No results found.", // "no_results_found" (list.tmpl:90)
} as const;

/** Upstream `setting.UI.Admin.RepoPagingNum` (modules/setting/ui.go:139). */
export const ADMIN_REPOS_PAGE_SIZE = 50;

/** The shared/repo/search sort vocabulary plus the header pairs (the module
 *  header). Default "recentupdate" (repo.go:59-62). */
export type AdminRepoSort =
  | "newest"
  | "oldest"
  | "alphabetically"
  | "reversealphabetically"
  | "recentupdate"
  | "leastupdate"
  | "moststars"
  | "feweststars"
  | "mostforks"
  | "fewestforks"
  | "size"
  | "reversesize"
  | "gitsize"
  | "reversegitsize"
  | "lfssize"
  | "reverselfssize";

/** The parsed query (the render's checked states + the pager's param set).
 *  Tri-states: "1" | "0" | null (absent); fork/mirror only ever carry "1"
 *  (the negated arms are omitted — the module header). */
export interface AdminReposListParams {
  keyword: string;
  sort: AdminRepoSort;
  /** Whether `?sort=` was in the URL (SortArrow's urlSort non-emptiness). */
  explicitSort: boolean;
  archived: "1" | "0" | null;
  fork: "1" | null;
  mirror: "1" | null;
  template: "1" | "0" | null;
  private: "1" | "0" | null;
  page: number;
}

const TRI = (raw: string | null): "1" | "0" | null => (raw === "1" || raw === "0" ? raw : null);

export function parseAdminReposListParams(params: URLSearchParams): AdminReposListParams {
  const raw = params.get("sort") ?? "";
  const known: AdminRepoSort[] = [
    "newest",
    "oldest",
    "alphabetically",
    "reversealphabetically",
    "recentupdate",
    "leastupdate",
    "moststars",
    "feweststars",
    "mostforks",
    "fewestforks",
    "size",
    "reversesize",
    "gitsize",
    "reversegitsize",
    "lfssize",
    "reverselfssize",
  ];
  const rawSort = params.get("sort");
  return {
    keyword: (params.get("q") ?? "").trim(),
    sort: (known as string[]).includes(raw) ? (raw as AdminRepoSort) : "recentupdate",
    explicitSort: rawSort !== null && rawSort !== "",
    archived: TRI(params.get("archived")),
    fork: params.get("fork") === "1" ? "1" : null,
    mirror: params.get("mirror") === "1" ? "1" : null,
    template: TRI(params.get("template")),
    private: TRI(params.get("private")),
    page: parsePageNumber(params.get("page")),
  };
}

/** repo.go:59-69's OrderByFlatMap lookup over the landed
 *  `searchRepositories` sort keys (services/repository.ts:718-750). The
 *  id-order stand-ins are the service's own documented posture (the module
 *  header). */
export function adminRepoSortMapping(sort: AdminRepoSort): { sort: string; order: string } {
  switch (sort) {
    case "newest":
      return { sort: "created", order: "desc" };
    case "oldest":
      return { sort: "created", order: "asc" };
    case "alphabetically":
      return { sort: "alpha", order: "asc" };
    case "reversealphabetically":
      return { sort: "alpha", order: "desc" };
    case "recentupdate":
      return { sort: "updated", order: "desc" };
    case "leastupdate":
      return { sort: "updated", order: "asc" };
    case "moststars":
      return { sort: "stars", order: "desc" };
    case "feweststars":
      return { sort: "stars", order: "asc" };
    case "mostforks":
      return { sort: "forks", order: "desc" };
    case "fewestforks":
      return { sort: "forks", order: "asc" };
    case "size":
      return { sort: "size", order: "asc" };
    case "reversesize":
      return { sort: "size", order: "desc" };
    case "gitsize":
      return { sort: "git_size", order: "asc" };
    case "reversegitsize":
      return { sort: "git_size", order: "desc" };
    case "lfssize":
      return { sort: "lfs_size", order: "asc" };
    case "reverselfssize":
      return { sort: "lfs_size", order: "desc" };
  }
}

// ---------------------------------------------------------------------------
// The loader (§3.2 — the landed searchRepositories service)
// ---------------------------------------------------------------------------

/** The page's render inputs. */
export interface AdminReposData {
  params: AdminReposListParams;
  query: URLSearchParams;
  total: number;
  more: boolean;
  items: RepositoryWithOwner[];
}

/**
 * The list load — `admin.Repos` → `RenderRepoSearch` over the landed
 * `searchRepositories` service: the admin viewer (all rows — the service's
 * is_admin short-circuit IS upstream's Private:true), the keyword, the
 * tri-state facets, the mapped sort, one page of 50.
 */
export async function loadAdminReposData(d1: D1Database, viewer: Viewer, search: URLSearchParams): Promise<AdminReposData> {
  const params = parseAdminReposListParams(search);
  // The service Viewer seam (the searchExploreRepos shape,
  // services/search.ts:106-109): the session viewer's two fields the WHERE
  // reads; the route gate guarantees kind === "user" (the module header).
  const apiViewer: ApiViewer = {
    origin: "",
    requester: viewer.kind === "user" ? { login: viewer.username, is_admin: viewer.isAdmin } : null,
  };
  const mapped = adminRepoSortMapping(params.sort);
  const listing = await searchRepositories(d1, apiViewer, {
    page: params.page,
    limit: ADMIN_REPOS_PAGE_SIZE,
    keyword: params.keyword,
    topicOnly: false,
    includeDesc: false,
    uid: 0,
    exclusive: false,
    priorityOwnerId: 0,
    teamId: 0,
    starredBy: 0,
    includePrivate: true, // upstream Repos: Private: true (repos.go:35)
    isPrivate: params.private === null ? null : params.private === "1",
    template: params.template === null ? null : params.template === "1",
    archived: params.archived === null ? null : params.archived === "1",
    mode: params.fork === "1" ? "fork" : params.mirror === "1" ? "mirror" : "",
    sort: mapped.sort,
    order: mapped.order,
  });

  const query = new URLSearchParams();
  if (params.keyword !== "") query.set("q", params.keyword);
  if (params.sort !== "recentupdate") query.set("sort", params.sort);
  if (params.archived !== null) query.set("archived", params.archived);
  if (params.fork !== null) query.set("fork", params.fork);
  if (params.mirror !== null) query.set("mirror", params.mirror);
  if (params.template !== null) query.set("template", params.template);
  if (params.private !== null) query.set("private", params.private);

  return { params, query, total: listing.total, more: params.page * ADMIN_REPOS_PAGE_SIZE < listing.total, items: listing.items };
}

// ---------------------------------------------------------------------------
// The render (templates/admin/repo/list.tmpl + shared/repo/search.tmpl)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern). */
export function renderAdminReposPage(ctx: UiContext, data: AdminReposData): string {
  return renderPage(<AdminReposPage ctx={ctx} data={data} />);
}

/** The admin repos page (§2.4.1 discriminator: `admin` — layout_head's
 *  pageClass, list.tmpl:1; the Title is ctx.Tr "admin.repositories",
 *  repos.go:31). */
export function AdminReposPage(props: { ctx: UiContext; data: AdminReposData }) {
  const { params } = props.data;
  const colCount = 10; // the live columns (LFS Size + Op omitted — the module header)
  const sortHref = (sort: string): string => {
    const next = new URLSearchParams(props.data.query);
    if (sort === "recentupdate") {
      next.delete("sort"); // the default never rides the URL (repo.go:59-62)
    } else {
      next.set("sort", sort);
    }
    const qs = next.toString();
    return qs === "" ? "/-/admin/repos" : `/-/admin/repos?${qs}`;
  };
  const filterClearHref = sortHref(params.sort); // q dropped too — the full clear
  const radio = (name: string, value: string, checked: boolean, label: string) => (
    <label class="item">
      <input type="radio" name={name} value={value} checked={checked} /> {label}
    </label>
  );
  const sortButton = (value: AdminRepoSort, label: string) => (
    <button type="submit" class="item" name="sort" value={value}>
      {label}
    </button>
  );
  return (
    <AdminFamilyShell ctx={props.ctx} title={adminReposLocale.repositories} pageClass="admin" active="repos">
      {/* The header (list.tmpl:3-8): panel name + total. The "Unadopted
          Repositories" button is omitted — the page is unlanded (the module
          header). */}
      <h4 class="ui top attached header">
        {adminReposLocale.repo_manage_panel} ({adminReposLocale.total.replace("%d", String(props.data.total))})
      </h4>
      {/* The toolbar (shared/repo/search.tmpl): ONE no-JS GET form wrapping
          the combo + the filter/sort dropdowns as details disclosures. */}
      <div class="ui attached segment">
        <div class="ui small secondary filter menu">
          <form class="ui form ignore-dirty tw-w-full flex-text-block tw-flex-wrap" method="get" action="/-/admin/repos">
            <div class="ui small fluid action input tw-flex-1">
              <input
                type="search"
                name="q"
                value={params.keyword}
                maxlength={255}
                spellcheck={false}
                placeholder={adminReposLocale.search_placeholder}
              />
              <button type="submit" class="ui small icon button" aria-label={adminReposLocale.search}>
                {adminReposLocale.search}
              </button>
            </div>
            {/* The filter dropdown (shared/repo/search.tmpl:10-47): the
                tri-state facets with landed backing; the fork/mirror "not"
                arms are omitted (the module header). */}
            <div class="item">
              <details>
                <summary>{adminReposLocale.filter_title}</summary>
                <div class="menu flex-items-menu">
                  <a class="item" href={filterClearHref}>
                    {adminReposLocale.filter_clear}
                  </a>
                  <div class="divider"></div>
                  {radio("archived", "1", params.archived === "1", adminReposLocale.filter_archived)}
                  {radio("archived", "0", params.archived === "0", adminReposLocale.filter_not_archived)}
                  <div class="divider"></div>
                  {radio("fork", "1", params.fork === "1", adminReposLocale.filter_forked)}
                  <div class="divider"></div>
                  {radio("mirror", "1", params.mirror === "1", adminReposLocale.filter_mirrored)}
                  <div class="divider"></div>
                  {radio("template", "1", params.template === "1", adminReposLocale.filter_template)}
                  {radio("template", "0", params.template === "0", adminReposLocale.filter_not_template)}
                  <div class="divider"></div>
                  {radio("private", "1", params.private === "1", adminReposLocale.filter_private)}
                  {radio("private", "0", params.private === "0", adminReposLocale.filter_public)}
                </div>
              </details>
            </div>
            {/* The sort dropdown (shared/repo/search.tmpl:48-83) — the users
                page's submit-button shape, no-JS live. */}
            <div class="item">
              <details>
                <summary>{adminReposLocale.sort}</summary>
                <div class="menu">
                  {sortButton("newest", adminReposLocale.sort_newest)}
                  {sortButton("oldest", adminReposLocale.sort_oldest)}
                  {sortButton("alphabetically", adminReposLocale.sort_alphabetically)}
                  {sortButton("reversealphabetically", adminReposLocale.sort_reverse_alphabetically)}
                  {sortButton("recentupdate", adminReposLocale.sort_recentupdate)}
                  {sortButton("leastupdate", adminReposLocale.sort_leastupdate)}
                  {sortButton("moststars", adminReposLocale.sort_moststars)}
                  {sortButton("feweststars", adminReposLocale.sort_feweststars)}
                  {sortButton("mostforks", adminReposLocale.sort_mostforks)}
                  {sortButton("fewestforks", adminReposLocale.sort_fewestforks)}
                  {sortButton("size", adminReposLocale.sort_size)}
                  {sortButton("reversesize", adminReposLocale.sort_reverse_size)}
                </div>
              </details>
            </div>
          </form>
        </div>
      </div>
      {/* The table (list.tmpl:12-94) — the ten live columns. The LFS Size and
          Op columns are omitted (the module header). */}
      <div class="ui attached table segment">
        <table class="ui very basic table selectable unstackable">
          <thead>
            <tr>
              <th>
                <SortHeader
                  label={adminReposLocale.col_id}
                  asc="oldest"
                  desc="newest"
                  active={params.sort}
                  explicit={params.explicitSort}
                  buildHref={sortHref}
                />
              </th>
              <th>{adminReposLocale.col_owner}</th>
              <th>
                <SortHeader
                  label={adminReposLocale.col_name}
                  asc="alphabetically"
                  desc="reversealphabetically"
                  active={params.sort}
                  explicit={params.explicitSort}
                  buildHref={sortHref}
                />
              </th>
              <th>{adminReposLocale.col_watchers}</th>
              <th>
                <SortHeader
                  label={adminReposLocale.col_stars}
                  asc="moststars"
                  desc="feweststars"
                  active={params.sort}
                  explicit={params.explicitSort}
                  buildHref={sortHref}
                />
              </th>
              <th>
                <SortHeader
                  label={adminReposLocale.col_forks}
                  asc="mostforks"
                  desc="fewestforks"
                  active={params.sort}
                  explicit={params.explicitSort}
                  buildHref={sortHref}
                />
              </th>
              <th>{adminReposLocale.col_issues}</th>
              <th>
                <SortHeader
                  label={adminReposLocale.col_size}
                  asc="gitsize"
                  desc="reversegitsize"
                  active={params.sort}
                  explicit={params.explicitSort}
                  buildHref={sortHref}
                />
              </th>
              <th>{adminReposLocale.col_updated}</th>
              <th>{adminReposLocale.col_created}</th>
            </tr>
          </thead>
          <tbody>
            {props.data.items.length === 0 ? (
              <tr>
                <td class="tw-text-center" colspan={colCount}>
                  {adminReposLocale.no_results}
                </td>
              </tr>
            ) : (
              props.data.items.map(({ repo, owner }) => (
                <tr key={repo.id}>
                  <td>{repo.id}</td>
                  {/* admin/shared/owner.tmpl: the owner link + the gold lock
                      on a private-visibility owner. */}
                  <td>
                    <a class="tw-break-anywhere" href={`/${owner.username}`}>
                      {owner.username}
                    </a>
                    {owner.visibility === "private" ? (
                      <span class="tw-text-gold">
                        <AdminEmbeddedSvg name="octicon-lock" />
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <a class="tw-break-anywhere" href={`/${repo.ownerNamespace}/${repo.slug}`}>
                      {repo.slug}
                    </a>
                    {repo.isArchived ? <span class="ui basic label">{adminReposLocale.archived}</span> : null}
                    {repo.visibility === "private" ? (
                      <span class="ui basic label">{adminReposLocale.private}</span>
                    ) : owner.visibility === "private" ? (
                      <span class="ui basic label">{adminReposLocale.internal}</span>
                    ) : null}
                    {repo.isTemplate ? <span class="ui basic label">{adminReposLocale.template}</span> : null}
                    {/* The mirror/fork glyphs (list.tmpl:68-72) — embedded
                        bytes (the module header). */}
                    {repo.isMirror ? (
                      <AdminEmbeddedSvg name="octicon-mirror" />
                    ) : repo.forkParent !== null ? (
                      <AdminEmbeddedSvg name="octicon-repo-forked" />
                    ) : null}
                  </td>
                  <td>{repo.numWatches}</td>
                  <td>{repo.numStars}</td>
                  <td>{repo.numForks}</td>
                  <td>{repo.numIssues}</td>
                  {/* Size: the column stores settled KiB; upstream
                      FormatByteSize takes bytes (the module header). */}
                  <td>{formatByteSize(repo.sizeKb * 1024)}</td>
                  <td>{repo.updatedAt !== null ? formatAdminDate(repo.updatedAt) : ""}</td>
                  <td>{formatAdminDate(repo.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <AdminFamilyPagination basePath="/-/admin/repos" query={props.data.query} page={params.page} more={props.data.more} />
    </AdminFamilyShell>
  );
}

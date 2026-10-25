/**
 * The explore pages — `/explore/repos` and `/explore/users` — plus the
 * `/explore` root redirect — pages wave 9 (SPEC-0008 U3 extension), upstream
 * `routers/web/explore/` (repo.go `Repos`, user.go `Users`, web.go:549-556
 * route group):
 *
 *   GET /explore          → 303 /explore/repos   (web.go:550-552)
 *   GET /explore/repos    → repo search page     (repo.go:146 Repos)
 *   GET /explore/users    → user search page     (user.go:124 Users)
 *
 * Anonymous-capable (upstream renders both for every viewer; the navbar
 * links them for both — head_navbar.tmpl's `PageIsExplore` item).
 *
 * ## DOM contract (templates/explore/repos.tmpl + users.tmpl +
 *  explore/navbar.tmpl + shared/repo/search.tmpl + shared/search/combo.tmpl +
 *  explore/user_list.tmpl + shared/repo/list.tmpl at the pin)
 *
 * `.page-content.explore.repositories` / `.explore.users`; the
 * `explore/navbar` tab strip (an `overflow-menu.ui.secondary.pointing
 * tabular top attached borderless menu secondary-nav`, centered — the
 * Repositories/Users pair; the Organizations/Code tabs are not rendered:
 * their pages do not exist, dead links forbidden §2.4.1); then
 * `.ui.container` with the search form (shared/search/combo's
 * `.ui.small.fluid.action.input` — `<input type="search" name="q"
 * maxlength={255}>` + submit), the repo list (shared/repo/list rows) or the
 * user list (explore/user_list rows), and the Older/Newer pager.
 *
 * ## Data (the landed search services — api/services/search.ts carries the
 *  reuse/extraction record)
 *
 * - repos: `searchExploreRepos` (the landed `searchRepositories` query with
 *   upstream's `Private: ctx.Doer != nil` scope — a signed-in viewer sees
 *   their own private repos, anonymous public rows only). `?q=` keyword,
 *   `?page=`, `?sort=` through the four web sorts with a landed backing
 *   (search.ts exploreRepoSort; unknown values degrade to the landed
 *   default order — upstream falls back to recentupdate, never an error).
 * - users: `searchExploreUsers` (the landed `searchUsers` predicate + the
 *   upstream Types/IsActive gates), `?q=`, `?page=`, `?sort=` over the four
 *   upstream sorts, "newest" default.
 * - Page size is upstream `setting.UI.ExplorePagingNum` = 20
 *   (modules/setting/ui.go:87).
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The repos filter dropdown (archived/fork/mirror/template/private
 *   facets) and the sort dropdowns are not rendered: the facets have no
 *   landed backing and a server-rendered Fomantic dropdown needs the JS
 *   contract this slice does not pin (dead controls forbidden, §2.4.1).
 *   `?sort=` stays honored as a plain URL parameter (see search.ts).
 * - Repo rows render the shared list reduction (the org-home row): the
 *   octicon-repo glyph (no avatar pipeline), owner/repo links (upstream
 *   `ShowRepoOwnerOnList` — the owner link is the row's namespace link),
 *   the archived/private/internal badges, the description, the "Updated"
 *   line, the open-pulls counter chip. Stars/forks/primary-language chips
 *   have no D1 sources (§3.1).
 * - User rows render the avatar placeholder circle (the owner-home
 *   avatar-slot rule), the `/{username}` name link (shared/user/name), the
 *   Private badge, the location and "Joined on" rows. The email row needs
 *   the ShowUserEmail setting (upstream's default-off gate — not rendered).
 * - Empty results render upstream's "search.no_results" line in both
 *   lists' `{{else}}` arms.
 */

import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  parseExploreUserSort,
  searchExploreRepos,
  searchExploreUsers,
  type ExploreDoer,
  type ExploreUserRow,
} from "../../api/services/search";
import { repoSettings, type repositories } from "../../db/schema";
import { OrgRepoListItem, type OrgHomeRepoItem } from "./org-home";
import { formatDueDate } from "./milestones";
import { parsePageNumber } from "../page-data";
import { userLink } from "../links";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { Viewer } from "../viewer";
import type { UiContext } from "../ui-context";

/** Page chrome text (component-local, the orgHomeLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const exploreLocale = {
  explore: "Explore", // "explore_title"
  repositories: "Repositories", // "explore.repos"
  users: "Users", // "explore.users"
  repos_placeholder: "Search repos…", // "search.repo_kind"
  users_placeholder: "Search users…", // "search.user_kind"
  search: "Search…", // "search.search" (the submit button's visible text —
  //  upstream renders the octicon-search glyph, which is outside the
  //  generated icon allowlist; the aria-label becomes the button text)
  no_results: "No matching results found.", // "search.no_results"
  joined_on: "Joined on", // "user.joined_on"
  user_private: "Private", // "repo.desc.private" (user_list.tmpl's badge)
} as const;

/** Upstream `setting.UI.ExplorePagingNum` (modules/setting/ui.go:87). */
export const EXPLORE_PAGE_SIZE = 20;

/** Trimmed `?q=` (upstream FormTrim). */
export function parseExploreKeyword(raw: string | null): string {
  return (raw ?? "").trim();
}

/** The doer slice the search service takes (null = anonymous). */
function exploreDoer(viewer: Viewer): ExploreDoer | null {
  return viewer.kind === "user" ? { id: viewer.id, username: viewer.username, isAdmin: viewer.isAdmin } : null;
}

// ---------------------------------------------------------------------------
// Data loading (§3.2 — the landed search services, never a self-fetch)
// ---------------------------------------------------------------------------

/** One rendered repo row: the repository, its owner's visibility (the
 *  internal-badge rule), the settings description. */
export interface ExploreRepoItem {
  repo: typeof repositories.$inferSelect;
  ownerVisibility: "public" | "limited" | "private";
  description: string;
}

/** The explore repos render inputs. */
export interface ExploreReposData {
  keyword: string;
  page: number;
  more: boolean;
  total: number;
  items: ExploreRepoItem[];
}

/**
 * Load `/explore/repos`: the landed repo-search query (search.ts — the
 * doer seam carries upstream's Private scope), then one batched description
 * read for the page's rows (the org-home loader pattern).
 */
export async function loadExploreReposData(
  d1: D1Database,
  viewer: Viewer,
  params: URLSearchParams,
): Promise<ExploreReposData> {
  const keyword = parseExploreKeyword(params.get("q"));
  const page = parsePageNumber(params.get("page"));
  const listing = await searchExploreRepos(d1, exploreDoer(viewer), {
    keyword,
    page,
    limit: EXPLORE_PAGE_SIZE,
    sort: params.get("sort") ?? "",
  });

  const descriptions = new Map<string, string>();
  if (listing.items.length > 0) {
    const rows = await drizzle(d1)
      .select({ repoId: repoSettings.repoId, description: repoSettings.description })
      .from(repoSettings)
      .where(inArray(repoSettings.repoId, listing.items.map((item) => item.repo.id)))
      .all();
    for (const row of rows) descriptions.set(row.repoId, row.description);
  }

  return {
    keyword,
    page,
    more: page * EXPLORE_PAGE_SIZE < listing.total,
    total: listing.total,
    items: listing.items.map((item) => ({
      repo: item.repo,
      ownerVisibility: item.owner.visibility,
      description: descriptions.get(item.repo.id) ?? "",
    })),
  };
}

/** The explore users render inputs. */
export interface ExploreUsersData {
  keyword: string;
  page: number;
  more: boolean;
  total: number;
  items: ExploreUserRow[];
}

/** Load `/explore/users`: the landed user-search query + the explore gates. */
export async function loadExploreUsersData(d1: D1Database, params: URLSearchParams): Promise<ExploreUsersData> {
  const keyword = parseExploreKeyword(params.get("q"));
  const page = parsePageNumber(params.get("page"));
  const listing = await searchExploreUsers(d1, {
    keyword,
    page,
    limit: EXPLORE_PAGE_SIZE,
    sort: parseExploreUserSort(params.get("sort")),
  });
  return {
    keyword,
    page,
    more: page * EXPLORE_PAGE_SIZE < listing.total,
    total: listing.total,
    items: listing.items,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** explore/navbar.tmpl: the Repositories/Users tab strip (the
 *  Organizations/Code tabs have no pages — module header). */
export function ExploreNavbar(props: { active: "repos" | "users" }) {
  const tab = (kind: "repos" | "users", href: string, label: string, icon: "octicon-repo" | "octicon-person") => (
    <a class={props.active === kind ? "active item" : "item"} href={href}>
      <Icon name={icon} /> {label}
    </a>
  );
  return (
    <overflow-menu class="ui secondary pointing tabular top attached borderless menu secondary-nav">
      <div class="overflow-menu-items tw-justify-center">
        {tab("repos", "/explore/repos", exploreLocale.repositories, "octicon-repo")}
        {tab("users", "/explore/users", exploreLocale.users, "octicon-person")}
      </div>
    </overflow-menu>
  );
}

/** The search box (shared/search/combo reduced): a GET form re-submitting
 *  `?q=` to the page's own URL; the input keeps the submitted keyword. */
export function ExploreSearchForm(props: { action: string; keyword: string; placeholder: string }) {
  return (
    <div class="ui small secondary filter menu">
      <form class="ui form ignore-dirty tw-flex-1" method="get" action={props.action}>
        <div class="ui small fluid action input">
          <input type="search" name="q" value={props.keyword} maxlength={255} spellcheck={false} placeholder={props.placeholder} />
          <button type="submit" class="ui small icon button" aria-label={exploreLocale.search}>
            {exploreLocale.search}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The Older/Newer pager preserving `?q=` (the issues-list DOM shape —
 *  div.center.page.buttons, driven by `page * size < total`). */
export function ExplorePagination(props: { basePath: string; keyword: string; page: number; more: boolean }) {
  if (props.page <= 1 && !props.more) return null;
  const href = (page: number): string => {
    const params = new URLSearchParams();
    if (props.keyword !== "") params.set("q", props.keyword);
    params.set("page", String(page));
    return `${props.basePath}?${params.toString()}`;
  };
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a class="item navigation" href={href(props.page - 1)}>
            <span class="navigation_label">Newer</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={href(props.page + 1)}>
            <span class="navigation_label">Older</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The full-document render — the repos page (§2.4.1 discriminator:
 *  `explore repositories`). */
export function renderExploreReposPage(ctx: UiContext, data: ExploreReposData): string {
  return renderPage(<ExploreReposPage ctx={ctx} data={data} />);
}

export function ExploreReposPage(props: { ctx: UiContext; data: ExploreReposData }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title={exploreLocale.explore} pageClass="explore repositories" activeNav="explore">
      <ExploreNavbar active="repos" />
      <div class="ui container">
        <ExploreSearchForm action="/explore/repos" keyword={data.keyword} placeholder={exploreLocale.repos_placeholder} />
        <div class="divider"></div>
        {data.items.length === 0 ? (
          <div>
            <p>{exploreLocale.no_results}</p>
          </div>
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
        <ExplorePagination basePath="/explore/repos" keyword={data.keyword} page={data.page} more={data.more} />
      </div>
    </BaseLayout>
  );
}

/** One explore/user_list.tmpl `.item` row (the module-header reduction):
 *  the avatar placeholder, the name link, the Private badge, location and
 *  "Joined on". */
export function ExploreUserRow(props: { user: ExploreUserRow }) {
  const { user } = props;
  return (
    <div class="item tw-items-center">
      <div class="item-leading">
        <span class="ui avatar" aria-hidden="true">
          <Icon name="octicon-person" size={48} />
        </span>
      </div>
      <div class="item-main">
        <div class="item-title">
          <a class="text muted" href={userLink(user.username)}>
            {user.username}
          </a>
          {user.visibility === "private" ? <span class="ui basic tiny label">{exploreLocale.user_private}</span> : null}
        </div>
        <div class="item-body">
          {user.location !== null && user.location !== "" ? (
            <span class="flex-text-inline">
              <Icon name="octicon-location" />
              {user.location}
            </span>
          ) : null}
          <span class="flex-text-inline">
            <Icon name="octicon-calendar" />
            {exploreLocale.joined_on} {formatDueDate(user.createdAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

/** The full-document render — the users page (§2.4.1 discriminator:
 *  `explore users`). */
export function renderExploreUsersPage(ctx: UiContext, data: ExploreUsersData): string {
  return renderPage(<ExploreUsersPage ctx={ctx} data={data} />);
}

export function ExploreUsersPage(props: { ctx: UiContext; data: ExploreUsersData }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title={exploreLocale.explore} pageClass="explore users" activeNav="explore">
      <ExploreNavbar active="users" />
      <div class="ui container">
        <ExploreSearchForm action="/explore/users" keyword={data.keyword} placeholder={exploreLocale.users_placeholder} />
        <div class="divider"></div>
        {data.items.length === 0 ? (
          <div class="item">
            <p>{exploreLocale.no_results}</p>
          </div>
        ) : (
          <div class="flex-divided-list items-with-main">
            {data.items.map((user) => (
              <ExploreUserRow key={user.id} user={user} />
            ))}
          </div>
        )}
        <ExplorePagination basePath="/explore/users" keyword={data.keyword} page={data.page} more={data.more} />
      </div>
    </BaseLayout>
  );
}

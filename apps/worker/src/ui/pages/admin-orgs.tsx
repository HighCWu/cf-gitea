/**
 * The ADMIN ORGANIZATIONS list page — `/-/admin/orgs` — the wave-admin-pages
 * bench row (the parity survey row docs/compat/ui-parity-survey.md:549's
 * orgs remainder), MOUNTED at 2f7afe9 (the mount window): the route lives in
 * `index.ts`'s admin literal family block — the retired wiring HANDOFF is
 * the mount record at the bottom. Sibling scope: `admin-users.tsx` (this wave)
 * hosts the shared family chrome (nav/shell/pager/embedded icons) and owns
 * the users list; `admin-repos.tsx` owns the repos list; the landed
 * dashboard/monitor family owns `/-/admin` and `/-/admin/monitor/*` — none
 * of those files is touched here.
 *
 * ## Upstream surface (at the pin)
 *
 * `templates/admin/org/list.tmpl` (82 lines) served by `admin.Organizations`
 * (routers/web/admin/orgs.go:22-36) through the SAME
 * `explore.RenderUserSearch` as the users page (routers/web/explore/
 * user.go:35-122), route `GET /-/admin/orgs` (web.go:828-830's `/orgs`
 * group), behind the shared admin gate (web.go:779 — anonymous → the login
 * redirect, a signed-in non-admin → the 404 shell; the ROUTE stage's
 * posture). The handler: Title + PageIsAdminOrganizations, `sort` defaulting
 * to `UserSearchDefaultAdminSort` = "alphabetically" (orgs.go:26 — the
 * users.go:49 constant), Types = [UserTypeOrganization,
 * UserTypeOrganizationReserved] (orgs.go:29 — organizations ONLY), all three
 * visibilities in scope (orgs.go:33), page size
 * `setting.UI.Admin.OrgPagingNum` = 50 (modules/setting/ui.go:141), NO
 * keyword gates beyond the shared `q` (SearchByEmail is NOT set — the
 * keyword matches name/full name only, models/user/search.go:87-91).
 *
 * NOTE the upstream quirk kept verbatim: org/list.tmpl:1 declares the
 * layout_head pageClass `"admin user"` (the users page's value — upstream
 * copy-through, the §2.4.1 discriminator for this page too).
 *
 * ## Row projection (org/list.tmpl:50-76 at the pin → the landed columns)
 *
 *   ID          users.id (sortable: oldest/newest)
 *   Name        users.username → /{username} (HomeLink); the display name in
 *               parentheses when fullName is set (list.tmpl:57); the
 *               octicon-lock gold glyph when visibility='private'
 *               (list.tmpl:59-61 — embedded bytes, the FOLD_SVG precedent);
 *               the Reserved label (type 3, list.tmpl:62-64) is unreachable —
 *               `users.type` has no reserved variant (sortable:
 *               alphabetically/reversealphabetically, data-sortt-default)
 *   Teams       COUNT(teams) per org — no maintained column exists
 *               (`users.numMembers` is the MEMBER counter; upstream's
 *               User.NumTeams is a maintained column we do not carry), so
 *               the loader runs one GROUP BY over the page's org ids
 *   Members     users.numMembers (the maintained counter — the same column
 *               the org members header reads)
 *   Repos       COUNT(repositories) per org — upstream's User.NumRepos is
 *               maintained; ours is derived the same way as the teams count
 *   Created     createdAt → AbsoluteShort (sortable here: the Created header
 *               carries recentupdate/leastupdate, list.tmpl:43-46 — sorting
 *               `updated_unix` upstream, no users.updated column →
 *               created_at, the admin-t2 deviation 5 stand-in)
 *   (actions)   the pencil link → list.tmpl:70's
 *               `{{.OrganisationLink}}/settings` = /org/{name}/settings
 *               (OrganisationLink, user.go:351-353; the upstream settings
 *               group, web.go:1017). The TARGET page (org-settings.tsx) IS
 *               landed — but at our DOCUMENTED-DIVERGENCE mount
 *               `/{org}/settings` (the index.ts mount record; pinned at
 *               ui/index.test.ts's org-settings family cases), with no
 *               `/org/{name}` alias, so the emitted href follows the
 *               MOUNTED shape, not upstream's bytes (upstream-parity rule:
 *               the mount is the divergence, the emitter adapts — the
 *               link-crawl A1/A4 fix, docs/usability/findings-links.md)
 *               (octicon-pencil, allowlisted)
 *
 * The header's "New Organization" button (list.tmpl:6 → /org/create) is a
 * LANDED page (org-create family) → rendered LIVE.
 *
 * ## Live search/sort arms (query passthrough, list.tmpl:9-30)
 *
 * The orgs page has NO filter dropdowns — just the search combo and the sort
 * menu, and upstream's own sort items are plain `<a href="?sort=…&q=…">`
 * links (list.tmpl:21-26, no JS, no form): rendered verbatim (q preserved,
 * active item marked). The table headers use the same SortHeader link
 * reduction as the users page (tablesort.ts → a `?sort=` anchor; the
 * triangles embed the submodule bytes exported from admin-users.tsx).
 * Unknown `sort` values fold to the default "alphabetically" (the
 * explore.tsx degradation posture — see parseAdminUserSort in
 * admin-users.tsx, shared vocabulary).
 *
 * ## Data (§3.2 — D1 through Drizzle; the service-layer gap recorded)
 *
 * Same posture as the users page (the module header there): no landed
 * service carries the admin org listing (`listVisibleOrgs`,
 * services/orgs.ts:313, is the explore/doer-shaped arm, not the admin
 * family listing; the API twin `adminGetAllOrgs` keeps its predicate in the
 * route module), so the module issues the admin predicate directly through
 * Drizzle — type='org', keyword over username/full name, the sort, one page
 * of 50 + two grouped counts (teams by org_id, repositories by owner_id)
 * for the page's rows.
 *
 * ## Mount record (MOUNTED at 2f7afe9 — the route is live)
 *
 * See admin-users.tsx's mount record for the shared recipe; this page's claim in
 * the landed admin literal family block:
 *
 *   `tail.length === 1 && tail[0] === "orgs"` returns `{ family:
 *    "admin-orgs" }` — static literal BEFORE any dynamic arm; the handler
 *   is adminPagePrologue(c) → loadAdminOrgsData(c.env.DB, searchParams) →
 *   renderAdminOrgsPage(p.ctx, data) at 200.
 *
 * The AdminFamilyNav import marks this page's item active via
 * `active="orgs"`. Survey row flipped on landing:
 * docs/compat/ui-parity-survey.md:549.
 */

import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, teams, users } from "../../db/schema";

import { parsePageNumber } from "../page-data";
import { Icon, renderPage } from "../shell";
import {
  AdminEmbeddedSvg,
  AdminFamilyPagination,
  AdminFamilyShell,
  SortHeader,
  formatAdminDate,
  parseAdminUserSort,
  type AdminUserSort,
} from "./admin-users";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const adminOrgsLocale = {
  /** The page Title (orgs.go:23 — ctx.Tr "admin.organizations"). */
  organizations: "Organizations", // "admin.organizations"
  org_manage_panel: "Organization Management", // "admin.orgs.org_manage_panel" (list.tmpl:4)
  total: "Total: %d", // "admin.total" (list.tmpl:4)
  new_orga: "New Organization", // "admin.orgs.new_orga" (list.tmpl:6 — LIVE: /org/create)
  search_placeholder: "Search orgs…", // "search.org_kind" (list.tmpl:12)
  search: "Search…", // "search.search" (the combo's submit — the explore text-button reduction)
  sort: "Sort", // "repo.issues.filter_sort" (list.tmpl:17)
  sort_oldest: "Oldest", // "repo.issues.filter_sort.oldest"
  sort_newest: "Newest", // "repo.issues.filter_sort.latest"
  sort_alphabetically: "Alphabetically", // "repo.issues.label.filter_sort.alphabetically"
  sort_reverse_alphabetically: "Reverse alphabetically", // "repo.issues.label.filter_sort.reverse_alphabetically"
  sort_recentupdate: "Most recently updated", // "repo.issues.filter_sort.recentupdate"
  sort_leastupdate: "Least recently updated", // "repo.issues.filter_sort.leastupdate"
  col_id: "ID", // list.tmpl:35
  col_name: "Name", // "admin.orgs.name" (list.tmpl:37)
  col_teams: "Teams", // "admin.orgs.teams" (list.tmpl:40)
  col_members: "Members", // "admin.orgs.members" (list.tmpl:41)
  col_repos: "Repos", // "admin.users.repos" (list.tmpl:42)
  col_created: "Created", // "admin.users.created" (list.tmpl:44)
  edit: "Edit", // "edit" (the pencil link's tooltip, list.tmpl:70)
  no_results: "No results found.", // "no_results_found" (list.tmpl:73)
} as const;

/** Upstream `setting.UI.Admin.OrgPagingNum` (modules/setting/ui.go:141). */
export const ADMIN_ORGS_PAGE_SIZE = 50;

/** The parsed query (the render's active states + the pager's param set). */
export interface AdminOrgsListParams {
  keyword: string;
  sort: AdminUserSort;
  /** Whether `?sort=` was in the URL (SortArrow's urlSort non-emptiness). */
  explicitSort: boolean;
  page: number;
}

export function parseAdminOrgsListParams(params: URLSearchParams): AdminOrgsListParams {
  const rawSort = params.get("sort");
  return {
    keyword: (params.get("q") ?? "").trim(),
    sort: parseAdminUserSort(rawSort),
    explicitSort: rawSort !== null && rawSort !== "",
    page: parsePageNumber(params.get("page")),
  };
}

// ---------------------------------------------------------------------------
// The loader (§3.2 — orgs.go:22-36 over the landed columns)
// ---------------------------------------------------------------------------

/** One rendered org row: the user row + the two derived counters (the
 *  maintained `numMembers` rides the row; upstream's NumTeams/NumRepos have
 *  no landed columns — the module header). */
export interface AdminOrgRow {
  org: typeof users.$inferSelect;
  numTeams: number;
  numRepos: number;
}

/** The page's render inputs. */
export interface AdminOrgsData {
  params: AdminOrgsListParams;
  query: URLSearchParams;
  total: number;
  more: boolean;
  items: AdminOrgRow[];
}

/**
 * The list load — `admin.Organizations` → `RenderUserSearch` over the landed
 * columns: type='org' (upstream's organization family, orgs.go:29), keyword
 * over username/full name (NO email arm — SearchByEmail unset), all three
 * visibilities in scope (orgs.go:33 — the admin gate is the route stage's),
 * the sort, one page of 50; then the page's Teams/Repos counters as two
 * GROUP BY reads (the module header).
 */
export async function loadAdminOrgsData(d1: D1Database, search: URLSearchParams): Promise<AdminOrgsData> {
  const params = parseAdminOrgsListParams(search);
  const conditions: SQL[] = [eq(users.type, "org")];
  if (params.keyword !== "") {
    const keyword = params.keyword.toLowerCase();
    conditions.push(sql`(
      instr(${users.usernameLower}, ${keyword}) > 0
      or instr(lower(coalesce(${users.fullName}, '')), ${keyword}) > 0
    )`);
  }
  const where = and(...conditions);
  const db = drizzle(d1);

  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(users).where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const rows = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(...adminOrgOrderBy(params.sort))
    .limit(ADMIN_ORGS_PAGE_SIZE)
    .offset((params.page - 1) * ADMIN_ORGS_PAGE_SIZE);

  // The page's derived counters (the module header): teams by org_id and
  // repositories by owner_id, one GROUP BY each over the page's ids.
  const ids = rows.map((row) => row.id);
  const teamCounts = new Map<number, number>();
  const repoCounts = new Map<number, number>();
  if (ids.length > 0) {
    const teamRows = await db
      .select({ orgId: teams.orgId, value: sql<number>`count(*)` })
      .from(teams)
      .where(inArray(teams.orgId, ids))
      .groupBy(teams.orgId)
      .all();
    for (const row of teamRows) teamCounts.set(row.orgId, Number(row.value));
    const repoRows = await db
      .select({ ownerId: repositories.ownerId, value: sql<number>`count(*)` })
      .from(repositories)
      .where(inArray(repositories.ownerId, ids))
      .groupBy(repositories.ownerId)
      .all();
    for (const row of repoRows) {
      if (row.ownerId !== null) repoCounts.set(row.ownerId, Number(row.value));
    }
  }

  const query = new URLSearchParams();
  if (params.keyword !== "") query.set("q", params.keyword);
  if (params.sort !== "alphabetically") query.set("sort", params.sort);

  return {
    params,
    query,
    total,
    more: params.page * ADMIN_ORGS_PAGE_SIZE < total,
    items: rows.map((org) => ({ org, numTeams: teamCounts.get(org.id) ?? 0, numRepos: repoCounts.get(org.id) ?? 0 })),
  };
}

/** orgs.go:26 + user.go:61-83's switch over the landed columns — the users
 *  page's mapping (admin-users.tsx); the orgs Created header sorts
 *  recentupdate/leastupdate → created_at (the deviation-5 stand-in). */
function adminOrgOrderBy(sort: AdminUserSort): SQL[] {
  switch (sort) {
    case "oldest":
      return [asc(users.id)];
    case "newest":
      return [desc(users.id)];
    case "alphabetically":
      return [asc(users.usernameLower)];
    case "reversealphabetically":
      return [desc(users.usernameLower)];
    case "recentupdate":
      return [desc(users.createdAt)];
    case "leastupdate":
      return [asc(users.createdAt)];
  }
}

// ---------------------------------------------------------------------------
// The render (templates/admin/org/list.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern). */
export function renderAdminOrgsPage(ctx: UiContext, data: AdminOrgsData): string {
  return renderPage(<AdminOrgsPage ctx={ctx} data={data} />);
}

/** The admin orgs page (§2.4.1 discriminator: `admin user` — list.tmpl:1's
 *  literal, upstream's copy-through quirk kept verbatim; the Title is
 *  ctx.Tr "admin.organizations", orgs.go:23). */
export function AdminOrgsPage(props: { ctx: UiContext; data: AdminOrgsData }) {
  const { params } = props.data;
  const colCount = 7;
  const sortHref = (sort: string): string => {
    const next = new URLSearchParams(props.data.query);
    if (sort === "alphabetically") {
      next.delete("sort"); // the default never rides the URL (orgs.go:26)
    } else {
      next.set("sort", sort);
    }
    const qs = next.toString();
    return qs === "" ? "/-/admin/orgs" : `/-/admin/orgs?${qs}`;
  };
  const sortItem = (value: AdminUserSort, label: string) => (
    <a class={params.sort === value ? "active item" : "item"} href={sortHref(value)}>
      {label}
    </a>
  );
  return (
    <AdminFamilyShell ctx={props.ctx} title={adminOrgsLocale.organizations} pageClass="admin user" active="orgs">
      {/* The header (list.tmpl:3-8): panel name + total + the LIVE New
          Organization button (org-create is landed — the module header). */}
      <h4 class="ui top attached header">
        {adminOrgsLocale.org_manage_panel} ({adminOrgsLocale.total.replace("%d", String(props.data.total))})
        <div class="ui right">
          <a class="ui primary tiny button" href="/org/create">
            {adminOrgsLocale.new_orga}
          </a>
        </div>
      </h4>
      {/* The toolbar (list.tmpl:9-30): the search combo + upstream's own
          plain-link sort menu (kept verbatim — no form needed). */}
      <div class="ui attached segment">
        <div class="ui secondary filter menu tw-items-center tw-mx-0">
          <form class="ui form ignore-dirty tw-flex-1" method="get" action="/-/admin/orgs">
            <div class="ui small fluid action input">
              <input
                type="search"
                name="q"
                value={params.keyword}
                maxlength={255}
                spellcheck={false}
                placeholder={adminOrgsLocale.search_placeholder}
              />
              <button type="submit" class="ui small icon button" aria-label={adminOrgsLocale.search}>
                {adminOrgsLocale.search}
              </button>
            </div>
          </form>
          <div class="ui dropdown type jump item tw-mr-0">
            <span class="text">{adminOrgsLocale.sort}</span>
            <div class="menu">
              {sortItem("oldest", adminOrgsLocale.sort_oldest)}
              {sortItem("newest", adminOrgsLocale.sort_newest)}
              {sortItem("alphabetically", adminOrgsLocale.sort_alphabetically)}
              {sortItem("reversealphabetically", adminOrgsLocale.sort_reverse_alphabetically)}
              {sortItem("recentupdate", adminOrgsLocale.sort_recentupdate)}
              {sortItem("leastupdate", adminOrgsLocale.sort_leastupdate)}
            </div>
          </div>
        </div>
      </div>
      {/* The table (list.tmpl:31-77) — all seven columns live. The sortable
          headers are the tablesort.ts link reduction. */}
      <div class="ui attached table segment">
        <table class="ui very basic table unstackable">
          <thead>
            <tr>
              <th scope="col">
                <SortHeader
                  label={adminOrgsLocale.col_id}
                  asc="oldest"
                  desc="newest"
                  active={params.sort}
                  explicit={params.explicitSort}
                  buildHref={sortHref}
                />
              </th>
              <th scope="col">
                <SortHeader
                  label={adminOrgsLocale.col_name}
                  asc="alphabetically"
                  desc="reversealphabetically"
                  active={params.sort}
                  explicit={params.explicitSort}
                  defaultColumn={true}
                  buildHref={sortHref}
                />
              </th>
              <th scope="col">{adminOrgsLocale.col_teams}</th>
              <th scope="col">{adminOrgsLocale.col_members}</th>
              <th scope="col">{adminOrgsLocale.col_repos}</th>
              <th scope="col">
                <SortHeader
                  label={adminOrgsLocale.col_created}
                  asc="recentupdate"
                  desc="leastupdate"
                  active={params.sort}
                  explicit={params.explicitSort}
                  buildHref={sortHref}
                />
              </th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {props.data.items.length === 0 ? (
              <tr>
                <td class="tw-text-center" colspan={colCount}>
                  {adminOrgsLocale.no_results}
                </td>
              </tr>
            ) : (
              props.data.items.map(({ org, numTeams, numRepos }) => (
                <tr key={org.id}>
                  <td>{org.id}</td>
                  <td>
                    <span class="username-display">
                      <a href={`/${org.username}`}>{org.username}</a>
                      {org.fullName !== null && org.fullName !== "" ? <span class="username-fullname">({org.fullName})</span> : null}
                    </span>
                    {org.visibility === "private" ? (
                      <span class="tw-text-gold">
                        <AdminEmbeddedSvg name="octicon-lock" />
                      </span>
                    ) : null}
                  </td>
                  <td>{numTeams}</td>
                  <td>{org.numMembers}</td>
                  <td>{numRepos}</td>
                  <td>{formatAdminDate(org.createdAt)}</td>
                  {/* The settings pencil (list.tmpl:70). Upstream emits
                      OrganisationLink()/settings = /org/{name}/settings
                      (user.go:351-353, web.go:1017); our org-settings mount
                      is the DOCUMENTED DIVERGENCE at /{org}/settings (no
                      /org/{name} alias), so the href follows the mounted
                      shape — org-settings.tsx is landed there and the link
                      is live (the link-crawl A1/A4 fix; the module
                      header's actions row). */}
                  <td>
                    <a href={`/${org.username}/settings`} data-tooltip-content={adminOrgsLocale.edit} aria-label={adminOrgsLocale.edit}>
                      <Icon name="octicon-pencil" />
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <AdminFamilyPagination basePath="/-/admin/orgs" query={props.data.query} page={params.page} more={props.data.more} />
    </AdminFamilyShell>
  );
}

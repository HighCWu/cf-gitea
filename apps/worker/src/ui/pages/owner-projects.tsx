/**
 * The owner projects list page, `/{username}/-/projects` — pages wave 37
 * (the UI-parity survey's regenerated top-5 row 5, docs/compat/
 * ui-parity-survey.md: web.go:1137-1163, M, authoring): the `/-` namespace's
 * projects board LISTING — the owner's projects index with the state/open
 * counts — over the landed projects service family (src/api/services/
 * projects.ts, all three scopes REG'd; the survey's "unblocked" note).
 *
 * ## Upstream shape (cited)
 *
 * `GET /{username}/-/projects` routes to `org.Projects`
 * (routers/web/org/projects.go:40-124, tplProjects = "org/projects/list")
 * under web.go:1107's `/{username}/-` group (web.go:1143-1150's read group:
 * `m.Get("", org.Projects)` + the `/{id}` board routes, and the write
 * group's `/new`, `/{id}/edit|delete|open|close` behind reqSignIn). The
 * template, org/projects/list.tmpl, branches on `.ContextUser.
 * IsOrganization`: an ORG renders `org/header` + the shared `projects/list`
 * inside `.page-content.organization.projects`; an INDIVIDUAL renders
 * `.page-content.user.profile` with the four-wide profile avatar column
 * (shared/user/profile_big_avatar) + the twelve-wide column carrying
 * `user/overview/header` + the same `projects/list`. It is a project-list
 * INDEX, not a board: one `.item` per project — the owner-project glyph
 * (`Project.IconName`, project.go:161-166: every non-repository project is
 * `octicon-project-symlink`), the title link onto the `/{id}` board, the
 * open/closed ISSUE counts, the writer controls (edit/open-close/delete +
 * the New Project button) and the rendered description.
 *
 * ## The slice (honest scoping)
 *
 * The LIST surface lands fully: the `?state=` facet (the handler's exact
 * reading, projects.go:45 — `state == "closed"` after trim+lowercase; the
 * web page has no "all" arm), the open/closed count toggle (writer-only —
 * the template's `{{if and $.CanWriteProjects ...}}` block), the per-row
 * visibility-filtered issue counts, the pagination
 * (`setting.UI.IssuePagingNum` = 20, modules/setting/ui.go:89), both empty
 * arms (projects/list.tmpl's `{{else}}` pair: "No projects yet." +
 * description when the owner carries NO projects at all, "No projects match
 * your search." when the current facet narrows to zero) and both chrome
 * arms. The BOARD depth (`/{id}` view with columns+cards, the
 * `/{id}/workflows` pages, and the whole write group) is its own follow-up
 * row, NOT half-ported — so:
 *
 * - project titles render as PLAIN TEXT (their `/{id}` anchor would be a
 *   dead link, §2.4.1);
 * - the per-row edit/open-close/delete controls, the delete confirm dialog
 *   and the New Project button are unrendered (their routes are the write
 *   group's, unclaimed — the milestone-edit precedent of rendering no dead
 *   controls);
 * - the `.list-header` search box (`q`) and sort dropdown are unrendered:
 *   no landed keyword/sort support over the scope (listProjects orders
 *   `id DESC` only) — the org-home search-facet reduction; upstream's sort
 *   types (GetSearchOrderByBySortType, project.go:242-257: oldest /
 *   alphabetically / reversealphabetically / recentupdate / leastupdate,
 *   default created_unix DESC) would all need service arms we do not have;
 *   the landed `id DESC` order coincides with the newest-first default for
 *   monotonic ids and is the landed service order rule (§3.2). The silent
 *   `?q=`/`?sort=` queries are read and ignored.
 *
 * ## Visibility (the group's exact gates, reduced to the landed predicates)
 *
 * The route group hangs `reqAnyRepoUnitAccess(TypeProjects, read, true)` +
 * `individualPermsChecker` (web.go:444-455, 945-959) off
 * `UserAssignmentWeb` + `OrgAssignment`:
 * - an ORG owner: `resolveOrgHome` first (the orgAssignment +
 *   HasOrgOrUserVisible seam — renamed orgs 307, invisible orgs 404-shell,
 *   exactly the /-/repositories family), THEN
 *   `Organization.AnyRepoUnitPermission(TypeProjects) >= read`
 *   (org.go:278-302) — the landed `orgProjectsAccessMode` verbatim, else
 *   the NotFound;
 * - an INDIVIDUAL owner: `resolveUserProfile` (the userAssignment +
 *   RedirectToUser + IsUserVisibleToViewer seam), THEN the stricter
 *   `individualPermsChecker` ladder on top — private users answer their
 *   `/-/projects` to SELF OR SITE ADMIN ONLY (no follower/co-member arm —
 *   the projects/packages/code family is deliberately tighter than the
 *   profile), limited users to any signed-in viewer, public users to
 *   everyone. A follower of a private user therefore 404-shells here where
 *   the profile page renders — upstream's own divergence between the two
 *   gates, kept verbatim;
 * - another user's/open org's projects LIST to anyone passing those gates
 *   (the read group has no per-project filter) — the rows' ISSUE counts are
 *   the visibility matrix: `LoadIssueNumbersForProject`'s owner branch
 *   (services/projects/issue.go:298-330) filters through
 *   `IssuesOptions.Doer` / `AllPublic` — the landed
 *   `projectIssueCountsForOrg` + `userVisibleRepos`
 *   (canViewRepositoryWithTeams) pair the routes/projects-user.ts list arm
 *   already serves. `canWriteProjects` (projects.go:121-124): an org gates
 *   on `CanWriteAnyRepoUnit(TypeProjects)` (orgProjectsAccessMode >=
 *   write), a user on doer == owner.
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The board drill-down (`/{id}`) is a follow-up row — titles are plain
 *   text, no dead links (the slice note above).
 * - The write group's controls (New Project button, per-row
 *   edit/open-close/delete, the delete confirm dialog) are unrendered —
 *   unclaimed routes (the slice note).
 * - The search box + sort dropdown are unrendered; `?q=`/`?sort=` are
 *   silently ignored (the slice note).
 * - The numbered pager (base/paginate.tmpl) reduces to the Older/Newer
 *   pair (the org-home/issues-list convention) carrying `?page=` plus the
 *   active `state`.
 * - Row descriptions render through the SHARED markdown service in its
 *   context-less "markdown" mode — upstream's
 *   `renderUtils.MarkdownToHtml(project.Description)` (projects.go:106-108)
 *   is the same repo-context-free render; ours escapes raw HTML
 *   (SPEC-0008 §3.4's documented sanitizer divergence).
 * - The user arm's overview menu (user/overview/header.tmpl) renders the
 *   two live tabs (Repositories + the active Projects) — Overview needs a
 *   profile-readme pipeline, Packages/Code/Activity/Stars their pages
 *   (dead links forbidden, §2.4.1); the Repositories tab anchors
 *   `/{username}` (the landed profile page, the user-profile menu
 *   convention — upstream's `?tab=repositories` is a no-op here). Tab
 *   count labels ride `loadHeaderCount`'s data (header.go:165-193):
 *   RepoCount = the doer-visible repository total (the profile loader's
 *   WHERE), ProjectCount = the OPEN projects total.
 * - The org arm's menu renders the Repositories + Projects tabs —
 *   OrgMenu's additive projectsTab extension (org-home.tsx, disclosed);
 *   Members/Teams/Settings stay OrgMenu's own reduction (not this row's
 *   diff).
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { listFollowers, listFollowing } from "../../api/services/follows";
import { renderMarkdownToHtml } from "../../api/services/markdown";
import {
  listProjects,
  orgAccessAtLeast,
  orgProjectScope,
  orgProjectsAccessMode,
  projectIssueCountsForOrg,
  userProjectScope,
  userVisibleRepos,
  type ProjectRow,
} from "../../api/services/projects";
import type { User } from "../../api/models/user";
import type { RepositoryWithOwner, Viewer as ApiViewer } from "../../api/services/repository";
import { repositories } from "../../db/schema";
import { type OrgRecord } from "../../services/orgs/orgs";
import { BaseLayout, Icon, renderPage } from "../shell";
import { parsePageNumber } from "../page-data";
import { prettyNumber } from "./releases";
import { OrgHeader, OrgMenu, resolveOrgHome } from "./org-home";
import {
  ProfileAvatarCard,
  resolveUserProfile,
  type ProfileDoer,
  type UserProfileRow,
} from "./user-profile";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";

/** Page chrome text (component-local, the orgHomeLocale pattern — locale.ts
 *  is shared and not this wave's file; upstream locale keys cited). */
export const ownerProjectsLocale = {
  projects: "Projects", // "user.projects" / "repo.projects"
  open_title: "Open", // "repo.issues.open_title"
  closed_title: "Closed", // "repo.issues.closed_title"
  empty: "No projects yet.", // "repo.projects.empty"
  empty_description: "Create a project to coordinate issues and pull requests.", // "repo.projects.empty_description"
  no_results: "No projects match your search.", // "repo.projects.no_results"
} as const;

/** Upstream `setting.UI.IssuePagingNum` (modules/setting/ui.go:89) — the
 *  projects list pager's page size (org.Projects reads it directly). */
export const OWNER_PROJECTS_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Resolution — the handler-side seam (index.ts calls these; kept here so the
// page module owns its data path, the org-home/user-profile pattern)
// ---------------------------------------------------------------------------

/** The resolution outcome for `/{username}/-/projects` — the OWNER
 *  (user-or-org) union the upstream handler branches on
 *  (`ctx.ContextUser.IsOrganization()`), plus the shared redirect/miss
 *  arms. */
export type OwnerProjectsResolution =
  | { kind: "org"; org: OrgRecord }
  | { kind: "user"; user: UserProfileRow }
  | { kind: "redirect"; location: string }
  | { kind: "missing" };

/**
 * Resolve the owner for the projects page: the ORG half first (upstream
 * OrgAssignment's arm — `resolveOrgHome`, so renamed orgs 307 and invisible
 * orgs 404-shell), gated by `orgProjectsAccessMode >= read` (web.go:444-455
 * reqAnyRepoUnitAccess's org arm — AnyRepoUnitPermission(TypeProjects) <
 * read is the NotFound); then the USER half (`resolveUserProfile` — the
 * userAssignment + RedirectToUser seam), gated by the
 * `individualPermsChecker` ladder (web.go:945-959: private → self or site
 * admin ONLY, limited → any signed-in viewer) which is deliberately
 * TIGHTER than the profile visibility the user half already passed — the
 * follower of a private user 404-shells exactly like upstream. A name
 * resolving to neither is a miss.
 */
export async function resolveOwnerProjects(
  d1: D1Database,
  owner: string,
  doer: ProfileDoer,
  requestPath: string,
  requestQuery: string,
): Promise<OwnerProjectsResolution> {
  const org = await resolveOrgHome(d1, owner, doer, requestPath, requestQuery);
  if (org.kind === "redirect") return org;
  if (org.kind === "org") {
    const access = await orgProjectsAccessMode(d1, org.org, doer.id);
    if (!orgAccessAtLeast(access, "read")) return { kind: "missing" };
    return org;
  }
  const profile = await resolveUserProfile(d1, owner, doer, requestPath, requestQuery);
  if (profile.kind === "redirect") return profile;
  if (profile.kind === "missing") return { kind: "missing" };
  // individualPermsChecker (web.go:945-959) — "public" answers to everyone,
  // "limited" needs any doer, "private" needs self or site admin.
  const user = profile.user;
  switch (user.visibility) {
    case "public":
      break;
    case "limited":
      if (doer.id === null) return { kind: "missing" };
      break;
    case "private":
      if (doer.id === null || (doer.id !== user.id && !doer.isAdmin)) return { kind: "missing" };
      break;
  }
  return { kind: "user", user };
}

// ---------------------------------------------------------------------------
// Data loading (§3.2 — the landed projects arms)
// ---------------------------------------------------------------------------

/** One rendered row: the project row plus the doer-visibility-filtered
 *  issue counts (the owner branch's numbers, never the plain counts). */
export interface OwnerProjectsItem {
  project: ProjectRow;
  counts: { open: number; closed: number; total: number };
}

/** The list page's render inputs (both chrome arms share the list half). */
export interface OwnerProjectsData {
  owner: { kind: "org"; org: OrgRecord } | { kind: "user"; user: UserProfileRow };
  items: OwnerProjectsItem[];
  /** The active facet — the web handler's binary reading (no "all"). */
  state: "open" | "closed";
  page: number;
  /** The ACTIVE state's total (upstream `total` — the pager's TotalCount). */
  total: number;
  more: boolean;
  /** The unconditional facet totals — OpenCount/ClosedCount (the toggle,
   *  the empty-arm decision) and the menu tab's open-projects count. */
  openTotal: number;
  closedTotal: number;
  /** The writer grant behind the toggle block (upstream canWriteProjects —
   *  projects.go:121-124). NO write control rides it in this slice; the
   *  toggle is the block's one live child. */
  canWrite: boolean;
  /** The menu tab counts (loadHeaderCount, header.go:165-193). */
  repoCount: number;
  /** The user arm's avatar-card counts (profile_big_avatar.tmpl). */
  followers: number;
  following: number;
}

/**
 * The web handler's exact facet reading (projects.go:45): `state ==
 * "closed"` after trim+lowercase — everything else (absent, "open", "all",
 * junk) is the OPEN arm. NOT the API's ParseIssueFilterStateIsClosed (that
 * one maps "all" to both — the web page has no all facet).
 */
export function parseOwnerProjectsState(params: URLSearchParams): "open" | "closed" {
  const raw = params.get("state");
  return raw !== null && raw.trim().toLowerCase() === "closed" ? "closed" : "open";
}

/**
 * The api `Viewer` projection of the session viewer — the three fields the
 * visibility path reads (repo-grants.ts's sessionApiUser shape; the wire
 * type's remaining fields are optional and unread).
 */
function projectsApiUser(viewer: Viewer): User | null {
  return viewer.kind === "user" ? { id: viewer.id, login: viewer.username, is_admin: viewer.isAdmin } : null;
}

/**
 * The doer-visible repositories OWNED by the scope owner (the counts'
 * visibility set — `userVisibleRepos` is owner-kind-agnostic upstream too,
 * shared/project.go:1685-1692 sets IssuesOptions.Owner whatever the owner
 * kind; the service doc cites services/projects/issue.go:298-308).
 */
async function ownerVisibleRepoIds(
  d1: D1Database,
  ownerId: number,
  viewer: Viewer,
  origin: string,
): Promise<string[]> {
  const apiViewer: ApiViewer = { origin, requester: projectsApiUser(viewer) };
  const visible: RepositoryWithOwner[] = await userVisibleRepos(d1, ownerId, apiViewer);
  return visible.map((pair) => pair.repo.id);
}

/**
 * Load the page (§3.2 — the landed service arms, never a self-fetch): the
 * scope-filtered active-state page, the opposite state's count (the
 * handler's second Count, projects.go:79-90), the per-row filtered counts
 * over ONE visibility-set walk, the writer grant, and the menu/avatar
 * counts.
 */
export async function loadOwnerProjectsData(
  d1: D1Database,
  owner: Extract<OwnerProjectsResolution, { kind: "org" | "user" }>,
  viewer: Viewer,
  origin: string,
  params: URLSearchParams,
): Promise<OwnerProjectsData> {
  const state = parseOwnerProjectsState(params);
  const isShowClosed = state === "closed";
  const page = parsePageNumber(params.get("page"));
  const doer: ProfileDoer =
    viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };

  const scope = owner.kind === "org" ? orgProjectScope(owner.org.id) : userProjectScope(owner.user.id);
  const ownerId = owner.kind === "org" ? owner.org.id : owner.user.id;

  // The handler's FindAndCount (active facet) + Count (opposite facet):
  // OpenCount/ClosedCount always carry their own state's total whichever
  // facet is active (projects.go:92-96).
  const [active, opposite] = await Promise.all([
    listProjects(d1, scope, isShowClosed, page, OWNER_PROJECTS_PAGE_SIZE),
    listProjects(d1, scope, !isShowClosed, 1, 1),
  ]);
  const openTotal = isShowClosed ? opposite.total : active.total;
  const closedTotal = isShowClosed ? active.total : opposite.total;

  // The counts' visibility set: ONE walk of the owner's repositories through
  // the landed visibility predicate, then a filtered count query per row
  // (the routes/projects-user.ts list arm's exact composition).
  const visibleRepoIds = await ownerVisibleRepoIds(d1, ownerId, viewer, origin);
  const items: OwnerProjectsItem[] = [];
  for (const project of active.items) {
    items.push({ project, counts: await projectIssueCountsForOrg(d1, project.id, visibleRepoIds) });
  }

  // canWriteProjects (projects.go:121-124): org → CanWriteAnyRepoUnit — the
  // landed orgProjectsAccessMode >= write; user → doer == owner.
  let canWrite: boolean;
  if (owner.kind === "org") {
    const access = await orgProjectsAccessMode(d1, owner.org, doer.id);
    canWrite = orgAccessAtLeast(access, "write");
  } else {
    canWrite = doer.id !== null && doer.id === owner.user.id;
  }

  // loadHeaderCount (header.go:165-176)'s RepoCount arm: the doer-visible
  // repository total — the profile loader's WHERE (self/admin sees private
  // rows, everyone else public).
  const seePrivateRepos = doer.id !== null && (doer.isAdmin || doer.id === ownerId);
  const repoWhere = seePrivateRepos
    ? eq(repositories.ownerId, ownerId)
    : and(eq(repositories.ownerId, ownerId), eq(repositories.visibility, "public"));
  const repoCountRow = await drizzle(d1)
    .select({ total: sql<number>`count(*)` })
    .from(repositories)
    .where(repoWhere)
    .get();

  // The user arm's avatar-card counts (the profile loader's pair, count-only
  // pages — the numbers are real).
  let followers = 0;
  let following = 0;
  if (owner.kind === "user") {
    const followViewer = { id: doer.id, isAdmin: doer.isAdmin };
    const [followerPage, followingPage] = await Promise.all([
      listFollowers(d1, owner.user.id, followViewer, { page: 1, pageSize: 1 }),
      listFollowing(d1, owner.user.id, followViewer, { page: 1, pageSize: 1 }),
    ]);
    followers = followerPage.total;
    following = followingPage.total;
  }

  return {
    owner,
    items,
    state,
    page,
    total: active.total,
    more: page * OWNER_PROJECTS_PAGE_SIZE < active.total,
    openTotal,
    closedTotal,
    canWrite,
    repoCount: Number(repoCountRow?.total ?? 0),
    followers,
    following,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The writer-only state toggle (projects/list.tmpl's
 *  `.list-header-toggle` block) — the New Project button that shares its
 *  `.flex-left-right` row is NOT rendered (the /new route is the write
 *  group's, unclaimed). Links are pure queries (upstream's `?state=open&q=`
 *  shapes minus the unrendered keyword). */
export function ProjectStateToggle(props: {
  basePath: string;
  state: "open" | "closed";
  openTotal: number;
  closedTotal: number;
}) {
  return (
    <div class="flex-left-right tw-mb-4">
      <div class="small-menu-items ui compact tiny menu list-header-toggle">
        <a class={props.state === "open" ? "active item" : "item"} href={`${props.basePath}?state=open`}>
          <Icon name="octicon-project-symlink" size={16} class="tw-mr-2" />
          {prettyNumber(props.openTotal)} {ownerProjectsLocale.open_title}
        </a>
        <a class={props.state === "closed" ? "active item" : "item"} href={`${props.basePath}?state=closed`}>
          <Icon name="octicon-check" size={16} class="tw-mr-2" />
          {prettyNumber(props.closedTotal)} {ownerProjectsLocale.closed_title}
        </a>
      </div>
    </div>
  );
}

/** One projects/list.tmpl `.item` row: the owner-project glyph + title (a
 *  plain-text span — the `/{id}` board anchor is the follow-up row's), the
 *  open/closed counts (the visibility-filtered numbers), the writer
 *  controls NOT rendered, and the markdown description (the handler's
 *  MarkdownToHtml render, projects.go:106-108 — context-less, origin
 *  irrelevant with no links to rewrite). */
export function ProjectListItem(props: { item: OwnerProjectsItem }) {
  const { project, counts } = props.item;
  const descriptionHtml =
    project.description !== ""
      ? renderMarkdownToHtml({ text: project.description, mode: "markdown", context: "", wiki: false, origin: "" })
      : "";
  return (
    <div class="item flex-relaxed-list">
      <span class="list-item-large-title">
        <Icon name="octicon-project-symlink" size={16} /> <span class="muted">{project.title}</span>
      </span>
      <div class="list-item-secondary-bar">
        <div class="flex-text-block tw-flex-wrap">
          <div class="flex-text-inline">
            <Icon name="octicon-issue-opened" size={14} /> {prettyNumber(counts.open)}{" "}
            {ownerProjectsLocale.open_title}
          </div>
          <div class="flex-text-inline">
            <Icon name="octicon-check" size={14} /> {prettyNumber(counts.closed)}{" "}
            {ownerProjectsLocale.closed_title}
          </div>
        </div>
      </div>
      {descriptionHtml !== "" ? (
        <div class="render-content markup" dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
      ) : null}
    </div>
  );
}

/** The pager — base/paginate.tmpl reduced to the Older/Newer pair (the
 *  org-home convention), carrying `?page=` plus the active state facet. */
function ProjectsPager(props: { basePath: string; data: OwnerProjectsData }) {
  const { data } = props;
  const href = (page: number): string =>
    data.state === "open" ? `${props.basePath}?page=${page}` : `${props.basePath}?state=closed&page=${page}`;
  if (data.page <= 1 && !data.more) return null;
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {data.page > 1 ? (
          <a class="item navigation" href={data.page > 2 ? href(data.page - 1) : props.basePath}>
            <span class="navigation_label">Newer</span>
          </a>
        ) : null}
        {data.more ? (
          <a class="item navigation" href={href(data.page + 1)}>
            <span class="navigation_label">Older</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The list half both chrome arms share (projects/list.tmpl): the
 *  writer-only toggle, the rows, the two empty arms (`{{if and (eq
 *  .OpenCount 0) (eq .ClosedCount 0)}}` — no projects at all vs the
 *  filtered-to-nothing arm) and the pager. The `.list-header` search/sort
 *  block is unrendered (the module header's reduction note). */
export function ProjectsListBlock(props: { basePath: string; data: OwnerProjectsData }) {
  const { data } = props;
  return (
    <>
      {data.canWrite ? (
        <ProjectStateToggle
          basePath={props.basePath}
          state={data.state}
          openTotal={data.openTotal}
          closedTotal={data.closedTotal}
        />
      ) : null}
      {data.items.length > 0 ? (
        <>
          <div class="flex-divided-list milestone-list">
            {data.items.map((item) => (
              <ProjectListItem item={item} />
            ))}
          </div>
          <ProjectsPager basePath={props.basePath} data={data} />
        </>
      ) : data.openTotal === 0 && data.closedTotal === 0 ? (
        <div class="empty-placeholder">
          <Icon name="octicon-project-symlink" size={48} />
          <h2>{ownerProjectsLocale.empty}</h2>
          <p>{ownerProjectsLocale.empty_description}</p>
        </div>
      ) : (
        <div class="empty-placeholder">
          <Icon name="octicon-search" size={48} />
          <h2>{ownerProjectsLocale.no_results}</h2>
        </div>
      )}
    </>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderOwnerProjectsPage(ctx: UiContext, data: OwnerProjectsData): string {
  return renderPage(<OwnerProjectsPage ctx={ctx} data={data} />);
}

/** The page (org/projects/list.tmpl's two chrome arms over the shared
 *  list). */
export function OwnerProjectsPage(props: { ctx: UiContext; data: OwnerProjectsData }) {
  const { ctx, data } = props;
  const ownerName = data.owner.kind === "org" ? data.owner.org.username : data.owner.user.username;
  const basePath = `/${ownerName}/-/projects`;
  if (data.owner.kind === "org") {
    // The ORG arm: org/header (the landed OrgHeader; org/header.tmpl:38's
    // trailing org/menu include is the OrgMenu strip) + the list inside the
    // upstream container.
    return (
      <BaseLayout ctx={ctx} title={ownerProjectsLocale.projects} pageClass="organization projects">
        <OrgHeader org={data.owner.org} signedIn={ctx.viewer.kind === "user"} />
        <OrgMenu
          orgLink={`/${ownerName}`}
          repoCount={data.repoCount}
          projectsTab={{ active: true, count: data.openTotal, href: basePath }}
        />
        <div class="ui container">
          <ProjectsListBlock basePath={basePath} data={data} />
        </div>
      </BaseLayout>
    );
  }
  // The USER arm: the profile grid — four-wide avatar column + twelve-wide
  // column carrying the overview header menu + the list (profile.tmpl's
  // projects shape, shared/user/profile_big_avatar + user/overview/header).
  return (
    <BaseLayout ctx={ctx} title={ownerProjectsLocale.projects} pageClass="user profile">
      <div class="ui container">
        <div class="ui stackable grid">
          <div class="ui four wide column">
            <ProfileAvatarCard user={data.owner.user} followers={data.followers} following={data.following} />
          </div>
          <div class="ui twelve wide column tw-mb-4">
            <OrgMenu
              orgLink={`/${ownerName}`}
              repoCount={data.repoCount}
              projectsTab={{ active: true, count: data.openTotal, href: basePath }}
            />
            <ProjectsListBlock basePath={basePath} data={data} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

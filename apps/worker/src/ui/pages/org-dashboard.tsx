/**
 * The org dashboard, `/org/{org}/dashboard[/{team}]` — the census R06 row
 * (upstream web.go:982-985 → `user.Dashboard`,
 * routers/web/user/home.go:77-136, under
 * `context.OrgAssignment{RequireMember: true, RequireTeamMember: true}`):
 * upstream's dashboard page rendered over the org — the org's activity feed
 * (the org-receiver rows of the `action` table, `OnlyPerformedBy=false`),
 * the optional `/{team}` variant filtering through the team's repo set
 * (`RequestedTeam` → `repo_id IN teamRepoIDs`, action.go:532-540), the
 * context-user switcher + team-filter navbar (user/dashboard/navbar.tmpl)
 * and the dashboard repo list over the ORG's repositories
 * (dashboardRepoList.uid = the org's id, home.go:104-109).
 *
 * ## The member-only posture (the census's Open Issues #9)
 *
 * Upstream answers NOT FOUND for every non-member — anonymous viewers
 * included (the group is NOT reqSignIn'd, so RequireMember 404s before any
 * login redirect; services/context/org.go:146-149). This module keeps that
 * posture exactly: anonymous AND signed-in non-members 404-shell
 * (indistinguishable from a missing org), org members/owners and site
 * admins render. The `/{team}` tail adds upstream's RequireTeamMember:
 * owner/site-admin pass (org.go:114-125 sets IsTeamMember for both), a
 * plain member needs the team_members row (org.go:226-236), and an unknown
 * team name 404-shells (org.go:214-218's teamExists miss).
 *
 * ## DOM contract (user/dashboard/{dashboard,navbar,feeds,guide}.tmpl +
 *  DashboardRepoList.vue at the pin)
 *
 * `.page-content.dashboard.feeds` (dashboard.tmpl:2) → navbar.tmpl reduced
 * to its SSR-renderable arms: the context-user switcher dropdown (self item
 * → `/`, one item per viewer membership → `/org/{name}/dashboard`, the
 * CanCreateOrganization New-Organization item → `/org/create`), the org
 * arm's team-filter dropdown ("All" + every visible non-includes-all team →
 * `/org/{org}/dashboard/{name}`), and the right menu's Activities item
 * (ACTIVE — `PageIsNews`) + the "View {org}" button. The dropdowns follow
 * the branch-selector's generic `.ui.dropdown` shape (the official bundle's
 * Fomantic enhances it client-side; the caret glyphs —
 * octicon-triangle-down/octicon-people — are not in the landed icon
 * allowlist, so they render text-only). Then dashboard.tmpl's
 * `flex-container` split: `.flex-container-main` carries the feeds
 * (feeds.tmpl's rows through the LANDED activity-feeds rendering —
 * pages/activity-feeds.tsx's exported item matrix) or guide.tmpl's
 * "No Activity" box when the feed is empty (upstream's
 * `{{if .Page.Paginator.TotalPages}}` arm — an empty feed renders the guide,
 * upstream-exact), and `#dashboard-repo-list.flex-container-sidebar` carries
 * the org's doer-accessible repositories (DashboardRepoList.vue reduced:
 * the "Repositories" header with the count label + the New-Repository `+`
 * link → `/repo/create?org={id}`, the shared shared/repo/list.tmpl row, the
 * widget's empty arm).
 *
 * ## The team arm's feed read (the module-private predicate re-issue)
 *
 * The plain arm rides the landed service read exactly
 * (`getFeedRows{kind:"org", requested:org.id, includePrivate:true,
 * onlyPerformedBy:false}` — member-only implies upstream's IncludePrivate).
 * The team arm adds upstream's `RequestedTeam` repo-set filter
 * (action.go:532-540), which the service's `FeedQueryOptions` does not
 * carry; the service's org-arm predicates are module-private (activity-
 * feeds.ts `feedCondition`/`actUserCond`/`repoAccessCond`), so — the
 * pages/dashboard.tsx precedent verbatim ("that query's functions are
 * module-private to the route file, so the dashboard re-issues its
 * predicate set here") — `teamFeedRows` re-issues them for this page's
 * fixed posture (is_deleted ∧ user_id = org.id ∧ the act-user visibility
 * triple with the requested-org branch ∧ the repo-accessibility union,
 * skipped for site admins per upstream's DoerIsSiteAdminFullAccess arm)
 * plus the team repo set (includes-all → every org repo, the landed
 * listTeamRepoPairs coverage union; else the team_repo_access rows).
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The heatmap (`{{template "user/heatmap"}}`, dashboard.tmpl:7) is not
 *   rendered — R03's widget arm is a separate census row; upstream renders
 *   the identical feed-only page when `EnableUserHeatmap=false` (the
 *   census's sanctioned degradation).
 * - The right menu's Issues/Pulls/Milestones tabs are not rendered — R07's
 *   org overview pages are separate census rows (dead links forbidden,
 *   §2.4.1). Activities renders active.
 * - The team dropdown links the team DISPLAY name (upstream
 *   `href="…/dashboard/{{.Name}}"`); resolution is the case-folded lower
 *   name (org.go:213-218), so an odd-case link still resolves.
 * - The repolist widget's search/filter/paging chrome (RepoList.vue's
 *   widget) reduces to the one page of 15 (`setting.UI.User.RepoPagingNum`,
 *   the user dashboard's cap); the org context renders no create-org `+`
 *   (upstream's widget hides the organizations tab for a uid that is an
 *   org) and the New-Repository `+` keeps upstream's
 *   `/repo/create?org={id}` target (the landed creation page answers it).
 * - The switcher avatar slots render the placeholder octicons (the
 *   avatar-slot rule; no avatar pipeline).
 */

import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  feedIssueTitles,
  getFeedRows,
  renderFeedItems,
  type ActionRow,
  type Activity,
} from "../../api/services/activity-feeds";
import { resolveOrgForRequest, type ResolvedOrg } from "../../api/services/orgs";
import { listOrgRepositories } from "../../api/services/org-repos";
import { TeamsService, type TeamRecord } from "../../api/routes/org-teams";
import type { Viewer as ApiViewer } from "../../api/services/repository";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import {
  actions,
  repoCollaborators,
  repoSettings,
  repositories,
  teamMembers,
  teamRepoAccess,
  teams,
  users,
} from "../../db/schema";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import {
  ActivityFeedList,
  ellipsisDisplay,
  feedBody,
  feedIconName,
  feedMessageSegments,
  issueIndexOf,
  type ActivityFeedItem,
  type ActivityFeedItemFields,
} from "./activity-feeds";
import { orgDisplayName, OrgRepoListItem, type OrgHomeRepoItem } from "./org-home";

/** Page chrome text (component-local, the orgHomeLocale pattern — locale.ts
 *  is shared and not this wave's file; upstream locale keys cited). */
export const orgDashboardLocale = {
  dashboard: "Dashboard", // "dashboard"
  switch_dashboard_context: "Switch Dashboard Context", // "home.switch_dashboard_context"
  filter_by_team: "Filter by team repositories", // "home.filter_by_team_repositories"
  teams: "Teams", // "org.teams" (the team dropdown's collapsed text)
  all: "All", // "all"
  activities: "Activities", // "activities"
  view_home: "View", // "home.view_home" — the %s name rides beside it
  new_org: "New Organization", // "new_org"
  my_repos: "Repositories", // "home.my_repos" (the widget header)
  new_repo: "New Repository", // "new_repo" (the widget header's + link)
  repos_empty: "There are no repositories yet.", // "home.empty_repo"
  guide_title: "No Activity", // "home.guide_title"
  guide_desc:
    "You are currently not following any repositories or users, so there is no content to display. You can explore repositories or users of interest from the links below.", // "home.guide_desc"
  guide_explore_repos: "Explore repositories", // "home.explore_repos"
  guide_explore_users: "Explore users", // "home.explore_users"
  visibility_limited: "Limited", // "org.settings.visibility.limited_shortname"
  visibility_private: "Private", // "org.settings.visibility.private_shortname"
  newer: "Newer", // the base/paginate reduction's navigation_label
  older: "Older",
} as const;

/** Upstream `setting.UI.FeedPagingNum` (modules/setting/ui.go:93) — the
 *  dashboard feed's page size (home.go:115 reads it). */
export const ORG_DASHBOARD_FEED_PAGE_SIZE = 20;

/** Upstream `setting.UI.User.RepoPagingNum` (modules/setting/ui.go:147) —
 *  the dashboard repo list's one-page cap (home.go:105's searchLimit). */
export const ORG_DASHBOARD_REPO_LIMIT = 15;

// ---------------------------------------------------------------------------
// Resolution + gates — the handler-side seam (index.ts calls these; the
// org-teams module pattern)
// ---------------------------------------------------------------------------

/** The resolution outcome for the `/{org}` segment: the resolved org, a
 *  rename redirect, or a miss (→ 404 shell). */
export type OrgDashboardResolution =
  | { kind: "org"; org: OrgRecord }
  | { kind: "redirect"; location: string }
  | { kind: "missing" };

/**
 * Resolve the org: `resolveOrgForRequest` (the orgAssignment + RedirectToUser
 * seam — non-org rows are misses, renamed orgs 307 behind the seam's coarse
 * gate). No separate visibility ladder: upstream's visibility check
 * (org.go:103-107) only tightens to the membership the dashboard's
 * RequireMember gate already demands, so the gate below subsumes it.
 */
export async function resolveOrgDashboardOrg(
  d1: D1Database,
  owner: string,
  doer: { id: number | null; isAdmin: boolean },
  requestPath: string,
  requestQuery: string,
): Promise<OrgDashboardResolution> {
  const resolved: ResolvedOrg = await resolveOrgForRequest(d1, owner, doer, requestPath, requestQuery);
  if (resolved.kind !== "org") {
    return resolved.kind === "redirect" ? resolved : { kind: "missing" };
  }
  return { kind: "org", org: resolved.org };
}

/**
 * RequireMember (services/context/org.go:146-149): a site admin (the
 * OrgAssignment super-access arm, org.go:119-125) or an `org_members` row.
 * Anonymous viewers fail — upstream 404s them, it does not redirect to
 * login (the group is not reqSignIn'd).
 */
export async function isOrgDashboardMember(d1: D1Database, org: OrgRecord, viewer: Viewer): Promise<boolean> {
  if (viewer.kind !== "user") return false;
  if (viewer.isAdmin) return true;
  return (await new OrgService(d1).getMembership(org.id, viewer.id)) !== null;
}

/**
 * RequireTeamMember (org.go:226-236): site admin/org owner pass (org.go's
 * IsTeamMember pre-set), a plain member needs the `team_members` row. The
 * loader runs this only for a RESOLVED team (an unknown name shells first —
 * org.go's teamExists miss).
 */
export async function isOrgDashboardTeamMember(
  d1: D1Database,
  org: OrgRecord,
  team: TeamRecord,
  viewer: Viewer,
): Promise<boolean> {
  if (viewer.kind !== "user") return false;
  if (viewer.isAdmin) return true;
  const orgs = new OrgService(d1);
  if (await orgs.isOrgOwner(org.id, viewer.id)) return true;
  return new TeamsService(d1).isTeamMember(team.id, viewer.id);
}

/**
 * The `/{team}` tail's resolution — the case-folded lower-name lookup
 * scoped to the org (org.go:213-218's EqualFold walk over the team set; our
 * `teams.lowerName` is UNIQUE per org, so one query answers it). `null` is
 * the 404-shell miss.
 */
export async function resolveDashboardTeam(
  d1: D1Database,
  org: OrgRecord,
  teamName: string,
): Promise<TeamRecord | null> {
  return new TeamsService(d1).getTeamByName(org.id, teamName);
}

// ---------------------------------------------------------------------------
// The team arm's feed read — the module-private predicate re-issue (the
// pages/dashboard.tsx precedent; see the module header)
// ---------------------------------------------------------------------------

/** FeedDateCond (action.go:445-461) — activity-feeds.ts `dateCond`
 *  verbatim: `[date 00:00:00, date 23:59:59]` UTC; unparsable input skips
 *  the filter. */
function dashboardDateCond(date: string): SQL | undefined {
  if (date === "") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return undefined;
  const low = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000;
  const high = low + 86_399;
  return and(gte(actions.createdAt, new Date(low * 1000)), lte(actions.createdAt, new Date(high * 1000)));
}

/**
 * One page of the TEAM-filtered org feed: the service's org-arm predicate
 * set re-issued verbatim (activity-feeds.ts `feedCondition`'s kind=org
 * shape — is_deleted ∧ user_id = requested ∧ actUserCond ∧ repoAccessCond —
 * with the self/admin fast path kept: a site admin skips the visibility
 * pair, action.go:465-472/498-501's DoerIsSiteAdminFullAccess arms) plus
 * upstream's RequestedTeam filter (action.go:532-540): repo_id IN the
 * team's covered set (includes-all → every org repo — the landed
 * listTeamRepoPairs coverage union; else the team_repo_access rows).
 */
async function teamFeedRows(
  d1: D1Database,
  org: OrgRecord,
  team: TeamRecord,
  viewer: { id: number; isAdmin: boolean },
  date: string,
  page: number,
  limit: number,
): Promise<{ total: number; rows: ActionRow[] }> {
  const db = drizzle(d1);
  const teamRepoCond =
    team.includesAllRepositories === true
      ? sql`${actions.repoId} IN (SELECT id FROM ${repositories} WHERE owner_id = ${org.id})`
      : sql`${actions.repoId} IN (SELECT repo_id FROM ${teamRepoAccess} WHERE team_id = ${team.id})`;
  const parts: SQL[] = [eq(actions.isDeleted, false), eq(actions.userId, org.id), teamRepoCond];
  if (!viewer.isAdmin) {
    // actUserCond's kind=org shape (activity-feeds.ts:284-309; the
    // public+limited ∪ actor ∪ requested-org triple).
    parts.push(
      sql`(${actions.actUserId} IN (SELECT id FROM ${users} WHERE visibility IN ('public', 'limited')) OR ${actions.actUserId} = ${viewer.id} OR ${actions.actUserId} = ${org.id})`,
    );
    // repoAccessCond (activity-feeds.ts:317-331; the actor-owned arm rides
    // along for verbatim fidelity — an org-owned repo is never actor-owned).
    parts.push(
      sql`${actions.repoId} IN (
        SELECT id FROM ${repositories} WHERE visibility = 'public'
        UNION SELECT id FROM ${repositories} WHERE owner_id = ${viewer.id}
        UNION SELECT repo_id FROM ${repoCollaborators} WHERE user_id = ${viewer.id}
        UNION SELECT tra.repo_id FROM ${teamMembers} tm
          JOIN ${teamRepoAccess} tra ON tra.team_id = tm.team_id
          WHERE tm.user_id = ${viewer.id}
      )`,
    );
  }
  const dateCond = dashboardDateCond(date);
  if (dateCond !== undefined) parts.push(dateCond);
  const condition = and(...parts);
  const rows = await db
    .select()
    .from(actions)
    .where(condition)
    .orderBy(desc(actions.createdAt), desc(actions.id))
    .limit(limit)
    .offset((page - 1) * limit)
    .all();
  const totals = await db.select({ count: sql<number>`count(*)` }).from(actions).where(condition).all();
  return { total: Number(totals[0]?.count ?? 0), rows };
}

// ---------------------------------------------------------------------------
// Data loading (§3.2 — the landed service arms, never a self-fetch)
// ---------------------------------------------------------------------------

/** The page's render inputs. */
export interface OrgDashboardData {
  org: OrgRecord;
  /** The resolved `/{team}` carrier; null = the all-teams arm. */
  team: TeamRecord | null;
  items: ActivityFeedItem[];
  page: number;
  /** The unpaginated feed total (getFeedRows' count / the team arm's
   *  count — upstream skips the count for the plain no-date arm
   *  (feed.go:22 DontCount) and pages on; the landed Older/Newer pager
   *  needs it, the count query is the landed shape). */
  total: number;
  more: boolean;
  /** The `?date=YYYY-MM-DD` passthrough (unparsable never reaches the
   *  query — FeedDateCond's warn-and-continue). */
  date: string;
  /** The team dropdown's visible teams (owner/admin: all; member:
   *  public/limited + own — org.go:186-204's SearchTeam arms). Render
   *  excludes the includes-all teams (navbar.tmpl:67). */
  teams: TeamRecord[];
  /** The sidebar repo rows + descriptions (the doer-accessible page —
   *  the landed §4.7 listing). */
  repos: OrgHomeRepoItem[];
  repoTotal: number;
  /** The context switcher's org rows (the viewer's memberships,
   *  GetUserOrgsList — home.go:89's Orgs data). */
  orgs: Array<{ username: string; visibility: "public" | "limited" | "private" }>;
}

/** The api `Viewer` projection of the session viewer (the activity-feeds
 *  loader's feedsApiUser shape — three fields, the rest optional). */
function dashboardApiUser(viewer: Viewer, origin: string): ApiViewer {
  return {
    origin,
    requester:
      viewer.kind === "user" ? { id: viewer.id, login: viewer.username, is_admin: viewer.isAdmin } : null,
  };
}

/**
 * The feed page → the render-item projection. The activity-feeds loader's
 * shape verbatim (loadActivityFeedsData's mapping half — the TEXT-repo-id
 * coordinate join for the issue-title arms, then the per-item projection
 * over the module's exported matrix helpers); the LIVE_TITLE set is that
 * module's private constant, copied per the dashboard.tsx precedent.
 */
async function projectFeedItems(
  d1: D1Database,
  viewer: Viewer,
  origin: string,
  rows: ActionRow[],
): Promise<ActivityFeedItem[]> {
  const activities = await renderFeedItems(d1, dashboardApiUser(viewer, origin), rows);

  // coordinates → TEXT repositories.id (the Activity payload's repo_id
  // renders numeric — TEXT keys render 0 — so the issue-title join goes
  // through repositories.ownerNamespace/slug).
  const coordinates = [
    ...new Set(activities.map((activity) => `${activity.repo?.owner?.login ?? ""}/${activity.repo?.name ?? ""}`)),
  ].filter((key) => key !== "/");
  const repoIdByCoordinates = new Map<string, string>();
  if (coordinates.length > 0) {
    const namespaces = [...new Set(coordinates.map((key) => key.slice(0, key.indexOf("/"))))];
    const repoRows = await drizzle(d1)
      .select({ id: repositories.id, ownerNamespace: repositories.ownerNamespace, slug: repositories.slug })
      .from(repositories)
      .where(inArray(repositories.ownerNamespace, namespaces))
      .all();
    for (const row of repoRows) {
      const key = `${row.ownerNamespace}/${row.slug}`;
      if (coordinates.includes(key)) repoIdByCoordinates.set(key, row.id);
    }
  }

  // The GetIssueTitle arms: the service's batched title read over the
  // page's (repoId, index) pairs (the activity-feeds loader's C2 shape).
  const titleKeys = new Map<string, { repoId: string; index: number }>();
  for (const activity of activities) {
    if (!LIVE_TITLE_OP_TYPES.has(activity.op_type)) continue;
    const repoId = repoIdByCoordinates.get(`${activity.repo?.owner?.login ?? ""}/${activity.repo?.name ?? ""}`);
    const index = issueIndexOf(activity.content);
    if (repoId !== undefined && index > 0) titleKeys.set(`${repoId}#${index}`, { repoId, index });
  }
  const titles = await feedIssueTitles(d1, titleKeys.values());

  return activities.map((activity) => {
    const ownerLogin = activity.repo?.owner?.login ?? "";
    const name = activity.repo?.name ?? "";
    const index = issueIndexOf(activity.content);
    // GetIssueTitle (action.go:386-403): index ≤ 0 skips the load →
    // "<Issue not found>"; a missing row is the load error →
    // "<500 when get issue>". Non-live arms never read it ("").
    let liveIssueTitle = "";
    if (LIVE_TITLE_OP_TYPES.has(activity.op_type)) {
      if (index <= 0) {
        liveIssueTitle = "<Issue not found>";
      } else {
        const repoId = repoIdByCoordinates.get(`${ownerLogin}/${name}`);
        liveIssueTitle =
          repoId === undefined ? "<500 when get issue>" : titles.get(`${repoId}#${index}`) ?? "<500 when get issue>";
      }
    }
    const base: ActivityFeedItemFields = {
      id: activity.id,
      opType: activity.op_type,
      actorName: ellipsisDisplay(activity.act_user?.login ?? "", 20),
      actorTitle: activity.act_user?.full_name ?? "",
      actorHref: `/${encodeURIComponent(activity.act_user?.login ?? "")}`,
      repoHref: `/${encodeURIComponent(ownerLogin)}/${encodeURIComponent(name)}`,
      shortRepoPath: `${ellipsisDisplay(ownerLogin, 20)}/${ellipsisDisplay(name, 33)}`,
      createdUnix: Math.floor(Date.parse(activity.created) / 1000),
      refName: activity.ref_name,
      content: activity.content,
      issueIndex: index,
      liveIssueTitle,
      liveCommentUrl: activity.comment?.html_url ?? null,
    };
    return {
      ...base,
      icon: feedIconName(base.opType),
      message: feedMessageSegments(base),
      body: feedBody(base),
    };
  });
}

/** The live-title op types (activity-feeds.tsx's LIVE_TITLE_OP_TYPES — the
 *  module-private set, copied verbatim per the dashboard.tsx precedent). */
const LIVE_TITLE_OP_TYPES: ReadonlySet<Activity["op_type"]> = new Set([
  "comment_issue",
  "approve_pull_request",
  "reject_pull_request",
  "comment_pull",
  "close_issue",
  "reopen_issue",
  "close_pull_request",
  "reopen_pull_request",
] as Activity["op_type"][]);

/**
 * Load the page (home.go:77-136's arms): the feed page (plain arm through
 * the landed service read; team arm through `teamFeedRows`), the visible
 * team dropdown set, the doer-accessible org repo page (the landed
 * §4.7 listing — the same read the org home serves) with one batched
 * description read, and the switcher's org memberships.
 */
export async function loadOrgDashboardData(
  d1: D1Database,
  org: OrgRecord,
  viewer: Viewer,
  origin: string,
  params: URLSearchParams,
  team: TeamRecord | null,
): Promise<OrgDashboardData> {
  if (viewer.kind !== "user") throw new Error("loadOrgDashboardData requires a signed-in viewer");
  const db = drizzle(d1);
  const page = parsePageNumber(params.get("page"));
  const date = params.get("date") ?? "";
  const actor = { id: viewer.id, isAdmin: viewer.isAdmin };

  const { total, rows } =
    team === null
      ? await getFeedRows(d1, {
          kind: "org",
          requested: { id: org.id },
          actor,
          includePrivate: true,
          onlyPerformedBy: false,
          date: date === "" ? undefined : date,
          page,
          limit: ORG_DASHBOARD_FEED_PAGE_SIZE,
        })
      : await teamFeedRows(d1, org, team, actor, date, page, ORG_DASHBOARD_FEED_PAGE_SIZE);

  const orgs = new OrgService(d1);
  const ownerOrAdmin = actor.isAdmin || (await orgs.isOrgOwner(org.id, viewer.id));

  // The team dropdown's visible set (org.go:186-204): owner/admin sees
  // every team; a plain member sees the public/limited teams plus their
  // own (upstream's SearchTeam IncludeVisibilities + UserID arms).
  const teamsWhere = ownerOrAdmin
    ? eq(teams.orgId, org.id)
    : and(
        eq(teams.orgId, org.id),
        sql`(${teams.visibility} IN ('public', 'limited') OR ${teams.id} IN (SELECT team_id FROM ${teamMembers} WHERE user_id = ${viewer.id}))`,
      );
  const teamList = await db.select().from(teams).where(teamsWhere).orderBy(asc(teams.lowerName)).all();

  // The sidebar repo page (the landed §4.7 listing — owners/admins see
  // private rows, plain members public + team-covered) + one batched
  // description read (the org-home loader pattern).
  const listing = await listOrgRepositories(d1, org, { id: viewer.id, isAdmin: viewer.isAdmin }, {
    page: 1,
    pageSize: ORG_DASHBOARD_REPO_LIMIT,
  });
  const descriptions = new Map<string, string>();
  if (listing.items.length > 0) {
    const rows_ = await db
      .select({ repoId: repoSettings.repoId, description: repoSettings.description })
      .from(repoSettings)
      .where(inArray(repoSettings.repoId, listing.items.map((item) => item.repo.id)))
      .all();
    for (const row of rows_) descriptions.set(row.repoId, row.description);
  }

  // The switcher's orgs (GetUserOrgsList — the self-list shape: every
  // membership regardless of visibility, listUserOrgs' private ceiling).
  const memberships = await orgs.listUserOrgs(viewer.id, { page: 1, pageSize: 50 });

  return {
    org,
    team,
    items: await projectFeedItems(d1, viewer, origin, rows),
    page,
    total,
    more: page * ORG_DASHBOARD_FEED_PAGE_SIZE < total,
    date,
    teams: teamList,
    repos: listing.items.map((item) => ({
      repo: item.repo,
      description: descriptions.get(item.repo.id) ?? "",
    })),
    repoTotal: listing.total,
    orgs: memberships.items.map((orgRow) => ({ username: orgRow.username, visibility: orgRow.visibility })),
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The visibility short-badge (navbar.tmpl:8-11 — limited/private only). */
function OrgVisibilityShortBadge(props: { visibility: "public" | "limited" | "private" }) {
  if (props.visibility === "limited") {
    return <div class="ui basic tiny horizontal label">{orgDashboardLocale.visibility_limited}</div>;
  }
  if (props.visibility === "private") {
    return <div class="ui basic tiny horizontal label">{orgDashboardLocale.visibility_private}</div>;
  }
  return null;
}

/** One switcher item: the avatar-slot placeholder (the avatar-slot rule),
 *  the ellipsized name and the visibility badge. */
function SwitcherItem(props: { href: string; name: string; title: string; active: boolean; visibility?: "public" | "limited" | "private" }) {
  return (
    <a class={props.active ? "active selected item" : "item"} title={props.title} href={props.href}>
      <span class="ui avatar" aria-hidden="true">
        <Icon name="octicon-person" size={20} />
      </span>
      <span class="gt-ellipsis">{props.name}</span>
      {props.visibility !== undefined ? <OrgVisibilityShortBadge visibility={props.visibility} /> : null}
    </a>
  );
}

/**
 * navbar.tmpl reduced (the module header): the context-user switcher
 * dropdown (self + memberships + New Organization), the org arm's team
 * filter dropdown, and the right menu's Activities (active) + View-home
 * pair. The dropdowns are generic `.ui.dropdown` DOM (the branch-selector
 * shape — the official bundle's Fomantic enhances them); the caret glyphs
 * render text-only (the icon-allowlist note).
 */
function OrgDashboardNavbar(props: { data: OrgDashboardData; viewerName: string }) {
  const { data } = props;
  const orgLink = `/org/${data.org.username}`;
  const dashLink = `${orgLink}/dashboard`;
  // navbar.tmpl:81 — the Activities href carries the team tail on a team
  // page (DashboardLink + `/{{PathEscape .Team.Name}}`).
  const activitiesHref = data.team === null ? dashLink : `${dashLink}/${encodeURIComponent(data.team.name)}`;
  return (
    <div class="secondary-nav tw-border-b tw-border-b-secondary">
      <div class="ui secondary stackable menu">
        <div class="item">
          <div class="ui dropdown jump">
            <span class="text">
              <span class="ui avatar" aria-hidden="true">
                <Icon name="octicon-person" size={24} />
              </span>
              <span class="gt-ellipsis">{props.viewerName}</span>
            </span>
            <div class="menu context-user-switch">
              <div class="header">{orgDashboardLocale.switch_dashboard_context}</div>
              <div class="scrolling menu">
                <SwitcherItem href="/" name={props.viewerName} title={props.viewerName} active={false} />
                {data.orgs.map((org) => (
                  <SwitcherItem
                    key={org.username}
                    href={`/org/${org.username}/dashboard`}
                    name={org.username}
                    title={org.username}
                    active={org.username === data.org.username}
                    visibility={org.visibility}
                  />
                ))}
              </div>
              <a class="item" href="/org/create">
                <Icon name="octicon-plus" /> {orgDashboardLocale.new_org}
              </a>
            </div>
          </div>
        </div>
        <div class="item">
          <div class="ui dropdown jump">
            <span class="text">
              <Icon name="octicon-organization" size={18} />
              {data.team === null ? orgDashboardLocale.teams : data.team.name}
            </span>
            <div class="menu">
              <div class="header">{orgDashboardLocale.filter_by_team}</div>
              <div class="scrolling menu items">
                {/* navbar.tmpl:63 — the All item is the bare dashboard URL. */}
                <a class={data.team === null ? "active selected item" : "item"} href={dashLink}>
                  {orgDashboardLocale.all}
                </a>
                {data.teams
                  .filter((team) => !team.includesAllRepositories)
                  .map((team) => (
                    <a
                      key={team.id}
                      class={data.team !== null && data.team.id === team.id ? "active selected item" : "item"}
                      title={team.name}
                      href={`${orgLink}/dashboard/${encodeURIComponent(team.name)}`}
                    >
                      {team.name}
                    </a>
                  ))}
              </div>
            </div>
          </div>
        </div>
        <div class="right menu tw-flex-wrap tw-justify-end">
          <a class="active item tw-ml-auto" href={activitiesHref}>
            <Icon name="octicon-rss" /> {orgDashboardLocale.activities}
          </a>
          <div class="item">
            <a class="ui primary basic button" href={`/${data.org.username}`} title={`View ${orgDisplayName(data.org)}`}>
              {orgDashboardLocale.view_home} {ellipsisDisplay(data.org.username, 20)}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

/** guide.tmpl — the empty-feed box (dashboard.tmpl:11's else arm). */
function DashboardGuide() {
  return (
    <div class="tw-text-center tw-p-8">
      <Icon name="octicon-package" size={24} class="tw-text-placeholder-text" />
      <h3 class="tw-my-4">{orgDashboardLocale.guide_title}</h3>
      <p class="tw-text-placeholder-text">{orgDashboardLocale.guide_desc}</p>
      <div>
        <a href="/explore/repos">{orgDashboardLocale.guide_explore_repos}</a>
        <span>·</span>
        <a href="/explore/users">{orgDashboardLocale.guide_explore_users}</a>
      </div>
    </div>
  );
}

/** The feed pager — base/paginate reduced to the Older/Newer pair (the
 *  org-home convention), carrying `date` when active. */
function DashboardFeedPager(props: { dashLink: string; page: number; more: boolean; date: string }) {
  const href = (target: number): string => {
    const params = new URLSearchParams();
    if (props.date !== "") params.set("date", props.date);
    if (target > 1) params.set("page", String(target));
    const query = params.toString();
    return `${props.dashLink}${query === "" ? "" : `?${query}`}`;
  };
  if (props.page <= 1 && !props.more) return null;
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a class="item navigation" href={href(props.page - 1)}>
            <span class="navigation_label">{orgDashboardLocale.newer}</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={href(props.page + 1)}>
            <span class="navigation_label">{orgDashboardLocale.older}</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The dashboard repo list (DashboardRepoList.vue reduced — the module
 * header): the "Repositories" header with the count label + the
 * New-Repository `+` link onto `/repo/create?org={id}`, then the shared
 * shared/repo/list.tmpl rows (OrgRepoListItem — the user dashboard's
 * sidebar row), then the widget's empty arm.
 */
function DashboardRepoList(props: { data: OrgDashboardData }) {
  const { data } = props;
  const orgLink = `/${data.org.username}`;
  return (
    <div id="dashboard-repo-list" class="flex-container-sidebar">
      <div>
        <div class="flex-text-block">
          <h4 class="ui top attached header tw-flex-1 tw-flex tw-items-center">
            <Icon name="octicon-repo" /> {orgDashboardLocale.my_repos}
            {data.repoTotal > 0 ? <div class="ui grey label">{data.repoTotal}</div> : null}
          </h4>
          <a
            class="tw-flex tw-items-center muted"
            href={`/repo/create?org=${data.org.id}`}
            data-tooltip-content={orgDashboardLocale.new_repo}
            aria-label={orgDashboardLocale.new_repo}
          >
            <Icon name="octicon-plus" />
          </a>
        </div>
        {data.repos.length === 0 ? (
          <div class="ui attached segment">
            <div class="empty-repo-or-org">
              <Icon name="octicon-git-branch" size={24} />
              <p>{orgDashboardLocale.repos_empty}</p>
            </div>
          </div>
        ) : (
          <div class="ui attached segment">
            <div class="flex-divided-list items-with-main">
              {data.repos.map((item) => (
                <OrgRepoListItem
                  key={item.repo.id}
                  orgLink={orgLink}
                  item={item}
                  orgPrivate={item.repo.visibility === "public" && data.org.visibility === "private"}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderOrgDashboardPage(ctx: UiContext, data: OrgDashboardData, viewerName: string): string {
  return renderPage(<OrgDashboardPage ctx={ctx} data={data} viewerName={viewerName} />);
}

/** The org dashboard page (§2.4.1 discriminator: `dashboard feeds` —
 *  dashboard.tmpl:2). */
export function OrgDashboardPage(props: { ctx: UiContext; data: OrgDashboardData; viewerName: string }) {
  const { ctx, data } = props;
  const orgLink = `/org/${data.org.username}`;
  // The pager keeps the team tail on a team page (upstream base/paginate
  // preserves the URL path).
  const dashLink =
    data.team === null ? `${orgLink}/dashboard` : `${orgLink}/dashboard/${encodeURIComponent(data.team.name)}`;
  return (
    <BaseLayout ctx={ctx} title={`${orgDisplayName(data.org)} - ${orgDashboardLocale.dashboard}`} pageClass="dashboard feeds">
      <OrgDashboardNavbar data={data} viewerName={props.viewerName} />
      <div class="ui container flex-container">
        <div class="flex-container-main">
          {data.total === 0 ? (
            <DashboardGuide />
          ) : (
            <>
              <ActivityFeedList items={data.items} />
              <DashboardFeedPager dashLink={dashLink} page={data.page} more={data.more} date={data.date} />
            </>
          )}
        </div>
        <DashboardRepoList data={data} />
      </div>
    </BaseLayout>
  );
}

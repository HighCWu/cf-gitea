/**
 * The org teams pages — pages wave 12 (SPEC-0008 U3 extension): the teams
 * list (`/{org}/teams`), each team's detail slice (`/{org}/teams/{id}` —
 * the members list and the repo-access list on ONE page), and the create-team
 * form (`/{org}/teams/new`, GET + POST). THE owner/admin family: every route
 * here answers the landed `requireOrgOwnership` posture (org owner
 * `role='owner'` or site admin — services/orgs.ts:148) collapsed to the
 * settings pages' gate shape — a signed-in non-owner 404-shells exactly like
 * the repo settings pages (upstream answers NotFound for every non-member,
 * routers/web/web.go:980-1001's OrgAssignment{RequireMember, RequireTeamMember};
 * the collapsed shell keeps existence hidden). Data is the landed org-teams
 * service half (src/api/routes/org-teams.ts `TeamsService` — SPEC-0007 §3.5's
 * port of routers/api/v1/org/team.go over the 0015 tables), never a
 * self-fetch (§3.2).
 *
 * ## DOM contract (templates/org/team/{teams,new,sidebar,members,repositories}
 *  .tmpl + org/header.tmpl at the pin)
 *
 * Every page: `.page-content.organization teams` (new.tmpl:
 * `organization new team`), then org/header.tmpl (the shared
 * pages/org-home.tsx OrgHeader), then the container. The list is teams.tmpl:
 * the owner prompt row (`flex-text-block` with the New Team primary button —
 * always rendered here, the viewer is an owner by the gate), the `?q=` search
 * form, and the `.ui.two.column.stackable.grid` of `.column.team-item-box`
 * rows (upstream renders an empty grid for zero teams — no empty-state box).
 * The detail is sidebar.tmpl's six-wide column (team name header +
 * visibility badge, the description / access / permission segments) beside
 * members.tmpl + repositories.tmpl's ten-wide lists (upstream splits them
 * across `/teams/{team}` and `/teams/{team}/repositories` with the
 * org-team-navbar switch — one slice page carrying both leaves the navbar
 * nothing to switch, so it is dropped, the dead-link rule). The form is
 * new.tmpl's header/segment pair reduced to the brief's fields.
 *
 * ## Route shapes (upstream divergences, §6 method)
 *
 * - The detail URL keys on the team ID (`/{org}/teams/{id}`), not upstream's
 *   `{{.LowerName | PathEscape}}` name link — the landed team read arms
 *   (`orgGetTeam`/`orgListTeamMembers`/`orgListTeamRepos`) all resolve by the
 *   int64 id (org-teams.ts `intPathParam`), so the slice follows the API
 *   shape; the list rows link their counts to the same detail page (upstream
 *   links the repos count onto the separate repositories page).
 * - `/{org}/teams` claims the literal second segment before the repo parse
 *   could read it as a repository named "teams" (the notifications/explore
 *   precedent). Upstream shadows a repo named "teams" identically: the org
 *   teams group registers at web.go:993, ahead of :1292's
 *   `/{username}/{reponame}`.
 * - The deeper tails (`/teams/{id}/repositories`, `/teams/{id}/edit`,
 *   `/teams/{id}/delete`, the `/action/*` writes) stay unclaimed → the
 *   engine's 404, exactly upstream's unregistered-route 404 for a slice that
 *   has not landed them.
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The create form renders the brief's fields ONLY — `team_name` +
 *   the `permission` select (the landed create arm's read/write/admin enum,
 *   CreateTeamOption): upstream new.tmpl's description, visibility radio
 *   group, repo_access radio group, can_create_org_repo checkbox and the
 *   unit-permission matrix are not rendered. Absent inputs ride the landed
 *   service defaults (visibility 'private' — NormalizeTeamVisibility,
 *   org-teams.ts createTeam). The `owners`/`new` reserved names keep the
 *   landed arms' answers: `owners` 422s as the duplicate (the §3.3 role
 *   bridge IS the Owners team), the reserved `new` propagates the bare
 *   upstream 500 (teams.go:229-235's APIErrorInternal).
 * - The list row's member strip renders NAME links (no avatar pipeline — an
 *   `<img>` to a missing route is a dead link, the org-home avatar-slot
 *   rule); a memberless team renders the empty strip without upstream's
 *   add_team_member link (its target form does not exist here).
 * - The detail page's member add/remove forms, the repo add/remove forms,
 *   the join/leave buttons and the owner Settings (edit) button are not
 *   rendered — those write routes are not in this wave's UI inventory, and
 *   dead controls are forbidden (§2.4.1).
 * - The permission section renders the upstream desc paragraphs for
 *   write/admin teams (the `<strong>` pair of
 *   org.teams.write/admin_permission_desc); a team carrying `units_map`
 *   overrides renders its stored per-unit rows (the documented units
 *   collapse, schema.ts `teams.units_map`), and a plain read team renders
 *   the access-mode text — upstream's full unit table iterates
 *   `unit_model.Units`, which has no landed catalog to iterate.
 * - Row counts are the maintained `num_members`/`num_repos` counters (the
 *   landed list read carries them). The detail lists cap at one page of 20
 *   (upstream `setting.UI.MembersPagingNum`, modules/setting/ui.go:91) with
 *   no pager — the counters above the lists carry the totals.
 */

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  TeamAlreadyExistsError,
  TeamNameEmptyError,
  TeamPermissionMissingError,
  TeamsService,
  type TeamRecord,
} from "../../api/routes/org-teams";
import { resolveOrgForRequest } from "../../api/services/orgs";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { teamMembers, users } from "../../db/schema";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { orgDisplayName, OrgHeader } from "./org-home";

/** Page chrome text (component-local, the orgHomeLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const orgTeamsLocale = {
  teams: "Teams", // "org.teams"
  manage_prompt: "Members are managed through teams. Add users to a team to invite them to this organization.", // "org.teams.manage_team_member_prompt"
  create_new_team: "New Team", // "org.create_new_team"
  search_placeholder: "Search teams…", // "search.team_kind"
  lower_members: "members", // "org.lower_members"
  lower_repositories: "repositories", // "org.lower_repositories"
  visibility_public: "Public", // "org.teams.visibility_public"
  visibility_limited: "Limited", // "org.teams.visibility_limited"
  visibility_private: "Private", // "org.teams.visibility_private"
  visibility_public_helper: "Visible to any signed-in user.", // "org.teams.visibility_public_helper"
  visibility_limited_helper: "Visible to all members of this organization.", // "org.teams.visibility_limited_helper"
  visibility_private_helper: "Visible only to team members and organization owners.", // "org.teams.visibility_private_helper"
  read_access: "Read", // "org.teams.read_access"
  write_access: "Write", // "org.teams.write_access"
  admin_access: "Administrator Access", // "org.teams.admin_access"
  none_access: "No Access", // "org.teams.none_access"
  members: "Members", // "org.members"
  repositories: "Repositories", // cf-gitea addition — the merged repos list's header (upstream's repositories page has none; the org-team-navbar carried the label, dropped with the switch)
  members_none: "No members on this team.", // "org.teams.members.none"
  repos_none: "No repositories could be accessed by this team.", // "org.teams.repos.none"
  no_desc: "This team has no description", // "org.teams.no_desc"
  team_access_desc: "Repository access", // "org.team_access_desc"
  all_repositories: "All repositories", // "org.teams.all_repositories"
  specific_repositories: "Specific repositories", // "org.teams.specific_repositories"
  can_create_org_repo: "Create repositories", // "org.teams.can_create_org_repo"
  permission_desc: "Permission", // "org.team_permission_desc"
  unit: "Unit", // "units.unit"
  team_name: "Team Name", // "org.team_name"
  team_name_helper: "Team names should be short and memorable.", // "org.team_name_helper"
  create_team: "Create Team", // "org.create_team"
  search: "Search", // cf-gitea addition — the submit label; upstream renders an
  // icon-only button (octicon-search), which is not in the landed icon
  // allowlist (scripts/gen-ui-icons.mjs is outside this wave's ownership).
} as const;

/** Upstream `setting.UI.MembersPagingNum` (modules/setting/ui.go:91) — the
 *  teams list page size AND the detail lists' one-page cap. */
export const ORG_TEAMS_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Resolution — the handler-side seam (index.ts calls these; kept here so the
// page module owns its data path, the org-home pattern)
// ---------------------------------------------------------------------------

/** The resolution outcome for the `/{org}/teams` family: the resolved org, a
 *  rename redirect, or a miss (→ 404 shell). */
export type OrgTeamsResolution =
  | { kind: "org"; org: OrgRecord }
  | { kind: "redirect"; location: string }
  | { kind: "missing" };

/**
 * Resolve the org for the family viewer: `resolveOrgForRequest` (the
 * orgAssignment + RedirectToUser seam — non-org rows are misses, renamed
 * orgs 307 behind the seam's coarse gate). No separate visibility ladder:
 * the family's ownership gate below implies it (an owner is a member, a
 * site admin sees everything), and every non-owner 404-shells regardless.
 */
export async function resolveOrgTeamsOrg(
  d1: D1Database,
  owner: string,
  doer: { id: number | null; isAdmin: boolean },
  requestPath: string,
  requestQuery: string,
): Promise<OrgTeamsResolution> {
  const resolved = await resolveOrgForRequest(d1, owner, doer, requestPath, requestQuery);
  if (resolved.kind !== "org") {
    return resolved.kind === "redirect" ? resolved : { kind: "missing" };
  }
  return { kind: "org", org: resolved.org };
}

/**
 * The family's ownership gate — the landed `requireOrgOwnership` posture
 * (services/orgs.ts:148) as a boolean: site admin, or the org's
 * `role='owner'` membership (`isOrgOwner` — NOT the §3.4 repo-create team
 * grant). Anonymous viewers are never owners.
 */
export async function canManageOrgTeams(d1: D1Database, org: OrgRecord, viewer: Viewer): Promise<boolean> {
  if (viewer.kind !== "user") return false;
  if (viewer.isAdmin) return true;
  return new OrgService(d1).isOrgOwner(org.id, viewer.id);
}

// ---------------------------------------------------------------------------
// Loaders + the create write (§3.2 — the landed TeamsService arms)
// ---------------------------------------------------------------------------

/** One rendered list row: the team row plus its member usernames (the
 *  batched strip read). */
export interface OrgTeamsListItem {
  team: TeamRecord;
  memberUsernames: string[];
}

/** The teams list render inputs. */
export interface OrgTeamsData {
  org: OrgRecord;
  teams: OrgTeamsListItem[];
  total: number;
  page: number;
  more: boolean;
  /** The `?q=` keyword under re-render ("" when absent). */
  keyword: string;
}

/**
 * Load the teams list (the landed orgListTeams read's OWNER arm: no user
 * filter, no visibility ladder — every team; org-teams.ts orgListTeamsRoute),
 * plus one batched member-strip read for the page's rows (the wave-2
 * batching pattern).
 */
export async function loadOrgTeamsData(
  d1: D1Database,
  org: OrgRecord,
  params: URLSearchParams,
): Promise<OrgTeamsData> {
  const page = parsePageNumber(params.get("page"));
  const keyword = params.get("q") ?? "";
  const service = new TeamsService(d1);
  const { items, total } = await service.listTeams({
    orgId: org.id,
    keyword: keyword,
    page,
    pageSize: ORG_TEAMS_PAGE_SIZE,
  });
  const memberUsernames = new Map<number, string[]>();
  if (items.length > 0) {
    const rows = await drizzle(d1)
      .select({ teamId: teamMembers.teamId, username: users.username })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(inArray(teamMembers.teamId, items.map((team) => team.id)))
      .orderBy(teamMembers.teamId, users.username)
      .all();
    for (const row of rows) {
      const list = memberUsernames.get(row.teamId) ?? [];
      list.push(row.username);
      memberUsernames.set(row.teamId, list);
    }
  }
  return {
    org,
    teams: items.map((team) => ({ team, memberUsernames: memberUsernames.get(team.id) ?? [] })),
    total,
    page,
    more: page * ORG_TEAMS_PAGE_SIZE < total,
    keyword,
  };
}

/** The team detail render inputs: the team row, its member rows and its
 *  covered repository slugs (the landed team read arms —
 *  listTeamMemberRows/listTeamRepoPairs, one page each). */
export interface OrgTeamDetailData {
  org: OrgRecord;
  team: TeamRecord;
  members: Array<typeof users.$inferSelect>;
  repoSlugs: string[];
}

/**
 * Load one team's detail slice. `null` = the 404 shell: an unknown id, or a
 * team that belongs to a DIFFERENT org (the id keys globally — a foreign id
 * must never leak the team, upstream resolves within the team's org).
 */
export async function loadOrgTeamDetailData(
  d1: D1Database,
  org: OrgRecord,
  teamId: number,
): Promise<OrgTeamDetailData | null> {
  const service = new TeamsService(d1);
  const team = await service.getTeamById(teamId);
  if (team === null || team.orgId !== org.id) return null;
  const members = await service.listTeamMemberRows(team.id, { page: 1, pageSize: ORG_TEAMS_PAGE_SIZE });
  const repos = await service.listTeamRepoPairs(team, { page: 1, pageSize: ORG_TEAMS_PAGE_SIZE });
  return {
    org,
    team,
    members: members.items,
    repoSlugs: repos.items.map((pair) => pair.repo.slug),
  };
}

/** The create form's fields (upstream new.tmpl's `team_name` +
 *  `permission` — the landed create arm's brief fields). The permission is
 *  normalized to the create arm's enum at parse time; anything else parses
 *  to "" (→ the create service's "no permission specified" 422, the API
 *  validator's arm). */
export interface TeamNewForm {
  name: string;
  permission: "read" | "write" | "admin" | "";
}

/** Parse the urlencoded create POST (the upstream new.tmpl field names). */
export function parseTeamNewForm(params: URLSearchParams): TeamNewForm {
  const permission = params.get("permission") ?? "";
  return {
    name: (params.get("team_name") ?? "").trim(),
    permission: permission === "read" || permission === "write" || permission === "admin" ? permission : "",
  };
}

export type CreateTeamResult = { outcome: "created"; team: TeamRecord } | { outcome: "invalid"; message: string };

/**
 * The create write through the landed `TeamsService.createTeam` (the exact
 * arm POST /orgs/{org}/teams serves). The typed NewTeam 422s re-render with
 * the API's messages (the settings/hooks pattern); the reserved `new` name
 * propagates its bare upstream 500 (teams.go:229-235's APIErrorInternal —
 * the module header's mapping note).
 */
export async function createTeamFromForm(d1: D1Database, org: OrgRecord, form: TeamNewForm): Promise<CreateTeamResult> {
  const service = new TeamsService(d1);
  try {
    const team = await service.createTeam(org, {
      name: form.name,
      permission: form.permission === "" ? undefined : form.permission,
    });
    return { outcome: "created", team };
  } catch (error) {
    if (
      error instanceof TeamNameEmptyError ||
      error instanceof TeamAlreadyExistsError ||
      error instanceof TeamPermissionMissingError
    ) {
      return { outcome: "invalid", message: error.message };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** org/header.tmpl's visibility badge + the brief's permission badge —
 *  teams.tmpl's `ui mini label` shape (visibility, with its tooltip helper);
 *  the permission label is the brief's addition (upstream renders the
 *  permission only on the detail sidebar). */
function TeamBadges(props: { team: TeamRecord }) {
  const { team } = props;
  const visibility =
    team.visibility === "public"
      ? orgTeamsLocale.visibility_public
      : team.visibility === "limited"
        ? orgTeamsLocale.visibility_limited
        : orgTeamsLocale.visibility_private;
  const helper =
    team.visibility === "public"
      ? orgTeamsLocale.visibility_public_helper
      : team.visibility === "limited"
        ? orgTeamsLocale.visibility_limited_helper
        : orgTeamsLocale.visibility_private_helper;
  const permission =
    team.authorize === "admin"
      ? orgTeamsLocale.admin_access
      : team.authorize === "write"
        ? orgTeamsLocale.write_access
        : team.authorize === "read"
          ? orgTeamsLocale.read_access
          : null;
  return (
    <>
      <span class="ui mini label" data-tooltip-content={helper}>
        {visibility}
      </span>
      {permission !== null ? <span class="ui mini label">{permission}</span> : null}
    </>
  );
}

/** The access-mode text for the sidebar's permission section. */
function accessModeText(mode: string): string {
  if (mode === "admin") return orgTeamsLocale.admin_access;
  if (mode === "write") return orgTeamsLocale.write_access;
  if (mode === "read") return orgTeamsLocale.read_access;
  return orgTeamsLocale.none_access;
}

/**
 * The plain-permission branch of the sidebar's permission section: a team
 * carrying `units_map` overrides renders its stored rows (the units
 * collapse — schema.ts `teams.units_map`); a plain read/none team renders
 * the access-mode text (upstream iterates unit_model.Units, which has no
 * landed catalog — the module header's reduction note).
 */
function TeamPermissionBody(props: { team: TeamRecord }) {
  const { team } = props;
  if (team.authorize === "admin") {
    // org.teams.admin_permission_desc — the strong pair inline.
    return (
      <p>
        This team grants <strong>Admin</strong> access: members can read from, push to and add collaborators to team
        repositories.
      </p>
    );
  }
  if (team.authorize === "write") {
    // org.teams.write_permission_desc.
    return (
      <p>
        This team grants <strong>Write</strong> access: members can read from and push to team repositories.
      </p>
    );
  }
  const unitsMap = team.unitsMap === null ? {} : (JSON.parse(team.unitsMap) as Record<string, string>);
  const units = Object.keys(unitsMap).sort();
  if (units.length === 0) return <p>{accessModeText(team.authorize)}</p>;
  return (
    <table class="ui table">
      <thead>
        <tr>
          <th scope="col">{orgTeamsLocale.unit}</th>
          <th scope="col">{orgTeamsLocale.permission_desc}</th>
        </tr>
      </thead>
      <tbody>
        {units.map((unit) => (
          <tr>
            <td>
              <strong>{unit}</strong>
            </td>
            <td>{accessModeText(unitsMap[unit] ?? "none")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** teams.tmpl's `.column.team-item-box` row: the name link, the visibility +
 *  permission badges, the member/repo counts (linked to the detail slice),
 *  the description header, and the member strip (names — the avatar-slot
 *  rule). */
export function OrgTeamsListItemView(props: { orgLink: string; item: OrgTeamsListItem }) {
  const { team, memberUsernames } = props.item;
  const teamLink = `${props.orgLink}/teams/${team.id}`;
  return (
    <div class="column team-item-box">
      <div class="ui top attached header muted-links flex-left-right team-item-header">
        <div class="flex-text-inline">
          <a href={teamLink}>
            <strong>{team.name}</strong>
          </a>
          <TeamBadges team={team} />
        </div>
        <div class="flex-text-block tw-flex-wrap">
          <a href={teamLink}>
            {team.numMembers} {orgTeamsLocale.lower_members}
          </a>
          {" · "}
          <a href={teamLink}>
            {team.numRepos} {orgTeamsLocale.lower_repositories}
          </a>
        </div>
      </div>
      {team.description !== "" ? <div class="ui attached header team-item-description">{team.description}</div> : null}
      <div class="ui attached segment">
        <div class="flex-text-block tw-flex-wrap">
          {memberUsernames.map((username) => (
            <a class="flex-text-inline" href={`/${username}`}>
              {username}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderOrgTeamsPage(ctx: UiContext, data: OrgTeamsData): string {
  return renderPage(<OrgTeamsPage ctx={ctx} data={data} />);
}

/** The teams list page (§2.4.1 discriminator: `organization teams` —
 *  teams.tmpl:3). */
export function OrgTeamsPage(props: { ctx: UiContext; data: OrgTeamsData }) {
  const { ctx, data } = props;
  const orgLink = `/${data.org.username}`;
  // The pager preserves the `?q=` keyword (upstream's base/paginate keeps
  // the query; the shared OrgHomePagination appends a bare ?page=).
  const pageHref = (target: number): string => {
    const keyword = data.keyword === "" ? "" : `q=${encodeURIComponent(data.keyword)}&`;
    return `${orgLink}/teams?${keyword}page=${target}`;
  };
  return (
    <BaseLayout ctx={ctx} title={orgDisplayName(data.org)} pageClass="organization teams">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container">
        {/* The owner prompt row (teams.tmpl's IsOrganizationOwner block —
            always live here, the gate admits owners only). */}
        <div class="flex-text-block">
          <div class="tw-flex-1">{orgTeamsLocale.manage_prompt}</div>
          <a class="ui primary button" href={`${orgLink}/teams/new`}>
            <Icon name="octicon-plus" /> {orgTeamsLocale.create_new_team}
          </a>
        </div>
        <form class="ui form ignore-dirty tw-my-4" method="get" action={`${orgLink}/teams`}>
          <div class="ui fluid action input">
            <input
              type="search"
              name="q"
              value={data.keyword}
              placeholder={orgTeamsLocale.search_placeholder}
              maxlength={255}
              spellcheck={false}
            />
            <button class="ui button" type="submit" aria-label={orgTeamsLocale.search}>
              {orgTeamsLocale.search}
            </button>
          </div>
        </form>
        {/* Upstream renders the grid unconditionally (zero teams = an empty
            grid, no empty-state box at this pin). */}
        <div class="ui two column stackable grid">
          {data.teams.map((item) => (
            <OrgTeamsListItemView orgLink={orgLink} item={item} />
          ))}
        </div>
        {data.page > 1 || data.more ? (
          <div class="center page buttons">
            <div class="ui borderless pagination menu">
              {data.page > 1 ? (
                <a class="item navigation" href={pageHref(data.page - 1)}>
                  <span class="navigation_label">Newer</span>
                </a>
              ) : null}
              {data.more ? (
                <a class="item navigation" href={pageHref(data.page + 1)}>
                  <span class="navigation_label">Older</span>
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </BaseLayout>
  );
}

/** The full-document render for the detail slice. */
export function renderOrgTeamDetailPage(ctx: UiContext, data: OrgTeamDetailData): string {
  return renderPage(<OrgTeamDetailPage ctx={ctx} data={data} />);
}

/**
 * The team detail slice (§2.4.1 discriminator: `organization teams` —
 * members.tmpl/repositories.tmpl:3): sidebar.tmpl's six-wide column (name +
 * visibility badge, description, access + permission segments) beside the
 * ten-wide members list + repo-access list (upstream's two pages merged —
 * the module header). The org-team-navbar switch and every add/remove/join/
 * leave control are documented degradations (no write routes this wave).
 */
export function OrgTeamDetailPage(props: { ctx: UiContext; data: OrgTeamDetailData }) {
  const { ctx, data } = props;
  const orgLink = `/${data.org.username}`;
  const team = data.team;
  return (
    <BaseLayout ctx={ctx} title={orgDisplayName(data.org)} pageClass="organization teams">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container">
        <div class="ui stackable grid">
          {/* sidebar.tmpl — the six-wide column. */}
          <div class="ui six wide column">
            <h4 class="ui top attached header flex-left-right">
              <div class="flex-text-inline">
                <strong>{team.name}</strong>
                <TeamBadges team={team} />
              </div>
            </h4>
            <div class="ui attached segment">
              {team.description !== "" ? (
                team.description
              ) : (
                <span class="tw-text-text-light tw-italic">{orgTeamsLocale.no_desc}</span>
              )}
            </div>
            <div class="ui attached segment">
              {/* No owners team exists under the §3.3 bridge (the API module
                  header) — upstream's IsOwnerTeam branch is dead code here. */}
              <h3>{orgTeamsLocale.team_access_desc}</h3>
              <ul>
                <li>
                  {team.includesAllRepositories
                    ? orgTeamsLocale.all_repositories
                    : orgTeamsLocale.specific_repositories}
                </li>
                {team.canCreateOrgRepo ? <li>{orgTeamsLocale.can_create_org_repo}</li> : null}
              </ul>
              <h3>{orgTeamsLocale.permission_desc}</h3>
              <TeamPermissionBody team={team} />
            </div>
          </div>
          {/* members.tmpl + repositories.tmpl — the merged ten-wide column. */}
          <div class="ui ten wide column">
            <h4 class="ui top attached header">{orgTeamsLocale.members}</h4>
            <div class="ui attached segment">
              {data.members.length === 0 ? (
                <span class="tw-text-text-light tw-italic">{orgTeamsLocale.members_none}</span>
              ) : (
                <div class="flex-divided-list items-with-main">
                  {data.members.map((member) => (
                    <div class="item tw-items-center">
                      <div class="item-leading">
                        <Icon name="octicon-person" size={32} />
                      </div>
                      <div class="item-main">
                        <div class="item-title">
                          <a href={`/${member.username}`}>{member.username}</a>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <h4 class="ui top attached header">{orgTeamsLocale.repositories}</h4>
            <div class="ui attached segment">
              {data.repoSlugs.length === 0 ? (
                <span class="tw-text-text-light tw-italic">{orgTeamsLocale.repos_none}</span>
              ) : (
                <div class="flex-divided-list items-with-main">
                  {data.repoSlugs.map((slug) => (
                    <div class="item tw-items-center">
                      <div class="item-leading">
                        <Icon name="octicon-repo" size={24} />
                      </div>
                      <div class="item-main">
                        <a class="item-title tw-text-primary" href={`${orgLink}/${slug}`}>
                          {data.org.username}/{slug}
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The create form's render inputs: the re-rendered submission (the plain
 *  GET defaults — name "", permission "read", the select's first option). */
export interface TeamNewData {
  org: OrgRecord;
  form: TeamNewForm;
  error: string | null;
}

/** The full-document render for the create form. */
export function renderOrgTeamNewPage(ctx: UiContext, data: TeamNewData): string {
  return renderPage(<OrgTeamNewPage ctx={ctx} data={data} />);
}

/** The create-team form (§2.4.1 discriminator: `organization new team` —
 *  new.tmpl:3): new.tmpl's header/segment pair reduced to the brief's two
 *  fields (team_name + the permission select — the module header's
 *  reduction note). */
export function OrgTeamNewPage(props: { ctx: UiContext; data: TeamNewData }) {
  const { ctx, data } = props;
  const orgLink = `/${data.org.username}`;
  return (
    <BaseLayout ctx={ctx} title={orgDisplayName(data.org)} pageClass="organization new team">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container">
        <div class="ui grid">
          <div class="column">
            <form class="ui form" action={`${orgLink}/teams/new`} method="post">
              <h3 class="ui top attached header">{orgTeamsLocale.create_new_team}</h3>
              <div class="ui attached segment">
                {data.error !== null ? <div class="ui negative message">{data.error}</div> : null}
                <div class="required field">
                  <label for="team_name">{orgTeamsLocale.team_name}</label>
                  <input id="team_name" name="team_name" value={data.form.name} required autofocus />
                  <span class="help">{orgTeamsLocale.team_name_helper}</span>
                </div>
                <div class="grouped field">
                  <label for="permission">{orgTeamsLocale.permission_desc}</label>
                  <select id="permission" name="permission" class="ui selection dropdown">
                    <option value="read" selected={data.form.permission === "read"}>
                      {orgTeamsLocale.read_access}
                    </option>
                    <option value="write" selected={data.form.permission === "write"}>
                      {orgTeamsLocale.write_access}
                    </option>
                    <option value="admin" selected={data.form.permission === "admin"}>
                      {orgTeamsLocale.admin_access}
                    </option>
                  </select>
                </div>
                <div class="field">
                  <button type="submit" class="ui primary button">
                    {orgTeamsLocale.create_team}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

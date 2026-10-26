/**
 * The collaborators settings panel — pages wave 24 (the UI-parity survey's
 * bench tier, family E row `GET .../settings/collaboration`, web.go:1194's
 * group `m.Group("/collaboration", ...)`):
 *
 *   GET  /{owner}/{repo}/settings/collaboration               the panel
 *   POST /{owner}/{repo}/settings/collaboration               the add
 *                                                              collaborator
 *                                                              write
 *   POST /{owner}/{repo}/settings/collaboration/access_mode   the access-mode
 *                                                              write
 *   POST /{owner}/{repo}/settings/collaboration/delete        the remove
 *                                                              write
 *   POST /{owner}/{repo}/settings/collaboration/team          the add-team
 *                                                              write
 *   POST /{owner}/{repo}/settings/collaboration/team/delete   the remove-team
 *                                                              write
 *
 * Upstream registers the page as `m.Combo("")` (GET + POST) and the four
 * writes as POST-only arms; the write URLs are upstream's exact literal
 * tails. The whole group rides the settings gate (the router's
 * settingsGate — anonymous 303s onto /login, a signed-in non-admin
 * 404-shells, upstream's equally undiscoverable admin-only posture).
 *
 * ## DOM contract (templates/repo/settings/{collaboration,layout_head,
 *  navbar}.tmpl at the pin)
 *
 * layout_head's pageClass is the literal `repository settings
 * collaboration`; the `.ui.container.flex-container` body carries the
 * shared settings navbar (SettingsNav — wave 15's export, now with the
 * Collaboration item upstream's navbar.tmpl:13 places between Repository
 * and Webhooks) and the `.flex-container-main > .repo-setting-content`:
 * the `h4.ui.top.attached.header` "Collaborators", the collaborators
 * `flex-divided-list` (each row the avatar slot, the shared/user/name
 * anchor, and the item-trailing access-mode + Remove controls), the
 * bottom-attached add form (#repo-collab-form), and — org-owned repos
 * only — the Teams header, the team rows (name anchor + the shield-lock
 * access line) and the add-team form (or the restricted note).
 *
 * ## Write paths (§3.2 — the landed services, never a self-fetch)
 *
 * - Add collaborator: upstream CollaborationPost's order — the empty name
 *   and the owner-themself arms redirect silently; then the not-exist /
 *   inactive / organization / duplicate / org-owner / blocked refusals
 *   (upstream's exact flash texts) — onto `findUserByName`,
 *   `isCollaborator`, `OrgService.isOrgOwner` and the two directions of
 *   `isBlockedBy` (AddOrUpdateCollaborator's ErrBlockedUser pair,
 *   services/repository/collaboration.go), then the landed
 *   `addOrUpdateCollaborator` upsert at the `write` default.
 * - Access mode: upstream ChangeCollaborationAccessMode — the uid + mode
 *   form onto the same `addOrUpdateCollaborator` upsert (the form posts
 *   this service's "read"|"write"|"admin" literals where upstream posts
 *   the 1|2|3 ints — the API enum's string spelling, the no-JS select's
 *   values).
 * - Remove: `deleteCollaborator` (idempotent — an absent collaboration
 *   deletes zero rows and still succeeds, exactly upstream's unconditional
 *   delete; an unknown USER id is the refused arm).
 * - Team add/remove: upstream AddTeamPost/DeleteTeam over the landed
 *   TeamsService arms the org-teams API routes serve — `getTeamByName`,
 *   `hasTeamRepo`, `addTeamRepo` / `removeTeamRepo` (both no-op covered /
 *   includes-all states silently, upstream's own arms). The team-write
 *   gate is upstream CanDoerManageOrgRepoCollaboratorTeam
 *   (repo_permission.go:751-757) composed here: site admin, the org's
 *   role='owner' membership, or a repo admin when the org's
 *   repo_admin_change_team_access flag is set.
 *
 * ## No-JS reductions (documented divergences)
 *
 * - The access-mode Fomantic dropdown (autosaving fetch onto
 *   /access_mode) renders as a plain select + Save button per row — the
 *   no-JS repeated-form convention of the branch-protection pages; the
 *   button text is this slice's (upstream's dropdown renders no button).
 * - The Remove buttons are plain form POSTs — upstream's link-action JS
 *   confirm modal (repo-collaborator-delete-modal) is not reproduced (the
 *   hooks-list reduction, wave 4).
 * - The add-form search boxes (#search-user-box/#search-team-box) render
 *   as plain text inputs — the dropdown's JS completion is the bundle's,
 *   not this slice's; upstream's `autofocus`/`required` attributes carry
 *   over verbatim.
 * - The collaborators list caps at the render limit below (upstream's
 *   FindCollaborationOptions renders unpaginated; the cap is the API
 *   route's own default page size).
 * - The per-team Units line renders only from the stored units_map JSON
 *   (the DEVIATION column) — with no unit ACL to intersect, a
 *   plain-permission read team renders no Units line (upstream lists the
 *   repo's enabled units there).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { isBlockedBy } from "../../api/services/blocks";
import { findUserByName, type UserRow } from "../../api/services/repository";
import {
  addOrUpdateCollaborator,
  deleteCollaborator,
  isCollaborator,
  listRepoCollaborators,
  type CollaboratorMode,
} from "../../api/services/repo-collaborators";
import { TeamsService, type TeamRecord } from "../../api/routes/org-teams";
import { OrgService } from "../../services/orgs/orgs";
import { users } from "../../db/schema";
import { userLink } from "../links";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { canAdminRepo, SettingsNav } from "./settings";

/** Page chrome + refusal texts (component-local, the orgMembersLocale
 *  pattern — locale.ts is shared and not this wave's file; upstream locale
 *  keys cited). */
export const collabLocale = {
  collaborators: "Collaborators", // "repo.settings.collaboration"
  teams: "Teams", // "repo.settings.teams"
  search_users: "Search users…", // "search.user_kind"
  search_teams: "Search teams…", // "search.team_kind"
  add_collaborator: "Add Collaborator", // "repo.settings.add_collaborator"
  remove: "Remove", // "repo.settings.delete_collaborator"
  save: "Save", // the no-JS artifact — upstream's dropdown autosaves (module header)
  add_team: "Add Team", // "repo.settings.add_team"
  units: "Units:", // collaboration.tmpl's literal Units line lead
  units_none: "None", // collaboration.tmpl's empty-units arm
  mode_read: "Read", // "repo.settings.collaboration.read"
  mode_write: "Write", // "repo.settings.collaboration.write"
  mode_admin: "Administrator", // "repo.settings.collaboration.admin"
  mode_per_unit: "Unit Permissions", // "repo.settings.collaboration.per_unit"
  change_team_restricted:
    "Changing team access for repository has been restricted to organization owner", // "repo.settings.change_team_access_not_allowed"
  delete_team_tip: "This team has access to all repositories and can't be removed", // "repo.settings.delete_team_tip"
  err_user_not_exist: "The user does not exist.", // "form.user_not_exist"
  err_inactive_user: "Cannot add an inactive user as a collaborator.", // "repo.settings.add_collaborator_inactive_user"
  err_org_collaborator: "Organizations cannot be added as a collaborator.", // "repo.settings.org_not_allowed_to_be_collaborator"
  err_duplicate: "The collaborator is already added to this repository.", // "repo.settings.add_collaborator_duplicate"
  err_org_owner: "Cannot add an owner as a collaborator.", // "repo.settings.add_collaborator_owner"
  err_blocked:
    "The collaborator is blocked by the repository owner or vice versa.", // "repo.settings.add_collaborator.blocked_user"
  err_team_not_exist: "The team does not exist.", // "form.team_not_exist"
  err_team_duplicate: "Team already has the repository", // "repo.settings.add_team_duplicate"
} as const;

/** Upstream renders the collaborators list unpaginated
 *  (FindCollaborationOptions carries no pager); the render caps at the API
 *  route's own default page size — the module-header reduction. */
export const COLLABORATORS_RENDER_LIMIT = 50;

/** The team units_map JSON's display names (the upstream unit NameKeys' short
 *  texts; unknown keys render raw — the column is API-written). */
const TEAM_UNIT_NAMES: Record<string, string> = {
  "repo.code": "Code",
  "repo.issues": "Issues",
  "repo.ext.issues": "Issues",
  "repo.pulls": "Pull Requests",
  "repo.releases": "Releases",
  "repo.projects": "Projects",
  "repo.ext.projects": "Projects",
  "repo.wiki": "Wiki",
  "repo.ext.wiki": "Wiki",
  "repo.actions": "Actions",
};

/** The panel's render inputs. */
export interface CollaborationData {
  collaborators: Array<{ user: UserRow; mode: CollaboratorMode }>;
  /** The org-owned repo's covering teams (empty for user-owned repos). */
  teams: TeamRecord[];
  ownerIsOrg: boolean;
  /** upstream template's CanChangeRepoTeamAccess — gates the team trailing
   *  buttons and swaps the add-team form for the restricted note. */
  canChangeTeams: boolean;
}

/** The repo's owner row within THIS module (the page-module twin read — the
 *  org-members keyword arm's pattern; no exported owner-by-id read exists). */
async function ownerRowOf(d1: D1Database, repo: RepoRow): Promise<UserRow | null> {
  if (repo.ownerId === null) return null;
  const row = await drizzle(d1).select().from(users).where(eq(users.id, repo.ownerId)).get();
  return row ?? null;
}

/**
 * upstream `CanDoerManageOrgRepoCollaboratorTeam`
 * (models/perm/access/repo_permission.go:751-757): the repo-permission
 * owner (the org owner / site admin) always; a repo admin only when the
 * org's repo_admin_change_team_access flag is set. The org-teams route's
 * `canDoerManageOrgRepoTeam` port composed from the landed exports (that
 * helper is module-private to the API route); the owner row rides the
 * module's twin read.
 */
export async function canChangeRepoTeamAccess(env: Env, d1: D1Database, repo: RepoRow, viewer: Viewer): Promise<boolean> {
  if (viewer.kind !== "user") return false;
  if (viewer.isAdmin) return true;
  const ownerRow = await ownerRowOf(d1, repo);
  if (ownerRow === null || ownerRow.type !== "org" || repo.ownerId === null) return false;
  if (await new OrgService(d1).isOrgOwner(repo.ownerId, viewer.id)) return true;
  if (!ownerRow.repoAdminChangeTeamAccess) return false;
  return canAdminRepo(env, repo, viewer);
}

/** Load the panel (§3.2): the landed collaborators read, the owner row, and
 *  — org-owned repos only — the landed GetRepoTeams read
 *  (`listRepoTeams`, the GET /repos/{owner}/{repo}/teams arm). */
export async function loadCollaborationData(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  viewer: Viewer,
): Promise<CollaborationData> {
  const listing = await listRepoCollaborators(d1, repo.id, 1, COLLABORATORS_RENDER_LIMIT);
  const ownerRow = await ownerRowOf(d1, repo);
  const ownerIsOrg = ownerRow !== null && ownerRow.type === "org";
  const teams =
    ownerIsOrg && repo.ownerId !== null ? await new TeamsService(d1).listRepoTeams(repo.ownerId, repo.id) : [];
  const canChangeTeams = ownerIsOrg ? await canChangeRepoTeamAccess(env, d1, repo, viewer) : false;
  return { collaborators: listing.items, teams, ownerIsOrg, canChangeTeams };
}

// ---------------------------------------------------------------------------
// Write paths (upstream CollaborationPost / ChangeCollaborationAccessMode /
// DeleteCollaboration / AddTeamPost / DeleteTeam over the landed services)
// ---------------------------------------------------------------------------

export type CollabWriteOutcome =
  | { outcome: "applied" }
  /** The empty-name / owner-themself arms (and the covered-team no-ops):
   *  upstream redirects silently. */
  | { outcome: "silent" }
  | { outcome: "refused"; message: string };

/**
 * The add-collaborator write — upstream CollaborationPost's exact refusal
 * order (collaboration.go:52-121) onto the landed services, then the
 * `write`-default upsert (AddOrUpdateCollaborator's default mode).
 */
export async function addCollaboratorFromForm(
  d1: D1Database,
  repo: RepoRow,
  name: string,
  now: Date,
): Promise<CollabWriteOutcome> {
  const trimmed = name.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed === repo.ownerNamespace.toLowerCase()) return { outcome: "silent" };
  const target = await findUserByName(d1, trimmed);
  if (target === null) return { outcome: "refused", message: collabLocale.err_user_not_exist };
  if (target.status !== "active") return { outcome: "refused", message: collabLocale.err_inactive_user };
  if (target.type === "org") return { outcome: "refused", message: collabLocale.err_org_collaborator };
  if (await isCollaborator(d1, repo.id, target.id)) {
    return { outcome: "refused", message: collabLocale.err_duplicate };
  }
  const ownerRow = await ownerRowOf(d1, repo);
  if (ownerRow !== null && ownerRow.type === "org" && repo.ownerId !== null) {
    if (await new OrgService(d1).isOrgOwner(repo.ownerId, target.id)) {
      return { outcome: "refused", message: collabLocale.err_org_owner };
    }
  }
  if (
    repo.ownerId !== null &&
    ((await isBlockedBy(d1, target.id, repo.ownerId)) || (await isBlockedBy(d1, repo.ownerId, target.id)))
  ) {
    return { outcome: "refused", message: collabLocale.err_blocked };
  }
  await addOrUpdateCollaborator(d1, repo.id, target.id, "write", now);
  return { outcome: "applied" };
}

/** Parse the access-mode form's `mode` value (the service's enum literals —
 *  the module-header divergence from upstream's 1|2|3 ints). */
export function parseAccessModeValue(raw: string | null): CollaboratorMode | null {
  if (raw === "read" || raw === "write" || raw === "admin") return raw;
  return null;
}

/**
 * The access-mode write — upstream ChangeCollaborationAccessMode: the uid +
 * mode form onto the same upsert. An unknown uid or a junk mode is the
 * refused arm (upstream answers 400; the no-JS form's failure re-renders
 * with the message).
 */
export async function changeAccessModeFromForm(
  d1: D1Database,
  repo: RepoRow,
  form: URLSearchParams,
  now: Date,
): Promise<CollabWriteOutcome> {
  const uid = Number.parseInt(form.get("uid") ?? "", 10);
  const mode = parseAccessModeValue(form.get("mode"));
  if (!Number.isInteger(uid) || uid <= 0 || mode === null) {
    return { outcome: "refused", message: collabLocale.err_user_not_exist };
  }
  // Upstream ChangeCollaborationAccessMode runs GetUserByID(uid) FIRST and
  // answers 400 — a positive uid naming no user must refuse, not silently
  // upsert an orphan row (the table carries no FK; the collaboration
  // matrix's RED).
  const target = await drizzle(d1).select({ id: users.id }).from(users).where(eq(users.id, uid)).get();
  if (target === undefined) {
    return { outcome: "refused", message: collabLocale.err_user_not_exist };
  }
  await addOrUpdateCollaborator(d1, repo.id, uid, mode, now);
  return { outcome: "applied" };
}

/**
 * The remove write — upstream DeleteCollaboration: the `id` form field is
 * the USER id (GetUserByID); a known user's absent collaboration deletes
 * zero rows and still succeeds (the idempotent arm).
 */
export async function removeCollaboratorFromForm(d1: D1Database, repo: RepoRow, form: URLSearchParams): Promise<CollabWriteOutcome> {
  const id = Number.parseInt(form.get("id") ?? "", 10);
  if (!Number.isInteger(id) || id <= 0) return { outcome: "refused", message: collabLocale.err_user_not_exist };
  const target = await findUserById(d1, id);
  if (target === null) return { outcome: "refused", message: collabLocale.err_user_not_exist };
  await deleteCollaborator(d1, repo.id, target.id);
  return { outcome: "applied" };
}

/** The page-module twin read of upstream GetUserByID (no exported
 *  user-by-id read exists — the ownerRowOf pattern). */
async function findUserById(d1: D1Database, id: number): Promise<UserRow | null> {
  const row = await drizzle(d1).select().from(users).where(eq(users.id, id)).get();
  return row ?? null;
}

/**
 * The add-team write — upstream AddTeamPost: the `team` name form onto
 * `getTeamByName` (the (org_id, lower_name) scoping IS upstream's
 * team-not-in-organization arm) and the landed `addTeamRepo` (its covered /
 * includes-all no-ops upstream's HasTeamRepo re-check; the explicit
 * duplicate refusal renders the flash text).
 */
export async function addTeamFromForm(d1: D1Database, repo: RepoRow, form: URLSearchParams): Promise<CollabWriteOutcome> {
  const name = (form.get("team") ?? "").trim().toLowerCase();
  if (name.length === 0 || repo.ownerId === null) return { outcome: "silent" };
  const service = new TeamsService(d1);
  const team = await service.getTeamByName(repo.ownerId, name);
  if (team === null) return { outcome: "refused", message: collabLocale.err_team_not_exist };
  if (await service.hasTeamRepo(team, repo.id)) return { outcome: "refused", message: collabLocale.err_team_duplicate };
  await service.addTeamRepo(team, repo.id);
  return { outcome: "applied" };
}

/**
 * The remove-team write — upstream DeleteTeam: the `id` form field is the
 * TEAM id (GetTeamByID); the landed `removeTeamRepo` no-ops the
 * includes-all / not-covered states silently (upstream's own arms).
 */
export async function removeTeamFromForm(d1: D1Database, repo: RepoRow, form: URLSearchParams): Promise<CollabWriteOutcome> {
  const id = Number.parseInt(form.get("id") ?? "", 10);
  if (!Number.isInteger(id) || id <= 0) return { outcome: "refused", message: collabLocale.err_team_not_exist };
  const team = await new TeamsService(d1).getTeamById(id);
  if (team === null) return { outcome: "refused", message: collabLocale.err_team_not_exist };
  await new TeamsService(d1).removeTeamRepo(team, repo.id);
  return { outcome: "applied" };
}

// ---------------------------------------------------------------------------
// Components (collaboration.tmpl's DOM, the reductions in the header)
// ---------------------------------------------------------------------------

/** Upstream `User.DisplayNameWithFullName` (models/user/user.go:496-501). */
function displayNameWithFullName(user: UserRow): string {
  const fullName = (user.fullName ?? "").trim();
  return fullName === "" ? user.username : `${user.username} (${fullName})`;
}

/** The team access line — upstream collaboration.tmpl's AccessMode ladder
 *  over this schema's authorize enum (none → the per-unit text, the else
 *  arm). */
function teamModeText(team: TeamRecord): string {
  switch (team.authorize) {
    case "owner":
      return "Owner"; // "repo.settings.collaboration.owner"
    case "admin":
      return "Administrator"; // "repo.settings.collaboration.admin"
    case "write":
      return collabLocale.mode_write;
    case "read":
      return collabLocale.mode_read;
    default:
      return collabLocale.mode_per_unit;
  }
}

/** The read-side team's Units line (upstream's `lt .AccessMode 2` arm) —
 *  from the stored units_map JSON only (the module-header reduction). */
function teamUnitsLine(team: TeamRecord): string | null {
  if (team.authorize === "write" || team.authorize === "admin" || team.authorize === "owner") return null;
  if (team.unitsMap === null) return null;
  let keys: string[] = [];
  try {
    const parsed: unknown = JSON.parse(team.unitsMap);
    if (Array.isArray(parsed)) keys = parsed.map(String);
    else if (typeof parsed === "object" && parsed !== null) keys = Object.keys(parsed);
  } catch {
    return null;
  }
  const names = keys.map((key) => TEAM_UNIT_NAMES[key] ?? key);
  return `${collabLocale.units} ${names.length > 0 ? names.join(", ") : collabLocale.units_none}`;
}

/** One collaborator row (the avatar-slot reduction — the name anchor
 *  navigates; the trailing controls are the no-JS forms). */
function CollaboratorRow(props: { repoLink: string; row: { user: UserRow; mode: CollaboratorMode } }) {
  const { repoLink, row } = props;
  const username = row.user.username;
  return (
    <div class="item tw-items-center">
      <div class="item-leading">
        <span class="ui avatar" aria-hidden="true">
          <Icon name="octicon-person" size={32} />
        </span>
      </div>
      <div class="item-main">
        <div class="item-title">
          <a class="text muted" href={userLink(username)}>
            {displayNameWithFullName(row.user)}
          </a>
        </div>
      </div>
      <div class="item-trailing">
        <div class="flex-text-block">
          <Icon name="octicon-shield-lock" />
          <form class="flex-text-block" method="post" action={`${repoLink}/settings/collaboration/access_mode`}>
            <input type="hidden" name="uid" value={row.user.id} />
            <select class="ui small dropdown" name="mode" aria-label={`Access mode for ${username}`}>
              <option value="admin" selected={row.mode === "admin"}>
                {collabLocale.mode_admin}
              </option>
              <option value="write" selected={row.mode === "write"}>
                {collabLocale.mode_write}
              </option>
              <option value="read" selected={row.mode === "read"}>
                {collabLocale.mode_read}
              </option>
            </select>
            <button class="ui tiny button" type="submit">
              {collabLocale.save}
            </button>
          </form>
        </div>
        <form method="post" action={`${repoLink}/settings/collaboration/delete`}>
          <input type="hidden" name="id" value={row.user.id} />
          <button class="ui red tiny button" type="submit">
            {collabLocale.remove}
          </button>
        </form>
      </div>
    </div>
  );
}

/** One team row (the id-keyed team link — the org-teams divergence; the
 *  trailing Remove gated and includes-all-disabled like upstream). */
function TeamRow(props: { repoLink: string; orgLink: string; team: TeamRecord; canChange: boolean }) {
  const { repoLink, orgLink, team, canChange } = props;
  const unitsLine = teamUnitsLine(team);
  return (
    <div class="item">
      <div class="item-main">
        <a class="item-title tw-text-primary" href={`${orgLink}/teams/${team.id}`}>
          {team.name}
        </a>
        <div class="item-body flex-text-block">
          <Icon name="octicon-shield-lock" /> {teamModeText(team)}
        </div>
        {unitsLine !== null ? <div class="item-body">{unitsLine}</div> : null}
      </div>
      {canChange ? (
        <div class="item-trailing">
          <form method="post" action={`${repoLink}/settings/collaboration/team/delete`}>
            <input type="hidden" name="id" value={team.id} />
            <button
              class="ui red tiny button"
              type="submit"
              disabled={team.includesAllRepositories}
              title={team.includesAllRepositories ? collabLocale.delete_team_tip : undefined}
            >
              {collabLocale.remove}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module; the error/collaborator options carry the POST
 *  re-render's message and kept submission, the settings-page convention). */
export function renderCollaborationPage(
  ctx: UiContext,
  data: CollaborationData,
  options: { error: string | null; collaborator: string },
): string {
  return renderPage(<CollaborationPage ctx={ctx} data={data} error={options.error} collaborator={options.collaborator} />);
}

/** The panel (§2.4.1 discriminator: `repository settings collaboration`). */
export function CollaborationPage(props: {
  ctx: UiContext;
  data: CollaborationData;
  error: string | null;
  collaborator: string;
}) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("CollaborationPage requires ctx.repo (BaseLayout renders it only when resolved)");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={collabLocale.collaborators} pageClass="repository settings collaboration">
      <div class="ui container flex-container">
        {/* The repo row arms the conditional Public Access item
            (navbar.tmpl:7-11 — the wave-settingsnav-fold's disclosed gap on
            this call site closed; like the five folded tabs the grant arm
            reduces to the visibility arm — this page loads no repo_units
            row, and loadRepoPublicAccess's read stays the public-access
            page's loader). */}
        <SettingsNav repoLink={repoLink} active="collaboration" repo={repo} />
        <div class="flex-container-main">
          <div class="repo-setting-content">
            {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
            <h4 class="ui top attached header">{collabLocale.collaborators}</h4>
            {data.collaborators.length > 0 ? (
              <div class="ui attached segment">
                <div class="flex-divided-list items-with-main">
                  {data.collaborators.map((row) => (
                    <CollaboratorRow key={row.user.id} repoLink={repoLink} row={row} />
                  ))}
                </div>
              </div>
            ) : null}
            <div class="ui bottom attached segment">
              <form class="ui form flex-text-block" id="repo-collab-form" action={`${repoLink}/settings/collaboration`} method="post">
                <div id="search-user-box" class="ui search input">
                  <input
                    class="prompt"
                    name="collaborator"
                    placeholder={collabLocale.search_users}
                    autocomplete="off"
                    value={props.collaborator}
                    required
                  />
                </div>
                <button type="submit" class="ui primary button">
                  {collabLocale.add_collaborator}
                </button>
              </form>
            </div>

            {data.ownerIsOrg ? (
              <>
                <h4 class="ui top attached header">{collabLocale.teams}</h4>
                {data.teams.length > 0 ? (
                  <div class="ui attached segment">
                    <div class="flex-divided-list items-with-main">
                      {data.teams.map((team) => (
                        <TeamRow
                          key={team.id}
                          repoLink={repoLink}
                          orgLink={`/${repo.ownerNamespace}`}
                          team={team}
                          canChange={data.canChangeTeams}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                <div class="ui bottom attached segment">
                  {data.canChangeTeams ? (
                    <form
                      class="ui form flex-text-block"
                      id="repo-collab-team-form"
                      action={`${repoLink}/settings/collaboration/team`}
                      method="post"
                    >
                      <div id="search-team-box" class="ui search input">
                        <input class="prompt" name="team" placeholder={collabLocale.search_teams} autocomplete="off" required />
                      </div>
                      <button type="submit" class="ui primary button">
                        {collabLocale.add_team}
                      </button>
                    </form>
                  ) : (
                    <div class="item">{collabLocale.change_team_restricted}</div>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

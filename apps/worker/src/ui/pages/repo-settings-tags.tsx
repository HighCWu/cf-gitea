/**
 * The repo settings PROTECTED TAGS panel — the bench-row UNMOUNTED module
 * (the repo-settings-wiki precedent: a sibling owns `index.ts`, this module
 * ships without a route — the handoff note at the bottom of this header).
 * The `/settings/tags` surface over the LANDED
 * `/repos/{owner}/{repo}/tag_protections` API arms (routes/tag-protections.ts
 * — the 5 frozen operations repoListTagProtection / repoGetTagProtection /
 * repoCreateTagProtection / repoEditTagProtection / repoDeleteTagProtection,
 * commit a80878c) and services/tag-protection.ts over the 0025
 * `protected_tags` store.
 *
 * ## Premise verification (at the pin) — both verified, one corrected
 *
 * VERIFIED: handlers `repo_setting.ProtectedTags` + `NewProtectedTagPost` +
 * `DeleteProtectedTagPost` + `EditProtectedTag` + `EditProtectedTagPost` at
 * `gitea/routers/web/web.go:1215-1221` (routers/web/repo/setting/
 * protected_tag.go; template constant `repo/settings/tags` at
 * protected_tag.go:27; template `gitea/templates/repo/settings/tags.tmpl`).
 * CORRECTED: the brief's "priority" in the rules list — the TAG family
 * carries NO priority (services/tag-protection.ts header: "Unlike the branch
 * family there is NO priority"; the 0025 table has no priority column).
 * Priority is the BRANCH family's arm; the tag table renders Pattern |
 * Allowed | actions, in id order (listProtectedTags' asc(id) — the insertion
 * order the renders echo).
 *
 * ## Gating (the brief's writer-vs-admin question → ADMIN everywhere)
 *
 * The whole `/settings` group closes behind `reqSignIn, context.RepoAssignment,
 * reqRepoAdmin` (web.go:1286) — all FIVE tag routes, GETs and POSTs alike,
 * are repo-ADMIN-only upstream; there is no writer arm to mirror. Ours: the
 * shared settingsGate posture (anonymous → the login 303; a signed-in
 * non-admin → the 404 shell — equally undiscoverable). `context.
 * RepoMustNotBeArchived()` rides the three POST arms ONLY (web.go:1216,1218,
 * 1220 — create, delete, edit); the GETs render on archived repos with the
 * template's warning arm instead of the content
 * (tags.tmpl's IsArchived branch, `repo.settings.archive.tagsettings_unavailable`).
 *
 * ## DOM contract (templates/repo/settings/{tags,navbar}.tmpl at the pin)
 *
 * layout_head's pageClass is the literal `repository settings edit` (the
 * branches-list literal — the two surfaces share it at this pin). ONE page
 * serves list AND form (upstream renders both in tags.tmpl; the edit GET is
 * the same template with the form filled and a Save/Cancel pair): the h4
 * `Tag Protection` header, the form (pattern input `name_pattern` with the
 * `v*` placeholder, the two allowlist fields, the mode-split buttons), then
 * the `ui single line table` — `<pre>` pattern cell, the Allowed cell
 * rendering each allowlisted principal as a label ("No One" when both lists
 * are empty), the Edit anchor + the inline delete form per row, the
 * colspan-3 empty row. The form action is `{{.Link}}` — ctx.Link is the
 * CURRENT request path (services/context/context.go:158), so the create page
 * POSTs `/settings/tags` and the edit page POSTs `/settings/tags/{id}`: the
 * route table splits the arms, the template never changes the action.
 *
 * ## No-JS reductions (documented divergences)
 *
 * - Upstream's user/team multiselect dropdowns (settings/user_dropdown.tmpl +
 *   team_dropdown.tmpl — hidden inputs carrying comma-joined IDs the bundle's
 *   JS fills) render as plain comma-separated NAME inputs: the landed family
 *   resolves name arrays at the edge with upstream's exact 422 texts
 *   (routes/tag-protections.ts resolveUserIds/resolveTeamIds), so names are
 *   what the no-JS form can express (the branch module's reduction).
 * - Upstream's dropdowns list only the repo's readers / reader-teams
 *   (setTagsContext's GetUsersWithAnyUnitAccess / GetTeamsWithAccessToAnyRepoUnit,
 *   protected_tag.go:155-170); our inputs accept ANY existing non-org name —
 *   the landed family's EXISTENCE-only resolution is the documented
 *   no-sanitization divergence (tag-protections.ts header: stored ids pass
 *   NO access filter), not a readers re-filter.
 * - The Allowed cell's avatar images (ctx.AvatarUtils.Avatar . 26) render as
 *   the plain label text; display name is GetDisplayName's
 *   displayName-else-username, the user label links the `/{username}` home,
 *   the team label links `/{org}/teams/{lowerName}` (OrganisationLink,
 *   models/user/user.go:352-354).
 * - The pattern help's doc link (the %s tail, "Read more in the protected
 *   tags guide") drops — no external docs surface (the branch module's
 *   name_pattern_help precedent).
 *
 * ## Write paths (§3.2 — the landed arms re-played, never a self-fetch)
 *
 * The POST bodies re-play routes/tag-protections.ts's handler bodies over
 * services/tag-protection.ts primitives (the handlers are module-private, so
 * the page module ports their steps with the same guards and order — the
 * branch-protection module's pattern). ApiError messages surface as `invalid`
 * re-render lines (the family convention): create's exact-text 400s
 * ("name_pattern are empty" — the grammatical quirk — and "both
 * whitelist_usernames and whitelist_teams are empty", checked on the RAW
 * arrays before any org scoping), the 403 "Tag protection already exist"
 * exact-pattern pre-check, the 422 resolution texts (the USER text carries
 * the LOWERCASED name; orgs do not resolve — the tag family's
 * GetDoerUserIDsByNames, unlike the branch family's pseudo-principal arm);
 * teams resolve on org-owned repos only, silently dropped otherwise. Edit is
 * the PATCH arm's pointer semantics: name_pattern replaces VERBATIM (no
 * trim, no empty check — an empty stored pattern is legal), teams resolve
 * BEFORE usernames, a submitted array replaces (this form always submits all
 * three fields, so the absent-field keep-arms never trigger); NO collision
 * or empty checks on edit (the arm has none). Delete is the repo-scoped
 * guard + row delete. NOTE the deliberate posture difference from upstream's
 * WEB posts (which only HTML5-require the input and never 400/403): this
 * module replays the LANDED API arms — the stricter, exact-text validation
 * is the brief's ask.
 *
 * Success flashes are the display-only-param reduction (no session-flash
 * plumbing): every write 303s onto `/settings/tags?saved=1` — upstream's
 * redirect targets all land on `/settings/tags` (NewProtectedTagPost's
 * current-path redirect, EditProtectedTagPost's and DeleteProtectedTagPost's
 * explicit repo.Link()+"/settings/tags") and all three flash
 * `repo.settings.update_settings_success`; the `?saved=1` param carries the
 * flash (the wiki module's reduction), display-only.
 *
 * ## Handoff note (for the `index.ts` window owner — this module has NO route)
 *
 * Mount over the landed settings posture (pages/ui index.ts's
 * branchProtection* handlers are the template — settingsGate order,
 * sameOriginGuard FIRST on every POST, archived POSTs 404-shell):
 *
 *   GET  /{owner}/{repo}/settings/tags          resolveUiRequest →
 *                                               settingsGate →
 *                                               loadProtectedTagRules +
 *                                               loadOwnerIsOrg +
 *                                               (edit ? the id's row +
 *                                               editFormOfTag :
 *                                               emptyTagProtectionForm())
 *                                               → renderTagProtectionPage
 *                                               (`?saved=1` → the flash,
 *                                               display-only)
 *   POST /{owner}/{repo}/settings/tags          sameOriginGuard →
 *                                               resolveUiRequest →
 *                                               settingsGate → archived 404 →
 *                                               parseTagProtectionForm(
 *                                               readUrlEncodedForm) →
 *                                               applyTagProtectionForm →
 *                                               created → 303 onto
 *                                               `/settings/tags?saved=1`;
 *                                               invalid → re-render the page
 *                                               with the kept form + the
 *                                               message
 *   POST /{owner}/{repo}/settings/tags/delete   sameOriginGuard → gate →
 *                                               archived 404 (RepoMustNotBe-
 *                                               Archived, web.go:1218) →
 *                                               form field `id` →
 *                                               deleteTagRuleById → 303 onto
 *                                               `/settings/tags?saved=1`;
 *                                               false → 404 shell
 *   GET  /{owner}/{repo}/settings/tags/{id}     gate → loadTagRuleById →
 *                                               null (unknown/foreign) → 404
 *                                               shell (upstream
 *                                               selectProtectedTagByContext's
 *                                               NotFound) → else render with
 *                                               editFormOfTag + editing set
 *   POST /{owner}/{repo}/settings/tags/{id}     sameOriginGuard → gate →
 *                                               archived 404 → parse →
 *                                               applyTagProtectionForm (the
 *                                               form's id keys the arm) →
 *                                               saved → 303; missing → 404
 *                                               shell; invalid → re-render
 *
 * Nav fold: TagSettingsNav below is MOUNT SCAFFOLDING — fold it into
 * SettingsNav (pages/settings.tsx): extend the `active` union with `"tags"`
 * and insert the item between Branches and Mirror (upstream's exact
 * position: immediately after Branches, navbar.tmpl:21-26); delete this
 * component on landing.
 */

import { and, eq, inArray, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ApiError } from "../../api/errors";
import type { RepositoryWithOwner } from "../../api/services/repository";
import { protectedTags, teams, users } from "../../db/schema";
import {
  findProtectedTagById,
  findProtectedTagByNamePattern,
  listProtectedTags,
  parseAllowlistIds,
  serializeAllowlistIds,
  type ProtectedTagRow,
} from "../../services/tag-protection";
import type { RepoRow, UiContext } from "../ui-context";
import { BaseLayout, renderPage } from "../shell";
import { loadOwnerIsOrg } from "./branch-protection";
import { mirrorLocale, settingsLocale } from "./settings";

/** Page chrome + notes text (component-local, the settingsLocale pattern;
 *  upstream locale keys cited, cf-gitea additions marked). */
export const tagProtectionLocale = {
  tags: "Tags", // "repo.settings.tags" (the navbar item)
  protection: "Tag Protection", // "repo.settings.tags.protection" (the page header)
  pattern: "Tag Pattern", // "repo.settings.tags.protection.pattern"
  pattern_help: "You can use a single name or a glob pattern or regular expression to match multiple tags.", // "repo.settings.tags.protection.pattern.description" — the %s doc-link tail dropped (no external docs surface) — cf-gitea reduction
  allowed: "Allowed", // "repo.settings.tags.protection.allowed" (the table header)
  allowed_users: "Allowed users", // "repo.settings.tags.protection.allowed.users"
  allowed_teams: "Allowed teams", // "repo.settings.tags.protection.allowed.teams"
  noone: "No One", // "repo.settings.tags.protection.allowed.noone"
  create: "Protect Tag", // "repo.settings.tags.protection.create"
  none: "There are no protected tags.", // "repo.settings.tags.protection.none"
  save: "Save", // "save"
  cancel: "Cancel", // "cancel"
  edit: "Edit", // "edit"
  remove: "Remove", // "remove"
  update_settings_success: "The repository settings have been updated.", // "repo.settings.update_settings_success" (the ?saved=1 flash reduction's text)
  archived_unavailable: "Tag settings are not available if the repo is archived.", // "repo.settings.archive.tagsettings_unavailable"
  names_help: "Comma-separated names.", // cf-gitea addition — the dropdown multiselect's no-JS replacement hint
} as const;

// ---------------------------------------------------------------------------
// The read side (§3.2 — the landed list read + the Allowed-cell render)
// ---------------------------------------------------------------------------

/** One Allowed-cell user label: GetDisplayName (displayName-else-username)
 *  over the `/{username}` home link. */
export interface TagRuleListUser {
  id: number;
  displayName: string;
  homeLink: string;
}

/** One Allowed-cell team label over the `/{org}/teams/{lowerName}` link
 *  (OrganisationLink + the teams path, models/user/user.go:352-354). */
export interface TagRuleListTeam {
  id: number;
  name: string;
  teamLink: string;
}

/** One rendered rule row: the stored row plus its allowlists rendered to
 *  labels in id order — vanished principals render as nothing (the API
 *  render's documented nuance, routes/tag-protections.ts renderProtection). */
export interface TagRuleListItem {
  row: ProtectedTagRow;
  users: TagRuleListUser[];
  teams: TagRuleListTeam[];
}

/**
 * The list read (GetProtectedTags' port, protected_tag.go:117-121, through
 * the landed listProtectedTags) + the ids→labels render. NOT the API's
 * username render: the web cell shows display names (upstream
 * {{.GetDisplayName}}), so the lookup carries displayName too. Team labels
 * render on ORG-owned repos only — upstream's template iterates `$.Teams`,
 * which setTagsContext populates only when `ctx.Repo.Owner.IsOrganization`
 * (protected_tag.go:161-170), so a user-owned repo renders team ids as
 * nothing (and its Allowed cell reads "No One" when ONLY team ids are set —
 * the template's `and $.Owner.IsOrganization .AllowlistTeamIDs` arm).
 */
export async function loadProtectedTagRules(d1: D1Database, repo: RepoRow): Promise<TagRuleListItem[]> {
  const rows = await listProtectedTags(d1, repo.id);
  const isOrg = await loadOwnerIsOrg(d1, repo);
  const userIds = [...new Set(rows.flatMap((row) => parseAllowlistIds(row.allowlistUserIds)))].filter((id) => id > 0);
  const userMap = new Map<number, { username: string; displayName: string | null }>();
  if (userIds.length > 0) {
    for (const row of await drizzle(d1)
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, userIds))
      .all()) {
      userMap.set(row.id, row);
    }
  }
  const teamIds = [...new Set(rows.flatMap((row) => parseAllowlistIds(row.allowlistTeamIds)))];
  const teamMap = new Map<number, { name: string; lowerName: string }>();
  if (teamIds.length > 0) {
    for (const row of await drizzle(d1)
      .select({ id: teams.id, name: teams.name, lowerName: teams.lowerName })
      .from(teams)
      .where(inArray(teams.id, teamIds))
      .all()) {
      teamMap.set(row.id, row);
    }
  }
  return rows.map((row) => ({
    row,
    users: parseAllowlistIds(row.allowlistUserIds)
      .filter((id) => id > 0)
      .flatMap((id) => {
        const user = userMap.get(id);
        return user === undefined ? [] : [{ id, displayName: user.displayName ?? user.username, homeLink: `/${user.username}` }];
      }),
    teams: isOrg
      ? parseAllowlistIds(row.allowlistTeamIds).flatMap((id) => {
          const team = teamMap.get(id);
          // OrganisationLink + "/teams/{lowerName}" (user.go:352-354).
          return team === undefined ? [] : [{ id, name: team.name, teamLink: `/org/${repo.ownerNamespace}/teams/${team.lowerName}` }];
        })
      : [],
  }));
}

/** The repo-scoped rule load (selectProtectedTagByContext's guard,
 *  protected_tag.go:174-187: GetProtectedTagByID then the `tag.RepoID ==
 *  repo.ID` compare — a miss or a foreign id is the same null → the route's
 *  404 shell). */
export async function loadTagRuleById(d1: D1Database, repoId: string, id: number): Promise<ProtectedTagRow | null> {
  const row = await findProtectedTagById(d1, id);
  return row !== null && row.repoId === repoId ? row : null;
}

// ---------------------------------------------------------------------------
// The form (tags.tmpl's input names verbatim: `name_pattern`,
// `allowlist_users`, `allowlist_teams`; the dropdowns' comma-joined-ID
// hidden inputs render as comma-separated NAME inputs — the module header)
// ---------------------------------------------------------------------------

export interface TagProtectionForm {
  /** 0 = the create form; >0 the stored rule id under edit (upstream keys
   *  the edit by the URL path id, not a hidden field — the id rides the
   *  route; the form carries it so the POST re-render keeps the arm). */
  id: number;
  namePattern: string;
  allowlistUsers: string;
  allowlistTeams: string;
}

/** Parse one urlencoded POST (the template's input names; a junk `id` reads
 *  as 0 = create — Go's FormInt64 zero). */
export function parseTagProtectionForm(params: URLSearchParams): TagProtectionForm {
  const idRaw = params.get("id") ?? "0";
  return {
    id: /^\d+$/.test(idRaw) ? Number.parseInt(idRaw, 10) : 0,
    namePattern: params.get("name_pattern") ?? "",
    allowlistUsers: params.get("allowlist_users") ?? "",
    allowlistTeams: params.get("allowlist_teams") ?? "",
  };
}

/** The create form's binding — empty pattern, empty lists. */
export function emptyTagProtectionForm(): TagProtectionForm {
  return { id: 0, namePattern: "", allowlistUsers: "", allowlistTeams: "" };
}

/**
 * The stored row as the edit form's binding — ids map to NAMES in id order
 * (the dropdown inputs' rendering, comma-joined), vanished principals render
 * as nothing (never invented — a resubmit drops them exactly like upstream's
 * web form whose dropdowns cannot re-emit a deleted principal).
 */
export async function editFormOfTag(d1: D1Database, row: ProtectedTagRow): Promise<TagProtectionForm> {
  const userIds = [...new Set(parseAllowlistIds(row.allowlistUserIds))].filter((id) => id > 0);
  const userNames = new Map<number, string>();
  if (userIds.length > 0) {
    for (const user of await drizzle(d1).select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds)).all()) {
      userNames.set(user.id, user.username);
    }
  }
  const teamIds = [...new Set(parseAllowlistIds(row.allowlistTeamIds))];
  const teamNames = new Map<number, string>();
  if (teamIds.length > 0) {
    for (const team of await drizzle(d1).select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamIds)).all()) {
      teamNames.set(team.id, team.name);
    }
  }
  const namesOf = (ids: number[], map: Map<number, string>): string =>
    ids
      .map((id) => map.get(id))
      .filter((name): name is string => name !== undefined)
      .join(",");
  return {
    id: row.id,
    namePattern: row.namePattern,
    allowlistUsers: namesOf(userIds, userNames),
    allowlistTeams: namesOf(teamIds, teamNames),
  };
}

// ---------------------------------------------------------------------------
// The write paths (§3.2 — the landed arms re-played over the service
// primitives; the module header carries the arm-by-arm citations)
// ---------------------------------------------------------------------------

/** routes/tag-protections.ts's private resolveUserIds (GetDoerUserIDsByNames,
 *  user.go:1237-1239, allowSystemDoer=false): case-insensitive, EXISTENCE
 *  only, orgs do not resolve (ne(users.type,"org")), NO pseudo-principal arm
 *  (the tag family, unlike the branch family). The 422 text carries the
 *  LOWERCASED name (ErrUserNotExist{Name: nameLower}, user.go:1223). */
async function resolveUserIds(d1: D1Database, names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const row = await drizzle(d1)
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.usernameLower, lower), ne(users.type, "org")))
      .limit(1)
      .get();
    if (row === undefined) {
      throw new ApiError(422, `user does not exist [uid: 0, name: ${lower}]`);
    }
    ids.push(row.id);
  }
  return ids;
}

/** routes/tag-protections.ts's private resolveTeamIds (GetTeamIDsByNames) —
 *  org-scoped, case-insensitive, upstream's exact 422 text. */
async function resolveTeamIds(d1: D1Database, orgId: number, names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const row = await drizzle(d1)
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.orgId, orgId), eq(teams.lowerName, name.toLowerCase())))
      .limit(1)
      .get();
    if (row === undefined) {
      throw new ApiError(422, `team does not exist [org_id ${orgId}, team_id 0, name: ${name}]`);
    }
    ids.push(row.id);
  }
  return ids;
}

/** The comma input's name list — split, trim, drop empties (the branch
 *  module's namesInput; upstream's API arrays carry no blanks to trim — the
 *  web form's comma strings do). */
function namesInput(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

export type TagProtectionResult =
  | { outcome: "created" }
  | { outcome: "saved" }
  | { outcome: "missing" } // the edit id not found in this repo (404 shell)
  | { outcome: "invalid"; message: string };

/**
 * The create-or-edit write (routes/tag-protections.ts's create/PATCH handler
 * bodies re-played — the module header carries the citations). The form's id
 * splits the arms: 0 creates, >0 edits. ApiError 400/403/422 messages
 * surface as `invalid` re-render lines (the family convention); an edit id
 * that is missing or foreign reads `missing` (the 404 shell).
 */
export async function applyTagProtectionForm(d1: D1Database, pair: RepositoryWithOwner, form: TagProtectionForm): Promise<TagProtectionResult> {
  // The arms throw ApiError — caught here so the message re-renders inline
  // (the family convention); unknown errors propagate.
  try {
    return await applyFormArms(d1, pair, form);
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
}

/** The arms' body (applyTagProtectionForm owns the catch). */
async function applyFormArms(d1: D1Database, pair: RepositoryWithOwner, form: TagProtectionForm): Promise<TagProtectionResult> {
  if (form.id === 0) {
    // --- CREATE (repoCreateTagProtection, tag.go:413-481) ------------------
    // TrimSpace + the empty arm (tag.go:416-419) — the exact upstream text,
    // grammatical quirk included.
    const namePattern = form.namePattern.trim();
    if (namePattern === "") {
      throw new ApiError(400, "name_pattern are empty");
    }
    // The RAW-form empty check, BEFORE any org scoping (tag.go:421-424) — a
    // user-repo create naming only teams passes here and stores the silent
    // team drop (the arm's own shape).
    const usersRaw = namesInput(form.allowlistUsers);
    const teamsRaw = namesInput(form.allowlistTeams);
    if (usersRaw.length === 0 && teamsRaw.length === 0) {
      throw new ApiError(400, "both whitelist_usernames and whitelist_teams are empty");
    }
    // The EXACT-pattern collision pre-check (tag.go:426-431) — no UNIQUE
    // constraint backs it (the 0025 table comment).
    if ((await findProtectedTagByNamePattern(d1, pair.repo.id, namePattern)) !== null) {
      throw new ApiError(403, "Tag protection already exist");
    }
    // Usernames resolve before anything writes (tag.go:433-440); teams
    // resolve on ORG-owned repos only, silently dropped otherwise
    // (tag.go:440-448 — no error for a user repo).
    const whitelistUsers = await resolveUserIds(d1, usersRaw);
    const whitelistTeams = pair.owner.type === "org" ? await resolveTeamIds(d1, pair.owner.id, teamsRaw) : [];
    const now = new Date();
    await drizzle(d1).insert(protectedTags).values({
      repoId: pair.repo.id,
      namePattern,
      allowlistUserIds: serializeAllowlistIds(whitelistUsers),
      allowlistTeamIds: serializeAllowlistIds(whitelistTeams),
      createdAt: now,
      updatedAt: now,
    });
    return { outcome: "created" };
  }

  // --- EDIT (repoEditTagProtection's PATCH body, tag.go:486-560) -----------
  const row = await findProtectedTagById(d1, form.id);
  // pt == nil || pt.RepoID != repo.ID (tag.go:495-499) — the 404 shell.
  if (row === null || row.repoId !== pair.repo.id) {
    return { outcome: "missing" };
  }
  // name_pattern is a POINTER: present = REPLACE, verbatim — no trim, no
  // empty check (tag.go:501-503; an empty stored pattern glob-compiles to ^$
  // and matches nothing but the empty tag name). This form always submits
  // the field, so the absent-keep arm never triggers.
  row.namePattern = form.namePattern;
  // Teams resolve BEFORE usernames (tag.go:505-519 then :521-533 — a
  // both-invalid body 422s on the team name first); a submitted array
  // replaces — org-scoped-resolved, or silently [] on a user repo
  // (GetTeamIDsByNames is never called).
  const whitelistTeams = pair.owner.type === "org" ? await resolveTeamIds(d1, pair.owner.id, namesInput(form.allowlistTeams)) : [];
  row.allowlistTeamIds = serializeAllowlistIds(whitelistTeams);
  const whitelistUsers = await resolveUserIds(d1, namesInput(form.allowlistUsers));
  row.allowlistUserIds = serializeAllowlistIds(whitelistUsers);
  // UpdateProtectedTag (AllCols) (tag.go:535-541). NO collision or empty
  // checks on edit (the arm has none; an edit may clear both lists to the
  // "No One" rule).
  await drizzle(d1)
    .update(protectedTags)
    .set({ namePattern: row.namePattern, allowlistUserIds: row.allowlistUserIds, allowlistTeamIds: row.allowlistTeamIds, updatedAt: new Date() })
    .where(eq(protectedTags.id, row.id));
  return { outcome: "saved" };
}

/**
 * The delete write (repoDeleteTagProtection's DELETE body, tag.go:628-637):
 * the repo-scoped guard (pt == nil || pt.RepoID != repo.ID — the same plain
 * 404) then the row delete; false = a missing/foreign id (404 shell). NO
 * archived guard here — the ROUTE carries it (RepoMustNotBeArchived,
 * web.go:1218), the same split as the API family's route-level 423.
 */
export async function deleteTagRuleById(d1: D1Database, pair: RepositoryWithOwner, id: number): Promise<boolean> {
  const row = await findProtectedTagById(d1, id);
  if (row === null || row.repoId !== pair.repo.id) {
    return false;
  }
  await drizzle(d1).delete(protectedTags).where(eq(protectedTags.id, row.id));
  return true;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The full-document render (§2.4.1 discriminator: `repository settings
 *  edit` — tags.tmpl's layout_head literal at this pin, shared with the
 *  branches list page). */
export function renderTagProtectionPage(options: { ctx: UiContext; data: TagProtectionPageData; error: string | null }): string {
  return renderPage(<TagProtectionPage ctx={options.ctx} data={options.data} error={options.error} />);
}

/** The page's render inputs: the rules list, the org gate for the team
 *  field, the form binding (the create-empty binding, the stored values on
 *  an edit GET, the kept submission on a re-render) and the rule under edit
 *  (null = the create form — the mode splits the buttons and the action,
 *  {{.Link}}'s current-path semantics). */
export interface TagProtectionPageData {
  rules: TagRuleListItem[];
  isOrg: boolean;
  form: TagProtectionForm;
  editing: ProtectedTagRow | null;
  /** The `?saved=1` flash reduction — display-only (the module header). */
  saved: boolean;
}

/**
 * The settings navbar with the Tags item — MOUNT SCAFFOLDING ONLY (the
 * handoff note): the literal `SettingsNav` DOM (pages/settings.tsx) with the
 * Tags item between Branches and Mirror (upstream's exact position,
 * navbar.tmpl:21-26) and active. The other items' texts import the owner's
 * locale objects; when the index.ts window folds this into `SettingsNav`
 * (the `active` union + the item), delete this component.
 */
export function TagSettingsNav(props: { repoLink: string }) {
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{settingsLocale.settings}</div>
        <a class="item" href={`${props.repoLink}/settings`}>
          {settingsLocale.options}
        </a>
        <a class="item" href={`${props.repoLink}/settings/collaboration`}>
          {settingsLocale.collaboration}
        </a>
        <a class="item" href={`${props.repoLink}/settings/hooks`}>
          {settingsLocale.hooks}
        </a>
        <a class="item" href={`${props.repoLink}/settings/branches`}>
          {settingsLocale.branches}
        </a>
        <a class="active item" href={`${props.repoLink}/settings/tags`}>
          {tagProtectionLocale.tags}
        </a>
        <a class="item" href={`${props.repoLink}/settings/mirror`}>
          {mirrorLocale.mirror_settings}
        </a>
      </div>
    </div>
  );
}

/** One allowlist names field (the dropdown multiselect's no-JS replacement —
 *  the module header). */
function NamesField(props: { id: string; name: string; label: string; value: string }) {
  return (
    <div class="whitelist field">
      <label for={props.id}>{props.label}</label>
      <input id={props.id} name={props.name} type="text" value={props.value} autocomplete="off" />
      <p class="help">{tagProtectionLocale.names_help}</p>
    </div>
  );
}

export function TagProtectionPage(props: { ctx: UiContext; data: TagProtectionPageData; error: string | null }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("TagProtectionPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const editing = data.editing !== null;
  // {{.Link}} — ctx.Link is the CURRENT request path (services/context/
  // context.go:158): the create page posts /settings/tags, the edit page
  // posts /settings/tags/{id}.
  const formAction = editing ? `${repoLink}/settings/tags/${data.editing!.id}` : `${repoLink}/settings/tags`;
  return (
    <BaseLayout ctx={ctx} title={tagProtectionLocale.tags} pageClass="repository settings edit">
      <div class="ui container flex-container">
        <TagSettingsNav repoLink={repoLink} />
        <div class="flex-container-main">
          {repo.isArchived ? (
            // tags.tmpl's IsArchived arm: the warning INSTEAD of the form
            // and the table (the whole protected-tags surface is
            // unavailable on an archived repo).
            <div class="ui warning message tw-text-center">{tagProtectionLocale.archived_unavailable}</div>
          ) : (
            <>
              <h4 class="ui top attached header">{tagProtectionLocale.protection}</h4>
              <div class="ui attached segment">
                <div class="ui grid">
                  <div class="sixteen wide column">
                    <div class="ui segment">
                      <form class="ui form" action={formAction} method="post">
                        {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
                        {data.saved ? <div class="ui info message">{tagProtectionLocale.update_settings_success}</div> : null}
                        <div class="field">
                          <label for="name_pattern">{tagProtectionLocale.pattern}</label>
                          <input id="name_pattern" name="name_pattern" type="text" autocomplete="off" value={data.form.namePattern} placeholder="v*" autofocus required />
                          <div class="help">{tagProtectionLocale.pattern_help}</div>
                        </div>
                        <NamesField id="allowlist_users" name="allowlist_users" label={tagProtectionLocale.allowed_users} value={data.form.allowlistUsers} />
                        {data.isOrg ? (
                          <NamesField id="allowlist_teams" name="allowlist_teams" label={tagProtectionLocale.allowed_teams} value={data.form.allowlistTeams} />
                        ) : null}
                        <div class="field">
                          {editing ? (
                            <>
                              <button type="submit" class="ui primary button">
                                {tagProtectionLocale.save}
                              </button>
                              <a class="ui primary button" href={`${repoLink}/settings/tags`}>
                                {tagProtectionLocale.cancel}
                              </a>
                            </>
                          ) : (
                            <button type="submit" class="ui primary button">
                              {tagProtectionLocale.create}
                            </button>
                          )}
                        </div>
                      </form>
                    </div>
                  </div>
                  <div class="sixteen wide column">
                    <table class="ui single line table">
                      <thead>
                        <tr>
                          <th>{tagProtectionLocale.pattern}</th>
                          <th>{tagProtectionLocale.allowed}</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {data.rules.length === 0 ? (
                          <tr class="tw-text-center">
                            <td colspan={3}>{tagProtectionLocale.none}</td>
                          </tr>
                        ) : (
                          data.rules.map((item) => (
                            <tr>
                              <td>
                                <pre>{item.row.namePattern}</pre>
                              </td>
                              <td>
                                {item.users.length > 0 || item.teams.length > 0 ? (
                                  <>
                                    {item.users.map((user) => (
                                      <a class="ui basic label" href={user.homeLink}>
                                        {user.displayName}
                                      </a>
                                    ))}
                                    {item.teams.map((team) => (
                                      <a class="ui basic label" href={team.teamLink}>
                                        {team.name}
                                      </a>
                                    ))}
                                  </>
                                ) : (
                                  tagProtectionLocale.noone
                                )}
                              </td>
                              <td class="tw-text-right">
                                <a class="ui tiny primary button" href={`${repoLink}/settings/tags/${item.row.id}`}>
                                  {tagProtectionLocale.edit}
                                </a>
                                <form class="tw-inline-block" action={`${repoLink}/settings/tags/delete`} method="post">
                                  <input type="hidden" name="id" value={String(item.row.id)} />
                                  <button type="submit" class="ui tiny red button">
                                    {tagProtectionLocale.remove}
                                  </button>
                                </form>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </BaseLayout>
  );
}

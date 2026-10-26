/**
 * The org settings group + the team edit form — pages wave 49 (the parity
 * survey's re-ranked #1: upstream web.go:1011 `org.EditTeam`/`EditTeamPost`/
 * `DeleteTeam` and web.go:1017-1092's `/{org}/settings` group over
 * `gitea/templates/org/settings/{layout_head,navbar,options,options_dangerzone}
 * .tmpl` and `gitea/templates/org/team/new.tmpl` in its edit arm). THE
 * owner/admin family, like every org settings page: each handler answers the
 * landed `requireOrgOwnership` posture (org owner `role='owner'` or site
 * admin — services/orgs.ts:148) collapsed exactly like the org-teams pages —
 * a signed-in non-owner 404-shells (upstream's RequireOwner OrgAssignment
 * NotFound, routers/web/web.go:1016), anonymous 303s onto the login
 * round-trip, a renamed org 307s (the shared org-teams prologue).
 *
 * ## Data (§3.2 — the landed org APIs, never a self-fetch)
 *
 * Every write arm rides a landed op, verified at the registry:
 *
 *   options form      `orgEdit` (PATCH /orgs/{org}) via
 *                     `editOrgProfile` (api/services/orgs.ts) — full_name,
 *                     email, description, website, location AND
 *                     repo_admin_change_team_access AND `visibility` (the
 *                     danger-zone visibility modal's write, upstream's
 *                     separate SettingsChangeVisibilityPost →
 *                     ChangeOrganizationVisibility);
 *   rename modal      `renameOrg` (POST /orgs/{org}/rename) via
 *                     `OrgService.renameOrg` — the whole RenameUser port
 *                     (name rules, the shared-namespace collision, the
 *                     redirect row);
 *   delete modal      `orgDelete` (DELETE /orgs/{org}) via
 *                     `OrgService.deleteOrg` — the repository guard +
 *                     the cascade (memberships, redirects, the users row);
 *   avatar pair       `orgUpdateAvatar`/`orgDeleteAvatar`
 *                     (POST/DELETE /orgs/{org}/avatar) via the
 *                     services/avatars.ts store — the page POSTs multipart
 *                     (upstream AvatarForm) and the module bridges the file
 *                     bytes through `processAvatarImage` + `uploadAvatar`,
 *                     the API arm's exact decode→process→store body;
 *   team edit form    `orgEditTeam` (PATCH /teams/{id}) via
 *                     `TeamsService.editTeam`;
 *   team delete       `orgDeleteTeam` (DELETE /teams/{id}) via
 *                     `TeamsService.deleteTeam`.
 *
 * ## DOM contract
 *
 * The settings page is layout_head.tmpl's `.page-content.organization
 * settings options` → org/header.tmpl (the shared OrgHeader) →
 * `.ui.container.flex-container` carrying org/settings/navbar.tmpl's
 * `.flex-container-nav` menu and the options form. The navbar reduces to the
 * LIVE tabs: Options (this page) + Labels (our landed `/{org}/labels` page —
 * upstream's item targets `{.OrgLink}}/settings/labels`, the documented
 * wave-14 URL divergence; the target exists so the tab stays live); the
 * hooks/applications/blocked_users/packages/actions/audit_logs items have no
 * landed pages and render nothing (the dead-link rule). The org/menu strip
 * the header template includes reduces away on the same convention as the
 * landed org members/teams/labels pages (their headers also drop it — the
 * owner-only Settings item is the menu's only unlanded entry).
 *
 * options.tmpl: the Organization header + attached segment form (full_name
 * maxlength 100, email maxlength 255, description textarea rows=2
 * maxlength 255, website maxlength 255, location maxlength 50, the
 * Permissions checkbox `repo_admin_change_team_access`, the Update Settings
 * submit), then the avatar form (multipart file input + Update Avatar +
 * Delete Current Avatar) and options_dangerzone.tmpl's three rows. The
 * danger zone's `<dialog>` modals are JS `show-modal` buttons upstream — the
 * no-JS faithful port renders each row's action as a `<details>` disclosure
 * wrapping the same form (the owner-project-board dialog reduction); every
 * control stays live.
 *
 * The team edit page is new.tmpl's `organization new team` page in its edit
 * arm (PageIsOrgTeamsNew false): org/header, then the form posting
 * `{.OrgLink}}/teams/{team}/edit` — team_name (required), description,
 * the visibility radio triple with helper texts, can_create_org_repo, the
 * permission radio group and — for a stored per-unit team — the unit rows,
 * plus the Update Settings submit and the red Delete Team button (a real
 * form POST, upstream's link-action + confirm dialog reduced; the
 * delete-confirm `<dialog>` is not reproduced, dead controls are forbidden).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The admin `max_repo_creation` field (options.tmpl's SignedUser.IsAdmin
 *   arm) is not rendered: the landed orgEdit/EditOrgOption carries no such
 *   key and the `users` table has no column — honest-absent, not dead.
 * - The email/description invalid-field error classes render as the generic
 *   banner: the landed orgEdit accepts the strings verbatim (EditOrgOption's
 *   binding-not-mirrored note), so the server-side validation arms
 *   (SettingsPost's Err_Email etc.) do not exist to port.
 * - The team form's `repo_access` radio group (specific/all →
 *   `includes_all_repositories`) is not rendered: the landed editTeam arm
 *   IGNORES that field (only createTeam applies it — the API module's
 *   service note), so posting it would be a dead control. A team's
 *   includes-all flag stays as-created.
 * - The upstream permission radios are none/write/admin ("General Access" =
 *   none, backed by the unit matrix). The landed EditTeamOption's blanket
 *   enum is read/write/admin (no `none` — a none without units 422s), and
 *   there is no landed unit catalog to iterate (the org-teams module's
 *   standing reduction). The form therefore renders read/write/admin
 *   radios checked by the team's `authorize`; a stored per-unit team
 *   (authorize `none`, `units_map` set) renders its STORED units as
 *   per-unit none/read/write radio rows (upstream's matrix restricted to
 *   the units it can prove) with `units_present=1`, and the blanket radios
 *   stay unchecked — checking one converts the team to that blanket mode
 *   (upstream's ParseAccessMode-first order: form.Permission wins over the
 *   units). New units cannot be added from the form (no catalog).
 * - The team delete and avatar writes redirect silently on both arms
 *   (upstream Flash.Success/Flash.Error + unconditional JSONRedirect; no
 *   session-flash plumbing exists — the user-settings reduction). The
 *   rename/delete CONFIRM arms re-render at 200 with the banner (upstream
 *   JSONError into the modal form — the org-labels typed-422 convention).
 * - The avatar widget renders the live `/user/avatar/{org}/{size}` image
 *   (the landed avatar-serving seam serves org rows — user AND org rows
 *   share the `u_` namespace) beside the file input; the JS crop widget is
 *   not reproduced. The org header's own placeholder glyph is org-home.tsx's
 *   landed shape, not this module's file.
 * - The owner-team arms of new.tmpl (hidden/disabled name, the fixed
 *   visibility label) are dead code here: the §3.3 owners-team bridge keeps
 *   no Owners team row (the org-teams module header) — no team can be the
 *   owner team.
 */

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { EditOrgOption } from "../../api/models/organization";
import { editOrgProfile } from "../../api/services/orgs";
import { TeamsService, type EditTeamOption, type TeamRecord } from "../../api/routes/org-teams";
import { repositories } from "../../db/schema";
import {
  deleteAvatar,
  MAX_AVATAR_WIRE_BYTES,
  processAvatarImage,
  uploadAvatar,
  AvatarOriginTooLargeError,
} from "../../services/avatars";
import {
  LastOrgOwnerError,
  OrgError,
  OrgNameCollisionError,
  OrgNamePatternNotAllowedError,
  OrgNameReservedError,
} from "../../services/orgs/errors";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import type { Child } from "hono/jsx";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { orgDisplayName, OrgHeader } from "./org-home";

/** Page chrome text (component-local, the orgTeamsLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const orgSettingsLocale = {
  settings: "Settings", // "org.settings" (the navbar header)
  options: "Organization", // "org.settings.options" (the Options tab + header)
  labels: "Labels", // "repo.labels" (the one other live tab)
  full_name: "Organization Full Name", // "org.org_full_name_holder"
  email: "Contact Email Address", // "org.settings.email"
  description: "Description", // "org.org_desc"
  website: "Website", // "org.settings.website"
  location: "Location", // "org.settings.location"
  permissions: "Permissions", // "org.settings.permission"
  repoadminchangeteam: "Repository admin can add and remove access for teams", // "org.settings.repoadminchangeteam"
  update_settings: "Update Settings", // "org.settings.update_settings"
  choose_new_avatar: "Choose new avatar", // "settings.choose_new_avatar"
  update_avatar: "Update Avatar", // "settings.update_avatar"
  delete_current_avatar: "Delete Current Avatar", // "settings.delete_current_avatar"
  danger_zone: "Danger Zone", // "repo.settings.danger_zone"
  visibility: "Visibility", // "org.settings.visibility"
  visibility_desc: "Change who can view the organization and its repositories.", // "org.settings.visibility_desc"
  change_visibility: "Change Visibility", // "org.settings.change_visibility"
  visibility_public: "Public", // "org.settings.visibility.public"
  visibility_limited: "Limited (Visible to authenticated users only)", // "org.settings.visibility.limited"
  visibility_private: "Private (Visible only to organization members)", // "org.settings.visibility.private"
  rename: "Rename Organization", // "org.settings.rename"
  rename_desc:
    "Changing the organization name will also change your organization's URL and free the old name.", // "org.settings.rename_desc"
  rename_new_org_name: "New Organization Name", // "org.settings.rename_new_org_name"
  name_confirm: "Enter the organization name as confirmation:", // "org.settings.name_confirm"
  delete_account: "Delete This Organization", // "org.settings.delete_account"
  delete_prompt:
    "The organization will be permanently removed. This CANNOT be undone!", // "org.settings.delete_prompt" (strong stripped)
  org_name_holder: "Organization Name", // "org.org_name_holder"
  // The confirm-arm texts (upstream JSONError/RenderWithErr messages).
  invalid_org_name: "The organization name you entered is incorrect.", // "form.enterred_invalid_org_name"
  org_still_own_repo:
    "This organization still owns one or more repositories. Delete or transfer them first.", // "form.org_still_own_repo"
  org_still_own_packages: "Packages need to be deleted first.", // "form.org_still_own_packages" (the packages model is FEATURE-ABSENT; the branch is unreachable but the text is kept for the cascade's parity)
  rename_no_change: "Organization name is not changed.", // "org.settings.rename_no_change"
  delete_notices_1: "This operation CANNOT be undone.", // "org.settings.delete_notices_1" (strong stripped)
  delete_failed: "Deleting organization failed due to an internal error", // "org.settings.delete_failed"
  // --- team edit (new.tmpl edit arm) ---
  team_settings: "Settings", // "org.teams.settings" (the form header + the sidebar button)
  team_name: "Team Name", // "org.team_name"
  team_name_helper: "Team names should be short and memorable.", // "org.team_name_helper"
  team_name_required: "Team name is required.", // cf-gitea addition — the web-bind Required arm the landed edit arm lacks (it skips empty names)
  team_desc: "Description", // "org.team_desc"
  team_desc_helper: "Describe the purpose or role of the team.", // "org.team_desc_helper"
  team_visibility: "Visibility", // "org.teams.visibility"
  team_visibility_private: "Private", // "org.teams.visibility_private"
  team_visibility_limited: "Limited", // "org.teams.visibility_limited"
  team_visibility_public: "Public", // "org.teams.visibility_public"
  team_visibility_private_helper: "Visible only to team members and organization owners.", // "org.teams.visibility_private_helper"
  team_visibility_limited_helper: "Visible to all members of this organization.", // "org.teams.visibility_limited_helper"
  team_visibility_public_helper: "Visible to any signed-in user.", // "org.teams.visibility_public_helper"
  team_access_desc: "Repository access", // "org.team_access_desc" — the dropped repo_access group's label, kept for the note-only rendering
  team_can_create_org_repo: "Create repositories", // "org.teams.can_create_org_repo"
  team_permission_desc: "Permission", // "org.team_permission_desc"
  team_read_access: "Read", // "org.teams.read_access"
  team_write_access: "Write", // "org.teams.write_access"
  team_admin_access: "Administrator Access", // "org.teams.admin_access"
  team_unit_desc: "Allow Access to Repository Sections", // "org.team_unit_desc"
  unit: "Unit", // "units.unit"
  team_none_access: "No Access", // "org.teams.none_access"
  team_update_settings: "Update Settings", // "org.teams.update_settings"
  team_delete: "Delete Team", // "org.teams.delete_team"
  team_name_been_taken: "The team name is already taken.", // "form.team_name_been_taken"
} as const;

// ---------------------------------------------------------------------------
// The options form + the danger-zone writes (the landed org arms)
// ---------------------------------------------------------------------------

/** The options form's fields (upstream UpdateOrgSettingForm minus the
 *  admin-only max_repo_creation — no landed column). */
export interface OrgSettingsForm {
  fullName: string;
  email: string;
  description: string;
  website: string;
  location: string;
  repoAdminChangeTeamAccess: boolean;
}

/** Parse the urlencoded options POST (the upstream options.tmpl field names;
 *  an unchecked checkbox is ABSENT, not false-valued). */
export function parseOrgSettingsForm(params: URLSearchParams): OrgSettingsForm {
  return {
    fullName: params.get("full_name") ?? "",
    email: params.get("email") ?? "",
    description: params.get("description") ?? "",
    website: params.get("website") ?? "",
    location: params.get("location") ?? "",
    repoAdminChangeTeamAccess: params.get("repo_admin_change_team_access") !== null,
  };
}

/**
 * The options write through the landed `editOrgProfile` (the exact arm PATCH
 * /orgs/{org} serves): empty strings CLEAR (the Go-pointer empty-vs-absent
 * semantics — the form always posts every field, upstream's UpdateOptions
 * included). The stored row is re-read and returned so a 303 round-trip
 * renders fresh values.
 */
export async function applyOrgSettingsForm(d1: D1Database, org: OrgRecord, form: OrgSettingsForm): Promise<OrgRecord> {
  const patch: EditOrgOption = {
    full_name: form.fullName,
    email: form.email,
    description: form.description,
    website: form.website,
    location: form.location,
    repo_admin_change_team_access: form.repoAdminChangeTeamAccess,
  };
  return editOrgProfile(d1, org, patch);
}

/** The rename form's fields (upstream RenameOrgForm: the confirmation field
 *  plus the new name). */
export interface OrgRenameForm {
  orgName: string;
  newOrgName: string;
}

export function parseOrgRenameForm(params: URLSearchParams): OrgRenameForm {
  return { orgName: params.get("org_name") ?? "", newOrgName: params.get("new_org_name") ?? "" };
}

export type OrgRenameResult =
  | { outcome: "applied"; org: OrgRecord }
  | { outcome: "invalid"; message: string };

/**
 * The rename write (upstream SettingsRenamePost over the landed
 * `OrgService.renameOrg` — the RenameUser port): the confirmation-name guard
 * first, the no-change refusal, then the name rules through the typed org
 * errors (upstream's IsErrUserAlreadyExist / IsErrNameReserved /
 * IsErrNamePatternNotAllowed messages).
 */
export async function applyOrgRenameForm(d1: D1Database, org: OrgRecord, form: OrgRenameForm): Promise<OrgRenameResult> {
  if (form.orgName !== org.username) {
    return { outcome: "invalid", message: orgSettingsLocale.invalid_org_name };
  }
  if (form.newOrgName === org.username) {
    return { outcome: "invalid", message: orgSettingsLocale.rename_no_change };
  }
  try {
    const renamed = await new OrgService(d1).renameOrg(org.id, form.newOrgName);
    return { outcome: "applied", org: renamed };
  } catch (error) {
    return { outcome: "invalid", message: renameErrorMessage(error, form.newOrgName) };
  }
}

/** Upstream SettingsRenamePost's error ladder (setting.go:494-506) over the
 *  typed org errors. */
function renameErrorMessage(error: unknown, newName: string): string {
  if (error instanceof OrgNameCollisionError) {
    return `The organization name "${newName}" has already been taken.`; // org.form.name_been_taken
  }
  if (error instanceof OrgNameReservedError) {
    return `The organization name "${newName}" is reserved.`; // org.form.name_reserved
  }
  if (error instanceof OrgNamePatternNotAllowedError) {
    return `The pattern "${newName}" is not allowed in an organization name.`; // org.form.name_pattern_not_allowed
  }
  if (error instanceof OrgError) {
    // The remaining name rules (chars/too-long) carry upstream's rule texts.
    return error.message;
  }
  return "Renaming organization failed because of an internal error"; // org.settings.rename_failed
}

/** The delete form's single confirmation field (upstream's `org_name`). */
export interface OrgDeleteForm {
  orgName: string;
}

export function parseOrgDeleteForm(params: URLSearchParams): OrgDeleteForm {
  return { orgName: params.get("org_name") ?? "" };
}

export type OrgDeleteResult = { outcome: "deleted" } | { outcome: "invalid"; message: string };

/**
 * The delete write (upstream SettingsDeleteOrgPost over the landed
 * `OrgService.deleteOrg`): the confirmation guard, the still-owns-repos
 * refusal (upstream's IsErrUserOwnRepos branch — the landed service raises
 * it as an UNTYPED error by design, so the web arm pre-checks the same COUNT
 * the service does; the service remains the enforcing guard), then the
 * cascade. Packages/projects notices (delete_notices_3/4) are dead upstream
 * arms here — neither model exists (FEATURE-ABSENT).
 */
export async function applyOrgDeleteForm(d1: D1Database, org: OrgRecord, form: OrgDeleteForm): Promise<OrgDeleteResult> {
  if (form.orgName !== org.username) {
    return { outcome: "invalid", message: orgSettingsLocale.invalid_org_name };
  }
  const repoCount = await drizzle(d1)
    .select({ total: sql<number>`count(*)` })
    .from(repositories)
    .where(eq(repositories.ownerId, org.id))
    .get();
  if ((repoCount?.total ?? 0) > 0) {
    return { outcome: "invalid", message: orgSettingsLocale.org_still_own_repo };
  }
  try {
    await new OrgService(d1).deleteOrg(org.id);
  } catch {
    // The cascade's failure (the guard raced) — upstream's admin/non-admin
    // flash ladder reduced to the generic failure text (no flash plumbing).
    return { outcome: "invalid", message: orgSettingsLocale.delete_failed };
  }
  return { outcome: "deleted" };
}

/** The visibility modal's parse (the `visibility` radio; anything but the
 *  three enum values is upstream's `invalid_data` arm → kept unchanged). */
export type OrgVisibilityForm = "public" | "limited" | "private" | "";

export function parseOrgVisibilityForm(params: URLSearchParams): OrgVisibilityForm {
  const value = params.get("visibility") ?? "";
  return value === "public" || value === "limited" || value === "private" ? value : "";
}

/**
 * The visibility write (upstream SettingsChangeVisibilityPost over the
 * landed orgEdit's `visibility` key — the API arm carries the exact field
 * ChangeOrganizationVisibility writes): an unchanged value answers upstream's
 * nothing-has-been-changed redirect arm; an out-of-enum value answers its
 * invalid_data redirect arm. Both redirect silently (no flash plumbing).
 */
export async function applyOrgVisibilityForm(d1: D1Database, org: OrgRecord, visibility: OrgVisibilityForm): Promise<{ changed: boolean }> {
  if (visibility === "" || visibility === org.visibility) return { changed: false };
  await editOrgProfile(d1, org, { visibility });
  return { changed: true };
}

// ---------------------------------------------------------------------------
// The avatar pair (upstream SettingsAvatar/SettingsDeleteAvatar over the
// landed avatar store — the API arm's exact decode→process→store body)
// ---------------------------------------------------------------------------

export type OrgAvatarUpload =
  | { outcome: "applied"; data: Uint8Array; contentType: string }
  | { outcome: "none" } // no file part posted (the empty-input submit)
  | { outcome: "error"; message: string };

/**
 * Read the multipart avatar POST (upstream AvatarForm's `avatar` file field;
 * shared/avatar_upload_crop posts `avatar` + crop fields the no-JS port
 * drops). The wire cap answers BEFORE any body byte is read (the API arm's
 * `avatarWireCap` posture — MAX_AVATAR_WIRE_BYTES bounds the base64 wire
 * form; the multipart original is smaller than its base64, so the same cap
 * is conservative).
 */
export async function readOrgAvatarUpload(req: Request): Promise<OrgAvatarUpload> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) return { outcome: "none" };
  const declared = req.headers.get("content-length");
  const length = declared === null ? undefined : Number.parseInt(declared, 10);
  if (length !== undefined && Number.isFinite(length) && length > MAX_AVATAR_WIRE_BYTES) {
    return { outcome: "error", message: `avatar request body exceeds the ${MAX_AVATAR_WIRE_BYTES} byte wire limit` };
  }
  let file: File | null = null;
  try {
    const form = await req.formData();
    const part = form.get("avatar");
    if (part instanceof File && part.size > 0) file = part;
  } catch {
    return { outcome: "error", message: "unable to read the avatar upload" };
  }
  if (file === null) return { outcome: "none" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let processed: ReturnType<typeof processAvatarImage>;
  try {
    processed = processAvatarImage(bytes);
  } catch (error) {
    if (error instanceof AvatarOriginTooLargeError) return { outcome: "error", message: error.message };
    return { outcome: "error", message: "unable to decode the avatar image" };
  }
  return { outcome: "applied", data: processed.data, contentType: processed.contentType };
}

/**
 * Store the processed upload through the landed `uploadAvatar` (the
 * `{kind: "org"}` target — the API arm's exact store call). Call only on an
 * `applied` parse.
 */
export async function storeOrgAvatar(
  bucket: R2Bucket,
  d1: D1Database,
  org: OrgRecord,
  processed: { data: Uint8Array; contentType: string },
): Promise<void> {
  await uploadAvatar({ bucket, d1, target: { kind: "org", principalId: org.id }, data: processed.data, contentType: processed.contentType });
}

/** The delete write through the landed `deleteAvatar` (the API arm's exact
 *  call; a missing object deletes nothing and still succeeds). */
export async function deleteOrgAvatar(bucket: R2Bucket, d1: D1Database, org: OrgRecord): Promise<void> {
  await deleteAvatar(bucket, d1, { kind: "org", principalId: org.id });
}

// ---------------------------------------------------------------------------
// The team edit form + delete (the landed orgEditTeam / orgDeleteTeam arms)
// ---------------------------------------------------------------------------

/** The team edit render inputs: the org-scoped team row. `null` = the 404
 *  shell (unknown id, or a team of a DIFFERENT org — the detail slice's
 *  foreign-id rule). */
export async function loadOrgTeamEditData(d1: D1Database, org: OrgRecord, teamId: number): Promise<TeamRecord | null> {
  const team = await new TeamsService(d1).getTeamById(teamId);
  if (team === null || team.orgId !== org.id) return null;
  return team;
}

/** The team edit form's fields (upstream CreateTeamForm's edit arm minus the
 *  dropped repo_access group — the module header's reduction). `permission`
 *  null = no blanket radio checked (a stored per-unit team's shape);
 *  `units` non-null = the `units_present=1` post carrying per-unit modes. */
export interface TeamEditForm {
  name: string;
  description: string;
  visibility: "public" | "limited" | "private" | "";
  canCreateOrgRepo: boolean;
  permission: "read" | "write" | "admin" | null;
  units: Record<string, string> | null;
}

/** Parse the urlencoded team edit POST (new.tmpl's field names). */
export function parseOrgTeamEditForm(params: URLSearchParams): TeamEditForm {
  const visibility = params.get("visibility") ?? "";
  const permission = params.get("permission") ?? "";
  const units: Record<string, string> = {};
  if (params.get("units_present") === "1") {
    for (const [key, value] of params) {
      if (!key.startsWith("unit_")) continue;
      const unit = key.slice("unit_".length);
      if (unit === "") continue;
      if (value === "none" || value === "read" || value === "write") units[unit] = value;
    }
  }
  return {
    name: (params.get("team_name") ?? "").trim(),
    description: params.get("description") ?? "",
    visibility: visibility === "public" || visibility === "limited" || visibility === "private" ? visibility : "",
    canCreateOrgRepo: params.get("can_create_org_repo") !== null,
    permission: permission === "read" || permission === "write" || permission === "admin" ? permission : null,
    units: params.get("units_present") === "1" ? units : null,
  };
}

export type TeamEditResult =
  | { outcome: "applied"; team: TeamRecord }
  | { outcome: "invalid"; message: string };

/**
 * The team edit write (upstream EditTeamPost over the landed
 * `TeamsService.editTeam`): the required-name guard first (the web-bind arm
 * the API arm lacks — editTeam skips an empty name silently), the
 * upstream field order (form.Permission wins over the units —
 * ParseAccessMode is parsed unconditionally, the matrix only applies under
 * the none access), then the landed arm. The rename collision re-renders
 * upstream's form.team_name_been_taken text (the landed arm's only typed
 * failure — the bare `team rename failed` error the UNIQUE arbiter raises).
 */
export async function applyOrgTeamEditForm(d1: D1Database, team: TeamRecord, form: TeamEditForm): Promise<TeamEditResult> {
  if (form.name === "") {
    return { outcome: "invalid", message: orgSettingsLocale.team_name_required };
  }
  const option: EditTeamOption = {
    name: form.name,
    description: form.description,
    visibility: form.visibility === "" ? undefined : form.visibility,
    can_create_org_repo: form.canCreateOrgRepo,
  };
  if (form.permission !== null) {
    option.permission = form.permission;
  } else if (form.units !== null && Object.keys(form.units).length > 0) {
    option.units_map = form.units;
  }
  try {
    const updated = await new TeamsService(d1).editTeam(team, option);
    return { outcome: "applied", team: updated };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("team rename failed")) {
      return { outcome: "invalid", message: orgSettingsLocale.team_name_been_taken };
    }
    throw error;
  }
}

export type TeamDeleteResult = { outcome: "deleted" } | { outcome: "refused" };

/**
 * The team delete write (upstream DeleteTeam over the landed
 * `TeamsService.deleteTeam`): the last-owner guard's refusal is upstream's
 * Flash.Error + unconditional redirect — both arms 303 here (the
 * no-flash reduction), the caller only learns which target to pick.
 */
export async function applyOrgTeamDelete(d1: D1Database, team: TeamRecord): Promise<TeamDeleteResult> {
  try {
    await new TeamsService(d1).deleteTeam(team);
  } catch (error) {
    if (error instanceof LastOrgOwnerError) return { outcome: "refused" };
    throw error;
  }
  return { outcome: "deleted" };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The settings navbar (org/settings/navbar.tmpl reduced to the two live
 *  tabs — the module header's note; Options is always the active item on
 *  this page, Labels links the landed `/{org}/labels` page). */
function SettingsNavbar(props: { orgLink: string }) {
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{orgSettingsLocale.settings}</div>
        <a class="active item" href={`${props.orgLink}/settings`}>
          {orgSettingsLocale.options}
        </a>
        <a class="item" href={`${props.orgLink}/labels`}>
          {orgSettingsLocale.labels}
        </a>
      </div>
    </div>
  );
}

/** One danger-zone row (options_dangerzone.tmpl's
 *  `flex-divided-list items-with-main` item): the title/body pair and the
 *  action control — upstream's show-modal button + `<dialog>` reduced to a
 *  `<details>` disclosure wrapping the same form (the owner-project-board
 *  dialog reduction). */
function DangerRow(props: { title: string; body: string; action: string; children: Child }) {
  return (
    <div class="item tw-items-center">
      <div class="item-main">
        <div class="item-title">{props.title}</div>
        <div class="item-body">{props.body}</div>
      </div>
      <div class="item-trailing">
        <details class="ui basic red button tw-p-0">
          <summary class="tw-p-2">{props.action}</summary>
          <div class="ui attached segment tw-text-left">{props.children}</div>
        </details>
      </div>
    </div>
  );
}

/** The settings page render inputs: the org row plus the re-render state
 *  (the banner message; null on the plain GET). */
export interface OrgSettingsData {
  org: OrgRecord;
  error: string | null;
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderOrgSettingsPage(ctx: UiContext, data: OrgSettingsData): string {
  return renderPage(<OrgSettingsPage ctx={ctx} data={data} />);
}

/**
 * The org settings page (§2.4.1 discriminator: `organization settings
 * options` — layout_head's pageClass dict): OrgHeader, then the
 * flex-container pair (navbar + main), the options form, the avatar form
 * and the danger zone.
 */
export function OrgSettingsPage(props: { ctx: UiContext; data: OrgSettingsData }) {
  const { ctx, data } = props;
  const org = data.org;
  const orgLink = `/${org.username}`;
  return (
    <BaseLayout ctx={ctx} title={orgDisplayName(org)} pageClass="organization settings options">
      <OrgHeader org={org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <SettingsNavbar orgLink={orgLink} />
        <div class="flex-container-main">
          {data.error !== null ? <div class="ui negative message">{data.error}</div> : null}
          <div class="org-setting-content">
            <h4 class="ui top attached header">{orgSettingsLocale.options}</h4>
            <div class="ui attached segment">
              {/* options.tmpl's form — action `{{.Link}}` = the page URL. */}
              <form class="ui form" action={`${orgLink}/settings`} method="post">
                <div class="field">
                  <label for="full_name">{orgSettingsLocale.full_name}</label>
                  <input id="full_name" name="full_name" value={org.fullName ?? ""} maxlength={100} />
                </div>
                <div class="field">
                  <label for="email">{orgSettingsLocale.email}</label>
                  <input id="email" name="email" type="email" value={org.email ?? ""} maxlength={255} />
                </div>
                <div class="field">
                  <label for="description">{orgSettingsLocale.description}</label>
                  <textarea id="description" name="description" rows={2} maxlength={255}>
                    {org.description ?? ""}
                  </textarea>
                </div>
                <div class="field">
                  <label for="website">{orgSettingsLocale.website}</label>
                  <input id="website" name="website" type="url" value={org.website ?? ""} maxlength={255} />
                </div>
                <div class="field">
                  <label for="location">{orgSettingsLocale.location}</label>
                  <input id="location" name="location" value={org.location ?? ""} maxlength={50} />
                </div>
                <div class="field" id="permission_box">
                  <label>{orgSettingsLocale.permissions}</label>
                  <div class="field">
                    <div class="ui checkbox">
                      <input type="checkbox" name="repo_admin_change_team_access" checked={org.repoAdminChangeTeamAccess} />
                      <label>{orgSettingsLocale.repoadminchangeteam}</label>
                    </div>
                  </div>
                </div>
                <div class="field">
                  <button type="submit" class="ui primary button">
                    {orgSettingsLocale.update_settings}
                  </button>
                </div>
              </form>

              <div class="divider" />

              {/* The avatar form (multipart — upstream AvatarForm's `avatar`
                  field; the current avatar through the landed serving seam). */}
              <form class="ui form" action={`${orgLink}/settings/avatar`} method="post" enctype="multipart/form-data">
                <div class="inline field">
                  <img class="ui avatar" src={`/user/avatar/${encodeURIComponent(org.username)}/64`} alt="" />{" "}
                  <label for="avatar">{orgSettingsLocale.choose_new_avatar}</label>
                  <input id="avatar" name="avatar" type="file" />
                </div>
                <div class="field">
                  <button type="submit" class="ui primary button">
                    {orgSettingsLocale.update_avatar}
                  </button>
                  <button type="submit" class="ui red button" formaction={`${orgLink}/settings/avatar/delete`} formnovalidate>
                    {orgSettingsLocale.delete_current_avatar}
                  </button>
                </div>
              </form>
            </div>

            {/* options_dangerzone.tmpl — the three rows, each modal a
                `<details>` form (the dialog reduction). */}
            <h4 class="ui top attached error header">{orgSettingsLocale.danger_zone}</h4>
            <div class="ui attached error danger segment">
              <div class="flex-divided-list items-with-main">
                <DangerRow title={orgSettingsLocale.visibility} body={orgSettingsLocale.visibility_desc} action={orgSettingsLocale.change_visibility}>
                  <form class="ui form" action={`${orgLink}/settings/visibility`} method="post">
                    <input type="hidden" name="current_visibility" value={org.visibility} />
                    <div class="grouped field">
                      <div class="field">
                        <div class="ui radio checkbox">
                          <input name="visibility" type="radio" value="public" checked={org.visibility === "public"} />
                          <label>{orgSettingsLocale.visibility_public}</label>
                        </div>
                      </div>
                      <div class="field">
                        <div class="ui radio checkbox">
                          <input name="visibility" type="radio" value="limited" checked={org.visibility === "limited"} />
                          <label>{orgSettingsLocale.visibility_limited}</label>
                        </div>
                      </div>
                      <div class="field">
                        <div class="ui radio checkbox">
                          <input name="visibility" type="radio" value="private" checked={org.visibility === "private"} />
                          <label>{orgSettingsLocale.visibility_private}</label>
                        </div>
                      </div>
                    </div>
                    <button type="submit" class="ui red button">
                      {orgSettingsLocale.change_visibility}
                    </button>
                  </form>
                </DangerRow>
                <DangerRow title={orgSettingsLocale.rename} body={orgSettingsLocale.rename_desc} action={orgSettingsLocale.rename}>
                  <form class="ui form" action={`${orgLink}/settings/rename`} method="post">
                    <div class="field">
                      <label>
                        {orgSettingsLocale.name_confirm} <span class="tw-text-red">{org.username}</span>
                      </label>
                    </div>
                    <div class="required field">
                      <label for="org_name_to_rename">{orgSettingsLocale.org_name_holder}</label>
                      <input id="org_name_to_rename" name="org_name" required />
                    </div>
                    <div class="required field">
                      <label>{orgSettingsLocale.rename_new_org_name}</label>
                      <input name="new_org_name" required />
                    </div>
                    <button type="submit" class="ui red button">
                      {orgSettingsLocale.rename}
                    </button>
                  </form>
                </DangerRow>
                <DangerRow title={orgSettingsLocale.delete_account} body={orgSettingsLocale.delete_prompt} action={orgSettingsLocale.delete_account}>
                  <form class="ui form" action={`${orgLink}/settings/delete`} method="post">
                    <div class="field">
                      <label>
                        {orgSettingsLocale.name_confirm} <span class="tw-text-red">{org.username}</span>
                      </label>
                    </div>
                    <div class="required field">
                      <label>{orgSettingsLocale.org_name_holder}</label>
                      <input name="org_name" required />
                    </div>
                    <button type="submit" class="ui red button">
                      {orgSettingsLocale.delete_account}
                    </button>
                  </form>
                </DangerRow>
              </div>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The team edit render inputs: the org, the stored team row and the
 *  re-render state (the submitted form + the banner message; the plain GET
 *  renders the stored values). */
export interface OrgTeamEditData {
  org: OrgRecord;
  team: TeamRecord;
  form: TeamEditForm;
  error: string | null;
}

/** The stored row → form defaults (the plain GET's render state). */
export function teamEditFormFromTeam(team: TeamRecord): TeamEditForm {
  return {
    name: team.name,
    description: team.description,
    visibility: team.visibility,
    canCreateOrgRepo: team.canCreateOrgRepo,
    permission: team.authorize === "read" || team.authorize === "write" || team.authorize === "admin" ? team.authorize : null,
    units: null,
  };
}

/** The full-document render for the team edit form. */
export function renderOrgTeamEditPage(ctx: UiContext, data: OrgTeamEditData): string {
  return renderPage(<OrgTeamEditPage ctx={ctx} data={data} />);
}

/** The stored per-unit map, parsed (the detail page's TeamPermissionBody
 *  shape — JSON in `teams.units_map`). */
function storedUnits(team: TeamRecord): Record<string, string> {
  if (team.unitsMap === null) return {};
  try {
    const parsed: unknown = JSON.parse(team.unitsMap);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // A malformed stored map renders as no units (the detail page's arm).
  }
  return {};
}

/** The unit mode → label. */
function unitModeLabel(mode: string): string {
  if (mode === "write") return orgSettingsLocale.team_write_access;
  if (mode === "read") return orgSettingsLocale.team_read_access;
  return orgSettingsLocale.team_none_access;
}

/**
 * The team edit page (§2.4.1 discriminator: `organization new team` —
 * new.tmpl:3 serves both arms): the edit form over the stored team, the
 * per-unit rows for a stored units team, and the red Delete Team button (a
 * real POST form — upstream's link-action + confirm dialog reduced).
 */
export function OrgTeamEditPage(props: { ctx: UiContext; data: OrgTeamEditData }) {
  const { ctx, data } = props;
  const org = data.org;
  const team = data.team;
  const orgLink = `/${org.username}`;
  const units = storedUnits(team);
  const unitNames = Object.keys(units).sort();
  const isUnitsTeam = team.authorize === "none" || unitNames.length > 0;
  return (
    <BaseLayout ctx={ctx} title={orgDisplayName(org)} pageClass="organization new team">
      <OrgHeader org={org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container">
        <div class="ui grid">
          <div class="column">
            <form class="ui form" action={`${orgLink}/teams/${team.id}/edit`} method="post">
              <h3 class="ui top attached header">{orgSettingsLocale.team_settings}</h3>
              <div class="ui attached segment">
                {data.error !== null ? <div class="ui negative message">{data.error}</div> : null}
                <div class="required field">
                  <label for="team_name">{orgSettingsLocale.team_name}</label>
                  <input id="team_name" name="team_name" value={data.form.name} required autofocus />
                  <span class="help">{orgSettingsLocale.team_name_helper}</span>
                </div>
                <div class="field">
                  <label for="description">{orgSettingsLocale.team_desc}</label>
                  <input id="description" name="description" value={data.form.description} maxlength={255} />
                  <span class="help">{orgSettingsLocale.team_desc_helper}</span>
                </div>
                <div class="grouped field">
                  <label>{orgSettingsLocale.team_visibility}</label>
                  <div class="field">
                    <div class="ui radio checkbox">
                      <input type="radio" name="visibility" value="private" checked={data.form.visibility === "private"} />
                      <label>{orgSettingsLocale.team_visibility_private}</label>
                      <span class="help">{orgSettingsLocale.team_visibility_private_helper}</span>
                    </div>
                  </div>
                  <div class="field">
                    <div class="ui radio checkbox">
                      <input type="radio" name="visibility" value="limited" checked={data.form.visibility === "limited"} />
                      <label>{orgSettingsLocale.team_visibility_limited}</label>
                      <span class="help">{orgSettingsLocale.team_visibility_limited_helper}</span>
                    </div>
                  </div>
                  <div class="field">
                    <div class="ui radio checkbox">
                      <input type="radio" name="visibility" value="public" checked={data.form.visibility === "public"} />
                      <label>{orgSettingsLocale.team_visibility_public}</label>
                      <span class="help">{orgSettingsLocale.team_visibility_public_helper}</span>
                    </div>
                  </div>
                </div>
                <div class="grouped field">
                  <label>{orgSettingsLocale.team_permission_desc}</label>
                  <div class="field">
                    <div class="ui radio checkbox">
                      <input type="radio" name="permission" value="read" checked={data.form.permission === "read"} />
                      <label>{orgSettingsLocale.team_read_access}</label>
                    </div>
                  </div>
                  <div class="field">
                    <div class="ui radio checkbox">
                      <input type="radio" name="permission" value="write" checked={data.form.permission === "write"} />
                      <label>{orgSettingsLocale.team_write_access}</label>
                    </div>
                  </div>
                  <div class="field">
                    <div class="ui radio checkbox">
                      <input type="radio" name="permission" value="admin" checked={data.form.permission === "admin"} />
                      <label>{orgSettingsLocale.team_admin_access}</label>
                    </div>
                  </div>
                  <div class="field">
                    <div class="ui checkbox">
                      <input id="can_create_org_repo" name="can_create_org_repo" type="checkbox" checked={data.form.canCreateOrgRepo} />
                      <label for="can_create_org_repo">{orgSettingsLocale.team_can_create_org_repo}</label>
                    </div>
                  </div>
                </div>
                {isUnitsTeam ? (
                  <div class="grouped field">
                    <label>{orgSettingsLocale.team_unit_desc}</label>
                    <table class="ui celled table">
                      <thead>
                        <tr>
                          <th scope="col">{orgSettingsLocale.unit}</th>
                          <th scope="col">{orgSettingsLocale.team_none_access}</th>
                          <th scope="col">{orgSettingsLocale.team_read_access}</th>
                          <th scope="col">{orgSettingsLocale.team_write_access}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unitNames.map((unit) => (
                          <tr>
                            <td>
                              <strong>{unit}</strong>
                              <span class="help">{unitModeLabel(units[unit] ?? "none")}</span>
                            </td>
                            {(["none", "read", "write"] as const).map((mode) => (
                              <td class="tw-text-center">
                                <div class="ui radio checkbox">
                                  <input
                                    type="radio"
                                    name={`unit_${unit}`}
                                    value={mode}
                                    checked={(units[unit] ?? "none") === mode}
                                    title={unitModeLabel(mode)}
                                  />
                                </div>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <input type="hidden" name="units_present" value="1" />
                  </div>
                ) : null}
                <div class="field">
                  <button type="submit" class="ui primary button">
                    {orgSettingsLocale.team_update_settings}
                  </button>
                </div>
              </div>
            </form>
            {/* The red Delete Team button (new.tmpl's link-action control) as
                a real POST form — the confirm dialog is the documented
                no-JS reduction. */}
            <form class="ui form" action={`${orgLink}/teams/${team.id}/delete`} method="post">
              <button type="submit" class="ui red button">
                {orgSettingsLocale.team_delete}
              </button>
            </form>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

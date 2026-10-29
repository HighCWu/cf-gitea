/**
 * The repo settings ACTIONS tab's GENERAL sub-tab (the census C9 arm — the
 * repo scope; the census row's owner token-permission page is the
 * org/user/admin scopes and is NOT this module), ported from the pin
 * fc4936884584a41931906553d96c2601d750e6ef.
 *
 * Upstream sources (VERIFIED at the pin):
 *   - `routers/web/web.go:1262-1265` — the `/actions/general` group
 *     (`GET ""` + `POST /actions_unit`) carries the literal comment
 *     "doesn't require actions enabled": it sits OUTSIDE the
 *     `actions.MustEnableActions` group (web.go:1266-1278), so the page
 *     renders — and the toggle writes — on a DISABLED unit. That is the
 *     arm's whole point: the general tab is the disabled unit's re-entry.
 *     The group inside the gate keeps `GET ""` → `misc.LocationRedirect(
 *     "./actions/general")` (web.go:1267) plus the collaborative-owner and
 *     token-permission POSTs (web.go:1270-1274).
 *   - `routers/web/repo/setting/actions.go:23-101` —
 *     `ActionsGeneralSettings` (Title "actions.general", PageType "general",
 *     PageIsActionsSettingsGeneral; the no-unit early render at :34-36) and
 *     `ActionsUnitPost` (the `enable_actions` FormBool →
 *     UpdateRepositoryUnits add/remove, flash success,
 *     `ctx.Redirect(RepoLink + "/settings/actions/general")` — base.go:157's
 *     default is 303 See Other).
 *   - `routers/web/repo/setting/actions.go:103-191` — the POST tails this
 *     module arms: `AddCollaborativeOwner` (GetUserByName → not-exist is a
 *     JSONError, append-if-absent, JSONOK), `DeleteCollaborativeOwner`
 *     (FormInt64 id, IsCollaborativeOwner or JSONErrorNotFound, remove,
 *     JSONOK) and `UpdateTokenPermissions` (override FormBool always
 *     written; mode + max ceiling only WHEN overriding, an invalid mode
 *     REFUSES the save with a flash-error redirect, enable-max false
 *     stores nil, then flash success + the 303 back onto the general page).
 *   - `routers/web/shared/actions` `ParseMaxTokenPermissions` (:38-55) —
 *     `max_unit_access_mode_{unitType}` per ActionsTokenUnitTypes, "write"/
 *     "read" keywords, everything (incl. absent) none; `max_id_token`
 *     grants on the literal "write".
 *   - `models/repo/repo_unit_actions.go` — the ActionsConfig the sections
 *     read/write (CollaborativeOwnerIDs, TokenPermissionMode,
 *     MaxTokenPermissions, OverrideOwnerConfig); `models/repo/repo_unit.go:
 *     32` stores it as the unit row's `config` TEXT column — the landed
 *     `repo_units.config` (schema.ts, migration 0043), serialized by
 *     services/actions/config.ts (that module's header carries the full
 *     store cite set, incl. the EnumValue permissive normalization).
 *   - `templates/repo/settings/actions.tmpl` (the PageType switchyard,
 *     pageClass `repository settings actions`) → `actions_general.tmpl`:
 *     the Enable Actions section FIRST and UNCONDITIONALLY (the h4 +
 *     attached segment + the `{{.Link}}/actions_unit` form — .Link is the
 *     current request URL, context.go:59/158, so the action is
 *     `.../settings/actions/general/actions_unit`); the Token Permissions
 *     section (:26-55 — `{{.RepoLink}}/settings/actions/general/
 *     token_permissions` form, the override-owner checkbox,
 *     `shared/actions/permission_mode_select`'s permissive/restricted
 *     radios, `shared/actions/permissions_table`'s per-unit maximum rows +
 *     the id-token row, the `initRepoActionsPermissionsForm` bundle hook)
 *     and the Collaborative Owners section (:57-98 — the owner list with
 *     the `{{$.Link}}/collaborative_owner/delete?id=` link-action buttons,
 *     the `{{.Link}}/collaborative_owner/add` form with the
 *     search-user-box input, `data-include-orgs="true"`) both arm on
 *     `$isActionsEnabled`, collaborative owners AND on
 *     `.Repository.IsPrivate` (:26, 57-58).
 *   - `routers/web/misc/misc.go:76-80` — LocationRedirect answers
 *     http.StatusSeeOther (303) with the LITERAL relative target
 *     `./actions/general`.
 *   - `templates/repo/settings/navbar.tmpl:42-59` — the General sub-item is
 *     UNCONDITIONAL inside the Actions disclosure (the disabled unit's
 *     re-entry again); only the runners/secrets/variables trio rides the
 *     unit conditional (:47). The shared SettingsNav carries the same
 *     posture via its `active === "general"` arm.
 *
 * ## Gates (the settingsGate; NO unit arm on the page itself)
 *
 * The settings subtree's posture everywhere (settings.tsx /
 * repo-settings-lfs.tsx headers): anonymous 303s onto the login round-trip,
 * a signed-in non-admin 404-shells (the shared `settingsGate` over
 * `isRepositoryAdmin`). The general group adds NOTHING — web.go:1262-1265
 * mounts it outside MustEnableActions precisely so a disabled unit can
 * reach its own re-entry toggle. The BARE `/settings/actions` redirect is
 * the mirror image: it sits INSIDE MustEnableActions (web.go:1266-1278's
 * group), so a disabled unit 404-shells it (MustEnableActions' repo arm is
 * `Permission.CanRead(TypeActions)`, actions.go:67-81 → the landed
 * `repo_settings.has_actions` flag) and an enabled one 303s. Upstream
 * registers no POST at the bare path (chi answers 405).
 *
 * ## Data (the repo_settings flag + the repo_units.config ActionsConfig store)
 *
 * The unit toggle rides `repo_settings.has_actions` (DEFAULT false — the
 * options form's `enable_actions` checkbox write, the API PATCH's
 * settingsPatch.hasActions arm), read through `loadRepoSettings` and written
 * through `saveRepoSettings` — the settings write idiom, exactly the API
 * route's own arm. Upstream keeps the unit on the `repo_unit` row itself
 * (UpdateRepositoryUnits); the landed reduction collapses the unit to the
 * flag (the MustEnableActions store — the C8 arm's gate reads the same
 * column). The two sections' state rides `repo_units.config` (the
 * ActionsConfig JSON — the upstream column-for-column home): loaded through
 * services/actions/config.ts `loadRepoActionsConfig`, written through the
 * module's UpdateTokenPermissions/collaborative-owner arms. The config's
 * lifetime is upstream's own: the toggle's lockstep unit-row delete wipes it
 * on disable, and re-enabling starts fresh (newRepoUnit's nil config).
 *
 * The OWNER-config fallback (actions.go:51-60): when the repo isn't
 * overriding, upstream renders the OWNER-level OwnerActionsConfig
 * (models/actions/config.go:40-47 — a `user_setting` 'actions.config' JSON
 * row). That store has no landed home (the owner token-permission page is
 * the census row's org/user scopes, not this module), so the loader renders
 * its NO-SETTING posture, which is exactly upstream's for a fresh owner:
 * mode permissive (FromDB's EnumValue normalization), the write-all max
 * (GetMaxTokenPermissions' nil ceiling), enable-max false.
 *
 * ## Routes (the POST tails are NOT registered — the wiring HANDOFF)
 *
 * `ui/index.ts` registers `settings-actions` / `settings-actions-general` /
 * `settings-actions-general-unit` (6fcb561/0c8da44) and NOTHING else under
 * /settings/actions/general — the token-permissions and collaborative-owner
 * POST tails stay engine-owned 404s until the orchestrator's registration
 * window (this module is not index.ts's owner). Everything the handlers
 * need is exported from here: the parsers (`parseRepoTokenPermissionsForm`,
 * `parseRepoCollaborativeOwnerAddForm`, `parseRepoCollaborativeOwnerDeleteForm`)
 * and the appliers (`applyRepoTokenPermissions` — the service
 * `applyRepoTokenPermissionsForm` — plus `applyRepoCollaborativeOwnerAdd`/
 * `Delete`); the HANDOFF recipe in this module's tail comment spells the
 * three route families and their exact upstream response shapes.
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - Avatar images are not rendered (no avatar route exists — the
 *   issue-detail header's reduction): the collaborative-owners list keeps
 *   the item structure with the name link, minus the `.item-leading` img.
 * - The search-user-box JS widget does not run (no bundler hook): the add
 *   input keeps upstream's name/placeholder/required contract and works as
 *   a plain text input; `data-include-orgs` is inert markup.
 * - The `initRepoActionsPermissionsForm` bundle hook (the JS that gates the
 *   max-permissions table on the checkbox) is not wired: the form posts the
 *   full radio set regardless, and the SERVER arm ignores the max radios
 *   unless `enable_max_permissions` is on (upstream's own :169-177 rule) —
 *   so the no-JS post is byte-equivalent.
 * - `ActionsUnitPost`/`UpdateTokenPermissions`' success flash and the
 *   delete arm's error flash reduce to the bare responses (the
 *   no-session-flash convention): the 303s / JSON bodies only.
 * - `unit_model.TypeActions.UnitGlobalDisabled()` is FALSE in this
 *   deployment (actions are the instance's core — the C8 header's vacuous
 *   instance-flag posture), so actions_general.tmpl:9-22's disabled-
 *   checkbox/tooltip/no-submit branch is unreachable and collapses: the
 *   checkbox never renders disabled and the submit always renders.
 * - The relocation debt: settings.tsx's options form carries
 *   `enable_actions` ("our UI has no Actions tab" — no longer true with
 *   this page landed; upstream keeps the checkbox ONLY here,
 *   actions_general.tmpl:13). Retiring the options copy is the
 *   orchestrator's settings.tsx fold (this module's header documents the
 *   debt; settings.tsx carries concurrent sibling hunks).
 */

import { findUserByName } from "../../api/services/repository";
import { loadRepoSettings, saveRepoSettings } from "../../api/services/repo-settings";
import { inArray, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { repositories, users } from "../../db/schema";
import {
  ACTIONS_TOKEN_UNIT_TYPES,
  addRepoActionsCollaborativeOwner,
  applyRepoTokenPermissionsForm,
  getMaxTokenPermissions,
  loadRepoActionsConfig,
  makeWriteAllActionsTokenPermissions,
  removeRepoActionsCollaborativeOwner,
  type ActionsTokenPermissionMode,
  type ActionsTokenPermissions,
  type RepoTokenPermissionsForm,
} from "../../services/actions/config";
import { BaseLayout, Icon, renderPage } from "../shell";
import { userLink } from "../links";
import type { UiContext } from "../ui-context";
import { SettingsNav } from "./settings";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const repoSettingsActionsGeneralLocale = {
  general: "General", // "actions.general" (the navbar sub-item, navbar.tmpl:45; the page Title, actions.go:24)
  actions: "Actions", // "actions.actions" (the toggle field's label, actions_general.tmpl:11)
  enable_actions: "Enable Actions", // "actions.general.enable_actions" (the section header, actions_general.tmpl:5)
  actions_desc: "Enable Repository Actions", // "repo.settings.actions_desc" (the checkbox label, actions_general.tmpl:14)
  update_settings: "Update Settings", // "repo.settings.update_settings" (the submit buttons, actions_general.tmpl:20/:53)
  permissions: "Actions Token Permissions", // "actions.general.permissions" (the section header, actions_general.tmpl:28)
  override_owner: "Override owner-level configuration", // "actions.general.token_permissions.override_owner" (:34)
  override_owner_desc:
    "If enabled, this repository will use its own Actions configuration instead of following the owner-level (user or organization) configuration.", // :36
  mode: "Default Token Permissions", // "actions.general.token_permissions.mode" (permission_mode_select.tmpl:2)
  mode_desc:
    "An Actions job will use the default permissions if it doesn't declare its permissions in the workflow file.", // .mode.desc (:3)
  mode_permissive: "Permissive", // .mode.permissive (permission_mode_select.tmpl:7)
  mode_permissive_desc: "Read and write permissions for the job's repository.", // .mode.permissive.desc (:9)
  mode_restricted: "Restricted", // .mode.restricted (permission_mode_select.tmpl:15)
  mode_restricted_desc: "Read-only permissions for contents units (code, releases) of the job's repository.", // .mode.restricted.desc (:17)
  maximum: "Maximum Token Permissions", // "actions.general.token_permissions.maximum" (permissions_table.tmpl:2)
  maximum_description: "Actions job's effective permissions will be limited by the maximum permissions.", // .maximum.description (:4)
  fork_pr_note:
    "If a job is started by a pull request from a fork, its effective permissions won't exceed the read-only permissions.", // .fork_pr_note (:8)
  customize_max_permissions: "Customize maximum permissions", // .customize_max_permissions (:15)
  id_token: "OpenID Connect token", // .id_token (permissions_table.tmpl:88)
  id_token_description:
    'Allow jobs declaring "id-token: write" to request short-lived OpenID Connect tokens for authenticating to external services.', // .id_token.description (:89)
  collaborative_owners_management: "Collaborative Owners Management", // "actions.general.collaborative_owners_management" (actions_general.tmpl:61)
  add_collaborative_owner: "Add Collaborative Owner", // .add_collaborative_owner (:92)
  collaborative_owners_management_help:
    "A collaborative owner is a user or an organization whose private repository has access to the actions and workflows of this repository.", // .collaborative_owners_management_help (:96)
  remove_collaborative_owner: "Remove Collaborative Owner", // .remove_collaborative_owner (:76)
  remove_collaborative_owner_desc:
    "Removing a collaborative owner will prevent the repositories of the owner from accessing the actions in this repository. Continue?", // .remove_collaborative_owner_desc (:77)
  search_user_kind: "Search users…", // "search.user_kind" (the add input's placeholder, :90)
  unit: "Unit", // "units.unit" (permissions_table.tmpl:5)
  none_access: "No Access", // "org.teams.none_access" (permissions_table.tmpl:6, permissions_table_unit.tmpl:7)
  read_access: "Read", // "org.teams.read_access" (permissions_table.tmpl:10)
  write_access: "Write", // "org.teams.write_access" (permissions_table.tmpl:14)
  none_access_helper:
    "Members cannot view or do any other action on this unit. It has no effect for public repositories.", // .none_access_helper
  read_access_helper: "Members can view and clone team repositories.", // .read_access_helper
  write_access_helper: "Members can read and push to team repositories.", // .write_access_helper
  remove: "Remove", // "remove" (the link-action button label, actions_general.tmpl:78)
  user_not_exist: "The user does not exist.", // "form.user_not_exist" (AddCollaborativeOwner's JSONError body, actions.go:108)
  not_found: "The target couldn't be found.", // "error.not_found" (DeleteCollaborativeOwner's JSONErrorNotFound body, :128-129)
} as const;

/** permissions_table.tmpl's rendered unit rows — the template's own list and
 *  order (the locale keys cited per row). Packages is NOT rendered upstream
 *  (the table's own omission, mirrored); its ceiling still parses — as none
 *  — because ParseMaxTokenPermissions loops all of ACTIONS_TOKEN_UNIT_TYPES
 *  and the field is absent from the form. */
export const repoSettingsActionsGeneralUnitLocale: ReadonlyArray<{ type: number; name: string; desc: string }> = [
  { type: 1, name: "Code", desc: "Access source code, files, commits and branches." }, // "repo.code" + "repo.code.desc"
  { type: 2, name: "Issues", desc: "Organize bug reports, tasks and milestones." }, // "repo.issues" + "repo.issues.desc"
  { type: 3, name: "Pull Requests", desc: "Enable pull requests and code reviews." }, // "repo.pulls" + "repo.pulls.desc"
  { type: 5, name: "Wiki", desc: "Write and share documentation with collaborators." }, // "repo.wiki" + "repo.wiki.desc"
  { type: 4, name: "Releases", desc: "Track project versions and downloads." }, // "repo.releases" + "repo.releases.desc"
  { type: 8, name: "Projects", desc: "Manage issues and pulls in projects." }, // "repo.projects" + "repo.projects.desc"
  { type: 10, name: "Actions", desc: "Manage actions" }, // "repo.actions" + "actions.unit.desc" (upstream's line has no period)
];

/** The bare `/settings/actions` redirect's target — the LITERAL relative
 *  bytes `misc.LocationRedirect("./actions/general")` emits
 *  (web.go:1267, misc.go:76-80; the browser resolves it against
 *  `/…/settings/actions` → `/…/settings/actions/general`). */
export const REPO_ACTIONS_GENERAL_REDIRECT_TARGET = "./actions/general";

// ---------------------------------------------------------------------------
// The toggle write arm (upstream ActionsUnitPost, actions.go:74-93)
// ---------------------------------------------------------------------------

/** The actions_unit POST body (upstream's single `enable_actions` field). */
export interface RepoActionsUnitForm {
  enableActions: boolean;
}

/** Upstream `FormBool` (base_form.go:62-65): strconv.ParseBool's accepted
 *  spellings, plus the case-insensitive "on" a value-less HTML checkbox
 *  sends. An absent field parses false. */
export function formBool(raw: string | null): boolean {
  if (raw === null) return false;
  const s = raw;
  if (["1", "t", "T", "true", "TRUE", "True", "0", "f", "F", "false", "FALSE", "False"].includes(s)) {
    return s === "1" || s === "t" || s === "T" || s === "true" || s === "TRUE" || s === "True";
  }
  return s.toLowerCase() === "on";
}

/** Upstream `FormInt64` (base_form.go:88-91): strconv.ParseInt with the
 *  error swallowed — a missing or non-integer field answers 0 (which the
 *  delete arm then fails IsCollaborativeOwner with — the same 404). */
export function formInt64(raw: string | null): number {
  if (raw === null || !/^-?\d+$/.test(raw)) return 0; // Go's ParseInt errors on junk → 0
  return Number.parseInt(raw, 10);
}

/** Parse the urlencoded actions_unit POST (the readUrlEncodedForm
 *  convention; the FormBool semantics above). */
export function parseRepoActionsUnitForm(params: URLSearchParams): RepoActionsUnitForm {
  return { enableActions: formBool(params.get("enable_actions")) };
}

/**
 * The toggle write — upstream ActionsUnitPost's UpdateRepositoryUnits
 * add/remove (actions.go:80-84) collapsed to the landed unit flag (the
 * module header's Data section): `enable_actions: true` sets
 * repo_settings.has_actions, false clears it. Idempotent both ways (the
 * settings upsert). The global-disabled guard (actions.go:80/82) is
 * unreachable here (the reduction above), so the write always applies.
 * Db failures propagate (upstream's ServerError arm).
 */
export async function applyRepoActionsUnitToggle(d1: D1Database, repoId: string, form: RepoActionsUnitForm): Promise<void> {
  await saveRepoSettings(d1, repoId, { hasActions: form.enableActions }, new Date());
}

// ---------------------------------------------------------------------------
// The token_permissions POST arm (upstream UpdateTokenPermissions,
// actions.go:139-191 — the write semantics live in
// services/actions/config.ts applyRepoTokenPermissionsForm; this module
// owns the form parse)
// ---------------------------------------------------------------------------

/** Parse the urlencoded token_permissions POST: the override + enable-max
 *  FormBools, the mode string, and one `max_unit_access_mode_{unitType}`
 *  radio per ACTIONS_TOKEN_UNIT_TYPES (absent parses "" — the apply's none
 *  arm, exactly ParseMaxTokenPermissions' default). */
export function parseRepoTokenPermissionsForm(params: URLSearchParams): RepoTokenPermissionsForm {
  const maxUnitAccessModes: Record<number, string> = {};
  for (const unitType of ACTIONS_TOKEN_UNIT_TYPES) {
    maxUnitAccessModes[unitType] = params.get(`max_unit_access_mode_${unitType}`) ?? "";
  }
  return {
    overrideOwnerConfig: formBool(params.get("override_owner_config")),
    tokenPermissionMode: params.get("token_permission_mode") ?? "",
    enableMaxPermissions: formBool(params.get("enable_max_permissions")),
    maxUnitAccessModes,
    maxIdToken: params.get("max_id_token") ?? "",
  };
}

/** The token_permissions write — a thin call through the store's
 *  UpdateTokenPermissions port (the module header's Routes section: the
 *  index.ts handler maps `"saved"` → the 303 back onto the general page,
 *  `"invalid-mode"` → upstream's flash-error redirect (the same 303 — the
 *  no-session-flash reduction), `"missing"` → the gate 404). */
export function applyRepoTokenPermissions(d1: D1Database, repoId: string, form: RepoTokenPermissionsForm) {
  return applyRepoTokenPermissionsForm(d1, repoId, form);
}

// ---------------------------------------------------------------------------
// The collaborative_owner POST arms (upstream AddCollaborativeOwner /
// DeleteCollaborativeOwner, actions.go:103-137 — the store arms live in
// services/actions/config.ts; this module owns the name→id resolution)
// ---------------------------------------------------------------------------

/** The collaborative_owner/add POST body (the search-user-box input's
 *  name; raw — upstream's FormString does not trim, and GetUserByName
 *  answers not-exist for ""). */
export interface RepoCollaborativeOwnerAddForm {
  collaborativeOwner: string;
}

export function parseRepoCollaborativeOwnerAddForm(params: URLSearchParams): RepoCollaborativeOwnerAddForm {
  return { collaborativeOwner: params.get("collaborative_owner") ?? "" };
}

/** The collaborative_owner/delete POST body (`?id=` — ctx.FormInt64 reads
 *  query and form; junk parses 0). */
export interface RepoCollaborativeOwnerDeleteForm {
  id: number;
}

export function parseRepoCollaborativeOwnerDeleteForm(params: URLSearchParams): RepoCollaborativeOwnerDeleteForm {
  return { id: formInt64(params.get("id")) };
}

/** AddCollaborativeOwner's GetUserByName → ActionsConfig.AddCollaborativeOwner
 *  chain (actions.go:104-119): the name resolves against the users table
 *  (orgs included — upstream orgs ARE users; findUserByName is
 *  case-insensitive like upstream's lower_name lookup). The index.ts
 *  handler maps `"added"` → JSONOK `{"ok":true}` (200),
 *  `"user-not-found"` → JSONError `{"errorMessage":<form.user_not_exist>,
 *  "renderFormat":"text"}` (400), `"missing"` → the gate 404. */
export async function applyRepoCollaborativeOwnerAdd(
  d1: D1Database,
  repoId: string,
  form: RepoCollaborativeOwnerAddForm,
): Promise<"added" | "user-not-found" | "missing"> {
  const user = await findUserByName(d1, form.collaborativeOwner);
  if (user === null) return "user-not-found"; // util.ErrNotExist → the JSONError arm
  return addRepoActionsCollaborativeOwner(d1, repoId, user.id);
}

/** DeleteCollaborativeOwner's IsCollaborativeOwner → Remove chain
 *  (actions.go:121-137): the handler maps `"removed"` → JSONOK (200),
 *  `"not-an-owner"` → JSONErrorNotFound `{"errorMessage":<error.not_found>,
 *  "renderFormat":"text"}` (404), `"missing"` → the gate 404. */
export function applyRepoCollaborativeOwnerDelete(
  d1: D1Database,
  repoId: string,
  form: RepoCollaborativeOwnerDeleteForm,
) {
  return removeRepoActionsCollaborativeOwner(d1, repoId, form.id);
}

// ---------------------------------------------------------------------------
// The page load (upstream ActionsGeneralSettings, actions.go:23-101 — the
// unit read the template arms on, plus the two sections' render inputs)
// ---------------------------------------------------------------------------

/** The token-permissions section's render inputs (actions.go:39-60's
 *  ctx.Data): the effective mode + ceiling, and whether the ceiling is the
 *  repo's own (drives the enable-max checkbox). */
export interface RepoActionsGeneralTokenPermissionsData {
  overrideOwnerConfig: boolean;
  tokenPermissionMode: ActionsTokenPermissionMode;
  maxTokenPermissions: ActionsTokenPermissions;
  enableMaxTokenPermissions: boolean;
}

/** The owner-config fallback (the module header's Data section — upstream's
 *  no-setting OwnerActionsConfig posture: FromDB's EnumValue normalization
 *  answers permissive, GetMaxTokenPermissions' nil ceiling answers
 *  write-all, enable-max false). */
export const OWNER_ACTIONS_CONFIG_FALLBACK_DATA: RepoActionsGeneralTokenPermissionsData = {
  overrideOwnerConfig: false,
  tokenPermissionMode: "permissive",
  maxTokenPermissions: makeWriteAllActionsTokenPermissions(),
  enableMaxTokenPermissions: false,
};

/** A collaborative-owner list row (the `.CollaborativeOwners` range —
 *  upstream's GetUsersByIDs rows reduced to what the render uses). */
export interface RepoActionsGeneralCollaborativeOwner {
  id: number;
  username: string;
  displayName: string | null;
}

/** The general tab's render inputs: the unit status the toggle section and
 *  the nav's conditional reflect, plus the two enabled-posture sections'
 *  data (zeroed on a disabled unit — the template arms them off). */
export interface RepoActionsGeneralPageData {
  isActionsEnabled: boolean;
  tokenPermissions: RepoActionsGeneralTokenPermissionsData;
  collaborativeOwners: RepoActionsGeneralCollaborativeOwner[];
}

export async function loadRepoActionsGeneralPageData(d1: D1Database, repoId: string): Promise<RepoActionsGeneralPageData> {
  const settings = await loadRepoSettings(d1, repoId);
  if (!settings.hasActions) {
    // upstream's no-unit early render (actions.go:34-36): the sections arm
    // off; the fallback inputs are carried but never rendered.
    return { isActionsEnabled: false, tokenPermissions: { ...OWNER_ACTIONS_CONFIG_FALLBACK_DATA }, collaborativeOwners: [] };
  }
  const cfg = await loadRepoActionsConfig(d1, repoId);
  // actions.go:41-60: the repo's own config when overriding, the owner's
  // otherwise (the header's fallback reduction — no landed owner store).
  const tokenPermissions: RepoActionsGeneralTokenPermissionsData = cfg.overrideOwnerConfig
    ? {
        overrideOwnerConfig: true,
        tokenPermissionMode: cfg.tokenPermissionMode,
        maxTokenPermissions: getMaxTokenPermissions(cfg),
        enableMaxTokenPermissions: cfg.maxTokenPermissions !== null,
      }
    : { ...OWNER_ACTIONS_CONFIG_FALLBACK_DATA };
  // actions.go:62-69: the collaborative owners load ONLY on a private repo
  // (actions_general.tmpl:57-58's arm), by the config's id order.
  const collaborativeOwners: RepoActionsGeneralCollaborativeOwner[] = [];
  const repoRow = await drizzle(d1).select({ visibility: repositories.visibility }).from(repositories).where(eq(repositories.id, repoId)).get();
  if (repoRow?.visibility === "private" && cfg.collaborativeOwnerIds.length > 0) {
    const rows = await drizzle(d1)
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, cfg.collaborativeOwnerIds))
      .all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of cfg.collaborativeOwnerIds) {
      const row = byId.get(id);
      if (row !== undefined) collaborativeOwners.push(row); // upstream GetUsersByIDs silently drops missing ids
    }
  }
  return { isActionsEnabled: true, tokenPermissions, collaborativeOwners };
}

// ---------------------------------------------------------------------------
// The render (repo/settings/actions.tmpl PageType "general" +
//  actions_general.tmpl — all three sections)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderRepoActionsGeneralPage(ctx: UiContext, data: RepoActionsGeneralPageData): string {
  return renderPage(<RepoActionsGeneralPage ctx={ctx} data={data} />);
}

/** The general page (§2.4.1 discriminator: `repository settings actions` —
 *  layout_head's pageClass dict, actions.tmpl:1; upstream's Title is
 *  `actions.general`, actions.go:24). Renders on a DISABLED unit (the
 *  route carries no unit gate — the module header). The settings pages'
 *  ctx.repo contract (the LFS shell's throw). */
export function RepoActionsGeneralPage(props: { ctx: UiContext; data: RepoActionsGeneralPageData }) {
  const { ctx } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoActionsGeneralPage requires ctx.repo");
  const locale = repoSettingsActionsGeneralLocale;
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const generalLink = `${repoLink}/settings/actions/general`;
  const tp = props.data.tokenPermissions;
  const accessMode = (unitType: number): 0 | 1 | 2 => tp.maxTokenPermissions.unitAccessModes[unitType] ?? 0;
  return (
    <BaseLayout ctx={ctx} title={locale.general} pageClass="repository settings actions">
      <div class="ui container flex-container">
        {/* hasActions threaded honestly: enabled → the Actions disclosure
            opens with the full trio (navbar.tmpl:47's conditional); disabled
            → General ALONE (the shared nav's `active === "general"` arm —
            the disabled unit's re-entry, navbar.tmpl:43-46's unconditional
            item). */}
        <SettingsNav repoLink={repoLink} active="general" repo={repo} hasActions={props.data.isActionsEnabled ? true : undefined} />
        <div class="flex-container-main">
          <div class="repo-setting-content">
            {/* actions_general.tmpl:3-24 — the Enable Actions section,
                FIRST and UNCONDITIONAL. The global-disabled branch
                (actions_general.tmpl:9, 12-13, 17-22) is unreachable in this
                deployment (the module header) and collapses. */}
            <h4 class="ui top attached header">{locale.enable_actions}</h4>
            <div class="ui attached segment">
              <form class="ui form" action={`${generalLink}/actions_unit`} method="post">
                <div class="inline field">
                  <label>{locale.actions}</label>
                  <div class="ui checkbox">
                    <input name="enable_actions" type="checkbox" checked={props.data.isActionsEnabled} />
                    <label>{locale.actions_desc}</label>
                  </div>
                </div>
                <div class="divider"></div>
                <div class="field">
                  <button type="submit" class="ui primary button">
                    {locale.update_settings}
                  </button>
                </div>
              </form>
            </div>
            {/* actions_general.tmpl:26-55 — the Token Permissions section
                (armed on $isActionsEnabled; the store landed — the C9
                documented-unrendered reduction is retired). */}
            {props.data.isActionsEnabled ? (
              <>
                <h4 class="ui top attached header">{locale.permissions}</h4>
                <div class="ui attached segment">
                  <form class="ui form" action={`${generalLink}/token_permissions`} method="post" data-global-init="initRepoActionsPermissionsForm">
                    {/* the override-owner checkbox (:31-39) */}
                    <div class="field">
                      <div class="ui checkbox">
                        <input type="checkbox" name="override_owner_config" checked={tp.overrideOwnerConfig} />
                        <label>
                          <strong>{locale.override_owner}</strong>
                        </label>
                      </div>
                      <div class="help">{locale.override_owner_desc}</div>
                    </div>
                    <div class="divider"></div>
                    <div class="field js-repo-token-permissions-config">
                      {/* shared/actions/permission_mode_select.tmpl */}
                      <div class="field js-permission-mode-section">
                        <label>{locale.mode}</label>
                        <div class="help">{locale.mode_desc}</div>
                        <div class="field">
                          <div class="ui radio checkbox">
                            <input type="radio" name="token_permission_mode" value="permissive" checked={tp.tokenPermissionMode === "permissive"} />
                            <label>{locale.mode_permissive}</label>
                            <div class="help">{locale.mode_permissive_desc}</div>
                          </div>
                        </div>
                        <div class="field">
                          <div class="ui radio checkbox">
                            <input type="radio" name="token_permission_mode" value="restricted" checked={tp.tokenPermissionMode === "restricted"} />
                            <label>{locale.mode_restricted}</label>
                            <div class="help">{locale.mode_restricted_desc}</div>
                          </div>
                        </div>
                      </div>
                      <div class="divider"></div>
                      {/* shared/actions/permissions_table.tmpl — the
                          template's own unit list/order (packages not
                          rendered, the module note on
                          repoSettingsActionsGeneralUnitLocale); the
                          octicon-question tooltip icons keep the
                          data-tooltip-content attrs. */}
                      <div class="field">
                        <label>{locale.maximum}</label>
                        <div class="help">
                          {locale.maximum_description}
                          <br></br>
                          {locale.fork_pr_note}
                        </div>
                        <div class="field">
                          <div class="ui checkbox">
                            <input type="checkbox" name="enable_max_permissions" checked={tp.enableMaxTokenPermissions} />
                            <label>{locale.customize_max_permissions}</label>
                          </div>
                        </div>
                        <table class="ui celled table js-permissions-table">
                          <thead>
                            <tr>
                              <th class="tw-w-2/5">{locale.unit}</th>
                              <th class="tw-text-center">
                                {locale.none_access}
                                <span class="tw-align-middle" data-tooltip-content={locale.none_access_helper}>
                                  <Icon name="octicon-question" size={16} class="tw-ml-1" />
                                </span>
                              </th>
                              <th class="tw-text-center">
                                {locale.read_access}
                                <span class="tw-align-middle" data-tooltip-content={locale.read_access_helper}>
                                  <Icon name="octicon-question" size={16} class="tw-ml-1" />
                                </span>
                              </th>
                              <th class="tw-text-center">
                                {locale.write_access}
                                <span class="tw-align-middle" data-tooltip-content={locale.write_access_helper}>
                                  <Icon name="octicon-question" size={16} class="tw-ml-1" />
                                </span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {/* permissions_table_unit.tmpl per row — the
                                radios: none checked on a 0/absent mode,
                                read on 1, write on 2. */}
                            {repoSettingsActionsGeneralUnitLocale.map((unit) => (
                              <tr>
                                <td>
                                  <strong>{unit.name}</strong>
                                  <div class="help">{unit.desc}</div>
                                </td>
                                <td class="tw-text-center">
                                  <div class="ui radio checkbox">
                                    <input type="radio" name={`max_unit_access_mode_${unit.type}`} value="none" checked={accessMode(unit.type) === 0} />
                                    <label></label>
                                  </div>
                                </td>
                                <td class="tw-text-center">
                                  <div class="ui radio checkbox">
                                    <input type="radio" name={`max_unit_access_mode_${unit.type}`} value="read" checked={accessMode(unit.type) === 1} />
                                    <label></label>
                                  </div>
                                </td>
                                <td class="tw-text-center">
                                  <div class="ui radio checkbox">
                                    <input type="radio" name={`max_unit_access_mode_${unit.type}`} value="write" checked={accessMode(unit.type) === 2} />
                                    <label></label>
                                  </div>
                                </td>
                              </tr>
                            ))}
                            {/* the id-token row (permissions_table.tmpl:84-105) */}
                            <tr>
                              <td>
                                <strong>{locale.id_token}</strong>
                                <div class="help">{locale.id_token_description}</div>
                              </td>
                              <td class="tw-text-center">
                                <div class="ui radio checkbox">
                                  <input type="radio" name="max_id_token" value="none" checked={!tp.maxTokenPermissions.idToken} />
                                  <label></label>
                                </div>
                              </td>
                              <td></td>
                              <td class="tw-text-center">
                                <div class="ui radio checkbox">
                                  <input type="radio" name="max_id_token" value="write" checked={tp.maxTokenPermissions.idToken} />
                                  <label></label>
                                </div>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <div class="field">
                      <button type="submit" class="ui primary button">
                        {locale.update_settings}
                      </button>
                    </div>
                  </form>
                </div>
              </>
            ) : null}
            {/* actions_general.tmpl:57-98 — the Collaborative Owners
                section ($isActionsEnabled AND .Repository.IsPrivate). The
                avatar img is a documented reduction (no avatar route); the
                search-user-box wrapper keeps upstream's markup with the JS
                widget inert. */}
            {props.data.isActionsEnabled && repo.visibility === "private" ? (
              <>
                <h4 class="ui top attached header">{locale.collaborative_owners_management}</h4>
                {props.data.collaborativeOwners.length > 0 ? (
                  <div class="ui attached segment">
                    <div class="flex-divided-list items-with-main">
                      {props.data.collaborativeOwners.map((owner) => (
                        <div class="item tw-items-center">
                          <div class="item-leading"></div>
                          <div class="item-main">
                            <div class="item-title">
                              <a class="text muted" href={userLink(owner.username)}>
                                {owner.displayName ?? owner.username}
                              </a>
                            </div>
                          </div>
                          <div class="item-trailing">
                            <button
                              type="button"
                              class="ui red tiny button inline link-action"
                              data-url={`${generalLink}/collaborative_owner/delete?id=${owner.id}`}
                              data-modal-confirm-header={locale.remove_collaborative_owner}
                              data-modal-confirm-content={locale.remove_collaborative_owner_desc}
                            >
                              {locale.remove}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div class="ui bottom attached segment">
                  <form class="ui form form-fetch-action flex-text-block" action={`${generalLink}/collaborative_owner/add`} method="post">
                    <div id="search-user-box" class="ui search input" data-include-orgs="true">
                      <input class="prompt" name="collaborative_owner" placeholder={locale.search_user_kind} autocomplete="off" autofocus required />
                    </div>
                    <button type="submit" class="ui primary button">
                      {locale.add_collaborative_owner}
                    </button>
                  </form>
                  <br></br>
                  {locale.collaborative_owners_management_help}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// The wiring HANDOFF (the orchestrator's index.ts window — this module is
// not index.ts's owner; everything the handlers need is exported above)
// ---------------------------------------------------------------------------
//
// Upstream web.go:1270-1274 mounts three POSTs inside MustEnableActions'
// /actions group (the settingsGate + the has-actions 404 arm — the bare
// literal's redirect handler `repoActionsSettingsRedirect` already carries
// that exact gate shape, index.ts:6830-6841). The recipe, upstream-shape
// for shape:
//
//   1. PARSE — add to the settings family's resolveUiRequest switch (the
//      literal-armlist at index.ts:4603-4617):
//        rest.length === 4 && rest[0] === "actions" && rest[1] === "general"
//          && rest[2] === "collaborative_owner" && rest[3] === "add"
//            → family "settings-actions-general-collaborative-add"
//        rest.length === 4 && … rest[3] === "delete"
//            → family "settings-actions-general-collaborative-delete"
//        rest.length === 3 && rest[2] === "token_permissions"
//            → family "settings-actions-general-token-permissions"
//      (extend the family union at index.ts:1848-1854 accordingly).
//
//   2. HANDLERS — three functions beside `repoActionsUnitSubmit`
//      (index.ts:6865-6881), each: sameOriginGuard → resolveUiRequest →
//      settingsGate → MustEnableActions' repo arm (`loadRepoSettings`;
//      !hasActions → respond(c.html(renderNotFound(ctx), 404)) — upstream's
//      MustEnableActions 404, NOT a drift guard) → drift guard → form via
//      readUrlEncodedForm + the parser → the applier. Then:
//        - token_permissions ("settings-actions-general-token-permissions"):
//          applyRepoTokenPermissions; "saved" | "invalid-mode" → BOTH 303
//          location `${repoLinkOf(repo)}/settings/actions/general`
//          (upstream :182-185/:189-190 — the success flash and the
//          invalid-mode flash both land on the redirect; the
//          no-session-flash reduction drops only the flash itself);
//          "missing" is unreachable behind the gate.
//        - collaborative add: applyRepoCollaborativeOwnerAdd; "added" →
//          respond(c.json({ ok: true }), 200) (ctx.JSONOK,
//          services/context/context.go:243-245); "user-not-found" →
//          respond(c.json({ errorMessage: repoSettingsActionsGeneralLocale.user_not_exist,
//          renderFormat: "text" }), 400) (ctx.JSONError, context.go:276-278 —
//          the fetch-action JS surfaces it); "missing" unreachable.
//        - collaborative delete: applyRepoCollaborativeOwnerDelete;
//          "removed" → c.json({ ok: true }) 200; "not-an-owner" →
//          respond(c.json({ errorMessage: repoSettingsActionsGeneralLocale.not_found,
//          renderFormat: "text" }), 404) (ctx.JSONErrorNotFound,
//          context.go:286-292 — upstream ALSO flashes the
//          collaborative_owner_not_exist line; the flash is the reduction
//          casualty, the body/contract is upstream's).
//
//   3. REGISTER — the three families on the settings POST arm (the same
//      app.post table repoActionsUnitSubmit rides), so a disabled unit's
//      POST 404-shells through the gate arm (upstream's group placement).

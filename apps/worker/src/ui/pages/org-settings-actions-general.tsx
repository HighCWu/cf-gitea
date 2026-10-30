/**
 * The org settings ACTIONS tab's GENERAL sub-tab — the census C9 arm's ORG
 * scope (the owner token-permission page; pages/repo-settings-actions-
 * general.tsx is the repo scope and is NOT this module), ported from the pin
 * fc4936884584a41931906553d96c2601d750e6ef. The USER scope renders the SAME
 * shared upstream partial — pages/user-settings-actions-general.tsx re-exports
 * this module's scope-neutral core and renders only its own frame (the
 * packages twin's reuse split).
 *
 * ## Upstream surface (VERIFIED at the pin)
 *
 *   - `routers/web/web.go:1051-1061` — the org `/{org}/settings` subtree's
 *     `/actions` group, behind `actions.MustEnableActions` (web.go:1061; at
 *     the OWNER scopes the gate is the instance flags only — ctx.Repo is nil
 *     so the repo-permission arm cannot ride, routers/web/repo/actions/
 *     actions.go:67-81 — both compile-time TRUE in the landed posture, the
 *     runners twins' gate posture): `GET /settings/actions` →
 *     `misc.LocationRedirect("./actions/general")` (:1052 — misc.go:76-80's
 *     303 with the LITERAL relative bytes), the `/general` group
 *     (`GET ""` `shared_actions.GeneralSettings` :1054 + `POST ""`
 *     `shared_actions.UpdateGeneralSettings` :1055), then the runners/
 *     secrets/variables/scoped-workflows groups (:1056-1060).
 *   - `routers/web/shared/actions/general.go` — the scope-shared handlers:
 *     `GeneralSettings` (:46-98) sets Title `actions.actions` (:48), the
 *     `PageIsOrgSettingsActionsGeneral` flag (:57-58), loads the OWNER-level
 *     OwnerActionsConfig via `actions_model.GetOwnerActionsConfig(ctx,
 *     rCtx.OwnerID)` (:67-70), lays the render inputs
 *     (TokenPermissionMode/Permissive/Restricted, MaxTokenPermissions with
 *     the `(&repo_model.ActionsConfig{}).GetMaxTokenPermissions()` nil
 *     fallback :77-80 — the write-all default, EnableMaxTokenPermissions =
 *     `MaxTokenPermissions != nil` :81, AllowedRepos via
 *     `GetOwnerRepositoriesByIDs` :84-88 — repo_list.go:844-850, an empty id
 *     list answers an empty list WITHOUT a query :845-847 — and OwnerID
 *     :91), then renders `org/settings_actions_general`'s tpl (:93-97).
 *   - `models/actions/config.go:20-33` — the OwnerActionsConfig (a user OR
 *     org owner — the SAME store both scopes read): TokenPermissionMode,
 *     MaxTokenPermissions, AllowedCrossRepoIDs; :38-46 its store:
 *     `user_setting` KV row `SettingsKeyActionsConfig` via
 *     `GetUserSettingJSON`/`SetUserSettingJSON`.
 *   - `models/user/setting.go:210-232` — GetUserSettingJSON: an ABSENT row
 *     still runs the type's `ConversionFrom.FromDB` on the empty bytes
 *     (:217-223), and OwnerActionsConfig.FromDB is the ignore-error
 *     Unmarshal + `EnumValue` mode normalization — so a fresh owner's
 *     loaded config reads mode "permissive" (enums[0], the same
 *     normalization the repo store's loader documents), max nil.
 *
 *   - Templates: `org/settings/actions_general.tmpl` (layout_head with an
 *     EMPTY dict (:1) — Go renders the missing map key as "" — verified on
 *     Go 1.27: the page-content div is `class="page-content "` WITH the
 *     trailing space; this module passes `pageClass=""` for the byte-identical
 *     attribute) wrapping `<div class="org-setting-content">` (:2-4) around
 *     the SHARED `shared/actions/owner_general_settings` partial:
 *     the Cross-Repository Access section (owner_general_settings.tmpl:1-41 —
 *     the `h4.ui.top.attached.header` + attached segment, the form action
 *     `{{.Link}}` = the request URL with the template's own TRAILING SPACE
 *     in `class="ui form form-fetch-action "` (:5, mirrored verbatim), the
 *     desc help line (:7), the Target Repositories list (:13-30 — repo rows
 *     with `repo/icon` + the FullName link + the
 *     `?cross_repo_remove_target_id={id}` link-action Remove button, the
 *     `{{else}}` arm's "org.repos.none" line :27-29) and the Add Target
 *     Repository row (:31-40 — the `initSearchRepoBox` wrapper with
 *     data-uid/data-exclusive kept inert, the `cross_repo_add_target_name`
 *     input with the "search.repo_kind" placeholder, the
 *     `cross_repo_add_target` submit); then the Actions Token Permissions
 *     section (:43-58 — the form action `{{.Link}}` with
 *     `data-global-init="initOwnerActionsPermissionsForm"` kept inert, the
 *     SHARED `permission_mode_select` + `permissions_table` partials — the
 *     exact partials pages/repo-settings-actions-general.tsx renders for the
 *     repo scope, MINUS the repo-only override-owner checkbox — and the
 *     Update Settings submit). NO repo-only section renders here: the owner
 *     page's whole body is those two sections.
 *
 * ## The store (LANDED — this wave; the recorded reduction is retired)
 *
 * The OWNER-level OwnerActionsConfig store IS landed:
 * `user_settings_kv` (schema.ts, migration 0048 — the `user_setting`
 * column-for-column port) + services/actions/owner-actions-config.ts (the
 * Get/Set/parse/serialize store — the module header carries the full cite
 * set: config.go:38-47, setting.go:186-232, setting_options.go:26). The
 * loaders read it (an absent row still answers the fresh posture above —
 * upstream's own semantics, now the STORE's default rather than the
 * loader's hardcoded shape), and the POST arms' applier
 * (`applyOwnerActionsGeneralForms` — the UpdateGeneralSettings port,
 * general.go:100-161) rides the same store. The registrations stay the
 * wiring HANDOFF (the tail below) — index.ts is not this module's file.
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The `initSearchRepoBox` JS widget does not run (no bundler hook): the
 *   add input keeps upstream's name/placeholder/required contract and works
 *   as a plain text input; `data-global-init`/`data-uid`/`data-exclusive`
 *   are inert markup.
 * - The `initOwnerActionsPermissionsForm` bundle hook (the JS gating the
 *   max-permissions table on the checkbox) is not wired: the form posts the
 *   full radio set regardless, and the SERVER arm ignores the max radios
 *   unless `enable_max_permissions` is on (upstream's own rule) — the no-JS
 *   post is byte-equivalent.
 * - Allowed-repo rows keep upstream's `repo/icon` shape reduced to the svg
 *   arm (no avatar route — the repo general module's avatar reduction); the
 *   rows' Remove buttons keep the `link-action` + `data-url` contract
 *   verbatim (the repo general module's shape). The rows render for any
 *   owner with saved cross-repo targets (the store read).
 * - The success flash ("settings.saved_successfully") reduces to the bare
 *   303 (the no-session-flash convention): the wiring maps the saved
 *   outcome onto the redirect-back. The add arm's JSONError keeps
 *   upstream's exact body — `OWNER_ACTIONS_REPO_NOT_EXIST_ERROR` (the
 *   :125 literal under context.go:276-278's shape), answered 400 by the
 *   wiring (the repo-actions-view json-outcome convention).
 * - Scoped-workflows: NOT this module (no upstream page content here at
 *   all — it rides P1-3's scoped-workflows SPEC-attachment; the nav sub-item
 *   stays the recorded dead item).
 */

import { BaseLayout, Icon, renderPage } from "../shell";
import { OrgHeader } from "./org-home";
import { OrgSettingsNavbar } from "../components/settings-nav";
import type { UiContext } from "../ui-context";
import type { OrgRecord } from "../../services/orgs/orgs";
import {
  ACTIONS_TOKEN_PERMISSION_MODES,
  ACTIONS_TOKEN_UNIT_TYPES,
  makeWriteAllActionsTokenPermissions,
  type ActionsTokenPermissionMode,
  type ActionsTokenPermissions,
} from "../../services/actions/config";
import {
  getOwnerActionsConfig,
  getOwnerRepositoriesByIDs,
  getRepositoryByName,
  setOwnerActionsConfig,
  type OwnerActionsConfig,
} from "../../services/actions/owner-actions-config";
import {
  formBool,
  repoSettingsActionsGeneralLocale,
  repoSettingsActionsGeneralUnitLocale,
} from "./repo-settings-actions-general";

// ---------------------------------------------------------------------------
// The locale (this module adds only the strings the shared owner partial
// cites beyond the repo general module's shared-partial vocabulary — every
// string cites its upstream key)
// ---------------------------------------------------------------------------

export const orgSettingsActionsGeneralLocale = {
  actions: "Actions", // "actions.actions" — the page Title (general.go:48) and the navbars' disclosure summary
  cross_repo: "Cross-Repository Access", // "actions.general.cross_repo" (owner_general_settings.tmpl:2)
  cross_repo_desc:
    "Allow the selected repositories to be accessed (read-only) by all the repositories in this owner with GITEA_TOKEN when running Actions jobs.", // .cross_repo_desc (:7)
  cross_repo_target_repos: "Target Repositories", // .cross_repo_target_repos (:12)
  cross_repo_add: "Add Target Repository", // .cross_repo_add (:32)
  search_repo_kind: "Search repos…", // "search.repo_kind" (the add input's placeholder, :37)
  repos_none: "No repositories.", // "org.repos.none" (the empty list line, :28)
  add: "Add", // "add" (the add submit, :39)
} as const;

// ---------------------------------------------------------------------------
// The page data (general.go:46-98's render inputs at the no-setting posture)
// ---------------------------------------------------------------------------

/** An allowed-repo list row (upstream's GetOwnerRepositoriesByIDs rows
 *  reduced to what the render uses — `$repo.Link` + `$repo.FullName` +
 *  `$repo.ID`; the id is this deployment's TEXT repositories.id — the store
 *  module header's id-space note). */
export interface OwnerActionsGeneralAllowedRepo {
  id: string;
  fullName: string;
  link: string;
}

/** The owner general page's render inputs: the OWNER-level OwnerActionsConfig
 *  triple (general.go:70-80) + the allowed list (:84-90) + the OwnerID the
 *  search box's data-uid carries (:91). */
export interface OwnerActionsGeneralPageData {
  ownerId: number;
  tokenPermissionMode: ActionsTokenPermissionMode;
  maxTokenPermissions: ActionsTokenPermissions;
  enableMaxTokenPermissions: boolean;
  allowedRepos: OwnerActionsGeneralAllowedRepo[];
}

/** The config → render-inputs mapping (general.go:70-81): the mode rides
 *  verbatim, a nil max substitutes the write-all default (:77-79 —
 *  `(&repo_model.ActionsConfig{}).GetMaxTokenPermissions()`), and
 *  EnableMaxTokenPermissions is `MaxTokenPermissions != nil` (:81). The
 *  allowed list is the loader's SECOND read (GetOwnerRepositoriesByIDs,
 *  :84-88) and stays outside this mapping. */
export function deriveOwnerActionsGeneralData(cfg: OwnerActionsConfig): Omit<OwnerActionsGeneralPageData, "ownerId" | "allowedRepos"> {
  return {
    tokenPermissionMode: cfg.tokenPermissionMode,
    maxTokenPermissions: cfg.maxTokenPermissions ?? makeWriteAllActionsTokenPermissions(),
    enableMaxTokenPermissions: cfg.maxTokenPermissions !== null,
  };
}

/** The NO-SETTING OwnerActionsConfig posture — upstream's own render for a
 *  fresh owner: the absent `user_setting` row still runs FromDB (models/user/
 *  setting.go:217-223), whose EnumValue normalization answers "permissive";
 *  general.go:78-79 substitutes the write-all default for a nil max;
 *  EnableMaxTokenPermissions is `MaxTokenPermissions != nil` (:81); the
 *  allowed list starts empty (config.go:27's omitempty zero). This is now
 *  the STORE's absent-row answer (services/actions/owner-actions-config.ts's
 *  default) flowed through `deriveOwnerActionsGeneralData` — kept exported
 *  as the posture constant the user-scope GET renders until the wiring
 *  HANDOFF lands, and the tests' semantic reference. */
export const OWNER_ACTIONS_GENERAL_FRESH_DATA: Omit<OwnerActionsGeneralPageData, "ownerId"> = {
  ...deriveOwnerActionsGeneralData({ tokenPermissionMode: "permissive", maxTokenPermissions: null, allowedCrossRepoIds: [] }),
  allowedRepos: [],
};

/**
 * The org general page's load (general.go:46-98 at the ORG scope): the
 * owner config read (`GetOwnerActionsConfig`, :67-70 — the store's
 * absent-row default answers the fresh posture for a never-saved owner)
 * and the allowed-repos read (:84-88 — `GetOwnerRepositoriesByIDs`, whose
 * empty-ids arm is upstream's own no-query short-circuit,
 * models/repo/repo_list.go:845-847). The org record rides in for the frame
 * (OrgHeader + the OrgLink); `getRunnersCtx`'s owner id is `org.id`
 * (runners.go:82-91's org arm).
 */
export async function loadOrgActionsGeneralPageData(d1: D1Database, org: OrgRecord): Promise<OwnerActionsGeneralPageData> {
  const cfg = await getOwnerActionsConfig(d1, org.id);
  const allowedRepos = await getOwnerRepositoriesByIDs(d1, org.id, cfg.allowedCrossRepoIds);
  return { ownerId: org.id, ...deriveOwnerActionsGeneralData(cfg), allowedRepos };
}

// ---------------------------------------------------------------------------
// The form parsers (upstream UpdateGeneralSettings' reads — general.go:98-141)
// ---------------------------------------------------------------------------

/** The cross-repo form's POST body (general.go:119-139): the add arm rides
 *  the `cross_repo_add_target` FormBool + the `cross_repo_add_target_name`
 *  FormString (empty name = no-op :121), the remove arm the
 *  `cross_repo_remove_target_id` (upstream FormInt64, 0 = no-op :137-139 —
 *  parsed as a STRING here: the id space is this deployment's TEXT
 *  repositories.id, the store module header's id-space note, so the no-op
 *  sentinel is "" and a match is exact string equality). */
export interface OwnerActionsCrossRepoForm {
  crossRepoAddTarget: boolean;
  crossRepoAddTargetName: string;
  crossRepoRemoveTargetId: string;
}

export function parseOwnerActionsCrossRepoForm(params: URLSearchParams): OwnerActionsCrossRepoForm {
  return {
    crossRepoAddTarget: formBool(params.get("cross_repo_add_target")),
    crossRepoAddTargetName: params.get("cross_repo_add_target_name") ?? "",
    crossRepoRemoveTargetId: params.get("cross_repo_remove_target_id") ?? "",
  };
}

/** The permissions form's POST body (general.go:132-141): the mode string,
 *  the enable-max FormBool, one `max_unit_access_mode_{unitType}` radio per
 *  ActionsTokenUnitTypes (absent parses "" — the none arm) and the
 *  `max_id_token` literal. */
export interface OwnerActionsPermissionsForm {
  tokenPermissionMode: string;
  enableMaxPermissions: boolean;
  maxUnitAccessModes: Record<number, string>;
  maxIdToken: string;
}

export function parseOwnerActionsPermissionsForm(params: URLSearchParams): OwnerActionsPermissionsForm {
  const maxUnitAccessModes: Record<number, string> = {};
  for (const unitType of ACTIONS_TOKEN_UNIT_TYPES) {
    maxUnitAccessModes[unitType] = params.get(`max_unit_access_mode_${unitType}`) ?? "";
  }
  return {
    tokenPermissionMode: params.get("token_permission_mode") ?? "",
    enableMaxPermissions: formBool(params.get("enable_max_permissions")),
    maxUnitAccessModes,
    maxIdToken: params.get("max_id_token") ?? "",
  };
}

/** `ParseMaxTokenPermissions` (general.go:25-44) — the shared port: write/
 *  read keywords, everything else (incl. absent) none; the id-token grants
 *  on the literal "write". Pure — the future applier persists its result
 *  under `max_token_permissions` only when `enable_max_permissions` is on
 *  (:145-151); the OWNER arm (unlike the repo module's UpdateTokenPermissions)
 *  has NO invalid-mode refusal: `util.EnumValue` invalid modes are silently
 *  IGNORED (:142-152 — `tokenPermissionModeValid` false skips the whole
 *  mode/max block, keeping the stored values). */
export function parseMaxTokenPermissions(form: OwnerActionsPermissionsForm): ActionsTokenPermissions {
  const unitAccessModes: { [unitType: number]: 0 | 1 | 2 } = {};
  for (const unitType of ACTIONS_TOKEN_UNIT_TYPES) {
    const raw = form.maxUnitAccessModes[unitType];
    unitAccessModes[unitType] = raw === "write" ? 2 : raw === "read" ? 1 : 0;
  }
  return { unitAccessModes, idToken: form.maxIdToken === "write" };
}

// ---------------------------------------------------------------------------
// The POST arm (upstream UpdateGeneralSettings, general.go:100-161 — both
// forms post to the page URL, `.Link`; the wiring mounts it at both scopes,
// the HANDOFF tail)
// ---------------------------------------------------------------------------

/** The add arm's JSONError body — general.go:125's LITERAL string under
 *  context.go:276-278's shape (`buildJsonErrorMap`: a string message renders
 *  `"renderFormat":"text"`); the wiring answers it 400 on the
 *  `"repo-not-exist"` outcome (the repo-actions-view json-outcome
 *  convention). */
export const OWNER_ACTIONS_REPO_NOT_EXIST_ERROR = { errorMessage: "Repository doesn't exist", renderFormat: "text" } as const;

/** The apply outcomes: `saved` is the wiring's 303 back onto the page URL
 *  (general.go:159-160's JSONRedirect("") with the no-session-flash
 *  reduction — the flash body never renders); `repo-not-exist` is :125's
 *  early return — NOTHING is stored (the remove + permissions arms and the
 *  save are all skipped, upstream's control flow verbatim). */
export type UpdateOwnerActionsGeneralOutcome = { outcome: "saved" } | { outcome: "repo-not-exist" };

/**
 * `UpdateGeneralSettings` (general.go:100-161) over the landed owner store:
 * the config load (:115-118 — the store's absent-row default), then BOTH
 * arms in upstream's order over the one post body.
 *
 *   - Cross-repo add (:119-135): the FormBool + a NON-empty name resolve the
 *     repo WITHIN the owner (`GetRepositoryByName` — owner-pinned,
 *     lower_name case-folded; `getRepositoryByName`), missing → the :125
 *     JSONError early return; otherwise append-if-absent of the id
 *     (:131-133). An add-flag with an EMPTY name skips the resolution and
 *     falls through to the save (:121's guard) — upstream's no-op that
 *     still persists.
 *   - Cross-repo remove (:137-139): a non-zero id removes ALL its
 *     occurrences (`util.SliceRemoveAll`; "" here, the string id space).
 *   - Permissions (:142-152): the mode must be EnumValue-valid for the
 *     block to apply AT ALL — an INVALID mode is silently IGNORED, keeping
 *     the stored mode/max (the owner arm has NO repo-style refusal);
 *     enable-max on → `parseMaxTokenPermissions`, off → nil (:145-151).
 *
 *   Then `SetOwnerActionsConfig` (:154-157) — note upstream saves on EVERY
 *   non-refused post, even a no-op one (a fresh owner's first save writes
 *   the normalized default row). The flash + JSONRedirect("") ride the
 *   outcome (the wiring's 303; the header's reductions).
 */
export async function applyOwnerActionsGeneralForms(
  d1: D1Database,
  ownerId: number,
  crossRepo: OwnerActionsCrossRepoForm,
  permissions: OwnerActionsPermissionsForm,
): Promise<UpdateOwnerActionsGeneralOutcome> {
  const cfg = await getOwnerActionsConfig(d1, ownerId);
  if (crossRepo.crossRepoAddTarget && crossRepo.crossRepoAddTargetName !== "") {
    const target = await getRepositoryByName(d1, ownerId, crossRepo.crossRepoAddTargetName);
    if (target === null) return { outcome: "repo-not-exist" }; // :125 — the early return skips everything below
    if (!cfg.allowedCrossRepoIds.includes(target.id)) cfg.allowedCrossRepoIds.push(target.id); // :131-133
  }
  if (crossRepo.crossRepoRemoveTargetId !== "") {
    cfg.allowedCrossRepoIds = cfg.allowedCrossRepoIds.filter((id) => id !== crossRepo.crossRepoRemoveTargetId); // :137-139, SliceRemoveAll
  }
  if (ACTIONS_TOKEN_PERMISSION_MODES.includes(permissions.tokenPermissionMode as ActionsTokenPermissionMode)) {
    cfg.tokenPermissionMode = permissions.tokenPermissionMode as ActionsTokenPermissionMode;
    cfg.maxTokenPermissions = permissions.enableMaxPermissions ? parseMaxTokenPermissions(permissions) : null; // :145-151
  }
  await setOwnerActionsConfig(d1, ownerId, cfg);
  return { outcome: "saved" };
}

// ---------------------------------------------------------------------------
// The render (org/settings/actions_general.tmpl around the SHARED
// owner_general_settings partial — both owner scopes render this fragment)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderOrgActionsGeneralPage(ctx: UiContext, data: OrgActionsGeneralPageDataWithOrg): string {
  return renderPage(<OrgActionsGeneralPage ctx={ctx} data={data} />);
}

/** The org page's data: the config triple + the org record for the frame. */
export interface OrgActionsGeneralPageDataWithOrg extends OwnerActionsGeneralPageData {
  org: OrgRecord;
}

/** The org general page (layout_head with the EMPTY dict (:1) — `pageClass=""
 *  renders upstream's `class="page-content "` trailing-space attribute; the
 *  Title is `actions.actions`, general.go:48). The settings pages' org
 *  posture: the route prologue owns the require-owner gate (the
 *  org-settings-actions mount record's posture — anonymous 303s onto the
 *  login round-trip, a signed-in non-owner 404-shells). */
export function OrgActionsGeneralPage(props: { ctx: UiContext; data: OrgActionsGeneralPageDataWithOrg }) {
  const { ctx } = props;
  const orgLink = `/${props.data.org.username}`;
  const link = `${orgLink}/settings/actions/general`;
  return (
    <BaseLayout ctx={ctx} title={orgSettingsActionsGeneralLocale.actions} pageClass="">
      <OrgHeader org={props.data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={orgLink} active="actions-general" />
        <div class="flex-container-main">
          {/* actions_general.tmpl:2-4 — the org wrapper. */}
          <div class="org-setting-content">
            <OwnerActionsGeneralSections link={link} data={props.data} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/**
 * The SHARED owner body (shared/actions/owner_general_settings.tmpl) — the
 * org page renders it inside `.org-setting-content`, the user page directly
 * under layout_head (its actions_general.tmpl has NO content wrapper).
 */
export function OwnerActionsGeneralSections(props: { link: string; data: OwnerActionsGeneralPageData }) {
  const locale = orgSettingsActionsGeneralLocale;
  const repoLocale = repoSettingsActionsGeneralLocale;
  const tp = props.data;
  const accessMode = (unitType: number): 0 | 1 | 2 => tp.maxTokenPermissions.unitAccessModes[unitType] ?? 0;
  return (
    <>
      {/* owner_general_settings.tmpl:1-41 — the Cross-Repository Access
          section. The form class carries upstream's own trailing space
          after form-fetch-action (:5) — mirrored verbatim. */}
      <h4 class="ui top attached header">{locale.cross_repo}</h4>
      <div class="ui attached segment">
        <form class="ui form form-fetch-action " action={props.link} method="post">
          {/* :7 — the desc help line. */}
          <div class="help">{locale.cross_repo_desc}</div>
          {/* :10-41 — the field with the target list + the add row. */}
          <div class="field tw-mt-4">
            <h5 class="ui header">{locale.cross_repo_target_repos}</h5>
            <div class="ui attached segment tw-p-2">
              <div class="ui divided relaxed list flex-items-block muted-links">
                {/* :14-24 the rows (repo/icon + FullName link + the
                    link-action Remove); :27-29 the empty arm — what serves
                    for any owner with no saved targets yet. */}
                {tp.allowedRepos.length > 0 ? (
                  tp.allowedRepos.map((repo) => (
                    <div class="item">
                      <Icon name="octicon-repo" size={24} />
                      <a class="tw-flex-1" href={repo.link}>
                        {repo.fullName}
                      </a>
                      <button class="ui red compact tiny button link-action" type="button" data-url={`?cross_repo_remove_target_id=${repo.id}`}>
                        {repoLocale.remove}
                      </button>
                    </div>
                  ))
                ) : (
                  <div class="item">{locale.repos_none}</div>
                )}
              </div>
            </div>
            <h5 class="ui header">{locale.cross_repo_add}</h5>
            <div class="flex-text-block">
              {/* :37-39 — the initSearchRepoBox wrapper kept inert (the
                  module header's search-box reduction). */}
              <div data-global-init="initSearchRepoBox" data-uid={String(props.data.ownerId)} data-exclusive="true" class="ui search tw-flex-1">
                <div class="ui input">
                  <input class="prompt" name="cross_repo_add_target_name" required placeholder={locale.search_repo_kind} autocomplete="off" />
                </div>
              </div>
              <button class="ui primary button" type="submit" name="cross_repo_add_target" value="true">
                {locale.add}
              </button>
            </div>
          </div>
        </form>
      </div>
      {/* owner_general_settings.tmpl:43-58 — the Actions Token Permissions
          section (the SHARED permission_mode_select + permissions_table
          partials — the repo general module's locale carries every string;
          the repo-only override-owner checkbox does NOT render here). */}
      <h4 class="ui top attached header">{repoLocale.permissions}</h4>
      <div class="ui attached segment">
        <form class="ui form form-fetch-action" action={props.link} method="post" data-global-init="initOwnerActionsPermissionsForm">
          {/* shared/actions/permission_mode_select.tmpl */}
          <div class="field js-permission-mode-section">
            <label>{repoLocale.mode}</label>
            <div class="help">{repoLocale.mode_desc}</div>
            <div class="field">
              <div class="ui radio checkbox">
                <input type="radio" name="token_permission_mode" value="permissive" checked={tp.tokenPermissionMode === "permissive"} />
                <label>{repoLocale.mode_permissive}</label>
                <div class="help">{repoLocale.mode_permissive_desc}</div>
              </div>
            </div>
            <div class="field">
              <div class="ui radio checkbox">
                <input type="radio" name="token_permission_mode" value="restricted" checked={tp.tokenPermissionMode === "restricted"} />
                <label>{repoLocale.mode_restricted}</label>
                <div class="help">{repoLocale.mode_restricted_desc}</div>
              </div>
            </div>
          </div>
          <div class="divider"></div>
          {/* shared/actions/permissions_table.tmpl — the template's own
              unit list/order via the repo module's table rows (packages not
              rendered, the template's own omission). */}
          <div class="field">
            <label>{repoLocale.maximum}</label>
            <div class="help">
              {repoLocale.maximum_description}
              <br></br>
              {repoLocale.fork_pr_note}
            </div>
            <div class="field">
              <div class="ui checkbox">
                <input type="checkbox" name="enable_max_permissions" checked={tp.enableMaxTokenPermissions} />
                <label>{repoLocale.customize_max_permissions}</label>
              </div>
            </div>
            <table class="ui celled table js-permissions-table">
              <thead>
                <tr>
                  <th class="tw-w-2/5">{repoLocale.unit}</th>
                  <th class="tw-text-center">
                    {repoLocale.none_access}
                    <span class="tw-align-middle" data-tooltip-content={repoLocale.none_access_helper}>
                      <Icon name="octicon-question" size={16} class="tw-ml-1" />
                    </span>
                  </th>
                  <th class="tw-text-center">
                    {repoLocale.read_access}
                    <span class="tw-align-middle" data-tooltip-content={repoLocale.read_access_helper}>
                      <Icon name="octicon-question" size={16} class="tw-ml-1" />
                    </span>
                  </th>
                  <th class="tw-text-center">
                    {repoLocale.write_access}
                    <span class="tw-align-middle" data-tooltip-content={repoLocale.write_access_helper}>
                      <Icon name="octicon-question" size={16} class="tw-ml-1" />
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* permissions_table_unit.tmpl per row — none on 0/absent,
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
                    <strong>{repoLocale.id_token}</strong>
                    <div class="help">{repoLocale.id_token_description}</div>
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
          <div class="field">
            <button type="submit" class="ui primary button">
              {repoLocale.update_settings}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// The wiring HANDOFF (the orchestrator's index.ts window — this module is
// not index.ts's owner; the GET mounts are live, the POST arms' appliers
// are landed below — only the registrations remain)
// ---------------------------------------------------------------------------
//
// Upstream web.go:1051-1061 (org) / 720-732 (user) mount, inside the
// ownership/signed-in settings prologues:
//
//   1. THE BARE REDIRECTS (landable today — no store):
//        GET  /{org}/settings/actions          → 303 Location:
//              "./actions/general" — upstream's
//              `misc.LocationRedirect("./actions/general")` (web.go:1052,
//              misc.go:76-80): the LITERAL relative bytes are the Location
//              value exactly as the mounted twins send them
//              (adminActionsGroupRedirect's `location: "./actions/runners"`).
//        GET  /user/settings/actions           → 303 Location:
//              "./actions/general" (web.go:722 — the same literal).
//      Both sit INSIDE MustEnableActions (the instance-flag gate — vacuous
//      here), so the prologues alone arm them.
//
//   2. THE GET PAGES (mounted; the loader lines swap to the store read —
//      the old FRESH_DATA postures are stale until these two lines land):
//        org (index.ts orgActionsGeneralPage — the `loadOrgActionsGeneral
//        PageData(org)` spread becomes):
//              const data = await loadOrgActionsGeneralPageData(c.env.DB, org);
//              return respond(c.html(renderOrgActionsGeneralPage(ctx, { ...data, org }), 200));
//        user (index.ts userActionsGeneralPage — the inline
//        OWNER_ACTIONS_GENERAL_FRESH_DATA spread becomes):
//              const data = await loadUserActionsGeneralPageData(c.env.DB, p.viewer.id);
//              return p.respond(c.html(renderUserActionsGeneralPage(p.ctx, data), 200));
//      (parse arms unchanged: family "org-settings-actions-general" /
//      "user-settings-actions-general" as mounted.)
//
//   3. THE POST ARMS (the store IS landed — these register the mounted
//      applier; upstream posts BOTH forms to the page URL itself, `.Link`;
//      owner_general_settings.tmpl:5/:44):
//        POST /{org}/settings/actions/general
//        POST /user/settings/actions/general
//      The applier is applyOwnerActionsGeneralForms (the UpdateGeneral-
//      Settings port, general.go:100-161 — the add arm's within-owner
//      resolution + :125's JSONError early return, the remove-all arm, the
//      no-refusal EnumValue arm, the save). The glue bodies, verbatim:
//
//        async function orgActionsGeneralSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
//          const guard = sameOriginGuard(c.req.raw);
//          if (guard !== null) return guard;
//          const resolved = await resolveOrgTeamsRequest(c);
//          if (!resolved.ok) return resolved.response;
//          const { org, respond } = resolved;
//          if (resolved.route.family !== "org-settings-actions-general") return respond(await c.notFound()); // drift guard
//          const params = await readUrlEncodedForm(c.req.raw);
//          const outcome = await applyOwnerActionsGeneralForms(c.env.DB, org.id, parseOwnerActionsCrossRepoForm(params), parseOwnerActionsPermissionsForm(params));
//          if (outcome.outcome === "repo-not-exist") {
//            return respond(new Response(JSON.stringify(OWNER_ACTIONS_REPO_NOT_EXIST_ERROR), { status: 400, headers: { "content-type": "application/json;charset=utf-8" } }));
//          }
//          return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/general` } }));
//        }
//
//        async function userActionsGeneralSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
//          const p = await userSettingsTabPrologue(c, true);
//          if (!p.ok) return p.response;
//          const params = await readUrlEncodedForm(c.req.raw);
//          const outcome = await applyUserActionsGeneralForms(c.env.DB, p.viewer.id, parseUserActionsCrossRepoForm(params), parseUserActionsPermissionsForm(params));
//          if (outcome.outcome === "repo-not-exist") {
//            return p.respond(new Response(JSON.stringify(USER_ACTIONS_REPO_NOT_EXIST_ERROR), { status: 400, headers: { "content-type": "application/json;charset=utf-8" } }));
//          }
//          return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/actions/general" } }));
//        }
//
//      Registrations (next to the GET twins):
//        uiRouter.post("/:owner/settings/actions/general", (c) => orgActionsGeneralSubmit(c));
//        uiRouter.post("/user/settings/actions/general", (c) => userActionsGeneralSubmit(c));
//      Imports to add: applyOwnerActionsGeneralForms,
//      parseOwnerActionsCrossRepoForm, parseOwnerActionsPermissionsForm,
//      OWNER_ACTIONS_REPO_NOT_EXIST_ERROR from this module; the user-twin
//      aliases (applyUserActionsGeneralForms / parseUserActions*Form /
//      USER_ACTIONS_REPO_NOT_EXIST_ERROR) from pages/
//      user-settings-actions-general. `outcome.outcome === "saved"` maps
//      general.go:159-160's JSONRedirect("") + flash (the no-session-flash
//      reduction) onto the 303 back onto the page URL; "repo-not-exist" is
//      :125's ctx.JSONError LITERAL answered 400 (context.go:276-278's
//      {"errorMessage","renderFormat":"text"} — the repo-actions-view
//      json-outcome convention).
//      THE STORE (landed this wave, the recorded reduction retired):
//      `user_settings_kv` (schema.ts migration 0048 — upstream
//      `user_setting`'s column-for-column port) +
//      services/actions/owner-actions-config.ts (Get/Set + the Go-marshal
//      serialization + the absent-row default). The one adaptation: the
//      allowed-cross-repo ids are this deployment's TEXT repositories.id
//      (upstream int64) — the store module header's id-space note — so
//      `cross_repo_remove_target_id` parses as a string ("" = the no-op
//      sentinel where upstream's FormInt64 uses 0).

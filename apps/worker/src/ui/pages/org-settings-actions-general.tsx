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
 * ## The store gap (the recorded reduction — disclosed per page)
 *
 * The OWNER-level OwnerActionsConfig store has NO landed home: upstream
 * persists it as a `user_setting` KV row (`models/actions/config.go:38-46`),
 * and this deployment has no generic KV table — the landed `user_settings`
 * side store is the typed-column collapse of upstream's user-preference
 * KV keys (schema.ts; the theme/language + actions-email precedents), and
 * growing it needs a migration. src/db is outside this unit's ownership, so
 * the WRITE arms are the recorded reduction: the page renders the
 * NO-SETTING posture — which is upstream's own render for any owner without
 * a saved setting (the FromDB-on-absent-row chain above: mode permissive,
 * max = write-all, enable-max false, allowed list empty) — and the POST
 * arms stay unregistered (engine-owned 404s, the repo general module's
 * landing-state precedent). Everything a store wave needs is exported here:
 * the form parsers + `parseMaxTokenPermissions` (the shared
 * ParseMaxTokenPermissions port), and the HANDOFF tail spells the mount
 * recipe plus the POST semantics to port once the store lands.
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
 *   verbatim (the repo general module's shape). The rows are unreachable
 *   until the store lands (the reduction above) — the render carries the
 *   template's structure, the empty arm is what serves.
 * - The success flash ("settings.saved_successfully") and the add arm's
 *   JSONError reduce to the bare responses (the no-session-flash
 *   convention) — recorded in the HANDOFF, not rendered.
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
  ACTIONS_TOKEN_UNIT_TYPES,
  makeWriteAllActionsTokenPermissions,
  type ActionsTokenPermissionMode,
  type ActionsTokenPermissions,
} from "../../services/actions/config";
import {
  formBool,
  formInt64,
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
 *  `$repo.ID`; unreachable until the store lands, the module header). */
export interface OwnerActionsGeneralAllowedRepo {
  id: number;
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

/** The NO-SETTING OwnerActionsConfig posture — upstream's own render for a
 *  fresh owner: the absent `user_setting` row still runs FromDB (models/user/
 *  setting.go:217-223), whose EnumValue normalization answers "permissive";
 *  general.go:78-79 substitutes the write-all default for a nil max;
 *  EnableMaxTokenPermissions is `MaxTokenPermissions != nil` (:81); the
 *  allowed list starts empty (config.go:27's omitempty zero). This module's
 *  loaders answer exactly this (the store gap is the module header's
 *  recorded reduction); the owner id is the loader's own input
 *  (getRunnersCtx's OwnerID, runners.go:82-91's org/user arms). */
export const OWNER_ACTIONS_GENERAL_FRESH_DATA: Omit<OwnerActionsGeneralPageData, "ownerId"> = {
  tokenPermissionMode: "permissive",
  maxTokenPermissions: makeWriteAllActionsTokenPermissions(),
  enableMaxTokenPermissions: false,
  allowedRepos: [],
};

/**
 * The org general page's load (general.go:46-98 at the ORG scope): the
 * owner config read + the allowed-repos read both answer the no-setting
 * posture without a store (the header's reduction — the allowed list's
 * empty-ids arm is upstream's own no-query short-circuit,
 * models/repo/repo_list.go:845-847). Synchronous: there is genuinely no D1
 * read behind this load today. The org record rides in for the frame
 * (OrgHeader + the OrgLink); `getRunnersCtx`'s owner id is `org.id`
 * (runners.go:82-91's org arm).
 */
export function loadOrgActionsGeneralPageData(org: OrgRecord): OwnerActionsGeneralPageData {
  return { ownerId: org.id, ...OWNER_ACTIONS_GENERAL_FRESH_DATA };
}

// ---------------------------------------------------------------------------
// The form parsers (upstream UpdateGeneralSettings' reads — general.go:98-141;
// the APPLIERS are the store-gap reduction — the HANDOFF tail)
// ---------------------------------------------------------------------------

/** The cross-repo form's POST body (general.go:119-139): the add arm rides
 *  the `cross_repo_add_target` FormBool + the `cross_repo_add_target_name`
 *  FormString (empty name = no-op :121), the remove arm the
 *  `cross_repo_remove_target_id` FormInt64 (0 = no-op :137-139). */
export interface OwnerActionsCrossRepoForm {
  crossRepoAddTarget: boolean;
  crossRepoAddTargetName: string;
  crossRepoRemoveTargetId: number;
}

export function parseOwnerActionsCrossRepoForm(params: URLSearchParams): OwnerActionsCrossRepoForm {
  return {
    crossRepoAddTarget: formBool(params.get("cross_repo_add_target")),
    crossRepoAddTargetName: params.get("cross_repo_add_target_name") ?? "",
    crossRepoRemoveTargetId: formInt64(params.get("cross_repo_remove_target_id")),
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
                    link-action Remove); :27-29 the empty arm. The rows are
                    unreachable until the store lands (the module header). */}
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
// not index.ts's owner; the GET mounts can land TODAY, the POST arms need
// the store first — the module header's store-gap reduction)
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
//   2. THE GET PAGES (landable today — the renders serve the no-setting
//      posture):
//        GET  /{org}/settings/actions/general → resolveOrgForRequest →
//              requireOrgOwnership → loadOrgActionsGeneralPageData(org) →
//              renderOrgActionsGeneralPage. (parse arm:
//              rest === ["settings","actions","general"] in the org block,
//              family "org-settings-actions-general".)
//        GET  /user/settings/actions/general  → the userSettingsTabPrologue
//              → renderUserSettingsActionsGeneralPage(ctx) — the user
//              module's loader needs no D1 either. (parse arm: the literal
//              three-tail in the user-settings block, family
//              "user-settings-actions-general".)
//
//   3. THE POST ARMS (BLOCKED on the store — upstream posts BOTH forms to
//      the page URL itself, `.Link`; owner_general_settings.tmpl:5/:44):
//        POST /{org}/settings/actions/general
//        POST /user/settings/actions/general
//      Upstream UpdateGeneralSettings (general.go:100-161): parse with
//      parseOwnerActionsCrossRepoForm + parseOwnerActionsPermissionsForm;
//      add arm — `crossRepoAddTarget && crossRepoAddTargetName !== ""`
//      resolves the repo WITHIN the owner (GetRepositoryByName is
//      owner-pinned + lower_name case-insensitive, models/repo/repo.go)
//      → not-exist is ctx.JSONError("Repository doesn't exist") (a LITERAL,
//      :125) answered 400 `{"errorMessage":…,"renderFormat":"text"}`;
//      append-if-absent of the id (:131-133). Remove arm — a non-zero id
//      removes all its occurrences (:137-139). Permissions arm —
//      `token_permission_mode` must be a valid enum (util.EnumValue) for the
//      mode/max block to apply AT ALL (:142-152: an invalid mode silently
//      KEEPS the stored values — the owner arm has no repo-style refusal);
//      enable-max on → parseMaxTokenPermissions(form), off → nil (:145-151).
//      Then SetOwnerActionsConfig (:154-157), flash
//      "settings.saved_successfully" and JSONRedirect("") (:159-160 — the
//      no-session-flash reduction keeps the redirect, `""` = back onto the
//      page URL).
//      THE STORE: `user_setting` KV 'actions.config' (models/actions/
//      config.go:38-46, SettingsKeyActionsConfig) — no landed home; the
//      landed `user_settings` side store is typed-columns (schema.ts), so
//      the home decision (a new KV table vs a `user_settings` JSON column —
//      the theme/language collapse precedent needs the latter) is a src/db
//      wave BEFORE these POSTs can register. Until then the POSTs stay
//      engine-owned 404s (the repo general module's landing-state
//      precedent), and the page module's exported parsers above are the
//      wave's parse half.

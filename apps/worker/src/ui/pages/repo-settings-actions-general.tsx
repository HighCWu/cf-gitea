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
 *   - `routers/web/repo/setting/actions.go:23-93` — `ActionsGeneralSettings`
 *     (Title "actions.general", PageType "general",
 *     PageIsActionsSettingsGeneral) and `ActionsUnitPost` (the
 *     `enable_actions` FormBool → UpdateRepositoryUnits add/remove, flash
 *     success, `ctx.Redirect(RepoLink + "/settings/actions/general")` —
 *     base.go:157's default is 303 See Other).
 *   - `templates/repo/settings/actions.tmpl` (the PageType switchyard,
 *     pageClass `repository settings actions`) → `actions_general.tmpl`:
 *     the Enable Actions section FIRST and UNCONDITIONALLY (the h4 +
 *     attached segment + the `{{.Link}}/actions_unit` form — .Link is the
 *     current request URL, context.go:59/158, so the action is
 *     `.../settings/actions/general/actions_unit`); the Token Permissions
 *     section and the Collaborative Owners section both arm on
 *     `$isActionsEnabled` (collaborative owners AND on `.Repository.IsPrivate`,
 *     actions_general.tmpl:26, 57-58).
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
 * ## Data (the landed repo_settings store — no actions tables)
 *
 * The unit toggle rides `repo_settings.has_actions` (DEFAULT false — the
 * options form's `enable_actions` checkbox write, the API PATCH's
 * settingsPatch.hasActions arm), read through `loadRepoSettings` and written
 * through `saveRepoSettings` — the settings write idiom, exactly the API
 * route's own arm. Upstream keeps the unit on the `repo_unit` row itself
 * (UpdateRepositoryUnits); the landed reduction collapses the unit to the
 * flag (the MustEnableActions store — the C8 arm's gate reads the same
 * column).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The Token Permissions section (actions_general.tmpl:26-55 — the
 *   override-owner checkbox, permission_mode_select's permissive/restricted
 *   radios, permissions_table's per-unit maximum rows + the id-token row,
 *   the `initRepoActionsPermissionsForm` bundle hook) and the Collaborative
 *   Owners section (actions_general.tmpl:57-98 — the owner list + the
 *   search-user-box add form) DOCUMENTED-UNRENDERED: upstream stores their
 *   state in the repo_unit ActionsConfig JSON (OverrideOwnerConfig,
 *   TokenPermissionMode, MaxTokenPermissions, CollaborativeOwnerIDs —
 *   models/actions/config.go) and the landed store has no such column; a
 *   rendered form with no store would be a dead control. Their POST tails
 *   (`/general/collaborative_owner/{add,delete}`,
 *   `/general/token_permissions`) stay unclaimed → the engine's 404,
 *   upstream's unregistered-route answer. Landing them needs the
 *   ActionsConfig store (a migration — the orchestrator's window).
 * - `unit_model.TypeActions.UnitGlobalDisabled()` is FALSE in this
 *   deployment (actions are the instance's core — the C8 header's vacuous
 *   instance-flag posture), so actions_general.tmpl:9-22's disabled-
 *   checkbox/tooltip/no-submit branch is unreachable and collapses: the
 *   checkbox never renders disabled and the submit always renders.
 * - `ActionsUnitPost`'s success flash reduces to the plain 303 (the
 *   no-session-flash convention — the C8 twins' 303-on-success).
 * - The relocation debt: settings.tsx's options form carries
 *   `enable_actions` ("our UI has no Actions tab" — no longer true with
 *   this page landed; upstream keeps the checkbox ONLY here,
 *   actions_general.tmpl:13). Retiring the options copy is the
 *   orchestrator's settings.tsx fold (this module's header documents the
 *   debt; settings.tsx carries concurrent sibling hunks).
 */

import { loadRepoSettings, saveRepoSettings } from "../../api/services/repo-settings";
import { BaseLayout, renderPage } from "../shell";
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
  update_settings: "Update Settings", // "repo.settings.update_settings" (the submit button, actions_general.tmpl:20)
} as const;

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
// The page load (upstream ActionsGeneralSettings' unit read,
//  actions.go:28-36 — the isActionsEnabled the template arms on)
// ---------------------------------------------------------------------------

/** The general tab's render inputs: the unit status the toggle section and
 *  the nav's conditional both reflect. The enabled-posture sections' data
 *  (token permissions, collaborative owners) has no landed store — the
 *  module header's reduction. */
export interface RepoActionsGeneralPageData {
  isActionsEnabled: boolean;
}

export async function loadRepoActionsGeneralPageData(d1: D1Database, repoId: string): Promise<RepoActionsGeneralPageData> {
  const settings = await loadRepoSettings(d1, repoId);
  return { isActionsEnabled: settings.hasActions };
}

// ---------------------------------------------------------------------------
// The render (repo/settings/actions.tmpl PageType "general" +
//  actions_general.tmpl's Enable Actions section — the landed arm)
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
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={repoSettingsActionsGeneralLocale.general} pageClass="repository settings actions">
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
            <h4 class="ui top attached header">{repoSettingsActionsGeneralLocale.enable_actions}</h4>
            <div class="ui attached segment">
              <form class="ui form" action={`${repoLink}/settings/actions/general/actions_unit`} method="post">
                <div class="inline field">
                  <label>{repoSettingsActionsGeneralLocale.actions}</label>
                  <div class="ui checkbox">
                    <input name="enable_actions" type="checkbox" checked={props.data.isActionsEnabled} />
                    <label>{repoSettingsActionsGeneralLocale.actions_desc}</label>
                  </div>
                </div>
                <div class="divider"></div>
                <div class="field">
                  <button type="submit" class="ui primary button">
                    {repoSettingsActionsGeneralLocale.update_settings}
                  </button>
                </div>
              </form>
            </div>
            {/* The Token Permissions section (actions_general.tmpl:26-55)
                and the Collaborative Owners section (:57-98) are
                documented-unrendered — no landed ActionsConfig store (the
                module header's reduction; never a dead control). */}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

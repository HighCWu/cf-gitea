/**
 * The user settings ACTIONS tab's GENERAL sub-tab — the census C9 arm's USER
 * scope (the owner token-permission page), ported from the pin
 * fc4936884584a41931906553d96c2601d750e6ef — the user-scope twin of
 * pages/org-settings-actions-general.tsx, built by REUSE: upstream renders
 * the SAME shared partial (`shared/actions/owner_general_settings`) for BOTH
 * owner scopes through the SAME handlers (`shared_actions.GeneralSettings` /
 * `UpdateGeneralSettings` — the getRunnersCtx owner input is the only
 * difference), so every scope-neutral piece is RE-EXPORTED from the org
 * module verbatim and only the frame is rendered here (the packages twin's
 * reuse split).
 *
 * ## Upstream surface (VERIFIED at the pin)
 *
 *   - `routers/web/web.go:720-732` — the reqSignIn `/user/settings`
 *     subtree's `/actions` group, behind `actions.MustEnableActions`
 *     (:731 — at the OWNER scopes the gate is the instance flags only,
 *     ctx.Repo is nil so the repo-permission arm cannot ride,
 *     routers/web/repo/actions/actions.go:67-81; both compile-time TRUE in
 *     the landed posture — the user runners twin's gate posture):
 *     `GET /user/settings/actions` → `misc.LocationRedirect(
 *     "./actions/general")` (:722 — misc.go:76-80's 303 with the LITERAL
 *     relative bytes), the `/general` group (`GET ""`
 *     `shared_actions.GeneralSettings` :724 + `POST ""`
 *     `shared_actions.UpdateGeneralSettings` :725), then the runners/
 *     secrets/variables/scoped-workflows groups (:727-730).
 *   - `routers/web/shared/actions/general.go:46-98` — the SAME handler the
 *     org page rides; the USER arm sets `PageIsUserSettingsActionsGeneral`
 *     (:60-62) and renders `user/settings/actions_general` (:95-97's else).
 *   - Templates: `user/settings/actions_general.tmpl` — layout_head with an
 *     EMPTY dict (:1; Go renders the missing map key as "" — verified on
 *     Go 1.27: `class="page-content "` WITH the trailing space; this module
 *     passes `pageClass=""` for the byte-identical attribute) wrapping the
 *     SHARED `shared/actions/owner_general_settings` partial DIRECTLY (:2)
 *     with NO `.user-setting-content` wrapper — unlike the family's
 *     actions.tmpl switchyard pages, the general template has no content
 *     div of its own.
 *   - `templates/user/settings/navbar.tmpl:39-60` — the Actions disclosure
 *     (open while PageIsUserSettingsActionsGeneral is set, :40's or-arm)
 *     with the General sub-item FIRST (:43-45 — href
 *     `/user/settings/actions/general`, label `actions.general`).
 *
 * The shared body, the loaders' no-setting posture, the store gap (the
 * OWNER-level `user_setting` KV store has no landed home — the write arms
 * are the recorded reduction), the parsers and the full HANDOFF recipe live
 * on the org module's header: EVERY claim there cites the same scope-shared
 * upstream sources and carries over verbatim, the owner id being the doer's
 * (`getRunnersCtx`'s user arm — OwnerID = ctx.Doer.ID, runners.go:82-91).
 */

import { BaseLayout, renderPage } from "../shell";
import { UserSettingsNavbar } from "../components/settings-nav";
import type { UiContext } from "../ui-context";
import {
  OWNER_ACTIONS_GENERAL_FRESH_DATA,
  OwnerActionsGeneralSections,
  orgSettingsActionsGeneralLocale,
  parseMaxTokenPermissions,
  parseOwnerActionsCrossRepoForm,
  parseOwnerActionsPermissionsForm,
  type OwnerActionsCrossRepoForm,
  type OwnerActionsGeneralAllowedRepo,
  type OwnerActionsGeneralPageData,
  type OwnerActionsPermissionsForm,
} from "./org-settings-actions-general";

// ---------------------------------------------------------------------------
// The re-exports (the wiki-raw aliasing style — the scope-neutral pieces
// under user-facing names, so this module's consumers never see an org name)
// ---------------------------------------------------------------------------

export const userSettingsActionsGeneralLocale = orgSettingsActionsGeneralLocale;
export const OWNER_ACTIONS_GENERAL_FRESH_POSTURE = OWNER_ACTIONS_GENERAL_FRESH_DATA;
export type UserActionsGeneralPageData = OwnerActionsGeneralPageData;
export type UserActionsGeneralAllowedRepo = OwnerActionsGeneralAllowedRepo;
export type UserActionsCrossRepoForm = OwnerActionsCrossRepoForm;
export type UserActionsPermissionsForm = OwnerActionsPermissionsForm;
export const parseUserActionsCrossRepoForm = parseOwnerActionsCrossRepoForm;
export const parseUserActionsPermissionsForm = parseOwnerActionsPermissionsForm;
export const parseUserMaxTokenPermissions = parseMaxTokenPermissions;

// ---------------------------------------------------------------------------
// The load + render
// ---------------------------------------------------------------------------

/**
 * The user general page's load (general.go:46-98 at the USER scope): the
 * no-setting posture without a store — the org module's loader comment
 * carries the store-gap reduction. `getRunnersCtx`'s owner id is the doer's
 * id (runners.go:82-91's user arm).
 */
export function loadUserActionsGeneralPageData(userId: number): UserActionsGeneralPageData {
  return { ownerId: userId, ...OWNER_ACTIONS_GENERAL_FRESH_DATA };
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderUserActionsGeneralPage(ctx: UiContext, data: UserActionsGeneralPageData): string {
  return renderPage(<UserActionsGeneralPage ctx={ctx} data={data} />);
}

/** The user general page (layout_head with the EMPTY dict (:1) —
 *  `pageClass=""` renders upstream's `class="page-content "` trailing-space
 *  attribute; the Title is `actions.actions`, general.go:48). The settings
 *  pages' user posture: the route prologue owns the signed-in gate
 *  (resolveUiSession — anonymous 303s onto the login round-trip, a session
 *  doer without a D1 row 404-shells; the nav never branches on viewer
 *  state). NO `.user-setting-content` wrapper — actions_general.tmpl:2
 *  mounts the shared partial directly. */
export function UserActionsGeneralPage(props: { ctx: UiContext; data: UserActionsGeneralPageData }) {
  const link = "/user/settings/actions/general";
  return (
    <BaseLayout ctx={props.ctx} title={userSettingsActionsGeneralLocale.actions} pageClass="">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="actions-general" />
        <div class="flex-container-main">
          <OwnerActionsGeneralSections link={link} data={props.data} />
        </div>
      </div>
    </BaseLayout>
  );
}

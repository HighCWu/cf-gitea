/**
 * The USER settings ACTIONS tab's SCOPED-WORKFLOWS sub-tab — the P1-3
 * staged pages' USER frame (pages/actions-scoped-workflows.tsx is the
 * scope-neutral core this module renders; the org/admin twins are
 * siblings), ported from the pin fc4936884584a41931906553d96c2601d750e6ef.
 *
 * Upstream: web.go:730 mounts addSettingsScopedWorkflowsRoutes inside the
 * reqSignIn `/user/settings/actions` group (web.go:721-731, behind
 * `actions.MustEnableActions` — at the OWNER scopes the gate is the
 * instance flags only, the runners twins' gate posture); the handler
 * renders `user/settings/actions.tmpl:9-11`'s PageType
 * "scoped-workflows" arm — layout pageClass `user settings actions`, the
 * `.user-setting-content` wrapper around the SHARED
 * shared/actions/scoped_workflows.tmpl. The nav arm is user/settings/
 * navbar.tmpl:55-56 (href `/user/settings/actions/scoped-workflows`; the
 * disclosure's open-arm includes PageIsSharedSettingsScopedWorkflows).
 *
 * The shared body, the store seam, the loaders and the POST appliers live
 * on the core module's header (every claim there cites the same
 * scope-shared upstream sources); the POST glue imports the appliers from
 * the core directly. The navbar element rides the `nav` prop — the core
 * header's nav reduction (the shared navbar's sub-item is the recorded
 * dead item until the fold hunk lands; the core's HANDOFF tail carries the
 * exact fold + mount recipes).
 */

import type { Child } from "hono/jsx";
import { renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import {
  UserScopedWorkflowsPage,
  loadScopedWorkflowsPageData,
  scopedWorkflowsLocale,
  type ScopedWorkflowFileReads,
  type ScopedWorkflowSourceRepoView,
  type ScopedWorkflowSourcesStore,
  type ScopedWorkflowsPageData as UserScopedWorkflowsPageData,
} from "./actions-scoped-workflows";

export { UserScopedWorkflowsPage, scopedWorkflowsLocale as userScopedWorkflowsLocale };
export type { UserScopedWorkflowsPageData };

/**
 * The user scoped-workflows page's load (`ScopedWorkflows` at the USER
 * scope — the owner id is the DOER's, getScopedWorkflowsCtx's user arm
 * scoped_workflows.go:60-66).
 */
export async function loadUserScopedWorkflowsPageData(
  store: ScopedWorkflowSourcesStore,
  d1: D1Database,
  readsFor: (repo: ScopedWorkflowSourceRepoView) => ScopedWorkflowFileReads,
  userId: number,
): Promise<UserScopedWorkflowsPageData> {
  return loadScopedWorkflowsPageData(store, d1, readsFor, { kind: "user", ownerId: userId });
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderUserScopedWorkflowsPage(ctx: UiContext, data: UserScopedWorkflowsPageData, nav: Child): string {
  return renderPage(<UserScopedWorkflowsPage ctx={ctx} data={data} nav={nav} />);
}

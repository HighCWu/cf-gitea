/**
 * The ADMIN actions SCOPED-WORKFLOWS page — the P1-3 staged pages' INSTANCE
 * frame (pages/actions-scoped-workflows.tsx is the scope-neutral core this
 * module renders; the org/user twins are siblings), ported from the pin
 * fc4936884584a41931906553d96c2601d750e6ef. Upstream's
 * `getScopedWorkflowsCtx` admin arm (scoped_workflows.go:69-77) runs the
 * SAME handlers at OwnerID 0: every repo on the instance is addable (the
 * `owner/name` form spelling), the search box submits full names
 * (ScopedWorkflowsSearchFullName, :145) and the desc is desc_global.
 *
 * Upstream: web.go:903 mounts addSettingsScopedWorkflowsRoutes inside the
 * `/-/admin/actions` group (web.go:898-905, behind `adminReq` — the shared
 * adminPagePrologue posture); the handler renders
 * `admin/actions.tmpl:9-11`'s PageType "scoped-workflows" arm — layout
 * pageClass `admin actions`, the `.admin-setting-content` wrapper around
 * the SHARED shared/actions/scoped_workflows.tmpl. The nav arm is
 * admin/navbar.tmpl:84-85 (href `/-/admin/actions/scoped-workflows`).
 *
 * The shared body, the store seam, the loaders and the POST appliers live
 * on the core module's header (every claim there cites the same
 * scope-shared upstream sources); the POST glue imports the appliers from
 * the core directly. The navbar element rides the `nav` prop — the core
 * header's nav reduction (the admin family nav's sub-item is the recorded
 * dead item until the fold hunk lands; the core's HANDOFF tail carries the
 * exact fold + mount recipes).
 */

import type { Child } from "hono/jsx";
import { renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import {
  AdminScopedWorkflowsPage,
  loadScopedWorkflowsPageData,
  scopedWorkflowsLocale,
  type ScopedWorkflowFileReads,
  type ScopedWorkflowSourceRepoView,
  type ScopedWorkflowSourcesStore,
  type ScopedWorkflowsPageData as AdminScopedWorkflowsPageData,
} from "./actions-scoped-workflows";

export { AdminScopedWorkflowsPage, scopedWorkflowsLocale as adminScopedWorkflowsLocale };
export type { AdminScopedWorkflowsPageData };

/**
 * The admin scoped-workflows page's load (`ScopedWorkflows` at the INSTANCE
 * scope — OwnerID 0, getScopedWorkflowsCtx's admin arm
 * scoped_workflows.go:69-77).
 */
export async function loadAdminScopedWorkflowsPageData(
  store: ScopedWorkflowSourcesStore,
  d1: D1Database,
  readsFor: (repo: ScopedWorkflowSourceRepoView) => ScopedWorkflowFileReads,
): Promise<AdminScopedWorkflowsPageData> {
  return loadScopedWorkflowsPageData(store, d1, readsFor, { kind: "admin" });
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderAdminScopedWorkflowsPage(ctx: UiContext, data: AdminScopedWorkflowsPageData, nav: Child): string {
  return renderPage(<AdminScopedWorkflowsPage ctx={ctx} data={data} nav={nav} />);
}

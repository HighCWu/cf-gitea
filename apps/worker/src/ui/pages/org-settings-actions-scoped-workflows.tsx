/**
 * The ORG settings ACTIONS tab's SCOPED-WORKFLOWS sub-tab — the P1-3 staged
 * pages' ORG frame (pages/actions-scoped-workflows.tsx is the scope-neutral
 * core this module renders; the user/admin twins are siblings), ported from
 * the pin fc4936884584a41931906553d96c2601d750e6ef.
 *
 * Upstream: web.go:1060 mounts addSettingsScopedWorkflowsRoutes inside the
 * `/{org}/settings/actions` group (web.go:1051-1061, behind
 * `actions.MustEnableActions` — at the OWNER scopes the gate is the
 * instance flags only, the runners twins' gate posture) inside the
 * org-settings prologue; the handler renders
 * `org/settings/actions.tmpl:9-11`'s PageType "scoped-workflows" arm —
 * layout pageClass `organization settings actions`, the
 * `.org-setting-content` wrapper around the SHARED
 * shared/actions/scoped_workflows.tmpl. The nav arm is org/settings/
 * navbar.tmpl:44-45 (href `{OrgLink}/settings/actions/scoped-workflows`;
 * the disclosure's open-arm includes PageIsSharedSettingsScopedWorkflows).
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
import type { OrgRecord } from "../../services/orgs/orgs";
import {
  OrgScopedWorkflowsPage,
  loadScopedWorkflowsPageData,
  scopedWorkflowsLocale,
  type ScopedWorkflowFileReads,
  type ScopedWorkflowSourceRepoView,
  type ScopedWorkflowSourcesStore,
  type ScopedWorkflowsPageData as OrgScopedWorkflowsPageData,
} from "./actions-scoped-workflows";

export { OrgScopedWorkflowsPage, scopedWorkflowsLocale as orgScopedWorkflowsLocale };
export type { OrgScopedWorkflowsPageData };

/**
 * The org scoped-workflows page's load (`ScopedWorkflows` at the ORG scope
 * — the owner id is the org's, getScopedWorkflowsCtx's org arm
 * scoped_workflows.go:50-56). The store read lists the org's sources; the
 * repo reads + parses ride the core's assembly.
 */
export async function loadOrgScopedWorkflowsPageData(
  store: ScopedWorkflowSourcesStore,
  d1: D1Database,
  readsFor: (repo: ScopedWorkflowSourceRepoView) => ScopedWorkflowFileReads,
  org: Pick<OrgRecord, "id" | "username">,
): Promise<OrgScopedWorkflowsPageData> {
  return loadScopedWorkflowsPageData(store, d1, readsFor, { kind: "org", ownerId: org.id, orgLink: `/${org.username}` });
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderOrgScopedWorkflowsPage(ctx: UiContext, data: OrgScopedWorkflowsPageData, org: OrgRecord, nav: Child): string {
  return renderPage(<OrgScopedWorkflowsPage ctx={ctx} data={data} org={org} nav={nav} />);
}

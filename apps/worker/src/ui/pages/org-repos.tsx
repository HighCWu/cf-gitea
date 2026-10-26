/**
 * The organization repositories page, `/{org}/-/repositories` — pages wave 23
 * (the UI-parity survey's next tier, docs/compat/ui-parity-survey.md family B
 * row `GET /{username}/-/repositories`: upstream web.go:1107's
 * `m.Group("/{username}/-", …)` with web.go:1134's
 * `m.Get("/repositories", org.Repositories)`).
 *
 * ## Upstream shape (cited)
 *
 * `org.Repositories` is `orgHome(ctx, true)` (routers/web/org/home.go:44-46):
 * the SAME tplOrgHome the org profile renders, with the repositories view
 * forced — and `org == nil` (a plain USER name reaching the route) answers
 * NotFound (home.go:50-54's own comment: "some requests may reach here by
 * 'user' route patterns"). At this pin the org profile has no profile-readme
 * pipeline on our side, so upstream's two URLs serve the same DOM through
 * one template: the Repositories tab (active — menu.tmpl links it to
 * `/-/repositories` only when a profile readme exists, which ours never
 * does, so upstream's own tab link is the plain home URL), the repo list,
 * and the pager.
 *
 * ## The slice
 *
 * The page module is therefore the FAMILY seam over the landed org-home
 * halves (pages/org-home.tsx), never a fork: the resolution is
 * `resolveOrgHome` verbatim — a plain user name is a `missing` (the
 * `org == nil` arm), a renamed org 307s, `orgVisibleToDoer` hides an
 * invisible org behind the shared 404 — the loader is `loadOrgHomeData`
 * (the `listOrgRepositories` read, §4.7's owner/team visibility arms), and
 * the render is `renderOrgHomePage` (the landed DOM). Documented
 * divergences carry over unchanged (the org-home module header): the
 * `?q=`/`sort` search facets of upstream's `shared/repo/search` box stay
 * unrendered (no landed repo-search over an org's rows — the org home's own
 * reduction note), the list order is the service's `slug ASC`, page size
 * upstream `setting.UI.User.RepoPagingNum` = 15.
 *
 * The upstream-sibling tails of the `/-` namespace (`/-/heatmap`,
 * `/-/packages*`, `/-/projects*`, `/-/code`) stay unclaimed → the engine's
 * 404, exactly upstream's unregistered-route answer for slices that have not
 * landed (the survey's L-effort rows).
 */

import type { OrgDoer } from "../../api/services/org-repos";
import type { UiContext } from "../ui-context";
import {
  loadOrgHomeData,
  renderOrgHomePage,
  resolveOrgHome,
  type OrgHomeData,
  type OrgHomeResolution,
} from "./org-home";
import type { OrgRecord } from "../../services/orgs/orgs";

/** The resolution outcome for `/{org}/-/repositories` (the org-home
 *  resolution's exact union — the family adds no arm of its own). */
export type OrgRepositoriesResolution = OrgHomeResolution;

/**
 * Resolve the org for the repositories family: `resolveOrgHome` verbatim —
 * a plain USER name is a `missing` (upstream org.Repositories' `org == nil`
 * NotFound arm, home.go:50-54), a renamed org 307s onto the new name,
 * `orgVisibleToDoer` 404-shells an invisible org.
 */
export function resolveOrgRepositories(
  d1: D1Database,
  owner: string,
  doer: OrgDoer,
  requestPath: string,
  requestQuery: string,
): Promise<OrgRepositoriesResolution> {
  return resolveOrgHome(d1, owner, doer, requestPath, requestQuery);
}

/** The repositories page render inputs (the org-home data verbatim — one
 *  template serves both upstream URLs). */
export type OrgRepositoriesData = OrgHomeData;

/** Load the page: the org home's loader verbatim (the landed
 *  `listOrgRepositories` read + the batched description read). */
export function loadOrgRepositoriesData(
  d1: D1Database,
  org: OrgRecord,
  doer: OrgDoer,
  params: URLSearchParams,
): Promise<OrgRepositoriesData> {
  return loadOrgHomeData(d1, org, doer, params);
}

/** The full-document render: the org home's page verbatim — upstream serves
 *  tplOrgHome through both URLs (the module header). */
export function renderOrgRepositoriesPage(ctx: UiContext, data: OrgRepositoriesData): string {
  return renderOrgHomePage(ctx, data);
}

/**
 * The ORG-scoped issue/pull/milestone overview pages — `/org/{org}/issues`,
 * `/org/{org}/pulls`, `/org/{org}/milestones` and their `/{team}` tails
 * (this wave — the census's R07 brief; the dispatch's fourth surface):
 * upstream web.go:986-991's routes under
 * `context.OrgAssignment(RequireMember: true, RequireTeamMember: true)` —
 * `user.Issues` / `user.Pulls` / `user.Milestones` at the SAME handlers the
 * personal inbox pages ride (routers/web/user/home.go:139-348), scoped to
 * the org's repo set by `buildIssueOverview`/`Milestones`' org branch
 * (home.go:428-433 + 142-144: `opts.Owner = ctx.Org.Organization.AsUser()`,
 * `repoOpts.OwnerID = ctxUser.ID`, the team tail sets `repoOpts.TeamID`).
 *
 * ## The member-only 404 posture (the census's explicit call)
 *
 * OrgAssignment (services/context/org.go:72-256) for this group:
 *   1. the org resolves by name (GetOrganizationByParams — the landed
 *      `resolveOrgHome` seam is that ladder: the type-gated lookup, the
 *      rename 307 through the org redirect table, the visibility gate);
 *   2. RequireMember (org.go:100-147 — force-set for private orgs): the
 *      viewer must hold an `org_members` row, OR be a site admin
 *      (org.go:110-114's IsMember bypass) — EVERYONE ELSE 404s, anonymous
 *      included (OrgAssignment never 303s — NO login redirect);
 *   3. the `{team}` tail resolves case-insensitively by `lower_name`
 *      (org.go:204-222) and RequireTeamMember (org.go:224-233) 404s a
 *      non-owner non-admin who is not a member of THAT team. A team miss
 *      404s.
 *
 * ## The page (templates/user/dashboard/* — the SAME templates as the
 *  personal inbox)
 *
 * `.page-content.dashboard.issues` (both lists) and the milestones class;
 * the dashboard/navbar's ORG branch (navbar.tmpl:46 + 79-96): the switcher
 * item carries the ORG (the name + the Limited/Private visibility badge —
 * the avatar-slot rule keeps the name alone) anchoring the org home, and
 * the right menu renders the Issues/Pulls/Milestones tabs
 * (`.OrganisationLink()/{kind}` + the team tail, active-selected).
 * Upstream's Activities tab (`{org}/dashboard`) links census R06's org
 * dashboard — not landed this wave, the dead-link rule (§2.4.1) keeps it
 * unrendered, the recorded reduction. The list body is the shared inbox
 * DOM — the loaders are the parameterized global-inbox reads with the org
 * repo-set scope (`OverviewOrgScope`), upstream's AllPublic extension never
 * applying (home.go:479-487's self-only condition).
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { orgMembers, teamMembers, teams } from "../../db/schema";
import { renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import type { OrgDoer } from "../../api/services/org-repos";
import type { OrgRecord } from "../../services/orgs/orgs";
import {
  loadDashboardMilestonesData,
  loadOverviewIssuesData,
  DashboardMilestonesPage,
  OverviewIssuesPage,
  type DashboardMilestonesData,
  type OverviewIssuesData,
  type OverviewOrgScope,
} from "./global-inbox";
import { resolveOrgHome } from "./org-home";

/** The route's parsed kind (the three overview tails). */
export type OrgInboxKind = "issues" | "pulls" | "milestones";

/** The resolution outcome (module header's ladder): the ready-to-load
 *  scope (with the resolved org row for the navbar), a rename redirect, or
 *  a miss (→ the 404 shell). */
export type OrgInboxResolution =
  | { kind: "ok"; org: OrgRecord; scope: OverviewOrgScope }
  | { kind: "redirect"; location: string }
  | { kind: "missing" };

/**
 * The RequireMember/RequireTeamMember ladder (module header) over the
 * landed org-home seam — the handler calls this, then dispatches the
 * outcome union.
 */
export async function resolveOrgInbox(
  d1: D1Database,
  orgName: string,
  viewer: Viewer,
  requestPath: string,
  requestQuery: string,
  teamName: string | null,
): Promise<OrgInboxResolution> {
  const doer: OrgDoer =
    viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
  const orgHome = await resolveOrgHome(d1, orgName, doer, requestPath, requestQuery);
  if (orgHome.kind === "redirect") return orgHome;
  if (orgHome.kind !== "org") return { kind: "missing" };
  const org = orgHome.org;

  const viewerId = viewer.kind === "user" ? viewer.id : null;
  const viewerIsAdmin = viewer.kind === "user" ? viewer.isAdmin : false;

  // RequireMember (org.go:100-147): site admins bypass; every non-member —
  // anonymous included — 404s.
  let isOwnerMember: boolean;
  if (viewerIsAdmin) {
    isOwnerMember = true;
  } else {
    if (viewerId === null) return { kind: "missing" };
    const member = await drizzle(d1)
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, viewerId)))
      .get();
    if (member === undefined) return { kind: "missing" }; // RequireMember's 404
    isOwnerMember = member.role === "owner";
  }

  // The team tail (org.go:204-233): resolve by lower_name, then
  // RequireTeamMember — non-owner non-admins must BE members of the team.
  let teamId: number | null = null;
  let resolvedTeamName: string | null = null;
  if (teamName !== null) {
    const team =
      (await drizzle(d1)
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .where(and(eq(teams.orgId, org.id), eq(teams.lowerName, teamName.toLowerCase())))
        .get()) ?? null;
    if (team === null) return { kind: "missing" }; // the visible-set miss → 404
    if (!viewerIsAdmin && !isOwnerMember) {
      if (viewerId === null) return { kind: "missing" };
      const teamMember = await drizzle(d1)
        .select({ id: teamMembers.id })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, viewerId)))
        .get();
      if (teamMember === undefined) return { kind: "missing" }; // RequireTeamMember's 404
    }
    teamId = team.id;
    resolvedTeamName = team.name;
  }

  return {
    kind: "ok",
    org,
    scope: {
      orgId: org.id,
      orgName: org.username,
      viewerId: viewerId as number,
      viewerIsAdmin,
      isOwnerMember,
      teamId,
      teamName: resolvedTeamName,
    },
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The dashboard navbar's ORG branch (navbar.tmpl:46 + 79-96): the
 *  switcher item carries the org (the name + the Limited/Private visibility
 *  badge — the avatar-slot rule keeps the name alone) anchoring the org
 *  home, then the right menu's Issues/Pulls/Milestones tabs — the first
 *  carries `tw-ml-auto` (the upstream right-menu shape). Upstream's
 *  Activities tab links R06's org dashboard — not landed, the dead-link
 *  rule keeps it unrendered (module header). */
export function OrgInboxNavbar(props: {
  orgName: string;
  visibility: "public" | "limited" | "private";
  active: OrgInboxKind;
  teamName: string | null;
}) {
  const tail = props.teamName === null ? "" : `/${props.teamName}`;
  const tabs: Array<[OrgInboxKind, string, string]> = [
    ["issues", "Issues", `/org/${props.orgName}/issues${tail}`],
    ["pulls", "Pull Requests", `/org/${props.orgName}/pulls${tail}`],
    ["milestones", "Milestones", `/org/${props.orgName}/milestones${tail}`],
  ];
  return (
    <div class="secondary-nav tw-border-b tw-border-b-secondary">
      <div class="ui secondary stackable menu">
        <div class="item">
          <a class="active selected item" href={`/${props.orgName}`}>
            <span class="gt-ellipsis">{props.orgName}</span>
            {props.visibility === "limited" ? <div class="ui basic tiny horizontal label">Limited</div> : null}
            {props.visibility === "private" ? <div class="ui basic tiny horizontal label">Private</div> : null}
          </a>
        </div>
        {tabs.map(([kind, label, href], i) => (
          <a key={kind} class={props.active === kind ? `active item${i === 0 ? " tw-ml-auto" : ""}` : `item${i === 0 ? " tw-ml-auto" : ""}`} href={href}>
            {label}
          </a>
        ))}
      </div>
    </div>
  );
}

/** The org page's render inputs beside the shared data (the navbar's). */
export interface OrgInboxChrome {
  orgName: string;
  visibility: "public" | "limited" | "private";
  teamName: string | null;
}

/** The full-document render — the org issues/pulls page (the shared
 *  dashboard template through the org navbar slot). */
export function renderOrgInboxIssuesPage(ctx: UiContext, data: OverviewIssuesData, chrome: OrgInboxChrome): string {
  return renderPage(
    <OverviewIssuesPage
      ctx={ctx}
      data={data}
      navbar={<OrgInboxNavbar {...chrome} active={data.listKind} />}
    />,
  );
}

/** The full-document render — the org milestones page. */
export function renderOrgInboxMilestonesPage(ctx: UiContext, data: DashboardMilestonesData, chrome: OrgInboxChrome): string {
  return renderPage(
    <DashboardMilestonesPage
      ctx={ctx}
      data={data}
      navbar={<OrgInboxNavbar {...chrome} active="milestones" />}
    />,
  );
}

/** The loader pass-throughs for the handler (kind dispatch — the census's
 *  "the loader parameterization is the bulk" is global-inbox's; this seam
 *  keeps the handler thin). */
export async function loadOrgInboxIssuesData(
  d1: D1Database,
  viewer: Viewer,
  kind: "issues" | "pulls",
  params: URLSearchParams,
  scope: OverviewOrgScope,
): Promise<OverviewIssuesData> {
  return loadOverviewIssuesData(d1, viewer, kind, params, scope);
}

export async function loadOrgInboxMilestonesData(
  d1: D1Database,
  viewer: Viewer,
  params: URLSearchParams,
  scope: OverviewOrgScope,
): Promise<DashboardMilestonesData> {
  return loadDashboardMilestonesData(d1, viewer, params, new Date(), scope);
}

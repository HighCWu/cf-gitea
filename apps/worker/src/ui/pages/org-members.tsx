/**
 * The organization members page, `/org/{org}/members` — pages wave 23 (the
 * UI-parity survey's next tier, docs/compat/ui-parity-survey.md family B row
 * `GET /org/{org}/members`, web.go:965 `m.Get("/members", org.Members)`).
 *
 * ## DOM contract (templates/org/member/members.tmpl + org/header.tmpl at the
 *  pin)
 *
 * pageClass is the template's literal `organization members`, then the shared
 * org/header.tmpl (pages/org-home.tsx OrgHeader — the teams/org-labels
 * precedent; the template carries no org menu), then the container: the
 * owner prompt row (`.flex-text-block` with the "Manage teams and members"
 * primary button — upstream links `./teams` under /org/{org}; ours links the
 * landed teams page at `/{org}/teams`, the org-teams/labels literal
 * divergence), the `?q=` search form (members.tmpl's
 * `ui form ignore-dirty tw-my-4` + `ui small fluid action input`), the
 * `.flex-divided-list.items-with-main` member rows, and base/paginate.
 * Per-row: the `.item-leading` avatar slot (the org-home placeholder rule —
 * the person glyph, NOT a link: an icon-only link has no accessible name),
 * the `.item-title` name link + the `ui basic small label` "Hidden" badge
 * when the membership is not public, and — only when the viewer's listing is
 * NOT public-only — the `org.members.member_role` line with the Owner row
 * carrying the shield-lock glyph inside the `<strong class="flex-text-
 * inline">` (members.tmpl:31-37).
 *
 * ## Who sees what (upstream FindOrgMembersOpts.PublicOnly, cited)
 *
 * The page is ANONYMOUS-CAPABLE: the web.go group's `optSignIn` is
 * `SignInRequired: setting.Service.RequireSignInViewStrict` — off at the pin
 * (web.go:354). Page reach follows OrgAssignment's visibility collapse
 * (services/context/org.go:88-101 — limited/private orgs hide from
 * unauthorized viewers) through the LANDED `orgVisibleToDoer`
 * (HasOrgOrUserVisible — an invisible org 404-shells, indistinguishable from
 * a missing one). The listing itself follows `FindOrgMembersOpts.PublicOnly()`
 * (models/organization/org.go:180-182) through the LANDED composition
 * (`orgMembersPublicOnly` + `isDoerOrgMember`, api/services/orgs.ts — the
 * exact arms `GET /orgs/{org}/members` serves): anonymous and signed-in
 * non-members see public members only (no role lines — the template keys the
 * block on `$.PublicOnly`); members, org owners and site admins see every
 * membership. The owner prompt row keys on OrgAssignment's `IsOwner` (site
 * admin or the org's `role='owner'` membership — services/context/org.go:
 * 106-120), the same composition the landed teams page gates on
 * (`canManageOrgTeams`).
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The `?q=` keyword: the landed `listOrgMemberRows` read has no keyword
 *   arm, so a keyword rides the page module's twin D1 read (the same
 *   org_members⋈users join, order, and public filter, plus the
 *   `applyKeywordFilter` columns — case-insensitive LIKE over lower_name +
 *   full_name, org.go:184-193). Upstream's email arm (keep_email_private
 *   gated, org.go:195-205) is unported — the page renders no email and the
 *   tier-2 identity has no keep-private flag.
 * - The per-row 2FA line (owner-only view) is unrendered — no two-factor
 *   model exists (members.tmpl:39-49).
 * - The `.item-trailing` actions are unrendered — the visibility toggle and
 *   the leave/remove buttons POST to `/members/action/*` (web.go:989), a
 *   write family outside this wave's inventory (dead controls forbidden,
 *   §2.4.1; the survey header keeps POST actions out of scope).
 * - The avatar link is the placeholder glyph (the org-home avatar-slot rule;
 *   the name link carries the navigation, so the row loses nothing
 *   keyboard-reachable).
 * - Page size is upstream `setting.UI.MembersPagingNum` = 20
 *   (modules/setting/ui.go:91 — the org-teams list's constant).
 */

import { and, asc, eq, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  isDoerOrgMember,
  listOrgMemberRows,
  orgMembersPublicOnly,
  resolveOrgForRequest,
  type OrgProfileDoer,
} from "../../api/services/orgs";
import { orgVisibleToDoer } from "../../api/services/org-repos";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { orgMembers, users } from "../../db/schema";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { orgDisplayName, OrgHeader } from "./org-home";

/** Page chrome text (component-local, the orgTeamsLocale pattern — locale.ts
 *  is shared and not this wave's file; upstream locale keys cited). */
export const orgMembersLocale = {
  manage_prompt: "Members are managed through teams. Add users to a team to invite them to this organization.", // "org.teams.manage_team_member_prompt"
  manage_team_member: "Manage teams and members", // "org.teams.manage_team_member"
  search_placeholder: "Search users…", // "search.user_kind"
  no_results: "No matching results found.", // "search.no_results"
  hidden: "Hidden", // "org.members.private"
  member_role: "Member Role:", // "org.members.member_role"
  owner: "Owner", // "org.members.owner"
  member: "Member", // "org.members.member"
} as const;

/** Upstream `setting.UI.MembersPagingNum` (modules/setting/ui.go:91). */
export const ORG_MEMBERS_PAGE_SIZE = 20;

/** One rendered row: the service read's exact shape (the joined user row +
 *  the membership, whose `isPublic`/`role` drive the two badges). */
export type OrgMembersRow = Awaited<ReturnType<typeof listOrgMemberRows>>["items"][number];

/** The members page render inputs. */
export interface OrgMembersData {
  org: OrgRecord;
  /** The viewer's listing scope (the PublicOnly map — the template's
   *  `$.PublicOnly`): true = public members only, no role lines. */
  publicOnly: boolean;
  /** The `?q=` keyword under re-render ("" when absent). */
  keyword: string;
  page: number;
  more: boolean;
  rows: OrgMembersRow[];
}

/**
 * The page viewer's OrgAssignment `IsOwner` (site admin or the org's
 * `role='owner'` membership — services/context/org.go:106-120), the prompt
 * row's gate and the same composition `canManageOrgTeams` serves for the
 * teams family.
 */
export async function isOrgOwnerViewer(d1: D1Database, org: OrgRecord, viewer: Viewer): Promise<boolean> {
  if (viewer.kind !== "user") return false;
  if (viewer.isAdmin) return true;
  return new OrgService(d1).isOrgOwner(org.id, viewer.id);
}

/**
 * Load the members page (§3.2 — the landed services, never a self-fetch):
 * `listOrgMemberRows` (the GET /orgs/{org}/members read's exact arm —
 * GetOrgUsersByOrgID's public filter, order and pagination) when no keyword
 * narrows the page; with a keyword, the twin D1 read adding
 * `applyKeywordFilter`'s case-insensitive LIKE over lower_name + full_name
 * (org.go:184-193; the email arm unported — the module header).
 */
export async function loadOrgMembersData(
  d1: D1Database,
  org: OrgRecord,
  doer: OrgProfileDoer,
  params: URLSearchParams,
): Promise<OrgMembersData> {
  const page = parsePageNumber(params.get("page"));
  const keyword = (params.get("q") ?? "").trim().slice(0, 255);
  const orgs = new OrgService(d1);
  const publicOnly = orgMembersPublicOnly(doer, await isDoerOrgMember(orgs, org, doer));

  let items: OrgMembersRow[];
  let total: number;
  if (keyword === "") {
    const listing = await listOrgMemberRows(d1, org.id, publicOnly, { page, pageSize: ORG_MEMBERS_PAGE_SIZE });
    items = listing.items;
    total = listing.total;
  } else {
    // The keyword arm: the same join/filter/order the service read runs,
    // plus the template keyword's substring pair. NOT LIKE: D1 caps LIKE
    // patterns at 50 bytes, so a 49+-char needle threw D1_ERROR and the
    // page answered a plain 500 (found by the matrix-5 probe); the
    // substring goes through instr() instead — the documented user-search
    // precedent (services/user.ts:81-97, the same reasoning). The needle
    // pre-lowers for the case-insensitive pair.
    const lowered = keyword.toLowerCase();
    const keywordCond = or(
      sql`instr(${users.usernameLower}, ${lowered}) > 0`,
      sql`instr(lower(${users.fullName}), ${lowered}) > 0`,
    );
    const where = publicOnly
      ? and(eq(orgMembers.orgId, org.id), eq(orgMembers.isPublic, true), keywordCond)
      : and(eq(orgMembers.orgId, org.id), keywordCond);
    const db = drizzle(d1);
    const rows = await db
      .select({ membership: orgMembers, user: users })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(where)
      .orderBy(asc(orgMembers.userId))
      .limit(ORG_MEMBERS_PAGE_SIZE)
      .offset((page - 1) * ORG_MEMBERS_PAGE_SIZE)
      .all();
    const totalRow = await db
      .select({ total: sql<number>`count(*)` })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(where)
      .get();
    items = rows.map((row) => ({ membership: row.membership, user: row.user }));
    total = totalRow?.total ?? 0;
  }

  return {
    org,
    publicOnly,
    keyword,
    page,
    more: page * ORG_MEMBERS_PAGE_SIZE < total,
    rows: items,
  };
}

// ---------------------------------------------------------------------------
// Resolution + components (members.tmpl's DOM, the reductions in the header)
// ---------------------------------------------------------------------------

/** The resolution outcome for `/org/{org}/members`: the resolved org, a
 *  rename redirect, or a miss (→ 404 shell). */
export type OrgMembersResolution =
  | { kind: "org"; org: OrgRecord }
  | { kind: "redirect"; location: string }
  | { kind: "missing" };

/**
 * Resolve the org for the page viewer: `resolveOrgForRequest` (the
 * orgAssignment + RedirectToUser seam — non-org rows are misses, renamed
 * orgs 307) then `orgVisibleToDoer` (HasOrgOrUserVisible — an invisible org
 * is indistinguishable from a missing one, the resolveOrgHome composition).
 * The members page adds no ladder of its own: the listing's PublicOnly scope
 * is the per-row gate, not the page's.
 */
export async function resolveOrgMembersOrg(
  d1: D1Database,
  orgName: string,
  doer: OrgProfileDoer,
  requestPath: string,
  requestQuery: string,
): Promise<OrgMembersResolution> {
  const resolved = await resolveOrgForRequest(d1, orgName, doer, requestPath, requestQuery);
  if (resolved.kind !== "org") {
    return resolved.kind === "redirect" ? resolved : { kind: "missing" };
  }
  if (!(await orgVisibleToDoer(new OrgService(d1), resolved.org, doer))) {
    return { kind: "missing" };
  }
  return { kind: "org", org: resolved.org };
}

/**
 * One members.tmpl `.item` row (reductions in the module header): the
 * placeholder avatar glyph (not a link — the name link navigates), the name
 * link, the "Hidden" badge on non-public memberships, and — only when the
 * listing is not public-only — the member-role line with the owner's
 * shield-lock glyph inside the strong.
 */
export function OrgMembersRowView(props: { row: OrgMembersRow; publicOnly: boolean }) {
  const { row, publicOnly } = props;
  const username = row.user.username;
  const isOwner = row.membership.role === "owner";
  return (
    <div class="item">
      <div class="item-leading">
        <Icon name="octicon-person" size={48} />
      </div>
      <div class="item-main">
        <div class="item-title">
          <a href={`/${username}`}>{username}</a>
          {!row.membership.isPublic ? <span class="ui basic small label">{orgMembersLocale.hidden}</span> : null}
        </div>
        {!publicOnly ? (
          <div class="tw-flex tw-flex-col tw-gap-1">
            <div>
              {orgMembersLocale.member_role}{" "}
              <strong class="flex-text-inline">
                {isOwner ? (
                  <>
                    <Icon name="octicon-shield-lock" /> {orgMembersLocale.owner}
                  </>
                ) : (
                  orgMembersLocale.member
                )}
              </strong>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component;
 *  the `ownerPrompt` gate rides the options like the branches page's
 *  `canAdmin`, evaluated once per request in the handler). */
export function renderOrgMembersPage(ctx: UiContext, data: OrgMembersData, options: { ownerPrompt: boolean }): string {
  return renderPage(<OrgMembersPage ctx={ctx} data={data} ownerPrompt={options.ownerPrompt} />);
}

/** The members page (§2.4.1 discriminator: members.tmpl:3's literal
 *  `organization members`). */
export function OrgMembersPage(props: { ctx: UiContext; data: OrgMembersData; ownerPrompt: boolean }) {
  const { ctx, data } = props;
  const orgLink = `/${data.org.username}`;
  const basePath = `/org/${data.org.username}/members`;
  // The pager preserves the `?q=` keyword (the org-teams pattern; upstream's
  // base/paginate keeps the query).
  const pageHref = (target: number): string => {
    const keywordParam = data.keyword === "" ? "" : `q=${encodeURIComponent(data.keyword)}&`;
    return `${basePath}?${keywordParam}page=${target}`;
  };
  return (
    <BaseLayout ctx={ctx} title={orgDisplayName(data.org)} pageClass="organization members">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container">
        {props.ownerPrompt ? (
          <div class="flex-text-block">
            <div class="tw-flex-1">{orgMembersLocale.manage_prompt}</div>
            <a class="ui primary button" href={`${orgLink}/teams`}>
              {orgMembersLocale.manage_team_member}
            </a>
          </div>
        ) : null}
        <form class="ui form ignore-dirty tw-my-4" method="get" action={basePath}>
          <div class="ui small fluid action input">
            <input
              type="search"
              name="q"
              value={data.keyword}
              placeholder={orgMembersLocale.search_placeholder}
              maxlength={255}
              spellcheck={false}
            />
            <button class="ui button" type="submit" aria-label={orgMembersLocale.search_placeholder}>
              {orgMembersLocale.search_placeholder}
            </button>
          </div>
        </form>
        <div class="flex-divided-list items-with-main">
          {data.rows.length === 0 ? (
            <div class="item">
              <div class="item-main">{orgMembersLocale.no_results}</div>
            </div>
          ) : (
            data.rows.map((row) => <OrgMembersRowView row={row} publicOnly={data.publicOnly} />)
          )}
        </div>
        {data.page > 1 || data.more ? (
          <div class="center page buttons">
            <div class="ui borderless pagination menu">
              {data.page > 1 ? (
                <a class="item navigation" href={pageHref(data.page - 1)}>
                  <span class="navigation_label">Newer</span>
                </a>
              ) : null}
              {data.more ? (
                <a class="item navigation" href={pageHref(data.page + 1)}>
                  <span class="navigation_label">Older</span>
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </BaseLayout>
  );
}

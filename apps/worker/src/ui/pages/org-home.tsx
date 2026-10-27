/**
 * The org home page, `/{org}` — pages wave 6 (SPEC-0008 U3 extension): the
 * public org profile — header, the reduced org menu, and the org's visible
 * repository list. The FIRST single-segment (non-repo-scoped) UI family, and
 * the first org-scoped page. Since wave 7 the `/{name}` shape serves the
 * OWNER home (upstream `OwnerProfile` dispatch): org rows land here, user
 * rows on pages/user-profile.tsx — one parse family (`owner-home`), this
 * module stays the org half.
 *
 * ## DOM contract (templates/org/home.tmpl + org/header.tmpl + org/menu.tmpl +
 *  shared/repo/list.tmpl + repo/icon.tmpl at the pin)
 *
 * `.page-content.organization profile`, then org/header.tmpl:
 * `.ui.container.flex-container` with the avatar slot + the
 * `.flex-relaxed-list.tw-flex-1` identity block (`.ui.header.flex-left-right
 * .tw-m-0` > `.flex-text-block` > `span.tw-text-2xl` display name + the
 * limited/private `ui large basic horizontal label` badges, the
 * `.render-content.markup` description, and the location/website/email
 * `.flex-text-block` rows), then org/menu.tmpl's
 * `overflow-menu.ui.secondary.pointing.tabular.borderless.menu` tab strip,
 * then home.tmpl's repository block: the shared/repo/list.tmpl
 * `div.flex-divided-list.items-with-main` (one `.item` per repo —
 * `.item-leading` repo glyph, `.item-main` > `.item-header` (.item-title
 * name link + `.label-list` archived/private/internal badges,
 * `.item-trailing.muted-links` counters) + `.item-body` description and
 * "Updated {TimeSince}") or home.tmpl's `.empty-placeholder` (48px repo
 * glyph + h2 + p), and the pager.
 *
 * ## Visibility (the landed org predicates — never a local re-derivation)
 *
 * `resolveOrgForRequest` (src/api/services/orgs.ts — upstream orgAssignment +
 * RedirectToUser) resolves the org: a plain USER name is a miss (the §4.11
 * type gate), and a renamed org 307s onto the new name (path first-occurrence
 * rewrite, query preserved) behind the coarse doer gate. Then
 * `orgVisibleToDoer` (src/api/services/org-repos.ts — upstream
 * `HasOrgOrUserVisible`): anonymous sees public orgs only, limited needs any
 * authenticated viewer, private needs the membership — anything invisible
 * 404-shells, indistinguishable from missing (existence never leaks, the
 * repo pages' §2.5 posture). The repo list is the landed
 * `listOrgRepositories` (GET /orgs/{org}/repos service half): owners and
 * site admins see private rows, everyone else public rows only (upstream
 * parity — the service doc's §4.7 note; a plain member's teams grant repo
 * access through the team layer, not the listing).
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The avatar slot renders a placeholder circle with the organization
   octicon (no avatar pipeline — an `<img>` to a missing route is a dead
 *   link, the new-issue page's avatar-slot rule).
 * - The org menu reduces to the single live tab (Repositories — this page):
 *   Overview needs a profile-readme pipeline, Members/Teams/Settings need
 *   their pages (dead links forbidden, §2.4.1 — the shell tab-strip rule).
 * - The members/teams sidebar column and the new-repo/migrate buttons are
 *   not rendered (no members/teams pages, no repo-create page).
 * - The profile README and the shared/repo/search box are not rendered (no
 *   readme pipeline, no search route).
 * - Row counters: stars/forks have no D1 counters (§3.1) and the primary
 *   language needs a per-repo stats read — the `.item-trailing` block renders
 *   the open-pulls count only (the maintained num_pulls counters, the shell's
 *   open-count subtraction), linked to the live /pulls page.
 * - The description renders as plain text (upstream renders markup through
 *   the README pipeline; the org description is profile metadata here).
 * - Repo list order is the landed service's `slug ASC`
 *   (listOrgRepos) — upstream org home sorts by the explore default
 *   (recentupdate); the landed service order wins (§3.2).
 * - Page size is upstream `setting.UI.User.RepoPagingNum` = 15
 *   (modules/setting/ui.go:147).
 */

import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { listOrgRepositories, orgVisibleToDoer, type OrgDoer } from "../../api/services/org-repos";
import { resolveOrgForRequest, type ResolvedOrg } from "../../api/services/orgs";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { repoSettings, type repositories } from "../../db/schema";
import { AdminEmbeddedSvg } from "./admin-users";
import { TimeSince } from "../components/file-list";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/** Page chrome text (component-local, the issuesLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const orgHomeLocale = {
  repositories: "Repositories", // "user.repositories"
  projects: "Projects", // "user.projects" (the wave-37 projectsTab item)
  repos_empty: "No repositories yet.", // "org.repos.empty"
  repos_empty_description: "Create a repository to share code with the organization.", // "org.repos.empty_description"
  repo_updated: "Updated", // "org.repo_updated"
  repo_archived: "Archived", // "repo.desc.archived"
  repo_private: "Private", // "repo.desc.private"
  repo_internal: "Internal", // "repo.desc.internal"
  repo_pulls_aria: "Pull Requests", // "repo.pulls"
  visibility_limited: "Limited", // "org.settings.visibility.limited_shortname"
  visibility_private: "Private", // "org.settings.visibility.private_shortname"
} as const;

/** Upstream `setting.UI.User.RepoPagingNum` (modules/setting/ui.go:147). */
export const ORG_HOME_PAGE_SIZE = 15;

/** One rendered row: the full repository row (the pulls counter lives on it)
 *  plus the repo_settings description. */
export interface OrgHomeRepoItem {
  repo: typeof repositories.$inferSelect;
  description: string;
}

/** The org home render inputs. */
export interface OrgHomeData {
  org: OrgRecord;
  repos: OrgHomeRepoItem[];
  total: number;
  page: number;
  more: boolean;
}

/** Upstream `DisplayName()` (models/user: fullName or the username). */
export function orgDisplayName(org: OrgRecord): string {
  return org.fullName !== null && org.fullName !== "" ? org.fullName : org.username;
}

/**
 * Load the page (§3.2 — the landed services, never a self-fetch): the
 * visible-row listing (the §4.7 owner predicate lives in the service), then
 * one batched description read for the page's rows (the wave-2 batching
 * pattern — loadRepoSettings is per-repo; the list needs the column only).
 */
export async function loadOrgHomeData(
  d1: D1Database,
  org: OrgRecord,
  doer: OrgDoer,
  params: URLSearchParams,
): Promise<OrgHomeData> {
  const page = parsePageNumber(params.get("page"));
  const listing = await listOrgRepositories(d1, org, doer, { page, pageSize: ORG_HOME_PAGE_SIZE });

  const descriptions = new Map<string, string>();
  if (listing.items.length > 0) {
    const rows = await drizzle(d1)
      .select({ repoId: repoSettings.repoId, description: repoSettings.description })
      .from(repoSettings)
      .where(inArray(repoSettings.repoId, listing.items.map((item) => item.repo.id)))
      .all();
    for (const row of rows) descriptions.set(row.repoId, row.description);
  }

  return {
    org,
    repos: listing.items.map((item) => ({ repo: item.repo, description: descriptions.get(item.repo.id) ?? "" })),
    total: listing.total,
    page,
    more: page * ORG_HOME_PAGE_SIZE < listing.total,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The visibility badge pair (org/header.tmpl — limited/private only; a
 *  public org renders no badge, exactly upstream). */
function OrgVisibilityBadge(props: { org: OrgRecord }) {
  if (props.org.visibility === "limited") {
    return <span class="ui large basic horizontal label">{orgHomeLocale.visibility_limited}</span>;
  }
  if (props.org.visibility === "private") {
    return <span class="ui large basic horizontal label">{orgHomeLocale.visibility_private}</span>;
  }
  return null;
}

/** org/header.tmpl: avatar slot (placeholder circle — no avatar pipeline),
 *  display name + visibility badge, description, the location/website/email
 *  rows (email is the upstream `{{if and .IsSigned .Org.Email}}` gate). */
export function OrgHeader(props: { org: OrgRecord; signedIn: boolean }) {
  const { org } = props;
  return (
    <div class="ui container flex-container">
      <div>
        <span class="ui avatar" aria-hidden="true">
          <Icon name="octicon-organization" size={100} />
        </span>
      </div>
      <div class="flex-relaxed-list tw-flex-1">
        <div class="ui header flex-left-right tw-m-0">
          <div class="flex-text-block">
            <span class="tw-text-2xl">{orgDisplayName(org)}</span>
            <OrgVisibilityBadge org={org} />
          </div>
        </div>
        {org.description !== null && org.description !== "" ? (
          <div class="render-content markup">{org.description}</div>
        ) : null}
        <div>
          {org.location !== null && org.location !== "" ? (
            <div class="flex-text-block">
              <Icon name="octicon-location" /> <span>{org.location}</span>
            </div>
          ) : null}
          {org.website !== null && org.website !== "" ? (
            <div class="flex-text-block">
              <Icon name="octicon-link" />{" "}
              <a class="muted" target="_blank" rel="me" href={org.website}>
                {org.website}
              </a>
            </div>
          ) : null}
          {props.signedIn && org.email !== null && org.email !== "" ? (
            <div class="flex-text-block">
              <Icon name="octicon-mail" /> <a class="muted" href={`mailto:${org.email}`}>{org.email}</a>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * org/menu.tmpl reduced to the live tabs (the shell tab-strip rule): only
 * this page exists, so the strip carries the single active Repositories tab
 * with the repo count (`{{if .RepoCount}}`). Wave 37 (the `/-/projects`
 * family, pages/owner-projects.tsx) adds the OPTIONAL projectsTab item —
 * the menu's upstream Projects tab (menu.tmpl's `{{if .CanReadProjects}}`
 * item, active on `PageIsViewProjects`), rendered only when the consumer
 * passes it; absent keeps the byte-stable single-tab DOM this page and the
 * user profile render.
 */
export function OrgMenu(props: {
  orgLink: string;
  repoCount: number;
  /** The upstream Projects tab (present only on a consumer that owns a
   *  live `/-/projects` page; count = the open-projects total, the
   *  `{{if .ProjectCount}}` label). */
  projectsTab?: { active: boolean; count: number; href: string };
}) {
  return (
    <div class="ui container">
      <overflow-menu class="ui secondary pointing tabular borderless menu tw-mb-4">
        <div class="overflow-menu-items">
          <a class={props.projectsTab?.active ? "item" : "active item"} href={props.orgLink}>
            <Icon name="octicon-repo" /> {orgHomeLocale.repositories}
            {props.repoCount > 0 ? <div class="ui small label">{props.repoCount}</div> : null}
          </a>
          {props.projectsTab ? (
            <a class={props.projectsTab.active ? "active item" : "item"} href={props.projectsTab.href}>
              <Icon name="octicon-project-symlink" /> {orgHomeLocale.projects}
              {props.projectsTab.count > 0 ? <div class="ui small label">{props.projectsTab.count}</div> : null}
            </a>
          ) : null}
        </div>
      </overflow-menu>
    </div>
  );
}

/**
 * One shared/repo/list.tmpl `.item` row (reductions in the module header):
 * the repo/icon.tmpl row glyph, the name link, the archived/private/internal
 * badges (internal = public repo under a private owner, upstream
 * `{{if .Owner.Visibility.IsPrivate}}`), the description, the
 * "Updated {TimeSince}" line, and the open-pulls counter chip.
 *
 * The row glyph is icon.tmpl's chain at the pin (avatar → mirror → fork →
 * plain; the avatar arm needs a pipeline we lack — the documented §6
 * degradation — so every row takes the glyph arms): `octicon-mirror` when
 * `is_mirror`, else `octicon-repo-forked` when `fork_parent` is set
 * ($.IsFork), else `octicon-repo` — mirror beats fork exactly upstream,
 * since the arms are `{{else if}}` chained. The mirror/forked bytes ride
 * admin-users.tsx's embedded seam (the user-settings-repos RepoKindIcon
 * precedent) — not on the shared Icon allowlist — at the same 24px slot and
 * the same `svg octicon-*` DOM as the plain arm. This component is the
 * SHARED shared/repo/list.tmpl row: the fix covers every consumer
 * (user-profile's repositories tab, explore, dashboard,
 * notification-subscriptions) — their rows can be mirrors/forks too. The
 * user-stars/user-watching tabs render their own reduced rows (their own
 * glyph sites); user-settings-repos rides repos.tmpl's DIFFERENT chain
 * (lock first, fork before mirror) in its own RepoKindIcon — not shared
 * with this one.
 */
export function OrgRepoListItem(props: { orgLink: string; item: OrgHomeRepoItem; orgPrivate: boolean }) {
  const { repo } = props.item;
  const repoLink = `${props.orgLink}/${repo.slug}`;
  const openPulls = Math.max(repo.numPulls - repo.numClosedPulls, 0);
  return (
    <div class="item">
      <div class="item-leading">
        {repo.isMirror ? (
          <AdminEmbeddedSvg name="octicon-mirror" size={24} />
        ) : repo.forkParent !== null ? (
          <AdminEmbeddedSvg name="octicon-repo-forked" size={24} />
        ) : (
          <Icon name="octicon-repo" size={24} />
        )}
      </div>
      <div class="item-main">
        <div class="item-header">
          <div class="item-title">
            <a class="tw-text-primary name" href={repoLink}>
              {repo.slug}
            </a>
            <span class="label-list">
              {repo.isArchived ? <span class="ui basic label">{orgHomeLocale.repo_archived}</span> : null}
              {repo.visibility === "private" ? (
                <span class="ui basic label">{orgHomeLocale.repo_private}</span>
              ) : props.orgPrivate ? (
                <span class="ui basic label">{orgHomeLocale.repo_internal}</span>
              ) : null}
            </span>
          </div>
          <div class="item-trailing muted-links">
            <a class="flex-text-inline" href={`${repoLink}/pulls`}>
              <span class="tw-contents" aria-label={orgHomeLocale.repo_pulls_aria}>
                <Icon name="octicon-git-pull-request" size={16} />
              </span>
              <span>{openPulls}</span>
            </a>
          </div>
        </div>
        {props.item.description !== "" ? <div class="item-body">{props.item.description}</div> : null}
        {repo.updatedAt !== null ? (
          <div class="item-body">
            {orgHomeLocale.repo_updated}{" "}
            <TimeSince unixSeconds={Math.floor(repo.updatedAt.getTime() / 1000)} tz="+0000" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The Older/Newer pagination — the issues list's DOM shape
 *  (div.center.page.buttons), driven by `page * size < total`. Exported for
 *  the user profile (wave 7) — the same shared/repo/list pager serves both
 *  owner homes. */
export function OrgHomePagination(props: { orgLink: string; page: number; more: boolean }) {
  if (props.page <= 1 && !props.more) return null;
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a
            class="item navigation"
            href={props.page > 2 ? `${props.orgLink}?page=${props.page - 1}` : props.orgLink}
          >
            <span class="navigation_label">Newer</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={`${props.orgLink}?page=${props.page + 1}`}>
            <span class="navigation_label">Older</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderOrgHomePage(ctx: UiContext, data: OrgHomeData): string {
  return renderPage(<OrgHomePage ctx={ctx} data={data} />);
}

/** The org home page (§2.4.1 discriminator: `organization profile`). */
export function OrgHomePage(props: { ctx: UiContext; data: OrgHomeData }) {
  const { ctx, data } = props;
  const orgLink = `/${data.org.username}`;
  return (
    <BaseLayout ctx={ctx} title={orgDisplayName(data.org)} pageClass="organization profile">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <OrgMenu orgLink={orgLink} repoCount={data.total} />
      <div class="ui container">
        {data.repos.length === 0 ? (
          <div class="empty-placeholder">
            <Icon name="octicon-repo" size={48} />
            <h2>{orgHomeLocale.repos_empty}</h2>
            <p>{orgHomeLocale.repos_empty_description}</p>
          </div>
        ) : (
          <>
            <div class="flex-divided-list items-with-main">
              {data.repos.map((item) => (
                <OrgRepoListItem orgLink={orgLink} item={item} orgPrivate={data.org.visibility === "private"} />
              ))}
            </div>
            <OrgHomePagination orgLink={orgLink} page={data.page} more={data.more} />
          </>
        )}
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// Resolution — the handler-side seam (index.ts calls these; kept here so the
// page module owns its data path, the issues-list pattern)
// ---------------------------------------------------------------------------

/** The resolution outcome for `/{org}` (the header comment's visibility
 *  ladder): the resolved org, a rename redirect, or a miss (→ 404 shell). */
export type OrgHomeResolution =
  | { kind: "org"; org: OrgRecord }
  | { kind: "redirect"; location: string }
  | { kind: "missing" };

/**
 * Resolve the org for the page viewer: `resolveOrgForRequest` (the
 * orgAssignment + RedirectToUser seam — non-org rows are misses, renamed
 * orgs 307), then `orgVisibleToDoer` (HasOrgOrUserVisible — an invisible org
 * is indistinguishable from a missing one). Since wave 7 the router calls
 * this as the ORG HALF of the owner-home dispatch: a plain USER name is a
 * `missing` here and falls through to the user half (pages/user-profile.tsx)
 * instead of 404-ing.
 */
export async function resolveOrgHome(
  d1: D1Database,
  owner: string,
  doer: OrgDoer,
  requestPath: string,
  requestQuery: string,
): Promise<OrgHomeResolution> {
  const resolved: ResolvedOrg = await resolveOrgForRequest(d1, owner, doer, requestPath, requestQuery);
  if (resolved.kind !== "org") {
    return resolved.kind === "redirect" ? resolved : { kind: "missing" };
  }
  if (!(await orgVisibleToDoer(new OrgService(d1), resolved.org, doer))) {
    return { kind: "missing" };
  }
  return { kind: "org", org: resolved.org };
}

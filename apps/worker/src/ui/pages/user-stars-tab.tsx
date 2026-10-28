/**
 * The profile STARS tab, `/{username}?tab=stars` — pages wave-124: the
 * starred-repositories list behind the overview header's Stars anchor
 * (routers/web/user/profile.go:191-219's `case "stars"`:
 * `SearchRepository{StarredByID: ctx.ContextUser.ID, Collaborate:
 * optional.Some(false), Private: ctx.IsSigned, Actor: ctx.Doer}` — the
 * USER→repos star direction; the repo→users direction is social-lists.ts
 * listRepoStargazers). The twin of pages/activity-feeds.tsx's mounted
 * `?tab=activity` arm — the profile grid, the avatar card, the tab strip,
 * then profile.tmpl's stars branch instead of the feeds.
 *
 * ## DOM contract (templates/user/profile.tmpl's `tab == "stars"` branch +
 *  shared/repo/list.tmpl + base/paginate.tmpl at the pin)
 *
 * `.page-content.user profile`, the two-column grid, the avatar card
 * (shared — ProfileAvatarCard from pages/user-profile.tsx), then the stars
 * branch: `<div class="stars">` wrapping shared/repo/list.tmpl's
 * `div.flex-divided-list.items-with-main` and the pager. The branch's
 * `shared/repo/search` include + its divider are not rendered (no search
 * route — the org-home reduction, the repositories tab's own note); the
 * list renders its `{{range}}…{{else}}` arm verbatim: zero rows =
 * `search.no_results` ("No matching results found.").
 *
 * Rows are the SAME repo-list rows the repositories tab renders — upstream
 * includes the identical shared/repo/list.tmpl — with the stars branch's
 * `ShowRepoOwnerOnList: true` (profile.go:194) difference: a starred repo
 * can belong to anyone, so the title carries the `{{if and
 * $.ShowRepoOwnerOnList .Owner}}` owner segment —
 * `<a href="/{owner}">{owner}</a>/<a href="/{owner}/{repo}">{repo}</a>`
 * (list.tmpl:9-12) — and the internal badge is per-ROW owner visibility
 * (list.tmpl's `{{if .Owner.Visibility.IsPrivate}}`), not the page owner's.
 * The row counters: the star chip (`{{if not $.DisableStars}}` — the
 * setting defaults false, modules/setting/repository.go:155, so it renders;
 * linked to the LIVE /{owner}/{repo}/stars stargazers page, uiRouter
 * `/:owner/:repo/stars`) beside the landed open-pulls chip (the org-home
 * row reduction; forks have no D1 counter — §3.1). The landed
 * OrgRepoListItem (pages/org-home.tsx) cannot render the owner segment and
 * org-home.tsx is not this wave's file, so the row is module-local — same
 * DOM, plus the two stars-branch arms. The leading row glyph is icon.tmpl's
 * chain (mirror → fork → plain — the OrgRepoListItem fix this module
 * inherits; the mirror/forked bytes ride admin-users.tsx's embedded seam).
 *
 * ## Visibility (the landed predicates — never a local re-derivation)
 *
 * The page rides the owner-home dispatch's USER half wholesale (the
 * resolveUserProfile ladder in pages/user-profile.tsx — userAssignment,
 * the user_redirects seam, IsUserVisibleToViewer); this module only loads
 * the tab body. The starred list is the landed
 * `listReposStarredByUser` (src/api/services/stars.ts — profile.go's
 * SearchRepository collapsed to the repositories tab's doer-visible
 * two-arm WHERE): the profile user themself or a site admin sees every
 * starred row, everyone else public rows only — a stranger's private
 * starred rows drop out (star metadata does not leak). The Repositories
 * count in the tab strip is the same doer-visible count the activity tab
 * computes (the loadUserProfileData WHERE over ownerId).
 *
 * ## Mount record (MOUNTED at 2f7afe9 — the wiring HANDOFF is retired)
 *
 * In apps/worker/src/ui/index.ts, ownerHomePage's USER half — AFTER the
 * `profile.kind === "missing"` 404 arm, BESIDE the `tab=activity` arm,
 * BEFORE the default loadUserProfileData fall-through:
 *
 * ```ts
 * import { loadUserStarsTabData, renderUserStarsTabPage } from "./pages/user-stars-tab";
 * // ...
 * if (url.searchParams.get("tab") === "stars") {
 *   const data = await loadUserStarsTabData(c.env.DB, profile.user, doer, url.searchParams);
 *   return respond(c.html(renderUserStarsTabPage(ctx, data), 200));
 * }
 * ```
 *
 * (`doer` is ownerHomePage's existing ProfileDoer — the stars loader takes
 * the doer, not the raw viewer.) The strip anchor for
 * pages/user-profile.tsx's ProfileTabs (owned by the profile-follow-tabs /
 * user-profile owner, folded in the same window) — header.tmpl renders the
 * Stars anchor AFTER Activity, inside the IsIndividual block, gated
 * `{{if not .DisableStars}}` (default false at the pin → always rendered;
 * user/overview/header.tmpl:36-44) — LANDED: ProfileTabs grew
 * `starsCount: number` (fed data.user.numStars, the maintained
 * users.num_stars column — upstream's `{{if .ContextUser.NumStars}}` label
 * gate) and renders the `?tab=stars` anchor with the count label; the
 * `?tab=watching` anchor landed beside it with the watching tab's own
 * mount (user-watching-tab.tsx).
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The `shared/repo/search` box and its divider are not rendered (no
 *   search route — the q/sort/archived/fork filters of upstream's
 *   SearchRepository are therefore not landed either; the loader note).
 * - List order is the landed `slug ASC` — upstream sorts by the explore
 *   default (recentupdate, profile.go:118-124); the landed order wins
 *   (§3.2, the org-home note).
 * - Fork counters have no D1 column (§3.1); the primary-language chip
 *   needs a per-repo stats read — the trailing block renders the star chip
 *   (the maintained num_stars column) + the open-pulls chip only.
 * - The pager is base/paginate.tmpl reduced to the Older/Newer pair (the
 *   org-home convention), carrying `tab=stars` in every href.
 * - Page size is upstream `setting.UI.User.RepoPagingNum` = 15
 *   (modules/setting/ui.go:147) — the SAME setting the repositories tab
 *   cites.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { listFollowers, listFollowing } from "../../api/services/follows";
import { listReposStarredByUser, type StarredByUserItem } from "../../api/services/stars";
import { repoSettings, repositories } from "../../db/schema";
import { TimeSince } from "../components/file-list";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { AdminEmbeddedSvg } from "./admin-users";
import { ProfileAvatarCard, userDisplayName, type ProfileDoer, type UserProfileRow } from "./user-profile";

/** Page chrome text (component-local, the userProfileLocale pattern —
 *  locale.ts is shared and not this wave's file). */
export const userStarsTabLocale = {
  repositories: "Repositories", // "user.repositories" (header.tmpl:13)
  activity: "Public Activity", // "user.activity" (header.tmpl:34)
  starred: "Starred Repositories", // "user.starred" (header.tmpl:38)
  no_results: "No matching results found.", // "search.no_results"
  repo_updated: "Updated", // "org.repo_updated"
  repo_archived: "Archived", // "repo.desc.archived"
  repo_private: "Private", // "repo.desc.private"
  repo_internal: "Internal", // "repo.desc.internal"
  stars_aria: "Stars", // "repo.stars" (list.tmpl's star chip aria label)
  repo_pulls_aria: "Pull Requests", // "repo.pulls"
  newer: "Newer", // "repo.issues.previous" (the pager reduction)
  older: "Older", // "repo.issues.next"
} as const;

/** Upstream `setting.UI.User.RepoPagingNum` (modules/setting/ui.go:147) —
 *  the same paging setting the repositories tab renders with. */
export const USER_STARS_TAB_PAGE_SIZE = 15;

/** One rendered starred-repo row: the repository row plus the per-row owner
 *  visibility (the internal-badge arm) and the repo_settings description. */
export interface StarsRepoItem extends StarredByUserItem {
  description: string;
}

/** The stars tab render inputs. */
export interface UserStarsTabData {
  user: UserProfileRow;
  repos: StarsRepoItem[];
  /** The visible starred total (the loader's filtered count — the pager's
   *  bound; upstream's SearchRepository count is the filtered query's). */
  total: number;
  /** The doer-visible repositories count (the Repositories tab label — the
   *  activity loader's arm). */
  repoCount: number;
  followers: number;
  following: number;
  page: number;
  more: boolean;
}

/**
 * Load the stars tab (profile.go:191-219's arm — §3.2, direct service
 * reads, never a self-fetch): the visible starred listing, one batched
 * description read for the page's rows (the org-home loader's pattern),
 * the doer-visible Repositories count, and the follower/following totals
 * (the avatar card, the profile loader's count-only reads).
 */
export async function loadUserStarsTabData(
  d1: D1Database,
  user: UserProfileRow,
  doer: ProfileDoer,
  params: URLSearchParams,
): Promise<UserStarsTabData> {
  const page = parsePageNumber(params.get("page"));
  const seePrivate = doer.id !== null && (doer.isAdmin || doer.id === user.id);
  const listing = await listReposStarredByUser(d1, user.id, {
    page,
    pageSize: USER_STARS_TAB_PAGE_SIZE,
    seePrivate,
  });

  const descriptions = new Map<string, string>();
  if (listing.items.length > 0) {
    const settings = await drizzle(d1)
      .select({ repoId: repoSettings.repoId, description: repoSettings.description })
      .from(repoSettings)
      .where(inArray(repoSettings.repoId, listing.items.map((item) => item.repo.id)))
      .all();
    for (const row of settings) descriptions.set(row.repoId, row.description);
  }

  // The Repositories tab label's count — the profile loader's doer-visible
  // WHERE (the activity loader's identical arm).
  const repoWhere = seePrivate
    ? eq(repositories.ownerId, user.id)
    : and(eq(repositories.ownerId, user.id), eq(repositories.visibility, "public"));
  const repoCountRow = await drizzle(d1)
    .select({ total: sql<number>`count(*)` })
    .from(repositories)
    .where(repoWhere)
    .get();

  const [followers, following] = await Promise.all([
    listFollowers(d1, user.id, doer, { page: 1, pageSize: 1 }),
    listFollowing(d1, user.id, doer, { page: 1, pageSize: 1 }),
  ]);

  return {
    user,
    repos: listing.items.map((item) => ({
      ...item,
      description: descriptions.get(item.repo.id) ?? "",
    })),
    total: listing.total,
    repoCount: Number(repoCountRow?.total ?? 0),
    followers: followers.total,
    following: following.total,
    page,
    more: page * USER_STARS_TAB_PAGE_SIZE < listing.total,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * The overview header (user/overview/header.tmpl reduced to its LIVE tabs
 * — the activity module's OverviewTabs twin with the Stars anchor added:
 * this page's arm): Repositories and Activity inactive, Stars ACTIVE
 * (header.tmpl:38-44, after Activity inside the IsIndividual block). The
 * Stars count label is the maintained `users.num_stars` (upstream
 * `{{if .ContextUser.NumStars}}` — real data); the Repositories count the
 * doer-visible query. DisableStars defaults false at the pin
 * (modules/setting/repository.go:155) so the `{{if not .DisableStars}}`
 * gate degrades to always-true (the watching `{{else}}` arm is not
 * rendered — the module header's board note). Module-local: org-home.tsx
 * is not this wave's file and OrgMenu carries no activity/stars slot.
 */
function StarsTabs(props: { username: string; repoCount: number; starsCount: number }) {
  return (
    <overflow-menu class="ui secondary pointing tabular borderless menu">
      <div class="overflow-menu-items">
        <a class="item" href={`/${props.username}?tab=repositories`}>
          <Icon name="octicon-repo" /> {userStarsTabLocale.repositories}
          {props.repoCount > 0 ? <div class="ui small label">{props.repoCount}</div> : null}
        </a>
        <a class="item" href={`/${props.username}?tab=activity`}>
          <Icon name="octicon-rss" /> {userStarsTabLocale.activity}
        </a>
        <a class="active item" href={`/${props.username}?tab=stars`}>
          <Icon name="octicon-star" /> {userStarsTabLocale.starred}
          {props.starsCount > 0 ? <div class="ui small label">{props.starsCount}</div> : null}
        </a>
      </div>
    </overflow-menu>
  );
}

/**
 * One shared/repo/list.tmpl `.item` row — the repositories tab's row DOM
 * (the OrgRepoListItem reduction) plus the stars branch's two arms:
 * `ShowRepoOwnerOnList`'s owner segment in the title (list.tmpl:9-12) and
 * the per-row star chip (`{{if not $.DisableStars}}`, list.tmpl:44-51 —
 * linked to the live /{owner}/{repo}/stars page). The internal badge reads
 * THIS row's owner visibility (list.tmpl's `{{if .Owner.Visibility.IsPrivate}}`).
 *
 * The leading glyph is repo/icon.tmpl's chain — the OrgRepoListItem
 * reduction's mirror → fork → plain branch (FLIPPED 2026-10-27; the
 * unconditional fallback glyph was the same divergence org-home's row
 * carried): `octicon-mirror` when `is_mirror`, else `octicon-repo-forked`
 * when `fork_parent` is set ($.IsFork), else `octicon-repo` — mirror beats
 * fork exactly upstream, since the arms are `{{else if}}` chained. The
 * starred row's full repositories row already carries both columns (the
 * loader batched it), so the chain reads the row data directly; the
 * mirror/forked bytes ride admin-users.tsx's embedded seam (not on the
 * shared Icon allowlist) at the same 24px slot and the same
 * `svg octicon-*` DOM as the plain arm.
 */
export function StarsRepoListItem(props: { item: StarsRepoItem }) {
  const { repo } = props.item;
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
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
            <a class="tw-text-primary name" href={`/${repo.ownerNamespace}`}>{repo.ownerNamespace}</a>
            /<a class="tw-text-primary name" href={repoLink}>{repo.slug}</a>
            <span class="label-list">
              {repo.isArchived ? <span class="ui basic label">{userStarsTabLocale.repo_archived}</span> : null}
              {repo.visibility === "private" ? (
                <span class="ui basic label">{userStarsTabLocale.repo_private}</span>
              ) : props.item.ownerVisibility === "private" ? (
                <span class="ui basic label">{userStarsTabLocale.repo_internal}</span>
              ) : null}
            </span>
          </div>
          <div class="item-trailing muted-links">
            <a class="flex-text-inline" href={`${repoLink}/stars`}>
              <span class="tw-contents" aria-label={userStarsTabLocale.stars_aria}>
                <Icon name="octicon-star" size={16} />
              </span>
              <span>{repo.numStars}</span>
            </a>
            <a class="flex-text-inline" href={`${repoLink}/pulls`}>
              <span class="tw-contents" aria-label={userStarsTabLocale.repo_pulls_aria}>
                <Icon name="octicon-git-pull-request" size={16} />
              </span>
              <span>{openPulls}</span>
            </a>
          </div>
        </div>
        {props.item.description !== "" ? <div class="item-body">{props.item.description}</div> : null}
        {repo.updatedAt !== null ? (
          <div class="item-body">
            {userStarsTabLocale.repo_updated}{" "}
            <TimeSince unixSeconds={Math.floor(repo.updatedAt.getTime() / 1000)} tz="+0000" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The pager — base/paginate.tmpl reduced to the Older/Newer pair (the
 *  org-home convention), every href carrying `tab=stars`. */
function StarsTabPager(props: { username: string; page: number; more: boolean }) {
  const href = (page: number): string => {
    const params = new URLSearchParams();
    params.set("tab", "stars");
    if (page > 1) params.set("page", String(page));
    const query = params.toString();
    return `/${props.username}${query === "" ? "" : `?${query}`}`;
  };
  if (props.page <= 1 && !props.more) return null;
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a class="item navigation" href={href(props.page - 1)}>
            <span class="navigation_label">{userStarsTabLocale.newer}</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={href(props.page + 1)}>
            <span class="navigation_label">{userStarsTabLocale.older}</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderUserStarsTabPage(ctx: UiContext, data: UserStarsTabData): string {
  return renderPage(<UserStarsTabPage ctx={ctx} data={data} />);
}

/** The profile stars tab (profile.tmpl's grid + the `tab == "stars"`
 *  branch: §2.4.1 discriminator `user profile`). */
export function UserStarsTabPage(props: { ctx: UiContext; data: UserStarsTabData }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title={userDisplayName(data.user)} pageClass="user profile">
      <div class="ui container">
        <div class="ui stackable grid">
          <div class="ui four wide column">
            <ProfileAvatarCard user={data.user} followers={data.followers} following={data.following} />
          </div>
          <div class="ui twelve wide column tw-mb-4">
            <StarsTabs
              username={data.user.username}
              repoCount={data.repoCount}
              starsCount={data.user.numStars}
            />
            {/* profile.tmpl's stars branch: <div class="stars"> — the search
                box + divider are the documented reduction, the list + pager
                render; the list's range-else arm on zero rows. */}
            <div class="stars">
              <div class="flex-divided-list items-with-main">
                {data.repos.length === 0 ? (
                  <div>{userStarsTabLocale.no_results}</div>
                ) : (
                  data.repos.map((item) => <StarsRepoListItem item={item} />)
                )}
              </div>
              <StarsTabPager username={data.user.username} page={data.page} more={data.more} />
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

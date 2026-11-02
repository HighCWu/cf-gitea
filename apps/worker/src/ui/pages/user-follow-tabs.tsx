/**
 * The user profile FOLLOWERS/FOLLOWING tabs, `/{username}?tab=followers` and
 * `?tab=following` — one module, the two card-list projections of the
 * profile family (MOUNTED at 2f7afe9 beside the `?tab=activity`
 * arm: `ownerHomePage`'s user half calls this module's load + render under
 * either tab param — the mount record at the tail of this header).
 *
 * ## Upstream shape (cited at the pin)
 *
 * `routers/web/user/profile.go:121-161`: `prepareUserProfileTabData` runs
 * BOTH follow listings BEFORE the tab switch — `GetUserFollowers` (:121-129,
 * into `NumFollowers`) and `GetUserFollowing` (:130-138, into
 * `NumFollowing`) — each at the SAME `page` and `pagingNum =
 * setting.UI.User.RepoPagingNum` (= 15, modules/setting/ui.go:147; the
 * profile loader's `USER_PROFILE_PAGE_SIZE`). The switch arms then pick:
 * `case "followers"` (:156-158) sets `Cards = followers`,
 * `total = numFollowers`; `case "following"` (:159-161) the following pair.
 * The pager (:315) is the generic `NewPagerBuilder().TotalCount(total)
 * .PerPageLimit(pagingNum).CurPage(page)`; `AddParamFromRequest`
 * (services/context/pagination.go:96-102) keeps every query param except
 * `page` — so the pager links carry `tab=followers`/`tab=following`
 * alongside `page=N` (base/paginate.tmpl's `{{$paginationParams}}`).
 *
 * `templates/user/profile.tmpl:25-29`: both tabs render the same
 * `repo/user_cards` template (so do the "organizations" and — with a repo
 * list instead — no other arms; the repositories/activity branches have
 * their own DOM). profile.go sets NO `CardsTitle`, so user_cards.tmpl:3-7's
 * `<h2>` arm never renders on these tabs.
 *
 * `templates/repo/user_cards.tmpl` — the card DOM (the pin's exact rows):
 * the `.user-cards#user-cards-container[data-fetch-trigger=fetch-reload]`
 * container (:2), a `<ul class="list">` (:8) with one
 * `<li class="item ui segment">` per card (:10): the 48px avatar inside a
 * `{{.HomeLink}}` anchor (:11-13), `<h3 class="name flex-text-block">` with
 * the `{{.DisplayName}}` link + the `shared/user/user_type_label` bot label
 * (:14), then the `.meta.flex-text-block` line (:16-24) — website
 * (`octicon-link` + `target="_blank"` anchor) ELSE location
 * (`octicon-location` + text) ELSE "Joined on {date}" (`octicon-calendar`)
 * — and `base/paginate` at :29. `HomeLink` is `/{username}` (the org home
 * route answers org rows: the FOLLOWING list legitimately contains
 * organizations — the follows service's `userTypes: ["user", "org"]`).
 * There is NO follow/unfollow control on these cards — the only upstream
 * follow button lives on the avatar card (profile_big_avatar.tmpl:123-148),
 * which our profile family does not render (the §2.5 write-action rule); a
 * card-level button would need that unlanded POST arm, and upstream renders
 * none here anyway.
 *
 * ## Entry points and the tab strip (the wave I-b completion recorded)
 *
 * The `?tab=followers`/`?tab=following` anchors live ONLY on the avatar
 * card — `shared/user/profile_big_avatar.tmpl:25` renders the
 * `NumFollowers`/`NumFollowing` counts as the two
 * `{{.ContextUser.HomeLink}}?tab=…` anchors (the person glyph prefixing the
 * followers one). `user/overview/header.tmpl` has NO followers/following
 * menu entries at this pin (:8-46's conditions cover
 * overview/repositories/projects/packages/code/activity/stars/watching
 * only) — so on these tabs upstream renders the overview header with NO
 * active item (both `eq .TabName` conditions fail). The avatar card is the
 * SAME template on every profile tab (prepareContextForProfileBigAvatar
 * runs for each), so the wave I-b arms ride along: the C2 follow button
 * (profile_big_avatar.tmpl:123-136, IsFollowing over the landed machinery)
 * and the C3 admin gear (:18) render beside the unconditional RSS anchor
 * (:31-33). The module-local strip renders the C1 tab set INACTIVE
 * (Projects header.tmpl:14-21 with the ProjectCount label, Packages
 * :22-26 armed on the packages flag, Code :27-31) — exact header.tmpl
 * behavior for `TabName = followers/following`, the activity module's
 * local-strip shape.
 *
 * ## Visibility (the landed predicates — never a local re-derivation)
 *
 * The PAGE gate is upstream's `IsUserVisibleToViewer` (profile.go:77-80 —
 * an invisible owner 404-shells before any tab data runs); the landed
 * `resolveUserProfile` already applies it and `ownerHomePage` dispatches
 * here only for a VISIBLE user. The LISTING gate is
 * `isUserVisibleToViewerCond` (user.go:1466-1501), which the landed
 * follows service applies inside `listFollowers`/`listFollowing` (the
 * `FollowViewer` doer passthrough — admin-full, anonymous-public-only,
 * the signed-in five-arm OR). The loader passes the session doer through
 * verbatim; no local filtering.
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The avatar slot renders the placeholder person octicon, NOT inside the
 *   upstream `{{.HomeLink}}` anchor (user_cards.tmpl:11-13) — an icon-only
 *   link has no accessible name (the org-members avatar-link rule); the
 *   name link beside it carries the navigation.
 * - The `user_type_label` bot badge (user_cards.tmpl:14) never renders —
 *   the `users.type` enum is 'user' | 'org' only (no bot type modeled).
 * - The pager reduces base/paginate.tmpl to the Older/Newer pair (the
 *   org-home convention — the profile repositories tab's own
 *   OrgHomePagination is the same reduction), carrying `tab` + `page`
 *   exactly like upstream's AddParamFromRequest output.
 * - `CardsTitle` is never set by profile.go, so the `<h2>` arm
 *   (user_cards.tmpl:3-7) is not rendered; the container renders
 *   unconditionally, an empty `<ul class="list">` being upstream's own
 *   empty state (no empty-placeholder arm in the template).
 * - The joined-on date renders through the landed `formatDueDate` ("Jan 15,
 *   2026") — upstream's `DateUtils.AbsoluteShort` shape, the profile card's
 *   existing rendering.
 * - `data-fetch-trigger="fetch-reload"` is kept verbatim (user_cards.tmpl:2)
 *   for DOM fidelity; it is inert here — the reload keys on watch/unwatch or
 *   star/unstar fetch actions, none of which exist on this page.
 *
 * ## Data (§3.2 — the landed service, never a self-fetch)
 *
 * `listFollowers`/`listFollowing` (src/api/services/follows.ts — the
 * `GET /users/{username}/followers|following` reads) at `{page,
 * pageSize: USER_PROFILE_PAGE_SIZE}`, BOTH always awaited (profile.go:121-138
 * runs both before the switch; the inactive page's rows are discarded, its
 * total feeds the avatar card). The overview header's Repositories count
 * rides the profile loader's doer-visible WHERE (loadActivityFeedsData's
 * parity copy — the seePrivate arm is admin/self).
 *
 * ## Mount record (MOUNTED at 2f7afe9 — the wiring HANDOFF is retired)
 *
 * The module is complete end-to-end: `loadUserFollowTabsData` (the data
 * seam) + `renderUserFollowTabsPage` (the full-document render). The route
 * arm is `GET /{username}` with `tab=followers` OR `tab=following`, mounted
 * beside the activity arm in `ownerHomePage`:
 *
 *     // after the `tab=activity` arm, before the repositories default:
 *     if (url.searchParams.get("tab") === "followers" || url.searchParams.get("tab") === "following") {
 *       const data = await loadUserFollowTabsData(c.env.DB, profile.user, doer, url.searchParams);
 *       return respond(c.html(renderUserFollowTabsPage(ctx, data), 200));
 *     }
 *
 * plus the import `import { loadUserFollowTabsData, renderUserFollowTabsPage } from "./pages/user-follow-tabs";`.
 * The strip modules need NO diff (the header has no follower anchors at
 * this pin — the strip section above). The one sibling diff that shipped
 * in the same window (so the anchors never shipped dead) is user-profile.tsx's
 * ProfileAvatarCard: profile_big_avatar.tmpl:25's plain-text counts became
 * the two tab anchors. Org names
 * never reach this arm (ownerHomePage's org half answers first, upstream's
 * org.Home-ignores-the-tab parity).
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { isFollowing, listFollowers, listFollowing } from "../../api/services/follows";
import { projects, repositories } from "../../db/schema";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { activityFeedsLocale } from "./activity-feeds";
import { formatDueDate } from "./milestones";
import { EyeIcon } from "./user-watching-tab";
import {
  ProfileAvatarCard,
  USER_PROFILE_PAGE_SIZE,
  userDisplayName,
  userProfileLocale,
  type ProfileDoer,
  type UserProfileRow,
} from "./user-profile";

/** The two card-list tabs this module serves (the ownerHomePage dispatch's
 *  exact literal pair — the loader's parse never sees anything else from
 *  the route). */
export type FollowTab = "followers" | "following";

/**
 * The tab param parse: `following` → the following projection, anything
 * else → followers. The route dispatches only the two literals (the
 * mount record's arm); the default arm is the loader seam's defensive
 * fallback, unreachable from the mounted route.
 */
export function parseFollowTab(raw: string | null): FollowTab {
  return raw === "following" ? "following" : "followers";
}

/** The follow-tabs page's render inputs. */
export interface UserFollowTabsData {
  user: UserProfileRow;
  tab: FollowTab;
  /** The active tab's page of cards (full `users` rows — the follows
   *  service's projection, DisplayName/meta fields included). */
  cards: UserProfileRow[];
  /** The avatar card's REAL counts (both listings' totals). */
  followers: number;
  following: number;
  /** The overview header's Repositories count (the doer-visible WHERE). */
  repoCount: number;
  /** The overview header's Projects count (header.tmpl:17-20's
   *  `{{if .ProjectCount}}` label — the OPEN individual projects,
   *  loadHeaderCount parity). */
  openProjects: number;
  page: number;
  more: boolean;
  /** The avatar card's follow-button input (profile_big_avatar.tmpl:123-136
   *  — the same template renders on every profile tab; present only for a
   *  signed-in viewer who is not the target, IsFollowing(doer, target) its
   *  label). */
  followButton: { following: boolean } | null;
  /** profile_big_avatar.tmpl:18's admin gear gate (the viewer's admin
   *  flag). */
  viewerIsAdmin: boolean;
}

/**
 * Load the page (profile.go:121-161's arms over the landed follows
 * service): BOTH listings always run at the same page/pageSize — the
 * active tab's page becomes the cards, both totals feed the avatar card —
 * then the header count. The doer passes straight through to the service's
 * `FollowViewer` (the visibility section above); paging is the shared
 * `parsePageNumber` clamp (`page < 1`, junk → 1, no upper clamp).
 */
export async function loadUserFollowTabsData(
  d1: D1Database,
  user: UserProfileRow,
  doer: ProfileDoer,
  params: URLSearchParams,
): Promise<UserFollowTabsData> {
  const page = parsePageNumber(params.get("page"));
  const tab = parseFollowTab(params.get("tab"));
  const followViewer = { id: doer.id, isAdmin: doer.isAdmin };

  // profile.go:121-138: both listings, same page + RepoPagingNum, before
  // the switch (:155-161) picks the cards.
  const [followers, following] = await Promise.all([
    listFollowers(d1, user.id, followViewer, { page, pageSize: USER_PROFILE_PAGE_SIZE }),
    listFollowing(d1, user.id, followViewer, { page, pageSize: USER_PROFILE_PAGE_SIZE }),
  ]);
  const active = tab === "followers" ? followers : following;

  // The overview header's Repositories count — the profile loader's
  // doer-visible WHERE (loadActivityFeedsData's parity copy; seePrivate is
  // admin/self only).
  const seePrivate = doer.id !== null && (doer.isAdmin || doer.id === user.id);
  const repoWhere = seePrivate
    ? eq(repositories.ownerId, user.id)
    : and(eq(repositories.ownerId, user.id), eq(repositories.visibility, "public"));
  const [repoCountRow, openProjectsRow, viewerFollows] = await Promise.all([
    drizzle(d1)
      .select({ total: sql<number>`count(*)` })
      .from(repositories)
      .where(repoWhere)
      .get(),
    // The strip's Projects count (header.tmpl:17-20 — the OPEN individual
    // projects: the projects.ownerId arm, loadHeaderCount parity).
    drizzle(d1)
      .select({ total: sql<number>`count(*)` })
      .from(projects)
      .where(and(eq(projects.ownerId, user.id), eq(projects.isClosed, false)))
      .get(),
    // The avatar card is the SAME template on every profile tab
    // (prepareContextForProfileBigAvatar runs for each) — the follow
    // button's gate + state ride along here (profile_big_avatar.tmpl:
    // 123-136, IsFollowing(doer, target), header.go:28's argument order).
    doer.id !== null && doer.id !== user.id ? isFollowing(d1, doer.id, user.id) : Promise.resolve(false),
  ]);

  return {
    user,
    tab,
    cards: active.items,
    followers: followers.total,
    following: following.total,
    repoCount: Number(repoCountRow?.total ?? 0),
    openProjects: Number(openProjectsRow?.total ?? 0),
    page,
    more: page * USER_PROFILE_PAGE_SIZE < active.total,
    followButton: doer.id !== null && doer.id !== user.id ? { following: viewerFollows } : null,
    viewerIsAdmin: doer.isAdmin,
  };
}

// ---------------------------------------------------------------------------
// Components (user_cards.tmpl's DOM, the reductions in the module header)
// ---------------------------------------------------------------------------

/**
 * One user_cards.tmpl card row (:10-25): the placeholder avatar glyph (the
 * anchor dropped — the header's degradation note), the DisplayName link in
 * the `h3.name.flex-text-block`, and the `.meta.flex-text-block` arm chain
 * website → location → joined-on.
 */
export function FollowCard(props: { user: UserProfileRow }) {
  const card = props.user;
  const homeLink = `/${card.username}`;
  return (
    <li class="item ui segment">
      <span class="ui avatar" aria-hidden="true">
        <Icon name="octicon-person" size={48} />
      </span>
      <h3 class="name flex-text-block">
        <a href={homeLink}>{userDisplayName(card)}</a>
      </h3>
      <div class="meta flex-text-block">
        {card.website !== null && card.website !== "" ? (
          <>
            <Icon name="octicon-link" />{" "}
            <a href={card.website} target="_blank">
              {card.website}
            </a>
          </>
        ) : card.location !== null && card.location !== "" ? (
          <>
            <Icon name="octicon-location" /> {card.location}
          </>
        ) : (
          <>
            <Icon name="octicon-calendar" /> {userProfileLocale.joined_on} {formatDueDate(card.createdAt)}
          </>
        )}
      </div>
    </li>
  );
}

/**
 * The base/paginate reduction to the Older/Newer pair (the org-home
 * convention), carrying `tab` + `page` exactly like upstream's
 * AddParamFromRequest output — every link keeps the tab, page 1 is the
 * bare `?tab=…` URL (the OrgHomePagination page-1 shape).
 */
function FollowTabsPager(props: { username: string; tab: FollowTab; page: number; more: boolean }) {
  if (props.page <= 1 && !props.more) return null;
  const href = (page: number): string =>
    page > 1 ? `/${props.username}?tab=${props.tab}&page=${page}` : `/${props.username}?tab=${props.tab}`;
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a class="item navigation" href={href(props.page - 1)}>
            <span class="navigation_label">{activityFeedsLocale.newer}</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={href(props.page + 1)}>
            <span class="navigation_label">{activityFeedsLocale.older}</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The user_cards container (:2-30 minus the never-set CardsTitle arm): the
 * list renders unconditionally — an empty `<ul class="list">` is upstream's
 * own empty state — with the pager inside the container (user_cards.tmpl:29).
 */
export function FollowCardsList(props: {
  username: string;
  tab: FollowTab;
  cards: UserProfileRow[];
  page: number;
  more: boolean;
}) {
  return (
    <div class="user-cards" id="user-cards-container" data-fetch-trigger="fetch-reload">
      <ul class="list">
        {props.cards.map((card) => (
          <FollowCard user={card} />
        ))}
      </ul>
      <FollowTabsPager username={props.username} tab={props.tab} page={props.page} more={props.more} />
    </div>
  );
}

/**
 * The overview header (user/overview/header.tmpl reduced to its live tabs)
 * with NEITHER tab item active — the `eq .TabName` conditions (header.tmpl:8,
 * :33) fail for followers/following, and the Stars/watching anchors
 * (header.tmpl:36-46) never mark active here either (upstream renders the
 * overview header with no active item for these pages — the collapsed-if
 * rule: both anchors render, neither is active). The wave I-b completion
 * adds the C1 Projects tab (header.tmpl:14-21 — `octicon-project-symlink`,
 * the `{{if .ProjectCount}}` label), the Packages tab (header.tmpl:22-26,
 * armed on the strict-polarity packages flag) and the Code tab
 * (header.tmpl:27-31 — `octicon-code`, the "user.code" label), all INACTIVE
 * — the activity module's local strip renders the same three. Module-local,
 * the activity module's kept-local pattern; labels reuse userProfileLocale
 * (this module imports it).
 */
function OverviewTabs(props: { username: string; repoCount: number; openProjects: number; packagesEnabled?: boolean }) {
  return (
    <overflow-menu class="ui secondary pointing tabular borderless menu">
      <div class="overflow-menu-items">
        <a class="item" href={`/${props.username}?tab=repositories`}>
          <Icon name="octicon-repo" /> {userProfileLocale.repositories}
          {props.repoCount > 0 ? <div class="ui small label">{props.repoCount}</div> : null}
        </a>
        <a class="item" href={`/${props.username}/-/projects`}>
          <Icon name="octicon-project-symlink" /> {userProfileLocale.projects}
          {props.openProjects > 0 ? <div class="ui small label">{props.openProjects}</div> : null}
        </a>
        {props.packagesEnabled !== false ? (
          <a class="item" href={`/${props.username}/-/packages`}>
            <Icon name="octicon-package" /> {userProfileLocale.packages}
          </a>
        ) : null}
        <a class="item" href={`/${props.username}/-/code`}>
          <Icon name="octicon-code" /> {userProfileLocale.code}
        </a>
        <a class="item" href={`/${props.username}?tab=activity`}>
          <Icon name="octicon-rss" /> {userProfileLocale.activity}
        </a>
        <a class="item" href={`/${props.username}?tab=stars`}>
          <Icon name="octicon-star" /> {userProfileLocale.starred}
        </a>
        <a class="item" href={`/${props.username}?tab=watching`}>
          <EyeIcon /> {userProfileLocale.watched}
        </a>
      </div>
    </overflow-menu>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderUserFollowTabsPage(ctx: UiContext, data: UserFollowTabsData): string {
  return renderPage(<UserFollowTabsPage ctx={ctx} data={data} />);
}

/** The profile follow tabs (profile.tmpl's grid + the `tab ==
 *  "followers"/"following"` branch: §2.4.1 discriminator `user profile`).
 *  The avatar card is the SAME template on every profile tab — the wave I-b
 *  arms ride along (the follow button profile_big_avatar.tmpl:123-136, the
 *  admin gear :18, the RSS anchor :31-33 already unconditional). */
export function UserFollowTabsPage(props: { ctx: UiContext; data: UserFollowTabsData }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title={userDisplayName(data.user)} pageClass="user profile">
      <div class="ui container">
        <div class="ui stackable grid">
          <div class="ui four wide column">
            <ProfileAvatarCard
              user={data.user}
              followers={data.followers}
              following={data.following}
              followButton={data.followButton ?? undefined}
              viewerIsAdmin={data.viewerIsAdmin}
            />
          </div>
          <div class="ui twelve wide column tw-mb-4">
            <OverviewTabs
              username={data.user.username}
              repoCount={data.repoCount}
              openProjects={data.openProjects}
              packagesEnabled={ctx.packagesEnabled}
            />
            <FollowCardsList
              username={data.user.username}
              tab={data.tab}
              cards={data.cards}
              page={data.page}
              more={data.more}
            />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

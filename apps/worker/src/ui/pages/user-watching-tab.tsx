/**
 * The profile WATCHING tab, `/{username}?tab=watching` — pages wave-124: the
 * watched-repositories list behind the overview header's DisableStars anchor
 * (routers/web/user/profile.go:220-246's `case "watching"`:
 * `SearchRepository{WatchedByID: ctx.ContextUser.ID, Collaborate:
 * optional.Some(false), Private: ctx.IsSigned, Actor: ctx.Doer}` — the
 * USER→repos watch direction; the repo→users direction is social-lists.ts
 * listRepoSubscribers). The twin of the stars module's `?tab=stars` page and
 * the mounted `?tab=activity` arm — the profile grid, the avatar card, the
 * tab strip, then the repositories-tab body.
 *
 * ## Upstream condition (cited at the pin)
 *
 * profile.go's watching case differs from stars (:191-219) in exactly one
 * option: `WatchedByID` instead of `StarredByID` — and it does NOT set
 * `ShowRepoOwnerOnList` (:193 sets it for stars only). `WatchedByID`
 * restricts to `id IN (SELECT repo_id FROM watch WHERE user_id = …)`
 * (models/repo/repo_list.go:401-403). `Collaborate: optional.Some(false)`
 * is inert here: it only applies when `opts.OwnerID > 0`
 * (repo_list.go:405-411) and the watching arm sets no OwnerID. The
 * visibility arm is `SearchRepositoryCondition` (repo_list.go:365-398):
 * `Private = ctx.IsSigned` — an anonymous doer is forced public-only
 * (public rows AND non-limited/private owners), a signed-in non-admin sees
 * additionally the private rows AccessibleRepositoryCondition grants (own +
 * collaborator + team), an admin is unfiltered; the landed reduced ACL
 * keeps the own arm (§3.2 — the collapse documented on
 * listReposStarredByUser and loadUserProfileData). Keyword/sort/language and
 * the archived/fork/mirror/template/private filters (:227-239) are not
 * landed — the profile page renders no search box (the org-home reduction).
 *
 * ## DOM contract (templates/user/profile.tmpl's `{{else}}` branch +
 *  shared/repo/list.tmpl + base/paginate.tmpl at the pin)
 *
 * profile.tmpl has NO watching branch: `?tab=watching` falls into the
 * `{{else}}` default (:32-36) — `shared/repo/search` + divider +
 * `shared/repo/list` + `base/paginate`, the repositories-tab shape (the
 * stars branch (:26-31) is the one that adds the `.stars` wrapper div; the
 * watching page renders the bare list). The search include + divider are
 * the documented reduction (no search route); the list renders its
 * `{{range}}…{{else}}` arm verbatim: zero rows = `search.no_results`
 * ("No matching results found.").
 *
 * Rows are shared/repo/list.tmpl's rows with the watching arm's gates:
 * title = the repo NAME only (`{{if and $.ShowRepoOwnerOnList .Owner}}` is
 * unset for watching) linking `/{owner}/{repo}` (repo.Link); the leading
 * slot renders the repo/icon fallback glyph (no avatar pipeline — the
 * org-home reduction); badges archived/private and the per-row internal
 * badge (`{{if .Owner.Visibility.IsPrivate}}` — owners ARE loaded,
 * repo_list.go's `loadAttributes`); trailing chips star (`{{if not
 * $.DisableStars}}`, default false at the pin, modules/setting/
 * repository.go:155 → renders, linked to the LIVE /{owner}/{repo}/stars
 * page) and open-pulls (the org-home row reduction; forks have no D1
 * counter — §3.1); the watch-gear button is gated on `$.Watches`, which
 * profile.go never sets → never renders; description + "Updated
 * {TimeSince}". The pager is base/paginate.tmpl's AddParamFromRequest
 * reduction — every link carries `tab=watching`.
 *
 * ## The tab strip (header.tmpl's watching anchor, verified)
 *
 * `user/overview/header.tmpl:43-46`: the watching anchor is the `{{else}}`
 * arm of `{{if not .DisableStars}}` — it REPLACES the Stars item when the
 * setting is on: `href="{{.ContextUser.HomeLink}}?tab=watching"`,
 * `{{svg "octicon-eye"}}`, label locale `user.watched` ("Watched
 * Repositories", locale_en-US.json), NO count label. With the default
 * (false) upstream renders stars there and NOTHING in the header is active
 * on `?tab=watching` (the tab is URL-reachable only). This module renders
 * the DisableStars arm faithfully — the watching item ACTIVE with the eye
 * glyph — beside the two live tabs (Repositories with the doer-visible
 * count, Activity), the follow-tabs module's kept-local strip pattern. The
 * eye glyph is NOT in the generated allowlist (scripts/gen-ui-icons.mjs) —
 * it embeds the exact submodule body inline (the
 * repo-blob-excerpt-fragment.tsx FOLD_SVG precedent); the HANDOFF NOTE
 * carries the allowlist migration.
 *
 * ## Visibility (the landed predicates — never a local re-derivation)
 *
 * The page rides the owner-home dispatch's USER half wholesale (the
 * resolveUserProfile ladder in pages/user-profile.tsx — userAssignment, the
 * user_redirects seam, IsUserVisibleToViewer); this module only loads the
 * tab body. The watched list is the landed `listWatchedRepositories`
 * (src/api/services/social-lists.ts:90 — the `GET /users/{username}/
 * subscriptions` read, REUSED AS-IS): its WHERE is the reduced ACL — public
 * rows plus rows whose namespace is the REQUESTING doer's, the admin arm
 * dropping the filter — exactly the Private-semantics collapse, KEPT
 * sharper than the stars lister's two-arm `seePrivate` (the owned-by-doer
 * arm survives: a stranger sees a private watched repo they own). The UI
 * `ProfileDoer` carries no login, so the loader resolves it: self reuses
 * the profile row's `usernameLower`, a signed-in non-admin stranger reads
 * their `users` row by id (one Drizzle read, the userVisibleToDoer
 * pattern), anonymous passes "" (public-only — the empty namespace never
 * matches) and the admin arm ignores the value (no lookup).
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The `shared/repo/search` box and its divider are not rendered (no
 *   search route — the q/sort/archived/fork filters of upstream's
 *   SearchRepository are therefore not landed either; the loader note).
 * - List order is the landed lister's `CAST(id AS INTEGER) ASC` (the
 *   numeric-id convention) — upstream sorts by the explore default
 *   (recentupdate, profile.go:118-124); the landed order wins (§3.2, the
 *   org-home note).
 * - Fork counters have no D1 column (§3.1); the primary-language chip needs
 *   a per-repo stats read — the trailing block renders the star chip + the
 *   open-pulls chip only.
 * - The eye glyph is embedded inline (the exact submodule path bytes) — the
 *   shared Icon facade's allowlist gains `octicon-eye` in a tooling wave
 *   (the HANDOFF NOTE's diff); the anchor then migrates to
 *   `<Icon name="octicon-eye">`.
 * - The pager is base/paginate.tmpl reduced to the Older/Newer pair (the
 *   org-home convention), carrying `tab=watching` in every href.
 * - Page size is upstream `setting.UI.User.RepoPagingNum` = 15
 *   (modules/setting/ui.go:147) — the SAME setting the repositories tab
 *   cites.
 *
 * ## HANDOFF NOTE — the mount recipe (NOT wired in this wave; index.ts is
 *  orchestrator-owned, recipe only; the orchestrator folds it in the mount
 *  window, exactly b1bf73a's activity arm)
 *
 * In apps/worker/src/ui/index.ts, ownerHomePage's USER half — AFTER the
 * `profile.kind === "missing"` 404 arm, BESIDE the `tab=activity` arm (and
 * the stars sibling's `tab=stars` arm when that folds first), BEFORE the
 * default loadUserProfileData fall-through:
 *
 * ```ts
 * import { loadUserWatchingTabData, renderUserWatchingTabPage } from "./pages/user-watching-tab";
 * // ...
 * if (url.searchParams.get("tab") === "watching") {
 *   const data = await loadUserWatchingTabData(c.env.DB, profile.user, doer, url.searchParams);
 *   return respond(c.html(renderUserWatchingTabPage(ctx, data), 200));
 * }
 * ```
 *
 * (`doer` is ownerHomePage's existing ProfileDoer — the loader resolves the
 * doer's login itself; no richer doer needed.) Strip-anchor diffs — the
 * exact watching anchor for the three family strips (compose with the stars
 * sibling's Stars anchor: header.tmpl renders watching INSTEAD of stars
 * under DisableStars, so the landed strips show both and document the
 * collapsed-if; place watching AFTER stars — the pragmatic order). Each
 * diff adds ONE inactive item (the watching page renders its own strip with
 * the item ACTIVE):
 *
 * ```tsx
 * <a class="item" href={`/${props.username}?tab=watching`}>
 *   <EyeIcon /> {userProfileLocale.watched}
 * </a>
 * ```
 *
 * - pages/user-profile.tsx ProfileTabs (after the stars sibling's Stars
 *   item): the anchor above, with `watched: "Watched Repositories", //
 *   "user.watched" (header.tmpl:45)` added to userProfileLocale and
 *   `EyeIcon` imported from this module (exported below).
 * - pages/activity-feeds.tsx OverviewTabs (the same anchor, its own locale
 *   object gains `watched`).
 * - pages/user-follow-tabs.tsx OverviewTabs (the same anchor — its local
 *   strip; import EyeIcon from this module).
 * - Tooling (optional, one line): add `'octicon-eye',` to ALLOWLIST in
 *   scripts/gen-ui-icons.mjs, run `pnpm gen:icons`, then swap this module's
 *   EyeIcon embeds for `<Icon name="octicon-eye">`.
 *
 * Org names never reach this arm (ownerHomePage's org half answers first,
 * upstream's org.Home-ignores-the-tab parity).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { listFollowers, listFollowing } from "../../api/services/follows";
import { listWatchedRepositories } from "../../api/services/social-lists";
import { repoSettings, repositories, users } from "../../db/schema";
import { TimeSince } from "../components/file-list";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { ProfileAvatarCard, userDisplayName, type ProfileDoer, type UserProfileRow } from "./user-profile";

/** Page chrome text (component-local, the userStarsTabLocale pattern —
 *  locale.ts is shared and not this wave's file). */
export const userWatchingTabLocale = {
  repositories: "Repositories", // "user.repositories" (header.tmpl:13)
  activity: "Public Activity", // "user.activity" (header.tmpl:34)
  watched: "Watched Repositories", // "user.watched" (header.tmpl:45)
  no_results: "No matching results found.", // "search.no_results"
  repo_updated: "Updated", // "org.repo_updated"
  repo_archived: "Archived", // "repo.desc.archived"
  repo_private: "Private", // "repo.desc.private"
  repo_internal: "Internal", // "repo.desc.internal"
  stars_aria: "Stars", // "repo.stars" (list.tmpl's star chip aria label)
  repo_pulls_aria: "Pull Requests", // "repo.pulls"
  newer: "Newer", // the base/paginate reduction's navigation_label (OrgHomePagination shape)
  older: "Older",
} as const;

/** Upstream `setting.UI.User.RepoPagingNum` (modules/setting/ui.go:147) —
 *  the same paging setting the repositories tab renders with. */
export const USER_WATCHING_TAB_PAGE_SIZE = 15;

/** One rendered watched-repo row: the repository row plus the per-row owner
 *  visibility (the internal-badge arm) and the repo_settings description. */
export interface WatchingRepoItem {
  repo: typeof repositories.$inferSelect;
  /** The owning user's visibility — the list.tmpl internal-badge arm. */
  ownerVisibility: "public" | "limited" | "private";
  description: string;
}

/** The watching tab render inputs. */
export interface UserWatchingTabData {
  user: UserProfileRow;
  repos: WatchingRepoItem[];
  /** The visible watched total (the loader's filtered count — the pager's
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
 * The pinned submodule's octicon-eye body (gitea/public/assets/img/svg/
 * octicon-eye.svg) — outside the generated allowlist
 * (scripts/gen-ui-icons.mjs), so the module embeds the exact `<path d>`
 * bytes inline (the repo-blob-excerpt-fragment.tsx FOLD_SVG precedent): the
 * upstream `{{svg "octicon-eye"}}` DOM (viewBox 0 0 16 16, the
 * `svg octicon-eye` class, aria-hidden). The HANDOFF NOTE carries the
 * one-line allowlist migration.
 */
const EYE_SVG_PATH =
  "M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14s-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2M1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5s2.825-.742 3.955-1.715c1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5s-2.825.742-3.955 1.715c-1.124.967-1.954 2.096-2.366 2.717M8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10";

/** The `{{svg "octicon-eye"}}` inline shape (shell.tsx's Icon DOM). */
export function EyeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      class="svg octicon-eye"
      aria-hidden="true"
    >
      <path d={EYE_SVG_PATH} />
    </svg>
  );
}

/**
 * Load the watching tab (profile.go:220-246's arm — §3.2, the landed
 * lister, never a self-fetch): the visible watched listing over
 * `listWatchedRepositories` (the doer login resolved per the visibility
 * section), one batched description read for the page's rows (the org-home
 * loader's pattern), the doer-visible Repositories count, and the
 * follower/following totals (the avatar card, the profile loader's
 * count-only reads). Paging is the shared `parsePageNumber` clamp
 * (`page < 1`, junk → 1, no upper clamp).
 */
export async function loadUserWatchingTabData(
  d1: D1Database,
  user: UserProfileRow,
  doer: ProfileDoer,
  params: URLSearchParams,
): Promise<UserWatchingTabData> {
  const page = parsePageNumber(params.get("page"));

  // profile.go:226-229's Actor/IsSigned arms → the landed lister's doer
  // login (the visibility section above): self reuses the profile row, a
  // signed-in stranger resolves their users row, anonymous passes "" (the
  // empty namespace never matches — public-only), the admin arm ignores
  // the value (no lookup).
  let doerLoginLower = "";
  if (doer.id !== null && !doer.isAdmin) {
    if (doer.id === user.id) {
      doerLoginLower = user.usernameLower;
    } else {
      const row = await drizzle(d1)
        .select({ usernameLower: users.usernameLower })
        .from(users)
        .where(eq(users.id, doer.id))
        .get();
      doerLoginLower = row?.usernameLower ?? "";
    }
  }

  const listing = await listWatchedRepositories(d1, user.id, {
    doerLoginLower,
    isAdmin: doer.isAdmin,
    page,
    pageSize: USER_WATCHING_TAB_PAGE_SIZE,
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
  const seePrivate = doer.id !== null && (doer.isAdmin || doer.id === user.id);
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
      repo: item.repo,
      ownerVisibility: item.owner.visibility,
      description: descriptions.get(item.repo.id) ?? "",
    })),
    total: listing.total,
    repoCount: Number(repoCountRow?.total ?? 0),
    followers: followers.total,
    following: following.total,
    page,
    more: page * USER_WATCHING_TAB_PAGE_SIZE < listing.total,
  };
}

// ---------------------------------------------------------------------------
// Components (shared/repo/list.tmpl's DOM, the reductions in the module header)
// ---------------------------------------------------------------------------

/**
 * The overview header (user/overview/header.tmpl reduced to its LIVE tabs —
 * the stars module's StarsTabs twin with the DisableStars arm in stars'
 * place): Repositories and Activity inactive, Watching ACTIVE —
 * header.tmpl:44-46's exact anchor (`?tab=watching`, the eye glyph, the
 * user.watched label) with NO count label (upstream renders none). The
 * Repositories count label is the doer-visible query (the `{{if
 * .RepoCount}}` gate); Activity carries none. Module-local: org-home.tsx is
 * not this wave's file and OrgMenu carries no activity slot.
 */
function WatchingTabs(props: { username: string; repoCount: number }) {
  return (
    <overflow-menu class="ui secondary pointing tabular borderless menu">
      <div class="overflow-menu-items">
        <a class="item" href={`/${props.username}?tab=repositories`}>
          <Icon name="octicon-repo" /> {userWatchingTabLocale.repositories}
          {props.repoCount > 0 ? <div class="ui small label">{props.repoCount}</div> : null}
        </a>
        <a class="item" href={`/${props.username}?tab=activity`}>
          <Icon name="octicon-rss" /> {userWatchingTabLocale.activity}
        </a>
        <a class="active item" href={`/${props.username}?tab=watching`}>
          <EyeIcon /> {userWatchingTabLocale.watched}
        </a>
      </div>
    </overflow-menu>
  );
}

/**
 * One shared/repo/list.tmpl `.item` row — the repositories tab's row DOM
 * (the OrgRepoListItem reduction) with the watching arm's gates: the title
 * is the repo NAME only (ShowRepoOwnerOnList is unset for watching —
 * profile.go sets it for stars alone) linking `/{owner}/{repo}` (repo.Link),
 * the internal badge reads THIS row's owner visibility (list.tmpl's
 * `{{if .Owner.Visibility.IsPrivate}}`), and the trailing block renders the
 * star chip (DisableStars defaults false — linked to the live
 * /{owner}/{repo}/stars page) beside the open-pulls chip; the watch-gear
 * button's `$.Watches` is never set by profile.go → never renders.
 */
export function WatchingRepoListItem(props: { item: WatchingRepoItem }) {
  const { repo } = props.item;
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const openPulls = Math.max(repo.numPulls - repo.numClosedPulls, 0);
  return (
    <div class="item">
      <div class="item-leading">
        <Icon name="octicon-repo" size={24} />
      </div>
      <div class="item-main">
        <div class="item-header">
          <div class="item-title">
            <a class="tw-text-primary name" href={repoLink}>
              {repo.slug}
            </a>
            <span class="label-list">
              {repo.isArchived ? <span class="ui basic label">{userWatchingTabLocale.repo_archived}</span> : null}
              {repo.visibility === "private" ? (
                <span class="ui basic label">{userWatchingTabLocale.repo_private}</span>
              ) : props.item.ownerVisibility === "private" ? (
                <span class="ui basic label">{userWatchingTabLocale.repo_internal}</span>
              ) : null}
            </span>
          </div>
          <div class="item-trailing muted-links">
            <a class="flex-text-inline" href={`${repoLink}/stars`}>
              <span class="tw-contents" aria-label={userWatchingTabLocale.stars_aria}>
                <Icon name="octicon-star" size={16} />
              </span>
              <span>{repo.numStars}</span>
            </a>
            <a class="flex-text-inline" href={`${repoLink}/pulls`}>
              <span class="tw-contents" aria-label={userWatchingTabLocale.repo_pulls_aria}>
                <Icon name="octicon-git-pull-request" size={16} />
              </span>
              <span>{openPulls}</span>
            </a>
          </div>
        </div>
        {props.item.description !== "" ? <div class="item-body">{props.item.description}</div> : null}
        {repo.updatedAt !== null ? (
          <div class="item-body">
            {userWatchingTabLocale.repo_updated}{" "}
            <TimeSince unixSeconds={Math.floor(repo.updatedAt.getTime() / 1000)} tz="+0000" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The pager — base/paginate.tmpl reduced to the Older/Newer pair (the
 *  org-home convention), every href carrying `tab=watching` (upstream's
 *  AddParamFromRequest keeps every query param except page). */
function WatchingTabPager(props: { username: string; page: number; more: boolean }) {
  const href = (page: number): string => {
    const params = new URLSearchParams();
    params.set("tab", "watching");
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
            <span class="navigation_label">{userWatchingTabLocale.newer}</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={href(props.page + 1)}>
            <span class="navigation_label">{userWatchingTabLocale.older}</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderUserWatchingTabPage(ctx: UiContext, data: UserWatchingTabData): string {
  return renderPage(<UserWatchingTabPage ctx={ctx} data={data} />);
}

/** The profile watching tab (profile.tmpl's grid + the `{{else}}` default
 *  branch the watching tab falls into: §2.4.1 discriminator `user
 *  profile`). */
export function UserWatchingTabPage(props: { ctx: UiContext; data: UserWatchingTabData }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title={userDisplayName(data.user)} pageClass="user profile">
      <div class="ui container">
        <div class="ui stackable grid">
          <div class="ui four wide column">
            <ProfileAvatarCard user={data.user} followers={data.followers} following={data.following} />
          </div>
          <div class="ui twelve wide column tw-mb-4">
            <WatchingTabs username={data.user.username} repoCount={data.repoCount} />
            {/* profile.tmpl's {{else}} branch: NO .stars wrapper — the search
                box + divider are the documented reduction, the list + pager
                render bare; the list's range-else arm on zero rows. */}
            <div class="flex-divided-list items-with-main">
              {data.repos.length === 0 ? (
                <div>{userWatchingTabLocale.no_results}</div>
              ) : (
                data.repos.map((item) => <WatchingRepoListItem item={item} />)
              )}
            </div>
            <WatchingTabPager username={data.user.username} page={data.page} more={data.more} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

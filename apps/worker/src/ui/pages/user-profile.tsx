/**
 * The user profile page, `/{username}` — pages wave 7 (SPEC-0008 U3
 * extension): the public user profile — avatar card, the reduced overview
 * menu, and the user's visible repository list. The USER half of the
 * single-segment owner-home family (pages/org-home.tsx is the org half; one
 * parse family, upstream's `OwnerProfile` dispatch — routers/web/user/
 * profile.go:37-52: `if ctx.ContextUser.IsOrganization() { org.Home(ctx) }
 * else { userProfile(ctx) }`).
 *
 * ## DOM contract (templates/user/profile.tmpl + shared/user/profile_big_avatar.tmpl
 *  + user/overview/header.tmpl + shared/repo/list.tmpl at the pin)
 *
 * `.page-content.user profile` (profile.tmpl:2), then one `.ui.container >
 * .ui.stackable.grid` with the two upstream columns: `.ui.four.wide.column`
 * carrying the `#profile-avatar-card .ui.fitted.segment` avatar card
 * (profile_big_avatar.tmpl) and `.ui.twelve.wide.column.tw-mb-4` carrying
 * the overview menu + the repository list (profile.tmpl:8-38's default
 * "repositories" tab — no profile README pipeline exists, so overview
 * degrades to repositories exactly like upstream's tab fallback,
 * profile.go:96-101).
 *
 * ## Visibility (the landed predicates — never a local re-derivation)
 *
 * The row resolves through upstream's userAssignment shape
 * (services/context/user.go:38-66): a type-blind `users` lookup, then the
 * USER type gate (an ORG name is this half's miss — it rendered the org home
 * already, the §4.11 gate mirrored), then the shared `user_redirects` seam —
 * a renamed user 307s onto the new name behind the coarse `RedirectToUser`
 * visibility gate (context_response.go:40-47, the same `doerCanViewPrivate`
 * predicate orgs.ts:109 applies), first-occurrence path rewrite, query
 * preserved. A LIVE user then passes `IsUserVisibleToViewer`
 * (models/user/user.go:1504-1556): self or site admin always; `public`
 * anyone; `limited` any signed-in viewer (the restricted-principal arm is
 * unreachable — no users.restricted column, the orgs.ts header note);
 * `private` a signed-in follower (user.go:1526, `IsFollowing(u.ID,
 * viewer.ID)` — verbatim argument order) or a co-member of any shared
 * organization (user.go:1531-1552 collapsed to org_members, the follows.ts
 * team-arm reduction). A prohibited user is invisible for EVERY viewer (the
 * landed §4.8 posture — repo-view.ts's owner-status rule). Anything not
 * visible 404-shells, indistinguishable from missing (existence never
 * leaks, the §2.5 posture).
 *
 * The repo list is a direct D1 read (§3.2 — the landed
 * `listUserRepositories` service speaks the API `Viewer` contract, whose
 * requester model the session viewer would have to fake; the WHERE is the
 * same owner-visibility rule): the user's own repos — every row for the
 * user themself or a site admin, `visibility = 'public'` rows for everyone
 * else (upstream SearchRepository{OwnerID, Private: ctx.IsSigned},
 * profile.go:281-297; org parity — listOrgRepos §4.7). Order is
 * `slug ASC` (listOrgRepos parity); upstream sorts by the explore default
 * (recentupdate) — the landed order wins (§3.2, the org-home note).
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The avatar slot renders a placeholder circle with the person octicon
 *   (no avatar pipeline — an `<img>` to a missing route is a dead link, the
 *   avatar-slot rule the org home set).
 * - The overview menu (user/overview/header.tmpl) renders its LIVE tabs in
 *   the template's order: Repositories (ACTIVE here), Projects (header.tmpl:16-21
 *   — the C1 tab, the `/-/projects` page, inactive with the ProjectCount
 *   label), Packages (header.tmpl:22-25, armed whenever
 *   `ctx.packagesEnabled !== false` — SPEC-0016 M2), Code (header.tmpl:26-31
 *   — the C1 tab, the `/-/code` page, inactive), Activity (the mounted
 *   `?tab=activity` page) and the Stars/watching pair (the collapsed-if note
 *   on ProfileTabs). Overview needs a profile-readme pipeline — not
 *   rendered (dead links forbidden, §2.4.1).
 * - The visibility badge next to the username follows the task brief and
 *   the org-header badge DOM (`ui large basic horizontal label`) — upstream
 *   badges org profiles only at this pin (org_profile_avatar.tmpl:9-10); an
 *   intentional divergence, kept discoverable for the visibility ladder.
 * - The email row needs the `ShowUserEmail` profile setting (no such model
 *   — profile_big_avatar.tmpl:60-66) and is not rendered. The admin gear
 *   (:18), the RSS feed anchor (:31-33) and the follow button (:123-136)
 *   ARE rendered (the C2/C3 rows — the gear on the viewer-side admin flag,
 *   the feed anchor unconditionally, the button when the loader passes
 *   followButton); the block-user link (:139-148) has no landed POST arm —
 *   not rendered (the dead-control rule); the org-avatar row
 *   (profile_big_avatar.tmpl:92-105) needs avatars — not rendered.
 * - The description renders as plain text (upstream renders markup through
 *   the README pipeline; the description is profile metadata here).
 * - The shared/repo/search box and its `<div class="divider">` are not
 *   rendered (no search route — the org-home reduction); the repo list
 *   wrapper div renders unconditionally, exactly upstream's shared/repo/
 *   list.tmpl:1.
 * - Row counters: the `.item-trailing` block renders the open-pulls count
 *   only (the org-home row reduction, shared/repo/list.tmpl's star/fork
 *   counters have no D1 columns — §3.1).
 * - Page size is upstream `setting.UI.User.RepoPagingNum` = 15
 *   (modules/setting/ui.go:147) — the SAME setting the org home cites.
 */

import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { doerCanViewPrivate } from "../../api/services/orgs";
import { isFollowing, listFollowers, listFollowing } from "../../api/services/follows";
import { orgMembers, projects, repoSettings, repositories, users } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { formatDueDate } from "./milestones";
import { OrgHomePagination, OrgRepoListItem, orgDisplayName, type OrgHomeRepoItem } from "./org-home";
import { AdminEmbeddedSvg } from "./admin-users";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { EyeIcon } from "./user-watching-tab";

/** Page chrome text (component-local, the orgHomeLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const userProfileLocale = {
  joined_on: "Joined on", // "user.joined_on"
  followers: "followers", // "user.followers"
  following: "following", // "user.following"
  repositories: "Repositories", // "user.repositories" (header.tmpl:13)
  projects: "Projects", // "user.projects" (header.tmpl:23's item — the C1 tab)
  packages: "Packages", // "packages.title" (header.tmpl:22-25's item — SPEC-0016 M2)
  code: "Code", // "user.code" (header.tmpl:29's item — the C1 tab)
  activity: "Public Activity", // "user.activity" (header.tmpl:34)
  starred: "Starred Repositories", // "user.starred" (header.tmpl:38)
  watched: "Watched Repositories", // "user.watched" (header.tmpl:45)
  visibility_limited: "Limited", // "org.settings.visibility.limited_shortname"
  visibility_private: "Private", // "org.settings.visibility.private_shortname"
  follow: "Follow", // "user.follow" (profile_big_avatar.tmpl:145)
  unfollow: "Unfollow", // "user.unfollow" (profile_big_avatar.tmpl:141)
  rss_feed: "RSS Feed", // "rss_feed" (profile_big_avatar.tmpl:32's tooltip)
  admin_details: "User Details", // "admin.users.details" (profile_big_avatar.tmpl:19's gear tooltip)
} as const;

/** Upstream `setting.UI.User.RepoPagingNum` (modules/setting/ui.go:147) —
 *  the same paging setting the org home renders with. */
export const USER_PROFILE_PAGE_SIZE = 15;

/** The full `users` row behind the profile (the page renders profile
 *  metadata the OrgRecord projection does not carry: status, createdAt,
 *  website/location/description). */
export type UserProfileRow = typeof users.$inferSelect;

/** The authenticated doer slice the ladder needs (null id = anonymous) —
 *  the OrgDoer shape, shared with the org half's predicates. */
export type ProfileDoer = { id: number | null; isAdmin: boolean };

/** Upstream `DisplayName()` (models/user: fullName or the username). */
export function userDisplayName(user: UserProfileRow): string {
  return user.fullName !== null && user.fullName !== "" ? user.fullName : user.username;
}

/**
 * `IsUserVisibleToViewer` (user.go:1504-1556) over the landed columns —
 * the header-comment ladder. `doer.id === user.id` (self) and site admin
 * short-circuit true; `private` checks follower-then-co-member.
 */
export async function userVisibleToDoer(
  d1: D1Database,
  user: UserProfileRow,
  doer: ProfileDoer,
): Promise<boolean> {
  if (doer.id !== null && (doer.isAdmin || doer.id === user.id)) return true;
  switch (user.visibility) {
    case "public":
      return true;
    case "limited":
      // Any authenticated principal (user.go:1515-1519; the restricted arm
      // is unreachable — no users.restricted column).
      return doer.id !== null;
    case "private": {
      if (doer.id === null) return false;
      // "If they follow - they see each other" (user.go:1525-1529) — the
      // verbatim IsFollowing(u.ID, viewer.ID) argument order.
      if (await isFollowing(d1, user.id, doer.id)) return true;
      // Shared-organization membership (user.go:1531-1552): a viewer row in
      // any org the user belongs to — plus upstream's `org_id = u.ID` arm
      // (the target-is-an-org special case, unreachable for type='user'
      // rows but kept verbatim in the OR).
      const shared = await drizzle(d1)
        .select({ id: orgMembers.id })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.userId, doer.id),
            or(
              eq(orgMembers.orgId, user.id),
              inArray(
                orgMembers.orgId,
                drizzle(d1).select({ orgId: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, user.id)),
              ),
            ),
          ),
        )
        .get();
      return shared !== undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution — the handler-side seam (index.ts calls these; kept here so the
// page module owns its data path, the org-home pattern)
// ---------------------------------------------------------------------------

/** The resolution outcome for `/{user}` (the header comment's ladder): the
 *  resolved user row, a rename redirect, or a miss (→ 404 shell). */
export type UserProfileResolution =
  | { kind: "user"; user: UserProfileRow }
  | { kind: "redirect"; location: string }
  | { kind: "missing" };

/**
 * Resolve the user for the page viewer — upstream userAssignment
 * (services/context/user.go:38-66) reduced: the type-gated live lookup,
 * then the shared `user_redirects` seam (a renamed user 307s behind the
 * coarse RedirectToUser gate, the org half's identical seam), then the
 * `IsUserVisibleToViewer` ladder. A prohibited user is a miss for every
 * viewer (§4.8).
 */
export async function resolveUserProfile(
  d1: D1Database,
  username: string,
  doer: ProfileDoer,
  requestPath: string,
  requestQuery: string,
): Promise<UserProfileResolution> {
  const orgs = new OrgService(d1);
  const lower = username.toLowerCase();
  const byLower = (value: string) =>
    drizzle(d1).select().from(users).where(eq(users.usernameLower, value)).get();
  const byId = (id: number) => drizzle(d1).select().from(users).where(eq(users.id, id)).get();

  const user: UserProfileRow | undefined = await byLower(lower);
  if (user === undefined || user.type !== "user") {
    // Miss OR an org row (the type gate — orgs answered on the org half).
    // Upstream then consults the redirect table (user.go:48-49); the seam
    // and its coarse gate are the org half's (orgs.ts:101-123), type-gated
    // to USER targets here so an org-target redirect can never leak from
    // this half.
    const redirectUserId = await orgs.lookupUserRedirect(lower);
    if (redirectUserId === null) return { kind: "missing" };
    const target = await byId(redirectUserId);
    if (target === undefined || target.type !== "user") return { kind: "missing" };
    if (target.visibility !== "public" && !doerCanViewPrivate(doer)) {
      // "We must be signed in to see limited or private" targets
      // (context_response.go:41-44) — indistinguishable from a miss.
      return { kind: "missing" };
    }
    // RedirectToUser (context_response.go:47-55): first occurrence of the
    // old name in the escaped path → the new display name; query preserved.
    let location = requestPath.replace(username, target.username);
    if (requestQuery !== "") {
      location += `?${requestQuery}`;
    }
    return { kind: "redirect", location };
  }
  // A prohibited user is invisible for every viewer (§4.8, repo-view.ts's
  // owner-status rule); the ladder answers the rest.
  if (user.status !== "active") return { kind: "missing" };
  if (!(await userVisibleToDoer(d1, user, doer))) return { kind: "missing" };
  return { kind: "user", user };
}

/** The profile page render inputs. */
export interface UserProfileData {
  user: UserProfileRow;
  repos: OrgHomeRepoItem[];
  total: number;
  followers: number;
  following: number;
  page: number;
  more: boolean;
  /** The strip's Projects tab count (header.tmpl:24's `{{if .ProjectCount}}`
   *  label — the OPEN individual projects total, loadHeaderCount parity,
   *  shared/user/header.go:172-192). */
  openProjects: number;
  /** profile_big_avatar.tmpl:123-136's follow button input: present only
   *  for a signed-in viewer who is not the target (upstream's
   *  `and .IsSigned (ne .SignedUserID .ContextUser.ID)` gate — no block
   *  store exists, so the `{{if not .UserBlocking}}` arm always holds);
   *  `following` is IsFollowing(doer, target) (header.go:28). */
  followButton: { following: boolean } | null;
  /** profile_big_avatar.tmpl:18's admin gear gate (`{{if .IsAdmin}}` — the
   *  signed-in viewer's admin flag; anonymous is false). */
  viewerIsAdmin: boolean;
}

/**
 * Load the page (§3.2 — direct service/Drizzle reads, never a self-fetch):
 * the visible-row listing (the header-comment WHERE), one batched
 * description read for the page's rows (the org-home loader's pattern), and
 * the follower/following totals (the landed follows service, count-only
 * pages — the numbers are real, the tab pages are not).
 *
 * The totals ARE the upstream shape, verified against the pin
 * (webui-parity count arm): profile_big_avatar.tmpl:25 renders
 * `.NumFollowers`/`.NumFollowing` from `prepareUserProfileTabData`'s
 * `GetUserFollowers`/`GetUserFollowing` FindAndCount totals
 * (routers/web/user/profile.go:118-138 over models/user/user.go:355-398 —
 * the VISIBILITY-FILTERED listings, not the raw maintained counters), so
 * the viewer-dependent totals and the anon-invisible private-follower
 * edges are upstream's own behavior, and the follow-tabs sibling's
 * identical call is the same parity. The API user payload's separate
 * `followers_count`/`following_count` (the raw maintained counters,
 * convert/user.go) is the api/services serializer files' surface — NOT
 * consumed here (the web profile never reads it), not duplicated (the
 * serializer unit owns those files; its hardcoded zeros remain its open
 * drift, parity-review-api.md:212).
 */
export async function loadUserProfileData(
  d1: D1Database,
  user: UserProfileRow,
  doer: ProfileDoer,
  params: URLSearchParams,
): Promise<UserProfileData> {
  const page = parsePageNumber(params.get("page"));
  const db = drizzle(d1);
  const seePrivate = doer.id !== null && (doer.isAdmin || doer.id === user.id);
  const where = seePrivate
    ? eq(repositories.ownerId, user.id)
    : and(eq(repositories.ownerId, user.id), eq(repositories.visibility, "public"));

  const rows = await db
    .select()
    .from(repositories)
    .where(where)
    .orderBy(asc(repositories.slug))
    .limit(USER_PROFILE_PAGE_SIZE)
    .offset((page - 1) * USER_PROFILE_PAGE_SIZE);
  const totalRow = await db
    .select({ total: sql<number>`count(*)` })
    .from(repositories)
    .where(where)
    .get();
  const total = Number(totalRow?.total ?? 0);

  const descriptions = new Map<string, string>();
  if (rows.length > 0) {
    const settings = await db
      .select({ repoId: repoSettings.repoId, description: repoSettings.description })
      .from(repoSettings)
      .where(inArray(repoSettings.repoId, rows.map((row) => row.id)))
      .all();
    for (const row of settings) descriptions.set(row.repoId, row.description);
  }

  const followViewer = { id: doer.id, isAdmin: doer.isAdmin };
  const [followers, following, openProjectsRow, viewerFollows] = await Promise.all([
    listFollowers(d1, user.id, followViewer, { page: 1, pageSize: 1 }),
    listFollowing(d1, user.id, followViewer, { page: 1, pageSize: 1 }),
    // header.tmpl:24's ProjectCount (the OPEN individual projects —
    // loadHeaderCount parity, shared/user/header.go:172-192's
    // SearchOptions{OwnerID, IsClosed: false, Type: individual} count; the
    // individual scope IS the projects.ownerId arm).
    drizzle(d1)
      .select({ total: sql<number>`count(*)` })
      .from(projects)
      .where(and(eq(projects.ownerId, user.id), eq(projects.isClosed, false)))
      .get(),
    // profile_big_avatar.tmpl:123-136's gate + state: a signed-in viewer
    // who is not the target carries the button, IsFollowing(doer, target)
    // is its label (header.go:28's exact argument order).
    doer.id !== null && doer.id !== user.id ? isFollowing(d1, doer.id, user.id) : Promise.resolve(false),
  ]);

  return {
    user,
    repos: rows.map((row) => ({ repo: row, description: descriptions.get(row.id) ?? "" })),
    total,
    followers: followers.total,
    following: following.total,
    page,
    more: page * USER_PROFILE_PAGE_SIZE < total,
    openProjects: Number(openProjectsRow?.total ?? 0),
    followButton: doer.id !== null && doer.id !== user.id ? { following: viewerFollows } : null,
    viewerIsAdmin: doer.isAdmin,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The visibility badge (the org-header badge DOM — see the header's
 *  divergence note): limited/private only; a public user renders none. */
function ProfileVisibilityBadge(props: { user: UserProfileRow }) {
  if (props.user.visibility === "limited") {
    return <span class="ui large basic horizontal label">{userProfileLocale.visibility_limited}</span>;
  }
  if (props.user.visibility === "private") {
    return <span class="ui large basic horizontal label">{userProfileLocale.visibility_private}</span>;
  }
  return null;
}

/**
 * shared/user/profile_big_avatar.tmpl reduced: the avatar placeholder circle,
 * the username (+ visibility badge — the divergence note) + the admin gear
 * (:18's `{{if .IsAdmin}}` row, the viewer-side admin flag — absent prop
 * renders none) + display name lines, the followers/following counts as the
 * two tab-page anchors (profile_big_avatar.tmpl:25 — `?tab=followers`
 * carries the 18px octicon-person glyph, the following anchor is bare) with
 * the RSS feed icon (:31-33 — `{{if .EnableFeed}}`; the setting pins TRUE
 * upstream, modules/setting/other.go:21, and the landed `/{owner}.rss` route
 * serves the bytes, so the anchor renders unconditionally), the follow
 * button (:123-136 — `{{if and .IsSigned (ne .SignedUserID
 * .ContextUser.ID)}}`; rendered only when the consumer passes
 * `followButton`, its POST is the landed `POST /{username}?action=…` arm and
 * the no-JS reduction 303s back onto the profile), then the location /
 * website / description / "Joined on" rows. Upstream's block-user link
 * (:139-148) has no landed POST arm — not rendered (the dead-control rule).
 */
export function ProfileAvatarCard(props: {
  user: UserProfileRow;
  followers: number;
  following: number;
  /** The follow button's state — present only for a signed-in viewer who is
   *  not the target (the loaders' gate); absent keeps the prior DOM
   *  (the projectsTab optional-prop convention). */
  followButton?: { following: boolean };
  /** The viewer's site-admin flag (profile_big_avatar.tmpl:18's gear gate);
   *  truthy renders the gear link onto the landed admin user-detail page. */
  viewerIsAdmin?: boolean;
}) {
  const { user } = props;
  return (
    <div id="profile-avatar-card" class="ui fitted segment">
      <div class="flex-divided-list items-px-default muted-links">
        <div class="item flex-text-block tw-justify-center tw-p-5">
          <span class="ui avatar" aria-hidden="true">
            <Icon name="octicon-person" size={100} />
          </span>
        </div>
        <div class="item flex-relaxed-list">
          <span class="tw-text-center">
            {user.username}
            <ProfileVisibilityBadge user={user} />
            {props.viewerIsAdmin ? (
              <a href={`/-/admin/users/${user.id}`} data-tooltip-content={userProfileLocale.admin_details} aria-label={userProfileLocale.admin_details}>
                <AdminEmbeddedSvg name="octicon-gear" size={18} />
              </a>
            ) : null}
          </span>
          {user.fullName !== null && user.fullName !== "" ? (
            <span class="tw-text-center">{user.fullName}</span>
          ) : null}
          <div class="tw-text-center">
            <a href={`/${user.username}?tab=followers`}>
              <Icon name="octicon-person" size={18} class="tw-mr-1" />
              {props.followers} {userProfileLocale.followers}
            </a>{" "}
            ·{" "}
            <a href={`/${user.username}?tab=following`}>
              {props.following} {userProfileLocale.following}
            </a>
            {/* profile_big_avatar.tmpl:31-33 — the RSS feed anchor; the
                EnableFeed setting pins TRUE (modules/setting/other.go:21),
                the /{owner}.rss route is landed. The aria-label pairs the
                tooltip (the icon-only-link rule, the admin-badges twin). */}
            <a href={`/${user.username}.rss`} data-tooltip-content={userProfileLocale.rss_feed} aria-label={userProfileLocale.rss_feed}>
              <i class="ui tw-text-text-light tw-ml-2" data-tooltip-content={userProfileLocale.rss_feed}>
                <Icon name="octicon-rss" size={18} />
              </i>
            </a>
          </div>
          {props.followButton ? (
            <div class="item">
              {/* profile_big_avatar.tmpl:127-134 — upstream's
                  data-fetch POST `?action=follow|unfollow` reduces to the
                  no-JS form POST (the house convention; the route 303s back
                  onto the profile). The button carries `primary` only when
                  NOT following (the Iif arms), octicon-person both ways. */}
              <form method="post" action={`/${user.username}?action=${props.followButton.following ? "unfollow" : "follow"}`}>
                <button type="submit" class={`ui basic ${props.followButton.following ? "" : "primary"} button tw-w-full`}>
                  <Icon name="octicon-person" />{" "}
                  {props.followButton.following ? userProfileLocale.unfollow : userProfileLocale.follow}
                </button>
              </form>
            </div>
          ) : null}
        </div>
        {user.location !== null && user.location !== "" ? (
          <div class="item">
            <Icon name="octicon-location" />
            <span class="tw-flex-1">{user.location}</span>
          </div>
        ) : null}
        {user.website !== null && user.website !== "" ? (
          <div class="item">
            <Icon name="octicon-link" />
            <a target="_blank" rel="me" href={user.website}>
              {user.website}
            </a>
          </div>
        ) : null}
        {user.description !== null && user.description !== "" ? (
          <div class="item">
            <div class="render-content markup">{user.description}</div>
          </div>
        ) : null}
        <div class="item">
          <Icon name="octicon-calendar" />{" "}
          <span>
            {userProfileLocale.joined_on} {formatDueDate(user.createdAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The overview header (user/overview/header.tmpl:12-46 reduced to its live
 *  tabs, in the template's order): Repositories ACTIVE here (header.tmpl:12's
 *  exact `?tab=repositories` href — the tab pages' twins render it
 *  inactive), the Projects anchor (header.tmpl:16-21 — the C1 tab, the
 *  `/{username}/-/projects` page; `octicon-project-symlink` + the
 *  `{{if .ProjectCount}}` label), the Packages anchor (header.tmpl:22-25,
 *  SPEC-0016 M2), the Code anchor (header.tmpl:26-31 — the C1 tab, the
 *  `/{username}/-/code` page; `octicon-code`, active on `IsCodePage`), the
 *  Activity anchor (header.tmpl:33-34), then the Stars anchor
 *  (header.tmpl:36-44) and the watching anchor (header.tmpl:43-46). THE
 *  COLLAPSED-IF: upstream renders Stars and watching as the two arms of
 *  `{{if not .DisableStars}}` — DisableStars defaults FALSE at the pin, so
 *  Stars is the default anchor and watching is direct-URL-only with NOTHING
 *  active. The landed reduction cannot model a setting that does not exist,
 *  so BOTH anchors render here INACTIVE (the repositories tab keeps the
 *  ACTIVE item on this page) — never watching instead of stars.
 *
 * The Projects/Code/Packages tabs ride OrgMenu's optional-prop pattern
 * (projectsTab since wave 37, packagesTab since SPEC-0016 M2; the C1
 * completion adds ProfileTabs' projectsTab + both strips' codeTab): absent
 * keeps the byte-stable prior DOM; present renders INACTIVE unless `active`
 * (the tab's own page passes active). The profile page arms Projects
 * unconditionally (header.tmpl:16's `{{if or .ContextUser.IsIndividual
 * .CanReadProjects}}` — every row on this page IS an individual) and Code
 * unconditionally (header.tmpl:26's `{{if and .IsRepoIndexerEnabled ...}}` —
 * the indexer is live, the /-/code page is landed), each inactive here.
 */
export function ProfileTabs(props: {
  username: string;
  repoCount: number;
  starsCount: number;
  /** Whether the Repositories item is active (header.tmpl:11's
   *  `{{if eq .TabName "repositories"}}` arm) — true on this page (the
   *  default), false on the tab pages whose TabName matches nothing
   *  (the organizations arm). */
  repositoriesActive?: boolean;
  /** The upstream Projects tab (header.tmpl:16-21), present only when the
   *  consumer owns the `/{username}/-/projects` page (the OrgMenu
   *  projectsTab precedent); count = the open-projects total, the
   *  `{{if .ProjectCount}}` label. */
  projectsTab?: { active: boolean; count: number; href: string };
  /** The upstream Packages tab (header.tmpl:22-25), present only when the
   *  consumer owns the `/{username}/-/packages` family. */
  packagesTab?: { active: boolean; href: string };
  /** The upstream Code tab (header.tmpl:26-31), present only when the
   *  consumer owns the `/{username}/-/code` page; no count label upstream. */
  codeTab?: { active: boolean; href: string };
}) {
  return (
    <overflow-menu class="ui secondary pointing tabular borderless menu tw-mb-4">
      <div class="overflow-menu-items">
        <a class={props.repositoriesActive === false ? "item" : "active item"} href={`/${props.username}?tab=repositories`}>
          <Icon name="octicon-repo" /> {userProfileLocale.repositories}
          {props.repoCount > 0 ? <div class="ui small label">{props.repoCount}</div> : null}
        </a>
        {props.projectsTab ? (
          <a class={props.projectsTab.active ? "active item" : "item"} href={props.projectsTab.href}>
            <Icon name="octicon-project-symlink" /> {userProfileLocale.projects}
            {props.projectsTab.count > 0 ? <div class="ui small label">{props.projectsTab.count}</div> : null}
          </a>
        ) : null}
        {props.packagesTab ? (
          <a class={props.packagesTab.active ? "active item" : "item"} href={props.packagesTab.href}>
            <Icon name="octicon-package" /> {userProfileLocale.packages}
          </a>
        ) : null}
        {props.codeTab ? (
          <a class={props.codeTab.active ? "active item" : "item"} href={props.codeTab.href}>
            <Icon name="octicon-code" /> {userProfileLocale.code}
          </a>
        ) : null}
        <a class="item" href={`/${props.username}?tab=activity`}>
          <Icon name="octicon-rss" /> {userProfileLocale.activity}
        </a>
        <a class="item" href={`/${props.username}?tab=stars`}>
          <Icon name="octicon-star" /> {userProfileLocale.starred}
          {props.starsCount > 0 ? <div class="ui small label">{props.starsCount}</div> : null}
        </a>
        <a class="item" href={`/${props.username}?tab=watching`}>
          <EyeIcon /> {userProfileLocale.watched}
        </a>
      </div>
    </overflow-menu>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderUserProfilePage(ctx: UiContext, data: UserProfileData): string {
  return renderPage(<UserProfilePage ctx={ctx} data={data} />);
}

/** The user profile page (§2.4.1 discriminator: `user profile` —
 *  profile.tmpl:2). */
export function UserProfilePage(props: { ctx: UiContext; data: UserProfileData }) {
  const { ctx, data } = props;
  const link = `/${data.user.username}`;
  const userIsPrivateOwner = data.user.visibility === "private";
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
            <ProfileTabs
              username={data.user.username}
              repoCount={data.total}
              starsCount={data.user.numStars}
              projectsTab={{ active: false, count: data.openProjects, href: `/${data.user.username}/-/projects` }}
              packagesTab={
                ctx.packagesEnabled !== false ? { active: false, href: `/${data.user.username}/-/packages` } : undefined
              }
              codeTab={{ active: false, href: `/${data.user.username}/-/code` }}
            />
            {/* shared/repo/list.tmpl: the wrapper renders unconditionally
                (zero repos = an empty list, upstream's own shape — the org
                home's empty-placeholder is home.tmpl's, not this template). */}
            <div class="flex-divided-list items-with-main">
              {data.repos.map((item) => (
                <OrgRepoListItem orgLink={link} item={item} orgPrivate={userIsPrivateOwner} />
              ))}
            </div>
            <OrgHomePagination orgLink={link} page={data.page} more={data.more} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// The ?tab=organizations arm (profile.go:260-278 — the C4 row; the index.ts
// dispatch hunk rides the orchestrator's fold, the mount recipe below)
// ---------------------------------------------------------------------------

/** The organizations tab's render inputs. */
export interface UserProfileOrganizationsData {
  user: UserProfileRow;
  /** One page of the membership cards (the OrgRecord projection — the
   *  landed listUserOrgs read, upstream's org.AsUser() cards). */
  orgs: OrgRecord[];
  /** The DoerViewOtherVisibility ceiling the listing ran at (the loader's
   *  ladder result, surfaced for the header doc/tests). */
  visibilityCeiling: "public" | "limited" | "private";
  followers: number;
  following: number;
  /** The strip's counts (the repositories loader's parity reads). */
  repoCount: number;
  openProjects: number;
  page: number;
  more: boolean;
  /** The avatar card's follow-button input (the repositories loader's
   *  shape — the same template renders on every profile tab). */
  followButton: { following: boolean } | null;
  /** The avatar card's admin gear gate (the viewer's admin flag). */
  viewerIsAdmin: boolean;
}

/**
 * `DoerViewOtherVisibility` (models/organization/org_list.go:79-90) over the
 * landed columns: an anonymous (or private-incapable) doer sees PUBLIC orgs
 * only; the site admin and the user themself see PRIVATE; a restricted doer
 * would see PUBLIC (the arm is unreachable — no users.restricted column);
 * every other signed-in doer sees LIMITED. This is the ceiling the landed
 * `listUserOrgs` `maxVisibility` encodes (the service's own upstream note).
 */
export function orgVisibilityCeiling(doer: ProfileDoer, user: UserProfileRow): "public" | "limited" | "private" {
  if (!doerCanViewPrivate(doer)) return "public";
  if (doer.isAdmin || doer.id === user.id) return "private";
  return "limited";
}

/**
 * Load the organizations tab (profile.go:260-278's case arm over the landed
 * read): `FindAndCount[organization.Organization]{UserID: ContextUser.ID,
 * IncludeVisibility: DoerViewOtherVisibility(Doer, ContextUser),
 * ListOptions{Page, PageSize: RepoPagingNum}}` is exactly
 * `OrgService.listUserOrgs(user.id, { maxVisibility: ceiling, page,
 * pageSize: USER_PROFILE_PAGE_SIZE })` — the cards are the org rows
 * (`org.AsUser()`), the count is the pager's total. The avatar-card and
 * strip counts ride the repositories loader's parity reads (the followers
 * pair's visibility-filtered totals, header.go's loadHeaderCount pair).
 */
export async function loadUserProfileOrganizationsData(
  d1: D1Database,
  user: UserProfileRow,
  doer: ProfileDoer,
  params: URLSearchParams,
): Promise<UserProfileOrganizationsData> {
  const page = parsePageNumber(params.get("page"));
  const visibilityCeiling = orgVisibilityCeiling(doer, user);
  const listing = await new OrgService(d1).listUserOrgs(user.id, {
    maxVisibility: visibilityCeiling,
    page,
    pageSize: USER_PROFILE_PAGE_SIZE,
  });

  const followViewer = { id: doer.id, isAdmin: doer.isAdmin };
  const seePrivate = doer.id !== null && (doer.isAdmin || doer.id === user.id);
  const repoWhere = seePrivate
    ? eq(repositories.ownerId, user.id)
    : and(eq(repositories.ownerId, user.id), eq(repositories.visibility, "public"));
  const [followers, following, repoCountRow, openProjectsRow, viewerFollows] = await Promise.all([
    listFollowers(d1, user.id, followViewer, { page: 1, pageSize: 1 }),
    listFollowing(d1, user.id, followViewer, { page: 1, pageSize: 1 }),
    drizzle(d1).select({ total: sql<number>`count(*)` }).from(repositories).where(repoWhere).get(),
    // The strip's Projects count (the loader's parity read — see
    // loadUserProfileData's note).
    drizzle(d1)
      .select({ total: sql<number>`count(*)` })
      .from(projects)
      .where(and(eq(projects.ownerId, user.id), eq(projects.isClosed, false)))
      .get(),
    // The avatar card is the SAME template on every profile tab
    // (prepareContextForProfileBigAvatar runs for each) — the follow
    // button's gate + state ride along here too.
    doer.id !== null && doer.id !== user.id ? isFollowing(d1, doer.id, user.id) : Promise.resolve(false),
  ]);

  return {
    user,
    orgs: listing.items,
    visibilityCeiling,
    followers: followers.total,
    following: following.total,
    repoCount: Number(repoCountRow?.total ?? 0),
    openProjects: Number(openProjectsRow?.total ?? 0),
    page,
    more: page * USER_PROFILE_PAGE_SIZE < listing.total,
    followButton: doer.id !== null && doer.id !== user.id ? { following: viewerFollows } : null,
    viewerIsAdmin: doer.isAdmin,
  };
}

/**
 * One user_cards.tmpl card row over an ORG record (the FollowCard twin —
 * the template's exact reductions: the placeholder avatar glyph OUTSIDE the
 * anchor (an icon-only link has no accessible name — the avatar-slot rule),
 * the DisplayName link in the `h3.name.flex-text-block`, then the
 * `.meta.flex-text-block` arm chain website → location → joined-on; the
 * `user_type_label` bot badge is unproducible — no bot type).
 */
function ProfileOrgCard(props: { org: OrgRecord }) {
  const card = props.org;
  const homeLink = `/${card.username}`;
  return (
    <li class="item ui segment">
      <span class="ui avatar" aria-hidden="true">
        <Icon name="octicon-organization" size={48} />
      </span>
      <h3 class="name flex-text-block">
        <a href={homeLink}>{orgDisplayName(card)}</a>
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
 * The user_cards container (user_cards.tmpl:2-30 minus the never-set
 * CardsTitle arm — profile.go sets no CardsTitle on this tab) with the
 * base/paginate reduction to the Older/Newer pair carrying
 * `tab=organizations` + `page` (AddParamFromRequest's output shape).
 */
function OrganizationsCardsList(props: { username: string; orgs: OrgRecord[]; page: number; more: boolean }) {
  if (props.page <= 1 && !props.more) {
    return (
      <div class="user-cards" id="user-cards-container" data-fetch-trigger="fetch-reload">
        <ul class="list">
          {props.orgs.map((org) => (
            <ProfileOrgCard org={org} />
          ))}
        </ul>
      </div>
    );
  }
  const href = (page: number): string =>
    page > 1 ? `/${props.username}?tab=organizations&page=${page}` : `/${props.username}?tab=organizations`;
  return (
    <div class="user-cards" id="user-cards-container" data-fetch-trigger="fetch-reload">
      <ul class="list">
        {props.orgs.map((org) => (
          <ProfileOrgCard org={org} />
        ))}
      </ul>
      <div class="center page buttons">
        <div class="ui borderless pagination menu">
          {props.page > 1 ? (
            <a class="item navigation" href={href(props.page - 1)}>
              <span class="navigation_label">Newer</span>
            </a>
          ) : null}
          {props.more ? (
            <a class="item navigation" href={href(props.page + 1)}>
              <span class="navigation_label">Older</span>
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderUserProfileOrganizationsPage(ctx: UiContext, data: UserProfileOrganizationsData): string {
  return renderPage(<UserProfileOrganizationsPage ctx={ctx} data={data} />);
}

/**
 * The profile organizations tab (profile.tmpl's grid + the
 * `tab == "organizations"` branch: §2.4.1 discriminator `user profile`).
 * The strip renders with NO active item (header.tmpl's `eq .TabName`
 * conditions all fail for "organizations" — the follow-tabs twin's exact
 * posture), carrying every live tab; the cards list renders unconditionally
 * (an empty `<ul class="list">` is upstream's own empty state).
 */
export function UserProfileOrganizationsPage(props: { ctx: UiContext; data: UserProfileOrganizationsData }) {
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
            <ProfileTabs
              username={data.user.username}
              repoCount={data.repoCount}
              starsCount={data.user.numStars}
              repositoriesActive={false}
              projectsTab={{ active: false, count: data.openProjects, href: `/${data.user.username}/-/projects` }}
              packagesTab={
                ctx.packagesEnabled !== false ? { active: false, href: `/${data.user.username}/-/packages` } : undefined
              }
              codeTab={{ active: false, href: `/${data.user.username}/-/code` }}
            />
            <OrganizationsCardsList username={data.user.username} orgs={data.orgs} page={data.page} more={data.more} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

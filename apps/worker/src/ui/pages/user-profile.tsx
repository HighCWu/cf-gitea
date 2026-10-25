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
 * - The overview menu (user/overview/header.tmpl) reduces to the single
 *   live tab (Repositories — this page): Overview needs a profile-readme
 *   pipeline, Projects/Packages/Code/Activity/Stars need their pages (dead
 *   links forbidden, §2.4.1). The tab anchors the canonical `/{username}`
 *   (no `?tab=` — one live tab, the OrgMenu shape).
 * - The followers/following counts render as plain text: the landed
 *   follows service supplies the totals (the counts are REAL data), but the
 *   `?tab=followers`/`?tab=following` pages do not exist (profile.tmpl:25's
 *   anchors would be dead links).
 * - The visibility badge next to the username follows the task brief and
 *   the org-header badge DOM (`ui large basic horizontal label`) — upstream
 *   badges org profiles only at this pin (org_profile_avatar.tmpl:9-10); an
 *   intentional divergence, kept discoverable for the visibility ladder.
 * - The email row needs the `ShowUserEmail` profile setting (no such model
 *   — profile_big_avatar.tmpl:60-66) and is not rendered; the admin gear
 *   link (profile_big_avatar.tmpl:18) needs the admin users page — not
 *   rendered; the follow/block buttons are signed-in write actions (§2.5) —
 *   not rendered; the org-avatar row (profile_big_avatar.tmpl:92-105) needs
 *   avatars — not rendered.
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
import { orgMembers, repoSettings, repositories, users } from "../../db/schema";
import { OrgService } from "../../services/orgs/orgs";
import { formatDueDate } from "./milestones";
import { OrgHomePagination, OrgMenu, OrgRepoListItem, type OrgHomeRepoItem } from "./org-home";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/** Page chrome text (component-local, the orgHomeLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const userProfileLocale = {
  joined_on: "Joined on", // "user.joined_on"
  followers: "followers", // "user.followers"
  following: "following", // "user.following"
  visibility_limited: "Limited", // "org.settings.visibility.limited_shortname"
  visibility_private: "Private", // "org.settings.visibility.private_shortname"
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
}

/**
 * Load the page (§3.2 — direct service/Drizzle reads, never a self-fetch):
 * the visible-row listing (the header-comment WHERE), one batched
 * description read for the page's rows (the org-home loader's pattern), and
 * the follower/following totals (the landed follows service, count-only
 * pages — the numbers are real, the tab pages are not).
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
  const [followers, following] = await Promise.all([
    listFollowers(d1, user.id, followViewer, { page: 1, pageSize: 1 }),
    listFollowing(d1, user.id, followViewer, { page: 1, pageSize: 1 }),
  ]);

  return {
    user,
    repos: rows.map((row) => ({ repo: row, description: descriptions.get(row.id) ?? "" })),
    total,
    followers: followers.total,
    following: following.total,
    page,
    more: page * USER_PROFILE_PAGE_SIZE < total,
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
 * the username (+ visibility badge — the divergence note) + display name
 * lines, the plain-text followers/following counts (the tab pages do not
 * exist), then the location / website / description / "Joined on" rows.
 */
export function ProfileAvatarCard(props: { user: UserProfileRow; followers: number; following: number }) {
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
          </span>
          {user.fullName !== null && user.fullName !== "" ? (
            <span class="tw-text-center">{user.fullName}</span>
          ) : null}
          <div class="tw-text-center">
            <span>
              {props.followers} {userProfileLocale.followers}
            </span>{" "}
            ·{" "}
            <span>
              {props.following} {userProfileLocale.following}
            </span>
          </div>
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
            <ProfileAvatarCard user={data.user} followers={data.followers} following={data.following} />
          </div>
          <div class="ui twelve wide column tw-mb-4">
            <OrgMenu orgLink={link} repoCount={data.total} />
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

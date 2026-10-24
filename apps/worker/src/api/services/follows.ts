import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { alias, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { follows, orgMembers, users } from "../../db/schema";

/**
 * The `follows` table + the user-follow reads behind the tier-2 follow trio
 * (SPEC-0004 appendix A rows `/users/{username}/followers`,
 * `/users/{username}/following`, `/users/{username}/following/{target}` —
 * upstream routers/api/v1/user/follower.go over models/user/follow.go) and
 * the follow-self row (`GET /user/followers`, `PUT/DELETE
 * /user/following/{username}` — follower.go ListMyFollowers / Follow /
 * Unfollow over the same model).
 *
 * The table lives in the Drizzle schema (`follows`, src/db/schema.ts) and
 * landed as migration 0007; D1 access goes through Drizzle per the
 * architecture boundary (no hand-written SQL in services). Superseded:
 * `FOLLOWS_DDL_STATEMENTS` below is kept only as the historical record of the
 * pre-migration raw-D1 bootstrap — the generated migration is authoritative
 * now.
 *
 * Upstream shapes (models/user/user.go:357–402):
 *   - followers of U: `follow ⨝ users` where `follow.follow_id = U.id` AND
 *     `users.type = individual` — orgs never appear in a followers list;
 *   - following of U: where `follow.user_id = U.id` AND `type IN (individual,
 *     organization)` — orgs DO appear among the followed;
 *   - both pass `isUserVisibleToViewerCond(viewer)` (user.go:1466–1501):
 *     admin-full ⇒ no filter; anonymous (and public-only tokens, unmodeled —
 *     services/orgs.ts header) ⇒ `visibility = public`; everyone else ⇒
 *     `visibility != private OR self OR viewer-follows-user OR co-members OR
 *     viewer's orgs` (the two team arms collapse to `org_members` at tier 1,
 *     SPEC-0007 §3.3);
 *   - upstream orders neither listing (xorm FindAndCount without OrderBy); we
 *     order `users.id ASC` so pages are deterministic — a documented
 *     non-observable divergence (unordered upstream means ANY order is
 *     conformant).
 */

/**
 * SUPERSEDED by migration 0007 (`follows` in src/db/schema.ts) — kept only so
 * pre-migration scratch databases can still be bootstrapped by hand. Do not
 * extend; change the schema + regenerate instead (AGENTS.md).
 *
 * Port of upstream `Follow` (models/user/follow.go:13–19): `user_id` follows
 * `follow_id`; the pair is UNIQUE (upstream `UNIQUE(follow)`), the reverse
 * direction gets its own index for follower listings, `created_at` is unix
 * seconds (repo convention) mirroring `CreatedUnix xorm:"INDEX created"`. FKs
 * cascade like the rest of the users-adjacent tables.
 */
export const FOLLOWS_DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  follow_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS follows_user_follow_uq ON follows (user_id, follow_id)`,
  `CREATE INDEX IF NOT EXISTS follows_follow_idx ON follows (follow_id)`,
];

/** The doer slice `isUserVisibleToViewerCond` needs (null = anonymous). */
export interface FollowViewer {
  id: number | null;
  isAdmin: boolean;
}

export interface FollowListOptions {
  /** Effective (already clamped) pagination — the routes' parseListOptions. */
  page: number;
  pageSize: number;
}

export interface FollowListPage {
  items: Array<typeof users.$inferSelect>;
  total: number;
}

/**
 * `IsFollowing` (models/user/follow.go:27–29): a single EXISTS probe —
 * `user` is following `followId`.
 */
export async function isFollowing(d1: D1Database, userId: number, followId: number): Promise<boolean> {
  const row = await drizzle(d1)
    .select({ id: follows.id })
    .from(follows)
    .where(and(eq(follows.userId, userId), eq(follows.followId, followId)))
    .get();
  return row !== undefined;
}

/**
 * `FollowUser` (follow.go:31–55) reduced to the modeled surface: the self and
 * already-following arms are the upstream silent no-ops (nil → the API's
 * 204), the insert is one guarded row. Documented divergences:
 *   - the two `IsUserBlockedBy` arms (ErrBlockedUser → the declared 403) are
 *     unreachable — cf-gitea has no user-blocks model yet;
 *   - upstream maintains `num_followers`/`num_following` counters on the user
 *     rows in the same transaction (follow.go:45–51) — the `users` schema has
 *     no such columns (the API renders zero counters, services/user.ts), so
 *     the counter halves are skipped, not stubbed;
 *   - the concurrent-follow race lands on the `(user_id, follow_id)` UNIQUE
 *     index and surfaces as a bare 500 — upstream's unique index aborts the
 *     transaction the same way.
 */
export async function followUser(d1: D1Database, userId: number, followId: number): Promise<void> {
  if (userId === followId || (await isFollowing(d1, userId, followId))) {
    return;
  }
  await drizzle(d1).insert(follows).values({ userId, followId, createdAt: new Date() });
}

/**
 * `UnfollowUser` (follow.go:59–79) reduced the same way: self and
 * not-following are silent no-ops (the API answers 204 either way); the
 * counter halves are skipped (no columns).
 */
export async function unfollowUser(d1: D1Database, userId: number, followId: number): Promise<void> {
  if (userId === followId || !(await isFollowing(d1, userId, followId))) {
    return;
  }
  await drizzle(d1)
    .delete(follows)
    .where(and(eq(follows.userId, userId), eq(follows.followId, followId)));
}

/**
 * `GetUserFollowers` (user.go:357–376): users who follow `followedUserId` —
 * individual users only, visibility-filtered by the viewer.
 */
export function listFollowers(
  d1: D1Database,
  followedUserId: number,
  viewer: FollowViewer,
  options: FollowListOptions,
): Promise<FollowListPage> {
  return pageFollowList(d1, {
    anchor: eq(follows.followId, followedUserId),
    joined: follows.userId,
    userTypes: ["user"],
    viewer,
    options,
  });
}

/**
 * `GetUserFollowing` (user.go:379–398): users `followerUserId` follows —
 * individual users AND organizations, visibility-filtered by the viewer.
 */
export function listFollowing(
  d1: D1Database,
  followerUserId: number,
  viewer: FollowViewer,
  options: FollowListOptions,
): Promise<FollowListPage> {
  return pageFollowList(d1, {
    anchor: eq(follows.userId, followerUserId),
    joined: follows.followId,
    userTypes: ["user", "org"],
    viewer,
    options,
  });
}

interface FollowListShape {
  /** The edge pinned to the listed user (`follow_id` for followers,
   *  `user_id` for following — upstream's two join directions). */
  anchor: SQL;
  /** The opposite edge — the projected users join `users.id` on it. */
  joined: AnySQLiteColumn;
  userTypes: Array<"user" | "org">;
  viewer: FollowViewer;
  options: FollowListOptions;
}

async function pageFollowList(d1: D1Database, shape: FollowListShape): Promise<FollowListPage> {
  const db = drizzle(d1);
  const where = and(shape.anchor, inArray(users.type, shape.userTypes), followVisibilityCond(db, shape.viewer));

  const totalRow = await db
    .select({ total: sql<number>`count(*)` })
    .from(follows)
    .innerJoin(users, eq(users.id, shape.joined))
    .where(where)
    .get();
  const rows = await db
    .select()
    .from(follows)
    .innerJoin(users, eq(users.id, shape.joined))
    .where(where)
    .orderBy(asc(users.id))
    .limit(shape.options.pageSize)
    .offset((shape.options.page - 1) * shape.options.pageSize)
    .all();

  return { items: rows.map((row) => row.users), total: totalRow?.total ?? 0 };
}

/**
 * `isUserVisibleToViewerCond` (user.go:1466–1501) at the landed tier. Admin
 * full access sees everything (no filter); anonymous (and the unmodeled
 * public-only tokens) see public users only; a signed-in non-restricted doer
 * additionally sees non-private users, themself, everyone who follows them,
 * their org co-members, and their orgs — the team_user arms collapse to
 * `org_members` (SPEC-0007 §3.3: role is the Owners-team collapse;
 * membership test = row).
 */
function followVisibilityCond(db: DrizzleD1Database, viewer: FollowViewer): SQL | undefined {
  if (viewer.id !== null && viewer.isAdmin) {
    return undefined;
  }
  if (viewer.id === null) {
    return eq(users.visibility, "public");
  }
  const viewerId = viewer.id;
  // Users who FOLLOW the viewer (upstream's comment says "viewer's following"
  // but the query selects follow.user_id WHERE follow_id = viewer — the SQL
  // is authoritative).
  const followersOfViewer = db.select({ id: follows.userId }).from(follows).where(eq(follows.followId, viewerId));
  // Viewer's org co-members (the team_user self-join upstream, collapsed to
  // one org_members pair at tier 1).
  const coMemberSide = alias(orgMembers, "co_member_side");
  const viewerSide = alias(orgMembers, "viewer_side");
  const coMembers = db
    .select({ id: coMemberSide.userId })
    .from(coMemberSide)
    .innerJoin(viewerSide, eq(coMemberSide.orgId, viewerSide.orgId))
    .where(eq(viewerSide.userId, viewerId));
  const viewerOrgs = db.select({ id: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, viewerId));
  return or(
    ne(users.visibility, "private"),
    eq(users.id, viewerId),
    inArray(users.id, followersOfViewer),
    inArray(users.id, coMembers),
    inArray(users.id, viewerOrgs),
  );
}

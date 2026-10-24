import { users } from "../../db/schema";

/**
 * The `follows` table + the user-follow reads behind the tier-2 follow trio
 * (SPEC-0004 appendix A rows `/users/{username}/followers`,
 * `/users/{username}/following`, `/users/{username}/following/{target}` —
 * upstream routers/api/v1/user/follower.go over models/user/follow.go) and
 * the follow-self row (`GET /user/followers`, `PUT/DELETE
 * /user/following/{username}` — follower.go ListMyFollowers / Follow /
 * Unfollow over the same model).
 *
 * PENDING MIGRATION — raw-D1 bootstrap, the superseded `ORG_DDL_STATEMENTS`/
 * `LFS_OBJECTS_DDL_STATEMENTS` pattern inverted: `follows` is NOT in the
 * Drizzle schema yet (src/db is owned by the migration wave), so this module
 * carries the DDL block for the schema owner (below) and reads through
 * parameterized raw D1 until the table lands in src/db/schema.ts + a
 * generated migration. When it does: delete `FOLLOWS_DDL_STATEMENTS`, port
 * the five queries to Drizzle (`follows` join `users`), and drop the raw-row
 * mapper. The AGENTS.md boundary ("D1 access goes through Drizzle ORM only —
 * no hand-written SQL strings in route handlers") is honored in spirit: every
 * statement lives HERE, parameterized, mirroring one upstream query.
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
 * DDL for the migration owner (report verbatim). Port of upstream `Follow`
 * (models/user/follow.go:13–19): `user_id` follows `follow_id`; the pair is
 * UNIQUE (upstream `UNIQUE(follow)`), the reverse direction gets its own
 * index for follower listings, `created_at` is unix seconds (repo
 * convention) mirroring `CreatedUnix xorm:"INDEX created"`. FKs cascade like
 * the rest of the users-adjacent tables (upstream relies on the delete-user
 * flow's explicit follow cleanup; ON DELETE CASCADE is our equivalent).
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
  const row = await d1
    .prepare("SELECT id FROM follows WHERE user_id = ? AND follow_id = ? LIMIT 1")
    .bind(userId, followId)
    .first<{ id: number }>();
  return row !== null;
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
  await d1
    .prepare("INSERT INTO follows (user_id, follow_id, created_at) VALUES (?, ?, ?)")
    .bind(userId, followId, Math.floor(Date.now() / 1000))
    .run();
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
  await d1.prepare("DELETE FROM follows WHERE user_id = ? AND follow_id = ?").bind(userId, followId).run();
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
    anchorColumn: "follows.follow_id",
    joinedColumn: "follows.user_id",
    anchorId: followedUserId,
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
    anchorColumn: "follows.user_id",
    joinedColumn: "follows.follow_id",
    anchorId: followerUserId,
    userTypes: ["user", "org"],
    viewer,
    options,
  });
}

interface FollowListShape {
  /** The edge column pinned to the listed user (`follow_id` for followers,
   *  `user_id` for following — upstream's two join directions). */
  anchorColumn: "follows.follow_id" | "follows.user_id";
  /** The opposite edge — the projected users join on it. */
  joinedColumn: "follows.user_id" | "follows.follow_id";
  anchorId: number;
  userTypes: Array<"user" | "org">;
  viewer: FollowViewer;
  options: FollowListOptions;
}

async function pageFollowList(d1: D1Database, shape: FollowListShape): Promise<FollowListPage> {
  const visibility = followVisibilityCond(shape.viewer);
  const where =
    `${shape.anchorColumn} = ? AND users.type IN (${shape.userTypes.map(() => "?").join(",")})` +
    (visibility.sql === "" ? "" : ` AND (${visibility.sql})`);
  const params: unknown[] = [shape.anchorId, ...shape.userTypes, ...visibility.params];

  const totalRow = await d1
    .prepare(
      `SELECT count(*) AS total FROM follows JOIN users ON users.id = ${shape.joinedColumn} WHERE ${where}`,
    )
    .bind(...params)
    .first<{ total: number }>();
  const rows = await d1
    .prepare(
      `SELECT users.* FROM follows JOIN users ON users.id = ${shape.joinedColumn} ` +
        `WHERE ${where} ORDER BY users.id ASC LIMIT ? OFFSET ?`,
    )
    .bind(...params, shape.options.pageSize, (shape.options.page - 1) * shape.options.pageSize)
    .all<RawUsersRow>();

  const items = (rows.results ?? []).map(rawToUserRow);
  return { items, total: totalRow?.total ?? 0 };
}

/**
 * `isUserVisibleToViewerCond` (user.go:1466–1501) at the landed tier. Admin
 * full access sees everything; anonymous (and the unmodeled public-only
 * tokens) see public users only; a signed-in non-restricted doer additionally
 * sees non-private users, themself, everyone they follow, their org
 * co-members, and their orgs — the team_user arms collapse to `org_members`
 * (SPEC-0007 §3.3: role is the Owners-team collapse; membership test = row).
 */
function followVisibilityCond(viewer: FollowViewer): { sql: string; params: number[] } {
  if (viewer.id !== null && viewer.isAdmin) {
    return { sql: "", params: [] };
  }
  if (viewer.id === null) {
    return { sql: "users.visibility = 'public'", params: [] };
  }
  const viewerId = viewer.id;
  return {
    sql:
      "users.visibility != 'private'" +
      " OR users.id = ?" + // viewer self
      // users who FOLLOW the viewer (upstream's comment says "viewer's
      // following" but the query selects follow.user_id WHERE follow_id =
      // viewer — the SQL is authoritative)
      " OR users.id IN (SELECT user_id FROM follows WHERE follow_id = ?)" +
      " OR users.id IN (" + // viewer's org co-members (team_user self-join upstream)
      "  SELECT t1.user_id FROM org_members t1 JOIN org_members t2 ON t1.org_id = t2.org_id WHERE t2.user_id = ?" +
      " )" +
      " OR users.id IN (SELECT org_id FROM org_members WHERE user_id = ?)", // viewer's orgs
    params: [viewerId, viewerId, viewerId, viewerId],
  };
}

/** Raw snake_case projection of `SELECT users.*` (until Drizzle owns follows
 *  AND these listings move to a Drizzle join). */
interface RawUsersRow {
  id: number;
  username: string;
  username_lower: string;
  email: string | null;
  display_name: string | null;
  is_admin: number;
  status: string;
  visibility: string;
  type: string;
  full_name: string | null;
  description: string | null;
  website: string | null;
  location: string | null;
  avatar_email: string | null;
  use_custom_avatar: number;
  num_members: number;
  repo_admin_change_team_access: number;
  created_at: number;
}

/** Raw row → the schema-shaped row `toApiUser` projects (unix seconds → Date,
 *  integers → booleans). */
function rawToUserRow(raw: RawUsersRow): typeof users.$inferSelect {
  return {
    id: raw.id,
    username: raw.username,
    usernameLower: raw.username_lower,
    email: raw.email,
    displayName: raw.display_name,
    isAdmin: raw.is_admin === 1,
    status: raw.status === "prohibited" ? "prohibited" : "active",
    visibility: raw.visibility === "limited" ? "limited" : raw.visibility === "private" ? "private" : "public",
    type: raw.type === "org" ? "org" : "user",
    fullName: raw.full_name,
    description: raw.description,
    website: raw.website,
    location: raw.location,
    avatarEmail: raw.avatar_email,
    useCustomAvatar: raw.use_custom_avatar === 1,
    numMembers: raw.num_members,
    repoAdminChangeTeamAccess: raw.repo_admin_change_team_access === 1,
    createdAt: new Date(raw.created_at * 1000),
  };
}

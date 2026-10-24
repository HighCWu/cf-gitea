import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../../db/schema";
import { GO_ZERO_TIME, type Viewer } from "./repository";
import type { User } from "../models/user";

/**
 * User reads backing the tier-1 directory routes (SPEC-0004 §2.4 rows:
 * userGet / userSearch). Mirrors upstream `convert.ToUser`
 * (gitea/services/convert/user.go) reduced to the D1 `users` table; columns
 * that do not exist yet render documented zero/defaults with TODO markers
 * instead of inventing schema.
 */

/** D1 row of the `users` table (src/db/schema.ts). */
type UserRow = typeof users.$inferSelect;

/**
 * D1 row → contract `User`, mirroring `convert.ToUser` (user.go:40–51 +
 * toUser user.go:80–118): `signed` = a token resolved, `authed` = the
 * requester is the user themself or a site admin. Only `authed` viewers get
 * the gated fields (is_admin/active/prohibit_login/last_login/language/
 * login_name/source_id); the primary email shows only to them — upstream
 * falls back to a placeholder address when hidden (user.go:102–105); our
 * landed pattern (services/repository.ts apiUserFromRow) renders "" until
 * the placeholder rule is ported.
 */
export function toApiUser(viewer: Viewer, row: UserRow): User {
  const authed =
    viewer.requester !== null &&
    (viewer.requester.is_admin === true || (viewer.requester.login ?? "").toLowerCase() === row.usernameLower);
  return {
    id: row.id,
    login: row.username,
    type: "User",
    login_name: "", // TODO(SPEC-0005): external authentication sources
    source_id: 0,
    full_name: row.displayName ?? "",
    email: authed ? (row.email ?? "") : "",
    avatar_url: `${viewer.origin}/avatars/${row.usernameLower}`, // TODO(SPEC-0005): avatar storage
    html_url: `${viewer.origin}/${row.username}`,
    language: "", // TODO(SPEC-0005): per-user language column
    is_admin: authed ? row.isAdmin : false,
    last_login: GO_ZERO_TIME, // TODO(SPEC-0005): last-login tracking
    created: row.createdAt.toISOString(),
    restricted: false, // TODO(SPEC-0007): restricted is a visibility concept (orgs)
    active: authed ? row.status === "active" : false,
    prohibit_login: authed ? row.status === "prohibited" : false,
    location: "",
    website: "",
    description: "",
    visibility: "public", // TODO(SPEC-0007): user visibility column
    followers_count: 0, // TODO(SPEC-0005): social counters
    following_count: 0,
    starred_repos_count: 0,
  };
}

export interface UserSearchOptions {
  /** Trimmed `q` — substring match on username_lower. */
  keyword: string;
  /** `uid` — pin the result to the user with this numeric id. */
  uid: number;
  /** Effective (already clamped) pagination. */
  page: number;
  limit: number;
}

/**
 * `GET /users/search` mirroring `user_model.SearchUsers`
 * (gitea/models/user/search.go) reduced to the D1 columns. Documented
 * divergences (all TODO(SPEC-0005/0007)):
 *  - keyword matches username_lower only (upstream also LIKEs full_name and
 *    the primary email behind keep_email_private — no such columns yet);
 *    substring via D1 `instr()`, not LIKE: D1 caps LIKE patterns at 50 bytes
 *    and `%`/`_` in user input would need pattern escaping — a parameterized
 *    instr() has neither problem;
 *  - visibility: every user is public until the visibility column exists
 *    (upstream BuildCanSeeUserCondition, search.go:172–186);
 *  - `uid < 0` selects upstream system users (Ghost/Actions); none exist in
 *    D1, so negative uids match nothing.
 *
 * Order is upstream's SearchOrderByAlphabetically (lower_name ASC).
 */
export async function searchUsers(
  d1: D1Database,
  opts: UserSearchOptions,
): Promise<{ items: UserRow[]; total: number }> {
  const conditions: SQL[] = [];
  if (opts.keyword !== "") {
    conditions.push(sql`instr(${users.usernameLower}, ${opts.keyword.toLowerCase()}) > 0`);
  }
  if (opts.uid > 0) {
    conditions.push(eq(users.id, opts.uid));
  } else if (opts.uid < 0) {
    // Upstream resolves negative uids through GetPossibleUserByID (system
    // users — Ghost/Actions, search.go user.Search:55–61); none exist in D1.
    conditions.push(sql`0 = 1`);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const db = drizzle(d1);

  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(users)
    .where(where);
  const items = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(asc(users.usernameLower))
    .limit(opts.limit)
    .offset((opts.page - 1) * opts.limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

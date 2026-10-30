import { and, asc, eq, ne, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";

import { orgMembers, users } from "../../db/schema";
import type { AuthUser } from "../../auth/auth-context";
import { apiUserFromRow, apiUserFromRowWithCounts, type ApiUserRow, type Viewer } from "./repository";
import { isFollowing } from "./follows";
import type { User } from "../models/user";

/**
 * User reads backing the tier-1 directory routes (SPEC-0004 §2.4 rows:
 * userGet / userSearch). Mirrors upstream `convert.ToUser`
 * (gitea/services/convert/user.go) reduced to the D1 `users` table; columns
 * that do not exist yet render documented zero/defaults with TODO markers
 * instead of inventing schema. This module also owns the user-directory
 * visibility predicates — the row-wise `user_model.IsUserVisibleToViewer`
 * (gitea/models/user/user.go:1504–1545) and the search-side
 * `BuildCanSeeUserCondition` (gitea/models/user/search.go:166–186) — reduced
 * to the landed `users.visibility` column (migration 0031's org-as-user-row
 * batch: SPEC-0007 §3.2). The follow/co-membership arms reuse the exact
 * shapes the SQL twin (`followVisibilityCond`, services/follows.ts) landed,
 * so a profile the listing admits the profile GET admits too.
 */

/** D1 row of the `users` table (src/db/schema.ts). */
type UserRow = typeof users.$inferSelect;

/**
 * The doer slice the user-visibility predicates need. `id: null` = anonymous,
 * or a resolved token identity that carries no D1 id — the degenerate
 * credential the org-side `doerCanViewPrivate` convention also reads as
 * not-private-capable, so the whole ladder treats it as anonymous.
 */
export interface UserVisibilityDoer {
  id: number | null;
  isAdmin: boolean;
  /** Case-folded requester login, null when anonymous (the self arm's second
   *  match shape — see `isSelfRow`). */
  loginLower: string | null;
}

/** Requester → doer slice for the visibility predicates (null when anonymous). */
export function visibilityDoerOf(viewer: Viewer): UserVisibilityDoer {
  return {
    id: viewer.requester?.id ?? null,
    isAdmin: viewer.requester?.is_admin === true,
    loginLower: viewer.requester?.login?.toLowerCase() ?? null,
  };
}

/**
 * The self arm: upstream checks it by NAME when resolving the context user
 * (`strings.EqualFold(doer.LowerName, username)`, services/context/user.go:45)
 * and by ID inside `IsUserVisibleToViewer` (user.go:1508) — the landed token
 * identity may resolve without a D1 id, so either match counts. This MUST
 * agree with the serializers' `authed` arm (login-based, convert.ToUser's
 * `doer.ID == user.ID || doer.IsAdmin` reduced the same way) or a private
 * self-profile would 404 while the serializer would have rendered gated
 * fields.
 */
function isSelfRow(doer: UserVisibilityDoer, row: UserRow): boolean {
  return (
    (doer.id !== null && doer.id === row.id) ||
    (doer.loginLower !== null && doer.loginLower === row.usernameLower)
  );
}

/**
 * The private arm's shared-org probe (user.go:1530–1543): a `team_user` count
 * where `uid = viewer AND (org_id = u OR org_id IN (SELECT org_id FROM
 * team_user WHERE uid = u))` — viewer is a member of the org `u` itself (arm
 * A; only an org row can match, ids never collide across the users table) or
 * of some org that also has `u` among its members (arm B). The team_user
 * pairs collapse to `org_members` (SPEC-0007 §3.3), the same self-join
 * `followVisibilityCond` landed.
 */
async function sharedOrgMembershipExists(d1: D1Database, rowId: number, viewerId: number): Promise<boolean> {
  const viewerSide = alias(orgMembers, "viewer_side");
  const targetSide = alias(orgMembers, "target_side");
  const row = await drizzle(d1)
    .select({ orgId: viewerSide.orgId })
    .from(viewerSide)
    .innerJoin(targetSide, eq(targetSide.orgId, viewerSide.orgId))
    .where(
      and(
        eq(viewerSide.userId, viewerId),
        or(eq(viewerSide.orgId, rowId), eq(targetSide.userId, rowId)),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}

/**
 * `IsUserVisibleToViewer` (gitea/models/user/user.go:1504–1545) reduced to
 * the modeled axes: `DoerTokenAllowsOwner` scopes are unmodeled (always
 * allow), `IsRestricted` has no column yet. Ladder: site admin or the row
 * itself → visible; `public` → always; `limited` → any signed-in doer
 * (user.go:1518–1523); `private` → a signed-in doer the row FOLLOWS
 * (`IsFollowing(u.ID, viewer.ID)`, user.go:1528 — the SQL is authoritative,
 * see follows.ts) or shares an org with. Mirrors the org-side
 * `orgVisibleToDoer` ladder shape (services/org-repos.ts) and the follows
 * listing cond (services/follows.ts), so a private profile is invisible to
 * the same viewers everywhere.
 */
export async function isUserVisibleToViewer(
  d1: D1Database,
  row: UserRow,
  doer: UserVisibilityDoer,
): Promise<boolean> {
  if (doer.isAdmin || isSelfRow(doer, row)) {
    return true;
  }
  switch (row.visibility) {
    case "public":
      return true;
    case "limited":
      return doer.id !== null;
    case "private": {
      if (doer.id === null) {
        return false;
      }
      if (await isFollowing(d1, row.id, doer.id)) {
        return true;
      }
      return sharedOrgMembershipExists(d1, row.id, doer.id);
    }
  }
}

/**
 * `BuildCanSeeUserCondition` (gitea/models/user/search.go:166–186) reduced to
 * the modeled axes — the listing WHERE `searchUsers` ANDs in: admin → no
 * filter; anonymous (and the degenerate id-less identity) → `public` only;
 * a signed-in doer → `visibility != private` (upstream `IN (public, limited)`
 * over the three-value enum) OR the row is the doer themself. Upstream's
 * org-membership arm (`IN (SELECT org_id FROM org_user …)`) admits private
 * ORG rows the actor belongs to — unreachable here because the search pins
 * `type = 'user'` (the Types filter), and org rows never enter the result
 * set.
 */
function canSeeUserCondition(doer: UserVisibilityDoer): SQL {
  if (doer.isAdmin && doer.id !== null) {
    // Upstream `actor != nil && !actor.IsAdmin` skips the whole cond for
    // admins; the id-less corner keeps the anonymous reading.
    return sql`1 = 1`;
  }
  if (doer.id === null) {
    return eq(users.visibility, "public");
  }
  return or(ne(users.visibility, "private"), eq(users.id, doer.id)) as SQL;
}

/**
 * D1 row → contract `User` for the tier-1 directory routes, mirroring
 * `convert.ToUser` (user.go:40–51 + toUser user.go:80–118). The S11 merge:
 * this is a thin delegation to the canonical body (`apiUserFromRow`,
 * services/repository.ts) — one serializer, zero drift between the
 * directory projection and every embedded `User` converter. Only `authed`
 * viewers (the user themself or a site admin) get the gated fields
 * (is_admin/active/prohibit_login/last_login/language/login_name/source_id);
 * the gated columns that do not exist yet render documented zero/defaults
 * with TODO markers instead of inventing schema (`last_login` is landed —
 * the users.last_login_at column, P3-7; language remains the side-store
 * decision TODO(SPEC-0005)).
 *
 * This sync render keeps the query-flat zero-defaults for the follow counts
 * (list callers cannot afford per-row count queries); the single-row GET
 * wiring (`GET /users/{username}`) is the route owner's one-line swap to
 * `toApiUserWithCounts` below — the canonical `apiUserFromRowWithCounts`
 * precedent (repository.ts), same pattern as `toApiRepositoryFull`.
 */
export function toApiUser(viewer: Viewer, row: UserRow): User {
  return apiUserFromRow(row, viewer);
}

/**
 * `toApiUser` with the async follow-count arm resolved
 * (`apiUserFromRowWithCounts`, services/repository.ts): the rendered
 * `followers_count`/`following_count` are the requester-visible totals —
 * the profile page's own numbers (upstream profile.go:118-138 over the
 * GetUserFollowers/GetUserFollowing FindAndCount, models/user/user.go:357-402;
 * upstream's API renders maintained columns we do not have — see
 * `ApiUserFollowCounts`). Single-row GETs only; list routes keep the sync
 * render.
 */
export async function toApiUserWithCounts(d1: D1Database, viewer: Viewer, row: UserRow): Promise<User> {
  return apiUserFromRowWithCounts(d1, row, viewer);
}

/**
 * The auth middlewares' identity conversion (api/auth.ts `identityFrom`): the
 * SPEC-0002 `AuthUser` → contract `User`, rendered through the CANONICAL
 * row-derived converter — the api review's drift 1 fix. `rowToUser`
 * (auth/token-service.ts) maps the row's render-relevant columns onto
 * `AuthUser` WHERE THE ROW IS IN HAND; this adapter rebuilds the
 * `ApiUserRow` slice from them (the `??` arms are reachable only for
 * hand-built AuthUser literals that predate the trio — production identity
 * always carries the row values) and renders with the requester as a
 * SELF-viewer: upstream converts the doer as `ToUser(ctx.Doer, ctx.Doer)`
 * (routers/api/v1/user/userGetCurrent), so the authed arm is always true
 * here and the gated fields (email/is_admin/active/prohibit_login) render
 * the row's real values. The gate reads only `login`/`is_admin` — the same
 * partial-requester slice services/search.ts builds for its Viewer.
 *
 * `origin` is request-scoped (the avatar/html URLs derive from it), which is
 * exactly why the conversion lives in the api middleware layer and not in
 * token-service/resolveAuth.
 */
export function authUserToApiUser(u: AuthUser, origin: string): User {
  const row: ApiUserRow = {
    id: u.id,
    username: u.username,
    usernameLower: u.usernameLower,
    email: u.email,
    displayName: u.displayName,
    type: u.type ?? "user",
    isAdmin: u.isAdmin,
    status: u.status,
    createdAt: u.createdAt,
    location: u.location,
    website: u.website,
    description: u.description,
    visibility: u.visibility ?? "public",
    numStars: u.numStars ?? 0,
    lastLoginAt: u.lastLoginAt ?? null,
  };
  return apiUserFromRow(row, {
    origin,
    requester: { login: u.username, is_admin: u.isAdmin },
  });
}

export interface UserSearchOptions {
  /** Trimmed `q` — substring match on username_lower. */
  keyword: string;
  /** `uid` — pin the result to the user with this numeric id. */
  uid: number;
  /** Effective (already clamped) pagination. */
  page: number;
  limit: number;
  /** The searcher's doer slice — feeds `canSeeUserCondition`. */
  viewer: UserVisibilityDoer;
}

/**
 * `GET /users/search` mirroring `user_model.SearchUsers`
 * (gitea/models/user/search.go) reduced to the D1 columns. Mirrors the
 * upstream handler's option set (routers/api/v1/user/user.go:63–72):
 * `Types: [UserTypeIndividual]` → the landed `type = 'user'` rows only (orgs
 * never answer the directory search), and `BuildCanSeeUserCondition`
 * (`canSeeUserCondition` above) ANDs the viewer's visibility ceiling into
 * count AND page alike. Documented divergences (all TODO(SPEC-0005)):
 *  - keyword matches username_lower only (upstream also LIKEs full_name and
 *    the primary email behind keep_email_private — no such columns yet);
 *    substring via D1 `instr()`, not LIKE: D1 caps LIKE patterns at 50 bytes
 *    and `%`/`_` in user input would need pattern escaping — a parameterized
 *    instr() has neither problem;
 *  - `uid < 0` selects upstream system users (Ghost/Actions); none exist in
 *    D1, so negative uids match nothing.
 *
 * Order is upstream's SearchOrderByAlphabetically (lower_name ASC).
 */
export async function searchUsers(
  d1: D1Database,
  opts: UserSearchOptions,
): Promise<{ items: UserRow[]; total: number }> {
  const conditions: SQL[] = [
    // Types: [UserTypeIndividual] (user.go:66) — org user rows are not
    // directory-search results (upstream UserType 1).
    eq(users.type, "user"),
    canSeeUserCondition(opts.viewer),
  ];
  if (opts.keyword !== "") {
    conditions.push(sql`instr(${users.usernameLower}, ${opts.keyword.toLowerCase()}) > 0`);
  }
  if (opts.uid > 0) {
    // Upstream ANDs the uid pin AFTER the can-see condition (search.go:111–113),
    // so a uid naming an invisible user yields an empty page, not a leak.
    conditions.push(eq(users.id, opts.uid));
  } else if (opts.uid < 0) {
    // Upstream resolves negative uids through GetPossibleUserByID (system
    // users — Ghost/Actions, search.go user.Search:55–61); none exist in D1.
    conditions.push(sql`0 = 1`);
  }
  const where = and(...conditions);
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

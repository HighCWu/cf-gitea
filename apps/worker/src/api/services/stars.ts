import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, stars, users } from "../../db/schema";
import type { RepositoryWithOwner } from "./repository";

/**
 * Repo stars behind the tier-1 star trio + list (SPEC-0004 §2.4 row:
 * `GET /user/starred` userCurrentListStarred and `GET/PUT/DELETE
 * /user/starred/{owner}/{repo}` userCurrentCheckStarring / userCurrentPutStar
 * / userCurrentDeleteStar — upstream routers/api/v1/user/star.go over
 * models/repo/star.go).
 *
 * The table lives in the Drizzle schema (`stars`, src/db/schema.ts) and
 * landed as migration 0008 (the fourth raw-DDL sweep, the 0005/0007
 * supersede pattern); D1 access goes through Drizzle per the architecture
 * boundary (no hand-written SQL in services). Superseded: the bootstrap
 * `STARS_DDL_STATEMENTS` block was deleted with the sweep — the generated
 * migration is authoritative now.
 *
 * Counters (migration 0030's `repositories.num_stars` + 0031's
 * `users.num_stars` — the star.go:45/48/59/62 quartet): both tallies move in
 * the SAME batch as the edge write below, mirroring upstream's single WithTx.
 * Upstream's ClearRepoStars zeroing (star.go:94–104, repo set private) lives
 * below as clearRepoStars.
 */

export interface StarListOptions {
  /** Effective (already clamped) pagination — the routes' parseListOptions. */
  page: number;
  pageSize: number;
}

/**
 * `IsStaring` (models/repo/star.go — upstream's one-probe spelling) — user X
 * has starred repo Y.
 */
export async function isStarring(d1: D1Database, userId: number, repoId: string): Promise<boolean> {
  const row = await drizzle(d1)
    .select({ id: stars.id })
    .from(stars)
    .where(and(eq(stars.userId, userId), eq(stars.repoId, repoId)))
    .limit(1)
    .get();
  return row !== undefined;
}

/**
 * `StarRepo(…, true)` (star.go:29–69) reduced to the modeled surface: the
 * already-starring arm is the upstream silent no-op (nil → the API's 204),
 * the insert is one guarded row — the `stars_user_repo_uq` pair is the
 * idempotence arbiter (ON CONFLICT DO NOTHING). The set-private ClearRepoStars
 * zeroing (star.go:94–104) is clearRepoStars below.
 *
 * Counter maintenance (the migration-0030 `repositories.num_stars` + 0031
 * `users.num_stars` columns): upstream moves BOTH counters and the edge
 * inside ONE WithTx (star.go:42–50 — insert, then the repo bump at :45 and
 * the doer bump at :48, rolling back together). The same shape here is one
 * D1 batch (= one implicit SQLite transaction) of the two counter UPDATEs
 * followed by the guarded INSERT:
 *   - each UPDATE is guarded by the edge's ABSENCE (`NOT EXISTS`), evaluated
 *     before the insert lands — the upstream `if staring { return nil }`
 *     arm (star.go:38–40), made atomic: a repeat PUT's updates see the
 *     surviving edge inside their own serialized batch and move nothing
 *     (a concurrent double-star serializes on the write lock, so exactly
 *     one batch counts);
 *   - ordering UPDATEs→INSERT keeps the whole increments+insert indivisible:
 *     a failed insert rolls the bumps back, like upstream's transaction.
 */
export async function starRepo(d1: D1Database, userId: number, repoId: string, now: Date): Promise<void> {
  const db = drizzle(d1);
  await db.batch([
    db
      .update(repositories)
      .set({ numStars: sql`num_stars + 1` })
      .where(
        and(
          eq(repositories.id, repoId),
          sql`NOT EXISTS (SELECT 1 FROM stars WHERE user_id = ${userId} AND repo_id = ${repoId})`,
        ),
      ),
    db
      .update(users)
      .set({ numStars: sql`num_stars + 1` })
      .where(
        and(
          eq(users.id, userId),
          sql`NOT EXISTS (SELECT 1 FROM stars WHERE user_id = ${userId} AND repo_id = ${repoId})`,
        ),
      ),
    db
      .insert(stars)
      .values({ userId, repoId, createdAt: now })
      .onConflictDoNothing({ target: [stars.userId, stars.repoId] }),
  ]);
}

/**
 * `StarRepo(…, false)` (star.go:51–65) — idempotent unsubscribe. One D1
 * batch, counters first: the decrements are guarded by the edge's EXISTENCE
 * (the upstream `if !staring { return nil }` arm, star.go:52–54 — a repeat
 * DELETE moves nothing), then the row delete lands — upstream's
 * repo decrement (star.go:59) and doer decrement (star.go:62) verbatim. The
 * MAX(…, 0) floor is drift insurance, not semantics: upstream's ±1
 * arithmetic can never cross zero (counters and edge move in one
 * transaction, star.go:56–64), but rows predating the backfills (0030 /
 * 0031) carry 0 beneath pre-existing star edges — un-starring such an edge
 * floors at 0 instead of going negative.
 */
export async function unstarRepo(d1: D1Database, userId: number, repoId: string): Promise<void> {
  const db = drizzle(d1);
  await db.batch([
    db
      .update(repositories)
      .set({ numStars: sql`MAX(num_stars - 1, 0)` })
      .where(
        and(
          eq(repositories.id, repoId),
          sql`EXISTS (SELECT 1 FROM stars WHERE user_id = ${userId} AND repo_id = ${repoId})`,
        ),
      ),
    db
      .update(users)
      .set({ numStars: sql`MAX(num_stars - 1, 0)` })
      .where(
        and(
          eq(users.id, userId),
          sql`EXISTS (SELECT 1 FROM stars WHERE user_id = ${userId} AND repo_id = ${repoId})`,
        ),
      ),
    db.delete(stars).where(and(eq(stars.userId, userId), eq(stars.repoId, repoId))),
  ]);
}

/**
 * `ClearRepoStars` (models/repo/star.go:94-104) — the private-flip zeroing.
 * Upstream calls it from setRepoVisibility's `if private` arm (services/
 * repository/repository.go:176-178: "If repo has become private, we need to
 * ... clear stars and watches"; the same pair arms UpdateRepository at
 * :295-300 and org.go:130-133). Ported statement-for-statement, one D1 batch
 * (= one implicit SQLite transaction) keeping rows + counters indivisible
 * the way the starRepo/unstarRepo batches above do:
 *   1. every starring user loses one `num_stars` (star.go:96-98, the
 *      `UPDATE user SET num_stars=num_stars-1 WHERE id IN (SELECT uid FROM
 *      star WHERE repo_id = ?)`) — the unique (uid, repo_id) pair makes it
 *      exactly one decrement per removed edge; the MAX(…, 0) floor is the
 *      same pre-backfill drift insurance as unstarRepo's, not new semantics;
 *   2. the repo counter is PLAIN-ZEROED, not decremented (star.go:100-102,
 *      `UPDATE repository SET num_stars = 0`), and the raw UPDATE touches no
 *      timestamp — so neither does this one;
 *   3. every star edge is deleted (star.go:104, `db.DeleteBeans(ctx,
 *      Star{RepoID: repoID})`).
 */
export async function clearRepoStars(d1: D1Database, repoId: string): Promise<void> {
  const db = drizzle(d1);
  await db.batch([
    db
      .update(users)
      .set({ numStars: sql`MAX(num_stars - 1, 0)` })
      .where(
        inArray(
          users.id,
          db.select({ uid: stars.userId }).from(stars).where(eq(stars.repoId, repoId)),
        ),
      ),
    db.update(repositories).set({ numStars: 0 }).where(eq(repositories.id, repoId)),
    db.delete(stars).where(eq(stars.repoId, repoId)),
  ]);
}

/**
 * `GetStarredRepos` (models/repo/user_repo.go:34–66) for both starred lists
 * (GET /user/starred and GET /users/{username}/starred): stars ⨝ repositories,
 * upstream's `` `repository`.id `` ordering (our text id sorts numerically via
 * CAST — the listUserRepositories convention), with the IncludePrivate
 * visibility gate collapsed to the landed ACL matrix
 * (services/repository.ts visibilityConditions): a still-accessible private
 * repo is the doer's own (or the doer is an admin); everything else public.
 * Repos whose access was revoked after starring drop out — upstream's
 * AccessibleRepositoryCondition arm (star metadata does not leak).
 *
 * The pagination TOTAL is not computed here: upstream renders the loaded
 * user's RAW counter — `ctx.Doer.NumStars` (star.go:117-118, GET
 * /user/starred) / `ctx.ContextUser.NumStars` (star.go:85-86, GET
 * /users/{username}/starred) — for BOTH the Link and X-Total-Count headers,
 * so the route renders the user row it already resolved (`users.num_stars`,
 * migration 0031 — kept in step by the star/unstar batches, the block
 * cascade, the private-clear and the repo-delete decrement). The body stays
 * visibility-filtered exactly like upstream's.
 */
export async function listStarredRepositories(
  d1: D1Database,
  userId: number,
  options: { doerLoginLower: string; isAdmin: boolean } & StarListOptions,
): Promise<RepositoryWithOwner[]> {
  const db = drizzle(d1);
  // Same predicate as visibilityConditions(viewer, includePrivate=true) for a
  // signed-in non-admin doer; the admin arm drops the filter entirely.
  const where = options.isAdmin
    ? eq(stars.userId, userId)
    : and(
        eq(stars.userId, userId),
        or(eq(repositories.visibility, "public"), eq(repositories.ownerNamespace, options.doerLoginLower)),
      );

  const rows = await db
    .select({ repo: repositories, owner: users })
    .from(stars)
    .innerJoin(repositories, eq(repositories.id, stars.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .where(where)
    .orderBy(sql`CAST(${repositories.id} AS INTEGER) ASC`)
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize);
  return rows;
}

/**
 * The profile STARS tab's loader (`GET /{username}?tab=stars`,
 * routers/web/user/profile.go:191-219's `case "stars"`): upstream
 * `SearchRepository{StarredByID: ctx.ContextUser.ID, Collaborate:
 * optional.Some(false), Private: ctx.IsSigned, Actor: ctx.Doer}` collapsed
 * to the doer-visible TWO-ARM WHERE the repositories tab's page loader uses
 * (pages/user-profile.tsx loadUserProfileData) — the caller passes
 * `seePrivate` computed exactly that way: the profile user themself or a
 * site admin sees every starred row, everyone else `visibility = 'public'`
 * rows only.
 *
 * Upstream's arms, for the record (models/repo/repo_list.go:365-398): an
 * anonymous doer is public-only (`SearchRepositoryCondition` forces
 * `Private = false`); a signed-in NON-ADMIN stranger would additionally see
 * private starred rows they hold unit/team access to
 * (AccessibleRepositoryCondition's collaborator/team arms,
 * repo_list.go:660-702), and upstream's public arm also excludes repos
 * under limited/private-visibility owners (repo_list.go:383-389). The
 * landed collapse keeps the two-arm shape (§3.2 — the loadUserProfileData /
 * listUserRepositories convention; both divergences documented there).
 * `Collaborate: Some(false)` is a no-op under the collapse: the stars join
 * is repo-scoped and no org collaboration rows exist in the landed model.
 *
 * Order is `slug ASC` (the repositories-tab convention) — upstream sorts by
 * the explore default (`OrderByFlatMap[sort]` → recentupdate,
 * profile.go:118-124); the landed order wins (§3.2, the org-home note). The
 * keyword/sort/archived/fork filters of the search are not landed (the
 * profile page renders no search box — the org-home reduction). Rows carry
 * the OWNER's visibility: `ShowRepoOwnerOnList` rows can belong to anyone,
 * so the list.tmpl internal badge (`{{if .Owner.Visibility.IsPrivate}}`)
 * is per-row here, not the page owner's.
 */
export interface StarredByUserItem {
  repo: typeof repositories.$inferSelect;
  /** The owning user's visibility — the list.tmpl internal-badge arm. */
  ownerVisibility: "public" | "limited" | "private";
}

export async function listReposStarredByUser(
  d1: D1Database,
  userId: number,
  options: { seePrivate: boolean } & StarListOptions,
): Promise<{ items: StarredByUserItem[]; total: number }> {
  const db = drizzle(d1);
  const where = options.seePrivate
    ? eq(stars.userId, userId)
    : and(eq(stars.userId, userId), eq(repositories.visibility, "public"));
  const totalRow = await db
    .select({ total: sql<number>`count(*)` })
    .from(stars)
    .innerJoin(repositories, eq(repositories.id, stars.repoId))
    .where(where)
    .get();
  const items = await db
    .select({ repo: repositories, ownerVisibility: users.visibility })
    .from(stars)
    .innerJoin(repositories, eq(repositories.id, stars.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .where(where)
    .orderBy(asc(repositories.slug))
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize);
  return { items, total: totalRow?.total ?? 0 };
}

/** Repo-scoped star delete (the api repoDelete path's housekeeping; the
 *  deleteRepository cascade covers the same rows through the schema table). */
export async function deleteRepoStars(d1: D1Database, repoId: string): Promise<void> {
  await drizzle(d1).delete(stars).where(eq(stars.repoId, repoId));
}

/** Star count of one user — the live-count read beside the MAINTAINED
 *  `users.num_stars` column (migration 0031; the payload renders the column,
 *  the way upstream renders `User.NumStars`); kept next to its store like
 *  countRepoWatchers (an integrity probe, not a route read today). */
export async function countUserStars(d1: D1Database, userId: number): Promise<number> {
  const row = await drizzle(d1)
    .select({ n: sql<number>`count(*)` })
    .from(stars)
    .where(eq(stars.userId, userId))
    .get();
  return row?.n ?? 0;
}

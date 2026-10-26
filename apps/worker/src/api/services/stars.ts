import { and, eq, or, sql } from "drizzle-orm";
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
 * Residual gap: upstream ALSO maintains the per-USER `user.num_stars` twin
 * (star.go:48/62) — the users table carries no such column (documented in
 * src/db/schema.ts); the per-REPO `repositories.num_stars` half IS modeled
 * (migration 0030) and maintained below. countUserStars below is the ready
 * read for a `starred_repos_count` projection.
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
 * idempotence arbiter (ON CONFLICT DO NOTHING). Documented divergences:
 *   - the per-USER `user.num_stars` counter (star.go:48) is unreachable —
 *     no such column (see the header);
 *   - the `ClearRepoStars` zeroing (star.go:94–104, repo set private) is the
 *     repos wave's seam.
 *
 * Counter maintenance (the migration-0030 `repositories.num_stars` column):
 * upstream moves the counter and the edge inside ONE WithTx (star.go:42–50
 * — insert, then `num_stars = num_stars + 1`, rolling back together). The
 * same shape here is one D1 batch (= one implicit SQLite transaction) of a
 * counter UPDATE followed by the guarded INSERT:
 *   - the UPDATE is guarded by the edge's ABSENCE (`NOT EXISTS`), evaluated
 *     before the insert lands — the upstream `if staring { return nil }`
 *     arm (star.go:38–40), made atomic: a repeat PUT's update sees the
 *     surviving edge inside its own serialized batch and moves nothing
 *     (a concurrent double-star serializes on the write lock, so exactly
 *     one batch counts);
 *   - ordering UPDATE→INSERT keeps the whole increment+insert indivisible:
 *     a failed insert rolls the bump back, like upstream's transaction.
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
      .insert(stars)
      .values({ userId, repoId, createdAt: now })
      .onConflictDoNothing({ target: [stars.userId, stars.repoId] }),
  ]);
}

/**
 * `StarRepo(…, false)` (star.go:51–65) — idempotent unsubscribe. One D1
 * batch, counter first: the decrement is guarded by the edge's EXISTENCE
 * (the upstream `if !staring { return nil }` arm, star.go:52–54 — a repeat
 * DELETE moves nothing), then the row delete lands. The MAX(…, 0) floor is
 * drift insurance, not semantics: upstream's ±1 arithmetic can never cross
 * zero (counter and edge move in one transaction, star.go:56–64), but rows
 * predating migration 0030 were backfilled to 0 beneath pre-existing star
 * edges — un-starring such an edge floors at 0 instead of going negative.
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
    db.delete(stars).where(and(eq(stars.userId, userId), eq(stars.repoId, repoId))),
  ]);
}

/**
 * `GetStarredRepos` (models/repo/user_repo.go:34–66) for the doer-self list:
 * stars ⨝ repositories, upstream's `` `repository`.id `` ordering (our text id
 * sorts numerically via CAST — the listUserRepositories convention), with the
 * IncludePrivate visibility gate collapsed to the landed ACL matrix
 * (services/repository.ts visibilityConditions): a still-accessible private
 * repo is the doer's own (or the doer is an admin); everything else public.
 * Repos whose access was revoked after starring drop out — upstream's
 * AccessibleRepositoryCondition arm (star metadata does not leak).
 *
 * The total is the FILTERED count. Upstream sets the pagination headers from
 * `ctx.Doer.NumStars` — the RAW counter, so upstream's total can exceed the
 * listed page after an access revocation; cf-gitea has no counter column, and
 * the filtered count is the only honest number (documented divergence,
 * observable only in the revoked-access edge).
 */
export async function listStarredRepositories(
  d1: D1Database,
  userId: number,
  options: { doerLoginLower: string; isAdmin: boolean } & StarListOptions,
): Promise<{ items: RepositoryWithOwner[]; total: number }> {
  const db = drizzle(d1);
  // Same predicate as visibilityConditions(viewer, includePrivate=true) for a
  // signed-in non-admin doer; the admin arm drops the filter entirely.
  const where = options.isAdmin
    ? eq(stars.userId, userId)
    : and(
        eq(stars.userId, userId),
        or(eq(repositories.visibility, "public"), eq(repositories.ownerNamespace, options.doerLoginLower)),
      );

  const totalRow = await db
    .select({ total: sql<number>`count(*)` })
    .from(stars)
    .innerJoin(repositories, eq(repositories.id, stars.repoId))
    .where(where)
    .get();
  const items = await db
    .select({ repo: repositories, owner: users })
    .from(stars)
    .innerJoin(repositories, eq(repositories.id, stars.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .where(where)
    .orderBy(sql`CAST(${repositories.id} AS INTEGER) ASC`)
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize);
  return { items, total: totalRow?.total ?? 0 };
}

/** Repo-scoped star delete (the api repoDelete path's housekeeping; the
 *  deleteRepository cascade covers the same rows through the schema table). */
export async function deleteRepoStars(d1: D1Database, repoId: string): Promise<void> {
  await drizzle(d1).delete(stars).where(eq(stars.repoId, repoId));
}

/** Star count of one user — the future `User.starred_repos_count` read
 *  (upstream `NumStars`); unused by the routes today (the projection renders
 *  the documented zero), kept next to its store like countRepoWatchers. */
export async function countUserStars(d1: D1Database, userId: number): Promise<number> {
  const row = await drizzle(d1)
    .select({ n: sql<number>`count(*)` })
    .from(stars)
    .where(eq(stars.userId, userId))
    .get();
  return row?.n ?? 0;
}

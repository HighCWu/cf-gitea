import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, users } from "../../db/schema";
import type { RepositoryWithOwner } from "./repository";

/**
 * Repo stars behind the tier-1 star trio + list (SPEC-0004 §2.4 row:
 * `GET /user/starred` userCurrentListStarred and `GET/PUT/DELETE
 * /user/starred/{owner}/{repo}` userCurrentCheckStarring / userCurrentPutStar
 * / userCurrentDeleteStar — upstream routers/api/v1/user/star.go over
 * models/repo/star.go).
 *
 * PENDING MIGRATION — raw-D1 bootstrap, the superseded `FOLLOWS_DDL_STATEMENTS`
 * pattern inverted (services/follows.ts): `stars` is NOT in the Drizzle schema
 * yet (src/db is owned by the migration wave), so this module carries the DDL
 * block for the schema owner (below) and reads through parameterized raw D1
 * until the table lands in src/db/schema.ts + a generated migration. When it
 * does: delete `STARS_DDL_STATEMENTS`, port the queries to Drizzle (`stars`
 * join `repositories`), and drop the raw projections. The AGENTS.md boundary
 * ("D1 access goes through Drizzle ORM only") is honored in spirit: every
 * statement lives HERE, parameterized, mirroring one upstream query.
 *
 * SWEEP NOTES for the migration owner (the repo_watchers precedent):
 *   - add the table to the `repositories` delete cascade
 *     (src/repos/service.ts deleteRepository) AND to the api repoDelete
 *     housekeeping (routes/repo.ts — deleteRepoStars is ready below);
 *   - `Repository.stars_count` (services/repository.ts) still renders the
 *     TODO zero — flip it to a stars count with the sweep if wanted.
 */

/**
 * DDL for the migration owner (report verbatim). Port of upstream `Star`
 * (models/repo/star.go:17–22): `UNIQUE(uid, repo_id)` is the idempotence
 * arbitration point, the reverse index serves repo-side counts and the delete
 * cascade, `created_at` is unix seconds (repo convention) mirroring
 * `CreatedUnix xorm:"INDEX created"`. FKs cascade like the users-adjacent
 * tables; `repo_id` is the registry's TEXT id (no FK — plain column per the
 * schema conventions for repositories-adjacent rows).
 */
export const STARS_DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS stars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS stars_user_repo_uq ON stars (user_id, repo_id)`,
  `CREATE INDEX IF NOT EXISTS stars_repo_idx ON stars (repo_id)`,
];

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
  const row = await d1
    .prepare("SELECT id FROM stars WHERE user_id = ?1 AND repo_id = ?2 LIMIT 1")
    .bind(userId, repoId)
    .first<{ id: number }>();
  return row !== null;
}

/**
 * `StarRepo(…, true)` (star.go:29–50) reduced to the modeled surface: the
 * already-starring arm is the upstream silent no-op (nil → the API's 204), the
 * insert is one guarded row. Documented divergences:
 *   - the `IsUserBlockedBy` arm (ErrBlockedUser → the declared 403) is
 *     unreachable — cf-gitea has no user-blocks model yet;
 *   - upstream maintains `repository.num_stars` + `user.num_stars` counters in
 *     the same transaction (star.go:45–50) — no such columns exist (the API
 *     renders zero counters, services/repository.ts), so the counter halves
 *     are skipped, not stubbed.
 */
export async function starRepo(d1: D1Database, userId: number, repoId: string, now: Date): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO stars (user_id, repo_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (user_id, repo_id) DO NOTHING",
    )
    .bind(userId, repoId, Math.floor(now.getTime() / 1000))
    .run();
}

/**
 * `StarRepo(…, false)` — idempotent unsubscribe; the counter halves are
 * skipped (no columns).
 */
export async function unstarRepo(d1: D1Database, userId: number, repoId: string): Promise<void> {
  await d1.prepare("DELETE FROM stars WHERE user_id = ?1 AND repo_id = ?2").bind(userId, repoId).run();
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
  // Same predicate as visibilityConditions(viewer, includePrivate=true) for a
  // signed-in non-admin doer; the admin arm drops the filter entirely.
  const visibility = options.isAdmin
    ? { sql: "", params: [] as unknown[] }
    : {
        sql: "(repositories.visibility = 'public' OR repositories.owner_namespace = ?)",
        params: [options.doerLoginLower] as unknown[],
      };
  const where =
    "stars.user_id = ?1" + (visibility.sql === "" ? "" : ` AND ${visibility.sql}`);
  const params: unknown[] = [userId, ...visibility.params];

  const totalRow = await d1
    .prepare(`SELECT count(*) AS total FROM stars JOIN repositories ON repositories.id = stars.repo_id WHERE ${where}`)
    .bind(...params)
    .first<{ total: number }>();
  const idRows = await d1
    .prepare(
      `SELECT stars.repo_id AS repo_id FROM stars JOIN repositories ON repositories.id = stars.repo_id ` +
        `WHERE ${where} ORDER BY CAST(repositories.id AS INTEGER) ASC LIMIT ? OFFSET ?`,
    )
    .bind(...params, options.pageSize, (options.page - 1) * options.pageSize)
    .all<{ repo_id: string }>();
  const ids = (idRows.results ?? []).map((row) => row.repo_id);
  if (ids.length === 0) {
    return { items: [], total: totalRow?.total ?? 0 };
  }
  // Hydrate repo + owner rows through Drizzle (the listOrgRepositories shape).
  const rows = await drizzle(d1)
    .select({ repo: repositories, owner: users })
    .from(repositories)
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .where(inArray(repositories.id, ids))
    .all();
  const byId = new Map(rows.map((row) => [row.repo.id, row]));
  const items: RepositoryWithOwner[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row !== undefined) items.push(row);
  }
  return { items, total: totalRow?.total ?? 0 };
}

/** Repo-scoped star delete (the api repoDelete path's housekeeping — see the
 *  sweep notes above; the deleteRepository cascade covers it with the sweep). */
export async function deleteRepoStars(d1: D1Database, repoId: string): Promise<void> {
  await d1.prepare("DELETE FROM stars WHERE repo_id = ?1").bind(repoId).run();
}

/** Star count of one user — the future `User.starred_repos_count` read
 *  (upstream `NumStars`); unused by the routes today (the projection renders
 *  the documented zero), kept next to its store like countRepoWatchers. */
export async function countUserStars(d1: D1Database, userId: number): Promise<number> {
  const row = await d1
    .prepare("SELECT COUNT(*) AS n FROM stars WHERE user_id = ?1")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Repo watch state (SPEC-0004 §2.4 row: `GET/PUT/DELETE
 * /repos/{owner}/{repo}/subscription`) — upstream `repo_watcher`
 * (models/repo/watch.go) reduced to the one edge the API reads: does user X
 * watch repo Y.
 *
 * The table lives in the Drizzle schema (`repoWatchers`, src/db/schema.ts)
 * and landed as migration 0007; D1 access goes through Drizzle per the
 * architecture boundary (no hand-written SQL in services). Superseded:
 * `REPO_WATCHERS_DDL_STATEMENTS` below is kept only as the historical record
 * of the pre-migration bootstrap (the batch-7 schema gap) — the generated
 * migration is authoritative now.
 *
 * Deliberately NOT the `issue_subscriptions` table: that one keys on issue
 * ids with its own unique index; overloading it for repo-level watch rows
 * would need a negative-id sentinel and would couple two features' cleanup
 * paths. Upstream keeps them separate too (`issue_watch` vs the
 * `watch`/`repo_watcher` table).
 *
 * Semantics mirrored (routers/api/v1/user/watch.go): watch/unwatch are
 * idempotent upsert/deletes (`WatchRepo` + `WatchRepoAuto`), `ignored` is
 * always false (the ignore mode is a user-notification setting, tier 2), and
 * `WatchInfo.created_at` renders the REPOSITORY's created timestamp (upstream
 * `ctx.Repo.Repository.CreatedUnix`), not the watch row's.
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, repoWatchers } from "../../db/schema";

/**
 * SUPERSEDED by migration 0007 (`repoWatchers` in src/db/schema.ts) — kept
 * only so pre-migration scratch databases can still be bootstrapped by hand.
 * Do not extend; change the schema + regenerate instead (AGENTS.md).
 */
export const REPO_WATCHERS_DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS repo_watchers (
  repo_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at INTEGER,
  PRIMARY KEY (repo_id, user_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_repo_watchers_user
  ON repo_watchers (user_id)`,
];

/** `IsWatchingRepo` (models/repo/watch.go) — the GET/PUT answer. */
export async function isWatchingRepo(d1: D1Database, repoId: string, userId: number): Promise<boolean> {
  const row = await drizzle(d1)
    .select({ one: sql<number>`1` })
    .from(repoWatchers)
    .where(and(eq(repoWatchers.repoId, repoId), eq(repoWatchers.userId, userId)))
    .get();
  return row !== undefined;
}

/**
 * `WatchRepoAuto(…, doWatch=true)` → `watchRepoByMode(Normal)` — idempotent
 * subscribe (upsert; SQLite's INSERT ... DO NOTHING keeps the FIRST
 * created_at on repeat watches).
 *
 * Counter maintenance (the migration-0030 `repositories.num_watches`
 * column): upstream bumps `num_watches` inside the same transaction as the
 * edge write, ONLY when watching-ness flips (watch.go:130-134's
 * repoWatchDelta + watch.go:153's `num_watches = num_watches + ?` — a
 * repeat watch never moves the column). The same shape here is one D1 batch
 * (= one implicit SQLite transaction): the increment is guarded by the
 * edge's ABSENCE, evaluated before the insert lands (watch.go:121-123's
 * "don't auto watch if already watching" arm, made atomic — a concurrent
 * double-watch serializes on the write lock so exactly one batch counts),
 * then the guarded INSERT. Ordering UPDATE→INSERT keeps bump+insert
 * indivisible, like upstream's WithTx.
 */
export async function watchRepo(d1: D1Database, repoId: string, userId: number, now: Date): Promise<void> {
  const db = drizzle(d1);
  await db.batch([
    db
      .update(repositories)
      .set({ numWatches: sql`num_watches + 1` })
      .where(
        and(
          eq(repositories.id, repoId),
          sql`NOT EXISTS (SELECT 1 FROM repo_watchers WHERE repo_id = ${repoId} AND user_id = ${userId})`,
        ),
      ),
    db
      .insert(repoWatchers)
      .values({ repoId, userId, createdAt: now })
      .onConflictDoNothing({ target: [repoWatchers.repoId, repoWatchers.userId] }),
  ]);
}

/**
 * `WatchRepoAuto(…, doWatch=false)` → `watchRepoByMode(None/Dont)` —
 * idempotent unsubscribe (absent row = fine). One D1 batch, counter first:
 * the decrement is guarded by the edge's EXISTENCE (upstream's
 * repoWatchDelta = -1 only when watching-ness flips, watch.go:130-134 — a
 * repeat unwatch moves nothing), then the row delete lands. The MAX(…, 0)
 * floor is drift insurance, not semantics: upstream's delta arithmetic can
 * never cross zero (delta and edge move in one transaction), but rows
 * predating migration 0030 were backfilled to 0 beneath pre-existing watch
 * edges — un-watching such an edge floors at 0 instead of going negative.
 */
export async function unwatchRepo(d1: D1Database, repoId: string, userId: number): Promise<void> {
  const db = drizzle(d1);
  await db.batch([
    db
      .update(repositories)
      .set({ numWatches: sql`MAX(num_watches - 1, 0)` })
      .where(
        and(
          eq(repositories.id, repoId),
          sql`EXISTS (SELECT 1 FROM repo_watchers WHERE repo_id = ${repoId} AND user_id = ${userId})`,
        ),
      ),
    db.delete(repoWatchers).where(and(eq(repoWatchers.repoId, repoId), eq(repoWatchers.userId, userId))),
  ]);
}

/** Watcher EDGE count (a live COUNT over `repo_watchers` — the drift probe
 *  next to the maintained `repositories.num_watches` column, which is what
 *  `Repository.watchers_count` renders). */
export async function countRepoWatchers(d1: D1Database, repoId: string): Promise<number> {
  const row = await drizzle(d1)
    .select({ n: sql<number>`count(*)` })
    .from(repoWatchers)
    .where(eq(repoWatchers.repoId, repoId))
    .get();
  return row?.n ?? 0;
}

/** Repo-scoped watch delete (the api repoDelete path's housekeeping; the
 *  deleteRepository cascade covers the same rows through the schema table). */
export async function deleteRepoWatchers(d1: D1Database, repoId: string): Promise<void> {
  await drizzle(d1).delete(repoWatchers).where(eq(repoWatchers.repoId, repoId));
}

/**
 * Repo watch state (SPEC-0004 §2.4 row: `GET/PUT/DELETE
 * /repos/{owner}/{repo}/subscription`) — upstream `repo_watcher`
 * (models/repo/watch.go) reduced to the one edge the API reads: does user X
 * watch repo Y.
 *
 * SCHEMA GAP (the raw-D1 + DDL-comment pattern of SPEC-0006's LFS
 * bootstrap): `src/db/schema.ts` is owned by a parallel change this batch and
 * migrations must not be hand-edited, so watch state lives OUTSIDE the
 * Drizzle schema for now, accessed with prepared statements from this mapper
 * (never in routes). DDL for the migration owner's sweep is
 * `REPO_WATCHERS_DDL_STATEMENTS`; the sweep also adds the table to the
 * `repositories` delete cascade (src/repos/service.ts deleteRepository) and
 * to the api repoDelete housekeeping (deleteRepoWatchers).
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

/**
 * Pre-migration bootstrap DDL (superseded by the schema entry the migration
 * owner lands; kept exactly like `LFS_OBJECTS_DDL_STATEMENTS`).
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
  const row = await d1
    .prepare("SELECT 1 AS one FROM repo_watchers WHERE repo_id = ?1 AND user_id = ?2")
    .bind(repoId, userId)
    .first<{ one: number }>();
  return row !== null;
}

/** `WatchRepo(…, true)` — idempotent subscribe (upsert; SQLite's INSERT ...
 *  DO NOTHING keeps the FIRST created_at on repeat watches). */
export async function watchRepo(d1: D1Database, repoId: string, userId: number, now: Date): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO repo_watchers (repo_id, user_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (repo_id, user_id) DO NOTHING",
    )
    .bind(repoId, userId, Math.floor(now.getTime() / 1000))
    .run();
}

/** `WatchRepo(…, false)` — idempotent unsubscribe (absent row = fine). */
export async function unwatchRepo(d1: D1Database, repoId: string, userId: number): Promise<void> {
  await d1.prepare("DELETE FROM repo_watchers WHERE repo_id = ?1 AND user_id = ?2").bind(repoId, userId).run();
}

/** Watcher count — the future `Repository.watchers_count` counter read. */
export async function countRepoWatchers(d1: D1Database, repoId: string): Promise<number> {
  const row = await d1
    .prepare("SELECT COUNT(*) AS n FROM repo_watchers WHERE repo_id = ?1")
    .bind(repoId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Repo-scoped watch delete (the api repoDelete path's housekeeping). */
export async function deleteRepoWatchers(d1: D1Database, repoId: string): Promise<void> {
  await d1.prepare("DELETE FROM repo_watchers WHERE repo_id = ?1").bind(repoId).run();
}

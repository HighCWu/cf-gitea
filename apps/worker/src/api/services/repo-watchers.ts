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

import { repoWatchers } from "../../db/schema";

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

/** `WatchRepo(…, true)` — idempotent subscribe (upsert; SQLite's INSERT ...
 *  DO NOTHING keeps the FIRST created_at on repeat watches). */
export async function watchRepo(d1: D1Database, repoId: string, userId: number, now: Date): Promise<void> {
  await drizzle(d1)
    .insert(repoWatchers)
    .values({ repoId, userId, createdAt: now })
    .onConflictDoNothing({ target: [repoWatchers.repoId, repoWatchers.userId] });
}

/** `WatchRepo(…, false)` — idempotent unsubscribe (absent row = fine). */
export async function unwatchRepo(d1: D1Database, repoId: string, userId: number): Promise<void> {
  await drizzle(d1)
    .delete(repoWatchers)
    .where(and(eq(repoWatchers.repoId, repoId), eq(repoWatchers.userId, userId)));
}

/** Watcher count — the future `Repository.watchers_count` counter read. */
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

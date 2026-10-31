/**
 * Repo watch state + MODES (SPEC-0004 §2.4 row: `GET/PUT/DELETE
 * /repos/{owner}/{repo}/subscription`) — upstream `watch`
 * (models/repo/watch.go) over the Drizzle `repoWatchers` table (src/db/
 * schema.ts; landed as migration 0007, the mode columns as migration 0053).
 *
 * The mode model (watch.go:17-27) — None=0 watch-nothing-unless-mentioned,
 * Normal=1 proactively watching, Dont=2 ignore the repo, Auto=3 from
 * AutoWatchOnChanges, Custom=4 the picked events only — is carried on the
 * `mode` + `include_{pull_requests,issues,releases}` columns (watch.go:43-49,
 * Custom IS live at the pin with that per-type granularity). Mode None is
 * never persisted: watchRepoByMode DELETEs the row on the None transition
 * (watch.go:149-151), so an absent row IS None through the GetWatch dummy
 * (watch.go:62-67, "the dummy record must mirror the column defaults").
 *
 * Transitions ported (all through `watchRepoByMode`, watch.go:114-156):
 *   - same mode → no-op (:118-120); Auto only fires from None (:121-124);
 *   - starting to watch resets the include flags so a custom selection
 *     survives plain watch/unwatch cycles (:136-138);
 *   - insert on the first-ever mode set, update otherwise, delete on None
 *     (:141-151); `num_watches` moves only when watching-ness flips
 *     (:128-134, :152-154) — the same guarded-counter D1 batch the
 *     pre-mode port used, now guarding on watching-ness (mode NOT IN
 *     (None, Dont)) instead of row existence.
 * The API arms route through `watchRepo`/`unwatchRepo`, the `WatchRepoAuto`
 * bodies (watch.go:159-178) minus the blocked-user probe that lives in the
 * route handler: watch keeps a Custom selection (:173-175), unwatch lands an
 * Auto watch on Dont (:164-165) and everything else on None (:167).
 * `watchRepoWithOptions` (:189-206, the WatchOptions setter the web watch
 * menu calls) lands for the store tier; its ROUTES (POST /action/watch and
 * /action/watch/options) are web-form surfaces — they ride the UI window.
 *
 * Deliberately NOT the `issue_subscriptions` table: upstream keeps them
 * separate too (`issue_watch` vs `watch`).
 *
 * Semantics mirrored (routers/api/v1/user/watch.go): watch/unwatch are
 * idempotent, and `WatchInfo.created_at` renders the REPOSITORY's created
 * timestamp (upstream `ctx.Repo.Repository.CreatedUnix`), not the watch
 * row's. `IsWatchingRepo` (:109-112) is mode-aware: a persisted Dont row
 * (the Auto-unwatch landing, :164-165) answers NOT watching.
 */

import { and, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";

import { repositories, repoWatchers } from "../../db/schema";

/**
 * `WatchMode` (models/repo/watch.go:20-27) — the iota constants verbatim.
 */
export const WatchMode = {
  /** 0 — watch nothing unless mentioned. Never persisted. */
  None: 0,
  /** 1 — proactively watching (all events, or custom before Custom existed). */
  Normal: 1,
  /** 2 — ignore the repo. */
  Dont: 2,
  /** 3 — automatically watching (from AutoWatchOnChanges). */
  Auto: 3,
  /** 4 — watching the events picked in the custom watch options. */
  Custom: 4,
} as const;
export type WatchMode = (typeof WatchMode)[keyof typeof WatchMode];

/** The event toggles of a watch row (`WatchOptions`, watch.go:180-186). */
export interface WatchEventOptions {
  watchPullRequests: boolean;
  watchIssues: boolean;
  watchReleases: boolean;
}

/** `GetWatch`'s shape (watch.go:57-69) over our composite-PK row (upstream's
 *  `ID` autoincr has no counterpart here — updates key on (repo_id, user_id)). */
export interface RepoWatch extends WatchEventOptions {
  repoId: string;
  userId: number;
  mode: WatchMode;
}

/** `IsWatchModeWatching` (watch.go:104-106). */
export function isWatchModeWatching(mode: WatchMode): boolean {
  return mode !== WatchMode.None && mode !== WatchMode.Dont;
}

const allIncludesTrue: WatchEventOptions = {
  watchPullRequests: true,
  watchIssues: true,
  watchReleases: true,
};

/**
 * `GetWatch` (watch.go:57-69) — the row, or the dummy record mirroring the
 * column defaults (mode None, every include true) when absent.
 */
export async function getWatch(d1: D1Database, repoId: string, userId: number): Promise<RepoWatch> {
  const row = await drizzle(d1)
    .select()
    .from(repoWatchers)
    .where(and(eq(repoWatchers.repoId, repoId), eq(repoWatchers.userId, userId)))
    .get();
  if (row !== undefined) {
    return {
      repoId,
      userId,
      mode: row.mode,
      watchPullRequests: row.includePullRequests,
      watchIssues: row.includeIssues,
      watchReleases: row.includeReleases,
    };
  }
  return { repoId, userId, mode: WatchMode.None, ...allIncludesTrue };
}

/** `IsWatchingRepo` (watch.go:109-112) — `GetWatch` then
 *  `IsWatchModeWatching`; the persisted Dont row answers false. */
export async function isWatchingRepo(d1: D1Database, repoId: string, userId: number): Promise<boolean> {
  const watch = await getWatch(d1, repoId, userId);
  return isWatchModeWatching(watch.mode);
}

/** The watching-ness guard the counter batch uses — a persisted row watches
 *  iff mode ∉ {None, Dont} (None never persists; the predicate keeps the
 *  guard exact against hypothetical drift rows). */
const watchingRowPredicate = (repoId: string, userId: number) =>
  sql`(SELECT 1 FROM repo_watchers WHERE repo_id = ${repoId} AND user_id = ${userId} AND mode NOT IN (0, 2))`;

/**
 * `watchRepoByMode` (watch.go:114-156) — the single mode-transition
 * primitive every setter funnels through. Counter discipline: the
 * `num_watches` delta is computed from the read, then the write rides ONE
 * D1 batch whose UPDATE is guarded by the same watching-ness predicate the
 * delta was derived from — a concurrent double-watch serializes on the
 * write lock so exactly one batch counts (the pre-mode port's atomicity
 * note, now on mode instead of row existence; upstream runs the equivalent
 * inside `WithTx`/one statement pair). The MAX(…, 0) floor is drift
 * insurance for rows predating the counter's backfill, not semantics.
 */
export async function watchRepoByMode(
  d1: D1Database,
  repoId: string,
  userId: number,
  mode: WatchMode,
  now: Date,
): Promise<void> {
  if (userId <= 0) return; // watch.go:115-117
  const current = await getWatch(d1, repoId, userId);
  if (current.mode === mode) return; // watch.go:118-120
  if (mode === WatchMode.Auto && (current.mode === WatchMode.Dont || isWatchModeWatching(current.mode))) {
    return; // watch.go:121-124 — don't auto watch if already watching or deliberately not watching
  }
  const wasWatching = isWatchModeWatching(current.mode);
  const willWatch = isWatchModeWatching(mode);
  const repoWatchDelta = wasWatching === willWatch ? 0 : willWatch ? 1 : -1; // watch.go:128-134
  // Starting to watch resets the options, otherwise a custom selection
  // survives (watch.go:136-138).
  const resetIncludes = repoWatchDelta === 1;
  const rowExists = current.mode !== WatchMode.None;
  const db = drizzle(d1);
  const counterBump = db
    .update(repositories)
    .set({ numWatches: sql`num_watches + 1` })
    .where(and(eq(repositories.id, repoId), sql`NOT EXISTS ${watchingRowPredicate(repoId, userId)}`));
  const counterDecrement = db
    .update(repositories)
    .set({ numWatches: sql`MAX(num_watches - 1, 0)` })
    .where(and(eq(repositories.id, repoId), sql`EXISTS ${watchingRowPredicate(repoId, userId)}`));
  // The batch is at least the edge write (the counter statement rides only
  // on a delta != 0) — the codebase's guarded-batch tuple shape (blocks.ts).
  const stmts: BatchItem<"sqlite">[] = [];
  if (repoWatchDelta === 1) stmts.push(counterBump);
  if (repoWatchDelta === -1) stmts.push(counterDecrement);

  if (!rowExists && mode !== WatchMode.None) {
    // watch.go:141-144 — first-ever mode set INSERTs (the dummy's includes
    // are the column defaults, true — watch.go:62-63).
    stmts.push(
      db
        .insert(repoWatchers)
        .values({ repoId, userId, mode, createdAt: now, ...allIncludesTrue })
        .onConflictDoNothing({ target: [repoWatchers.repoId, repoWatchers.userId] }),
    );
  } else if (mode !== WatchMode.None) {
    // watch.go:145-148 — update; the includes ride only on the reset arm.
    stmts.push(
      db
        .update(repoWatchers)
        .set({
          mode,
          ...(resetIncludes ? { includePullRequests: true, includeIssues: true, includeReleases: true } : {}),
        })
        .where(and(eq(repoWatchers.repoId, repoId), eq(repoWatchers.userId, userId))),
    );
  } else {
    // watch.go:149-151 — the None transition DELETEs the row (from watching
    // or from a persisted Dont; both keep the counter honest).
    stmts.push(db.delete(repoWatchers).where(and(eq(repoWatchers.repoId, repoId), eq(repoWatchers.userId, userId))));
  }
  await db.batch(stmts as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

/**
 * `WatchRepoAuto(…, doWatch=true)` (watch.go:159-177) minus the blocked-user
 * probe (the route handler owns it) — idempotent subscribe. A Custom watch
 * keeps the user's picked events (:173-175); everything else lands on
 * Normal via `watchRepoByMode` (a repeat Normal PUT is the same-mode no-op;
 * starting to watch resets the includes).
 */
export async function watchRepo(d1: D1Database, repoId: string, userId: number, now: Date): Promise<void> {
  const current = await getWatch(d1, repoId, userId);
  if (current.mode === WatchMode.Custom) return; // watch.go:173-175 — keep the events the user picked
  return watchRepoByMode(d1, repoId, userId, WatchMode.Normal, now);
}

/**
 * `WatchRepoAuto(…, doWatch=false)` (watch.go:159-168) — idempotent
 * unsubscribe: an Auto watch lands on Dont (the deliberate-off state, the
 * row PERSISTS with mode=2 and the counter decrements), everything else on
 * None (row deleted; a persisted Dont stays Dont — the same-mode no-op).
 */
export async function unwatchRepo(
  d1: D1Database,
  repoId: string,
  userId: number,
  now: Date = new Date(),
): Promise<void> {
  const current = await getWatch(d1, repoId, userId);
  if (current.mode === WatchMode.Auto) {
    return watchRepoByMode(d1, repoId, userId, WatchMode.Dont, now); // watch.go:164-165
  }
  return watchRepoByMode(d1, repoId, userId, WatchMode.None, now); // watch.go:167
}

/**
 * `WatchRepoWithOptions` (watch.go:189-206) — the WatchOptions setter (the
 * web watch menu's ignore/participate/watch/custom arms). The include flags
 * are written for Normal and Custom only (:199-203); upstream wraps both
 * statements in `WithTx`, ours is the transition batch then the flag update
 * (the include flags of a fresh insert already reset to true — a Normal
 * write is then the explicit opts, a Custom write the picked set).
 */
export async function watchRepoWithOptions(
  d1: D1Database,
  repoId: string,
  userId: number,
  opts: { mode: WatchMode } & WatchEventOptions,
  now: Date,
): Promise<void> {
  await watchRepoByMode(d1, repoId, userId, opts.mode, now);
  if (opts.mode === WatchMode.Normal || opts.mode === WatchMode.Custom) {
    await drizzle(d1)
      .update(repoWatchers)
      .set({
        includePullRequests: opts.watchPullRequests,
        includeIssues: opts.watchIssues,
        includeReleases: opts.watchReleases,
      })
      .where(and(eq(repoWatchers.repoId, repoId), eq(repoWatchers.userId, userId)));
  }
}

/**
 * `ClearRepoWatches` (models/repo/watch.go:327-333) — the private-flip
 * zeroing (repository.go:179-181: "watchers who lost access must not keep
 * watching the now-private repo"). Upstream's body is exactly two statements
 * and adjusts NO user counter (unlike the star port in services/stars.ts —
 * star.go:96-98 decrements each stargazer, while the users table carries no
 * watch tally): the repo counter is plain-zeroed (watch.go:329-331, `UPDATE
 * repository SET num_watches = 0`, no timestamp touch) and every watch edge
 * is deleted (watch.go:333, `db.DeleteBeans(ctx, Watch{RepoID: repoID})`).
 */
export async function clearRepoWatches(d1: D1Database, repoId: string): Promise<void> {
  const db = drizzle(d1);
  await db.batch([
    db.update(repositories).set({ numWatches: 0 }).where(eq(repositories.id, repoId)),
    db.delete(repoWatchers).where(eq(repoWatchers.repoId, repoId)),
  ]);
}

/** Watcher EDGE count (a live COUNT over `repo_watchers` — the drift probe
 *  next to the maintained `repositories.num_watches` column, which is what
 *  `Repository.watchers_count` renders). Counted rows are the WATCHING rows
 *  (mode <> Dont; None never persists) so the probe tracks the counter's
 *  delta arithmetic, which ignores persisted-Dont rows. */
export async function countRepoWatchers(d1: D1Database, repoId: string): Promise<number> {
  const row = await drizzle(d1)
    .select({ n: sql<number>`count(*)` })
    .from(repoWatchers)
    .where(and(eq(repoWatchers.repoId, repoId), ne(repoWatchers.mode, WatchMode.Dont)))
    .get();
  return row?.n ?? 0;
}

/** Repo-scoped watch delete (the api repoDelete path's housekeeping; the
 *  deleteRepository cascade covers the same rows through the schema table). */
export async function deleteRepoWatchers(d1: D1Database, repoId: string): Promise<void> {
  await drizzle(d1).delete(repoWatchers).where(eq(repoWatchers.repoId, repoId));
}

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

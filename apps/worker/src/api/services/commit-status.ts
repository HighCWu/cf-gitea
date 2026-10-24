import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { commitStatuses, users, type CommitStatusRow } from "../../db/schema";
import type { CommitStatusState, CommitStatus } from "../models/commit-status";
import { GO_ZERO_TIME, apiUserFromRow, type Viewer } from "./repository";

/**
 * Commit-status reads/writes backing the tier-1 `repository`-tagged CI-status
 * routes (SPEC-0004 §2.4 rows: repoCreateStatus / repoListStatuses /
 * repoListStatusesByRef / repoGetCombinedStatusByRef), on the landed
 * `commit_statuses` D1 table.
 *
 * Upstream references mirrored:
 *  - list sort orders: `CommitStatusOptions.ToOrders`
 *    (gitea/models/git/commit_status.go) — note "leastindex" orders by
 *    `index DESC` and "highestindex" by `index ASC` (the names are inverted
 *    relative to intuition; kept faithful).
 *  - state filter: only the five swagger values filter; anything else is
 *    ignored (`CommitStatusOptions.ToConds` — "skipped" and garbage never
 *    filter).
 *  - combined: `GetLatestCommitStatus` keeps the LATEST row per context
 *    (max `index` per `context_hash`), then `CommitStatusStates.Combine`
 *    (gitea/modules/commitstatus/commit_status.go:67–82) aggregates
 *    worst-of: any error/failure/warning → "failure"; otherwise all-success
 *    (success/skipped only, at least one) → "success"; else "pending".
 *    Our schema has no `context_hash`/`index` columns (READ-ONLY this wave):
 *    `context` groups 1:1 with its hash, and the global autoincrement `id`
 *    is order-equivalent to the per-sha index within one (repo, sha).
 */

/** D1 rows are ordered by the global autoincrement id — see the module comment. */
type StatusOrderBy = SQL[];

/**
 * The list sort enum (`repoListStatuses` `sort` query param). Invalid values
 * silently take upstream's default — FormTrim + ToOrders default, never 422.
 */
export function commitStatusOrderBy(sort: string): StatusOrderBy {
  switch (sort) {
    case "oldest":
      return [asc(commitStatuses.createdAt), asc(commitStatuses.id)];
    case "recentupdate":
      return [desc(commitStatuses.updatedAt), desc(commitStatuses.id)];
    case "leastupdate":
      return [asc(commitStatuses.updatedAt), asc(commitStatuses.id)];
    case "leastindex":
      return [desc(commitStatuses.id)];
    case "highestindex":
      return [asc(commitStatuses.id)];
    default:
      // upstream default: "created_unix DESC, `index` DESC — timestamps have
      // 1s resolution, `index` keeps paging stable".
      return [desc(commitStatuses.createdAt), desc(commitStatuses.id)];
  }
}

/** The `state` query filter enum; any other value filters nothing. */
const STATE_FILTER_VALUES: readonly string[] = ["pending", "success", "error", "failure", "warning"];

function isStateFilterValue(state: string): state is CommitStatusState {
  return STATE_FILTER_VALUES.includes(state);
}

/**
 * Full-length lowercase commit id (sha1 `FullLength` = 40 hex chars — our
 * repositories pin `object_format_name: "sha1"`). Upstream resolves the POST
 * path sha through `gitRepo.GetCommit` (services/repository/commitstatus/
 * commitstatus.go:80 — branch names and short hashes resolve), which needs
 * the SPEC-0001 storage engine: unavailable to this wave. Until that lands
 * the POST route requires a full-length sha (see routes/statuses.ts).
 */
export function isFullLengthCommitId(sha: string): boolean {
  return /^[0-9a-f]{40}$/.test(sha);
}

function isoOrGoZero(date: Date | null): string {
  return date === null ? GO_ZERO_TIME : date.toISOString();
}

export interface CommitStatusWireContext {
  /** The API URL prefix of the repository: `{origin}/api/v1/repos/{owner}/{repo}`. */
  repoApiUrl: string;
  creator: CommitStatus["creator"];
}

/**
 * `convert.ToCommitStatus` (gitea/services/convert/status.go:17–35) — note
 * two pinned-commit quirks kept faithful: `id` carries the per-sha status
 * INDEX (our D1 table has no index column — the autoincrement id takes its
 * place; TODO(SPEC-0005): commit_status_index), and `updated_at` is rendered
 * from CreatedUnix, i.e. it always equals `created_at`.
 */
export function toApiCommitStatus(row: CommitStatusRow, ctx: CommitStatusWireContext): CommitStatus {
  const created = isoOrGoZero(row.createdAt);
  return {
    id: row.id, // upstream emits the per-sha index here (see module comment)
    status: row.state,
    target_url: row.targetUrl ?? "",
    description: row.description ?? "",
    url: `${ctx.repoApiUrl}/statuses/${encodeURIComponent(row.sha)}`,
    context: row.context,
    creator: ctx.creator,
    created_at: created,
    updated_at: created, // upstream quirk: Updated renders CreatedUnix
  };
}

/**
 * Convert a list of rows to the wire shape, resolving every distinct creator
 * with one query (upstream loads per row; N+1 reduced).
 */
export async function toApiCommitStatuses(
  d1: D1Database,
  viewer: Viewer,
  repoApiUrl: string,
  rows: CommitStatusRow[],
): Promise<CommitStatus[]> {
  const creatorIds = [...new Set(rows.map((row) => row.creatorId).filter((id): id is number => id !== null))];
  const creatorsById = new Map<number, CommitStatus["creator"]>();
  if (creatorIds.length > 0) {
    const userRows = await drizzle(d1).select().from(users).where(inArray(users.id, creatorIds));
    for (const user of userRows) {
      creatorsById.set(user.id, apiUserFromRow(user, viewer));
    }
  }
  return rows.map((row) =>
    toApiCommitStatus(row, { repoApiUrl, creator: row.creatorId === null ? null : (creatorsById.get(row.creatorId) ?? null) }),
  );
}

export interface CreateCommitStatusInput {
  repoId: string;
  sha: string;
  state: CommitStatusState;
  targetUrl: string;
  description: string;
  context: string;
  creatorId: number | null;
}

/**
 * `NewCommitStatus` insert side: xorm's `created`/`updated` auto-columns
 * become explicit timestamps; upstream's separate `commit_status_index`
 * counter (per-sha monotonic index) has no D1 counterpart yet — the
 * autoincrement id doubles as the sort/aggregation key (module comment).
 */
export async function createCommitStatus(d1: D1Database, input: CreateCommitStatusInput): Promise<CommitStatusRow> {
  const now = new Date();
  const rows = await drizzle(d1)
    .insert(commitStatuses)
    .values({
      repoId: input.repoId,
      sha: input.sha,
      state: input.state,
      targetUrl: input.targetUrl,
      description: input.description,
      context: input.context,
      creatorId: input.creatorId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("commit status insert committed without returning rows");
  }
  return row;
}

export interface CommitStatusListResult {
  items: CommitStatusRow[];
  total: number;
}

/** `getCommitStatuses` — FindAndCount over (repo_id, sha) with the sort/state
 * query params (`repoListStatuses` queries the path sha VERBATIM, no ref
 * resolution). */
export async function listCommitStatuses(
  d1: D1Database,
  repoId: string,
  sha: string,
  sort: string,
  state: string,
  page: number,
  limit: number,
): Promise<CommitStatusListResult> {
  const conditions: SQL[] = [eq(commitStatuses.repoId, repoId), eq(commitStatuses.sha, sha)];
  if (isStateFilterValue(state)) {
    conditions.push(eq(commitStatuses.state, state));
  }
  const where = and(...conditions);
  const db = drizzle(d1);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(commitStatuses).where(where);
  const items = await db
    .select()
    .from(commitStatuses)
    .where(where)
    .orderBy(...commitStatusOrderBy(sort))
    .limit(limit)
    .offset((page - 1) * limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

/**
 * `GetLatestCommitStatus` + `CountLatestCommitStatus` — the latest status per
 * context, newest context first, plus the distinct-context count that feeds
 * the CombinedStatus `total_count`/`X-Total-Count`.
 */
export async function latestCommitStatuses(
  d1: D1Database,
  repoId: string,
  sha: string,
  page: number,
  limit: number,
): Promise<CommitStatusListResult> {
  const scoped = and(eq(commitStatuses.repoId, repoId), eq(commitStatuses.sha, sha));
  // max id per context = upstream's max(index) per context_hash.
  const latestIdsPerContext = drizzle(d1)
    .select({ value: sql<number>`max(${commitStatuses.id})` })
    .from(commitStatuses)
    .where(scoped)
    .groupBy(commitStatuses.context);
  const db = drizzle(d1);
  const items = await db
    .select()
    .from(commitStatuses)
    .where(and(scoped, inArray(commitStatuses.id, latestIdsPerContext)))
    .orderBy(desc(commitStatuses.id))
    .limit(limit)
    .offset((page - 1) * limit);
  const contextRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(commitStatuses)
    .where(scoped)
    .groupBy(commitStatuses.context);
  return { items, total: contextRows.length };
}

/**
 * `CommitStatusStates.Combine` (gitea/modules/commitstatus/commit_status.go:67–82)
 * — the exact worst-of precedence: the FIRST error/failure/warning short-
 * circuits to "failure" (warning is failure-family, Gitea-specific);
 * success/skipped count; "success" only when EVERY state counted success;
 * anything else (pending present, or no statuses) is "pending".
 */
export function combineCommitStatusStates(states: CommitStatusState[]): CommitStatusState {
  let successCount = 0;
  for (const state of states) {
    if (state === "error" || state === "failure" || state === "warning") {
      return "failure";
    }
    if (state === "success" || state === "skipped") {
      successCount++;
    }
  }
  if (successCount > 0 && successCount === states.length) {
    return "success";
  }
  return "pending";
}

/**
 * `convert.ToCombinedStatus` — aggregation runs over the latest-per-context
 * rows only; an empty set renders the "pending" fallback
 * (services/convert/status.go:59–61).
 */
export function combinedStateOf(rows: CommitStatusRow[]): CommitStatusState {
  return combineCommitStatusStates(rows.map((row) => row.state));
}

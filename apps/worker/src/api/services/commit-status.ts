import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { commitStatuses, commitStatusIndexes, users, type CommitStatusRow } from "../../db/schema";
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
 *  - writes: `NewCommitStatus` (commit_status.go:497–537) allocates the
 *    per-(repo, sha) ordinal from the `commit_status_indexes` counter
 *    (MAX+1, :125–181) inside ONE transaction — ours is one D1 batch
 *    (transactional, same atomicity) — and derives `context_hash` =
 *    sha1 hex of the context (HashCommitStatusContext :550–552) when the
 *    caller left it empty. Pre-port rows carry NULL hash (D1 SQL has no
 *    sha1(); migration 0072 backfills `index` only): the grouping read
 *    repairs them on first touch (SPEC-0005 §10.3), and until then
 *    `coalesce(context_hash, context)` keeps their grouping identical to
 *    the pre-port raw-context behavior.
 */

/** Upstream's ToOrders (`index` tie-breakers keep paging stable past 1s resolution). */
type StatusOrderBy = SQL[];

/**
 * The list sort enum (`repoListStatuses` `sort` query param). Invalid values
 * silently take upstream's default — FormTrim + ToOrders default, never 422.
 */
export function commitStatusOrderBy(sort: string): StatusOrderBy {
  switch (sort) {
    case "oldest":
      return [asc(commitStatuses.createdAt), asc(commitStatuses.index)];
    case "recentupdate":
      return [desc(commitStatuses.updatedAt), desc(commitStatuses.index)];
    case "leastupdate":
      return [asc(commitStatuses.updatedAt), asc(commitStatuses.index)];
    case "leastindex":
      return [desc(commitStatuses.index)];
    case "highestindex":
      return [asc(commitStatuses.index)];
    default:
      // upstream default: "created_unix DESC, `index` DESC — timestamps have
      // 1s resolution, `index` keeps paging stable".
      return [desc(commitStatuses.createdAt), desc(commitStatuses.index)];
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

/**
 * `HashCommitStatusContext` (commit_status.go:550–552) — the lowercase hex
 * sha1 the `context_hash` dedupe key carries. Callers that need same-display
 * contexts separated mix extra data into the input (the Actions writer joins
 * `ctxName + "\x00" + workflowId`, actions/commit_status.go:282, #35699).
 */
export async function hashCommitStatusContext(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
 * INDEX (convert/status.go:24 `ID: status.Index` — NOT the row pk; the
 * webhook payload keeps the pk, notifier.go:942 — upstream's own asymmetry),
 * and `updated_at` is rendered from CreatedUnix, i.e. it always equals
 * `created_at`.
 */
export function toApiCommitStatus(row: CommitStatusRow, ctx: CommitStatusWireContext): CommitStatus {
  const created = isoOrGoZero(row.createdAt);
  return {
    id: row.index ?? 0, // upstream emits the per-sha index here (see module comment)
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
  /**
   * Callers may pre-compute the dedupe hash to keep same-display contexts
   * separated (upstream NewCommitStatus:526–528 — "only derive from Context
   * when unset"; the Actions writer mixes the workflow file path in,
   * actions/commit_status.go:282). Empty/absent → derived from `context`.
   */
  contextHash?: string;
  creatorId: number | null;
}

/**
 * `NewCommitStatus` insert side (commit_status.go:497–537): xorm's
 * `created`/`updated` auto-columns become explicit timestamps. The per-sha
 * ordinal comes from the `commit_status_indexes` counter — GetNextCommitStatusIndex's
 * MAX+1 (:125–181; the first status of a sha gets 1, the counter restarts per
 * (repo, sha)) — as a postgres-arm-shaped upsert (`max_index = max_index + 1`
 * on conflict, RETURNING via the insert's subselect reading the updated row).
 * Counter bump + row insert ride ONE D1 batch, which is transactional — the
 * same atomicity as upstream's single WithTx (:506–536); a crash between the
 * pair would burn an ordinal, harmless, upstream identical.
 * `context_hash` = sha1(context) (the :526–528 default; API callers never
 * pre-compute).
 */
export async function createCommitStatus(d1: D1Database, input: CreateCommitStatusInput): Promise<CommitStatusRow> {
  const now = new Date();
  const db = drizzle(d1);
  const contextHash = input.contextHash || (await hashCommitStatusContext(input.context));
  const results = await db.batch(
    [
      db
        .insert(commitStatusIndexes)
        .values({ repoId: input.repoId, sha: input.sha, maxIndex: 1 })
        .onConflictDoUpdate({
          target: [commitStatusIndexes.repoId, commitStatusIndexes.sha],
          set: { maxIndex: sql`${commitStatusIndexes.maxIndex} + 1` },
        }),
      db
        .insert(commitStatuses)
        .values({
          repoId: input.repoId,
          sha: input.sha,
          // reads the counter row the batch's first statement just upserted —
          // one round trip keeps the pair atomic (upstream's WithTx).
          index: sql`(SELECT \`max_index\` FROM \`commit_status_indexes\` WHERE \`repo_id\` = ${input.repoId} AND \`sha\` = ${input.sha})`,
          contextHash,
          state: input.state,
          targetUrl: input.targetUrl,
          description: input.description,
          context: input.context,
          creatorId: input.creatorId,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    ] as const,
  );
  const inserted = results[1];
  const row = inserted[0];
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
 * The lazy `context_hash` repair seam (SPEC-0005 §10.6.1 — the port's
 * choice): a first-read sweep scoped to the (repo, sha) being grouped, run
 * synchronously BEFORE the grouping queries inside `latestCommitStatuses`,
 * so the read that touches a pre-port (NULL-hash) scope already answers with
 * upstream-faithful grouping — no waitUntil convergence lag (the merge gates
 * act on THIS read; a post-response repair could leave the gate answer stale
 * until the next request, and the gates have no executionCtx to defer
 * through). Bounded: the sweep touches only the scope's NULL-hash rows, at
 * most REPAIR_SWEEP_BOUND per read (per-commit statuses are small; a
 * pathological sha converges over successive reads), one idempotent
 * NULL-guarded UPDATE per distinct context riding one D1 batch. Writers
 * always persist a hash, so post-port rows never enter the sweep.
 */
const REPAIR_SWEEP_BOUND = 200;

/** The exhaustion-loop transport page for `db.ListOptionsAll` reads. */
const STATUS_ALL_PAGE_SIZE = 100;

async function repairNullContextHashes(d1: D1Database, scoped: SQL): Promise<void> {
  const db = drizzle(d1);
  const stale = await db
    .select({ context: commitStatuses.context })
    .from(commitStatuses)
    .where(and(scoped, isNull(commitStatuses.contextHash)))
    .groupBy(commitStatuses.context)
    .limit(REPAIR_SWEEP_BOUND);
  // sequential idempotent UPDATEs — each is NULL-guarded, so a partial pass
  // just leaves the remainder to the next read.
  for (const row of stale) {
    const hash = await hashCommitStatusContext(row.context);
    await db
      .update(commitStatuses)
      .set({ contextHash: hash })
      .where(and(scoped, eq(commitStatuses.context, row.context), isNull(commitStatuses.contextHash)));
  }
}

/**
 * `GetLatestCommitStatus` + `CountLatestCommitStatus` — the latest status per
 * context (max `index` per `context_hash`, commit_status.go:343–366), newest
 * context first, plus the distinct-context count that feeds the CombinedStatus
 * `total_count`/`X-Total-Count`. Pre-port NULL-hash rows group by their raw
 * context instead (`coalesce`) — SQL's per-value NULL handling keeps their
 * grouping exactly the pre-port observable, so the repair arm above is a pure
 * convergence pass, never a behavior change.
 */
export async function latestCommitStatuses(
  d1: D1Database,
  repoId: string,
  sha: string,
  page: number,
  limit: number,
): Promise<CommitStatusListResult> {
  const scoped = and(eq(commitStatuses.repoId, repoId), eq(commitStatuses.sha, sha)) as SQL;
  await repairNullContextHashes(d1, scoped);
  const groupKey = sql`coalesce(${commitStatuses.contextHash}, ${commitStatuses.context})`;
  // max index per context_hash = upstream's GetLatestCommitStatus indices query.
  const latestIndicesPerContext = drizzle(d1)
    .select({ value: sql<number>`max(${commitStatuses.index})` })
    .from(commitStatuses)
    .where(scoped)
    .groupBy(groupKey);
  const db = drizzle(d1);
  const items = await db
    .select()
    .from(commitStatuses)
    .where(and(scoped, inArray(commitStatuses.index, latestIndicesPerContext)))
    .orderBy(desc(commitStatuses.index))
    .limit(limit)
    .offset((page - 1) * limit);
  const contextRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(commitStatuses)
    .where(scoped)
    .groupBy(groupKey);
  return { items, total: contextRows.length };
}

/**
 * `GetLatestCommitStatus(…, db.ListOptionsAll)` (commit_status.go:343–359 with
 * models/db/list.go:40) — every latest-per-context row at the sha, paged to
 * exhaustion (the same loop shape the merge gates carry). The Actions writer
 * consumes this for its identical-state short-circuit and its legacy-hash
 * adoption arm.
 */
export async function allLatestCommitStatuses(d1: D1Database, repoId: string, sha: string): Promise<CommitStatusRow[]> {
  const out: CommitStatusRow[] = [];
  for (let page = 1; ; page++) {
    const { items } = await latestCommitStatuses(d1, repoId, sha, page, STATUS_ALL_PAGE_SIZE);
    out.push(...items);
    if (items.length < STATUS_ALL_PAGE_SIZE) return out;
  }
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

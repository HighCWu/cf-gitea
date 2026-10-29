/**
 * The Tier-2 pages' engine client (SPEC-0008 §3.2 data-sourcing rules): the
 * thin wrapper over the RepoCell RPC surface the pages read. Pages NEVER
 * self-fetch their own HTTP surface (no `fetch("/api/v1/…")` from a handler —
 * the subrequest budget, auth re-runs, and event-loop hop all forbid it, §3.2;
 * precedent: gitHttpGate.serveHead reads `RepoCell.listRefs()` by RPC).
 *
 * Engine RPC surface used (verified `packages/git-engine/dist-types/repo.d.ts`
 * at this pin): `listRefs`, `readCommit`, `listLog`, `listTree`, `readBlob`,
 * plus the A10-L batched enrichment RPC `listTreeCommits(ref, paths)` — one
 * date-ordered walk answering the first commit per path, index-aligned
 * (`TreeCommitsResult`), replacing the per-entry `listLog(ref, {path, n: 1})`
 * fan on directory views (see page-data.ts; the per-path fan remains the
 * documented fallback for entries the batch misses) — and the census R08
 * blame RPC `blame(ref, path)` (the blame page's line runs + per-oid commit
 * metadata).
 *
 * Failure posture: every method resolves `null` on transport failure (a thrown
 * RPC), mirroring the gate's serveHead catch-and-fall-back (§4.9 "unreadable
 * storage must not break" the page). `null` is ALSO the engine's own
 * not-found/unresolvable-ref answer, so callers branch on one shape; a page
 * decides per family whether that means the empty-repo render or the 404
 * shell.
 *
 * DO addressing: the combined repo name from the RESOLVED D1 row
 * (`ownerNamespace/slug` — the same combined-name convention as the gate's
 * `env.REPO.getByName("owner/repo")`, but taken from the row the page already
 * resolved so /ALICE/hello and /alice/hello reach the same cell; the gate's
 * request-casing variant carries the same `TODO(SPEC-0003 M2)` switch to
 * `storage_key`, which this module inherits — one more reason pages go through
 * this one file, open question 5).
 */

import type {
  BlobResult,
  BlameResult,
  CommitJson,
  ActivityStatsResult,
  ContributorStatsResult,
  GrepResult,
  LogResult,
  RefsResult,
  TreeCommitsResult,
  TreeResult,
} from "@cf-gitea/git-engine";

/** The exact engine RPC slice the pages consume — `null`-on-failure shape. */
export interface EngineClient {
  listRefs(): Promise<RefsResult | null>;
  readCommit(id?: string): Promise<CommitJson | null>;
  listLog(ref?: string, opts?: { path?: string; ofs?: number; n?: number }): Promise<LogResult | null>;
  listTree(ref?: string, path?: string): Promise<TreeResult | null>;
  readBlob(ref: string | undefined, path: string): Promise<BlobResult | null>;
  /** A10-L batched enrichment: commit per input path, index-aligned. */
  listTreeCommits(ref: string | undefined, paths: string[]): Promise<TreeCommitsResult | null>;
  /** Per-line blame (the census R08 RPC): same-commit line runs + per-oid
   *  commit metadata; `null` = unavailable (unresolvable ref, missing path,
   *  binary, over-size — the engine's availability ladder). */
  blame(ref: string | undefined, path: string, opts?: { lineOfs?: number; lineLimit?: number }): Promise<BlameResult | null>;
  /** In-repo content search (SPEC-0015 M1, census R10): exact/words/regexp
   *  over flattenTree, results capped at 50 with `truncated` honesty;
   *  `null` = refused (empty/absent q, unresolvable ref, regexp compile
   *  failure — the availability ladder). */
  grep(ref: string | undefined, opts?: { q?: string; mode?: "exact" | "words" | "regexp"; path?: string }): Promise<GrepResult | null>;
  /** Windowed pulse counts (SPEC-0015 M2a, the activity page's arms):
   *  period-switched first-parent fold with merges excluded, add/del totals,
   *  per-author counts, a 10-min TTL cache keyed by the immutable tip;
   *  `null` = unresolvable ref/empty repo (the availability ladder). */
  activityStats(ref: string | undefined, period?: string): Promise<ActivityStatsResult | null>;
  /** Per-author weekly add/del timeline (SPEC-0015 M2b, the R15 charts'
   *  substrate): full-history walk (merges excluded from the fold, counted
   *  as cap slots), Sunday-anchored Unix-ms buckets computed in each
   *  commit's recorded timezone, oldest-name precedence; NO TTL (the
   *  fixed-history immutability argument); `truncated` on the scan cap. */
  contributorStats(ref: string | undefined): Promise<ContributorStatsResult | null>;
}

/** Build the client for one repository from the request's bindings. */
export function engineClient(env: Env, repoName: string): EngineClient {
  const cell = env.REPO.getByName(repoName);
  const safe = <T>(pending: Promise<T>): Promise<T | null> => pending.catch(() => null);
  return {
    listRefs: () => safe(cell.listRefs()),
    readCommit: (id) => safe(cell.readCommit(id)),
    listLog: (ref, opts) => safe(cell.listLog(ref, opts)),
    listTree: (ref, path) => safe(cell.listTree(ref, path)),
    readBlob: (ref, path) => safe(cell.readBlob(ref, path)),
    listTreeCommits: (ref, paths) => safe(cell.listTreeCommits(ref, paths)),
    blame: (ref, path, opts) => safe(cell.blame(ref, path, opts)),
    grep: (ref, opts) => safe(cell.grep(ref, opts)),
    activityStats: (ref, period) => safe(cell.activityStats(ref, period)),
    contributorStats: (ref) => safe(cell.contributorStats(ref)),
  };
}

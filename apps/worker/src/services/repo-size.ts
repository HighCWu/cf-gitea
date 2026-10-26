/**
 * Settle-time repository size (upstream `Repository.Size`) — the R2 byte
 * footprint of one repository's git storage, persisted to
 * `repositories.size_kb` and rendered as the API `size` KB integer.
 *
 * UPSTREAM SCOPE (the citation this module implements): upstream's
 * `git.CalcRepositorySize` (modules/git/size.go:15-39) walks the bare git
 * directory (`RepoLocalPath`) and sums every regular file's bytes — packs,
 * loose objects, staging and temp files alike (vanished temp/lock files are
 * skipped mid-walk). That git-dir total is `GitSize`
 * (modules/repository/create.go:16-27); LFS is a SEPARATE sum over the
 * `lfs_object` table (`GetRepoLFSSize`), and the stored column folds both:
 * `Size = GitSize + LFSSize` (models/repo/update.go:105-112). The API renders
 * KB at read time: `Size: int(repo.Size / 1024)` (services/convert/
 * repository.go:207).
 *
 * OURS: the git-dir walk maps onto the repo's R2 storage prefix —
 * `repos/<storage_key>/` (packs/ + idx sidecars + staging/ + clone-cache/,
 * the ONE prefix a repo's storage ever addresses: packages/git-engine
 * src/git/r2keys.ts:39-76, the same prefix the delete purge walks,
 * src/repos/purge.ts). R2 `list` returns key+size without bodies, so the
 * accounting is metadata-only: paginated `list` under the prefix, sum
 * `size`, floor-divide to KiB (upstream's Go `int(size / 1024)` truncation),
 * persist. The `imports/<storage_key>/` prefix stays OUT — it holds only the
 * chunked-import channel's transient staging, purged at import end
 * (src/repos/imports/pipeline.ts), never part of the live git dir.
 *
 * DEVIATION (documented): this wave accounts the GIT footprint only — the
 * upstream `size` column's LFS half (update.go:110) is not folded in, since
 * LFS objects live in their own storage domain and the mission pins the
 * semantic to CalRepositorySize's scope (git size, NOT LFS/attachments).
 *
 * WHEN: upstream recomputes at exactly the settle points we mirror — after a
 * push's updates apply (services/repository/push.go:74-83), after a fork's
 * replication (services/repository/fork.go:190), after a template generate
 * (services/repository/generate.go:295), plus create/migrate/adopt/check.
 * The wiring lives at the same seams here: the engine onPush adapter
 * (services/webhooks-push.ts `handleUserPushEvent`) and the fork
 * replication's shared pass (src/repos/fork-task.ts `replicateRepoCopy`,
 * which the generate route rides synchronously — api/services/generate-repo.ts).
 * Like upstream's fork arm ("even if below operations failed, it could be
 * ignored", fork.go:189-192), a failed accounting never fails the settle:
 * callers wrap, log, and the next settle leg re-accounts.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories } from "../db/schema";

/**
 * `repos/<storage_key>/` — the repo's storage prefix (the engine's
 * `repoPrefix`, git-engine src/git/r2keys.ts:39-42; restated here because the
 * engine's public mod does not export r2keys and the delete purge already
 * carries the same literal — src/repos/purge.ts purgeRepoStorage).
 */
export function repoStoragePrefix(storageKey: string): string {
  return `repos/${storageKey}/`;
}

/**
 * R2 list page size passed to `bucket.list({ limit })` — the binding default
 * is 1000; an explicit value keeps the pagination testable (tests pass a
 * small limit to force multi-page walks without a thousand fixtures).
 */
export const REPO_SIZE_PAGE_LIMIT = 1000;

/**
 * Subrequest cap for one accounting walk (the delete purge's budget
 * discipline, src/repos/purge.ts MAX_DELETE_CALLS): 500 list pages x up to
 * 1000 keys ≈ 500k objects before the walk gives up. Exceeding the cap is a
 * DEGRADED ANSWER, not a throw — the settle leg runs inside the engine's
 * onPush waitUntil (30 s past the response) and a fork replication's queue
 * consumer; either way the size column keeps its last settled value until a
 * later push re-accounts. A prefix beyond the cap is far past any real
 * repository shape at hobby scale.
 */
export const REPO_SIZE_MAX_LIST_PAGES = 500;

/**
 * The R2 binding slice the walk consumes — structurally the `R2Bucket`
 * binding (`REPO_PACKS`); optional-shaped so embedding/test envs without the
 * bucket degrade to a no-op (the purge's `if (!bucket) return` posture).
 */
export type RepoSizeBucket = {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: ReadonlyArray<{ size: number }>;
    truncated: boolean;
    cursor?: string;
  }>;
};

export interface RepoSizeWalkOptions {
  /** Page size override (tests); default REPO_SIZE_PAGE_LIMIT. */
  pageLimit?: number;
}

/**
 * The byte total of one storage key's git prefix — upstream's
 * CalcRepositorySize over R2 metadata. Paginated (cursor) and capped
 * (REPO_SIZE_MAX_LIST_PAGES); a missing bucket answers 0 (nothing ever
 * stored). Throws only on R2 errors — the settle callers own the
 * never-fail-the-settle catch.
 */
export async function sumRepoStorageBytes(
  bucket: RepoSizeBucket | undefined | null,
  storageKey: string,
  options: RepoSizeWalkOptions = {},
): Promise<number> {
  if (!bucket) return 0;
  const prefix = repoStoragePrefix(storageKey);
  const limit = options.pageLimit ?? REPO_SIZE_PAGE_LIMIT;
  let total = 0;
  let cursor: string | undefined;
  for (let pages = 0; ; pages++) {
    if (pages >= REPO_SIZE_MAX_LIST_PAGES) return total; // degraded answer, see the cap
    const listed = await bucket.list({ prefix, cursor, limit });
    for (const object of listed.objects) total += object.size;
    if (!listed.truncated) return total;
    cursor = listed.cursor;
  }
}

/** bytes → upstream's rendered KB integer (convert/repository.go:207 — Go
 *  integer division truncates; sizes are non-negative, so floor). */
export function bytesToKib(bytes: number): number {
  return Math.floor(bytes / 1024);
}

/**
 * The repositories-row slice the settle legs carry (`RepoRow` satisfies it).
 */
export interface RepoSizeTarget {
  id: string;
  storageKey: string;
}

/**
 * One settle leg's work: re-account the repo's R2 git footprint and persist
 * `size_kb`. Upstream's UpdateRepoSize is `NoAutoTime()` (models/repo/
 * update.go:108) — the size write deliberately does NOT bump `updated_at`,
 * and neither does ours. An empty/unstored prefix persists 0 (the empty-repo
 * answer). Missing bucket → no-op (nothing is known to be stored). Throws on
 * R2/D1 errors — the wiring wraps.
 */
export async function syncRepoSizeFromStorage(
  bucket: RepoSizeBucket | undefined | null,
  d1: D1Database,
  repo: RepoSizeTarget,
  options: RepoSizeWalkOptions = {},
): Promise<void> {
  if (!bucket) return;
  const sizeKb = bytesToKib(await sumRepoStorageBytes(bucket, repo.storageKey, options));
  await drizzle(d1)
    .update(repositories)
    .set({ sizeKb })
    .where(eq(repositories.id, repo.id))
    .run();
}

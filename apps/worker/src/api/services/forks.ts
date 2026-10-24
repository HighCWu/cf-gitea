import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, users } from "../../db/schema";
import { RepoService, type RepoRow } from "../../repos/service";
import type { Repository } from "../models/repository";
import { loadRepoSettings, saveRepoSettings } from "./repo-settings";
import { toApiRepository, type RepositoryWithOwner, type Viewer } from "./repository";

/**
 * Tier-1 forks service half (SPEC-0004 §2.4 row `GET/POST
 * /repos/{owner}/{repo}/forks` — upstream routers/api/v1/repo/fork.go
 * ListForks/CreateFork over services/repository/fork.go ForkRepository/
 * FindForks, backed by the SPEC-0001b §5.3 engine replication).
 *
 * Storage: the landed repos service (src/repos/service.ts create — the
 * UNIQUE(owner, slug) arbitration, redirect shadow rule, engine-registry
 * mirror) mints the fork row with `status='creating'` (upstream
 * `RepositoryBeingMigrated`) and a FRESH immutable storage_key; this module
 * adds the fork edge + the async hand-off:
 *
 *   - `fork_parent` (the edge to the source's repositories.id — upstream's
 *     `Repository.ForkID`) is NOT a Drizzle column yet, so it rides the
 *     raw-D1 bootstrap below (the STARS_DDL_STATEMENTS pattern; swept in the
 *     next migration together with the schema-owner port).
 *   - the git content is NOT copied here: the POST enqueues ONE
 *     `{kind: "repo-fork"}` REPO_TASKS message and answers 202; the consumer
 *     (src/repos/fork-task.ts) runs the engine's replicateForkCatalog and
 *     settles the row (`status='ready'`, `is_empty` copied) — the import
 *     channel's settle pattern.
 *
 * Documented divergences from upstream ForkRepository (all fork.go lines):
 *   - `IsPrivate` copies ONLY the base repo's flag; upstream ORs in the base
 *     owner's own private visibility (no org/user visibility columns yet).
 *   - `IsEmpty` starts TRUE even for a non-empty source (nothing is servable
 *     before the queue finalize; upstream copies the flag before cloning).
 *   - the base-repo `num_forks` counter bump is skipped — the Repository
 *     projection still renders `forks_count: 0` (no maintained column;
 *     services/repository.ts TODO).
 *   - LFS pointers are not copied (no LFS model on the fork path yet).
 *   - a lost queue enqueue strands the fork in 'creating' (logged admin
 *     notice, the delete-purge enqueue posture) — upstream clones
 *     synchronously and cleans up on failure.
 */

/**
 * DDL for the migration owner (report verbatim). `fork_parent` is the fork
 * edge: the source's `repositories.id` (upstream `Repository.ForkID int64`,
 * models/repo/repo.go), NULL for non-forks. Plain TEXT column, no FK, per the
 * repositories-adjacent schema conventions; the index serves the fork list's
 * `WHERE fork_parent = ?` scan (FindForks' `fork_id` lookup, fork.go:253).
 */
export const FORKS_DDL_STATEMENTS: readonly string[] = [
  `ALTER TABLE repositories ADD COLUMN fork_parent TEXT`,
  `CREATE INDEX IF NOT EXISTS repositories_fork_parent_idx ON repositories (fork_parent)`,
];

/** Queue producer seam narrowed to the fork message family (mirrors
 *  ImportQueueProducer: tests inject a capturing stub). */
export interface ForkQueueProducer {
  send(message: Record<string, unknown>): Promise<unknown>;
}

export interface ForkServiceDeps {
  /** REPO_TASKS producer — the one repo-fork fan-out. Optional so pure-D1
   *  tests (and direct consumer drives) run without a queue. */
  queue?: ForkQueueProducer;
}

/** One fork's creation record: the re-read fork row (status='creating'). */
export type CreatedFork = RepoRow;

/**
 * POST /repos/{owner}/{repo}/forks body guard (upstream CreateFork:
 * `GetUserFork` — at most one fork of a given source per owner, fork.go:78-88;
 * the error unwraps util.ErrAlreadyExist → the 409 family). Pure D1, raw
 * column.
 */
export async function findForkByOwner(
  d1: D1Database,
  sourceRepoId: string,
  ownerId: number,
): Promise<{ id: string; ownerNamespace: string; slug: string } | null> {
  const row = await d1
    .prepare("SELECT id, owner_namespace, slug FROM repositories WHERE fork_parent = ?1 AND owner_id = ?2 LIMIT 1")
    .bind(sourceRepoId, ownerId)
    .first<{ id: string; owner_namespace: string; slug: string }>();
  return row === null ? null : { id: row.id, ownerNamespace: row.owner_namespace, slug: row.slug };
}

/**
 * `ForkRepository` steps 1 + the async hand-off (fork.go:60-135 reduced to
 * the modeled surface): create through the repos service ('creating'), copy
 * the upstream-faithful metadata (default branch, description, private flag),
 * stamp `fork_parent`, and enqueue the replication message. Returns the
 * re-read fork row — the 202 body renders it with `fork: true` +
 * `parent` (routes/forks.ts toForkRepository).
 */
export async function createFork(
  d1: D1Database,
  deps: ForkServiceDeps,
  input: {
    source: RepositoryWithOwner;
    /** the fork's owner namespace (doer or org row — resolve + authorize in
     *  the route, the prepareDoerCreateRepoInOrg split). */
    targetOwner: { id: number; usernameLower: string };
    name: string;
  },
): Promise<{ fork: RepoRow; engineName: string }> {
  const source = input.source.repo;
  const service = new RepoService(d1);
  const created = await service.create({
    owner: input.targetOwner,
    name: input.name,
    isPrivate: source.visibility === "private",
    status: "creating",
  });

  // Upstream copies DefaultBranch + Description + IsPrivate at insert time.
  // default_branch is a Drizzle column; description rides the repo-edit side
  // store (the same one the createOrgRepo auto-init path writes); fork_parent
  // is the raw column until the migration sweep.
  const settings = await loadRepoSettings(d1, source.id);
  await drizzle(d1)
    .update(repositories)
    .set({ defaultBranch: source.defaultBranch, updatedAt: new Date() })
    .where(eq(repositories.id, created.id));
  if (settings.description !== "") {
    await saveRepoSettings(d1, created.id, { description: settings.description }, new Date());
  }
  await d1
    .prepare("UPDATE repositories SET fork_parent = ?1 WHERE id = ?2")
    .bind(source.id, created.id)
    .run();

  // The 202 contract: the replication is the queue's work. A lost enqueue
  // strands the fork in 'creating' — logged (the admin-notice equivalent),
  // never failing the user-facing create (the delete-purge enqueue posture).
  if (deps.queue !== undefined) {
    try {
      await deps.queue.send({ kind: "repo-fork", sourceRepoId: source.id, forkRepoId: created.id });
    } catch (error) {
      console.error(
        `[forks] replication enqueue failed for ${created.id} (fork stays 'creating'): ${errorMessage(error)}`,
      );
    }
  }

  const fork = await service.get(created.id);
  if (fork === null) throw new Error(`fork row vanished after creation: ${created.id}`);
  return { fork, engineName: `${fork.ownerNamespace}/${fork.slug}` };
}

/**
 * `FindForks` (fork.go:252-267): repository rows where `fork_parent` = the
 * source's id, ordered by the upstream `"id"` (our text id sorts numerically
 * via CAST — the listUserRepositories convention), filtered by the reduced
 * accessible-condition (admin all; doer + public; anonymous public only).
 * Owner rows hydrate through the users join (org forks included — orgs ARE
 * users rows, SPEC-0007).
 */
export async function listForks(
  d1: D1Database,
  sourceRepoId: string,
  options: { page: number; pageSize: number; doerLoginLower: string | null; isAdmin: boolean },
): Promise<{ items: RepositoryWithOwner[]; total: number }> {
  const visibility =
    options.isAdmin || options.doerLoginLower === null
      ? options.isAdmin
        ? { sql: "", params: [] as unknown[] }
        : { sql: "repositories.visibility = 'public'", params: [] as unknown[] }
      : {
          sql: "(repositories.visibility = 'public' OR repositories.owner_namespace = ?)",
          params: [options.doerLoginLower] as unknown[],
        };
  const where = "fork_parent = ?1" + (visibility.sql === "" ? "" : ` AND ${visibility.sql}`);
  const params: unknown[] = [sourceRepoId, ...visibility.params];

  const totalRow = await d1
    .prepare(`SELECT count(*) AS total FROM repositories WHERE ${where}`)
    .bind(...params)
    .first<{ total: number }>();
  const idRows = await d1
    .prepare(
      `SELECT id FROM repositories WHERE ${where} ORDER BY CAST(id AS INTEGER) ASC LIMIT ? OFFSET ?`,
    )
    .bind(...params, options.pageSize, (options.page - 1) * options.pageSize)
    .all<{ id: string }>();
  const ids = idRows.results.map((row) => row.id);
  if (ids.length === 0) {
    return { items: [], total: totalRow?.total ?? 0 };
  }
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

/**
 * The 202 body: upstream `convert.ToRepo(ctx, fork, Permission{AccessMode:
 * Owner})` for a fork (fork.go:168) — `fork: true`, `parent` = the source at
 * the viewer's own permissions, and the creator's embedded permissions block
 * is the full owner triple regardless of the generic viewer matrix (the
 * toCreatedOrgRepository pattern: an org-owned fork's creator is not the
 * ownerNamespace login).
 */
export function toForkRepository(
  viewer: Viewer,
  forkPair: RepositoryWithOwner,
  sourcePair: RepositoryWithOwner,
): Repository {
  return {
    ...toApiRepository(viewer, forkPair),
    fork: true,
    parent: toApiRepository(viewer, sourcePair),
    permissions: { admin: true, push: true, pull: true },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

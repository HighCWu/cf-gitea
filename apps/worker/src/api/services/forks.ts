import { and, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Registry } from "@cf-gitea/git-engine";

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
 *     `Repository.ForkID`) landed as the Drizzle column with migration 0009
 *     (the fifth raw-DDL sweep: this file's FORKS_DDL_STATEMENTS is deleted,
 *     the 0005/0007/0008 supersede pattern). No delete-cascade row is needed
 *     — the edge dies with the repositories row itself.
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
 *   - the base-repo `num_forks` counter bumps in the settle's one D1 batch,
 *     exactly-once with the CAS (fork-task.ts; migration 0031 — SPEC-0001b
 *     §5.3.1 row 2), and `forks_count` renders the column.
 *   - LFS pointers are not copied (no LFS model on the fork path yet).
 *   - a lost queue enqueue strands the fork in 'creating' (logged admin
 *     notice, the delete-purge enqueue posture) — upstream clones
 *     synchronously and cleans up on failure.
 */

/** Queue producer seam narrowed to the fork message family (mirrors
 *  ImportQueueProducer: tests inject a capturing stub). */
export interface ForkQueueProducer {
  send(message: Record<string, unknown>): Promise<unknown>;
}

export interface ForkServiceDeps {
  /** REPO_TASKS producer — the one repo-fork fan-out. Optional so pure-D1
   *  tests (and direct consumer drives) run without a queue. */
  queue?: ForkQueueProducer;
  /** Engine Registry DO stub — rides the fork row's create (REDEPLOY8: bare
   *  RepoService construction skips seedRepoExtras' upsert, so the fork
   *  404s on info/refs/clone until its replication push lands). Optional so
   *  pure-D1 tests run standalone; the route passes the gate's shape. */
  registry?: DurableObjectStub<Registry>;
}

/** One fork's creation record: the re-read fork row (status='creating'). */
export type CreatedFork = RepoRow;

/**
 * POST /repos/{owner}/{repo}/forks body guard (upstream CreateFork:
 * `GetUserFork` — at most one fork of a given source per owner, fork.go:78-88;
 * the error unwraps util.ErrAlreadyExist → the 409 family). Drizzle over the
 * 0009 `fork_parent` column (the raw SELECT it supersedes arbitrated the same
 * `fork_parent AND owner_id` pair — the fork_parent_idx serves it).
 */
export async function findForkByOwner(
  d1: D1Database,
  sourceRepoId: string,
  ownerId: number,
): Promise<{ id: string; ownerNamespace: string; slug: string } | null> {
  const row = await drizzle(d1)
    .select({
      id: repositories.id,
      ownerNamespace: repositories.ownerNamespace,
      slug: repositories.slug,
    })
    .from(repositories)
    .where(and(eq(repositories.forkParent, sourceRepoId), eq(repositories.ownerId, ownerId)))
    .limit(1)
    .get();
  return row ?? null;
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
  const service = new RepoService(d1, { registry: deps.registry });
  const created = await service.create({
    owner: input.targetOwner,
    name: input.name,
    isPrivate: source.visibility === "private",
    status: "creating",
  });

  // Upstream copies DefaultBranch + Description + IsPrivate at insert time.
  // default_branch and fork_parent are Drizzle columns (0009); description
  // rides the repo-edit side store (the same one the createOrgRepo auto-init
  // path writes).
  const settings = await loadRepoSettings(d1, source.id);
  await drizzle(d1)
    .update(repositories)
    .set({ defaultBranch: source.defaultBranch, forkParent: source.id, updatedAt: new Date() })
    .where(eq(repositories.id, created.id));
  if (settings.description !== "") {
    await saveRepoSettings(d1, created.id, { description: settings.description }, new Date());
  }

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
  // The reduced accessible-condition (admin all; doer + public; anonymous
  // public only) as Drizzle — the string filter the raw count/id SELECTs it
  // supersedes interpolated.
  const visibility =
    options.isAdmin || options.doerLoginLower === null
      ? options.isAdmin
        ? undefined
        : eq(repositories.visibility, "public")
      : or(eq(repositories.visibility, "public"), eq(repositories.ownerNamespace, options.doerLoginLower));
  const where =
    visibility === undefined
      ? eq(repositories.forkParent, sourceRepoId)
      : and(eq(repositories.forkParent, sourceRepoId), visibility);
  const db = drizzle(d1);

  const totalRow = await db
    .select({ total: sql<number>`count(*)` })
    .from(repositories)
    .where(where)
    .get();
  const idRows = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(where)
    .orderBy(sql`CAST(${repositories.id} AS INTEGER) ASC`)
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize)
    .all();
  const ids = idRows.map((row) => row.id);
  if (ids.length === 0) {
    return { items: [], total: totalRow?.total ?? 0 };
  }
  const rows = await db
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

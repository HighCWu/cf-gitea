/**
 * Fork replication — the REPO_TASKS consumer side (SPEC-0001b §5.3 steps 2-4,
 * wired to the API through the SPEC-0004 §2.4 `POST /repos/{owner}/{repo}/forks`
 * 202). The endpoint mints the fork's D1 row (new storage_key, owner = caller,
 * status='creating') and enqueues ONE `{kind: "repo-fork"}` message; THIS
 * module is the consumer the message lands on — the same dispatch point the
 * import channel's `{kind: "import-*"}` family uses (src/repos/purge.ts
 * handleRepoTasks), so a fork job shares the queue's max_batch_size=1 +
 * max_concurrency=1 serialization.
 *
 * The body is the engine's own replication loop (packages/git-engine
 * src/fork/replicate.ts, re-exported through the package boundary):
 * replicateForkCatalog(parentCell, forkCell, REPO_PACKS, {parentStorageKey,
 * forkStorageKey}) — paged catalog reads on the parent, streamed R2→R2 pack
 * copies (R2 has no server-side copy on the Workers binding), index-row
 * adoption on the fork, then the ONE finalizing transaction that lands refs +
 * HEAD + catalog and clears the importing gate. Pack bytes never ride the
 * DO→DO control plane; sqlite-location packs ride `packData` on the page and
 * are rehydrated into the fork's R2 prefix.
 *
 * Idempotence (queue redelivery is at-least-once): rows are keyed, copies
 * overwrite, and after a committed finalize `beginForkImport` refuses with
 * "fork target is not empty" — that exact refusal is the documented
 * already-done success (the engine docstring's consumer contract). Every other
 * failure throws → the queue retries the whole body from "".
 *
 * The D1 settle mirrors the import channel's settleDone (src/repos/imports/
 * service.ts): ONE CAS UPDATE flips `status='creating' → 'ready'` and copies
 * the source's emptiness (`is_empty=false` for a non-empty source) — 0 rows
 * changed on redelivery. The fork row was created EMPTY on purpose: nothing is
 * servable before finalize, so `empty:true` during the window is the honest
 * wire state (documented divergence from upstream, which copies IsEmpty from
 * the base before the clone).
 *
 * WEBHOOK (SPEC-0005 §3.5): the settle's winning invocation emits the `fork`
 * event through services/repo-events.ts — upstream's ForkRepository
 * (services/webhook/notifier.go:86-91), routed through the SOURCE repository
 * and CAS-gated so a redelivery never duplicates it. The source-vanished
 * degraded shell settles silently (nothing was replicated; no event).
 */

import { and, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  replicateForkCatalog,
  type ForkSourceRepo,
  type ForkTargetRepo,
  type ReplicateForkResult,
} from "@cf-gitea/git-engine";

import { apiUserFromRow, findRepositoryById, toApiRepository, type Viewer } from "../api/services/repository";
import { repositories } from "../db/schema";
import { emitRepoEventInline, forkEventPayload } from "../services/repo-events";
import { appOrigin } from "../services/webhooks-push";
import type { RepoRow } from "./service";

/** REPO_TASKS message of the fork family (the `{kind: "repo-fork", …}` shape
 *  the forks API enqueues right after minting the fork row). */
export interface RepoForkMessage {
  kind: "repo-fork";
  /** the D1 id of the fork's source (repositories.id). */
  sourceRepoId: string;
  /** the D1 id of the freshly minted fork row. */
  forkRepoId: string;
}

export function isForkMessage(value: unknown): value is RepoForkMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as RepoForkMessage).kind === "repo-fork" &&
    typeof (value as RepoForkMessage).sourceRepoId === "string" &&
    typeof (value as RepoForkMessage).forkRepoId === "string"
  );
}

/** The engine refusal that means "a previous run already finalized" — the
 *  documented idempotent-success arm (replicate.ts module doc). */
function isAlreadyFinalized(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("beginForkImport:") &&
    error.message.includes("fork target is not empty")
  );
}

/**
 * One fork message's work (exported so tests drive it without fabricating a
 * MessageBatch, the purgeRepoMessage convention). Re-reads BOTH rows fresh —
 * the message was enqueued by the 202, but storage keys/owner namespaces are
 * only trusted from D1 — then replicates and settles.
 */
export async function handleForkMessage(env: Env, msg: RepoForkMessage): Promise<void> {
  const db = drizzle(env.DB);
  const fork = await db.select().from(repositories).where(eq(repositories.id, msg.forkRepoId)).get();
  // The fork row was deleted while the message sat in the queue: nothing to
  // replicate into — the delete pipeline owns its storage, so just ack.
  if (fork === undefined) return;
  const source = await db.select().from(repositories).where(eq(repositories.id, msg.sourceRepoId)).get();
  if (source === undefined) {
    // The source vanished after the 202: there is nothing to copy, and a
    // retry would not bring it back. Settle the orphaned shell to ready-empty
    // (a visible empty repo beats one stuck in 'creating' forever) and leave
    // the admin notice.
    console.error(
      `[repo-tasks] fork ${fork.id}: source ${msg.sourceRepoId} no longer exists; settling the fork empty`,
    );
    await settleForkRow(db, fork, true);
    return;
  }

  await replicateRepoCopy(env, source, fork);

  const settled = await settleForkRow(db, fork, source.isEmpty);
  if (settled) {
    // `fork` event (upstream ForkRepository, notifier.go:86-91): emitted once
    // the fork is servable, gated on the settle's CAS so an at-least-once
    // redelivery never duplicates it. Upstream routes it through the SOURCE
    // repository (`EventSource{Repository: oldRepo}`) — its hooks and the
    // source owner's receive it — with `forkee` = the source and
    // `repository` = the new fork (the struct field doc is stale upstream;
    // the notifier is authoritative). Sender: the fork's owner IS the
    // creating doer (the forks route mints owner = caller); a future
    // org-target fork would render the org — none exist today.
    const [sourcePair, forkPair] = [
      await findRepositoryById(env.DB, source.id),
      await findRepositoryById(env.DB, fork.id),
    ];
    if (sourcePair !== null && forkPair !== null) {
      const viewer: Viewer = { origin: appOrigin(env), requester: null };
      await emitRepoEventInline(env, {
        repoId: sourcePair.repo.id,
        ownerId: sourcePair.owner.id,
        eventType: "fork",
        payload: forkEventPayload(
          toApiRepository(viewer, sourcePair),
          toApiRepository(viewer, forkPair),
          apiUserFromRow(forkPair.owner, viewer),
        ),
      });
    }
  }
}

/**
 * The engine's replication pass, shared by the fork consumer and the
 * template-generate API (POST /repos/{owner}/{repo}/generate —
 * api/services/generate-repo.ts rides THIS pass synchronously instead of
 * through the queue, so the 201 body describes a real repo; upstream
 * GenerateRepository is synchronous too). Structural stubs over the two
 * RepoCells (replicate.ts's ForkSourceRepo / ForkTargetRepo): the DO RPC
 * surface already matches; the adapters only strip the tag-peel cache field
 * the loop does not need.
 *
 * Idempotent the same way the consumer is: after a committed finalize,
 * `beginForkImport` refuses with "fork target is not empty" — that exact
 * refusal is the documented already-done success. Every other failure
 * throws (the queue retry arm / the route's error mapping).
 */
export async function replicateRepoCopy(env: Env, source: RepoRow, fork: RepoRow): Promise<void> {
  const parentCell = env.REPO.getByName(`${source.ownerNamespace}/${source.slug}`);
  const forkCell = env.REPO.getByName(`${fork.ownerNamespace}/${fork.slug}`);
  const parent: ForkSourceRepo = {
    listCatalogPage: (after, limit) => parentCell.listCatalogPage(after, limit),
    listRefs: async () => {
      const refs = await parentCell.listRefs();
      return { head: refs.head, refs: refs.refs.map((r) => ({ name: r.name, target: r.target })) };
    },
  };
  const target: ForkTargetRepo = {
    beginForkImport: (storageKey) => forkCell.beginForkImport(storageKey),
    adoptForkPacks: (page) => forkCell.adoptForkPacks(page),
    finalizeForkImport: (input) => forkCell.finalizeForkImport(input),
  };

  let result: ReplicateForkResult | null = null;
  try {
    result = await replicateForkCatalog(parent, target, env.REPO_PACKS, {
      parentStorageKey: source.storageKey,
      forkStorageKey: fork.storageKey,
    });
  } catch (error) {
    if (!isAlreadyFinalized(error)) throw error;
    // A committed finalize is already in place: the replication is done.
  }
  void result; // counts are observability-only today (no D1 columns for them)
}

/**
 * The import-settle pattern (imports/service.ts settleDone): one CAS UPDATE,
 * `status='creating' → 'ready'`, emptiness copied from the source. 0 rows
 * changed on a redelivery (or after a concurrent delete) — a no-op, never a
 * resurrection. Returns whether THIS invocation flipped the row — the fork
 * event's exactly-once gate (and the generate route's settle; upstream
 * GenerateRepository flips RepositoryBeingMigrated → RepositoryReady at the
 * end of the same flow, template.go:181-187).
 */
export async function settleForkRow(
  db: DrizzleD1Database,
  fork: RepoRow,
  sourceEmpty: boolean,
): Promise<boolean> {
  const settled = await db
    .update(repositories)
    .set({ status: "ready", isEmpty: sourceEmpty, updatedAt: new Date() })
    .where(and(eq(repositories.id, fork.id), eq(repositories.status, "creating")))
    .run();
  return (settled.meta.changes ?? 0) > 0;
}

/**
 * The REPO_TASKS dispatch arm (the shape purge.ts's handleRepoTasks uses for
 * the import family): run the work, ack; a throw retries THAT message. Split
 * from handleForkMessage so the consumer owns its ack/retry policy in one
 * place and the purge dispatcher's insertion stays three lines.
 */
export async function runForkTask(
  env: Env,
  body: RepoForkMessage,
  message: { id: string; ack(): void; retry(): void },
): Promise<void> {
  try {
    await handleForkMessage(env, body);
    message.ack();
  } catch (error) {
    console.error(
      `[repo-tasks] fork task ${message.id} retrying: ${error instanceof Error ? error.message : String(error)}`,
    );
    message.retry();
  }
}

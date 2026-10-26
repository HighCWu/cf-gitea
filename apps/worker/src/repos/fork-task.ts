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
 * The body is the SPEC-0001b §5.3 replication loop (packages/git-engine
 * src/fork/replicate.ts is the engine's reference form of it), brokered
 * WORKER-SIDE so the loose-object closure can land between adopt and
 * finalize: beginForkImport → paged parent reads on the catalog → streamed
 * R2→R2 pack copies (R2 has no server-side copy on the Workers binding) →
 * adoptForkPacks per page → the loose carry (carry.ts) → the ONE finalizing
 * transaction that lands refs + HEAD + catalog and clears the importing
 * gate. Pack bytes never ride the DO→DO control plane; sqlite-location packs
 * ride `packData` on the page and are rehydrated into the fork's R2 prefix.
 *
 * WHY the loop is not the engine's one-shot `replicateForkCatalog` anymore
 * (REDEPLOY13, docs/design/p0-evidence.md OPEN ISSUE 1): the engine loop
 * finalizes internally and finalize's object validation checks REF TIPS
 * only, so the old two-phase shape (run the loop; carry the loose class only
 * when finalize refuses with `object not imported`) silently skipped every
 * loose object that is NOT a tip. A template whose history is a real push
 * stacked on auto_init content has ALL tips packed while the auto_init
 * commit hangs off the packed tip's parent line — finalize succeeded, the
 * interior never carried, and the generated cell served API reads but died
 * on the git wire (upload-pack's walk threw `missing object` = the silent
 * 500; a later push's anti-check answered `missing necessary objects`).
 * The loose carry now runs UNCONDITIONALLY inside the open lease (the same
 * window the refusal arm used — putApiObjects is ungated during an import);
 * the walk stages nothing for packed oids and descends through packed
 * commits' cross-store edges, so a fully packed source pays a small bounded
 * read cost and a loose-only source pays exactly what the old arm paid.
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
 * FORK TALLY (migration 0031 `repositories.num_forks`): the settle is also
 * the parent's `num_forks` increment point (upstream bumps INSIDE
 * ForkRepository's creation transaction, services/repository/fork.go:110-113
 * → IncrementRepoForkNum, models/repo/fork.go:57-61 — the sole call site;
 * the template-generate copy never counts, GenerateRepository has no
 * IncrementRepoForkNum arm). The increment rides the SAME D1 batch as the
 * CAS, guarded by the fork row still being 'creating' — evaluated before the
 * CAS statement lands, so a redelivery (fork already 'ready') moves nothing,
 * exactly-once with the settle itself. Documented timing divergence: the
 * tally moves when the fork becomes SERVABLE (our settle), not at row mint
 * (upstream's create tx) — a pre-settle fork is not a servable fork, so the
 * parent's fork list/count stay consistent with what the API serves. The
 * fork-delete / child-reset decrements (delete.go:224-228 / :282-285) live
 * in the delete cascade — reported to the repos owner, not wired here.
 *
 * WEBHOOK (SPEC-0005 §3.5): the settle's winning invocation emits the `fork`
 * event through services/repo-events.ts — upstream's ForkRepository
 * (services/webhook/notifier.go:86-91), routed through the SOURCE repository
 * and CAS-gated so a redelivery never duplicates it. The source-vanished
 * degraded shell settles silently (nothing was replicated; no event).
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { copyObject, type RepoCell } from "@cf-gitea/git-engine";

import { apiUserFromRow, findRepositoryById, toApiRepository, type Viewer } from "../api/services/repository";
import { repositories } from "../db/schema";
import { emitRepoEventInline, forkEventPayload } from "../services/repo-events";
import { appOrigin } from "../services/webhooks-push";
import { syncRepoSizeFromStorage } from "../services/repo-size";
import { carryLooseRefs, idxR2Key, packR2Key } from "./carry";
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

/** The beginForkImport refusal that means "a previous run already finalized"
 *  — the documented idempotent-success arm (replicate.ts module doc: after a
 *  committed finalize the cell holds content and re-beginning is refused so a
 *  live repo's writes can never be gated forever). */
function isAlreadyFinalized(reason: string): boolean {
  return reason.includes("fork target is not empty");
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
    // the admin notice. The tally arm still rides along: its UPDATE targets
    // the vanished source row and matches nothing (an inert guard), the same
    // end state as upstream's decrement-on-parent-delete never having had a
    // counted fork to undo.
    console.error(
      `[repo-tasks] fork ${fork.id}: source ${msg.sourceRepoId} no longer exists; settling the fork empty`,
    );
    await settleForkRow(db, fork, true, { countTowardSourceId: msg.sourceRepoId });
    return;
  }

  await replicateRepoCopy(env, source, fork);

  const settled = await settleForkRow(db, fork, source.isEmpty, {
    countTowardSourceId: source.id,
  });
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
 * The SPEC-0001b §5.3 copy pass, shared by the fork consumer and the
 * template-generate API (POST /repos/{owner}/{repo}/generate —
 * api/services/generate-repo.ts rides THIS pass synchronously instead of
 * through the queue, so the 201 body describes a real repo; upstream
 * GenerateRepository is synchronous too). The adapters strip the stubs'
 * Promise-intersection types; the DO RPC surface already matches.
 *
 * Idempotent the same way the queue consumer is: after a committed finalize,
 * `beginForkImport` refuses with "fork target is not empty" — that exact
 * refusal is the documented already-done success. Every other failure
 * throws (the queue retry arm / the route's error mapping).
 *
 * The loose closure lands UNCONDITIONALLY inside the open import lease —
 * see the module header's WHY for the REDEPLOY13 wire residual this closes
 * (the old finalize-refusal-triggered arm only caught LOOSE TIPS; the
 * stacked-push shape's loose interior hides under packed tips' parent
 * lines). The loose carry rides carry.ts's `carryLooseRefs` against the two
 * cells directly (its structural `CarrySource`/`CarryTarget` surfaces).
 *
 * SIZE SETTLE (upstream services/repository/fork.go:190 / generate.go:295 —
 * UpdateRepoSize right after the copy): once the replication lands (or is
 * found already-finalized), the copy's byte footprint is re-accounted from
 * the FORK's own `repos/<fork.storage_key>/` prefix and persisted — the
 * fork inherits the source's footprint because it just received a physical
 * pack copy into that prefix (never copied from the source's column: the
 * numbers must describe the fork's own storage). generate-repo.ts rides the
 * same pass, so the generated repo settles its inherited footprint too.
 * Accounting failures never fail the replication (upstream fork.go:189-192's
 * "even if below operations failed, it could be ignored" posture — and a
 * throw here would loop the queue redelivery past an already-committed
 * copy): logged, size keeps its previous settled value until the next leg.
 */
export async function replicateRepoCopy(env: Env, source: RepoRow, fork: RepoRow): Promise<void> {
  const parentCell = env.REPO.getByName(`${source.ownerNamespace}/${source.slug}`);
  const forkCell = env.REPO.getByName(`${fork.ownerNamespace}/${fork.slug}`);
  const label = `${source.ownerNamespace}/${source.slug} -> ${fork.ownerNamespace}/${fork.slug}`;

  // §5.3 step 2 — open the lease. The not-empty refusal IS the already-done
  // success (the replication pass is skipped; the size settle below still
  // runs — the old error-driven arm fell through to it the same way);
  // everything else throws (the route maps it, the queue retries it).
  const begin = await forkCell.beginForkImport(fork.storageKey);
  const alreadyFinalized = begin.tag === "invalid" && isAlreadyFinalized(begin.reason);
  if (begin.tag === "invalid" && !alreadyFinalized) {
    throw new Error(`beginForkImport: ${begin.reason}`);
  }
  if (!alreadyFinalized) {
    await replicateCatalogAndLooseClosure(env, parentCell, forkCell, source, fork, label);
  }

  try {
    await syncRepoSizeFromStorage(env.REPO_PACKS, env.DB, fork);
  } catch (error) {
    console.error(
      `[repo-tasks] fork ${fork.id}: size settle failed (the copied fork stands): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The §5.3 steps 3-4 body behind replicateRepoCopy (called only with the
 * import lease open): the pack catalog loop, the ALWAYS-on loose closure,
 * and the one finalizing transaction. Split out so the already-finalized
 * redelivery arm reads as the one-line skip it is.
 */
async function replicateCatalogAndLooseClosure(
  env: Env,
  parentCell: DurableObjectStub<RepoCell>,
  forkCell: DurableObjectStub<RepoCell>,
  source: RepoRow,
  fork: RepoRow,
  label: string,
): Promise<void> {
  // §5.3 step 3 — the pack catalog loop (the engine replicate.ts body,
  // brokered here so the loose closure can land between adopt and finalize):
  // stream the bytes into the fork's prefix, then adopt the page (verifies
  // the copied tails, lands the page's index rows). A throw mid-loop leaves
  // the lease open — the queue's re-run re-begins (idempotent: rows keyed,
  // copies overwrite, staging replaced) and the generate route owns cleanup.
  const packed = new Set<string>();
  let cursor = "";
  for (;;) {
    const page = await parentCell.listCatalogPage(cursor, 8192);
    for (const p of page.packs) {
      if (p.rowsFrom !== "") continue; // continuation slice: bytes already moved
      const bucket = env.REPO_PACKS;
      if (!bucket) throw new Error(`fork copy ${label}: REPO_PACKS unbound`);
      const dstPack = packR2Key(fork.storageKey, p.packKey);
      if (p.location === "r2") {
        await copyObject(bucket, packR2Key(source.storageKey, p.packKey), dstPack);
      } else if (p.packData) {
        // sqlite-location pack: the bytes rode the page (DO-local pack_data
        // rehydration) — one plain put into the fork's prefix
        await bucket.put(dstPack, p.packData);
      } else {
        throw new Error(`fork copy ${label}: sqlite pack without inline bytes: ${p.packKey}`);
      }
      if (p.idxBytes > 0) {
        await copyObject(bucket, idxR2Key(source.storageKey, p.packKey), idxR2Key(fork.storageKey, p.packKey));
      }
    }
    for (const p of page.packs) for (const row of p.rows) packed.add(row.oid);
    const adopted = await forkCell.adoptForkPacks(page);
    if (adopted.tag === "invalid") throw new Error(`adoptForkPacks: ${adopted.reason}`);
    cursor = page.nextAfter;
    if (!page.more) break;
  }

  // The loose closure — ALWAYS, inside the same lease window (putApiObjects
  // is ungated during an import). Packed tips descend through their
  // cross-store edges; a fully packed source pays the small bounded read
  // cost and stages nothing.
  const refs = await parentCell.listRefs();
  const { carried, head, truncated } = await carryLooseRefs(parentCell, forkCell, refs.refs, refs.head, packed, label);
  if (truncated) {
    // Documented floor (carry.ts module doc): the descent died on its budget
    // before proving the closure complete — loud here, the copy still lands.
    console.error(
      `[repo-tasks] fork ${fork.id}: loose-closure descent truncated (${label}); the git wire may be incomplete for this cell`,
    );
  }

  // §5.3 step 4 — ONE finalizing transaction: catalog rows landed during
  // adopt; refs (+ cached tag peels) + HEAD + refs_version land now and the
  // importing gate clears. Nothing is servable before this transaction.
  const fin = await forkCell.finalizeForkImport({ refs: carried, head });
  if (fin.tag === "invalid") throw new Error(`finalizeForkImport: ${fin.reason}`);
}

/**
 * The import-settle pattern (imports/service.ts settleDone): one CAS UPDATE,
 * `status='creating' → 'ready'`, emptiness copied from the source. 0 rows
 * changed on a redelivery (or after a concurrent delete) — a no-op, never a
 * resurrection. Returns whether THIS invocation flipped the row — the fork
 * event's exactly-once gate (and the generate route's settle; upstream
 * GenerateRepository flips RepositoryBeingMigrated → RepositoryReady at the
 * end of the same flow, template.go:181-187).
 *
 * `options.countTowardSourceId` opts the FORK TALLY in (migration 0031
 * `repositories.num_forks`; the fork consumer passes the source's id, the
 * template-generate callers pass nothing — upstream counts forks at
 * ForkRepository only, services/repository/fork.go:110-113, never in
 * GenerateRepository). The increment PRECEDES the CAS inside the same D1
 * batch (one implicit transaction) and is guarded by the fork row still
 * being 'creating' — the guard is evaluated against the pre-CAS state, so
 * it rises and falls together with the CAS's own predicate: first delivery
 * bumps exactly once, a redelivery (row already 'ready') matches zero rows
 * on both statements, and a concurrently-vanished fork row leaves both
 * inert. A vanished SOURCE row likewise matches nothing — the orphaned-shell
 * settle rides through unchanged.
 */
export async function settleForkRow(
  db: DrizzleD1Database,
  fork: RepoRow,
  sourceEmpty: boolean,
  options?: { countTowardSourceId?: string },
): Promise<boolean> {
  const settle = db
    .update(repositories)
    .set({ status: "ready", isEmpty: sourceEmpty, updatedAt: new Date() })
    .where(and(eq(repositories.id, fork.id), eq(repositories.status, "creating")));
  if (options?.countTowardSourceId === undefined) {
    const settled = await settle.run();
    return (settled.meta.changes ?? 0) > 0;
  }
  const sourceId = options.countTowardSourceId;
  const results = await db.batch([
    db
      .update(repositories)
      .set({ numForks: sql`num_forks + 1` })
      .where(
        and(
          eq(repositories.id, sourceId),
          sql`EXISTS (SELECT 1 FROM repositories WHERE id = ${fork.id} AND status = 'creating')`,
        ),
      ),
    settle,
  ]);
  return (results[1]?.meta.changes ?? 0) > 0;
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

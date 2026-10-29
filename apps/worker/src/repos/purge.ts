/**
 * Repo delete purge — SPEC-0003 §2.5.5 steps 2-4 (the ENGINE-WAVE flip of the
 * M4 pipeline: the tombstone and destroy are now the real RepoCell RPCs, and
 * R2 addressing is the immutable D1 storage key).
 *
 *   - Tombstone (step 2): `RepoCell.markDeleted()` — sets meta.deleted=1 in
 *     one transaction; beginReceive refuses new leases ("repository
 *     deleted"), a finalize mid-flight aborts inside its commit transaction
 *     (§4.2), reads keep answering until destroy. Idempotent.
 *   - Queue purge (step 3): paged R2 `list` + batch `delete` over the two
 *     prefixes the storage-key-addressed engine ever writes for the repo
 *     (`repos/<storage_key>/` — packs, staging, clone cache — plus
 *     `imports/<storage_key>/`). Steps are idempotent; a purge that dies
 *     mid-way is retried by queue redelivery, and a prefix too large for one
 *     invocation's subrequest budget throws to trigger that redelivery (T3
 *     discipline).
 *   - Destroy (step 4, AFTER the R2 prefix purge — destroy does NOT touch
 *     R2): `RepoCell.destroy()` — one transactional wipe, alarm cleared,
 *     registry row removed via the engine's host hook. Idempotent.
 *
 * DO addressing stays by the combined engine name (`owner/repo`): the cell
 * binds its name from the request path, while the storage key (meta.storage_key,
 * persisted from the gate's x-storage-key header on receives) names the R2
 * prefixes. `engineNames` covers every combined name the repo was known by
 * (current + redirected — the registry-fix wave's cell carry makes each
 * rename leave a full copy at the successor name, so every listed cell holds
 * purgable content).
 */

import { isAuditRetentionMessage, pruneExpiredAuditEvents } from "../services/audit";
import { handlePackagesCleanup, isPackageCleanupMessage } from "../services/packages/cleanup";
import { DEMO_RETENTION_HOURS, isDemoSweepMessage } from "../services/demo-sweep";
import { handleMirrorSync, isMirrorSyncMessage } from "../services/mirror/sync";
import { handlePushMirrorSync, isPushMirrorSyncMessage } from "../services/mirror/push-sync";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import { handleImportTask, isImportMessage } from "./imports/pipeline";
import { isForkMessage, runForkTask } from "./fork-task";
import { RepoNotExistError, RepoService, type RepoRow } from "./service";

/** Queue message (REPO_TASKS): what the delete pipeline must purge.
 *  `storageKey` (r_<id>) names the R2 prefixes; `engineNames` is every
 *  combined name the repo was known by (current + redirected) — each names
 *  a RepoCell that must be tombstoned and destroyed. */
export interface RepoPurgeMessage {
  storageKey: string;
  engineNames: string[];
}

export function isRepoPurgeMessage(value: unknown): value is RepoPurgeMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RepoPurgeMessage).storageKey === "string" &&
    Array.isArray((value as RepoPurgeMessage).engineNames) &&
    (value as RepoPurgeMessage).engineNames.every((n) => typeof n === "string")
  );
}

/**
 * §2.5.5 step 2 — DO tombstone via the engine's markDeleted RPC. Idempotent:
 * tombstoning an already-tombstoned (or never-created) cell re-initializes an
 * empty one and marks it; destroy later wipes it either way.
 */
export async function tombstoneRepoDO(env: Env, engineName: string): Promise<void> {
  const result = await env.REPO.getByName(engineName).markDeleted();
  if (result.tag !== "ok") {
    // The engine's tagged union has a single variant today; guarded so a
    // future variant cannot silently pass as success.
    throw new Error(`repo DO tombstone for ${engineName}: unexpected ${JSON.stringify(result)}`);
  }
}

/** Subrequest budget for one consumer invocation (T3 discipline): deletes are
 *  batched (one call per up-to-1000-key page), but the cap keeps a huge
 *  prefix from starving the invocation. Exceeding it throws → redelivery. */
const MAX_DELETE_CALLS = 400;

/** Paged list + batch delete of one R2 prefix. Throws (for queue redelivery)
 *  when the subrequest budget runs out mid-prefix. */
async function purgePrefix(bucket: R2Bucket, prefix: string, budget: { calls: number }): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      if (++budget.calls > MAX_DELETE_CALLS) throw new Error(`purge budget exceeded at ${prefix}`);
      await bucket.delete(listed.objects.map((o) => o.key));
    }
    if (!listed.truncated) return;
    cursor = listed.cursor;
  }
}

/**
 * §2.5.5 step 3 — R2 prefix purge for the repo's immutable storage key
 * (repos/<storage_key>/ since the Step 3 key layout: packs, staging and the
 * clone cache share ONE prefix; imports/<storage_key>/ is the import
 * channel's). Idempotent; throws when the subrequest budget runs out (queue
 * redelivery resumes).
 */
export async function purgeRepoStorage(env: Env, storageKey: string): Promise<void> {
  const bucket = env.REPO_PACKS;
  if (!bucket) return;
  const budget = { calls: 0 };
  for (const prefix of [`repos/${storageKey}/`, `imports/${storageKey}/`]) {
    await purgePrefix(bucket, prefix, budget);
  }
}

/**
 * §2.5.5 step 4 — DO destroy via the engine's destroy RPC (after the R2
 * prefix purge; destroy wipes SQLite + the alarm and removes the registry
 * row, never R2). Idempotent: destroying a destroyed/never-created cell
 * re-initializes an empty one.
 */
export async function destroyRepoDO(env: Env, engineName: string): Promise<void> {
  const result = await env.REPO.getByName(engineName).destroy();
  if (result.tag !== "ok") {
    throw new Error(`repo DO destroy for ${engineName}: unexpected ${JSON.stringify(result)}`);
  }
}

/**
 * REPO_TASKS consumer. The message families share the queue (all serialized:
 * max_batch_size=1 + max_concurrency=1, SPEC-0003 §3.3):
 *
 *   - repo delete purges ({storageKey, engineNames}): tombstone every engine
 *     name, purge the storage-key R2 prefixes, then destroy — in that order,
 *     per SPEC-0003 §2.5.5.
 *   - import tasks ({kind: import-chunk|import-abort|import-sweep, …},
 *     SPEC-0003 §2.6): the chunked import pipeline (src/repos/imports/).
 *   - mirror syncs ({kind: "mirror-sync", repoId}, SPEC-0009 §2.6): one
 *     pull-mirror fetch window; the cron producer (src/index.ts scheduled →
 *     enqueueDueMirrorSyncs) CAS-guards the enqueue, and handleMirrorSync
 *     re-checks every state, so redelivery is safe. A throw is that
 *     handler's queue-retry signal.
 *   - demo sweeps ({kind: "demo-sweep", repoId}, SPEC-0014 §3.2): the
 *     DEMO_MODE-gated hourly producer's delete requests — handleDemoSweep
 *     re-checks exemption + age at consume time, then drives the SAME
 *     deleteRepository cascade as the API's DELETE route. No CAS on the
 *     enqueue: the row deletion is the claim, so redelivery (and the
 *     §3.0 DLQ redrive) is absorbed idempotently.
 *
 * Per message: idempotent work, then ack; a throw retries THAT message (the
 * redelivery re-runs the idempotent steps). Storage errors never fail the
 * user-facing delete — they surface here as queue retries, and after
 * max_retries land in the queue's dead-letter handling (the admin-notice
 * equivalent).
 */
export async function handleRepoTasks(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    if (isImportMessage(message.body)) {
      try {
        await handleImportTask(env, message.body);
        message.ack();
      } catch (error) {
        console.error(`[repo-tasks] import task ${message.id} retrying: ${error instanceof Error ? error.message : String(error)}`);
        message.retry();
      }
      continue;
    }
    if (isForkMessage(message.body)) {
      // runForkTask owns its ack/retry policy (fork-task.ts) — a throw
      // retries only this message. Without this arm the fork message fell
      // through to the malformed-purge drop: POST /forks answered 202 and
      // the replication NEVER ran (repo stuck 'creating') — found by the
      // webhook-emissions wave's survey, 2026-10-25.
      await runForkTask(env, message.body, message);
      continue;
    }
    if (isMirrorSyncMessage(message.body)) {
      try {
        await handleMirrorSync(env, { repoId: message.body.repoId });
        message.ack();
      } catch (error) {
        console.error(`[repo-tasks] mirror-sync ${message.id} retrying: ${error instanceof Error ? error.message : String(error)}`);
        message.retry();
      }
      continue;
    }
    // Push-mirror outbound sync (SPEC specs/push-mirror-outbound.md §4): one
    // message = one mirror row = one HTTPS push to the remote — the
    // pull direction's exact claim/retry discipline.
    if (isPushMirrorSyncMessage(message.body)) {
      try {
        await handlePushMirrorSync(env, { repoId: message.body.repoId, pushMirrorId: message.body.pushMirrorId });
        message.ack();
      } catch (error) {
        console.error(`[repo-tasks] push-mirror-sync ${message.id} retrying: ${error instanceof Error ? error.message : String(error)}`);
        message.retry();
      }
      continue;
    }
    // Demo sweep (SPEC-0014 §3.2) — BEFORE the purge fallback, like every
    // typed arm: a purge body has no `kind`, so an unclaimed demo message
    // would otherwise fall into the malformed-purge drop. No gate check
    // here on purpose: the gate arms the PRODUCER (services/demo-sweep.ts);
    // a message only exists because an armed producer enqueued it, and a
    // later gate flip-off must not strand the delete it already scheduled.
    if (isDemoSweepMessage(message.body)) {
      try {
        await handleDemoSweep(env, message.body.repoId);
        message.ack();
      } catch (error) {
        console.error(`[repo-tasks] demo-sweep ${message.id} retrying: ${error instanceof Error ? error.message : String(error)}`);
        message.retry();
      }
      continue;
    }
    // Audit retention (SPEC-0015 M4 §4.3) — the same typed-arm placement: a
    // paged drizzle delete, idempotent across redeliveries, window defaulting
    // to 90 on the consumer side (the producer is AUDIT_RETENTION_DAYS-gated
    // in services/demo-sweep.ts; no gate here, same rationale as demo-sweep).
    if (isAuditRetentionMessage(message.body)) {
      try {
        await pruneExpiredAuditEvents(env);
        message.ack();
      } catch (error) {
        console.error(`[repo-tasks] audit-retention ${message.id} retrying: ${error instanceof Error ? error.message : String(error)}`);
        message.retry();
      }
      continue;
    }
    // Packages cleanup (SPEC-0016 §4.4, ratified non-demo-gated but
    // probe-gated — the producer sends only when a rule is enabled OR an
    // expired orphan exists; failures swallowed at console.error so a broken
    // tail arm can never fail the invocation).
    if (isPackageCleanupMessage(message.body)) {
      try {
        await handlePackagesCleanup(env);
        message.ack();
      } catch (error) {
        console.error(`[repo-tasks] package-cleanup ${message.id} retrying: ${error instanceof Error ? error.message : String(error)}`);
        message.retry();
      }
      continue;
    }
    if (!isRepoPurgeMessage(message.body)) {
      console.error(`[repo-tasks] dropping malformed purge message ${message.id}`);
      message.ack();
      continue;
    }
    await purgeRepoMessage(env, message.body);
    message.ack();
  }
}

/** One purge message's work (exported so tests drive it without fabricating
 *  a MessageBatch; the steps are idempotent, so a redelivery re-runs them). */
export async function purgeRepoMessage(env: Env, body: RepoPurgeMessage): Promise<void> {
  // Step 2: tombstone every cell the repo was known under. Failures are
  // logged and the pipeline continues — the steps below still run, and a
  // redelivery re-executes the idempotent tombstone.
  for (const name of body.engineNames) {
    try {
      await tombstoneRepoDO(env, name);
    } catch (error) {
      console.error(`[repo-tasks] tombstone ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Step 3: R2 prefix purge under the immutable storage key. Throws on a
  // budget overrun → the queue redelivers before destroy ever runs.
  await purgeRepoStorage(env, body.storageKey);

  // Step 4 (final): destroy every cell. A failure throws so the redelivery
  // retries; destroy (and everything above it) is idempotent.
  for (const name of body.engineNames) {
    await destroyRepoDO(env, name);
  }

  // Registry backstop: destroy's host hook already removes the row for cells
  // whose meta bound a name; this sweep covers cells that were never reached
  // over HTTP. receivePack upserts heal any false removal.
  for (const name of body.engineNames) {
    try {
      await env.REGISTRY.getByName("registry").remove(name);
    } catch {
      // registry rows heal via receivePack upserts; nothing to do
    }
  }
}

/**
 * One demo-sweep message's work (SPEC-0014 §3.2, exported so tests drive it
 * without fabricating a MessageBatch). The demo arm adds NO deletion logic
 * of its own — it is a second caller of the same cascade the API's
 * `DELETE /repos/{owner}/{repo}` route and the gate's engine-shape DELETE
 * use:
 *
 *   1. Load the repo row; GONE → return normally (the arm acks) — a delete
 *      raced the sweep, and the user delete already ran this same cascade
 *      (§6.6; the mirror arm's missing-row posture).
 *   2. Re-check exemption and age at CONSUME time (§3.2 step 2 — the
 *      enqueue-to-consume window can change the verdict): the owner has
 *      become a site admin since enqueue (§6.3 — exemption is a property of
 *      the owner NOW) or the row is inside the retention window → return,
 *      no delete. A NULL owner has no exempting principal → swept.
 *   3. RepoService.deleteRepository — the EXISTING cascade unchanged: the
 *      D1 batch delete of the row + every dependent (the repositories row
 *      the batch's final statement), the synchronous DO tombstone + registry
 *      removal, then the enqueue of the standard {storageKey, engineNames}
 *      purge message whose consumer run finishes the R2 prefix purge +
 *      RepoDO.destroy() below. Row-deletion is the sweep's only claim (§3.1
 *      — no CAS), so a duplicate message finds the row gone and acks (§6.7).
 *
 * A RepoNotExistError from the cascade is caught-and-acked — the
 * idempotent-delete semantics deleteRepositoryViaEngineShape documents
 * (§3.4); anything else throws → the arm retries THAT message.
 */
export async function handleDemoSweep(env: Env, repoId: string): Promise<void> {
  const repo = await new RepoService(env.DB).get(repoId);
  if (repo === null) return;
  if (repo.ownerId !== null) {
    const owner = await drizzle(env.DB)
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, repo.ownerId))
      .get();
    if (owner?.isAdmin === true) return;
  }
  const cut = new Date(Date.now() - DEMO_RETENTION_HOURS * 60 * 60 * 1000);
  if (!(repo.createdAt < cut)) return;
  try {
    await new RepoService(env.DB, {
      registry: env.REGISTRY.getByName("registry"),
      queue: env.REPO_TASKS,
      tombstone: (engineName) => tombstoneRepoDO(env, engineName),
    }).deleteRepository(repo.id);
  } catch (error) {
    if (!(error instanceof RepoNotExistError)) throw error;
    // A concurrent delete won the race; the requested end state (the demo
    // repo gone) already holds — idempotent-delete semantics (§3.4).
  }
}

/**
 * The engine-admin DELETE shape (`DELETE /{owner}/{repo}`) for a D1-RESOLVED
 * repository, run through the sanctioned §2.5.5 pipeline instead of the
 * engine's bare cell wipe.
 *
 * Production finding (2026-10-24, security-wave follow-up): the gate used to
 * forward an authorized admin DELETE verbatim to the engine, whose handler
 * (packages/git-engine src/repo.ts DELETE "/") wipes the cell's SQLite and the
 * `repos/<storage_key>/` R2 prefix but knows nothing of D1 — the repositories
 * row and its dependents (redirects, transfer, counters, …) survived as an
 * orphan that still resolved, still gated every route, and pointed at dead
 * storage (`imports/<storage_key>/` was never reclaimed, and the burnt
 * UNIQUE(owner, slug) blocked re-creation). This helper is the fix's engine
 * side: the SAME pipeline as the Worker API channel (src/api/routes/repo.ts
 * repoDelete) — RepoService.deleteRepository's D1 cascade FIRST, then the
 * tombstone, then the queue purge whose final destroy is the ONLY cell wipe —
 * never a bare engine destroy. Callers (the gate's engine-path branch) must
 * have already decided the request with the matrix WRITE rows; the D1-missing
 * transitional population keeps the verbatim engine passthrough.
 *
 * The response is the engine's wire contract byte-for-byte (200, `deleted\n`)
 * so engine-shape callers keep working unchanged — scripts/deploy-smoke.mjs
 * checkCleanup asserts exactly this body.
 */
export async function deleteRepositoryViaEngineShape(env: Env, repo: RepoRow): Promise<Response> {
  try {
    await new RepoService(env.DB, {
      registry: env.REGISTRY.getByName("registry"),
      queue: env.REPO_TASKS,
      tombstone: (engineName) => tombstoneRepoDO(env, engineName),
    }).deleteRepository(repo.id);
  } catch (error) {
    if (!(error instanceof RepoNotExistError)) throw error;
    // A concurrent delete won the race; the requested end state (the repo
    // gone everywhere) already holds — idempotent-delete semantics, like the
    // engine's own wipe.
  }
  return new Response("deleted\n");
}

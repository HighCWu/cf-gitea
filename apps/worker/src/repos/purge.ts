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
 * (current + redirected renames/transfers re-seed fresh cells).
 */

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
 * REPO_TASKS consumer. Per message: tombstone every engine name (retry of a
 * step-2 failure is a no-op), purge the storage-key R2 prefixes, then destroy
 * every engine name as the FINAL step. Per AGENTS.md, storage errors never
 * fail the user-facing delete — they surface here as queue retries, and
 * after max_retries land in the queue's dead-letter handling (the
 * admin-notice equivalent).
 */
export async function handleRepoTasks(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
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

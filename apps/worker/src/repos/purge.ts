/**
 * Repo delete purge — SPEC-0003 §2.5.5 steps 2-3 (M4 pipeline, landed with
 * the M2 D1 halves).
 *
 * The engine exposes NO `markDeleted` / `destroy` RPCs (the RepoCell surface
 * is beginReceive/finalizeReceive/releaseReceive + the read RPCs; see
 * TODO(SPEC-0003 ENGINE-WAVE) in src/repos/service.ts). The best available
 * primitives, used here:
 *
 *   - Tombstone: a direct `DELETE /` request to the repo's DO (the same wipe
 *     the engine's admin DELETE drives): RepoCell drops its SQLite (refs
 *     never dangle; an in-flight finalizeReceive fails on the wiped lease
 *     table, §4.2) and purges the R2 pack prefixes. The `x-repo` header MUST
 *     carry the engine name — RepoCell binds its storage name from it.
 *   - Queue purge: paged R2 `list` + batch `delete` over every prefix the
 *     name-addressed engine ever wrote for the repo (`repos/<name>/`,
 *     `raw/<name>/`, `imports/<name>/`), plus a final Registry DO removal.
 *     Steps are idempotent; a purge that dies mid-way is retried by queue
 *     redelivery, and a prefix too large for one invocation's subrequest
 *     budget throws to trigger that redelivery (T3 discipline).
 *
 * TODO(SPEC-0003 ENGINE-WAVE): once RepoCell exposes markDeleted/destroy and
 * storage_key addressing, the tombstone becomes the real RPC and the purge
 * prefixes collapse to `repos/<storage_key>/` + `imports/<storage_key>/`.
 */

/** Queue message (REPO_TASKS): what the delete pipeline must purge.
 *  `engineNames` is every combined name the repo was known by (current +
 *  redirected) — the name-addressed engine spread storage across all of them;
 *  `storageKey` (r_<id>) is carried for the storage-key engine wave. */
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
 * §2.5.5 step 2 — DO tombstone. Wipes the repo DO's storage (gate: the Worker
 * is trusted infrastructure; the DO route has no auth of its own).
 * Idempotent: deleting an already-deleted/never-created DO re-initializes an
 * empty cell.
 */
export async function tombstoneRepoDO(env: Env, engineName: string): Promise<void> {
  // The DO-internal route is "/" (mod.ts rewrites the sub-path before
  // stub.fetch); RepoCell binds its persisted storage name (meta.repo → R2
  // prefixes) from x-repo — omitting it would rebind the cell to "repo".
  const req = new Request("https://repo-tasks.local/", {
    method: "DELETE",
    headers: { "x-repo": engineName },
  });
  const res = await env.REPO.getByName(engineName).fetch(req);
  if (!res.ok) {
    throw new Error(`repo DO tombstone for ${engineName} failed: HTTP ${res.status}`);
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
 * §2.5.5 step 3 — R2 prefix purge for one engine name. Idempotent; throws
 * when the subrequest budget runs out (queue redelivery resumes).
 */
export async function purgeRepoStorage(env: Env, engineName: string): Promise<void> {
  const bucket = env.REPO_PACKS;
  if (!bucket) return;
  const budget = { calls: 0 };
  for (const prefix of [`repos/${engineName}/`, `raw/${engineName}/`, `imports/${engineName}/`]) {
    await purgePrefix(bucket, prefix, budget);
  }
}

/**
 * REPO_TASKS consumer. Per message: tombstone every engine name (retry of a
 * step-2 failure is a no-op), purge the R2 prefixes, drop any Registry row
 * left behind. Per AGENTS.md, storage errors never fail the user-facing
 * delete — they surface here as queue retries, and after max_retries land in
 * the queue's dead-letter handling (the admin-notice equivalent).
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
 *  a MessageBatch; the steps are idempotent). */
export async function purgeRepoMessage(env: Env, body: RepoPurgeMessage): Promise<void> {
  for (const name of body.engineNames) {
    try {
      await tombstoneRepoDO(env, name);
    } catch (error) {
      console.error(`[repo-tasks] tombstone ${name}: ${error instanceof Error ? error.message : String(error)}`);
      // continue: the registry removal + prefix purge below still run
    }
    await purgeRepoStorage(env, name);
    try {
      await env.REGISTRY.getByName("registry").remove(name);
    } catch {
      // registry rows heal via receivePack upserts; nothing to do
    }
  }
}

/**
 * Repository-lifecycle webhook events (SPEC-0005 §3.5) — the SHARED emission
 * seam for every repo write path, the `services/issue-events.ts` pattern
 * (same header rationale: the §2.7 payload identity renders through
 * api/services/repository converters, and api/services/hooks.ts already
 * imports src/issues/webhooks.ts — putting api imports under that module
 * would close a cycle). Five callers fan the family out:
 *
 *   - the `/api/v1` repo create arms: createCurrentUserRepo
 *     (src/api/routes/user-repos.ts) and createOrgRepo
 *     (src/api/routes/org-repos.ts) — `repository` action=created;
 *   - repoEdit / repoDelete (src/api/routes/repo.ts) — `repository`
 *     action=renamed (with `changes.name.from`) / deleted;
 *   - the push-create settle handshake (src/git-http/gate.ts
 *     settleCreatingRepo) — `repository` action=created at the moment the
 *     'creating' row becomes real (upstream creates READY and notifies at
 *     once; our §2.5.2 crash-window settle is the honest equivalent);
 *   - the fork replication consumer (src/repos/fork-task.ts) — the `fork`
 *     event (upstream ForkRepository, notifier.go:86-91), routed through the
 *     SOURCE repository's hooks (upstream's `EventSource{Repository:
 *     oldRepo}`) with `forkee` = the source and `repository` = the fork.
 *
 * The delivery mechanics are emitIssueEvent's, moved verbatim (the routes'
 * inline-helper lineage): the delivery-row insert is AWAITED inline after the
 * mutation committed, failures are caught and logged, never propagated, and
 * the Queue producer ({deliveryId} batch) either hangs off the
 * executionCtx-guarded waitUntil (hono callers) or is awaited inline
 * (off-response callers that already run inside waitUntil / a queue consumer).
 * In-process callers without a queue binding leave the rows `pending` — the
 * durable source of truth.
 *
 * Upstream shapes (submodule pin fc4936884584):
 *   - RepositoryPayload (modules/structs/hook.go:566): action
 *     created|deleted|renamed (HookRepoAction, :557-562 — there is NO
 *     transfer action; upstream's webhookNotifier inherits NullNotifier's
 *     no-op TransferRepository, so our pending-transfer 202 and the
 *     transfer-accept route stay silent, upstream-faithful);
 *   - ForkPayload (hook.go:272): forkee/repository/sender — the notifier
 *     fills forkee with the SOURCE (oldRepo), not the fork (the stale field
 *     doc says otherwise; notifier.go:86-91 is authoritative).
 */

import { apiUserFromRow, toApiRepository, type RepositoryWithOwner, type Viewer } from "../api/services/repository";
import type { WebhookDeliveryMessage } from "../webhooks/consumer";
import { emitWebhookDeliveries, type HookEventType } from "../issues/webhooks";

/** Structural `ExecutionContext` (the hono getter's annotation and the
 *  generated global drifted — the routes' precedent): only waitUntil is
 *  consumed here. */
export interface RepoEventExecution {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The hono-shaped request source the route handlers hand over
 * (`Context<ApiEnv>` is structurally this). `executionCtx` is hono's GETTER:
 * it is read lazily inside `emitRepoEvent`'s guard, because reading it throws
 * for in-process callers (tests via router.fetch) that have no execution
 * context.
 */
export interface RepoEventRequest {
  /** Worker bindings (D1 for the fan-out, the optional Queue producer). */
  readonly env: Env;
  /** `Context.executionCtx` — read inside the try/catch (see above). */
  readonly executionCtx: RepoEventExecution;
}

/** One repo-family webhook event: where, who owns the repo, what, and the
 *  §2.7 payload (already rendered — see repositoryEventPayload/forkEventPayload). */
export interface RepoEventEmission {
  /** Repository the event happened on. */
  repoId: string;
  /** Owner (user/org) id for owner-level hooks; null = none resolvable. */
  ownerId: number | null;
  eventType: HookEventType;
  payload: unknown;
}

/** The `WEBHOOK_DELIVERY` Queue producer, when the binding is wired. */
function webhookDeliveryQueue(env: Env): {
  sendBatch(messages: { body: WebhookDeliveryMessage }[]): Promise<unknown>;
} | null {
  const candidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  if (candidate === undefined || candidate === null) return null;
  const queue = candidate as { sendBatch?: (messages: { body: WebhookDeliveryMessage }[]) => Promise<unknown> };
  return typeof queue.sendBatch === "function" ? { sendBatch: queue.sendBatch.bind(queue) } : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fanOut(
  env: Env,
  emission: RepoEventEmission,
  enqueue: ((deliveryIds: number[]) => Promise<void>) | undefined,
  logLabel: string,
): Promise<void> {
  try {
    await emitWebhookDeliveries(env.DB, { ...emission, refName: null }, { enqueue });
  } catch (error) {
    console.error(`[${logLabel}] webhook fan-out failed (${emission.eventType}): ${errorMessage(error)}`);
  }
}

/**
 * Fire one repo-family webhook event from a hono route: the delivery-row
 * insert is AWAITED inline (request-visible, the hooks.ts fireTestDelivery
 * precedent — upstream CreateHookTask is synchronous too) so tests and
 * downstream observers see the row when the response lands; failures are
 * caught and logged, never propagated into the response. Only the Queue
 * producer ({deliveryId} batch) hangs off the executionCtx-guarded waitUntil
 * — real worker invocations enqueue; in-process callers (tests via
 * router.fetch) have no executionCtx, skip the enqueue, and leave the rows
 * `pending` (the consumer's idempotent CAS makes a later enqueue a safe
 * replay).
 */
export async function emitRepoEvent(request: RepoEventRequest, emission: RepoEventEmission): Promise<void> {
  let execCtx: RepoEventExecution | undefined;
  try {
    execCtx = request.executionCtx;
  } catch {
    execCtx = undefined; // in-process caller (tests): no execution context
  }
  const queue = webhookDeliveryQueue(request.env);
  await fanOut(
    request.env,
    emission,
    queue !== null && execCtx !== undefined
      ? (deliveryIds) => {
          const batch = queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } })));
          execCtx.waitUntil(batch.then(undefined, (error: unknown) => {
            console.error(`[repo-events] delivery enqueue failed (${emission.eventType}): ${errorMessage(error)}`);
          }));
        }
      : undefined,
    "repo-events",
  );
}

/**
 * The off-response variant for callers with no hono request: the push-create
 * settle already runs inside `ctx.waitUntil` and the fork consumer inside a
 * queue invocation (15-minute wall budget), so the Queue batch is AWAITED
 * inline here. Same failure posture: caught, logged, never propagated.
 */
export async function emitRepoEventInline(env: Env, emission: RepoEventEmission): Promise<void> {
  const queue = webhookDeliveryQueue(env);
  await fanOut(
    env,
    emission,
    queue !== null
      ? (deliveryIds) => queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))).then(() => undefined)
      : undefined,
    "repo-events",
  );
}

/**
 * The shared RepositoryPayload wrapper (§2.7, modules/structs/hook.go:566).
 * `organization` is upstream's `ToUser(owner)` — the owner user row even when
 * that owner is a user, not an org (CreateRepository/DeleteRepository/
 * RenameRepository all pass the owner). `changes` renders only for the
 * renamed action (omitempty upstream).
 */
export function repositoryEventPayload(
  action: string,
  repository: unknown,
  organization: unknown,
  sender: unknown,
  options: { changes?: Record<string, { from: string }> } = {},
): Record<string, unknown> {
  return {
    action,
    repository,
    organization,
    sender,
    ...(options.changes === undefined ? {} : { changes: options.changes }),
  };
}

/**
 * The shared ForkPayload wrapper (§2.7, modules/structs/hook.go:272).
 * `forkee` is the SOURCE repository (notifier.go:86-91 — the struct field's
 * own doc comment is stale upstream).
 */
export function forkEventPayload(forkee: unknown, repository: unknown, sender: unknown): Record<string, unknown> {
  return { forkee, repository, sender };
}

/** The §2.7 identity block for the repo family: the repository object plus
 *  the owner user object upstream fills `organization` with, rendered by the
 *  same converters as the REST responses. */
export function repositoryEventIdentity(
  viewer: Viewer,
  pair: RepositoryWithOwner,
): { repository: unknown; organization: unknown } {
  return {
    repository: toApiRepository(viewer, pair),
    organization: apiUserFromRow(pair.owner, viewer),
  };
}

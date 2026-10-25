/**
 * Issue-family webhook events (SPEC-0005 §3.5) — the SHARED emission seam for
 * every issue write path.
 *
 * Two callers fan the same family out, and they must never diverge again:
 *
 *   - the `/api/v1` routes (src/api/routes/issues.ts): issueCreateIssue
 *     (opened, then closed when `form.closed`), issueEditIssue (edited on a
 *     title/body change, closed/reopened on a state transition) and
 *     issueCreateComment (issue_comment / pull_request_comment created);
 *   - the UI session write path (src/ui/pages/new-issue.tsx
 *     `createIssueFromForm`, the wave-4 new-issue form): the issues "opened"
 *     event, which that path previously never emitted (the wave-4 divergence
 *     — API-created issues notified subscribers, web-created ones did not).
 *
 * The delivery mechanics here are the routes' former inline helpers, moved
 * verbatim (behavior pinned by src/api/issues.test.ts's emitted-event
 * assertions): the delivery-row insert is AWAITED inline after the mutation
 * committed (request-visible — the hooks.ts fireTestDelivery precedent,
 * upstream CreateHookTask is synchronous too), failures are caught and
 * logged, never propagated, and only the Queue producer ({deliveryId} batch)
 * hangs off the executionCtx-guarded waitUntil — real worker invocations
 * enqueue; in-process callers (tests via router.fetch) have no execution
 * context, skip the enqueue, and leave the rows `pending` (the durable source
 * of truth; the consumer's idempotent CAS makes a later enqueue a safe
 * replay).
 *
 * The module sits beside webhooks-push.ts for the same reason that wave gave
 * (its header, "the builder lives HERE rather than in src/issues/webhooks.ts
 * because it composes api/services converters"): the §2.7 payload identity
 * (repository/sender) renders through api/services/repository converters, and
 * api/services/hooks.ts already imports src/issues/webhooks.ts — putting api
 * imports under that module would close a cycle. src/issues/webhooks.ts
 * stays the low-level delivery-row writer (§3.5 mechanics over a bare
 * D1Database); this module is the issue-family payload + emission layer over
 * it.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { toApiIssue } from "../api/services/issues";
import {
  apiUserFromRow,
  findRepositoryById,
  toApiRepository,
  type RepositoryWithOwner,
  type Viewer,
} from "../api/services/repository";
import { users } from "../db/schema";
import type { IssueRow } from "../issues/service";
import { emitWebhookDeliveries, type HookEventType } from "../issues/webhooks";
import type { Issue } from "../api/models/issue";
import type { WebhookDeliveryMessage } from "../webhooks/consumer";

/** Structural `ExecutionContext` (the hono getter's annotation and the
 *  generated global drifted — the routes' precedent): only waitUntil is
 *  consumed here. */
export interface IssueEventExecution {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The hono-shaped request source both write paths hand over — the API routes
 * (`Context<ApiEnv>`) and the UI router (`Context<{ Bindings: Env }>`) are
 * both structurally this. `executionCtx` is hono's GETTER: it is read lazily
 * inside `emitIssueEvent`'s guard, because reading it throws for in-process
 * callers (tests via router.fetch) that have no execution context.
 */
export interface IssueEventRequest {
  /** Worker bindings (D1 for the fan-out, the optional Queue producer). */
  readonly env: Env;
  /** `Context.executionCtx` — read inside the try/catch (see above). */
  readonly executionCtx: IssueEventExecution;
}

/** One issue-family webhook event: where, who owns the repo, what, and the
 *  §2.7 payload (already rendered — see issueEventPayload). */
export interface IssueEventEmission {
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

/**
 * Fire one issue-family webhook event. The delivery-row insert is AWAITED
 * inline (request-visible, the hooks.ts fireTestDelivery precedent — upstream
 * CreateHookTask is synchronous too) so tests and downstream observers see
 * the row when the response lands; failures are caught and logged, never
 * propagated into the response. Only the Queue producer ({deliveryId} batch)
 * hangs off the executionCtx-guarded waitUntil — real worker invocations
 * enqueue; in-process callers (tests via router.fetch) have no executionCtx,
 * skip the enqueue, and leave the rows `pending` (the durable source of
 * truth; the consumer's idempotent CAS makes a later enqueue a safe replay).
 */
export async function emitIssueEvent(request: IssueEventRequest, emission: IssueEventEmission): Promise<void> {
  let execCtx: IssueEventExecution | undefined;
  try {
    execCtx = request.executionCtx;
  } catch {
    execCtx = undefined; // in-process caller (tests): no execution context
  }
  const queue = webhookDeliveryQueue(request.env);
  try {
    await emitWebhookDeliveries(request.env.DB, { ...emission, refName: null }, {
      enqueue:
        queue !== null && execCtx !== undefined
          ? (deliveryIds) => {
              execCtx.waitUntil(
                queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))).then(undefined, (error: unknown) => {
                  console.error(`[issues] delivery enqueue failed (${emission.eventType}): ${errorMessage(error)}`);
                }),
              );
            }
          : undefined,
    });
  } catch (error) {
    console.error(`[issues] webhook fan-out failed (${emission.eventType}): ${errorMessage(error)}`);
  }
}

/**
 * The shared IssuePayload wrapper (§2.7, modules/structs/hook.go:435).
 */
export function issueEventPayload(
  action: string,
  apiIssue: Issue,
  index: number,
  repository: unknown,
  sender: unknown,
  options: { changes?: Record<string, { from: string }>; commitId?: string } = {},
): Record<string, unknown> {
  return {
    action,
    number: index,
    ...(options.changes === undefined ? {} : { changes: options.changes }),
    issue: apiIssue,
    repository,
    sender,
    commit_id: options.commitId ?? "",
  };
}

/** Issue-event bundle: the webhook `repository` object + doer sender + the
 *  owner id that resolves owner-level hooks (§3.5 step 1's repo ∪ owner ∪
 *  system union). */
export interface IssueEventIdentity {
  repository: unknown;
  sender: unknown;
  ownerId: number | null;
}

/** Assemble the bundle from a Viewer over a repo+owner pair — the identity
 *  half every issue payload embeds, rendered by the same §2.7 converters as
 *  the REST responses. */
export function issueEventIdentity(viewer: Viewer, pair: RepositoryWithOwner, sender: unknown): IssueEventIdentity {
  return {
    repository: toApiRepository(viewer, pair),
    sender,
    ownerId: pair.repo.ownerId,
  };
}

// ---------------------------------------------------------------------------
// The UI session write path (pages/new-issue.tsx — createIssueFromForm).
// ---------------------------------------------------------------------------

/** Inputs of the UI new-issue fan-out (emitSessionIssueOpened). */
export interface SessionIssueOpenedInput {
  /** The hono request source (the UI router's context, structurally). */
  request: IssueEventRequest;
  /** Instance origin the §2.7 payload URLs are built against (ctx.origin). */
  origin: string;
  /** The repository the issue was filed on. */
  repoId: string;
  /** The created issue row (IssuesService.createIssue's result). */
  issue: IssueRow;
  /** The session doer's user id — payload sender. */
  posterId: number;
}

/**
 * The UI new-issue write path's fan-out: the SAME `issues` "opened" event the
 * POST /repos/{owner}/{repo}/issues route emits (same payload builder, same
 * delivery mechanics through emitIssueEvent), assembled from what the session
 * path holds — the resolved repo row, the created issue, the session doer.
 *
 * The doer serializes through `apiUserFromRow` — the SAME converter that
 * renders the payload's embedded `repository.owner` (payload-internal
 * §2.7 consistency; the push-webhook sender precedent), self-rendered so the
 * doer sees their own email exactly like upstream's convert.ToUser(doer,
 * doer). The API route keeps its token-identity serialization (toApiUser) —
 * behavior-identical there, pinned by its own tests.
 *
 * Never throws: the identity assembly and the fan-out are best-effort (the
 * write already committed; a webhook failure must never fail it — the same
 * posture as the route, which renders its payload outside the try/catch but
 * whose create handler awaits an already-caught emit). Identity resolution
 * failures (orphaned repo row, missing doer row) log and skip, the push
 * wave's degradation rule.
 */
export async function emitSessionIssueOpened(input: SessionIssueOpenedInput): Promise<void> {
  try {
    const pair = await findRepositoryById(input.request.env.DB, input.repoId);
    if (pair === null) {
      console.error(`[issues] webhook fan-out skipped (opened): repository row missing [id: ${input.repoId}]`);
      return;
    }
    const poster =
      (await drizzle(input.request.env.DB).select().from(users).where(eq(users.id, input.posterId)).limit(1).all())[0] ?? null;
    if (poster === null) {
      console.error(`[issues] webhook fan-out skipped (opened): doer row missing [id: ${input.posterId}]`);
      return;
    }
    // Self-render bootstrap: apiUserFromRow reads only login/is_admin off the
    // viewer, so the first pass (anonymous viewer) yields the doer object the
    // second pass needs to authenticate the doer against themself.
    const viewer: Viewer = { origin: input.origin, requester: apiUserFromRow(poster, { origin: input.origin, requester: null }) };
    const identity = issueEventIdentity(viewer, pair, apiUserFromRow(poster, viewer));
    await emitIssueEvent(input.request, {
      repoId: pair.repo.id,
      ownerId: identity.ownerId,
      eventType: "issues",
      payload: issueEventPayload("opened", await toApiIssue(input.request.env.DB, viewer, pair, input.issue), input.issue.index, identity.repository, identity.sender),
    });
  } catch (error) {
    console.error(`[issues] webhook fan-out failed (opened): ${errorMessage(error)}`);
  }
}

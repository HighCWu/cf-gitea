/**
 * Webhook DLQ sweep + delivery-log cleanup (SPEC-0005 §3.6 poison/DLQ, §4.9).
 *
 * Two entry points, both driven by the cron/periodic job the orchestrator
 * wires (no cron wiring lives in this module):
 *
 * - `webhookDlqHandler` — consumer of the `webhook-delivery-dlq` Queue: a
 *   message only lands here after the delivery consumer exhausted
 *   `max_retries` without persisting an outcome (D1 unavailable, crash). The
 *   handler marks that row `state='failed'` (guarded to `pending`/`delivering`
 *   — never clobbering a recorded terminal state) with an explanatory
 *   fallback response when none was recorded, and acks. Poisoned message
 *   bodies are logged and acked: the sweep below is the safety net for them.
 * - `sweepStuckDeliveries` — the RepoDO-alarm-style periodic pass (§3.6):
 *   rows stuck in `delivering` (crash after the §3.6 CAS but before the
 *   outcome write — including deliveries whose queue message was lost
 *   entirely) older than a threshold are marked `failed`, so the delivery
 *   list never shows a perpetual `delivering`.
 * - `cleanupWebhookDeliveries` — §4.9 log growth control, upstream
 *   `CleanupHookTaskTable` parity (models/webhook/hooktask.go:218–280): keep
 *   the newest `perWebhook` (default 100) terminal rows per webhook and drop
 *   terminal rows older than `olderThanDays` (default 30). Only terminal rows
 *   (`delivered`/`skipped`/`failed`) are ever deleted — the upstream
 *   `is_delivered` guard — so in-flight and never-enqueued deliveries survive.
 *
 * ORCHESTRATOR INTEGRATION (see ./consumer header for the queue blocks):
 *
 * ```ts
 * // src/index.ts
 * import { webhookDlqHandler } from "./webhooks/dlq";
 * export { webhookDlqHandler };
 *
 * // scheduled handler (cron trigger in wrangler.jsonc):
 * async scheduled(_ctrl, env, ctx) {
 *   ctx.waitUntil(sweepStuckDeliveries(env.DB));
 *   ctx.waitUntil(cleanupWebhookDeliveries(env.DB));
 * }
 * ```
 */

import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { webhookDeliveries } from "../db/schema";
import type { WebhookDeliveryMessage } from "./consumer";

/** Structural slice of the Worker `Env` the DLQ consumer needs. */
export interface WebhookDlqEnv {
  DB: D1Database;
}

export interface WebhookDlqOptions {
  now?: Date;
}

export interface SweepOptions {
  /** Rows in `delivering` older than this are failed (default 15 min — far past the 5 s delivery timeout). */
  stuckAfterSeconds?: number;
  now?: Date;
}

export interface CleanupOptions {
  /** Newest N terminal rows kept per webhook (default 100, upstream `numberToKeep`). */
  perWebhook?: number;
  /** Terminal rows older than this many days are dropped (default 30, §4.9). */
  olderThanDays?: number;
  now?: Date;
}

export interface CleanupResult {
  /** Rows deleted by the age rule. */
  deletedByAge: number;
  /** Rows deleted by the newest-N-per-webhook rule. */
  deletedByCount: number;
  /** Webhooks the newest-N rule swept. */
  hooksSwept: number;
}

/** States whose outcome is final — the only rows cleanup may delete. */
const TERMINAL_STATES = ["delivered", "skipped", "failed"] as const;

/** Fallback `HookResponse` recorded for rows abandoned without any outcome. */
const ABANDONED_RESPONSE: string = JSON.stringify({
  status: 0,
  headers: {},
  body: "delivery abandoned: the consumer could not persist an outcome (dead-letter queue)",
});

/**
 * Mark one row `failed` if it never reached a terminal state. Returns true
 * when this call performed the transition.
 */
async function markStuckFailed(
  d1: D1Database,
  deliveryId: number,
  now: Date,
): Promise<boolean> {
  const db = drizzle(d1);
  const updated = await db
    .update(webhookDeliveries)
    .set({
      state: "failed",
      deliveredAt: now,
      responseContent: sql`COALESCE(${webhookDeliveries.responseContent}, ${ABANDONED_RESPONSE})`,
    })
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        inArray(webhookDeliveries.state, ["pending", "delivering"]),
      ),
    )
    .returning({ id: webhookDeliveries.id })
    .all();
  return updated.length > 0;
}

/**
 * The `webhook-delivery-dlq` Queue consumer. Wire as the `queue` export
 * alongside `webhookQueueHandler` (module header).
 */
export async function webhookDlqHandler(
  batch: MessageBatch<WebhookDeliveryMessage>,
  env: WebhookDlqEnv,
  _ctx?: ExecutionContext,
): Promise<void> {
  const now = new Date();
  for (const message of batch.messages) {
    const body: unknown = message.body;
    const deliveryId = typeof body === "object" && body !== null ? (body as { deliveryId?: unknown }).deliveryId : undefined;
    if (typeof deliveryId !== "number" || !Number.isInteger(deliveryId) || deliveryId <= 0) {
      // Poisoned body — nothing addressable; the stuck-row sweep covers the row.
      console.error(`webhook DLQ message with unaddressable body: ${JSON.stringify(body)}`);
      message.ack();
      continue;
    }
    try {
      const marked = await markStuckFailed(env.DB, deliveryId, now);
      if (marked) console.warn(`webhook delivery ${deliveryId} marked failed from DLQ`);
      message.ack();
    } catch (error) {
      console.error(
        `webhook DLQ could not mark delivery ${deliveryId} failed:`,
        error instanceof Error ? error.message : error,
      );
      message.retry();
    }
  }
}

/**
 * §3.6 periodic sweep — fail rows stuck in `delivering` older than
 * `stuckAfterSeconds`. Returns the number of rows transitioned.
 */
export async function sweepStuckDeliveries(d1: D1Database, options: SweepOptions = {}): Promise<number> {
  const db = drizzle(d1);
  const stuckAfterSeconds = options.stuckAfterSeconds ?? 900;
  const cutoff = new Date((options.now ?? new Date()).getTime() - stuckAfterSeconds * 1000);
  const updated = await db
    .update(webhookDeliveries)
    .set({
      state: "failed",
      deliveredAt: options.now ?? new Date(),
      responseContent: sql`COALESCE(${webhookDeliveries.responseContent}, ${ABANDONED_RESPONSE})`,
    })
    .where(and(eq(webhookDeliveries.state, "delivering"), lt(webhookDeliveries.createdAt, cutoff)))
    .returning({ id: webhookDeliveries.id })
    .all();
  return updated.length;
}

/**
 * §4.9 delivery-log cleanup (upstream `CleanupHookTaskTable` with both
 * `OlderThan` and `PerWebhook` policies applied). Returns the deletion counts.
 */
export async function cleanupWebhookDeliveries(
  d1: D1Database,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const db = drizzle(d1);
  const perWebhook = options.perWebhook ?? 100;
  const olderThanDays = options.olderThanDays ?? 30;
  const now = options.now ?? new Date();
  const ageCutoff = new Date(now.getTime() - olderThanDays * 86_400_000);

  // Age rule: terminal rows older than the cutoff (upstream OlderThan sweep,
  // restricted to our terminal states — upstream's `is_delivered` guard).
  const ageDeleted = await db
    .delete(webhookDeliveries)
    .where(
      and(inArray(webhookDeliveries.state, [...TERMINAL_STATES]), lt(webhookDeliveries.createdAt, ageCutoff)),
    )
    .returning({ id: webhookDeliveries.id })
    .all();

  // Newest-N rule: per webhook, keep the newest `perWebhook` terminal rows by
  // id (insertion order) and drop older terminal ones. Non-terminal rows are
  // outside both the keep-set (they have no place among delivered history)
  // and the deletion set (upstream never deletes undelivered tasks).
  const hooks = await db.selectDistinct({ hookId: webhookDeliveries.hookId }).from(webhookDeliveries).all();
  let countDeleted = 0;
  for (const hook of hooks) {
    const deleted = await db
      .delete(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.hookId, hook.hookId),
          inArray(webhookDeliveries.state, [...TERMINAL_STATES]),
          notInArray(
            webhookDeliveries.id,
            db
              .select({ id: webhookDeliveries.id })
              .from(webhookDeliveries)
              .where(
                and(eq(webhookDeliveries.hookId, hook.hookId), inArray(webhookDeliveries.state, [...TERMINAL_STATES])),
              )
              .orderBy(desc(webhookDeliveries.id))
              .limit(perWebhook),
          ),
        ),
      )
      .returning({ id: webhookDeliveries.id })
      .all();
    countDeleted += deleted.length;
  }

  return {
    deletedByAge: ageDeleted.length,
    deletedByCount: countDeleted,
    hooksSwept: hooks.length,
  };
}

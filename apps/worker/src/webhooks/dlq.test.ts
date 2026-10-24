/**
 * SPEC-0005 §3.6 (poison/DLQ) + §4.9 (delivery-log cleanup) tests for
 * `src/webhooks/dlq.ts` — real local D1, stub queue batches.
 */

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { webhookDeliveries, webhooks } from "../db/schema";
import type { WebhookDeliveryMessage } from "./consumer";
import { cleanupWebhookDeliveries, sweepStuckDeliveries, webhookDlqHandler } from "./dlq";
import { applyWebhooksD1Migrations } from "./testing/apply-d1-migrations";

beforeAll(applyWebhooksD1Migrations);

const db = () => drizzle(env.DB);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM webhook_deliveries").run();
  await env.DB.prepare("DELETE FROM webhooks").run();
});

async function seedHook(): Promise<number> {
  const rows = await db()
    .insert(webhooks)
    .values({ repoId: "r_test1", url: "http://receiver.test/hook", events: '{"send_everything":true}', isActive: true })
    .returning({ id: webhooks.id })
    .all();
  return rows[0]!.id;
}

async function seedDelivery(
  hookId: number,
  overrides: Partial<typeof webhookDeliveries.$inferInsert> = {},
): Promise<number> {
  const rows = await db()
    .insert(webhookDeliveries)
    .values({
      hookId,
      repoId: "r_test1",
      uuid: crypto.randomUUID(),
      eventType: "issues",
      eventGroup: "issues",
      payloadContent: "{}",
      state: "pending",
      createdAt: new Date(),
      ...overrides,
    })
    .returning({ id: webhookDeliveries.id })
    .all();
  return rows[0]!.id;
}

async function deliveryRow(id: number) {
  const row = await db().select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).get();
  if (row === undefined) throw new Error("delivery row vanished");
  return row;
}

function stubBatch(bodies: unknown[]): {
  batch: MessageBatch<WebhookDeliveryMessage>;
  acked: () => number;
  retried: () => number;
} {
  const counters = { ack: 0, retry: 0 };
  const batch: MessageBatch<WebhookDeliveryMessage> = {
    queue: "webhook-delivery-dlq",
    metadata: { metrics: { backlogCount: bodies.length, backlogBytes: 0 } },
    messages: bodies.map((body, index) => ({
      id: `dlq-${index}`,
      timestamp: new Date(),
      body: body as WebhookDeliveryMessage,
      attempts: 4,
      ack: () => {
        counters.ack++;
      },
      retry: () => {
        counters.retry++;
      },
    })),
    ackAll: () => {
      counters.ack += bodies.length;
    },
    retryAll: () => {
      counters.retry += bodies.length;
    },
  };
  return { batch, acked: () => counters.ack, retried: () => counters.retry };
}

describe("webhookDlqHandler (§3.6 poison/DLQ)", () => {
  it("marks a stuck delivering row failed with the abandoned-response fallback", async () => {
    const hookId = await seedHook();
    const deliveryId = await seedDelivery(hookId, { state: "delivering", attempts: 1 });
    const { batch, acked, retried } = stubBatch([{ deliveryId }]);
    await webhookDlqHandler(batch, { DB: env.DB }, {} as ExecutionContext);
    expect(acked()).toBe(1);
    expect(retried()).toBe(0);
    const row = await deliveryRow(deliveryId);
    expect(row.state).toBe("failed");
    expect(row.isSucceed).toBe(false);
    expect(row.deliveredAt).not.toBeNull();
    const response = JSON.parse(row.responseContent ?? "{}") as { status: number; body: string };
    expect(response.status).toBe(0);
    expect(response.body).toContain("dead-letter queue");
  });

  it("never clobbers a recorded outcome or terminal state", async () => {
    const hookId = await seedHook();
    const delivered = await seedDelivery(hookId, {
      state: "delivered",
      isSucceed: false,
      responseContent: '{"status":500,"headers":{},"body":"boom"}',
    });
    const failed = await seedDelivery(hookId, { state: "failed" });
    const { batch, acked, retried } = stubBatch([{ deliveryId: delivered }, { deliveryId: failed }]);
    await webhookDlqHandler(batch, { DB: env.DB }, {} as ExecutionContext);
    expect(acked()).toBe(2);
    expect(retried()).toBe(0);
    expect((await deliveryRow(delivered)).state).toBe("delivered");
    expect((await deliveryRow(delivered)).responseContent).toBe('{"status":500,"headers":{},"body":"boom"}');
    expect((await deliveryRow(failed)).state).toBe("failed");
  });

  it("acks unaddressable bodies (the stuck-row sweep covers their rows)", async () => {
    const { batch, acked, retried } = stubBatch([{ oops: true }, "junk"]);
    await webhookDlqHandler(batch, { DB: env.DB }, {} as ExecutionContext);
    expect(acked()).toBe(2);
    expect(retried()).toBe(0);
  });
});

describe("sweepStuckDeliveries (§3.6 periodic pass)", () => {
  it("fails old delivering rows and leaves fresh, pending, and terminal rows alone", async () => {
    const hookId = await seedHook();
    const now = Date.now();
    const stale = await seedDelivery(hookId, {
      state: "delivering",
      attempts: 1,
      createdAt: new Date(now - 20 * 60_000),
    });
    const fresh = await seedDelivery(hookId, { state: "delivering", attempts: 1, createdAt: new Date(now) });
    const pending = await seedDelivery(hookId, { createdAt: new Date(now - 20 * 60_000) });
    const done = await seedDelivery(hookId, {
      state: "delivered",
      isSucceed: true,
      createdAt: new Date(now - 20 * 60_000),
    });

    const swept = await sweepStuckDeliveries(env.DB, { stuckAfterSeconds: 900, now: new Date(now) });
    expect(swept).toBe(1);
    expect((await deliveryRow(stale)).state).toBe("failed");
    expect((await deliveryRow(fresh)).state).toBe("delivering");
    expect((await deliveryRow(pending)).state).toBe("pending");
    expect((await deliveryRow(done)).state).toBe("delivered");
  });

  it("keeps a recorded partial outcome when failing a stuck row", async () => {
    const hookId = await seedHook();
    const withOutcome = await seedDelivery(hookId, {
      state: "delivering",
      attempts: 1,
      createdAt: new Date(Date.now() - 20 * 60_000),
      requestContent: '{"url":"http://receiver.test/hook","http_method":"POST","headers":{},"body":"{}"}',
    });
    await sweepStuckDeliveries(env.DB, {});
    const row = await deliveryRow(withOutcome);
    expect(row.state).toBe("failed");
    expect(row.requestContent).not.toBeNull(); // request info survives
    expect(row.responseContent).toContain("dead-letter queue"); // only the response was missing
  });
});

describe("cleanupWebhookDeliveries (§4.9)", () => {
  it("keeps the newest N terminal rows per webhook and never deletes pending rows", async () => {
    const hookId = await seedHook();
    const firstId = await seedDelivery(hookId, { state: "delivered", isSucceed: true });
    for (let i = 1; i < 105; i++) {
      await seedDelivery(hookId, { state: "delivered", isSucceed: true });
    }
    await seedDelivery(hookId, { state: "pending" });
    await seedDelivery(hookId, { state: "pending" });

    const result = await cleanupWebhookDeliveries(env.DB, { perWebhook: 100 });
    expect(result.deletedByCount).toBe(5);
    const remaining = await db().select().from(webhookDeliveries).all();
    expect(remaining).toHaveLength(102); // 100 terminal + 2 pending
    expect(remaining.filter((row) => row.state === "pending")).toHaveLength(2);
    // the kept terminal rows are the newest hundred: the first five are gone
    const deliveredIds = remaining.filter((row) => row.state === "delivered").map((row) => row.id);
    expect(deliveredIds).toHaveLength(100);
    expect(Math.min(...deliveredIds)).toBe(firstId + 5);
    expect(Math.max(...deliveredIds)).toBe(firstId + 104);
  });

  it("deletes only terminal rows older than the cutoff (age rule)", async () => {
    const hookId = await seedHook();
    const old = new Date(Date.now() - 40 * 86_400_000);
    const recent = new Date(Date.now() - 1 * 86_400_000);
    const oldDelivered = await seedDelivery(hookId, { state: "delivered", createdAt: old });
    const oldPending = await seedDelivery(hookId, { state: "pending", createdAt: old });
    const oldStuck = await seedDelivery(hookId, { state: "delivering", createdAt: old });
    const recentDelivered = await seedDelivery(hookId, { state: "delivered", createdAt: recent });

    const result = await cleanupWebhookDeliveries(env.DB, { olderThanDays: 30 });
    expect(result.deletedByAge).toBe(1);
    expect((await deliveryRow(recentDelivered)).state).toBe("delivered");
    expect((await deliveryRow(oldPending)).state).toBe("pending");
    expect((await deliveryRow(oldStuck)).state).toBe("delivering");
    await expect(deliveryRow(oldDelivered)).rejects.toThrow();
  });

  it("applies both rules across several hooks", async () => {
    const hookA = await seedHook();
    const hookB = await seedHook();
    for (let i = 0; i < 3; i++) await seedDelivery(hookA, { state: "delivered", isSucceed: true });
    for (let i = 0; i < 3; i++) await seedDelivery(hookB, { state: "delivered", isSucceed: true });

    const result = await cleanupWebhookDeliveries(env.DB, { perWebhook: 2 });
    expect(result.hooksSwept).toBe(2);
    expect(result.deletedByCount).toBe(2);
    const rows = await db().select().from(webhookDeliveries).all();
    expect(rows).toHaveLength(4);
    const perHook = new Map<number, number>();
    for (const row of rows) perHook.set(row.hookId, (perHook.get(row.hookId) ?? 0) + 1);
    expect(perHook.get(hookA)).toBe(2);
    expect(perHook.get(hookB)).toBe(2);
  });
});

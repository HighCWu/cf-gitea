/**
 * SPEC-0005 §3.6/§5.1/§5.2 unit tests for the webhook delivery Queue consumer
 * — real local D1 (generated migrations in beforeAll), a fetch stub receiver
 * (NO real network — the fetchImpl seam), and stub queue batches.
 */

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { webhookDeliveries, webhooks } from "../db/schema";
import { emitWebhookDeliveries } from "../issues/webhooks";
import {
  WEBHOOK_RESPONSE_LIMIT_BYTES,
  buildWebhookRequest,
  computeWebhookSignatures,
  processWebhookDelivery,
  runWebhookDeliveryBatch,
  type WebhookDeliveryMessage,
} from "./consumer";
import { applyWebhooksD1Migrations } from "./testing/apply-d1-migrations";

beforeAll(applyWebhooksD1Migrations);

const db = () => drizzle(env.DB);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM webhook_deliveries").run();
  await env.DB.prepare("DELETE FROM webhooks").run();
});

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

const PAYLOAD = JSON.stringify(
  { action: "opened", number: 1, issue: { id: 7 }, repository: { id: 3 }, sender: { id: 5 } },
  null,
  2,
);

async function seedHook(overrides: Partial<typeof webhooks.$inferInsert> = {}): Promise<number> {
  const rows = await db()
    .insert(webhooks)
    .values({
      repoId: "r_test1",
      url: "http://receiver.test/hook",
      events: JSON.stringify({ send_everything: true }),
      isActive: true,
      secret: "s3cr3t",
      ...overrides,
    })
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
      payloadContent: PAYLOAD,
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

async function hookRow(id: number) {
  const row = await db().select().from(webhooks).where(eq(webhooks.id, id)).get();
  if (row === undefined) throw new Error("webhook row vanished");
  return row;
}

// ---------------------------------------------------------------------------
// Fetch stub receiver (§5.2 "in-test HTTP receiver")
// ---------------------------------------------------------------------------

interface ReceivedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function receiverStub(handler: (call: ReceivedCall) => Response | Promise<Response>) {
  const calls: ReceivedCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Copy the plain record as-is: the consumer passes its own header record
    // (upstream canonical case) and workerd's Headers would lowercase names.
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      for (const [key, value] of Object.entries(init.headers)) {
        headers[key] = String(value);
      }
    }
    const call: ReceivedCall = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchImpl };
}

/** A receiver that only aborts when the delivery timeout fires. */
function neverRespondingReceiver() {
  const fetchImpl = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const reason: unknown = init.signal?.reason;
        reject(reason instanceof Error ? reason : new Error("delivery timed out"));
      });
    });
  return { fetchImpl };
}

interface StubbedMessage {
  body: unknown;
}

function stubBatch(messages: StubbedMessage[]): {
  batch: MessageBatch<WebhookDeliveryMessage>;
  acked: () => number;
  retried: () => number;
} {
  const counters = { ack: 0, retry: 0 };
  const batch: MessageBatch<WebhookDeliveryMessage> = {
    queue: "webhook-delivery",
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
    messages: messages.map((message, index) => ({
      id: `msg-${index}`,
      timestamp: new Date(),
      body: message.body as WebhookDeliveryMessage,
      attempts: 1,
      ack: () => {
        counters.ack++;
      },
      retry: () => {
        counters.retry++;
      },
    })),
    ackAll: () => {
      counters.ack += messages.length;
    },
    retryAll: () => {
      counters.retry += messages.length;
    },
  };
  return { batch, acked: () => counters.ack, retried: () => counters.retry };
}

// ---------------------------------------------------------------------------
// Signatures — known HMAC vectors
// ---------------------------------------------------------------------------

describe("computeWebhookSignatures (known HMAC vectors)", () => {
  it("matches RFC 2202 HMAC-SHA1 test case 1", async () => {
    // key = 0x0b repeated 20 times, data "Hi There"
    const key = "\u000b".repeat(20);
    const sig = await computeWebhookSignatures(key, "Hi There");
    expect(sig.sha1).toBe("b617318655057264e28bc0b6fb378c8ef146be00");
  });

  it("matches RFC 4231 HMAC-SHA256 test case 2", async () => {
    const sig = await computeWebhookSignatures("Jefe", "what do ya want for nothing?");
    expect(sig.sha256).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("matches RFC 2202 HMAC-SHA1 test case 2 over the same data", async () => {
    const sig = await computeWebhookSignatures("Jefe", "what do ya want for nothing?");
    expect(sig.sha1).toBe("effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
  });

  it("returns empty signatures for an empty secret (headers still sent)", async () => {
    const sig = await computeWebhookSignatures("", PAYLOAD);
    expect(sig.sha1).toBe("");
    expect(sig.sha256).toBe("");
  });
});

describe("buildWebhookRequest (§2.6 header set / §2.7 byte shape)", () => {
  const delivery = { uuid: "uuid-1", eventType: "pull_request_comment", eventGroup: "issue_comment" };
  const signatures = { sha1: "a1b2", sha256: "c3d4" };
  const hook = {
    url: "http://receiver.test/hook",
    httpMethod: "POST",
    contentType: 1,
    headerAuthorizationEncrypted: null,
  };

  it("builds the full upstream header set with target type", () => {
    const built = buildWebhookRequest({
      hook,
      payloadText: PAYLOAD,
      delivery,
      targetType: "repository",
      signatures,
    });
    expect(built.method).toBe("POST");
    expect(built.headers["X-Gitea-Delivery"]).toBe("uuid-1");
    expect(built.headers["X-Gitea-Event"]).toBe("issue_comment");
    expect(built.headers["X-Gitea-Event-Type"]).toBe("pull_request_comment");
    expect(built.headers["X-Gitea-Signature"]).toBe("c3d4");
    expect(built.headers["X-Gitea-Hook-Installation-Target-Type"]).toBe("repository");
    expect(built.headers["X-Gogs-Delivery"]).toBe("uuid-1");
    expect(built.headers["X-Gogs-Signature"]).toBe("c3d4");
    expect(built.headers["X-Hub-Signature"]).toBe("sha1=a1b2");
    expect(built.headers["X-Hub-Signature-256"]).toBe("sha256=c3d4");
    expect(built.headers["X-GitHub-Delivery"]).toBe("uuid-1");
    expect(built.headers["X-GitHub-Hook-Installation-Target-Type"]).toBe("repository");
    expect(built.headers["Content-Type"]).toBe("application/json");
    expect(built.body).toBe(PAYLOAD);
  });

  it("encodes the form variant as payload=<urlencoded>", () => {
    const built = buildWebhookRequest({
      hook: { ...hook, contentType: 2 },
      payloadText: PAYLOAD,
      delivery,
      targetType: "repository",
      signatures,
    });
    expect(built.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(built.body?.startsWith("payload=")).toBe(true);
    expect(new URLSearchParams(built.body ?? "").get("payload")).toBe(PAYLOAD);
  });

  it("puts the payload into the query string for GET and keeps the logged body", () => {
    const built = buildWebhookRequest({
      hook: { ...hook, httpMethod: "GET" },
      payloadText: PAYLOAD,
      delivery,
      targetType: "repository",
      signatures,
    });
    expect(built.method).toBe("GET");
    expect(built.body).toBeNull();
    expect(new URL(built.url).searchParams.get("payload")).toBe(PAYLOAD);
    expect(built.loggedBody).toBe(PAYLOAD); // upstream logs the payload as body
  });

  it("rejects PUT (matrix v1-only upstream, we always store version 2)", () => {
    expect(() =>
      buildWebhookRequest({
        hook: { ...hook, httpMethod: "PUT" },
        payloadText: PAYLOAD,
        delivery,
        targetType: "repository",
        signatures,
      }),
    ).toThrow("invalid http method: PUT");
  });

  it("adds the Authorization header from the stored column", () => {
    const built = buildWebhookRequest({
      hook: { ...hook, headerAuthorizationEncrypted: "Bearer abc" },
      payloadText: PAYLOAD,
      delivery,
      targetType: "repository",
      signatures,
    });
    expect(built.headers["Authorization"]).toBe("Bearer abc");
  });
});

// ---------------------------------------------------------------------------
// §3.6 consumer algorithm against real D1
// ---------------------------------------------------------------------------

describe("§3.6 delivery — success path", () => {
  it("delivers a producer-emitted event end to end (§5.2 roundtrip)", async () => {
    const hookId = await seedHook();
    const enqueued: number[][] = [];
    const { deliveryIds } = await emitWebhookDeliveries(
      env.DB,
      { repoId: "r_test1", eventType: "issues", payload: JSON.parse(PAYLOAD) },
      { enqueue: (ids) => void enqueued.push(ids) },
    );
    expect(enqueued).toHaveLength(1);
    expect(deliveryIds).toEqual(enqueued[0]);

    const { calls, fetchImpl } = receiverStub(() =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Receiver": "yes" },
      }),
    );
    const outcome = await processWebhookDelivery(env.DB, { deliveryId: deliveryIds[0]! }, {}, { fetchImpl });
    expect(outcome).toEqual({ kind: "delivered", isSucceed: true });
    expect(calls).toHaveLength(1);

    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.body).toBe(PAYLOAD); // §2.7 2-space byte shape signed & sent
    const row = await deliveryRow(deliveryIds[0]!);
    expect(call.headers["X-Gitea-Delivery"]).toBe(row.uuid);
    expect(call.headers["X-Gitea-Event"]).toBe("issues");
    expect(call.headers["X-Gitea-Event-Type"]).toBe("issues");
    expect(call.headers["X-Gitea-Hook-Installation-Target-Type"]).toBe("repository");
    // signatures verify against the received raw body
    const expected = await computeWebhookSignatures("s3cr3t", PAYLOAD);
    expect(call.headers["X-Gitea-Signature"]).toBe(expected.sha256);
    expect(call.headers["X-Hub-Signature"]).toBe(`sha1=${expected.sha1}`);
    expect(call.headers["X-Hub-Signature-256"]).toBe(`sha256=${expected.sha256}`);

    expect(row.state).toBe("delivered");
    expect(row.isSucceed).toBe(true);
    expect(row.attempts).toBe(1);
    const request = JSON.parse(row.requestContent ?? "{}") as { url: string; http_method: string; body: string; headers: Record<string, string> };
    expect(request.http_method).toBe("POST");
    expect(request.body).toBe(PAYLOAD);
    expect(request.headers["X-Gitea-Event"]).toBe("issues");
    const response = JSON.parse(row.responseContent ?? "{}") as { status: number; body: string; headers: Record<string, string> };
    expect(response.status).toBe(200);
    expect(response.body).toBe('{"ok":true}');
    expect(response.headers["x-receiver"]).toBe("yes");
    expect(row.deliveredAt).not.toBeNull();
    expect((await hookRow(hookId)).lastStatus).toBe(1); // HookStatus.Succeed
  });

  it("resolves owner-level hooks to the user target type and system hooks to system", async () => {
    const ownerHook = await seedHook({ repoId: null, ownerId: 42 });
    const systemHook = await seedHook({ repoId: null, ownerId: null, isSystemWebhook: true });
    const seen: string[] = [];
    const { fetchImpl } = receiverStub((call) => {
      seen.push(call.headers["X-Gitea-Hook-Installation-Target-Type"]!);
      return new Response(null, { status: 200 });
    });
    const a = await seedDelivery(ownerHook);
    const b = await seedDelivery(systemHook);
    await processWebhookDelivery(env.DB, { deliveryId: a }, {}, { fetchImpl });
    await processWebhookDelivery(env.DB, { deliveryId: b }, {}, { fetchImpl });
    expect(seen).toEqual(["user", "system"]);
  });
});

describe("§3.6 CAS idempotency (queue redelivery guard)", () => {
  it("acks as a no-op when the row is not pending (crashed first attempt)", async () => {
    const hookId = await seedHook();
    const deliveryId = await seedDelivery(hookId, { state: "delivering", attempts: 1 });
    const { calls, fetchImpl } = receiverStub(() => {
      throw new Error("must not send twice");
    });
    const outcome = await processWebhookDelivery(env.DB, { deliveryId }, {}, { fetchImpl });
    expect(outcome).toEqual({ kind: "noop" });
    expect(calls).toHaveLength(0);
    expect((await deliveryRow(deliveryId)).state).toBe("delivering"); // sweep/DLQ owns it now
  });

  it("acks as a no-op on a fully-processed redelivery", async () => {
    const hookId = await seedHook();
    const deliveryId = await seedDelivery(hookId, { state: "delivered", isSucceed: true });
    const { calls, fetchImpl } = receiverStub(() => {
      throw new Error("must not send twice");
    });
    const outcome = await processWebhookDelivery(env.DB, { deliveryId }, {}, { fetchImpl });
    expect(outcome).toEqual({ kind: "noop" });
    expect(calls).toHaveLength(0);
    expect((await deliveryRow(deliveryId)).attempts).toBe(0); // CAS never bumped
  });

  it("retries only when the outcome cannot be persisted and acks poison bodies", async () => {
    const hookId = await seedHook();
    const deliveryId = await seedDelivery(hookId);
    const { fetchImpl } = receiverStub(() => new Response(null, { status: 200 }));
    // A D1 proxy whose prepare throws simulates "could not persist outcome".
    const brokenDb: D1Database = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return () => {
            throw new Error("d1 down");
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
      },
    });
    const { batch, acked, retried } = stubBatch([
      { body: { deliveryId } }, //processable, but D1 is down → retry (queue redelivers)
      { body: { notA: "deliveryId" } }, // poison body → ack
      { body: "nonsense" }, // poison body → ack
    ]);
    const result = await runWebhookDeliveryBatch(
      batch,
      { DB: brokenDb, WEBHOOK_ALLOWED_HOST_LIST: "loopback" },
      { fetchImpl },
    );
    expect(result).toEqual({ acked: 2, retried: 1 });
    expect(acked()).toBe(2);
    expect(retried()).toBe(1);
    // nothing was consumed: the row still waits for the redelivery
    expect((await deliveryRow(deliveryId)).state).toBe("pending");
  });
});

describe("§3.6/§4.8 terminal failures (no retry)", () => {
  it("records a timeout as a terminal failure with the error text", async () => {
    const hookId = await seedHook();
    const deliveryId = await seedDelivery(hookId);
    const { fetchImpl } = neverRespondingReceiver();
    const outcome = await processWebhookDelivery(env.DB, { deliveryId }, {}, { fetchImpl, deliveryTimeoutMs: 25 });
    expect(outcome).toEqual({ kind: "delivered", isSucceed: false });
    const row = await deliveryRow(deliveryId);
    expect(row.state).toBe("delivered"); // terminal, not pending/delivering
    expect(row.isSucceed).toBe(false);
    const response = JSON.parse(row.responseContent ?? "{}") as { status: number; body: string };
    expect(response.status).toBe(0);
    expect(response.body.startsWith("Delivery: ")).toBe(true);
    expect(row.requestContent).not.toBeNull();
    expect((await hookRow(hookId)).lastStatus).toBe(2); // HookStatus.Fail
  });

  it("records a non-2xx response as terminal with the capped body", async () => {
    const hookId = await seedHook();
    const deliveryId = await seedDelivery(hookId);
    const { calls, fetchImpl } = receiverStub(() => new Response("boom", { status: 500 }));
    const outcome = await processWebhookDelivery(env.DB, { deliveryId }, {}, { fetchImpl });
    expect(outcome).toEqual({ kind: "delivered", isSucceed: false });
    expect(calls).toHaveLength(1);
    const row = await deliveryRow(deliveryId);
    const response = JSON.parse(row.responseContent ?? "{}") as { status: number; body: string };
    expect(response.status).toBe(500);
    expect(response.body).toBe("boom");
    expect(row.isSucceed).toBe(false);
    expect(row.state).toBe("delivered");
  });

  it("denies metadata/loopback targets by default before issuing any request", async () => {
    const hookId = await seedHook({ url: "http://169.254.169.254/latest/meta-data/" });
    const deliveryId = await seedDelivery(hookId);
    const { calls, fetchImpl } = receiverStub(() => {
      throw new Error("must not reach a denied target");
    });
    const outcome = await processWebhookDelivery(env.DB, { deliveryId }, {}, { fetchImpl });
    expect(outcome).toEqual({ kind: "delivered", isSucceed: false });
    expect(calls).toHaveLength(0);
    const row = await deliveryRow(deliveryId);
    expect(row.state).toBe("delivered");
    expect((row.responseContent ?? "").includes("Delivery: ")).toBe(true);
    expect((row.responseContent ?? "").includes("WEBHOOK_ALLOWED_HOST_LIST")).toBe(true);
  });

  it("delivers to loopback only when the allow list widens it", async () => {
    const hookId = await seedHook({ url: "http://127.0.0.1:8787/hook" });
    const deliveryId = await seedDelivery(hookId);
    const denied = receiverStub(() => new Response(null, { status: 200 }));
    await processWebhookDelivery(env.DB, { deliveryId }, {}, { fetchImpl: denied.fetchImpl });
    expect(denied.calls).toHaveLength(0); // default-deny loopback

    await env.DB.prepare("UPDATE webhook_deliveries SET state='pending' WHERE id = ?").bind(deliveryId).run();
    const allowed = receiverStub(() => new Response(null, { status: 200 }));
    const outcome = await processWebhookDelivery(
      env.DB,
      { deliveryId },
      { WEBHOOK_ALLOWED_HOST_LIST: "loopback" },
      { fetchImpl: allowed.fetchImpl },
    );
    expect(outcome).toEqual({ kind: "delivered", isSucceed: true });
    expect(allowed.calls).toHaveLength(1);
    expect(allowed.calls[0]!.url).toBe("http://127.0.0.1:8787/hook");
  });

  it("records unsupported http methods (PUT) as terminal failures", async () => {
    const hookId = await seedHook({ httpMethod: "PUT" });
    const deliveryId = await seedDelivery(hookId);
    const { calls, fetchImpl } = receiverStub(() => new Response(null, { status: 200 }));
    const outcome = await processWebhookDelivery(env.DB, { deliveryId }, {}, { fetchImpl });
    expect(outcome).toEqual({ kind: "delivered", isSucceed: false });
    expect(calls).toHaveLength(0);
    const row = await deliveryRow(deliveryId);
    expect(row.requestContent).toBeNull(); // nothing was built
    expect((row.responseContent ?? "").includes("invalid http method: PUT")).toBe(true);
  });
});

describe("§3.6 recording rules", () => {
  it("caps the response body at the limit (default 1 MiB)", async () => {
    expect(WEBHOOK_RESPONSE_LIMIT_BYTES).toBe(1024 * 1024);
    const hookId = await seedHook();
    const deliveryId = await seedDelivery(hookId);
    const { fetchImpl } = receiverStub(() => new Response("x".repeat(100), { status: 200 }));
    await processWebhookDelivery(env.DB, { deliveryId }, {}, { fetchImpl, responseLimit: 16 });
    const row = await deliveryRow(deliveryId);
    const response = JSON.parse(row.responseContent ?? "{}") as { body: string };
    expect(response.body).toHaveLength(16);
  });

  it("masks the Authorization header in the stored request", async () => {
    const hookId = await seedHook({ headerAuthorizationEncrypted: "Bearer super-secret-value" });
    const deliveryId = await seedDelivery(hookId);
    const { calls, fetchImpl } = receiverStub(() => new Response(null, { status: 200 }));
    await processWebhookDelivery(env.DB, { deliveryId }, {}, { fetchImpl });
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer super-secret-value"); // sent verbatim
    const row = await deliveryRow(deliveryId);
    expect(row.requestContent ?? "").not.toContain("super-secret-value");
    const request = JSON.parse(row.requestContent ?? "{}") as { headers: Record<string, string> };
    expect(request.headers["Authorization"]).toBe("******");
  });

  it("records skipped for an inactive hook without touching the hook status", async () => {
    const hookId = await seedHook({ isActive: false });
    const deliveryId = await seedDelivery(hookId);
    const { calls, fetchImpl } = receiverStub(() => {
      throw new Error("inactive hooks must not be contacted");
    });
    const outcome = await processWebhookDelivery(env.DB, { deliveryId }, {}, { fetchImpl });
    expect(outcome).toEqual({ kind: "skipped", reason: "inactive" });
    expect(calls).toHaveLength(0);
    const row = await deliveryRow(deliveryId);
    expect(row.state).toBe("skipped");
    expect(row.isSucceed).toBe(false);
    expect(row.deliveredAt).not.toBeNull();
    expect((await hookRow(hookId)).lastStatus).toBe(0); // untouched
  });

  it("records skipped when the webhook row was purged (§4.13)", async () => {
    const hookId = await seedHook();
    const deliveryId = await seedDelivery(hookId);
    await env.DB.prepare("DELETE FROM webhooks WHERE id = ?").bind(hookId).run();
    const { calls, fetchImpl } = receiverStub(() => new Response(null, { status: 200 }));
    const outcome = await processWebhookDelivery(env.DB, { deliveryId }, {}, { fetchImpl });
    expect(outcome).toEqual({ kind: "skipped", reason: "hook-missing" });
    expect(calls).toHaveLength(0);
    expect((await deliveryRow(deliveryId)).state).toBe("skipped");
  });

  it("sends the form and GET variants per hook config", async () => {
    const formHook = await seedHook({ contentType: 2 });
    const getHook = await seedHook({ httpMethod: "GET" });
    const { calls, fetchImpl } = receiverStub(() => new Response(null, { status: 204 }));
    const formDelivery = await seedDelivery(formHook);
    const getDelivery = await seedDelivery(getHook);
    await processWebhookDelivery(env.DB, { deliveryId: formDelivery }, {}, { fetchImpl });
    await processWebhookDelivery(env.DB, { deliveryId: getDelivery }, {}, { fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(calls[0]!.body ?? "").get("payload")).toBe(PAYLOAD);
    expect(calls[1]!.method).toBe("GET");
    expect(calls[1]!.body).toBeNull();
    expect(new URL(calls[1]!.url).searchParams.get("payload")).toBe(PAYLOAD);
    // signatures are always over the stored payload bytes, not the transport form
    const expected = await computeWebhookSignatures("s3cr3t", PAYLOAD);
    expect(calls[1]!.headers["X-Hub-Signature-256"]).toBe(`sha256=${expected.sha256}`);
  });
});

describe("runWebhookDeliveryBatch (batch loop behind webhookQueueHandler)", () => {
  it("processes a whole batch to completion, one ack per message", async () => {
    const hookId = await seedHook();
    const a = await seedDelivery(hookId);
    const b = await seedDelivery(hookId);
    const { calls, fetchImpl } = receiverStub(() => new Response(null, { status: 200 }));
    const { batch, acked, retried } = stubBatch([{ body: { deliveryId: a } }, { body: { deliveryId: b } }]);
    const result = await runWebhookDeliveryBatch(batch, { DB: env.DB }, { fetchImpl });
    expect(result).toEqual({ acked: 2, retried: 0 });
    expect(acked()).toBe(2);
    expect(retried()).toBe(0);
    expect(calls).toHaveLength(2);
    expect((await deliveryRow(a)).state).toBe("delivered");
    expect((await deliveryRow(b)).state).toBe("delivered");
  });
});

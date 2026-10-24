/**
 * Webhook delivery Queue consumer (SPEC-0005 §3.6) — the delivery-worker side
 * of the pipeline that `src/issues/webhooks.ts` (`emitWebhookDeliveries`)
 * feeds. Message: `{deliveryId}` only — the payload lives in D1, so retries
 * always read fresh config and the delivery log is complete regardless of
 * queue state.
 *
 * Per message (§3.6 steps 1–5):
 *  1. CAS `pending → delivering` (`attempts` + 1); 0 rows ⇒ already handled ⇒
 *     ack no-op (idempotent redelivery guard, mirrors upstream
 *     `MarkTaskDelivered`);
 *  2. read the webhook row; missing row (§4.13 purge) or `is_active=false` ⇒
 *     `state='skipped'`, ack;
 *  3. sign the stored `payload_content` bytes with the secret — HMAC-SHA256
 *     and HMAC-SHA1 via WebCrypto — and build the full upstream header set
 *     (§2.6 `addDefaultHeaders`): `X-Gitea-*`, `X-Gogs-*`, `X-GitHub-*`,
 *     `X-Hub-Signature(-256)`, delivery uuid, event group/type headers;
 *  4. POST `application/json` (or the form/GET parity variants), 5 s timeout
 *     via `AbortSignal.timeout`;
 *  5. read the response capped at 1 MiB, record `request_content` /
 *     `response_content` (Authorization masked `******`), then
 *     `state='delivered'`, `is_succeed = 2xx`, `webhooks.last_status`.
 *
 * Retry policy — upstream parity: FAILED DELIVERIES ARE TERMINAL. A network
 * error, timeout, non-2xx, SSRF denial, or request-construction error is
 * recorded (`is_succeed=0`, error text in `response_content.body`) and the
 * message acked — no automatic retry (§4.8); the user replays explicitly.
 * Queue redelivery exists only for consumer crashes: the handler calls
 * `message.retry()` solely when it could not persist an outcome (D1
 * unavailable); after the queue's max attempts the message lands in the DLQ
 * (`src/webhooks/dlq.ts`), whose sweep marks stuck rows `failed` so the
 * delivery list never shows a perpetual `delivering`.
 *
 * SSRF: the target URL is screened by `./ssrf` against
 * `WEBHOOK_ALLOWED_HOST_LIST` (upstream `security.ALLOWED_HOST_LIST`
 * semantics; default lax = allow all public, loopback/link-local/metadata
 * denied) before any request is issued.
 *
 * ---------------------------------------------------------------------------
 * ORCHESTRATOR INTEGRATION (SPEC-0005 §3.6) — the only wiring this module
 * needs; file ownership kept out of `index.ts` / `wrangler.jsonc` here.
 *
 * 1. `wrangler.jsonc` (queues are only available on Workers with
 *    `"compatibility_date"` ≥ 2023-12-01 — satisfied):
 *
 *    ```jsonc
 *    "queues": {
 *      "producers": [
 *        { "binding": "WEBHOOK_DELIVERY", "queue": "webhook-delivery" }
 *      ],
 *      "consumers": [
 *        {
 *          "queue": "webhook-delivery",
 *          "max_retries": 3,
 *          "dead_letter_queue": "webhook-delivery-dlq"
 *        },
 *        {
 *          "queue": "webhook-delivery-dlq",
 *          "max_retries": 1,
 *          "max_batch_size": 10
 *        }
 *      ]
 *    }
 *    ```
 *
 *    then `wrangler types` and `wrangler queues create webhook-delivery`
 *    (+ `...-dlq`). `WEBHOOK_ALLOWED_HOST_LIST` / `WEBHOOK_EGRESS_MODE` are
 *    optional `[vars]` (documented in ./ssrf); none of this module's config
 *    is a secret (hook secrets live in D1).
 *
 * 2. `src/index.ts` — a Worker exposes ONE `queue` export, so it dispatches on
 *    `batch.queue` (the message type is identical for both queues):
 *
 *    ```ts
 *    import { webhookDlqHandler } from "./webhooks/dlq";
 *    import { webhookQueueHandler, type WebhookDeliveryMessage } from "./webhooks/consumer";
 *
 *    export default {
 *      // ...fetch/scheduled...
 *      async queue(batch: MessageBatch<WebhookDeliveryMessage>, env: Env, ctx: ExecutionContext) {
 *        if (batch.queue === "webhook-delivery-dlq") return webhookDlqHandler(batch, env, ctx);
 *        return webhookQueueHandler(batch, env, ctx);
 *      },
 *    } satisfies ExportedHandler<Env, WebhookDeliveryMessage>;
 *    ```
 *
 *    Producer side: pass
 *    `(ids) => env.WEBHOOK_DELIVERY.sendBatch(ids.map((deliveryId) => ({ deliveryId })))`
 *    as `emitWebhookDeliveries`' `enqueue` callback. `cleanupWebhookDeliveries`
 *    + `sweepStuckDeliveries` (./dlq) hang off the cron/periodic job
 *    (`scheduled` handler + `"triggers": {"crons": [...]}` in wrangler.jsonc).
 * ---------------------------------------------------------------------------
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { HookStatus, webhookDeliveries, webhooks } from "../db/schema";
import { checkWebhookTarget, parseHostPolicy, type EgressMode } from "./ssrf";

/** The only thing a producer puts on the queue (§3.6). */
export interface WebhookDeliveryMessage {
  deliveryId: number;
}

/** Structural slice of the Worker `Env` the consumer needs (queue bindings add themselves). */
export interface WebhookQueueEnv {
  DB: D1Database;
  /** Upstream `security.ALLOWED_HOST_LIST` syntax; unset = lax allow-all-public. */
  WEBHOOK_ALLOWED_HOST_LIST?: string;
  /** `lax` (default) | `strict`. */
  WEBHOOK_EGRESS_MODE?: string;
}

export interface WebhookDeliveryOptions {
  /** Test seam — defaults to the global `fetch`. NO real network in tests. */
  fetchImpl?: typeof fetch;
  /** Delivery timeout (§3.6 step 4); default 5 s, upstream `DELIVER_TIMEOUT`. */
  deliveryTimeoutMs?: number;
  /** Response read cap; default 1 MiB (upstream `util.ReadWithLimit(resp.Body, 1024*1024)`). */
  responseLimit?: number;
  /** Test clock for `delivered_unix`. */
  now?: Date;
}

/** Upstream `webhook.DELIVER_TIMEOUT` default (modules/setting/webhook.go:31). */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 5_000;
/** Upstream response read cap (services/webhook/deliver.go). */
export const WEBHOOK_RESPONSE_LIMIT_BYTES = 1024 * 1024;

/** `webhooks.content_type` — upstream `ContentTypeForm` (1 = ContentTypeJSON, the default). */
const CONTENT_TYPE_FORM = 2;

// ---------------------------------------------------------------------------
// Signatures (§2.6 — HMAC over the exact stored payload bytes)
// ---------------------------------------------------------------------------

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function hmacHex(hash: "SHA-1" | "SHA-256", secret: Uint8Array, payload: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, payload);
  return toHex(signature);
}

export interface WebhookSignatures {
  sha1: string;
  sha256: string;
}

/**
 * Compute both webhook signatures over `payload` with `secret`. Empty secret
 * yields empty hex strings — the signature headers are still sent, mirroring
 * upstream `addDefaultHeaders` (deliver.go:96–111).
 */
export async function computeWebhookSignatures(secret: string, payload: string): Promise<WebhookSignatures> {
  const encoder = new TextEncoder();
  if (secret === "") return { sha1: "", sha256: "" };
  const secretBytes = encoder.encode(secret);
  const [sha1, sha256] = await Promise.all([
    hmacHex("SHA-1", secretBytes, encoder.encode(payload)),
    hmacHex("SHA-256", secretBytes, encoder.encode(payload)),
  ]);
  return { sha1, sha256 };
}

// ---------------------------------------------------------------------------
// Request construction (upstream newDefaultRequest, deliver.go:47–93)
// ---------------------------------------------------------------------------

/** Go `url.QueryEscape`: unreserved stays, space becomes `+`. */
function goQueryEscape(text: string): string {
  return encodeURIComponent(text)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/**
 * Go `url.Values.Encode` semantics for the GET variant: payload replaces any
 * existing `payload` key, keys sorted byte-wise, `QueryEscape`d.
 */
function mergePayloadIntoQuery(rawUrl: string, payload: string): string {
  const url = new URL(rawUrl);
  const pairs = new Map<string, string[]>();
  for (const [key, value] of url.searchParams.entries()) {
    const values = pairs.get(key);
    if (values === undefined) pairs.set(key, [value]);
    else values.push(value);
  }
  pairs.set("payload", [payload]);
  const encoded = [...pairs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, values]) => values.map((value) => `${goQueryEscape(key)}=${goQueryEscape(value)}`).join("&"))
    .join("&");
  const base = `${url.origin}${url.pathname}`;
  return encoded === "" ? base : `${base}?${encoded}`;
}

export interface BuiltWebhookRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The exact bytes sent (GET sends no body — `body` stays the payload for the log). */
  body: string | null;
  /** Body recorded in `request_content` (upstream always logs the payload here). */
  loggedBody: string;
}

export class WebhookRequestError extends Error {}

/**
 * `X-Gitea-Hook-Installation-Target-Type` (deliver.go:113–124). Upstream
 * resolves owner-level hooks to "organization"/"user" via the user row;
 * organizations land with SPEC-0007, so owners resolve to "user" and the
 * owner-row-gone fallback ("default") applies only to an ownerless row.
 */
function resolveTargetType(hook: {
  isSystemWebhook: boolean;
  repoId: string | null;
  ownerId: number | null;
}): string {
  if (hook.isSystemWebhook) return "system";
  if (hook.repoId !== null) return "repository";
  if (hook.ownerId !== null) return "user"; // organization detection: SPEC-0007
  return "default";
}

/** Build the request for one delivery (headers in upstream `addDefaultHeaders` order). */
export function buildWebhookRequest(input: {
  hook: {
    url: string;
    httpMethod: string;
    contentType: number;
    headerAuthorizationEncrypted: string | null;
  };
  /** The stored payload bytes (§2.7 2-space JSON) — signed and logged verbatim. */
  payloadText: string;
  delivery: { uuid: string; eventType: string; eventGroup: string };
  targetType: string;
  signatures: WebhookSignatures;
}): BuiltWebhookRequest {
  const { hook, payloadText, delivery, targetType, signatures } = input;
  const headers: Record<string, string> = {
    "X-Gitea-Delivery": delivery.uuid,
    "X-Gitea-Event": delivery.eventGroup,
    "X-Gitea-Event-Type": delivery.eventType,
    "X-Gitea-Signature": signatures.sha256,
    "X-Gitea-Hook-Installation-Target-Type": targetType,
    "X-Gogs-Delivery": delivery.uuid,
    "X-Gogs-Event": delivery.eventGroup,
    "X-Gogs-Event-Type": delivery.eventType,
    "X-Gogs-Signature": signatures.sha256,
    "X-Hub-Signature": `sha1=${signatures.sha1}`,
    "X-Hub-Signature-256": `sha256=${signatures.sha256}`,
    "X-GitHub-Delivery": delivery.uuid,
    "X-GitHub-Event": delivery.eventGroup,
    "X-GitHub-Event-Type": delivery.eventType,
    "X-GitHub-Hook-Installation-Target-Type": targetType,
  };

  const method = hook.httpMethod === "" ? "POST" : hook.httpMethod.toUpperCase();
  let url = hook.url;
  let body: string | null;
  switch (method) {
    case "POST":
      if (hook.contentType === CONTENT_TYPE_FORM) {
        // Upstream: `payload=<urlencoded>` over the raw payload (deliver.go:59–68).
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = `payload=${goQueryEscape(payloadText)}`;
      } else {
        headers["Content-Type"] = "application/json";
        body = payloadText;
      }
      break;
    case "GET":
      // Upstream: payload into the query string (deliver.go:69–81).
      url = mergePayloadIntoQuery(hook.url, payloadText);
      body = null;
      break;
    default:
      // Upstream supports PUT only for the MATRIX type with payload_version 1
      // (newDefaultRequest); we always store version-2 gitea payloads.
      throw new WebhookRequestError(`invalid http method: ${method}`);
  }

  // The stored Authorization value is sent verbatim but masked in the log
  // (upstream decrypts `HeaderAuthorizationEncrypted`; the encryption-at-rest
  // service lands with the settings module — column read as-is meanwhile).
  if (hook.headerAuthorizationEncrypted !== null && hook.headerAuthorizationEncrypted !== "") {
    headers["Authorization"] = hook.headerAuthorizationEncrypted;
  }

  return { url, method, headers, body, loggedBody: payloadText };
}

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

/** Upstream `HookRequest` JSON shape (models/webhook/hooktask.go:43–48). */
export interface HookRequestInfo {
  url: string;
  http_method: string;
  headers: Record<string, string>;
  body: string;
}

/** Upstream `HookResponse` JSON shape (models/webhook/hooktask.go:51–55). */
export interface HookResponseInfo {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Response-body read capped like upstream `util.ReadWithLimit(resp.Body, 1 MiB)`. */
export async function readResponseCapped(response: Response, limit: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    chunks.push(value);
    received += value.byteLength;
    if (received >= limit) {
      await reader.cancel().catch(() => {}); // stop draining an oversized body
      break;
    }
  }
  const total = Math.min(received, limit);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= total) break;
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, total - offset));
    merged.set(slice, offset);
    offset += slice.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Mask `Authorization` in the recorded header map (§3.6 step 5, upstream `******`). */
function maskRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const masked = { ...headers };
  if (masked["Authorization"] !== undefined && masked["Authorization"] !== "") {
    masked["Authorization"] = "******";
  }
  return masked;
}

export type DeliveryOutcome =
  | { kind: "delivered"; isSucceed: boolean }
  | { kind: "skipped"; reason: "inactive" | "hook-missing" }
  | { kind: "noop" };

/**
 * §3.6 consumer algorithm for one `{deliveryId}`. Returns normally once the
 * outcome is durably recorded (⇒ ack); throws only when it could not persist
 * (⇒ retry/DLQ).
 */
export async function processWebhookDelivery(
  d1: D1Database,
  message: WebhookDeliveryMessage,
  env: Pick<WebhookQueueEnv, "WEBHOOK_ALLOWED_HOST_LIST" | "WEBHOOK_EGRESS_MODE">,
  options: WebhookDeliveryOptions = {},
): Promise<DeliveryOutcome> {
  const db = drizzle(d1);
  const now = options.now ?? new Date();

  // §3.6 step 1 — CAS pending→delivering; 0 rows ⇒ already handled ⇒ noop.
  const claimed = await db
    .update(webhookDeliveries)
    .set({ state: "delivering", attempts: sql`${webhookDeliveries.attempts} + 1` })
    .where(and(eq(webhookDeliveries.id, message.deliveryId), eq(webhookDeliveries.state, "pending")))
    .returning({ id: webhookDeliveries.id })
    .all();
  if (claimed.length === 0) return { kind: "noop" };

  const delivery = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, message.deliveryId))
    .get();
  if (delivery === undefined) {
    // The row vanished mid-flight (concurrent repo purge) — nothing to deliver.
    return { kind: "skipped", reason: "hook-missing" };
  }

  const hook = await db.select().from(webhooks).where(eq(webhooks.id, delivery.hookId)).get();

  // §3.6 step 2 — inactive (or purged, §4.13) hooks record `skipped`.
  if (hook === undefined || !hook.isActive) {
    await db
      .update(webhookDeliveries)
      .set({ state: "skipped", deliveredAt: now })
      .where(eq(webhookDeliveries.id, delivery.id));
    return { kind: "skipped", reason: hook === undefined ? "hook-missing" : "inactive" };
  }

  // §3.6 step 3 — sign the stored payload bytes with the hook secret.
  const signatures = await computeWebhookSignatures(hook.secret, delivery.payloadContent);
  const targetType = resolveTargetType(hook);

  const recordFailure = async (
    response: HookResponseInfo,
    request: HookRequestInfo | null,
  ): Promise<DeliveryOutcome> =>
    recordDeliveryOutcome(db, delivery.id, hook.id, {
      request: request === null ? null : { ...request, headers: maskRequestHeaders(request.headers) },
      response,
      isSucceed: false,
      now,
    });

  let built: BuiltWebhookRequest;
  try {
    built = buildWebhookRequest({
      hook: {
        url: hook.url,
        httpMethod: hook.httpMethod,
        contentType: hook.contentType,
        headerAuthorizationEncrypted: hook.headerAuthorizationEncrypted,
      },
      payloadText: delivery.payloadContent,
      delivery: { uuid: delivery.uuid, eventType: delivery.eventType, eventGroup: delivery.eventGroup },
      targetType,
      signatures,
    });
  } catch (error) {
    // Terminal request-construction error (unsupported method, bad URL form):
    // recorded like any other failure so the row never sticks in `delivering`
    // and every event costs one attempt, never a retry loop (§3.6).
    return await recordFailure(
      {
        status: 0,
        headers: {},
        body: `Delivery: ${error instanceof Error ? error.message : String(error)}`,
      },
      null,
    );
  }

  // SSRF gate (§3.6 Egress) — before any request is issued.
  let targetUrl: URL;
  try {
    targetUrl = new URL(built.url);
  } catch {
    return await recordFailure(
      { status: 0, headers: {}, body: `Delivery: invalid URL: ${hook.url}` },
      null,
    );
  }
  const mode: EgressMode = env.WEBHOOK_EGRESS_MODE === "strict" ? "strict" : "lax";
  const decision = checkWebhookTarget(targetUrl, parseHostPolicy(env.WEBHOOK_ALLOWED_HOST_LIST, mode));
  if (!decision.allowed) {
    return await recordFailure(
      { status: 0, headers: {}, body: `Delivery: ${decision.reason}` },
      {
        url: built.url,
        http_method: built.method,
        headers: built.headers,
        body: built.loggedBody,
      },
    );
  }

  // §3.6 step 4 — issue the request with the 5 s timeout.
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.deliveryTimeoutMs ?? WEBHOOK_DELIVERY_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetchImpl(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // §4.8 — one attempt, terminal failure recorded as upstream's
    // `t.ResponseInfo.Body = fmt.Sprintf("Delivery: %v", err)`.
    return await recordFailure(
      {
        status: 0,
        headers: {},
        body: `Delivery: ${error instanceof Error ? error.message : String(error)}`,
      },
      {
        url: built.url,
        http_method: built.method,
        headers: built.headers,
        body: built.loggedBody,
      },
    );
  }

  // §3.6 step 5 — cap the response read at 1 MiB and persist the outcome.
  const responseLimit = options.responseLimit ?? WEBHOOK_RESPONSE_LIMIT_BYTES;
  const responseBody = await readResponseCapped(response, responseLimit);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const isSucceed = response.status / 100 === 2;
  return recordDeliveryOutcome(db, delivery.id, hook.id, {
    request: {
      url: built.url,
      http_method: built.method,
      headers: maskRequestHeaders(built.headers),
      body: built.loggedBody,
    },
    response: { status: response.status, headers: responseHeaders, body: responseBody },
    isSucceed,
    now,
  });
}

/** Persist the delivery outcome + `webhooks.last_status` in one D1 batch (§3.6 step 5). */
async function recordDeliveryOutcome(
  db: ReturnType<typeof drizzle>,
  deliveryId: number,
  hookId: number,
  outcome: {
    request: HookRequestInfo | null;
    response: HookResponseInfo;
    isSucceed: boolean;
    now: Date;
  },
): Promise<DeliveryOutcome> {
  await db.batch([
    db
      .update(webhookDeliveries)
      .set({
        state: "delivered",
        isSucceed: outcome.isSucceed,
        requestContent: outcome.request === null ? null : JSON.stringify(outcome.request),
        responseContent: JSON.stringify(outcome.response),
        deliveredAt: outcome.now,
      })
      .where(eq(webhookDeliveries.id, deliveryId)),
    db
      .update(webhooks)
      .set({ lastStatus: outcome.isSucceed ? HookStatus.Succeed : HookStatus.Fail })
      .where(eq(webhooks.id, hookId)),
  ]);
  return { kind: "delivered", isSucceed: outcome.isSucceed };
}

/**
 * Process a whole queue batch with per-message ack/retry (§3.6): outcomes are
 * acked (including terminal failures — no retry); only a failure to persist
 * (D1 unavailable) leaves the message un-acked for queue redelivery/DLQ.
 */
export async function runWebhookDeliveryBatch(
  batch: MessageBatch<WebhookDeliveryMessage>,
  env: WebhookQueueEnv,
  options: WebhookDeliveryOptions = {},
): Promise<{ acked: number; retried: number }> {
  let acked = 0;
  let retried = 0;
  for (const message of batch.messages) {
    const body: unknown = message.body;
    if (typeof body !== "object" || body === null) {
      message.ack(); // unparseable poison body — nothing to deliver
      acked++;
      continue;
    }
    const { deliveryId } = body as { deliveryId?: unknown };
    if (typeof deliveryId !== "number" || !Number.isInteger(deliveryId) || deliveryId <= 0) {
      message.ack();
      acked++;
      continue;
    }
    try {
      await processWebhookDelivery(env.DB, { deliveryId }, env, options);
      message.ack();
      acked++;
    } catch (error) {
      // Could not persist the outcome — leave un-acked (§3.6 poison/DLQ).
      console.error(
        `webhook delivery ${deliveryId} could not be processed, message retried:`,
        error instanceof Error ? error.message : error,
      );
      message.retry();
      retried++;
    }
  }
  return { acked, retried };
}

/**
 * The production Queue consumer. Wire as the `queue` export of the Worker
 * entry point (see the module header for the exact `index.ts`/`wrangler.jsonc`
 * blocks).
 */
export async function webhookQueueHandler(
  batch: MessageBatch<WebhookDeliveryMessage>,
  env: WebhookQueueEnv,
  _ctx?: ExecutionContext,
): Promise<void> {
  await runWebhookDeliveryBatch(batch, env);
}

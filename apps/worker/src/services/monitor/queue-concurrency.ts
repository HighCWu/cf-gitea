/**
 * The /set ARM — queue consumer max_concurrency (SPEC-0021 §3) — the
 * Cloudflare-native adapter over the official Queues consumer API, replacing
 * the recorded "no worker-pool knob" reduction (the freeze, 2026-11-01:
 * Cloudflare Queues DO carry the knob — max_concurrency on the consumer —
 * so the admin gets upstream's QueueSet posture through the platform API).
 *
 * ## The closed loop (binding — every write rides it)
 *
 *   read (GET the consumer's FULL config)
 *     → modify (change ONLY settings.max_concurrency; batch_size /
 *       max_retries / max_wait_time_ms / retry_delay / dead_letter_queue /
 *       script_name / type are preserved VERBATIM — the PUT replaces the
 *       consumer wholesale, so dropping a field DROPS the setting)
 *     → write (PUT)
 *     → verify (GET-verify the effective value; bounded retries absorb the
 *       platform's read-after-write window; a persistent mismatch is the
 *       read-back-mismatch FAIL — never a claimed success)
 *     → display: the UI shows the RUNTIME value (the verified GET) AND the
 *       DECLARED value (the allowlist's declared_max_concurrency, mirroring
 *       wrangler.jsonc) SEPARATELY — our wrangler.jsonc re-applies declared
 *       settings on the next deploy, so a runtime change is a DRIFT the
 *       admin must see, never a silent permanent change.
 *
 * ## Upstream posture (routers/web/admin/queue.go QueueSet, web.go:809)
 *
 *   POST /-/admin/monitor/queue/{qid}/set  form field `max-number`;
 *   empty = re-set the current value (the "Settings Updated" flash);
 *   the value is clamped < -1 to -1 (upstream's unlimited). Ours:
 *   1..250 passes through (the platform's validated range, the freeze),
 *   "auto" / "-1" / clamped-negatives → null (the platform's auto arm —
 *   "automatically opt in to the platform's maximum"; the -1→auto mapping is
 *   the documented divergence: upstream's -1 is unlimited workers, the
 *   platform's closest arm is auto), anything else is the
 *   maxnumberworkers.error flash. Upstream redirects; the no-JS re-render is
 *   the cron POST's convention (no flash queue yet).
 *
 * ## Security (the freeze — binding)
 *
 *   - admin-gated at the route (the family prologue);
 *   - queue/consumer ids from the SERVER-SIDE allowlist ONLY — the qid in
 *     the URL is a lookup key, never an API path component;
 *   - the CLOUDFLARE_QUEUES_TOKEN secret never renders and never logs;
 *   - every applied write emits an audit row (operator, before, after, API
 *     result, timestamp — the emitAudit seam; a failed audit write never
 *     fails the flash, the cron manual-run's log-and-continue precedent,
 *     since the platform write already happened);
 *   - conflict-safety on concurrent edits (two admins racing the read-
 *     modify-write) is a DOCUMENTED FOLLOW-UP (SPEC-0021 §8), not built:
 *     the platform exposes no compare-and-swap on the consumer, the loop's
 *     verify step catches a lost update on the next read, and the audit
 *     trail shows both writes.
 */

import { drizzle } from "drizzle-orm/d1";

import { emitAudit, defineAction } from "../audit";
import {
  cfApiEnvelopeRequest,
  classifyPlatformStatus,
  monitorPlatformConfigFromEnv,
  type CfApiOutcome,
  type FetchImpl,
  type MonitorPlatformConfig,
  type MonitorPlatformStatus,
} from "./platform";

/** The applied write's audit action (registered once at module load — the
 *  seam's define() posture; the system:* class, system scope). */
export const MONITOR_QUEUE_SET_AUDIT_ACTION = defineAction(
  "system:monitor:queue-concurrency-set",
  "Changed queue consumer {queue} max_concurrency from {before} to {after} (API {result}).",
);

/** The validated max_concurrency range (the freeze; the platform documents
 *  null = auto as the recommended arm above the range). */
export const MAX_CONCURRENCY_MIN = 1;
export const MAX_CONCURRENCY_MAX = 250;

/** The consumer's settings slice this arm reads/preserves/writes — the flat
 *  shape of the API's result.settings (absent fields stay null; "or empty
 *  string if not configured" dead_letter_queue keeps the API's own
 *  representation verbatim for the PUT's preservation). */
export interface QueueConsumerSettings {
  consumerId: string | null;
  scriptName: string | null;
  type: string | null;
  queueName: string | null;
  deadLetterQueue: string | null;
  createdOn: string | null;
  batchSize: number | null;
  maxConcurrency: number | null;
  maxRetries: number | null;
  maxWaitTimeMs: number | null;
  retryDelay: number | null;
}

function optString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function optNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parse the envelope's consumer result (the worker variant; an http_pull
 *  result parses with its worker-only fields null — the allowlist decides
 *  what this deployment addresses, and a mismatch surfaces at the PUT). */
function parseConsumerResult(result: unknown): QueueConsumerSettings {
  if (result === null || typeof result !== "object") {
    throw new Error("consumer result is not an object");
  }
  const r = result as Record<string, unknown>;
  const settings = (r.settings ?? null) as Record<string, unknown> | null;
  return {
    consumerId: optString(r.consumer_id),
    scriptName: optString(r.script_name),
    type: optString(r.type),
    queueName: optString(r.queue_name),
    deadLetterQueue: optString(r.dead_letter_queue),
    createdOn: optString(r.created_on),
    batchSize: settings === null ? null : optNumber(settings.batch_size),
    maxConcurrency: settings === null ? null : optNumber(settings.max_concurrency),
    maxRetries: settings === null ? null : optNumber(settings.max_retries),
    maxWaitTimeMs: settings === null ? null : optNumber(settings.max_wait_time_ms),
    retryDelay: settings === null ? null : optNumber(settings.retry_delay),
  };
}

// ---------------------------------------------------------------------------
// The GET read (the loop's read AND verify steps; the manage page's runtime
// display and the diagnosis report's queue-truth item share it)
// ---------------------------------------------------------------------------

/** The consumer read/write outcome — the shared envelope taxonomy with the
 *  ok arm carrying the PARSED settings (the callers' shape). */
export type QueueConsumerOutcome =
  | { kind: "ok"; settings: QueueConsumerSettings }
  | Exclude<CfApiOutcome<QueueConsumerSettings>, { kind: "ok" }>;

/** GET /accounts/{a}/queues/{q}/consumers/{c} — the full consumer config. */
export async function readQueueConsumer(options: {
  accountId: string;
  apiToken: string | undefined;
  target: { queueId: string; consumerId: string };
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<QueueConsumerOutcome> {
  const outcome = await cfApiEnvelopeRequest<QueueConsumerSettings>({
    apiToken: options.apiToken,
    method: "GET",
    url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/queues/${encodeURIComponent(options.target.queueId)}/consumers/${encodeURIComponent(options.target.consumerId)}`,
    parseResult: parseConsumerResult,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });
  return outcome.kind === "ok" ? { kind: "ok", settings: outcome.result } : outcome;
}

// ---------------------------------------------------------------------------
// The PUT write — preserve everything, change ONLY settings.max_concurrency
// ---------------------------------------------------------------------------

/** The PUT body builder — the preservation rule made structural: every field
 *  the GET returned rides the body verbatim; ONLY settings.max_concurrency
 *  takes the new value. Absent GET fields stay absent (passing invented
 *  defaults would overwrite the platform's stored state with guesses). */
export function buildConsumerPutBody(settings: QueueConsumerSettings, newMaxConcurrency: number | null): string {
  const body: Record<string, unknown> = {
    // The worker variant is this deployment's only consumer shape (the
    // committed config's consumers are all script consumers); the read's
    // own type wins when the platform answers with one.
    type: settings.type ?? "worker",
  };
  if (settings.scriptName !== null) body.script_name = settings.scriptName;
  if (settings.deadLetterQueue !== null) body.dead_letter_queue = settings.deadLetterQueue;
  const settingsBody: Record<string, unknown> = {};
  if (settings.batchSize !== null) settingsBody.batch_size = settings.batchSize;
  settingsBody.max_concurrency = newMaxConcurrency; // THE change (null = auto)
  if (settings.maxRetries !== null) settingsBody.max_retries = settings.maxRetries;
  if (settings.maxWaitTimeMs !== null) settingsBody.max_wait_time_ms = settings.maxWaitTimeMs;
  if (settings.retryDelay !== null) settingsBody.retry_delay = settings.retryDelay;
  body.settings = settingsBody;
  return JSON.stringify(body);
}

async function putConsumer(options: {
  accountId: string;
  apiToken: string | undefined;
  target: { queueId: string; consumerId: string };
  body: string;
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<QueueConsumerOutcome> {
  const outcome = await cfApiEnvelopeRequest<QueueConsumerSettings>({
    apiToken: options.apiToken,
    method: "PUT",
    url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/queues/${encodeURIComponent(options.target.queueId)}/consumers/${encodeURIComponent(options.target.consumerId)}`,
    body: options.body,
    parseResult: parseConsumerResult,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });
  return outcome.kind === "ok" ? { kind: "ok", settings: outcome.result } : outcome;
}

// ---------------------------------------------------------------------------
// The closed loop
// ---------------------------------------------------------------------------

/** The verify step's bounded read-after-write posture: three reads, 500 ms
 *  apart, before the mismatch is a FAIL. */
const VERIFY_ATTEMPTS = 3;
const VERIFY_DELAY_MS = 500;

/** The loop's verdict — every non-ok kind maps onto the frozen taxonomy
 *  (auth/bad-request/mismatch/... fail; unconfigured skips). */
export type QueueSetLoopOutcome =
  | { kind: "ok"; before: number | null; after: number | null; effective: number | null; settings: QueueConsumerSettings }
  | { kind: "unconfigured" }
  /** The initial read failed (auth/404/network/...). */
  | { kind: "read-failed"; status: MonitorPlatformStatus; detail: string }
  /** The PUT failed — the write did not land. */
  | { kind: "write-failed"; status: MonitorPlatformStatus; detail: string }
  /** The verify GET kept answering a different value — the frozen
   *  read-back-mismatch FAIL (never reported as success). */
  | { kind: "verify-failed"; expected: number | null; got: number | null; attempts: number };

/** The read → modify → write → verify loop. `maxConcurrency` is the already
 *  parsed target (null = auto). */
export async function setQueueConsumerMaxConcurrency(options: {
  accountId: string;
  apiToken: string | undefined;
  target: { queueId: string; consumerId: string };
  maxConcurrency: number | null;
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<QueueSetLoopOutcome> {
  // READ — the full config (also the loop's before value). The unconfigured
  // arm passes through VERBATIM (the skip/warn arm must stay the skip/warn
  // arm — never re-labeled a read failure).
  const read = await readQueueConsumer(options);
  if (read.kind === "unconfigured") {
    return { kind: "unconfigured" };
  }
  if (read.kind !== "ok") {
    const classified = classifyPlatformStatus(read);
    return { kind: "read-failed", status: classified.status, detail: classified.detail ?? read.kind };
  }
  const before = read.settings.maxConcurrency;
  // WRITE — preserve everything, change ONLY max_concurrency.
  const write = await putConsumer({
    ...options,
    body: buildConsumerPutBody(read.settings, options.maxConcurrency),
  });
  if (write.kind === "unconfigured") {
    return { kind: "unconfigured" };
  }
  if (write.kind !== "ok") {
    const classified = classifyPlatformStatus(write);
    return { kind: "write-failed", status: classified.status, detail: classified.detail ?? write.kind };
  }
  // VERIFY — GET-verify the effective value (bounded read-after-write
  // retries; the PUT's own result body is NOT trusted as the verification —
  // the platform may acknowledge before the setting is effective).
  let got: number | null = null;
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    const verify = await readQueueConsumer(options);
    if (verify.kind === "ok") {
      got = verify.settings.maxConcurrency;
      if (got === options.maxConcurrency) {
        return {
          kind: "ok",
          before,
          after: options.maxConcurrency,
          effective: got,
          // The VERIFIED settings (the display's runtime row).
          settings: verify.settings,
        };
      }
    }
    if (attempt < VERIFY_ATTEMPTS) {
      await (options.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(VERIFY_DELAY_MS);
    }
  }
  return { kind: "verify-failed", expected: options.maxConcurrency, got, attempts: VERIFY_ATTEMPTS };
}

// ---------------------------------------------------------------------------
// The form (upstream's max-number field) + the route-level apply
// ---------------------------------------------------------------------------

/** The parsed /set form (upstream's QueueSet): `max` is the target —
 *  `"keep-current"` rides the loop unchanged (upstream's empty field re-sets
 *  the current value), null is the auto arm, a number is the range-checked
 *  value. `null` return = the failed binding (the error flash). */
export type MonitorQueueSetMax = number | null | "keep-current";

export function parseMonitorQueueSetForm(params: URLSearchParams): MonitorQueueSetMax | null {
  const raw = params.get("max-number");
  if (raw === null || raw.trim() === "") {
    // Upstream: an empty max-number re-sets the CURRENT value (the
    // "Settings Updated" flash) — the loop runs unchanged.
    return "keep-current";
  }
  const trimmed = raw.trim();
  if (trimmed === "auto") {
    // The cf-gitea label for the platform's null=auto arm.
    return null;
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || String(value) !== trimmed) {
    return null;
  }
  if (value === -1) {
    // Upstream's unlimited alias → the platform's auto arm (the documented
    // divergence: closest substrate arm).
    return null;
  }
  if (value < -1) {
    // Upstream clamps to -1 → auto.
    return null;
  }
  if (value < MAX_CONCURRENCY_MIN || value > MAX_CONCURRENCY_MAX) {
    // The freeze's validated range (0 and >250 reject — the platform's
    // own validated range, not an invented clamp).
    return null;
  }
  return value;
}

/** The rendered flash pair (upstream's locale keys, verbatim English). */
export function monitorQueueSetFlashText(outcome: QueueSetLoopOutcome): { kind: "positive" | "negative"; text: string } {
  if (outcome.kind === "ok") {
    // "Settings Updated" — upstream's changed flash; the drift display on
    // the re-rendered page shows runtime vs declared.
    return { kind: "positive", text: "Settings Updated" };
  }
  if (outcome.kind === "unconfigured") {
    return { kind: "negative", text: "The queue platform arm is not configured (no CLOUDFLARE_QUEUES_TOKEN)." };
  }
  if (outcome.kind === "verify-failed") {
    return {
      kind: "negative",
      text: `Read-back mismatch: expected max_concurrency ${outcome.expected === null ? "auto" : outcome.expected}, the platform kept answering ${outcome.got === null ? "auto" : outcome.got}.`,
    };
  }
  if (outcome.kind === "read-failed") {
    return { kind: "negative", text: `Reading the consumer failed (${outcome.status}): ${outcome.detail}` };
  }
  return { kind: "negative", text: `Writing the consumer failed (${outcome.status}): ${outcome.detail}` };
}

/** The route-level apply: resolve the allowlist target (the qid is a LOOKUP
 *  KEY — an unknown/unconfigured name answers the honest unconfigured arm,
 *  never an API call with request data), run the loop, emit the audit row.
 *  The "keep-current" arm resolves INSIDE this function (one extra GET —
 *  the loop's before value), so the route passes the parsed form verbatim. */
export async function applyAdminMonitorQueueSet(
  env: Env,
  d1: D1Database,
  qid: string,
  max: MonitorQueueSetMax,
  options: {
    actorId: number;
    actorName: string;
    now?: Date;
    fetchImpl?: FetchImpl;
    sleepImpl?: (ms: number) => Promise<void>;
    /** The pre-built platform config (the route passes the same object it
     *  rendered the page from; tests inject the allowlist without touching
     *  the real env — the name is NOT in the generated Env until the
     *  wrangler.jsonc fold). Default: read from env. */
    platform?: MonitorPlatformConfig;
  },
): Promise<{ outcome: QueueSetLoopOutcome | { kind: "unconfigured" | "allowlist-error" }; flash: { kind: "positive" | "negative"; text: string } }> {
  const config = options.platform ?? monitorPlatformConfigOf(env);
  if (config.queueAllowlistError !== null) {
    return {
      outcome: { kind: "allowlist-error" },
      flash: { kind: "negative", text: `The queue platform allowlist is misconfigured: ${config.queueAllowlistError}` },
    };
  }
  const target = config.queueTargets.get(qid);
  if (target === undefined || config.accountId === undefined || config.queuesToken === undefined) {
    return {
      outcome: { kind: "unconfigured" },
      flash: { kind: "negative", text: monitorQueueSetFlashText({ kind: "unconfigured" }).text },
    };
  }
  // "keep-current" needs the loop's read value first — one extra GET when
  // the admin submitted the empty field (upstream's re-set posture).
  let loopMax: number | null;
  if (max === "keep-current") {
    const read = await readQueueConsumer({ accountId: config.accountId, apiToken: config.queuesToken, target, fetchImpl: options.fetchImpl, sleepImpl: options.sleepImpl });
    if (read.kind === "unconfigured") {
      return { outcome: { kind: "unconfigured" }, flash: monitorQueueSetFlashText({ kind: "unconfigured" }) };
    }
    if (read.kind !== "ok") {
      const classified = classifyPlatformStatus(read);
      const outcome: QueueSetLoopOutcome = { kind: "read-failed", status: classified.status, detail: classified.detail ?? read.kind };
      return { outcome, flash: monitorQueueSetFlashText(outcome) };
    }
    loopMax = read.settings.maxConcurrency;
  } else {
    loopMax = max;
  }
  const outcome = await setQueueConsumerMaxConcurrency({
    accountId: config.accountId,
    apiToken: config.queuesToken,
    target,
    maxConcurrency: loopMax,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });
  // The audit row: every APPLIED write (the ok loop) — operator, before,
  // after, API result, timestamp (the freeze). A failed audit write never
  // fails the flash (the platform write already happened — the cron
  // manual-run's log-and-continue precedent; the next loop's audit carries
  // the corrective row).
  if (outcome.kind === "ok") {
    const beforeText = outcome.before === null ? "auto" : String(outcome.before);
    const afterText = outcome.after === null ? "auto" : String(outcome.after);
    await emitAudit(drizzle(d1), {
      action: MONITOR_QUEUE_SET_AUDIT_ACTION,
      actorId: options.actorId,
      actorName: options.actorName,
      scopeType: "system",
      scopeId: "",
      origin: "ui",
      vars: { queue: qid, before: beforeText, after: afterText, result: "updated" },
      metadata: {
        queue: qid,
        consumer_id: target.consumerId,
        before_max_concurrency: outcome.before,
        after_max_concurrency: outcome.after,
        effective_max_concurrency: outcome.effective,
        declared_max_concurrency: target.declaredMaxConcurrency,
        api_result: "ok",
      },
      ipAddress: null,
      timestamp: options.now,
    }).catch((auditError: unknown) => {
      console.error("[monitor] queue set audit row not recorded", auditError);
    });
  }
  return { outcome, flash: monitorQueueSetFlashText(outcome) };
}

/** The platform config read (the env-slice seam — platform.ts's documented
 *  intersection; a plain Env satisfies the optional slice verbatim). */
function monitorPlatformConfigOf(env: Env): MonitorPlatformConfig {
  return monitorPlatformConfigFromEnv(env);
}

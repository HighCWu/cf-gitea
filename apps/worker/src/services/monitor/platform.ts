/**
 * The MONITOR PLATFORM ADAPTER seam (SPEC-0021) — the Cloudflare API client
 * the admin-monitor platform arms ride: the queue-concurrency /set loop
 * (services/monitor/queue-concurrency.ts), the profiling/pprof trigger
 * (services/monitor/profile.ts), and the diagnosis composite's deployment
 * item. The design is FROZEN (the monitor-platform freeze, 2026-11-01):
 * these arms are CLOUDFLARE-NATIVE adapters over the OFFICIAL APIs, never
 * local approximations.
 *
 * ## Verified API shapes (live docs, 2026-11-01)
 *
 *   - Queue consumer READ:   GET  /accounts/{account_id}/queues/{queue_id}/consumers/{consumer_id}
 *   - Queue consumer WRITE:  PUT  /accounts/{account_id}/queues/{queue_id}/consumers/{consumer_id}
 *     (developers.cloudflare.com/api/resources/queues/subresources/consumers/
 *     methods/{get,update}/ — PUT, NOT PATCH; PUT "Replaces a Queue consumer,
 *     or creates it if it does not exist", so a read-modify-write loop that
 *     preserves the untouched fields is the only safe shape). Worker-variant
 *     body: {type:"worker", script_name, dead_letter_queue, settings:{
 *     batch_size, max_concurrency, max_retries, max_wait_time_ms,
 *     retry_delay}}; `max_concurrency: null` = "automatically opt in to the
 *     platform's maximum (recommended)" — the null=auto arm. The response is
 *     the standard Cloudflare envelope {success, errors, messages, result}.
 *     Token permissions: Queues Write (the write) / Queues Read (the reads).
 *   - Profiling:             POST /accounts/{account_id}/workers/workers/{worker_id}/versions/{version_id}/profile
 *     (developers.cloudflare.com/workers/observability/profiling-in-production/
 *     — body {duration_ms: 1000..50000 required, profile_type: "cpu"(default)
 *     |"heap"}; the response is a GZIPPED PPROF FILE (binary, NOT the JSON
 *     envelope); `version_id` takes "latest" or a UUID — "latest selects the
 *     most recently created version, not necessarily a deployed one", so the
 *     diagnosis deployment read (below) supplies the serving version when it
 *     can. Token: Workers Scripts Read. Rate limited — HTTP 429 with
 *     Retry-After.
 *   - Deployments:           GET /accounts/{account_id}/workers/scripts/{script_name}/deployments
 *     (the FIRST item of result.deployments is "the latest deployment
 *     actively serving traffic"; items carry created_on, source,
 *     versions[{percentage, version_id}], annotations) — the diagnosis
 *     report's deployment-version item, and the profile's version_id source.
 *   - Workers Logs / Traces: NO query API (dashboards, wrangler tail, and
 *     OTel/Logpush export only — developers.cloudflare.com/workers/
 *     observability/{logs/workers-logs,traces}/, verified 2026-11-01). The
 *     perftrace section therefore states the enabled posture honestly and
 *     links out; it never fabricates a query arm.
 *
 * ## The two status dimensions (SPEC-0021 §6 — NEVER conflated)
 *
 *   - implementation-status: the SPEC/notes wording — 集成待验证
 *     ("integrated, awaiting live verification") until the deploy-probe
 *     battery (scripts/deploy-probes.mjs monitor-platform) passes against a
 *     live deployment, then 已实现 ("implemented"). Code comments NEVER
 *     claim more than the probes have proven.
 *   - environment-status: what a GIVEN deployment answers at runtime — the
 *     MonitorPlatformStatus union below: "available" (可用), "unconfigured"
 *     (未配置 — the secret/var names absent), "insufficient-permissions"
 *     (权限不足 — the platform answered 401/403; NEVER reported as
 *     "platform unsupported"), "platform-unavailable" (平台暂不可用 —
 *     network/5xx/429-exhausted/4xx-shaped platform refusals). The Monitor
     UI surfaces this dimension to the admin verbatim.
 *
 * ## The failure taxonomy (the frozen verification split — binding)
 *
 *   token-unconfigured-and-disabled → skip/warn (the honest degraded arm);
 *   401/403                        → FAIL (never "platform unsupported");
 *   400                            → fail;
 *   read-back-mismatch             → fail;
 *   429                            → bounded retry, then report (never a
 *                                    silent green).
 *
 * ## Configuration (the orchestrator's wrangler.jsonc fold declares these)
 *
 *   vars:    CLOUDFLARE_ACCOUNT_ID      — the API URLs' account id
 *            MONITOR_QUEUE_CONSUMERS    — the SERVER-SIDE allowlist JSON:
 *              {"repo-tasks":{"queue_id":"repo-tasks","consumer_id":"<32hex>",
 *                             "declared_max_concurrency":1}}
 *              (declared_max_concurrency mirrors wrangler.jsonc's
 *              queues.consumers[].max_concurrency for the UI's
 *              declared-vs-runtime drift display; null = declared auto)
 *            MONITOR_WORKER_NAME        — the deployed Worker's name for the
 *              profile/deployment URLs (defaults to "cf-gitea", the
 *              committed config's name; renamed deployments override)
 *   secrets: CLOUDFLARE_QUEUES_TOKEN    — minimal-privilege Queues
 *                                        Read+Write token, SEPARATE from
 *            CLOUDFLARE_PROFILE_TOKEN   — Workers Scripts Read (profiling +
 *                                        the deployment read)
 *   The queue/consumer IDs come ONLY from this server-side allowlist — never
 *   from a request (the qid a URL carries is a LOOKUP KEY into the allowlist,
 *   nothing more). Until the orchestrator's wrangler.jsonc fold declares the
 *   names, the generated Env lacks them; MonitorPlatformEnvSlice is the one
 *   documented structural seam (no `any`, no forced casts) — once declared,
 *   Env satisfies it verbatim.
 */

/** The injected fetch seam (the gitclient fetchImpl convention — NO real
 *  network in tests; the stub records the exact request literals). */
export type FetchImpl = typeof fetch;

/** The environment-status dimension (SPEC-0021 §6): what a given deployment
 *  answers at runtime for one platform arm. */
export type MonitorPlatformStatus =
  | "available"
  | "unconfigured"
  | "insufficient-permissions"
  | "platform-unavailable";

/** One allowlisted queue consumer — the ONLY way this codebase addresses a
 *  Cloudflare queue consumer. Entries come from the MONITOR_QUEUE_CONSUMERS
 *  var (server-side; never request data). */
export interface MonitorQueueConsumerTarget {
  /** The lookup key — the landed monitor registry's queue name (the qid the
   *  admin URLs carry). */
  key: string;
  /** The queue identifier passed verbatim in the API path (the queue NAME or
   *  UUID — whatever the operator pinned; the adapter never guesses). */
  queueId: string;
  /** The consumer identifier (Cloudflare's 32-hex consumer id). */
  consumerId: string;
  /** The wrangler-declared max_concurrency (queues.consumers[].max_concurrency
   *  in the committed config), mirrored here for the declared-vs-runtime
   *  display; null = declared auto (or the field absent). */
  declaredMaxConcurrency: number | null;
}

/** The parsed platform configuration (monitorPlatformConfigFromEnv's output —
 *  the adapters take this, never the raw env). */
export interface MonitorPlatformConfig {
  accountId: string | undefined;
  queuesToken: string | undefined;
  profileToken: string | undefined;
  workerName: string;
  /** The allowlist, keyed by the registry queue name. */
  queueTargets: ReadonlyMap<string, MonitorQueueConsumerTarget>;
  /** The allowlist's parse error (a malformed var is a DEPLOYMENT
   *  misconfiguration the admin must see — the arm degrades to unconfigured
   *  carrying this reason; it never throws and never partially trusts). */
  queueAllowlistError: string | null;
}

/**
 * The platform arms' env slice — the RAW NAMES the adapters read,
 * structurally optional. The names are NOT in the generated Env until the
 * orchestrator's wrangler.jsonc fold adds them (AGENTS.md: wrangler.jsonc is
 * account-local; wrangler.jsonc.example is outside this unit's ownership);
 * this plain structural type is the single documented seam: today's Env is
 * assignable to it verbatim (all members optional), and after the fold +
 * `wrangler types` the same read serves the declared names. No `any`, no
 * cast-through-unknown anywhere.
 */
export type MonitorPlatformEnvSlice = {
  CLOUDFLARE_ACCOUNT_ID?: string;
  MONITOR_QUEUE_CONSUMERS?: string;
  MONITOR_WORKER_NAME?: string;
  CLOUDFLARE_QUEUES_TOKEN?: string;
  CLOUDFLARE_PROFILE_TOKEN?: string;
};

/** The committed config's worker name — MONITOR_WORKER_NAME's default (the
 *  example config is the template every deployment is cut from). */
export const DEFAULT_MONITOR_WORKER_NAME = "cf-gitea";

/** The allowlist JSON's shape check: every entry must carry non-empty
 *  queue_id + consumer_id strings; declared_max_concurrency must be a
 *  non-negative integer or null when present. Anything else fails the WHOLE
 *  var (no partial trust — an allowlist is a security boundary). */
export function parseMonitorQueueAllowlist(raw: string | undefined): {
  targets: ReadonlyMap<string, MonitorQueueConsumerTarget>;
  error: string | null;
} {
  if (raw === undefined || raw.trim() === "") {
    return { targets: new Map(), error: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { targets: new Map(), error: `MONITOR_QUEUE_CONSUMERS is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { targets: new Map(), error: "MONITOR_QUEUE_CONSUMERS must be a JSON object keyed by queue name" };
  }
  const targets = new Map<string, MonitorQueueConsumerTarget>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) {
      return { targets: new Map(), error: `MONITOR_QUEUE_CONSUMERS key is not a queue-name shape: ${JSON.stringify(key).slice(0, 64)}` };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { targets: new Map(), error: `MONITOR_QUEUE_CONSUMERS[${key}] must be an object` };
    }
    const entry = value as Record<string, unknown>;
    const queueId = entry.queue_id;
    const consumerId = entry.consumer_id;
    if (typeof queueId !== "string" || queueId === "") {
      return { targets: new Map(), error: `MONITOR_QUEUE_CONSUMERS[${key}].queue_id must be a non-empty string` };
    }
    if (typeof consumerId !== "string" || consumerId === "") {
      return { targets: new Map(), error: `MONITOR_QUEUE_CONSUMERS[${key}].consumer_id must be a non-empty string` };
    }
    const declaredRaw = entry.declared_max_concurrency;
    let declared: number | null = null;
    if (declaredRaw !== undefined && declaredRaw !== null) {
      if (typeof declaredRaw !== "number" || !Number.isInteger(declaredRaw) || declaredRaw < 0) {
        return { targets: new Map(), error: `MONITOR_QUEUE_CONSUMERS[${key}].declared_max_concurrency must be a non-negative integer or null` };
      }
      declared = declaredRaw;
    }
    targets.set(key, { key, queueId, consumerId, declaredMaxConcurrency: declared });
  }
  return { targets, error: null };
}

/** Assemble the platform config from the (sliced) env — the ONE read of the
 *  raw names; everything downstream takes the parsed config. The union is
 *  the fold's seam: today's Env (names absent) and the post-fold Env (names
 *  declared) BOTH pass; the internal narrowing is safe by construction —
 *  every slice member is optional and every read is undefined-checked. */
export function monitorPlatformConfigFromEnv(env: MonitorPlatformEnvSlice | Env): MonitorPlatformConfig {
  const slice = env as MonitorPlatformEnvSlice;
  const { targets, error } = parseMonitorQueueAllowlist(slice.MONITOR_QUEUE_CONSUMERS);
  return {
    accountId: slice.CLOUDFLARE_ACCOUNT_ID,
    queuesToken: slice.CLOUDFLARE_QUEUES_TOKEN,
    profileToken: slice.CLOUDFLARE_PROFILE_TOKEN,
    workerName: slice.MONITOR_WORKER_NAME && slice.MONITOR_WORKER_NAME.trim() !== "" ? slice.MONITOR_WORKER_NAME.trim() : DEFAULT_MONITOR_WORKER_NAME,
    queueTargets: targets,
    queueAllowlistError: error,
  };
}

// ---------------------------------------------------------------------------
// The Cloudflare API call core — envelope parsing + the frozen failure
// taxonomy's outcome union. The arms (queue-concurrency/profile) map the
// outcomes onto their own verdicts; the mapping lives in ONE classifier.
// ---------------------------------------------------------------------------

/** The Cloudflare envelope's error entry (ResponseInfo). */
export interface CfApiError {
  code: number | null;
  message: string;
}

/** The structured outcome of one Cloudflare API call. `ok` carries the
 *  envelope's `result`; every failure kind names its taxonomy class so no
 *  caller can mistake a 401 for "platform unsupported". */
export type CfApiOutcome<T> =
  | { kind: "ok"; result: T }
  /** The arm's secret/var is absent — the skip/warn arm (never a 0, never a
   *  fabricated success). */
  | { kind: "unconfigured" }
  /** 401/403 — the frozen taxonomy's FAIL class: insufficient permissions,
   *  NEVER "platform unsupported". */
  | { kind: "auth"; status: number; errors: CfApiError[] }
  /** 400 — a rejected request shape (fail). */
  | { kind: "bad-request"; status: number; errors: CfApiError[] }
  /** 404 — a wrong id (fail; the allowlist's ids and the platform disagree). */
  | { kind: "not-found"; status: number; errors: CfApiError[] }
  /** 429 — bounded retries exhausted; Retry-After was honored between them. */
  | { kind: "rate-limited"; retryAfterMs: number | null; attempts: number }
  /** Network failure / 5xx / any other status — the platform is not
   *  answering normally. */
  | { kind: "platform-unavailable"; status: number | null; message: string };

/** The bounded 429 posture: honor Retry-After (capped), at most
 *  `retries` retries, then report rate-limited. */
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_RETRY_CAP_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parse Retry-After (seconds per the spec; Cloudflare may send seconds) →
 *  ms, capped; null = absent/unparseable. */
function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number.parseFloat(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, RATE_LIMIT_RETRY_CAP_MS);
}

/** The error entries of an envelope-shaped body (or a fallback when the body
 *  is not envelope JSON — binary error bodies, HTML error pages). */
function envelopeErrors(text: string): CfApiError[] {
  try {
    const parsed = JSON.parse(text) as { errors?: unknown };
    if (Array.isArray(parsed.errors)) {
      return parsed.errors.map((e) => {
        const entry = (e ?? {}) as { code?: unknown; message?: unknown };
        return {
          code: typeof entry.code === "number" ? entry.code : null,
          message: typeof entry.message === "string" ? entry.message : "",
        };
      });
    }
  } catch {
    // fall through — not JSON
  }
  return [{ code: null, message: text.slice(0, 200) }];
}

/** One fetch attempt: either a Response or an already-classified network
 *  failure (the two cores share the attempt + the 429 loop). */
type FetchAttempt = { res: Response } | { failed: CfApiOutcome<never> };

/** The fetch attempt shared by both cores — a network throw is the
 *  platform-unavailable arm (status null), never an application crash. */
async function doFetchRequest(
  options: { apiToken: string | undefined; method: string; url: string; body?: string },
  doFetch: FetchImpl,
): Promise<FetchAttempt> {
  try {
    const res = await doFetch(options.url, {
      method: options.method,
      headers: {
        authorization: `Bearer ${options.apiToken}`,
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: options.body,
    });
    return { res };
  } catch (err) {
    return { failed: { kind: "platform-unavailable", status: null, message: err instanceof Error ? err.message : String(err) } };
  }
}

/** The bounded 429 posture shared by both cores: honor Retry-After (capped),
 *  at most RATE_LIMIT_RETRIES retries, then report rate-limited. Returns
 *  null = not rate-limited (the caller proceeds with the response); a
 *  non-null value is the exhausted report. */
async function handle429<T>(
  res: Response,
  attempts: number,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<CfApiOutcome<T> | null> {
  const retryAfter = retryAfterMs(res.headers);
  if (attempts <= RATE_LIMIT_RETRIES) {
    await sleepImpl(retryAfter ?? 1_000);
    return null;
  }
  return { kind: "rate-limited", retryAfterMs: retryAfter, attempts };
}

/** The shared request core (JSON-envelope arms): one Cloudflare API request
 *  with the frozen taxonomy's classification and the bounded 429 loop.
 *  `apiToken` undefined ⇒ {kind:"unconfigured"} without a fetch (the
 *  skip/warn arm never touches the network). `parseResult` decodes the
 *  envelope's `result` (thrown parse errors land in platform-unavailable —
 *  an unreadable success body is a platform misbehavior, not an application
 *  bug). Exported for the sibling adapters (queue-concurrency's GET/PUT ride
 *  it directly). */
export async function cfApiEnvelopeRequest<T>(options: {
  apiToken: string | undefined;
  method: string;
  url: string;
  body?: string;
  parseResult: (result: unknown) => T;
  fetchImpl?: FetchImpl;
  /** Test seam: the bounded-retry sleep (real timers otherwise). */
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<CfApiOutcome<T>> {
  if (options.apiToken === undefined || options.apiToken === "") {
    return { kind: "unconfigured" };
  }
  const doFetch = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  let attempts = 0;
  for (;;) {
    attempts++;
    const attempt = await doFetchRequest(options, doFetch);
    if ("failed" in attempt) return attempt.failed;
    const res = attempt.res;
    if (res.status === 429) {
      const exhausted = await handle429<T>(res, attempts, sleepImpl);
      if (exhausted !== null) return exhausted;
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      return classifyNonOk(res.status, text);
    }
    let envelope: { result?: unknown };
    try {
      envelope = JSON.parse(text) as { result?: unknown };
    } catch {
      return { kind: "platform-unavailable", status: res.status, message: `success status with a non-JSON body: ${text.slice(0, 120)}` };
    }
    try {
      return { kind: "ok", result: options.parseResult(envelope.result) };
    } catch (err) {
      return { kind: "platform-unavailable", status: res.status, message: `unexpected result shape: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

/** One Cloudflare API request carrying the BINARY response arms (profiling):
 *  the `ok` outcome carries the raw Response (the caller streams the
 *  gzipped pprof bytes); failures classify by status after draining the body
 *  (error bodies are envelope JSON, never binary). `apiToken` undefined ⇒
 *  {kind:"unconfigured"} without a fetch. */
export async function cfApiBinaryRequest(options: {
  apiToken: string | undefined;
  method: string;
  url: string;
  body?: string;
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<CfApiOutcome<Response>> {
  if (options.apiToken === undefined || options.apiToken === "") {
    return { kind: "unconfigured" };
  }
  const doFetch = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  let attempts = 0;
  for (;;) {
    attempts++;
    const attempt = await doFetchRequest(options, doFetch);
    if ("failed" in attempt) return attempt.failed;
    const res = attempt.res;
    if (res.status === 429) {
      const exhausted = await handle429<Response>(res, attempts, sleepImpl);
      if (exhausted !== null) return exhausted;
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      return classifyNonOk(res.status, text);
    }
    return { kind: "ok", result: res };
  }
}

function classifyNonOk<T>(status: number, text: string): CfApiOutcome<T> {
  const errors = envelopeErrors(text);
  if (status === 401 || status === 403) {
    return { kind: "auth", status, errors };
  }
  if (status === 400 || status === 405 || status === 415) {
    return { kind: "bad-request", status, errors };
  }
  if (status === 404) {
    return { kind: "not-found", status, errors };
  }
  return { kind: "platform-unavailable", status, message: errors.map((e) => e.message).join("; ").slice(0, 200) };
}

/** The environment-status classifier (SPEC-0021 §6) — ONE mapping from the
 *  outcome unions onto the four-value dimension, shared by every arm's UI.
 *  The input is the minimal structural shape (every arm's outcome union —
 *  CfApiOutcome<T>, the queue loop's, the profile's — carries at least
 *  these members, so each classifies without casts). */
export function classifyPlatformStatus(outcome:
  | { kind: "ok"; [k: string]: unknown }
  | { kind: "unconfigured" }
  | { kind: "auth"; status: number; [k: string]: unknown }
  | { kind: "bad-request"; status: number; [k: string]: unknown }
  | { kind: "not-found"; status: number; [k: string]: unknown }
  | { kind: "rate-limited"; attempts: number; retryAfterMs: number | null; [k: string]: unknown }
  | { kind: "platform-unavailable"; message: string; [k: string]: unknown }
  | { kind: "read-failed"; status: MonitorPlatformStatus; detail: string }
  | { kind: "write-failed"; status: MonitorPlatformStatus; detail: string }
  | { kind: "verify-failed"; expected: number | null; got: number | null; attempts: number }
  | { kind: "invalid-response"; message: string }): {
  status: MonitorPlatformStatus;
  detail: string | null;
} {
  switch (outcome.kind) {
    case "ok":
      return { status: "available", detail: null };
    case "unconfigured":
      return { status: "unconfigured", detail: "the Cloudflare API token / vars for this arm are not configured" };
    case "auth":
      return { status: "insufficient-permissions", detail: `the platform answered ${outcome.status} — the token lacks the required permission (never report this as "platform unsupported")` };
    case "bad-request":
      return { status: "platform-unavailable", detail: `the platform rejected the request (${outcome.status})` };
    case "not-found":
      return { status: "platform-unavailable", detail: "the platform answered 404 — the configured queue/consumer/worker id does not resolve" };
    case "rate-limited":
      return { status: "platform-unavailable", detail: `rate limited after ${outcome.attempts} attempts (Retry-After ${outcome.retryAfterMs ?? "absent"})` };
    case "platform-unavailable":
      return { status: "platform-unavailable", detail: outcome.message };
    case "read-failed":
    case "write-failed":
      return { status: outcome.status, detail: outcome.detail };
    case "verify-failed":
      return { status: "platform-unavailable", detail: `read-back mismatch after ${outcome.attempts} verify reads (expected ${outcome.expected ?? "auto"}, got ${outcome.got ?? "auto"})` };
    case "invalid-response":
      return { status: "platform-unavailable", detail: outcome.message };
  }
}

// ---------------------------------------------------------------------------
// The deployments read (the diagnosis report's deployment-version item; also
// the profile trigger's serving-version source). Token: the PROFILE token
// (Workers Scripts Read covers the deployments read).
// ---------------------------------------------------------------------------

export interface WorkerDeploymentInfo {
  /** The deployment id. */
  id: string;
  createdOn: string | null;
  source: string | null;
  /** The deployment's message annotation (`workers/message`) when present. */
  message: string | null;
  /** versions[{percentage, version_id}] verbatim. */
  versions: Array<{ percentage: number; versionId: string }>;
}

/** GET the latest actively-serving deployment (the list's FIRST item —
 *  developers.cloudflare.com/api/resources/workers/subresources/scripts/
 *  subresources/deployments/methods/list/). */
export async function readLatestDeployment(options: {
  accountId: string | undefined;
  apiToken: string | undefined;
  workerName: string;
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<CfApiOutcome<WorkerDeploymentInfo | null>> {
  if (options.accountId === undefined || options.accountId === "") {
    return { kind: "unconfigured" };
  }
  return cfApiEnvelopeRequest<WorkerDeploymentInfo | null>({
    apiToken: options.apiToken,
    method: "GET",
    url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/workers/scripts/${encodeURIComponent(options.workerName)}/deployments`,
    parseResult: (result) => {
      // result: { deployments: [...] } — the FIRST item serves traffic.
      const deployments = (result as { deployments?: unknown } | null)?.deployments;
      if (!Array.isArray(deployments) || deployments.length === 0) {
        return null;
      }
      const first = deployments[0] as Record<string, unknown>;
      const annotations = (first.annotations ?? null) as Record<string, unknown> | null;
      const versions = Array.isArray(first.versions)
        ? (first.versions as Array<Record<string, unknown>>).map((v) => ({
            percentage: typeof v.percentage === "number" ? v.percentage : 0,
            versionId: typeof v.version_id === "string" ? v.version_id : "",
          }))
        : [];
      return {
        id: typeof first.id === "string" ? first.id : "",
        createdOn: typeof first.created_on === "string" ? first.created_on : null,
        source: typeof first.source === "string" ? first.source : null,
        message: annotations && typeof annotations["workers/message"] === "string" ? (annotations["workers/message"]) : null,
        versions,
      };
    },
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });
}

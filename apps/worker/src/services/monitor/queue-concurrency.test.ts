/**
 * The /set ARM's tests (SPEC-0021 §7 — the verification split's module half):
 * the closed loop's request LITERALS over the fetchImpl seam (the GET/PUT
 * paths, the Bearer auth, the PUT body preserving every untouched consumer
 * setting and changing ONLY settings.max_concurrency), the verify step
 * (read-back-mismatch = FAIL after the bounded reads — never a claimed
 * success), the frozen taxonomy arms (401/403 = insufficient-permissions,
 * 400 = bad-request, 429 = bounded retry then report, unconfigured = the
 * skip/warn arm without a fetch), the upstream max-number form parse (the
 * clamps and the auto alias), and the audit row (operator, before, after,
 * API result, timestamp) over the real D1.
 */

import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { auditEvents } from "../../db/schema";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import {
  MAX_CONCURRENCY_MAX,
  MAX_CONCURRENCY_MIN,
  MONITOR_QUEUE_SET_AUDIT_ACTION,
  applyAdminMonitorQueueSet,
  buildConsumerPutBody,
  monitorQueueSetFlashText,
  parseMonitorQueueSetForm,
  readQueueConsumer,
  setQueueConsumerMaxConcurrency,
  type QueueConsumerSettings,
} from "./queue-concurrency";
import type { FetchImpl, MonitorPlatformConfig } from "./platform";

// --- the fetch stub (the platform.test.ts shape) -----------------------------

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function stubFetch(responses: (Response | ((req: RecordedRequest) => Response))[]): { fetchImpl: FetchImpl; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) headers[key.toLowerCase()] = value;
    }
    const body =
      init?.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : new TextDecoder().decode(await new Response(init.body as BodyInit).arrayBuffer());
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    const response = responses[calls.length - 1];
    if (response === undefined) throw new Error(`unexpected request #${calls.length}: ${url}`);
    return typeof response === "function" ? response(calls[calls.length - 1]!) : response;
  };
  return { fetchImpl, calls };
}

const consumerEnvelope = (settings: Partial<QueueConsumerSettings>) =>
  new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: {
        consumer_id: "c1",
        created_on: "2026-10-01T00:00:00Z",
        dead_letter_queue: settings.deadLetterQueue ?? "repo-tasks-dlq",
        queue_name: "repo-tasks",
        script_name: settings.scriptName ?? "cf-gitea",
        type: "worker",
        settings: {
          batch_size: settings.batchSize ?? 1,
          max_concurrency: settings.maxConcurrency ?? null,
          max_retries: settings.maxRetries ?? 5,
          max_wait_time_ms: settings.maxWaitTimeMs ?? 5000,
          retry_delay: settings.retryDelay ?? 10,
        },
      },
    }),
    { status: 200 },
  );

const TARGET = { queueId: "repo-tasks", consumerId: "c1" };
const noSleep = () => Promise.resolve();

// --- the form parse (upstream's max-number field) -----------------------------

describe("parseMonitorQueueSetForm (upstream's max-number field)", () => {
  it("the empty field is the keep-current arm (upstream re-sets the current value)", () => {
    expect(parseMonitorQueueSetForm(new URLSearchParams({ "max-number": "" }))).toBe("keep-current");
    expect(parseMonitorQueueSetForm(new URLSearchParams({ "max-number": "  " }))).toBe("keep-current");
    expect(parseMonitorQueueSetForm(new URLSearchParams({}))).toBe("keep-current");
  });

  it("the validated range passes through; the bounds are the freeze's 1..250", () => {
    expect(MAX_CONCURRENCY_MIN).toBe(1);
    expect(MAX_CONCURRENCY_MAX).toBe(250);
    expect(parseMonitorQueueSetForm(new URLSearchParams({ "max-number": "1" }))).toBe(1);
    expect(parseMonitorQueueSetForm(new URLSearchParams({ "max-number": "250" }))).toBe(250);
    expect(parseMonitorQueueSetForm(new URLSearchParams({ "max-number": " 8 " }))).toBe(8);
  });

  it("the auto arm: the literal and upstream's -1 alias (and the < -1 clamp) map to null", () => {
    expect(parseMonitorQueueSetForm(new URLSearchParams({ "max-number": "auto" }))).toBeNull();
    expect(parseMonitorQueueSetForm(new URLSearchParams({ "max-number": "-1" }))).toBeNull();
    expect(parseMonitorQueueSetForm(new URLSearchParams({ "max-number": "-40" }))).toBeNull();
  });

  it("out-of-range and non-integer values are the failed binding (0, 251, junk)", () => {
    for (const bad of ["0", "251", "abc", "3.5", "+7", "1e2"]) {
      expect(parseMonitorQueueSetForm(new URLSearchParams({ "max-number": bad })), bad).toBeNull();
    }
  });
});

// --- the PUT body builder (the preservation rule made structural) --------------

describe("buildConsumerPutBody (change ONLY settings.max_concurrency)", () => {
  it("preserves every read field verbatim and changes only max_concurrency", () => {
    const body = JSON.parse(
      buildConsumerPutBody(
        {
          consumerId: "c1",
          scriptName: "cf-gitea",
          type: "worker",
          queueName: "repo-tasks",
          deadLetterQueue: "repo-tasks-dlq",
          createdOn: "2026-10-01T00:00:00Z",
          batchSize: 1,
          maxConcurrency: 1,
          maxRetries: 5,
          maxWaitTimeMs: 5000,
          retryDelay: 10,
        },
        4,
      ),
    ) as { type: string; script_name: string; dead_letter_queue: string | null; settings: Record<string, unknown> };
    // The PUT replaces the consumer wholesale — every preserved field must
    // ride the body (dropping one DROPS the setting).
    expect(body).toEqual({
      type: "worker",
      script_name: "cf-gitea",
      dead_letter_queue: "repo-tasks-dlq",
      settings: {
        batch_size: 1,
        max_concurrency: 4, // THE change
        max_retries: 5,
        max_wait_time_ms: 5000,
        retry_delay: 10,
      },
    });
  });

  it("the auto arm writes null; absent read fields stay absent (no invented defaults)", () => {
    const body = JSON.parse(
      buildConsumerPutBody(
        {
          consumerId: "c1",
          scriptName: null,
          type: "worker",
          queueName: "q",
          deadLetterQueue: null,
          createdOn: null,
          batchSize: null,
          maxConcurrency: 3,
          maxRetries: null,
          maxWaitTimeMs: null,
          retryDelay: null,
        },
        null,
      ),
    ) as { type: string; script_name: string; dead_letter_queue: string | null; settings: Record<string, unknown> };
    expect(body).toEqual({ type: "worker", settings: { max_concurrency: null } });
  });
});

// --- the closed loop ------------------------------------------------------------

describe("setQueueConsumerMaxConcurrency (the read → modify → write → verify loop)", () => {
  it("the request literals: GET/PUT paths + Bearer auth + the preserving PUT body", async () => {
    const { fetchImpl, calls } = stubFetch([
      consumerEnvelope({ maxConcurrency: 1 }),
      consumerEnvelope({ maxConcurrency: 4 }),
      consumerEnvelope({ maxConcurrency: 4 }),
    ]);
    const outcome = await setQueueConsumerMaxConcurrency({
      accountId: "acct01",
      apiToken: "q-tok",
      target: TARGET,
      maxConcurrency: 4,
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(outcome.kind).toBe("ok");
    expect(calls).toHaveLength(3); // read, write, verify
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct01/queues/repo-tasks/consumers/c1");
    expect(calls[0]!.headers.authorization).toBe("Bearer q-tok");
    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.url).toBe(calls[0]!.url);
    const putBody = JSON.parse(calls[1]!.body!) as { settings: Record<string, unknown>; dead_letter_queue: string | null };
    expect(putBody.settings.max_concurrency).toBe(4); // the change
    expect(putBody.settings.batch_size).toBe(1); // preserved
    expect(putBody.settings.max_retries).toBe(5); // preserved
    expect(putBody.dead_letter_queue).toBe("repo-tasks-dlq"); // preserved
    // The loop's before/after/effective triple (the audit row's inputs).
    if (outcome.kind === "ok") {
      expect(outcome.before).toBe(1);
      expect(outcome.after).toBe(4);
      expect(outcome.effective).toBe(4);
      expect(outcome.settings.maxConcurrency).toBe(4); // the VERIFIED read
    }
  });

  it("the verify step retries the read-back and fails on a persistent mismatch (read-back-mismatch = FAIL)", async () => {
    // The PUT "succeeds" but the platform keeps answering the OLD value.
    const { fetchImpl, calls } = stubFetch([
      consumerEnvelope({ maxConcurrency: 1 }),
      consumerEnvelope({ maxConcurrency: 4 }),
      consumerEnvelope({ maxConcurrency: 1 }),
      consumerEnvelope({ maxConcurrency: 1 }),
      consumerEnvelope({ maxConcurrency: 1 }),
    ]);
    const outcome = await setQueueConsumerMaxConcurrency({
      accountId: "a",
      apiToken: "t",
      target: TARGET,
      maxConcurrency: 4,
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(outcome).toEqual({ kind: "verify-failed", expected: 4, got: 1, attempts: 3 });
    expect(calls).toHaveLength(5); // read + write + 3 verify reads
  });

  it("the frozen taxonomy arms: 401 on the read = read-failed/insufficient-permissions; 400 on the write = write-failed; no token = unconfigured without a fetch", async () => {
    const auth = stubFetch([new Response('{"errors":[]}', { status: 401 })]);
    const readFail = await setQueueConsumerMaxConcurrency({
      accountId: "a",
      apiToken: "t",
      target: TARGET,
      maxConcurrency: 2,
      fetchImpl: auth.fetchImpl,
      sleepImpl: noSleep,
    });
    expect(readFail.kind).toBe("read-failed");
    expect(readFail.kind === "read-failed" && readFail.status).toBe("insufficient-permissions");

    const badReq = stubFetch([
      consumerEnvelope({ maxConcurrency: 1 }),
      new Response('{"errors":[{"message":"validation failed"}]}', { status: 400 }),
    ]);
    const writeFail = await setQueueConsumerMaxConcurrency({
      accountId: "a",
      apiToken: "t",
      target: TARGET,
      maxConcurrency: 2,
      fetchImpl: badReq.fetchImpl,
      sleepImpl: noSleep,
    });
    expect(writeFail.kind).toBe("write-failed");
    expect(writeFail.kind === "write-failed" && writeFail.status).toBe("platform-unavailable");

    const noToken = stubFetch([]);
    const unconfigured = await setQueueConsumerMaxConcurrency({
      accountId: "a",
      apiToken: undefined,
      target: TARGET,
      maxConcurrency: 2,
      fetchImpl: noToken.fetchImpl,
    });
    expect(unconfigured).toEqual({ kind: "unconfigured" });
    expect(noToken.calls).toEqual([]);
  });

  it("a 429 mid-loop rides the bounded retry (then the loop proceeds)", async () => {
    const { fetchImpl, calls } = stubFetch([
      new Response("", { status: 429, headers: { "retry-after": "0" } }),
      consumerEnvelope({ maxConcurrency: 1 }),
      consumerEnvelope({ maxConcurrency: 2 }),
      consumerEnvelope({ maxConcurrency: 2 }),
    ]);
    const outcome = await setQueueConsumerMaxConcurrency({
      accountId: "a",
      apiToken: "t",
      target: TARGET,
      maxConcurrency: 2,
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(outcome.kind).toBe("ok");
    expect(calls).toHaveLength(4);
  });
});

describe("readQueueConsumer (the runtime read the manage page displays)", () => {
  it("parses the consumer settings verbatim (nulls preserved)", async () => {
    const { fetchImpl, calls } = stubFetch([consumerEnvelope({ maxConcurrency: 7, batchSize: 3 })]);
    const outcome = await readQueueConsumer({ accountId: "a", apiToken: "t", target: TARGET, fetchImpl });
    expect(outcome.kind).toBe("ok");
    expect(calls[0]!.method).toBe("GET");
    if (outcome.kind === "ok") {
      expect(outcome.settings.maxConcurrency).toBe(7);
      expect(outcome.settings.batchSize).toBe(3);
      expect(outcome.settings.scriptName).toBe("cf-gitea");
      expect(outcome.settings.deadLetterQueue).toBe("repo-tasks-dlq");
    }
  });
});

// --- the flash texts -------------------------------------------------------------

describe("monitorQueueSetFlashText (upstream's changed/error flashes)", () => {
  it("the applied loop answers Settings Updated; every degraded arm answers a negative naming the state", () => {
    expect(monitorQueueSetFlashText({ kind: "ok", before: 1, after: 2, effective: 2, settings: {} as QueueConsumerSettings })).toEqual({
      kind: "positive",
      text: "Settings Updated",
    });
    expect(monitorQueueSetFlashText({ kind: "unconfigured" }).kind).toBe("negative");
    expect(monitorQueueSetFlashText({ kind: "verify-failed", expected: 2, got: 1, attempts: 3 }).text).toContain("Read-back mismatch");
    expect(monitorQueueSetFlashText({ kind: "read-failed", status: "insufficient-permissions", detail: "d" }).text).toContain("Reading the consumer failed");
    expect(monitorQueueSetFlashText({ kind: "write-failed", status: "platform-unavailable", detail: "d" }).text).toContain("Writing the consumer failed");
  });
});

// --- the route-level apply (real D1 for the audit row) ----------------------------

/** The platform config for the apply tests (the server-side allowlist with
 *  one entry; the declared value mirrors wrangler.jsonc's 1). */
function platformConfig(): MonitorPlatformConfig {
  return {
    accountId: "acct01",
    queuesToken: "q-tok",
    profileToken: undefined,
    workerName: "cf-gitea",
    queueTargets: new Map([["repo-tasks", { key: "repo-tasks", queueId: "repo-tasks", consumerId: "c1", declaredMaxConcurrency: 1 }]]),
    queueAllowlistError: null,
  };
}

describe("applyAdminMonitorQueueSet (the route apply: loop + audit row)", () => {
  beforeAll(async () => {
    await applyAuthD1Migrations();
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM audit_event").run();
  });

  it("an applied write emits the audit row (operator, before, after, API result, timestamp)", async () => {
    const AT = new Date("2026-11-01T12:00:00Z");
    const { fetchImpl, calls } = stubFetch([
      consumerEnvelope({ maxConcurrency: 1 }),
      consumerEnvelope({ maxConcurrency: 3 }),
      consumerEnvelope({ maxConcurrency: 3 }),
    ]);
    const result = await applyAdminMonitorQueueSet({} as Env, env.DB, "repo-tasks", 3, {
      actorId: 7,
      actorName: "root",
      now: AT,
      fetchImpl,
      sleepImpl: noSleep,
      platform: platformConfig(),
    });
    expect(result.flash).toEqual({ kind: "positive", text: "Settings Updated" });
    expect(calls).toHaveLength(3);
    const rows = await drizzle(env.DB).select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe(MONITOR_QUEUE_SET_AUDIT_ACTION);
    expect(rows[0]!.actorId).toBe(7);
    expect(rows[0]!.actorName).toBe("root");
    expect(rows[0]!.scopeType).toBe("system");
    expect(rows[0]!.origin).toBe("ui");
    expect(rows[0]!.message).toContain("repo-tasks");
    expect(rows[0]!.message).toContain("1");
    expect(rows[0]!.message).toContain("3");
    const metadata = JSON.parse(rows[0]!.metadata!) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      queue: "repo-tasks",
      consumer_id: "c1",
      before_max_concurrency: 1,
      after_max_concurrency: 3,
      effective_max_concurrency: 3,
      declared_max_concurrency: 1,
      api_result: "ok",
    });
    expect(rows[0]!.createdUnix.toISOString()).toBe(AT.toISOString());
  });

  it("an unconfigured queue name answers the honest negative WITHOUT any API call or audit row", async () => {
    const { fetchImpl, calls } = stubFetch([]);
    const result = await applyAdminMonitorQueueSet({} as Env, env.DB, "webhook-delivery-dlq", 2, {
      actorId: 7,
      actorName: "root",
      fetchImpl,
      sleepImpl: noSleep,
      platform: platformConfig(),
    });
    expect(result.outcome).toEqual({ kind: "unconfigured" });
    expect(result.flash.kind).toBe("negative");
    expect(calls).toEqual([]);
    expect(await drizzle(env.DB).select().from(auditEvents).all()).toEqual([]);
  });

  it("a failed loop writes no audit row (only the ok loop audits)", async () => {
    const { fetchImpl } = stubFetch([new Response('{"errors":[]}', { status: 403 })]);
    const result = await applyAdminMonitorQueueSet({} as Env, env.DB, "repo-tasks", 2, {
      actorId: 7,
      actorName: "root",
      fetchImpl,
      sleepImpl: noSleep,
      platform: platformConfig(),
    });
    expect(result.outcome.kind).toBe("read-failed");
    expect(result.flash.kind).toBe("negative");
    expect(await drizzle(env.DB).select().from(auditEvents).all()).toEqual([]);
  });

  it("the keep-current arm reads the current value and re-sets it (upstream's empty-field posture)", async () => {
    const { fetchImpl, calls } = stubFetch([
      consumerEnvelope({ maxConcurrency: 1 }), // the keep-current read
      consumerEnvelope({ maxConcurrency: 1 }), // the loop's read
      consumerEnvelope({ maxConcurrency: 1 }), // the PUT (same value)
      consumerEnvelope({ maxConcurrency: 1 }), // the verify read
    ]);
    const result = await applyAdminMonitorQueueSet({} as Env, env.DB, "repo-tasks", "keep-current", {
      actorId: 7,
      actorName: "root",
      fetchImpl,
      sleepImpl: noSleep,
      platform: platformConfig(),
    });
    expect(result.flash).toEqual({ kind: "positive", text: "Settings Updated" });
    expect(calls).toHaveLength(4); // keep-current read + the loop's three
    const putBody = JSON.parse(calls[2]!.body!) as { settings: { max_concurrency: number | null } };
    expect(putBody.settings.max_concurrency).toBe(1); // re-set, not changed
  });
});

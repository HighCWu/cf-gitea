/**
 * The MONITOR PLATFORM SEAM's tests (SPEC-0021 §7 — the verification split's
 * MODULE half): the request LITERALS (method, path, auth header, body) over
 * the fetchImpl seam (the gitclient.test.ts stub shape — NO real network),
 * the envelope/taxonomy classification TABLE (the frozen split: token
 * unconfigured = the skip/warn arm without a fetch; 401/403 =
 * insufficient-permissions, NEVER "platform unsupported"; 400 = fail;
 * 429 = bounded retry then report), the bounded-retry mechanics
 * (Retry-After honored through the injected sleep), and the allowlist parse
 * (the server-side security boundary — a malformed var fails WHOLE, never
 * partially trusted).
 */

import { describe, expect, it } from "vitest";

import {
  classifyPlatformStatus,
  cfApiBinaryRequest,
  cfApiEnvelopeRequest,
  monitorPlatformConfigFromEnv,
  parseMonitorQueueAllowlist,
  readLatestDeployment,
  type FetchImpl,
} from "./platform";

// --- the fetch stub (the gitclient.test.ts shape) -----------------------------

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch stub answering one canned response per call, recording requests.
 *  A function response receives the recorded call (429 sequences). */
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

const envelope = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 });

/** The bounded-retry test's no-op sleep (real 1s waits would stall the run). */
const noSleep = () => Promise.resolve();

// --- the allowlist parse (the server-side security boundary) -------------------

describe("parseMonitorQueueAllowlist (the server-side allowlist)", () => {
  it("absent/empty var answers an empty map with no error (the unconfigured posture)", () => {
    expect(parseMonitorQueueAllowlist(undefined)).toEqual({ targets: new Map(), error: null });
    expect(parseMonitorQueueAllowlist("")).toEqual({ targets: new Map(), error: null });
    expect(parseMonitorQueueAllowlist("   ")).toEqual({ targets: new Map(), error: null });
  });

  it("a valid var parses the targets verbatim (ids passed through, never guessed)", () => {
    const { targets, error } = parseMonitorQueueAllowlist(
      JSON.stringify({
        "repo-tasks": { queue_id: "repo-tasks", consumer_id: "023e105f4ecef8ad9ca31a8372d0c353", declared_max_concurrency: 1 },
        "webhook-delivery": { queue_id: "8f7d…", consumer_id: "abc", declared_max_concurrency: null },
      }),
    );
    expect(error).toBeNull();
    expect(targets.get("repo-tasks")).toEqual({
      key: "repo-tasks",
      queueId: "repo-tasks",
      consumerId: "023e105f4ecef8ad9ca31a8372d0c353",
      declaredMaxConcurrency: 1,
    });
    expect(targets.get("webhook-delivery")).toEqual({
      key: "webhook-delivery",
      queueId: "8f7d…",
      consumerId: "abc",
      declaredMaxConcurrency: null,
    });
  });

  it("a malformed var fails WHOLE (no partial trust — the boundary rule)", () => {
    for (const raw of [
      "{not json",
      "[]",
      "null",
      JSON.stringify({ "repo-tasks": { consumer_id: "c" } }), // queue_id missing
      JSON.stringify({ "repo-tasks": { queue_id: "" } }), // consumer_id missing
      JSON.stringify({ "repo-tasks": { queue_id: "q", consumer_id: "c", declared_max_concurrency: "high" } }),
      JSON.stringify({ "repo-tasks": { queue_id: "q", consumer_id: "c", declared_max_concurrency: -1 } }),
      JSON.stringify({ "bad key!": { queue_id: "q", consumer_id: "c" } }),
    ]) {
      const parsed = parseMonitorQueueAllowlist(raw);
      expect(parsed.targets.size, raw).toBe(0);
      expect(parsed.error, raw).toBeTypeOf("string");
    }
  });
});

describe("monitorPlatformConfigFromEnv (the env-slice read)", () => {
  it("reads the names and defaults the worker name (the committed config's)", () => {
    const config = monitorPlatformConfigFromEnv({
      CLOUDFLARE_ACCOUNT_ID: "acct01",
      MONITOR_QUEUE_CONSUMERS: JSON.stringify({ "repo-tasks": { queue_id: "repo-tasks", consumer_id: "c1" } }),
      CLOUDFLARE_QUEUES_TOKEN: "q-tok",
      CLOUDFLARE_PROFILE_TOKEN: "p-tok",
    });
    expect(config.accountId).toBe("acct01");
    expect(config.queuesToken).toBe("q-tok");
    expect(config.profileToken).toBe("p-tok");
    expect(config.workerName).toBe("cf-gitea");
    expect(config.queueTargets.size).toBe(1);
    expect(config.queueAllowlistError).toBeNull();
  });

  it("a blank MONITOR_WORKER_NAME falls back; a malformed allowlist carries the error", () => {
    const config = monitorPlatformConfigFromEnv({ MONITOR_WORKER_NAME: "  my-worker  ", MONITOR_QUEUE_CONSUMERS: "nope" });
    expect(config.workerName).toBe("my-worker");
    expect(config.queueTargets.size).toBe(0);
    expect(config.queueAllowlistError).toBeTypeOf("string");
  });
});

// --- the request core: literals + the frozen taxonomy table --------------------

describe("cfApiEnvelopeRequest (the request literals + the frozen taxonomy)", () => {
  it("the skip/warm arm: an unconfigured token answers unconfigured WITHOUT a fetch", async () => {
    const { fetchImpl, calls } = stubFetch([envelope({})]);
    const outcome = await cfApiEnvelopeRequest({ apiToken: undefined, method: "GET", url: "https://x", parseResult: (r) => r, fetchImpl });
    expect(outcome).toEqual({ kind: "unconfigured" });
    expect(calls).toEqual([]);
  });

  it("the request literal: Bearer auth header, no content-type without a body", async () => {
    const { fetchImpl, calls } = stubFetch([envelope({ v: 1 })]);
    const outcome = await cfApiEnvelopeRequest({
      apiToken: "tok-123",
      method: "GET",
      url: "https://api.cloudflare.com/client/v4/accounts/a/queues/q/consumers/c",
      parseResult: (r) => r as { v: number },
      fetchImpl,
    });
    expect(outcome).toEqual({ kind: "ok", result: { v: 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/a/queues/q/consumers/c");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-123");
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
    expect(calls[0]!.body).toBeUndefined();
  });

  it("a POST carries the JSON body + content-type", async () => {
    const { fetchImpl, calls } = stubFetch([envelope({})]);
    await cfApiEnvelopeRequest({
      apiToken: "tok",
      method: "POST",
      url: "https://x",
      body: JSON.stringify({ a: 1 }),
      parseResult: (r) => r,
      fetchImpl,
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body).toBe('{"a":1}');
  });

  // THE TAXONOMY TABLE (the frozen verification split — binding):
  it("the taxonomy table: 401/403 = auth (insufficient-permissions, NEVER 'platform unsupported'); 400 = bad-request; 404 = not-found; 5xx/network = platform-unavailable", async () => {
    const cases: Array<{ status: number; kind: string }> = [
      { status: 401, kind: "auth" },
      { status: 403, kind: "auth" },
      { status: 400, kind: "bad-request" },
      { status: 404, kind: "not-found" },
      { status: 500, kind: "platform-unavailable" },
      { status: 503, kind: "platform-unavailable" },
    ];
    for (const c of cases) {
      const { fetchImpl } = stubFetch([
        new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "boom" }] }), { status: c.status }),
      ]);
      const outcome = await cfApiEnvelopeRequest({ apiToken: "tok", method: "GET", url: "https://x", parseResult: (r) => r, fetchImpl, sleepImpl: noSleep });
      expect(outcome.kind, `status ${c.status}`).toBe(c.kind);
    }
    // A network throw is the platform-unavailable arm (status null), never
    // an application crash.
    const failing: FetchImpl = () => Promise.reject(new Error("dial tcp: i/o timeout"));
    const outcome = await cfApiEnvelopeRequest({ apiToken: "tok", method: "GET", url: "https://x", parseResult: (r) => r, fetchImpl: failing });
    expect(outcome).toEqual({ kind: "platform-unavailable", status: null, message: "dial tcp: i/o timeout" });
  });

  it("the bounded 429 loop: Retry-After honored through the injected sleep, then the report", async () => {
    // Two 429s (Retry-After: 0) then a 200 — the loop retries twice.
    const { fetchImpl, calls } = stubFetch([
      new Response("", { status: 429, headers: { "retry-after": "0" } }),
      new Response("", { status: 429, headers: { "retry-after": "0" } }),
      envelope({ done: true }),
    ]);
    const slept: number[] = [];
    const outcome = await cfApiEnvelopeRequest({
      apiToken: "tok",
      method: "GET",
      url: "https://x",
      parseResult: (r) => r as { done: boolean },
      fetchImpl,
      sleepImpl: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect(outcome).toEqual({ kind: "ok", result: { done: true } });
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([0, 0]);
  });

  it("429 beyond the bound reports rate-limited with the attempts + the last Retry-After", async () => {
    const { fetchImpl, calls } = stubFetch([
      new Response("", { status: 429, headers: { "retry-after": "0" } }),
      new Response("", { status: 429, headers: { "retry-after": "0" } }),
      new Response("", { status: 429, headers: { "retry-after": "7" } }),
    ]);
    const outcome = await cfApiEnvelopeRequest({ apiToken: "tok", method: "GET", url: "https://x", parseResult: (r) => r, fetchImpl, sleepImpl: noSleep });
    // Retry-After 7 s reports CAPPED at the 5 s bound (the bounded-retry
    // posture caps the wait, and the report carries the capped value).
    expect(outcome).toEqual({ kind: "rate-limited", retryAfterMs: 5000, attempts: 3 });
    expect(calls).toHaveLength(3); // 1 initial + 2 retries (the bound)
  });

  it("a success status with a non-JSON body (or an unreadable result) is platform-unavailable", async () => {
    const { fetchImpl } = stubFetch([new Response("<html>boom</html>", { status: 200 })]);
    const outcome = await cfApiEnvelopeRequest({ apiToken: "tok", method: "GET", url: "https://x", parseResult: (r) => r, fetchImpl });
    expect(outcome.kind).toBe("platform-unavailable");
    const { fetchImpl: badShape } = stubFetch([new Response(JSON.stringify({ result: 42 }), { status: 200 })]);
    const outcome2 = await cfApiEnvelopeRequest({
      apiToken: "tok",
      method: "GET",
      url: "https://x",
      parseResult: (r) => {
        if (typeof r !== "string") throw new Error("expected string");
        return r;
      },
      fetchImpl: badShape,
    });
    expect(outcome2.kind).toBe("platform-unavailable");
  });
});

describe("cfApiBinaryRequest (the binary-response arms' classification)", () => {
  it("ok carries the raw Response (the caller streams the bytes)", async () => {
    const { fetchImpl } = stubFetch([new Response(new Uint8Array([0x1f, 0x8b]), { status: 200 })]);
    const outcome = await cfApiBinaryRequest({ apiToken: "tok", method: "POST", url: "https://x", body: "{}", fetchImpl });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      const bytes = new Uint8Array(await outcome.result.arrayBuffer());
      expect([...bytes]).toEqual([0x1f, 0x8b]);
    }
  });

  it("an unconfigured token answers unconfigured; error bodies drain and classify", async () => {
    const { fetchImpl, calls } = stubFetch([
      new Response(JSON.stringify({ errors: [{ code: 10000, message: "no token" }] }), { status: 401 }),
    ]);
    const missing = await cfApiBinaryRequest({ apiToken: undefined, method: "POST", url: "https://x", fetchImpl });
    expect(missing).toEqual({ kind: "unconfigured" });
    const auth = await cfApiBinaryRequest({ apiToken: "tok", method: "POST", url: "https://x", body: "{}", fetchImpl });
    expect(auth.kind).toBe("auth");
    expect(calls).toHaveLength(1);
  });

  it("the bounded 429 loop rides the binary arm too", async () => {
    const { fetchImpl, calls } = stubFetch([
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
    ]);
    const outcome = await cfApiBinaryRequest({ apiToken: "tok", method: "POST", url: "https://x", body: "{}", fetchImpl, sleepImpl: noSleep });
    expect(outcome).toEqual({ kind: "rate-limited", retryAfterMs: null, attempts: 3 });
    expect(calls).toHaveLength(3);
  });
});

// --- the classifier (the environment-status dimension) -------------------------

describe("classifyPlatformStatus (the environment-status dimension, SPEC-0021 §6)", () => {
  it("maps every outcome kind onto the frozen four-value dimension", () => {
    expect(classifyPlatformStatus({ kind: "ok" })).toEqual({ status: "available", detail: null });
    expect(classifyPlatformStatus({ kind: "unconfigured" }).status).toBe("unconfigured");
    // 401/403 → insufficient-permissions — the detail pins the NEVER rule.
    const auth = classifyPlatformStatus({ kind: "auth", status: 403 });
    expect(auth.status).toBe("insufficient-permissions");
    expect(auth.detail).toContain("never report this as");
    expect(classifyPlatformStatus({ kind: "bad-request", status: 400 }).status).toBe("platform-unavailable");
    expect(classifyPlatformStatus({ kind: "not-found", status: 404 }).status).toBe("platform-unavailable");
    expect(classifyPlatformStatus({ kind: "rate-limited", attempts: 3, retryAfterMs: null }).status).toBe("platform-unavailable");
    expect(classifyPlatformStatus({ kind: "platform-unavailable", message: "boom" })).toEqual({ status: "platform-unavailable", detail: "boom" });
    // The queue loop's and profile's own kinds classify too (no casts).
    expect(classifyPlatformStatus({ kind: "read-failed", status: "insufficient-permissions", detail: "d" }).status).toBe("insufficient-permissions");
    expect(classifyPlatformStatus({ kind: "verify-failed", expected: 2, got: 1, attempts: 3 }).status).toBe("platform-unavailable");
    expect(classifyPlatformStatus({ kind: "invalid-response", message: "not gzip" }).status).toBe("platform-unavailable");
  });
});

// --- the deployments read (the diagnosis report's deployment item) --------------

describe("readLatestDeployment (GET deployments — the FIRST item serves traffic)", () => {
  it("the request literal + the first-deployment extraction", async () => {
    const { fetchImpl, calls } = stubFetch([
      envelope({
        deployments: [
          {
            id: "dep-1111",
            created_on: "2026-11-01T00:00:00Z",
            source: "wrangler",
            annotations: { "workers/message": "v1.5 deploy" },
            versions: [{ percentage: 100, version_id: "ver-2222-3333" }],
          },
          { id: "dep-old", versions: [] },
        ],
      }),
    ]);
    const outcome = await readLatestDeployment({
      accountId: "acct01",
      apiToken: "p-tok",
      workerName: "cf-gitea",
      fetchImpl,
    });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct01/workers/scripts/cf-gitea/deployments");
    expect(calls[0]!.headers.authorization).toBe("Bearer p-tok");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.result?.id).toBe("dep-1111"); // the FIRST, not the second
      expect(outcome.result?.message).toBe("v1.5 deploy");
      expect(outcome.result?.versions[0]?.versionId).toBe("ver-2222-3333");
    }
  });

  it("an absent account id answers unconfigured without a fetch; no deployments answers null", async () => {
    const { fetchImpl, calls } = stubFetch([envelope({ deployments: [] })]);
    const missing = await readLatestDeployment({ accountId: undefined, apiToken: "t", workerName: "w", fetchImpl });
    expect(missing).toEqual({ kind: "unconfigured" });
    const empty = await readLatestDeployment({ accountId: "a", apiToken: "t", workerName: "w", fetchImpl });
    expect(empty).toEqual({ kind: "ok", result: null });
    expect(calls).toHaveLength(1);
  });
});

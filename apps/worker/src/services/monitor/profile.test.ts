/**
 * The PPROF ADAPTER's tests (SPEC-0021 §7 — the verification split's module
 * half): the profile request's LITERALS (the POST path with the versions
 * segment, the JSON body's bounded duration_ms + profile_type, the Bearer
 * auth), the params parse (the platform's 1..50 s bounds, the type union),
 * the frozen taxonomy arms (unconfigured without a fetch, 401 =
 * insufficient-permissions, 429 = bounded retry then report), and the
 * worker-side content validation (size cap + gzip magic — a wrong-shaped
 * download is refused, never passed to the admin; the DEEP pprof parse is
 * the deploy-probe battery's contract, not this module's).
 */

import { describe, expect, it } from "vitest";

import {
  PROFILE_DURATION_MS_MAX,
  PROFILE_DURATION_MS_MIN,
  PROFILE_MAX_BYTES,
  parseMonitorProfileParams,
  profileFilename,
  requestWorkerProfile,
} from "./profile";
import type { FetchImpl } from "./platform";

// --- the fetch stub -------------------------------------------------------------

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

const noSleep = () => Promise.resolve();

/** A real gzip stream (workerd's CompressionStream) — the magic check must
 *  pass on genuine gzip bytes, not hand-planted ones. */
async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- the params parse ------------------------------------------------------------

describe("parseMonitorProfileParams (the bounded trigger)", () => {
  it("the platform's duration bounds (duration_ms 1000..50000 = seconds 1..50)", () => {
    expect(PROFILE_DURATION_MS_MIN).toBe(1000);
    expect(PROFILE_DURATION_MS_MAX).toBe(50000);
    expect(parseMonitorProfileParams(new URLSearchParams({ seconds: "1" }))).toEqual({ type: "cpu", durationMs: 1000 });
    expect(parseMonitorProfileParams(new URLSearchParams({ seconds: "50" }))).toEqual({ type: "cpu", durationMs: 50000 });
    expect(parseMonitorProfileParams(new URLSearchParams({ seconds: "10", type: "heap" }))).toEqual({ type: "heap", durationMs: 10000 });
  });

  it("out-of-bounds, junk, and unknown types are the failed binding (never a guessed default)", () => {
    const badCases: Array<Record<string, string>> = [
      { seconds: "0" },
      { seconds: "51" },
      { seconds: "abc" },
      { seconds: "10.5" },
      { type: "heap" }, // seconds absent
      { seconds: "10", type: "gpu" },
    ];
    for (const query of badCases) {
      expect(parseMonitorProfileParams(new URLSearchParams(query)), JSON.stringify(query)).toBeNull();
    }
  });
});

describe("profileFilename (the type-prefixed attachment)", () => {
  it("stamps type + UTC time in the upstream diagnosis-filename shape", () => {
    expect(profileFilename("cpu", new Date("2026-11-01T09:07:05Z"))).toBe("cf-gitea-profile-cpu-20261101-090705.pprof.gz");
    expect(profileFilename("heap", new Date("2026-11-01T09:07:05Z"))).toBe("cf-gitea-profile-heap-20261101-090705.pprof.gz");
  });
});

// --- the request ------------------------------------------------------------------

describe("requestWorkerProfile (POST the profile — the verified gzipped pprof)", () => {
  it("the request literal: the versions-segment POST path, the JSON body, the Bearer auth", async () => {
    const bytes = await gzipBytes(new TextEncoder().encode("pprof-content"));
    const { fetchImpl, calls } = stubFetch([new Response(bytes, { status: 200 })]);
    const outcome = await requestWorkerProfile({
      accountId: "acct01",
      apiToken: "p-tok",
      workerName: "cf-gitea",
      type: "cpu",
      durationMs: 10000,
      fetchImpl,
    });
    expect(outcome.kind).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct01/workers/workers/cf-gitea/versions/latest/profile",
    );
    expect(calls[0]!.headers.authorization).toBe("Bearer p-tok");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ duration_ms: 10000, profile_type: "cpu" });
    if (outcome.kind === "ok") {
      expect(outcome.byteLength).toBe(bytes.length);
      expect(outcome.bytes[0]).toBe(0x1f); // the gzip magic rode through
      expect(outcome.bytes[1]).toBe(0x8b);
    }
  });

  it("an explicit versionId rides the path (the serving version from the deployments read)", async () => {
    const bytes = await gzipBytes(new TextEncoder().encode("x"));
    const { fetchImpl, calls } = stubFetch([new Response(bytes, { status: 200 })]);
    await requestWorkerProfile({
      accountId: "a",
      apiToken: "t",
      workerName: "w",
      versionId: "ver-1234",
      type: "heap",
      durationMs: 1000,
      fetchImpl,
    });
    expect(calls[0]!.url).toContain("/versions/ver-1234/profile");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ duration_ms: 1000, profile_type: "heap" });
  });

  it("the skip/warn arm: no token answers unconfigured WITHOUT a fetch", async () => {
    const { fetchImpl, calls } = stubFetch([]);
    const outcome = await requestWorkerProfile({ accountId: "a", apiToken: undefined, workerName: "w", type: "cpu", durationMs: 1000, fetchImpl });
    expect(outcome).toEqual({ kind: "unconfigured" });
    expect(calls).toEqual([]);
  });

  it("the frozen taxonomy: 401 = auth (insufficient-permissions), 429 = bounded retry then report", async () => {
    const auth = stubFetch([new Response('{"errors":[{"message":"nope"}]}', { status: 401 })]);
    const authOutcome = await requestWorkerProfile({
      accountId: "a",
      apiToken: "t",
      workerName: "w",
      type: "cpu",
      durationMs: 1000,
      fetchImpl: auth.fetchImpl,
      sleepImpl: noSleep,
    });
    expect(authOutcome).toMatchObject({ kind: "auth", status: 401 });

    const limited = stubFetch([
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
    ]);
    const rateOutcome = await requestWorkerProfile({
      accountId: "a",
      apiToken: "t",
      workerName: "w",
      type: "cpu",
      durationMs: 1000,
      fetchImpl: limited.fetchImpl,
      sleepImpl: noSleep,
    });
    expect(rateOutcome).toEqual({ kind: "rate-limited", retryAfterMs: null, attempts: 3 });
    expect(limited.calls).toHaveLength(3);
  });

  it("the content validation: an EMPTY body, a non-gzip body, and an over-cap content-length are invalid-response", async () => {
    const empty = stubFetch([new Response(new Uint8Array(0), { status: 200 })]);
    expect(
      (await requestWorkerProfile({ accountId: "a", apiToken: "t", workerName: "w", type: "cpu", durationMs: 1000, fetchImpl: empty.fetchImpl }))
        .kind,
    ).toBe("invalid-response");

    const plain = stubFetch([new Response(new TextEncoder().encode("plain text, not gzip"), { status: 200 })]);
    expect(
      (await requestWorkerProfile({ accountId: "a", apiToken: "t", workerName: "w", type: "cpu", durationMs: 1000, fetchImpl: plain.fetchImpl }))
        .kind,
    ).toBe("invalid-response");

    const overCap = stubFetch([
      new Response("x", {
        status: 200,
        headers: { "content-length": String(PROFILE_MAX_BYTES + 1) },
      }),
    ]);
    const outcome = await requestWorkerProfile({
      accountId: "a",
      apiToken: "t",
      workerName: "w",
      type: "cpu",
      durationMs: 1000,
      fetchImpl: overCap.fetchImpl,
    });
    expect(outcome.kind).toBe("invalid-response");
    expect(outcome.kind === "invalid-response" && outcome.message).toContain("size cap");
  });

  it("a genuine gzip body passes the worker-side validation (the deep parse is the probe's contract)", async () => {
    const bytes = await gzipBytes(new TextEncoder().encode("0".repeat(2048)));
    const ok = stubFetch([new Response(bytes, { status: 200 })]);
    const outcome = await requestWorkerProfile({
      accountId: "a",
      apiToken: "t",
      workerName: "w",
      type: "heap",
      durationMs: 1000,
      fetchImpl: ok.fetchImpl,
    });
    expect(outcome.kind).toBe("ok");
    expect(outcome.kind === "ok" && outcome.type).toBe("heap");
  });
});

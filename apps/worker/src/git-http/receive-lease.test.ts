/**
 * SPEC-0001 §5's disconnect fast-fail amendment (T7a) — the L325 incident
 * regression battery.
 *
 * Production history (2026-11-22/23): a large mirror push to the Workers
 * deployment died mid-transfer ("unexpected disconnect while reading
 * sideband packet" client-side), and every later push to that repository
 * answered `503 Retry-After: 10` for 20–40 minutes at a stretch — five such
 * windows in one night, >2 hours of lost push capacity. Root cause: the
 * receive lease is held until finalize/release/expiry, and a holder whose
 * client dies SILENTLY (no bytes, no EOF, no TCP error reaching the edge)
 * parks forever on `reader.read()` — the exclusive slot stays "active" until
 * the 15-minute TTL, and each retry that finally acquired the lease could
 * stall identically, chaining the windows. Mechanically there is NO
 * refresh/re-take self-lock (a busy beginReceive returns before creating any
 * lease row, and nothing extends a receive lease); the appearance of one is
 * the chained-TTL pattern.
 *
 * The fix (upstream-faithful — upstream's receive-pack is a child process
 * bound to the HTTP request context, githttp.go serviceRPC → gitcmd
 * command.go CommandContext: a disconnect KILLS the process and git's
 * advisory locks die with it, so upstream never leaves a lock behind):
 *   - the receive's body-reading phases race the abort signal and fail the
 *     push immediately (499, unobservable to the dead client), releasing the
 *     lease with a sweep;
 *   - `GIT_TIMEOUT_RECEIVE` (seconds, the `[git.timeout]` key style) makes
 *     the TTL — the only defense against a signal-less silent drop —
 *     deployable config.
 *
 * Pinned here against a real engine composition (createDurableGit over the
 * real DO/R2 bindings, the branch-protection-push.test.ts mirror-boundary
 * harness shape):
 *   1. an in-flight receive (stalled mid-pack) blocks a concurrent push with
 *      `503` + `retry-after: 10` — the T7 guard, unchanged;
 *   2. aborting that holder's signal releases the lease immediately — the
 *      next push acquires it and APPLIES (the incident's missing behavior);
 *   3. the TTL plumbing end to end: default 15-min lease, a short explicit
 *      `leaseTtlMs` expires (slot freed), invalid values keep the default;
 *   4. the config resolver pins default/floor/ceiling/garbage handling.
 *
 * The "holder" is driven engine-direct with `EngineCallOptions.signal` —
 * exactly the channel the gate's forwardToEngine hands the original
 * request's signal through (a D1-resolved forward re-wraps the request and a
 * reconstructed Request carries a fresh never-aborting signal). The
 * verbatim-passthrough fallback (`req.signal`) is covered by test 2's
 * second arm, where the signal rides the Request itself and the call options
 * carry none.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  RECEIVE_LEASE_TTL_MAX_MS,
  RECEIVE_LEASE_TTL_MIN_MS,
  RECEIVE_LEASE_TTL_MS,
  clampReceiveLeaseTtlMs,
  createDurableGit,
  resolveReceiveLeaseTtlSeconds,
} from "@cf-gitea/git-engine";

import { ZERO_OID, buildPack } from "../repos/testing/git-pack";

const RECEIVE_CT = "application/x-git-receive-pack-request";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function engine() {
  // the mirror/import composition posture (no validatePush hook, no UI):
  // the lease behavior under test lives in receivePack regardless of hook
  return createDurableGit<Env>({ authorize: () => true, ui: false, namespaces: true });
}

const NOOP_CTX = {} as ExecutionContext;

/** A complete, applicable receive-pack body (command + flush + real pack). */
function completePushBody(oid: string, pack: Uint8Array): Uint8Array {
  const line = `${ZERO_OID} ${oid} refs/heads/main\0report-status`;
  const section = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`;
  const head = new TextEncoder().encode(section);
  const out = new Uint8Array(head.length + pack.length);
  out.set(head, 0);
  out.set(pack, head.length);
  return out;
}

/**
 * A receive-pack body whose pack NEVER completes: the full command section
 * plus the first bytes of a real pack, then the stream just stops (the
 * silent-drop shape — no close, no error, no more bytes). The engine parses
 * the section, opens the lease, and parks in staging exactly like the
 * incident's stalled holders.
 */
function stalledPushBody(oid: string, pack: Uint8Array): {
  body: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
} {
  let released: ReadableStreamDefaultController<Uint8Array> | undefined;
  const line = `${ZERO_OID} ${oid} refs/heads/main\0report-status side-band-64k`;
  const section = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`;
  const head = new TextEncoder().encode(section);
  const prefix = pack.subarray(0, 16);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      released = c;
      c.enqueue(head);
      c.enqueue(prefix);
      // hold: never close, never enqueue again
    },
  });
  return { body, controller: released! };
}

/**
 * A side-effect-free lease probe: a command section with an INVALID refname.
 * beginReceive checks the busy state BEFORE refname validation (the sweep,
 * then the lease probe, then the funny-refname rejection — control-plane.ts
 * beginReceive's exact order), so a busy repo answers `503` and a free repo
 * answers `200` (all-ng report) — and neither arm creates, extends, or
 * releases a lease, nor touches refs. This is what makes "the lease turned
 * over" a deterministic poll instead of a sleep.
 */
async function leaseProbe(
  e: ReturnType<typeof engine>,
  repo: string
): Promise<number> {
  const line = `${ZERO_OID} ${"a".repeat(40)} refs/heads/..invalid`;
  const section = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`;
  const response = await e.fetch(
    new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
      method: "POST",
      headers: { "content-type": RECEIVE_CT, "content-length": String(section.length) },
      body: new TextEncoder().encode(section),
    }),
    env,
    NOOP_CTX
  );
  return response.status;
}

describe("receive lease disconnect fast-fail (SPEC-0001 §5 amendment, T7a)", () => {
  it("an in-flight receive blocks a concurrent push with 503 + retry-after (T7, unchanged)", async () => {
    const e = engine();
    const repo = "lease/concurrent";
    const { oid, pack } = await buildPack();
    const { body } = stalledPushBody(oid, pack);
    const ac = new AbortController();

    // holder: stalls mid-pack holding the lease (not awaited yet)
    const holder = e.fetch(
      new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
        method: "POST",
        headers: { "content-type": RECEIVE_CT },
        body,
        // workerd accepts the streams-spec duplex pairing for a stream body;
        // the workers-types RequestInit omits it (sync.ts's spread shape)
        ...{ duplex: "half" as const },
      }),
      env,
      NOOP_CTX,
      { signal: ac.signal }
    );

    // deterministic wait-for-lease: the invalid-refname probe flips to 503
    await expect
      .poll(() => leaseProbe(e, repo), { timeout: 15_000, interval: 50 })
      .toBe(503);

    // the T7 guard: a real concurrent push is refused with the busy shape
    const second = await e.fetch(
      new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
        method: "POST",
        headers: { "content-type": RECEIVE_CT },
        body: completePushBody(oid, pack),
      }),
      env,
      NOOP_CTX
    );
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("10");
    expect(new TextDecoder().decode(new Uint8Array(await second.arrayBuffer()))).toContain(
      "busy: too many concurrent pushes"
    );

    // cleanup: kill the holder, expect the fast-fail answer, slot freed
    ac.abort();
    expect((await holder).status).toBe(499);
    await expect
      .poll(() => leaseProbe(e, repo), { timeout: 15_000, interval: 50 })
      .toBe(200);
  });

  it("aborting the holder's signal frees the slot — the next push acquires the lease and applies", async () => {
    const e = engine();
    const repo = "lease/fastfail";
    const { oid, pack } = await buildPack();
    const { body } = stalledPushBody(oid, pack);
    const ac = new AbortController();

    const holder = e.fetch(
      new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
        method: "POST",
        headers: { "content-type": RECEIVE_CT },
        body,
        // workerd accepts the streams-spec duplex pairing for a stream body;
        // the workers-types RequestInit omits it (sync.ts's spread shape)
        ...{ duplex: "half" as const },
      }),
      env,
      NOOP_CTX,
      { signal: ac.signal }
    );
    await expect
      .poll(() => leaseProbe(e, repo), { timeout: 15_000, interval: 50 })
      .toBe(503);

    // the incident's missing behavior: the disconnect turns the slot over
    ac.abort();
    const holderResponse = await holder;
    expect(holderResponse.status).toBe(499);
    expect(new TextDecoder().decode(new Uint8Array(await holderResponse.arrayBuffer()))).toContain(
      "client disconnected mid-push"
    );

    // a NEW push acquires the lease immediately and APPLIES — the repo is
    // writable again in the same turn the client died, not at TTL expiry
    const next = await e.fetch(
      new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
        method: "POST",
        headers: { "content-type": RECEIVE_CT },
        body: completePushBody(oid, pack),
      }),
      env,
      NOOP_CTX
    );
    expect(next.status).toBe(200);
    const report = new TextDecoder().decode(new Uint8Array(await next.arrayBuffer()));
    expect(report).toContain("unpack ok");
    expect(report).toContain("ok refs/heads/main");
  });

  it("the fallback channel: a request-carried abort signal (verbatim passthrough shape) fast-fails too", async () => {
    const e = engine();
    const repo = "lease/signal-fallback";
    const { oid, pack } = await buildPack();
    const { body } = stalledPushBody(oid, pack);
    const ac = new AbortController();

    // NO call options: receivePack falls back to req.signal — the
    // D1-missing passthrough's channel, where the original request object
    // (and its signal) reaches the engine untouched
    const holder = e.fetch(
      new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
        method: "POST",
        headers: { "content-type": RECEIVE_CT },
        body,
        // workerd accepts the streams-spec duplex pairing for a stream body;
        // the workers-types RequestInit omits it (sync.ts's spread shape)
        ...{ duplex: "half" as const },
        signal: ac.signal,
      }),
      env,
      NOOP_CTX
    );
    await expect
      .poll(() => leaseProbe(e, repo), { timeout: 15_000, interval: 50 })
      .toBe(503);

    ac.abort();
    expect((await holder).status).toBe(499);
    await expect
      .poll(() => leaseProbe(e, repo), { timeout: 15_000, interval: 50 })
      .toBe(200);
  });
});

describe("receive lease TTL plumbing (GIT_TIMEOUT_RECEIVE)", () => {
  it("beginReceive defaults to the 15-minute backstop, honors a short explicit leaseTtlMs, and falls back on invalid values", async () => {
    const repo = "lease/ttl";
    const stub = env.REPO.getByName(repo);
    await stub.bindRepo(repo);
    const commands = [{ old: ZERO_OID, next: "b".repeat(40), ref: "refs/heads/ttl" }];

    // default: the historical 15-minute backstop
    const def = await stub.beginReceive({ commands, capabilities: [], packBytesHint: null });
    expect(def.tag).toBe("ok");
    if (def.tag !== "ok") return;
    const defDelta = def.leaseExpiresAt - Date.now();
    expect(defDelta).toBeGreaterThan(RECEIVE_LEASE_TTL_MS - 2_000);
    expect(defDelta).toBeLessThanOrEqual(RECEIVE_LEASE_TTL_MS);
    await stub.releaseReceive({ leaseToken: def.leaseToken, sweep: false });

    // explicit short TTL: the slot expires (the silent-drop backstop at work)
    const short = await stub.beginReceive({
      commands,
      capabilities: [],
      packBytesHint: null,
      leaseTtlMs: 120,
    });
    expect(short.tag).toBe("ok");
    if (short.tag !== "ok") return;
    expect(short.leaseExpiresAt - Date.now()).toBeLessThanOrEqual(120);
    await sleep(300);
    // the next begin sweeps the expired row and acquires — with an INVALID
    // override in the same call (0 keeps the default), pinning both behaviors
    const refreshed = await stub.beginReceive({
      commands,
      capabilities: [],
      packBytesHint: null,
      leaseTtlMs: 0,
    });
    expect(refreshed.tag).toBe("ok");
    if (refreshed.tag !== "ok") return;
    const refreshedDelta = refreshed.leaseExpiresAt - Date.now();
    expect(refreshedDelta).toBeGreaterThan(RECEIVE_LEASE_TTL_MS - 2_000);
    expect(refreshedDelta).toBeLessThanOrEqual(RECEIVE_LEASE_TTL_MS);
    await stub.releaseReceive({ leaseToken: refreshed.leaseToken, sweep: false });
  });

  it("resolveReceiveLeaseTtlSeconds pins default, floor, ceiling and garbage; clampReceiveLeaseTtlMs guards the RPC input", () => {
    // seconds, upstream [git.timeout] style
    expect(resolveReceiveLeaseTtlSeconds("900")).toBe(15 * 60 * 1000);
    expect(resolveReceiveLeaseTtlSeconds(undefined)).toBe(RECEIVE_LEASE_TTL_MS);
    expect(resolveReceiveLeaseTtlSeconds(null)).toBe(RECEIVE_LEASE_TTL_MS);
    expect(resolveReceiveLeaseTtlSeconds("")).toBe(RECEIVE_LEASE_TTL_MS);
    expect(resolveReceiveLeaseTtlSeconds("garbage")).toBe(RECEIVE_LEASE_TTL_MS);
    expect(resolveReceiveLeaseTtlSeconds("0")).toBe(RECEIVE_LEASE_TTL_MS);
    expect(resolveReceiveLeaseTtlSeconds("-30")).toBe(RECEIVE_LEASE_TTL_MS);
    // clamp floor/ceiling
    expect(resolveReceiveLeaseTtlSeconds("30")).toBe(RECEIVE_LEASE_TTL_MIN_MS);
    expect(resolveReceiveLeaseTtlSeconds("59")).toBe(RECEIVE_LEASE_TTL_MIN_MS);
    expect(resolveReceiveLeaseTtlSeconds("100000")).toBe(RECEIVE_LEASE_TTL_MAX_MS);
    expect(resolveReceiveLeaseTtlSeconds("86401")).toBe(RECEIVE_LEASE_TTL_MAX_MS);
    // the RPC input guard: absent/invalid → default, explicit value passes
    expect(clampReceiveLeaseTtlMs(undefined)).toBe(RECEIVE_LEASE_TTL_MS);
    expect(clampReceiveLeaseTtlMs(null)).toBe(RECEIVE_LEASE_TTL_MS);
    expect(clampReceiveLeaseTtlMs(0)).toBe(RECEIVE_LEASE_TTL_MS);
    expect(clampReceiveLeaseTtlMs(-5)).toBe(RECEIVE_LEASE_TTL_MS);
    expect(clampReceiveLeaseTtlMs(Number.NaN)).toBe(RECEIVE_LEASE_TTL_MS);
    expect(clampReceiveLeaseTtlMs(120)).toBe(120);
    expect(clampReceiveLeaseTtlMs(5 * 60 * 1000)).toBe(5 * 60 * 1000);
  });
});

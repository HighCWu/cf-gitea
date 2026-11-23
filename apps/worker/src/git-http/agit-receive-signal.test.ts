/**
 * The receive-lease disconnect fast-fail's D1-resolved lane — the agit
 * receive handler's own engine call (the 2026-11-23 mirror-wall recurrence).
 *
 * Production history: fe6fc56 armed the abort fast-fail by threading the
 * original request's signal through forwardToEngine's call options, and the
 * receive-lease battery pinned it engine-direct. But a repository WITH a D1
 * row — every ordinary git-HTTP push once the row exists — never goes
 * through forwardToEngine: receive-pack branches to handleAgitReceive, whose
 * forward REBUILDS the Request (a reconstructed Request carries a fresh,
 * never-aborting signal) and whose engine.fetch call passed only
 * `pusher`/`validatePush`. receivePack fell back to that dead signal, so the
 * fast-fail was never armed on exactly the lane the mirror push rides; a
 * client that dies mid-pack strands the lease for the full TTL again and the
 * chained-TTL wall returns (observed: one window content re-pushed for 6.5h,
 * each acquired slot dying identically past the edge idle tolerance).
 *
 * Pinned here at the GATE layer (not engine-direct): the holder is a real
 * gitHttpGate call whose Request carries this test's AbortController signal
 * — the same object identity the production fetch event's request has — with
 * a body whose pack never completes (the silent-drop shape). The battery:
 *
 *   1. the stalled holder parks ON THE LEASE — an engine-direct probe flips
 *      503, and a concurrent real push through the gate answers the busy
 *      shape (503 + retry-after) — the T7 guard on this lane;
 *   2. aborting the REQUEST's signal releases the lease immediately — the
 *      holder answers 499 and the next push through the gate acquires and
 *      APPLIES (the incident's missing behavior, now on the D1 lane).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDurableGit } from "@cf-gitea/git-engine";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { RepoService } from "../repos/service";
import { ZERO_OID, buildPack } from "../repos/testing/git-pack";
import { gitHttpGate } from "./gate";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_collaborators", "repo_units", "repo_counters", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

const RECEIVE_CT = "application/x-git-receive-pack-request";

// The gate + engine are composed the way the tests that drive them directly
// do (the mirror/import engine posture — the lease behavior under test lives
// in receivePack regardless of hook), sharing ONE engine instance so the
// gate's forwards and the probes land on the same DO cells.
const engine = createDurableGit<Env>({ authorize: () => true, ui: false, namespaces: true });

const NOOP_CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

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
 * silent-drop shape — no close, no error, no more bytes). The gate's section
 * parse finishes at the flush, the forward begins, the engine opens the
 * lease and parks in staging exactly like the stalled mirror holders.
 */
function stalledPushBody(oid: string, pack: Uint8Array): ReadableStream<Uint8Array> {
  const line = `${ZERO_OID} ${oid} refs/heads/main\0report-status side-band-64k`;
  const section = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`;
  const head = new TextEncoder().encode(section);
  const prefix = pack.subarray(0, 16);
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(head);
      c.enqueue(prefix);
      // hold: never close, never enqueue again
    },
  });
}

/**
 * A side-effect-free lease probe: a command section with an INVALID refname.
 * beginReceive checks the busy state BEFORE refname validation (the sweep,
 * then the lease probe, then the funny-refname rejection), so a busy repo
 * answers `503` and a free repo answers `200` — and neither arm creates,
 * extends, or releases a lease, nor touches refs. Driven engine-direct at
 * the SAME path the gate forwards to, so it polls the same cell's lease.
 */
async function leaseProbe(repoPath: string): Promise<number> {
  const line = `${ZERO_OID} ${"a".repeat(40)} refs/heads/..invalid`;
  const section = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`;
  const response = await engine.fetch(
    new Request(`https://example.com${repoPath}`, {
      method: "POST",
      headers: { "content-type": RECEIVE_CT, "content-length": String(section.length) },
      body: new TextEncoder().encode(section),
    }),
    env,
    NOOP_CTX
  );
  return response.status;
}

describe("agit receive lane's disconnect fast-fail (the D1-resolved push path)", () => {
  it("aborting the gate request's signal frees the lease — the next push through the gate acquires and applies", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const slug = `agsig${Date.now()}`;
    await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: slug,
      isPrivate: false,
    });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const repoPath = `/alice/${slug}.git/git-receive-pack`;
    const { oid, pack } = await buildPack();
    const ac = new AbortController();

    // holder: the gate call itself (the D1-resolved receive lane —
    // handleAgitReceive), stalls mid-pack holding the lease. The Request
    // carries this test's signal, the same identity a production fetch
    // event's request.signal has.
    const holder = gitHttpGate(
      new Request(`https://example.com${repoPath}`, {
        method: "POST",
        headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
        body: stalledPushBody(oid, pack),
        // workerd accepts the streams-spec duplex pairing for a stream body;
        // the workers-types RequestInit omits it (gate forward's spread shape)
        ...{ duplex: "half" as const },
        signal: ac.signal,
      }),
      env,
      NOOP_CTX,
      engine
    );

    // deterministic wait-for-lease: the invalid-refname probe flips to 503
    await expect
      .poll(() => leaseProbe(repoPath), { timeout: 15_000, interval: 50 })
      .toBe(503);

    // the T7 guard through the gate: a real concurrent push is refused with
    // the busy shape (the incident's client view of the wall)
    const second = await gitHttpGate(
      new Request(`https://example.com${repoPath}`, {
        method: "POST",
        headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
        body: completePushBody(oid, pack),
      }),
      env,
      NOOP_CTX,
      engine
    );
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("10");
    expect(new TextDecoder().decode(new Uint8Array(await second.arrayBuffer()))).toContain(
      "busy: too many concurrent pushes"
    );

    // the incident's missing behavior on THIS lane: the disconnect turns the
    // slot over — the holder answers the fast-fail, the lease is free at once
    ac.abort();
    // raced, not awaited bare: the regression this pins is the holder staying
    // parked AFTER the request aborted (the signal never reaching the engine)
    const holderResponse = await Promise.race([
      holder,
      new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
    ]);
    expect(holderResponse, "the gate call stayed parked after its request aborted — the disconnect signal never reached the engine (the lease only frees at TTL)").not.toBeNull();
    expect(holderResponse?.status).toBe(499);

    await expect
      .poll(() => leaseProbe(repoPath), { timeout: 15_000, interval: 50 })
      .toBe(200);

    // a NEW push through the gate acquires the lease immediately and APPLIES
    // — the repo is writable again in the same turn the client died, not at
    // TTL expiry
    const next = await gitHttpGate(
      new Request(`https://example.com${repoPath}`, {
        method: "POST",
        headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
        body: completePushBody(oid, pack),
      }),
      env,
      NOOP_CTX,
      engine
    );
    expect(next.status).toBe(200);
    const report = new TextDecoder().decode(new Uint8Array(await next.arrayBuffer()));
    expect(report).toContain("unpack ok");
    expect(report).toContain("ok refs/heads/main");
  });
});

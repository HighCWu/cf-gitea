/**
 * SPEC 0230 acceptance harness — black-box receive-pack sideband keepalive
 * (L825 lane). The SPEC lives at docs/specs/0230-receive-sideband-keepalive
 * in the laimon-comfy product repo; the implementation (receivePack staged
 * streaming + CPU-yield points) belongs to the L823 engine lane in THIS
 * repo. This file is an INDEPENDENT acceptance surface: it consumes the
 * response the way a client does and never reads engine internals.
 *
 * Two ledgers, accounted honestly in
 * README.spec0230-keepalive-harness.md and in every run's output:
 *
 * LEDGER A — "protocol consumer self-proof" (always green, L823-
 * independent): the sideband-64k stream consumer and its keepalive
 * discipline judge are proven against scripted producers, including the
 * fake-alive failure mode — beats scheduled but a synchronous CPU block
 * starving the timer past the silence cap — which is the failure class the
 * implementation lane's own server-side tests are least able to cover.
 * If this ledger is red, the HARNESS is wrong, not the engine.
 *
 * LEDGER B — "engine acceptance, black box": real receivePack calls under
 * the real workerd bindings, judged by the same consumer. The structural
 * arms (negotiation, zero-regression fixture, post-report persistence, the
 * buffered failure shape) are green at the pre-L823 HEAD and must STAY
 * green after the streaming change. The timing arm (B4) and the in-stream
 * failure arm (B5) auto-detect whether the stream arm exists:
 *   - pre-merge they record `PENDING L823` skips (the suite stays green),
 *   - post-merge they assert the full SPEC 0230 contract — and because the
 *     arm-open probe is structural (a catastrophic throw-hook push answers
 *     500 pre-merge vs 200 + band-3 post-merge), a post-merge FAKE-ALIVE
 *     implementation (arm open, zero bytes in flight) is RED, not skipped.
 *
 * Honest scope limits (documented, not hidden):
 *   - "client" here reads the ENGINE Response body under workerd. That
 *     proves server-side per-frame arrival, not the edge's 60-70s idle cap
 *     itself — the edge leg is SPEC 0230's own 诚实边界 deployment
 *     acceptance (w264 thin re-push), outside this harness by design.
 *   - The CPU-yield criterion's END-TO-END arm (a real multi-second
 *     synchronous scan blocking a 20s beat) needs an index heavy enough to
 *     block the event loop past the interval — out of bounded-suite scope
 *     here; Ledger A3 proves the judge catches that shape, and the README
 *     records the heavy-fixture follow-up.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDurableGit } from "@cf-gitea/git-engine";
import type { PushValidator } from "@cf-gitea/git-engine";

import { buildPack, ZERO_OID } from "../repos/testing/git-pack";
import { PRE_L823_FIXTURE } from "./testing/receive-sideband-pre-l823-fixture";
import {
  analyzeReceiveStream,
  assertKeepaliveDiscipline,
  bandFrame,
  bytesToHex,
  consumeResponseBody,
  firstDiffOffset,
  heartbeatPacket,
  reportPacket,
  scriptedReceivePackStream,
} from "./testing/sideband-consumer";

const RECEIVE_CT = "application/x-git-receive-pack-request";
const SIDEBAND_CAPS = "report-status-v2 side-band-64k";
const PLAIN_CAPS = "report-status";
const te = new TextEncoder();

/**
 * The keepalive interval SPEC 0230 claims ("建议 20s 一拍"; git's official
 * receive.keepAlive default 5s is the conservative floor). The acceptance
 * judge is interval × capFactor. If the implementation window chooses a
 * different interval inside the SPEC's 15–30s range, update this constant
 * to the implementation's declared value — the judge only loosens for the
 * CLAIMED interval, never for an observed violation.
 */
const KEEPALIVE_INTERVAL_MS = 20_000;
/** allowed silence = interval × 2 (the SPEC 0230 acceptance judge) */
const KEEPALIVE_CAP_FACTOR = 2;
/**
 * The injected index-window delay: must exceed the implementation's actual
 * beat interval so at least one beat falls inside the window. 20s claim +
 * 5s margin. Bump together with KEEPALIVE_INTERVAL_MS above if the window
 * picks a larger interval.
 */
const INDEX_WINDOW_DELAY_MS = KEEPALIVE_INTERVAL_MS + 5_000;

function engine() {
  // the mirror/import composition posture (no validatePush default, no UI):
  // identical to the receive-lease regression battery's engine() so this
  // harness observes the same composition the incident suites pin
  return createDurableGit<Env>({ authorize: () => true, ui: false, namespaces: true });
}

/**
 * Post-merge the receive tail is waitUntil-bound (SPEC 0230's staged
 * streaming shape), so the harness must hand the engine a context whose
 * waitUntil exists; pre-merge receivePack never touches ctx on these arms
 * (onPush is not wired here), making the shim a no-op today.
 */
const CTX = {
  waitUntil: (p: Promise<unknown>): void => {
    void p.catch(() => {});
  },
} as unknown as ExecutionContext;

function receivePushBody(oid: string, pack: Uint8Array, caps: string): Uint8Array {
  const line = `${ZERO_OID} ${oid} refs/heads/main\0${caps}`;
  const section = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`;
  const head = new TextEncoder().encode(section);
  const out = new Uint8Array(head.length + pack.length);
  out.set(head, 0);
  out.set(pack, head.length);
  return out;
}

function pushRequest(repo: string, body: Uint8Array): Request {
  return new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
    method: "POST",
    headers: { "content-type": RECEIVE_CT, "content-length": String(body.length) },
    body,
  });
}

const allowAll: PushValidator = (commands) => commands.map(() => ({}));
const throwCatastrophic: PushValidator = () => {
  throw new Error("l825-catastrophic-injection");
};

function hexSlice(bytes: Uint8Array, from: number): string {
  return bytesToHex(bytes.subarray(from, from + 16));
}

/** Assert byte-equality against the committed fixture with a usable diff. */
function expectFixtureBytes(actual: Uint8Array, fixtureHex: string, arm: string): void {
  const expected = new Uint8Array(
    (fixtureHex.match(/.{2}/g) ?? []).map((h) => Number.parseInt(h, 16)),
  );
  if (bytesToHex(actual) === fixtureHex) return;
  const d = firstDiffOffset(expected, actual);
  throw new Error(
    `${arm}: response bytes diverged from the pre-L823 fixture at byte ${d} ` +
      `(got ${hexSlice(actual, Math.max(0, d))} want ${hexSlice(expected, Math.max(0, d))}; ` +
      `lengths actual=${actual.length} fixture=${expected.length}) — SPEC 0230's ` +
      "zero-regression check, NOT fixture staleness; re-pin only after a reviewed protocol change",
  );
}

/**
 * Structural arm-open probe with NO timing dependence: a catastrophic
 * (throw-hook) push answers today's buffered `500` shape pre-merge, and the
 * in-stream `200` + band-3 shape once the staged streaming arm exists
 * (SPEC 0230: after the arm opens the HTTP status is already committed).
 * This is what lets the timing arm distinguish "streaming missing" (skip)
 * from "streaming present but silent" (a fake-alive RED).
 */
async function probeArmOpen(e: ReturnType<typeof engine>): Promise<{ open: boolean; status: number }> {
  const { oid, pack } = await buildPack();
  const resp = await e.fetch(
    pushRequest("l825/arm-probe", receivePushBody(oid, pack, SIDEBAND_CAPS)),
    env,
    CTX,
    { validatePush: throwCatastrophic },
  );
  return { open: resp.status === 200, status: resp.status };
}

describe("SPEC 0230 harness — Ledger A: protocol consumer self-proof (L823-independent)", () => {
  it("A1: parses band-1/2/3 framing, flush, and the byte-exact 0005 01 heartbeat", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(heartbeatPacket());
        controller.enqueue(bandFrame(2, te.encode("Indexing objects: 1000/2000\n")));
        controller.enqueue(bandFrame(3, te.encode("fatal: boom\n")));
        controller.enqueue(reportPacket(["unpack ok", "ok refs/heads/main"]));
        controller.enqueue(te.encode("0000"));
        controller.close();
      },
    });
    const c = await consumeResponseBody(stream);
    const a = analyzeReceiveStream(c, "sideband");
    expect(a.violations).toEqual([]);
    expect(a.mode).toBe("sideband");
    // the heartbeat is identified BYTE-EXACTLY: 4 ASCII hex digits + 0x01
    expect(a.heartbeats.length).toBe(1);
    expect(bytesToHex(a.heartbeats[0]?.raw ?? new Uint8Array(0))).toBe("3030303501");
    expect(a.progress.length).toBe(1);
    expect(a.progress[0]?.text).toContain("Indexing objects");
    expect(a.band3Errors.length).toBe(1);
    expect(a.band3Errors[0]?.text).toContain("fatal: boom");
    expect(a.report.seen).toBe(true);
    expect(a.report.unpackLine).toBe("unpack ok");
    expect(a.report.commandLines).toEqual(["ok refs/heads/main"]);
    expect(a.report.followedOnlyByFlush).toBe(true);
  });

  it("A2: beats through the indexing window pass the discipline; the report is terminal", { timeout: 15_000 }, async () => {
    const c = await consumeResponseBody(
      scriptedReceivePackStream({ mode: "keepalive", indexingMs: 1_600, intervalMs: 400 }),
    );
    const a = analyzeReceiveStream(c, "sideband");
    // the judge every other test in this file leans on: silence ≤ interval×2,
    // at least one byte-exact heartbeat, report present and terminal
    assertKeepaliveDiscipline(a, { intervalMs: 400, capFactor: 2 });
    expect(a.heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(a.report.unpackLine).toBe("unpack ok");
    expect(a.maxGapMs).toBeLessThanOrEqual(800);
  });

  it("A3 fake-alive: a sync CPU block starving the beat timer trips the silence judge", { timeout: 20_000 }, async () => {
    // the implementation-lane trap (SPEC 0230 CPU yield design section):
    // beats are scheduled on the wall clock, but one synchronous CPU segment
    // covering the whole window means the event loop runs them only at the
    // end — the wire shows a single end burst, indistinguishable from the
    // buffered response. The judge must catch it BY TIMING.
    const c = await consumeResponseBody(
      scriptedReceivePackStream({
        mode: "fake-alive",
        indexingMs: 1_600,
        intervalMs: 400,
        cpuBlockMs: 1_600,
      }),
    );
    const a = analyzeReceiveStream(c, "sideband");
    // a late beat does exist (the timer fired after the block) — presence
    // alone must NOT pass; the silence judge is what convicts
    expect(a.heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(a.maxGapMs).toBeGreaterThan(800);
    expect(() => assertKeepaliveDiscipline(a, { intervalMs: 400, capFactor: 2 })).toThrow(
      /SPEC0230-SILENCE over-cap/,
    );
  });

  it("A4: an illegal pkt-line length header is caught, not silently consumed", async () => {
    const c = await consumeResponseBody(
      scriptedReceivePackStream({ mode: "bad-header", indexingMs: 60 }),
    );
    const a = analyzeReceiveStream(c, "sideband");
    expect(a.violations.some((v) => v.code === "bad-length-header")).toBe(true);
  });

  it("A5: a truncated final frame (declared > delivered) is caught", async () => {
    const c = await consumeResponseBody(
      scriptedReceivePackStream({ mode: "truncated", indexingMs: 60 }),
    );
    const a = analyzeReceiveStream(c, "sideband");
    expect(a.violations.some((v) => v.code === "overrun" || v.code === "truncated-frame")).toBe(
      true,
    );
  });

  it("A6: content after the report (report not terminal) is caught", { timeout: 15_000 }, async () => {
    const c = await consumeResponseBody(
      scriptedReceivePackStream({
        mode: "early-report",
        indexingMs: 1_200,
        intervalMs: 400,
        milestones: [{ atMs: 900, text: "Resolving deltas: 100\n" }],
      }),
    );
    const a = analyzeReceiveStream(c, "sideband");
    expect(a.report.seen).toBe(true);
    expect(a.report.followedOnlyByFlush).toBe(false);
    expect(() => assertKeepaliveDiscipline(a, { intervalMs: 400, capFactor: 2 })).toThrow(
      /SPEC0230-REPORT not terminal/,
    );
  });

  it("A7: milestone frames reset the silence clock and are never miscounted as heartbeats", { timeout: 15_000 }, async () => {
    // milestone at 200ms; the 400ms tick must be idle-gate-suppressed (the
    // official keepAlive reading SPEC 0230 pins), the 800ms tick fires
    const c = await consumeResponseBody(
      scriptedReceivePackStream({
        mode: "keepalive",
        indexingMs: 1_200,
        intervalMs: 400,
        milestones: [{ atMs: 200, text: "Indexing objects: 1/2\n" }],
      }),
    );
    const a = analyzeReceiveStream(c, "sideband");
    assertKeepaliveDiscipline(a, { intervalMs: 400, capFactor: 2 });
    expect(a.progress.length).toBe(1);
    expect(a.heartbeats.length).toBe(1);
  });

  it("A8 quiet window: beats alone carry the silence (criterion ③ protocol side)", { timeout: 15_000 }, async () => {
    // no milestones at all — the --quiet/no-progress thin-window shape the
    // official empty keepalive packet exists for: the beats must stand alone
    const c = await consumeResponseBody(
      scriptedReceivePackStream({ mode: "keepalive", indexingMs: 1_200, intervalMs: 400 }),
    );
    const a = analyzeReceiveStream(c, "sideband");
    assertKeepaliveDiscipline(a, { intervalMs: 400, capFactor: 2 });
    expect(a.progress.length).toBe(0);
    expect(a.heartbeats.length).toBeGreaterThanOrEqual(2);
  });
});

describe("SPEC 0230 acceptance — Ledger B: engine, black box", () => {
  it("B1 negotiation: the receive advertisement still offers side-band-64k, and a non-sideband push answers a plain pkt-line report byte-identical to the pre-L823 fixture", { timeout: 30_000 }, async () => {
    const e = engine();
    const { oid, pack } = await buildPack();

    const resp = await e.fetch(
      pushRequest("l825/plain", receivePushBody(oid, pack, PLAIN_CAPS)),
      env,
      CTX,
    );
    expect(resp.status).toBe(200);
    const c = await consumeResponseBody(resp.body);
    const a = analyzeReceiveStream(c, "plain");
    expect(a.violations).toEqual([]);
    expect(a.report.unpackLine).toBe("unpack ok");
    expect(a.report.commandLines).toEqual(["ok refs/heads/main"]);
    expectFixtureBytes(c.raw, PRE_L823_FIXTURE.noSidebandHex, "B1 plain report");

    // negotiation surface: the receive capability list (engine advertisement,
    // protocol.ts) still carries side-band-64k + report-status-v2 — criterion
    // ①' "heartbeat only where the client requested sideband" precondition
    const adv = await e.fetch(
      new Request("https://engine.internal/l825/plain.git/info/refs?service=git-receive-pack"),
      env,
      CTX,
    );
    expect(adv.status).toBe(200);
    const advText = await adv.text();
    expect(advText).toContain("side-band-64k");
    expect(advText).toContain("report-status-v2");
  });

  it("B2 zero-regression: a fast sideband push's bytes equal the pre-L823 fixture; frames legal; report terminal; no beat fires", { timeout: 30_000 }, async () => {
    const e = engine();
    const { oid, pack } = await buildPack();
    const resp = await e.fetch(
      pushRequest("l825/sideband", receivePushBody(oid, pack, SIDEBAND_CAPS)),
      env,
      CTX,
    );
    expect(resp.status).toBe(200);
    const c = await consumeResponseBody(resp.body);
    const a = analyzeReceiveStream(c, "sideband");
    expect(a.violations).toEqual([]);
    expect(a.report.unpackLine).toBe("unpack ok");
    expect(a.report.commandLines).toEqual(["ok refs/heads/main"]);
    expect(a.report.followedOnlyByFlush).toBe(true);
    // SPEC 0230 supplementary check: the fast push's byte content must stay
    // IDENTICAL across the streaming change — the idle-gated 20s keepalive
    // cannot fire inside a millisecond-scale push, so a beat here would mean
    // the gating (or the fixture) is wrong
    expect(a.heartbeats.length).toBe(0);
    expectFixtureBytes(c.raw, PRE_L823_FIXTURE.sidebandHex, "B2 sideband report");
  });

  it("B3 criterion ⑤ post-hoc: after an ok report the ref tip and objects are queryable", { timeout: 30_000 }, async () => {
    const e = engine();
    const { oid, pack } = await buildPack();
    const resp = await e.fetch(
      pushRequest("l825/persist", receivePushBody(oid, pack, SIDEBAND_CAPS)),
      env,
      CTX,
    );
    expect(resp.status).toBe(200);
    const c = await consumeResponseBody(resp.body);
    const a = analyzeReceiveStream(c, "sideband");
    expect(a.report.seen).toBe(true);
    expect(a.report.unpackLine).toBe("unpack ok");
    // success was reported ⇒ the finalize transaction (objects + checksum +
    // refs) already decided: the tip is served on the read surface
    const adv = await e.fetch(
      new Request("https://engine.internal/l825/persist.git/info/refs?service=git-upload-pack"),
      env,
      CTX,
    );
    expect(adv.status).toBe(200);
    const advText = await adv.text();
    expect(advText).toContain(oid);
    expect(advText).toContain("refs/heads/main");
  });

  it("B4 criteria ②④ timing: during an injected index-window delay the consumer receives byte-exact heartbeats, silence ≤ interval×2 (auto-arms post-L823; fake-alive = red)", { timeout: 90_000 }, async (ctx) => {
    const e = engine();
    // 0. structural arm-open probe (no timing dependence — see its doc)
    const probe = await probeArmOpen(e);
    if (!probe.open) {
      ctx.skip(
        `PENDING L823 (SPEC 0230): receivePack is still fully buffered — the throw-hook probe ` +
          `answered the pre-merge 500 failure shape (status ${probe.status}), so no stream arm ` +
          "exists to observe. The timing assertions below are fully armed and activate " +
          "automatically once the receive-pack streaming commit lands (probe answers 200).",
      );
    }
    // 1. the delayed-index push: the validatePush hook runs post-scan /
    //    post-classify, pre-finalize, INSIDE the streamed window — a real,
    //    black-box injection of the L816 dead-window shape using the engine's
    //    own extension point (zero engine-code coupling)
    const { oid, pack } = await buildPack();
    let cancelDelay: (() => void) | undefined;
    const slowValidator: PushValidator = async (commands) => {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, INDEX_WINDOW_DELAY_MS);
        cancelDelay = () => clearTimeout(t);
      });
      return commands.map(() => ({}));
    };
    try {
      const resp = await e.fetch(
        pushRequest("l825/keepalive", receivePushBody(oid, pack, SIDEBAND_CAPS)),
        env,
        CTX,
        { validatePush: slowValidator },
      );
      expect(resp.status).toBe(200);
      const c = await consumeResponseBody(resp.body);
      const a = analyzeReceiveStream(c, "sideband");
      // THE acceptance judge: byte-exact empty keepalive packets during the
      // window, no silence over interval×2, report terminal (criteria ② + ④
      // at engine-side arrival). Because the probe PROVED the arm is open,
      // zero in-window bytes cannot skip — it is a fake-alive RED here.
      assertKeepaliveDiscipline(a, {
        intervalMs: KEEPALIVE_INTERVAL_MS,
        capFactor: KEEPALIVE_CAP_FACTOR,
      });
      // criterion ③ engine-side: a 3-object pack emits no progress
      // milestones, so the ONLY window output was the empty keepalive frames
      // themselves — beats do not depend on visible progress text
      expect(a.progress.length).toBe(0);
      expect(a.heartbeats.length).toBeGreaterThanOrEqual(1);
      expect(a.report.unpackLine).toBe("unpack ok");
      console.log(
        `[l825 B4] observed gaps=${JSON.stringify(a.gaps)} heartbeats=${a.heartbeats.length} ` +
          `endedAtMs=${c.endedAtMs} terminatedBy=${c.terminatedBy}`,
      );
    } finally {
      cancelDelay?.();
    }
  });

  it("B5 failure semantics: a catastrophic post-arm failure answers band-3 + termination (not a silent break), and the lease turns over", { timeout: 60_000 }, async (ctx) => {
    const e = engine();
    const { oid, pack } = await buildPack();
    const resp = await e.fetch(
      pushRequest("l825/catastrophe", receivePushBody(oid, pack, SIDEBAND_CAPS)),
      env,
      CTX,
      { validatePush: throwCatastrophic },
    );
    if (resp.status === 500) {
      // pre-L823 buffered contract, pinned verbatim before skipping: a
      // throwing hook fails the request closed (500), releases the lease,
      // sweeps staging — the shape receive-lease-style suites already pin
      const body = await resp.text();
      expect(body).toContain("l825-catastrophic-injection");
      ctx.skip(
        "PENDING L823 (SPEC 0230): no stream arm yet — today's buffered 500 failure shape is " +
          "pinned above; the in-stream band-3 + termination contract asserts once the " +
          "receive-pack streaming commit lands (the same probe then answers 200).",
      );
    }
    expect(resp.status).toBe(200);
    const c = await consumeResponseBody(resp.body);
    const a = analyzeReceiveStream(c, "sideband");
    // protocol-legal to the end: no framing violation, at least one band-3
    // error frame, NO success report, stream terminated (SPEC 0230: band-3
    // then close — a silent mid-stream break without any of these is the bug)
    expect(a.violations).toEqual([]);
    expect(a.band3Errors.length).toBeGreaterThanOrEqual(1);
    expect(a.report.seen && a.report.unpackLine === "unpack ok").toBe(false);
    expect(c.terminatedBy).toBe("close");
    console.log(
      `[l825 B5] band3=${JSON.stringify(a.band3Errors.map((x) => x.text))} ` +
        `terminatedBy=${c.terminatedBy} endedAtMs=${c.endedAtMs}`,
    );
    // the failure path must release the lease: a follow-up push lands
    const retry = await e.fetch(
      pushRequest("l825/catastrophe", receivePushBody(oid, pack, PLAIN_CAPS)),
      env,
      CTX,
      { validatePush: allowAll },
    );
    expect(retry.status).toBe(200);
    const retryBody = new Uint8Array(await retry.arrayBuffer());
    expect(new TextDecoder().decode(retryBody)).toContain("unpack ok");
  });
});

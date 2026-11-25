/**
 * SPEC 0230 — the streaming receive answer + official keepalive packet.
 *
 * The mirror line's wall ③½ (DEPLOY.md, the L816 window): a thin windowed
 * push whose indexing phase runs ~60s+ answers ZERO bytes after the request
 * body is staged, and the edge path cuts the silent connection. The engine's
 * receive advertising already negotiates `side-band-64k`, so the answer has
 * a multiplexed channel; this battery pins the streaming arm's wire
 * contract, mapped onto the SPEC's five acceptance criteria:
 *
 *   ① side-band-64k negotiation (zero-regression form): a client that does
 *     NOT request sideband keeps today's exact buffered answer bytes, and a
 *     sideband client's streamed answer is byte-identical to the buffered
 *     render (fast pushes emit no heartbeat, so equality is exact);
 *   ② legal protocol frames keep flowing during indexing: with the
 *     heartbeat interval pinned to its test floor (GIT_RECEIVE_KEEPALIVE_MS,
 *     the same deployable-var family as GIT_RECEIVE_DEADLINE_MS), a
 *     multi-second indexing window emits frames whose arrivals stay bounded
 *     and whose pkt-line framing validates — the production posture maps
 *     to 20s x 2 < the ~60s silence-cap floor;
 *   ③ the idle keepalive does not depend on progress text: the battery's
 *     packs never cross a 100k-object or 64MB milestone, so every
 *     pre-report frame is the five-byte `0005\x01` packet itself;
 *   ④ bytes actually DELIVERED to a consumer (never merely enqueued): the
 *     assertions run over an incremental reader of the real Response body —
 *     workerd's response streaming, arrival timestamps included — not over
 *     engine internals;
 *   ⑤ the success report is never early: with a validatePush hook (which
 *     the pipeline runs strictly between indexing and finalize), every byte
 *     delivered before the hook resolved is a keepalive or progress frame,
 *     and the `unpack ok` report arrives only afterwards.
 *
 * Failure semantics past the arm: the 200 is already committed, so a
 * catastrophic failure expresses IN BAND — a band-3 error frame, then the
 * stream closes, and the lease turns over exactly as the buffered path's
 * outer catch does (pinned by the throwing-hook test below; the
 * pre-arm/disconnect 499 semantics are unchanged and stay pinned by
 * receive-lease.test.ts, whose stalled holder dies mid-STAGING — before the
 * arm opens).
 *
 * Harness: engine-direct over the real DO/R2 bindings (the
 * branch-protection-push harness shape), because the heartbeat cadence and
 * the hook ride per-call channels a SELF.fetch round trip cannot pin.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDurableGit, type Env, type PushValidator } from "@cf-gitea/git-engine";

import { ZERO_OID, buildPack } from "../repos/testing/git-pack";

const RECEIVE_CT = "application/x-git-receive-pack-request";
const enc = new TextEncoder();
const dec = new TextDecoder();

/** The engine composed like the mirror/import posture (no hook, no UI). */
function engine() {
  return createDurableGit<Env>({ authorize: () => true, ui: false, namespaces: true });
}

/** The battery's env: the real bindings with the heartbeat at its test
 *  floor (50ms — the clamp floor receiveKeepaliveMs enforces), so protocol
 *  timing is observable inside a fast test. */
function fastKeepaliveEnv(): Env {
  return { ...env, GIT_RECEIVE_KEEPALIVE_MS: "50" };
}

const NOOP_CTX = {} as ExecutionContext;

// ---------------------------------------------------------------------------
// Wire builders (pkt-line / side-band, matching gitprotocol-pack(5))
// ---------------------------------------------------------------------------

function concatU8(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function pktLineBytes(payload: string): Uint8Array {
  const body = enc.encode(payload);
  const head = enc.encode((body.length + 4).toString(16).padStart(4, "0"));
  return concatU8([head, body]);
}

/** A receive command section: one command line (+caps on it), then flush. */
function commandSection(line: string, caps: string): Uint8Array {
  const full = caps ? `${line}\0${caps}` : line;
  return concatU8([pktLineBytes(full), enc.encode("0000")]);
}

/** The buffered non-sideband success render for a single-ok command:
 *  `unpack ok` + the command's ok line + flush (renderStatus(..., false)). */
function expectedPlainReport(ref: string): Uint8Array {
  return concatU8([pktLineBytes("unpack ok\n"), pktLineBytes(`ok ${ref}\n`), enc.encode("0000")]);
}

/** The sideband render for a single-ok command: the report pkt-lines wrap
 *  in ONE band-1 frame, then the report's own flush
 *  (renderStatus(..., true) — sidebandFrames(1, inner) + FLUSH). */
function expectedSidebandReport(ref: string): Uint8Array {
  const inner = concatU8([pktLineBytes("unpack ok\n"), pktLineBytes(`ok ${ref}\n`), enc.encode("0000")]);
  const framed = concatU8([new Uint8Array([1]), inner]);
  const head = enc.encode((framed.length + 4).toString(16).padStart(4, "0"));
  return concatU8([head, framed, enc.encode("0000")]);
}

// ---------------------------------------------------------------------------
// Frame walking + timed incremental consumption (the protocol-level client)
// ---------------------------------------------------------------------------

interface Frame {
  /** 0 = flush pkt, 1/2/3 = sideband band */
  band: number;
  /** true for the official five-byte zero-data band-1 keepalive packet */
  keepalive: boolean;
  data: Uint8Array;
}

interface TimedFrame {
  frame: Frame;
  /** arrival time of the read chunk the frame completed in */
  at: number;
}

/**
 * Strict pkt-line walk over a WHOLE answer assembled from timed incremental
 * reads. Frames may split across read chunks; the walk carries the partial
 * tail. Every length header must be four hex digits, no frame may overrun
 * the body, and no trailing bytes may survive the last frame — the
 * framing-legality half of acceptance ②. Emission order is preserved (the
 * stream delivers in order).
 */
function timedFrames(arrivals: Arrival[]): TimedFrame[] {
  const out: TimedFrame[] = [];
  let buf: Uint8Array = new Uint8Array(0);
  for (const a of arrivals) {
    buf = buf.length > 0 ? concatU8([buf, a.bytes]) : a.bytes;
    let p = 0;
    for (;;) {
      if (p + 4 > buf.length) break;
      const head = String.fromCharCode(buf[p]!, buf[p + 1]!, buf[p + 2]!, buf[p + 3]!);
      if (!/^[0-9a-f]{4}$/.test(head)) {
        throw new Error(`bad pkt-line length header at ${p}: ${JSON.stringify(head)}`);
      }
      const len = parseInt(head, 16);
      if (len === 0) {
        out.push({ at: a.at, frame: { band: 0, keepalive: false, data: new Uint8Array(0) } });
        p += 4;
        continue;
      }
      if (p + len > buf.length) break; // frame split across chunks; carry it
      const payload = buf.subarray(p + 4, p + len);
      const band = payload.length > 0 ? payload[0]! : -1;
      // the official keepAlive packet: total length 5 — four hex chars plus
      // the single 0x01 band byte, zero data bytes
      out.push({ at: a.at, frame: { band, keepalive: len === 5 && band === 1, data: payload.subarray(1) } });
      p += len;
    }
    buf = buf.subarray(p);
  }
  if (buf.length > 0) {
    throw new Error(`trailing non-pkt-line bytes after the last frame (${buf.length})`);
  }
  return out;
}

interface Arrival {
  at: number;
  bytes: Uint8Array;
}

/** Read the response body INCREMENTALLY with arrival timestamps — the
 *  acceptance-④ discipline: what a client actually received, when. */
async function consumeTimed(res: Response): Promise<Arrival[]> {
  const arrivals: Arrival[] = [];
  const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) arrivals.push({ at: Date.now(), bytes: value });
  }
  return arrivals;
}

function allBytes(arrivals: Arrival[]): Uint8Array {
  return concatU8(arrivals.map((a) => a.bytes));
}

/** The first arrival chunk containing the success report marker. */
function reportArrival(arrivals: Arrival[]): Arrival | undefined {
  return arrivals.find((a) => dec.decode(a.bytes).includes("unpack ok"));
}

// ---------------------------------------------------------------------------
// Pack fixtures
// ---------------------------------------------------------------------------

async function sha1Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function oidBytes(hexStr: string): Uint8Array {
  const raw = new Uint8Array(20);
  for (let j = 0; j < 20; j++) raw[j] = parseInt(hexStr.slice(j * 2, j * 2 + 2), 16);
  return raw;
}

async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function be32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 15);
  size >>>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(b);
  return new Uint8Array(bytes);
}

/**
 * A self-contained pack of `blobCount` tiny blobs + one tree + one commit —
 * the slow-indexing fixture: enough entries that the engine's scan spans
 * many keepalive ticks, and (at any count below the 100k milestone) ZERO
 * band-2 progress emissions, which is what makes the keepalive observable
 * on its own (acceptance ③).
 */
async function buildWidePack(blobCount: number): Promise<{ oid: string; pack: Uint8Array }> {
  const blobBodies: Uint8Array[] = [];
  const blobOids: string[] = [];
  for (let i = 0; i < blobCount; i++) {
    const body = enc.encode(`keepalive fixture blob ${i}\n`);
    const oid = await sha1Bytes(concatU8([enc.encode(`blob ${body.length}\0`), body]));
    blobBodies.push(body);
    blobOids.push(toHex(oid));
  }
  // pack order: every blob, then the tree, then the commit (base before user)
  const packChunks: Uint8Array[] = [];
  for (const body of blobBodies) {
    packChunks.push(objectHeader(3, body.length));
    packChunks.push(await zlibDeflate(body));
  }
  const treeEntries: Uint8Array[] = [];
  for (let i = 0; i < blobOids.length; i++) {
    treeEntries.push(enc.encode(`100644 f${String(i).padStart(5, "0")}\0`));
    treeEntries.push(oidBytes(blobOids[i]!));
  }
  const treeBody = concatU8(treeEntries);
  const treeOid = toHex(await sha1Bytes(concatU8([enc.encode(`tree ${treeBody.length}\0`), treeBody])));
  packChunks.push(objectHeader(2, treeBody.length));
  packChunks.push(await zlibDeflate(treeBody));

  const time = 1700000000;
  const commitBody = enc.encode(
    `tree ${treeOid}\n` +
      `author Test User <test@example.com> ${time} +0000\n` +
      `committer Test User <test@example.com> ${time} +0000\n\n` +
      "keepalive fixture commit\n",
  );
  const commitOid = toHex(await sha1Bytes(concatU8([enc.encode(`commit ${commitBody.length}\0`), commitBody])));
  packChunks.push(objectHeader(1, commitBody.length));
  packChunks.push(await zlibDeflate(commitBody));

  const head = concatU8([enc.encode("PACK"), be32(2), be32(blobCount + 2)]);
  const trailer = await sha1Bytes(concatU8([head, ...packChunks]));
  return { oid: commitOid, pack: concatU8([head, ...packChunks, trailer]) };
}

/** Deterministic lease probe (receive-lease.test.ts's shape): an
 *  invalid-refname command section that beginReceive answers busy-503 or
 *  200 without creating or releasing any lease. */
async function leaseProbe(e: ReturnType<typeof engine>, repo: string): Promise<number> {
  const line = `${ZERO_OID} ${"a".repeat(40)} refs/heads/..invalid`;
  const section = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`;
  const res = await e.fetch(
    new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
      method: "POST",
      headers: { "content-type": RECEIVE_CT, "content-length": String(section.length) },
      body: enc.encode(section),
    }),
    env,
    NOOP_CTX
  );
  return res.status;
}

async function pushSideband(
  e: ReturnType<typeof engine>,
  eEnv: Env,
  repo: string,
  body: Uint8Array,
  validatePush?: PushValidator
): Promise<Response> {
  return e.fetch(
    new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
      method: "POST",
      headers: { "content-type": RECEIVE_CT, "content-length": String(body.length) },
      body,
    }),
    eEnv,
    NOOP_CTX,
    validatePush ? { validatePush } : undefined
  );
}

// ---------------------------------------------------------------------------
// The battery
// ---------------------------------------------------------------------------

describe("SPEC 0230: streaming receive answer + official keepalive", () => {
  it("① non-sideband pushes keep today's byte-exact buffered answer; sideband pushes stream the identical render", async () => {
    const e = engine();
    const { oid, pack } = await buildPack();

    // arm 1: caps WITHOUT side-band-64k — the retained buffered path. The
    // body must equal the plain render byte-for-byte (no keepalive can ever
    // appear here: the buffered arm has no heartbeat).
    const plainRepo = "keepalive/plain";
    const plainBody = concatU8([
      commandSection(`${ZERO_OID} ${oid} refs/heads/main`, "report-status"),
      pack,
    ]);
    const plain = await e.fetch(
      new Request(`https://engine.internal/${plainRepo}.git/git-receive-pack`, {
        method: "POST",
        headers: { "content-type": RECEIVE_CT, "content-length": String(plainBody.length) },
        body: plainBody,
      }),
      env,
      NOOP_CTX
    );
    expect(plain.status).toBe(200);
    const plainBytes = new Uint8Array(await plain.arrayBuffer());
    expect(plainBytes).toEqual(expectedPlainReport("refs/heads/main"));

    // arm 2: the SAME section with side-band-64k — the streaming arm. A fast
    // push never sees a heartbeat tick (default 20s interval), so the
    // streamed answer must equal the sideband render byte-for-byte.
    const sbRepo = "keepalive/sideband";
    const sbBody = concatU8([
      commandSection(`${ZERO_OID} ${oid} refs/heads/main`, "report-status side-band-64k"),
      pack,
    ]);
    const sb = await pushSideband(e, env, sbRepo, sbBody);
    expect(sb.status).toBe(200);
    const sbBytes = new Uint8Array(await sb.arrayBuffer());
    expect(sbBytes).toEqual(expectedSidebandReport("refs/heads/main"));
  });

  it("②③④ during indexing the answer keeps emitting legal keepalive frames — delivered to a consumer, no progress text needed", async () => {
    const e = engine();
    const repo = "keepalive/wide";
    const { oid, pack } = await buildWidePack(4000);
    const body = concatU8([
      commandSection(`${ZERO_OID} ${oid} refs/heads/main`, "report-status side-band-64k"),
      pack,
    ]);

    const res = await pushSideband(e, fastKeepaliveEnv(), repo, body);
    expect(res.status).toBe(200);
    const arrivals = await consumeTimed(res);
    expect(arrivals.length).toBeGreaterThan(0);

    // ② framing legality over the whole delivered answer (throws on any
    // bad length header, overrun, or trailing garbage)
    const frames = timedFrames(arrivals);
    // exactly one band-1 data frame rode in: the report; a flush closes it
    const reportIdx = frames.findIndex((t) => t.frame.band === 1 && !t.frame.keepalive);
    expect(reportIdx).toBeGreaterThan(0); // frames arrived before it
    const report = frames[reportIdx]!.frame;
    expect(dec.decode(report.data)).toContain("unpack ok");
    expect(dec.decode(report.data)).toContain("ok refs/heads/main");
    expect(frames[frames.length - 1]!.frame.band).toBe(0);

    // ③ + ④ pacing: every PRE-report frame is a keepalive — this fixture
    // crosses no 100k-object or 64MB milestone, so no band-2 progress
    // exists at all; the observed silence pattern is keepalive-only
    const pre = frames.slice(0, reportIdx);
    const keepalives = pre.filter((t) => t.frame.keepalive);
    expect(keepalives.length).toBeGreaterThan(0);
    for (const t of pre) {
      if (t.frame.band === 1) expect(t.frame.keepalive).toBe(true);
      else expect(t.frame.band).toBe(2); // progress would be legal; none is emitted
    }
    for (const k of keepalives) expect(k.frame.data.length).toBe(0);

    // ② arrival-gap bound: with the 50ms battery cadence, adjacent read
    // arrivals stay far inside a 5s ceiling (production maps to 20s, and
    // the SPEC constraint is interval x 2 < the ~60s silence-cap floor)
    for (let i = 1; i < arrivals.length; i++) {
      expect(arrivals[i]!.at - arrivals[i - 1]!.at).toBeLessThanOrEqual(5000);
    }
  });

  it("⑤ the success report is never early: only keepalives arrive before the validatePush hook resolves", async () => {
    const e = engine();
    const repo = "keepalive/order";
    const { oid, pack } = await buildPack();
    const body = concatU8([
      commandSection(`${ZERO_OID} ${oid} refs/heads/main`, "report-status side-band-64k"),
      pack,
    ]);

    let hookEndedAt = 0;
    let hookRan = false;
    const res = await pushSideband(e, fastKeepaliveEnv(), repo, body, (commands) => {
      hookRan = true;
      expect(commands.length).toBe(1);
      expect(commands[0]!.ref).toBe("refs/heads/main");
      hookEndedAt = Date.now();
      return [{}]; // verdict: apply
    });
    expect(res.status).toBe(200);
    // drain the stream first: the answer resolves EARLY (the arm opens after
    // staging), and the hook/finalize/report ride the tail — by stream end
    // the tail has run all three, in order
    const arrivals = await consumeTimed(res);
    expect(hookRan).toBe(true);

    // the report exists and arrived no earlier than the hook's resolution
    // (the hook sits strictly between indexing and finalize, and the report
    // is emitted strictly after finalize's transaction)
    const marker = reportArrival(arrivals);
    expect(marker).toBeDefined();
    expect(marker!.at).toBeGreaterThanOrEqual(hookEndedAt);

    // ⑤ zero early report: any frame delivered before the hook resolved —
    // except in report position — is a keepalive or progress frame; a
    // band-1 data frame there would be a success report preceding the
    // persistence it reports
    const frames = timedFrames(arrivals);
    const reportIdx = frames.findIndex((t) => t.frame.band === 1 && !t.frame.keepalive);
    expect(reportIdx).toBeGreaterThan(-1);
    for (let i = 0; i < reportIdx; i++) {
      const t = frames[i]!;
      if (t.at >= hookEndedAt) continue; // emitted after the hook: fine
      if (t.frame.band === 1) expect(t.frame.keepalive).toBe(true);
    }
    expect(dec.decode(allBytes(arrivals))).toContain("ok refs/heads/main");
  });

  it("failure past the arm is in-band: a throwing hook emits band-3 and closes, and the lease turns over", async () => {
    const e = engine();
    const repo = "keepalive/fail";
    const { oid, pack } = await buildPack();
    const body = concatU8([
      commandSection(`${ZERO_OID} ${oid} refs/heads/main`, "report-status side-band-64k"),
      pack,
    ]);

    const res = await pushSideband(e, fastKeepaliveEnv(), repo, body, () => {
      throw new Error("hook exploded in test");
    });
    // the status committed when the arm opened; the failure rides band-3
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const frames = timedFrames([{ at: 0, bytes }]);
    const errors = frames.filter((t) => t.frame.band === 3);
    expect(errors.length).toBe(1);
    expect(dec.decode(errors[0]!.frame.data)).toBe("error: hook exploded in test\n");
    // no success report ever rode the stream
    expect(dec.decode(bytes)).not.toContain("unpack ok");
    // and the lease turned over exactly like the buffered path's outer catch
    await expect
      .poll(() => leaseProbe(e, repo), { timeout: 15_000, interval: 50 })
      .toBe(200);
  });

  it("deletes-only sideband pushes stream the byte-identical render (the arm opens with no staging)", async () => {
    const e = engine();
    const repo = "keepalive/delete";
    const { oid, pack } = await buildPack();

    const create = await pushSideband(
      e,
      env,
      repo,
      concatU8([commandSection(`${ZERO_OID} ${oid} refs/heads/main`, "report-status side-band-64k"), pack])
    );
    expect(dec.decode(new Uint8Array(await create.arrayBuffer()))).toContain("unpack ok");

    const del = await pushSideband(
      e,
      env,
      repo,
      commandSection(`${oid} ${ZERO_OID} refs/heads/main`, "report-status side-band-64k")
    );
    expect(del.status).toBe(200);
    const bytes = new Uint8Array(await del.arrayBuffer());
    expect(bytes).toEqual(expectedSidebandReport("refs/heads/main"));
  });
});

/**
 * SPEC 0230 acceptance harness — a protocol-level side-band-64k stream
 * consumer (L825 lane: an INDEPENDENT black-box test surface for the
 * receive-pack sideband keepalive; the SPEC lives at
 * docs/specs/0230-receive-sideband-keepalive in the laimon-comfy product
 * repo, the implementation belongs to the L823 engine lane).
 *
 * What it does: reads a receive-pack Response body incrementally, timestamps
 * every read batch with wall-clock arrival times, parses pkt-line frames
 * (gitprotocol-common(5): four ASCII hex length digits INCLUDING the four
 * header bytes themselves; 0000 flush, 0001 delim, otherwise len-4 payload
 * bytes) and — on a side-band-64k multiplexed stream — splits each payload
 * into band 1 (data / report-status), band 2 (progress) and band 3 (error)
 * per gitprotocol-pack(5) §PACKFILE DATA.
 *
 * The keepalive shape under acceptance is git's official receive.keepAlive
 * form (git-config(1), "empty keepalive packet"): five bytes `0005\x01` —
 * four ASCII hex length digits "0005" plus the 0x01 band-1 channel byte,
 * i.e. a zero-data band-1 frame — emitted while processing is otherwise
 * silent. The analyzer identifies that frame BYTE-EXACTLY and never
 * confuses it with band-2 progress text or with the band-1 report-status
 * payload.
 *
 * This file is harness-side only: it contains no engine code and nothing
 * receivePack-specific beyond the protocol shapes. It proves its own
 * assertions against scripted producers in the companion acceptance test
 * (receive-sideband-keepalive-acceptance.test.ts, describe "protocol
 * consumer self-proof"), including the fake-alive failure mode — a
 * synchronous CPU block starving the beat timer past the silence cap —
 * which is exactly the failure class the implementation lane's own
 * server-side tests are least able to cover.
 */

const te = new TextEncoder();
const td = new TextDecoder();

export type SidebandBand = 1 | 2 | 3;

/** One raw read() resolution, with the wall-clock time it arrived. */
export interface ArrivalBatch {
  /** ms relative to consumption start when reader.read() resolved */
  readonly atMs: number;
  readonly bytes: Uint8Array;
  /** absolute byte offset of this batch's first byte in the stream */
  readonly startOffset: number;
  readonly length: number;
}

export type StreamEventKind = "flush" | "delim" | "data";

export interface StreamEvent {
  readonly kind: StreamEventKind;
  /** absolute byte offset of the frame's FIRST byte in the stream */
  readonly offset: number;
  /** ms relative to consumption start when the frame's LAST byte arrived */
  readonly arrivalMs: number;
  /** full raw frame bytes (length header included; kind "flush"/"delim" = 4 bytes) */
  readonly raw: Uint8Array;
  /** for kind "data": the payload bytes after the 4-digit length header */
  readonly payload: Uint8Array;
}

export type ViolationCode =
  | "bad-length-header" // the four length digits were not strict hex
  | "overrun" // a declared length overran the buffered bytes at stream end
  | "truncated-frame" // the stream ended mid-frame
  | "bad-band" // a sideband band byte outside 1..3
  | "unexpected-delim" // 0001 inside a receive-pack response
  | "parse-aborted"; // framing broke so badly the rest could not be parsed

export interface ProtocolViolation {
  readonly code: ViolationCode;
  readonly detail: string;
  readonly offset?: number;
}

export interface Consumption {
  readonly events: StreamEvent[];
  readonly batches: ArrivalBatch[];
  readonly violations: ProtocolViolation[];
  /** every byte the stream delivered, concatenated (test-sized streams only) */
  readonly raw: Uint8Array;
  readonly totalBytes: number;
  /** ms relative to start when the stream terminated (close or error) */
  readonly endedAtMs: number;
  readonly terminatedBy: "close" | "error";
  readonly errorMessage?: string;
}

export interface ReportStructure {
  readonly seen: boolean;
  /** arrival of the FIRST report-carrying frame (ms relative to start) */
  readonly arrivalMs: number | null;
  readonly unpackLine: string | null;
  readonly commandLines: string[];
  /** true when nothing but flush-pkts followed the report's last frame */
  readonly followedOnlyByFlush: boolean;
  readonly text: string;
}

export interface KeepaliveAnalysis {
  readonly mode: "sideband" | "plain";
  /** byte-exact `0005\x01` empty band-1 keepalive frames */
  readonly heartbeats: StreamEvent[];
  readonly progress: { readonly event: StreamEvent; readonly text: string }[];
  readonly band3Errors: { readonly event: StreamEvent; readonly text: string }[];
  readonly report: ReportStructure;
  /** silence windows between consecutive frame arrivals, first from t=0 */
  readonly gaps: { readonly fromMs: number; readonly toMs: number; readonly ms: number }[];
  readonly maxGapMs: number;
  readonly violations: ProtocolViolation[];
}

const FLUSH_BYTES = te.encode("0000");
// four ASCII hex length digits ("0005" — the length includes them) plus the
// 0x01 band-1 channel byte, zero payload: git's "empty keepalive packet"
const HEARTBEAT_BYTES = new Uint8Array(5);
HEARTBEAT_BYTES.set(te.encode("0005"), 0);
HEARTBEAT_BYTES[4] = 0x01;

export function isHeartbeatFrame(e: StreamEvent): boolean {
  return (
    e.kind === "data" && e.raw.length === 5 && byteEqual(e.raw, HEARTBEAT_BYTES)
  );
}

export function byteEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Offset of the first differing byte, or -1 when equal (diagnostics helper). */
export function firstDiffOffset(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return i;
  return a.length === b.length ? -1 : n;
}

/**
 * Consume a Response body incrementally. Frames are parsed as batches land;
 * a frame's arrivalMs is the resolution time of the read batch that carried
 * its LAST byte — batches that deliver several frames at once (the buffered
 * one-shot response shape) report every frame at the same instant, which is
 * exactly what a real client would have observed.
 */
export async function consumeResponseBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<Consumption> {
  const t0 = Date.now();
  const events: StreamEvent[] = [];
  const batches: ArrivalBatch[] = [];
  const violations: ProtocolViolation[] = [];
  const rawChunks: Uint8Array[] = [];
  let total = 0;
  let buffer = new Uint8Array(0);
  const bufStart = 0; // absolute offset of buffer[0] — the buffer always grows from byte 0
  let pos = 0; // absolute offset of the next unparsed byte
  let aborted = false;

  const batchAt = (absOffset: number): number => {
    for (let i = batches.length - 1; i >= 0; i--) {
      const b = batches[i]!;
      if (absOffset >= b.startOffset && absOffset < b.startOffset + b.length) return b.atMs;
    }
    return batches.length > 0 ? (batches[batches.length - 1]?.atMs ?? 0) : 0;
  };

  const parse = (): void => {
    while (!aborted) {
      const available = bufStart + buffer.length - pos;
      if (available < 4) return;
      const headerBuf = buffer.subarray(pos - bufStart, pos - bufStart + 4);
      let len = 0;
      let headerOk = true;
      for (let i = 0; i < 4; i++) {
        const c = headerBuf[i] ?? 0;
        let d: number;
        if (c >= 0x30 && c <= 0x39) d = c - 0x30;
        else if (c >= 0x61 && c <= 0x66) d = c - 0x57;
        else if (c >= 0x41 && c <= 0x46) d = c - 0x37;
        else {
          headerOk = false;
          break;
        }
        len = (len << 4) | d;
      }
      const headerOffset = pos;
      if (!headerOk) {
        violations.push({
          code: "bad-length-header",
          detail: `length header ${td.decode(headerBuf)} is not four strict hex digits`,
          offset: headerOffset,
        });
        aborted = true;
        return;
      }
      if (len === 0 || len === 1) {
        const at = batchAt(pos + 3);
        const raw = buffer.subarray(pos - bufStart, pos - bufStart + 4);
        events.push({
          kind: len === 0 ? "flush" : "delim",
          offset: pos,
          arrivalMs: at,
          raw,
          payload: new Uint8Array(0),
        });
        if (len === 1) {
          violations.push({
            code: "unexpected-delim",
            detail: "pkt-line delim (0001) inside a receive-pack response",
            offset: pos,
          });
        }
        pos += 4;
        continue;
      }
      if (available < len) return; // need more bytes
      const at = batchAt(pos + len - 1);
      const raw = buffer.subarray(pos - bufStart, pos - bufStart + len);
      events.push({
        kind: "data",
        offset: pos,
        arrivalMs: at,
        raw,
        payload: raw.subarray(4),
      });
      pos += len;
    }
  };

  if (body === null) {
    return {
      events,
      batches,
      violations,
      raw: new Uint8Array(0),
      totalBytes: 0,
      endedAtMs: 0,
      terminatedBy: "close",
    };
  }

  let terminatedBy: "close" | "error" = "close";
  let errorMessage: string | undefined;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const at = Date.now() - t0;
      if (done) break;
      if (value === undefined) continue;
      batches.push({ atMs: at, bytes: value, startOffset: total, length: value.length });
      rawChunks.push(value);
      total += value.length;
      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer, 0);
      merged.set(value, buffer.length);
      buffer = merged;
      parse();
    }
  } catch (err) {
    terminatedBy = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  const endedAt = Date.now() - t0;
  // stream end with unparsed bytes left: a frame the protocol promised but
  // never delivered (only meaningful when framing had not already broken)
  const leftover = bufStart + buffer.length - pos;
  if (!aborted && leftover > 0) {
    violations.push({
      code: leftover >= 4 ? "overrun" : "truncated-frame",
      detail:
        `stream ended with ${leftover} unparsed trailing byte(s) ` +
        `(frame at offset ${pos} never completed)`,
      offset: pos,
    });
  }
  if (aborted && leftover > 0) {
    violations.push({
      code: "parse-aborted",
      detail: `${leftover} trailing byte(s) after a broken length header were not parsed`,
      offset: pos,
    });
  }
  return {
    events,
    batches,
    violations,
    raw: concatBytes(rawChunks),
    totalBytes: total,
    endedAtMs: endedAt,
    terminatedBy,
    errorMessage,
  };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * The report region's inner framing: a band-1 report payload carries
 * pkt-LINEs nested INSIDE the sideband frame (renderStatus wraps
 * `pkt("unpack ok\n")`-style lines plus its own terminating flush inside
 * band 1), so the analyzer must strip those inner 4-byte headers too.
 */
function parseInnerReportLines(
  bytes: Uint8Array,
  violations: ProtocolViolation[],
  reportStartOffset: number,
): { lines: string[]; endedWithFlush: boolean } {
  const lines: string[] = [];
  let pos = 0;
  let endedWithFlush = false;
  while (pos + 4 <= bytes.length) {
    let len = 0;
    let headerOk = true;
    for (let i = 0; i < 4; i++) {
      const c = bytes[pos + i] ?? 0;
      let d: number;
      if (c >= 0x30 && c <= 0x39) d = c - 0x30;
      else if (c >= 0x61 && c <= 0x66) d = c - 0x57;
      else if (c >= 0x41 && c <= 0x46) d = c - 0x37;
      else {
        headerOk = false;
        break;
      }
      len = (len << 4) | d;
    }
    if (!headerOk) {
      violations.push({
        code: "bad-length-header",
        detail: `report region has an inner length header that is not four strict hex digits at +${pos}`,
        offset: reportStartOffset + pos,
      });
      break;
    }
    if (len === 0) {
      endedWithFlush = true;
      pos += 4;
      continue;
    }
    if (len === 1) {
      pos += 4;
      continue;
    }
    if (pos + len > bytes.length) {
      violations.push({
        code: "truncated-frame",
        detail: `report region's inner pkt-line at +${pos} declares ${len} bytes but only ` +
          `${bytes.length - pos} remain`,
        offset: reportStartOffset + pos,
      });
      break;
    }
    let text = td.decode(bytes.subarray(pos + 4, pos + len));
    if (text.endsWith("\n")) text = text.slice(0, -1);
    lines.push(text);
    pos += len;
  }
  return { lines, endedWithFlush };
}

/**
 * Interpret a consumption as a receive-pack response. In sideband mode every
 * data frame must carry a band byte in 1..3 (payload[0]); band-1 frames split
 * into the byte-exact empty keepalive frame and the report-status payload;
 * band-2 frames are progress text; band-3 frames are error text. In plain
 * mode (the client never requested side-band-64k) data frames are report
 * pkt-lines directly and no heartbeat can exist by protocol construction.
 */
export function analyzeReceiveStream(
  c: Consumption,
  mode: "sideband" | "plain",
): KeepaliveAnalysis {
  const violations: ProtocolViolation[] = [...c.violations];
  const heartbeats: StreamEvent[] = [];
  const progress: { event: StreamEvent; text: string }[] = [];
  const band3Errors: { event: StreamEvent; text: string }[] = [];
  const reportPayloads: Uint8Array[] = [];
  let reportFirstArrival: number | null = null;
  let reportLastEvent: StreamEvent | null = null;

  for (const e of c.events) {
    if (e.kind !== "data") continue;
    if (mode === "plain") {
      reportPayloads.push(e.payload);
      if (reportFirstArrival === null) reportFirstArrival = e.arrivalMs;
      reportLastEvent = e;
      continue;
    }
    const band = e.payload[0];
    if (band !== 1 && band !== 2 && band !== 3) {
      violations.push({
        code: "bad-band",
        detail: `data frame at offset ${e.offset} carries band byte ${String(band)}, outside 1..3`,
        offset: e.offset,
      });
      continue;
    }
    if (band === 1) {
      // the zero-data band-1 frame: exactly the five-byte empty keepalive
      if (isHeartbeatFrame(e)) {
        heartbeats.push(e);
        continue;
      }
      reportPayloads.push(e.payload.subarray(1));
      if (reportFirstArrival === null) reportFirstArrival = e.arrivalMs;
      reportLastEvent = e;
    } else if (band === 2) {
      progress.push({ event: e, text: td.decode(e.payload.subarray(1)) });
    } else {
      band3Errors.push({ event: e, text: td.decode(e.payload.subarray(1)) });
    }
  }

  // report ordering: nothing but flush-pkts may follow the report's last frame
  let followedOnlyByFlush = reportLastEvent !== null;
  if (reportLastEvent !== null) {
    for (const e of c.events) {
      if (e.offset > reportLastEvent.offset && e.kind !== "flush") {
        followedOnlyByFlush = false;
        break;
      }
    }
  }

  const reportStartOffset = reportPayloads.length > 0 && reportLastEvent !== null
    ? reportLastEvent.offset + 4 + 1
    : 0;
  let unpackLine: string | null;
  let commandLines: string[];
  let reportText: string;
  if (mode === "plain") {
    // plain-mode data frames ARE single pkt-lines already (the stream parser
    // stripped their outer headers) — one line per event, no inner framing
    const lines = reportPayloads.map((p) => {
      let text = td.decode(p);
      if (text.endsWith("\n")) text = text.slice(0, -1);
      return text;
    });
    unpackLine = lines[0] ?? null;
    commandLines = lines.slice(1);
    reportText = lines.map((l) => `${l}\n`).join("");
  } else {
    const inner = parseInnerReportLines(concatBytes(reportPayloads), violations, reportStartOffset);
    unpackLine = inner.lines[0] ?? null;
    commandLines = inner.lines.slice(1);
    reportText = inner.lines.map((l) => `${l}\n`).join("");
  }
  const report: ReportStructure = {
    seen: reportLastEvent !== null,
    arrivalMs: reportFirstArrival,
    unpackLine,
    commandLines,
    followedOnlyByFlush,
    text: reportText,
  };

  // silence windows between consecutive arrivals; the leading window runs
  // from consumption start to the first arrival
  const gaps: { fromMs: number; toMs: number; ms: number }[] = [];
  let prev = 0;
  for (const e of c.events) {
    gaps.push({ fromMs: prev, toMs: e.arrivalMs, ms: e.arrivalMs - prev });
    prev = e.arrivalMs;
  }
  const maxGapMs = gaps.reduce((m, g) => Math.max(m, g.ms), 0);

  return { mode, heartbeats, progress, band3Errors, report, gaps, maxGapMs, violations };
}

export interface DisciplineConfig {
  /** the CLAIMED keepalive interval (SPEC 0230: 20s) */
  intervalMs: number;
  /** allowed silence = intervalMs * capFactor (the task's judge: 2) */
  capFactor?: number;
  /** demand at least one keepalive frame (default true) */
  requireHeartbeat?: boolean;
}

/**
 * Throw with a SPEC0230-tagged message when a sideband keepalive analysis
 * violates the acceptance discipline. This is the single judge used by the
 * engine-facing timing arms AND by the scripted-producer self-proof (where
 * the fake-alive producer must trip it).
 */
export function assertKeepaliveDiscipline(
  a: KeepaliveAnalysis,
  cfg: DisciplineConfig,
): void {
  const cap = cfg.intervalMs * (cfg.capFactor ?? 2);
  const problems: string[] = [];
  for (const v of a.violations) problems.push(`SPEC0230-PROTOCOL ${v.code}: ${v.detail}`);
  if (cfg.requireHeartbeat !== false && a.heartbeats.length === 0) {
    problems.push(
      "SPEC0230-KEEPALIVE none: not one byte-exact 0005 01 empty keepalive frame arrived",
    );
  }
  for (const g of a.gaps) {
    if (g.ms > cap) {
      problems.push(
        `SPEC0230-SILENCE over-cap: ${g.ms}ms of no frames between t=${g.fromMs}ms and ` +
          `t=${g.toMs}ms (cap ${cap}ms = claimed interval ${cfg.intervalMs}ms x ` +
          `${cfg.capFactor ?? 2})`,
      );
    }
  }
  if (!a.report.seen) problems.push("SPEC0230-REPORT absent: no report-status payload arrived");
  else if (!a.report.followedOnlyByFlush) {
    problems.push(
      "SPEC0230-REPORT not terminal: non-flush frames follow the report — the terminal " +
        "report must be the stream's last content",
    );
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

/* ---------------------------------------------------------------------------
 * Scripted producers — harness-side fake receive-pack response streams used
 * to prove the consumer's own assertions (Ledger A). They speak ONLY the
 * protocol shapes; they are not engine code.
 * ------------------------------------------------------------------------- */

export type ScriptedMode =
  | "keepalive" // interval beats (idle-gated), milestones honored, report last — the SPEC shape
  | "fake-alive" // beats scheduled, but a synchronous CPU block starves the timer past the window
  | "early-report" // report mid-stream with content after it — ordering violation
  | "bad-header" // an illegal pkt-line length header mid-stream
  | "truncated"; // a frame that declares more bytes than the stream delivers

export interface ScriptedConfig {
  mode: ScriptedMode;
  /** the "indexing" window length (arm open -> report) */
  indexingMs: number;
  /** beat interval (default 400ms — scaled-down 20s claim) */
  intervalMs?: number;
  /** band-2 milestone emissions inside the window */
  milestones?: { atMs: number; text: string }[];
  /** synchronous CPU burn length for fake-alive (default = indexingMs) */
  cpuBlockMs?: number;
}

function pktFrame(payload: Uint8Array): Uint8Array {
  // gitprotocol-common(5): the four hex length digits INCLUDE the four header
  // bytes themselves (engine pkt() does the same) — a header of payload.length
  // alone would desync every consumer by four bytes per frame
  const head = te.encode((payload.length + 4).toString(16).padStart(4, "0"));
  const out = new Uint8Array(4 + payload.length);
  out.set(head, 0);
  out.set(payload, 4);
  return out;
}

/** Wrap payload bytes into one sideband band frame (exported for canned fixtures). */
export function bandFrame(band: SidebandBand, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(payload.length + 1);
  framed[0] = band;
  framed.set(payload, 1);
  return pktFrame(framed);
}

/** The byte-exact git-official empty keepalive packet. */
export function heartbeatPacket(): Uint8Array {
  return HEARTBEAT_BYTES.slice();
}

/**
 * A wrapped band-1 report-status payload mirroring renderStatus's shape:
 * pkt-lines (with their own 4-byte headers) plus the report's terminating
 * flush, nested INSIDE the band-1 frame — NOT raw text. The analyzer's inner
 * parser (parseInnerReportLines) decodes exactly this shape.
 */
export function reportPacket(lines: string[]): Uint8Array {
  const inner = concatBytes([
    ...lines.map((l) => pktFrame(te.encode(`${l}\n`))),
    FLUSH_BYTES.slice(),
  ]);
  return bandFrame(1, inner);
}

export function scriptedReceivePackStream(cfg: ScriptedConfig): ReadableStream<Uint8Array> {
  const interval = cfg.intervalMs ?? 400;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const t0 = Date.now();
      let lastEmit = t0;
      let closed = false;
      const enqueue = (bytes: Uint8Array): void => {
        if (closed) return;
        controller.enqueue(bytes);
        lastEmit = Date.now();
      };
      const finish = (): void => {
        if (closed) return;
        closed = true;
        controller.enqueue(FLUSH_BYTES.slice());
        controller.close();
      };
      const reportAt = (atMs: number): void => {
        setTimeout(() => {
          if (closed) return;
          enqueue(reportPacket(["unpack ok", "ok refs/heads/main"]));
          finish();
        }, Math.max(0, atMs - (Date.now() - t0)));
      };

      if (cfg.mode === "keepalive" || cfg.mode === "fake-alive") {
        // idle-gated beats, exactly the official keepAlive semantics the SPEC
        // pins: a tick only emits when the window since the last emission has
        // actually covered the interval
        const timer = setInterval(() => {
          if (closed) {
            clearInterval(timer);
            return;
          }
          if (Date.now() - lastEmit >= interval * 0.9) {
            enqueue(heartbeatPacket());
          }
        }, interval);
        for (const m of cfg.milestones ?? []) {
          setTimeout(() => {
            if (!closed) enqueue(bandFrame(2, te.encode(m.text)));
          }, Math.max(0, m.atMs - (Date.now() - t0)));
        }
        if (cfg.mode === "fake-alive") {
          // the trap SPEC 0230's CPU-yield section warns about: synchronous
          // CPU work starves the timer for the whole window — the beats are
          // scheduled but the event loop cannot run them until the block
          // ends. The burn starts on the NEXT macrotask so the consumer is
          // already parked in reader.read() when the loop blocks (burning
          // inside start() would finish before anyone began reading, and the
          // starvation would never be observable on the wire).
          setTimeout(() => {
            burnSync(cfg.cpuBlockMs ?? cfg.indexingMs);
          }, 0);
        }
        reportAt(cfg.indexingMs);
        return;
      }
      if (cfg.mode === "early-report") {
        setTimeout(() => {
          enqueue(reportPacket(["unpack ok", "ok refs/heads/main"]));
        }, Math.max(0, Math.floor(cfg.indexingMs * 0.3)));
        for (const m of cfg.milestones ?? []) {
          setTimeout(() => {
            if (!closed) enqueue(bandFrame(2, te.encode(m.text)));
          }, Math.max(0, m.atMs - (Date.now() - t0)));
        }
        setTimeout(() => finish(), Math.max(0, cfg.indexingMs));
        return;
      }
      if (cfg.mode === "bad-header") {
        enqueue(heartbeatPacket());
        enqueue(te.encode("00zz")); // not four hex digits
        enqueue(te.encode("junk-after-broken-header"));
        setTimeout(() => finish(), Math.max(0, cfg.indexingMs));
        return;
      }
      // truncated: declares a 16-byte frame, delivers six, then ends
      enqueue(heartbeatPacket());
      enqueue(te.encode("0010" + "abcd"));
      setTimeout(() => finish(), Math.max(0, cfg.indexingMs));
    },
  });
}

/** A busy-wait CPU block — the workerm event loop cannot run timers inside it. */
export function burnSync(ms: number): void {
  const end = Date.now() + ms;
  let sink = 0;
  while (Date.now() < end) {
    for (let i = 0; i < 10_000; i++) sink = (sink + i) % 7;
  }
  if (sink < 0) throw new Error("unreachable: keeps the loop from being optimized away");
}

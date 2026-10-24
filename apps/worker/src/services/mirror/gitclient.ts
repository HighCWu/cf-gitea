/**
 * Outbound git smart-HTTP client (SPEC-0009 §2.5, milestone M1) — the client
 * mirror of the engine's upload-pack SERVER surface (SPEC-0001 §5). We
 * advertise v0+v2 fetch (docs/design/m3-design-inputs.md capability matrix),
 * and this client speaks whatever the REMOTE advertises: `git-protocol:
 * version=2` on the info/refs GET, falling back to the v0 advertisement the
 * moment the source does not answer with the v2 capability advert.
 *
 * Negotiation is deliberately minimal (SPEC-0009 §2.5): ONE round, always
 * with `done` (stateless; upstream servers answer a done-round with the
 * ACK/NAK section + pack — the same shapes the engine itself renders,
 * git/protocol.ts uploadPack), no multi-round stateless negotiation, no
 * shallow/deepen (mirrors are full-history), no filter expressions, and wants
 * are always advertised tips (no allow-reachable-sha1-in-want dependence).
 * v2 framing per gitprotocol-v2: the packfile section is ALWAYS multiplexed
 * (band bytes 1/2/3) and terminates at a flush — there is no sideband
 * negotiation in v2 (only the whole-response `sideband-all` opt-in, which we
 * do not send); v0 multiplexing rides the classic `side-band-64k` capability
 * and is only requested when the source advertises it.
 *
 * What is reused vs net-new (the SPEC §2.5 audit, verified against the
 * dist-types boundary):
 *   - pkt-line codec: the engine's `PktParser`/`pkt` are NOT exported through
 *     the package root (packages/git-engine exports only "."; dist-types is
 *     generated and never edited), so a local strict-hex codec lives below —
 *     byte-exact with the engine's rules (reject parseInt-style leniency) and
 *     with the precedent already set by src/repos/imports/pipeline.ts.
 *   - Pack receive: a fetch window IS a receive (SPEC-0009 §3.2) — the
 *     demuxed band-1 pack stream feeds the engine's own receive pipeline via
 *     the import-channel composition (src/repos/imports/pipeline.ts), which
 *     reuses stagePack → copy → finalizeReceive unchanged.
 *   - CAS/HEAD-fixup/report-status: engine primitives; the sync orchestrator
 *     (sync.ts) drives them.
 *
 * Hardening posture (SPEC-0009 §2.5 "Runner" + §4.1):
 *   - `redirect: "manual"` with re-validation of EVERY hop (scheme stays
 *     https, egress gate re-run, max 5 hops; a POST redirect is only followed
 *     on 307/308 — a 301/302/303 would downgrade to GET and can never carry
 *     the fetch request).
 *   - Size caps: the advertisement buffer is capped (8 MiB — §4.3.10) and the
 *     pack response is capped by a counting transform over the (transparently
 *     decompressed) body — in Workers the total-bytes cap and the
 *     decompressed-size cap are the same number, because fetch() decompresses
 *     content-encoding before the stream is exposed (documented residual).
 *   - Strict response content-type checks (the SPEC-0003 §2.2 conventions,
 *     now asserted on the response side): a dumb-HTTP source is a clear
 *     protocol error, never a garbage-pack parse.
 *   - Per-request abort-signal timeout; band 2 progress is collected, band 3
 *     is a hard stream error (§2.5 sideband demux).
 *   - Egress gate re-checked on every sync AND every redirect hop (§4.1 —
 *     upstream re-validates per sync, mirror_pull.go:113-121): IP-literal
 *     classification is imported from the webhook SSRF module (§4.1 posture
 *     parity), plus the mirror-specific https-only/userinfo/`.internal` rules.
 *
 * All errors are `SmartHttpError` with messages safe for `repo_mirrors.
 * last_error`; URLs in messages go through `sanitizeUrl` (userinfo never
 * reaches a log — upstream's SanitizeCredentialURLs discipline).
 */

import { classifyAddress, parseHostPolicy, parseIpLiteral, type EgressDecision, type HostPolicy } from "../../webhooks/ssrf";

// ---------------------------------------------------------------------------
// Limits (SPEC-0009 §2.5/§4.3 "Limits" — defaults; callers may tighten only)
// ---------------------------------------------------------------------------

/** Advertisement buffer cap (§4.3.10: ~100k refs). */
export const ADVERT_MAX_BYTES = 8 * 1024 * 1024;
/** Pack total-bytes cap: the engine's pack quota (a sync pack ≤ 1 GiB, §4.3
 * limits; the engine rejects oversized packs at staging anyway — this cap
 * stops the download before a single staging byte is written). */
export const PACK_MAX_BYTES = 1024 * 1024 * 1024;
/** Redirect hops re-validated before giving up (§2.5 runner). */
export const MAX_REDIRECT_HOPS = 5;
/** Haves per negotiation round (§2.5: bounded, ≤ 256 tips). */
export const MAX_HAVES = 256;
/** Per-request abort timeout. Mirrors fetch multi-hundred-MiB packs on the
 * queue consumer's 15-minute wall budget; the timeout is a stuck-stream
 * backstop, not a transfer bound. */
export const DEFAULT_FETCH_TIMEOUT_MS = 600_000;

/** Smart-HTTP content types (SPEC-0003 §2.2 conventions, response side). */
export const UPLOAD_PACK_ADVERTISEMENT_CT = "application/x-git-upload-pack-advertisement";
export const UPLOAD_PACK_RESULT_CT = "application/x-git-upload-pack-result";
export const UPLOAD_PACK_REQUEST_CT = "application/x-git-upload-pack-request";

const AGENT_CAP = "agent=cf-gitea-mirror/1";
const GIT_PROTOCOL_V2 = "version=2";

const OID_RE = /^[0-9a-f]{40}$/;
const ZERO_OID = "0".repeat(40);

/** Test seam + queue-consumer injection point — mirrors the webhook
 * consumer's `fetchImpl` option (NO real network in tests). */
export type FetchImpl = typeof fetch;

export class SmartHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmartHttpError";
  }
}

/** Strip userinfo from a URL for error/log surfaces (§4.2 — secrets are never
 * logged; a userinfo URL is gate-rejected anyway, defense in depth). */
export function sanitizeUrl(url: URL | string): string {
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.username === "" && u.password === "") return u.href;
  const clean = new URL(u.href);
  clean.username = "";
  clean.password = "";
  return clean.href;
}

// ---------------------------------------------------------------------------
// pkt-line codec — local, byte-exact with the engine's PktParser (see module
// doc: the engine does not export it through the package boundary; the same
// strictness rules apply: every one of the four length bytes must be a hex
// digit, or the packet is rejected)
// ---------------------------------------------------------------------------

const TE = new TextEncoder();
const TD = new TextDecoder();

function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  if (code >= 0x41 && code <= 0x5a) return code - 0x37;
  return -1;
}

function hex4(buf: Uint8Array, pos: number): number {
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const d = hexDigit(buf[pos + i] ?? -1);
    if (d < 0) throw new SmartHttpError("bad pkt-line length from source");
    n = (n << 4) | d;
  }
  return n;
}

/** Encode one pkt-line (the 4-byte length prefix includes itself). */
export function pkt(payload: string | Uint8Array): Uint8Array {
  const body = typeof payload === "string" ? TE.encode(payload) : payload;
  const len = body.length + 4;
  if (len > 65520) throw new SmartHttpError("pkt-line payload too large");
  const head = len.toString(16).padStart(4, "0");
  const out = new Uint8Array(len);
  out.set(TE.encode(head), 0);
  out.set(body, 4);
  return out;
}

/** pkt-line as text (builders assemble ASCII-only request bodies). */
function pktStr(payload: string): string {
  const len = payload.length + 4;
  if (len > 65520) throw new SmartHttpError("pkt-line payload too large");
  return `${len.toString(16).padStart(4, "0")}${payload}`;
}

/** The flush-pkt and delim-pkt are bare length words, not framed lines. */
const FLUSH = "0000";
const DELIM = "0001";

function concatBytes(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** One parsed pkt-line. flush/delim carry no payload. */
type Frame = { kind: "flush" } | { kind: "delim" } | { kind: "line"; payload: Uint8Array };

/**
 * Parse one pkt-line at `pos`. Returns null when more bytes are needed.
 * Throws on framing violations (strict hex, impossible lengths). `next` is
 * the offset after the frame.
 */
function frameAt(buf: Uint8Array, pos: number): { frame: Frame; next: number } | null {
  if (buf.length - pos < 4) return null;
  const len = hex4(buf, pos);
  if (len === 0) return { frame: { kind: "flush" }, next: pos + 4 };
  if (len === 1) return { frame: { kind: "delim" }, next: pos + 4 };
  if (len < 4 || len > 65520) throw new SmartHttpError(`bad pkt-line length ${len} from source`);
  if (buf.length - pos < len) return null;
  return { frame: { kind: "line", payload: buf.slice(pos + 4, pos + len) }, next: pos + len };
}

function frameText(payload: Uint8Array): string {
  return TD.decode(payload);
}

// ---------------------------------------------------------------------------
// Advertisement types + parsers (SPEC §2.5: the client parser is the mirror
// image of the engine's lsRefs renderer / advertisement renderer, not shared
// code — this is the direction the engine never needed)
// ---------------------------------------------------------------------------

export interface AdvertisedRef {
  name: string;
  oid: string;
  /** Peeled commit target of an annotated tag (`<ref>{}` continuation line in
   *  v0, `peeled:` attribute in v2). */
  peeled?: string;
  /** v2 `symref-target:` (or v0 `symref=HEAD:` capability) — where HEAD points. */
  symrefTarget?: string;
}

export interface Advertisement {
  protocolVersion: 0 | 2;
  /** v2: the capability advert's entries (ls-refs=…, fetch=…, object-format=…);
   *  v0: the first ref line's capability list. */
  capabilities: string[];
  /** v0: the advertised refs (HEAD included as a ref line when advertised).
   *  v2: filled by the ls-refs round fetchRefs drives after the capability
   *  advert. */
  refs: AdvertisedRef[];
  /** HEAD → branch symref, when the source advertises one. */
  headSymref: string | null;
  /** Unborn HEAD target (empty source): v2 `unborn` ls-refs line, v0 `unborn`
   *  capability. */
  unbornHead: string | null;
}

/** Split a pkt-line's capability section (v0 ref lines carry it after `\0`). */
function capsOf(lineText: string): string[] {
  const nul = lineText.indexOf("\0");
  if (nul < 0) return [];
  return lineText
    .slice(nul + 1)
    .trim()
    .split(" ")
    .filter((c) => c !== "");
}

/**
 * Parse the GET info/refs body. Detects the protocol: a first pkt-line of
 * "version 2" is the v2 capability advert (refs arrive via the ls-refs
 * round); anything else must be the v0 ref advertisement
 * (`# service=git-upload-pack` header, capabilities on the first ref line,
 * `^{}` peel continuation lines, `capabilities^{}` for an empty source).
 */
export function parseInfoRefsAdvert(bytes: Uint8Array): Advertisement {
  const advert: Advertisement = { protocolVersion: 0, capabilities: [], refs: [], headSymref: null, unbornHead: null };
  let pos = 0;
  const first = frameAt(bytes, pos);
  if (first === null || first.frame.kind !== "line") throw new SmartHttpError("empty or malformed advertisement from source");
  const firstText = frameText(first.frame.payload).trimEnd();
  pos = first.next;

  if (firstText === "version 2") {
    // v2 capability advert: plain lines until the flush (or end of body —
    // tolerated; the flush-less shape appears behind some proxies).
    const caps: string[] = [];
    for (;;) {
      const f = frameAt(bytes, pos);
      if (f === null) break;
      pos = f.next;
      if (f.frame.kind === "flush") break;
      if (f.frame.kind === "line") caps.push(frameText(f.frame.payload).trimEnd());
    }
    advert.protocolVersion = 2;
    advert.capabilities = caps;
    return advert;
  }

  // v0: optional "# service=…" header pkt + flush, then ref lines.
  if (firstText.startsWith("# service=")) {
    const sep = frameAt(bytes, pos);
    if (sep === null || sep.frame.kind !== "flush") throw new SmartHttpError("v0 advertisement header not followed by a flush");
    pos = sep.next;
  }

  let capsSource: string | null = null;
  let lastRef: AdvertisedRef | null = null;
  for (;;) {
    const f = frameAt(bytes, pos);
    if (f === null || f.frame.kind === "flush") break;
    pos = f.next;
    if (f.frame.kind !== "line") throw new SmartHttpError("unexpected delim-pkt in a v0 advertisement");
    const text = frameText(f.frame.payload).trimEnd();
    const head = text.split("\0")[0]!;
    const sp = head.indexOf(" ");
    if (sp < 0) throw new SmartHttpError(`malformed v0 ref line: ${text.slice(0, 80)}`);
    const oid = head.slice(0, sp);
    const name = head.slice(sp + 1);
    if (!OID_RE.test(oid)) throw new SmartHttpError(`malformed oid in v0 advertisement: ${name.slice(0, 60)}`);
    if (capsSource === null) capsSource = text; // capabilities ride the FIRST line
    if (name === "capabilities^{}") {
      // Empty source (gitprotocol-pack: zero-id capabilities line).
      continue;
    }
    if (name.endsWith("^{}")) {
      // Peeled target of the previous (annotated tag) ref.
      const base = name.slice(0, -3);
      if (lastRef === null || lastRef.name !== base) {
        throw new SmartHttpError(`peeled line without its ref in v0 advertisement: ${base.slice(0, 60)}`);
      }
      lastRef.peeled = oid;
      continue;
    }
    lastRef = { name, oid };
    advert.refs.push(lastRef);
  }
  advert.capabilities = capsSource === null ? [] : capsOf(capsSource);
  for (const cap of advert.capabilities) {
    if (cap.startsWith("symref=HEAD:")) advert.headSymref = cap.slice("symref=HEAD:".length);
  }
  // `unborn HEAD refs/heads/main` is a multi-token capability — the space-split
  // capability list cannot carry it, so scan the raw token stream (git's own
  // v0 parse special-cases it the same way).
  const capTokens = capsSource === null ? [] : capsSource.split("\0").pop()!.trim().split(" ").filter((t) => t !== "");
  for (let i = 0; i + 2 < capTokens.length + 1; i++) {
    if (capTokens[i] === "unborn" && capTokens[i + 1] === "HEAD") {
      advert.unbornHead = capTokens[i + 2] ?? null;
      break;
    }
  }
  return advert;
}

/**
 * Parse a v2 ls-refs response (the engine's `lsRefs` renderer, mirrored):
 * `<oid> SP <refname> [peeled:<oid>] [symref-target:<refname>]` lines; an
 * unborn HEAD arrives as `<unborn> HEAD symref-target:refs/heads/<name>`.
 */
export function parseLsRefsResponse(bytes: Uint8Array): { refs: AdvertisedRef[]; unbornHead: string | null } {
  const refs: AdvertisedRef[] = [];
  let unbornHead: string | null = null;
  let pos = 0;
  for (;;) {
    const f = frameAt(bytes, pos);
    if (f === null || f.frame.kind === "flush") break;
    pos = f.next;
    if (f.frame.kind !== "line") throw new SmartHttpError("unexpected delim-pkt in ls-refs response");
    const text = frameText(f.frame.payload).trimEnd();
    if (text.startsWith("ERR ")) throw new SmartHttpError(`source ls-refs error: ${text.slice(4, 200)}`);
    const sp = text.indexOf(" ");
    if (sp < 0) throw new SmartHttpError(`malformed ls-refs line: ${text.slice(0, 80)}`);
    const oidOrUnborn = text.slice(0, sp);
    const rest = text.slice(sp + 1);
    if (oidOrUnborn === "unborn") {
      // `unborn HEAD symref-target:refs/heads/main`
      const m = /symref-target:(\S+)/.exec(rest);
      if (m === null) throw new SmartHttpError(`unborn ls-refs line without symref-target: ${text.slice(0, 80)}`);
      unbornHead = m[1]!;
      continue;
    }
    if (!OID_RE.test(oidOrUnborn)) throw new SmartHttpError(`malformed oid in ls-refs: ${text.slice(0, 80)}`);
    const ref: AdvertisedRef = { name: rest, oid: oidOrUnborn };
    const sp2 = rest.indexOf(" ");
    if (sp2 >= 0) {
      ref.name = rest.slice(0, sp2);
      for (const attr of rest.slice(sp2 + 1).split(" ")) {
        if (attr.startsWith("peeled:")) ref.peeled = attr.slice(7);
        else if (attr.startsWith("symref-target:")) ref.symrefTarget = attr.slice(14);
      }
    }
    refs.push(ref);
  }
  return { refs, unbornHead };
}

// ---------------------------------------------------------------------------
// Request builders (SPEC §2.5 ~70 LOC) — exported for golden-bytes tests
// ---------------------------------------------------------------------------

function v2Preamble(command: "ls-refs" | "fetch", advertisedCaps: string[]): string {
  let s = pktStr(`command=${command}\n`) + pktStr(`${AGENT_CAP}\n`);
  if (advertisedCaps.some((c) => c === "object-format=sha1" || c === "object-format" || c.startsWith("object-format=sha1 "))) {
    s += pktStr("object-format=sha1\n");
  }
  return s + DELIM;
}

/** v0 want/have section + `done` + flush (stateless single round). Caps ride
 * the first want line, exactly like git (stateless_rpc flushes after done). */
export function buildV0FetchBody(wants: string[], haves: string[], caps: string[]): Uint8Array {
  const capText = caps.length > 0 ? ` ${caps.join(" ")}` : "";
  let s = "";
  wants.forEach((w, i) => {
    if (!OID_RE.test(w)) throw new SmartHttpError(`want is not a 40-hex oid: ${w.slice(0, 8)}…`);
    s += pktStr(i === 0 ? `want ${w}${capText}\n` : `want ${w}\n`);
  });
  s += FLUSH;
  for (const h of haves) {
    if (!OID_RE.test(h)) throw new SmartHttpError(`have is not a 40-hex oid: ${h.slice(0, 8)}…`);
    s += pktStr(`have ${h}\n`);
  }
  s += pktStr("done\n") + FLUSH;
  return TE.encode(s);
}

/** v2 ls-refs request: symrefs + peel + unborn, NO ref-prefix — a mirror
 * wants the complete ref tree (§2.5; open question 4 keeps upstream parity). */
export function buildLsRefsBody(advertisedCaps: string[]): Uint8Array {
  return TE.encode(v2Preamble("ls-refs", advertisedCaps) + pktStr("symrefs\n") + pktStr("peel\n") + pktStr("unborn\n") + FLUSH);
}

/** v2 command=fetch request: one round, `done` always. The fetch arguments
 * are the protocol's plain args (thin-pack/ofs-delta/no-progress — always
 * supported by a v2 server; the packfile section multiplexes unconditionally,
 * no sideband argument exists in v2). Wants must be advertised tips (§2.5). */
export function buildV2FetchBody(wants: string[], haves: string[], advertisedCaps: string[]): Uint8Array {
  let s = v2Preamble("fetch", advertisedCaps);
  for (const arg of ["thin-pack", "ofs-delta", "no-progress"]) s += pktStr(`${arg}\n`);
  for (const w of wants) {
    if (!OID_RE.test(w)) throw new SmartHttpError(`want is not a 40-hex oid: ${w.slice(0, 8)}…`);
    s += pktStr(`want ${w}\n`);
  }
  for (const h of haves) {
    if (!OID_RE.test(h)) throw new SmartHttpError(`have is not a 40-hex oid: ${h.slice(0, 8)}…`);
    s += pktStr(`have ${h}\n`);
  }
  s += pktStr("done\n") + FLUSH;
  return TE.encode(s);
}

// ---------------------------------------------------------------------------
// Sideband demux + pack response pump (SPEC §2.5 sideband demux): band 1 →
// pack stream, band 2 → progress, band 3 → hard error. Implemented as a
// pull-based ReadableStream so the raw-remainder hand-off after the v0 ack
// section stays a plain byte move (a v0 source without side-band-64k puts raw
// pack bytes directly after the NAK/final-ACK line).
// ---------------------------------------------------------------------------

export interface PackStreamHooks {
  /** Band 2 progress text, chunk-decoded (kept in the sync log). */
  onProgress?: (text: string) => void;
  /** Remote sideband-3 error text (hard failure, §2.5). */
  onRemoteError?: (text: string) => void;
}

export interface PackResponseResult {
  /** Demuxed pack bytes (band 1; or the raw body when the v0 source offered
   * no side-band-64k and the ack section ran straight into the pack). */
  packStream: ReadableStream<Uint8Array>;
  /** Oids the source ACKed as common (the haves it already has) — resolves
   * when the ack section completes, before any pack byte is consumed. */
  ackedRefs: Promise<string[]>;
  /** Total response bytes counted (decompressed view); resolves at stream end. */
  bytesSeen: Promise<number>;
}

/**
 * Demux an upload-pack response body (v0: ack section → sideband pack;
 * v2: optional acknowledgments → packfile section → always-sideband frames).
 * Enforces the total-bytes cap (the decompressed view — see module doc) on
 * every read; any violation or band-3 frame errors the whole stream.
 */
export function demuxPackResponse(
  body: ReadableStream<Uint8Array>,
  shape: { protocolVersion: 0 | 2; sideband: boolean },
  hooks: PackStreamHooks,
  options: { maxBytes: number },
): PackResponseResult {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = new Uint8Array(0);
  let pos = 0;
  let total = 0;
  let state: "header" | "packfile-delim" | "sideband" | "raw" | "done" = "header";
  const acks: string[] = [];
  let resolveAcks!: (v: string[]) => void;
  let rejectAcks!: (e: unknown) => void;
  let resolveBytes!: (v: number) => void;
  let rejectBytes!: (e: unknown) => void;
  const ackedRefs = new Promise<string[]>((res, rej) => {
    resolveAcks = res;
    rejectAcks = rej;
  });
  const bytesSeen = new Promise<number>((res, rej) => {
    resolveBytes = res;
    rejectBytes = rej;
  });
  // The stream's own error is the primary failure surface (the receive fails
  // on it); ackedRefs/bytesSeen are secondary observers — an unobserved
  // rejection must not surface as an unhandledRejection (workerd treats those
  // as fatal). Awaiting them still throws for callers that observe them.
  ackedRefs.catch(() => {});
  bytesSeen.catch(() => {});

  const fail = (error: unknown): void => {
    rejectAcks(error);
    rejectBytes(error);
  };
  /** The ack section completed (pack starts) — acks are final here; the byte
   *  count only settles at stream end (the total-bytes promise must observe
   *  the WHOLE response, not just its prefix). */
  const finishAcks = (): void => {
    resolveAcks(acks);
  };
  const finishBytes = (): void => {
    resolveBytes(total);
  };
  const absorb = (value: Uint8Array): void => {
    total += value.length;
    if (total > options.maxBytes) {
      throw new SmartHttpError(`source pack exceeds the ${options.maxBytes} byte cap (received ${total})`);
    }
  };
  /** Ack-section terminator reached: the pack section starts NOW. */
  const beginPack = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    finishAcks();
    if (shape.sideband) {
      state = "sideband";
    } else {
      // Raw pack: whatever is left in the buffer (and the rest of the body)
      // is pack bytes — move them through untouched.
      state = "raw";
      if (buf.length - pos > 0) {
        controller.enqueue(buf.slice(pos));
        pos = buf.length;
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (pos > 0) {
          buf = buf.slice(pos); // keep the parse window small (≤ one frame tail)
          pos = 0;
        }
        for (;;) {
          if (state === "done") {
            finishBytes();
            controller.close();
            return;
          }
          if (state === "raw") {
            const { done, value } = await reader.read();
            if (done) {
              state = "done";
              continue;
            }
            absorb(value);
            controller.enqueue(value);
            return;
          }
          const parsed = frameAt(buf, pos);
          if (parsed === null) {
            const { done, value } = await reader.read();
            if (done) {
              if (state === "header") {
                // Every `done` round gets a pack (possibly empty); ending in
                // the header means the source closed early.
                throw new SmartHttpError("source closed the response before the pack section");
              }
              throw new SmartHttpError("source closed the response mid-frame (truncated pack)");
            }
            absorb(value);
            buf = pos === 0 ? concatBytes(buf, value) : concatBytes(buf.slice(pos), value);
            pos = 0;
            continue;
          }
          pos = parsed.next;
          const frame = parsed.frame;

          if (state === "header") {
            if (frame.kind === "flush") continue; // section separator (v2)
            if (frame.kind === "delim") continue; // stray delim: tolerated
            const text = frameText(frame.payload).trimEnd();
            if (text.startsWith("ERR ")) {
              throw new SmartHttpError(`source fetch error: ${text.slice(4, 200)}`);
            }
            if (shape.protocolVersion === 0) {
              const ack = /^ACK ([0-9a-f]{40})(?: (common|ready))?$/.exec(text);
              if (ack !== null) {
                if (!acks.includes(ack[1]!)) acks.push(ack[1]!); // the final bare ACK repeats the last common
                if (ack[2] === undefined) beginPack(controller); // bare ACK: pack follows
                continue;
              }
              if (text === "NAK") {
                beginPack(controller);
                continue;
              }
              throw new SmartHttpError(`unexpected line in the v0 ack section: ${text.slice(0, 80)}`);
            }
            // v2 sections before the packfile section: "acknowledgments",
            // "shallow-info", "wanted-refs", ACK/NAK lines — tolerated
            // preamble (we never deepen; haves may produce acks). The
            // packfile section header switches to its delim + sideband
            // frames.
            if (text === "packfile") {
              finishAcks(); // acks are final once the packfile section begins (v2 has no v0-style NAK terminator)
              state = "packfile-delim";
              continue;
            }
            const ack = /^ACK ([0-9a-f]{40})$/.exec(text);
            if (ack !== null) acks.push(ack[1]!);
            continue;
          }

          if (state === "packfile-delim") {
            if (frame.kind === "delim") {
              if (!shape.sideband) {
                // v2 packfile sections are ALWAYS multiplexed (module doc);
                // reaching here means the caller misdeclared the shape.
                throw new SmartHttpError("v2 packfile section received without a negotiated sideband");
              }
              state = "sideband";
              continue;
            }
            if (frame.kind === "flush") {
              state = "done"; // empty packfile section — protocol end
              continue;
            }
            throw new SmartHttpError("expected the packfile section's delim-pkt from source");
          }

          if (state === "sideband") {
            if (frame.kind === "flush") {
              state = "done";
              continue;
            }
            if (frame.kind !== "line") continue;
            if (frame.payload.length === 0) continue;
            const band = frame.payload[0]!;
            const payload = frame.payload.slice(1);
            if (band === 1) {
              if (payload.length > 0) {
                controller.enqueue(payload);
                return;
              }
              continue;
            }
            if (band === 2) {
              if (payload.length > 0) hooks.onProgress?.(decoder.decode(payload, { stream: true }));
              continue;
            }
            if (band === 3) {
              const message = payload.length > 0 ? decoder.decode(payload) : "(no detail)";
              hooks.onRemoteError?.(message);
              throw new SmartHttpError(`source reported a fatal error (sideband 3): ${message.slice(0, 200)}`);
            }
            throw new SmartHttpError(`unexpected sideband band ${band} from source`);
          }
        }
      } catch (error) {
        fail(error);
        reader.cancel(error).catch(() => {}); // stop the transfer; never mask the real error
        controller.error(error);
      }
    },
    cancel(reason) {
      fail(new SmartHttpError("pack stream cancelled before completion"));
      return reader.cancel(reason);
    },
  });

  return { packStream: stream, ackedRefs, bytesSeen };
}

// ---------------------------------------------------------------------------
// Runner (SPEC §2.5 "Runner"): credentials, redirect:manual with per-hop
// re-validation, abort timeout, strict content types
// ---------------------------------------------------------------------------

export interface GitClientOptions {
  /** Test seam / queue injection — defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Full Authorization header value (Basic/Bearer — §2.2 composition). */
  authHeader?: string;
  /** Per-request abort timeout (default DEFAULT_FETCH_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Advertisement buffer cap (default ADVERT_MAX_BYTES). */
  advertMaxBytes?: number;
  /** Pack total-bytes cap (default PACK_MAX_BYTES). */
  packMaxBytes?: number;
  /** Parsed egress allow-list (§4.1); default lax-empty. */
  policy?: HostPolicy;
  /** Redirect hop budget (default MAX_REDIRECT_HOPS). */
  maxRedirects?: number;
}

/** Normalize a repo URL to its smart-HTTP base (no trailing slash). */
function sourceBase(repoUrl: string): URL {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new SmartHttpError("source URL is not a valid URL");
  }
  url.href = url.href.replace(/\/+$/, "");
  return url;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface RunRequestOptions extends GitClientOptions {
  expectContentType: string;
  what: string;
}

/**
 * Issue one logical request with `redirect: "manual"`, re-validating every
 * hop (https + egress gate) and asserting the expected content type. The body
 * must be a replayable Uint8Array (a 307/308 retry re-sends it); POSTs carry
 * the smart-HTTP request content type (the SPEC-0003 §2.2 conventions, now on
 * the request side — git servers and our own gate both require it).
 */
async function runRequest(url: URL, init: { method: "GET" | "POST"; body?: Uint8Array; requestContentType?: string }, options: RunRequestOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxHops = options.maxRedirects ?? MAX_REDIRECT_HOPS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const policy = options.policy ?? defaultMirrorPolicy();
  const headers: Record<string, string> = { "git-protocol": GIT_PROTOCOL_V2 };
  if (init.requestContentType !== undefined) headers["content-type"] = init.requestContentType;
  if (options.authHeader !== undefined) headers.authorization = options.authHeader;

  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const gate = checkMirrorSource(current, policy);
    if (!gate.allowed) throw new SmartHttpError(gate.reason);

    let response: Response;
    try {
      response = await fetchImpl(current.toString(), {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SmartHttpError(`source request failed (${options.what}): ${message} [${sanitizeUrl(current)}]`);
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (location === null) throw new SmartHttpError(`source redirect ${response.status} without a Location header`);
      const next = new URL(location, current);
      if (next.protocol !== "https:") {
        throw new SmartHttpError(`source redirect left https (${next.protocol}) — refusing [${sanitizeUrl(next)}]`);
      }
      if (init.method === "POST" && response.status !== 307 && response.status !== 308) {
        throw new SmartHttpError(`source redirected the fetch POST with ${response.status} (would downgrade to GET) — refusing`);
      }
      current = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SmartHttpError(`source responded ${response.status} for ${options.what} [${sanitizeUrl(current)}]`);
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== options.expectContentType) {
      throw new SmartHttpError(
        `source ${options.what} content-type is '${contentType ?? "none"}', expected '${options.expectContentType}' (dumb HTTP or a non-git server?) [${sanitizeUrl(current)}]`,
      );
    }
    return response;
  }
  throw new SmartHttpError(`source exceeded the ${maxHops}-redirect budget [${sanitizeUrl(current)}]`);
}

/** The runtime types `Response.body` as a loosely-parameterized stream; the
 *  wire carries Uint8Arrays — the same narrowing consumer.ts's
 *  readResponseCapped performs on its reader. */
function responseBodyBytes(response: Response): ReadableStream<Uint8Array> {
  if (response.body === null) throw new SmartHttpError("source response had no body");
  return response.body as ReadableStream<Uint8Array>;
}

/** Read a bounded response body fully (advertisement / ls-refs). */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number, what: string): Promise<Uint8Array> {
  if (body === null) throw new SmartHttpError(`source ${what} had no body`);
  const reader = body.getReader();
  let out = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    if (out.length + value.length > max) {
      await reader.cancel().catch(() => {});
      throw new SmartHttpError(`source ${what} exceeds the ${max} byte cap`);
    }
    out = concatBytes(out, value);
  }
}

// ---------------------------------------------------------------------------
// fetchRefs / fetchPack — the client surface
// ---------------------------------------------------------------------------

/**
 * GET info/refs (both service shapes) → the source advertisement. v2: the
 * capability advert is parsed, then a `command=ls-refs` POST collects the
 * refs (symrefs, peeled tags, unborn HEAD). v0: the ref lines carry the caps
 * (symref=HEAD, `^{}` peels) — one request, no second round.
 */
export async function fetchRefs(repoUrl: string, options: GitClientOptions = {}): Promise<Advertisement> {
  const base = sourceBase(repoUrl);
  const advertMax = options.advertMaxBytes ?? ADVERT_MAX_BYTES;

  const infoRefs = await runRequest(
    new URL(`${base.toString()}/info/refs?service=git-upload-pack`),
    { method: "GET" },
    { ...options, expectContentType: UPLOAD_PACK_ADVERTISEMENT_CT, what: "info/refs advertisement" },
  );
  const advert = parseInfoRefsAdvert(await readCapped(responseBodyBytes(infoRefs), advertMax, "info/refs advertisement"));
  if (advert.protocolVersion === 0) return advert;

  // v2: the capability advert carries no refs — POST ls-refs (§2.5).
  const lsRefs = await runRequest(
    new URL(`${base.toString()}/git-upload-pack`),
    { method: "POST", body: buildLsRefsBody(advert.capabilities), requestContentType: UPLOAD_PACK_REQUEST_CT },
    { ...options, expectContentType: UPLOAD_PACK_RESULT_CT, what: "ls-refs" },
  );
  const parsed = parseLsRefsResponse(await readCapped(responseBodyBytes(lsRefs), advertMax, "ls-refs response"));
  advert.refs = parsed.refs;
  const head = parsed.refs.find((r) => r.name === "HEAD");
  if (head?.symrefTarget !== undefined) advert.headSymref = head.symrefTarget;
  advert.unbornHead = parsed.unbornHead;
  return advert;
}

export interface FetchPackOptions extends GitClientOptions {
  /** The advertisement fetchRefs returned — the client speaks what the source
   * advertised (protocol version decides the request shape). A v0 fetch
   * without it uses a conservative default capability set. */
  advert?: Advertisement;
  /** Progress sink (band 2 — kept in the sync log). */
  onProgress?: (text: string) => void;
}

export interface FetchPackResult extends PackResponseResult {
  protocolVersion: 0 | 2;
}

/**
 * POST git-upload-pack — one negotiation round, always `done` (§2.5). Wants
 * must be advertised tips; haves are the local tips already held (≤ MAX_HAVES;
 * thin packs resolve their bases from our own store — the engine accepts
 * cross-pack thin resolution, SPEC-0001 §5). Returns the DEMUXED pack stream
 * plus the acked-common set and the byte count.
 */
export async function fetchPack(repoUrl: string, wants: string[], haves: string[], options: FetchPackOptions = {}): Promise<FetchPackResult> {
  if (wants.length === 0) throw new SmartHttpError("fetchPack requires at least one want");
  if (haves.length > MAX_HAVES) throw new SmartHttpError(`haves exceed the ${MAX_HAVES}-tip negotiation bound`);
  const base = sourceBase(repoUrl);
  const advert = options.advert;
  const v2 = advert?.protocolVersion === 2;

  let body: Uint8Array;
  let sideband: boolean;
  if (v2) {
    body = buildV2FetchBody(wants, haves, advert?.capabilities ?? []);
    sideband = true; // v2 packfile sections multiplex unconditionally (module doc)
  } else {
    const capabilities = advert?.capabilities ?? ["multi_ack_detailed", "side-band-64k", "thin-pack", "ofs-delta"];
    const caps: string[] = [];
    if (capabilities.includes("multi_ack_detailed")) caps.push("multi_ack_detailed"); // git's first position
    if (capabilities.includes("side-band-64k")) {
      caps.push("side-band-64k");
      sideband = true;
    } else {
      sideband = false;
    }
    if (capabilities.includes("thin-pack")) caps.push("thin-pack");
    if (capabilities.includes("ofs-delta")) caps.push("ofs-delta");
    caps.push(AGENT_CAP);
    body = buildV0FetchBody(wants, haves, caps);
  }

  const response = await runRequest(
    new URL(`${base.toString()}/git-upload-pack`),
    { method: "POST", body, requestContentType: UPLOAD_PACK_REQUEST_CT },
    { ...options, expectContentType: UPLOAD_PACK_RESULT_CT, what: "git-upload-pack fetch" },
  );
  const demuxed = demuxPackResponse(
    responseBodyBytes(response),
    { protocolVersion: v2 ? 2 : 0, sideband },
    { onProgress: options.onProgress },
    { maxBytes: options.packMaxBytes ?? PACK_MAX_BYTES },
  );
  return { protocolVersion: v2 ? 2 : 0, ...demuxed };
}

// ---------------------------------------------------------------------------
// Egress gate (§4.1) — webhook SSRF classification + mirror-specific rules
// (kept below the protocol surface it guards; exported for the orchestrator
// and the migrate route's accept-time gate)
// ---------------------------------------------------------------------------

/** The webhook module's lax policy, for callers that did not build one. */
export function defaultMirrorPolicy(): HostPolicy {
  return parseHostPolicy(undefined, "lax");
}

/**
 * Screen a mirror source URL (§4.1). Same posture as webhook targets, ported
 * to upstream's migration policy (modules/egress/policies.go:23-34,78-84):
 *
 * - https only; opaque/other schemes are rejected before any resolution. The
 *   CRLF-smuggling shapes upstream blocks (services/migrations/migrate.go
 *   :66-68) arrive in RAW strings — WHATWG URL parsing already strips control
 *   bytes, so the serialized-form control-char check below is defense in
 *   depth; the migrate route's raw-string validation owns that vector.
 * - credentials in the URL's userinfo are REJECTED (§2.2: credentials only
 *   ever arrive in the structured fields of the migrate API).
 * - IP-literal targets go through the webhook module's classification
 *   (`classifyAddress`): reserved → always denied; restricted (loopback,
 *   RFC1918, link-local incl. cloud metadata, CGNAT, ULA) → denied unless an
 *   explicit IP-form allow entry covers them (upstream WithLocalNeedsIPAllow
 *   — a hostname entry is not enough).
 * - Hostnames: `*.local` / `*.internal` / `localhost` are denied outright
 *   (§4.1). The webhook module's resolution caveat applies unchanged (Workers
 *   fetch re-resolves independently; the residual TOCTOU is documented and
 *   accepted, mitigated by re-validated redirect hops).
 * - Remaining hostnames are screened against the allow-list (strict mode) or
 *   allowed (lax — upstream's default for public targets).
 *
 * The list-matching rules are the webhook gate's, re-rendered with the
 * MIRROR attribution (that function hard-codes the webhook setting name and
 * admits http — the shared, imported half is the IP classification and the
 * parsed-list model from src/webhooks/ssrf.ts).
 */
export function checkMirrorSource(url: URL, policy: HostPolicy = defaultMirrorPolicy()): EgressDecision {
  const usage = "mirror sync";
  const key = "MIRROR_ALLOWED_HOST_LIST";
  const deny = (extra: string): EgressDecision => ({
    allowed: false,
    reason: `${usage} ${extra}, deny '${sanitizeUrl(url)}' (check ${key})`,
  });

  if (url.protocol !== "https:") {
    return { allowed: false, reason: `${usage}: only https source URLs are supported, deny '${sanitizeUrl(url)}'` };
  }
  if (url.username !== "" || url.password !== "") {
    return { allowed: false, reason: `${usage}: source URL must not carry credentials in its userinfo, deny '${sanitizeUrl(url)}'` };
  }
  if (/[\r\n\t]/.test(url.href)) {
    return { allowed: false, reason: `${usage}: source URL contains control characters, deny '${sanitizeUrl(url)}'` };
  }

  const host = url.hostname.toLowerCase();
  const port = url.port === "" ? 443 : Number(url.port);

  const literal = parseIpLiteral(host);
  if (literal !== null) {
    const addressClass = classifyAddress(literal);
    if (addressClass === "reserved") return deny("can not fetch from reserved addresses");
    const ipAllowed = policy.allow.ips.some(
      (rule) => rule.isV4 === literal.isV4 && cidrContains128(rule.prefix, rule.bits, literal.bytes) && portInRange(rule.ports, port),
    );
    if (ipAllowed) return { allowed: true, reason: "" };
    if (policy.mode === "lax" && addressClass === "public") return { allowed: true, reason: "" };
    return deny("needs an explicit IP allow entry (non-public address)");
  }

  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return deny("can not fetch from local-only host names");
  }
  const hostAllowed = policy.allow.hosts.some(
    (rule) => hostMatchesPattern(rule.pattern, host) && portInRange(rule.ports, port),
  );
  if (hostAllowed) return { allowed: true, reason: "" };
  if (policy.mode === "lax") return { allowed: true, reason: "" };
  return deny("can only fetch from allowed hosts");
}

/** 128-bit CIDR containment over the ssrf module's canonical form. The
 * ssrf module keeps its matcher private; this mirrors `cidrContains` there
 * (byte-exact: v4 rules live at offset 12 of the canonical form). */
function cidrContains128(prefix: Uint8Array, bits: number, addr: Uint8Array): boolean {
  if (bits === 0) return true;
  let remaining = bits;
  let i = 0;
  while (remaining > 0) {
    const mask = remaining >= 8 ? 0xff : 0xff << (8 - remaining);
    if ((addr[i]! & mask) !== (prefix[i]! & mask)) return false;
    remaining -= 8;
    i++;
  }
  return true;
}

function portInRange(ports: { start: number; end: number }[], port: number): boolean {
  return ports.some((r) => port >= r.start && port <= r.end);
}

/** `example.com` matches the host and its subdomains; `*.x`/`.x` subdomains
 * only — the ssrf module's matchHostPattern, mirrored for the same reason. */
function hostMatchesPattern(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.") || pattern.startsWith(".")) {
    const suffix = pattern.startsWith("*.") ? pattern.slice(1) : pattern;
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return pattern === host || host.endsWith(`.${pattern}`);
}

// ---------------------------------------------------------------------------
// Advertisement → command synthesis (SPEC §2.5 ~80 LOC): the diff the sync
// orchestrator turns into fetch windows and receive commands
// ---------------------------------------------------------------------------

/** git check-ref-format's core rules, the subset imports/service.ts enforces
 *  for manifests — refname validation failures FAIL the sync (§2.5). The
 *  printable specials live in one regex; control bytes are a code-point walk
 *  (a literal control-character range trips the no-control-regex lint, and a
 *  manual loop keeps the git rule readable anyway). */
const REFNAME_SPECIALS = /[\s~^:?*[\]\\]/;

export function validRefName(name: string): boolean {
  if (!name.startsWith("refs/") || name.endsWith("/") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false; // ASCII control bytes
  }
  if (REFNAME_SPECIALS.test(name)) return false;
  for (const component of name.split("/")) {
    if (component === "" || component.startsWith(".") || component.endsWith(".lock")) return false;
  }
  return true;
}

export interface MirrorRefPlan {
  /** Advertised refs missing locally (create commands, old = ZERO_OID). */
  creates: { ref: string; oid: string }[];
  /** Advertised refs whose local tip differs — FORCE updates: `old` carries
   * the current local tip, which is exactly the engine CAS `old === current`
   * plus the `+` refspec semantics (§2.5; non-fast-forward rewinds apply). */
  updates: { ref: string; old: string; oid: string }[];
  /** Local refs absent upstream — deleted IFF prune is enabled (§4.3.3). */
  deletes: { ref: string; old: string }[];
  /** Distinct missing tips = the fetch window's wants. */
  wants: string[];
  /** `refs/pull/*` deltas ride the mirror but are NEVER notified (§2.7). */
  notifiedExcluded: string[];
}

/**
 * Diff the advertisement against the local refs (listRefs result) into the
 * sync plan. HEAD is never planned (it is fixed once at import; syncs do not
 * move meta.head — §4.3.8). Invalid advertised refnames throw.
 */
export function planMirrorSync(
  advert: Advertisement,
  localRefs: { name: string; target: string }[],
  options: { prune: boolean },
): MirrorRefPlan {
  const local = new Map(localRefs.map((r) => [r.name, r.target]));
  const plan: MirrorRefPlan = { creates: [], updates: [], deletes: [], wants: [], notifiedExcluded: [] };
  const wantSet = new Set<string>();

  for (const ref of advert.refs) {
    if (ref.name === "HEAD") continue; // §4.3.8 — HEAD moves only at import
    if (!validRefName(ref.name)) throw new SmartHttpError(`source advertises an invalid refname: ${ref.name.slice(0, 80)}`);
    const current = local.get(ref.name);
    if (current === ref.oid) continue; // up to date
    if (current === undefined) plan.creates.push({ ref: ref.name, oid: ref.oid });
    else plan.updates.push({ ref: ref.name, old: current, oid: ref.oid });
    if (!wantSet.has(ref.oid)) {
      wantSet.add(ref.oid);
      plan.wants.push(ref.oid);
    }
    if (ref.name.startsWith("refs/pull/")) plan.notifiedExcluded.push(ref.name);
  }

  if (options.prune) {
    for (const [name, target] of local) {
      if (advert.refs.some((r) => r.name === name)) continue;
      if (!validRefName(name)) continue; // never plan a delete on a name we could not have created
      plan.deletes.push({ ref: name, old: target });
      if (name.startsWith("refs/pull/")) plan.notifiedExcluded.push(name);
    }
  }
  return plan;
}

/** Convenience re-export: the ZERO_OID the plan's consumers compare against. */
export { ZERO_OID };

/**
 * Outbound push client (SPEC specs/push-mirror-outbound.md §2, "the client
 * shell") — the client side of git-receive-pack over smart HTTP. The mirror
 * image of gitclient.ts (the pull direction): we GET the remote's
 * `info/refs?service=git-receive-pack` advertisement (v0 ONLY —
 * gitprotocol-v2 defines fetch/ls-refs; receive-pack is unchanged, so push
 * discovery never speaks v2 and the `git-protocol: version=2` offer header is
 * omitted), diff it against OUR tips (§2.2 step 2 — polarity inverted vs
 * planMirrorSync: force is a client-side decision, `old` carries the
 * REMOTE's advertised oid because receive-pack is a per-ref CAS on the
 * server), then POST the receive-pack request: pkt-line command section
 * (capabilities on the first command) + flush + [raw pack bytes] — the pack
 * itself comes from the loopback upload-pack composition (§2.4, zero engine
 * changes) and streams through `prependStream`, never buffered.
 *
 * Capability posture (§2.2 step 4): we request `report-status delete-refs`
 * + agent. NOT side-band-64k (the response then arrives as plain pkt-lines —
 * a simpler parse than the pull direction's demux), NOT thin-pack/ofs-delta
 * (the loopback pack is self-contained by construction), NOT atomic
 * (upstream mirrors are not atomic; a partial apply is a failed sync, §6.5).
 *
 * The response is report-status v0 (§2.2 step 5): `unpack ok|<err>` then one
 * `ok <ref>` / `ng <ref> [<msg>]` per command. ANY ng fails the sync
 * wholesale (upstream: git push exits non-zero on any rejected ref), with
 * the failed refs joined into `last_error` (capped) — `ng fetch first` is
 * the advertisement→POST TOCTOU and self-heals at the next cadence.
 *
 * Where the parsers come from (the SPEC §2.5 collapse note): the v0
 * advertisement parser (`parseInfoRefsAdvert`) and the strict runner
 * (`runRequest` — manual redirects with per-hop egress re-validation, 307/308
 * only for POSTs, abort timeout, strict content types) are the pull client's,
 * imported; `parseReportStatus` is the helper sync.ts used to carry
 * privately — it lives HERE so both consumers share one parser.
 *
 * All errors are `SmartHttpError` with messages safe for
 * `push_mirrors.last_error`; URLs in messages go through `sanitizeUrl`
 * (upstream's SanitizeErrorCredentialURLs discipline) and the Authorization
 * value never appears in any error text (asserted by test).
 */

import {
  ADVERT_MAX_BYTES,
  AGENT_CAP,
  MAX_HAVES,
  SmartHttpError,
  ZERO_OID,
  concatBytes,
  parseInfoRefsAdvert,
  pkt,
  readCapped,
  responseBodyBytes,
  runRequest,
  sourceBase,
  validRefName,
  type Advertisement,
  type GitClientOptions,
} from "./gitclient";

// ---------------------------------------------------------------------------
// Smart-HTTP content types (gitprotocol-http.txt; the receive side of the
// SPEC-0003 §2.2 conventions)
// ---------------------------------------------------------------------------

export const RECEIVE_PACK_ADVERTISEMENT_CT = "application/x-git-receive-pack-advertisement";
export const RECEIVE_PACK_REQUEST_CT = "application/x-git-receive-pack-request";
export const RECEIVE_PACK_RESULT_CT = "application/x-git-receive-pack-result";

/** Capabilities this client requests on the first command (§2.2 step 4). */
export const RECEIVE_PACK_CAPS = `report-status delete-refs ${AGENT_CAP}`;

const TE = new TextEncoder();
const TD = new TextDecoder();

const FLUSH_PKT = TE.encode("0000");
const OID_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Step 1 — the receive-pack ref advertisement
// ---------------------------------------------------------------------------

/**
 * GET `{remote}/info/refs?service=git-receive-pack` → the parsed v0
 * advertisement. Reuses the pull client's advertisement parser verbatim (the
 * v0 grammar, `^{}` peel continuations and the zero-id `capabilities^{}`
 * empty-repo line are service-agnostic) and the pull runner's hardening
 * posture (manual redirects with per-hop egress re-validation, abort
 * timeout, strict content type). Adds the push-specific refusals: a v2
 * answer is a protocol violation (receive-pack is v0-only) and an
 * `object-format` other than sha1 fails the sync cleanly (the engine store
 * is SHA-1 only, §6.8).
 */
export async function fetchReceiveRefs(repoUrl: string, options: GitClientOptions = {}): Promise<Advertisement> {
  const base = sourceBase(repoUrl);
  const response = await runRequest(
    new URL(`${base.toString()}/info/refs?service=git-receive-pack`),
    { method: "GET", protocolHeader: false },
    {
      ...options,
      expectContentType: RECEIVE_PACK_ADVERTISEMENT_CT,
      what: "info/refs advertisement",
      peerLabel: "mirror target",
    },
  );
  const bytes = await readCapped(
    responseBodyBytes(response),
    options.advertMaxBytes ?? ADVERT_MAX_BYTES,
    "info/refs advertisement",
  );
  const advert = parseInfoRefsAdvert(bytes);
  if (advert.protocolVersion !== 0) {
    throw new SmartHttpError("mirror target answered the receive-pack advertisement with protocol v2 (receive-pack is v0-only)");
  }
  const objectFormat = advert.capabilities.find((cap) => cap.startsWith("object-format="));
  if (objectFormat !== undefined && objectFormat !== "object-format=sha1") {
    throw new SmartHttpError(`mirror target advertises ${objectFormat} — this store is SHA-1 only`);
  }
  return advert;
}

/** Whether delete commands may be sent at all (gitprotocol-pack: a server
 *  advertises `delete-refs` to accept them, §6.2). */
export function advertisesDeleteRefs(advert: Advertisement): boolean {
  return advert.capabilities.includes("delete-refs");
}

// ---------------------------------------------------------------------------
// Step 2 — the plan (advertisement vs our tips)
// ---------------------------------------------------------------------------

/** The v1 refset (§2.3): the refspecs upstream CONFIGURES
 *  (mirror_push.go:37-40) — a deliberate divergence from `--mirror`'s
 *  literal `refs/*`, which would try to create `refs/pull/*` on GitHub-type
 *  targets and be rejected server-side. HEAD is outside by construction. */
export function inPushRefset(name: string): boolean {
  return name.startsWith("refs/heads/") || name.startsWith("refs/tags/");
}

export interface PushRefPlan {
  /** We hold the ref, the remote does not advertise it → create command
   *  `old = ZERO_OID, new = our tip`. */
  creates: { ref: string; oid: string }[];
  /** Both sides hold it, tips differ → update command with
   *  `old = the REMOTE's advertised oid` (the per-ref CAS value; force is
   *  the client-side decision to send the update at all, §2.2 step 2). */
  updates: { ref: string; old: string; oid: string }[];
  /** The remote advertises it (inside the refset), we lack it → delete
   *  command `new = ZERO_OID`. Prune is ALWAYS on within the refset (§2.3);
   *  only gated on the remote's `delete-refs` capability. */
  deletes: { ref: string; old: string }[];
  /** Deletes dropped because the target does not advertise `delete-refs` —
   *  surfaced, never silently pretended (§6.2). */
  skippedDeletes: string[];
  /** The REMOTE's advertised oids (tips + `^{}` peeled targets, deduped,
   *  ≤ MAX_HAVES — truncation only inflates the pack, never corrupts it,
   *  §2.4): the haves of the loopback upload-pack call. Includes refs
   *  OUTSIDE the pushed refset — the remote truly holds those objects. */
  haves: string[];
  /** Our new tips (creates + updates, deduped) — the wants of the loopback
   *  upload-pack call. Every planned command's objects ride one pack; the
   *  haves-exclusion yields a valid 0-object pack when the remote already
   *  holds everything (§6.14). */
  wants: string[];
}

/**
 * Diff the receive advertisement against our local tips (listRefs result)
 * into the push plan — the mirror image of planMirrorSync: polarity
 * inverted, prune always-on inside the refset, HEAD excluded (it is not in
 * the refset), refname validation on the names we would create/update.
 */
export function planPushSync(
  advert: Advertisement,
  localRefs: { name: string; target: string }[],
  options: { allowDelete?: boolean } = {},
): PushRefPlan {
  const local = new Map(localRefs.map((r) => [r.name, r.target]));
  const plan: PushRefPlan = { creates: [], updates: [], deletes: [], skippedDeletes: [], haves: [], wants: [] };
  const wantSet = new Set<string>();
  const haveSet = new Set<string>();
  const addHave = (oid: string | undefined): void => {
    if (oid === undefined || haveSet.size >= MAX_HAVES || !OID_RE.test(oid) || haveSet.has(oid)) return;
    haveSet.add(oid);
  };

  for (const ref of advert.refs) {
    addHave(ref.oid);
    addHave(ref.peeled);
    if (!inPushRefset(ref.name)) continue; // HEAD, refs/pull/*, refs/notes/* — never planned (§2.3)
    if (!validRefName(ref.name)) {
      throw new SmartHttpError(`mirror target advertises an invalid refname: ${ref.name.slice(0, 80)}`);
    }
    const ours = local.get(ref.name);
    if (ours === undefined) {
      // The remote has it, we do not → prune-delete (always-on, §2.3).
      if (options.allowDelete === true) plan.deletes.push({ ref: ref.name, old: ref.oid });
      else plan.skippedDeletes.push(ref.name);
      continue;
    }
    if (ours === ref.oid) continue; // identical — nothing to send
    plan.updates.push({ ref: ref.name, old: ref.oid, oid: ours });
  }

  for (const [name, ours] of local) {
    if (!inPushRefset(name)) continue; // never push refs/pull/* etc. (§2.3)
    if (advert.refs.some((r) => r.name === name)) continue;
    plan.creates.push({ ref: name, oid: ours });
  }

  for (const create of plan.creates) {
    if (!wantSet.has(create.oid)) {
      wantSet.add(create.oid);
      plan.wants.push(create.oid);
    }
  }
  for (const update of plan.updates) {
    if (!wantSet.has(update.oid)) {
      wantSet.add(update.oid);
      plan.wants.push(update.oid);
    }
  }
  plan.haves = [...haveSet];
  return plan;
}

/** The plan flattened into receive-pack update commands in command order
 *  (creates, updates, deletes — each with the wire's `old`/`new` fields). */
export function planCommands(plan: PushRefPlan): { old: string; next: string; ref: string }[] {
  const commands: { old: string; next: string; ref: string }[] = [];
  for (const create of plan.creates) commands.push({ old: ZERO_OID, next: create.oid, ref: create.ref });
  for (const update of plan.updates) commands.push({ old: update.old, next: update.oid, ref: update.ref });
  for (const del of plan.deletes) commands.push({ old: del.old, next: ZERO_OID, ref: del.ref });
  return commands;
}

// ---------------------------------------------------------------------------
// Step 4 — the receive-pack request body
// ---------------------------------------------------------------------------

/**
 * The command-section pkt-lines (gitprotocol-pack update-commands grammar):
 * capabilities ride the FIRST command after a NUL, the rest are bare
 * `<old> SP <new> SP <ref>`, terminated by a flush. Deletes-only requests
 * carry NO packfile after this section (§2.2 step 3 — the caller passes a
 * null pack stream). Exported for golden-bytes tests.
 */
export function buildReceivePackBody(commands: { old: string; next: string; ref: string }[]): Uint8Array {
  if (commands.length === 0) throw new SmartHttpError("a receive-pack request requires at least one command");
  const lines: Uint8Array[] = [];
  commands.forEach((cmd, i) => {
    if (!OID_RE.test(cmd.old) || !OID_RE.test(cmd.next)) {
      throw new SmartHttpError(`receive command for ${cmd.ref.slice(0, 60)} carries a non-40-hex oid`);
    }
    if (!validRefName(cmd.ref)) throw new SmartHttpError(`receive command carries an invalid refname: ${cmd.ref.slice(0, 80)}`);
    const line = i === 0 ? `${cmd.old} ${cmd.next} ${cmd.ref}\0${RECEIVE_PACK_CAPS}\n` : `${cmd.old} ${cmd.next} ${cmd.ref}\n`;
    lines.push(pkt(line));
  });
  lines.push(FLUSH_PKT);
  return lines.reduce((acc, part) => concatBytes(acc, part));
}

/** Prefix + stream, read sequentially — the pack is NEVER buffered (AGENTS.md
 *  streaming rule). Same composition as sync.ts's internal receive and the
 *  import channel: the composite carries no content-length, so the remote
 *  sees a chunked body (the engine's own receive path steers on that the
 *  same way). */
function prependStream(prefix: Uint8Array, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let sentPrefix = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentPrefix) {
        sentPrefix = true;
        controller.enqueue(prefix);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

// ---------------------------------------------------------------------------
// Step 5 — report-status (the SHARED parser; sync.ts imports this)
// ---------------------------------------------------------------------------

export interface ReceiveReport {
  unpackError: string | null;
  results: { ref: string; ok: boolean; message?: string }[];
}

/** Strict 4-hex pkt-line length (the engine's PktParser rules — the same
 *  local copy the pull sync and the import channel carry). */
function hex4(buf: Uint8Array, pos: number): number {
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const c = buf[pos + i];
    if (c === undefined) throw new SmartHttpError("bad pkt-line length in report-status");
    let d: number;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x57;
    else if (c >= 0x41 && c <= 0x5a) d = c - 0x37;
    else throw new SmartHttpError("bad pkt-line length in report-status");
    n = (n << 4) | d;
  }
  return n;
}

/**
 * Parse a report-status v0 body (gitprotocol-pack; the engine's renderStatus
 * shape): `unpack ok|<error>` then `ok <ref>` / `ng <ref> [<error>]` per
 * command, ending at the flush. `ng fetch first` = the remote moved between
 * advertisement and POST (TOCTOU, §6.4); `ng non-fast-forward` (or
 * server-specific text) = the remote refuses the update (§6.3). Accepts the
 * raw bytes or the buffered response.
 */
export function parseReportStatus(body: ArrayBuffer | Uint8Array): ReceiveReport {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const out: ReceiveReport = { unpackError: null, results: [] };
  let pos = 0;
  for (;;) {
    if (pos + 4 > bytes.length) break;
    const len = hex4(bytes, pos);
    pos += 4;
    if (len === 0) break; // flush: end of report
    if (len < 4 || pos + len - 4 > bytes.length) throw new SmartHttpError("truncated report-status from the mirror target");
    const line = TD.decode(bytes.subarray(pos, pos + len - 4)).trimEnd();
    pos += len - 4;
    if (line.startsWith("unpack ")) {
      const messageText = line.slice("unpack ".length);
      if (messageText !== "ok") out.unpackError = messageText;
      continue;
    }
    if (line.startsWith("ok ")) {
      out.results.push({ ref: line.slice(3), ok: true });
    } else if (line.startsWith("ng ")) {
      const rest = line.slice(3);
      const sp = rest.indexOf(" ");
      out.results.push(
        sp === -1 ? { ref: rest, ok: false } : { ref: rest.slice(0, sp), ok: false, message: rest.slice(sp + 1) },
      );
    }
  }
  return out;
}

/** One-line last_error summary of a rejected report (§6.5): the first few
 *  failed refs + the count, capped by the caller's settle truncation. */
export function describeReportFailure(report: ReceiveReport): string {
  const failed = report.results.filter((r) => !r.ok);
  if (report.unpackError !== null) return `unpack ${report.unpackError}`;
  const detail = failed
    .slice(0, 5)
    .map((r) => `${r.ref}${r.message === undefined ? "" : ` (${r.message})`}`)
    .join("; ");
  return failed.length > 5
    ? `${failed.length} ref(s) rejected: ${detail}; … (${failed.length} total)`
    : `${failed.length} ref(s) rejected: ${detail}`;
}

// ---------------------------------------------------------------------------
// Steps 4+5 — the POST
// ---------------------------------------------------------------------------

/**
 * POST `{remote}/git-receive-pack` (§2.2 step 4): `Content-Type:
 * application/x-git-receive-pack-request`, `Accept:
 * application/x-git-receive-pack-result`, body = command section + flush +
 * [pack stream] — streamed with `duplex: "half"`, never buffered. A
 * deletes-only request (null pack stream) sends the bare section with a
 * declared length. The response is parsed as report-status v0 (no
 * side-band-64k was requested — plain pkt-lines).
 *
 * Redirect posture (the shared runner): the stream body cannot be replayed,
 * so any 307/308 on the POST is a hard refusal — re-validated egress on
 * every hop still applies to the initial URL and to GET legs.
 */
export async function pushPack(
  repoUrl: string,
  commands: { old: string; next: string; ref: string }[],
  packStream: ReadableStream<Uint8Array> | null,
  options: GitClientOptions = {},
): Promise<ReceiveReport> {
  const base = sourceBase(repoUrl);
  const section = buildReceivePackBody(commands);
  const body = packStream === null ? section : prependStream(section, packStream);
  const response = await runRequest(
    new URL(`${base.toString()}/git-receive-pack`),
    {
      method: "POST",
      body,
      requestContentType: RECEIVE_PACK_REQUEST_CT,
      accept: RECEIVE_PACK_RESULT_CT,
      protocolHeader: false,
    },
    { ...options, expectContentType: RECEIVE_PACK_RESULT_CT, what: "git-receive-pack push", peerLabel: "mirror target" },
  );
  const reportBytes = await readCapped(
    responseBodyBytes(response),
    options.advertMaxBytes ?? ADVERT_MAX_BYTES,
    "report-status response",
  );
  return parseReportStatus(reportBytes);
}

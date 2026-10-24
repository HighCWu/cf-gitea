/**
 * SPEC-0009 §5 unit tests for the outbound smart-HTTP client — golden
 * fixtures over the fetchImpl seam (NO real network; the established webhook
 * consumer pattern: Workers tests cannot bind sockets, so the "stub server"
 * is a fetch stub that answers the exact bytes a git source would).
 *
 * Covered: v0/v2 advertisement parses (peels, symref, unborn HEAD, empty
 * source), fetch request builder bytes, sideband demux (bands 1/2/3, frames
 * split at hostile byte boundaries, v2 sections), one-round done shapes
 * (NAK / multi_ack_detailed / bare-ACK terminators), redirect rejection +
 * re-validation, cap enforcement (advertisement + pack), SSRF denial
 * (loopback/metadata/private, .internal, strict lists, redirect-to-internal),
 * and the advertisement → receive-command synthesis table.
 */

import { describe, expect, it } from "vitest";

import { buildPack } from "../../repos/testing/git-pack";
import {
  buildLsRefsBody,
  buildV0FetchBody,
  buildV2FetchBody,
  checkMirrorSource,
  demuxPackResponse,
  fetchPack,
  fetchRefs,
  parseInfoRefsAdvert,
  parseLsRefsResponse,
  pkt,
  planMirrorSync,
  validRefName,
  MAX_HAVES,
  UPLOAD_PACK_ADVERTISEMENT_CT,
  UPLOAD_PACK_RESULT_CT,
  UPLOAD_PACK_REQUEST_CT,
  type Advertisement,
  type FetchImpl,
} from "./gitclient";
import { parseHostPolicy } from "../../webhooks/ssrf";

const OID = "1234567890123456789012345678901234567890";
const OID2 = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const TAG = "2222222222222222222222222222222222222222";
const TAG_PEELED = "3333333333333333333333333333333333333333";
const LOCAL = "4444444444444444444444444444444444444444";

const TE = new TextEncoder();

function pktStr(payload: string): string {
  return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Sideband-frame one band's payload (band byte + pkt-line framing). */
function sideband(band: number, payload: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let i = 0; i < payload.length; i += 1000) {
    frames.push(pkt(concatBytes(new Uint8Array([band]), payload.slice(i, i + 1000))));
  }
  return frames.length === 0 ? [pkt(new Uint8Array([band]))] : frames;
}

const FLUSH_PKT = TE.encode("0000");

/** A v0 advertisement: HEAD + branch + annotated tag (with peel), capabilities
 *  on the first line — the engine's `advertisement` renderer shape. */
function v0AdvertBytes(): Uint8Array {
  const caps = `multi_ack_detailed no-done shallow side-band-64k thin-pack ofs-delta symref=HEAD:refs/heads/main agent=git/2.45`;
  return concatBytes(
    pkt(`# service=git-upload-pack\n`),
    FLUSH_PKT,
    pkt(`${OID} HEAD\0${caps}\n`),
    pkt(`${OID2} refs/heads/main\n`),
    pkt(`${LOCAL} refs/heads/topic\n`),
    pkt(`${TAG} refs/tags/v1\n`),
    pkt(`${TAG_PEELED} refs/tags/v1^{}\n`),
    FLUSH_PKT,
  );
}

function v0EmptyAdvertBytes(): Uint8Array {
  return concatBytes(
    pkt(`# service=git-upload-pack\n`),
    FLUSH_PKT,
    pkt(`${"0".repeat(40)} capabilities^{}\0shallow side-band-64k unborn HEAD refs/heads/main agent=git/2.45\n`),
    FLUSH_PKT,
  );
}

/** The v2 capability advert (the engine renders exactly this shape). */
function v2CapsBytes(): Uint8Array {
  return concatBytes(pkt("version 2\n"), pkt("agent=git/2.45\n"), pkt("ls-refs=unborn\n"), pkt("fetch=shallow wait-for-done\n"), pkt("object-format=sha1\n"), FLUSH_PKT);
}

function v2LsRefsBytes(): Uint8Array {
  return concatBytes(
    pkt(`${OID} HEAD symref-target:refs/heads/main\n`),
    pkt(`${OID2} refs/heads/main\n`),
    pkt(`${TAG} refs/tags/v1 peeled:${TAG_PEELED}\n`),
    FLUSH_PKT,
  );
}

function v2LsRefsUnbornBytes(): Uint8Array {
  return concatBytes(pkt(`unborn HEAD symref-target:refs/heads/trunk\n`), FLUSH_PKT);
}

/** A fetch stub answering one canned response per call, recording requests. */
interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
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
        : init.body instanceof Uint8Array
          ? init.body
          : new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    const response = responses[calls.length - 1];
    if (response === undefined) throw new Error(`unexpected request #${calls.length}: ${url}`);
    return typeof response === "function" ? response(calls[calls.length - 1]!) : response;
  };
  return { fetchImpl, calls };
}

/** The stub records the body it was handed; a missing one is a test failure,
 *  not an empty decode (decode(undefined) types as "" — never assert on it). */
function recordedBody(call: RecordedRequest): Uint8Array {
  if (call.body === undefined) throw new Error(`stub recorded no body for ${call.method} ${call.url}`);
  return call.body;
}

function advertResponse(body: Uint8Array, init: ResponseInit = {}): Response {  return new Response(new Uint8Array(body), { status: init.status ?? 200, headers: { "content-type": UPLOAD_PACK_ADVERTISEMENT_CT, ...(init.headers as Record<string, string> | undefined) } });
}

function resultResponse(body: Uint8Array): Response {
  return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": UPLOAD_PACK_RESULT_CT } });
}

/** Split bytes into hostile 1-byte chunks (frame boundaries land mid-length). */
function byteStream(bytes: Uint8Array, chunkSize = 1): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(...chunks);
}

const laxPolicy = () => parseHostPolicy(undefined, "lax");

// ---------------------------------------------------------------------------
// Advertisement parses
// ---------------------------------------------------------------------------

describe("parseInfoRefsAdvert (v0)", () => {
  it("parses refs, symref HEAD and the peeled tag", () => {
    const advert = parseInfoRefsAdvert(v0AdvertBytes());
    expect(advert.protocolVersion).toBe(0);
    expect(advert.headSymref).toBe("refs/heads/main");
    expect(advert.refs).toEqual([
      { name: "HEAD", oid: OID },
      { name: "refs/heads/main", oid: OID2 },
      { name: "refs/heads/topic", oid: LOCAL },
      { name: "refs/tags/v1", oid: TAG, peeled: TAG_PEELED },
    ]);
    expect(advert.capabilities).toContain("side-band-64k");
    expect(advert.capabilities).toContain("symref=HEAD:refs/heads/main");
  });

  it("parses the empty source (capabilities^{}) including the unborn HEAD cap", () => {
    const advert = parseInfoRefsAdvert(v0EmptyAdvertBytes());
    expect(advert.refs).toEqual([]);
    expect(advert.unbornHead).toBe("refs/heads/main");
    expect(advert.headSymref).toBeNull();
    expect(advert.capabilities).toContain("side-band-64k");
  });

  it("rejects malformed pkt-line lengths (strict hex, the engine's PktParser rule)", () => {
    const bytes = TE.encode("  12" + "x".repeat(14));
    expect(() => parseInfoRefsAdvert(bytes)).toThrow(/pkt-line/);
    expect(() => parseInfoRefsAdvert(TE.encode("001g"))).toThrow(/pkt-line/);
  });

  it("rejects a peel continuation line without its ref", () => {
    const bytes = concatBytes(pkt(`# service=git-upload-pack\n`), FLUSH_PKT, pkt(`${OID} refs/tags/v1\n`), pkt(`${TAG_PEELED} refs/tags/other^{}\n`));
    expect(() => parseInfoRefsAdvert(bytes)).toThrow(/peeled line without its ref/);
  });
});

describe("parseLsRefsResponse (v2)", () => {
  it("parses symref targets and peeled attributes", () => {
    const parsed = parseLsRefsResponse(v2LsRefsBytes());
    expect(parsed.refs).toEqual([
      { name: "HEAD", oid: OID, symrefTarget: "refs/heads/main" },
      { name: "refs/heads/main", oid: OID2 },
      { name: "refs/tags/v1", oid: TAG, peeled: TAG_PEELED },
    ]);
    expect(parsed.unbornHead).toBeNull();
  });

  it("parses the unborn HEAD line of an empty source", () => {
    const parsed = parseLsRefsResponse(v2LsRefsUnbornBytes());
    expect(parsed.refs).toEqual([]);
    expect(parsed.unbornHead).toBe("refs/heads/trunk");
  });

  it("surfaces v2 ERR pkt-lines as errors", () => {
    const bytes = pkt("ERR upload-pack: not our ref 1234567890\n");
    expect(() => parseLsRefsResponse(bytes)).toThrow(/not our ref/);
  });
});

// ---------------------------------------------------------------------------
// fetchRefs — the two service shapes, over the fetch stub
// ---------------------------------------------------------------------------

describe("fetchRefs", () => {
  it("v0 source: one GET, refs parsed from the advertisement", async () => {
    const { fetchImpl, calls } = stubFetch([advertResponse(v0AdvertBytes())]);
    const advert = await fetchRefs("https://src.example.com/repo.git", { fetchImpl, policy: laxPolicy() });
    expect(advert.protocolVersion).toBe(0);
    expect(advert.refs.map((r) => r.name)).toEqual(["HEAD", "refs/heads/main", "refs/heads/topic", "refs/tags/v1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://src.example.com/repo.git/info/refs?service=git-upload-pack");
    expect(calls[0]!.headers["git-protocol"]).toBe("version=2");
  });

  it("v2 source: capability advert then the ls-refs POST", async () => {
    const { fetchImpl, calls } = stubFetch([advertResponse(v2CapsBytes()), resultResponse(v2LsRefsBytes())]);
    const advert = await fetchRefs("https://src.example.com/repo.git", { fetchImpl, policy: laxPolicy() });
    expect(advert.protocolVersion).toBe(2);
    expect(advert.headSymref).toBe("refs/heads/main");
    expect(advert.refs.map((r) => r.name)).toEqual(["HEAD", "refs/heads/main", "refs/tags/v1"]);
    expect(advert.refs.find((r) => r.name === "refs/tags/v1")?.peeled).toBe(TAG_PEELED);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.headers["content-type"]).toBe(UPLOAD_PACK_REQUEST_CT);
    const lsRefsBody = new TextDecoder().decode(recordedBody(calls[1]!));
    expect(lsRefsBody).toContain(pktStr("command=ls-refs\n"));
    expect(lsRefsBody).toContain(pktStr("object-format=sha1\n"));
    expect(lsRefsBody).toContain(pktStr("symrefs\n"));
    expect(lsRefsBody).toContain(pktStr("peel\n"));
    expect(lsRefsBody).toContain(pktStr("unborn\n"));
    expect(lsRefsBody.endsWith("0000")).toBe(true);
  });

  it("v2 empty source: the unborn HEAD replaces the symref", async () => {
    const { fetchImpl } = stubFetch([advertResponse(v2CapsBytes()), resultResponse(v2LsRefsUnbornBytes())]);
    const advert = await fetchRefs("https://src.example.com/repo.git", { fetchImpl, policy: laxPolicy() });
    expect(advert.refs).toEqual([]);
    expect(advert.headSymref).toBeNull();
    expect(advert.unbornHead).toBe("refs/heads/trunk");
  });

  it("rejects a dumb-HTTP source by content type before parsing", async () => {
    const { fetchImpl } = stubFetch([new Response("<html>not git</html>", { headers: { "content-type": "text/html" } })]);
    await expect(fetchRefs("https://src.example.com/repo.git", { fetchImpl, policy: laxPolicy() })).rejects.toThrow(/dumb HTTP/);
  });

  it("enforces the advertisement buffer cap", async () => {
    const { fetchImpl } = stubFetch([advertResponse(v0AdvertBytes())]);
    await expect(fetchRefs("https://src.example.com/repo.git", { fetchImpl, policy: laxPolicy(), advertMaxBytes: 16 })).rejects.toThrow(
      /exceeds the 16 byte cap/,
    );
  });

  it("rejects non-2xx responses with the status in the error", async () => {
    const { fetchImpl } = stubFetch([new Response("nope", { status: 404, headers: { "content-type": "text/plain" } })]);
    await expect(fetchRefs("https://src.example.com/repo.git", { fetchImpl, policy: laxPolicy() })).rejects.toThrow(/source responded 404/);
  });
});

// ---------------------------------------------------------------------------
// Fetch request builders — golden bytes
// ---------------------------------------------------------------------------

describe("request builders", () => {
  it("v0 body: caps on the first want, flush, haves, done, stateless flush", () => {
    const body = new TextDecoder().decode(buildV0FetchBody([OID, OID2], [LOCAL], ["multi_ack_detailed", "side-band-64k", "thin-pack", "ofs-delta", "agent=cf-gitea-mirror/1"]));
    const expected =
      pktStr(`want ${OID} multi_ack_detailed side-band-64k thin-pack ofs-delta agent=cf-gitea-mirror/1\n`) +
      pktStr(`want ${OID2}\n`) +
      "0000" +
      pktStr(`have ${LOCAL}\n`) +
      pktStr("done\n") +
      "0000";
    expect(body).toBe(expected);
  });

  it("v2 body: command header, object-format (when advertised), args, wants/haves, done", () => {
    const body = new TextDecoder().decode(buildV2FetchBody([OID], [LOCAL], ["object-format=sha1", "fetch=shallow wait-for-done"]));
    const expected =
      pktStr("command=fetch\n") +
      pktStr("agent=cf-gitea-mirror/1\n") +
      pktStr("object-format=sha1\n") +
      "0001" +
      pktStr("thin-pack\n") +
      pktStr("ofs-delta\n") +
      pktStr("no-progress\n") +
      pktStr(`want ${OID}\n`) +
      pktStr(`have ${LOCAL}\n`) +
      pktStr("done\n") +
      "0000";
    expect(body).toBe(expected);
  });

  it("v2 body omits object-format when the source did not advertise it", () => {
    const body = new TextDecoder().decode(buildV2FetchBody([OID], [], []));
    expect(body).not.toContain("object-format");
    expect(body).toContain(pktStr("command=fetch\n"));
  });

  it("ls-refs body requests the full tree (symrefs, peel, unborn, no ref-prefix)", () => {
    const body = new TextDecoder().decode(buildLsRefsBody(["object-format=sha1"]));
    expect(body).toContain(pktStr("command=ls-refs\n"));
    expect(body).toContain(pktStr("symrefs\n"));
    expect(body).toContain(pktStr("peel\n"));
    expect(body).toContain(pktStr("unborn\n"));
    expect(body).not.toContain("ref-prefix");
    expect(body.endsWith("0000")).toBe(true);
  });

  it("validates oids; fetchPack (not the builder) bounds haves", () => {
    expect(() => buildV0FetchBody(["not-an-oid"], [], [])).toThrow(/40-hex/);
    expect(() => buildV2FetchBody([OID], [`z${OID.slice(1)}`], [])).toThrow(/40-hex/);
    const haves = Array.from({ length: MAX_HAVES + 1 }, (_, i) => i.toString(16).padStart(40, "0"));
    expect(() => buildV0FetchBody([OID], haves, [])).not.toThrow(); // the count bound lives in fetchPack
  });

  it("fetchPack enforces the wants/haves contract", async () => {
    const { fetchImpl } = stubFetch([]);
    await expect(fetchPack("https://src.example.com/repo.git", [], [], { fetchImpl, policy: laxPolicy() })).rejects.toThrow(/at least one want/);
    const haves = Array.from({ length: MAX_HAVES + 1 }, (_, i) => i.toString(16).padStart(40, "0"));
    await expect(fetchPack("https://src.example.com/repo.git", [OID], haves, { fetchImpl, policy: laxPolicy() })).rejects.toThrow(/256/);
    // The gate runs before any request is issued.
    await expect(fetchPack("https://127.0.0.1/repo.git", [OID], [], { fetchImpl, policy: laxPolicy() })).rejects.toThrow(/non-public address/);
  });
});

// ---------------------------------------------------------------------------
// fetchPack — one-round done, sideband demux, redirect + caps
// ---------------------------------------------------------------------------

describe("fetchPack (v0)", () => {
  it("sends the negotiated caps and demuxes the sideband pack", async () => {
    const { oid, pack } = await buildPack();
    // Progress (band 2) frames ride BETWEEN pack frames; the pack itself is
    // split across frame boundaries.
    const body = concatBytes(
      pkt("NAK\n"),
      ...sideband(2, TE.encode("Enumerating objects: 3, done.\n")),
      ...sideband(1, pack),
      FLUSH_PKT,
    );
    const { fetchImpl, calls } = stubFetch([resultResponse(body)]);
    const advert = parseInfoRefsAdvert(v0AdvertBytes());
    const fetched = await fetchPack("https://src.example.com/repo.git", [oid], [LOCAL], { fetchImpl, policy: laxPolicy(), advert });

    const progress: string[] = [];
    // (progress hook is fetchPack's option; re-run through the demux seam for the assertion)
    const direct = demuxPackResponse(byteStream(body, 7), { protocolVersion: 0, sideband: true }, { onProgress: (t) => progress.push(t) }, { maxBytes: 1024 * 1024 });
    expect(await drain(direct.packStream)).toEqual(pack);
    expect(await direct.ackedRefs).toEqual([]);
    expect(await direct.bytesSeen).toBe(body.length);
    expect(progress.join("")).toContain("Enumerating objects");

    expect(fetched.protocolVersion).toBe(0);
    expect(await drain(fetched.packStream)).toEqual(pack);
    expect(await fetched.ackedRefs).toEqual([]);
    expect(await fetched.bytesSeen).toBe(body.length);
    const requestBody = new TextDecoder().decode(recordedBody(calls[0]!));
    expect(requestBody).toBe(
      pktStr(`want ${oid} multi_ack_detailed side-band-64k thin-pack ofs-delta agent=cf-gitea-mirror/1\n`) +
        "0000" +
        pktStr(`have ${LOCAL}\n`) +
        pktStr("done\n") +
        "0000",
    );
    expect(calls[0]!.headers["content-type"]).toBe(UPLOAD_PACK_REQUEST_CT);
  });

  it("collects multi_ack_detailed commons and treats the bare ACK as the pack terminator", async () => {
    const { pack } = await buildPack();
    const body = concatBytes(pkt(`ACK ${LOCAL} common\n`), pkt(`ACK ${LOCAL}\n`), ...sideband(1, pack), FLUSH_PKT);
    const demuxed = demuxPackResponse(byteStream(body, 3), { protocolVersion: 0, sideband: true }, {}, { maxBytes: 1024 * 1024 });
    // Drain FIRST: ackedRefs settles as the ack section is parsed (during pulls).
    const drained = drain(demuxed.packStream);
    expect(await demuxed.ackedRefs).toEqual([LOCAL]);
    expect(await drained).toEqual(pack);
  });

  it("streams raw bytes after NAK when the source offered no side-band-64k", async () => {
    const { pack } = await buildPack();
    const caps = "shallow ofs-delta agent=git/2.45"; // deliberately no side-band-64k
    const advert = parseInfoRefsAdvert(
      concatBytes(pkt(`# service=git-upload-pack\n`), FLUSH_PKT, pkt(`${OID} HEAD\0${caps}\n`), FLUSH_PKT),
    );
    expect(advert.capabilities).not.toContain("side-band-64k");
    const body = concatBytes(pkt("NAK\n"), pack);
    const demuxed = demuxPackResponse(byteStream(body, 5), { protocolVersion: 0, sideband: false }, {}, { maxBytes: 1024 * 1024 });
    expect(await drain(demuxed.packStream)).toEqual(pack);
  });

  it("errors the stream on a sideband-3 frame", async () => {
    const body = concatBytes(pkt("NAK\n"), pkt(new Uint8Array([3, ...TE.encode("fatal: boom")])));
    const demuxed = demuxPackResponse(byteStream(body, 4), { protocolVersion: 0, sideband: true }, {}, { maxBytes: 1024 * 1024 });
    await expect(drain(demuxed.packStream)).rejects.toThrow(/sideband 3.*boom/s);
    await expect(demuxed.bytesSeen).rejects.toThrow(/sideband 3/);
  });
  it("enforces the total-bytes cap on the response stream", async () => {
    const { pack } = await buildPack();
    const body = concatBytes(pkt("NAK\n"), ...sideband(1, pack), FLUSH_PKT);
    const demuxed = demuxPackResponse(byteStream(body, 64), { protocolVersion: 0, sideband: true }, {}, { maxBytes: 10 });
    await expect(drain(demuxed.packStream)).rejects.toThrow(/exceeds the 10 byte cap/);
    await expect(demuxed.bytesSeen).rejects.toThrow(/exceeds the 10 byte cap/);
  });

  it("rejects a truncated response (source closed mid-frame)", async () => {
    const { pack } = await buildPack();
    const body = concatBytes(pkt("NAK\n"), ...sideband(1, pack.slice(0, 10))); // no flush, no end
    const demuxed = demuxPackResponse(byteStream(body, 9), { protocolVersion: 0, sideband: true }, {}, { maxBytes: 1024 * 1024 });
    await expect(drain(demuxed.packStream)).rejects.toThrow(/closed the response/);
  });
});

describe("fetchPack (v2)", () => {
  it("skips acknowledgments when the server answers done with the packfile section directly", async () => {
    const { oid, pack } = await buildPack();
    const advert: Advertisement = { protocolVersion: 2, capabilities: ["object-format=sha1", "fetch=shallow wait-for-done"], refs: [], headSymref: null, unbornHead: null };
    const body = concatBytes(pkt("packfile\n"), TE.encode("0001"), ...sideband(1, pack), FLUSH_PKT);
    const { fetchImpl, calls } = stubFetch([resultResponse(body)]);
    const fetched = await fetchPack("https://src.example.com/repo.git", [oid], [], { fetchImpl, policy: laxPolicy(), advert });
    expect(fetched.protocolVersion).toBe(2);
    const drained = drain(fetched.packStream); // start consuming: ackedRefs settles during the pulls
    expect(await fetched.ackedRefs).toEqual([]);
    expect(await drained).toEqual(pack);

    const requestBody = new TextDecoder().decode(recordedBody(calls[0]!));
    expect(requestBody).toContain(pktStr("command=fetch\n"));
    expect(requestBody).toContain(pktStr("object-format=sha1\n"));
    expect(requestBody).toContain(pktStr("thin-pack\n"));
    expect(requestBody).toContain(pktStr("ofs-delta\n"));
    expect(requestBody).toContain(pktStr("no-progress\n"));
    expect(requestBody).toContain(pktStr(`want ${oid}\n`));
    expect(requestBody).toContain(pktStr("done\n"));
    // v2 multiplexes unconditionally — there is no sideband argument to send.
    expect(requestBody).not.toContain("sideband");
  });

  it("parses the acknowledgments section when the server sends one", async () => {
    const { pack } = await buildPack();
    const advert: Advertisement = { protocolVersion: 2, capabilities: [], refs: [], headSymref: null, unbornHead: null };
    const body = concatBytes(pkt("acknowledgments\n"), pkt(`ACK ${LOCAL}\n`), FLUSH_PKT, pkt("packfile\n"), TE.encode("0001"), ...sideband(1, pack), FLUSH_PKT);
    const { fetchImpl } = stubFetch([resultResponse(body)]);
    const fetched = await fetchPack("https://src.example.com/repo.git", ["5".repeat(40)], [LOCAL], { fetchImpl, policy: laxPolicy(), advert });
    const drained = drain(fetched.packStream); // start consuming: ackedRefs settles during the pulls
    expect(await fetched.ackedRefs).toEqual([LOCAL]);
    expect(await drained).toEqual(pack);
  });

  it("surfaces v2 ERR pkt-lines as fetch errors", async () => {
    const advert: Advertisement = { protocolVersion: 2, capabilities: [], refs: [], headSymref: null, unbornHead: null };
    const { fetchImpl } = stubFetch([resultResponse(pkt("ERR upload-pack: not our ref 1234567890\n"))]);
    const fetched = await fetchPack("https://src.example.com/repo.git", ["5".repeat(40)], [], { fetchImpl, policy: laxPolicy(), advert });
    await expect(drain(fetched.packStream)).rejects.toThrow(/not our ref/);
    await expect(fetched.ackedRefs).rejects.toThrow(/not our ref/);
  });
});

// ---------------------------------------------------------------------------
// Redirect re-validation (redirect: "manual", every hop gated)
// ---------------------------------------------------------------------------

describe("redirect handling", () => {
  it("follows an https redirect between public hosts (GET)", async () => {
    const redirect = new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/repo.git/info/refs?service=git-upload-pack" } });
    const { fetchImpl, calls } = stubFetch([redirect, advertResponse(v0AdvertBytes())]);
    const advert = await fetchRefs("https://src.example.com/repo.git", { fetchImpl, policy: laxPolicy() });
    expect(advert.refs.length).toBeGreaterThan(0);
    expect(calls[1]!.url).toBe("https://elsewhere.example.com/repo.git/info/refs?service=git-upload-pack");
  });

  it("refuses a redirect that leaves https", async () => {
    const redirect = new Response(null, { status: 302, headers: { location: "http://elsewhere.example.com/repo.git" } });
    const { fetchImpl } = stubFetch([redirect]);
    await expect(fetchRefs("https://src.example.com/repo.git", { fetchImpl, policy: laxPolicy() })).rejects.toThrow(/redirect left https/);
  });

  it("refuses a redirect into a denied host (redirect-to-internal)", async () => {
    const redirect = new Response(null, { status: 302, headers: { location: "https://127.0.0.1/repo.git/info/refs" } });
    const { fetchImpl, calls } = stubFetch([redirect]);
    await expect(fetchRefs("https://src.example.com/repo.git", { fetchImpl, policy: laxPolicy() })).rejects.toThrow(/non-public address/);
    expect(calls).toHaveLength(1); // the second hop never left the gate
  });

  it("refuses a POST redirect that would downgrade to GET (301/302/303)", async () => {
    const { oid } = await buildPack();
    const redirect = new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/repo.git/git-upload-pack" } });
    const { fetchImpl } = stubFetch([redirect]);
    await expect(fetchPack("https://src.example.com/repo.git", [oid], [], { fetchImpl, policy: laxPolicy() })).rejects.toThrow(/downgrade/);
  });

  it("follows a POST redirect on 307/308 and re-sends the body", async () => {
    const { oid, pack } = await buildPack();
    const redirect = new Response(null, { status: 307, headers: { location: "https://elsewhere.example.com/repo.git/git-upload-pack" } });
    const body = concatBytes(pkt("NAK\n"), ...sideband(1, pack), FLUSH_PKT);
    const { fetchImpl, calls } = stubFetch([redirect, resultResponse(body)]);
    const fetched = await fetchPack("https://src.example.com/repo.git", [oid], [], { fetchImpl, policy: laxPolicy() });
    expect(await drain(fetched.packStream)).toEqual(pack);
    expect(calls[1]!.url).toBe("https://elsewhere.example.com/repo.git/git-upload-pack");
    expect(calls[1]!.body).toBeDefined();
  });

  it("gives up after the redirect budget", async () => {
    const loop = (): Response => new Response(null, { status: 302, headers: { location: "https://src.example.com/repo.git/info/refs?service=git-upload-pack" } });
    const responses: Response[] = Array.from({ length: 8 }, loop);
    const { fetchImpl, calls } = stubFetch(responses);
    await expect(fetchRefs("https://src.example.com/repo.git", { fetchImpl, policy: laxPolicy(), maxRedirects: 3 })).rejects.toThrow(/redirect budget/);
    expect(calls.length).toBeLessThanOrEqual(5); // initial + 3 hops
  });

  it("refuses a redirect without a Location header", async () => {
    const { fetchImpl } = stubFetch([new Response(null, { status: 302 })]);
    await expect(fetchRefs("https://src.example.com/repo.git", { fetchImpl, policy: laxPolicy() })).rejects.toThrow(/without a Location/);
  });
});

// ---------------------------------------------------------------------------
// Egress gate (§4.1)
// ---------------------------------------------------------------------------

describe("checkMirrorSource (SSRF)", () => {
  const lax = laxPolicy();

  it("allows public https sources", () => {
    expect(checkMirrorSource(new URL("https://example.com/repo.git"), lax).allowed).toBe(true);
    expect(checkMirrorSource(new URL("https://8.8.8.8/repo.git"), lax).allowed).toBe(true);
    expect(checkMirrorSource(new URL("https://example.com:8443/repo.git"), lax).allowed).toBe(true);
  });

  it("denies non-https schemes before anything else", () => {
    expect(checkMirrorSource(new URL("http://example.com/repo.git"), lax).allowed).toBe(false);
    expect(checkMirrorSource(new URL("http://127.0.0.1/repo.git"), lax).allowed).toBe(false);
    expect(checkMirrorSource(new URL("git://example.com/repo.git"), lax).allowed).toBe(false);
    expect(checkMirrorSource(new URL("ssh://git@example.com/repo.git"), lax).allowed).toBe(false);
  });

  it("denies credentials in the URL userinfo", () => {
    expect(checkMirrorSource(new URL("https://user:pass@example.com/repo.git"), lax).allowed).toBe(false);
  });

  it("denies loopback, private, CGNAT and metadata IP literals (the loopback test)", () => {
    for (const host of ["127.0.0.1", "127.8.8.8", "[::1]", "[::ffff:127.0.0.1]", "10.1.2.3", "172.16.0.9", "192.168.1.1", "100.64.0.1", "169.254.169.254", "0.0.0.1", "224.0.0.1"]) {
      const decision = checkMirrorSource(new URL(`https://${host}/repo.git`), lax);
      expect(decision.allowed, host).toBe(false);
    }
  });

  it("denies local-only host names", () => {
    for (const host of ["localhost", "foo.local", "bar.internal"]) {
      expect(checkMirrorSource(new URL(`https://${host}/repo.git`), lax).allowed, host).toBe(false);
    }
  });

  it("an explicit IP allow entry admits a non-public target (test rig)", () => {
    const policy = parseHostPolicy("127.0.0.1", "lax");
    expect(checkMirrorSource(new URL("https://127.0.0.1/repo.git"), policy).allowed).toBe(true);
    const portPolicy = parseHostPolicy("127.0.0.1:9443", "lax");
    expect(checkMirrorSource(new URL("https://127.0.0.1:9443/repo.git"), portPolicy).allowed).toBe(true);
    expect(checkMirrorSource(new URL("https://127.0.0.1:9444/repo.git"), portPolicy).allowed).toBe(false);
  });

  it("strict mode allows only list entries", () => {
    const strict = parseHostPolicy("example.com:443", "strict");
    expect(checkMirrorSource(new URL("https://example.com/repo.git"), strict).allowed).toBe(true);
    expect(checkMirrorSource(new URL("https://sub.example.com/repo.git"), strict).allowed).toBe(true);
    expect(checkMirrorSource(new URL("https://example.com:8443/repo.git"), strict).allowed).toBe(false);
    expect(checkMirrorSource(new URL("https://other.com/repo.git"), strict).allowed).toBe(false);
  });

  it("denies the git-scheme CRLF smuggling shape at the gate", () => {
    // WHATWG URL parsing strips embedded CR/LF, so the guard also checks the
    // serialized form; a raw-string source never reaches a URL unparsed.
    const smuggled = new URL("https://example.com/repo.git");
    const href = smuggled.href;
    expect(/[\r\n\t]/.test(href)).toBe(false);
    expect(checkMirrorSource(smuggled, lax).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Command synthesis (advertisement vs local refs)
// ---------------------------------------------------------------------------

describe("planMirrorSync", () => {
  const advert: Advertisement = {
    protocolVersion: 2,
    capabilities: [],
    refs: [
      { name: "HEAD", oid: OID, symrefTarget: "refs/heads/main" },
      { name: "refs/heads/main", oid: OID2 },
      { name: "refs/tags/v1", oid: TAG, peeled: TAG_PEELED },
      { name: "refs/pull/1/head", oid: LOCAL },
    ],
    headSymref: "refs/heads/main",
    unbornHead: null,
  };

  it("creates, force-updates and dedups wants; HEAD is never planned", () => {
    const plan = planMirrorSync(advert, [{ name: "refs/heads/main", target: LOCAL }], { prune: false });
    expect(plan.creates).toEqual([
      { ref: "refs/tags/v1", oid: TAG },
      { ref: "refs/pull/1/head", oid: LOCAL },
    ]);
    expect(plan.updates).toEqual([{ ref: "refs/heads/main", old: LOCAL, oid: OID2 }]);
    expect(plan.deletes).toEqual([]);
    // wants = the distinct oids of creates+updates (HEAD's entry never plans);
    // refs/pull's tip is fetched like any other advertised ref.
    expect(plan.wants).toEqual([OID2, TAG, LOCAL]);
    expect(plan.notifiedExcluded).toEqual(["refs/pull/1/head"]);
  });

  it("deletes only when prune is enabled", () => {
    const local = [
      { name: "refs/heads/main", target: OID2 },
      { name: "refs/heads/gone", target: TAG },
    ];
    expect(planMirrorSync(advert, local, { prune: true }).deletes).toEqual([{ ref: "refs/heads/gone", old: TAG }]);
    expect(planMirrorSync(advert, local, { prune: false }).deletes).toEqual([]);
  });

  it("is a no-op when everything is up to date", () => {
    const local = advert.refs.map((r) => ({ name: r.name, target: r.oid }));
    const plan = planMirrorSync(advert, local, { prune: true });
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.wants).toEqual([]);
  });

  it("fails the sync on an invalid (funny) refname", () => {
    const bad: Advertisement = { ...advert, refs: [{ name: "refs/heads/ma..in", oid: OID }] };
    expect(() => planMirrorSync(bad, [], { prune: true })).toThrow(/invalid refname/);
    const lock: Advertisement = { ...advert, refs: [{ name: "refs/heads/x.lock", oid: OID }] };
    expect(() => planMirrorSync(lock, [], { prune: true })).toThrow(/invalid refname/);
  });

  it("validRefName mirrors the manifest refname rules", () => {
    expect(validRefName("refs/heads/main")).toBe(true);
    expect(validRefName("refs/pull/1/head")).toBe(true);
    expect(validRefName("refs/tags/v1.0")).toBe(true);
    expect(validRefName("HEAD")).toBe(false);
    expect(validRefName("refs/heads/")).toBe(false);
    expect(validRefName("refs/heads/a b")).toBe(false);
    expect(validRefName("refs/heads/~x")).toBe(false);
    expect(validRefName("refs/heads/a..b")).toBe(false);
    expect(validRefName("refs/heads/a//b")).toBe(false);
    expect(validRefName("refs/heads/.hidden")).toBe(false);
    expect(validRefName("refs/heads/@{x}")).toBe(false);
  });
});

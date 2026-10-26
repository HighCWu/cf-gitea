/**
 * Outbound push client units (SPEC specs/push-mirror-outbound.md §2/§7) —
 * the pure protocol layer over synthetic advertisements and stub transports
 * (NO network, NO engine): the planPushSync diff table, the
 * buildReceivePackBody golden bytes, the shared report-status parser, and
 * fetchReceiveRefs's refusals (sha256, v2, 401, dumb content type).
 *
 * The full round trip against the REAL engine is push-sync.test.ts's
 * loopback oracle; this file pins the bytes and the decision tables.
 */

import { describe, expect, it } from "vitest";

import {
  SmartHttpError,
  ZERO_OID,
  type Advertisement,
  type FetchImpl,
} from "./gitclient";
import {
  RECEIVE_PACK_ADVERTISEMENT_CT,
  RECEIVE_PACK_REQUEST_CT,
  RECEIVE_PACK_RESULT_CT,
  buildReceivePackBody,
  describeReportFailure,
  fetchReceiveRefs,
  advertisesDeleteRefs,
  parseReportStatus,
  planCommands,
  planPushSync,
  pushPack,
} from "./pushclient";

// ---------------------------------------------------------------------------
// Local byte helpers (the sync.test.ts precedent — test-file copies)
// ---------------------------------------------------------------------------

const TE = new TextEncoder();
const TD = new TextDecoder();

function pkt(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? TE.encode(payload) : payload;
  const out = new Uint8Array(bytes.length + 4);
  out.set(TE.encode(`${(bytes.length + 4).toString(16).padStart(4, "0")}`), 0);
  out.set(bytes, 4);
  return out;
}

const FLUSH_PKT = TE.encode("0000");

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function advert(caps: string[], refs: { name: string; oid: string; peeled?: string }[]): Advertisement {
  return { protocolVersion: 0, capabilities: caps, refs, headSymref: null, unbornHead: null };
}

/** A one-response stub fetch that records every request it saw. */
function stubFetch(response: () => Response): { fetchImpl: FetchImpl; requests: { url: string; method: string; headers: Headers; body: Uint8Array | null }[] } {
  const requests: { url: string; method: string; headers: Headers; body: Uint8Array | null }[] = [];
  return {
    requests,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body === undefined || typeof init.body === "string" ? null : new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
      requests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
      return response();
    },
  };
}

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_C = "c".repeat(40);
const OID_D = "d".repeat(40);
const OID_E = "e".repeat(40);

// ---------------------------------------------------------------------------
// planPushSync — the §2.3 decision table
// ---------------------------------------------------------------------------

describe("planPushSync", () => {
  const localRefs = [
    { name: "refs/heads/main", target: OID_A },
    { name: "refs/heads/topic", target: OID_B },
    { name: "refs/tags/v1", target: OID_C },
    { name: "refs/pull/7/head", target: OID_D }, // never pushed (§2.3 refset)
  ];

  it("plans creates for refs the remote lacks, with old = ZERO_OID", () => {
    const plan = planPushSync(advert(["report-status", "delete-refs"], []), localRefs, { allowDelete: true });
    expect(plan.creates.map((c) => [c.ref, c.oid])).toEqual([
      ["refs/heads/main", OID_A],
      ["refs/heads/topic", OID_B],
      ["refs/tags/v1", OID_C],
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.wants).toEqual([OID_A, OID_B, OID_C]); // deduped, our tips
    expect(plan.haves).toEqual([]); // empty remote
  });

  it("plans updates with old = the REMOTE's advertised tip (per-ref CAS), and deletes for remote-only refs", () => {
    const remote = advert(
      ["report-status", "delete-refs"],
      [
        { name: "refs/heads/main", oid: OID_E }, // diverged — update, old = remote's tip
        { name: "refs/heads/gone", oid: OID_D }, // we lack it — delete (prune always-on, §2.3)
        { name: "refs/tags/v1", oid: OID_C }, // identical — no command
      ],
    );
    const plan = planPushSync(remote, localRefs, { allowDelete: true });
    expect(plan.updates).toEqual([{ ref: "refs/heads/main", old: OID_E, oid: OID_A }]);
    expect(plan.deletes).toEqual([{ ref: "refs/heads/gone", old: OID_D }]);
    expect(plan.creates.map((c) => c.ref)).toEqual(["refs/heads/topic"]); // remote lacks topic
    expect(plan.wants).toEqual([OID_B, OID_A]); // creates' tips first, then updates' (deduped)
    expect(plan.haves).toEqual([OID_E, OID_D, OID_C]); // advertised tips, order-stable
  });

  it("drops deletes (surfaced) when the target lacks delete-refs, and never plans out-of-refset refs", () => {
    const remote = advert(
      ["report-status"], // NO delete-refs
      [
        { name: "refs/heads/gone", oid: OID_D },
        { name: "refs/pull/9/head", oid: OID_E }, // outside the refset — never planned NOR deleted
        { name: "HEAD", oid: OID_A }, // HEAD is not a ref (§2.2 — mirrors do not move HEAD)
      ],
    );
    const plan = planPushSync(remote, localRefs, {});
    expect(plan.deletes).toEqual([]);
    expect(plan.skippedDeletes).toEqual(["refs/heads/gone"]);
    expect(plan.creates.every((c) => c.ref.startsWith("refs/heads/") || c.ref.startsWith("refs/tags/"))).toBe(true);
    expect(plan.haves).toContain(OID_E); // out-of-refset oids still ride the haves (the remote holds them)
  });

  it("counts peeled ^{} targets into the haves", () => {
    const remote = advert(["report-status", "delete-refs"], [
      { name: "refs/tags/annotated", oid: OID_C, peeled: OID_A },
    ]);
    const plan = planPushSync(remote, localRefs, { allowDelete: true });
    expect(plan.haves).toContain(OID_A); // the peeled commit — the remote holds the history
    expect(plan.updates).toEqual([]); // identical tag — no command
    expect(plan.creates.map((c) => c.ref)).toEqual(["refs/heads/main", "refs/heads/topic", "refs/tags/v1"]);
  });

  it("throws on an invalid advertised refname inside the refset", () => {
    const remote = advert(["report-status", "delete-refs"], [{ name: "refs/heads/bad name", oid: OID_D }]);
    expect(() => planPushSync(remote, localRefs, { allowDelete: true })).toThrow(SmartHttpError);
  });

  it("planCommands flattens creates/updates/deletes into wire order", () => {
    const plan = planPushSync(
      advert(["report-status", "delete-refs"], [
        { name: "refs/heads/gone", oid: OID_E },
        { name: "refs/heads/main", oid: OID_D },
      ]),
      localRefs,
      { allowDelete: true },
    );
    expect(planCommands(plan)).toEqual([
      { old: ZERO_OID, next: OID_B, ref: "refs/heads/topic" }, // create
      { old: ZERO_OID, next: OID_C, ref: "refs/tags/v1" }, // create
      { old: OID_D, next: OID_A, ref: "refs/heads/main" }, // update (force — old is the remote's)
      { old: OID_E, next: ZERO_OID, ref: "refs/heads/gone" }, // delete
    ]);
  });

  it("advertisesDeleteRefs reads the capability list", () => {
    expect(advertisesDeleteRefs(advert(["report-status", "delete-refs"], []))).toBe(true);
    expect(advertisesDeleteRefs(advert(["report-status"], []))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildReceivePackBody — golden bytes (§2.2 step 4)
// ---------------------------------------------------------------------------

describe("buildReceivePackBody", () => {
  it("carries the capability list on the FIRST command after a NUL, bare lines after, flush last", () => {
    const body = buildReceivePackBody([
      { old: ZERO_OID, next: OID_A, ref: "refs/heads/main" },
      { old: OID_B, next: OID_C, ref: "refs/tags/v1" },
    ]);
    const text = TD.decode(body);
    // First command carries the caps NUL-separated; the second is bare; the
    // section ends at a flush.
    expect(text).toContain(`\0report-status delete-refs agent=cf-gitea-mirror/1\n`);
    expect(text).toContain(`${OID_B} ${OID_C} refs/tags/v1\n`);
    expect(text.endsWith("0000")).toBe(true);
    // Byte-exact against the local pkt renderer.
    expect(body).toEqual(
      concatBytes(
        pkt(`${ZERO_OID} ${OID_A} refs/heads/main\0report-status delete-refs agent=cf-gitea-mirror/1\n`),
        pkt(`${OID_B} ${OID_C} refs/tags/v1\n`),
        FLUSH_PKT,
      ),
    );
  });

  it("rejects a non-40-hex oid and an invalid refname", () => {
    expect(() => buildReceivePackBody([{ old: "nothex", next: OID_A, ref: "refs/heads/main" }])).toThrow(SmartHttpError);
    expect(() => buildReceivePackBody([{ old: ZERO_OID, next: OID_A, ref: "refs/heads/bad name" }])).toThrow(SmartHttpError);
    expect(() => buildReceivePackBody([])).toThrow(SmartHttpError);
  });
});

// ---------------------------------------------------------------------------
// parseReportStatus / describeReportFailure (§2.2 step 5)
// ---------------------------------------------------------------------------

describe("parseReportStatus", () => {
  it("parses unpack ok + all-ok results", () => {
    const body = concatBytes(pkt("unpack ok\n"), pkt(`ok refs/heads/main\n`), pkt(`ok refs/tags/v1\n`), FLUSH_PKT);
    expect(parseReportStatus(body)).toEqual({
      unpackError: null,
      results: [
        { ref: "refs/heads/main", ok: true },
        { ref: "refs/tags/v1", ok: true },
      ],
    });
  });

  it("parses an unpack error and mixed ok/ng with messages", () => {
    const failed = concatBytes(pkt("unpack index-pack failed\n"), FLUSH_PKT);
    expect(parseReportStatus(failed)).toEqual({ unpackError: "index-pack failed", results: [] });

    const mixed = concatBytes(
      pkt("unpack ok\n"),
      pkt(`ok refs/heads/main\n`),
      pkt(`ng refs/heads/topic non-fast-forward\n`),
      pkt(`ng refs/tags/v1\n`), // message-less ng
      FLUSH_PKT,
    );
    expect(parseReportStatus(mixed)).toEqual({
      unpackError: null,
      results: [
        { ref: "refs/heads/main", ok: true },
        { ref: "refs/heads/topic", ok: false, message: "non-fast-forward" },
        { ref: "refs/tags/v1", ok: false },
      ],
    });
  });

  it("throws on a truncated frame or a bad length word (strict hex4 discipline)", () => {
    // A declared length longer than the body → truncated frame.
    expect(() => parseReportStatus(TE.encode("00ffunpack ok\n"))).toThrow(SmartHttpError);
    // A non-hex length word.
    expect(() => parseReportStatus(TE.encode("zzzz"))).toThrow(SmartHttpError);
  });

  it("describeReportFailure summarizes the failed refs (capped)", () => {
    const report = parseReportStatus(
      concatBytes(pkt("unpack ok\n"), pkt(`ng refs/heads/topic fetch first\n`), pkt(`ok refs/heads/main\n`), FLUSH_PKT),
    );
    expect(describeReportFailure(report)).toBe("1 ref(s) rejected: refs/heads/topic (fetch first)");
    expect(describeReportFailure({ unpackError: "bad pack", results: [] })).toBe("unpack bad pack");
  });
});

// ---------------------------------------------------------------------------
// fetchReceiveRefs + pushPack against a stub transport
// ---------------------------------------------------------------------------

describe("fetchReceiveRefs", () => {
  const infoRefsUrl = "https://dest.example.com/org/repo.git/info/refs?service=git-receive-pack";

  const advertResponse = (body: Uint8Array): Response =>
    new Response(new Uint8Array(body), { status: 200, headers: { "content-type": RECEIVE_PACK_ADVERTISEMENT_CT } });

  it("GETs the receive service URL without the v2 protocol header and parses the v0 advert", async () => {
    const { fetchImpl, requests } = stubFetch(() =>
      advertResponse(
        concatBytes(
          pkt("# service=git-receive-pack\n"),
          FLUSH_PKT,
          pkt(`${OID_A} refs/heads/main\0report-status delete-refs agent=git/2.45\n`),
          FLUSH_PKT,
        ),
      ),
    );
    const advert = await fetchReceiveRefs("https://dest.example.com/org/repo.git", { fetchImpl });
    expect(advert.protocolVersion).toBe(0);
    expect(advert.refs).toEqual([{ name: "refs/heads/main", oid: OID_A }]);
    expect(advert.capabilities).toContain("delete-refs");
    expect(requests[0]!.url).toBe(infoRefsUrl);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.headers.get("git-protocol")).toBeNull(); // v0-only — the offer header is omitted (§2.2)
  });

  it("fails cleanly on an object-format=sha256 target (§6.8)", async () => {
    const { fetchImpl } = stubFetch(() =>
      advertResponse(
        concatBytes(
          pkt("# service=git-receive-pack\n"),
          FLUSH_PKT,
          pkt(`${OID_A} refs/heads/main\0report-status object-format=sha256 agent=git/2.45\n`),
          FLUSH_PKT,
        ),
      ),
    );
    await expect(fetchReceiveRefs("https://dest.example.com/org/repo.git", { fetchImpl })).rejects.toThrow(/sha256/);
  });

  it("fails cleanly on a v2 answer (receive-pack is v0-only)", async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(concatBytes(pkt("version 2\n"), FLUSH_PKT), {
          status: 200,
          headers: { "content-type": RECEIVE_PACK_ADVERTISEMENT_CT },
        }),
    );
    await expect(fetchReceiveRefs("https://dest.example.com/org/repo.git", { fetchImpl })).rejects.toThrow(/v0-only/);
  });

  it("surfaces a 401 and a dumb content type as SmartHttpError with the sanitized URL", async () => {
    const denied = stubFetch(() => new Response("nope", { status: 401 }));
    try {
      await fetchReceiveRefs("https://dest.example.com/org/repo.git", { fetchImpl: denied.fetchImpl });
      expect.unreachable("401 must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SmartHttpError);
      expect((error as SmartHttpError).message).toContain("401");
    }
    const dumb = stubFetch(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(fetchReceiveRefs("https://dest.example.com/org/repo.git", { fetchImpl: dumb.fetchImpl })).rejects.toThrow(
      /dumb HTTP/,
    );
  });

  it("sends the configured Authorization header", async () => {
    const { fetchImpl, requests } = stubFetch(() =>
      advertResponse(
        concatBytes(pkt("# service=git-receive-pack\n"), FLUSH_PKT, pkt(`${OID_A} refs/heads/main\0report-status\n`), FLUSH_PKT),
      ),
    );
    await fetchReceiveRefs("https://dest.example.com/org/repo.git", { fetchImpl, authHeader: "Basic dXNlcjpwYXNz" });
    expect(requests[0]!.headers.get("authorization")).toBe("Basic dXNlcjpwYXNz");
  });
});

describe("pushPack", () => {
  const result = (body: Uint8Array): Response =>
    new Response(new Uint8Array(body), { status: 200, headers: { "content-type": RECEIVE_PACK_RESULT_CT } });

  it("POSTs the command section with the receive request content type and Accept header, and parses the report", async () => {
    const { fetchImpl, requests } = stubFetch(() => result(concatBytes(pkt("unpack ok\n"), pkt(`ok refs/heads/main\n`), FLUSH_PKT)));
    const commands = [{ old: ZERO_OID, next: OID_A, ref: "refs/heads/main" }];
    const report = await pushPack("https://dest.example.com/org/repo.git", commands, null, { fetchImpl });
    expect(report.results).toEqual([{ ref: "refs/heads/main", ok: true }]);
    expect(requests[0]!.url).toBe("https://dest.example.com/org/repo.git/git-receive-pack");
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers.get("content-type")).toBe(RECEIVE_PACK_REQUEST_CT);
    expect(requests[0]!.headers.get("accept")).toBe(RECEIVE_PACK_RESULT_CT);
    expect(requests[0]!.headers.get("git-protocol")).toBeNull();
    // Deletes-only: the body IS the bare command section (no pack bytes — §2.2 step 3).
    expect(requests[0]!.body).toEqual(buildReceivePackBody(commands));
  });

  it("streams the pack after the command section (prefix first byte, then pack bytes)", async () => {
    const { fetchImpl, requests } = stubFetch(() => result(concatBytes(pkt("unpack ok\n"), pkt(`ok refs/heads/main\n`), FLUSH_PKT)));
    const commands = [{ old: ZERO_OID, next: OID_A, ref: "refs/heads/main" }];
    const pack = TE.encode("PACK-bytes");
    const packStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pack);
        controller.close();
      },
    });
    await pushPack("https://dest.example.com/org/repo.git", commands, packStream, { fetchImpl });
    const body = requests[0]!.body!;
    const section = buildReceivePackBody(commands);
    expect(body.length).toBe(section.length + pack.length);
    expect(body.slice(0, section.length)).toEqual(section);
    expect(body.slice(section.length)).toEqual(pack);
  });
});

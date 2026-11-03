/**
 * The serve-content unit battery (parity review D-6): the packages arm of
 * upstream's ctx.ServeContent — base.go:186-190 = ServeSetHeaders +
 * net/http ServeContent's precondition/range subset. CONSOLIDATED onto the
 * shared serve pipeline (src/web/attachments-serving.ts, GP's serve.go
 * port): the header set rides `serveSetHeaders`, the disposition encoding
 * rides `encodeContentDisposition` + `goPathBase` — this battery pins that
 * the PACKAGES path carries the SAME decision table (the equivalence pin),
 * plus the byte shapes of upstream's own TestContentDisposition
 * (modules/httplib/content_disposition_test.go) attachment-flavored, byte for
 * byte. MOVED PINS (the consolidation): the plain-object header keys are the
 * canonical MIME spellings the shared table emits — Go writes exactly those
 * via header.Set (serve.go:59-104); the wire is unchanged (Headers
 * normalize). The conditional/range arms pin Go's checkPreconditions +
 * parseRange wire shapes (the ETag-less package file: only `If-None-Match: *`
 * matches), including the strict Go time.Parse date validation (a rolled
 * "31 Feb" must not 304/412) and the empty-If-None-Match gate.
 */

import { describe, expect, it } from "vitest";

import { encodeContentDisposition, goPathBase, serveSetHeaders } from "../../web/attachments-serving";
import { planByteServing, serveFileHeaderSet, servePackageFileResponse, sliceByteRange } from "./serve-content";

const CREATED = new Date("2026-10-29T12:00:00Z");
const CREATED_RFC1123 = "Thu, 29 Oct 2026 12:00:00 GMT";
const request = (headers: Record<string, string> = {}, method = "GET"): Request =>
  new Request("https://example.com/x", { method, headers });

// ---------------------------------------------------------------------------
// the shared disposition through the packages path — content_disposition.go
// (the upstream TestContentDisposition table), byte-identical to the former
// private copy
// ---------------------------------------------------------------------------

describe("encodeContentDisposition attachment word (the upstream TestContentDisposition table)", () => {
  it("renders token-safe names bare and leaves ASCII names twin-free", () => {
    expect(encodeContentDisposition("attachment", goPathBase("test.txt"))).toBe("attachment; filename=test.txt");
    expect(encodeContentDisposition("attachment", goPathBase("mytool-1.0.0.tar.gz"))).toBe(
      "attachment; filename=mytool-1.0.0.tar.gz",
    );
    expect(encodeContentDisposition("attachment", goPathBase('"test.txt'))).toBe(
      'attachment; filename="\\"test.txt"',
    );
    expect(encodeContentDisposition("attachment", goPathBase("hello\tworld.txt"))).toBe(
      'attachment; filename="hello\tworld.txt"',
    );
  });

  it("pairs the safe name with the RFC 5987 filename* twin for non-ASCII names", () => {
    expect(encodeContentDisposition("attachment", goPathBase("test❌.txt"))).toBe(
      "attachment; filename=test_.txt; filename*=utf-8''test%E2%9D%8C.txt",
    );
    expect(encodeContentDisposition("attachment", goPathBase("test ❌.txt"))).toBe(
      'attachment; filename="test _.txt"; filename*=utf-8\'\'test%20%E2%9D%8C.txt',
    );
    // The unicode-name package shape from the review gate: `ü` → `_` quoted-side,
    // pct-encoded twin over the UTF-8 bytes (uppercase hex).
    expect(encodeContentDisposition("attachment", goPathBase("nü-tool-1.0.pkg"))).toBe(
      "attachment; filename=n_-tool-1.0.pkg; filename*=utf-8''n%C3%BC-tool-1.0.pkg",
    );
  });

  it("encodes control runes and keeps the quoted tab verbatim", () => {
    expect(encodeContentDisposition("attachment", goPathBase("hello\nworld.txt"))).toBe(
      "attachment; filename=hello_world.txt; filename*=utf-8''hello%0Aworld.txt",
    );
    expect(encodeContentDisposition("attachment", goPathBase("hello\rworld.txt"))).toBe(
      "attachment; filename=hello_world.txt; filename*=utf-8''hello%0Dworld.txt",
    );
  });

  it("percent-encodes every non-attr-char byte, uppercase hex", () => {
    // The safe name still carries spaces/colons → the quoted form; the twin
    // encodes the ORIGINAL runes.
    expect(encodeContentDisposition("attachment", goPathBase("café steep: ü.pkg"))).toBe(
      'attachment; filename="caf_ steep: _.pkg"; filename*=utf-8\'\'caf%C3%A9%20steep%3A%20%C3%BC.pkg',
    );
    expect(encodeContentDisposition("attachment", goPathBase("del\u007f.txt"))).toBe(
      "attachment; filename=del_.txt; filename*=utf-8''del%7F.txt",
    );
  });

  it("carries the consolidation's drift closures the former private copy lacked", () => {
    // Go's RFC 2045 bitmap EXCLUDES { } from the token set (grammar.go — the
    // printable non-tspecials c1d91fd's shared-port fix pinned) → the
    // quoted-string arm; the former packages copy bare-tokened them.
    expect(encodeContentDisposition("attachment", goPathBase("a{b}.txt"))).toBe(
      'attachment; filename="a{b}.txt"',
    );
    expect(encodeContentDisposition("attachment", goPathBase("{leading}.bin"))).toBe(
      'attachment; filename="{leading}.bin"',
    );
    // The RFC 2231 ext-value is an attr-char walk: '*', "'" and '%' are
    // NOT attr-chars (content_disposition.go's byte checks) — the former
    // copy's isTokenChar-based walk kept them raw. The safe names stay
    // bare tokens ('*', "'", '%' are IN Go's token bitmap).
    expect(encodeContentDisposition("attachment", goPathBase("a*b✓.txt"))).toBe(
      "attachment; filename=a*b_.txt; filename*=utf-8''a%2Ab%E2%9C%93.txt",
    );
    expect(encodeContentDisposition("attachment", goPathBase("it's✓.txt"))).toBe(
      "attachment; filename=it's_.txt; filename*=utf-8''it%27s%E2%9C%93.txt",
    );
    expect(encodeContentDisposition("attachment", goPathBase("50%✓.txt"))).toBe(
      "attachment; filename=50%_.txt; filename*=utf-8''50%25%E2%9C%93.txt",
    );
    // path.Base cuts at the serve site (serve.go:92) — a slash-carrying name
    // serves its final element (the former copy's lastIndexOf reduction
    // agrees here; goPathBase also carries Go's trailing-slash/'' edges).
    expect(encodeContentDisposition("attachment", goPathBase("pkg/dir/kit-1.0.tgz"))).toBe(
      "attachment; filename=kit-1.0.tgz",
    );
  });
});

// ---------------------------------------------------------------------------
// serveFileHeaderSet — the shared ServeSetHeaders table (serve.go:56-105 +
// httpcache.go:23-38) fed with the packages inputs
// ---------------------------------------------------------------------------

describe("serveFileHeaderSet", () => {
  it("mounts the full upstream set for a named file", () => {
    const headers = serveFileHeaderSet({ filename: "test.txt", size: 7, created: CREATED });
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Content-Security-Policy"]).toBe("sandbox allow-scripts allow-modals allow-popups allow-downloads");
    expect(headers["Cache-Control"]).toBe("max-age=0, private, must-revalidate");
    expect(headers["Content-Length"]).toBe("7");
    expect(headers["Last-Modified"]).toBe(CREATED_RFC1123);
    expect(headers["Content-Disposition"]).toBe("attachment; filename=test.txt");
    expect(headers["Access-Control-Expose-Headers"]).toBe("Content-Disposition");
  });

  it("IS the shared table's output — the consolidation equivalence pin", () => {
    // The packages path rides attachments-serving's serveSetHeaders verbatim;
    // this pin makes any future drift between the seams a test failure.
    expect(serveFileHeaderSet({ filename: "pkg.bin", size: 7, created: CREATED })).toEqual(
      serveSetHeaders({ filename: "pkg.bin", contentLength: 7, lastModified: CREATED }),
    );
    // The registry's Content-Type override (maven's jar, swift's
    // text/x-swift, the key arms' pgp-keys) is the same table's type entry.
    expect(serveFileHeaderSet({ filename: "k.pkg", size: 1, created: CREATED, contentType: "application/pgp-keys" })).toEqual(
      serveSetHeaders({ filename: "k.pkg", contentLength: 1, lastModified: CREATED, contentType: "application/pgp-keys" }),
    );
  });

  it("omits the disposition and the expose echo when no filename rides (maven HEAD)", () => {
    const headers = serveFileHeaderSet({ size: 7, created: CREATED, contentType: "application/java-archive" });
    expect(headers["Content-Type"]).toBe("application/java-archive");
    expect(headers["Content-Disposition"]).toBeUndefined();
    expect(headers["Access-Control-Expose-Headers"]).toBeUndefined();
    expect(headers["Cache-Control"]).toBe("max-age=0, private, must-revalidate");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("branches the CSP on the content type (pdf variant, audio/video bare)", () => {
    expect(serveFileHeaderSet({ size: 1, created: CREATED, contentType: "application/pdf" })["Content-Security-Policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(
      serveFileHeaderSet({ size: 1, created: CREATED, contentType: "audio/mpeg" })["Content-Security-Policy"],
    ).toBeUndefined();
    expect(
      serveFileHeaderSet({ size: 1, created: CREATED, contentType: "video/mp4" })["Content-Security-Policy"],
    ).toBeUndefined();
  });

  it("cuts the disposition through path.Base (serve.go:92)", () => {
    expect(
      serveFileHeaderSet({ filename: "a/b/kit-1.0.tgz", size: 1, created: CREATED })["Content-Disposition"],
    ).toBe("attachment; filename=kit-1.0.tgz");
  });

  it("omits Last-Modified when no created rides (the key arms' zero-modtime posture)", () => {
    // The debian.go:38-41 / alpine.go:57-60 / rpm.go:62-65 / arch.go:38-40
    // key arms, the chef .priv download and rubygems' SetServeHeaders pair
    // pass no LastModified — setLastModified's isZeroTime skips the header.
    const headers = serveFileHeaderSet({
      filename: "repository.key",
      contentType: "application/pgp-keys",
      size: 5,
    });
    expect(headers["Last-Modified"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/pgp-keys");
    expect(headers["Cache-Control"]).toBe("max-age=0, private, must-revalidate");
    expect(headers["Content-Length"]).toBe("5");
  });
});

// ---------------------------------------------------------------------------
// planByteServing — net/http checkPreconditions + parseRange
// ---------------------------------------------------------------------------

describe("planByteServing", () => {
  const serve = { kind: "serve", status: 200, start: 0, length: 10, contentRange: null } as const;

  it("serves the full body without conditionals", () => {
    expect(planByteServing(request(), 10, CREATED)).toEqual(serve);
  });

  it("304s on If-Modified-Since at or after the modtime (second granularity)", () => {
    expect(planByteServing(request({ "If-Modified-Since": CREATED_RFC1123 }), 10, CREATED)).toEqual({
      kind: "not-modified",
    });
    expect(
      planByteServing(request({ "If-Modified-Since": "Fri, 30 Oct 2026 00:00:00 GMT" }), 10, CREATED),
    ).toEqual({ kind: "not-modified" });
    expect(
      planByteServing(request({ "If-Modified-Since": "Wed, 28 Oct 2026 00:00:00 GMT" }), 10, CREATED),
    ).toEqual(serve);
    expect(planByteServing(request({ "If-Modified-Since": "not a date" }), 10, CREATED)).toEqual(serve);
  });

  it("dates are Go time.Parse-strict — a rolled '31 Feb' must not 304/412", () => {
    // JS Date.parse rolls Feb 31 into March; Go time.Parse errors and the
    // precondition is ignored (condNone) — serve 200 in every arm.
    expect(planByteServing(request({ "If-Modified-Since": "Wed, 31 Feb 2024 00:00:00 GMT" }), 10, CREATED)).toEqual(
      serve,
    );
    expect(planByteServing(request({ "If-Unmodified-Since": "Wed, 31 Feb 2024 00:00:00 GMT" }), 10, CREATED)).toEqual(
      serve,
    );
    // A garbage If-Range date drops the range (Go's checkIfRange condNone).
    expect(planByteServing(request({ Range: "bytes=2-", "If-Range": "Wed, 31 Feb 2024 00:00:00 GMT" }), 10, CREATED)).toEqual(
      serve,
    );
    // Out-of-range day/time components fail the same way.
    expect(planByteServing(request({ "If-Modified-Since": "Thu, 00 Oct 2026 00:00:00 GMT" }), 10, CREATED)).toEqual(
      serve,
    );
    expect(planByteServing(request({ "If-Modified-Since": "Thu, 29 Oct 2026 24:00:00 GMT" }), 10, CREATED)).toEqual(
      serve,
    );
  });

  it("If-None-Match: * matches the ETag-less file; specific tags never do", () => {
    expect(planByteServing(request({ "If-None-Match": "*" }), 10, CREATED)).toEqual({ kind: "not-modified" });
    expect(planByteServing(request({ "If-None-Match": `"abc"` }), 10, CREATED)).toEqual(serve);
    expect(planByteServing(request({ "If-None-Match": `"abc", *` }), 10, CREATED)).toEqual({ kind: "not-modified" });
    // A match on a non-GET/HEAD is the 412 arm.
    expect(planByteServing(request({ "If-None-Match": "*" }, "POST"), 10, CREATED)).toEqual({
      kind: "precondition-failed",
    });
  });

  it("an EMPTY-valued If-None-Match still consults If-Modified-Since (Header.Get semantics)", () => {
    // The shared pipeline's gate (GP's predecessor-defect fix, httpcache.go
    // :102-104) on the packages path: Header.Get reports an empty value as
    // "" — indistinguishable from absent on the IMS gate.
    expect(
      planByteServing(request({ "If-None-Match": "", "If-Modified-Since": CREATED_RFC1123 }), 10, CREATED),
    ).toEqual({ kind: "not-modified" });
  });

  it("a present If-None-Match suppresses If-Modified-Since (RFC 7232 §6)", () => {
    expect(
      planByteServing(request({ "If-None-Match": `"nope"`, "If-Modified-Since": CREATED_RFC1123 }), 10, CREATED),
    ).toEqual(serve);
  });

  it("If-Match: * passes, any tag fails against no ETag; If-Unmodified-Since backs it", () => {
    expect(planByteServing(request({ "If-Match": "*" }), 10, CREATED)).toEqual(serve);
    expect(planByteServing(request({ "If-Match": `"abc"` }), 10, CREATED)).toEqual({ kind: "precondition-failed" });
    expect(planByteServing(request({ "If-Unmodified-Since": CREATED_RFC1123 }), 10, CREATED)).toEqual(serve);
    expect(
      planByteServing(request({ "If-Unmodified-Since": "Wed, 28 Oct 2026 00:00:00 GMT" }), 10, CREATED),
    ).toEqual({ kind: "precondition-failed" });
    // If-Match wins over If-Unmodified-Since.
    expect(
      planByteServing(
        request({ "If-Match": "*", "If-Unmodified-Since": "Wed, 28 Oct 2026 00:00:00 GMT" }),
        10,
        CREATED,
      ),
    ).toEqual(serve);
  });

  it("single ranges 206 with Content-Range; suffix and open-ended forms included", () => {
    expect(planByteServing(request({ Range: "bytes=2-5" }), 10, CREATED)).toEqual({
      kind: "serve",
      status: 206,
      start: 2,
      length: 4,
      contentRange: "bytes 2-5/10",
    });
    expect(planByteServing(request({ Range: "bytes=4-" }), 10, CREATED)).toEqual({
      kind: "serve",
      status: 206,
      start: 4,
      length: 6,
      contentRange: "bytes 4-9/10",
    });
    expect(planByteServing(request({ Range: "bytes=-3" }), 10, CREATED)).toEqual({
      kind: "serve",
      status: 206,
      start: 7,
      length: 3,
      contentRange: "bytes 7-9/10",
    });
    expect(planByteServing(request({ Range: "bytes=0-999" }), 10, CREATED)).toEqual({
      kind: "serve",
      status: 206,
      start: 0,
      length: 10,
      contentRange: "bytes 0-9/10",
    });
  });

  it("non-overlapping ranges 416 with the */size Content-Range; garbage 416 without", () => {
    expect(planByteServing(request({ Range: "bytes=10-" }), 10, CREATED)).toEqual({
      kind: "range-unsatisfiable",
      contentRange: "bytes */10",
      message: "invalid range: failed to overlap",
    });
    expect(planByteServing(request({ Range: "zap=1-2" }), 10, CREATED)).toEqual({
      kind: "range-unsatisfiable",
      contentRange: null,
      message: "invalid range",
    });
    // An empty file ignores any range (Go's size==0 arm).
    expect(planByteServing(request({ Range: "bytes=0-" }), 0, CREATED)).toEqual({
      kind: "serve",
      status: 200,
      start: 0,
      length: 0,
      contentRange: null,
    });
  });

  it("multi-range falls back to the full 200 (the documented divergence)", () => {
    expect(planByteServing(request({ Range: "bytes=0-1,3-4" }), 10, CREATED)).toEqual(serve);
  });

  it("If-Range gates the range on the modtime date; an etag-shaped value drops it", () => {
    expect(planByteServing(request({ Range: "bytes=2-", "If-Range": CREATED_RFC1123 }), 10, CREATED)).toEqual({
      kind: "serve",
      status: 206,
      start: 2,
      length: 8,
      contentRange: "bytes 2-9/10",
    });
    expect(
      planByteServing(request({ Range: "bytes=2-", "If-Range": "Wed, 28 Oct 2026 00:00:00 GMT" }), 10, CREATED),
    ).toEqual(serve);
    expect(planByteServing(request({ Range: "bytes=2-", "If-Range": `"somewhere"` }), 10, CREATED)).toEqual(serve);
    // The gate itself is GET/HEAD-only (fs.go:585-587): any other method
    // honors the Range regardless of a mismatched If-Range.
    expect(planByteServing(request({ Range: "bytes=2-", "If-Range": `"somewhere"` }, "POST"), 10, CREATED)).toEqual({
      kind: "serve",
      status: 206,
      start: 2,
      length: 8,
      contentRange: "bytes 2-9/10",
    });
    // HEAD is still gated (GET || HEAD pass the method check).
    expect(planByteServing(request({ Range: "bytes=2-", "If-Range": `"somewhere"` }, "HEAD"), 10, CREATED)).toEqual(
      serve,
    );
  });

  // -- the zero-modtime posture (created-less arms: the key downloads) -----

  it("an absent created makes If-(Un)Modified-Since inert (isZeroTime) while * still 304s", () => {
    // fs.go:618-621 — the zero modtime is "unspecified": the date checks go
    // condNone even for a stale/valid date; If-None-Match: * is
    // ETag-independent and still not-modifies.
    expect(planByteServing(request({ "If-Modified-Since": "Wed, 28 Oct 2026 00:00:00 GMT" }), 10)).toEqual(serve);
    expect(planByteServing(request({ "If-Modified-Since": "Fri, 30 Oct 2026 00:00:00 GMT" }), 10)).toEqual(serve);
    expect(planByteServing(request({ "If-Unmodified-Since": "Wed, 28 Oct 2026 00:00:00 GMT" }), 10)).toEqual(serve);
    expect(planByteServing(request({ "If-None-Match": "*" }), 10)).toEqual({ kind: "not-modified" });
    // A date-form If-Range never matches the strict zero (fs.go:601-603) —
    // the Range drops; Range alone still 206s.
    expect(planByteServing(request({ Range: "bytes=2-", "If-Range": CREATED_RFC1123 }), 10)).toEqual(serve);
    expect(planByteServing(request({ Range: "bytes=2-" }), 10)).toEqual({
      kind: "serve",
      status: 206,
      start: 2,
      length: 8,
      contentRange: "bytes 2-9/10",
    });
  });

  it("an epoch-zero created behaves like the unspecified time for IMS/IUS but compares in If-Range", () => {
    // isZeroTime covers Unix epoch 0 for setLastModified/IMS/IUS
    // (fs.go:618-621), while checkIfRange tests the STRICT IsZero
    // (fs.go:601-603) — an epoch-zero modtime still compares there.
    const epoch = new Date(0);
    expect(planByteServing(request({ "If-Modified-Since": "Fri, 30 Oct 2026 00:00:00 GMT" }), 10, epoch)).toEqual(
      serve,
    );
    expect(planByteServing(request({ "If-Unmodified-Since": "Wed, 28 Oct 2026 00:00:00 GMT" }), 10, epoch)).toEqual(
      serve,
    );
    expect(planByteServing(request({ Range: "bytes=2-", "If-Range": "Thu, 01 Jan 1970 00:00:00 GMT" }), 10, epoch)).toEqual({
      kind: "serve",
      status: 206,
      start: 2,
      length: 8,
      contentRange: "bytes 2-9/10",
    });
    expect(planByteServing(request({ Range: "bytes=2-", "If-Range": "Fri, 02 Jan 1970 00:00:00 GMT" }), 10, epoch)).toEqual(
      serve,
    );
  });

  // -- the strconv.ParseInt-exact range grammar -----------------------------

  it("byte-ranges are ParseInt-exact — trailing junk, hex, float and double-dash forms are 416s", () => {
    // Number.parseInt's prefix tolerance would serve these; Go ParseInt
    // consumes the WHOLE string and errors.
    for (const range of ["bytes=2-5junk", "bytes=0x2-5", "bytes=2-0x5", "bytes=1e2-", "bytes=+2--5", "bytes=2-10-15"]) {
      expect(planByteServing(request({ Range: range }), 10, CREATED)).toEqual({
        kind: "range-unsatisfiable",
        contentRange: null,
        message: "invalid range",
      });
    }
    // The optional sign is VALID grammar (strconv.ParseInt("+2") = 2).
    expect(planByteServing(request({ Range: "bytes=+2-5" }), 10, CREATED)).toEqual({
      kind: "serve",
      status: 206,
      start: 2,
      length: 4,
      contentRange: "bytes 2-5/10",
    });
    // textproto.TrimString is ASCII-space only — an NBSP is grammar garbage
    // (JS String.trim would have trimmed it into a serving range).
    expect(planByteServing(request({ Range: "bytes=\u00A02-5" }), 10, CREATED)).toEqual({
      kind: "range-unsatisfiable",
      contentRange: null,
      message: "invalid range",
    });
    expect(planByteServing(request({ Range: "bytes= 2-5 " }), 10, CREATED)).toEqual({
      kind: "serve",
      status: 206,
      start: 2,
      length: 4,
      contentRange: "bytes 2-5/10",
    });
  });

  it("int64 bounds follow ParseInt, not Number safety — out-of-int64 is invalid, beyond-2^53 no-overlaps", () => {
    // Beyond int64: ParseInt errors → the bare invalid 416 (no Content-Range).
    expect(planByteServing(request({ Range: "bytes=9223372036854775808-" }), 10, CREATED)).toEqual({
      kind: "range-unsatisfiable",
      contentRange: null,
      message: "invalid range",
    });
    // Between 2^53 and 2^63: ParseInt succeeds → start >= size → the
    // no-overlap 416 WITH `bytes */size` (the former isSafeInteger gate
    // answered the wrong shape here).
    expect(planByteServing(request({ Range: "bytes=9007199254740993-" }), 10, CREATED)).toEqual({
      kind: "range-unsatisfiable",
      contentRange: "bytes */10",
      message: "invalid range: failed to overlap",
    });
    // A suffix beyond 2^53 but inside int64 clamps to the whole file (the
    // former gate 416'd it).
    expect(planByteServing(request({ Range: "bytes=-9007199254740993" }), 10, CREATED)).toEqual({
      kind: "serve",
      status: 206,
      start: 0,
      length: 10,
      contentRange: "bytes 0-9/10",
    });
    // A suffix beyond int64 is invalid.
    expect(planByteServing(request({ Range: "bytes=-9223372036854775809" }), 10, CREATED)).toEqual({
      kind: "range-unsatisfiable",
      contentRange: null,
      message: "invalid range",
    });
  });
});

// ---------------------------------------------------------------------------
// servePackageFileResponse + sliceByteRange — the ctx.ServeContent assembly
// ---------------------------------------------------------------------------

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function textOf(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder("utf-8").decode(await new Response(stream).arrayBuffer());
}

describe("servePackageFileResponse", () => {
  const opts = { filename: "test.txt", size: 11, created: CREATED };

  it("assembles the 200 with the full header set and Accept-Ranges", async () => {
    const res = servePackageFileResponse(request(), streamOf(["hello world"]), opts);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe("11");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals allow-popups allow-downloads");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=test.txt");
    expect(res.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    expect(res.headers.get("last-modified")).toBe(CREATED_RFC1123);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await textOf(res.body as ReadableStream<Uint8Array>)).toBe("hello world");
  });

  it("304 keeps the cache/disposition/Last-Modified metadata and drops the representation", async () => {
    const res = servePackageFileResponse(request({ "If-Modified-Since": CREATED_RFC1123 }), null, opts);
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(res.headers.get("last-modified")).toBe(CREATED_RFC1123);
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=test.txt");
    expect(res.headers.get("accept-ranges")).toBeNull();
  });

  it("412 rides the bare status over the set headers", async () => {
    const res = servePackageFileResponse(request({ "If-Match": `"gone"` }), null, opts);
    expect(res.status).toBe(412);
    expect(await res.text()).toBe("");
    expect(res.headers.get("last-modified")).toBe(CREATED_RFC1123);
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
  });

  it("416 runs serveError's header surgery then http.Error — metadata deleted, disposition/CSP/Content-Range kept", async () => {
    // serveError (fs.go:188-211, the GODEBUG=httpservecontentkeepheaders
    // default; gitea builds go 1.27 with no override) deletes the
    // success-oriented Cache-Control/Content-Encoding/Etag/Last-Modified;
    // http.Error (server.go:2337-2357) then deletes Content-Length, resets
    // Content-Type and nosniff. The CSP, the disposition and the
    // `bytes */size` Content-Range are in neither delete list and survive;
    // Accept-Ranges never lands (fs.go:396 is after the error return).
    const res = servePackageFileResponse(request({ Range: "bytes=50-" }), streamOf(["hello world"]), opts);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */11");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("last-modified")).toBeNull();
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=test.txt");
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals allow-popups allow-downloads");
    expect(res.headers.get("accept-ranges")).toBeNull();
    expect(await res.text()).toBe("invalid range: failed to overlap\n");

    // The bare invalid-range 416 (no Content-Range to keep) carries the same
    // error shape.
    const garbage = servePackageFileResponse(request({ Range: "zap=1-2" }), streamOf(["hello world"]), opts);
    expect(garbage.status).toBe(416);
    expect(garbage.headers.get("content-range")).toBeNull();
    expect(garbage.headers.get("cache-control")).toBeNull();
    expect(await garbage.text()).toBe("invalid range\n");
  });

  it("a created-less download (the key arms' shape) serves the full set with NO Last-Modified", () => {
    const keyRes = servePackageFileResponse(request(), streamOf(["-----KEY-----"]), {
      filename: "repository.key",
      contentType: "application/pgp-keys",
      size: 11,
    });
    expect(keyRes.status).toBe(200);
    expect(keyRes.headers.get("content-type")).toBe("application/pgp-keys");
    expect(keyRes.headers.get("content-disposition")).toBe("attachment; filename=repository.key");
    expect(keyRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(keyRes.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals allow-popups allow-downloads");
    expect(keyRes.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(keyRes.headers.get("accept-ranges")).toBe("bytes");
    expect(keyRes.headers.get("content-length")).toBe("11");
    // The zero-modtime arm: no Last-Modified, and a stale If-Modified-Since
    // cannot 304 (the date checks are inert).
    expect(keyRes.headers.get("last-modified")).toBeNull();
    const stale = servePackageFileResponse(request({ "If-Modified-Since": "Sat, 01 Jan 2050 00:00:00 GMT" }), null, {
      filename: "repository.key",
      contentType: "application/pgp-keys",
      size: 11,
    });
    expect(stale.status).toBe(200);
  });

  it("206 slices the body and answers HEAD with the status alone", async () => {
    const res = servePackageFileResponse(request({ Range: "bytes=6-10" }), streamOf(["hello world"]), opts);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 6-10/11");
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await textOf(res.body as ReadableStream<Uint8Array>)).toBe("world");

    const head = servePackageFileResponse(request({ Range: "bytes=6-10" }, "HEAD"), null, opts);
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe("bytes 6-10/11");
    expect(await head.text()).toBe("");
  });

  it("a ZERO-START 206 slices too — the smoke's fix-before-deploy find (bytes=0-9 answered the FULL body)", async () => {
    // The pre-deploy local smoke (docs/usability/smoke-local-api-ui.md):
    // Range bytes=0-9 / 0-0 answered 206 with content-range 0-9/56 but the
    // FULL 56-byte body — `plan.start > 0` skipped the slice at start 0.
    // Go's ServeContent honors zero-start ranges; resumable clients corrupt.
    const res = servePackageFileResponse(request({ Range: "bytes=0-9" }), streamOf(["hello world"]), opts);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-9/11");
    expect(res.headers.get("content-length")).toBe("10");
    expect(await textOf(res.body as ReadableStream<Uint8Array>)).toBe("hello worl");

    const point = servePackageFileResponse(request({ Range: "bytes=0-0" }), streamOf(["hello world"]), opts);
    expect(point.status).toBe(206);
    expect(point.headers.get("content-range")).toBe("bytes 0-0/11");
    expect(await textOf(point.body as ReadableStream<Uint8Array>)).toBe("h");
  });

  it("HEAD carries the 200 headers without a body", async () => {
    const head = servePackageFileResponse(request({}, "HEAD"), null, opts);
    expect(head.status).toBe(200);
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(head.headers.get("content-length")).toBe("11");
    expect(await head.text()).toBe("");
  });
});

describe("sliceByteRange", () => {
  it("cuts the skip-then-take window out of the source stream", async () => {
    expect(await textOf(sliceByteRange(streamOf(["hello world"]), 0, 5))).toBe("hello");
    expect(await textOf(sliceByteRange(streamOf(["hello world"]), 6, 5))).toBe("world");
    expect(await textOf(sliceByteRange(streamOf(["hel", "lo ", "wor", "ld"]), 4, 3))).toBe("o w");
    expect(await textOf(sliceByteRange(streamOf(["abc"]), 1, 0))).toBe("");
  });
});

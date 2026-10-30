/**
 * The serve-content unit battery (parity review D-6): the port of upstream's
 * modules/httplib serve.go + content_disposition.go + httpcache.go and the
 * net/http ServeContent precondition/range subset. The disposition table
 * mirrors upstream's own TestContentDisposition
 * (modules/httplib/content_disposition_test.go) attachment-flavored, byte for
 * byte; the conditional/range arms pin Go's checkPreconditions + parseRange
 * wire shapes (the ETag-less package file: only `If-None-Match: *` matches).
 */

import { describe, expect, it } from "vitest";

import {
  contentDispositionAttachment,
  planByteServing,
  serveFileHeaderSet,
  servePackageFileResponse,
  sliceByteRange,
} from "./serve-content";

const CREATED = new Date("2026-10-29T12:00:00Z");
const CREATED_RFC1123 = "Thu, 29 Oct 2026 12:00:00 GMT";
const request = (headers: Record<string, string> = {}, method = "GET"): Request =>
  new Request("https://example.com/x", { method, headers });

// ---------------------------------------------------------------------------
// contentDispositionAttachment — content_disposition.go:47-67
// ---------------------------------------------------------------------------

describe("contentDispositionAttachment (the upstream TestContentDisposition table)", () => {
  it("renders token-safe names bare and leaves ASCII names twin-free", () => {
    expect(contentDispositionAttachment("test.txt")).toBe("attachment; filename=test.txt");
    expect(contentDispositionAttachment("mytool-1.0.0.tar.gz")).toBe(
      "attachment; filename=mytool-1.0.0.tar.gz",
    );
    expect(contentDispositionAttachment('"test.txt')).toBe('attachment; filename="\\"test.txt"');
    expect(contentDispositionAttachment("hello\tworld.txt")).toBe('attachment; filename="hello\tworld.txt"');
  });

  it("pairs the safe name with the RFC 5987 filename* twin for non-ASCII names", () => {
    expect(contentDispositionAttachment("test❌.txt")).toBe(
      "attachment; filename=test_.txt; filename*=utf-8''test%E2%9D%8C.txt",
    );
    expect(contentDispositionAttachment("test ❌.txt")).toBe(
      'attachment; filename="test _.txt"; filename*=utf-8\'\'test%20%E2%9D%8C.txt',
    );
    // The unicode-name package shape from the review gate: `ü` → `_` quoted-side,
    // pct-encoded twin over the UTF-8 bytes (uppercase hex).
    expect(contentDispositionAttachment("nü-tool-1.0.pkg")).toBe(
      "attachment; filename=n_-tool-1.0.pkg; filename*=utf-8''n%C3%BC-tool-1.0.pkg",
    );
  });

  it("encodes control runes and keeps the quoted tab verbatim", () => {
    expect(contentDispositionAttachment("hello\nworld.txt")).toBe(
      "attachment; filename=hello_world.txt; filename*=utf-8''hello%0Aworld.txt",
    );
    expect(contentDispositionAttachment("hello\rworld.txt")).toBe(
      "attachment; filename=hello_world.txt; filename*=utf-8''hello%0Dworld.txt",
    );
  });

  it("percent-encodes every non-attr-char byte, uppercase hex", () => {
    // The safe name still carries spaces/colons → the quoted form; the twin
    // encodes the ORIGINAL runes.
    expect(contentDispositionAttachment("café steep: ü.pkg")).toBe(
      'attachment; filename="caf_ steep: _.pkg"; filename*=utf-8\'\'caf%C3%A9%20steep%3A%20%C3%BC.pkg',
    );
    expect(contentDispositionAttachment("del\u007f.txt")).toBe(
      "attachment; filename=del_.txt; filename*=utf-8''del%7F.txt",
    );
  });
});

// ---------------------------------------------------------------------------
// serveFileHeaderSet — serve.go:56-95 + httpcache.go:23-38
// ---------------------------------------------------------------------------

describe("serveFileHeaderSet", () => {
  it("mounts the full upstream set for a named file", () => {
    const headers = serveFileHeaderSet({ filename: "test.txt", size: 7, created: CREATED });
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toBe("sandbox allow-scripts allow-modals allow-popups allow-downloads");
    expect(headers["cache-control"]).toBe("max-age=0, private, must-revalidate");
    expect(headers["content-length"]).toBe("7");
    expect(headers["last-modified"]).toBe(CREATED_RFC1123);
    expect(headers["content-disposition"]).toBe("attachment; filename=test.txt");
    expect(headers["access-control-expose-headers"]).toBe("Content-Disposition");
  });

  it("omits the disposition and the expose echo when no filename rides (maven HEAD)", () => {
    const headers = serveFileHeaderSet({ size: 7, created: CREATED, contentType: "application/java-archive" });
    expect(headers["content-type"]).toBe("application/java-archive");
    expect(headers["content-disposition"]).toBeUndefined();
    expect(headers["access-control-expose-headers"]).toBeUndefined();
    expect(headers["cache-control"]).toBe("max-age=0, private, must-revalidate");
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  it("branches the CSP on the content type (pdf variant, audio/video bare)", () => {
    expect(serveFileHeaderSet({ size: 1, created: CREATED, contentType: "application/pdf" })["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(
      serveFileHeaderSet({ size: 1, created: CREATED, contentType: "audio/mpeg" })["content-security-policy"],
    ).toBeUndefined();
    expect(
      serveFileHeaderSet({ size: 1, created: CREATED, contentType: "video/mp4" })["content-security-policy"],
    ).toBeUndefined();
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

  it("If-None-Match: * matches the ETag-less file; specific tags never do", () => {
    expect(planByteServing(request({ "If-None-Match": "*" }), 10, CREATED)).toEqual({ kind: "not-modified" });
    expect(planByteServing(request({ "If-None-Match": `"abc"` }), 10, CREATED)).toEqual(serve);
    expect(planByteServing(request({ "If-None-Match": `"abc", *` }), 10, CREATED)).toEqual({ kind: "not-modified" });
    // A match on a non-GET/HEAD is the 412 arm.
    expect(planByteServing(request({ "If-None-Match": "*" }, "POST"), 10, CREATED)).toEqual({
      kind: "precondition-failed",
    });
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

  it("416 resets the error shape per http.Error and keeps Content-Range + metadata", async () => {
    const res = servePackageFileResponse(request({ Range: "bytes=50-" }), streamOf(["hello world"]), opts);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */11");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(await res.text()).toBe("invalid range: failed to overlap\n");
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

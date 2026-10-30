/**
 * The file-download serving seam (parity review §3 / D-6). Upstream's
 * `helper.ServePackageFile` → `ctx.ServeContent`
 * (services/context/base.go:186-190) is two steps:
 *
 *  1. `httplib.ServeSetHeaders` (modules/httplib/serve.go:77-95) — the
 *     Content-Type/nosniff/CSP block (serveSetHeaderContentRelated,
 *     serve.go:56-75), the attachment disposition with the RFC 5987
 *     `filename*` twin (content_disposition.go:47-67 over Go's
 *     mime.FormatMediaType), the `Access-Control-Expose-Headers` echo, the
 *     `max-age=0, private, must-revalidate` Cache-Control
 *     (httpcache.go:23-38, the prod posture packages never override), and
 *     Last-Modified from the file row;
 *  2. Go `net/http` ServeContent's precondition + range machinery
 *     (RFC 7232 §6 / RFC 7233): If-Match / If-Unmodified-Since / If-None-Match
 *     / If-Modified-Since → 412/304, If-Range gating, `Accept-Ranges: bytes`,
 *     single-range 206 + Content-Range, 416 for non-overlapping ranges.
 *
 * Package files carry NO ETag upstream (review §3: "none on files"), so
 * `If-None-Match` only ever matches the `*` wildcard and specific tags fall
 * through — the wire shape of Go's checkIfNoneMatch against an empty ETag.
 *
 * One documented mini-divergence: Go answers a MULTI-range request with a
 * multipart/byteranges body; this port serves the full 200 (the
 * single-range resume shape `curl -C -` and browsers issue). Mirrors the
 * minimal-range posture upstream's own ServeUserContentByReader takes for
 * UI-served files (serve.go ServeUserContentByReader: "no support for
 * multiple range").
 */

/** `application/octet-stream` — typesniffer.MimeTypeApplicationOctetStream (serve.go:60). */
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

// ---------------------------------------------------------------------------
// Content-Disposition — content_disposition.go over mime.FormatMediaType
// ---------------------------------------------------------------------------

/** `needsEncodingRune` (content_disposition.go:18-20): outside printable ASCII, tab exempt. */
function needsEncodingRune(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code < 0x20 || code > 0x7e) && code !== 0x09;
}

/** RFC 2045 tspecials — the characters that bar a value from the bare-token form. */
const T_SPECIALS = new Set([...`()<>@,;:\\"/[]?=`]);

function isTokenChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code > 0x20 && code < 0x7f && !T_SPECIALS.has(char);
}

/** The mime.FormatMediaType value forms, verified against the Go oracle:
 *  a token renders bare, any other printable+tab value renders quoted with
 *  backslash escapes, and anything else takes the RFC 2231 ext-value form. */
function formatMediaTypeValue(value: string): string {
  const chars = Array.from(value);
  if (chars.every(isTokenChar)) return value;
  if (chars.every((char) => char === "\t" || (char.codePointAt(0) ?? 0) >= 0x20 && (char.codePointAt(0) ?? 0) <= 0x7e)) {
    return `"${value.replace(/[\\"]/g, "\\$&")}"`;
  }
  return `utf-8''${encodeRfc5987(value)}`;
}

/** RFC 5987 ext-value: attr-chars stay raw, every other UTF-8 byte pct-encodes
 *  (uppercase hex — the Go oracle's `%C3%BC` / `%7F` / `%3A` spellings). */
function encodeRfc5987(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (isTokenChar(char)) {
      out += char;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * `encodeContentDisposition(ContentDispositionAttachment, …)`
 * (content_disposition.go:47-67): the safe name (non-printables → `_`,
 * tab exempt) renders in the bare/quoted token form, and when the ORIGINAL
 * name carried any non-printable rune the `; filename*=utf-8''…` twin of the
 * original joins it. Go's guard clause (the mime-package panic arm) is
 * unreachable in the port by construction.
 */
export function contentDispositionAttachment(filename: string): string {
  const safeName = Array.from(filename)
    .map((char) => (needsEncodingRune(char) ? "_" : char))
    .join("");
  let result = `attachment; filename=${formatMediaTypeValue(safeName)}`;
  if (Array.from(filename).some(needsEncodingRune)) {
    result += `; filename*=utf-8''${encodeRfc5987(filename)}`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// ServeSetHeaders — serve.go:56-95 + httpcache.go:23-38
// ---------------------------------------------------------------------------

/** The upstream CSP constants (serve.go:32-45). */
const CSP_DEFAULT = "sandbox allow-scripts allow-modals allow-popups allow-downloads";
const CSP_PDF = "default-src 'none'; style-src 'unsafe-inline'";

/** `serveSetHeaderContentRelated` (serve.go:56-75): nosniff + the CSP branch
 *  on the EFFECTIVE content type (pdf → the render-sandbox variant,
 *  audio/video → no CSP at all, everything else → the sandbox default). */
function contentSecurityPolicy(contentType: string): string | null {
  if (contentType.startsWith("application/pdf")) return CSP_PDF;
  if (contentType.startsWith("video/") || contentType.startsWith("audio/")) return null;
  return CSP_DEFAULT;
}

export interface ServeFileHeaderOptions {
  /** Unset = no disposition and no expose-headers echo (the maven HEAD
   *  posture, maven.go:216-219 — SetServeHeaders runs before Filename lands). */
  filename?: string;
  /** Defaults to application/octet-stream. */
  contentType?: string;
  size: number;
  /** The file row's creation time → Last-Modified. */
  created: Date;
}

/**
 * `ServeSetHeaders` (serve.go:77-95): the header SET every package-file
 * download carries. Cache-Control is the prod posture
 * (`max-age=0, private, must-revalidate` — packages never set IsPublic or a
 * MaxAge, httpcache.go:31-35); the dev X-Gitea-Debug variant has no
 * RUN_MODE counterpart here. Last-Modified renders http.TimeFormat
 * (JS `toUTCString` is the same RFC 1123 GMT shape). `path.Base` runs before
 * the disposition encoding (serve.go:87).
 */
export function serveFileHeaderSet(opts: ServeFileHeaderOptions): Record<string, string> {
  const contentType = opts.contentType === undefined || opts.contentType === "" ? DEFAULT_CONTENT_TYPE : opts.contentType;
  const headers: Record<string, string> = {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "content-length": String(opts.size),
    "cache-control": "max-age=0, private, must-revalidate",
    "last-modified": opts.created.toUTCString(),
  };
  const csp = contentSecurityPolicy(contentType);
  if (csp !== null) headers["content-security-policy"] = csp;
  if (opts.filename !== undefined && opts.filename !== "") {
    const base = opts.filename.slice(opts.filename.lastIndexOf("/") + 1);
    headers["content-disposition"] = contentDispositionAttachment(base);
    headers["access-control-expose-headers"] = "Content-Disposition";
  }
  return headers;
}

// ---------------------------------------------------------------------------
// The ServeContent precondition + range machinery
// ---------------------------------------------------------------------------

/** A byte-serving decision — the checkPreconditions + parseRange outcome. */
export type ByteServingPlan =
  | { kind: "not-modified" }
  | { kind: "precondition-failed" }
  | { kind: "range-unsatisfiable"; contentRange: string | null; message: string }
  | { kind: "serve"; status: 200 | 206; start: number; length: number; contentRange: string | null };

/** Go's ParseTime is lenient over the three HTTP date forms; the requests
 *  these registries see are RFC 1123 (what Last-Modified itself renders). */
function parseHttpDate(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** `scanETag` (net/http/fs.go): a `W/"…"` / `"…"` token over the etag-octet
 *  alphabet, closed by the terminal quote; null on any garbage. */
function scanEtag(input: string): { etag: string; remain: string } | null {
  const rest = input.trim();
  const start = rest.startsWith("W/") ? 2 : 0;
  if (rest.length - start < 2 || rest.charAt(start) !== '"') return null;
  for (let i = start + 1; i < rest.length; i++) {
    const code = rest.charCodeAt(i);
    if (code === 0x22) return { etag: rest.slice(0, i + 1), remain: rest.slice(i + 1) };
    if (!(code === 0x21 || (code >= 0x23 && code <= 0x7e) || code >= 0x80)) return null;
  }
  return null;
}

/** A comma-split If-(None-)Match list walk: `*` or a strong/weak tag equal to
 *  `ours` matches. Package files carry no ETag, so only `*` can ever match. */
function etagListMatches(header: string): boolean {
  let buf = header;
  for (;;) {
    buf = buf.trim();
    if (buf.length === 0) return false;
    if (buf[0] === ",") {
      buf = buf.slice(1);
      continue;
    }
    if (buf[0] === "*") return true;
    const scanned = scanEtag(buf);
    if (scanned === null) return false;
    // etagWeakMatch(scanned.etag, ours) with ours = "" — never true.
    buf = scanned.remain;
  }
}

interface ByteRange {
  start: number;
  length: number;
}

/** `parseRange` (net/http/fs.go) reduced to the single-range shape (the
 *  multi-range multipart answer is the documented divergence — the caller
 *  falls back to the full 200). */
function parseSingleRange(header: string, size: number): ByteRange[] | "invalid" | "no-overlap" {
  const prefix = "bytes=";
  if (!header.startsWith(prefix)) return "invalid";
  const ranges: ByteRange[] = [];
  let noOverlap = false;
  for (const segment of header.slice(prefix.length).split(",")) {
    const raw = segment.trim();
    if (raw === "") continue;
    const dash = raw.indexOf("-");
    if (dash < 0) return "invalid";
    const startText = raw.slice(0, dash).trim();
    const endText = raw.slice(dash + 1).trim();
    if (startText === "") {
      // Suffix form `bytes=-N`: the last N bytes (clamped at the size).
      if (endText === "" || endText[0] === "-") return "invalid";
      const suffix = Number.parseInt(endText, 10);
      if (!Number.isSafeInteger(suffix) || suffix < 0) return "invalid";
      const clamped = Math.min(suffix, size);
      ranges.push({ start: size - clamped, length: size - (size - clamped) });
      continue;
    }
    const start = Number.parseInt(startText, 10);
    if (Number.isNaN(start) || !Number.isSafeInteger(start) || start < 0) return "invalid";
    if (start >= size) {
      noOverlap = true;
      continue;
    }
    if (endText === "") {
      ranges.push({ start, length: size - start });
      continue;
    }
    const end = Number.parseInt(endText, 10);
    if (Number.isNaN(end) || !Number.isSafeInteger(end) || start > end) return "invalid";
    ranges.push({ start, length: Math.min(end, size - 1) - start + 1 });
  }
  if (noOverlap && ranges.length === 0) return "no-overlap";
  return ranges;
}

/**
 * `checkPreconditions` + the range arm of `serveContent`
 * (net/http/fs.go, RFC 7232 §6): the exact Go order — If-Match, then
 * If-Unmodified-Since (only in If-Match's absence), then If-None-Match
 * (whose presence SUPPRESSES If-Modified-Since), then If-Range gating the
 * Range header. Second-truncation of the modtime mirrors Go's
 * `modtime.Truncate(time.Second)`.
 */
export function planByteServing(request: Request, size: number, created: Date): ByteServingPlan {
  const method = request.method;
  const isGetOrHead = method === "GET" || method === "HEAD";
  const headers = request.headers;
  // Last-Modified truncates sub-second precision; compare in whole seconds.
  const modSec = Math.floor(created.getTime() / 1000);

  // 1. If-Match; If-Unmodified-Since only when If-Match is absent.
  const ifMatch = headers.get("If-Match") ?? "";
  if (ifMatch !== "") {
    if (!etagListMatches(ifMatch)) return { kind: "precondition-failed" };
  } else {
    const ifUnmodifiedSince = headers.get("If-Unmodified-Since") ?? "";
    if (ifUnmodifiedSince !== "") {
      const date = parseHttpDate(ifUnmodifiedSince);
      if (date !== null && modSec > Math.floor(date / 1000)) return { kind: "precondition-failed" };
    }
  }

  // 2. If-None-Match (`*` matches; specific tags cannot — no ETag on files).
  const ifNoneMatch = headers.get("If-None-Match") ?? "";
  if (ifNoneMatch !== "") {
    if (etagListMatches(ifNoneMatch)) {
      return isGetOrHead ? { kind: "not-modified" } : { kind: "precondition-failed" };
    }
  } else if (isGetOrHead) {
    const ifModifiedSince = headers.get("If-Modified-Since") ?? "";
    if (ifModifiedSince !== "") {
      const date = parseHttpDate(ifModifiedSince);
      if (date !== null && modSec <= Math.floor(date / 1000)) return { kind: "not-modified" };
    }
  }

  // 3. Range, gated by If-Range (an ETag-shaped If-Range never matches our
  //    ETag-less files; a date If-Range matches on whole seconds).
  let rangeHeader = headers.get("Range") ?? "";
  if (rangeHeader !== "") {
    const ifRange = headers.get("If-Range") ?? "";
    if (ifRange !== "") {
      const asEtag = scanEtag(ifRange);
      const date = asEtag === null ? parseHttpDate(ifRange) : null;
      if (asEtag !== null || date === null || Math.floor(date / 1000) !== modSec) rangeHeader = "";
    }
  }

  if (rangeHeader === "") {
    return { kind: "serve", status: 200, start: 0, length: size, contentRange: null };
  }
  const parsed = parseSingleRange(rangeHeader, size);
  if (parsed === "invalid") {
    return { kind: "range-unsatisfiable", contentRange: null, message: "invalid range" };
  }
  if (parsed === "no-overlap") {
    if (size === 0) {
      // Go: some clients range everything; an empty file ignores the header.
      return { kind: "serve", status: 200, start: 0, length: 0, contentRange: null };
    }
    return {
      kind: "range-unsatisfiable",
      contentRange: `bytes */${size}`,
      message: "invalid range: failed to overlap",
    };
  }
  if (parsed.length === 1) {
    const only = parsed[0];
    if (only === undefined) return { kind: "serve", status: 200, start: 0, length: size, contentRange: null };
    return {
      kind: "serve",
      status: 206,
      start: only.start,
      length: only.length,
      contentRange: `bytes ${only.start}-${only.start + only.length - 1}/${size}`,
    };
  }
  // The multi-range divergence: Go answers multipart/byteranges; serve the
  // full 200 (see the module note).
  return { kind: "serve", status: 200, start: 0, length: size, contentRange: null };
}

/**
 * The skip-then-take stream window for a 206 body (R2 objects hand back a
 * fresh full stream; `bucket.get(key, { range })` re-open is the alternative
 * the download services can adopt later).
 */
export function sliceByteRange(
  stream: ReadableStream<Uint8Array>,
  start: number,
  length: number,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let position = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const end = start + length;
      for (;;) {
        if (position >= end) {
          controller.close();
          await reader.cancel();
          return;
        }
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        const chunk = next.value;
        const chunkEnd = position + chunk.length;
        const from = Math.max(0, start - position);
        const to = Math.min(chunk.length, end - position);
        if (to > from) controller.enqueue(chunk.subarray(from, to));
        position = chunkEnd;
        if (chunkEnd >= end) {
          controller.close();
          await reader.cancel();
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * The composed `ctx.ServeContent` (base.go:186-190): ServeSetHeaders first,
 * then the precondition/range machinery. `body === null` is the HEAD arm —
 * Go's server discards the handler's writes for HEAD while the status and
 * headers (including a 304/206 outcome) stand.
 */
export function servePackageFileResponse(
  request: Request,
  body: ReadableStream<Uint8Array> | null,
  opts: ServeFileHeaderOptions,
): Response {
  const headers = serveFileHeaderSet(opts);
  const plan = planByteServing(request, opts.size, opts.created);

  if (plan.kind === "not-modified") {
    // writeNotModified (fs.go): drop the representation headers, keep the rest.
    const notModified = new Headers(headers);
    notModified.delete("content-type");
    notModified.delete("content-length");
    return new Response(null, { status: 304, headers: notModified });
  }
  if (plan.kind === "precondition-failed") {
    // Go's checkPreconditions writes the bare 412 over the set headers.
    return new Response(null, { status: 412, headers: new Headers(headers) });
  }
  if (plan.kind === "range-unsatisfiable") {
    // serveError → http.Error (server.go): CL deleted, CT reset, nosniff,
    // `message\n` body; the earlier headers (Cache-Control, disposition,
    // Last-Modified, the `bytes */size` Content-Range) stand.
    const unsatisfiable = new Headers(headers);
    unsatisfiable.delete("content-length");
    unsatisfiable.set("content-type", "text/plain; charset=utf-8");
    unsatisfiable.set("x-content-type-options", "nosniff");
    if (plan.contentRange !== null) unsatisfiable.set("content-range", plan.contentRange);
    return new Response(`${plan.message}\n`, { status: 416, headers: unsatisfiable });
  }

  const serving = new Headers(headers);
  if (plan.status === 206) {
    serving.set("content-range", plan.contentRange ?? "");
    serving.set("content-length", String(plan.length));
  }
  // Accept-Ranges lands after the range switch (fs.go serveContent) — on
  // 200/206 only, never on the 304/412/416 arms.
  serving.set("accept-ranges", "bytes");
  if (body === null) {
    return new Response(null, { status: plan.status, headers: serving });
  }
  const out = plan.status === 206 && plan.start > 0 ? sliceByteRange(body, plan.start, plan.length) : body;
  return new Response(out, { status: plan.status, headers: serving });
}

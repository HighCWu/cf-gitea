/**
 * The file-download serving seam (parity review §3 / D-6) — the port of
 * upstream's `helper.ServePackageFile` → `ctx.ServeContent`
 * (services/context/base.go:186-190), CONSOLIDATED onto the shared serve
 * pipeline (`src/web/attachments-serving.ts`, the serve.go port): the header
 * SET and the Content-Disposition encoding ride that module's exports
 * (`serveSetHeaders`, `encodeContentDisposition`, `goPathBase`) — the same
 * ServeSetHeaders (serve.go:77-105) family the web attachments route, the API
 * blob GET, and the archive ride — instead of this module's former private
 * copy (the copy's derivation drifts are recorded in the test battery).
 *
 * What remains here is the packages arm upstream genuinely separates:
 *
 *  1. The packages-specific INPUTS — the registry's own Content-Type override
 *     (maven's jar/xml pair maven.go:206-214, swift's "text/x-swift", the
 *     debian/alpine/rpm key arms) and the file row's created time — are
 *     carried by the callers and fed through the shared table: the CSP branch
 *     (serve.go:62-73) keys off the resolved type, the zero value floors to
 *     application/octet-stream (serve.go:58), and the disposition word is
 *     ServeSetHeaders' IfZero ATTACHMENT default (serve.go:91). The routes'
 *     own permission/quota arms (protocolContext, the sentinels) stay at the
 *     callers, exactly where upstream separates them.
 *  2. The BYTE-SERVING machinery of Go net/http's ServeContent (RFC 7232 §6 /
 *     RFC 7233): If-Match / If-Unmodified-Since / If-None-Match /
 *     If-Modified-Since → 412/304, If-Range gating, `Accept-Ranges: bytes`,
 *     single-range 206 + Content-Range, 416 for non-overlapping ranges. This
 *     is deliberately NOT the web attachment chain
 *     (HandleGenericETagPrivateCache + ServeUserContentByFile): upstream
 *     packages never sniffs and never runs that machinery — conflating the
 *     two would change the wire (sniffed types, INLINE disposition, ETag 304s
 *     packages never emits).
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
 *
 * The date validation mirrors the shared module's Go time.Parse port
 * (parseHttpTimeFormat — strict IMF-fixdate, range-checked: "31 Feb 2024"
 * errors where JS `Date.parse` silently rolls over into March). It is a
 * LOCAL MIRROR only because the shared module does not export that helper
 * yet — the export hunk is reported to the orchestrator; once it lands this
 * helper folds to the import (the two tables are byte-identical decisions).
 */

import { encodeContentDisposition, goPathBase, serveSetHeaders } from "../../web/attachments-serving";

// ---------------------------------------------------------------------------
// ServeSetHeaders — the shared pipeline's header set (serve.go:56-105 +
// httpcache.go:23-38), fed with the packages-specific inputs
// ---------------------------------------------------------------------------

export interface ServeFileHeaderOptions {
  /** Unset = no disposition and no expose-headers echo (the maven HEAD
   *  posture, maven.go:216-219 — SetServeHeaders runs before Filename lands). */
  filename?: string;
  /** The registry's own override (maven's jar/xml, swift's text/x-swift, the
   *  key arms' pgp-keys/pem); unset/"" floors to application/octet-stream
   *  (serve.go:58) inside the shared table. */
  contentType?: string;
  size: number;
  /** The file row's creation time → Last-Modified. */
  created: Date;
}

/**
 * `ServeSetHeaders` (serve.go:77-105) through the shared pipeline: the header
 * SET every package-file download carries — nosniff, the CSP branch on the
 * resolved type, the ATTACHMENT disposition over `path.Base(filename)`
 * (serve.go:92) with the RFC 2231 `filename*` twin (content_disposition.go),
 * the `Access-Control-Expose-Headers` echo, the zero-duration Cache-Control
 * prod posture (`max-age=0, private, must-revalidate`, httpcache.go:31-35 —
 * packages never set IsPublic or a MaxAge), Content-Length, and Last-Modified
 * from the file row.
 */
export function serveFileHeaderSet(opts: ServeFileHeaderOptions): Record<string, string> {
  return serveSetHeaders({
    filename: opts.filename,
    contentType: opts.contentType,
    contentLength: opts.size,
    lastModified: opts.created,
  });
}

// ---------------------------------------------------------------------------
// The strict HTTP-date validation — the local mirror of the shared module's
// Go time.Parse port (fold to the import once parseHttpTimeFormat is
// exported; see the module note)
// ---------------------------------------------------------------------------

/** Strict IMF-fixdate (Go's http.TimeFormat layout) — other legal HTTP date
 *  spellings fail time.Parse upstream and must fail here too. */
const IMF_FIXDATE_RE = /^([A-Z][a-z]{2}), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const SHORT_MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};
const SHORT_DAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

/**
 * Go time.Parse(http.TimeFormat, …) — the fixdate shape AND Go's range
 * validation: the weekday one of the seven shorts, the month a real short
 * name, the day in range for that month (leap years included — "31 Feb 2024"
 * errors upstream, where JS Date.parse would silently roll over), hour ≤ 23,
 * minute/second ≤ 59. Returns epoch ms.
 */
function parseHttpTimeFormat(value: string): number | null {
  const match = IMF_FIXDATE_RE.exec(value);
  if (match === null) return null;
  const dayName = match[1] ?? "";
  const month = SHORT_MONTHS[match[3] ?? ""];
  if (!SHORT_DAYS.has(dayName) || month === undefined) return null;
  const day = Number(match[2]);
  const year = Number(match[4]);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = Number(match[7]);
  if (hour > 23 || minute > 59 || second > 59 || day < 1) return null;
  if (day > new Date(Date.UTC(year, month + 1, 0)).getUTCDate()) return null;
  // Date.UTC maps years 0-99 onto 1900+y — setUTCFullYear keeps them literal.
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
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
 * (whose presence SUPPRESSES If-Modified-Since — including an EMPTY-valued
 * If-None-Match, which `Header.Get` reports as "" and therefore still
 * consults If-Modified-Since, exactly like the shared module's gate), then
 * If-Range gating the Range header. Second-truncation of the modtime mirrors
 * Go's `modtime.Truncate(time.Second)`; the date validation is Go
 * time.Parse-exact (the strict fixdate parser above — a rolled "31 Feb" must
 * not 304/412 where Go serves 200).
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
      const date = parseHttpTimeFormat(ifUnmodifiedSince);
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
      const date = parseHttpTimeFormat(ifModifiedSince);
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
      const date = asEtag === null ? parseHttpTimeFormat(ifRange) : null;
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
 * The composed `ctx.ServeContent` (base.go:186-190): ServeSetHeaders first —
 * through the shared pipeline — then the precondition/range machinery.
 * `body === null` is the HEAD arm — Go's server discards the handler's writes
 * for HEAD while the status and headers (including a 304/206 outcome) stand.
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
  // EVERY 206 slices (the smoke's fix-before-deploy find: `start > 0` let a
  // zero-start range skip the slice and stream the FULL body under a 0-9
  // content-range — resumable clients corrupt; Go's ServeContent honors
  // zero-start ranges).
  const out = plan.status === 206 ? sliceByteRange(body, plan.start, plan.length) : body;
  return new Response(out, { status: plan.status, headers: serving });
}

// ---------------------------------------------------------------------------
// Re-exports for the packages route files' DIRECT disposition sites (the
// debian/alpine/rpm repository-key arms build bare two-header responses where
// upstream rides ctx.ServeContent — the consolidation keeps their wire shape
// but routes the encoding through the shared table, so a bare-key download
// cannot drift from the family again). The canonical seam is the direct
// import (archive.ts / actions-artifacts.ts precedent); this re-export keeps
// the packages routes' single import line.
// ---------------------------------------------------------------------------

export { encodeContentDisposition, goPathBase };

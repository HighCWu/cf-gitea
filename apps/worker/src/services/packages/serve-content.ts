/**
 * The file-download serving seam (parity review §3 / D-6) — the port of
 * upstream's `helper.ServePackageFile` → `ctx.ServeContent`
 * (services/context/base.go:186-190), CONSOLIDATED onto the shared serve
 * pipeline (`src/web/attachments-serving.ts`, the serve.go port): the header
 * SET and the Content-Disposition encoding ride that module's exports
 * (`serveSetHeaders` + its encoder family) — the same ServeSetHeaders
 * (serve.go:77-105) family the web attachments route, the API blob GET, and
 * the archive ride — instead of this module's former private copy (the
 * copy's derivation drifts are recorded in the test battery). Every
 * upstream ctx.ServeContent download arm composes through
 * `servePackageFileResponse` here: the generic file family
 * (helper.ServePackageFile), the debian/alpine/rpm/arch repository-key
 * arms, the chef .priv download, and the swift manifest pair.
 *
 * What remains here is the packages arm upstream genuinely separates:
 *
 *  1. The packages-specific INPUTS — the registry's own Content-Type override
 *     (maven's jar/xml pair maven.go:209-217, swift's "text/x-swift", the
 *     debian/alpine/rpm/arch key arms) and the file row's created time — are
 *     carried by the callers and fed through the shared table: the CSP branch
 *     (serve.go:62-73) keys off the resolved type, the zero value floors to
 *     application/octet-stream (serve.go:58), and the disposition word is
 *     ServeSetHeaders' IfZero ATTACHMENT default (serve.go:91). The routes'
 *     own permission/quota arms (protocolContext, the sentinels) stay at the
 *     callers, exactly where upstream separates them. `created` is OPTIONAL:
 *     every ctx.ServeContent arm that passes no LastModified (the
 *     debian.go:38-41 / alpine.go:57-60 / rpm.go:62-65 / arch.go:38-40
 *     repository-key arms, the chef .priv download setting/packages.go:108-113,
 *     rubygems' SetServeHeaders pair rubygems.go:82-84/:122-124) rides the
 *     ZERO-MODTIME posture — no Last-Modified header, and If-Unmodified-Since
 *     / If-Modified-Since inert (Go isZeroTime, fs.go:618-621: the zero time
 *     AND the Unix epoch are both "unspecified"), while a date-form If-Range
 *     never matches on the strict zero (fs.go:601-603's IsZero arm — an
 *     epoch-zero modtime still compares).
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
 * multiple range"). The REST of the ServeContent family is the exact Go
 * port (fs.go at gitea's go 1.27 toolchain): the preconditions order, the
 * strconv.ParseInt-exact range grammar (whole-string decimal, optional
 * sign, int64 bounds — `Number.parseInt`'s prefix tolerance would serve
 * "12abc"/"0x10" ranges Go rejects), the ASCII-space trims of
 * textproto.TrimString, the If-Range method gate (fs.go:585-587), and the
 * error-path header surgery — serveError (fs.go:188-211) DELETES
 * Cache-Control/Content-Encoding/Etag/Last-Modified before http.Error
 * (server.go:2337-2357) resets Content-Type/Content-Length/nosniff (the
 * GODEBUG=httpservecontentkeepheaders default; gitea's build sets no
 * override, and writeNotModified, fs.go:627-642, also drops
 * Content-Encoding). Accept-Ranges: bytes lands AFTER the range switch
 * (fs.go:396) — 200/206 only, never on the 304/412/416 error arms.
 *
 * The date validation is the shared module's Go time.Parse port
 * (parseHttpTimeFormat — strict IMF-fixdate, range-checked: "31 Feb 2024"
 * errors where JS `Date.parse` silently rolls over into March), imported from
 * the shared serve pipeline — one parser for both consumers (the former local
 * mirror's code was byte-identical; only its doc prose differed).
 */

import { parseHttpTimeFormat, serveSetHeaders } from "../../web/attachments-serving";

// ---------------------------------------------------------------------------
// ServeSetHeaders — the shared pipeline's header set (serve.go:56-105 +
// httpcache.go:23-38), fed with the packages-specific inputs
// ---------------------------------------------------------------------------

export interface ServeFileHeaderOptions {
  /** Unset = no disposition and no expose-headers echo (the maven HEAD
   *  posture, maven.go:219-222 — SetServeHeaders runs before Filename lands). */
  filename?: string;
  /** The registry's own override (maven's jar/xml, swift's text/x-swift, the
   *  key arms' pgp-keys/pem); unset/"" floors to application/octet-stream
   *  (serve.go:58) inside the shared table. */
  contentType?: string;
  size: number;
  /** The file row's creation time → Last-Modified. ABSENT = upstream's zero
   *  ServeHeaderOptions.LastModified (the repository-key arms, the chef .priv
   *  download): no Last-Modified header, the If-(Un)Modified-Since checks
   *  inert (Go isZeroTime — the zero time and Unix epoch both), and a
   *  date-form If-Range never matches. */
  created?: Date;
}

/**
 * `ServeSetHeaders` (serve.go:77-105) through the shared pipeline: the header
 * SET every package-file download carries — nosniff, the CSP branch on the
 * resolved type, the ATTACHMENT disposition over `path.Base(filename)`
 * (serve.go:92) with the RFC 2231 `filename*` twin (content_disposition.go),
 * the `Access-Control-Expose-Headers` echo, the zero-duration Cache-Control
 * prod posture (`max-age=0, private, must-revalidate`, httpcache.go:31-35 —
 * packages never set IsPublic or a MaxAge), Content-Length, and Last-Modified
 * from the file row (skipped when `created` is absent — setLastModified's
 * isZeroTime arm).
 */
export function serveFileHeaderSet(opts: ServeFileHeaderOptions): Record<string, string> {
  return serveSetHeaders({
    filename: opts.filename,
    contentType: opts.contentType,
    contentLength: opts.size,
    lastModified: opts.created ?? null,
  });
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

/** textproto.TrimString (textproto.go:127-136): ASCII space only — SP, TAB,
 *  LF, VT, FF, CR. JS String.trim's Unicode set is wider and would accept
 *  spec forms Go rejects. */
function trimAsciiSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && " \t\n\v\f\r".includes(text.charAt(start))) start++;
  while (end > start && " \t\n\v\f\r".includes(text.charAt(end - 1))) end--;
  return text.slice(start, end);
}

/**
 * strconv.ParseInt(text, 10, 64) — whole-string decimal, optional +/- sign,
 * int64 bounds (`[-2^63, 2^63-1]`, out-of-range is an error like any other
 * invalid form). `Number.parseInt` is prefix-tolerant ("12abc" → 12, "0x10"
 * → 0, "1e3" → 1000) and would serve byte-ranges Go answers 416 to; the
 * result rides BigInt so the int64 magnitudes a real size never reaches
 * (hence exactness never matters downstream) still pass the range check like
 * Go's.
 */
function parseGoInt64(text: string): bigint | null {
  const match = /^[+-]?[0-9]+$/.exec(text);
  if (match === null) return null;
  const value = BigInt(text);
  if (value > 2n ** 63n - 1n || value < -(2n ** 63n)) return null;
  return value;
}

/** `parseRange` (net/http/fs.go) reduced to the single-range shape (the
 *  multi-range multipart answer is the documented divergence — the caller
 *  falls back to the full 200). Each arm carries fs.go's cite; the integer
 *  grammar is ParseInt-exact (the helper above), the trims are
 *  textproto.TrimString-exact. */
function parseSingleRange(header: string, size: number): ByteRange[] | "invalid" | "no-overlap" {
  const prefix = "bytes=";
  if (!header.startsWith(prefix)) return "invalid";
  const ranges: ByteRange[] = [];
  let noOverlap = false;
  for (const segment of header.slice(prefix.length).split(",")) {
    const raw = trimAsciiSpace(segment);
    if (raw === "") continue;
    // strings.Cut at the FIRST dash: a second dash rides into endText and
    // fails the integer parse ("5-10-15" is invalid, never a nested range).
    const dash = raw.indexOf("-");
    if (dash < 0) return "invalid";
    const startText = trimAsciiSpace(raw.slice(0, dash));
    const endText = trimAsciiSpace(raw.slice(dash + 1));
    if (startText === "") {
      // Suffix form `bytes=-N`: the last N bytes, clamped at the size — the
      // explicit `end[0] == '-'` gate fires before the parse (fs.go:1043-1046).
      if (endText === "" || endText.charAt(0) === "-") return "invalid";
      const suffix = parseGoInt64(endText);
      if (suffix === null || suffix < 0n) return "invalid";
      const clamped = suffix > size ? BigInt(size) : suffix;
      const start = size - Number(clamped);
      ranges.push({ start, length: size - start });
      continue;
    }
    const startValue = parseGoInt64(startText);
    if (startValue === null || startValue < 0n) return "invalid";
    if (startValue >= size) {
      // The range begins after the size of the content — no overlap.
      noOverlap = true;
      continue;
    }
    // `startValue < size` (≤ MAX_SAFE_INTEGER in practice) — exact as a number.
    const start = Number(startValue);
    if (endText === "") {
      // No end: the range extends to the end of the file.
      ranges.push({ start, length: size - start });
      continue;
    }
    const endValue = parseGoInt64(endText);
    if (endValue === null || start > endValue) return "invalid";
    const clampedEnd = endValue >= size ? BigInt(size - 1) : endValue;
    ranges.push({ start, length: Number(clampedEnd) - start + 1 });
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
 * If-Range gating the Range header (GET/HEAD only — fs.go:585-587; any other
 * method honors the Range regardless). Second-truncation of the modtime
 * mirrors Go's `modtime.Truncate(time.Second)`; the date validation is Go
 * time.Parse-exact (the shared module's strict fixdate parser,
 * parseHttpTimeFormat — a rolled "31 Feb" must not 304/412 where Go serves
 * 200). `created` absent = the zero modtime: If-Unmodified-Since /
 * If-Modified-Since go condNone (fs.go's isZeroTime covers the zero time AND
 * the Unix epoch) and a date-form If-Range never matches (fs.go:601-603
 * checks the STRICT IsZero — an epoch-zero modtime still compares).
 */
export function planByteServing(request: Request, size: number, created?: Date): ByteServingPlan {
  const method = request.method;
  const isGetOrHead = method === "GET" || method === "HEAD";
  const headers = request.headers;
  // Last-Modified truncates sub-second precision; compare in whole seconds.
  // `null` = Go's zero time (the created-less arms). The If-(Un)Modified-Since
  // arms additionally treat epoch zero as unspecified (isZeroTime,
  // fs.go:618-621 — the zero time AND the Unix epoch).
  const modSec = created === undefined ? null : Math.floor(created.getTime() / 1000);

  // 1. If-Match; If-Unmodified-Since only when If-Match is absent.
  const ifMatch = headers.get("If-Match") ?? "";
  if (ifMatch !== "") {
    if (!etagListMatches(ifMatch)) return { kind: "precondition-failed" };
  } else {
    const ifUnmodifiedSince = headers.get("If-Unmodified-Since") ?? "";
    if (ifUnmodifiedSince !== "" && modSec !== null && modSec !== 0) {
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
    if (ifModifiedSince !== "" && modSec !== null && modSec !== 0) {
      const date = parseHttpTimeFormat(ifModifiedSince);
      if (date !== null && modSec <= Math.floor(date / 1000)) return { kind: "not-modified" };
    }
  }

  // 3. Range, gated by If-Range (an ETag-shaped If-Range never matches our
  //    ETag-less files; a date If-Range matches on whole seconds; the strict
  //    zero modtime never matches — fs.go:601-603; non-GET/HEAD skips the
  //    gate entirely — fs.go:585-587).
  let rangeHeader = headers.get("Range") ?? "";
  if (rangeHeader !== "" && isGetOrHead) {
    const ifRange = headers.get("If-Range") ?? "";
    if (ifRange !== "") {
      const asEtag = scanEtag(ifRange);
      const date = asEtag === null && modSec !== null ? parseHttpTimeFormat(ifRange) : null;
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
    // writeNotModified (fs.go:627-642): drop the representation headers
    // (Content-Type, Content-Length, Content-Encoding), keep the rest —
    // Last-Modified survives (no ETag on files).
    const notModified = new Headers(headers);
    notModified.delete("content-type");
    notModified.delete("content-length");
    notModified.delete("content-encoding");
    return new Response(null, { status: 304, headers: notModified });
  }
  if (plan.kind === "precondition-failed") {
    // Go's checkPreconditions writes the bare 412 over the set headers.
    return new Response(null, { status: 412, headers: new Headers(headers) });
  }
  if (plan.kind === "range-unsatisfiable") {
    // serveError (fs.go:188-211) THEN http.Error (server.go:2337-2357): the
    // success-oriented Cache-Control/Content-Encoding/Etag/Last-Modified are
    // deleted first (the GODEBUG=httpservecontentkeepheaders default — gitea's
    // go 1.27 build sets no override), then CL deleted, CT reset, nosniff and
    // the `message\n` body. The CSP, the disposition and the `bytes */size`
    // Content-Range survive (in neither delete list).
    const unsatisfiable = new Headers(headers);
    unsatisfiable.delete("cache-control");
    unsatisfiable.delete("content-encoding");
    unsatisfiable.delete("etag");
    unsatisfiable.delete("last-modified");
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
// (The former re-export block for the routes' direct disposition sites is
// gone: the debian/alpine/rpm/arch repository-key arms and the chef .priv
// download now ride servePackageFileResponse themselves — upstream's
// ctx.ServeContent — so no direct disposition site remains to share it.)
// ---------------------------------------------------------------------------

/**
 * The releases download tail — the parity survey's row 2 (top-5 #1): the
 * web mux's release-asset serving routes over the landed release-assets
 * service data, upstream
 *
 *   GET /{owner}/{repo}/releases/download/{vTag}/{fileName}
 *                                   web.go:1514 repo.RedirectDownload
 *                                   (routers/web/repo/repo.go:303-347)
 *   GET /{owner}/{repo}/releases/attachments/{uuid}
 *                                   web.go:1513 repo.GetAttachment
 *                                   (routers/web/repo/attachment.go:244-246
 *                                   → ServeAttachment attachment.go:220-336)
 *
 * both under the releases group's gates (web.go:1505-1514): `optSignIn`,
 * `context.RepoAssignment` (the §2.5 prologue), `repo.MustBeNotEmpty` and
 * `reqRepoReleaseReader` — the landed `hasReleases` unit gate (the
 * releasesReadGate arm, the releases pages' own gate; a disabled unit is
 * upstream `perm.CanRead(TypeReleases)` false → 404).
 *
 * ## ServeAttachment, ported (attachment.go:220-336)
 *
 *   - uuid lookup → missing: 404; the attachment's repo must equal the URL's
 *     repo (attachment.go:282-285) → 404;
 *   - the draft gate (attachment.go:295-311): a DRAFT release's attachments
 *     404 for viewers without release-write access — the UUID links must not
 *     leak draft binaries (the API-side canAccessReleaseDraft mirror);
 *   - `IncreaseDownloadCount` (attachment.go:338) — one D1 counter UPDATE;
 *     a failed update is upstream's ServerError class (the plain 500);
 *   - ServeDirect (presigned redirect) does not exist on the R2 binding —
 *     every response streams the object body (the AGENTS no-buffer rule);
 *   - the httpcache pair (attachment.go:364
 *     HandleGenericETagPrivateCache): strong ETag `"{uuid}"` + Last-Modified
 *     (the row's createdAt), If-None-Match (comma list, `W/`-insensitive, `*`)
 *     or If-Modified-Since (ignored when INM is present) answer 304 with
 *     `Cache-Control: private, max-age=21600` (CacheControlForPrivateStatic →
 *     STATIC_CACHE_TIME 6 h, setting/server.go:254);
 *   - the 200 rides httplib.ServeUserContentByFile (attachment.go:366-368):
 *     the first 1024 bytes are prefetched and SNIFFED (mimeDetectionBufferLen,
 *     serve.go:203-233 — the prefix is re-streamed ahead of the body, nothing
 *     is buffered whole); the sniffed class decides the content type
 *     (serve.go:118-134 serveSetHeadersByUserContent): browsable binary
 *     (image/svg/pdf/video/audio) keeps its mime, ANY text is forced to
 *     `text/plain` (user HTML never renders as a page — the security point),
 *     everything else is `application/octet-stream`;
 *   - ServeSetHeaders' matrix (serve.go:88-105): `X-Content-Type-Options:
 *     nosniff`, the sandbox CSP (serve.go:59-72 serveSetHeaderContentRelated:
 *     `sandbox allow-scripts allow-modals allow-popups allow-downloads`, the
 *     PDF variant `default-src 'none'; style-src 'unsafe-inline'`, audio/
 *     video DELIVERS no CSP), `Content-Length`, the Content-Disposition
 *     (inline — the sniffed default serve.go:135-141; UI.SVG.Enabled defaults
 *     true, setting/ui.go:120-123, so even SVG stays inline) encoded per
 *     content_disposition.go, `Access-Control-Expose-Headers:
 *     Content-Disposition`, Last-Modified, and the zero-option prod
 *     Cache-Control OVERWRITE (the archive family's documented posture —
 *     ServeSetHeaders runs after the ETag gate and its
 *     `max-age=0, private, must-revalidate` replaces the 6 h value);
 *   - gzhttp's no-compression hint for the already-compressed extensions
 *     (serve.go:85-89, klauspost gzhttp.HeaderNoCompression).
 *
 * ## The sniffer (typesniffer.DetectContentType, reduced but honest)
 *
 * Upstream extends Go's http.DetectContentType (net/http/sniff.go) with SVG,
 * avif, mp3-rescue and ogg-split post-processing (typesniffer.go:88-186).
 * The port keeps the exact decision classes the serving path consumes:
 * Go's HTML signature table (leading-whitespace, case-insensitive tags),
 * `<?xml`, the byte-signature table for the browsable set (pdf/png/jpeg/gif/
 * bmp/ico/webp/wave/webm/mp3/mp4-ftyp + gitea's avif brand override), the
 * UTF-16 BOMs, and the final text/binary mask (textSig — the `<=0x08, 0x0B,
 * 0x0E-0x1A, 0x1C-0x1F` byte test over the first 512 bytes from the first
 * non-whitespace byte). Reduced, documented: the EOT font re-check and the
 * charset detection beyond the BOM (x/text encodings) are not ported — text
 * lands `text/plain; charset=utf-8` unless a UTF-16 BOM says otherwise.
 *
 * ## RedirectDownload (repo.go:303-347)
 *
 * The {vTag}/{fileName} pair resolves through `FindReleases{RepoID,
 * TagNames: [vTag], IncludeDrafts: canWrite}` — an EXACT (case-sensitive,
 * is_tag=false) tag match, drafts visible to writers only — then
 * `GetAttachmentByReleaseIDFileName` (exact name, attachment.go:165-171);
 * zero matches and the literal `latest` alias falls to
 * `GetLatestReleaseByRepoID` (the GitHub alias, repo.go:330-345 — the landed
 * findLatestRelease's exact filters). Every miss is upstream's
 * ctx.HTTPError(404) — the §4.5 404 shell, like every ui download.
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { releaseAssets, releases } from "../../db/schema";
import { findLatestRelease } from "../../api/services/releases";
import type { ReleaseRow } from "../../issues/service";

// ---------------------------------------------------------------------------
// The sniffer (typesniffer.DetectContentType — module header)
// ---------------------------------------------------------------------------

/** Go's sniffLen (net/http/sniff.go) — the text/binary mask window. */
const SNIFF_LEN = 512;

/** Gitea's SniffContentSize (typesniffer.go:14) — the prefetch window. */
export const SNIFF_CONTENT_SIZE = 1024;

function startsWith(data: Uint8Array, prefix: number[]): boolean {
  if (data.length < prefix.length) return false;
  return prefix.every((byte, index) => data[index] === byte);
}

/** Go's isWS (sniff.go): \t \n \f \r space. */
function isWs(byte: number): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

/** The ftyp box brands (typesniffer.go detectFileTypeBox) — avif overrides. */
function ftypBrand(data: Uint8Array): string | null {
  if (data.length < 12) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const boxSize = view.getUint32(0);
  if (boxSize < 12 || boxSize > data.length) return null;
  const tag = String.fromCharCode(data[4] as number, data[5] as number, data[6] as number, data[7] as number);
  if (tag !== "ftyp") return null;
  return String.fromCharCode(data[8] as number, data[9] as number, data[10] as number, data[11] as number);
}

const SVG_COMMENT_RE = /<!--[\s\S]*?-->/g;
/** typesniffer.go's svgTagRegex (HTML-ish) and svgTagInXMLRegex (XML prolog). */
const SVG_TAG_RE = /^\s*(?:(?:<!DOCTYPE\s+svg(?:[\s:]+[\s\S]*?>|>))\s*)*<svg\b/i;
const SVG_TAG_IN_XML_RE = /^<\?xml\b[\s\S]*?\?>\s*(?:(?:<!DOCTYPE\s+svg(?:[\s:]+[\s\S]*?>|>))\s*)*<svg\b/i;

/** Go http.DetectContentType's HTML signature tags (net/http/sniff.go
 *  htmlSigs — leading whitespace skipped, tags case-insensitive; `<A`/`<B`
 *  are prefix tests exactly like the Go table's byte-prefix match). */
const HTML_TAG_RE = /^[\t\n\f\r ]*<(?:!DOCTYPE[\t\n\f\r ]+HTML|HTML|HEAD|SCRIPT|IFRAME|H1|DIV|FONT|TABLE|A|STYLE|TITLE|B|BODY|BR|P)/i;

/** The sniffed content type of one prefetch buffer (≤ 1024 bytes) — the
 *  reduced DetectContentType port (module header). The value feeds
 *  serveSetHeadersByUserContent's class decision, never rendered directly. */
export function sniffContentType(head: Uint8Array): string {
  if (head.length === 0) return "text/plain";
  // Go caps the sniff at sniffLen BEFORE matching.
  const data = head.length > SNIFF_LEN ? head.subarray(0, SNIFF_LEN) : head;
  const latin = (bytes: Uint8Array): string => {
    let out = "";
    for (const byte of bytes) out += String.fromCharCode(byte);
    return out;
  };
  let ct: string;
  const text = latin(data);
  if (HTML_TAG_RE.test(text) || text.startsWith("<!--")) {
    ct = "text/html; charset=utf-8";
  } else if (/^[\t\n\f\r ]*<\?xml/i.test(text)) {
    ct = "text/xml; charset=utf-8";
  } else if (startsWith(data, [0xfe, 0xff])) {
    ct = "text/plain; charset=utf-16be";
  } else if (startsWith(data, [0xff, 0xfe])) {
    ct = "text/plain; charset=utf-16le";
  } else if (startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    ct = "application/pdf"; // %PDF-
  } else if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    ct = "image/png";
  } else if (startsWith(data, [0xff, 0xd8, 0xff])) {
    ct = "image/jpeg";
  } else if (startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    ct = "image/gif"; // GIF87a / GIF89a
  } else if (startsWith(data, [0x42, 0x4d])) {
    ct = "image/bmp"; // BM
  } else if (startsWith(data, [0x00, 0x00, 0x01, 0x00])) {
    ct = "image/x-icon";
  } else if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    ct = "image/webp"; // RIFF....WEBP
  } else if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data.subarray(8), [0x57, 0x41, 0x56, 0x45])) {
    ct = "audio/wave"; // RIFF....WAVE
  } else if (startsWith(data, [0x1a, 0x45, 0xdf, 0xa3])) {
    ct = "video/webm";
  } else if (startsWith(data, [0x4f, 0x67, 0x67, 0x53, 0x00])) {
    ct = "application/ogg"; // OggS\0 — split below
  } else if (startsWith(data, [0x49, 0x44, 0x33]) || startsWith(data, [0xff, 0xfb]) || startsWith(data, [0xff, 0xf3]) || startsWith(data, [0xff, 0xf2])) {
    ct = "audio/mpeg"; // ID3 / 0xFF 0xFB|F3|F2
  } else if (startsWith(data, [0x25, 0x21, 0x50, 0x53, 0x2d, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x2d])) {
    ct = "application/postscript"; // %!PS-Adobe-
  } else {
    const brand = ftypBrand(data);
    ct = brand === null ? "" : brand === "avif" ? "image/avif" : "video/mp4";
    if (ct === "") {
      // textSig (sniff.go's fallback): the binary mask over the bytes from
      // the first non-whitespace one.
      let firstNonWs = 0;
      while (firstNonWs < data.length && isWs(data[firstNonWs] as number)) firstNonWs += 1;
      ct = "text/plain; charset=utf-8";
      for (let i = firstNonWs; i < data.length; i++) {
        const byte = data[i] as number;
        if (byte <= 0x08 || byte === 0x0b || (0x0e <= byte && byte <= 0x1a) || (0x1c <= byte && byte <= 0x1f)) {
          ct = "application/octet-stream";
          break;
        }
      }
    }
  }

  // --- Gitea's post-processing (typesniffer.go:133-183) ---
  if (ct === "audio/mpeg" && startsWith(data, [0x49, 0x44, 0x33])) {
    // The ID3 prefix rescues text content that merely starts like an MP3.
    const rest = latin(data.subarray(3));
    if (binaryMask(rest)) ct = "text/plain; charset=utf-8";
  }
  if (ct === "application/ogg") {
    const head256 = latin(data.subarray(0, Math.min(data.length, 256)));
    ct = head256.includes("theora") || head256.includes("dirac") ? "video/ogg" : "audio/ogg";
  }
  const detectByHtml = ct.startsWith("text/plain") || ct.startsWith("text/html");
  const detectByXml = ct.startsWith("text/xml");
  if (detectByHtml || detectByXml) {
    const processed = latin(head).replace(SVG_COMMENT_RE, "").trim();
    if ((detectByHtml && SVG_TAG_RE.test(processed)) || (detectByXml && SVG_TAG_IN_XML_RE.test(processed))) {
      ct = "image/svg+xml";
    }
  }
  return ct;
}

/** The textSig mask over a latin-1 string (the mp3-rescue arm's reuse). */
function binaryMask(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) return true; // non-latin1 → binary for this purpose
    if (code <= 0x08 || code === 0x0b || (0x0e <= code && code <= 0x1a) || (0x1c <= code && code <= 0x1f)) return true;
  }
  return false;
}

/** serveSetHeadersByUserContent's class decision (serve.go:118-134): the
 *  browsable binary keeps its sniffed mime, ANY text is forced to plain
 *  (with the charset the BOM carries), everything else is octet-stream. */
export function userContentType(ct: string): string {
  const browsable =
    ct.startsWith("image/") || ct.startsWith("video/") || ct.startsWith("audio/") || ct === "application/pdf";
  if (browsable) return ct.split(";")[0] ?? ct;
  if (ct.startsWith("text/")) {
    const utf16 = ct.includes("utf-16le") ? "; charset=utf-16le" : ct.includes("utf-16be") ? "; charset=utf-16be" : "; charset=utf-8";
    return `text/plain${utf16}`;
  }
  return "application/octet-stream";
}

/** serveSetHeaderContentRelated's CSP matrix (serve.go:59-72). */
export function userContentCsp(contentType: string): string | null {
  if (contentType.startsWith("application/pdf")) return "default-src 'none'; style-src 'unsafe-inline'";
  if (contentType.startsWith("video/") || contentType.startsWith("audio/")) return null;
  return "sandbox allow-scripts allow-modals allow-popups allow-downloads";
}

// ---------------------------------------------------------------------------
// Content-Disposition (modules/httplib/content_disposition.go)
// ---------------------------------------------------------------------------

/** getSafeName (content_disposition.go:23-33): invalid chars → `_`. */
function dispositionSafeName(name: string): { safe: string; needsEncoding: boolean } {
  let safe = "";
  let needsEncoding = false;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0x7f;
    if ((code < 0x20 || code > 0x7e) && code !== 0x09) {
      needsEncoding = true;
      safe += "_";
    } else {
      safe += char;
    }
  }
  return { safe, needsEncoding };
}

/** mime.FormatMediaType's quoted-token decision for the filename value
 *  (content_disposition_test.go's table: token chars bare, ` ():/,;<=>?@[]`
 *  quoted, `"\` escaped). */
function dispositionValue(value: string): string {
  if (/^[^ ();/,;<=>?@[\]"\\]+$/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

/** RFC 2231's attr-char percent-encoding (mime package's encoding). */
function dispositionUtf8Value(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const isAttrChar =
      (0x41 <= byte && byte <= 0x5a) || (0x61 <= byte && byte <= 0x7a) || (0x30 <= byte && byte <= 0x39) ||
      byte === 0x21 || byte === 0x23 || byte === 0x24 || byte === 0x26 || byte === 0x2b || byte === 0x2d ||
      byte === 0x2e || byte === 0x5e || byte === 0x5f || byte === 0x60 || byte === 0x7c || byte === 0x7e;
    out += isAttrChar ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** encodeContentDisposition (content_disposition.go:47-65) — the safe name
 *  always first, the RFC 5987 `filename*` appended when encoding happened. */
export function encodeContentDisposition(disposition: string, filename: string): string {
  const { safe, needsEncoding } = dispositionSafeName(filename);
  const base = `${disposition}; filename=${dispositionValue(safe)}`;
  if (!needsEncoding) return base;
  return `${base}; filename*=utf-8''${dispositionUtf8Value(filename)}`;
}

// ---------------------------------------------------------------------------
// The cache pair (httpcache.HandleGenericETagPrivateCache)
// ---------------------------------------------------------------------------

/** CacheControlForPrivateStatic's prod value — STATIC_CACHE_TIME 6 h. */
const PRIVATE_STATIC_CACHE_CONTROL = "private, max-age=21600";

/** The web middleware's zero-option prod stamp — the 200's Cache-Control
 *  (ServeSetHeaders runs after the ETag gate and OVERWRITES the 6 h value,
 *  the archive family's documented posture). */
const WEB_CACHE_CONTROL = "max-age=0, private, must-revalidate";

/** checkIfNoneMatchIsValid (httpcache.go:70-86): comma list, `W/`
 *  prefix-insensitive compare, `*` matches. */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const trimmed = ifNoneMatch.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;
  const bare = etag.replace(/^W\//, "");
  return trimmed.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === bare);
}

/** http.TimeFormat emission (UTC RFC 1123 — Date.toUTCString's exact shape). */
export function httpTime(time: Date): string {
  return time.toUTCString();
}

/** One serving outcome: the streamed object (sniff prefix split off) or the
 *  404 family (the §4.5 shell — the module header). */
export type ReleaseAttachmentServe =
  | {
      kind: "serve";
      /** The sniffed prefix bytes (≤ SNIFF_CONTENT_SIZE) — feeds the response
       *  headers' content decision; the stream re-emits everything. */
      prefix: Uint8Array;
      body: ReadableStream<Uint8Array>;
      /** The ACTUAL byte count (the R2 object's size — Content-Length). */
      size: number;
      /** The verbatim D1 name (Content-Disposition's filename). */
      filename: string;
      /** The row uuid — the ETag's bytes. */
      uuid: string;
      /** The row's createdAt — Last-Modified. */
      createdAt: Date;
    }
  | { kind: "not-found" };

/** The prefetch + sniff split of one R2 body: up to SNIFF_CONTENT_SIZE bytes
 *  come off the front (the sniff buffer), the remainder streams after them —
 *  never more than the window is held (serve.go:203-233's ReadAtMost +
 *  MultiReader shape). */
async function splitPrefetch(body: ReadableStream<Uint8Array>): Promise<{ prefix: Uint8Array; rest: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < SNIFF_CONTENT_SIZE) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const prefix = new Uint8Array(Math.min(total, SNIFF_CONTENT_SIZE));
  let filled = 0;
  const tails: Uint8Array[] = []; // the chunk bytes beyond the window
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, prefix.byteLength - filled);
    if (take > 0) {
      prefix.set(chunk.subarray(0, take), filled);
      filled += take;
    }
    if (chunk.byteLength > take) tails.push(chunk.subarray(take));
  }
  let tailIndex = 0;
  let prefixSent = false;
  const rest = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // The prefetch bytes re-stream first (upstream's MultiReader shape —
      // the body must carry EVERY byte, the prefix only fed the sniff).
      if (!prefixSent) {
        prefixSent = true;
        controller.enqueue(prefix);
        return;
      }
      const tail = tails[tailIndex];
      if (tail !== undefined) {
        controller.enqueue(tail);
        tailIndex += 1;
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else if (value !== undefined) controller.enqueue(value);
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
  return { prefix, rest };
}

/**
 * GET .../releases/attachments/{uuid} — ServeAttachment's gates + open
 * (module header): the row must exist, belong to this repo, and — for a
 * DRAFT release — the viewer needs release-write access; then the download
 * counter moves and the R2 object opens (missing object → the 404 family:
 * storage under the row is the confirmed-bytes invariant, but a drifted
 * bucket must not leak a fabricated stream).
 */
export async function openReleaseAttachment(
  bucket: R2Bucket,
  d1: D1Database,
  repo: { id: string },
  uuid: string,
  options: { canWriteReleases: boolean },
): Promise<ReleaseAttachmentServe> {
  const row = await drizzle(d1).select().from(releaseAssets).where(eq(releaseAssets.uuid, uuid)).limit(1).get();
  if (row === undefined) return { kind: "not-found" }; // GetAttachmentByUUID's miss
  if (row.repoId !== repo.id) return { kind: "not-found" }; // attachment.go:282-285's repo match
  // The draft gate (attachment.go:295-311) — draft binaries ride the write
  // grant exactly like the release page itself.
  if (row.releaseId !== 0 && !options.canWriteReleases) {
    const release = await findReleaseById(d1, row.releaseId);
    if (release === null || release.isDraft) return { kind: "not-found" };
  }
  // IncreaseDownloadCount (attachment.go:338) — one UPDATE; a failure
  // propagates (upstream ServerError → the 500 class, never a fabricated 4xx).
  await drizzle(d1)
    .update(releaseAssets)
    .set({ downloadCount: sql`${releaseAssets.downloadCount} + 1` })
    .where(eq(releaseAssets.id, row.id));
  const object = await bucket.get(row.r2Key);
  if (object === null) return { kind: "not-found" };
  // The R2 binding types the body's element loosely (`ReadableStream<any>`);
  // the wire contract here is bytes (markdown.ts's readLimitedText posture).
  const { prefix, rest } = await splitPrefetch(object.body as ReadableStream<Uint8Array>);
  return {
    kind: "serve",
    prefix,
    body: rest,
    size: object.size,
    filename: row.name,
    uuid: row.uuid,
    createdAt: row.createdAt ?? new Date(0),
  };
}

/** `GetReleaseByID` for the draft gate (a plain id read). */
async function findReleaseById(d1: D1Database, id: number): Promise<ReleaseRow | null> {
  const rows = await drizzle(d1).select().from(releases).where(eq(releases.id, id)).limit(1).all();
  return rows[0] ?? null;
}

/**
 * GET .../releases/download/{vTag}/{fileName} — RedirectDownload (repo.go:
 * 303-347): the EXACT tag-name find (case-sensitive, tag-only records
 * excluded, drafts only for writers — FindReleases' ToConds verbatim), then
 * the release's attachment by exact name; zero releases and the literal
 * `latest` falls to GetLatestReleaseByRepoID (the GitHub alias). Every miss
 * is the 404 family.
 */
export async function loadReleaseDownload(
  bucket: R2Bucket,
  d1: D1Database,
  repo: { id: string },
  vTag: string,
  fileName: string,
  options: { canWriteReleases: boolean },
): Promise<ReleaseAttachmentServe> {
  const conditions = [eq(releases.repoId, repo.id), eq(releases.isTag, false), eq(releases.tagName, vTag)];
  if (!options.canWriteReleases) conditions.push(eq(releases.isDraft, false));
  const found = await drizzle(d1)
    .select()
    .from(releases)
    .where(and(...conditions))
    .limit(2)
    .all();
  // Upstream acts on `len(releases) == 1` exactly (repo.go:318) — a
  // duplicated tag row would refuse rather than guess.
  let release: ReleaseRow | null = found.length === 1 ? (found[0] ?? null) : null;
  if (release === null && vTag === "latest") {
    release = await findLatestRelease(d1, repo.id); // the alias arm (repo.go:330-345)
  }
  if (release === null) return { kind: "not-found" };
  const asset = await drizzle(d1)
    .select()
    .from(releaseAssets)
    .where(and(eq(releaseAssets.releaseId, release.id), eq(releaseAssets.name, fileName)))
    .limit(1)
    .get();
  if (asset === undefined) return { kind: "not-found" }; // GetAttachmentByReleaseIDFileName's miss
  return openReleaseAttachment(bucket, d1, repo, asset.uuid, options);
}

// ---------------------------------------------------------------------------
// The response builders
// ---------------------------------------------------------------------------

/** The skip-compression extensions (serve.go:85-89 — gzhttp's no-compression
 *  hint carries the value "1"). */
const SKIP_COMPRESSION_EXTS = new Set([".gz", ".bz2", ".zip", ".xz", ".zst", ".deb", ".apk", ".jar", ".png", ".jpg", ".webp"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * The serve Response — the module header's matrix. The 304 arm
 * (HandleGenericETagPrivateCache) answers the ETag/If-Modified-Since pair
 * with the 6 h private cache; the 200 streams the body with the sniffed
 * content headers and the overwritten zero-option Cache-Control.
 */
export function releaseAttachmentResponse(
  serve: Extract<ReleaseAttachmentServe, { kind: "serve" }>,
  options: { ifNoneMatch: string | null; ifModifiedSince: string | null },
): Response {
  const etag = `"${serve.uuid}"`;
  const lastModified = httpTime(serve.createdAt);
  const contentType = userContentType(sniffContentType(serve.prefix));
  const headers = new Headers();
  headers.set("etag", etag);
  headers.set("last-modified", lastModified);
  if (options.ifNoneMatch !== null && etagMatches(options.ifNoneMatch, etag)) {
    headers.set("cache-control", PRIVATE_STATIC_CACHE_CONTROL);
    return new Response(null, { status: 304, headers });
  }
  // The If-Modified-Since arm — ignored when If-None-Match is present
  // (httpcache.go:104-113).
  if (options.ifNoneMatch === null && options.ifModifiedSince !== null && options.ifModifiedSince !== "") {
    const since = new Date(options.ifModifiedSince);
    if (!Number.isNaN(since.getTime()) && Math.floor(serve.createdAt.getTime() / 1000) <= Math.floor(since.getTime() / 1000)) {
      headers.set("cache-control", PRIVATE_STATIC_CACHE_CONTROL);
      return new Response(null, { status: 304, headers });
    }
  }
  headers.set("content-type", contentType);
  headers.set("x-content-type-options", "nosniff");
  const csp = userContentCsp(contentType);
  if (csp === null) headers.delete("content-security-policy");
  else headers.set("content-security-policy", csp);
  headers.set("content-length", String(serve.size));
  // The sniffed disposition: inline (UI.SVG.Enabled default keeps SVG inline
  // too — serve.go:135-141; the disposition encoding is content_disposition.go's).
  headers.set("content-disposition", encodeContentDisposition("inline", serve.filename));
  headers.set("access-control-expose-headers", "Content-Disposition");
  if (SKIP_COMPRESSION_EXTS.has(extensionOf(serve.filename))) headers.set("x-no-compression", "1");
  headers.set("cache-control", WEB_CACHE_CONTROL);
  return new Response(serve.body, { status: 200, headers });
}

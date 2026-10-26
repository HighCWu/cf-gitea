import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { issueAttachments, issues, releaseAssets, releases, repositories, users } from "../db/schema";
import { basicAuthTokenCandidate, parseAuthorizationHeader } from "../auth/httpauth";
import { D1FailureLimiter } from "../auth/failure-limiter";
import {
  limiterCheckFailOpen,
  limiterRecordFailureFailOpen,
  limiterResetFailOpen,
} from "../auth/middleware";
import { ScopeSet } from "../auth/scopes";
import { TokenService } from "../auth/token-service";
import { doerRepoAccessMode } from "../api/services/repository";
import { collaboratorModeOf } from "../api/services/repo-collaborators";
// The read-grant predicate of SPEC-0010 §2.6 — exactly one copy shared by the
// git-HTTP matrix and the UI page resolution; this web seam rides it too, so
// page visibility, git-HTTP visibility, and attachment visibility cannot drift.
import { readGrant } from "../git-http/acl";

/**
 * The site-level attachment-serving seam — the surveyed web family
 * `GET, OPTIONS /attachments/{uuid}` (web.go:912, `webAuth.AllowBasic,
 * webAuth.AllowOAuth2`, handler repo.GetAttachment). These are WEB routes,
 * not /api/v1 ops: upstream mounts them on the web mux, the frozen OpenAPI
 * contract has no operation for them, and the traffic is the browser
 * dereferencing the `browser_download_url` both landed attachment families
 * emit (routes/issue-attachments.ts toApiAttachment, api/services/
 * release-assets.ts render — both `.../attachments/<encodeURIComponent(uuid)>`).
 * A plain Hono sub-app outside the zod-openapi tier, like avatar-serving.
 *
 * THE HANDLER (routers/web/repo/attachment.go:135-241 ServeAttachment, port
 * order preserved — the arms are status-code ordered):
 *
 *   1. GetAttachmentByUUID (models/repo/attachment.go) — miss → 404.
 *      Upstream has ONE `attachment` table; cf-gitea split it (issue half =
 *      `issue_attachments`, SPEC-0005 §3.3; release half = `release_assets`,
 *      §3.2 — different storage path/flow), so the uuid resolution reads both
 *      halves (issue first). UUIDs are crypto-random, so the split cannot
 *      collide.
 *   2. GetAttachmentLinkedTypeAndRepoID (services/repository/repository.go:
 *      207-229): issue → unit TypeIssues/TypePullRequests (issue.IsPull) +
 *      issue.RepoID; release → TypeReleases + rel.RepoID; else TypeInvalid.
 *      A dangling issue/release row is a ServerError → 500 upstream.
 *   3. Repo-mismatch arm (:154-157) only fires when ctx.Repo.Repository is
 *      resolved — this site-level route has none (web.go:912 sits outside
 *      RepoAssignment), so the arm is dead here (it guards the
 *      /{username}/{reponame}/attachments/{uuid} compatibility twin,
 *      web.go:1529-1532, not landed — see OPEN ISSUES).
 *   4. TypeInvalid arm (:159-163): an unlinked attachment serves to its
 *      uploader only, everyone else 404. Structurally unreachable in
 *      cf-gitea: both halves carry NOT NULL links (issue_attachments.issue_id,
 *      release_assets.release_id) — kept as a documented dead arm.
 *   5. GetRepositoryByID + GetDoerRepoPermission (:164-182) — the site route
 *      resolves the repo itself (ctx.Repo.Repository is nil). A missing repo
 *      row is the GetRepositoryByID ServerError → 500 arm; permission fails
 *      → 404 (existence hidden). The permission walk is the landed
 *      `readGrant` predicate (git-http/acl.ts, SPEC-0003 §2.4 rows 1-9 +
 *      SPEC-0010 §2.6): repo visibility × owner visibility/status ×
 *      owner/site-admin/team arms — the SAME walk the issue-attachment API
 *      reads render through requireVisibleRepo and the UI pages resolve
 *      through. Anonymous + public repo + active public owner → served
 *      (upstream: CanRead(unit.TypeIssues) on the anonymous pull permission).
 *   6. Draft-release arm (:193-203): release assets of a DRAFT release serve
 *      only to release-WRITE grants — "otherwise the UUID-based web endpoints
 *      would leak draft attachments to any recipient of the (leaked) download
 *      URL" (upstream comment). The write grant folds the landed matrix's
 *      owner/site-admin/team-write/collaborator-write arms (the
 *      canWriteRepository shape, api/services/repo-access.ts:101-119).
 *   7. CheckTokenScopes (services/context/permission.go:16-31) +
 *      attachmentReadScope (attachment.go:25-34): issues/PRs require
 *      `read:issue`, releases `read:repository`; missing scope → 403 (AFTER
 *      the 404 arms). Only token-carrying doers are checked upstream
 *      (hasApiTokenScope); cf-gitea has no sessions, so every authenticated
 *      caller is a token caller and the check always runs for them.
 *      Documented divergence: upstream's web route does NOT apply the token's
 *      public-only bit (that is an API-tier enforcement — GetDoerRepoPermission
 *      reads the user's grants), so the git-HTTP gate's maskedByPublicOnly arm
 *      is deliberately absent here.
 *   8. IncreaseDownloadCount (models/repo/attachment.go:46-53) — +1 on the
 *      row, before the bytes are served (the landed blob GET twin,
 *      routes/issue-attachments.ts:1278-1281).
 *   9. ServeDirect (:218-226) — inapplicable like avatar-serving's (the R2
 *      binding serves bytes directly, no presigned URL).
 *  10. HandleGenericETagPrivateCache (httpcache.go:81-117): ETag
 *      `"<uuid>"` + Last-Modified from CreatedUnix; If-None-Match → 304
 *      (list compare, `*`, weak-stripped); else If-Modified-Since (second
 *      precision, ignored when If-None-Match is present) → 304; the 304
 *      carries ONLY those two headers (Cache-Control is set after the checks,
 *      httpcache.go:115 — and is then immediately overwritten by the serve
 *      headers below, upstream's own order).
 *  11. storage.Open miss → ServerError 500 (:233-237); then
 *      httplib.ServeUserContentByFile (serve.go:232-240) — sniffed
 *      content-type + INLINE disposition + sandbox CSP (below).
 *
 * 404/403/500 bodies: ctx.HTTPError is Go's http.Error (services/context/
 * base.go:105-111) — bare StatusText, text/plain + nosniff; ctx.ServerError
 * renders upstream's HTML error page, answered here with a plain-text 500
 * (the avatar-serving error-page divergence).
 *
 * SERVE HEADERS (httplib/serve.go:56-105 over the sniffed type, the
 * ServeUserContentByReader 1024-byte pre-read, serve.go:148-175):
 *   - Content-Type (serveSetHeadersByUserContent, :107-144): MimeTypeMap is
 *     disabled by default → typesniffer.DetectContentType
 *     (modules/typesniffer/typesniffer.go:122-185) — Go's
 *     http.DetectContentType (net/http/sniff.go, ported verbatim below) plus
 *     Gitea's extensions: the EOT re-check, the SVG regexes, the ID3 re-fix,
 *     the avif ftyp brand, the ogg theora/dirac split. Browsable binary
 *     (image/|svg|pdf|video/|audio/) keeps its mime; text forces bare
 *     "text/plain" (never render user HTML as a page, :120-123); everything
 *     else application/octet-stream. charset: DetectEncoding's utf-8 fast
 *     path (modules/charset/charset.go:146-177 — truncated-tail trim +
 *     utf-8 validity) appends "; charset=utf-8"; the non-utf-8 chardet
 *     fallback is NOT ported — those serve bare "text/plain" (documented
 *     divergence).
 *   - Content-Disposition (:135-141): defaults to INLINE for everything —
 *     the ONLY download arm is an SVG attachment when SVG rendering is
 *     disabled (setting.UI.SVG.Enabled / ENABLE_RENDER, default TRUE,
 *     modules/setting/ui.go:120-124), so with frozen defaults SVGs also serve
 *     inline. The mission's "inline images vs download others" split is NOT
 *     upstream behavior — upstream sandboxes inline content with the CSP
 *     instead. Encoding is encodeContentDisposition (httplib/
 *     content_disposition.go:47-65) over Go mime.FormatMediaType
 *     (mime/mediatype.go): safe name (control/non-ASCII → '_', tab kept),
 *     token or quoted-string form, and the RFC 2231 `filename*=utf-8''…`
 *     twin whenever the original name needed encoding.
 *   - CSP (serveSetHeaderContentRelated, :56-74): sandbox
 *     "sandbox allow-scripts allow-modals allow-popups allow-downloads";
 *     application/pdf gets "default-src 'none'; style-src 'unsafe-inline'"
 *     (the PDF-RENDER-SANDBOX hint); video/|audio/ get NO CSP header.
 *   - Cache-Control (:96-99): opts zero value (IsPublic=false,
 *     CacheDuration=0) in prod → "max-age=0, private, must-revalidate" —
 *     this overwrites step 10's "private, max-age=21600", so the ETag pair
 *     revalidates every time (the "defaults to 5 minutes" comment on
 *     ServeHeaderOptions.CacheDuration is stale; no default is applied).
 *   - Last-Modified: the FILE mtime (serve.go:238) — the R2 object's
 *     `uploaded`, overwriting step 10's CreatedUnix value.
 *   - Access-Control-Expose-Headers: Content-Disposition (:93).
 *   - X-Content-Type-Options: nosniff (:60).
 *   - The gzhttp no-compression hint (:80-83) is an internal contract with
 *     upstream's gzip wrapper — not emitted (no gzip wrapper on Workers;
 *     Cloudflare compresses at the edge).
 *
 * Divergences (beyond the inline notes): Range/If-Range (ServeUserContentByReader's
 * minimal single-range arm, serve.go:166-229) is not ported — bodies stream
 * whole from R2, the avatar-serving precedent; and the OPTIONS method of
 * upstream's `Methods("GET, OPTIONS", optionsCorsHandler())` is not carried
 * (CORS is disabled by default so optionsCorsHandler degenerates to re-running
 * the download — a preflight would double-count downloads).
 *
 * AUTH: token/Bearer/Basic-candidate credentials via the SPEC-0002 parsers
 * (webAuth.AllowBasic/AllowOAuth2); invalid credentials degrade to anonymous
 * (upstream's web chain does not abort on auth failure) and a limiter-blocked
 * IP likewise degrades (ef2c049 fail-open; upstream has no limiter on web
 * routes at all).
 *
 * INTEGRATION (orchestrator-owned — src/index.ts, untouched here): /attachments
 * is a two-segment path, so the fetch dispatcher's repo-scoped branch
 * (`segments.length >= 2`) currently hands it to gitHttpGate, which 404s it
 * through the headless engine. Wire (beside the avatar-serving carve-out):
 *
 *     const isAttachmentServing = segments[0] === "attachments";
 *     // fold into: const isRepoScoped = ... && !isAttachmentServing;
 *     // and before the uiRouter mount:
 *     app.route("/", attachmentsServingRouter);
 */

/**
 * CacheControlForPrivateStatic's prod wire form (httpcache.go:50-54) — the
 * step-10 value that the serve headers overwrite on the 200 path (upstream
 * sets it at httpcache.go:115 and never emits it: the 304 path returns before
 * the set, the 200 path has it clobbered by SERVE_CACHE_CONTROL).
 */
export const PRIVATE_STATIC_CACHE_CONTROL = "private, max-age=21600";
/** SetCacheControlInHeader prod form for the zero-value ServeHeaderOptions
 *  (IsPublic=false, MaxAge=0 — httpcache.go:29-31): the final 200 value. */
export const SERVE_CACHE_CONTROL = "max-age=0, private, must-revalidate";
/** serveHeaderCspDefault (serve.go:44). */
const CSP_SANDBOX = "sandbox allow-scripts allow-modals allow-popups allow-downloads";
/** serveHeaderCspPdf (serve.go:50). */
const CSP_PDF = "default-src 'none'; style-src 'unsafe-inline'";
/** setting.UI.SVG.Enabled default TRUE (modules/setting/ui.go:120-124,
 *  `ENABLE_RENDER`) — the SVG→attachment disposition arm never fires. */
const SVG_RENDER_ENABLED = true;
/** ServeUserContentByReader's sniff window (serve.go:146). */
const MIME_DETECTION_BUFFER_LEN = 1024;

/** Go's http.Error (base.go:105-111 → net/http.Error): text/plain + nosniff
 *  + trailing newline. */
function textError(status: 403 | 404 | 500, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
}

const NOT_FOUND = (): Response => textError(404, "Not Found"); // http.StatusText(404)
const FORBIDDEN = (): Response => textError(403, "Forbidden");
const SERVER_ERROR = (): Response => textError(500, "Internal Server Error");

// ---------------------------------------------------------------------------
// httpcache port (modules/httpcache/httpcache.go:44-117)
// ---------------------------------------------------------------------------

/** checkIfNoneMatchIsValid (httpcache.go:57-75). */
function ifNoneMatchMatches(header: string, etag: string): boolean {
  const trimmed = header.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;
  const bare = etag.startsWith("W/") ? etag.slice(2) : etag;
  for (const item of trimmed.split(",")) {
    const candidate = item.trim();
    const stripped = candidate.startsWith("W/") ? candidate.slice(2) : candidate;
    if (stripped === bare) return true;
  }
  return false;
}

/** Strict IMF-fixdate (Go's http.TimeFormat layout) — other legal HTTP dates
 *  fail time.Parse upstream and must fail here too. */
const IMF_FIXDATE_RE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * handleGenericETagTimeCache's decision (httpcache.go:87-117): returns the
 * 304 response when handled. Headers carried on the 304 are exactly
 * ETag + Last-Modified — SetCacheControlInHeader runs only on the miss path.
 */
function genericEtagTimeCache(
  request: Request,
  etag: string,
  lastModified: Date | null,
): Response | null {
  const headers: Record<string, string> = { ETag: etag };
  if (lastModified !== null) {
    headers["Last-Modified"] = lastModified.toUTCString();
  }
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch !== null && ifNoneMatchMatches(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers });
  }
  // "A recipient MUST ignore If-Modified-Since if the request contains an
  // If-None-Match header field" (httpcache.go:102-104).
  if (lastModified !== null && ifNoneMatch === null) {
    const ifModifiedSince = request.headers.get("if-modified-since");
    if (ifModifiedSince !== null && IMF_FIXDATE_RE.test(ifModifiedSince)) {
      const since = Date.parse(ifModifiedSince);
      if (!Number.isNaN(since) && Math.floor(lastModified.getTime() / 1000) <= Math.floor(since / 1000)) {
        return new Response(null, { status: 304, headers });
      }
    }
  }
  // The miss path sets Cache-Control: PRIVATE_STATIC_CACHE_CONTROL here
  // (httpcache.go:115); the serve headers below overwrite it, so the value
  // never reaches the wire — the const is the documented intermediate.
  return null;
}

// ---------------------------------------------------------------------------
// Go mime.FormatMediaType port (mime/mediatype.go) + httplib's
// encodeContentDisposition (content_disposition.go:20-65)
// ---------------------------------------------------------------------------

/** isTSpecial (mime/grammar.go): `()<>@,;:\"/[]?=`. */
function isTSpecial(r: string): boolean {
  return `()<>@,;:\\"/[]?=`.includes(r);
}

/** isTokenChar: any US-ASCII CHAR except SPACE, CTLs, or tspecials. */
function isTokenChar(code: number): boolean {
  return code > 0x20 && code < 0x7f && !isTSpecial(String.fromCharCode(code));
}

function isToken(value: string): boolean {
  if (value === "") return false;
  for (let i = 0; i < value.length; i += 1) {
    if (!isTokenChar(value.charCodeAt(i))) return false;
  }
  return true;
}

/** needsEncoding (mime/type.go): (b < ' ' || b > '~') && b != '\t'. */
function needsEncoding(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 || code > 0x7e) && code !== 0x09) return true;
  }
  return false;
}

const UPPERHEX = "0123456789ABCDEF";

/** Byte accessor for the noUncheckedIndexedAccess view of Uint8Array — every
 *  call site is guarded by the Go port's length checks, so the `?? 0` can
 *  only observe in-bounds bytes. */
function byteAt(data: Uint8Array, index: number): number {
  return data[index] ?? 0;
}

/** The two ContentDispositionType values (content_disposition.go:16-17). */
export type ContentDispositionType = "inline" | "attachment";

/**
 * FormatMediaType(string(t), { filename: value }) — the single-parameter
 * mediatype.go path (attribute sorted sole; type/token validation skipped:
 * the caller passes a fixed ContentDispositionType and "filename"). The
 * RFC 2231 branch walks UTF-8 BYTES like Go's `len(value)`/`value[index]`
 * loop — a non-ASCII rune encodes as its UTF-8 sequence (%C3%A9 for é).
 */
function formatMediaTypeFilename(t: ContentDispositionType, value: string): string {
  if (needsEncoding(value)) {
    // RFC 2231 section 4 + 7: attribute-char excludes SPACE, CTLs, "*", "'",
    // "%", and tspecials.
    const bytes = new TextEncoder().encode(value);
    let out = `${t}; filename*=utf-8''`;
    for (let i = 0; i < bytes.length; i += 1) {
      const code = byteAt(bytes, i);
      if (code <= 0x20 || code >= 0x7f || code === 0x2a || code === 0x27 || code === 0x25 || isTSpecial(String.fromCharCode(code))) {
        out += `%${UPPERHEX[code >> 4]}${UPPERHEX[code & 0x0f]}`;
      } else {
        out += String.fromCharCode(code);
      }
    }
    return out;
  }
  if (isToken(value)) {
    return `${t}; filename=${value}`;
  }
  // quoted-string, escaping `"` and `\`
  let quoted = "";
  for (let i = 0; i < value.length; i += 1) {
    const character = value[i];
    if (character === '"' || character === "\\") quoted += "\\";
    quoted += character;
  }
  return `${t}; filename="${quoted}"`;
}

/** getSafeName (content_disposition.go:25-36) — rune-wise; non-printable and
 *  non-ASCII runes collapse to '_', tab kept, needsEncoding flagged. */
function getSafeName(name: string): { safe: string; encoded: boolean } {
  let safe = "";
  let encoded = false;
  for (const rune of name) {
    const code = rune.codePointAt(0) ?? 0;
    if ((code < 0x20 || code > 0x7e) && code !== 0x09) {
      encoded = true;
      safe += "_";
    } else {
      safe += rune;
    }
  }
  return { safe, encoded };
}

/** encodeContentDisposition (content_disposition.go:47-65): the safe-name
 *  form, plus the `; filename*=utf-8''…` suffix from the original whenever
 *  encoding is needed (the two type strings share the leading layout, so the
 *  suffix is cut at the type's length like upstream's TrimPrefix). */
export function encodeContentDisposition(t: ContentDispositionType, filename: string): string {
  const { safe, encoded } = getSafeName(filename);
  const result = formatMediaTypeFilename(t, safe);
  if (!encoded) {
    return result;
  }
  return result + formatMediaTypeFilename(t, filename).slice(t.length);
}

// ---------------------------------------------------------------------------
// Go net/http/sniff.go port (fetched at go1.24.0; the table is unchanged on
// master, which only moved it to net/http/internal) — DetectContentType
// ---------------------------------------------------------------------------

const SNIFF_LEN = 512;

function isWS(b: number): boolean {
  return b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20;
}

function isTT(b: number): boolean {
  return b === 0x20 || b === 0x3e; // ' ' or '>'
}

interface SniffSig {
  match(data: Uint8Array, firstNonWS: number): string;
}

class ExactSig implements SniffSig {
  constructor(
    private readonly sig: string,
    private readonly ct: string,
  ) {}
  match(data: Uint8Array): string {
    if (data.length < this.sig.length) return "";
    for (let i = 0; i < this.sig.length; i += 1) {
      if (byteAt(data, i) !== this.sig.charCodeAt(i)) return "";
    }
    return this.ct;
  }
}

class MaskedSig implements SniffSig {
  constructor(
    private readonly pat: string,
    private readonly mask: string,
    private readonly ct: string,
    private readonly skipWS = false,
  ) {}
  match(data: Uint8Array, firstNonWS: number): string {
    const start = this.skipWS ? firstNonWS : 0;
    if (this.pat.length !== this.mask.length) return "";
    if (data.length - start < this.pat.length) return "";
    for (let i = 0; i < this.pat.length; i += 1) {
      if ((byteAt(data, start + i) & this.mask.charCodeAt(i)) !== this.pat.charCodeAt(i)) return "";
    }
    return this.ct;
  }
}

class HtmlSig implements SniffSig {
  constructor(private readonly tag: string) {}
  match(data: Uint8Array, firstNonWS: number): string {
    const start = firstNonWS;
    if (data.length - start < this.tag.length + 1) return "";
    for (let i = 0; i < this.tag.length; i += 1) {
      const expected = this.tag.charCodeAt(i);
      let actual = byteAt(data, start + i);
      if (expected >= 0x41 && expected <= 0x5a) {
        actual &= 0xdf;
      }
      if (expected !== actual) return "";
    }
    if (!isTT(byteAt(data, start + this.tag.length))) return "";
    return "text/html; charset=utf-8";
  }
}

class Mp4Sig implements SniffSig {
  match(data: Uint8Array): string {
    if (data.length < 12) return "";
    const boxSize =
      ((byteAt(data, 0) << 24) | (byteAt(data, 1) << 16) | (byteAt(data, 2) << 8) | byteAt(data, 3)) >>> 0;
    if (data.length < boxSize || boxSize % 4 !== 0) return "";
    if (String.fromCharCode(byteAt(data, 4), byteAt(data, 5), byteAt(data, 6), byteAt(data, 7)) !== "ftyp") {
      return "";
    }
    for (let st = 8; st < boxSize; st += 4) {
      if (st === 12) continue;
      if (st + 3 >= data.length) return "";
      if (String.fromCharCode(byteAt(data, st), byteAt(data, st + 1), byteAt(data, st + 2)) === "mp4") {
        return "video/mp4";
      }
    }
    return "";
  }
}

class TextSig implements SniffSig {
  match(data: Uint8Array, firstNonWS: number): string {
    for (let i = firstNonWS; i < data.length; i += 1) {
      const b = byteAt(data, i);
      if (b <= 0x08 || b === 0x0b || (b >= 0x0e && b <= 0x1a) || (b >= 0x1c && b <= 0x1f)) return "";
    }
    return "text/plain; charset=utf-8";
  }
}

const SNIFF_SIGNATURES: SniffSig[] = [
  new HtmlSig("<!DOCTYPE HTML"),
  new HtmlSig("<HTML"),
  new HtmlSig("<HEAD"),
  new HtmlSig("<SCRIPT"),
  new HtmlSig("<IFRAME"),
  new HtmlSig("<H1"),
  new HtmlSig("<DIV"),
  new HtmlSig("<FONT"),
  new HtmlSig("<TABLE"),
  new HtmlSig("<A"),
  new HtmlSig("<STYLE"),
  new HtmlSig("<TITLE"),
  new HtmlSig("<B"),
  new HtmlSig("<BODY"),
  new HtmlSig("<BR"),
  new HtmlSig("<P"),
  new HtmlSig("<!--"),
  new MaskedSig("<?xml", "\xff\xff\xff\xff\xff", "text/xml; charset=utf-8", true),
  new ExactSig("%PDF-", "application/pdf"),
  new ExactSig("%!PS-Adobe-", "application/postscript"),
  new MaskedSig("\xfe\xff\x00\x00", "\xff\xff\x00\x00", "text/plain; charset=utf-16be"),
  new MaskedSig("\xff\xfe\x00\x00", "\xff\xff\x00\x00", "text/plain; charset=utf-16le"),
  new MaskedSig("\xef\xbb\xbf\x00", "\xff\xff\xff\x00", "text/plain; charset=utf-8"),
  new ExactSig("\x00\x00\x01\x00", "image/x-icon"),
  new ExactSig("\x00\x00\x02\x00", "image/x-icon"),
  new ExactSig("BM", "image/bmp"),
  new ExactSig("GIF87a", "image/gif"),
  new ExactSig("GIF89a", "image/gif"),
  new MaskedSig("RIFF\x00\x00\x00\x00WEBPVP", "\xff\xff\xff\xff\x00\x00\x00\x00\xff\xff\xff\xff\xff\xff", "image/webp"),
  new ExactSig("\x89PNG\x0d\x0a\x1a\x0a", "image/png"),
  new ExactSig("\xff\xd8\xff", "image/jpeg"),
  new MaskedSig("FORM\x00\x00\x00\x00AIFF", "\xff\xff\xff\xff\x00\x00\x00\x00\xff\xff\xff\xff", "audio/aiff"),
  new MaskedSig("ID3", "\xff\xff\xff", "audio/mpeg"),
  new MaskedSig("OggS\x00", "\xff\xff\xff\xff\xff", "application/ogg"),
  new MaskedSig("MThd\x00\x00\x00\x06", "\xff\xff\xff\xff\x00\x00\x00\x00", "audio/midi"),
  new MaskedSig("RIFF\x00\x00\x00\x00AVI ", "\xff\xff\xff\xff\x00\x00\x00\x00\xff\xff\xff\xff", "video/avi"),
  new MaskedSig("RIFF\x00\x00\x00\x00WAVE", "\xff\xff\xff\xff\x00\x00\x00\x00\xff\xff\xff\xff", "audio/wave"),
  new Mp4Sig(),
  new ExactSig("\x1a\x45\xdf\xa3", "video/webm"),
  new MaskedSig(
    "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00LP",
    "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\xff\xff",
    "application/vnd.ms-fontobject",
  ),
  new ExactSig("\x00\x01\x00\x00", "font/ttf"),
  new ExactSig("OTTO", "font/otf"),
  new ExactSig("ttcf", "font/collection"),
  new ExactSig("wOFF", "font/woff"),
  new ExactSig("wOF2", "font/woff2"),
  new ExactSig("\x1f\x8b\x08", "application/x-gzip"),
  new ExactSig("PK\x03\x04", "application/zip"),
  new ExactSig("Rar!\x1a\x07\x00", "application/x-rar-compressed"),
  new ExactSig("Rar!\x1a\x07\x01\x00", "application/x-rar-compressed"),
  new ExactSig("\x00\x61\x73\x6d", "application/wasm"),
  new TextSig(),
];

/** Go http.DetectContentType (sniff.go:18-43). */
export function goDetectContentType(data: Uint8Array): string {
  const clipped = data.length > SNIFF_LEN ? data.slice(0, SNIFF_LEN) : data;
  let firstNonWS = 0;
  for (; firstNonWS < clipped.length && isWS(byteAt(clipped, firstNonWS)); firstNonWS += 1);
  for (const sig of SNIFF_SIGNATURES) {
    const ct = sig.match(clipped, firstNonWS);
    if (ct !== "") return ct;
  }
  return "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Gitea typesniffer port (modules/typesniffer/typesniffer.go:91-189)
// ---------------------------------------------------------------------------

const SNIFF_CONTENT_SIZE = 1024;
const MIME_TYPE_IMAGE_SVG = "image/svg+xml";
const MIME_TYPE_IMAGE_AVIF = "image/avif";
const MIME_TYPE_OCTET_STREAM = "application/octet-stream";

/** svgComment `(?s)<!--.*?-->`; svgTagRegex `(?si)\A\s*(?:(<!DOCTYPE\s+svg
 *  ([\s:]+.*?>|>))\s*)*<svg\b`; svgTagInXMLRegex the `<?xml … ?>` variant
 *  (typesniffer.go:29-31). */
const SVG_COMMENT_RE = /<!--[\s\S]*?-->/g;
const SVG_TAG_RE = /^\s*(?:(<!DOCTYPE\s+svg([\s:]+.*?>|>))\s*)*<svg\b/is;
const SVG_TAG_IN_XML_RE = /^<\?xml\b.*?\?>\s*(?:(<!DOCTYPE\s+svg([\s:]+.*?>|>))\s*)*<svg\b/is;

/** detectFileTypeBox (typesniffer.go:91-108). */
function detectFileTypeBox(data: Uint8Array): { brands: string[]; found: boolean } {
  if (data.length < 12) return { brands: [], found: false };
  const boxSize =
    ((byteAt(data, 0) << 24) | (byteAt(data, 1) << 16) | (byteAt(data, 2) << 8) | byteAt(data, 3)) >>> 0;
  if (boxSize < 12 || boxSize > data.length) return { brands: [], found: false };
  if (String.fromCharCode(byteAt(data, 4), byteAt(data, 5), byteAt(data, 6), byteAt(data, 7)) !== "ftyp") {
    return { brands: [], found: false };
  }
  const brands = [String.fromCharCode(byteAt(data, 8), byteAt(data, 9), byteAt(data, 10), byteAt(data, 11))];
  for (let i = 16; i + 4 <= boxSize; i += 4) {
    brands.push(
      String.fromCharCode(byteAt(data, i), byteAt(data, i + 1), byteAt(data, i + 2), byteAt(data, i + 3)),
    );
  }
  return { brands, found: true };
}

/** isEmbeddedOpenType (typesniffer.go:110-119). */
function isEmbeddedOpenType(data: Uint8Array): boolean {
  if (data.length < 80) return false;
  const version =
    byteAt(data, 8) | (byteAt(data, 9) << 8) | (byteAt(data, 10) << 16) | (byteAt(data, 11) << 24);
  const magic = byteAt(data, 34) | (byteAt(data, 35) << 8);
  let reservedZero = true;
  for (let i = 64; i < 80; i += 1) {
    if (byteAt(data, i) !== 0) {
      reservedZero = false;
      break;
    }
  }
  const versionOk = version === 0x00010000 || version === 0x00020001 || version === 0x00020002;
  return versionOk && magic === 0x504c && reservedZero;
}

class SniffedType {
  constructor(readonly contentType: string) {}
  isText(): boolean {
    return this.contentType.includes("text/");
  }
  isImage(): boolean {
    return this.contentType.includes("image/");
  }
  isSvgImage(): boolean {
    return this.contentType.includes(MIME_TYPE_IMAGE_SVG);
  }
  isPDF(): boolean {
    return this.contentType.includes("application/pdf");
  }
  isVideo(): boolean {
    return this.contentType.includes("video/");
  }
  isAudio(): boolean {
    return this.contentType.includes("audio/");
  }
  isBrowsableBinaryType(): boolean {
    return this.isImage() || this.isSvgImage() || this.isPDF() || this.isVideo() || this.isAudio();
  }
  getMimeType(): string {
    const semi = this.contentType.indexOf(";");
    return semi === -1 ? this.contentType : this.contentType.slice(0, semi);
  }
}

/** DetectContentType (typesniffer.go:122-185). */
export function detectContentType(input: Uint8Array): SniffedType {
  if (input.length === 0) {
    return new SniffedType("text/plain");
  }
  let ct = goDetectContentType(input);
  const data = input.length > SNIFF_CONTENT_SIZE ? input.slice(0, SNIFF_CONTENT_SIZE) : input;

  const TYPE_MS_FONT_OBJECT = "application/vnd.ms-fontobject";
  if (ct === TYPE_MS_FONT_OBJECT) {
    // "Stupid Golang blindly detects any content with 34th-35th bytes being
    // 'LP' as font" (typesniffer.go:134-143).
    if (isEmbeddedOpenType(data)) {
      return new SniffedType(TYPE_MS_FONT_OBJECT);
    }
    const patched = data.slice();
    patched[34] = 0x6c; // 'l'
    ct = goDetectContentType(patched);
  }

  const detectByHTML = ct.includes("text/plain") || ct.includes("text/html");
  const detectByXML = ct.includes("text/xml");
  if (detectByHTML || detectByXML) {
    const dataProcessed = new TextDecoder().decode(data).replace(SVG_COMMENT_RE, "").trim();
    if (
      (detectByHTML && SVG_TAG_RE.test(dataProcessed)) ||
      (detectByXML && SVG_TAG_IN_XML_RE.test(dataProcessed))
    ) {
      ct = MIME_TYPE_IMAGE_SVG;
    }
  }

  if (
    ct.startsWith("audio/") &&
    byteAt(data, 0) === 0x49 &&
    byteAt(data, 1) === 0x44 &&
    byteAt(data, 2) === 0x33
  ) {
    // The MP3 detection is inaccurate ("ID3" prefix → audio/mpeg); re-detect
    // past the prefix so text content wins (typesniffer.go:158-166).
    const ct2 = goDetectContentType(data.slice(3));
    if (ct2.startsWith("text/")) {
      ct = ct2;
    }
  }

  const { brands, found } = detectFileTypeBox(data);
  if (found && brands.includes("avif")) {
    ct = MIME_TYPE_IMAGE_AVIF;
  }

  if (ct === "application/ogg") {
    const head = data.length > 256 ? data.slice(0, 256) : data;
    const headText = new TextDecoder("latin1").decode(head);
    // ogg is only used by some video formats; audio/ogg for most cases
    ct = headText.includes("theora") || headText.includes("dirac") ? "video/ogg" : "audio/ogg";
  }
  return new SniffedType(ct);
}

/** DetectEncoding's utf-8 fast path (modules/charset/charset.go:146-177):
 *  trim a possibly-truncated trailing rune, then validate. The non-utf-8
 *  chardet fallback is not ported — the caller serves bare "text/plain". */
function detectEncodingUtf8(content: Uint8Array): string | null {
  let end = content.length - 1;
  let trimmed = content;
  let count = 0;
  while (end >= 0 && count < 4) {
    const c = byteAt(content, end);
    if (c >> 5 === 0b110 || c >> 4 === 0b1110 || c >> 3 === 0b11110) {
      trimmed = content.slice(0, end);
      break;
    }
    if (c >> 6 === 0b10) {
      end -= 1;
    } else {
      break;
    }
    count += 1;
  }
  try {
    // fatal decoder: invalid interior bytes reject (Go utf8.Valid) — BOM
    // stripping is irrelevant, only validity is consulted.
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(trimmed);
    return "utf-8";
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Serving resolution
// ---------------------------------------------------------------------------

type IssueAttachmentRow = typeof issueAttachments.$inferSelect;
type ReleaseAssetRow = typeof releaseAssets.$inferSelect;

/** Which half of the split attachment table the uuid resolved to, plus the
 *  upstream linked unit type (attachment.go:25-34 attachmentReadScope). */
type ResolvedAttachment =
  | { kind: "issue"; row: IssueAttachmentRow; issue: typeof issues.$inferSelect; unitType: "issues" | "pulls" }
  | { kind: "release"; row: ReleaseAssetRow; release: typeof releases.$inferSelect };

export type { ResolvedAttachment };

/** The uuid → (attachment, linked type, repoID) walk: GetAttachmentByUUID +
 *  GetAttachmentLinkedTypeAndRepoID (repository.go:207-229) over the split
 *  halves. Missing issue/release rows (dangling links) return null → the
 *  ServerError 500 arm. */
export async function resolveAttachmentByUuid(
  d1: D1Database,
  uuid: string,
): Promise<ResolvedAttachment | "missing" | "dangling"> {
  const db = drizzle(d1);
  const attach = (await db.select().from(issueAttachments).where(eq(issueAttachments.uuid, uuid)).limit(1))[0];
  if (attach !== undefined) {
    const issue = (await db.select().from(issues).where(eq(issues.id, attach.issueId)).limit(1))[0];
    if (issue === undefined) return "dangling";
    return { kind: "issue", row: attach, issue, unitType: issue.isPull ? "pulls" : "issues" };
  }
  const asset = (await db.select().from(releaseAssets).where(eq(releaseAssets.uuid, uuid)).limit(1))[0];
  if (asset !== undefined) {
    const release = (await db.select().from(releases).where(eq(releases.id, asset.releaseId)).limit(1))[0];
    if (release === undefined) return "dangling";
    return { kind: "release", row: asset, release };
  }
  return "missing";
}

interface Doer {
  id: number;
  isAdmin: boolean;
}

/** The request credential, if any (git-http/acl.ts requestCredential twin):
 *  the bearer token or the Basic password (token-as-password). */
function requestCredential(request: Request): string | null {
  const header = request.headers.get("authorization");
  const parsed = header === null ? null : parseAuthorizationHeader(header);
  return parsed?.bearerToken?.token ?? (parsed?.basicAuth ? basicAuthTokenCandidate(parsed.basicAuth) : null);
}

export interface CredentialResult {
  doer: Doer | null;
  scope: ScopeSet | null;
}

/**
 * The optional web-auth walk (upstream webAuth: Basic/OAuth2 credentials,
 * session-equivalent absent — SPEC-0002 tokens only). Invalid credentials
 * degrade to anonymous (upstream's web chain does not abort); the
 * brute-force limiter rides the credential-testing path fail-open (ef2c049)
 * and a blocked IP degrades to anonymous too.
 */
export async function resolveOptionalCredential(request: Request, env: Env): Promise<CredentialResult> {
  const credential = requestCredential(request);
  if (credential === null) {
    return { doer: null, scope: null };
  }
  const now = new Date();
  const limiter = new D1FailureLimiter(env.DB);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const verdict = await limiterCheckFailOpen(limiter, ip, now);
  if (verdict.blocked) {
    return { doer: null, scope: null };
  }
  const verified = await new TokenService(env.DB).verify(credential, { now });
  if (verified === null) {
    await limiterRecordFailureFailOpen(limiter, ip, now);
    return { doer: null, scope: null };
  }
  const scope = ScopeSet.parseLenient(verified.token.scopes);
  await limiterResetFailOpen(limiter, ip);
  const service = new TokenService(env.DB);
  if (service.needsLastUsedTouch(verified.token, now)) {
    await service.touchLastUsed(verified.token.id, now).catch(() => undefined);
  }
  return { doer: { id: verified.user.id, isAdmin: verified.user.isAdmin }, scope };
}

/** attachmentReadScope (attachment.go:25-34) — the required token scope per
 *  unit type; null when the unit needs no scope (unreachable here). */
function attachmentReadScope(unitType: "issues" | "pulls" | "releases"): string {
  return unitType === "releases" ? "read:repository" : "read:issue";
}

/** The release-write grant for the draft arm — the canWriteRepository arms
 *  (api/services/repo-access.ts:101-119) folded for this seam's resolved
 *  shapes: site admin, repo owner, a write/admin-mode team grant, or a
 *  write/admin collaborator row. */
async function canWriteReleases(
  d1: D1Database,
  repo: Pick<typeof repositories.$inferSelect, "id" | "ownerId">,
  owner: { id: number } | null,
  doer: Doer,
  teamMode: Awaited<ReturnType<typeof doerRepoAccessMode>>,
): Promise<boolean> {
  if (doer.isAdmin) return true;
  if (owner !== null && doer.id === owner.id) return true;
  if (teamMode === "write" || teamMode === "admin" || teamMode === "owner") return true;
  const mode = await collaboratorModeOf(d1, repo.id, doer.id);
  return mode === "write" || mode === "admin";
}

// ---------------------------------------------------------------------------
// Streaming: the 1024-byte sniff pre-read + rest re-stream (io.MultiReader)
// ---------------------------------------------------------------------------

async function prefixAndRest(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ prefix: Uint8Array; rest: ReadableStream<Uint8Array> | null }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return { prefix: concatChunks(chunks, total), rest: null };
    }
    chunks.push(value);
    total += value.byteLength;
    if (total >= limit) {
      return { prefix: concatChunks(chunks, total), rest: readableFromReader(reader) };
    }
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Re-wrap the exhausted-prefix reader as a fresh stream (the MultiReader
 *  tail; cancel propagates so R2 bodies are not leaked open). */
function readableFromReader(reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      void reader.cancel().catch(() => undefined);
    },
  });
}

/** The sniff prefix re-attached ahead of the untouched body (io.MultiReader). */
function prependPrefix(prefix: Uint8Array, rest: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let sent = false;
  return rest.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(prefix);
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(prefix);
        }
      },
    }),
  );
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export const attachmentsServingRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// GET /attachments/{uuid} — the ServeAttachment port (web.go:912,
// routers/web/repo/attachment.go:135-246). HEAD rides the GET handler like
// upstream (chi routes HEAD to GET; Go's server then discards the body).
// ---------------------------------------------------------------------------

attachmentsServingRouter.on(["GET", "HEAD"], "/attachments/:uuid", async (c) => {
  const request = c.req.raw;
  const uuid = c.req.param("uuid") ?? "";

  // 1. GetAttachmentByUUID + 2. GetAttachmentLinkedTypeAndRepoID.
  const resolved = await resolveAttachmentByUuid(c.env.DB, uuid);
  if (resolved === "missing") {
    return NOT_FOUND(); // IsErrAttachmentNotExist (attachment.go:138-140)
  }
  if (resolved === "dangling") {
    return SERVER_ERROR(); // GetAttachmentLinkedTypeAndRepoID ServerError (:146-150)
  }
  const repoId = resolved.kind === "issue" ? resolved.issue.repoId : resolved.row.repoId;
  const unitType = resolved.kind === "issue" ? resolved.unitType : "releases";

  // 3. The repo-mismatch arm (:154-157) is dead on this site-level route —
  // ctx.Repo.Repository is nil (web.go:912 sits outside RepoAssignment).
  // 4. The TypeInvalid uploader-only arm (:159-163) is structurally
  // unreachable: both cf-gitea halves carry NOT NULL links.

  // 5. GetRepositoryByID + GetDoerRepoPermission (:164-182), over the landed
  // readGrant predicate (SPEC-0003 §2.4 / SPEC-0010 §2.6).
  const repo = (await drizzle(c.env.DB).select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
  if (repo === undefined) {
    return SERVER_ERROR(); // GetRepositoryByID ServerError (:170-173)
  }
  const ownerRow = (
    await drizzle(c.env.DB)
      .select({ id: users.id, status: users.status, visibility: users.visibility })
      .from(users)
      .where(eq(users.usernameLower, repo.ownerNamespace))
      .limit(1)
  )[0];
  const credential = await resolveOptionalCredential(request, c.env);
  const doer = credential.doer;
  const teamMode =
    doer === null ? "none" : await doerRepoAccessMode(c.env.DB, { id: repo.id, ownerId: repo.ownerId }, doer.id);
  const canRead = readGrant({
    repoVisibility: repo.visibility,
    owner: ownerRow === undefined ? null : { id: ownerRow.id, status: ownerRow.status },
    ownerVisibility: ownerRow?.visibility ?? "private",
    doer,
    teamMode,
  });
  if (!canRead) {
    return NOT_FOUND(); // perm.CanRead fail (:184-187)
  }

  // 6. The draft-release arm (:193-203) — release_id is NOT NULL on
  // release_assets, so the upstream `attach.ReleaseID != 0` guard always
  // holds on this half.
  if (resolved.kind === "release" && resolved.release.isDraft) {
    const canWrite =
      doer !== null &&
      (await canWriteReleases(
        c.env.DB,
        repo,
        ownerRow === undefined ? null : ownerRow,
        doer,
        teamMode,
      ));
    if (!canWrite) {
      return NOT_FOUND();
    }
  }

  // 7. CheckTokenScopes + attachmentReadScope (:205-210) — AFTER the 404
  // arms, matching upstream's order; only token doers are checked.
  if (doer !== null && credential.scope !== null && !credential.scope.has(attachmentReadScope(unitType))) {
    return FORBIDDEN();
  }

  // 8. IncreaseDownloadCount (:213-216) — before the bytes, upstream order.
  if (resolved.kind === "issue") {
    await drizzle(c.env.DB)
      .update(issueAttachments)
      .set({ downloadCount: resolved.row.downloadCount + 1 })
      .where(eq(issueAttachments.id, resolved.row.id));
  } else {
    await drizzle(c.env.DB)
      .update(releaseAssets)
      .set({ downloadCount: resolved.row.downloadCount + 1 })
      .where(eq(releaseAssets.id, resolved.row.id));
  }

  // 9. ServeDirect (:218-226) inapplicable — the R2 binding serves directly.
  const r2Key = resolved.row.r2Key;
  if (r2Key === null) {
    // The relay's pending arm (row-first landing, never uploaded) — nothing
    // to open; the landed blob GET answers the same 404.
    return NOT_FOUND();
  }
  const object = await c.env.REPO_PACKS.get(r2Key);
  if (object === null) {
    return SERVER_ERROR(); // storage.Open ServerError (:233-237)
  }

  // 10. HandleGenericETagPrivateCache (:228-230) — ETag + CreatedUnix.
  const etag = `"${uuid}"`;
  const created = resolved.row.createdAt ?? null;
  const cached = genericEtagTimeCache(request, etag, created);
  if (cached !== null) {
    return cached;
  }

  // 11. ServeUserContentByFile (serve.go:232-240) — sniff, headers, stream.
  // (The platform types R2 stream elements as `any`; the wire contract is
  // bytes — the landed cast discipline, routes/issue-attachments.ts.)
  const { prefix, rest } = await prefixAndRest(
    object.body as ReadableStream<Uint8Array>,
    MIME_DETECTION_BUFFER_LEN,
  );
  const sniffed = detectContentType(prefix);
  let contentType: string;
  if (sniffed.isBrowsableBinaryType()) {
    contentType = sniffed.getMimeType();
  } else if (sniffed.isText()) {
    // intentionally not the sniffed text/* type — user HTML must not render
    // as a page (serve.go:120-123)
    contentType = "text/plain";
    const charset = detectEncodingUtf8(prefix);
    if (charset !== null) {
      contentType += `; charset=${charset}`;
    }
  } else {
    contentType = MIME_TYPE_OCTET_STREAM;
  }
  // ContentDisposition default (serve.go:135-141): INLINE; the only
  // attachment arm is SVG-with-render-disabled (default enabled → dead arm,
  // kept as the constant's complement).
  const dispositionType: ContentDispositionType =
    SVG_RENDER_ENABLED || !sniffed.isSvgImage() ? "inline" : "attachment";
  const disposition = encodeContentDisposition(dispositionType, resolved.row.name);

  const headers: Record<string, string> = {
    // SetCacheControlInHeader (serve.go:96-99) overwrites the etag handler's
    // value — the ETag pair revalidates every time.
    "Cache-Control": SERVE_CACHE_CONTROL,
    ETag: etag,
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Content-Length": String(object.size),
    "Content-Disposition": disposition,
    "Access-Control-Expose-Headers": "Content-Disposition",
    // The FILE mtime (serve.go:238) overwrites the CreatedUnix value.
    "Last-Modified": object.uploaded.toUTCString(),
  };
  const csp = contentType.startsWith("application/pdf")
    ? CSP_PDF
    : contentType.startsWith("video/") || contentType.startsWith("audio/")
      ? null
      : CSP_SANDBOX;
  if (csp !== null) {
    headers["Content-Security-Policy"] = csp;
  }

  if (c.req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  const body = rest === null ? streamOf(prefix) : prependPrefix(prefix, rest);
  return new Response(body, { status: 200, headers });
});

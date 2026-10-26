/**
 * The archive file downloads — the parity survey's row 1: the web mux's
 * archive wildcard over the landed archive service, upstream
 *
 *   GET /{owner}/{repo}/archive/*   web.go:1689 repo.Download
 *                                   (routers/web/repo/repo.go:352-374 →
 *                                   services/repository/archiver
 *                                   NewRequest archiver.go:80-100 +
 *                                   ServeRepoArchive archiver.go:355-395)
 *
 * ## Upstream shape (the ported contract)
 *
 *   - the `{ref}.{ext}` tail splits at the suffix (SplitArchiveNameType,
 *     models/repo/archiver.go:52-63): `.zip` / `.tar.gz` / `.bundle`;
 *     an unknown suffix is the upstream `400 unknown format: …`
 *     (ctx.HTTPError → http.Error: plain text, base.go:105-113) — a REAL
 *     400, not the 404 family;
 *   - the ref resolves branch → tag (peeled) → 40-hex oid exactly like the
 *     landed API seam (GetCommit's `unrecognized repository reference` 404
 *     otherwise — an EMPTY repository has no refs and lands there too, but
 *     the route group's MustBeNotEmpty gate 404s it first, web.go:1692);
 *   - `?path=` subpaths filter the walk (FormStrings("path"),
 *     repo.go:358 — the API family's pathspec semantics);
 *   - `.bundle` parses upstream as a third format and STREAMS a git bundle;
 *     our builder refuses it (the API seam's documented divergence — pack
 *     surgery the surface does not carry), answered as the 400 class.
 *
 * ## Response headers (the ServeRepoArchive matrix, stream path)
 *
 *   - Content-Type `application/octet-stream` + `X-Content-Type-Options:
 *     nosniff` for BOTH formats — ServeSetHeaders' empty-ContentType arm
 *     (httplib/serve.go:77-81 serveSetHeaderContentRelated falls to
 *     MimeTypeApplicationOctetStream); the sniffed zip/gzip types never
 *     appear on the web route (our API sibling's `application/zip` /
 *     `application/gzip` choice is its own landed divergence);
 *   - Content-Disposition attachment naming
 *     `{repo.Name}-{ref-with-slashes-as-dashes}.{ext}` (GetArchiveName,
 *     archiver.go:107-109) + `Access-Control-Expose-Headers:
 *     Content-Disposition` (ServeSetHeaders' filename form);
 *   - the Nix immutable-rev `Link` header keyed by the RESOLVED commit oid
 *     (archiver.go:358-361; Repo.APIURL() is AppURL + /api/v1/repos/… —
 *     our origin + the landed API path, so the header's target is a REAL
 *     sibling route here);
 *   - the weak ETag `W/"{oid}-{fmt}-{PrefixArchiveFiles}"` —
 *     PrefixArchiveFiles defaults true and our prefix is unconditional, so
 *     the literal is always `-true` (archiver.go:372-373); If-None-Match
 *     (comma list, W/ prefix-insensitive, `*`) answers 304 with
 *     `Cache-Control: private, max-age=21600` (HandleGenericETagPrivateCache
 *     → CacheControlForPrivateStatic → STATIC_CACHE_TIME 6 h,
 *     setting/server.go:254);
 *   - the 200's Cache-Control is `max-age=0, private, must-revalidate`:
 *     ServeSetHeaders runs AFTER HandleGenericETagPrivateCache
 *     (archiver.go:371-378) and its zero-option prod form OVERWRITES the
 *     private-static value (httpcache.go SetCacheControlInHeader Set, not
 *     Add) — the web middleware's stamp, the diffpatch precedent.
 *
 * ## Semantics / posture
 *
 * - Streaming all the way: the service's pull-driven chunk stream feeds the
 *   Response body directly — no archive is ever buffered whole (AGENTS.md's
 *   unbounded-body rule; the API route's composition verbatim).
 * - The gates upstream carries that we don't: `webAuth.AllowBasic/
 *   AllowOAuth2` (token-auth arms the session router doesn't serve — the
 *   prologue's visibility resolution covers the read), `dlSourceEnabled`
 *   (web.go:416 — DisableDownloadSourceArchives, a setting we don't model;
 *   upstream default keeps the route live), `checkDownloadTokenScope`
 *   (private-repo token scope — same session posture).
 * - A walk-budget 422 from the service (the entry/dir caps) surfaces before
 *   the response starts and answers the plain 500 class, like upstream's
 *   ServerError on a pre-stream git failure.
 * - The bare `/archive` (empty wildcard) claims upstream's 400 arm: chi's
 *   `/*` matches the empty tail and SplitArchiveNameType("") is unknown.
 *
 * This module holds the loader + the Response builder only; the handler
 * lives in src/ui/index.ts beside its sibling dispatchers (the resolveUiRequest
 * session/repo prologue is index-owned). Not a page — the diffpatch-file
 * precedent for plain Responses through the ui router.
 */

import { buildArchive, parseArchiveName, resolveArchiveRef } from "../../api/services/archive";
import { engineReads, refTipMap } from "../../api/services/engine";

/** The streaming download the loader produces. */
export interface RepoArchiveStream {
  kind: "stream";
  body: ReadableStream<Uint8Array>;
  /** The attachment filename: `{slug}-{ref-with-dashes}.{ext}`. */
  downloadName: string;
  /** The RESOLVED commit oid — the ETag and the Nix Link header key. */
  commitOid: string;
  format: "tar.gz" | "zip";
}

/** The upstream 400 class: an unknown suffix or the bundle refusal. */
export interface RepoArchiveBadFormat {
  kind: "bad-format";
  message: string;
}

/** The upstream 404 class: the MustBeNotEmpty arm or an unresolvable ref. */
export interface RepoArchiveNotFound {
  kind: "not-found";
  message: string;
}

export type RepoArchiveDownload = RepoArchiveStream | RepoArchiveBadFormat | RepoArchiveNotFound;

/** The loader's repo subset (the caller's resolved row). */
export type RepoArchiveRepo = {
  ownerNamespace: string;
  slug: string;
  isEmpty: boolean;
};

/**
 * Resolve + open the archive stream over the landed service (the API route's
 * serveArchive composition). `bad-format` = the 400 class, `not-found` = the
 * 404 family (the §4.5 shell, like every ui download's missing arm).
 */
export async function loadRepoArchive(
  env: Env,
  repo: RepoArchiveRepo,
  refExt: string,
  subPaths: string[],
): Promise<RepoArchiveDownload> {
  // The route group's MustBeNotEmpty gate (web.go:1692): an empty repo 404s
  // before the handler body (the releases family's read-gate arm).
  if (repo.isEmpty) return { kind: "not-found", message: "repository is empty" };
  const parsed = parseArchiveName(refExt);
  if (parsed === null || parsed.ref === "") {
    return { kind: "bad-format", message: `unknown format: ${refExt}` };
  }
  if (parsed.format === "bundle") {
    // Upstream's third format streams a git bundle here; the landed builder
    // refuses (the API seam's documented divergence) — the 400 class.
    return { kind: "bad-format", message: "bundle archives are not supported" };
  }
  const reads = engineReads(env, repo);
  const tips = refTipMap(await reads.listRefs());
  const refTarget = resolveArchiveRef(tips, parsed.ref);
  const commit = refTarget === null ? null : await reads.readCommit(refTarget);
  if (refTarget === null || commit === null) {
    // GetCommit's failure: `unrecognized repository reference` 404
    // (archiver.go:92-94's NewNotExistErrorf).
    return { kind: "not-found", message: `unrecognized repository reference: ${parsed.ref}` };
  }
  const stream = await buildArchive(
    reads,
    refTarget,
    parsed.format,
    repo.slug,
    parsed.ref,
    commit.committer.time,
    subPaths,
  );
  return {
    kind: "stream",
    body: stream.body,
    downloadName: stream.downloadName,
    commitOid: commit.oid,
    format: parsed.format,
  };
}

/** CacheControlForPrivateStatic's prod value — STATIC_CACHE_TIME 6 h
 *  (setting/server.go:254), emitted on the 304 only. */
const PRIVATE_STATIC_CACHE_CONTROL = "private, max-age=21600";

/** The web middleware's zero-option prod stamp — the 200's Cache-Control
 *  (ServeSetHeaders runs after the ETag check and OVERWRITES the 6 h value,
 *  archiver.go:371-378; the diffpatch precedent). */
const WEB_CACHE_CONTROL = "max-age=0, private, must-revalidate";

/** checkIfNoneMatchIsValid (httpcache.go:70-86): comma list, `W/`
 *  prefix-insensitive compare, `*` matches. */
function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;
  const bare = etag.replace(/^W\//, "");
  return trimmed.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === bare);
}

/**
 * The archive download Response — the module doc's header matrix. The ETag
 * short-circuits to the upstream 304 (empty body, the private-static
 * Cache-Control); the 200 streams the service's pull-driven chunks (the
 * body is consumed by the runtime as the client pulls — never buffered).
 */
export function repoArchiveResponse(
  download: RepoArchiveStream,
  options: { origin: string; owner: string; repo: string; ifNoneMatch: string | null },
): Response {
  const { body, downloadName, commitOid, format } = download;
  // The weak ETag's bytes depend on the commit + format + the prefix posture
  // (always prefixed here — archiver.go:372-373's `%t` with the default).
  const etag = `W/"${commitOid}-${format}-true"`;
  if (etagMatches(options.ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": PRIVATE_STATIC_CACHE_CONTROL },
    });
  }
  const ownerEnc = encodeURIComponent(options.owner);
  const slugEnc = encodeURIComponent(options.repo);
  return new Response(body, {
    status: 200,
    headers: {
      // The Nix immutable-rev link (archiver.go:358-361) — Repo.APIURL() is
      // AppURL + /api/v1/repos/…, so the target is the landed API route.
      link: `<${options.origin}/api/v1/repos/${ownerEnc}/${slugEnc}/archive/${commitOid}.${format}?rev=${commitOid}>; rel="immutable"`,
      etag,
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="${downloadName}"`,
      "access-control-expose-headers": "Content-Disposition",
      "cache-control": WEB_CACHE_CONTROL,
    },
  });
}

/** The upstream 400 class's body — ctx.HTTPError → http.Error's plain-text
 *  form (base.go:105-113: the message + trailing newline, nosniff). */
export function archiveBadFormatResponse(message: string): Response {
  return new Response(`${message}\n`, {
    status: 400,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": WEB_CACHE_CONTROL,
    },
  });
}

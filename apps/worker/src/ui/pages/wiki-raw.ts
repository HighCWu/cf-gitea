/**
 * The wiki RAW byte arm — the wiki family's missing download route, upstream
 *
 *   GET /{owner}/{repo}/wiki/raw/*   web.go:1621 → repo.WikiRaw
 *                                    (routers/web/repo/wiki.go:597-639)
 *                                    → common.ServeBlob + ServeUserContentByReader
 *
 * — the bytes behind the markdown pipeline's `![img](/wiki/raw/…)` rewrites
 * (repo-wiki.tsx's wiki-mode image policy): wiki pages can link raw assets,
 * and WikiRaw's doc line says exactly that ("outputs raw blob requested by
 * user (image for example)").
 *
 * ## The upstream handler, arm by arm (wiki.go:597-639)
 *
 * - REF: `findWikiRepoCommit` (wiki.go:98-125) — the wiki repo's default
 *   branch (`DefaultWikiBranch`; ours = the repo default branch, the landed
 *   `wikiBranch` convention). A missing branch is its not-exist class →
 *   ctx.NotFound (wiki.go:600-604): the absent-wiki 404 arm. (The DB
 *   re-sync retry, wiki.go:106-120, has no counterpart — our cell's HEAD is
 *   seated by the engine on first write, nothing to drift.)
 * - PATH GRAMMAR (wiki.go:609-610): `providedWebPath =
 *   WebPathFromRequest(PathParamRaw("*"))` — the codec's clean + `/`→`%2F`
 *   round trip (services/wiki.ts `webPathFromRequest`); NO "Home" default
 *   here (unlike the page arms — an empty tail probes `.md` then `""`).
 *   `providedGitPath = WebPathToGitPath(providedWebPath)` — the coded
 *   `.md`-suffixed path (or the raw pass-through for `.md` tails).
 * - THE FOUR CANDIDATES (wiki.go:612-628 over findEntryForFile 81-96):
 *   the coded git path, then `url.QueryUnescape(coded)` ("the shortest
 *   alternative" — `+`→space; the service's `queryUnescape` is the exact Go
 *   port), then — only on a total first-round miss — the
 *   `TrimSuffix(".md")` retry (the NON-`.md` raw file round: images pushed
 *   straight into the wiki repo) and its QueryUnescape. Loader:
 *   `readWikiRawBlob` (services/wiki.ts — this module's seam).
 * - SERVE: `common.ServeBlob(ctx.Base, repo, ctx.Repo.TreePath,
 *   entry.Blob(...), nil)` (wiki.go:632) — no lastModified (WikiRaw passes
 *   nil), no checkDownloadTokenScope (unlike the /raw repo twin,
 *   download.go:96-109). The ported response shape:
 *   1. the ETag gate (serve.go:21 → httpcache.go:87-117
 *      HandleGenericETagPrivateCache): strong ETag `"<blob-oid>"`, set on
 *      EVERY answer; If-None-Match (comma list, `W/`-insensitive, `*`,
 *      httpcache.go:57-75) matching → **304 with the ETag only** — the
 *      Cache-Control stamp (SetCacheControlInHeader) runs AFTER the 304
 *      returns, so upstream's 304 carries no Cache-Control (the exact-order
 *      port here; pages/release-downloads.ts adds the header on its 304s —
 *      that module's own disclosed divergence). No Last-Modified arm (nil
 *      lastModified skips both the header and If-Modified-Since).
 *   2. the 200 (httplib serve.go:38-43 → 148-161 → 107-144):
 *      - Content-Type: the first 1024 bytes (mimeDetectionBufferLen,
 *        serve.go:146) through DetectContentType's class decision
 *        (serve.go:118-134 serveSetHeadersByUserContent): browsable binary
 *        (image/svg/pdf/video/audio) keeps its mime, ANY text is forced to
 *        `text/plain` (+ the BOM's charset — the DetectEncoding reduction),
 *        everything else `application/octet-stream`. Reused verbatim from
 *        pages/release-downloads.ts's ported sniffer (`sniffContentType` +
 *        `userContentType` — one port, two consumers).
 *      - `X-Content-Type-Options: nosniff` + the CSP matrix
 *        (serve.go:59-74: sandbox for the rest, the PDF variant, none for
 *        audio/video) — `userContentCsp`.
 *      - `Content-Length`: the blob size.
 *      - `Content-Disposition: inline; filename=.` — the quirk: the
 *        filename is `path.Base(ctx.Repo.TreePath)` (serve.go:39) and the
 *        wiki group mounts NO RepoRef middleware (web.go:1622's args; the
 *        TreePath writes live in getRefName*, services/context/repo.go:
 *        839-918), so TreePath stays "" and `path.Base("")` is `"."` — the
 *        bare-dot filename is upstream-faithful, kept. Disposition `inline`
 *        (the sniffed default, serve.go:135-141; UI.SVG.Enabled default
 *        keeps SVG inline too) through the content_disposition port
 *        (`encodeContentDisposition`), plus
 *        `Access-Control-Expose-Headers: Content-Disposition` (serve.go:93).
 *      - `Cache-Control`: SetCacheControlInHeader's prod form
 *        (httpcache.go:23-41) with ServeBlob's options (serve.go:40-42) —
 *        `CacheIsPublic: !repo.IsPrivate && owner.Visibility ==
 *        VisibleTypePublic`, MaxAge = StaticCacheTime (6 h,
 *        setting/server.go:254) → `public, max-age=21600` for a public
 *        repo owned by a public principal, `private, max-age=21600`
 *        otherwise.
 *      - ETag: already set by the gate (serve.go:21 runs first) — the 200
 *        carries it too.
 *      - gzhttp's no-compression hint never fires (the `"."` filename has
 *        no extension in the skip set, serve.go:80-83).
 *
 * ## Documented divergences
 *
 * - Range requests: ServeUserContentByReader's minimal single-range 206 arm
 *   (serve.go:166-229) is not ported — the landed download family serves
 *   whole bodies (release-downloads/archive-files carry no 206 arm either);
 *   wiki page images fetch whole.
 * - An EMPTY tail (or any probe naming a DIRECTORY): upstream's
 *   GetTreeEntryByPath("") returns the root TREE entry (tree_blob.go:29-36)
 *   and the tree oid then fails the blob open → ServerError 500; the
 *   engine's readBlob answers null for a non-blob hit → the 404 family
 *   here. A 500 born of a type-confusion quirk is not ported.
 * - A literal `%XX`-bearing git entry name (a title with URL-reserved
 *   chars) resolves through the engine's per-segment decodePath — the same
 *   convention every landed wiki read already rides (pageBlob probes the
 *   coded path identically); nothing new here.
 *
 * ## Mount record (MOUNTED at 2f7afe9 — the wiring HANDOFF is retired;
 * the recipe below is kept as the landed-shape record)
 *
 * The three claimed shapes moved to `wiki-raw` BEFORE the
 * wiki family arms, mirroring the excerpt twin's exact plumbing:
 *
 * 1. ROUTE INTERFACE (beside the wiki route): `WikiRawRoute { family:
 *    "wiki-raw"; owner; repo; rawTail }` — the decoded `/raw` tail
 *    (per-segment decode + "/" join — the wiki family's rawTail
 *    convention; "" never claims here: the bare `/wiki/raw` tail stays
 *    with the page family, exactly upstream's chi wildcard which does not
 *    match `/raw`) — on the `ParsedUiRoute` union.
 *
 * 2. PARSE (inside parseUiRoute's early `head === "wiki"` block — the
 *    excerpt twin's own block; claimed before the later `family: "wiki"`
 *    return, else the page family would swallow raw tails): the
 *    `rest.length >= 2 && rest[0] === "raw"` arm returns
 *    `{ family: "wiki-raw", owner, repo, rawTail }` with the per-segment
 *    decode in try/catch (decode failure → null → the engine's 404).
 *
 * 3. HANDLER + REGISTRATION: the `wikiRawBlob` handler beside the excerpt
 *    fragment — `resolveUiRequest` → the drift guard →
 *    `loadRepoSettings` hasWiki 404-shell (MustEnableWiki, web.go:1622) →
 *    the pair re-read (the wikiPrologue precedent) →
 *    `loadWikiRawBlob(c.env, pair, route.rawTail)` (null → 404,
 *    wiki.go:638's NotFound) → `wikiRawBlobResponse(blob, { cacheIsPublic,
 *    ifNoneMatch })` — registered as
 *    `uiRouter.get("/:owner/:repo/wiki/raw/*", …)` BEFORE the `wiki/*`
 *    patterns.
 *
 *    (reqUnitWikiReader reduces to repo visibility — already the §2.5
 *    prologue's; the group's `optSignIn` needs no arm — reads need no
 *    session.)
 *
 * ## Data sourcing (§3.2 — service ops, never a self-fetch)
 *
 * The bytes ride the LANDED wiki service's cell reads (services/wiki.ts
 * `readWikiRawBlob` — the sibling `owner/slug.wiki` engine cell over
 * `wikiReads`), the same seam the five page loaders use; the sniffing rides
 * release-downloads.ts's ported sniffer. No D1, no R2 — the wiki cell is
 * the store.
 */

import type { WikiRawBlob } from "../../services/wiki";
import {
  encodeContentDisposition,
  sniffContentType,
  SNIFF_CONTENT_SIZE,
  userContentCsp,
  userContentType,
} from "./release-downloads";

/** `readWikiRawBlob` under the module's load* name — the loader seam the
 *  mounted handler calls (the family's loader convention). */
export { readWikiRawBlob as loadWikiRawBlob } from "../../services/wiki";
export type { WikiRawBlob };

/** The ServeBlob filename (serve.go:39 `path.Base(ctx.Repo.TreePath)` with
 *  the wiki group's never-set TreePath — path.Base("") = "."). */
const RAW_FILENAME = ".";

/** STATIC_CACHE_TIME (setting/server.go:254) in seconds. */
const STATIC_CACHE_TIME_SECONDS = 21_600;

/** The If-None-Match match (httpcache.go:57-75 checkIfNoneMatchIsValid):
 *  comma list, `W/`-prefix-insensitive compare, `*` matches. */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const trimmed = ifNoneMatch.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;
  const bare = etag.replace(/^W\//, "");
  return trimmed.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === bare);
}

/**
 * The raw blob Response — the module header's two-arm port. The 304 answers
 * If-None-Match with the ETag ONLY (httpcache.go:96-101 returns before
 * SetCacheControlInHeader); the 200 carries the sniffed content headers, the
 * inline `"."` disposition and the public/private 6 h Cache-Control.
 */
export function wikiRawBlobResponse(
  blob: WikiRawBlob,
  options: { cacheIsPublic: boolean; ifNoneMatch: string | null },
): Response {
  const etag = `"${blob.oid}"`; // serve.go:21's quoted oid
  if (options.ifNoneMatch !== null && etagMatches(options.ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  const head = blob.data.subarray(0, Math.min(blob.data.byteLength, SNIFF_CONTENT_SIZE));
  const contentType = userContentType(sniffContentType(head)); // serve.go:118-134's class decision
  const headers = new Headers();
  headers.set("etag", etag);
  headers.set("content-type", contentType);
  headers.set("x-content-type-options", "nosniff");
  const csp = userContentCsp(contentType); // serve.go:59-74's matrix
  if (csp === null) headers.delete("content-security-policy");
  else headers.set("content-security-policy", csp);
  headers.set("content-length", String(blob.data.byteLength));
  headers.set("content-disposition", encodeContentDisposition("inline", RAW_FILENAME));
  headers.set("access-control-expose-headers", "Content-Disposition");
  headers.set("cache-control", `${options.cacheIsPublic ? "public" : "private"}, max-age=${STATIC_CACHE_TIME_SECONDS}`);
  return new Response(blob.data, { status: 200, headers });
}

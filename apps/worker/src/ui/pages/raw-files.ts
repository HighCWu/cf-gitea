/**
 * The RAW + MEDIA byte-serving families — the parity survey's two PARTIAL
 * rows (the census's R21/R22 closes, the directive's top impact): upstream
 *
 *   GET /{owner}/{repo}/raw/blob/{sha}            web.go:1708 repo.DownloadByID
 *   GET /{owner}/{repo}/raw/{branch|tag|commit}/* web.go:1709-1711
 *                                   (context.RepoRefByType + repo.SingleDownload)
 *   GET /{owner}/{repo}/raw/*                     web.go:1712 — DEPRECATED
 *                                   backward-compat arm (RepoRefByType(""))
 *   GET /{owner}/{repo}/media/blob/{sha}          web.go:1700 repo.DownloadByIDOrLFS
 *   GET /{owner}/{repo}/media/{branch|tag|commit}/* web.go:1701-1703
 *                                   (repo.SingleDownloadOrLFS)
 *   GET /{owner}/{repo}/media/*                   web.go:1704 — DEPRECATED arm
 *
 * under the repo-code group's gates (web.go:1653-1762's closing args):
 * `optSignIn`, `context.RepoAssignment` (the §2.5 prologue), the group's
 * `webAuth.AllowBasic`/`AllowOAuth2` (token-auth arms the session posture
 * covers — the wiki-raw checkDownloadTokenScope note) and
 * `repo.MustBeNotEmpty` — an empty repo 404-shells before the handler body.
 *
 * ## The LFS audit note (2026-10-30 — findings-git-e2e F4's premise corrected)
 *
 * F4 read upstream's raw route as `SingleDownloadOrLFS` "wired at
 * web.go:1701" — but web.go:1701 is a line of the MEDIA group: at the pin,
 * `/raw` is `repo.SingleDownload` (web.go:1705-1712) and `/media` is
 * `repo.SingleDownloadOrLFS` (web.go:1699-1704). SingleDownload
 * (download.go:105-121) calls `common.ServeBlob` DIRECTLY — no pointer
 * probe, no LFS arm (serve.go:20-44's ServeBlob has none) — so upstream
 * `/raw` serves the POINTER TEXT for an LFS file (a text blob → sniffed
 * `text/plain`, the git-blob-oid ETag), exactly what this module's raw arm
 * has always served. Upstream's own web UI corroborates the split: it links
 * LFS files with `/media/` URLs (view_file.go:210-212 flips RawFileLink for
 * LFS files; tests/integration/lfs_view_test.go:61,80 asserts the /media
 * link) precisely BECAUSE raw would serve pointer bytes. The split is as old
 * as the surfaces themselves (2a03e96bce, #5787 — 2019: the /media group is
 * BORN on SingleDownloadOrLFS while /raw stays on SingleDownload). SPEC-0006
 * already records the posture ("GET …/raw/{filepath} never LFS-resolves").
 * This module therefore stays as landed — no raw-arm LFS resolution; the
 * matrix suite pins the raw-arm pointer serving as a regression guard.
 *
 * ## The upstream handlers (routers/web/repo/download.go)
 *
 * - `SingleDownload` (:105-121): getBlobForEntry (:69-102) — the tree entry
 *   under the middleware-resolved ref (a DIR or SUBMODULE entry is
 *   NotFound, :86-89); `lastModified` = GetTreePathLatestCommit's committer
 *   time (:91-99); then common.ServeBlob.
 * - `SingleDownloadOrLFS` (:123-137): the same blob + ServeBlobOrLFS
 *   (:25-67) — read the first MetaFileMaxSize bytes,
 *   `lfs.ReadPointerFromBuffer`; a VALID pointer looks up
 *   `GetLFSMetaObjectByOid` (models/git/lfs.go:121-136 — any row; a miss is
 *   the nil-meta arm) and serves the LFS OBJECT bytes through
 *   httplib.ServeUserContentByFile (ServeHeaderOptions{Filename: TreePath} —
 *   no cache options → the zero-duration private stamp), after a SECOND ETag
 *   gate on the pointer oid with the meta's updated time; an invalid/absent
 *   pointer falls through to the plain ServeBlob.
 * - `DownloadByID`/`DownloadByIDOrLFS` (:139-190): GetBlob(sha) with
 *   lastModified nil (TreePath never set → the "." filename base, the
 *   wiki-raw quirk's sibling).
 *
 * ## ServeBlob / ServeUserContentByReader (routers/common/serve.go:20-44 +
 *  modules/httplib/serve.go:118-233) — the response matrix
 *
 * 1. `HandleGenericETagPrivateCache` (httpcache.go:114-139): the quoted oid
 *    ETag + the Last-Modified stamp go on EVERY answer; If-None-Match
 *    (comma list, `W/`-insensitive, `*`) or — absent INM — If-Modified-Since
 *    (second-truncated compare, the release-downloads port) answers **304
 *    with those two headers only** (SetCacheControlInHeader runs after the
 *    early return — the wiki-raw exact-order port; release-downloads adds
 *    the header on its 304s, that module's own disclosed divergence).
 * 2. The 200 (ServeUserContentByReader → serveSetHeadersByUserContent →
 *    ServeSetHeaders): the first 1024 bytes sniffed (SNIFF_CONTENT_SIZE);
 *    browsable binary keeps its mime, ANY text is forced to `text/plain`
 *    (+ the BOM's charset), everything else `application/octet-stream`;
 *    `X-Content-Type-Options: nosniff`; the CSP matrix (userContentCsp);
 *    `Content-Length` = the size; `Content-Disposition: inline; filename=`
 *    path.Base(TreePath) (the LFS arm passes the FULL TreePath as Filename —
 *    ServeSetHeaders applies the same path.Base) encoded per
 *    content_disposition.go, + `Access-Control-Expose-Headers`; the gzhttp
 *    no-compression hint on the skip extensions (`x-no-compression: 1`, the
 *    release-downloads port); then the cache stamp — ServeBlob's options
 *    carry CacheIsPublic (public repo ∧ public owner) and CacheDuration =
 *    StaticCacheTime → `${public|private}, max-age=21600`, while the LFS
 *    arm's empty options stamp the zero-duration prod form
 *    `max-age=0, private, must-revalidate`; finally Last-Modified when
 *    non-zero (the LFS arm re-dates it to the object's storage ModTime —
 *    our R2 object's `uploaded`).
 *
 * ## The port, over the landed boundary (the documented divergences)
 *
 * - The TYPED ref arms + the deprecated guess arm ride the /src family's
 *   resolution: `resolveRefSuffix` per type, and the legacy arm re-issued
 *   over the same walk (upstream getRefNameLegacy, services/context/repo.go:
 *   844-864: branch walk → tag walk → 7..64-hex first segment → the DEFAULT
 *   BRANCH fallback with the whole tail as tree path — the FIXME'd old-code
 *   behavior; upstream's renamed-branch arm has no landed renamed_branches
 *   model and is not ported).
 * - The `/blob/{sha}` arms: the engine boundary has NO object-by-oid read
 *   (readBlob walks a ref's tree), so the arm answers the existence probe —
 *   an unresolvable sha is upstream's GetBlob not-exist 404, and a
 *   resolvable one 404s where upstream streams object bytes (the render-file
 *   blob arm's boundary-gap reduction; upstream's commit-oid corner serves
 *   the commit object's raw bytes — not ported). Closed with the R08-class
 *   engine-RPC wave.
 * - The LFS arm reads through the LANDED store (services/lfs — SPEC-0006):
 *   `lfsRepoId`'s numeric repo key, `LfsStateService.get` for the meta row
 *   (ANY state — the landed enum folds upstream's row-exists semantics),
 *   `lfsKey`'s R2 key, `createLfsStore` for the bytes; a pointer whose row
 *   exists but whose R2 object is gone (the uploading-state race upstream
 *   answers with a ServerError 500 — ReadMetaObject's failure) degrades to
 *   the plain blob, the graceful arm of upstream's own meta==nil
 *   fall-through. The presign posture (upstream ServeDirect,
 *   download.go:46-54) mints `store.presignGet` and 303-redirects
 *   (ctx.Redirect's default status, base.go:157 — ServeDirectOptions nil,
 *   so no disposition rides the signed URL); relay mode answers null and
 *   streams.
 * - Single-range 206 serving (ServeUserContentByReader's minimal Range arm)
 *   is not ported — the landed download families' shared reduction
 *   (wiki-raw's header note); git-lfs and browsers fall back to whole-body
 *   GETs.
 * - GetTreePathLatestCommit failing degrades to lastModified = null (serve
 *   without the stamp) where upstream ServerErrors — the engine-reads
 *   null-on-failure convention.
 * - `checkDownloadTokenScope` (download.go:11-16) and the webAuth arms: the
 *   §2.5 prologue's visibility resolution is the landed read gate (the
 *   wiki-raw posture note).
 *
 * ## Mount record (this wave)
 *
 * ROUTE INTERFACE: `RawMediaRoute` on the ParsedUiRoute union (families
 * "raw-file" | "media-file" — one interface, the family selects the handler
 * arm). PARSE: inside parseUiRoute's repo-scoped switch — `head === "raw" |
 * "media"` claims exactly upstream's five chi shapes per group: the
 * 2-segment `blob/{sha}`, the three typed wildcards (`branch|tag|commit` +
 * ≥1 more segment), and the deprecated catch-all (≥1 segment — chi's `/*`
 * does not match the bare `/raw`/`/media` literal, so that stays unclaimed
 * → the engine's 404, exactly upstream). HANDLER + REGISTRATION: the
 * `rawMediaFile` handler beside the wiki-raw byte arm — resolveUiRequest →
 * MustBeNotEmpty 404-shell → the pair re-read (the wikiPrologue precedent,
 * for the owner visibility half of cacheIsPublic) → the loader → the
 * response builders — registered as the five
 * `/:owner/:repo/{raw,media}/...` GET patterns beside the render family.
 *
 * ## Data sourcing (§3.2 — service ops, never a self-fetch)
 *
 * The bytes ride the LANDED engine reads (`engineReads.readBlob` +
 * `listLog` for the lastModified walk) and the LANDED LFS store (SPEC-0006);
 * the sniffing/disposition/cache pair rides release-downloads.ts's ported
 * helpers (one port, three consumers — the wiki-raw pattern). No D1 beyond
 * the lfsObjects meta row.
 */

import { defaultLfsDeps, lfsRepoId } from "../../lfs/router";
import { lfsKey } from "../../services/lfs/store";
import { parsePointer, PointerTooLargeError } from "../../services/lfs/pointer";
import { engineReads } from "../../api/services/engine";
import type { BlobResult } from "@cf-gitea/git-engine";
import {
  encodeContentDisposition,
  httpTime,
  sniffContentType,
  SNIFF_CONTENT_SIZE,
  splitPrefetch,
  SKIP_COMPRESSION_EXTS,
  userContentCsp,
  userContentType,
} from "./release-downloads";
import { resolveRefSuffix, type RefType, type RefSuffixRefs } from "../index";

/** lfs.MetaFileMaxSize — the pointer probe window (POINTER_MAX_BYTES equals
 *  the constant; the probe slices BEFORE parse, so the too-large throw
 *  cannot fire). */
const POINTER_PROBE_BYTES = 1024;

/** STATIC_CACHE_TIME (setting/server.go:254) in seconds. */
const STATIC_CACHE_TIME_SECONDS = 21_600;

/** The web middleware's zero-option prod stamp — the LFS arm's Cache-Control
 *  (ServeHeaderOptions{} → IsPublic false, MaxAge zero → httpcache.go:25-41's
 *  prod form; the archive family's WEB_CACHE_CONTROL twin). */
const WEB_CACHE_CONTROL = "max-age=0, private, must-revalidate";

/** The loader's repo subset (the caller's resolved row): the uuid id feeds
 *  the LFS numeric repo key, the storageKey the R2 object key. */
export interface RawMediaRepo {
  id: string;
  ownerNamespace: string;
  slug: string;
  isEmpty: boolean;
  defaultBranch: string;
  storageKey: string;
}

/** One parse shape: the typed arms' resolved suffix, the deprecated arm's
 *  raw tail, or the blob sha. */
export type RawMediaTarget =
  | { kind: "ref"; refType: RefType; refSuffix: string }
  | { kind: "legacy"; refSuffix: string }
  | { kind: "blob"; sha: string };

/**
 * Upstream `getRefNameLegacy` (services/context/repo.go:844-864) over the
 * /src family's resolution universes: branch walk (resolveRefSuffix's
 * shortest-prefix walk; its literal-HEAD arm included) → tag walk → the
 * 7..64-hex first segment (no existence check — upstream's FIXME preserved)
 * → the default-branch fallback with the whole tail as tree path (the old
 * code's behavior — the FIXME note). The caller 404-shells the empty repo
 * before this runs.
 */
export function resolveLegacyRefSuffix(
  rest: string,
  refs: RefSuffixRefs,
): { refType: RefType; ref: string; treePath: string } {
  const branch = resolveRefSuffix("branch", rest, refs);
  if (branch !== null) return branch;
  const tag = resolveRefSuffix("tag", rest, refs);
  if (tag !== null) return tag;
  const parts = rest.split("/");
  if (/^[0-9a-f]{7,64}$/i.test(parts[0] ?? "")) {
    return { refType: "commit", ref: parts[0] as string, treePath: parts.slice(1).join("/") };
  }
  const fallback = refs.branches.includes(refs.defaultBranch) ? refs.defaultBranch : (refs.branches[0] ?? refs.defaultBranch);
  return { refType: "branch", ref: fallback, treePath: rest };
}

/** `path.Base` (Go): the final segment; "" and "." stay ".". */
function baseName(treePath: string): string {
  if (treePath === "") return ".";
  const base = treePath.split("/").pop() ?? "";
  return base === "" ? "." : base;
}

/** The shared ref/blob resolution behind both families (download.go's
 *  getBlobForEntry over the middleware-ref arms): the ref resolves against
 *  the refs list; an empty treePath names no blob (upstream
 *  GetTreeEntryByPath("") is the root TREE entry → the NotFound arm); the
 *  engine's readBlob nulls on dirs and gitlinks (the entry.IsDir/
 *  IsSubModule 404 arm) and on misses. `latestCommitTime` runs the
 *  GetTreePathLatestCommit walk (download.go:91-99) — the first commit over
 *  the path at the resolved tip (listLog's path-filtered n=1 walk), null on
 *  the blob arm or a failed walk (the null-on-failure reduction). */
async function resolveRefBlob(
  env: Env,
  repo: RawMediaRepo,
  target: RawMediaTarget,
  options: { latestCommitTime: boolean },
): Promise<{ blob: BlobResult; treePath: string; lastModified: Date | null } | null> {
  const reads = engineReads(env, repo);
  const refsResult = await reads.listRefs();
  if (refsResult === null) return null;
  const refs: RefSuffixRefs = {
    branches: refsResult.refs
      .filter((ref) => ref.name.startsWith("refs/heads/"))
      .map((ref) => ref.name.slice("refs/heads/".length)),
    tags: refsResult.refs.filter((ref) => ref.name.startsWith("refs/tags/")).map((ref) => ref.name.slice("refs/tags/".length)),
    defaultBranch: repo.defaultBranch,
  };

  let resolved: { refType: RefType; ref: string; treePath: string } | null;
  if (target.kind === "blob") {
    // The boundary-gap arm (module header): the GetBlob existence probe,
    // then no bytes — the render-file blob arm's reduction.
    const commit = await reads.readCommit(target.sha);
    if (commit === null) return null;
    return null;
  }
  if (target.kind === "legacy") {
    resolved = resolveLegacyRefSuffix(target.refSuffix, refs);
  } else {
    resolved = resolveRefSuffix(target.refType, target.refSuffix, refs);
  }
  if (resolved === null) return null; // "branch or tag not exist" (repo.go:976-979)
  if (resolved.treePath === "") return null; // GetTreeEntryByPath("") → the root tree → NotFound
  const blob = await reads.readBlob(resolved.ref, resolved.treePath);
  if (blob === null) return null;
  let lastModified: Date | null = null;
  if (options.latestCommitTime) {
    // The walk starts at the RESOLVED ref (ctx.Repo.Commit — not the blob).
    const log = await reads.listLog(resolved.ref, { path: resolved.treePath, n: 1 });
    const commit = log?.commits[0];
    if (commit !== undefined) lastModified = new Date(commit.committer.time * 1000);
  }
  return { blob, treePath: resolved.treePath, lastModified };
}

// ---------------------------------------------------------------------------
// The RAW arm — load + response (common.ServeBlob's exact order)
// ---------------------------------------------------------------------------

/** The raw arm's load outcome: the blob + its ServeBlob inputs, or null —
 *  the 404 family (empty repo, unresolvable ref, missing blob path). */
export type RawBlobLoad =
  | {
      kind: "raw";
      blob: BlobResult;
      /** path.Base(TreePath) — the disposition filename (blob arm: "."). */
      filename: string;
      /** GetTreePathLatestCommit's committer time; null on the blob arm or a
       *  failed walk (the null-on-failure reduction). */
      lastModified: Date | null;
    }
  | { kind: "not-found" };

/**
 * The RAW arm loader (download.go SingleDownload/DownloadByID): the shared
 * blob resolution + the tree path's latest-commit walk for lastModified
 * (skipped on the blob arm — nil upstream).
 */
export async function loadRawBlob(env: Env, repo: RawMediaRepo, target: RawMediaTarget): Promise<RawBlobLoad> {
  if (repo.isEmpty) return { kind: "not-found" }; // MustBeNotEmpty (web.go:1713's group gate)
  const found = await resolveRefBlob(env, repo, target, { latestCommitTime: target.kind !== "blob" });
  if (found === null) return { kind: "not-found" };
  return { kind: "raw", blob: found.blob, filename: baseName(found.treePath), lastModified: found.lastModified };
}

/** The wiki-raw module's etagMatches — the comma-list, W/-insensitive,
 *  `*`-matching If-None-Match test (httpcache.go:57-75). */
function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;
  const bare = etag.replace(/^W\//, "");
  return trimmed.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === bare);
}

/** httpcache.go:104-113's second-truncated If-Modified-Since compare —
 *  ignored whenever If-None-Match is present. */
function ifModifiedSinceMatches(ifModifiedSince: string | null, lastModified: Date): boolean {
  if (ifModifiedSince === null || ifModifiedSince === "") return false;
  const since = new Date(ifModifiedSince);
  if (Number.isNaN(since.getTime())) return false;
  return Math.floor(lastModified.getTime() / 1000) <= Math.floor(since.getTime() / 1000);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/** The sniffed content headers — serveSetHeadersByUserContent →
 *  ServeSetHeaders over one prefetch buffer (the release-downloads builder's
 *  matrix; the disposition is the sniffed inline default — UI.SVG.Enabled
 *  default true keeps SVG inline). */
function applyUserContentHeaders(headers: Headers, prefix: Uint8Array, size: number, filename: string): void {
  const contentType = userContentType(sniffContentType(prefix));
  headers.set("content-type", contentType);
  headers.set("x-content-type-options", "nosniff");
  const csp = userContentCsp(contentType);
  if (csp === null) headers.delete("content-security-policy");
  else headers.set("content-security-policy", csp);
  headers.set("content-length", String(size));
  headers.set("content-disposition", encodeContentDisposition("inline", filename));
  headers.set("access-control-expose-headers", "Content-Disposition");
  if (SKIP_COMPRESSION_EXTS.has(extensionOf(filename))) headers.set("x-no-compression", "1");
}

/**
 * The RAW blob Response — common.ServeBlob's port (module header's matrix).
 * The 304 answers the ETag/If-Modified-Since pair with the ETag +
 * Last-Modified ONLY (HandleGenericETagPrivateCache returns before
 * SetCacheControlInHeader — the wiki-raw exact-order port); the 200 carries
 * the sniffed headers and the public/private 6 h static stamp (ServeBlob's
 * CacheIsPublic + StaticCacheTime options).
 */
export function rawBlobResponse(
  load: Extract<RawBlobLoad, { kind: "raw" }>,
  options: { cacheIsPublic: boolean; ifNoneMatch: string | null; ifModifiedSince: string | null },
): Response {
  const etag = `"${load.blob.oid}"`; // serve.go:21's quoted blob oid
  const headers = new Headers();
  headers.set("etag", etag);
  if (load.lastModified !== null) headers.set("last-modified", httpTime(load.lastModified));
  if (etagMatches(options.ifNoneMatch, etag)) return new Response(null, { status: 304, headers });
  if (
    load.lastModified !== null &&
    options.ifNoneMatch === null &&
    ifModifiedSinceMatches(options.ifModifiedSince, load.lastModified)
  ) {
    return new Response(null, { status: 304, headers });
  }
  const prefix = load.blob.data.subarray(0, Math.min(load.blob.data.byteLength, SNIFF_CONTENT_SIZE));
  applyUserContentHeaders(headers, prefix, load.blob.data.byteLength, load.filename);
  headers.set("cache-control", `${options.cacheIsPublic ? "public" : "private"}, max-age=${STATIC_CACHE_TIME_SECONDS}`);
  return new Response(load.blob.data, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// The MEDIA arm — the LFS-aware variant (download.go ServeBlobOrLFS)
// ---------------------------------------------------------------------------

/** The media arm's load outcome (module header): `blob` = the plain
 *  ServeBlob fall-through (no valid pointer or no meta row — and the
 *  row-without-bytes race's graceful arm), `redirect` = the presign posture
 *  (ServeDirect → ctx.Redirect 303), `lfs` = the relayed object bytes with
 *  the sniff prefix split off. */
export type MediaFileLoad =
  | { kind: "blob"; raw: Extract<RawBlobLoad, { kind: "raw" }> }
  | {
      kind: "redirect";
      location: string;
      /** The pointer oid — the second ETag gate's bytes. */
      pointerOid: string;
      /** The meta row's updatedAt — the gate's Last-Modified. */
      metaUpdatedAt: Date;
      filename: string;
    }
  | {
      kind: "lfs";
      pointerOid: string;
      metaUpdatedAt: Date;
      /** The sniff prefix (≤ SNIFF_CONTENT_SIZE) — split off the stream. */
      prefix: Uint8Array;
      body: ReadableStream<Uint8Array>;
      /** The stored object's size (Content-Length). */
      size: number;
      /** The stored object's upload time — ServeUserContentByFile's
       *  Stat().ModTime (the 200's Last-Modified). */
      uploadedAt: Date;
      filename: string;
    }
  | { kind: "not-found" };

/**
 * The MEDIA arm loader (download.go SingleDownloadOrLFS/DownloadByIDOrLFS →
 * ServeBlobOrLFS): the shared blob resolution WITH the latest-commit walk
 * (SingleDownloadOrLFS computed it inside getBlobForEntry before the probe;
 * the blob arms pass nil — DownloadByID*), then the pointer probe — the
 * first 1024 bytes through the LANDED parser (`strict: false`: a non-pointer
 * answers null; a MALFORMED pointer throws InvalidPointerError — caught to
 * the same fall-through, exactly upstream's IsValid() == false arm). A valid
 * pointer reads the meta row (GetLFSMetaObjectByOid over `lfsRepoId`) and
 * opens the LFS bytes; the presign posture mints the redirect first
 * (upstream's ServeDirect arm sits between the gate and the read).
 */
export async function loadMediaBlob(env: Env, repo: RawMediaRepo, target: RawMediaTarget): Promise<MediaFileLoad> {
  if (repo.isEmpty) return { kind: "not-found" }; // MustBeNotEmpty (web.go:1705's group gate)
  const found = await resolveRefBlob(env, repo, target, { latestCommitTime: target.kind !== "blob" });
  if (found === null) return { kind: "not-found" };
  const raw: Extract<RawBlobLoad, { kind: "raw" }> = {
    kind: "raw",
    blob: found.blob,
    filename: baseName(found.treePath),
    lastModified: found.lastModified,
  };
  const probe = found.blob.data.subarray(0, Math.min(found.blob.data.byteLength, POINTER_PROBE_BYTES));
  const pointer = (() => {
    try {
      return parsePointer(probe, { strict: false });
    } catch (error) {
      if (error instanceof PointerTooLargeError) throw error; // unreachable — the probe slices
      return null; // InvalidPointerError — upstream's invalid-pointer arm
    }
  })();
  const pointerOid = pointer?.oid ?? null;
  if (pointerOid === null) return { kind: "blob", raw };

  const { state, store } = defaultLfsDeps(env);
  const meta = await state.get(lfsRepoId(repo.id), pointerOid);
  if (meta === null) return { kind: "blob", raw }; // GetLFSMetaObjectByOid's miss → plain ServeBlob

  const filename = baseName(found.treePath);
  const key = lfsKey(repo.storageKey, pointerOid);
  const href = await store.presignGet({ key });
  if (href !== null) {
    return { kind: "redirect", location: href.href, pointerOid, metaUpdatedAt: meta.updatedAt, filename };
  }
  const object = await store.get(key);
  if (object === null) return { kind: "blob", raw }; // the row-without-bytes race — the graceful arm
  const { prefix, rest } = await splitPrefetch(object.body as ReadableStream<Uint8Array>);
  return {
    kind: "lfs",
    pointerOid,
    metaUpdatedAt: meta.updatedAt,
    prefix,
    body: rest,
    size: object.size,
    uploadedAt: object.uploaded,
    filename,
  };
}

/**
 * The MEDIA blob Response — download.go ServeBlobOrLFS's port. The plain
 * fall-through re-runs the RAW builder (the gate's ETag is the git blob
 * oid, Last-Modified the tree path's latest-commit time from the loader);
 * the LFS outcomes run the SECOND gate (ETag = the pointer oid,
 * Last-Modified = the meta's updated time — HandleGenericETagPrivateCache
 * again, 304 = the two headers only); the redirect answers 303 after that
 * gate; the relayed 200 stamps the zero-duration private Cache-Control and
 * re-dates Last-Modified to the object's storage time
 * (ServeUserContentByFile's Stat().ModTime).
 */
export function mediaBlobResponse(
  load: Exclude<MediaFileLoad, { kind: "not-found" }>,
  options: { cacheIsPublic: boolean; ifNoneMatch: string | null; ifModifiedSince: string | null },
): Response {
  if (load.kind === "blob") {
    return rawBlobResponse(load.raw, {
      cacheIsPublic: options.cacheIsPublic,
      ifNoneMatch: options.ifNoneMatch,
      ifModifiedSince: options.ifModifiedSince,
    });
  }
  // The SECOND gate (download.go:35-37): ETag flips to the pointer oid and
  // Last-Modified to the meta's updated time — overwriting the first gate's
  // stamps before any answer is written.
  const etag = `"${load.pointerOid}"`;
  const headers = new Headers();
  headers.set("etag", etag);
  headers.set("last-modified", httpTime(load.metaUpdatedAt));
  if (etagMatches(options.ifNoneMatch, etag)) return new Response(null, { status: 304, headers });
  if (options.ifNoneMatch === null && ifModifiedSinceMatches(options.ifModifiedSince, load.metaUpdatedAt)) {
    return new Response(null, { status: 304, headers });
  }
  if (load.kind === "redirect") {
    // ServeDirect (download.go:46-54) → ctx.Redirect's 303 (base.go:157).
    return new Response(null, {
      status: 303,
      headers: { location: load.location, etag, "last-modified": httpTime(load.metaUpdatedAt) },
    });
  }
  // The relayed 200 — ServeUserContentByFile (download.go:62-64): the
  // empty-options stamp (zero-duration private), the object's storage time
  // as Last-Modified (Stat().ModTime), the sniff prefix re-streamed ahead
  // of the body (the MultiReader shape).
  headers.set("last-modified", httpTime(load.uploadedAt));
  applyUserContentHeaders(headers, load.prefix, load.size, load.filename);
  headers.set("cache-control", WEB_CACHE_CONTROL);
  return new Response(load.body, { status: 200, headers });
}

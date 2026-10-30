/**
 * The census C4 artifacts module (docs/research/actions-ui-census.md §1.1's
 * artifacts tails + §3.8): the run-artifact PREVIEW page — the
 * artifact_preview.tmpl port over ArtifactsPreviewView's ctx data — plus the
 * signed root RAW-content serving the page's iframe and the run viewer's
 * previewLink compose from. The `ViewResponse.artifacts[]` roll-up itself is
 * C2's (repo-actions-view.tsx, landed); C4 supplies what its `previewLink`
 * points at.
 *
 * Upstream pin (VERIFIED at fc4936884584a41931906553d96c2601d750e6ef):
 *
 *   - GET /{owner}/{repo}/actions/artifacts/{artifact_id}/preview[/ *]
 *     (web.go:1596-1598, actions.ArtifactsPreviewView — view_artifact.go:341-390):
 *     the SSR file browser; `reqSignIn` per the census (user-generated HTML
 *     under the instance domain).
 *   - GET /-/actions/artifacts/{artifact_id}/{expires}/{signature}[/*]
 *     (web.go:293, actions.ArtifactsPreviewRawView — view_artifact.go:402-484):
 *     ROOT-level, no session — the sandboxed iframe sends no cookies, so the
 *     HMAC (artifact_id, expires) triple IS the auth, and Sec-Fetch-Dest:
 *     document 302s to the repo-scoped preview page.
 *   - The panel-side tails the run viewer's Vue app links —
 *     `GET+DELETE /actions/runs/{run}/artifacts/{artifact_name}`
 *     (view.go:1201-1282 download/delete) — are NOT this module: the download
 *     composes the legacy zip and the delete answers JSONOK, both needing
 *     their own route arms; REPORTED for the orchestrator's wiring window.
 *
 * ## Route wiring (ui/index.ts is orchestrator-owned — the REPORTED arms)
 *
 *   1. `actions-artifact-preview` (repo family): GET
 *      `/{owner}/{repo}/actions/artifacts/{id}/preview` + the `/preview/{tail}`
 *      shape → gate ladder = the C2 family's read ladder (resolveUiRequest +
 *      repo.MustBeNotEmpty + MustEnableActions) →
 *      loadArtifactPreviewPageData(env, repo, id, tail) → 404 shell on
 *      "not-found", the 500 chrome on "error" (upstream's ServerError arms —
 *      a missing/unconfirmed artifact IS a ServerError here, view_artifact.go:346-353),
 *      else c.html(renderArtifactPreviewPage(ctx, data)).
 *   2. `actions-artifact-preview-raw` (ROOT family, outside any repo group):
 *      GET `/-/actions/artifacts/{id}/{expires}/{signature}/{tail}` →
 *      serveArtifactPreviewRaw(env, { artifactId, expires, signature, tail,
 *      secFetchDest: req.headers.get("sec-fetch-dest"), helperScriptSrc }).
 *      helperScriptSrc: the manifest's `web_src/js/external-render-helper.ts`
 *      entry resolved through the same assetUrlPrefix the shell uses — the
 *      HTML-preview sandbox helper.
 *
 * ## Data (view_artifact.go over the M1b store)
 *
 * Rows read through services/actions/artifacts.ts's landed surface
 * (getArtifactById + findReadableArtifacts = loadUploadedArtifactsByID's
 * family query, GetArtifactsByRunAttemptAndName). The v4 artifact is a
 * single-file ZIP in R2 (`actions/artifacts/<run>/<artifact>`): the listing
 * parses the central directory; entry serving slices the local file header's
 * data run and inflates method-8 entries through the platform
 * DecompressionStream("deflate-raw"). Legacy rows are one file each —
 * gzipped on store (content_encoding "gzip"), served gunzipped.
 *
 * ## Documented divergences (each cites its upstream arm)
 *
 * - The zip-listing LRU (10 min, keyed artifactID+updated) has no instance
 *   cache in Workers; every preview request re-lists (the C2 ref-cache
 *   posture — reads are R2 hops already paid by the page view).
 * - Zip64 entries are not parsed: the preview gate caps artifacts at
 *   ArtifactPreviewMaxSize (10 MiB) BEFORE any read, far below the zip64
 *   thresholds; a zip64 artifact's listing falls back to the single-file
 *   fallback path exactly like upstream's zip.ErrFormat arm.
 * - typesniffer.DetectContentType is ported as the SUBSET the preview gate
 *   reads (IsText/IsImage/IsPDF over Go's sniff signatures for
 *   jpeg/png/gif/webp/bmp/ico/avif/svg/pdf plus Go's binary-control-byte
 *   heuristic); unknown exotic formats answer text/plain or octet-stream
 *   where Go's full table would name them — the 415 gate's decisions match
 *   on every input the difference could touch (text vs binary vs image/pdf).
 * - The back-arrow icon ({{svg "octicon-arrow-left"}}) renders no icon: the
 *   generated icon set (ui/icons.generated.ts, a shared file) carries no
 *   arrow glyph yet; the anchor keeps the exact classes/text the CSS and the
 *   census's DOM contract target. The directory icon rides the bundled
 *   octicon-file-directory-fill twin (octicon-file-directory is also absent).
 * - ServeSetHeaders' cache-control leg is upstream's default-verbosed shape
 *   for a non-cacheable response; the raw route omits it (the signed URL is
 *   single-purpose, the iframe is no-store-prone) — only the disposition +
 *   CORS headers are set, as view_artifact.go's own sets are.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories } from "../../db/schema";
import { actionsBuildSignature, base64RawUrlEncode, signaturesEqual } from "../../services/actions/secrets";
import {
  ARTIFACT_STATUS_UPLOAD_CONFIRMED,
  CONTENT_ENCODING_V3_GZIP,
  findReadableArtifacts,
  getArtifactById,
  type ArtifactRow,
} from "../../services/actions/artifacts";
import {
  ARTIFACT_PREVIEW_MAX_SIZE,
  getRunAttemptByRepoAndId,
  getRunByRepoAndId,
  isArtifactPreviewSizeAllowed,
  repoActionsViewLocale,
} from "./repo-actions-view";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";

type D1 = D1Database;

// ---------------------------------------------------------------------------
// The locale (artifact_preview.tmpl's ctx.Locale.Tr keys, read from
// options/locale/locale_en-US.json at the pin)
// ---------------------------------------------------------------------------

export const artifactPreviewLocale = {
  preview: "Preview", // "preview"
  files: "Files", // "files"
  backToRun: "Back to action run #%d", // "actions.artifacts.back_to_run"
  backToRunAttempt: "Back to action run #%d (attempt %d)", // "actions.artifacts.back_to_run_attempt"
  previewNoFiles: "This artifact contains no files to preview.", // "actions.artifacts.preview_no_files"
  previewTooLarge: "This artifact is too large to preview. Please download it to view its contents.", // "actions.artifacts.preview_artifact_too_large"
  previewFileNotFound: "The requested file is not present in this artifact.", // "actions.artifacts.preview_file_not_found"
  previewFilesTruncated: "This artifact contains many files, so only the first files are shown.", // "actions.artifacts.preview_file_list_truncated"
} as const;

/** TrString's %d substitution (the two back-link formats). */
export function formatPreviewCount(format: string, ...values: number[]): string {
  let out = format;
  for (const value of values) {
    out = out.replace("%d", String(value));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The size gates (view_artifact.go:179-182 + setting.UI.MaxDisplayFileSize)
// ---------------------------------------------------------------------------

/** setting.UI.MaxDisplayFileSize's default (modules/setting/ui.go:98) — the
 *  per-FILE preview ceiling of ServeArtifactPreviewContent (413 above it). */
export const MAX_DISPLAY_FILE_SIZE = 8 * 1024 * 1024;

/** artifactPreviewMaxFiles (view_artifact.go:61). */
export const ARTIFACT_PREVIEW_MAX_FILES = 2000;

// ---------------------------------------------------------------------------
// Path helpers (util/path.go + util/url.go — the exact ports)
// ---------------------------------------------------------------------------

/** Go path.Clean (the POSIX algorithm, for the PathJoinRel port). */
export function goPathClean(p: string): string {
  if (p === "") return ".";
  const rooted = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!rooted) {
        out.push("..");
      }
      continue;
    }
    out.push(part);
  }
  const cleaned = (rooted ? "/" : "") + out.join("/");
  return cleaned === "" ? "." : cleaned;
}

/** PathJoinRelX over ONE element (path.go:74-83): backslashes fold to
 *  slashes, Clean anchors at "/", the leading slash strips; "/" lands ".". */
export function pathJoinRelX(value: string): string {
  if (value === "") return "";
  const cleaned = goPathClean(`/${value.replaceAll("\\", "/")}`);
  return cleaned === "/" ? "." : cleaned.slice(1);
}

/** normalizeArtifactPreviewPath (view_artifact.go:136-142). */
export function normalizeArtifactPreviewPath(path: string): string {
  const joined = pathJoinRelX(path);
  return joined === "." ? "" : joined;
}

/** PathEscapeSegments (util/url.go:12-19). */
export function pathEscapeSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** artifactPreviewFallbackPath (view_artifact.go:144-146) — the row's
 *  artifactPath, falling back to the artifact name. */
export function artifactPreviewFallbackPath(artifact: ArtifactRow): string {
  return normalizeArtifactPreviewPath(artifact.artifactPath) || artifact.artifactName;
}

/** IsArtifactV4 (services/actions/artifacts.go:21-23) — a content type (it
 *  contains "/") marks the v4 single-file zip. */
export function isArtifactV4(artifact: ArtifactRow): boolean {
  return artifact.contentEncodingOrType.includes("/");
}

// ---------------------------------------------------------------------------
// The page clock (the ROUTE_CLOCK seam's page-module twin — ui/index.ts's
// module-scope route clock + `__setRouteClockForTests`, the seam that
// un-skipped the admin-monitor-cron golden). The signed-link expiry hop in
// artifactPreviewRawLink hardcoded `Date.now()`, so every /preview/{path}
// render carried wall-clock bytes in the iframe's data-src and the tail
// golden stayed excluded (the goldens.test.ts block comment). The
// rendered-byte call below consults `artifactPreviewNow()`; with the
// override unset (production) the expression is exactly the wall clock, so
// every response is byte-identical to the pre-seam behavior — no
// request-visible surface change. The raw route's expiry GATE
// (serveArtifactPreviewRaw) deliberately does NOT consult it: it is a
// decision, not rendered bytes (the route-clock seam's stored-row-stamp
// care, one class over).
//
// No request state: one module-scope variable, read at link-compose time,
// written ONLY by the test hook below (module-level pure).
// ---------------------------------------------------------------------------

/** The test-only page clock: returns the pinned Date, or null to fall back
 *  to the wall clock. */
type ArtifactPreviewClock = () => Date | null;

let ARTIFACT_PREVIEW_CLOCK: ArtifactPreviewClock | null = null;

/**
 * TEST-ONLY (the name marks it): pin or clear the clock that
 * artifactPreviewRawLink's expiry hop consults. `null` restores the wall
 * clock. Never call from production code — the golden harness
 * (`__tests__/goldens.test.ts`) is the only intended caller.
 */
export function __setArtifactPreviewClockForTests(clock: ArtifactPreviewClock | null): void {
  ARTIFACT_PREVIEW_CLOCK = clock;
}

/** The clock the signed-link expiry runs on: the pinned override when the
 *  test harness set one, the wall clock otherwise
 *  (`ARTIFACT_PREVIEW_CLOCK?.() ?? new Date()`). */
function artifactPreviewNow(): Date {
  return ARTIFACT_PREVIEW_CLOCK?.() ?? new Date();
}

// ---------------------------------------------------------------------------
// The HMAC link (view_artifact.go:392-400 over secrets.ts's BuildSignature)
// ---------------------------------------------------------------------------

/** artifactPreviewSignature (view_artifact.go:392-394). */
export async function artifactPreviewSignature(env: Env, artifactId: number, expires: number): Promise<string> {
  const digest = await actionsBuildSignature(env, "artifact-preview", [String(artifactId), String(expires)]);
  return base64RawUrlEncode(digest);
}

/** artifactPreviewRawLink (view_artifact.go:397-400): one hour out; the
 *  trailing slash is load-bearing (the route's tail mounts after it). */
export async function artifactPreviewRawLink(env: Env, artifactId: number): Promise<string> {
  const expires = Math.floor(artifactPreviewNow().getTime() / 1000) + 60 * 60;
  const signature = await artifactPreviewSignature(env, artifactId, expires);
  return `/-/actions/artifacts/${artifactId}/${expires}/${signature}/`;
}

// ---------------------------------------------------------------------------
// The artifact family read (loadUploadedArtifactsByID, view_artifact.go:111-134)
// ---------------------------------------------------------------------------

/**
 * loadUploadedArtifactsByID's port: the row, then every row of its
 * (run, attempt, name) family ordered by id; null when the family is empty
 * or ANY row is not UploadConfirmed (an expired/pending-deletion artifact
 * reads as missing). The caller adds the repo scoping and maps null to its
 * own error arm (the page 500s, the raw route 404s — upstream's split).
 */
export async function loadUploadedArtifactsById(d1: D1, artifactId: number): Promise<ArtifactRow[] | null> {
  const art = await getArtifactById(d1, artifactId);
  if (art === null) return null;
  const family = await findReadableArtifacts(d1, {
    runId: art.runId,
    runAttemptIds: [art.runAttemptId],
    artifactName: art.artifactName,
  });
  if (family.length === 0 || family.some((row) => row.status !== ARTIFACT_STATUS_UPLOAD_CONFIRMED)) {
    return null;
  }
  return family;
}

/** artifactsTotalSize (view_artifact.go:184-189). */
export function artifactsTotalSize(artifacts: ArtifactRow[]): number {
  return artifacts.reduce((sum, art) => sum + art.fileSize, 0);
}

// ---------------------------------------------------------------------------
// The preview listing (view_artifact.go:148-248)
// ---------------------------------------------------------------------------

export interface ArtifactPreviewFile {
  path: string;
  name: string;
  /** Empty for directories. */
  link: string;
  depth: number;
  selected: boolean;
}

export interface ArtifactPreviewList {
  paths: string[];
  truncated: boolean;
}

/** newArtifactPreviewList (view_artifact.go:172-177): sort, dedupe, cap at
 *  artifactPreviewMaxFiles. */
function newArtifactPreviewList(paths: string[]): ArtifactPreviewList {
  const sorted = [...new Set(paths)].sort();
  return {
    paths: sorted.slice(0, ARTIFACT_PREVIEW_MAX_FILES),
    truncated: sorted.length > ARTIFACT_PREVIEW_MAX_FILES,
  };
}

/** buildArtifactPreviewFiles (view_artifact.go:148-170): the directory rows
 *  first-seen order interleaved with the file rows (depth = segment count - 1;
 *  links carry the escaped path appended to previewLink). */
export function buildArtifactPreviewFiles(paths: string[], selectedPath: string, previewLink: string): ArtifactPreviewFile[] {
  const previewFiles: ArtifactPreviewFile[] = [];
  const seenDirs = new Set<string>();
  for (const filePath of paths) {
    const parts = filePath.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      if (seenDirs.has(dirPath)) continue;
      seenDirs.add(dirPath);
      previewFiles.push({ path: dirPath, name: parts[i] ?? "", link: "", depth: i, selected: false });
    }
    previewFiles.push({
      path: filePath,
      name: parts[parts.length - 1] ?? filePath,
      link: previewLink + pathEscapeSegments(filePath),
      depth: parts.length - 1,
      selected: filePath === selectedPath,
    });
  }
  return previewFiles;
}

// ---------------------------------------------------------------------------
// The zip reader (the v4 single-file archive — central directory + local
// headers; the streaming inflate rides the platform DecompressionStream)
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  headerOffset: number;
}

interface ParsedZip {
  entries: ZipEntry[];
  /** The whole object's bytes — bounded by the preview size gate BEFORE the
   *  read (the size is known from D1; this is not an unbounded body). */
  bytes: Uint8Array;
  /** True when the bytes are not a readable zip (upstream zip.ErrFormat). */
  invalid: boolean;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

/** The subsequence search the helper-script tag scan needs. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  const matchesAt = (at: number): boolean => {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[at + j] !== needle[j]) return false;
    }
    return true;
  };
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (matchesAt(i)) return i;
  }
  return -1;
}

/** artifactV4ZipFilePath (view_artifact.go:204-210): directory entries (the
 *  trailing slash) and empty normalized names drop out. */
function zipEntryFilePath(name: string): string {
  if (name.endsWith("/")) return "";
  return normalizeArtifactPreviewPath(name);
}

/** Parse the EOCD + central directory. A truncated/malformed archive sets
 *  `invalid` (the ErrFormat arm) instead of throwing. */
function parseZip(bytes: Uint8Array): ParsedZip {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  // The EOCD is at most 22 bytes + a 64 KiB comment.
  const searchFloor = Math.max(0, bytes.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = bytes.length - 22; i >= searchFloor; i--) {
    if (readU32(bytes, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { entries: [], bytes, invalid: true };
  const count = readU16(bytes, eocd + 10);
  const cdOffset = readU32(bytes, eocd + 16);
  const entries: ZipEntry[] = [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || readU32(bytes, at) !== CD_SIG) {
      return { entries: [], bytes, invalid: true };
    }
    const nameLength = readU16(bytes, at + 28);
    const extraLength = readU16(bytes, at + 30);
    const commentLength = readU16(bytes, at + 32);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.push({
      name,
      method: readU16(bytes, at + 10),
      compressedSize: readU32(bytes, at + 20),
      uncompressedSize: readU32(bytes, at + 24),
      headerOffset: readU32(bytes, at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, bytes, invalid: false };
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const body = new Response(new Uint8Array(compressed)).body;
  if (body === null) throw new Error("actions: zip inflate lost its body");
  return new Uint8Array(await new Response(body.pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
}

/** A zip entry's uncompressed bytes (method 0 passthrough, method 8 raw
 *  inflate; anything else is upstream's unsupported-archive territory — the
 *  ErrFormat-style fallback owns it). */
async function zipEntryBytes(zip: ParsedZip, entry: ZipEntry): Promise<Uint8Array | null> {
  if (entry.headerOffset + 30 > zip.bytes.length || readU32(zip.bytes, entry.headerOffset) !== 0x04034b50) {
    return null;
  }
  const nameLength = readU16(zip.bytes, entry.headerOffset + 26);
  const extraLength = readU16(zip.bytes, entry.headerOffset + 28);
  const dataStart = entry.headerOffset + 30 + nameLength + extraLength;
  if (dataStart + entry.compressedSize > zip.bytes.length) return null;
  const compressed = zip.bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRaw(compressed);
  return null;
}

/** listPreviewForV4Artifact's port minus the LRU (the divergence note): the
 *  merged object's zip listing; an unreadable archive falls back to the
 *  row's single path (view_artifact.go:219-222). */
async function listPreviewForV4Artifact(env: Env, artifact: ArtifactRow): Promise<ArtifactPreviewList> {
  const obj = await env.REPO_PACKS.get(artifact.storagePath);
  if (obj === null) throw new Error(`storage open "${artifact.storagePath}": object missing`);
  const zip = parseZip(new Uint8Array(await obj.arrayBuffer()));
  if (zip.invalid) {
    return newArtifactPreviewList([artifactPreviewFallbackPath(artifact)]);
  }
  const paths: string[] = [];
  for (const entry of zip.entries) {
    const path = zipEntryFilePath(entry.name);
    if (path !== "") paths.push(path);
  }
  return newArtifactPreviewList(paths);
}

/** listPreview (view_artifact.go:239-248): a lone v4 artifact lists its zip;
 *  the legacy shape is one path per row. */
export async function listArtifactPreview(env: Env, artifacts: ArtifactRow[]): Promise<ArtifactPreviewList> {
  if (artifacts.length === 1 && isArtifactV4(artifacts[0]!)) {
    return listPreviewForV4Artifact(env, artifacts[0]!);
  }
  return newArtifactPreviewList(artifacts.map(artifactPreviewFallbackPath));
}

// ---------------------------------------------------------------------------
// The content sniffer (ServeArtifactPreviewContent's DetectContentType subset
// — the divergence note documents the trim)
// ---------------------------------------------------------------------------

/** Go http.DetectContentType's binary heuristic + the preview gate's
 *  signature set, over at most SniffContentSize (1024) bytes. */
export function sniffPreviewContentType(head: Uint8Array): string {
  const data = head.subarray(0, Math.min(head.length, 1024));
  const hasPrefix = (sig: string, offset = 0): boolean => {
    if (data.length < offset + sig.length) return false;
    for (let i = 0; i < sig.length; i++) {
      if (data[offset + i] !== sig.charCodeAt(i)) return false;
    }
    return true;
  };
  const hasBytes = (bytes: number[]): boolean => {
    if (data.length < bytes.length) return false;
    return bytes.every((b, i) => data[i] === b);
  };

  if (hasBytes([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasBytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasPrefix("GIF87a") || hasPrefix("GIF89a")) return "image/gif";
  if (hasPrefix("RIFF") && data.length >= 12 && hasPrefix("WEBP", 8)) return "image/webp";
  if (hasPrefix("BM")) return "image/bmp";
  if (hasBytes([0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (data.length >= 12 && hasPrefix("ftyp", 4) && hasPrefix("avif", 8)) return "image/avif";
  if (hasPrefix("%PDF-")) return "application/pdf";
  // The svg arm (typesniffer's regexes, flattened): optional XML prolog +
  // DOCTYPE, then the <svg tag — case-insensitive.
  const headText = new TextDecoder().decode(data).replace(/^[\s\ufeff]+/, "");
  const svgProbe = headText
    .replace(/^<\?xml[\s\S]*?\?>/i, "")
    .replace(/^<!doctype\s+svg[\s\S]*?>/i, "")
    .replace(/^[\s\ufeff]+/, "");
  if (/^<svg[\s>]/i.test(svgProbe)) return "image/svg+xml";

  // Go's text heuristic: the first non-whitespace through the cap must not
  // carry the binary control-byte set.
  let firstNonWs = 0;
  while (firstNonWs < data.length && (data[firstNonWs] === 9 || data[firstNonWs] === 10 || data[firstNonWs] === 12 || data[firstNonWs] === 13 || data[firstNonWs] === 32)) {
    firstNonWs++;
  }
  for (let i = firstNonWs; i < data.length; i++) {
    const b = data[i]!;
    if (b <= 0x08 || b === 0x0b || (b >= 0x0e && b <= 0x1a) || (b >= 0x1c && b <= 0x1f)) {
      return "application/octet-stream";
    }
  }
  return "text/plain; charset=utf-8";
}

/** DetectWellKnownMimeType's arms of artifactPreviewContentType
 *  (view_artifact.go:250-259) — Go's mime.TypeByExtension spellings. */
function wellKnownMimeByExt(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  switch (filename.slice(dot).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".htm":
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    default:
      return null;
  }
}

/** artifactPreviewContentType (view_artifact.go:250-259). */
export function artifactPreviewContentType(filename: string, sniffed: string): string {
  const wellKnown = wellKnownMimeByExt(filename);
  if (wellKnown !== null) return wellKnown;
  if (sniffed.includes("text/plain")) return "text/plain; charset=utf-8";
  return sniffed;
}

/** getSafeName + encodeContentDisposition (content_disposition.go:16-65):
 *  the ASCII-safe quoted form, plus the RFC 2231 filename* twin when any
 *  rune needed masking. `kind` is the disposition word — upstream carries it
 *  as ContentDispositionType (inline for the preview content, attachment for
 *  the download arms: ServeSetHeaders' default and the zip-compose set,
 *  view.go:1245). */
function encodeContentDisposition(kind: "inline" | "attachment", filename: string): string {
  let safe = "";
  let needsEncoding = false;
  for (const char of filename) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 || code > 0x7e) && code !== 0x09) {
      needsEncoding = true;
      safe += "_";
    } else {
      safe += char;
    }
  }
  const quoted = (value: string): string =>
    // mime.FormatMediaType quotes any value beyond Go's isTokenChar set
    // (RFC 2045 token chars: the specials !#$%&'*+-.^_`|~ plus alnum).
    /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(value) ? value : `"${value.replaceAll(`"`, `\\"`)}"`;
  const base = `${kind}; filename=${quoted(safe)}`;
  if (!needsEncoding) return base;
  return `${base}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** EncodeContentDispositionInline (content_disposition.go:35). */
export function encodeContentDispositionInline(filename: string): string {
  return encodeContentDisposition("inline", filename);
}

/** EncodeContentDispositionAttachment (content_disposition.go:38) — the
 *  download family's twin (the runs-artifact module composes both arms from
 *  it). */
export function encodeContentDispositionAttachment(filename: string): string {
  return encodeContentDisposition("attachment", filename);
}

/** insertArtifactPreviewHelperScript (view_artifact.go:261-306): the sandbox
 *  helper rides the first structural insertion point — after <head>, else
 *  before <body> (wrapped in a synthesized head), else after <html>, else
 *  prepended. The tag search is case-insensitive over the head buffer, byte
 *  offsets preserved. */
export function insertArtifactPreviewHelperScript(headBuf: Uint8Array, helperScriptSrc: string): Uint8Array {
  const helperScript = new TextEncoder().encode(`<script crossorigin src="${helperScriptSrc}"></script>`);
  const lower = new TextEncoder().encode(new TextDecoder().decode(headBuf).toLowerCase());
  const findTagClose = (from: number): number => {
    const close = lower.indexOf(0x3e /* > */, from);
    return close < 0 ? -1 : close + 1;
  };
  let pos = -1;
  let addHeadTag = false;

  const headAt = indexOfBytes(lower, new TextEncoder().encode("<head"));
  if (headAt !== -1) {
    const close = findTagClose(headAt);
    if (close !== -1) pos = close;
  }
  if (pos === -1) {
    const bodyAt = indexOfBytes(lower, new TextEncoder().encode("<body"));
    if (bodyAt !== -1) {
      pos = bodyAt;
      addHeadTag = true;
    }
  }
  if (pos === -1) {
    const htmlAt = indexOfBytes(lower, new TextEncoder().encode("<html"));
    if (htmlAt !== -1) {
      const close = findTagClose(htmlAt);
      if (close !== -1) {
        pos = close;
        addHeadTag = true;
      }
    }
  }

  const wrapped = addHeadTag
    ? new TextEncoder().encode(`<head><script crossorigin src="${helperScriptSrc}"></script></head>`)
    : helperScript;
  if (pos === -1) {
    const out = new Uint8Array(wrapped.length + headBuf.length);
    out.set(wrapped, 0);
    out.set(headBuf, wrapped.length);
    return out;
  }
  const out = new Uint8Array(headBuf.length + wrapped.length);
  out.set(headBuf.subarray(0, pos), 0);
  out.set(wrapped, pos);
  out.set(headBuf.subarray(pos), pos + wrapped.length);
  return out;
}

// ---------------------------------------------------------------------------
// The content serving (ServeArtifactPreviewContent, view_artifact.go:308-339)
// ---------------------------------------------------------------------------

export interface ServePreviewContentOptions {
  /** The resolved script src for HTML previews (the route wiring's manifest
   *  read); null skips the insertion (no manifest entry). */
  helperScriptSrc: string | null;
}

/**
 * The previewable-content Response: 413 above the per-file display cap, 415
 * for non-text/image/pdf content; the headers carry the inline disposition
 * and the sandbox CORS openness. `content` is bounded: the caller's size is
 * known BEFORE the read (zip entry metadata / the row's fileSize).
 */
export function serveArtifactPreviewContent(
  filePath: string,
  content: Uint8Array,
  size: number,
  options: ServePreviewContentOptions,
): Response {
  if (size < 0 || size > MAX_DISPLAY_FILE_SIZE) {
    return textError(413, "file is too large to preview, please download the artifact instead");
  }
  const data = content.subarray(0, size === 0 ? 0 : Math.min(content.length, size));
  const head = data.subarray(0, Math.min(data.length, 8 * 1024));
  const sniffed = sniffPreviewContentType(head);
  const isText = sniffed.includes("text/");
  const isImage = sniffed.includes("image/");
  const isPdf = sniffed.includes("application/pdf");
  if (!isText && !isImage && !isPdf) {
    return textError(415, "artifact preview is not supported for this file type");
  }

  const contentType = artifactPreviewContentType(filePath, sniffed);
  let body: Uint8Array = data;
  if (contentType.startsWith("text/html") && options.helperScriptSrc !== null) {
    const injected = insertArtifactPreviewHelperScript(head, options.helperScriptSrc);
    const out = new Uint8Array(injected.length + (data.length - head.length));
    out.set(injected, 0);
    out.set(data.subarray(head.length), injected.length);
    body = out;
  }

  const base = filePath.split("/").pop() ?? filePath;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": encodeContentDispositionInline(base),
      "access-control-expose-headers": "Content-Disposition",
      // Module scripts and fetch() from the sandboxed opaque origin need CORS.
      "access-control-allow-origin": "*",
    },
  });
}

function textError(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}


// ---------------------------------------------------------------------------
// The page data (ArtifactsPreviewView + RenderArtifactPreview,
// view_artifact.go:341-390 + 82-109)
// ---------------------------------------------------------------------------

export interface ArtifactPreviewData {
  runUrl: string;
  runIndex: number;
  runAttempt: number;
  artifactName: string;
  downloadUrl: string;
  previewContentUrl: string;
  requestedPathMissing: boolean;
  previewTooLarge: boolean;
  previewFilesTruncated: boolean;
  previewFiles: ArtifactPreviewFile[];
}

export type LoadArtifactPreviewOutcome =
  /** The MaxSize==0 disable arm (view_artifact.go:342-345) — upstream's
   *  NotFound. Our constant is positive, so the arm is dormant. */
  | { outcome: "not-found" }
  /** loadUploadedArtifactsByID / the run / the attempt read arms —
   *  upstream's ServerError (a missing or unconfirmed artifact 500s here,
   *  view_artifact.go:346-353; the raw route 404s its own misses). */
  | { outcome: "error" }
  | { outcome: "ok"; data: ArtifactPreviewData };

/**
 * ArtifactsPreviewView's data assembly: the artifact's family (repo-scoped),
 * the run/attempt back-links, the size gate, the listing, and the requested
 * path's resolution — everything the SSR file browser renders from.
 * `requestedPath` is the route's decoded tail ("" on the bare preview URL).
 */
export async function loadArtifactPreviewPageData(
  env: Env,
  repo: RepoRow,
  artifactId: number,
  requestedPath: string,
): Promise<LoadArtifactPreviewOutcome> {
  if (ARTIFACT_PREVIEW_MAX_SIZE === 0) return { outcome: "not-found" };

  const artifacts = await loadUploadedArtifactsById(env.DB, artifactId);
  if (artifacts === null || (artifacts[0]?.repoId ?? "") !== repo.id) {
    return { outcome: "error" }; // upstream ServerError("loadUploadedArtifactsByID")
  }
  const artifact = artifacts[0]!;

  const run = await getRunByRepoAndId(env.DB, artifact.repoId, artifact.runId);
  if (run === null) return { outcome: "error" }; // upstream ServerError("GetRunByRepoAndID")

  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const runUrl = `${repoLink}/actions/runs/${run.id}`;
  const data: ArtifactPreviewData = {
    runUrl,
    runIndex: run.index,
    runAttempt: 0,
    artifactName: artifact.artifactName,
    downloadUrl: `${runUrl}/artifacts/${encodeURIComponent(artifact.artifactName)}`,
    previewContentUrl: "",
    requestedPathMissing: false,
    previewTooLarge: !isArtifactPreviewSizeAllowed(artifactsTotalSize(artifacts)),
    previewFilesTruncated: false,
    previewFiles: [],
  };
  if (artifact.runAttemptId > 0) {
    const attempt = await getRunAttemptByRepoAndId(env.DB, artifact.repoId, artifact.runAttemptId);
    if (attempt === null) return { outcome: "error" }; // upstream ServerError
    data.runAttempt = attempt.attempt;
    data.runUrl = `${runUrl}/attempts/${attempt.attempt}`;
    data.downloadUrl = `${data.downloadUrl}?attempt=${attempt.attempt}`;
  }

  let list: ArtifactPreviewList = { paths: [], truncated: false };
  if (!data.previewTooLarge) {
    list = await listArtifactPreview(env, artifacts);
  }
  data.previewFilesTruncated = list.truncated;

  // RenderArtifactPreview (view_artifact.go:82-109): the requested path must
  // sit in the listing; a capped listing cannot prove absence, so the file
  // rides in at its sorted position instead of the missing-banner.
  const requested = normalizeArtifactPreviewPath(requestedPath);
  let effectiveRequested = requested;
  if (requested !== "" && !list.paths.includes(requested)) {
    const index = list.paths.findIndex((path) => path >= requested);
    const at = index === -1 ? list.paths.length : index;
    if (list.truncated) {
      const cloned = [...list.paths];
      cloned.splice(at, 0, requested);
      list.paths = cloned.slice(0, ARTIFACT_PREVIEW_MAX_FILES);
    } else {
      data.requestedPathMissing = !data.previewTooLarge;
      effectiveRequested = "";
    }
  }

  // previewLink (view_artifact.go:388) + rawLink (view_artifact.go:389).
  const previewLink = `${repoLink}/actions/artifacts/${artifactId}/preview/`;
  data.previewFiles = buildArtifactPreviewFiles(list.paths, effectiveRequested, previewLink);
  if (effectiveRequested !== "") {
    data.previewContentUrl = (await artifactPreviewRawLink(env, artifactId)) + pathEscapeSegments(effectiveRequested);
  }
  return { outcome: "ok", data };
}

// ---------------------------------------------------------------------------
// The raw serving (ArtifactsPreviewRawView + serveArtifactPreviewRaw,
// view_artifact.go:402-484 — the ROOT route, the HMAC is the auth)
// ---------------------------------------------------------------------------

export interface ArtifactPreviewRawRequest {
  artifactId: number;
  expires: number;
  /** The path's base64url signature segment. */
  signature: string;
  /** The decoded route tail ("" at the bare signed root). */
  tail: string;
  /** The Sec-Fetch-Dest header (the document-navigation redirect arm). */
  secFetchDest: string | null;
  /** The sandbox helper script src (the route wiring's manifest read); null
   *  skips the HTML injection. */
  helperScriptSrc: string | null;
}

/**
 * The raw-content Response for one signed request. Errors follow upstream's
 * split: 404 on the gate/family/entry misses, 413 over the preview cap, 415
 * from the sniffer gate; infrastructure failures throw (the route's 500
 * chrome — upstream's log.Error + HTTPError(500) arm).
 */
export async function serveArtifactPreviewRaw(env: Env, request: ArtifactPreviewRawRequest): Promise<Response> {
  // The gate (view_artifact.go:405-409): the disable arm, the expiry, the
  // HMAC — every miss is an opaque 404. The comparison is over the ENCODED
  // base64 strings' bytes (upstream hmac.Equal's two []byte conversions).
  if (ARTIFACT_PREVIEW_MAX_SIZE === 0 || request.expires < Math.floor(Date.now() / 1000)) {
    return textError(404, "Not Found");
  }
  const expected = await artifactPreviewSignature(env, request.artifactId, request.expires);
  const encoder = new TextEncoder();
  if (!signaturesEqual(encoder.encode(request.signature), encoder.encode(expected))) {
    return textError(404, "Not Found");
  }

  const filePath = normalizeArtifactPreviewPath(request.tail);
  const artifacts = await loadUploadedArtifactsById(env.DB, request.artifactId);
  if (artifacts === null) return textError(404, "Not Found");

  // Only the preview page shows generated content, so top-level navigations
  // redirect there (view_artifact.go:425-432).
  if (request.secFetchDest === "document") {
    const repoRows = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, artifacts[0]!.repoId)).limit(1);
    const repo = repoRows[0];
    if (repo === undefined) throw new Error(`actions: GetRepositoryByID missing ${artifacts[0]!.repoId}`);
    const location = `/${repo.ownerNamespace}/${repo.slug}/actions/artifacts/${request.artifactId}/preview/${pathEscapeSegments(filePath)}`;
    return new Response(null, { status: 302, headers: { location } });
  }

  if (!isArtifactPreviewSizeAllowed(artifactsTotalSize(artifacts))) {
    return textError(413, "artifact is too large to preview, please download it instead");
  }

  // The v4 zip arm (view_artifact.go:439-461): a readable archive serves its
  // matching entry; an UNREADABLE one falls through to the legacy match
  // (the zip.ErrFormat arm).
  if (artifacts.length === 1 && isArtifactV4(artifacts[0]!)) {
    const v4 = artifacts[0]!;
    const obj = await env.REPO_PACKS.get(v4.storagePath);
    if (obj === null) throw new Error(`storage open "${v4.storagePath}": object missing`);
    const zip = parseZip(new Uint8Array(await obj.arrayBuffer()));
    if (!zip.invalid) {
      const entry = filePath === "" ? undefined : zip.entries.find((e) => zipEntryFilePath(e.name) === filePath);
      if (entry === undefined) return textError(404, "Not Found");
      const bytes = await zipEntryBytes(zip, entry);
      if (bytes === null) throw new Error(`actions: zip entry "${entry.name}" unreadable`);
      return serveArtifactPreviewContent(filePath, bytes, entry.uncompressedSize, {
        helperScriptSrc: request.helperScriptSrc,
      });
    }
  }

  // The legacy arm (view_artifact.go:463-482): one row per file, possibly
  // gzipped on store.
  const artifact = artifacts.find((row) => artifactPreviewFallbackPath(row) === filePath);
  if (artifact === undefined) return textError(404, "Not Found");
  const obj = await env.REPO_PACKS.get(artifact.storagePath);
  if (obj === null) throw new Error(`storage open "${artifact.storagePath}": object missing`);
  let bytes: Uint8Array;
  if (artifact.contentEncodingOrType === CONTENT_ENCODING_V3_GZIP) {
    bytes = new Uint8Array(await new Response(obj.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  } else {
    bytes = new Uint8Array(await obj.arrayBuffer());
  }
  return serveArtifactPreviewContent(filePath, bytes, artifact.fileSize, {
    helperScriptSrc: request.helperScriptSrc,
  });
}

// ---------------------------------------------------------------------------
// The page render (artifact_preview.tmpl)
// ---------------------------------------------------------------------------

/**
 * The SSR file browser (artifact_preview.tmpl): the back link, the download
 * button, the file tree, the three warning banners, and the sandboxed
 * external-render iframe (`data-global-init="initExternalRenderIframe"` —
 * the official bundle's only hook on this page).
 */
export function renderArtifactPreviewPage(ctx: UiContext, data: ArtifactPreviewData): string {
  const locale = artifactPreviewLocale;
  const backText =
    data.runAttempt > 0
      ? formatPreviewCount(locale.backToRunAttempt, data.runIndex, data.runAttempt)
      : formatPreviewCount(locale.backToRun, data.runIndex);
  return renderPage(
    <BaseLayout ctx={ctx} title={locale.preview} pageClass="repository actions">
      <div class="ui fluid container">
        <div class="action-view-header">
          {/* upstream's {{svg "octicon-arrow-left" 14}} — the generated icon
              set carries no arrow glyph (the divergence note). */}
          <a class="action-view-back" href={data.runUrl}>
            {backText}
          </a>
          <div class="action-info-summary">
            <h2 class="action-info-summary-title-text">
              {locale.preview}: {data.artifactName}
            </h2>
            <a class="ui small compact button" href={data.downloadUrl}>
              <Icon name="octicon-download" />
              {repoActionsViewLocale.downloadFile}
            </a>
          </div>
        </div>
        <div class="flex-container">
          <div class="flex-container-nav">
            <div class="ui fluid vertical menu">
              <div class="header item">{locale.files}</div>
              {data.previewFiles.length === 0 ? (
                <div class="item">{locale.previewNoFiles}</div>
              ) : (
                data.previewFiles.map((file) =>
                  file.link !== "" ? (
                    <a
                      class={`item flex-text-block artifact-preview-item${file.selected ? " active" : ""}`}
                      style={`--depth: ${file.depth}`}
                      href={file.link}
                      title={file.path}
                    >
                      <Icon name="octicon-file" />
                      <span class="gt-ellipsis">{file.name}</span>
                    </a>
                  ) : (
                    <div class="item flex-text-block artifact-preview-item" style={`--depth: ${file.depth}`} title={file.path}>
                      {/* octicon-file-directory-fill — the bundled twin of
                          upstream's octicon-file-directory (absent set). */}
                      <Icon name="octicon-file-directory-fill" />
                      <span class="gt-ellipsis">{file.name}</span>
                    </div>
                  ),
                )
              )}
            </div>
          </div>
          <div class="flex-container-main">
            {data.previewTooLarge ? <div class="ui warning message">{locale.previewTooLarge}</div> : null}
            {data.requestedPathMissing ? <div class="ui warning message">{locale.previewFileNotFound}</div> : null}
            {data.previewFilesTruncated ? <div class="ui info message">{locale.previewFilesTruncated}</div> : null}
            {data.previewContentUrl !== "" ? (
              <div class="ui fitted segment">
                <iframe
                  class="external-render-iframe"
                  data-src={data.previewContentUrl}
                  data-global-init="initExternalRenderIframe"
                  referrerpolicy="no-referrer"
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </BaseLayout>,
  );
}

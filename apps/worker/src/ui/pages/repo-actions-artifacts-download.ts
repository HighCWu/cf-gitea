/**
 * The census C4 remainder: the runs-artifact DOWNLOAD + DELETE family —
 * upstream web.go:1595-1596 at pin fc4936884584a41931906553d96c2601d750e6ef
 * (inside the /actions group, so the group ladder optSignIn + RepoAssignment
 * + MustBeNotEmpty + reqRepoActionsReader + MustEnableActions gates BOTH
 * arms; the DELETE adds the per-route reqRepoActionsWriter):
 *
 *   GET    /{owner}/{repo}/actions/runs/{run}/artifacts/{artifact_name}
 *          actions.ArtifactsDownloadView (routers/web/repo/actions/view.go:1201-1279)
 *   DELETE /{owner}/{repo}/actions/runs/{run}/artifacts/{artifact_name}
 *          actions.ArtifactsDeleteView (view.go:1183-1199), reqRepoActionsWriter
 *
 * Both resolve the run through getCurrentRunByPathParam (view.go:61-73 — the
 * POST-family lookup: "latest" or ROW ID, no index disambiguation/redirect —
 * repo-actions-view.tsx's resolveRunByPath) and scope the artifact rows
 * through resolveArtifactAttemptIDFromQuery (view.go:1180-1195): the
 * `attempt` query parameter selects the attempt row (junk/negative/missing
 * numbers and unknown attempt numbers are ServerErrors, NOT 404s), and an
 * ABSENT parameter falls back to run.LatestAttemptID.
 *
 * ## GET — the download (view.go:1201-1279)
 *
 * GetArtifactsByRunAttemptAndName(run.ID, resolvedAttemptID, name) orders by
 * id; an empty family or ANY row whose status is not UploadConfirmed answers
 * the 404 page ("artifact not found" — ctx.HTTPError, the NotFound shell).
 * A single row where IsArtifactV4 (ContentEncodingOrType contains "/", the
 * v4 single-zip marker) serves the stored object verbatim through
 * DownloadArtifactV4 (services/actions/artifacts.go:60-65 minus the
 * ServeDirect leg — see the divergences): httplib.ServeUserContentByFile
 * with Filename=artifactPath + ContentType=contentEncodingOrType, i.e. the
 * ServeSetHeaders chain (inline disposition over path.Base, nosniff, the
 * sandbox CSP, prod cache-control, Last-Modified) plus ServeUserContent
 * ByReader's minimal single-range support over the storage object's size.
 * Every other shape composes a zip on the fly: Content-Disposition
 * attachment "name.zip", a Go archive/zip-shaped stream (flag 0x8 data
 * descriptors, Deflate entries) whose entry names are the rows'
 * artifactPath and whose contents are the stored files, gunzipping rows
 * stored with ContentEncodingV3Gzip first (view.go:1249-1277).
 *
 * ## DELETE — the pending-delete mark (view.go:1183-1199)
 *
 * SetArtifactNeedDeleteByRunAttempt (models/actions/artifact.go:270-274)
 * flips ONLY the UploadConfirmed rows of (run, attempt, name) to
 * ArtifactStatusPendingDeletion (5) — mark, never a hard delete: the
 * retention sweep (services/actions/retention.ts's
 * listPendingDeleteArtifacts consumers) owns the storage deletion exactly
 * like upstream's cleanup goroutine. The success body is ctx.JSON's `{}` —
 * NOT Cancel's JSONOK shape (view.go:1198 vs view.go:944's cancel twin).
 *
 * ## Streaming posture (the AGENTS.md Workers rule)
 *
 * The GET never buffers an artifact: the v4 arm streams the R2 object body
 * straight into the Response (a range request narrows the R2 GET itself),
 * and the zip arm composes entry-by-entry through a pull-driven
 * ReadableStream — R2 body → (gunzip) → crc32+size tap → deflate-raw — so
 * memory holds one chunk regardless of artifact size. No arrayBuffer/text
 * on any artifact body in this module.
 *
 * ## Documented divergences (each cites its upstream arm)
 *
 * - DownloadArtifactV4ServeDirect (artifacts.go:34-45) is not attempted:
 *   this store has no public bucket URL composer; upstream serves the same
 *   ReadStorage arm whenever ServeDirect is unconfigured. A future
 *   custom-domain R2 binding swaps in here without touching callers.
 * - ServeUserContentByFile's sniff/charset arms
 *   (serveSetHeadersByUserContent) are dead code on this route — the v4
 *   caller always passes ContentType — so only the MimeTypeMap-off shape is
 *   modeled; gzhttp's no-compression proxy hint header is not emitted.
 * - httpcache: the prod shape ("max-age=0, private, must-revalidate") is
 *   set verbatim; the RUN_MODE=dev variant + X-Gitea-Debug header is not
 *   modeled (this Worker is always the prod form). The legacy zip arm —
 *   upstream sets NO cache-control — inherits the uiRouter's own identical
 *   house middleware value (ui/index.ts), an equivalent observable.
 * - The zip-compose arm sets `content-type: application/zip` explicitly
 *   where Go's transparent response sniffer would name the same type
 *   (PK\x03\x04 → application/zip); upstream's code sets nothing itself.
 * - The zip writer is pre-zip64: u32 sizes/offsets, u16 entry counts — a
 *   single entry > 4 GiB, an archive past 4 GiB of output, or > 65535
 *   entries would overflow the fields (the preview module's zip64 posture
 *   note applies; v1 artifacts store one row per file). Go's writer would
 *   emit zip64 there.
 * - Zip data descriptors are the 12-byte signature-less form Go's
 *   archive/zip writer emits for its non-seekable response streams; readers
 *   take sizes/crc from the central directory.
 * - ServeUserContentByReader's multiple-range and If-Range arms are beyond
 *   upstream's own minimal single-range port (it serves the FIRST range
 *   shape only); the 416/400 error-text bodies mirror http.Error's plain
 *   text form.
 * - `runId` is the store's TEXT repositories.id string, not upstream's
 *   int64 (the M1a sentinel adaptation, as repo-actions-view.tsx notes);
 *   artifact numeric columns stay numbers.
 */

import {
  ARTIFACT_STATUS_UPLOAD_CONFIRMED,
  CONTENT_ENCODING_V3_GZIP,
  findReadableArtifacts,
  setArtifactNeedDeleteByRunAttempt,
  type ArtifactRow,
} from "../../services/actions/artifacts";
import type { RunRow } from "../../services/actions/model";
import {
  encodeContentDispositionAttachment,
  encodeContentDispositionInline,
  isArtifactV4,
} from "./repo-actions-artifacts";
import { getRunAttemptByRunIdAndAttemptNum, parsePathParamInt64 } from "./repo-actions-view";

type D1 = D1Database;

// ---------------------------------------------------------------------------
// The attempt-query resolution (resolveArtifactAttemptIDFromQuery,
// view.go:1180-1195) — shared by both arms
// ---------------------------------------------------------------------------

export type ResolvedArtifactAttempt =
  | { outcome: "ok"; runAttemptId: number }
  /** The `attempt` value junk/negative (FormInt64's 0), or the attempt row
   *  missing — upstream's ServerError arms (a 500, not a 404). */
  | { outcome: "error" };

/**
 * The `attempt` query parameter's resolution: absent → run.latestAttemptID
 * (0 for legacy runs); present-but-unparseable/<=0 → ServerError; a number
 * without an attempt row → ServerError (GetRunAttemptByRunIDAndAttemptNum's
 * ErrNotExist, view.go:1191).
 */
export async function resolveArtifactAttemptIdFromQuery(d1: D1, run: RunRow, attemptQuery: string): Promise<ResolvedArtifactAttempt> {
  if (attemptQuery === "") {
    return { outcome: "ok", runAttemptId: run.latestAttemptId };
  }
  const attemptNum = parsePathParamInt64(attemptQuery);
  if (attemptNum <= 0) return { outcome: "error" };
  const attempt = await getRunAttemptByRunIdAndAttemptNum(d1, run.id, attemptNum);
  if (attempt === null) return { outcome: "error" };
  return { outcome: "ok", runAttemptId: attempt.id };
}

// ---------------------------------------------------------------------------
// The family read (GetArtifactsByRunAttemptAndName + the confirmed gate,
// view.go:1209-1222)
// ---------------------------------------------------------------------------

/**
 * The run-scoped family (rows ordered by id), null when the family is empty
 * or ANY row is not UploadConfirmed — upstream's ctx.HTTPError(404,
 * "artifact not found") arm, the NotFound shell at the wiring.
 */
async function loadRunArtifactFamily(d1: D1, run: RunRow, runAttemptId: number, artifactName: string): Promise<ArtifactRow[] | null> {
  const family = await findReadableArtifacts(d1, {
    runId: run.id,
    runAttemptIds: [runAttemptId],
    artifactName,
  });
  if (family.length === 0 || family.some((row) => row.status !== ARTIFACT_STATUS_UPLOAD_CONFIRMED)) {
    return null;
  }
  return family;
}

// ---------------------------------------------------------------------------
// The v4 arm (DownloadArtifactV4ReadStorage over ServeUserContentByFile/
// ByReader, artifacts.go:47-58 + serve.go:77-110/155-230)
// ---------------------------------------------------------------------------

/** Go path.Base (the POSIX algorithm) — ServeSetHeaders' disposition base. */
export function goPathBase(p: string): string {
  if (p === "") return ".";
  let end = p.length;
  while (end > 0 && p[end - 1] === "/") end--;
  if (end === 0) return "/";
  const start = p.lastIndexOf("/", end - 1) + 1;
  return p.slice(start, end);
}

/** serveHeaderCspDefault / serveHeaderCspPdf (serve.go:44-56): JS is
 *  disabled on the same origin via the sandbox; PDF needs no sandbox; media
 *  deletes the header. */
const CSP_SANDBOX = "sandbox allow-scripts allow-modals allow-popups allow-downloads";
const CSP_PDF = "default-src 'none'; style-src 'unsafe-inline'";

/** httpcache's prod default shape (httpcache.go:23-41, MaxAge 0). */
const CACHE_CONTROL_NO_CACHE = "max-age=0, private, must-revalidate";

function serveContentHeaders(contentType: string, disposition: string, lastModified: Date | null): Headers {
  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("x-content-type-options", "nosniff");
  if (contentType.startsWith("application/pdf")) headers.set("content-security-policy", CSP_PDF);
  else if (!contentType.startsWith("video/") && !contentType.startsWith("audio/")) headers.set("content-security-policy", CSP_SANDBOX);
  headers.set("content-disposition", disposition);
  headers.set("access-control-expose-headers", "Content-Disposition");
  headers.set("cache-control", CACHE_CONTROL_NO_CACHE);
  if (lastModified !== null) headers.set("last-modified", lastModified.toUTCString());
  return headers;
}

/** A minimal single-range port of ServeUserContentByReader's tail
 *  (serve.go:174-227): "bytes=start-end" / "bytes=start-" only — upstream
 *  serves the FIRST range shape, never multiple ranges. */
type RangeServe =
  /** The 200 complete response: the caller streams the full object body
   *  (content-length set by the parse). */
  | { kind: "full" }
  | { kind: "partial"; body: ReadableStream<Uint8Array> }
  /** http.Error's plain-text arms; upstream's header map still carries the
   *  serve headers when the error writes (they were set before the parse),
   *  so the error Response keeps them too. */
  | { kind: "error"; status: 416 | 400; message: string };

async function parseRangeServe(
  bucket: R2Bucket,
  storagePath: string,
  size: number,
  rangeHeader: string | null,
  headers: Headers,
): Promise<RangeServe> {
  if (size <= 0 || rangeHeader === null || !rangeHeader.startsWith("bytes=")) {
    headers.set("content-length", String(size));
    return { kind: "full" };
  }
  const rangeParts = rangeHeader.slice("bytes=".length);
  const [startRaw, endRaw] = rangeParts.split("-", 2);
  // Go's strconv.ParseInt(base 10) — a strict decimal, so JS's parseInt
  // looseness (leading whitespace, sign quirks beyond +/-) 416s like Go's
  // parse error arm.
  const parseStrict = (raw: string): number => (/^[+-]?[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN);
  const start = parseStrict(startRaw ?? "");
  if (!Number.isFinite(start) || start < 0 || start >= size) {
    return { kind: "error", status: 416, message: "invalid start range" };
  }
  let end: number;
  if (endRaw === undefined) {
    return { kind: "error", status: 400, message: "invalid end range" };
  }
  if (endRaw === "") {
    end = size - 1; // "bytes=start-"
  } else {
    end = parseStrict(endRaw);
    if (!Number.isFinite(end)) return { kind: "error", status: 400, message: "invalid end range" };
    if (end >= size) end = size - 1;
  }
  if (end < start) return { kind: "error", status: 400, message: "invalid end range" };
  const length = end - start + 1;
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  headers.set("content-length", String(length));
  const ranged = await bucket.get(storagePath, { range: { offset: start, length } });
  if (ranged === null) throw new Error(`storage open "${storagePath}": object missing`);
  return { kind: "partial", body: ranged.body as ReadableStream<Uint8Array> };
}

/**
 * The v4 download: the stored single-zip object served verbatim with the
 * ServeUserContentByFile header chain (inline disposition over the
 * artifactPath's base, the stored content type) and the minimal range
 * support. Throws on a missing object (the route's 500 chrome — upstream's
 * storage Open error → ServerError).
 */
export async function serveArtifactV4Download(env: Env, artifact: ArtifactRow, rangeHeader: string | null): Promise<Response> {
  const obj = await env.REPO_PACKS.get(artifact.storagePath);
  if (obj === null) throw new Error(`storage open "${artifact.storagePath}": object missing`);
  const headers = serveContentHeaders(artifact.contentEncodingOrType, encodeContentDispositionInline(goPathBase(artifact.artifactPath)), obj.uploaded);
  const served = await parseRangeServe(env.REPO_PACKS, artifact.storagePath, obj.size, rangeHeader, headers);
  if (served.kind === "error") {
    // http.Error(w, err.Error(), status): the plain-text body over the
    // already-set serve headers.
    return new Response(`${served.message}\n`, { status: served.status, headers });
  }
  const body = served.kind === "full" ? obj.body : served.body;
  return new Response(body, { status: served.kind === "full" ? 200 : 206, headers });
}

// ---------------------------------------------------------------------------
// The legacy zip-compose arm (view.go:1245-1277) — the streaming zip writer
// ---------------------------------------------------------------------------

/** CRC-32 (IEEE 802.3, reflected 0xedb88320) — the zip entry checksum. */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Feeds one chunk into the running register (init 0xffffffff, finalize
 *  with the XOR-invert). */
function crc32Feed(state: number, chunk: Uint8Array): number {
  let c = state;
  for (let i = 0; i < chunk.length; i++) c = CRC32_TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8);
  return c >>> 0;
}

/** MS-DOS date/time pair (the zip's local timestamp fields; the DOS epoch
 *  starts 1980). */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(at.getFullYear(), 1980);
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

interface ZipCentralEntry {
  name: Uint8Array;
  flags: number;
  dosTime: number;
  dosDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

/** Local file header: bit 0x8 (data descriptor — Go's archive/zip writer
 *  sets it for every entry) + the EFS bit 0x800 for non-ASCII names; crc and
 *  sizes stay zero, the descriptor carries them. */
function zipLocalHeader(entry: { name: Uint8Array; flags: number; dosTime: number; dosDate: number }): Uint8Array {
  const header = new Uint8Array(30 + entry.name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true); // version needed
  view.setUint16(6, entry.flags, true);
  view.setUint16(8, 8, true); // Deflate — zipWriter.Create's default method
  view.setUint16(10, entry.dosTime, true);
  view.setUint16(12, entry.dosDate, true);
  view.setUint16(26, entry.name.length, true);
  header.set(entry.name, 30);
  return header;
}

function zipCentralRecord(entry: ZipCentralEntry): Uint8Array {
  const record = new Uint8Array(46 + entry.name.length);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true); // version made by
  view.setUint16(6, 20, true); // version needed
  view.setUint16(8, entry.flags, true);
  view.setUint16(10, 8, true);
  view.setUint16(12, entry.dosTime, true);
  view.setUint16(14, entry.dosDate, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, entry.compressedSize, true);
  view.setUint32(24, entry.uncompressedSize, true);
  view.setUint16(28, entry.name.length, true);
  view.setUint32(42, entry.offset, true);
  record.set(entry.name, 46);
  return record;
}

function zipEocd(count: number, cdSize: number, cdOffset: number): Uint8Array {
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, Math.min(count, 0xffff), true);
  view.setUint16(10, Math.min(count, 0xffff), true);
  view.setUint32(12, cdSize, true);
  view.setUint32(16, cdOffset, true);
  return eocd;
}

/** The 12-byte signature-less data descriptor (Go's writeDataDescriptor
 *  shape). */
function zipDataDescriptor(crc32: number, compressedSize: number, uncompressedSize: number): Uint8Array {
  const descriptor = new Uint8Array(12);
  const view = new DataView(descriptor.buffer);
  view.setUint32(0, crc32, true);
  view.setUint32(4, compressedSize, true);
  view.setUint32(8, uncompressedSize, true);
  return descriptor;
}

/** Compresses one stored file into deflate-raw chunks while tapping crc32 +
 *  the uncompressed size off the source stream — one buffered chunk at a
 *  time, no whole-file read. */
async function* deflateTap(source: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array, { crc32: number; uncompressedSize: number }> {
  const deflater = new CompressionStream("deflate-raw");
  const writer = deflater.writable.getWriter();
  const compressed = deflater.readable.getReader();
  const srcReader = source.getReader();
  let crcState = 0xffffffff;
  let uncompressedSize = 0;
  const pump = (async () => {
    for (;;) {
      const { done, value } = await srcReader.read();
      if (done) break;
      crcState = crc32Feed(crcState, value);
      uncompressedSize += value.byteLength;
      await writer.write(value);
    }
    await writer.close();
  })();
  for (;;) {
    const { done, value } = await compressed.read();
    if (done) break;
    yield value;
  }
  await pump;
  return { crc32: (crcState ^ 0xffffffff) >>> 0, uncompressedSize };
}

/** Pull-driven ReadableStream over an async generator (one-chunk lookahead:
 *  the default queuing strategy's highWaterMark). A generator throw errors
 *  the stream mid-response — upstream's own mid-stream failure shape, where
 *  the ServerError attempt after a partial write cannot change the status. */
function readableFromGenerator(gen: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return gen.next().then(({ done, value }) => {
        if (done || value === undefined) controller.close();
        else controller.enqueue(value);
      });
    },
    cancel() {
      return gen.return(undefined).then(() => undefined);
    },
  });
}

/**
 * The legacy zip stream: one Deflate entry per artifact row (id order), the
 * entry name = the row's artifactPath, the content = the stored file
 * gunzipped when the row carries ContentEncodingV3Gzip (view.go:1249-1277).
 * Yields local headers, compressed chunks and descriptors per entry, then
 * the central directory + EOCD.
 */
async function* composeArtifactZipStream(env: Env, artifacts: ArtifactRow[]): AsyncGenerator<Uint8Array> {
  const central: ZipCentralEntry[] = [];
  let offset = 0;
  // Go's zipWriter.Create stamps Modified with the DOWNLOAD moment.
  const { time: dosTime, date: dosDate } = dosDateTime(new Date());
  for (const artifact of artifacts) {
    const name = new TextEncoder().encode(artifact.artifactPath);
    // Go flags non-ASCII entry names with the EFS bit (they decode as UTF-8).
    const flags = 0x8 | (/[\u0080-\uFFFF]/.test(artifact.artifactPath) ? 0x800 : 0);
    const entryHead = { name, flags, dosTime, dosDate };
    const localHeader = zipLocalHeader(entryHead);
    yield localHeader;

    const obj = await env.REPO_PACKS.get(artifact.storagePath);
    if (obj === null) throw new Error(`storage open "${artifact.storagePath}": object missing`);
    let source: ReadableStream<Uint8Array> = obj.body as ReadableStream<Uint8Array>;
    if (artifact.contentEncodingOrType === CONTENT_ENCODING_V3_GZIP) {
      source = source.pipeThrough<Uint8Array>(new DecompressionStream("gzip"));
    }
    const deflated = deflateTap(source);
    let compressedSize = 0;
    let tap: { crc32: number; uncompressedSize: number } | undefined;
    for (;;) {
      const { done, value } = await deflated.next();
      if (done) {
        // The terminating next() carries the tap's totals (the generator's
        // return value).
        tap = value;
        break;
      }
      compressedSize += value.byteLength;
      yield value;
    }
    if (tap === undefined) throw new Error("actions: zip deflate tap lost its totals");
    yield zipDataDescriptor(tap.crc32, compressedSize, tap.uncompressedSize);
    central.push({ ...entryHead, crc32: tap.crc32, compressedSize, uncompressedSize: tap.uncompressedSize, offset });
    offset += localHeader.length + compressedSize + 12;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const entry of central) {
    const record = zipCentralRecord(entry);
    cdSize += record.length;
    yield record;
  }
  yield zipEocd(central.length, cdSize, cdStart);
}

// ---------------------------------------------------------------------------
// The GET arm (ArtifactsDownloadView, view.go:1201-1279)
// ---------------------------------------------------------------------------

export type DownloadRunArtifactOutcome =
  /** The family's 404s: an empty family or any unconfirmed row (upstream's
   *  "artifact not found" HTTPError — the NotFound shell at the wiring). */
  | { outcome: "not-found" }
  /** resolveArtifactAttemptIDFromQuery's ServerError arms — the 500 shell. */
  | { outcome: "error" }
  | { outcome: "ok"; response: Response };

/**
 * The download Response for a resolved run. The v4 single-zip artifact
 * serves verbatim; every other family composes a streaming zip. The body is
 * ALWAYS a live stream — the wiring must not buffer it.
 */
export async function buildRunArtifactDownload(
  env: Env,
  run: RunRow,
  artifactName: string,
  attemptQuery: string,
  rangeHeader: string | null,
): Promise<DownloadRunArtifactOutcome> {
  const attempt = await resolveArtifactAttemptIdFromQuery(env.DB, run, attemptQuery);
  if (attempt.outcome === "error") return { outcome: "error" };
  const family = await loadRunArtifactFamily(env.DB, run, attempt.runAttemptId, artifactName);
  if (family === null) return { outcome: "not-found" };

  // The v4 arm (view.go:1224-1231): one row carrying a content type.
  if (family.length === 1 && isArtifactV4(family[0]!)) {
    return { outcome: "ok", response: await serveArtifactV4Download(env, family[0]!, rangeHeader) };
  }

  // The legacy arm (view.go:1234-1278): the on-the-fly zip.
  const headers = new Headers({
    "content-disposition": encodeContentDispositionAttachment(`${artifactName}.zip`),
    "content-type": "application/zip", // Go's sniffer names the same type
  });
  const stream = readableFromGenerator(composeArtifactZipStream(env, family));
  return { outcome: "ok", response: new Response(stream, { status: 200, headers }) };
}

// ---------------------------------------------------------------------------
// The DELETE arm (ArtifactsDeleteView, view.go:1183-1199)
// ---------------------------------------------------------------------------

export type DeleteRunArtifactOutcome =
  /** resolveArtifactAttemptIDFromQuery's ServerError arms — the 500 shell. */
  | { outcome: "error" }
  | { outcome: "ok"; response: Response };

/**
 * The pending-delete mark: the confirmed (run, attempt, name) rows flip to
 * ArtifactStatusPendingDeletion; the retention sweep deletes later (mark,
 * never a hard delete). The success body is ctx.JSON's `{}` — Cancel's
 * JSONOK shape is a DIFFERENT arm's body.
 */
export async function deleteRunArtifact(d1: D1, run: RunRow, artifactName: string, attemptQuery: string): Promise<DeleteRunArtifactOutcome> {
  const attempt = await resolveArtifactAttemptIdFromQuery(d1, run, attemptQuery);
  if (attempt.outcome === "error") return { outcome: "error" };
  await setArtifactNeedDeleteByRunAttempt(d1, run.id, attempt.runAttemptId, artifactName);
  return {
    outcome: "ok",
    response: new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json;charset=utf-8" },
    }),
  };
}

// ---------------------------------------------------------------------------
// HANDOFF — route wiring (ui/index.ts is orchestrator-owned; the dead-link
// rule keeps these arms OFF this module's callers until the mount lands)
//
// 1. Route interface (beside RepoActionsRunViewRoute, ui/index.ts ~2834) and
//    the union: add `RepoActionsRunArtifactRoute` to ParsedUiRoute (~3197).
//
//      /** The census C4 remainder: the runs-artifact download + delete
//       *  family (pages/repo-actions-artifacts-download.ts — upstream
//       *  web.go:1595-1596). One family for BOTH methods: the GET is the
//       *  zip-compose/v4 stream, the DELETE is the writer-gated
//       *  pending-deletion mark. The {run} segment claims ANY value
//       *  (chi params — resolveRunByPath's loader arms); {artifact_name} is
//       *  ONE decoded segment (url.PathEscape composes it upstream). */
//      export interface RepoActionsRunArtifactRoute {
//        family: "actions-run-artifact";
//        owner: string;
//        repo: string;
//        run: string;
//        artifactName: string;
//      }
//
// 2. parseUiRoute claim — inside the `head === "actions" && rest.length >= 3
//    && rest[0] === "runs"` block (~4228), BEFORE its `return null` (and
//    before/after the cancel shape — disjoint literals, order-free):
//
//      if (rest.length === 4 && rest[2] === "artifacts") {
//        let artifactName: string;
//        try {
//          artifactName = decodeURIComponent(rest[3] as string);
//        } catch {
//          return null; // malformed escape — upstream chi 404s it too
//        }
//        return { family: "actions-run-artifact", owner, repo, run: rest[1] as string, artifactName };
//      }
//
//    INTEGRATION RIPPLE: repo-actions-view.test.tsx (~line 246) pins
//    `/alice/demo/actions/runs/7/artifacts/some-name` as UNCLAIMED — flip
//    that expectation to the family shape above in the same landing.
//
// 3. Registrations (beside the C2 block, ui/index.ts ~13962):
//
//      uiRouter.get("/:owner/:repo/actions/runs/:run/artifacts/:name", (c) => actionsRunArtifactDownload(c));
//      uiRouter.delete("/:owner/:repo/actions/runs/:run/artifacts/:name", (c) => actionsRunArtifactDelete(c));
//
// 4. Handlers (beside actionsRunCancel ~6361) — the gate ladders:
//
//    - GET = the C2 READ ladder verbatim (actionsRunViewGate: MustBeNotEmpty
//      + MustEnableActions; anonymous readers PASS — upstream's
//      reqRepoActionsReader group middleware). The run resolves through
//      resolveRunByPath (getCurrentRunByPathParam — "latest"/row-id, NO
//      index redirect: view.go:61-73). outcome "not-found" → the 404 shell;
//      "error" → renderServerErrorShellResponse; "ok" → respond(response)
//      UNCHANGED — the body is a live stream, never buffer it.
//
//      async function actionsRunArtifactDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
//        const resolved = await resolveUiRequest(c);
//        if (!resolved.ok) return resolved.response;
//        const { ctx, repo, respond } = resolved;
//        if (resolved.route.family !== "actions-run-artifact") return respond(await c.notFound()); // drift guard
//        const gate = await actionsRunViewGate(c, resolved);
//        if (gate !== null) return gate;
//        const run = await resolveRunByPath(c.env.DB, repo.id, resolved.route.run);
//        if (run === null) return respond(c.html(renderNotFound(ctx), 404)); // getCurrentRunByPathParam's NotFound
//        const outcome = await buildRunArtifactDownload(
//          c.env,
//          run,
//          resolved.route.artifactName,
//          resolved.url.searchParams.get("attempt") ?? "",
//          c.req.header("range"),
//        );
//        if (outcome.outcome === "not-found") return respond(c.html(renderNotFound(ctx), 404));
//        if (outcome.outcome === "error") return renderServerErrorShellResponse(c.env, c.req.raw);
//        return respond(outcome.response);
//      }
//
//    - DELETE = the cancel-POST-style writer arm: sameOriginGuard FIRST,
//      then the C2 read ladder, then RequireUnitWriter's NotFound (the
//      404 shell, never the login 303 — upstream's reqRepoActionsWriter on
//      web.go:1596). Same run resolution; "error" → the 500 shell.
//
//      async function actionsRunArtifactDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
//        const guard = sameOriginGuard(c.req.raw);
//        if (guard !== null) return guard;
//        const resolved = await resolveUiRequest(c);
//        if (!resolved.ok) return resolved.response;
//        const { ctx, viewer, repo, respond } = resolved;
//        if (resolved.route.family !== "actions-run-artifact") return respond(await c.notFound()); // drift guard
//        const gate = await actionsRunViewGate(c, resolved);
//        if (gate !== null) return gate;
//        if (viewer.kind !== "user" || !(await canWriteRepo(c.env, repo, viewer))) {
//          return respond(c.html(renderNotFound(ctx), 404)); // RequireUnitWriter's NotFound
//        }
//        const run = await resolveRunByPath(c.env.DB, repo.id, resolved.route.run);
//        if (run === null) return respond(c.html(renderNotFound(ctx), 404));
//        const outcome = await deleteRunArtifact(
//          c.env.DB,
//          run,
//          resolved.route.artifactName,
//          resolved.url.searchParams.get("attempt") ?? "",
//        );
//        if (outcome.outcome === "error") return renderServerErrorShellResponse(c.env, c.req.raw);
//        return respond(outcome.response);
//      }
//
// 5. Imports into ui/index.ts: buildRunArtifactDownload, deleteRunArtifact
//    from "./pages/repo-actions-artifacts-download" (resolveRunByPath is
//    already in the repo-actions-view import block).
// ---------------------------------------------------------------------------

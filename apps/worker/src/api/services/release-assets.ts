import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { releaseAssets } from "../../db/schema";
import type { Attachment } from "../models/release";

/**
 * Release assets — the D1+R2 half of the release family (SPEC-0004 §2.4 rows
 * repoListReleaseAttachments / repoCreateReleaseAttachment; upstream
 * routers/api/v1/repo/release_attachment.go ListReleaseAttachments /
 * CreateReleaseAttachment over the landed `release_assets` table).
 *
 * Storage (SPEC-0005 §3.3): R2 keys are
 * `repos/<storage_key>/release-assets/<release_id>/<uuid>-<name>` under the
 * shared REPO_PACKS bucket — the repo-prefix purge (SPEC-0005 §4.13) covers
 * them, and the uuid prefix keeps same-name uploads collision-free. D1 keeps
 * the row (name/size/uuid/r2_key) and — cheap, because the single streaming
 * pass already digests the bytes — the sha256 checksum.
 *
 * Upload shape (the LFS relay-store discipline, src/services/lfs/store.ts):
 *   - `Content-Length` is REQUIRED (411 when absent): the R2 binding needs a
 *     known-length body, and git/curl uploads always declare it — the same
 *     rule the LFS relay handlers enforce.
 *   - **413 threshold: 512 MiB** — SPEC-0005 §3.3's documented default ("ours
 *     fixed at 512 MiB until a settings SPEC"; upstream's attachment setting
 *     default is 2048 MiB). Checked BEFORE streaming when Content-Length is
 *     known and enforced per-chunk while streaming.
 *   - `application/octet-stream` (any non-multipart content type) streams
 *     single-pass hash-and-forward into one R2 object — zero copy, the LFS
 *     putStream pattern.
 *   - `multipart/form-data` cannot know the file part's length upfront (only
 *     the whole body length is declared), so the extracted part streams into
 *     an R2 multipart upload in bounded 8 MiB parts (≈ 64 subrequests at the
 *     512 MiB cap, far under the budget) — still one pass, never buffering
 *     more than one part (the AGENTS no-arrayBuffer rule).
 *
 * Deviations from upstream (documented): the >16 MiB presigned-PUT branch of
 * SPEC-0005 §3.3 is deferred (the R2 binding cannot presign and no S3
 * credentials exist — the relay path is day-one; the presign flow needs its
 * own wave), so every upload rides the streaming relay; a multipart body
 * without an `attachment` file part answers 400 (upstream's FormFile error
 * surfaces as an empty-body 500, kept here for genuinely unexpected
 * failures); the `attachment is not enabled` unit gate does not exist here
 * (our release settings carry has_releases only, enforced by the routes).
 */

/** Inferred row of the `release_assets` table (SPEC-0005 §3.2/§3.3). */
export type ReleaseAssetRow = typeof releaseAssets.$inferSelect;

/** SPEC-0005 §3.3 — the 413 threshold (512 MiB). */
export const MAX_RELEASE_ASSET_BYTES = 512 * 1024 * 1024;

/** R2 multipart-upload part size for the multipart path (≥ 5 MiB S3 minimum). */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

/** Part-header budget before a multipart body is declared malformed. */
const MAX_PART_HEADER_BYTES = 16 * 1024;

/** Non-file form fields are tiny; anything larger is drained, not captured. */
const MAX_FORM_FIELD_BYTES = 64 * 1024;

const STORAGE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** Thrown when the streamed asset exceeds MAX_RELEASE_ASSET_BYTES (→ 413). */
export class AssetTooLargeError extends Error {
  constructor() {
    super("attachment is too large");
    this.name = "AssetTooLargeError";
  }
}

/** Thrown on a malformed multipart body (missing/mismatched boundaries → 400). */
export class MalformedMultipartError extends Error {
  constructor(reason: string) {
    super(`malformed multipart body: ${reason}`);
    this.name = "MalformedMultipartError";
  }
}

/** Thrown when the streamed bytes contradict the declared Content-Length (→ 400). */
export class AssetSizeMismatchError extends Error {
  constructor() {
    super("request body size does not match Content-Length");
    this.name = "AssetSizeMismatchError";
  }
}

/**
 * Build the R2 key for an asset (SPEC-0005 §3.3 layout). Every segment is
 * format-gated before concatenation (the LFS key discipline): the storage
 * key must match the engine's key shape, the release id must be a positive
 * integer, and the name segment is reduced to `[A-Za-z0-9._-]` (display
 * names stay verbatim in D1) so `/`, `..` and control bytes can never
 * escape the prefix.
 */
export function releaseAssetKey(storageKey: string, releaseId: number, uuid: string, name: string): string {
  if (!STORAGE_KEY_RE.test(storageKey)) {
    throw new Error(`invalid repo storage key: ${storageKey}`);
  }
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) {
    throw new Error(`invalid release id: ${releaseId}`);
  }
  return `repos/${storageKey}/release-assets/${releaseId}/${uuid}-${sanitizeAssetNameSegment(name)}`;
}

/** The R2 key's name segment: injection-proof, leading dots flattened. */
function sanitizeAssetNameSegment(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128);
  return cleaned.length > 0 ? cleaned : "asset";
}

/** List a release's assets in id order (upstream Find → primary-key order). */
export async function listReleaseAssets(d1: D1Database, releaseId: number): Promise<ReleaseAssetRow[]> {
  return drizzle(d1)
    .select()
    .from(releaseAssets)
    .where(eq(releaseAssets.releaseId, releaseId))
    .orderBy(asc(releaseAssets.id))
    .all();
}

/**
 * `convert.toAttachment` → the contract `Attachment`. `browser_download_url`
 * is upstream's Attachment.DownloadURL: AppSubURL (empty) + /attachments/ +
 * the path-escaped uuid, made absolute against the request origin.
 */
export function toApiAttachment(origin: string, row: ReleaseAssetRow): Attachment {
  return {
    id: row.id,
    name: row.name,
    created_at: row.createdAt === null || row.createdAt === undefined ? undefined : row.createdAt.toISOString(),
    download_count: row.downloadCount,
    size: row.size,
    uuid: row.uuid,
    browser_download_url: `${origin}/attachments/${encodeURIComponent(row.uuid)}`,
  };
}

// ---------------------------------------------------------------------------
// Streaming multipart parsing (RFC 7578 subset — form-data parts)
// ---------------------------------------------------------------------------

/** One parsed multipart part: its disposition fields + a content generator. */
export interface MultipartPart {
  name: string;
  filename: string | null;
  /** The part's content bytes, ending exactly before the closing delimiter. */
  content: AsyncGenerator<Uint8Array>;
}

/**
 * Pull-based byte window over a request stream: the multipart scanner needs
 * needle matching across chunk edges plus bounded retention, without ever
 * holding more than a few chunks in memory.
 */
class ByteWindow {
  private chunks: Uint8Array[] = [];
  private consumedInFirst = 0;
  private eof = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** Bytes currently buffered (not yet consumed). */
  get buffered(): number {
    let total = -this.consumedInFirst;
    for (const chunk of this.chunks) total += chunk.byteLength;
    return total;
  }

  /** Pull until at least n bytes are buffered; false when EOF caps below n. */
  async ensure(n: number): Promise<boolean> {
    while (!this.eof && this.buffered < n) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.eof = true;
        break;
      }
      if (value.byteLength > 0) this.chunks.push(value);
    }
    return this.buffered >= n;
  }

  /** Byte at a buffered offset (caller ensures availability). */
  peek(offset: number): number {
    let index = offset + this.consumedInFirst;
    for (const chunk of this.chunks) {
      if (index < chunk.byteLength) {
        const byte = chunk[index];
        if (byte !== undefined) return byte;
      }
      index -= chunk.byteLength;
    }
    throw new RangeError("peek past the buffered window");
  }

  /** Bounds-checked byte-sequence match at a buffered offset. */
  matchAt(offset: number, bytes: Uint8Array): boolean {
    if (offset < 0 || offset + bytes.byteLength > this.buffered) return false;
    for (let i = 0; i < bytes.byteLength; i++) {
      const expected = bytes[i];
      if (expected === undefined || this.peek(offset + i) !== expected) return false;
    }
    return true;
  }

  /** First index of needle at or after `from`, or -1 (searches buffered only). */
  indexOf(needle: Uint8Array, from: number): number {
    if (needle.byteLength === 0) return from;
    const last = this.buffered - needle.byteLength;
    const first = needle[0];
    if (first === undefined) return from;
    for (let start = from; start <= last; start++) {
      if (this.peek(start) !== first) continue;
      let matched = true;
      for (let i = 1; i < needle.byteLength; i++) {
        const expected = needle[i];
        if (expected === undefined || this.peek(start + i) !== expected) {
          matched = false;
          break;
        }
      }
      if (matched) return start;
    }
    return -1;
  }

  /** Consume n bytes and return them as one array (small reads only). */
  take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0];
      if (chunk === undefined) {
        throw new RangeError("take past the buffered window");
      }
      const available = chunk.byteLength - this.consumedInFirst;
      const count = Math.min(available, n - filled);
      out.set(chunk.subarray(this.consumedInFirst, this.consumedInFirst + count), filled);
      filled += count;
      this.consumedInFirst += count;
      if (this.consumedInFirst === chunk.byteLength) {
        this.chunks.shift();
        this.consumedInFirst = 0;
      }
    }
    return out;
  }

  /** Drop n buffered bytes (drain). */
  drop(n: number): void {
    let remaining = n;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      if (chunk === undefined) {
        return;
      }
      const available = chunk.byteLength - this.consumedInFirst;
      if (remaining < available) {
        this.consumedInFirst += remaining;
        return;
      }
      remaining -= available;
      this.chunks.shift();
      this.consumedInFirst = 0;
    }
  }

  /** Copy of [from, from+len) without consuming (contiguous → subarray view). */
  view(from: number, len: number): Uint8Array {
    const first = this.chunks[0];
    if (first === undefined || len === 0) return new Uint8Array(len);
    const start = from + this.consumedInFirst;
    if (start + len <= first.byteLength) {
      return first.subarray(start, start + len);
    }
    const out = new Uint8Array(len);
    let filled = 0;
    let chunkIndex = 0;
    let index = start;
    while (filled < len && chunkIndex < this.chunks.length) {
      const chunk = this.chunks[chunkIndex];
      if (chunk === undefined) break;
      if (index < chunk.byteLength) {
        const count = Math.min(chunk.byteLength - index, len - filled);
        out.set(chunk.subarray(index, index + count), filled);
        filled += count;
        index = 0;
      } else {
        index -= chunk.byteLength;
      }
      chunkIndex++;
    }
    return out;
  }
}

const encoder = new TextEncoder();
const CRLF = encoder.encode("\r\n");
const DASH_DASH = encoder.encode("--");

/**
 * Parse `Content-Disposition: form-data; name="x"; filename="y"` (RFC 7578):
 * quoted values with backslash escapes, bare tokens, and the RFC 5987
 * `filename*=` extended form (UTF-8 only, Go mime-parser parity).
 */
function parseContentDisposition(headerValue: string): { name: string; filename: string | null } {
  const semicolon = headerValue.indexOf(";");
  const disposition = (semicolon === -1 ? headerValue : headerValue.slice(0, semicolon)).trim().toLowerCase();
  if (disposition !== "form-data") {
    return { name: "", filename: null };
  }
  let name = "";
  let filename: string | null = null;
  const parameters = headerValue.slice(semicolon + 1);
  const pattern = /\s*([a-zA-Z*]+)(\*)?\s*=\s*("((?:[^"\\]|\\.)*)"|[^;\s]*)/g;
  for (const match of parameters.matchAll(pattern)) {
    const key = (match[1] ?? "").toLowerCase();
    const extended = match[2] === "*";
    let value = match[4] !== undefined ? match[4].replace(/\\(.)/g, "$1") : (match[3] ?? "");
    if (extended) {
      // RFC 5987: charset'lang'percent-encoded-value — UTF-8 only.
      const parts = value.split("'");
      const encoded = parts[2];
      value = parts.length === 3 && encoded !== undefined ? decodeUtf8Percent(encoded) : value;
    }
    if (key === "name") name = value;
    if (key === "filename") filename = value;
  }
  return { name, filename };
}

function decodeUtf8Percent(text: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "%" && i + 2 < text.length) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Stream-parse a `multipart/form-data` body into parts: one pass, bounded
 * buffering — file content is yielded chunk-by-chunk; the first boundary is
 * always at (or near) the head of a well-formed body, so the preamble scan
 * never walks more than a few chunks.
 *
 * The reader lock is deliberately NOT released when this generator ends or
 * is abandoned: a consumer may break out of the parts loop to stream the
 * captured part's content (which shares this reader through its ByteWindow),
 * so tearing the reader down here would break the still-live content
 * generator. The request-scoped stream is cancelled with the request.
 */
export async function* parseMultipartParts(
  body: ReadableStream<Uint8Array>,
  boundary: string,
): AsyncGenerator<MultipartPart> {
  const reader = body.getReader();
  const window = new ByteWindow(reader);
  const delimiter = encoder.encode(`--${boundary}`);
  // Preamble: discard bytes until the first delimiter (keep a partial-
  // match tail so a delimiter split across chunks is still found).
  let at = -1;
  for (;;) {
    at = window.indexOf(delimiter, 0);
    if (at !== -1) break;
    const retain = Math.min(window.buffered, delimiter.byteLength - 1);
    if (window.buffered > retain) window.drop(window.buffered - retain);
    if (!(await window.ensure(window.buffered + 1))) {
      throw new MalformedMultipartError("boundary never found");
    }
  }
  window.drop(at + delimiter.byteLength);

    for (;;) {
      // After the delimiter: optional transport padding, then the closing
      // "--" or a CRLF that starts the next part's headers.
      for (;;) {
        if (!(await window.ensure(2))) {
          throw new MalformedMultipartError("truncated after boundary");
        }
        if (window.matchAt(0, DASH_DASH)) {
          return; // closing delimiter — done
        }
        const byte = window.peek(0);
        if (byte === 32 || byte === 9) {
          window.drop(1); // transport padding
          continue;
        }
        if (!window.matchAt(0, CRLF)) {
          throw new MalformedMultipartError("boundary line not CRLF-terminated");
        }
        window.drop(2);
        break;
      }

    // Headers: bounded scan for the CRLFCRLF terminator.
    const headerEnd = await scanHeaders(window);
    const headerText = new TextDecoder("utf-8").decode(window.view(0, headerEnd));
    window.drop(headerEnd + 4); // the terminator
    const dispositionHeader = headerText
      .split("\r\n")
      .map((line) => line.split(":"))
      .find((parts) => (parts[0] ?? "").trim().toLowerCase() === "content-disposition")
      ?.slice(1)
      .join(":")
      .trim();
    const { name, filename } =
      dispositionHeader === undefined
        ? { name: "", filename: null }
        : parseContentDisposition(dispositionHeader);

    yield { name, filename, content: readPartContent(window, delimiter) };
  }
}

/** Read part headers: returns the offset of the CRLFCRLF terminator. */
async function scanHeaders(window: ByteWindow): Promise<number> {
  for (let end = 0; end < MAX_PART_HEADER_BYTES; end++) {
    if (!(await window.ensure(end + 4))) {
      throw new MalformedMultipartError("truncated part headers");
    }
    if (window.matchAt(end, CRLF) && window.matchAt(end + 2, CRLF)) {
      return end;
    }
  }
  throw new MalformedMultipartError("part headers exceed the size budget");
}

/**
 * The content generator of one part: yields byte chunks until the CRLF +
 * delimiter, leaving the window positioned right after it (the outer loop
 * then reads the closing "--" or the next part's headers). Retains only the
 * needle-length partial-match tail between chunks.
 */
async function* readPartContent(window: ByteWindow, delimiter: Uint8Array): AsyncGenerator<Uint8Array> {
  const needle = new Uint8Array(2 + delimiter.byteLength);
  needle.set(CRLF, 0);
  needle.set(delimiter, 2);
  for (;;) {
    const at = window.indexOf(needle, 0);
    if (at !== -1) {
      if (at > 0) yield window.view(0, at);
      window.drop(at + needle.byteLength);
      return;
    }
    const buffered = window.buffered;
    const retain = Math.min(buffered, needle.byteLength - 1);
    if (buffered > retain) {
      yield window.view(0, buffered - retain);
      window.drop(buffered - retain);
    }
    if (!(await window.ensure(window.buffered + 1))) {
      throw new MalformedMultipartError("part content not closed by a boundary");
    }
  }
}

/** Adapt a parsed part's content generator into a ReadableStream. */
export function readableStreamFromGenerator(gen: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await gen.next();
      if (done || value === undefined) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel() {
      void gen.return(undefined);
    },
  });
}

/** Capture a small non-file field's text (≤ 64 KiB, drained beyond). */
export async function readTextFieldPart(part: MultipartPart): Promise<string> {
  const collected: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of part.content) {
    if (total < MAX_FORM_FIELD_BYTES) {
      collected.push(chunk);
      total += chunk.byteLength;
    }
  }
  return new TextDecoder("utf-8").decode(concatBytes(collected, total));
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const only = chunks[0];
  if (chunks.length === 1 && only !== undefined) return only;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Incremental sha-256 over forwarded chunks (the DigestStream discipline). */
class RunningDigest {
  private readonly digest = new crypto.DigestStream("SHA-256");
  private readonly writer = this.digest.getWriter();

  write(chunk: Uint8Array): Promise<void> {
    return this.writer.write(chunk).then(() => undefined);
  }

  async hex(): Promise<string> {
    await this.writer.close();
    return bytesToHex(new Uint8Array(await this.digest.digest));
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export interface UploadReleaseAssetInput {
  bucket: R2Bucket;
  d1: D1Database;
  repoId: string;
  storageKey: string;
  releaseId: number;
  uploaderId: number;
  /** Display name (verbatim in D1; sanitized for the R2 key segment). */
  name: string;
  /** The extracted content stream (the file part, or the raw body). */
  content: ReadableStream<Uint8Array>;
  /** True when the content arrives via the multipart path (R2 MPU). */
  multipart: boolean;
  /**
   * Declared Content-Length of the RAW body (undefined = unbounded — the R2
   * binding rejects unknown-length streams, so the raw path requires it and
   * the routes answer 411 without it; multipart uses the MPU path instead).
   */
  declaredLength?: number;
  /** Limit override — test seam for the 413 path (routes use the module const). */
  maxBytes?: number;
  now?: Date;
}

/**
 * Stream one asset to R2 and land its D1 row (module header). Overflow (→
 * AssetTooLargeError/413) and any upstream failure clean up their R2 state
 * (object delete / MPU abort) so the orphan sweep never sees confirmed
 * bytes; a D1 failure after a successful upload deletes the object too.
 */
export async function uploadReleaseAsset(input: UploadReleaseAssetInput): Promise<ReleaseAssetRow> {
  const uuid = crypto.randomUUID();
  const key = releaseAssetKey(input.storageKey, input.releaseId, uuid, input.name);
  const digest = new RunningDigest();
  const limit = input.maxBytes ?? MAX_RELEASE_ASSET_BYTES;
  const size = await (input.multipart
    ? streamIntoMultipartUpload(input.bucket, key, input.content, digest, limit)
    : streamIntoObject(input.bucket, key, input.content, digest, input.declaredLength, limit));
  const checksumSha256 = await digest.hex();
  try {
    const rows = await drizzle(input.d1)
      .insert(releaseAssets)
      .values({
        uuid,
        repoId: input.repoId,
        releaseId: input.releaseId,
        uploaderId: input.uploaderId,
        name: input.name,
        size,
        downloadCount: 0,
        r2Key: key,
        checksumSha256,
        createdAt: input.now ?? new Date(),
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("release asset row insert returned no row");
    }
    return row;
  } catch (error) {
    await input.bucket.delete(key); // confirmed bytes need their row (§4.10)
    throw error;
  }
}

/**
 * The octet-stream path: single-pass hash-and-forward (LFS putStream shape).
 * A known declared length inserts a FixedLengthStream so the R2 binding gets
 * its required known-length body and a lying Content-Length errors the pipe
 * instead of truncating silently.
 */
async function streamIntoObject(
  bucket: R2Bucket,
  key: string,
  content: ReadableStream<Uint8Array>,
  digest: RunningDigest,
  declaredLength: number | undefined,
  limit: number,
): Promise<number> {
  let forwarded = 0;
  try {
    const hashAndForward = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        forwarded += chunk.byteLength;
        if (forwarded > limit) {
          throw new AssetTooLargeError();
        }
        controller.enqueue(chunk);
        return digest.write(chunk);
      },
      flush() {
        // Typed check beats FixedLengthStream's anonymous abort.
        if (declaredLength !== undefined && forwarded !== declaredLength) {
          throw new AssetSizeMismatchError();
        }
      },
    });
    const sink =
      declaredLength === undefined
        ? hashAndForward.readable
        : hashAndForward.readable.pipeThrough(new FixedLengthStream(declaredLength));
    // The pump and the store run concurrently; whichever fails first fails
    // the upload, and the catch leaves no object behind.
    const put = bucket.put(key, sink);
    await Promise.all([put, content.pipeTo(hashAndForward.writable)]);
  } catch (error) {
    await bucket.delete(key);
    throw error;
  }
  return forwarded;
}

/** The multipart path: bounded 8 MiB parts through an R2 multipart upload. */
async function streamIntoMultipartUpload(
  bucket: R2Bucket,
  key: string,
  content: ReadableStream<Uint8Array>,
  digest: RunningDigest,
  limit: number,
): Promise<number> {
  const mpu = await bucket.createMultipartUpload(key);
  const uploaded: R2UploadedPart[] = [];
  let partNumber = 1;
  let forwarded = 0;
  try {
    let buffer = new Uint8Array(UPLOAD_PART_BYTES);
    let filled = 0;
    const flush = async (): Promise<void> => {
      if (filled === 0) return;
      const body = buffer.slice(0, filled);
      uploaded.push(await mpu.uploadPart(partNumber, body));
      partNumber += 1;
      filled = 0;
    };
    const reader = content.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      forwarded += value.byteLength;
      if (forwarded > limit) {
        throw new AssetTooLargeError();
      }
      await digest.write(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const room = UPLOAD_PART_BYTES - filled;
        const count = Math.min(room, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === UPLOAD_PART_BYTES) {
          await flush();
        }
      }
    }
    await flush();
    if (uploaded.length === 0) {
      // Zero-byte asset: abort the (empty) MPU and store the empty object
      // directly — a multipart upload with no parts cannot be completed.
      await mpu.abort();
      await bucket.put(key, new Uint8Array(0));
      return forwarded;
    }
    await mpu.complete(uploaded);
  } catch (error) {
    try {
      await mpu.abort();
    } catch {
      // Already aborted/completed (or the sweep collects the parts, §4.10) —
      // abort failures must not mask the original error.
    }
    throw error;
  }
  return forwarded;
}

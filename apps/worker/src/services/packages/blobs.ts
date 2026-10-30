/**
 * The package blob store (SPEC-0016 §4.2/§5.1) — the R2 half over the shared
 * REPO_PACKS bucket, one new namespace beside the engine's `repos/`+`imports/`
 * prefixes, the LFS `lfs/` family and the release assets:
 *
 *   packages/blobs/aa/bb/<sha256>   content blobs — GLOBAL content-addressed
 *                                   keys (upstream KeyToRelativePath's 2/2
 *                                   shard, content_store.go:69-71, under a
 *                                   packages/ root). Owner scoping lives only
 *                                   in D1; two owners uploading identical
 *                                   bytes share one object (the dedup the
 *                                   four-hash blob row models).
 *   packages/tmp/<upload-uuid>      the hash-then-key spool (§5.1). Read only
 *                                   by the upload that created it; deleted on
 *                                   both success and failure paths.
 *
 * ## The two-pass copy (ratification 1, §5.1)
 *
 * The generic PUT must know the sha256 BEFORE the final R2 key exists, but
 * the body can only be read once. Pass 1 streams the request body through a
 * hash-and-cap transform into the spool object (single pass, never
 * buffering — the release-asset discipline, api/services/release-assets.ts;
 * the three WebCrypto digests computed in the same pass). The D1 dedup
 * lookup then decides: a hit skips the copy entirely; a miss runs ONE
 * bounded second pass — `bucket.get(spool)` body → `bucket.put(content-key)`
 * (intra-datacenter bandwidth, no egress) — and the spool is deleted on both
 * paths. The D1 row lands only after the final key is durably stored
 * (object-first, §5.1: D1 rows are only useful once the bytes they point at
 * exist).
 *
 * Failure windows (§5.1): a crash between spool-put and final-put leaves an
 * orphan tmp object; a crash between final-put and D1-insert leaves an
 * unreferenced content blob — the packages cleanup arm's OLDER_THAN sweep is
 * the SOLE deleter for both (ratification 4).
 *
 * ## Streaming discipline (AGENTS.md Workers rules)
 *
 * A DECLARED Content-Length (the common case — every real registry client
 * sends one) streams through a FixedLengthStream (a lying header errors the
 * pipe instead of truncating), with the 512 MiB cap checked BEFORE streaming
 * (declared length) and per-chunk WHILE streaming.
 *
 * A CHUNKED body (no Content-Length — `curl -T -`, `curl --data-binary @-`;
 * the packages parity review's D-2: upstream Go streams these) spools through
 * a bounded R2 MULTIPART upload instead — the R2 binding rejects
 * unknown-length streams (release-assets.ts's raw path requires the declared
 * length for the same reason), so the unknown arm buffers 8 MiB parts at a
 * time and uploads them as it goes: memory stays flat, the per-chunk cap
 * still fires mid-stream (→ 413), and the completed spool object is
 * byte-identical in role to the known-length arm's (pass 2 cannot tell the
 * arms apart). An isolate death mid-MPU leaves uploaded parts for R2's own
 * incomplete-part collection — the same ratified orphan window the
 * release-asset MPU carries. `arrayBuffer()` is never called on an
 * unknown-size body.
 */

import { and, eq, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageBlobs } from "../../db/schema";

/** SPEC-0005 §3.3 / SPEC-0016 §3.4 — the hard byte cap (512 MiB). */
export const MAX_PACKAGE_BLOB_BYTES = 512 * 1024 * 1024;

const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The content key for a sha256 hex digest — upstream's `aa/bb/` shard
 * (KeyToRelativePath, content_store.go:69-71) under the packages/ root.
 * Format-gated BEFORE any R2 call (the LFS injection-proof rule:
 * services/lfs/store.ts:5-9) — an invalid segment throws, it never reaches
 * the bucket.
 */
export function packageBlobContentKey(sha256: string): string {
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`invalid package blob sha256: ${sha256}`);
  }
  return `packages/blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/** The spool key for an upload uuid (format-gated, same discipline). */
export function packageBlobSpoolKey(uploadUuid: string): string {
  if (!UUID_RE.test(uploadUuid)) {
    throw new Error(`invalid package upload uuid: ${uploadUuid}`);
  }
  return `packages/tmp/${uploadUuid}`;
}

/** Thrown when the streamed blob exceeds MAX_PACKAGE_BLOB_BYTES (→ 413). */
export class PackageBlobTooLargeError extends Error {
  constructor() {
    super("package blob is too large");
    this.name = "PackageBlobTooLargeError";
  }
}

/** Thrown when the streamed bytes contradict the declared Content-Length (→ 400). */
export class PackageSizeMismatchError extends Error {
  constructor() {
    super("request body size does not match Content-Length");
    this.name = "PackageSizeMismatchError";
  }
}

/** One spooled upload's digest record (pass 1's product). */
export interface SpooledBlob {
  spoolKey: string;
  size: number;
  /** hex digests; the three WebCrypto-supported ones are always computed. */
  sha1: string;
  sha256: string;
  sha512: string;
}

/** Incremental digests over forwarded chunks (the DigestStream discipline). */
class RunningDigests {
  private readonly sha1 = new crypto.DigestStream("SHA-1");
  private readonly sha256 = new crypto.DigestStream("SHA-256");
  private readonly sha512 = new crypto.DigestStream("SHA-512");
  private readonly w1 = this.sha1.getWriter();
  private readonly w256 = this.sha256.getWriter();
  private readonly w512 = this.sha512.getWriter();

  write(chunk: Uint8Array): Promise<void> {
    // One chunk, three writers — upstream's HashedSizeReader computes all
    // four sums in one pass; MD5 is unavailable in Workers' WebCrypto, so the
    // blob row's hash_md5 stays NULL (documented at the schema table).
    return Promise.all([
      this.w1.write(chunk),
      this.w256.write(chunk),
      this.w512.write(chunk),
    ]).then(() => undefined);
  }

  async hexes(): Promise<{ sha1: string; sha256: string; sha512: string }> {
    await Promise.all([this.w1.close(), this.w256.close(), this.w512.close()]);
    const [d1, d256, d512] = await Promise.all([this.sha1.digest, this.sha256.digest, this.sha512.digest]);
    return {
      sha1: bytesToHex(new Uint8Array(d1)),
      sha256: bytesToHex(new Uint8Array(d256)),
      sha512: bytesToHex(new Uint8Array(d512)),
    };
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export interface SpoolAndHashInput {
  bucket: R2Bucket;
  /** The request body stream (the store never calls arrayBuffer on it). */
  content: ReadableStream<Uint8Array>;
  /**
   * The declared Content-Length when the client sent one (every real registry
   * client does). `undefined` — a chunked body (the parity review's D-2) —
   * spools through the bounded R2 multipart upload instead of the
   * FixedLengthStream, streaming all the same: the size-mismatch check is
   * meaningless without a declaration, the cap still fires per-chunk.
   */
  declaredLength?: number;
  /** Cap override — test seam (routes use the module const). */
  maxBytes?: number;
  /** Spool key override — test seam (routes mint a random uuid). */
  spoolKey?: string;
}

/** The bounded MPU part (the release-asset posture — above R2's 5 MiB part
 *  floor, far under the memory budget, 64 parts to the 512 MiB cap). */
const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

/**
 * PASS 1 (§5.1) — the KNOWN-LENGTH arm: single-pass hash-and-forward into the
 * spool object through a FixedLengthStream. The 512 MiB cap is checked BEFORE
 * streaming (declared length) and per-chunk WHILE streaming; a lying
 * Content-Length errors the pipe (mapped to PackageSizeMismatchError). Any
 * failure deletes the spool object so confirmed bytes never orphan (the
 * release-asset rollback).
 */
async function spoolKnownLength(input: SpoolAndHashInput, spoolKey: string, limit: number): Promise<SpooledBlob> {
  const declaredLength = input.declaredLength as number;
  const digests = new RunningDigests();
  let forwarded = 0;
  try {
    // BEFORE streaming (§6 storage plan: "over-cap → 413 checked before and
    // during streaming").
    if (declaredLength > limit) {
      throw new PackageBlobTooLargeError();
    }
    const hashAndCap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        forwarded += chunk.byteLength;
        if (forwarded > limit) {
          throw new PackageBlobTooLargeError();
        }
        controller.enqueue(chunk);
        return digests.write(chunk);
      },
      flush() {
        // Typed check beats FixedLengthStream's anonymous abort.
        if (forwarded !== declaredLength) {
          throw new PackageSizeMismatchError();
        }
      },
    });
    const sink = hashAndCap.readable.pipeThrough(new FixedLengthStream(declaredLength));
    // The pump and the store run concurrently; whichever fails first fails
    // the upload, and the catch leaves no spool object behind.
    const put = input.bucket.put(spoolKey, sink);
    await Promise.all([put, input.content.pipeTo(hashAndCap.writable)]);
  } catch (error) {
    await input.bucket.delete(spoolKey);
    throw error;
  }
  const hexes = await digests.hexes();
  return { spoolKey, size: forwarded, ...hexes };
}

/**
 * PASS 1 (§5.1) — the CHUNKED arm (no declared length): the same
 * hash-and-cap walk, but the sink is a bounded R2 multipart upload — 8 MiB
 * parts streamed as they fill, memory flat regardless of body size. The cap
 * fires per-chunk (→ 413); no size-mismatch check exists without a
 * declaration (there is nothing to mismatch). Failure aborts the MPU and
 * deletes any completed spool; a zero-byte body aborts the (empty) MPU and
 * stores the empty object directly — an MPU with no parts cannot complete.
 */
async function spoolUnknownLength(input: SpoolAndHashInput, spoolKey: string, limit: number): Promise<SpooledBlob> {
  const digests = new RunningDigests();
  const mpu = await input.bucket.createMultipartUpload(spoolKey);
  const uploaded: R2UploadedPart[] = [];
  let partNumber = 1;
  let forwarded = 0;
  try {
    const buffer = new Uint8Array(UPLOAD_PART_BYTES);
    let filled = 0;
    const flush = async (): Promise<void> => {
      if (filled === 0) return;
      uploaded.push(await mpu.uploadPart(partNumber, buffer.slice(0, filled)));
      partNumber += 1;
      filled = 0;
    };
    const reader = input.content.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      forwarded += value.byteLength;
      if (forwarded > limit) {
        throw new PackageBlobTooLargeError();
      }
      await digests.write(value);
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
      await mpu.abort();
      await input.bucket.put(spoolKey, new Uint8Array(0));
    } else {
      await mpu.complete(uploaded);
    }
  } catch (error) {
    try {
      await mpu.abort();
    } catch {
      // Already aborted/completed — abort failures must not mask the error.
    }
    await input.bucket.delete(spoolKey).catch(() => undefined);
    throw error;
  }
  const hexes = await digests.hexes();
  return { spoolKey, size: forwarded, ...hexes };
}

/**
 * PASS 1 (§5.1): single-pass hash-and-forward into the spool object — the
 * known-length arm through a FixedLengthStream, the chunked arm through the
 * bounded multipart upload (see the module header's streaming discipline).
 * Either way the 512 MiB cap is enforced WHILE streaming and any failure
 * leaves no spool object behind.
 */
export async function spoolAndHash(input: SpoolAndHashInput): Promise<SpooledBlob> {
  const spoolKey = input.spoolKey ?? packageBlobSpoolKey(crypto.randomUUID());
  const limit = input.maxBytes ?? MAX_PACKAGE_BLOB_BYTES;
  return input.declaredLength === undefined
    ? spoolUnknownLength(input, spoolKey, limit)
    : spoolKnownLength(input, spoolKey, limit);
}

/**
 * PASS 2 (§5.1): ONE bounded second pass — stream the spool object's body
 * into the content key, then delete the spool. The spool body is a
 * known-length stream (an R2 object body), so put() accepts it directly.
 * The spool delete runs on BOTH the success and failure paths (§4.2: never
 * read by anything but the upload that created it).
 */
export async function copySpoolToContentKey(bucket: R2Bucket, spoolKey: string, sha256: string): Promise<void> {
  const contentKey = packageBlobContentKey(sha256);
  try {
    const spooled = await bucket.get(spoolKey);
    if (spooled === null) {
      throw new Error(`package spool object vanished: ${spoolKey}`);
    }
    await bucket.put(contentKey, spooled.body);
  } finally {
    await bucket.delete(spoolKey);
  }
}

/** The blob row type consumers render (PackageFile's hash fields). */
export type PackageBlobRow = typeof packageBlobs.$inferSelect;

export interface GetOrInsertBlobInput {
  size: number;
  sha256: string;
  sha1?: string | null;
  sha512?: string | null;
  now?: Date;
}

/** The dedup predicate: size + sha256. The sha256 IS the content identity
 *  (and the R2 key), so it alone arbitrates — upstream's lookup spans all
 *  four hashes because upstream always computes all four; ours may leave the
 *  optional digests NULL, and a same-sha256 row with a different digest set
 *  is the SAME bytes (the extra UNIQUEs stay for the schema parity and the
 *  collision probes). */
function blobKeyConditions(input: GetOrInsertBlobInput): SQL[] {
  return [eq(packageBlobs.size, input.size), eq(packageBlobs.hashSha256, input.sha256)];
}

/**
 * `GetOrInsertBlob` (upstream package_blob.go:52-77, the §5.2 GetOrInsert
 * shape): dedup lookup by (size, sha256), insert on the miss whose sha256
 * UNIQUE arbitrates the concurrent race — a losing insert re-selects BY
 * SHA256 and answers the winner's row (upstream's own retry arm, relaxed to
 * the content identity: a same-sha256 row with a drifted size column is the
 * same bytes, so it is answered rather than erroring). The CALLER owns the
 * R2 half: a `created: false` answer means the bytes already exist (skip the
 * second pass), a `created: true` answer means the content key must be
 * stored before this row is useful.
 */
export async function getOrInsertBlob(
  d1: D1Database,
  input: GetOrInsertBlobInput,
): Promise<{ row: PackageBlobRow; created: boolean }> {
  const db = drizzle(d1);
  const where = and(...blobKeyConditions(input));
  const existing = await db.select().from(packageBlobs).where(where).get();
  if (existing !== undefined) {
    return { row: existing, created: false };
  }
  const inserted = await db
    .insert(packageBlobs)
    .values({
      size: input.size,
      hashSha256: input.sha256,
      hashSha1: input.sha1 ?? null,
      hashSha512: input.sha512 ?? null,
      createdUnix: input.now ?? new Date(),
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (row !== undefined) {
    return { row, created: true };
  }
  // A concurrent insert won the sha256 UNIQUE — answer its row by the
  // content identity alone.
  const winner = await db.select().from(packageBlobs).where(eq(packageBlobs.hashSha256, input.sha256)).get();
  if (winner === undefined) {
    throw new Error("package blob insert raced and the dedup lookup then missed");
  }
  return { row: winner, created: false };
}

/** `GetBlobByID` (package_blob.go:78+) — the download path's row. */
export async function getBlobById(d1: D1Database, blobId: number): Promise<PackageBlobRow | null> {
  return (await drizzle(d1).select().from(packageBlobs).where(eq(packageBlobs.id, blobId)).get()) ?? null;
}

/**
 * LFS blob storage — the `LfsStore` capability interface over R2
 * (SPEC-0006 §2.3, §3.1).
 *
 * Keys are `lfs/<storage_key>/<oid>` — the R2 key is a pure function of the
 * repo's immutable storage key (`r_<id>`, SPEC-0003 §3.1) and the validated
 * 64-hex oid, so it is content-addressed and injection-proof: invalid oids
 * never reach key construction (port of upstream's panic guard,
 * `modules/lfs/pointer.go:115-124`). Never store these keys; D1 keeps bare
 * rows only (§3.2).
 *
 * Two implementations sit behind one interface:
 *
 * - `RelayLfsStore` — Worker-relayed streaming (day-one default, no secrets).
 *   `put` runs a single-pass hash-and-forward pipeline (each chunk is enqueued
 *   downstream AND hashed into a `DigestStream` — never `.tee()`, which would
 *   buffer the unconsumed branch in isolate memory) and enforces
 *   sha256(content) == oid and Content-Length, deleting the R2 object on any
 *   mismatch (upstream `hashingReader` discipline, `content_store.go:95-165`).
 * - `PresignLfsStore` — checksum-bound presigned R2 URLs via `aws4fetch`
 *   SigV4 query signing. The `x-amz-checksum-sha256` header (base64 of the
 *   oid's raw 32 bytes) is bound into the PUT signature and repeated in the
 *   href's `header` map, so a successful PUT *proves* sha256(content) == oid —
 *   integrity is enforced by storage, not by a later pass. R2's binding does
 *   not expose presigning, so this needs S3 credentials; `presignPut` /
 *   `presignGet` return `null` when unsupported and callers fall back to the
 *   relay handlers (the capability probe of §2.3).
 *
 * Required secrets/vars for presign mode (create with `wrangler secret put`;
 * never in source or wrangler.jsonc):
 * - `R2_ACCESS_KEY_ID` — R2 S3 API token access key (dashboard-created).
 * - `R2_SECRET_ACCESS_KEY` — the matching secret access key.
 * - `R2_ACCOUNT_ID` — Cloudflare account id (plain var is fine; not secret).
 * The presigned host is `<account>.r2.cloudflarestorage.com/<bucket>/…`, so
 * `bucketName` must match the bound bucket (or the dedicated-bucket override).
 */

import { AwsV4Signer } from "aws4fetch";

import { InvalidPointerError } from "./pointer";

/** Default presigned-URL TTL (SPEC-0006 §2.3; `LFS_URL_TTL_SECONDS`). */
export const DEFAULT_LFS_URL_TTL_SECONDS = 900;
/** S3 caps presigned URLs at 7 days. */
export const MAX_LFS_URL_TTL_SECONDS = 604_800;

const OID_RE = /^[0-9a-f]{64}$/;
const STORAGE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** Thrown when a storage key would be built from a non-validated segment. */
export class LfsKeyError extends Error {
  constructor(reason: string) {
    super(`invalid LFS storage key: ${reason}`);
    this.name = "LfsKeyError";
  }
}

/** Upstream `lfs_module.ErrHashMismatch` (`modules/lfs/content_store.go:18`). */
export class LfsHashMismatchError extends Error {
  constructor() {
    super("content hash does not match OID");
    this.name = "LfsHashMismatchError";
  }
}

/** Upstream `lfs_module.ErrSizeMismatch` (`modules/lfs/content_store.go:19`). */
export class LfsSizeMismatchError extends Error {
  constructor() {
    super("content size does not match");
    this.name = "LfsSizeMismatchError";
  }
}

/**
 * Build the R2 key for an LFS object. Both segments are format-gated before
 * any string is concatenated (SPEC-0006 §3.1/§4.12).
 */
export function lfsKey(storageKey: string, oid: string): string {
  if (!STORAGE_KEY_RE.test(storageKey)) {
    throw new LfsKeyError(`storage key must match ${STORAGE_KEY_RE.source}: ${storageKey}`);
  }
  if (!OID_RE.test(oid)) {
    throw new InvalidPointerError(`oid is not 64 lowercase hex chars: ${oid}`);
  }
  return `lfs/${storageKey}/${oid}`;
}

/** Existence + size + stored sha256 (hex), as seen by a HEAD. */
export interface LfsObjectStat {
  size: number;
  /** Hex sha256 R2 stored for the object; null when unknown. */
  sha256Hex: string | null;
}

export interface LfsPutOptions {
  /** Known Content-Length — enables a FixedLengthStream (size enforcement). */
  size?: number;
  /**
   * Bind this checksum into the stored object (the oid in relay mode).
   * The streamed body is hashed in the same pass; mismatch ⇒ object deleted
   * and `LfsHashMismatchError` / `LfsSizeMismatchError`.
   */
  expectedSha256Hex?: string;
  httpMetadata?: R2HTTPMetadata;
}

export interface LfsGetOptions {
  range?: R2Range;
}

export interface LfsPresignPutOptions {
  /** Full R2 key (`lfs/<storage_key>/<oid>`) — see `lfsKey`. */
  key: string;
  /** `x-amz-checksum-sha256` value: base64 of the oid's raw 32 bytes. */
  checksumSha256Base64: string;
  ttlSeconds?: number;
  /** Injectable clock for deterministic signatures (tests). */
  now?: Date;
}

export interface LfsPresignGetOptions {
  key: string;
  /** Signed-in `response-content-disposition` override (filename parity). */
  responseContentDisposition?: string;
  /** Signed-in `response-content-type` override. */
  responseContentType?: string;
  ttlSeconds?: number;
  now?: Date;
}

/** A batch-API action link (upstream `lfs_module.Link` + expiry fields). */
export interface LfsHref {
  href: string;
  header?: Record<string, string>;
  /** RFC3339 (second precision) — git-lfs refreshes by re-batching. */
  expiresAt?: string;
  /** Seconds until expiry — mirrors `expires_at` for easy math. */
  expiresIn?: number;
}

/**
 * One LFS storage capability: relay primitives for the data path plus the
 * presign probes of §2.3. `presignPut`/`presignGet` return `null` when the
 * implementation cannot mint presigned URLs ⇒ callers use relay handlers.
 */
export interface LfsStore {
  /** "presign" implementations also relay (verify/adopt HEAD via binding). */
  readonly mode: "relay" | "presign";
  put(
    key: string,
    body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
    options?: LfsPutOptions,
  ): Promise<R2Object | null>;
  get(key: string, options?: LfsGetOptions): Promise<R2ObjectBody | null>;
  head(key: string): Promise<LfsObjectStat | null>;
  delete(key: string): Promise<void>;
  presignPut(options: LfsPresignPutOptions): Promise<LfsHref | null>;
  presignGet(options: LfsPresignGetOptions): Promise<LfsHref | null>;
}

/** Shared relay primitives over the R2 binding (both modes need them). */
export class RelayLfsStore implements LfsStore {
  readonly mode: "relay" | "presign" = "relay";

  constructor(protected readonly bucket: R2Bucket) {}

  async put(
    key: string,
    body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
    options: LfsPutOptions = {},
  ): Promise<R2Object | null> {
    if (body instanceof ReadableStream) {
      return this.putStream(key, body, options);
    }
    const digestHex = await sha256Hex(new Uint8Array(body));
    assertExpected(digestHex, body.byteLength, options);
    return this.bucket.put(key, body, {
      ...(options.expectedSha256Hex !== undefined ? { sha256: options.expectedSha256Hex } : {}),
      ...(options.httpMetadata !== undefined ? { httpMetadata: options.httpMetadata } : {}),
    });
  }

  /**
   * Single-pass hash-and-forward (SPEC-0006 §2.3): the source is piped through
   * a transform that forwards each chunk and writes it into a DigestStream —
   * one pass, no buffering. A known size inserts a FixedLengthStream so a
   * lying Content-Length errors the pipe instead of truncating silently.
   */
  protected async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: LfsPutOptions,
  ): Promise<R2Object | null> {
    const digest = new crypto.DigestStream("SHA-256"); // workerd exposes DigestStream under `crypto`
    const digestWriter = digest.getWriter();
    const limit = options.size;
    let forwarded = 0;

    const hashAndForward = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        forwarded += chunk.byteLength;
        // Typed size enforcement beats FixedLengthStream's anonymous abort —
        // the handlers map LfsSizeMismatchError to upstream's 422.
        if (limit !== undefined && forwarded > limit) {
          throw new LfsSizeMismatchError();
        }
        controller.enqueue(chunk);
        // Awaited for ordering + backpressure; SHA-256 keeps up with the pipe.
        return digestWriter.write(chunk);
      },
      flush() {
        if (limit !== undefined && forwarded !== limit) {
          throw new LfsSizeMismatchError();
        }
        return digestWriter.close();
      },
    });

    const sink = options.size === undefined
      ? hashAndForward.readable
      : hashAndForward.readable.pipeThrough(new FixedLengthStream(options.size));

    let stored: R2Object | null;
    try {
      // R2 binding streams need a known length; handlers must require
      // Content-Length on relay uploads (git-lfs basic always sends one) and
      // answer 411 otherwise — SPEC-0006 §2.3. The pump and the store run
      // concurrently: whichever fails first fails the put, and the catch
      // leaves no object behind.
      const pumping = body.pipeTo(hashAndForward.writable);
      stored = await Promise.all([this.bucket.put(key, sink, {
        ...(options.expectedSha256Hex !== undefined ? { sha256: options.expectedSha256Hex } : {}),
        ...(options.httpMetadata !== undefined ? { httpMetadata: options.httpMetadata } : {}),
      }), pumping]).then(([result]) => result);
      const bytesWritten = Number(digest.bytesWritten);
      if (options.size !== undefined && bytesWritten !== options.size) {
        throw new LfsSizeMismatchError();
      }
      assertExpected(bytesToHex(new Uint8Array(await digest.digest)), bytesWritten, options);
    } catch (error) {
      // Never leave partial/corrupt bytes behind (§2.3 mismatch handling).
      await this.bucket.delete(key);
      // R2 validates the bound checksum at receive time (storage-enforced
      // integrity, the relay twin of the presigned PUT's
      // x-amz-checksum-sha256) and rejects with its own wording — rewrap it
      // so handlers can map the mismatch to upstream's 422.
      if (
        options.expectedSha256Hex !== undefined &&
        error instanceof Error &&
        !(error instanceof LfsHashMismatchError) &&
        !(error instanceof LfsSizeMismatchError) &&
        /sha-256 checksum/i.test(error.message)
      ) {
        throw new LfsHashMismatchError();
      }
      throw error;
    }
    return stored;
  }

  async get(key: string, options: LfsGetOptions = {}): Promise<R2ObjectBody | null> {
    const result = await this.bucket.get(key, options.range === undefined ? {} : { range: options.range });
    return result ?? null;
  }

  async head(key: string): Promise<LfsObjectStat | null> {
    const object = await this.bucket.head(key);
    if (object === null) return null;
    const checksums = object.checksums.toJSON();
    const sha256Hex = checksums.sha256 ?? null;
    return { size: object.size, sha256Hex };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  presignPut(_options: LfsPresignPutOptions): Promise<LfsHref | null> {
    return Promise.resolve(null); // relay capability probe: never presigns
  }

  presignGet(_options: LfsPresignGetOptions): Promise<LfsHref | null> {
    return Promise.resolve(null);
  }
}

export interface R2S3Credentials {
  /** `R2_ACCESS_KEY_ID` secret. */
  accessKeyId: string;
  /** `R2_SECRET_ACCESS_KEY` secret. */
  secretAccessKey: string;
  /** `R2_ACCOUNT_ID` var — first label of the S3 endpoint host. */
  accountId: string;
}

export interface PresignLfsStoreOptions {
  bucketName: string;
  ttlSeconds?: number;
}

/**
 * Presigned-URL mode (SPEC-0006 §2.3 default when credentials exist):
 * SigV4 query signing against `https://<account>.r2.cloudflarestorage.com`.
 * Signing is pure local HMAC — zero subrequests. The PUT binds
 * `x-amz-checksum-sha256` into the signature AND echoes it in the header map;
 * the GET signs optional `response-content-*` overrides instead.
 */
export class PresignLfsStore extends RelayLfsStore {
  override readonly mode = "presign" as const;

  constructor(
    bucket: R2Bucket,
    private readonly credentials: R2S3Credentials,
    private readonly options: PresignLfsStoreOptions,
  ) {
    super(bucket);
  }

  override async presignPut(options: LfsPresignPutOptions): Promise<LfsHref | null> {
    const { ttl, datetime } = this.clock(options);
    const url = this.endpoint(options.key);
    url.searchParams.set("X-Amz-Expires", String(ttl)); // respected: only defaulted when absent
    const signer = new AwsV4Signer({
      method: "PUT",
      url: url.toString(),
      headers: { "x-amz-checksum-sha256": options.checksumSha256Base64 },
      accessKeyId: this.credentials.accessKeyId,
      secretAccessKey: this.credentials.secretAccessKey,
      signQuery: true,
      service: "s3",
      region: "auto",
      datetime,
    });
    const signed = await signer.sign();
    return {
      href: signed.url.toString(),
      header: { "x-amz-checksum-sha256": options.checksumSha256Base64 },
      expiresAt: rfc3339(options.now ?? new Date(), ttl),
      expiresIn: ttl,
    };
  }

  override async presignGet(options: LfsPresignGetOptions): Promise<LfsHref | null> {
    const { ttl, datetime } = this.clock(options);
    const url = this.endpoint(options.key);
    url.searchParams.set("X-Amz-Expires", String(ttl));
    if (options.responseContentDisposition !== undefined) {
      url.searchParams.set("response-content-disposition", options.responseContentDisposition);
    }
    if (options.responseContentType !== undefined) {
      url.searchParams.set("response-content-type", options.responseContentType);
    }
    const signer = new AwsV4Signer({
      method: "GET",
      url: url.toString(),
      accessKeyId: this.credentials.accessKeyId,
      secretAccessKey: this.credentials.secretAccessKey,
      signQuery: true,
      service: "s3",
      region: "auto",
      datetime,
    });
    const signed = await signer.sign();
    // Presigned URLs are bearer credentials — no Authorization echo.
    return { href: signed.url.toString(), expiresAt: rfc3339(options.now ?? new Date(), ttl), expiresIn: ttl };
  }

  private clock(options: { ttlSeconds?: number; now?: Date }): { ttl: number; datetime: string } {
    const ttl = options.ttlSeconds ?? this.options.ttlSeconds ?? DEFAULT_LFS_URL_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_LFS_URL_TTL_SECONDS) {
      throw new RangeError(`LFS URL TTL must be 1..${MAX_LFS_URL_TTL_SECONDS} seconds, got ${ttl}`);
    }
    const now = options.now ?? new Date();
    // aws4fetch datetime shape: 20261024T000000Z.
    const datetime = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    return { ttl, datetime };
  }

  private endpoint(key: string): URL {
    const base = `https://${this.credentials.accountId}.r2.cloudflarestorage.com`;
    return new URL(`/${encodeURIComponent(this.options.bucketName)}/${key}`, base);
  }
}

export interface LfsStoreConfig {
  /** "auto" (default): presign when S3 credentials are present, else relay. */
  mode?: "auto" | "relay" | "presign";
  /** S3 credentials for presign mode; absent ⇒ relay fallback. */
  credentials?: Partial<R2S3Credentials>;
  bucketName?: string;
  ttlSeconds?: number;
}

/** True when the credential triple is complete enough to presign. */
export function hasPresignCredentials(config: LfsStoreConfig): boolean {
  const c = config.credentials;
  return c?.accessKeyId !== undefined && c.accessKeyId !== "" &&
    c?.secretAccessKey !== undefined && c.secretAccessKey !== "" &&
    c?.accountId !== undefined && c.accountId !== "";
}

/**
 * Mode selection (SPEC-0006 §2.3): presign is the default when S3 credentials
 * exist and `LFS_HREF_MODE` does not force relay; explicit "presign" with
 * missing credentials is a loud misconfiguration.
 */
export function createLfsStore(bucket: R2Bucket, config: LfsStoreConfig = {}): LfsStore {
  const mode = config.mode ?? "auto";
  const canPresign = hasPresignCredentials(config) && config.bucketName !== undefined;
  if (mode === "presign" && !canPresign) {
    throw new LfsKeyError(
      "LFS_HREF_MODE=presign requires R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY secrets and an R2_ACCOUNT_ID var",
    );
  }
  if (mode !== "relay" && canPresign) {
    return new PresignLfsStore(bucket, config.credentials as R2S3Credentials, {
      bucketName: config.bucketName as string,
      ttlSeconds: config.ttlSeconds,
    });
  }
  return new RelayLfsStore(bucket);
}

function assertExpected(digestHex: string, size: number, options: LfsPutOptions): void {
  if (options.expectedSha256Hex !== undefined && digestHex !== options.expectedSha256Hex.toLowerCase()) {
    throw new LfsHashMismatchError();
  }
  if (options.size !== undefined && size !== options.size) {
    throw new LfsSizeMismatchError();
  }
}

/** `x-amz-checksum-sha256` value for an oid: base64 of its raw 32 bytes. */
export function checksumHeaderFor(oid: string): string {
  if (!OID_RE.test(oid)) {
    throw new InvalidPointerError(`oid is not 64 lowercase hex chars: ${oid}`);
  }
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    raw[i] = Number.parseInt(oid.slice(i * 2, i * 2 + 2), 16);
  }
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** RFC3339 with second precision (the SPEC's `2026-10-24T12:45:00Z` shape). */
export function rfc3339(now: Date, offsetSeconds: number): string {
  return new Date(now.getTime() + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

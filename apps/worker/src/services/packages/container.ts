/**
 * The OCI container registry service (SPEC-0016 §7 M6 — the seventh package
 * protocol). The upstream map, at the pin (routers 1,459 lines + services 456):
 *
 *   routers/api/packages/api.go:509-547     ContainerRoutes() — the /v2/ root
 *                                           mount, the wire arms this module
 *                                           backs (the route half lives in
 *                                           api/routes/packages-protocols.ts's
 *                                           createContainerProtocolRouter)
 *   routers/api/packages/container/container.go  the arms + the 401 handshake
 *                                           (APIUnauthorizedError :116-130) +
 *                                           the response-header writer (:53-88)
 *   routers/api/packages/container/blob.go  saveAsPackageBlob (:28-68), the
 *                                           upload version (:86-133),
 *                                           createFileForBlob (:135-160),
 *                                           deleteBlob (:162-186)
 *   routers/api/packages/container/manifest.go  processManifest (:41-73), the
 *                                           image-manifest (:100-159) and
 *                                           image-index (:161-229) flows,
 *                                           createPackageAndVersion (:231-320,
 *                                           the delete-and-recreate overwrite
 *                                           arm), createFileFromBlobReference
 *                                           (:331-377), createManifestBlob
 *                                           (:379-416)
 *   routers/api/packages/container/errors.go  the OCI named errors
 *   services/packages/container/blob_uploader.go  the chunked upload session
 *   services/packages/container/common.go   ParseManifestMetadata
 *   services/packages/container/cleanup.go  the expiry sweeps
 *   models/packages/container/search.go     the blob/tag/repository searches
 *   models/packages/package_blob_upload.go  the upload-session row
 *   modules/packages/container/{const,metadata}.go  the property names, media
 *                                           types and the Metadata payload
 *   services/packages/auth.go               the HS256 authorization token
 *                                           (CreateAuthorizationToken :30-55 /
 *                                           ParseAuthorizationToken :73-89),
 *                                           keyed — exactly like upstream —
 *                                           off the general token signing
 *                                           secret (GetGeneralTokenSigningSecret
 *                                           role; our row is the actions
 *                                           keystore's shared
 *                                           `general_token_signing_secret`)
 *
 * ## The upload-session store (the M6 SPEC-attachment decision, §8.6)
 *
 * UPSTREAM SPLITS the state: a `package_blob_upload` D1-analog ROW (id,
 * BytesReceived, HashStateBytes, updated INDEX) plus the chunk bytes in a
 * TEMP FILE under AppDataTempDir("package-upload") (blob_uploader.go:33-39).
 * The ratified candidates were "R2 multipart-upload handles" vs "a D1
 * upload-rows model"; the upstream-faithful answer is BOTH HALVES in their
 * native homes — the row lands in D1 (`package_blob_uploads`, migration 0046,
 * the schema table's comment carries the column mapping) and the chunk bytes
 * land in R2 (`packages/uploads/<uuid>/<seq>` — R2 cannot append, so ONE
 * OBJECT PER PATCH stands in for the appended file; the D1 `chunk_count`
 * column is the ordered enumeration upstream infers from the file extent).
 * R2 multipart uploads were rejected because their non-terminal parts have a
 * 5 MiB floor — real chunked pushes stream smaller parts (the OCI spec
 * explicitly allows arbitrary chunk sizes) and complete() would fail.
 *
 * TWO disclosed reductions, both forced by the platform:
 *   1. NO HashStateBytes: WebCrypto digest state is unserializable, so the
 *      PUT re-streams the chunks through fresh digests instead of resuming
 *      upstream's MultiHasher (blob_uploader.go:48-53, :104-109) — the R2
 *      reads are intra-datacenter and bounded by the 512 MiB cap.
 *   2. EACH PATCH chunk is spooled through the bounded store
 *      (spoolAndHash's 512 MiB cap fires per chunk; upstream's temp file is
 *      unbounded) — a single PATCH chunk over the cap answers 413.
 * The PUT-finalize digest verification, the quota checks and the
 * delete-on-success session lifecycle are upstream-exact.
 *
 * Storage namespaces this module owns: `packages/uploads/<uuid>/<seq>` (the
 * chunk objects) beside blobs.ts's `packages/blobs/` + `packages/tmp/`.
 */

import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  orgMembers,
  packageBlobUploads,
  packageBlobs,
  packageFiles,
  packageProperties,
  packageVersions,
  packages,
  systemKeystore,
  users,
} from "../../db/schema";
import { KEYSTORE_SECRET_ROW } from "../actions/secrets";
import {
  MAX_PACKAGE_BLOB_BYTES,
  PackageBlobTooLargeError,
  PackageSizeMismatchError,
  copySpoolToContentKey,
  getOrInsertBlob,
  packageBlobContentKey,
  spoolAndHash,
  type PackageBlobRow,
  type SpooledBlob,
} from "./blobs";
import {
  PropertyType,
  QuotaTotalCountError,
  countVersions,
  deletePackageFile,
  deletePackageVersionAndReferences,
  getOrInsertPackage,
  checkSizeQuotaExceeded,
  tryInsertFile,
  type PackageDoer,
  type PackagesQuotaConfig,
} from "./model";
import { isValidAbsoluteHttpUrl } from "./protocol-common";

// ---------------------------------------------------------------------------
// Constants (modules/packages/container/const.go + metadata.go:20-35 +
// container.go:40-51)
// ---------------------------------------------------------------------------

/** manifest.go:42 — the OCI pushing-manifests cap. */
export const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

/** metadata.go:88 — the image-config parse cap (ParseImageConfig's reader). */
const MAX_IMAGE_CONFIG_BYTES = 8 * 1024 * 1024;

/** const.go — the internal staging version the pushed blobs attach to. */
export const CONTAINER_UPLOAD_VERSION = "_upload";

/** const.go — the manifest file's name inside a version. */
export const CONTAINER_MANIFEST_FILENAME = "manifest.json";

/** metadata.go:21-25 — the property names. */
export const CONTAINER_PROPERTY_REPOSITORY = "container.repository";
export const CONTAINER_PROPERTY_DIGEST = "container.digest";
export const CONTAINER_PROPERTY_MEDIA_TYPE = "container.mediatype";
export const CONTAINER_PROPERTY_MANIFEST_TAGGED = "container.manifest.tagged";
export const CONTAINER_PROPERTY_MANIFEST_REFERENCE = "container.manifest.reference";

/** helm.go:8 (modules/packages/container/helm) — the helm config dispatch. */
const HELM_CONFIG_MEDIA_TYPE = "application/vnd.cncf.helm.config.v1+json";

/** container.go:48 — the image-name grammar (lowercase only). */
const IMAGE_NAME_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/;

/** container.go:49 — the tag-reference grammar (128 chars max). */
const REFERENCE_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

/** go-digest.Validate — the registered algorithms' exact hex lengths. */
const DIGEST_PATTERN = /^(?:sha256:[a-f0-9]{64}|sha384:[a-f0-9]{96}|sha512:[a-f0-9]{128})$/;

/** metadata.go:76-78 — the media-type validity gate. */
export function isContainerMediaTypeValid(mediaType: string): boolean {
  return mediaType.startsWith("application/vnd.docker.") || mediaType.startsWith("application/vnd.oci.");
}

/** metadata.go:80-82. */
export function isImageManifestMediaType(mediaType: string): boolean {
  const lowered = mediaType.toLowerCase();
  return lowered === "application/vnd.oci.image.manifest.v1+json" || lowered === "application/vnd.docker.distribution.manifest.v2+json";
}

/** metadata.go:84-86. */
export function isImageIndexMediaType(mediaType: string): boolean {
  const lowered = mediaType.toLowerCase();
  return lowered === "application/vnd.oci.image.index.v1+json" || lowered === "application/vnd.docker.distribution.manifest.list.v2+json";
}

/** container.go:141 — the VerifyImageName gate. */
export function isValidImageName(image: string): boolean {
  return IMAGE_NAME_PATTERN.test(image);
}

/** go-digest — the digest grammar (blob GET/HEAD/DELETE, digest references). */
export function isValidDigest(digest: string): boolean {
  return DIGEST_PATTERN.test(digest);
}

/** container.go:567 — the tag-reference gate. */
export function isValidReference(reference: string): boolean {
  return REFERENCE_PATTERN.test(reference);
}

// ---------------------------------------------------------------------------
// The OCI named errors (errors.go) — code + status + optional message; the
// wire shape `{"errors":[{"code","message"}]}` the route renders
// ---------------------------------------------------------------------------

export class OciNamedError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message = "",
  ) {
    super(message);
    this.name = "OciNamedError";
  }

  withMessage(message: string): OciNamedError {
    return new OciNamedError(this.code, this.statusCode, message);
  }

  withStatusCode(statusCode: number): OciNamedError {
    return new OciNamedError(this.code, statusCode, this.message);
  }
}

/** The errors.go table (:12-23). */
export const OCI_BLOB_UNKNOWN = new OciNamedError("BLOB_UNKNOWN", 404);
export const OCI_BLOB_UPLOAD_INVALID = new OciNamedError("BLOB_UPLOAD_INVALID", 400);
export const OCI_BLOB_UPLOAD_UNKNOWN = new OciNamedError("BLOB_UPLOAD_UNKNOWN", 404);
export const OCI_DIGEST_INVALID = new OciNamedError("DIGEST_INVALID", 400);
export const OCI_MANIFEST_BLOB_UNKNOWN = new OciNamedError("MANIFEST_BLOB_UNKNOWN", 404);
export const OCI_MANIFEST_INVALID = new OciNamedError("MANIFEST_INVALID", 400);
export const OCI_MANIFEST_UNKNOWN = new OciNamedError("MANIFEST_UNKNOWN", 404);
export const OCI_NAME_INVALID = new OciNamedError("NAME_INVALID", 400);
export const OCI_NAME_UNKNOWN = new OciNamedError("NAME_UNKNOWN", 404);
export const OCI_SIZE_INVALID = new OciNamedError("SIZE_INVALID", 400);
export const OCI_UNAUTHORIZED = new OciNamedError("UNAUTHORIZED", 401);
export const OCI_UNSUPPORTED = new OciNamedError("UNSUPPORTED", 501);

// ---------------------------------------------------------------------------
// The authorization token (services/packages/auth.go) — HS256 off the shared
// general signing secret; claims {exp(+24h), nbf, UserID, Scope}. The
// ActionsUserTaskID claim has no carrier here (no actions-runner pushes our
// container registry) and is dropped, as upstream's zero value is.
// ---------------------------------------------------------------------------

const PACKAGE_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export interface ContainerTokenClaims {
  userId: number;
  scope: string;
}

/** Upstream GhostUserID (models/user/user_system.go:12) — the anonymous pull
 *  identity. A claims userId of -1 resolves to the ghost marker, NOT to a
 *  users row. */
export const CONTAINER_GHOST_USER_ID = -1;

let signingSecretCacheD1: D1Database | null = null;
let signingSecretCache: Promise<string> | null = null;

/**
 * The general token signing secret (GetGeneralTokenSigningSecret's role). The
 * row is SHARED with the actions keystore (services/actions/secrets.ts — the
 * app.ini [oauth2] JWT_SECRET role); this reader deliberately does NOT go
 * through loadKeystore (whose cold path RSA-generates the OIDC piece) — it
 * reads the secret row and, when missing, performs the SAME
 * generate-once-save-back the actions module performs (insert-on-conflict-
 * do-nothing + read-back; a concurrent cold load adopts the winner's
 * material). Cached per isolate — the actions module's posture. Tests reset
 * via resetContainerTokenCacheForTests.
 */
async function loadSigningSecret(d1: D1Database): Promise<string> {
  if (signingSecretCacheD1 === d1 && signingSecretCache !== null) {
    return signingSecretCache;
  }
  const promise = (async (): Promise<string> => {
    const db = drizzle(d1);
    const readPiece = (value: string): string => {
      const parsed = JSON.parse(value) as { tokenSigningSecret?: unknown };
      if (typeof parsed.tokenSigningSecret === "string" && parsed.tokenSigningSecret !== "") {
        return parsed.tokenSigningSecret;
      }
      throw new Error("container: keystore secret row is malformed");
    };
    const row = await db.select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_SECRET_ROW)).get();
    if (row !== undefined) {
      return readPiece(row.value);
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let secretHex = "";
    for (const b of bytes) secretHex += b.toString(16).padStart(2, "0");
    const now = new Date();
    await db
      .insert(systemKeystore)
      .values({ name: KEYSTORE_SECRET_ROW, value: JSON.stringify({ v: 1, tokenSigningSecret: secretHex }), createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    const winner = await db.select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_SECRET_ROW)).get();
    if (winner === undefined) {
      throw new Error("container: keystore secret row missing after insert (D1 write failed?)");
    }
    return readPiece(winner.value);
  })();
  signingSecretCacheD1 = d1;
  signingSecretCache = promise;
  promise.catch(() => {
    if (signingSecretCacheD1 === d1) {
      signingSecretCacheD1 = null;
      signingSecretCache = null;
    }
  });
  return promise;
}

/**
 * TEST-ONLY: drop the module-level signing-secret cache (an isolate restart).
 */
export function resetContainerTokenCacheForTests(): void {
  signingSecretCacheD1 = null;
  signingSecretCache = null;
}

async function hmacKey(d1: D1Database): Promise<CryptoKey> {
  const secretHex = await loadSigningSecret(d1);
  const bytes = new Uint8Array(secretHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(secretHex.slice(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** CreateAuthorizationToken (auth.go:30-55): exp = now + 24 h, nbf = now. */
export async function mintContainerToken(d1: D1Database, userId: number, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        exp: now + PACKAGE_TOKEN_TTL_SECONDS,
        nbf: now,
        UserID: userId,
        Scope: scope,
      }),
    ),
  );
  const key = await hmacKey(d1);
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/**
 * ParseAuthorizationToken (auth.go:73-89): verify the HS256 signature, the
 * expiry and the not-before (golang-jwt v5 defaults — no leeway), then answer
 * the claims. ANY failure answers null (the route maps it to the 401
 * handshake, upstream afterAuthCallback → APIUnauthorizedError).
 */
export async function verifyContainerToken(d1: D1Database, token: string): Promise<ContainerTokenClaims | null> {
  const parts = token.split(".");
  const [header, body, sig] = parts;
  if (parts.length !== 3 || header === undefined || body === undefined || sig === undefined) {
    return null;
  }
  let alg: unknown;
  try {
    alg = (JSON.parse(new TextDecoder().decode(base64UrlDecode(header))) as { alg?: unknown }).alg;
  } catch {
    return null;
  }
  if (alg !== "HS256") {
    return null;
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64UrlDecode(sig);
  } catch {
    return null;
  }
  const key = await hmacKey(d1);
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(`${header}.${body}`));
  } catch {
    return null;
  }
  if (!ok) {
    return null;
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as Record<string, unknown>;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) {
    return null;
  }
  if (typeof claims.nbf !== "number" || claims.nbf > now) {
    return null;
  }
  const userId = claims.UserID;
  if (typeof userId !== "number" || !Number.isInteger(userId)) {
    return null;
  }
  return { userId, scope: typeof claims.Scope === "string" ? claims.Scope : "" };
}

// ---------------------------------------------------------------------------
// The upload-session store (package_blob_upload.go + blob_uploader.go)
// ---------------------------------------------------------------------------

export type ContainerBlobUploadRow = typeof packageBlobUploads.$inferSelect;

const UPLOAD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UPLOAD_CHUNK_SEQ_RE = /^\d+$/;

/** The chunk-object key — format-gated BEFORE any R2 call (the LFS
 *  injection-proof rule). */
export function containerUploadChunkKey(uploadId: string, seq: number): string {
  if (!UPLOAD_UUID_RE.test(uploadId)) {
    throw new Error(`invalid package upload uuid: ${uploadId}`);
  }
  if (!UPLOAD_CHUNK_SEQ_RE.test(String(seq)) || seq < 1) {
    throw new Error(`invalid package upload chunk seq: ${seq}`);
  }
  return `packages/uploads/${uploadId}/${seq}`;
}

/** CreateBlobUpload (package_blob_upload.go:33-42) — the id is our random
 *  uuid (upstream CryptoRandomString(25); both opaque to clients). */
export async function createContainerBlobUpload(d1: D1Database, now = new Date()): Promise<ContainerBlobUploadRow> {
  const inserted = await drizzle(d1)
    .insert(packageBlobUploads)
    .values({ id: crypto.randomUUID(), bytesReceived: 0, chunkCount: 0, createdUnix: now, updatedUnix: now })
    .returning()
    .all();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("container: blob upload insert failed");
  }
  return row;
}

/** GetBlobUploadByID (:45-56) — null for the unknown-upload 404 arm. */
export async function getContainerBlobUpload(d1: D1Database, id: string): Promise<ContainerBlobUploadRow | null> {
  return (await drizzle(d1).select().from(packageBlobUploads).where(eq(packageBlobUploads.id, id)).get()) ?? null;
}

/**
 * BlobUploader.Append (blob_uploader.go:79-110) — one PATCH chunk. The body
 * spools through the bounded store into its OWN chunk object (the R2
 * append-file analog: one object per chunk, ordered by the row's
 * chunk_count); the D1 counters then advance ATOMICALLY under the
 * expected-chunk-count guard — the offset-mismatch race arm
 * (errOffsetMismatch, :88-90) — so a concurrent PATCH on one session loses
 * its guard and its object is rolled back. The per-chunk spool cap is the
 * module MAX_PACKAGE_BLOB_BYTES (upstream's temp file is unbounded — the
 * documented reduction; real clients' chunks are MiB-scale).
 */
export async function appendContainerUploadChunk(
  d1: D1Database,
  bucket: R2Bucket,
  uploadId: string,
  content: ReadableStream<Uint8Array>,
  declaredLength?: number,
  now = new Date(),
): Promise<{ bytesReceived: number; chunkCount: number; chunkSize: number }> {
  const current = await getContainerBlobUpload(d1, uploadId);
  if (current === null) {
    throw OCI_BLOB_UPLOAD_UNKNOWN;
  }
  const expectedSeq = current.chunkCount + 1;
  const chunkKey = containerUploadChunkKey(uploadId, expectedSeq);
  const spooled = await spoolAndHash({ bucket, content, declaredLength, spoolKey: chunkKey });
  const updated = await drizzle(d1)
    .update(packageBlobUploads)
    .set({
      bytesReceived: sql`${packageBlobUploads.bytesReceived} + ${spooled.size}`,
      chunkCount: expectedSeq,
      updatedUnix: now,
    })
    .where(and(eq(packageBlobUploads.id, uploadId), eq(packageBlobUploads.chunkCount, expectedSeq - 1)))
    .returning()
    .all();
  const row = updated[0];
  if (row === undefined) {
    // A concurrent PATCH advanced the row first — roll the object back and
    // answer the offset-mismatch arm (upstream 500; we answer the family's
    // BLOB_UPLOAD_INVALID, the OCI spec's own wording for a bad offset).
    await bucket.delete(chunkKey);
    throw OCI_BLOB_UPLOAD_INVALID.withMessage("offset mismatch between upload and model");
  }
  return { bytesReceived: row.bytesReceived, chunkCount: row.chunkCount, chunkSize: spooled.size };
}

/** RemoveBlobUploadByID (blob_uploader.go:131-142) — the row AND the chunk
 *  objects (upstream deletes the temp file; ours the chunk objects). */
export async function removeContainerBlobUpload(d1: D1Database, bucket: R2Bucket, id: string): Promise<void> {
  const row = await getContainerBlobUpload(d1, id);
  await drizzle(d1).delete(packageBlobUploads).where(eq(packageBlobUploads.id, id)).run();
  if (row === null) {
    return;
  }
  for (let seq = 1; seq <= row.chunkCount; seq++) {
    await bucket.delete(containerUploadChunkKey(id, seq));
  }
}

/** The chunks of a session as an ordered key list. */
function chunkKeys(uploadId: string, chunkCount: number): string[] {
  const keys: string[] = [];
  for (let seq = 1; seq <= chunkCount; seq++) {
    keys.push(containerUploadChunkKey(uploadId, seq));
  }
  return keys;
}

/** A ReadableStream concatenating the given R2 object bodies in order. */
function concatR2Bodies(bucket: R2Bucket, keys: string[]): ReadableStream<Uint8Array> {
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (reader === null) {
          const key = keys[index];
          if (key === undefined) {
            controller.close();
            return;
          }
          const object = await bucket.get(key);
          if (object === null) {
            throw new Error(`container: upload chunk object vanished: ${key}`);
          }
          reader = object.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader.releaseLock();
          reader = null;
          index += 1;
          continue;
        }
        controller.enqueue(value);
        return;
      }
    },
    cancel() {
      void reader?.cancel();
      reader = null;
    },
  });
}

// ---------------------------------------------------------------------------
// The blob-save path (blob.go:28-160) — shared by the single-POST arm and the
// PUT finalize
// ---------------------------------------------------------------------------

/** The owner slice the service reads (the routes pass the resolved row). */
export interface ContainerOwner {
  id: number;
  usernameLower: string;
  visibility: "public" | "limited" | "private";
  type: "user" | "org";
}

async function getOrCreateUploadVersion(d1: D1Database, owner: ContainerOwner, image: string, now = new Date()) {
  // blob.go:93-115 — the package row (name IS the lower name, upstream inserts
  // ToLower(image)) + the repository property on the created arm.
  const { row: pkg, created } = await getOrInsertPackage(d1, {
    ownerId: owner.id,
    type: "container",
    name: image.toLowerCase(),
    now,
  });
  if (created) {
    await insertProperty(d1, PropertyType.Package, pkg.id, CONTAINER_PROPERTY_REPOSITORY, `${owner.usernameLower}/${image.toLowerCase()}`);
  }
  // blob.go:117-131 — the INTERNAL _upload staging version.
  const lowerVersion = CONTAINER_UPLOAD_VERSION;
  const existing = await drizzle(d1)
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.lowerVersion, lowerVersion)))
    .get();
  if (existing !== undefined) {
    return { pkg, version: existing };
  }
  const inserted = await drizzle(d1)
    .insert(packageVersions)
    .values({
      packageId: pkg.id,
      creatorId: owner.id,
      version: CONTAINER_UPLOAD_VERSION,
      lowerVersion,
      isInternal: true,
      metadataJson: "null",
      createdUnix: now,
    })
    .onConflictDoNothing()
    .returning()
    .all();
  const version = inserted[0];
  if (version !== undefined) {
    return { pkg, version };
  }
  const winner = await drizzle(d1)
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.lowerVersion, lowerVersion)))
    .get();
  if (winner === undefined) {
    throw new Error("container: upload version insert raced and the identity lookup then missed");
  }
  return { pkg, version: winner };
}

/** createFileForBlob (blob.go:135-160) — the sha256_<hash> file with its
 *  digest property, on the given version. A duplicate (the same blob already
 *  staged — ANY duplicate, identical or not, upstream's TryInsertFile arm
 *  :146-149) is a no-op. */
async function createFileForBlob(d1: D1Database, versionId: number, blob: PackageBlobRow, now = new Date()): Promise<void> {
  const name = `sha256_${blob.hashSha256}`;
  const result = await tryInsertFile(d1, { versionId, blobId: blob.id, name, now });
  if (result.outcome === "conflict") {
    // Unreachable for content-addressed names (same name ⇒ same bytes);
    // treated like upstream's duplicate skip for safety.
    return;
  }
  await insertProperty(d1, PropertyType.File, result.row.id, CONTAINER_PROPERTY_DIGEST, `sha256:${blob.hashSha256}`);
}

/**
 * saveAsPackageBlob's tail (blob.go:38-68) shared by both save arms: quota →
 * dedup insert → the content key on the created arm → the staging file. The
 * caller owns the spool: `spool.spoolKey` is consumed here (copied to the
 * content key or deleted on the dedup hit).
 */
async function saveSpooledBlob(
  d1: D1Database,
  bucket: R2Bucket,
  owner: ContainerOwner,
  image: string,
  doer: PackageDoer,
  spool: SpooledBlob,
  quota: PackagesQuotaConfig,
  now = new Date(),
): Promise<PackageBlobRow> {
  // blob.go:49 — CheckSizeQuotaExceeded (the container type carries no
  // per-type entry, so the owner-total arm fires; admins bypass).
  await checkSizeQuotaExceeded(d1, doer.isAdmin, owner.id, "container", spool.size, quota);
  const { row: blob, created } = await getOrInsertBlob(d1, {
    size: spool.size,
    sha256: spool.sha256,
    sha1: spool.sha1,
    sha512: spool.sha512,
    now,
  });
  if (created) {
    await copySpoolToContentKey(bucket, spool.spoolKey, spool.sha256);
  } else {
    await bucket.delete(spool.spoolKey);
  }
  const { version } = await getOrCreateUploadVersion(d1, owner, image, now);
  await createFileForBlob(d1, version.id, blob, now);
  return blob;
}

/**
 * The single-POST arm (container.go:269-308, `POST …?digest=`): stream the
 * body through the bounded store, verify the digest (mismatch →
 * DIGEST_INVALID — upstream container.go:278-281), then the shared save tail.
 */
export async function saveContainerBlobFromStream(opts: {
  d1: D1Database;
  bucket: R2Bucket;
  owner: ContainerOwner;
  doer: PackageDoer;
  image: string;
  digest: string;
  content: ReadableStream<Uint8Array>;
  declaredLength?: number;
  quota: PackagesQuotaConfig;
  maxBytes?: number;
  now?: Date;
}): Promise<PackageBlobRow> {
  const now = opts.now ?? new Date();
  const spooled = await spoolAndHash({
    bucket: opts.bucket,
    content: opts.content,
    declaredLength: opts.declaredLength,
    maxBytes: opts.maxBytes ?? MAX_PACKAGE_BLOB_BYTES,
  });
  if (`sha256:${spooled.sha256}` !== opts.digest) {
    await opts.bucket.delete(spooled.spoolKey);
    throw OCI_DIGEST_INVALID;
  }
  return saveSpooledBlob(opts.d1, opts.bucket, opts.owner, opts.image, opts.doer, spooled, opts.quota, now);
}

/**
 * The PUT finalize (container.go:400-466): optional final body chunk, then
 * the digest verification over the WHOLE session — the chunks re-stream
 * through fresh digests (the documented HashStateBytes reduction) — then the
 * shared save tail and the session removal. The session SURVIVES a digest
 * mismatch and a quota 403 (upstream returns before RemoveBlobUploadByID,
 * :456) and is removed only on success.
 */
export async function finalizeContainerBlobUpload(opts: {
  d1: D1Database;
  bucket: R2Bucket;
  owner: ContainerOwner;
  doer: PackageDoer;
  image: string;
  upload: ContainerBlobUploadRow;
  digest: string;
  finalChunk?: { content: ReadableStream<Uint8Array>; declaredLength?: number };
  quota: PackagesQuotaConfig;
  now?: Date;
}): Promise<PackageBlobRow> {
  const now = opts.now ?? new Date();
  let session = opts.upload;
  if (opts.finalChunk !== undefined) {
    const appended = await appendContainerUploadChunk(
      opts.d1,
      opts.bucket,
      session.id,
      opts.finalChunk.content,
      opts.finalChunk.declaredLength,
      now,
    );
    session = { ...session, bytesReceived: appended.bytesReceived, chunkCount: appended.chunkCount };
  }

  // The finalize spool rides blobs.ts's packages/tmp/ namespace, keyed by the
  // session uuid (no collision: the session owns it).
  if (!UPLOAD_UUID_RE.test(session.id)) {
    throw new Error(`invalid package upload uuid: ${session.id}`);
  }
  const spoolKey = `packages/tmp/${session.id}`;
  let spooled: SpooledBlob;
  try {
    spooled = await spoolAndHash({
      bucket: opts.bucket,
      content: concatR2Bodies(opts.bucket, chunkKeys(session.id, session.chunkCount)),
      declaredLength: session.bytesReceived,
      spoolKey,
    });
  } catch (error) {
    await opts.bucket.delete(spoolKey).catch(() => undefined);
    if (error instanceof PackageSizeMismatchError) {
      // The D1 byte total disagrees with the stored chunks — upstream's
      // errOffsetMismatch (500).
      throw new Error("container: chunk/model offset mismatch", { cause: error });
    }
    throw error;
  }
  if (`sha256:${spooled.sha256}` !== opts.digest) {
    await opts.bucket.delete(spoolKey);
    throw OCI_DIGEST_INVALID;
  }
  try {
    const blob = await saveSpooledBlob(opts.d1, opts.bucket, opts.owner, opts.image, opts.doer, spooled, opts.quota, now);
    // container.go:456 — RemoveBlobUploadByID AFTER a successful save (the
    // session survives the digest/quota arms above).
    await removeContainerBlobUpload(opts.d1, opts.bucket, session.id);
    return blob;
  } finally {
    await opts.bucket.delete(spoolKey).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// The container-model searches (models/packages/container/search.go)
// ---------------------------------------------------------------------------

export class ContainerBlobNotExistError extends Error {
  constructor() {
    super("container blob does not exist");
    this.name = "ContainerBlobNotExistError";
  }
}

export interface ContainerBlobSearchOptions {
  ownerId?: number;
  image?: string;
  digest?: string;
  tag?: string;
  isManifest?: boolean;
  onlyLead?: boolean;
  repository?: string;
}

export interface ContainerBlobDescriptor {
  file: typeof packageFiles.$inferSelect;
  blob: PackageBlobRow;
}

/** search.go:32-72 — the shared WHERE builder (the property subqueries). */
function containerBlobConditions(d1: D1Database, opts: ContainerBlobSearchOptions) {
  const conditions = [eq(packages.type, "container")];
  if (opts.ownerId !== undefined) conditions.push(eq(packages.ownerId, opts.ownerId));
  if (opts.image !== undefined && opts.image !== "") conditions.push(eq(packages.lowerName, opts.image.toLowerCase()));
  if (opts.tag !== undefined && opts.tag !== "") conditions.push(eq(packageVersions.lowerVersion, opts.tag.toLowerCase()));
  if (opts.isManifest === true) conditions.push(eq(packageFiles.lowerName, CONTAINER_MANIFEST_FILENAME));
  if (opts.onlyLead === true) conditions.push(eq(packageFiles.isLead, true));
  if (opts.digest !== undefined && opts.digest !== "") {
    conditions.push(
      inArray(
        packageFiles.id,
        drizzle(d1)
          .select({ refId: packageProperties.refId })
          .from(packageProperties)
          .where(
            and(
              eq(packageProperties.refType, PropertyType.File),
              eq(packageProperties.name, CONTAINER_PROPERTY_DIGEST),
              eq(packageProperties.value, opts.digest),
            ),
          ),
      ),
    );
  }
  if (opts.repository !== undefined && opts.repository !== "") {
    conditions.push(
      inArray(
        packages.id,
        drizzle(d1)
          .select({ refId: packageProperties.refId })
          .from(packageProperties)
          .where(
            and(
              eq(packageProperties.refType, PropertyType.Package),
              eq(packageProperties.name, CONTAINER_PROPERTY_REPOSITORY),
              eq(packageProperties.value, opts.repository),
            ),
          ),
      ),
    );
  }
  return conditions;
}

function containerBlobQuery(d1: D1Database, opts: ContainerBlobSearchOptions) {
  return drizzle(d1)
    .select({ file: packageFiles, blob: packageBlobs })
    .from(packageFiles)
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
    .where(and(...containerBlobConditions(d1, opts)));
}

/** GetContainerBlob (search.go:76-84) — the first match. */
export async function getContainerBlob(d1: D1Database, opts: ContainerBlobSearchOptions): Promise<ContainerBlobDescriptor> {
  const rows = await containerBlobQuery(d1, opts).limit(1).all();
  const row = rows[0];
  if (row === undefined) {
    throw new ContainerBlobNotExistError();
  }
  return row;
}

/** GetContainerBlobs (search.go:87-89) — every match (the delete arm). */
export async function getContainerBlobs(d1: D1Database, opts: ContainerBlobSearchOptions): Promise<ContainerBlobDescriptor[]> {
  return containerBlobQuery(d1, opts).all();
}

/** GetManifestVersions (search.go:110-119) — the non-internal versions whose
 *  files match the search (the manifest-delete arm walks these). */
export async function getContainerManifestVersions(
  d1: D1Database,
  opts: ContainerBlobSearchOptions,
): Promise<(typeof packageVersions.$inferSelect)[]> {
  const rows = await drizzle(d1)
    .select({ version: packageVersions })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .innerJoin(packageFiles, eq(packageFiles.versionId, packageVersions.id))
    .where(and(...containerBlobConditions(d1, opts), eq(packageVersions.isInternal, false)))
    .all();
  return rows.map((row) => row.version);
}

/** GetImageTags (search.go:123-164) — the sorted tag list (the versions
 *  carrying a ManifestTagged property), `lower_version > last` pagination. */
export async function getContainerImageTags(
  d1: D1Database,
  ownerId: number,
  image: string,
  n: number,
  last: string,
): Promise<string[]> {
  if (n === 0) {
    return [];
  }
  const conditions = [
    eq(packages.type, "container"),
    eq(packages.ownerId, ownerId),
    eq(packages.lowerName, image.toLowerCase()),
    eq(packageVersions.isInternal, false),
    inArray(
      packageVersions.id,
      drizzle(d1)
        .select({ refId: packageProperties.refId })
        .from(packageProperties)
        .where(and(eq(packageProperties.refType, PropertyType.Version), eq(packageProperties.name, CONTAINER_PROPERTY_MANIFEST_TAGGED))),
    ),
  ];
  if (last !== "") {
    conditions.push(gt(packageVersions.lowerVersion, last.toLowerCase()));
  }
  // n <= 0 → no LIMIT (upstream's -1 default); SQLite's LIMIT -1 is unbounded.
  const rows = await drizzle(d1)
    .select({ lowerVersion: packageVersions.lowerVersion })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(and(...conditions))
    .orderBy(asc(packageVersions.lowerVersion))
    .limit(n > 0 ? n : -1)
    .all();
  return rows.map((row) => row.lowerVersion);
}

/**
 * GetRepositories (search.go:252-287) — the catalog: the repository-property
 * values of container packages with at least one non-internal version, the
 * owner filtered by the viewer's visibility ladder (BuildCanSeeUserCondition:
 * anonymous/ghost → public owners only; authenticated → public + limited +
 * own + org memberships; admin → all; our substrate has no restricted-user
 * column — the ladder folds that arm away), `value > last` pagination.
 */
export async function listContainerRepositories(
  d1: D1Database,
  viewer: { id: number; isAdmin: boolean } | null,
  n: number,
  last: string,
): Promise<string[]> {
  const conditions = [
    eq(packages.type, "container"),
    eq(packageProperties.refType, PropertyType.Package),
    eq(packageProperties.name, CONTAINER_PROPERTY_REPOSITORY),
    inArray(
      packages.id,
      drizzle(d1)
        .select({ packageId: packageVersions.packageId })
        .from(packageVersions)
        .where(eq(packageVersions.isInternal, false)),
    ),
  ];
  if (last !== "") {
    conditions.push(gt(packageProperties.value, last.toLowerCase()));
  }
  if (viewer === null) {
    conditions.push(eq(users.visibility, "public"));
  } else if (!viewer.isAdmin) {
    conditions.push(
      sql`(${users.visibility} IN ('public', 'limited') OR ${users.id} = ${viewer.id} OR (${users.type} = 'org' AND EXISTS (SELECT 1 FROM ${orgMembers} WHERE ${orgMembers.orgId} = ${users.id} AND ${orgMembers.userId} = ${viewer.id})))`,
    );
  }
  const rows = await drizzle(d1)
    .select({ value: packageProperties.value })
    .from(packageProperties)
    .innerJoin(packages, eq(packages.id, packageProperties.refId))
    .innerJoin(users, eq(users.id, packages.ownerId))
    .where(and(...conditions))
    .orderBy(asc(packageProperties.value))
    .limit(n)
    .all();
  return rows.map((row) => row.value);
}

/** getExistingContainerBlob's tail (container.go:781-796): the content store
 *  must agree with the row (an orphaned row with vanished bytes reads as
 *  not-exist). */
export async function containerBlobStoreSizeMatches(bucket: R2Bucket, blob: PackageBlobRow): Promise<boolean> {
  const head = await bucket.head(packageBlobContentKey(blob.hashSha256));
  return head !== null && head.size === blob.size;
}

/**
 * IsBlobAccessibleForUser (models/packages/package_blob.go:124-156) folded
 * onto the landed org model (the §4.1 precedent — upstream's team_unit
 * packages-unit query collapses into the landed teams row): the doer may
 * mount the cross-repo blob when the SOURCE package's owner is visible —
 * self / site admin / public / (authenticated, non-ghost) limited / org
 * membership. A ghost or anonymous doer sees public owners only (upstream's
 * ghost carries no user row into the query). Upstream's restricted-user arm
 * has no analog (no restricted column).
 */
export async function isContainerBlobAccessible(
  d1: D1Database,
  descriptor: ContainerBlobDescriptor,
  doer: { id: number; isAdmin: boolean } | null,
): Promise<boolean> {
  if (doer !== null && doer.isAdmin) {
    return true;
  }
  const source = await drizzle(d1)
    .select({ ownerId: packages.ownerId, visibility: users.visibility, type: users.type })
    .from(packageFiles)
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .innerJoin(users, eq(users.id, packages.ownerId))
    .where(eq(packageFiles.id, descriptor.file.id))
    .get();
  if (source === undefined) {
    return false;
  }
  if (doer === null) {
    return source.visibility === "public";
  }
  if (doer.id === source.ownerId) {
    return true;
  }
  if (source.visibility === "public" || source.visibility === "limited") {
    return true;
  }
  if (source.type === "org") {
    const membership = await drizzle(d1)
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, source.ownerId), eq(orgMembers.userId, doer.id)))
      .get();
    return membership !== undefined;
  }
  return false;
}

/** mountBlob (blob.go:71-80) — the cross-repo mount: the blob gains a file
 *  row on the TARGET image's staging version (the search's digest property
 *  then finds it under both images). */
export async function mountContainerBlob(
  d1: D1Database,
  owner: ContainerOwner,
  image: string,
  blob: PackageBlobRow,
  now = new Date(),
): Promise<void> {
  const { version } = await getOrCreateUploadVersion(d1, owner, image, now);
  await createFileForBlob(d1, version.id, blob, now);
}

// ---------------------------------------------------------------------------
// Properties (models/packages/package_property.go — the write shapes the
// container flow needs)
// ---------------------------------------------------------------------------

export async function insertProperty(
  d1: D1Database,
  refType: number,
  refId: number,
  name: string,
  value: string,
): Promise<void> {
  await drizzle(d1).insert(packageProperties).values({ refType, refId, name, value }).run();
}

/** InsertOrUpdateProperty (package_property.go:70-81) — select, update on
 *  hit, insert on miss (NO unique arbitrates this pair upstream). */
export async function insertOrUpdateProperty(
  d1: D1Database,
  refType: number,
  refId: number,
  name: string,
  value: string,
): Promise<void> {
  const db = drizzle(d1);
  const existing = await db
    .select({ id: packageProperties.id })
    .from(packageProperties)
    .where(and(eq(packageProperties.refType, refType), eq(packageProperties.refId, refId), eq(packageProperties.name, name)))
    .get();
  if (existing !== undefined) {
    await db.update(packageProperties).set({ value }).where(eq(packageProperties.id, existing.id)).run();
    return;
  }
  await insertProperty(d1, refType, refId, name, value);
}

/** DeletePropertiesByName (package_property.go) — one (ref-type, ref-id, name). */
export async function deletePropertiesByName(
  d1: D1Database,
  refType: number,
  refId: number,
  name: string,
): Promise<void> {
  await drizzle(d1)
    .delete(packageProperties)
    .where(and(eq(packageProperties.refType, refType), eq(packageProperties.refId, refId), eq(packageProperties.name, name)))
    .run();
}

// ---------------------------------------------------------------------------
// Deletes (blob.go:162-186 + the manifest-delete walk)
// ---------------------------------------------------------------------------

/** deleteBlob (blob.go:162-186) — every file carrying the digest loses its
 *  row (the unreferenced-sweep owns the R2 key, ratification 4). */
export async function deleteContainerBlob(d1: D1Database, ownerId: number, image: string, digest: string): Promise<void> {
  const descriptors = await getContainerBlobs(d1, { ownerId, image, digest });
  for (const descriptor of descriptors) {
    await deletePackageFile(d1, descriptor.file.id);
  }
}

// ---------------------------------------------------------------------------
// The manifest flows (manifest.go)
// ---------------------------------------------------------------------------

/** metadata.go:55-74 — the Metadata payload (the JSON key order below is the
 *  struct's declaration order; Go maps render sorted — both pinned). */
export interface ContainerMetadata {
  type: "oci" | "helm";
  isTagged: boolean;
  platform?: string;
  description?: string;
  authors?: string[];
  license?: string;
  projectUrl?: string;
  repositoryUrl?: string;
  documentationUrl?: string;
  labels?: Record<string, string>;
  imageLayers?: string[];
  manifests?: { platform: string; digest: string; size: number }[];
}

/** The Go struct's marshal: declaration order, omitempty, sorted label keys. */
export function serializeContainerMetadata(metadata: ContainerMetadata): string {
  const parts: string[] = [];
  parts.push(`"type":${JSON.stringify(metadata.type)}`);
  parts.push(`"is_tagged":${metadata.isTagged ? "true" : "false"}`);
  if (metadata.platform !== undefined && metadata.platform !== "") {
    parts.push(`"platform":${JSON.stringify(metadata.platform)}`);
  }
  if (metadata.description !== undefined && metadata.description !== "") {
    parts.push(`"description":${JSON.stringify(metadata.description)}`);
  }
  if (metadata.authors !== undefined && metadata.authors.length > 0) {
    parts.push(`"authors":${JSON.stringify(metadata.authors)}`);
  }
  if (metadata.license !== undefined && metadata.license !== "") {
    parts.push(`"license":${JSON.stringify(metadata.license)}`);
  }
  if (metadata.projectUrl !== undefined && metadata.projectUrl !== "") {
    parts.push(`"project_url":${JSON.stringify(metadata.projectUrl)}`);
  }
  if (metadata.repositoryUrl !== undefined && metadata.repositoryUrl !== "") {
    parts.push(`"repository_url":${JSON.stringify(metadata.repositoryUrl)}`);
  }
  if (metadata.documentationUrl !== undefined && metadata.documentationUrl !== "") {
    parts.push(`"documentation_url":${JSON.stringify(metadata.documentationUrl)}`);
  }
  if (metadata.labels !== undefined && Object.keys(metadata.labels).length > 0) {
    const entries = Object.keys(metadata.labels)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${JSON.stringify(metadata.labels?.[key] ?? "")}`);
    parts.push(`"labels":{${entries.join(",")}}`);
  }
  if (metadata.imageLayers !== undefined && metadata.imageLayers.length > 0) {
    parts.push(`"layer_creation":${JSON.stringify(metadata.imageLayers)}`);
  }
  if (metadata.manifests !== undefined && metadata.manifests.length > 0) {
    const entries = metadata.manifests.map(
      (manifest) => `{"platform":${JSON.stringify(manifest.platform)},"digest":${JSON.stringify(manifest.digest)},"size":${manifest.size}}`,
    );
    parts.push(`"manifests":[${entries.join(",")}]`);
  }
  return `{${parts.join(",")}}`;
}

/** The narrow OCI image-config shape ParseImageConfig consumes. */
interface OciImageConfig {
  os?: unknown;
  architecture?: unknown;
  variant?: unknown;
  history?: unknown;
  config?: { labels?: unknown };
}

/** metadata.go:91-163 — ParseImageConfig. The helm-config arm dispatches on
 *  the config media type; the OCI fallback carries the unknown-platform arm
 *  for a config that does not parse (only when the manifest media type is
 *  NOT an image manifest — otherwise the parse error propagates, upstream's
 *  500). */
export function parseContainerImageConfig(mediaType: string, configText: string): ContainerMetadata {
  if (mediaType.toLowerCase() === HELM_CONFIG_MEDIA_TYPE) {
    return parseHelmImageConfig(configText);
  }
  let image: OciImageConfig;
  try {
    image = JSON.parse(configText) as OciImageConfig;
  } catch {
    if (!isImageManifestMediaType(mediaType)) {
      return { type: "oci", isTagged: false, platform: "unknown/unknown" };
    }
    throw new Error("container: image config parse failed");
  }
  const os = typeof image.os === "string" ? image.os : "";
  const architecture = typeof image.architecture === "string" ? image.architecture : "";
  const variant = typeof image.variant === "string" ? image.variant : "";
  let platform = "linux/amd64";
  if (os !== "" && architecture !== "") {
    platform = variant === "" ? `${os}/${architecture}` : `${os}/${architecture}/${variant}`;
  }
  const labels: Record<string, string> = {};
  const rawLabels = image.config?.labels;
  if (typeof rawLabels === "object" && rawLabels !== null) {
    for (const [key, value] of Object.entries(rawLabels as Record<string, unknown>)) {
      if (typeof value === "string") {
        labels[key] = value;
      }
    }
  }
  const imageLayers: string[] = [];
  if (Array.isArray(image.history)) {
    for (const entry of image.history) {
      const createdBy = typeof (entry as { created_by?: unknown })?.created_by === "string" ? (entry as { created_by: string }).created_by : "";
      let cmd = createdBy;
      const nop = cmd.indexOf("#(nop) ");
      if (nop !== -1) {
        cmd = cmd.slice(nop + 7).trim();
      }
      if (cmd !== "") {
        imageLayers.push(cmd);
      }
    }
  }
  const urlOrEmpty = (value: string): string => (isValidAbsoluteHttpUrl(value) ? value : "");
  const metadata: ContainerMetadata = {
    type: "oci",
    isTagged: false,
    platform,
    license: labels["org.opencontainers.image.licenses"] ?? "",
    projectUrl: urlOrEmpty(labels["org.opencontainers.image.url"] ?? ""),
    repositoryUrl: urlOrEmpty(labels["org.opencontainers.image.source"] ?? ""),
    documentationUrl: urlOrEmpty(labels["org.opencontainers.image.documentation"] ?? ""),
    description: labels["org.opencontainers.image.description"] ?? "",
    labels,
    imageLayers,
  };
  if (typeof labels["org.opencontainers.image.authors"] === "string") {
    metadata.authors = [labels["org.opencontainers.image.authors"]];
  }
  return metadata;
}

/** metadata.go:165-193 — parseHelmConfig. */
function parseHelmImageConfig(configText: string): ContainerMetadata {
  let config: { description?: unknown; home?: unknown; maintainers?: unknown; sources?: unknown };
  try {
    config = JSON.parse(configText) as typeof config;
  } catch {
    throw new Error("container: helm chart config parse failed");
  }
  const metadata: ContainerMetadata = {
    type: "helm",
    isTagged: false,
    description: typeof config.description === "string" ? config.description : "",
    projectUrl: typeof config.home === "string" ? config.home : "",
  };
  if (!isValidAbsoluteHttpUrl(metadata.projectUrl ?? "")) {
    metadata.projectUrl = "";
  }
  if (Array.isArray(config.maintainers)) {
    const authors: string[] = [];
    for (const maintainer of config.maintainers) {
      const name = typeof (maintainer as { name?: unknown })?.name === "string" ? (maintainer as { name: string }).name : "";
      if (name !== "") {
        authors.push(name);
      }
    }
    if (authors.length > 0) {
      metadata.authors = authors;
    }
  }
  if (Array.isArray(config.sources) && config.sources.length > 0) {
    const source: unknown = config.sources[0];
    if (typeof source === "string" && isValidAbsoluteHttpUrl(source)) {
      metadata.repositoryUrl = source;
    }
  }
  return metadata;
}

export interface PutContainerManifestResult {
  digest: string;
}

/** The narrow manifest-document shapes the flows consume. */
interface OciManifestDocument {
  config?: { mediaType?: unknown; digest?: unknown; size?: unknown };
  layers?: unknown;
  manifests?: unknown;
}

interface OciIndexDocument {
  manifests?: unknown;
}

/** The blobReference of manifest.go:322-329 — `file` is null for the
 *  manifest's own blob (upstream File: &PackageFileDescriptor{Blob: pb},
 *  the File half nil → the move arm skips). */
interface BlobReference {
  digest: string;
  mediaType: string;
  name: string | null;
  blob: PackageBlobRow;
  file: (typeof packageFiles.$inferSelect) | null;
  expectedSize: number;
  isLead: boolean;
}

/**
 * PutManifest (container.go:555-606) + processManifest (manifest.go:41-73).
 * The body spools through the bounded store under the manifest cap
 * (maxManifestSize + 1; over-cap → MANIFEST_INVALID 413, container.go:580-583),
 * parses once from the spool, then routes to the image-manifest or image-index
 * flow by the RESOLVED media type (header first, document second).
 */
export async function putContainerManifest(opts: {
  d1: D1Database;
  bucket: R2Bucket;
  owner: ContainerOwner;
  doer: PackageDoer;
  image: string;
  reference: string;
  contentType: string;
  content: ReadableStream<Uint8Array>;
  declaredLength?: number;
  quota: PackagesQuotaConfig;
  now?: Date;
}): Promise<PutContainerManifestResult> {
  const now = opts.now ?? new Date();
  const isTagged = !isValidDigest(opts.reference);
  if (isTagged && !isValidReference(opts.reference)) {
    throw OCI_MANIFEST_INVALID.withMessage("Tag is invalid");
  }

  const spoolKey = `packages/tmp/${crypto.randomUUID()}`;
  let spooled: SpooledBlob;
  try {
    spooled = await spoolAndHash({
      bucket: opts.bucket,
      content: opts.content,
      declaredLength: opts.declaredLength,
      maxBytes: MAX_MANIFEST_BYTES + 1,
      spoolKey,
    });
  } catch (error) {
    if (error instanceof PackageBlobTooLargeError) {
      await opts.bucket.delete(spoolKey).catch(() => undefined);
      throw OCI_MANIFEST_INVALID.withMessage("Manifest exceeds maximum size").withStatusCode(413);
    }
    throw error;
  }
  if (spooled.size > MAX_MANIFEST_BYTES) {
    await opts.bucket.delete(spoolKey);
    throw OCI_MANIFEST_INVALID.withMessage("Manifest exceeds maximum size").withStatusCode(413);
  }

  try {
    const spooledObject = await opts.bucket.get(spoolKey);
    if (spooledObject === null) {
      throw new Error(`container: manifest spool object vanished: ${spoolKey}`);
    }
    const documentText = await spooledObject.text();
    let document: { schemaVersion?: unknown; mediaType?: unknown };
    try {
      document = JSON.parse(documentText) as typeof document;
    } catch {
      // upstream: the json.Decode error propagates → apiError 500.
      throw new Error("container: manifest JSON parse failed");
    }
    if (document.schemaVersion !== 2) {
      throw OCI_UNSUPPORTED.withMessage("Schema version is not supported");
    }

    let mediaType = opts.contentType;
    if (!isContainerMediaTypeValid(mediaType)) {
      mediaType = typeof document.mediaType === "string" ? document.mediaType : "";
      if (!isContainerMediaTypeValid(mediaType)) {
        throw OCI_MANIFEST_INVALID.withMessage("MediaType not recognized");
      }
    }

    if (isImageManifestMediaType(mediaType)) {
      return await processOciImageManifest(opts, documentText, spooled, mediaType, isTagged, now);
    }
    if (isImageIndexMediaType(mediaType)) {
      return await processOciImageIndex(opts, documentText, spooled, mediaType, isTagged, now);
    }
    throw OCI_MANIFEST_INVALID;
  } finally {
    await opts.bucket.delete(spoolKey).catch(() => undefined);
  }
}

/** createFileFromBlobReference (manifest.go:331-377). */
async function createFileFromBlobReference(
  d1: D1Database,
  versionId: number,
  uploadVersionId: number | null,
  ref: BlobReference,
  now: Date,
): Promise<void> {
  if (ref.blob.size !== ref.expectedSize) {
    throw OCI_SIZE_INVALID;
  }
  const name = ref.name ?? `sha256_${ref.blob.hashSha256}`;
  const result = await tryInsertFile(d1, {
    versionId,
    blobId: ref.blob.id,
    name,
    compositeKey: ref.digest,
    isLead: ref.isLead,
    now,
  });
  if (result.outcome === "conflict") {
    throw new Error("container: manifest file insert conflicted with different bytes");
  }
  if (result.outcome === "created") {
    await insertProperty(d1, PropertyType.File, result.row.id, CONTAINER_PROPERTY_MEDIA_TYPE, ref.mediaType);
    await insertProperty(d1, PropertyType.File, result.row.id, CONTAINER_PROPERTY_DIGEST, ref.digest);
  }
  // manifest.go:369-374 — move semantics: a blob staged on the _upload
  // version relocates to the manifest version (the manifest's own blob has
  // file === null and skips).
  if (ref.file !== null && uploadVersionId !== null && ref.file.versionId === uploadVersionId) {
    await deletePackageFile(d1, ref.file.id);
  }
}

/** createPackageAndVersion (manifest.go:231-320): the package row (+ the
 *  repository property on create), the reference version with the
 *  DELETE-AND-RECREATE overwrite arm (download count kept), the count quota,
 *  and the tagged/reference properties. */
async function createPackageAndVersion(
  d1: D1Database,
  owner: ContainerOwner,
  doer: PackageDoer,
  image: string,
  reference: string,
  isTagged: boolean,
  metadata: ContainerMetadata,
  quota: PackagesQuotaConfig,
  now: Date,
): Promise<{ pkgId: number; versionId: number }> {
  const imageLower = image.toLowerCase();
  const { row: pkg, created } = await getOrInsertPackage(d1, {
    ownerId: owner.id,
    type: "container",
    name: imageLower,
    now,
  });
  if (created) {
    await insertProperty(d1, PropertyType.Package, pkg.id, CONTAINER_PROPERTY_REPOSITORY, `${owner.usernameLower}/${imageLower}`);
  }

  metadata.isTagged = isTagged;
  const metadataJson = serializeContainerMetadata(metadata);

  const lowerReference = reference.toLowerCase();
  const insertVersion = async (downloadCount: number): Promise<(typeof packageVersions.$inferSelect)[]> =>
    drizzle(d1)
      .insert(packageVersions)
      .values({
        packageId: pkg.id,
        creatorId: doer.id,
        version: lowerReference,
        lowerVersion: lowerReference,
        isInternal: false,
        metadataJson,
        downloadCount,
        createdUnix: now,
      })
      .onConflictDoNothing()
      .returning()
      .all();

  let version = (await insertVersion(0))[0];
  if (version === undefined) {
    // The overwrite arm (manifest.go:277-294): the existing version is
    // DELETED with all its references and recreated, keeping the download
    // count. No global lock exists on our substrate — the D1 UNIQUE
    // arbitrates (SPEC-0016 §4.3's posture); a concurrent same-tag publish
    // converges on the recreated row.
    const existing = await drizzle(d1)
      .select()
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.lowerVersion, lowerReference)))
      .get();
    if (existing === undefined) {
      throw new Error("container: version insert raced and the identity lookup then missed");
    }
    await deletePackageVersionAndReferences(d1, existing.id);
    version = (await insertVersion(existing.downloadCount))[0];
    if (version === undefined) {
      throw new Error("container: version re-insert raced and lost twice");
    }
  }

  // manifest.go:296-298 — CheckCountQuotaExceeded (packages.go:366-385).
  if (!doer.isAdmin && quota.limitTotalOwnerCount > -1) {
    const totalCount = await countVersions(d1, owner.id);
    if (totalCount > quota.limitTotalOwnerCount) {
      throw new QuotaTotalCountError();
    }
  }

  if (isTagged) {
    await insertOrUpdateProperty(d1, PropertyType.Version, version.id, CONTAINER_PROPERTY_MANIFEST_TAGGED, "");
  } else {
    await deletePropertiesByName(d1, PropertyType.Version, version.id, CONTAINER_PROPERTY_MANIFEST_TAGGED);
  }
  await deletePropertiesByName(d1, PropertyType.Version, version.id, CONTAINER_PROPERTY_MANIFEST_REFERENCE);
  for (const manifest of metadata.manifests ?? []) {
    await insertProperty(d1, PropertyType.Version, version.id, CONTAINER_PROPERTY_MANIFEST_REFERENCE, manifest.digest);
  }
  return { pkgId: pkg.id, versionId: version.id };
}

/** createManifestBlob (manifest.go:379-416): the manifest document becomes a
 *  blob (dedup + content key), gains the lead manifest.json file (composite =
 *  its digest), and older lead files of the version are demoted. */
async function createManifestBlob(
  d1: D1Database,
  bucket: R2Bucket,
  versionId: number,
  uploadVersionId: number | null,
  mediaType: string,
  spooled: SpooledBlob,
  now: Date,
): Promise<string> {
  const { row: blob, created } = await getOrInsertBlob(d1, {
    size: spooled.size,
    sha256: spooled.sha256,
    sha1: spooled.sha1,
    sha512: spooled.sha512,
    now,
  });
  if (created) {
    await copySpoolToContentKey(bucket, spooled.spoolKey, spooled.sha256);
  } else {
    await bucket.delete(spooled.spoolKey);
  }
  const manifestDigest = `sha256:${spooled.sha256}`;
  await createFileFromBlobReference(
    d1,
    versionId,
    uploadVersionId,
    {
      digest: manifestDigest,
      mediaType,
      name: CONTAINER_MANIFEST_FILENAME,
      blob,
      file: null,
      expectedSize: blob.size,
      isLead: true,
    },
    now,
  );
  // manifest.go:398-414 — demote every OTHER lead manifest.json of the version
  // (the fresh insert is identifiable by its composite key + recency; upstream
  // re-searches and demotes by id).
  const oldLeads = await drizzle(d1)
    .select({ id: packageFiles.id })
    .from(packageFiles)
    .where(and(eq(packageFiles.versionId, versionId), eq(packageFiles.lowerName, CONTAINER_MANIFEST_FILENAME), eq(packageFiles.isLead, true)))
    .all();
  for (const oldLead of oldLeads) {
    const stillLead = await drizzle(d1)
      .select({ id: packageFiles.id, compositeKey: packageFiles.compositeKey })
      .from(packageFiles)
      .where(eq(packageFiles.id, oldLead.id))
      .get();
    if (stillLead === undefined || stillLead.compositeKey === manifestDigest) {
      continue;
    }
    await drizzle(d1).update(packageFiles).set({ isLead: false }).where(eq(packageFiles.id, oldLead.id)).run();
  }
  return manifestDigest;
}

/** ParseManifestMetadata (common.go:38-55) — the config descriptor lookup and
 *  the config parse. */
async function parseManifestMetadata(
  d1: D1Database,
  bucket: R2Bucket,
  owner: ContainerOwner,
  image: string,
  manifest: OciManifestDocument,
): Promise<{ configDescriptor: ContainerBlobDescriptor; configMediaType: string; metadata: ContainerMetadata }> {
  const config = manifest.config ?? {};
  const configMediaType = typeof config.mediaType === "string" ? config.mediaType : "";
  const configDigest = typeof config.digest === "string" ? config.digest : "";
  if (configDigest === "") {
    throw new ContainerBlobNotExistError();
  }
  const configDescriptor = await getContainerBlob(d1, { ownerId: owner.id, image, digest: configDigest });
  const contentKey = packageBlobContentKey(configDescriptor.blob.hashSha256);
  const object = await bucket.get(contentKey);
  if (object === null) {
    throw new ContainerBlobNotExistError();
  }
  if (object.size > MAX_IMAGE_CONFIG_BYTES) {
    // upstream: the LimitedReader's ErrContentTooLarge on an image-manifest
    // config media type propagates → 500.
    throw new Error("container: image config exceeds the parse cap");
  }
  const configText = await object.text();
  let metadata: ContainerMetadata;
  try {
    metadata = parseContainerImageConfig(configMediaType, configText);
  } catch (error) {
    // A malformed config on a NON-manifest config media type degrades to the
    // unknown platform (metadata.go:101-104); otherwise it propagates (500).
    if (!isImageManifestMediaType(configMediaType)) {
      metadata = { type: "oci", isTagged: false, platform: "unknown/unknown" };
    } else {
      throw error;
    }
  }
  return { configDescriptor, configMediaType, metadata };
}

/** processOciImageManifest (manifest.go:100-159). */
async function processOciImageManifest(
  opts: {
    d1: D1Database;
    bucket: R2Bucket;
    owner: ContainerOwner;
    doer: PackageDoer;
    image: string;
    reference: string;
    quota: PackagesQuotaConfig;
  },
  documentText: string,
  spooled: SpooledBlob,
  mediaType: string,
  isTagged: boolean,
  now: Date,
): Promise<PutContainerManifestResult> {
  let manifest: OciManifestDocument;
  try {
    manifest = JSON.parse(documentText) as OciManifestDocument;
  } catch {
    throw new Error("container: manifest JSON parse failed");
  }
  const { configDescriptor, configMediaType, metadata } = await parseManifestMetadata(
    opts.d1,
    opts.bucket,
    opts.owner,
    opts.image,
    manifest,
  );
  const configDigest = typeof manifest.config?.digest === "string" ? manifest.config.digest : "";
  const configSize = typeof manifest.config?.size === "number" ? manifest.config.size : -1;

  const upload = await getOrCreateUploadVersion(opts.d1, opts.owner, opts.image, now);
  const { versionId } = await createPackageAndVersion(
    opts.d1,
    opts.owner,
    opts.doer,
    opts.image,
    opts.reference,
    isTagged,
    metadata,
    opts.quota,
    now,
  );

  // The config reference + every layer reference (manifest.go:112-136). A
  // missing layer → ErrContainerBlobNotExist → BLOB_UNKNOWN (container.go:589).
  await createFileFromBlobReference(
    opts.d1,
    versionId,
    upload.version.id,
    {
      digest: configDigest,
      mediaType: configMediaType,
      name: null,
      blob: configDescriptor.blob,
      file: configDescriptor.file,
      expectedSize: configSize,
      isLead: false,
    },
    now,
  );
  if (Array.isArray(manifest.layers)) {
    for (const layer of manifest.layers) {
      const layerRecord = layer as { mediaType?: unknown; digest?: unknown; size?: unknown };
      const layerDigest = typeof layerRecord.digest === "string" ? layerRecord.digest : "";
      const layerMediaType = typeof layerRecord.mediaType === "string" ? layerRecord.mediaType : "";
      const layerSize = typeof layerRecord.size === "number" ? layerRecord.size : -1;
      if (layerDigest === "") {
        throw new ContainerBlobNotExistError();
      }
      const descriptor = await getContainerBlob(opts.d1, { ownerId: opts.owner.id, image: opts.image, digest: layerDigest });
      await createFileFromBlobReference(
        opts.d1,
        versionId,
        upload.version.id,
        { digest: layerDigest, mediaType: layerMediaType, name: null, blob: descriptor.blob, file: descriptor.file, expectedSize: layerSize, isLead: false },
        now,
      );
    }
  }

  const digest = await createManifestBlob(opts.d1, opts.bucket, versionId, upload.version.id, mediaType, spooled, now);
  return { digest };
}

/** processOciImageIndex (manifest.go:161-229) — every referenced manifest
 *  must already exist AS A MANIFEST; the metadata collects their platforms. */
async function processOciImageIndex(
  opts: {
    d1: D1Database;
    bucket: R2Bucket;
    owner: ContainerOwner;
    doer: PackageDoer;
    image: string;
    reference: string;
    quota: PackagesQuotaConfig;
  },
  documentText: string,
  spooled: SpooledBlob,
  mediaType: string,
  isTagged: boolean,
  now: Date,
): Promise<PutContainerManifestResult> {
  let index: OciIndexDocument;
  try {
    index = JSON.parse(documentText) as OciIndexDocument;
  } catch {
    throw new Error("container: index JSON parse failed");
  }
  const entries: unknown[] = Array.isArray(index.manifests) ? (index.manifests as unknown[]) : [];
  const manifests: { platform: string; digest: string; size: number }[] = [];
  for (const entry of entries) {
    const record = entry as { mediaType?: unknown; digest?: unknown; platform?: { os?: unknown; architecture?: unknown; variant?: unknown } };
    const entryMediaType = typeof record.mediaType === "string" ? record.mediaType : "";
    if (!isImageManifestMediaType(entryMediaType)) {
      throw OCI_MANIFEST_INVALID;
    }
    const entryDigest = typeof record.digest === "string" ? record.digest : "";
    if (entryDigest === "") {
      throw OCI_MANIFEST_BLOB_UNKNOWN;
    }
    const descriptor = await getContainerBlob(opts.d1, {
      ownerId: opts.owner.id,
      image: opts.image,
      digest: entryDigest,
      isManifest: true,
    });
    let platform = "linux/amd64";
    if (typeof record.platform === "object" && record.platform !== null) {
      const os = typeof record.platform.os === "string" ? record.platform.os : "";
      const architecture = typeof record.platform.architecture === "string" ? record.platform.architecture : "";
      const variant = typeof record.platform.variant === "string" ? record.platform.variant : "";
      if (os !== "" && architecture !== "") {
        platform = variant === "" ? `${os}/${architecture}` : `${os}/${architecture}/${variant}`;
      }
    }
    // manifest.go:204-209 — CalculateFileSize over the referenced version.
    const sizeRows = await drizzle(opts.d1)
      .select({ total: sql<number>`coalesce(sum(${packageBlobs.size}), 0)` })
      .from(packageFiles)
      .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
      .where(eq(packageFiles.versionId, descriptor.file.versionId))
      .all();
    manifests.push({ platform, digest: entryDigest, size: sizeRows[0]?.total ?? 0 });
  }

  const upload = await getOrCreateUploadVersion(opts.d1, opts.owner, opts.image, now);
  const { versionId } = await createPackageAndVersion(
    opts.d1,
    opts.owner,
    opts.doer,
    opts.image,
    opts.reference,
    isTagged,
    { type: "oci", isTagged: false, manifests },
    opts.quota,
    now,
  );
  const digest = await createManifestBlob(opts.d1, opts.bucket, versionId, upload.version.id, mediaType, spooled, now);
  return { digest };
}

// ---------------------------------------------------------------------------
// The expiry sweeps (services/packages/container/cleanup.go) — exported for
// the packages cleanup producer block (the wiring is a HANDOFF: cleanup.ts is
// outside this unit's ownership)
// ---------------------------------------------------------------------------

/** cleanupExpiredBlobUploads (cleanup.go:19-31): the expired session rows and
 *  their chunk objects. */
export async function cleanupExpiredContainerUploads(
  d1: D1Database,
  bucket: R2Bucket,
  olderThanMs: number,
  now = new Date(),
): Promise<number> {
  const cut = new Date(now.getTime() - olderThanMs);
  const expired = await drizzle(d1)
    .select()
    .from(packageBlobUploads)
    .where(lt(packageBlobUploads.updatedUnix, cut))
    .all();
  for (const row of expired) {
    await removeContainerBlobUpload(d1, bucket, row.id);
  }
  return expired.length;
}

/** cleanupExpiredUploadedBlobs (cleanup.go:34-66): staging files on internal
 *  _upload versions older than the window lose their rows, then the emptied
 *  internal versions (and their properties) go too. */
export async function cleanupExpiredUploadedContainerBlobs(
  d1: D1Database,
  olderThanMs: number,
  now = new Date(),
): Promise<number> {
  const db = drizzle(d1);
  const cut = new Date(now.getTime() - olderThanMs);
  const expiredFiles = await db
    .select({ file: packageFiles })
    .from(packageFiles)
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      and(
        eq(packageVersions.isInternal, true),
        eq(packageVersions.lowerVersion, CONTAINER_UPLOAD_VERSION),
        eq(packages.type, "container"),
        lt(packageFiles.createdUnix, cut),
      ),
    )
    .all();
  for (const row of expiredFiles) {
    await deletePackageFile(d1, row.file.id);
  }
  const emptied = await db
    .select({ version: packageVersions })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .leftJoin(packageFiles, eq(packageFiles.versionId, packageVersions.id))
    .where(
      and(
        eq(packageVersions.isInternal, true),
        eq(packageVersions.lowerVersion, CONTAINER_UPLOAD_VERSION),
        eq(packages.type, "container"),
        sql`${packageFiles.id} IS NULL`,
      ),
    )
    .all();
  for (const row of emptied) {
    await deletePackageVersionAndReferences(d1, row.version.id);
  }
  return expiredFiles.length;
}

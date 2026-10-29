/**
 * The generic registry protocol service (SPEC-0016 §3.2) — the service half
 * of `/api/packages/{username}/generic/...` (upstream
 * routers/api/packages/generic/generic.go over CreatePackageOrAddFileToExisting /
 * OpenFileForDownloadByPackageNameAndVersion, packages.go:84/:602).
 *
 * - Upload: upstream validates name/version/filename against the regex set
 *   (generic.go:20-66 — ported verbatim), streams the body through the
 *   two-pass blob store (services/packages/blobs.ts), walks the GetOrInsert
 *   ladder (package → version → blob → file, §5.2) under the quota checks
 *   (403), answers 201 created / idempotent-on-identical-bytes / 409
 *   duplicate-different-bytes.
 * - Download: the version → file → blob walk, the R2 content-key stream,
 *   `Content-Disposition` per upstream's ServePackageFile
 *   (helper.go:52-77), and the lead-file GET download-counter bump
 *   (packages.go:655-660 — HEAD never counts).
 * - Delete: per-file (deletes the version too when it was the last file —
 *   generic.go:189-199) and per-version (RemovePackageVersionByNameAndVersion,
 *   packages.go:505-513). The R2 content keys are NEVER deleted here — the
 *   unreferenced-blob sweep is the sole content-key deleter (ratification 4,
 *   the PACKAGE-DEFER-STORAGE-DELETE posture upstream carries).
 */

import {
  type PackageBlobRow,
  type PackageDoer,
  type PackageFileRow,
  type PackageOwnerRow,
  type PackagesQuotaConfig,
  checkCountQuotaExceeded,
  checkSizeQuotaExceeded,
  deletePackageFile,
  deletePackageVersionAndReferences,
  getFileDescriptors,
  getFileForVersionByName,
  getOrInsertPackage,
  getOrInsertVersion,
  getVersionByNameAndVersion,
  incrementDownloadCounter,
  listFilesByVersion,
  tryInsertFile,
} from "./model";
import {
  copySpoolToContentKey,
  packageBlobContentKey,
  getOrInsertBlob,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";

// ---------------------------------------------------------------------------
// Upstream's validation set (generic.go:20-66), ported verbatim — Go's \w is
// ASCII, so the JS twin uses the same class; the single-character rule and
// the dot-only rejects ride along.
// ---------------------------------------------------------------------------

const PACKAGE_NAME_REGEX = /^[-_+.\w]+$/;
const FILENAME_REGEX = /^[-_+=:;.()[\]{}~!@#$%^& \w]+$/;

/** isValidPackageName (generic.go:53-58): the regex, a single non-alnum char is invalid, ".." is invalid. */
export function isValidPackageName(packageName: string): boolean {
  if (packageName.length === 1 && !/[a-z0-9_]/i.test(packageName)) {
    return false;
  }
  return PACKAGE_NAME_REGEX.test(packageName) && packageName !== "..";
}

/** isValidFileName (generic.go:60-64): the regex, trimmed-equals, not "." or "..". */
export function isValidFileName(filename: string): boolean {
  return FILENAME_REGEX.test(filename) && filename.trim() === filename && filename !== "." && filename !== "..";
}

/** The version rule (generic.go:82-86): trimmed-equals only. */
export function isValidPackageVersion(packageVersion: string): boolean {
  return packageVersion === packageVersion.trim();
}

// ---------------------------------------------------------------------------
// Upload — the CreatePackageOrAddFileToExisting walk (packages.go:84-129)
// ---------------------------------------------------------------------------

/** Thrown when the same (version, file, composite key) exists with DIFFERENT bytes (→ 409). */
export class DuplicatePackageFileError extends Error {
  constructor(readonly existing: PackageFileRow) {
    super("package file already exists");
    this.name = "DuplicatePackageFileError";
  }
}

export interface UploadGenericFileInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  packageName: string;
  packageVersion: string;
  filename: string;
  /** The request body stream (spooled, never buffered). */
  content: ReadableStream<Uint8Array>;
  declaredLength: number;
  quota: PackagesQuotaConfig;
  now?: Date;
  /** Test seams. */
  maxBytes?: number;
  spoolKey?: string;
}

export interface UploadGenericFileResult {
  descriptorFile: PackageFileRow;
  blob: PackageBlobRow;
  /** false when the upload was an idempotent duplicate (§5.2). */
  createdFile: boolean;
}

/**
 * The generic PUT's service walk:
 *   1. quota (count + size, admin bypass — the upstream checks run inside
 *      addFileToPackageVersion, packages.go:305-312);
 *   2. PASS 1 — spool-and-hash (the store owns the 413 cap + 400 mismatch);
 *   3. get-or-insert package → version → blob (the D1 dedup decides whether
 *      the second pass runs at all);
 *   4. PASS 2 on a new blob (or a dedup hit whose object was swept) — the
 *      spool streams to the content key, then the spool is deleted;
 *   5. the file row (identical-bytes no-op / different-bytes conflict).
 */
export async function uploadGenericFile(input: UploadGenericFileInput): Promise<UploadGenericFileResult> {
  const now = input.now ?? new Date();
  await checkCountQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, input.quota);
  // The size quota reads the DECLARED length pre-stream (the real size is
  // enforced identical by the FixedLengthStream); the count check needs no size.
  await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "generic", input.declaredLength, input.quota);

  const spooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: input.maxBytes,
    spoolKey: input.spoolKey,
  });

  try {
    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "generic",
      name: input.packageName,
      now,
    });
    const { row: version } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: input.packageVersion,
      now,
    });
    const { row: blob, created: blobCreated } = await getOrInsertBlob(input.d1, {
      size: spooled.size,
      sha256: spooled.sha256,
      sha1: spooled.sha1,
      sha512: spooled.sha512,
      now,
    });

    // PASS 2 — skipped entirely on a dedup hit whose object still exists
    // (the upstream OptionalSize repair branch, packages.go:268-285, keeps a
    // dedup row whose object was lost servable by re-landing it).
    const objectPresent = (await input.bucket.head(packageBlobContentKey(spooled.sha256))) !== null;
    if (blobCreated || !objectPresent) {
      await copySpoolToContentKey(input.bucket, spooled.spoolKey, spooled.sha256);
    } else {
      await input.bucket.delete(spooled.spoolKey);
    }

    // The D1 row only became useful after the final key was durably stored
    // (object-first, §5.1). A failure from here on leaves the unreferenced
    // blob row + key to the cleanup sweep (the ratified failure window).
    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: input.filename,
      isLead: true,
      now,
    });
    if (fileResult.outcome === "conflict") {
      throw new DuplicatePackageFileError(fileResult.row);
    }
    return { descriptorFile: fileResult.row, blob, createdFile: fileResult.outcome === "created" };
  } catch (error) {
    // The spool never orphans on a failure INSIDE the walk (the store's own
    // failure path already deleted it; copySpoolToContentKey deletes it on
    // both of its paths, so any residue here means pass 1 succeeded and pass
    // 2 never ran).
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Download — OpenFileForDownloadByPackageNameAndVersion (packages.go:602+)
// ---------------------------------------------------------------------------

export interface GenericDownload {
  descriptor: { file: PackageFileRow; blob: PackageBlobRow };
  versionId: number;
  /** Fresh stream over the content object (the caller pipes it out). */
  stream: ReadableStream;
  size: number;
  /** The R2 object metadata the response headers render (§3.2 upstream helper.go). */
  uploaded: Date;
}

/**
 * The GET/HEAD walk: version → file → blob → R2 object stream. `method` is
 * upstream's download-counter gate: a LEAD file's GET bumps it, HEAD never
 * does (packages.go:655-660). A missing object is the honest 404 (the
 * sole-sweeper posture: an unreferenced blob's key can be gone while rows
 * still exist only if a file row referenced it — which the sweep refuses).
 */
export async function openGenericFileForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  packageName: string,
  packageVersion: string,
  filename: string,
  method: "GET" | "HEAD",
): Promise<GenericDownload | null> {
  const version = await getVersionByNameAndVersion(d1, owner.id, "generic", packageName, packageVersion);
  if (version === null) return null;
  const file = await getFileForVersionByName(d1, version.id, filename);
  if (file === null) return null;
  const descriptors = await getFileDescriptors(d1, version.id);
  const match = descriptors.find((entry) => entry.file.id === file.id);
  if (match === undefined) return null;
  const object = await bucket.get(packageBlobContentKey(match.blob.hashSha256));
  if (object === null) return null;
  if (file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, version.id);
  }
  return {
    descriptor: match,
    versionId: version.id,
    stream: object.body,
    size: object.size,
    uploaded: object.uploaded,
  };
}

// ---------------------------------------------------------------------------
// Delete — DeletePackageFile / RemovePackageVersionByNameAndVersion
// ---------------------------------------------------------------------------

/**
 * Per-file DELETE (generic.go:164-202): deleting the LAST file deletes the
 * version with it; otherwise just the file. The content key stays — the
 * sweep is the sole deleter.
 */
export async function deleteGenericFile(
  d1: D1Database,
  owner: PackageOwnerRow,
  packageName: string,
  packageVersion: string,
  filename: string,
): Promise<"file" | "version" | null> {
  const version = await getVersionByNameAndVersion(d1, owner.id, "generic", packageName, packageVersion);
  if (version === null) return null;
  const file = await getFileForVersionByName(d1, version.id, filename);
  if (file === null) return null;
  const remaining = await listFilesByVersion(d1, version.id);
  if (remaining.length <= 1) {
    await deletePackageVersionAndReferences(d1, version.id);
    return "version";
  }
  await deletePackageFile(d1, file.id);
  return "file";
}

/**
 * Per-version DELETE (generic.go:140-161 → packages.go:505-513): the version
 * cascade (files + properties + row). Null = no such version.
 */
export async function deleteGenericVersion(
  d1: D1Database,
  owner: PackageOwnerRow,
  packageName: string,
  packageVersion: string,
): Promise<boolean> {
  const version = await getVersionByNameAndVersion(d1, owner.id, "generic", packageName, packageVersion);
  if (version === null) return false;
  await deletePackageVersionAndReferences(d1, version.id);
  return true;
}

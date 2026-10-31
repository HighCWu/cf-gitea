/**
 * The Terraform state-backend protocol service (SPEC-0016 §7 long tail) —
 * the service half of `/api/packages/{username}/terraform/state/{name}`
 * (upstream routers/api/packages/terraform/terraform.go over
 * modules/packages/terraform/state.go + lock.go at the pin). Upstream's
 * surface is the GitLab-compatible TERRAFORM STATE backend (api.go:466-476 —
 * the route group's own comment cites GitLab's fine-grained-permissions
 * reference); there is NO module registry / .well-known discovery in the pin.
 *
 * The model: one PACKAGE per state name (type `terraform`, package.go:54
 * `TypeTerraformState`), one VERSION per serial (`version = FormatUint(serial)`
 * — terraform.go:167), ONE lead file `tfstate` per version (terraform.go:30
 * `stateFilename`), the lock as a PACKAGE-type property `terraform.lock`
 * (lock.go:16 `LockFile`) holding the LockInfo JSON. No metadata JSON on the
 * version row (upstream's PackageCreationInfo carries none).
 *
 * - ParseState (state.go:12-31): `{serial, lineage}` — serial must decode as
 *   a whole number ≥ 1 ("state serial is missing" on 0) and lineage must be
 *   non-empty ("state lineage is missing"); the two-field subset doc'd at
 *   state.go:9-11.
 * - The lock state machine (lock.go + terraform.go:299-422): ParseLockInfo
 *   requires `ID` (lock.go:47-50) over a 64 KiB bounded read (lock.go:18);
 *   `IsLocked` = `ID != ""` (lock.go:34-36). SetLock/RemoveLock are
 *   CONDITIONAL property updates (lock.go:87-101 — `value = ''` guard on set,
 *   `value != ''` on remove, `n == 0` → the "failed to update lock state"
 *   error); a missing row inserts (remove inserts the EMPTY row).
 * - The endpoints (terraform.go):
 *   · GET state (latest, :39-50) / GET by serial (:53-55) —
 *     OpenFileForDownloadByPackageNameAndVersion (packages.go:601) → the
 *     GET-only download bump (:668);
 *   · POST upload (:88-193): the name gate (:91 → isValidPackageName :80-85),
 *     the lock enforcement (`?ID=` mismatch → 423 + the lock JSON :117-121),
 *     the size quota BEFORE the parse (:140), the 201, the duplicate-file
 *     409 (ErrDuplicatePackageFile — a same-serial re-post);
 *   · DELETE by serial (:196-234): the LATEST version is the 403
 *     ("cannot delete the latest version"), else 204;
 *   · DELETE whole (:238-297): locked → 423, else remove every version +
 *     the package → 200;
 *   · POST lock (:302-362): ALLOCATES the package row when missing
 *     (:327-342), locked → 423 + the lock JSON, else 200;
 *   · DELETE lock (:366-422): missing package or not locked → 200, ID
 *     mismatch → 423, else clear → 200.
 * - The family apiError is PLAIN TEXT (terraform.go:33-36 ctx.Plaintext); a
 *   nil error object renders the EMPTY body (helper.ProcessErrorForUser's
 *   zero message) — the 404 arms answer empty. The 423 LOCK bodies are the
 *   ONE JSON exception (ctx.JSON(423, lock)).
 *
 * Divergences (documented per AGENTS.md): upstream wraps every mutation in
 * the globallock (redis/inproc, terraform.go:95-101) — our store's arbiter
 * is the D1 conditional update (the lock CAS port) + the file UNIQUE, the
 * same constraint-arbitrated posture every landed family uses (model.ts's
 * header note); the remaining check-then-act window (two unlocked uploads
 * racing) is the same class the other families accept. The LockInfo
 * `Created` timestamp round-trips as the RFC3339-shaped string it parsed as
 * (Go re-renders through RFC3339Nano; an ABSENT Created renders Go's zero
 * time `0001-01-01T00:00:00Z` both stored and on the 423 body — the Go
 * round-trip's observable shape); the serial must be a safe integer (Go's
 * uint64 decode admits more digits than JS Number preserves). The store's
 * 512 MiB blob cap maps to 413 (upstream's unbounded spool has no cap arm).
 */

import { and, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  type PackageBlobRow,
  type PackageDoer,
  type PackageFileRow,
  type PackageOwnerRow,
  type PackagesQuotaConfig,
  type PackageVersionRow,
  PropertyType,
  checkSizeQuotaExceeded,
  deletePackageVersionAndReferences,
  deletePackageAndReferences,
  getFileForVersionByName,
  getOrInsertPackage,
  getOrInsertVersion,
  getPackageByName,
  getVersionByNameAndVersion,
  incrementDownloadCounter,
  searchLatestVersions,
  tryInsertFile,
} from "./model";
import { packageProperties } from "../../db/schema";
import {
  MAX_PACKAGE_BLOB_BYTES,
  PackageBlobTooLargeError,
  PackageSizeMismatchError,
  copySpoolToContentKey,
  getBlobById,
  getOrInsertBlob,
  packageBlobContentKey,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import { DuplicatePackageFileError } from "./generic";

// ---------------------------------------------------------------------------
// The module constants (modules/packages/terraform/)
// ---------------------------------------------------------------------------

/** package.go:54 — `TypeTerraformState Type = "terraform"`. */
export const TERRAFORM_PACKAGE_TYPE = "terraform";

/** lock.go:16 — the lock property name. */
export const TERRAFORM_LOCK_FILE = "terraform.lock";

/** lock.go:18 — `maxLockInfoSize`. */
const MAX_LOCK_INFO_BYTES = 64 * 1024;

/** terraform.go:30 — `stateFilename`. */
export const TERRAFORM_STATE_FILENAME = "tfstate";

// ---------------------------------------------------------------------------
// The state parse (state.go)
// ---------------------------------------------------------------------------

export class TerraformInvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerraformInvalidStateError";
  }
}

/** state.go:15-19 — the two-field subset. */
export interface TerraformState {
  serial: number;
  lineage: string;
}

/**
 * ParseState (state.go:21-31): the JSON body must decode `{serial, lineage}`
 * with serial a whole number ≥ 1 and lineage non-empty. Type mismatches and
 * malformed JSON are the decode-error class (Go's json.Decode errors → the
 * route's 400).
 */
export function parseTerraformState(bytes: Uint8Array): TerraformState {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new TerraformInvalidStateError("invalid character in state document");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TerraformInvalidStateError("invalid state document");
  }
  const record = decoded as Record<string, unknown>;
  const serial = record["serial"];
  // The uint64 decode: a whole number ≥ 1 (0 means "wasn't set", state.go:24).
  if (typeof serial !== "number" || !Number.isSafeInteger(serial) || serial < 1) {
    throw new TerraformInvalidStateError("state serial is missing");
  }
  const lineage = record["lineage"];
  if (typeof lineage !== "string" || lineage === "") {
    throw new TerraformInvalidStateError("state lineage is missing");
  }
  return { serial, lineage };
}

// ---------------------------------------------------------------------------
// The lock state machine (lock.go)
// ---------------------------------------------------------------------------

/** lock.go:20-29 — the struct's json-tag order verbatim (Go Marshal order on
 *  the 423 body); `Created` carries the rendered time STRING. */
export interface TerraformLockInfo {
  ID: string;
  Operation: string;
  Info: string;
  Who: string;
  Version: string;
  Created: string;
  Path: string;
}

/** Go's zero time.Time render — an ABSENT Created round-trips as this. */
const ZERO_TIME = "0001-01-01T00:00:00Z";

/** The RFC3339 shapes Go's time decode accepts (the range-validity inside is
 *  the documented reduction — the shape gates the decode-error arm). */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export class TerraformLockInfoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerraformLockInfoError";
  }
}

/** The zero lock (lock.go's zero-value return — `IsLocked() == false`). */
export function zeroTerraformLock(): TerraformLockInfo {
  return { ID: "", Operation: "", Info: "", Who: "", Version: "", Created: ZERO_TIME, Path: "" };
}

/**
 * ParseLockInfo (lock.go:38-52): the 64 KiB bounded JSON decode, `ID`
 * required ("terraform lock is missing an ID"), a non-empty `Created` must be
 * a time shape (Go's decode error arm), an absent one canonicalizes to the
 * zero time exactly as Go's round-trip renders it.
 */
export function parseTerraformLockInfo(bytes: Uint8Array): TerraformLockInfo {
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes.subarray(0, MAX_LOCK_INFO_BYTES)),
    );
  } catch {
    throw new TerraformLockInfoError("invalid lock document");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TerraformLockInfoError("invalid lock document");
  }
  const record = decoded as Record<string, unknown>;
  const id = record["ID"];
  if (typeof id !== "string" || id === "") {
    throw new TerraformLockInfoError("terraform lock is missing an ID");
  }
  const text = (key: string): string => {
    const value = record[key];
    if (value === undefined) return "";
    if (typeof value !== "string") throw new TerraformLockInfoError("invalid lock document");
    return value;
  };
  const createdRaw = text("Created");
  if (createdRaw !== "" && !RFC3339.test(createdRaw)) {
    throw new TerraformLockInfoError("invalid lock document");
  }
  return {
    ID: id,
    Operation: text("Operation"),
    Info: text("Info"),
    Who: text("Who"),
    Version: text("Version"),
    Created: createdRaw === "" ? ZERO_TIME : createdRaw,
    Path: text("Path"),
  };
}

/** lock.go:34-36 — `IsLocked`. */
export function isTerraformLockLocked(lock: TerraformLockInfo): boolean {
  return lock.ID !== "";
}

/** GetLock (lock.go:55-71): the package property, the ZERO lock when the row
 *  is missing or empty. */
export async function getTerraformLock(d1: D1Database, packageId: number): Promise<TerraformLockInfo> {
  const row = await drizzle(d1)
    .select({ value: packageProperties.value })
    .from(packageProperties)
    .where(
      and(
        eq(packageProperties.refType, PropertyType.Package),
        eq(packageProperties.refId, packageId),
        eq(packageProperties.name, TERRAFORM_LOCK_FILE),
      ),
    )
    .get();
  if (row === undefined || row.value === "") return zeroTerraformLock();
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Partial<TerraformLockInfo>;
      return {
        ID: typeof record.ID === "string" ? record.ID : "",
        Operation: typeof record.Operation === "string" ? record.Operation : "",
        Info: typeof record.Info === "string" ? record.Info : "",
        Who: typeof record.Who === "string" ? record.Who : "",
        Version: typeof record.Version === "string" ? record.Version : "",
        Created: typeof record.Created === "string" && record.Created !== "" ? record.Created : ZERO_TIME,
        Path: typeof record.Path === "string" ? record.Path : "",
      };
    }
  } catch {
    // a malformed row reads as the zero lock (upstream errors 500; the
    // property is only ever written by this module — the defensive read keeps
    // the family serving; the CAS below still refuses to double-set)
  }
  return zeroTerraformLock();
}

/** lock.go:103-108 — the conditional-write failure ("failed to update lock
 *  state") — upstream's bare errors.New → the route's 500. */
export class TerraformLockStateError extends Error {
  constructor() {
    super("failed to update lock state");
    this.name = "TerraformLockStateError";
  }
}

function lockPropertyWhere(packageId: number) {
  return and(
    eq(packageProperties.refType, PropertyType.Package),
    eq(packageProperties.refId, packageId),
    eq(packageProperties.name, TERRAFORM_LOCK_FILE),
  );
}

/**
 * SetLock (lock.go:74-85 + updateLock :87-101): the CAS UPDATE guarded on
 * `value = ''`, else the INSERT when no row exists, else the CAS lost (the
 * state locked between the caller's check and this write) → the update-failed
 * error. The missing globallock rides the D1 conditional — the single
 * statement arbitrates the race the globallock would have serialized.
 */
export async function setTerraformLock(d1: D1Database, packageId: number, lock: TerraformLockInfo): Promise<void> {
  const value = JSON.stringify(lock);
  const cas = await drizzle(d1)
    .update(packageProperties)
    .set({ value })
    .where(and(lockPropertyWhere(packageId), eq(packageProperties.value, "")))
    .run();
  if (cas.meta.changes > 0) return;
  const existing = await drizzle(d1)
    .select({ id: packageProperties.id })
    .from(packageProperties)
    .where(lockPropertyWhere(packageId))
    .get();
  if (existing === undefined) {
    await drizzle(d1)
      .insert(packageProperties)
      .values({ refType: PropertyType.Package, refId: packageId, name: TERRAFORM_LOCK_FILE, value })
      .run();
    return;
  }
  throw new TerraformLockStateError();
}

/**
 * RemoveLock (lock.go:90-93 + updateLock): the CAS UPDATE clearing `value`
 * guarded on `value != ''`; a MISSING row inserts the empty row (the
 * upstream insert arm); a present-but-empty row means the caller raced an
 * unlock — the update matched nothing → the update-failed error.
 */
export async function removeTerraformLock(d1: D1Database, packageId: number): Promise<void> {
  const cas = await drizzle(d1)
    .update(packageProperties)
    .set({ value: "" })
    .where(and(lockPropertyWhere(packageId), ne(packageProperties.value, "")))
    .run();
  if (cas.meta.changes > 0) return;
  const existing = await drizzle(d1)
    .select({ id: packageProperties.id })
    .from(packageProperties)
    .where(lockPropertyWhere(packageId))
    .get();
  if (existing === undefined) {
    await drizzle(d1)
      .insert(packageProperties)
      .values({ refType: PropertyType.Package, refId: packageId, name: TERRAFORM_LOCK_FILE, value: "" })
      .run();
    return;
  }
  throw new TerraformLockStateError();
}

// ---------------------------------------------------------------------------
// The name gate (terraform.go:27, 80-85)
// ---------------------------------------------------------------------------

/** terraform.go:27 — `\A[-_+.\w]+\z` (RE2 \w = [0-9A-Za-z_]). */
const STATE_NAME_PATTERN = /^[0-9A-Za-z_\-+.]+$/;

/**
 * isValidPackageName (terraform.go:80-85): the pattern AND NOT ".." AND the
 * single-character rule (a lone char must be a letter or number — "." and "-"
 * fail it). The byte-vs-rune corner reduces to the ASCII class (the pattern
 * admits ASCII only anyway).
 */
export function isTerraformStateNameValid(name: string): boolean {
  if (!STATE_NAME_PATTERN.test(name)) return false;
  if (name === "..") return false;
  if (name.length === 1 && !/[0-9A-Za-z]/.test(name)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The version lookups (terraform.go:424-439)
// ---------------------------------------------------------------------------

/**
 * getLatestVersion (terraform.go:424-439): SearchLatestVersions over the
 * exact owner/type/name triple (IsInternal false, SortCreatedDesc) — the
 * max-id version of the one package. Null = ErrPackageNotExist.
 */
export async function getTerraformLatestVersion(
  d1: D1Database,
  ownerId: number,
  name: string,
): Promise<PackageVersionRow | null> {
  const { rows } = await searchLatestVersions(d1, {
    ownerId,
    type: TERRAFORM_PACKAGE_TYPE,
    name,
    exact: true,
    excludeInternal: true,
  });
  return rows[0]?.version ?? null;
}

// ---------------------------------------------------------------------------
// The state reads (terraform.go:39-78)
// ---------------------------------------------------------------------------

export interface TerraformStateDownload {
  file: PackageFileRow;
  blob: PackageBlobRow;
  stream: ReadableStream;
  size: number;
}

/**
 * streamState's lookup (terraform.go:58-78 over packages.go:601-625): the
 * package → version (the serial or the latest) → the `tfstate` file → the
 * blob → the R2 stream, with the GET-only download bump
 * (IncrementDownloadCounter, packages.go:668). Null = the ErrPackageNotExist
 * / missing-file class (the route's 404).
 */
export async function openTerraformStateForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  name: string,
  serial: string | null,
  method: string,
): Promise<TerraformStateDownload | null> {
  const pkg = await getPackageByName(d1, owner.id, TERRAFORM_PACKAGE_TYPE, name);
  if (pkg === null) return null;
  const version =
    serial === null
      ? await getTerraformLatestVersion(d1, owner.id, name)
      : await getVersionByNameAndVersion(d1, owner.id, TERRAFORM_PACKAGE_TYPE, name, serial);
  if (version === null) return null;
  const file = await getFileForVersionByName(d1, version.id, TERRAFORM_STATE_FILENAME);
  if (file === null) return null;
  const blob = await getBlobById(d1, file.blobId);
  if (blob === null) return null;
  const object = await bucket.get(packageBlobContentKey(blob.hashSha256));
  if (object === null) return null;
  if (method === "GET") {
    await incrementDownloadCounter(d1, version.id);
  }
  return { file, blob, stream: object.body, size: object.size };
}

// ---------------------------------------------------------------------------
// The upload (terraform.go:88-193)
// ---------------------------------------------------------------------------

export class TerraformInvalidStateNameError extends Error {
  constructor() {
    super("invalid package name");
    this.name = "TerraformInvalidStateNameError";
  }
}

/**
 * The upload's pre-body lock enforcement (terraform.go:108-121): a locked
 * state refuses the write unless the request's `ID` (the ?ID= form value —
 * ctx.FormString reads the query too) matches the lock's. `locked` carries
 * the lock for the route's 423 JSON body.
 */
export async function assertTerraformStateWritable(
  d1: D1Database,
  ownerId: number,
  name: string,
  requestId: string,
): Promise<{ kind: "ok" } | { kind: "locked"; lock: TerraformLockInfo }> {
  const pkg = await getPackageByName(d1, ownerId, TERRAFORM_PACKAGE_TYPE, name);
  if (pkg === null) return { kind: "ok" };
  const lock = await getTerraformLock(d1, pkg.id);
  if (isTerraformLockLocked(lock) && lock.ID !== requestId) {
    return { kind: "locked", lock };
  }
  return { kind: "ok" };
}

export interface UploadTerraformStateInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  name: string;
  content: ReadableStream<Uint8Array>;
  declaredLength: number | undefined;
  quota: PackagesQuotaConfig;
  now?: Date;
  spoolKey?: string;
}

export interface UploadTerraformStateResult {
  pkg: { id: number; name: string };
  version: PackageVersionRow;
  file: PackageFileRow;
  blob: PackageBlobRow;
  state: TerraformState;
}

/**
 * UploadState (terraform.go:88-193): the name gate (:91-94), the spool
 * (:123-138), the size quota BEFORE the parse (:140-147 — no count-quota arm
 * upstream), ParseState (:149-154 — the serial/lineage 400s), then
 * CreatePackageOrAddFileToExisting (:160-179 — the `terraform` package, the
 * serial-string version, the lead `tfstate` file; a same-serial re-post is
 * the ErrDuplicatePackageFile 409).
 */
export async function uploadTerraformState(input: UploadTerraformStateInput): Promise<UploadTerraformStateResult> {
  const now = input.now ?? new Date();
  if (!isTerraformStateNameValid(input.name)) {
    throw new TerraformInvalidStateNameError();
  }

  const spooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: MAX_PACKAGE_BLOB_BYTES,
    spoolKey: input.spoolKey,
  });

  try {
    const spoolObject = await input.bucket.get(spooled.spoolKey);
    if (spoolObject === null) {
      throw new Error("package spool object vanished");
    }
    const bytes = new Uint8Array(await spoolObject.arrayBuffer());

    // terraform.go:140-147 — the size quota before the parse.
    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, TERRAFORM_PACKAGE_TYPE, bytes.byteLength, input.quota);

    const state = parseTerraformState(bytes);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: TERRAFORM_PACKAGE_TYPE,
      name: input.name,
      semverCompatible: false,
      now,
    });
    const { row: version } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: String(state.serial),
      now,
    });

    const { row: blob, created: blobCreated } = await getOrInsertBlob(input.d1, {
      size: bytes.byteLength,
      sha256: spooled.sha256,
      sha1: spooled.sha1,
      sha512: spooled.sha512,
      now,
    });

    const objectPresent = (await input.bucket.head(packageBlobContentKey(spooled.sha256))) !== null;
    if (blobCreated || !objectPresent) {
      await copySpoolToContentKey(input.bucket, spooled.spoolKey, spooled.sha256);
    } else {
      await input.bucket.delete(spooled.spoolKey);
    }

    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: TERRAFORM_STATE_FILENAME,
      isLead: true,
      compositeKey: "",
      now,
    });
    if (fileResult.outcome !== "created") {
      throw new DuplicatePackageFileError(fileResult.row);
    }

    return { pkg: { id: pkg.id, name: pkg.name }, version, file: fileResult.row, blob, state };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The deletes (terraform.go:196-297)
// ---------------------------------------------------------------------------

export type DeleteTerraformStateBySerialOutcome =
  | { kind: "not-found" }
  | { kind: "latest" }
  | { kind: "deleted" };

/**
 * DeleteStateBySerial (terraform.go:196-234): the serial version must exist
 * (404), the package's latest must exist (404), the LATEST serial is the 403
 * ("cannot delete the latest version"), else the version cascade → 204.
 */
export async function deleteTerraformStateBySerial(
  d1: D1Database,
  ownerId: number,
  name: string,
  serial: string,
): Promise<DeleteTerraformStateBySerialOutcome> {
  const version = await getVersionByNameAndVersion(d1, ownerId, TERRAFORM_PACKAGE_TYPE, name, serial);
  if (version === null) return { kind: "not-found" };
  const latest = await getTerraformLatestVersion(d1, ownerId, name);
  if (latest === null) return { kind: "not-found" };
  if (latest.id === version.id) return { kind: "latest" };
  await deletePackageVersionAndReferences(d1, version.id);
  return { kind: "deleted" };
}

export type DeleteTerraformStateOutcome = { kind: "not-found" } | { kind: "locked" } | { kind: "deleted" };

/**
 * DeleteState (terraform.go:238-297): missing package → 404; a locked state
 * → 423 ("terraform state is locked"); else every version + the package
 * cascade (the lock property rides DeleteAllProperties :278) → 200.
 */
export async function deleteTerraformState(d1: D1Database, ownerId: number, name: string): Promise<DeleteTerraformStateOutcome> {
  const pkg = await getPackageByName(d1, ownerId, TERRAFORM_PACKAGE_TYPE, name);
  if (pkg === null) return { kind: "not-found" };
  const lock = await getTerraformLock(d1, pkg.id);
  if (isTerraformLockLocked(lock)) return { kind: "locked" };
  await deletePackageAndReferences(d1, pkg.id);
  return { kind: "deleted" };
}

// ---------------------------------------------------------------------------
// The lock endpoints (terraform.go:299-422)
// ---------------------------------------------------------------------------

export type LockTerraformStateOutcome =
  | { kind: "bad-name" }
  | { kind: "bad-lock" }
  | { kind: "locked"; lock: TerraformLockInfo }
  | { kind: "ok"; lock: TerraformLockInfo };

/**
 * LockState (terraform.go:302-362): the name gate, the 64 KiB lock parse,
 * the package ALLOCATION when missing (:327-342), the locked → 423 arm, the
 * set → 200.
 */
export async function lockTerraformState(
  d1: D1Database,
  ownerId: number,
  name: string,
  body: Uint8Array,
): Promise<LockTerraformStateOutcome> {
  if (!isTerraformStateNameValid(name)) return { kind: "bad-name" };
  let lock: TerraformLockInfo;
  try {
    lock = parseTerraformLockInfo(body);
  } catch (error) {
    if (error instanceof TerraformLockInfoError) return { kind: "bad-lock" };
    throw error;
  }
  const { row: pkg } = await getOrInsertPackage(d1, {
    ownerId,
    type: TERRAFORM_PACKAGE_TYPE,
    name,
    semverCompatible: false,
  });
  const current = await getTerraformLock(d1, pkg.id);
  if (isTerraformLockLocked(current)) return { kind: "locked", lock: current };
  await setTerraformLock(d1, pkg.id, lock);
  return { kind: "ok", lock };
}

export type UnlockTerraformStateOutcome =
  | { kind: "bad-name" }
  | { kind: "bad-lock" }
  | { kind: "missing" }
  | { kind: "mismatch" }
  | { kind: "ok" };

/**
 * UnlockState (terraform.go:366-422): the name gate, the lock parse, the
 * missing package → 200 (:389-392), the not-locked → 200 (:403-406), the ID
 * mismatch → 423 (:409-412), the clear → 200.
 */
export async function unlockTerraformState(
  d1: D1Database,
  ownerId: number,
  name: string,
  body: Uint8Array,
): Promise<UnlockTerraformStateOutcome> {
  if (!isTerraformStateNameValid(name)) return { kind: "bad-name" };
  let reqLock: TerraformLockInfo;
  try {
    reqLock = parseTerraformLockInfo(body);
  } catch (error) {
    if (error instanceof TerraformLockInfoError) return { kind: "bad-lock" };
    throw error;
  }
  const pkg = await getPackageByName(d1, ownerId, TERRAFORM_PACKAGE_TYPE, name);
  if (pkg === null) return { kind: "missing" };
  const existing = await getTerraformLock(d1, pkg.id);
  if (!isTerraformLockLocked(existing)) return { kind: "ok" };
  if (existing.ID !== reqLock.ID) return { kind: "mismatch" };
  await removeTerraformLock(d1, pkg.id);
  return { kind: "ok" };
}

// Re-exported for the route mapper's error list (the 413 store cap + the
// lying-Content-Length posture).
export { MAX_PACKAGE_BLOB_BYTES, PackageBlobTooLargeError, PackageSizeMismatchError };

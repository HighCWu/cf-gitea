/**
 * The Go module proxy protocol service (SPEC-0016 §7's long-tail `go` row) —
 * the service half of `/api/packages/{username}/go/...` (upstream
 * routers/api/packages/goproxy/goproxy.go over
 * modules/packages/goproxy/metadata.go at the pin fc493688).
 *
 * ## The proxy protocol surface (goproxy.go at the pin)
 *
 * The `go` client's GOPROXY contract (go.dev/ref/mod#goproxy-protocol) rides
 * FIVE read arms + one write arm:
 *   - `GET {name}/@v/list`      — EnumeratePackageVersions (goproxy.go:29-49):
 *     the versions one per line, CreatedUnix ASC, `text/plain;charset=utf-8`;
 *     the empty module is `apiError(404, nil)` — the EMPTY body.
 *   - `GET {name}/@latest` and `GET {name}/@v/{version}.info` —
 *     PackageVersionMetadata (goproxy.go:51-69): ctx.JSON
 *     `{"Version": …, "Time": CreatedUnix.AsLocalTime()}` — Go renders
 *     time.Time as RFC3339Nano; upstream's column is second-granular so the
 *     fraction never appears, and our UTC substrate renders the `Z` form (the
 *     AsLocalTime offset is the server's TZ — workerd has no TZ database, the
 *     documented reduction every landed family carries).
 *   - `GET {name}/@v/{version}.mod` — PackageVersionGoModContent
 *     (goproxy.go:71-89): the version-scoped `go.mod` PROPERTY served as
 *     plain text; a missing property is upstream's 500 (err==nil with
 *     len!=1 → apiError(500, nil) → the prod "internal server error").
 *   - `GET {name}/@v/{version}.zip` — DownloadPackageFile (goproxy.go:91-119):
 *     the ONE stored file (len != 1 → 500), helper.ServePackageFile →
 *     ctx.ServeContent with Filename + LastModified (the serve-content.ts
 *     D-6 set; ServeSetHeaders receives no ContentType →
 *     util.IfZero("", …) → application/octet-stream, serve.go:75 — the zip
 *     is NOT sniffed); the lead file's GET bumps the download counter
 *     (packages.go:664-668).
 *   - `PUT /upload` — UploadPackage (goproxy.go:155-223): parse the zip per
 *     go.dev/ref/mod#zip-files, store name/version from the FIRST
 *     `{module}@{version}/` entry, the go.mod text as a VERSION PROPERTY
 *     (`go.mod`, metadata.go:18), the zip bytes VERBATIM as the ONE lead file
 *     `{version}.zip`; created → 201.
 *   - `GET /sumdb/sum.golang.org/supported` → `http.NotFound` (api.go:308) —
 *     the checksum-DB mirror probe; answering 404 tells the client this
 *     proxy does not mirror sum.golang.org.
 *
 * ## The missing-module contract (404/410)
 *
 * The protocol says a proxy answers "not available" for a missing
 * module/version with 404 or 410 and the go tool treats the pair alike.
 * Upstream's answer is uniformly 404 (apiError StatusNotFound in every
 * resolvePackage miss, goproxy.go:54-56/:93-95; the list miss with a nil err
 * is the empty-body 404, goproxy.go:35-37); 410 never appears anywhere in
 * the pin — the client-side equivalence makes that the faithful posture, so
 * this family serves 404 and never 410.
 *
 * ## Version validation = x/mod/semver.IsValid
 *
 * metadata.go:64 accepts the version taken VERBATIM from the zip path (it is
 * later echoed one-per-line into @v/list), gated only by
 * golang.org/x/mod/semver.IsValid — canonical three-number forms AND the
 * short `v1`/`v1.2` forms, prerelease and build suffixes, which is exactly
 * how Go's pseudo-versions (`v0.0.0-20230101000000-abcdefabcdef`) stay
 * valid: they are canonical semver with a prerelease. `isGoSemverValid`
 * below is that parser ported anchor-for-anchor (parseInt's leading-zero
 * rule, the prerelease's numeric-identifier rule, the build's laxer
 * identifier rule). There is no separate pseudo-version grammar in the pin.
 *
 * ## Documented reductions
 *
 * - The upload is capped at 64 MiB (413) — the nuget/arch parse-family
 *   precedent: upstream spools the upload through a HashedSizeBuffer with no
 *   explicit cap, ours must materialize the bytes for the zip walk.
 * - The go.mod 16 MiB cap IS upstream's (metadata.go:20, the
 *   go.dev/ref/mod#zip-path-size-constraints floor).
 * - `zip.NewReader`'s malformed-archive failure is a PLAIN Go error, not
 *   ErrInvalidArgument → UploadPackage's default arm → 500
 *   (goproxy.go:172-180; the helm corrupt-gzip arm's twin). Only the three
 *   ErrInvalidArgument sentinels answer 400.
 * - A duplicate FILE row (only reachable if a prior walk died between the
 *   version row and the file row) hits the same DEFAULT arm → 500
 *   (goproxy.go:211-217 maps only ErrDuplicatePackageVersion/quota;
 *   ErrDuplicatePackageFile falls to default → apiError(500, …)).
 * - The version duplicate is the 409 ALWAYS (allowDuplicate=false —
 *   createPackageAndVersion returns ErrDuplicatePackageVersion which
 *   goproxy.go:211-212 maps to StatusConflict; the go.mod property insert
 *   rides the created-only branch, packages.go createPackageAndVersion).
 */

import { drizzle } from "drizzle-orm/d1";

import { packageProperties } from "../../db/schema";
import {
  type PackageBlobRow,
  type PackageDoer,
  type PackageFileRow,
  type PackageOwnerRow,
  type PackageVersionRow,
  type PackagesQuotaConfig,
  PropertyType,
  UNLIMITED_QUOTA,
  QuotaTotalCountError,
  checkSizeQuotaExceeded,
  countVersions,
  getFileDescriptors,
  getOrInsertPackage,
  getOrInsertVersion,
  getVersionByNameAndVersion,
  incrementDownloadCounter,
  listFilesByVersion,
  searchLatestVersions,
  searchVersions,
  tryInsertFile,
} from "./model";
import { copySpoolToContentKey, getOrInsertBlob, packageBlobContentKey, spoolAndHash, type SpooledBlob } from "./blobs";
import { getPackageProperties } from "./protocol-common";

// ---------------------------------------------------------------------------
// Upstream sentinels (metadata.go:23-27 + goproxy.go's error arms)
// ---------------------------------------------------------------------------

/** ErrInvalidStructure (metadata.go:24) → 400. */
export class GoInvalidStructureError extends Error {
  constructor() {
    super("package has invalid structure");
    this.name = "GoInvalidStructureError";
  }
}

/** ErrInvalidVersion (metadata.go:25) → 400. */
export class GoInvalidVersionError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "GoInvalidVersionError";
  }
}

/** ErrGoModFileTooLarge (metadata.go:26) → 400. */
export class GoModFileTooLargeError extends Error {
  constructor() {
    super("go.mod file is too large");
    this.name = "GoModFileTooLargeError";
  }
}

/** resolvePackage's ErrPackageNotExist (goproxy.go:54-56/:93-95) → 404. */
export class GoPackageNotExistError extends Error {
  constructor() {
    super("package does not exist");
    this.name = "GoPackageNotExistError";
  }
}

/** ErrDuplicatePackageVersion (goproxy.go:211-212) → 409. */
export class GoDuplicateVersionError extends Error {
  constructor(readonly existing: PackageVersionRow) {
    super("package version already exists");
    this.name = "GoDuplicateVersionError";
  }
}

/** The single-file arm's len(pfs) != 1 (goproxy.go:102-106) → 500. */
export class GoFileSetInvalidError extends Error {
  constructor() {
    super("package file set is invalid");
    this.name = "GoFileSetInvalidError";
  }
}

/** The go.mod property arm's len(pps) != 1 (goproxy.go:82-86) → 500. */
export class GoModPropertyMissingError extends Error {
  constructor() {
    super("go.mod property is missing");
    this.name = "GoModPropertyMissingError";
  }
}

/** `zip.NewReader`'s failure — a PLAIN error upstream → the 500 arm
 *  (goproxy.go:172-180's non-ErrInvalidArgument branch). */
export class GoInvalidArchiveError extends Error {
  constructor() {
    super("zip: not a valid zip file");
    this.name = "GoInvalidArchiveError";
  }
}

/** PropertyGoMod (metadata.go:18) — the version-scoped go.mod property name. */
export const GO_PROPERTY_GOMOD = "go.mod";

/** maxGoModFileSize (metadata.go:20 — go.dev/ref/mod#zip-path-size-constraints). */
export const MAX_GO_MOD_FILE_SIZE = 16 * 1024 * 1024;

/** The upload parse cap (the nuget/arch parse-family precedent; upstream has
 *  no explicit cap — the module header's reduction note). */
export const MAX_GO_UPLOAD_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// x/mod/semver.IsValid — the parse ported anchor-for-anchor (semver.go)
// ---------------------------------------------------------------------------

/** parseInt (x/mod/semver parse.go): digits, no leading zeros unless "0". */
function semverParseInt(v: string): { rest: string } | null {
  if (v === "") return null;
  const first = v.charCodeAt(0);
  if (first < 0x30 || first > 0x39) return null;
  let i = 1;
  while (i < v.length) {
    const code = v.charCodeAt(i);
    if (code < 0x30 || code > 0x39) break;
    i += 1;
  }
  const rest = v.slice(i);
  if (v[0] === "0" && i !== 1) return null;
  return { rest };
}

/** isIdentChar (x/mod/semver): alphanumerics and the hyphen. */
function semverIdentChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x2d
  );
}

/** isBadNum (x/mod/semver): all digits, length > 1, leading zero. */
function semverIsBadNum(v: string): boolean {
  let i = 0;
  while (i < v.length) {
    const code = v.charCodeAt(i);
    if (code < 0x30 || code > 0x39) break;
    i += 1;
  }
  return i === v.length && i > 1 && v[0] === "0";
}

/** parsePrerelease (x/mod/semver): `-` + dot-separated identifiers, each
 *  non-empty and (when all-numeric) free of leading zeros. */
function semverParsePrerelease(v: string): { rest: string } | null {
  if (v === "" || v[0] !== "-") return null;
  let i = 1;
  let start = 1;
  while (i < v.length && v[i] !== "+") {
    const code = v.charCodeAt(i);
    if (!semverIdentChar(code) && code !== 0x2e) return null;
    if (code === 0x2e) {
      if (start === i || semverIsBadNum(v.slice(start, i))) return null;
      start = i + 1;
    }
    i += 1;
  }
  if (start === i || semverIsBadNum(v.slice(start, i))) return null;
  return { rest: v.slice(i) };
}

/** parseBuild (x/mod/semver): `+` + dot-separated identifiers, each non-empty
 *  (numeric identifiers MAY carry leading zeros — the laxer arm). */
function semverParseBuild(v: string): { rest: string } | null {
  if (v === "" || v[0] !== "+") return null;
  let i = 1;
  let start = 1;
  while (i < v.length) {
    const code = v.charCodeAt(i);
    if (!semverIdentChar(code) && code !== 0x2e) return null;
    if (code === 0x2e) {
      if (start === i) return null;
      start = i + 1;
    }
    i += 1;
  }
  if (start === i) return null;
  return { rest: v.slice(i) };
}

/**
 * `semver.IsValid` (x/mod/semver parse.go): `v` + parseInt [. parseInt [
 * . parseInt [- prerelease] [+ build]]] — the SHORT `v1`/`v1.2` forms are
 * valid (the parse short-circuits after the consumed integers), canonical
 * three-number forms are valid, prerelease/build suffixes are valid. This is
 * the whole version gate metadata.go:64 applies (pseudo-versions are
 * canonical semver with a prerelease — no separate grammar exists upstream).
 */
export function isGoSemverValid(version: string): boolean {
  if (version === "" || version[0] !== "v") return false;
  let rest = version.slice(1);
  const major = semverParseInt(rest);
  if (major === null) return false;
  rest = major.rest;
  if (rest === "") return true; // short "v1"
  if (rest[0] !== ".") return false;
  const minor = semverParseInt(rest.slice(1));
  if (minor === null) return false;
  rest = minor.rest;
  if (rest === "") return true; // short "v1.2"
  if (rest[0] !== ".") return false;
  const patch = semverParseInt(rest.slice(1));
  if (patch === null) return false;
  rest = patch.rest;
  if (rest.startsWith("-")) {
    const prerelease = semverParsePrerelease(rest);
    if (prerelease === null) return false;
    rest = prerelease.rest;
  }
  if (rest.startsWith("+")) {
    const build = semverParseBuild(rest);
    if (build === null) return false;
    rest = build.rest;
  }
  return rest === "";
}

// ---------------------------------------------------------------------------
// path helpers — Go path.Dir / path.Base over zip entry names
// ---------------------------------------------------------------------------

/** Go path.Clean's lexical walk reduced to the slice form path.Dir feeds it
 *  (Clean(dir + "/")): strips trailing slashes (repeated included); ""
 *  cleans to "." and "/" stays "/". */
function goPathCleanDir(dir: string): string {
  if (dir === "") return ".";
  const trimmed = dir.replace(/\/+$/, "");
  if (trimmed === "") return dir.startsWith("/") ? "/" : ".";
  return trimmed;
}

/** Go path.Dir: everything before the final slash, Clean'd; no slash → ".". */
function goPathDir(name: string): string {
  const at = name.lastIndexOf("/");
  if (at < 0) return ".";
  return goPathCleanDir(name.slice(0, at + 1));
}

/** Go path.Base: after the final slash; trailing slashes ignored, all-slash
 *  → "/", "" → ".". */
function goPathBase(name: string): string {
  if (name === "") return ".";
  let end = name.length;
  while (end > 0 && name[end - 1] === "/") end -= 1;
  const start = name.lastIndexOf("/", end - 1) + 1;
  const base = name.slice(start, end);
  return base === "" ? "/" : base;
}

// ---------------------------------------------------------------------------
// The zip reader — EOCD + central-directory walk (the nuget reader's idiom,
// re-landed here self-contained: the parse needs entry BYTES and nuget's
// extractor is module-private; stored + deflate-raw, zip64 out of scope
// under the 64 MiB parse cap)
// ---------------------------------------------------------------------------

interface GoZipEntryRaw {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function zipU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
}

function zipU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) |
    ((bytes[offset + 1] as number) << 8) |
    ((bytes[offset + 2] as number) << 16) |
    ((bytes[offset + 3] as number) << 24)
  ) >>> 0;
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CD_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

function zipLatin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** One entry's bytes — stored copied, deflate inflated (the claimed
 *  uncompressed size bounds the output, the zip-bomb gate). */
async function zipExtractEntry(bytes: Uint8Array, entry: GoZipEntryRaw): Promise<Uint8Array> {
  if (entry.localHeaderOffset + 30 > bytes.byteLength || zipU32(bytes, entry.localHeaderOffset) !== ZIP_LOCAL_SIGNATURE) {
    throw new GoInvalidArchiveError();
  }
  const nameLength = zipU16(bytes, entry.localHeaderOffset + 26);
  const extraLength = zipU16(bytes, entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) {
    return compressed.slice();
  }
  if (entry.method === 8) {
    const inflated = new Response(compressed.slice()).body?.pipeThrough(new DecompressionStream("deflate-raw"));
    if (inflated === undefined) {
      throw new GoInvalidArchiveError();
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = inflated.getReader();
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      total += read.value.byteLength;
      if (total > entry.uncompressedSize) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be errored.
        }
        throw new GoInvalidArchiveError();
      }
      chunks.push(read.value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  throw new GoInvalidArchiveError();
}

/** The central-directory walk; a missing EOCD or a bad signature is
 *  zip.NewReader's failure. */
function readGoZipEntries(bytes: Uint8Array): GoZipEntryRaw[] {
  const window = Math.min(bytes.byteLength, 22 + 65535);
  let eocdAt = -1;
  for (let i = bytes.byteLength - 22; i >= bytes.byteLength - window; i--) {
    if (zipU32(bytes, i) === ZIP_EOCD_SIGNATURE) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0 || bytes.byteLength - eocdAt < 22) {
    throw new GoInvalidArchiveError();
  }
  const entryCount = zipU16(bytes, eocdAt + 10);
  const cdSize = zipU32(bytes, eocdAt + 12);
  const cdOffset = zipU32(bytes, eocdAt + 16);
  if (cdOffset + cdSize > bytes.byteLength) {
    throw new GoInvalidArchiveError();
  }
  const entries: GoZipEntryRaw[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > bytes.byteLength || zipU32(bytes, cursor) !== ZIP_CD_SIGNATURE) {
      throw new GoInvalidArchiveError();
    }
    const flags = zipU16(bytes, cursor + 8);
    const nameLength = zipU16(bytes, cursor + 28);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    entries.push({
      name: (flags & 0x800) !== 0 ? new TextDecoder().decode(nameBytes) : zipLatin1(nameBytes),
      method: zipU16(bytes, cursor + 10),
      compressedSize: zipU32(bytes, cursor + 20),
      uncompressedSize: zipU32(bytes, cursor + 24),
      localHeaderOffset: zipU32(bytes, cursor + 42),
    });
    cursor += 46 + nameLength + zipU16(bytes, cursor + 30) + zipU16(bytes, cursor + 32);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// ParsePackage (metadata.go:37-103) — go.dev/ref/mod#zip-files
// ---------------------------------------------------------------------------

export interface GoPackageArchive {
  /** The module path — everything before `@` in the first `@`-entry's dir. */
  name: string;
  /** The version — verbatim from the zip path (semver-validated). */
  version: string;
  /** The go.mod text, or the synthesized `module {name}` when absent. */
  goMod: string;
}

/**
 * `ParsePackage` (metadata.go:37-103): the module name and version come from
 * the FIRST central-directory entry whose dir carries `@` (path.Dir →
 * SplitN "@", 2 → SplitN "/", 2); the version is semver-gated (→
 * ErrInvalidVersion); entries BELOW the `{module}@{version}/` root are
 * skipped; the first root-level `go.mod` read (over maxGoModFileSize →
 * ErrGoModFileTooLarge) completes the parse; no `@`-entry at all →
 * ErrInvalidStructure; `@`-entries but no root go.mod → GoMod synthesizes as
 * `module {name}` (metadata.go:100).
 */
export async function parseGoModuleArchive(bytes: Uint8Array): Promise<GoPackageArchive> {
  const entries = readGoZipEntries(bytes);
  let parsed: GoPackageArchive | null = null;
  for (const entry of entries) {
    const nameAndVersion = goPathDir(entry.name);
    const at = nameAndVersion.indexOf("@");
    if (at < 0) continue;
    const after = nameAndVersion.slice(at + 1);
    const slashAt = after.indexOf("/");
    if (parsed === null) {
      const version = slashAt < 0 ? after : after.slice(0, slashAt);
      parsed = { name: nameAndVersion.slice(0, at), version, goMod: "" };
      // The version is echoed verbatim into @v/list — it must be a valid
      // module version (metadata.go:60-65).
      if (!isGoSemverValid(parsed.version)) {
        throw new GoInvalidVersionError();
      }
    }
    if (slashAt >= 0) {
      // Files below the {module}@{version} root are skipped (metadata.go:69-72).
      continue;
    }
    if (goPathBase(entry.name) === "go.mod") {
      if (entry.uncompressedSize > MAX_GO_MOD_FILE_SIZE) {
        throw new GoModFileTooLargeError();
      }
      parsed.goMod = new TextDecoder().decode(await zipExtractEntry(bytes, entry));
      return parsed;
    }
  }
  if (parsed === null) {
    throw new GoInvalidStructureError();
  }
  parsed.goMod = `module ${parsed.name}`;
  return parsed;
}

// ---------------------------------------------------------------------------
// RFC3339Nano (Go time.Time JSON rendering) — UTC (the AsLocalTime reduction,
// module header); second-granular upstream rows never render a fraction.
// ---------------------------------------------------------------------------

export function goTimeJson(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  let out = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  const ms = date.getUTCMilliseconds();
  if (ms !== 0) {
    out += `.${pad(ms, 3).replace(/0+$/, "")}`;
  }
  return `${out}Z`;
}

// ---------------------------------------------------------------------------
// Upload — UploadPackage (goproxy.go:155-223) over createPackageAndAddFile
// ---------------------------------------------------------------------------

export interface UploadGoPackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  /** The request body stream (spooled, never buffered). */
  content: ReadableStream<Uint8Array>;
  /** The declared Content-Length; `undefined` = a chunked body (D-2). */
  declaredLength: number | undefined;
  quota: PackagesQuotaConfig;
  now?: Date;
  /** Test seams. */
  maxBytes?: number;
  spoolKey?: string;
}

export interface UploadGoPackageResult {
  version: PackageVersionRow;
  file: PackageFileRow;
  blob: PackageBlobRow;
}

/**
 * The go upload's service walk (the helm/arch parse-family idiom): quota
 * pre-checks → pass-1 spool-and-hash → the bytes → ParsePackage →
 * get-or-insert package (type "go") → version (duplicate → the 409 sentinel)
 * → the created-only `go.mod` version property → blob → pass-2 copy → the
 * ONE lead file `{version}.zip` (a duplicate file row is upstream's DEFAULT
 * arm → the route's 500). The spool never orphans on a failure inside the
 * walk.
 */
export async function uploadGoPackage(input: UploadGoPackageInput): Promise<UploadGoPackageResult> {
  const now = input.now ?? new Date();
  // CheckCountQuotaExceeded rides the versionCreated branch
  // (createPackageAndVersion) — the +1 post-insert parity the landed
  // families pin (count + 1 > limit; admin bypass).
  if (!input.doer.isAdmin && input.quota.limitTotalOwnerCount > UNLIMITED_QUOTA) {
    const total = (await countVersions(input.d1, input.owner.id)) + 1;
    if (total > input.quota.limitTotalOwnerCount) {
      throw new QuotaTotalCountError();
    }
  }
  // Size quota: declared length pre-check; the chunked arm defers to
  // post-spool with the real size (upstream reads Data.Size() after the
  // read, packages.go:303-306 — the generic.ts order).
  if (input.declaredLength !== undefined) {
    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "go", input.declaredLength, input.quota);
  }

  const spooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: input.maxBytes ?? Math.min(MAX_GO_UPLOAD_BYTES, 512 * 1024 * 1024),
    spoolKey: input.spoolKey,
  });

  try {
    if (input.declaredLength === undefined) {
      await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "go", spooled.size, input.quota);
    }
    const spoolObject = await input.bucket.get(spooled.spoolKey);
    if (spoolObject === null) {
      throw new Error("go upload spool object vanished");
    }
    const bytes = new Uint8Array(await spoolObject.arrayBuffer());
    const archive = await parseGoModuleArchive(bytes);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "go",
      name: archive.name,
      now,
    });
    const { row: version, created: versionCreated } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: archive.version,
      now,
    });
    if (!versionCreated) {
      // ErrDuplicatePackageVersion → 409 (goproxy.go:211-212) — ALWAYS for
      // go (allowDuplicate=false); the go.mod property only ever lands on
      // the created branch (createPackageAndVersion).
      throw new GoDuplicateVersionError(version);
    }
    // The version property (VersionProperties map, goproxy.go:197-199) —
    // created-only, upstream's insert order (packages.go
    // createPackageAndVersion's versionCreated branch).
    await drizzle(input.d1)
      .insert(packageProperties)
      .values({ refType: PropertyType.Version, refId: version.id, name: GO_PROPERTY_GOMOD, value: archive.goMod })
      .run();

    const { row: blob, created: blobCreated } = await getOrInsertBlob(input.d1, {
      size: spooled.size,
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

    // Filename `{version}.zip`, IsLead true (goproxy.go:202-208); a
    // duplicate row hits upstream's DEFAULT arm → 500 (module header note).
    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: `${archive.version}.zip`,
      isLead: true,
      now,
    });
    if (fileResult.outcome !== "created") {
      throw new Error("package file already exists");
    }
    return { version, file: fileResult.row, blob };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Read arms
// ---------------------------------------------------------------------------

/**
 * `resolvePackage` (goproxy.go:121-153): version "latest" →
 * SearchLatestVersions (SortCreatedDesc, exact name, IsInternal false —
 * `len(pvs) != 1` → ErrPackageNotExist); every other string →
 * GetVersionByNameAndVersion. Null = the 404 sentinel.
 */
export async function resolveGoPackageVersion(
  d1: D1Database,
  ownerId: number,
  name: string,
  version: string,
): Promise<PackageVersionRow | null> {
  if (version === "latest") {
    const found = await searchLatestVersions(d1, {
      ownerId,
      type: "go",
      name,
      exact: true,
      excludeInternal: true,
      page: 1,
      limit: 100000,
    });
    if (found.rows.length !== 1) {
      return null;
    }
    return found.rows[0]?.version ?? null;
  }
  return getVersionByNameAndVersion(d1, ownerId, "go", name, version);
}

/**
 * `EnumeratePackageVersions` (goproxy.go:29-49): GetVersionsByPackageName
 * (SearchVersions exact-match, IsInternal false — package_version.go:140-151),
 * then the handler's CreatedUnix ASC sort (sort.Slice — ours adds the id
 * tiebreak upstream's unstable sort leaves undefined; deterministic output).
 * Empty when the module has no versions (the caller answers the EMPTY-body
 * 404).
 */
export async function listGoPackageVersions(d1: D1Database, ownerId: number, name: string): Promise<string[]> {
  const found = await searchVersions(d1, {
    ownerId,
    type: "go",
    name,
    exact: true,
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });
  if (found.rows.length === 0) {
    return [];
  }
  const sorted = [...found.rows].sort((a, b) => {
    const at = a.version.createdUnix.getTime();
    const bt = b.version.createdUnix.getTime();
    if (at !== bt) return at - bt;
    return a.version.id - b.version.id;
  });
  return sorted.map((row) => row.version.version);
}

/**
 * `PackageVersionGoModContent`'s property read (goproxy.go:82-86):
 * GetPropertiesByName(PropertyTypeVersion, pv.ID, "go.mod") — len != 1 is
 * the 500 sentinel.
 */
export async function getGoModContent(d1: D1Database, versionId: number): Promise<string> {
  const properties = await getPackageProperties(d1, PropertyType.Version, versionId);
  const matches = properties.filter((property) => property.name === GO_PROPERTY_GOMOD);
  if (matches.length !== 1) {
    throw new GoModPropertyMissingError();
  }
  return matches[0]?.value ?? "";
}

/**
 * `DownloadPackageFile`'s walk (goproxy.go:91-119): resolve → the ONE file
 * (len != 1 → the 500 sentinel) → the blob → the R2 content stream; the
 * lead file's GET bumps the download counter (packages.go:664-668, HEAD
 * never counts). Throws GoPackageNotExistError on the resolve miss AND on a
 * vanished content object (the honest 404 — the sole-sweeper posture).
 */
export interface GoZipDownload {
  file: PackageFileRow;
  version: PackageVersionRow;
  stream: ReadableStream;
  size: number;
  filename: string;
  created: Date;
}

export async function openGoZipForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  name: string,
  version: string,
  method: "GET" | "HEAD",
): Promise<GoZipDownload> {
  const resolved = await resolveGoPackageVersion(d1, owner.id, name, version);
  if (resolved === null) {
    throw new GoPackageNotExistError();
  }
  const files = await listFilesByVersion(d1, resolved.id);
  const file = files[0];
  if (files.length !== 1 || file === undefined) {
    throw new GoFileSetInvalidError();
  }
  const descriptors = await getFileDescriptors(d1, resolved.id);
  const match = descriptors.find((entry) => entry.file.id === file.id);
  if (match === undefined) {
    throw new GoFileSetInvalidError();
  }
  const object = await bucket.get(packageBlobContentKey(match.blob.hashSha256));
  if (object === null) {
    throw new GoPackageNotExistError();
  }
  if (file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, resolved.id);
  }
  return {
    file,
    version: resolved,
    stream: object.body,
    size: object.size,
    filename: file.name,
    created: file.createdUnix,
  };
}

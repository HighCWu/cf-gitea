/**
 * The Swift package registry protocol service (SPEC-0016 §2.1's long-tail
 * `swift` row) — the service half of `/api/packages/{username}/swift/...`
 * (upstream routers/api/packages/swift/swift.go 507 ln +
 * modules/packages/swift/metadata.go 258 ln at the pin fc493688, with the
 * upstream integration test tests/integration/api_packages_swift_test.go and
 * the module's metadata_test.go as the shape oracles).
 *
 * ## The wire surface (swift.go + api.go:451-471 at the pin)
 *
 * The Swift Package Manager registry contract
 * (github.com/swiftlang/swift-package-manager Registry.md) rides:
 *   - `POST /swift` and `POST /swift/login` — CheckAuthenticate
 *     (swift.go:103-110): the ONLY check is `ctx.Doer == nil` → 401; the
 *     arms sit OUTSIDE reqPackageAccess ("Needs to be unauthenticated",
 *     api.go:452-455) so ANY valid credential passes regardless of scope.
 *     The 200 carries NO Content-Version (ctx.Status(200) only).
 *   - `GET /swift/{scope}/{name}` + `.json` — EnumeratePackageVersions
 *     (swift.go:125-166): GetVersionsByPackageName (a SearchVersions
 *     EXACT-match on the lower-cased `scope.name` id), sorted by
 *     SemVer.LessThan ASC; `{"releases": {"<SemVer.String()>": {"url":
 *     baseURL + RAW version}}}` (Go map marshal = key-sorted) with the Link
 *     `rel="latest-version"` header carrying PathEscape of the LAST row's RAW
 *     version; the empty set is apiError(404, nil) — detail "".
 *   - `GET /swift/{scope}/{name}/{version}` + `{version}.json` —
 *     PackageVersionMetadata (swift.go:182-251): the resources pair (the ONE
 *     source-archive zip, checksum = the blob's sha256) + the schema.org
 *     SoftwareSourceCode metadata document (name from the PACKAGE property
 *     swift.name, description/keywords/license/licenseURL/codeRepository from
 *     the stored Metadata JSON, author present when ANY of its four name
 *     parts is non-empty, repositoryURLs from the swift.repository_url
 *     VERSION properties).
 *   - `GET /swift/{scope}/{name}/{version}.zip` — DownloadPackageFile
 *     (swift.go:424-458): the `Digest: sha256=<hash>` header + the D-6 serve
 *     set with application/zip; the lead GET bumps the counter.
 *   - `GET /swift/{scope}/{name}/{version}/Package.swift?swift-version=…` —
 *     DownloadManifest (swift.go:254-303): the stored manifest text verbatim,
 *     text/x-swift; the query param is NewVersion-normalized
 *     (TrimmedVersionString: "5.6.0" → "5.6") before the manifests lookup; a
 *     MISS answers 303 SeeOther with the bare Location (no query) — the
 *     client re-asks for the default manifest.
 *   - `PUT /swift/{scope}/{name}/{version}` — UploadPackageFile
 *     (swift.go:323-421): multipart (or urlencoded) form, "source-archive"
 *     as a FILE part (or plain value — formFileOptionalReadCloser falls back
 *     to FormValue, swift.go:306-320) + optional "metadata" JSON; the zip is
 *     stored VERBATIM as the ONE lead file `{name}-{version}.zip`, the
 *     manifests + author as the version's MetadataJSON, swift.scope/swift.name
 *     as PACKAGE properties, each metadata repositoryURL as a
 *     swift.repository_url VERSION property (insert errors logged, not fatal —
 *     swift.go:411-416). 201, Content-Version only.
 *   - `GET /swift/identifiers?url=…` — LookupPackageIdentifiers
 *     (swift.go:465-506): SearchLatestVersions over the
 *     swift.repository_url version property; `{identifiers: [packageID…]}`.
 *
 * ## The version grammar = hashicorp/go-version v1.9.0 (gitea/go.mod)
 *
 * The upload gate is `version.NewSemver` (SemverRegexpRaw — the prerelease
 * REQUIRES its "-" separator), the manifest-filename and tools-version gates
 * the same, and the swift-version query param `version.NewVersion`
 * (VersionRegexpRaw — the laxer `-?` letter-prerelease form). Both parse
 * arbitrary segment counts; Segments64 is zero-padded to three. Ported
 * anchor-for-anchor below (parseSwiftVersionStrict / parseSwiftVersionLax /
 * swiftVersionString / swiftTrimmedVersionString / swiftCompareVersions) —
 * Compare's prerelease walk carries go-version's own quirks verbatim
 * (comparePart's empty-part + numeric-vs-string rules, the equal-segments
 * short-circuit through String()).
 *
 * ## Documented reductions
 *
 * - The multipart/urlencoded BODY is capped at 64 MiB (413) — the
 *   goproxy/nuget parse-family precedent: upstream spools through a hashed
 *   buffer with no explicit cap, ours materializes for the multipart walk
 *   and the zip parse.
 * - The metadata form part is bounded by upstream's 32 MiB MaxMetadataSize
 *   (modules/packages/limited_reader.go:14); exceeding it errors the JSON
 *   decode upstream (the 500 default arm) — ours throws at the same point.
 * - A malformed zip, a zip-bomb-shaped archive and an undecodable metadata
 *   JSON are PLAIN errors upstream (zip.NewReader / json.Decode failures are
 *   not util.ErrInvalidArgument) → UploadPackageFile's DEFAULT arm → 500.
 *   Only the ErrInvalidArgument sentinels answer 400.
 * - A vanished R2 content object answers 404 (the honest-404 sole-sweeper
 *   posture every landed download arm carries) where upstream's
 *   OpenFileForDownload failure would map 500 — unreachable through the
 *   upload path, the families' documented stance.
 * - A duplicate FILE row (reachable only if a prior walk died between the
 *   version row and the file row) hits the DEFAULT arm → 500 — the goproxy
 *   module-header note.
 * - JSON rendering uses JSON.stringify (no Go Marshal HTML escaping) — the
 *   landed families' wire posture.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageProperties, packageVersions, packages } from "../../db/schema";
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
  searchVersions,
  tryInsertFile,
} from "./model";
import { getOrInsertBlob } from "./blobs";
import {
  packageBlobContentKey,
  packageBlobSpoolKey,
  copySpoolToContentKey,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import { getPackageProperties, isValidAbsoluteHttpUrl, writeVersionMetadata } from "./protocol-common";

// ---------------------------------------------------------------------------
// Upstream sentinels (metadata.go:23-26 + swift.go's error arms)
// ---------------------------------------------------------------------------

/** ErrMissingManifestFile (metadata.go:23) → 400. */
export class SwiftMissingManifestFileError extends Error {
  constructor() {
    super("Package.swift file is missing");
    this.name = "SwiftMissingManifestFileError";
  }
}

/** ErrManifestFileTooLarge (metadata.go:24) → 400. */
export class SwiftManifestFileTooLargeError extends Error {
  constructor() {
    super("Package.swift file is too large");
    this.name = "SwiftManifestFileTooLargeError";
  }
}

/** ErrManifestFilesTooLarge (metadata.go:25) → 400. */
export class SwiftManifestFilesTooLargeError extends Error {
  constructor() {
    super("Package.swift files are too large");
    this.name = "SwiftManifestFilesTooLargeError";
  }
}

/** ErrInvalidManifestVersion (metadata.go:26) → 400. */
export class SwiftInvalidManifestVersionError extends Error {
  constructor() {
    super("manifest version is invalid");
    this.name = "SwiftInvalidManifestVersionError";
  }
}

/** The upload's URL-version NewSemver failure (swift.go:328-333) → 400; the
 *  Problem detail IS go-version's error text ("malformed version: X"). */
export class SwiftInvalidVersionError extends Error {
  constructor(readonly version: string) {
    super(`malformed version: ${version}`);
    this.name = "SwiftInvalidVersionError";
  }
}

/** A scope-pattern miss (swift.go:330) → 400 with the EMPTY detail (nil err). */
export class SwiftInvalidScopeError extends Error {
  constructor() {
    super("");
    this.name = "SwiftInvalidScopeError";
  }
}

/** A name-pattern miss (swift.go:330) → 400 with the EMPTY detail. */
export class SwiftInvalidNameError extends Error {
  constructor() {
    super("");
    this.name = "SwiftInvalidNameError";
  }
}

/** The missing "source-archive" form part (swift.go:336-339) → 400. */
export class SwiftMissingSourceArchiveError extends Error {
  constructor() {
    super("unable to read source-archive file");
    this.name = "SwiftMissingSourceArchiveError";
  }
}

/** ErrPackageNotExist on the resolve misses → 404. */
export class SwiftPackageNotExistError extends Error {
  constructor() {
    super("package does not exist");
    this.name = "SwiftPackageNotExistError";
  }
}

/** ErrDuplicatePackageVersion (swift.go:401-402) → 409. */
export class SwiftDuplicateVersionError extends Error {
  constructor(readonly existing: PackageVersionRow) {
    super("package version already exists");
    this.name = "SwiftDuplicateVersionError";
  }
}

/** zip.NewReader's plain failure / the bomb gate — the DEFAULT arm → 500. */
export class SwiftInvalidArchiveError extends Error {
  constructor() {
    super("zip: not a valid zip file");
    this.name = "SwiftInvalidArchiveError";
  }
}

// ---------------------------------------------------------------------------
// Upstream constants
// ---------------------------------------------------------------------------

/** The registry media types (swift.go:32-36, Registry.md §3.5). */
export const SWIFT_ACCEPT_JSON = "application/vnd.swift.registry.v1+json";
export const SWIFT_ACCEPT_SWIFT = "application/vnd.swift.registry.v1+swift";
export const SWIFT_ACCEPT_ZIP = "application/vnd.swift.registry.v1+zip";

/** The property names (metadata.go:37-39). */
export const SWIFT_PROPERTY_SCOPE = "swift.scope";
export const SWIFT_PROPERTY_NAME = "swift.name";
export const SWIFT_PROPERTY_REPOSITORY_URL = "swift.repository_url";

/** maxManifestFileSize (metadata.go:33) — the RECORDED uncompressed size. */
export const MAX_SWIFT_MANIFEST_FILE_SIZE = 128 * 1024;

/** maxManifestFiles (metadata.go:34) — the SELECTED manifest count. */
export const MAX_SWIFT_MANIFEST_FILES = 64;

/** maxManifestSize (metadata.go:35) — the selected manifests' recorded total. */
export const MAX_SWIFT_MANIFEST_SIZE = MAX_SWIFT_MANIFEST_FILES * MAX_SWIFT_MANIFEST_FILE_SIZE;

/** packages.MaxMetadataSize (modules/packages/limited_reader.go:14). */
export const MAX_SWIFT_METADATA_BYTES = 32 * 1024 * 1024;

/** The multipart body parse cap — the parse-family reduction (module header). */
export const MAX_SWIFT_UPLOAD_BYTES = 64 * 1024 * 1024;

/**
 * The scope/name patterns (swift.go:40-42, Registry.md §3.6.1/2):
 * scope `\A[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\z`, name
 * `\A[a-zA-Z0-9][a-zA-Z0-9-_]{0,99}\z`.
 */
const SWIFT_SCOPE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/;
const SWIFT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-_]{0,99}$/;

export function isSwiftScopeValid(scope: string): boolean {
  return SWIFT_SCOPE_PATTERN.test(scope);
}

export function isSwiftNameValid(name: string): boolean {
  return SWIFT_NAME_PATTERN.test(name);
}

export function buildSwiftPackageID(scope: string, name: string): string {
  return `${scope}.${name}`;
}

// ---------------------------------------------------------------------------
// hashicorp/go-version v1.9.0 — the port (version.go at the pin's go.mod)
// ---------------------------------------------------------------------------

/** The parsed version: `segments` is the FULL unpadded split (Segments64),
 *  `si` the original segment count, `pre`/`metadata` WITHOUT their
 *  separators (v.pre / v.metadata). */
export interface SwiftVersion {
  segments: number[];
  si: number;
  pre: string;
  metadata: string;
  original: string;
}

/**
 * VersionRegexpRaw + SemverRegexpRaw (version.go:40-49). Group indices are
 * Go's open-paren order: [1] core, [4] digit-start prerelease, [7]
 * letter-start prerelease (the lax pattern's second alternative carries
 * `-?`), [10] build metadata. Both are anchored and end with the dangling
 * `?` (a lazy-optional no-op under the anchors — kept verbatim).
 */
const SWIFT_VERSION_SEMVER_PATTERN =
  /^v?([0-9]+(\.[0-9]+)*?)(-([0-9]+[0-9A-Za-z-~]*(\.[0-9A-Za-z-~]+)*)|(-([A-Za-z-~]+[0-9A-Za-z-~]*(\.[0-9A-Za-z-~]+)*)))?(\+([0-9A-Za-z-~]+(\.[0-9A-Za-z-~]+)*))??$/;
const SWIFT_VERSION_LAX_PATTERN =
  /^v?([0-9]+(\.[0-9]+)*?)(-([0-9]+[0-9A-Za-z-~]*(\.[0-9A-Za-z-~]+)*)|(-?([A-Za-z-~]+[0-9A-Za-z-~]*(\.[0-9A-Za-z-~]+)*)))?(\+([0-9A-Za-z-~]+(\.[0-9A-Za-z-~]+)*))??$/;

/** newVersion (version.go:115-151) over one of the two patterns. */
function parseSwiftVersionWith(pattern: RegExp, v: string): SwiftVersion | null {
  const matches = pattern.exec(v);
  if (matches === null) return null;
  const segmentsStr = (matches[1] ?? "").split(".");
  const segments = segmentsStr.map((part) => Number.parseInt(part, 10));
  let pre = matches[7] ?? "";
  if (pre === "") {
    pre = matches[4] ?? "";
  }
  return {
    segments,
    si: segmentsStr.length,
    pre,
    metadata: matches[10] ?? "",
    original: v,
  };
}

/** `version.NewSemver` (SemverRegexpRaw — the strict prerelease separator). */
export function parseSwiftVersionStrict(v: string): SwiftVersion | null {
  return parseSwiftVersionWith(SWIFT_VERSION_SEMVER_PATTERN, v);
}

/** `version.NewVersion` (VersionRegexpRaw — the lax `-?` letter form). */
export function parseSwiftVersionLax(v: string): SwiftVersion | null {
  return parseSwiftVersionWith(SWIFT_VERSION_LAX_PATTERN, v);
}

/** `Version.String()` (version.go:436-460) — segments zero-padded to three,
 *  canonicalized (no `v`, no leading zeros), pre/metadata re-attached. */
export function swiftVersionString(v: SwiftVersion): string {
  const padded = [...v.segments];
  while (padded.length < 3) padded.push(0);
  let out = padded.map((segment) => String(segment)).join(".");
  if (v.pre !== "") out += `-${v.pre}`;
  if (v.metadata !== "") out += `+${v.metadata}`;
  return out;
}

/** `TrimmedVersionString` (metadata.go:248-257) — major.minor, plus .patch
 *  only when non-zero (pre/metadata dropped). */
export function swiftTrimmedVersionString(v: SwiftVersion): string {
  const s0 = v.segments[0] ?? 0;
  const s1 = v.segments[1] ?? 0;
  const s2 = v.segments[2] ?? 0;
  let out = `${s0}.${s1}`;
  if (s2 !== 0) out += `.${s2}`;
  return out;
}

/** comparePart (version.go:261-306) — go-version's own prerelease-part
 *  rules, quirks included (an empty part sorts below a numeric other and
 *  ABOVE a non-numeric one; numeric sorts below non-numeric; the rest
 *  lexical/numeric). */
function swiftComparePart(preSelf: string, preOther: string): number {
  if (preSelf === preOther) return 0;
  const selfInt = /^-?\d+$/.test(preSelf) ? Number.parseInt(preSelf, 10) : NaN;
  const selfNumeric = !Number.isNaN(selfInt);
  const otherInt = /^-?\d+$/.test(preOther) ? Number.parseInt(preOther, 10) : NaN;
  const otherNumeric = !Number.isNaN(otherInt);
  if (preSelf === "") {
    return otherNumeric ? -1 : 1;
  }
  if (preOther === "") {
    return selfNumeric ? 1 : -1;
  }
  if (selfNumeric && !otherNumeric) return -1;
  if (!selfNumeric && otherNumeric) return 1;
  if (!selfNumeric && !otherNumeric && preSelf > preOther) return 1;
  if (selfInt > otherInt) return 1;
  return -1;
}

/** comparePrereleases (version.go:308-346) — the dot-split walk over the
 *  longer part list, empty-tail parts compared per comparePart. */
function swiftComparePrereleases(selfPre: string, otherPre: string): number {
  if (selfPre === otherPre) return 0;
  const selfParts = selfPre.split(".");
  const otherParts = otherPre.split(".");
  const biggest = Math.max(selfParts.length, otherParts.length);
  for (let i = 0; i < biggest; i++) {
    const partSelf = selfParts[i] ?? "";
    const partOther = otherParts[i] ?? "";
    const compare = swiftComparePart(partSelf, partOther);
    if (compare !== 0) return compare;
  }
  return 0;
}

function swiftAllZero(segments: number[]): boolean {
  return segments.every((segment) => segment === 0);
}

/** `Version.Compare` (version.go:169-235) — the String() equality
 *  short-circuit, the equal-segments prerelease walk, then the jagged
 *  segment compare (a shorter array loses only if the other's tail is
 *  non-zero). */
export function swiftCompareVersions(self: SwiftVersion, other: SwiftVersion): number {
  if (swiftVersionString(self) === swiftVersionString(other)) return 0;
  const selfSegments = self.segments;
  const otherSegments = other.segments;
  const equalSegments =
    selfSegments.length === otherSegments.length && selfSegments.every((s, i) => s === otherSegments[i]);
  if (equalSegments) {
    if (self.pre === "" && other.pre === "") return 0;
    if (self.pre === "") return 1;
    if (other.pre === "") return -1;
    return swiftComparePrereleases(self.pre, other.pre);
  }
  const highest = Math.max(selfSegments.length, otherSegments.length);
  for (let i = 0; i < highest; i++) {
    if (i > selfSegments.length - 1) {
      if (!swiftAllZero(otherSegments.slice(i))) return -1;
      break;
    }
    if (i > otherSegments.length - 1) {
      if (!swiftAllZero(selfSegments.slice(i))) return 1;
      break;
    }
    const lhs = selfSegments[i] as number;
    const rhs = otherSegments[i] as number;
    if (lhs === rhs) continue;
    if (lhs < rhs) return -1;
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The zip reader — EOCD + central-directory walk (the goproxy idiom,
// re-landed self-contained: stored + deflate-raw, the bomb gate, zip64 out
// of scope under the 64 MiB parse cap)
// ---------------------------------------------------------------------------

interface SwiftZipEntryRaw {
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
async function zipExtractEntry(bytes: Uint8Array, entry: SwiftZipEntryRaw): Promise<Uint8Array> {
  if (entry.localHeaderOffset + 30 > bytes.byteLength || zipU32(bytes, entry.localHeaderOffset) !== ZIP_LOCAL_SIGNATURE) {
    throw new SwiftInvalidArchiveError();
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
      throw new SwiftInvalidArchiveError();
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
        throw new SwiftInvalidArchiveError();
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
  throw new SwiftInvalidArchiveError();
}

/** The central-directory walk; a missing EOCD or a bad signature is
 *  zip.NewReader's failure. */
function readSwiftZipEntries(bytes: Uint8Array): SwiftZipEntryRaw[] {
  const window = Math.min(bytes.byteLength, 22 + 65535);
  let eocdAt = -1;
  for (let i = bytes.byteLength - 22; i >= bytes.byteLength - window; i--) {
    if (zipU32(bytes, i) === ZIP_EOCD_SIGNATURE) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0 || bytes.byteLength - eocdAt < 22) {
    throw new SwiftInvalidArchiveError();
  }
  const entryCount = zipU16(bytes, eocdAt + 10);
  const cdSize = zipU32(bytes, eocdAt + 12);
  const cdOffset = zipU32(bytes, eocdAt + 16);
  if (cdOffset + cdSize > bytes.byteLength) {
    throw new SwiftInvalidArchiveError();
  }
  const entries: SwiftZipEntryRaw[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > bytes.byteLength || zipU32(bytes, cursor) !== ZIP_CD_SIGNATURE) {
      throw new SwiftInvalidArchiveError();
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
// Go path.Dir / path.Base over zip entry names (the goproxy twins)
// ---------------------------------------------------------------------------

function goPathCleanDir(dir: string): string {
  if (dir === "") return ".";
  const trimmed = dir.replace(/\/+$/, "");
  if (trimmed === "") return dir.startsWith("/") ? "/" : ".";
  return trimmed;
}

function goPathDir(name: string): string {
  const at = name.lastIndexOf("/");
  if (at < 0) return ".";
  return goPathCleanDir(name.slice(0, at + 1));
}

function goPathBase(name: string): string {
  if (name === "") return ".";
  let end = name.length;
  while (end > 0 && name[end - 1] === "/") end -= 1;
  const start = name.lastIndexOf("/", end - 1) + 1;
  const base = name.slice(start, end);
  return base === "" ? "/" : base;
}

// ---------------------------------------------------------------------------
// The metadata shapes (metadata.go:42-115)
// ---------------------------------------------------------------------------

/** Manifest (metadata.go:60-63) — the tools_version omitempty twin. */
export interface SwiftManifest {
  content: string;
  toolsVersion: string;
}

/** Person (metadata.go:89-95) — the four name parts (no @type in the STORED
 *  form; the response builder adds it). */
export interface SwiftPerson {
  name: string;
  givenName: string;
  middleName: string;
  familyName: string;
}

/** Metadata (metadata.go:49-57) — the stored shape (upstream tag order when
 *  serialized). */
export interface SwiftMetadata {
  description: string;
  keywords: string[];
  repositoryURL: string;
  license: string;
  licenseURL: string;
  author: SwiftPerson;
  manifests: Record<string, SwiftManifest>;
}

/** Package (metadata.go:43-46) — ParsePackage's answer. */
export interface SwiftPackage {
  repositoryURLs: string[];
  metadata: SwiftMetadata;
}

/** The zero-value Metadata (ParsePackage's initial shape). */
function emptySwiftMetadata(): SwiftMetadata {
  return { description: "", keywords: [], repositoryURL: "", license: "", licenseURL: "", author: { name: "", givenName: "", middleName: "", familyName: "" }, manifests: {} };
}

/** `Person.String()` (metadata.go:97-115) — given/middle/family joined by
 *  single spaces. */
function swiftPersonString(person: SwiftPerson): string {
  return [person.givenName, person.middleName, person.familyName]
    .filter((part) => part !== "")
    .join(" ");
}

const SWIFT_MANIFEST_PATTERN = /^Package(?:@swift-(\d+(?:\.\d+)?(?:\.\d+)?))?\.swift$/;
const SWIFT_TOOLS_VERSION_PATTERN = /^\/\/ swift-tools-version:(\d+(?:\.\d+)?(?:\.\d+)?)/;

/**
 * `ParsePackage` (metadata.go:118-245): the SELECTED manifest set is the
 * shallowest manifest directory (ties by dir name, never archive order —
 * the nested-package rule), keyed by the TRIMMED `@swift-X.Y.Z` version;
 * the default (no-suffix) manifest MUST exist. Caps ride the RECORDED
 * uncompressed sizes. The optional metadata form part decodes as the
 * schema.org SoftwareSourceCode document (Go's case-insensitive field
 * fallback reproduced), URLs validated, author Name synthesized from its
 * parts when absent.
 */
export async function parseSwiftPackage(zipBytes: Uint8Array, metadataBytes: Uint8Array | null): Promise<SwiftPackage> {
  const entries = readSwiftZipEntries(zipBytes);

  const result: SwiftPackage = { repositoryURLs: [], metadata: emptySwiftMetadata() };
  const manifests = result.metadata.manifests;

  // Nested packages (test fixtures, examples, benchmarks) ship their own
  // manifests, which must not replace the package manifest. The package sits
  // at the archive root or in a single top level directory, so keep only the
  // shallowest manifest directory, breaking ties by name for stability
  // (metadata.go:130-146).
  let manifestFiles: SwiftZipEntryRaw[] | null = null;
  let manifestDir = "";
  let manifestDepth = 0;
  for (const file of entries) {
    if (file.name.endsWith("/") || !SWIFT_MANIFEST_PATTERN.test(goPathBase(file.name))) {
      continue;
    }
    const dir = goPathDir(file.name);
    const depth = (file.name.match(/\//g) ?? []).length;
    if (manifestFiles === null || depth < manifestDepth || (depth === manifestDepth && dir < manifestDir)) {
      manifestDir = dir;
      manifestDepth = depth;
      manifestFiles = [file];
    } else if (dir === manifestDir) {
      manifestFiles.push(file);
    }
  }
  const selected = manifestFiles ?? [];
  if (selected.length > MAX_SWIFT_MANIFEST_FILES) {
    throw new SwiftManifestFilesTooLargeError();
  }
  let manifestSize = 0;
  for (const file of selected) {
    manifestSize += file.uncompressedSize;
  }
  if (manifestSize > MAX_SWIFT_MANIFEST_SIZE) {
    throw new SwiftManifestFilesTooLargeError();
  }

  for (const file of selected) {
    const manifestMatch = SWIFT_MANIFEST_PATTERN.exec(goPathBase(file.name));
    if (file.uncompressedSize > MAX_SWIFT_MANIFEST_FILE_SIZE) {
      throw new SwiftManifestFileTooLargeError();
    }
    const content = new TextDecoder().decode(await zipExtractEntry(zipBytes, file));

    let swiftVersion = "";
    const captured = manifestMatch?.[1];
    if (captured !== undefined && captured !== "") {
      const v = parseSwiftVersionStrict(captured);
      if (v === null) {
        throw new SwiftInvalidManifestVersionError();
      }
      swiftVersion = swiftTrimmedVersionString(v);
    }

    const manifest: SwiftManifest = { content, toolsVersion: "" };
    const toolsMatch = SWIFT_TOOLS_VERSION_PATTERN.exec(manifest.content);
    const toolsCaptured = toolsMatch?.[1];
    if (toolsCaptured !== undefined) {
      const v = parseSwiftVersionStrict(toolsCaptured);
      if (v === null) {
        throw new SwiftInvalidManifestVersionError();
      }
      manifest.toolsVersion = swiftTrimmedVersionString(v);
    }

    manifests[swiftVersion] = manifest;
  }

  if (manifests[""] === undefined) {
    throw new SwiftMissingManifestFileError();
  }

  if (metadataBytes !== null) {
    // packages.NewLimitedReader(mr, MaxMetadataSize): a bigger document
    // truncates mid-decode upstream — the 500 default arm; ours throws here.
    if (metadataBytes.byteLength > MAX_SWIFT_METADATA_BYTES) {
      throw new Error("metadata form part exceeds the 32 MiB metadata limit");
    }
    const ssc = decodeSwiftSourceCode(new TextDecoder().decode(metadataBytes));
    result.metadata.description = ssc.description;
    result.metadata.keywords = ssc.keywords;
    result.metadata.license = ssc.license;
    result.metadata.licenseURL = isValidAbsoluteHttpUrl(ssc.licenseURL) ? ssc.licenseURL : "";
    result.metadata.repositoryURL = isValidAbsoluteHttpUrl(ssc.codeRepository) ? ssc.codeRepository : "";
    const author: SwiftPerson = {
      name: ssc.authorName,
      givenName: ssc.authorGivenName,
      middleName: ssc.authorMiddleName,
      familyName: ssc.authorFamilyName,
    };
    // If Name is not provided, generate it from individual name components
    // (metadata.go:226-229).
    if (author.name === "") {
      author.name = swiftPersonString(author);
    }
    result.metadata.author = author;
    result.repositoryURLs = ssc.repositoryURLs;
  }

  return result;
}

// ---------------------------------------------------------------------------
// The metadata JSON decode — Go encoding/json's case-insensitive field
// fallback (a miss on the exact tag folds case for the whole object)
// ---------------------------------------------------------------------------

interface SwiftSourceCodeDecoded {
  description: string;
  keywords: string[];
  repositoryURLs: string[];
  license: string;
  licenseURL: string;
  codeRepository: string;
  authorName: string;
  authorGivenName: string;
  authorMiddleName: string;
  authorFamilyName: string;
}

/** Go's field lookup: the exact tag first, else the first case-insensitive
 *  fold match (json.Unmarshal's conflict resolution). */
function pickSwiftField(obj: Record<string, unknown>, key: string): unknown {
  if (obj[key] !== undefined) return obj[key];
  const lower = key.toLowerCase();
  for (const candidate of Object.keys(obj)) {
    if (candidate.toLowerCase() === lower) return obj[candidate];
  }
  return undefined;
}

function pickSwiftString(obj: Record<string, unknown>, key: string): string {
  const value = pickSwiftField(obj, key);
  return typeof value === "string" ? value : "";
}

function pickSwiftStringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = pickSwiftField(obj, key);
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "string" ? entry : ""));
}

function decodeSwiftSourceCode(text: string): SwiftSourceCodeDecoded {
  // json.Decoder.Decode: an EMPTY document is io.EOF — the 500 default arm.
  const parsed = JSON.parse(text) as unknown;
  const obj = (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  const author = pickSwiftField(obj, "author");
  const authorObj =
    author !== null && typeof author === "object" && !Array.isArray(author)
      ? (author as Record<string, unknown>)
      : {};
  return {
    description: pickSwiftString(obj, "description"),
    keywords: pickSwiftStringArray(obj, "keywords"),
    repositoryURLs: pickSwiftStringArray(obj, "repositoryURLs"),
    license: pickSwiftString(obj, "license"),
    licenseURL: pickSwiftString(obj, "licenseURL"),
    codeRepository: pickSwiftString(obj, "codeRepository"),
    authorName: pickSwiftString(authorObj, "name"),
    authorGivenName: pickSwiftString(authorObj, "givenName"),
    authorMiddleName: pickSwiftString(authorObj, "middleName"),
    authorFamilyName: pickSwiftString(authorObj, "familyName"),
  };
}

/** The Metadata JSON serialization — upstream's tag order (description,
 *  keywords, repository_url, license, license_url, author, manifests) with
 *  the omitempty fields and Go's sorted-map key order for manifests. */
export function serializeSwiftMetadata(metadata: SwiftMetadata): string {
  const parts: string[] = [];
  if (metadata.description !== "") parts.push(`"description":${JSON.stringify(metadata.description)}`);
  if (metadata.keywords.length > 0) parts.push(`"keywords":${JSON.stringify(metadata.keywords)}`);
  if (metadata.repositoryURL !== "") parts.push(`"repository_url":${JSON.stringify(metadata.repositoryURL)}`);
  if (metadata.license !== "") parts.push(`"license":${JSON.stringify(metadata.license)}`);
  if (metadata.licenseURL !== "") parts.push(`"license_url":${JSON.stringify(metadata.licenseURL)}`);
  const authorParts: string[] = [];
  if (metadata.author.name !== "") authorParts.push(`"name":${JSON.stringify(metadata.author.name)}`);
  if (metadata.author.givenName !== "") authorParts.push(`"givenName":${JSON.stringify(metadata.author.givenName)}`);
  if (metadata.author.middleName !== "") authorParts.push(`"middleName":${JSON.stringify(metadata.author.middleName)}`);
  if (metadata.author.familyName !== "") authorParts.push(`"familyName":${JSON.stringify(metadata.author.familyName)}`);
  parts.push(`"author":{${authorParts.join(",")}}`);
  const manifestKeys = Object.keys(metadata.manifests).sort();
  const manifestParts = manifestKeys.map((key) => {
    const manifest = metadata.manifests[key] as SwiftManifest;
    const fields = [`"content":${JSON.stringify(manifest.content)}`];
    if (manifest.toolsVersion !== "") fields.push(`"tools_version":${JSON.stringify(manifest.toolsVersion)}`);
    return `${JSON.stringify(key)}:{${fields.join(",")}}`;
  });
  parts.push(`"manifests":{${manifestParts.join(",")}}`);
  return `{${parts.join(",")}}`;
}

// ---------------------------------------------------------------------------
// The multipart / urlencoded form walk — formFileOptionalReadCloser
// (swift.go:306-320): the FILE part first, else the plain VALUE part
// ---------------------------------------------------------------------------

export interface SwiftUploadForm {
  /** The "source-archive" bytes; `isFile` marks a filename-bearing part. */
  archive: Uint8Array | null;
  archiveIsFile: boolean;
  /** The raw "metadata" part bytes; null when absent/empty. */
  metadata: Uint8Array | null;
  metadataIsFile: boolean;
}

/** Content-Disposition: form-data; name="x"; filename="y" (quoted or bare). */
function parseContentDisposition(value: string): { name: string; filename: string } {
  let name = "";
  let filename = "";
  for (const rawParam of value.split(";")) {
    const param = rawParam.trim();
    const eqAt = param.indexOf("=");
    if (eqAt < 0) continue;
    const key = param.slice(0, eqAt).trim().toLowerCase();
    let val = param.slice(eqAt + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    if (key === "name") name = val;
    if (key === "filename") filename = val;
  }
  return { name, filename };
}

function indexOfSubsequence(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0) return from;
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** The multipart walk over the materialized body. */
function parseSwiftMultipart(contentType: string, bytes: Uint8Array): SwiftUploadForm {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? "").trim();
  const form: SwiftUploadForm = { archive: null, archiveIsFile: false, metadata: null, metadataIsFile: false };
  if (boundary === "") return form;
  const delimiter = new TextEncoder().encode(`--${boundary}`);

  let cursor = indexOfSubsequence(bytes, delimiter, 0);
  while (cursor !== -1) {
    let partStart = cursor + delimiter.length;
    // The closing delimiter "--" ends the walk.
    if (bytes[partStart] === 0x2d && bytes[partStart + 1] === 0x2d) break;
    if (bytes[partStart] === 0x0d && bytes[partStart + 1] === 0x0a) partStart += 2;
    const next = indexOfSubsequence(bytes, delimiter, partStart);
    if (next === -1) break;
    // The part body ends at the CRLF that precedes the next delimiter.
    let partEnd = next;
    if (partEnd >= 2 && bytes[partEnd - 2] === 0x0d && bytes[partEnd - 1] === 0x0a) partEnd -= 2;
    const partBytes = bytes.subarray(partStart, partEnd);
    // Headers end at the first CRLFCRLF.
    const headerEnd = indexOfSubsequence(partBytes, new TextEncoder().encode("\r\n\r\n"), 0);
    if (headerEnd !== -1) {
      const headerText = new TextDecoder("latin1").decode(partBytes.subarray(0, headerEnd));
      const body = partBytes.slice(headerEnd + 4);
      let name = "";
      let filename = "";
      for (const line of headerText.split("\r\n")) {
        const colonAt = line.indexOf(":");
        if (colonAt < 0) continue;
        const key = line.slice(0, colonAt).trim().toLowerCase();
        if (key !== "content-disposition") continue;
        const parsed = parseContentDisposition(line.slice(colonAt + 1));
        name = parsed.name;
        filename = parsed.filename;
      }
      if (name === "source-archive" && form.archive === null) {
        if (filename !== "") {
          form.archive = body;
          form.archiveIsFile = true;
        } else if (!form.archiveIsFile && body.byteLength > 0) {
          // An empty VALUE part is FormValue's "" → the nil reader
          // (swift.go:316-319) — absent, not an empty archive.
          form.archive = body;
        }
      }
      if (name === "metadata" && form.metadata === null) {
        if (filename !== "") {
          form.metadata = body;
          form.metadataIsFile = true;
        } else if (!form.metadataIsFile && body.byteLength > 0) {
          form.metadata = body;
        }
      }
    }
    cursor = next;
  }
  return form;
}

/** The urlencoded fallback (Go's FormValue path — a non-multipart body). */
function parseSwiftUrlencoded(bytes: Uint8Array): SwiftUploadForm {
  const text = new TextDecoder().decode(bytes);
  const params = new URLSearchParams(text);
  const archive = params.get("source-archive");
  const metadata = params.get("metadata");
  return {
    archive: archive === null ? null : new TextEncoder().encode(archive),
    archiveIsFile: false,
    metadata: metadata === null || metadata === "" ? null : new TextEncoder().encode(metadata),
    metadataIsFile: false,
  };
}

export function parseSwiftUploadForm(contentType: string, bytes: Uint8Array): SwiftUploadForm {
  if (/multipart\/form-data/i.test(contentType)) {
    return parseSwiftMultipart(contentType, bytes);
  }
  return parseSwiftUrlencoded(bytes);
}

// ---------------------------------------------------------------------------
// Upload — UploadPackageFile (swift.go:323-421) over CreatePackageAndAddFile
// ---------------------------------------------------------------------------

export interface UploadSwiftPackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  scope: string;
  name: string;
  version: string;
  /** The request content-type (multipart vs urlencoded dispatch). */
  contentType: string;
  /** The request body stream (spooled, never buffered raw). */
  content: ReadableStream<Uint8Array>;
  /** The declared Content-Length; `undefined` = a chunked body (D-2). */
  declaredLength: number | undefined;
  quota: PackagesQuotaConfig;
  now?: Date;
  /** Test seams. */
  maxBytes?: number;
  spoolKey?: string;
}

export interface UploadSwiftPackageResult {
  version: PackageVersionRow;
  file: PackageFileRow;
  blob: PackageBlobRow;
}

async function hashSwiftArchive(bytes: Uint8Array): Promise<{ sha1: string; sha256: string; sha512: string }> {
  const [sha1, sha256, sha512] = await Promise.all([
    crypto.subtle.digest("SHA-1", bytes.slice().buffer),
    crypto.subtle.digest("SHA-256", bytes.slice().buffer),
    crypto.subtle.digest("SHA-512", bytes.slice().buffer),
  ]);
  const hex = (buffer: ArrayBuffer): string => {
    let out = "";
    for (const byte of new Uint8Array(buffer)) out += byte.toString(16).padStart(2, "0");
    return out;
  };
  return { sha1: hex(sha1), sha256: hex(sha256), sha512: hex(sha512) };
}

/**
 * The swift upload's service walk (the goproxy parse-family idiom): the
 * scope/name/version gate has run at the route (upstream validates BEFORE
 * reading the body); then quota pre-checks → the body spool (bounded) → the
 * multipart/urlencoded parse → ParsePackage → get-or-insert package (type
 * "swift", name `scope.name`, semverCompatible) → version (duplicate → the
 * 409 sentinel) → MetadataJSON + the package properties (created-only) →
 * blob → the content-key pass → the ONE lead file `{name}-{version}.zip` →
 * the repositoryURL version properties (insert errors logged only —
 * swift.go:411-416). The spools never orphan on a failure inside the walk.
 */
export async function uploadSwiftPackage(input: UploadSwiftPackageInput): Promise<UploadSwiftPackageResult> {
  const now = input.now ?? new Date();
  // CheckCountQuotaExceeded rides the versionCreated branch — the +1
  // post-insert parity the landed families pin (admin bypass).
  if (!input.doer.isAdmin && input.quota.limitTotalOwnerCount > UNLIMITED_QUOTA) {
    const total = (await countVersions(input.d1, input.owner.id)) + 1;
    if (total > input.quota.limitTotalOwnerCount) {
      throw new QuotaTotalCountError();
    }
  }
  // Size quota: declared length pre-check; the chunked arm defers to
  // post-spool with the real size (the goproxy order).
  if (input.declaredLength !== undefined) {
    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "swift", input.declaredLength, input.quota);
  }

  const bodySpooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: input.maxBytes ?? MAX_SWIFT_UPLOAD_BYTES,
    spoolKey: input.spoolKey,
  });
  let archiveSpoolKey: string | null = null;

  try {
    if (input.declaredLength === undefined) {
      await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "swift", bodySpooled.size, input.quota);
    }
    const spoolObject = await input.bucket.get(bodySpooled.spoolKey);
    if (spoolObject === null) {
      throw new Error("swift upload spool object vanished");
    }
    const bodyBytes = new Uint8Array(await spoolObject.arrayBuffer());
    const form = parseSwiftUploadForm(input.contentType, bodyBytes);
    if (form.archive === null) {
      throw new SwiftMissingSourceArchiveError();
    }
    const archive = form.archive;

    const pck = await parseSwiftPackage(archive, form.metadata);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "swift",
      name: buildSwiftPackageID(input.scope, input.name),
      semverCompatible: true,
      now,
    });
    const { row: version, created: versionCreated } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: input.version,
      now,
    });
    if (!versionCreated) {
      throw new SwiftDuplicateVersionError(version);
    }

    // The metadata JSON + the package properties ride the created-only
    // branch (createPackageAndVersion).
    await writeVersionMetadata(input.d1, version.id, serializeSwiftMetadata(pck.metadata));
    await drizzle(input.d1)
      .insert(packageProperties)
      .values([
        { refType: PropertyType.Package, refId: pkg.id, name: SWIFT_PROPERTY_SCOPE, value: input.scope },
        { refType: PropertyType.Package, refId: pkg.id, name: SWIFT_PROPERTY_NAME, value: input.name },
      ])
      .run();

    const digests = await hashSwiftArchive(archive);
    const { row: blob, created: blobCreated } = await getOrInsertBlob(input.d1, {
      size: archive.byteLength,
      sha256: digests.sha256,
      sha1: digests.sha1,
      sha512: digests.sha512,
      now,
    });
    archiveSpoolKey = packageBlobSpoolKey(crypto.randomUUID());
    await input.bucket.put(archiveSpoolKey, archive.slice());
    const objectPresent = (await input.bucket.head(packageBlobContentKey(digests.sha256))) !== null;
    if (blobCreated || !objectPresent) {
      await copySpoolToContentKey(input.bucket, archiveSpoolKey, digests.sha256);
    } else {
      await input.bucket.delete(archiveSpoolKey);
    }
    archiveSpoolKey = null;

    // Filename `{name}-{version}.zip`, IsLead true (swift.go:390-397); a
    // duplicate row hits upstream's DEFAULT arm → 500 (the goproxy note).
    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: `${input.name}-${input.version}.zip`,
      isLead: true,
      now,
    });
    if (fileResult.outcome !== "created") {
      throw new Error("package file already exists");
    }

    // The repositoryURL version properties (swift.go:411-416) — insert
    // errors are logged, never fatal.
    for (const url of pck.repositoryURLs) {
      try {
        await drizzle(input.d1)
          .insert(packageProperties)
          .values({ refType: PropertyType.Version, refId: version.id, name: SWIFT_PROPERTY_REPOSITORY_URL, value: url })
          .run();
      } catch (error) {
        console.error("[packages-swift] repository_url property insert failed", error);
      }
    }

    return { version, file: fileResult.row, blob };
  } finally {
    await input.bucket.delete(bodySpooled.spoolKey).catch(() => undefined);
    if (archiveSpoolKey !== null) {
      await input.bucket.delete(archiveSpoolKey).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Read arms
// ---------------------------------------------------------------------------

/**
 * `EnumeratePackageVersions`' version set (swift.go:129): GetVersionsByPackageName
 * = SearchVersions EXACT-match on the lower-cased id, IsInternal false —
 * sorted by SemVer.LessThan ASC (the handler's sort.Slice; ours adds the id
 * tiebreak for determinism).
 */
export async function listSwiftPackageVersions(
  d1: D1Database,
  ownerId: number,
  scope: string,
  name: string,
): Promise<PackageVersionRow[]> {
  const found = await searchVersions(d1, {
    ownerId,
    type: "swift",
    name: buildSwiftPackageID(scope, name),
    exact: true,
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });
  const sorted = [...found.rows].sort((a, b) => {
    const av = parseSwiftVersionStrict(a.version.version);
    const bv = parseSwiftVersionStrict(b.version.version);
    if (av !== null && bv !== null) {
      const compare = swiftCompareVersions(av, bv);
      if (compare !== 0) return compare;
    }
    return a.version.id - b.version.id;
  });
  return sorted.map((row) => row.version);
}

/** `GetVersionByNameAndVersion` (the resolve pair of the read arms). */
export async function resolveSwiftVersion(
  d1: D1Database,
  ownerId: number,
  scope: string,
  name: string,
  version: string,
): Promise<PackageVersionRow | null> {
  return getVersionByNameAndVersion(d1, ownerId, "swift", buildSwiftPackageID(scope, name), version);
}

/** The read arms' descriptor: the ONE file + blob, the stored metadata, the
 *  package properties and the repositoryURL version properties (id order —
 *  upstream GetProperties order, package_property.go:60-70). Swift versions
 *  carry exactly ONE file (the upload writes one); any other count is the
 *  DEFAULT arm's 500 class (upstream indexes Files[0] unguarded). */
export interface SwiftVersionDescriptor {
  pkg: Awaited<ReturnType<typeof getOrInsertPackage>>["row"];
  version: PackageVersionRow;
  file: PackageFileRow;
  blob: PackageBlobRow;
  metadata: SwiftMetadata;
  scopeProperty: string;
  nameProperty: string;
  repositoryURLs: string[];
}

function deserializeSwiftMetadata(raw: string | null): SwiftMetadata {
  if (raw === null || raw === "") return emptySwiftMetadata();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const manifestsRaw = (parsed.manifests ?? {}) as Record<string, { content?: unknown; tools_version?: unknown }>;
    const manifests: Record<string, SwiftManifest> = {};
    for (const key of Object.keys(manifestsRaw)) {
      const entry = manifestsRaw[key];
      manifests[key] = {
        content: typeof entry?.content === "string" ? entry.content : "",
        toolsVersion: typeof entry?.tools_version === "string" ? entry.tools_version : "",
      };
    }
    const authorRaw = (parsed.author ?? {}) as Record<string, unknown>;
    return {
      description: typeof parsed.description === "string" ? parsed.description : "",
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map((entry) => (typeof entry === "string" ? entry : "")) : [],
      repositoryURL: typeof parsed.repository_url === "string" ? parsed.repository_url : "",
      license: typeof parsed.license === "string" ? parsed.license : "",
      licenseURL: typeof parsed.license_url === "string" ? parsed.license_url : "",
      author: {
        name: typeof authorRaw.name === "string" ? authorRaw.name : "",
        givenName: typeof authorRaw.givenName === "string" ? authorRaw.givenName : "",
        middleName: typeof authorRaw.middleName === "string" ? authorRaw.middleName : "",
        familyName: typeof authorRaw.familyName === "string" ? authorRaw.familyName : "",
      },
      manifests,
    };
  } catch {
    return emptySwiftMetadata();
  }
}

export async function getSwiftVersionDescriptor(
  d1: D1Database,
  ownerId: number,
  scope: string,
  name: string,
  version: string,
): Promise<SwiftVersionDescriptor | null> {
  const pv = await resolveSwiftVersion(d1, ownerId, scope, name, version);
  if (pv === null) return null;
  const pkgRow = (
    await drizzle(d1)
      .select()
      .from(packages)
      .where(eq(packages.id, pv.packageId))
      .get()
  );
  if (pkgRow === undefined) return null;
  const descriptors = await getFileDescriptors(d1, pv.id);
  const first = descriptors[0];
  if (descriptors.length !== 1 || first === undefined) {
    throw new Error("package file set is invalid");
  }
  const packageProps = await getPackageProperties(d1, PropertyType.Package, pkgRow.id);
  const versionProps = await getPackageProperties(d1, PropertyType.Version, pv.id);
  return {
    pkg: pkgRow,
    version: pv,
    file: first.file,
    blob: first.blob,
    metadata: deserializeSwiftMetadata(pv.metadataJson),
    scopeProperty: packageProps.find((property) => property.name === SWIFT_PROPERTY_SCOPE)?.value ?? "",
    nameProperty: packageProps.find((property) => property.name === SWIFT_PROPERTY_NAME)?.value ?? "",
    repositoryURLs: versionProps
      .filter((property) => property.name === SWIFT_PROPERTY_REPOSITORY_URL)
      .map((property) => property.value),
  };
}

/** `DownloadPackageFile`'s content walk — the R2 stream for the ONE lead
 *  file; the lead GET bumps the counter (HEAD never counts). Null = the
 *  vanished-content honest 404. */
export interface SwiftZipDownload {
  file: PackageFileRow;
  version: PackageVersionRow;
  blob: PackageBlobRow;
  stream: ReadableStream;
  size: number;
  created: Date;
}

export async function openSwiftZipForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  scope: string,
  name: string,
  version: string,
  method: "GET" | "HEAD",
): Promise<SwiftZipDownload | null> {
  const descriptor = await getSwiftVersionDescriptor(d1, owner.id, scope, name, version);
  if (descriptor === null) {
    throw new SwiftPackageNotExistError();
  }
  const object = await bucket.get(packageBlobContentKey(descriptor.blob.hashSha256));
  if (object === null) {
    return null;
  }
  if (descriptor.file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, descriptor.version.id);
  }
  return {
    file: descriptor.file,
    version: descriptor.version,
    blob: descriptor.blob,
    stream: object.body,
    size: object.size,
    created: descriptor.file.createdUnix,
  };
}

/**
 * `LookupPackageIdentifiers`' search (swift.go:472-479): SearchLatestVersions
 * over the swift.repository_url VERSION property — max(id) per package over
 * the property join, IsInternal false both columns, ordered created/id DESC
 * (the model's searchLatestVersions order).
 */
export async function lookupSwiftIdentifiers(d1: D1Database, ownerId: number, url: string): Promise<string[]> {
  const latestIds = drizzle(d1)
    .select({ id: sql<number>`max(${packageVersions.id})` })
    .from(packageProperties)
    .innerJoin(
      packageVersions,
      and(eq(packageProperties.refType, PropertyType.Version), eq(packageProperties.refId, packageVersions.id)),
    )
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      and(
        eq(packages.ownerId, ownerId),
        eq(packages.type, "swift"),
        eq(packages.isInternal, false),
        eq(packageVersions.isInternal, false),
        eq(packageProperties.name, SWIFT_PROPERTY_REPOSITORY_URL),
        eq(packageProperties.value, url),
      ),
    )
    .groupBy(packageVersions.packageId);
  const rows = await drizzle(d1)
    .select({ pkg: packages })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(inArray(packageVersions.id, latestIds))
    .orderBy(sql`${packageVersions.createdUnix} desc, ${packageVersions.id} desc`)
    .all();
  return rows.map((row) => row.pkg.name);
}

// ---------------------------------------------------------------------------
// Wire builders — the JSON documents (Go struct/map marshal order)
// ---------------------------------------------------------------------------

/** EnumeratePackageVersions' body — releases keyed by SemVer.String() with
 *  RAW-version URLs (swift.go:149-165); Go marshals the map key-sorted. */
export function buildSwiftEnumerateJson(baseURL: string, versions: PackageVersionRow[]): string {
  const entries = versions.map((version) => {
    const parsed = parseSwiftVersionStrict(version.version);
    return {
      key: parsed !== null ? swiftVersionString(parsed) : version.version,
      url: `${baseURL}${version.version}`,
    };
  });
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const releases = entries.map((entry) => `${JSON.stringify(entry.key)}:{"url":${JSON.stringify(entry.url)}}`);
  return `{"releases":{${releases.join(",")}}}`;
}

/** The metadata response document (PackageVersionMetadataResponse +
 *  SoftwareSourceCode — swift.go:168-251, declaration order). */
export function buildSwiftMetadataResponseJson(input: {
  id: string;
  version: string;
  checksum: string;
  metadata: SwiftMetadata;
  packageName: string;
  repositoryURLs: string[];
}): string {
  const m = input.metadata;
  const metaParts: string[] = [
    `"@context":["http://schema.org/"]`,
    `"@type":"SoftwareSourceCode"`,
    `"name":${JSON.stringify(input.packageName)}`,
    `"version":${JSON.stringify(input.version)}`,
  ];
  if (m.description !== "") metaParts.push(`"description":${JSON.stringify(m.description)}`);
  if (m.keywords.length > 0) metaParts.push(`"keywords":${JSON.stringify(m.keywords)}`);
  if (m.repositoryURL !== "") metaParts.push(`"codeRepository":${JSON.stringify(m.repositoryURL)}`);
  if (m.license !== "") metaParts.push(`"license":${JSON.stringify(m.license)}`);
  if (m.licenseURL !== "") metaParts.push(`"licenseURL":${JSON.stringify(m.licenseURL)}`);
  if (m.author.name !== "" || m.author.givenName !== "" || m.author.middleName !== "" || m.author.familyName !== "") {
    const authorParts = [`"@type":"Person"`];
    if (m.author.name !== "") authorParts.push(`"name":${JSON.stringify(m.author.name)}`);
    if (m.author.givenName !== "") authorParts.push(`"givenName":${JSON.stringify(m.author.givenName)}`);
    if (m.author.middleName !== "") authorParts.push(`"middleName":${JSON.stringify(m.author.middleName)}`);
    if (m.author.familyName !== "") authorParts.push(`"familyName":${JSON.stringify(m.author.familyName)}`);
    metaParts.push(`"author":{${authorParts.join(",")}}`);
  }
  metaParts.push(`"programmingLanguage":{"@type":"ComputerLanguage","name":"Swift","url":"https://swift.org"}`);
  if (input.repositoryURLs.length > 0) {
    metaParts.push(`"repositoryURLs":${JSON.stringify(input.repositoryURLs)}`);
  }
  return [
    `{"id":${JSON.stringify(input.id)}`,
    `"version":${JSON.stringify(input.version)}`,
    `"resources":[{"name":"source-archive","type":"application/zip","checksum":${JSON.stringify(input.checksum)}}]`,
    `"metadata":{${metaParts.join(",")}}}`,
  ].join(",");
}

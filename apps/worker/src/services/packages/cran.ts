/**
 * The CRAN package registry protocol service (SPEC-0016 §7 long tail) — the
 * service half of `/api/packages/{username}/cran/...` (upstream
 * routers/api/packages/cran/cran.go over CreatePackageOrAddFileToExisting /
 * SearchFile, packages.go:160/:594):
 *
 * - Upload (cran.go:113-206): PUT /src (source) and PUT /bin
 *   (?platform=&rversion= — the binary arm; a missing platform/rversion is
 *   the 400-nil arm, cran.go:141-144). The body parses as a .tar.gz (gzip
 *   magic) or .zip archive whose DESCRIPTION member (depth ≤ 1) feeds
 *   ParseDescription (modules/packages/cran/metadata.go:223-260); the FILE
 *   name is `{Package}_{Version}{.tar.gz|.zip}` (cran.go:185), IsLead true,
 *   and the file rides:
 *     · source: composite key "" (EmptyFileKey) + the property
 *       `cran.type=source` (one property);
 *     · binary: composite key `platform|rversion` + THREE properties
 *       (`cran.type=binary`, `cran.platform`, `cran.rversion` — the
 *       upstream property KEY SPELLINGS verbatim, metadata.go:16-18
 *       including the `cran.rvserion` typo);
 *   ANY duplicate file row is the 409 (no OverwriteExisting). A missing
 *   DESCRIPTION / an invalid name / an invalid version are the
 *   ErrInvalidArgument sentinels (→ 400).
 * - The PACKAGES index (cran.go:49-111): per-package LATEST version whose
 *   file matches the (type[, platform, rversion]) triple, ordered package
 *   name ASC (models/packages/cran/search.go:43-95 — the SQL join filters
 *   the properties, the R-version pick happens in GO via CompareVersions
 *   because "SQL can't order R version strings"); rendered as the R
 *   DESCRIPTION field blocks separated by blank lines — Package/Version/
 *   License?/Depends?/Imports?/LinkingTo?/Suggests?/NeedsCompilation
 *   (ALWAYS)/MD5sum. Empty → null (the route's 404). `.gz` answers the
 *   gzip'd body with application/x-gzip.
 * - Download (cran.go:208-253): SearchFile by (type, platform, rversion,
 *   filename) — the Archive/{package}/{filename} route shares the handler.
 *
 * Divergences (documented per AGENTS.md): the zip CRC is not verified (Go's
 * archive/zip verifies on read; the blob sha256 gates the bytes at the
 * store); MD5sum renders the EMPTY value (Workers' WebCrypto has no MD5 —
 * the landed blob-row note; upstream prints the hash_md5 hex);
 * NaturalSortCompare's x/text English collation for non-numeric parts
 * reduces to byte order (identical for the ASCII digit/dot alphabet the
 * ported version grammar admits).
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  type PackageBlobRow,
  type PackageDoer,
  type PackageFileRow,
  type PackageOwnerRow,
  type PackagesQuotaConfig,
  type PackageVersionRow,
  PropertyType,
  UNLIMITED_QUOTA,
  QuotaTotalCountError,
  checkSizeQuotaExceeded,
  countVersions,
  getFileDescriptors,
  getOrInsertPackage,
  getOrInsertVersion,
  tryInsertFile,
} from "./model";
import { packageFiles, packageProperties, packageVersions, packages } from "../../db/schema";
import {
  copySpoolToContentKey,
  getOrInsertBlob,
  packageBlobContentKey,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import { writeVersionMetadata } from "./protocol-common";
import { DuplicatePackageFileError } from "./generic";

import { readTarMembers } from "./distro-common";

// ---------------------------------------------------------------------------
// The module metadata (modules/packages/cran/metadata.go)
// ---------------------------------------------------------------------------

/** metadata.go:15-18 — the upstream KEY SPELLINGS verbatim (the
 *  `cran.rvserion` typo included — the property rows must spell it the
 *  same way the search filters do). */
export const CRAN_PROPERTY_TYPE = "cran.type";
export const CRAN_PROPERTY_PLATFORM = "cran.platform";
export const CRAN_PROPERTY_RVERSION = "cran.rvserion";

/** metadata.go:19-20. */
export const CRAN_TYPE_SOURCE = "source";
export const CRAN_TYPE_BINARY = "binary";

/** metadata.go:35-46 in the struct's json-tag order (omitempty on every
 *  field except needs_compilation). */
export interface CranMetadata {
  title: string;
  description: string;
  project_url: string[];
  license: string;
  authors: string[];
  depends: string[];
  imports: string[];
  suggests: string[];
  linking_to: string[];
  needs_compilation: boolean;
}

export interface CranPackage {
  name: string;
  version: string;
  /** ".tar.gz" | ".zip" — set by the parse's container arm. */
  fileExtension: string;
  metadata: CranMetadata;
}

// -- The parse errors (util.NewInvalidArgumentErrorf → the 400 arm) --------

export class CranMissingDescriptionError extends Error {
  constructor() {
    super("DESCRIPTION file is missing");
    this.name = "CranMissingDescriptionError";
  }
}

export class CranInvalidNameError extends Error {
  constructor() {
    super("package name is invalid");
    this.name = "CranInvalidNameError";
  }
}

export class CranInvalidVersionError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "CranInvalidVersionError";
  }
}

/** A structurally broken archive — upstream's gzip/tar/zip plain errors →
 *  the 500 default arm at the route. */
export class CranArchiveError extends Error {
  constructor() {
    super("the package archive could not be read");
    this.name = "CranArchiveError";
  }
}

// -- The DESCRIPTION field grammar (metadata.go:25-31) ----------------------

/** fieldPattern `\A\S+:` — a field header line starts a non-space run then ':'. */
const FIELD_PATTERN = /^[^\s:]+:/;
/** namePattern `[a-zA-Z][a-zA-Z0-9.]*[a-zA-Z0-9]` (≥ 2 chars). */
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9.]*[a-zA-Z0-9]$/;
/** versionPattern `[0-9]+(?:[.-][0-9]+)+`. */
const VERSION_PATTERN = /^[0-9]+(?:[.-][0-9]+)+$/;
/** authorReplacePattern `[\[\(].+?[\]\)]` — the parenthetical strip. */
const AUTHOR_REPLACE = /\[.*?\]|\(.*?\)/g;

/** packages.MaxMetadataSize (limited_reader.go:14). */
const MAX_DESCRIPTION_BYTES = 32 * 1024 * 1024;

/** splitAndTrim (metadata.go:255-261): Split ", " + TrimSpace each. */
function splitAndTrim(value: string): string[] {
  return value.split(", ").map((item) => item.trim());
}

/**
 * ParseDescription (metadata.go:223-260): the line walk where a NON-field
 * line continues the previous field (joined with a space); an empty line
 * is skipped. The recognized fields set the struct; Package/Version
 * validate their patterns (the ErrInvalidName/ErrInvalidVersion 400s).
 */
export function parseCranDescription(text: string): CranPackage {
  const pkg: CranPackage = {
    name: "",
    version: "",
    fileExtension: "",
    metadata: {
      title: "",
      description: "",
      project_url: [],
      license: "",
      authors: [],
      depends: [],
      imports: [],
      suggests: [],
      linking_to: [],
      needs_compilation: false,
    },
  };
  const setField = (data: string): void => {
    if (data === "") return;
    const colon = data.indexOf(":");
    if (colon === -1) return;
    const key = data.slice(0, colon).trim();
    const value = data.slice(colon + 1).trim();
    switch (key) {
      case "Package":
        if (!NAME_PATTERN.test(value)) throw new CranInvalidNameError();
        pkg.name = value;
        break;
      case "Version":
        if (!VERSION_PATTERN.test(value)) throw new CranInvalidVersionError();
        pkg.version = value;
        break;
      case "Title":
        pkg.metadata.title = value;
        break;
      case "Description":
        pkg.metadata.description = value;
        break;
      case "URL":
        pkg.metadata.project_url = splitAndTrim(value);
        break;
      case "License":
        pkg.metadata.license = value;
        break;
      case "Author":
        pkg.metadata.authors = splitAndTrim(value.replaceAll(AUTHOR_REPLACE, ""));
        break;
      case "Depends":
        pkg.metadata.depends = splitAndTrim(value);
        break;
      case "Imports":
        pkg.metadata.imports = splitAndTrim(value);
        break;
      case "Suggests":
        pkg.metadata.suggests = splitAndTrim(value);
        break;
      case "LinkingTo":
        pkg.metadata.linking_to = splitAndTrim(value);
        break;
      case "NeedsCompilation":
        pkg.metadata.needs_compilation = value === "yes";
        break;
    }
  };
  let buffer = "";
  for (const rawLine of text.slice(0, MAX_DESCRIPTION_BYTES).split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (line === "") continue;
    if (!FIELD_PATTERN.test(line)) {
      buffer += " " + line;
      continue;
    }
    setField(buffer);
    buffer = line;
  }
  setField(buffer);
  return pkg;
}

// ---------------------------------------------------------------------------
// The archive walk (metadata.go:63-220) — the gzip-magic dispatch
// ---------------------------------------------------------------------------

/** The depth-≤1 rule (metadata.go:99/:141): `strings.Count(name, "/") > 1`
 *  skips — a member in the archive ROOT or one directory down qualifies. */
function isShallowMember(name: string): boolean {
  return name.split("/").length - 1 <= 1;
}

export async function parseCranPackage(bytes: Uint8Array): Promise<CranPackage> {
  if (bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return parseCranPackageTarGz(bytes);
  }
  return parseCranPackageZip(bytes);
}

async function parseCranPackageTarGz(bytes: Uint8Array): Promise<CranPackage> {
  let inflated: Uint8Array;
  try {
    const stream = new Response(bytes.slice()).body?.pipeThrough(new DecompressionStream("gzip"));
    if (stream === undefined) throw new Error("no gzip stream");
    inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new CranArchiveError();
  }
  let members: ReturnType<typeof readTarMembers>;
  try {
    members = readTarMembers(inflated);
  } catch {
    throw new CranArchiveError();
  }
  for (const member of members) {
    if (!isShallowMember(member.name)) continue;
    if (member.name.split("/").pop() === "DESCRIPTION") {
      const parsed = parseCranDescription(new TextDecoder().decode(member.data.subarray(0, MAX_DESCRIPTION_BYTES)));
      parsed.fileExtension = ".tar.gz";
      return parsed;
    }
  }
  throw new CranMissingDescriptionError();
}

// -- The zip reader (self-contained; the swift walk's inverse) --------------

interface CranZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function zipU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function zipU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0
  );
}

const ZIP_EOCD = 0x06054b50;
const ZIP_CD = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

function readCranZipEntries(bytes: Uint8Array): CranZipEntry[] {
  const window = Math.min(bytes.byteLength, 22 + 65535);
  let eocdAt = -1;
  for (let i = bytes.byteLength - 22; i >= bytes.byteLength - window; i--) {
    if (zipU32(bytes, i) === ZIP_EOCD) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0 || bytes.byteLength - eocdAt < 22) throw new CranArchiveError();
  const entryCount = zipU16(bytes, eocdAt + 10);
  const cdSize = zipU32(bytes, eocdAt + 12);
  const cdOffset = zipU32(bytes, eocdAt + 16);
  if (cdOffset + cdSize > bytes.byteLength) throw new CranArchiveError();
  const entries: CranZipEntry[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > bytes.byteLength || zipU32(bytes, cursor) !== ZIP_CD) throw new CranArchiveError();
    const flags = zipU16(bytes, cursor + 8);
    const nameLength = zipU16(bytes, cursor + 28);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    entries.push({
      name: (flags & 0x800) !== 0 ? new TextDecoder().decode(nameBytes) : latin1(nameBytes),
      method: zipU16(bytes, cursor + 10),
      compressedSize: zipU32(bytes, cursor + 20),
      uncompressedSize: zipU32(bytes, cursor + 24),
      localHeaderOffset: zipU32(bytes, cursor + 42),
    });
    cursor += 46 + nameLength + zipU16(bytes, cursor + 30) + zipU16(bytes, cursor + 32);
  }
  return entries;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

async function zipExtract(bytes: Uint8Array, entry: CranZipEntry): Promise<Uint8Array> {
  if (entry.localHeaderOffset + 30 > bytes.byteLength || zipU32(bytes, entry.localHeaderOffset) !== ZIP_LOCAL) {
    throw new CranArchiveError();
  }
  const nameLength = zipU16(bytes, entry.localHeaderOffset + 26);
  const extraLength = zipU16(bytes, entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed.slice();
  if (entry.method !== 8) throw new CranArchiveError();
  const inflated = new Response(compressed.slice()).body?.pipeThrough(new DecompressionStream("deflate-raw"));
  if (inflated === undefined) throw new CranArchiveError();
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
        // already errored
      }
      throw new CranArchiveError();
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

async function parseCranPackageZip(bytes: Uint8Array): Promise<CranPackage> {
  const entries = readCranZipEntries(bytes);
  for (const entry of entries) {
    if (!isShallowMember(entry.name)) continue;
    if (entry.name.split("/").pop() === "DESCRIPTION") {
      const data = await zipExtract(bytes, entry);
      const parsed = parseCranDescription(new TextDecoder().decode(data.subarray(0, MAX_DESCRIPTION_BYTES)));
      parsed.fileExtension = ".zip";
      return parsed;
    }
  }
  throw new CranMissingDescriptionError();
}

// ---------------------------------------------------------------------------
// CompareVersions (metadata.go:248-251) — NaturalSortCompare over the
// "-"→"." normalized strings
// ---------------------------------------------------------------------------

/**
 * NaturalSortCompare (modules/base/natural_sort.go:57-94) — the number-run
 * split, the leading-zero trim, the digit-count-then-byte compare, the
 * tail string.Compare. The x/text English collation for non-numeric parts
 * reduces to byte order (identical for the ASCII digit/dot alphabet the
 * version grammar admits — the documented reduction).
 */
export function naturalSortCompare(a: string, b: string): number {
  const pos = { a: 0, b: 0 };
  for (; pos.a < a.length && pos.b < b.length; ) {
    const endA = advanceRun(a, pos.a);
    const endB = advanceRun(b, pos.b);
    const partA = a.slice(pos.a, endA);
    const partB = b.slice(pos.b, endB);
    const isNumA = isDigit(partA.charCodeAt(0));
    const isNumB = isDigit(partB.charCodeAt(0));
    if (isNumA && isNumB) {
      if (partA !== partB) {
        const numA = trimZeros(partA);
        const numB = trimZeros(partB);
        if (numA.length !== numB.length) return numA.length - numB.length;
        if (numA !== numB) return numA < numB ? -1 : 1;
      }
    } else if (partA !== partB) {
      return partA < partB ? -1 : 1;
    }
    pos.a = endA;
    pos.b = endB;
  }
  return a === b ? 0 : a < b ? -1 : 1;
}

const isDigit = (code: number | undefined): boolean => code !== undefined && code >= 0x30 && code <= 0x39;

/** naturalSortAdvance: one homogeneous (all-digit or all-non-digit) run. */
function advanceRun(str: string, start: number): number {
  let end = start;
  const firstIsDigit = isDigit(str.charCodeAt(end));
  while (end < str.length && isDigit(str.charCodeAt(end)) === firstIsDigit) end++;
  return end;
}

/** naturalSortTrimZeros: strips leading '0's, keeping one char. */
function trimZeros(num: string): string {
  let i = 0;
  while (i < num.length - 1 && num[i] === "0") i++;
  return num.slice(i);
}

/** CompareVersions (metadata.go:248-251): R treats "." and "-" as
 *  equivalent separators. */
export function cranCompareVersions(a: string, b: string): number {
  return naturalSortCompare(a.replaceAll("-", "."), b.replaceAll("-", "."));
}

// ---------------------------------------------------------------------------
// Upload (cran.go:113-206)
// ---------------------------------------------------------------------------

export interface UploadCranPackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  content: ReadableStream<Uint8Array>;
  declaredLength: number | undefined;
  quota: PackagesQuotaConfig;
  now?: Date;
  maxBytes?: number;
  spoolKey?: string;
}

export interface UploadCranPackageResult {
  pkg: { id: number; name: string };
  version: PackageVersionRow;
  file: PackageFileRow;
  blob: PackageBlobRow;
  parsed: CranPackage;
}

/** The `cran.type`/platform/rversion triple a binary upload writes. */
async function writeCranFileProperties(d1: D1Database, fileId: number, properties: Record<string, string>): Promise<void> {
  await drizzle(d1)
    .insert(packageProperties)
    .values(
      Object.entries(properties).map(([name, value]) => ({
        refType: PropertyType.File,
        refId: fileId,
        name,
        value,
      })),
    )
    .run();
}

async function uploadCranPackageFile(
  input: UploadCranPackageInput,
  compositeKey: string,
  properties: Record<string, string>,
): Promise<UploadCranPackageResult> {
  const now = input.now ?? new Date();
  if (!input.doer.isAdmin && input.quota.limitTotalOwnerCount > UNLIMITED_QUOTA) {
    const total = (await countVersions(input.d1, input.owner.id)) + 1;
    if (total > input.quota.limitTotalOwnerCount) {
      throw new QuotaTotalCountError();
    }
  }

  const spooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: input.maxBytes,
    spoolKey: input.spoolKey,
  });

  try {
    const spoolObject = await input.bucket.get(spooled.spoolKey);
    if (spoolObject === null) {
      throw new Error("package spool object vanished");
    }
    const bytes = new Uint8Array(await spoolObject.arrayBuffer());
    const parsed = await parseCranPackage(bytes);

    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "cran", bytes.byteLength, input.quota);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "cran",
      name: parsed.name,
      semverCompatible: false,
      now,
    });
    const { row: version, created: versionCreated } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: parsed.version,
      now,
    });
    if (versionCreated) {
      await writeVersionMetadata(input.d1, version.id, JSON.stringify(parsed.metadata));
    }

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

    // cran.go:185 — Filename: fmt.Sprintf("%s_%s%s", …); IsLead: true (:195).
    const filename = `${parsed.name}_${parsed.version}${parsed.fileExtension}`;
    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: filename,
      isLead: true,
      compositeKey,
      now,
    });
    if (fileResult.outcome !== "created") {
      throw new DuplicatePackageFileError(fileResult.row);
    }
    await writeCranFileProperties(input.d1, fileResult.row.id, properties);

    return { pkg: { id: pkg.id, name: pkg.name }, version, file: fileResult.row, blob, parsed };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

/** PUT /src (cran.go:113-124): EmptyFileKey + the source property. */
export function uploadCranSourcePackage(input: UploadCranPackageInput): Promise<UploadCranPackageResult> {
  return uploadCranPackageFile(input, "", { [CRAN_PROPERTY_TYPE]: CRAN_TYPE_SOURCE });
}

/** PUT /bin (cran.go:126-140): the platform|rversion composite key + the
 *  three properties. The missing platform/rversion arm is the route's
 *  400-nil (cran.go:141-144). */
export function uploadCranBinaryPackage(
  input: UploadCranPackageInput,
  platform: string,
  rversion: string,
): Promise<UploadCranPackageResult> {
  return uploadCranPackageFile(input, `${platform}|${rversion}`, {
    [CRAN_PROPERTY_TYPE]: CRAN_TYPE_BINARY,
    [CRAN_PROPERTY_PLATFORM]: platform,
    [CRAN_PROPERTY_RVERSION]: rversion,
  });
}

// ---------------------------------------------------------------------------
// The property-matched searches (models/packages/cran/search.go)
// ---------------------------------------------------------------------------

interface CranFileMatch {
  file: PackageFileRow;
  version: PackageVersionRow;
  pkg: { id: number; name: string };
}

/** Every cran file of one owner with its version + package rows (the
 *  search joins' JS reduction — the property filter runs on the fetched
 *  property rows; volumes are registry-small). Ordered package.name ASC,
 *  package.id ASC (search.go:52's Asc pair). */
async function listCranFileMatches(d1: D1Database, ownerId: number): Promise<CranFileMatch[]> {
  const rows = await drizzle(d1)
    .select({ file: packageFiles, version: packageVersions, pkg: packages })
    .from(packageFiles)
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      and(
        eq(packages.ownerId, ownerId),
        eq(packages.type, "cran"),
        eq(packages.isInternal, false),
        eq(packageVersions.isInternal, false),
      ),
    )
    .orderBy(asc(packages.name), asc(packages.id))
    .all();
  return rows.map((row) => ({ file: row.file, version: row.version, pkg: { id: row.pkg.id, name: row.pkg.name } }));
}

function fileMatchesTriple(props: { name: string; value: string }[], fileType: string, platform: string, rversion: string): boolean {
  const byName = (name: string): string => props.find((p) => p.name === name)?.value ?? "";
  if (byName(CRAN_PROPERTY_TYPE) !== fileType) return false;
  if (platform !== "" && byName(CRAN_PROPERTY_PLATFORM) !== platform) return false;
  if (rversion !== "" && byName(CRAN_PROPERTY_RVERSION) !== rversion) return false;
  // The source triple passes platform/rversion as "" — matched only when
  // the file carries the EMPTY values (Go's GetByName zero value).
  if (platform === "" && byName(CRAN_PROPERTY_PLATFORM) !== "") return false;
  if (rversion === "" && byName(CRAN_PROPERTY_RVERSION) !== "") return false;
  return true;
}

/**
 * EnumerateSourcePackages / EnumerateBinaryPackages' data (cran.go:29-111):
 * per-package LATEST version (CompareVersions) whose file matches the
 * triple, package name ASC. Null = the route's 404 (zero matches).
 */
export async function enumerateCranPackages(
  d1: D1Database,
  owner: PackageOwnerRow,
  fileType: string,
  platform: string,
  rversion: string,
): Promise<
  {
    pkg: { id: number; name: string };
    version: PackageVersionRow;
    metadata: CranMetadata;
    file: PackageFileRow;
    blob: PackageBlobRow;
  }[]
> {
  const matches = await listCranFileMatches(d1, owner.id);
  const propertyRows = matches.length
    ? await drizzle(d1)
        .select({ refId: packageProperties.refId, name: packageProperties.name, value: packageProperties.value })
        .from(packageProperties)
        .where(
          and(
            eq(packageProperties.refType, PropertyType.File),
            inArray(
              packageProperties.refId,
              matches.map((m) => m.file.id),
            ),
          ),
        )
        .all()
    : [];
  const propsByFile = new Map<number, { name: string; value: string }[]>();
  for (const row of propertyRows) {
    const list = propsByFile.get(row.refId) ?? [];
    list.push({ name: row.name, value: row.value });
    propsByFile.set(row.refId, list);
  }
  // The per-package latest-version pick (search.go:60-74 — in Go, "SQL
  // can't order R version strings").
  const byPackage = new Map<number, { pkg: CranFileMatch["pkg"]; version: PackageVersionRow; file: PackageFileRow }>();
  for (const match of matches) {
    const props = propsByFile.get(match.file.id) ?? [];
    if (!fileMatchesTriple(props, fileType, platform, rversion)) continue;
    const current = byPackage.get(match.pkg.id);
    if (current === undefined || cranCompareVersions(match.version.version, current.version.version) > 0) {
      byPackage.set(match.pkg.id, { pkg: match.pkg, version: match.version, file: match.file });
    }
  }
  const entries = [...byPackage.values()].sort((a, b) => a.pkg.name.localeCompare(b.pkg.name) || a.pkg.id - b.pkg.id);
  if (entries.length === 0) return [];
  const out: {
    pkg: { id: number; name: string };
    version: PackageVersionRow;
    metadata: CranMetadata;
    file: PackageFileRow;
    blob: PackageBlobRow;
  }[] = [];
  for (const entry of entries) {
    const descriptors = await getFileDescriptors(d1, entry.version.id);
    const match = descriptors.find((d) => d.file.id === entry.file.id);
    if (match === undefined) continue;
    let metadata: CranMetadata = {
      title: "",
      description: "",
      project_url: [],
      license: "",
      authors: [],
      depends: [],
      imports: [],
      suggests: [],
      linking_to: [],
      needs_compilation: false,
    };
    if (entry.version.metadataJson !== null) {
      try {
        const parsed: unknown = JSON.parse(entry.version.metadataJson);
        if (parsed !== null && typeof parsed === "object") {
          metadata = { ...metadata, ...(parsed as Partial<CranMetadata>) };
        }
      } catch {
        // a malformed row renders the zero metadata
      }
    }
    out.push({ pkg: entry.pkg, version: entry.version, metadata, file: match.file, blob: match.blob });
  }
  return out;
}

/**
 * The PACKAGES field block for one entry (cran.go:78-110) — Package/
 * Version/License?/Depends?/Imports?/LinkingTo?/Suggests?/NeedsCompilation
 * (ALWAYS)/MD5sum. The MD5sum renders the EMPTY value (the WebCrypto
 * reduction — upstream prints the blob's hash_md5 hex).
 */
export function renderCranPackagesEntry(entry: {
  pkg: { name: string };
  version: PackageVersionRow;
  metadata: CranMetadata;
}): string {
  const lines: string[] = [];
  lines.push(`Package: ${entry.pkg.name}`);
  lines.push(`Version: ${entry.version.version}`);
  if (entry.metadata.license !== "") lines.push(`License: ${entry.metadata.license}`);
  if (entry.metadata.depends.length > 0) lines.push(`Depends: ${entry.metadata.depends.join(", ")}`);
  if (entry.metadata.imports.length > 0) lines.push(`Imports: ${entry.metadata.imports.join(", ")}`);
  if (entry.metadata.linking_to.length > 0) lines.push(`LinkingTo: ${entry.metadata.linking_to.join(", ")}`);
  if (entry.metadata.suggests.length > 0) lines.push(`Suggests: ${entry.metadata.suggests.join(", ")}`);
  lines.push(`NeedsCompilation: ${entry.metadata.needs_compilation ? "yes" : "no"}`);
  lines.push("MD5sum: ");
  return lines.join("\n");
}

/** The whole PACKAGES body (entries joined by the blank-line separator,
 *  cran.go:69-73/:111). */
export function renderCranPackagesIndex(
  entries: Parameters<typeof renderCranPackagesEntry>[0][],
): string {
  return entries.map(renderCranPackagesEntry).join("\n\n");
}

// ---------------------------------------------------------------------------
// Download (cran.go:208-253)
// ---------------------------------------------------------------------------

export interface CranDownload {
  file: PackageFileRow;
  blob: PackageBlobRow;
  stream: ReadableStream;
  size: number;
}

/** SearchFile (search.go:97-120): the ONE file whose name + property
 *  triple match. Null = the route's 404. */
export async function openCranFileForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  fileType: string,
  platform: string,
  rversion: string,
  filename: string,
): Promise<CranDownload | null> {
  if (filename === "") return null;
  const matches = await listCranFileMatches(d1, owner.id);
  const named = matches.filter((m) => m.file.lowerName === filename.toLowerCase());
  for (const match of named) {
    const props = await drizzle(d1)
      .select({ name: packageProperties.name, value: packageProperties.value })
      .from(packageProperties)
      .where(and(eq(packageProperties.refType, PropertyType.File), eq(packageProperties.refId, match.file.id)))
      .all();
    if (!fileMatchesTriple(props, fileType, platform, rversion)) continue;
    const descriptors = await getFileDescriptors(d1, match.version.id);
    const descriptor = descriptors.find((entry) => entry.file.id === match.file.id);
    if (descriptor === undefined) return null;
    const object = await bucket.get(packageBlobContentKey(descriptor.blob.hashSha256));
    if (object === null) return null;
    return { file: descriptor.file, blob: descriptor.blob, stream: object.body, size: object.size };
  }
  return null;
}

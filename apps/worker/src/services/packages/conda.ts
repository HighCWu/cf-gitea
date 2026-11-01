/**
 * The Conda package registry protocol service (SPEC-0016 §7 long tail) — the
 * service half of `/api/packages/{username}/conda/...` (upstream
 * routers/api/packages/conda/conda.go over CreatePackageOrAddFileToExisting /
 * the conda property-filtered SearchFiles, models/packages/conda/search.go):
 *
 * - Upload (conda.go:189-294): PUT with the RAW body (ctx.UploadStream — not
 *   multipart); the filename must end `.tar.bz2` or `.conda`
 *   (isCondaPackageFileName, conda.go:37-39) else the 400-nil arm. The parse
 *   (modules/packages/conda/metadata.go) walks the tar for
 *   `info/index.json` (REQUIRED — its absence is ErrInvalidStructure) and
 *   `info/about.json` (optional, zero-filled), each through a ≤ 32 MiB
 *   limited read (limited_reader.go:14); `checkName`/`checkVersion`
 *   (metadata.go:220-243, the conda-build grammar: lowercase, no
 *   `=@#$%^&*:;\"'\|<>?/ ` plus `!` in names / `-` in versions) are the
 *   ErrInvalidName/ErrInvalidVersion sentinels; about.json's home/dev_url/
 *   doc_url clear when not absolute http/https URLs with a host
 *   (validation.IsValidURL, helpers.go:42-51).
 *   The stored FILE is `{name}-{version}-{build}{.tar.bz2|.conda}` under the
 *   SUBDIR composite key (conda.go:269-271), IsLead true, carrying
 *   `conda.subdir` + `conda.metadata` (the FileMetadata JSON); the PACKAGE
 *   is named `channel/name` (the bare name when channel is empty) and
 *   carries `conda.name` + `conda.channel` — BOTH written at package
 *   creation only, INCLUDING the empty-channel row (the channel-filtered
 *   SearchFiles matches `value = channel` exactly, so the default
 *   enumeration needs it); the VERSION carries the VersionMetadata JSON,
 *   written at version creation only.
 * - Repodata (conda.go:55-187): SearchFiles(channel, subdir) → the RepoData
 *   render {info:{subdir}, packages, "packages.conda", removed} — keyed by
 *   the stored file name, split by the file metadata's is_conda flag, the
 *   Go map-key sort (bytewise), the PackageInfo struct's 13-field order, a
 *   trailing newline (json.Encoder). Zero files → the 404-nil arm.
 * - Download (conda.go:296-322): SearchFiles(channel, subdir, filename)
 *   must answer EXACTLY one row (more is the 404, conda.go:308); the lead
 *   file bumps the version counter on GET (packages.go:668).
 *
 * The three staged codec walls, RESOLVED (SPEC-0016 §7's conda row):
 * 1. `.tar.bz2` parse — the vendored bzip2 DECODER (./bz2.ts, the Go
 *    compress/bzip2 semantics) + the shared tar walk (./distro-common)
 *    adopted; every malformed or CRC-failing stream is the plain-error
 *    class (upstream's bzip2/tar/json errors are not ErrInvalidArgument —
 *    conda.go:218-224 sends them to the 500 arm).
 * 2. `.conda` parse — ADOPTED (2026-11-01, the wall's recorded reopen
 *    trigger landed: the dedicated zstd-decoder unit). ParsePackageConda
 *    (metadata.go:101-130) rides the family-local EOCD + central-directory
 *    zip walk (the tar-scan idiom of the landed cran/nuget readers: stored
 *    + deflate members, CRC32-gated at data EOF, zip64 out of scope under
 *    the upload cap) over `info-*.tar.zst` and the vendored zstd DECODER
 *    (./zstd.ts — the format-doc port with facebook/zstd's C decoder as
 *    the algorithm reference, XXH-64 checksums verified, dictionaries/
 *    legacy frames rejected, skippable frames passed through, concatenated
 *    frames decoded in sequence) into the SAME parsePackageTar walk the
 *    `.tar.bz2` arm runs; the arm sets FileMetadata.IsCondaPackage = true
 *    (metadata.go:122-124), which flips the stored extension to `.conda`
 *    (conda.go:239-242) and the repodata split to `packages.conda`. A zip
 *    with no `info-*.tar.zst` member is the invalid-structure sentinel
 *    (metadata.go:129); zip/zstd/tar/json failures stay the plain-error
 *    500 class (conda.go:218-224).
 * 3. `repodata.json.bz2` serving — ADOPTED (the wall's reopen trigger
 *    landed): the pin serves the `.bz2` variants (conda.go:44's switch +
 *    conda.go:170-183's bzip2 writer — upstream rides
 *    github.com/dsnet/compress, a format Go's stdlib cannot write) through
 *    the vendored from-spec bzip2 ENCODER (./bz2-encode.ts): the SAME
 *    repodata JSON body compressed, `application/x-bzip2` for the `.bz2`
 *    names (conda.go:174-179's suffix branch). The encoder's output
 *    round-trips through BOTH the landed decoder and system bzip2 (the
 *    bz2-encode.ts battery; encoder freedom over byte-identity, the
 *    format's block+combined CRCs are the loud correctness gate).
 */

import { and, eq, inArray } from "drizzle-orm";
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
  incrementDownloadCounter,
  tryInsertFile,
} from "./model";
import { packageFiles, packageProperties, packageVersions, packages } from "../../db/schema";
import {
  MAX_PACKAGE_BLOB_BYTES,
  PackageBlobTooLargeError,
  PackageSizeMismatchError,
  copySpoolToContentKey,
  getOrInsertBlob,
  packageBlobContentKey,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import { writeVersionMetadata } from "./protocol-common";
import { DuplicatePackageFileError } from "./generic";
import { readTarMembers, crc32 } from "./distro-common";
import { bzip2Decompress } from "./bz2";
import { bzip2Compress } from "./bz2-encode";
import { zstdDecompress } from "./zstd";

// ---------------------------------------------------------------------------
// The module constants (modules/packages/conda/metadata.go:26-31)
// ---------------------------------------------------------------------------

/** package.go:39 — `TypeConda Type = "conda"`. */
export const CONDA_PACKAGE_TYPE = "conda";

export const CONDA_PROPERTY_NAME = "conda.name";
export const CONDA_PROPERTY_CHANNEL = "conda.channel";
export const CONDA_PROPERTY_SUBDIR = "conda.subdir";
export const CONDA_PROPERTY_METADATA = "conda.metadata";

/** limited_reader.go:14 — packages.MaxMetadataSize. */
const MAX_METADATA_BYTES = 32 * 1024 * 1024;

/** conda.go:44's repodata switch — all four names (the .bz2 twins ride
 *  the wall-3 encoder, see encodeCondaRepodataBody). */
export const CONDA_REPODATA_NAMES = [
  "repodata.json",
  "repodata.json.bz2",
  "current_repodata.json",
  "current_repodata.json.bz2",
];

// ---------------------------------------------------------------------------
// The parse errors (metadata.go:21-23) — the ErrInvalidArgument sentinels
// (→ the 400 arm, conda.go:218-220) and the plain-error class (→ 500)
// ---------------------------------------------------------------------------

export class CondaInvalidStructureError extends Error {
  constructor() {
    super("package structure is invalid");
    this.name = "CondaInvalidStructureError";
  }
}

export class CondaInvalidNameError extends Error {
  constructor() {
    super("package name is invalid");
    this.name = "CondaInvalidNameError";
  }
}

export class CondaInvalidVersionError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "CondaInvalidVersionError";
  }
}

/** A structurally broken container/stream/json decode — upstream's
 *  bzip2/tar/json plain errors → the route's 500 default arm. */
export class CondaArchiveError extends Error {
  constructor() {
    super("the package archive could not be read");
    this.name = "CondaArchiveError";
  }
}

/** A malformed STORED row (the conda.metadata property is written only by
 *  this module — the 500 arm upstream answers for an undecodable property,
 *  conda.go:136-139). */
export class CondaStoredMetadataError extends Error {
  constructor() {
    super("stored package metadata is unreadable");
    this.name = "CondaStoredMetadataError";
  }
}

// ---------------------------------------------------------------------------
// The metadata structs (metadata.go:42-86) — the json-tag orders verbatim
// (Go Marshal order on every stored/rendered body)
// ---------------------------------------------------------------------------

/** metadata.go:43-51 — every field omitempty. */
export interface CondaVersionMetadata {
  description: string;
  summary: string;
  project_url: string;
  repository_url: string;
  documentation_url: string;
  license: string;
  license_family: string;
}

/** metadata.go:54-63 — `is_conda` carries NO omitempty (always rendered). */
export interface CondaFileMetadata {
  is_conda: boolean;
  architecture: string;
  noarch: string;
  build: string;
  build_number: number;
  dependencies: string[];
  platform: string;
  timestamp: number;
}

export interface CondaPackage {
  name: string;
  version: string;
  subdir: string;
  versionMetadata: CondaVersionMetadata;
  fileMetadata: CondaFileMetadata;
}

function zeroFileMetadata(): CondaFileMetadata {
  return {
    is_conda: false,
    architecture: "",
    noarch: "",
    build: "",
    build_number: 0,
    dependencies: [],
    platform: "",
    timestamp: 0,
  };
}

/** The FileMetadata JSON exactly as Go marshals the struct (tag order,
 *  omitempty on everything but is_conda). */
export function buildCondaFileMetadataJson(md: CondaFileMetadata): string {
  const out: Record<string, unknown> = { is_conda: md.is_conda };
  if (md.architecture !== "") out.architecture = md.architecture;
  if (md.noarch !== "") out.noarch = md.noarch;
  if (md.build !== "") out.build = md.build;
  if (md.build_number !== 0) out.build_number = md.build_number;
  if (md.dependencies.length > 0) out.dependencies = md.dependencies;
  if (md.platform !== "") out.platform = md.platform;
  if (md.timestamp !== 0) out.timestamp = md.timestamp;
  return JSON.stringify(out);
}

/** The VersionMetadata JSON exactly as Go marshals the struct. */
export function buildCondaVersionMetadataJson(md: CondaVersionMetadata): string {
  const out: Record<string, unknown> = {};
  if (md.description !== "") out.description = md.description;
  if (md.summary !== "") out.summary = md.summary;
  if (md.project_url !== "") out.project_url = md.project_url;
  if (md.repository_url !== "") out.repository_url = md.repository_url;
  if (md.documentation_url !== "") out.documentation_url = md.documentation_url;
  if (md.license !== "") out.license = md.license;
  if (md.license_family !== "") out.license_family = md.license_family;
  return JSON.stringify(out);
}

/**
 * validation.IsValidURL (modules/validation/helpers.go:42-51): the URI must
 * parse strictly, carry an http/https scheme (ANY other scheme — ftp://
 * included — is invalid; the earlier "any absolute scheme" reading
 * conflated the composer family's own gate with this one), and hold a
 * valid port (WHATWG throws on an invalid port for these special schemes,
 * the portOnly/validPort arm). Go's url.ParseRequestURI errors on control
 * bytes — the tab/CR/LF the WHATWG parser would silently STRIP and thereby
 * admit — so they are rejected before parsing.
 */
export function isValidCondaUrl(value: string): boolean {
  if (value === "") return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The JSON decode helpers (Go json.Decode into the struct pointers: an
// absent field or JSON null leaves the zero, a TYPE mismatch is a decode
// error — the 500 class; unknown fields are ignored)
// ---------------------------------------------------------------------------

type CondaRecord = Record<string, unknown>;

function decodeCondaJsonObject(bytes: Uint8Array): CondaRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new CondaArchiveError();
  }
  // JSON null decodes into a struct pointer as a no-op (the zero struct) —
  // an object-shaped nothing. Arrays are a real decode error.
  if (parsed === null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new CondaArchiveError();
  return parsed as CondaRecord;
}

function condaString(record: CondaRecord, key: string): string {
  const value = record[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new CondaArchiveError();
  return value;
}

function condaInt(record: CondaRecord, key: string): number {
  const value = record[key];
  if (value === undefined || value === null) return 0;
  // Go decodes an int64 from integer literals only; JS numbers carry the
  // value (the safe-integer gate is the documented decode reduction).
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new CondaArchiveError();
  return value;
}

function condaStringArray(record: CondaRecord, key: string): string[] {
  const value = record[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CondaArchiveError();
  return value.map((item) => {
    if (typeof item !== "string") throw new CondaArchiveError();
    return item;
  });
}

// ---------------------------------------------------------------------------
// The name/version grammar (metadata.go:220-243, the conda-build vectors)
// ---------------------------------------------------------------------------

const CONDA_BAD_CHARACTERS = '=@#$%^&*:;"\'\\|<>?/ ';

function condaCheckBadCharacters(s: string, additional: string): boolean {
  for (const ch of s) {
    if (CONDA_BAD_CHARACTERS.includes(ch) || additional.includes(ch)) return true;
  }
  return false;
}

/** checkName (metadata.go:220-228): non-empty, lowercase, no bad chars+. */
export function condaCheckName(name: string): boolean {
  if (name === "") return false;
  if (name !== name.toLowerCase()) return false;
  return !condaCheckBadCharacters(name, "!");
}

/** checkVersion (metadata.go:231-236): non-empty, no bad chars+-. */
export function condaCheckVersion(version: string): boolean {
  if (version === "") return false;
  return !condaCheckBadCharacters(version, "-");
}

/** conda.go:37-39. */
export function isCondaPackageFileName(filename: string): boolean {
  return filename.endsWith(".tar.bz2") || filename.endsWith(".conda");
}

// ---------------------------------------------------------------------------
// The parse (metadata.go:93-217) — the tar walk shared by both container
// arms (the containers differ; parsePackageTar is one function upstream)
// ---------------------------------------------------------------------------

/**
 * parsePackageTar (metadata.go:132-217) over the decoded tar: walks the
 * regular-file members for `info/index.json` (REQUIRED — its absence is
 * ErrInvalidStructure) and `info/about.json` (optional, zero-filled),
 * each through the ≤ 32 MiB metadata bound (limited_reader.go:14), the
 * name/version gates on index decode, and the about-URL validation.
 */
function parseCondaTarMembers(members: ReturnType<typeof readTarMembers>): CondaPackage {
  let index: CondaRecord | null = null;
  let about: CondaRecord | null = null;
  for (const member of members) {
    if (member.data.byteLength > MAX_METADATA_BYTES) throw new CondaArchiveError();
    if (member.name === "info/index.json") {
      index = decodeCondaJsonObject(member.data);
      // The gates run on decode, before about.json is even read.
      if (!condaCheckName(condaString(index, "name"))) throw new CondaInvalidNameError();
      if (!condaCheckVersion(condaString(index, "version"))) throw new CondaInvalidVersionError();
      if (about !== null) break;
    } else if (member.name === "info/about.json") {
      about = decodeCondaJsonObject(member.data);
      if (index !== null) break;
    }
  }
  if (index === null) throw new CondaInvalidStructureError();
  if (about === null) about = {};

  const projectUrl = condaString(about, "home");
  const repositoryUrl = condaString(about, "dev_url");
  const documentationUrl = condaString(about, "doc_url");

  return {
    name: condaString(index, "name"),
    version: condaString(index, "version"),
    subdir: condaString(index, "subdir"),
    versionMetadata: {
      description: condaString(about, "description"),
      summary: condaString(about, "summary"),
      project_url: isValidCondaUrl(projectUrl) ? projectUrl : "",
      repository_url: isValidCondaUrl(repositoryUrl) ? repositoryUrl : "",
      documentation_url: isValidCondaUrl(documentationUrl) ? documentationUrl : "",
      license: condaString(index, "license"),
      license_family: condaString(index, "license_family"),
    },
    fileMetadata: {
      is_conda: false,
      architecture: condaString(index, "arch"),
      noarch: condaString(index, "noarch"),
      build: condaString(index, "build"),
      build_number: condaInt(index, "build_number"),
      dependencies: condaStringArray(index, "depends"),
      platform: condaString(index, "platform"),
      timestamp: condaInt(index, "timestamp"),
    },
  };
}

/**
 * ParsePackageBZ2 (metadata.go:94-98): bzip2 decode (the vendored port —
 * Bzip2Error is the plain-error class like Go's reader) + the tar walk.
 */
export function parseCondaPackageTarBz2(bytes: Uint8Array): CondaPackage {
  let inflated: Uint8Array;
  try {
    inflated = bzip2Decompress(bytes);
  } catch {
    throw new CondaArchiveError();
  }
  let members: ReturnType<typeof readTarMembers>;
  try {
    members = readTarMembers(inflated);
  } catch {
    throw new CondaArchiveError();
  }
  return parseCondaTarMembers(members);
}

// ---------------------------------------------------------------------------
// The `.conda` container (metadata.go:101-130) — the outer zip + the inner
// zstd'd tar. The zip walk is the family-local tar-scan idiom (the landed
// cran/nuget readers): an EOCD + central-directory scan, stored (method 0)
// and deflate (method 8, DecompressionStream("deflate-raw")) members,
// CRC32-gated at data EOF (Go's archive/zip readDataEOF → checkSum), zip64
// out of scope under the upload cap. Dictionaries and legacy frames are
// rejected by the decoder itself; every zip/zstd/tar failure is the
// plain-error class (→ the 500 arm), a missing `info-*.tar.zst` member the
// invalid-structure sentinel (metadata.go:129 → the 400 arm).
// ---------------------------------------------------------------------------

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CD_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

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

interface CondaZipMember {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** The central-directory scan (zip.NewReader's readDirectory). */
function readCondaZipMembers(bytes: Uint8Array): CondaZipMember[] {
  if (bytes.byteLength < 22) throw new Error("zip: not a valid zip file");
  // The EOCD lives in the last 22 + 65535 bytes (max comment length).
  const window = Math.min(bytes.byteLength, 22 + 65535);
  let eocdAt = -1;
  for (let i = bytes.byteLength - 22; i >= bytes.byteLength - window; i--) {
    if (zipU32(bytes, i) === ZIP_EOCD_SIGNATURE) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0) throw new Error("zip: not a valid zip file");
  const entryCount = zipU16(bytes, eocdAt + 10);
  const cdSize = zipU32(bytes, eocdAt + 12);
  const cdOffset = zipU32(bytes, eocdAt + 16);
  if (cdOffset + cdSize > bytes.byteLength) throw new Error("zip: not a valid zip file");
  const members: CondaZipMember[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > bytes.byteLength || zipU32(bytes, cursor) !== ZIP_CD_SIGNATURE) {
      throw new Error("zip: not a valid zip file");
    }
    const flags = zipU16(bytes, cursor + 8);
    const nameLength = zipU16(bytes, cursor + 28);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let name: string;
    if ((flags & 0x800) !== 0) {
      name = new TextDecoder().decode(nameBytes);
    } else {
      name = "";
      for (const byte of nameBytes) name += String.fromCharCode(byte);
    }
    members.push({
      name,
      method: zipU16(bytes, cursor + 10),
      crc32: zipU32(bytes, cursor + 16),
      compressedSize: zipU32(bytes, cursor + 20),
      uncompressedSize: zipU32(bytes, cursor + 24),
      localHeaderOffset: zipU32(bytes, cursor + 42),
    });
    cursor += 46 + nameLength + zipU16(bytes, cursor + 30) + zipU16(bytes, cursor + 32);
  }
  return members;
}

/** One member's data, CRC-verified at data EOF (readDataEOF → checkSum). */
async function readCondaZipMember(bytes: Uint8Array, member: CondaZipMember): Promise<Uint8Array> {
  if (
    member.localHeaderOffset + 30 > bytes.byteLength ||
    zipU32(bytes, member.localHeaderOffset) !== ZIP_LOCAL_SIGNATURE
  ) {
    throw new Error("zip: invalid local header");
  }
  const nameLength = zipU16(bytes, member.localHeaderOffset + 26);
  const extraLength = zipU16(bytes, member.localHeaderOffset + 28);
  const dataStart = member.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataStart, dataStart + member.compressedSize);
  const checkSum = (data: Uint8Array): Uint8Array => {
    if (crc32(data) !== member.crc32) throw new Error("zip: checksum error");
    return data;
  };
  if (member.method === 0) {
    return checkSum(compressed.slice());
  }
  if (member.method === 8) {
    const inflated = new Response(compressed.slice()).body!.pipeThrough(
      new DecompressionStream("deflate-raw"),
    );
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = inflated.getReader();
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      total += read.value.byteLength;
      // The zip-bomb gate: the claimed uncompressed size bounds the output.
      if (total > member.uncompressedSize) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be errored.
        }
        throw new Error("zip: decompressed size exceeds the entry's recorded size");
      }
      chunks.push(read.value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return checkSum(out);
  }
  throw new Error(`zip: unsupported compression method ${member.method}`);
}

/**
 * ParsePackageConda (metadata.go:101-130): the outer zip's `info-*.tar.zst`
 * member, zstd-decoded (the vendored port) into the shared tar walk, with
 * FileMetadata.IsCondaPackage = true (metadata.go:122-124 — the flag that
 * stores the file as `.conda` and renders it under `packages.conda`).
 */
export async function parseCondaPackageConda(bytes: Uint8Array): Promise<CondaPackage> {
  let members: CondaZipMember[];
  try {
    members = readCondaZipMembers(bytes);
  } catch {
    throw new CondaArchiveError();
  }
  // metadata.go:107-108 — the FIRST `info-`/`.tar.zst` member wins.
  const infoMember = members.find(
    (member) => member.name.startsWith("info-") && member.name.endsWith(".tar.zst"),
  );
  if (infoMember === undefined) throw new CondaInvalidStructureError();

  let memberData: Uint8Array;
  try {
    memberData = await readCondaZipMember(bytes, infoMember);
  } catch {
    throw new CondaArchiveError();
  }
  let inflated: Uint8Array;
  try {
    inflated = zstdDecompress(memberData);
  } catch {
    throw new CondaArchiveError();
  }
  let tarMembers: ReturnType<typeof readTarMembers>;
  try {
    tarMembers = readTarMembers(inflated);
  } catch {
    throw new CondaArchiveError();
  }
  const parsed = parseCondaTarMembers(tarMembers);
  parsed.fileMetadata.is_conda = true;
  return parsed;
}

// ---------------------------------------------------------------------------
// The channel/subdir property search (models/packages/conda/search.go) —
// the SQL join's JS reduction (the cran posture; volumes are registry-
// small). Filters: type + owner + non-internal VERSION, the PACKAGE
// property `conda.channel = channel` (exact — the empty-channel row
// included), the FILE property `conda.subdir = subdir`, and the
// lower-cased filename when set.
// ---------------------------------------------------------------------------

export interface CondaFileMatch {
  pkg: { id: number; name: string };
  version: PackageVersionRow;
  file: PackageFileRow;
}

async function condaPropertiesByRef(
  d1: D1Database,
  refType: number,
  refIds: number[],
): Promise<Map<number, Map<string, string>>> {
  const byRef = new Map<number, Map<string, string>>();
  if (refIds.length === 0) return byRef;
  const rows = await drizzle(d1)
    .select({ refId: packageProperties.refId, name: packageProperties.name, value: packageProperties.value })
    .from(packageProperties)
    .where(and(eq(packageProperties.refType, refType), inArray(packageProperties.refId, refIds)))
    .all();
  for (const row of rows) {
    let byName = byRef.get(row.refId);
    if (byName === undefined) {
      byName = new Map<string, string>();
      byRef.set(row.refId, byName);
    }
    byName.set(row.name, row.value);
  }
  return byRef;
}

export async function searchCondaFiles(
  d1: D1Database,
  ownerId: number,
  channel: string,
  subdir: string,
  filename = "",
): Promise<CondaFileMatch[]> {
  const rows = await drizzle(d1)
    .select({ file: packageFiles, version: packageVersions, pkg: packages })
    .from(packageFiles)
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      and(
        eq(packages.ownerId, ownerId),
        eq(packages.type, CONDA_PACKAGE_TYPE),
        eq(packageVersions.isInternal, false),
      ),
    )
    .all();
  if (rows.length === 0) return [];

  const packageProps = await condaPropertiesByRef(
    d1,
    PropertyType.Package,
    rows.map((row) => row.pkg.id),
  );
  const fileProps = await condaPropertiesByRef(
    d1,
    PropertyType.File,
    rows.map((row) => row.file.id),
  );

  const lowerFilename = filename === "" ? "" : filename.toLowerCase();
  const matches: CondaFileMatch[] = [];
  for (const row of rows) {
    if (packageProps.get(row.pkg.id)?.get(CONDA_PROPERTY_CHANNEL) !== channel) continue;
    if (fileProps.get(row.file.id)?.get(CONDA_PROPERTY_SUBDIR) !== subdir) continue;
    if (lowerFilename !== "" && row.file.lowerName !== lowerFilename) continue;
    matches.push({ pkg: { id: row.pkg.id, name: row.pkg.name }, version: row.version, file: row.file });
  }
  return matches;
}

// ---------------------------------------------------------------------------
// The repodata render (conda.go:55-187)
// ---------------------------------------------------------------------------

/** conda.go:60-74 — the PackageInfo struct's 13-field order verbatim (no
 *  omitempty: every field renders, `depends` nil→[] via SliceNilAsEmpty). */
export interface CondaPackageInfo {
  name: string;
  version: string;
  noarch: string;
  subdir: string;
  timestamp: number;
  build: string;
  build_number: number;
  depends: string[];
  license: string;
  license_family: string;
  md5: string;
  sha256: string;
  size: number;
}

/** Go's encoding/json sorts map keys by UTF-8 bytes (sort.Strings). */
function condaMapKeyCompare(a: string, b: string): number {
  const bytesA = new TextEncoder().encode(a);
  const bytesB = new TextEncoder().encode(b);
  const shared = Math.min(bytesA.length, bytesB.length);
  for (let i = 0; i < shared; i++) {
    const diff = (bytesA[i] ?? 0) - (bytesB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return bytesA.length - bytesB.length;
}

function condaSortedMap(entries: [string, CondaPackageInfo][]): Record<string, CondaPackageInfo> {
  const out: Record<string, CondaPackageInfo> = {};
  for (const [key, value] of [...entries].sort(([a], [b]) => condaMapKeyCompare(a, b))) {
    out[key] = value;
  }
  return out;
}

/** The license/license_family render (DescriptorMetadata's read of the
 *  version row — a missing/malformed row renders the zero fields). */
function condaVersionLicenseFields(version: PackageVersionRow): { license: string; licenseFamily: string } {
  if (version.metadataJson === null) return { license: "", licenseFamily: "" };
  try {
    const parsed: unknown = JSON.parse(version.metadataJson);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        license: typeof record.license === "string" ? record.license : "",
        licenseFamily: typeof record.license_family === "string" ? record.license_family : "",
      };
    }
  } catch {
    // fall through to the zero render
  }
  return { license: "", licenseFamily: "" };
}

/** The stored conda.metadata property back into the struct (undecodable →
 *  the 500 arm upstream answers, conda.go:136-139). */
export function loadCondaFileMetadata(raw: string): CondaFileMetadata {
  const zero = zeroFileMetadata();
  if (raw === "") return zero;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CondaStoredMetadataError();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CondaStoredMetadataError();
  }
  const record = parsed as CondaRecord;
  const str = (key: string): string => {
    const value = record[key];
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw new CondaStoredMetadataError();
    return value;
  };
  const num = (key: string): number => {
    const value = record[key];
    if (value === undefined || value === null) return 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new CondaStoredMetadataError();
    return value;
  };
  const deps = record.dependencies;
  return {
    is_conda: record.is_conda === true,
    architecture: str("architecture"),
    noarch: str("noarch"),
    build: str("build"),
    build_number: num("build_number"),
    dependencies:
      deps === undefined || deps === null
        ? []
        : Array.isArray(deps)
          ? deps.map((item) => {
              if (typeof item !== "string") throw new CondaStoredMetadataError();
              return item;
            })
          : [],
    platform: str("platform"),
    timestamp: num("timestamp"),
  };
}

/**
 * EnumeratePackages' data + render (conda.go:55-187): the RepoData JSON
 * body — info/packages/packages.conda/removed in the struct order, the
 * maps' keys sorted, the json.Encoder trailing newline. Null = zero files
 * (the route's 404-nil arm, conda.go:102-105).
 */
export async function buildCondaRepodata(
  d1: D1Database,
  owner: PackageOwnerRow,
  channel: string,
  subdir: string,
): Promise<string | null> {
  const matches = await searchCondaFiles(d1, owner.id, channel, subdir);
  if (matches.length === 0) return null;

  const packageProps = await condaPropertiesByRef(
    d1,
    PropertyType.Package,
    matches.map((match) => match.pkg.id),
  );
  const fileProps = await condaPropertiesByRef(
    d1,
    PropertyType.File,
    matches.map((match) => match.file.id),
  );

  const packagesEntries: [string, CondaPackageInfo][] = [];
  const condaEntries: [string, CondaPackageInfo][] = [];
  for (const match of matches) {
    const descriptors = await getFileDescriptors(d1, match.version.id);
    const descriptor = descriptors.find((entry) => entry.file.id === match.file.id);
    if (descriptor === undefined) throw new CondaStoredMetadataError();

    const fileMetadata = loadCondaFileMetadata(fileProps.get(match.file.id)?.get(CONDA_PROPERTY_METADATA) ?? "");
    const licenses = condaVersionLicenseFields(match.version);
    const info: CondaPackageInfo = {
      name: packageProps.get(match.pkg.id)?.get(CONDA_PROPERTY_NAME) ?? "",
      version: match.version.version,
      noarch: fileMetadata.noarch,
      subdir,
      timestamp: fileMetadata.timestamp,
      build: fileMetadata.build,
      build_number: fileMetadata.build_number,
      depends: fileMetadata.dependencies,
      license: licenses.license,
      license_family: licenses.licenseFamily,
      md5: descriptor.blob.hashMd5 ?? "",
      sha256: descriptor.blob.hashSha256,
      size: descriptor.blob.size,
    };
    (fileMetadata.is_conda ? condaEntries : packagesEntries).push([match.file.name, info]);
  }

  const repoData = {
    info: { subdir },
    packages: condaSortedMap(packagesEntries),
    "packages.conda": condaSortedMap(condaEntries),
    removed: {} as Record<string, never>,
  };
  return `${JSON.stringify(repoData)}\n`;
}

// ---------------------------------------------------------------------------
// The .bz2 repodata variants (conda.go:170-183) — the wall-3 encoder
// ---------------------------------------------------------------------------

/** conda.go:174-179's suffix branch: `.json` → application/json, the `.bz2`
 *  twins → application/x-bzip2. */
export function condaRepodataContentType(filename: string): "application/json" | "application/x-bzip2" {
  return filename.endsWith(".json") ? "application/json" : "application/x-bzip2";
}

/**
 * conda.go:170-183's writer: the .bz2 names serve the SAME repodata JSON
 * body through the vendored bzip2 encoder (level 9 — the whole
 * enumeration fits one 900k block); `.json` serves UTF-8 verbatim.
 */
export function encodeCondaRepodataBody(body: string, filename: string): Uint8Array {
  const utf8 = new TextEncoder().encode(body);
  if (!filename.endsWith(".bz2")) return utf8;
  return bzip2Compress(utf8);
}

// ---------------------------------------------------------------------------
// The download (conda.go:296-322)
// ---------------------------------------------------------------------------

export interface CondaDownload {
  file: PackageFileRow;
  blob: PackageBlobRow;
  stream: ReadableStream;
  size: number;
}

/**
 * DownloadPackageFile's lookup (conda.go:297-311): the search must answer
 * EXACTLY one row (zero OR multiple is the 404 — conda.go:308's len != 1);
 * the lead file bumps the version counter on GET (packages.go:668).
 */
export async function openCondaFileForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  channel: string,
  subdir: string,
  filename: string,
  method: "GET" | "HEAD",
): Promise<CondaDownload | null> {
  if (filename === "") return null;
  const matches = await searchCondaFiles(d1, owner.id, channel, subdir, filename);
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (match === undefined) return null;
  const descriptors = await getFileDescriptors(d1, match.version.id);
  const descriptor = descriptors.find((entry) => entry.file.id === match.file.id);
  if (descriptor === undefined) return null;
  const object = await bucket.get(packageBlobContentKey(descriptor.blob.hashSha256));
  if (object === null) return null;
  if (method === "GET") {
    // The counter is the download's OBSERVABILITY, not its gate (services/
    // packages/packages.go:666-670 — upstream logs the increment failure
    // and returns the opened file regardless; a failed write must not turn
    // a servable blob into a 500).
    try {
      await incrementDownloadCounter(d1, match.version.id);
    } catch (error) {
      console.error(`[packages:conda] Error incrementing download counter (version ${match.version.id}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { file: descriptor.file, blob: descriptor.blob, stream: object.body, size: object.size };
}

// ---------------------------------------------------------------------------
// The upload (conda.go:189-294)
// ---------------------------------------------------------------------------

export interface UploadCondaPackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  /** The channel path segment ("" = the default channel). */
  channel: string;
  /** The URL filename — gated by isCondaPackageFileName. */
  filename: string;
  content: ReadableStream<Uint8Array>;
  declaredLength: number | undefined;
  quota: PackagesQuotaConfig;
  now?: Date;
  spoolKey?: string;
}

export interface UploadCondaPackageResult {
  pkg: { id: number; name: string };
  version: PackageVersionRow;
  file: PackageFileRow;
  blob: PackageBlobRow;
  parsed: CondaPackage;
}

/** The package properties write (conda.go:262-265 — at package CREATION
 *  only; the empty-channel row is load-bearing for the search). */
async function writeCondaPackageProperties(d1: D1Database, packageId: number, name: string, channel: string): Promise<void> {
  await drizzle(d1)
    .insert(packageProperties)
    .values([
      { refType: PropertyType.Package, refId: packageId, name: CONDA_PROPERTY_NAME, value: name },
      { refType: PropertyType.Package, refId: packageId, name: CONDA_PROPERTY_CHANNEL, value: channel },
    ])
    .run();
}

/** The file properties write (conda.go:275-278). */
async function writeCondaFileProperties(
  d1: D1Database,
  fileId: number,
  parsed: CondaPackage,
): Promise<void> {
  await drizzle(d1)
    .insert(packageProperties)
    .values([
      { refType: PropertyType.File, refId: fileId, name: CONDA_PROPERTY_SUBDIR, value: parsed.subdir },
      {
        refType: PropertyType.File,
        refId: fileId,
        name: CONDA_PROPERTY_METADATA,
        value: buildCondaFileMetadataJson(parsed.fileMetadata),
      },
    ])
    .run();
}

/**
 * UploadPackageFile's store walk (conda.go:189-294): the filename gate,
 * the spool → parse (the container dispatch by suffix, conda.go:213-217)
 * → size-quota → create chain. CreatePackageOrAddFileToExisting: the
 * package properties ride package creation, the version metadata rides
 * version creation, and ANY duplicate (version, file, composite-key) row
 * is the ErrDuplicatePackageFile 409 (no OverwriteExisting).
 */
export async function uploadCondaPackageFile(input: UploadCondaPackageInput): Promise<UploadCondaPackageResult> {
  const now = input.now ?? new Date();
  if (!isCondaPackageFileName(input.filename)) {
    // Unreachable through the route (it gates first, conda.go:191-194) —
    // kept so the service alone still refuses foreign names.
    throw new CondaInvalidStructureError();
  }
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
    maxBytes: MAX_PACKAGE_BLOB_BYTES,
    spoolKey: input.spoolKey,
  });

  try {
    const spoolObject = await input.bucket.get(spooled.spoolKey);
    if (spoolObject === null) {
      throw new Error("package spool object vanished");
    }
    const bytes = new Uint8Array(await spoolObject.arrayBuffer());

    // conda.go:213-217 — the container dispatch by filename suffix.
    const parsed = input.filename.endsWith(".conda")
      ? await parseCondaPackageConda(bytes)
      : parseCondaPackageTarBz2(bytes);

    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, CONDA_PACKAGE_TYPE, bytes.byteLength, input.quota);

    // conda.go:232-237 — the package name carries the channel prefix.
    const fullName = input.channel === "" ? parsed.name : `${input.channel}/${parsed.name}`;

    const { row: pkg, created: packageCreated } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: CONDA_PACKAGE_TYPE,
      name: fullName,
      semverCompatible: false,
      now,
    });
    if (packageCreated) {
      await writeCondaPackageProperties(input.d1, pkg.id, parsed.name, input.channel);
    }
    const { row: version, created: versionCreated } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: parsed.version,
      now,
    });
    if (versionCreated) {
      await writeVersionMetadata(input.d1, version.id, buildCondaVersionMetadataJson(parsed.versionMetadata));
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

    // conda.go:269-271 — `{name}-{version}-{build}{ext}` under the subdir
    // composite key (an empty build renders the trailing dash, Go's
    // Sprintf verbatim).
    const extension = parsed.fileMetadata.is_conda ? ".conda" : ".tar.bz2";
    const storedName = `${parsed.name}-${parsed.version}-${parsed.fileMetadata.build}${extension}`;
    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: storedName,
      isLead: true,
      compositeKey: parsed.subdir,
      now,
    });
    if (fileResult.outcome !== "created") {
      throw new DuplicatePackageFileError(fileResult.row);
    }
    await writeCondaFileProperties(input.d1, fileResult.row.id, parsed);

    return { pkg: { id: pkg.id, name: pkg.name }, version, file: fileResult.row, blob, parsed };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

// Re-exported for the route mapper's error list (the 413 store cap + the
// lying-Content-Length posture).
export { MAX_PACKAGE_BLOB_BYTES, PackageBlobTooLargeError, PackageSizeMismatchError };

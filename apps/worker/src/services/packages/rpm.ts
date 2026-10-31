/**
 * The RPM (yum/dnf) registry family (SPEC-0016 §7 M7) — upstream at the pin
 * fc4936884584: routers/api/packages/rpm/rpm.go (471 ln) + services/packages/
 * rpm/repository.go (709 ln) + services/packages/rpm/sign.go (26 ln) +
 * modules/packages/rpm/header.go (259 ln, the binary header reader) +
 * metadata.go (303 ln, the tag extraction) + models/packages/rpm/search.go
 * (GetGroups).
 *
 * ## The index-builder posture (the M7 family's stored-index answer)
 *
 * Identical to the debian/alpine siblings: indices are STORED, not rendered
 * per request — every upload/delete/errata ends with
 * `BuildSpecificRepositoryFiles` (rpm.go:213/322/465 → repository.go:136-236)
 * and the createrepo-shaped repodata files (`primary.xml.gz`,
 * `filelists.xml.gz`, `other.xml.gz`, optionally `updateinfo.xml.gz`, plus
 * `repomd.xml` + the GPG-detached `repomd.xml.asc`) live as files of the
 * internal `_rpm` + `_repository` package version (repository.go:34-36),
 * keyed by the group path segment as the composite key. The GET arms are
 * plain file lookups (rpm.go:93-119); HEAD answers bare existence
 * (rpm.go:68-90). The empty-group arm deletes the group's files
 * (repository.go:152-165 — upstream wipes EVERY group's internal files
 * there; ours keeps the family's per-key posture, the debian/alpine
 * precedent).
 *
 * ## The RPM header parse (modules/packages/rpm/header.go port)
 *
 * The binary format (https://rpm-software-management.github.io/rpm/manual/
 * format_v4.html): a 96-byte lead (magic 0xedabeedb), the signature header
 * section (≤32 entries, ≤64 MiB data — the pin's hdrblobVerifyLengths
 * bounds), an 8-byte alignment pad, and the main header section (≤0xffff
 * entries, ≤0x0fffffff data). Each section: 16-byte intro (magic
 * 0x8eade801, indexCount, dataSize), 16-byte index entries (tag/type/
 * offset/count, big-endian) and the data store. The reader validates the
 * index like rpmlib's hdrblobVerifyInfo (monotonic offsets, per-type length
 * checks, the ≤63 region tag skipped at position 0) and verifies the
 * signature header's SHA-256/SHA-1 digest over the main header bytes
 * (header.go:202-210). The tag extraction (metadata.go:106-263) reads
 * name/version/release/epoch/arch plus the provides/requires/conflicts/
 * obsoletes triples, the dirnames/basenames/dirindexes file list, and the
 * changelog triple. The parse reads ONLY the header bytes off the spooled
 * upload (upstream never touches the payload either — ParsePackage's
 * io.Reader is consumed exactly through the second header).
 *
 * ## Signing (the keypair answer)
 *
 * Upstream serves an owner-scoped OpenPGP keypair (repository.key,
 * rpm.go:55-66 — GetOrCreateKeyPair under `rpm.key.private/public`) and
 * signs `repomd.xml` into an armored detached `repomd.xml.asc`
 * (repository.go:239-309, openpgp.ArmoredDetachSign — RSA-SHA256, the
 * go-crypto default). That is exactly the subset distro-common's OpenPGP v4
 * signer implements for debian's Release.gpg — the same signer covers it.
 * The keypair needs the third `rpm.key.created` row (the debian twin's
 * posture): our stored RSA material is SPKI/PKCS#8 PEM without a creation
 * timestamp, and the OpenPGP key packet bytes must be STABLE or the key
 * id/fingerprint would drift between requests.
 *
 * ## Documented reductions
 *
 *  - The upload-time package re-signing arm (`?sign=true` /
 *    `setting.Packages.DefaultRPMSignEnabled`, rpm.go:138-152 → module
 *    sign.go's SignPackage) is NOT ported. Upstream's default is OFF; the
 *    re-sign requires the signature-region rewrite (marshalSignature) plus
 *    MD5 payload verification (the payloadVerifier fallback — WebCrypto has
 *    no MD5, the debian MD5-reduction posture). Packages signed at build
 *    time with rpmsign pass through untouched; `?sign=true` is accepted and
 *    ignored.
 *  - RSA-2048 (upstream openpgp.NewEntity's 4096-bit default — the
 *    documented Workers-cost divergence, the debian/alpine precedent).
 *  - The header parse reads a bounded region (lead + both header sections ≤
 *    64 MiB total — real signature+header sections are tens of KiB);
 *    beyond it the upload answers 400 "invalid RPM package".
 *  - The repodata search result order is file lower_name ascending
 *    (upstream's SearchFiles leaves the order to the engine's default; the
 *    debian/alpine family pins it).
 *  - `Origin`/`AppName` renders the literal "Gitea" (the landed
 *    instance-name posture; upstream renders setting.AppName), and the
 *    config's absolute URLs derive from the request origin (upstream's
 *    setting.AppURL).
 */

import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageBlobs, packageFiles, packageProperties, packages, packageVersions } from "../../db/schema";
import {
  asciiBytes,
  bytesToHex,
  concatBytes,
  getOrCreateInternalPackageVersion,
  getOrCreateOwnerKeyPair,
  gzipCompress,
  loadOpenPgpKey,
  openPgpArmoredDetachedSign,
  openPgpTransferablePublicKey,
  packageBlobContentKey,
  PropertyType,
  storeRepositoryFile,
  deleteRepositoryFile,
  type InternalRepositoryVersion,
} from "./distro-common";
import {
  copySpoolToContentKey,
  getOrInsertBlob,
  MAX_PACKAGE_BLOB_BYTES,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import {
  checkSizeQuotaExceeded,
  countVersions,
  deletePackageFile,
  deletePackageVersionAndReferences,
  getFileForVersionByName,
  getVersionByNameAndVersion,
  getOrInsertPackage,
  getOrInsertVersion,
  hasVersionFileReferences,
  incrementDownloadCounter,
  QuotaTotalCountError,
  tryInsertFile,
  UNLIMITED_QUOTA,
  type PackageOwnerRow,
  type PackagesQuotaConfig,
} from "./model";
import { DuplicatePackageFileError } from "./generic";
import { isValidAbsoluteHttpUrl, writeVersionMetadata } from "./protocol-common";

// ---------------------------------------------------------------------------
// Upstream constants (modules/packages/rpm/metadata.go:16-26)
// ---------------------------------------------------------------------------

export const RPM_PROPERTY_METADATA = "rpm.metadata";
export const RPM_PROPERTY_GROUP = "rpm.group";
export const RPM_PROPERTY_ARCHITECTURE = "rpm.architecture";

const RPM_SETTING_KEY_PRIVATE = "rpm.key.private";
const RPM_SETTING_KEY_PUBLIC = "rpm.key.public";
/** The OpenPGP key-packet creation-time pin (the debian.key.created twin). */
const RPM_SETTING_KEY_CREATED = "rpm.key.created";

export const RPM_REPOSITORY_PACKAGE = "_rpm";
export const RPM_REPOSITORY_VERSION = "_repository";

/** The internal repository files of one group (the builder's output set). */
const RPM_REPODATA_FILENAMES = [
  "primary.xml.gz",
  "filelists.xml.gz",
  "other.xml.gz",
  "updateinfo.xml.gz",
  "repomd.xml",
  "repomd.xml.asc",
] as const;

/** The header-region parse gate (the module-header reduction note). */
const MAX_RPM_PARSE_BYTES = 64 * 1024 * 1024;

/** The errata POST body bound (the npm dist-tag cap's posture — the payload
 *  is a control-plane JSON array, never a package stream). */
export const MAX_RPM_ERRATA_BODY_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Errors — upstream's sentinel (modules/packages/rpm/header.go:23)
// ---------------------------------------------------------------------------

export class RpmInvalidPackageError extends Error {
  constructor() {
    super("invalid RPM package");
    this.name = "RpmInvalidPackageError";
  }
}

/** The errata arm's 404 sentinel (models/packages/package.go:25's
 *  ErrPackageNotExist text). */
export class RpmPackageNotExistError extends Error {
  constructor() {
    super("package does not exist");
    this.name = "RpmPackageNotExistError";
  }
}

// ---------------------------------------------------------------------------
// The binary header reader (modules/packages/rpm/header.go:25-260)
// ---------------------------------------------------------------------------

const LEAD_SIZE = 96;
const LEAD_MAGIC = 0xedabeedb;
const HEADER_MAGIC = 0x8eade801;
const HEADER_INTRO_SIZE = 16;
const INDEX_ENTRY_SIZE = 16;
const MAX_HEADER_ENTRIES = 0xffff; // rpmlib's hdrblobVerifyLengths limits
const MAX_HEADER_DATA = 0x0fffffff;
const MAX_HEADER_ARRAY = 0x000fffff;
const MAX_SIGNATURE_ENTRIES = 32;
const MAX_SIGNATURE_DATA = 64 * 1024 * 1024;
const MAX_REGION_TAG = 63;

// The type iota (header.go:39-50).
const TYPE_NULL = 0;
const TYPE_CHAR = 1;
const TYPE_INT8 = 2;
const TYPE_INT16 = 3;
const TYPE_INT32 = 4;
const TYPE_INT64 = 5;
const TYPE_STRING = 6;
const TYPE_BIN = 7;
const TYPE_STRING_ARRAY = 8;
const TYPE_I18NSTRING = 9;

const TYPE_SIZES = new Map<number, number>([
  [TYPE_NULL, 0],
  [TYPE_CHAR, 1],
  [TYPE_INT8, 1],
  [TYPE_INT16, 2],
  [TYPE_INT32, 4],
  [TYPE_INT64, 8],
  [TYPE_BIN, 1],
]);

// The tags the metadata extraction reads (header.go:54-104).
const TAG_NAME = 1000;
const TAG_VERSION = 1001;
const TAG_RELEASE = 1002;
const TAG_EPOCH = 1003;
const TAG_SUMMARY = 1004;
const TAG_DESCRIPTION = 1005;
const TAG_BUILD_TIME = 1006;
const TAG_BUILD_HOST = 1007;
const TAG_SIZE = 1009;
const TAG_VENDOR = 1011;
const TAG_LICENSE = 1014;
const TAG_PACKAGER = 1015;
const TAG_GROUP = 1016;
const TAG_URL = 1020;
const TAG_ARCH = 1022;
const TAG_FILE_MODES = 1030;
const TAG_FILE_MTIMES = 1034;
const TAG_FILE_FLAGS = 1037;
const TAG_SOURCE_RPM = 1044;
const TAG_PROVIDE_NAME = 1047;
const TAG_REQUIRE_FLAGS = 1048;
const TAG_REQUIRE_NAME = 1049;
const TAG_REQUIRE_VERSION = 1050;
const TAG_CONFLICT_FLAGS = 1053;
const TAG_CONFLICT_NAME = 1054;
const TAG_CONFLICT_VERSION = 1055;
const TAG_CHANGELOG_TIME = 1080;
const TAG_CHANGELOG_NAME = 1081;
const TAG_CHANGELOG_TEXT = 1082;
const TAG_OBSOLETE_NAME = 1090;
const TAG_PROVIDE_FLAGS = 1112;
const TAG_PROVIDE_VERSION = 1113;
const TAG_OBSOLETE_FLAGS = 1114;
const TAG_OBSOLETE_VERSION = 1115;
const TAG_DIR_INDEXES = 1116;
const TAG_BASE_NAMES = 1117;
const TAG_DIR_NAMES = 1118;
const SIG_TAG_SHA1 = 269;
const SIG_TAG_SHA256 = 273;
const SIG_TAG_PAYLOAD_SIZE = 1007;

// The dependency-sense and file-flag bits (metadata.go:28-40 — the syscall
// constants upstream can't reach on windows builds).
const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IXUSR = 0x40;
const S_IXGRP = 0x8;
const S_IXOTH = 0x1;
const SENSE_LESS = 0x2;
const SENSE_GREATER = 0x4;
const SENSE_EQUAL = 0x8;
const FILE_GHOST = 0x40;

interface HeaderEntry {
  typ: number;
  count: number;
  data: Uint8Array;
}

interface RpmHeader {
  /** intro + index + store — the digest verification hashes THIS. */
  raw: Uint8Array;
  entries: Map<number, HeaderEntry>;
}

function u32At(bytes: Uint8Array, offset: number): number {
  // >>> 0 — the signed-int32 bitwise result goes unsigned (the lead/header
  // magics both exceed 2^31).
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

/** dataLength (header.go:157-176) — the consumed byte count of one entry, or
 *  null when the type/count is impossible for the remaining store. */
function headerDataLength(typ: number, count: number, data: Uint8Array, from: number): number | null {
  if (typ === TYPE_STRING || typ === TYPE_STRING_ARRAY || typ === TYPE_I18NSTRING) {
    if (count > data.byteLength - from) return null;
    let n = 0;
    for (let i = 0; i < count; i++) {
      const nul = data.indexOf(0, from + n);
      if (nul < 0) return null;
      n = nul - from + 1;
    }
    return n;
  }
  const size = TYPE_SIZES.get(typ);
  if (size === undefined) return null;
  const total = size * count;
  return total <= data.byteLength - from ? total : null;
}

/** readHeader (header.go:118-155) — validates the index like rpmlib's
 *  hdrblobVerifyInfo so data is only captured as it is read. The section
 *  lives at `start`; the store-length bound matches upstream's
 *  `store[offset:]` (an entry may not read past the declared store end). */
function readHeaderSection(bytes: Uint8Array, start: number, maxEntries: number, maxData: number): { header: RpmHeader; end: number } {
  if (start + HEADER_INTRO_SIZE > bytes.byteLength) throw new RpmInvalidPackageError();
  const indexCount = u32At(bytes, start + 8);
  const dataSize = u32At(bytes, start + 12);
  if (u32At(bytes, start) !== HEADER_MAGIC || indexCount > maxEntries || dataSize > maxData) {
    throw new RpmInvalidPackageError();
  }
  const size = HEADER_INTRO_SIZE + indexCount * INDEX_ENTRY_SIZE + dataSize;
  if (start + size > bytes.byteLength || start + size > MAX_RPM_PARSE_BYTES) throw new RpmInvalidPackageError();
  const raw = bytes.slice(start, start + size);
  const storeOffset = HEADER_INTRO_SIZE + indexCount * INDEX_ENTRY_SIZE;
  const entries = new Map<number, HeaderEntry>();
  const indexStart = start + HEADER_INTRO_SIZE;
  let end = 0;
  for (let i = 0; i < indexCount; i++) {
    const entry = indexStart + i * INDEX_ENTRY_SIZE;
    const tag = u32At(bytes, entry);
    const typ = u32At(bytes, entry + 4);
    const offset = u32At(bytes, entry + 8);
    const count = u32At(bytes, entry + 12);
    if (i === 0 && tag <= MAX_REGION_TAG) continue; // the region entry
    if (offset < end || offset > dataSize || (typ !== TYPE_BIN && count > MAX_HEADER_ARRAY)) {
      throw new RpmInvalidPackageError();
    }
    const n = headerDataLength(typ, count, raw, storeOffset + offset);
    if (n === null) throw new RpmInvalidPackageError();
    end = offset + n;
    entries.set(tag, { typ, count, data: raw.slice(storeOffset + offset, storeOffset + offset + n) });
  }
  return { header: { raw, entries }, end: start + size };
}

function signaturePadding(size: number): number {
  return (8 - (size % 8)) % 8;
}

async function shaHex(bytes: Uint8Array, algorithm: "SHA-1" | "SHA-256"): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest(algorithm, bytes)));
}

/** readHeaders (header.go:178-212): lead → signature header → alignment pad →
 *  main header, then the signature's SHA-256/SHA-1 digest must match the main
 *  header bytes. */
async function readHeaders(bytes: Uint8Array): Promise<{ sig: RpmHeader; header: RpmHeader }> {
  if (bytes.byteLength < LEAD_SIZE || u32At(bytes, 0) !== LEAD_MAGIC) throw new RpmInvalidPackageError();
  const { header: sig, end: sigEnd } = readHeaderSection(bytes, LEAD_SIZE, MAX_SIGNATURE_ENTRIES, MAX_SIGNATURE_DATA);
  const headerStart = sigEnd + signaturePadding(sig.raw.byteLength);
  const { header } = readHeaderSection(bytes, headerStart, MAX_HEADER_ENTRIES, MAX_HEADER_DATA);
  let digest = firstString(sig, SIG_TAG_SHA256);
  if (digest !== "") {
    if ((await shaHex(header.raw, "SHA-256")) !== digest) throw new RpmInvalidPackageError();
  } else if ((digest = firstString(sig, SIG_TAG_SHA1)) !== "") {
    if ((await shaHex(header.raw, "SHA-1")) !== digest) throw new RpmInvalidPackageError();
  }
  return { sig, header };
}

/** getStrings (header.go:218-224) — count null-terminated strings split on
 *  the final NUL. */
function stringsOf(header: RpmHeader, tag: number): string[] {
  const entry = header.entries.get(tag);
  if (entry === undefined || entry.count === 0) return [];
  if (entry.typ !== TYPE_STRING && entry.typ !== TYPE_STRING_ARRAY && entry.typ !== TYPE_I18NSTRING) return [];
  const text = new TextDecoder().decode(entry.data.subarray(0, entry.data.byteLength - 1));
  return text.split("\x00");
}

function firstString(header: RpmHeader, tag: number): string {
  const values = stringsOf(header, tag);
  return values.length > 0 ? (values[0] ?? "") : "";
}

/** getUints (header.go:233-252) — the integer types chunked by their width. */
function uintsOf(header: RpmHeader, tag: number): number[] {
  const entry = header.entries.get(tag);
  if (entry === undefined || entry.typ < TYPE_CHAR || entry.typ > TYPE_INT64) return [];
  const width = TYPE_SIZES.get(entry.typ) ?? 1;
  const view = new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
  const values: number[] = [];
  for (let offset = 0; offset + width <= entry.data.byteLength; offset += width) {
    switch (width) {
      case 1:
        values.push(view.getUint8(offset));
        break;
      case 2:
        values.push(view.getUint16(offset));
        break;
      case 4:
        values.push(view.getUint32(offset));
        break;
      default:
        // Uint64 values (sizes/timestamps) fit Number for every real rpm;
        // upstream carries them as uint64.
        values.push(Number(view.getBigUint64(offset)));
        break;
    }
  }
  return values;
}

function firstUint(header: RpmHeader, tag: number): number {
  const values = uintsOf(header, tag);
  return values.length > 0 ? (values[0] ?? 0) : 0;
}

// ---------------------------------------------------------------------------
// The metadata shapes (modules/packages/rpm/metadata.go:45-103 — the Go JSON
// tag spellings are the STORED property keys, so the interfaces use them)
// ---------------------------------------------------------------------------

export interface RpmEntry {
  name: string;
  flags?: string;
  version?: string;
  epoch?: string;
  release?: string;
}

export interface RpmFileEntry {
  path: string;
  type?: string;
  is_executable: boolean;
}

export interface RpmChangelog {
  author?: string;
  date?: number;
  text?: string;
}

export interface RpmFileMetadata {
  architecture?: string;
  epoch?: string;
  version?: string;
  release?: string;
  vendor?: string;
  group?: string;
  packager?: string;
  source_rpm?: string;
  build_host?: string;
  build_time?: number;
  file_time?: number;
  installed_size?: number;
  archive_size?: number;
  provide?: RpmEntry[];
  require?: RpmEntry[];
  conflict?: RpmEntry[];
  obsolete?: RpmEntry[];
  files?: RpmFileEntry[];
  changelogs?: RpmChangelog[];
}

export interface RpmVersionMetadata {
  license?: string;
  project_url?: string;
  summary?: string;
  description?: string;
  updates?: RpmUpdate[];
}

export interface RpmDateAttr {
  date: string;
}

export interface RpmUpdate {
  from: string;
  status: string;
  type: string;
  version: string;
  id: string;
  title: string;
  severity: string;
  description: string;
  issued?: RpmDateAttr;
  updated?: RpmDateAttr;
  references: RpmReference[];
  pkg_list: RpmCollection[];
}

export interface RpmReference {
  href: string;
  id: string;
  title: string;
  type: string;
}

export interface RpmCollection {
  short: string;
  packages: RpmUpdatePackage[];
}

export interface RpmUpdatePackage {
  arch: string;
  name: string;
  release: string;
  src: string;
  version: string;
  filename: string;
}

export interface RpmPackageInfo {
  name: string;
  version: string;
  versionMetadata: RpmVersionMetadata;
  fileMetadata: RpmFileMetadata;
}

/** getEntries (metadata.go:163-209) — the provides/requires/conflicts/
 *  obsoletes triples folded into display entries. */
function getEntries(header: RpmHeader, namesTag: number, versionsTag: number, flagsTag: number): RpmEntry[] {
  const names = stringsOf(header, namesTag);
  const flags = uintsOf(header, flagsTag);
  const versions = stringsOf(header, versionsTag);
  if (names.length === 0 || names.length !== flags.length || names.length !== versions.length) return [];
  const entries: RpmEntry[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i] ?? "";
    const flag = flags[i] ?? 0;
    const entry: RpmEntry = { name };
    if ((flag & SENSE_GREATER) !== 0 && (flag & SENSE_EQUAL) !== 0) entry.flags = "GE";
    else if ((flag & SENSE_LESS) !== 0 && (flag & SENSE_EQUAL) !== 0) entry.flags = "LE";
    else if ((flag & SENSE_GREATER) !== 0) entry.flags = "GT";
    else if ((flag & SENSE_LESS) !== 0) entry.flags = "LT";
    else if ((flag & SENSE_EQUAL) !== 0) entry.flags = "EQ";
    const version = versions[i] ?? "";
    if (version !== "") {
      const parts = version.split("-");
      const versionParts = (parts[0] ?? "").split(":");
      if (versionParts.length === 2) {
        entry.version = versionParts[1];
        entry.epoch = versionParts[0];
      } else {
        entry.version = versionParts[0];
        entry.epoch = "0";
      }
      if (parts.length > 1) entry.release = parts[1];
    }
    entries.push(entry);
  }
  return entries;
}

/** getFiles (metadata.go:211-246) — basenames + dirnames[dirindexes] with the
 *  ghost/dir/executable mode fold. */
function getFiles(header: RpmHeader): RpmFileEntry[] {
  const baseNames = stringsOf(header, TAG_BASE_NAMES);
  const dirNames = stringsOf(header, TAG_DIR_NAMES);
  const dirIndexes = uintsOf(header, TAG_DIR_INDEXES);
  const fileFlags = uintsOf(header, TAG_FILE_FLAGS);
  const fileModes = uintsOf(header, TAG_FILE_MODES);
  const files: RpmFileEntry[] = [];
  for (let i = 0; i < baseNames.length; i++) {
    const base = baseNames[i] ?? "";
    const dirIndex = dirIndexes[i];
    if (dirIndex === undefined || dirIndex >= dirNames.length) continue;
    let fileType: string | undefined;
    let isExecutable = false;
    const mode = fileModes[i];
    if (i < fileFlags.length && (fileFlags[i] ?? 0) & FILE_GHOST) {
      fileType = "ghost";
    } else if (mode !== undefined) {
      if ((mode & S_IFMT) === S_IFDIR) {
        fileType = "dir";
      } else {
        const perm = mode & ~S_IFMT;
        isExecutable = (perm & S_IXUSR) !== 0 || (perm & S_IXGRP) !== 0 || (perm & S_IXOTH) !== 0;
      }
    }
    const file: RpmFileEntry = { path: (dirNames[dirIndex] ?? "") + base, is_executable: isExecutable };
    if (fileType !== undefined) file.type = fileType;
    files.push(file);
  }
  return files;
}

/** getChangelogs (metadata.go:248-263) — the equal-length text/author/time
 *  triple. */
function getChangelogs(header: RpmHeader): RpmChangelog[] {
  const texts = stringsOf(header, TAG_CHANGELOG_TEXT);
  const authors = stringsOf(header, TAG_CHANGELOG_NAME);
  const times = uintsOf(header, TAG_CHANGELOG_TIME);
  if (texts.length === 0 || texts.length !== authors.length || texts.length !== times.length) return [];
  const changelogs: RpmChangelog[] = [];
  for (let i = 0; i < texts.length; i++) {
    const changelog: RpmChangelog = {};
    if ((authors[i] ?? "") !== "") changelog.author = authors[i];
    changelog.date = times[i] ?? 0;
    if ((texts[i] ?? "") !== "") changelog.text = texts[i];
    changelogs.push(changelog);
  }
  return changelogs;
}

/** Serialize FileMetadata the way upstream stores it — Go's json.Marshal
 *  field order with omitempty (metadata.go:60-83). `is_executable` and
 *  `path` carry NO omitempty. */
export function serializeRpmFileMetadata(fm: RpmFileMetadata): string {
  const parts: string[] = [];
  const str = (key: string, value: string | undefined): void => {
    if (value !== undefined && value !== "") parts.push(`"${key}":${JSON.stringify(value)}`);
  };
  const num = (key: string, value: number | undefined): void => {
    if (value !== undefined && value !== 0) parts.push(`"${key}":${value}`);
  };
  const list = (key: string, value: unknown[] | undefined): void => {
    if (value !== undefined && value.length > 0) parts.push(`"${key}":${JSON.stringify(value)}`);
  };
  str("architecture", fm.architecture);
  str("epoch", fm.epoch);
  str("version", fm.version);
  str("release", fm.release);
  str("vendor", fm.vendor);
  str("group", fm.group);
  str("packager", fm.packager);
  str("source_rpm", fm.source_rpm);
  str("build_host", fm.build_host);
  num("build_time", fm.build_time);
  num("file_time", fm.file_time);
  num("installed_size", fm.installed_size);
  num("archive_size", fm.archive_size);
  list("provide", fm.provide);
  list("require", fm.require);
  list("conflict", fm.conflict);
  list("obsolete", fm.obsolete);
  list("files", fm.files);
  list("changelogs", fm.changelogs);
  return `{${parts.join(",")}}`;
}

/** The incremental header-region reader: consumes ONLY the bytes the two
 *  header sections need (lead + signature + pad + main header — the payload
 *  is never read, like upstream's io.Reader), so the parse window tracks the
 *  section intros as they arrive instead of buffering the whole upload. */
class HeaderRegionReader {
  private chunks: Uint8Array[] = [];
  private total = 0;
  private done = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** Buffer until at least `n` bytes are present; the stream ending early is
   *  the invalid-package arm (header.go's EOF fold). */
  async ensure(n: number): Promise<Uint8Array> {
    while (this.total < n && !this.done) {
      const read = await this.reader.read();
      if (read.done) {
        this.done = true;
        break;
      }
      this.chunks.push(read.value);
      this.total += read.value.byteLength;
      if (this.total > MAX_RPM_PARSE_BYTES) throw new RpmInvalidPackageError();
    }
    if (this.total < n) throw new RpmInvalidPackageError();
    return this.snapshot();
  }

  snapshot(): Uint8Array {
    return concatBytes(...this.chunks);
  }
}

/** The section size intro at `start` (readHeader's bound checks, split out so
 *  the region reader can drive the reads phase-by-phase). */
function sectionSizeAt(bytes: Uint8Array, start: number, maxEntries: number, maxData: number): { indexCount: number; dataSize: number; size: number } {
  if (start + HEADER_INTRO_SIZE > bytes.byteLength) throw new RpmInvalidPackageError();
  const indexCount = u32At(bytes, start + 8);
  const dataSize = u32At(bytes, start + 12);
  if (u32At(bytes, start) !== HEADER_MAGIC || indexCount > maxEntries || dataSize > maxData) {
    throw new RpmInvalidPackageError();
  }
  const size = HEADER_INTRO_SIZE + indexCount * INDEX_ENTRY_SIZE + dataSize;
  if (size > MAX_RPM_PARSE_BYTES) throw new RpmInvalidPackageError();
  return { indexCount, dataSize, size };
}

/** ParsePackage (metadata.go:106-161) over the SPOOLED upload. */
export async function parseRpmPackage(body: ReadableStream<Uint8Array>): Promise<RpmPackageInfo> {
  const reader = body.getReader();
  try {
    const region = new HeaderRegionReader(reader);
    // The lead (96 bytes), then the signature section's size intro, then its
    // body + alignment pad, then the main section's intro and body.
    let bytes = await region.ensure(LEAD_SIZE + HEADER_INTRO_SIZE);
    if (u32At(bytes, 0) !== LEAD_MAGIC) throw new RpmInvalidPackageError();
    const sig = sectionSizeAt(bytes, LEAD_SIZE, MAX_SIGNATURE_ENTRIES, MAX_SIGNATURE_DATA);
    const pad = signaturePadding(sig.size);
    bytes = await region.ensure(LEAD_SIZE + sig.size + pad + HEADER_INTRO_SIZE);
    const main = sectionSizeAt(bytes, LEAD_SIZE + sig.size + pad, MAX_HEADER_ENTRIES, MAX_HEADER_DATA);
    bytes = await region.ensure(LEAD_SIZE + sig.size + pad + main.size);
    const { sig: sigHeader, header } = await readHeaders(bytes);
    const name = firstString(header, TAG_NAME);
    const ver = firstString(header, TAG_VERSION);
    const rel = firstString(header, TAG_RELEASE);
    const arch = firstString(header, TAG_ARCH);
    if (name === "" || ver === "" || rel === "" || arch === "") throw new RpmInvalidPackageError();
    const epoch = String(firstUint(header, TAG_EPOCH));
    let version = `${ver}-${rel}`;
    if (epoch !== "0") version = `${epoch}-${version}`;
    let projectUrl = firstString(header, TAG_URL);
    if (!isValidAbsoluteHttpUrl(projectUrl)) projectUrl = "";
    const fileMetadata: RpmFileMetadata = {
      architecture: arch,
      epoch,
      version: ver,
      release: rel,
    };
    const optionalStr = (tag: number): string | undefined => {
      const value = firstString(header, tag);
      return value === "" ? undefined : value;
    };
    if (optionalStr(TAG_VENDOR) !== undefined) fileMetadata.vendor = optionalStr(TAG_VENDOR);
    if (optionalStr(TAG_GROUP) !== undefined) fileMetadata.group = optionalStr(TAG_GROUP);
    if (optionalStr(TAG_PACKAGER) !== undefined) fileMetadata.packager = optionalStr(TAG_PACKAGER);
    if (optionalStr(TAG_SOURCE_RPM) !== undefined) fileMetadata.source_rpm = optionalStr(TAG_SOURCE_RPM);
    if (optionalStr(TAG_BUILD_HOST) !== undefined) fileMetadata.build_host = optionalStr(TAG_BUILD_HOST);
    if (firstUint(header, TAG_BUILD_TIME) !== 0) fileMetadata.build_time = firstUint(header, TAG_BUILD_TIME);
    if (firstUint(header, TAG_FILE_MTIMES) !== 0) fileMetadata.file_time = firstUint(header, TAG_FILE_MTIMES);
    if (firstUint(header, TAG_SIZE) !== 0) fileMetadata.installed_size = firstUint(header, TAG_SIZE);
    if (firstUint(sigHeader, SIG_TAG_PAYLOAD_SIZE) !== 0) fileMetadata.archive_size = firstUint(sigHeader, SIG_TAG_PAYLOAD_SIZE);
    const provides = getEntries(header, TAG_PROVIDE_NAME, TAG_PROVIDE_VERSION, TAG_PROVIDE_FLAGS);
    const requires = getEntries(header, TAG_REQUIRE_NAME, TAG_REQUIRE_VERSION, TAG_REQUIRE_FLAGS);
    const conflicts = getEntries(header, TAG_CONFLICT_NAME, TAG_CONFLICT_VERSION, TAG_CONFLICT_FLAGS);
    const obsoletes = getEntries(header, TAG_OBSOLETE_NAME, TAG_OBSOLETE_VERSION, TAG_OBSOLETE_FLAGS);
    const files = getFiles(header);
    const changelogs = getChangelogs(header);
    if (provides.length > 0) fileMetadata.provide = provides;
    if (requires.length > 0) fileMetadata.require = requires;
    if (conflicts.length > 0) fileMetadata.conflict = conflicts;
    if (obsoletes.length > 0) fileMetadata.obsolete = obsoletes;
    if (files.length > 0) fileMetadata.files = files;
    if (changelogs.length > 0) fileMetadata.changelogs = changelogs;
    const versionMetadata: RpmVersionMetadata = {};
    if (optionalStr(TAG_LICENSE) !== undefined) versionMetadata.license = optionalStr(TAG_LICENSE);
    if (projectUrl !== "") versionMetadata.project_url = projectUrl;
    if (optionalStr(TAG_SUMMARY) !== undefined) versionMetadata.summary = optionalStr(TAG_SUMMARY);
    if (optionalStr(TAG_DESCRIPTION) !== undefined) versionMetadata.description = optionalStr(TAG_DESCRIPTION);
    return { name, version, versionMetadata, fileMetadata };
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// The owner keypair (repository.go:39-71) — `rpm.key.private/public` plus the
// `rpm.key.created` OpenPGP packet-creation pin (the debian twin's posture).
// ---------------------------------------------------------------------------

/** GetOrCreateKeyPair (repository.go:39-41) over upstream's setting keys. */
export async function getOrCreateRpmKeyPair(d1: D1Database, ownerId: number): Promise<Awaited<ReturnType<typeof getOrCreateOwnerKeyPair>>> {
  return getOrCreateOwnerKeyPair(d1, ownerId, RPM_SETTING_KEY_PRIVATE, RPM_SETTING_KEY_PUBLIC, "SHA-256", RPM_SETTING_KEY_CREATED);
}

/** The repository.key arm (rpm.go:55-66): the armored transferable public key
 *  (application/pgp-keys). Upstream's uid is go-crypto's NewEntity("",
 *  "RPM Registry", "") rendering — "(RPM Registry)". */
export async function buildRpmRepositoryKey(d1: D1Database, ownerId: number): Promise<string> {
  const keys = await getOrCreateRpmKeyPair(d1, ownerId);
  const createdSeconds = keys.creationTime ?? Math.floor(Date.now() / 1000);
  const key = await loadOpenPgpKey(keys.publicSpki, keys.privateKey, createdSeconds);
  return openPgpTransferablePublicKey(key, "(RPM Registry)", createdSeconds);
}

// ---------------------------------------------------------------------------
// The repo-config render (rpm.go:36-52 — GetRepositoryConfig)
// ---------------------------------------------------------------------------

/** The `[gitea-…]` dnf repo file. `appName` renders the instance name
 *  (upstream setting.AppName); `apiBase` is `<AppURL>api/packages/<owner>/
 *  rpm` (upstream builds it from setting.AppURL). The gpgkey arm points at
 *  the GROUP-LESS repository.key for every group (upstream's exact body —
 *  the keypair is owner-scoped). */
export function renderRpmRepositoryConfig(ownerName: string, ownerLower: string, group: string, apiBase: string, appName: string): string {
  const groupParts = group === "" ? [] : group.split("/");
  const id = ["gitea-" + ownerLower, ...groupParts].join("-");
  const name = [ownerName, appName, ...groupParts].join(" - ");
  const baseurl = [apiBase, ...groupParts].join("/");
  return `[${id}]\nname=${name}\nbaseurl=${baseurl}\nenabled=1\ngpgcheck=1\ngpgkey=${apiBase}/repository.key`;
}

// ---------------------------------------------------------------------------
// Upload (rpm.go:121-219)
// ---------------------------------------------------------------------------

export interface UploadRpmPackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: { id: number; isAdmin: boolean };
  group: string;
  content: ReadableStream<Uint8Array>;
  declaredLength?: number;
  quota: PackagesQuotaConfig;
  now?: Date;
  spoolKey?: string;
  maxBytes?: number;
}

export interface UploadRpmPackageResult {
  file: { id: number; name: string };
  packageInfo: RpmPackageInfo;
}

/**
 * `UploadPackageFile` (rpm.go:121-219) — the debian/alpine upload shape (the
 * count-quota +1 parity pre-insert, the size check after the parse, the D-1
 * any-duplicate 409, the properties triple, the post-write rebuild rider).
 * The file name is `{name}-{version}.{arch}.rpm` where `version` is
 * `{ver}-{rel}` prefixed `{epoch}-` when the epoch is not 0; the composite
 * key IS the group path segment. The `?sign=true` arm is accepted and
 * ignored (the module-header reduction).
 */
export async function uploadRpmPackage(input: UploadRpmPackageInput): Promise<UploadRpmPackageResult> {
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
    maxBytes: input.maxBytes ?? MAX_PACKAGE_BLOB_BYTES,
    spoolKey: input.spoolKey,
  });
  try {
    const spoolObject = await input.bucket.get(spooled.spoolKey);
    if (spoolObject === null) throw new Error("package spool object vanished");
    const packageInfo = await parseRpmPackage(spoolObject.body as ReadableStream<Uint8Array>);
    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "rpm", spooled.size, input.quota);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "rpm",
      name: packageInfo.name,
      semverCompatible: false,
      now,
    });
    const { row: version, created: versionCreated } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: packageInfo.version,
      now,
    });
    if (versionCreated) {
      await writeVersionMetadata(input.d1, version.id, JSON.stringify(packageInfo.versionMetadata));
    }
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

    const architecture = packageInfo.fileMetadata.architecture ?? "";
    const filename = `${packageInfo.name}-${packageInfo.version}.${architecture}.rpm`;
    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: filename,
      isLead: true,
      compositeKey: input.group,
      now,
    });
    if (fileResult.outcome !== "created") {
      throw new DuplicatePackageFileError(fileResult.row);
    }
    await drizzle(input.d1)
      .insert(packageProperties)
      .values([
        { refType: PropertyType.File, refId: fileResult.row.id, name: RPM_PROPERTY_GROUP, value: input.group },
        { refType: PropertyType.File, refId: fileResult.row.id, name: RPM_PROPERTY_ARCHITECTURE, value: architecture },
        { refType: PropertyType.File, refId: fileResult.row.id, name: RPM_PROPERTY_METADATA, value: serializeRpmFileMetadata(packageInfo.fileMetadata) },
      ])
      .run();

    await buildRpmRepositoryFiles(input.d1, input.bucket, input.owner.id, input.group, now);
    return { file: { id: fileResult.row.id, name: filename }, packageInfo };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The repodata search (repository.go:142-147 over the generic SearchFiles,
// models/packages/package_file.go:230 + toConds)
// ---------------------------------------------------------------------------

interface RpmIndexRow {
  file: typeof packageFiles.$inferSelect;
  blob: typeof packageBlobs.$inferSelect;
  version: typeof packageVersions.$inferSelect;
  packageName: string;
  fileMetadata: RpmFileMetadata;
  versionMetadata: RpmVersionMetadata;
}

/** The rpm.metadata property subselect (the debian/alpine shape). */
function filePropertySubselect(name: string): SQL<string> {
  return sql<string>`(
    select pp.value from package_properties pp
    where pp.ref_type = ${PropertyType.File} and pp.ref_id = ${packageFiles.id}
      and pp.name = ${name} limit 1)`;
}

/**
 * SearchFiles(OwnerID, PackageType=rpm, Query="%.rpm", CompositeKey=group)
 * (package_file.go:230-241 + toConds): the version subselect pins
 * `is_internal = false` + owner + type; the composite filter is DROPPED for
 * the empty group (toConds' `opts.CompositeKey != ""` guard); the metadata
 * property carries the parse product. The order pins file lower_name (the
 * family posture — upstream leaves the engine default).
 */
async function searchRpmFiles(d1: D1Database, ownerId: number, group: string): Promise<RpmIndexRow[]> {
  const db = drizzle(d1);
  const rows = await db
    .select({
      file: packageFiles,
      blob: packageBlobs,
      version: packageVersions,
      packageName: packages.name,
      fileMetadataRaw: filePropertySubselect(RPM_PROPERTY_METADATA),
    })
    .from(packageFiles)
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
    .where(
      and(
        eq(packages.type, "rpm"),
        eq(packages.ownerId, ownerId),
        eq(packages.isInternal, false),
        eq(packageVersions.isInternal, false),
        sql`${packageFiles.lowerName} like '%.rpm'`,
        ...(group !== "" ? [eq(packageFiles.compositeKey, group)] : []),
      ),
    )
    .orderBy(asc(packageFiles.lowerName))
    .all();
  return rows.map(({ file, blob, version, packageName, fileMetadataRaw }) => ({
    file,
    blob,
    version,
    packageName: packageName ?? "",
    fileMetadata: fileMetadataRaw ? (JSON.parse(fileMetadataRaw) as RpmFileMetadata) : {},
    versionMetadata: version.metadataJson ? (JSON.parse(version.metadataJson) as RpmVersionMetadata) : {},
  }));
}

// ---------------------------------------------------------------------------
// The repodata XML renders (repository.go:311-545) — Go's encoding/xml shape:
 // fields in struct order, empty elements as explicit open+close pairs, and
// EscapeText's escapes (& < > " ' \t \n \r) everywhere.
// ---------------------------------------------------------------------------

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** Go encoding/xml's escapeText (the invalid-control-char arm maps to
 *  U+FFFD like Go's rune fold). */
function xmlEscape(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    switch (char) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&#34;";
        break;
      case "'":
        out += "&#39;";
        break;
      case "\t":
        out += "&#x9;";
        break;
      case "\n":
        out += "&#xA;";
        break;
      case "\r":
        out += "&#xD;";
        break;
      default:
        if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) out += "\uFFFD";
        else out += char;
    }
  }
  return out;
}

function el(name: string, attrs: string, text?: string): string {
  const open = attrs === "" ? `<${name}>` : `<${name} ${attrs}>`;
  if (text === undefined) return `${open}</${name}>`;
  return `${open}${xmlEscape(text)}</${name}>`;
}

/** The composite wrapper: `inner` is ALREADY-ESCAPED markup assembled from
 *  el()/attr() leaves — only leaves escape (the same split Go's encoder
 *  makes between chardata and element structure). */
function wrapEl(name: string, attrs: string, inner: string): string {
  const open = attrs === "" ? `<${name}>` : `<${name} ${attrs}>`;
  return `${open}${inner}</${name}>`;
}

function attr(name: string, value: string | number): string {
  return `${name}="${xmlEscape(String(value))}"`;
}

function versionEl(epoch: string | undefined, ver: string | undefined, rel: string | undefined): string {
  return el("version", `${attr("epoch", epoch ?? "")} ${attr("ver", ver ?? "")} ${attr("rel", rel ?? "")}`);
}

function fileEls(files: RpmFileEntry[] | undefined): string {
  let out = "";
  for (const file of files ?? []) {
    out += file.type === undefined ? el("file", "", file.path) : el("file", attr("type", file.type), file.path);
  }
  return out;
}

/** The primary.xml `<package>` entry (repository.go:312-451). */
function primaryPackageEl(row: RpmIndexRow): string {
  const fm = row.fileMetadata;
  const vm = row.versionMetadata;
  const executableFiles = (fm.files ?? []).filter((file) => file.is_executable);
  const formatInner =
    el("rpm:license", "", vm.license ?? "") +
    el("rpm:vendor", "", fm.vendor ?? "") +
    el("rpm:group", "", fm.group ?? "") +
    el("rpm:buildhost", "", fm.build_host ?? "") +
    el("rpm:sourcerpm", "", fm.source_rpm ?? "") +
    entryWrapper("rpm:provides", fm.provide) +
    entryWrapper("rpm:requires", fm.require) +
    entryWrapper("rpm:conflicts", fm.conflict) +
    entryWrapper("rpm:obsoletes", fm.obsolete) +
    fileEls(executableFiles);
  const format = wrapEl("format", "", formatInner);
  return (
    `<package ${attr("type", "rpm")}>` +
    el("name", "", row.packageName) +
    el("arch", "", fm.architecture ?? "") +
    versionEl(fm.epoch, fm.version, fm.release) +
    el("checksum", `${attr("type", "sha256")} ${attr("pkgid", "YES")}`, row.blob.hashSha256) +
    el("summary", "", vm.summary ?? "") +
    el("description", "", vm.description ?? "") +
    el("packager", "", fm.packager ?? "") +
    el("url", "", vm.project_url ?? "") +
    el("time", `${attr("file", fm.file_time ?? 0)} ${attr("build", fm.build_time ?? 0)}`) +
    el("size", `${attr("package", row.blob.size)} ${attr("installed", fm.installed_size ?? 0)} ${attr("archive", fm.archive_size ?? 0)}`) +
    el("location", attr("href", `package/${row.packageName}/${row.version.version}/${fm.architecture ?? ""}/${row.packageName}-${row.version.version}.${fm.architecture ?? ""}.rpm`)) +
    format +
    `</package>`
  );
}

/** The `<rpm:provides>`-family wrapper (an EntryList struct always renders,
 *  even with zero entries). */
function entryWrapper(name: string, entries: RpmEntry[] | undefined): string {
  let inner = "";
  for (const entry of entries ?? []) {
    const attrs = [
      attr("name", entry.name),
      ...(entry.flags !== undefined ? [attr("flags", entry.flags)] : []),
      ...(entry.version !== undefined ? [attr("ver", entry.version)] : []),
      ...(entry.epoch !== undefined ? [attr("epoch", entry.epoch)] : []),
      ...(entry.release !== undefined ? [attr("rel", entry.release)] : []),
    ].join(" ");
    inner += el("rpm:entry", attrs);
  }
  return wrapEl(name, "", inner);
}

function buildPrimaryXml(rows: RpmIndexRow[]): string {
  const packagesEl = rows.map(primaryPackageEl).join("");
  return `${XML_HEADER}${wrapEl("metadata", `${attr("xmlns", "http://linux.duke.edu/metadata/common")} ${attr("xmlns:rpm", "http://linux.duke.edu/metadata/rpm")} ${attr("packages", rows.length)}`, packagesEl)}`;
}

function buildFilelistsXml(rows: RpmIndexRow[]): string {
  let packagesEl = "";
  for (const row of rows) {
    const fm = row.fileMetadata;
    packagesEl +=
      `<package ${attr("pkgid", row.blob.hashSha256)} ${attr("name", row.packageName)} ${attr("arch", fm.architecture ?? "")}>` +
      versionEl(fm.epoch, fm.version, fm.release) +
      fileEls(fm.files) +
      `</package>`;
  }
  return `${XML_HEADER}${wrapEl("filelists", `${attr("xmlns", "http://linux.duke.edu/metadata/other")} ${attr("packages", rows.length)}`, packagesEl)}`;
}

function buildOtherXml(rows: RpmIndexRow[]): string {
  let packagesEl = "";
  for (const row of rows) {
    const fm = row.fileMetadata;
    let changelogs = "";
    for (const changelog of fm.changelogs ?? []) {
      const attrs = [
        attr("author", changelog.author ?? ""),
        attr("date", changelog.date ?? 0),
      ].join(" ");
      changelogs += el("changelog", attrs, changelog.text ?? "");
    }
    packagesEl +=
      `<package ${attr("pkgid", row.blob.hashSha256)} ${attr("name", row.packageName)} ${attr("arch", fm.architecture ?? "")}>` +
      versionEl(fm.epoch, fm.version, fm.release) +
      changelogs +
      `</package>`;
  }
  return `${XML_HEADER}${wrapEl("otherdata", `${attr("xmlns", "http://linux.duke.edu/metadata/other")} ${attr("packages", rows.length)}`, packagesEl)}`;
}

/** buildUpdateInfo (repository.go:560-632): the ID-merged, sorted updateinfo
 *  render. Issued/Updated render only when present (Go's nil pointers). */
function buildUpdateInfoXml(updates: RpmUpdate[]): string {
  let updatesEl = "";
  for (const update of updates) {
    let inner =
      el("id", "", update.id) +
      el("title", "", update.title) +
      el("severity", "", update.severity) +
      el("description", "", update.description);
    if (update.issued !== undefined) inner += el("issued", attr("date", update.issued.date));
    if (update.updated !== undefined) inner += el("updated", attr("date", update.updated.date));
    if ((update.references ?? []).length > 0) {
      let references = "";
      for (const reference of update.references) {
        references += el(
          "reference",
          `${attr("href", reference.href)} ${attr("id", reference.id)} ${attr("title", reference.title)} ${attr("type", reference.type)}`,
        );
      }
      inner += wrapEl("references", "", references);
    }
    if ((update.pkg_list ?? []).length > 0) {
      let collections = "";
      for (const collection of update.pkg_list) {
        let packageEls = "";
        for (const pkg of collection.packages ?? []) {
          packageEls +=
            `<package ${attr("arch", pkg.arch)} ${attr("name", pkg.name)} ${attr("release", pkg.release)} ${attr("src", pkg.src)} ${attr("version", pkg.version)}>` +
            el("filename", "", pkg.filename) +
            `</package>`;
        }
        collections += wrapEl("collection", attr("short", collection.short), packageEls);
      }
      inner += wrapEl("pkglist", "", collections);
    }
    updatesEl +=
      `<update ${attr("from", update.from)} ${attr("status", update.status)} ${attr("type", update.type)} ${attr("version", update.version)}>` +
      inner +
      `</update>`;
  }
  return `${XML_HEADER}${wrapEl("updates", attr("xmlns", "http://linux.duke.edu/metadata/updateinfo"), updatesEl)}`;
}

/** The repomd.xml render (repository.go:239-245). */
function buildRepomdXml(data: RepodataEntry[]): string {
  let dataEls = "";
  for (const entry of data) {
    dataEls +=
      `<data ${attr("type", entry.type)}>` +
      el("checksum", attr("type", "sha256"), entry.checksum) +
      el("open-checksum", attr("type", "sha256"), entry.openChecksum) +
      el("location", attr("href", `repodata/${entry.filename}`)) +
      el("timestamp", "", String(entry.timestamp)) +
      el("size", "", String(entry.size)) +
      el("open-size", "", String(entry.openSize)) +
      `</data>`;
  }
  return `${XML_HEADER}${wrapEl("repomd", `${attr("xmlns", "http://linux.duke.edu/metadata/repo")} ${attr("xmlns:rpm", "http://linux.duke.edu/metadata/rpm")}`, dataEls)}`;
}

interface RepodataEntry {
  type: string;
  checksum: string;
  openChecksum: string;
  filename: string;
  timestamp: number;
  size: number;
  openSize: number;
}

/** addDataAsFileToRepo (repository.go:651-709): gzip the render, hash BOTH
 *  arms, store `{type}.xml.gz`, and answer the repomd `<data>` descriptor.
 *  The open-checksum hashes the UNCOMPRESSED bytes (the counter writer), the
 *  checksum the compressed store. */
async function addDataAsFileToRepo(
  d1: D1Database,
  bucket: R2Bucket,
  repoVersion: InternalRepositoryVersion,
  filetype: string,
  xml: string,
  group: string,
  timestamp: number,
  now: Date,
): Promise<RepodataEntry> {
  const plain = asciiBytes(xml);
  const compressed = await gzipCompress(plain);
  const filename = `${filetype}.xml.gz`;
  await storeRepositoryFile(d1, bucket, {
    versionId: repoVersion.version.id,
    filename,
    compositeKey: group,
    content: compressed,
    properties: {},
    now,
  });
  return {
    type: filetype,
    checksum: await shaHex(compressed, "SHA-256"),
    openChecksum: await shaHex(plain, "SHA-256"),
    filename,
    timestamp,
    size: compressed.byteLength,
    openSize: plain.byteLength,
  };
}

// ---------------------------------------------------------------------------
// BuildSpecificRepositoryFiles (repository.go:136-236)
// ---------------------------------------------------------------------------

/** collectUpdateInfoUpdates (repository.go:547-557) — one copy of each
 *  version's updates, in search order. */
function collectUpdateInfoUpdates(rows: RpmIndexRow[]): RpmUpdate[] {
  const seen = new Set<number>();
  const updates: RpmUpdate[] = [];
  for (const row of rows) {
    if (seen.has(row.version.id)) continue;
    seen.add(row.version.id);
    for (const update of row.versionMetadata.updates ?? []) updates.push(update);
  }
  return updates;
}

/** The ID-merge (repository.go:562-617): collections merge by `short`,
 *  packages dedupe on name+version+release+arch, then the IDs sort. */
function mergeUpdates(updates: RpmUpdate[]): RpmUpdate[] {
  const byId = new Map<string, RpmUpdate>();
  for (const update of updates) {
    const existing = byId.get(update.id);
    if (existing === undefined) {
      byId.set(update.id, {
        ...update,
        references: [...(update.references ?? [])],
        pkg_list: (update.pkg_list ?? []).map((collection) => ({
          short: collection.short,
          packages: [...(collection.packages ?? [])],
        })),
      });
      continue;
    }
    for (const collection of update.pkg_list ?? []) {
      const target = (existing.pkg_list ??= []).find((candidate) => candidate.short === collection.short);
      if (target === undefined) {
        existing.pkg_list.push({ short: collection.short, packages: [...(collection.packages ?? [])] });
        continue;
      }
      for (const pkg of collection.packages ?? []) {
        const duplicate = (target.packages ?? []).some(
          (candidate) =>
            candidate.name === pkg.name && candidate.version === pkg.version && candidate.release === pkg.release && candidate.arch === pkg.arch,
        );
        if (!duplicate) target.packages.push(pkg);
      }
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * BuildSpecificRepositoryFiles (repository.go:136-236): the group's
 * primary/filelists/other (+ updateinfo when any version carries updates),
 * then repomd.xml + the GPG-detached repomd.xml.asc. The empty-group arm
 * deletes the group's own files (repository.go:152-165 narrows to the
 * family's per-key posture — upstream wipes every group's internal files
 * there; the debian/alpine precedent).
 */
export async function buildRpmRepositoryFiles(d1: D1Database, bucket: R2Bucket, ownerId: number, group: string, now?: Date): Promise<void> {
  const at = now ?? new Date();
  const repoVersion = await getOrCreateInternalPackageVersion(d1, ownerId, "rpm", RPM_REPOSITORY_PACKAGE, RPM_REPOSITORY_VERSION);
  const rows = await searchRpmFiles(d1, ownerId, group);
  if (rows.length === 0) {
    for (const filename of RPM_REPODATA_FILENAMES) {
      await deleteRepositoryFile(d1, repoVersion.version.id, filename, group);
    }
    return;
  }
  const timestamp = Math.floor(at.getTime() / 1000);
  const data: RepodataEntry[] = [];
  data.push(await addDataAsFileToRepo(d1, bucket, repoVersion, "primary", buildPrimaryXml(rows), group, timestamp, at));
  data.push(await addDataAsFileToRepo(d1, bucket, repoVersion, "filelists", buildFilelistsXml(rows), group, timestamp, at));
  data.push(await addDataAsFileToRepo(d1, bucket, repoVersion, "other", buildOtherXml(rows), group, timestamp, at));
  const updates = mergeUpdates(collectUpdateInfoUpdates(rows));
  if (updates.length > 0) {
    data.push(await addDataAsFileToRepo(d1, bucket, repoVersion, "updateinfo", buildUpdateInfoXml(updates), group, timestamp, at));
  }
  const repomdXml = buildRepomdXml(data);
  const repomdBytes = asciiBytes(repomdXml);
  await storeRepositoryFile(d1, bucket, {
    versionId: repoVersion.version.id,
    filename: "repomd.xml",
    compositeKey: group,
    content: repomdBytes,
    properties: {},
    now: at,
  });
  const keys = await getOrCreateRpmKeyPair(d1, ownerId);
  const key = await loadOpenPgpKey(keys.publicSpki, keys.privateKey, keys.creationTime ?? timestamp);
  const repomdAsc = await openPgpArmoredDetachedSign(key, repomdBytes, timestamp);
  await storeRepositoryFile(d1, bucket, {
    versionId: repoVersion.version.id,
    filename: "repomd.xml.asc",
    compositeKey: group,
    content: asciiBytes(repomdAsc),
    properties: {},
    now: at,
  });
}

/** GetGroups (models/packages/rpm/search.go:16-21 over
 *  GetDistinctPropertyValues, package_property.go:148-175): the distinct
 *  rpm.group file-property values of the owner's non-internal rpm packages
 *  (the cleanup rebuild-arms' iteration source). */
export async function listRpmGroups(d1: D1Database, ownerId: number): Promise<string[]> {
  const rows = await drizzle(d1)
    .selectDistinct({ value: packageProperties.value })
    .from(packageProperties)
    .innerJoin(packageFiles, eq(packageFiles.id, packageProperties.refId))
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      and(
        eq(packageProperties.refType, PropertyType.File),
        eq(packageProperties.name, RPM_PROPERTY_GROUP),
        eq(packages.type, "rpm"),
        eq(packages.ownerId, ownerId),
      ),
    )
    .all();
  return rows.map((row) => row.value);
}

/** BuildAllRepositoryFiles (repository.go:74-104): delete every internal
 *  file, then rebuild each group (the cleanup rule arm's shape). */
export async function buildAllRpmRepositoryFiles(d1: D1Database, bucket: R2Bucket, ownerId: number, now?: Date): Promise<void> {
  const repoVersion = await getOrCreateInternalPackageVersion(d1, ownerId, "rpm", RPM_REPOSITORY_PACKAGE, RPM_REPOSITORY_VERSION);
  const existing = await drizzle(d1)
    .select({ id: packageFiles.id })
    .from(packageFiles)
    .where(eq(packageFiles.versionId, repoVersion.version.id))
    .all();
  for (const row of existing) {
    await deletePackageFile(d1, row.id);
  }
  for (const group of await listRpmGroups(d1, ownerId)) {
    await buildRpmRepositoryFiles(d1, bucket, ownerId, group, now);
  }
}

// ---------------------------------------------------------------------------
// Serving (rpm.go:68-119 + :221-257) + the errata arm (:331-471) + delete
// (:259-328)
// ---------------------------------------------------------------------------

export interface RpmDownload {
  stream: ReadableStream;
  size: number;
  filename: string;
  created: Date;
}

/** CheckRepositoryFileExistence (rpm.go:68-90) + GetRepositoryFile
 *  (rpm.go:93-119): the stored internal file by (filename, group). The
 *  internal files are IsLead=false, so GET never bumps the counter
 *  (packages.go:665-670's IsLead gate). */
export async function openRpmRepositoryFile(d1: D1Database, bucket: R2Bucket, ownerId: number, group: string, filename: string): Promise<RpmDownload | null> {
  const repoVersion = await getOrCreateInternalPackageVersion(d1, ownerId, "rpm", RPM_REPOSITORY_PACKAGE, RPM_REPOSITORY_VERSION);
  const pair = await drizzle(d1)
    .select({ file: packageFiles, blob: packageBlobs })
    .from(packageFiles)
    .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
    .where(
      and(
        eq(packageFiles.versionId, repoVersion.version.id),
        eq(packageFiles.lowerName, filename.toLowerCase()),
        eq(packageFiles.compositeKey, group),
      ),
    )
    .get();
  if (pair === undefined) return null;
  const object = await bucket.get(packageBlobContentKey(pair.blob.hashSha256));
  if (object === null) return null;
  return { stream: object.body, size: object.size, filename: pair.file.name, created: pair.file.createdUnix };
}

/**
 * DownloadPackageFile (rpm.go:221-257): the `{name}-{version}.{arch}.rpm`
 * file on the exact version (the version string carries the epoch prefix —
 * the URL's {version} is the same spelling), with the noarch fallback when
 * the requested architecture is not noarch. GET bumps the lead-file counter
 * (packages.go:665-670).
 */
export async function openRpmPackageFile(
  d1: D1Database,
  bucket: R2Bucket,
  ownerId: number,
  group: string,
  name: string,
  version: string,
  architecture: string,
  method: "GET" | "HEAD" = "GET",
): Promise<RpmDownload | null> {
  const open = async (arch: string): Promise<{ download: RpmDownload; versionId: number } | null> => {
    const pv = await getVersionByNameAndVersion(d1, ownerId, "rpm", name, version);
    if (pv === null) return null;
    const pf = await getFileForVersionByName(d1, pv.id, `${name}-${version}.${arch}.rpm`, group);
    if (pf === null) return null;
    const blob = (await drizzle(d1).select().from(packageBlobs).where(eq(packageBlobs.id, pf.blobId)).get()) ?? null;
    if (blob === null) return null;
    const object = await bucket.get(packageBlobContentKey(blob.hashSha256));
    if (object === null) return null;
    return { download: { stream: object.body, size: object.size, filename: pf.name, created: pf.createdUnix }, versionId: pv.id };
  };
  const pick = async (arch: string): Promise<RpmDownload | null> => {
    const found = await open(arch);
    if (found === null) return null;
    if (method === "GET") await incrementDownloadCounter(d1, found.versionId);
    return found.download;
  };
  const exact = await pick(architecture);
  if (exact !== null || architecture === "noarch") return exact;
  return pick("noarch");
}

/**
 * DeletePackageFile (rpm.go:259-328): the exact-architecture file (no
 * fallback), the version-if-unreferenced fold, the rebuild rider. Answers
 * `false` for the 404 arm.
 */
export async function deleteRpmPackageFile(d1: D1Database, bucket: R2Bucket, ownerId: number, group: string, name: string, version: string, architecture: string, now?: Date): Promise<boolean> {
  const pv = await getVersionByNameAndVersion(d1, ownerId, "rpm", name, version);
  if (pv === null) return false;
  const pf = await getFileForVersionByName(d1, pv.id, `${name}-${version}.${architecture}.rpm`, group);
  if (pf === null) return false;
  await deletePackageFile(d1, pf.id);
  if (!(await hasVersionFileReferences(d1, pv.id))) {
    await deletePackageVersionAndReferences(d1, pv.id);
  }
  await buildRpmRepositoryFiles(d1, bucket, ownerId, group, now);
  return true;
}

/** The errata merge (rpm.go:368-451): merge by ID, collections by `short`,
 *  packages dedupe on name+version+release+arch, scalars + references
 *  overwritten, `updated` stamped with the render of Go's
 *  "2006-01-02 15:04:05". The JSON-decoded array keeps upstream's nil-skips
 *  (null entries and null pkglist members are dropped like upstream's
 *  sanitize loops). */
export function mergeErrataUpdates(vm: RpmVersionMetadata, updates: unknown[], now: Date): RpmUpdate[] {
  const stamp = now.toISOString().slice(0, 19).replace("T", " ");
  const merged: RpmUpdate[] = [...(vm.updates ?? [])];
  for (const raw of updates) {
    if (raw === null || typeof raw !== "object") continue;
    const incoming = raw as RpmUpdate;
    const clean: RpmUpdate = {
      ...incoming,
      references: (incoming.references ?? []).filter((reference) => reference !== null),
      pkg_list: (incoming.pkg_list ?? [])
        .filter((collection) => collection !== null)
        .map((collection) => ({
          short: collection.short,
          packages: (collection.packages ?? []).filter((pkg) => pkg !== null),
        })),
    };
    const existing = merged.find((candidate) => candidate.id === clean.id);
    if (existing === undefined) {
      merged.push({
        ...clean,
        issued: clean.issued ?? { date: stamp },
        updated: clean.updated ?? { date: stamp },
      });
      continue;
    }
    for (const collection of clean.pkg_list) {
      const target = (existing.pkg_list ??= []).find((candidate) => candidate.short === collection.short);
      if (target === undefined) {
        existing.pkg_list.push({ short: collection.short, packages: [...collection.packages] });
        continue;
      }
      for (const pkg of collection.packages) {
        const duplicate = (target.packages ?? []).some(
          (candidate) =>
            candidate.name === pkg.name && candidate.version === pkg.version && candidate.release === pkg.release && candidate.arch === pkg.arch,
        );
        if (!duplicate) target.packages.push(pkg);
      }
    }
    existing.from = clean.from;
    existing.status = clean.status;
    existing.type = clean.type;
    existing.version = clean.version;
    existing.title = clean.title;
    existing.severity = clean.severity;
    existing.description = clean.description;
    existing.references = clean.references;
    existing.updated = { date: stamp };
  }
  return merged;
}

/**
 * UploadErrata (rpm.go:331-471): merge the posted updates into the version's
 * metadata JSON, rebuild the group, answer 200. The 404 body is upstream's
 * ErrPackageNotExist text.
 */
export async function uploadRpmErrata(d1: D1Database, bucket: R2Bucket, ownerId: number, group: string, name: string, version: string, updates: unknown[], now?: Date): Promise<void> {
  const at = now ?? new Date();
  const pv = await getVersionByNameAndVersion(d1, ownerId, "rpm", name, version);
  if (pv === null) throw new RpmPackageNotExistError();
  const vm: RpmVersionMetadata = pv.metadataJson ? (JSON.parse(pv.metadataJson) as RpmVersionMetadata) : {};
  vm.updates = mergeErrataUpdates(vm, updates, at);
  await writeVersionMetadata(d1, pv.id, JSON.stringify(vm));
  await buildRpmRepositoryFiles(d1, bucket, ownerId, group, at);
}

// ---------------------------------------------------------------------------
// The route grammar (api.go:424-435): the group spans segments upstream
// (`<group:*>` — chi's PathGroup), so the wildcard walk tail-anchors every
// arm and the group is the remaining segments joined with "/". Exported for
// the route suite's grammar pins.
// ---------------------------------------------------------------------------

export type RpmArm = "key" | "repo-config" | "repodata" | "upload" | "errata" | "download" | "delete";

export interface RpmTarget {
  arm: RpmArm;
  /** The group path segments — may span "/" (upstream `<group:*>`). */
  group: string;
  filename?: string;
  name?: string;
  version?: string;
  architecture?: string;
}

/**
 * The decoded remainder after `/{username}/rpm/`. Match order mirrors the
 * upstream registration order (rpm.go's MatchPath list): repository.key,
 * then the `.repo` configs, then the repodata tails, the upload, the errata
 * POST, the two download shapes (5-segment tail first), and the DELETE.
 * Every segment must be non-empty (chi's paths cannot match empty
 * segments).
 */
export function parseRpmTarget(decoded: string, method: string): RpmTarget | null {
  const parts = decoded.split("/");
  if (parts.some((part) => part === "")) return null;
  const getish = method === "GET" || method === "HEAD";
  if (parts.length === 1 && parts[0] === "repository.key" && getish) {
    return { arm: "key", group: "" };
  }
  if (getish && (parts[parts.length - 1] ?? "").endsWith(".repo")) {
    const last = parts[parts.length - 1] ?? "";
    const group = [...parts.slice(0, -1), last.slice(0, -".repo".length)].join("/");
    if (group === "") return null;
    return { arm: "repo-config", group };
  }
  if (parts.length >= 3 && parts[parts.length - 2] === "repodata" && getish) {
    return { arm: "repodata", group: parts.slice(0, -2).join("/"), filename: parts[parts.length - 1] };
  }
  if (parts.length >= 2 && parts[parts.length - 1] === "upload" && method === "PUT") {
    return { arm: "upload", group: parts.slice(0, -1).join("/") };
  }
  if (parts.length >= 5 && parts[parts.length - 4] === "package" && method === "POST" && parts[parts.length - 1] === "errata") {
    return { arm: "errata", group: parts.slice(0, -4).join("/"), name: parts[parts.length - 3], version: parts[parts.length - 2] };
  }
  if (parts.length >= 6 && parts[parts.length - 5] === "package" && getish) {
    return {
      arm: "download",
      group: parts.slice(0, -5).join("/"),
      name: parts[parts.length - 4],
      version: parts[parts.length - 3],
      architecture: parts[parts.length - 2],
      filename: parts[parts.length - 1],
    };
  }
  if (parts.length >= 5 && parts[parts.length - 4] === "package") {
    if (!getish && method !== "DELETE") return null;
    return {
      arm: getish ? "download" : "delete",
      group: parts.slice(0, -4).join("/"),
      name: parts[parts.length - 3],
      version: parts[parts.length - 2],
      architecture: parts[parts.length - 1],
    };
  }
  return null;
}

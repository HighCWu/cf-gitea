/**
 * The Arch (pacman) registry family (SPEC-0016 §7 M7) — upstream at the pin
 * fc4936884584: routers/api/packages/arch/arch.go (306 ln) +
 * services/packages/arch/repository.go (401 ln) + vercmp.go (105 ln) +
 * models/packages/arch/search.go + modules/packages/arch/metadata.go (269 ln).
 * The third M7 family over the landed distro-common substrate (debian.ts +
 * alpine.ts are the siblings; the stored-index posture is the family's
 * as-built answer in specs/0016-packages.md §8 M7).
 *
 * ## The index-builder posture (repository.go)
 *
 * Indices are STORED, not rendered per request — every upload/delete ends
 * with `BuildSpecificRepositoryFiles` (arch.go:160/299 → repository.go:149-171)
 * and the GET arm is a plain file lookup (arch.go:168-252): every
 * `{repository}.db`/`.db.tar.gz`/`.files`/`.files.tar.gz` spelling (plus the
 * repository-generic `index.db`, `packages.db`, … spellings pacman clients
 * emit — the upstream integration test's six-name sweep) normalizes to the
 * ONE stored `packages.db` file of the internal `_arch` + `_repository`
 * version under composite key `{repository}|{architecture}`
 * (arch.go:186-197 — upstream's normalization of the pacman repo-add
 * ".db → .db.tar.gz symlink dance"; there is no literal symlink in the
 * registry, the alias spellings ARE the dance). An `any` upload re-rolls
 * EVERY architecture's index of that repository (repository.go:155-163),
 * and every real-architecture index merges the any-arch files in
 * (repository.go:194-201).
 *
 * ## The .db format (repository.go:237-321)
 *
 * ONE gzip member containing a ustar archive of per-package directories:
 * `{name}-{version}/desc` + `{name}-{version}/files` (the pair written
 * files-first, repository.go:282-287), each a `%KEY%\nvalue\n\n` field
 * document (writeFields, empty values skipped, Mode os.ModePerm = 0o777).
 * desc carries FILENAME/MD5SUM/SHA256SUM/PGPSIG/CSIZE/ISIZE/NAME/BASE/ARCH/
 * VERSION/DESC/URL/LICENSE/GROUPS/BUILDDATE/PACKAGER/PROVIDES/REPLACES/
 * CONFLICTS/DEPENDS/OPTDEPENDS/MAKEDEPENDS/CHECKDEPENDS in that order
 * (repository.go:353-379, the be_sync.c layout); files carries FILES (the
 * package's tar member list, newline-joined — joinFields DROPS entries
 * containing \n or \r, the pacman line-forgery gate, repository.go:339-344).
 * The archive is signed with the owner's OpenPGP key (SignData, the raw
 * detached packet) and the base64 signature is stored as the index file's
 * `arch.signature` property — the `{filename}.sig` serving arm
 * (arch.go:222-239) decodes and serves it. Each desc's PGPSIG is the
 * package file's own stored signature property, verbatim base64.
 *
 * ## vercmp (vercmp.go — the version-compare port)
 *
 * `archCompareVersions` is the pacman EVR comparison (vercmp.go:88-105 over
 * libalpm version.c): epoch (`n:`), dot-split version segments, release
 * (`-r`); segments compare numeric-when-both-numeric, numeric-beats-alpha,
 * else byte-wise. Its registry consumer at the pin is the index build's
 * highest-version fold (repository.go:225-235 — a package's older versions
 * must not "downgrade" the index entry; the pacman downgrade-hazard note is
 * carried in the upstream comment). vercmp_test.go's own table (the
 * man-vercmp.8 chains + the epoch/release arms) is pinned in the suite.
 *
 * ## Documented reductions
 *
 *  - RSA-2048 + `arch.key.created` (upstream 4096 via openpgp NewEntity —
 *    the Workers-cost divergence; the created row pins the v4 key-packet
 *    creation time exactly like `debian.key.created`, because upstream
 *    freezes it inside the serialized entity while ours stores a raw PEM).
 *  - .pkg.tar.zst / .pkg.tar.xz uploads answer 400 "unsupported package
 *    container format" (upstream's own sentinel) — the substrate has no
 *    zstd/xz decoder (workerd ships gzip only); .pkg.tar.gz parses fully.
 *    Upstream decodes all three (metadata.go:104-132).
 *  - The upload is capped at 64 MiB (PackageBlobTooLargeError → 413): the
 *    SignData arm holds the whole document for the RFC 4880 hash framing and
 *    WebCrypto cannot stream it, and the parse materializes the walked
 *    members' payloads (workerd's streaming decoder withholds output on
 *    trailing input, so the multistream concatenation rides distro-common's
 *    exact-length windows); upstream signs from a disk-backed hashed buffer
 *    and streams the tar. Real-world Arch packages are
 *    kilobytes-to-tens-of-MB.
 *  - desc omits %MD5SUM% (the blobs.ts three-digest posture never computes
 *    MD5 — the empty value is skipped by writeFields; the debian precedent).
 *    Upstream always writes it (blob.HashMD5).
 *  - The index member order is package lower_name/version ascending —
 *    upstream folds a Go map (random order); ours is pinned (the alpine
 *    paragraph-order precedent).
 *  - The two ErrNotExist-bearing 404 bodies upstream can produce on the
 *    serving arm ("resource does not exist", arch.go:241-249) are
 *    unreachable here — the file↔blob join is INNER, so a found row always
 *    opens; ours answers the nil-object arms' EMPTY body (arch.go:207/218)
 *    uniformly on the GET family, and keeps the "resource does not exist"
 *    body on the DELETE version-miss arm where upstream's error IS the
 *    not-exist sentinel (arch.go:268-275).
 */

import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageBlobs, packageFiles, packageProperties, packages, packageVersions } from "../../db/schema";
import {
  asciiBytes,
  base64ToBytes,
  bytesToBase64,
  buildTar,
  deleteRepositoryFile,
  getOrCreateInternalPackageVersion,
  getOrCreateOwnerKeyPair,
  gzipCompress,
  loadOpenPgpKey,
  openPgpSignaturePacket,
  openPgpTransferablePublicKey,
  packageBlobContentKey,
  PropertyType,
  storeRepositoryFile,
  walkGzipMembers,
} from "./distro-common";
import { copySpoolToContentKey, getOrInsertBlob, MAX_PACKAGE_BLOB_BYTES, spoolAndHash } from "./blobs";
import {
  checkSizeQuotaExceeded,
  countVersions,
  deletePackageFile,
  deletePackageVersionAndReferences,
  getOrInsertPackage,
  getOrInsertVersion,
  hasVersionFileReferences,
  QuotaTotalCountError,
  tryInsertFile,
  UNLIMITED_QUOTA,
  type PackageBlobRow,
  type PackageFileRow,
  type PackageOwnerRow,
  type PackagesQuotaConfig,
  type PackageVersionRow,
} from "./model";
import { DuplicatePackageFileError } from "./generic";
import { writeVersionMetadata } from "./protocol-common";

// ---------------------------------------------------------------------------
// Upstream constants (modules/packages/arch/metadata.go:24-39 +
// services/packages/arch/repository.go:36-38)
// ---------------------------------------------------------------------------

export const ARCH_PROPERTY_REPOSITORY = "arch.repository";
export const ARCH_PROPERTY_ARCHITECTURE = "arch.architecture";
export const ARCH_PROPERTY_SIGNATURE = "arch.signature";
export const ARCH_PROPERTY_METADATA = "arch.metadata";

const ARCH_SETTING_KEY_PRIVATE = "arch.key.private";
const ARCH_SETTING_KEY_PUBLIC = "arch.key.public";
/** Our companion row for the OpenPGP key-packet creation time (the debian
 *  precedent — upstream freezes it inside the serialized entity). */
const ARCH_SETTING_KEY_CREATED = "arch.key.created";

export const ARCH_REPOSITORY_PACKAGE = "_arch";
export const ARCH_REPOSITORY_VERSION = "_repository";

export const ARCH_ANY = "any";

/** IndexArchiveFilename (repository.go:36-38). */
export const ARCH_INDEX_FILENAME = "packages.db";

/** metadata.go:38 — the .PKGINFO reader cap. */
export const MAX_PKGINFO_SIZE = 1024 * 1024;
/** metadata.go:55-56 — the accumulated file-list caps. */
export const MAX_FILE_ENTRIES = 100000;
export const MAX_FILE_NAME_BYTES = 16 * 1024 * 1024;
/** The module-header reduction: the parse+sign window (upstream caps nothing). */
export const MAX_ARCH_UPLOAD_BYTES = 64 * 1024 * 1024;

/** metadata.go:49-51 — Go \A…\z → JS ^…$ (the debian patterns' posture: the
 *  anchors are equivalent on the single-line values a PKGINFO reader sees). */
const NAME_PATTERN = /^[a-zA-Z0-9@._+-]+$/;
const VERSION_PATTERN = /^(?:\d:)?[\w.+~]+(?:-[-\w.+~]+)?$/;

// ---------------------------------------------------------------------------
// vercmp — the verbatim port (vercmp.go:14-105)
// ---------------------------------------------------------------------------

export interface ArchEVR {
  epoch: string;
  version: string;
  release: string;
}

/** parseEVR (vercmp.go:14-30): `epoch:version-release` with the defaults
 *  epoch=0 / release=1 when the separators are absent. */
export function parseArchEVR(evr: string): ArchEVR {
  let epoch = "0";
  let rest = evr;
  const colon = rest.indexOf(":");
  if (colon !== -1) {
    epoch = rest.slice(0, colon);
    rest = rest.slice(colon + 1);
  }
  let version = rest;
  let release = "1";
  const dash = rest.indexOf("-");
  if (dash !== -1) {
    version = rest.slice(0, dash);
    release = rest.slice(dash + 1);
  }
  return { epoch, version, release };
}

/** isNumeric (vercmp.go:79-86) — the empty string IS numeric (the loop never
 *  runs), faithfully. */
function isNumericSegment(s: string): boolean {
  return /^[0-9]*$/.test(s);
}

/** compare (vercmp.go:48-77): both numeric → integer compare (Go's Atoi
 *  ignores the overflow error, yielding 0 — mirrored with the safe-integer
 *  guard); numeric beats alpha; else byte-wise compare. */
function compareSegment(a: string, b: string): number {
  if (a === b) return 0;
  const aNumeric = isNumericSegment(a);
  const bNumeric = isNumericSegment(b);
  if (aNumeric && bNumeric) {
    const parse = (s: string): number => {
      const value = Number.parseInt(s, 10);
      return Number.isSafeInteger(value) ? value : 0; // Go's ignored-Atoi-error arm
    };
    const aInt = parse(a);
    const bInt = parse(b);
    if (aInt < bInt) return -1;
    if (aInt > bInt) return 1;
    return 0;
  }
  if (aNumeric) return 1;
  if (bNumeric) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** compareSegments (vercmp.go:32-46): pairwise, then the shorter prefix
 *  loses (equal lengths → 0; the FIRST list shorter → -1). */
function compareSegmentLists(a: string[], b: string[]): number {
  const l = Math.min(a.length, b.length);
  for (let i = 0; i < l; i++) {
    const r = compareSegment(a[i] ?? "", b[i] ?? "");
    if (r !== 0) return r;
  }
  if (a.length === b.length) return 0;
  if (l === a.length) return -1;
  return 1;
}

/** compareVersions (vercmp.go:88-105): epoch, then dot-split version, then
 *  release. Answers -1 | 0 | 1. */
export function archCompareVersions(a: string, b: string): number {
  if (a === b) return 0;
  const evrA = parseArchEVR(a);
  const evrB = parseArchEVR(b);
  const epoch = compareSegmentLists([evrA.epoch], [evrB.epoch]);
  if (epoch !== 0) return epoch;
  const version = compareSegmentLists(evrA.version.split("."), evrB.version.split("."));
  if (version !== 0) return version;
  return compareSegmentLists([evrA.release], [evrB.release]);
}

// ---------------------------------------------------------------------------
// Metadata shapes (metadata.go:67-90 — the Go JSON tag order/omitempty)
// ---------------------------------------------------------------------------

export interface ArchVersionMetadata {
  description?: string;
  project_url?: string;
  licenses?: string[];
}

export interface ArchFileMetadata {
  architecture: string;
  base?: string;
  installed_size?: number;
  build_date?: number;
  packager?: string;
  groups?: string[];
  provides?: string[];
  replaces?: string[];
  depends?: string[];
  opt_depends?: string[];
  make_depends?: string[];
  check_depends?: string[];
  conflicts?: string[];
  xdata?: string[];
  backup?: string[];
  files?: string[];
}

export interface ArchPackageInfo {
  name: string;
  version: string;
  versionMetadata: ArchVersionMetadata;
  fileMetadata: ArchFileMetadata;
  fileCompressionExtension: string;
}

// ---------------------------------------------------------------------------
// Errors — upstream's sentinels (metadata.go:42-46, filelist.go:18,
// limited_reader.go:16) with their ProcessErrorForUser messages
// ---------------------------------------------------------------------------

export class ArchMissingPkginfoError extends Error {
  constructor() {
    super(".PKGINFO file is missing");
    this.name = "ArchMissingPkginfoError";
  }
}

export class ArchUnsupportedFormatError extends Error {
  constructor() {
    super("unsupported package container format");
    this.name = "ArchUnsupportedFormatError";
  }
}

export class ArchInvalidNameError extends Error {
  constructor() {
    super("package name is invalid");
    this.name = "ArchInvalidNameError";
  }
}

export class ArchInvalidVersionError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "ArchInvalidVersionError";
  }
}

export class ArchInvalidArchitectureError extends Error {
  constructor() {
    super("package architecture is invalid");
    this.name = "ArchInvalidArchitectureError";
  }
}

/** ErrContentTooLarge (limited_reader.go:16) — the >1 MiB .PKGINFO arm; the
 *  sentinel IS an InvalidArgument → the 400 family. */
export class ArchPkginfoTooLargeError extends Error {
  constructor() {
    super("content exceeds the size limit");
    this.name = "ArchPkginfoTooLargeError";
  }
}

/** filelist.go:18 — the BoundedFileList cap arm (400 via InvalidArgument). */
export class ArchTooManyFileEntriesError extends Error {
  constructor() {
    super("package contains too many file entries");
    this.name = "ArchTooManyFileEntriesError";
  }
}

// ---------------------------------------------------------------------------
// The .PKGINFO parse (metadata.go:180-269)
// ---------------------------------------------------------------------------

/** ParsePackageInfo (metadata.go:180-269) — the `key = value` line reader.
 *  builddate/size ParseInt failures throw PLAIN errors (upstream's
 *  strconv.NumError is not an InvalidArgument → the 500 family). */
export function parseArchPackageInfo(text: string): ArchPackageInfo {
  const info: ArchPackageInfo = {
    name: "",
    version: "",
    versionMetadata: {},
    fileMetadata: { architecture: "" },
    fileCompressionExtension: "",
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case "pkgname":
        info.name = value;
        break;
      case "pkgbase":
        info.fileMetadata.base = value;
        break;
      case "pkgver":
        info.version = value;
        break;
      case "pkgdesc":
        info.versionMetadata.description = value;
        break;
      case "url":
        info.versionMetadata.project_url = value;
        break;
      case "packager":
        info.fileMetadata.packager = value;
        break;
      case "arch":
        info.fileMetadata.architecture = value;
        break;
      case "license":
        (info.versionMetadata.licenses ??= []).push(value);
        break;
      case "provides":
        (info.fileMetadata.provides ??= []).push(value);
        break;
      case "depend":
        (info.fileMetadata.depends ??= []).push(value);
        break;
      case "replaces":
        (info.fileMetadata.replaces ??= []).push(value);
        break;
      case "optdepend":
        (info.fileMetadata.opt_depends ??= []).push(value);
        break;
      case "makedepend":
        (info.fileMetadata.make_depends ??= []).push(value);
        break;
      case "checkdepend":
        (info.fileMetadata.check_depends ??= []).push(value);
        break;
      case "conflict":
        (info.fileMetadata.conflicts ??= []).push(value);
        break;
      case "backup":
        (info.fileMetadata.backup ??= []).push(value);
        break;
      case "group":
        (info.fileMetadata.groups ??= []).push(value);
        break;
      case "builddate": {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(parsed)) throw new Error("invalid builddate");
        info.fileMetadata.build_date = parsed;
        break;
      }
      case "size": {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(parsed)) throw new Error("invalid size");
        info.fileMetadata.installed_size = parsed;
        break;
      }
      case "xdata":
        (info.fileMetadata.xdata ??= []).push(value);
        break;
    }
  }
  if (!NAME_PATTERN.test(info.name)) throw new ArchInvalidNameError();
  if (!VERSION_PATTERN.test(info.version)) throw new ArchInvalidVersionError();
  if (info.fileMetadata.architecture === "") throw new ArchInvalidArchitectureError();
  // validation.IsValidURL reduced (the protocol-common twin's posture).
  if (info.versionMetadata.project_url !== undefined) {
    const valid = ((): boolean => {
      try {
        const parsed = new URL(info.versionMetadata.project_url ?? "");
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    })();
    if (!valid) info.versionMetadata.project_url = "";
  }
  return info;
}

// ---------------------------------------------------------------------------
// The container parse (metadata.go:93-175) — the walked-members decompression
// (the platform's only decode path for the concatenated-multistream input)
// followed by an INCREMENTAL tar walk over the payload: only .PKGINFO's bytes
// and the member NAMES are retained (the data members are skipped
// in-flight) — upstream's tar.Next() posture. zst/xz are refused (the
// module-header reduction).
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a];
const GZ_MAGIC = [0x1f, 0x8b];

function magicMatches(header: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, index) => (header[index] ?? -1) === byte);
}

/** A buffered reader over a byte stream with ensure/take/skip. */
class TarByteReader {
  private buffer = new Uint8Array(8192);
  private start = 0;
  private filled = 0;
  private eof = false;

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private compact(): void {
    if (this.start > 0) {
      this.buffer.set(this.buffer.subarray(this.start, this.filled), 0);
      this.filled -= this.start;
      this.start = 0;
    }
  }

  private growTo(min: number): void {
    if (this.buffer.byteLength >= min) return;
    const size = Math.max(min, this.buffer.byteLength * 2);
    const grown = new Uint8Array(size);
    grown.set(this.buffer.subarray(this.start, this.filled), 0);
    this.buffer = grown;
    this.start = 0;
  }

  /** True when `n` bytes are readable from the cursor. */
  async ensure(n: number): Promise<boolean> {
    while (this.filled - this.start < n) {
      if (this.eof) return false;
      const read = await this.reader.read();
      if (read.done) {
        this.eof = true;
        return this.filled - this.start >= n;
      }
      this.compact();
      this.growTo(this.filled + read.value.byteLength);
      this.buffer.set(read.value, this.filled);
      this.filled += read.value.byteLength;
    }
    return true;
  }

  take(n: number): Uint8Array {
    const out = this.buffer.slice(this.start, this.start + n);
    this.start += n;
    return out;
  }

  async skip(n: number): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      const available = this.filled - this.start;
      if (available > 0) {
        const step = Math.min(available, remaining);
        this.start += step;
        remaining -= step;
        continue;
      }
      if (this.eof) return;
      const read = await this.reader.read();
      if (read.done) {
        this.eof = true;
        return;
      }
      remaining -= read.value.byteLength;
    }
  }
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function tarTextField(bytes: Uint8Array, start: number, length: number): string {
  let end = start;
  const stop = start + length;
  while (end < stop && (bytes[end] ?? 0) !== 0) end++;
  return new TextDecoder("latin1").decode(bytes.subarray(start, end));
}

function tarSizeField(bytes: Uint8Array, start: number): number {
  const text = tarTextField(bytes, start, 12).trim();
  if (text === "") return 0;
  const size = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new ArchUnsupportedFormatError();
  return size;
}

/** pax 'x' records: `"%d key=value\n"` lines; only `path` matters here. */
function paxPathOverride(data: Uint8Array): string | null {
  const text = new TextDecoder("latin1").decode(data);
  for (const line of text.split("\n")) {
    const space = line.indexOf(" ");
    if (space === -1) continue;
    const record = line.slice(space + 1);
    if (record.startsWith("path=")) return record.slice("path=".length);
  }
  return null;
}

export interface ArchPackageWalkResult {
  info: ArchPackageInfo;
  /** The collected member names (filelist.go's BoundedFileList product). */
  files: string[];
}

/**
 * ParsePackage (metadata.go:93-175) over the in-memory upload bytes. The
 * sniff (metadata.go:94-132) picks the codec; the payload is ONE logical
 * stream of the walked gzip members' payloads (upstream Go gzip.Reader's
 * default multistream). The member WALK is the platform's only decode path
 * here — workerd's streaming decoder withholds ALL output when the input
 * carries trailing bytes (the spike-streams record), so the concatenated
 * members are walked by distro-common's exact-length windows and the
 * payloads concatenated. The tar walk then stays incremental over the
 * payload (only .PKGINFO's bytes and member names are retained).
 * `.PKGINFO` parses (LAST occurrence wins — upstream overwrites `p`), every
 * non-dot-named member joins the bounded file list (newline-bearing names
 * skipped — the pacman index-forgery gate, metadata.go:158-160), and the
 * compression extension rides the sniff. Missing .PKGINFO at EOF → the 400
 * sentinel.
 */
export async function parseArchPackage(body: Uint8Array): Promise<ArchPackageWalkResult> {
  // The 10-byte compression sniff (metadata.go:94-132).
  if (body.byteLength < 10) throw new ArchUnsupportedFormatError();
  const header = body.subarray(0, 10);
  if (magicMatches(header, ZSTD_MAGIC) || magicMatches(header, XZ_MAGIC)) {
    throw new ArchUnsupportedFormatError(); // the module-header reduction
  }
  if (!magicMatches(header, GZ_MAGIC)) {
    throw new ArchUnsupportedFormatError();
  }
  const compressionType = "gz";
  // The multistream walk: every member's payload concatenated in order.
  const members = await walkGzipMembers(body);
  let total = 0;
  for (const member of members) total += member.payload.byteLength;
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const member of members) {
    payload.set(member.payload, offset);
    offset += member.payload.byteLength;
  }
  const tar = new TarByteReader(bytesToStream(payload).getReader());

  let info: ArchPackageInfo | null = null;
  const files: string[] = [];
  let nameBytes = 0;
  let pendingName: string | null = null;
  for (;;) {
    if (!(await tar.ensure(512))) break;
    const block = tar.take(512);
    if ((block[0] ?? 0) === 0) break; // the end block
    const size = tarSizeField(block, 124);
    const typeflag = block[156] ?? -1;
    const rawName = tarTextField(block, 0, 100);
    const prefix = tarTextField(block, 345, 155);
    const name = pendingName ?? (prefix !== "" ? `${prefix}/${rawName}` : rawName);
    pendingName = null;
    if (typeflag === 0x4c) {
      // GNU long name ('L'): the data IS the next member's name.
      if (!(await tar.ensure(size))) throw new ArchUnsupportedFormatError();
      pendingName = new TextDecoder("latin1").decode(tar.take(size)).replace(/\0+$/, "");
    } else if (typeflag === 0x78) {
      // pax extended header ('x'): the path record overrides the next name.
      if (!(await tar.ensure(size))) throw new ArchUnsupportedFormatError();
      pendingName = paxPathOverride(tar.take(size)) ?? pendingName;
    } else if (typeflag === 0x30 || typeflag === 0) {
      const base = name.slice(name.lastIndexOf("/") + 1);
      if (base === ".PKGINFO") {
        if (size > MAX_PKGINFO_SIZE) throw new ArchPkginfoTooLargeError();
        if (!(await tar.ensure(size))) throw new ArchUnsupportedFormatError();
        info = parseArchPackageInfo(new TextDecoder().decode(tar.take(size)));
      } else {
        if (!base.startsWith(".") && !/[\n\r]/.test(name)) {
          if (files.length >= MAX_FILE_ENTRIES || nameBytes + name.length > MAX_FILE_NAME_BYTES) {
            throw new ArchTooManyFileEntriesError();
          }
          files.push(name);
          nameBytes += name.length;
        }
        await tar.skip(size);
      }
    } else {
      await tar.skip(size);
    }
    await tar.skip((512 - (size % 512)) % 512);
  }
  if (info === null) throw new ArchMissingPkginfoError();
  return { info: { ...info, fileCompressionExtension: compressionType }, files };
}

// ---------------------------------------------------------------------------
// Upload (arch.go:43-166)
// ---------------------------------------------------------------------------

export interface UploadArchPackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: { id: number; isAdmin: boolean };
  repository: string;
  content: ReadableStream<Uint8Array>;
  declaredLength?: number;
  quota: PackagesQuotaConfig;
  now?: Date;
  spoolKey?: string;
}

export interface UploadArchPackageResult {
  file: { id: number; name: string };
  packageInfo: ArchPackageInfo;
}

/**
 * `UploadPackageFile` (arch.go:43-166) — the shared quota/duplicate posture
 * of the debian/alpine siblings, the repository/architecture/metadata/
 * signature file-property quadruple (arch.go:140-145), the SignData rider
 * over the raw upload bytes (arch.go:83-87 — the desc's PGPSIG source), and
 * the index rebuild with the any-arch propagation.
 */
export async function uploadArchPackage(input: UploadArchPackageInput): Promise<UploadArchPackageResult> {
  const repository = input.repository.trim(); // arch.go:44
  const now = input.now ?? new Date();
  if (!input.doer.isAdmin && input.quota.limitTotalOwnerCount > UNLIMITED_QUOTA) {
    const total = (await countVersions(input.d1, input.owner.id)) + 1;
    if (total > input.quota.limitTotalOwnerCount) {
      throw new QuotaTotalCountError();
    }
  }
  const spooled = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: Math.min(MAX_ARCH_UPLOAD_BYTES, MAX_PACKAGE_BLOB_BYTES),
    spoolKey: input.spoolKey,
  });
  try {
    const spoolObject = await input.bucket.get(spooled.spoolKey);
    if (spoolObject === null) throw new Error("package spool object vanished");
    // The SignData arm holds the whole document — the module-header cap.
    const content = new Uint8Array(await spoolObject.arrayBuffer());
    const walk = await parseArchPackage(content);
    const packageInfo = walk.info;
    // metadata.go:171 — the collected tar member names ride the file metadata.
    packageInfo.fileMetadata.files = walk.files;
    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "arch", spooled.size, input.quota);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "arch",
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

    const architecture = packageInfo.fileMetadata.architecture;
    const filename = `${packageInfo.name}-${packageInfo.version}-${architecture}.pkg.tar.${packageInfo.fileCompressionExtension}`;
    const compositeKey = `${repository}|${architecture}`;

    // The cross-compression duplicate search (arch.go:102-118): any file of
    // the same name-version-arch stem with the same repository+architecture
    // properties 409s before the creation attempt.
    const stem = `${packageInfo.name}-${packageInfo.version}-${architecture}.pkg.tar.`.toLowerCase();
    const dupRows = await drizzle(input.d1)
      .select({ file: packageFiles })
      .from(packageFiles)
      .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .where(
        and(
          eq(packages.type, "arch"),
          eq(packages.ownerId, input.owner.id),
          sql`${packageFiles.lowerName} like ${`${stem}%`}`,
          sql`(select count(*) from package_properties pp
               where pp.ref_type = ${PropertyType.File} and pp.ref_id = ${packageFiles.id}
                 and ((pp.name = ${ARCH_PROPERTY_REPOSITORY} and pp.value = ${repository})
                   or (pp.name = ${ARCH_PROPERTY_ARCHITECTURE} and pp.value = ${architecture}))) = 2`,
        ),
      )
      .all();
    const dupFile = dupRows[0]?.file;
    if (dupFile !== undefined) throw new DuplicatePackageFileError(dupFile);

    const signature = await signArchData(input.d1, input.owner.id, content, now);

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
    await drizzle(input.d1)
      .insert(packageProperties)
      .values([
        { refType: PropertyType.File, refId: fileResult.row.id, name: ARCH_PROPERTY_REPOSITORY, value: repository },
        { refType: PropertyType.File, refId: fileResult.row.id, name: ARCH_PROPERTY_ARCHITECTURE, value: architecture },
        { refType: PropertyType.File, refId: fileResult.row.id, name: ARCH_PROPERTY_METADATA, value: JSON.stringify(packageInfo.fileMetadata) },
        { refType: PropertyType.File, refId: fileResult.row.id, name: ARCH_PROPERTY_SIGNATURE, value: bytesToBase64(signature) },
      ])
      .run();

    await buildArchRepositoryFiles(input.d1, input.bucket, input.owner, repository, architecture, now);
    return { file: { id: fileResult.row.id, name: filename }, packageInfo };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The index builder (repository.go:109-401)
// ---------------------------------------------------------------------------

export interface ArchIndexFileRow {
  file: PackageFileRow;
  blob: PackageBlobRow;
  version: PackageVersionRow;
  packageName: string;
  fileMetadata: ArchFileMetadata;
  versionMetadata: ArchVersionMetadata;
  signature: string;
}

/** The property subselect helper (the alpine sibling's shape). */
function filePropertySubselect(name: string): SQL<string> {
  return sql<string>`(
    select pp.value from package_properties pp
    where pp.ref_type = ${PropertyType.File} and pp.ref_id = ${packageFiles.id}
      and pp.name = ${name} limit 1)`;
}

/**
 * `searchPackageFiles` (repository.go:173-187): `%.pkg.tar.%` files whose
 * repository+architecture file properties both match — upstream's
 * builder.Like{"package_file.lower_name", strings.ToLower(query)} (the
 * lowercased pattern, wildcards live) translated to the correlated-count
 * property filter the landed siblings use.
 */
async function searchArchFiles(
  d1: D1Database,
  ownerId: number,
  repository: string,
  architecture: string,
): Promise<ArchIndexFileRow[]> {
  const db = drizzle(d1);
  const rows = await db
    .select({
      file: packageFiles,
      blob: packageBlobs,
      version: packageVersions,
      packageName: packages.name,
      fileMetadataRaw: filePropertySubselect(ARCH_PROPERTY_METADATA),
      signature: filePropertySubselect(ARCH_PROPERTY_SIGNATURE),
    })
    .from(packageFiles)
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
    .where(
      and(
        eq(packages.type, "arch"),
        eq(packages.ownerId, ownerId),
        eq(packages.isInternal, false),
        eq(packageVersions.isInternal, false),
        sql`${packageFiles.lowerName} like '%.pkg.tar.%'`,
        sql`(select count(*) from package_properties pp
             where pp.ref_type = ${PropertyType.File} and pp.ref_id = ${packageFiles.id}
               and ((pp.name = ${ARCH_PROPERTY_REPOSITORY} and pp.value = ${repository})
                 or (pp.name = ${ARCH_PROPERTY_ARCHITECTURE} and pp.value = ${architecture}))) = 2`,
      ),
    )
    .orderBy(asc(packages.lowerName), asc(packageVersions.lowerVersion), asc(packageFiles.lowerName))
    .all();
  return rows.map(({ file, blob, version, packageName, fileMetadataRaw, signature }) => ({
    file,
    blob,
    version,
    packageName: packageName ?? "",
    fileMetadata: fileMetadataRaw ? (JSON.parse(fileMetadataRaw) as ArchFileMetadata) : { architecture: "" },
    versionMetadata: version.metadataJson ? (JSON.parse(version.metadataJson) as ArchVersionMetadata) : {},
    signature: signature ?? "",
  }));
}

/** GetArchitectures (models/packages/arch/search.go:25-36): the distinct
 *  architecture property values of the repository. */
async function listArchArchitectures(d1: D1Database, ownerId: number, repository: string): Promise<string[]> {
  const rows = await drizzle(d1)
    .select({ value: packageProperties.value })
    .from(packageProperties)
    .innerJoin(packageFiles, eq(packageFiles.id, packageProperties.refId))
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      and(
        eq(packageProperties.refType, PropertyType.File),
        eq(packageProperties.name, ARCH_PROPERTY_ARCHITECTURE),
        eq(packages.type, "arch"),
        eq(packages.ownerId, ownerId),
        eq(packages.isInternal, false),
        eq(packageVersions.isInternal, false),
        sql`exists (select 1 from package_properties pp where pp.ref_type = ${PropertyType.File}
              and pp.ref_id = ${packageFiles.id}
              and pp.name = ${ARCH_PROPERTY_REPOSITORY} and pp.value = ${repository})`,
      ),
    )
    .groupBy(packageProperties.value)
    .all();
  return rows.map((row) => row.value);
}

/** joinFields (repository.go:339-344) — entries carrying \n or \r are
 *  dropped (the pacman line-forgery gate), the rest newline-joined. */
export function joinArchFields(values: string[]): string {
  return values.filter((value) => !/[\n\r]/.test(value)).join("\n");
}

/** writeFields (repository.go:381-400) — `%KEY%\nvalue\n\n` per non-empty
 *  field, as a tar member shape. */
export function writeArchFields(filename: string, fields: [string, string][]): { name: string; data: Uint8Array } {
  let text = "";
  for (const [key, value] of fields) {
    if (value === "") continue;
    text += `%${key}%\n${value}\n\n`;
  }
  return { name: filename, data: asciiBytes(text) };
}

function compareArchIndexEntries(a: ArchIndexFileRow, b: ArchIndexFileRow): number {
  // The pinned member order (the module-header reduction): package
  // lower_name, then version, then file name — the fold guarantees one
  // entry per package id, so the first key already separates.
  if (a.version.packageId !== b.version.packageId) {
    if (a.packageName.toLowerCase() !== b.packageName.toLowerCase()) {
      return a.packageName.toLowerCase() < b.packageName.toLowerCase() ? -1 : 1;
    }
    return a.version.lowerVersion < b.version.lowerVersion ? -1 : 1;
  }
  return a.file.lowerName < b.file.lowerName ? -1 : 1;
}

/**
 * `buildPackagesIndex` (repository.go:189-322): the per-package desc/files
 * tar from the stored metadata, gzipped, signed, stored as `packages.db`
 * under `{repository}|{architecture}`. The any-arch files merge in for every
 * real architecture (repository.go:194-201); the version fold keeps the
 * HIGHEST version per package id (repository.go:225-235, the vercmp
 * consumer); the empty arm deletes the stored index (repository.go:203-213).
 */
async function buildArchPackagesIndex(
  d1: D1Database,
  bucket: R2Bucket,
  ownerId: number,
  repoVersion: { version: { id: number } },
  repository: string,
  architecture: string,
  now: Date,
): Promise<void> {
  const compositeKey = `${repository}|${architecture}`;
  let rows = await searchArchFiles(d1, ownerId, repository, architecture);
  if (architecture !== ARCH_ANY) {
    const anyRows = await searchArchFiles(d1, ownerId, repository, ARCH_ANY);
    rows = [...rows, ...anyRows];
  }
  if (rows.length === 0) {
    await deleteRepositoryFile(d1, repoVersion.version.id, ARCH_INDEX_FILENAME, compositeKey);
    return;
  }
  // The vercmp fold (repository.go:215-235): one file per package id, the
  // highest version surviving ("we shouldn't allow 'downgrading'").
  const byPackageId = new Map<number, ArchIndexFileRow>();
  for (const row of rows) {
    const current = byPackageId.get(row.version.packageId);
    if (current === undefined || archCompareVersions(current.version.version, row.version.version) === -1) {
      byPackageId.set(row.version.packageId, row);
    }
  }
  const entries = [...byPackageId.values()].sort(compareArchIndexEntries);

  const members: { name: string; mode: number; data: Uint8Array }[] = [];
  for (const opts of entries) {
    const fm = opts.fileMetadata;
    const vm = opts.versionMetadata;
    const dir = `${opts.packageName}-${opts.version.version}`;
    // writeFiles (repository.go:346-350) — the FILES member first.
    const filesMember = writeArchFields(`${dir}/files`, [["FILES", joinArchFields(fm.files ?? [])]]);
    members.push({ name: filesMember.name, mode: 0o777, data: filesMember.data });
    // writeDescription (repository.go:353-379) — the be_sync.c field order.
    const descMember = writeArchFields(`${dir}/desc`, [
      ["FILENAME", opts.file.name],
      ["MD5SUM", opts.blob.hashMd5 ?? ""],
      ["SHA256SUM", opts.blob.hashSha256],
      ["PGPSIG", opts.signature],
      ["CSIZE", String(opts.blob.size)],
      ["ISIZE", String(fm.installed_size ?? 0)],
      ["NAME", opts.packageName],
      ["BASE", fm.base ?? ""],
      ["ARCH", fm.architecture],
      ["VERSION", opts.version.version],
      ["DESC", vm.description ?? ""],
      ["URL", vm.project_url ?? ""],
      ["LICENSE", joinArchFields(vm.licenses ?? [])],
      ["GROUPS", joinArchFields(fm.groups ?? [])],
      ["BUILDDATE", String(fm.build_date ?? 0)],
      ["PACKAGER", fm.packager ?? ""],
      ["PROVIDES", joinArchFields(fm.provides ?? [])],
      ["REPLACES", joinArchFields(fm.replaces ?? [])],
      ["CONFLICTS", joinArchFields(fm.conflicts ?? [])],
      ["DEPENDS", joinArchFields(fm.depends ?? [])],
      ["OPTDEPENDS", joinArchFields(fm.opt_depends ?? [])],
      ["MAKEDEPENDS", joinArchFields(fm.make_depends ?? [])],
      ["CHECKDEPENDS", joinArchFields(fm.check_depends ?? [])],
    ]);
    members.push({ name: descMember.name, mode: 0o777, data: descMember.data });
  }
  const archive = await gzipCompress(buildTar(members, true));

  // SignData (repository.go:293-296) — the raw detached packet; the base64
  // arm is stored as the index file's signature property (:317).
  const signature = await signArchData(d1, ownerId, archive, now);
  await storeRepositoryFile(d1, bucket, {
    versionId: repoVersion.version.id,
    filename: ARCH_INDEX_FILENAME,
    compositeKey,
    content: archive,
    properties: {
      [ARCH_PROPERTY_REPOSITORY]: repository,
      [ARCH_PROPERTY_ARCHITECTURE]: architecture,
      [ARCH_PROPERTY_SIGNATURE]: bytesToBase64(signature),
    },
    now,
  });
}

/**
 * `BuildSpecificRepositoryFiles` (repository.go:149-171): the requested
 * architecture's index — plus EVERY existing architecture of the repository
 * when the upload was any (the propagation arm).
 */
export async function buildArchRepositoryFiles(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  repository: string,
  architecture: string,
  now?: Date,
): Promise<void> {
  const repoVersion = await getOrCreateInternalPackageVersion(d1, owner.id, "arch", ARCH_REPOSITORY_PACKAGE, ARCH_REPOSITORY_VERSION);
  const architectures = new Set<string>([architecture]);
  if (architecture === ARCH_ANY) {
    for (const existing of await listArchArchitectures(d1, owner.id, repository)) {
      architectures.add(existing);
    }
  }
  for (const arch of architectures) {
    await buildArchPackagesIndex(d1, bucket, owner.id, repoVersion, repository, arch, now ?? new Date());
  }
}

// ---------------------------------------------------------------------------
// The signing + key arms (repository.go:40-107)
// ---------------------------------------------------------------------------

/** The arch signing arms — upstream's setting keys + the created row. */
export async function getOrCreateArchKeyPair(
  d1: D1Database,
  ownerId: number,
): Promise<Awaited<ReturnType<typeof getOrCreateOwnerKeyPair>> & { creationTime?: number }> {
  return getOrCreateOwnerKeyPair(d1, ownerId, ARCH_SETTING_KEY_PRIVATE, ARCH_SETTING_KEY_PUBLIC, "SHA-256", ARCH_SETTING_KEY_CREATED);
}

/** `SignData` (repository.go:85-107): the RAW detached RSA-SHA256 OpenPGP
 *  signature packet over `data` (upstream DetachSign's binary-document
 *  output — no armor). */
export async function signArchData(d1: D1Database, ownerId: number, data: Uint8Array, now: Date): Promise<Uint8Array> {
  const keys = await getOrCreateArchKeyPair(d1, ownerId);
  const createdSeconds = keys.creationTime ?? Math.floor(now.getTime() / 1000);
  const key = await loadOpenPgpKey(keys.publicSpki, keys.privateKey, createdSeconds);
  return openPgpSignaturePacket(key, data, Math.floor(now.getTime() / 1000), 0x00);
}

/** `GetRepositoryKey` (arch.go:31-41): the armored transferable public key
 *  (application/pgp-keys). The userid mirrors upstream's
 *  NewEntity("", "Arch Registry", "", nil) — a comment-only userid renders
 *  as "(Arch Registry)". */
export async function buildArchRepositoryKey(d1: D1Database, ownerId: number): Promise<string> {
  const keys = await getOrCreateArchKeyPair(d1, ownerId);
  const createdSeconds = keys.creationTime ?? Math.floor(Date.now() / 1000);
  const key = await loadOpenPgpKey(keys.publicSpki, keys.privateKey, createdSeconds);
  return openPgpTransferablePublicKey(key, "(Arch Registry)", createdSeconds);
}

// ---------------------------------------------------------------------------
// Serving + delete (arch.go:168-305)
// ---------------------------------------------------------------------------

export interface ArchDownload {
  stream: ReadableStream;
  size: number;
  filename: string;
  created: Date;
}

/** The db/files index spellings that normalize to the stored `packages.db`
 *  (arch.go:186 — the pacman symlink-dance aliases). */
const INDEX_SUFFIXES = [".db.tar.gz", ".files.tar.gz", ".files", ".db"];

/**
 * `GetPackageOrRepositoryFile` (arch.go:168-252): `{filename}.sig` arms
 * decode the stored signature property and serve the bytes under the
 * ORIGINAL filename; the index spellings normalize to the internal
 * `_repository` version's `packages.db`; everything else is an exact
 * package-file search (upstream's lowercased LIKE — wildcards live). Zero
 * hits retry the composite key with the `any` architecture (arch.go:204-216);
 * anything but exactly one hit 404s with the EMPTY body (arch.go:217-220).
 */
export async function openArchRepositoryFile(
  d1: D1Database,
  bucket: R2Bucket,
  ownerId: number,
  repository: string,
  architecture: string,
  filenameOrig: string,
): Promise<ArchDownload | null> {
  let filename = filenameOrig;
  let isSignature = false;
  if (filename.endsWith(".sig")) {
    isSignature = true;
    filename = filename.slice(0, filename.length - ".sig".length);
  }

  let query = filename;
  let versionId: number | undefined = undefined;
  if (INDEX_SUFFIXES.some((suffix) => filename.endsWith(suffix))) {
    // arch.go:186-197 — normalize to the stored index file.
    query = ARCH_INDEX_FILENAME;
    const repoVersion = await getOrCreateInternalPackageVersion(d1, ownerId, "arch", ARCH_REPOSITORY_PACKAGE, ARCH_REPOSITORY_VERSION);
    versionId = repoVersion.version.id;
  }

  // arch.go:179-184's PackageFileSearchOptions — the index arm carries the
  // internal version id and NO is-internal filters (upstream's SearchFiles
  // has none; the internal rows must be findable here), the package arm
  // keeps the landed siblings' non-internal filters.
  const search = async (compositeKey: string) => {
    const filters = [
      ...(versionId !== undefined ? [eq(packageFiles.versionId, versionId)] : []),
      eq(packages.type, "arch"),
      eq(packages.ownerId, ownerId),
      ...(versionId === undefined ? [eq(packages.isInternal, false), eq(packageVersions.isInternal, false)] : []),
      sql`${packageFiles.lowerName} like ${query.toLowerCase()}`,
      eq(packageFiles.compositeKey, compositeKey),
    ];
    return drizzle(d1)
      .select({ file: packageFiles, blob: packageBlobs, version: packageVersions })
      .from(packageFiles)
      .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
      .where(and(...filters))
      .all();
  };

  let pfs = await search(`${repository}|${architecture}`);
  if (pfs.length === 0) {
    if (architecture === ARCH_ANY) return null;
    pfs = await search(`${repository}|${ARCH_ANY}`);
  }
  if (pfs.length !== 1) return null;
  const found = pfs[0];
  if (found === undefined) return null;

  if (isSignature) {
    const rows = await drizzle(d1)
      .select({ value: packageProperties.value })
      .from(packageProperties)
      .where(
        and(
          eq(packageProperties.refType, PropertyType.File),
          eq(packageProperties.refId, found.file.id),
          eq(packageProperties.name, ARCH_PROPERTY_SIGNATURE),
        ),
      )
      .all();
    const value = rows[0]?.value;
    if (value === undefined) return null;
    const data = base64ToBytes(value);
    return {
      stream: bytesToStream(data),
      size: data.byteLength,
      filename: filenameOrig,
      created: found.file.createdUnix,
    };
  }
  const object = await bucket.get(packageBlobContentKey(found.blob.hashSha256));
  if (object === null) return null;
  return { stream: object.body, size: object.size, filename: found.file.name, created: found.file.createdUnix };
}

export type DeleteArchPackageResult =
  | { ok: true }
  | { ok: false; missing: "version" | "file" };

/**
 * `DeletePackageVersion` (arch.go:254-305): the file by version + composite
 * key (EXACT architecture — no any fallback), the version-if-unreferenced
 * fold, the rebuild rider. The two 404 arms stay distinguished because their
 * upstream BODIES differ: the version miss carries the not-exist sentinel
 * ("resource does not exist", arch.go:268-275), the file-search miss is the
 * nil-object EMPTY body (arch.go:285-288).
 */
export async function deleteArchPackageVersion(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  repository: string,
  architecture: string,
  name: string,
  version: string,
  now?: Date,
): Promise<DeleteArchPackageResult> {
  const db = drizzle(d1);
  const pv = await db
    .select({ version: packageVersions })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      and(
        eq(packages.ownerId, owner.id),
        eq(packages.type, "arch"),
        eq(packages.lowerName, name.toLowerCase()),
        eq(packageVersions.lowerVersion, version.toLowerCase()),
      ),
    )
    .get();
  if (pv === undefined) return { ok: false, missing: "version" };
  const versionId = pv.version.id;

  const pfs = await db
    .select({ file: packageFiles })
    .from(packageFiles)
    .where(and(eq(packageFiles.versionId, versionId), eq(packageFiles.compositeKey, `${repository}|${architecture}`)))
    .all();
  if (pfs.length !== 1) return { ok: false, missing: "file" };
  const fileRow = pfs[0]?.file;
  if (fileRow === undefined) return { ok: false, missing: "file" };

  await deletePackageFile(d1, fileRow.id);
  const stillReferenced = await hasVersionFileReferences(d1, fileRow.versionId);
  if (!stillReferenced) {
    await deletePackageVersionAndReferences(d1, fileRow.versionId);
  }
  await buildArchRepositoryFiles(d1, bucket, owner, repository, architecture, now);
  return { ok: true };
}

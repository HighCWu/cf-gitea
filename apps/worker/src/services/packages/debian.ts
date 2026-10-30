/**
 * The Debian registry family (SPEC-0016 §7 M7) — upstream at the pin
 * fc4936884584: routers/api/packages/debian/debian.go (306 ln) +
 * services/packages/debian/repository.go (397 ln) + modules/packages/debian/
 * metadata.go (ParsePackage/ParseControlFile/GlobalVars).
 *
 * ## The index-builder posture (the M7 family's generation answer)
 *
 * Upstream does NOT render indices per request: every upload/delete handler
 * ends with `BuildSpecificRepositoryFiles` (debian.go:197/300), which
 * REGENERATES the affected indices and STORES them as files of an internal
 * package version (`GetOrCreateRepositoryVersion` → the `_debian` +
 * `_repository` internal rows, repository.go:34-38) — serving is then a plain
 * file lookup (GetRepositoryFile, debian.go:46-76). This module mirrors that:
 * indices are built bytes stored through distro-common's storeRepositoryFile
 * (the OverwriteExisting internal-file arm), and the GET arms open stored
 * files. (Contrast helm — upstream's only per-request render.)
 *
 * ## Documented reductions (each disclosed in SPEC-0016's as-built)
 *
 *  - `Packages.xz` is NOT generated: the substrate has no xz codec (Go's
 *    ulikulex/xz has no Workers equivalent; the hand-rolled posture forbids a
 *    dependency). apt consumes `Packages.gz` — the mandatory baseline
 *    compression — and Release/by-hash list only the generated files.
 *  - control archives compressed as .xz/.zst answer 400 "unsupported
 *    compression algorithm" (upstream's own default-arm error; Workers has no
 *    decoders). .gz and uncompressed control.tar parse (dpkg-deb's default).
 *  - MD5 is unavailable on Workers' WebCrypto (blobs.ts's three-digest
 *    posture), so the Packages paragraphs omit the `MD5sum:` line and Release
 *    omits the `MD5Sum:` section (apt verifies SHA256; SHA1/SHA512 also
 *    carried). A `by-hash/md5sum/...` request answers 404 (never stored).
 *  - Release's `Date:` renders JS toUTCString() — the same RFC 1123 GMT
 *    spelling as Go's time.RFC1123 in UTC.
 *  - Origin/Label: upstream renders setting.AppName; this deployment's
 *    instance-name posture is the literal "Gitea" (the wiki.ts commit-identity
 *    precedent).
 *
 * ## Signing
 *
 * Per-owner RSA keypair in user_settings_kv (upstream's `user_setting` home,
 * keypair.go:18-43) under upstream's exact setting keys
 * (`debian.key.private`/`debian.key.public` + a third `debian.key.created`
 * row pinning the OpenPGP key-packet creation time — the packet bytes must be
 * STABLE or the key id/fingerprint would drift between requests); the
 * OpenPGP v4 RSA-SHA256 signatures (InRelease clearsign + Release.gpg armored
 * detached) ride distro-common's signer — gpgv-verified against the real gpg
 * (the M7 live battery).
 */

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageBlobs, packageFiles, packageProperties, packageVersions, packages } from "../../db/schema";
import {
  asciiBytes,
  getOrCreateInternalPackageVersion,
  getOrCreateOwnerKeyPair,
  gzipCompress,
  loadOpenPgpKey,
  openPgpArmoredDetachedSign,
  openPgpClearsign,
  openPgpTransferablePublicKey,
  packageBlobContentKey,
  PropertyType,
  readTarMembers,
  storeRepositoryFile,
  deleteRepositoryFile,
  walkGzipMembers,
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
  getVersionByNameAndVersion,
  getOrInsertPackage,
  getOrInsertVersion,
  hasVersionFileReferences,
  incrementDownloadCounter,
  QuotaTotalCountError,
  tryInsertFile,
  UNLIMITED_QUOTA,
  type PackagesQuotaConfig,
  type PackageOwnerRow,
} from "./model";
import { DuplicatePackageFileError } from "./generic";
import { writeVersionMetadata } from "./protocol-common";

// ---------------------------------------------------------------------------
// Upstream constants (modules/packages/debian/metadata.go:24-38 + :57-68)
// ---------------------------------------------------------------------------

export const DEBIAN_PROPERTY_DISTRIBUTION = "debian.distribution";
export const DEBIAN_PROPERTY_COMPONENT = "debian.component";
export const DEBIAN_PROPERTY_ARCHITECTURE = "debian.architecture";
export const DEBIAN_PROPERTY_CONTROL = "debian.control";
export const DEBIAN_PROPERTY_INCLUDE_IN_RELEASE = "debian.repository.include_in_release";

const DEBIAN_SETTING_KEY_PRIVATE = "debian.key.private";
const DEBIAN_SETTING_KEY_PUBLIC = "debian.key.public";
const DEBIAN_SETTING_KEY_CREATED = "debian.key.created";

export const DEBIAN_REPOSITORY_PACKAGE = "_debian";
export const DEBIAN_REPOSITORY_VERSION = "_repository";

const CONTROL_TAR = "control.tar";
/** The decompression bomb gate (metadata.go:139-141). */
const MAX_CONTROL_TAR_SIZE = 32 * 1024 * 1024;

/** The GlobalVars patterns (metadata.go:57-68) — Go regexp \A…\z → JS ^…$
 *  (the anchors are equivalent on single-line inputs). */
const NAME_PATTERN = /^[a-z0-9][a-z0-9+-.]+$/;
const VERSION_PATTERN = /^(?:(0|[1-9][0-9]*):)?[a-zA-Z0-9.+~]+(?:-[a-zA-Z0-9.+-~]+)?$/;
const SYMBOL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.~+_-]*$/;

export function isValidDebianDistributionOrComponent(value: string): boolean {
  return SYMBOL_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Errors — upstream's message strings (metadata.go:52-56)
// ---------------------------------------------------------------------------

export class DebianMissingControlError extends Error {
  constructor() {
    super("control file is missing");
    this.name = "DebianMissingControlError";
  }
}

export class DebianUnsupportedCompressionError extends Error {
  constructor() {
    super("unsupported compression algorithm");
    this.name = "DebianUnsupportedCompressionError";
  }
}

export class DebianInvalidNameError extends Error {
  constructor() {
    super("package name is invalid");
    this.name = "DebianInvalidNameError";
  }
}

export class DebianInvalidVersionError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "DebianInvalidVersionError";
  }
}

export class DebianInvalidArchitectureError extends Error {
  constructor() {
    super("package architecture is invalid");
    this.name = "DebianInvalidArchitectureError";
  }
}

export class DebianInvalidDistOrComponentError extends Error {
  constructor() {
    super("invalid distribution or component");
    this.name = "DebianInvalidDistOrComponentError";
  }
}

// ---------------------------------------------------------------------------
// The .deb parse (metadata.go:92-163 + ParseControlFile :166-265)
// ---------------------------------------------------------------------------

export interface DebianPackageInfo {
  name: string;
  version: string;
  architecture: string;
  /** The verbatim control stanza (metadata.go:194's PropertyControl value). */
  control: string;
  metadata: DebianMetadata;
}

export interface DebianMetadata {
  maintainer?: string;
  project_url?: string;
  description?: string;
  dependencies?: string[];
}

/** The Maintainer display-name arm (metadata.go:221-227): "Name <addr>"
 *  renders the name, anything else the raw value. */
function parseDebianMaintainerName(value: string): string {
  const match = /^(.*?)\s*<[^>]*>\s*$/.exec(value);
  const name = match?.[1]?.trim() ?? "";
  return name !== "" ? name : value;
}

/** validation.IsValidURL reduced (the protocol-common twin). */
function isValidDebianHomepage(value: string): boolean {
  if (value === "") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * ParseControlFile (metadata.go:166-265) — the single-stanza control reader:
 * blank line terminates the stanza (the stanza-smuggling gate), folded
 * continuation lines ride the previous key (never re-split on ":"), the four
 * validations run at the end.
 */
export function parseDebianControlFile(text: string): DebianPackageInfo {
  const info: DebianPackageInfo = {
    name: "",
    version: "",
    architecture: "",
    control: "",
    metadata: {},
  };
  let key = "";
  let depends = "";
  let description = "";
  const controlLines: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed === "") {
      // Exactly one stanza: stop at the blank line that terminates it
      // (metadata.go:181-189 — a crafted stanza cannot smuggle additional
      // ones into the generated Packages index).
      if (controlLines.length === 0) continue;
      break;
    }
    controlLines.push(line);
    if (line[0] === " " || line[0] === "\t") {
      if (key === "Description") description += line;
      else if (key === "Depends") depends += trimmed;
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    key = trimmed.slice(0, colon);
    const value = trimmed.slice(colon + 1).trim();
    switch (key) {
      case "Package":
        info.name = value;
        break;
      case "Version":
        info.version = value;
        break;
      case "Architecture":
        info.architecture = value;
        break;
      case "Maintainer":
        info.metadata.maintainer = parseDebianMaintainerName(value);
        break;
      case "Description":
        description = value;
        break;
      case "Depends":
        depends += value;
        break;
      case "Homepage":
        if (isValidDebianHomepage(value)) info.metadata.project_url = value;
        break;
    }
  }
  if (!NAME_PATTERN.test(info.name)) throw new DebianInvalidNameError();
  if (!VERSION_PATTERN.test(info.version)) throw new DebianInvalidVersionError();
  if (info.architecture === "") throw new DebianInvalidArchitectureError();
  info.metadata.description = description;
  info.metadata.dependencies = depends
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" || depends.trim() !== "");
  info.control = controlLines.join("\n").trim();
  return info;
}

// ---------------------------------------------------------------------------
// The streaming ar walk over the spooled upload (ParsePackage's in-memory
// reader reduced to the members the control needs — data.tar is never read)
// ---------------------------------------------------------------------------

/** A bounded exact-read stream reader (helm.ts's ByteReader shape, self-owned). */
class StreamReader {
  private buffer = new Uint8Array(64 * 1024);
  private start = 0;
  private end = 0;
  private done = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private grow(need: number): void {
    const grown = new Uint8Array(1 << Math.ceil(Math.log2(Math.max(need, 1024))));
    grown.set(this.buffer.subarray(this.start, this.end), 0);
    this.end -= this.start;
    this.start = 0;
    this.buffer = grown;
  }

  async ensure(n: number): Promise<boolean> {
    if (this.end - this.start >= n) return true;
    if (this.done) return this.end - this.start >= n;
    if (n > this.buffer.byteLength) this.grow(n);
    this.buffer.copyWithin(0, this.start, this.end);
    this.end -= this.start;
    this.start = 0;
    while (this.end < n && !this.done) {
      const read = await this.reader.read();
      if (read.done) {
        this.done = true;
        break;
      }
      if (this.end + read.value.byteLength > this.buffer.byteLength) {
        this.grow(this.end + read.value.byteLength);
      }
      this.buffer.set(read.value, this.end);
      this.end += read.value.byteLength;
    }
    return this.end - this.start >= n;
  }

  async readExact(n: number): Promise<Uint8Array> {
    if (!(await this.ensure(n))) throw new DebianMissingControlError();
    const out = this.buffer.slice(this.start, this.start + n);
    this.start += n;
    return out;
  }

  async skip(n: number): Promise<void> {
    const buffered = Math.min(n, this.end - this.start);
    this.start += buffered;
    let remaining = n - buffered;
    while (remaining > 0 && !this.done) {
      const read = await this.reader.read();
      if (read.done) {
        this.done = true;
        break;
      }
      remaining -= read.value.byteLength;
    }
    if (remaining > 0) throw new DebianMissingControlError();
  }

  release(): void {
    try {
      this.reader.releaseLock();
    } catch {
      // already released
    }
  }
}

const AR_MAGIC = "!<arch>\n";
const LATIN1 = new TextDecoder("latin1");

/**
 * `ParsePackage` (metadata.go:92-163) over the SPOOLED upload: the ar walk
 * stops at the `control.tar[...]` member (the layout puts it second, after
 * `debian-binary`, and before the possibly-huge `data.tar.*` — the walk never
 * reads data.tar). The .gz member decodes through the member walk (exactly
 * one member). Returns the parsed control.
 */
export async function parseDebianPackage(body: ReadableStream<Uint8Array>): Promise<DebianPackageInfo> {
  const reader = new StreamReader(body.getReader());
  try {
    const magic = await reader.readExact(8);
    if (LATIN1.decode(magic) !== AR_MAGIC) throw new DebianMissingControlError();
    for (;;) {
      if (!(await reader.ensure(60))) throw new DebianMissingControlError();
      const headerBytes = await reader.readExact(60);
      const nameRaw = LATIN1.decode(headerBytes.subarray(0, 16));
      const name = nameRaw.slice(0, nameRaw.indexOf("\0")).replace(/\/\s*$/, "").trim();
      const size = Number.parseInt(LATIN1.decode(headerBytes.subarray(48, 58)).trim(), 10);
      if (!Number.isSafeInteger(size) || size < 0) throw new DebianMissingControlError();
      if (name.startsWith(CONTROL_TAR)) {
        if (size > MAX_CONTROL_TAR_SIZE) throw new DebianMissingControlError();
        const memberBytes = await reader.readExact(size);
        const suffix = name.slice(CONTROL_TAR.length).replace(/\/$/, "");
        let controlText: string | null = null;
        if (suffix === "") {
          controlText = findControlInTar(memberBytes);
        } else if (suffix === ".gz") {
          const members = await walkGzipMembers(memberBytes);
          const firstMember = members[0];
          if (members.length !== 1 || firstMember === undefined) throw new DebianMissingControlError();
          controlText = findControlInTar(firstMember.payload);
        } else {
          // .xz / .zst — no codec in the substrate (documented reduction).
          throw new DebianUnsupportedCompressionError();
        }
        if (controlText !== null) return parseDebianControlFile(controlText);
        // control.tar without a control file — upstream keeps walking (a
        // second control member would be pathological); ours ends 400.
        throw new DebianMissingControlError();
      }
      await reader.skip(size + (size % 2)); // two-byte member alignment
    }
  } finally {
    reader.release();
  }
}

/** The regular-file member named `control` (basename — Go's FileInfo().Name()
 *  semantics, metadata.go:155). */
function findControlInTar(tarBytes: Uint8Array): string | null {
  for (const member of readTarMembers(tarBytes)) {
    const base = member.name.slice(member.name.lastIndexOf("/") + 1);
    if (base === "control") return new TextDecoder().decode(member.data);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Upload (debian.go:118-203)
// ---------------------------------------------------------------------------

export interface UploadDebianPackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: { id: number; isAdmin: boolean };
  distribution: string;
  component: string;
  content: ReadableStream<Uint8Array>;
  declaredLength?: number;
  quota: PackagesQuotaConfig;
  now?: Date;
  spoolKey?: string;
  maxBytes?: number;
}

export interface UploadDebianPackageResult {
  file: { id: number; name: string };
  packageInfo: DebianPackageInfo;
}

/**
 * `UploadPackageFile` (debian.go:118-203) — the pypi upload shape (quota
 * order: COUNT pre-insert with the +1 parity, SIZE after the parse with the
 * real byte count), the D-1 duplicate rule (ANY existing file row → 409), and
 * the post-upload `BuildSpecificRepositoryFiles` rider.
 */
export async function uploadDebianPackage(input: UploadDebianPackageInput): Promise<UploadDebianPackageResult> {
  if (!isValidDebianDistributionOrComponent(input.distribution) || !isValidDebianDistributionOrComponent(input.component)) {
    throw new DebianInvalidDistOrComponentError();
  }
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
    const packageInfo = await parseDebianPackage(spoolObject.body as ReadableStream<Uint8Array>);
    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "debian", spooled.size, input.quota);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "debian",
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
      await writeVersionMetadata(input.d1, version.id, JSON.stringify(packageInfo.metadata));
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

    const filename = `${packageInfo.name}_${packageInfo.version}_${packageInfo.architecture}.deb`;
    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: filename,
      isLead: true,
      compositeKey: `${input.distribution}|${input.component}`,
      now,
    });
    if (fileResult.outcome !== "created") {
      throw new DuplicatePackageFileError(fileResult.row);
    }
    await drizzle(input.d1)
      .insert(packageProperties)
      .values([
        { refType: PropertyType.File, refId: fileResult.row.id, name: DEBIAN_PROPERTY_DISTRIBUTION, value: input.distribution },
        { refType: PropertyType.File, refId: fileResult.row.id, name: DEBIAN_PROPERTY_COMPONENT, value: input.component },
        { refType: PropertyType.File, refId: fileResult.row.id, name: DEBIAN_PROPERTY_ARCHITECTURE, value: packageInfo.architecture },
        { refType: PropertyType.File, refId: fileResult.row.id, name: DEBIAN_PROPERTY_CONTROL, value: packageInfo.control },
      ])
      .run();

    await buildDebianRepositoryFiles(input.d1, input.bucket, input.owner, input.distribution, input.component, packageInfo.architecture, now);
    return { file: { id: fileResult.row.id, name: filename }, packageInfo };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The index builders (repository.go)
// ---------------------------------------------------------------------------

export interface DebianFileRow {
  file: typeof packageFiles.$inferSelect;
  blob: typeof packageBlobs.$inferSelect;
  control: string;
  component: string;
  architecture: string;
}

/** One file-scoped property subselect (the correlated lookup the Packages
 *  paragraphs read back; the property name is a drizzle-bound parameter). */
function filePropertySubselect(name: string): SQL<string> {
  return sql<string>`(
    select pp.value from package_properties pp
    where pp.ref_type = ${PropertyType.File} and pp.ref_id = ${packageFiles.id}
      and pp.name = ${name} limit 1)`;
}

/**
 * `SearchPackages`'s correlated-count filter (models/packages/debian/
 * search.go:26-67) — is_lead files of NON-internal debian packages of the
 * owner whose file properties carry ALL THREE of dist/component/arch,
 * ordered by package lower_name then version creation (search.go:88's Asc).
 */
async function searchDebianFiles(
  d1: D1Database,
  ownerId: number,
  distribution: string,
  component: string,
  architecture: string,
): Promise<DebianFileRow[]> {
  const db = drizzle(d1);
  const rows = await db
    .select({
      file: packageFiles,
      blob: packageBlobs,
      control: filePropertySubselect(DEBIAN_PROPERTY_CONTROL),
      component: filePropertySubselect(DEBIAN_PROPERTY_COMPONENT),
      architecture: filePropertySubselect(DEBIAN_PROPERTY_ARCHITECTURE),
    })
    .from(packageFiles)
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
    .where(
      and(
        eq(packageFiles.isLead, true),
        eq(packages.type, "debian"),
        eq(packages.ownerId, ownerId),
        eq(packages.isInternal, false),
        eq(packageVersions.isInternal, false),
        sql`(select count(*) from package_properties pp
             where pp.ref_type = ${PropertyType.File} and pp.ref_id = ${packageFiles.id}
               and ((pp.name = ${DEBIAN_PROPERTY_DISTRIBUTION} and pp.value = ${distribution})
                 or (pp.name = ${DEBIAN_PROPERTY_COMPONENT} and pp.value = ${component})
                 or (pp.name = ${DEBIAN_PROPERTY_ARCHITECTURE} and pp.value = ${architecture}))) = 3`,
      ),
    )
    .orderBy(asc(packages.lowerName), asc(packageVersions.createdUnix))
    .all();
  return rows.map(({ file, blob, control, component: c, architecture: a }) => ({
    file,
    blob,
    control: control ?? "",
    component: c ?? "",
    architecture: a ?? "",
  }));
}

/**
 * `buildPackagesIndices` (repository.go:147-248): the Packages paragraphs
 * (control stanza + Filename/Size/hashes), stored as `Packages` +
 * `Packages.gz` (xz not generated — the documented reduction); the
 * empty-repository arm deletes the pair.
 */
async function buildPackagesIndices(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  repoVersion: InternalRepositoryVersion,
  distribution: string,
  component: string,
  architecture: string,
  now: Date,
): Promise<void> {
  const compositeKey = `${distribution}|${component}|${architecture}`;
  const rows = await searchDebianFiles(d1, owner.id, distribution, component, architecture);
  if (rows.length === 0) {
    for (const filename of ["Packages", "Packages.gz"]) {
      await deleteRepositoryFile(d1, repoVersion.version.id, filename, compositeKey);
    }
    return;
  }
  const paragraphs: string[] = [];
  for (const row of rows) {
    paragraphs.push(
      `${row.control}\n` +
        `Filename: pool/${distribution}/${component}/${row.file.name}\n` +
        `Size: ${row.blob.size}\n` +
        `SHA1: ${row.blob.hashSha1 ?? ""}\n` +
        `SHA256: ${row.blob.hashSha256}\n` +
        `SHA512: ${row.blob.hashSha512 ?? ""}\n`,
    );
  }
  const packagesText = paragraphs.join("\n");
  const plain = asciiBytes(packagesText);
  const gzipped = await gzipCompress(plain);
  const properties = {
    [DEBIAN_PROPERTY_INCLUDE_IN_RELEASE]: "",
    [DEBIAN_PROPERTY_DISTRIBUTION]: distribution,
    [DEBIAN_PROPERTY_COMPONENT]: component,
    [DEBIAN_PROPERTY_ARCHITECTURE]: architecture,
  };
  await storeRepositoryFile(d1, bucket, {
    versionId: repoVersion.version.id,
    filename: "Packages",
    compositeKey,
    content: plain,
    properties,
    now,
  });
  await storeRepositoryFile(d1, bucket, {
    versionId: repoVersion.version.id,
    filename: "Packages.gz",
    compositeKey,
    content: gzipped,
    properties,
    now,
  });
}

/** The include-in-release files of one distribution — the Release checksum
 *  rows (repository.go:252-261's SearchFiles + :331-343 descriptors). */
interface DebianReleaseRow {
  fileId: number;
  filename: string;
  size: number;
  sha1: string | null;
  sha256: string;
  sha512: string | null;
  component: string;
  architecture: string;
}

async function listIncludeInReleaseFiles(d1: D1Database, versionId: number, distribution: string): Promise<DebianReleaseRow[]> {
  const db = drizzle(d1);
  const existsProperty = (name: string, value?: string): SQL =>
    value === undefined
      ? sql`exists (select 1 from package_properties pp where pp.ref_type = ${PropertyType.File}
            and pp.ref_id = ${packageFiles.id} and pp.name = ${name})`
      : sql`exists (select 1 from package_properties pp where pp.ref_type = ${PropertyType.File}
            and pp.ref_id = ${packageFiles.id} and pp.name = ${name} and pp.value = ${value})`;
  const base = await db
    .select({
      fileId: packageFiles.id,
      filename: packageFiles.name,
      size: packageBlobs.size,
      sha1: packageBlobs.hashSha1,
      sha256: packageBlobs.hashSha256,
      sha512: packageBlobs.hashSha512,
    })
    .from(packageFiles)
    .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
    .where(
      and(
        eq(packageFiles.versionId, versionId),
        existsProperty(DEBIAN_PROPERTY_INCLUDE_IN_RELEASE, ""),
        existsProperty(DEBIAN_PROPERTY_DISTRIBUTION, distribution),
      ),
    )
    .all();
  if (base.length === 0) return [];
  const detailRows = await db
    .select({ refId: packageProperties.refId, name: packageProperties.name, value: packageProperties.value })
    .from(packageProperties)
    .where(
      and(
        eq(packageProperties.refType, PropertyType.File),
        inArray(
          packageProperties.refId,
          base.map((row) => row.fileId),
        ),
        inArray(packageProperties.name, [DEBIAN_PROPERTY_COMPONENT, DEBIAN_PROPERTY_ARCHITECTURE]),
      ),
    )
    .all();
  const details = new Map<number, { component: string; architecture: string }>();
  for (const detail of detailRows) {
    const entry = details.get(detail.refId) ?? { component: "", architecture: "" };
    if (detail.name === DEBIAN_PROPERTY_COMPONENT) entry.component = detail.value;
    if (detail.name === DEBIAN_PROPERTY_ARCHITECTURE) entry.architecture = detail.value;
    details.set(detail.refId, entry);
  }
  return base.map((row) => ({
    ...row,
    component: details.get(row.fileId)?.component ?? "",
    architecture: details.get(row.fileId)?.architecture ?? "",
  }));
}

/**
 * `buildReleaseFiles` (repository.go:251-397): the Release document over
 * every include-in-release file of the distribution, then the clearsigned
 * InRelease, the armored detached Release.gpg and the bare Release — stored
 * with composite key = distribution; the empty arm deletes the trio.
 */
async function buildReleaseFiles(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  repoVersion: InternalRepositoryVersion,
  distribution: string,
  now: Date,
): Promise<void> {
  const rows = await listIncludeInReleaseFiles(d1, repoVersion.version.id, distribution);
  if (rows.length === 0) {
    for (const filename of ["Release", "Release.gpg", "InRelease"]) {
      await deleteRepositoryFile(d1, repoVersion.version.id, filename, distribution);
    }
    return;
  }
  // Components/architectures: upstream reads the DISTINCT property values
  // (repository.go:281-293, GetComponents/GetArchitectures); the include-set's
  // own values are the same answer set (every Packages file of the dist is in
  // it) — sorted there, sorted here.
  const components = [...new Set(rows.map((row) => row.component))].sort();
  const architectures = [...new Set(rows.map((row) => row.architecture))].sort();

  const lines: string[] = [
    "Origin: Gitea",
    "Label: Gitea",
    `Suite: ${distribution}`,
    `Codename: ${distribution}`,
    `Components: ${components.join(" ")}`,
    `Architectures: ${architectures.join(" ")}`,
    `Date: ${now.toUTCString()}`,
    "Acquire-By-Hash: yes",
  ];
  const ordered = rows
    .map((row) => ({ row, path: `${row.component}/binary-${row.architecture}/${row.filename}` }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const [header, digest] of [
    ["SHA1:", (row: DebianReleaseRow) => row.sha1],
    ["SHA256:", (row: DebianReleaseRow) => row.sha256],
    ["SHA512:", (row: DebianReleaseRow) => row.sha512],
  ] as const) {
    lines.push(header);
    for (const { row, path } of ordered) {
      const value = digest(row);
      if (value !== null && value !== "") lines.push(` ${value} ${row.size} ${path}`);
    }
  }
  const releaseText = `${lines.join("\n")}\n`;

  // The signing arms (repository.go:295-361): InRelease clearsigned,
  // Release.gpg armored-detached, Release bare.
  const keys = await getOrCreateDebianKeyPair(d1, owner.id);
  const createdSeconds = keys.creationTime ?? Math.floor(now.getTime() / 1000);
  const key = await loadOpenPgpKey(keys.publicSpki, keys.privateKey, createdSeconds);
  const inRelease = await openPgpClearsign(key, releaseText, Math.floor(now.getTime() / 1000));
  const releaseGpg = await openPgpArmoredDetachedSign(key, asciiBytes(releaseText), Math.floor(now.getTime() / 1000));

  const properties = { [DEBIAN_PROPERTY_DISTRIBUTION]: distribution };
  await storeRepositoryFile(d1, bucket, {
    versionId: repoVersion.version.id,
    filename: "Release",
    compositeKey: distribution,
    content: asciiBytes(releaseText),
    properties,
    now,
  });
  await storeRepositoryFile(d1, bucket, {
    versionId: repoVersion.version.id,
    filename: "Release.gpg",
    compositeKey: distribution,
    content: asciiBytes(releaseGpg),
    properties,
    now,
  });
  await storeRepositoryFile(d1, bucket, {
    versionId: repoVersion.version.id,
    filename: "InRelease",
    compositeKey: distribution,
    content: asciiBytes(inRelease),
    properties,
    now,
  });
}

/**
 * `BuildSpecificRepositoryFiles` (repository.go:128-136): the Packages pair
 * for the exact dist/component/arch, then the Release trio for the whole
 * distribution.
 */
export async function buildDebianRepositoryFiles(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  distribution: string,
  component: string,
  architecture: string,
  now?: Date,
): Promise<void> {
  const repoVersion = await getOrCreateInternalPackageVersion(d1, owner.id, "debian", DEBIAN_REPOSITORY_PACKAGE, DEBIAN_REPOSITORY_VERSION);
  await buildPackagesIndices(d1, bucket, owner, repoVersion, distribution, component, architecture, now ?? new Date());
  await buildReleaseFiles(d1, bucket, owner, repoVersion, distribution, now ?? new Date());
}

/** The debian signing arms — upstream's setting keys + a third row carrying
 *  the OpenPGP key-packet creation time. */
export async function getOrCreateDebianKeyPair(
  d1: D1Database,
  ownerId: number,
): Promise<Awaited<ReturnType<typeof getOrCreateOwnerKeyPair>> & { creationTime?: number }> {
  return getOrCreateOwnerKeyPair(d1, ownerId, DEBIAN_SETTING_KEY_PRIVATE, DEBIAN_SETTING_KEY_PUBLIC, "SHA-256", DEBIAN_SETTING_KEY_CREATED);
}

/** The repository.key arm's body (debian.go:31-42): the armored transferable
 *  public key (application/pgp-keys). */
export async function buildDebianRepositoryKey(d1: D1Database, ownerId: number): Promise<string> {
  const keys = await getOrCreateDebianKeyPair(d1, ownerId);
  const createdSeconds = keys.creationTime ?? Math.floor(Date.now() / 1000);
  const key = await loadOpenPgpKey(keys.publicSpki, keys.privateKey, createdSeconds);
  return openPgpTransferablePublicKey(key, "(Automatically generated Debian Registry Key; created by Gitea)", createdSeconds);
}

// ---------------------------------------------------------------------------
// Serving + delete (debian.go:46-116 + :205-306)
// ---------------------------------------------------------------------------

export interface DebianDownload {
  stream: ReadableStream;
  size: number;
  filename: string;
  created: Date;
}

/** The stored-file opener (the content object over the blob row). */
async function openStoredFile(
  d1: D1Database,
  bucket: R2Bucket,
  versionId: number,
  filename: string,
  compositeKey: string,
): Promise<DebianDownload | null> {
  const pair = await drizzle(d1)
    .select({ file: packageFiles, blob: packageBlobs })
    .from(packageFiles)
    .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
    .where(
      and(
        eq(packageFiles.versionId, versionId),
        eq(packageFiles.lowerName, filename.toLowerCase()),
        eq(packageFiles.compositeKey, compositeKey),
      ),
    )
    .get();
  if (pair === undefined) return null;
  const object = await bucket.get(packageBlobContentKey(pair.blob.hashSha256));
  if (object === null) return null;
  return { stream: object.body, size: object.size, filename: pair.file.name, created: pair.file.createdUnix };
}

/**
 * `GetRepositoryFile` (debian.go:46-76) — the internal version's files: the
 * dist-level files use composite key = distribution; the component files use
 * `dist|component|arch` (the `binary-` prefix trimmed, debian.go:56-59).
 */
export async function openDebianRepositoryFile(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  distribution: string,
  component: string,
  architecture: string,
  filename: string,
): Promise<DebianDownload | null> {
  const repoVersion = await getOrCreateInternalPackageVersion(d1, owner.id, "debian", DEBIAN_REPOSITORY_PACKAGE, DEBIAN_REPOSITORY_VERSION);
  let compositeKey = distribution;
  if (component !== "" && architecture !== "") {
    compositeKey = `${distribution}|${component}|${architecture}`;
  }
  return openStoredFile(d1, bucket, repoVersion.version.id, filename, compositeKey);
}

/** `GetRepositoryFileByHash` (debian.go:79-116): files of the internal
 *  version whose blob hash matches; md5sum maps to the never-stored md5 →
 *  404 (the documented reduction). */
export async function openDebianRepositoryFileByHash(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  algorithm: string,
  hash: string,
): Promise<DebianDownload | null> {
  const algo = algorithm.toLowerCase() === "md5sum" ? "md5" : algorithm.toLowerCase();
  const digest = hash.toLowerCase();
  if (!/^(sha1|sha256|sha512|md5)$/.test(algo) || !/^[0-9a-f]+$/.test(digest)) return null;
  if (algo === "md5") return null; // MD5 never stored (the documented reduction)
  const repoVersion = await getOrCreateInternalPackageVersion(d1, owner.id, "debian", DEBIAN_REPOSITORY_PACKAGE, DEBIAN_REPOSITORY_VERSION);
  const db = drizzle(d1);
  const hashCondition =
    algo === "sha1" ? eq(packageBlobs.hashSha1, digest) : algo === "sha512" ? eq(packageBlobs.hashSha512, digest) : eq(packageBlobs.hashSha256, digest);
  const match = await db
    .select({ file: packageFiles, blob: packageBlobs })
    .from(packageFiles)
    .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
    .where(and(eq(packageFiles.versionId, repoVersion.version.id), hashCondition))
    .limit(1)
    .all();
  const found = match[0];
  if (found === undefined) return null;
  const object = await bucket.get(packageBlobContentKey(found.blob.hashSha256));
  if (object === null) return null;
  return { stream: object.body, size: object.size, filename: found.file.name, created: found.file.createdUnix };
}

/** `DownloadPackageFile` (debian.go:205-237) — the pool path. The lead-file
 *  download counter rides `OpenFileForDownload` upstream (packages_service's
 *  increment arm); the routes pass the method. */
export async function openDebianPoolFile(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  distribution: string,
  component: string,
  name: string,
  version: string,
  architecture: string,
  method: "GET" | "HEAD" = "GET",
): Promise<{ download: DebianDownload; versionId: number } | null> {
  const versionRow = await getVersionByNameAndVersion(d1, owner.id, "debian", name, version);
  if (versionRow === null) return null;
  const download = await openStoredFile(
    d1,
    bucket,
    versionRow.id,
    `${name}_${version}_${architecture}.deb`,
    `${distribution}|${component}`,
  );
  if (download === null) return null;
  if (method === "GET") await incrementDownloadCounter(d1, versionRow.id);
  return { download, versionId: versionRow.id };
}

/**
 * `DeletePackageFile` (debian.go:239-306): the named .deb row, the
 * version-if-unreferenced fold, then the index rebuild rider. Answers
 * `false` for the 404 arm (missing version or file).
 */
export async function deleteDebianPackageFile(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  distribution: string,
  component: string,
  name: string,
  version: string,
  architecture: string,
  now?: Date,
): Promise<boolean> {
  const versionRow = await getVersionByNameAndVersion(d1, owner.id, "debian", name, version);
  if (versionRow === null) return false;
  const db = drizzle(d1);
  const fileRow = await db
    .select()
    .from(packageFiles)
    .where(
      and(
        eq(packageFiles.versionId, versionRow.id),
        eq(packageFiles.lowerName, `${name}_${version}_${architecture}.deb`.toLowerCase()),
        eq(packageFiles.compositeKey, `${distribution}|${component}`),
      ),
    )
    .get();
  if (fileRow === undefined) return false;
  await deletePackageFile(d1, fileRow.id);
  const stillReferenced = await hasVersionFileReferences(d1, versionRow.id);
  if (!stillReferenced) {
    await deletePackageVersionAndReferences(d1, versionRow.id);
  }
  await buildDebianRepositoryFiles(d1, bucket, owner, distribution, component, architecture, now);
  return true;
}

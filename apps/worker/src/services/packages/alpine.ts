/**
 * The Alpine registry family (SPEC-0016 §7 M7) — upstream at the pin
 * fc4936884584: routers/api/packages/alpine/alpine.go (284 ln) +
 * services/packages/alpine/repository.go (351 ln) + modules/packages/alpine/
 * metadata.go (the multi-member .apk ParsePackage + PKGINFO reader).
 *
 * ## The index-builder posture
 *
 * Same as the debian sibling: indices are STORED, not rendered per request —
 * every upload/delete ends with `BuildSpecificRepositoryFiles`
 * (alpine.go:195/278 → repository.go:97-120) and `GetRepositoryFile` serves
 * the stored `APKINDEX.tar.gz` from the internal `_alpine` + `_repository`
 * package version. The noarch folds are upstream's own: a noarch upload
 * re-rolls EVERY architecture's index of that branch/repository
 * (repository.go:104-112), and every per-architecture index merges the
 * noarch packages in (repository.go:155-162), with the download/serving arms
 * falling back to the noarch index/file when the requested architecture has
 * none (alpine.go:83-97/:219-236).
 *
 * ## The APKINDEX format (repository.go:149-351)
 *
 * A concatenated-gzip archive of two tar streams: `.SIGN.RSA-<owner>@<fp>.rsa.pub`
 * (the RSA-SHA1 PKCS#1v1.5 signature over the SECOND stream's bytes, written
 * WITHOUT tar end blocks — writeGzipStream's addTarEnd=false) followed by the
 * `APKINDEX` stream (tar WITH end blocks, gzipped). The checksum line `C:` is
 * "Q1" + base64(sha1(RAW member bytes)) — the tee'd reader in metadata.go:79-108;
 * this module's member walk (distro-common) reproduces the per-member raw
 * hashing exactly.
 *
 * ## Documented reductions
 *
 *  - RSA-2048 (upstream util.GenerateKeyPair(4096) — the documented
 *    Workers-cost divergence, the actions OIDC precedent).
 *  - The .apk parse reads the upload prefix bounded at 64 MiB (signature +
 *    control members are kilobytes in real apks; the cap is the hostile-input
 *    gate — upstream reads the whole stream but stops at the PKGINFO member).
 *  - The index paragraph order is file lower_name ascending (upstream's
 *    SearchFiles leaves the order to the engine's default; ours is pinned).
 */

import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageBlobs, packageFiles, packageProperties, packages, packageVersions } from "../../db/schema";
import {
  asciiBytes,
  buildTar,
  bytesToBase64,
  getOrCreateInternalPackageVersion,
  getOrCreateOwnerKeyPair,
  gzipCompress,
  packageBlobContentKey,
  PropertyType,
  rsaKeyFingerprint,
  rsaSign,
  rsaVerify,
  storeRepositoryFile,
  deleteRepositoryFile,
  walkGzipMembers,
  readTarMembers,
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
  getOrInsertPackage,
  getOrInsertVersion,
  hasVersionFileReferences,
  incrementDownloadCounter,
  QuotaTotalCountError,
  tryInsertFile,
  UNLIMITED_QUOTA,
  type PackagesQuotaConfig,
} from "./model";
import { DuplicatePackageFileError } from "./generic";
import { writeVersionMetadata } from "./protocol-common";

// ---------------------------------------------------------------------------
// Upstream constants (modules/packages/alpine/metadata.go:26-41)
// ---------------------------------------------------------------------------

/** The owner slice the service reads (the routes pass the resolved row — the
 *  container family's ContainerOwner shape). */
export interface AlpineOwner {
  id: number;
  usernameLower: string;
  visibility: "public" | "limited" | "private";
  type: "user" | "org";
}

export const ALPINE_PROPERTY_METADATA = "alpine.metadata";
export const ALPINE_PROPERTY_BRANCH = "alpine.branch";
export const ALPINE_PROPERTY_REPOSITORY = "alpine.repository";
export const ALPINE_PROPERTY_ARCHITECTURE = "alpine.architecture";

const ALPINE_SETTING_KEY_PRIVATE = "alpine.key.private";
const ALPINE_SETTING_KEY_PUBLIC = "alpine.key.public";

export const ALPINE_REPOSITORY_PACKAGE = "_alpine";
export const ALPINE_REPOSITORY_VERSION = "_repository";

export const ALPINE_NOARCH = "noarch";

export const ALPINE_INDEX_FILENAME = "APKINDEX";
export const ALPINE_INDEX_ARCHIVE_FILENAME = "APKINDEX.tar.gz";

/** metadata.go:40 — the PKGINFO provides/depend cap. */
const MAX_PACKAGE_INFO_ENTRIES = 1024;

/** The .apk parse window (the module-header reduction). */
const MAX_APK_PARSE_WINDOW = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Metadata shapes (metadata.go:48-73 — the Go JSON tag order/omitempty)
// ---------------------------------------------------------------------------

/** VersionMetadata's marshal order: description, license, project_url,
 *  maintainer (all omitempty). */
export interface AlpineVersionMetadata {
  description?: string;
  license?: string;
  project_url?: string;
  maintainer?: string;
}

/** FileMetadata's marshal order: checksum (NO omitempty), then the rest. */
export interface AlpineFileMetadata {
  checksum: string;
  packager?: string;
  build_date?: number;
  size?: number;
  architecture?: string;
  origin?: string;
  commit_hash?: string;
  install_if?: string;
  provides?: string[];
  dependencies?: string[];
  provider_priority?: number;
}

export interface AlpinePackageInfo {
  name: string;
  version: string;
  versionMetadata: AlpineVersionMetadata;
  fileMetadata: AlpineFileMetadata;
}

// ---------------------------------------------------------------------------
// Errors — upstream's sentinels (metadata.go:19-24)
// ---------------------------------------------------------------------------

export class AlpineMissingPkginfoError extends Error {
  constructor() {
    super("PKGINFO file is missing");
    this.name = "AlpineMissingPkginfoError";
  }
}

export class AlpineInvalidNameError extends Error {
  constructor() {
    super("package name is invalid");
    this.name = "AlpineInvalidNameError";
  }
}

export class AlpineInvalidVersionError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "AlpineInvalidVersionError";
  }
}

export class AlpinePackageInfoTooLargeError extends Error {
  constructor() {
    super("PKGINFO contains too many entries");
    this.name = "AlpinePackageInfoTooLargeError";
  }
}

export class AlpineInvalidBranchError extends Error {
  constructor() {
    super("invalid branch or repository");
    this.name = "AlpineInvalidBranchError";
  }
}

// ---------------------------------------------------------------------------
// The .apk parse (metadata.go:77-261)
// ---------------------------------------------------------------------------

/** ParsePackageInfo (metadata.go:139-235) — the PKGINFO key=value reader. */
export function parseAlpinePackageInfo(text: string): AlpinePackageInfo {
  const info: AlpinePackageInfo = {
    name: "",
    version: "",
    versionMetadata: {},
    fileMetadata: { checksum: "" },
  };
  let listCount = 0;
  const addList = (value: string): void => {
    if (value !== "") {
      listCount += 1;
      if (listCount >= MAX_PACKAGE_INFO_ENTRIES) throw new AlpinePackageInfoTooLargeError();
    }
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
      case "pkgver":
        info.version = value;
        break;
      case "pkgdesc":
        info.versionMetadata.description = value;
        break;
      case "url":
        info.versionMetadata.project_url = value;
        break;
      case "builddate": {
        const parsed = Number.parseInt(value, 10);
        if (Number.isSafeInteger(parsed)) info.fileMetadata.build_date = parsed;
        break;
      }
      case "size": {
        const parsed = Number.parseInt(value, 10);
        if (Number.isSafeInteger(parsed)) info.fileMetadata.size = parsed;
        break;
      }
      case "arch":
        info.fileMetadata.architecture = value;
        break;
      case "origin":
        info.fileMetadata.origin = value;
        break;
      case "commit":
        info.fileMetadata.commit_hash = value;
        break;
      case "maintainer":
        info.versionMetadata.maintainer = value;
        break;
      case "packager":
        info.fileMetadata.packager = value;
        break;
      case "license":
        info.versionMetadata.license = value;
        break;
      case "install_if":
        info.fileMetadata.install_if = value;
        break;
      case "provides":
        addList(value);
        if (value !== "") {
          (info.fileMetadata.provides ??= []).push(value);
        }
        break;
      case "depend":
        addList(value);
        if (value !== "") {
          (info.fileMetadata.dependencies ??= []).push(value);
        }
        break;
      case "provider_priority": {
        const parsed = Number.parseInt(value, 10);
        if (Number.isSafeInteger(parsed)) info.fileMetadata.provider_priority = parsed;
        break;
      }
    }
  }
  // metadata.go:237-246: name/version non-empty; the URL validity gate clears
  // a non-http(s) project_url.
  if (info.name === "") throw new AlpineInvalidNameError();
  if (info.version === "") throw new AlpineInvalidVersionError();
  if (info.versionMetadata.project_url !== undefined) {
    try {
      const parsed = new URL(info.versionMetadata.project_url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") info.versionMetadata.project_url = "";
    } catch {
      info.versionMetadata.project_url = "";
    }
  }
  if (info.versionMetadata.project_url === "") delete info.versionMetadata.project_url;
  return info;
}

/**
 * `ParsePackage` (metadata.go:77-136) over the spooled upload: the
 * concatenated-gzip member walk (signature stream, then the control stream
 * carrying `.PKGINFO`), stopping at the PKGINFO member like upstream. The
 * checksum = "Q1" + base64(sha1(RAW member bytes)) — the tee'd reader's
 * product (the member containing .PKGINFO).
 */
export async function parseAlpinePackage(body: ReadableStream<Uint8Array>): Promise<AlpinePackageInfo> {
  const reader = body.getReader();
  let window = new Uint8Array(0);
  let filled = 0;
  try {
    for (;;) {
      // Read another chunk into the window (geometric start, capped).
      if (filled === window.byteLength) {
        const grown = new Uint8Array(Math.min(Math.max(window.byteLength * 2, 256 * 1024), MAX_APK_PARSE_WINDOW));
        grown.set(window.subarray(0, filled), 0);
        window = grown;
      }
      const read = await reader.read();
      if (read.done) break;
      const chunk = read.value;
      if (filled + chunk.byteLength > window.byteLength) {
        // A chunk bigger than the remaining capacity: grow to fit.
        const grown = new Uint8Array(Math.min(Math.max(filled + chunk.byteLength, window.byteLength * 2), MAX_APK_PARSE_WINDOW));
        grown.set(window.subarray(0, filled), 0);
        window = grown;
      }
      if (filled + chunk.byteLength > window.byteLength) throw new AlpineMissingPkginfoError();
      window.set(chunk, filled);
      filled += chunk.byteLength;

      try {
        const members = await walkGzipMembers(window.subarray(0, filled));
        for (const member of members) {
          const entries = readPkginfoFromTar(member.payload);
          if (entries === null) continue;
          const checksumDigest = await crypto.subtle.digest("SHA-1", member.raw);
          const info = parseAlpinePackageInfo(entries);
          info.fileMetadata.checksum = `Q1${bytesToBase64(new Uint8Array(checksumDigest))}`;
          return info;
        }
      } catch (error) {
        // A window that cuts the last member mid-stream ends the walk with
        // "invalid gzip member" — grow and retry.
        if (!(error instanceof Error) || error.message !== "invalid gzip member") throw error;
      }
    }
    throw new AlpineMissingPkginfoError();
  } finally {
    reader.releaseLock();
  }
}

/** The regular-file members' `.PKGINFO` text (metadata.go:89-107's walk —
 *  the FIRST member whose tar carries .PKGINFO answers). */
function readPkginfoFromTar(payload: Uint8Array): string | null {
  for (const member of readTarMembers(payload)) {
    const base = member.name.slice(member.name.lastIndexOf("/") + 1);
    if (base === ".PKGINFO") return new TextDecoder().decode(member.data);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Upload (alpine.go:110-201)
// ---------------------------------------------------------------------------

export interface UploadAlpinePackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: AlpineOwner;
  doer: { id: number; isAdmin: boolean };
  branch: string;
  repository: string;
  content: ReadableStream<Uint8Array>;
  declaredLength?: number;
  quota: PackagesQuotaConfig;
  now?: Date;
  spoolKey?: string;
  maxBytes?: number;
}

export interface UploadAlpinePackageResult {
  file: { id: number; name: string };
  packageInfo: AlpinePackageInfo;
}

/**
 * `UploadPackageFile` (alpine.go:110-201) — the shared quota/duplicate
 * posture of the debian sibling, the file properties carrying the branch/
 * repository/architecture/metadata quadruple, and the index rebuild rider
 * with the noarch propagation.
 */
export async function uploadAlpinePackage(input: UploadAlpinePackageInput): Promise<UploadAlpinePackageResult> {
  const branch = input.branch.trim();
  const repository = input.repository.trim();
  if (branch === "" || repository === "") throw new AlpineInvalidBranchError();
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
    const packageInfo = await parseAlpinePackage(spoolObject.body as ReadableStream<Uint8Array>);
    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "alpine", spooled.size, input.quota);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "alpine",
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
    const filename = `${packageInfo.name}-${packageInfo.version}.apk`;
    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: filename,
      isLead: true,
      compositeKey: `${branch}|${repository}|${architecture}`,
      now,
    });
    if (fileResult.outcome !== "created") {
      throw new DuplicatePackageFileError(fileResult.row);
    }
    await drizzle(input.d1)
      .insert(packageProperties)
      .values([
        { refType: PropertyType.File, refId: fileResult.row.id, name: ALPINE_PROPERTY_BRANCH, value: branch },
        { refType: PropertyType.File, refId: fileResult.row.id, name: ALPINE_PROPERTY_REPOSITORY, value: repository },
        { refType: PropertyType.File, refId: fileResult.row.id, name: ALPINE_PROPERTY_ARCHITECTURE, value: architecture },
        { refType: PropertyType.File, refId: fileResult.row.id, name: ALPINE_PROPERTY_METADATA, value: JSON.stringify(packageInfo.fileMetadata) },
      ])
      .run();

    await buildAlpineRepositoryFiles(input.d1, input.bucket, input.owner, branch, repository, architecture, now);
    return { file: { id: fileResult.row.id, name: filename }, packageInfo };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The index builder (repository.go:53-329)
// ---------------------------------------------------------------------------

export interface AlpineIndexFileRow {
  file: typeof packageFiles.$inferSelect;
  blob: typeof packageBlobs.$inferSelect;
  version: typeof packageVersions.$inferSelect;
  /** The package row's display name — the P: line (repository.go:219). */
  packageName: string;
  fileMetadata: AlpineFileMetadata;
  versionMetadata: AlpineVersionMetadata;
}

/** The property subselect helper (the debian sibling's shape). */
function filePropertySubselect(name: string): SQL<string> {
  return sql<string>`(
    select pp.value from package_properties pp
    where pp.ref_type = ${PropertyType.File} and pp.ref_id = ${packageFiles.id}
      and pp.name = ${name} limit 1)`;
}

/**
 * `searchPackageFiles` (repository.go:132-147): .apk files of the owner's
 * non-internal alpine packages whose file properties match the branch/
 * repository/architecture triple (the generic SearchFiles property filter).
 */
async function searchAlpineFiles(
  d1: D1Database,
  ownerId: number,
  branch: string,
  repository: string,
  architecture: string,
): Promise<AlpineIndexFileRow[]> {
  const db = drizzle(d1);
  const rows = await db
    .select({
      file: packageFiles,
      blob: packageBlobs,
      version: packageVersions,
      packageName: packages.name,
      fileMetadataRaw: filePropertySubselect(ALPINE_PROPERTY_METADATA),
    })
    .from(packageFiles)
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
    .where(
      and(
        eq(packages.type, "alpine"),
        eq(packages.ownerId, ownerId),
        eq(packages.isInternal, false),
        eq(packageVersions.isInternal, false),
        sql`${packageFiles.lowerName} like '%.apk'`,
        sql`(select count(*) from package_properties pp
             where pp.ref_type = ${PropertyType.File} and pp.ref_id = ${packageFiles.id}
               and ((pp.name = ${ALPINE_PROPERTY_BRANCH} and pp.value = ${branch})
                 or (pp.name = ${ALPINE_PROPERTY_REPOSITORY} and pp.value = ${repository})
                 or (pp.name = ${ALPINE_PROPERTY_ARCHITECTURE} and pp.value = ${architecture}))) = 3`,
      ),
    )
    .orderBy(asc(packageFiles.lowerName))
    .all();
  return rows.map(({ file, blob, version, packageName, fileMetadataRaw }) => ({
    file,
    blob,
    version,
    packageName: packageName ?? "",
    fileMetadata: (fileMetadataRaw ? (JSON.parse(fileMetadataRaw) as AlpineFileMetadata) : { checksum: "" }),
    versionMetadata: (version.metadataJson ? (JSON.parse(version.metadataJson) as AlpineVersionMetadata) : {}),
  }));
}

/**
 * `buildPackagesIndex` (repository.go:150-329): the APKINDEX paragraphs from
 * the stored file/version metadata, tarred+gzipped, RSA-SHA1 signed into the
 * leading `.SIGN.RSA-…` member, stored as `APKINDEX.tar.gz`. The noarch merge
 * (repository.go:155-162) folds noarch packages into every real
 * architecture's index.
 */
async function buildAlpinePackagesIndex(
  d1: D1Database,
  bucket: R2Bucket,
  owner: AlpineOwner,
  repoVersion: Awaited<ReturnType<typeof getOrCreateInternalPackageVersion>>,
  branch: string,
  repository: string,
  architecture: string,
  now: Date,
): Promise<void> {
  const compositeKey = `${branch}|${repository}|${architecture}`;
  let rows = await searchAlpineFiles(d1, owner.id, branch, repository, architecture);
  if (architecture !== ALPINE_NOARCH) {
    const noarchRows = await searchAlpineFiles(d1, owner.id, branch, repository, ALPINE_NOARCH);
    rows = [...rows, ...noarchRows];
  }
  if (rows.length === 0) {
    await deleteRepositoryFile(d1, repoVersion.version.id, ALPINE_INDEX_ARCHIVE_FILENAME, compositeKey);
    return;
  }
  // The paragraphs (repository.go:215-252) — A: prints the INDEX's
  // architecture (a noarch file's paragraph carries the requested arch).
  const paragraphs: string[] = [];
  for (const row of rows) {
    const fm = row.fileMetadata;
    const vm = row.versionMetadata;
    const lines: string[] = [
      `C:${fm.checksum}`,
      `P:${row.packageName}`,
      `V:${row.version.version}`,
      `A:${architecture}`,
    ];
    if (vm.description !== undefined && vm.description !== "") lines.push(`T:${vm.description}`);
    if (vm.project_url !== undefined && vm.project_url !== "") lines.push(`U:${vm.project_url}`);
    if (vm.license !== undefined && vm.license !== "") lines.push(`L:${vm.license}`);
    lines.push(`S:${row.blob.size}`);
    lines.push(`I:${fm.size ?? 0}`);
    lines.push(`o:${fm.origin ?? ""}`);
    lines.push(`m:${vm.maintainer ?? ""}`);
    lines.push(`t:${fm.build_date ?? 0}`);
    if (fm.commit_hash !== undefined && fm.commit_hash !== "") lines.push(`c:${fm.commit_hash}`);
    if (fm.dependencies !== undefined && fm.dependencies.length > 0) lines.push(`D:${fm.dependencies.join(" ")}`);
    if (fm.provides !== undefined && fm.provides.length > 0) lines.push(`p:${fm.provides.join(" ")}`);
    if (fm.install_if !== undefined && fm.install_if !== "") lines.push(`i:${fm.install_if}`);
    if (fm.provider_priority !== undefined && fm.provider_priority > 0) lines.push(`k:${fm.provider_priority}`);
    paragraphs.push(`${lines.join("\n")}\n`);
  }
  const indexText = paragraphs.join("\n");

  // The two-stream archive (repository.go:254-307): member 2 = the unsigned
  // index (tar WITH end blocks, gzipped); member 1 = the signature entry (tar
  // WITHOUT end blocks, gzipped) prepended.
  const unsignedArchive = await gzipCompress(buildTar([{ name: ALPINE_INDEX_FILENAME, mode: 0o600, data: asciiBytes(indexText) }], true));
  const keys = await getOrCreateAlpineKeyPair(d1, owner.id);
  const signature = await rsaSign(keys.privateKey, unsignedArchive);
  const fingerprint = await rsaKeyFingerprint(keys.publicPem);
  const signEntry = await gzipCompress(
    buildTar([{ name: `.SIGN.RSA-${owner.usernameLower}@${fingerprint}.rsa.pub`, mode: 0o600, data: signature }], false),
  );
  const archive = new Uint8Array(signEntry.byteLength + unsignedArchive.byteLength);
  archive.set(signEntry, 0);
  archive.set(unsignedArchive, signEntry.byteLength);

  await storeRepositoryFile(d1, bucket, {
    versionId: repoVersion.version.id,
    filename: ALPINE_INDEX_ARCHIVE_FILENAME,
    compositeKey,
    content: archive,
    properties: {
      [ALPINE_PROPERTY_BRANCH]: branch,
      [ALPINE_PROPERTY_REPOSITORY]: repository,
      [ALPINE_PROPERTY_ARCHITECTURE]: architecture,
    },
    now,
  });
}

/**
 * `BuildSpecificRepositoryFiles` (repository.go:97-120): the requested
 * architecture's index — plus EVERY existing architecture of the branch/
 * repository when the upload was noarch (the propagation arm).
 */
export async function buildAlpineRepositoryFiles(
  d1: D1Database,
  bucket: R2Bucket,
  owner: AlpineOwner,
  branch: string,
  repository: string,
  architecture: string,
  now?: Date,
): Promise<void> {
  const repoVersion = await getOrCreateInternalPackageVersion(d1, owner.id, "alpine", ALPINE_REPOSITORY_PACKAGE, ALPINE_REPOSITORY_VERSION);
  const architectures = new Set<string>([architecture]);
  if (architecture === ALPINE_NOARCH) {
    for (const existing of await listAlpineArchitectures(d1, owner.id, branch, repository)) {
      architectures.add(existing);
    }
  }
  for (const arch of architectures) {
    await buildAlpinePackagesIndex(d1, bucket, owner, repoVersion, branch, repository, arch, now ?? new Date());
  }
}

/** The distinct architectures of a branch/repository (the propagation scan —
 *  upstream GetArchitectures, models/packages/alpine/search.go:42-52). */
async function listAlpineArchitectures(d1: D1Database, ownerId: number, branch: string, repository: string): Promise<string[]> {
  const rows = await drizzle(d1)
    .select({ value: packageProperties.value })
    .from(packageProperties)
    .innerJoin(packageFiles, eq(packageFiles.id, packageProperties.refId))
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      and(
        eq(packageProperties.refType, PropertyType.File),
        eq(packageProperties.name, ALPINE_PROPERTY_ARCHITECTURE),
        eq(packages.type, "alpine"),
        eq(packages.ownerId, ownerId),
        eq(packages.isInternal, false),
        eq(packageVersions.isInternal, false),
        sql`exists (select 1 from package_properties pp where pp.ref_type = ${PropertyType.File}
              and pp.ref_id = ${packageFiles.id}
              and pp.name = ${ALPINE_PROPERTY_BRANCH} and pp.value = ${branch})`,
        sql`exists (select 1 from package_properties pp where pp.ref_type = ${PropertyType.File}
              and pp.ref_id = ${packageFiles.id}
              and pp.name = ${ALPINE_PROPERTY_REPOSITORY} and pp.value = ${repository})`,
      ),
    )
    .groupBy(packageProperties.value)
    .all();
  return rows.map((row) => row.value);
}

/** The alpine signing arms — upstream's setting keys (the RSA fingerprint is
 *  SPKI-derived, no creation-time material → no created row). */
export async function getOrCreateAlpineKeyPair(
  d1: D1Database,
  ownerId: number,
): Promise<Awaited<ReturnType<typeof getOrCreateOwnerKeyPair>> & { creationTime?: number }> {
  return getOrCreateOwnerKeyPair(d1, ownerId, ALPINE_SETTING_KEY_PRIVATE, ALPINE_SETTING_KEY_PUBLIC, "SHA-1");
}

/** The `key` arm (alpine.go:32-61): the public PEM + its fingerprint (the
 *  served filename `{lower}@{fingerprint}.rsa.pub`). */
export async function buildAlpineRepositoryKey(
  d1: D1Database,
  ownerId: number,
): Promise<{ publicPem: string; fingerprint: string }> {
  const keys = await getOrCreateAlpineKeyPair(d1, ownerId);
  return { publicPem: keys.publicPem, fingerprint: await rsaKeyFingerprint(keys.publicPem) };
}

// ---------------------------------------------------------------------------
// Serving + delete (alpine.go:63-108 + :203-284)
// ---------------------------------------------------------------------------

export interface AlpineDownload {
  stream: ReadableStream;
  size: number;
  filename: string;
  created: Date;
}

/** `GetRepositoryFile` (alpine.go:63-108): the stored index for
 *  branch|repository|architecture, falling back to the noarch index (the
 *  noarch-only-repository arm). */
export async function openAlpineIndexFile(
  d1: D1Database,
  bucket: R2Bucket,
  owner: AlpineOwner,
  branch: string,
  repository: string,
  architecture: string,
): Promise<AlpineDownload | null> {
  const repoVersion = await getOrCreateInternalPackageVersion(d1, owner.id, "alpine", ALPINE_REPOSITORY_PACKAGE, ALPINE_REPOSITORY_VERSION);
  const open = async (arch: string): Promise<AlpineDownload | null> => {
    const pair = await drizzle(d1)
      .select({ file: packageFiles, blob: packageBlobs })
      .from(packageFiles)
      .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
      .where(
        and(
          eq(packageFiles.versionId, repoVersion.version.id),
          eq(packageFiles.lowerName, ALPINE_INDEX_ARCHIVE_FILENAME.toLowerCase()),
          eq(packageFiles.compositeKey, `${branch}|${repository}|${arch}`),
        ),
      )
      .get();
    if (pair === undefined) return null;
    const object = await bucket.get(packageBlobContentKey(pair.blob.hashSha256));
    if (object === null) return null;
    return { stream: object.body, size: object.size, filename: pair.file.name, created: pair.file.createdUnix };
  };
  const exact = await open(architecture);
  if (exact !== null || architecture === ALPINE_NOARCH) return exact;
  return open(ALPINE_NOARCH);
}

/** `DownloadPackageFile` (alpine.go:203-249): the .apk file by filename +
 *  composite key, with the noarch fallback. */
export async function openAlpinePackageFile(
  d1: D1Database,
  bucket: R2Bucket,
  owner: AlpineOwner,
  branch: string,
  repository: string,
  architecture: string,
  filename: string,
  method: "GET" | "HEAD" = "GET",
): Promise<AlpineDownload | null> {
  void repository;
  // The .apk files live on the package versions (not the internal version —
  // only the INDEX does), so the search spans the owner's alpine packages.
  const openPackageFile = async (arch: string): Promise<{ download: AlpineDownload; versionId: number } | null> => {
    const pair = await drizzle(d1)
      .select({ file: packageFiles, blob: packageBlobs, version: packageVersions })
      .from(packageFiles)
      .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
      .where(
        and(
          eq(packages.type, "alpine"),
          eq(packages.ownerId, owner.id),
          eq(packages.isInternal, false),
          eq(packageFiles.lowerName, filename.toLowerCase()),
          eq(packageFiles.compositeKey, `${branch}|${repository}|${arch}`),
        ),
      )
      .get();
    if (pair === undefined) return null;
    const object = await bucket.get(packageBlobContentKey(pair.blob.hashSha256));
    if (object === null) return null;
    return {
      download: { stream: object.body, size: object.size, filename: pair.file.name, created: pair.file.createdUnix },
      versionId: pair.version.id,
    };
  };
  const pick = async (arch: string): Promise<AlpineDownload | null> => {
    const found = await openPackageFile(arch);
    if (found === null) return null;
    if (method === "GET") await incrementDownloadCounter(d1, found.versionId);
    return found.download;
  };
  const exact = await pick(architecture);
  if (exact !== null || architecture === ALPINE_NOARCH) return exact;
  return pick(ALPINE_NOARCH);
}

/** The WebCrypto self-check the suites run (the real crypto verification of
 *  the .SIGN.RSA entry against the served public key). */
export async function verifyAlpineIndexSignature(
  publicSpki: Uint8Array,
  signature: Uint8Array,
  unsignedArchive: Uint8Array,
): Promise<boolean> {
  return rsaVerify(publicSpki, "SHA-1", signature, unsignedArchive);
}

/**
 * `DeletePackageFile` (alpine.go:251-284): the file by filename + composite
 * key (EXACT architecture — the delete arm has no noarch fallback), the
 * version-if-unreferenced fold, the rebuild rider. Answers `false` for the
 * 404 arm.
 */
export async function deleteAlpinePackageFile(
  d1: D1Database,
  bucket: R2Bucket,
  owner: AlpineOwner,
  branch: string,
  repository: string,
  architecture: string,
  filename: string,
  now?: Date,
): Promise<boolean> {
  const db = drizzle(d1);
  const pairs = await db
    .select({ file: packageFiles })
    .from(packageFiles)
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      and(
        eq(packages.type, "alpine"),
        eq(packages.ownerId, owner.id),
        eq(packages.isInternal, false),
        eq(packageFiles.lowerName, filename.toLowerCase()),
        eq(packageFiles.compositeKey, `${branch}|${repository}|${architecture}`),
      ),
    )
    .all();
  if (pairs.length !== 1) return false;
  const fileId = pairs[0]?.file.id;
  if (fileId === undefined) return false;
  const fileRow = (await db.select().from(packageFiles).where(eq(packageFiles.id, fileId)).get()) ?? null;
  if (fileRow === null) return false;
  await deletePackageFile(d1, fileRow.id);
  const stillReferenced = await hasVersionFileReferences(d1, fileRow.versionId);
  if (!stillReferenced) {
    await deletePackageVersionAndReferences(d1, fileRow.versionId);
  }
  await buildAlpineRepositoryFiles(d1, bucket, owner, branch, repository, architecture, now);
  return true;
}

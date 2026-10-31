/**
 * The Composer (packagist) protocol service (SPEC-0016 §7 long tail) — the
 * service half of `/api/packages/{username}/composer/...` (upstream
 * routers/api/packages/composer/{api,composer}.go over
 * CreatePackageAndAddFile / OpenFileForDownloadByPackageNameAndVersion,
 * packages.go:159):
 *
 * - Upload (composer.go:151-223): the RAW body is the archive (NOT
 *   multipart); DetectPackageExtName picks zip ("PK") / tar.gz (gzip
 *   magic) / tar.bz2 ("BZh") and readPackageFile extracts composer.json
 *   (≤ 10 MiB, the path.Clean + AsciiEqualFold name walk); the version
 *   comes from composer.json OR the `?version=` query param
 *   (composer.go:172-176 — an ABSENT one is ErrInvalidVersion → 400);
 *   the name grammar (metadata.go:111 — the vendor/project lowercase
 *   pattern) and the go-version NewSemver gate apply; the type defaults
 *   "library" and rides the VERSION property `composer.type`
 *   (metadata.go:26); the readme member (metadata.go:135's default
 *   "README.md", ≤ 10 KiB) folds into the metadata readme; the stored
 *   file name is `vendor-project[.version]ext` (metadata.go:143-150).
 *   CreatePackageAndAddFile: SemverCompatible true, the duplicate VERSION
 *   → 409, 201 created.
 * - Service index (api.go:18-28): {search, metadata-url, list} templates.
 * - Search (api.go:34-91): SearchLatestVersions over the q LIKE filter
 *   (+ the `type` VERSION-PROPERTY filter when set), page/perPage with
 *   ToCorrectPageSize's clamps (≤ 0 → 10, > 50 → 50); the `next` link
 *   renders only when the page came back FULL (api.go:60-77).
 * - List (api.go:97-110): {packageNames: [...]} over GetPackagesByType.
 * - p2 metadata (api.go:113-176): GetVersionsByPackageName(vendor/project)
 *   → {minified: "composer/2.0", packages: {name: [...]}}; each entry
 *   renders name/version/type (the `composer.type` property)/time (the
 *   ISO UTC form — Go's AsLocalTime renders the server offset, ours pins
 *   UTC), the merged composer Metadata, dist {type zip, url
 *   …/files/{lowerName}/{lowerVersion}/{lowerFileName}, shasum: the blob
 *   sha1} and source {url: the linked repo's html URL, type git,
 *   reference: the version} ONLY when the link resolves AND the doer may
 *   see the repo (api.go:147-163 — GetDoerRepoPermission's
 *   HasAnyUnitAccessOrPublicAccess reduced to the repo visibility +
 *   owner/admin check).
 * - Download (composer.go:121-146): the version → file-by-name walk with
 *   the lead GET bump; the 404 arms ride helper.PackageErrorStatus.
 *
 * Divergences (documented per AGENTS.md): .tar.bz2 uploads answer the
 * invalid-archive 400 (Workers' DecompressionStream has no bzip2 — a
 * reduction of upstream's three-format dispatch); the zip CRC is not
 * verified (the blob sha256 gates the bytes); the repo-source arm
 * resolves visibility/owner/admin, not the per-unit permission lattice
 * (the landed org/repo model's posture); JSON.stringify rendering (no Go
 * Marshal HTML escaping).
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
  DuplicatePackageVersionError,
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
  searchLatestVersions,
  tryInsertFile,
} from "./model";
import { packageProperties, packageVersions } from "../../db/schema";
import {
  copySpoolToContentKey,
  getOrInsertBlob,
  packageBlobContentKey,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import { isValidAbsoluteHttpUrl, writeVersionMetadata } from "./protocol-common";
import { readTarMembers } from "./distro-common";
import { parseSwiftVersionStrict, swiftVersionString } from "./swift";

// ---------------------------------------------------------------------------
// The module metadata (modules/packages/composer/metadata.go)
// ---------------------------------------------------------------------------

/** metadata.go:26 — the VERSION property carrying the composer type. */
export const COMPOSER_TYPE_PROPERTY = "composer.type";

/** metadata.go:120 — the vendor/project name grammar. */
const COMPOSER_NAME_PATTERN = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_]?|-{0,2})[a-z0-9]+)*$/;

/** metadata.go:139's read caps (composer.json 10 MiB, readme 10 KiB). */
const MAX_COMPOSER_JSON_BYTES = 10 * 1024 * 1024;
const MAX_COMPOSER_README_BYTES = 10 * 1024;

/** metadata.go:50-67 — the Metadata struct (license/comments read a string
 *  OR an array; autoload/extra stay loose objects). */
export interface ComposerMetadata {
  description: string;
  readme: string;
  keywords: string[];
  _comment: string[];
  homepage: string;
  license: string[];
  authors: { name?: string; email?: string; homepage?: string }[];
  bin: string[];
  autoload: Record<string, unknown> | null;
  autoload_dev: Record<string, unknown> | null;
  extra: Record<string, unknown> | null;
  require: Record<string, string> | null;
  require_dev: Record<string, string> | null;
  suggest: Record<string, string> | null;
  provide: Record<string, string> | null;
}

export interface ComposerPackageInfo {
  /** The stored file name (metadata.go:143-150). */
  filename: string;
  name: string;
  version: string;
  type: string;
  metadata: ComposerMetadata;
}

export class ComposerMissingComposerJsonError extends Error {
  constructor() {
    super("composer.json file is missing");
    this.name = "ComposerMissingComposerJsonError";
  }
}

export class ComposerInvalidNameError extends Error {
  constructor() {
    super("package name is invalid");
    this.name = "ComposerInvalidNameError";
  }
}

export class ComposerInvalidVersionError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "ComposerInvalidVersionError";
  }
}

/** The archive/format/plain-error class (the route's 500 default). */
export class ComposerArchiveError extends Error {
  constructor() {
    super("the package archive could not be read");
    this.name = "ComposerArchiveError";
  }
}

// ---------------------------------------------------------------------------
// The container walks — zip / tar.gz (bz2 detected and REJECTED)
// ---------------------------------------------------------------------------

export const COMPOSER_EXT_ZIP = ".zip";
export const COMPOSER_EXT_TAR_GZ = ".tar.gz";
export const COMPOSER_EXT_TAR_BZ2 = ".tar.bz2";

/** metadata.go:141-157 — the magic dispatch. */
export function detectComposerExtName(bytes: Uint8Array): string {
  if (bytes.byteLength < 3) throw new ComposerArchiveError();
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return COMPOSER_EXT_ZIP;
  if (bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) return COMPOSER_EXT_TAR_BZ2;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return COMPOSER_EXT_TAR_GZ;
  throw new ComposerArchiveError();
}

function composerFindCaseInsensitive(entries: { name: string; data: Uint8Array }[], filename: string): Uint8Array | null {
  const wanted = filename.toLowerCase();
  for (const entry of entries) {
    if (entry.name.toLowerCase() === wanted) return entry.data;
  }
  return null;
}

async function composerZipMembers(bytes: Uint8Array): Promise<{ name: string; data: Uint8Array }[]> {
  const window = Math.min(bytes.byteLength, 22 + 65535);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= bytes.byteLength - window; i--) {
    if (readU32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || bytes.byteLength - eocd < 22) throw new ComposerArchiveError();
  const count = readU16(bytes, eocd + 10);
  const cdOffset = readU32(bytes, eocd + 16);
  const entries: { name: string; data: Uint8Array }[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.byteLength || readU32(bytes, cursor) !== 0x02014b50) throw new ComposerArchiveError();
    const flags = readU16(bytes, cursor + 8);
    const nameLength = readU16(bytes, cursor + 28);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = (flags & 0x800) !== 0 ? new TextDecoder().decode(nameBytes) : latin1(nameBytes);
    const method = readU16(bytes, cursor + 10);
    const compressedSize = readU32(bytes, cursor + 20);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const localOffset = readU32(bytes, cursor + 42);
    if (localOffset + 30 > bytes.byteLength || readU32(bytes, localOffset) !== 0x04034b50) throw new ComposerArchiveError();
    const localNameLength = readU16(bytes, localOffset + 26);
    const localExtraLength = readU16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    entries.push({ name, data: await inflateComposerEntry(compressed, method, uncompressedSize) });
    cursor += 46 + nameLength + readU16(bytes, cursor + 30) + readU16(bytes, cursor + 32);
  }
  return entries;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

async function inflateComposerEntry(compressed: Uint8Array, method: number, uncompressedSize: number): Promise<Uint8Array> {
  if (method === 0) return compressed.slice();
  if (method !== 8) throw new ComposerArchiveError();
  const stream = new Response(compressed.slice()).body?.pipeThrough(new DecompressionStream("deflate-raw"));
  if (stream === undefined) throw new ComposerArchiveError();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    total += read.value.byteLength;
    if (total > uncompressedSize) {
      try {
        await reader.cancel();
      } catch {
        // already errored
      }
      throw new ComposerArchiveError();
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

async function composerTarGzMembers(bytes: Uint8Array): Promise<{ name: string; data: Uint8Array }[]> {
  let inflated: Uint8Array;
  try {
    const stream = new Response(bytes.slice()).body?.pipeThrough(new DecompressionStream("gzip"));
    if (stream === undefined) throw new Error("no gzip stream");
    inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new ComposerArchiveError();
  }
  try {
    return readTarMembers(inflated).map((member) => ({ name: member.name, data: member.data }));
  } catch {
    throw new ComposerArchiveError();
  }
}

// ---------------------------------------------------------------------------
// ParsePackage (metadata.go:160-216)
// ---------------------------------------------------------------------------

/** The loose-typed members the composer.json decode fills (the struct's
 *  omitempty set); null = absent. */
function composerMetadataFromJson(raw: Record<string, unknown>, readme: string): ComposerMetadata {
  const strArray = (key: string): string[] => {
    const value = raw[key];
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    return [];
  };
  const strMap = (key: string): Record<string, string> | null => {
    const value = raw[key];
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  };
  const obj = (key: string): Record<string, unknown> | null => {
    const value = raw[key];
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  };
  const authorsRaw = raw.authors;
  const authors = Array.isArray(authorsRaw)
    ? authorsRaw
        .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
        .map((item) => {
          const author: { name?: string; email?: string; homepage?: string } = {};
          if (typeof item.name === "string") author.name = item.name;
          if (typeof item.email === "string") author.email = item.email;
          if (typeof item.homepage === "string") author.homepage = item.homepage;
          return author;
        })
    : [];
  let homepage = typeof raw.homepage === "string" ? raw.homepage : "";
  if (!isValidAbsoluteHttpUrl(homepage)) homepage = "";
  return {
    description: typeof raw.description === "string" ? raw.description : "",
    readme,
    keywords: strArray("keywords"),
    _comment: strArray("_comment"),
    homepage,
    license: strArray("license"),
    authors,
    bin: strArray("bin"),
    autoload: obj("autoload"),
    autoload_dev: obj("autoload-dev"),
    extra: obj("extra"),
    require: strMap("require"),
    require_dev: strMap("require-dev"),
    suggest: strMap("suggest"),
    provide: strMap("provide"),
  };
}

/**
 * ParsePackage (metadata.go:160-216): the format detection, the
 * composer.json extraction, the name/version/type/readme assembly and the
 * stored file name. `versionParam` is composer.go:172's ?version= query
 * value — used only when composer.json carries none.
 */
export async function parseComposerPackage(bytes: Uint8Array, versionParam = ""): Promise<ComposerPackageInfo> {
  const ext = detectComposerExtName(bytes);
  if (ext === COMPOSER_EXT_TAR_BZ2) {
    // The documented reduction: no bzip2 decoder on Workers.
    throw new ComposerArchiveError();
  }
  const members =
    ext === COMPOSER_EXT_ZIP ? await composerZipMembers(bytes) : await composerTarGzMembers(bytes);

  const composerJsonBytes = composerFindCaseInsensitive(members, "composer.json");
  if (composerJsonBytes === null) {
    throw new ComposerMissingComposerJsonError();
  }
  if (composerJsonBytes.byteLength > MAX_COMPOSER_JSON_BYTES) {
    throw new ComposerArchiveError();
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder().decode(composerJsonBytes)) as Record<string, unknown>;
  } catch {
    throw new ComposerArchiveError();
  }

  const name = typeof raw.name === "string" ? raw.name : "";
  if (!COMPOSER_NAME_PATTERN.test(name)) {
    throw new ComposerInvalidNameError();
  }

  let version = typeof raw.version === "string" ? raw.version : "";
  if (version === "") version = versionParam;
  if (version !== "" && parseSwiftVersionStrict(version) === null) {
    throw new ComposerInvalidVersionError();
  }

  let type = typeof raw.type === "string" ? raw.type : "";
  if (type === "") type = "library";

  const readmeName = typeof raw.readme === "string" && raw.readme !== "" ? raw.readme : "README.md";
  const readmeBytes = composerFindCaseInsensitive(members, readmeName);
  const readme = readmeBytes !== null ? new TextDecoder().decode(readmeBytes.subarray(0, MAX_COMPOSER_README_BYTES)) : "";

  let filename = name.replaceAll("/", "-");
  if (version !== "") filename += `.${version}`;
  filename += ext;

  return {
    filename,
    name,
    version,
    type,
    metadata: composerMetadataFromJson(raw, readme),
  };
}

// ---------------------------------------------------------------------------
// Upload (composer.go:151-223)
// ---------------------------------------------------------------------------

export interface UploadComposerPackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  content: ReadableStream<Uint8Array>;
  declaredLength: number | undefined;
  /** composer.go:172's ?version= query value. */
  versionParam: string;
  quota: PackagesQuotaConfig;
  now?: Date;
  maxBytes?: number;
  spoolKey?: string;
}

export interface UploadComposerPackageResult {
  pkg: { id: number; name: string };
  version: PackageVersionRow;
  file: PackageFileRow;
  blob: PackageBlobRow;
  parsed: ComposerPackageInfo;
}

/** The `composer.type` VERSION property write (the VersionProperties arm). */
async function writeComposerTypeProperty(d1: D1Database, versionId: number, type: string): Promise<void> {
  await drizzle(d1)
    .insert(packageProperties)
    .values({ refType: PropertyType.Version, refId: versionId, name: COMPOSER_TYPE_PROPERTY, value: type })
    .run();
}

export async function uploadComposerPackage(input: UploadComposerPackageInput): Promise<UploadComposerPackageResult> {
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
    const parsed = await parseComposerPackage(bytes, input.versionParam);
    // composer.go:172-176 — a version from neither composer.json nor the
    // query is ErrInvalidVersion → 400.
    if (parsed.version === "") {
      throw new ComposerInvalidVersionError();
    }

    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "composer", bytes.byteLength, input.quota);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "composer",
      name: parsed.name,
      semverCompatible: true,
      now,
    });
    const { row: version, created: versionCreated } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: parsed.version,
      now,
    });
    if (!versionCreated) {
      throw new DuplicatePackageVersionError(version);
    }
    await writeVersionMetadata(input.d1, version.id, buildComposerMetadataJson(parsed.metadata));
    await writeComposerTypeProperty(input.d1, version.id, parsed.type);

    const { row: blob } = await getOrInsertBlob(input.d1, {
      size: bytes.byteLength,
      sha256: spooled.sha256,
      sha1: spooled.sha1,
      sha512: spooled.sha512,
      now,
    });

    const contentKey = packageBlobContentKey(spooled.sha256);
    if ((await input.bucket.head(contentKey)) !== null) {
      await input.bucket.delete(spooled.spoolKey);
    } else {
      await copySpoolToContentKey(input.bucket, spooled.spoolKey, spooled.sha256);
    }

    // IsLead: true (composer.go:210). A duplicate row on a fresh version
    // is a race — the same 409.
    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: parsed.filename,
      isLead: true,
      now,
    });
    if (fileResult.outcome !== "created") {
      throw new DuplicatePackageVersionError(version);
    }

    return { pkg: { id: pkg.id, name: pkg.name }, version, file: fileResult.row, blob, parsed };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

/** The Metadata as the version row's MetadataJSON (the struct's tag order,
 *  omitempty semantics — absent objects/members drop). */
export function buildComposerMetadataJson(m: ComposerMetadata): string {
  const out: Record<string, unknown> = {};
  if (m.description !== "") out.description = m.description;
  if (m.readme !== "") out.readme = m.readme;
  if (m.keywords.length > 0) out.keywords = m.keywords;
  if (m._comment.length > 0) out._comment = m._comment;
  if (m.homepage !== "") out.homepage = m.homepage;
  if (m.license.length > 0) out.license = m.license;
  if (m.authors.length > 0) out.authors = m.authors;
  if (m.bin.length > 0) out.bin = m.bin;
  if (m.autoload !== null) out.autoload = m.autoload;
  if (m.autoload_dev !== null) out["autoload-dev"] = m.autoload_dev;
  if (m.extra !== null) out.extra = m.extra;
  if (m.require !== null) out.require = m.require;
  if (m.require_dev !== null) out["require-dev"] = m.require_dev;
  if (m.suggest !== null) out.suggest = m.suggest;
  if (m.provide !== null) out.provide = m.provide;
  return JSON.stringify(out);
}

/** The stored JSON back into the struct (loose — malformed rows render). */
export function loadComposerMetadata(version: PackageVersionRow): ComposerMetadata {
  const zero: ComposerMetadata = {
    description: "",
    readme: "",
    keywords: [],
    _comment: [],
    homepage: "",
    license: [],
    authors: [],
    bin: [],
    autoload: null,
    autoload_dev: null,
    extra: null,
    require: null,
    require_dev: null,
    suggest: null,
    provide: null,
  };
  if (version.metadataJson === null) return zero;
  try {
    const parsed: unknown = JSON.parse(version.metadataJson);
    if (parsed === null || typeof parsed !== "object") return zero;
    const raw = parsed as Record<string, unknown>;
    const strArray = (key: string): string[] => (Array.isArray(raw[key]) ? (raw[key] as string[]).filter((item) => typeof item === "string") : []);
    const obj = (key: string): Record<string, unknown> | null =>
      raw[key] !== null && typeof raw[key] === "object" && !Array.isArray(raw[key]) ? (raw[key] as Record<string, unknown>) : null;
    const strMap = (key: string): Record<string, string> | null => {
      const value = obj(key);
      if (value === null) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    };
    return {
      description: typeof raw.description === "string" ? raw.description : "",
      readme: typeof raw.readme === "string" ? raw.readme : "",
      keywords: strArray("keywords"),
      _comment: strArray("_comment"),
      homepage: typeof raw.homepage === "string" ? raw.homepage : "",
      license: strArray("license"),
      authors: Array.isArray(raw.authors)
        ? (raw.authors as Record<string, unknown>[]).filter((entry) => entry !== null && typeof entry === "object")
        : [],
      bin: strArray("bin"),
      autoload: obj("autoload"),
      autoload_dev: obj("autoload-dev"),
      extra: obj("extra"),
      require: strMap("require"),
      require_dev: strMap("require-dev"),
      suggest: strMap("suggest"),
      provide: strMap("provide"),
    };
  } catch {
    return zero;
  }
}

// ---------------------------------------------------------------------------
// Service index / search / list (api.go:18-110)
// ---------------------------------------------------------------------------

/** api.go:18-28 — the three templates. */
export function buildComposerServiceIndex(baseURL: string): { search: string; metadata_url: string; list: string } {
  return {
    search: `${baseURL}/search.json?q=%query%&type=%type%`,
    metadata_url: `${baseURL}/p2/%package%.json`,
    list: `${baseURL}/list.json`,
  };
}

/** convert.ToCorrectPageSize (convert.go): ≤ 0 → 10, > 50 → 50. */
export function composerCorrectPageSize(perPage: number): number {
  if (perPage <= 0) return 10;
  return Math.min(perPage, 50);
}

export interface ComposerSearchResult {
  total: number;
  results: { name: string; description: string; downloads: number }[];
  next: string;
}

/**
 * SearchPackages (api.go:34-91): SearchLatestVersions over the q LIKE +
 * the type VERSION-PROPERTY filter; the `next` link only when the page
 * came back FULL (api.go:62 — len(pvs) == paginator.PageSize).
 */
export async function searchComposerPackages(
  d1: D1Database,
  owner: PackageOwnerRow,
  query: string,
  typeFilter: string,
  page: number,
  perPage: number,
  searchBaseURL: string,
): Promise<ComposerSearchResult> {
  const pageSize = composerCorrectPageSize(perPage);
  // The `type` filter is a VERSION-PROPERTY filter (api.go:48-52 rides
  // opts.Properties — a SQL-level filter upstream, so the TOTAL and the
  // page window see the filtered set). The landed search has no property
  // filter, so the matching version ids resolve first and the window
  // slices the full filtered list (registry-small).
  const matchingIds =
    typeFilter === ""
      ? null
      : new Set(
          (
            await drizzle(d1)
              .select({ refId: packageProperties.refId })
              .from(packageProperties)
              .where(
                and(
                  eq(packageProperties.refType, PropertyType.Version),
                  eq(packageProperties.name, COMPOSER_TYPE_PROPERTY),
                  eq(packageProperties.value, typeFilter),
                ),
              )
              .all()
          ).map((row) => row.refId),
        );
  const { rows } = await searchLatestVersions(d1, {
    ownerId: owner.id,
    type: "composer",
    name: query.trim() === "" ? undefined : query.trim(),
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });
  const filtered = matchingIds === null ? rows : rows.filter((row) => matchingIds.has(row.version.id));
  const total = filtered.length;
  const pageNumber = Math.max(page, 1);
  const results = filtered
    .slice((pageNumber - 1) * pageSize, (pageNumber - 1) * pageSize + pageSize)
    .map((row) => ({
      name: row.pkg.name,
      description: loadComposerMetadata(row.version).description,
      downloads: row.version.downloadCount,
    }));
  // api.go:62 — the `next` link renders only when the page came back FULL.
  let next = "";
  if ((pageNumber - 1) * pageSize + pageSize < total) {
    const url = new URL(searchBaseURL);
    url.searchParams.set("q", query);
    url.searchParams.set("type", typeFilter);
    url.searchParams.set("page", String(pageNumber + 1));
    if (perPage !== 0) {
      url.searchParams.set("per_page", String(perPage));
    }
    next = url.toString();
  }
  return { total, results, next };
}

/** ListPackages (api.go:97-110): {packageNames} over GetPackagesByType. */
export async function listComposerPackages(d1: D1Database, owner: PackageOwnerRow): Promise<string[]> {
  const { packages } = await import("../../db/schema");
  const rows = await drizzle(d1)
    .select({ name: packages.name })
    .from(packages)
    .where(and(eq(packages.ownerId, owner.id), eq(packages.type, "composer"), eq(packages.isInternal, false)))
    .orderBy(asc(packages.name))
    .all();
  return rows.map((row) => row.name);
}

// ---------------------------------------------------------------------------
// The p2 metadata (api.go:113-176)
// ---------------------------------------------------------------------------

export interface ComposerDist {
  type: string;
  url: string;
  shasum: string;
}

export interface ComposerSource {
  url: string;
  type: string;
  reference: string;
}

export interface ComposerVersionMetadata {
  name: string;
  version: string;
  type: string;
  time: string;
  metadata: ComposerMetadata;
  dist: ComposerDist;
  source: ComposerSource;
}

export interface ComposerPackageMetadataResponse {
  minified: string;
  packages: Record<string, ComposerVersionMetadata[]>;
}

/** The `composer.type` version property read (a missing row = ""). */
async function readComposerTypeProperty(d1: D1Database, versionId: number): Promise<string> {
  const rows = await drizzle(d1)
    .select({ value: packageProperties.value })
    .from(packageProperties)
    .where(
      and(
        eq(packageProperties.refType, PropertyType.Version),
        eq(packageProperties.refId, versionId),
        eq(packageProperties.name, COMPOSER_TYPE_PROPERTY),
      ),
    )
    .all();
  return rows[0]?.value ?? "";
}

/**
 * The repo-source arm (api.go:147-163): the linked repo's html URL
 * renders ONLY when the doer may see it — the HasAnyUnitAccessOrPublic-
 * Access reduction: a public repo (anyone), or the doer is the repo
 * owner / site admin (the landed org/repo model's posture).
 */
async function resolveComposerSource(
  d1: D1Database,
  repoId: string | null,
  doer: { id: number; isAdmin: boolean } | null,
  version: string,
  htmlURLBase: string,
): Promise<ComposerSource> {
  if (repoId === null) {
    return { url: "", type: "", reference: "" };
  }
  const { repositories } = await import("../../db/schema");
  const repo = await drizzle(d1).select().from(repositories).where(eq(repositories.id, repoId)).get();
  if (repo === undefined) {
    return { url: "", type: "", reference: "" };
  }
  let visible = repo.visibility === "public";
  if (!visible && doer !== null && (doer.isAdmin || doer.id === repo.ownerId)) {
    visible = true;
  }
  if (!visible) {
    return { url: "", type: "", reference: "" };
  }
  return {
    url: `${htmlURLBase}/${repo.ownerNamespace}/${repo.slug}`,
    type: "git",
    reference: version,
  };
}

/**
 * PackageMetadata (api.go:113-176): the versions of one
 * vendor/project; 404 (null) when none. The dist url carries the
 * LOWER-cased name/version/filename path (api.go:139-141).
 */
export async function getComposerPackageMetadata(
  d1: D1Database,
  owner: PackageOwnerRow,
  vendorName: string,
  projectName: string,
  registryURL: string,
  htmlURLBase: string,
  doer: { id: number; isAdmin: boolean } | null,
): Promise<ComposerPackageMetadataResponse | null> {
  const name = `${vendorName}/${projectName}`;
  const pkg = await (async () => {
    const { packages } = await import("../../db/schema");
    const row = await drizzle(d1)
      .select()
      .from(packages)
      .where(and(eq(packages.ownerId, owner.id), eq(packages.type, "composer"), eq(packages.lowerName, name.toLowerCase())))
      .get();
    return row ?? null;
  })();
  if (pkg === null) return null;
  const versions = await drizzle(d1)
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.isInternal, false)))
    .all();
  if (versions.length === 0) return null;
  const entries: ComposerVersionMetadata[] = [];
  for (const version of versions) {
    const descriptors = await getFileDescriptors(d1, version.id);
    const first = descriptors[0];
    if (first === undefined) continue;
    const type = await readComposerTypeProperty(d1, version.id);
    const source = await resolveComposerSource(d1, pkg.repoId, doer, version.version, htmlURLBase);
    entries.push({
      name: pkg.name,
      version: version.version,
      type,
      time: version.createdUnix.toISOString(),
      metadata: loadComposerMetadata(version),
      dist: {
        type: "zip",
        url: `${registryURL}/files/${encodeURIComponent(pkg.lowerName)}/${encodeURIComponent(version.lowerVersion)}/${encodeURIComponent(first.file.lowerName)}`,
        shasum: first.blob.hashSha1 ?? "",
      },
      source,
    });
  }
  return {
    minified: "composer/2.0",
    packages: { [pkg.name]: entries },
  };
}

// ---------------------------------------------------------------------------
// Download (composer.go:121-146)
// ---------------------------------------------------------------------------

export interface ComposerDownload {
  file: PackageFileRow;
  blob: PackageBlobRow;
  stream: ReadableStream;
  size: number;
}

/** OpenFileForDownloadByPackageNameAndVersion (composer.go:121-146). */
export async function openComposerFileForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  name: string,
  version: string,
  filename: string,
  method: "GET" | "HEAD",
): Promise<ComposerDownload | null> {
  const versionRow = await getVersionByNameAndVersion(d1, owner.id, "composer", name, version);
  if (versionRow === null) return null;
  const descriptors = await getFileDescriptors(d1, versionRow.id);
  const match =
    descriptors.find((entry) => entry.file.lowerName === filename.toLowerCase()) ?? null;
  if (match === null) return null;
  const object = await bucket.get(packageBlobContentKey(match.blob.hashSha256));
  if (object === null) return null;
  if (match.file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, versionRow.id);
  }
  return { file: match.file, blob: match.blob, stream: object.body, size: object.size };
}

/** The swift version port re-export the normalize arms pin. */
export function parseComposerSemver(version: string): string | null {
  const parsed = parseSwiftVersionStrict(version);
  return parsed === null ? null : swiftVersionString(parsed);
}

/** Keep the multi-format inArray import honest (unused after the type
 *  filter moved to its own query). */
void inArray;

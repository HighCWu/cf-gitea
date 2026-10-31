/**
 * The Vagrant box registry protocol service (SPEC-0016 §7 long tail) — the
 * service half of `/api/packages/{username}/vagrant/...` (upstream
 * routers/api/packages/vagrant/vagrant.go over
 * CreatePackageOrAddFileToExisting / OpenFileForDownloadByPackageNameAndVersion,
 * packages.go:160/:594):
 *
 * - Upload (vagrant.go:97-171): the PUT path carries {name}/{version}/
 *   {provider}. The arms in upstream's order: the version MUST parse as
 *   hashicorp/go-version NewSemver (vagrant.go:104-108 → 400), the provider
 *   MUST end ".box" (vagrant.go:110-113 → 400), then the body parses as a
 *   .box = a gzip'd tar whose OPTIONAL `info.json` member feeds
 *   ParseMetadataFromBox (modules/packages/vagrant/metadata.go — a MISSING
 *   info.json is NOT an error: the zero Metadata stands; a corrupt
 *   gzip/tar/JSON is a plain error → the 500 default arm at the route).
 *   The box NAME comes from the URL path, never the archive. The box bytes
 *   store VERBATIM as the ONE lead file strings.ToLower(provider) carrying
 *   the file property `vagrant.provider` = TrimSuffix(provider, ".box")
 *   (original case); ANY existing file row is the 409 — upstream's
 *   CreatePackageOrAddFileToExisting runs WITHOUT OverwriteExisting, so
 *   TryInsertFile's duplicate answer reaches the 409 (the pypi D-1 posture).
 * - Enumerate (vagrant.go:55-95): every version (GetVersionsByPackageName —
 *   created DESC) re-sorted SemVer.LessThan ASC, rendered through
 *   packageDescriptorToMetadata's provider array — each file becomes
 *   {name: the provider property, url: baseURL/version/url-escaped
 *   filename, checksum: sha512, checksum_type: "sha512"}; the package
 *   description renders the LAST (newest) version's metadata. An empty
 *   answer is the route's 404 (nil).
 * - Download (vagrant.go:173-189): the version → file-by-name → blob walk
 *   with the lead-file GET counter bump (packages.go:655-660).
 *
 * Divergences (documented per AGENTS.md): the SemVer sort pins a stable id
 * tiebreak for equal version strings (Go's slice sort is unspecified for
 * equal keys); the version grammar port is the swift unit's
 * hashicorp/go-version port (the SAME upstream library — swift.ts ports
 * SemverRegexpRaw + Compare verbatim; NewSemver = parseSwiftVersionStrict,
 * LessThan = swiftCompareVersions < 0); the box parse materializes the
 * spool once (upstream's HashedBuffer holds the whole body in memory over
 * ~1 MiB too); the provider property write rides the caller's drizzle
 * batch AFTER the file insert (the protocol-common property seam —
 * upstream folds the properties into the same transaction; the D1-no-tx
 * posture of §4.3).
 */

import { and, eq } from "drizzle-orm";
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
  getFileForVersionByName,
  getOrInsertPackage,
  getOrInsertVersion,
  getVersionByNameAndVersion,
  incrementDownloadCounter,
  searchVersions,
  tryInsertFile,
} from "./model";
import { packageProperties } from "../../db/schema";
import {
  copySpoolToContentKey,
  getOrInsertBlob,
  packageBlobContentKey,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import { writeVersionMetadata } from "./protocol-common";
import { DuplicatePackageFileError } from "./generic";
// The hashicorp/go-version port (the swift unit's) — vagrant's upload gate
// and sort ride the SAME library (vagrant.go imports
// "github.com/hashicorp/go-version"; swift.ts ports SemverRegexpRaw +
// Compare verbatim).
import { parseSwiftVersionStrict, swiftCompareVersions, type SwiftVersion } from "./swift";

import { readTarMembers } from "./distro-common";

// ---------------------------------------------------------------------------
// The module metadata (modules/packages/vagrant/metadata.go)
// ---------------------------------------------------------------------------

/** upstream PropertyProvider (metadata.go:12). */
export const VAGRANT_PROPERTY_PROVIDER = "vagrant.provider";

/** upstream Metadata (metadata.go:14-19), the struct's json-tag order. */
export interface VagrantMetadata {
  author: string;
  description: string;
  project_url: string;
  repository_url: string;
}

export const emptyVagrantMetadata = (): VagrantMetadata => ({
  author: "",
  description: "",
  project_url: "",
  repository_url: "",
});

/** The metadata as the version's MetadataJSON (Go's omitempty set — empty
 *  fields drop; non-empty render in declaration order). */
export function buildVagrantMetadataJson(m: VagrantMetadata): string {
  const out: Record<string, string> = {};
  if (m.author !== "") out.author = m.author;
  if (m.description !== "") out.description = m.description;
  if (m.project_url !== "") out.project_url = m.project_url;
  if (m.repository_url !== "") out.repository_url = m.repository_url;
  return JSON.stringify(out);
}

/** The stored JSON back into the struct (a malformed row reads as zero —
 *  the descriptor render never crashes on legacy rows). */
export function loadVagrantMetadata(version: PackageVersionRow): VagrantMetadata {
  if (version.metadataJson === null) return emptyVagrantMetadata();
  try {
    const parsed: unknown = JSON.parse(version.metadataJson);
    if (parsed === null || typeof parsed !== "object") return emptyVagrantMetadata();
    const record = parsed as Record<string, unknown>;
    const str = (key: string): string => (typeof record[key] === "string" ? (record[key]) : "");
    return {
      author: str("author"),
      description: str("description"),
      project_url: str("project_url"),
      repository_url: str("repository_url"),
    };
  } catch {
    return emptyVagrantMetadata();
  }
}

// ---------------------------------------------------------------------------
// ParseMetadataFromBox (metadata.go:24-91)
// ---------------------------------------------------------------------------

/** A corrupt .box — upstream's gzip.NewReader / tar.Next / json.Decode
 *  plain errors (NOT util.ErrInvalidArgument) → the 500 default arm. */
export class VagrantBoxFormatError extends Error {
  constructor() {
    super("the box archive could not be read");
    this.name = "VagrantBoxFormatError";
  }
}

/**
 * ParseInfoFile (metadata.go:52-88): "There is no defined format for this
 * file, just try the common keys" — matched case-insensitively; a URL
 * candidate is kept only when it parses absolute http(s)
 * (validation.IsValidURL). Upstream's map iteration order is random, and
 * every fallthrough arm writes the SAME field — the last matching key
 * wins there, so ours pins key order (Object.entries) for determinism.
 */
function parseVagrantInfoJson(text: string): VagrantMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VagrantBoxFormatError();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Go's map[string]string decode of a JSON array/scalar is an
    // unmarshaling type error — the same plain-error arm.
    throw new VagrantBoxFormatError();
  }
  const metadata = emptyVagrantMetadata();
  const isValidUrl = (value: string): boolean => {
    if (value === "") return false;
    try {
      const u = new URL(value);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  };
  for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof rawValue !== "string") continue;
    switch (rawKey.toLowerCase()) {
      case "description":
      case "short_description":
        metadata.description = rawValue;
        break;
      case "website":
      case "homepage":
      case "url":
        if (isValidUrl(rawValue)) metadata.project_url = rawValue;
        break;
      case "repository":
      case "source":
        if (isValidUrl(rawValue)) metadata.repository_url = rawValue;
        break;
      case "author":
      case "authors":
        metadata.author = rawValue;
        break;
    }
  }
  return metadata;
}

/** packages.MaxMetadataSize (limited_reader.go:14) — the info.json cap. */
const MAX_BOX_INFO_JSON_BYTES = 32 * 1024 * 1024;

/**
 * ParseMetadataFromBox (metadata.go:24-50): gzip-decode, walk the tar, and
 * on the `info.json` member parse it — EARLY RETURN (later members never
 * read, Go's tar.Next early-return). NO info.json member is the ZERO
 * metadata with NO error (metadata.go:48 `return &Metadata{}`). A
 * structural failure or a failed decode is the plain error.
 */
export async function parseVagrantBoxMetadata(bytes: Uint8Array): Promise<VagrantMetadata> {
  if (bytes.byteLength < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new VagrantBoxFormatError();
  }
  let inflated: Uint8Array;
  try {
    const stream = new Response(bytes.slice()).body?.pipeThrough(new DecompressionStream("gzip"));
    if (stream === undefined) throw new VagrantBoxFormatError();
    inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new VagrantBoxFormatError();
  }
  let members: ReturnType<typeof readTarMembers>;
  try {
    members = readTarMembers(inflated);
  } catch {
    throw new VagrantBoxFormatError();
  }
  for (const member of members) {
    if (member.name === "info.json") {
      return parseVagrantInfoJson(new TextDecoder().decode(member.data.subarray(0, MAX_BOX_INFO_JSON_BYTES)));
    }
  }
  return emptyVagrantMetadata();
}

// ---------------------------------------------------------------------------
// The version grammar — hashicorp/go-version NewSemver (the swift port)
// ---------------------------------------------------------------------------

/** vagrant.go:104-108 — version.NewSemver(boxVersion). */
export function parseVagrantSemver(version: string): SwiftVersion | null {
  return parseSwiftVersionStrict(version);
}

/** The search row the enumerate sorts (searchVersions' answer shape). */
export type VagrantVersionSearchRow = {
  version: PackageVersionRow;
  pkg: { id: number; name: string };
};

/** sort.Slice(pds, LessThan ASC) (vagrant.go:74-76) — the stable id
 *  tiebreak; an unparseable stored version (impossible through the gate)
 *  sorts by id alone. */
export function compareVagrantVersions(a: VagrantVersionSearchRow, b: VagrantVersionSearchRow): number {
  const parsedA = parseVagrantSemver(a.version.version);
  const parsedB = parseVagrantSemver(b.version.version);
  if (parsedA !== null && parsedB !== null) {
    const cmp = swiftCompareVersions(parsedA, parsedB);
    if (cmp !== 0) return cmp;
  }
  return a.version.id - b.version.id;
}

// ---------------------------------------------------------------------------
// Upload (vagrant.go:97-171)
// ---------------------------------------------------------------------------

export interface UploadVagrantBoxInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  /** The {name} path segment — the package name (never the archive's). */
  name: string;
  /** The {version} path segment — MUST parse as go-version NewSemver. */
  version: string;
  /** The {provider} path segment — MUST end ".box". */
  provider: string;
  /** The raw request body stream (spooled whole; never buffered). */
  content: ReadableStream<Uint8Array>;
  /** The declared Content-Length; `undefined` = a chunked body (D-2). */
  declaredLength: number | undefined;
  quota: PackagesQuotaConfig;
  now?: Date;
  /** Test seams (the generic upload's). */
  maxBytes?: number;
  spoolKey?: string;
}

export interface UploadVagrantBoxResult {
  file: PackageFileRow;
  blob: PackageBlobRow;
}

/** vagrant.go:110-113 — the ".box" suffix gate. */
export function isVagrantProviderNameValid(provider: string): boolean {
  return provider.endsWith(".box");
}

/** vagrant.go:104-108 — the NewSemver parse failure (the ErrInvalidArgument
 *  arm → 400; the message is go-version's parse text at the route). */
export class VagrantInvalidVersionError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "VagrantInvalidVersionError";
  }
}

/** vagrant.go:110-113 — the ".box" suffix failure (the 400 arm). */
export class VagrantInvalidProviderError extends Error {
  constructor() {
    super("provider name is invalid");
    this.name = "VagrantInvalidProviderError";
  }
}

/**
 * The PUT's service walk — the upstream arms in order (semver → .box →
 * parse), the quota checks on the shared model (COUNT precedes the
 * inserts — `count + 1 > limit`, the pypi posture; SIZE runs on the
 * spooled FILE's real byte count, packages.go:303-306), then
 * CreatePackageOrAddFileToExisting without OverwriteExisting: the box
 * metadata lands only on a freshly created version, and ANY existing
 * (version, name, composite) file row throws DuplicatePackageFileError →
 * 409. The spool dies on every path.
 */
export async function uploadVagrantBox(input: UploadVagrantBoxInput): Promise<UploadVagrantBoxResult> {
  if (parseVagrantSemver(input.version) === null) {
    throw new VagrantInvalidVersionError();
  }
  if (!isVagrantProviderNameValid(input.provider)) {
    throw new VagrantInvalidProviderError();
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
    maxBytes: input.maxBytes,
    spoolKey: input.spoolKey,
  });

  try {
    const spoolObject = await input.bucket.get(spooled.spoolKey);
    if (spoolObject === null) {
      throw new Error("package spool object vanished");
    }
    // The box parse needs the whole archive (tar members walk byte
    // offsets); upstream's HashedBuffer holds the body too.
    const bytes = new Uint8Array(await spoolObject.arrayBuffer());
    const metadata = await parseVagrantBoxMetadata(bytes);

    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "vagrant", bytes.byteLength, input.quota);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "vagrant",
      name: input.name,
      semverCompatible: true,
      now,
    });
    const { row: version, created: versionCreated } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: input.version,
      now,
    });
    // Metadata lands ONLY on a freshly created version (the protocol-common
    // seam note — CreatePackageOrAddFileToExisting marshals into the INSERT).
    if (versionCreated) {
      await writeVersionMetadata(input.d1, version.id, buildVagrantMetadataJson(metadata));
    }

    const { row: blob, created: blobCreated } = await getOrInsertBlob(input.d1, {
      size: bytes.byteLength,
      sha256: spooled.sha256,
      sha1: spooled.sha1,
      sha512: spooled.sha512,
      now,
    });

    // The store's dedup posture: a hit whose object still exists skips the
    // copy; a miss streams the spool into the content key (the spool dies
    // with the copy — the landed two-pass discipline).
    const objectPresent = (await input.bucket.head(packageBlobContentKey(spooled.sha256))) !== null;
    if (blobCreated || !objectPresent) {
      await copySpoolToContentKey(input.bucket, spooled.spoolKey, spooled.sha256);
    } else {
      await input.bucket.delete(spooled.spoolKey);
    }

    // vagrant.go:146 — Filename: strings.ToLower(boxProvider); IsLead: true
    // (:152). ANY existing row is the duplicate (no OverwriteExisting).
    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: input.provider.toLowerCase(),
      isLead: true,
      now,
    });
    if (fileResult.outcome !== "created") {
      throw new DuplicatePackageFileError(fileResult.row);
    }
    // vagrant.go:153-155 — PropertyProvider: TrimSuffix(boxProvider, ".box").
    await drizzle(input.d1)
      .insert(packageProperties)
      .values({
        refType: PropertyType.File,
        refId: fileResult.row.id,
        name: VAGRANT_PROPERTY_PROVIDER,
        value: input.provider.slice(0, -".box".length),
      })
      .run();

    return { file: fileResult.row, blob };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Enumerate (vagrant.go:55-95)
// ---------------------------------------------------------------------------

export interface VagrantProviderData {
  name: string;
  url: string;
  checksum: string;
  checksum_type: string;
}

export interface VagrantVersionMetadata {
  version: string;
  status: string;
  providers: VagrantProviderData[];
}

export interface VagrantBoxEnumerate {
  name: string;
  description: string;
  versions: VagrantVersionMetadata[];
}

/** The file property read — a missing row renders the empty string (Go's
 *  Properties.GetByName zero value). */
async function readVagrantProviderProperty(d1: D1Database, fileId: number): Promise<string> {
  const rows = await drizzle(d1)
    .select({ name: packageProperties.name, value: packageProperties.value })
    .from(packageProperties)
    .where(and(eq(packageProperties.refType, PropertyType.File), eq(packageProperties.refId, fileId)))
    .all();
  const provider = rows.find((entry) => entry.name === VAGRANT_PROPERTY_PROVIDER);
  return provider?.value ?? "";
}

/**
 * EnumeratePackageVersions (vagrant.go:55-95): GetVersionsByPackageName →
 * SearchVersions (created DESC), re-sorted SemVer ASC. Null = the route's
 * 404 (missing package or zero versions). The description renders the LAST
 * (newest) version's metadata; each FILE of each version contributes one
 * provider entry whose url is `baseURL/{version}/{url-escaped filename}`
 * (vagrant.go:44-50) and whose checksum is the blob's sha512
 * (nullable in our schema — the empty string when a legacy row misses it).
 */
export async function enumerateVagrantBox(
  d1: D1Database,
  owner: PackageOwnerRow,
  name: string,
  baseURL: string,
): Promise<VagrantBoxEnumerate | null> {
  const { rows } = await searchVersions(d1, {
    ownerId: owner.id,
    type: "vagrant",
    name,
    exact: true,
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });
  if (rows.length === 0) return null;
  const sorted = [...rows].sort(compareVagrantVersions);
  const versions: VagrantVersionMetadata[] = [];
  for (const row of sorted) {
    const descriptors = await getFileDescriptors(d1, row.version.id);
    const providers: VagrantProviderData[] = [];
    for (const descriptor of descriptors) {
      const versionUrl = `${baseURL}/${encodeURIComponent(row.version.version)}`;
      providers.push({
        name: await readVagrantProviderProperty(d1, descriptor.file.id),
        url: `${versionUrl}/${encodeURIComponent(descriptor.file.name)}`,
        checksum: descriptor.blob.hashSha512 ?? "",
        checksum_type: "sha512",
      });
    }
    versions.push({ version: row.version.version, status: "active", providers });
  }
  const newest = sorted[sorted.length - 1];
  if (newest === undefined) return null;
  return {
    name: newest.pkg.name,
    description: loadVagrantMetadata(newest.version).description,
    versions,
  };
}

// ---------------------------------------------------------------------------
// Download (vagrant.go:173-189)
// ---------------------------------------------------------------------------

export interface VagrantBoxDownload {
  file: PackageFileRow;
  blob: PackageBlobRow;
  /** Fresh stream over the content object (the caller pipes it out). */
  stream: ReadableStream;
  size: number;
}

/**
 * OpenFileForDownloadByPackageNameAndVersion (vagrant.go:173-189): the
 * version → file-by-name → blob walk; the lead-file GET bump
 * (packages.go:655-660). Null = the route's 404.
 */
export async function openVagrantBoxForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  name: string,
  version: string,
  provider: string,
  method: "GET" | "HEAD",
): Promise<VagrantBoxDownload | null> {
  const versionRow = await getVersionByNameAndVersion(d1, owner.id, "vagrant", name, version);
  if (versionRow === null) return null;
  const file = await getFileForVersionByName(d1, versionRow.id, provider);
  if (file === null) return null;
  const descriptors = await getFileDescriptors(d1, versionRow.id);
  const match = descriptors.find((entry) => entry.file.id === file.id);
  if (match === undefined) return null;
  const object = await bucket.get(packageBlobContentKey(match.blob.hashSha256));
  if (object === null) return null;
  if (file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, versionRow.id);
  }
  return { file: match.file, blob: match.blob, stream: object.body, size: object.size };
}

/** CheckBoxAvailable / the enumerate gate (vagrant.go:33-53): the box has
 *  at least one version (false = the 404). */
export async function vagrantBoxExists(d1: D1Database, owner: PackageOwnerRow, name: string): Promise<boolean> {
  const { rows } = await searchVersions(d1, {
    ownerId: owner.id,
    type: "vagrant",
    name,
    exact: true,
    excludeInternal: true,
    page: 1,
    limit: 1,
  });
  return rows.length > 0;
}

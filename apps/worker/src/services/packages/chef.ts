/**
 * The Chef supermarket protocol service (SPEC-0016 §7 long tail) — the
 * service half of `/api/packages/{username}/chef/api/v1/...` (upstream
 * routers/api/packages/chef/chef.go over CreatePackageAndAddFile /
 * RemovePackageVersionByNameAndVersion, packages.go:159):
 *
 * - Upload (chef.go:201-251): the multipart `tarball` part parses as a
 *   gzip'd tar whose metadata.json member (EXACTLY one "/" in the path,
 *   chef.go's `strings.Count(hd.Name, "/") != 1` skip) feeds
 *   ParseChefMetadata (modules/packages/chef/chef.go:113-146): the JSON
 *   decode over the 32 MiB LimitedReader, the name `\A\S+\z`, the version
 *   `\A\d+\.\d+(?:\.\d+)?\z` (the ErrInvalidName/ErrInvalidVersion 400s),
 *   the source_url validation (invalid → blanked), author = maintainer,
 *   repository_url = source_url. CreatePackageAndAddFile rides
 *   SemverCompatible true, the stored file name ToLower(version +
 *   ".tar.gz"), IsLead true; a duplicate VERSION is the 409 (no
 *   add-file-to-existing); created answers `ctx.JSON(201, {})`.
 * - Universe (chef.go:35-72): EVERY version (SearchVersions, no
 *   paginator) rendered `{cookbook: {version: {location_type: "opscode",
 *   location_path: baseURL, download_url: …/cookbooks/{name}/versions/
 *   {version}/download, dependencies}}}` — a nil dependencies map marshals
 *   null (Go's encoding/json), which the port reproduces.
 * - Search/Enumerate (chef.go:75-136): SearchLatestVersions over the `q`
 *   LIKE filter with the absolute start/items pagination and the
 *   `order` switch (recently_updated|recently_added → created DESC, else
 *   name ASC — upstream's SortNameAsc default); the response is
 *   {start, total, items: [{cookbook_name, cookbook_maintainer,
 *   cookbook_description, cookbook: …/cookbooks/{name}}]}.
 * - Cookbook metadata (chef.go:139-186): every version sorted SemVer ASC;
 *   `latest_version` + the versions array carry the …/versions/{v} URLs;
 *   category "" and deprecated false are upstream's constants; created_at/
 *   updated_at render the LATEST version's creation time. Empty → null
 *   (the 404-nil arm).
 * - Version metadata (chef.go:189-236): the version segment's "_" reads
 *   as "." (chef.go:191's ReplaceAll — the knife quirk); the response
 *   carries tarball_file_size (the first file's blob size), published_at,
 *   cookbook/file URLs, license, dependencies (null when absent).
 * - Download (chef.go:239-264): the version → files[0] walk with the
 *   lead-file GET counter bump (packages.go:655-660).
 * - Delete (chef.go:267-316): the version arm is
 *   RemovePackageVersionByNameAndVersion (404 on the miss); the cookbook
 *   arm removes EVERY version (404 when the package is missing or empty —
 *   chef.go:296-299's len check), each with RemovePackageVersion.
 *
 * Divergences (documented per AGENTS.md): upstream registers chef.Auth
 * (the X-Ops signed-header RSA method over the user's
 * `chef.public_pem` setting, auth.go) as an ADDITIONAL auth method — the
 * signed-request verification rides the auth module's credential pass
 * this repo resolves per-token (SPEC-0002); the six protocol arms here
 * consume the resolved doer exactly like the other families, and the
 * X-Ops method is recorded as the OPEN auth-surface item rather than
 * ported into the service (the user-setting store + the four signature
 * versions are upstream's auth-method surface, not the registry's).
 * The SemVer sort pins a stable id tiebreak (Go's slice sort is
 * unspecified for equal keys); JSON rendering via JSON.stringify (no Go
 * Marshal HTML escaping — the landed families' posture); `versions` /
 * `items` empty answers render [] not null (Go marshals a nil slice as
 * null — chef.go initializes with make(…, 0, len), ours pins the
 * initialized-shape).
 */

import {
  type PackageBlobRow,
  type PackageDoer,
  type PackageFileRow,
  type PackageOwnerRow,
  type PackagesQuotaConfig,
  type PackageVersionRow,
  DuplicatePackageVersionError,
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
  deletePackageVersionAndReferences,
} from "./model";
import { packageVersions } from "../../db/schema";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getOrInsertBlob, packageBlobContentKey, spoolAndHash, type SpooledBlob } from "./blobs";
import { isValidAbsoluteHttpUrl, writeVersionMetadata } from "./protocol-common";
import { readTarMembers } from "./distro-common";
import { parseSwiftVersionStrict, swiftCompareVersions } from "./swift";

// ---------------------------------------------------------------------------
// The module metadata (modules/packages/chef/chef.go)
// ---------------------------------------------------------------------------

/** chef.go:22-24 — `\A\S+\z` and `\A\d+\.\d+(?:\.\d+)?\z`. */
const CHEF_NAME_PATTERN = /^\S+$/;
const CHEF_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/;

/** chef.go:30-39 — the Metadata struct in its json-tag order (omitempty on
 *  every field; Dependencies keeps nil → null). */
export interface ChefMetadata {
  description: string;
  long_description: string;
  author: string;
  license: string;
  repository_url: string;
  dependencies: Record<string, string> | null;
}

export interface ChefPackage {
  name: string;
  version: string;
  metadata: ChefMetadata;
}

export class ChefMissingMetadataError extends Error {
  constructor() {
    super("metadata.json file is missing");
    this.name = "ChefMissingMetadataError";
  }
}

export class ChefInvalidNameError extends Error {
  constructor() {
    super("package name is invalid");
    this.name = "ChefInvalidNameError";
  }
}

export class ChefInvalidVersionError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "ChefInvalidVersionError";
  }
}

/** The plain archive errors (gzip/tar/JSON) — the route's 500 default. */
export class ChefArchiveError extends Error {
  constructor() {
    super("the cookbook archive could not be read");
    this.name = "ChefArchiveError";
  }
}

/** packages.MaxMetadataSize (limited_reader.go:14). */
const MAX_CHEF_METADATA_BYTES = 32 * 1024 * 1024;

/**
 * ParseChefMetadata (chef.go:113-146): the JSON decode, the name/version
 * pattern gates, the source_url validation, the Metadata assembly
 * (author = maintainer, repository_url = source_url).
 */
export function parseChefMetadata(text: string): ChefPackage {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(0, MAX_CHEF_METADATA_BYTES)) as Record<string, unknown>;
  } catch {
    throw new ChefArchiveError();
  }
  const str = (key: string): string => (typeof raw[key] === "string" ? (raw[key]) : "");
  const name = str("name");
  const version = str("version");
  if (!CHEF_NAME_PATTERN.test(name)) {
    throw new ChefInvalidNameError();
  }
  if (!CHEF_VERSION_PATTERN.test(version)) {
    throw new ChefInvalidVersionError();
  }
  let sourceUrl = str("source_url");
  if (!isValidAbsoluteHttpUrl(sourceUrl)) {
    sourceUrl = "";
  }
  let dependencies: Record<string, string> | null = null;
  const rawDependencies = raw.dependencies;
  if (rawDependencies !== null && typeof rawDependencies === "object" && !Array.isArray(rawDependencies)) {
    dependencies = {};
    for (const [key, value] of Object.entries(rawDependencies as Record<string, unknown>)) {
      if (typeof value === "string") dependencies[key] = value;
    }
  }
  return {
    name,
    version,
    metadata: {
      description: str("description"),
      long_description: str("long_description"),
      author: str("maintainer"),
      license: str("license"),
      repository_url: sourceUrl,
      dependencies,
    },
  };
}

/**
 * ParsePackage (chef.go:49-83): the gzip'd tar walk — members with EXACTLY
 * one "/" whose base is metadata.json parse (the first hit wins, the
 * tar.Next early-return). A missing member is the 400 sentinel; a corrupt
 * archive is the plain error.
 */
export async function parseChefPackage(bytes: Uint8Array): Promise<ChefPackage> {
  if (bytes.byteLength < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new ChefArchiveError();
  }
  let inflated: Uint8Array;
  try {
    const stream = new Response(bytes.slice()).body?.pipeThrough(new DecompressionStream("gzip"));
    if (stream === undefined) throw new Error("no gzip stream");
    inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new ChefArchiveError();
  }
  let members: ReturnType<typeof readTarMembers>;
  try {
    members = readTarMembers(inflated);
  } catch {
    throw new ChefArchiveError();
  }
  for (const member of members) {
    if ((member.name.match(/\//g) ?? []).length !== 1) continue;
    if (member.name.slice(member.name.lastIndexOf("/") + 1) === "metadata.json") {
      return parseChefMetadata(new TextDecoder().decode(member.data.subarray(0, MAX_CHEF_METADATA_BYTES)));
    }
  }
  throw new ChefMissingMetadataError();
}

// ---------------------------------------------------------------------------
// The version list walk (shared by universe/search/metadata)
// ---------------------------------------------------------------------------

interface ChefVersionEntry {
  version: PackageVersionRow;
  pkgName: string;
  metadata: ChefMetadata;
}

/** loadChefMetadata — the stored JSON back into the struct (a nil/absent
 *  dependencies map stays null, Go's marshal shape). */
function loadChefMetadata(version: PackageVersionRow): ChefMetadata {
  const zero: ChefMetadata = {
    description: "",
    long_description: "",
    author: "",
    license: "",
    repository_url: "",
    dependencies: null,
  };
  if (version.metadataJson === null) return zero;
  try {
    const parsed: unknown = JSON.parse(version.metadataJson);
    if (parsed === null || typeof parsed !== "object") return zero;
    const record = parsed as Record<string, unknown>;
    const str = (key: string): string => (typeof record[key] === "string" ? (record[key]) : "");
    const deps = record.dependencies;
    return {
      description: str("description"),
      long_description: str("long_description"),
      author: str("author"),
      license: str("license"),
      repository_url: str("repository_url"),
      dependencies:
        deps !== null && typeof deps === "object" && !Array.isArray(deps)
          ? Object.fromEntries(
              Object.entries(deps as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            )
          : null,
    };
  } catch {
    return zero;
  }
}

/** Every chef version of one owner (name-optional), package name ASC /
 *  id ASC (SearchVersions' insertion order feeds the sorts below). */
async function queryChefVersions(
  d1: D1Database,
  ownerId: number,
  name: string | undefined,
): Promise<{ version: PackageVersionRow; pkgName: string }[]> {
  const { packages } = await import("../../db/schema");
  const conditions = [eq(packages.ownerId, ownerId), eq(packages.type, "chef"), eq(packages.isInternal, false)];
  if (name !== undefined) {
    conditions.push(eq(packages.lowerName, name.toLowerCase()));
  }
  return drizzle(d1)
    .select({ version: packageVersions, pkgName: packages.name })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(and(...conditions))
    .orderBy(asc(packages.name), asc(packages.id))
    .all();
}

async function listChefVersions(d1: D1Database, ownerId: number, name: string | undefined): Promise<ChefVersionEntry[]> {
  const rows = await queryChefVersions(d1, ownerId, name);
  return rows.map((row) => ({ version: row.version, pkgName: row.pkgName, metadata: loadChefMetadata(row.version) }));
}

/** sort.Slice(SemVer.LessThan ASC) — the stable id tiebreak. */
function compareChefVersions(a: ChefVersionEntry, b: ChefVersionEntry): number {
  const parsedA = parseSwiftVersionStrict(a.version.version);
  const parsedB = parseSwiftVersionStrict(b.version.version);
  if (parsedA !== null && parsedB !== null) {
    const cmp = swiftCompareVersions(parsedA, parsedB);
    if (cmp !== 0) return cmp;
  }
  return a.version.id - b.version.id;
}

// ---------------------------------------------------------------------------
// Universe (chef.go:35-72)
// ---------------------------------------------------------------------------

export interface ChefUniverseVersionInfo {
  location_type: string;
  location_path: string;
  download_url: string;
  dependencies: Record<string, string> | null;
}

/**
 * PackagesUniverse (chef.go:35-72): EVERY version of EVERY cookbook, keyed
 * {cookbook: {version: info}}. Null never — an empty store answers {}.
 */
export async function buildChefUniverse(
  d1: D1Database,
  owner: PackageOwnerRow,
  apiV1BaseURL: string,
): Promise<Record<string, Record<string, ChefUniverseVersionInfo>>> {
  const list = await listChefVersions(d1, owner.id, undefined);
  const universe: Record<string, Record<string, ChefUniverseVersionInfo>> = {};
  for (const entry of list) {
    const versions = universe[entry.pkgName] ?? {};
    versions[entry.version.version] = {
      location_type: "opscode",
      location_path: apiV1BaseURL,
      download_url: `${apiV1BaseURL}/cookbooks/${encodeURIComponent(entry.pkgName)}/versions/${encodeURIComponent(entry.version.version)}/download`,
      dependencies: entry.metadata.dependencies,
    };
    universe[entry.pkgName] = versions;
  }
  return universe;
}

// ---------------------------------------------------------------------------
// Search / Enumerate (chef.go:75-136)
// ---------------------------------------------------------------------------

export interface ChefSearchItem {
  cookbook_name: string;
  cookbook_maintainer: string;
  cookbook_description: string;
  cookbook: string;
}

export interface ChefSearchResult {
  start: number;
  total: number;
  items: ChefSearchItem[];
}

/**
 * EnumeratePackages (chef.go:75-136): the LATEST version per cookbook
 * matching the `q` LIKE filter; the order switch (created DESC for the
 * recently_* orders, else name ASC — the id tiebreak pins determinism);
 * the absolute start/items window; `total` counts the FILTERED rows
 * before the window.
 */
export async function searchChefPackages(
  d1: D1Database,
  owner: PackageOwnerRow,
  query: string,
  order: string,
  start: number,
  items: number,
  cookbooksBaseURL: string,
): Promise<ChefSearchResult> {
  const trimmed = query.trim().toLowerCase();
  const recentlyOrdered = order.trim().toLowerCase() === "recently_updated" || order.trim().toLowerCase() === "recently_added";
  // db.NewAbsoluteListOptions(start, items) — an ABSOLUTE skip/take window
  // (Paginator.GetSkipTake); the landed page/limit search cannot express an
  // arbitrary skip, so the window slices out of a start+items fetch (the
  // count is the filtered total either way).
  const windowSize = Math.max(items, 0);
  const { rows, count } = await searchLatestVersions(d1, {
    ownerId: owner.id,
    type: "chef",
    name: trimmed === "" ? undefined : trimmed,
    excludeInternal: true,
    page: 1,
    limit: start + windowSize,
  });
  const sorted = [...rows].sort((a, b) => {
    if (recentlyOrdered) {
      // SortCreatedDesc rides created DESC, id DESC (the configureOrderBy
      // secondary) — D1's second-granularity createdUnix ties often.
      const byCreated = b.version.createdUnix.getTime() - a.version.createdUnix.getTime();
      if (byCreated !== 0) return byCreated;
      return b.version.id - a.version.id;
    }
    const byName = a.pkg.name.localeCompare(b.pkg.name);
    if (byName !== 0) return byName;
    return a.version.id - b.version.id;
  });
  const itemRows: ChefSearchItem[] = sorted.slice(start, start + windowSize).map((row) => ({
    cookbook_name: row.pkg.name,
    cookbook_maintainer: loadChefMetadata(row.version).author,
    cookbook_description: loadChefMetadata(row.version).description,
    cookbook: `${cookbooksBaseURL}${encodeURIComponent(row.pkg.name)}`,
  }));
  return { start, total: count, items: itemRows };
}

// ---------------------------------------------------------------------------
// Cookbook + version metadata (chef.go:139-236)
// ---------------------------------------------------------------------------

export interface ChefCookbookMetadata {
  name: string;
  maintainer: string;
  description: string;
  category: string;
  latest_version: string;
  source_url: string;
  created_at: string;
  updated_at: string;
  deprecated: boolean;
  versions: string[];
}

/**
 * PackageMetadata (chef.go:139-186): every version SemVer ASC; the urls
 * carry the …/versions/ base. Null = the route's 404-nil.
 */
export async function getChefCookbookMetadata(
  d1: D1Database,
  owner: PackageOwnerRow,
  name: string,
  versionsBaseURL: string,
): Promise<ChefCookbookMetadata | null> {
  const list = await listChefVersions(d1, owner.id, name);
  if (list.length === 0) return null;
  const sorted = [...list].sort(compareChefVersions);
  const latest = sorted[sorted.length - 1];
  if (latest === undefined) return null;
  const created = latest.version.createdUnix.toISOString();
  return {
    name: latest.pkgName,
    maintainer: latest.metadata.author,
    description: latest.metadata.description,
    category: "",
    latest_version: `${versionsBaseURL}${encodeURIComponent(latest.version.version)}`,
    source_url: latest.metadata.repository_url,
    created_at: created,
    updated_at: created,
    deprecated: false,
    versions: sorted.map((entry) => `${versionsBaseURL}${encodeURIComponent(entry.version.version)}`),
  };
}

export interface ChefVersionMetadata {
  version: string;
  tarball_file_size: number;
  published_at: string;
  cookbook: string;
  file: string;
  license: string;
  dependencies: Record<string, string> | null;
}

/**
 * PackageVersionMetadata (chef.go:189-236): the version segment's "_" is
 * a "." (chef.go:191 — knife calls this endpoint with underscores). Null
 * = the route's 404.
 */
export async function getChefVersionMetadata(
  d1: D1Database,
  owner: PackageOwnerRow,
  name: string,
  versionSegment: string,
  cookbookBaseURL: string,
): Promise<ChefVersionMetadata | null> {
  const version = versionSegment.replaceAll("_", ".");
  const versionRow = await getVersionByNameAndVersion(d1, owner.id, "chef", name, version);
  if (versionRow === null) return null;
  const descriptors = await getFileDescriptors(d1, versionRow.id);
  const first = descriptors[0];
  if (first === undefined) return null;
  const metadata = loadChefMetadata(versionRow);
  const versionUrl = `${cookbookBaseURL}/versions/${encodeURIComponent(versionRow.version)}`;
  return {
    version: versionRow.version,
    tarball_file_size: first.blob.size,
    published_at: versionRow.createdUnix.toISOString(),
    cookbook: cookbookBaseURL,
    file: `${versionUrl}/download`,
    license: metadata.license,
    dependencies: metadata.dependencies,
  };
}

// ---------------------------------------------------------------------------
// Upload (chef.go:201-251)
// ---------------------------------------------------------------------------

export interface ChefUploadForm {
  tarball: Uint8Array;
}

/** The multipart scan for the `tarball` part (chef.go:206-208's FormFile). */
export function scanChefUploadForm(contentType: string, bytes: Uint8Array): ChefUploadForm {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? "").trim();
  if (boundary === "") throw new ChefArchiveError();
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const headerSplit = new TextEncoder().encode("\r\n\r\n");
  for (let cursor = indexOfSequence(bytes, delimiter, 0); cursor !== -1; cursor = indexOfSequence(bytes, delimiter, cursor + 1)) {
    let part = cursor + delimiter.byteLength;
    if (bytes[part] === 0x2d && bytes[part + 1] === 0x2d) break;
    while (bytes[part] === 0x0d && bytes[part + 1] === 0x0a) part += 2;
    const headerEnd = indexOfSequence(bytes, headerSplit, part);
    if (headerEnd === -1) break;
    const headers = new TextDecoder().decode(bytes.subarray(part, headerEnd));
    const disposition = headers.split("\r\n").find((line) => line.toLowerCase().startsWith("content-disposition:")) ?? "";
    if (/name="tarball"/i.test(disposition)) {
      const contentStart = headerEnd + 4;
      const next = indexOfSequence(bytes, delimiter, contentStart);
      if (next === -1) break;
      let contentEnd = next;
      if (bytes[contentEnd - 2] === 0x0d && bytes[contentEnd - 1] === 0x0a) contentEnd -= 2;
      return { tarball: bytes.slice(contentStart, contentEnd) };
    }
  }
  throw new ChefMissingTarballError();
}

export class ChefMissingTarballError extends Error {
  constructor() {
    super("the tarball form field is missing");
    this.name = "ChefMissingTarballError";
  }
}

function indexOfSequence(hay: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0) return from;
  outer: for (let i = from; i <= hay.byteLength - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export interface UploadChefPackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  contentType: string;
  content: ReadableStream<Uint8Array>;
  declaredLength: number | undefined;
  quota: PackagesQuotaConfig;
  now?: Date;
  maxBytes?: number;
  spoolKey?: string;
}

export interface UploadChefPackageResult {
  pkg: { id: number; name: string };
  version: PackageVersionRow;
  file: PackageFileRow;
  blob: PackageBlobRow;
  parsed: ChefPackage;
}

/**
 * The upload's service walk (chef.go:201-251): the multipart scan → the
 * cookbook parse (the 400 sentinels) → the quota arms →
 * CreatePackageAndAddFile — the version DUPLICATE is the 409, the stored
 * name ToLower(version + ".tar.gz"), IsLead true, metadata into the fresh
 * version row only.
 */
export async function uploadChefPackage(input: UploadChefPackageInput): Promise<UploadChefPackageResult> {
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
    const body = new Uint8Array(await spoolObject.arrayBuffer());
    const form = scanChefUploadForm(input.contentType, body);
    const parsed = await parseChefPackage(form.tarball);

    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "chef", form.tarball.byteLength, input.quota);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "chef",
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
    await writeVersionMetadata(input.d1, version.id, buildChefMetadataJson(parsed.metadata));

    const { row: blob } = await getOrInsertBlob(input.d1, {
      size: form.tarball.byteLength,
      sha256: spooled.sha256,
      sha1: spooled.sha1,
      sha512: spooled.sha512,
      now,
    });

    const contentKey = packageBlobContentKey(spooled.sha256);
    const objectPresent = (await input.bucket.head(contentKey)) !== null;
    if (objectPresent) {
      await input.bucket.delete(spooled.spoolKey);
    } else {
      // The tarball bytes are already extracted (in memory); the multipart
      // envelope never stores. The spool dies either way.
      await input.bucket.put(contentKey, form.tarball.slice());
      await input.bucket.delete(spooled.spoolKey);
    }

    // chef.go:238-241 — Filename: strings.ToLower(version + ".tar.gz");
    // IsLead: true. A duplicate file row on a fresh version is
    // unreachable outside a race, but the guard stays.
    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: `${parsed.version}.tar.gz`.toLowerCase(),
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

/** buildChefMetadataJson — the omitempty set in the struct's tag order. */
export function buildChefMetadataJson(m: ChefMetadata): string {
  const out: Record<string, unknown> = {};
  if (m.description !== "") out.description = m.description;
  if (m.long_description !== "") out.long_description = m.long_description;
  if (m.author !== "") out.author = m.author;
  if (m.license !== "") out.license = m.license;
  if (m.repository_url !== "") out.repository_url = m.repository_url;
  if (m.dependencies !== null && Object.keys(m.dependencies).length > 0) out.dependencies = m.dependencies;
  return JSON.stringify(out);
}

// ---------------------------------------------------------------------------
// Download + delete (chef.go:239-316)
// ---------------------------------------------------------------------------

export interface ChefDownload {
  file: PackageFileRow;
  blob: PackageBlobRow;
  stream: ReadableStream;
  size: number;
}

/** DownloadPackage (chef.go:239-264): the version → files[0] walk with the
 *  lead GET bump. Null = the route's 404. */
export async function openChefPackageForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  name: string,
  version: string,
  method: "GET" | "HEAD",
): Promise<ChefDownload | null> {
  const versionRow = await getVersionByNameAndVersion(d1, owner.id, "chef", name, version);
  if (versionRow === null) return null;
  const descriptors = await getFileDescriptors(d1, versionRow.id);
  const first = descriptors[0];
  if (first === undefined) return null;
  const object = await bucket.get(packageBlobContentKey(first.blob.hashSha256));
  if (object === null) return null;
  if (first.file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, versionRow.id);
  }
  return { file: first.file, blob: first.blob, stream: object.body, size: object.size };
}

/**
 * DeletePackageVersion (chef.go:267-286): RemovePackageVersionByNameAndVersion —
 * true when the version row died (the unreferenced-package fold rides the
 * model's cascade). Null-miss = the 404.
 */
export async function deleteChefPackageVersion(
  d1: D1Database,
  owner: PackageOwnerRow,
  name: string,
  version: string,
): Promise<boolean> {
  const versionRow = await getVersionByNameAndVersion(d1, owner.id, "chef", name, version);
  if (versionRow === null) return false;
  await deletePackageVersionAndReferences(d1, versionRow.id);
  return true;
}

/**
 * DeletePackage (chef.go:289-316): EVERY version of the cookbook dies;
 * false when the package is missing or ALREADY empty (the len==0 404-nil
 * arm — chef.go:296-299).
 */
export async function deleteChefPackage(d1: D1Database, owner: PackageOwnerRow, name: string): Promise<boolean> {
  const list = await listChefVersions(d1, owner.id, name);
  if (list.length === 0) return false;
  for (const entry of list) {
    await deletePackageVersionAndReferences(d1, entry.version.id);
  }
  return true;
}

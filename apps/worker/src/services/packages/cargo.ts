/**
 * The Cargo (Rust) registry protocol service (SPEC-0016 §7 M7 tail) — upstream
 * `routers/api/packages/cargo/cargo.go` + `services/packages/cargo/index.go` +
 * `modules/packages/cargo/parser.go` at the pin fc493688. The endpoint family
 * (api.go:127-146, the group wrapped in reqPackageAccess(read) with the write
 * arms inside reqPackageAccess(write)):
 *
 *   GET    …/cargo/config.json                                   → RepositoryConfig (cargo.go:60-63)
 *   GET    …/cargo/{1|2|3|4-segment sparse path}/{package}       → EnumeratePackageVersions (cargo.go:66-87)
 *   GET    …/cargo/api/v1/crates?q&page&per_page                 → SearchPackages (cargo.go:106-143)
 *   PUT    …/cargo/api/v1/crates/new                             → UploadPackage (cargo.go:170-224)
 *   GET    …/cargo/api/v1/crates/{package}/{version}/download    → DownloadPackageFile (cargo.go:158-167)
 *   DELETE …/cargo/api/v1/crates/{package}/{version}/yank        → YankPackage (cargo.go:247-274)
 *   PUT    …/cargo/api/v1/crates/{package}/{version}/unyank      → UnyankPackage (the yank=false twin)
 *   GET    …/cargo/api/v1/crates/{package}/owners                → ListOwners (cargo.go:152-155)
 *
 * ## The index storage posture (the git-repo reduction)
 *
 * Upstream maintains a REAL git repository `_cargo-index`
 * (index.go:24, InitializeIndexRepository) whose per-package NDJSON files and
 * config.json are committed through the files service — that repo serves the
 * TRADITIONAL git-protocol index clients. The sparse-HTTP endpoints served
 * here do NOT read it: EnumeratePackageVersions derives every index line from
 * the database at request time (cargo.go:66-87 → BuildPackageIndex,
 * index.go:139-183 — SearchVersions + the version descriptors), and
 * UpdatePackageIndexIfExists itself states the contract this port rides:
 * "cargo http index does not rely on the repo itself, so if the repo does not
 * exist, we just do nothing" (index.go:94-99). SPEC-0016 §1 carves the
 * git-backed `_cargo-index` repository out of v1 ("own SPEC-attached
 * milestone") — so our tree NEVER has the repo, updateCargoPackageIndex is
 * permanently the repo-absent arm (the upstream no-op), and the sparse index
 * is derived on read exactly as upstream's HTTP face does. Every write arm
 * (publish / yank / unyank / the cleanup rider) still calls it at upstream's
 * call-site shape, so the git-index milestone can hang content off one seam.
 *
 * ## The .crate container (parser.go:57-71)
 *
 * cargo's publish body is NOT a bare .crate file: `uint32-LE metadata length |
 * metadata JSON | uint32-LE content length | .crate bytes` (the registry
 * publish wire, doc.rust-lang.org/cargo/reference/registry-web-api#publish).
 * The metadata JSON is the crates.io publish summary; upstream validates the
 * name (`\A[a-zA-Z][a-zA-Z0-9-_]{0,63}\z`, parser.go:53) and the version
 * (hashicorp/go-version NewSemver, parser.go:63 → npm.ts's parseGoSemver
 * port), blanks non-absolute http(s) homepage/documentation/repository URLs
 * (parser.go:66-71), and resolves renamed dependencies:
 * `explicit_name_in_toml` names the DEPENDENCY while the original name moves
 * to `package` (parser.go:105-124, the registry publish contract's "new
 * package name if renamed, otherwise empty"). MaxMetadataSize is 32 MiB
 * (limited_reader.go:14; exceeded → 400 "content exceeds the size limit").
 * The content length is checked against the bytes actually received — short
 * content → 400 "invalid content size" (cargo.go:181-184); trailing bytes
 * past the declared content are ignored (the io.LimitReader truncation).
 *
 * ## The index-entry line (index.go:125-135)
 *
 *   {"name","vers","deps":[{name,req,features,optional,default_features,
 *    target,kind,registry,package}],"cksum","features","yanked","links"?}
 *
 * struct-marshaled in declaration order, one JSON line per version, "\n"
 * terminated; deps nil → [] and features nil → {} (index.go:157-165); cksum
 * is the LEAD file's blob sha256 (index.go:171 — pd.Files[0].Blob.HashSHA256);
 * yanked comes from the `cargo.yanked` VERSION property (parser.go:19,
 * strconv.ParseBool with the error ignored → false, index.go:169); links
 * omits when empty. The ORDER is upstream SortVersionAsc
 * (package_version.go:287-294): `ORDER BY package_version.version ASC,
 * id DESC` — the raw version STRING ascending (not a semver-aware sort);
 * zero versions → nil → apiError(404, nil) → the empty-detail 404 body
 * (cargo.go:80-82).
 *
 * ## Error bodies (cargo.go:19-49)
 *
 * Every error answers `{"ok":false,"errors":[{"detail": message}]}` — the
 * StatusResponse wrap — with ProcessErrorForUser's prod posture stripping
 * 500s to "internal server error". Success answers `{"ok":true}`.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageFiles, packageProperties, packageVersions, repositories } from "../../db/schema";
import {
  QuotaTotalCountError,
  QuotaTotalSizeError,
  calculateFileSize,
  countVersions,
  getOrInsertPackage,
  getOrInsertVersion,
  getPackageByName,
  getPackageDescriptor,
  getVersionByNameAndVersion,
  incrementDownloadCounter,
  searchLatestVersions,
  type PackageOwnerVisibility,
  type PackagesQuotaConfig,
  type PackageRow,
} from "./model";
import {
  MAX_PACKAGE_BLOB_BYTES,
  getOrInsertBlob,
  packageBlobContentKey,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import { getPackageProperties, isValidAbsoluteHttpUrl, writeVersionMetadata } from "./protocol-common";
import { bytesToHex } from "./distro-common";
import { parseGoSemver } from "./npm";

// ---------------------------------------------------------------------------
// Metadata (modules/packages/cargo/parser.go:27-51 — the JSON-tag order is
// the wire order; every field omitempty on Metadata, NONE on Dependency)
// ---------------------------------------------------------------------------

/** The index/deps dependency record (parser.go:37-48). */
export interface CargoDependency {
  name: string;
  req: string;
  features: string[];
  optional: boolean;
  default_features: boolean;
  target: string | null;
  kind: string;
  registry: string | null;
  package: string | null;
}

/** The stored version metadata (parser.go:27-51). */
export interface CargoMetadata {
  dependencies?: CargoDependency[];
  features?: Record<string, string[]>;
  authors?: string[];
  description?: string;
  documentation_url?: string;
  project_url?: string;
  readme?: string;
  keywords?: string[];
  categories?: string[];
  license?: string;
  repository_url?: string;
  links?: string;
}

/** `PropertyYanked` (parser.go:19) — the version property holding the flag. */
export const CARGO_YANKED_PROPERTY = "cargo.yanked";

/** `IndexRepositoryName` (index.go:24) — the git-protocol mirror repo's name
 *  (never created in our tree — see the module-header reduction). */
export const CARGO_INDEX_REPOSITORY_NAME = "_cargo-index";

/** `ConfigFileName` (index.go:25). */
export const CARGO_CONFIG_FILE_NAME = "config.json";

// ---------------------------------------------------------------------------
// Errors — the parser + handler sentinels with upstream's messages
// ---------------------------------------------------------------------------

/** ErrInvalidName (parser.go:22) → 400. */
export class CargoInvalidNameError extends Error {
  constructor() {
    super("package name is invalid");
    this.name = "CargoInvalidNameError";
  }
}

/** ErrInvalidVersion (parser.go:23) → 400. */
export class CargoInvalidVersionError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "CargoInvalidVersionError";
  }
}

/** ErrContentTooLarge (limited_reader.go:12) — metadata past the 32 MiB cap → 400. */
export class CargoMetadataTooLargeError extends Error {
  constructor() {
    super("content exceeds the size limit");
    this.name = "CargoMetadataTooLargeError";
  }
}

/** The container's content length contradicting the received bytes → 400
 *  "invalid content size" (cargo.go:181-184). */
export class CargoContentSizeMismatchError extends Error {
  constructor() {
    super("invalid content size");
    this.name = "CargoContentSizeMismatchError";
  }
}

/** A malformed container (short headers, invalid JSON) → 400; the message is
 *  the JS parse error text where upstream carries Go's runtime text — a
 *  disclosed message-shape divergence (the status and the wrap are exact). */
export class CargoParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CargoParseError";
  }
}

/** ErrDuplicatePackageVersion at publish (cargo.go:204-205) → 409. */
export class CargoDuplicateVersionError extends Error {
  constructor() {
    super("package version already exists");
    this.name = "CargoDuplicateVersionError";
  }
}

/** ErrPackageNotExist → 404 "package does not exist". */
export class CargoPackageNotExistError extends Error {
  constructor() {
    super("package does not exist");
    this.name = "CargoPackageNotExistError";
  }
}

/** ErrPackageFileNotExist → 404 "package file does not exist". */
export class CargoFileNotExistError extends Error {
  constructor() {
    super("package file does not exist");
    this.name = "CargoFileNotExistError";
  }
}

/** The yank walk's missing `cargo.yanked` property (cargo.go:256-259) → 500
 *  ("Property not found" upstream — the prod posture strips the detail). */
export class CargoYankedPropertyMissingError extends Error {
  constructor() {
    super("Property not found");
    this.name = "CargoYankedPropertyMissingError";
  }
}

// ---------------------------------------------------------------------------
// The .crate container parse (parser.go:57-124)
// ---------------------------------------------------------------------------

/** MaxMetadataSize (limited_reader.go:14). */
export const MAX_CARGO_METADATA_BYTES = 32 * 1024 * 1024;

/** The name regexp (parser.go:53). */
const CARGO_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-_]{0,63}$/;

/** The publish-metadata wire shape (the crates.io publish summary the cargo
 *  client sends; parser.go:78-104's anonymous struct). */
interface CargoPublishMeta {
  name?: string;
  vers?: string;
  deps?: {
    name?: string;
    version_req?: string;
    features?: string[];
    optional?: boolean;
    default_features?: boolean;
    target?: string | null;
    kind?: string;
    registry?: string | null;
    explicit_name_in_toml?: string;
  }[];
  features?: Record<string, string[]> | null;
  authors?: string[] | null;
  description?: string;
  documentation?: string;
  homepage?: string;
  readme?: string;
  readme_file?: string;
  keywords?: string[] | null;
  categories?: string[] | null;
  license?: string;
  license_file?: string;
  repository?: string;
  links?: string;
}

/** The parsed container: the metadata record + the content window. */
export interface ParsedCargoPackage {
  name: string;
  version: string;
  metadata: CargoMetadata;
  /** The content's byte offset inside the spool object (after both headers). */
  contentOffset: number;
  /** The declared content length (parser.go:64-71's second uint32). */
  contentSize: number;
}

/**
 * `ParsePackage` over a spooled body (parser.go:57-71): the two LE-uint32
 * headers are read off the spool's head, the metadata is bounded-read and
 * JSON-decoded, the name/version/URL/dependency normalizations run
 * (parser.go:63-124), and the content is left as a (offset, size) window the
 * caller streams — upstream hands an io.LimitReader; the caller's size check
 * (cargo.go:181-184) is our offset-vs-spool-size comparison.
 */
export async function parseCargoPackage(bucket: R2Bucket, spooled: SpooledBlob): Promise<ParsedCargoPackage> {
  const header = await readSpoolPrefix(bucket, spooled.spoolKey, 8 + MAX_CARGO_METADATA_BYTES + 4);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

  if (header.byteLength < 4) {
    throw new CargoParseError("unexpected end of publish body");
  }
  const metaLen = view.getUint32(0, true);
  if (metaLen > MAX_CARGO_METADATA_BYTES) {
    // binary.Read passes; the LimitReader errors once a byte past the cap
    // (parser.go:60-62 → limited_reader.go:26-29).
    throw new CargoMetadataTooLargeError();
  }
  const metaEnd = 4 + metaLen;
  if (header.byteLength < metaEnd + 4) {
    throw new CargoParseError("unexpected end of publish body");
  }
  let meta: CargoPublishMeta;
  try {
    meta = JSON.parse(new TextDecoder().decode(header.subarray(4, metaEnd))) as CargoPublishMeta;
  } catch (error) {
    throw new CargoParseError(error instanceof Error ? error.message : "invalid metadata JSON");
  }

  const name = meta.name ?? "";
  if (!CARGO_NAME_RE.test(name)) {
    throw new CargoInvalidNameError();
  }
  const version = meta.vers ?? "";
  if (parseGoSemver(version) === null) {
    throw new CargoInvalidVersionError();
  }

  // parser.go:66-71 — non-absolute http(s) URLs blank out.
  const homepage = isValidAbsoluteHttpUrl(meta.homepage ?? "") ? (meta.homepage ?? "") : "";
  const documentation = isValidAbsoluteHttpUrl(meta.documentation ?? "") ? (meta.documentation ?? "") : "";
  const repository = isValidAbsoluteHttpUrl(meta.repository ?? "") ? (meta.repository ?? "") : "";

  // parser.go:105-124 — the rename resolution: explicit_name_in_toml names
  // the dependency and the registry name moves to `package`; unrenamed deps
  // carry package = null.
  const dependencies: CargoDependency[] = (meta.deps ?? []).map((dep) => {
    const explicit = dep.explicit_name_in_toml ?? "";
    const renamed = explicit !== "";
    return {
      name: renamed ? explicit : (dep.name ?? ""),
      req: dep.version_req ?? "",
      features: dep.features ?? [],
      optional: dep.optional ?? false,
      default_features: dep.default_features ?? false,
      target: dep.target ?? null,
      kind: dep.kind ?? "",
      registry: dep.registry ?? null,
      package: renamed ? (dep.name ?? "") : null,
    };
  });

  const contentSize = view.getUint32(metaEnd, true);
  const metadata: CargoMetadata = {
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(meta.features && Object.keys(meta.features).length > 0 ? { features: meta.features } : {}),
    ...(meta.authors && meta.authors.length > 0 ? { authors: meta.authors } : {}),
    ...(meta.description !== undefined && meta.description !== "" ? { description: meta.description } : {}),
    ...(documentation !== "" ? { documentation_url: documentation } : {}),
    ...(homepage !== "" ? { project_url: homepage } : {}),
    ...(meta.readme !== undefined && meta.readme !== "" ? { readme: meta.readme } : {}),
    ...(meta.keywords && meta.keywords.length > 0 ? { keywords: meta.keywords } : {}),
    ...(meta.categories && meta.categories.length > 0 ? { categories: meta.categories } : {}),
    ...(meta.license !== undefined && meta.license !== "" ? { license: meta.license } : {}),
    ...(repository !== "" ? { repository_url: repository } : {}),
    ...(meta.links !== undefined && meta.links !== "" ? { links: meta.links } : {}),
  };

  return { name, version, metadata, contentOffset: metaEnd + 4, contentSize };
}

/** A bounded head-read of a spool object (the metadata never exceeds the cap
 *  + 12 bytes; one R2 range get — the npm readSpoolText posture, byte-flavored). */
async function readSpoolPrefix(bucket: R2Bucket, spoolKey: string, maxBytes: number): Promise<Uint8Array> {
  const object = await bucket.get(spoolKey, { range: { offset: 0, length: maxBytes } });
  if (object === null) {
    throw new CargoParseError("package spool object vanished");
  }
  return new Uint8Array(await object.arrayBuffer());
}

/** `{name}-{version}.crate` lowercased (cargo.go:161-163 / :200-202). */
export function cargoCrateFilename(name: string, version: string): string {
  return `${name}-${version}.crate`.toLowerCase();
}

/**
 * `BuildPackagePath` (index.go:31-45) — the sparse index's segment layout:
 * 1/2/3-char names under the `1|2|3` roots, longer names sharded by the
 * first two / next two characters (lower-cased, upstream's p.LowerName key).
 */
export function buildCargoPackagePath(name: string): string {
  if (name.length === 0) {
    throw new Error("Cargo package name can not be empty");
  }
  const lower = name.toLowerCase();
  if (lower.length === 1) return `1/${lower}`;
  if (lower.length === 2) return `2/${lower}`;
  if (lower.length === 3) return `3/${lower[0]}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

// ---------------------------------------------------------------------------
// The sparse index lines (index.go:125-183)
// ---------------------------------------------------------------------------

/** `IndexVersionEntry` (index.go:125-135) — the key order IS the wire order. */
export interface CargoIndexVersionEntry {
  name: string;
  vers: string;
  deps: CargoDependency[];
  cksum: string;
  features: Record<string, string[]>;
  yanked: boolean;
  links?: string;
}

/** The stored metadata reader (DescriptorMetadata's unmarshal-or-zero). */
function readCargoMetadata(metadataJson: string | null): CargoMetadata {
  if (metadataJson === null || metadataJson === "") return {};
  try {
    return JSON.parse(metadataJson) as CargoMetadata;
  } catch {
    return {};
  }
}

/** `strconv.ParseBool` with the error ignored (index.go:169) — invalid → false. */
function parseCargoYanked(value: string): boolean {
  return value === "1" || value === "t" || value === "T" || value === "TRUE" || value === "true" || value === "True";
}

/** `BuildPackageIndex` (index.go:139-183): the package's versions in
 *  SortVersionAsc order (package_version.go:287-294 — `version ASC, id DESC`,
 *  the raw string sort upstream ships), one entry line per version. Null =
 *  zero versions → the 404 arm (cargo.go:80-82). */
export async function buildCargoPackageIndex(d1: D1Database, pkg: PackageRow): Promise<string | null> {
  // SearchVersions(PackageID, SortVersionAsc) — unpaginated upstream; our
  // order key is the version STRING asc with the id DESC stable tail.
  const versions = await drizzle(d1)
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.isInternal, false)))
    .orderBy(asc(packageVersions.version), sql`${packageVersions.id} DESC`)
    .all();
  if (versions.length === 0) return null;

  const lines: string[] = [];
  for (const version of versions) {
    const descriptor = await getPackageDescriptor(d1, pkg, version);
    const lead = descriptor.files[0];
    if (lead === undefined) {
      // Upstream indexes Files[0] bare (index.go:171) — a fileless version is
      // a corrupted row and answers the 500 arm.
      throw new Error(`cargo version ${pkg.name}@${version.version} has no files`);
    }
    const metadata = readCargoMetadata(version.metadataJson);
    const props = await getPackageProperties(d1, 0 /* PropertyTypeVersion */, version.id);
    const yankedRaw = props.find((prop) => prop.name === CARGO_YANKED_PROPERTY)?.value ?? "";

    // metadata.Dependencies/Features nil → empty containers (index.go:157-165).
    const deps = metadata.dependencies ?? [];
    const features = metadata.features ?? {};
    const entry: CargoIndexVersionEntry = {
      name: pkg.name,
      vers: version.version,
      deps,
      cksum: lead.blob.hashSha256,
      features,
      yanked: parseCargoYanked(yankedRaw),
      ...(metadata.links !== undefined && metadata.links !== "" ? { links: metadata.links } : {}),
    };
    lines.push(JSON.stringify(entry));
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The config document (index.go:260-272)
// ---------------------------------------------------------------------------

/** `Config` (index.go:260-265) — key order preserved. */
export interface CargoRegistryConfig {
  dl: string;
  api: string;
  "auth-required": boolean;
}

/**
 * `BuildConfig` (index.go:267-272): dl → the crates prefix, api → the family
 * root, auth-required → the private-owner posture. Upstream also ORs
 * `setting.Service.RequireSignInViewStrict` — off-by-default and not carried
 * in our config surface (the landed families' posture for that setting), so
 * the visibility arm alone decides.
 */
export function buildCargoRegistryConfig(
  owner: { username: string; visibility: PackageOwnerVisibility },
  origin: string,
): CargoRegistryConfig {
  return {
    dl: `${origin}/api/packages/${owner.username}/cargo/api/v1/crates`,
    api: `${origin}/api/packages/${owner.username}/cargo`,
    "auth-required": owner.visibility !== "public",
  };
}

// ---------------------------------------------------------------------------
// Search (cargo.go:106-143) — the crates.io /api/v1/crates q-arm
// ---------------------------------------------------------------------------

/** `SearchResult` (cargo.go:108-124) — key order preserved. */
export interface CargoSearchResult {
  crates: { name: string; max_version: string; description: string }[];
  meta: { total: number };
}

/**
 * `SearchPackages`' query (cargo.go:115-122): SearchLatestVersions over the
 * owner's non-internal cargo packages, the trimmed `q` as a lower_name
 * LIKE-substring (package_version.go:226-231's non-exact SearchValue arm),
 * `page` clamped ≥ 1 and `per_page` through ToCorrectPageSize
 * (convert/utils.go:15-22: ≤ 0 → the default 10, > 50 → 50 — API defaults).
 */
export async function searchCargoPackages(
  d1: D1Database,
  ownerId: number,
  q: string,
  page: number,
  perPage: number,
): Promise<CargoSearchResult> {
  const effectivePage = Math.max(page, 1);
  const limit = perPage <= 0 ? 10 : Math.min(perPage, 50);
  const found = await searchLatestVersions(d1, {
    ownerId,
    type: "cargo",
    name: q,
    excludeInternal: true,
    page: effectivePage,
    limit,
  });
  const crates = [];
  for (const row of found.rows) {
    const metadata = readCargoMetadata(row.version.metadataJson);
    crates.push({
      name: row.pkg.name,
      max_version: row.version.version,
      description: metadata.description ?? "",
    });
  }
  return { crates, meta: { total: found.count } };
}

// ---------------------------------------------------------------------------
// The write arms — publish (cargo.go:170-224), yank/unyank (:247-274)
// ---------------------------------------------------------------------------

/** The owner slice the protocol arms pass down. */
export interface CargoOwner {
  id: number;
  username: string;
  usernameLower: string;
  visibility: PackageOwnerVisibility;
}

export interface UploadCargoPackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: CargoOwner;
  doer: { id: number; isAdmin: boolean };
  content: ReadableStream<Uint8Array>;
  declaredLength?: number;
  quota: PackagesQuotaConfig;
  now?: Date;
}

export interface UploadCargoPackageResult {
  pkg: PackageRow;
  versionId: number;
  version: string;
}

/**
 * `UploadPackage`'s service walk (cargo.go:170-224 → CreatePackageAndAddFile,
 * packages.go): spool the whole container (the parse needs the head; the
 * store cap is our transport bound — upstream cargo carries no
 * MaxBytesReader, only the metadata cap and the quota lattice), parse, the
 * content-size check, then the quota/count → package → version → metadata →
 * yanked-property → blob → lead-file chain. `SemverCompatible: true`
 * (cargo.go:193), file `{name}-{version}.crate` lowercased with IsLead: true
 * (cargo.go:200-208).
 */
export async function uploadCargoPackage(input: UploadCargoPackageInput): Promise<UploadCargoPackageResult> {
  const { d1, bucket } = input;
  const now = input.now ?? new Date();

  // PASS 1 — the whole body (headers + metadata + content) spools under the
  // store cap; the parse walks the spool's head only.
  const spooled = await spoolAndHash({
    bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: MAX_PACKAGE_BLOB_BYTES,
  });

  try {
    const parsed = await parseCargoPackage(bucket, spooled);

    // cargo.go:181-184 — buf.Size() != ContentSize. The content window is
    // everything after both headers; SHORT content is the only mismatch
    // upstream's LimitReader can produce (trailing bytes are truncated).
    if (spooled.size - parsed.contentOffset < parsed.contentSize) {
      throw new CargoContentSizeMismatchError();
    }

    // CreatePackageAndVersion (packages.go:188-245): the count quota first,
    // then the package/version inserts. SemverCompatible: true (cargo.go:193).
    if (!input.doer.isAdmin && input.quota.limitTotalOwnerCount > -1) {
      if ((await countVersions(d1, input.owner.id)) + 1 > input.quota.limitTotalOwnerCount) {
        throw new QuotaTotalCountError();
      }
    }

    const { row: pkg } = await getOrInsertPackage(d1, {
      ownerId: input.owner.id,
      type: "cargo",
      name: parsed.name,
      semverCompatible: true,
      now,
    });
    const { row: version, created: versionCreated } = await getOrInsertVersion(d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: parsed.version,
      now,
    });
    if (!versionCreated) {
      // ErrDuplicatePackageVersion (cargo.go:204-205) → 409; the spool dies
      // in the finally below.
      throw new CargoDuplicateVersionError();
    }

    // The metadata marshals at INSERT time (packages.go:218-245 — a duplicate
    // version keeps its original metadata; unreachable past the 409 above).
    await writeVersionMetadata(d1, version.id, JSON.stringify(parsed.metadata));
    // VersionProperties {cargo.yanked: "false"} (cargo.go:195-199).
    await drizzle(d1)
      .insert(packageProperties)
      .values({ refType: 0 /* PropertyTypeVersion */, refId: version.id, name: CARGO_YANKED_PROPERTY, value: "false" });

    // AddFileToPackageVersion (packages.go:336+): the size quota, then the
    // blob dedup → content key → the lead file.
    if (!input.doer.isAdmin && input.quota.limitTotalOwnerSize > -1) {
      if ((await calculateFileSize(d1, input.owner.id)) + parsed.contentSize > input.quota.limitTotalOwnerSize) {
        throw new QuotaTotalSizeError();
      }
    }
    const blob = await storeCargoContent(d1, bucket, spooled, parsed);
    const filename = cargoCrateFilename(parsed.name, parsed.version);
    const inserted = await drizzle(d1)
      .insert(packageFiles)
      .values({
        versionId: version.id,
        blobId: blob.id,
        name: filename,
        lowerName: filename.toLowerCase(),
        isLead: true,
        createdUnix: now,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      // Unreachable through the protocol (the version UNIQUE fires first) —
      // upstream would answer ErrDuplicatePackageFile's default arm (500).
      throw new Error("cargo package file insert raced a duplicate");
    }

    // UpdatePackageIndexIfExists (cargo.go:210-220) — the git-index seam;
    // the repo-absent no-op per index.go:94-99 (updateCargoPackageIndex).
    await updateCargoPackageIndex(d1, input.owner.id, pkg.id);

    return { pkg, versionId: version.id, version: version.version };
  } finally {
    await bucket.delete(spooled.spoolKey).catch(() => undefined);
  }
}

/**
 * The content window pass: digest the spool's (offset, size) slice — the
 * blob hashes must cover the .crate bytes, NOT the container — then stream
 * the same slice into the content key (the key needs the sha256, so the
 * digest pass runs first; two range reads, intra-datacenter). The window is
 * size-verified before this runs, so both passes see exactly contentSize
 * bytes; `getOrInsertBlob` answers the content-addressed dedup.
 */
async function storeCargoContent(d1: D1Database, bucket: R2Bucket, spooled: SpooledBlob, parsed: ParsedCargoPackage) {
  const ranged = await bucket.get(spooled.spoolKey, { range: { offset: parsed.contentOffset, length: parsed.contentSize } });
  if (ranged === null) {
    throw new CargoParseError("package spool object vanished");
  }
  // DigestStream IS a WritableStream — tee branches feed the three digests
  // in parallel (the blobs module's RunningDigests shape, byte-source
  // swapped from the request body to the spool window).
  const [b1, rest] = ranged.body.tee();
  const [b2, b3] = rest.tee();
  const sha1 = new crypto.DigestStream("SHA-1");
  const sha256 = new crypto.DigestStream("SHA-256");
  const sha512 = new crypto.DigestStream("SHA-512");
  await Promise.all([b1.pipeTo(sha1), b2.pipeTo(sha256), b3.pipeTo(sha512)]);
  const [d1Digest, d256, d512] = await Promise.all([sha1.digest, sha256.digest, sha512.digest]);
  const hashSha1 = bytesToHex(new Uint8Array(d1Digest));
  const hashSha256 = bytesToHex(new Uint8Array(d256));
  const hashSha512 = bytesToHex(new Uint8Array(d512));

  const { row: blob } = await getOrInsertBlob(d1, {
    size: parsed.contentSize,
    sha256: hashSha256,
    sha1: hashSha1,
    sha512: hashSha512,
  });
  const fresh = await bucket.get(spooled.spoolKey, { range: { offset: parsed.contentOffset, length: parsed.contentSize } });
  if (fresh === null) {
    throw new CargoParseError("package spool object vanished");
  }
  await bucket.put(packageBlobContentKey(hashSha256), fresh.body);
  return blob;
}

/**
 * `UpdatePackageIndexIfExists` (index.go:92-112) — the git-index seam every
 * cargo write arm calls. Upstream looks up the owner's `_cargo-index`
 * repository and, when it does not exist, returns nil WITHOUT any other
 * effect ("cargo http index does not rely on the repo itself, so if the repo
 * does not exist, we just do nothing", index.go:94-99). Our tree never
 * creates that repository (SPEC-0016 §1: the git-backed index repo is its own
 * SPEC-attached milestone), so the function resolves the upstream contract's
 * repo-absent arm permanently: one repositories-row probe keyed
 * owner+`_cargo-index`, then the no-op. The row probe exists so the git-index
 * milestone can hang its rewrite arm on this exact seam, and so a deployment
 * that happens to carry a `_cargo-index` repo row keeps the write arms
 * observable (the present arm logs the reduction — no content is written).
 */
export async function updateCargoPackageIndex(d1: D1Database, ownerId: number, packageId: number): Promise<void> {
  const repo = await drizzle(d1)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerId, ownerId), eq(repositories.slug, CARGO_INDEX_REPOSITORY_NAME)))
    .limit(1)
    .all();
  if (repo.length === 0) {
    // index.go:96-99 — the repo-absent arm: do nothing.
    return;
  }
  // The repo row EXISTS (upstream would alterRepositoryContent here,
  // index.go:110-112). Our v1 carries no files-service write path for the
  // index repo (the git-index milestone's subject) — log-and-skip keeps the
  // write arms live without fabricating content.
  console.log(
    `[packages-cargo] package ${packageId}: a _cargo-index repository row exists but the git-index mirror is not maintained (SPEC-0016 §1); the sparse index derives on read`,
  );
}

/**
 * The yank/unyank walk (cargo.go:247-274): the version must exist (404),
 * the `cargo.yanked` version property must exist (the 500 sentinel — a
 * pre-yank-era version row), then the property flips and the index seam
 * runs. Returns nothing; the caller answers `{"ok": true}`.
 */
export async function setCargoPackageYanked(
  d1: D1Database,
  ownerId: number,
  name: string,
  version: string,
  yank: boolean,
): Promise<void> {
  const pv = await getVersionByNameAndVersion(d1, ownerId, "cargo", name, version);
  if (pv === null) {
    throw new CargoPackageNotExistError();
  }
  const props = await getPackageProperties(d1, 0 /* PropertyTypeVersion */, pv.id);
  const prop = props.find((candidate) => candidate.name === CARGO_YANKED_PROPERTY);
  if (prop === undefined) {
    // cargo.go:256-259 — "Property not found" rides the 500 arm.
    throw new CargoYankedPropertyMissingError();
  }
  await drizzle(d1)
    .update(packageProperties)
    .set({ value: yank ? "true" : "false" })
    .where(eq(packageProperties.id, prop.id))
    .run();
  // UpdatePackageIndexIfExists (cargo.go:262-267) — the git-index seam.
  await updateCargoPackageIndex(d1, ownerId, pv.packageId);
}

/**
 * `DownloadPackageFile`'s lookup (cargo.go:158-167 →
 * OpenFileForDownloadByPackageNameAndVersion): the owner-scoped version, the
 * `{name}-{version}.crate` lead file, the blob object. The counter bumps on
 * the lead file's GET only (IsLead: true, the helper.ServePackageFile gate).
 * A version miss throws CargoPackageNotExistError and a file miss
 * CargoFileNotExistError — the route maps both to the 404 detail arm.
 */
export async function openCargoFileForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  ownerId: number,
  name: string,
  version: string,
  method: "GET" | "HEAD",
): Promise<{ stream: ReadableStream; size: number; filename: string; created: Date }> {
  const pv = await getVersionByNameAndVersion(d1, ownerId, "cargo", name, version);
  if (pv === null) {
    throw new CargoPackageNotExistError();
  }
  const pkg = await getPackageByName(d1, ownerId, "cargo", name);
  if (pkg === null) {
    throw new CargoPackageNotExistError();
  }
  const filename = cargoCrateFilename(name, version);
  const descriptor = await getPackageDescriptor(d1, pkg, pv);
  const match = descriptor.files.find((entry) => entry.file.lowerName === filename.toLowerCase());
  if (match === undefined) {
    throw new CargoFileNotExistError();
  }
  const object = await bucket.get(packageBlobContentKey(match.blob.hashSha256));
  if (object === null) {
    throw new CargoFileNotExistError();
  }
  if (match.file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, pv.id);
  }
  return { stream: object.body, size: object.size, filename: match.file.name, created: match.file.createdUnix };
}

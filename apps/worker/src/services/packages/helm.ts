/**
 * The Helm registry protocol service (SPEC-0016 §7 M3) — the service half of
 * `/api/packages/{username}/helm/...` (upstream
 * routers/api/packages/helm/helm.go over CreatePackageOrAddFileToExisting /
 * AddFileToExistingPackage, packages.go:160/:247):
 *
 * - Chart upload (POST /api/charts): the RAW request body is the chart
 *   archive. Upstream buffers it into a hashed buffer, then
 *   ParseChartArchive (modules/packages/helm/metadata.go) gunzips → tars →
 *   finds the regular `Chart.yaml` member whose name has EXACTLY one slash
 *   (`<chart>/Chart.yaml`; root-level and nested copies are skipped,
 *   metadata.go:89-103), decodes it (limited to MaxMetadataSize = 32 MiB,
 *   limited_reader.go:14 — past the cap is ErrContentTooLarge, an
 *   InvalidArgument → 400), validates apiVersion/type/name and the semver
 *   version (ParseChartFile, metadata.go:106-131), and normalizes an invalid
 *   `home` to "". Our pass structure: PASS 1 spools the whole archive (the
 *   landed store), PASS 2a streams the spool through DecompressionStream +
 *   a minimal tar scanner for Chart.yaml, PASS 2b is the landed
 *   copySpoolToContentKey (the chart file IS the whole archive). Upstream's
 *   OverwriteExisting: true (helm.go:194) is honored: re-publishing a chart
 *   version with DIFFERENT bytes replaces the file row (delete + insert via
 *   the landed model exports) instead of answering 409.
 * - Provenance upload (POST /api/prov): ParseProvenanceFile reads the first
 *   1 MiB, clearsign-decodes it (upstream uses go-crypto clearsign.Decode —
 *   DECODE ONLY, the signature is not verified; the plaintext is a
 *   Chart.yaml), then AddFileToExistingPackage requires the version to exist
 *   (ErrPackageNotExist → 404) and adds `<name>-<version>.tgz.prov` with
 *   IsLead: false.
 * - Index (GET /index.yaml): SearchVersions over the owner's helm packages
 *   (upstream's default order — created DESC, id DESC), each version's
 *   MetadataJSON rendered inline into its ChartVersion entry with the
 *   canonical download URL (`urls`) and the creation timestamp, keyed by
 *   chart name (go-yaml emits map keys sorted), `apiVersion: v1`,
 *   `generated: now`, `serverInfo.contextPath` (helm.go:40-96).
 * - Download (GET /{filename}): upstream searches the owner's non-internal
 *   helm versions carrying a file with that EXACT name and requires
 *   EXACTLY ONE match (helm.go:99-139 — the route passes only {filename};
 *   the Name filter value comes back empty and ToConds skips empty filters,
 *   package_version.go:228-235). Then the version → file → blob walk with
 *   the lead-file GET counter bump.
 *
 * Divergences (documented per AGENTS.md): the clearsign decode is a minimal
 * armor parser (structure only — upstream also does not verify the
 * signature); GNU base-256 tar sizes and long-name (typeflag L) members are
 * not supported (the scanner answers 500 — upstream's Go tar handles them);
 * timestamps render ISO with millis where Go's time.Time renders nanos; the
 * semver check is hashicorp/go-version's semverRegexp shape (the module is
 * not vendored at this pin).
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import { packageFiles, packageVersions, packages } from "../../db/schema";
import {
  type PackageBlobRow,
  type PackageDoer,
  type PackageFileRow,
  type PackageOwnerRow,
  type PackagesQuotaConfig,
  type PackageVersionRow,
  checkCountQuotaExceeded,
  checkSizeQuotaExceeded,
  deletePackageFile,
  getFileDescriptors,
  getFileForVersionByName,
  getOrInsertPackage,
  getOrInsertVersion,
  getVersionByNameAndVersion,
  incrementDownloadCounter,
  searchVersions,
  tryInsertFile,
} from "./model";
import {
  copySpoolToContentKey,
  getOrInsertBlob,
  packageBlobContentKey,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import { isValidAbsoluteHttpUrl, writeVersionMetadata } from "./protocol-common";

// ---------------------------------------------------------------------------
// Errors — upstream's InvalidArgument sentinels answer 400 at the route
// (helm.go:160-166/:231-238); everything else is 500.
// ---------------------------------------------------------------------------

/** ErrMissingChartFile (metadata.go:21). */
export class HelmChartMissingError extends Error {
  constructor() {
    super("Chart.yaml file is missing");
    this.name = "HelmChartMissingError";
  }
}

/** ErrInvalidName (metadata.go:23). */
export class HelmNameInvalidError extends Error {
  constructor() {
    super("package name is invalid");
    this.name = "HelmNameInvalidError";
  }
}

/** ErrInvalidVersion (metadata.go:25). */
export class HelmVersionInvalidError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "HelmVersionInvalidError";
  }
}

/** ErrInvalidChart (metadata.go:27). */
export class HelmChartInvalidError extends Error {
  constructor() {
    super("chart is invalid");
    this.name = "HelmChartInvalidError";
  }
}

/** ErrInvalidProvenance (metadata.go:29). */
export class HelmProvenanceInvalidError extends Error {
  constructor() {
    super("provenance file is invalid");
    this.name = "HelmProvenanceInvalidError";
  }
}

/** ErrPackageNotExist at AddFileToExistingPackage (helm.go:265-266) → 404. */
export class HelmPackageNotExistError extends Error {
  constructor() {
    super("package does not exist");
    this.name = "HelmPackageNotExistError";
  }
}

/** A gzip/tar/YAML structural failure — upstream maps every NON
 *  InvalidArgument error to 500 (helm.go:163-165). */
export class HelmArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelmArchiveError";
  }
}

// ---------------------------------------------------------------------------
// Chart metadata (modules/packages/helm/metadata.go) — the JSON shape stored
// in package_versions.metadata_json uses upstream's json tags.
// ---------------------------------------------------------------------------

export interface HelmMaintainer {
  name?: string;
  email?: string;
  url?: string;
}

export interface HelmDependency {
  name: string;
  version?: string;
  repository: string;
  condition?: string;
  tags?: string[];
  enabled?: boolean;
  /** Upstream's json tag (the yaml tag spells it "import-values"). */
  import_values?: unknown[];
  alias?: string;
}

export interface HelmMetadata {
  /** Upstream's json tag for APIVersion (metadata.go:39). */
  api_version: string;
  type?: string;
  name: string;
  version: string;
  app_version?: string;
  home?: string;
  sources?: string[];
  description?: string;
  keywords?: string[];
  maintainers?: HelmMaintainer[];
  icon?: string;
  condition?: string;
  tags?: string;
  deprecated?: boolean;
  annotations?: Record<string, string>;
  kube_version?: string;
  dependencies?: HelmDependency[];
}

/** hashicorp/go-version's NewSemver shape: optional v, 1..n dotted numeric
 *  core, numeric-led or single-letter pre-release, dotted build metadata. */
const HELM_SEMVER_REGEX =
  /^v?[0-9]+(?:\.[0-9]+)*?(?:-[0-9][0-9A-Za-z\-~]*(?:\.[0-9A-Za-z\-~]+)*|-?[A-Za-z\-~])?(?:\+[0-9A-Za-z\-~]+(?:\.[0-9A-Za-z\-~]+)*)?$/;

/** createFilename (helm.go:278-280). */
export function createChartFilename(metadata: HelmMetadata): string {
  return `${metadata.name}-${metadata.version}.tgz`.toLowerCase();
}

/** createProvenanceFilename (helm.go:282-284). */
export function createProvenanceFilename(metadata: HelmMetadata): string {
  return `${metadata.name}-${metadata.version}.tgz.prov`.toLowerCase();
}

// YAML decode helpers — a type mismatch is a Go decode failure → 500
// (HelmArchiveError), matching helm.go's error classification.

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HelmArchiveError("chart metadata is not a mapping");
  }
  return value as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  // A bare `key:` decodes to null — go-yaml lands it in the zero string.
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HelmArchiveError(`chart field ${key} is not a string`);
  return value;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = optionalString(record, key) ?? "";
  return value;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HelmArchiveError(`chart field ${key} is not a string list`);
  }
  return value as string[];
}

function optionalMaintainers(record: Record<string, unknown>, key: string): HelmMaintainer[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HelmArchiveError(`chart field ${key} is not a list`);
  return value.map((entry) => {
    const map = asRecord(entry);
    const maintainer: HelmMaintainer = {};
    const name = optionalString(map, "name");
    const email = optionalString(map, "email");
    const url = optionalString(map, "url");
    if (name !== undefined) maintainer.name = name;
    if (email !== undefined) maintainer.email = email;
    if (url !== undefined) maintainer.url = url;
    return maintainer;
  });
}

function optionalAnnotations(record: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  const map = asRecord(value);
  const out: Record<string, string> = {};
  for (const [annotationKey, annotationValue] of Object.entries(map)) {
    if (typeof annotationValue !== "string") {
      throw new HelmArchiveError("chart annotations must be strings");
    }
    out[annotationKey] = annotationValue;
  }
  return out;
}

function optionalDependencies(record: Record<string, unknown>, key: string): HelmDependency[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HelmArchiveError(`chart field ${key} is not a list`);
  return value.map((entry) => {
    const map = asRecord(entry);
    const dependency: HelmDependency = {
      name: requiredString(map, "name"),
      repository: requiredString(map, "repository"),
    };
    const version = optionalString(map, "version");
    const condition = optionalString(map, "condition");
    const tags = optionalStringArray(map, "tags");
    const enabled = map["enabled"];
    const importValues = map["import_values"] ?? map["import-values"];
    const alias = optionalString(map, "alias");
    if (version !== undefined) dependency.version = version;
    if (condition !== undefined) dependency.condition = condition;
    if (tags !== undefined) dependency.tags = tags;
    if (typeof enabled === "boolean") dependency.enabled = enabled;
    else if (enabled !== undefined) throw new HelmArchiveError("chart dependency enabled is not a boolean");
    if (importValues !== undefined) {
      if (!Array.isArray(importValues)) throw new HelmArchiveError("chart dependency import values are not a list");
      dependency.import_values = importValues;
    }
    if (alias !== undefined) dependency.alias = alias;
    return dependency;
  });
}

/**
 * ParseChartFile (metadata.go:106-131): decode the Chart.yaml text, require
 * apiVersion, the application|library type, a name, a semver version, and
 * normalize an invalid `home` to "".
 */
export function parseChartYaml(bytes: Uint8Array): HelmMetadata {
  let doc: unknown;
  try {
    doc = yamlParse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new HelmArchiveError(`Chart.yaml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const map = asRecord(doc);

  const metadata: HelmMetadata = {
    api_version: requiredString(map, "apiVersion"),
    name: requiredString(map, "name"),
    version: requiredString(map, "version"),
  };
  if (metadata.api_version === "") throw new HelmChartInvalidError();

  const type = requiredString(map, "type");
  if (type !== "" && type !== "application" && type !== "library") throw new HelmChartInvalidError();
  if (type !== "") metadata.type = type;

  if (metadata.name === "") throw new HelmNameInvalidError();
  if (!HELM_SEMVER_REGEX.test(metadata.version)) throw new HelmVersionInvalidError();

  let home = requiredString(map, "home");
  if (!isValidAbsoluteHttpUrl(home)) home = "";
  if (home !== "") metadata.home = home;

  const sources = optionalStringArray(map, "sources");
  if (sources !== undefined && sources.length > 0) metadata.sources = sources;
  const description = optionalString(map, "description");
  if (description !== undefined && description !== "") metadata.description = description;
  const keywords = optionalStringArray(map, "keywords");
  if (keywords !== undefined && keywords.length > 0) metadata.keywords = keywords;
  const maintainers = optionalMaintainers(map, "maintainers");
  if (maintainers !== undefined && maintainers.length > 0) metadata.maintainers = maintainers;
  const icon = optionalString(map, "icon");
  if (icon !== undefined && icon !== "") metadata.icon = icon;
  const condition = optionalString(map, "condition");
  if (condition !== undefined && condition !== "") metadata.condition = condition;
  const tags = optionalString(map, "tags");
  if (tags !== undefined && tags !== "") metadata.tags = tags;
  const deprecated = map["deprecated"];
  if (deprecated !== undefined) {
    if (typeof deprecated !== "boolean") throw new HelmArchiveError("chart deprecated is not a boolean");
    if (deprecated) metadata.deprecated = true;
  }
  const annotations = optionalAnnotations(map, "annotations");
  if (annotations !== undefined && Object.keys(annotations).length > 0) metadata.annotations = annotations;
  const kubeVersion = optionalString(map, "kubeVersion");
  if (kubeVersion !== undefined && kubeVersion !== "") metadata.kube_version = kubeVersion;
  const dependencies = optionalDependencies(map, "dependencies");
  if (dependencies !== undefined && dependencies.length > 0) metadata.dependencies = dependencies;
  return metadata;
}

// ---------------------------------------------------------------------------
// The archive scan — DecompressionStream("gzip") + a minimal tar reader
// ---------------------------------------------------------------------------

/** packages.MaxMetadataSize (limited_reader.go:14). */
const MAX_METADATA_SIZE = 32 * 1024 * 1024;

/** Small buffered reader over a byte stream (compacting, grow-on-demand). */
class ByteReader {
  private buf = new Uint8Array(64 * 1024);
  private start = 0;
  private end = 0;
  private done = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** True when `n` bytes are buffered from the cursor. */
  async ensure(n: number): Promise<boolean> {
    if (this.end - this.start >= n) return true;
    if (this.done) return false;
    if (n > this.buf.byteLength) this.grow(n);
    this.buf.copyWithin(0, this.start, this.end);
    this.end -= this.start;
    this.start = 0;
    while (this.end < n && !this.done) {
      const read = await this.reader.read();
      if (read.done) {
        this.done = true;
        break;
      }
      if (this.end + read.value.byteLength > this.buf.byteLength) {
        this.grow(this.end + read.value.byteLength);
      }
      this.buf.set(read.value, this.end);
      this.end += read.value.byteLength;
    }
    return this.end - this.start >= n;
  }

  view(n: number): Uint8Array {
    return this.buf.subarray(this.start, this.start + n);
  }

  skip(n: number): void {
    this.start = Math.min(this.start + n, this.end);
  }

  /** Consume-and-discard `n` bytes, streaming the part that is not buffered. */
  async drain(n: number): Promise<void> {
    const buffered = Math.min(n, this.end - this.start);
    this.skip(buffered);
    let remaining = n - buffered;
    while (remaining > 0 && !this.done) {
      const read = await this.reader.read();
      if (read.done) {
        this.done = true;
        break;
      }
      remaining -= read.value.byteLength;
    }
    if (remaining > 0) throw new HelmArchiveError("tar archive ended mid-member");
  }

  grow(need: number): void {
    const grown = new Uint8Array(1 << Math.ceil(Math.log2(Math.max(need, 1024))));
    grown.set(this.buf.subarray(this.start, this.end), 0);
    this.end -= this.start;
    this.start = 0;
    this.buf = grown;
  }

  release(): void {
    try {
      this.reader.releaseLock();
    } catch {
      // The lock is already released.
    }
  }
}

function nullTerminated(bytes: Uint8Array): string {
  const stop = bytes.indexOf(0);
  return new TextDecoder("latin1").decode(stop === -1 ? bytes : bytes.subarray(0, stop));
}

function parseOctalSize(bytes: Uint8Array): number {
  if (bytes.length > 0 && (bytes[0] as number) & 0x80) {
    // GNU base-256 encoding — not supported (documented divergence).
    throw new HelmArchiveError("tar member uses a base-256 size");
  }
  const text = nullTerminated(bytes).trim();
  if (text === "") return 0;
  const size = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new HelmArchiveError("tar member size is malformed");
  }
  return size;
}

/**
 * ParseChartArchive's walk (metadata.go:80-105) over a streaming gunzip:
 * iterate tar members; the FIRST regular file whose basename is Chart.yaml
 * with EXACTLY one slash in its full name (`<chart>/Chart.yaml` — root-level
 * and deeper copies are skipped, metadata.go:93-96) answers its bytes. Null
 * when the archive ends without such a member (ErrMissingChartFile).
 */
export async function readChartYamlFromTarGz(source: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
  let decompressed: ReadableStream<Uint8Array>;
  try {
    decompressed = source.pipeThrough<Uint8Array>(new DecompressionStream("gzip"));
  } catch {
    throw new HelmArchiveError("the chart archive is not gzip");
  }
  const tarReader = new ByteReader(decompressed.getReader());
  try {
    for (;;) {
      if (!(await tarReader.ensure(512))) return null; // clean end of archive
      const header = tarReader.view(512);
      // Two consecutive zero blocks end the archive; one is enough here.
      if (header.every((byte) => byte === 0)) return null;
      const name = nullTerminated(header.subarray(0, 100));
      const prefix = nullTerminated(header.subarray(345, 500)); // ustar prefix
      const fullName = prefix !== "" ? `${prefix}/${name}` : name;
      const size = parseOctalSize(header.subarray(124, 136));
      const typeflag: number | undefined = header[156];
      const isRegular = typeflag === undefined || typeflag === 0x30 || typeflag === 0;
      const basename = fullName.slice(fullName.lastIndexOf("/") + 1);
      // metadata.go:92-96 — basename Chart.yaml, exactly one slash, regular.
      if (isRegular && basename === "Chart.yaml" && (fullName.match(/\//g) ?? []).length === 1) {
        if (size > MAX_METADATA_SIZE) {
          // ErrContentTooLarge (limited_reader.go:11) is InvalidArgument → 400.
          throw new HelmChartInvalidError();
        }
        tarReader.skip(512);
        if (!(await tarReader.ensure(size))) {
          throw new HelmArchiveError("Chart.yaml member is truncated");
        }
        return tarReader.view(size).slice();
      }
      await tarReader.drain(512 + Math.ceil(size / 512) * 512);
    }
  } catch (error) {
    // A gunzip/tar read failure surfaces as a rejected read — wrap it in the
    // 500 class upstream's non-InvalidArgument arm produces (helm.go:163-165),
    // letting the typed InvalidArgument errors pass through untouched.
    if (error instanceof HelmChartInvalidError || error instanceof HelmArchiveError) throw error;
    throw new HelmArchiveError(`the chart archive is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    tarReader.release();
  }
}

// ---------------------------------------------------------------------------
// The clearsign decode (ParseProvenanceFile, metadata.go:134-152) — upstream
// DECODES the armor and reads the plaintext; the signature is not verified.
// ---------------------------------------------------------------------------

export function decodeClearsignPlaintext(data: Uint8Array): Uint8Array | null {
  const text = new TextDecoder().decode(data);
  const lines = text.split(/\r?\n/);
  const begin = lines.findIndex((line) => line.startsWith("-----BEGIN PGP SIGNED MESSAGE-----"));
  if (begin === -1) return null;
  let cursor = begin + 1;
  // Armor headers ("Hash: SHA256", "Charset: ...") end at the blank line.
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === undefined || line === "" || !line.includes(":")) break;
    cursor++;
  }
  if (cursor >= lines.length || lines[cursor] !== "") return null;
  cursor++;
  const plaintext: string[] = [];
  let signatureAt = -1;
  for (; cursor < lines.length; cursor++) {
    if (lines[cursor]?.startsWith("-----BEGIN PGP SIGNATURE-----")) {
      signatureAt = cursor;
      break;
    }
    // Dash-escaped lines ("- leading dash") unescape.
    plaintext.push(lines[cursor]?.startsWith("- ") ? (lines[cursor] as string).slice(2) : (lines[cursor] as string));
  }
  if (signatureAt === -1) return null;
  const hasSignatureEnd = lines.some(
    (line, index) => index > signatureAt && line.startsWith("-----END PGP SIGNATURE-----"),
  );
  if (!hasSignatureEnd) return null;
  return new TextEncoder().encode(plaintext.join("\n"));
}

/** ParseProvenanceFile's read cap: io.LimitReader(r, 1<<20) (metadata.go:137). */
export const MAX_PROVENANCE_PARSE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Upload — UploadPackage / UploadProvenanceFile (helm.go:142-276)
// ---------------------------------------------------------------------------

export interface UploadHelmChartInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  /** The raw chart archive stream (the request body). */
  content: ReadableStream<Uint8Array>;
  declaredLength: number;
  quota: PackagesQuotaConfig;
  now?: Date;
  maxBytes?: number;
  spoolKey?: string;
}

export interface UploadHelmResult {
  descriptorFile: PackageFileRow;
  blob: PackageBlobRow;
  metadata: HelmMetadata;
  createdFile: boolean;
  /** True when an existing file row with different bytes was replaced
   *  (upstream's OverwriteExisting: true, helm.go:194/:260). */
  overwrote: boolean;
}

/**
 * The POST /api/charts walk. Count quota up-front (the landed generic
 * idiom); the size quota runs after the archive parsed, with the archive's
 * real size (upstream checks inside addFileToPackageVersion with the file
 * size, packages.go:305-312).
 */
export async function uploadHelmChart(input: UploadHelmChartInput): Promise<UploadHelmResult> {
  const now = input.now ?? new Date();
  await checkCountQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, input.quota);

  // PASS 1 — spool the whole archive (the store owns the 413 cap + length
  // check; the chart file IS the whole body here).
  const spooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: input.maxBytes,
    spoolKey: input.spoolKey,
  });

  try {
    // PASS 2a — gunzip + tar-scan for Chart.yaml, then parse it.
    const spoolObject = await input.bucket.get(spooled.spoolKey);
    if (spoolObject === null) {
      throw new Error("package spool object vanished");
    }
    const chartYaml = await readChartYamlFromTarGz(spoolObject.body as ReadableStream<Uint8Array>);
    if (chartYaml === null) throw new HelmChartMissingError();
    const metadata = parseChartYaml(chartYaml);

    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "helm", spooled.size, input.quota);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "helm",
      name: metadata.name,
      // SemverCompatible: true (helm.go:183).
      semverCompatible: true,
      now,
    });
    const { row: version, created: versionCreated } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: metadata.version,
      now,
    });
    // Metadata lands ONLY on a freshly created version (upstream marshals it
    // into the GetOrInsertVersion INSERT — a duplicate version keeps its
    // original metadata).
    if (versionCreated) {
      await writeVersionMetadata(input.d1, version.id, JSON.stringify(metadata));
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

    // OverwriteExisting: true (helm.go:194) — an existing file row with
    // different bytes is deleted (properties with it, the landed
    // deletePackageFile) and re-inserted; the same blob is the idempotent
    // no-op (upstream's short circuit, packages.go:336-339).
    const filename = createChartFilename(metadata);
    const existing = await getFileForVersionByName(input.d1, version.id, filename);
    let overwrote = false;
    if (existing !== null && existing.blobId !== blob.id) {
      await deletePackageFile(input.d1, existing.id);
      overwrote = true;
    }
    if (existing === null || existing.blobId !== blob.id) {
      const fileResult = await tryInsertFile(input.d1, {
        versionId: version.id,
        blobId: blob.id,
        name: filename,
        isLead: true,
        now,
      });
      if (fileResult.outcome === "conflict") {
        // A concurrent publisher re-took the name between the delete and the
        // insert — upstream serializes through globallock, ours arbitrates on
        // the D1 UNIQUE and answers the duplicate arm.
        throw new Error("package file insert raced an overwrite");
      }
      return { descriptorFile: fileResult.row, blob, metadata, createdFile: fileResult.outcome === "created", overwrote };
    }
    return { descriptorFile: existing, blob, metadata, createdFile: false, overwrote };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

export type UploadHelmProvenanceInput = UploadHelmChartInput;

/**
 * The POST /api/prov walk (helm.go:213-276): decode the clearsign plaintext
 * as a Chart.yaml, then AddFileToExistingPackage — the version must already
 * exist (ErrPackageNotExist → 404) and the prov lands with IsLead: false.
 */
export async function uploadHelmProvenance(input: UploadHelmProvenanceInput): Promise<UploadHelmResult> {
  const now = input.now ?? new Date();
  await checkCountQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, input.quota);

  const spooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: input.maxBytes,
    spoolKey: input.spoolKey,
  });

  try {
    // ParseProvenanceFile reads only the first MiB (metadata.go:137).
    const headLength = Math.min(spooled.size, MAX_PROVENANCE_PARSE_BYTES);
    const head = await input.bucket.get(spooled.spoolKey, { range: { offset: 0, length: headLength } });
    if (head === null) {
      throw new Error("package spool object vanished");
    }
    const plaintext = decodeClearsignPlaintext(new Uint8Array(await head.arrayBuffer()));
    if (plaintext === null) throw new HelmProvenanceInvalidError();
    const metadata = parseChartYaml(plaintext);

    // AddFileToExistingPackage: GetVersionByNameAndVersion or
    // ErrPackageNotExist (packages.go:247-256).
    const version: PackageVersionRow | null = await getVersionByNameAndVersion(
      input.d1,
      input.owner.id,
      "helm",
      metadata.name,
      metadata.version,
    );
    if (version === null) throw new HelmPackageNotExistError();

    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "helm", spooled.size, input.quota);

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

    const filename = createProvenanceFilename(metadata);
    const existing = await getFileForVersionByName(input.d1, version.id, filename);
    let overwrote = false;
    if (existing !== null && existing.blobId !== blob.id) {
      await deletePackageFile(input.d1, existing.id);
      overwrote = true;
    }
    if (existing === null || existing.blobId !== blob.id) {
      const fileResult = await tryInsertFile(input.d1, {
        versionId: version.id,
        blobId: blob.id,
        name: filename,
        isLead: false, // IsLead: false (helm.go:259)
        now,
      });
      if (fileResult.outcome === "conflict") {
        throw new Error("package file insert raced an overwrite");
      }
      return { descriptorFile: fileResult.row, blob, metadata, createdFile: fileResult.outcome === "created", overwrote };
    }
    return { descriptorFile: existing, blob, metadata, createdFile: false, overwrote };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Index — helm.Index (helm.go:40-96)
// ---------------------------------------------------------------------------

/**
 * The index.yaml document: every non-internal helm version of the owner,
 * entries keyed by chart name (sorted keys — go-yaml emits map keys sorted),
 * each entry rendering the stored metadata inline (upstream's yaml field
 * order), then urls/created. Returns the YAML text.
 */
export async function buildHelmIndexYaml(
  d1: D1Database,
  baseUrl: string,
  ownerId: number,
  generatedAt?: Date,
): Promise<string> {
  // Upstream SearchVersions with no paginator returns EVERY row in the
  // default order (created DESC, id DESC — package_version.go:289-291); the
  // explicit large limit stands in for "no pagination".
  const { rows } = await searchVersions(d1, {
    ownerId,
    type: "helm",
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });

  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    // Upstream unmarshals MetadataJSON into helm_module.Metadata; a decode
    // failure is a 500 (helm.go:74-78).
    let stored: unknown;
    try {
      stored = row.version.metadataJson === null ? {} : JSON.parse(row.version.metadataJson);
    } catch (error) {
      throw new HelmArchiveError(`stored chart metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const metadata = asRecord(stored);
    const name = requiredString(metadata, "name");
    const entry: Record<string, unknown> = {};
    // Inline helm_module.Metadata in its yaml field order; name/version are
    // not omitempty upstream, the rest render only when present.
    entry.apiVersion = optionalString(metadata, "api_version") ?? "";
    const type = optionalString(metadata, "type");
    if (type !== undefined && type !== "") entry.type = type;
    entry.name = name;
    entry.version = requiredString(metadata, "version");
    const appVersion = optionalString(metadata, "app_version");
    if (appVersion !== undefined && appVersion !== "") entry.appVersion = appVersion;
    const home = optionalString(metadata, "home");
    if (home !== undefined && home !== "") entry.home = home;
    const sources = optionalStringArray(metadata, "sources");
    if (sources !== undefined && sources.length > 0) entry.sources = sources;
    const description = optionalString(metadata, "description");
    if (description !== undefined && description !== "") entry.description = description;
    const keywords = optionalStringArray(metadata, "keywords");
    if (keywords !== undefined && keywords.length > 0) entry.keywords = keywords;
    const maintainers = optionalMaintainers(metadata, "maintainers");
    if (maintainers !== undefined && maintainers.length > 0) entry.maintainers = maintainers;
    const icon = optionalString(metadata, "icon");
    if (icon !== undefined && icon !== "") entry.icon = icon;
    const condition = optionalString(metadata, "condition");
    if (condition !== undefined && condition !== "") entry.condition = condition;
    const tags = optionalString(metadata, "tags");
    if (tags !== undefined && tags !== "") entry.tags = tags;
    const deprecated = metadata["deprecated"];
    if (deprecated === true) entry.deprecated = true;
    const annotations = optionalAnnotations(metadata, "annotations");
    if (annotations !== undefined && Object.keys(annotations).length > 0) entry.annotations = annotations;
    const kubeVersion = optionalString(metadata, "kube_version");
    if (kubeVersion !== undefined && kubeVersion !== "") entry.kubeVersion = kubeVersion;
    const dependencies = optionalDependencies(metadata, "dependencies");
    if (dependencies !== undefined && dependencies.length > 0) {
      // The yaml tag spells it "import-values" (metadata.go:76).
      entry.dependencies = dependencies.map((dep) => {
        const { import_values, ...rest } = dep;
        return import_values !== undefined ? { ...rest, "import-values": import_values } : rest;
      });
    }
    // URLs: baseURL + "/" + the escaped canonical filename (helm.go:83).
    const filename = `${name}-${entry.version as string}.tgz`.toLowerCase();
    entry.urls = [`${baseUrl}/${encodeURIComponent(filename)}`];
    // Created (helm.go:82) — ISO with millis where Go renders RFC3339 nanos.
    entry.created = row.version.createdUnix.toISOString();
    const list = grouped.get(name);
    if (list === undefined) grouped.set(name, [entry]);
    else list.push(entry);
  }

  const entries: Record<string, Record<string, unknown>[]> = {};
  for (const name of [...grouped.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    entries[name] = grouped.get(name) as Record<string, unknown>[];
  }

  // serverInfo.contextPath: AppSubURL + the mount path (helm.go:93) — the
  // base URL's pathname stands in for AppSubURL being empty.
  let contextPath = baseUrl;
  try {
    contextPath = new URL(baseUrl).pathname;
  } catch {
    // A relative base URL renders verbatim.
  }
  return yamlStringify({
    apiVersion: "v1",
    entries,
    generated: (generatedAt ?? new Date()).toISOString(),
    serverInfo: { contextPath },
  }, { indent: 4 });
}

// ---------------------------------------------------------------------------
// Download — helm.DownloadPackageFile (helm.go:99-139)
// ---------------------------------------------------------------------------

export interface HelmDownload {
  descriptor: { file: PackageFileRow; blob: PackageBlobRow };
  version: PackageVersionRow;
  stream: ReadableStream;
  size: number;
}

/**
 * The filename-keyed walk: the owner's non-internal helm versions carrying a
 * file with this EXACT name must answer EXACTLY ONE version row (upstream's
 * `len(pvs) != 1` → 404, helm.go:116-119 — the Name filter's value comes
 * back empty from the route and ToConds skips it,
 * package_version.go:228-235). Null = 404.
 */
export async function openHelmFileForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  filename: string,
  method: "GET" | "HEAD",
): Promise<HelmDownload | null> {
  if (filename === "") return null;
  const db = drizzle(d1);
  const matches = await db
    .select({ version: packageVersions })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .innerJoin(packageFiles, eq(packageFiles.versionId, packageVersions.id))
    .where(
      and(
        eq(packages.ownerId, owner.id),
        eq(packages.type, "helm"),
        eq(packages.isInternal, false),
        eq(packageVersions.isInternal, false),
        eq(packageFiles.lowerName, filename.toLowerCase()),
      ),
    )
    .all();
  if (matches.length !== 1) return null;
  const version = matches[0]?.version;
  if (version === undefined) return null;

  const file = await getFileForVersionByName(d1, version.id, filename);
  if (file === null) return null;
  const descriptors = await getFileDescriptors(d1, version.id);
  const match = descriptors.find((entry) => entry.file.id === file.id);
  if (match === undefined) return null;
  const object = await bucket.get(packageBlobContentKey(match.blob.hashSha256));
  if (object === null) return null;
  // OpenBlobForDownload's lead-file GET counter bump (packages.go:655-660):
  // the chart counts, the .prov never does.
  if (file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, version.id);
  }
  return { descriptor: match, version, stream: object.body, size: object.size };
}

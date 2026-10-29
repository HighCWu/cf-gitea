/**
 * The NuGet registry protocol service (SPEC-0016 §7 M5) — the service half of
 * `/api/packages/{username}/nuget/...` (upstream routers/api/packages/nuget,
 * the family SPEC-0016 §2.1 sizes as the largest single-ecosystem wire:
 * nuget.go 698 + api_v2.go 416 + api_v3.go 313 + links.go 52 + auth.go 26,
 * over modules/packages/nuget/metadata.go 276 + symbol_extractor.go 190):
 *
 * - PUT / (UploadPackage, nuget.go:426-499): the nupkg is a ZIP; the root
 *   .nuspec (no "/" in the name, ≤ 3 MiB uncompressed — metadata.go:47,163)
 *   parses into id/version/metadata; the version runs hashicorp go-version's
 *   NewSemver (metadata.go:178) and is stored NORMALIZED
 *   (toNormalizedVersion, metadata.go:264-276 — "1.04.5.2.5-rc.1+metadata"
 *   publishes as "1.4.5.2-rc.1", the fifth segment dropped); the nupkg lands
 *   as the lead file `{id}.{version}.nupkg` (lowercased) and the ORIGINAL
 *   nuspec bytes as a second file `{id}.nuspec`; SemverCompatible=true;
 *   duplicate version → 409 BEFORE the quota checks (the createPackageAndVersion
 *   ordering — count quota runs only for a fresh version, packages.go:214-219);
 *   the nuspec add rides AddFileToPackageVersionInternal which SKIPS quota
 *   (services/packages/packages.go:222-229 — the dead 403 switch in nuget.go
 *   is defensive only).
 * - PUT /symbolpackage (nuget.go:503-594): a SymbolsPackage nuspec (the
 *   `<packageTypes><packageType name="SymbolsPackage"/>` arm,
 *   metadata.go:187-193); ExtractPortablePdb (symbol_extractor.go:44-110)
 *   walks the zip — .nuspec/.xml/.psmdcp/.rels/.p7s skipped, .pdb parsed for
 *   the BSJB magic + #Pdb stream GUID (ParseDebugHeaderID :113-190, 256 MiB
 *   total cap), any other extension is ErrInvalidFiles; the snupkg lands
 *   `{id}.{version}.snupkg` and each pdb `{name}` with the pdb id as
 *   CompositeKey + a `nuget.symbol.id` file property; the version must exist
 *   (404), duplicates answer 409 REGARDLESS of bytes (upstream TryInsertFile,
 *   package_file.go:46-58 — no bytes comparison).
 * - GET /index.json (V3 service index), /query (V3 search), /registration/
 *   {id}/index.json + /{version}[.json] (registration index/leaf, semver
 *   ascending), /package/{id}/index.json + /{version}/{filename} (the
 *   package-base-address family: enumerate + ANY file download with the
 *   lead-file GET counter bump).
 * - The V2 OData feed (api_v2.go): / (service index), /$metadata (the static
 *   Edmx document, api_v2.go:100-231), /Packages(Id='…',Version='…') (the
 *   namespaced entry), /Packages(), /Search() (the latest-versions feed with
 *   the `$skip`/`$top` next link), /FindPackagesById() (all versions) and
 *   their /$count arms; getSearchTerm (nuget.go:98-121) trims quotes from
 *   searchTerm or extracts the quoted term from an OData `$filter` (exact
 *   when ` eq '` matches).
 * - DELETE /{id}/{version} → RemovePackageVersionByNameAndVersion (204; 404
 *   unknown), /symbols/{filename}/{guid}/{filename2} → the symbol query
 *   protocol (filename == filename2, the file property match, exactly one
 *   hit).
 * - Errors are `{"Message": ...}` JSON (nuget.go:30-35, helper.go:28-48:
 *   400/404 pass the error text, 500 answers "internal server error").
 * - Auth (nuget.Auth, auth.go:23-26): the Basic/bearer credential pass, with
 *   X-NuGet-ApiKey as the FALLBACK token source (upstream VerifyAuthToken's
 *   apiKey arm — Authorization wins when both are present).
 *
 * XML is hand-built (AGENTS.md: no new deps) with Go encoding/xml's exact
 * posture verified at the pin: NO self-closing tags except the verbatim
 * `,innerxml` content workaround (nuget.go:340-342 — "force a self-closing
 * tag to satisfy XmlReader.IsEmptyElement"), attributes in struct-field
 * order, EscapeText's escape set, RFC3339Nano timestamps in UTC (Workers has
 * no server-local zone — upstream renders CreatedUnix.AsLocalTime()).
 *
 * Divergences (documented per AGENTS.md): the upload is BUFFERED under a
 * 64 MiB cap (upstream streams into a spooling HashedBuffer; the workerd
 * isolate ceiling forces the threshold — npm's own divergence) with a 413 arm
 * upstream lacks; a lying Content-Length answers 500 like npm's
 * non-InvalidArgument posture (upstream would fail the zip parse → 400 — our
 * cap check runs BEFORE the parse); dependency-group map order is
 * deterministic (sorted framework keys — upstream iterates a Go map,
 * unspecified); the zip reader is an EOCD + central-directory walk (stored +
 * deflate-raw entries; zip64 not needed under the cap); PDB EOF error texts
 * carry "unexpected EOF" where Go's binary.Read says "EOF"; error texts carry
 * our parse-error wording where Go embeds decoder line numbers.
 */

import { and, asc, desc, eq, inArray, like, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageBlobs, packageFiles, packageProperties, packageVersions, packages } from "../../db/schema";
import {
  type PackageBlobRow,
  type PackageDoer,
  type PackageFileRow,
  type PackageOwnerRow,
  type PackagesQuotaConfig,
  type PackageRow,
  type PackageVersionRow,
  UNLIMITED_QUOTA,
  QuotaTotalCountError,
  checkSizeQuotaExceeded,
  countVersions,
  deletePackageVersionAndReferences,
  getFileForVersionByName,
  getOrInsertPackage,
  getOrInsertVersion,
  getVersionByNameAndVersion,
  incrementDownloadCounter,
  tryInsertFile,
} from "./model";
import {
  copySpoolToContentKey,
  getBlobById,
  getOrInsertBlob,
  packageBlobContentKey,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import { goQueryEscape, parseGoSemver, parseGoVersion, type GoVersion } from "./npm";

// ---------------------------------------------------------------------------
// Errors — metadata.go's InvalidArgument sentinels answer 400 at the route;
// plain parse errors answer 500 ("internal server error" in production,
// helper.go:29-44).
// ---------------------------------------------------------------------------

/** ErrMissingNuspecFile (metadata.go:24). */
export class NugetMissingNuspecFileError extends Error {
  constructor() {
    super("Nuspec file is missing");
    this.name = "NugetMissingNuspecFileError";
  }
}

/** ErrNuspecFileTooLarge (metadata.go:26). */
export class NugetNuspecFileTooLargeError extends Error {
  constructor() {
    super("Nuspec file is too large");
    this.name = "NugetNuspecFileTooLargeError";
  }
}

/** ErrNuspecInvalidID (metadata.go:28). */
export class NugetNuspecInvalidIDError extends Error {
  constructor() {
    super("Nuspec file contains an invalid id");
    this.name = "NugetNuspecInvalidIDError";
  }
}

/** ErrNuspecInvalidVersion (metadata.go:30). */
export class NugetNuspecInvalidVersionError extends Error {
  constructor() {
    super("Nuspec file contains an invalid version");
    this.name = "NugetNuspecInvalidVersionError";
  }
}

/** nuget.go:626 — errors.New("unexpected package type"), status 400 explicit. */
export class NugetUnexpectedPackageTypeError extends Error {
  constructor() {
    super("unexpected package type");
    this.name = "NugetUnexpectedPackageTypeError";
  }
}

/** The ExtractPortablePdb InvalidArgument set (symbol_extractor.go:21-24). */
export class NugetMissingPdbFilesError extends Error {
  constructor() {
    super("package does not contain PDB files");
    this.name = "NugetMissingPdbFilesError";
  }
}

export class NugetInvalidFilesError extends Error {
  constructor() {
    super("package contains invalid files");
    this.name = "NugetInvalidFilesError";
  }
}

/** The wrapped "Invalid PDB file: …" arm (symbol_extractor.go:81) — plain
 *  error → the route's 500, like upstream's non-InvalidArgument wrap. */
export class NugetInvalidPdbError extends Error {
  constructor(detail: string) {
    super(`Invalid PDB file: ${detail}`);
    this.name = "NugetInvalidPdbError";
  }
}

/** The zip-open failure (metadata.go:142-144 — InvalidArgument, message
 *  carries the underlying reason). */
export class NugetInvalidPackageArchiveError extends Error {
  constructor(detail: string) {
    super(`unable to parse package meta: ${detail}`);
    this.name = "NugetInvalidPackageArchiveError";
  }
}

/** The duplicate sentinel the route maps to 409 (nuget.go:461-462). */
export class NugetDuplicateVersionError extends Error {
  constructor(readonly existing: PackageVersionRow) {
    super("package version already exists");
    this.name = "NugetDuplicateVersionError";
  }
}

/** The ErrPackageNotExist shape the route maps to 404. */
export class NugetPackageNotExistError extends Error {
  constructor() {
    super("package does not exist");
    this.name = "NugetPackageNotExistError";
  }
}

/** The ErrDuplicatePackageFile shape → 409 (the symbol package arms). */
export class NugetDuplicatePackageFileError extends Error {
  constructor() {
    super("package file already exists");
    this.name = "NugetDuplicatePackageFileError";
  }
}

/** The upload buffering cap (the module divergence note) → 413. */
export const MAX_NUGET_UPLOAD_BYTES = 64 * 1024 * 1024;

/** The buffered-upload cap arm → 413 (our threshold, npm's arm shape). */
export class NugetBodyTooLargeError extends Error {
  constructor() {
    super("http: request body too large");
    this.name = "NugetBodyTooLargeError";
  }
}

// ---------------------------------------------------------------------------
// hashicorp go-version — validation (NewSemver), the descriptor's SemVer
// (NewVersion — version.NewVersion(pv.Version), descriptor.go:151-158) and
// toNormalizedVersion ride the npm module's PROVEN port (parseGoSemver /
// parseGoVersion); the segments rule is applied over the canonical string.
// ---------------------------------------------------------------------------

/** metadata.go:45 — `\A\w+(?:[.-]\w+)*\z` (\w = [0-9A-Za-z_], ASCII). */
const NUGET_ID_REGEX = /^[0-9A-Za-z_]+(?:[.-][0-9A-Za-z_]+)*$/;

export function validateNugetId(id: string): boolean {
  return NUGET_ID_REGEX.test(id);
}

/**
 * toNormalizedVersion (metadata.go:264-276) over the go-version canonical
 * form: print segments 0-2, print segment 3 only when it exists AND > 0,
 * drop everything beyond, then append the prerelease. Metadata is dropped.
 */
export function toNormalizedVersion(v: GoVersion): string {
  // The canonical string is `segments.join(".")[-pre][+meta]` — split off the
  // metadata (first "+"), then the prerelease (first "-"; a semver prerelease
  // never contains "+" and the core is all digits/dots).
  let rest = v.canonical;
  const plusAt = rest.indexOf("+");
  if (plusAt !== -1) rest = rest.slice(0, plusAt);
  const dashAt = rest.indexOf("-");
  const core = dashAt === -1 ? rest : rest.slice(0, dashAt);
  const pre = dashAt === -1 ? "" : rest.slice(dashAt + 1);
  const segments = core.split(".").map((part) => Number.parseInt(part, 10));
  if (segments.length < 3 || segments.some((s) => !Number.isSafeInteger(s))) {
    // Unreachable over parseGoSemver's own output — a defensive gate.
    throw new Error(`go-version canonical form is malformed: ${v.canonical}`);
  }
  let out = `${segments[0]}.${segments[1]}.${segments[2]}`;
  if (segments.length > 3 && (segments[3] as number) > 0) {
    out += `.${segments[3]}`;
  }
  if (pre !== "") out += `-${pre}`;
  return out;
}

// ---------------------------------------------------------------------------
// The NuGet module Metadata (modules/packages/nuget/metadata.go:59-85's json
// tags) — the shape stored in package_versions.metadata_json and rendered
// back out by every V2/V3 read.
// ---------------------------------------------------------------------------

export interface NugetDependency {
  id: string;
  version: string;
}

export interface NugetMetadata {
  authors: string;
  copyright: string;
  description: string;
  developmentDependency: boolean;
  iconUrl: string;
  language: string;
  licenseUrl: string;
  minClientVersion: string;
  owners: string;
  projectUrl: string;
  readme: string;
  releaseNotes: string;
  repositoryUrl: string;
  requireLicenseAcceptance: boolean;
  summary: string;
  tags: string;
  title: string;
  /** Framework group → dependencies ("" = the groupless `<dependency>` arm). */
  dependencies: Record<string, NugetDependency[]>;
}

const NUGET_METADATA_EMPTY: NugetMetadata = {
  authors: "",
  copyright: "",
  description: "",
  developmentDependency: false,
  iconUrl: "",
  language: "",
  licenseUrl: "",
  minClientVersion: "",
  owners: "",
  projectUrl: "",
  readme: "",
  releaseNotes: "",
  repositoryUrl: "",
  requireLicenseAcceptance: false,
  summary: "",
  tags: "",
  title: "",
  dependencies: {},
};

/** PropertyTypeFile property name (metadata.go:42). */
export const NUGET_SYMBOL_ID_PROPERTY = "nuget.symbol.id";

/**
 * The descriptor's metadata unmarshal (descriptor.go:243-249): parse the
 * stored JSON into the full NugetMetadata shape — nulls/absent keys land in
 * zero values, unknown keys dropped, a broken JSON or a type mismatch throws
 * (the route's 500 arm).
 */
export function nugetMetadataFromJson(raw: string | null): NugetMetadata {
  const out: NugetMetadata = { ...NUGET_METADATA_EMPTY, dependencies: {} };
  if (raw === null) return out;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error("stored nuget metadata is not valid JSON");
  }
  if (doc === null) return out;
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("stored nuget metadata is not an object");
  }
  const source = doc as Record<string, unknown>;
  // The stored JSON keys are upstream Metadata's json tags — snake_case —
  // mapped onto the camelCase interface fields.
  const stringFields: [
    string,
    keyof Pick<NugetMetadata, "authors" | "copyright" | "description" | "iconUrl" | "language" | "licenseUrl" | "minClientVersion" | "owners" | "projectUrl" | "readme" | "releaseNotes" | "repositoryUrl" | "summary" | "tags" | "title">,
  ][] = [
    ["authors", "authors"],
    ["copyright", "copyright"],
    ["description", "description"],
    ["icon_url", "iconUrl"],
    ["language", "language"],
    ["license_url", "licenseUrl"],
    ["min_client_version", "minClientVersion"],
    ["owners", "owners"],
    ["project_url", "projectUrl"],
    ["readme", "readme"],
    ["release_notes", "releaseNotes"],
    ["repository_url", "repositoryUrl"],
    ["summary", "summary"],
    ["tags", "tags"],
    ["title", "title"],
  ];
  for (const [storedKey, field] of stringFields) {
    const value = source[storedKey];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new Error(`stored nuget metadata field ${storedKey} is not a string`);
    out[field] = value;
  }
  const boolFields: [string, "developmentDependency" | "requireLicenseAcceptance"][] = [
    ["development_dependency", "developmentDependency"],
    ["require_license_acceptance", "requireLicenseAcceptance"],
  ];
  for (const [storedKey, field] of boolFields) {
    const value = source[storedKey];
    if (value === undefined || value === null) continue;
    if (typeof value !== "boolean") throw new Error(`stored nuget metadata field ${storedKey} is not a boolean`);
    out[field] = value;
  }
  const rawDeps = source["dependencies"];
  if (rawDeps !== undefined && rawDeps !== null) {
    if (typeof rawDeps !== "object" || Array.isArray(rawDeps)) {
      throw new Error("stored nuget metadata field dependencies is not an object");
    }
    for (const [group, entries] of Object.entries(rawDeps as Record<string, unknown>)) {
      if (!Array.isArray(entries)) throw new Error("stored nuget metadata dependency group is not a list");
      const deps: NugetDependency[] = [];
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error("stored nuget metadata dependency is not an object");
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.id !== "string" || typeof record.version !== "string") {
          throw new Error("stored nuget metadata dependency fields are not strings");
        }
        deps.push({ id: record.id, version: record.version });
      }
      out.dependencies[group] = deps;
    }
  }
  return out;
}

/**
 * json.Marshal(Metadata) at INSERT time (packages.go:169-172): struct field
 * order, omitempty semantics (require_license_acceptance has NONE — always
 * present; dependencies omitted when the map is empty), map keys sorted
 * (encoding/json's own rule).
 */
export function serializeNugetMetadata(metadata: NugetMetadata): string {
  const record: Record<string, unknown> = {};
  const putOmit = (key: string, value: string | boolean | undefined): void => {
    if (value === "" || value === false || value === undefined) return;
    record[key] = value;
  };
  putOmit("authors", metadata.authors);
  putOmit("copyright", metadata.copyright);
  putOmit("description", metadata.description);
  putOmit("development_dependency", metadata.developmentDependency);
  putOmit("icon_url", metadata.iconUrl);
  putOmit("language", metadata.language);
  putOmit("license_url", metadata.licenseUrl);
  putOmit("min_client_version", metadata.minClientVersion);
  putOmit("owners", metadata.owners);
  putOmit("project_url", metadata.projectUrl);
  putOmit("readme", metadata.readme);
  putOmit("release_notes", metadata.releaseNotes);
  putOmit("repository_url", metadata.repositoryUrl);
  // require_license_acceptance carries no omitempty — always serialized.
  record["require_license_acceptance"] = metadata.requireLicenseAcceptance;
  putOmit("summary", metadata.summary);
  putOmit("tags", metadata.tags);
  putOmit("title", metadata.title);
  if (Object.keys(metadata.dependencies).length > 0) {
    const sorted: Record<string, unknown> = {};
    for (const group of [...Object.keys(metadata.dependencies)].sort()) {
      sorted[group] = (metadata.dependencies[group] ?? []).map((dep) => ({ id: dep.id, version: dep.version }));
    }
    record["dependencies"] = sorted;
  }
  // Every record key was inserted in struct order and the dependencies map
  // is pre-sorted above — plain JSON.stringify is already deterministic.
  return JSON.stringify(record);
}

// ---------------------------------------------------------------------------
// Go's XML writer — encoding/xml with NO self-closing tags (nuget.go:340-342's
// workaround comment proves it), attributes in struct-field order, EscapeText.
// ---------------------------------------------------------------------------

/** encoding/xml EscapeText's exact set (verified against the Go stdlib). */
function xmlEscape(text: string): string {
  let out = "";
  for (const ch of text) {
    switch (ch) {
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
        out += ch;
    }
  }
  return out;
}

/** An element: `<name a="v">children</name>` — never self-closes (Go). */
function el(name: string, attrs: [string, string][] = [], children: string[] = []): string {
  const head =
    attrs.length > 0
      ? `<${name} ${attrs.map(([key, value]) => `${key}="${xmlEscape(value)}"`).join(" ")}>`
      : `<${name}>`;
  return `${head}${children.join("")}</${name}>`;
}

/** A chardata element (optionally with a `type` attribute — TypedValue). */
function textEl(name: string, text: string, typeAttr?: string): string {
  const attrs: [string, string][] = typeAttr !== undefined ? [["type", typeAttr]] : [];
  return el(name, attrs, [xmlEscape(text)]);
}

/** RFC3339Nano in UTC (Go time.Time XML/JSON rendering; trailing zeros of the
 *  fraction trimmed, a zero fraction omitted entirely). */
export function goRFC3339(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  let out = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  const ms = date.getUTCMilliseconds();
  if (ms !== 0) {
    out += `.${pad(ms, 3).replace(/0+$/, "")}`;
  }
  return `${out}Z`;
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';

// ---------------------------------------------------------------------------
// The zip reader — an EOCD + central-directory walk (the tar-scan idiom:
// hand-built binary parse, no deps). Stored (method 0) and deflate (method 8,
// DecompressionStream("deflate-raw")) entries; zip64 is out of scope under
// the upload cap.
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  method: number;
  uncompressedSize: number;
  data(): Promise<Uint8Array>;
}

interface ZipEntryRaw {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) |
    ((bytes[offset + 1] as number) << 8) |
    ((bytes[offset + 2] as number) << 16) |
    ((bytes[offset + 3] as number) << 24)
  ) >>> 0;
}

const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** Parse the central directory; a missing EOCD or a bad signature is the
 *  zip.NewReader failure (metadata.go:142-144). */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  // EOCD lives in the last 22 + 65535 bytes (max comment length).
  const window = Math.min(bytes.byteLength, 22 + 65535);
  let eocdAt = -1;
  for (let i = bytes.byteLength - 22; i >= bytes.byteLength - window; i--) {
    if (u32(bytes, i) === EOCD_SIGNATURE) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0 || bytes.byteLength - eocdAt < 22) {
    throw new NugetInvalidPackageArchiveError("zip: not a valid zip file");
  }
  const entryCount = u16(bytes, eocdAt + 10);
  const cdSize = u32(bytes, eocdAt + 12);
  const cdOffset = u32(bytes, eocdAt + 16);
  if (cdOffset + cdSize > bytes.byteLength) {
    throw new NugetInvalidPackageArchiveError("zip: not a valid zip file");
  }
  const entries: ZipEntryRaw[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > bytes.byteLength || u32(bytes, cursor) !== CD_SIGNATURE) {
      throw new NugetInvalidPackageArchiveError("zip: not a valid zip file");
    }
    const flags = u16(bytes, cursor + 8);
    const nameLength = u16(bytes, cursor + 28);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    entries.push({
      name: (flags & 0x800) !== 0 ? new TextDecoder().decode(nameBytes) : latin1(nameBytes),
      method: u16(bytes, cursor + 10),
      compressedSize: u32(bytes, cursor + 20),
      uncompressedSize: u32(bytes, cursor + 24),
      localHeaderOffset: u32(bytes, cursor + 42),
    });
    cursor += 46 + nameLength + u16(bytes, cursor + 30) + u16(bytes, cursor + 32);
  }
  return entries.map((entry) => ({
    name: entry.name,
    method: entry.method,
    uncompressedSize: entry.uncompressedSize,
    async data(): Promise<Uint8Array> {
      return extractEntry(bytes, entry);
    },
  }));
}

async function extractEntry(bytes: Uint8Array, entry: ZipEntryRaw): Promise<Uint8Array> {
  if (entry.localHeaderOffset + 30 > bytes.byteLength || u32(bytes, entry.localHeaderOffset) !== LOCAL_SIGNATURE) {
    throw new Error("zip: invalid local header");
  }
  const nameLength = u16(bytes, entry.localHeaderOffset + 26);
  const extraLength = u16(bytes, entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) {
    return compressed.slice();
  }
  if (entry.method === 8) {
    const inflated = new Response(compressed.slice()).body!.pipeThrough(new DecompressionStream("deflate-raw"));
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = inflated.getReader();
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      total += read.value.byteLength;
      // The zip-bomb gate: the claimed uncompressed size bounds the output.
      if (total > entry.uncompressedSize) {
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
    return out;
  }
  throw new Error(`zip: unsupported compression method ${entry.method}`);
}

// ---------------------------------------------------------------------------
// The nuspec XML parse (metadata.go:87-260) — a minimal XML DOM over the
// shapes the struct tags pin. Go's Decode errors (malformed markup, empty
// content) are PLAIN errors → the route's 500; only the four InvalidArgument
// sentinels answer 400.
// ---------------------------------------------------------------------------

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  /** Child elements, in document order. */
  children: XmlElement[];
  /** The element's own text (chardata, entities decoded, CDATA raw). */
  text: string;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+[0-9]*?);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : whole;
    }
    switch (body) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return whole;
    }
  });
}

/** A minimal well-formedness parser: elements, attributes, text, comments,
 *  CDATA, PI/declaration. Errors are plain (→ 500, Go's Decode arm). */
function parseXmlElement(source: string): XmlElement {
  let pos = 0;
  const length = source.length;

  const skipMisc = (): void => {
    for (;;) {
      while (pos < length && /\s/.test(source[pos] as string)) pos++;
      if (pos < length && source[pos] === "<") {
        if (source.startsWith("<!--", pos)) {
          const end = source.indexOf("-->", pos + 4);
          if (end === -1) throw new Error("XML syntax error: unterminated comment");
          pos = end + 3;
          continue;
        }
        if (source.startsWith("<![CDATA[", pos)) {
          throw new Error("XML syntax error: CDATA outside element content");
        }
        if (source.startsWith("<!", pos) || source.startsWith("<?", pos)) {
          const end = source.indexOf(">", pos);
          if (end === -1) throw new Error("XML syntax error: unterminated declaration");
          pos = end + 1;
          continue;
        }
      }
      return;
    }
  };

  const readName = (): string => {
    const match = /^[A-Za-z_:][-A-Za-z0-9_:.]*/.exec(source.slice(pos));
    if (match === null) throw new Error("XML syntax error: expected a name");
    pos += match[0].length;
    return match[0];
  };

  const skipWhitespace = (): void => {
    while (pos < length && /\s/.test(source[pos] as string)) pos++;
  };

  const parseElement = (): XmlElement => {
    skipMisc();
    if (pos >= length || source[pos] !== "<") throw new Error("XML syntax error: expected an element");
    pos++; // consume "<"
    const name = readName();
    const attrs: Record<string, string> = {};
    for (;;) {
      skipWhitespace();
      if (pos >= length) throw new Error("XML syntax error: unterminated start tag");
      if (source[pos] === "/") {
        pos++;
        if (source[pos] !== ">") throw new Error("XML syntax error: malformed self-closing tag");
        pos++;
        return { name, attrs, children: [], text: "" };
      }
      if (source[pos] === ">") {
        pos++;
        break;
      }
      const attrName = readName();
      skipWhitespace();
      if (source[pos] !== "=") throw new Error("XML syntax error: expected = in attribute");
      pos++;
      skipWhitespace();
      const quote = source[pos];
      if (quote !== '"' && quote !== "'") throw new Error("XML syntax error: unquoted attribute value");
      pos++;
      const end = source.indexOf(quote, pos);
      if (end === -1) throw new Error("XML syntax error: unterminated attribute value");
      attrs[attrName] = decodeEntities(source.slice(pos, end));
      pos = end + 1;
    }
    const children: XmlElement[] = [];
    let text = "";
    for (;;) {
      if (pos >= length) throw new Error(`XML syntax error: unclosed element <${name}>`);
      if (source.startsWith("<!--", pos)) {
        const end = source.indexOf("-->", pos + 4);
        if (end === -1) throw new Error("XML syntax error: unterminated comment");
        pos = end + 3;
        continue;
      }
      if (source.startsWith("<![CDATA[", pos)) {
        const end = source.indexOf("]]>", pos + 9);
        if (end === -1) throw new Error("XML syntax error: unterminated CDATA");
        text += source.slice(pos + 9, end);
        pos = end + 3;
        continue;
      }
      if (source.startsWith("</", pos)) {
        pos += 2;
        const closeName = readName();
        if (closeName !== name) throw new Error(`XML syntax error: </${closeName}> does not close <${name}>`);
        skipWhitespace();
        if (source[pos] !== ">") throw new Error("XML syntax error: malformed end tag");
        pos++;
        return { name, attrs, children, text };
      }
      if (source.startsWith("<?", pos) || source.startsWith("<!", pos)) {
        const end = source.indexOf(">", pos);
        if (end === -1) throw new Error("XML syntax error: unterminated declaration");
        pos = end + 1;
        continue;
      }
      if (source[pos] === "<") {
        children.push(parseElement());
        continue;
      }
      const nextTag = source.indexOf("<", pos);
      const chunk = nextTag === -1 ? source.slice(pos) : source.slice(pos, nextTag);
      text += decodeEntities(chunk);
      pos = nextTag === -1 ? length : nextTag;
    }
  };

  return parseElement();
}

/** The LAST occurrence wins (Go's Unmarshal overwrites on repeats). */
function childText(parent: XmlElement, name: string): string {
  let value = "";
  for (const child of parent.children) {
    if (child.name === name) value = child.text;
  }
  return value;
}

function childElement(parent: XmlElement, name: string): XmlElement | null {
  let found: XmlElement | null = null;
  for (const child of parent.children) {
    if (child.name === name) found = child;
  }
  return found;
}

function childElements(parent: XmlElement, name: string): XmlElement[] {
  return parent.children.filter((child) => child.name === name);
}

/** strconv.ParseBool's accepted set; anything else is a plain unmarshal
 *  error → 500 (upstream's non-InvalidArgument arm). */
function parseGoBool(text: string, field: string): boolean {
  switch (text) {
    case "1":
    case "t":
    case "T":
    case "true":
    case "TRUE":
    case "True":
      return true;
    case "0":
    case "f":
    case "F":
    case "false":
    case "FALSE":
    case "False":
      return false;
    default:
      throw new Error(`nuspec field ${field} is not a boolean`);
  }
}

function isValidAbsoluteHttpUrl(value: string): boolean {
  if (value === "") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export type NugetPackageKind = "dependency" | "symbols";

/** metadata.go's Package struct (the parse product). */
export interface NugetPackageMeta {
  packageType: NugetPackageKind;
  id: string;
  /** The NORMALIZED version (toNormalizedVersion) — the stored row's version. */
  version: string;
  metadata: NugetMetadata;
  /** The ORIGINAL nuspec bytes (stored as the {id}.nuspec file). */
  nuspecContent: Uint8Array;
}

const MAX_NUSPEC_FILE_SIZE = 3 * 1024 * 1024;

/** ParsePackageMetaData (metadata.go:140-164): the first ROOT entry ending
 *  .nuspec (case-insensitive; "root" = no "/" in the name — upstream's
 *  filepath.Dir arm, which also rejects a leading slash), size-checked
 *  against the recorded uncompressed size BEFORE extraction. */
export async function parseNugetPackage(bytes: Uint8Array): Promise<NugetPackageMeta> {
  let entries: ZipEntry[];
  try {
    entries = readZipEntries(bytes);
  } catch (error) {
    if (error instanceof NugetInvalidPackageArchiveError) throw error;
    throw new NugetInvalidPackageArchiveError(error instanceof Error ? error.message : "zip: not a valid zip file");
  }
  const nuspec = entries.find((entry) => !entry.name.includes("/") && entry.name.toLowerCase().endsWith(".nuspec"));
  if (nuspec === undefined) {
    throw new NugetMissingNuspecFileError();
  }
  if (nuspec.uncompressedSize > MAX_NUSPEC_FILE_SIZE) {
    throw new NugetNuspecFileTooLargeError();
  }
  const nuspecBytes = await nuspec.data();
  return parseNuspecMetaData(entries, nuspecBytes);
}

/** ParseNuspecMetaData (metadata.go:167-260). */
export async function parseNuspecMetaData(archive: ZipEntry[], nuspecBytes: Uint8Array): Promise<NugetPackageMeta> {
  const decoded = new TextDecoder().decode(nuspecBytes);
  if (decoded.trim() === "") throw new Error("XML syntax error: empty nuspec document");
  const root = parseXmlElement(decoded);
  const metadataEl = childElement(root, "metadata");
  if (metadataEl === null) {
    // Go's decoder leaves the nested struct zeroed for a missing <metadata>;
    // the id check below then fails — mirror that outcome.
    throw new NugetNuspecInvalidIDError();
  }
  const metadata = metadataEl;

  const id = childText(metadata, "id");
  if (!validateNugetId(id)) {
    throw new NugetNuspecInvalidIDError();
  }

  const rawVersion = childText(metadata, "version");
  const semver = parseGoSemver(rawVersion);
  if (semver === null) {
    throw new NugetNuspecInvalidVersionError();
  }

  let projectUrl = childText(metadata, "projectUrl");
  // metadata.go:183-185 — validation.IsValidURL normalizes a non-URL to "".
  if (!isValidAbsoluteHttpUrl(projectUrl)) projectUrl = "";

  let packageType: NugetPackageKind = "dependency";
  const packageTypes = childElement(metadata, "packageTypes");
  if (packageTypes !== null) {
    for (const packageTypeEl of childElements(packageTypes, "packageType")) {
      if (packageTypeEl.attrs["name"] === "SymbolsPackage") {
        packageType = "symbols";
        break;
      }
    }
  }

  const dependencies: Record<string, NugetDependency[]> = {};
  const collect = (dependencyEls: XmlElement[]): NugetDependency[] => {
    const deps: NugetDependency[] = [];
    for (const dep of dependencyEls) {
      const depId = dep.attrs["id"] ?? "";
      const depVersion = dep.attrs["version"] ?? "";
      if (depId === "" || depVersion === "") continue;
      deps.push({ id: depId, version: depVersion });
    }
    return deps;
  };
  const dependenciesEl = childElement(metadata, "dependencies");
  if (dependenciesEl !== null) {
    const groupless = collect(childElements(dependenciesEl, "dependency"));
    if (groupless.length > 0) dependencies[""] = groupless;
    for (const group of childElements(dependenciesEl, "group")) {
      const deps = collect(childElements(group, "dependency"));
      if (deps.length > 0) dependencies[group.attrs["targetFramework"] ?? ""] = deps;
    }
  }

  const m: NugetMetadata = {
    authors: childText(metadata, "authors"),
    copyright: childText(metadata, "copyright"),
    description: childText(metadata, "description"),
    developmentDependency: parseGoBool(childText(metadata, "developmentDependency") || "0", "developmentDependency"),
    iconUrl: childText(metadata, "iconUrl"),
    language: childText(metadata, "language"),
    licenseUrl: childText(metadata, "licenseUrl"),
    minClientVersion: metadata.attrs["minClientVersion"] ?? "",
    owners: childText(metadata, "owners"),
    projectUrl,
    readme: "",
    releaseNotes: childText(metadata, "releaseNotes"),
    repositoryUrl: childElement(metadata, "repository")?.attrs["url"] ?? "",
    requireLicenseAcceptance: parseGoBool(
      childText(metadata, "requireLicenseAcceptance") || "0",
      "requireLicenseAcceptance",
    ),
    summary: childText(metadata, "summary"),
    tags: childText(metadata, "tags"),
    title: childText(metadata, "title"),
    dependencies,
  };

  // metadata.go:216-223 — the readme is INLINED from the archive when the
  // named entry opens; a miss keeps the empty string. Capped at 1 MiB.
  const readmeName = childText(metadata, "readme");
  if (readmeName !== "") {
    const readmeEntry = archive.find((entry) => entry.name === readmeName);
    if (readmeEntry !== undefined) {
      const readmeBytes = await readmeEntry.data();
      m.readme = new TextDecoder().decode(readmeBytes.slice(0, 1024 * 1024));
    }
  }

  return {
    packageType,
    id,
    version: toNormalizedVersion(semver),
    metadata: m,
    nuspecContent: nuspecBytes,
  };
}

// ---------------------------------------------------------------------------
// The portable-PDB extractor (symbol_extractor.go) — the BSJB walk.
// ---------------------------------------------------------------------------

const MAX_PDB_TOTAL_SIZE = 256 * 1024 * 1024;

export interface PortablePdb {
  /** path.Base of the archive entry name. */
  name: string;
  /** The #Pdb stream GUID, upstream's %08x%04x%04x%04x%012x shape. */
  id: string;
  content: Uint8Array;
}

/** ExtractPortablePdb (symbol_extractor.go:44-110): .nuspec/.xml/.psmdcp/
 *  .rels/.p7s skipped, .pdb parsed, ANY other extension ErrInvalidFiles. */
export async function extractPortablePdb(bytes: Uint8Array): Promise<PortablePdb[]> {
  const entries = readZipEntries(bytes);
  const pdbs: PortablePdb[] = [];
  let remaining = MAX_PDB_TOTAL_SIZE;
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    const dotAt = entry.name.lastIndexOf(".");
    const ext = dotAt === -1 ? "" : entry.name.slice(dotAt).toLowerCase();
    if (ext === ".nuspec" || ext === ".xml" || ext === ".psmdcp" || ext === ".rels" || ext === ".p7s") {
      continue;
    }
    if (ext !== ".pdb") {
      throw new NugetInvalidFilesError();
    }
    // NewLimitedReader(f, remaining) — the cap TRUNCATES silently; the
    // truncated parse then fails the magic/stream checks (upstream's 500 arm).
    const capped = entry.uncompressedSize < remaining ? entry.uncompressedSize : remaining;
    const content = (await entry.data()).subarray(0, capped);
    remaining -= capped;
    const id = parseDebugHeaderId(content);
    pdbs.push({ name: basename(entry.name), id, content });
  }
  if (pdbs.length === 0) {
    throw new NugetMissingPdbFilesError();
  }
  return pdbs;
}

function basename(name: string): string {
  const slashAt = name.lastIndexOf("/");
  return slashAt === -1 ? name : name.slice(slashAt + 1);
}

function readU32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) |
    ((bytes[offset + 1] as number) << 8) |
    ((bytes[offset + 2] as number) << 16) |
    ((bytes[offset + 3] as number) << 24)
  ) >>> 0;
}

function readI32Le(bytes: Uint8Array, offset: number): number {
  return readU32Le(bytes, offset) | 0;
}

function readU16Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
}

function hexPad(value: number, width: number): string {
  return value.toString(16).padStart(width, "0");
}

/** ParseDebugHeaderID (symbol_extractor.go:113-190) — throws the wrapped
 *  "Invalid PDB file: …" error (→ 500, upstream's non-InvalidArgument arm). */
export function parseDebugHeaderId(bytes: Uint8Array): string {
  const eof = (): NugetInvalidPdbError => new NugetInvalidPdbError("unexpected EOF");
  if (bytes.byteLength < 4) throw eof();
  if (readU32Le(bytes, 0) !== 0x424a5342) {
    throw new NugetInvalidPdbError("invalid Portable PDB magic number");
  }
  let pos = 12; // magic (4) + major/minor versions (8) — upstream's Seek(8) after the magic
  if (bytes.byteLength < pos + 4) throw eof();
  const versionStringSize = readI32Le(bytes, pos);
  pos += 4;
  if (versionStringSize < 0 || bytes.byteLength < pos + versionStringSize + 2) throw eof();
  pos += versionStringSize;
  pos += 2; // flags
  if (bytes.byteLength < pos + 2) throw eof();
  const streamCount = readU16Le(bytes, pos);
  pos += 2;

  const readAlignedString = (): string => {
    let text = "";
    for (;;) {
      if (bytes.byteLength < pos + 4) throw eof();
      const quad = bytes.subarray(pos, pos + 4);
      pos += 4;
      const zeroAt = quad.indexOf(0);
      if (zeroAt !== -1) {
        text += latin1(quad.subarray(0, zeroAt));
        return text;
      }
      text += latin1(quad);
    }
  };

  for (let i = 0; i < streamCount; i++) {
    if (bytes.byteLength < pos + 8) throw eof();
    const offset = readU32Le(bytes, pos);
    pos += 8; // offset + size
    const name = readAlignedString();
    if (name === "#Pdb") {
      if (bytes.byteLength < offset + 16) throw eof();
      const b = bytes.subarray(offset, offset + 16);
      const data1 = readU32Le(b, 0);
      const data2 = readU16Le(b, 4);
      const data3 = readU16Le(b, 6);
      const tail4 = hexPad(b[8] as number, 2) + hexPad(b[9] as number, 2);
      let tail12 = "";
      for (let i2 = 10; i2 < 16; i2++) tail12 += hexPad(b[i2] as number, 2);
      return `${hexPad(data1, 8)}${hexPad(data2, 4)}${hexPad(data3, 4)}${tail4}${tail12}`;
    }
  }
  throw new NugetInvalidPdbError("missing PDB stream");
}

// ---------------------------------------------------------------------------
// The model queries the protocol needs (upstream models/packages/nuget/
// search.go + package_version.go's default ordering).
// ---------------------------------------------------------------------------

const NUGET_TYPE = "nuget";

function baseConditions(ownerId: number): SQL[] {
  return [
    eq(packages.ownerId, ownerId),
    eq(packages.type, NUGET_TYPE),
    eq(packages.isInternal, false),
    eq(packageVersions.isInternal, false),
  ];
}

export interface NugetSearchTerm {
  value: string;
  exactMatch: boolean;
}

function nameCondition(term: NugetSearchTerm): SQL {
  return term.exactMatch
    ? eq(packages.lowerName, term.value.toLowerCase())
    : like(packages.lowerName, `%${term.value.toLowerCase()}%`);
}

/** models/packages/nuget SearchVersions (search.go:17-47): the PACKAGE count
 *  is the total; each selected package (name ASC, absolute skip/take)
 *  contributes ALL its non-internal versions, versions by id ASC (the
 *  natural join order). The package-side queries carry PACKAGE-only columns
 *  (toConds' package.* half); the version is_internal filter rides the join. */
export async function nugetSearchAllVersionsPerPackage(
  d1: D1Database,
  ownerId: number,
  term: NugetSearchTerm,
  rawSkip: number,
  rawTake: number,
): Promise<{ rows: { version: PackageVersionRow; pkg: PackageRow }[]; total: number; skip: number; take: number }> {
  const skip = Math.max(rawSkip, 0);
  const take = rawTake <= 0 ? 30 : Math.min(rawTake, 50);
  const db = drizzle(d1);
  const packageConds: SQL[] = [
    eq(packages.ownerId, ownerId),
    eq(packages.type, NUGET_TYPE),
    eq(packages.isInternal, false),
  ];
  if (term.value !== "") packageConds.push(nameCondition(term));
  const packageWhere = and(...packageConds);
  const totalRows = await db
    .select({ total: sql<number>`count(*)` })
    .from(packages)
    .where(packageWhere)
    .all();
  const selected = await db
    .select({ id: packages.id })
    .from(packages)
    .where(packageWhere)
    .orderBy(asc(packages.name))
    .limit(take)
    .offset(skip)
    .all();
  const ids = selected.map((row) => row.id);
  const total = totalRows[0]?.total ?? 0;
  if (ids.length === 0) return { rows: [], total, skip, take };
  const rows = await db
    .select({ version: packageVersions, pkg: packages })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(and(inArray(packages.id, ids), eq(packageVersions.isInternal, false)))
    .orderBy(asc(packages.name), asc(packageVersions.id))
    .all();
  return { rows, total, skip, take };
}

/** CountPackages (search.go:50-54). */
export async function nugetCountPackages(d1: D1Database, ownerId: number, term: NugetSearchTerm): Promise<number> {
  const conds: SQL[] = [eq(packages.ownerId, ownerId), eq(packages.type, NUGET_TYPE), eq(packages.isInternal, false)];
  if (term.value !== "") conds.push(nameCondition(term));
  const rows = await drizzle(d1)
    .select({ total: sql<number>`count(*)` })
    .from(packages)
    .where(and(...conds))
    .all();
  return rows[0]?.total ?? 0;
}

/** CountVersions (packages.go:372-379 with the name-exact filter) — the
 *  /FindPackagesById()/$count arm. */
export async function nugetCountVersions(d1: D1Database, ownerId: number, packageName: string): Promise<number> {
  const conds = [...baseConditions(ownerId), eq(packages.lowerName, packageName.toLowerCase())];
  const rows = await drizzle(d1)
    .select({ total: sql<number>`count(*)` })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(and(...conds))
    .all();
  return rows[0]?.total ?? 0;
}

/** SearchLatestVersions with the ABSOLUTE skip/take paginator (the /Search()
 *  arm; list.go:89-99 clamps skip<0→0, take<=0→30, take>50→50). */
export async function nugetSearchLatestVersionsPaginated(
  d1: D1Database,
  ownerId: number,
  term: NugetSearchTerm,
  rawSkip: number,
  rawTake: number,
): Promise<{ rows: { version: PackageVersionRow; pkg: PackageRow }[]; total: number; skip: number; take: number }> {
  const skip = Math.max(rawSkip, 0);
  const take = rawTake <= 0 ? 30 : Math.min(rawTake, 50);
  const db = drizzle(d1);
  const conds = [...baseConditions(ownerId)];
  if (term.value !== "") conds.push(nameCondition(term));
  const where = and(...conds);
  const latestIds = db
    .select({ id: sql<number>`max(${packageVersions.id})` })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(where)
    .groupBy(packageVersions.packageId);
  const rows = await db
    .select({ version: packageVersions, pkg: packages })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(inArray(packageVersions.id, latestIds))
    .orderBy(desc(packageVersions.createdUnix), desc(packageVersions.id))
    .limit(take)
    .offset(skip)
    .all();
  const counted = await db
    .select({ total: sql<number>`count(*)` })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      inArray(
        packageVersions.id,
        db
          .select({ id: sql<number>`max(${packageVersions.id})` })
          .from(packageVersions)
          .innerJoin(packages, eq(packages.id, packageVersions.packageId))
          .where(where)
          .groupBy(packageVersions.packageId),
      ),
    )
    .all();
  return { rows, total: counted[0]?.total ?? 0, skip, take };
}

/** SearchVersions with the absolute paginator (the /FindPackagesById() arm —
 *  name-exact, created_unix DESC + id DESC, the configureOrderBy default). */
export async function nugetSearchVersionsPaginated(
  d1: D1Database,
  ownerId: number,
  packageName: string,
  rawSkip: number,
  rawTake: number,
): Promise<{ rows: { version: PackageVersionRow; pkg: PackageRow }[]; total: number; skip: number; take: number }> {
  const skip = Math.max(rawSkip, 0);
  const take = rawTake <= 0 ? 30 : Math.min(rawTake, 50);
  const db = drizzle(d1);
  const conds = [...baseConditions(ownerId), eq(packages.lowerName, packageName.toLowerCase())];
  const where = and(...conds);
  const rows = await db
    .select({ version: packageVersions, pkg: packages })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(where)
    .orderBy(desc(packageVersions.createdUnix), desc(packageVersions.id))
    .limit(take)
    .offset(skip)
    .all();
  const counted = await db
    .select({ total: sql<number>`count(*)` })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(where)
    .all();
  return { rows, total: counted[0]?.total ?? 0, skip, take };
}

/** GetVersionsByPackageName (package_version.go:139-147) — no paginator, the
 *  default created DESC + id DESC order. */
export async function getNugetVersionsByPackageName(
  d1: D1Database,
  ownerId: number,
  packageName: string,
): Promise<{ version: PackageVersionRow; pkg: PackageRow }[]> {
  const conds = [...baseConditions(ownerId), eq(packages.lowerName, packageName.toLowerCase())];
  return drizzle(d1)
    .select({ version: packageVersions, pkg: packages })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(and(...conds))
    .orderBy(desc(packageVersions.createdUnix), desc(packageVersions.id))
    .all();
}

// ---------------------------------------------------------------------------
// The descriptor (models/packages/descriptor.go) — SemVer for the
// semver-compatible nuget type, files with blobs, the metadata JSON.
// ---------------------------------------------------------------------------

export interface NugetDescriptor {
  pkg: PackageRow;
  version: PackageVersionRow;
  semver: GoVersion;
  files: { file: PackageFileRow; blob: PackageBlobRow }[];
  metadata: NugetMetadata;
}

export async function getNugetDescriptor(
  d1: D1Database,
  pkg: PackageRow,
  version: PackageVersionRow,
): Promise<NugetDescriptor> {
  const semver = parseGoVersion(version.version);
  if (semver === null) {
    throw new Error(`stored nuget version is malformed: ${version.version}`);
  }
  const files = await drizzle(d1)
    .select({ file: packageFiles, blob: packageBlobs })
    .from(packageFiles)
    .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
    .where(eq(packageFiles.versionId, version.id))
    .orderBy(asc(packageFiles.lowerName), asc(packageFiles.createdUnix), asc(packageFiles.id))
    .all();
  return { pkg, version, semver, files, metadata: nugetMetadataFromJson(version.metadataJson) };
}

/** CalculateBlobSize (descriptor.go:140-145). */
function blobSize(descriptor: NugetDescriptor): number {
  return descriptor.files.reduce((sum, entry) => sum + entry.blob.size, 0);
}

/** IsPrerelease (package_version.go:40-45) — the substring test. */
function isPrerelease(version: string): boolean {
  return version !== "" && version.includes("-");
}

/** buildDependencyString (api_v2.go:398-416) — `id:version:group` joined by
 *  `|`; the group keys iterate SORTED (upstream iterates a Go map). */
function buildDependencyString(metadata: NugetMetadata): string {
  const parts: string[] = [];
  for (const group of [...Object.keys(metadata.dependencies)].sort()) {
    for (const dep of metadata.dependencies[group] ?? []) {
      parts.push(`${dep.id}:${dep.version}:${group}`);
    }
  }
  return parts.join("|");
}

// ---------------------------------------------------------------------------
// The link builder (links.go)
// ---------------------------------------------------------------------------

export interface NugetNextOptions {
  path: string;
  query: [string, string][];
}

export class NugetLinkBuilder {
  constructor(
    readonly base: string,
    readonly next?: NugetNextOptions,
  ) {}

  registrationIndexUrl(id: string): string {
    return `${this.base}/registration/${id}/index.json`;
  }

  registrationLeafUrl(id: string, version: string): string {
    return `${this.base}/registration/${id}/${version}.json`;
  }

  packageDownloadUrl(id: string, version: string): string {
    return `${this.base}/package/${id}/${version}/${id}.${version}.nupkg`;
  }

  packageMetadataUrl(id: string, version: string): string {
    return `${this.base}/Packages(Id='${id}',Version='${version}')`;
  }

  /** GetNextURL (links.go:41-52): base + path, query url.Values.Encode —
   *  keys sorted, values QueryEscaped. */
  nextUrl(): string {
    const query = [...(this.next?.query ?? [])];
    query.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const encoded = query.map(([key, value]) => `${goQueryEscape(key)}=${goQueryEscape(value)}`).join("&");
    return encoded === "" ? `${this.base}/${this.next?.path ?? ""}` : `${this.base}/${this.next?.path ?? ""}?${encoded}`;
  }
}

// ---------------------------------------------------------------------------
// The V2 XML shapes (api_v2.go)
// ---------------------------------------------------------------------------

/** ServiceIndexV2 (nuget.go:45-66 + api_v2.go:30-36). */
export function serviceIndexV2Xml(base: string): string {
  const workspace = el(
    "workspace",
    [],
    [
      textEl("atom:title", "Default", "text"),
      el("collection", [["href", "Packages"]], [textEl("atom:title", "Packages", "text")]),
    ],
  );
  const service = el(
    "service",
    [
      ["base", base],
      ["xmlns", "http://www.w3.org/2007/app"],
      ["xmlns:atom", "http://www.w3.org/2005/Atom"],
    ],
    [workspace],
  );
  return XML_HEADER + service;
}

/** FeedCapabilityResource (nuget.go:89-91 + api_v2.go:100-231) — the static
 *  Edmx document, rendered exactly as Go's encoder would (single line, no
 *  self-closing tags, struct-field attribute order, bool attrs verbatim). */
export const NUGET_EDMX_METADATA_XML =
  XML_HEADER +
  '<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">' +
  '<edmx:DataServices xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" m:DataServiceVersion="2.0" m:MaxDataServiceVersion="2.0">' +
  '<Schema xmlns="http://schemas.microsoft.com/ado/2006/04/edm" Namespace="NuGetGallery.OData">' +
  '<EntityType Name="V2FeedPackage" m:HasStream="true">' +
  "<Key>" +
  '<PropertyRef Name="Id"></PropertyRef>' +
  '<PropertyRef Name="Version"></PropertyRef>' +
  "</Key>" +
  '<Property Name="Id" Type="Edm.String" Nullable="false"></Property>' +
  '<Property Name="Version" Type="Edm.String" Nullable="false"></Property>' +
  '<Property Name="NormalizedVersion" Type="Edm.String" Nullable="true"></Property>' +
  '<Property Name="Authors" Type="Edm.String" Nullable="true"></Property>' +
  '<Property Name="Created" Type="Edm.DateTime" Nullable="false"></Property>' +
  '<Property Name="Dependencies" Type="Edm.String" Nullable="false"></Property>' +
  '<Property Name="Description" Type="Edm.String" Nullable="false"></Property>' +
  '<Property Name="DownloadCount" Type="Edm.Int64" Nullable="false"></Property>' +
  '<Property Name="LastUpdated" Type="Edm.DateTime" Nullable="false"></Property>' +
  '<Property Name="Published" Type="Edm.DateTime" Nullable="false"></Property>' +
  '<Property Name="PackageSize" Type="Edm.Int64" Nullable="false"></Property>' +
  '<Property Name="ProjectUrl" Type="Edm.String" Nullable="true"></Property>' +
  '<Property Name="ReleaseNotes" Type="Edm.String" Nullable="true"></Property>' +
  '<Property Name="RequireLicenseAcceptance" Type="Edm.Boolean" Nullable="false"></Property>' +
  '<Property Name="Title" Type="Edm.String" Nullable="true"></Property>' +
  '<Property Name="VersionDownloadCount" Type="Edm.Int64" Nullable="false"></Property>' +
  "</EntityType>" +
  "</Schema>" +
  '<Schema xmlns="http://schemas.microsoft.com/ado/2006/04/edm" Namespace="NuGetGallery">' +
  '<EntityContainer Name="V2FeedContext" m:IsDefaultEntityContainer="true">' +
  '<EntitySet Name="Packages" EntityType="NuGetGallery.OData.V2FeedPackage"></EntitySet>' +
  '<FunctionImport Name="Search" ReturnType="Collection(NuGetGallery.OData.V2FeedPackage)" EntitySet="Packages">' +
  '<Parameter Name="searchTerm" Type="Edm.String"></Parameter>' +
  "</FunctionImport>" +
  '<FunctionImport Name="FindPackagesById" ReturnType="Collection(NuGetGallery.OData.V2FeedPackage)" EntitySet="Packages">' +
  '<Parameter Name="id" Type="Edm.String"></Parameter>' +
  "</FunctionImport>" +
  "</EntityContainer>" +
  "</Schema>" +
  "</edmx:DataServices>" +
  "</edmx:Edmx>";

/** createFeedResponse (api_v2.go:306-333). */
export function createFeedResponseXml(
  builder: NugetLinkBuilder,
  totalEntries: number,
  descriptors: NugetDescriptor[],
): string {
  const links: string[] = [el("link", [["rel", "self"], ["href", builder.base]])];
  if (builder.next !== undefined) {
    links.push(el("link", [["rel", "next"], ["href", builder.nextUrl()]]));
  }
  const entries = descriptors.map((descriptor) => createEntryXml(builder, descriptor, false));
  const feed = el(
    "feed",
    [
      ["xmlns", "http://www.w3.org/2005/Atom"],
      ["xmlns:d", "http://schemas.microsoft.com/ado/2007/08/dataservices"],
      ["xmlns:m", "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"],
      ["xml:base", builder.base],
    ],
    [
      textEl("id", "http://schemas.datacontract.org/2004/07/"),
      textEl("title", ""),
      textEl("updated", goRFC3339(new Date())),
      ...links,
      ...entries,
      textEl("m:count", String(totalEntries)),
    ],
  );
  return XML_HEADER + feed;
}

/** createEntry (api_v2.go:335-396) — the V2 leaf sets withNamespace; the
 *  Content field is the LAST struct member and carries the verbatim
 *  self-closing innerxml workaround (nuget.go:340-342). */
export function createEntryXml(builder: NugetLinkBuilder, descriptor: NugetDescriptor, withNamespace: boolean): string {
  const id = builder.packageMetadataUrl(descriptor.pkg.name, descriptor.version.version);
  const content = `<content type="application/zip" src="${xmlEscape(
    builder.packageDownloadUrl(descriptor.pkg.name, descriptor.version.version),
  )}"/>`;
  const created = goRFC3339(descriptor.version.createdUnix);
  const metadata = descriptor.metadata;
  const typed = (name: string, value: string, type: string): string => textEl(name, value, type);
  const properties = el("m:properties", [], [
    textEl("d:Authors", metadata.authors),
    ...(metadata.copyright !== "" ? [textEl("d:Copyright", metadata.copyright)] : []),
    typed("d:Created", created, "Edm.DateTime"),
    textEl("d:Dependencies", buildDependencyString(metadata)),
    textEl("d:Description", metadata.description),
    typed("d:DevelopmentDependency", String(metadata.developmentDependency), "Edm.Boolean"),
    typed("d:DownloadCount", String(descriptor.version.downloadCount), "Edm.Int64"),
    textEl("d:Id", descriptor.pkg.name),
    ...(metadata.iconUrl !== "" ? [textEl("d:IconUrl", metadata.iconUrl)] : []),
    ...(metadata.language !== "" ? [textEl("d:Language", metadata.language)] : []),
    typed("d:LastUpdated", created, "Edm.DateTime"),
    ...(metadata.licenseUrl !== "" ? [textEl("d:LicenseUrl", metadata.licenseUrl)] : []),
    ...(metadata.minClientVersion !== "" ? [textEl("d:MinClientVersion", metadata.minClientVersion)] : []),
    textEl("d:NormalizedVersion", descriptor.version.version),
    ...(metadata.owners !== "" ? [textEl("d:Owners", metadata.owners)] : []),
    typed("d:PackageSize", String(blobSize(descriptor)), "Edm.Int64"),
    ...(metadata.projectUrl !== "" ? [textEl("d:ProjectUrl", metadata.projectUrl)] : []),
    typed("d:Published", created, "Edm.DateTime"),
    ...(metadata.releaseNotes !== "" ? [textEl("d:ReleaseNotes", metadata.releaseNotes)] : []),
    typed("d:RequireLicenseAcceptance", String(metadata.requireLicenseAcceptance), "Edm.Boolean"),
    ...(metadata.tags !== "" ? [textEl("d:Tags", metadata.tags)] : []),
    ...(metadata.title !== "" ? [textEl("d:Title", metadata.title)] : []),
    textEl("d:Version", descriptor.version.version),
    typed("d:VersionDownloadCount", String(descriptor.version.downloadCount), "Edm.Int64"),
  ]);
  const entryAttrs: [string, string][] = withNamespace
    ? [
        ["xmlns", "http://www.w3.org/2005/Atom"],
        ["xmlns:d", "http://schemas.microsoft.com/ado/2007/08/dataservices"],
        ["xmlns:m", "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"],
        ["xml:base", builder.base],
      ]
    : [];
  const entry = el("entry", entryAttrs, [
    textEl("id", id),
    el("category", [
      ["term", "NuGetGallery.OData.V2FeedPackage"],
      ["scheme", "http://schemas.microsoft.com/ado/2007/08/dataservices/scheme"],
    ]),
    el("link", [["rel", "self"], ["href", id]]),
    el("link", [["rel", "edit"], ["href", id]]),
    textEl("title", descriptor.pkg.name, "text"),
    textEl("updated", created),
    el("author", [], [textEl("name", metadata.authors)]),
    textEl("summary", ""),
    properties,
  ]);
  return entry + content;
}

// ---------------------------------------------------------------------------
// The V3 JSON shapes (api_v3.go) — struct declaration order, ALL fields
// present (none of these structs carry omitempty).
// ---------------------------------------------------------------------------

interface CatalogEntryJson {
  "@id": string;
  authors: string;
  copyright: string;
  dependencyGroups: { targetFramework: string; dependencies: { id: string; range: string }[] }[];
  description: string;
  iconUrl: string;
  id: string;
  isPrerelease: boolean;
  language: string;
  licenseUrl: string;
  packageContent: string;
  projectUrl: string;
  requireLicenseAcceptance: boolean;
  summary: string;
  tags: string;
  version: string;
  releaseNotes: string;
  published: string;
}

/** createDependencyGroups (api_v3.go:142-159) — deterministic order. */
function dependencyGroupsJson(metadata: NugetMetadata): CatalogEntryJson["dependencyGroups"] {
  return [...Object.keys(metadata.dependencies).sort()].map((framework) => ({
    targetFramework: framework,
    dependencies: (metadata.dependencies[framework] ?? []).map((dep) => ({ id: dep.id, range: dep.version })),
  }));
}

function catalogEntryJson(builder: NugetLinkBuilder, descriptor: NugetDescriptor): CatalogEntryJson {
  const metadata = descriptor.metadata;
  return {
    "@id": builder.registrationLeafUrl(descriptor.pkg.name, descriptor.version.version),
    authors: metadata.authors,
    copyright: metadata.copyright,
    dependencyGroups: dependencyGroupsJson(metadata),
    description: metadata.description,
    iconUrl: metadata.iconUrl,
    id: descriptor.pkg.name,
    isPrerelease: isPrerelease(descriptor.version.version),
    language: metadata.language,
    licenseUrl: metadata.licenseUrl,
    packageContent: builder.packageDownloadUrl(descriptor.pkg.name, descriptor.version.version),
    projectUrl: metadata.projectUrl,
    requireLicenseAcceptance: metadata.requireLicenseAcceptance,
    summary: metadata.summary,
    tags: metadata.tags,
    version: descriptor.version.version,
    releaseNotes: metadata.releaseNotes,
    published: goRFC3339(descriptor.version.createdUnix),
  };
}

/** createRegistrationIndexResponse (api_v3.go:87-111) — SemVer ascending. */
export function createRegistrationIndexJson(
  builder: NugetLinkBuilder,
  descriptors: NugetDescriptor[],
): Record<string, unknown> {
  const sorted = [...descriptors].sort((a, b) => {
    const cmp = a.semver.compare(b.semver);
    if (cmp !== 0) return cmp;
    return a.version.id - b.version.id; // sort.Slice is unstable upstream — pin determinism
  });
  const name = sorted[0]?.pkg.name ?? "";
  return {
    "@id": builder.registrationIndexUrl(name),
    "@type": ["catalog:CatalogRoot", "PackageRegistration", "catalog:Permalink"],
    count: 1,
    items: [
      {
        "@id": builder.registrationIndexUrl(name),
        lower: sorted[0]?.version.version ?? "",
        upper: sorted[sorted.length - 1]?.version.version ?? "",
        count: sorted.length,
        items: sorted.map((descriptor) => ({
          "@id": builder.registrationLeafUrl(descriptor.pkg.name, descriptor.version.version),
          packageContent: builder.packageDownloadUrl(descriptor.pkg.name, descriptor.version.version),
          catalogEntry: catalogEntryJson(builder, descriptor),
        })),
      },
    ],
  };
}

/** createRegistrationLeafResponse (api_v3.go:170-200). */
export function createRegistrationLeafJson(
  builder: NugetLinkBuilder,
  descriptor: NugetDescriptor,
): Record<string, unknown> {
  return {
    "@id": builder.registrationLeafUrl(descriptor.pkg.name, descriptor.version.version),
    "@type": ["Package", "http://schema.nuget.org/catalog#Permalink"],
    packageContent: builder.packageDownloadUrl(descriptor.pkg.name, descriptor.version.version),
    registration: builder.registrationIndexUrl(descriptor.pkg.name),
    catalogEntry: catalogEntryJson(builder, descriptor),
  };
}

/** createPackageVersionsResponse (api_v3.go:207-216). */
export function createPackageVersionsJson(versions: PackageVersionRow[]): Record<string, unknown> {
  return { versions: versions.map((version) => version.version) };
}

/** createSearchResultResponse (api_v3.go:253-274) — groups keyed by package
 *  name, sorted with English collation ignoring case (reduced to the
 *  lowercase compare — ids are ASCII per the id regex). */
export function createSearchResultJson(
  builder: NugetLinkBuilder,
  totalHits: number,
  descriptors: NugetDescriptor[],
): Record<string, unknown> {
  const grouped = new Map<string, NugetDescriptor[]>();
  for (const descriptor of descriptors) {
    const list = grouped.get(descriptor.pkg.name) ?? [];
    list.push(descriptor);
    grouped.set(descriptor.pkg.name, list);
  }
  const keys = [...grouped.keys()].sort((a, b) => {
    const lowerA = a.toLowerCase();
    const lowerB = b.toLowerCase();
    if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0; // case-variant tiebreak (primary strength)
  });
  const data = keys.map((key) => createSearchResultEntryJson(builder, grouped.get(key) ?? []));
  return { totalHits, data };
}

/** createSearchResult (api_v3.go:276-313) — latest by SemVer, versions in
 *  the query order, downloads always 0 (upstream never sets the field). */
function createSearchResultEntryJson(
  builder: NugetLinkBuilder,
  descriptors: NugetDescriptor[],
): Record<string, unknown> {
  let latest = descriptors[0];
  const versions: Record<string, unknown>[] = [];
  let totalDownloads = 0;
  for (const descriptor of descriptors) {
    if (latest !== undefined && latest.semver.compare(descriptor.semver) < 0) latest = descriptor;
    totalDownloads += descriptor.version.downloadCount;
    versions.push({
      "@id": builder.registrationLeafUrl(descriptor.pkg.name, descriptor.version.version),
      version: descriptor.version.version,
      downloads: 0,
    });
  }
  if (latest === undefined) throw new Error("search result group has no versions");
  const metadata = latest.metadata;
  return {
    authors: metadata.authors,
    copyright: metadata.copyright,
    dependencyGroups: dependencyGroupsJson(metadata),
    description: metadata.description,
    iconUrl: metadata.iconUrl,
    id: latest.pkg.name,
    isPrerelease: isPrerelease(latest.version.version),
    language: metadata.language,
    licenseUrl: metadata.licenseUrl,
    projectUrl: metadata.projectUrl,
    requireLicenseAcceptance: metadata.requireLicenseAcceptance,
    summary: metadata.summary,
    tags: metadata.tags,
    title: metadata.title,
    totalDownloads,
    version: latest.version.version,
    versions,
    registration: builder.registrationIndexUrl(latest.pkg.name),
  };
}

/** ServiceIndexV3 (nuget.go:69-86) — the nine resources in order. */
export function createServiceIndexJson(base: string): Record<string, unknown> {
  const resource = (id: string, type: string): Record<string, unknown> => ({ "@id": id, "@type": type });
  return {
    version: "3.0.0",
    resources: [
      resource(`${base}/query`, "SearchQueryService"),
      resource(`${base}/query`, "SearchQueryService/3.0.0-beta"),
      resource(`${base}/query`, "SearchQueryService/3.0.0-rc"),
      resource(`${base}/registration`, "RegistrationsBaseUrl"),
      resource(`${base}/registration`, "RegistrationsBaseUrl/3.0.0-beta"),
      resource(`${base}/registration`, "RegistrationsBaseUrl/3.0.0-rc"),
      resource(`${base}/package`, "PackageBaseAddress/3.0.0"),
      resource(base, "PackagePublish/2.0.0"),
      resource(`${base}/symbolpackage`, "SymbolPackagePublish/4.9.0"),
    ],
  };
}

// ---------------------------------------------------------------------------
// getSearchTerm (nuget.go:93-121) + the form helpers
// ---------------------------------------------------------------------------

const SEARCH_TERM_EXTRACT = /'([^']+)'/;
const SEARCH_TERM_EXACT = /\s+eq\s+'/;

export function getNugetSearchTerm(params: URLSearchParams): NugetSearchTerm {
  const trimQuotes = (value: string): string => value.replace(/^'+/, "").replace(/'+$/, "");
  const searchTerm = trimQuotes((params.get("searchTerm") ?? "").trim());
  if (searchTerm !== "") {
    return { value: searchTerm, exactMatch: false };
  }
  const filter = (params.get("$filter") ?? "").trim();
  const match = SEARCH_TERM_EXTRACT.exec(filter);
  if (match !== null) {
    return { value: (match[1] ?? "").trim(), exactMatch: SEARCH_TERM_EXACT.test(filter) };
  }
  return { value: "", exactMatch: false };
}

/** ctx.FormInt — 0 on any parse failure. */
export function formInt(params: URLSearchParams, key: string): number {
  const parsed = Number.parseInt((params.get(key) ?? "").trim(), 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Upload — UploadPackage's service walk (nuget.go:426-499 over
// createPackageAndAddFile: the duplicate 409 wins over quota, the nuspec add
// skips quota). The whole body IS the nupkg, so the spool digests are the
// nupkg blob's digests.
// ---------------------------------------------------------------------------

export interface NugetProtocolInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  content: ReadableStream<Uint8Array>;
  declaredLength: number;
  quota: PackagesQuotaConfig;
  now?: Date;
  maxBytes?: number;
  spoolKey?: string;
}

export interface NugetUploadResult {
  pkg: PackageRow;
  version: PackageVersionRow;
  blob: PackageBlobRow;
  nupkgFile: PackageFileRow;
  nuspecFile: PackageFileRow;
}

export async function uploadNugetPackage(input: NugetProtocolInput): Promise<NugetUploadResult> {
  const now = input.now ?? new Date();
  const maxBytes = input.maxBytes ?? MAX_NUGET_UPLOAD_BYTES;

  // PASS 1 — spool the nupkg (the cap checked before and while streaming).
  if (input.declaredLength > maxBytes) throw new NugetBodyTooLargeError();
  const spooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes,
    spoolKey: input.spoolKey,
  });

  try {
    // The zip/nuspec parse (400 arms: archive, missing/too-large nuspec,
    // invalid id/version; malformed XML → 500).
    const bytes = await readSpoolBytes(input.bucket, spooled.spoolKey, maxBytes);
    const parsed = await parseNugetPackage(bytes);
    if (parsed.packageType !== "dependency") {
      throw new NugetUnexpectedPackageTypeError();
    }

    // The duplicate-version arbitration wins over quota (packages.go:214-219 —
    // count quota runs only for a fresh version).
    const existing = await getVersionByNameAndVersion(input.d1, input.owner.id, NUGET_TYPE, parsed.id, parsed.version);
    if (existing !== null) throw new NugetDuplicateVersionError(existing);

    // The quota checks precede the inserts (one transaction upstream — a 403
    // leaves no rows). SIZE: CheckSizeQuotaExceeded adds the pending upload to
    // the owner's stored total (packages.go:311-314). COUNT: upstream checks
    // AFTER the version insert, inside the rolling-back transaction
    // (packages.go:214-219) — the pre-insert equivalent is count + 1 > limit.
    if (!input.doer.isAdmin && input.quota.limitTotalOwnerCount > UNLIMITED_QUOTA) {
      const total = (await countVersions(input.d1, input.owner.id)) + 1;
      if (total > input.quota.limitTotalOwnerCount) {
        throw new QuotaTotalCountError();
      }
    }
    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, NUGET_TYPE, spooled.size, input.quota);

    // SemverCompatible: true (nuget.go:446).
    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: NUGET_TYPE,
      name: parsed.id,
      semverCompatible: true,
      now,
    });
    const { row: version, created: versionCreated } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: parsed.version,
      now,
    });
    if (!versionCreated) throw new NugetDuplicateVersionError(version);

    // MetadataJSON lands with the version INSERT (packages.go:167-172) — the
    // landed seam patches it right after (the versionCreated gate holds).
    await drizzle(input.d1)
      .update(packageVersions)
      .set({ metadataJson: serializeNugetMetadata(parsed.metadata) })
      .where(eq(packageVersions.id, version.id))
      .run();

    // The nupkg blob row dedups on the spool's digests; the content object
    // copies from the spool (the two-pass discipline).
    const { row: blob } = await getOrInsertBlob(input.d1, {
      size: spooled.size,
      sha256: spooled.sha256,
      sha1: spooled.sha1,
      sha512: spooled.sha512,
      now,
    });
    const objectPresent = (await input.bucket.head(packageBlobContentKey(spooled.sha256))) !== null;
    if (!objectPresent) {
      await copySpoolToContentKey(input.bucket, spooled.spoolKey, spooled.sha256);
    }

    // strings.ToLower(fmt.Sprintf("%s.%s.nupkg", np.ID, np.Version)) — IsLead.
    const nupkgName = `${parsed.id}.${parsed.version}.nupkg`.toLowerCase();
    const nupkgResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: nupkgName,
      isLead: true,
      now,
    });
    if (nupkgResult.outcome === "conflict") {
      throw new Error("package file conflict despite a fresh version");
    }

    // The nuspec file: AddFileToPackageVersionInternal — quota SKIPPED
    // (packages.go:222-229), IsLead defaults false, no properties.
    const [nuspecSha1, nuspecSha256, nuspecSha512] = await Promise.all([
      digestHex("SHA-1", parsed.nuspecContent),
      digestHex("SHA-256", parsed.nuspecContent),
      digestHex("SHA-512", parsed.nuspecContent),
    ]);
    const { row: nuspecBlob } = await getOrInsertBlob(input.d1, {
      size: parsed.nuspecContent.byteLength,
      sha256: nuspecSha256,
      sha1: nuspecSha1,
      sha512: nuspecSha512,
      now,
    });
    const nuspecObjectPresent = (await input.bucket.head(packageBlobContentKey(nuspecSha256))) !== null;
    if (!nuspecObjectPresent) {
      await input.bucket.put(packageBlobContentKey(nuspecSha256), parsed.nuspecContent);
    }
    const nuspecResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: nuspecBlob.id,
      name: `${parsed.id}.nuspec`.toLowerCase(),
      isLead: false,
      now,
    });
    if (nuspecResult.outcome !== "created") {
      // The nuspec row can only exist after a prior identical push — which
      // the duplicate-version gate already 409'd. Defensive only.
      throw new Error("package nuspec file conflict despite a fresh version");
    }

    return { pkg, version, blob, nupkgFile: nupkgResult.row, nuspecFile: nuspecResult.row };
  } finally {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
  }
}

async function digestHex(algorithm: "SHA-1" | "SHA-256" | "SHA-512", bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, bytes.slice());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readSpoolBytes(bucket: R2Bucket, spoolKey: string, maxBytes: number): Promise<Uint8Array> {
  const object = await bucket.get(spoolKey);
  if (object === null) throw new Error("package spool object vanished");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = (object.body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      total += read.value.byteLength;
      if (total > maxBytes) throw new NugetBodyTooLargeError();
      chunks.push(read.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The lock is already released.
    }
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Symbol package upload — UploadSymbolPackage (nuget.go:503-594)
// ---------------------------------------------------------------------------

export interface NugetSymbolUploadResult {
  snupkgFile: PackageFileRow;
  pdbFiles: PackageFileRow[];
}

export async function uploadNugetSymbolPackage(input: NugetProtocolInput): Promise<NugetSymbolUploadResult> {
  const now = input.now ?? new Date();
  const maxBytes = input.maxBytes ?? MAX_NUGET_UPLOAD_BYTES;
  if (input.declaredLength > maxBytes) throw new NugetBodyTooLargeError();
  const spooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes,
    spoolKey: input.spoolKey,
  });

  try {
    const bytes = await readSpoolBytes(input.bucket, spooled.spoolKey, maxBytes);
    const parsed = await parseNugetPackage(bytes);
    if (parsed.packageType !== "symbols") {
      throw new NugetUnexpectedPackageTypeError();
    }
    const pdbs = await extractPortablePdb(bytes);

    // AddFileToExistingPackage: the version MUST exist (nuget.go:530-537).
    const version = await getVersionByNameAndVersion(input.d1, input.owner.id, NUGET_TYPE, parsed.id, parsed.version);
    if (version === null) throw new NugetPackageNotExistError();

    const putFile = async (
      name: string,
      blobBytes: Uint8Array,
      opts: { compositeKey?: string; symbolId?: string; isLead?: boolean } = {},
    ): Promise<PackageFileRow> => {
      const [sha1, sha256, sha512] = await Promise.all([
        digestHex("SHA-1", blobBytes),
        digestHex("SHA-256", blobBytes),
        digestHex("SHA-512", blobBytes),
      ]);
      // The CHECKED add-file arm: size quota per file (packages.go:311-314).
      await checkSizeQuotaExceeded(
        input.d1,
        input.doer.isAdmin,
        input.owner.id,
        NUGET_TYPE,
        blobBytes.byteLength,
        input.quota,
      );
      const { row: blob } = await getOrInsertBlob(input.d1, {
        size: blobBytes.byteLength,
        sha256,
        sha1,
        sha512,
        now,
      });
      const objectPresent = (await input.bucket.head(packageBlobContentKey(sha256))) !== null;
      if (!objectPresent) {
        await input.bucket.put(packageBlobContentKey(sha256), blobBytes);
      }
      const result = await tryInsertFile(input.d1, {
        versionId: version.id,
        blobId: blob.id,
        name,
        compositeKey: opts.compositeKey ?? "",
        isLead: opts.isLead ?? false,
        now,
      });
      if (result.outcome !== "created") {
        // upstream TryInsertFile fails ANY duplicate regardless of bytes
        // (package_file.go:46-58) → ErrDuplicatePackageFile → 409.
        throw new NugetDuplicatePackageFileError();
      }
      if (opts.symbolId !== undefined) {
        await drizzle(input.d1)
          .insert(packageProperties)
          .values({ refType: 1, refId: result.row.id, name: NUGET_SYMBOL_ID_PROPERTY, value: opts.symbolId })
          .run();
      }
      return result.row;
    };

    // strings.ToLower(fmt.Sprintf("%s.%s.snupkg", np.ID, np.Version)), IsLead false.
    const snupkgFile = await putFile(`${parsed.id}.${parsed.version}.snupkg`.toLowerCase(), bytes);

    // Each pdb: lower(name), CompositeKey = lower(pdb id), the symbol property.
    const pdbFiles: PackageFileRow[] = [];
    for (const pdb of pdbs) {
      pdbFiles.push(
        await putFile(pdb.name.toLowerCase(), pdb.content, {
          compositeKey: pdb.id.toLowerCase(),
          symbolId: pdb.id.toLowerCase(),
        }),
      );
    }
    return { snupkgFile, pdbFiles };
  } finally {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Downloads — OpenFileForDownloadByPackageNameAndVersion (packages.go:601-615)
// with the lead-file GET counter bump (:667-670). PackageNotExistError = 404.
// ---------------------------------------------------------------------------

export interface NugetDownload {
  file: PackageFileRow;
  blob: PackageBlobRow;
  version: PackageVersionRow;
  stream: ReadableStream;
  size: number;
}

export async function openNugetFileForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  packageName: string,
  packageVersion: string,
  filename: string,
  method: "GET" | "HEAD",
): Promise<NugetDownload | null> {
  const version = await getVersionByNameAndVersion(d1, owner.id, NUGET_TYPE, packageName, packageVersion);
  if (version === null) throw new NugetPackageNotExistError();
  const file = await getFileForVersionByName(d1, version.id, filename, "");
  if (file === null) throw new NugetPackageNotExistError();
  const blob = await getBlobById(d1, file.blobId);
  if (blob === null) throw new NugetPackageNotExistError();
  const object = await bucket.get(packageBlobContentKey(blob.hashSha256));
  if (object === null) throw new NugetPackageNotExistError();
  if (file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, version.id);
  }
  return { file, blob, version, stream: object.body, size: object.size };
}

// ---------------------------------------------------------------------------
// Delete — RemovePackageVersionByNameAndVersion (packages.go:504-512). The
// content keys are never deleted here (the unreferenced-blob sweep is the
// sole deleter — ratification 4).
// ---------------------------------------------------------------------------

export async function removeNugetVersion(
  d1: D1Database,
  owner: PackageOwnerRow,
  packageName: string,
  packageVersion: string,
): Promise<boolean> {
  const version = await getVersionByNameAndVersion(d1, owner.id, NUGET_TYPE, packageName, packageVersion);
  if (version === null) return false;
  await deletePackageVersionAndReferences(d1, version.id);
  return true;
}

// ---------------------------------------------------------------------------
// The symbol query protocol — DownloadSymbolFile (nuget.go:637-671)
// ---------------------------------------------------------------------------

const SYMBOL_GUID_REGEX = /^[0-9a-fA-F]{32}[fF]{8}$/;

export function isValidNugetSymbolGuid(segment: string): boolean {
  return SYMBOL_GUID_REGEX.test(segment);
}

/** SearchFiles (package_file.go:151-215 with the owner/type scope + the
 *  symbol property): files of the owner's non-internal nuget versions whose
 *  lower_name LIKEs the query and whose PropertyTypeFile rows match
 *  nuget.symbol.id = lower(guid). Exactly one hit or null (404). */
export async function findNugetSymbolFile(
  d1: D1Database,
  owner: PackageOwnerRow,
  filename: string,
  guid: string,
): Promise<{ file: PackageFileRow; blob: PackageBlobRow; version: PackageVersionRow } | null> {
  const rows = await drizzle(d1)
    .select({ file: packageFiles, blob: packageBlobs, version: packageVersions })
    .from(packageFiles)
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
    .innerJoin(
      packageProperties,
      and(
        eq(packageProperties.refType, 1),
        eq(packageProperties.refId, packageFiles.id),
        eq(packageProperties.name, NUGET_SYMBOL_ID_PROPERTY),
        eq(packageProperties.value, guid.toLowerCase()),
      ),
    )
    .where(
      and(
        eq(packages.ownerId, owner.id),
        eq(packages.type, NUGET_TYPE),
        eq(packageVersions.isInternal, false),
        like(packageFiles.lowerName, `%${filename.toLowerCase()}%`),
      ),
    )
    .all();
  if (rows.length !== 1) return null; // len(pfs) != 1 → 404
  const found = rows[0];
  if (found === undefined) return null;
  return { file: found.file, blob: found.blob, version: found.version };
}

export async function openNugetSymbolFileForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  filename: string,
  guid: string,
  method: "GET" | "HEAD",
): Promise<NugetDownload | null> {
  const found = await findNugetSymbolFile(d1, owner, filename, guid);
  if (found === null) return null;
  const object = await bucket.get(packageBlobContentKey(found.blob.hashSha256));
  if (object === null) return null;
  if (found.file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, found.version.id);
  }
  return { file: found.file, blob: found.blob, version: found.version, stream: object.body, size: object.size };
}

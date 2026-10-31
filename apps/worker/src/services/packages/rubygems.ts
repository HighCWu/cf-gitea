/**
 * The RubyGems protocol service (SPEC-0016 §7's long-tail `rubygems` row) —
 * the service half of `/api/packages/{username}/rubygems/...` (upstream
 * routers/api/packages/rubygems/rubygems.go 466 ln over
 * modules/packages/rubygems/{marshal.go, metadata.go} at the pin fc493688,
 * with tests/integration/api_packages_rubygems_test.go as the client-shape
 * oracle).
 *
 * ## The protocol surface (api.go:437-447 — the whole group wrapped in
 * reqPackageAccess(read), the api/v1/gems subgroup adding write)
 *
 *   - `GET /specs.4.8.gz`            — EnumeratePackages: EVERY version of
 *     the owner's rubygems type (GetVersionsByPackageType → SearchVersions,
 *     created DESC), each rendered `[name, Gem::Version-marshal, platform]`,
 *     Marshal-4.8 encoded, gzipped ("specs.4.8").
 *   - `GET /latest_specs.4.8.gz`     — EnumeratePackagesLatest: the latest
 *     version per package (SearchLatestVersions), "latest_specs.4.8".
 *   - `GET /prerelease_specs.4.8.gz` — EnumeratePackagesPreRelease: NOT
 *     supported — always the EMPTY list (rubygems.go:59-61), encoded
 *     `[\x00` ("prerelease_specs.4.8").
 *   - `GET /quick/Marshal.4.8/{filename}` — ServePackageSpecification: the
 *     filename MUST end `.gemspec.rz` (else 501 EMPTY); it names the stored
 *     gem ("{X}.gemspec.rz" → "{X}.gem"), whose version row is then rendered
 *     as a Marshal-4.8 `Gem::Specification` USERDEF (rubygems.go:132-158, 19
 *     fields — the @rubygems_version "3.2.3" / @specification_version 4 /
 *     nil-date render upstream pins) and served ZLIB-compressed.
 *   - `GET /gems/{filename}` — DownloadPackageFile: the ONE version whose
 *     file set contains the exact filename (len != 1 → 404 EMPTY), the stored
 *     .gem bytes through helper.ServePackageFile (the D-6 serve set), the
 *     lead GET bumping the download counter.
 *   - `GET /info/{packagename}` — GetPackageInfo: the compact-index text for
 *     ONE gem (`---\n` + one line per version; no versions → 404 EMPTY).
 *   - `GET /versions` — GetAllPackagesVersions: the compact index of EVERY
 *     package (`{name} {versions} {md5-of-info}` lines).
 *   - `POST /api/v1/gems` — UploadPackageFile: the RAW BODY is the .gem
 *     (ctx.UploadStream — the integration test posts bare bytes, no
 *     multipart); parse → 201, duplicate version → 409.
 *   - `DELETE /api/v1/gems/yank` — DeletePackage: gem_name + version from
 *     the form (ParseMultipartForm — a non-multipart content type is
 *     upstream's 500 arm; the integration test posts multipart fields), the
 *     version delete → 200 EMPTY, unknown → 404.
 *
 * ## The pin's parse posture — YAML, not Marshal (the mission-brief
 * correction)
 *
 * The `.gem` container is a tar of `metadata.gz` + `data.tar.gz` +
 * `checksums.yaml.gz`, and metadata.gz is a gzipped Yaml document with
 * `!ruby/object:Gem::*` tags — Ruby's `Gem::Specification#to_yaml` output.
 * At the pin upstream parses it with go.yaml.in/yaml/v4 into a typed gemspec
 * struct (metadata.go:176-246, yaml.NewDecoder over a 32 MiB limited
 * reader); `modules/packages/rubygems/marshal.go` carries the Marshal
 * ENCODER ONLY (NewMarshalEncoder — grep-verified: no MarshalDecoder exists
 * anywhere in the pin tree), used for the specs.4.8 enumerations and the
 * quick/Marshal.4.8 gemspec render. This module ports both halves
 * anchor-for-anchor: the encoder byte-for-byte (the marshal_test.go vectors
 * + the integration test's gemspec.rz byte string are the oracles), and the
 * YAML parse with the `yaml` package's unknown-tag resolution —
 * `!ruby/object:…` tags resolve to their natural mapping/sequence shapes
 * with warnings suppressed (logLevel "error"), Go yaml.v3's silent posture.
 *
 * ## Version semantics
 *
 * The version string is stored VERBATIM from the gemspec (no server-side
 * Gem::Version normalization exists in the pin — Ruby normalizes client-
 * side); the gate is metadata.go's versionMatcher regex
 * `\A[0-9]+(?:\.[0-9a-zA-Z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z`
 * (→ ErrInvalidVersion 400). The package row is SemverCompatible (upload:
 * SemverCompatible: true, rubygems.go:243), so the model's descriptor sort
 * orders versions semantically. Gem::Version appears ON THE WIRE only as the
 * marshal wrapper `U:\x11Gem::Version[\x06{version}`.
 *
 * ## Storage posture
 *
 * No properties — the Metadata struct serializes into the version row's
 * MetadataJSON (upstream passes Metadata through PackageCreationInfo into
 * createPackageAndVersion) with upstream's json-tag key order and omitempty
 * semantics; the .gem bytes store VERBATIM as the ONE lead file
 * `{name}-{version}[-{platform}].gem` (makeGemFullFileName, lowercased).
 *
 * ## Error shapes (apiError → helper.ProcessErrorForUser → ctx.PlainText)
 *
 * 400: ErrMissingMetadataFile / ErrInvalidName / ErrInvalidVersion /
 * ErrInvalidMetadata (the compact-index line-forgery gate) /
 * ErrContentTooLarge (the 32 MiB metadata cap) — all util InvalidArgument
 * sentinels. 404: the resolve misses (ErrPackageNotExist "package does not
 * exist") and the nil-detail EMPTY-body 404s (the len!=1 file searches, the
 * empty info). 409: ErrDuplicatePackageVersion. 403: quota. 501: the
 * non-.gemspec.rz quick filename. 500: everything else — corrupt
 * tar/gzip/YAML (plain Go errors upstream: tar.Next, gzip.NewReader,
 * yaml.Decode are not InvalidArgument), a duplicate file row (the DEFAULT
 * arm), the prod body strip.
 *
 * ## Documented reductions
 *
 * - The upload is capped at 64 MiB (413 — the go/nuget/arch parse-family
 *   precedent: upstream spools with no explicit cap, ours materializes the
 *   bytes for the tar walk).
 * - The 32 MiB metadata cap is enforced AFTER inflating (upstream trips
 *   NewLimitedReader mid-stream); same sentinel, same status.
 * - The tar walk is self-contained here (the distro-common reader answers a
 *   finished list; upstream's tar.Next RETURNS EARLY on metadata.gz, so a
 *   malformed member AFTER it must not fail the parse — the walk below keeps
 *   the early return and Go's header-checksum/partial-block 500 arms).
 * - Single-member + concatenated-member gzip decode rides distro-common's
 *   walkGzipMembers (Go's gzip.Reader multistream default); a body with no
 *   gzip magic errors (upstream gzip.NewReader's 500 arm).
 * - yaml.parse() reads a single document (Go's Decoder.Decode reads the
 *   first of a stream) — multi-document metadata is pathological.
 * - RubyObject's Go map iteration order is undefined upstream; the port
 *   emits members in insertion order (deterministic; the type exists only
 *   for encoder completeness — no rubygems wire path emits an object).
 */

import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";

import { packageBlobs, packageFiles, packageVersions, packages } from "../../db/schema";
import {
  Document,
  isMap as isYamlMap,
  isScalar as isYamlScalar,
  isSeq as isYamlSeq,
  parseDocument,
  type Scalar,
} from "yaml";

import {
  type PackageBlobRow,
  type PackageDoer,
  type PackageFileRow,
  type PackageOwnerRow,
  type PackageVersionRow,
  type PackagesQuotaConfig,
  QuotaTotalCountError,
  UNLIMITED_QUOTA,
  checkSizeQuotaExceeded,
  countVersions,
  deletePackageVersionAndReferences,
  getFileDescriptors,
  getOrInsertPackage,
  getOrInsertVersion,
  getVersionByNameAndVersion,
  incrementDownloadCounter,
  searchLatestVersions,
  searchVersions,
  tryInsertFile,
} from "./model";
import { isValidAbsoluteHttpUrl, writeVersionMetadata } from "./protocol-common";
import { copySpoolToContentKey, getOrInsertBlob, packageBlobContentKey, spoolAndHash, type SpooledBlob } from "./blobs";
import { concatBytes, walkGzipMembers } from "./distro-common";
import { md5Hex } from "./maven";

// ---------------------------------------------------------------------------
// Upstream sentinels (metadata.go:23-30 + limited_reader.go:12 + the
// router's error arms)
// ---------------------------------------------------------------------------

/** ErrMissingMetadataFile (metadata.go:24) → 400. */
export class RubyMissingMetadataFileError extends Error {
  constructor() {
    super("metadata.gz file is missing");
    this.name = "RubyMissingMetadataFileError";
  }
}

/** ErrInvalidName (metadata.go:26) → 400. */
export class RubyInvalidNameError extends Error {
  constructor() {
    super("package name is invalid");
    this.name = "RubyInvalidNameError";
  }
}

/** ErrInvalidVersion (metadata.go:28) → 400. */
export class RubyInvalidVersionError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "RubyInvalidVersionError";
  }
}

/** ErrInvalidMetadata (metadata.go:30) — metadata that would forge compact-
 *  index lines → 400. */
export class RubyInvalidMetadataError extends Error {
  constructor() {
    super("package metadata is invalid");
    this.name = "RubyInvalidMetadataError";
  }
}

/** ErrContentTooLarge (limited_reader.go:12) — the 32 MiB metadata cap → 400. */
export class RubyContentTooLargeError extends Error {
  constructor() {
    super("content exceeds the size limit");
    this.name = "RubyContentTooLargeError";
  }
}

/** ErrInvalidIntRange (marshal.go:37) — the encoder's fixnum-range throw. */
export class RubyMarshalIntRangeError extends Error {
  constructor() {
    super("number is not in valid range");
    this.name = "RubyMarshalIntRangeError";
  }
}

/** ErrUnsupportedType (marshal.go:35) — the encoder's unsupported-value throw. */
export class RubyMarshalUnsupportedTypeError extends Error {
  constructor() {
    super("type is unsupported");
    this.name = "RubyMarshalUnsupportedTypeError";
  }
}

/** resolve misses (getVersionsByFilename len != 1, the yank miss) → 404. */
export class RubyPackageNotExistError extends Error {
  constructor() {
    super("package does not exist");
    this.name = "RubyPackageNotExistError";
  }
}

/** ErrDuplicatePackageVersion (rubygems.go:258-259) → 409. */
export class RubyDuplicateVersionError extends Error {
  constructor(readonly existing: PackageVersionRow) {
    super("package version already exists");
    this.name = "RubyDuplicateVersionError";
  }
}

/** The upload parse cap (the go/nuget/arch parse-family reduction; upstream
 *  spools the upload with no explicit cap — module-header note). */
export const MAX_RUBYGEMS_UPLOAD_BYTES = 64 * 1024 * 1024;

/** MaxMetadataSize (limited_reader.go:14) — the DECOMPRESSED metadata cap. */
export const MAX_RUBYGEMS_METADATA_SIZE = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The Marshal 4.8 encoder — modules/packages/rubygems/marshal.go ported
// anchor-for-anchor (the pin's marshal code is encoder-only; the
// marshal_test.go byte vectors are the oracle this module's suite pins)
// ---------------------------------------------------------------------------

export const MARSHAL_MAJOR_VERSION = 4;
export const MARSHAL_MINOR_VERSION = 8;

const typeNil = 0x30; // '0'
const typeTrue = 0x54; // 'T'
const typeFalse = 0x46; // 'F'
const typeFixnum = 0x69; // 'i'
const typeString = 0x22; // '"'
const typeSymbol = 0x3a; // ':'
const typeSymbolLink = 0x3b; // ';'
const typeArray = 0x5b; // '['
const typeIVar = 0x49; // 'I'
const typeUserMarshal = 0x55; // 'U'
const typeUserDef = 0x75; // 'u'
const typeObject = 0x6f; // 'o'

/** RubyUserMarshal (marshal.go:41-44) — a Ruby object with marshal_load. */
export class RubyUserMarshal {
  constructor(readonly name: string, readonly value: MarshalValue) {}
}

/** RubyUserDef (marshal.go:47-50) — a Ruby object with _load. */
export class RubyUserDef {
  constructor(readonly name: string, readonly value: MarshalValue) {}
}

/** RubyObject (marshal.go:53-57) — a default Ruby object. Members keep
 *  insertion order (Go's map order is undefined — the module-header note). */
export class RubyObject {
  constructor(
    readonly name: string,
    readonly members: [string, MarshalValue][],
  ) {}
}

/** The value set the encoder carries (marshal.go's supported types). */
export type MarshalValue = null | boolean | number | string | MarshalValue[] | RubyUserMarshal | RubyUserDef | RubyObject;

/** The bufio.Writer stand-in: a flat byte buffer (the payloads are small —
 *  one specs list, one gemspec). */
class MarshalBuffer {
  private chunks: number[][] = [];

  writeByte(byte: number): void {
    this.chunks.push([byte]);
  }

  writeBytes(bytes: Uint8Array | number[]): void {
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i] as number);
    this.chunks.push(out);
  }

  toBytes(): Uint8Array {
    return concatBytes(...this.chunks);
  }
}

/** MarshalEncoder (marshal.go:58-71): the symbol table dedups across the
 *  whole encoding (':'-symbols emit once, then ';' + index links). */
export class MarshalEncoder {
  private readonly w = new MarshalBuffer();
  private readonly symbols = new Map<string, number>();

  /** Encode (marshal.go:74-85): the 4.8 version header, the value, flush. */
  encode(value: MarshalValue): Uint8Array {
    this.w.writeBytes([MARSHAL_MAJOR_VERSION, MARSHAL_MINOR_VERSION]);
    this.marshal(value);
    return this.w.toBytes();
  }

  private marshal(v: MarshalValue): void {
    if (v === null) {
      this.w.writeByte(typeNil);
      return;
    }
    if (typeof v === "boolean") {
      this.w.writeByte(v ? typeTrue : typeFalse);
      return;
    }
    if (typeof v === "number") {
      this.w.writeByte(typeFixnum);
      this.marshalIntInternal(v);
      return;
    }
    if (typeof v === "string") {
      this.marshalString(v);
      return;
    }
    if (Array.isArray(v)) {
      this.w.writeByte(typeArray);
      this.marshalIntInternal(v.length);
      for (const item of v) this.marshal(item);
      return;
    }
    if (v instanceof RubyUserMarshal) {
      this.w.writeByte(typeUserMarshal);
      this.marshalSymbol(v.name);
      this.marshal(v.value);
      return;
    }
    if (v instanceof RubyUserDef) {
      // marshalUserDef (marshal.go:273-290): the value encodes through a
      // FRESH encoder (its own 4.8 header), then length-prefixed bytes.
      const inner = new MarshalEncoder().encode(v.value);
      this.w.writeByte(typeUserDef);
      this.marshalSymbol(v.name);
      this.marshalIntInternal(inner.byteLength);
      this.w.writeBytes(inner);
      return;
    }
    if (v instanceof RubyObject) {
      this.w.writeByte(typeObject);
      this.marshalSymbol(v.name);
      this.marshalIntInternal(v.members.length);
      for (const [key, value] of v.members) {
        this.marshalSymbol(key);
        this.marshal(value);
      }
      return;
    }
    throw new RubyMarshalUnsupportedTypeError();
  }

  /** marshalIntInternal (marshal.go:141-185): the single-byte forms (0;
   *  1..122 as +5; -123..-1 as -5), else the length-form — positive lengths
   *  1-4 little-endian for 123..0x3fffffff, NEGATIVE lengths for the
   *  -0x40000000..-124 range, outside either → ErrInvalidIntRange. */
  private marshalIntInternal(i: number): void {
    if (!Number.isSafeInteger(i)) throw new RubyMarshalIntRangeError();
    if (i === 0) {
      this.w.writeByte(0);
      return;
    }
    if (i > 0 && i < 123) {
      this.w.writeByte(i + 5);
      return;
    }
    if (i > -124 && i <= -1) {
      this.w.writeByte(i - 5);
      return;
    }
    let length: number;
    if (i > 122 && i <= 0xff) length = 1;
    else if (i <= 0xffff && i > 0xff) length = 2;
    else if (i <= 0xffffff && i > 0xffff) length = 3;
    else if (i <= 0x3fffffff && i > 0xffffff) length = 4;
    else if (i >= -0x100 && i < -123) length = -1;
    else if (i >= -0x10000 && i < -0x100) length = -2;
    else if (i >= -0x1000000 && i < -0x100000) length = -3;
    else if (i >= -0x40000000 && i < -0x1000000) length = -4;
    else throw new RubyMarshalIntRangeError();

    this.w.writeByte(length);
    const width = length < 0 ? -length : length;
    for (let c = 0; c < width; c++) {
      this.w.writeByte((i >> (8 * c)) & 0xff);
    }
  }

  /** marshalString (marshal.go:187-205): IVar-wrapped raw string with the
   *  single E=true instance variable (Ruby's UTF-8-ness marker). */
  private marshalString(str: string): void {
    this.w.writeByte(typeIVar);
    this.marshalRawString(str);
    this.marshalIntInternal(1);
    this.marshalSymbol("E");
    this.w.writeByte(typeTrue);
  }

  private marshalRawString(str: string): void {
    this.w.writeByte(typeString);
    const bytes = new TextEncoder().encode(str);
    this.marshalIntInternal(bytes.byteLength);
    this.w.writeBytes(bytes);
  }

  private marshalSymbol(str: string): void {
    const known = this.symbols.get(str);
    if (known !== undefined) {
      this.w.writeByte(typeSymbolLink);
      this.marshalIntInternal(known);
      return;
    }
    this.symbols.set(str, this.symbols.size);
    this.w.writeByte(typeSymbol);
    const bytes = new TextEncoder().encode(str);
    this.marshalIntInternal(bytes.byteLength);
    this.w.writeBytes(bytes);
  }
}

// ---------------------------------------------------------------------------
// The gemspec matchers (metadata.go:37-41) — Ruby's VALID_NAME_PATTERN and
// the Gem::Version-shaped version grammar, Go regexp anchor-for-anchor
// ---------------------------------------------------------------------------

/** `\A[\w.-]+\z` — Go \w = [0-9A-Za-z_]. */
const NAME_MATCHER = /^[0-9A-Za-z_.-]+$/;

/** `\A[0-9]+(?:\.[0-9a-zA-Z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z`. */
const VERSION_MATCHER = /^[0-9]+(?:\.[0-9a-zA-Z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// ---------------------------------------------------------------------------
// The Metadata struct (metadata.go:51-74) — the version row's MetadataJSON
// payload in upstream's json-tag key order (omitempty: keys land only when
// non-empty)
// ---------------------------------------------------------------------------

export interface RubyGemVersionRequirement {
  restriction: string;
  version: string;
}

export interface RubyGemDependency {
  name: string;
  version: RubyGemVersionRequirement[];
}

export interface RubyGemMetadata {
  platform: string;
  description: string;
  summary: string;
  authors: string[];
  licenses: string[];
  requiredRubyVersion: RubyGemVersionRequirement[];
  requiredRubygemsVersion: RubyGemVersionRequirement[];
  projectUrl: string;
  runtimeDependencies: RubyGemDependency[];
  developmentDependencies: RubyGemDependency[];
}

/** buildRubyGemMetadataJson — upstream's Metadata json tags, omitempty: a key
 *  lands only when its value is non-empty (Go drops zero strings and
 *  zero-length slices, metadata.go:51-62). */
export function buildRubyGemMetadataJson(m: RubyGemMetadata): string {
  const doc: Record<string, unknown> = {};
  if (m.platform !== "") doc.platform = m.platform;
  if (m.description !== "") doc.description = m.description;
  if (m.summary !== "") doc.summary = m.summary;
  if (m.authors.length > 0) doc.authors = m.authors;
  if (m.licenses.length > 0) doc.licenses = m.licenses;
  if (m.requiredRubyVersion.length > 0) doc.required_ruby_version = m.requiredRubyVersion;
  if (m.requiredRubygemsVersion.length > 0) doc.required_rubygems_version = m.requiredRubygemsVersion;
  if (m.projectUrl !== "") doc.project_url = m.projectUrl;
  if (m.runtimeDependencies.length > 0) doc.runtime_dependencies = m.runtimeDependencies;
  if (m.developmentDependencies.length > 0) doc.development_dependencies = m.developmentDependencies;
  return JSON.stringify(doc);
}

/** loadRubyGemMetadata — the descriptor's Metadata read (descriptor.go:211's
 *  &rubygems.Metadata{} with zero values when the JSON is absent/corrupt). */
export function loadRubyGemMetadata(version: PackageVersionRow): RubyGemMetadata {
  const empty: RubyGemMetadata = {
    platform: "",
    description: "",
    summary: "",
    authors: [],
    licenses: [],
    requiredRubyVersion: [],
    requiredRubygemsVersion: [],
    projectUrl: "",
    runtimeDependencies: [],
    developmentDependencies: [],
  };
  if (version.metadataJson === null || version.metadataJson === "") return empty;
  try {
    const parsed: unknown = JSON.parse(version.metadataJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    const doc = parsed as Record<string, unknown>;
    const str = (key: string): string => (typeof doc[key] === "string" ? doc[key] : "");
    const list = (key: string): string[] => {
      const value = doc[key];
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    };
    const asReqList = (value: unknown): RubyGemVersionRequirement[] => {
      if (!Array.isArray(value)) return [];
      return value.flatMap((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
        const record = entry as Record<string, unknown>;
        if (typeof record.restriction !== "string" || typeof record.version !== "string") return [];
        return [{ restriction: record.restriction, version: record.version }];
      });
    };
    const reqs = (key: string): RubyGemVersionRequirement[] => asReqList(doc[key]);
    const deps = (key: string): RubyGemDependency[] => {
      if (!Array.isArray(doc[key])) return [];
      return (doc[key] as unknown[]).flatMap((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
        const record = entry as Record<string, unknown>;
        if (typeof record.name !== "string") return [];
        return [{ name: record.name, version: asReqList(record.version) }];
      });
    };
    return {
      platform: str("platform"),
      description: str("description"),
      summary: str("summary"),
      authors: list("authors"),
      licenses: list("licenses"),
      requiredRubyVersion: reqs("required_ruby_version"),
      requiredRubygemsVersion: reqs("required_rubygems_version"),
      projectUrl: str("project_url"),
      runtimeDependencies: deps("runtime_dependencies"),
      developmentDependencies: deps("development_dependencies"),
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// ParsePackageMetaData (metadata.go:157-246) — the tar walk, the gzip
// inflate with the 32 MiB cap, the YAML gemspec decode, the validation gates
// ---------------------------------------------------------------------------

/** The gemspec struct (metadata.go:76-118) in the fields the Metadata build
 *  reads; every other upstream field decodes and dies unused. */
export interface RubyGemPackage {
  name: string;
  version: string;
  metadata: RubyGemMetadata;
}

/** tarNameAt — the ustar name (+prefix twin) as Go archive/tar's Header.Name. */
function tarNameAt(bytes: Uint8Array, offset: number): string {
  const field = (start: number, length: number): string => {
    let end = start;
    const stop = start + length;
    while (end < stop && bytes[end] !== 0) end++;
    return new TextDecoder("latin1").decode(bytes.subarray(start, end));
  };
  const name = field(offset, 100);
  const prefix = field(offset + 345, 155);
  return prefix !== "" ? `${prefix}/${name}` : name;
}

/** tarSizeAt — the octal size field (garbage is tar.Next's plain error → the
 *  500 arm; all-NUL/all-space decodes to 0). */
function tarSizeAt(bytes: Uint8Array, offset: number): number {
  let text = "";
  for (let i = 0; i < 12; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined || byte === 0) break;
    text += String.fromCharCode(byte);
  }
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  if (!/^[0-7]+$/.test(trimmed)) throw new Error("malformed tar size");
  const size = Number.parseInt(trimmed, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("malformed tar size");
  return size;
}

/** tarHeaderChecksumOk — Go tar.Next's header validation (the unsigned sum
 *  with the checksum field as spaces; the signed variant never differs here
 *  — header bytes are ASCII). */
function tarHeaderChecksumOk(bytes: Uint8Array, offset: number): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    const byte = bytes[offset + i] ?? 0;
    sum += i >= 148 && i < 156 ? 0x20 : byte;
  }
  let text = "";
  for (let i = 0; i < 8; i++) {
    const byte = bytes[offset + 148 + i];
    if (byte === undefined || byte === 0) break;
    text += String.fromCharCode(byte);
  }
  const parsed = Number.parseInt(text.trim(), 8);
  return Number.isSafeInteger(parsed) && parsed === sum;
}

/**
 * The tar walk of ParsePackageMetaData (metadata.go:158-174): entries in
 * order; `metadata.gz` RETURNS EARLY (a malformed member after it never
 * read); tar.Next's structural failures (partial trailing block, bad header
 * checksum, garbage size) are plain errors → the 500 arm; no member →
 * ErrMissingMetadataFile.
 */
export function extractGemMetadataGz(bytes: Uint8Array): Uint8Array {
  let offset = 0;
  let sawEndBlock = false;
  while (offset + 512 <= bytes.byteLength) {
    if ((bytes[offset] ?? 0) === 0) {
      sawEndBlock = true; // the end block(s) — tar.EOF
      break;
    }
    if (!tarHeaderChecksumOk(bytes, offset)) throw new Error("tar: header checksum failed");
    const size = tarSizeAt(bytes, offset + 124);
    const name = tarNameAt(bytes, offset);
    const dataStart = offset + 512;
    if (dataStart + size > bytes.byteLength) throw new Error("tar: truncated member");
    if (name === "metadata.gz") {
      return bytes.slice(dataStart, dataStart + size);
    }
    offset = dataStart + size + ((512 - (size % 512)) % 512);
  }
  if (!sawEndBlock && bytes.byteLength > offset) throw new Error("tar: unexpected EOF"); // a partial trailing block
  throw new RubyMissingMetadataFileError();
}

/**
 * The metadata inflate: walkGzipMembers over the member bytes (Go
 * gzip.NewReader's multistream default), the DECOMPRESSED total capped at
 * MaxMetadataSize by NewLimitedReader (→ ErrContentTooLarge); a body with no
 * gzip magic errors (gzip.NewReader's plain error → the 500 arm).
 */
export async function gunzipGemMetadata(bytes: Uint8Array): Promise<Uint8Array> {
  const members = await walkGzipMembers(bytes);
  if (members.length === 0) throw new Error("gzip: invalid header");
  let total = 0;
  const chunks: Uint8Array[] = [];
  for (const member of members) {
    total += member.payload.byteLength;
    if (total > MAX_RUBYGEMS_METADATA_SIZE) throw new RubyContentTooLargeError();
    chunks.push(member.payload);
  }
  return concatBytes(...chunks);
}

// --- the YAML gemspec decode (metadata.go's typed struct over yaml.v3) ----
//
// Go yaml.v3 decodes scalars into a STRING field through `n.Value` — the
// scalar's TEXTUAL value ("1.0" stays "1.0"). The platform parser resolves
// plain scalars (1.0 → the float 1), so the decode walks the DOCUMENT nodes
// with source tokens: a plain scalar reads its `srcToken.source` verbatim
// (n.Value), a quoted/block scalar its unescaped `value` (Go unescapes the
// same way). A collection where a scalar/slice/struct belongs is yaml.v3's
// type error — the decode-failure arm (null → the 500).

/** A decoded node: map / seq / scalar-with-text (null text = the null node). */
type GemNode =
  | { kind: "map"; entries: [string, GemNode][] }
  | { kind: "seq"; items: GemNode[] }
  | { kind: "scalar"; text: string };

/** scalarText — Go n.Value for a string target: the plain source verbatim,
 *  the quoted/block unescaped value; a null scalar decodes to "" (yaml.v3
 *  leaves the zero value). */
function gemScalar(node: Scalar): { kind: "scalar"; text: string } {
  const source = (node.srcToken as { source?: string } | undefined)?.source;
  if (node.type === "PLAIN" && typeof source === "string") {
    return { kind: "scalar", text: source };
  }
  return {
    kind: "scalar",
    text:
      typeof node.value === "string"
        ? node.value
        : typeof node.value === "number" || typeof node.value === "boolean"
          ? String(node.value)
          : "",
  };
}

function toGemNode(node: unknown): GemNode | null {
  if (isYamlMap(node)) {
    const entries: [string, GemNode][] = [];
    for (const pair of node.items) {
      const key = pair.key;
      if (!isYamlScalar(key)) return null; // Go: a collection key into the struct walk is a decode error
      const { text } = gemScalar(key);
      const value = pair.value;
      if (value === undefined) {
        entries.push([text, { kind: "scalar", text: "" }]);
        continue;
      }
      const decoded = toGemNode(value);
      if (decoded === null) return null;
      entries.push([text, decoded]);
    }
    return { kind: "map", entries };
  }
  if (isYamlSeq(node)) {
    const items: GemNode[] = [];
    for (const item of node.items) {
      const decoded = toGemNode(item);
      if (decoded === null) return null;
      items.push(decoded);
    }
    return { kind: "seq", items };
  }
  if (isYamlScalar(node)) return gemScalar(node);
  return null;
}

/** The document walk: null = the decode-failure arm (a parse error, a
 *  non-mapping root, a collection key — Go's Decode error / io.EOF). */
function parseGemDocument(text: string): GemNode | null {
  let doc: Document;
  try {
    doc = parseDocument(text, { keepSourceTokens: true, logLevel: "error" });
  } catch {
    return null;
  }
  if (doc.errors.length > 0) return null;
  if (doc.contents === null || doc.contents === undefined) return null; // Decoder.Decode's io.EOF
  return toGemNode(doc.contents);
}

function nodeMap(node: GemNode | undefined): Map<string, GemNode> | null {
  if (node === undefined || (node.kind === "scalar" && node.text === "")) return new Map(); // nil → the zero struct
  if (node.kind !== "map") return null;
  return new Map(node.entries);
}

function nodeString(node: GemNode | undefined): string | null {
  if (node === undefined) return "";
  if (node.kind !== "scalar") return null;
  return node.text;
}

function nodeStringList(node: GemNode | undefined): string[] | null {
  if (node === undefined) return [];
  if (node.kind === "scalar" && node.text === "") return []; // nil → the nil slice
  if (node.kind !== "seq") return null;
  const out: string[] = [];
  for (const item of node.items) {
    const text = nodeString(item);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}

/** nodeToPlain — the any-shaped value asVersionRequirement walks: scalars
 *  render their text, collections convert recursively (Go's []any /
 *  map[string]any decode). */
function nodeToPlain(node: GemNode): unknown {
  if (node.kind === "scalar") return node.text;
  if (node.kind === "seq") return node.items.map(nodeToPlain);
  const out: Record<string, unknown> = {};
  for (const [key, value] of node.entries) out[key] = nodeToPlain(value);
  return out;
}

/** requirement's `requirements` — Go's [][]any: each element must be a seq
 *  (a scalar/map element is the type error → 500) or the null node (stays
 *  nil, len != 2 skips it in asVersionRequirement). */
function nodeRequirements(node: GemNode | undefined): unknown[] | null {
  if (node === undefined) return [];
  if (node.kind === "scalar" && node.text === "") return []; // nil
  if (node.kind !== "seq") return null;
  const rows: unknown[] = [];
  for (const item of node.items) {
    if (item.kind === "scalar" && item.text === "") {
      rows.push(null);
      continue;
    }
    if (item.kind !== "seq") return null;
    rows.push(item.items.map(nodeToPlain));
  }
  return rows;
}

/** asVersionRequirement (metadata.go:125-154) — the `[[restriction, {version:
 *  string}], ...]` shape; every other entry SKIPS (len != 2, non-string
 *  restriction, non-map version holder, missing/non-string version) and the
 *  `>= 0` default pair drops. */
export function asVersionRequirement(requirements: unknown): RubyGemVersionRequirement[] {
  const out: RubyGemVersionRequirement[] = [];
  if (!Array.isArray(requirements)) return out;
  for (const entry of requirements) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const req: unknown[] = entry;
    const restriction = req[0];
    if (typeof restriction !== "string") continue;
    const holder = req[1];
    if (holder === null || typeof holder !== "object" || Array.isArray(holder)) continue;
    const record = holder as Record<string, unknown>;
    if (!("version" in record)) continue;
    const version = record.version;
    if (typeof version !== "string") continue;
    if (version === "0" && restriction === ">=") continue;
    out.push({ restriction, version });
  }
  return out;
}

/** decodeGemspec — yaml.v3's decode into the gemspec struct: the document
 *  must be a mapping; field type mismatches (a collection where a scalar/
 *  slice/struct belongs) are DECODE ERRORS (null answer → the 500 arm);
 *  unknown fields are ignored (yaml.v3's non-strict default). */
function decodeGemspec(text: string): {
  name: string;
  version: string;
  platform: string;
  authors: string[];
  description: string;
  homepage: string;
  licenses: string[];
  summary: string;
  requiredRubyVersion: RubyGemVersionRequirement[];
  requiredRubygemsVersion: RubyGemVersionRequirement[];
  dependencies: { name: string; type: string; requirement: RubyGemVersionRequirement[] }[];
} | null {
  const doc = parseGemDocument(text);
  if (doc === null) return null; // the decode error / io.EOF arm
  const root = nodeMap(doc);
  if (root === null) return null;
  const name = nodeString(root.get("name"));
  if (name === null) return null;
  const versionMap = nodeMap(root.get("version"));
  if (versionMap === null) return null;
  const version = nodeString(versionMap.get("version"));
  if (version === null) return null;
  const platform = nodeString(root.get("platform"));
  if (platform === null) return null;
  const authors = nodeStringList(root.get("authors"));
  if (authors === null) return null;
  const description = nodeString(root.get("description"));
  if (description === null) return null;
  const homepage = nodeString(root.get("homepage"));
  if (homepage === null) return null;
  const licenses = nodeStringList(root.get("licenses"));
  if (licenses === null) return null;
  const summary = nodeString(root.get("summary"));
  if (summary === null) return null;
  const requiredRuby = nodeMap(root.get("required_ruby_version"));
  if (requiredRuby === null) return null;
  const requiredRubygems = nodeMap(root.get("required_rubygems_version"));
  if (requiredRubygems === null) return null;
  const requirementsRuby = nodeRequirements(requiredRuby.get("requirements"));
  if (requirementsRuby === null) return null;
  const requirementsRubygems = nodeRequirements(requiredRubygems.get("requirements"));
  if (requirementsRubygems === null) return null;
  const dependencies: { name: string; type: string; requirement: RubyGemVersionRequirement[] }[] = [];
  const depsNode = root.get("dependencies");
  if (depsNode !== undefined && !(depsNode.kind === "scalar" && depsNode.text === "")) {
    if (depsNode.kind !== "seq") return null;
    for (const entry of depsNode.items) {
      const dep = nodeMap(entry);
      if (dep === null) return null;
      const depName = nodeString(dep.get("name"));
      if (depName === null) return null;
      const depType = nodeString(dep.get("type"));
      if (depType === null) return null;
      const requirementMap = nodeMap(dep.get("requirement"));
      if (requirementMap === null) return null;
      const requirements = nodeRequirements(requirementMap.get("requirements"));
      if (requirements === null) return null;
      dependencies.push({ name: depName, type: depType, requirement: asVersionRequirement(requirements) });
    }
  }
  return {
    name,
    version,
    platform,
    authors,
    description,
    homepage,
    licenses,
    summary,
    requiredRubyVersion: asVersionRequirement(requirementsRuby),
    requiredRubygemsVersion: asVersionRequirement(requirementsRubygems),
    dependencies,
  };
}

/**
 * parseGemMetadata (metadata.go:176-246): the validations and the Metadata
 * build — name/version regexes (→ ErrInvalidName / ErrInvalidVersion), the
 * homepage URL validation (invalid → dropped), the dependency split on
 * `type: ":runtime"` (everything else development), and the
 * compact-index line-forgery gate (any indexed value carrying \r or \n →
 * ErrInvalidMetadata, metadata.go:228-239).
 */
export function parseGemMetadata(text: string): RubyGemPackage {
  const spec = decodeGemspec(text);
  if (spec === null) {
    // yaml.v3's decode error — a plain error → the 500 arm.
    throw new Error("yaml: cannot decode gem specification");
  }
  if (!NAME_MATCHER.test(spec.name)) throw new RubyInvalidNameError();
  if (!VERSION_MATCHER.test(spec.version)) throw new RubyInvalidVersionError();

  const metadata: RubyGemMetadata = {
    platform: spec.platform,
    description: spec.description,
    summary: spec.summary,
    authors: spec.authors,
    licenses: spec.licenses,
    projectUrl: isValidAbsoluteHttpUrl(spec.homepage) ? spec.homepage : "",
    requiredRubyVersion: spec.requiredRubyVersion,
    requiredRubygemsVersion: spec.requiredRubygemsVersion,
    runtimeDependencies: [],
    developmentDependencies: [],
  };
  for (const dep of spec.dependencies) {
    const entry: RubyGemDependency = { name: dep.name, version: dep.requirement };
    if (dep.type === ":runtime") {
      metadata.runtimeDependencies.push(entry);
    } else {
      metadata.developmentDependencies.push(entry);
    }
  }

  // The indexed-value newline gate (metadata.go:228-239): the compact index
  // is line-based — a line break in any echoed value would forge entries.
  const values: string[] = [metadata.platform];
  const reqs = [...metadata.requiredRubyVersion, ...metadata.requiredRubygemsVersion];
  for (const dep of [...metadata.runtimeDependencies, ...metadata.developmentDependencies]) {
    values.push(dep.name);
    reqs.push(...dep.version);
  }
  for (const req of reqs) {
    values.push(req.restriction, req.version);
  }
  if (values.some((value) => /[\r\n]/.test(value))) throw new RubyInvalidMetadataError();

  return { name: spec.name, version: spec.version, metadata };
}

/**
 * ParsePackageMetaData (metadata.go:157-174) over the WHOLE gem bytes: the
 * tar walk finds metadata.gz, the inflate caps, the YAML decode validates.
 */
export async function parseRubyGemPackage(bytes: Uint8Array): Promise<RubyGemPackage> {
  const metadataGz = extractGemMetadataGz(bytes);
  const inflated = await gunzipGemMetadata(metadataGz);
  return parseGemMetadata(new TextDecoder().decode(inflated));
}

// ---------------------------------------------------------------------------
// The archive encoders for the wire — enumeratePackages' gzip writer
// (rubygems.go:86-94) and ServePackageSpecification's zlib writer
// (rubygems.go:126-127). Go's gzip writer carries zw.Name ("specs.4.8") in
// the FNAME header field; the platform CompressionStream cannot set it, and
// every consumer (the `gem`/Bundler clients, upstream's own integration test)
// compares the DECOMPRESSED payloads.
// ---------------------------------------------------------------------------

/** The compressed stream bytes via the platform encoder. */
async function compressWith(format: "gzip" | "deflate", data: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(data.slice()).body?.pipeThrough(new CompressionStream(format));
  if (stream === undefined) throw new Error("no compression stream");
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    chunks.push(read.value);
  }
  return concatBytes(...chunks);
}

/** The gzipped Marshal payload (specs.4.8.gz and siblings). */
export function gzipRubyGemArchive(payload: Uint8Array): Promise<Uint8Array> {
  return compressWith("gzip", payload);
}

/** The zlib (RFC 1950) payload — the .gemspec.rz shape (Ruby's zlib). */
export function zlibRubyGemArchive(payload: Uint8Array): Promise<Uint8Array> {
  return compressWith("deflate", payload);
}

// ---------------------------------------------------------------------------
// makeGemFullFileName (rubygems.go:448-456)
// ---------------------------------------------------------------------------

export function makeGemFullFileName(gemName: string, version: string, platform: string): string {
  const basename =
    platform === "" || platform === "ruby" ? `${gemName}-${version}` : `${gemName}-${version}-${platform}`;
  return `${basename.toLowerCase()}.gem`;
}

// ---------------------------------------------------------------------------
// The compact-index text (rubygems.go:368-446) — GetPackageInfo and
// GetAllPackagesVersions' shared render
// ---------------------------------------------------------------------------

/** writePackageVersionRequirements (rubygems.go:378-387): `prefix` + the
 *  `&`-joined `{restriction} {version}` pairs; NONE → the `>= 0` default. */
function writePackageVersionRequirements(prefix: string, reqs: RubyGemVersionRequirement[], out: string[]): void {
  out.push(prefix);
  const list = reqs.length === 0 ? [{ restriction: ">=", version: "0" }] : reqs;
  list.forEach((req, i) => {
    out.push(`${i === 0 ? "" : "&"}${req.restriction} ${req.version}`);
  });
}

/** writePackageVersionForDependency (rubygems.go:389-397): `VERSION` or
 *  `VERSION-PLATFORM` (a "ruby"/empty platform renders bare), trailing
 *  space. */
function writePackageVersionForDependency(version: string, platform: string, out: string[]): void {
  if (platform !== "" && platform !== "ruby") {
    out.push(`${version}-${platform} `);
  } else {
    out.push(`${version} `);
  }
}

/**
 * makePackageVersionDependency (rubygems.go:399-433): the ONE line for a
 * version — `VERSION[-PLATFORM] RUNTIME_DEPS|checksum:SHA256[,ruby:REQS][,
 * rubygems:REQS]`; DEPENDENCY `NAME:CONSTRAINT[&CONSTRAINT]`. The missing
 * file/blob is an ERROR (upstream apiError(500, err) — not the not-exist
 * arm), answered by the route's 500.
 */
export async function makeRubyGemVersionDependency(
  d1: D1Database,
  version: PackageVersionRow,
  pkgName: string,
  metadata: RubyGemMetadata,
): Promise<string> {
  const fullFilename = makeGemFullFileName(pkgName, version.version, metadata.platform);
  const file = await (async () => {
    const rows = await drizzle(d1)
      .select({ file: packageFiles, blob: packageBlobs })
      .from(packageFiles)
      .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
      .where(and(eq(packageFiles.versionId, version.id), eq(packageFiles.lowerName, fullFilename.toLowerCase())))
      .get();
    return rows ?? null;
  })();
  if (file === null) throw new Error("package file does not exist");

  const out: string[] = [];
  writePackageVersionForDependency(version.version, metadata.platform, out);
  metadata.runtimeDependencies.forEach((dep, i) => {
    writePackageVersionRequirements(`${i === 0 ? "" : ","}${dep.name}:`, dep.version, out);
  });
  out.push(`|checksum:${file.blob.hashSha256 ?? ""}`);
  if (metadata.requiredRubyVersion.length !== 0) {
    writePackageVersionRequirements(",ruby:", metadata.requiredRubyVersion, out);
  }
  if (metadata.requiredRubygemsVersion.length !== 0) {
    writePackageVersionRequirements(",rubygems:", metadata.requiredRubygemsVersion, out);
  }
  return out.join("");
}

/**
 * makePackageInfo (rubygems.go:435-446): `---\n` + one line per version.
 * The versions arrive in GetVersionsByPackageName order (created DESC).
 */
export async function makeRubyGemPackageInfo(
  d1: D1Database,
  entries: RubyGemVersionEntry[],
): Promise<string> {
  const lines: string[] = ["---\n"];
  for (const entry of entries) {
    lines.push(
      await makeRubyGemVersionDependency(d1, entry.version, entry.pkg.name, entry.metadata),
      "\n",
    );
  }
  return lines.join("");
}

/** One pkg+version+metadata triple — the enumeration/compact-index unit. */
export interface RubyGemVersionEntry {
  pkg: { id: number; name: string };
  version: PackageVersionRow;
  metadata: RubyGemMetadata;
}

/** The rows as RubyGemVersionEntry with parsed metadata. */
function withMetadata(rows: { version: PackageVersionRow; pkg: { id: number; name: string } }[]): RubyGemVersionEntry[] {
  return rows.map((row) => ({ ...row, metadata: loadRubyGemMetadata(row.version) }));
}

/**
 * GetVersionsByPackageName (package_version.go:140-151) — SearchVersions
 * exact-match, IsInternal false, created DESC.
 */
export async function listRubyGemVersionsByName(
  d1: D1Database,
  ownerId: number,
  name: string,
): Promise<RubyGemVersionEntry[]> {
  const found = await searchVersions(d1, {
    ownerId,
    type: "rubygems",
    name,
    exact: true,
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });
  return withMetadata(found.rows);
}

/** GetVersionsByPackageType (package_version.go:130-137) — every version,
 *  created DESC (the specs.4.8 order). */
export async function listRubyGemVersionsByType(d1: D1Database, ownerId: number): Promise<RubyGemVersionEntry[]> {
  const found = await searchVersions(d1, {
    ownerId,
    type: "rubygems",
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });
  return withMetadata(found.rows);
}

/** SearchLatestVersions (rubygems.go:45-53) — the latest per package. */
export async function listLatestRubyGemVersions(d1: D1Database, ownerId: number): Promise<RubyGemVersionEntry[]> {
  const found = await searchLatestVersions(d1, {
    ownerId,
    type: "rubygems",
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });
  return withMetadata(found.rows);
}

/**
 * GetPackagesByType (package.go:297-309) — the owner's rubygems packages.
 * Upstream's Find carries NO order (xorm default, undefined); ours pins
 * id ASC for deterministic output.
 */
export async function listRubyGemPackagesByType(
  d1: D1Database,
  ownerId: number,
): Promise<{ id: number; name: string }[]> {
  const rows = await drizzle(d1)
    .select({ id: packages.id, name: packages.name })
    .from(packages)
    .where(and(eq(packages.ownerId, ownerId), eq(packages.type, "rubygems"), eq(packages.isInternal, false)))
    .orderBy(asc(packages.id))
    .all();
  return rows;
}

// ---------------------------------------------------------------------------
// The Marshal wire shapes — the specs enumerations and the gemspec render
// ---------------------------------------------------------------------------

/**
 * enumeratePackages' payload (rubygems.go:63-94): the specs list — each
 * version `[name, Gem::Version-marshal([version]), platform]`, Marshal-4.8
 * encoded (the caller gzips it).
 */
export function buildRubyGemSpecsPayload(entries: RubyGemVersionEntry[]): Uint8Array {
  const specs: MarshalValue[] = entries.map((entry) => [
    entry.pkg.name,
    new RubyUserMarshal("Gem::Version", [entry.version.version]),
    entry.metadata.platform,
  ]);
  return new MarshalEncoder().encode(specs);
}

/** The EMPTY specs list (prerelease_specs.4.8 — rubygems.go:59-61). */
export function buildRubyGemEmptySpecsPayload(): Uint8Array {
  return new MarshalEncoder().encode([]);
}

/**
 * ServePackageSpecification's render (rubygems.go:132-158): the
 * Gem::Specification USERDEF — the 19 @-fields in upstream's literal order
 * (the integration test's gemspec.rz byte string is the oracle):
 * @rubygems_version "3.2.3", @specification_version 4, name, Gem::Version,
 * nil date, @summary, nil @required_ruby_version, nil
 * @required_rubygems_version, @original_platform, @dependencies [],
 * rubyforge_project nil, @email "", @authors, @description, @project_url,
 * has_rdoc true, @new_platform, nil, @licenses.
 */
export function buildRubyGemSpecification(
  pkgName: string,
  version: string,
  metadata: RubyGemMetadata,
): Uint8Array {
  const spec = new RubyUserDef("Gem::Specification", [
    "3.2.3", // @rubygems_version
    4, // @specification_version
    pkgName,
    new RubyUserMarshal("Gem::Version", [version]),
    null, // date
    metadata.summary, // @summary
    null, // @required_ruby_version
    null, // @required_rubygems_version
    metadata.platform, // @original_platform
    [], // @dependencies
    null, // rubyforge_project
    "", // @email
    metadata.authors, // @authors
    metadata.description, // @description
    metadata.projectUrl, // @project_url
    true, // has_rdoc
    metadata.platform, // @new_platform
    null,
    metadata.licenses, // @licenses
  ]);
  return new MarshalEncoder().encode(spec);
}

/**
 * GetAllPackagesVersions (rubygems.go:321-366): `---\n` + per package
 * `{name} {versions-joined-by-,} {md5-of-info}` — versions in
 * GetVersionsByPackageName order (created DESC), each `VERSION[_PLATFORM]`
 * (writePackageVersionForList: a non-"ruby" platform appends _platform),
 * the md5 over the package's info text (makePackageInfo — the maven family's
 * md5Hex; Workers' WebCrypto carries no MD5).
 */
export async function buildRubyGemCompactIndex(d1: D1Database, ownerId: number): Promise<string> {
  const pkgs = await listRubyGemPackagesByType(d1, ownerId);
  const out: string[] = ["---\n"];
  for (const pkg of pkgs) {
    const versions = await listRubyGemVersionsByName(d1, ownerId, pkg.name);
    if (versions.length === 0) continue;
    const info = await makeRubyGemPackageInfo(d1, versions);
    out.push(pkg.name, " ");
    versions.forEach((entry, i) => {
      const sep = i === versions.length - 1 ? "" : ",";
      const platform = entry.metadata.platform;
      if (platform !== "" && platform !== "ruby") {
        out.push(`${entry.version.version}_${platform}${sep}`);
      } else {
        out.push(`${entry.version.version}${sep}`);
      }
    });
    out.push(` ${md5Hex(new TextEncoder().encode(info))}\n`);
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// getVersionsByFilename (rubygems.go:458-466) + the download walk
// ---------------------------------------------------------------------------

/**
 * The file-name search (SearchVersions{HasFileWithName} — the joined pair
 * filtered to versions owning the exact file; IsInternal false both sides).
 */
export async function findRubyGemVersionsByFilename(
  d1: D1Database,
  ownerId: number,
  filename: string,
): Promise<{ version: PackageVersionRow; pkg: { id: number; name: string }; metadata: RubyGemMetadata }[]> {
  const rows = await drizzle(d1)
    .select({ version: packageVersions, pkg: { id: packages.id, name: packages.name } })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .innerJoin(packageFiles, eq(packageFiles.versionId, packageVersions.id))
    .where(
      and(
        eq(packages.ownerId, ownerId),
        eq(packages.type, "rubygems"),
        eq(packages.isInternal, false),
        eq(packageVersions.isInternal, false),
        eq(packageFiles.lowerName, filename.toLowerCase()),
      ),
    )
    .all();
  return withMetadata(rows);
}

export interface RubyGemDownload {
  file: PackageFileRow;
  version: PackageVersionRow;
  stream: ReadableStream;
  size: number;
  filename: string;
  created: Date;
}

/**
 * DownloadPackageFile's walk (rubygems.go:166-198): the file-name search →
 * `len(pvs) != 1` is the EMPTY-404 sentinel; the single version's matching
 * file opens from the content store; the lead GET bumps the counter
 * (helper.ServePackageFile → ServeContent, packages.go:664-668). The
 * vanished content object is the honest 404 (the sole-sweeper posture).
 */
export async function openRubyGemForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  ownerId: number,
  filename: string,
  method: "GET" | "HEAD",
): Promise<RubyGemDownload> {
  const matches = await findRubyGemVersionsByFilename(d1, ownerId, filename);
  if (matches.length !== 1) {
    throw new RubyPackageNotExistError();
  }
  const match = matches[0];
  if (match === undefined) throw new RubyPackageNotExistError();
  const descriptors = await getFileDescriptors(d1, match.version.id);
  const descriptor = descriptors.find((entry) => entry.file.name === filename);
  if (descriptor === undefined) throw new Error("package file does not exist");
  const object = await bucket.get(packageBlobContentKey(descriptor.blob.hashSha256));
  if (object === null) throw new RubyPackageNotExistError();
  if (descriptor.file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, match.version.id);
  }
  return {
    file: descriptor.file,
    version: match.version,
    stream: object.body,
    size: object.size,
    filename: descriptor.file.name,
    created: descriptor.file.createdUnix,
  };
}

// ---------------------------------------------------------------------------
// Upload — UploadPackageFile (rubygems.go:201-269) over
// CreatePackageAndAddFile (SemverCompatible: true)
// ---------------------------------------------------------------------------

export interface UploadRubyGemInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  /** The request body stream (spooled, never buffered). */
  content: ReadableStream<Uint8Array>;
  /** The declared Content-Length; `undefined` = a chunked body (D-2). */
  declaredLength: number | undefined;
  quota: PackagesQuotaConfig;
  now?: Date;
  /** Test seams. */
  maxBytes?: number;
  spoolKey?: string;
}

export interface UploadRubyGemResult {
  version: PackageVersionRow;
  file: PackageFileRow;
  blob: PackageBlobRow;
  parsed: RubyGemPackage;
}

/**
 * The upload's service walk (the goproxy/helm parse-family idiom): quota
 * pre-checks → pass-1 spool-and-hash → the bytes → ParsePackageMetaData →
 * get-or-insert package (type "rubygems", SemverCompatible true) → version
 * (duplicate → the 409 sentinel) → the created-only MetadataJSON write →
 * blob → pass-2 copy → the ONE lead file {name}-{version}[-{platform}].gem
 * (a duplicate file row is upstream's DEFAULT arm → the route's 500). The
 * spool never orphans on a failure inside the walk.
 */
export async function uploadRubyGem(input: UploadRubyGemInput): Promise<UploadRubyGemResult> {
  const now = input.now ?? new Date();
  // CheckCountQuotaExceeded rides the versionCreated branch
  // (createPackageAndVersion) — the +1 post-insert parity.
  if (!input.doer.isAdmin && input.quota.limitTotalOwnerCount > UNLIMITED_QUOTA) {
    const total = (await countVersions(input.d1, input.owner.id)) + 1;
    if (total > input.quota.limitTotalOwnerCount) {
      throw new QuotaTotalCountError();
    }
  }
  if (input.declaredLength !== undefined) {
    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "rubygems", input.declaredLength, input.quota);
  }

  const spooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: input.maxBytes ?? Math.min(MAX_RUBYGEMS_UPLOAD_BYTES, 512 * 1024 * 1024),
    spoolKey: input.spoolKey,
  });

  try {
    if (input.declaredLength === undefined) {
      await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "rubygems", spooled.size, input.quota);
    }
    const spoolObject = await input.bucket.get(spooled.spoolKey);
    if (spoolObject === null) {
      throw new Error("rubygems upload spool object vanished");
    }
    const bytes = new Uint8Array(await spoolObject.arrayBuffer());
    const parsed = await parseRubyGemPackage(bytes);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "rubygems",
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
      // ErrDuplicatePackageVersion → 409 (rubygems.go:258-259) — ALWAYS for
      // rubygems (allowDuplicate defaults false).
      throw new RubyDuplicateVersionError(version);
    }
    // The Metadata JSON lands ONLY on a freshly created version (upstream
    // marshals it at INSERT inside createPackageAndVersion — the
    // protocol-common note).
    await writeVersionMetadata(input.d1, version.id, buildRubyGemMetadataJson(parsed.metadata));

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

    const filename = makeGemFullFileName(parsed.name, parsed.version, parsed.metadata.platform);
    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: filename,
      isLead: true,
      now,
    });
    if (fileResult.outcome !== "created") {
      // A duplicate file row is unreachable through this walk (the version
      // duplicate 409s first) — the DEFAULT-arm posture stands.
      throw new Error("package file already exists");
    }
    return { version, file: fileResult.row, blob, parsed };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Delete — DeletePackage (rubygems.go:272-298) over
// RemovePackageVersionByNameAndVersion (packages.go:505-512)
// ---------------------------------------------------------------------------

/**
 * RemovePackageVersionByNameAndVersion: the name+version resolve
 * (ErrPackageNotExist → the 404 sentinel) → DeletePackageVersionAndReferences
 * (files + properties + the version row; blobs defer to the sweep — the
 * PACKAGE-DEFER-STORAGE-DELETE hint). Rubygems registers no
 * OnBeforeRemovePackageVersion hook.
 */
export async function removeRubyGemVersion(
  d1: D1Database,
  ownerId: number,
  name: string,
  version: string,
): Promise<PackageVersionRow | null> {
  const pv = await getVersionByNameAndVersion(d1, ownerId, "rubygems", name, version);
  if (pv === null) return null;
  await deletePackageVersionAndReferences(d1, pv.id);
  return pv;
}

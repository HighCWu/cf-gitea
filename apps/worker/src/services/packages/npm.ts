/**
 * The npm registry protocol service (SPEC-0016 §7 M4) — the service half of
 * `/api/packages/{username}/npm/...` (upstream routers/api/packages/npm over
 * modules/packages/npm/creator.go, the family SPEC-0016 §2.1 sizes at 1,236
 * upstream lines: npm.go 551 + creator 486 + api.go 160 + metadata 39):
 *
 * - Publish (PUT /{id}): upstream ParseUpload (creator.go:265-394) — the
 *   couchdb-ish document with a `versions` map and base64 `_attachments`.
 *   Exactly ONE version entry is honored (npm publish's shape); the name
 *   matcher (creator.go:41-46,214), the hashicorp/go-version NewSemver
 *   validation (creator.go:289), the attachment lookup
 *   (`{name}-{version}.tgz` with the single-attachment fallback for
 *   `npm publish --provenance` sigstore bundles, creator.go:351-356), the
 *   strict base64 decode, the `sha1-`/`sha512-` integrity check
 *   (creator.go:367-386), and the tarball scan (creator.go:388) port
 *   arm-for-arm. A document WITHOUT `_attachments` is `npm deprecate`
 *   (creator.go:462-486: only versions whose JSON object explicitly carries
 *   a `deprecated` key are emitted).
 * - The packument (GET /{id}, npm.go:81-133 + api.go:20-125): every
 *   non-internal version sorted by the go-version Compare (the descriptor's
 *   SemVer.LessThan, api.go:21-23), keyed by the NORMALIZED semver string
 *   (api.go:31-32 — "v1.2" publishes as "1.2.0"), dist-tags from the
 *   `npm.tag` version properties with the highest-non-prerelease `latest`
 *   fallback (api.go:51-60 — yarn/pnpm break without it), `time` with the
 *   derived created/modified (api.go:47-49), served DETERMINISTICALLY with a
 *   weak ETag (npm.go:87-95 — gitea's MarshalDeterministic + the sha256
 *   W/etag, honored as If-None-Match → 304 like Go's http.ServeContent).
 * - The version object's dist block (api.go:119-123): shasum = the blob's
 *   sha1 hex, integrity = "sha512-" + base64(sha512 bytes), tarball = the
 *   stored `gitea_tarball_path` (fixed at publish — lockfiles pin it,
 *   creator.go:349) or the 1.27 fallback shape (api.go:88).
 * - dist-tags CRUD (npm.go:377-509): properties named `npm.tag`
 *   (metadata.go:7); a tag that parses as a version is invalid
 *   (npm.go:464-471); the body of PUT dist-tags/{tag} is a quoted version
 *   string bounded at 4 KiB (npm.go:408-419).
 * - `npm deprecate` (npm.go:289-335): per-version metadata patch, missing
 *   versions skipped, equal messages no-ops; `npm unpublish` =
 *   DELETE /{id}/-/{filename}/-rev/{rev} → RemovePackageVersion (npm.go:338-350)
 *   and DELETE /{id}/-rev/{rev} → the whole package (npm.go:353-375); the
 *   PUT -rev DeletePreview is upstream's deliberate 200 no-op (npm.go:282-284).
 * - The tarball scan (creator.go:398-438): gzip + tar walk for
 *   npm-shrinkwrap.json / *.gyp / package.json scripts at exactly one slash
 *   depth, 32 MiB decompressed cap, 1 MiB package.json cap; read failures
 *   yield zero values (publish never blocks on scan errors).
 * - The repository link (npm.go:198-216 + repo.go:788-797 +
 *   modules/git/url/url.go:110-159): the publish document's `repository.url`
 *   matching THIS instance resolves to a repo; a doer without repo write
 *   answers 403 "no permission to upload this package"; success links the
 *   package row (SetRepositoryLink via the landed model export).
 *
 * Divergences (documented per AGENTS.md): the publish document is BUFFERED
 * (JSON.parse) under a 64 MiB cap — upstream buffers 256 MiB in Go memory;
 * workerd's isolate ceiling forces the smaller threshold, the ARM (413
 * "http: request body too large", npm.go:180-183) is upstream's own. The
 * RFC3339-millis timestamps (Go renders nanos), the SSH-domain reduction (no
 * setting.SSH.Domain — scp-shape URLs match against the request host), the
 * map-key sort comparator (UTF-8 byte order on the ASCII keys the wire
 * carries), the multiple-`versions`-entries publish (upstream iterates a Go
 * map — unspecified; ours is deterministic first-entry), and the GNU
 * base-256 / typeflag-L tar limitations (truncated member names; the helm.ts
 * scanner twin) ride the same reasoning. MD5 stays NULL (the landed blob-row
 * note).
 */

import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import { packageFiles, packageProperties, packageVersions, packages, repositories } from "../../db/schema";
import { doerRepoAccessMode } from "../../api/services/repository";
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
  getFileDescriptors,
  getOrInsertPackage,
  getOrInsertVersion,
  getVersionByNameAndVersion,
  getPackageByName,
  incrementDownloadCounter,
  linkPackageToRepo,
  searchVersions,
  tryInsertFile,
} from "./model";
import { getOrInsertBlob, packageBlobContentKey, spoolAndHash, type SpooledBlob } from "./blobs";
import { getPackageProperties, isValidAbsoluteHttpUrl, writeVersionMetadata } from "./protocol-common";

// ---------------------------------------------------------------------------
// Errors — creator.go's InvalidArgument sentinels answer 400 at the route;
// errInvalidTagName (npm.go:37) and the deprecate empty arm answer 400 too.
// ---------------------------------------------------------------------------

/** ErrInvalidPackage (creator.go:30). */
export class NpmInvalidPackageError extends Error {
  constructor() {
    super("package is invalid");
    this.name = "NpmInvalidPackageError";
  }
}

/** ErrInvalidPackageName (creator.go:32). */
export class NpmInvalidPackageNameError extends Error {
  constructor() {
    super("package name is invalid");
    this.name = "NpmInvalidPackageNameError";
  }
}

/** ErrInvalidPackageVersion (creator.go:34). */
export class NpmInvalidPackageVersionError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "NpmInvalidPackageVersionError";
  }
}

/** ErrInvalidAttachment (creator.go:36). */
export class NpmInvalidAttachmentError extends Error {
  constructor() {
    super("package attachment is invalid");
    this.name = "NpmInvalidAttachmentError";
  }
}

/** ErrInvalidIntegrity (creator.go:38). */
export class NpmInvalidIntegrityError extends Error {
  constructor() {
    super("failed to validate integrity");
    this.name = "NpmInvalidIntegrityError";
  }
}

/** errInvalidTagName (npm.go:37) — note the capital T, upstream's text. */
export class NpmInvalidTagError extends Error {
  constructor() {
    super("The tag name is invalid");
    this.name = "NpmInvalidTagError";
  }
}

/** deprecatePackage's empty arm (npm.go:290-292) → 400. */
export class NpmDeprecateNoVersionsError extends Error {
  constructor() {
    super("npm deprecate request contains no versions");
    this.name = "NpmDeprecateNoVersionsError";
  }
}

/** The MaxBytesReader arm (npm.go:180-183) → 413. */
export class NpmBodyTooLargeError extends Error {
  constructor() {
    super("http: request body too large");
    this.name = "NpmBodyTooLargeError";
  }
}

/** ErrDuplicatePackageVersion at publish (npm.go:249-250) → 409. */
export class NpmDuplicateVersionError extends Error {
  constructor(readonly existing: PackageVersionRow) {
    super("package version already exists");
    this.name = "NpmDuplicateVersionError";
  }
}

/** npm.go:213's 403 — the linked repo's packages write is missing. */
export class NpmLinkPermissionError extends Error {
  constructor() {
    super("no permission to upload this package");
    this.name = "NpmLinkPermissionError";
  }
}

// ---------------------------------------------------------------------------
// hashicorp/go-version v1.9.0 port (version.go) — the descriptor's SemVer and
// npm's validation both ride it. VersionRegexpRaw vs SemverRegexpRaw differ in
// the prerelease separator ("1.0alpha" parses as a VERSION, not as a SEMVER);
// canonical re-renders canonically (v1.02 → 1.2.0), compare() implements the
// segment-padding + prerelease precedence rules verbatim.
// ---------------------------------------------------------------------------

const GO_VERSION_REGEX =
  /^v?([0-9]+(\.[0-9]+)*?)(-([0-9]+[0-9A-Za-z\-~]*(\.[0-9A-Za-z\-~]+)*)|(-?([A-Za-z\-~]+[0-9A-Za-z\-~]*(\.[0-9A-Za-z\-~]+)*)))?(\+([0-9A-Za-z\-~]+(\.[0-9A-Za-z\-~]+)*))?$/;

const GO_SEMVER_REGEX =
  /^v?([0-9]+(\.[0-9]+)*?)(-([0-9]+[0-9A-Za-z\-~]*(\.[0-9A-Za-z\-~]+)*)|(-([A-Za-z\-~]+[0-9A-Za-z\-~]*(\.[0-9A-Za-z\-~]+)*)))?(\+([0-9A-Za-z\-~]+(\.[0-9A-Za-z\-~]+)*))?$/;

export interface GoVersion {
  /** Canonical re-render (go-version String()). */
  readonly canonical: string;
  /** go-version Prerelease(). */
  readonly prerelease: string;
  /** go-version Compare(). */
  compare(other: GoVersion): number;
  lessThan(other: GoVersion): boolean;
}

/** The internal shape carrying the parsed segments (compare's other side). */
interface GoVersionImpl extends GoVersion {
  readonly segments: number[];
}

function parseGoVersionLike(v: string, pattern: RegExp): GoVersionImpl | null {
  const m = pattern.exec(v);
  if (m === null) return null;
  const core = m[1] ?? "";
  const segments: number[] = [];
  for (const part of core.split(".")) {
    if (!/^[0-9]+$/.test(part)) return null;
    const value = Number.parseInt(part, 10);
    // Go ParseInt(_, 10, 64) — a value past int64 is a parse ERROR.
    if (!Number.isSafeInteger(value) || value > 9_007_199_254_740_991) return null;
    segments.push(value);
  }
  for (let i = segments.length; i < 3; i++) segments.push(0);
  // matches[7] (alpha prerelease) wins over matches[4] (numeric prerelease).
  const pre = m[7] ?? m[4] ?? "";
  const metadata = m[10] ?? "";
  const canonical = `${segments.join(".")}${pre !== "" ? `-${pre}` : ""}${metadata !== "" ? `+${metadata}` : ""}`;

  return {
    canonical,
    prerelease: pre,
    segments,
    compare(other: GoVersion): number {
      const otherImpl = other as GoVersionImpl;
      // A quick, efficient equality check (go-version Compare's first arm).
      if (canonical === otherImpl.canonical) return 0;
      const selfSegs = segments;
      const otherSegs = otherImpl.segments;
      // equalSegments (lengths included) → the prerelease arm.
      if (selfSegs.length === otherSegs.length && selfSegs.every((s, i) => s === otherSegs[i])) {
        if (pre === "" && otherImpl.prerelease === "") return 0;
        if (pre === "") return 1;
        if (otherImpl.prerelease === "") return -1;
        return comparePrereleases(pre, otherImpl.prerelease);
      }
      // The jagged segment walk (go-version Compare's remaining arms).
      const lenSelf = selfSegs.length;
      const lenOther = otherSegs.length;
      const highest = lenSelf < lenOther ? lenOther : lenSelf;
      for (let i = 0; i < highest; i++) {
        if (i > lenSelf - 1) {
          // Self had the lower specificity: other's remainder must be zeros.
          if (!otherSegs.slice(i).every((s) => s === 0)) return -1;
          break;
        } else if (i > lenOther - 1) {
          if (!selfSegs.slice(i).every((s) => s === 0)) return 1;
          break;
        }
        const lhs = selfSegs[i] as number;
        const rhs = otherSegs[i] as number;
        if (lhs !== rhs) return lhs < rhs ? -1 : 1;
      }
      return 0;
    },
    lessThan(other: GoVersion): boolean {
      return this.compare(other) < 0;
    },
  };
}

/** go-version comparePrereleases + comparePart (version.go:260-343). */
function comparePrereleases(self: string, other: string): number {
  if (self === other) return 0;
  const selfParts = self.split(".");
  const otherParts = other.split(".");
  const biggest = Math.max(selfParts.length, otherParts.length);
  for (let i = 0; i < biggest; i++) {
    const partSelf = i < selfParts.length ? (selfParts[i] as string) : "";
    const partOther = i < otherParts.length ? (otherParts[i] as string) : "";
    const cmp = comparePrePart(partSelf, partOther);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function comparePrePart(self: string, other: string): number {
  if (self === other) return 0;
  const selfNumeric = /^[0-9]+$/.test(self);
  const otherNumeric = /^[0-9]+$/.test(other);
  // An empty part lets the other side decide (go-version's documented quirk:
  // empty sorts before numeric, after alphanumeric).
  if (self === "") return otherNumeric ? -1 : 1;
  if (other === "") return selfNumeric ? 1 : -1;
  if (selfNumeric && !otherNumeric) return -1;
  if (!selfNumeric && otherNumeric) return 1;
  if (!selfNumeric && !otherNumeric) return self > other ? 1 : -1;
  const selfInt = Number.parseInt(self, 10);
  const otherInt = Number.parseInt(other, 10);
  if (selfInt !== otherInt) return selfInt > otherInt ? 1 : -1;
  return 0;
}

/** `version.NewVersion` (the lenient regexp — PackageVersionMetadata's and
 *  setPackageTag's "does this look like a version" probe, descriptor.go's
 *  SemVer). Null = malformed. */
export function parseGoVersion(v: string): GoVersion | null {
  return parseGoVersionLike(v, GO_VERSION_REGEX);
}

/** `version.NewSemver` (creator.go:289 — publish validation). */
export function parseGoSemver(v: string): GoVersion | null {
  return parseGoVersionLike(v, GO_SEMVER_REGEX);
}

// ---------------------------------------------------------------------------
// The npm module Metadata (modules/packages/npm/metadata.go's json tags) —
// the shape stored in package_versions.metadata_json and rendered back out.
// ---------------------------------------------------------------------------

export interface NpmRepository {
  type: string;
  url: string;
  directory?: string;
}

export interface NpmMetadata {
  scope?: string;
  name?: string;
  description?: string;
  author?: string;
  license?: string;
  project_url?: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
  bundleDependencies?: string[];
  development_dependencies?: Record<string, string>;
  peer_dependencies?: Record<string, string>;
  peer_dependencies_meta?: Record<string, unknown>;
  optional_dependencies?: Record<string, string>;
  bin?: Record<string, string>;
  readme?: string;
  repository?: NpmRepository;
  has_install_script?: boolean;
  has_shrinkwrap?: boolean;
  engines?: Record<string, string>;
  cpu?: string[];
  os?: string[];
  libc?: string[];
  directories?: Record<string, string>;
  funding?: unknown;
  accept_dependencies?: Record<string, string>;
  deprecated?: string;
  /** Gitea-internal, fixed at publish because lockfiles pin it. */
  gitea_tarball_path?: string;
}

/** The npm.tag property name (metadata.go:7). */
export const NPM_TAG_PROPERTY = "npm.tag";

/**
 * The descriptor's metadata unmarshal (descriptor.go:243-249): parse the
 * stored JSON into the npm Metadata shape — unknown keys dropped, nulls land
 * in the zero values, a broken JSON or a type mismatch is a 500
 * (packageMetadata's unmarshal arm). NULL metadata is the zero struct.
 */
export function normalizeNpmMetadata(raw: string | null): NpmMetadata {
  if (raw === null) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error("stored npm metadata is not valid JSON");
  }
  if (doc === null) return {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("stored npm metadata is not an object");
  }
  const source = doc as Record<string, unknown>;
  const out: NpmMetadata = {};
  const str = (key: string): string | undefined => {
    const value = source[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`stored npm metadata field ${key} is not a string`);
    return value;
  };
  const strings = (key: string): string[] | undefined => {
    const value = source[key];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new Error(`stored npm metadata field ${key} is not a string list`);
    }
    return value as string[];
  };
  const record = (key: string): Record<string, string> | undefined => {
    const value = source[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`stored npm metadata field ${key} is not an object`);
    }
    const outRecord: Record<string, string> = {};
    for (const [mapKey, mapValue] of Object.entries(value as Record<string, unknown>)) {
      if (typeof mapValue !== "string") throw new Error(`stored npm metadata field ${key} has a non-string value`);
      outRecord[mapKey] = mapValue;
    }
    return outRecord;
  };
  const set = <K extends keyof NpmMetadata>(key: K, value: NpmMetadata[K] | undefined): void => {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  };

  set("scope", str("scope"));
  set("name", str("name"));
  set("description", str("description"));
  set("author", str("author"));
  set("license", str("license"));
  set("project_url", str("project_url"));
  set("keywords", strings("keywords"));
  set("dependencies", record("dependencies"));
  set("bundleDependencies", strings("bundleDependencies"));
  set("development_dependencies", record("development_dependencies"));
  set("peer_dependencies", record("peer_dependencies"));
  const peerMeta = source["peer_dependencies_meta"];
  if (peerMeta !== undefined && peerMeta !== null) {
    if (typeof peerMeta !== "object" || Array.isArray(peerMeta)) {
      throw new Error("stored npm metadata field peer_dependencies_meta is not an object");
    }
    set("peer_dependencies_meta", peerMeta as Record<string, unknown>);
  }
  set("optional_dependencies", record("optional_dependencies"));
  set("bin", record("bin"));
  set("readme", str("readme"));
  const repository = source["repository"];
  if (repository !== undefined && repository !== null) {
    if (typeof repository !== "object" || Array.isArray(repository)) {
      throw new Error("stored npm metadata field repository is not an object");
    }
    const repoRecord = repository as Record<string, unknown>;
    const repoType = repoRecord["type"];
    const repoUrl = repoRecord["url"];
    const repoDirectory = repoRecord["directory"];
    if (
      (repoType !== undefined && repoType !== null && typeof repoType !== "string") ||
      (repoUrl !== undefined && repoUrl !== null && typeof repoUrl !== "string") ||
      (repoDirectory !== undefined && repoDirectory !== null && typeof repoDirectory !== "string")
    ) {
      throw new Error("stored npm metadata field repository is malformed");
    }
    set("repository", {
      type: repoType ?? "",
      url: repoUrl ?? "",
      ...(repoDirectory !== undefined && repoDirectory !== null && repoDirectory !== "" ? { directory: repoDirectory } : {}),
    });
  }
  const boolFlag = (key: "has_install_script" | "has_shrinkwrap"): void => {
    const value = source[key];
    if (value === undefined || value === null) return;
    if (typeof value !== "boolean") throw new Error(`stored npm metadata field ${key} is not a boolean`);
    if (value) (out as Record<string, unknown>)[key] = true;
  };
  boolFlag("has_install_script");
  boolFlag("has_shrinkwrap");
  set("engines", record("engines"));
  set("cpu", strings("cpu"));
  set("os", strings("os"));
  set("libc", strings("libc"));
  set("directories", record("directories"));
  if (source["funding"] !== undefined && source["funding"] !== null) {
    set("funding", source["funding"]);
  }
  set("accept_dependencies", record("accept_dependencies"));
  set("deprecated", str("deprecated"));
  set("gitea_tarball_path", str("gitea_tarball_path"));
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic JSON — gitea's MarshalDeterministic (jsonv2.Deterministic)
// sorts MAP keys while struct fields keep declaration order. Map-shaped
// objects are wrapped in SortedJsonMap; everything else serializes in its
// construction order.
// ---------------------------------------------------------------------------

export class SortedJsonMap {
  constructor(readonly entries: Record<string, unknown>) {}
}

export function deterministicJsonStringify(value: unknown): string {
  if (value instanceof SortedJsonMap) {
    const keys = Object.keys(value.entries).sort(utf8ByteCompare);
    const parts = keys.map((key) => `${JSON.stringify(key)}:${deterministicJsonStringify(value.entries[key])}`);
    return `{${parts.join(",")}}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => deterministicJsonStringify(entry)).join(",")}]`;
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  const parts = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => `${JSON.stringify(key)}:${deterministicJsonStringify(entry)}`);
  return `{${parts.join(",")}}`;
}

/** UTF-8 byte order (Go's map-key string sort), reduced to code-point order —
 *  every key the npm wire carries is ASCII, where the two coincide. */
function utf8ByteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function digestHex(algorithm: "SHA-1" | "SHA-256" | "SHA-512", data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, data);
  return bytesToHex(new Uint8Array(digest));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Go's URL escapers (net/url PathEscape/QueryEscape) — the dist.tarball shapes
// (api.go:88, creator.go:349) render through them.
// ---------------------------------------------------------------------------

/** Go url.PathEscape (encodePathSegment: only / ; , ? are segment-escaped). */
export function goPathEscape(value: string): string {
  return encodeURIComponent(value)
    .replace(/%24/g, "$")
    .replace(/%26/g, "&")
    .replace(/%2[Bb]/g, "+")
    .replace(/%3[Aa]/g, ":")
    .replace(/%3[Dd]/g, "=")
    .replace(/%40/g, "@");
}

/** Go url.QueryEscape (everything but unreserved; space becomes +). */
export function goQueryEscape(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** util.PathEscapeSegments (util/url.go:12-19) — escape each "/" segment. */
export function goPathEscapeSegments(value: string): string {
  return value.split("/").map(goPathEscape).join("/");
}

// ---------------------------------------------------------------------------
// creator.go — the publish/deprecate document parse
// ---------------------------------------------------------------------------

/** The publish result (creator.go's Package struct). */
export interface NpmPublishPackage {
  name: string;
  version: string;
  distTags: string[];
  metadata: NpmMetadata;
  /** The stored FILE name — lowercased (creator.go:347-348). */
  filename: string;
  /** The decoded tarball bytes. */
  data: Uint8Array;
}

/** The deprecate result (creator.go:450-456). */
export interface NpmDeprecation {
  packageName: string;
  versions: Record<string, string>;
}

export type ParsedNpmUpload =
  | { kind: "publish"; pkg: NpmPublishPackage }
  | { kind: "deprecate"; dep: NpmDeprecation };

/** RegexpNamePart (creator.go:41) + validateName (creator.go:440-448). */
const NPM_NAME_PART = "[a-z0-9-][a-z0-9-._]*";
const NPM_NAME_REGEX = new RegExp(`^(@${NPM_NAME_PART}/)?${NPM_NAME_PART}$`);

export function validateNpmName(name: string): boolean {
  if (name.trim() !== name) return false;
  if (name.length === 0 || name.length > 214) return false;
  return NPM_NAME_REGEX.test(name);
}

interface WireVersionDoc {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  author?: unknown;
  homepage?: unknown;
  license?: unknown;
  repository?: unknown;
  keywords?: unknown;
  dependencies?: unknown;
  bundleDependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
  peerDependenciesMeta?: unknown;
  bin?: unknown;
  optionalDependencies?: unknown;
  readme?: unknown;
  dist?: unknown;
  engines?: unknown;
  cpu?: unknown;
  os?: unknown;
  libc?: unknown;
  directories?: unknown;
  funding?: unknown;
  acceptDependencies?: unknown;
  deprecated?: unknown;
}

interface WireDocument {
  name?: unknown;
  description?: unknown;
  "dist-tags"?: unknown;
  versions?: unknown;
  readme?: unknown;
  homepage?: unknown;
  keywords?: unknown;
  repository?: unknown;
  author?: unknown;
  license?: unknown;
  deprecated?: unknown;
  _attachments?: unknown;
}

/** Type-coercion helpers — a type mismatch fails the WHOLE unmarshal
 *  (creator.go's json.Unmarshal → the 500 arm), null lands in zero values. */
class WireError extends Error {}

function wireString(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new WireError(`${field} is not a string`);
  return value;
}

function wireStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new WireError(`${field} is not a string list`);
  }
  return value as string[];
}

function wireStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new WireError(`${field} is not an object`);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") throw new WireError(`${field} has a non-string value`);
    out[key] = entry;
  }
  return out;
}

/** npm_module.User.UnmarshalJSON (creator.go:176-198): a bare string names
 *  the user; an object carries username/name/email/url — only Name renders
 *  (the metadata stores just the author's name string). */
function wireUserName(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && !Array.isArray(value)) {
    const name = (value as Record<string, unknown>)["name"];
    if (name === undefined || name === null) return "";
    if (typeof name !== "string") throw new WireError(`${field}.name is not a string`);
    return name;
  }
  throw new WireError(`${field} is not a user`);
}

/** License.UnmarshalJSON (creator.go:79-96): string or {"type": string}. */
function wireLicense(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && !Array.isArray(value)) {
    const type = (value as Record<string, unknown>)["type"];
    return typeof type === "string" ? type : "";
  }
  throw new WireError("license is not a string or object");
}

/** Repository.UnmarshalJSON (creator.go:208-225): string → url, or object. */
function wireRepository(value: unknown): NpmRepository | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return { type: "", url: value };
  if (typeof value !== "object" || Array.isArray(value)) throw new WireError("repository is not a string or object");
  const record = value as Record<string, unknown>;
  const directory = wireString(record["directory"], "repository.directory");
  return {
    type: wireString(record["type"], "repository.type"),
    url: wireString(record["url"], "repository.url"),
    ...(directory !== "" ? { directory } : {}),
  };
}

/** Bin.UnmarshalJSON (creator.go:232-248): string → {"": value}, or map. */
function wireBin(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return { "": value };
  return wireStringRecord(value, "bin");
}

interface WireAttachment {
  data: string;
  length?: number;
  content_type?: string;
}

function wireAttachments(value: unknown): Record<string, WireAttachment> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new WireError("_attachments is not an object");
  const out: Record<string, WireAttachment> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new WireError("_attachments entry is not an object");
    }
    const record = entry as Record<string, unknown>;
    const data = record["data"];
    if (typeof data !== "string") throw new WireError("_attachments entry data is not a string");
    const length = record["length"];
    if (length !== undefined && length !== null && typeof length !== "number") {
      throw new WireError("_attachments entry length is not a number");
    }
    const contentType = record["content_type"];
    if (contentType !== undefined && contentType !== null && typeof contentType !== "string") {
      throw new WireError("_attachments entry content_type is not a string");
    }
    out[key] = {
      data,
      ...(length !== undefined && length !== null ? { length } : {}),
      ...(contentType !== undefined && contentType !== null ? { content_type: contentType } : {}),
    };
  }
  return out;
}

/** Strict base64 (Go base64.StdEncoding: padded, alphabet-only). */
function decodeStrictBase64(value: string): Uint8Array | null {
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const body = value.replace(/=+$/, "");
  if (value.length - body.length > 2) return null;
  if (body.length === 0 && value.length > 0) {
    // "=" or "==" alone: Go decodes them to zero bytes.
    try {
      atob(value);
      return new Uint8Array(0);
    } catch {
      return null;
    }
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * ParseUpload (creator.go:265-280): a body with `_attachments` is a publish,
 * without one a deprecate. The doc arrives pre-parsed (JSON.parse failures
 * are the route's 500 arm — upstream's non-InvalidArgument path). Async only
 * because the integrity digests ride WebCrypto (Go sums synchronously).
 */
export async function parseNpmUpload(doc: unknown): Promise<ParsedNpmUpload> {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new WireError("document is not an object");
  }
  const wire = doc as WireDocument;
  const attachments = wireAttachments(wire._attachments);
  if (Object.keys(attachments).length === 0) {
    return { kind: "deprecate", dep: parseUploadDeprecation(wire, doc) };
  }
  return { kind: "publish", pkg: await parseUploadPackage(wire, attachments) };
}

/** parseUploadDeprecation (creator.go:462-486): only versions whose raw JSON
 *  object explicitly carries `deprecated` are emitted; the TYPED value is the
 *  message (a non-string there fails the whole parse). */
function parseUploadDeprecation(wire: WireDocument, rawDoc: unknown): NpmDeprecation {
  const name = wireString(wire.name, "name");
  if (!validateNpmName(name)) throw new NpmInvalidPackageNameError();
  if (rawDoc === null || typeof rawDoc !== "object") throw new WireError("document is not an object");
  const rawVersions = (rawDoc as Record<string, unknown>)["versions"];
  const rawMap = new Set<string>();
  if (rawVersions !== undefined && rawVersions !== null) {
    if (typeof rawVersions !== "object" || Array.isArray(rawVersions)) throw new WireError("versions is not an object");
    for (const [version, entry] of Object.entries(rawVersions as Record<string, unknown>)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      if ("deprecated" in entry) rawMap.add(version);
    }
  }
  const versions: Record<string, string> = {};
  const typedVersions = wire.versions;
  if (typedVersions !== undefined && typedVersions !== null) {
    if (typeof typedVersions !== "object" || Array.isArray(typedVersions)) throw new WireError("versions is not an object");
    for (const [version, meta] of Object.entries(typedVersions as Record<string, unknown>)) {
      if (meta === null || typeof meta !== "object" || Array.isArray(meta)) continue;
      if (!rawMap.has(version)) continue;
      versions[version] = wireString((meta as WireVersionDoc).deprecated, "deprecated");
    }
  }
  return { packageName: name, versions };
}

/** parseUploadPackage (creator.go:283-394) — the FIRST versions entry wins
 *  (npm publish sends exactly one; upstream iterates a Go map). */
async function parseUploadPackage(
  wire: WireDocument,
  attachments: Record<string, WireAttachment>,
): Promise<NpmPublishPackage> {
  const versionsDoc = wire.versions;
  if (versionsDoc === undefined || versionsDoc === null || typeof versionsDoc !== "object" || Array.isArray(versionsDoc)) {
    throw new NpmInvalidPackageError();
  }
  const distTags = wireStringRecord(wire["dist-tags"], "dist-tags") ?? {};
  for (const [, metaUnknown] of Object.entries(versionsDoc as Record<string, unknown>)) {
    if (metaUnknown === null || typeof metaUnknown !== "object" || Array.isArray(metaUnknown)) {
      throw new NpmInvalidPackageError();
    }
    const meta = metaUnknown as WireVersionDoc;
    const name = wireString(meta.name, "versions[].name");
    if (!validateNpmName(name)) throw new NpmInvalidPackageNameError();

    const rawVersion = wireString(meta.version, "versions[].version");
    const semver = parseGoSemver(rawVersion);
    if (semver === null) throw new NpmInvalidPackageVersionError();

    let scope = "";
    let unscopedName = name;
    const slash = name.indexOf("/");
    if (slash !== -1) {
      scope = name.slice(0, slash);
      unscopedName = name.slice(slash + 1);
    }

    let homepage = wireString(meta.homepage, "versions[].homepage");
    if (!isValidAbsoluteHttpUrl(homepage)) homepage = "";

    // A string "bin" means a single executable named after the package
    // (creator.go:307-309).
    let bin = wireBin(meta.bin);
    if (bin !== undefined && bin[""] !== undefined && Object.keys(bin).length === 1) {
      const command = bin[""];
      bin = { [unscopedName]: command };
    }

    const filename = `${unscopedName}-${semver.canonical}.tgz`.toLowerCase();
    // creator.go:349 — the canonical URL clients derive; the file LOOKUP
    // ignores case, the URL keeps the published case.
    const giteaTarballPath = `${goPathEscapeSegments(name)}/-/${goPathEscape(`${unscopedName}-${semver.canonical}.tgz`)}`;

    const attachment = attachments[`${name}-${rawVersion}.tgz`];
    const fallback =
      attachment === undefined && Object.keys(attachments).length === 1 ? Object.values(attachments)[0] : undefined;
    const chosen = attachment ?? fallback;
    if (chosen === undefined || chosen.data.length === 0) throw new NpmInvalidAttachmentError();
    const data = decodeStrictBase64(chosen.data);
    if (data === null) throw new NpmInvalidAttachmentError();

    const distRecord = wireStringRecord(meta.dist, "dist");
    const integrityRaw = distRecord?.["integrity"] ?? "";
    const dash = integrityRaw.indexOf("-");
    if (dash === -1) throw new NpmInvalidIntegrityError();
    const algorithm = integrityRaw.slice(0, dash);
    const declaredHash = decodeStrictBase64(integrityRaw.slice(dash + 1));
    if (declaredHash === null) throw new NpmInvalidIntegrityError();
    // creator.go:375-384 — only sha1/sha512 compute a hash; unknown
    // algorithms leave it empty (an empty declared hash then compares equal).
    let hashBytes: Uint8Array | null = null;
    if (algorithm === "sha1" || algorithm === "sha512") {
      hashBytes = new Uint8Array(await crypto.subtle.digest(algorithm === "sha1" ? "SHA-1" : "SHA-512", data));
    }
    if (hashBytes !== null && !bytesEqual(hashBytes, declaredHash)) throw new NpmInvalidIntegrityError();

    // creator.go:388 — the tarball scan rides the parse (before any DB arm).
    const scan = await inspectNpmTarball(bufferStream(data));

    const metadata: NpmMetadata = {};
    const set = <K extends keyof NpmMetadata>(key: K, value: NpmMetadata[K] | undefined): void => {
      if (value !== undefined) (metadata as Record<string, unknown>)[key] = value;
    };
    if (scope !== "") set("scope", scope);
    set("name", unscopedName);
    const description = wireString(meta.description, "description");
    if (description !== "") set("description", description);
    const author = wireUserName(meta.author, "author");
    if (author !== "") set("author", author);
    const license = wireLicense(meta.license);
    if (license !== "") set("license", license);
    if (homepage !== "") set("project_url", homepage);
    const keywords = wireStringArray(meta.keywords, "keywords");
    if (keywords !== undefined && keywords.length > 0) set("keywords", keywords);
    const dependencies = wireStringRecord(meta.dependencies, "dependencies");
    if (dependencies !== undefined) set("dependencies", dependencies);
    const bundleDependencies = wireStringArray(meta.bundleDependencies, "bundleDependencies");
    if (bundleDependencies !== undefined) set("bundleDependencies", bundleDependencies);
    const devDependencies = wireStringRecord(meta.devDependencies, "devDependencies");
    if (devDependencies !== undefined) set("development_dependencies", devDependencies);
    const peerDependencies = wireStringRecord(meta.peerDependencies, "peerDependencies");
    if (peerDependencies !== undefined) set("peer_dependencies", peerDependencies);
    const peerMeta = meta.peerDependenciesMeta;
    if (peerMeta !== undefined && peerMeta !== null) {
      if (typeof peerMeta !== "object" || Array.isArray(peerMeta)) throw new WireError("peerDependenciesMeta is not an object");
      set("peer_dependencies_meta", peerMeta as Record<string, unknown>);
    }
    const optionalDependencies = wireStringRecord(meta.optionalDependencies, "optionalDependencies");
    if (optionalDependencies !== undefined) set("optional_dependencies", optionalDependencies);
    if (bin !== undefined) set("bin", bin);
    const readme = wireString(meta.readme, "readme");
    if (readme !== "") set("readme", readme);
    const repository = wireRepository(meta.repository);
    if (repository !== undefined) set("repository", repository);
    if (scan.hasInstallScript) set("has_install_script", true);
    if (scan.hasShrinkwrap) set("has_shrinkwrap", true);
    const engines = wireStringRecord(meta.engines, "engines");
    if (engines !== undefined) set("engines", engines);
    const cpu = wireStringArray(meta.cpu, "cpu");
    if (cpu !== undefined) set("cpu", cpu);
    const os = wireStringArray(meta.os, "os");
    if (os !== undefined) set("os", os);
    const libc = wireStringArray(meta.libc, "libc");
    if (libc !== undefined) set("libc", libc);
    const directories = wireStringRecord(meta.directories, "directories");
    if (directories !== undefined) set("directories", directories);
    if (meta.funding !== undefined && meta.funding !== null) set("funding", meta.funding);
    const acceptDependencies = wireStringRecord(meta.acceptDependencies, "acceptDependencies");
    if (acceptDependencies !== undefined) set("accept_dependencies", acceptDependencies);
    const deprecated = wireString(meta.deprecated, "deprecated");
    if (deprecated !== "") set("deprecated", deprecated);
    set("gitea_tarball_path", giteaTarballPath);

    return {
      name,
      version: semver.canonical,
      distTags: Object.keys(distTags),
      metadata,
      filename,
      data,
    };
  }
  throw new NpmInvalidPackageError();
}

/** A one-shot byte buffer as a stream (the scan's input). */
function bufferStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// The tarball scan (creator.go:398-438 inspectTarball) — streaming gunzip +
// a minimal tar walk (the helm.ts ByteReader twin). Read failures yield zero
// values: publish never blocks on scan errors.
// ---------------------------------------------------------------------------

/** creator.go:398 — caps the decompressed bytes the scan reads (gzip bombs). */
export const MAX_NPM_TARBALL_SCAN_BYTES = 32 * 1024 * 1024;

/** creator.go:401 — caps the package.json bytes decoded from the tarball. */
export const MAX_NPM_PACKAGE_JSON_BYTES = 1024 * 1024;

/** A cap-exceeded or malformed stream aborts the scan with partial results. */
class TarScanAbort extends Error {}

class NpmTarReader {
  private buf = new Uint8Array(64 * 1024);
  private start = 0;
  private end = 0;
  private done = false;
  private consumed = 0; // decompressed bytes pulled past the cursor (the cap)

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

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
      this.consumed += read.value.byteLength;
      if (this.consumed > MAX_NPM_TARBALL_SCAN_BYTES) throw new TarScanAbort("scan cap exceeded");
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
      this.consumed += read.value.byteLength;
      if (this.consumed > MAX_NPM_TARBALL_SCAN_BYTES) throw new TarScanAbort("scan cap exceeded");
      remaining -= read.value.byteLength;
    }
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

function tarNullTerminated(bytes: Uint8Array): string {
  const stop = bytes.indexOf(0);
  return new TextDecoder("latin1").decode(stop === -1 ? bytes : bytes.subarray(0, stop));
}

function tarSize(bytes: Uint8Array): number {
  const text = tarNullTerminated(bytes).trim();
  if (text === "") return 0;
  const size = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new TarScanAbort("malformed tar member size");
  return size;
}

/**
 * inspectTarball (creator.go:403-438): trust the tarball over the client's
 * packument. npm pack puts files under one root directory; members at
 * EXACTLY one slash depth (after stripping ONE leading "./") are inspected:
 * a member named "npm-shrinkwrap.json" flags the shrinkwrap, ".gyp" the gyp
 * build, and "package.json" contributes its lifecycle scripts / gypfile flag.
 */
export async function inspectNpmTarball(source: ReadableStream<Uint8Array>): Promise<{
  hasShrinkwrap: boolean;
  hasInstallScript: boolean;
}> {
  let hasShrinkwrap = false;
  let hasGypFile = false;
  let scripts = { preinstall: "", install: "", postinstall: "" };
  let gypfile: unknown;
  try {
    const decompressed = source.pipeThrough(new DecompressionStream("gzip"));
    const reader = new NpmTarReader(decompressed.getReader());
    try {
      for (;;) {
        if (!(await reader.ensure(512))) break; // clean end of archive
        const header = reader.view(512);
        if (header.every((byte) => byte === 0)) break;
        const name = tarNullTerminated(header.subarray(0, 100));
        const prefix = tarNullTerminated(header.subarray(345, 500)); // ustar prefix
        const fullName = prefix !== "" ? `${prefix}/${name}` : name;
        const size = tarSize(header.subarray(124, 136));
        const memberName = fullName.startsWith("./") ? fullName.slice(2) : fullName;
        if ((memberName.match(/\//g) ?? []).length === 1) {
          if (memberName.endsWith("/npm-shrinkwrap.json")) {
            hasShrinkwrap = true;
          } else if (memberName.endsWith(".gyp")) {
            hasGypFile = true;
          } else if (memberName.endsWith("/package.json")) {
            reader.skip(512);
            const jsonLength = Math.min(size, MAX_NPM_PACKAGE_JSON_BYTES);
            if (await reader.ensure(jsonLength)) {
              try {
                const parsed: unknown = JSON.parse(new TextDecoder().decode(reader.view(jsonLength).slice()));
                if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                  const record = parsed as Record<string, unknown>;
                  const scriptsRaw: unknown = record["scripts"];
                  if (scriptsRaw !== null && typeof scriptsRaw === "object" && !Array.isArray(scriptsRaw)) {
                    const scriptRecord = scriptsRaw as Record<string, unknown>;
                    const pick = (key: string): string =>
                      typeof scriptRecord[key] === "string" ? scriptRecord[key] : "";
                    scripts = { preinstall: pick("preinstall"), install: pick("install"), postinstall: pick("postinstall") };
                  }
                  gypfile = record["gypfile"];
                }
              } catch {
                // creator.go:433 — a malformed package.json falls through.
              }
            }
          }
        }
        await reader.drain(512 + Math.ceil(size / 512) * 512);
      }
    } finally {
      reader.release();
    }
  } catch {
    // creator.go:403 — read errors yield zero values (partial flags kept).
  }
  const scriptText = `${scripts.preinstall}${scripts.install}${scripts.postinstall}`.trim();
  return {
    hasShrinkwrap,
    // npm publish adds "install": "node-gyp rebuild" for a root *.gyp file to
    // the manifest, but not to the tarball (creator.go:436-437).
    hasInstallScript: scriptText !== "" || (hasGypFile && gypfile !== false),
  };
}

// ---------------------------------------------------------------------------
// Repository link (npm.go:198-216 + repo.go:788-797 + git/url/url.go:110-159)
// ---------------------------------------------------------------------------

export interface NpmLinkedRepository {
  id: string;
  ownerId: number;
}

/**
 * GetRepositoryByURLRelax (repo.go:788-797) over ParseRepositoryURL
 * (url.go:110-159), reduced to our substrate: http(s) URLs whose origin is
 * the instance (IsCurrentGiteaSiteURL's arm — the request origin) and
 * scp-shape `user@host:owner/repo[.git]` URLs whose host matches (no
 * setting.SSH.Domain exists here) resolve to owner/repo; everything else is
 * "not ours" and the whole arm skips (npm.go:198's err == nil gate).
 */
export async function findNpmRepositoryByLinkUrl(
  d1: D1Database,
  repositoryUrl: string,
  instanceOrigin: string,
): Promise<NpmLinkedRepository | null> {
  let ownerName: string;
  let repoName: string;
  try {
    if (repositoryUrl.includes("://")) {
      const parsed = new URL(repositoryUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      if (parsed.origin !== instanceOrigin) return null;
      const fields = parsed.pathname.replace(/^\//, "").split("/");
      ownerName = fields[0] ?? "";
      repoName = (fields[1] ?? "").replace(/\.git$/, "");
    } else if (repositoryUrl.includes("@") && repositoryUrl.includes(":")) {
      // ParseGitURL's scp short syntax (url.go:58-89) — host between @ and
      // the first ":" outside IPv6 brackets.
      const at = repositoryUrl.indexOf("@");
      let squareBrackets = false;
      let colon = -1;
      for (let i = 0; i < repositoryUrl.length; i++) {
        const char = repositoryUrl[i];
        if (char === "[") squareBrackets = true;
        else if (char === "]") squareBrackets = false;
        else if (char === ":" && !squareBrackets) {
          colon = i;
          break;
        }
      }
      if (colon === -1 || colon <= at) return null;
      const host = repositoryUrl.slice(at + 1, colon);
      let instanceHost = instanceOrigin;
      try {
        instanceHost = new URL(instanceOrigin).host;
      } catch {
        // A bare-host origin compares verbatim.
      }
      if (host !== instanceHost) return null;
      const path = repositoryUrl.slice(colon + 1).replace(/^\//, "");
      const fields = path.split("/");
      ownerName = fields[0] ?? "";
      repoName = (fields[1] ?? "").replace(/\.git$/, "");
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (ownerName === "" || repoName === "") return null;
  const row = await drizzle(d1)
    .select({ id: repositories.id, ownerId: repositories.ownerId })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, ownerName.toLowerCase()), eq(repositories.slug, repoName)))
    .limit(1)
    .all();
  const repo = row[0];
  if (repo === undefined || repo.ownerId === null) return null;
  return { id: repo.id, ownerId: repo.ownerId };
}

/** The npm.go:200-215 permission arm: owner self, else the repo write fold
 *  (the doerRepoAccessMode predicate — the git-HTTP gate's own source). */
export async function canWriteLinkedRepository(
  d1: D1Database,
  repo: NpmLinkedRepository,
  doer: PackageDoer,
): Promise<boolean> {
  if (repo.ownerId === doer.id) return true;
  const mode = await doerRepoAccessMode(d1, { id: repo.id, ownerId: repo.ownerId }, doer.id);
  return mode === "write" || mode === "admin" || mode === "owner";
}

// ---------------------------------------------------------------------------
// Upload — UploadPackage's service walk (npm.go:178-278 over
// createPackageAndAddFile, packages.go:79-102, allowDuplicate = FALSE: the
// duplicate version answers 409 BEFORE any quota or file work)
// ---------------------------------------------------------------------------

/** MaxBytesReader(256 MiB) (npm.go:180) — see the module divergence note. */
export const MAX_NPM_UPLOAD_BYTES = 64 * 1024 * 1024;

export interface UploadNpmPackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  /** The request body stream (spooled whole, then buffered under the cap). */
  content: ReadableStream<Uint8Array>;
  declaredLength: number;
  quota: PackagesQuotaConfig;
  /** The request origin — the repo-link URL match domain. */
  instanceOrigin: string;
  now?: Date;
  /** Test seams. */
  maxBytes?: number;
  spoolKey?: string;
}

export type UploadNpmPackageResult =
  | { kind: "published"; pkg: PackageRow; version: PackageVersionRow; blob: PackageBlobRow; file: PackageFileRow }
  | { kind: "deprecated" };

/**
 * The publish/deprecate walk, in upstream's arm order: PASS 1 spool (413 /
 * length-mismatch), the bounded buffered document parse (the 400
 * InvalidArgument set; malformed JSON → the route's 500), then — for a
 * publish — the repo-link permission (403), the duplicate-version
 * arbitration (409), the COUNT + SIZE quota checks (403 — run BEFORE the
 * inserts, because upstream wraps the walk in ONE transaction whose rollback
 * leaves no rows on a quota denial; the count arm carries the +1 post-insert
 * parity upstream's insert-then-check ordering produces — see below), then
 * the package/version rows, the
 * metadata write, the blob row + content object (the decoded tarball goes
 * straight to its content key — the parse already materialized the bytes, no
 * ranged second pass), the lead file row, the dist-tag properties, and the
 * repository link. A deprecate document routes into deprecateNpmVersions
 * (npm.go:192-196).
 */
export async function uploadNpmPackage(input: UploadNpmPackageInput): Promise<UploadNpmPackageResult> {
  const now = input.now ?? new Date();

  // PASS 1 — spool under the npm MaxBytesReader cap (the route maps the
  // over-cap error to 413 and a lying length to the parse-failure 500).
  const spooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: input.maxBytes ?? MAX_NPM_UPLOAD_BYTES,
    spoolKey: input.spoolKey,
  });

  try {
    // The document: spool → bounded buffer → JSON.parse.
    const doc: unknown = JSON.parse(await readSpoolText(input.bucket, spooled.spoolKey, input.maxBytes ?? MAX_NPM_UPLOAD_BYTES));
    const parsed = await parseNpmUpload(doc);

    // `npm deprecate` reuses the publish endpoint with no `_attachments`
    // (npm.go:192-196).
    if (parsed.kind === "deprecate") {
      await deprecateNpmVersions(input.d1, input.owner, parsed.dep);
      return { kind: "deprecated" };
    }
    const pkgDoc = parsed.pkg;

    // The repo-link permission arm runs BEFORE any DB write (npm.go:198-216).
    let linkedRepo: NpmLinkedRepository | null = null;
    const linkUrl = pkgDoc.metadata.repository?.url ?? "";
    if (linkUrl !== "") {
      const repo = await findNpmRepositoryByLinkUrl(input.d1, linkUrl, input.instanceOrigin);
      if (repo !== null) {
        if (!(await canWriteLinkedRepository(input.d1, repo, input.doer))) {
          throw new NpmLinkPermissionError();
        }
        linkedRepo = repo;
      }
    }

    // The duplicate-version arbitration wins over quota (npm.go:249-250 —
    // createPackageAndVersion throws ErrDuplicatePackageVersion before the
    // addFileToPackageVersion quota checks run).
    const existing = await getVersionByNameAndVersion(input.d1, input.owner.id, "npm", pkgDoc.name, pkgDoc.version);
    if (existing !== null) throw new NpmDuplicateVersionError(existing);

    // The quota checks precede the inserts (one transaction upstream — a 403
    // leaves no rows). SIZE: CheckSizeQuotaExceeded runs at
    // addFileToPackageVersion's start (packages.go:303-306) with the TARBALL's
    // size, not the envelope's. COUNT: upstream checks AFTER the version
    // insert, inside the rolling-back transaction (the versionCreated gate,
    // packages.go:188-191) and throws when totalCount > limit
    // (packages.go:380-381) — the pre-insert equivalent is count + 1 > limit,
    // so an exactly-at-limit owner publishes the version that REACHES the cap
    // but not one past (the nuget.ts twin carries the same parity).
    if (!input.doer.isAdmin && input.quota.limitTotalOwnerCount > UNLIMITED_QUOTA) {
      const total = (await countVersions(input.d1, input.owner.id)) + 1;
      if (total > input.quota.limitTotalOwnerCount) {
        throw new QuotaTotalCountError();
      }
    }
    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "npm", pkgDoc.data.byteLength, input.quota);

    // createPackageAndVersion with allowDuplicate = FALSE: the D1 UNIQUE
    // arbitrates a concurrent re-publish (→ 409, npm.go:249-250).
    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "npm",
      name: pkgDoc.name,
      // SemverCompatible: true (npm.go:234).
      semverCompatible: true,
      now,
    });
    const { row: version, created: versionCreated } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: pkgDoc.version,
      now,
    });
    if (!versionCreated) throw new NpmDuplicateVersionError(version);

    // MetadataJSON lands with the version INSERT (createPackageAndVersion);
    // the landed seam patches it right after — the versionCreated gate holds.
    await writeVersionMetadata(input.d1, version.id, JSON.stringify(sortMetadataMaps(pkgDoc.metadata)));

    // The blob row dedups on the TARBALL's digests (the spool's digests
    // cover the JSON envelope, not the attachment).
    const [tarballSha1, tarballSha256, tarballSha512] = await Promise.all([
      digestHex("SHA-1", pkgDoc.data),
      digestHex("SHA-256", pkgDoc.data),
      digestHex("SHA-512", pkgDoc.data),
    ]);
    const { row: blob } = await getOrInsertBlob(input.d1, {
      size: pkgDoc.data.byteLength,
      sha256: tarballSha256,
      sha1: tarballSha1,
      sha512: tarballSha512,
      now,
    });
    // The content object: the bytes are already materialized — one put at
    // the content-addressed key (skip when a dedup hit's object survives).
    const objectPresent = (await input.bucket.head(packageBlobContentKey(tarballSha256))) !== null;
    if (!objectPresent) {
      await input.bucket.put(packageBlobContentKey(tarballSha256), pkgDoc.data);
    }

    const fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: pkgDoc.filename,
      isLead: true, // IsLead: true (npm.go:244)
      now,
    });
    if (fileResult.outcome === "conflict") {
      // Unreachable through the 409 gate — upstream has no
      // ErrDuplicatePackageFile arm in npm's switch either (→ 500).
      throw new Error("package file conflict despite a fresh version");
    }

    // The dist-tag properties (npm.go:259-268) — every dist-tags KEY of the
    // document points at THIS version; an invalid tag 400s the request after
    // the version landed (upstream's own ordering).
    for (const tag of pkgDoc.distTags) {
      const outcome = await setNpmPackageTag(input.d1, tag, version, false);
      if (outcome === "invalid-tag") throw new NpmInvalidTagError();
    }

    // SetRepositoryLink (npm.go:270-275) — the package-level pointer.
    if (linkedRepo !== null) {
      await linkPackageToRepo(input.d1, pkg.id, linkedRepo.id);
    }

    return { kind: "published", pkg, version, blob, file: fileResult.row };
  } finally {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
  }
}

/** The metadata JSON as stored — maps key-sorted, struct order kept. */
function sortMetadataMaps(metadata: NpmMetadata): Record<string, unknown> {
  const sorted = (value: Record<string, string> | undefined): SortedJsonMap | undefined =>
    value === undefined ? undefined : new SortedJsonMap({ ...value });
  const out: Record<string, unknown> = { ...metadata };
  if (metadata.dependencies !== undefined) out.dependencies = sorted(metadata.dependencies);
  if (metadata.development_dependencies !== undefined) {
    out.development_dependencies = sorted(metadata.development_dependencies);
  }
  if (metadata.peer_dependencies !== undefined) out.peer_dependencies = sorted(metadata.peer_dependencies);
  if (metadata.peer_dependencies_meta !== undefined) {
    out.peer_dependencies_meta = new SortedJsonMap({ ...metadata.peer_dependencies_meta });
  }
  if (metadata.optional_dependencies !== undefined) out.optional_dependencies = sorted(metadata.optional_dependencies);
  if (metadata.bin !== undefined) out.bin = sorted(metadata.bin);
  if (metadata.engines !== undefined) out.engines = sorted(metadata.engines);
  if (metadata.directories !== undefined) out.directories = sorted(metadata.directories);
  if (metadata.accept_dependencies !== undefined) out.accept_dependencies = sorted(metadata.accept_dependencies);
  return out;
}

/** Bounded spool read (the document buffer cap — see the module note). */
async function readSpoolText(bucket: R2Bucket, spoolKey: string, maxBytes: number): Promise<string> {
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
      if (total > maxBytes) throw new NpmBodyTooLargeError();
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
  return new TextDecoder().decode(all);
}

// ---------------------------------------------------------------------------
// Deprecate — deprecatePackage (npm.go:289-335)
// ---------------------------------------------------------------------------

/**
 * The `npm deprecate` arm: per-version metadata patch in ONE D1 batch (the
 * transaction upstream wraps the loop in), missing versions skipped, equal
 * messages no-ops. An empty version set → 400 (NpmDeprecateNoVersionsError).
 */
export async function deprecateNpmVersions(
  d1: D1Database,
  owner: PackageOwnerRow,
  dep: NpmDeprecation,
): Promise<void> {
  if (Object.keys(dep.versions).length === 0) throw new NpmDeprecateNoVersionsError();
  const db = drizzle(d1);
  const statements: BatchItem<"sqlite">[] = [];
  for (const [version, message] of Object.entries(dep.versions)) {
    const pv = await getVersionByNameAndVersion(d1, owner.id, "npm", dep.packageName, version);
    if (pv === null) continue; // ErrPackageNotExist → continue (npm.go:300-303)
    const metadata = normalizeNpmMetadata(pv.metadataJson); // broken JSON → 500
    if (metadata.deprecated === message) continue; // npm.go:313-315
    metadata.deprecated = message;
    statements.push(
      db
        .update(packageVersions)
        .set({ metadataJson: JSON.stringify(sortMetadataMaps(metadata)) })
        .where(eq(packageVersions.id, pv.id)),
    );
  }
  if (statements.length > 0) {
    // ONE batch (the WithTx arm) — a partial failure applies nothing.
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }
}

// ---------------------------------------------------------------------------
// Downloads — packageVersionByFilename + DownloadPackageFileByName
// (npm.go:135-175): EXACTLY ONE version may carry the file name
// (case-insensitively); the version path segment is IGNORED (both GET shapes
// share the handler, which searches by name + filename only).
// ---------------------------------------------------------------------------

export interface NpmDownload {
  file: PackageFileRow;
  blob: PackageBlobRow;
  version: PackageVersionRow;
  stream: ReadableStream;
  size: number;
}

/** packageVersionByFilename (npm.go:135-152). Null = the 404 arm. */
export async function findNpmVersionForFilename(
  d1: D1Database,
  owner: PackageOwnerRow,
  packageName: string,
  filename: string,
): Promise<PackageVersionRow | null> {
  if (filename === "") return null;
  const rows = await drizzle(d1)
    .select({ version: packageVersions })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .innerJoin(packageFiles, eq(packageFiles.versionId, packageVersions.id))
    .where(
      and(
        eq(packages.ownerId, owner.id),
        eq(packages.type, "npm"),
        eq(packages.lowerName, packageName.toLowerCase()),
        eq(packages.isInternal, false),
        eq(packageVersions.isInternal, false),
        eq(packageFiles.lowerName, filename.toLowerCase()),
      ),
    )
    .orderBy(desc(packageVersions.createdUnix), desc(packageVersions.id))
    .all();
  if (rows.length !== 1) return null; // len(pvs) != 1 → 404
  return rows[0]?.version ?? null;
}

/** The download walk: version → file → blob → R2 stream, the lead-file GET
 *  counter bump (packages.go:655-660 — HEAD never counts). Null = 404. */
export async function openNpmFileForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  packageName: string,
  filename: string,
  method: "GET" | "HEAD",
): Promise<NpmDownload | null> {
  const version = await findNpmVersionForFilename(d1, owner, packageName, filename);
  if (version === null) return null;
  const descriptors = await getFileDescriptors(d1, version.id);
  const match = descriptors.find((entry) => entry.file.lowerName === filename.toLowerCase());
  if (match === undefined) return null;
  const object = await bucket.get(packageBlobContentKey(match.blob.hashSha256));
  if (object === null) return null;
  if (match.file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, version.id);
  }
  return { file: match.file, blob: match.blob, version, stream: object.body, size: object.size };
}

// ---------------------------------------------------------------------------
// Unpublish — RemovePackageVersion / DeletePackage (npm.go:337-375). The
// content keys are NEVER deleted here — the unreferenced-blob sweep is the
// sole content-key deleter (ratification 4).
// ---------------------------------------------------------------------------

export async function removeNpmVersion(d1: D1Database, versionId: number): Promise<void> {
  await deletePackageVersionAndReferences(d1, versionId);
}

/** DeletePackage (npm.go:353-375): false = the 404 arm (no versions). */
export async function removeNpmPackage(d1: D1Database, owner: PackageOwnerRow, packageName: string): Promise<boolean> {
  const { rows } = await searchVersions(d1, {
    ownerId: owner.id,
    type: "npm",
    name: packageName,
    exact: true,
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });
  if (rows.length === 0) return false;
  for (const row of rows) {
    await deletePackageVersionAndReferences(d1, row.version.id);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The packument — packageMetadata + createPackageMetadataResponse
// (npm.go:60-95 + api.go:20-79) and the single-version metadata
// (PackageVersionMetadata, npm.go:97-133 + api.go:81-125)
// ---------------------------------------------------------------------------

interface NpmVersionEntry {
  pkg: PackageRow;
  version: PackageVersionRow;
  semver: GoVersion;
  files: { file: PackageFileRow; blob: PackageBlobRow }[];
  tagProperties: { id: number; name: string; value: string }[];
}

/** GetPackageDescriptors' per-version assembly (descriptor.go:170-238). */
async function assembleNpmVersionEntry(d1: D1Database, pkg: PackageRow, version: PackageVersionRow): Promise<NpmVersionEntry> {
  // descriptor.go:224-227 — SemVer parses (npm is semver-compatible); a
  // broken stored version is a 500 (the descriptor's error arm).
  const semver = parseGoVersion(version.version);
  if (semver === null) throw new Error(`stored npm version is malformed: ${version.version}`);
  const files = await getFileDescriptors(d1, version.id);
  const properties = await getPackageProperties(d1, 0 /* PropertyTypeVersion */, version.id);
  return {
    pkg,
    version,
    semver,
    files,
    tagProperties: properties.filter((prop) => prop.name === NPM_TAG_PROPERTY),
  };
}

/** api.go:88 — the fallback tarball path pinned by pre-1.27 lockfiles. */
function fallbackTarballPath(entry: NpmVersionEntry): string {
  const first = entry.files[0];
  if (first === undefined) throw new Error("npm version has no files");
  return `${goQueryEscape(entry.pkg.name)}/-/${goPathEscape(entry.version.version)}/${goPathEscape(first.file.lowerName)}`;
}

/** User object wire shape (creator.go:167-173): name required, rest omitempty. */
function userField(name: string | undefined): Record<string, unknown> {
  return { ...(name !== undefined && name !== "" ? { name } : { name: "" }) };
}

/** Repository render (api.go's Repository field, omitzero): all-zero omits. */
function repositoryField(repo: NpmRepository | undefined): Record<string, unknown> | undefined {
  if (repo === undefined) return undefined;
  if (repo.type === "" && repo.url === "" && (repo.directory ?? "") === "") return undefined;
  return {
    type: repo.type,
    url: repo.url,
    ...(repo.directory !== undefined && repo.directory !== "" ? { directory: repo.directory } : {}),
  };
}

/**
 * createPackageMetadataVersion (api.go:81-125) — one version object; struct
 * field order kept, maps wrapped for the deterministic writer.
 */
function renderNpmVersionObject(
  registryUrl: string,
  ownerName: string,
  entry: NpmVersionEntry,
): Record<string, unknown> {
  const first = entry.files[0];
  if (first === undefined) throw new Error("npm version has no files");
  const metadata = normalizeNpmMetadata(entry.version.metadataJson);
  const tarballPath = metadata.gitea_tarball_path ?? fallbackTarballPath(entry);
  // api.go:119-123 — sha512 hex → bytes → base64; sha1 hex verbatim.
  const sha512Bytes = hexToBytes(first.blob.hashSha512 ?? "");
  const record: Record<string, unknown> = {
    _id: `${entry.pkg.name}@${entry.version.version}`,
    name: entry.pkg.name,
    version: entry.version.version,
    description: metadata.description ?? "",
    author: userField(metadata.author),
  };
  if (metadata.project_url !== undefined && metadata.project_url !== "") record.homepage = metadata.project_url;
  if (metadata.license !== undefined && metadata.license !== "") record.license = metadata.license;
  const repository = repositoryField(metadata.repository);
  if (repository !== undefined) record.repository = repository;
  if (metadata.keywords !== undefined && metadata.keywords.length > 0) record.keywords = metadata.keywords;
  if (metadata.dependencies !== undefined) record.dependencies = new SortedJsonMap(metadata.dependencies);
  if (metadata.bundleDependencies !== undefined && metadata.bundleDependencies.length > 0) {
    record.bundleDependencies = metadata.bundleDependencies;
  }
  if (metadata.development_dependencies !== undefined) {
    record.devDependencies = new SortedJsonMap(metadata.development_dependencies);
  }
  if (metadata.peer_dependencies !== undefined) record.peerDependencies = new SortedJsonMap(metadata.peer_dependencies);
  if (metadata.peer_dependencies_meta !== undefined) {
    record.peerDependenciesMeta = new SortedJsonMap(metadata.peer_dependencies_meta);
  }
  if (metadata.bin !== undefined) record.bin = new SortedJsonMap(metadata.bin);
  if (metadata.optional_dependencies !== undefined) {
    record.optionalDependencies = new SortedJsonMap(metadata.optional_dependencies);
  }
  record.dist = {
    integrity: `sha512-${btoaBytes(sha512Bytes)}`,
    shasum: first.blob.hashSha1 ?? "",
    tarball: `${registryUrl}/${tarballPath}`,
  };
  record.maintainers = [userField(ownerName)];
  if (metadata.has_install_script === true) record.hasInstallScript = true;
  if (metadata.has_shrinkwrap === true) record._hasShrinkwrap = true;
  if (metadata.engines !== undefined) record.engines = new SortedJsonMap(metadata.engines);
  if (metadata.cpu !== undefined) record.cpu = metadata.cpu;
  if (metadata.os !== undefined) record.os = metadata.os;
  if (metadata.libc !== undefined) record.libc = metadata.libc;
  if (metadata.directories !== undefined) record.directories = new SortedJsonMap(metadata.directories);
  if (metadata.funding !== undefined) record.funding = metadata.funding;
  if (metadata.accept_dependencies !== undefined) {
    record.acceptDependencies = new SortedJsonMap(metadata.accept_dependencies);
  }
  if (metadata.deprecated !== undefined && metadata.deprecated !== "") record.deprecated = metadata.deprecated;
  return record;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function btoaBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface NpmPackumentBuild {
  /** The serialized packument document + its weak ETag digest. */
  body: string;
  etag: string;
  /** The dist-tags map (npm.go:377-402's fallback source). */
  distTags: Record<string, string>;
  /** Serialized version objects by normalized semver key. */
  versionBodies: Map<string, { body: string; etag: string }>;
}

/**
 * createPackageMetadataResponse (api.go:20-79): versions ascending by
 * SemVer, dist-tags from the tag properties with the highest-non-prerelease
 * latest fallback, time with the derived created/modified, and the
 * top-level fields from the LATEST version's metadata. Null = the 404 arm
 * (no versions at all).
 */
export async function buildNpmPackument(
  d1: D1Database,
  registryUrl: string,
  owner: PackageOwnerRow & { username: string },
  packageName: string,
): Promise<NpmPackumentBuild | null> {
  const { rows } = await searchVersions(d1, {
    ownerId: owner.id,
    type: "npm",
    name: packageName,
    exact: true,
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });
  if (rows.length === 0) return null; // packageMetadata's len(pvs) == 0 arm

  const entries: NpmVersionEntry[] = [];
  for (const row of rows) {
    entries.push(await assembleNpmVersionEntry(d1, row.pkg, row.version));
  }
  // api.go:21-23 — ascending SemVer.LessThan.
  entries.sort((a, b) => a.semver.compare(b.semver));

  const versions = new Map<string, { body: string; etag: string; record: Record<string, unknown> }>();
  const times = new Map<string, string>();
  const distTags: Record<string, string> = {};
  let latestEntry: NpmVersionEntry | undefined;
  let firstPublished = entries[0]?.version.createdUnix;
  let lastPublished = entries[0]?.version.createdUnix;
  for (const entry of entries) {
    const key = entry.semver.canonical;
    const record = renderNpmVersionObject(registryUrl, owner.username, entry);
    const body = deterministicJsonStringify(record);
    versions.set(key, { body, etag: await sha256Hex(body), record });
    times.set(key, entry.version.createdUnix.toISOString());
    if (firstPublished !== undefined && entry.version.createdUnix.getTime() < firstPublished.getTime()) {
      firstPublished = entry.version.createdUnix;
    }
    if (lastPublished !== undefined && entry.version.createdUnix.getTime() > lastPublished.getTime()) {
      lastPublished = entry.version.createdUnix;
    }
    for (const prop of entry.tagProperties) {
      distTags[prop.value] = entry.version.version;
      if (prop.value === "latest") latestEntry = entry;
    }
  }
  times.set("created", (firstPublished ?? new Date(0)).toISOString());
  times.set("modified", (lastPublished ?? new Date(0)).toISOString());

  // api.go:51-60 — yarn and pnpm fail without `latest`, e.g. after its
  // version got deleted: fall back to the highest version, preferring the
  // highest WITHOUT a prerelease.
  if (latestEntry === undefined) {
    let highestNonPrerelease: NpmVersionEntry | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry !== undefined && entry.semver.prerelease === "") {
        highestNonPrerelease = entry;
        break;
      }
    }
    latestEntry = highestNonPrerelease ?? entries[entries.length - 1];
    if (latestEntry === undefined) throw new Error("npm packument has no versions");
    distTags.latest = latestEntry.version.version;
  }

  const latestMetadata = normalizeNpmMetadata(latestEntry.version.metadataJson);

  // PackageMetadata's struct field order (creator.go:59-75).
  const packument: Record<string, unknown> = {
    _id: latestEntry.pkg.name,
    name: latestEntry.pkg.name,
    description: latestMetadata.description ?? "",
    "dist-tags": new SortedJsonMap(distTags),
    versions: new SortedJsonMap(Object.fromEntries([...versions].map(([key, value]) => [key, value.record]))),
  };
  if (latestMetadata.readme !== undefined && latestMetadata.readme !== "") packument.readme = latestMetadata.readme;
  packument.maintainers = [userField(owner.username)];
  packument.time = new SortedJsonMap(Object.fromEntries(times));
  if (latestMetadata.project_url !== undefined && latestMetadata.project_url !== "") {
    packument.homepage = latestMetadata.project_url;
  }
  if (latestMetadata.keywords !== undefined && latestMetadata.keywords.length > 0) {
    packument.keywords = latestMetadata.keywords;
  }
  const repository = repositoryField(latestMetadata.repository);
  if (repository !== undefined) packument.repository = repository;
  packument.author = userField(latestMetadata.author);
  if (latestMetadata.license !== undefined && latestMetadata.license !== "") {
    packument.license = latestMetadata.license;
  }

  const body = deterministicJsonStringify(packument);
  const versionBodies = new Map<string, { body: string; etag: string }>();
  for (const [key, value] of versions) {
    versionBodies.set(key, { body: value.body, etag: value.etag });
  }
  return { body, etag: await sha256Hex(body), distTags, versionBodies };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * PackageVersionMetadata's lookup (npm.go:97-133): a version-shaped param
 * searches versions (exact, case-folded), anything else searches the
 * npm.tag properties; no hit with "latest" serves the packument's fallback
 * version object. Answers the SERIALIZED single-version document.
 */
export async function buildNpmVersionMetadata(
  d1: D1Database,
  registryUrl: string,
  owner: PackageOwnerRow & { username: string },
  packageName: string,
  versionOrTag: string,
): Promise<{ body: string; etag: string } | { fallback: "latest" } | null> {
  const pkg: PackageRow | null = await getPackageByName(d1, owner.id, "npm", packageName);
  if (pkg === null) return null;
  let entry: NpmVersionEntry | undefined;
  if (parseGoVersion(versionOrTag) !== null) {
    const found = await getVersionByNameAndVersion(d1, owner.id, "npm", packageName, versionOrTag);
    if (found !== null) entry = await assembleNpmVersionEntry(d1, pkg, found);
  } else {
    // A tag (setPackageTag rejects version-like names, npm.go:109-111).
    entry = await findNpmVersionByTag(d1, pkg.id, versionOrTag);
  }
  if (entry === undefined) {
    if (versionOrTag === "latest") return { fallback: "latest" }; // npm.go:120-123
    return null; // 404 "version not found: " + versionOrTag
  }
  const record = renderNpmVersionObject(registryUrl, owner.username, entry);
  const body = deterministicJsonStringify(record);
  return { body, etag: await sha256Hex(body) };
}

/** npm.go's tag-property search arm (SearchVersions + Properties). */
async function findNpmVersionByTag(d1: D1Database, packageId: number, tag: string): Promise<NpmVersionEntry | undefined> {
  const rows = await drizzle(d1)
    .select({ version: packageVersions })
    .from(packageVersions)
    .innerJoin(packageProperties, eq(packageProperties.refId, packageVersions.id))
    .where(
      and(
        eq(packageVersions.packageId, packageId),
        eq(packageVersions.isInternal, false),
        eq(packageProperties.refType, 0),
        eq(packageProperties.name, NPM_TAG_PROPERTY),
        eq(packageProperties.value, tag),
      ),
    )
    .orderBy(desc(packageVersions.createdUnix), desc(packageVersions.id))
    .limit(1)
    .all();
  const row = rows[0];
  if (row === undefined) return undefined;
  const pkg = await getPackageById(d1, packageId);
  if (pkg === null) return undefined;
  return assembleNpmVersionEntry(d1, pkg, row.version);
}

async function getPackageById(d1: D1Database, packageId: number): Promise<PackageRow | null> {
  return (await drizzle(d1).select().from(packages).where(eq(packages.id, packageId)).get()) ?? null;
}

// ---------------------------------------------------------------------------
// dist-tags CRUD (npm.go:377-509)
// ---------------------------------------------------------------------------

/**
 * ListPackageTags (npm.go:378-402): every version's npm.tag properties, the
 * OLDEST version winning a duplicated tag (the created-DESC iteration's last
 * write); without a `latest` tag the packument's dist-tags (with its
 * fallback) serve instead; no versions at all → null (the 404 arm).
 */
export async function listNpmDistTags(
  d1: D1Database,
  owner: PackageOwnerRow & { username: string },
  packageName: string,
  registryUrl: string,
): Promise<Record<string, string> | null> {
  const { rows } = await searchVersions(d1, {
    ownerId: owner.id,
    type: "npm",
    name: packageName,
    exact: true,
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });
  const tags: Record<string, string> = {};
  for (const row of rows) {
    const entry = await assembleNpmVersionEntry(d1, row.pkg, row.version);
    for (const prop of entry.tagProperties) {
      tags[prop.value] = row.version.version;
    }
  }
  if (tags.latest !== undefined) return tags;
  const packument = await buildNpmPackument(d1, registryUrl, owner, packageName);
  if (packument === null) return null;
  return packument.distTags;
}

export type SetNpmTagOutcome = "ok" | "invalid-tag";

/**
 * setPackageTag (npm.go:464-509): a tag must be non-empty and NOT parse as a
 * version; the tag moves — the property is removed from any version that
 * currently holds it, then (unless deleteOnly) inserted for the target.
 * The delete+insert ride one D1 batch (the WithTx arm).
 */
export async function setNpmPackageTag(
  d1: D1Database,
  tag: string,
  target: PackageVersionRow,
  deleteOnly: boolean,
): Promise<SetNpmTagOutcome> {
  if (tag === "") return "invalid-tag";
  if (parseGoVersion(tag) !== null) return "invalid-tag";

  // SearchVersions(PackageID, Properties{npm.tag: tag}) — the versions of
  // THIS package currently holding the tag (npm.go:473-483).
  const holders = await drizzle(d1)
    .selectDistinct({ id: packageVersions.id })
    .from(packageVersions)
    .innerJoin(packageProperties, eq(packageProperties.refId, packageVersions.id))
    .where(
      and(
        eq(packageVersions.packageId, target.packageId),
        eq(packageVersions.isInternal, false),
        eq(packageProperties.refType, 0),
        eq(packageProperties.name, NPM_TAG_PROPERTY),
        eq(packageProperties.value, tag),
      ),
    )
    .all();

  const db = drizzle(d1);
  const statements: BatchItem<"sqlite">[] = [];
  if (holders.length === 1) {
    const holderId = holders[0]?.id;
    if (holderId !== undefined) {
      const props = await getPackageProperties(d1, 0, holderId);
      const match = props.find((prop) => prop.name === NPM_TAG_PROPERTY && prop.value === tag);
      if (match !== undefined) {
        statements.push(db.delete(packageProperties).where(eq(packageProperties.id, match.id)));
      }
    }
  }
  if (!deleteOnly) {
    statements.push(
      db.insert(packageProperties).values({ refType: 0, refId: target.id, name: NPM_TAG_PROPERTY, value: tag }),
    );
  }
  if (statements.length > 0) {
    // ONE batch (the WithTx arm) — the move is atomic.
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }
  return "ok";
}

/** The AddPackageTag body bound (npm.go:408-419) — a quoted version string. */
export const MAX_NPM_DIST_TAG_BODY_BYTES = 4 * 1024;

// ---------------------------------------------------------------------------
// Search — PackageSearch + createPackageSearchResponse (npm.go:523-551 +
// api.go:127-160); the absolute skip/take paginator (list.go:89-99)
// ---------------------------------------------------------------------------

/** setting.API defaults (app.ini): DEFAULT_PAGING_NUM / MAX_RESPONSE_ITEMS. */
const SEARCH_DEFAULT_PAGE_SIZE = 30;
const SEARCH_MAX_PAGE_SIZE = 50;

export interface NpmSearchResult {
  objects: Record<string, unknown>[];
  total: number;
}

export async function searchNpmPackages(
  d1: D1Database,
  owner: PackageOwnerRow & { username: string },
  text: string,
  from: number,
  size: number,
  registryUrl: string,
): Promise<NpmSearchResult> {
  // NewAbsoluteListOptions(from, size) — from < 0 → 0; size <= 0 → the
  // default page size; past the max → capped (list.go:89-99).
  const skip = Math.max(from, 0);
  const take = size <= 0 ? SEARCH_DEFAULT_PAGE_SIZE : Math.min(size, SEARCH_MAX_PAGE_SIZE);

  const conditions = [
    eq(packages.ownerId, owner.id),
    eq(packages.type, "npm"),
    eq(packages.isInternal, false),
    eq(packageVersions.isInternal, false),
  ];
  const trimmed = text.trim();
  if (trimmed !== "") {
    conditions.push(like(packages.lowerName, `%${trimmed.toLowerCase()}%`));
  }
  // SearchLatestVersions' MAX(id) GROUP BY package_id subquery (the landed
  // model's shape, rebuilt here for the absolute skip/take paginator).
  const latestIds = drizzle(d1)
    .select({ id: sql<number>`max(${packageVersions.id})` })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(and(...conditions))
    .groupBy(packageVersions.packageId);
  const rows = await drizzle(d1)
    .select({ version: packageVersions, pkg: packages })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(inArray(packageVersions.id, latestIds))
    .orderBy(desc(packageVersions.createdUnix), desc(packageVersions.id))
    .offset(skip)
    .limit(take)
    .all();
  const counted = await drizzle(d1)
    .select({ total: sql<number>`count(*)` })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      inArray(
        packageVersions.id,
        drizzle(d1)
          .select({ id: sql<number>`max(${packageVersions.id})` })
          .from(packageVersions)
          .innerJoin(packages, eq(packages.id, packageVersions.packageId))
          .where(and(...conditions))
          .groupBy(packageVersions.packageId),
      ),
    )
    .all();
  const total = counted[0]?.total ?? 0;

  const objects: Record<string, unknown>[] = [];
  for (const row of rows) {
    const entry = await assembleNpmVersionEntry(d1, row.pkg, row.version);
    const metadata = normalizeNpmMetadata(entry.version.metadataJson);
    const scope = metadata.scope !== undefined && metadata.scope !== "" ? metadata.scope : "unscoped";
    const links: Record<string, unknown> = { npm: registryUrl };
    if (metadata.project_url !== undefined && metadata.project_url !== "") links.homepage = metadata.project_url;
    const pkgObject: Record<string, unknown> = {
      scope,
      name: metadata.name ?? "",
      version: entry.version.version,
      date: entry.version.createdUnix.toISOString(),
      description: metadata.description ?? "",
      author: userField(metadata.author),
      // Publisher: pd.Owner.Name (api.go:145).
      publisher: userField(owner.username),
      maintainers: [], // npm cli needs this field (api.go:146)
    };
    if (metadata.keywords !== undefined && metadata.keywords.length > 0) pkgObject.keywords = metadata.keywords;
    pkgObject.links = links;
    objects.push({ package: pkgObject });
  }
  return { objects, total };
}

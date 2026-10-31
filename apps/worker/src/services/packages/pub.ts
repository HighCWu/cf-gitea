/**
 * The Dart pub registry protocol service (SPEC-0016 §7 long tail) — the
 * service half of `/api/packages/{username}/pub/...` (upstream
 * routers/api/packages/pub/pub.go over CreatePackageAndAddFile /
 * GetPackageDescriptor, packages.go:159; the repository-spec-v2 wire):
 *
 * - ParsePackage (modules/packages/pub/metadata.go:75-113): a tar.gz walk —
 *   `pubspec.yaml` (exact case, ≤ 128 KiB, the pub-dev reader cap
 *   metadata.go:32) feeds ParsePubspecMetadata and `readme.md`
 *   (EqualFold, ≤ 1 MiB, util.ReadWithLimit) rides along; a pubspec-less
 *   archive is ErrMissingPubspecFile (→ 400). ParsePubspecMetadata
 *   (:115-157) decodes the YAML into the pubspecPackage struct, validates
 *   the name pattern `[a-zA-Z_][a-zA-Z0-9_]*`, gates the version through
 *   hashicorp/go-version NewSemver AND STORES v.String() (the normalized
 *   form — "v1.0.0" lands as "1.0.0"), blanks invalid homepage/repository
 *   URLs, and decodes the WHOLE document AGAIN as `any` into
 *   Metadata.Pubspec (the wire's pass-through).
 * - Upload (pub.go:117-190): the multipart body's `file` part is the
 *   archive; the version DUPLICATE is the 409 (CreatePackageAndAddFile —
 *   no add-file-to-existing), quota 403, 201 → 204-with-Location on
 *   success (pub.go:180-189: `Location: {base}/versions/new/finalize/
 *   {name}/{version}`). The stored file name is
 *   ToLower(normalizedVersion + ".tar.gz"), IsLead true.
 * - Enumerate (pub.go:52-99): every version sorted SemVer ASC; the
 *   response `{"name", "latest", "versions"}` where each entry renders
 *   {version, archive_url: `{base}/{name}/files/{version}.tar.gz`,
 *   published, pubspec}; `latest` = the LAST entry. Empty → null (404).
 * - Download (pub.go:192-222): the version segment trims a trailing
 *   ".tar.gz"; the descriptor's first file (lower_name order) serves with
 *   the lead GET counter bump.
 *
 * The YAML reader (parsePubspecYaml) is a BOUNDED SUBSET port (documented
 * per AGENTS.md): block mappings, block sequences, flow sequences,
 * flow mappings on one line, single/double-quoted and plain scalars,
 * `#` comments, int/float/bool/null resolution — the shapes a real
 * pubspec.yaml carries. NOT ported: anchors/aliases, multi-document
 * streams, block scalars (`|`/`>`), tags — upstream's go.yaml.in/yaml/v4
 * decode of those into the pubspecPackage struct would take the same
 * fields from a form pubspecs never use; an unparseable document errors
 * the walk (the route's non-sentinel default → 500), matching upstream's
 * yaml.Unmarshal error.
 */

import { drizzle } from "drizzle-orm/d1";

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
  tryInsertFile,
} from "./model";
import {
  getOrInsertBlob,
  packageBlobContentKey,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import { isValidAbsoluteHttpUrl, writeVersionMetadata } from "./protocol-common";

import { readTarMembers } from "./distro-common";
import { parseSwiftVersionStrict, swiftCompareVersions, swiftVersionString, type SwiftVersion } from "./swift";

// ---------------------------------------------------------------------------
// The metadata module (modules/packages/pub/metadata.go)
// ---------------------------------------------------------------------------

/** metadata.go:30 — the pub-dev reader's cap. */
export const MAX_PUBSPEC_FILE_SIZE = 128 * 1024;

/** metadata.go:33-39 in the struct's json-tag order (Pubspec ALWAYS
 *  renders — no omitempty; the others drop when empty). */
export interface PubMetadata {
  description: string;
  project_url: string;
  repository_url: string;
  documentation_url: string;
  readme: string;
  pubspec: unknown;
}

export interface PubPackage {
  name: string;
  version: string;
  metadata: PubMetadata;
}

export class PubMissingPubspecError extends Error {
  constructor() {
    super("Pubspec file is missing");
    this.name = "PubMissingPubspecError";
  }
}

export class PubPubspecTooLargeError extends Error {
  constructor() {
    super("Pubspec file is too large");
    this.name = "PubPubspecTooLargeError";
  }
}

export class PubInvalidNameError extends Error {
  constructor() {
    super("package name is invalid");
    this.name = "PubInvalidNameError";
  }
}

export class PubInvalidVersionError extends Error {
  constructor() {
    super("package version is invalid");
    this.name = "PubInvalidVersionError";
  }
}

/** A structurally broken archive or an unparseable YAML document — the
 *  plain errors (the route's non-sentinel default → 500). */
export class PubArchiveError extends Error {
  constructor() {
    super("the package archive could not be read");
    this.name = "PubArchiveError";
  }
}

/** metadata.go:28 — `[a-zA-Z_][a-zA-Z0-9_]*`. */
const PUB_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** The pubspecPackage struct's fields (metadata.go:41-48). */
interface PubspecPackage {
  name: string;
  version: string;
  description: string;
  homepage: string;
  repository: string;
  documentation: string;
}

// ---------------------------------------------------------------------------
// The bounded YAML subset reader (see the module header)
// ---------------------------------------------------------------------------

/**
 * A pubspec document → a JSON-shaped value (map → object, sequence →
 * array, scalars resolved: int/float/true/false/null, quoted strings).
 * `null` for an EMPTY document (yaml.Unmarshal's answer).
 */
export function parsePubspecYaml(text: string): unknown {
  const lines: { indent: number; content: string; number: number }[] = [];
  text.split("\n").forEach((raw, index) => {
    const withoutComment = stripComment(raw);
    if (withoutComment.trim() === "") return;
    if (withoutComment.trim() === "---") return; // a document start marker — one doc
    const indent = withoutComment.length - withoutComment.trimStart().length;
    lines.push({ indent, content: withoutComment.trim(), number: index + 1 });
  });
  if (lines.length === 0) return null;
  const parser = new YamlMapReader(lines, 0, lines.length, lines[0]?.indent ?? 0);
  return parser.read();
}

function stripComment(line: string): string {
  // A '#' starts a comment only outside quotes and only after a space or
  // at line start (YAML's rule); pubspec scalars carrying '#' are quoted.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

class YamlMapReader {
  constructor(
    private readonly lines: { indent: number; content: string; number: number }[],
    private readonly start: number,
    private readonly end: number,
    private readonly indent: number,
  ) {}

  read(): unknown {
    const first = this.lines[this.start];
    if (first === undefined) return null;
    if (first.content.startsWith("- ")) return this.readSequence();
    return this.readMapping();
  }

  private readMapping(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let cursor = this.start;
    while (cursor < this.end) {
      const line = this.lines[cursor];
      if (line === undefined || line.indent < this.indent) break;
      if (line.indent > this.indent) {
        cursor += 1; // a stray deeper line — skip (the struct decode ignores)
        continue;
      }
      const colon = findMappingColon(line.content);
      if (colon === -1) {
        cursor += 1;
        continue;
      }
      const key = unquote(line.content.slice(0, colon).trim());
      const rest = line.content.slice(colon + 1).trim();
      if (rest !== "") {
        out[key] = parseFlowScalarOrCollection(rest);
        cursor += 1;
        continue;
      }
      // A nested block: the first deeper line decides (a sequence may sit
      // at the SAME indent as its key — YAML allows it).
      let next = cursor + 1;
      while (next < this.end && (this.lines[next]?.indent ?? -1) > line.indent) next += 1;
      const deeperStart = cursor + 1;
      const deeper = this.lines[deeperStart];
      if (deeper === undefined || deeper.indent <= line.indent) {
        const sameIndentSequence = deeper !== undefined && deeper.indent === line.indent && deeper.content.startsWith("- ");
        out[key] = sameIndentSequence ? this.readSequenceAt(deeperStart, line.indent, next) : null;
        cursor = sameIndentSequence ? next : deeperStart;
        continue;
      }
      out[key] = new YamlMapReader(this.lines, deeperStart, next, deeper.indent).read();
      cursor = next;
    }
    return out;
  }

  private readSequence(): unknown[] {
    const first = this.lines[this.start];
    return this.readSequenceAt(this.start, first?.indent ?? 0, this.end);
  }

  private readSequenceAt(start: number, indent: number, end: number): unknown[] {
    const out: unknown[] = [];
    let cursor = start;
    while (cursor < end) {
      const line = this.lines[cursor];
      if (line === undefined || line.indent !== indent || !line.content.startsWith("- ")) break;
      const item = line.content.slice(2).trim();
      const colon = findMappingColon(item);
      if (colon !== -1 && colon > 0) {
        // An inline map start ("- key: value") — collect the continuation
        // keys at indent+2.
        const map: Record<string, unknown> = {};
        const inlineKey = unquote(item.slice(0, colon).trim());
        const inlineRest = item.slice(colon + 1).trim();
        map[inlineKey] = inlineRest === "" ? null : parseFlowScalarOrCollection(inlineRest);
        cursor += 1;
        while (cursor < end) {
          const cont = this.lines[cursor];
          if (cont === undefined || cont.indent <= indent || cont.content.startsWith("- ")) break;
          const contColon = findMappingColon(cont.content);
          if (contColon === -1) {
            cursor += 1;
            continue;
          }
          const contKey = unquote(cont.content.slice(0, contColon).trim());
          const contRest = cont.content.slice(contColon + 1).trim();
          if (contRest !== "") {
            map[contKey] = parseFlowScalarOrCollection(contRest);
            cursor += 1;
          } else {
            let next = cursor + 1;
            while (next < end && (this.lines[next]?.indent ?? -1) > cont.indent) next += 1;
            const deeper = this.lines[cursor + 1];
            map[contKey] =
              deeper === undefined || deeper.indent <= cont.indent
                ? null
                : new YamlMapReader(this.lines, cursor + 1, next, deeper.indent).read();
            cursor = next;
          }
        }
        out.push(map);
        continue;
      }
      out.push(parseFlowScalarOrCollection(item));
      cursor += 1;
    }
    return out;
  }
}

/** The key/value colon: the first ": " (or a trailing ":") outside quotes. */
function findMappingColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ":" && !inSingle && !inDouble) {
      if (i === text.length - 1) return i;
      if (text[i + 1] === " ") return i;
    }
  }
  return -1;
}

/** A scalar or a flow collection ("[a, b]", "{k: v}"), resolved. */
function parseFlowScalarOrCollection(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlowItems(inner).map((item) => parseFlowScalarOrCollection(item));
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1).trim();
    const out: Record<string, unknown> = {};
    if (inner === "") return out;
    for (const item of splitFlowItems(inner)) {
      const colon = item.indexOf(":");
      if (colon === -1) continue;
      out[unquote(item.slice(0, colon).trim())] = parseFlowScalarOrCollection(item.slice(colon + 1).trim());
    }
    return out;
  }
  return resolveScalar(trimmed);
}

function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "[" || ch === "{") depth += 1;
      else if (ch === "]" || ch === "}") depth -= 1;
      else if (ch === "," && depth === 0) {
        items.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim() !== "") items.push(current.trim());
  return items;
}

function resolveScalar(text: string): unknown {
  if (text === "") return null;
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text === "null" || text === "~" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (/^[-+]?[0-9]+$/.test(text)) {
    const value = Number.parseInt(text, 10);
    if (Number.isSafeInteger(value)) return value;
  }
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(text)) {
    const value = Number.parseFloat(text);
    if (Number.isFinite(value)) return value;
  }
  return text;
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// ParsePackage (metadata.go:75-157)
// ---------------------------------------------------------------------------

/** util.ReadWithLimit's readme cap (metadata.go:96 — 1 MiB). */
const MAX_PUB_README_BYTES = 1024 * 1024;

/**
 * The tar.gz walk (metadata.go:75-113): `pubspec.yaml` (exact case) is
 * REQUIRED, `readme.md` (EqualFold) is optional — BOTH members read (the
 * walk never early-returns; the readme may follow the pubspec).
 */
export async function parsePubPackage(bytes: Uint8Array): Promise<PubPackage> {
  if (bytes.byteLength < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new PubArchiveError();
  }
  let inflated: Uint8Array;
  try {
    const stream = new Response(bytes.slice()).body?.pipeThrough(new DecompressionStream("gzip"));
    if (stream === undefined) throw new Error("no gzip stream");
    inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new PubArchiveError();
  }
  let members: ReturnType<typeof readTarMembers>;
  try {
    members = readTarMembers(inflated);
  } catch {
    throw new PubArchiveError();
  }
  let parsed: PubPackage | null = null;
  let readme = "";
  for (const member of members) {
    if (member.name === "pubspec.yaml") {
      if (member.data.byteLength > MAX_PUBSPEC_FILE_SIZE) {
        throw new PubPubspecTooLargeError();
      }
      parsed = parsePubspecMetadata(new TextDecoder().decode(member.data));
    } else if (member.name.toLowerCase() === "readme.md") {
      readme = new TextDecoder().decode(member.data.subarray(0, MAX_PUB_README_BYTES));
    }
  }
  if (parsed === null) {
    throw new PubMissingPubspecError();
  }
  parsed.metadata.readme = readme;
  return parsed;
}

/**
 * ParsePubspecMetadata (metadata.go:115-157): the struct decode, the name
 * pattern, the go-version NewSemver gate (STORING v.String()), the URL
 * validation (invalid → blanked), and the whole-document re-decode into
 * `pubspec`. An unparseable document is the plain error.
 */
export function parsePubspecMetadata(text: string): PubPackage {
  const document = parsePubspecYaml(text);
  const fields: Partial<PubspecPackage> =
    document !== null && typeof document === "object" && !Array.isArray(document)
      ? (document)
      : {};
  const name = typeof fields.name === "string" ? fields.name : "";
  if (!PUB_NAME_PATTERN.test(name)) {
    throw new PubInvalidNameError();
  }
  // go-yaml decodes an UNQUOTED float-looking version (`version: 1.0`)
  // into a float — the struct's string field takes a DECODE ERROR (the
  // plain-error arm at the route), not the invalid-version 400.
  if (fields.version !== undefined && typeof fields.version !== "string") {
    throw new PubArchiveError();
  }
  const rawVersion = typeof fields.version === "string" ? fields.version : "";
  const parsedVersion = parseSwiftVersionStrict(rawVersion);
  if (parsedVersion === null) {
    throw new PubInvalidVersionError();
  }
  const version = swiftVersionString(parsedVersion);
  const homepage = typeof fields.homepage === "string" && isValidAbsoluteHttpUrl(fields.homepage) ? fields.homepage : "";
  const repository =
    typeof fields.repository === "string" && isValidAbsoluteHttpUrl(fields.repository) ? fields.repository : "";
  return {
    name,
    version,
    metadata: {
      description: typeof fields.description === "string" ? fields.description : "",
      project_url: homepage,
      repository_url: repository,
      documentation_url: typeof fields.documentation === "string" ? fields.documentation : "",
      readme: "",
      pubspec: document,
    },
  };
}

// ---------------------------------------------------------------------------
// The wire shapes (pub.go's jsonResponse structs)
// ---------------------------------------------------------------------------

export interface PubVersionMetadata {
  version: string;
  archive_url: string;
  published: string;
  pubspec?: unknown;
}

/** packageDescriptorToMetadata (pub.go:44-51) — the published timestamp
 *  renders the ISO UTC form (Go's AsLocalTime + RFC3339Nano with the
 *  server offset; ours pins UTC — the documented shape divergence). */
export function pubDescriptorToMetadata(baseURL: string, version: PackageVersionRow, pubspec: unknown): PubVersionMetadata {
  return {
    version: version.version,
    archive_url: `${baseURL}/files/${encodeURIComponent(version.version)}.tar.gz`,
    published: version.createdUnix.toISOString(),
    ...(pubspec === null || pubspec === undefined ? {} : { pubspec }),
  };
}

/** The version list SemVer ASC (pub.go:74-76's LessThan sort) — the stable
 *  id tiebreak. */
export function comparePubVersions(a: PackageVersionRow, b: PackageVersionRow): number {
  const parsedA = parseSwiftVersionStrict(a.version);
  const parsedB = parseSwiftVersionStrict(b.version);
  if (parsedA !== null && parsedB !== null) {
    const cmp = swiftCompareVersions(parsedA, parsedB);
    if (cmp !== 0) return cmp;
  }
  return a.id - b.id;
}

/**
 * EnumeratePackageVersions (pub.go:52-99): every version SemVer ASC with
 * its pubspec loaded; `latest` is the LAST entry. Null = the route's 404.
 */
export async function enumeratePubPackage(
  d1: D1Database,
  owner: PackageOwnerRow,
  id: string,
  baseURL: string,
): Promise<{ name: string; latest: PubVersionMetadata; versions: PubVersionMetadata[] } | null> {
  const list = await listPubVersions(d1, owner.id, id);
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => comparePubVersions(a.version, b.version));
  const pkgName = sorted[0]?.pkgName ?? id;
  const versions = sorted.map((entry) =>
    pubDescriptorToMetadata(`${baseURL}/${encodeURIComponent(pkgName)}`, entry.version, entry.pubspec),
  );
  const latest = versions[versions.length - 1];
  if (latest === undefined) return null;
  return { name: pkgName, latest, versions };
}

interface PubVersionEntry {
  version: PackageVersionRow;
  pkgName: string;
  pubspec: unknown;
}

async function listPubVersions(d1: D1Database, ownerId: number, name: string): Promise<PubVersionEntry[]> {
  const { packages, packageVersions } = await import("../../db/schema");
  const { and, eq } = await import("drizzle-orm");
  const rows = await drizzle(d1)
    .select({ version: packageVersions, pkgName: packages.name })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      and(
        eq(packages.ownerId, ownerId),
        eq(packages.type, "pub"),
        eq(packages.lowerName, name.toLowerCase()),
        eq(packageVersions.isInternal, false),
      ),
    )
    .all();
  return rows.map((row) => {
    let pubspec: unknown = null;
    if (row.version.metadataJson !== null) {
      try {
        const parsed: unknown = JSON.parse(row.version.metadataJson);
        if (parsed !== null && typeof parsed === "object" && "pubspec" in parsed) {
          pubspec = (parsed as Record<string, unknown>).pubspec;
        }
      } catch {
        // a malformed row renders without pubspec
      }
    }
    return { version: row.version, pkgName: row.pkgName, pubspec };
  });
}

// ---------------------------------------------------------------------------
// Upload (pub.go:117-190)
// ---------------------------------------------------------------------------

export interface PubUploadForm {
  /** The `file` part's bytes (the archive). */
  file: Uint8Array;
}

/**
 * The multipart scan for the `file` part (pub.go:120-123's FormFile) — a
 * bounded byte walk over the spooled body: the FIRST part whose
 * Content-Disposition carries a filename AND name="file" wins. A missing
 * part or a malformed body is the 400 arm.
 */
export function scanPubUploadForm(contentType: string, bytes: Uint8Array): PubUploadForm {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? "").trim();
  if (boundary === "") throw new PubArchiveError(); // the FormFile parse failure arm
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const text = bytes;
  for (let cursor = indexOfSequence(text, delimiter, 0); cursor !== -1; cursor = indexOfSequence(text, delimiter, cursor + 1)) {
    let part = cursor + delimiter.byteLength;
    if (text[part] === 0x2d && text[part + 1] === 0x2d) break; // the close delimiter
    while (text[part] === 0x0d && text[part + 1] === 0x0a) part += 2;
    const headerEnd = indexOfSequence(text, new TextEncoder().encode("\r\n\r\n"), part);
    if (headerEnd === -1) break;
    const headers = new TextDecoder().decode(text.subarray(part, headerEnd));
    const dispositionLine = headers.split("\r\n").find((line) => line.toLowerCase().startsWith("content-disposition:")) ?? "";
    if (/name="file"/i.test(dispositionLine) && /filename=/i.test(dispositionLine)) {
      const contentStart = headerEnd + 4;
      const next = indexOfSequence(text, delimiter, contentStart);
      if (next === -1) break;
      let contentEnd = next;
      if (text[contentEnd - 2] === 0x0d && text[contentEnd - 1] === 0x0a) contentEnd -= 2;
      return { file: text.slice(contentStart, contentEnd) };
    }
  }
  throw new PubMissingFileError();
}

export class PubMissingFileError extends Error {
  constructor() {
    super("the file form field is missing");
    this.name = "PubMissingFileError";
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

export interface UploadPubPackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  /** The multipart Content-Type (carries the boundary). */
  contentType: string;
  content: ReadableStream<Uint8Array>;
  declaredLength: number | undefined;
  quota: PackagesQuotaConfig;
  now?: Date;
  maxBytes?: number;
  spoolKey?: string;
}

export interface UploadPubPackageResult {
  pkg: { id: number; name: string };
  version: PackageVersionRow;
  file: PackageFileRow;
  blob: PackageBlobRow;
  parsed: PubPackage;
}

/**
 * The upload's service walk (pub.go:117-190): the multipart scan → the
 * archive parse (the 400 sentinels) → CreatePackageAndAddFile — the
 * version DUPLICATE is ErrDuplicatePackageVersion (→ 409), the quota arms
 * precede, the stored name is ToLower(normalized + ".tar.gz"), IsLead
 * true, and the version metadata carries the PubMetadata JSON.
 */
export async function uploadPubPackage(input: UploadPubPackageInput): Promise<UploadPubPackageResult> {
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
    const form = scanPubUploadForm(input.contentType, body);
    const parsed = await parsePubPackage(form.file);

    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "pub", form.file.byteLength, input.quota);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "pub",
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
    // CreatePackageAndAddFile REJECTS a duplicate version
    // (ErrDuplicatePackageVersion → 409; no add-file-to-existing arm).
    if (!versionCreated) {
      throw new DuplicatePackageVersionError(version);
    }
    await writeVersionMetadata(
      input.d1,
      version.id,
      JSON.stringify({
        ...(parsed.metadata.description !== "" ? { description: parsed.metadata.description } : {}),
        ...(parsed.metadata.project_url !== "" ? { project_url: parsed.metadata.project_url } : {}),
        ...(parsed.metadata.repository_url !== "" ? { repository_url: parsed.metadata.repository_url } : {}),
        ...(parsed.metadata.documentation_url !== "" ? { documentation_url: parsed.metadata.documentation_url } : {}),
        ...(parsed.metadata.readme !== "" ? { readme: parsed.metadata.readme } : {}),
        pubspec: parsed.metadata.pubspec,
      }),
    );

    const { row: blob } = await getOrInsertBlob(input.d1, {
      size: form.file.byteLength,
      sha256: spooled.sha256,
      sha1: spooled.sha1,
      sha512: spooled.sha512,
      now,
    });

    // The stored object is the ARCHIVE part's bytes only (the multipart
    // envelope never stores) — the extracted bytes are already in memory,
    // so the content key takes them directly and the spool dies either way.
    const contentKey = packageBlobContentKey(spooled.sha256);
    if ((await input.bucket.head(contentKey)) !== null) {
      await input.bucket.delete(spooled.spoolKey);
    } else {
      await input.bucket.put(contentKey, form.file.slice());
      await input.bucket.delete(spooled.spoolKey);
    }

    // pub.go:163-166 — Filename: ToLower(version + ".tar.gz"); IsLead true.
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

// ---------------------------------------------------------------------------
// Finalize + download (pub.go:130-154 / 192-222)
// ---------------------------------------------------------------------------

/** FinalizePackage (pub.go:130-154): the version exists → true. */
export async function pubVersionExists(d1: D1Database, owner: PackageOwnerRow, id: string, version: string): Promise<boolean> {
  const found = await getVersionByNameAndVersion(d1, owner.id, "pub", id, version);
  return found !== null;
}

export interface PubDownload {
  file: PackageFileRow;
  blob: PackageBlobRow;
  stream: ReadableStream;
  size: number;
}

/**
 * DownloadPackageFile (pub.go:192-222): the version segment trims a
 * trailing ".tar.gz"; the descriptor's FIRST file (lower_name order)
 * serves; the lead GET bump (packages.go:655-660). Null = the route's 404.
 */
export async function openPubFileForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  id: string,
  versionSegment: string,
  method: "GET" | "HEAD",
): Promise<PubDownload | null> {
  const version = versionSegment.endsWith(".tar.gz") ? versionSegment.slice(0, -".tar.gz".length) : versionSegment;
  const versionRow = await getVersionByNameAndVersion(d1, owner.id, "pub", id, version);
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

/** PackageVersionMetadata (pub.go:101-128): one version's entry — null =
 *  the route's 404. */
export async function getPubVersionMetadata(
  d1: D1Database,
  owner: PackageOwnerRow,
  id: string,
  version: string,
  baseURL: string,
): Promise<PubVersionMetadata | null> {
  const versionRow = await getVersionByNameAndVersion(d1, owner.id, "pub", id, version);
  if (versionRow === null) return null;
  const { pubspec } = (await listPubVersions(d1, owner.id, id)).find((entry) => entry.version.id === versionRow.id) ?? {
    pubspec: null,
  };
  return pubDescriptorToMetadata(`${baseURL}/${encodeURIComponent(id)}`, versionRow, pubspec);
}

/** The go-version port re-export the enumerate tests pin (NewSemver's
 *  normalization — "v1.0.0" stores as "1.0.0"). */
export function parsePubSemver(version: string): SwiftVersion | null {
  return parseSwiftVersionStrict(version);
}

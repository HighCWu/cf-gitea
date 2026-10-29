/**
 * The Maven registry protocol service (SPEC-0016 §7 M5) — the service half of
 * `/api/packages/{username}/maven/*` (upstream routers/api/packages/maven/
 * maven.go, 490 lines, + api.go — the PUT/GET/HEAD path-group family,
 * api.go:336-339 — and modules/packages/maven/metadata.go, the pom.xml
 * metadata extraction):
 *
 * - The path layout (extractPathParameters, maven.go:443-490): the wildcard
 *   splits as `{group path}/{artifactId}/{version}/{filename}` with the
 *   maven-metadata.xml[.md5/.sha1/.sha256/.sha512] special case — an
 *   artifact-level metadata request carries NO version, a `version-SNAPSHOT`
 *   metadata request keeps it. The internal package name is `groupId:
 *   artifactId` (toInternalPackageName, maven.go:432-437); the legacy
 *   `groupId-artifactId` form (maven.go:439-441) is read as a fallback on
 *   every GET and renamed to the colon form on the next non-legacy upload
 *   (maven.go:292-303, UpdatePackageNameByID).
 * - Upload (UploadPackageFile, maven.go:238-414): the artifact write streams
 *   through the store's spool (512 MiB cap, the landed two-pass discipline);
 *   a pom upload parses the metadata and writes the version's MetadataJSON —
 *   upstream writes it on BOTH arms (marshaled into the version INSERT inside
 *   createPackageAndVersion, services/packages/packages.go:170-186, and
 *   updated on an existing version, maven.go:370-388) — so ours writes after
 *   the get-or-insert regardless of `created`. A checksum PUT (.sha1/.md5/
 *   .sha256/.sha512) is VERIFICATION, not storage: the body (capped at
 *   maxChecksumSize = sha512.Size*2+1 = 129 bytes, maven.go:33/266-278) is
 *   compared EXACTLY against the stored hash column (maven.go:331-343 — no
 *   trim, no case fold; mismatch 400 "hash mismatch", match 200) and nothing
 *   lands. IsMeta SNAPSHOT metadata files upload with OverwriteExisting
 *   (maven.go:356 — the helm re-publish idiom); every other duplicate answers
 *   409 (maven.go:403-404 — upstream's TryInsertFile fails the duplicate
 *   REGARDLESS of bytes, pinned by upstream's own integration test: the same
 *   "test" body twice answers 409, tests/integration/api_packages_maven_test.go:53-54).
 * - maven-metadata.xml (serveMavenMetadata, maven.go:82-150 + api.go): the
 *   versions of BOTH package names concatenated (legacy first), sorted
 *   ascending by creation (maven.go:108-111 — "Maven and Gradle order packages
 *   by their creation timestamp"), rendered as api.go's MetadataResponse XML
 *   in Go's xml.Marshal element order with `release` omitted when every
 *   version is a -SNAPSHOT (api.go:14-21); the checksum siblings hash the
 *   exact served bytes (header included, maven.go:126-143).
 * - pom parsing (ParsePackageMetaData, metadata.go:65-111): the
 *   groupId/artifactId/version/packaging-relevant coordinate fields, the
 *   parent-inheritance fallback for groupId, license names, dependency
 *   coordinates; an invalid `url` normalizes to "" and a missing groupId in
 *   both places is util.ErrInvalidArgument ("invalid argument", error.go:24).
 *
 * The XML and the MD5 are hand-built in TS (AGENTS.md: no new deps): the
 * metadata XML escapes with Go encoding/xml's exact set (EscapeText —
 * & < > " ' tab LF CR) and MD5 is a local RFC 1321 implementation — maven is
 * the first protocol with MD5 ON THE WIRE in both directions (the .md5 GET
 * serves the stored hash, the .md5 PUT verifies against it; the landed blob
 * row leaves hash_md5 NULL because WebCrypto has no MD5), so the upload fills
 * a NULL hash_md5 in after the dedup insert (an idempotent same-bytes repair;
 * the schema table comment documents generic's NULL, this module is the first
 * filler — flag the schema comment for the next window's touch-up).
 *
 * Divergences (documented per AGENTS.md): error bodies carry our parse-error
 * texts (Go's carry xml-decoder line numbers — clients never surface them);
 * the pom reader honors utf-8/utf-16/latin1 declared encodings via TextDecoder
 * and falls back to utf-8 (Go's charset.NewReaderLabel handles dozens);
 * unspecified-extension file GETs answer application/octet-stream (Go sniffs
 * the first bytes via http.ServeContent); the globallock per-package upload
 * serialization (maven.go:257-263) is the D1 UNIQUE arbitration + re-select
 * idiom the whole model already uses (SPEC-0016 §4.3: no DO); the version
 * metadata of a non-pom upload stays SQL NULL where upstream stores the JSON
 * string "null" (json.Marshal of a nil pointer — every consumer unmarshals
 * both to no-metadata); `use_legacy_package_name` reads the URL query only
 * (upstream FormBool also reads a form-encoded body, which no maven client
 * sends on an artifact PUT — upstream's own use is query-shaped,
 * api_packages_maven_test.go:84).
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageBlobs, packages } from "../../db/schema";
import {
  type PackageBlobRow,
  type PackageDoer,
  type PackageFileRow,
  type PackageOwnerRow,
  type PackagesQuotaConfig,
  type PackageVersionRow,
  UNLIMITED_QUOTA,
  QuotaTotalCountError,
  checkSizeQuotaExceeded,
  countVersions,
  deletePackageFile,
  getFileForVersionByName,
  getOrInsertPackage,
  getOrInsertVersion,
  getPackageByName,
  getVersionByNameAndVersion,
  incrementDownloadCounter,
  searchVersions,
  tryInsertFile,
  type InsertFileResult,
} from "./model";
import {
  PackageBlobTooLargeError,
  copySpoolToContentKey,
  getBlobById,
  getOrInsertBlob,
  packageBlobContentKey,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import { DuplicatePackageFileError } from "./generic";
import { isValidAbsoluteHttpUrl, writeVersionMetadata } from "./protocol-common";

// ---------------------------------------------------------------------------
// Constants + the extension helpers (maven.go:33-45, 416-422)
// ---------------------------------------------------------------------------

/** maxChecksumSize (maven.go:33) — sha512 hex (128) + the Go sum-colon form. */
export const MAX_CHECKSUM_BYTES = 128 + 1;

const MAVEN_METADATA_FILE = "maven-metadata.xml";
const CHECKSUM_EXTENSIONS = new Set([".md5", ".sha1", ".sha256", ".sha512"]);

/** isChecksumExtension (maven.go:420-422) — the UPLOAD path uses the raw ext
 *  (maven.go:265), the SERVE path lowercases first (maven.go:125/168). */
export function isMavenChecksumExtension(ext: string): boolean {
  return CHECKSUM_EXTENSIONS.has(ext);
}

/** Go path.Ext: the suffix from the final dot of the final element; ".sha1"
 *  answers ".sha1" (the scan-back finds the leading dot), "noext" answers "". */
export function mavenPathExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot);
}

// ---------------------------------------------------------------------------
// Path parameters (maven.go:424-490)
// ---------------------------------------------------------------------------

export interface MavenPathParameters {
  groupId: string;
  artifactId: string;
  /** "" for the artifact-level maven-metadata.xml request. */
  version: string;
  filename: string;
  isMeta: boolean;
}

/** illegalCharacters (maven.go:49). */
const ILLEGAL_CHARACTERS = /[\\/:?"<>|*]/;

/**
 * extractPathParameters (maven.go:443-490) over the route wildcard:
 *   /com/group/id/artifactId/maven-metadata.xml[.md5|.sha1|.sha256|.sha512]
 *   /com/group/id/artifactId/version-SNAPSHOT/maven-metadata.xml[...]
 *   /com/group/id/artifactId/version/any-file
 *   /com/group/id/artifactId/version-SNAPSHOT/any-file
 * Null = errInvalidParameters (400).
 */
export function extractMavenPathParameters(wildcard: string): MavenPathParameters | null {
  const parts = wildcard.split("/");
  const filename = parts[parts.length - 1] ?? "";
  const isMeta =
    filename === MAVEN_METADATA_FILE ||
    filename === `${MAVEN_METADATA_FILE}.md5` ||
    filename === `${MAVEN_METADATA_FILE}.sha1` ||
    filename === `${MAVEN_METADATA_FILE}.sha256` ||
    filename === `${MAVEN_METADATA_FILE}.sha512`;

  let rest = parts.slice(0, -1);
  if (rest.length === 0) return null;

  let version = rest[rest.length - 1] ?? "";
  if (isMeta && !version.endsWith("-SNAPSHOT")) {
    // The artifact-level metadata request: the segment that would be the
    // version IS the artifactId — do not consume it.
    version = "";
  } else {
    rest = rest.slice(0, -1);
  }
  if (ILLEGAL_CHARACTERS.test(version)) return null;
  if (rest.length < 2) return null;

  const artifactId = rest[rest.length - 1] ?? "";
  const groupId = rest.slice(0, -1).join(".");
  if (ILLEGAL_CHARACTERS.test(groupId) || ILLEGAL_CHARACTERS.test(artifactId)) return null;

  return { groupId, artifactId, version, filename, isMeta };
}

/**
 * The route-side wildcard resolver: Hono does not expose the `*` match as a
 * param, so the maven wildcard is sliced off the raw (still percent-encoded)
 * path after the `/{username}/maven/` marker (found anywhere — the sub-app
 * sees the full mount path) and URL-decoded as a PATH (chi hands upstream the
 * decoded wildcard — %2F splits too). "" when the marker is missing, null on
 * a malformed escape.
 */
export function decodeMavenPathWildcard(pathname: string, username: string): string | null {
  const marker = `/${encodeURIComponent(username)}/maven/`;
  const at = pathname.indexOf(marker);
  if (at === -1) return "";
  try {
    return decodeURIComponent(pathname.slice(at + marker.length));
  } catch {
    return null;
  }
}

/** toInternalPackageName (maven.go:432-437) — "GroupID:ArtifactID". */
export function mavenInternalPackageName(params: MavenPathParameters): string {
  return `${params.groupId}:${params.artifactId}`;
}

/** toInternalPackageNameLegacy (maven.go:439-441) — "GroupID-ArtifactID". */
export function mavenLegacyPackageName(params: MavenPathParameters): string {
  return `${params.groupId}-${params.artifactId}`;
}

// ---------------------------------------------------------------------------
// The protocol errors (each maps to its upstream status + plain-text body at
// the route — apiError is ctx.PlainText, maven.go:52-56)
// ---------------------------------------------------------------------------

/** errInvalidParameters (maven.go:48) → 400. */
export class MavenInvalidParametersError extends Error {
  constructor() {
    super("request parameters are invalid");
    this.name = "MavenInvalidParametersError";
  }
}

/** The >129-byte checksum body (maven.go:276-278) → 413. */
export class MavenChecksumTooLargeError extends Error {
  constructor() {
    super("checksum is too large");
    this.name = "MavenChecksumTooLargeError";
  }
}

/** ErrPackageNotExist ("package does not exist", package.go:25) → 404. */
export class MavenPackageNotExistError extends Error {
  constructor() {
    super("package does not exist");
    this.name = "MavenPackageNotExistError";
  }
}

/** ErrPackageFileNotExist ("package file does not exist", package_file.go:27) → 404. */
export class MavenPackageFileNotExistError extends Error {
  constructor() {
    super("package file does not exist");
    this.name = "MavenPackageFileNotExistError";
  }
}

/** The checksum PUT contradicting the stored hash (maven.go:341) → 400. */
export class MavenHashMismatchError extends Error {
  constructor() {
    super("hash mismatch");
    this.name = "MavenHashMismatchError";
  }
}

/** A malformed pom XML (metadata.go:70-72's Decode error) → 400. */
export class MavenPomParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MavenPomParseError";
  }
}

/** The missing-groupId arm (metadata.go:99-101) — util.ErrInvalidArgument → 400. */
export class MavenPomInvalidArgumentError extends Error {
  constructor() {
    super("invalid argument");
    this.name = "MavenPomInvalidArgumentError";
  }
}

// ---------------------------------------------------------------------------
// MD5 — the local RFC 1321 implementation (Workers' WebCrypto has no MD5).
// Incremental over Uint8Array chunks; the standard Math.sin key schedule is
// deterministic, so the table builds at module load.
// ---------------------------------------------------------------------------

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = (() => {
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  return table;
})();

export class Md5 {
  private readonly state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  private totalBytes = 0;

  update(chunk: Uint8Array): this {
    this.totalBytes += chunk.byteLength;
    let offset = 0;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, chunk.byteLength);
      this.block.set(chunk.subarray(0, take), this.blockLen);
      this.blockLen += take;
      offset = take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    while (offset + 64 <= chunk.byteLength) {
      this.compress(chunk, offset);
      offset += 64;
    }
    if (offset < chunk.byteLength) {
      this.block.set(chunk.subarray(offset), 0);
      this.blockLen = chunk.byteLength - offset;
    }
    return this;
  }

  private compress(bytes: Uint8Array, offset: number): void {
    const m = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      m[i] = (bytes[j]! | (bytes[j + 1]! << 8) | (bytes[j + 2]! << 16) | (bytes[j + 3]! << 24)) >>> 0;
    }
    const h = this.state;
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[i]! + m[g]!) >>> 0;
      b = (b + ((sum << MD5_SHIFTS[i]!) | (sum >>> (32 - MD5_SHIFTS[i]!)))) >>> 0;
      a = tmp;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
  }

  hex(): string {
    // Padding: 0x80, zeros, then the 64-bit little-endian bit count.
    const bitLengthLow = (this.totalBytes << 3) >>> 0;
    const bitLengthHigh = Math.floor(this.totalBytes / 536870912) >>> 0; // totalBytes / 2^29
    const padded = new Uint8Array(this.blockLen < 56 ? 64 : 128);
    padded.set(this.block.subarray(0, this.blockLen), 0);
    padded[this.blockLen] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.byteLength - 8, bitLengthLow, true);
    view.setUint32(padded.byteLength - 4, bitLengthHigh, true);
    if (this.blockLen >= 56) {
      this.compress(padded, 0);
      this.compress(padded, 64);
    } else {
      this.compress(padded, 0);
    }
    let out = "";
    for (let i = 0; i < 4; i++) {
      const word = this.state[i]!;
      out += (word & 0xff).toString(16).padStart(2, "0");
      out += ((word >>> 8) & 0xff).toString(16).padStart(2, "0");
      out += ((word >>> 16) & 0xff).toString(16).padStart(2, "0");
      out += ((word >>> 24) & 0xff).toString(16).padStart(2, "0");
    }
    return out;
  }
}

/** One-shot MD5 over the whole input. */
export function md5Hex(bytes: Uint8Array): string {
  return new Md5().update(bytes).hex();
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

// ---------------------------------------------------------------------------
// The pom parser (modules/packages/maven/metadata.go) — a hand-built minimal
// XML reader for the pomStruct field set (no DOMParser in workerd, no deps).
// ---------------------------------------------------------------------------

/** The Metadata struct (metadata.go:17-25) in its json-tag key order — the
 *  version row's MetadataJSON payload (omitempty: keys land only when set). */
export interface MavenDependencyMetadata {
  group_id?: string;
  artifact_id?: string;
  version?: string;
}

export interface MavenPomMetadata {
  group_id?: string;
  artifact_id?: string;
  name?: string;
  description?: string;
  project_url?: string;
  licenses?: string[];
  dependencies?: MavenDependencyMetadata[];
}

interface XmlNode {
  /** The LOCAL element name (namespace prefixes stripped — Go matches the
   *  tag's bare name against any namespace). */
  name: string;
  children: XmlNode[];
  /** The element's DIRECT character data pieces (document order). */
  texts: string[];
}

/** Go xml.EscapeText's set — the same escaping encoding/xml marshal applies
 *  to element chardata (used by the metadata renderer below; kept beside the
 *  parser for symmetry). */
export function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;")
    .replaceAll("'", "&#39;")
    .replaceAll("\t", "&#x9;")
    .replaceAll("\n", "&#xA;")
    .replaceAll("\r", "&#xD;");
}

/** The entity set Go's decoder accepts — predeclared + numeric; anything else
 *  is "invalid character entity" (an error, like upstream's). */
function unescapeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  let out = "";
  for (let i = 0; i < text.length; ) {
    const amp = text.indexOf("&", i);
    if (amp === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, amp); // the plain-text run before the entity
    const semi = text.indexOf(";", amp);
    if (semi === -1) throw new MavenPomParseError("invalid character entity");
    const entity = text.slice(amp + 1, semi);
    if (entity === "lt") out += "<";
    else if (entity === "gt") out += ">";
    else if (entity === "amp") out += "&";
    else if (entity === "quot") out += '"';
    else if (entity === "apos") out += "'";
    else if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        throw new MavenPomParseError("invalid character entity");
      }
      out += String.fromCodePoint(code);
    } else if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        throw new MavenPomParseError("invalid character entity");
      }
      out += String.fromCodePoint(code);
    } else {
      throw new MavenPomParseError("invalid character entity");
    }
    i = semi + 1;
  }
  return out;
}

/** All character data of the element subtree, concatenated raw — Go's string
 *  fields accumulate every chardata byte under the element. */
function deepText(node: XmlNode): string {
  let out = "";
  const walk = (current: XmlNode): void => {
    for (const piece of current.texts) out += piece;
    for (const child of current.children) walk(child);
  };
  walk(node);
  return out;
}

function localElementName(raw: string): string {
  const colon = raw.indexOf(":");
  return colon === -1 ? raw : raw.slice(colon + 1);
}

function parseXmlRootElement(input: string): XmlNode {
  const n = input.length;
  let i = 0;
  // A UTF-8 BOM precedes the prolog.
  if (input.startsWith("\uFEFF")) i = 1;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;

  const pushText = (piece: string): void => {
    const top = stack[stack.length - 1];
    if (top !== undefined && piece !== "") top.texts.push(piece);
  };

  while (i < n) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      pushText(unescapeXmlEntities(input.slice(i)));
      break;
    }
    if (lt > i) pushText(unescapeXmlEntities(input.slice(i, lt)));

    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      if (end === -1) throw new MavenPomParseError("unterminated comment");
      i = end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      if (end === -1) throw new MavenPomParseError("unterminated CDATA section");
      pushText(input.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (input.startsWith("<?", lt)) {
      const end = input.indexOf("?>", lt + 2);
      if (end === -1) throw new MavenPomParseError("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (input.startsWith("<!", lt)) {
      // DOCTYPE (and friends) — skipped; internal-subset entities are NOT
      // resolved (documented divergence from Go's decoder).
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const ch = input[j];
        if (ch === "[") depth++;
        else if (ch === "]") depth = Math.max(depth - 1, 0);
        else if (ch === ">" && depth === 0) break;
      }
      if (j >= n) throw new MavenPomParseError("unterminated markup declaration");
      i = j + 1;
      continue;
    }
    if (input.startsWith("</", lt)) {
      const end = input.indexOf(">", lt);
      if (end === -1) throw new MavenPomParseError("unterminated end tag");
      const name = localElementName(input.slice(lt + 2, end).trim());
      const top = stack.pop();
      if (top === undefined || top.name !== name) {
        throw new MavenPomParseError(`unexpected end element </${name}>`);
      }
      i = end + 1;
      if (stack.length === 0) {
        // Decode reads exactly one top-level element; trailing bytes are
        // ignored (Go's Decoder semantics).
        return top;
      }
      continue;
    }

    // Start element.
    const j = lt + 1;
    let nameEnd = j;
    while (nameEnd < n && !/\s|[/>]/.test(input[nameEnd]!)) nameEnd++;
    const rawName = input.slice(j, nameEnd);
    if (rawName === "") throw new MavenPomParseError("expected element name");
    // Attribute soup — scan quote-aware for the tag end.
    let k = nameEnd;
    let quote: string | null = null;
    for (; k < n; k++) {
      const ch = input[k]!;
      if (quote !== null) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === ">") break;
    }
    if (k >= n) throw new MavenPomParseError("unterminated start tag");
    const selfClosing = input[k - 1] === "/";
    const node: XmlNode = { name: localElementName(rawName), children: [], texts: [] };
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      if (root !== null) throw new MavenPomParseError("multiple top-level elements");
      root = node;
    } else {
      parent.children.push(node);
    }
    if (selfClosing) {
      if (stack.length === 0) return node;
    } else {
      stack.push(node);
    }
    i = k + 1;
  }
  throw new MavenPomParseError("unexpected EOF");
}

/** Direct children with the given local name (document order). */
function directChildren(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function lastDirectChild(node: XmlNode, name: string): XmlNode | undefined {
  const children = directChildren(node, name);
  return children[children.length - 1];
}

/** Go's repeated-scalar rule: the LAST element wins (each decode overwrites). */
function lastChildText(node: XmlNode, name: string): string {
  const child = lastDirectChild(node, name);
  return child === undefined ? "" : deepText(child);
}

/** Honor the XML declaration's encoding through TextDecoder where the label
 *  resolves; anything else decodes utf-8 (documented). */
function decodePomBytes(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 120));
  const declared = /<\?xml\s+[^>]*encoding=["']([^"']+)["']/i.exec(head)?.[1];
  if (declared !== undefined) {
    try {
      return new TextDecoder(declared.toLowerCase()).decode(bytes);
    } catch {
      // An unsupported label falls through to utf-8.
    }
  }
  return new TextDecoder().decode(bytes);
}

/**
 * ParsePackageMetaData (metadata.go:65-111): the pom coordinate fields with
 * the parent-inheritance fallback for groupId (metadata.go:94-101); an
 * invalid `url` normalizes to "" (the protocol-common validator = upstream
 * validation.IsValidURL); license NAMES collect (non-empty only,
 * metadata.go:78-83); dependencies reduce to their coordinates
 * (metadata.go:85-92). Throws MavenPomParseError on malformed XML / a
 * non-`project` root / an unknown entity, MavenPomInvalidArgumentError when
 * neither pom nor parent carries a groupId.
 */
export function parsePomMetadata(bytes: Uint8Array): MavenPomMetadata {
  const root = parseXmlRootElement(decodePomBytes(bytes));
  if (root.name !== "project") {
    throw new MavenPomParseError(`expected element type <project> but have <${root.name}>`);
  }

  let url = lastChildText(root, "url");
  if (!isValidAbsoluteHttpUrl(url)) url = "";

  const licenses: string[] = [];
  for (const licensesElement of directChildren(root, "licenses")) {
    for (const licenseElement of directChildren(licensesElement, "license")) {
      const name = lastChildText(licenseElement, "name");
      if (name !== "") licenses.push(name);
    }
  }

  const dependencies: MavenDependencyMetadata[] = [];
  for (const dependenciesElement of directChildren(root, "dependencies")) {
    for (const dependencyElement of directChildren(dependenciesElement, "dependency")) {
      const dependency: MavenDependencyMetadata = {};
      const groupId = lastChildText(dependencyElement, "groupId");
      const artifactId = lastChildText(dependencyElement, "artifactId");
      const version = lastChildText(dependencyElement, "version");
      if (groupId !== "") dependency.group_id = groupId;
      if (artifactId !== "") dependency.artifact_id = artifactId;
      if (version !== "") dependency.version = version;
      dependencies.push(dependency);
    }
  }

  let groupId = lastChildText(root, "groupId");
  if (groupId === "") {
    // The current module could inherit parent (metadata.go:96-98).
    groupId = lastChildText(lastDirectChild(root, "parent") ?? root, "groupId");
  }
  if (groupId === "") throw new MavenPomInvalidArgumentError();

  const metadata: MavenPomMetadata = { group_id: groupId };
  const artifactId = lastChildText(root, "artifactId");
  if (artifactId !== "") metadata.artifact_id = artifactId;
  const name = lastChildText(root, "name");
  if (name !== "") metadata.name = name;
  const description = lastChildText(root, "description");
  if (description !== "") metadata.description = description;
  if (url !== "") metadata.project_url = url;
  if (licenses.length > 0) metadata.licenses = licenses;
  if (dependencies.length > 0) metadata.dependencies = dependencies;
  return metadata;
}

// ---------------------------------------------------------------------------
// The maven-metadata.xml document (api.go MetadataResponse + maven.go:82-150)
// ---------------------------------------------------------------------------

/**
 * createMetadataResponse + xml.Marshal + xml.Header (api.go:14-47): the
 * versions in creation order, `latest` = the newest-created, `release` = the
 * last non-SNAPSHOT (omitted when every version is a -SNAPSHOT, upstream's
 * omitempty), all through Go's EscapeText set.
 */
export function renderMavenMetadataXml(groupId: string, artifactId: string, versions: string[]): string {
  let release: string | null = null;
  for (const version of versions) {
    if (!version.endsWith("-SNAPSHOT")) release = version;
  }
  const releaseXml = release === null ? "" : `<release>${escapeXmlText(release)}</release>`;
  const latest = versions[versions.length - 1] ?? "";
  const versionsXml = versions.map((version) => `<version>${escapeXmlText(version)}</version>`).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<metadata><groupId>${escapeXmlText(groupId)}</groupId><artifactId>${escapeXmlText(artifactId)}</artifactId>` +
    `<versioning>${releaseXml}<latest>${escapeXmlText(latest)}</latest>` +
    `<versions>${versionsXml}</versions></versioning></metadata>`
  );
}

export interface MavenMetadataDocument {
  /** The exact served bytes' text (header included — upstream hashes
   *  xmlMetadataWithHeader, maven.go:118). */
  xml: string;
  /** The newest-created version's timestamp (the Last-Modified header). */
  lastModified: Date;
}

/**
 * serveMavenMetadata's data half (maven.go:82-115): the versions of BOTH
 * package names (legacy first, maven.go:85-95), each list excluding internal
 * rows (GetVersionsByPackageName's IsInternal:false, package_version.go:148),
 * sorted ascending by creation (maven.go:108-111). Null = 404.
 */
export async function loadMavenMetadataDocument(
  d1: D1Database,
  owner: PackageOwnerRow,
  params: MavenPathParameters,
): Promise<MavenMetadataDocument | null> {
  // Upstream serves EVERY version (SearchVersions with no paginator); the
  // explicit large limit stands in for "no pagination" (the pypi idiom).
  const legacy = await searchVersions(d1, {
    ownerId: owner.id,
    type: "maven",
    name: mavenLegacyPackageName(params),
    exact: true,
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });
  const current = await searchVersions(d1, {
    ownerId: owner.id,
    type: "maven",
    name: mavenInternalPackageName(params),
    exact: true,
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });
  const rows: { version: PackageVersionRow }[] = [...legacy.rows, ...current.rows];
  if (rows.length === 0) return null;
  // sort.Slice ascending by CreatedUnix (maven.go:108-111); the tie-break is
  // ascending id (upstream's sort is unstable on the second-resolution ties —
  // ours pins insertion order, which also matches the model's max(id)-is-latest
  // rule).
  rows.sort(
    (a, b) => a.version.createdUnix.getTime() - b.version.createdUnix.getTime() || a.version.id - b.version.id,
  );
  const latest = rows[rows.length - 1]!.version;
  return {
    xml: renderMavenMetadataXml(
      params.groupId,
      params.artifactId,
      rows.map((row) => row.version.version),
    ),
    lastModified: latest.createdUnix,
  };
}

/** The checksum of the exact metadata bytes (maven.go:126-143); md5 is the
 *  local implementation, the rest WebCrypto. */
export async function mavenMetadataChecksum(xml: string, ext: string): Promise<string> {
  const bytes = new TextEncoder().encode(xml);
  switch (ext) {
    case ".md5":
      return md5Hex(bytes);
    case ".sha1":
      return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)));
    case ".sha256":
      return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    case ".sha512":
      return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-512", bytes)));
    default:
      throw new Error(`not a checksum extension: ${ext}`);
  }
}

// ---------------------------------------------------------------------------
// The upload walk (UploadPackageFile, maven.go:238-414)
// ---------------------------------------------------------------------------

/** Go strconv.ParseBool's truthy set — FormBool("use_legacy_package_name"). */
function isGoTruthyFormValue(raw: string): boolean {
  return raw === "1" || raw === "t" || raw === "T" || raw === "TRUE" || raw === "true" || raw === "True";
}

export interface UploadMavenPackageFileInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  /** The route wildcard (already decoded — decodeMavenPathWildcard). */
  pathWildcard: string;
  /** The raw `use_legacy_package_name` query value (Go ParseBool'd). */
  useLegacyPackageName: string;
  /** The request body stream (spooled whole; never buffered). */
  content: ReadableStream<Uint8Array>;
  /** The REQUIRED declared Content-Length of the body. */
  declaredLength: number;
  quota: PackagesQuotaConfig;
  now?: Date;
  /** Test seams (mirroring the pypi/helm uploads'). */
  maxBytes?: number;
  spoolKey?: string;
}

export type MavenUploadOutcome =
  | { kind: "ignored-metadata" } // the artifact-level index PUT → 200 (maven.go:246-249)
  | { kind: "checksum-verified" } // the verification PUT → 200 (maven.go:345)
  | { kind: "created"; file: PackageFileRow; blob: PackageBlobRow; createdFile: boolean }; // → 201

/** The stored hash column a checksum extension reads (null columns → ""). */
function storedChecksum(blob: PackageBlobRow, ext: string): string {
  switch (ext) {
    case ".md5":
      return blob.hashMd5 ?? "";
    case ".sha1":
      return blob.hashSha1 ?? "";
    case ".sha256":
      return blob.hashSha256;
    case ".sha512":
      return blob.hashSha512 ?? "";
    default:
      return "";
  }
}

/**
 * The PUT's service walk. Arms in upstream's order: path params → the
 * artifact-level metadata ignore → the legacy-name resolve/rename → the
 * checksum VERIFY arm (quota-free, maven.go:306-347 returns before any quota
 * or creation) → the pom metadata parse (400 on malformed) → the size quota →
 * the create-or-add (duplicate file → 409, quota → 403).
 */
export async function uploadMavenPackageFile(input: UploadMavenPackageFileInput): Promise<MavenUploadOutcome> {
  const now = input.now ?? new Date();
  const params = extractMavenPathParameters(input.pathWildcard);
  if (params === null) throw new MavenInvalidParametersError();

  // Ignore the package index /<name>/maven-metadata.xml (maven.go:245-249).
  if (params.isMeta && params.version === "") {
    return { kind: "ignored-metadata" };
  }

  const packageName = isGoTruthyFormValue(input.useLegacyPackageName)
    ? mavenLegacyPackageName(params)
    : mavenInternalPackageName(params);
  const legacyName = mavenLegacyPackageName(params);
  const ext = mavenPathExt(params.filename); // the RAW ext — the upload arm is case-sensitive (maven.go:265)
  const isChecksum = isMavenChecksumExtension(ext);

  // The body streams through the spool. A checksum PUT caps at
  // maxChecksumSize (LimitReader(129+1) + isChecksumSizeAllowed, maven.go:266-278):
  // 129 bytes pass, 130 trip the cap → 413.
  let md5: Md5 | null = null;
  let spooled: SpooledBlob;
  if (isChecksum) {
    try {
      spooled = await spoolAndHash({
        bucket: input.bucket,
        content: input.content,
        declaredLength: input.declaredLength,
        maxBytes: MAX_CHECKSUM_BYTES,
        spoolKey: input.spoolKey,
      });
    } catch (error) {
      if (error instanceof PackageBlobTooLargeError) throw new MavenChecksumTooLargeError();
      throw error;
    }
  } else {
    // The artifact bytes: MD5 rides a tap on the way into the spool (one
    // pass, the landed hash-and-forward discipline; the other three digests
    // come from the spool itself).
    const digest = new Md5();
    const md5Tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        digest.update(chunk);
        controller.enqueue(chunk);
      },
    });
    spooled = await spoolAndHash({
      bucket: input.bucket,
      content: input.content.pipeThrough(md5Tap),
      declaredLength: input.declaredLength,
      maxBytes: input.maxBytes,
      spoolKey: input.spoolKey,
    });
    md5 = digest;
  }

  try {
    // Old maven packages use "groupId-artifactId" as the package name —
    // rename the legacy row to the current form (maven.go:292-303). With the
    // legacy flag set the "rename" target IS the legacy name (an update
    // no-op, upstream's own shape).
    const legacyPackage = await getPackageByName(input.d1, input.owner.id, "maven", legacyName);
    if (legacyPackage !== null) {
      await drizzle(input.d1)
        .update(packages)
        .set({ name: packageName, lowerName: packageName.toLowerCase() })
        .where(
          and(
            eq(packages.id, legacyPackage.id),
            eq(packages.ownerId, input.owner.id),
            eq(packages.type, "maven"),
            eq(packages.isInternal, false),
          ),
        )
        .run();
    }

    // Do not upload checksum files but compare the hashes (maven.go:305-347):
    // version and file must exist (both 404), the ≤129-byte body compares
    // EXACTLY against the stored column, and nothing is stored.
    if (isChecksum) {
      const version = await getVersionByNameAndVersion(
        input.d1,
        input.owner.id,
        "maven",
        packageName,
        params.version,
      );
      if (version === null) throw new MavenPackageNotExistError();
      const file = await getFileForVersionByName(
        input.d1,
        version.id,
        params.filename.slice(0, params.filename.length - ext.length),
      );
      if (file === null) throw new MavenPackageFileNotExistError();
      const blob = await getBlobById(input.d1, file.blobId);
      if (blob === null) throw new Error("package blob row missing");
      const spoolObject = await input.bucket.get(spooled.spoolKey);
      if (spoolObject === null) throw new Error("package spool object vanished");
      const bodyText = new TextDecoder().decode(new Uint8Array(await spoolObject.arrayBuffer()));
      if (storedChecksum(blob, ext) !== bodyText) throw new MavenHashMismatchError();
      // The checksum body is never stored — the spool dies here (a mismatch
      // throws into the catch's delete instead).
      await input.bucket.delete(spooled.spoolKey);
      return { kind: "checksum-verified" };
    }

    // COUNT: upstream checks AFTER the version insert, inside the
    // rolling-back transaction (the versionCreated gate, packages.go:188-191)
    // and throws when totalCount > limit (packages.go:380-381) — the
    // pre-insert equivalent is count + 1 > limit, so an exactly-at-limit
    // owner publishes the version that REACHES the cap but not one past.
    if (!input.doer.isAdmin && input.quota.limitTotalOwnerCount > UNLIMITED_QUOTA) {
      const total = (await countVersions(input.d1, input.owner.id)) + 1;
      if (total > input.quota.limitTotalOwnerCount) {
        throw new QuotaTotalCountError();
      }
    }

    // If it's the package pom file extract the metadata (maven.go:359-394):
    // the parse is 400 on a malformed pom, BEFORE the quota/creation arms —
    // upstream's order (the parse sits before CreatePackageOrAddFileToExisting).
    let pomMetadata: MavenPomMetadata | null = null;
    if (ext === ".pom") {
      const spoolObject = await input.bucket.get(spooled.spoolKey);
      if (spoolObject === null) throw new Error("package spool object vanished");
      const pomBytes = new Uint8Array(await spoolObject.arrayBuffer());
      pomMetadata = parsePomMetadata(pomBytes);
    }

    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "maven", spooled.size, input.quota);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "maven",
      name: packageName,
      // SemverCompatible: false (maven.go:288).
      semverCompatible: false,
      now,
    });
    const { row: version } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: params.version,
      now,
    });
    // The pom metadata lands on BOTH arms: marshaled into the fresh version's
    // INSERT (packages.go:170-186) or updated on the existing one
    // (maven.go:370-388). A non-pom upload leaves SQL NULL where upstream
    // stores "null" (documented, invisible to consumers).
    if (pomMetadata !== null) {
      await writeVersionMetadata(input.d1, version.id, JSON.stringify(pomMetadata));
    }

    const { row: blob, created: blobCreated } = await getOrInsertBlob(input.d1, {
      size: spooled.size,
      sha256: spooled.sha256,
      sha1: spooled.sha1,
      sha512: spooled.sha512,
      now,
    });
    // The four-hash parity repair: maven's .md5 is on the wire both ways, so
    // a dedup hit whose row predates this module (or arrived from another
    // protocol) gets its NULL md5 filled in — same bytes, idempotent value.
    const contentMd5 = md5?.hex() ?? null;
    if (blob.hashMd5 === null && contentMd5 !== null) {
      await drizzle(input.d1)
        .update(packageBlobs)
        .set({ hashMd5: contentMd5 })
        .where(eq(packageBlobs.id, blob.id))
        .run();
      blob.hashMd5 = contentMd5;
    }

    // A dedup hit whose object still exists skips the copy; a miss runs the
    // one bounded second pass (the landed two-pass discipline).
    const objectPresent = (await input.bucket.head(packageBlobContentKey(spooled.sha256))) !== null;
    if (blobCreated || !objectPresent) {
      await copySpoolToContentKey(input.bucket, spooled.spoolKey, spooled.sha256);
    } else {
      await input.bucket.delete(spooled.spoolKey);
    }

    // IsLead only for the pom (maven.go:360-361); the SNAPSHOT metadata file
    // re-publishes with OverwriteExisting (maven.go:356 — the same-blob
    // short circuit stays a 201); every other duplicate is the 409 upstream's
    // TryInsertFile answers regardless of bytes (maven.go:403-404).
    const fileResult: InsertFileResult = await insertMavenFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: params.filename,
      isLead: ext === ".pom",
      overwrite: params.isMeta,
      now,
    });
    if (fileResult.outcome === "conflict") {
      throw new DuplicatePackageFileError(fileResult.row);
    }
    if (fileResult.outcome === "identical" && !params.isMeta) {
      throw new DuplicatePackageFileError(fileResult.row);
    }
    return { kind: "created", file: fileResult.row, blob, createdFile: fileResult.outcome === "created" };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

/**
 * The OverwriteExisting insert (packages.go:319-345): an existing file with
 * the same blob is the short-circuit no-op; a different blob is deleted
 * (properties with it) and re-inserted; no existing row is a plain insert.
 */
async function insertMavenFile(
  d1: D1Database,
  input: {
    versionId: number;
    blobId: number;
    name: string;
    isLead: boolean;
    overwrite: boolean;
    now: Date;
  },
): Promise<InsertFileResult> {
  if (!input.overwrite) {
    return tryInsertFile(d1, {
      versionId: input.versionId,
      blobId: input.blobId,
      name: input.name,
      isLead: input.isLead,
      now: input.now,
    });
  }
  const existing = await getFileForVersionByName(d1, input.versionId, input.name);
  if (existing === null) {
    return tryInsertFile(d1, {
      versionId: input.versionId,
      blobId: input.blobId,
      name: input.name,
      isLead: input.isLead,
      now: input.now,
    });
  }
  if (existing.blobId === input.blobId) {
    return { outcome: "identical", row: existing };
  }
  await deletePackageFile(d1, existing.id);
  return tryInsertFile(d1, {
    versionId: input.versionId,
    blobId: input.blobId,
    name: input.name,
    isLead: input.isLead,
    now: input.now,
  });
}

// ---------------------------------------------------------------------------
// The download walks (maven.go:59-231)
// ---------------------------------------------------------------------------

/** The per-extension Content-Type (maven.go:209-214); unspecified extensions
 *  answer application/octet-stream (Go sniffs — documented). */
export function mavenServeContentType(ext: string): string {
  switch (ext) {
    case ".jar":
      return "application/java-archive";
    case ".pom":
      return "text/xml";
    default:
      return "application/octet-stream";
  }
}

export interface MavenOpenedFile {
  kind: "file";
  file: PackageFileRow;
  blob: PackageBlobRow;
  /** Fresh stream over the content object (the caller pipes it out). */
  stream: ReadableStream;
  size: number;
  contentType: string;
}

export interface MavenOpenedChecksum {
  kind: "checksum";
  hash: string;
}

/**
 * servePackageFile (maven.go:152-231): the version walk tries the current
 * name then the legacy fallback (maven.go:153-156), the filename sheds its
 * checksum extension before the file lookup, a checksum GET answers the
 * STORED hash (maven.go:189-203), and the lead-file GET bumps the download
 * counter (OpenBlobForDownload, packages.go:667-671 — checksum GETs return
 * before it, so they never count). Throws the typed 404s; a missing blob row
 * or R2 object is the internal-error arm.
 */
export async function openMavenFile(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  params: MavenPathParameters,
  method: "GET" | "HEAD",
): Promise<MavenOpenedFile | MavenOpenedChecksum> {
  const ext = mavenPathExt(params.filename).toLowerCase(); // the SERVE path lowercases (maven.go:168)
  const isChecksum = isMavenChecksumExtension(ext);

  let version = await getVersionByNameAndVersion(
    d1,
    owner.id,
    "maven",
    mavenInternalPackageName(params),
    params.version,
  );
  if (version === null) {
    version = await getVersionByNameAndVersion(d1, owner.id, "maven", mavenLegacyPackageName(params), params.version);
  }
  if (version === null) throw new MavenPackageNotExistError();

  const filename = isChecksum ? params.filename.slice(0, params.filename.length - ext.length) : params.filename;
  const file = await getFileForVersionByName(d1, version.id, filename);
  if (file === null) throw new MavenPackageFileNotExistError();
  const blob = await getBlobById(d1, file.blobId);
  if (blob === null) throw new Error("package blob row missing");

  if (isChecksum) {
    return { kind: "checksum", hash: storedChecksum(blob, ext) };
  }

  const object = await bucket.get(packageBlobContentKey(blob.hashSha256));
  if (object === null) throw new Error("package content object missing");
  if (file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, version.id);
  }
  return {
    kind: "file",
    file,
    blob,
    stream: object.body,
    size: object.size,
    contentType: mavenServeContentType(ext),
  };
}

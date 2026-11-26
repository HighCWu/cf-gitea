/**
 * The Terraform MODULE registry service (SPEC terraform-module-registry.md —
 * upstream 5d9bfa1e14 at the pin, modules/packages/terraform_module/ +
 * routers/api/packages/terraform_module/). Distinct from the STATE backend
 * beside it (terraform.ts — the GitLab-compatible /terraform/state API): the
 * module registry speaks Hashicorp's module registry protocol over package
 * rows of type `terraform-module`.
 *
 * The model: one PACKAGE per (owner, "{name}/{provider}" — package.go:54's
 * `TypeTerraformModule`, semverCompatible=true), one VERSION per canonical
 * semver (NormalizeVersion's `v1.0.0` == `1.0.0` fold, parser.go:39-44), ONE
 * lead file `module.tar.gz` per version stored VERBATIM and immutable
 * (terraform_module.go:27 `archiveFilename`; no OverwriteExisting anywhere —
 * a duplicate version answers 409), and the version's `metadata_json` holds
 * the parsed Metadata (metadata.go) read by the in-tree HCL scanner (hcl.go
 * — upstream's 235-line block scanner standing in for hashicorp/hcl/v2).
 * No file/package properties and no delete guards exist for the type (only
 * terraform STATE registers a spec upstream).
 *
 * Ports, anchor-for-anchor:
 * - ValidateAddress (parser.go:32-46) — Terraform's registry-address rules:
 *   namespace/name match `[0-9A-Za-z](?:[0-9A-Za-z_-]{0,62}[0-9A-Za-z])?`,
 *   provider `[0-9a-z]{1,64}`.
 * - NormalizeVersion (parser.go:39-44) — hashicorp/go-version v1.9.0
 *   NewSemver: `v?([0-9]+(\.[0-9]+)*?)(-(pre))?(+(meta))?` anchored, segments
 *   padded to 3, String() drops the `v` prefix (so v1.0.0 and 1.0.0 are the
 *   same row). Segments decode through BigInt to keep Go's int64 width (a
 *   segment past 2^63-1 errors, Go ParseInt's arm; JS Number would silently
 *   round — the terraform.ts serial-precision posture).
 * - ParseModuleArchive (parser.go:46-125): gzip stream, TOTAL decompressed
 *   bytes capped at MaxMetadataSize = 32 MiB (limited_reader.go:14 —
 *   N=limit+1, the past-cap byte errors ErrContentTooLarge; our port caps
 *   the materialized buffer at limit+1 and reads headers/data/skip-padding
 *   from it — upstream streams, the cap is the observable); tar walk over
 *   regular files only, dotfile basenames skipped, `.tf`/`.tf.json` sources
 *   + `readme.md`/`readme` (case-insensitive, ≤ 1 MiB); empty dir → root,
 *   `modules/<name>` (exactly one level) → submodule; no root and no
 *   submodules → ErrNoRootModule (the "package the contents" teaching
 *   message verbatim).
 * - The HCL scanner (hcl.go): four indexed block types, depth ≤ 2 (only
 *   terraform.required_providers nests), `${`/`%{` template nesting capped
 *   at 32; expressions captured RAW (never evaluated — Input.type and
 *   Input.default store expression text, the quoted default keeps its
 *   quotes); hclString decodes quoted strings/heredocs and answers "" for
 *   anything needing evaluation (a live `${`/`%{` after stripping the
 *   `$${`/`%%{` escapes). The seven upstream malformed-never-panic vectors
 *   are pinned in the battery.
 * - The archive download's signed URL (upstream base/tool.go:36-95): 58-char
 *   time-limit code `YYYYMMDDHHmm + %06d(minutes) + hex(HMAC-SHA1)` keyed by
 *   the general token signing secret over
 *   `data + hex(secret) + startStr + endStr + minutes`, verified
 *   constant-time with the `start <= now < start+minutes` window. UTC rides
 *   for Go's `time.Local` (self-consistent create+verify; recorded).
 * - The upload walk (terraform_module.go:109-176 over packages service
 *   CreatePackageAndAddFile): spool verbatim → parse metadata → the
 *   count/size quota gates → package+version+lead file → the created-arm
 *   webhook. The delete walk (RemovePackageVersionByNameAndVersion) emits
 *   the deleted event with the descriptor resolved BEFORE the cascade (the
 *   generic family's shape).
 *
 * Divergences (each recorded per AGENTS.md): the 512 MiB store cap answers
 * 413 where upstream's spool is unbounded (the standing family posture);
 * UTC for time.Local; the mutation arbiter is the D1 UNIQUEs (no globallock,
 * the model.ts header posture); the gzip/tar error SUFFIXES are
 * DecompressionStream-shaped where Go names the format
 * ("invalid gzip stream: …" / "invalid tar stream: …" prefixes match); the
 * 32 MiB cap trips on total decompressed stream bytes (headers + data +
 * padding) exactly like upstream's limited reader wrapped around the gzip
 * stream; Go's \xNN/octal string escapes insert raw bytes where our decoder
 * yields the matching code points (multi-byte \x sequences can differ in
 * re-encoded UTF-8 — descriptions only, unreachable from real HCL).
 */

import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageVersions, packages, systemKeystore } from "../../db/schema";
import { KEYSTORE_SECRET_ROW } from "../actions/secrets";
import {
  DuplicatePackageVersionError,
  QuotaTotalCountError,
  type PackageBlobRow,
  type PackageDoer,
  type PackageOwnerRow,
  type PackagesQuotaConfig,
  type PackageFileRow,
  type PackageVersionRow,
  UNLIMITED_QUOTA,
  checkSizeQuotaExceeded,
  countVersions,
  deletePackageVersionAndReferences,
  getFileForVersionByName,
  getOrInsertPackage,
  getOrInsertVersion,
  getPackageByName,
  getVersionByNameAndVersion,
  incrementDownloadCounter,
  tryInsertFile,
} from "./model";
import { copySpoolToContentKey, getBlobById, getOrInsertBlob, packageBlobContentKey, spoolAndHash, type SpooledBlob } from "./blobs";
import { writeVersionMetadata } from "./protocol-common";
import { emitPackageCreated, type PackageEventEnv } from "./webhooks";

// ---------------------------------------------------------------------------
// The wire types (metadata.go — Go field order; omitempty = undefined)
// ---------------------------------------------------------------------------

/** metadata.go:32-38 — an `variable` block's scanned shape. */
export interface TerraformModuleInput {
  name: string;
  type?: string;
  description?: string;
  /** The RAW expression text (a quoted default keeps its quotes). */
  default?: string;
  required: boolean;
}

/** metadata.go:40-43. */
export interface TerraformModuleOutput {
  name: string;
  description?: string;
}

/** metadata.go:45-49 — a required_providers entry. */
export interface TerraformModuleProvider {
  name: string;
  source?: string;
  version?: string;
}

/** metadata.go:24-30 — one module body (root or submodule). */
export interface TerraformModuleModule {
  inputs?: TerraformModuleInput[];
  outputs?: TerraformModuleOutput[];
  providers?: TerraformModuleProvider[];
}

/** metadata.go:19-22 — a module packaged under modules/<name>. */
export interface TerraformModuleSubmodule {
  readme?: string;
  module?: TerraformModuleModule;
}

/** metadata.go:14-17 — the version's metadata_json document. */
export interface TerraformModuleMetadata {
  readme?: string;
  root?: TerraformModuleModule;
  submodules?: Record<string, TerraformModuleSubmodule>;
}

/** The package type value (package.go:54). */
export const TERRAFORM_MODULE_PACKAGE_TYPE = "terraform-module";

/** terraform_module.go:27 — the single lead file name. */
export const TERRAFORM_MODULE_ARCHIVE_FILENAME = "module.tar.gz";

/** parser.go:20 — READMEs above this are not stored (rendered per view). */
export const TERRAFORM_MODULE_MAX_README_SIZE = 1024 * 1024;

/** packages.MaxMetadataSize (limited_reader.go:14). */
export const TERRAFORM_MODULE_MAX_METADATA_SIZE = 32 * 1024 * 1024;

/** terraform_module.go:28 — the signed archive URL's validity window. */
export const TERRAFORM_ARCHIVE_CODE_MINUTES = 10;

// ---------------------------------------------------------------------------
// Errors — the route maps each to its plain-text status
// ---------------------------------------------------------------------------

/** parser.go:15-19 ErrInvalidNamespace / ErrInvalidName / ErrInvalidProvider. */
export class TerraformModuleAddressError extends Error {
  readonly kind: "namespace" | "name" | "provider";
  constructor(kind: "namespace" | "name" | "provider", message: string) {
    super(message);
    this.kind = kind;
    this.name = "TerraformModuleAddressError";
  }
}

/** parser.go:20 ErrInvalidVersion. */
export class TerraformModuleVersionError extends Error {
  constructor() {
    super("module version is invalid");
    this.name = "TerraformModuleVersionError";
  }
}

/** Bad gzip / tar bytes (parser.go:51-54, 69-71) — the 400 arm. */
export class TerraformModuleArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerraformModuleArchiveError";
  }
}

/** packages ErrContentTooLarge (limited_reader.go:11) — the 413 arm. */
export class TerraformModuleContentTooLargeError extends Error {
  constructor() {
    super("content exceeds the size limit");
    this.name = "TerraformModuleContentTooLargeError";
  }
}

/** parser.go:23 ErrNoRootModule — the message teaches the fix. */
export class TerraformModuleNoRootError extends Error {
  constructor() {
    super(
      "no terraform module at the archive root: package the module directory's contents, not the directory itself (e.g. `tar -czf module.tar.gz -C path/to/module .`)",
    );
    this.name = "TerraformModuleNoRootError";
  }
}

// ---------------------------------------------------------------------------
// Address + version (parser.go:32-44)
// ---------------------------------------------------------------------------

const MODULE_NAME_RE = /^[0-9A-Za-z](?:[0-9A-Za-z_-]{0,62}[0-9A-Za-z])?$/;
const MODULE_SYSTEM_RE = /^[0-9a-z]{1,64}$/;

/**
 * ValidateAddress (parser.go:32-40): namespace and name share the
 * registry-address name rule; the provider (system) is lowercase-only.
 * Throws TerraformModuleAddressError with the upstream error's text.
 */
export function validateTerraformModuleAddress(namespace: string, name: string, provider: string): void {
  if (!MODULE_NAME_RE.test(namespace)) {
    throw new TerraformModuleAddressError("namespace", "module namespace (owner name) is invalid");
  }
  if (!MODULE_NAME_RE.test(name)) {
    throw new TerraformModuleAddressError("name", "module name is invalid");
  }
  if (!MODULE_SYSTEM_RE.test(provider)) {
    throw new TerraformModuleAddressError("provider", "module provider is invalid");
  }
}

/**
 * hashicorp/go-version v1.9.0 SemverRegexpRaw anchored (NewSemver's
 * grammar): optional `v`, dot-separated numeric segments (padding to 3 at
 * String time), `-` prerelease requiring its separator (numeric-led or
 * alpha/`-`/`~`-led alternates), `+` metadata. Capture 1 = segments,
 * 2 = prerelease, 3 = metadata.
 */
const GO_SEMVER_RE =
  /^v?([0-9]+(?:\.[0-9]+)*?)(?:-([0-9]+[0-9A-Za-z\-~]*(?:\.[0-9A-Za-z\-~]+)*|[A-Za-z\-~]+[0-9A-Za-z\-~]*(?:\.[0-9A-Za-z\-~]+)*))?(?:\+([0-9A-Za-z\-~]+(?:\.[0-9A-Za-z\-~]+)*))?$/;

const INT64_MAX = 9223372036854775807n;

/**
 * NormalizeVersion (parser.go:39-44 over go-version NewSemver+String): the
 * canonical form drops the `v` prefix, pads missing segments with 0 and
 * re-renders decimal — `v1.0.0`/`1.0.0`/`v1` all normalize to `1.0.0`, so
 * the lower-version UNIQUE makes them one row.
 */
export function normalizeTerraformModuleVersion(raw: string): string {
  const match = GO_SEMVER_RE.exec(raw);
  if (match === null) throw new TerraformModuleVersionError();
  const segmentTexts = match[1]!.split(".");
  const segments: bigint[] = [];
  for (const text of segmentTexts) {
    // Go strconv.ParseInt(str, 10, 64): digits only, int64 range.
    if (!/^\d+$/.test(text)) throw new TerraformModuleVersionError();
    const value = BigInt(text);
    if (value > INT64_MAX) throw new TerraformModuleVersionError();
    segments.push(value);
  }
  while (segments.length < 3) segments.push(0n);
  let out = segments.join(".");
  if (match[2] !== undefined) out += `-${match[2]}`;
  if (match[3] !== undefined) out += `+${match[3]}`;
  return out;
}

// ---------------------------------------------------------------------------
// The HCL scanner (hcl.go — the block-structure scanner, never an evaluator)
// ---------------------------------------------------------------------------

/** hcl.go:16 — bodies of other blocks are skipped wholesale. */
const HCL_INDEXED_BLOCKS = new Set(["variable", "output", "terraform", "required_providers"]);

/** hcl.go:27 — the `${`/`%{` template recursion cap. */
const HCL_MAX_NESTING = 32;

interface HclBlock {
  typ: string;
  labels: string[];
  /** attribute name → raw expression source bytes */
  attrs: Map<string, Uint8Array>;
  blocks: HclBlock[];
}

const DECODER = new TextDecoder("utf-8");

function decodeUtf8(bytes: Uint8Array): string {
  return DECODER.decode(bytes);
}

/**
 * hclScanner (hcl.go:20-27): reads HCL block structure without evaluating
 * expressions. Byte-indexed; `peek` answers 0 past the end (Go's byte
 * zero-value out-of-range read).
 */
class HclScanner {
  readonly src: Uint8Array;
  pos = 0;
  nesting = 0;

  constructor(src: Uint8Array) {
    this.src = src;
  }

  peek(offset: number): number {
    return this.pos + offset < this.src.length ? this.src[this.pos + offset]! : 0;
  }

  /** hcl.go:31-78 — the block body walker. */
  body(depth: number): HclBlock {
    const out: HclBlock = { typ: "", labels: [], attrs: new Map(), blocks: [] };
    for (;;) {
      this.skipSpace(true);
      if (this.pos >= this.src.length) return out;
      if (this.src[this.pos]! === 0x7d /* } */) {
        this.pos++;
        return out;
      }
      const start = this.pos;
      const name = this.ident();
      this.skipSpace(false);
      if (name !== "" && this.peek(0) === 0x3d /* = */) {
        this.pos++;
        this.skipSpace(false);
        const exprStart = this.pos;
        out.attrs.set(name, this.src.subarray(exprStart, this.skipExpr()));
        continue;
      }
      const labels: string[] = [];
      while (name !== "" && this.peek(0) !== 0x7b /* { */) {
        const labelStart = this.pos;
        if (this.peek(0) === 0x22 /* " */) {
          this.skipString();
          labels.push(hclString(decodeUtf8(this.src.subarray(labelStart, this.pos))));
        } else {
          const label = this.ident();
          if (label === "") break;
          labels.push(label);
        }
        this.skipSpace(false);
      }
      // only terraform.required_providers needs two levels (hcl.go:61-64)
      if (name === "" || this.peek(0) !== 0x7b || depth >= 2 || !HCL_INDEXED_BLOCKS.has(name)) {
        this.skipExpr();
        if (this.pos === start) this.pos++;
        continue;
      }
      this.pos++;
      const block = this.body(depth + 1);
      block.typ = name;
      block.labels = labels;
      out.blocks.push(block);
    }
  }

  /**
   * skipExpr (hcl.go:81-107): advance to the newline, comma or unbalanced
   * closing bracket that ends an expression; answers where its source ends
   * (trailing whitespace/comments excluded, the closing bracket itself too).
   */
  skipExpr(): number {
    let end = this.pos;
    for (let depth = 0; this.pos < this.src.length; ) {
      const c = this.src[this.pos]!;
      if (c === 0x22 /* " */) {
        this.skipString();
      } else if (c === 0x3c /* < */ && this.skipHeredoc()) {
        // the heredoc body was consumed wholesale (the empty Go case)
      } else if (this.skipComment()) {
        continue;
      } else if ((c === 0x0a || c === 0x2c) && depth === 0) {
        return end;
      } else if (c === 0x7d || c === 0x5d || c === 0x29 /* } ] ) */) {
        if (depth === 0) return end;
        depth--;
        this.pos++;
      } else if (c === 0x7b || c === 0x5b || c === 0x28 /* { [ ( */) {
        depth++;
        this.pos++;
      } else if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) {
        this.pos++;
        continue;
      } else {
        this.pos++;
      }
      end = this.pos;
    }
    return end;
  }

  /**
   * skipString (hcl.go:109-137): a quoted string scanner honoring `\\`
   * escapes, doubled `$$`/`%%`, and `${`/`%{` template sequences (whose
   * nested expressions may carry commas/newlines) with the recursion cap.
   */
  skipString(): void {
    this.pos++;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if ((c === 0x5c && this.pos + 1 < this.src.length) || ((c === 0x24 || c === 0x25) && this.peek(1) === c)) {
        this.pos++;
      } else if (c === 0x22 /* " */) {
        this.pos++;
        return;
      } else if (c === 0x0a) {
        return;
      } else if ((c === 0x24 || c === 0x25) && this.peek(1) === 0x7b /* { */) {
        if (this.nesting >= HCL_MAX_NESTING) return;
        this.nesting++;
        this.pos += 2;
        // commas and newlines don't end a template sequence (hcl.go:126)
        for (;;) {
          this.skipExpr();
          const p = this.peek(0);
          if (p === 0x2c || p === 0x0a) {
            this.pos++;
            continue;
          }
          break;
        }
        this.nesting--;
        if (this.peek(0) !== 0x7d) return;
      }
      this.pos++;
    }
  }

  /** skipHeredoc (hcl.go:139-165): `<<[-]DELIM … DELIM` bodies, wholesale. */
  skipHeredoc(): boolean {
    const start = this.pos;
    if (this.peek(1) !== 0x3c /* < */) return false;
    this.pos += 2;
    if (this.peek(0) === 0x2d /* - */) this.pos++;
    const delim = this.ident();
    if (this.peek(0) === 0x0d) this.pos++;
    if (delim === "" || this.peek(0) !== 0x0a) {
      this.pos = start;
      return false;
    }
    while (this.pos < this.src.length) {
      const lineStart = this.pos + 1;
      this.pos = this.src.length;
      const lineEnd = this.src.indexOf(0x0a, lineStart);
      if (lineEnd >= 0) this.pos = lineEnd;
      if (decodeUtf8(this.src.subarray(lineStart, this.pos)).trim() === delim) break;
    }
    return true;
  }

  /** skipComment (hcl.go:167-183): hash and double-slash to end of line,
   *  slash-star blocks wholesale. */
  skipComment(): boolean {
    const c = this.peek(0);
    if (c === 0x23 /* # */ || (c === 0x2f /* slash */ && this.peek(1) === 0x2f)) {
      while (this.pos < this.src.length && this.src[this.pos] !== 0x0a) this.pos++;
      return true;
    }
    if (c === 0x2f && this.peek(1) === 0x2a /* star — the block-comment opener */) {
      const close = indexOfSeq(this.src, this.pos + 2, [0x2a, 0x2f]);
      this.pos = close >= 0 ? close + 2 : this.src.length;
      return true;
    }
    return false;
  }

  /** skipSpace (hcl.go:185-198): blanks always; newlines/commas when asked. */
  skipSpace(newlines: boolean): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === 0x20 || c === 0x09 || c === 0x0d || (newlines && (c === 0x0a || c === 0x2c))) {
        this.pos++;
        continue;
      }
      if (!this.skipComment()) return;
    }
  }

  /** ident (hcl.go:200-210): `_`, letters, and inner `-`/digits. */
  ident(): string {
    const start = this.pos;
    for (; this.pos < this.src.length; this.pos++) {
      const c = this.src[this.pos]!;
      const isIdentStart = c === 0x5f || (0x61 <= c && c <= 0x7a) || (0x41 <= c && c <= 0x5a);
      const isIdentInner = this.pos > start && (c === 0x2d || (0x30 <= c && c <= 0x39));
      if (!(isIdentStart || isIdentInner)) break;
    }
    return decodeUtf8(this.src.subarray(start, this.pos));
  }
}

/** indexOfSeq — bytes.Index for the block-comment closer scan (src has no
 *  indexOf over Uint8Array). */
function indexOfSeq(src: Uint8Array, from: number, seq: [number, number]): number {
  for (let i = Math.max(from, 0); i + 1 < src.length + 1; i++) {
    if (src[i] === seq[0] && src[i + 1] === seq[1]) return i;
  }
  return -1;
}

const hclEscapedTemplates = /\$\$\{|%%\{/g;

/**
 * hclString (hcl.go:216-231): decodes a string literal or heredoc;
 * expressions and templates that need evaluation answer "". `$${`/`%%{`
 * are escaped-template markers — stripped for the evaluation check, then
 * unescaped into literal `${`/`%{` in the decoded output.
 */
export function hclString(expr: string): string {
  if (expr.startsWith("<<")) {
    const nl = expr.indexOf("\n");
    if (nl < 0) return "";
    const content = expr.slice(nl + 1);
    const last = content.lastIndexOf("\n");
    return content.slice(0, last + 1);
  }
  const unescaped = expr.replace(hclEscapedTemplates, "");
  if (unescaped.includes("${") || unescaped.includes("%{")) return "";
  const decoded = goUnquote(expr);
  if (decoded === null) return "";
  return decoded.replace(/\$\$\{/g, "${").replace(/%%\{/g, "%{");
}

/**
 * strconv.Unquote for the double-quoted form (the only shape hclString
 * feeds it): standard Go escapes, `\xNN`/octal as matching code points,
 * `\uXXXX`/`\UXXXXXXXX` as code points; anything else (raw newline/CR,
 * unknown escape, inner quote) errors → null → hclString answers "".
 */
function goUnquote(expr: string): string | null {
  if (expr.length < 2 || !expr.startsWith('"') || !expr.endsWith('"')) return null;
  let out = "";
  let i = 1;
  const end = expr.length - 1;
  while (i < end) {
    const c = expr[i];
    if (c === "\n" || c === "\r") return null;
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    i++;
    if (i >= end) return null;
    const e = expr[i];
    i++;
    switch (e) {
      case "a":
        out += "\x07";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "v":
        out += "\v";
        break;
      case "\\":
        out += "\\";
        break;
      case '"':
        out += '"';
        break;
      case "'":
        out += "'";
        break;
      case "x": {
        const hex = expr.slice(i, i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 2;
        break;
      }
      case "u": {
        const hex = expr.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 4;
        break;
      }
      case "U": {
        const hex = expr.slice(i, i + 8);
        if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null;
        const value = Number.parseInt(hex, 16);
        if (value > 0x10ffff) return null;
        out += String.fromCodePoint(value);
        i += 8;
        break;
      }
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7": {
        const oct = expr.slice(i - 1, i + 2);
        if (!/^[0-7]{3}$/.test(oct)) return null;
        out += String.fromCodePoint(Number.parseInt(oct, 8));
        i += 2;
        break;
      }
      default:
        return null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// parseModule (parser.go:127-165) — one module body over its .tf file map
// ---------------------------------------------------------------------------

interface NamedSource {
  /** byte-order sort key (Go strings.Compare is byte-wise) */
  nameBytes: Uint8Array;
  name: string;
  data: Uint8Array;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

function trimBom(data: Uint8Array): Uint8Array {
  return data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? data.subarray(3) : data;
}

/** parseModule (parser.go:127-165): scan the sorted sources, collect. */
function parseTerraformModuleBody(files: NamedSource[]): TerraformModuleModule {
  const inputs: TerraformModuleInput[] = [];
  const outputs: TerraformModuleOutput[] = [];
  const providers = new Map<string, TerraformModuleProvider>();
  for (const file of files) {
    const scanner = new HclScanner(trimBom(file.data));
    for (const block of scanner.body(0).blocks) {
      const attrs = block.attrs;
      if (block.typ === "variable" && block.labels.length === 1) {
        const hasDefault = attrs.has("default");
        const input: TerraformModuleInput = {
          name: block.labels[0]!,
          type: decodeUtf8(attrs.get("type") ?? new Uint8Array()),
          description: hclString(decodeUtf8(attrs.get("description") ?? new Uint8Array())),
          default: decodeUtf8(attrs.get("default") ?? new Uint8Array()),
          required: !hasDefault,
        };
        inputs.push(stripEmptyInputStrings(input));
      } else if (block.typ === "output" && block.labels.length === 1) {
        const output: TerraformModuleOutput = {
          name: block.labels[0]!,
          description: hclString(decodeUtf8(attrs.get("description") ?? new Uint8Array())),
        };
        outputs.push(stripEmptyOutputStrings(output));
      } else if (block.typ === "terraform") {
        for (const inner of block.blocks) {
          if (inner.typ !== "required_providers") continue;
          for (const [name, expr] of inner.attrs) {
            if (providers.has(name)) continue;
            const provider: TerraformModuleProvider = { name };
            const exprText = expr;
            if (exprText.length > 0 && exprText[0] === 0x7b /* { */) {
              const fields = new HclScanner(exprText.subarray(1)).body(2).attrs;
              const source = hclString(decodeUtf8(fields.get("source") ?? new Uint8Array()));
              const version = hclString(decodeUtf8(fields.get("version") ?? new Uint8Array()));
              if (source !== "") provider.source = source;
              if (version !== "") provider.version = version;
            } else {
              const version = hclString(decodeUtf8(exprText));
              if (version !== "") provider.version = version;
            }
            providers.set(name, provider);
          }
        }
      }
    }
  }
  const module: TerraformModuleModule = {};
  if (inputs.length > 0) module.inputs = inputs;
  if (outputs.length > 0) module.outputs = outputs;
  if (providers.size > 0) {
    module.providers = [...providers.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return module;
}

/** Go omitempty: empty optional strings stay off the wire. */
function stripEmptyInputStrings(input: TerraformModuleInput): TerraformModuleInput {
  const out: TerraformModuleInput = { name: input.name, required: input.required };
  if (input.type !== "") out.type = input.type;
  if (input.description !== "") out.description = input.description;
  if (input.default !== "") out.default = input.default;
  return out;
}

function stripEmptyOutputStrings(output: TerraformModuleOutput): TerraformModuleOutput {
  const out: TerraformModuleOutput = { name: output.name };
  if (output.description !== "") out.description = output.description;
  return out;
}

// ---------------------------------------------------------------------------
// ParseModuleArchive (parser.go:46-125) — the gzip+tar walk
// ---------------------------------------------------------------------------

/** Go path.Clean (lexical, posix). Returns "" only for an empty input. */
function posixClean(path: string): string {
  if (path === "") return ".";
  const rooted = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!rooted) {
        out.push("..");
      }
      continue;
    }
    out.push(part);
  }
  let joined = out.join("/");
  if (rooted) joined = `/${joined}`;
  return joined === "" ? "." : joined;
}

interface TarEntry {
  name: string;
  typeflag: number;
  size: number;
  dataOffset: number;
}

/**
 * The ustar walk (the helm ByteReader idiom, capped at the metadata limit +
 * 1 — limited_reader.go's N=limit+1 delivers at most that many bytes): GNU
 * `L` long names and PAX `path` records resolve; base-256 size fields are
 * rejected (the helm divergence); one zero block ends the archive.
 */
function walkTar(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  // carried GNU L / pax path for the NEXT member header
  let longName: string | null = null;
  let paxPath: string | null = null;
  for (;;) {
    if (tar.length - offset < 512) return entries; // clean end (trailing bytes tolerate)
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return entries;
    offset += 512;
    const size = parseTarSize(header.subarray(124, 136));
    const typeflag: number = header[156] ?? 0;
    let name: string;
    if (longName !== null) {
      name = longName;
      longName = null;
    } else if (paxPath !== null) {
      name = paxPath;
      paxPath = null;
    } else {
      const base = decodeUtf8(header.subarray(0, 100)).split("\0")[0]!;
      const prefix = decodeUtf8(header.subarray(345, 500)).split("\0")[0]!;
      name = prefix !== "" ? `${prefix}/${base}` : base;
    }
    if (typeflag === 0x4c /* GNU L — the next header's name */) {
      if (tar.length - offset < size) throw new TerraformModuleArchiveError("invalid tar stream: truncated long name");
      longName = decodeUtf8(tar.subarray(offset, offset + size)).replace(/\0.*$/, "");
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    if (typeflag === 0x78 /* pax x — extended header */) {
      if (tar.length - offset < size) throw new TerraformModuleArchiveError("invalid tar stream: truncated pax header");
      paxPath = readPaxPath(tar.subarray(offset, offset + size));
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    const isRegular = typeflag === 0x30 || typeflag === 0;
    if (isRegular) {
      if (tar.length - offset < size) throw new TerraformModuleArchiveError("invalid tar stream: member is truncated");
      entries.push({ name, typeflag, size, dataOffset: offset });
    }
    offset += Math.ceil(size / 512) * 512;
  }
}

/** helm's parseOctalSize — octal text, GNU base-256 rejected. */
function parseTarSize(bytes: Uint8Array): number {
  if (bytes.length > 0 && (bytes[0] as number) & 0x80) {
    throw new TerraformModuleArchiveError("invalid tar stream: tar member uses a base-256 size");
  }
  const text = decodeUtf8(bytes).split("\0")[0]!.trim();
  if (text === "") return 0;
  const size = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TerraformModuleArchiveError("invalid tar stream: tar member size is malformed");
  }
  return size;
}

/** The pax `path` record (the only key the module grammar needs). */
function readPaxPath(record: Uint8Array): string | null {
  const text = decodeUtf8(record);
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space < 0) break;
    const length = Number.parseInt(text.slice(at, space), 10);
    if (!Number.isSafeInteger(length) || length <= space - at + 1) break;
    const field = text.slice(space + 1, at + length - 1); // strip the trailing \n
    const eq = field.indexOf("=");
    if (eq >= 0 && field.slice(0, eq) === "path") return field.slice(eq + 1);
    at += length;
  }
  return null;
}

/**
 * ParseModuleArchive (parser.go:46-125): gunzip the stream with the 32 MiB
 * total cap (ErrContentTooLarge past it), walk the tar, classify each
 * member, and assemble the Metadata. `ErrNoRootModule` when neither a root
 * source nor a submodule source exists.
 */
export async function parseTerraformModuleArchive(source: ReadableStream<Uint8Array>): Promise<TerraformModuleMetadata> {
  let tar: Uint8Array;
  try {
    tar = await readBoundedGzip(source, TERRAFORM_MODULE_MAX_METADATA_SIZE + 1);
  } catch (error) {
    if (error instanceof TerraformModuleContentTooLargeError) throw error;
    throw new TerraformModuleArchiveError(`invalid gzip stream: ${error instanceof Error ? error.message : "read failed"}`);
  }
  const metadata: TerraformModuleMetadata = {};
  const rootFiles = new Map<string, Uint8Array>();
  const submoduleFiles = new Map<string, Map<string, Uint8Array>>();
  const submoduleReadmes = new Map<string, string>();
  for (const entry of walkTar(tar)) {
    const cleaned = posixClean(entry.name);
    const splitAt = cleaned.lastIndexOf("/");
    const base = splitAt < 0 ? cleaned : cleaned.slice(splitAt + 1);
    const dir = splitAt < 0 ? "" : cleaned.slice(0, splitAt + 1);
    if (base.startsWith(".")) continue; // Terraform ignores dotfiles
    const isSource = base.endsWith(".tf") || base.endsWith(".tf.json");
    const isReadme = base.toLowerCase() === "readme.md" || base.toLowerCase() === "readme";
    const subMatch = /^modules\/([^/]+)$/.exec(dir.endsWith("/") ? dir.slice(0, -1) : dir);
    const isSubmodule = subMatch !== null;
    if ((!isSource && !isReadme) || (dir !== "" && !isSubmodule)) continue;
    if (isReadme && entry.size > TERRAFORM_MODULE_MAX_README_SIZE) continue;
    const data = tar.subarray(entry.dataOffset, entry.dataOffset + entry.size);
    if (isSubmodule && isSource) {
      const name = subMatch[1]!;
      const files = submoduleFiles.get(name) ?? new Map<string, Uint8Array>();
      files.set(base, data);
      submoduleFiles.set(name, files);
    } else if (isSubmodule) {
      submoduleReadmes.set(subMatch[1]!, decodeUtf8(data));
    } else if (isReadme) {
      metadata.readme = decodeUtf8(data);
    } else {
      rootFiles.set(base, data);
    }
  }
  if (rootFiles.size === 0 && submoduleFiles.size === 0) throw new TerraformModuleNoRootError();
  if (rootFiles.size > 0) {
    metadata.root = parseTerraformModuleBody(sortedNamedSources(rootFiles));
  }
  if (submoduleFiles.size > 0) {
    const submodules: Record<string, TerraformModuleSubmodule> = {};
    const names = [...submoduleFiles.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const submodule: TerraformModuleSubmodule = {
        module: parseTerraformModuleBody(sortedNamedSources(submoduleFiles.get(name)!)),
      };
      const readme = submoduleReadmes.get(name);
      if (readme !== undefined) submodule.readme = readme;
      submodules[name] = submodule;
    }
    metadata.submodules = submodules;
  }
  return metadata;
}

/** Go maps.Keys sorted + slices.Sorted — byte-wise name order. */
function sortedNamedSources(files: Map<string, Uint8Array>): NamedSource[] {
  const list: NamedSource[] = [];
  for (const [name, data] of files) {
    list.push({ nameBytes: new TextEncoder().encode(name), name, data });
  }
  list.sort((a, b) => compareBytes(a.nameBytes, b.nameBytes));
  return list;
}

/** Decompress gzip with a hard byte cap (the total-decompressed limit). */
async function readBoundedGzip(source: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> {
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = source.pipeThrough<Uint8Array>(new DecompressionStream("gzip"));
  } catch {
    throw new Error("unable to start the decompressor");
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    const chunk = read.value;
    total += chunk.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new TerraformModuleContentTooLargeError();
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The signed archive URL (base/tool.go:36-95)
// ---------------------------------------------------------------------------

/** The general token signing secret reader — container.ts's posture (the
 *  keystore row shared with the actions module; generate-once-save-back on
 *  a cold isolate; cached per isolate). container.ts keeps its own private
 *  copy (its header explains why loadKeystore's RSA cold path is avoided);
 *  this is the same reader re-implemented so the state package's neighbors
 *  stay untouched. */
let archiveSigningSecretCacheD1: D1Database | null = null;
let archiveSigningSecretCache: Promise<string> | null = null;

function loadArchiveSigningSecret(d1: D1Database): Promise<string> {
  if (archiveSigningSecretCacheD1 === d1 && archiveSigningSecretCache !== null) {
    return archiveSigningSecretCache;
  }
  const promise = (async (): Promise<string> => {
    const db = drizzle(d1);
    const readPiece = (value: string): string => {
      const parsed = JSON.parse(value) as { tokenSigningSecret?: unknown };
      if (typeof parsed.tokenSigningSecret === "string" && parsed.tokenSigningSecret !== "") {
        return parsed.tokenSigningSecret;
      }
      throw new Error("terraform-modules: keystore secret row is malformed");
    };
    const row = await db.select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_SECRET_ROW)).get();
    if (row !== undefined) return readPiece(row.value);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let secretHex = "";
    for (const b of bytes) secretHex += b.toString(16).padStart(2, "0");
    const now = new Date();
    await db
      .insert(systemKeystore)
      .values({ name: KEYSTORE_SECRET_ROW, value: JSON.stringify({ v: 1, tokenSigningSecret: secretHex }), createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    const winner = await db.select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_SECRET_ROW)).get();
    if (winner === undefined) {
      throw new Error("terraform-modules: keystore secret row missing after insert (D1 write failed?)");
    }
    return readPiece(winner.value);
  })();
  archiveSigningSecretCacheD1 = d1;
  archiveSigningSecretCache = promise;
  promise.catch(() => {
    if (archiveSigningSecretCacheD1 === d1) {
      archiveSigningSecretCacheD1 = null;
      archiveSigningSecretCache = null;
    }
  });
  return promise;
}

function importHmacSha1Key(secretUtf8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", secretUtf8, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
}

/** TEST-ONLY: drop the signing-secret cache (the container module's
 *  resetContainerTokenCacheForTests posture — simulates an isolate
 *  restart). Never call from a request path. */
export function resetTerraformModuleSigningCacheForTests(): void {
  archiveSigningSecretCacheD1 = null;
  archiveSigningSecretCache = null;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** `200601021504` in UTC (Go time.Local's engine pin — recorded). */
function formatStamp(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}${mo}${d}${h}${mi}`;
}

function parseStamp(stamp: string): Date | null {
  if (!/^\d{12}$/.test(stamp)) return null;
  const date = new Date(
    Date.UTC(
      Number.parseInt(stamp.slice(0, 4), 10),
      Number.parseInt(stamp.slice(4, 6), 10) - 1,
      Number.parseInt(stamp.slice(6, 8), 10),
      Number.parseInt(stamp.slice(8, 10), 10),
      Number.parseInt(stamp.slice(10, 12), 10),
    ),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

async function hmacSha1Hex(secret: string, message: string): Promise<string> {
  const key = await importHmacSha1Key(new TextEncoder().encode(secret));
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(new Uint8Array(mac));
}

/** archiveCodeData (terraform_module.go:66-68). */
export function terraformModuleArchiveCodeData(ownerId: number, name: string, version: string): string {
  return `terraform-module:${ownerId}:${name}:${version}`;
}

/**
 * CreateTimeLimitCode (tool.go:62-95): `startStr(12) + %06d(minutes) +
 * hex(HMAC-SHA1)` — 58 chars total (TimeLimitCodeLength = 12+6+40). The
 * HMAC key is the secret string's bytes; the message carries
 * `data + hex(secret) + startStr + endStr + minutes` (Go's Fprintf shape —
 * our stored secret is already hex, so the embedded hex matches it).
 */
export async function createTerraformArchiveTimeLimitCode(d1: D1Database, data: string, minutes: number, now: Date): Promise<string> {
  const secret = await loadArchiveSigningSecret(d1);
  const startStr = formatStamp(now);
  const endStr = formatStamp(new Date(now.getTime() + minutes * 60_000));
  const mac = await hmacSha1Hex(secret, `${data}${secret}${startStr}${endStr}${minutes}`);
  return `${startStr}${String(minutes).padStart(6, "0")}${mac}`;
}

/**
 * VerifyTimeLimitCode (tool.go:36-57): length > 18; re-derive from the
 * code's own embedded stamp+minutes; constant-time compare; then the
 * `start <= now < start + minutes` window.
 */
export async function verifyTerraformArchiveTimeLimitCode(
  d1: D1Database,
  now: Date,
  data: string,
  minutes: number,
  code: string | null | undefined,
): Promise<boolean> {
  if (code === null || code === undefined || code.length <= 18) return false;
  const startStr = code.slice(0, 12);
  const aliveTimeStr = code.slice(12, 18);
  const aliveTime = Number.parseInt(aliveTimeStr, 10); // junk → the derive compare fails
  if (!Number.isSafeInteger(aliveTime) || aliveTime < 0) return false;
  const secret = await loadArchiveSigningSecret(d1);
  const start = parseStamp(startStr);
  if (start === null) return false;
  const endStr = formatStamp(new Date(start.getTime() + aliveTime * 60_000));
  const retCode = `${startStr}${String(aliveTime).padStart(6, "0")}${await hmacSha1Hex(
    secret,
    `${data}${secret}${startStr}${endStr}${aliveTime}`,
  )}`;
  if (!constantTimeEquals(retCode, code)) return false;
  return (start.getTime() <= now.getTime()) && now.getTime() < start.getTime() + minutes * 60_000;
}

/** subtle.ConstantTimeCompare's fold — never short-circuits on content. */
function constantTimeEquals(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const len = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

/** HasValidArchiveSignature (terraform_module.go:78-81). */
export async function hasValidTerraformArchiveSignature(
  d1: D1Database,
  ownerId: number,
  name: string,
  version: string,
  code: string | null | undefined,
): Promise<boolean> {
  const data = terraformModuleArchiveCodeData(ownerId, name, version);
  return verifyTerraformArchiveTimeLimitCode(d1, new Date(), data, TERRAFORM_ARCHIVE_CODE_MINUTES, code);
}

// ---------------------------------------------------------------------------
// The registry walks (terraform_module.go's router, service-shaped)
// ---------------------------------------------------------------------------

/** The package name is `{name}/{provider}` (terraform_module.go:43-45). */
export function terraformModulePackageName(name: string, provider: string): string {
  return `${name}/${provider}`;
}

/** ListVersions (terraform_module.go:75-91 over GetVersionsByPackageName,
 *  package_version.go): the version strings, newest first (created DESC,
 *  id DESC — §5.7). Unpaged: the protocol envelope carries them all. */
export async function listTerraformModuleVersions(d1: D1Database, ownerId: number, name: string): Promise<string[]> {
  const rows = await drizzle(d1)
    .select({ version: packageVersions.version })
    .from(packageVersions)
    .innerJoin(packages, eq(packageVersions.packageId, packages.id))
    .where(
      and(
        eq(packages.ownerId, ownerId),
        eq(packages.type, TERRAFORM_MODULE_PACKAGE_TYPE),
        eq(packages.lowerName, name.toLowerCase()),
        eq(packageVersions.isInternal, false),
      ),
    )
    .orderBy(desc(packageVersions.createdUnix), desc(packageVersions.id))
    .all();
  return rows.map((row) => row.version);
}

export type OpenTerraformModuleArchive =
  | { kind: "ok"; stream: ReadableStream; size: number; file: PackageFileRow; blob: PackageBlobRow }
  | { kind: "version-missing" }
  | { kind: "file-missing" };

/**
 * DownloadArchive's service half (terraform_module.go:118-130 over
 * packages_service.OpenFileForDownloadByPackageNameAndVersion): resolve
 * version + the lead `module.tar.gz` + its blob + the R2 object; GET bumps
 * the download counter (packages.go:668's GET-only seam). Null = the 404
 * arm (missing package/version/file/object).
 */
export async function openTerraformModuleArchiveForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  name: string,
  version: string,
  method: string,
): Promise<OpenTerraformModuleArchive> {
  const pkg = await getPackageByName(d1, owner.id, TERRAFORM_MODULE_PACKAGE_TYPE, name);
  if (pkg === null) return { kind: "version-missing" };
  const versionRow = await getVersionByNameAndVersion(d1, owner.id, TERRAFORM_MODULE_PACKAGE_TYPE, name, version);
  if (versionRow === null) return { kind: "version-missing" };
  const file = await getFileForVersionByName(d1, versionRow.id, TERRAFORM_MODULE_ARCHIVE_FILENAME);
  if (file === null) return { kind: "file-missing" };
  const blob = await getBlobById(d1, file.blobId);
  if (blob === null) return { kind: "file-missing" };
  const object = await bucket.get(packageBlobContentKey(blob.hashSha256));
  if (object === null) return { kind: "file-missing" };
  if (method === "GET") {
    await incrementDownloadCounter(d1, versionRow.id);
  }
  return { kind: "ok", stream: object.body, size: object.size, file, blob };
}

export interface UploadTerraformModuleInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  /** The module name segment (validated separately from the provider). */
  name: string;
  provider: string;
  /** The RAW version path segment; normalized here (parser.go:39-44). */
  version: string;
  content: ReadableStream<Uint8Array>;
  declaredLength: number | undefined;
  quota: PackagesQuotaConfig;
  /** The webhook seam — the created arm fires when the version row is new. */
  webhookEnv?: PackageEventEnv;
  now?: Date;
  maxBytes?: number;
}

export interface UploadTerraformModuleResult {
  pkg: { id: number; name: string };
  version: PackageVersionRow;
  metadata: TerraformModuleMetadata;
  created: boolean;
}

/**
 * UploadModule's service half (terraform_module.go:109-176 over
 * CreatePackageAndAddFile): spool verbatim → ParseModuleArchive → the
 * quota gates → package(`{name}/{provider}`, semverCompatible=true) +
 * version(canonical semver, metadata on the created arm only) + the lead
 * `module.tar.gz` blob → the created webhook. Duplicate versions throw
 * DuplicatePackageVersionError (the route's 409); quota errors throw the
 * model's classes (the route's 403); parse failures throw the archive
 * errors (400 / 413).
 */
export async function uploadTerraformModule(input: UploadTerraformModuleInput): Promise<UploadTerraformModuleResult> {
  const now = input.now ?? new Date();
  const packageName = terraformModulePackageName(input.name, input.provider);
  const version = normalizeTerraformModuleVersion(input.version);

  // The count quota precedes the spool (helm's order — upstream checks
  // inside the transaction; the pre-insert equivalent is count + 1 > limit).
  if (!input.doer.isAdmin && input.quota.limitTotalOwnerCount > UNLIMITED_QUOTA) {
    const total = (await countVersions(input.d1, input.owner.id)) + 1;
    if (total > input.quota.limitTotalOwnerCount) throw new QuotaTotalCountError();
  }

  // PASS 1 — spool the archive verbatim (the store owns the 413 cap).
  const spooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: input.maxBytes,
  });

  try {
    // PASS 2 — parse the metadata from the spool (32 MiB decompressed cap).
    const spoolObject = await input.bucket.get(spooled.spoolKey);
    if (spoolObject === null) throw new Error("package spool object vanished");
    const metadata = await parseTerraformModuleArchive(spoolObject.body as ReadableStream<Uint8Array>);

    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, TERRAFORM_MODULE_PACKAGE_TYPE, spooled.size, input.quota);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: TERRAFORM_MODULE_PACKAGE_TYPE,
      name: packageName,
      // SemverCompatible: true (terraform_module.go:150).
      semverCompatible: true,
      now,
    });
    const { row: versionRow, created: versionCreated } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version,
      now,
    });
    if (!versionCreated) {
      // Immutable: the duplicate-version arm (ErrDuplicatePackageVersion →
      // the route's 409) BEFORE any blob/file write (upstream's
      // createPackageAndVersion !created && !allowDuplicate arm).
      throw new DuplicatePackageVersionError(versionRow);
    }
    await writeVersionMetadata(input.d1, versionRow.id, JSON.stringify(metadata));

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
    } else {
      await input.bucket.delete(spooled.spoolKey);
    }
    const fileResult = await tryInsertFile(input.d1, {
      versionId: versionRow.id,
      blobId: blob.id,
      name: TERRAFORM_MODULE_ARCHIVE_FILENAME,
      isLead: true,
      now,
    });
    if (fileResult.outcome === "conflict") {
      // The file UNIQUE lost a race it cannot lose in practice (the version
      // row was created inside this walk) — upstream's globallock posture.
      throw new Error("package file insert raced its own fresh version");
    }

    // The created arm (packages.go:131) — the duplicate arm threw above, so
    // versionCreated holds; the seam never throws (helm's posture).
    if (input.webhookEnv !== undefined) {
      await emitPackageCreated(input.webhookEnv, { pkg, version: versionRow }, input.doer.id);
    }
    return { pkg, version: versionRow, metadata, created: true };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

/**
 * DeleteModule's service half (terraform_module.go:178-187 over
 * RemovePackageVersionByNameAndVersion): resolve the version (miss → null,
 * the route's 404), cascade it (modules have NO OnBeforeRemove guard).
 * The caller resolves the event descriptor BEFORE the cascade and emits
 * the deleted webhook (the generic family's notify-before-hook shape —
 * upstream packages.go:537's notify rides inside RemovePackageVersion).
 */
export async function deleteTerraformModuleVersion(
  d1: D1Database,
  ownerId: number,
  name: string,
  version: string,
): Promise<boolean> {
  const versionRow = await getVersionByNameAndVersion(d1, ownerId, TERRAFORM_MODULE_PACKAGE_TYPE, name, version);
  if (versionRow === null) return false;
  await deletePackageVersionAndReferences(d1, versionRow.id);
  return true;
}

/**
 * Archive service (SPEC-0004 §2.4 row repoGetArchive): server-side tar.gz /
 * zip of a ref, built Worker-side over the engine's public read RPCs
 * (listTree walk + readBlob per entry) and STREAMED to the client — pull-based
 * chunk generation, so no request body or archive is ever buffered whole and
 * the Workers wall-clock/CPU posture of AGENTS.md holds (waiting on the DO RPC
 * is free; only the byte-formatting counts as CPU).
 *
 * The engine's vendored snapshot builders (packages/git-engine
 * src/git/snapshot.ts tarGz/zip) are NOT on the dist-types export surface
 * (mod.d.ts), so this module re-derives the same ustar/zip formats. Upstream
 * behavior (routers/api/v1/repo/file.go GetArchive →
 * services/repository/archiver serveRepoArchive → modules/git/archive.go —
 * a real `git archive` run):
 *   - `{archive}` = `REF.tar.gz` | `REF.zip` (`REF.bundle` is the third
 *     upstream format — a git bundle needs pack surgery the API surface does
 *     not carry; parsed but refused with the unknown-format 400, documented);
 *   - the ref resolves branch → tag → 40-hex oid; an unresolvable ref is the
 *     upstream `unrecognized repository reference` 404 (an empty repo has no
 *     refs and lands there too — GetCommit fails the same way);
 *   - entries carry the LOWERCASED REPO NAME prefix (PrefixArchiveFiles
 *     default true — archive.go --prefix=<repo>/), full paths from the tree
 *     root, submodules skipped (upstream TODO: "add submodule data to zip");
 *   - `path` query subpaths filter the walk (git archive pathspec semantics:
 *     exact match or a descendant; the surviving entries keep full paths);
 *   - response headers: the Nix immutable-rev Link header, an attachment
 *     Content-Disposition naming `<slug>-<ref with slashes as dashes>.<ext>`.
 *
 * .gitattributes export rules (parity-review-git D3 §7.3): upstream archives
 * are real `git archive` output, which honors export-ignore/export-subst read
 * from the ARCHIVED TREE ONLY (no worktree/info/global attribute sources
 * without git archive's --worktree-attributes). Honored here at the entry
 * level, before any byte streams:
 *   - a directory's `.gitattributes` is parsed when the walk enters it (one
 *     extra readBlob per directory that carries one); deeper files take
 *     precedence over shallower ones, and within one file the LAST matching
 *     line wins (gitattributes(5));
 *   - patterns follow gitignore(5) matching: a pattern containing a slash
 *     (leading or middle) is anchored to its .gitattributes directory, a
 *     pattern without one matches the BASENAME at any depth; a trailing
 *     slash makes it directory-only; a matching DIRECTORY prunes its whole
 *     subtree. Outside the honored subset (documented): `[...]` character
 *     classes, brace expansion and escaped wildcards;
 *   - `!pattern` negative-pattern lines are SKIPPED (git 2.43 warns "negative
 *     patterns are ignored in git attributes" and does the same);
 *     `-export-ignore` is the re-include arm — a deeper file's unset beats a
 *     shallower set, so `/tests export-ignore` + `lib/.gitattributes`
 *     `keep.go -export-ignore` archives lib/keep.go;
 *   - attribute exclusion applies REGARDLESS of `path` subpaths (verified
 *     against git 2.43: `git archive HEAD <ignored path>` answers an empty
 *     archive — a pathspec cannot resurrect an export-ignored path);
 *   - export-subst is PARSED but intentionally NOT substituted. Upstream
 *     expands `$Format:…$` through git's full pretty-format machinery —
 *     verified against git 2.43.0, every log placeholder expands (even %h
 *     abbreviation, %d decorations, multi-line formats; a `$Format:` without
 *     its closing `$` even steals the next `$` in the file). Faithfulness
 *     there is engine-deep (%h/%p need object-graph abbreviation, %d/%D need
 *     ref decorations, %aN/%aE need mailmap), and a partial substitution is a
 *     state git never produces — so blobs stream byte-identical to the
 *     committed content and `$Format:…$` literals survive verbatim. The
 *     disposition is pinned in archive.test.ts; moving it engine-side is the
 *     recorded future arm.
 *
 * zip entries DEFLATE (method 8, raw deflate via CompressionStream):
 * `git archive --format=zip` deflates at the zlib default level (archive-zip.c
 * writes method 8 for every non-empty entry), so the former STORE posture
 * (SPEC-0004's CPU-for-bytes trade) is superseded by the parity review §7.4 —
 * method 8 + honest compressed/uncompressed sizes, content byte-identical
 * after inflate.
 *
 * SPEC-0004 §3.4 cache note: engine reads key Cache API entries by
 * `repositories.refs_version`; this walk reads through the DO live (the
 * archive bytes are immutable for a fixed commit oid, so the streaming
 * response carries upstream's weak-ETag semantics implicitly — the ETag
 * family lands with the shared cache layer, not per-route).
 *
 * Bounds (the API-side budget SPEC-0004 §2.4 calls out): entry/dir caps on
 * the walk, and a total-bytes cap enforced WHILE streaming — a repository
 * over the cap streams a truncated archive (the HTTP contract of a streaming
 * response; the failure is the client's incomplete-download error, headers
 * cannot change once the body started).
 */

import type { EngineReads } from "./engine";
import { branchRef, refTipMap, tagRef } from "./engine";
import { ApiError } from "../errors";

/** One file to archive: full tree path + entry metadata (blob bytes stream later). */
export interface ArchiveEntry {
  path: string;
  oid: string;
  /** engine mode string: "100644" | "100755" | "120000" (symlink) */
  mode: string;
}

export type ArchiveFormat = "tar.gz" | "zip" | "bundle";

/**
 * `SplitArchiveNameType` (models/repo/archiver.go:52) — the suffix decides
 * the format and the remainder is the ref. Unknown → null (the route's
 * upstream 400 "unknown format: …"). `.bundle` parses as upstream's third
 * type but is refused at the route (documented divergence).
 */
export function parseArchiveName(archive: string): { ref: string; format: ArchiveFormat } | null {
  if (archive.endsWith(".zip")) return { ref: archive.slice(0, -4), format: "zip" };
  if (archive.endsWith(".tar.gz")) return { ref: archive.slice(0, -7), format: "tar.gz" };
  if (archive.endsWith(".bundle")) return { ref: archive.slice(0, -7), format: "bundle" };
  return null;
}

/** Walk caps (see module doc). */
export const MAX_ARCHIVE_FILES = 20_000;
export const MAX_ARCHIVE_DIRS = 2_000;
/** Streaming total-bytes cap — oversized archives truncate mid-stream. */
export const MAX_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Strict ref resolution for the archive tail — branch, tag (peeled to the
 * commit, like upstream GetCommit through an annotated tag), then a 40-hex
 * oid. NO default-branch fallback: upstream GetCommit(refFromName) fails on
 * an unresolvable name; the default branch is never implicit here. Null =
 * the route's upstream `unrecognized repository reference` 404. Shared by
 * the API route and the wave-32 web archive download (the route's former
 * private copy converged onto this export at 889b74a — byte-identical, no
 * drift).
 */
export function resolveArchiveRef(tips: ReturnType<typeof refTipMap>, ref: string): string | null {
  const branch = tips.get(branchRef(ref));
  if (branch !== undefined) return branch.target;
  const tag = tips.get(tagRef(ref));
  if (tag !== undefined) return tag.peeled ?? tag.target;
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  return null;
}

// ---------------------------------------------------------------------------
// .gitattributes export rules (export-ignore honored; export-subst parsed)
// ---------------------------------------------------------------------------

const TD = new TextDecoder();

/**
 * One parsed .gitattributes line that assigns one of the archive-relevant
 * attributes. Lines assigning neither export-ignore nor export-subst are
 * dropped at parse time (they cannot affect the archive). Assignment values
 * follow gitattributes(5): `attr` = true, `-attr` = false (unset), `!attr` =
 * null (explicitly unspecified), `attr=value` = undefined (neither TRUE nor
 * UNSET — the archive check is git's ATTR_TRUE, so value forms never match).
 */
export interface GitattributesRule {
  re: RegExp;
  /** pattern ended with `/` — matches directories only */
  dirOnly: boolean;
  /** pattern had no slash — matched against the basename at any depth */
  basenameOnly: boolean;
  exportIgnore?: boolean | null;
  exportSubst?: boolean | null;
}

/**
 * gitignore(5) matching for one rule: anchored patterns match the whole
 * repo-root-relative path; basename patterns match at any depth; dirOnly
 * rules never match a file entry. Directory matches prune the subtree at the
 * walk site (upstream: "patterns that match a directory do not recursively
 * match paths inside that directory" — the prune is what archives get).
 */
export function ruleMatches(rule: GitattributesRule, path: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false;
  if (rule.basenameOnly) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return rule.re.test(base);
  }
  return rule.re.test(path);
}

/**
 * The LAST matching export-ignore assignment in rule order wins; rule order
 * is root→leaf files with each file's lines in order, which reproduces
 * gitattributes(5)'s precedence (deeper file beats shallower, later line
 * beats earlier). No matching assignment → unspecified → include.
 */
function exportIgnoreExcluded(rules: GitattributesRule[], path: string, isDir: boolean): boolean {
  let value: boolean | null | undefined;
  for (const rule of rules) {
    if (rule.exportIgnore === undefined) continue;
    if (ruleMatches(rule, path, isDir)) value = rule.exportIgnore;
  }
  return value === true;
}

/** One unanchored segment: `*`/`?` never cross `/` (gitignore wildmatch). */
function compileSegment(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

function compilePattern(pattern: string, dirOnly: boolean, basenameOnly: boolean): GitattributesRule {
  let source: string;
  if (basenameOnly) {
    source = `^${compileSegment(pattern)}$`;
  } else {
    // `**` as a whole segment crosses directories; `**/` also matches zero of
    // them (gitignore wildmatch). Leading `**/x` → x at any depth; `x/**`
    // matches everything below x but not x itself.
    source = "^";
    const segments = pattern.split("/");
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string;
      const last = i === segments.length - 1;
      if (segment === "**") {
        source += last ? ".*" : "(?:.*/)?";
        continue;
      }
      source += compileSegment(segment);
      if (!last) source += "/";
    }
    source += "$";
  }
  return { re: new RegExp(source, "u"), dirOnly, basenameOnly };
}

/**
 * Field split with gitattributes' backslash escapes (`foo\ bar` is one field
 * whose space is literal); the backslash itself is dropped from the field.
 */
function splitAttrFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current !== "") {
        fields.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (current !== "") fields.push(current);
  return fields;
}

/** `name` → true; `-name` → false; `!name` → null; `name=value` → undefined. */
function attrAssignment(token: string): { name: string; value: boolean | null | undefined } | null {
  if (token.startsWith("-")) return { name: token.slice(1), value: false };
  if (token.startsWith("!")) return { name: token.slice(1), value: null };
  const eq = token.indexOf("=");
  if (eq >= 0) return { name: token.slice(0, eq), value: undefined };
  return { name: token, value: true };
}

/**
 * Parse one .gitattributes blob's text as found at tree directory `dir`
 * ("" for the root). gitattributes(5) line grammar with the archive subset:
 * comments (`#`), blank lines, `[attr]` macro lines and `!pattern`
 * negative-pattern lines are skipped (git 2.43 ignores the latter with a
 * warning); the remaining lines compile one pattern each. Patterns anchor to
 * `dir` when they contain a slash, otherwise match basenames at any depth.
 */
export function parseGitattributes(text: string, dir: string): GitattributesRule[] {
  const rules: GitattributesRule[] = [];
  const dirPrefix = dir === "" ? "" : `${dir}/`;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "" || line.startsWith("#") || line.startsWith("!") || line.startsWith("[attr]")) continue;
    const fields = splitAttrFields(line);
    const pattern = fields[0];
    if (pattern === undefined) continue;
    let dirOnly = false;
    let body = pattern;
    if (body.endsWith("/")) {
      dirOnly = true;
      body = body.slice(0, -1);
    }
    const basenameOnly = !body.includes("/");
    if (body.startsWith("/")) body = body.slice(1);
    if (body === "") continue;
    let compiled: GitattributesRule;
    try {
      compiled = compilePattern(basenameOnly ? body : dirPrefix + body, dirOnly, basenameOnly);
    } catch {
      continue; // an uncompilable pattern matches nothing, like git's skip
    }
    const rule: GitattributesRule = { re: compiled.re, dirOnly: compiled.dirOnly, basenameOnly: compiled.basenameOnly };
    for (const token of fields.slice(1)) {
      const assignment = attrAssignment(token);
      if (assignment === null) continue;
      if (assignment.name === "export-ignore" && rule.exportIgnore === undefined) rule.exportIgnore = assignment.value;
      if (assignment.name === "export-subst" && rule.exportSubst === undefined) rule.exportSubst = assignment.value;
    }
    if (rule.exportIgnore !== undefined || rule.exportSubst !== undefined) rules.push(rule);
  }
  return rules;
}

/**
 * Bounded depth-first flatten of the ref's tree through per-level listTree
 * RPCs (collectTreeRecursive's interim pattern, with archive-scale budgets).
 * Gitlink (submodule) entries are skipped; symlinks carry their mode. Paths
 * not matching any subPath pathspec are pruned before recursion, and
 * .gitattributes export-ignore rules collected along the walked chain exclude
 * entries before they reach the archive (see the module doc): a directory
 * match prunes its whole subtree, and exclusion holds regardless of the
 * pathspec — a `path` subpath cannot resurrect an export-ignored path, like
 * git archive.
 */
export async function collectArchiveEntries(
  reads: EngineReads,
  refTarget: string,
  subPaths: string[],
): Promise<ArchiveEntry[]> {
  const out: ArchiveEntry[] = [];
  let dirs = 0;
  const matches = (path: string): boolean =>
    subPaths.length === 0 || subPaths.some((p) => path === p || path.startsWith(`${p}/`) || p.startsWith(`${path}/`));
  const walk = async (prefix: string, inherited: GitattributesRule[]): Promise<void> => {
    const tree = await reads.listTree(refTarget, prefix);
    if (tree === null) return;
    const rules = [...inherited];
    const attrEntry = tree.entries.find((e) => e.name === ".gitattributes" && e.type === "blob");
    if (attrEntry !== undefined) {
      const blob = await reads.readBlob(refTarget, prefix === "" ? ".gitattributes" : `${prefix}/.gitattributes`);
      if (blob !== null) rules.push(...parseGitattributes(TD.decode(blob.data), prefix));
    }
    for (const entry of tree.entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (!matches(path)) continue;
      if (entry.type === "tree") {
        if (exportIgnoreExcluded(rules, path, true)) continue;
        dirs += 1;
        if (dirs > MAX_ARCHIVE_DIRS) {
          throw new ApiError(422, "repository tree exceeds the archive walk budget");
        }
        await walk(path, rules);
      } else if (entry.type === "blob") {
        if (exportIgnoreExcluded(rules, path, false)) continue;
        if (out.length >= MAX_ARCHIVE_FILES) {
          throw new ApiError(422, "repository tree exceeds the archive walk budget");
        }
        out.push({ path, oid: entry.oid, mode: entry.mode });
      }
      // type "commit" (submodule): skipped, like upstream git archive
    }
  };
  await walk("", []);
  return out;
}

// ---------------------------------------------------------------------------
// ustar + zip byte builders (the streaming chunk emitters)
// ---------------------------------------------------------------------------

const TE = new TextEncoder();

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function octalField(value: number, width: number): Uint8Array {
  return TE.encode(`${value.toString(8).padStart(width - 1, "0")}\0`);
}

/** One 512-byte ustar header (ustar\0 00 magic; checksum over the raw field bytes). */
function tarHeader(path: string, mode: string, size: number, mtime: number, typeflag: string, linkname: string): Uint8Array {
  const h = new Uint8Array(512);
  let name = path;
  let ustarPrefix = "";
  if (TE.encode(name).byteLength > 100) {
    // ustar prefix split at the last slash that keeps both halves in budget
    let idx = path.lastIndexOf("/");
    while (idx > 0 && TE.encode(path.slice(0, idx)).byteLength > 155) {
      idx = path.lastIndexOf("/", idx - 1);
    }
    if (idx > 0) {
      ustarPrefix = path.slice(0, idx);
      name = path.slice(idx + 1);
    }
    if (TE.encode(name).byteLength > 100) {
      throw new ApiError(422, `archive path too long: ${path}`);
    }
  }
  h.set(TE.encode(name).subarray(0, 100), 0);
  const modeValue = mode === "120000" ? 0o777 : mode === "100755" ? 0o755 : mode === "100644" ? 0o644 : 0o644;
  h.set(octalField(modeValue, 8), 100);
  h.set(octalField(0, 8), 108); // uid
  h.set(octalField(0, 8), 116); // gid
  h.set(octalField(size, 12), 124);
  h.set(octalField(mtime, 12), 136);
  h.set(TE.encode("        "), 148); // checksum placeholder (spaces)
  h.set(TE.encode(typeflag), 156);
  h.set(TE.encode(linkname).subarray(0, 100), 157);
  h.set(TE.encode("ustar\0"), 257);
  h.set(TE.encode("00"), 263);
  h.set(TE.encode("root").subarray(0, 32), 265);
  h.set(TE.encode("root").subarray(0, 32), 297);
  h.set(TE.encode(ustarPrefix).subarray(0, 155), 345);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i] ?? 0;
  h.set(TE.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return h;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.byteLength; i++) {
    const slot = CRC_TABLE[(c ^ (data[i] ?? 0)) & 0xff] ?? 0;
    c = (slot ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(unixSecs: number): { time: number; date: number } {
  const d = new Date(unixSecs * 1000);
  const date = (((d.getUTCFullYear() - 1980) & 0x7f) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return { time, date };
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}
function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

/** Pull-driven ReadableStream over an async generator (no detached promises —
 *  the consumer's pull schedules every DO read and byte emit). */
function readableFromChunks(chunks: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel() {
      void iterator.return?.(undefined);
    },
  });
}

interface ArchiveStreamOptions {
  prefix: string;
  entries: ArchiveEntry[];
  reads: EngineReads;
  refTarget: string;
  /** commit committer time (unix secs) — every entry's mtime */
  mtime: number;
}

/**
 * The ustar chunk stream: per entry `header + data + padding`, then the
 * two-block end-of-archive marker. Symlinks serialize as typeflag "2" with
 * the target as the link name (empty data), like git archive. Budget
 * violations throw inside the generator — the response stream errors and the
 * client sees the truncation.
 */
async function* tarChunks(options: ArchiveStreamOptions): AsyncGenerator<Uint8Array> {
  const { prefix, entries, reads, refTarget, mtime } = options;
  let total = 0;
  for (const entry of entries) {
    const blob = await reads.readBlob(refTarget, entry.path);
    if (blob === null) continue; // raced with a push — skip, like git archive's missing-object tolerance
    const symlink = entry.mode === "120000";
    const target = symlink ? new TextDecoder().decode(blob.data) : "";
    const size = symlink ? 0 : blob.data.byteLength;
    yield tarHeader(`${prefix}/${entry.path}`, entry.mode, size, mtime, symlink ? "2" : "0", target);
    if (!symlink && blob.data.byteLength > 0) {
      total += blob.data.byteLength;
      if (total > MAX_ARCHIVE_TOTAL_BYTES) {
        throw new Error("archive exceeds the total size budget");
      }
      yield blob.data;
      const pad = (512 - (blob.data.byteLength % 512)) % 512;
      if (pad > 0) yield new Uint8Array(pad);
    }
  }
  yield new Uint8Array(1024); // end-of-archive
}

/** Raw DEFLATE (no zlib wrapper — zip method 8's stream form) of one blob. */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The zip chunk stream with DEFLATE entries (method 8 — `git archive
 * --format=zip` deflates every entry at the zlib default level, archive-zip.c;
 * the former STORE posture is superseded per parity-review-git §7.4). Each
 * entry's bytes compress whole (the blob is already fully read) so the local
 * header carries the real CRC-32 of the UNCOMPRESSED data plus honest
 * compressed/uncompressed sizes — no data-descriptor flag. The size budget
 * still counts uncompressed bytes (the cap bounds content, not the codec).
 * Local parts stream per entry; the central directory (small: 46 bytes + name
 * each) accumulates and precedes the EOCD at close.
 */
async function* zipChunks(options: ArchiveStreamOptions): AsyncGenerator<Uint8Array> {
  const { prefix, entries, reads, refTarget, mtime } = options;
  const { time, date } = dosDateTime(mtime);
  const central: Uint8Array[] = [];
  let offset = 0;
  let total = 0;
  for (const entry of entries) {
    const blob = await reads.readBlob(refTarget, entry.path);
    if (blob === null) continue;
    const name = TE.encode(`${prefix}/${entry.path}`);
    const crc = crc32(blob.data);
    const size = blob.data.byteLength;
    total += size;
    if (total > MAX_ARCHIVE_TOTAL_BYTES) {
      throw new Error("archive exceeds the total size budget");
    }
    const stored = await deflateRaw(blob.data);
    const externalAttrs = (((entry.mode === "120000" ? 0o120777 : 0o100000 | (entry.mode === "100755" ? 0o755 : 0o644)) << 16) >>> 0);

    const local = new Uint8Array(30 + name.byteLength);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, 20);
    u16(lv, 6, 0); // flags
    u16(lv, 8, 8); // method DEFLATE (raw)
    u16(lv, 10, time);
    u16(lv, 12, date);
    u32(lv, 14, crc);
    u32(lv, 18, stored.byteLength); // compressed
    u32(lv, 22, size);
    u16(lv, 26, name.byteLength);
    local.set(name, 30);
    yield local;
    if (stored.byteLength > 0) yield stored;

    const cd = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(cd.buffer);
    u32(cv, 0, 0x02014b50);
    u16(cv, 4, (3 << 8) | 20); // made by unix
    u16(cv, 6, 20);
    u16(cv, 8, 0); // flags
    u16(cv, 10, 8); // method DEFLATE (raw)
    u16(cv, 12, time);
    u16(cv, 14, date);
    u32(cv, 16, crc);
    u32(cv, 20, stored.byteLength);
    u32(cv, 24, size);
    u16(cv, 28, name.byteLength);
    u32(cv, 38, externalAttrs);
    u32(cv, 42, offset);
    cd.set(name, 46);
    central.push(cd);
    offset += local.byteLength + stored.byteLength;
  }

  const cdStart = offset;
  const cdBytes = concatBytes(central);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 8, central.length);
  u16(ev, 10, central.length);
  u32(ev, 12, cdBytes.byteLength);
  u32(ev, 16, cdStart);
  if (cdBytes.byteLength > 0) yield cdBytes;
  yield eocd;
}

export interface ArchiveStream {
  body: ReadableStream<Uint8Array>;
  /** filename for the Content-Disposition attachment header */
  downloadName: string;
}

/**
 * Collect + build in one call. The entry walk completes before the response
 * starts (so tree-budget failures map to declared ApiErrors, not a broken
 * stream); the blob reads stream pull-driven afterwards.
 */
export async function buildArchive(
  reads: EngineReads,
  refTarget: string,
  format: ArchiveFormat,
  repoSlug: string,
  ref: string,
  mtime: number,
  subPaths: string[],
): Promise<ArchiveStream> {
  const entries = await collectArchiveEntries(reads, refTarget, subPaths);
  if (format === "bundle") {
    throw new ApiError(400, "bundle archives are not supported");
  }
  const prefix = repoSlug.toLowerCase();
  const downloadName = `${repoSlug}-${ref.replaceAll("/", "-")}.${format}`;
  const options: ArchiveStreamOptions = { prefix, entries, reads, refTarget, mtime };
  const body =
    format === "tar.gz"
      ? readableFromChunks(tarChunks(options)).pipeThrough(new CompressionStream("gzip"))
      : readableFromChunks(zipChunks(options));
  return { body, downloadName };
}

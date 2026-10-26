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
 * (mod.d.ts), so this module re-derives the same ustar/STORE formats. Upstream
 * behavior (routers/api/v1/repo/file.go GetArchive →
 * services/repository/archiver serveRepoArchive → modules/git/archive.go):
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
 * the API route and the wave-32 web archive download (the routes/archive.ts
 * private copy predates this export — a convergence TODO, not a second
 * semantic).
 */
export function resolveArchiveRef(tips: ReturnType<typeof refTipMap>, ref: string): string | null {
  const branch = tips.get(branchRef(ref));
  if (branch !== undefined) return branch.target;
  const tag = tips.get(tagRef(ref));
  if (tag !== undefined) return tag.peeled ?? tag.target;
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  return null;
}

/**
 * Bounded depth-first flatten of the ref's tree through per-level listTree
 * RPCs (collectTreeRecursive's interim pattern, with archive-scale budgets).
 * Gitlink (submodule) entries are skipped; symlinks carry their mode. Paths
 * not matching any subPath pathspec are pruned before recursion.
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
  const walk = async (prefix: string): Promise<void> => {
    const tree = await reads.listTree(refTarget, prefix);
    if (tree === null) return;
    for (const entry of tree.entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (!matches(path)) continue;
      if (entry.type === "tree") {
        dirs += 1;
        if (dirs > MAX_ARCHIVE_DIRS) {
          throw new ApiError(422, "repository tree exceeds the archive walk budget");
        }
        await walk(path);
      } else if (entry.type === "blob") {
        if (out.length >= MAX_ARCHIVE_FILES) {
          throw new ApiError(422, "repository tree exceeds the archive walk budget");
        }
        out.push({ path, oid: entry.oid, mode: entry.mode });
      }
      // type "commit" (submodule): skipped, like upstream git archive
    }
  };
  await walk("");
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

/**
 * The zip chunk stream with STORE entries (method 0 — valid zip, no deflate
 * on the request path; the engine's own builder compresses, this one trades
 * bytes for CPU, a documented SPEC-0004 posture). Local parts stream per
 * entry; the central directory (small: 46 bytes + name each) accumulates and
 * precedes the EOCD at close.
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
    const externalAttrs = (((entry.mode === "120000" ? 0o120777 : 0o100000 | (entry.mode === "100755" ? 0o755 : 0o644)) << 16) >>> 0);

    const local = new Uint8Array(30 + name.byteLength);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, 20);
    u16(lv, 6, 0); // flags
    u16(lv, 8, 0); // method STORE
    u16(lv, 10, time);
    u16(lv, 12, date);
    u32(lv, 14, crc);
    u32(lv, 18, size); // compressed
    u32(lv, 22, size);
    u16(lv, 26, name.byteLength);
    local.set(name, 30);
    yield local;
    if (size > 0) yield blob.data;

    const cd = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(cd.buffer);
    u32(cv, 0, 0x02014b50);
    u16(cv, 4, (3 << 8) | 20); // made by unix
    u16(cv, 6, 20);
    u16(cv, 8, 0); // flags
    u16(cv, 10, 0); // method STORE
    u16(cv, 12, time);
    u16(cv, 14, date);
    u32(cv, 16, crc);
    u32(cv, 20, size);
    u32(cv, 24, size);
    u16(cv, 28, name.byteLength);
    u32(cv, 38, externalAttrs);
    u32(cv, 42, offset);
    cd.set(name, 46);
    central.push(cd);
    offset += local.byteLength + size;
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

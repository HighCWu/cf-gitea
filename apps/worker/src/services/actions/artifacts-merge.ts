/**
 * The artifact chunk merge (SPEC-0012 §2.4-2.5/§4.2, M1b) — the streaming
 * replacement for upstream's in-process MultiReader over storage objects
 * (artifacts_chunks.go:309-399).
 *
 * R2 has no server-side concatenation (the SPEC-0001a workerd#1349 gap), so
 * the merge feeds ordered chunk bodies into ONE R2 multipart upload,
 * coalescing small chunks into ≥5 MiB parts (R2's non-final part floor).
 * CPU stays near zero; wall time is R2 throughput — free under the
 * unbounded-HTTP-wall rule. Memory is bounded at one part buffer (8 MiB)
 * plus one chunk.
 *
 * Completeness + order checks are the CALLER's (they read the D1 row
 * bookkeeping, not the bytes): planOrderedChunks verifies ordering exactly
 * upstream's mergeChunksForArtifact (repeated chunks dropped, a missing
 * middle chunk → not complete → null, last-end ≠ compressed size → null).
 */

import { v3Dir, v4Dir } from "./artifacts";

/** The ordered byte ranges to concatenate. */
export interface ByteSource {
  start: number;
  end: number;
  get(): Promise<Uint8Array>;
}

/**
 * mergeChunksForArtifact (artifacts_chunks.go:311-399) minus the byte
 * streaming: returns the completed ordered ranges, or null when the chunks
 * are not complete (an empty storage path upstream — nothing merges).
 */
export function planOrderedChunks(chunks: Array<{ start: number; end: number }>, fileCompressedSize: number): Array<{ start: number; end: number }> | null {
  const sorted = [...chunks].sort((a, b) => a.start - b.start);
  const allChunks: Array<{ start: number; end: number }> = [];
  let startAt = -1;
  for (const c of sorted) {
    // startAt is -1 → first chunk; c.start === startAt + 1 → in order.
    // Anything else is a repeat (dropped) or a missing middle (gap).
    if (c.start === startAt + 1) {
      allChunks.push(c);
      startAt = c.end;
    }
  }
  // The last chunk's end + 1 must equal the compressed size — else the
  // upload is incomplete and nothing merges (an empty path upstream).
  if (startAt + 1 !== fileCompressedSize) {
    return null;
  }
  return allChunks;
}

/**
 * Stream the ordered sources into one R2 object at `key` (an R2 multipart
 * upload, 8 MiB parts), verifying the optional "sha256:<hex>" checksum.
 * WebCrypto has no streaming digest, so checksummed merges accumulate the
 * parts (the finalize size field bounds them; OQ-3's run cap is the
 * long-term bound) while the non-checksummed path stays streaming.
 * Returns the written byte count.
 */
export async function writeMergedArtifact(
  env: Env,
  key: string,
  sources: ByteSource[],
  expectedSize: number,
  checksum: string,
): Promise<number> {
  const PART_BYTES = 8 * 1024 * 1024;
  const buffer = new Uint8Array(PART_BYTES);
  let buffered = 0;
  let partNumber = 1;
  const parts: Array<{ partNumber: number; etag: string }> = [];
  let written = 0;
  // Holder object: property narrowing resets across the awaits, unlike a
  // captured `let` (whose closure assignment TypeScript mis-narrows).
  const state: { mpu?: R2MultipartUpload } = {};

  const checksummed = checksum.startsWith("sha256:");
  const accumulated: Uint8Array[] | null = checksummed ? [] : null;

  const flush = async (final: boolean): Promise<void> => {
    if (buffered === 0) return;
    const chunk = buffer.slice(0, buffered);
    // Non-final parts must clear the 5 MiB floor; coalesce until they do.
    if (!final && chunk.length < 5 * 1024 * 1024) return;
    if (state.mpu === undefined) {
      state.mpu = await env.REPO_PACKS.createMultipartUpload(key);
    }
    const uploaded = await state.mpu.uploadPart(partNumber, chunk);
    parts.push({ partNumber, etag: uploaded.etag });
    partNumber += 1;
    buffered = 0;
  };

  for (const source of sources) {
    const bytes = await source.get();
    accumulated?.push(bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const space = PART_BYTES - buffered;
      const take = Math.min(space, bytes.length - offset);
      buffer.set(bytes.subarray(offset, offset + take), buffered);
      buffered += take;
      offset += take;
      written += take;
      if (buffered === PART_BYTES) {
        await flush(false);
      }
    }
  }
  await flush(true);
  if (state.mpu !== undefined) {
    await state.mpu.complete(parts);
  } else {
    await env.REPO_PACKS.put(key, buffer.slice(0, buffered));
  }

  if (written !== expectedSize) {
    throw new Error("merged file size is not equal to chunk length");
  }

  if (checksummed && accumulated !== null) {
    const total = accumulated.reduce((sum, part) => sum + part.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const part of accumulated) {
      all.set(part, at);
      at += part.length;
    }
    const digest = await crypto.subtle.digest("SHA-256", all);
    const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    if (!checksum.endsWith(actual)) {
      throw new Error(`update artifact error checksum is invalid ${checksum} vs ${actual}`);
    }
  }

  return written;
}

// ---------------------------------------------------------------------------
// Chunk listing (artifacts_chunks.go:49-73,163-184 + artifactsv4.go:186-215)
// ---------------------------------------------------------------------------

export interface ChunkItem {
  artifactId: number;
  /** The full R2 key. */
  path: string;
  size: number;
  start: number;
  /** Inclusive (artifacts_chunks.go:158). */
  end: number;
  /** v4 only. */
  chunkName?: string;
}

/** parseChunkFileItemV3 (artifacts_chunks.go:49-73) over a basename. */
export function parseChunkFileItemV3(baseName: string, objectSize: number): ChunkItem | null {
  if (!baseName.endsWith(".chunk")) {
    return null;
  }
  const match = /^(\d+)-(\d+)-(\d+)-(\d+)\.chunk$/.exec(baseName);
  if (match === null) {
    throw new Error(`unable to parse chunk name: ${baseName}`);
  }
  const item: ChunkItem = {
    artifactId: Number(match[2]),
    path: baseName,
    size: 0,
    start: Number(match[3]),
    end: Number(match[4]),
  };
  if (item.end === 0) {
    item.size = objectSize;
    item.end = item.start + item.size - 1;
  } else {
    item.size = item.end - item.start + 1;
  }
  return item;
}

/** parseChunkFileItemV4 (artifactsv4.go:186-215) over a basename. */
export function parseChunkFileItemV4(baseName: string, artifactId: number, objectSize: number): ChunkItem | null {
  if (!baseName.startsWith("block-")) {
    return null;
  }
  const match = /^block-(\d+)-(\d+)-(\d+)-([A-Za-z0-9_=-]+)$/.exec(baseName);
  if (match === null) {
    throw new Error(`unable to parse chunk name: ${baseName}`);
  }
  const itemArtifactId = Number(match[2]);
  if (itemArtifactId !== artifactId) {
    return null; // errSkipChunkFile
  }
  const padded = (match[4] ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const item: ChunkItem = {
    artifactId: itemArtifactId,
    path: baseName,
    size: Number(match[3]),
    start: 0,
    end: 0,
    chunkName: bin,
  };
  if (item.size <= 0) {
    item.size = objectSize;
  }
  return item;
}

/** listV3UnorderedChunksMapByRunID (artifacts_chunks.go:163-184) — R2 list
 *  under the run's v3 dir, grouped by artifact id, parse failures fatal. */
export async function listV3ChunksByRun(env: Env, runId: number): Promise<Map<number, ChunkItem[]>> {
  const out = new Map<number, ChunkItem[]>();
  let cursor: string | undefined;
  do {
    const page = await env.REPO_PACKS.list({ prefix: `${v3Dir(runId)}/`, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const baseName = obj.key.slice(obj.key.lastIndexOf("/") + 1);
      const item = parseChunkFileItemV3(baseName, obj.size);
      if (item === null) {
        continue;
      }
      item.path = obj.key;
      const list = out.get(item.artifactId) ?? [];
      list.push(item);
      out.set(item.artifactId, list);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return out;
}

/**
 * listOrderedChunksForArtifact (artifacts_chunks.go:186-258): v4 first — a
 * blocklist replays its named blocks in list order with recomputed
 * contiguous offsets; a single anonymous v4 block (chunkMapV4 === null)
 * passes through; no v4 blocks at all falls back to v3's start-sorted
 * listing.
 */
export async function listOrderedChunksForArtifact(
  env: Env,
  runId: number,
  artifactId: number,
  blockList: string[] | null,
): Promise<ChunkItem[]> {
  const emptyListAsError = (chunks: ChunkItem[]): ChunkItem[] => {
    if (chunks.length === 0) {
      throw new Error(`no chunk found for artifact id: ${artifactId}`);
    }
    return chunks;
  };

  const chunkMapV4 = blockList !== null ? new Map<string, ChunkItem | null>(blockList.map((name) => [name, null])) : null;
  const v4Chunks: ChunkItem[] = [];
  let sawOwnV4Block = false;

  let cursor: string | undefined;
  do {
    const page = await env.REPO_PACKS.list({ prefix: `${v4Dir(runId)}/`, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const baseName = obj.key.slice(obj.key.lastIndexOf("/") + 1);
      const item = parseChunkFileItemV4(baseName, artifactId, obj.size);
      if (item === null) {
        continue;
      }
      item.path = obj.key;
      sawOwnV4Block = true;
      if (chunkMapV4 !== null && chunkMapV4.has(item.chunkName ?? "")) {
        chunkMapV4.set(item.chunkName ?? "", item);
      } else if (chunkMapV4 === null) {
        if (v4Chunks.length > 0) {
          throw new Error("blockmap is required for chunks > 1");
        }
        v4Chunks.push(item);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);

  if (blockList === null && v4Chunks.length === 0) {
    if (sawOwnV4Block) {
      // Two-plus anonymous blocks without a blocklist — the scan's
      // "blockmap is required" branch fires on the second block; reaching
      // here with blocks seen but none kept surfaces the same error.
      throw new Error("blockmap is required for chunks > 1");
    }
    // The v3 fallback: unordered listing sorted by start.
    const map = await listV3ChunksByRun(env, runId);
    const chunks = (map.get(artifactId) ?? []).sort((a, b) => a.start - b.start);
    return emptyListAsError(chunks);
  }

  if (v4Chunks.length === 0 && chunkMapV4 !== null) {
    const ordered: ChunkItem[] = [];
    for (let i = 0; i < blockList!.length; i++) {
      const chunk = chunkMapV4.get(blockList![i] ?? "");
      if (chunk === undefined || chunk === null) {
        throw new Error(`missing chunk (${i}/${blockList!.length}): ${blockList![i]}`);
      }
      ordered.push(chunk);
    }
    // Replay the block order into contiguous offsets
    // (artifacts_chunks.go:249-257).
    for (let i = 0; i < ordered.length; i++) {
      const chunk = ordered[i]!;
      if (i === 0) {
        chunk.end = chunk.start + chunk.size - 1;
      } else {
        const prev = ordered[i - 1]!;
        chunk.start = prev.end + 1;
        chunk.end = chunk.start + chunk.size - 1;
      }
    }
    return emptyListAsError(ordered);
  }

  return emptyListAsError(v4Chunks);
}

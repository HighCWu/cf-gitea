import { z } from "zod";

import {
  MAX_CHUNKS,
  type ImportManifest,
  type ImportManifestChunk,
  type StagedChunk,
} from "../../repos/imports/service";

/**
 * Wire shapes for the chunked import channel (SPEC-0003 §2.6). Deliberately
 * OUTSIDE the frozen 0004 contract: the SPEC pins these endpoints as
 * "declared here, swagger-shaped in 0004", so the routes register as plain
 * Hono routes and these schemas validate at runtime only — they never enter
 * the generated OpenAPI document (scripts/check-openapi.mjs stays green
 * against the vendored swagger).
 */

const OID = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-hex object id");

export const manifestChunkSchema = z.object({
  /** Chunk index, 0-based, contiguous in upload order (oldest first). */
  n: z.number().int().min(0),
  /** Declared pack size in bytes (32-byte pack floor). */
  bytes: z.number().int().min(32),
  /** Pack trailer SHA-1 — what `git pack-objects` names the pack. */
  sha1: OID,
  /** A 40-hex oid carried by this chunk (the window tip): the consumer's
   *  temporary per-chunk ref targets it, making the engine's connectivity
   *  check the per-chunk verdict. */
  tip: OID,
});

export const importManifestSchema = z
  .object({
    /** Default branch adopted at settle; must be a branch in `refs`. */
    head: z.string().min(1).max(255),
    /** Ref → tip oid, created in one multi-ref CAS at finalize. */
    refs: z.record(z.string(), OID),
    chunks: z.array(manifestChunkSchema).min(1).max(MAX_CHUNKS),
    /** Declared total; must equal the chunk-byte sum. */
    totalBytes: z.number().int().min(32),
  })
  .strict();

/** Runtime mirrors of the wire types (the service owns the parsed shapes). */
export type ManifestChunkJson = ImportManifestChunk;
export type ManifestJson = ImportManifest;
export type StagedChunkJson = StagedChunk;

/** POST /repos/{owner}/{repo}/imports response (§2.6: `{import_id,
 *  chunk_size_cap, upload}` + the one-time import token). */
export interface ImportCreated {
  import_id: number;
  state: string;
  /** One-time plaintext token (`imp_…`) — chunk-upload auth without
   *  re-sending the API token (§3.1). Only this response carries it. */
  import_token: string;
  /** Chunk size cap in bytes (frozen on the row). */
  chunk_size_cap: number;
  /** Maximum chunk count. */
  chunk_count_cap: number;
  /** URL template for the relay PUTs (`{n}` = chunk index). */
  upload: string;
}

/** GET /repos/{owner}/{repo}/imports/{id} response (§2.6 observability). */
export interface ImportStatus {
  import_id: number;
  state: "staged" | "indexing" | "finalizing" | "done" | "failed";
  error: string | null;
  chunk_size_cap: number;
  /** Pre-manifest upload record: chunk index → {bytes, sha1}. */
  staged: Record<string, StagedChunk>;
  /** Post-start manifest with per-chunk checkpoints (null until start). */
  manifest: {
    head: string;
    refs: Record<string, string>;
    total_bytes: number;
    chunks: { n: number; bytes: number; sha1: string; tip: string; status?: string; error?: string }[];
  } | null;
  total_bytes: number;
  heartbeat_at: string | null;
  created_at: string;
}

/** POST …/start response. */
export interface ImportStarted {
  import_id: number;
  state: "indexing";
  /** Chunk indexes (re-)enqueued for indexing. */
  queued_chunks: number[];
}

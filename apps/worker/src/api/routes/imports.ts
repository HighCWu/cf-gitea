import type { MiddlewareHandler } from "hono";
import type { Context } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { ApiError } from "../errors";
import type { ApiEnv } from "../env";
import {
  canViewRepositoryWithTeams,
  findRepositoryByPath,
  repositoryPermissions,
  viewerOf,
  type RepositoryWithOwner,
} from "../services/repository";
import {
  importManifestSchema,
  type ImportCreated,
  type ImportStarted,
  type ImportStatus,
} from "../models/imports";
import {
  hashImportToken,
  importChunkR2Key,
  isImportToken,
  ImportConflictError,
  ImportNotFoundError,
  ManifestInvalidError,
  MAX_MANIFEST_BYTES,
  parseStagedRow,
  parseManifestRow,
  ImportService,
  MAX_CHUNKS,
  type ImportRow,
} from "../../repos/imports/service";

/**
 * Chunked import channel (SPEC-0003 §2.6) — the `imports/**` family:
 *
 *   POST   /repos/{owner}/{repo}/imports                      create (row +
 *                                                             repo→migrating)
 *   PUT    /repos/{owner}/{repo}/imports/{id}/chunks/{n}      relay chunk upload
 *                                                             (import token)
 *   POST   /repos/{owner}/{repo}/imports/{id}/start           validate manifest,
 *                                                             enqueue chunks
 *   GET    /repos/{owner}/{repo}/imports/{id}                 status/checkpoints
 *   POST   /repos/{owner}/{repo}/imports/{id}/abort           CAS → failed +
 *                                                             purge
 *
 * OWNER-OR-ADMIN SCOPED (§2.6) via the SPEC-0002 requireAuth middleware plus
 * the shared viewer/permission helpers. The chunk PUT is the exception: it
 * authenticates with the ONE-TIME import token (§3.1 — the uploader process
 * never sees the API token), hashed in D1 like a PAT.
 *
 * Deliberately PLAIN Hono routes: the SPEC declares this surface outside the
 * frozen 0004 swagger contract ("declared here, swagger-shaped in 0004"), so
 * these paths must NOT enter the generated OpenAPI document
 * (scripts/check-openapi.mjs asserts every declared path exists in the
 * vendored Gitea swagger). Swagger shaping joins the SPEC-0004 wave.
 *
 * Handlers stay thin (AGENTS.md): parse → authorize → ImportService /
 * pipeline call → respond. The chunk PUT streams the request body into R2
 * through a FixedLengthStream — the body is never buffered.
 */

/** Owner-or-admin gate (§2.6); invisible repos are the 404 anti-enumeration. */
async function requireAdminRepo(c: Context<ApiEnv>, owner: string, repo: string): Promise<RepositoryWithOwner> {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, owner, repo);
  if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) throw new ApiError(404, "not found");
  if (!repositoryPermissions(viewer, found.repo).admin) {
    throw new ApiError(403, "only the repository owner or a site admin can manage imports");
  }
  return found;
}

/** Resolve the import row for a path param, scoped to the repo (a mismatched
 *  pair is the same 404 as a missing row — no cross-repo enumeration). */
async function requireImport(c: Context<ApiEnv>, repoId: string, importId: number): Promise<ImportRow> {
  const service = new ImportService(c.env.DB);
  const row = await service.get(importId);
  if (row === null || row.repoId !== repoId) throw new ApiError(404, "not found");
  return row;
}

function parseImportId(raw: string): number {
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, `invalid import id: ${raw}`);
  return id;
}

function parseChunkIndex(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n >= MAX_CHUNKS) {
    throw new ApiError(400, `invalid chunk index: ${raw}`);
  }
  return n;
}

const OID_RE = /^[0-9a-f]{40}$/;

/** Map the service's error family onto the upstream status codes (§2.6:
 *  validation → 400, conflicts → 409; unknown errors rethrow into the global
 *  handler's 500). Use as `.catch(toApiError)`. */
function toApiError(error: unknown): never {
  if (error instanceof ImportConflictError) throw new ApiError(409, error.message);
  if (error instanceof ManifestInvalidError) throw new ApiError(400, error.message);
  if (error instanceof ImportNotFoundError) throw new ApiError(404, error.message);
  throw error;
}

export function registerImportRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // POST — create the import (§2.6: repo must exist, is_empty, not archived,
  // no active import → otherwise 409; flips status='migrating').
  app.post("/repos/:owner/:repo/imports", requireAuth, async (c) => {
    const { owner, repo } = c.req.param();
    const found = await requireAdminRepo(c, owner, repo);
    const service = new ImportService(c.env.DB, { queue: c.env.REPO_TASKS });
    const { row, importToken, chunkCap } = await service.create(found.repo.id).catch(toApiError);
    const body: ImportCreated = {
      import_id: row.id,
      state: row.state,
      import_token: importToken,
      chunk_size_cap: chunkCap,
      chunk_count_cap: MAX_CHUNKS,
      upload: `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/imports/${row.id}/chunks/{n}`,
    };
    return c.json(body, 201);
  });

  // PUT — the Worker-relayed chunk upload (§2.6: "streams straight into R2
  // … same bytes either way, single streaming write, never buffered").
  // Requires Content-Length (the engine's known-length staging needs it) and
  // the X-Chunk-Sha1 digest (start cross-checks the manifest against it).
  app.put("/repos/:owner/:repo/imports/:importId/chunks/:chunkN", async (c) => {
    const { owner, repo } = c.req.param();
    const importId = parseImportId(c.req.param("importId"));
    const chunkN = parseChunkIndex(c.req.param("chunkN"));

    const token = c.req.header("x-import-token") ?? bearerToken(c.req.header("authorization"));
    if (token === null || !isImportToken(token)) {
      throw new ApiError(401, "import token required (X-Import-Token)");
    }
    const found = await findRepositoryByPath(c.env.DB, owner, repo);
    if (found === null) throw new ApiError(404, "not found");
    const service = new ImportService(c.env.DB);
    const row = await service.getByTokenHash(await hashImportToken(token));
    if (row === null || row.repoId !== found.repo.id) throw new ApiError(401, "invalid import token");
    if (row.id !== importId) throw new ApiError(404, "not found");
    if (row.state !== "staged" && row.state !== "indexing") {
      throw new ApiError(409, `import is ${row.state}; chunk uploads require staged or indexing`);
    }
    const manifest = row.manifest === null ? null : parseManifestRow(row);
    if (manifest !== null && chunkN >= manifest.chunks.length) {
      throw new ApiError(400, `chunk index ${chunkN} exceeds the manifest (${manifest.chunks.length} chunks)`);
    }

    const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (!Number.isInteger(declared) || declared <= 0) {
      throw new ApiError(411, "chunk uploads require Content-Length");
    }
    if (declared > row.chunkCap) {
      throw new ApiError(413, `chunk exceeds the size cap (${declared} > ${row.chunkCap})`);
    }
    const sha1 = c.req.header("x-chunk-sha1");
    if (sha1 === undefined || !OID_RE.test(sha1)) {
      throw new ApiError(400, "chunk uploads require the X-Chunk-Sha1 pack digest header");
    }
    if (c.req.raw.body === null) throw new ApiError(400, "missing chunk body");

    // One streaming write into R2: imports/<storage_key>/<import_id>/chunk-<n>.pack.
    const bucket = c.env.REPO_PACKS;
    if (!bucket) throw new ApiError(500, "REPO_PACKS binding missing");
    const key = importChunkR2Key(found.repo.storageKey, row.id, chunkN);
    const fixed = new FixedLengthStream(declared);
    const put = bucket.put(key, fixed.readable);
    try {
      await c.req.raw.body.pipeTo(fixed.writable);
      await put;
    } catch (error) {
      try {
        await bucket.delete(key);
      } catch {
        // the failed write never landed; nothing to clean
      }
      throw error;
    }

    const updated = await service.recordStagedChunk(row.id, chunkN, { bytes: declared, sha1 }).catch(toApiError);
    return c.json({ import_id: row.id, chunk: chunkN, bytes: declared, sha1, state: updated.state }, 200);
  });

  // POST — start: manifest validation + per-chunk fan-out (§2.6). Body is
  // bounded by the manifest cap before parsing (≤ 1 MiB, §2.6 limits).
  app.post("/repos/:owner/:repo/imports/:importId/start", requireAuth, async (c) => {
    const { owner, repo } = c.req.param();
    const importId = parseImportId(c.req.param("importId"));
    const found = await requireAdminRepo(c, owner, repo);
    const row = await requireImport(c, found.repo.id, importId);

    const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (Number.isInteger(declared) && declared > MAX_MANIFEST_BYTES) {
      throw new ApiError(413, `manifest exceeds the ${MAX_MANIFEST_BYTES} byte cap`);
    }
    let manifestBody: unknown;
    try {
      manifestBody = await c.req.json();
    } catch {
      throw new ApiError(400, "manifest must be a JSON object");
    }
    // Shape first (zod), semantics second (the service's validateManifest).
    const shape = importManifestSchema.safeParse(manifestBody);
    if (!shape.success) {
      throw new ApiError(400, `invalid manifest: ${shape.error.issues[0]?.message ?? "malformed"}`);
    }

    const service = new ImportService(c.env.DB, { queue: c.env.REPO_TASKS });
    const { pending } = await service.start(row.id, manifestBody).catch(toApiError);
    const body: ImportStarted = { import_id: row.id, state: "indexing", queued_chunks: pending };
    return c.json(body, 200);
  });

  // GET — status/observability (§2.6: state, per-chunk checkpoints, bytes
  // staged, error text).
  app.get("/repos/:owner/:repo/imports/:importId", requireAuth, async (c) => {
    const { owner, repo } = c.req.param();
    const importId = parseImportId(c.req.param("importId"));
    const found = await requireAdminRepo(c, owner, repo);
    const row = await requireImport(c, found.repo.id, importId);
    return c.json(toImportStatus(row), 200);
  });

  // POST — abort (§2.6 step 4): CAS → failed('aborted') + repo back to
  // ready, then the cleanup (temp-ref delete + R2 prefix purge) runs
  // synchronously AND via a queue message — the message retries past a
  // chunk receive holding the engine lease; both halves are idempotent.
  app.post("/repos/:owner/:repo/imports/:importId/abort", requireAuth, async (c) => {
    const { owner, repo } = c.req.param();
    const importId = parseImportId(c.req.param("importId"));
    const found = await requireAdminRepo(c, owner, repo);
    const row = await requireImport(c, found.repo.id, importId);

    const service = new ImportService(c.env.DB, { queue: c.env.REPO_TASKS });
    const aborted = await service.abort(row.id);
    if (aborted === null) {
      throw new ApiError(409, `import is ${row.state}; abort requires an active import`);
    }
    // The D1 CAS landed above; the storage half of the abort (temporary-ref
    // delete + R2 chunk-prefix purge) is the queued import-abort message's
    // work — queue retries absorb a chunk receive holding the engine lease,
    // and the route layer stays engine-free (the /api/v1 OpenAPI bundle must
    // not reach packages/git-engine, scripts/check-openapi.mjs's boundary).
    if (c.env.REPO_TASKS) {
      try {
        await c.env.REPO_TASKS.send({ kind: "import-abort", importId: row.id, repoId: row.repoId });
      } catch (error) {
        console.error(`[imports] abort ${row.id} enqueue failed: ${errorMessage(error)}`);
      }
    }
    return c.json({ import_id: row.id, state: aborted.state, error: aborted.error }, 200);
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function bearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function toImportStatus(row: ImportRow): ImportStatus {
  const manifest = row.manifest === null ? null : parseManifestRow(row);
  return {
    import_id: row.id,
    state: row.state,
    error: row.error,
    chunk_size_cap: row.chunkCap,
    staged: parseStagedRow(row),
    manifest:
      manifest === null
        ? null
        : {
            head: manifest.head,
            refs: manifest.refs,
            total_bytes: manifest.totalBytes,
            chunks: manifest.chunks.map((chunk) => ({
              n: chunk.n,
              bytes: chunk.bytes,
              sha1: chunk.sha1,
              tip: chunk.tip,
              status: chunk.status,
              error: chunk.error,
            })),
          },
    total_bytes: row.totalBytes,
    heartbeat_at: row.heartbeatAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

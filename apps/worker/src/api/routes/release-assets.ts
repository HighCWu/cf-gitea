import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { attachmentSchema } from "../models/release";
import { canWriteRepository, requireVisibleRepo } from "../services/repo-access";
import { loadRepoSettings } from "../services/repo-settings";
import {
  AssetSizeMismatchError,
  AssetTooLargeError,
  MalformedMultipartError,
  type MultipartPart,
  MAX_RELEASE_ASSET_BYTES,
  listReleaseAssets,
  parseMultipartParts,
  readTextFieldPart,
  readableStreamFromGenerator,
  toApiAttachment,
  uploadReleaseAsset,
} from "../services/release-assets";
import { assertDraftVisible, assertNotTagRecord, findReleaseForRepoById } from "../services/releases";

/**
 * Tier-1 release-asset routes (SPEC-0004 §2.4 rows repoListReleaseAttachments
 * / repoCreateReleaseAttachment; upstream routers/api/v1/repo/
 * release_attachment.go ListReleaseAttachments / CreateReleaseAttachment over
 * the landed `release_assets` table + the shared REPO_PACKS bucket — the
 * single-attachment `{attachment_id}` sub-family stays tier 2).
 *
 * Auth (upstream registration, api.go:1416-1418 — inside the releases group):
 * the GET is anonymous-capable on public repos; the POST carries
 * `reqToken + reqRepoWriter(TypeReleases)` — the writer gate is
 * services/repo-access.ts's (reduced matrix + collaborator rows). Both ride
 * mustEnableUnit(TypeReleases) (412 when the stored has_releases flag is
 * false) and the release 404 rules (repo-scoped global id, tag-only records
 * invisible, drafts 404 without release-write access).
 *
 * The POST body (declared in the vendored contract as formData params, which
 * the OpenAPI-3 zod surface cannot express — the request shape lives in
 * services/release-assets.ts's header): `multipart/form-data` with the
 * `attachment` file part plus a `name` field that overrides the part
 * filename, or `application/octet-stream` (any non-multipart type) with
 * `?name=`. Both stream to R2 (the AGENTS no-buffer rule) with the 413
 * threshold of SPEC-0005 §3.3 (512 MiB) and REQUIRE Content-Length (411 —
 * the LFS relay discipline; the R2 binding needs a known-length body).
 *
 * Declared responses mirror the vendored contract exactly. Runtime-only
 * statuses the handlers can emit (undeclared; the orchestrator-owned
 * RUNTIME_ONLY_RESPONSES tables are not extended by this batch):
 *   - both routes: 412 (releases unit disabled);
 *   - POST: 411 (missing Content-Length) — and 423 is NOT emitted (the pin
 *     registers no mustNotBeArchived on release writes).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const attachmentListSchema = z.array(attachmentSchema);

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
function pathId(raw: string): number {
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Shared repo resolution + the releases-unit gate (routes/releases.ts twin). */
async function requireAssetsRepo(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const found = await requireVisibleRepo(c, path);
  const settings = await loadRepoSettings(c.env.DB, found.repo.id);
  if (!settings.hasReleases) {
    throw new ApiError(412, "releases are disabled for this repo");
  }
  return found;
}

/** The release-write grant (reqRepoWriter(TypeReleases) reduced). */
async function requireAssetWriter(c: Context<ApiEnv>, found: Awaited<ReturnType<typeof requireVisibleRepo>>): Promise<void> {
  if (await canWriteRepository(c, found)) {
    return;
  }
  throw new ApiError(403, "token does not have the required scope or the user does not have write access");
}

/** The single-release 404 rules (repo-scoped global id; tag rows invisible). */
async function requireReleaseForAssets(c: Context<ApiEnv>, repoId: string, rawId: string) {
  const row = await findReleaseForRepoById(c.env.DB, repoId, pathId(rawId));
  if (row === null) {
    throw new ApiError(404, "not found");
  }
  assertNotTagRecord(row);
  return row;
}

const listAssetsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/releases/{id}/assets",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "List release's attachments",
    operationId: "repoListReleaseAttachments",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo" }),
        repo: z.string().min(1).openapi({ description: "name of the repo" }),
        id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the release" }),
      }),
    },
    responses: {
      200: { description: "AttachmentList", content: { "application/json": { schema: attachmentListSchema } } },
      404: notFoundResponse,
    },
  });

const createAssetRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/releases/{id}/assets",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Create a release attachment",
    operationId: "repoCreateReleaseAttachment",
    // The consumed body is multipart/form-data OR application/octet-stream
    // (formData `attachment` + query `name` in the vendored contract) — not
    // expressible as an OpenAPI-3 JSON schema, documented in the module
    // header; the raw body is read streaming, never via c.req.parseBody().
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo" }),
        repo: z.string().min(1).openapi({ description: "name of the repo" }),
        id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the release" }),
      }),
      query: z.object({
        name: z.string().optional().openapi({ description: "name of the attachment" }),
      }),
    },
    responses: {
      201: { description: "Attachment", content: { "application/json": { schema: attachmentSchema } } },
      400: errorResponse,
      404: notFoundResponse,
      413: errorResponse,
    },
  });

/** Extract the RFC 2046 boundary from a multipart Content-Type (null otherwise). */
function multipartBoundary(contentType: string): string | null {
  const match = /^\s*multipart\/form-data\s*(?:;|$)/i.exec(contentType);
  if (match === null) return null;
  const boundaryMatch = /;\s*boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  return boundary === undefined || boundary === "" ? null : boundary;
}

/** Map the streaming service's typed failures onto upstream status codes. */
function assetErrorToApiError(error: unknown): ApiError | undefined {
  if (error instanceof AssetTooLargeError) {
    return new ApiError(413, "attachment is too large");
  }
  if (error instanceof MalformedMultipartError || error instanceof AssetSizeMismatchError) {
    return new ApiError(400, error.message);
  }
  return undefined;
}

export function registerReleaseAssetRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(listAssetsRoute(optionalAuth), async (c) => {
    const found = await requireAssetsRepo(c, c.req.valid("param"));
    const { id } = c.req.valid("param");
    const release = await requireReleaseForAssets(c, found.repo.id, id);
    assertDraftVisible({ canWrite: await canWriteRepository(c, found) }, release);
    const origin = new URL(c.req.url).origin;
    const rows = await listReleaseAssets(c.env.DB, release.id);
    return c.json(rows.map((row) => toApiAttachment(origin, row)), 200);
  });

  app.openapi(createAssetRoute(requireAuth), async (c) => {
    const found = await requireAssetsRepo(c, c.req.valid("param"));
    await requireAssetWriter(c, found);
    const { id } = c.req.valid("param");
    // Upstream checkReleaseMatchRepo runs BEFORE the body is consumed.
    const release = await requireReleaseForAssets(c, found.repo.id, id);
    assertDraftVisible({ canWrite: true }, release); // writers see drafts

    const requester = c.get("authUser");
    const queryName = c.req.valid("query").name ?? "";
    const request = c.req.raw;
    const contentType = request.headers.get("content-type") ?? "";
    const declaredLength = contentLength(request);

    let filenameFromPart: string | null = null;
    let nameField: string | null = null;
    let content: ReadableStream<Uint8Array> | null = null;
    let multipart = false;
    const boundary = multipartBoundary(contentType);
    if (boundary !== null) {
      // multipart/form-data: the `attachment` file part carries the bytes
      // (its filename names the asset unless `name` overrides). The parts
      // stream is consumed sequentially; once the file part is captured the
      // loop breaks (single-pass — the body tail is not parsed, so a `name`
      // field is honored only when it precedes the attachment part; the
      // contract's `?name=` query always wins and is order-independent).
      multipart = true;
      for await (const part of parseMultipartParts(ensureBody(request), boundary)) {
        if (part.name === "attachment" && content === null) {
          filenameFromPart = part.filename;
          content = readableStreamFromGenerator(part.content);
          break;
        }
        if (part.name === "name") {
          const text = await readTextFieldPart(part);
          if (text !== "") nameField = text;
        } else {
          await readTextFieldPart(part); // drain unknown fields
        }
      }
    } else {
      // octet-stream (any non-multipart type, upstream's else branch): the
      // body IS the asset; ?name= is the only name source.
      content = ensureBody(request);
    }

    // Upstream name priority: the query (`FormString` reads the URL query
    // first), then the multipart `name` field, then the file part's filename.
    const name = queryName !== "" ? queryName : (nameField ?? filenameFromPart);
    if (name === null || name === "") {
      throw new ApiError(400, "Could not determine name of attachment.");
    }
    if (content === null) {
      // A multipart body with no `attachment` part (upstream FormFile fails
      // with an internal error; ours keeps the request-scoped failure class).
      throw new ApiError(400, "no attachment file in request");
    }
    // 413 before streaming when the length is known (SPEC-0005 §3.3);
    // 411 when it is not (the relay-store Content-Length discipline).
    if (declaredLength === null) {
      throw new ApiError(411, "Content-Length header is required");
    }
    if (declaredLength > MAX_RELEASE_ASSET_BYTES) {
      throw new ApiError(413, "attachment is too large");
    }

    try {
      const row = await uploadReleaseAsset({
        bucket: c.env.REPO_PACKS,
        d1: c.env.DB,
        repoId: found.repo.id,
        storageKey: found.repo.storageKey,
        releaseId: release.id,
        uploaderId: requester.id ?? 0,
        name,
        content,
        multipart,
        declaredLength: multipart ? undefined : declaredLength,
      });
      return c.json(toApiAttachment(new URL(c.req.url).origin, row), 201);
    } catch (error) {
      const mapped = assetErrorToApiError(error);
      if (mapped !== undefined) {
        throw mapped;
      }
      throw error;
    }
  });
}

/** The request body — a zero-byte stream when absent (a Content-Length: 0
 *  POST upstream creates a 0-byte attachment; keep that behavior). */
function ensureBody(request: Request): ReadableStream<Uint8Array> {
  return request.body ?? new Blob([]).stream();
}

/** The declared Content-Length (null when absent or not a valid integer). */
function contentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

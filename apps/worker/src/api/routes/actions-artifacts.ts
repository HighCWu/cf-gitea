/**
 * The /api/v1 Actions ARTIFACTS quartet (the board's P1-10 row,
 * docs/residuals-v1.3.2.md — P1-7's remainder slice 3 of 5):
 *
 *   GET    /repos/{owner}/{repo}/actions/artifacts                 getArtifacts
 *   GET    /repos/{owner}/{repo}/actions/artifacts/{artifact_id}   getArtifact
 *   DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id}   deleteArtifact
 *   GET    /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip  downloadArtifact
 *
 * (routers/api/v1/api.go:1371-1376, inside the /actions group whose ladder
 * closes with reqRepoReader(unit.TypeActions); handlers
 * routers/api/v1/repo/action.go:1863-2151) plus the FIFTH arm the /zip
 * redirect targets — DownloadArtifactRaw (`…/{artifact_id}/zip/raw`,
 * registered at api.go:1555-1558 OUTSIDE every swagger-documented group,
 * sig-authenticated: "Artifacts direct download endpoint authenticates via
 * signed url … no need to use other middlewares").
 *
 * GATES — the group has NO reqToken (unlike the secrets/variables/runners
 * family's reqOwner ladder: addActionsRoutes at api.go:1253): reads are
 * anonymous-capable on public repos (optionalAuth + the visibility 404),
 * and DELETE carries only reqRepoWriter(TypeActions) (api.go:1374) — an
 * anonymous caller 403s "user should have a permission to write to a repo"
 * (api.go:396), the 401 is UNREACHABLE here. The actions-unit reader gate
 * (reqRepoReader(TypeActions), api.go:403-410): CanRead(TypeActions) ||
 * repo-admin || site-admin — the landed reduction (the C4/C8 twin's note)
 * makes visibility the unit read and keeps the `repo_units` type='actions'
 * row as the unit's existence arm (the runner-scan's own gate,
 * services/actions/model.ts:657); a visible repo WITHOUT the unit 403s
 * non-admins with upstream's exact message. The delete's writer gate is
 * services/repo-access.ts's canWriteRepository (the landed reqRepoWriter
 * grade).
 *
 * THE WIRE (the /api/v1 rendering over the LANDED artifacts store —
 * services/actions/artifacts*.ts): the list answers
 * `ActionArtifactsResponse` {artifacts, total_count} paginated with
 * upstream's silent page/limit clamp (utils.GetListOptions — and NO
 * X-Total-Count/Link headers: the handler only ctx.JSONes the body,
 * action.go:1911-1913); getArtifact/deleteArtifact/downloadArtifact
 * resolve through getArtifactByPathParam (a RepoID mismatch, an unknown id,
 * or a status outside {UploadConfirmed, Expired} is the SAME 404 "artifact
 * not found" — lowercase), then IsArtifactV4 (the content-type "/"/marker)
 * splits v4 from the "v3 not supported due to not having one unique id"
 * fallthrough 404 "Artifact not found" (UPPERCASE — upstream's two texts
 * differ in case; /raw's own v3 fallthrough is lowercase again,
 * action.go:2081 vs :2134). The /zip arm answers the @actions/toolkit's
 * asserted 302: a signed URL to the raw endpoint (HMAC tag "api" over
 * endpoint+unix-expires+artifactID, 60-minute expiry, base64 raw-url,
 * action.go:2010-2025) carrying Go's http.Redirect GET body over it; the
 * toolkit's X-Gitea-Fetch-Action header flips that to the fetch-action
 * JSON 200 {redirect} (base.go:150-159, server_request.go:246-248). The
 * raw arm streams the stored v4 zip through the ServeUserContentByFile
 * chain (inline disposition, nosniff, the sandbox CSP, the prod
 * cache-control, Last-Modified, minimal single-range — the API arm of the
 * C4 web-UI module's byte-equal port). Delete is the upstream QUIRK: only
 * the CONFIRMED rows flip to pending-deletion (SetArtifactNeedDeleteByID →
 * setConfirmedArtifactsStatus' status filter, artifact.go:255-267), so
 * deleting an EXPIRED v4 artifact still answers 204 with no row change —
 * the retention sweep owns the storage deletion.
 *
 * DECLARED SETS mirror the vendored contract exactly, per op: list/get
 * {200,400,404}, delete {204,400,404}, zip {302,400,404}. The RUNTIME-ONLY
 * codes the handlers can still emit stay undeclared (the
 * orchestrator-owned RUNTIME_ONLY_RESPONSES table is NOT extended here —
 * the deploy-keys/branch-protections/secrets-variables batch pattern):
 *   - the reader 403 (unit-less visible repo, api.go:406) and the writer
 *     403 (api.go:396);
 *   - the raw endpoint is NOT in the contract at all (no swagger block
 *     upstream — the same plain-route-outside-the-spec posture as the
 *     archive catchall and contents.ts raw/media precedents), so its
 *     runtime codes (the sig 404s, the 401, the 200/206 stream) never
 *     enter check:api's declared set either.
 * The declared 400s have no read path (the junk artifact_id parses to 0
 * and falls into the 404 miss — services/context/base_path.go:35-38; the
 * name filter cannot 400) — pinned by the `⊆ contract` check, not runtime.
 *
 * HANDOFF (orchestrator): registration is the family one-liner after
 * registerSecretsVariablesRoutes in src/api/router.ts —
 *   registerActionsArtifactRoutes(app, requireAuth, optionalAuth);
 * (requireAuth is accepted for the family signature symmetry but UNUSED:
 * upstream carries no reqToken on any of these five arms).
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";

import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import { parseListOptions } from "../pagination";
import { setArtifactNeedDeleteByID, ARTIFACT_STATUS_EXPIRED, type ArtifactRow } from "../../services/actions/artifacts";
import {
  ARTIFACT_EXPIRED_MESSAGE,
  ARTIFACT_NOT_FOUND_MESSAGE,
  ARTIFACT_V3_NOT_FOUND_MESSAGE,
  REPO_READER_403_MESSAGE,
  REPO_WRITER_403_MESSAGE,
  SIGNATURE_LINK_EXPIRED_MESSAGE,
  actionsUnitRowExists,
  artifactByPathParam,
  artifactPathId,
  buildDownloadRawEndpoint,
  buildSigUrl,
  goRedirectBody,
  isArtifactV4,
  listRepoArtifacts,
  serveArtifactV4Raw,
  toApiArtifact,
  verifyArtifactDownloadSig,
} from "../services/actions-artifacts";
import { canWriteRepository, isRepositoryAdmin, requireVisibleRepo } from "../services/repo-access";
import type { RepositoryWithOwner } from "../services/repository";

// ---------------------------------------------------------------------------
// Wire schemas (route-local: the module owns its contract shapes).
// ---------------------------------------------------------------------------

/** The embedded `workflow_run` of ToActionArtifact (convert.go:785-789):
 *  ONLY {id, repository_id, head_sha} are set — the rest of
 *  ActionWorkflowRun serializes at its zero value (the service module's
 *  render note). */
const actionArtifactWorkflowRunSchema = z.object({
  id: z.number().int().openapi({ format: "int64" }),
  url: z.string(),
  previous_attempt_url: z.string().nullable(),
  html_url: z.string(),
  jobs_url: z.string(),
  logs_url: z.string(),
  artifacts_url: z.string(),
  cancel_url: z.string(),
  rerun_url: z.string(),
  display_title: z.string(),
  path: z.string(),
  event: z.string(),
  run_attempt: z.number().int().openapi({ format: "int64" }),
  run_number: z.number().int().openapi({ format: "int64" }),
  repository_id: z.number().int().openapi({ format: "int64" }),
  head_sha: z.string(),
  status: z.string(),
  pull_requests: z.array(z.unknown()),
  created_at: z.string().openapi({ format: "date-time" }),
  updated_at: z.string().openapi({ format: "date-time" }),
  started_at: z.string().openapi({ format: "date-time" }),
  completed_at: z.string().openapi({ format: "date-time" }),
});

/** `#/definitions/ActionArtifact` (repo_actions.go:89-104). */
const actionArtifactSchema = z.object({
  id: z.number().int().openapi({ format: "int64" }),
  name: z.string().openapi({ description: "the artifact's name" }),
  size_in_bytes: z.number().int().openapi({ format: "int64", description: "the artifact's size in bytes" }),
  url: z.string().openapi({ description: "the artifact's API URL" }),
  archive_download_url: z.string().openapi({ description: "the artifact's archive download URL" }),
  expired: z.boolean().openapi({ description: "whether the artifact is expired" }),
  workflow_run: actionArtifactWorkflowRunSchema,
  created_at: z.string().openapi({ format: "date-time" }),
  updated_at: z.string().openapi({ format: "date-time" }),
  expires_at: z.string().openapi({ format: "date-time" }),
});

/** `#/definitions/ActionArtifactsResponse` (repo_actions.go:160-164). */
const actionArtifactsResponseSchema = z.object({
  artifacts: z.array(actionArtifactSchema),
  total_count: z.number().int().openapi({ format: "int64" }),
});

// ---------------------------------------------------------------------------
// Shared fragments + gates.
// ---------------------------------------------------------------------------

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const artifactIdParams = z.object({
  ...ownerRepoParams,
  artifact_id: z.string().min(1).openapi({ description: "id of the artifact" }),
});

/** reqRepoReader(TypeActions) (api.go:403-410) — the module-header
 *  reduction: visibility is already enforced, so the arms are the actions
 *  unit row (the store's CanRead analog) and the admin OR-clause. */
async function requireActionsReader(c: Context<ApiEnv>, found: RepositoryWithOwner): Promise<void> {
  if (await isRepositoryAdmin(c, found)) {
    return;
  }
  if (await actionsUnitRowExists(c.env.DB, found.repo.id)) {
    return;
  }
  throw new ApiError(403, REPO_READER_403_MESSAGE);
}

/** reqRepoWriter(TypeActions) (api.go:393-400) — the landed
 *  canWriteRepository grant (repo-access.ts's module header maps it). */
async function requireActionsWriter(c: Context<ApiEnv>, found: RepositoryWithOwner): Promise<void> {
  if (await canWriteRepository(c, found)) {
    return;
  }
  throw new ApiError(403, REPO_WRITER_403_MESSAGE);
}

/** getArtifactByPathParam's miss arm (action.go:2149). */
function artifactMiss(): never {
  throw new ApiError(404, ARTIFACT_NOT_FOUND_MESSAGE);
}

/** The by-id handlers' v3 fallthrough (action.go:1953/1989/2081 — the
 *  uppercase text). */
function artifactV3Miss(): never {
  throw new ApiError(404, ARTIFACT_V3_NOT_FOUND_MESSAGE);
}

export function registerActionsArtifactRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  void requireAuth; // upstream carries NO reqToken on any of these arms (the header note)

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/actions/artifacts (GetArtifacts,
  // action.go:1877-1913) — the repo-scoped finalized list, the `name`
  // filter, the silent page/limit clamp, no pagination headers.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/actions/artifacts",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Lists all artifacts for a repository",
      operationId: "getArtifacts",
      request: {
        params: z.object({ ...ownerRepoParams }),
        query: z.object({
          name: z.string().optional().openapi({ description: "name of the artifact" }),
        }),
      },
      responses: {
        200: {
          description: "success",
          content: { "application/json": { schema: actionArtifactsResponseSchema } },
        },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo } = c.req.valid("param");
      const found = await requireVisibleRepo(c, { owner, repo });
      await requireActionsReader(c, found);
      const { name } = c.req.valid("query");
      const opts = parseListOptions(new URL(c.req.url));
      const { rows, total } = await listRepoArtifacts(c.env.DB, found.repo.id, name ?? "", opts.page, opts.limit);
      return c.json(
        {
          artifacts: rows.map((art) => toApiArtifactOf(c, found, art)),
          total_count: total,
        },
        200,
      );
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}
  // (GetArtifact, action.go:1916-1957) — the v4 row rendered, the v3
  // fallthrough uppercase 404.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/actions/artifacts/{artifact_id}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Gets a specific artifact for a workflow run",
      operationId: "getArtifact",
      request: { params: artifactIdParams },
      responses: {
        200: {
          description: "success",
          content: { "application/json": { schema: actionArtifactSchema } },
        },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo, artifact_id } = c.req.valid("param");
      const found = await requireVisibleRepo(c, { owner, repo });
      await requireActionsReader(c, found);
      const art = await artifactByPathParam(c.env.DB, found.repo.id, artifact_id);
      if (art === null) artifactMiss();
      if (!isArtifactV4(art)) artifactV3Miss();
      return c.json(toApiArtifactOf(c, found, art), 200);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id}
  // (DeleteArtifact, action.go:1960-1996) — reqRepoWriter(TypeActions) and
  // NO reqToken (the anonymous 403); the pending-delete mark, 204 empty.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/actions/artifacts/{artifact_id}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Deletes a specific artifact for a workflow run",
      operationId: "deleteArtifact",
      request: { params: artifactIdParams },
      responses: {
        204: { description: "No Content" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo, artifact_id } = c.req.valid("param");
      const found = await requireVisibleRepo(c, { owner, repo });
      await requireActionsReader(c, found);
      await requireActionsWriter(c, found);
      const art = await artifactByPathParam(c.env.DB, found.repo.id, artifact_id);
      if (art === null) artifactMiss();
      if (!isArtifactV4(art)) artifactV3Miss();
      // SetArtifactNeedDeleteByID (action.go:1983-1985) — the CONFIRMED-row
      // flip; an EXPIRED row still answers 204 untouched (the header quirk).
      await setArtifactNeedDeleteByID(c.env.DB, art.id);
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip
  // (DownloadArtifact, action.go:2042-2083) — the toolkit's asserted 302
  // to the signed raw URL; the expired arm 404s BEFORE the v4 split.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Downloads a specific artifact for a workflow run redirects to blob url",
      operationId: "downloadArtifact",
      request: { params: artifactIdParams },
      responses: {
        302: { description: "redirect to the blob download" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo, artifact_id } = c.req.valid("param");
      const found = await requireVisibleRepo(c, { owner, repo });
      await requireActionsReader(c, found);
      const art = await artifactByPathParam(c.env.DB, found.repo.id, artifact_id);
      if (art === null) artifactMiss();
      if (art.status === ARTIFACT_STATUS_EXPIRED) {
        throw new ApiError(404, ARTIFACT_EXPIRED_MESSAGE);
      }
      if (!isArtifactV4(art)) artifactV3Miss();
      const redirectUrl = await buildSigUrl(c.env, appUrlOf(c), found.repo.ownerNamespace, found.repo.slug, art.id);
      return downloadRedirect(c, redirectUrl);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip/raw
  // (DownloadArtifactRaw, action.go:2084-2136, registered at api.go:1555-
  // 1558 OUTSIDE the swagger-documented groups) — sig-authenticated, no
  // repoAssignment. A PLAIN route: upstream declares no swagger block for
  // it (absent from the frozen contract), so it stays outside the
  // generated spec per the archive-catchall / contents raw-media precedent.
  // -------------------------------------------------------------------------
  app.get("/repos/:owner/:repo/actions/artifacts/:artifactId/zip/raw", (c) => downloadArtifactRaw(c));
}

// ---------------------------------------------------------------------------
// Handler plumbing (file-local: the plain route shares the openapi arms'
// service calls).
// ---------------------------------------------------------------------------

/** AppURL for buildSigURL — the request origin + AppURL's trailing slash
 *  (services/actions/routes.ts appUrlOf's shape). */
function appUrlOf(c: Context<ApiEnv>): string {
  return new URL(c.req.url).origin + "/";
}

/** The converter seam — `origin` pinned from the request (convert.go's
 *  repo.APIURL() reads setting.AppURL; our seam reads the request origin,
 *  the toApiRepository convention). */
function toApiArtifactOf(c: Context<ApiEnv>, found: RepositoryWithOwner, art: ArtifactRow) {
  return toApiArtifact(found, new URL(c.req.url).origin, art);
}

/** Base.Redirect's API shape (base.go:150-159): the fetch-action header
 *  flips the 302 into the JSON 200 {redirect}; otherwise Go's
 *  http.Redirect — Location + the GET anchor body, text/html. */
function downloadRedirect(c: Context<ApiEnv>, location: string): Response {
  if ((c.req.header("X-Gitea-Fetch-Action") ?? "") !== "") {
    return c.json({ redirect: location }, 200);
  }
  return new Response(goRedirectBody(location), {
    status: 302,
    headers: { Location: location, "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * DownloadArtifactRaw (action.go:2084-2136): verify the sig (bad sig → the
 * bare "not found" 404 — hmac.Equal's failure arm at :2092-2095), then the
 * expiry (401 "Error link expired", :2097-2100), then resolve the repo by
 * path (miss → APIErrorNotFound "not found", :2102-2110), then the same
 * getArtifactByPathParam + expired + v4 arms as /zip — with /raw's own
 * LOWERCASE v3 fallthrough text (:2134). The storage-error arm throws into
 * the 500 family (upstream's APIErrorInternal, :2126-2130).
 */
async function downloadArtifactRaw(c: Context<ApiEnv>): Promise<Response> {
  const owner = c.req.param("owner") ?? "";
  const repo = c.req.param("repo") ?? "";
  const rawId = c.req.param("artifactId") ?? "";
  const artifactId = artifactPathId(rawId);
  const endpoint = buildDownloadRawEndpoint(owner, repo, artifactId);
  const verified = await verifyArtifactDownloadSig(c.env, {
    sig: c.req.query("sig") ?? "",
    expires: c.req.query("expires") ?? "",
    endpoint,
    artifactId,
  });
  if (verified.outcome === "bad-sig") {
    throw new ApiError(404, "not found");
  }
  if (verified.outcome === "expired") {
    throw new ApiError(401, SIGNATURE_LINK_EXPIRED_MESSAGE);
  }
  const found = await requireVisibleRepo(c, { owner, repo });
  const art = await artifactByPathParam(c.env.DB, found.repo.id, rawId);
  if (art === null) artifactMiss();
  if (art.status === ARTIFACT_STATUS_EXPIRED) {
    throw new ApiError(404, ARTIFACT_EXPIRED_MESSAGE);
  }
  if (!isArtifactV4(art)) throw new ApiError(404, ARTIFACT_NOT_FOUND_MESSAGE);
  return serveArtifactV4Raw(c.env, art, c.req.header("Range") ?? null);
}

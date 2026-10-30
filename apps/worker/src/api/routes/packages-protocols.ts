/**
 * The M3/M4 registry protocol routes (SPEC-0016 §7): the PYPI, HELM and NPM
 * families of upstream's CommonRoutes (api.go:417-421 / api.go:337-341 /
 * api.go:378-414), mounted at `/api/packages` beside the generic family
 * (routes/packages.ts — NOT in the frozen OpenAPI document, upstream keeps
 * the package-manager endpoints outside the v1 swagger too, so this
 * registers as a plain Hono router and src/index.ts mounts it with a second
 * `app.route("/api/packages", …)`).
 *
 * The gate stack is upstream's per-family wrap — the group carries
 * `reqPackageAccess(read)` with the write arms adding
 * `reqPackageAccess(write)` — resolved through the same credential pass the
 * generic family uses (routes/packages.ts's private helpers are the pattern
 * this file re-implements: parse → TokenService.verify → ScopeSet, the LFS
 * seam; anonymous requests flow through so public-owner downloads work and
 * everything insufficient answers 401 + the WWW-Authenticate challenge).
 *
 * Error BODIES differ per family, as upstream's apiError helpers do:
 * pypi.apiError answers PLAIN TEXT (pypi.go:41-44, ctx.PlainText) while
 * helm.apiError and npm.apiError answer `{"error": message}` JSON (helm.go:29-37
 * / npm.go:39-44, ctx.JSON).
 *
 * The npm family's name-bearing routes are NOT plain `:param` patterns:
 * upstream routes them through chi's PathGroup with UseUnescapedPath
 * (api.go:391-414 — the NPM-ROUTE-PATH-PATTERN hint names the three
 * `@scope%2Fcore` / `%40angular%2Fcore` / `@angular/core` shapes a client
 * sends), so the name segment can carry an ENCODED slash. Hono's params
 * cannot span one, so the `/:username/npm/*` wildcard hands the RAW
 * remainder to `parseNpmTarget`, which decodes it once (upstream's
 * unescape-first order) and walks the upstream grammar segment-by-segment:
 * the name is everything before the first `-`/`-rev` marker (scoped names
 * span segments), dist-tags ride the `-/package/{id}/dist-tags` prefix, and
 * the `-{version}/` download shape IGNORES the version (upstream's two GET
 * shapes share DownloadPackageFileByName, a filename-only search).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { userRedirects, users } from "../../db/schema";
import type { AuthUser } from "../../auth/auth-context";
import { basicAuthTokenCandidate, parseAuthorizationHeader } from "../../auth/httpauth";
import { userRedirectDoesNotExist } from "../../auth/middleware";
import { ScopeSet } from "../../auth/scopes";
import { TokenService } from "../../auth/token-service";
import { findUserByName, type UserRow } from "../services/repository";
import {
  type PackageAccessMode,
  QuotaTotalCountError,
  QuotaTotalSizeError,
  QuotaTypeSizeError,
  accessModeAtLeast,
  determinePackageAccessMode,
  getVersionByNameAndVersion,
  getPackageByName,
  packagesQuotaFromEnv,
  searchVersions,
} from "../../services/packages/model";
import { PackageSizeMismatchError, PackageBlobTooLargeError } from "../../services/packages/blobs";
import { DuplicatePackageFileError } from "../../services/packages/generic";
import {
  PypiFormError,
  PypiHashMismatchError,
  PypiInvalidNameOrVersionError,
  PypiMissingContentError,
  loadPypiSimpleIndex,
  openPypiFileForDownload,
  renderPypiSimpleIndex,
  uploadPypiPackage,
} from "../../services/packages/pypi";
import {
  HelmArchiveError,
  HelmChartInvalidError,
  HelmChartMissingError,
  HelmNameInvalidError,
  HelmPackageNotExistError,
  HelmProvenanceInvalidError,
  HelmVersionInvalidError,
  buildHelmIndexYaml,
  openHelmFileForDownload,
  uploadHelmChart,
  uploadHelmProvenance,
} from "../../services/packages/helm";
import {
  MAX_NPM_DIST_TAG_BODY_BYTES,
  NpmBodyTooLargeError,
  NpmDeprecateNoVersionsError,
  NpmDuplicateVersionError,
  NpmInvalidAttachmentError,
  NpmInvalidIntegrityError,
  NpmInvalidPackageNameError,
  NpmInvalidPackageError,
  NpmInvalidPackageVersionError,
  NpmInvalidTagError,
  NpmLinkPermissionError,
  SortedJsonMap,
  buildNpmPackument,
  buildNpmVersionMetadata,
  deterministicJsonStringify,
  findNpmVersionForFilename,
  listNpmDistTags,
  openNpmFileForDownload,
  removeNpmPackage,
  removeNpmVersion,
  searchNpmPackages,
  setNpmPackageTag,
  uploadNpmPackage,
  validateNpmName,
} from "../../services/packages/npm";

import {
  decodeMavenPathWildcard,
  extractMavenPathParameters,
  loadMavenMetadataDocument,
  mavenMetadataChecksum,
  mavenPathExt,
  openMavenFile,
  uploadMavenPackageFile,
  MavenChecksumTooLargeError,
  MavenHashMismatchError,
  MavenInvalidParametersError,
  MavenPackageFileNotExistError,
  MavenPackageNotExistError,
  MavenPomInvalidArgumentError,
  MavenPomParseError,
} from "../../services/packages/maven";

import {
  NUGET_EDMX_METADATA_XML,
  NugetBodyTooLargeError,
  NugetDuplicatePackageFileError,
  NugetDuplicateVersionError,
  NugetInvalidFilesError,
  NugetInvalidPackageArchiveError,
  NugetMissingNuspecFileError,
  NugetMissingPdbFilesError,
  NugetNuspecFileTooLargeError,
  NugetNuspecInvalidIDError,
  NugetNuspecInvalidVersionError,
  NugetPackageNotExistError,
  NugetUnexpectedPackageTypeError,
  NugetLinkBuilder,
  createEntryXml,
  createFeedResponseXml,
  createPackageVersionsJson,
  createRegistrationIndexJson,
  createRegistrationLeafJson,
  createSearchResultJson,
  createServiceIndexJson,
  formInt,
  getNugetDescriptor,
  getNugetSearchTerm,
  getNugetVersionsByPackageName,
  isValidNugetSymbolGuid,
  nugetCountPackages,
  nugetCountVersions,
  nugetSearchAllVersionsPerPackage,
  nugetSearchLatestVersionsPaginated,
  nugetSearchVersionsPaginated,
  openNugetFileForDownload,
  openNugetSymbolFileForDownload,
  removeNugetVersion,
  serviceIndexV2Xml,
  uploadNugetPackage,
  uploadNugetSymbolPackage,
} from "../../services/packages/nuget";

const WWW_AUTHENTICATE = 'Basic realm="Gitea Package API"';

// ---------------------------------------------------------------------------
// The protocol gate (routes/packages.ts's pattern, re-implemented — that
// module's helpers are private and the file is not this unit's to touch)
// ---------------------------------------------------------------------------

interface ResolvedCredential {
  doer: AuthUser | null;
  scope: ScopeSet | null;
}

/**
 * The credential pass shared by every protocol family. `opts.apiKeyHeader`
 * adds the nuget.Auth fallback (auth.go:23-26 — upstream VerifyAuthToken's
 * apiKey arm: X-NuGet-ApiKey carries the token when the Authorization header
 * is absent; Authorization WINS when both are present).
 */
async function resolveCredential(
  d1: D1Database,
  request: Request,
  opts: { apiKeyHeader?: boolean } = {},
): Promise<ResolvedCredential> {
  const header = request.headers.get("Authorization");
  const parsed = header === null ? null : parseAuthorizationHeader(header);
  const credential =
    parsed?.bearerToken?.token ?? (parsed?.basicAuth ? basicAuthTokenCandidate(parsed.basicAuth) : null);
  if (parsed === null || credential === null) {
    if (opts.apiKeyHeader === true) {
      const apiKey = request.headers.get("X-NuGet-ApiKey");
      if (apiKey !== null && apiKey !== "") {
        const verified = await new TokenService(d1).verify(apiKey, { now: new Date() });
        if (verified !== null) {
          return { doer: verified.user, scope: ScopeSet.parseLenient(verified.token.scopes) };
        }
      }
    }
    return { doer: null, scope: null };
  }
  const verified = await new TokenService(d1).verify(credential, { now: new Date() });
  if (verified === null) {
    return { doer: null, scope: null };
  }
  return { doer: verified.user, scope: ScopeSet.parseLenient(verified.token.scopes) };
}

function ownerBlindToPublicOnly(owner: UserRow, cred: ResolvedCredential): boolean {
  return (
    cred.doer !== null &&
    cred.scope?.publicOnly === true &&
    cred.doer.id !== owner.id &&
    !cred.doer.isAdmin &&
    owner.visibility !== "public"
  );
}

function ownerVisibleToDoer(owner: UserRow, cred: ResolvedCredential): boolean {
  return cred.doer === null ? owner.visibility === "public" : true;
}

async function resolveOwnerRow(d1: D1Database, username: string): Promise<UserRow | null> {
  let row = await findUserByName(d1, username);
  if (row === null) {
    const redirect = await drizzle(d1)
      .select({ redirectUserId: userRedirects.redirectUserId })
      .from(userRedirects)
      .where(eq(userRedirects.lowerName, username.toLowerCase()))
      .get();
    if (redirect !== undefined) {
      row = (await drizzle(d1).select().from(users).where(eq(users.id, redirect.redirectUserId)).get()) ?? null;
    }
  }
  return row;
}

function packageAccessChallenge(): never {
  throw new HTTPException(401, {
    res: plainResponse(401, "user should have specific permission or be a site admin", {
      "WWW-Authenticate": WWW_AUTHENTICATE,
    }),
  });
}

/** The strict-polarity PACKAGES_ENABLED arm: only "false" disables. */
function packagesDisabled(env: Env): boolean {
  return !packagesQuotaFromEnv(env).packagesEnabled;
}

async function protocolAccessGate(
  d1: D1Database,
  required: "read" | "write",
  owner: UserRow,
  cred: ResolvedCredential,
): Promise<void> {
  if (cred.scope !== null && !cred.scope.has(`${required}:package`)) {
    packageAccessChallenge();
  }
  const mode: PackageAccessMode = await determinePackageAccessMode(d1, owner, cred.doer, {
    ownerVisibleToDoer: ownerVisibleToDoer(owner, cred),
  });
  if (!accessModeAtLeast(mode, required)) {
    packageAccessChallenge();
  }
}

async function protocolContext(
  c: Context<{ Bindings: Env }>,
  required: "read" | "write",
  opts: { apiKeyHeader?: boolean } = {},
): Promise<{ owner: UserRow; cred: ResolvedCredential }> {
  if (packagesDisabled(c.env)) {
    throw new HTTPException(404, { res: plainResponse(404, "not found") });
  }
  const cred = await resolveCredential(c.env.DB, c.req.raw, opts);
  const username = c.req.param("username") ?? "";
  const owner = await resolveOwnerRow(c.env.DB, username);
  if (owner === null) {
    throw new HTTPException(404, { res: plainResponse(404, userRedirectDoesNotExist(username)) });
  }
  if (ownerBlindToPublicOnly(owner, cred)) {
    throw new HTTPException(404, { res: plainResponse(404, userRedirectDoesNotExist(owner.username)) });
  }
  await protocolAccessGate(c.env.DB, required, owner, cred);
  return { owner, cred };
}

// ---------------------------------------------------------------------------
// Response helpers — pypi errors are PLAIN TEXT, helm errors are JSON
// ---------------------------------------------------------------------------

function plainResponse(status: ContentfulStatus, message: string, extraHeaders?: Record<string, string>): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain;charset=utf-8", ...(extraHeaders ?? {}) },
  });
}

type ContentfulStatus = 400 | 401 | 403 | 404 | 409 | 411 | 413 | 500;

/** helm.go:29-37 — `{"error": message}` with the upstream status. */

/** The maven error mapper (the M5a unit's proven shape — plain-text bodies per maven.go:52-56). */
function mavenErrorResponse(error: unknown): Response {
  if (error instanceof HTTPException) throw error;
  if (error instanceof MavenInvalidParametersError) return plainResponse(400, error.message);
  if (error instanceof MavenPomParseError || error instanceof MavenPomInvalidArgumentError) {
    return plainResponse(400, error.message);
  }
  if (error instanceof PackageSizeMismatchError || error instanceof MavenHashMismatchError) {
    return plainResponse(400, error.message);
  }
  if (error instanceof MavenPackageNotExistError || error instanceof MavenPackageFileNotExistError) {
    return plainResponse(404, error.message);
  }
  if (error instanceof MavenChecksumTooLargeError || error instanceof PackageBlobTooLargeError) {
    return plainResponse(413, error.message);
  }
  if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
    return plainResponse(403, quotaMessage(error));
  }
  if (error instanceof DuplicatePackageFileError) return plainResponse(409, "package file already exists");
  console.error("[packages-maven] request failed", error);
  return plainResponse(500, "internal server error");
}

function helmErrorResponse(status: ContentfulStatus, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** pypi.go:41-44 — ctx.PlainText with the upstream message. */
function pypiErrorResponse(status: ContentfulStatus, message: string): Response {
  return plainResponse(status, message);
}

function quotaMessage(error: unknown): string {
  return error instanceof Error ? error.message : "quota exceeded";
}

/**
 * nuget.go:30-35 — the family's `{"Message": ...}` JSON error body via
 * ctx.JSON (Content-Type application/json;charset=utf-8); helper.go:29-44
 * strips 500s to "internal server error" (the prod posture).
 */
function nugetApiError(status: ContentfulStatus, message: string): Response {
  return new Response(JSON.stringify({ Message: message }), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

/** The nuget family's error mapper — the 400 InvalidArgument sentinels, the
 *  409 duplicates, the 404 not-exist, the quota 403, the 413 caps. */
function nugetErrorResponse(error: unknown): Response {
  if (error instanceof HTTPException) throw error;
  if (
    error instanceof NugetInvalidPackageArchiveError ||
    error instanceof NugetMissingNuspecFileError ||
    error instanceof NugetNuspecFileTooLargeError ||
    error instanceof NugetNuspecInvalidIDError ||
    error instanceof NugetNuspecInvalidVersionError ||
    error instanceof NugetMissingPdbFilesError ||
    error instanceof NugetInvalidFilesError ||
    error instanceof NugetUnexpectedPackageTypeError
  ) {
    return nugetApiError(400, error.message);
  }
  if (error instanceof NugetDuplicateVersionError || error instanceof NugetDuplicatePackageFileError) {
    return nugetApiError(409, error.message);
  }
  if (error instanceof NugetPackageNotExistError) return nugetApiError(404, error.message);
  if (error instanceof PackageSizeMismatchError) {
    // A lying Content-Length rejects the upload before any parse — the npm
    // non-InvalidArgument posture (see the nuget module divergence note).
    return nugetApiError(500, "internal server error");
  }
  if (error instanceof NugetBodyTooLargeError || error instanceof PackageBlobTooLargeError) {
    return nugetApiError(413, error.message);
  }
  if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
    return nugetApiError(403, quotaMessage(error));
  }
  console.error("[packages-nuget] request failed", error);
  return nugetApiError(500, "internal server error");
}

/** xmlResponse (nuget.go:37-42) — the atom+xml header + body pair. */
function nugetXmlResponse(xml: string): Response {
  return new Response(xml, { status: 200, headers: { "content-type": "application/atom+xml; charset=utf-8" } });
}

/** ctx.PlainText(200, count) for the /$count arms. */
function nugetCountResponse(count: number): Response {
  return new Response(String(count), { status: 200, headers: { "content-type": "text/plain;charset=utf-8" } });
}

/** The declared Content-Length (null when absent or not a valid integer). */
function contentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** The shared byte-serving shape (the generic router's serveDownload idiom
 *  — upstream helper.ServePackageFile: attachment disposition + last-modified
 *  from the file row). */
function fileResponse(
  c: Context<{ Bindings: Env }>,
  download: { stream: ReadableStream; size: number; filename: string; created: Date },
): Response {
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-length": String(download.size),
    "content-disposition": `attachment; filename="${download.filename.replace(/["\\]/g, "_")}"`,
    "last-modified": download.created.toUTCString(),
  });
  if (c.req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(download.stream, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// The sub-app
// ---------------------------------------------------------------------------

/**
 * The `/api/packages` sub-app carrying the pypi + helm families (mounted by
 * src/index.ts beside routes/packages.ts's generic router; resolveAuth is NOT
 * mounted — the family carries its own credential pass, upstream's
 * CommonRoutes posture).
 */
export function createEcosystemProtocolRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // ------------------------------ PYPI ---------------------------------
  // api.go:417-421: POST "/" upload (write), GET /files/{id}/{version}/
  // {filename}, GET /simple/{id} — the group wrapped in read.

  const pypiUpload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return pypiErrorResponse(401, "user should have specific permission or be a site admin");
      }
      // A missing Content-Length streams: the store spools chunked bodies
      // through the bounded R2 multipart upload (the parity review's D-2 —
      // upstream Go reads the stream regardless).
      await uploadPypiPackage({
        d1: c.env.DB,
        bucket: c.env.REPO_PACKS,
        owner,
        doer,
        contentType: c.req.header("content-type") ?? "",
        content: bodyStream(c.req.raw),
        declaredLength: contentLength(c.req.raw) ?? undefined,
        quota: packagesQuotaFromEnv(c.env),
      });
      return new Response(null, { status: 201 });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof PackageSizeMismatchError) return pypiErrorResponse(400, error.message);
      if (
        error instanceof PypiFormError ||
        error instanceof PypiMissingContentError ||
        error instanceof PypiHashMismatchError ||
        error instanceof PypiInvalidNameOrVersionError
      ) {
        return pypiErrorResponse(400, error.message);
      }
      if (error instanceof DuplicatePackageFileError) return pypiErrorResponse(409, "package file already exists");
      if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
        return pypiErrorResponse(403, quotaMessage(error));
      }
      console.error("[packages-pypi] upload failed", error);
      return pypiErrorResponse(500, "internal server error");
    }
  };

  // Upstream registers the upload INSIDE the /pypi group at "/" — the full
  // pattern ends with a slash (api.go:418). Both shapes register: the slash
  // form is upstream's registered shape, the bare form the tolerant variant
  // package-manager clients configure.
  app.post("/:username/pypi/", (c) => pypiUpload(c));
  app.post("/:username/pypi", (c) => pypiUpload(c));

  app.get("/:username/pypi/simple/:id", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      // RegistryURL (pypi.go:71): AppURL + "api/packages/{owner}/pypi" — the
      // owner name renders unescaped, as upstream injects it.
      const origin = new URL(c.req.url).origin;
      const registryUrl = `${origin}/api/packages/${owner.username}/pypi`;
      const index = await loadPypiSimpleIndex(c.env.DB, owner, c.req.param("id") ?? "");
      if (index === null) {
        // apiError(ctx, 404, nil) — the empty plain-text body.
        return pypiErrorResponse(404, "");
      }
      return new Response(
        renderPypiSimpleIndex({
          displayName: index.displayName,
          lowerName: index.lowerName,
          registryUrl,
          entries: index.entries,
        }),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      console.error("[packages-pypi] simple index failed", error);
      return pypiErrorResponse(500, "internal server error");
    }
  });

  app.get("/:username/pypi/files/:id/:version/:filename", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      const download = await openPypiFileForDownload(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        c.req.param("id") ?? "",
        c.req.param("version") ?? "",
        c.req.param("filename") ?? "",
        c.req.method === "HEAD" ? "HEAD" : "GET",
      );
      if (download === null) {
        // helper.PackageErrorStatus: ErrNotExist → 404 (pypi.go:96-98).
        return pypiErrorResponse(404, "package file does not exist");
      }
      return fileResponse(c, {
        stream: download.stream,
        size: download.size,
        filename: download.descriptor.file.name,
        created: download.descriptor.file.createdUnix,
      });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      console.error("[packages-pypi] download failed", error);
      return pypiErrorResponse(500, "internal server error");
    }
  });

  // A HEAD on the pypi file route — upstream registers GET only; HEAD rides
  // the GET handler in practice (the download-counter gate sees HEAD).
  app.on("HEAD", "/:username/pypi/files/:id/:version/:filename", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      const download = await openPypiFileForDownload(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        c.req.param("id") ?? "",
        c.req.param("version") ?? "",
        c.req.param("filename") ?? "",
        "HEAD",
      );
      if (download === null) {
        return pypiErrorResponse(404, "package file does not exist");
      }
      return fileResponse(c, {
        stream: download.stream,
        size: download.size,
        filename: download.descriptor.file.name,
        created: download.descriptor.file.createdUnix,
      });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      return pypiErrorResponse(500, "internal server error");
    }
  });

  // ------------------------------ HELM ---------------------------------
  // api.go:337-341: GET /index.yaml, GET /{filename} (read), POST /api/charts
  // and POST /api/prov (write).

  app.get("/:username/helm/index.yaml", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      // baseURL (helm.go:51): AppURL + "api/packages/" + PathEscape(owner) +
      // "/helm" — the JS twin of PathEscape is encodeURIComponent.
      const origin = new URL(c.req.url).origin;
      const baseUrl = `${origin}/api/packages/${encodeURIComponent(owner.username)}/helm`;
      const yaml = await buildHelmIndexYaml(c.env.DB, baseUrl, owner.id);
      // Upstream streams the encoder straight to the response with no
      // content-type — Go's sniffer answers text/plain; charset=utf-8.
      return new Response(yaml, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof HelmArchiveError) return helmErrorResponse(500, error.message);
      console.error("[packages-helm] index failed", error);
      return helmErrorResponse(500, "internal server error");
    }
  });

  const helmDownload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const download = await openHelmFileForDownload(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        c.req.param("filename") ?? "",
        c.req.method === "HEAD" ? "HEAD" : "GET",
      );
      if (download === null) {
        // apiError(ctx, 404, ErrPackageFileNotExist) — the JSON error body.
        return helmErrorResponse(404, "package file does not exist");
      }
      return fileResponse(c, {
        stream: download.stream,
        size: download.size,
        filename: download.descriptor.file.name,
        created: download.descriptor.file.createdUnix,
      });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      console.error("[packages-helm] download failed", error);
      return helmErrorResponse(500, "internal server error");
    }
  };
  // index.yaml registers FIRST (static-over-param — chi's own rule at the
  // upstream group); HEAD rides the same walk.
  app.get("/:username/helm/:filename", (c) => helmDownload(c));
  app.on("HEAD", "/:username/helm/:filename", (c) => helmDownload(c));

  const helmChartUpload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return helmErrorResponse(401, "user should have specific permission or be a site admin");
      }
      await uploadHelmChart({
        d1: c.env.DB,
        bucket: c.env.REPO_PACKS,
        owner,
        doer,
        content: bodyStream(c.req.raw),
        declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
        quota: packagesQuotaFromEnv(c.env),
      });
      return new Response(null, { status: 201 });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof PackageSizeMismatchError) return helmErrorResponse(400, error.message);
      if (
        error instanceof HelmChartMissingError ||
        error instanceof HelmNameInvalidError ||
        error instanceof HelmVersionInvalidError ||
        error instanceof HelmChartInvalidError
      ) {
        // The ErrInvalidArgument arm (helm.go:160-166) → 400.
        return helmErrorResponse(400, error.message);
      }
      if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
        return helmErrorResponse(403, quotaMessage(error));
      }
      if (error instanceof HelmArchiveError) return helmErrorResponse(500, error.message);
      console.error("[packages-helm] chart upload failed", error);
      return helmErrorResponse(500, "internal server error");
    }
  };

  const helmProvUpload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return helmErrorResponse(401, "user should have specific permission or be a site admin");
      }
      await uploadHelmProvenance({
        d1: c.env.DB,
        bucket: c.env.REPO_PACKS,
        owner,
        doer,
        content: bodyStream(c.req.raw),
        declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
        quota: packagesQuotaFromEnv(c.env),
      });
      return new Response(null, { status: 201 });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof PackageSizeMismatchError) return helmErrorResponse(400, error.message);
      if (
        error instanceof HelmProvenanceInvalidError ||
        error instanceof HelmChartMissingError ||
        error instanceof HelmNameInvalidError ||
        error instanceof HelmVersionInvalidError ||
        error instanceof HelmChartInvalidError
      ) {
        // The ErrInvalidArgument / io.EOF arm (helm.go:231-238) → 400.
        return helmErrorResponse(400, error.message);
      }
      if (error instanceof HelmPackageNotExistError) {
        // The ErrPackageNotExist arm (helm.go:265-266) → 404.
        return helmErrorResponse(404, error.message);
      }
      if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
        return helmErrorResponse(403, quotaMessage(error));
      }
      if (error instanceof HelmArchiveError) return helmErrorResponse(500, error.message);
      console.error("[packages-helm] provenance upload failed", error);
      return helmErrorResponse(500, "internal server error");
    }
  };

  app.post("/:username/helm/api/charts", (c) => helmChartUpload(c));
  app.post("/:username/helm/api/prov", (c) => helmProvUpload(c));

  // ------------------------------ NPM ----------------------------------
  // api.go:378-414: the metadata endpoints (/-/v1/search, /-/ping, /-/whoami)
  // plus the chi PathGroup family over the name-bearing shapes — routed
  // through parseNpmTarget (see the module header's routing note).

  app.on("GET", "/:username/npm/*", (c) => npmDispatch(c));
  app.on("HEAD", "/:username/npm/*", (c) => npmDispatch(c));
  app.on("PUT", "/:username/npm/*", (c) => npmDispatch(c));
  app.on("DELETE", "/:username/npm/*", (c) => npmDispatch(c));
  app.on("POST", "/:username/npm/*", (c) => npmDispatch(c));


  // ------------------------------ MAVEN (api.go:336-339) ------------------------------
  const mavenDownload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const wildcard = decodeMavenPathWildcard(c.req.path, c.req.param("username") ?? "");
      if (wildcard === null) return plainResponse(400, "request parameters are invalid");
      const params = extractMavenPathParameters(wildcard);
      if (params === null) return plainResponse(400, "request parameters are invalid");

      if (params.isMeta && params.version === "") {
        // serveMavenMetadata (maven.go:82-150).
        const doc = await loadMavenMetadataDocument(c.env.DB, owner, params);
        if (doc === null) return plainResponse(404, "package does not exist");
        const ext = mavenPathExt(params.filename).toLowerCase();
        const bytes = new TextEncoder().encode(doc.xml);
        if (ext === ".md5" || ext === ".sha1" || ext === ".sha256" || ext === ".sha512") {
          return new Response(await mavenMetadataChecksum(doc.xml, ext), {
            status: 200,
            headers: { "content-type": "text/plain;charset=utf-8" },
          });
        }
        const headers = new Headers({
          "content-type": "text/xml",
          "content-length": String(bytes.byteLength),
          "last-modified": doc.lastModified.toUTCString(),
        });
        return new Response(c.req.method === "HEAD" ? null : bytes, { status: 200, headers });
      }

      const opened = await openMavenFile(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        params,
        c.req.method === "HEAD" ? "HEAD" : "GET",
      );
      if (opened.kind === "checksum") {
        return new Response(opened.hash, {
          status: 200,
          headers: { "content-type": "text/plain;charset=utf-8" },
        });
      }
      const headers = new Headers({
        "content-type": opened.contentType,
        "content-length": String(opened.size),
        "last-modified": opened.file.createdUnix.toUTCString(),
      });
      // Upstream's HEAD-only branch sets headers WITHOUT the filename
      // (maven.go:216-219) — no Content-Disposition; the GET arm sets it
      // (helper.ServePackageFile).
      if (c.req.method !== "HEAD") {
        headers.set(
          "content-disposition",
          `attachment; filename="${opened.file.name.replace(/["\\]/g, "_")}"`,
        );
      }
      return new Response(c.req.method === "HEAD" ? null : opened.stream, { status: 200, headers });
    } catch (error) {
      return mavenErrorResponse(error);
    }
  };
  app.put("/:username/maven/*", async (c) => {
    try {
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return plainResponse(401, "user should have specific permission or be a site admin", {
          "WWW-Authenticate": WWW_AUTHENTICATE,
        });
      }
      const wildcard = decodeMavenPathWildcard(c.req.path, c.req.param("username") ?? "");
      if (wildcard === null) return plainResponse(400, "request parameters are invalid");
      const outcome = await uploadMavenPackageFile({
        d1: c.env.DB,
        bucket: c.env.REPO_PACKS,
        owner,
        doer,
        pathWildcard: wildcard,
        useLegacyPackageName: new URL(c.req.url).searchParams.get("use_legacy_package_name") ?? "",
        content: bodyStream(c.req.raw),
        declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
        quota: packagesQuotaFromEnv(c.env),
      });
      return new Response(null, { status: outcome.kind === "created" ? 201 : 200 });
    } catch (error) {
      return mavenErrorResponse(error);
    }
  });

  app.get("/:username/maven/*", (c) => mavenDownload(c));
  app.on("HEAD", "/:username/maven/*", (c) => mavenDownload(c));

  // ------------------------------ NUGET (api.go:348-378) ------------------------------
  // The V3 JSON family (index/query/registration/package-base-address), the
  // V2 OData feed (service index, $metadata, Packages()/Search()/
  // FindPackagesById() + counts, the Packages(Id=..) entry), the write arms
  // (PUT /, PUT /symbolpackage, DELETE /{id}/{version}) and the symbol query
  // protocol. The base URL renders the owner name RAW — upstream's fmt
  // concat does no escaping (nuget.go:46/70).

  const nugetBaseOf = (origin: string, ownerName: string): string => `${origin}/api/packages/${ownerName}/nuget`;

  const nugetUpload = async (c: Context<{ Bindings: Env }>, kind: "dependency" | "symbols"): Promise<Response> => {
    try {
      const { owner, cred } = await protocolContext(c, "write", { apiKeyHeader: true });
      const doer = cred.doer;
      if (doer === null) {
        return nugetApiError(401, "user should have specific permission or be a site admin");
      }
      const input = {
        d1: c.env.DB,
        bucket: c.env.REPO_PACKS,
        owner,
        doer,
        content: bodyStream(c.req.raw),
        declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
        quota: packagesQuotaFromEnv(c.env),
      };
      if (kind === "dependency") {
        await uploadNugetPackage(input);
      } else {
        await uploadNugetSymbolPackage(input);
      }
      return new Response(null, { status: 201 });
    } catch (error) {
      return nugetErrorResponse(error);
    }
  };
  // Upstream registers the publish INSIDE the /nuget group at "/" (api.go:365)
  // — both the bare and slash forms register (the pypi precedent).
  app.put("/:username/nuget", (c) => nugetUpload(c, "dependency"));
  app.put("/:username/nuget/", (c) => nugetUpload(c, "dependency"));
  app.put("/:username/nuget/symbolpackage", (c) => nugetUpload(c, "symbols"));

  // DeletePackage (nuget.go:675-698) — the group-level /{id}/{version} shape.
  app.delete("/:username/nuget/:id/:version", async (c) => {
    try {
      const { owner } = await protocolContext(c, "write", { apiKeyHeader: true });
      const removed = await removeNugetVersion(
        c.env.DB,
        owner,
        c.req.param("id") ?? "",
        c.req.param("version") ?? "",
      );
      if (!removed) return nugetApiError(404, "package does not exist");
      return new Response(null, { status: 204 });
    } catch (error) {
      return nugetErrorResponse(error);
    }
  });

  // ServiceIndexV3 (nuget.go:69-86).
  app.get("/:username/nuget/index.json", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      const origin = new URL(c.req.url).origin;
      return new Response(JSON.stringify(createServiceIndexJson(nugetBaseOf(origin, owner.username))), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    } catch (error) {
      return nugetErrorResponse(error);
    }
  });

  // FeedCapabilityResource (nuget.go:89-91) — the static Edmx document.
  app.get("/:username/nuget/$metadata", async (c) => {
    try {
      await protocolContext(c, "read");
      return nugetXmlResponse(NUGET_EDMX_METADATA_XML);
    } catch (error) {
      return nugetErrorResponse(error);
    }
  });

  // ServiceIndexV2 (nuget.go:45-66) — the group's "/" shape.
  app.get("/:username/nuget", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      const origin = new URL(c.req.url).origin;
      return nugetXmlResponse(serviceIndexV2Xml(nugetBaseOf(origin, owner.username)));
    } catch (error) {
      return nugetErrorResponse(error);
    }
  });
  app.get("/:username/nuget/", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      const origin = new URL(c.req.url).origin;
      return nugetXmlResponse(serviceIndexV2Xml(nugetBaseOf(origin, owner.username)));
    } catch (error) {
      return nugetErrorResponse(error);
    }
  });

  // SearchServiceV3 (nuget.go:191-219) — /query?q=&skip=&take=.
  app.get("/:username/nuget/query", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      const origin = new URL(c.req.url).origin;
      const builder = new NugetLinkBuilder(nugetBaseOf(origin, owner.username));
      const params = new URL(c.req.url).searchParams;
      const term = { value: (params.get("q") ?? "").trim(), exactMatch: false };
      const found = await nugetSearchAllVersionsPerPackage(
        c.env.DB,
        owner.id,
        term,
        formInt(params, "skip"),
        formInt(params, "take"),
      );
      const descriptors = [];
      for (const row of found.rows) descriptors.push(await getNugetDescriptor(c.env.DB, row.pkg, row.version));
      return new Response(JSON.stringify(createSearchResultJson(builder, found.total, descriptors)), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    } catch (error) {
      return nugetErrorResponse(error);
    }
  });

  // RegistrationIndex (nuget.go:222-247) — semver ascending; the empty arm
  // answers apiError(404, nil) — the empty message ({"Message": ""}).
  app.get("/:username/nuget/registration/:id/index.json", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      const origin = new URL(c.req.url).origin;
      const builder = new NugetLinkBuilder(nugetBaseOf(origin, owner.username));
      const rows = await getNugetVersionsByPackageName(c.env.DB, owner.id, c.req.param("id") ?? "");
      if (rows.length === 0) return nugetApiError(404, "");
      const descriptors = [];
      for (const row of rows) descriptors.push(await getNugetDescriptor(c.env.DB, row.pkg, row.version));
      return new Response(JSON.stringify(createRegistrationIndexJson(builder, descriptors)), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    } catch (error) {
      return nugetErrorResponse(error);
    }
  });

  // RegistrationLeafV3 (nuget.go:280-306) — the .json suffix trimmed.
  const nugetLeafV3 = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const origin = new URL(c.req.url).origin;
      const builder = new NugetLinkBuilder(nugetBaseOf(origin, owner.username));
      const id = c.req.param("id") ?? "";
      const version = (c.req.param("version") ?? "").replace(/\.json$/, "");
      const pv = await getVersionByNameAndVersion(c.env.DB, owner.id, "nuget", id, version);
      if (pv === null) return nugetApiError(404, "package does not exist");
      const pkg = await getPackageByName(c.env.DB, owner.id, "nuget", id);
      if (pkg === null) return nugetApiError(404, "package does not exist");
      const descriptor = await getNugetDescriptor(c.env.DB, pkg, pv);
      return new Response(JSON.stringify(createRegistrationLeafJson(builder, descriptor)), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    } catch (error) {
      return nugetErrorResponse(error);
    }
  };
  app.get("/:username/nuget/registration/:id/:version", (c) => nugetLeafV3(c));

  // EnumeratePackageVersionsV3 (nuget.go:378-394) — the empty arm 404s with
  // the empty message.
  app.get("/:username/nuget/package/:id/index.json", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      const rows = await getNugetVersionsByPackageName(c.env.DB, owner.id, c.req.param("id") ?? "");
      if (rows.length === 0) return nugetApiError(404, "");
      return new Response(JSON.stringify(createPackageVersionsJson(rows.map((row) => row.version))), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    } catch (error) {
      return nugetErrorResponse(error);
    }
  });

  // DownloadPackageFile (nuget.go:398-422) — ANY file of the version; the
  // unknown-version/file arms answer 404 "package does not exist".
  const nugetDownload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const download = await openNugetFileForDownload(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        c.req.param("id") ?? "",
        c.req.param("version") ?? "",
        c.req.param("filename") ?? "",
        c.req.method === "HEAD" ? "HEAD" : "GET",
      );
      if (download === null) return nugetApiError(404, "package does not exist");
      return fileResponse(c, {
        stream: download.stream,
        size: download.size,
        filename: download.file.name,
        created: download.file.createdUnix,
      });
    } catch (error) {
      return nugetErrorResponse(error);
    }
  };
  app.get("/:username/nuget/package/:id/:version/:filename", (c) => nugetDownload(c));
  app.on("HEAD", "/:username/nuget/package/:id/:version/:filename", (c) => nugetDownload(c));

  // DownloadSymbolFile (nuget.go:637-671) — the chi guid regex
  // ([0-9a-fA-F]{32}[fF]{8}) non-matches fall off the router (404, empty
  // message); a filename/filename2 mismatch is apiError(400, nil).
  const nugetSymbolDownload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const filename = c.req.param("filename") ?? "";
      const guid = c.req.param("guid") ?? "";
      const filename2 = c.req.param("filename2") ?? "";
      if (!isValidNugetSymbolGuid(guid)) return nugetApiError(404, "");
      if (filename !== filename2) return nugetApiError(400, "");
      const download = await openNugetSymbolFileForDownload(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        filename,
        guid.slice(0, 32),
        c.req.method === "HEAD" ? "HEAD" : "GET",
      );
      if (download === null) return nugetApiError(404, "");
      return fileResponse(c, {
        stream: download.stream,
        size: download.size,
        filename: download.file.name,
        created: download.file.createdUnix,
      });
    } catch (error) {
      return nugetErrorResponse(error);
    }
  };
  app.get("/:username/nuget/symbols/:filename/:guid/:filename2", (c) => nugetSymbolDownload(c));
  app.on("HEAD", "/:username/nuget/symbols/:filename/:guid/:filename2", (c) => nugetSymbolDownload(c));

  // RegistrationLeafV2 (nuget.go:250-277) — the namespaced entry. chi routes
  // the shape through a path regex, `Packages\(Id='([^']+)',Version='([^']+)'\)`;
  // Hono's router cannot compile embedded params inside parens, so the route
  // rides the Packages(Id=* prefix wildcard and the handler re-pins upstream's
  // regex over the decoded remainder (raw-quote and %27 URL shapes decode to
  // the same string). A non-match is the router's 404.
  const nugetLeafV2 = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const origin = new URL(c.req.url).origin;
      const builder = new NugetLinkBuilder(nugetBaseOf(origin, owner.username));
      const rawPath = c.req.path;
      const marker = "Packages(Id=";
      const nugetAt = rawPath.indexOf("/nuget/");
      const markerAt = nugetAt === -1 ? -1 : rawPath.indexOf(marker, nugetAt);
      const match =
        markerAt !== -1
          ? /^'([^']*)',Version='([^']*)'\)$/.exec(rawPath.slice(markerAt + marker.length))
          : null;
      if (match === null) return nugetApiError(404, "");
      const id = match[1] ?? "";
      const version = match[2] ?? "";
      const pv = await getVersionByNameAndVersion(c.env.DB, owner.id, "nuget", id, version);
      if (pv === null) return nugetApiError(404, "package does not exist");
      const pkg = await getPackageByName(c.env.DB, owner.id, "nuget", id);
      if (pkg === null) return nugetApiError(404, "package does not exist");
      const descriptor = await getNugetDescriptor(c.env.DB, pkg, pv);
      return nugetXmlResponse(createEntryXml(builder, descriptor, true));
    } catch (error) {
      return nugetErrorResponse(error);
    }
  };
  app.get("/:username/nuget/Packages(Id=*", (c) => nugetLeafV2(c));

  // The V2 feeds (SearchServiceV2 / EnumeratePackageVersionsV2, nuget.go:124-356)
  // with the next-link arm when the page filled.
  const nugetFeed = async (c: Context<{ Bindings: Env }>, kind: "search" | "enumerate"): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const origin = new URL(c.req.url).origin;
      const params = new URL(c.req.url).searchParams;
      let found;
      let nextPath: string;
      const nextQuery: [string, string][] = [];
      if (kind === "search") {
        const term = getNugetSearchTerm(params);
        found = await nugetSearchLatestVersionsPaginated(
          c.env.DB,
          owner.id,
          term,
          formInt(params, "$skip"),
          formInt(params, "$top"),
        );
        nextPath = "Search()";
        const searchTerm = (params.get("searchTerm") ?? "").trim();
        const filter = (params.get("$filter") ?? "").trim();
        if (searchTerm !== "") nextQuery.push(["searchTerm", searchTerm]);
        if (filter !== "") nextQuery.push(["$filter", filter]);
      } else {
        const packageName = (params.get("id") ?? "")
          .trim()
          .replace(/^'+/, "")
          .replace(/'+$/, "");
        found = await nugetSearchVersionsPaginated(
          c.env.DB,
          owner.id,
          packageName,
          formInt(params, "$skip"),
          formInt(params, "$top"),
        );
        nextPath = "FindPackagesById()";
        if (packageName !== "") nextQuery.push(["id", packageName]);
      }
      const next =
        found.rows.length === found.take
          ? {
              path: nextPath,
              query: [...nextQuery, ["$skip", String(found.skip + found.take)] as [string, string], ["$top", String(found.take)] as [string, string]],
            }
          : undefined;
      const descriptors = [];
      for (const row of found.rows) descriptors.push(await getNugetDescriptor(c.env.DB, row.pkg, row.version));
      return nugetXmlResponse(
        createFeedResponseXml(new NugetLinkBuilder(nugetBaseOf(origin, owner.username), next), found.total, descriptors),
      );
    } catch (error) {
      return nugetErrorResponse(error);
    }
  };
  app.get("/:username/nuget/Packages()", (c) => nugetFeed(c, "search"));
  app.get("/:username/nuget/Search()", (c) => nugetFeed(c, "search"));
  app.get("/:username/nuget/FindPackagesById()", (c) => nugetFeed(c, "enumerate"));

  // The /$count arms (nuget.go:176-188 / :359-375) — plain-text integers.
  const nugetSearchCount = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const term = getNugetSearchTerm(new URL(c.req.url).searchParams);
      return nugetCountResponse(await nugetCountPackages(c.env.DB, owner.id, term));
    } catch (error) {
      return nugetErrorResponse(error);
    }
  };
  app.get("/:username/nuget/Packages()/$count", (c) => nugetSearchCount(c));
  app.get("/:username/nuget/Search()/$count", (c) => nugetSearchCount(c));
  app.get("/:username/nuget/FindPackagesById()/$count", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      const packageName = (new URL(c.req.url).searchParams.get("id") ?? "")
        .trim()
        .replace(/^'+/, "")
        .replace(/'+$/, "");
      return nugetCountResponse(await nugetCountVersions(c.env.DB, owner.id, packageName));
    } catch (error) {
      return nugetErrorResponse(error);
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// The npm PathGroup walk — upstream's UseUnescapedPath + name regexes
// (api.go:391-414) as a manual grammar over the decoded remainder
// ---------------------------------------------------------------------------

type NpmArm =
  | "search"
  | "ping"
  | "whoami"
  | "dist-tags"
  | "put-tag"
  | "delete-tag"
  | "packument"
  | "publish"
  | "version-metadata"
  | "download"
  | "delete-version"
  | "delete-package"
  | "delete-preview";

interface NpmTarget {
  arm: NpmArm;
  /** The full package name — spans segments for scoped packages. */
  name: string;
  version?: string;
  filename?: string;
  tag?: string;
}

/**
 * The decoded remainder after `/{username}/npm/`: `-/package/{id}/dist-tags`
 * prefixes first (the metadata endpoints), then the tarball/revision shapes —
 * the name is everything before the first exact `-`/`-rev` segment (scoped
 * names span segments), and EVERY name-bearing arm validates the id against
 * upstream's route regex (creator.go's `(@scope/)?name`, anchor-for-anchor):
 * chi's MatchPath patterns embed it, so an invalid URL name 404s at ROUTING —
 * the creator's 400 "package name is invalid" is the arm for a versions
 * ENTRY whose name disagrees with a routable URL id.
 */
export function parseNpmTarget(decoded: string, method: string): NpmTarget | null {
  const parts = decoded.split("/");
  if (parts[0] === "-") {
    if (parts.length === 3 && parts[1] === "v1" && parts[2] === "search" && method === "GET") {
      return { arm: "search", name: "" };
    }
    if (parts.length === 2 && parts[1] === "ping") return { arm: "ping", name: "" };
    if (parts.length === 2 && parts[1] === "whoami") return { arm: "whoami", name: "" };
    if (parts[1] === "package") {
      const distTagsAt = parts.lastIndexOf("dist-tags");
      if (distTagsAt >= 3) {
        const name = parts.slice(2, distTagsAt).join("/");
        const rest = parts.slice(distTagsAt + 1);
        if (!validateNpmName(name)) return null;
        if (rest.length === 0 && method === "GET") return { arm: "dist-tags", name };
        if (rest.length === 1 && method === "PUT") return { arm: "put-tag", name, tag: rest[0] };
        if (rest.length === 1 && method === "DELETE") return { arm: "delete-tag", name, tag: rest[0] };
      }
    }
    return null;
  }
  const revAt = parts.indexOf("-rev");
  const dashAt = parts.indexOf("-");
  if (revAt !== -1 && (dashAt === -1 || revAt < dashAt)) {
    // /{id}/-rev/{revision}
    if (parts.length !== revAt + 2) return null;
    const name = parts.slice(0, revAt).join("/");
    if (!validateNpmName(name)) return null;
    if (method === "DELETE") return { arm: "delete-package", name };
    if (method === "PUT") return { arm: "delete-preview", name };
    return null;
  }
  if (dashAt !== -1) {
    const name = parts.slice(0, dashAt).join("/");
    if (!validateNpmName(name)) return null;
    const rest = parts.slice(dashAt + 1);
    const restRev = rest.indexOf("-rev");
    if (restRev !== -1) {
      if (method !== "DELETE" || restRev + 2 !== rest.length) return null;
      const middle = rest.slice(0, restRev);
      if (middle.length === 1) return { arm: "delete-version", name, filename: middle[0] };
      if (middle.length === 2) return { arm: "delete-version", name, filename: middle[1] };
      return null;
    }
    if (method === "GET" || method === "HEAD") {
      if (rest.length === 1) return { arm: "download", name, filename: rest[0] };
      if (rest.length === 2) return { arm: "download", name, version: rest[0], filename: rest[1] };
    }
    return null;
  }
  // The grammar tail (api.go:405-410): `GET {id}/{version}` then
  // `GET {id}` / `PUT {id}` — the id regex disambiguates a two-segment path:
  // a leading `@` consumes the next segment (the scope cannot stand alone),
  // a bare name does not.
  const first = parts[0] ?? "";
  if (first.startsWith("@")) {
    if (parts.length === 2) {
      const name = `${first}/${parts[1] ?? ""}`;
      if (!validateNpmName(name)) return null;
      if (method === "GET" || method === "HEAD") return { arm: "packument", name };
      if (method === "PUT") return { arm: "publish", name };
      return null;
    }
    if (parts.length === 3 && method === "GET") {
      const name = `${first}/${parts[1] ?? ""}`;
      if (!validateNpmName(name)) return null;
      return { arm: "version-metadata", name, version: parts[2] };
    }
    return null;
  }
  if (parts.length === 1) {
    if (!validateNpmName(first)) return null;
    if (method === "GET" || method === "HEAD") return { arm: "packument", name: first };
    if (method === "PUT") return { arm: "publish", name: first };
    return null;
  }
  if (parts.length === 2 && method === "GET") {
    if (!validateNpmName(first)) return null;
    return { arm: "version-metadata", name: first, version: parts[1] };
  }
  return null;
}

/** npm.go:39-44 — the family's JSON error body. */
function npmErrorResponse(status: ContentfulStatus | 304, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** RFC 7232 §2.3 weak comparison (Go http.ServeContent's If-None-Match arm). */
function etagMatches(headerValue: string, etag: string): boolean {
  for (const candidate of headerValue.split(",")) {
    const trimmed = candidate.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    if (trimmed === etag || trimmed === "*") return true;
  }
  return false;
}

/** npm.go:87-95 — the deterministic body + W/etag, with the 304 short-cut. */
function npmJsonMetadataResponse(c: Context<{ Bindings: Env }>, build: { body: string; etag: string }): Response {
  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatch !== undefined && etagMatches(ifNoneMatch, build.etag)) {
    return new Response(null, { status: 304, headers: { etag: `W/"${build.etag}"` } });
  }
  return new Response(build.body, {
    status: 200,
    headers: {
      "content-type": "application/json;charset=utf-8",
      etag: `W/"${build.etag}"`,
    },
  });
}

async function npmDispatch(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const rawPath = c.req.path;
    const segments = rawPath.split("/");
    // ["", "api", "packages", {username}, "npm", ...] — c.req.path arrives
    // decodeURI'd (Hono getPath): RESERVED escapes like %2F and %40 survive,
    // which is exactly upstream's UseUnescapedPath order — the encoded slash
    // keeps the name one routing segment, and this walk decodes the remainder
    // FULLY (a malformed escape cannot match the grammar below and 404s).
    const prefix = `/api/packages/${segments[3] ?? ""}/npm/`;
    if (!rawPath.startsWith(prefix)) {
      return npmErrorResponse(404, "");
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath.slice(prefix.length));
    } catch {
      return npmErrorResponse(404, "");
    }
    const target = parseNpmTarget(decoded, c.req.method);
    if (target === null) {
      return npmErrorResponse(404, "");
    }
    // The group's read wrap with the write arms' extra check (api.go:379-414).
    const WRITE_ARMS: ReadonlySet<NpmArm> = new Set([
      "publish",
      "put-tag",
      "delete-tag",
      "delete-version",
      "delete-package",
      "delete-preview",
    ]);
    const { owner, cred } = await protocolContext(c, WRITE_ARMS.has(target.arm) ? "write" : "read");
    const origin = new URL(c.req.url).origin;
    // buildNpmRegistryURL (npm.go:56-58): AppURL + api/packages/{owner}/npm.
    const registryUrl = `${origin}/api/packages/${encodeURIComponent(owner.username)}/npm`;

    switch (target.arm) {
      case "ping":
        // npm.go:511-513.
        return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
      case "whoami": {
        // npm.go:515-521.
        if (cred.doer === null) return npmErrorResponse(401, "Unauthorized");
        return new Response(JSON.stringify({ username: cred.doer.username }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      case "search": {
        const form = new URL(c.req.url).searchParams;
        const text = (form.get("text") ?? "").trim();
        const from = Number.parseInt(form.get("from") ?? "", 10);
        const size = Number.parseInt(form.get("size") ?? "", 10);
        const result = await searchNpmPackages(
          c.env.DB,
          owner,
          text,
          Number.isSafeInteger(from) ? from : 0,
          Number.isSafeInteger(size) ? size : 0,
          registryUrl,
        );
        return new Response(JSON.stringify({ objects: result.objects, total: result.total }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      case "packument": {
        const build = await buildNpmPackument(c.env.DB, registryUrl, owner, target.name);
        if (build === null) return npmErrorResponse(404, "");
        return npmJsonMetadataResponse(c, build);
      }
      case "version-metadata": {
        const built = await buildNpmVersionMetadata(c.env.DB, registryUrl, owner, target.name, target.version ?? "");
        if (built === null) return npmErrorResponse(404, `version not found: ${target.version}`);
        if ("fallback" in built) {
          // npm.go:120-123 — unset "latest" serves the packument's fallback.
          const packument = await buildNpmPackument(c.env.DB, registryUrl, owner, target.name);
          const latest = packument?.distTags.latest;
          const versionBody = latest !== undefined ? packument?.versionBodies.get(latest) : undefined;
          if (packument === null || latest === undefined || versionBody === undefined) {
            return npmErrorResponse(404, "");
          }
          return npmJsonMetadataResponse(c, versionBody);
        }
        return npmJsonMetadataResponse(c, built);
      }
      case "download": {
        const download = await openNpmFileForDownload(
          c.env.DB,
          c.env.REPO_PACKS,
          owner,
          target.name,
          target.filename ?? "",
          c.req.method === "HEAD" ? "HEAD" : "GET",
        );
        if (download === null) return npmErrorResponse(404, ""); // apiError(404, nil)
        return fileResponse(c, {
          stream: download.stream,
          size: download.size,
          filename: download.file.name,
          created: download.file.createdUnix,
        });
      }
      case "publish": {
        const doer = cred.doer;
        if (doer === null) return npmErrorResponse(401, "user should have specific permission or be a site admin");
        const result = await uploadNpmPackage({
          d1: c.env.DB,
          bucket: c.env.REPO_PACKS,
          owner,
          doer,
          content: bodyStream(c.req.raw),
          declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
          quota: packagesQuotaFromEnv(c.env),
          instanceOrigin: origin,
        });
        // deprecatePackage's 200 (npm.go:334) / UploadPackage's 201 (npm.go:277).
        return new Response(null, { status: result.kind === "deprecated" ? 200 : 201 });
      }
      case "dist-tags": {
        const tags = await listNpmDistTags(c.env.DB, owner, target.name, registryUrl);
        if (tags === null) return npmErrorResponse(404, "");
        return new Response(deterministicJsonStringify(new SortedJsonMap(tags)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      case "put-tag": {
        // The body is a quoted version string, bounded (npm.go:408-419).
        const body = await c.req.raw.text();
        if (body.length > MAX_NPM_DIST_TAG_BODY_BYTES) return npmErrorResponse(413, "request body too large");
        const version = body.replace(/^"/, "").replace(/"$/, "");
        const targetVersion = await getVersionByNameAndVersion(c.env.DB, owner.id, "npm", target.name, version);
        if (targetVersion === null) return npmErrorResponse(404, "package does not exist");
        const outcome = await setNpmPackageTag(c.env.DB, target.tag ?? "", targetVersion, false);
        if (outcome === "invalid-tag") return npmErrorResponse(400, "The tag name is invalid");
        return new Response(null, { status: 200 });
      }
      case "delete-tag": {
        const { rows } = await searchVersions(c.env.DB, {
          ownerId: owner.id,
          type: "npm",
          name: target.name,
          exact: true,
          excludeInternal: true,
          page: 1,
          limit: 100000,
        });
        const newest = rows[0]?.version;
        if (newest !== undefined) {
          const outcome = await setNpmPackageTag(c.env.DB, target.tag ?? "", newest, true);
          if (outcome === "invalid-tag") return npmErrorResponse(400, "The tag name is invalid");
        }
        return new Response(null, { status: 200 });
      }
      case "delete-version": {
        // npm unpublish by tarball (npm.go:337-350): packageVersionByFilename
        // (a filename-only search, NO download-counter bump) + RemovePackageVersion.
        const found = await findNpmVersionForFilename(c.env.DB, owner, target.name, target.filename ?? "");
        if (found === null) return npmErrorResponse(404, "");
        await removeNpmVersion(c.env.DB, found.id);
        return new Response(null, { status: 200 });
      }
      case "delete-package": {
        // npm unpublish of the whole package (npm.go:352-375).
        const removed = await removeNpmPackage(c.env.DB, owner, target.name);
        if (!removed) return npmErrorResponse(404, "");
        return new Response(null, { status: 200 });
      }
      case "delete-preview":
        // DeletePreview does nothing (npm.go:280-284) — the client's
        // bookkeeping call after deleting a version.
        return new Response(null, { status: 200 });
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (
      error instanceof NpmInvalidPackageError ||
      error instanceof NpmInvalidPackageNameError ||
      error instanceof NpmInvalidPackageVersionError ||
      error instanceof NpmInvalidAttachmentError ||
      error instanceof NpmInvalidIntegrityError ||
      error instanceof NpmDeprecateNoVersionsError
    ) {
      return npmErrorResponse(400, error.message); // the InvalidArgument arm
    }
    if (error instanceof NpmInvalidTagError) return npmErrorResponse(400, error.message); // errInvalidTagName
    if (error instanceof NpmDuplicateVersionError) return npmErrorResponse(409, error.message);
    if (error instanceof NpmLinkPermissionError) return npmErrorResponse(403, error.message);
    if (error instanceof NpmBodyTooLargeError) return npmErrorResponse(413, error.message);
    if (error instanceof PackageSizeMismatchError) {
      // A lying Content-Length truncates the JSON document — upstream's
      // non-InvalidArgument parse-failure arm (npm.go:186-188).
      return npmErrorResponse(500, "internal server error");
    }
    if (error instanceof PackageBlobTooLargeError) return npmErrorResponse(413, error.message);
    if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
      return npmErrorResponse(403, quotaMessage(error));
    }
    console.error("[packages-npm] request failed", error);
    return npmErrorResponse(500, "internal server error");
  }
}

/** The request body as a byte stream (an absent body is a closed stream). */
function bodyStream(request: Request): ReadableStream<Uint8Array> {
  return request.body as ReadableStream<Uint8Array> | null ?? emptyStream();
}

/** A closed zero-byte stream (a Content-Length: 0 body). */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

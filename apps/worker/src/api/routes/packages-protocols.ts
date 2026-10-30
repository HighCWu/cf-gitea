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
  PropertyType,
  deletePackageVersionAndReferences,
} from "../../services/packages/model";
import {
  buildDebianRepositoryKey,
  DebianInvalidArchitectureError,
  DebianInvalidDistOrComponentError,
  DebianInvalidNameError,
  DebianInvalidVersionError,
  DebianMissingControlError,
  DebianUnsupportedCompressionError,
  deleteDebianPackageFile,
  openDebianPoolFile,
  openDebianRepositoryFile,
  openDebianRepositoryFileByHash,
  uploadDebianPackage,
} from "../../services/packages/debian";
import {
  AlpineInvalidBranchError,
  AlpineInvalidNameError,
  AlpineInvalidVersionError,
  AlpineMissingPkginfoError,
  AlpinePackageInfoTooLargeError,
  buildAlpineRepositoryKey,
  deleteAlpinePackageFile,
  openAlpineIndexFile,
  openAlpinePackageFile,
  uploadAlpinePackage,
} from "../../services/packages/alpine";
import { getPackageProperties } from "../../services/packages/protocol-common";
import { PackageSizeMismatchError, PackageBlobTooLargeError, packageBlobContentKey } from "../../services/packages/blobs";
import { DuplicatePackageFileError } from "../../services/packages/generic";
import { contentDispositionAttachment, serveFileHeaderSet, servePackageFileResponse } from "../../services/packages/serve-content";
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
  CONTAINER_GHOST_USER_ID,
  ContainerBlobNotExistError,
  OciNamedError,
  OCI_BLOB_UPLOAD_INVALID,
  OCI_BLOB_UPLOAD_UNKNOWN,
  OCI_BLOB_UNKNOWN,
  OCI_DIGEST_INVALID,
  OCI_MANIFEST_UNKNOWN,
  OCI_NAME_INVALID,
  OCI_NAME_UNKNOWN,
  OCI_UNAUTHORIZED,
  appendContainerUploadChunk,
  containerBlobStoreSizeMatches,
  createContainerBlobUpload,
  deleteContainerBlob,
  finalizeContainerBlobUpload,
  getContainerBlob,
  getContainerBlobUpload,
  getContainerImageTags,
  getContainerManifestVersions,
  isContainerMediaTypeValid,
  isContainerBlobAccessible,
  isValidDigest,
  isValidImageName,
  isValidReference,
  listContainerRepositories,
  mintContainerToken,
  mountContainerBlob,
  putContainerManifest,
  removeContainerBlobUpload,
  saveContainerBlobFromStream,
  verifyContainerToken,
} from "../../services/packages/container";

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
  required: "read" | "write" | "none",
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
  // "none" — the nuget service-index carve-out (api.go:342-346): the
  // `GET /`, `/index.json` and `/$metadata` group sits OUTSIDE every
  // reqPackageAccess wrap ("Needs to be unauthenticated for the NuGet
  // client"), so upstream's UserAssignmentWeb still 404s an unknown
  // {username} and verifyAuth still authenticates without rejecting, but no
  // scope/access gate and no private-owner blindness run — a private owner's
  // index answers 200 to anonymous. Everything else keeps the gate stack.
  if (required !== "none") {
    if (ownerBlindToPublicOnly(owner, cred)) {
      throw new HTTPException(404, { res: plainResponse(404, userRedirectDoesNotExist(owner.username)) });
    }
    await protocolAccessGate(c.env.DB, required, owner, cred);
  }
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

/** The shared byte-serving shape (the generic router's serveDownload idiom —
 *  upstream helper.ServePackageFile → ctx.ServeContent: the review's D-6
 *  header set (nosniff/CSP/Cache-Control/expose-headers + the RFC 5987
 *  `filename*` disposition twin) plus the 304/412/416/206 machinery, served
 *  through serve-content.ts). */
function fileResponse(
  c: Context<{ Bindings: Env }>,
  download: { stream: ReadableStream; size: number; filename: string; created: Date },
  contentType?: string,
): Response {
  return servePackageFileResponse(
    c.req.raw,
    c.req.method === "HEAD" ? null : download.stream,
    { filename: download.filename, size: download.size, created: download.created, contentType },
  );
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
      // Upstream's HEAD-only branch runs SetServeHeaders WITHOUT the filename
      // (maven.go:216-219) — the D-6 header set but no Content-Disposition
      // and no byte-serving (http.ServeContent never runs there; always 200).
      // The GET arm is helper.ServePackageFile → ctx.ServeContent: the full
      // disposition + the 304/206 arms (review D-6).
      const serveOpts = {
        size: opened.size,
        created: opened.file.createdUnix,
        contentType: opened.contentType,
      };
      if (c.req.method === "HEAD") {
        return new Response(null, { status: 200, headers: serveFileHeaderSet(serveOpts) });
      }
      return servePackageFileResponse(c.req.raw, opened.stream, { ...serveOpts, filename: opened.file.name });
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

  // ServiceIndexV3 (nuget.go:69-86) — the unauthenticated service-index group
  // (api.go:342-346, review D-4/U-1): no read gate.
  app.get("/:username/nuget/index.json", async (c) => {
    try {
      const { owner } = await protocolContext(c, "none");
      const origin = new URL(c.req.url).origin;
      return new Response(JSON.stringify(createServiceIndexJson(nugetBaseOf(origin, owner.username))), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    } catch (error) {
      return nugetErrorResponse(error);
    }
  });

  // FeedCapabilityResource (nuget.go:89-91) — the static Edmx document; the
  // unauthenticated service-index group (api.go:342-346, review D-4/U-1).
  app.get("/:username/nuget/$metadata", async (c) => {
    try {
      await protocolContext(c, "none");
      return nugetXmlResponse(NUGET_EDMX_METADATA_XML);
    } catch (error) {
      return nugetErrorResponse(error);
    }
  });

  // ServiceIndexV2 (nuget.go:45-66) — the group's "/" shape; the
  // unauthenticated service-index group (api.go:342-346, review D-4/U-1).
  app.get("/:username/nuget", async (c) => {
    try {
      const { owner } = await protocolContext(c, "none");
      const origin = new URL(c.req.url).origin;
      return nugetXmlResponse(serviceIndexV2Xml(nugetBaseOf(origin, owner.username)));
    } catch (error) {
      return nugetErrorResponse(error);
    }
  });
  app.get("/:username/nuget/", async (c) => {
    try {
      const { owner } = await protocolContext(c, "none");
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

  // ------------------------------ DEBIAN (api.go:287-304) ------------------------------
  // The M7 index-builder family: the stored-index serving arms over the
  // internal `_debian` version + the pool upload/delete riders (the index
  // build rides the service, services/packages/debian.ts's posture note).

  app.get("/:username/debian/repository.key", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      const key = await buildDebianRepositoryKey(c.env.DB, owner.id);
      return new Response(key, {
        status: 200,
        headers: {
          "content-type": "application/pgp-keys",
          "content-disposition": contentDispositionAttachment("repository.key"),
        },
      });
    } catch (error) {
      return debianErrorResponse(error);
    }
  });

  // GetRepositoryFileByHash (debian.go:79-116) — the lookup ignores the
  // component/architecture context (a hash-only search, upstream's shape).
  const debianByHash = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const download = await openDebianRepositoryFileByHash(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        c.req.param("algorithm") ?? "",
        c.req.param("hash") ?? "",
      );
      if (download === null) return debianPlain(404, "package file does not exist");
      return fileResponse(c, download);
    } catch (error) {
      return debianErrorResponse(error);
    }
  };
  app.get("/:username/debian/dists/:distribution/:component/:architecture/by-hash/:algorithm/:hash", (c) => debianByHash(c));
  app.get("/:username/debian/dists/:distribution/by-hash/:algorithm/:hash", (c) => debianByHash(c));

  const debianRepositoryFile = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const distribution = c.req.param("distribution") ?? "";
      const component = c.req.param("component") ?? "";
      const architecture = (c.req.param("architecture") ?? "").replace(/^binary-/, "");
      const filename = c.req.param("filename") ?? "";
      const download = await openDebianRepositoryFile(c.env.DB, c.env.REPO_PACKS, owner, distribution, component, architecture, filename);
      if (download === null) return debianPlain(404, "package file does not exist");
      return fileResponse(c, download);
    } catch (error) {
      return debianErrorResponse(error);
    }
  };
  app.get("/:username/debian/dists/:distribution/:component/:architecture/:filename", (c) => debianRepositoryFile(c));
  app.get("/:username/debian/dists/:distribution/:filename", (c) => debianRepositoryFile(c));

  const debianPoolDownload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const file = c.req.param("file") ?? "";
      // The `{name}_{version}_{architecture}.deb` shape (debian.go:298) —
      // name/version never carry underscores (the GlobalVars patterns), so
      // the split is exact.
      const parts = file.replace(/\.deb$/, "").split("_");
      if (parts.length !== 3) return debianPlain(404, "package file does not exist");
      const [name, version, architecture] = parts as [string, string, string];
      const found = await openDebianPoolFile(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        c.req.param("distribution") ?? "",
        c.req.param("component") ?? "",
        name,
        version,
        architecture,
        c.req.method === "HEAD" ? "HEAD" : "GET",
      );
      if (found === null) return debianPlain(404, "package file does not exist");
      return fileResponse(c, found.download, "application/vnd.debian.binary-package");
    } catch (error) {
      return debianErrorResponse(error);
    }
  };
  app.get("/:username/debian/pool/:distribution/:component/:file", (c) => debianPoolDownload(c));
  app.on("HEAD", "/:username/debian/pool/:distribution/:component/:file", (c) => debianPoolDownload(c));

  app.put("/:username/debian/pool/:distribution/:component/upload", async (c) => {
    try {
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return debianPlain(401, "user should have specific permission or be a site admin");
      }
      await uploadDebianPackage({
        d1: c.env.DB,
        bucket: c.env.REPO_PACKS,
        owner,
        doer,
        distribution: c.req.param("distribution") ?? "",
        component: c.req.param("component") ?? "",
        content: bodyStream(c.req.raw),
        declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
        quota: packagesQuotaFromEnv(c.env),
      });
      return new Response(null, { status: 201 });
    } catch (error) {
      return debianErrorResponse(error);
    }
  });

  app.delete("/:username/debian/pool/:distribution/:component/:name/:version/:architecture", async (c) => {
    try {
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return debianPlain(401, "user should have specific permission or be a site admin");
      }
      const deleted = await deleteDebianPackageFile(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        c.req.param("distribution") ?? "",
        c.req.param("component") ?? "",
        c.req.param("name") ?? "",
        c.req.param("version") ?? "",
        c.req.param("architecture") ?? "",
      );
      if (!deleted) return debianPlain(404, "package file does not exist");
      return new Response(null, { status: 204 });
    } catch (error) {
      return debianErrorResponse(error);
    }
  });

  // ------------------------------ ALPINE (api.go:105-117) ------------------------------
  // The M7 index-builder family: the stored APKINDEX serving arms over the
  // internal `_alpine` version + the upload/delete riders (services/packages/
  // alpine.ts carries the two-stream signed-archive builder).

  app.get("/:username/alpine/key", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      const key = await buildAlpineRepositoryKey(c.env.DB, owner.id);
      // GetRepositoryKey (alpine.go:32-61): the PEM with the fingerprint
      // filename (`{lower}@{fingerprint}.rsa.pub`).
      return new Response(key.publicPem, {
        status: 200,
        headers: {
          "content-type": "application/x-pem-file",
          "content-disposition": contentDispositionAttachment(`${owner.usernameLower}@${key.fingerprint}.rsa.pub`),
        },
      });
    } catch (error) {
      return debianErrorResponse(error);
    }
  });

  app.put("/:username/alpine/:branch/:repository", async (c) => {
    try {
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return debianPlain(401, "user should have specific permission or be a site admin");
      }
      await uploadAlpinePackage({
        d1: c.env.DB,
        bucket: c.env.REPO_PACKS,
        owner,
        doer,
        branch: c.req.param("branch") ?? "",
        repository: c.req.param("repository") ?? "",
        content: bodyStream(c.req.raw),
        declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
        quota: packagesQuotaFromEnv(c.env),
      });
      return new Response(null, { status: 201 });
    } catch (error) {
      return debianErrorResponse(error);
    }
  });

  const alpineIndexDownload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const download = await openAlpineIndexFile(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        c.req.param("branch") ?? "",
        c.req.param("repository") ?? "",
        c.req.param("architecture") ?? "",
      );
      if (download === null) return debianPlain(404, "package file does not exist");
      return fileResponse(c, download);
    } catch (error) {
      return debianErrorResponse(error);
    }
  };
  // The static tail outranks the :filename arm (upstream registers the
  // APKINDEX route first within the architecture group, alpine.go:110).
  app.get("/:username/alpine/:branch/:repository/:architecture/APKINDEX.tar.gz", (c) => alpineIndexDownload(c));
  app.on("HEAD", "/:username/alpine/:branch/:repository/:architecture/APKINDEX.tar.gz", (c) => alpineIndexDownload(c));

  const alpinePackageDownload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const download = await openAlpinePackageFile(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        c.req.param("branch") ?? "",
        c.req.param("repository") ?? "",
        c.req.param("architecture") ?? "",
        c.req.param("filename") ?? "",
        c.req.method === "HEAD" ? "HEAD" : "GET",
      );
      if (download === null) return debianPlain(404, "package file does not exist");
      return fileResponse(c, download);
    } catch (error) {
      return debianErrorResponse(error);
    }
  };
  app.get("/:username/alpine/:branch/:repository/:architecture/:filename", (c) => alpinePackageDownload(c));
  app.on("HEAD", "/:username/alpine/:branch/:repository/:architecture/:filename", (c) => alpinePackageDownload(c));

  app.delete("/:username/alpine/:branch/:repository/:architecture/:filename", async (c) => {
    try {
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return debianPlain(401, "user should have specific permission or be a site admin");
      }
      const deleted = await deleteAlpinePackageFile(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        c.req.param("branch") ?? "",
        c.req.param("repository") ?? "",
        c.req.param("architecture") ?? "",
        c.req.param("filename") ?? "",
      );
      if (!deleted) return debianPlain(404, "package file does not exist");
      return new Response(null, { status: 204 });
    } catch (error) {
      return debianErrorResponse(error);
    }
  });
  return app;
}

// ---------------------------------------------------------------------------
// The M7 error/response helpers (the debian + alpine families share the
// plain-text apiError shape — debian.go:26-29 / alpine.go:27-30, both through
// helper.ProcessErrorForUser → ctx.PlainText)
// ---------------------------------------------------------------------------

/** The plain-text body with the upstream status (ctx.PlainText). */
function debianPlain(status: 400 | 401 | 403 | 404 | 409 | 411 | 413 | 500, message: string): Response {
  return plainResponse(status, message);
}

/** The family error mapper: the 400 InvalidArgument sentinels, the 409
 *  duplicate (the D-1 any-duplicate rule), the quota 403, the caps. */
function debianErrorResponse(error: unknown): Response {
  if (error instanceof HTTPException) throw error;
  if (
    error instanceof DebianMissingControlError ||
    error instanceof DebianUnsupportedCompressionError ||
    error instanceof DebianInvalidNameError ||
    error instanceof DebianInvalidVersionError ||
    error instanceof DebianInvalidArchitectureError ||
    error instanceof DebianInvalidDistOrComponentError ||
    error instanceof AlpineMissingPkginfoError ||
    error instanceof AlpineInvalidNameError ||
    error instanceof AlpineInvalidVersionError ||
    error instanceof AlpinePackageInfoTooLargeError ||
    error instanceof AlpineInvalidBranchError
  ) {
    return debianPlain(400, error.message);
  }
  if (error instanceof DuplicatePackageFileError) return debianPlain(409, "package file already exists");
  if (error instanceof PackageSizeMismatchError) return debianPlain(400, error.message);
  if (error instanceof PackageBlobTooLargeError) return debianPlain(413, error.message);
  if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
    return debianPlain(403, quotaMessage(error));
  }
  console.error("[packages-distro] request failed", error);
  return debianPlain(500, "internal server error");
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

// ---------------------------------------------------------------------------
// The OCI CONTAINER registry (SPEC-0016 §7 M6) — upstream ContainerRoutes
// (routers/api/packages/api.go:509-547), the /v2/ ROOT mount. src/index.ts
// mounts this router beside the packages mounts (`app.route("/v2",
// createContainerProtocolRouter())`) and wrangler.jsonc.example pins
// "/v2/*" in run_worker_first — both orchestrator-owned files (HANDOFF).
//
// Wire shapes (container.go:53-130): EVERY response carries the
// Docker-Distribution-Api-Version header; the header quartet Location /
// Range / Content-Length / Docker-Upload-Uuid rides the upload arms, the
// Docker-Content-Digest + ETag pair the content arms; error BODIES are the
// OCI envelope `{"errors":[{"code","message"}]}` (errors.go) while the
// apiError arms (quota 403, bare 500) answer the bare status with NO body
// (container.go:90-93 discards ProcessErrorForUser's message). The 401
// handshake serves the Bearer realm challenge plus — when the {username}
// owner exists and is non-public — the Basic realm twin (container.go:116-130,
// the apple-container login support); the access-denied arms reuse the
// neighbors' Gitea-Package-API challenge verbatim (upstream's shared
// reqPackageAccess, api.go:43-63).
//
// The credential pass (api.go:512-515's {Basic, Auth{AllowGhostUser}}):
// Basic → the PAT verify (a FAILED Basic verifies as ANONYMOUS, upstream
// basic.go's nil-nil posture — the /token arm then mints the ghost token);
// Bearer → the family's HS256 JWT ONLY (a Bearer PAT is NOT a container
// credential — upstream packages/auth.go parses every Bearer as the JWT);
// absent → anonymous. The ghost token (userId -1) passes
// ReqContainerAccess but stays anonymous in the access ladder
// (package.go:135-155's !doer.IsGhost() guards).
// ---------------------------------------------------------------------------

interface ContainerHeaderOpts {
  location?: string;
  /** The RFC 5988 pagination Link (catalog + tag list rel="next"). */
  link?: string;
  range?: string;
  contentLength?: number;
  uploadUuid?: string;
  contentDigest?: string;
  contentType?: string;
  /** WWW-Authenticate values APPENDED in order (the handshake's pair). */
  wwwAuthenticate?: string[];
}

/** writeResponseHeaders (container.go:63-82) + jsonResponse's content-type. */
function containerResponse(status: number, body: BodyInit | null, opts: ContainerHeaderOpts = {}): Response {
  const headers = new Headers();
  if (opts.contentType !== undefined) headers.set("Content-Type", opts.contentType);
  if (opts.location !== undefined && opts.location !== "") headers.set("Location", opts.location);
  if (opts.link !== undefined && opts.link !== "") headers.set("Link", opts.link);
  if (opts.range !== undefined && opts.range !== "") headers.set("Range", opts.range);
  if (opts.contentLength !== undefined) headers.set("Content-Length", String(opts.contentLength));
  if (opts.uploadUuid !== undefined && opts.uploadUuid !== "") headers.set("Docker-Upload-Uuid", opts.uploadUuid);
  if (opts.contentDigest !== undefined && opts.contentDigest !== "") {
    headers.set("Docker-Content-Digest", opts.contentDigest);
    headers.set("ETag", `"${opts.contentDigest}"`);
  }
  headers.set("Docker-Distribution-Api-Version", "registry/2.0");
  for (const value of opts.wwwAuthenticate ?? []) {
    headers.append("WWW-Authenticate", value);
  }
  return new Response(body, { status, headers });
}

/** apiErrorDefined (container.go:96-114) — the OCI error envelope. */
function ociErrorResponse(error: OciNamedError, wwwAuthenticate?: string[]): Response {
  return containerResponse(error.statusCode, JSON.stringify({ errors: [{ code: error.code, message: error.message }] }), {
    contentType: "application/json",
    wwwAuthenticate,
  });
}

/** APIUnauthorizedError (container.go:116-130): the Bearer realm (the origin
 *  root — no sub-path to strip) + the Basic twin when the owner exists and is
 *  non-public. */
function containerUnauthorizedResponse(origin: string, owner: UserRow | null): Response {
  const challenges = [
    `Bearer realm="${origin}/v2/token",service="container_registry",scope="*"`,
    ...(owner !== null && owner.visibility !== "public" ? ['Basic realm="Gitea Container Registry"'] : []),
  ];
  return ociErrorResponse(OCI_UNAUTHORIZED, challenges);
}

type ContainerCredential =
  | { kind: "anonymous" }
  | { kind: "ghost" }
  | { kind: "user"; doer: AuthUser; scope: ScopeSet | null };

/**
 * The container credential pass. null = INVALID credential (a Bearer that
 * fails the JWT verify — upstream packages/auth.go's error return → the
 * afterAuthCallback handshake). A failed BASIC verifies as anonymous
 * (upstream basic.go's nil-nil), NOT as invalid.
 */
async function resolveContainerCredential(d1: D1Database, request: Request): Promise<ContainerCredential | null> {
  const header = request.headers.get("Authorization");
  if (header === null) return { kind: "anonymous" };
  const parsed = parseAuthorizationHeader(header);
  if (parsed === null) return { kind: "anonymous" };
  if (parsed.basicAuth !== null) {
    const credential = basicAuthTokenCandidate(parsed.basicAuth);
    const verified = await new TokenService(d1).verify(credential, { now: new Date() });
    if (verified === null) return { kind: "anonymous" };
    return { kind: "user", doer: verified.user, scope: ScopeSet.parseLenient(verified.token.scopes) };
  }
  const claims = await verifyContainerToken(d1, parsed.bearerToken?.token ?? "");
  if (claims === null) return null;
  if (claims.userId === CONTAINER_GHOST_USER_ID) return { kind: "ghost" };
  const row = (await drizzle(d1).select().from(users).where(eq(users.id, claims.userId)).get()) ?? null;
  if (row === null || row.status !== "active") return null;
  return {
    kind: "user",
    doer: rowToAuthUser(row),
    scope: ScopeSet.parseLenient(claims.scope),
  };
}

/** The AuthUser projection of a users row (the auth middleware's converter). */
function rowToAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    usernameLower: row.usernameLower,
    email: row.email,
    displayName: row.displayName,
    location: row.location,
    website: row.website,
    description: row.description,
    isAdmin: row.isAdmin,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/** The gate failure = the neighbors' challenge verbatim (upstream's shared
 *  reqPackageAccess answers the same 401 + Basic realm + plain body,
 *  api.go:51-61). */
function containerGateContext(owner: UserRow, doer: AuthUser | null, scope: ScopeSet | null): ResolvedCredential {
  return { doer, scope };
}

/**
 * The container family's gate arms carry their response as a VALUE, never as
 * a thrown HTTPException: the root app's onError override (src/index.ts:91)
 * renders every unhandled error as the 500 chrome and has no
 * HTTPException passthrough — a thrown challenge would die as a 500 on the
 * live deployment (the six older families ride the same landmine; flagged to
 * the orchestrator). The dispatcher unwraps these one frame down.
 */
class ContainerGateResponse extends Error {
  constructor(readonly response: Response) {
    super("container gate response");
    this.name = "ContainerGateResponse";
  }
}

/**
 * The {username}-group preamble: the plain-404 owner resolution
 * (UserAssignmentWeb), the public-only blindness, then the shared gate
 * (protocolAccessGate — scope then access mode, the reqPackageAccess port).
 * Ghost/anonymous doers reach the gate with doer=null (the ladder's
 * anonymous arm — package.go's IsGhost guards).
 */
async function containerOwnerContext(
  c: Context<{ Bindings: Env }>,
  required: "read" | "write",
): Promise<{ owner: UserRow; doer: AuthUser | null; ghost: boolean }> {
  if (packagesDisabled(c.env)) {
    throw new ContainerGateResponse(plainResponse(404, "not found"));
  }
  const origin = new URL(c.req.url).origin;
  const cred = await resolveContainerCredential(c.env.DB, c.req.raw);
  if (cred === null) {
    // Upstream's afterAuthCallback looks the owner up from the path param
    // for the challenge (container.go:121-128) — a private owner's path
    // adds the Basic realm twin even on an auth-layer failure.
    const challengeOwner = await resolveOwnerRow(c.env.DB, containerUsername(c));
    throw new ContainerGateResponse(containerUnauthorizedResponse(origin, challengeOwner));
  }
  const username = containerUsername(c);
  const owner = await resolveOwnerRow(c.env.DB, username);
  if (owner === null) {
    throw new ContainerGateResponse(plainResponse(404, userRedirectDoesNotExist(username)));
  }
  const doer = cred.kind === "user" ? cred.doer : null;
  const scope = cred.kind === "user" ? cred.scope : null;
  const resolved = containerGateContext(owner, doer, scope);
  if (ownerBlindToPublicOnly(owner, resolved)) {
    throw new ContainerGateResponse(plainResponse(404, userRedirectDoesNotExist(owner.username)));
  }
  try {
    await protocolAccessGate(c.env.DB, required, owner, resolved);
  } catch (error) {
    // The shared gate throws the families' HTTPException challenge — carry
    // its prepared response (upstream reqPackageAccess's 401, api.go:51-61).
    if (error instanceof HTTPException) {
      throw new ContainerGateResponse(error.getResponse());
    }
    throw error;
  }
  return { owner, doer, ghost: cred.kind === "ghost" };
}

/** VerifyImageName (container.go:140-144). */
function verifyContainerImageName(image: string): void {
  if (!isValidImageName(image)) {
    throw OCI_NAME_INVALID;
  }
}

/** The dispatcher's username (segments[1], decoded once — the raw path is
 *  NOT param-decoded on a wildcard registration; upstream's chi params
 *  arrive decoded). */
function containerUsername(c: Context<{ Bindings: Env }>): string {
  const segments = c.req.path.split("/").filter((segment) => segment !== "");
  return decodeSegment(segments[1] ?? "");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The container family's error mapper (the catch-all the dispatcher wraps). */
function containerErrorResponse(error: unknown): Response {
  if (error instanceof HTTPException) throw error;
  if (error instanceof ContainerGateResponse) return error.response;
  if (error instanceof OciNamedError) return ociErrorResponse(error);
  // The manifest PUT's missing config/layer → BLOB_UNKNOWN (container.go:589-590);
  // the manifest GET arms catch their own NotExist first (MANIFEST_UNKNOWN).
  if (error instanceof ContainerBlobNotExistError) return ociErrorResponse(OCI_BLOB_UNKNOWN);
  // apiError(ctx, 403/413/500, err) — the BARE status, message discarded
  // (container.go:90-93).
  if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
    return containerResponse(403, null);
  }
  if (error instanceof PackageBlobTooLargeError) return containerResponse(413, null);
  if (error instanceof PackageSizeMismatchError) return containerResponse(500, null);
  console.error("[packages-container] request failed", error);
  return containerResponse(500, null);
}

/** container.go:188-193 — the chunked-upload range header's start offset. */
function parseContentRangeStart(contentRange: string): number | null {
  const match = /^(\d+)-(\d+)$/.exec(contentRange.trim());
  if (match === null) return null;
  const start = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(start) ? start : null;
}

/** The manifest search options from a reference (container.go:608-626) — a
 *  digest reference or a tag (lead-only); anything else is the
 *  MANIFEST_UNKNOWN arm. */
function containerManifestSearchReference(reference: string): { digest?: string; tag?: string } | null {
  if (isValidDigest(reference)) {
    return { digest: reference };
  }
  if (isValidReference(reference)) {
    return { tag: reference };
  }
  return null;
}

/** The stored media-type property of a manifest file (container.go:638-639 —
 *  the fallback to application/octet-stream when absent or unrecognized). */
async function containerManifestContentType(d1: D1Database, fileId: number): Promise<string> {
  const properties = await getPackageProperties(d1, PropertyType.File, fileId);
  const stored = properties.find((property) => property.name === "container.mediatype")?.value ?? "";
  return isContainerMediaTypeValid(stored) ? stored : "application/octet-stream";
}

/**
 * The /v2 dispatcher. Hono params cannot span the image's slashes (nested
 * repo paths — upstream's `<image:*>`), so the router catches the whole tail
 * with a wildcard and the grammar is walked segment-by-segment (the npm
 * family's parseTarget pattern). Mount-agnostic: the leading segment is the
 * mount prefix and is ignored. The zero-rest GET is the /v2/ ping (the ""
 * registration covers the bare /v2 — Hono's route() merge collapses the "/"
 * sub-path onto the mount point, so the trailing-slash shape arrives HERE).
 */
async function containerDispatch(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const segments = c.req.path.split("/").filter((segment) => segment !== "");
    const rest = segments.slice(2);
    const method = c.req.method;
    const notFound = (): Response => plainResponse(404, "404 page not found\n");

    if (rest.length === 0) {
      if (method === "GET") return containerPing(c);
      return notFound();
    }
    if (rest.length < 2) return notFound();

    // POST <image>/blobs/uploads (api.go:527)
    if (
      method === "POST" &&
      rest[rest.length - 1] === "uploads" &&
      rest[rest.length - 2] === "blobs"
    ) {
      const image = rest.slice(0, -2).join("/");
      verifyContainerImageName(image);
      return await containerPostBlobUploads(c, image);
    }
    // GET <image>/tags/list (api.go:528)
    if (method === "GET" && rest[rest.length - 1] === "list" && rest[rest.length - 2] === "tags") {
      const image = rest.slice(0, -2).join("/");
      verifyContainerImageName(image);
      return await containerGetTagsList(c, image);
    }
    // <image>/blobs/uploads/<uuid> GET/PATCH/PUT/DELETE (api.go:530-534)
    if (rest.length >= 4 && rest[rest.length - 2] === "uploads" && rest[rest.length - 3] === "blobs") {
      const maybeUuid = rest[rest.length - 1];
      if (maybeUuid !== undefined && maybeUuid !== "" && ["GET", "PATCH", "PUT", "DELETE"].includes(method)) {
        const image = rest.slice(0, -3).join("/");
        verifyContainerImageName(image);
        return await containerBlobUploadSession(c, method, image, maybeUuid);
      }
    }
    // <image>/blobs/<digest> HEAD/GET/DELETE (api.go:536-538)
    if (["HEAD", "GET", "DELETE"].includes(method) && rest[rest.length - 2] === "blobs" && rest[rest.length - 1] !== "uploads") {
      const digest = rest[rest.length - 1] ?? "";
      const image = rest.slice(0, -2).join("/");
      verifyContainerImageName(image);
      return await containerBlobContent(c, method, image, digest);
    }
    // <image>/manifests/<reference> HEAD/GET/PUT/DELETE (api.go:540-543)
    if (["HEAD", "GET", "PUT", "DELETE"].includes(method) && rest[rest.length - 2] === "manifests") {
      const reference = rest[rest.length - 1] ?? "";
      const image = rest.slice(0, -2).join("/");
      verifyContainerImageName(image);
      return await containerManifest(c, method, image, reference);
    }
    return notFound();
  } catch (error) {
    return containerErrorResponse(error);
  }
}

// The individual arms — thin over services/packages/container.ts.

/** DetermineSupport (container.go:148-150) behind ReqContainerAccess
 *  (:133-137). */
async function containerPing(c: Context<{ Bindings: Env }>): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  const cred = await resolveContainerCredential(c.env.DB, c.req.raw);
  if (cred === null || cred.kind === "anonymous") {
    return containerUnauthorizedResponse(origin, null);
  }
  return containerResponse(200, null);
}

/** Authenticate (container.go:154-187) — the ghost mint for anonymous, the
 *  package-scope gate for real users, the 401 for ghost/invalid bearers. */
async function containerToken(c: Context<{ Bindings: Env }>): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  const d1 = c.env.DB;
  const cred = await resolveContainerCredential(d1, c.req.raw);
  if (cred === null) {
    return containerUnauthorizedResponse(origin, null);
  }
  if (cred.kind === "user") {
    const scope = cred.scope;
    // container.go:165-176 — HasAnyScope(read:package, write:package, all).
    if (scope === null || !scope.hasAny("read:package", "write:package", "all")) {
      return containerUnauthorizedResponse(origin, null);
    }
    const token = await mintContainerToken(d1, cred.doer.id, verifiedScopeString(cred));
    return containerResponse(200, JSON.stringify({ token }), { contentType: "application/json" });
  }
  if (cred.kind === "anonymous") {
    // container.go:157-163 — the ghost token (no RequireSignInViewStrict).
    const token = await mintContainerToken(d1, CONTAINER_GHOST_USER_ID, "");
    return containerResponse(200, JSON.stringify({ token }), { contentType: "application/json" });
  }
  // A ghost/invalid bearer at /token: upstream's ghost doer carries no
  // scope → the HasAnyScope gate 401s (container.go:165-176).
  return containerUnauthorizedResponse(origin, null);
}

/** The mint-time scope string (the PAT's normalized scope — upstream's
 *  GetAccessScope answer). */
function verifiedScopeString(cred: Extract<ContainerCredential, { kind: "user" }>): string {
  return cred.scope?.toString() ?? "";
}

/** AuthenticateNotImplemented (container.go:190-198) — the 404 stub. */
function containerTokenPost(): Response {
  return containerResponse(404, null);
}

/** GetRepositoryList (container.go:201-231) — the catalog. */
async function containerCatalog(c: Context<{ Bindings: Env }>): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  const cred = await resolveContainerCredential(c.env.DB, c.req.raw);
  if (cred === null || cred.kind === "anonymous") {
    return containerUnauthorizedResponse(origin, null);
  }
  let n = 100;
  const rawN = c.req.query("n");
  if (rawN !== undefined && rawN !== "") {
    const parsed = Number.parseInt(rawN, 10);
    n = Number.isSafeInteger(parsed) ? parsed : 0;
  }
  if (n <= 0 || n > 100) n = 100;
  const last = c.req.query("last") ?? "";
  const viewer = cred.kind === "user" ? { id: cred.doer.id, isAdmin: cred.doer.isAdmin } : null;
  const repositories = await listContainerRepositories(c.env.DB, viewer, n, last);
  if (repositories.length === n) {
    // container.go:218-226 — the Link rel="next" header.
    const v = new URLSearchParams();
    v.set("n", String(n));
    v.set("last", repositories[repositories.length - 1] ?? "");
    return containerResponse(200, JSON.stringify({ repositories }), {
      contentType: "application/json",
      link: `</v2/_catalog?${v.toString()}>; rel="next"`,
    });
  }
  return containerResponse(200, JSON.stringify({ repositories }), { contentType: "application/json" });
}


/** PostBlobsUploads (container.go:236-321) — mount / single-POST / session. */
async function containerPostBlobUploads(c: Context<{ Bindings: Env }>, image: string): Promise<Response> {
  const { owner, doer } = await containerOwnerContext(c, "write");
  const d1 = c.env.DB;
  const bucket = c.env.REPO_PACKS;
  const quota = packagesQuotaFromEnv(c.env);
  const lowerName = owner.usernameLower;
  const doerOrNull = doer === null ? null : { id: doer.id, isAdmin: doer.isAdmin };

  // The cross-repo mount (container.go:239-267): the source search is
  // owner-UNSCOPED (the repository property names owner/image); an
  // inaccessible or missing source falls through to the normal flow.
  const mount = c.req.query("mount") ?? "";
  if (mount !== "") {
    const from = c.req.query("from") ?? "";
    let descriptor: Awaited<ReturnType<typeof getContainerBlob>> | null = null;
    try {
      descriptor = await getContainerBlob(d1, { repository: from, digest: mount });
    } catch (error) {
      if (!(error instanceof ContainerBlobNotExistError)) throw error;
    }
    if (descriptor !== null && (await containerBlobStoreSizeMatches(bucket, descriptor.blob)) && (await isContainerBlobAccessible(d1, descriptor, doerOrNull))) {
      await mountContainerBlob(d1, { id: owner.id, usernameLower: lowerName, visibility: owner.visibility, type: owner.type }, image, descriptor.blob);
      return containerResponse(201, null, {
        location: `/v2/${lowerName}/${image}/blobs/${mount}`,
        contentDigest: mount,
      });
    }
  }

  // The single-POST arm (container.go:269-308).
  const digest = c.req.query("digest") ?? "";
  if (digest !== "") {
    await saveContainerBlobFromStream({
      d1,
      bucket,
      owner: { id: owner.id, usernameLower: lowerName, visibility: owner.visibility, type: owner.type },
      doer: doer === null ? { id: 0, isAdmin: false } : { id: doer.id, isAdmin: doer.isAdmin },
      image,
      digest,
      content: bodyStream(c.req.raw),
      declaredLength: contentLength(c.req.raw) ?? undefined,
      quota,
    });
    return containerResponse(201, null, {
      location: `/v2/${lowerName}/${image}/blobs/${digest}`,
      contentDigest: digest,
    });
  }

  // The chunked-upload session (container.go:310-320).
  const upload = await createContainerBlobUpload(d1);
  return containerResponse(202, null, {
    location: `/v2/${lowerName}/${image}/blobs/uploads/${upload.id}`,
    uploadUuid: upload.id,
  });
}

/** GetBlobsUpload (container.go:324-348) — the session status probe. */
async function containerGetBlobsUpload(c: Context<{ Bindings: Env }>, image: string, uuid: string): Promise<Response> {
  const { owner } = await containerOwnerContext(c, "write");
  const upload = await getContainerBlobUpload(c.env.DB, uuid);
  if (upload === null) {
    return ociErrorResponse(OCI_BLOB_UPLOAD_UNKNOWN);
  }
  const lowerName = owner.usernameLower;
  return containerResponse(204, null, {
    location: `/v2/${lowerName}/${image}/blobs/uploads/${upload.id}`,
    uploadUuid: upload.id,
    range: upload.bytesReceived > 0 ? `0-${upload.bytesReceived - 1}` : undefined,
  });
}

/** PatchBlobsUpload (container.go:352-397) — the chunk append. */
async function containerPatchBlobsUpload(c: Context<{ Bindings: Env }>, image: string, uuid: string): Promise<Response> {
  const { owner } = await containerOwnerContext(c, "write");
  const upload = await getContainerBlobUpload(c.env.DB, uuid);
  if (upload === null) {
    return ociErrorResponse(OCI_BLOB_UPLOAD_UNKNOWN);
  }
  const contentRange = c.req.raw.headers.get("Content-Range");
  if (contentRange !== null && contentRange !== "") {
    const start = parseContentRangeStart(contentRange);
    if (start === null) {
      return ociErrorResponse(OCI_BLOB_UPLOAD_INVALID);
    }
    if (start !== upload.bytesReceived) {
      return ociErrorResponse(OCI_BLOB_UPLOAD_INVALID.withStatusCode(416));
    }
  } else if (upload.bytesReceived !== 0) {
    return ociErrorResponse(OCI_BLOB_UPLOAD_INVALID.withMessage("Stream uploads after first write are not allowed"));
  }
  const appended = await appendContainerUploadChunk(
    c.env.DB,
    c.env.REPO_PACKS,
    upload.id,
    bodyStream(c.req.raw),
    contentLength(c.req.raw) ?? undefined,
  );
  return containerResponse(202, null, {
    location: `/v2/${owner.usernameLower}/${image}/blobs/uploads/${upload.id}`,
    uploadUuid: upload.id,
    range: appended.bytesReceived > 0 ? `0-${appended.bytesReceived - 1}` : undefined,
  });
}

/** PutBlobsUpload (container.go:400-466) — the finalize. */
async function containerPutBlobsUpload(c: Context<{ Bindings: Env }>, image: string, uuid: string): Promise<Response> {
  const { owner, doer } = await containerOwnerContext(c, "write");
  const digest = c.req.query("digest") ?? "";
  if (digest === "") {
    return ociErrorResponse(OCI_DIGEST_INVALID);
  }
  const upload = await getContainerBlobUpload(c.env.DB, uuid);
  if (upload === null) {
    return ociErrorResponse(OCI_BLOB_UPLOAD_UNKNOWN);
  }
  const finalBody = c.req.raw.body;
  await finalizeContainerBlobUpload({
    d1: c.env.DB,
    bucket: c.env.REPO_PACKS,
    owner: { id: owner.id, usernameLower: owner.usernameLower, visibility: owner.visibility, type: owner.type },
    doer: doer === null ? { id: 0, isAdmin: false } : { id: doer.id, isAdmin: doer.isAdmin },
    image,
    upload,
    digest,
    finalChunk:
      finalBody !== null
        ? { content: finalBody as ReadableStream<Uint8Array>, declaredLength: contentLength(c.req.raw) ?? undefined }
        : undefined,
    quota: packagesQuotaFromEnv(c.env),
  });
  return containerResponse(201, null, {
    location: `/v2/${owner.usernameLower}/${image}/blobs/${digest}`,
    contentDigest: digest,
  });
}

/** DeleteBlobsUpload (container.go:469-488) — the abort. */
async function containerDeleteBlobsUpload(c: Context<{ Bindings: Env }>, uuid: string): Promise<Response> {
  await containerOwnerContext(c, "write");
  const upload = await getContainerBlobUpload(c.env.DB, uuid);
  if (upload === null) {
    return ociErrorResponse(OCI_BLOB_UPLOAD_UNKNOWN);
  }
  await removeContainerBlobUpload(c.env.DB, c.env.REPO_PACKS, uuid);
  return containerResponse(204, null);
}

/** The session-arms router (api.go:530-534 — the pattern carries write on
 *  ALL FOUR methods). */
async function containerBlobUploadSession(
  c: Context<{ Bindings: Env }>,
  method: string,
  image: string,
  uuid: string,
): Promise<Response> {
  switch (method) {
    case "GET":
      return containerGetBlobsUpload(c, image, uuid);
    case "PATCH":
      return containerPatchBlobsUpload(c, image, uuid);
    case "PUT":
      return containerPutBlobsUpload(c, image, uuid);
    default:
      return containerDeleteBlobsUpload(c, uuid);
  }
}

/** getBlobFromContext (container.go:490-501) + the store-size gate
 *  (getExistingContainerBlob, :781-796). */
async function containerBlobFromContext(
  d1: D1Database,
  bucket: R2Bucket,
  ownerId: number,
  image: string,
  digest: string,
): Promise<Awaited<ReturnType<typeof getContainerBlob>>> {
  if (!isValidDigest(digest)) {
    throw new ContainerBlobNotExistError();
  }
  const descriptor = await getContainerBlob(d1, { ownerId, image, digest });
  if (!(await containerBlobStoreSizeMatches(bucket, descriptor.blob))) {
    throw new ContainerBlobNotExistError();
  }
  return descriptor;
}

/** HeadBlob + GetBlob (container.go:504-536). */
async function containerBlobContent(c: Context<{ Bindings: Env }>, method: string, image: string, digest: string): Promise<Response> {
  const { owner } = await containerOwnerContext(c, method === "DELETE" ? "write" : "read");
  const d1 = c.env.DB;
  if (method === "DELETE") {
    // DeleteBlob (container.go:539-552) — the invalid digest is the
    // BLOB_UNKNOWN arm here (the validate-then-delete order, :540-543).
    if (!isValidDigest(digest)) {
      return ociErrorResponse(OCI_BLOB_UNKNOWN);
    }
    await deleteContainerBlob(d1, owner.id, image, digest);
    return containerResponse(202, null);
  }
  const descriptor = await containerBlobFromContext(d1, c.env.REPO_PACKS, owner.id, image, digest);
  const digestProperty = descriptor.blob.hashSha256 === "" ? "" : `sha256:${descriptor.blob.hashSha256}`;
  if (method === "HEAD") {
    // container.go:514-519 — application/octet-stream + the length + digest.
    return containerResponse(200, null, {
      contentType: "application/octet-stream",
      contentLength: descriptor.blob.size,
      contentDigest: digestProperty,
    });
  }
  // GetBlob (container.go:523-536) — always 200 full-body (upstream serveBlob
  // io.Copy's with no range/conditional machinery; we do not advertise
  // Accept-Ranges so resuming clients fall back per RFC 7233).
  const object = await c.env.REPO_PACKS.get(packageBlobContentKey(descriptor.blob.hashSha256));
  if (object === null) {
    return ociErrorResponse(OCI_BLOB_UNKNOWN);
  }
  return containerResponse(200, object.body, {
    contentType: "application/octet-stream",
    contentLength: descriptor.blob.size,
    contentDigest: digestProperty,
  });
}

/** PutManifest (container.go:555-606). */
async function containerPutManifest(c: Context<{ Bindings: Env }>, image: string, reference: string): Promise<Response> {
  const { owner, doer } = await containerOwnerContext(c, "write");
  const result = await putContainerManifest({
    d1: c.env.DB,
    bucket: c.env.REPO_PACKS,
    owner: { id: owner.id, usernameLower: owner.usernameLower, visibility: owner.visibility, type: owner.type },
    doer: doer === null ? { id: 0, isAdmin: false } : { id: doer.id, isAdmin: doer.isAdmin },
    image,
    reference,
    contentType: c.req.header("Content-Type") ?? "",
    content: bodyStream(c.req.raw),
    declaredLength: contentLength(c.req.raw) ?? undefined,
    quota: packagesQuotaFromEnv(c.env),
  });
  return containerResponse(201, null, {
    location: `/v2/${owner.usernameLower}/${image}/manifests/${reference}`,
    contentDigest: result.digest,
  });
}

/** getManifestFromContext (container.go:628-641) + the store-size gate. */
async function containerManifestFromContext(
  c: Context<{ Bindings: Env }>,
  ownerId: number,
  image: string,
  reference: string,
): Promise<{ descriptor: Awaited<ReturnType<typeof getContainerBlob>>; contentType: string; digestProperty: string }> {
  const search = containerManifestSearchReference(reference);
  if (search === null) {
    throw new ContainerBlobNotExistError();
  }
  const descriptor = await getContainerBlob(c.env.DB, {
    ownerId,
    image,
    digest: search.digest,
    tag: search.tag,
    isManifest: true,
    onlyLead: search.tag !== undefined,
  });
  if (!(await containerBlobStoreSizeMatches(c.env.REPO_PACKS, descriptor.blob))) {
    throw new ContainerBlobNotExistError();
  }
  return {
    descriptor,
    contentType: await containerManifestContentType(c.env.DB, descriptor.file.id),
    digestProperty: `sha256:${descriptor.blob.hashSha256}`,
  };
}

/** HeadManifest + GetManifest (container.go:644-674). */
async function containerGetOrHeadManifest(c: Context<{ Bindings: Env }>, method: string, image: string, reference: string): Promise<Response> {
  const { owner } = await containerOwnerContext(c, "read");
  let found: Awaited<ReturnType<typeof containerManifestFromContext>>;
  try {
    found = await containerManifestFromContext(c, owner.id, image, reference);
  } catch (error) {
    // container.go:647-648 / :666-667 — the not-exist arm is MANIFEST_UNKNOWN
    // on the pull arms.
    if (error instanceof ContainerBlobNotExistError) {
      return ociErrorResponse(OCI_MANIFEST_UNKNOWN);
    }
    throw error;
  }
  if (method === "HEAD") {
    return containerResponse(200, null, {
      contentType: found.contentType,
      contentLength: found.descriptor.blob.size,
      contentDigest: found.digestProperty,
    });
  }
  const object = await c.env.REPO_PACKS.get(packageBlobContentKey(found.descriptor.blob.hashSha256));
  if (object === null) {
    return ociErrorResponse(OCI_MANIFEST_UNKNOWN);
  }
  return containerResponse(200, object.body, {
    contentType: found.contentType,
    contentLength: found.descriptor.blob.size,
    contentDigest: found.digestProperty,
  });
}

/** DeleteManifest (container.go:678-704). */
async function containerDeleteManifest(c: Context<{ Bindings: Env }>, image: string, reference: string): Promise<Response> {
  const { owner } = await containerOwnerContext(c, "write");
  const search = containerManifestSearchReference(reference);
  if (search === null) {
    return ociErrorResponse(OCI_MANIFEST_UNKNOWN);
  }
  const versions = await getContainerManifestVersions(c.env.DB, {
    ownerId: owner.id,
    image,
    digest: search.digest,
    tag: search.tag,
    isManifest: true,
    onlyLead: search.tag !== undefined,
  });
  if (versions.length === 0) {
    return ociErrorResponse(OCI_MANIFEST_UNKNOWN);
  }
  for (const version of versions) {
    await deletePackageVersionAndReferences(c.env.DB, version.id);
  }
  return containerResponse(202, null);
}

/** The manifest-arms router (api.go:540-543). */
async function containerManifest(c: Context<{ Bindings: Env }>, method: string, image: string, reference: string): Promise<Response> {
  switch (method) {
    case "PUT":
      return containerPutManifest(c, image, reference);
    case "DELETE":
      return containerDeleteManifest(c, image, reference);
    default:
      return containerGetOrHeadManifest(c, method, image, reference);
  }
}

/** GetTagsList (container.go:735-778). */
async function containerGetTagsList(c: Context<{ Bindings: Env }>, image: string): Promise<Response> {
  const { owner } = await containerOwnerContext(c, "read");
  const pkg = await getPackageByName(c.env.DB, owner.id, "container", image);
  if (pkg === null) {
    return ociErrorResponse(OCI_NAME_UNKNOWN);
  }
  const rawN = c.req.query("n");
  let n = -1;
  if (rawN !== undefined && rawN !== "") {
    const parsed = Number.parseInt(rawN, 10);
    n = Number.isSafeInteger(parsed) ? parsed : 0;
  }
  const last = c.req.query("last") ?? "";
  const tags = await getContainerImageTags(c.env.DB, owner.id, image, n, last);
  if (tags.length > 0) {
    const v = new URLSearchParams();
    if (n > 0) {
      v.set("n", String(n));
    }
    v.set("last", tags[tags.length - 1] ?? "");
    return containerResponse(200, JSON.stringify({ name: `${owner.usernameLower}/${image.toLowerCase()}`, tags }), {
      contentType: "application/json",
      link: `</v2/${owner.usernameLower}/${image}/tags/list?${v.toString()}>; rel="next"`,
    });
  }
  return containerResponse(200, JSON.stringify({ name: `${owner.usernameLower}/${image.toLowerCase()}`, tags }), {
    contentType: "application/json",
  });
}

/**
 * The /v2 sub-app (api.go:509-547) — src/index.ts mounts it at the ROOT
 * (`app.route("/v2", …)`). The statics (/token, /_catalog, the bare /v2
 * ping) outrank the wildcard in Hono's router; everything else reaches the
 * grammar dispatcher (including the /v2/ trailing-slash ping — see the
 * dispatcher's note).
 */
export function createContainerProtocolRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.get("", (c) => containerPing(c));
  app.get("/token", (c) => containerToken(c));
  app.post("/token", () => containerTokenPost());
  app.get("/_catalog", (c) => containerCatalog(c));
  app.on(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], "/*", (c) => containerDispatch(c));
  return app;
}

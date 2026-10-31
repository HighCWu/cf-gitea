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
  DuplicatePackageVersionError,
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
import {
  ArchInvalidArchitectureError,
  ArchInvalidNameError,
  ArchInvalidVersionError,
  ArchMissingPkginfoError,
  ArchPkginfoTooLargeError,
  ArchTooManyFileEntriesError,
  ArchUnsupportedFormatError,
  buildArchRepositoryKey,
  deleteArchPackageVersion,
  openArchRepositoryFile,
  uploadArchPackage,
} from "../../services/packages/arch";
import {
  MAX_RPM_ERRATA_BODY_BYTES,
  RpmInvalidPackageError,
  RpmPackageNotExistError,
  buildRpmRepositoryKey,
  deleteRpmPackageFile,
  openRpmPackageFile,
  openRpmRepositoryFile,
  parseRpmTarget,
  renderRpmRepositoryConfig,
  uploadRpmErrata,
  uploadRpmPackage,
} from "../../services/packages/rpm";
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

import {
  GoDuplicateVersionError,
  GoFileSetInvalidError,
  GoInvalidStructureError,
  GoModFileTooLargeError,
  GoModPropertyMissingError,
  GoPackageNotExistError,
  GoInvalidVersionError,
  goTimeJson,
  getGoModContent,
  listGoPackageVersions,
  openGoZipForDownload,
  resolveGoPackageVersion,
  uploadGoPackage,
} from "../../services/packages/goproxy";

import {
  CARGO_CONFIG_FILE_NAME,
  CargoContentSizeMismatchError,
  CargoDuplicateVersionError,
  CargoFileNotExistError,
  CargoInvalidNameError,
  CargoInvalidVersionError,
  CargoMetadataTooLargeError,
  CargoPackageNotExistError,
  CargoParseError,
  buildCargoPackageIndex,
  buildCargoRegistryConfig,
  openCargoFileForDownload,
  searchCargoPackages,
  setCargoPackageYanked,
  uploadCargoPackage,
} from "../../services/packages/cargo";

import {
  MAX_SWIFT_UPLOAD_BYTES,
  SWIFT_ACCEPT_JSON,
  SWIFT_ACCEPT_SWIFT,
  SWIFT_ACCEPT_ZIP,
  SwiftDuplicateVersionError,
  SwiftInvalidManifestVersionError,
  SwiftInvalidNameError,
  SwiftInvalidScopeError,
  SwiftInvalidVersionError,
  SwiftManifestFileTooLargeError,
  SwiftManifestFilesTooLargeError,
  SwiftMissingManifestFileError,
  SwiftMissingSourceArchiveError,
  SwiftPackageNotExistError,
  buildSwiftMetadataResponseJson,
  buildSwiftPackageID,
  buildSwiftEnumerateJson,
  getSwiftVersionDescriptor,
  isSwiftNameValid,
  isSwiftScopeValid,
  listSwiftPackageVersions,
  lookupSwiftIdentifiers,
  openSwiftZipForDownload,
  parseSwiftVersionLax,
  parseSwiftVersionStrict,
  swiftTrimmedVersionString,
  uploadSwiftPackage,
} from "../../services/packages/swift";

import {
  RubyContentTooLargeError,
  RubyDuplicateVersionError,
  RubyInvalidMetadataError,
  RubyInvalidNameError,
  RubyInvalidVersionError,
  RubyMissingMetadataFileError,
  RubyPackageNotExistError,
  buildRubyGemCompactIndex,
  buildRubyGemEmptySpecsPayload,
  buildRubyGemSpecification,
  buildRubyGemSpecsPayload,
  findRubyGemVersionsByFilename,
  gzipRubyGemArchive,
  listLatestRubyGemVersions,
  listRubyGemVersionsByType,
  listRubyGemVersionsByName,
  makeRubyGemPackageInfo,
  openRubyGemForDownload,
  removeRubyGemVersion,
  uploadRubyGem,
  zlibRubyGemArchive,
} from "../../services/packages/rubygems";
import {
  VagrantInvalidProviderError,
  VagrantInvalidVersionError,
  isVagrantProviderNameValid,
  parseVagrantSemver,
  enumerateVagrantBox,
  openVagrantBoxForDownload,
  uploadVagrantBox,
  vagrantBoxExists,
} from "../../services/packages/vagrant";
import {
  CRAN_TYPE_BINARY,
  CRAN_TYPE_SOURCE,
  CranArchiveError,
  CranInvalidNameError,
  CranInvalidVersionError,
  CranMissingDescriptionError,
  enumerateCranPackages,
  openCranFileForDownload,
  renderCranPackagesIndex,
  uploadCranBinaryPackage,
  uploadCranSourcePackage,
} from "../../services/packages/cran";
import {
  PubArchiveError,
  PubInvalidNameError,
  PubInvalidVersionError,
  PubMissingFileError,
  PubMissingPubspecError,
  PubPubspecTooLargeError,
  enumeratePubPackage,
  getPubVersionMetadata,
  openPubFileForDownload,
  pubVersionExists,
  uploadPubPackage,
} from "../../services/packages/pub";
import {
  ChefArchiveError,
  ChefInvalidNameError,
  ChefInvalidVersionError,
  ChefMissingMetadataError,
  ChefMissingTarballError,
  buildChefUniverse,
  deleteChefPackage,
  deleteChefPackageVersion,
  getChefCookbookMetadata,
  getChefVersionMetadata,
  openChefPackageForDownload,
  searchChefPackages,
  uploadChefPackage,
} from "../../services/packages/chef";
import {
  ComposerArchiveError,
  ComposerInvalidNameError,
  ComposerInvalidVersionError,
  ComposerMissingComposerJsonError,
  buildComposerServiceIndex,
  getComposerPackageMetadata,
  listComposerPackages,
  openComposerFileForDownload,
  searchComposerPackages,
  uploadComposerPackage,
} from "../../services/packages/composer";
import {
  type ConanPackageReference,
  type ConanRecipeReference,
  buildConanDownloadUrls,
  buildConanSnapshot,
  buildConanUploadUrls,
  conanPackageAsKey,
  conanPackageLinkName,
  conanRecipeAsKey,
  conanRecipeLinkName,
  deleteConanPackageV1,
  deleteConanPackageV2,
  deleteConanRecipeV1,
  deleteConanRecipeV2,
  getConanLatestPackageRevision,
  getConanLatestRecipeRevision,
  listConanPackageRevisionsJson,
  listConanRecipeRevisionsJson,
  listConanRevisionFiles,
  newConanRecipeReference,
  openConanFileForDownload,
  searchConanPackages,
  searchConanRecipes,
  uploadConanFile,
} from "../../services/packages/conan";

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

  // ------------------------------ RPM (api.go:423-435) ------------------------------
  // The M7 index-builder family: the stored repodata serving arms over the
  // internal `_rpm` version + the upload/delete/errata riders (services/
  // packages/rpm.ts carries the createrepo-shaped builder + the binary header
  // parse). The group spans segments upstream (`<group:*>`), so the
  // `/:username/rpm/*` wildcard hands the remainder to parseRpmTarget — the
  // npm walk's precedent — and the sibling `/rpm.repo` route is the group=""
  // config (api.go:423).

  const rpmRepoConfig = async (c: Context<{ Bindings: Env }>, group: string): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const origin = new URL(c.req.url).origin;
      // GetRepositoryConfig (rpm.go:36-52): setting.AppURL renders as the
      // request origin, AppName as the literal "Gitea" (the instance-name
      // posture).
      const body = renderRpmRepositoryConfig(owner.username, owner.usernameLower, group, `${origin}/api/packages/${owner.username}/rpm`, "Gitea");
      return new Response(body, { status: 200, headers: { "content-type": "text/plain;charset=utf-8" } });
    } catch (error) {
      return rpmErrorResponse(error);
    }
  };
  app.on(["HEAD", "GET"], "/:username/rpm.repo", (c) => rpmRepoConfig(c, ""));

  const rpmDispatch = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const rawPath = c.req.path;
      const segments = rawPath.split("/");
      // ["", "api", "packages", {username}, "rpm", ...] — the npm walk's
      // path discipline: RESERVED escapes survive in c.req.path; this walk
      // decodes the remainder FULLY (a malformed escape cannot match the
      // grammar below and 404s).
      const prefix = `/api/packages/${segments[3] ?? ""}/rpm/`;
      if (!rawPath.startsWith(prefix)) {
        return rpmPlain(404, "package file does not exist");
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(rawPath.slice(prefix.length));
      } catch {
        return rpmPlain(404, "package file does not exist");
      }
      const target = parseRpmTarget(decoded, c.req.method);
      if (target === null) {
        return rpmPlain(404, "package file does not exist");
      }
      const READ_ARMS: ReadonlySet<string> = new Set(["key", "repo-config", "repodata", "download"]);
      const { owner, cred } = await protocolContext(c, READ_ARMS.has(target.arm) ? "read" : "write");

      switch (target.arm) {
        case "key": {
          // GetRepositoryKey (rpm.go:55-66): the armored transferable public
          // key, application/pgp-keys, filename repository.key.
          const key = await buildRpmRepositoryKey(c.env.DB, owner.id);
          return new Response(key, {
            status: 200,
            headers: {
              "content-type": "application/pgp-keys",
              "content-disposition": contentDispositionAttachment("repository.key"),
            },
          });
        }
        case "repo-config":
          return rpmRepoConfig(c, target.group);
        case "repodata": {
          // HEAD → CheckRepositoryFileExistence (rpm.go:68-90, bare
          // headers); GET → GetRepositoryFile (rpm.go:93-119). The internal
          // files are IsLead=false, so the counter never moves.
          const download = await openRpmRepositoryFile(c.env.DB, c.env.REPO_PACKS, owner.id, target.group, target.filename ?? "");
          if (download === null) return rpmPlain(404, "package file does not exist");
          return fileResponse(c, download);
        }
        case "upload": {
          // UploadPackageFile (rpm.go:121-219): the PUT stream, the parse,
          // the properties triple, the rebuild rider. The `sign` query arm
          // is accepted and ignored (the rpm.ts module-header reduction).
          const doer = cred.doer;
          if (doer === null) {
            return rpmPlain(401, "user should have specific permission or be a site admin");
          }
          await uploadRpmPackage({
            d1: c.env.DB,
            bucket: c.env.REPO_PACKS,
            owner,
            doer,
            group: target.group,
            content: bodyStream(c.req.raw),
            declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
            quota: packagesQuotaFromEnv(c.env),
          });
          return new Response(null, { status: 201 });
        }
        case "errata": {
          // UploadErrata (rpm.go:331-471): the JSON updates array merged
          // into the version's metadata, the rebuild, 200. The body is a
          // bounded read (the npm put-tag posture).
          const doer = cred.doer;
          if (doer === null) {
            return rpmPlain(401, "user should have specific permission or be a site admin");
          }
          const body = await c.req.raw.text();
          if (body.length > MAX_RPM_ERRATA_BODY_BYTES) {
            return rpmPlain(400, "invalid update info");
          }
          let updates: unknown;
          try {
            updates = JSON.parse(body);
          } catch (error) {
            return rpmPlain(400, error instanceof Error ? error.message : "invalid update info");
          }
          if (!Array.isArray(updates)) {
            return rpmPlain(400, "invalid update info");
          }
          await uploadRpmErrata(c.env.DB, c.env.REPO_PACKS, owner.id, target.group, target.name ?? "", target.version ?? "", updates);
          return new Response(null, { status: 200 });
        }
        case "download": {
          // DownloadPackageFile (rpm.go:221-257): the two URL shapes share
          // one handler — the {filename} tail is ignored (the upstream
          // comment on the route), the noarch fallback applies, GET bumps
          // the lead counter.
          const download = await openRpmPackageFile(
            c.env.DB,
            c.env.REPO_PACKS,
            owner.id,
            target.group,
            target.name ?? "",
            target.version ?? "",
            target.architecture ?? "",
            c.req.method === "HEAD" ? "HEAD" : "GET",
          );
          if (download === null) return rpmPlain(404, "package file does not exist");
          return fileResponse(c, download);
        }
        case "delete": {
          // DeletePackageFile (rpm.go:259-328): the exact-architecture file
          // (no fallback), the unreferenced-version fold, the rebuild, 204.
          const doer = cred.doer;
          if (doer === null) {
            return rpmPlain(401, "user should have specific permission or be a site admin");
          }
          const deleted = await deleteRpmPackageFile(
            c.env.DB,
            c.env.REPO_PACKS,
            owner.id,
            target.group,
            target.name ?? "",
            target.version ?? "",
            target.architecture ?? "",
          );
          if (!deleted) return rpmPlain(404, "package file does not exist");
          return new Response(null, { status: 204 });
        }
        default:
          return rpmPlain(404, "package file does not exist");
      }
    } catch (error) {
      return rpmErrorResponse(error);
    }
  };
  app.on(["HEAD", "GET"], "/:username/rpm/*", (c) => rpmDispatch(c));
  app.on("PUT", "/:username/rpm/*", (c) => rpmDispatch(c));
  app.on("POST", "/:username/rpm/*", (c) => rpmDispatch(c));
  app.on("DELETE", "/:username/rpm/*", (c) => rpmDispatch(c));

  // ------------------------------ ARCH (api.go:118-126) ------------------------------
  // The pacman family: the repository.generic PKGINFO index builder lives in
  // services/packages/arch.ts (the .db tar + the vercmp port). The route
  // grammar is upstream's PathGroup wildcard — `<repository:*>` spans
  // segments AND can be empty (chi's catch-all matches zero segments; the
  // integration test's repository "" arms ride it), with the literal tail
  // segments pinning the arm:
  //   PUT  /<repository:*>                              → upload (repository = the whole remainder, TrimSpace'd)
  //   GET  /<repository:*>/<architecture>/<filename>    → GetPackageOrRepositoryFile
  //   DEL  /<repository:*>/<name>/<version>/<architecture> → DeletePackageVersion
  // so the GET arm pins the last TWO segments and the DELETE arm the last
  // THREE. Hono params cannot span segments, so the /:username/arch/*
  // wildcard hands the raw remainder to the walk (the npm PathGroup
  // posture), decoding PER SEGMENT (chi matches the raw path and unescapes
  // each param — an encoded slash stays within its segment).

  const archKey = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      // GetRepositoryKey (arch.go:31-41): application/pgp-keys, ServeContent
      // with no filename — no attachment disposition.
      const key = await buildArchRepositoryKey(c.env.DB, owner.id);
      return new Response(key, { status: 200, headers: { "content-type": "application/pgp-keys" } });
    } catch (error) {
      return debianErrorResponse(error);
    }
  };
  app.get("/:username/arch/repository.key", (c) => archKey(c));
  app.on("HEAD", "/:username/arch/repository.key", (c) => archKey(c));

  type ArchTarget =
    | { arm: "upload"; repository: string }
    | { arm: "file"; repository: string; architecture: string; filename: string }
    | { arm: "delete"; repository: string; name: string; version: string; architecture: string };

  const archTargetFrom = (parts: string[], method: string): ArchTarget | null => {
    if (method === "PUT") {
      return { arm: "upload", repository: parts.join("/") };
    }
    if (method === "GET" || method === "HEAD") {
      if (parts.length < 2) return null;
      const architecture = parts[parts.length - 2] ?? "";
      const filename = parts[parts.length - 1] ?? "";
      return { arm: "file", repository: parts.slice(0, -2).join("/"), architecture, filename };
    }
    if (method === "DELETE") {
      if (parts.length < 3) return null;
      const name = parts[parts.length - 3] ?? "";
      const version = parts[parts.length - 2] ?? "";
      const architecture = parts[parts.length - 1] ?? "";
      return { arm: "delete", repository: parts.slice(0, -3).join("/"), name, version, architecture };
    }
    return null;
  };

  const archDispatch = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const rawPath = c.req.path;
      const segments = rawPath.split("/");
      // ["", "api", "packages", {username}, "arch", ...] — the npm walk's
      // path discipline: RESERVED escapes survive in c.req.path; this walk
      // decodes each segment (chi's per-param unescape; a malformed escape
      // cannot match the grammar below and 404s).
      const prefix = `/api/packages/${segments[3] ?? ""}/arch`;
      if (!rawPath.startsWith(`${prefix}/`) && rawPath !== prefix) {
        return debianPlain(404, "");
      }
      const rawRemainder = rawPath.slice(prefix.length).replace(/^\//, "");
      const parts: string[] = [];
      if (rawRemainder !== "") {
        for (const part of rawRemainder.split("/")) {
          try {
            parts.push(decodeURIComponent(part));
          } catch {
            return debianPlain(404, "");
          }
        }
      }
      const target = archTargetFrom(parts, c.req.method);
      if (target === null) return debianPlain(404, "");
      if (target.arm === "upload") {
        const { owner, cred } = await protocolContext(c, "write");
        const doer = cred.doer;
        if (doer === null) {
          return debianPlain(401, "user should have specific permission or be a site admin");
        }
        await uploadArchPackage({
          d1: c.env.DB,
          bucket: c.env.REPO_PACKS,
          owner,
          doer,
          repository: target.repository,
          content: bodyStream(c.req.raw),
          declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
          quota: packagesQuotaFromEnv(c.env),
        });
        return new Response(null, { status: 201 });
      }
      if (target.arm === "file") {
        const { owner } = await protocolContext(c, "read");
        const download = await openArchRepositoryFile(
          c.env.DB,
          c.env.REPO_PACKS,
          owner.id,
          target.repository,
          target.architecture,
          target.filename,
        );
        if (download === null) return debianPlain(404, "");
        return fileResponse(c, download);
      }
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return debianPlain(401, "user should have specific permission or be a site admin");
      }
      const deleted = await deleteArchPackageVersion(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        target.repository,
        target.architecture,
        target.name,
        target.version,
      );
      if (!deleted.ok) {
        // The version miss carries upstream's not-exist sentinel body; the
        // file-search miss is the nil-object EMPTY body (arch.go:268-275 vs
        // :285-288).
        return debianPlain(404, deleted.missing === "version" ? "resource does not exist" : "");
      }
      return new Response(null, { status: 204 });
    } catch (error) {
      return debianErrorResponse(error);
    }
  };
  app.put("/:username/arch", (c) => archDispatch(c)); // api.go:120 — the no-repository arm
  app.put("/:username/arch/*", (c) => archDispatch(c));
  app.get("/:username/arch/*", (c) => archDispatch(c));
  app.on("HEAD", "/:username/arch/*", (c) => archDispatch(c));
  app.delete("/:username/arch/*", (c) => archDispatch(c));

  // ------------------------------ GO (api.go:305-316) ------------------------------
  // The Go module proxy protocol: the PUT /upload write arm, the sumdb
  // checksum-DB mirror probe (http.NotFound — "this proxy does not mirror
  // sum.golang.org"), and the PathGroup read family whose `<name:*>` spans
  // segments (module paths carry slashes). The wildcard hands the raw
  // remainder to goDispatch (the npm walk's posture); the statics outrank it
  // in Hono's router.

  app.put("/:username/go/upload", async (c) => {
    try {
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return goPlain(401, "user should have specific permission or be a site admin");
      }
      await uploadGoPackage({
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
      return goErrorResponse(error);
    }
  });

  // api.go:308 — r.Get("/sumdb/sum.golang.org/supported", http.NotFound).
  // The 404 is the PROTOCOL ANSWER (the client concludes "no checksum-DB
  // mirror"); chi still runs the group's read gate before the handler, so
  // the probe keeps the gate stack.
  app.on(["GET", "HEAD"], "/:username/go/sumdb/sum.golang.org/supported", async (c) => {
    await protocolContext(c, "read");
    return goNotFoundPage();
  });

  app.on(["GET", "HEAD"], "/:username/go/*", (c) => goDispatch(c));

  // ------------------------------ CARGO (api.go:127-146) ------------------------------
  // The Rust sparse-index family: config.json + the four sparse-path shapes
  // (`/1/{package}`, `/2/{package}`, `/3/{_}/{package}`, `/{_}/{__}/{package}`
  // — the placeholders are dummies, the package name is always the LAST
  // segment, index.go:31-45), the crates.io API group (search / publish /
  // download / yank / unyank / owners). Every error answers the
  // StatusResponse wrap `{"ok":false,"errors":[{"detail":…}]}` and every
  // success `{"ok":true}` (cargo.go:19-49); the index lines serve as
  // text/plain NDJSON (ctx.PlainTextBytes). The git-backed `_cargo-index`
  // mirror is v1 out-of-scope (SPEC-0016 §1) — the sparse HTTP face derives
  // on read exactly as upstream's does (see cargo.ts's posture note).

  const cargoIndex = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const pkg = await getPackageByName(c.env.DB, owner.id, "cargo", c.req.param("package") ?? "");
      if (pkg === null) {
        // EnumeratePackageVersions' name miss (cargo.go:68-72) → 404
        // "package does not exist" through the wrap.
        return cargoApiError(404, "package does not exist");
      }
      const index = await buildCargoPackageIndex(c.env.DB, pkg);
      if (index === null) {
        // apiError(ctx, 404, nil) — the EMPTY detail (cargo.go:80-82).
        return cargoApiError(404, "");
      }
      return new Response(index, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    } catch (error) {
      return cargoErrorResponse(error);
    }
  };
  // The STATIC shapes register FIRST — upstream's own order (the api/v1/crates
  // group at api.go:129-138, config.json at :140, then the sparse paths at
  // :141-145) and Hono's tie-break: the 3-segment generic sparse shape below
  // would otherwise shadow the static search route.
  app.get(`/:username/cargo/${CARGO_CONFIG_FILE_NAME}`, async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      const origin = new URL(c.req.url).origin;
      return new Response(JSON.stringify(buildCargoRegistryConfig(owner, origin)), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    } catch (error) {
      return cargoErrorResponse(error);
    }
  });

  app.get("/:username/cargo/api/v1/crates", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      const params = new URL(c.req.url).searchParams;
      const result = await searchCargoPackages(
        c.env.DB,
        owner.id,
        (params.get("q") ?? "").trim(),
        formInt(params, "page"),
        formInt(params, "per_page"),
      );
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    } catch (error) {
      return cargoErrorResponse(error);
    }
  });

  app.put("/:username/cargo/api/v1/crates/new", async (c) => {
    try {
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return cargoApiError(401, "user should have specific permission or be a site admin");
      }
      await uploadCargoPackage({
        d1: c.env.DB,
        bucket: c.env.REPO_PACKS,
        owner,
        doer,
        content: bodyStream(c.req.raw),
        declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
        quota: packagesQuotaFromEnv(c.env),
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    } catch (error) {
      return cargoErrorResponse(error);
    }
  });

  const cargoDownload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const download = await openCargoFileForDownload(
        c.env.DB,
        c.env.REPO_PACKS,
        owner.id,
        c.req.param("package") ?? "",
        c.req.param("version") ?? "",
        c.req.method === "HEAD" ? "HEAD" : "GET",
      );
      return fileResponse(c, download);
    } catch (error) {
      return cargoErrorResponse(error);
    }
  };
  app.get("/:username/cargo/api/v1/crates/:package/:version/download", (c) => cargoDownload(c));
  app.on("HEAD", "/:username/cargo/api/v1/crates/:package/:version/download", (c) => cargoDownload(c));

  const cargoYank = (yank: boolean) => async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return cargoApiError(401, "user should have specific permission or be a site admin");
      }
      await setCargoPackageYanked(
        c.env.DB,
        owner.id,
        c.req.param("package") ?? "",
        c.req.param("version") ?? "",
        yank,
      );
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    } catch (error) {
      return cargoErrorResponse(error);
    }
  };
  app.delete("/:username/cargo/api/v1/crates/:package/:version/yank", (c) => cargoYank(true)(c));
  app.put("/:username/cargo/api/v1/crates/:package/:version/unyank", (c) => cargoYank(false)(c));

  app.get("/:username/cargo/api/v1/crates/:package/owners", async (c) => {
    try {
      const { owner } = await protocolContext(c, "read");
      // The :package segment only pins the route shape; the OWNER answers
      // (cargo.go:152-155 — the scope's single owner entry).
      return new Response(
        JSON.stringify({
          users: [{ id: owner.id, login: owner.username, name: owner.displayName ?? owner.username }],
        }),
        { status: 200, headers: { "content-type": "application/json;charset=utf-8" } },
      );
    } catch (error) {
      return cargoErrorResponse(error);
    }
  });

  // The four sparse shapes register LAST (upstream api.go:141-145's tail): the
  // statics above outrank them, and a `/3/a/b` request hits the static "3"
  // route over the generic param shape in both routers.
  app.get(`/:username/cargo/1/:package`, (c) => cargoIndex(c));
  app.get(`/:username/cargo/2/:package`, (c) => cargoIndex(c));
  app.get("/:username/cargo/3/:cargoDash/:package", (c) => cargoIndex(c));
  app.get("/:username/cargo/:cargoDash/:cargoDash2/:package", (c) => cargoIndex(c));

  // ------------------------------ SWIFT (api.go:451-471) ------------------------------
  // The Swift Package Manager registry family: the login probe pair (the
  // UNAUTHENTICATED group — Doer-nil is the only check, any valid credential
  // passes regardless of scope), the identifiers lookup, and the
  // {scope}/{name} family whose chi PathGroup (`/*`) carries the version
  // shapes (version / version.json / version.zip / version/Package.swift /
  // PUT version). The scope/name/version params are chi `[^/]+` single
  // segments, so the walk decodes PER SEGMENT (the arch precedent — chi's
  // per-param unescape); the `.json` suffix routes strip the suffix the way
  // chi's static-tail branches do (valid package names can never carry a
  // dot — namePattern). Unmatched shapes UNDER {scope}/{name} run the read
  // gate first (chi PathGroup's middleware precedes its internal 404 — the
  // go family's posture), then chi's router page; anything shallower 404s
  // without a gate (no route there to carry middleware).

  app.post("/:username/swift", (c) => swiftCheckAuthenticate(c));
  app.post("/:username/swift/login", (c) => swiftCheckAuthenticate(c));

  const swiftDispatch = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const rawPath = c.req.path;
      const segments = rawPath.split("/");
      // ["", "api", "packages", {username}, "swift", ...] — the arch walk's
      // per-segment decode (a malformed escape falls to the 404 page).
      const prefix = `/api/packages/${segments[3] ?? ""}/swift`;
      const notFoundPage = (): Response => swiftNotFoundPage();
      if (!rawPath.startsWith(`${prefix}/`)) {
        return notFoundPage();
      }
      const rawRemainder = rawPath.slice(prefix.length).replace(/^\//, "");
      const parts: string[] = [];
      if (rawRemainder !== "") {
        for (const part of rawRemainder.split("/")) {
          try {
            parts.push(decodeURIComponent(part));
          } catch {
            return notFoundPage();
          }
        }
      } else {
        parts.push("");
      }
      const target = parseSwiftTarget(parts, c.req.method);
      if (target.arm === "not-found") {
        if (target.gated === true) {
          // The PathGroup node matched — chi runs the group's read gate
          // before its internal 404 (the go family's posture).
          await protocolContext(c, "read");
        }
        return notFoundPage();
      }
      const origin = new URL(c.req.url).origin;
      if (target.arm === "identifiers") {
        // LookupPackageIdentifiers (swift.go:465-506): the read gate rides
        // the group; the Accept check precedes the url-param 400.
        const { owner } = await protocolContext(c, "read");
        const acceptError = swiftAcceptMismatch(c, SWIFT_ACCEPT_JSON);
        if (acceptError !== null) return acceptError;
        const url = c.req.query("url") ?? "";
        if (url === "") {
          return swiftProblemResponse(400, "");
        }
        const identifiers = await lookupSwiftIdentifiers(c.env.DB, owner.id, url);
        if (identifiers.length === 0) {
          return swiftProblemResponse(404, "");
        }
        return new Response(JSON.stringify({ identifiers }), {
          status: 200,
          headers: { "content-type": "application/json;charset=utf-8", "content-version": "1" },
        });
      }
      if (target.arm === "enumerate") {
        const { owner } = await protocolContext(c, "read");
        const acceptError = swiftAcceptMismatch(c, SWIFT_ACCEPT_JSON);
        if (acceptError !== null) return acceptError;
        const versions = await listSwiftPackageVersions(c.env.DB, owner.id, target.scope, target.name);
        if (versions.length === 0) {
          // apiError(ctx, 404, nil) — the EMPTY detail (swift.go:134-136).
          return swiftProblemResponse(404, "");
        }
        // baseURL (swift.go:149): AppURL + api/packages/{PathEscape
        // lowerowner}/swift/{PathEscape scope}/{PathEscape name}/ — the JS
        // twin of PathEscape is encodeURIComponent (the helm precedent).
        const baseURL = `${origin}/api/packages/${encodeURIComponent(owner.usernameLower)}/swift/${encodeURIComponent(target.scope)}/${encodeURIComponent(target.name)}/`;
        // Link (swift.go:159-161): the LAST sorted row's RAW version.
        const last = versions[versions.length - 1]?.version ?? "";
        return new Response(buildSwiftEnumerateJson(baseURL, versions), {
          status: 200,
          headers: {
            "content-type": "application/json;charset=utf-8",
            "content-version": "1",
            link: `<${baseURL}${encodeURIComponent(last)}>; rel="latest-version"`,
          },
        });
      }
      if (target.arm === "metadata") {
        const { owner } = await protocolContext(c, "read");
        const acceptError = swiftAcceptMismatch(c, SWIFT_ACCEPT_JSON);
        if (acceptError !== null) return acceptError;
        const descriptor = await getSwiftVersionDescriptor(c.env.DB, owner.id, target.scope, target.name, target.version);
        if (descriptor === null) {
          return swiftProblemResponse(404, "package does not exist");
        }
        return new Response(
          buildSwiftMetadataResponseJson({
            id: buildSwiftPackageID(target.scope, target.name),
            version: descriptor.version.version,
            checksum: descriptor.blob.hashSha256,
            metadata: descriptor.metadata,
            packageName: descriptor.nameProperty,
            repositoryURLs: descriptor.repositoryURLs,
          }),
          { status: 200, headers: { "content-type": "application/json;charset=utf-8", "content-version": "1" } },
        );
      }
      if (target.arm === "download") {
        const { owner } = await protocolContext(c, "read");
        const acceptError = swiftAcceptMismatch(c, SWIFT_ACCEPT_ZIP);
        if (acceptError !== null) return acceptError;
        // DownloadPackageFile (swift.go:424-458): the Digest header rides
        // setResponseHeaders BEFORE the serve; the content-type is
        // application/zip; the lead GET bumps the counter.
        const download = await openSwiftZipForDownload(
          c.env.DB,
          c.env.REPO_PACKS,
          owner,
          target.scope,
          target.name,
          target.version,
          c.req.method === "HEAD" ? "HEAD" : "GET",
        );
        if (download === null) {
          // The vanished-content honest 404 (the families' sole-sweeper
          // posture; upstream's storage failure would map 500).
          return swiftProblemResponse(404, "package does not exist");
        }
        const response = fileResponse(
          c,
          { stream: download.stream, size: download.size, filename: download.file.name, created: download.created },
          "application/zip",
        );
        response.headers.set("Digest", `sha256=${download.blob.hashSha256}`);
        response.headers.set("Content-Version", "1");
        return response;
      }
      if (target.arm === "manifest") {
        const { owner } = await protocolContext(c, "read");
        const acceptError = swiftAcceptMismatch(c, SWIFT_ACCEPT_SWIFT);
        if (acceptError !== null) return acceptError;
        const descriptor = await getSwiftVersionDescriptor(c.env.DB, owner.id, target.scope, target.name, target.version);
        if (descriptor === null) {
          return swiftProblemResponse(404, "package does not exist");
        }
        // The swift-version param normalizes through NewVersion +
        // TrimmedVersionString (swift.go:275-281); an unparseable value
        // rides RAW into the manifests lookup (→ the redirect).
        let swiftVersion = c.req.query("swift-version") ?? "";
        if (swiftVersion !== "") {
          const parsed = parseSwiftVersionLax(swiftVersion);
          if (parsed !== null) {
            swiftVersion = swiftTrimmedVersionString(parsed);
          }
        }
        const manifest = descriptor.metadata.manifests[swiftVersion];
        if (manifest === undefined) {
          // 303 SeeOther with the bare Location (owner lower name, scope,
          // name, version RAW — swift.go:284-288) + Content-Version.
          return new Response(null, {
            status: 303,
            headers: {
              location: `${origin}/api/packages/${owner.usernameLower}/swift/${target.scope}/${target.name}/${target.version}/Package.swift`,
              "content-version": "1",
            },
          });
        }
        const filename = swiftVersion === "" ? "Package.swift" : `Package@swift-${swiftVersion}.swift`;
        const bytes = new TextEncoder().encode(manifest.content);
        const response = servePackageFileResponse(
          c.req.raw,
          c.req.method === "HEAD" ? null : new Response(bytes).body,
          {
            filename,
            size: bytes.byteLength,
            created: descriptor.version.createdUnix,
            contentType: "text/x-swift",
          },
        );
        response.headers.set("Content-Version", "1");
        return response;
      }
      // arm === "upload" — PUT /<version> (swift.go:323-421): the write gate
      // rides protocolContext (upstream's group read gate + the route's
      // reqPackageAccess(write) pair collapse), then the Accept check.
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        return swiftProblemResponse(401, "user should have specific permission or be a site admin");
      }
      const acceptError = swiftAcceptMismatch(c, SWIFT_ACCEPT_JSON);
      if (acceptError !== null) return acceptError;
      // The URL-param validation (swift.go:328-333) runs BEFORE the body is
      // read: NewSemver's error (when the version failed) IS the Problem
      // detail, else a pattern miss carries the EMPTY detail — ONE shared
      // 400 arm.
      const versionParsed = parseSwiftVersionStrict(target.version);
      if (versionParsed === null) {
        return swiftProblemResponse(400, new SwiftInvalidVersionError(target.version).message);
      }
      if (!isSwiftScopeValid(target.scope) || !isSwiftNameValid(target.name)) {
        return swiftProblemResponse(400, "");
      }
      await uploadSwiftPackage({
        d1: c.env.DB,
        bucket: c.env.REPO_PACKS,
        owner,
        doer,
        scope: target.scope,
        name: target.name,
        version: target.version,
        contentType: c.req.header("content-type") ?? "",
        content: bodyStream(c.req.raw),
        declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
        quota: packagesQuotaFromEnv(c.env),
        maxBytes: MAX_SWIFT_UPLOAD_BYTES,
      });
      return new Response(null, { status: 201, headers: { "content-version": "1" } });
    } catch (error) {
      return swiftErrorResponse(error);
    }
  };
  app.get("/:username/swift/*", (c) => swiftDispatch(c));
  app.on("HEAD", "/:username/swift/*", (c) => swiftDispatch(c));
  app.put("/:username/swift/*", (c) => swiftDispatch(c));

  // ------------------------------ RUBYGEMS (api.go:437-447) ------------------------------
  // The RubyGems registry: the three Marshal-4.8 specs enumerations (the
  // gem/Bundler store base), the quick/Marshal.4.8 gemspec render, the .gem
  // download, the compact-index pair (info + versions), and the api/v1/gems
  // write group (POST push + DELETE yank). The group's read wrap rides every
  // read arm through protocolContext(c, "read"); the write arms add the
  // doer-bearing write gate (the go upload arm's posture). HEAD rides the
  // download/gemspec GET walks (the pypi/helm precedent — upstream registers
  // GET only). The enumerations' + gemspec's archive responses are the
  // SetServeHeaders streaming shape (no Last-Modified, no byte-serving — see
  // rubygemsArchiveResponse); only the .gem download rides the D-6 machinery.

  app.get("/:username/rubygems/specs.4.8.gz", (c) => rubygemsEnumerate(c, "specs"));
  app.get("/:username/rubygems/latest_specs.4.8.gz", (c) => rubygemsEnumerate(c, "latest"));
  app.get("/:username/rubygems/prerelease_specs.4.8.gz", (c) => rubygemsEnumerate(c, "prerelease"));
  app.get("/:username/rubygems/quick/Marshal.4.8/:filename", (c) => rubygemsGemspec(c));
  app.on("HEAD", "/:username/rubygems/quick/Marshal.4.8/:filename", (c) => rubygemsGemspec(c));
  app.get("/:username/rubygems/gems/:filename", (c) => rubygemsDownload(c));
  app.on("HEAD", "/:username/rubygems/gems/:filename", (c) => rubygemsDownload(c));
  app.get("/:username/rubygems/info/:packagename", (c) => rubygemsInfo(c));
  app.get("/:username/rubygems/versions", (c) => rubygemsVersions(c));
  app.post("/:username/rubygems/api/v1/gems/", (c) => rubygemsUpload(c));
  app.post("/:username/rubygems/api/v1/gems", (c) => rubygemsUpload(c)); // the bare twin (the pypi double-registration precedent)
  app.delete("/:username/rubygems/api/v1/gems/yank", (c) => rubygemsYank(c));

  // ------------------------------ VAGRANT (api.go:488-498) ------------------------------
  // The boxes family: the authenticate probe (the bare Doer-nil check —
  // ANY valid credential passes), the box HEAD/GET enumerate pair, and the
  // {version}/{provider} download/upload pair. The group's read wrap rides
  // the download/enumerate arms through protocolContext(c, "read"); the
  // PUT adds the write gate. HEAD rides the enumerate GET walk (the
  // pypi/helm precedent — upstream registers HEAD only on the box arm).

  app.get("/:username/vagrant/authenticate", (c) => vagrantAuthenticate(c));
  app.on("HEAD", "/:username/vagrant/:name", (c) => vagrantBoxProbe(c));
  app.get("/:username/vagrant/:name", (c) => vagrantEnumerate(c));
  app.get("/:username/vagrant/:name/:version/:provider", (c) => vagrantDownload(c));
  app.on("HEAD", "/:username/vagrant/:name/:version/:provider", (c) => vagrantDownload(c));
  app.put("/:username/vagrant/:name/:version/:provider", (c) => vagrantUpload(c));

  // ------------------------------ CRAN (api.go:300-318) ------------------------------
  // The R family: the src/contrib + bin/{platform}/contrib/{rversion}
  // PACKAGES(.gz) enumerations, the filename downloads (the Archive shape
  // shares the handler — the filename pins), and the src/bin PUTs (the
  // binary arm reads the platform/rversion query pair). The error bodies
  // are the PLAIN TEXT family shape (cran.go:27-30's ctx.PlainText).

  app.get("/:username/cran/src/contrib/PACKAGES", (c) => cranEnumerate(c, CRAN_TYPE_SOURCE, "", ""));
  app.get("/:username/cran/src/contrib/PACKAGES.gz", (c) => cranEnumerate(c, CRAN_TYPE_SOURCE, "", ""));
  app.get("/:username/cran/src/contrib/Archive/:packagename/:filename", (c) => cranDownload(c, CRAN_TYPE_SOURCE, "", ""));
  app.on("HEAD", "/:username/cran/src/contrib/Archive/:packagename/:filename", (c) => cranDownload(c, CRAN_TYPE_SOURCE, "", ""));
  app.get("/:username/cran/src/contrib/:filename", (c) => cranDownload(c, CRAN_TYPE_SOURCE, "", ""));
  app.on("HEAD", "/:username/cran/src/contrib/:filename", (c) => cranDownload(c, CRAN_TYPE_SOURCE, "", ""));
  app.put("/:username/cran/src", (c) => cranUpload(c, "source"));
  app.get("/:username/cran/bin/:platform/contrib/:rversion/PACKAGES", (c) =>
    cranEnumerate(c, CRAN_TYPE_BINARY, c.req.param("platform") ?? "", c.req.param("rversion") ?? ""),
  );
  app.get("/:username/cran/bin/:platform/contrib/:rversion/PACKAGES.gz", (c) =>
    cranEnumerate(c, CRAN_TYPE_BINARY, c.req.param("platform") ?? "", c.req.param("rversion") ?? ""),
  );
  app.get("/:username/cran/bin/:platform/contrib/:rversion/:filename", (c) =>
    cranDownload(c, CRAN_TYPE_BINARY, c.req.param("platform") ?? "", c.req.param("rversion") ?? ""),
  );
  app.on("HEAD", "/:username/cran/bin/:platform/contrib/:rversion/:filename", (c) =>
    cranDownload(c, CRAN_TYPE_BINARY, c.req.param("platform") ?? "", c.req.param("rversion") ?? ""),
  );
  app.put("/:username/cran/bin", (c) => cranUpload(c, "binary"));

  // ------------------------------ PUB (api.go:398-413) ------------------------------
  // The dart pub family: the versions/new publish dance (the upload-url
  // request, the multipart POST, the finalize probe — ALL under the write
  // gate, api.go:401-406) and the {id} read group (enumerate, files,
  // version metadata). The JSON bodies carry the
  // application/vnd.pub.v2+json content type; errors are the
  // {"error":{code,message}} wrapper.

  app.get("/:username/pub/api/packages/versions/new", (c) => pubRequestUpload(c));
  app.post("/:username/pub/api/packages/versions/new/upload", (c) => pubUpload(c));
  app.get("/:username/pub/api/packages/versions/new/finalize/:id/:version", (c) => pubFinalize(c));
  app.get("/:username/pub/api/packages/:id", (c) => pubEnumerate(c));
  app.get("/:username/pub/api/packages/:id/files/:version", (c) => pubDownload(c));
  app.on("HEAD", "/:username/pub/api/packages/:id/files/:version", (c) => pubDownload(c));
  app.get("/:username/pub/api/packages/:id/:version", (c) => pubVersionMetadata(c));

  // ------------------------------ CHEF (api.go:147-164) ------------------------------
  // The supermarket family: the universe + search enumerations, the
  // cookbooks collection (enumerate GET + upload POST), the cookbook and
  // version metadata shapes, the download, and the two delete arms. The
  // error bodies are the {"error_messages":[…]} wrapper.

  app.get("/:username/chef/api/v1/universe", (c) => chefUniverse(c));
  app.get("/:username/chef/api/v1/search", (c) => chefEnumerate(c));
  app.get("/:username/chef/api/v1/cookbooks", (c) => chefEnumerate(c));
  app.post("/:username/chef/api/v1/cookbooks", (c) => chefUpload(c));
  app.get("/:username/chef/api/v1/cookbooks/:name", (c) => chefCookbookMetadata(c));
  app.delete("/:username/chef/api/v1/cookbooks/:name", (c) => chefDeleteCookbook(c));
  app.get("/:username/chef/api/v1/cookbooks/:name/versions/:version", (c) => chefVersionMetadata(c));
  app.delete("/:username/chef/api/v1/cookbooks/:name/versions/:version", (c) => chefDeleteVersion(c));
  app.get("/:username/chef/api/v1/cookbooks/:name/versions/:version/download", (c) => chefDownload(c));
  app.on("HEAD", "/:username/chef/api/v1/cookbooks/:name/versions/:version/download", (c) => chefDownload(c));

  // ------------------------------ COMPOSER (api.go:166-175) ------------------------------
  // The packagist family: the service index, the search/list pair, the p2
  // metadata (~dev.json shares the handler — the suffix strips), the
  // download, and the RAW-body PUT (the ?version= query fallback).

  app.get("/:username/composer/packages.json", (c) => composerServiceIndex(c));
  app.get("/:username/composer/search.json", (c) => composerSearch(c));
  app.get("/:username/composer/list.json", (c) => composerList(c));
  // The p2 metadata pair (~dev twin shares the handler) rides ONE whole-
  // segment capture: Hono folds a param-with-literal-tail (`:project~dev.json`)
  // into the param LABEL (the SmartRouter captures under "project~dev.json"),
  // so the two-literal-route shape 404s every project — the packages-minor
  // probes battery's find (upstream chi separates the dot via its [^/^.]+
  // class). The handler dispatches the suffix; a non-.json segment answers
  // the 404 shape.
  app.get("/:username/composer/p2/:vendor/:filename", (c) => composerMetadata(c));
  app.get("/:username/composer/files/:package/:version/:filename", (c) => composerDownload(c));
  app.on("HEAD", "/:username/composer/files/:package/:version/:filename", (c) => composerDownload(c));
  app.put("/:username/composer", (c) => composerUpload(c));

  // ------------------------------ CONAN (api.go:175-290) ------------------------------
  // The conan family: the v1+v2 tables ride ONE decoded-remainder walk
  // (the npm/rpm/swift posture — Hono params cannot express chi's nested
  // optional tails). The group's read wrap rides the walk; the write arms
  // carry the doer-bearing gate. The authenticate mints a package-scoped
  // token the client echoes back (verified beside the standard
  // credentials in conanGate).

  app.on(["GET", "DELETE", "POST", "PUT"], "/:username/conan/*", (c) => conanDispatch(c));

  return app;
}

// ---------------------------------------------------------------------------
// The GO proxy walk — upstream's PathGroup (api.go:309-316) as a manual
// grammar over the decoded remainder. chi's `<name:*>` is greedy (`.*`), so
// the LAST `@latest` / `@v` marker wins (a module path may itself carry a
// `@v` segment); `<version>` is chi's `[^/]+` — an empty version tail
// (.zip/.info/.mod with nothing before the dot) falls off the grammar to the
// router's 404 page.
// ---------------------------------------------------------------------------

type GoArm = "latest" | "list" | "info" | "mod" | "zip";

interface GoTarget {
  arm: GoArm;
  /** The module path — spans segments, may be empty (chi's `<name:*>`). */
  name: string;
  version?: string;
}

export function parseGoTarget(decoded: string): GoTarget | null {
  const parts = decoded.split("/");
  const last = parts[parts.length - 1] ?? "";
  const prev = parts[parts.length - 2] ?? "";
  // Registration order is chi's own: @latest first, then the @v tails. The
  // arms are mutually exclusive on the marker segment, so the walk order
  // only matters for greedy name capture — both walk arms take the LAST
  // marker, matching chi's greedy `<name:*>`.
  if (last === "@latest") {
    return { arm: "latest", name: parts.slice(0, -1).join("/") };
  }
  if (prev === "@v") {
    const name = parts.slice(0, -2).join("/");
    if (last === "list") return { arm: "list", name };
    if (last.endsWith(".zip") && last.length > ".zip".length) {
      return { arm: "zip", name, version: last.slice(0, -".zip".length) };
    }
    if (last.endsWith(".info") && last.length > ".info".length) {
      return { arm: "info", name, version: last.slice(0, -".info".length) };
    }
    if (last.endsWith(".mod") && last.length > ".mod".length) {
      return { arm: "mod", name, version: last.slice(0, -".mod".length) };
    }
  }
  return null;
}

/** Go http.NotFound (net/http/server.go Error): the exact page chi serves
 *  for an unmatched shape AFTER the group's gate stack has run. */
function goNotFoundPage(): Response {
  return new Response("404 page not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/** goproxy.go:24-27 — the family's plain-text apiError (helper
 *  ProcessErrorForUser → ctx.PlainText). */
function goPlain(status: 400 | 401 | 403 | 404 | 409 | 411 | 413 | 500, message: string): Response {
  return plainResponse(status, message);
}

/**
 * UploadPackage's error switch (goproxy.go:172-180 / :211-217): the three
 * ErrInvalidArgument sentinels → 400; ErrDuplicatePackageVersion → 409;
 * quota → 403. Everything else (zip.NewReader's plain error, a duplicate
 * file row, the store's read failures) hits the DEFAULT arm → the prod
 * 500 body — EXCEPT the store caps, which are our reduction statuses (413)
 * and the lying-Content-Length analog (the npm/nuget non-InvalidArgument
 * posture → 500).
 */
function goErrorResponse(error: unknown): Response {
  if (error instanceof HTTPException) throw error;
  if (
    error instanceof GoInvalidStructureError ||
    error instanceof GoInvalidVersionError ||
    error instanceof GoModFileTooLargeError
  ) {
    return goPlain(400, error.message);
  }
  if (error instanceof GoPackageNotExistError) return goPlain(404, error.message);
  if (error instanceof GoDuplicateVersionError) return goPlain(409, error.message);
  if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
    return goPlain(403, quotaMessage(error));
  }
  if (error instanceof PackageBlobTooLargeError) return goPlain(413, error.message);
  if (error instanceof PackageSizeMismatchError) {
    // The lying-Content-Length store failure — upstream's non-ErrInvalidArgument
    // read arm → 500 (the npm/nuget posture).
    return goPlain(500, "internal server error");
  }
  console.error("[packages-go] request failed", error);
  return goPlain(500, "internal server error");
}

async function goDispatch(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const rawPath = c.req.path;
    const segments = rawPath.split("/");
    // ["", "api", "packages", {username}, "go", ...] — the npm walk's path
    // discipline: RESERVED escapes survive in c.req.path; the remainder
    // decodes FULLY (a malformed escape cannot match the grammar and 404s
    // on the router page).
    const prefix = `/api/packages/${segments[3] ?? ""}/go/`;
    if (!rawPath.startsWith(prefix)) {
      return goNotFoundPage();
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath.slice(prefix.length));
    } catch {
      return goNotFoundPage();
    }
    const target = parseGoTarget(decoded);
    // chi runs the group middleware BEFORE the router 404s — the gate stack
    // precedes the not-found page.
    const { owner } = await protocolContext(c, "read");
    if (target === null) {
      return goNotFoundPage();
    }
    if (target.arm === "list") {
      // EnumeratePackageVersions (goproxy.go:29-49): the empty module is
      // apiError(404, nil) — the EMPTY body; hits render one version per
      // line, text/plain;charset=utf-8.
      const versions = await listGoPackageVersions(c.env.DB, owner.id, target.name);
      if (versions.length === 0) {
        return goPlain(404, "");
      }
      return new Response(versions.map((version) => `${version}\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    }
    // PackageVersionMetadata / GoModContent / DownloadPackageFile share
    // resolvePackage — the null answer is 404 "package does not exist"
    // (ErrPackageNotExist's message through ProcessErrorForUser).
    if (target.arm === "latest" || target.arm === "info") {
      const version = target.arm === "latest" ? "latest" : (target.version ?? "");
      const pv = await resolveGoPackageVersion(c.env.DB, owner.id, target.name, version);
      if (pv === null) return goPlain(404, new GoPackageNotExistError().message);
      // ctx.JSON (base.go:112-119 — application/json;charset=utf-8), the
      // {Version, Time} struct in declaration order; Time renders
      // RFC3339Nano (goTimeJson — the AsLocalTime reduction).
      return new Response(JSON.stringify({ Version: pv.version, Time: goTimeJson(pv.createdUnix) }), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    }
    if (target.arm === "mod") {
      const pv = await resolveGoPackageVersion(c.env.DB, owner.id, target.name, target.version ?? "");
      if (pv === null) return goPlain(404, new GoPackageNotExistError().message);
      const goMod = await getGoModContent(c.env.DB, pv.id);
      return new Response(goMod, {
        status: 200,
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    }
    // arm === "zip" — DownloadPackageFile (goproxy.go:91-119): the ONE file
    // through helper.ServePackageFile (the D-6 set, octet-stream per
    // ServeSetHeaders' IfZero default); the lead GET bumps the counter.
    const download = await openGoZipForDownload(
      c.env.DB,
      c.env.REPO_PACKS,
      owner,
      target.name,
      target.version ?? "",
      c.req.method === "HEAD" ? "HEAD" : "GET",
    );
    return fileResponse(c, {
      stream: download.stream,
      size: download.size,
      filename: download.filename,
      created: download.created,
    });
  } catch (error) {
    if (error instanceof GoFileSetInvalidError || error instanceof GoModPropertyMissingError) {
      // The download walk's 500 sentinels ride the family mapper's DEFAULT
      // arm (goproxy.go:102-106 / :82-86 → apiError(500, …)).
      console.error("[packages-go] read arm failed", error);
      return goPlain(500, "internal server error");
    }
    return goErrorResponse(error);
  }
}

// ---------------------------------------------------------------------------
// The CARGO error/response helpers — cargo.go:19-49: apiError wraps EVERY
// error (any status) in the StatusResponse shape
// `{"ok":false,"errors":[{"detail":message}]}` while successes answer
// `{"ok":true}`; ProcessErrorForUser (helper.go:30-49) strips 500s to the
// prod "internal server error" posture. Content types follow ctx.JSON /
// ctx.PlainTextBytes (application/json;charset=utf-8 / text/plain).
// ---------------------------------------------------------------------------

/** apiError (cargo.go:28-36) — the wrap with the upstream status. */
function cargoApiError(status: ContentfulStatus, message: string): Response {
  return new Response(JSON.stringify({ ok: false, errors: [{ detail: message }] }), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

/** The cargo family's error mapper — the 400 parse sentinels, the 409
 *  duplicate, the 404 not-exist pair, the quota 403, the caps. */
function cargoErrorResponse(error: unknown): Response {
  if (error instanceof HTTPException) throw error;
  if (
    error instanceof CargoParseError ||
    error instanceof CargoInvalidNameError ||
    error instanceof CargoInvalidVersionError ||
    error instanceof CargoMetadataTooLargeError ||
    error instanceof CargoContentSizeMismatchError
  ) {
    return cargoApiError(400, error.message);
  }
  if (error instanceof CargoDuplicateVersionError) return cargoApiError(409, error.message);
  if (error instanceof CargoPackageNotExistError) return cargoApiError(404, error.message);
  if (error instanceof CargoFileNotExistError) return cargoApiError(404, error.message);
  if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
    return cargoApiError(403, quotaMessage(error));
  }
  if (error instanceof PackageBlobTooLargeError) return cargoApiError(413, error.message);
  if (error instanceof PackageSizeMismatchError) {
    // The lying-Content-Length store failure — upstream's non-sentinel read
    // arm → the 500 default (the npm/nuget posture).
    return cargoApiError(500, "internal server error");
  }
  // CargoYankedPropertyMissingError and everything else ride the default arm
  // — helper.ProcessErrorForUser strips 500 details to the prod message.
  console.error("[packages-cargo] request failed", error);
  return cargoApiError(500, "internal server error");
}

// ---------------------------------------------------------------------------
// The SWIFT walk + wire helpers — upstream's {scope}/{name} chi PathGroup
// (api.go:462-468) as a manual grammar over the per-segment-decoded
// remainder. chi's `<version>` is `[^/]+`; the `.json`/`.zip` suffix routes
// strip their suffixes (chi's static-tail branches win over the bare param
// route, and a valid package name can never carry a dot — namePattern).
// Every swift response carries Content-Version: 1 (setResponseHeaders,
// swift.go:54-71) — EXCEPT CheckAuthenticate's bare 200.
// ---------------------------------------------------------------------------

type SwiftArm =
  | { arm: "enumerate"; scope: string; name: string }
  | { arm: "identifiers" }
  | { arm: "metadata"; scope: string; name: string; version: string }
  | { arm: "download"; scope: string; name: string; version: string }
  | { arm: "manifest"; scope: string; name: string; version: string }
  | { arm: "upload"; scope: string; name: string; version: string }
  /** gated=false — the shape has no upstream route NOR gate; gated=true —
   *  the PathGroup node matched, so the read gate precedes the 404 page. */
  | { arm: "not-found"; gated: boolean };

/**
 * The PathGroup grammar. parts[0] = "identifiers" (the static lookup route,
 * api.go:470) or a lone scope (no route); parts[0..1] = scope/name
 * (two-segment shapes ride the plain group: enumerate bare + .json; ANY
 * other method is ungated); parts[2..] = the PathGroup shapes, with any
 * ≥3-part shape gated.
 */
export function parseSwiftTarget(parts: string[], method: string): SwiftArm {
  if (parts.length === 1) {
    if ((parts[0] ?? "") === "identifiers" && (method === "GET" || method === "HEAD")) {
      return { arm: "identifiers" };
    }
    return { arm: "not-found", gated: false };
  }
  if (parts.length < 2) return { arm: "not-found", gated: false };
  const scope = parts[0] ?? "";
  const name = parts[1] ?? "";
  if (parts.length === 2) {
    if (method === "GET" || method === "HEAD") {
      // The `.json` static-tail branch: the suffix strips (chi's trie picks
      // the suffix route over the bare param).
      const stripped = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
      return { arm: "enumerate", scope, name: stripped };
    }
    return { arm: "not-found", gated: false };
  }
  const rest = parts.slice(2);
  const version = rest[0] ?? "";
  if (method === "GET" || method === "HEAD") {
    if (rest.length === 1) {
      if (version.endsWith(".json") && version.length > ".json".length) {
        return { arm: "metadata", scope, name, version: version.slice(0, -".json".length) };
      }
      if (version.endsWith(".zip") && version.length > ".zip".length) {
        return { arm: "download", scope, name, version: version.slice(0, -".zip".length) };
      }
      return { arm: "metadata", scope, name, version };
    }
    if (rest.length === 2 && rest[1] === "Package.swift") {
      return { arm: "manifest", scope, name, version };
    }
    return { arm: "not-found", gated: true };
  }
  if (method === "PUT" && rest.length === 1) {
    return { arm: "upload", scope, name, version };
  }
  return { arm: "not-found", gated: true };
}

/** CheckAuthenticate (swift.go:103-110) — the unauthenticated group's pair:
 *  the 401 Problem for an anonymous credential, the bare 200 (NO
 *  Content-Version — ctx.Status only) otherwise. The {username} owner
 *  resolution still applies (the outer group's UserAssignment). */
async function swiftCheckAuthenticate(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { cred } = await protocolContext(c, "none");
    if (cred.doer === null) {
      return swiftProblemResponse(401, "");
    }
    return new Response(null, { status: 200 });
  } catch (error) {
    return swiftErrorResponse(error);
  }
}

/** CheckAcceptMediaType (swift.go:93-100): a PRESENT-but-different Accept
 *  answers the 400 Problem; absent/empty passes. */
function swiftAcceptMismatch(c: Context<{ Bindings: Env }>, required: string): Response | null {
  const accept = c.req.header("Accept");
  if (accept !== undefined && accept !== "" && accept !== required) {
    return swiftProblemResponse(400, `Unexpected accept header. Should be '${required}'.`);
  }
  return null;
}

/** apiError (swift.go:74-90): the RFC 7807 Problem document
 *  `{"status":…,"detail":…}\n` (json.Encoder's trailing newline),
 *  application/problem+json + Content-Version: 1. */
function swiftProblemResponse(status: ContentfulStatus, detail: string): Response {
  return new Response(`${JSON.stringify({ status, detail })}\n`, {
    status,
    headers: { "content-type": "application/problem+json", "content-version": "1" },
  });
}

/** chi's default NotFoundHandler (the go family's http.NotFound page). */
function swiftNotFoundPage(): Response {
  return new Response("404 page not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/**
 * UploadPackageFile's error switch (swift.go:399-409) + the read arms': the
 * ErrInvalidArgument sentinels → 400; ErrDuplicatePackageVersion → 409;
 * ErrPackageNotExist → 404; quota → 403; the store caps (413) and the
 * lying-Content-Length (500, the npm/nuget posture) are our reductions;
 * zip.NewReader / metadata-JSON decode failures are PLAIN errors upstream →
 * the DEFAULT arm → 500 (the prod body).
 */
function swiftErrorResponse(error: unknown): Response {
  if (error instanceof HTTPException) throw error;
  if (
    error instanceof SwiftInvalidVersionError ||
    error instanceof SwiftInvalidScopeError ||
    error instanceof SwiftInvalidNameError ||
    error instanceof SwiftMissingSourceArchiveError ||
    error instanceof SwiftMissingManifestFileError ||
    error instanceof SwiftManifestFileTooLargeError ||
    error instanceof SwiftManifestFilesTooLargeError ||
    error instanceof SwiftInvalidManifestVersionError
  ) {
    return swiftProblemResponse(400, error.message);
  }
  if (error instanceof SwiftDuplicateVersionError) return swiftProblemResponse(409, error.message);
  if (error instanceof SwiftPackageNotExistError) return swiftProblemResponse(404, error.message);
  if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
    return swiftProblemResponse(403, quotaMessage(error));
  }
  if (error instanceof PackageBlobTooLargeError) return swiftProblemResponse(413, error.message);
  if (error instanceof PackageSizeMismatchError) {
    return swiftProblemResponse(500, "internal server error");
  }
  // SwiftInvalidArchiveError and everything else ride the default arm.
  console.error("[packages-swift] request failed", error);
  return swiftProblemResponse(500, "internal server error");
}

// ---------------------------------------------------------------------------
// The M7 error/response helpers (the debian + alpine families share the
// plain-text apiError shape — debian.go:26-29 / alpine.go:27-30 /
// arch.go:26-29, all through helper.ProcessErrorForUser → ctx.PlainText)
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
    error instanceof AlpineInvalidBranchError ||
    error instanceof ArchMissingPkginfoError ||
    error instanceof ArchUnsupportedFormatError ||
    error instanceof ArchInvalidNameError ||
    error instanceof ArchInvalidVersionError ||
    error instanceof ArchInvalidArchitectureError ||
    error instanceof ArchPkginfoTooLargeError ||
    error instanceof ArchTooManyFileEntriesError
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
// The RPM response helpers (rpm.go:30-33 — the plain-text apiError shape,
// helper.ProcessErrorForUser → ctx.PlainText; the status map rides
// UploadPackageFile's switch: 400 ErrInvalidArgument / 409 duplicates /
// 403 quota / 404 not-exist)
// ---------------------------------------------------------------------------

function rpmPlain(status: 400 | 401 | 403 | 404 | 409 | 411 | 413 | 500, message: string): Response {
  return plainResponse(status, message);
}

function rpmErrorResponse(error: unknown): Response {
  if (error instanceof HTTPException) throw error;
  if (error instanceof RpmInvalidPackageError || error instanceof PackageSizeMismatchError) {
    return rpmPlain(400, error.message);
  }
  if (error instanceof RpmPackageNotExistError) return rpmPlain(404, error.message);
  if (error instanceof DuplicatePackageFileError) return rpmPlain(409, "package file already exists");
  if (error instanceof PackageBlobTooLargeError) return rpmPlain(413, error.message);
  if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
    return rpmPlain(403, quotaMessage(error));
  }
  console.error("[packages-rpm] request failed", error);
  return rpmPlain(500, "internal server error");
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

// ---------------------------------------------------------------------------
// The RUBYGEMS response helpers — rubygems.go:27-30: apiError wraps
// ProcessErrorForUser's message in ctx.PlainText (the plain-text family
// shape); the archive responses ride SetServeHeaders + the gzip/zlib writers
// (rubygems.go:82-94 / :122-127) — ServeSetHeaders with a ZERO LastModified
// skips the header (serve.go:101-104), Content-Type falls to the
// octet-stream default (serve.go:60), and NO byte-serving runs (upstream
// never routes these through ServeContent).
// ---------------------------------------------------------------------------

/** rubygems.go:27-30 — the plain-text apiError (the ctx.PlainText set). */
function rubygemsPlain(status: ContentfulStatus, message: string): Response {
  return plainResponse(status, message);
}

/** ctx.PlainText(200, …) for the compact-index pair (base.go:128-135 — the
 *  text/plain;charset=utf-8 + nosniff set). */
function rubygemsTextResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/** apiError(status, nil) — the EMPTY-detail body (fmt.Sprint of nil), the
 *  404 file-search / info misses and the 501 quick-filename gate. */
function rubygemsEmptyDetail(status: 404 | 501): Response {
  return new Response("", {
    status,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/** SetServeHeaders({Filename}) + the compressed archive bytes — the exact
 *  upstream header set: octet-stream + nosniff + the sandbox CSP
 *  (serveSetHeaderContentRelated), the prod Cache-Control posture
 *  (httpcache.go:31-35), the attachment disposition + expose-headers echo
 *  (serve.go:87-94), and NO Last-Modified (a zero ServeHeaderOptions time —
 *  serve.go:101-104's skip). */
function rubygemsArchiveResponse(filename: string, body: Uint8Array): Response {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  return new Response(body.slice(), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox allow-scripts allow-modals allow-popups allow-downloads",
      "cache-control": "max-age=0, private, must-revalidate",
      "content-disposition": contentDispositionAttachment(base),
      "access-control-expose-headers": "Content-Disposition",
    },
  });
}

/**
 * UploadPackageFile's error switch (rubygems.go:218-226 / :256-264): the
 * util-ErrInvalidArgument sentinels (the metadata parse family + the 32 MiB
 * cap) → 400; ErrDuplicatePackageVersion → 409; quota → 403. Everything
 * else — the corrupt tar/gzip/YAML plain errors (upstream's tar.Next,
 * gzip.NewReader and yaml.Decode failures), a duplicate file row, the store
 * caps — hits the DEFAULT arm → the prod 500 body, EXCEPT the blob cap
 * (our 413 reduction) and the lying-Content-Length store failure (the
 * npm/nuget non-InvalidArgument posture → 500).
 */
function rubygemsErrorResponse(error: unknown): Response {
  if (error instanceof HTTPException) throw error;
  if (
    error instanceof RubyMissingMetadataFileError ||
    error instanceof RubyInvalidNameError ||
    error instanceof RubyInvalidVersionError ||
    error instanceof RubyInvalidMetadataError ||
    error instanceof RubyContentTooLargeError
  ) {
    return rubygemsPlain(400, error.message);
  }
  if (error instanceof RubyPackageNotExistError) return rubygemsPlain(404, error.message);
  if (error instanceof RubyDuplicateVersionError) return rubygemsPlain(409, error.message);
  if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
    return rubygemsPlain(403, quotaMessage(error));
  }
  if (error instanceof PackageBlobTooLargeError) return rubygemsPlain(413, error.message);
  if (error instanceof PackageSizeMismatchError) {
    // The lying-Content-Length store failure — upstream's non-sentinel
    // default arm (the npm/nuget posture).
    return rubygemsPlain(500, "internal server error");
  }
  console.error("[packages-rubygems] request failed", error);
  return rubygemsPlain(500, "internal server error");
}

// The read arms — every one through the group's read gate (api.go:437-447's
// reqPackageAccess(read) wrap).

/** The specs.4.8 / latest_specs.4.8 / prerelease_specs.4.8 enumerations —
 *  the Marshal payloads gzipped through the streaming writer shape. */
async function rubygemsEnumerate(c: Context<{ Bindings: Env }>, kind: "specs" | "latest" | "prerelease"): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const filename = kind === "specs" ? "specs.4.8" : kind === "latest" ? "latest_specs.4.8" : "prerelease_specs.4.8";
    const payload =
      kind === "prerelease"
        ? buildRubyGemEmptySpecsPayload()
        : buildRubyGemSpecsPayload(
            kind === "specs"
              ? await listRubyGemVersionsByType(c.env.DB, owner.id)
              : await listLatestRubyGemVersions(c.env.DB, owner.id),
          );
    return rubygemsArchiveResponse(`${filename}.gz`, await gzipRubyGemArchive(payload));
  } catch (error) {
    return rubygemsErrorResponse(error);
  }
}

/**
 * ServePackageSpecification (rubygems.go:97-163): the filename MUST end
 * `.gemspec.rz` (else the 501 EMPTY gate); it names the stored gem
 * (`filename[:len-10] + "gem"`), whose version row renders the
 * Gem::Specification USERDEF, served zlib-compressed; `len(pvs) != 1` is the
 * EMPTY-404.
 */
async function rubygemsGemspec(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const filename = c.req.param("filename") ?? "";
    if (!filename.endsWith(".gemspec.rz")) {
      return rubygemsEmptyDetail(501);
    }
    const gemFilename = `${filename.slice(0, filename.length - 10)}gem`;
    const matches = await findRubyGemVersionsByFilename(c.env.DB, owner.id, gemFilename);
    if (matches.length !== 1) {
      return rubygemsEmptyDetail(404);
    }
    const match = matches[0];
    if (match === undefined) return rubygemsEmptyDetail(404);
    const payload = buildRubyGemSpecification(match.pkg.name, match.version.version, match.metadata);
    return rubygemsArchiveResponse(filename, await zlibRubyGemArchive(payload));
  } catch (error) {
    return rubygemsErrorResponse(error);
  }
}

/** DownloadPackageFile (rubygems.go:166-198) — the stored .gem through the
 *  D-6 serve shape; the search's `len != 1` is the EMPTY-404 sentinel. */
async function rubygemsDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const download = await openRubyGemForDownload(
      c.env.DB,
      c.env.REPO_PACKS,
      owner.id,
      c.req.param("filename") ?? "",
      c.req.method === "HEAD" ? "HEAD" : "GET",
    );
    return fileResponse(c, {
      stream: download.stream,
      size: download.size,
      filename: download.filename,
      created: download.created,
    });
  } catch (error) {
    if (error instanceof RubyPackageNotExistError) {
      // apiError(404, nil) — the len != 1 EMPTY body (rubygems.go:175-177).
      return rubygemsEmptyDetail(404);
    }
    return rubygemsErrorResponse(error);
  }
}

/** GetPackageInfo (rubygems.go:302-319) — the one-gem compact index; the
 *  version miss is the EMPTY-404, the body ctx.PlainText(200). */
async function rubygemsInfo(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const versions = await listRubyGemVersionsByName(c.env.DB, owner.id, c.req.param("packagename") ?? "");
    if (versions.length === 0) {
      return rubygemsEmptyDetail(404);
    }
    return rubygemsTextResponse(await makeRubyGemPackageInfo(c.env.DB, versions));
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    console.error("[packages-rubygems] info failed", error);
    return rubygemsPlain(500, "internal server error");
  }
}

/** GetAllPackagesVersions (rubygems.go:321-366) — the whole-store compact
 *  index (empty store → the bare `---\n`). */
async function rubygemsVersions(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    return rubygemsTextResponse(await buildRubyGemCompactIndex(c.env.DB, owner.id));
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    console.error("[packages-rubygems] versions failed", error);
    return rubygemsPlain(500, "internal server error");
  }
}

// The write arms — api/v1/gems' reqPackageAccess(write) subgroup; a null
// doer is the challenge (the go upload arm's posture).

/** UploadPackageFile (rubygems.go:201-269) — the RAW body is the .gem
 *  (ctx.UploadStream; the integration test posts bare bytes), created → 201
 *  EMPTY. */
async function rubygemsUpload(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner, cred } = await protocolContext(c, "write");
    const doer = cred.doer;
    if (doer === null) {
      return rubygemsPlain(401, "user should have specific permission or be a site admin");
    }
    await uploadRubyGem({
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
    return rubygemsErrorResponse(error);
  }
}

/**
 * DeletePackage (rubygems.go:272-298): ParseMultipartForm FIRST — a
 * non-multipart content type is Go's ErrNotMultipart → the 500 DEFAULT arm
 * (the pin's literal shape; the integration test posts multipart fields);
 * gem_name/version read through Go's r.Form order (URL query first —
 * ParseForm merges the query ahead of the body — then the multipart
 * fields). The miss is the ErrPackageNotExist 404 WITH its message; success
 * is Go's write-nothing handler answer: 200 EMPTY.
 */
async function rubygemsYank(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner, cred } = await protocolContext(c, "write");
    const doer = cred.doer;
    if (doer === null) {
      return rubygemsPlain(401, "user should have specific permission or be a site admin");
    }
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      // Go ParseMultipartForm's ErrNotMultipart — the DEFAULT arm.
      return rubygemsPlain(500, "internal server error");
    }
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      // ErrMissingBoundary / a malformed body — the DEFAULT arm.
      return rubygemsPlain(500, "internal server error");
    }
    // Go r.Form order: the URL query values lead (ParseForm), the body
    // fields append; FormString takes the FIRST hit.
    const params = new URLSearchParams(new URL(c.req.url).search);
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") params.append(key, value);
    }
    const removed = await removeRubyGemVersion(
      c.env.DB,
      owner.id,
      params.get("gem_name") ?? "",
      params.get("version") ?? "",
    );
    if (removed === null) {
      return rubygemsPlain(404, new RubyPackageNotExistError().message);
    }
    return new Response(null, { status: 200 });
  } catch (error) {
    return rubygemsErrorResponse(error);
  }
}

// ===========================================================================
// The SIX LONG-TAIL FAMILIES (SPEC-0016 §7) — vagrant, cran, pub, chef,
// composer, conan. The handlers live at module level (the rubygems split);
// the registrations sit inside createEcosystemProtocolRouter.
// ===========================================================================

// ---------------------------------------------------------------------------
// VAGRANT — vagrant.go:24-31 ({"errors":[…]}) + the api.go:488-498 arms.
// ---------------------------------------------------------------------------

function vagrantErrorResponse(status: ContentfulStatus, message: string): Response {
  return new Response(JSON.stringify({ errors: [message] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** CheckAuthenticate (vagrant.go:33-53): the bare doer-nil check — the
 *  group's read gate has ALREADY verified the credential. */
async function vagrantAuthenticate(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { cred } = await protocolContext(c, "read");
    if (cred.doer === null) {
      return vagrantErrorResponse(401, "Invalid access token");
    }
    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** CheckBoxAvailable (vagrant.go:33-53) — HEAD; the enumerate gate. */
async function vagrantBoxProbe(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    if (!(await vagrantBoxExists(c.env.DB, owner, c.req.param("name") ?? ""))) {
      return vagrantErrorResponse(404, "");
    }
    return new Response(null, { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** EnumeratePackageVersions (vagrant.go:55-95). */
async function vagrantEnumerate(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const origin = new URL(c.req.url).origin;
    const baseURL = `${origin}/api/packages/${owner.username}/vagrant/${encodeURIComponent(c.req.param("name") ?? "")}`;
    const enumerate = await enumerateVagrantBox(c.env.DB, owner, c.req.param("name") ?? "", baseURL);
    if (enumerate === null) {
      return vagrantErrorResponse(404, "");
    }
    return new Response(JSON.stringify(enumerate), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** UploadPackageFile (vagrant.go:97-171): the PUT walk. */
async function vagrantUpload(c: Context<{ Bindings: Env }>): Promise<Response> {
  const version = c.req.param("version") ?? "";
  const provider = c.req.param("provider") ?? "";
  try {
    const { owner, cred } = await protocolContext(c, "write");
    const doer = cred.doer;
    if (doer === null) {
      return vagrantErrorResponse(401, "user should have specific permission or be a site admin");
    }
    if (parseVagrantSemver(version) === null) {
      return vagrantErrorResponse(400, "package version is invalid");
    }
    if (!isVagrantProviderNameValid(provider)) {
      return vagrantErrorResponse(400, "provider name is invalid");
    }
    await uploadVagrantBox({
      d1: c.env.DB,
      bucket: c.env.REPO_PACKS,
      owner,
      doer,
      name: c.req.param("name") ?? "",
      version,
      provider,
      content: bodyStream(c.req.raw),
      declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
      quota: packagesQuotaFromEnv(c.env),
    });
    return new Response(null, { status: 201 });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof VagrantInvalidVersionError || error instanceof VagrantInvalidProviderError) {
      return vagrantErrorResponse(400, error.message);
    }
    if (error instanceof DuplicatePackageFileError) return vagrantErrorResponse(409, "package file already exists");
    if (
      error instanceof QuotaTotalCountError ||
      error instanceof QuotaTypeSizeError ||
      error instanceof QuotaTotalSizeError
    ) {
      return vagrantErrorResponse(403, quotaMessage(error));
    }
    console.error("[packages-vagrant] upload failed", error);
    return vagrantErrorResponse(500, "internal server error");
  }
}

/** DownloadPackageFile (vagrant.go:173-189). */
async function vagrantDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const download = await openVagrantBoxForDownload(
      c.env.DB,
      c.env.REPO_PACKS,
      owner,
      c.req.param("name") ?? "",
      c.req.param("version") ?? "",
      c.req.param("provider") ?? "",
      c.req.method === "HEAD" ? "HEAD" : "GET",
    );
    if (download === null) return vagrantErrorResponse(404, "");
    return fileResponse(c, {
      stream: download.stream,
      size: download.size,
      filename: download.file.name,
      created: download.file.createdUnix,
    });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CRAN — cran.go:27-30 (the PLAIN TEXT apiError) + the api.go:300-318 arms.
// ---------------------------------------------------------------------------

/** apiError(404, nil) / apiError(400, nil) — the EMPTY-detail bodies. */
function cranEmptyDetail(status: 400 | 401 | 404): Response {
  return plainResponse(status, "");
}

/** enumeratePackages (cran.go:49-111): the PACKAGES(.gz) body — an EMPTY
 *  answer is the 404-nil; the `.gz` suffix renders the gzipped form
 *  (application/x-gzip). */
async function cranEnumerate(c: Context<{ Bindings: Env }>, fileType: string, platform: string, rversion: string): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const gz = (c.req.path.endsWith(".gz") ? ".gz" : "") !== "";
    if (gz && !c.req.path.endsWith("PACKAGES.gz")) {
      return cranEmptyDetail(404);
    }
    const entries = await enumerateCranPackages(c.env.DB, owner, fileType, platform, rversion);
    if (entries.length === 0) {
      return cranEmptyDetail(404);
    }
    const body = renderCranPackagesIndex(entries);
    if (gz) {
      const { gzipCompress } = await import("../../services/packages/distro-common");
      const bytes = await gzipCompress(new TextEncoder().encode(body));
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "content-type": "application/x-gzip" },
      });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain;charset=utf-8" },
    });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    console.error("[packages-cran] enumerate failed", error);
    return plainResponse(500, "internal server error");
  }
}

/** downloadPackageFile (cran.go:208-253). */
async function cranDownload(c: Context<{ Bindings: Env }>, fileType: string, platform: string, rversion: string): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const download = await openCranFileForDownload(
      c.env.DB,
      c.env.REPO_PACKS,
      owner,
      fileType,
      platform,
      rversion,
      c.req.param("filename") ?? "",
    );
    if (download === null) return cranEmptyDetail(404);
    return fileResponse(c, {
      stream: download.stream,
      size: download.size,
      filename: download.file.name,
      created: download.file.createdUnix,
    });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** uploadPackageFile (cran.go:113-206): the src/bin PUTs; the binary arm
 *  reads the platform/rversion query pair (the 400-nil missing arm). */
async function cranUpload(c: Context<{ Bindings: Env }>, kind: "source" | "binary"): Promise<Response> {
  try {
    const { owner, cred } = await protocolContext(c, "write");
    const doer = cred.doer;
    if (doer === null) {
      return cranEmptyDetail(401);
    }
    let platform = "";
    let rversion = "";
    if (kind === "binary") {
      platform = c.req.query("platform") ?? "";
      rversion = c.req.query("rversion") ?? "";
      if (platform === "" || rversion === "") {
        return cranEmptyDetail(400);
      }
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
    if (kind === "source") {
      await uploadCranSourcePackage(input);
    } else {
      await uploadCranBinaryPackage(input, platform, rversion);
    }
    return new Response(null, { status: 201 });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    if (
      error instanceof CranMissingDescriptionError ||
      error instanceof CranInvalidNameError ||
      error instanceof CranInvalidVersionError
    ) {
      return plainResponse(400, error.message);
    }
    if (error instanceof DuplicatePackageFileError) return plainResponse(409, "package file already exists");
    if (
      error instanceof QuotaTotalCountError ||
      error instanceof QuotaTypeSizeError ||
      error instanceof QuotaTotalSizeError
    ) {
      return plainResponse(403, quotaMessage(error));
    }
    // The corrupt-archive class (plain Go errors upstream) and everything
    // else — the 500 default arm.
    if (error instanceof CranArchiveError) {
      console.error("[packages-cran] upload failed", error);
    }
    return plainResponse(500, "internal server error");
  }
}

// ---------------------------------------------------------------------------
// PUB — pub.go:25-39 ({"error":{code,message}} over
// application/vnd.pub.v2+json) + the api.go:398-413 arms.
// ---------------------------------------------------------------------------

const PUB_CONTENT_TYPE = "application/vnd.pub.v2+json";

function pubJsonResponse(status: 200 | ContentfulStatus, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": PUB_CONTENT_TYPE } });
}

/** apiError (pub.go:25-39) — the StatusText code + the message. */
function pubErrorResponse(status: ContentfulStatus, message: string): Response {
  return pubJsonResponse(status, { error: { code: httpStatusText(status), message } });
}

/** Go's http.StatusText for the codes the family answers. */
function httpStatusText(status: ContentfulStatus): string {
  const texts: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    411: "Length Required",
    413: "Request Entity Too Large",
    500: "Internal Server Error",
  };
  return texts[status] ?? "";
}

function pubOriginBaseURL(c: Context<{ Bindings: Env }>, owner: UserRow): string {
  const origin = new URL(c.req.url).origin;
  return `${origin}/api/packages/${owner.username}/pub/api/packages`;
}

/** RequestUpload (pub.go:99-112): the upload-url form (the fields map is
 *  ALWAYS empty — the direct-upload answer). */
async function pubRequestUpload(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "write");
    return pubJsonResponse(200, {
      url: `${pubOriginBaseURL(c, owner)}/versions/new/upload`,
      fields: {},
    });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** UploadPackageFile (pub.go:117-190): the multipart POST; 204 carries the
 *  Location finalize header. */
async function pubUpload(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner, cred } = await protocolContext(c, "write");
    const doer = cred.doer;
    if (doer === null) {
      return pubErrorResponse(401, "user should have specific permission or be a site admin");
    }
    const result = await uploadPubPackage({
      d1: c.env.DB,
      bucket: c.env.REPO_PACKS,
      owner,
      doer,
      contentType: c.req.header("content-type") ?? "",
      content: bodyStream(c.req.raw),
      declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
      quota: packagesQuotaFromEnv(c.env),
    });
    return new Response(null, {
      status: 204,
      headers: {
        location: `${pubOriginBaseURL(c, owner)}/versions/new/finalize/${encodeURIComponent(result.parsed.name)}/${encodeURIComponent(result.parsed.version)}`,
      },
    });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    if (
      error instanceof PubMissingPubspecError ||
      error instanceof PubPubspecTooLargeError ||
      error instanceof PubInvalidNameError ||
      error instanceof PubInvalidVersionError ||
      error instanceof PubMissingFileError ||
      error instanceof PubArchiveError
    ) {
      return pubErrorResponse(400, error.message);
    }
    if (error instanceof DuplicatePackageVersionError) return pubErrorResponse(409, error.message);
    if (
      error instanceof QuotaTotalCountError ||
      error instanceof QuotaTypeSizeError ||
      error instanceof QuotaTotalSizeError
    ) {
      return pubErrorResponse(403, quotaMessage(error));
    }
    console.error("[packages-pub] upload failed", error);
    return pubErrorResponse(500, "internal server error");
  }
}

/** FinalizePackage (pub.go:130-154): {"success":{}} 200 / the 404 arm. */
async function pubFinalize(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "write");
    if (!(await pubVersionExists(c.env.DB, owner, c.req.param("id") ?? "", c.req.param("version") ?? ""))) {
      return pubErrorResponse(404, "");
    }
    return pubJsonResponse(200, { success: { message: "" } });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** EnumeratePackageVersions (pub.go:52-99). */
async function pubEnumerate(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const id = c.req.param("id") ?? "";
    const enumerate = await enumeratePubPackage(c.env.DB, owner, id, pubOriginBaseURL(c, owner));
    if (enumerate === null) {
      return pubErrorResponse(404, "");
    }
    return pubJsonResponse(200, enumerate);
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** PackageVersionMetadata (pub.go:101-128). */
async function pubVersionMetadata(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const metadata = await getPubVersionMetadata(
      c.env.DB,
      owner,
      c.req.param("id") ?? "",
      c.req.param("version") ?? "",
      pubOriginBaseURL(c, owner),
    );
    if (metadata === null) {
      return pubErrorResponse(404, "");
    }
    return pubJsonResponse(200, metadata);
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** DownloadPackageFile (pub.go:192-222). */
async function pubDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const download = await openPubFileForDownload(
      c.env.DB,
      c.env.REPO_PACKS,
      owner,
      c.req.param("id") ?? "",
      c.req.param("version") ?? "",
      c.req.method === "HEAD" ? "HEAD" : "GET",
    );
    if (download === null) return pubErrorResponse(404, "");
    return fileResponse(c, {
      stream: download.stream,
      size: download.size,
      filename: download.file.name,
      created: download.file.createdUnix,
    });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CHEF — chef.go:24-31 ({"error_messages":[…]}) + the api.go:147-164 arms.
// ---------------------------------------------------------------------------

function chefErrorResponse(status: ContentfulStatus, message: string): Response {
  return new Response(JSON.stringify({ error_messages: [message] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** PackagesUniverse (chef.go:35-72). */
async function chefUniverse(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const origin = new URL(c.req.url).origin;
    const baseURL = `${origin}/api/packages/${owner.username}/chef/api/v1`;
    const universe = await buildChefUniverse(c.env.DB, owner, baseURL);
    return new Response(JSON.stringify(universe), { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** EnumeratePackages (chef.go:75-136) — /search AND the /cookbooks root. */
async function chefEnumerate(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const origin = new URL(c.req.url).origin;
    const baseURL = `${origin}/api/packages/${owner.username}/chef/api/v1/cookbooks/`;
    const result = await searchChefPackages(
      c.env.DB,
      owner,
      c.req.query("q") ?? "",
      c.req.query("order") ?? "",
      // NewAbsoluteListOptions (chef.go:70-73 + list_options.go): an absent
      // or take<=0 `items` falls back to DefaultPagingNum(10) — upstream's
      // own default, not an empty window (the probes battery's parity find).
      Number.parseInt(c.req.query("start") ?? "0", 10) || 0,
      (() => {
        const items = Number.parseInt(c.req.query("items") ?? "0", 10) || 0;
        return items > 0 ? items : 10;
      })(),
      baseURL,
    );
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** UploadPackage (chef.go:201-251): the multipart POST. */
async function chefUpload(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner, cred } = await protocolContext(c, "write");
    const doer = cred.doer;
    if (doer === null) {
      return chefErrorResponse(401, "user should have specific permission or be a site admin");
    }
    await uploadChefPackage({
      d1: c.env.DB,
      bucket: c.env.REPO_PACKS,
      owner,
      doer,
      contentType: c.req.header("content-type") ?? "",
      content: bodyStream(c.req.raw),
      declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
      quota: packagesQuotaFromEnv(c.env),
    });
    return new Response(JSON.stringify({}), { status: 201, headers: { "content-type": "application/json" } });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    if (
      error instanceof ChefMissingMetadataError ||
      error instanceof ChefInvalidNameError ||
      error instanceof ChefInvalidVersionError ||
      error instanceof ChefMissingTarballError
    ) {
      return chefErrorResponse(400, error.message);
    }
    if (error instanceof DuplicatePackageVersionError) return chefErrorResponse(409, error.message);
    if (
      error instanceof QuotaTotalCountError ||
      error instanceof QuotaTypeSizeError ||
      error instanceof QuotaTotalSizeError
    ) {
      return chefErrorResponse(403, quotaMessage(error));
    }
    // The corrupt-archive class — the 500 default arm (chef.go:216-222).
    if (error instanceof ChefArchiveError) {
      console.error("[packages-chef] upload failed", error);
    }
    return chefErrorResponse(500, "internal server error");
  }
}

/** PackageMetadata (chef.go:139-186). */
async function chefCookbookMetadata(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const origin = new URL(c.req.url).origin;
    const name = c.req.param("name") ?? "";
    const versionsBaseURL = `${origin}/api/packages/${owner.username}/chef/api/v1/cookbooks/${encodeURIComponent(name)}/versions/`;
    const metadata = await getChefCookbookMetadata(c.env.DB, owner, name, versionsBaseURL);
    if (metadata === null) {
      return chefErrorResponse(404, "");
    }
    return new Response(JSON.stringify(metadata), { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** PackageVersionMetadata (chef.go:189-236). */
async function chefVersionMetadata(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const origin = new URL(c.req.url).origin;
    const name = c.req.param("name") ?? "";
    const cookbookBaseURL = `${origin}/api/packages/${owner.username}/chef/api/v1/cookbooks/${encodeURIComponent(name)}`;
    const metadata = await getChefVersionMetadata(c.env.DB, owner, name, c.req.param("version") ?? "", cookbookBaseURL);
    if (metadata === null) {
      return chefErrorResponse(404, "");
    }
    return new Response(JSON.stringify(metadata), { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** DownloadPackage (chef.go:239-264). */
async function chefDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const download = await openChefPackageForDownload(
      c.env.DB,
      c.env.REPO_PACKS,
      owner,
      c.req.param("name") ?? "",
      c.req.param("version") ?? "",
      c.req.method === "HEAD" ? "HEAD" : "GET",
    );
    if (download === null) return chefErrorResponse(404, "");
    return fileResponse(c, {
      stream: download.stream,
      size: download.size,
      filename: download.file.name,
      created: download.file.createdUnix,
    });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** DeletePackageVersion (chef.go:267-286) — write. */
async function chefDeleteVersion(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner, cred } = await protocolContext(c, "write");
    const doer = cred.doer;
    if (doer === null) {
      return chefErrorResponse(401, "user should have specific permission or be a site admin");
    }
    const deleted = await deleteChefPackageVersion(c.env.DB, owner, c.req.param("name") ?? "", c.req.param("version") ?? "");
    if (!deleted) return chefErrorResponse(404, "");
    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** DeletePackage (chef.go:289-316) — write. */
async function chefDeleteCookbook(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner, cred } = await protocolContext(c, "write");
    const doer = cred.doer;
    if (doer === null) {
      return chefErrorResponse(401, "user should have specific permission or be a site admin");
    }
    const deleted = await deleteChefPackage(c.env.DB, owner, c.req.param("name") ?? "");
    if (!deleted) return chefErrorResponse(404, "");
    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// COMPOSER — composer.go:39-49 ({"errors":[{status,message}]}) + the
// api.go:166-175 arms.
// ---------------------------------------------------------------------------

function composerErrorResponse(status: ContentfulStatus, message: string): Response {
  return new Response(JSON.stringify({ errors: [{ status, message }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** ServiceIndex (api.go:18-28). */
async function composerServiceIndex(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const origin = new URL(c.req.url).origin;
    const index = buildComposerServiceIndex(`${origin}/api/packages/${owner.username}/composer`);
    return new Response(JSON.stringify(index), { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** SearchPackages (api.go:34-91). */
async function composerSearch(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const origin = new URL(c.req.url).origin;
    const result = await searchComposerPackages(
      c.env.DB,
      owner,
      c.req.query("q") ?? "",
      c.req.query("type") ?? "",
      Number.parseInt(c.req.query("page") ?? "1", 10) || 1,
      Number.parseInt(c.req.query("per_page") ?? "0", 10) || 0,
      `${origin}/api/packages/${owner.username}/composer/search.json`,
    );
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** EnumeratePackages (api.go:97-110). */
async function composerList(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const names = await listComposerPackages(c.env.DB, owner);
    return new Response(JSON.stringify({ packageNames: names }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** PackageMetadata (api.go:113-176) — the ~dev.json twin strips its suffix. */
async function composerMetadata(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner, cred } = await protocolContext(c, "read");
    const origin = new URL(c.req.url).origin;
    const registryURL = `${origin}/api/packages/${owner.username}/composer`;
    let project = c.req.param("filename") ?? "";
    if (project.endsWith("~dev.json")) {
      project = project.slice(0, -"~dev.json".length);
    } else if (project.endsWith(".json")) {
      project = project.slice(0, -".json".length);
    } else {
      // The whole-segment capture admits non-.json shapes (upstream's chi
      // class [^/^.]+ never matches them — the route itself 404s); answer
      // the family's own not-found body.
      return c.json({ errors: [{ status: 404, message: "package does not exist" }] }, 404);
    }
    const metadata = await getComposerPackageMetadata(
      c.env.DB,
      owner,
      c.req.param("vendor") ?? "",
      project,
      registryURL,
      origin,
      cred.doer === null ? null : { id: cred.doer.id, isAdmin: cred.doer.isAdmin },
    );
    if (metadata === null) {
      return composerErrorResponse(404, "package does not exist");
    }
    return new Response(JSON.stringify(metadata), { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** DownloadPackageFile (composer.go:121-146). */
async function composerDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner } = await protocolContext(c, "read");
    const download = await openComposerFileForDownload(
      c.env.DB,
      c.env.REPO_PACKS,
      owner,
      c.req.param("package") ?? "",
      c.req.param("version") ?? "",
      c.req.param("filename") ?? "",
      c.req.method === "HEAD" ? "HEAD" : "GET",
    );
    if (download === null) return composerErrorResponse(404, "package does not exist");
    return fileResponse(c, {
      stream: download.stream,
      size: download.size,
      filename: download.file.name,
      created: download.file.createdUnix,
    });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  }
}

/** UploadPackage (composer.go:151-223): the RAW body PUT. */
async function composerUpload(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const { owner, cred } = await protocolContext(c, "write");
    const doer = cred.doer;
    if (doer === null) {
      return composerErrorResponse(401, "user should have specific permission or be a site admin");
    }
    await uploadComposerPackage({
      d1: c.env.DB,
      bucket: c.env.REPO_PACKS,
      owner,
      doer,
      content: bodyStream(c.req.raw),
      declaredLength: contentLength(c.req.raw) ?? undefined, // chunked streams (D-2)
      versionParam: c.req.query("version") ?? "",
      quota: packagesQuotaFromEnv(c.env),
    });
    return new Response(null, { status: 201 });
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    if (
      error instanceof ComposerMissingComposerJsonError ||
      error instanceof ComposerInvalidNameError ||
      error instanceof ComposerInvalidVersionError
    ) {
      return composerErrorResponse(400, error.message);
    }
    if (error instanceof DuplicatePackageVersionError) return composerErrorResponse(409, error.message);
    if (
      error instanceof QuotaTotalCountError ||
      error instanceof QuotaTypeSizeError ||
      error instanceof QuotaTotalSizeError
    ) {
      return composerErrorResponse(403, quotaMessage(error));
    }
    // The corrupt-archive / missing-version arms ride the default here —
    // the missing-version arm is the route's OWN 400 (composer.go:172-176).
    if (error instanceof ComposerArchiveError) {
      console.error("[packages-composer] upload failed", error);
    }
    return composerErrorResponse(500, "internal server error");
  }
}

// ---------------------------------------------------------------------------
// CONAN — conan.go:54-66 ({"message": …} over application/json) + the
// api.go:175-290 v1/v2 tables, ONE decoded-remainder walk.
// ---------------------------------------------------------------------------

/** jsonResponse (conan.go:54-59) — Go's json.Encoder appends the newline. */
function conanJsonResponse(status: 200 | 201 | 404, body: unknown): Response {
  return new Response(`${JSON.stringify(body)}\n`, { status, headers: { "content-type": "application/json" } });
}

function conanErrorResponseRaw(status: ContentfulStatus, message: string): Response {
  return new Response(`${JSON.stringify({ message })}\n`, {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface ConanGate {
  owner: UserRow;
  cred: ResolvedCredential;
}

/**
 * The conan credential pass: the STANDARD gate first (protocolContext), a
 * minted authenticate token riding the Basic password / Bearer header
 * second (the client echoes /users/authenticate's token back — upstream's
 * CreateAuthorizationToken flow, verified beside the shared credentials).
 */
async function conanGate(c: Context<{ Bindings: Env }>, required: "read" | "write"): Promise<ConanGate> {
  try {
    return await protocolContext(c, required);
  } catch (error) {
    if (!(error instanceof HTTPException)) throw error;
    if (error.getResponse().status !== 401) throw error;
    const gate = await conanMintedGate(c, required);
    if (gate !== null) return gate;
    throw error;
  }
}

/** The minted-token fallback (upstream's CreateAuthorizationToken/verify
 *  pair reduced to the auth module's mint seam). */
async function conanMintedGate(c: Context<{ Bindings: Env }>, required: "read" | "write"): Promise<ConanGate | null> {
  const header = c.req.raw.headers.get("Authorization");
  let token = "";
  if (header !== null) {
    const lower = header.toLowerCase();
    if (lower.startsWith("bearer ")) token = header.slice(7).trim();
    if (lower.startsWith("basic ")) {
      const decoded = atob(header.slice(6).trim());
      const colon = decoded.indexOf(":");
      token = colon === -1 ? "" : decoded.slice(colon + 1);
    }
  }
  if (token === "") return null;
  const claims = await verifyContainerToken(c.env.DB, token);
  if (claims === null || claims.userId === CONTAINER_GHOST_USER_ID) return null;
  const owner = await resolveOwnerRow(c.env.DB, c.req.param("username") ?? "");
  if (owner === null) return null;
  const row = (await drizzle(c.env.DB).select().from(users).where(eq(users.id, claims.userId)).get()) ?? null;
  if (row === null) return null;
  const doer = rowToAuthUser(row);
  await protocolAccessGate(c.env.DB, required, owner, { doer, scope: ScopeSet.parseLenient("write:package") });
  return { owner, cred: { doer, scope: ScopeSet.parseLenient("write:package") } };
}

/** The v1/v2 write arms answer the bare challenge (the go upload posture). */
function conanUnauthorized(): Response {
  return conanErrorResponseRaw(401, "user should have specific permission or be a site admin");
}

function conanFileURLBase(c: Context<{ Bindings: Env }>, owner: UserRow, recipeLinkName: string): string {
  const origin = new URL(c.req.url).origin;
  return `${origin}/api/packages/${owner.username}/conan/v1/files/${recipeLinkName}`;
}

interface ConanRouteTarget {
  version: "v1" | "v2";
  arm: string;
  recipe: ConanRecipeReference;
  pref: ConanPackageReference | null;
  filename: string;
}

/**
 * The walk over the decoded remainder (the npm posture — the RESERVED
 * escapes survive in c.req.path; the walk decodes per segment, a malformed
 * escape 404s). Returns null = the router-page 404.
 */
function parseConanTarget(parts: string[], method: string): ConanRouteTarget | null {
  const version = parts[0] === "v1" ? "v1" : parts[0] === "v2" ? "v2" : null;
  if (version === null) return null;
  const rest = parts.slice(1);
  // ping / users/{authenticate,check_credentials} / conans/search
  if (rest[0] === undefined || rest[0] === "ping") {
    return { version, arm: "ping", recipe: newConanRecipeReference("x", "1.0", "_", "_", ""), pref: null, filename: "" };
  }
  if (rest[0] === "users") {
    if (rest[1] === "authenticate" || rest[1] === "check_credentials") {
      return { version, arm: rest[1], recipe: newConanRecipeReference("x", "1.0", "_", "_", ""), pref: null, filename: "" };
    }
    return null;
  }
  if (rest[0] !== "conans") return null;
  if (rest[1] === "search") {
    return { version, arm: "recipe-search", recipe: newConanRecipeReference("x", "1.0", "_", "_", ""), pref: null, filename: "" };
  }
  // conans/{name}/{version}/{user}/{channel}[/…]
  const name = rest[1];
  const recipeVersion = rest[2];
  const user = rest[3];
  const channel = rest[4];
  if (name === undefined || recipeVersion === undefined || user === undefined || channel === undefined) return null;
  let recipe: ConanRecipeReference;
  try {
    recipe = newConanRecipeReference(name, recipeVersion, user, channel, "");
  } catch {
    return null;
  }
  const tail = rest.slice(5);
  const pinRevision = (revision: string): ConanRouteTarget | null => {
    try {
      recipe = newConanRecipeReference(name, recipeVersion, user, channel, revision);
      return null;
    } catch {
      return null;
    }
  };
  void pinRevision;
  const withRevision = (revision: string): ConanRecipeReference | null => {
    try {
      return newConanRecipeReference(name, recipeVersion, user, channel, revision);
    } catch {
      return null;
    }
  };

  // No tail: GET snapshot / DELETE (v1 always, v2 by-revision-or-all).
  if (tail.length === 0) {
    return { version, arm: method === "DELETE" ? "delete-recipe" : "snapshot", recipe, pref: null, filename: "" };
  }
  const head = tail[0] ?? "";
  if (tail.length === 1 && head === "search") return { version, arm: "package-search", recipe, pref: null, filename: "" };
  if (tail.length === 1 && head === "digest") return { version, arm: "recipe-urls", recipe, pref: null, filename: "" };
  if (tail.length === 1 && head === "download_urls") return { version, arm: "recipe-urls", recipe, pref: null, filename: "" };
  if (tail.length === 1 && head === "upload_urls") return { version, arm: "recipe-upload-urls", recipe, pref: null, filename: "" };
  if (tail.length === 1 && head === "latest" && version === "v2") {
    return { version, arm: "recipe-latest", recipe, pref: null, filename: "" };
  }
  if (tail.length === 1 && head === "revisions" && version === "v2") {
    if (method === "DELETE") return { version, arm: "delete-recipe", recipe, pref: null, filename: "" };
    return { version, arm: "recipe-revisions", recipe, pref: null, filename: "" };
  }
  if (head === "packages" && tail.length >= 2) {
    if (tail[1] === "delete" && tail.length === 2) {
      return { version, arm: "delete-packages-v1", recipe, pref: null, filename: "" };
    }
    const reference = tail[1] ?? "";
    if (reference === "" || reference === "delete") return null;
    const packageTail = tail.slice(2);
    const barePref = (): ConanPackageReference => ({ recipe, reference, revision: "" });
    if (packageTail.length === 0) {
      return { version, arm: method === "DELETE" ? "delete-package" : "package-snapshot", recipe, pref: barePref(), filename: "" };
    }
    const pkgHead = packageTail[0] ?? "";
    if (pkgHead === "digest" && packageTail.length === 1) {
      return { version, arm: "package-urls", recipe, pref: barePref(), filename: "" };
    }
    if (pkgHead === "download_urls" && packageTail.length === 1) {
      return { version, arm: "package-urls", recipe, pref: barePref(), filename: "" };
    }
    if (pkgHead === "upload_urls" && packageTail.length === 1) {
      return { version, arm: "package-upload-urls", recipe, pref: barePref(), filename: "" };
    }
    if (pkgHead === "latest" && packageTail.length === 1 && version === "v2") {
      return { version, arm: "package-latest", recipe, pref: barePref(), filename: "" };
    }
    if (pkgHead === "revisions" && version === "v2") {
      const pkgTail = packageTail.slice(1);
      if (pkgTail.length === 0) {
        if (method === "DELETE") return { version, arm: "delete-package", recipe, pref: null, filename: "" };
        return { version, arm: "package-revisions", recipe, pref: null, filename: "" };
      }
      const prev = pkgTail[0] ?? "";
      const deep = pkgTail.slice(1);
      if (deep.length === 0) {
        if (method === "DELETE") {
          return { version, arm: "delete-package", recipe, pref: { recipe, reference, revision: prev }, filename: "" };
        }
        return { version, arm: "package-revision-files", recipe, pref: { recipe, reference, revision: prev }, filename: "" };
      }
      if (deep[0] === "files" && deep.length === 1) {
        return { version, arm: "package-revision-files", recipe, pref: { recipe, reference, revision: prev }, filename: "" };
      }
      if (deep[0] === "files" && deep.length === 2) {
        return { version, arm: "package-file", recipe, pref: { recipe, reference, revision: prev }, filename: deep[1] ?? "" };
      }
      return null;
    }
    return null;
  }
  if (head === "revisions" && version === "v2" && tail.length >= 2) {
    const revision = tail[1] ?? "";
    const pinned = withRevision(revision);
    if (pinned === null) return null;
    const revTail = tail.slice(2);
    if (revTail.length === 0) {
      if (method === "DELETE") return { version, arm: "delete-recipe", recipe: pinned, pref: null, filename: "" };
      return { version, arm: "recipe-revision-files", recipe: pinned, pref: null, filename: "" };
    }
    if (revTail[0] === "search" && revTail.length === 1) {
      return { version, arm: "package-search", recipe: pinned, pref: null, filename: "" };
    }
    if (revTail[0] === "files") {
      const fileTail = revTail.slice(1);
      if (fileTail.length === 0) {
        return { version, arm: "recipe-revision-files", recipe: pinned, pref: null, filename: "" };
      }
      if (fileTail.length === 1) {
        return { version, arm: "recipe-file", recipe: pinned, pref: null, filename: fileTail[0] ?? "" };
      }
      // recipe/{reference}/{prev}/... — the v2 PACKAGE file shapes ride
      // /revisions/{rev}/packages (handled below) — anything else 404s.
      return null;
    }
    if (revTail[0] === "packages" && revTail.length >= 2) {
      const reference = revTail[1] ?? "";
      if (reference === "" || reference === "delete") return null;
      const pkgTail = revTail.slice(2);
      if (pkgTail.length === 0) {
        if (method === "DELETE") {
          return { version, arm: "delete-package", recipe: pinned, pref: null, filename: "" };
        }
        return { version, arm: "package-snapshot", recipe: pinned, pref: null, filename: "" };
      }
      const pkgHead = pkgTail[0] ?? "";
      if (pkgHead === "latest" && pkgTail.length === 1) {
        return { version, arm: "package-latest", recipe: pinned, pref: null, filename: "" };
      }
      if (pkgHead === "revisions") {
        const deep = pkgTail.slice(1);
        if (deep.length === 0) {
          if (method === "DELETE") return { version, arm: "delete-package", recipe: pinned, pref: null, filename: "" };
          return { version, arm: "package-revisions", recipe: pinned, pref: null, filename: "" };
        }
        const prev = deep[0] ?? "";
        const deepest = deep.slice(1);
        if (deepest.length === 0) {
          if (method === "DELETE") {
            return { version, arm: "delete-package", recipe: pinned, pref: { recipe, reference, revision: prev }, filename: "" };
          }
          return { version, arm: "package-revision-files", recipe: pinned, pref: { recipe, reference, revision: prev }, filename: "" };
        }
        if (deepest[0] === "files" && deepest.length === 1) {
          return { version, arm: "package-revision-files", recipe: pinned, pref: { recipe, reference, revision: prev }, filename: "" };
        }
        if (deepest[0] === "files" && deepest.length === 2) {
          return { version, arm: "package-file", recipe: pinned, pref: { recipe, reference, revision: prev }, filename: deepest[1] ?? "" };
        }
        return null;
      }
      return null;
    }
    return null;
  }
  return null;
}

async function conanDispatch(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const rawPath = c.req.path;
    const segments = rawPath.split("/");
    // ["", "api", "packages", {username}, "conan", …]
    const prefix = `/api/packages/${segments[3] ?? ""}/conan`;
    if (!rawPath.startsWith(`${prefix}/`)) {
      return conanErrorResponseRaw(404, "");
    }
    const parts: string[] = [];
    for (const part of rawPath.slice(prefix.length + 1).split("/")) {
      try {
        parts.push(decodeURIComponent(part));
      } catch {
        return conanErrorResponseRaw(404, "");
      }
    }
    const target = parseConanTarget(parts, c.req.method);
    if (target === null) {
      return conanErrorResponseRaw(404, "");
    }
    if (target.arm === "ping") {
      return new Response(null, { status: 200, headers: { "x-conan-server-capabilities": "revisions" } });
    }
    if (target.arm === "authenticate") {
      const { cred } = await conanGate(c, "read");
      if (cred.doer === null) {
        return conanErrorResponseRaw(400, "");
      }
      return new Response(await mintContainerToken(c.env.DB, cred.doer.id, "package:read,package:write"), { status: 200 });
    }
    if (target.arm === "check_credentials") {
      const { cred } = await conanGate(c, "read");
      return cred.doer === null ? new Response(null, { status: 401 }) : new Response(null, { status: 200 });
    }
    if (target.arm === "recipe-search") {
      const { owner } = await conanGate(c, "read");
      return conanJsonResponse(200, { results: await searchConanRecipes(c.env.DB, owner.id, c.req.query("q") ?? "") });
    }
    if (target.arm === "snapshot" || target.arm === "recipe-revision-files") {
      const { owner } = await conanGate(c, "read");
      if (target.arm === "snapshot" && c.req.method === "GET") {
        const files = await buildConanSnapshot(c.env.DB, owner.id, target.recipe, conanRecipeAsKey(target.recipe));
        if (files === null) return conanErrorResponseRaw(404, "");
        return conanJsonResponse(200, files);
      }
      const files = await listConanRevisionFiles(c.env.DB, owner.id, target.recipe, conanRecipeAsKey(target.recipe));
      if (files === null) return conanErrorResponseRaw(404, "");
      return conanJsonResponse(200, files);
    }
    if (target.arm === "recipe-urls") {
      const { owner } = await conanGate(c, "read");
      const urls = await buildConanDownloadUrls(
        c.env.DB,
        owner.id,
        target.recipe,
        conanRecipeAsKey(target.recipe),
        `${conanFileURLBase(c, owner, conanRecipeLinkName(target.recipe))}/recipe`,
      );
      if (urls === null) return conanErrorResponseRaw(404, "");
      return conanJsonResponse(200, urls);
    }
    if (target.arm === "recipe-upload-urls" || target.arm === "package-upload-urls") {
      if (c.req.method !== "POST") return conanErrorResponseRaw(404, "");
      const { owner, cred } = await conanGate(c, "write");
      const doer = cred.doer;
      if (doer === null) return conanUnauthorized();
      const hasPackage = target.arm === "package-upload-urls";
      let sizes: Record<string, number>;
      try {
        const parsed: unknown = await c.req.json();
        if (parsed === null || typeof parsed !== "object") {
          return conanErrorResponseRaw(400, "");
        }
        sizes = parsed as Record<string, number>;
      } catch {
        return conanErrorResponseRaw(400, "");
      }
      const urlBase = hasPackage
        ? `${conanFileURLBase(c, owner, conanRecipeLinkName(target.recipe))}/package/${target.pref === null ? "" : conanPackageLinkName(target.pref)}`
        : `${conanFileURLBase(c, owner, conanRecipeLinkName(target.recipe))}/recipe`;
      return conanJsonResponse(200, buildConanUploadUrls(sizes ?? {}, hasPackage, urlBase));
    }
    if (target.arm === "recipe-file" || target.arm === "package-file") {
      const hasPackage = target.arm === "package-file";
      if (c.req.method === "PUT") {
        const { owner, cred } = await conanGate(c, "write");
        const doer = cred.doer;
        if (doer === null) return conanUnauthorized();
        try {
          await uploadConanFile({
            d1: c.env.DB,
            bucket: c.env.REPO_PACKS,
            owner,
            doer,
            recipe: target.recipe,
            packageReference: target.pref,
            filename: target.filename,
            content: bodyStream(c.req.raw),
            declaredLength: contentLength(c.req.raw) ?? undefined,
            quota: packagesQuotaFromEnv(c.env),
          });
        } catch (error) {
          if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
            return conanErrorResponseRaw(403, quotaMessage(error));
          }
          throw error;
        }
        return new Response(null, { status: 201 });
      }
      if (c.req.method !== "GET" && c.req.method !== "HEAD") return conanErrorResponseRaw(404, "");
      const { owner } = await conanGate(c, "read");
      const fileKey = hasPackage && target.pref !== null ? conanPackageAsKey(target.pref) : conanRecipeAsKey(target.recipe);
      const download = await openConanFileForDownload(
        c.env.DB,
        c.env.REPO_PACKS,
        owner.id,
        target.recipe,
        fileKey,
        target.filename,
        c.req.method === "HEAD" ? "HEAD" : "GET",
      );
      if (download === null) return conanErrorResponseRaw(404, "");
      return fileResponse(c, {
        stream: download.stream,
        size: download.size,
        filename: download.file.name,
        created: download.file.createdUnix,
      });
    }
    if (target.arm === "package-snapshot" || target.arm === "package-urls" || target.arm === "package-revision-files") {
      const { owner } = await conanGate(c, "read");
      if (target.arm === "package-snapshot" && c.req.method === "GET") {
        const pref = target.pref;
        if (pref === null) return conanErrorResponseRaw(404, "");
        const files = await buildConanSnapshot(c.env.DB, owner.id, target.recipe, conanPackageAsKey(pref));
        if (files === null) return conanErrorResponseRaw(404, "");
        return conanJsonResponse(200, files);
      }
      if (target.arm === "package-revision-files") {
        const pref = target.pref;
        if (pref === null) return conanErrorResponseRaw(404, "");
        const files = await listConanRevisionFiles(c.env.DB, owner.id, target.recipe, conanPackageAsKey(pref));
        if (files === null) return conanErrorResponseRaw(404, "");
        return conanJsonResponse(200, files);
      }
      const pref = target.pref;
      if (pref === null) return conanErrorResponseRaw(404, "");
      const urls = await buildConanDownloadUrls(
        c.env.DB,
        owner.id,
        target.recipe,
        conanPackageAsKey(pref),
        `${conanFileURLBase(c, owner, conanRecipeLinkName(target.recipe))}/package/${conanPackageLinkName(pref)}`,
      );
      if (urls === null) return conanErrorResponseRaw(404, "");
      return conanJsonResponse(200, urls);
    }
    if (target.arm === "recipe-latest") {
      const { owner } = await conanGate(c, "read");
      const latest = await getConanLatestRecipeRevision(c.env.DB, owner.id, target.recipe);
      if (latest === null) return conanErrorResponseRaw(404, "");
      return conanJsonResponse(200, { revision: latest.revision, time: latest.time });
    }
    if (target.arm === "recipe-revisions") {
      const { owner } = await conanGate(c, "read");
      const revisions = await listConanRecipeRevisionsJson(c.env.DB, owner.id, target.recipe);
      if (revisions === null) return conanErrorResponseRaw(404, "");
      return conanJsonResponse(200, revisions);
    }
    if (target.arm === "package-latest") {
      const { owner } = await conanGate(c, "read");
      const pref = target.pref;
      if (pref === null) return conanErrorResponseRaw(404, "");
      const latest = await getConanLatestPackageRevision(c.env.DB, owner.id, pref);
      if (latest === null) return conanErrorResponseRaw(404, "");
      return conanJsonResponse(200, { revision: latest.revision, time: latest.time });
    }
    if (target.arm === "package-revisions") {
      const { owner } = await conanGate(c, "read");
      const pref = target.pref;
      if (pref === null) return conanErrorResponseRaw(404, "");
      const revisions = await listConanPackageRevisionsJson(c.env.DB, owner.id, pref);
      if (revisions === null) return conanErrorResponseRaw(404, "");
      return conanJsonResponse(200, revisions);
    }
    if (target.arm === "package-search") {
      const { owner } = await conanGate(c, "read");
      const result = await searchConanPackages(c.env.DB, owner.id, target.recipe, target.version === "v1");
      if (result === null) return conanErrorResponseRaw(404, "");
      return conanJsonResponse(200, result);
    }
    if (target.arm === "delete-recipe") {
      const { owner } = await conanGate(c, "write");
      const outcome =
        target.version === "v1"
          ? await deleteConanRecipeV1(c.env.DB, owner.id, target.recipe)
          : await deleteConanRecipeV2(c.env.DB, owner.id, target.recipe);
      if (outcome.kind === "not-found") return conanErrorResponseRaw(404, "");
      if (outcome.kind === "reference-not-exist") return conanErrorResponseRaw(404, "");
      return new Response(null, { status: 200 });
    }
    if (target.arm === "delete-packages-v1") {
      const { owner } = await conanGate(c, "write");
      let body: { package_ids?: string[] } = {};
      try {
        const parsed = (await c.req.json()) as unknown;
        if (parsed !== null && typeof parsed === "object") {
          body = parsed;
        }
      } catch {
        return conanErrorResponseRaw(500, "internal server error");
      }
      const outcome = await deleteConanPackageV1(c.env.DB, owner.id, target.recipe, body.package_ids ?? []);
      if (outcome.kind !== "deleted") return conanErrorResponseRaw(404, "");
      return new Response(null, { status: 200 });
    }
    if (target.arm === "delete-package") {
      const { owner } = await conanGate(c, "write");
      const outcome = await deleteConanPackageV2(c.env.DB, owner.id, target.recipe, target.pref);
      if (outcome.kind === "not-found") return conanErrorResponseRaw(404, "");
      if (outcome.kind === "reference-not-exist") return conanErrorResponseRaw(404, "");
      return new Response(null, { status: 200 });
    }
    return conanErrorResponseRaw(404, "");
  } catch (error) {
    if (error instanceof HTTPException) return error.getResponse();
    console.error("[packages-conan] request failed", error);
    return conanErrorResponseRaw(500, "internal server error");
  }
}


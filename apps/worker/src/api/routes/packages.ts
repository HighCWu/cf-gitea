import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { repositories, userRedirects, users } from "../../db/schema";
import type { AuthUser } from "../../auth/auth-context";
import { basicAuthTokenCandidate, parseAuthorizationHeader } from "../../auth/httpauth";
import { userRedirectDoesNotExist } from "../../auth/middleware";
import { ScopeSet } from "../../auth/scopes";
import { TokenService } from "../../auth/token-service";
import { toApiUser as authToApiUser } from "../auth";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { repositorySchema } from "../models/repository";
import { userSchema } from "../models/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import {
  canViewRepositoryWithTeams,
  findUserByName,
  repositoryPermissionsWithTeams,
  toApiRepository,
  viewerOf,
  type RepositoryWithOwner,
  type UserRow,
  type Viewer,
} from "../services/repository";
import { toApiUser } from "../services/user";
import {
  type PackageAccessMode,
  type PackageDescriptor,
  QuotaTotalCountError,
  QuotaTotalSizeError,
  QuotaTypeSizeError,
  accessModeAtLeast,
  deletePackageAndReferences,
  deletePackageVersionAndReferences,
  determinePackageAccessMode,
  getPackageByName,
  getPackageDescriptor,
  getFileDescriptors,
  getVersionByNameAndVersion,
  linkPackageToRepo,
  packagesQuotaFromEnv,
  searchLatestVersions,
  searchVersions,
  unlinkPackageFromRepo,
} from "../../services/packages/model";
import {
  DuplicatePackageFileError,
  deleteGenericFile,
  deleteGenericVersion,
  isValidFileName,
  isValidPackageName,
  isValidPackageVersion,
  openGenericFileForDownload,
  uploadGenericFile,
} from "../../services/packages/generic";
import { PackageSizeMismatchError } from "../../services/packages/blobs";
import { servePackageFileResponse } from "../../services/packages/serve-content";

/**
 * The package registry API surface (SPEC-0016 §3) — two mounted families in
 * one module:
 *
 *  A. The NINE management ops + the admin list on `/api/v1` (§3.1) — upstream
 *     routers/api/v1/api.go:1695-1714 (the group's own note: "these are Gitea
 *     package management API — see packages.CommonRoutes … for endpoints that
 *     implement package manager APIs") + api.go:1820 (`GET /admin/packages`).
 *     Wire shapes are upstream's modules/structs/package.go (`Package` keyed
 *     by the VERSION id, `PackageFile` carrying the four hashes) through the
 *     landed user/repo serializers.
 *  B. The GENERIC registry protocol (§3.2) — upstream api.go:318-335 +
 *     routers/api/packages/generic/generic.go, mounted at `/api/packages`
 *     (NOT /api/v1 — upstream's own mount note). This family is NOT in the
 *     frozen OpenAPI document (upstream's package-manager endpoints live
 *     outside the v1 swagger too), so it registers as a plain Hono router
 *     (the imports.ts plain-Hono precedent).
 *
 * Auth — upstream's gate stack for the v1 group is
 * `reqToken() + tokenRequiresScopes(package) + context.UserAssignmentAPI() +
 * context.PackageAssignmentAPI() + reqPackageAccess(read)`, the write ops
 * adding `reqPackageAccess(write)`; the protocol family carries ONLY
 * `reqPackageAccess(read|write)` (anonymous downloads of public owners pass;
 * an insufficient arm answers 401 + `WWW-Authenticate: Basic realm="Gitea
 * Package API"` so real package-manager clients re-prompt — §5.10). The
 * ApiEnv seam carries the verified identity but not the token scope (its
 * `auth` variable is the identity slice only), so this module resolves the
 * presented credential ITSELF — the LFS router's seam
 * (src/lfs/router.ts:275-368): parse → TokenService.verify → ScopeSet — one
 * pass per request, covering reqToken (401 "token is required"),
 * tokenRequiresScopes (403, the exact upstream message) and reqPackageAccess
 * (401 + the challenge header) in upstream's order. The nine routes therefore
 * register WITHOUT the requireAuth middleware (its only job — the anonymous
 * 401 — is this gate's first arm); requireAuth stays the admin list's
 * identity middleware (the admin-t2 idiom: no PAT scope enforcement on the
 * admin family — upstream's admin group carries
 * tokenRequiresScopes(admin), a documented cf-gitea admin-family deviation).
 *
 * The admin list renders ALL owners' versions (upstream admin/packages.go
 * ListPackages over SearchVersions) behind reqSiteAdmin.
 */

const WWW_AUTHENTICATE = 'Basic realm="Gitea Package API"';

// ---------------------------------------------------------------------------
// Credential resolution (the LFS seam) + the upstream gate arms
// ---------------------------------------------------------------------------

interface ResolvedCredential {
  doer: AuthUser | null;
  scope: ScopeSet | null;
}

/** Parse + verify the presented credential; anything absent/invalid is anonymous
 *  (the packages contexter's silent auth failure — the 401 challenge below is
 *  what makes clients re-prompt). */
async function resolveCredential(d1: D1Database, request: Request): Promise<ResolvedCredential> {
  const header = request.headers.get("Authorization");
  const parsed = header === null ? null : parseAuthorizationHeader(header);
  const credential =
    parsed?.bearerToken?.token ?? (parsed?.basicAuth ? basicAuthTokenCandidate(parsed.basicAuth) : null);
  if (parsed === null || credential === null) {
    return { doer: null, scope: null };
  }
  const verified = await new TokenService(d1).verify(credential, { now: new Date() });
  if (verified === null) {
    return { doer: null, scope: null };
  }
  return { doer: verified.user, scope: ScopeSet.parseLenient(verified.token.scopes) };
}

function isWriteMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

/** tokenRequiresScopes' 403 body (the upstream message with Go's %v slice form). */
function scopeForbidden(required: string, tokenScope: string): ApiError {
  return new ApiError(
    403,
    `token does not have at least one of required scope(s), required=[${required}], token scope=${tokenScope}`,
  );
}

/** reqPackageAccess' 401 — the challenge header is the arm's whole point (§5.10). */
function packageAccessChallenge(): never {
  throw new HTTPException(401, {
    res: plainResponse(401, "user should have specific permission or be a site admin", {
      "WWW-Authenticate": WWW_AUTHENTICATE,
    }),
  });
}

/** A plain-text response (the protocol family's error shape — upstream
 *  apiError → ctx.PlainText). */
function plainResponse(status: ContentfulStatus, message: string, extraHeaders?: Record<string, string>): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain;charset=utf-8", ...(extraHeaders ?? {}) },
  });
}

type ContentfulStatus = 400 | 401 | 403 | 404 | 409 | 411 | 413 | 500;

/** The strict-polarity `PACKAGES_ENABLED` arm: only the exact string "false"
 *  disables (the DEMO_MODE discipline); a disabled instance 404s the family
 *  (upstream never registers the routes at all). */
function packagesDisabled(env: Env): boolean {
  return !packagesQuotaFromEnv(env).packagesEnabled;
}

/**
 * UserAssignmentAPI (services/context/user.go) on our substrate: resolve the
 * `:owner` param through the user_redirect shadow (findUserByName misses fall
 * to user_redirects), masking unknown AND public-only-blind targets with the
 * anti-enumeration 404. Returns the users row.
 */
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

/** The public-only blind arm (upstream DoerTokenAllowsOwner inside the
 *  assignment): self/admin always see the owner; a public-only token
 *  resolving a non-public owner is masked out. */
function ownerBlindToPublicOnly(owner: UserRow, cred: ResolvedCredential): boolean {
  return (
    cred.doer !== null &&
    cred.scope?.publicOnly === true &&
    cred.doer.id !== owner.id &&
    !cred.doer.isAdmin &&
    owner.visibility !== "public"
  );
}

/** The visibility input of determinePackageAccessMode (the two families
 *  share it): only an ANONYMOUS caller is blind on a non-public owner — every
 *  authenticated doer reaches the ladder, whose membership checks keep a
 *  private org's own members granted and whose visibility arm blinds
 *  strangers. The public-only masking is the separate ownerBlindToPublicOnly
 *  404 arm upstream runs BEFORE the assignment. */
function ownerVisibleToDoer(owner: UserRow, cred: ResolvedCredential): boolean {
  return cred.doer === null ? owner.visibility === "public" : true;
}

export interface PackageContext {
  cred: ResolvedCredential;
  owner: UserRow;
  mode: PackageAccessMode;
}

/** The viewer for the serializers: the package family's identity comes from
 *  the credential pass (the nine ops carry no requireAuth, so
 *  `c.var.authUser` is unset); the admin list's requireAuth identity wins
 *  when present. */
function packageViewer(c: Context<ApiEnv>, cred: ResolvedCredential): Viewer {
  const fromCredential = cred.doer === null ? null : authToApiUser(cred.doer);
  return { origin: new URL(c.req.url).origin, requester: fromCredential ?? c.get("authUser") ?? null };
}

/**
 * The full upstream gate stack in upstream's order (api.go:1700-1714):
 *   1. PACKAGES_ENABLED=false → 404;
 *   2. reqToken (v1 only) — anonymous → 401 "token is required";
 *   3. tokenRequiresScopes (v1 only) — a token without the method-derived
 *      `read:package`/`write:package` → 403 (the exact upstream message);
 *   4. UserAssignmentAPI → the owner row (masked 404s);
 *   5. reqPackageAccess(required) — a token whose scope misses the
 *      required-mode-derived level → 401 + challenge; then the access-mode
 *      compare (determinePackageAccessMode's §4.1 fold) → 401 + challenge.
 */
async function requirePackageContext(
  c: Context<ApiEnv>,
  required: "read" | "write",
  options: { requireToken?: boolean; groupScopeGate?: boolean } = {},
): Promise<PackageContext> {
  if (packagesDisabled(c.env)) {
    throw new ApiError(404, "not found");
  }
  const cred = await resolveCredential(c.env.DB, c.req.raw);
  if ((options.requireToken ?? false) && cred.doer === null) {
    throw new ApiError(401, "token is required");
  }
  if ((options.groupScopeGate ?? false) && cred.scope !== null) {
    const methodLevel = isWriteMethod(c.req.method) ? "write" : "read";
    if (!cred.scope.has(`${methodLevel}:package`)) {
      throw scopeForbidden(`${methodLevel}:package`, cred.scope.toString());
    }
  }
  const owner = await resolveOwnerRow(c.env.DB, c.req.param("owner") ?? "");
  if (owner === null) {
    throw new ApiError(404, userRedirectDoesNotExist(c.req.param("owner") ?? ""));
  }
  if (ownerBlindToPublicOnly(owner, cred)) {
    throw new ApiError(404, userRedirectDoesNotExist(owner.username));
  }
  const mode = await determinePackageAccessMode(c.env.DB, owner, cred.doer, {
    ownerVisibleToDoer: ownerVisibleToDoer(owner, cred),
  });
  // reqPackageAccess — the token-scope half (skipped without a token,
  // upstream GetDoerTokenScope's ok-check), then the access-mode half.
  if (cred.scope !== null && !cred.scope.has(`${required}:package`)) {
    packageAccessChallenge();
  }
  if (!accessModeAtLeast(mode, required)) {
    packageAccessChallenge();
  }
  return { cred, owner, mode };
}

// ---------------------------------------------------------------------------
// Wire conversion — convert.ToPackage / ToPackageFile (convert/package.go)
// ---------------------------------------------------------------------------

/** `PackageFile` (structs/package.go:34-49) — the four hashes + size + name.
 *  cf-gitea digests every upload with the three WebCrypto-supported sums, so
 *  `md5` renders "" (the schema's hash_md5 stays NULL — see the table note). */
export const packageFileSchema = z.object({
  id: z.number().int(),
  size: z.number().int(),
  name: z.string(),
  md5: z.string(),
  sha1: z.string(),
  sha256: z.string(),
  sha512: z.string(),
});

/** `Package` (structs/package.go:11-31) — keyed by the VERSION id. */
export const packageSchema = z.object({
  id: z.number().int(),
  owner: userSchema,
  repository: repositorySchema.nullable(),
  creator: userSchema.nullable(),
  type: z.string(),
  name: z.string(),
  version: z.string(),
  html_url: z.string(),
  created_at: z.string(),
});

export type ApiPackage = z.infer<typeof packageSchema>;

/** `convert.ToPackage` — one descriptor row to the wire. The linked repo
 *  renders only when the doer can view it (upstream's HasAnyUnitAccess gate);
 *  creator 0/missing renders null (upstream loads the row; our creator_id
 *  defaults 0 for unattributed versions — a documented null-vs-error
 *  divergence). */
export async function toApiPackage(
  d1: D1Database,
  viewer: Viewer,
  descriptor: PackageDescriptor,
  owner: UserRow,
): Promise<ApiPackage> {
  const pkg = descriptor.pkg;
  const version = descriptor.version;
  const creatorRow =
    version.creatorId === 0
      ? null
      : ((await drizzle(d1).select().from(users).where(eq(users.id, version.creatorId)).get()) ?? null);
  let linked: RepositoryWithOwner | null = null;
  if (pkg.repoId !== null) {
    const repoRow = (await drizzle(d1).select().from(repositories).where(eq(repositories.id, pkg.repoId)).get()) ?? null;
    if (repoRow !== null && (await canViewRepositoryWithTeams(d1, viewer, repoRow))) {
      const repoOwner = await findUserByName(d1, repoRow.ownerNamespace);
      if (repoOwner !== null) {
        linked = { repo: repoRow, owner: repoOwner };
      }
    }
  }
  const htmlUrl = `${viewer.origin}/${encodeURIComponent(owner.username)}/-/packages/${encodeURIComponent(pkg.type)}/${encodeURIComponent(pkg.lowerName)}/${encodeURIComponent(version.lowerVersion)}`;
  return {
    id: version.id,
    owner: toApiUser(viewer, owner),
    repository: linked === null ? null : toApiRepository(viewer, linked),
    creator: creatorRow === null ? null : toApiUser(viewer, creatorRow),
    type: pkg.type,
    name: pkg.name,
    version: version.version,
    html_url: htmlUrl,
    created_at: version.createdUnix.toISOString(),
  };
}

/** `convert.ToPackageFile`. */
function toApiPackageFile(descriptor: { file: { id: number; name: string }; blob: { size: number; hashMd5: string | null; hashSha1: string | null; hashSha256: string; hashSha512: string | null } }) {
  return {
    id: descriptor.file.id,
    size: descriptor.blob.size,
    name: descriptor.file.name,
    md5: descriptor.blob.hashMd5 ?? "",
    sha1: descriptor.blob.hashSha1 ?? "",
    sha256: descriptor.blob.hashSha256,
    sha512: descriptor.blob.hashSha512 ?? "",
  };
}

// ---------------------------------------------------------------------------
// Shared request plumbing
// ---------------------------------------------------------------------------

/** A shared descriptor loader: version → package row + descriptor (404 masked). */
async function requireDescriptor(
  c: Context<ApiEnv>,
  owner: UserRow,
  type: string,
  name: string,
  version: string,
): Promise<PackageDescriptor> {
  const versionRow = await getVersionByNameAndVersion(c.env.DB, owner.id, type, name, version);
  if (versionRow === null) {
    throw new ApiError(404, "not found");
  }
  const pkgRow = await getPackageByName(c.env.DB, owner.id, type, name);
  if (pkgRow === null) {
    throw new ApiError(404, "not found");
  }
  return getPackageDescriptor(c.env.DB, pkgRow, versionRow);
}

/** The linked-repo row for linkPackage (GetRepositoryByName — owner-scoped
 *  slug, case-insensitive). */
async function findOwnerRepository(d1: D1Database, ownerId: number, repoName: string) {
  const rows = await drizzle(d1)
    .select()
    .from(repositories)
    .where(eq(repositories.ownerId, ownerId))
    .all();
  return rows.find((row) => row.slug.toLowerCase() === repoName.toLowerCase()) ?? null;
}

/**
 * Upstream canDoerManagePackage (package_update.go:46-68) reduced to the
 * landed model: admin/self always manage; the org fold's admin/owner modes
 * (owner-role bridge, admin/owner teams) manage; an admin-armed grant on the
 * LINKED repo manages (upstream's old-behavior repo-admin arm).
 */
async function canDoerManagePackage(
  d1: D1Database,
  owner: UserRow,
  pkgOwnerId: number,
  pkgRepoId: string | null,
  doer: AuthUser,
  viewer: Viewer,
): Promise<boolean> {
  if (doer.isAdmin || doer.id === pkgOwnerId) return true;
  const mode = await determinePackageAccessMode(d1, owner, doer, { ownerVisibleToDoer: true });
  if (accessModeAtLeast(mode, "admin")) return true;
  if (pkgRepoId !== null) {
    const repoRow = (await drizzle(d1).select().from(repositories).where(eq(repositories.id, pkgRepoId)).get()) ?? null;
    if (repoRow !== null) {
      const permissions = await repositoryPermissionsWithTeams(d1, viewer, repoRow);
      if (permissions.admin) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// A — the nine management ops + admin list (§3.1)
// ---------------------------------------------------------------------------

const ownerParam = z.object({
  owner: z.string().min(1).openapi({ description: "owner of the packages" }),
});
const typeParam = z.object({
  owner: z.string().min(1).openapi({ description: "owner of the packages" }),
  type: z.string().min(1).openapi({ description: "type of the package" }),
  name: z.string().min(1).openapi({ description: "name of the package" }),
});
const versionParam = z.object({
  owner: z.string().min(1).openapi({ description: "owner of the packages" }),
  type: z.string().min(1).openapi({ description: "type of the package" }),
  name: z.string().min(1).openapi({ description: "name of the package" }),
  version: z.string().min(1).openapi({ description: "version of the package" }),
});

const listQuery = z.object({
  page: z.string().optional().openapi({ description: "page number of results to return (1-based)" }),
  limit: z.string().optional().openapi({ description: "page size of results" }),
  type: z.string().optional().openapi({ description: "package type filter" }),
  q: z.string().optional().openapi({ description: "name filter" }),
});

const versionsQuery = z.object({
  page: z.string().optional().openapi({ description: "page number of results to return (1-based)" }),
  limit: z.string().optional().openapi({ description: "page size of results" }),
});

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;
const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;
const packageListResponse = {
  description: "PackageList",
  content: { "application/json": { schema: z.array(packageSchema) } },
} as const;

/** The local reqSiteAdmin twin (the admin-t2 idiom). */
function requireSiteAdmin(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const doer = c.get("authUser");
    if (doer === undefined || !doer.is_admin) {
      throw new ApiError(403, "user should be the site admin");
    }
    return next();
  };
}

export function registerPackagesRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // listPackages — GET /packages/{owner} (api.go:1700 group head; upstream
  // ListPackages renders EVERY matching version — SearchVersions,
  // v1/packages/package.go:471 — not the UI's latest-per-package shape).
  app.openapi(
    createRoute({
      method: "get",
      path: "/packages/{owner}",
      tags: ["package"],
      summary: "Gets all packages of an owner",
      operationId: "listPackages",
      request: { params: ownerParam, query: listQuery },
      responses: { 200: packageListResponse, 404: notFoundResponse },
    }),
    async (c) => {
      const { owner, cred } = await requirePackageContext(c, "read", { requireToken: true, groupScopeGate: true });
      const query = c.req.valid("query");
      const opts = parseListOptions(new URL(c.req.url));
      const { rows, count } = await searchVersions(c.env.DB, {
        ownerId: owner.id,
        type: query.type ?? "",
        name: query.q ?? "",
        excludeInternal: true,
        page: opts.page,
        limit: opts.limit,
      });
      const viewer = packageViewer(c, cred);
      const bodies: ApiPackage[] = [];
      for (const row of rows) {
        const descriptor = await getPackageDescriptor(c.env.DB, row.pkg, row.version);
        bodies.push(await toApiPackage(c.env.DB, viewer, descriptor, owner));
      }
      setPaginationHeaders(c, count, opts);
      return c.json(bodies, 200);
    },
  );

  // listPackageVersions — GET /packages/{owner}/{type}/{name} (upstream
  // registers `m.Get("/")` inside the {type}/{name} group; the trailing
  // slash is the UI's canonical-form rule's casualty — cf-gitea routes never
  // declare slashed paths).
  app.openapi(
    createRoute({
      method: "get",
      path: "/packages/{owner}/{type}/{name}",
      tags: ["package"],
      summary: "Gets all versions of a package",
      operationId: "listPackageVersions",
      request: { params: typeParam, query: versionsQuery },
      responses: { 200: packageListResponse, 404: notFoundResponse },
    }),
    async (c) => {
      const { owner, cred } = await requirePackageContext(c, "read", { requireToken: true, groupScopeGate: true });
      const params = c.req.valid("param");
      const opts = parseListOptions(new URL(c.req.url));
      const { rows, count } = await searchVersions(c.env.DB, {
        ownerId: owner.id,
        type: params.type,
        name: params.name,
        exact: true,
        excludeInternal: true,
        page: opts.page,
        limit: opts.limit,
      });
      const viewer = packageViewer(c, cred);
      const bodies: ApiPackage[] = [];
      for (const row of rows) {
        const descriptor = await getPackageDescriptor(c.env.DB, row.pkg, row.version);
        bodies.push(await toApiPackage(c.env.DB, viewer, descriptor, owner));
      }
      setPaginationHeaders(c, count, opts);
      return c.json(bodies, 200);
    },
  );

  // deletePackage — DELETE /packages/{owner}/{type}/{name} (write scope).
  app.openapi(
    createRoute({
      method: "delete",
      path: "/packages/{owner}/{type}/{name}",
      tags: ["package"],
      summary: "Delete a package",
      operationId: "deletePackage",
      request: { params: typeParam },
      responses: { 204: { description: "empty" }, 404: notFoundResponse },
    }),
    async (c) => {
      const { owner } = await requirePackageContext(c, "write", { requireToken: true, groupScopeGate: true });
      const params = c.req.valid("param");
      const pkg = await getPackageByName(c.env.DB, owner.id, params.type, params.name);
      if (pkg === null) {
        throw new ApiError(404, "not found");
      }
      await deletePackageAndReferences(c.env.DB, pkg.id);
      return c.body(null, 204);
    },
  );

  // getPackage — GET /packages/{owner}/{type}/{name}/{version}.
  app.openapi(
    createRoute({
      method: "get",
      path: "/packages/{owner}/{type}/{name}/{version}",
      tags: ["package"],
      summary: "Gets a package",
      operationId: "getPackage",
      request: { params: versionParam },
      responses: {
        200: { description: "Package", content: { "application/json": { schema: packageSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, cred } = await requirePackageContext(c, "read", { requireToken: true, groupScopeGate: true });
      const params = c.req.valid("param");
      const descriptor = await requireDescriptor(c, owner, params.type, params.name, params.version);
      return c.json(await toApiPackage(c.env.DB, packageViewer(c, cred), descriptor, owner), 200);
    },
  );

  // deletePackageVersion — DELETE …/{version} (write scope).
  app.openapi(
    createRoute({
      method: "delete",
      path: "/packages/{owner}/{type}/{name}/{version}",
      tags: ["package"],
      summary: "Delete a package version",
      operationId: "deletePackageVersion",
      request: { params: versionParam },
      responses: { 204: { description: "empty" }, 404: notFoundResponse },
    }),
    async (c) => {
      const { owner } = await requirePackageContext(c, "write", { requireToken: true, groupScopeGate: true });
      const params = c.req.valid("param");
      const versionRow = await getVersionByNameAndVersion(c.env.DB, owner.id, params.type, params.name, params.version);
      if (versionRow === null) {
        throw new ApiError(404, "not found");
      }
      await deletePackageVersionAndReferences(c.env.DB, versionRow.id);
      return c.body(null, 204);
    },
  );

  // listPackageFiles — GET …/{version}/files.
  app.openapi(
    createRoute({
      method: "get",
      path: "/packages/{owner}/{type}/{name}/{version}/files",
      tags: ["package"],
      summary: "Gets all files of a package",
      operationId: "listPackageFiles",
      request: { params: versionParam },
      responses: {
        200: {
          description: "PackageFileList",
          content: { "application/json": { schema: z.array(packageFileSchema) } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner } = await requirePackageContext(c, "read", { requireToken: true, groupScopeGate: true });
      const params = c.req.valid("param");
      const descriptor = await requireDescriptor(c, owner, params.type, params.name, params.version);
      const files = await getFileDescriptors(c.env.DB, descriptor.version.id);
      return c.json(files.map((entry) => toApiPackageFile(entry)), 200);
    },
  );

  // getLatestPackageVersion — GET …/-/latest (the one SearchLatestVersions
  // consumer in the family — v1/packages/package.go:321; the literal `-/`
  // segment wins over the {version} param by static-over-param precedence,
  // upstream chi's own rule).
  app.openapi(
    createRoute({
      method: "get",
      path: "/packages/{owner}/{type}/{name}/-/latest",
      tags: ["package"],
      summary: "Gets the latest version of a package",
      operationId: "getLatestPackageVersion",
      request: { params: typeParam },
      responses: {
        200: { description: "Package", content: { "application/json": { schema: packageSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, cred: ctxCred } = await requirePackageContext(c, "read", { requireToken: true, groupScopeGate: true });
      const params = c.req.valid("param");
      const { rows } = await searchLatestVersions(c.env.DB, {
        ownerId: owner.id,
        type: params.type,
        name: params.name,
        exact: true,
        excludeInternal: true,
        limit: 1,
        page: 1,
      });
      const latest = rows[0];
      if (latest === undefined) {
        throw new ApiError(404, "not found");
      }
      const descriptor = await getPackageDescriptor(c.env.DB, latest.pkg, latest.version);
      return c.json(await toApiPackage(c.env.DB, packageViewer(c, ctxCred), descriptor, owner), 200);
    },
  );

  // linkPackage — POST …/-/link/{repo_name} (write scope; 201 empty).
  app.openapi(
    createRoute({
      method: "post",
      path: "/packages/{owner}/{type}/{name}/-/link/{repo_name}",
      tags: ["package"],
      summary: "Link a package to a repository",
      operationId: "linkPackage",
      request: {
        params: typeParam.extend({
          repo_name: z.string().min(1).openapi({ description: "name of the repository to link." }),
        }),
      },
      responses: { 201: { description: "empty" }, 404: notFoundResponse },
    }),
    async (c) => {
      const { owner, cred } = await requirePackageContext(c, "write", { requireToken: true, groupScopeGate: true });
      const params = c.req.valid("param");
      const pkg = await getPackageByName(c.env.DB, owner.id, params.type, params.name);
      if (pkg === null) {
        throw new ApiError(404, "package does not exist");
      }
      const repo = await findOwnerRepository(c.env.DB, owner.id, params.repo_name);
      if (repo === null) {
        throw new ApiError(404, "repository does not exist");
      }
      // LinkToRepository (package_update.go:20-43): cross-owner → 403
      // (unreachable here — both sides resolve the SAME owner), already
      // linked → 400, no packages write grant on the repo → 403.
      if (pkg.repoId !== null) {
        throw new ApiError(400, "package has already been linked to a repository");
      }
      const doer = cred.doer;
      if (doer === null || !doer.isAdmin) {
        const permissions = await repositoryPermissionsWithTeams(c.env.DB, packageViewer(c, cred), repo);
        if (!permissions.push) {
          throw new ApiError(403, "user does not have granted access to the repository");
        }
      }
      await linkPackageToRepo(c.env.DB, pkg.id, repo.id);
      return c.body(null, 201);
    },
  );

  // unlinkPackage — POST …/-/unlink (write scope; upstream answers 204).
  app.openapi(
    createRoute({
      method: "post",
      path: "/packages/{owner}/{type}/{name}/-/unlink",
      tags: ["package"],
      summary: "Unlink a package from a repository",
      operationId: "unlinkPackage",
      request: { params: typeParam },
      responses: { 204: { description: "empty" }, 404: notFoundResponse },
    }),
    async (c) => {
      const { owner, cred } = await requirePackageContext(c, "write", { requireToken: true, groupScopeGate: true });
      const params = c.req.valid("param");
      const pkg = await getPackageByName(c.env.DB, owner.id, params.type, params.name);
      if (pkg === null) {
        throw new ApiError(404, "package does not exist");
      }
      if (pkg.repoId === null) {
        throw new ApiError(400, "package has not been linked to a repository");
      }
      const doer = cred.doer;
      if (
        doer === null ||
        !(await canDoerManagePackage(c.env.DB, owner, pkg.ownerId, pkg.repoId, doer, packageViewer(c, cred)))
      ) {
        throw new ApiError(403, "user does not have granted access to the package");
      }
      await unlinkPackageFromRepo(c.env.DB, pkg.id);
      return c.body(null, 204);
    },
  );

  // adminListPackages — GET /admin/packages (api.go:1820; reqSiteAdmin, the
  // admin-t2 PAT-scope deviation documented in the module header).
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/packages",
      middleware: [requireAuth, requireSiteAdmin()],
      tags: ["admin"],
      summary: "List all packages",
      operationId: "adminListPackages",
      request: { query: listQuery },
      responses: { 200: packageListResponse, 403: forbiddenResponse },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const opts = parseListOptions(new URL(c.req.url));
      const { rows, count } = await searchVersions(c.env.DB, {
        type: query.type ?? "",
        name: query.q ?? "",
        excludeInternal: true,
        page: opts.page,
        limit: opts.limit,
      });
      const viewer = viewerOf(c);
      const bodies: ApiPackage[] = [];
      for (const row of rows) {
        const ownerRow = (await drizzle(c.env.DB).select().from(users).where(eq(users.id, row.pkg.ownerId)).get()) ?? null;
        if (ownerRow === null) continue; // an owner row deleted mid-render: skip (upstream's join would error the page)
        const descriptor = await getPackageDescriptor(c.env.DB, row.pkg, row.version);
        bodies.push(await toApiPackage(c.env.DB, viewer, descriptor, ownerRow));
      }
      setPaginationHeaders(c, count, opts);
      return c.json(bodies, 200);
    },
  );
}

// ---------------------------------------------------------------------------
// B — the generic registry protocol (§3.2, /api/packages — plain Hono,
// upstream apiError answers PLAIN TEXT bodies)
// ---------------------------------------------------------------------------

/** reqPackageAccess for the protocol family: the token-scope half (skipped
 *  without a token), then the access-mode half; both answer the 401
 *  challenge. */
async function protocolAccessGate(
  d1: D1Database,
  required: "read" | "write",
  owner: UserRow,
  cred: ResolvedCredential,
): Promise<void> {
  if (cred.scope !== null && !cred.scope.has(`${required}:package`)) {
    packageAccessChallenge();
  }
  const mode = await determinePackageAccessMode(d1, owner, cred.doer, {
    ownerVisibleToDoer: ownerVisibleToDoer(owner, cred),
  });
  if (!accessModeAtLeast(mode, required)) {
    packageAccessChallenge();
  }
}

/** The protocol family's shared prologue: disabled arm → plain-text 404, the
 *  owner assignment (masked 404s), then the access gate. */
async function protocolContext(
  c: Context<{ Bindings: Env }>,
  required: "read" | "write",
): Promise<{ owner: UserRow; cred: ResolvedCredential }> {
  if (packagesDisabled(c.env)) {
    throw new HTTPException(404, { res: plainResponse(404, "not found") });
  }
  const cred = await resolveCredential(c.env.DB, c.req.raw);
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

/** Map the typed service/store failures onto the protocol's status family. */
function protocolErrorStatus(error: unknown): Response | undefined {
  if (error instanceof PackageSizeMismatchError) {
    return plainResponse(400, error.message);
  }
  if (error instanceof DuplicatePackageFileError) {
    return plainResponse(409, "package file already exists");
  }
  if (error instanceof QuotaTotalCountError || error instanceof QuotaTypeSizeError || error instanceof QuotaTotalSizeError) {
    return plainResponse(403, error.message);
  }
  return undefined;
}

/**
 * The `/api/packages` sub-app (mounted by src/index.ts; resolveAuth is NOT
 * mounted here — the family carries its own credential pass, upstream's
 * CommonRoutes auth posture). The R04/R16 web pages are DOWNSTREAM (§1).
 */
export function createPackagesProtocolRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  const serveDownload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "read");
      const params = c.req.param();
      const download = await openGenericFileForDownload(
        c.env.DB,
        c.env.REPO_PACKS,
        owner,
        params.packagename ?? "",
        params.packageversion ?? "",
        params.filename ?? "",
        c.req.method === "HEAD" ? "HEAD" : "GET",
      );
      if (download === null) {
        return plainResponse(404, "package file does not exist");
      }
      // helper.ServePackageFile → ctx.ServeContent (review D-6): the full
      // ServeSetHeaders set with the RFC 5987 `filename*` disposition twin,
      // plus the 304/412/416/206 byte-serving arms (serve-content.ts). HEAD
      // suppresses the body while the byte-serving status stands.
      return servePackageFileResponse(
        c.req.raw,
        c.req.method === "HEAD" ? null : download.stream,
        {
          filename: download.descriptor.file.name,
          size: download.size,
          created: download.descriptor.file.createdUnix,
        },
      );
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      return plainResponse(500, "internal server error");
    }
  };

  const upload = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner, cred } = await protocolContext(c, "write");
      const doer = cred.doer;
      if (doer === null) {
        // reqPackageAccess(write) 401'd for anonymous already (mode none <
        // write); this arm only carries the type through.
        return plainResponse(401, "user should have specific permission or be a site admin", {
          "WWW-Authenticate": WWW_AUTHENTICATE,
        });
      }
      const params = c.req.param();
      const packageName = params.packagename ?? "";
      const filename = params.filename ?? "";
      const packageVersion = params.packageversion ?? "";
      // Upstream's validation order (generic.go:69-86): name, filename, version.
      if (!isValidPackageName(packageName)) {
        return plainResponse(400, "invalid package name");
      }
      if (!isValidFileName(filename)) {
        return plainResponse(400, "invalid filename");
      }
      if (!isValidPackageVersion(packageVersion)) {
        return plainResponse(400, "invalid package version");
      }
      const body = c.req.raw.body as ReadableStream<Uint8Array> | null;
      await uploadGenericFile({
        d1: c.env.DB,
        bucket: c.env.REPO_PACKS,
        owner,
        doer,
        packageName,
        packageVersion,
        filename,
        content: body ?? emptyStream(),
        // A missing Content-Length streams: the store spools chunked bodies
        // through the bounded R2 multipart upload (the parity review's D-2 —
        // upstream Go reads the stream regardless).
        declaredLength: contentLength(c.req.raw) ?? undefined,
        quota: packagesQuotaFromEnv(c.env),
      });
      return new Response(null, { status: 201 });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      const mapped = protocolErrorStatus(error);
      if (mapped !== undefined) return mapped;
      console.error("[packages-protocol] upload failed", error);
      return plainResponse(500, "internal server error");
    }
  };

  const deleteVersion = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "write");
      const params = c.req.param();
      const deleted = await deleteGenericVersion(
        c.env.DB,
        owner,
        params.packagename ?? "",
        params.packageversion ?? "",
      );
      if (!deleted) {
        return plainResponse(404, "package does not exist");
      }
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      return plainResponse(500, "internal server error");
    }
  };

  const deleteFile = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      const { owner } = await protocolContext(c, "write");
      const params = c.req.param();
      const deleted = await deleteGenericFile(
        c.env.DB,
        owner,
        params.packagename ?? "",
        params.packageversion ?? "",
        params.filename ?? "",
      );
      if (deleted === null) {
        return plainResponse(404, "package file does not exist");
      }
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      return plainResponse(500, "internal server error");
    }
  };

  // The upstream route table (api.go:318-335): the {username} assignment
  // segment leads every path (the sub-app is mounted at /api/packages —
  // upstream's CommonRoutes sit at /api/packages/{username}/generic/…),
  // DELETE per-version, then the {filename} group with HEAD/GET, PUT, DELETE
  // arms.
  app.delete("/:username/generic/:packagename/:packageversion", (c) => deleteVersion(c));
  app.get("/:username/generic/:packagename/:packageversion/:filename", (c) => serveDownload(c));
  app.on("HEAD", "/:username/generic/:packagename/:packageversion/:filename", (c) => serveDownload(c));
  app.put("/:username/generic/:packagename/:packageversion/:filename", (c) => upload(c));
  app.delete("/:username/generic/:packagename/:packageversion/:filename", (c) => deleteFile(c));

  return app;
}

/** The declared Content-Length (null when absent or not a valid integer). */
function contentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** A closed zero-byte stream (a Content-Length: 0 PUT stores an empty blob). */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

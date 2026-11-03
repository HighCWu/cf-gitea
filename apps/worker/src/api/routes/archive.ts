/**
 * GET /repos/{owner}/{repo}/archive/{archive} (repoGetArchive — SPEC-0004
 * §2.4 row): a streamed server-side archive of one ref, mirroring upstream
 * routers/api/v1/repo/file.go GetArchive → serveRepoArchive (services/
 * repository/archiver). Mechanics live in services/archive.ts (ustar/zip
 * chunk builders over listTree + readBlob; the vendored engine's snapshot
 * builders are not on the dist-types export surface).
 *
 * Upstream contract points mirrored here:
 *   - the `{archive}` tail is `REF.tar.gz` | `REF.zip`; an unknown suffix is
 *     the upstream 400 "unknown format: …" (undeclared at the contract —
 *     runtime-only class); `.bundle` parses upstream as a third format but is
 *     refused here (a git bundle needs pack-level output the API surface does
 *     not carry — documented divergence);
 *   - the ref resolves branch → tag (peeled) → 40-hex oid; anything else
 *     (including an EMPTY repository — no refs to resolve) is the upstream
 *     "unrecognized repository reference" 404;
 *   - the Nix `Link: …rel="immutable"` header keyed by the RESOLVED commit
 *     oid, and an attachment Content-Disposition naming
 *     `<slug>-<ref-slashes-as-dashes>.<ext>`;
 *   - `path` query subpaths (collectionFormat multi) filter the walk with git
 *     archive pathspec semantics;
 *   - reads are anonymous-capable on public repos (upstream repo group
 *     carries reqRepoReader) — optionalAuth.
 *
 * The declared responses stay exactly the contract's {200, 404}. The hono
 * `{archive}` param is one path segment: multi-segment ref names
 * ("feature/x.tar.gz") reach the plain-hono catchall below (outside the
 * generated doc — the contents.ts raw/media precedent), which mirrors the
 * upstream wildcard route.
 */

import type { Context, MiddlewareHandler } from "hono";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import { buildArchive, parseArchiveName, resolveArchiveRef } from "../services/archive";
import { engineReads, refTipMap } from "../services/engine";
import { requireVisibleRepo } from "../services/repo-access";
import { handleGenericEtagPrivateCache, serveSetHeaders } from "../../web/attachments-serving";

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** `?path=a&path=b` arrives as an array, a single `?path=a` as a bare string. */
function subPathsOf(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((p) => p.replace(/^\/+|\/+$/g, "")).filter((p) => p !== "");
}

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

/** Shared handler for the openapi route and the multi-segment catchall. */
async function serveArchive(c: Context<ApiEnv>, owner: string, repo: string, archive: string, subPaths: string[]): Promise<Response> {
  const parsed = parseArchiveName(archive);
  if (parsed === null || parsed.ref === "") {
    throw new ApiError(400, `unknown format: ${archive}`);
  }
  if (parsed.format === "bundle") {
    throw new ApiError(400, "bundle archives are not supported");
  }
  const pair = await requireVisibleRepo(c, { owner, repo });
  const reads = engineReads(c.env, pair.repo);
  const tips = refTipMap(await reads.listRefs());
  const refTarget = resolveArchiveRef(tips, parsed.ref);
  if (refTarget === null) {
    throw new ApiError(404, `unrecognized repository reference: ${parsed.ref}`);
  }
  const commit = await reads.readCommit(refTarget);
  if (commit === null) {
    throw new ApiError(404, `unrecognized repository reference: ${parsed.ref}`);
  }
  const stream = await buildArchive(
    reads,
    refTarget,
    parsed.format,
    pair.repo.slug,
    parsed.ref,
    commit.committer.time,
    subPaths,
  );
  const origin = new URL(c.req.url).origin;
  const ownerEnc = encodeURIComponent(pair.repo.ownerNamespace);
  const slugEnc = encodeURIComponent(pair.repo.slug);
  const link = `<${origin}/api/v1/repos/${ownerEnc}/${slugEnc}/archive/${commit.oid}.${parsed.format}?rev=${commit.oid}>; rel="immutable"`;

  // The pre-serve weak-ETag cache arm (archiver.go:367-373): the path-less
  // stream ride only — `W/"%s-%s-%t"` over CommitID, ArchiveType.String()
  // (the bare extension: "tar.gz"/"zip", models/repo/archiver.go:40-48) and
  // PrefixArchiveFiles (default TRUE, modules/setting/repository.go:153; our
  // downloadName always prefixes, so the %t arm is the constant "true").
  // Upstream sets the ETag into the ResponseWriter on BOTH paths (:89), the
  // 304 returning before anything else — so the miss path's ServeSetHeaders
  // must carry it too (the serve headers never touch ETag), exactly like the
  // attachment router's pass-through. The miss path's private-static
  // Cache-Control (httpcache.go:115) is immediately overwritten by the serve
  // headers (serve.go:96-99). Upstream sets the Link header BEFORE the cache
  // handler, so its 304 carries ETag + Link.
  let weakEtag: string | undefined;
  if (subPaths.length === 0) {
    weakEtag = `W/"${commit.oid}-${parsed.format}-true"`;
    const cached = handleGenericEtagPrivateCache(c.req.raw, weakEtag, null);
    if (cached !== null) {
      cached.headers.set("Link", link);
      return cached;
    }
  }

  // ServeSetHeaders' zero-option form — archiver.go:374
  // `ServeSetHeaders(ctx.Resp, ServeHeaderOptions{Filename: downloadName})`;
  // the non-stream arm rides ctx.ServeContent (base.go:176-180), which calls
  // the same ServeSetHeaders and thereby pre-empts http.ServeContent's own
  // extension sniff with the same already-set type. So Content-Type is the
  // IfZero application/octet-stream floor (serve.go:58) — NOT
  // application/gzip|application/zip (the former hardcoded pair, moved this
  // wave to the pin). The disposition word is ServeSetHeaders' IfZero
  // ATTACHMENT default (serve.go:91) — upstream's own word at this site, not
  // the sniffed INLINE pipeline the attachment byte-serves ride; the
  // downloadName (REF slashes already dashed) legally carries `"`/`\`/non-
  // ASCII, and the Go-exact composition masks per getSafeName with the RFC
  // 2231 twin only when encoding is needed (content_disposition.go:47-65),
  // cut at path.Base inside serveSetHeaders (serve.go:92). The same header
  // set carries nosniff (serve.go:60), the sandbox CSP (serve.go:62-73 —
  // octet-stream is neither pdf nor audio/video), expose-headers (:93) and
  // the zero-duration prod Cache-Control (:96-99 → httpcache.go:29-31).
  // No Content-Length (upstream passes none while streaming) and no
  // Last-Modified in this arm (:374 passes none; the non-stream arm's file
  // mtime belongs to storage this route does not touch).
  const headers = serveSetHeaders({ filename: stream.downloadName, etag: weakEtag ?? null });
  return new Response(stream.body, {
    status: 200,
    headers: { ...headers, Link: link },
  });
}

export function registerArchiveRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  void requireAuth;
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/archive/{archive}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get an archive of a repository",
      operationId: "repoGetArchive",
      request: {
        params: z.object({
          ...ownerRepoParams,
          archive: z.string().min(1).openapi({ description: "the git reference for download with attached archive format (e.g. master.zip)" }),
        }),
        query: z.object({
          path: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .openapi({ description: "subpath of the repository to download", type: "array", items: { type: "string" } }),
        }),
      },
      responses: {
        200: { description: "success" },
        404: notFoundResponse,
      },
    }),
    (c) => {
      const { owner, repo, archive } = c.req.valid("param");
      return serveArchive(c, owner, repo, archive, subPathsOf(c.req.valid("query").path));
    },
    bindValidationHook,
  );

  // Multi-segment refs ("feature/x.tar.gz") — the upstream wildcard tail the
  // single-segment openapi param cannot match (contents.ts catchall pattern).
  app.get("/repos/:owner/:repo/archive/*", (c) => {
    const { owner, repo } = c.req.param();
    const marker = `/${owner}/${repo}/archive/`;
    const tail = c.req.path.slice(c.req.path.indexOf(marker) + marker.length);
    return serveArchive(c, owner, repo, decodeURIComponent(tail), c.req.queries("path") ?? []);
  });
}

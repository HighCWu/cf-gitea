import type { Context, MiddlewareHandler } from "hono";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { TreeEntryJson } from "@cf-gitea/git-engine";
import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import { engineReads, refTipMap, resolveNamedRef } from "../services/engine";
import {
  collectTreeRecursive,
  MAX_RECURSIVE_TREE_ENTRIES,
  toGitBlob,
  toGitTree,
  toReference,
} from "../services/git-models";
import { gitBlobResponseSchema, gitTreeResponseSchema, referenceSchema, type Reference } from "../models/git";
import { setPaginationHeaders } from "../pagination";
import { requireVisibleRepo } from "../services/repo-access";

/**
 * Tier-1 raw git-object reads (SPEC-0004 §2.4 rows repoListAllGitRefs /
 * repoListGitRefs / GetTree / GetBlob — 4 paths, 4 operations). All reads go
 * through the engine's public content RPCs (listRefs / listTree / readBlob);
 * nothing here touches D1 beyond repo resolution.
 *
 * Upstream behavior mirrored (routers/api/v1/repo/git_ref.go + tree.go +
 * blob.go):
 *   - git/refs: the full refs table; an EMPTY repo → 404 (getGitRefsInternal's
 *     len(refs)==0 APIErrorNotFound);
 *   - git/refs/{ref}: PREFIX matching on "refs/" + param (GetRefsFiltered),
 *     several refs may answer one filter; a SINGLE exact match returns the
 *     bare Reference OBJECT (the union quirk the contract's ReferenceList
 *     schema does not model — the compat suite drives the array shape);
 *   - git/trees/{sha}: accepts a ref or commit sha and renders the REAL tree
 *     id; paginated with page + **per_page** (default/cap
 *     DefaultGitTreesPerPage=1000), `truncated` on pages with a successor,
 *     `recursive` flattens depth-first (bounded at MAX_RECURSIVE_TREE_ENTRIES
 *     here — the engine has no walk RPC; per-level listTree RPCs);
 *   - git/blobs/{sha}: base64 content under DefaultMaxBlobSize (10 MiB),
 *     size/url only above; the object-by-oid read composes a bounded tree
 *     walk (find the entry path) + readBlob — the public RPC surface has no
 *     readObject-by-oid; oversized walks → the declared 404.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

/** upstream setting.API.DefaultGitTreesPerPage (modules/setting/api.go:20). */
const GIT_TREES_PER_PAGE = 1000;
/** upstream setting.API.DefaultMaxBlobSize (modules/setting/api.go:21). */
const DEFAULT_MAX_BLOB_SIZE = 10485760;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

function intParam(url: URL, key: string): number {
  const raw = url.searchParams.get(key);
  if (raw === null || !/^-?\d+$/.test(raw)) return 0;
  return Number.parseInt(raw, 10);
}

/** Bounded recursive walk from a level — find the path holding `oid`. */
async function findPathOfOid(
  reads: ReturnType<typeof engineReads>,
  ref: string,
  entries: TreeEntryJson[],
  oid: string,
): Promise<{ path: string; entry: TreeEntryJson } | null> {
  let visited = 0;
  const walk = async (level: TreeEntryJson[], prefix: string): Promise<{ path: string; entry: TreeEntryJson } | null> => {
    for (const entry of level) {
      if (++visited > MAX_RECURSIVE_TREE_ENTRIES) return null;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.oid === oid) return { path, entry };
      if (entry.type === "tree") {
        const child = await reads.listTree(ref, path);
        if (child !== null) {
          const found = await walk(child.entries, path);
          if (found !== null) return found;
        }
      }
    }
    return null;
  };
  return walk(entries, "");
}

/** The prefix-match refs read shared by the openapi route + the catchall. */
async function gitRefsFiltered(c: Context<ApiEnv>, owner: string, repo: string, ref: string): Promise<Response> {
  const pair = await requireVisibleRepo(c, { owner, repo });
  const filter = "refs/" + ref;
  const refs = await engineReads(c.env, pair.repo).listRefs();
  const matched = (refs?.refs ?? []).filter((entry) => entry.name.startsWith(filter));
  if (matched.length === 0) {
    throw new ApiError(404, "not found");
  }
  const origin = new URL(c.req.url).origin;
  const tips = refTipMap(refs);
  const rendered = matched.map((entry) => toReference(entry.name, tips.get(entry.name) ?? { target: entry.target }, pair, origin));
  // the union quirk: a single exact match answers the bare object
  const payload: Reference | Reference[] = rendered.length === 1 && matched[0]!.name === filter ? rendered[0]! : rendered;
  return c.json(payload, 200);
}

export function registerGitRoutes(
  app: OpenAPIHono<ApiEnv>,
  _requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/git/refs (repoListAllGitRefs)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/git/refs",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get specified ref or filtered repository's refs",
      operationId: "repoListAllGitRefs",
      request: { params: z.object(ownerRepoParams) },
      responses: {
        200: { description: "ReferenceList", content: { "application/json": { schema: z.array(referenceSchema) } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      const refs = await engineReads(c.env, pair.repo).listRefs();
      if (refs === null || refs.refs.length === 0) {
        throw new ApiError(404, "not found");
      }
      const origin = new URL(c.req.url).origin;
      const tips = refTipMap(refs);
      return c.json(refs.refs.map((ref) => toReference(ref.name, tips.get(ref.name) ?? { target: ref.target }, pair, origin)), 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/git/refs/{ref} (repoListGitRefs) — prefix
  // matching on "refs/" + param; a single exact match answers the bare object.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/git/refs/{ref}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get specified ref or filtered repository's refs",
      operationId: "repoListGitRefs",
      request: {
        params: z.object({
          ...ownerRepoParams,
          ref: z.string().min(1).openapi({ description: "part or full name of the ref" }),
        }),
      },
      responses: {
        200: { description: "ReferenceList", content: { "application/json": { schema: z.union([referenceSchema, z.array(referenceSchema)]) } } },
        404: notFoundResponse,
      },
    }),
    (c) => {
      const { owner, repo, ref } = c.req.valid("param");
      // Union (single-bare-object | array) response: hono's typed helpers
      // can't narrow z.union at this position — cast at the route boundary
      // (the repoGetContentsList precedent).
      return gitRefsFiltered(c, owner, repo, ref) as unknown as ReturnType<
        typeof c.json<never>
      >;
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/git/trees/{sha} (GetTree) — page/per_page
  // pagination (the contract's exception; SPEC-0004 §2.5).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/git/trees/{sha}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Gets the tree of a repository.",
      operationId: "GetTree",
      request: {
        params: z.object({
          ...ownerRepoParams,
          sha: z.string().min(1).openapi({ description: "sha of the commit" }),
        }),
        query: z.object({
          recursive: z.string().optional().openapi({ type: "boolean", description: "show all directories and files" }),
          page: z.string().optional().openapi({ type: "integer", description: "page number; the 'truncated' field in the response will be true if there are still more items after this page, false if the last page" }),
          per_page: z.string().optional().openapi({ type: "integer", description: "number of items per page" }),
        }),
      },
      responses: {
        200: { description: "GitTreeResponse", content: { "application/json": { schema: gitTreeResponseSchema } } },
        400: validationErrorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      const sha = c.req.valid("param").sha;
      if (sha === "") {
        throw new ApiError(400, "sha not provided");
      }
      const reads = engineReads(c.env, pair.repo);
      // GetTreeBySHA resolves refs AND commits; listTree peels the ref target
      // to its commit and renders the REAL tree id in the response.
      const resolved = resolveNamedRef(refTipMap(await reads.listRefs()), sha, pair.repo.defaultBranch);
      const commit = resolved === null ? await reads.readCommit(sha) : await reads.readCommit(resolved.target);
      if (commit === null) {
        throw new ApiError(400, `sha not found [${sha}]`);
      }
      const listRef = resolved !== null ? resolved.target : sha;
      const tree = await reads.listTree(listRef);
      if (tree === null) {
        throw new ApiError(404, "not found");
      }

      const url = new URL(c.req.url);
      const recursive = ["1", "t", "T", "true", "TRUE", "True", "on"].includes(url.searchParams.get("recursive") ?? "");
      let flattened = tree.entries.map((entry) => ({ ...entry, name: entry.name }));
      let truncated = false;
      if (recursive) {
        const walk = await collectTreeRecursive(reads, listRef, tree.entries, { visited: 0, dirs: 0 });
        flattened = walk.flattened;
        truncated = walk.truncated;
      }

      const perPage = Math.min(Math.max(intParam(url, "per_page"), 0) || GIT_TREES_PER_PAGE, GIT_TREES_PER_PAGE);
      const page = Math.max(intParam(url, "page"), 1);
      const rendered = toGitTree(tree.oid, flattened, truncated, page, perPage, pair, url.origin);
      setPaginationHeaders(c, rendered.total, { page, limit: perPage });
      return c.json(rendered.tree, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/git/blobs/{sha} (GetBlob)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/git/blobs/{sha}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Gets the blob of a repository.",
      operationId: "GetBlob",
      request: {
        params: z.object({
          ...ownerRepoParams,
          sha: z.string().min(1).openapi({ description: "sha of the commit" }),
        }),
      },
      responses: {
        200: { description: "GitBlobResponse", content: { "application/json": { schema: gitBlobResponseSchema } } },
        400: validationErrorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      const sha = c.req.valid("param").sha;
      if (sha === "") {
        throw new ApiError(400, "sha not provided");
      }
      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new ApiError(400, `sha not found [${sha}]`);
      }
      const reads = engineReads(c.env, pair.repo);
      const refs = await reads.listRefs();
      if (refs === null || refs.head === null) {
        throw new ApiError(404, "not found");
      }
      const headRef = resolveNamedRef(refTipMap(refs), refs.head, pair.repo.defaultBranch);
      if (headRef === null) {
        throw new ApiError(404, "not found");
      }
      const tree = await reads.listTree(headRef.target);
      if (tree === null) {
        throw new ApiError(404, "not found");
      }
      // The public RPC surface has no readObject-by-oid: locate the blob's
      // tree path with a bounded walk, then readBlob the path.
      const found = await findPathOfOid(reads, headRef.target, tree.entries, sha);
      if (found === null || found.entry.type !== "blob") {
        throw new ApiError(404, "not found");
      }
      const blob = await reads.readBlob(headRef.target, found.path);
      if (blob === null) {
        throw new ApiError(404, "not found");
      }
      const rendered: import("../models/git").GitBlobResponse = toGitBlob(blob.oid, blob.data, pair, new URL(c.req.url).origin);
      if (blob.data.byteLength > DEFAULT_MAX_BLOB_SIZE) {
        // upstream DefaultMaxBlobSize: size/url only, content withheld
        return c.json({ ...rendered, content: undefined, encoding: undefined }, 200);
      }
      return c.json(rendered, 200);
    },
  );

  // Plain-hono catchall (outside the generated doc): the multi-segment ref
  // filter form (`git/refs/heads/main`) the one-param route cannot match.
  app.get("/repos/:owner/:repo/git/refs/*", (c) => {
    const { owner, repo } = c.req.param();
    const rest = decodeURIComponent(c.req.path.slice(c.req.path.indexOf(`/${owner}/${repo}/git/refs/`) + `/${owner}/${repo}/git/refs/`.length));
    return gitRefsFiltered(c, owner, repo, rest);
  });
}

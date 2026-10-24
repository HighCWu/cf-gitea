import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  combinedStatusSchema,
  commitStatusListSchema,
  commitStatusSchema,
  createStatusOptionSchema,
} from "../models/commit-status";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import {
  createCommitStatus,
  isFullLengthCommitId,
  latestCommitStatuses,
  listCommitStatuses,
  combinedStateOf,
  toApiCommitStatus,
  toApiCommitStatuses,
} from "../services/commit-status";
import {
  apiRepositoryUrl,
  canViewRepository,
  findRepositoryByPath,
  toApiRepository,
  viewerOf,
} from "../services/repository";

/**
 * Tier-1 `repository`-tagged commit-status routes (SPEC-0004 §2.4 rows:
 * repoCreateStatus / repoListStatuses / repoListStatusesByRef /
 * repoGetCombinedStatusByRef). Reads are anonymous-capable (upstream
 * `reqRepoReader(unit.TypeCode)` behind the Contexter); the POST requires a
 * token upstream (`reqToken` + `reqRepoWriter(TypeCode)` — SPEC-0002
 * `write:repository`).
 *
 * Ref-vs-sha (documented wave limitation): upstream resolves the
 * `/commits/{ref}` path params through the storage engine
 * (`utils.ResolveRefCommit` — branches, tags, refs/*, short hashes) and the
 * POST sha through `gitRepo.GetCommit`. The engine is not reachable from the
 * api layer this wave, so:
 *  - `GET /statuses/{sha}` queries the sha verbatim, exactly like upstream
 *    (`getCommitStatuses` does no resolution) — unknown shas list empty.
 *  - `GET /commits/{ref}/*` accepts only a full-length commit id; anything
 *    else 404s with upstream's exact `git.ErrNotExist` message. Branch/tag
 *    resolution is a TODO(SPEC-0001/0003) — until then every branch/tag ref
 *    takes the path upstream itself takes for unresolvable refs.
 *  - `POST /statuses/{sha}` requires a full-length commit id; other input
 *    422s at runtime — a documented runtime-only response (upstream resolves
 *    then 500s on unknown shas; neither is reproducible without the engine).
 *  - Slash-bearing refs must be URL-encoded (`refs%2Fheads%2Fmain`): hono
 *    path params are single-segment, while upstream's chi `<ref:*>` also
 *    matches raw slashes (api.go:1488–1490 deliberately supports both).
 */

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

/** Lenient strings for the enum query params (upstream never validates them:
 * unknown sorts take the default order, unknown states filter nothing). */
const sortParam = z.string().optional().openapi({
  type: "string",
  enum: ["oldest", "recentupdate", "leastupdate", "leastindex", "highestindex"],
  description: "type of sort",
});
const stateParam = z.string().optional().openapi({
  type: "string",
  enum: ["pending", "success", "error", "failure", "warning"],
  description: "type of state",
});

const statusListQuery = {
  query: z.object({
    sort: sortParam,
    state: stateParam,
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

const shaParams = {
  params: z.object({
    ...ownerRepoParams,
    sha: z.string().min(1).openapi({ description: "sha of the commit" }),
  }),
} as const;

const refParams = {
  params: z.object({
    ...ownerRepoParams,
    ref: z.string().min(1).openapi({ description: "name of branch/tag/commit" }),
  }),
} as const;

/** `GET /repos/{owner}/{repo}/statuses/{sha}` (repoListStatuses). */
const listStatusesRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/statuses/{sha}",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get a commit's statuses",
    operationId: "repoListStatuses",
    request: { ...shaParams, ...statusListQuery },
    responses: {
      200: {
        description: "CommitStatusList",
        content: { "application/json": { schema: commitStatusListSchema } },
      },
      400: errorResponse,
      404: notFoundResponse,
    },
  });

/**
 * `POST /repos/{owner}/{repo}/statuses/{sha}` (repoCreateStatus) — 201 with
 * the created CommitStatus. Body bind failures map to the declared 400 (the
 * hook below); upstream's Go bind would 422 at runtime (undeclared).
 */
const createStatusRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/statuses/{sha}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Create a commit status",
    operationId: "repoCreateStatus",
    request: {
      ...shaParams,
      body: {
        content: { "application/json": { schema: createStatusOptionSchema } },
      },
    },
    responses: {
      201: {
        description: "CommitStatus",
        content: { "application/json": { schema: commitStatusSchema } },
      },
      400: errorResponse,
      404: notFoundResponse,
    },
  });

/** `GET /repos/{owner}/{repo}/commits/{ref}/statuses` (repoListStatusesByRef). */
const listStatusesByRefRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/commits/{ref}/statuses",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get a commit's statuses, by branch/tag/commit reference",
    operationId: "repoListStatusesByRef",
    request: { ...refParams, ...statusListQuery },
    responses: {
      200: {
        description: "CommitStatusList",
        content: { "application/json": { schema: commitStatusListSchema } },
      },
      400: errorResponse,
      404: notFoundResponse,
    },
  });

/** `GET /repos/{owner}/{repo}/commits/{ref}/status` (repoGetCombinedStatusByRef). */
const combinedStatusByRefRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/commits/{ref}/status",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get a commit's combined status, by branch/tag/commit reference",
    operationId: "repoGetCombinedStatusByRef",
    request: {
      ...refParams,
      query: z.object({
        page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
        limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
      }),
    },
    responses: {
      200: {
        description: "CombinedStatus",
        content: { "application/json": { schema: combinedStatusSchema } },
      },
      400: errorResponse,
      404: notFoundResponse,
    },
  });

/**
 * Repo resolution shared by all four routes — missing and invisible
 * repositories are the same anti-enumeration 404 (SPEC-0004 §2.4).
 */
async function requireVisibleRepo(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !canViewRepository(viewer, found.repo)) {
    throw new ApiError(404, "not found");
  }
  return { viewer, found };
}

/**
 * The `/commits/{ref}` resolution — full-length commit ids only this wave
 * (see the module comment for the engine TODO). The message is upstream's
 * exact `git.ErrNotExist` rendering for an unresolvable ref, which is what
 * real Gitea answers for unknown refs too.
 */
function resolveRefToFullSha(ref: string): string {
  if (!isFullLengthCommitId(ref)) {
    throw new ApiError(404, `object does not exist [id: ${ref}, rel_path: ]`);
  }
  return ref;
}

/** Body bind hook: upstream's Go bind answers malformed bodies with 422
 * (undeclared here); this route uses the contract-declared 400 instead. */
const statusBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(400, "invalid request body");
  }
  return undefined;
};

export function registerStatusRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(listStatusesRoute(optionalAuth), async (c) => {
    const { sha } = c.req.valid("param");
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const url = new URL(c.req.url);
    const listOptions = parseListOptions(url);
    // Upstream queries the sha verbatim — no resolution on this route.
    const sort = (url.searchParams.get("sort") ?? "").trim();
    const state = (url.searchParams.get("state") ?? "").trim();
    const { items, total } = await listCommitStatuses(c.env.DB, found.repo.id, sha, sort, state, listOptions.page, listOptions.limit);
    setPaginationHeaders(c, total, listOptions);
    return c.json(await toApiCommitStatuses(c.env.DB, viewer, apiRepositoryUrl(found, viewer.origin), items), 200);
  });

  app.openapi(
    createStatusRoute(requireAuth),
    async (c) => {
      const { sha } = c.req.valid("param");
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      if (!isFullLengthCommitId(sha)) {
        // Runtime-only 422: upstream resolves short shas/refs through the
        // engine (TODO(SPEC-0001/0003)); until then only full-length commit
        // ids are accepted, and nothing is stored under other shapes.
        throw new ApiError(422, `invalid sha: ${sha}`);
      }
      const body = c.req.valid("json");
      // Upstream stores the state verbatim without validation (Go has no
      // runtime check); the D1 schema pins the contract enum, so an absent
      // state is rejected (declared 400; out-of-enum values are rejected by
      // the body validator above the handler).
      if (body.state === undefined) {
        throw new ApiError(400, "invalid status state: ");
      }
      // NewCommitStatus trims all text values; the schema pins the 'default'
      // context for absent ones (upstream stores "").
      const context = (body.context ?? "").trim();
      const row = await createCommitStatus(c.env.DB, {
        repoId: found.repo.id,
        sha,
        state: body.state,
        targetUrl: (body.target_url ?? "").trim(),
        description: (body.description ?? "").trim(),
        context: context === "" ? "default" : context,
        creatorId: viewer.requester?.id ?? null,
      });
      return c.json(
        toApiCommitStatus(row, {
          repoApiUrl: apiRepositoryUrl(found, viewer.origin),
          creator: viewer.requester ?? null, // upstream renders ctx.Doer as the creator
        }),
        201,
      );
    },
    statusBodyHook,
  );

  app.openapi(listStatusesByRefRoute(optionalAuth), async (c) => {
    const { ref } = c.req.valid("param");
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const sha = resolveRefToFullSha(ref);
    const url = new URL(c.req.url);
    const listOptions = parseListOptions(url);
    const sort = (url.searchParams.get("sort") ?? "").trim();
    const state = (url.searchParams.get("state") ?? "").trim();
    const { items, total } = await listCommitStatuses(c.env.DB, found.repo.id, sha, sort, state, listOptions.page, listOptions.limit);
    setPaginationHeaders(c, total, listOptions);
    return c.json(await toApiCommitStatuses(c.env.DB, viewer, apiRepositoryUrl(found, viewer.origin), items), 200);
  });

  app.openapi(combinedStatusByRefRoute(optionalAuth), async (c) => {
    const { ref } = c.req.valid("param");
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const sha = resolveRefToFullSha(ref);
    const url = new URL(c.req.url);
    const listOptions = parseListOptions(url);
    const { items, total } = await latestCommitStatuses(c.env.DB, found.repo.id, sha, listOptions.page, listOptions.limit);
    setPaginationHeaders(c, total, listOptions);
    const apiRepo = toApiRepository(viewer, found);
    return c.json(
      {
        state: combinedStateOf(items),
        sha,
        statuses: await toApiCommitStatuses(c.env.DB, viewer, apiRepositoryUrl(found, viewer.origin), items),
        total_count: total,
        repository: apiRepo,
        commit_url: `${apiRepo.url}/commits/${encodeURIComponent(sha)}`,
        url: `${apiRepo.url}/commits/${encodeURIComponent(sha)}/status`,
      },
      200,
    );
  });
}

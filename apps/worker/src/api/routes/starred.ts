import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { repositoryListSchema } from "../models/repository";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { requireVisibleRepo } from "../services/repo-access";
import { toApiRepository, viewerOf } from "../services/repository";
import { isStarring, listStarredRepositories, starRepo, unstarRepo } from "../services/stars";

/**
 * Tier-1 star routes (SPEC-0004 §2.4 rows `GET /user/starred` +
 * `GET/PUT/DELETE /user/starred/{owner}/{repo}`; upstream
 * routers/api/v1/user/star.go GetMyStarredRepos / IsStarring / Star / Unstar
 * over the `stars` raw-D1 store — services/stars.ts documents the schema gap).
 *
 * Auth: upstream wires the group with `reqStarsEnabled()` +
 * `tokenRequiresScopes(repository)` inside the reqToken'd /user group
 * (api.go:1184–1191) — every operation requires a signed-in caller (anonymous
 * → the runtime 401 `token is required` body, the /user RUNTIME_ONLY class;
 * not declared: the vendored contract declares no 401 here). The stars feature
 * flag is always enabled on this instance and per-category token scopes land
 * with the SPEC-0002 API-layer gates. Repo resolution follows the
 * anti-enumeration 404 (requireVisibleRepo); the declared 403s are upstream's
 * ErrBlockedUser family — unreachable with no user-blocks model (documented
 * in services/stars.ts), kept in the declarations as the contract mirror.
 *
 * Semantics: GET 404s when the caller is not starring (upstream
 * APIErrorNotFound); PUT/DELETE are the idempotent 204 star/unstar (upstream
 * StarRepo's already-(un)starring arms return nil → 204 either way).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const emptyResponse = { description: "empty" } as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const listQuerySchema = {
  query: z.object({
    page: z
      .string()
      .optional()
      .openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z
      .string()
      .optional()
      .openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

const listStarredRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/starred",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "The repos that the authenticated user has starred",
    operationId: "userCurrentListStarred",
    request: listQuerySchema,
    responses: {
      200: {
        description: "RepositoryList",
        content: { "application/json": { schema: repositoryListSchema } },
      },
      403: forbiddenResponse,
    },
  });

const checkStarringRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/starred/{owner}/{repo}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Whether the authenticated is starring the repo",
    operationId: "userCurrentCheckStarring",
    request: { params: z.object(ownerRepoParams) },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const putStarRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/user/starred/{owner}/{repo}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Star the given repo",
    operationId: "userCurrentPutStar",
    request: { params: z.object(ownerRepoParams) },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const deleteStarRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/user/starred/{owner}/{repo}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Unstar the given repo",
    operationId: "userCurrentDeleteStar",
    request: { params: z.object(ownerRepoParams) },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

export function registerStarredRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  app.openapi(listStarredRoute(requireAuth), async (c) => {
    const doer = c.get("authUser");
    const row = await findStarredDoerRow(c.env.DB, doer.id);
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listStarredRepositories(c.env.DB, row.id, {
      doerLoginLower: row.usernameLower,
      isAdmin: row.isAdmin,
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const viewer = viewerOf(c);
    return c.json(items.map((pair) => toApiRepository(viewer, pair)), 200);
  });

  app.openapi(checkStarringRoute(requireAuth), async (c) => {
    const pair = await requireVisibleRepo(c, c.req.valid("param"));
    const doer = await findStarredDoerRow(c.env.DB, c.get("authUser").id);
    if (!(await isStarring(c.env.DB, doer.id, pair.repo.id))) {
      // Upstream IsStarring's APIErrorNotFound — the empty-family 404.
      throw new ApiError(404, "not found");
    }
    return c.body(null, 204);
  });

  app.openapi(putStarRoute(requireAuth), async (c) => {
    const pair = await requireVisibleRepo(c, c.req.valid("param"));
    const doer = await findStarredDoerRow(c.env.DB, c.get("authUser").id);
    await starRepo(c.env.DB, doer.id, pair.repo.id, new Date());
    return c.body(null, 204);
  });

  app.openapi(deleteStarRoute(requireAuth), async (c) => {
    const pair = await requireVisibleRepo(c, c.req.valid("param"));
    const doer = await findStarredDoerRow(c.env.DB, c.get("authUser").id);
    await unstarRepo(c.env.DB, doer.id, pair.repo.id);
    return c.body(null, 204);
  });
}

/** The stars store keys on the D1 user id — a resolved token without a row is
 *  the silent-auth-failure convention (the api middlewares' class). The admin
 *  flag comes from the row, not the projection. */
async function findStarredDoerRow(d1: D1Database, doerId: number | undefined) {
  if (doerId === undefined) {
    throw new ApiError(401, "token is required");
  }
  const row = await d1
    .prepare("SELECT id, username_lower AS usernameLower, is_admin AS isAdmin FROM users WHERE id = ?1")
    .bind(doerId)
    .first<{ id: number; usernameLower: string; isAdmin: number }>();
  if (row === null) {
    throw new ApiError(401, "token is required");
  }
  return { id: row.id, usernameLower: row.usernameLower, isAdmin: row.isAdmin === 1 };
}

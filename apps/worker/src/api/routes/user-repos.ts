import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { repositoryListSchema } from "../models/repository";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import {
  findUserByName,
  listOwnedRepositories,
  listUserRepositories,
  toApiRepository,
  viewerOf,
} from "../services/repository";

/**
 * Tier-1 `user`-tagged repository lists (SPEC-0004 §2.4):
 * `GET /users/{username}/repos` (userListRepos) and `GET /user/repos`
 * (userCurrentListRepos). Both send the runtime list headers upstream sends
 * on every list (`X-Total-Count`, `Link`).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
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

/**
 * `GET /users/{username}/repos` — public repositories of the user (all of
 * them when the token resolves to the user themself or a site admin); 404
 * when the user does not exist. Token optional (upstream Contexter resolves
 * `ctx.Doer` on every route — visibility widens for the owner/admin).
 */
function userListReposRoute(optionalAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
    method: "get",
    path: "/users/{username}/repos",
    tags: ["user"],
    summary: "List the repos owned by the given user",
    operationId: "userListRepos",
    middleware: [optionalAuth],
    request: {
      ...listQuerySchema,
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user whose owned repos are to be listed" }),
      }),
    },
    responses: {
      200: {
        description: "RepositoryList",
        content: { "application/json": { schema: repositoryListSchema } },
      },
      404: notFoundResponse,
    },
  });
}

/**
 * `GET /user/repos` — requires a signed-in caller (upstream `reqToken`);
 * anonymous callers get the runtime 401 `token is required` body exactly
 * like `GET /user` (not declared here: the vendored contract documents only
 * 200 — /user's RUNTIME_ONLY_RESPONSES exception pattern, orchestrator-owned
 * table). Created inside `registerUserReposRoutes`: the declaration carries
 * the `requireAuth` middleware handed in by the router.
 */
function userCurrentListReposRoute(requireAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
    method: "get",
    path: "/user/repos",
    tags: ["user"],
    summary: "List the repos that the authenticated user owns",
    operationId: "userCurrentListRepos",
    middleware: [requireAuth],
    request: listQuerySchema,
    responses: {
      200: {
        description: "RepositoryList",
        content: { "application/json": { schema: repositoryListSchema } },
      },
    },
  });
}

export function registerUserReposRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(userListReposRoute(optionalAuth), async (c) => {
    const { username } = c.req.valid("param");
    const viewer = viewerOf(c);
    const user = await findUserByName(c.env.DB, username);
    if (user === null) {
      throw new ApiError(404, "not found");
    }
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listUserRepositories(c.env.DB, user.usernameLower, viewer, listOptions);
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map((pair) => toApiRepository(viewer, pair)), 200);
  });

  app.openapi(userCurrentListReposRoute(requireAuth), async (c) => {
    const viewer = viewerOf(c);
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listOwnedRepositories(c.env.DB, viewer, listOptions);
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map((pair) => toApiRepository(viewer, pair)), 200);
  });
}

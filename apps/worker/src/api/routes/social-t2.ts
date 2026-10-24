import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { repositoryListSchema } from "../models/repository";
import { userListSchema } from "../models/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { requireVisibleRepo } from "../services/repo-access";
import { findUserByName, toApiRepository, viewerOf } from "../services/repository";
import {
  listRepoStargazers,
  listRepoSubscribers,
  listWatchedRepositories,
} from "../services/social-lists";
import { listStarredRepositories } from "../services/stars";
import { listFollowing } from "../services/follows";
import { toApiUser } from "../services/user";

/**
 * Tier-2 social listings (SPEC-0004 appendix A rows repoListStargazers,
 * repoListSubscribers, userListStarred, userCurrentListSubscriptions,
 * userListSubscriptions, userCurrentListFollowing — upstream repo/star.go
 * ListStargazers, repo/subscribe.go Subscribers + GetWatchedRepos variants,
 * follower.go ListMyFollowing).
 *
 * Auth (upstream registration):
 *   - the repo listings ride `repoAssignment()` — anonymous reads on public
 *     repositories (optionalAuth);
 *   - the /user and /users groups are `reqToken()` (api.go:1077–1092 /
 *     1180–1229) — requireAuth; anonymous callers get the runtime-only 401
 *     "token is required" body (the /user RUNTIME_ONLY class, undeclared in
 *     the vendored swagger and NOT added to the orchestrator tables by this
 *     batch — same convention as routes/starred.ts).
 *
 * Declared 403s (repoListStargazers, userListStarred) are upstream's
 * ErrBlockedUser family — unreachable with no user-blocks model; kept in the
 * declarations as the contract mirror (routes/starred.ts convention).
 *
 * The doer-idless corner (a resolved identity with no D1 row) answers the
 * silent-auth-failure 401 (the starred routes' convention).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

const usernameParams = {
  params: z.object({
    username: z.string().min(1).openapi({ description: "username of the user" }),
  }),
} as const;

const listStargazersRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/stargazers",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "The users that have starred the repository",
    operationId: "repoListStargazers",
    request: { params: z.object(ownerRepoParams), ...listQuery },
    responses: {
      200: { description: "UserList", content: { "application/json": { schema: userListSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const listSubscribersRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/subscribers",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "The users that are watching the repository",
    operationId: "repoListSubscribers",
    request: { params: z.object(ownerRepoParams), ...listQuery },
    responses: {
      200: { description: "UserList", content: { "application/json": { schema: userListSchema } } },
      404: notFoundResponse,
    },
  });

const userListStarredRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}/starred",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "The repos that the given user has starred",
    operationId: "userListStarred",
    request: { ...usernameParams, ...listQuery },
    responses: {
      200: { description: "RepositoryList", content: { "application/json": { schema: repositoryListSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const userCurrentListSubscriptionsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/subscriptions",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List repositories watched by the authenticated user",
    operationId: "userCurrentListSubscriptions",
    request: listQuery,
    responses: {
      200: { description: "RepositoryList", content: { "application/json": { schema: repositoryListSchema } } },
    },
  });

const userListSubscriptionsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}/subscriptions",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "The repos that the given user is watching",
    operationId: "userListSubscriptions",
    request: { ...usernameParams, ...listQuery },
    responses: {
      200: { description: "RepositoryList", content: { "application/json": { schema: repositoryListSchema } } },
      404: notFoundResponse,
    },
  });

const userCurrentListFollowingRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/following",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the users that the authenticated user is following",
    operationId: "userCurrentListFollowing",
    request: listQuery,
    responses: {
      200: { description: "UserList", content: { "application/json": { schema: userListSchema } } },
    },
  });

/** The doer's D1 row (the visibility predicate needs the lower-cased login;
 *  a resolved token without a row is the silent-auth-failure 401 corner). */
async function requireDoerRow(
  d1: D1Database,
  doer: { id?: number } | undefined,
): Promise<{ id: number; usernameLower: string; isAdmin: boolean }> {
  if (doer?.id === undefined) {
    throw new ApiError(401, "token is required");
  }
  const row = await d1
    .prepare("SELECT id, username_lower AS usernameLower, is_admin AS isAdmin FROM users WHERE id = ?1")
    .bind(doer.id)
    .first<{ id: number; usernameLower: string; isAdmin: number }>();
  if (row === null) {
    throw new ApiError(401, "token is required");
  }
  return { id: row.id, usernameLower: row.usernameLower, isAdmin: row.isAdmin === 1 };
}

export function registerSocialT2Routes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // GET /repos/{owner}/{repo}/stargazers — ListStargazers (repo/star.go).
  app.openapi(listStargazersRoute(optionalAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listRepoStargazers(c.env.DB, found.repo.id, {
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const viewer = viewerOf(c);
    return c.json(items.map((row) => toApiUser(viewer, row)), 200);
  });

  // GET /repos/{owner}/{repo}/subscribers — Subscribers (repo/subscribe.go).
  app.openapi(listSubscribersRoute(optionalAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listRepoSubscribers(c.env.DB, found.repo.id, {
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const viewer = viewerOf(c);
    return c.json(items.map((row) => toApiUser(viewer, row)), 200);
  });

  // GET /users/{username}/starred — GetStarredRepos (user/star.go): the
  // visibility anchor is the DOER (what the requesting caller may see), the
  // list anchor is the named user.
  app.openapi(userListStarredRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    const target = await findUserByName(c.env.DB, username);
    if (target === null) {
      throw new ApiError(404, "not found");
    }
    const doer = await requireDoerRow(c.env.DB, c.get("authUser"));
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listStarredRepositories(c.env.DB, target.id, {
      doerLoginLower: doer.usernameLower,
      isAdmin: doer.isAdmin,
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const viewer = viewerOf(c);
    return c.json(items.map((pair) => toApiRepository(viewer, pair)), 200);
  });

  // GET /user/subscriptions — GetMyWatchedRepos (user/subscribe.go).
  app.openapi(userCurrentListSubscriptionsRoute(requireAuth), async (c) => {
    const doer = await requireDoerRow(c.env.DB, c.get("authUser"));
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listWatchedRepositories(c.env.DB, doer.id, {
      doerLoginLower: doer.usernameLower,
      isAdmin: doer.isAdmin,
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const viewer = viewerOf(c);
    return c.json(items.map((pair) => toApiRepository(viewer, pair)), 200);
  });

  // GET /users/{username}/subscriptions — GetWatchedRepos: same visibility
  // anchor as the starred variant (the requesting doer sees public + own).
  app.openapi(userListSubscriptionsRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    const target = await findUserByName(c.env.DB, username);
    if (target === null) {
      throw new ApiError(404, "not found");
    }
    const doer = await requireDoerRow(c.env.DB, c.get("authUser"));
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listWatchedRepositories(c.env.DB, target.id, {
      doerLoginLower: doer.usernameLower,
      isAdmin: doer.isAdmin,
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const viewer = viewerOf(c);
    return c.json(items.map((pair) => toApiRepository(viewer, pair)), 200);
  });

  // GET /user/following — ListMyFollowing (follower.go): the doer-anchored
  // listing over the same follows store the /users/{username} route serves.
  app.openapi(userCurrentListFollowingRoute(requireAuth), async (c) => {
    const doer = c.get("authUser");
    if (doer?.id === undefined) {
      throw new ApiError(401, "token is required");
    }
    const viewer = viewerOf(c);
    const followViewer = { id: doer.id, isAdmin: doer.is_admin === true };
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listFollowing(c.env.DB, doer.id, followViewer, {
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map((row) => toApiUser(viewer, row)), 200);
  });
}

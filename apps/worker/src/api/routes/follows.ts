import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { userListSchema } from "../models/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { listFollowers, listFollowing, isFollowing, type FollowViewer } from "../services/follows";
import { findUserByName, viewerOf } from "../services/repository";
import { toApiUser } from "../services/user";

/**
 * Tier-2 follow routes (SPEC-0004 appendix A rows `/users/{username}/followers`,
 * `/users/{username}/following`, `/users/{username}/following/{target}` —
 * upstream routers/api/v1/user/follower.go ListFollowers / ListFollowing /
 * CheckFollowing). The authenticated trio (`/user/followers`,
 * `/user/following`, `/user/following/{username}`) is a separate appendix row
 * — NOT this batch. The write half (`PUT/DELETE /user/following/{username}`)
 * rides the same appendix row and is equally deferred; the follow table's
 * DDL block for the migration owner lives in services/follows.ts.
 *
 * Declared responses mirror the vendored contract exactly; the RUNTIME-ONLY
 * codes the handlers can still emit (orchestrator-owned
 * RUNTIME_ONLY_RESPONSES table, same class as the /user 401 exception):
 *   - all three: 401 — upstream wires reqToken() at the whole /users group
 *     (routers/api/v1/api.go:1077–1092); the swagger documents only 200/204/404.
 *
 * Target resolution is userAssignment-shaped (404, any user row — orgs pass
 * the individual-perms checker; renamed users keep the landed
 * routes/users.ts no-redirect shape until the users group adopts the seam).
 * The per-target visibility gate (individualPermsChecker) is not applied:
 * every user row is public until the SPEC-0007 visibility model reaches the
 * user directory (same standing TODO as routes/users.ts userGet).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

const followerParams = {
  params: z.object({
    username: z
      .string()
      .min(1)
      .openapi({ description: "username of the user whose followers are to be listed" }),
  }),
} as const;

const followingParams = {
  params: z.object({
    username: z
      .string()
      .min(1)
      .openapi({ description: "username of the user whose followed users are to be listed" }),
  }),
} as const;

const checkFollowingParams = {
  params: z.object({
    username: z.string().min(1).openapi({ description: "username of the following user" }),
    target: z.string().min(1).openapi({ description: "username of the followed user" }),
  }),
} as const;

const userListFollowersRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}/followers",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the given user's followers",
    operationId: "userListFollowers",
    request: { ...listQuery, ...followerParams },
    responses: {
      200: {
        description: "UserList",
        content: { "application/json": { schema: userListSchema } },
      },
      404: notFoundResponse,
    },
  });

const userListFollowingRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}/following",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the users that the given user is following",
    operationId: "userListFollowing",
    request: { ...listQuery, ...followingParams },
    responses: {
      200: {
        description: "UserList",
        content: { "application/json": { schema: userListSchema } },
      },
      404: notFoundResponse,
    },
  });

const userCheckFollowingRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}/following/{target}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Check if one user is following another user",
    operationId: "userCheckFollowing",
    request: checkFollowingParams,
    responses: {
      204: { description: "empty" },
      404: notFoundResponse,
    },
  });

export function registerFollowRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
): void {
  const viewerSlice = (c: { get(key: "authUser"): unknown }): FollowViewer => {
    const requester = c.get("authUser") as import("../models/user").User | undefined;
    // reqToken guarantees an identity; the id-less corner is the landed
    // orgDoerOf convention (invalid credential → the reqToken answer).
    if (requester === undefined || requester.id === undefined) {
      throw new ApiError(401, "token is required");
    }
    return { id: requester.id, isAdmin: requester.is_admin === true };
  };

  app.openapi(userListFollowersRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    const target = await findUserByName(c.env.DB, username);
    if (target === null) {
      throw new ApiError(404, "not found");
    }
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listFollowers(c.env.DB, target.id, viewerSlice(c), {
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const viewer = viewerOf(c);
    return c.json(items.map((row) => toApiUser(viewer, row)), 200);
  });

  app.openapi(userListFollowingRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    const target = await findUserByName(c.env.DB, username);
    if (target === null) {
      throw new ApiError(404, "not found");
    }
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listFollowing(c.env.DB, target.id, viewerSlice(c), {
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const viewer = viewerOf(c);
    return c.json(items.map((row) => toApiUser(viewer, row)), 200);
  });

  // checkUserFollowing (follower.go:158–164): IsFollowing → 204, else 404
  // (the 404 carries the declared APIError body — the notFound ref).
  app.openapi(userCheckFollowingRoute(requireAuth), async (c) => {
    const { username, target: targetName } = c.req.valid("param");
    const user = await findUserByName(c.env.DB, username);
    const target = await findUserByName(c.env.DB, targetName);
    if (user === null || target === null) {
      throw new ApiError(404, "not found");
    }
    if (await isFollowing(c.env.DB, user.id, target.id)) {
      return c.body(null, 204);
    }
    throw new ApiError(404, "not found");
  });
}

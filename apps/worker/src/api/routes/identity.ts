import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { gpgKeyListSchema } from "../models/gpg-key";
import { publicKeyListSchema } from "../models/public-key";
import { userListSchema } from "../models/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { findUserByName, viewerOf } from "../services/repository";
import { followUser, listFollowers, unfollowUser } from "../services/follows";
import { toApiUser } from "../services/user";

/**
 * The identity self-service surface the tier-2 batches deferred (SPEC-0004
 * appendix A category a):
 *   - `GET /user/followers` (userCurrentListFollowers) — follower.go
 *     ListMyFollowers over the same listing the `/users/{username}/followers`
 *     route serves (routes/follows.ts), anchored at the doer;
 *   - `PUT/DELETE /user/following/{username}` (userCurrentPutFollow /
 *     userCurrentDeleteFollow) — follower.go Follow / Unfollow over
 *     models/user/follow.go FollowUser/UnfollowUser; the {username} target is
 *     `context.UserAssignmentAPI()`-shaped (404, any user row — orgs pass,
 *     SPEC-0007 §4.11's type asymmetry);
 *   - `GET /users/{username}/keys` + `GET /users/{username}/gpg_keys`
 *     (userListKeys / userListGPGKeys) — upstream lists real SSH/GPG keys
 *     (routers/api/v1/user/key.go listPublicKeys / ListGPGKeys); cf-gitea has
 *     NO key storage (no public_key/gpg tables, no CRUD), so both render the
 *     contract's declared list as the EMPTY ARRAY — the documented
 *     divergence. `fingerprint` is accepted (declared param) and ignored for
 *     the same reason.
 *
 * Declared responses mirror the vendored contract exactly; the RUNTIME-ONLY
 * codes the handlers can still emit (orchestrator-owned
 * RUNTIME_ONLY_RESPONSES table, same class as the /user 401 exception):
 *   - all five: 401 — upstream wires reqToken()/tokenRequiresScopes(User) at
 *     the groups (api.go /user group + the /users group at api.go:1077–1092);
 *     the swagger documents only 200/204/403/404.
 *   - PUT's declared 403 (ErrBlockedUser, follow.go:38–40) is UNREACHABLE —
 *     no user-blocks model exists yet.
 *   - Follow/unfollow counter maintenance (`num_followers`/`num_following`,
 *     follow.go:45–51) is skipped — the `users` schema has no such columns
 *     (services/follows.ts header divergence note).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

const userCurrentListFollowersRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/followers",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the authenticated user's followers",
    operationId: "userCurrentListFollowers",
    request: listQuery,
    responses: {
      200: {
        description: "UserList",
        content: { "application/json": { schema: userListSchema } },
      },
    },
  });

const userCurrentPutFollowRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/user/following/{username}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Follow a user",
    operationId: "userCurrentPutFollow",
    request: {
      params: z.object({
        username: z.string().min(1).openapi({ description: "username of the user to follow" }),
      }),
    },
    responses: {
      204: { description: "empty" },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const userCurrentDeleteFollowRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/user/following/{username}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Unfollow a user",
    operationId: "userCurrentDeleteFollow",
    request: {
      params: z.object({
        username: z.string().min(1).openapi({ description: "username of the user to unfollow" }),
      }),
    },
    responses: {
      204: { description: "empty" },
      404: notFoundResponse,
    },
  });

const userListKeysRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}/keys",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the given user's public keys",
    operationId: "userListKeys",
    request: {
      ...listQuery,
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user whose public keys are to be listed" }),
        fingerprint: z.string().optional().openapi({ description: "fingerprint of the key" }),
      }),
    },
    responses: {
      200: {
        description: "PublicKeyList",
        content: { "application/json": { schema: publicKeyListSchema } },
      },
      404: notFoundResponse,
    },
  });

const userListGpgKeysRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}/gpg_keys",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the given user's GPG keys",
    operationId: "userListGPGKeys",
    request: {
      ...listQuery,
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user whose GPG key list is to be obtained" }),
      }),
    },
    responses: {
      200: {
        description: "GPGKeyList",
        content: { "application/json": { schema: gpgKeyListSchema } },
      },
      404: notFoundResponse,
    },
  });

export function registerIdentityRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
): void {
  // The doer slice the follow service needs — reqToken guarantees an
  // identity; the id-less corner is the landed orgDoerOf convention
  // (invalid credential → the reqToken answer). The concrete id (not the
  // FollowViewer null-arm) is the doer-anchored listings' anchor.
  const followViewer = (c: { get(key: "authUser"): unknown }): { id: number; isAdmin: boolean } => {
    const requester = c.get("authUser") as import("../models/user").User | undefined;
    if (requester === undefined || requester.id === undefined) {
      throw new ApiError(401, "token is required");
    }
    return { id: requester.id, isAdmin: requester.is_admin === true };
  };

  // GET /user/followers — listUserFollowers(ctx, ctx.Doer) (follower.go):
  // the shared listing anchored at the doer, visibility-filtered by the
  // doer-as-viewer (isUserVisibleToViewerCond lives in the service).
  app.openapi(userCurrentListFollowersRoute(requireAuth), async (c) => {
    const viewer = followViewer(c);
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listFollowers(c.env.DB, viewer.id, viewer, {
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map((row) => toApiUser(viewerOf(c), row)), 200);
  });

  // PUT /user/following/{username} — Follow (follower.go): the target miss is
  // the UserAssignmentAPI 404; self/repeat follows are the model's silent
  // no-ops (204); the 403 arm (blocked users) has no model yet.
  app.openapi(userCurrentPutFollowRoute(requireAuth), async (c) => {
    const doer = followViewer(c);
    const { username } = c.req.valid("param");
    const target = await findUserByName(c.env.DB, username);
    if (target === null) {
      throw new ApiError(404, "not found");
    }
    await followUser(c.env.DB, doer.id, target.id);
    return c.body(null, 204);
  });

  // DELETE /user/following/{username} — Unfollow: same target miss; not-
  // following and self are silent no-ops (204 either way, follow.go:59–62).
  app.openapi(userCurrentDeleteFollowRoute(requireAuth), async (c) => {
    const doer = followViewer(c);
    const { username } = c.req.valid("param");
    const target = await findUserByName(c.env.DB, username);
    if (target === null) {
      throw new ApiError(404, "not found");
    }
    await unfollowUser(c.env.DB, doer.id, target.id);
    return c.body(null, 204);
  });

  // GET /users/{username}/keys + /gpg_keys — the empty-array stubs: the
  // target lookup stays type-blind (UserAssignmentAPI resolves orgs too,
  // SPEC-0007 §4.11), pagination headers still report total 0, and the
  // declared `fingerprint` filter has nothing to filter.
  app.openapi(userListKeysRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    if ((await findUserByName(c.env.DB, username)) === null) {
      throw new ApiError(404, "not found");
    }
    const listOptions = parseListOptions(new URL(c.req.url));
    setPaginationHeaders(c, 0, listOptions);
    return c.json([], 200);
  });

  app.openapi(userListGpgKeysRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    if ((await findUserByName(c.env.DB, username)) === null) {
      throw new ApiError(404, "not found");
    }
    const listOptions = parseListOptions(new URL(c.req.url));
    setPaginationHeaders(c, 0, listOptions);
    return c.json([], 200);
  });
}

import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { gpgKeys, publicKeys } from "../../db/schema";
import { loadSubkeys, toApiGpgKey, toApiPublicKey } from "../services/account-keys";
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
 *     (userListKeys / userListGPGKeys) — REAL reads over the migration-0016
 *     `public_keys`/`gpg_keys` tables (upstream routers/api/v1/user/key.go
 *     listPublicKeys / user/gpg_key.go ListGPGKeys). The row→API mappers are
 *     the shared account-family layer, services/account-keys.ts (`toApiPublicKey`
 *     / `toApiGpgKey` / `loadSubkeys` — the consolidation of misc-t3.ts's
 *     originals, formerly copied verbatim below). Upstream visibility: the
 *     KEYS are public — the handlers
 *     apply no viewer filter, any authenticated caller lists any assigned
 *     user's keys (listPublicKeys(ctx, ctx.ContextUser), key.go:132-135;
 *     listGPGKeys(ctx, ctx.ContextUser.ID), gpg_key.go:46-72; the api.go
 *     `/users` group wires only reqToken + UserAssignmentAPI at api.go:
 *     1085-1092). The USER themselves gate is this route's existing
 *     type-blind `findUserByName` assignment (miss → 404; orgs pass and own
 *     no keys → the empty array). `fingerprint` filters the TARGET's keys —
 *     upstream scopes the arm to the named user on this route (key.go:59-70:
 *     username != "" → userID = user.ID, "Querying not just listing"), and
 *     the plain arm excludes principal keys (NotKeytype KeyTypePrincipal,
 *     key.go:74-78). Private information (owner/read_only/key_type) renders
 *     for the owner or a site admin only (key.go:96-99; every row here has
 *     owner == target, so the per-key doer check collapses to one test).
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

/** Upstream KeyTypePrincipal (models/asymkey/ssh_key.go:35; schema.ts
 *  carries the raw-integer mapping). */
const KEY_TYPE_PRINCIPAL = 3;

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

  // GET /users/{username}/keys — listPublicKeys(ctx, ctx.ContextUser)
  // (user/key.go:132-135): the target miss is this route's existing
  // type-blind assignment 404; the keys themselves are PUBLIC — no viewer
  // filter (module header for the key.go/gpg_key.go cites). The fingerprint
  // arm stays scoped to the target on this named-user route (key.go:59-70);
  // the plain arm excludes principal keys (key.go:74-78, NotKeytype). Order
  // `id` (FindPublicKeyOptions.ToOrders, ssh_key.go:221-223). Private
  // information renders for the owner or a site admin only (key.go:96-99 —
  // every row's owner is the target, so the per-key doer check collapses).
  app.openapi(userListKeysRoute(requireAuth), async (c) => {
    const doer = c.get("authUser");
    const { username } = c.req.valid("param");
    const target = await findUserByName(c.env.DB, username);
    if (target === null) {
      throw new ApiError(404, "not found");
    }
    const url = new URL(c.req.url);
    const fingerprint = url.searchParams.get("fingerprint") ?? "";
    const listOptions = parseListOptions(url);
    const db = drizzle(c.env.DB);
    const where =
      fingerprint !== ""
        ? and(eq(publicKeys.ownerId, target.id), eq(publicKeys.fingerprint, fingerprint))
        : and(eq(publicKeys.ownerId, target.id), ne(publicKeys.type, KEY_TYPE_PRINCIPAL));
    const total = Number((await db.select({ value: sql<number>`count(*)` }).from(publicKeys).where(where))[0]!.value);
    const rows = await db
      .select()
      .from(publicKeys)
      .where(where)
      .orderBy(asc(publicKeys.id))
      .limit(listOptions.limit)
      .offset((listOptions.page - 1) * listOptions.limit);
    setPaginationHeaders(c, total, listOptions);
    const includePrivate = doer.is_admin === true || doer.id === target.id;
    return c.json(rows.map((row) => toApiPublicKey(c, row, target, includePrivate)), 200);
  });

  // GET /users/{username}/gpg_keys — ListGPGKeys → listGPGKeys(ctx,
  // ctx.ContextUser.ID, …) (user/gpg_key.go:46-72): primary rows only
  // (FindGPGKeyOptions' default `primary_key_id = ""`, models/asymkey/
  // gpg_key.go:82-95), LoadSubKeys attached, order `id` (ToOrders,
  // gpg_key.go:78-80). No fingerprint param on this route (the contract
  // declares none); no viewer filter (module header).
  app.openapi(userListGpgKeysRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    const target = await findUserByName(c.env.DB, username);
    if (target === null) {
      throw new ApiError(404, "not found");
    }
    const listOptions = parseListOptions(new URL(c.req.url));
    const db = drizzle(c.env.DB);
    const where = and(eq(gpgKeys.ownerId, target.id), eq(gpgKeys.primaryKeyId, ""));
    const total = Number((await db.select({ value: sql<number>`count(*)` }).from(gpgKeys).where(where))[0]!.value);
    const rows = await db
      .select()
      .from(gpgKeys)
      .where(where)
      .orderBy(asc(gpgKeys.id))
      .limit(listOptions.limit)
      .offset((listOptions.page - 1) * listOptions.limit);
    const subkeys = await loadSubkeys(c.env.DB, rows.map((row) => row.keyId));
    setPaginationHeaders(c, total, listOptions);
    return c.json(rows.map((row) => toApiGpgKey(row, subkeys.get(row.keyId) ?? [])), 200);
  });
}

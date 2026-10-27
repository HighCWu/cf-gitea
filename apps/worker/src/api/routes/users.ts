import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { userSchema } from "../models/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { findUserByName, formInt64, formTrim, viewerOf } from "../services/repository";
import { isUserVisibleToViewer, searchUsers, toApiUser, visibilityDoerOf } from "../services/user";

/**
 * Tier-1 `user`-tagged directory reads (SPEC-0004 §2.4):
 * `GET /users/{username}` (userGet) and `GET /users/search` (userSearch).
 * Both are anonymous-capable upstream (`reqExploreSignIn`); a valid token
 * only widens the response (email visibility for self/admin, the visibility
 * ladder's limited/private arms).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

/**
 * `GET /users/{username}` — vendored contract: tag `user`, operationId
 * `userGet`, 200 → `#/responses/User` + 404 → notFound (upstream user.GetInfo,
 * routers/api/v1/user/user.go:97).
 *
 * SPEC-0004 §2.4 gotcha: 404 for missing AND restricted users —
 * indistinguishable (upstream fakes ErrUserNotExist for invisible users,
 * user.go:114–117). "Restricted" is the `users.visibility` ladder:
 * `IsUserVisibleToViewer` (user.go:1504–1545) reduced to the landed columns
 * (services/user.ts) — public rows always render; limited/private rows only
 * for the row itself, a site admin, and (per the exact upstream arms) a
 * signed-in doer for limited, a followed/co-member doer for private. Org
 * rows answer too (type-blind `GetUserByName`, models/user/user.go:1132) and
 * pass the SAME ladder — `GetInfo` gates every row, so a private org is as
 * fake-404 here as on `/orgs/{org}`.
 */
const userGetRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}",
    middleware: [optionalAuth],
    tags: ["user"],
    summary: "Get a user",
    operationId: "userGet",
    request: {
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user whose data is to be listed" }),
      }),
    },
    responses: {
      200: {
        description: "User",
        content: { "application/json": { schema: userSchema } },
      },
      404: notFoundResponse,
    },
  });

/**
 * `GET /users/search` — vendored contract: tag `user`, operationId
 * `userSearch`, 200 → the contract's inline `{ok, data: [User]}` object
 * (upstream user.Search, routers/api/v1/user/user.go:19). `X-Total-Count` +
 * `Link` are runtime-only list headers upstream sends here at runtime
 * (user.go:89–90), not declared in the contract (SPEC-0004 §2.5).
 */
const userSearchRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/search",
    middleware: [optionalAuth],
    tags: ["user"],
    summary: "Search for users",
    operationId: "userSearch",
    request: {
      query: z.object({
        q: z.string().optional().openapi({ description: "keyword" }),
        uid: z
          .string()
          .optional()
          .openapi({ type: "integer", format: "int64", description: "ID of the user to search for" }),
        page: z
          .string()
          .optional()
          .openapi({ type: "integer", description: "page number of results to return (1-based)" }),
        limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
      }),
    },
    responses: {
      200: {
        description: "SearchResults of a successful search",
        content: {
          "application/json": {
            schema: z.object({
              ok: z.boolean().openapi({ description: "indicates if the search was successful" }),
              data: z.array(userSchema).openapi({ description: "the user search results" }),
            }),
          },
        },
      },
    },
  });

export function registerUsersRoutes(
  app: OpenAPIHono<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // Registration order matters: OpenAPIHono dispatches first-match in
  // registration order, so the static `/users/search` path must be declared
  // before the `/users/{username}` param route or "search" is captured as a
  // username.
  app.openapi(userSearchRoute(optionalAuth), async (c) => {
    const url = new URL(c.req.url);
    const listOptions = parseListOptions(url);
    const viewer = viewerOf(c);
    const { items, total } = await searchUsers(c.env.DB, {
      keyword: formTrim(url.searchParams, "q"),
      uid: formInt64(url.searchParams, "uid"),
      page: listOptions.page,
      limit: listOptions.limit,
      viewer: visibilityDoerOf(viewer),
    });
    setPaginationHeaders(c, total, listOptions);
    return c.json({ ok: true, data: items.map((row) => toApiUser(viewer, row)) }, 200);
  });

  app.openapi(userGetRoute(optionalAuth), async (c) => {
    const { username } = c.req.valid("param");
    const viewer = viewerOf(c);
    const user = await findUserByName(c.env.DB, username);
    if (user === null) {
      // Missing and restricted are the same 404 upstream (anti-enumeration,
      // user.go:114–117); the ladder below keeps the two indistinguishable.
      throw new ApiError(404, "not found");
    }
    if (!(await isUserVisibleToViewer(c.env.DB, user, visibilityDoerOf(viewer)))) {
      // The fake not-exist: an invisible row answers the identical 404 body.
      throw new ApiError(404, "not found");
    }
    return c.json(toApiUser(viewer, user), 200);
  });
}

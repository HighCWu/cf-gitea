import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { userSchema } from "../models/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { findUserByName, formInt64, formTrim, viewerOf } from "../services/repository";
import { searchUsers, toApiUser } from "../services/user";

/**
 * Tier-1 `user`-tagged directory reads (SPEC-0004 §2.4):
 * `GET /users/{username}` (userGet) and `GET /users/search` (userSearch).
 * Both are anonymous-capable upstream (`reqExploreSignIn`); a valid token
 * only widens the response (email visibility for self/admin).
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
 * user.go:114–117). "restricted" is a user-visibility concept the D1 schema
 * does not have yet: every user is treated as public until then.
 * TODO(SPEC-0007 orgs): visibility column + the real visibility check.
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
    const { items, total } = await searchUsers(c.env.DB, {
      keyword: formTrim(url.searchParams, "q"),
      uid: formInt64(url.searchParams, "uid"),
      page: listOptions.page,
      limit: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const viewer = viewerOf(c);
    return c.json({ ok: true, data: items.map((row) => toApiUser(viewer, row)) }, 200);
  });

  app.openapi(userGetRoute(optionalAuth), async (c) => {
    const { username } = c.req.valid("param");
    const user = await findUserByName(c.env.DB, username);
    if (user === null) {
      // Missing and restricted are the same 404 upstream (anti-enumeration);
      // every user is public until the visibility column exists (SPEC-0007).
      throw new ApiError(404, "not found");
    }
    return c.json(toApiUser(viewerOf(c), user), 200);
  });
}

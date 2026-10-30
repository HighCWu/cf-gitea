import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import { apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { userSchema } from "../models/user";
import { findUserByName, viewerOf } from "../services/repository";
import { toApiUserWithCounts } from "../services/user";

/**
 * `GET /user` — vendored contract: tag `user`, operationId `userGetCurrent`,
 * 200 → `#/responses/User` (upstream userGetCurrent, routers/api/v1/user).
 *
 * Response 401 is a documented runtime-only exception (SPEC-0004 §2.5 /
 * scripts/check-openapi.mjs RUNTIME_ONLY_RESPONSES): upstream `reqToken()`
 * rejects anonymous callers with 401 at runtime, the vendored swagger omits
 * the status. The body is the shared `{message, url}` error family, declared
 * per the header→body conversion note.
 */
export function registerUserRoute(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
): void {
  const userRoute = createRoute({
    method: "get",
    path: "/user",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Get the authenticated user",
    operationId: "userGetCurrent",
    responses: {
      200: {
        description: "User",
        content: { "application/json": { schema: userSchema } },
      },
      401: {
        description: "unauthorized",
        content: { "application/json": { schema: apiErrorSchema } },
      },
    },
  });

  app.openapi(userRoute, async (c) => {
    const rendered = c.get("authUser");
    // The self view renders the follower/following counts (upstream renders
    // the raw NumFollowers/NumFollowing columns here too — the same seam as
    // GET /users/{username}): re-read the row and render through the async
    // twin; the middleware's sync render stays for every other route. A
    // missing row (should not happen — the token resolved it) degrades to
    // the middleware's render rather than failing the identity endpoint.
    const row = rendered.login === undefined ? null : await findUserByName(c.env.DB, rendered.login);
    if (row === null) return c.json(rendered, 200);
    return c.json(await toApiUserWithCounts(c.env.DB, viewerOf(c), row), 200);
  });
}

import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import { apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { userSchema } from "../models/user";

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

  app.openapi(userRoute, (c) => {
    const user = c.get("authUser");
    return c.json(user, 200);
  });
}

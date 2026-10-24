import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { SERVER_VERSION } from "../config";
import type { ApiEnv } from "../env";
import { serverVersionSchema, type ServerVersion } from "../models/server-version";

/**
 * `GET /version` — vendored contract: tag `miscellaneous`, operationId
 * `getVersion`, single 200 → `#/responses/ServerVersion`. Anonymous (no auth).
 */
const versionRoute = createRoute({
  method: "get",
  path: "/version",
  tags: ["miscellaneous"],
  summary: "Returns the version of the Gitea application",
  operationId: "getVersion",
  responses: {
    200: {
      description: "ServerVersion",
      content: { "application/json": { schema: serverVersionSchema } },
    },
  },
});

export function registerVersionRoute(app: OpenAPIHono<ApiEnv>): void {
  app.openapi(versionRoute, (c) => {
    const body: ServerVersion = { version: SERVER_VERSION };
    return c.json(body, 200);
  });
}

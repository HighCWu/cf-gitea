import type { OpenAPIHono } from "@hono/zod-openapi";

import { SERVER_VERSION } from "./config";
import type { ApiEnv } from "./env";
import { createApiRouter } from "./router";

/**
 * Info block for the generated OpenAPI document, mirroring the vendored
 * swagger's `info` (title/description/license); `version` carries our pinned
 * SERVER_VERSION instead of upstream's GITEA-API-APP-VERSION placeholder.
 */
const specObjectConfig = {
  openapi: "3.0.3",
  info: {
    title: "Gitea API",
    description: "This documentation describes the Gitea API.",
    license: { name: "MIT", url: "http://opensource.org/licenses/MIT" },
    version: SERVER_VERSION,
  },
};

/**
 * The OpenAPI document describing every declared `/api/v1` route
 * (SPEC-0004 §5.1 contract discipline: the app exposes its route registry).
 * Consumed by scripts/check-openapi.mjs against the vendored Gitea swagger.
 */
export function getGeneratedSpec(): ReturnType<OpenAPIHono<ApiEnv>["getOpenAPIDocument"]> {
  return createApiRouter().getOpenAPIDocument(specObjectConfig);
}

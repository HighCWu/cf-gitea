import { z } from "@hono/zod-openapi";
import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { SWAGGER_DOC_PATH } from "./config";
import type { ApiEnv } from "./env";

/**
 * Wire body of the `error` response family: `{message, url}` — upstream
 * `APIError` (gitea/modules/structs/miscellaneous.go).
 *
 * Contract quirk preserved per SPEC-0004 §2.5: the vendored swagger declares
 * `message`/`url` as response *headers* (swagger-go generation artifact), the
 * runtime sends them as the JSON body. Our zod declaration models the runtime
 * body; scripts/check-openapi.mjs carries the documented header→body
 * conversion note.
 */
export const apiErrorSchema = z.object({
  message: z.string(),
  url: z.string(),
});

/**
 * URL Gitea points at in every error body (`setting.API.SwaggerURL`,
 * gitea/modules/setting/api.go: AppURL + "api/swagger").
 */
export function swaggerDocUrl(c: Context<ApiEnv>): string {
  return `${new URL(c.req.url).origin}${SWAGGER_DOC_PATH}`;
}

/**
 * Runtime error carrying an upstream-style API status + message. Thrown by
 * handlers and middleware; `giteaErrorHandler` renders it.
 */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  /** Extra body fields for error variants that carry them (e.g. 422 `invalidTopics`). */
  readonly extra?: Record<string, unknown>;

  constructor(status: ContentfulStatusCode, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.extra = extra;
  }
}

/**
 * onError middleware producing Gitea's exact error body. Known `ApiError`s
 * render `{message, url}` (+ extras) with their status; `HTTPException`s
 * (hono/@hono-zod-openapi internals — e.g. the declared-body media-type
 * gate's 415) render through the same family with their status; anything
 * else is an internal error rendered like upstream's `APIErrorInternal` in
 * production: status 500 with an empty message (never leak internals).
 */
export const giteaErrorHandler: ErrorHandler<ApiEnv> = (err, c) => {
  if (err instanceof ApiError) {
    return c.json({ message: err.message, url: swaggerDocUrl(c), ...err.extra }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json({ message: err.message, url: swaggerDocUrl(c) }, err.status);
  }
  return c.json({ message: "", url: swaggerDocUrl(c) }, 500);
};

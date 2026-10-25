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
 * Generic user-facing message for untyped internal errors — the exact string
 * upstream substitutes for end users on its own 500 paths: the packages API
 * `ProcessErrorForUser` (gitea/routers/api/packages/helper/helper.go:41,
 * `message = "internal server error"` in prod for non-admins) and the web
 * JSON error path (`gitea/services/context/context.go:272`,
 * `buildUserErrorMessage("internal server error", err)`).
 */
const INTERNAL_ERROR_MESSAGE = "internal server error";

/**
 * onError middleware producing Gitea's exact error body. Known `ApiError`s
 * render `{message, url}` (+ extras) with their status; `HTTPException`s
 * (hono/@hono-zod-openapi internals — e.g. the declared-body media-type
 * gate's 415) render through the same family with their status; anything
 * else is an internal error: the thrown value is logged (upstream logs it
 * too, `apiErrorInternal`'s `log.ErrorWithSkip`) and the body carries the
 * constant `internal server error` fallback. Upstream's own
 * `APIErrorInternal` (gitea/services/context/api.go:117–130) blanks the
 * message entirely in prod — an intentional divergence (production finding
 * ef2c049): `{"message":""}` is a body no client can render, and even
 * `err.message` stays in the logs rather than the wire.
 */
export const giteaErrorHandler: ErrorHandler<ApiEnv> = (err, c) => {
  if (err instanceof ApiError) {
    return c.json({ message: err.message, url: swaggerDocUrl(c), ...err.extra }, err.status);
  }
  if (err instanceof HTTPException) {
    // An HTTPException that carries its own prepared response passes through
    // untouched — the org-rename 307 seam (routes/orgs.ts) needs the Location
    // header + empty body, which the APIError conversion below would erase.
    if (err.res !== undefined) {
      return err.res;
    }
    return c.json({ message: err.message, url: swaggerDocUrl(c) }, err.status);
  }
  console.error(`api: unhandled error on ${c.req.method} ${c.req.path}`, err);
  return c.json({ message: INTERNAL_ERROR_MESSAGE, url: swaggerDocUrl(c) }, 500);
};

import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { markdownOptionSchema } from "../models/markdown-option";
import { MAX_DISPLAY_FILE_SIZE, readLimitedText, renderMarkdownToHtml } from "../services/markdown";

/**
 * Tier-1 `miscellaneous`-tagged markdown rendering (SPEC-0004 §2.4):
 * `POST /markdown` (renderMarkdown) and `POST /markdown/raw`
 * (renderMarkdownRaw). Both require any valid token upstream (`reqToken()`,
 * gitea/routers/api/v1/api.go:1018–1019 — no scope restriction).
 *
 * Response 401 is a documented runtime-only exception (SPEC-0004 §2.5 /
 * scripts/check-openapi.mjs RUNTIME_ONLY_RESPONSES — see the report entry
 * for these routes): the vendored contract declares only 200/422.
 */

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

/**
 * `POST /markdown` — vendored contract: consumes `application/json`,
 * produces `text/html`, 200 → MarkdownRender (string) + 422 →
 * validationError (upstream misc.Markdown, routers/api/v1/misc/markup.go:43).
 * Body field binding mirrors Go's case-insensitive JSON decode: exact
 * contract keys preferred, other casings accepted.
 */
const markdownRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/markdown",
    middleware: [requireAuth],
    tags: ["miscellaneous"],
    summary: "Render a markdown document as HTML",
    operationId: "renderMarkdown",
    request: {
      body: {
        content: { "application/json": { schema: markdownOptionSchema } },
      },
    },
    responses: {
      200: {
        description: "MarkdownRender",
        content: { "text/html": { schema: z.string() } },
      },
      422: validationErrorResponse,
    },
  });

/**
 * `POST /markdown/raw` — vendored contract: consumes `text/plain` (the body
 * IS the raw markdown text, not JSON), produces `text/html`, 200 →
 * MarkdownRender + 422 → validationError (upstream misc.MarkdownRaw,
 * routers/api/v1/misc/markup.go:68 — always mode "markdown", no context).
 */
const markdownRawRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/markdown/raw",
    middleware: [requireAuth],
    tags: ["miscellaneous"],
    summary: "Render raw markdown as HTML",
    operationId: "renderMarkdownRaw",
    request: {
      body: {
        content: { "text/plain": { schema: z.string() } },
        required: true,
        description: "Request body to render",
      },
    },
    responses: {
      200: {
        description: "MarkdownRender",
        content: { "text/html": { schema: z.string() } },
      },
      422: validationErrorResponse,
    },
  });

/** Contract keys of MarkdownOption (Go field names, no json tags). */
const MARKDOWN_OPTION_KEYS = ["Context", "Mode", "Text", "Wiki"] as const;

function markdownOptionKey(rawKey: string): (typeof MARKDOWN_OPTION_KEYS)[number] | null {
  for (const key of MARKDOWN_OPTION_KEYS) {
    if (key === rawKey) {
      return key;
    }
  }
  const lower = rawKey.toLowerCase();
  for (const key of MARKDOWN_OPTION_KEYS) {
    if (key.toLowerCase() === lower) {
      return key;
    }
  }
  return null;
}

/**
 * Bind the MarkdownOption payload the way Go's `bind(api.MarkdownOption{})`
 * does (routers/api/v1/api.go:838): case-insensitive key matching (Go's
 * encoding/json accepts any casing), absent fields are zero values, malformed
 * payloads → 422 validationError (api.go:841–844). The declared route body
 * hands malformed/mistyped JSON to the register-time hook first; this stays
 * as the standalone bind for the cached raw text.
 */
function bindMarkdownOption(raw: string): { text: string; mode: string; context: string; wiki: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(422, "invalid request body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(422, "invalid request body");
  }
  const source = parsed as Record<string, unknown>;
  const option: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(source)) {
    const key = markdownOptionKey(rawKey);
    if (key !== null) {
      option[key] = value;
    }
  }
  const schema = markdownOptionSchema.safeParse(option);
  if (!schema.success) {
    throw new ApiError(422, "invalid request body");
  }
  const { Text, Mode, Context, Wiki } = schema.data;
  return { text: Text ?? "", mode: Mode ?? "", context: Context ?? "", wiki: Wiki ?? false };
}

/** Route registration hook for the declared JSON body: upstream answers bind
 * failures with 422 (api.go:841–844), the vendored contract documents the
 * validationError response — map the validator's default 400 onto the exact
 * error family instead. (hono's validator rejects *unparseable* JSON before
 * the hook runs — that case stays a 400, reported as a runtime divergence.) */
const markdownBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

export function registerMarkdownRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(
    markdownRoute(requireAuth),
    async (c) => {
      // The declared body makes @hono/zod-openapi consume (and cache) the
      // stream for validation; `c.req.text()` resolves from that cache. The
      // JSON body is uncapped like upstream's Go bind — only the raw variant
      // reads through MaxDisplayFileSize.
      const option = bindMarkdownOption(await c.req.text());
      const html = renderMarkdownToHtml({ ...option, origin: new URL(c.req.url).origin });
      // Upstream also sets a nonce'd Content-Security-Policy web-render
      // header here (markup.go:40 SetHeaderContentSecurityPolicyGeneral);
      // the API response is consumed by non-browser clients, and html:false
      // + rel="nofollow" cover the injection surface — a documented
      // divergence.
      return c.body(html, 200, { "Content-Type": HTML_CONTENT_TYPE });
    },
    markdownBodyHook,
  );

  app.openapi(markdownRawRoute(requireAuth), async (c) => {
    const text = await readLimitedText(c.req.raw, MAX_DISPLAY_FILE_SIZE);
    const html = renderMarkdownToHtml({ text, mode: "markdown", context: "", wiki: false, origin: new URL(c.req.url).origin });
    return c.body(html, 200, { "Content-Type": HTML_CONTENT_TYPE });
  });
}

/**
 * GET /repos/{owner}/{repo}/languages (repoGetLanguages — SPEC-0004 §2.4
 * row): bytes per language, computed on demand over the default branch
 * (services/languages.ts — upstream computes async via go-enry and caches;
 * the extension-based reduction and its divergences are documented there).
 *
 * Upstream shape: a JSON map of language name → byte count (the contract's
 * LanguageStatistics response, `produces application/json`), `{}` when the
 * repository has no stats (empty repos included — upstream's empty
 * language_stats table marshals the same). Missing/invisible repository is
 * the anti-enumeration 404. Reads are anonymous-capable on public repos
 * (upstream repo group carries reqRepoReader) — optionalAuth.
 */

import type { MiddlewareHandler } from "hono";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { ApiEnv } from "../env";
import { apiErrorSchema } from "../errors";
import { engineReads } from "../services/engine";
import { languageStats } from "../services/languages";
import { requireVisibleRepo } from "../services/repo-access";

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

export function registerLanguageRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  void requireAuth;
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/languages",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get languages and number of bytes of code written",
      operationId: "repoGetLanguages",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
        }),
      },
      responses: {
        200: {
          description: "LanguageStatistics",
          content: { "application/json": { schema: z.record(z.string(), z.number().int()) } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo } = c.req.valid("param");
      const pair = await requireVisibleRepo(c, { owner, repo });
      const reads = engineReads(c.env, pair.repo);
      const tips = await reads.listRefs();
      const head = tips?.head ?? null;
      if (head === null) {
        // empty repository: no refs → no stats, upstream's empty {} (200)
        return c.json({}, 200);
      }
      return c.json(await languageStats(reads, head), 200);
    },
  );
}

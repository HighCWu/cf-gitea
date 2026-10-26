import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { requireVisibleRepo } from "../services/repo-access";
import { getRepoLicenses } from "../../services/repo-licenses";

/**
 * `GET /repos/{owner}/{repo}/licenses` (repoGetLicenses — long-tail batch;
 * the read side of migration 0027's `repo_license` table). Upstream
 * routers/api/v1/repo/license.go:14-49, mounted
 * `m.Get("/licenses", reqRepoReader(unit.TypeCode), repo.GetLicenses)`
 * (api.go:1544): the rows' `license` strings, ascending (GetRepoLicenses'
 * `.Asc("license")`, models/repo/license.go:66-73).
 *
 * Ours: [optionalAuth] + requireVisibleRepo (the reqRepoReader
 * anti-enumeration 404 — a public repo reads anonymously, an invisible one
 * 404s for strangers, SPEC-0003's ACL matrix).
 *
 * POPULATION (the module contract): upstream populates the table at PUSH
 * time (services/repository/license.go — the licenseclassifier walk of the
 * default branch). cf-gitea's push pipeline now calls the detection glue —
 * services/repo-licenses.ts `syncRepoLicensesFromCell`, wired into the
 * engine's onPush settle seam (webhooks-push.ts `handleUserPushEvent`) — so
 * repos whose default branch carries license files answer real rows, and
 * never-created repos honestly answer `[]` (the same shape, never a fake
 * list).
 *
 * Declared responses mirror the contract exactly: {200, 404}. The 401 arm
 * reqRepoReader can emit for anonymous readers of private repos is
 * runtime-only (the tag-protections batch pattern — the orchestrator-owned
 * RUNTIME_ONLY_RESPONSES table is not extended here).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

export function registerRepoLicenseRoutes(
  app: OpenAPIHono<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/licenses",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get repo licenses",
      operationId: "repoGetLicenses",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
        }),
      },
      responses: {
        200: {
          description: "LicensesList",
          content: { "application/json": { schema: z.array(z.string()) } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo } = c.req.valid("param");
      const pair = await requireVisibleRepo(c, { owner, repo });
      // GetLicenses (license.go:37-48): GetRepoLicenses → the StringList.
      const rows = await getRepoLicenses(c.env.DB, pair.repo.id);
      return c.json(rows.map((row) => row.license), 200);
    },
  );
}

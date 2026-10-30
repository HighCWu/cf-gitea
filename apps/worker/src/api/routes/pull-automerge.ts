/**
 * DELETE /repos/{owner}/{repo}/pulls/{index}/merge (repoCancelScheduledAutoMerge
 * — SPEC-0004 §2.4 row): cancel a scheduled auto-merge. This backend NEVER
 * schedules one (POST …/merge refuses merge_when_checks_succeed with the
 * declared 409 — no scheduled-merge table exists), so the only reachable
 * upstream behavior is the not-scheduled branch of
 * routers/api/v1/repo/pull.go CancelScheduledAutoMerge:
 * GetScheduledMergeByPullID → exist=false → APIErrorNotFound. The route
 * mirrors exactly that, in upstream's order:
 *   1. invisible/missing repository → the anti-enumeration 404;
 *   2. missing PR index → the ErrPullRequestNotExist 404
 *      (`pull request does not exist [id: 0, …]`, the pulls-route message);
 *   3. otherwise (PR exists, nothing scheduled) → the bare 404 "not found".
 *
 * The declared {204, 403, 423} branches are therefore never emitted: 204
 * needs a scheduled row (cannot exist), 403 the cancel-permission check
 * (only reachable past step 3 upstream), 423 has no mustNotBeArchived in the
 * upstream handler (the same declared-but-unreachable shape as the pulls
 * PATCH route). Auth is requireAuth — upstream's write-scope stand-in (the
 * hooks/pulls-merge convention); the anonymous 401 is the usual
 * runtime-only class.
 *
 * NOTE for the router one-liner: this is the ONLY registration of the DELETE
 * method on /repos/{owner}/{repo}/pulls/{index}/merge — routes/pulls.ts owns
 * the GET/POST pair and must not duplicate it.
 */

import type { Context, MiddlewareHandler } from "hono";
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import { findPullRequestByIndex, pullRequestNotExistError } from "../services/pulls";
import { assertPullsUnit } from "../services/issue-unit-gates";
import { requireVisibleRepo } from "../services/repo-access";

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const repoArchivedResponse = {
  description: "repoArchivedError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

function pathId(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function cancelScheduledAutoMerge(c: Context<ApiEnv>, owner: string, repo: string, rawIndex: string): Promise<Response> {
  const found = await requireVisibleRepo(c, { owner, repo });
  // The pulls-group UNIT gate (mustAllowPulls, api.go:1478): a mirror, an
  // archived repo, or a pulls-disabled repo is the bare 404 before the
  // lookup — same shadow the group gate casts over upstream's whole
  // /pulls subtree (services/issue-unit-gates.ts).
  await assertPullsUnit(c.env.DB, found);
  const index = pathId(rawIndex);
  const row = await findPullRequestByIndex(c.env.DB, found.repo.id, index);
  if (row === null) {
    throw pullRequestNotExistError(found.repo.id, index);
  }
  // No scheduled auto-merge can exist on this backend — upstream's
  // GetScheduledMergeByPullID exist=false → APIErrorNotFound.
  throw new ApiError(404, "not found");
}

export function registerPullAutoMergeRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/pulls/{index}/merge",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Cancel the scheduled auto merge for the given pull request",
      operationId: "repoCancelScheduledAutoMerge",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
          index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of the pull request to merge" }),
        }),
      },
      responses: {
        204: { description: "empty" },
        403: forbiddenResponse,
        404: notFoundResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const { owner, repo, index } = c.req.valid("param");
      return cancelScheduledAutoMerge(c, owner, repo, index);
    },
  );
}

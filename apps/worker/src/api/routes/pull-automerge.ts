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
 *   2. missing PR index → the bare APIErrorNotFound 404 ("not found",
 *      services/context/api.go:137-142 — upstream's cancel handler answers
 *      IsErrPullRequestNotExist with the SAME bare 404 as the scheduled-none
 *      arm, pull.go:1279-1282, NOT the pulls-route message);
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
 * THE 58f9890/79a94f9 FLIP: a scheduled row CAN now exist (the web box's
 * MWCS arm + the cron consumer, migration 0059). The route is the FULL
 * upstream ladder now: the not-scheduled 404 (the only arm the old stub
 * could answer), then the cancel-permission check (the SCHEDULER cancels
 * freely; anyone else needs IsUserAllowedToMerge — the landed two-gate
 * shape: base write + the rule's merge whitelist, the 403 otherwise), then
 * RemoveScheduledAutoMerge -> the real 204. The type-35 comment ride is the
 * web module's; the API cancel is silent like upstream's.
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
import { findPullRequestByIndex } from "../services/pulls";
import { getScheduledAutoMerge, removeScheduledAutoMerge } from "../../services/pull-automerge";
import { findRepositoryById } from "../services/repository";
import { findRule, isUserMergeWhitelisted, parseRuleConfig, principalAccessOf } from "../../services/branch-protection";
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
    // IsErrPullRequestNotExist → APIErrorNotFound (pull.go:1279-1282): the
    // BARE 404 "not found" — unlike the pulls GET routes, this handler does
    // not render the ErrPullRequestNotExist message.
    throw new ApiError(404, "not found");
  }
  // GetScheduledMergeByPullID: exist=false → APIErrorNotFound too
  // (pull.go:1289-1292) — the same bare 404 (the old stub's only reachable
  // arm — still the common case).
  const scheduled = await getScheduledAutoMerge(c.env.DB, row.issue.id);
  if (scheduled === null) {
    throw new ApiError(404, "not found");
  }
  // The cancel-permission split (pull.go's ctx.Doer.ID != autoMerge.DoerID):
  // the SCHEDULER cancels freely; anyone else needs IsUserAllowedToMerge —
  // the landed two-gate shape (base write + the rule's merge whitelist).
  // requireAuth guarantees the user; the narrow keeps it cast-free.
  const authUser = c.get("authUser");
  if (authUser !== undefined && authUser.id !== scheduled.doerId) {
    const pair = await findRepositoryById(c.env.DB, found.repo.id);
    if (pair === null) {
      throw new ApiError(404, "not found");
    }
    const access = await principalAccessOf(c.env.DB, pair.repo, authUser);
    const rule = await findRule(c.env.DB, found.repo.id, row.pullRequest.baseBranch);
    const allowed = access.write && (rule === null || (await isUserMergeWhitelisted(c.env.DB, parseRuleConfig(rule.rules), access)));
    if (!allowed) {
      // pull.go:1303-1304's verbatim text (the web handler's HTTPError text
      // is the identical string, routers/web/repo/pull.go:1274).
      throw new ApiError(403, "user has no permission to cancel the scheduled auto merge");
    }
  }
  await removeScheduledAutoMerge(c.env.DB, row.issue, authUser?.id ?? 0, new Date());
  return c.body(null, 204);
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

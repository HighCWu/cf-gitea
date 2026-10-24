import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { pullRequestSchema } from "../models/pull";
import { requireVisibleRepo } from "../services/repo-access";
import { findPullRequestByCommitSha, pullRequestNotCarryingCommitError } from "../services/commit-pull";
import { toApiPullRequest } from "../services/pulls";

/**
 * Tier-1 commit → PR resolution (SPEC-0004 §2.4 row repoGetCommitPullRequest —
 * the LAST pure-D1 tier-1 row; upstream routers/api/v1/repo/commits.go
 * GetCommitPullRequest over the landed `pull_requests` table).
 *
 * Auth: anonymous-capable on public repos (upstream registers the commits
 * group without reqToken — api.go:1494) — the optional-auth middleware only.
 * Data layer: the D1-only `head_sha` join of services/commit-pull.ts (the
 * documented divergence from upstream's `merged_commit_id` lookup — the
 * engine merge wave, SPEC-0004 §6.4, has not landed merge metadata yet);
 * 404 with upstream's exact ErrPullRequestNotExist body when no PR carries
 * the sha. Rendered through the shared PR converter in "single" mode WITHOUT
 * engine extras: `mergeable` renders from the row's cached status machine
 * and `base.sha` stays "" — D1-pure by construction (cache row `none`).
 *
 * Declared responses mirror the vendored contract exactly (200 PullRequest,
 * 404 notFound).
 */
const commitPullRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/commits/{sha}/pull",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get the merged pull request of the commit",
    operationId: "repoGetCommitPullRequest",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo" }),
        repo: z.string().min(1).openapi({ description: "name of the repo" }),
        sha: z.string().min(1).openapi({ description: "SHA of the commit to get" }),
      }),
    },
    responses: {
      200: { description: "PullRequest", content: { "application/json": { schema: pullRequestSchema } } },
      404: {
        description: "notFound",
        content: { "application/json": { schema: apiErrorSchema } },
      },
    },
  });

export function registerCommitPullRoute(app: OpenAPIHono<ApiEnv>, optionalAuth: MiddlewareHandler<ApiEnv>): void {
  app.openapi(commitPullRoute(optionalAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const { sha } = c.req.valid("param");
    const pr = await findPullRequestByCommitSha(c.env.DB, found.repo.id, sha);
    if (pr === null) {
      throw pullRequestNotCarryingCommitError(found.repo.id);
    }
    const viewer = { origin: new URL(c.req.url).origin, requester: c.get("authUser") ?? null };
    return c.json(await toApiPullRequest(c.env.DB, viewer, found, pr.issue, pr.pullRequest, "single"), 200);
  });
}

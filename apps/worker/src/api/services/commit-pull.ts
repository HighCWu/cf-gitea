import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { issues, pullRequests } from "../../db/schema";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { ApiError } from "../errors";

/**
 * `GET /repos/{owner}/{repo}/commits/{sha}/pull` data layer — the LAST
 * pure-D1 tier-1 row (SPEC-0004 §2.4 repoGetCommitPullRequest, cache `none`).
 *
 * Upstream resolves the commit → PR join through
 * `issues_model.GetPullRequestByMergedCommit(ctx, repo.ID, sha)`, which
 * matches `base_repo_id = ? AND merged_commit_id = ?` (gitea/models/issues/
 * pull.go:1000-1017). SPEC-0004 §2.4 (and the batch brief) pin OUR join to
 * `pull_requests.head_sha` instead — the denormalized `refs/pull/N/head`
 * cache our own PR creation flow maintains (schema.ts) — so the endpoint
 * answers "which PR carries this commit" without engine merge metadata,
 * which the 0001b merge wave has not landed yet. The divergence is recorded
 * here and in the route header; when merges land, `merged_commit_id`
 * matching can be added alongside without changing the route.
 *
 * Both lookups are scoped to the BASE repo (upstream's repo_id column) and
 * do NOT filter on the merged flag — upstream takes whatever the single
 * matching row is; we take the lowest id when several PR rows share a head
 * sha (deterministic, Get()'s first-row semantics made stable).
 */

/** The joined PR view (a PR *is* an issue — SPEC-0005 §3.2). */
export interface CommitPullRequest {
  issue: IssueRow;
  pullRequest: PullRequestRow;
}

/** `GetPullRequestByMergedCommit` over the `head_sha` join (module header). */
export async function findPullRequestByCommitSha(
  d1: D1Database,
  repoId: string,
  sha: string,
): Promise<CommitPullRequest | null> {
  const rows = await drizzle(d1)
    .select({ issue: issues, pullRequest: pullRequests })
    .from(pullRequests)
    .innerJoin(issues, eq(issues.id, pullRequests.issueId))
    .where(and(eq(pullRequests.baseRepoId, repoId), eq(pullRequests.headSha, sha)))
    .orderBy(asc(pullRequests.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The 404 body — upstream renders `err.Error()` of
 * `ErrPullRequestNotExist{0, 0, 0, repoID, "", ""}` (routers/api/v1/repo/
 * commits.go GetCommitPullRequest), i.e. the six-field struct format with
 * the zero/empty defaults this lookup carries.
 */
export function pullRequestNotCarryingCommitError(repoId: string): ApiError {
  return new ApiError(
    404,
    "pull request does not exist " +
      `[id: 0, issue_id: 0, head_repo_id: 0, base_repo_id: ${repoId}, head_branch: , base_branch: ]`,
  );
}

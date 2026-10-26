/**
 * PR engine semantics (SPEC-0005 §3.4) over the landed SPEC-0001b RPCs: the
 * lazy mergeability check (GET observes `checking` → checkMergeability →
 * CAS the D1 row), the merge execution per style (executeMerge /
 * rebaseOnto + putRebaseObjects), and the PR diff range composition
 * (merge_base...refs/pull/N/head — SPEC-0004 §6.4/0001b §10.8: the API
 * service owns the composition; the engine never sees PR rows).
 *
 * The D1 landing is CAS-guarded with the `UpdateColsIfNotMerged` rule (§3.4):
 * never overwrite a merged PR's row, so a racing merge wins over a late
 * check. Checks write nothing durable engine-side (0001b §4.6 locked rule) —
 * re-running one is always safe.
 */

import { and, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import type { MergeabilityStatus, MergeStyle, Person, RebaseOutcome } from "@cf-gitea/git-engine";

import { PRFlow, PRStatus, issues, pullRequests } from "../../db/schema";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { CommentType } from "../../issues/comment-types";
import { IssuesService } from "../../issues/service";
import type { ApiEnv } from "../env";
import { ApiError } from "../errors";
import { canUserDelete, findRule, parseRuleConfig, principalAccessOf } from "../../services/branch-protection";
import {
  branchRef,
  engineCell,
  engineReads,
  executeMergeError,
  pullHeadRef,
  ZERO_OID,
} from "./engine";
import { findRepositoryById, type RepositoryWithOwner } from "./repository";
import { canWriteRepository } from "./repo-access";

/** `PullRequestStatus` mapping (§2.4; unrelated has no upstream row → Empty). */
export function statusFromMergeability(status: MergeabilityStatus): number {
  switch (status) {
    case "mergeable":
      return PRStatus.Mergeable;
    case "conflict":
      return PRStatus.Conflict;
    case "ancestor":
      return PRStatus.Ancestor;
    case "empty":
    case "unrelated":
      return PRStatus.Empty;
    case "error":
      return PRStatus.Error;
  }
}

/**
 * The `mergeable` render (convert.toAPIPullRequest): checking → null
 * (unknown), mergeable → true, everything else (conflict/empty/ancestor/
 * error, merged) → false.
 */
export function mergeableOfRow(pr: PullRequestRow): boolean | null {
  if (pr.hasMerged) return false;
  switch (pr.status) {
    case PRStatus.Checking:
      return null;
    case PRStatus.Mergeable:
      return true;
    default:
      return false;
  }
}

/**
 * Lazy mergeability check: a GET observing `status=checking` fires the
 * read-only engine check and CAS-writes the result (status, conflicted
 * files, merge base, divergence, head-sha cache). Transport failures and
 * unresolvable refs leave the row `checking` (the self-healing posture of
 * §3.4 — any later GET re-enqueues the work by simply running again).
 */
export async function ensurePullRequestChecked(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  pr: PullRequestRow,
): Promise<PullRequestRow> {
  if (pr.hasMerged || pr.status !== PRStatus.Checking) {
    return pr;
  }
  const reads = engineReads(c.env, pair.repo);
  const check = await reads.checkMergeability({
    base: branchRef(pr.baseBranch),
    head: pullHeadRef(pr.index),
  });
  if (check === null || check.tag !== "ok") {
    return pr;
  }
  const head = await reads.readCommit(pullHeadRef(pr.index));
  const updated = await drizzle(c.env.DB)
    .update(pullRequests)
    .set({
      status: statusFromMergeability(check.status),
      conflictedFiles: check.conflictedFiles.length > 0 ? JSON.stringify(check.conflictedFiles) : null,
      mergeBase: check.mergeBase,
      commitsAhead: check.commitsAhead,
      commitsBehind: check.commitsBehind,
      ...(head === null ? {} : { headSha: head.oid }),
    })
    // §3.4 CAS guard: never overwrite a merged PR's row.
    .where(and(eq(pullRequests.id, pr.id), eq(pullRequests.hasMerged, false)))
    .returning();
  return updated[0] ?? pr;
}

/**
 * The PR diff range (three-dot): `merge_base...refs/pull/N/head`. The range
 * composition per 0001b §10.8 — a null merge base (unrelated histories)
 * renders an empty diff, exactly like `git diff base...head` upstream.
 */
export async function pullRequestDiff(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  pr: PullRequestRow,
): Promise<{ files: import("@cf-gitea/git-engine").DiffFileJson[]; mergeBase: string | null; head: string }> {
  const reads = engineReads(c.env, pair.repo);
  const baseTip = await reads.readCommit(branchRef(pr.baseBranch));
  const headCommit = await reads.readCommit(pullHeadRef(pr.index));
  if (baseTip === null || headCommit === null) {
    throw new ApiError(404, "not found");
  }
  const mergeBase =
    pr.mergeBase ??
    (await (async () => {
      const base = await reads.mergeBase(baseTip.oid, headCommit.oid);
      return base !== null && base.tag === "ok" ? base.base : null;
    })());
  if (mergeBase === null) {
    return { files: [], mergeBase: null, head: headCommit.oid };
  }
  const diff = await reads.readDiff(headCommit.oid, mergeBase);
  return { files: diff?.files ?? [], mergeBase, head: headCommit.oid };
}

/**
 * HasUnmergedPullRequestsByHeadInfo (models/issues/pull_list.go:140-147) —
 * "checks if there are open and not merged pull request by given head
 * information (repo and branch)": `head_repo_id = ? AND head_branch = ? AND
 * has_merged = 0 AND issue.is_closed = 0 AND flow = Github` (INNER JOIN
 * issue). DeleteBranchAfterMerge consults it before the delete ("Don't clean
 * up when there are other PR's that use this branch as head branch",
 * services/repository/branch.go:844-849) and skips with
 * ErrUnprocessableContent when it answers true — the surviving PR keeps its
 * head branch. Ordering divergence: upstream runs the check AFTER the merge
 * marked this PR merged + closed, so the merged PR excludes itself; ours
 * runs before the D1 landing, so this PR's row is excluded explicitly by
 * issue id.
 */
async function hasUnmergedPullRequestsByHeadInfo(d1: D1Database, headRepoId: string, headBranch: string, excludeIssueId: number): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .innerJoin(issues, eq(issues.id, pullRequests.issueId))
    .where(
      and(
        eq(pullRequests.headRepoId, headRepoId),
        eq(pullRequests.headBranch, headBranch),
        eq(pullRequests.hasMerged, false),
        eq(issues.isClosed, false),
        eq(pullRequests.flow, PRFlow.Github),
        ne(pullRequests.issueId, excludeIssueId),
      ),
    )
    .limit(1)
    .all();
  return rows.length > 0;
}

/**
 * CanDeleteBranchWithPermission's protected-branch arm
 * (services/repository/branch.go:572-583): the first-match rule for the
 * branch gates the delete on protectedBranch.CanUserDelete(doer,
 * permissionInRepo) — ErrBranchIsProtected ("branch is protected",
 * models/git/protected_branch.go:27). The doer's access pair
 * (principalAccessOf) and the CanUserDelete predicate are the same ports the
 * DELETE /repos/{owner}/{repo}/branches endpoint (repoDeleteBranch)
 * enforces; the merge caller only skips.
 */
async function headBranchDeleteRefusedByRule(c: Context<ApiEnv>, pair: RepositoryWithOwner, headBranch: string): Promise<boolean> {
  const rule = await findRule(c.env.DB, pair.repo.id, headBranch);
  if (rule === null) {
    return false;
  }
  const access = await principalAccessOf(c.env.DB, pair.repo, c.get("authUser"));
  return !(await canUserDelete(c.env.DB, parseRuleConfig(rule.rules), access));
}

export interface MergePullOptions {
  style: "merge" | "rebase" | "rebase-merge" | "squash" | "fast-forward-only" | "manually-merged";
  title: string;
  message: string;
  deleteBranchAfterMerge: boolean;
  /** manually-merged: the commit the caller merged into base */
  mergeCommitId?: string;
  doerId: number;
  now: Date;
}

function mergePerson(c: Context<ApiEnv>): Person {
  const doer = c.get("authUser");
  const hostname = new URL(c.req.url).hostname;
  const name = doer?.login ?? "Gitea";
  const email = doer?.email && doer.email !== "" ? doer.email : `${name.toLowerCase()}@noreply.${hostname}`;
  return { name, email, time: Math.floor(Date.now() / 1000), tz: "+0000" };
}

/**
 * Merge execution (§3.4). Preconditions are the route's (mergeable state,
 * not WIP, not merged, not archived); this function lands the engine
 * choreography and then the D1 row + the merge_pull issue close.
 *
 * Styles:
 *   - merge / squash / fast-forward-only → one executeMerge;
 *   - rebase / rebase-merge → rebaseOnto replay, objects land through
 *     putRebaseObjects, then fast-forward-only (rebase) or merge (rebase-
 *     merge) moves the base ref onto the replayed head;
 *   - manually-merged → verify the given commit is an ancestor of base
 *     (upstream MergedManually) and mark the row without touching refs.
 */
export async function mergePullRequest(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  pr: PullRequestRow,
  opts: MergePullOptions,
): Promise<{ commitOid: string | null }> {
  const cell = engineCell(c.env, pair.repo);
  const reads = engineReads(c.env, pair.repo);
  const baseRef = branchRef(pr.baseBranch);
  const headRef = pullHeadRef(pr.index);

  let commitOid: string | null;

  if (opts.style === "manually-merged") {
    if (opts.mergeCommitId === undefined || opts.mergeCommitId === "") {
      throw new ApiError(405, "The merge commit id is required for manually-merged");
    }
    // ancestor verification: mergeBase(commit, baseRef) must be the commit
    const baseTip = await reads.readCommit(baseRef);
    const ancestor = await reads.mergeBase(opts.mergeCommitId, baseRef);
    if (baseTip === null || ancestor === null || ancestor.tag !== "ok" || ancestor.base !== opts.mergeCommitId) {
      throw new ApiError(405, "The merge commit is not an ancestor of the base branch");
    }
    commitOid = opts.mergeCommitId;
  } else {
    const tips = await reads.listRefs();
    const baseTip = (tips?.refs ?? []).find((ref) => ref.name === baseRef)?.target;
    if (baseTip === undefined) {
      throw new ApiError(405, `base branch is missing [name: ${pr.baseBranch}]`);
    }

    let head = headRef;
    let style: MergeStyle = opts.style === "fast-forward-only" ? "fast-forward-only" : opts.style === "squash" ? "squash" : "merge";
    if (opts.style === "rebase" || opts.style === "rebase-merge") {
      const replay: RebaseOutcome = await cell.rebaseOnto({
        head: headRef,
        onto: baseTip,
        committer: mergePerson(c),
      });
      if (replay.tag !== "rebased") {
        throw new ApiError(405, replay.tag === "conflict" ? "rebase would conflict" : replay.tag === "too_many" ? `too many commits to rebase [count: ${replay.count}]` : replay.tag);
      }
      const stored = await cell.putRebaseObjects(replay.objects);
      if (stored.tag !== "ok") {
        throw new ApiError(405, stored.tag === "invalid" ? stored.reason : "rebase too large");
      }
      head = replay.headOid;
      style = opts.style === "rebase" ? "fast-forward-only" : "merge";
    }

    const result = await cell.executeMerge({
      style,
      base: baseRef,
      head,
      expectedBaseOid: baseTip,
      message: opts.title === "" ? opts.message : opts.title,
      author: mergePerson(c),
      committer: mergePerson(c),
      extraRefUpdates: [],
    });
    if (result.tag !== "committed") {
      throw executeMergeError(result);
    }
    commitOid = result.commitOid;

    if (opts.deleteBranchAfterMerge && pr.headRepoId === pair.repo.id) {
      // best-effort head-branch delete (upstream writes the delete_branch
      // system comment too — deferred with the tier-2 surface). The refusal
      // arms mirror upstream DeleteBranchAfterMerge +
      // CanDeleteBranchWithPermission (services/repository/branch.go
      // :838-857, :561-584), in upstream order: the default/target arm
      // (:562-564, ErrBranchIsDefault "branch is default or pull request
      // target"; the target-branch variant is DefaultTargetBranch ??
      // DefaultBranch, and we carry no PR-unit config yet), the shared-head
      // arm (:844-849), the protected-branch arm (:572-583). EVERY refusal
      // SKIPS: the API merge caller logs Debug and ignores the error because
      // the PR has already merged — the merge lands and the branch simply
      // survives (pull.go: "no way to tell users that what error happens,
      // and the PR has been merged, so ignore the error").
      if (pr.headBranch === pair.repo.defaultBranch) {
        console.info(`[pull-engine] head-branch delete skipped: branch is default or pull request target [branch: ${pr.headBranch}]`);
      } else if (await hasUnmergedPullRequestsByHeadInfo(c.env.DB, pr.headRepoId, pr.headBranch, issue.id)) {
        console.info(`[pull-engine] head-branch delete skipped: another open pull request uses this branch as head [branch: ${pr.headBranch}]`);
      } else if (await headBranchDeleteRefusedByRule(c, pair, pr.headBranch)) {
        console.info(`[pull-engine] head-branch delete skipped: branch is protected [branch: ${pr.headBranch}]`);
      } else {
        const headTip = (tips?.refs ?? []).find((ref) => ref.name === branchRef(pr.headBranch))?.target;
        if (headTip !== undefined) {
          try {
            await cell.deleteApiRef({ ref: branchRef(pr.headBranch), expectedOid: headTip });
          } catch (error) {
            console.error(`[pull-engine] head-branch delete failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } else if (opts.deleteBranchAfterMerge) {
      // FORK HEAD: upstream's DeleteBranchAfterMerge operates on pr.HeadRepo,
      // not the base (services/repository/branch.go:812-822 — LoadHeadRepo →
      // GetRepositoryByID, models/issues/pull.go:232-251; a nil head repo —
      // "Forked repository has already been deleted" (:817-820) — fails the
      // delete with repo.branch.deletion_failed and the merge caller ignores
      // it). The SAME guard ladder runs against the HEAD repo's state and the
      // doer's permission THERE: CanDeleteBranch (branch.go:551-557) resolves
      // GetDoerRepoPermission(ctx, pr.HeadRepo, doer) — the fork's own
      // repo-scoped permission (models/perm/access/repo_permission.go:413-418
      // → GetIndividualUserRepoPermission: owner/admin/collaborator/org-team
      // only; allow_maintainer_edit grants nothing here) — so the arms read:
      //   - default/target arm: branch.go:562-564 against pr.HeadRepo
      //     (GetPullRequestTargetBranch → DefaultBranch; no PR-unit config);
      //   - shared-head arm: branch.go:844-849, keyed on pr.HeadRepoID —
      //     the helper above is already head-repo keyed;
      //   - write arm: branch.go:564-566 — permissionInRepo.CanWrite(
      //     unit.TypeCode) IN THE HEAD REPO. The same-repo arm above omits it
      //     because the merge route already required write on the one repo
      //     involved; a fork head needs its own check (a base maintainer
      //     merging an outside fork holds no write there and the delete
      //     skips). principalAccessOf().write is the landed CanWrite port;
      //   - protected arm: branch.go:568-583 — the HEAD repo's first-match
      //     rule + CanUserDelete with the head-repo access pair
      //     (headBranchDeleteRefusedByRule parameterized over the pair).
      // The delete is a CAS on the FORK cell's branch ref (its own cell —
      // forks are full copies, SPEC-0001b §5.2; the engineCell id is the
      // repo's owner/slug identity, not the base's). Every refusal and miss
      // skips — the same skip-not-error posture as the same-repo arm.
      const headPair = await findRepositoryById(c.env.DB, pr.headRepoId);
      if (headPair === null) {
        console.info(`[pull-engine] head-branch delete skipped: head repository is gone [repo_id: ${pr.headRepoId}]`);
      } else if (pr.headBranch === headPair.repo.defaultBranch) {
        console.info(`[pull-engine] head-branch delete skipped: branch is default or pull request target [branch: ${pr.headBranch}]`);
      } else if (await hasUnmergedPullRequestsByHeadInfo(c.env.DB, pr.headRepoId, pr.headBranch, issue.id)) {
        console.info(`[pull-engine] head-branch delete skipped: another open pull request uses this branch as head [branch: ${pr.headBranch}]`);
      } else if (!(await principalAccessOf(c.env.DB, headPair.repo, c.get("authUser"))).write) {
        console.info(`[pull-engine] head-branch delete skipped: no write access to the head repository [repo: ${headPair.repo.ownerNamespace}/${headPair.repo.slug}]`);
      } else if (await headBranchDeleteRefusedByRule(c, headPair, pr.headBranch)) {
        console.info(`[pull-engine] head-branch delete skipped: branch is protected [branch: ${pr.headBranch}]`);
      } else {
        const headCell = engineCell(c.env, headPair.repo);
        const headTip = ((await engineReads(c.env, headPair.repo).listRefs())?.refs ?? []).find((ref) => ref.name === branchRef(pr.headBranch))?.target;
        if (headTip !== undefined) {
          try {
            await headCell.deleteApiRef({ ref: branchRef(pr.headBranch), expectedOid: headTip });
          } catch (error) {
            console.error(`[pull-engine] head-branch delete failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
  }

  // D1 landing: mark merged + close the issue with the merge_pull (28)
  // system comment (§3.4). The close runs first (it owns the repo counters
  // and the system comment inside one batch); the PR row update is guarded
  // by has_merged=0 so a racing merge wins.
  const service = new IssuesService(c.env.DB);
  try {
    await service.closeIssue(issue.id, { actorId: opts.doerId, commentType: CommentType.MergePull, now: opts.now });
  } catch {
    // already closed (upstream tolerates the closed state on merge)
  }
  await drizzle(c.env.DB)
    .update(pullRequests)
    .set({
      hasMerged: true,
      mergedCommitId: commitOid,
      mergerId: opts.doerId,
      mergedAt: opts.now,
      status: PRStatus.Mergeable,
    })
    .where(and(eq(pullRequests.id, pr.id), eq(pullRequests.hasMerged, false)));

  return { commitOid };
}

/**
 * POST /merge-upstream permission gate + the fork gate: forks cannot exist
 * yet (SPEC-0003 fork primitives pending), so every repo answers 404 — the
 * endpoint is wired for the day a `repositories.base_repo_id` column lands.
 */
export async function mergeUpstream(c: Context<ApiEnv>, pair: RepositoryWithOwner): Promise<never> {
  if (!(await canWriteRepository(c, pair))) {
    throw new ApiError(403, "Must have write access");
  }
  throw new ApiError(404, "repository has no upstream (forks cannot exist yet)");
}

/** The refs/pull/N/head write at PR creation (§3.4 creation flow step 4). */
export async function createPullHeadRef(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  index: number,
  headSha: string,
): Promise<void> {
  const result = await engineCell(c.env, pair.repo).commitApiChange({
    ref: pullHeadRef(index),
    expectedOldOid: ZERO_OID,
    newOid: headSha,
  });
  if (result.tag !== "committed") {
    throw new Error(`refs/pull/${index}/head write failed: ${result.tag}`);
  }
}

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
import { carryLooseRefs, type CarrySource, type CarryTarget } from "../../repos/carry";
import { canUserDelete, findRule, parseRuleConfig, principalAccessOf } from "../../services/branch-protection";
import {
  branchRef,
  engineCell,
  engineReads,
  executeMergeError,
  pullHeadRef,
  ZERO_OID,
} from "./engine";
import type { EngineMergeBaseResult, EngineReads } from "./engine";
import { engineRepoName } from "./engine";
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
 * The `mergeable` render (convert.toAPIPullRequest → pr.Mergeable(ctx)):
 * upstream's field is a NON-NULLABLE bool (structs/pull.go:65; swagger
 * "type": "boolean", v1-swagger.generated.json:33120-33124) and the model
 * method answers `status != Checking && status != Conflict && status !=
 * Error && !IsWorkInProgress` (models/issues/pull.go:751-756) — so checking
 * renders FALSE (not null: the board's "mergeable: null while checking"
 * premise predates this pin), conflict/error render false, and
 * ancestor/empty/unrelated pass the filter and render TRUE (only the three
 * statuses above are excluded — the pin's exact filter). Merged rows carry
 * their last status through the merge (upstream's MarkAsMerged keeps
 * pr.Status, services/pull/merge.go:366; our merge write sets Mergeable,
 * executeMerge below), so they render true like upstream. `wip` is
 * `HasWorkInProgressPrefix(issue.title)` (models/issues/pull.go:652-658 —
 * the title-prefix check is the whole gate).
 */
export function mergeableOfRow(pr: PullRequestRow, wip: boolean): boolean {
  if (wip) return false;
  switch (pr.status) {
    case PRStatus.Checking:
    case PRStatus.Conflict:
    case PRStatus.Error:
      return false;
    default:
      return true;
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
 * The stat's engine-read slice over a NARROW env: the service-side emitters
 * (the push webhooks' `WebhookPushEnv`, the issue-delete emission struct)
 * hold structural env slices, not the full request Env `engineReads`
 * (engine.ts) types its parameter against — the same escape `engineWalk`
 * (services/webhooks-push.ts) takes by addressing the cell from the
 * namespace alone. The safe adapter IS engineReads's own (`null` on a
 * thrown transport — the engine.ts module doc; `null` is also the engine's
 * own not-found answer), reduced to the three RPCs the range needs.
 */
function envEngineReads(env: Pick<ApiEnv["Bindings"], "REPO">, pair: RepositoryWithOwner): Pick<EngineReads, "readCommit" | "mergeBase" | "readDiff"> {
  const cell = env.REPO.getByName(engineRepoName(pair.repo));
  // async/await erases the RPC stub's `Promise & Pick` intersection types,
  // which break plain `.catch(() => null)` inference on union results —
  // engineReads's comment verbatim.
  const safe = async <T>(pending: Promise<T>): Promise<T | null> => {
    try {
      return await pending;
    } catch {
      return null;
    }
  };
  return {
    readCommit: (id) => safe(cell.readCommit(id)),
    // the union-returning RPC carries an explicit type argument — the RPC
    // stub's `Promise & Pick` intersections make inference pick one union
    // member (engineReads's comment verbatim).
    mergeBase: (a, b) => safe<EngineMergeBaseResult>(cell.mergeBase(a, b)),
    readDiff: (id, id2) => safe(cell.readDiff(id, id2)),
  };
}

/**
 * The PR diff range (three-dot): `merge_base...refs/pull/N/head`. The range
 * composition per 0001b §10.8 — a null merge base (unrelated histories)
 * renders an empty diff, exactly like `git diff base...head` upstream.
 * `truncated` carries the engine's budget flag (repo.ts computeDiff —
 * MAX_DIFF_FILES=100 / MAX_DIFF_BLOB=512 KiB; SPEC-0001b §3) so stat-style
 * consumers can refuse partial sums instead of serving them as totals.
 *
 * The env-parameterized core serves the non-request callers (the webhook
 * service emitters); the Context wrapper below is the route-facing delegate.
 */
export async function pullRequestDiffForEnv(
  env: Pick<ApiEnv["Bindings"], "REPO">,
  pair: RepositoryWithOwner,
  pr: PullRequestRow,
): Promise<{
  files: import("@cf-gitea/git-engine").DiffFileJson[];
  mergeBase: string | null;
  head: string;
  truncated: boolean;
}> {
  const reads = envEngineReads(env, pair);
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
    return { files: [], mergeBase: null, head: headCommit.oid, truncated: false };
  }
  const diff = await reads.readDiff(headCommit.oid, mergeBase);
  return { files: diff?.files ?? [], mergeBase, head: headCommit.oid, truncated: diff?.truncated ?? false };
}

/** The route-facing diff range — the env core over the request's bindings. */
export async function pullRequestDiff(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  pr: PullRequestRow,
): Promise<{
  files: import("@cf-gitea/git-engine").DiffFileJson[];
  mergeBase: string | null;
  head: string;
  truncated: boolean;
}> {
  return pullRequestDiffForEnv(c.env, pair, pr);
}

/**
 * `GetDiffShortStat`'s API-consumer port — the PR diff-stat trio
 * `additions`/`deletions`/`changed_files` (services/convert/pull.go:245-254:
 * the single converter fills them from a GetDiffShortStat over
 * `pr.MergeBase..head`, and on a diff error it LOGS and leaves all three nil
 * — :247-250). The engine read is the range diff (pullRequestDiff), so the
 * stat is its numstat sum (`add`/`del` per file, DiffFileJson) with
 * `files.length` as NumFiles. The nil-mapping arms, each upstream-faithful:
 *   - a null merge base (upstream's empty `pr.MergeBase` errors the
 *     GetDiffShortStat the same way),
 *   - a TRUNCATED engine walk (the budget-bounded partial — upstream's walk
 *     is never bounded, so there is no upstream equivalent; serving partial
 *     sums as totals would misstate the PR, the error arm's omit posture),
 *   - any engine read failure (upstream logs and omits — :247-250; the
 *     PR itself still renders).
 * Returns null for every omit arm; the converter renders the trio only from
 * a non-null stat (the fields are omitempty pointers, structs/pull.go:51-55).
 *
 * The env-parameterized core serves the webhook/service emitters whose
 * payload conversions ride ToPayloadPullRequest too (the GetDiffShortStat
 * block is NOT gated on isPayload — convert/pull.go:31-34 + :230-254): the
 * push sync (`pull_request_sync`, notifier.go:850), the branch-delete close
 * (IssueChangeStatus, notifier.go:249-271) and the issue-delete funnel
 * (DeleteIssue, notifier.go:313-341). Those callers hold env slices, not a
 * hono Context; `WebhookPushEnv`/the emission struct satisfy the narrow
 * `REPO` pick structurally.
 */
export async function pullRequestDiffShortStatForEnv(
  env: Pick<ApiEnv["Bindings"], "REPO">,
  pair: RepositoryWithOwner,
  pr: PullRequestRow,
): Promise<{ additions: number; deletions: number; changedFiles: number } | null> {
  let range: Awaited<ReturnType<typeof pullRequestDiffForEnv>>;
  try {
    range = await pullRequestDiffForEnv(env, pair, pr);
  } catch {
    return null;
  }
  if (range.mergeBase === null || range.truncated) {
    return null;
  }
  let additions = 0;
  let deletions = 0;
  for (const file of range.files) {
    additions += file.add;
    deletions += file.del;
  }
  return { additions, deletions, changedFiles: range.files.length };
}

/** The route-facing stat — the env core over the request's bindings. */
export async function pullRequestDiffShortStat(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  pr: PullRequestRow,
): Promise<{ additions: number; deletions: number; changedFiles: number } | null> {
  return pullRequestDiffShortStatForEnv(c.env, pair, pr);
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
  /** The composed commit message (composeMergeMessage) — "" when none. */
  message: string;
  deleteBranchAfterMerge: boolean;
  /** manually-merged: the commit the caller merged into base */
  mergeCommitId?: string;
  doerId: number;
  now: Date;
}

/**
 * The API merge message (findings F2 — the empty merge commit). Port of the
 * API handler's composition (gitea/routers/api/v1/repo/pull.go:966-986) over
 * GetDefaultMergeMessage (services/pull/merge.go:112-148): a trimmed
 * `merge_title_field` wins; empty/absent falls to the style's default —
 *   rebase                          → "" (the fast-forward rebase amends nothing)
 *   squash                          → `{title} (#{index})`
 *   merge/rebase-merge/fast-forward-only →
 *     same-repo head:               `Merge pull request '{title}' (#{index}) from {head} into {base}`
 *     deleted head repo:            `Merge pull request '{title}' (#{index}) from <deleted>:{head} into {base}`
 *     fork head:                    `Merge pull request '{title}' (#{index}) from {owner}/{name}:{head} into {base}`
 * A non-empty trimmed `merge_message_field` appends as `\n\n{field}`. The
 * `.gitea/default_merge_message/*.md` template resolution upstream runs
 * first (merge.go:116-122) is NOT modeled — the template-less default is the
 * only path (documented SPEC-0005 divergence). manually-merged callers skip
 * composition entirely (upstream returns at pull.go:945-951 before it).
 */
export async function composeMergeMessage(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  pr: PullRequestRow,
  input: { style: MergePullOptions["style"]; mergeTitleField: string; mergeMessageField: string },
): Promise<string> {
  let defaultTitle: string;
  if (input.style === "rebase") {
    // fast-forward rebase: upstream returns ("", "") — no amend, no message.
    defaultTitle = "";
  } else if (input.style === "squash") {
    defaultTitle = `${issue.title} (#${pr.index})`;
  } else if (pr.headRepoId === pair.repo.id) {
    defaultTitle = `Merge pull request '${issue.title}' (#${pr.index}) from ${pr.headBranch} into ${pr.baseBranch}`;
  } else {
    const head = await findRepositoryById(c.env.DB, pr.headRepoId);
    const from = head === null ? `<deleted>:${pr.headBranch}` : `${head.repo.ownerNamespace}/${head.repo.slug}:${pr.headBranch}`;
    defaultTitle = `Merge pull request '${issue.title}' (#${pr.index}) from ${from} into ${pr.baseBranch}`;
  }
  const title = input.mergeTitleField.trim();
  let message = title === "" ? defaultTitle : title;
  const body = input.mergeMessageField.trim();
  if (body !== "") {
    message += `\n\n${body}`;
  }
  return message;
}

/**
 * The merge commit's author/committer lines, stamped with the merge FLOW's
 * clock (`opts.now` — the same Date the row's merged_at and the merge_pull
 * close comment carry), not a fresh wall read. The render-wallclock audit's
 * class-(c) fix: the stamp lands in STORED git objects, so a pinned clock can
 * only hold the bytes at the write path — and production gets one clock per
 * merge flow (commit stamps == row stamps) instead of two reads a handler
 * apart. Upstream parity: MergePullContext stamps everything from one
 * time.Now (routers/api/v1/repo/pull.go merge handler → pull.Merge).
 */
function mergePerson(c: Context<ApiEnv>, now: Date): Person {
  const doer = c.get("authUser");
  const hostname = new URL(c.req.url).hostname;
  const name = doer?.login ?? "Gitea";
  const email = doer?.email && doer.email !== "" ? doer.email : `${name.toLowerCase()}@noreply.${hostname}`;
  return { name, email, time: Math.floor(now.getTime() / 1000), tz: "+0000" };
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
        committer: mergePerson(c, opts.now),
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
      message: opts.message,
      author: mergePerson(c, opts.now),
      committer: mergePerson(c, opts.now),
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

// ---------------------------------------------------------------------------
// Cross-repo (fork head) PR creation — the create-compare seam the POST arm
// runs for a `user:branch` head. Upstream computes the cross-repo compare in
// the HEAD repository: GetCompareInfo fetches the base commit into the head
// repo first ("we need to fetch the base commit into the head repository
// because we will use headGitRepo in the following code") and merge-bases
// THERE (services/git/compare.go:73-89). Our engine cells are per-repo object
// stores with no cross-cell ancestry (mergeBase/countDivergence are same-cell
// walks), so the identical trick applies natively: forks are FULL copies
// (SPEC-0001b §5.2 — replicateForkCatalog lands the parent's whole catalog),
// so the base's history is already in the fork's cell and the merge base
// computes there. The mirror-image copy — the fork head's divergent closure
// INTO the base cell — is ours alone: upstream does all compare work in the
// head repo, while OUR PR machinery (refs/pull/N/head's landing, the lazy
// mergeability check, the diff range, the merge execution) reads the BASE
// cell exclusively (§10.8 composition; the fork-head tests create through
// this same API path, so the carry is theirs to exercise too).
// ---------------------------------------------------------------------------

/** Structural CarrySource over one cell (the fork-task.ts wrapping style —
 *  plain adapter functions strip the RPC stub's `Promise & Pick`
 *  intersections so the structural assignment infers). `peeled` rides through
 *  like carry.ts's own adapter — the packed-aware partition in carryLooseRefs
 *  keys on it, so a future tag-naming surface gets the packed/loose split for
 *  free instead of a blind walk. */
function carrySource(env: ApiEnv["Bindings"], pair: { ownerNamespace: string; slug: string }): CarrySource {
  const cell = engineCell(env, pair);
  return {
    listRefs: async () => {
      const refs = await cell.listRefs();
      return {
        head: refs.head,
        refs: refs.refs.map((ref) => ({ name: ref.name, target: ref.target, ...(ref.peeled === undefined ? {} : { peeled: ref.peeled }) })),
      };
    },
    listCatalogPage: (after, limit) => cell.listCatalogPage(after, limit),
    readCommit: (id) => cell.readCommit(id),
    listTree: (ref, path) => cell.listTree(ref, path),
    readBlob: (ref, path) => cell.readBlob(ref, path),
  };
}

/** putApiObjects adapter over a cell — the carry target's one-method slice. */
function carryTarget(env: ApiEnv["Bindings"], pair: { ownerNamespace: string; slug: string }): Pick<CarryTarget, "putApiObjects"> {
  const cell = engineCell(env, pair);
  return { putApiObjects: (objects) => cell.putApiObjects(objects) };
}

/** The cell's ACTIVE pack catalog oids — the carry walk's skip set. A packed
 *  oid's closure is self-contained in the cell (carry.ts's pack invariant),
 *  so the walk stops there; base-cell loose objects outside the catalog are
 *  re-put idempotently (putApiObjects no-ops on a known oid). */
async function packedCatalogOids(source: CarrySource): Promise<Set<string>> {
  const packed = new Set<string>();
  let cursor = "";
  for (;;) {
    const page = await source.listCatalogPage(cursor, 8192);
    for (const pack of page.packs) {
      for (const row of pack.rows) packed.add(row.oid);
    }
    cursor = page.nextAfter;
    if (!page.more) break;
  }
  return packed;
}

/**
 * The create arm's merge base for a cross-repo head, computed IN THE HEAD
 * CELL (the fork holds the base's full history — SPEC-0001b §5.2 — so both
 * sides of the walk live there; upstream runs the same computation in the
 * head repo, compare.go:83). When the base advanced past the fork point the
 * base tip is absent from the fork cell (`{tag: "missing", which: "a"}`) and
 * upstream's fetch is ported: the base tip's closure is carried into the fork
 * cell — objects only, no ref, the FetchRemoteTempCommit posture
 * (compare.go:73-80; our GC reclaims unreferenced loose objects) — and the
 * computation retries once. Still no common ancestor → null: upstream's empty
 * `CompareBase` (compare.go:91-93 — GetCompareInfo "does its best"; the PR is
 * still created and diffs empty, never a "nothing to compare" refusal).
 *
 * The carry rides carryLooseRefs (the rename/fork carries' packed-aware
 * partition) with a single synthetic base-branch ref and `head: null` — these
 * carries land OBJECTS only, no ref (the FetchRemoteTempCommit posture), so
 * the returned finalize input is discarded. Today's base is always a branch
 * tip (the route resolved it through branchRef), so the partition is the
 * identity; the adoption matters the day a head/base naming surface reaches a
 * tag, where the pre-adoption blind walk would silently drop the tag tip.
 */
export async function crossRepoCreateMergeBase(
  c: Context<ApiEnv>,
  basePair: RepositoryWithOwner,
  headPair: RepositoryWithOwner,
  baseBranch: string,
  baseTip: string,
  headTip: string,
): Promise<string | null> {
  const headReads = engineReads(c.env, headPair.repo);
  let result = await headReads.mergeBase(baseTip, headTip);
  if (result !== null && result.tag === "missing" && result.which === "a") {
    await carryLooseRefs(
      carrySource(c.env, basePair.repo),
      carryTarget(c.env, headPair.repo),
      [{ name: branchRef(baseBranch), target: baseTip }],
      null,
      await packedCatalogOids(carrySource(c.env, headPair.repo)),
      `${basePair.repo.ownerNamespace}/${basePair.repo.slug} -> ${headPair.repo.ownerNamespace}/${headPair.repo.slug} (pr-create base fetch)`,
    );
    result = await headReads.mergeBase(baseTip, headTip);
  }
  return result !== null && result.tag === "ok" ? result.base : null;
}

/**
 * The head-side counterpart of the base fetch: the fork head's divergent
 * closure is carried INTO the base cell, because everything downstream reads
 * it there — `refs/pull/N/head` cannot even land without it (commitApiChange
 * presence-checks the commit and its root tree, control-plane.d.ts), and the
 * lazy mergeability check, the diff range and the merge execution all walk
 * the base cell. Short-circuits when the base cell already holds the tip
 * (even branches: the shared history IS the base's own).
 *
 * The carry rides carryLooseRefs with a single synthetic head-branch ref and
 * `head: null` — the walk reconstructs objects from the read RPCs and
 * lands them through putApiObjects — idempotent, so a retried or concurrent
 * create is safe, and a failure leaves nothing durable (the walk precedes the
 * D1 creation). No ref lands in the base cell here either: the only ref the
 * create writes is `refs/pull/N/head` (the route's createPullHeadRef), so the
 * returned finalize input is discarded. The partition is the identity for
 * today's branch tips; a head that names a tag rides the packed/loose split
 * instead of the pre-adoption blind walk that silently dropped the tag tip.
 * Bounded walks: a divergent history beyond the walk budgets,
 * or a pushed commit carrying headers serializeCommit does not model (gpgsig
 * et al — the Worker-authored loose class round-trips byte-exact by
 * construction, pushed exotic-header commits do not), throws and fails the
 * create with the honest 500. Runs only for cross-repo heads — the same-repo
 * arm's object store already holds the head branch.
 */
export async function carryForkHeadIntoBase(
  c: Context<ApiEnv>,
  basePair: RepositoryWithOwner,
  headPair: RepositoryWithOwner,
  headBranch: string,
  headTip: string,
): Promise<void> {
  if ((await engineReads(c.env, basePair.repo).readCommit(headTip)) !== null) {
    return;
  }
  const baseSource = carrySource(c.env, basePair.repo);
  await carryLooseRefs(
    carrySource(c.env, headPair.repo),
    carryTarget(c.env, basePair.repo),
    [{ name: branchRef(headBranch), target: headTip }],
    null,
    await packedCatalogOids(baseSource),
    `${headPair.repo.ownerNamespace}/${headPair.repo.slug} -> ${basePair.repo.ownerNamespace}/${basePair.repo.slug} (pr-create head carry)`,
  );
}

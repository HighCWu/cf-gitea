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

import { and, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import type { MergeabilityStatus, MergeStyle, Person, RebaseOutcome } from "@cf-gitea/git-engine";

import { PRFlow, PRStatus, comments, issues, pullAutoMerges, pullRequests, users } from "../../db/schema";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { CommentType } from "../../issues/comment-types";
import { IssueAlreadyChangedError } from "../../issues/errors";
import { notifyMergePullRequest as notifyMergePullRequestWorkflow } from "../../services/projects-workflow";
import { IssuesService } from "../../issues/service";
// Cycle disclosure: ./issues imports pullRequestDiffShortStatForEnv from THIS
// module; both directions use the import inside function bodies only (live
// bindings — no module-init-time reads), so the ESM cycle is safe under Vite
// and workerd. The alternative — duplicating the IssueNoDependenciesLeft
// probe here — would fork the shared port the route's gate and the merge
// box's blocker item already share.
import { issueNoDependenciesLeft } from "./issues";
import type { ApiEnv } from "../env";
import { ApiError } from "../errors";
import { notifyAutoMergePullRequest, notifyMergePullRequest } from "../../services/mail/notify";
import { setIssueReadBy } from "../../services/mentions/carrier";
import { carryLooseRefs, type CarrySource, type CarryTarget } from "../../repos/carry";
import { canUserDelete, findRule, parseRuleConfig, principalAccessOf, type PullBranchProtectionGit } from "../../services/branch-protection";
import { discoverCodeOwnerRules, type CodeOwnerRule } from "../../services/codeowners";
import {
  branchRef,
  engineCell,
  engineReads,
  executeMergeError,
  pullHeadRef,
  refTipMap,
  ZERO_OID,
} from "./engine";
import type { EngineMergeBaseResult, EngineReads } from "./engine";
import { engineRepoName } from "./engine";
import { canViewRepository, doerRepoAccessMode, findRepositoryById, viewerOf, type RepositoryWithOwner } from "./repository";
import { loadRepoSettings } from "./repo-settings";
// Cycle disclosure: ./pull-reviews imports nothing from THIS module; the
// edge exists so the retarget's tail rides the same official-flag predicate
// the review arms use (one isOfficialReviewer, RecalculateReviewsOfficial's
// re-evaluation included).
import { PullReviewsService } from "./pull-reviews";
// The squash default-body builders (the compose arm's GetSquashMergeCommitMessages
// + Reviewed-on half) — the api→page seam; pull-merge-box imports THIS module's
// merge entry points back, so the edge is a lazy cycle (function-body bindings
// only, resolved at call time — the same shape upload-staging→repo-editor-tails
// established, with the back-edge noted in both doc comments).
import { commitMessageMerge, getDefaultMergeMessageParts, squashMergeCommitMessages } from "../../ui/pages/pull-merge-box";
import { canWriteRepository } from "./repo-access";

/**
 * `PullRequestStatusUnrelated` (models/issues/pull.go:118 — the eighth
 * iota value, added by b1c5fedd17 as its own status instead of Empty).
 * Declared here until the db/schema.ts PRStatus enum lands the constant
 * (handoff to the schema owner: `Unrelated: 7` after `Ancestor: 6` —
 * upstream's xorm stores the raw int, no migration, and neither do we);
 * the merge box imports this constant so both sides agree until then.
 */
export const PR_STATUS_UNRELATED = 7;

/** `PullRequestStatus` mapping (§2.4; unrelated carries its own status since
 *  b1c5fedd17 — previously it collapsed into Empty). */
export function statusFromMergeability(status: MergeabilityStatus): number {
  switch (status) {
    case "mergeable":
      return PRStatus.Mergeable;
    case "conflict":
      return PRStatus.Conflict;
    case "ancestor":
      return PRStatus.Ancestor;
    case "empty":
      return PRStatus.Empty;
    case "unrelated":
      return PR_STATUS_UNRELATED;
    case "error":
      return PRStatus.Error;
  }
}

/**
 * The `mergeable` render (convert.toAPIPullRequest → pr.Mergeable(ctx)):
 * upstream's field is a NON-NULLABLE bool (structs/pull.go:65; swagger
 * "type": "boolean", v1-swagger.generated.json:33120-33124) and the model
 * method answers `status != Checking && status != Conflict && status !=
 * Error && status != Unrelated && !IsWorkInProgress` (models/issues/pull.go:
 * 767-775 — b1c5fedd17 added Unrelated to the exclusion set) — so checking/
 * conflict/error render FALSE (not null: the board's "mergeable: null while
 * checking" premise predates this pin), and UNRELATED renders false too
 * since this window, while ancestor/empty pass the filter and render TRUE
 * (only the four statuses above are excluded — the pin's exact filter).
 * Merged rows carry their last status through the merge (upstream's
 * MarkAsMerged keeps pr.Status, services/pull/merge.go:366; our merge write
 * sets Mergeable, executeMerge below), so they render true like upstream.
 * `wip` is `HasWorkInProgressPrefix(issue.title)` (models/issues/pull.go:
 * 668-674 — the title-prefix check is the whole gate).
 */
export function mergeableOfRow(pr: PullRequestRow, wip: boolean): boolean {
  if (wip) return false;
  switch (pr.status) {
    case PRStatus.Checking:
    case PRStatus.Conflict:
    case PRStatus.Error:
      return false;
    case PR_STATUS_UNRELATED:
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

// ---------------------------------------------------------------------------
// The B-53 merge-gate git collection (census B-53 — the codeowner +
// protected-file arms' merge-time view). checkPullBranchProtections
// (services/branch-protection.ts) consumes this through its input.
// ---------------------------------------------------------------------------

/**
 * The merge-time git view the branch-protection gate's B-53 arms read —
 * `pullGateGitInputs` threads into `PullBranchProtectionInput.git`. Both
 * pieces come from ONE base repo (the PR's base; upstream's gate reads
 * `pr.BaseRepo` throughout, services/issue/pull.go:128-206):
 *
 * - `changedFiles` — `GetFilesChangedBetween(mergeBase, headRef)`
 *   (modules/git/repo_compare.go:84: `diff-tree --name-only --root -r`,
 *   a two-commit walk) over `pr.GetGitHeadRefName()` (refs/pull/N/head,
 *   services/issue/pull.go:148). Ours is the PR diff range's path list
 *   (pullRequestDiffForEnv — the same mergeBase..head walk); `complete` is
 *   false on the engine's file budget (`truncated`) AND on a null merge
 *   base (the unrelated-histories state, where upstream's
 *   git.MergeBase errors and the codeowner gate fails closed, :137-166).
 *   A failed walk answers null — the gate's fail-closed carrier.
 * - `codeownerRules` — the CODEOWNERS parse (services/issue/pull.go:47-126,
 *   ported in services/codeowners.ts): a FORK base repo short-circuits to
 *   no rules BEFORE any read (:53-55); otherwise the candidate paths are
 *   probed at the LIVE base-branch tip (GetBranchCommit, :66-67 — not the
 *   stored merge base) with the first found file winning; a missing tip or
 *   an over-size file answers null (fail closed, :69-84).
 *
 * Callers thread this lazily — only when a rule arms one of the arms
 * (upstream returns before any walk when the arms are disarmed), so a
 * plain-protected merge pays nothing.
 */
export async function pullGateGitInputs(env: ApiEnv["Bindings"], pair: RepositoryWithOwner, pr: PullRequestRow, d1: D1Database): Promise<PullBranchProtectionGit> {
  return pullGateGitInputsFromReads(engineReads(env, pair.repo), pair.repo, pr, d1);
}

/**
 * The SAME collection over a caller-provided reads bundle — the B-53R2
 * merge-box display arms thread it through the loader's optional `reads`
 * seam (the callers already build `engineReads(env, repo)` for the squash
 * walk and the branch tips), so the box evaluates the two blockers over the
 * ONE landed composition instead of re-implementing the walk. The walk
 * pieces mirror `pullRequestDiffForEnv`'s arms verbatim: the stored
 * `pr.mergeBase` when the row carries it, the live merge-base read
 * otherwise; a null merge base answers `{paths: [], complete: false}`; a
 * null diff answers the empty COMPLETE walk (the carrier's landed posture);
 * a failed ref read answers null (fail closed).
 */
export async function pullGateGitInputsFromReads(
  reads: EngineReads,
  repo: Pick<RepositoryWithOwner["repo"], "forkParent" | "ownerNamespace" | "slug">,
  pr: PullRequestRow,
  d1: D1Database,
): Promise<PullBranchProtectionGit> {
  const isFork = repo.forkParent !== null;
  const changedFiles = await (async (): Promise<PullBranchProtectionGit["changedFiles"]> => {
    const baseTip = await reads.readCommit(branchRef(pr.baseBranch));
    const headCommit = await reads.readCommit(pullHeadRef(pr.index));
    if (baseTip === null || headCommit === null) return null;
    let mergeBase = pr.mergeBase;
    if (mergeBase === null) {
      const base = await reads.mergeBase(baseTip.oid, headCommit.oid);
      mergeBase = base !== null && base.tag === "ok" ? base.base : null;
    }
    // A null merge base (unrelated histories → the Empty state) leaves the
    // walk incomplete: upstream's git.MergeBase errors there and the
    // codeowner gate fails closed (services/issue/pull.go:152-166 →
    // :171-175).
    if (mergeBase === null) return { paths: [], complete: false };
    const diff = await reads.readDiff(headCommit.oid, mergeBase);
    return { paths: (diff?.files ?? []).map((file) => file.path), complete: !diff?.truncated };
  })().catch((): null => null);

  const codeownerRules = isFork
    ? [] // :53-55 — a fork base repo has no codeowner rules, before any read
    : await (async (): Promise<CodeOwnerRule[] | null> => {
        const baseTip = await reads.readCommit(branchRef(pr.baseBranch));
        if (baseTip === null) return null; // GetBranchCommit error — fail closed
        return discoverCodeOwnerRules(d1, (path) => reads.readBlob(baseTip.oid, path));
      })();

  return { changedFiles, codeownerRules };
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
export async function hasUnmergedPullRequestsByHeadInfo(d1: D1Database, headRepoId: string, headBranch: string, excludeIssueId: number): Promise<boolean> {
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
  /** The auto-merge consumer's flag — upstream Merge's final wasAutoMerged
   *  arg (services/automerge/automerge.go:262 passes true; every manual
   *  caller omits it). FN-7: when set, the merged arm stamps the schedule
   *  row's merged_commit_id before consuming it. */
  wasAutoMerged?: boolean;
  doerId: number;
  now: Date;
}

/**
 * The API merge message (findings F2 — the empty merge commit). Port of the
 * API handler's composition (gitea/routers/api/v1/repo/pull.go:963-986) over
 * GetDefaultMergeMessage: a trimmed `merge_title_field` wins; empty/absent
 * falls to the style's default — getDefaultMergeMessageParts
 * (ui/pages/pull-merge-box.tsx, the api→page seam) resolves the
 * `.gitea/default_merge_message/*.md` template FIRST (merge.go:116-122 →
 * resolveMergeMessageTemplate :150-166: `{STYLE}_TEMPLATE.md` off the base
 * repo's default-branch tip, `DEFAULT_TEMPLATE.md` the fallback; a found
 * template's first line IS the title and its trimmed remainder the body,
 * both shell-like expanded over the vars map with ClosingIssues —
 * merge.go:88-114/:168-175), else the template-less defaults —
 *   rebase                          → "" (the fast-forward rebase amends nothing)
 *   squash                          → `{title} (#{index})`
 *   merge/rebase-merge/fast-forward-only →
 *     same-repo head:               `Merge pull request '{title}' (#{index}) from {head} into {base}`
 *     deleted head repo:            `Merge pull request '{title}' (#{index}) from <deleted>:{head} into {base}`
 *     fork head:                    `Merge pull request '{title}' (#{index}) from {owner}/{name}:{head} into {base}`
 * THE SQUASH DEFAULT BODY (upstream's useDefaultSquashBody arm, pull.go:966-
 * 983): `mergeMessageField === undefined` — the form key ABSENT from the
 * request, exactly upstream's `!HasMergeMessageField &&
 * !Req.Form.Has("merge_message_field")` (forms/repo_form.go:455-457: a
 * present-even-empty JSON value sets HasMergeMessageField and SKIPS the arm;
 * a present-empty field stores the title only) — and style `squash` composes
 * `CommitMessageMerge(GetSquashMergeCommitMessages(pr), defaultBody)` where
 * defaultBody is GetDefaultMergeMessage's body (the template's expanded
 * remainder, or the `Reviewed-on`/`Reviewed-by` block, merge.go:163-165).
 * The composition reuses the merge box's exported builders — the
 * upload-staging→repo-editor-tails precedent; the back-edge is lazy
 * call-time bindings. A non-empty trimmed `merge_message_field` appends as
 * `\n\n{field}`. The web merge-box path passes a plain string (its form
 * always carries the field, upstream web pull.go:1116-1129 has NO default-
 * body arm) — the arm is API-only, exactly upstream. Template/read failures
 * degrade to the template-less shape (the box loader's disclosed err-arm
 * posture) instead of upstream's APIErrorInternal 500 — a prefilled-body
 * read never fails the merge. manually-merged callers skip composition
 * entirely (upstream returns at pull.go:945-951 before it).
 */
export async function composeMergeMessage(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  pr: PullRequestRow,
  input: { style: MergePullOptions["style"]; mergeTitleField: string; mergeMessageField: string | undefined },
): Promise<string> {
  const reads = engineReads(c.env, pair.repo);
  const parts = await getDefaultMergeMessageParts(
    c.env.DB,
    { repo: pair.repo, issue, pr, reads, origin: new URL(c.req.url).origin },
    input.style,
  );
  const title = input.mergeTitleField.trim();
  let message = title === "" ? parts.title : title;
  let field = input.mergeMessageField;
  if (field === undefined && input.style === "squash") {
    // useDefaultSquashBody (pull.go:966-983): the absent field composes the
    // squash default — the commit-message walk + GetDefaultMergeMessage's
    // body joined through git.CommitMessageMerge, then trimmed and appended
    // with the title below.
    const prUnit = (await loadRepoSettings(c.env.DB, pair.repo.id)).prUnit;
    const squashMessages = await squashMergeCommitMessages(c.env.DB, { issue, pr, reads }, prUnit.DefaultSquashMergeMessage);
    field = commitMessageMerge(squashMessages, parts.body);
  }
  const body = (field ?? "").trim();
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
 * not WIP, not merged, not archived) EXCEPT the open-dependency gate, which
 * lives HERE so every caller inherits it (the API route pre-checks the same
 * port; the web merge box and the auto-merge consumer reach the core
 * directly); this function lands the engine choreography and then the D1
 * row + the merge_pull issue close.
 *
 * Styles:
 *   - merge / squash / fast-forward-only → one executeMerge;
 *   - rebase / rebase-merge → rebaseOnto replay, objects land through
 *     putRebaseObjects, then fast-forward-only (rebase) or merge (rebase-
 *     merge) moves the base ref onto the replayed head;
 *   - manually-merged → verify the given commit is an ancestor of base
 *     (upstream MergedManually) and mark the row without touching refs.
 */
/**
 * FN-7: the schedule row's merged_commit_id stamp — upstream's
 * recordMergeIntent arm (services/pull/merge.go:265-274): when the landing
 * is the auto-merge schedule's own, the row records the merge's commit id
 * (`MergedCommitID xorm:"VARCHAR(64)"`, models/pull/automerge.go:26) before
 * MarkAsMerged's consumption (:829-838) deletes it. Exported for the stamp
 * pin (the write is only observable between the stamp and the delete).
 */
export async function stampAutoMergeCommit(d1: D1Database, issueId: number, commitOid: string): Promise<void> {
  await drizzle(d1).update(pullAutoMerges).set({ mergedCommitId: commitOid }).where(eq(pullAutoMerges.issueId, issueId));
}

export async function mergePullRequest(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  pr: PullRequestRow,
  opts: MergePullOptions,
): Promise<{ commitOid: string | null }> {
  // The open-dependency gate — CheckPullMergeable's FINAL arm (services/pull/
  // check.go:214-216): IssueNoDependenciesLeft (models/issues/dependency.go:
  // 190-199 — only `issue_id = this` edges joined to an OPEN dependency_id
  // block; being the blocker never does) must answer true before any merge
  // work starts. Upstream's Manually check type returns BEFORE the gate
  // (check.go:160-163), so the manually-merged mark skips it here too. Error
  // mapping: the error class is check.go:46's ErrDependenciesLeft — since
  // b1c5fedd17 it wraps util.ErrUnprocessableContent and the API ladder's
  // fallthrough renders user-mapped errors (APIErrorInternal → apiErrorAuto →
  // ErrorUnwrapForUser, services/context/api.go:120-123), so a deps-blocked
  // merge answers 422 "is blocked by an open dependency" upstream. This core
  // gate throws that exact status + message (the route pre-gates with the
  // same answer, so both layers agree); the web merge box translates the
  // message back to the pr_close_blocked flash (pull.go:1050-1051's web arm,
  // mergeEngineErrorMessage's dedicated branch), and upstream's issue-close
  // API maps the same condition to 412 Precondition Failed (issue.go:645-648,
  // :983-986).
  if (opts.style !== "manually-merged" && !(await issueNoDependenciesLeft(c.env.DB, issue.id))) {
    throw new ApiError(422, "is blocked by an open dependency");
  }

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
      // GetRepositoryByID, models/issues/pull.go:244-263; a nil head repo —
      // "Forked repository has already been deleted" (:833-836) — fails the
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
  // by has_merged=0 so a racing merge wins. The close service stays BARE —
  // no mail env: upstream's merge close is the MODEL-level SetIssueAsClosed
  // (services/pull/merge.go:838 — no notify fires from it; the merge's only
  // mail is MergePullRequest below, never IssueChangeStatus's close).
  const service = new IssuesService(c.env.DB);
  let mergedIssue = issue;
  try {
    mergedIssue = await service.closeIssue(issue.id, { actorId: opts.doerId, commentType: CommentType.MergePull, now: opts.now });
  } catch (error) {
    // Upstream's SetIssueAsClosed sits INSIDE MarkAsMerged's transaction
    // (merge.go:838-843 — every failure wraps as `ChangeIssueStatus: %w` and
    // fails the WHOLE mark: the PR row update at :845-853 never runs). The one
    // tolerated case is the already-closed race — a concurrent close between
    // the caller's issue load and this close loses closeIssue's CAS
    // (`WHERE is_closed = 0`) and answers IssueAlreadyChangedError; the mark
    // proceeds (the merged-PR tolerance this landing documented). EVERYTHING
    // else propagates — DependenciesLeftError first (issue_update.go:62-72's
    // open-dependency arm, our 412 gate): reachable here through the
    // manually-merged style (CheckPullMergeable skips the deps arm for it,
    // check.go:160-163, so the engine's pre-gate above never fired) and
    // through a dependency added between the pre-gate and this close. A
    // blocked close writes nothing (the gate sits before the CAS batch) and
    // the PR update below never runs — the mark lands NOTHING, exactly
    // upstream: web pull.go MergedManually's default arm ServerErrors and the
    // API handler falls to APIErrorInternal.
    if (error instanceof IssueAlreadyChangedError) {
      // already closed (upstream tolerates the closed state on merge)
    } else {
      throw error;
    }
  }
  const merged = await drizzle(c.env.DB)
    .update(pullRequests)
    .set({
      hasMerged: true,
      mergedCommitId: commitOid,
      mergerId: opts.doerId,
      mergedAt: opts.now,
      status: PRStatus.Mergeable,
    })
    .where(and(eq(pullRequests.id, pr.id), eq(pullRequests.hasMerged, false)))
    .returning({ id: pullRequests.id });

  // The winning-merge mail arm — upstream's markAsMergedPostProcess
  // (services/pull/merge.go:385-412): the MergePullRequest receiver fires
  // ONLY for the landing winner (the CAS `cnt != 1 → ErrIssueAlreadyChanged`
  // guard at :848-852 — a loser must not mail) and carries the RELOADED
  // closed issue. Best-effort, never throws: the merge has already landed,
  // exactly like upstream logs notify errors past the merge (:865-867).
  if (merged.length > 0) {
    // FN-7: the schedule's recordMergeIntent stamp (services/pull/merge.go:
    // 265-274) — when THIS landing is the auto-merge consumer's own, the
    // schedule row records the merge's commit id: the durable marker that
    // this landing was the schedule's own (MarkAsMerged's
    // wasAutoMerged = schedule.MergedCommitID == pr.MergedCommitID,
    // merge.go:834). The stamp precedes the cleanup delete below (:835-838) —
    // the same two-statement order upstream runs across its recordMergeIntent
    // and MarkAsMerged transactions; a crash between them leaves the stamped
    // row, which the consumer's first ladder arm (already-merged) reaps.
    // This SAME condition is the computed wasAutoMerged flavor upstream
    // hands markAsMergedPostProcess (merge.go:863 reads it back off the
    // stamped row) — the MAIL arm below keys on it (unit MAILFLAVOR).
    const wasAutoMerged = opts.wasAutoMerged === true && commitOid !== null;
    if (wasAutoMerged) {
      await stampAutoMergeCommit(c.env.DB, issue.id, commitOid);
    }
    // The scheduled auto merge's cleanup (services/pull/merge.go:827-837):
    // upstream's Merge reads GetScheduledMergeByPullID (computing wasAutoMerged
    // from it) and DeleteScheduledAutoMerge's the row inside the success
    // transaction — a direct merge raced or superseded a schedule, and the
    // landing clears it. The wasAutoMerged emission half is
    // markAsMergedPostProcess's notify dispatch (merge.go:403-407), and its
    // WEBHOOK arm is flavor-uniform: webhookNotifier.AutoMergePullRequest is a
    // pure redirect into MergePullRequest (services/webhook/notifier.go
    // :684-687 — same ToPayloadPullRequest payload @715 with HookIssueClosed
    // @718, same secret pipeline), so the merged webhook needs no stamp read —
    // the non-port record (unit TAILS2, 2026-11-04). The flavor split lives in
    // the non-webhook notifiers: the MAIL arm dispatches on wasAutoMerged
    // below (notify.go:148-156 ActionAutoMergePullRequest — landed,
    // services/mail/notify.ts's notifyAutoMergePullRequest) and the FEED arm
    // rides the consumer's own emit (ActionAutoMergePullRequest, feed/
    // notifier.go:279-289 — pull-automerge.ts); the actions notifier redirects
    // like the webhook, notifier.go:674-677. The delete is composed directly
    // over the table (the
    // service's deleteScheduledAutoMerge — automerge.go:98-100 — is the same
    // statement, but pull-automerge.ts imports THIS module, so reaching back
    // would invert the layer direction with a cycle). Idempotent with the
    // consumer's own delete (a scheduled landing deletes twice, once per
    // side). Best-effort like the arms beside it: the merge has already
    // landed, and the consumer's merged-PR arm tolerates a surviving row.
    try {
      await drizzle(c.env.DB).delete(pullAutoMerges).where(eq(pullAutoMerges.issueId, issue.id));
    } catch (error) {
      console.error(`[pull-engine] auto-merge schedule cleanup failed (issue ${issue.id}): ${error instanceof Error ? error.message : String(error)}`);
    }
    // The §13.4 merge arm (specs/email-outbound.md): upstream's Merge
    // handler stamps the PR's issue read for the merging doer BEFORE the
    // mergeability checks (routers/api/v1/repo/pull.go:909-914 —
    // `if ctx.IsSigned { SetIssueReadBy(ctx, pr.Issue.ID, ctx.Doer.ID) }`).
    // The arm rides the winning landing here (the route owns the checks,
    // routes stay service-free of the write per the fold precedent), so a
    // refused merge (405/409 before the service call) marks nothing where
    // upstream's mark already ran — the disclosed placement divergence;
    // the merger-consumed-the-thread semantics are the same. Both halves
    // stamp (carrier's setIssueReadBy: issue_user.is_read + the derived
    // mailbox's read_at_unix = now). Best-effort like the notify beside
    // it — a mark failure must not fail a landed merge.
    try {
      await setIssueReadBy(c.env.DB, issue.id, opts.doerId, opts.now);
    } catch (error) {
      console.error(`[pull-engine] merge mark-read failed (issue ${issue.id}): ${error instanceof Error ? error.message : String(error)}`);
    }
    await notifyMailMergePullRequest(c.env, mergedIssue, opts.doerId, pr.baseBranch, opts.now, wasAutoMerged);
    // The project-workflow arm (workflow_notifier.go:44-50): the merge's
    // MergePullRequest notification's workflow consumer — pull_request_merged
    // over the RELOADED closed issue (markAsMergedPostProcess's position,
    // merge.go:406). Best-effort past the landed merge: the port's reducer
    // logs per-action and never throws.
    try {
      await notifyMergePullRequestWorkflow(c.env.DB, { issue: mergedIssue, doerId: opts.doerId, now: opts.now, mailEnv: c.env });
    } catch (error) {
      console.error(`[pull-engine] project workflow notify failed (issue ${issue.id}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { commitOid };
}

/**
 * The emit site's best-effort wrapper — loads the merger (upstream passes
 * the `merger` user to markAsMergedPostProcess, merge.go:863) and hands the
 * arm to the notify hub with the computed wasAutoMerged flavor: the
 * scheduled automerge's landing fires the AutoMergePullRequest receiver
 * (services/mailer/notify.go:148-156 — the ForceDoerNotification flavor,
 * mail_issue.go:185), the manual merge keeps MergePullRequest (:138-146),
 * exactly markAsMergedPostProcess's dispatch (merge.go:403-407). Failures
 * log; the merge stays committed.
 */
async function notifyMailMergePullRequest(
  env: ApiEnv["Bindings"],
  issue: IssueRow,
  doerId: number,
  baseBranch: string,
  now: Date,
  wasAutoMerged: boolean,
): Promise<void> {
  try {
    const doer = (await drizzle(env.DB).select().from(users).where(eq(users.id, doerId)).get()) ?? null;
    if (doer === null) {
      console.error(`[pull-engine] merge notify skipped: doer row missing [id: ${doerId}]`);
      return;
    }
    const outcome = wasAutoMerged
      ? await notifyAutoMergePullRequest(env, { issue, doer, baseBranch }, { now })
      : await notifyMergePullRequest(env, { issue, doer, baseBranch }, { now });
    if (outcome.outcome === "enqueued" && outcome.enqueue.some((e) => e.outcome === "pending-unqueued")) {
      console.warn(`[pull-engine] merge notify: some rows stayed pending-unqueued (issue ${issue.id})`);
    }
  } catch (error) {
    console.error(`[pull-engine] merge notify failed (issue ${issue.id}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * POST /merge-upstream's service (repo_service.MergeUpstream,
 * services/repository/merge_upstream.go:22-100): sync a FORK's branch with
 * its base. The gate ladder in upstream order — the write gate (the route's
 * reqRepoWriter(TypeCode) middleware, 403 "user should have a permission to
 * write to a repo"), the base-code read gate (:32-41 — a fork created while
 * the base was public must not keep pulling after it turned private; 403
 * "permission denied to read base repo %d"), the fork gate (400 "repo is not
 * a fork"), the branch resolution (GetUpstreamDivergingInfo :102-133: the
 * fork branch must exist — 404 ErrBranchNotExist's render with the upstream
 * MISSING-COMMA verbatim, models/git/branch.go:50 "branch does not exist
 * [repo_id: %d name: %s]"; the base-side name is the fork's own branch when
 * the base has it, else the base's default branch), then the three styles:
 * "up-to-date" (the base tip is already an ancestor), "fast-forward" (the
 * base→fork push lands — upstream PushManaged's ff move), and "merge" (the
 * diverged fall-through: upstream fakes a REVERSE PR — pull.Update's
 * reversePR swap, services/pull/update.go:96-107 — and merges the base INTO
 * the fork branch with the verbatim message "merge upstream"; ff_only
 * refuses the fall-through with 400 "fast-forward merge not possible:
 * branch has diverged"). Conflict/unrelated answers 409 (the route's
 * IsErrMergeConflicts / IsErrMergeUnrelatedHistories arms).
 *
 * Adaptations (documented, the platform's shape): upstream pushes FROM the
 * base repo INTO the fork (PushManaged); our fork cells are full object
 * copies (SPEC-0001b §5.2) so the base history is already in the fork's
 * cell and the FF move / reverse merge execute THERE — executeMerge with
 * the fork branch as the CAS'd base ref and the base tip as the head oid
 * (fast-forward-only for the ff arm, merge for the reverse-PR arm). The
 * ancestry probe (BaseBranchHasNewCommits, GetBranchDivergingInfo's
 * has-previous-commit arm) computes the same way — mergeBase in the fork
 * cell. Upstream's push webhooks for the moved fork branch ride the push
 * pipeline (notifier fan-out on the receive path); the API write here moves
 * the ref through the engine's CAS landing, which carries none — the same
 * posture as every engine-driven merge.
 */
export async function mergeUpstream(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  input: { branch: string; ffOnly: boolean },
): Promise<{ mergeStyle: "up-to-date" | "fast-forward" | "merge" }> {
  // reqRepoWriter(TypeCode) (api.go:1314 → :392-400): the write gate —
  // "user should have a permission to write to a repo".
  if (!(await canWriteRepository(c, pair))) {
    throw new ApiError(403, "user should have a permission to write to a repo");
  }
  if (pair.repo.forkParent === null) {
    // GetUpstreamDivergingInfo's fork gate (:107-109): InvalidArgument —
    // "repo is not a fork" — the route maps to 400.
    throw new ApiError(400, "repo is not a fork");
  }
  const basePair = await findRepositoryById(c.env.DB, pair.repo.forkParent);
  if (basePair === null) {
    // The fork edge dangles (the source was deleted): upstream's GetBaseRepo
    // fails ErrRepoNotExist — the route's unmapped arm answers 500.
    throw new ApiError(500, `base repository does not exist [id: ${pair.repo.forkParent}]`);
  }

  // The base-code read gate (:32-41): GetDoerRepoPermission(baseRepo,
  // doer).CanRead(TypeCode) — a PUBLIC base reads for any doer (the
  // visibility matrix), a private one needs the grant.
  const doer = c.get("authUser");
  const doerId = doer?.id ?? null;
  const canReadBase = doerId !== null && (canViewRepository(viewerOf(c), basePair.repo) || (await doerRepoAccessMode(c.env.DB, basePair.repo, doerId)) !== "none");
  if (!canReadBase) {
    throw new ApiError(403, `permission denied to read base repo ${basePair.repo.id}`);
  }

  const forkCell = engineCell(c.env, pair.repo);
  const baseCellReads = engineReads(c.env, basePair.repo);
  const forkReads = engineReads(c.env, pair.repo);

  // The branch resolution (:111-133): the FORK branch must exist (the head
  // side resolves FIRST — GetBranchDivergingInfo :763-765 — so its miss is
  // the 404 the route answers).
  const forkTip = refTipMap(await forkReads.listRefs()).get(branchRef(input.branch))?.target;
  if (forkTip === undefined) {
    throw new ApiError(404, `branch does not exist [repo_id: ${pair.repo.id} name: ${input.branch}]`);
  }
  // The BASE-side name: the fork's own branch when the base has it ("Do the
  // best to follow the GitHub's behavior", :120-124), else the base's
  // default branch; a default-branch miss is the second GetBranchExisting's
  // ErrBranchNotExist — 404 with the base repo's id + name.
  const baseTipMap = refTipMap(await baseCellReads.listRefs());
  let baseBranchName = input.branch;
  let baseTip = baseTipMap.get(branchRef(input.branch))?.target;
  if (baseTip === undefined) {
    baseBranchName = basePair.repo.defaultBranch;
    baseTip = baseTipMap.get(branchRef(baseBranchName))?.target;
    if (baseTip === undefined) {
      throw new ApiError(404, `branch does not exist [repo_id: ${basePair.repo.id} name: ${baseBranchName}]`);
    }
  }

  // The base fetch (the pr-create arm's FetchRemoteTempCommit posture,
  // compare.go:73-80): when the base advanced past the fork point its tip
  // (and the commits beyond the fork point) are absent from the fork cell —
  // carry the closure in, OBJECTS ONLY no ref, so the ancestry walk and the
  // merges below resolve. Idempotent (putApiObjects no-ops on known oids).
  if ((await forkCell.readCommit(baseTip)) === null) {
    await carryLooseRefs(
      carrySource(c.env, basePair.repo),
      carryTarget(c.env, pair.repo),
      [{ name: branchRef(baseBranchName), target: baseTip }],
      null,
      await packedCatalogOids(carrySource(c.env, pair.repo)),
      `${basePair.repo.ownerNamespace}/${basePair.repo.slug} -> ${pair.repo.ownerNamespace}/${pair.repo.slug} (merge-upstream base fetch)`,
    );
  }

  // BaseBranchHasNewCommits (GetBranchDivergingInfo :767-814's
  // has-previous-commit tail): the base tip is NOT an ancestor of the fork
  // tip. Equal tips and a behind fork answer "up-to-date" (:44-46). An
  // unresolvable merge base (unrelated histories) counts as new base
  // commits — the diverged walk below answers its own 409.
  const ancestry = await forkCell.mergeBase(baseTip, forkTip);
  const baseHasNewCommits = !(ancestry.tag === "ok" && ancestry.base === baseTip);
  if (!baseHasNewCommits) {
    return { mergeStyle: "up-to-date" };
  }

  const person = mergePerson(c, new Date());

  // The ff attempt (:48-56): the base→fork push with normal (non-forced)
  // semantics — a non-descendant base tip is the PushOutOfDate rejection.
  // Our CAS landing: fast-forward-only moves the fork branch onto the base
  // tip; not_fast_forward / ref_conflict / unrelated all fall through to
  // the reverse-merge arm, upstream's out-of-date/rejected fall-through
  // (:58-70).
  const ff = await forkCell.executeMerge({
    style: "fast-forward-only",
    base: branchRef(input.branch),
    head: baseTip,
    expectedBaseOid: forkTip,
    message: "",
    author: person,
    committer: person,
    extraRefUpdates: [],
  });
  if (ff.tag === "committed") {
    return { mergeStyle: "fast-forward" };
  }

  // The ff_only refusal (:62-65): InvalidArgument — "fast-forward merge not
  // possible: branch has diverged" — 400.
  if (input.ffOnly) {
    throw new ApiError(400, "fast-forward merge not possible: branch has diverged");
  }

  // The reverse-PR merge (:67-97): pull.Update's fake-PR swap (update.go:
  // 96-107) merges the BASE branch INTO the fork branch with the verbatim
  // message "merge upstream". Conflicts and unrelated histories are the
  // route's 409 family (IsErrMergeConflicts / IsErrMergeUnrelatedHistories);
  // the upstream renders embed raw git output our engine doesn't capture,
  // so the texts carry the condition prefix with our engine's detail.
  const merged = await forkCell.executeMerge({
    style: "merge",
    base: branchRef(input.branch),
    head: baseTip,
    expectedBaseOid: forkTip,
    message: "merge upstream",
    author: person,
    committer: person,
    extraRefUpdates: [],
  });
  if (merged.tag === "committed") {
    return { mergeStyle: "merge" };
  }
  if (merged.tag === "conflict") {
    throw new ApiError(409, `Merge Conflict Error: ${merged.conflictedFiles.join(", ")}`);
  }
  if (merged.tag === "nothing_to_merge" && merged.status === "unrelated") {
    throw new ApiError(409, "Merge UnrelatedHistories Error: unrelated histories");
  }
  throw executeMergeError(merged);
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

// ---------------------------------------------------------------------------
// The pull merge-box web write arms (the merge-box census's POST family): the
// §3.4-family services the API merge route does not carry — the update-branch
// execution (services/pull/update.go Update), the standalone post-merge
// cleanup (services/repository/branch.go DeleteBranchAfterMerge — the web
// CleanUpPullRequest arm's service) and the target-branch retarget
// (services/pull/pull.go ChangeTargetBranch). The UI merge-box module
// (ui/pages/pull-merge-box.tsx) owns the handler ladders — permission gates,
// form mapping, outcome mapping — over these seams, exactly like the API
// merge route owns its ladder over mergePullRequest above.
// ---------------------------------------------------------------------------

/**
 * Update the PR's head branch with the base branch (services/pull/update.go
 * Update, :24-99): style merge lands the reverse-PR merge commit (base =
 * the HEAD branch — the ref that MOVES — head = the BASE branch, exactly the
 * FakePR swap at :77-90); style rebase replays the head onto the base tip and
 * fast-forwards (updateHeadByRebaseOnToBase, §4.5's choreography). The row
 * then CAS-resets to `checking` with mergeBase/conflicts cleared — upstream
 * re-checks mergeability inline through the post-web-operation task
 * (addTestPullRequestTaskAfterWebOperation, :69); ours delegates to the lazy
 * check the next GET runs (§3.4's self-healing posture, the same reset the
 * target-branch retarget below takes).
 *
 * Same-repo heads ONLY: a fork head's cell carries the base branch as a
 * FORK-POINT SNAPSHOT (SPEC-0001b §5.2 replication), so merging it would
 * silently drop the base's newer commits — the cross-cell live fetch upstream
 * runs (it fetches pr.BaseRepo into the head repo) has no landed primitive,
 * and a wrong-content merge is worse than a refusal (ApiError 405; the UI
 * render gates the arm to same-repo heads).
 *
 * Refusals, upstream order: AGit flow → the unsupported error (500, the
 * update.go:26-29 TODO); the pull ref unresolvable or behind == 0 → 405
 * ("HeadBranch of PR N is up to date", update.go:44-51 — the handler renders
 * it a flash error); missing head/base branch → 405 (the merge route's own
 * text). Ref CAS races surface through executeMerge's tags
 * (conflict / not_fast_forward / ref_conflict — executeMergeError).
 */
export async function updatePullRequestBranch(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  pr: PullRequestRow,
  opts: { style: "merge" | "rebase"; message: string; now: Date },
): Promise<{ headTip: string }> {
  if (pr.flow !== PRFlow.Github) {
    throw new ApiError(500, "update of agit flow pull request's head branch is unsupported");
  }
  if (pr.headRepoId !== pair.repo.id) {
    throw new ApiError(405, "fork head update requires the cross-cell base fetch (not landed)");
  }
  const cell = engineCell(c.env, pair.repo);
  const reads = engineReads(c.env, pair.repo);
  const headBranchRef = branchRef(pr.headBranch);
  const baseBranchRef = branchRef(pr.baseBranch);
  const tips = refTipMap(await reads.listRefs());
  const headTip = tips.get(headBranchRef)?.target;
  const baseTip = tips.get(baseBranchRef)?.target;
  if (headTip === undefined) {
    throw new ApiError(405, `head branch is missing [name: ${pr.headBranch}]`);
  }
  if (baseTip === undefined) {
    throw new ApiError(405, `base branch is missing [name: ${pr.baseBranch}]`);
  }
  // GetDiverging(base, refs/pull/N/head).Behind == 0 → up to date (:44-51);
  // the ref's absence is the same refusal class (the PR head never landed).
  const divergence = await cell.countDivergence(baseBranchRef, pullHeadRef(pr.index));
  if (divergence.tag !== "ok") {
    throw new ApiError(405, `pull head ref is missing [ref: ${pullHeadRef(pr.index)}]`);
  }
  if (divergence.behind === 0) {
    throw new ApiError(405, `HeadBranch of PR ${pr.index} is up to date`);
  }

  let newTip: string;
  if (opts.style === "rebase") {
    const replay: RebaseOutcome = await cell.rebaseOnto({ head: headBranchRef, onto: baseTip, committer: mergePerson(c, opts.now) });
    if (replay.tag !== "rebased") {
      throw new ApiError(
        405,
        replay.tag === "conflict" ? "rebase would conflict" : replay.tag === "too_many" ? `too many commits to rebase [count: ${replay.count}]` : replay.tag,
      );
    }
    const stored = await cell.putRebaseObjects(replay.objects);
    if (stored.tag !== "ok") {
      throw new ApiError(405, stored.tag === "invalid" ? stored.reason : "rebase too large");
    }
    const ff = await cell.executeMerge({
      style: "fast-forward-only",
      base: headBranchRef,
      head: replay.headOid,
      expectedBaseOid: headTip,
      message: "",
      author: mergePerson(c, opts.now),
      committer: mergePerson(c, opts.now),
      extraRefUpdates: [],
    });
    if (ff.tag !== "committed") throw executeMergeError(ff);
    newTip = ff.commitOid;
  } else {
    const result = await cell.executeMerge({
      style: "merge",
      base: headBranchRef,
      head: baseBranchRef,
      expectedBaseOid: headTip,
      message: opts.message,
      author: mergePerson(c, opts.now),
      committer: mergePerson(c, opts.now),
      extraRefUpdates: [],
    });
    if (result.tag !== "committed") throw executeMergeError(result);
    newTip = result.commitOid;
  }

  // UpdateColsIfNotMerged over the reset (§3.4's CAS guard): a racing merge
  // wins over a late branch update.
  await drizzle(c.env.DB)
    .update(pullRequests)
    .set({ status: PRStatus.Checking, mergeBase: null, conflictedFiles: null, headSha: newTip })
    .where(and(eq(pullRequests.id, pr.id), eq(pullRequests.hasMerged, false)));
  return { headTip: newTip };
}

/**
 * The web cleanup's service — DeleteBranchAfterMerge (services/repository/
 * branch.go:808-884) with the CanDeleteBranch ladder (the default arm, the
 * head-repo write arm and the protected-rule arm, :561-584 — the same
 * predicates the embedded merge-time delete above ports) and the
 * tip-equality gate (:866-873, "the branch has no new commits after
 * merging": refs/pull/N/head in the BASE cell must still point at the head
 * branch's tip in the HEAD cell). Outcome classes map onto
 * deleteBranchAfterMergeAndFlashMessage (routers/web/repo/pull.go:1233-1253):
 * "skipped" = the silently-ignored permission/not-exist arms; "failed" = the
 * flash-error arms (deletion_failed / delete_branch_has_new_commits — the
 * locale texts verbatim, the flash's only content); "deleted" = the success
 * flash. The delete-branch system comment (AddDeletePRBranchComment, the
 * landed type-11 push-cascade twin, services/webhooks-push.ts:1002-1016)
 * rides success — best-effort like upstream ("intentionally ignore the
 * following error", branch.go:877-881). The RefDelete webhook stays deferred
 * with the embedded arm's tier-2 surface (the same skip-not-error posture).
 */
export type DeleteBranchAfterMergeOutcome =
  | { outcome: "deleted"; fullBranchName: string }
  | { outcome: "skipped"; fullBranchName: string }
  | { outcome: "failed"; fullBranchName: string; message: string };

const deletionFailedMessage = (fullBranchName: string): string => `Failed to delete branch "${fullBranchName}".`;

export async function deleteBranchAfterMerge(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  pr: PullRequestRow,
  opts: { doerId: number; now: Date },
): Promise<DeleteBranchAfterMergeOutcome> {
  const headPair = await findRepositoryById(c.env.DB, pr.headRepoId);
  // Deleted fork → ErrNotExist wrapped (branch.go:822-825) → the flash
  // helper's silent skip (pull.go:1237-1240).
  if (headPair === null) {
    return { outcome: "skipped", fullBranchName: `(deleted-repo):${pr.headBranch}` };
  }
  const fullBranchName = `${headPair.repo.ownerNamespace}/${headPair.repo.slug}:${pr.headBranch}`;
  // "Don't clean up unmerged and unclosed PRs and agit PRs" (:839-842) — an
  // unprocessable → deletion_failed flash.
  if (!pr.hasMerged && !issue.isClosed && pr.flow !== PRFlow.Github) {
    return { outcome: "failed", fullBranchName, message: deletionFailedMessage(fullBranchName) };
  }
  // "Don't clean up when there are other PR's that use this branch as head
  // branch" (:844-849) — the shared-head probe above, exclusion aside.
  if (await hasUnmergedPullRequestsByHeadInfo(c.env.DB, pr.headRepoId, pr.headBranch, issue.id)) {
    return { outcome: "failed", fullBranchName, message: deletionFailedMessage(fullBranchName) };
  }
  // CanDeleteBranch's ladder (:561-584): the default/target arm, the write
  // arm, the protected-rule arm — every refusal the deletion_failed flash
  // (the permission class of the silent skip is unreachable here: the button
  // only renders for viewers who passed the same ladder).
  if (pr.headBranch === headPair.repo.defaultBranch) {
    return { outcome: "failed", fullBranchName, message: deletionFailedMessage(fullBranchName) };
  }
  const doerRow = (await drizzle(c.env.DB).select().from(users).where(eq(users.id, opts.doerId)).get()) ?? null;
  const access = await principalAccessOf(c.env.DB, headPair.repo, doerRow === null ? null : { id: doerRow.id, login: doerRow.username, is_admin: doerRow.isAdmin });
  if (!access.write) {
    return { outcome: "failed", fullBranchName, message: deletionFailedMessage(fullBranchName) };
  }
  const rule = await findRule(c.env.DB, headPair.repo.id, pr.headBranch);
  if (rule !== null && !(await canUserDelete(c.env.DB, parseRuleConfig(rule.rules), access))) {
    return { outcome: "failed", fullBranchName, message: deletionFailedMessage(fullBranchName) };
  }
  // The tip-equality gate (:866-873): the PR's internal ref must still point
  // at the head branch tip — a post-merge push refuses with the
  // has_new_commits flash.
  const pullTip = refTipMap(await engineReads(c.env, pair.repo).listRefs()).get(pullHeadRef(pr.index))?.target;
  const branchTip = refTipMap(await engineReads(c.env, headPair.repo).listRefs()).get(branchRef(pr.headBranch))?.target;
  if (pullTip === undefined || branchTip === undefined || pullTip !== branchTip) {
    return {
      outcome: "failed",
      fullBranchName,
      message: `Branch "${fullBranchName}" cannot be deleted because new commits have been added after merging.`,
    };
  }
  const result = await engineCell(c.env, headPair.repo).deleteApiRef({ ref: branchRef(pr.headBranch), expectedOid: branchTip });
  if (result.tag !== "deleted") {
    return { outcome: "failed", fullBranchName, message: deletionFailedMessage(fullBranchName) };
  }
  try {
    await drizzle(c.env.DB).batch([
      drizzle(c.env.DB).insert(comments).values({
        type: CommentType.DeleteBranch,
        posterId: opts.doerId,
        issueId: issue.id,
        oldRef: pr.headBranch,
        createdAt: opts.now,
      }),
      drizzle(c.env.DB)
        .update(issues)
        .set({ numComments: sql`num_comments + 1`, updatedAt: opts.now })
        .where(eq(issues.id, issue.id)),
    ]);
  } catch (error) {
    console.error(`[pull-engine] delete-branch comment failed (issue ${issue.id}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return { outcome: "deleted", fullBranchName };
}

/**
 * Change a pull request's target branch (services/pull/pull.go
 * ChangeTargetBranch, :226-358): the five refusals in upstream order (the
 * no-op same-branch return, the closed arm, the merged arm, the missing
 * target, the branches-equal arm), the duplicate-open-PR arm, then the CAS
 * landing over UpdateColsIfNotMerged's columns followed by the in-transaction
 * tail (RecalculateReviewsOfficial → the type-25 ChangeTargetBranch comment →
 * the push-comments delete/recreate). The mergeability re-check upstream runs
 * inline (checkPullRequestBranchMergeable) delegates here to the lazy check:
 * the row CAS-resets to `checking` with mergeBase/conflicts cleared and the
 * next GET rewrites status/conflicts/divergence/mergeBase (§3.4 — the PR is
 * CREATED as `checking`; a retarget is the same re-derivation). The
 * branches-equal comparison rides the BASE cell (the pull ref is the landed
 * projection of the fork head — carryForkHeadIntoBase), so the cross-repo
 * compare stays same-cell like every PR read (§10.8).
 *
 * Error flavors (`errorFlavor`): the SAME upstream refusals render through
 * two mappers — the WEB merge-box flash texts (the landed `web` default,
 * pull-merge-box.tsx's error-message relay) and the API route's ladder
 * (pull.go:757-770: ErrPullRequestAlreadyExists→409, ErrIssueIsClosed→422,
 * ErrPullRequestHasMerged→409, everything else — ErrBranchesEqual, the
 * ErrBranchNotExist re-check, the CAS `pull request status has changed` —
 * unmapped → APIErrorInternal 500 with err.Error(), the model renders
 * verbatim including the `%sm` branches-equal typo,
 * models/git/branch.go:95-97).
 *
 * The doer-carrying tail (`doerId`): upstream's tail runs INSIDE the service
 * unconditionally (CreateComment needs the Doer). The landed web caller
 * predates the tail (pull-merge-box.tsx passes no doer — its posture keeps
 * the HEAD behavior until the web wave picks the doer up); the API route
 * passes the doer and gets the full upstream tail. Non-transactional here —
 * the same documented posture as the create arms.
 */
export async function changePullRequestTargetBranch(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  pr: PullRequestRow,
  input: { targetBranch: string; now: Date; errorFlavor?: "web" | "api"; doerId?: number },
): Promise<{ baseBranch: string }> {
  const flavor = input.errorFlavor ?? "web";
  // "Current target branch is already the same" (:234-236) — the no-op.
  if (pr.baseBranch === input.targetBranch) {
    return { baseBranch: pr.baseBranch };
  }
  if (issue.isClosed) {
    // ErrIssueIsClosed (:240-247; the render is ErrIssueIsClosed.Error —
    // "Pull Request [id, repo_id, index] is already closed"): web 409 flash
    // / API ladder 422 err.Error().
    throw flavor === "api"
      ? new ApiError(422, `Pull Request [id: ${issue.id}, repo_id: ${issue.repoId}, index: ${issue.index}] is already closed`)
      : new ApiError(409, "The pull request has been closed.");
  }
  if (pr.hasMerged) {
    // ErrPullRequestHasMerged (:249-256; services/pull/pull.go:204-223's
    // render — unreachable through the API route, whose gate skips merged
    // silently, kept for the service's own parity).
    const mergedRender = `pull request has merged [id: ${pr.id}, issue_id: ${pr.index}, head_repo_id: ${pr.headRepoId}, base_repo_id: ${pr.baseRepoId}, head_branch: ${pr.headBranch}, base_branch: ${pr.baseBranch}]`;
    throw flavor === "api"
      ? new ApiError(409, mergedRender)
      : new ApiError(409, "Failed: The pull request has been merged. You cannot merge again or change the target branch.");
  }
  const reads = engineReads(c.env, pair.repo);
  const tips = refTipMap(await reads.listRefs());
  const targetTip = tips.get(branchRef(input.targetBranch))?.target;
  if (targetTip === undefined) {
    // ErrBranchNotExist (:258-263) — the API route's probe answers 404
    // before the service, so this arm is the web box's own render plus the
    // API ladder's unmapped 500 (err.Error(), models/git/branch.go's
    // "branch does not exist [repo_id: %d name: %s]" — upstream's missing
    // comma verbatim).
    throw flavor === "api"
      ? new ApiError(500, `branch does not exist [repo_id: ${pair.repo.id} name: ${input.targetBranch}]`)
      : new ApiError(400, "Target branch does not exist.");
  }
  // IsHeadEqualWithBranch → ErrBranchesEqual (:261-268): the head tip (the
  // pull ref) equals the target tip — the retarget changes nothing.
  const headTip = tips.get(pullHeadRef(pr.index))?.target;
  if (headTip !== undefined && headTip === targetTip) {
    // The API ladder has NO ErrBranchesEqual arm → APIErrorInternal 500 with
    // err.Error() — models/git/branch.go:95-97's `%sm` typo verbatim (the
    // literal "m" rides the head branch name). The web box answers the
    // compare-view no-differences flash.
    throw flavor === "api"
      ? new ApiError(500, `branches are equal [head: ${pr.headBranch}m base: ${input.targetBranch}]`)
      : new ApiError(400, "There are no differences to show. There is no need to create a pull request.");
  }
  // GetUnmergedPullRequest duplicate (:270-282): an open unmerged Github-flow
  // PR already spans head → target. The API ladder maps
  // ErrPullRequestAlreadyExists → 409 err.Error() (models/issues/pull.go's
  // "pull request already exists for these targets [...]" render); the web
  // flash strips the link to text.
  const duplicate = await drizzle(c.env.DB)
    .select({
      id: pullRequests.id,
      index: pullRequests.index,
      headRepoId: pullRequests.headRepoId,
      baseRepoId: pullRequests.baseRepoId,
      headBranch: pullRequests.headBranch,
      baseBranch: pullRequests.baseBranch,
    })
    .from(pullRequests)
    .innerJoin(issues, eq(issues.id, pullRequests.issueId))
    .where(
      and(
        eq(pullRequests.headRepoId, pr.headRepoId),
        eq(pullRequests.headBranch, pr.headBranch),
        eq(pullRequests.baseRepoId, pr.baseRepoId),
        eq(pullRequests.baseBranch, input.targetBranch),
        eq(pullRequests.hasMerged, false),
        eq(issues.isClosed, false),
        eq(pullRequests.flow, PRFlow.Github),
        ne(pullRequests.issueId, issue.id),
      ),
    )
    .limit(1)
    .all();
  if (duplicate.length > 0) {
    const dup = duplicate[0]!;
    throw flavor === "api"
      ? new ApiError(
          409,
          `pull request already exists for these targets [id: ${dup.id}, issue_id: ${dup.index}, head_repo_id: ${dup.headRepoId}, base_repo_id: ${dup.baseRepoId}, head_branch: ${dup.headBranch}, base_branch: ${dup.baseBranch}]`,
        )
      : new ApiError(
          409,
          `A pull request between these branches already exists: ${pair.repo.ownerNamespace}/${pair.repo.slug}#${dup.index}`,
        );
  }
  const updated = await drizzle(c.env.DB)
    .update(pullRequests)
    .set({ baseBranch: input.targetBranch, status: PRStatus.Checking, mergeBase: null, conflictedFiles: null })
    .where(and(eq(pullRequests.id, pr.id), eq(pullRequests.hasMerged, false)))
    .returning({ id: pullRequests.id });
  if (updated.length === 0) {
    // Lost the UpdateColsIfNotMerged race — the PR merged in between.
    // Upstream answers `util.ErrorWrap(util.ErrInvalidArgument, "pull
    // request status has changed")` (:296-299) — the API ladder's unmapped
    // 500 err.Error(); the web flash reuses its merged refusal.
    throw flavor === "api"
      ? new ApiError(500, "pull request status has changed")
      : new ApiError(409, "Failed: The pull request has been merged. You cannot merge again or change the target branch.");
  }

  // The doer-carrying tail — upstream's post-CAS in-tx order (:331-358):
  // syncCommitDivergence (ours is the lazy `checking` reset above) →
  // RecalculateReviewsOfficial → the type-25 ChangeTargetBranch comment →
  // the push-comments delete/recreate.
  if (input.doerId !== undefined) {
    // RecalculateReviewsOfficial (models/issues/review.go:332-368): the
    // official flags were computed against the OLD base's protection rules —
    // "Otherwise a stale official approval could bypass the new branch's
    // protection" (:327-330).
    const reviews = new PullReviewsService(c.env.DB, c.env);
    await reviews.recalculateReviewsOfficial(pair, issue.id, input.targetBranch);

    // The type-25 ChangeTargetBranch comment (CreateComment, :332-351) with
    // oldRef/newRef — NO num_comments bump (updateCommentInfos counts only
    // ConversationCountedCommentType = comment/review, comment.go:209-211)
    // but the issue's updated_unix rides.
    await drizzle(c.env.DB).batch([
      drizzle(c.env.DB).insert(comments).values({
        type: CommentType.ChangeTargetBranch,
        posterId: input.doerId,
        issueId: issue.id,
        oldRef: pr.baseBranch,
        newRef: input.targetBranch,
        content: "",
        createdAt: input.now,
        updatedAt: input.now,
      }),
      drizzle(c.env.DB).update(issues).set({ updatedAt: input.now }).where(eq(issues.id, issue.id)),
    ] as const);

    // The push-comments refresh (:353-358): delete every type-29
    // PullRequestPush comment of the issue (they describe the OLD base's
    // ranges), then recreate the NEW range's first-push comment —
    // CreatePushPullComment(doer, pr, refs/heads/<newBase>,
    // refs/pull/N/head, false), comment.go:95+ — whose normal-push arm
    // walks baseTip..headTip newest-capped and stays SILENT on an empty
    // range (comment.go:43-45's shouldCreate=false). The walk rides the
    // BASE cell (the pull ref is its landed projection, §10.8).
    await drizzle(c.env.DB)
      .delete(comments)
      .where(and(eq(comments.issueId, issue.id), eq(comments.type, CommentType.PullRequestPush)))
      .run();
    const range = await reads.listCommitsRange(targetTip, pullHeadRef(pr.index), RETARGET_PUSH_COMMITS_CAP, 0);
    if (range !== null && range.commits.length > 0) {
      const commitIds = range.commits.map((commit) => commit.oid);
      await drizzle(c.env.DB).insert(comments).values({
        type: CommentType.PullRequestPush,
        posterId: input.doerId,
        issueId: issue.id,
        content: JSON.stringify({ is_force_push: false, commit_ids: commitIds } satisfies RetargetPushActionContent),
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
  }
  return { baseBranch: input.targetBranch };
}

/** `maxPushCommitsInCommentCount` (services/pull/comment.go:19) — the type-29
 *  recreate's commit cap. Kept local (webhooks-push exports the same 1000 but
 *  imports THIS module — the back-edge would cycle). */
const RETARGET_PUSH_COMMITS_CAP = 1000;

/** Upstream `PushActionContent` (models/issues/comment.go:375-381) — the
 *  type-29 comment's content JSON (the webhooks-push writer's shape). */
interface RetargetPushActionContent {
  is_force_push: boolean;
  commit_ids: string[];
}

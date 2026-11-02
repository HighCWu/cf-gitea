/**
 * The pull merge box fragment — bench tick-10 row 4 (TWO-STAGE: module only,
 * the route is a later index.ts window), upstream
 *
 *   GET /{owner}/{repo}/pulls/{index}/merge_box   web.go:1659
 *                                 → repo.ViewPullMergeBox (issue_view.go:459-489)
 *                                 → ctx.HTML(tplPullMergeBox)
 *                                 — templates/repo/issue/view_content/pull_merge_box.tmpl
 *
 * — the `.timeline-item.comment.pull-merge-box` card the conversation page's
 * timeline carries and the official bundle REFRESHES on a timer while checks
 * run (`data-global-init="initRepoPullMergeBox"` +
 * `data-pull-merge-box-reloading-interval` + `data-pull-link`): the full
 * mergeability surface the wave-3 issue-detail page renders as its one-line
 * reduction. The loader projects the LANDED merge state — the `pull_requests`
 * row (status/conflicts/divergence per §3.4), the branch-protection service's
 * merge-gate helpers (the same ports the POST /api/v1 merge route enforces),
 * the commit-status store and the review rows — into the template's data
 * shape; the render emits the template's DOM arm-for-arm over what that state
 * answers.
 *
 * ## The upstream handler, knob by knob (issue_view.go:459-489 + 878-1042)
 *
 * - the route hangs off `m.Group("/{type:pulls}/{index}")` AFTER the issue
 *   row loads (`prepareIssueViewLoad`): a non-pull row is `ctx.NotFound` —
 *   the loader answers null and the route-stage handler 404-shells;
 * - `ShowMergeBox = !pull.HasMerged || data.IsPullBranchDeletable` (the
 *   template's own gate): upstream keeps the merged box ONLY to offer the
 *   delete-branch button (`POST /{index}/cleanup` — LANDED at 20f7290's
 *   write-tails fold, the cleanup arm below); the pre-fold reduction (the
 *   button dead ⇒ the loader answered null for EVERY merged PR) is retired —
 *   the merged arm now computes the deletable pair ("there is nothing to
 *   do", issue_view.go:971-974, is the null arm only for the
 *   non-deletable merged row) and the box renders for merged rows too;
 * - `PullMergeBoxReloading`/`ReloadingInterval`: `pull.IsChecking()` → the
 *   parent view's reload marker + the fragment's 5000 ms polling interval
 *   (issue_view.go:486 + 953-956); ours keys on the D1 row alone
 *   (`status = Checking`) — the commit-status pending half of upstream's
 *   `needRefreshMergeBox` has no landed writer that would ever flip it back;
 * - `prepareMergeBoxInfoItems` + `prepareMergeBoxProtectionChecks` +
 *   `prepareMergeBoxIconColor` (pull_merge_box.go): ported arm-for-arm over
 *   the landed sources — the reducer's comments carry each arm; closed PRs
 *   take prepareMergeBoxInfoItems' early return (the ClosedInfo pair INSTEAD
 *   of every blocker/prompt section) and skip the status section
 *   (prepareMergeBoxStatusCheckData's IsClosed early return, pull.go:400-402);
 * - `prepareMergeBoxStatusCheckData` (pull.go:397-495): the status section
 *   loads for OPEN PRs with a resolvable head sha regardless of protection
 *   (`ShowStatusCheck = enableStatusCheck || hasRequiredStatusContexts ||
 *   len(statuses) > 0`); with `enableStatusCheck || hasRequiredStatusContexts`
 *   the failed/missing required checks land as protection-blocker error items
 *   (pull.go:487-493) and fold into `hasOverridableBlockers`.
 *
 * ## Documented divergences (no landed source — honest reductions, §6)
 *
 * - THE MERGE FORM (the `$data.MergeFormProps` Vue island div
 *   `#pull-request-merge-form[data-merge-form-props]`) renders as the no-JS
 *   form with upstream's field names since the write arms landed (the
 *   write-arm section below); the ISLAND itself stays unrendered — (a) the
 *   island payload rides upstream's pageData, which our shell emits as null
 *   (the issue-detail reduction's cite, verbatim); (b) the merge-style
 *   allowlist/default rides the PR-unit config's D1 home (the repo_units
 *   config store — pullRequestsConfigFromJson; the early config-defaults
 *   reduction predates that home and is retired); (c) the style dropdown is
 *   the pull-reviews select reduction (the Vue menu is JS-only). The
 *   message PREFILLS ride the SELECTED style (the no-JS render shows one
 *   style's fields; the Vue swaps per selection): the title is S2's
 *   composeMergeMessage re-issue, the BODY (landed with this module's
 *   squash-prefill arm) is upstream's composition —
 *   `CommitMessageMerge(GetSquashMergeCommitMessages(pr),
 *   GetDefaultMergeMessage(squash).body)` for squash (pull_merge_form.go:
 *   145), the bare Reviewed-on block for merge/rebase-merge (:122/:137).
 *   Two disclosed degradations ride the body: the commit walk needs the
 *   optional `reads` seam (absent → the Reviewed-on-only body — upstream's
 *   own GetDefaultMergeMessage error arm), and ranges past the
 *   MERGE_MESSAGE_COMMITS_WALK_CEILING (1000 commits) keep the oldest-first
 *   page where upstream's rev-list streams and keeps the newest 50 (the
 *   ceiling bounds the materialization; the engine walk's own budget is
 *   50k). The >50 window itself is exact since the walk-ceiling fix: the
 *   read takes the whole in-range set oldest-first and slices the NEWEST
 *   MERGE_MESSAGE_COMMITS_LIMIT window (upstream rev-list --max-count 50,
 *   pull.go:759-761). The `.gitea/default_merge_message/*.md` template
 *   resolution upstream runs first (merge.go:116-122) landed with it —
 *   getDefaultMergeMessageParts below resolves {STYLE}_TEMPLATE.md /
 *   DEFAULT_TEMPLATE.md and expands the vars (ClosingIssues included)
 *   before the template-less defaults.
 * - THE UPDATE-BRANCH ARM (`ShowUpdatePullInfo`, update_branch_by_merge.tmpl)
 *   renders since the write arms landed (below); it stays gated to same-repo
 *   heads (the engine's fork refusal) and the `PullRequestsConfig` style
 *   gates ride the upstream defaults. The `pull_requests.commits_behind`
 *   count feeds the render gate (`blockOnOutdatedBranch` keeps the merge
 *   gate's access).
 * - THE DELETE-BRANCH BUTTON (`IsPullBranchDeletable` +
 *   `data-url="{issue}/cleanup"`) renders since the cleanup POST landed
 *   (below); its deletable computation rides the optional `listTips` engine
 *   seam — callers without it (the issue-detail inline mount's loader call
 *   today) get the assumed-true degradation (the POST re-checks and
 *   refuses; the merged box then renders for every merged PR).
 * - COMMIT SIGNING (`prepareMergeBoxCommitSigning`: requireSigned/willSign,
 *   the `repo.signing.*` prompts and the require_signed_wont_sign blocker)
 *   has no source — no signing service exists; `canMergeNow`'s signing half
 *   is dropped because the landed merge gate never checks signatures.
 * - THE STATUS-CHECK BLOCKER renders upstream's DISPLAY (the failed/missing
 *   error items, the icon colors, the canMergeNow/bypass prompts) from the
 *   stored rule config + statuses, but the LANDED merge gate never enforces
 *   commit statuses (branch-protection.ts's IsPullCommitStatusPass note —
 *   SPEC-0013 §6 "stored-only, never enforced"): the box may show a required
 *   check as failed while the landed POST /merge would still succeed. The
 *   fragment is the upstream card; the divergence is the gate, not the render.
 * - `isBlockedByCodeowners` and `isBlockedByChangedProtectedFiles` have no
 *   landed predicates (the service's §6 omissions) — their blocker items and
 *   their `hasOverridableBlockers` contribution are omitted, keeping the
 *   protection blockers a faithful projection of `checkPullBranchProtections`
 *   (approvals, rejected reviews, official review requests, outdated branch)
 *   plus the stored required-check state above.
 * - `IsPullRequestBroken` (the "data_broken" blocker) reduces to the missing
 *   head-repo row (the deleted-fork arm); upstream's second arm (head branch
 *   commit ≠ the PR's internal ref — push-sync staleness) needs engine reads
 *   the loader declines. `cant_reopen_deleted_branch` (the closed body's
 *   other arm) falls to the same reduction — closed PRs always show
 *   `reopen_to_merge`.
 * - The WIP toggle button (`initPullRequestWipToggle`, POST `{issue}/title`)
 *   is a write action without a landed route — the WIP line renders, the
 *   button does not (so `IsIssuePoster`/`HasIssuesOrPullsWritePermission`
 *   and the matched `data-wip-prefix` are never needed).
 * - `AutodetectManualMerge` has no PR-unit config → upstream's default
 *   (false) → the merge-instruction warning renders whenever the merge
 *   instructions do; the Actions `approve-status-checks` item has no Actions
 *   runs to read → never renders; `CommitStatusesApplyDoerPermission` (the
 *   pending-status hiding for non-readers) is skipped — the UI router has
 *   already resolved the repo as visible before this loader runs (§2.5);
 *   `pullCommitStatusCheckData.RequireApprovalRunCount` rides Actions runs —
 *   no source, the `#approve-status-checks` item never renders.
 * - Octicons outside the generated allowlist (octicon-x, octicon-alert,
 *   gitea-running, gitea-exclamation, octicon-skip) embed the pinned
 *   submodule's exact `<path d>` bytes (the blob-excerpt FOLD_SVG precedent);
 *   the allowlisted rest ride the shared ICON_PATHS. `gitea-exclamation`
 *   keeps its upstream `-1 -1 26 26` viewBox.
 *
 * ## The WRITE arms (census gap #2 — the merge-box POST family)
 *
 * The upstream writes hang off the SAME pulls/{index} group (web.go:1665-1669)
 * plus the base-change form (web.go:1439, `POST /pull/{index}/target_branch`):
 *
 *   POST /{owner}/{repo}/pulls/{index}/merge                     web.go:1665
 *   POST /{owner}/{repo}/pulls/{index}/cancel_auto_merge         web.go:1666
 *   POST /{owner}/{repo}/pulls/{index}/update                    web.go:1667
 *   POST /{owner}/{repo}/pulls/{index}/set_allow_maintainer_edit web.go:1668
 *   POST /{owner}/{repo}/pulls/{index}/cleanup                   web.go:1669
 *   POST /{owner}/{repo}/pull/{index}/target_branch              web.go:1439
 *
 * (web.go:1667's `UpdatePullRequest` is the UPDATE-BRANCH write — merge or
 * rebase the base into the PR head branch, services/pull/update.go — NOT a
 * title/body edit; the title/body posts live on the `/{type}/{index}/title`
 * and `/content` routes, issue.go:274/326.) The handler ladders below are
 * this module's; the git choreography rides the landed pull-engine seams
 * (`mergePullRequest` — the API merge route's own service — plus the new
 * `updatePullRequestBranch` / `deleteBranchAfterMerge` /
 * `changePullRequestTargetBranch`), and the permission predicates ride the
 * same branch-protection/repo-access services the GET loader and the API
 * routes use. Response shapes are the house's web-POST convention (the
 * issue-comment POST posture): success → redirect outcome (the mounted
 * handler answers 303 onto the PR page, upstream JSONRedirect/Redirect's
 * target), failure → the error outcome carrying the upstream flash/locale
 * text (the mounted handler re-renders the conversation page with it), and
 * the upstream NotFound arms → the not-found outcome (the 404 shell).
 *
 * Per-write divergences (each cite inline at the seam):
 * - merge: the auto-merge schedule is REAL (migration 0059's
 *   `pull_auto_merges` — the MWCS arm schedules into
 *   services/pull-automerge.ts, whose queue consumer merges when the
 *   required checks go green; the box renders the pending message + the
 *   cancel button); the webhook + feed action ride the route's own payload
 *   assembly re-issued over importable service pieces (emitIssueEvent +
 *   recordAction — pullRequestPayload's §2.7 shape with citations);
 *   `cancel_auto_merge` deletes the scheduled row (the scheduler may cancel
 *   their own schedule; a non-scheduler needs the merge right — the
 *   not-scheduled 404 stays for a missing row); the merge form renders
 *   upstream's field names (PullRequestMergeForm.vue +
 *   forms.MergePullRequestForm) reduced to the no-JS select (the
 *   pull-reviews combobox reduction precedent — the Vue island is JS-only);
 *   the island's autoMergeWhenSucceed v-model reduces to the hidden field's
 *   render-time value (true when the merge cannot happen now).
 * - update: same-repo heads only (the engine fork refusal — the fork cell's
 *   base branch is a fork-point snapshot); the PR-unit config gates default
 *   true (repo_unit.go's DefaultPullRequestsConfig — no D1 home).
 * - set_allow_maintainer_edit + target_branch: upstream answers JSON for the
 *   sidebar/title JS islands; ours are the no-JS form posts that 303 back
 *   (the allow-edits checkbox and the base select render in the SIDEBAR and
 *   TITLE families, not the merge box — allow_maintainer_edit.tmpl +
 *   view_title.tmpl:94 — so this module ships their seams for those folds).
 * - cleanup: the merged box's delete button renders again (ShowMergeBox =
 *   `!HasMerged || IsPullBranchDeletable`, issue_view.go:974 — the loader's
 *   merged arm now computes the deletable pair, purple icon included) as a
 *   no-JS form around upstream's link-action button.
 *
 * ## Mount record (MOUNTED at 22599e4, window-2e B2 — the wiring HANDOFF
 * is retired)
 *
 * The route arm maps onto this module as: parser arm `pull-merge-box` —
 * `/{owner}/{repo}/pulls/{index}/merge_box`, GET, inside the pulls group's
 * tail dispatch beside `pull-files`/`pull-commits` (ui/index.ts's
 * `head === "pulls" && rest[1] === ...` ladder, web.go:1659); the handler
 * then 1. `resolveUiRequest` (the shared session/repo prologue — index-owned);
 * 2. `findIssueByRepoAndIndex` → null, or `!issue.isPull` ⇒ the §4.5 404
 * shell (upstream's prepareIssueViewLoad miss / `ctx.NotFound`);
 * 3. `findPullRequestByIndex` → null ⇒ the same 404 shell (an issue row
 * without its PR extension is the broken-data class, never a box);
 * 4. `loadPullMergeBoxData` → null (a merged AND non-deletable row since
 * 20f7290's cleanup arm — upstream renders the
 * ShowMergeBox=false arm) ⇒ `pullMergeBoxFragmentResponse("")` — an EMPTY
 * 200, exactly the template's `{{if $data.ShowMergeBox}}` miss, which is
 * also what the bundle's reload loop wants as its stop signal;
 * 5. otherwise `pullMergeBoxFragmentResponse(pullMergeBoxFragmentHtml(data))`
 * (content-type + the zero-option prod Cache-Control, the fragment twin's
 * Response shape). No layout, no window.config — the fragment mounts inside
 * the conversation page's timeline.
 *
 * ## The SECOND mount — the conversation page's inline box (webui-parity
 * top-drift 5 retired)
 *
 * Upstream's conversation page renders the SAME template server-side in the
 * timeline (view_content.tmpl:67-72, after `timeline-comments-end`, before
 * the comment form, gated `IsPull && !Repository.IsArchived`); the fragment
 * route exists so the bundle's `initRepoPullMergeBox` reload loop can
 * refetch the card while checks run. The conversation page
 * (pages/issue-detail.tsx) now renders `PullMergeBoxFragment` INLINE from
 * its loader's `loadPullMergeBoxData` call — the archived gate lives there
 * (the loader itself stays repo-shape-only, exactly like the route arm).
 * One builder, two mounts: the fragment Response and the page markup are
 * byte-identical by construction.
 */

import { renderToString } from "hono/jsx/dom/server";
import { Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { CommitJson, RefsResult } from "@cf-gitea/git-engine";

import { branchRef, pullHeadRef, type EngineReads } from "../../api/services/engine";
import { latestCommitStatuses, combinedStateOf } from "../../api/services/commit-status";
import type { CommitStatusState } from "../../api/models/commit-status";
import { hasWorkInProgressPrefix, issueNoDependenciesLeft } from "../../api/services/issues";
import type { User } from "../../api/models/user";
import type { ApiEnv } from "../../api/env";
import { ApiError } from "../../api/errors";
import {
  composeMergeMessage,
  deleteBranchAfterMerge,
  changePullRequestTargetBranch,
  ensurePullRequestChecked,
  hasUnmergedPullRequestsByHeadInfo,
  mergePullRequest,
  pullRequestDiffShortStat,
  updatePullRequestBranch,
} from "../../api/services/pull-engine";
import { findPullRequestByIndex, toApiPullRequest } from "../../api/services/pulls";
import { findRepositoryById, toApiRepository } from "../../api/services/repository";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { ActionType, recordAction } from "../../api/services/activity-feeds";
import { emitIssueEvent } from "../../services/issue-events";
import {
  canBypassBranchProtection,
  canUserDelete,
  canUserForcePush,
  canUserPush,
  checkPullBranchProtections,
  findRule,
  isUserMergeWhitelisted,
  mergeBlockedByOfficialReviewRequests,
  mergeBlockedByOutdatedBranch,
  mergeBlockedByRejectedReview,
  grantedApprovalsCount,
  parseRuleConfig,
  principalAccessOf,
  principalAccessOfRow,
  type PrincipalAccess,
  type ProtectedBranchConfig,
} from "../../services/branch-protection";
import {
  contextMatchesRequired,
  createScheduledAutoMergeComment,
  getScheduledAutoMerge,
  mergeRequiredContextsCommitStatus,
  removeScheduledAutoMerge,
  scheduleAutoMergeRow,
} from "../../services/pull-automerge";
import { PRFlow, PRStatus, comments, issues, pullRequests, pullReviews, ReviewType, users, type CommitStatusRow } from "../../db/schema";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { ICON_PATHS } from "../icons";
import { timeSinceParts } from "../page-data";
import type { RepoRow } from "../ui-context";
import type { Viewer } from "../viewer";

/** Page chrome text (component-local, the issueDetailLocale pattern — the
 *  upstream en-US strings verbatim; the checking prompt is upstream's own
 *  "Some checks are pending" fallback, NOT issue-detail's cf-gitea addition). */
export const pullMergeBoxLocale = {
  closed: "Pull request closed", // "repo.pulls.closed"
  reopen_to_merge: "Please reopen this pull request to perform a merge.", // "repo.pulls.reopen_to_merge"
  files_conflicted: "This pull request has changes conflicting with the target branch.", // "repo.pulls.files_conflicted"
  files_conflicted_no_listed_files: "(No conflicting files listed)", // "repo.pulls.files_conflicted_no_listed_files"
  data_broken: "This pull request is broken due to missing fork information.", // "repo.pulls.data_broken"
  is_checking: "Checking for merge conflicts…", // "repo.pulls.is_checking"
  is_ancestor: "This branch is already included in the target branch. There is nothing to merge.", // "repo.pulls.is_ancestor"
  is_empty: "The changes on this branch are already on the target branch. This will be an empty commit.", // "repo.pulls.is_empty"
  cannot_auto_merge_desc: "This pull request cannot be merged automatically due to conflicts.", // "repo.pulls.cannot_auto_merge_desc"
  cannot_auto_merge_helper: "Merge manually to resolve the conflicts.", // "repo.pulls.cannot_auto_merge_helper"
  no_merge_access: "You are not authorized to merge this pull request.", // "repo.pulls.no_merge_access"
  can_auto_merge_desc: "This pull request can be merged automatically.", // "repo.pulls.can_auto_merge_desc"
  required_status_check_administrator: "As an administrator, you may still merge this pull request.", // "repo.pulls.required_status_check_administrator"
  required_status_check_bypass_allowlist: "You are allowed to bypass branch protection rules for this merge.", // "repo.pulls.required_status_check_bypass_allowlist"
  cannot_merge_work_in_progress: "This pull request is marked as a work in progress.", // "repo.pulls.cannot_merge_work_in_progress"
  required_status_check_failed: "Required status checks did not pass", // "repo.pulls.required_status_check_failed"
  required_status_check_missing: "Required status checks are missing or pending", // "repo.pulls.required_status_check_missing"
  blocked_by_approvals:
    "This pull request doesn't have enough required approvals yet. {granted} of {required} official approvals granted.", // "repo.pulls.blocked_by_approvals" (%d of %d)
  blocked_by_approvals_whitelisted:
    "This pull request doesn't have enough required approvals yet. {granted} of {required} approvals granted from users or teams on the allowlist.", // "repo.pulls.blocked_by_approvals_whitelisted"
  blocked_by_rejection: "This pull request has changes requested by an official reviewer.", // "repo.pulls.blocked_by_rejection"
  blocked_by_official_review_requests: "This pull request has official review requests.", // "repo.pulls.blocked_by_official_review_requests"
  blocked_by_outdated_branch: "This pull request is blocked because it's outdated.", // "repo.pulls.blocked_by_outdated_branch"
  status_checking: "Some checks are pending", // "repo.pulls.status_checking"
  status_checks_success: "All checks were successful", // "repo.pulls.status_checks_success"
  status_checks_failure_optional: "Some optional checks failed", // "repo.pulls.status_checks_failure_optional"
  status_checks_failure_required: "Some required checks failed", // "repo.pulls.status_checks_failure_required"
  status_checks_warning: "Some checks reported warnings", // "repo.pulls.status_checks_warning"
  status_checks_error: "Some checks reported errors", // "repo.pulls.status_checks_error"
  status_checks_show_all: "Show all checks", // "repo.pulls.status_checks_show_all"
  status_checks_hide_all: "Hide all checks", // "repo.pulls.status_checks_hide_all"
  status_checks_requested: "Required", // "repo.pulls.status_checks_requested"
  status_checks_details: "Details", // "repo.pulls.status_checks_details"
  cmd_instruction_hint: "View command line instructions", // "repo.pulls.cmd_instruction_hint"
  cmd_instruction_checkout_title: "Checkout", // "repo.pulls.cmd_instruction_checkout_title"
  cmd_instruction_checkout_desc: "From your project repository, check out a new branch and test the changes.", // "repo.pulls.cmd_instruction_checkout_desc"
  cmd_instruction_merge_title: "Merge", // "repo.pulls.cmd_instruction_merge_title"
  cmd_instruction_merge_desc: "Merge the changes and update on Gitea.", // "repo.pulls.cmd_instruction_merge_desc"
  cmd_instruction_merge_warning:
    'Warning: This operation cannot merge pull request because "autodetect manual merge" is not enabled.', // "repo.pulls.cmd_instruction_merge_warning"
  git_guide_remote_name: "origin", // SystemConfig Repository.GitGuideRemoteName default (setting/config.go:79)
} as const;

/** The write-arm locale (the same en-US file at the pin — the merge form's
 *  strings, the update-branch arm, the cleanup flashes and the write refusals
 *  the handler ladders surface). */
export const pullMergeWriteLocale = {
  // the merge form (PullRequestMergeForm.vue's props strings)
  merge_pull_request: "Create merge commit", // "repo.pulls.merge_pull_request"
  rebase_merge_pull_request: "Rebase, then fast-forward", // "repo.pulls.rebase_merge_pull_request"
  rebase_merge_commit_pull_request: "Rebase, then create merge commit", // "repo.pulls.rebase_merge_commit_pull_request"
  squash_merge_pull_request: "Create squash commit", // "repo.pulls.squash_merge_pull_request"
  fast_forward_only_merge_pull_request: "Fast-forward only", // "repo.pulls.fast_forward_only_merge_pull_request"
  merge_manually: "Manually merged", // "repo.pulls.merge_manually"
  no_merge_desc: "This pull request cannot be merged because all repository merge options are disabled.", // "repo.pulls.no_merge_desc"
  no_merge_helper: "Enable merge options in the repository settings or merge the pull request manually.", // "repo.pulls.no_merge_helper"
  commit_message_desc: "Add an optional extended description…", // "repo.editor.commit_message_desc"
  merge_commit_id: "The merge commit ID", // "repo.pulls.merge_commit_id"
  branch_delete_button: "Delete Branch", // "repo.branch.delete_html" (the merged box's cleanup button)
  branch_delete_checkbox: 'Delete Branch "{branch}"', // "repo.branch.delete" (the form checkbox label)
  // the merged box (prepareMergeBoxInfoItems' merged arm)
  merged_success: "Pull request successfully merged and closed", // "repo.pulls.merged_success"
  merged_info_prefix: "The branch ", // "repo.pulls.merged_info_text" around the <code> target
  merged_info_suffix: " can now be deleted.",
  // the update-branch arm (update_branch_by_merge.tmpl + preparePullUpdateActions)
  outdated_with_base_branch: "This branch is out-of-date with the base branch", // "repo.pulls.outdated_with_base_branch"
  update_branch: "Update branch by merge", // "repo.pulls.update_branch"
  update_branch_rebase: "Update branch by rebase", // "repo.pulls.update_branch_rebase"
  // the POST refusal flashes (the handler ladders' error texts)
  is_closed: "The pull request has been closed.", // "repo.pulls.is_closed"
  has_merged: "Failed: The pull request has been merged. You cannot merge again or change the target branch.", // "repo.pulls.has_merged"
  no_merge_wip: "This pull request cannot be merged because it is marked as being a work in progress.", // "repo.pulls.no_merge_wip"
  no_merge_not_ready: "This pull request is not ready to be merged. Check review status and status checks.", // "repo.pulls.no_merge_not_ready"
  dependencies_left: "You need to close all issues that are blocking this pull request before you can merge it.", // "repo.issues.dependency.pr_close_blocked"
  update_not_allowed: "You are not allowed to update branch", // "repo.pulls.update_not_allowed" (ErrNoPermissionToMerge's arm)
  invalid_merge_option: "You cannot use this merge option for this pull request.", // "repo.pulls.invalid_merge_option"
  wrong_commit_id: "commit ID must be a commit ID on the target branch", // "repo.pulls.wrong_commit_id"
  merge_conflict: "Merge Failed: There was a conflict while merging. Hint: Try a different strategy.", // "repo.pulls.merge_conflict"
  merge_out_of_date: "Merge Failed: While generating the merge, the base was updated. Hint: Try again.", // "repo.pulls.merge_out_of_date"
  unable_to_update: "Unable to update pull request", // UpdatePullRequest's fallback JSONError text
  branch_deletion_success: 'Branch "{branch}" has been deleted.', // "repo.branch.deletion_success"
  no_permission_for_action: "user not allowed to do this action", // pull.ErrUserHasNoPermissionForAction's text
  // the auto-merge arms (pull_merge_form.go:91-94 + the pending tip)
  auto_merge_button_when_succeed: "(When checks succeed)", // "repo.pulls.auto_merge_button_when_succeed"
  auto_merge_cancel_schedule: "Cancel auto merge", // "repo.pulls.auto_merge_cancel_schedule"
  // "repo.pulls.auto_merge_has_pending_schedule" = "%[1]s scheduled this pull
  // request to auto merge when all checks succeed %[2]s." — the relative time
  // renders between the fragments (the TimeSince seam).
  auto_merge_has_pending_schedule_prefix: "scheduled this pull request to auto merge when all checks succeed",
  auto_merge_has_pending_schedule_suffix: ".",
  cancel_permission_denied: "user has no permission to cancel the scheduled auto merge", // pull.go:1278's HTTPError text
} as const;

/** The conflicted-files list cap (pull_merge_box.go:112-115): > 10 keeps 10
 *  and appends a literal "..." list item. */
export const CONFLICTED_FILES_CAP = 10;

/** The status-check list cap — upstream pages `db.ListOptionsAll` (unbounded);
 *  the cap bounds the render for pathological status sets without changing
 *  the newest-first order (the TIMELINE_LIMIT posture). */
export const STATUS_CHECKS_LIMIT = 100;

// ---------------------------------------------------------------------------
// Icon rendering — the allowlisted set rides the shared ICON_PATHS; the merge
// box's extras embed the pinned submodule's exact path bytes.
// ---------------------------------------------------------------------------

/** Non-allowlisted icons with their upstream asset bytes
 *  (gitea/public/assets/img/svg/ at the pin). */
const MERGE_BOX_EMBEDDED_ICONS: Record<string, { paths: string[]; viewBox: string }> = {
  "octicon-x": {
    paths: [
      "M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.75.75 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.75.75 0 0 1-.734-.215L8 9.06l-3.22 3.22a.75.75 0 0 1-1.042-.018.75.75 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06",
    ],
    viewBox: "0 0 16 16",
  },
  "octicon-alert": {
    paths: [
      "M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0M9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0",
    ],
    viewBox: "0 0 16 16",
  },
  "gitea-running": {
    paths: [
      "M3.05 3.05a7 7 0 1 1 9.9 9.9 7 7 0 0 1-9.9-9.9Z",
      "M8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
      "M14 8a6 6 0 0 0-6-6V0a8 8 0 0 1 8 8z",
    ],
    viewBox: "0 0 16 16",
  },
  "gitea-exclamation": {
    paths: [
      "M12 15.99a2 2 0 0 0 2-2V2.03a2 2 0 0 0-4 0v11.96a2 2 0 0 0 2 2m0 7.98a2.5 2.5 0 1 0-2.5-2.5 2.5 2.5 0 0 0 2.5 2.5",
    ],
    viewBox: "-1 -1 26 26",
  },
  "octicon-skip": {
    paths: [
      "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0m9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.75.75 0 0 1 .215-.734l5.5-5.5a.75.75 0 0 1 1.042.018.75.75 0 0 1 .018 1.042",
    ],
    viewBox: "0 0 16 16",
  },
};

/** The allowlisted entries (single-sourced) plus the embedded extras —
 *  `Record<string, readonly string[]>` so either source feeds the same
 *  renderer. */
const MERGE_BOX_ICON_PATHS: Record<string, readonly string[]> = {
  ...(ICON_PATHS as Record<string, readonly string[]>),
  ...Object.fromEntries(Object.entries(MERGE_BOX_EMBEDDED_ICONS).map(([name, icon]) => [name, icon.paths])),
};

function mergeBoxIconViewBox(name: string): string {
  return MERGE_BOX_EMBEDDED_ICONS[name]?.viewBox ?? "0 0 16 16";
}

/** `{{svg "name" size "extra-class"}}`'s DOM (shell.tsx's Icon shape — the
 *  `svg {name} {extra}` class string upstream's RenderHTML emits). */
function MergeBoxSvg(props: { name: string; size?: number; extraClass?: string }) {
  const classes = props.extraClass === undefined ? `svg ${props.name}` : `svg ${props.name} ${props.extraClass}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={mergeBoxIconViewBox(props.name)}
      width={props.size ?? 16}
      height={props.size ?? 16}
      class={classes}
      aria-hidden="true"
    >
      {(MERGE_BOX_ICON_PATHS[props.name] ?? []).map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The data shape — the pullMergeBoxData fields the render consumes
// ---------------------------------------------------------------------------

/** One `pullMergeBoxInfoItem` (pull_merge_box.go:15-19) with the icon held as
 *  a renderable name/class pair (upstream pre-renders SVG HTML; JSX renders
 *  the same DOM from the pair). `iconClass` is the RenderHTML extra class —
 *  a color (`tw-text-red`) or the spinner's `rotate-clockwise`. */
export interface PullMergeBoxInfoItem {
  icon: string;
  iconClass?: string;
  info: string;
  listItems: string[];
}

/** One `pullCommitStatusCheckData.PullCommitStatuses` row plus the
 *  `IsContextRequired` projection (`status_items.tmpl`'s Required label). */
export interface PullMergeBoxStatusItem {
  state: CommitStatusState;
  context: string;
  description: string;
  targetUrl: string;
  required: boolean;
}

/** The status-check section (`ShowStatusCheck` arm) — `null` = the section
 *  does not render (closed PR, or no rule contexts and no stored statuses). */
export interface PullMergeBoxStatusCheckData {
  prompt: string;
  items: PullMergeBoxStatusItem[];
  /** Required contexts with no matching status row (status_items.tmpl's
   *  MissingRequiredChecks range). */
  missingRequired: string[];
}

/** The command-line instruction block (`pull_merge_instruction.tmpl`) —
 *  pre-rendered command lines (the ShellEscape'd args baked in). */
export interface PullMergeBoxCommands {
  checkoutLines: string[];
  /** The merge block renders only when `ShowMergeInstructions`
   *  (canWriteToHeadRepo) — empty = checkout only. */
  mergeBlocks: { style: string; lines: string[]; hidden: boolean }[];
  mergePushLine: string | null;
  showMergeWarning: boolean;
}

/** Everything the fragment renders — the `pullMergeBoxData` projection
 *  (pull.go:260-310), fields renamed to their template roles. */
export interface PullMergeBoxData {
  issueLink: string;
  /** 0 = no reloading attrs; 5000 = the checking poll (issue_view.go:953-956). */
  reloadingInterval: number;
  /** `.timeline-avatar` color class (prepareMergeBoxIconColor). */
  timelineIconClass: string;
/** The closed arm (`ClosedInfoTitle`/`ClosedInfoBody`). The closed-unmerged
 *  shape is the plain `{title, body}` pair; the MERGED arm (reachable again
 *  since the write arms landed — ShowMergeBox's deletable half) carries the
 *  code-embedded target: `prefix <code>code</code> suffix` (the
 *  merged_info_text HTMLFormat). `null` = open PR. */
closedInfo:
  | { title: string; body: string; bodyCode?: undefined }
  | { title: string; body?: undefined; bodyCode: { prefix: string; code: string; suffix: string } }
  | null;
statusChecks: PullMergeBoxStatusCheckData | null;
/** The `InfoSections` — one section per `.item` div (the commit-blocker /
 *  protection-blocker / merge-prompt collection split, pull_merge_box.go:185-190);
 *  sections with no items render nothing (the template's own `{{if}}`). */
infoSections: PullMergeBoxInfoItem[][];
/** The WIP line renders when the title carries a prefix (the toggle button
 *  is not rendered — module doc). */
isWorkInProgress: boolean;
commands: PullMergeBoxCommands | null;
/** The merge form (the `$data.MergeFormProps` island reduced to the no-JS
 *  form — the module doc's write-arm section). Fields are
 *  forms.MergePullRequestForm + PullRequestMergeForm.vue's names. `null` =
 *  the island's absence (closed/merged rows, or `!hasPermToMerge`). */
mergeForm: {
  /** The form action base — `{issueLink}/merge` (PullRequestMergeForm.vue's
   *  `baseLink+'/merge'`). */
  issueLink: string;
  /** `head_commit_id` — the head_sha cache (CompareInfo.HeadCommitID's
   *  landed projection; the write ignores it like the API body contract). */
  headCommitId: string;
  /** The `force_merge` hidden input's v-model (the Vue computed:
   *  `canMergeNow && !allOverridableChecksOk`). */
  forceMerge: boolean;
  /** The allowed styles (the PR-unit allowlist — pull_merge_form.go:126-170:
   *  each Allow* flag gates its entry, fast-forward-only also needs
   *  CommitsBehind == 0, and manually-merged rides canUseManualMerge =
   *  !WIP && !IsChecking && AllowManualMerge). */
  styles: { name: string; text: string; hideMessageFields: boolean }[];
  /** The preselected `do` — prepareMergeBoxFormProps's ladder: the stored
   *  DefaultMergeStyle when its style is allowed, else the first allowed
   *  (pull_merge_form.go:29-46). */
  defaultStyle: string;
  /** The title field's prefill — the SELECTED style's composed default
   *  (GetDefaultMergeMessage's per-style shape, re-issued for the render:
   *  mergeTitleFieldText on the merge/rebase-merge/squash entries,
   *  pull_merge_form.go:121/136/144). */
  defaultTitle: string;
  /** The message field's prefill — the SELECTED style's
   *  mergeMessageFieldText (pull_merge_form.go:122/137/145): the squash
   *  entry's `git.CommitMessageMerge(GetSquashMergeCommitMessages(pr),
   *  defaultSquashMergeBody)` composition (the config-switched commit
   *  bullet list / PR body / blank, plus the co-author trailers, merged
   *  with the Reviewed-on block), the bare Reviewed-on block for
   *  merge/rebase-merge, "" for the hidden-fields styles and the broken
   *  rows. Swaps with the title on the default-style switch. */
  defaultBody: string;
  /** The unresolved-dependency readiness gate — the write ladder's
   *  issueNoDependenciesLeft arm (check.go:219-223): true disables the
   *  submit, the pr_close_blocked message riding the box's blocker item. */
  blockedByDependencies: boolean;
  /** The delete checkbox (the Vue `isPullBranchDeletable`). */
  isPullBranchDeletable: boolean;
  /** The checkbox label's branch target (the `textDeleteBranch` arg). */
  headTarget: string;
  /** The hidden `merge_when_checks_succeed` value — the Vue
   *  autoMergeWhenSucceed reduction: true when the merge cannot happen now
   *  (`!canMergeNow` — the !canMergeNow arm offers ONLY the auto merge),
   *  false for the plain merge. */
  mergeWhenChecksSucceed: boolean;
  /** The scheduled row (`hasPendingPullRequestMerge` + its tip: the doer
   *  name + the created stamp the relative time renders between). `null` =
   *  nothing scheduled (GetScheduledMergeByPullID's miss). */
  pendingAutoMerge: { doerName: string; createdUnix: number } | null;
} | null;
/** The update-branch arm (`ShowUpdatePullInfo` + the update_branch_by_merge
 *  template's buttons, reduced to one no-JS form per style). `null` when the
 *  arm does not render. */
updateBranch: { options: { style: "merge" | "rebase"; text: string; url: string }[] } | null;
/** The merged box's cleanup delete (`DeleteBranchLink` + the button). */
deleteBranch: { link: string; headTarget: string } | null;
}

// ---------------------------------------------------------------------------
// util.ShellEscape port (modules/util/shellquote.go:56-110)
// ---------------------------------------------------------------------------

const SHELL_NEEDS_ESCAPE = " \t\n|&;()<>${}[]*?!\"'`\\";
const SHELL_NEEDS_SINGLE_QUOTE = "!\n";

function containsAny(text: string, chars: string): boolean {
  for (const ch of chars) {
    if (text.includes(ch)) return true;
  }
  return false;
}

/** util.ShellEscape: plain when clean (never a leading `#`), double-quote
 *  escaping otherwise, single-quote escaping only for `!`/newline, and the
 *  leading-`~` expansion prefix stays unescaped. */
export function shellEscape(toEscape: string): string {
  if (toEscape.length === 0) return toEscape;
  let start = 0;
  if (toEscape.charCodeAt(0) === 0x7e /* ~ */) {
    const slash = toEscape.indexOf("/");
    const idx = slash === -1 ? toEscape.length : slash + 1;
    if (!containsAny(toEscape.slice(0, idx), SHELL_NEEDS_ESCAPE)) start = idx;
  }
  const rest = toEscape.slice(start);
  if (!containsAny(rest, SHELL_NEEDS_ESCAPE) && toEscape.charCodeAt(0) !== 0x23 /* # */) return toEscape;
  if (containsAny(rest, SHELL_NEEDS_SINGLE_QUOTE)) {
    return `${toEscape.slice(0, start)}'${rest.replaceAll("'", "'\\''")}'`;
  }
  return `${toEscape.slice(0, start)}"${rest.replaceAll(/[$`"\\]/g, (ch) => `\\${ch}`)}"`;
}

// ---------------------------------------------------------------------------
// The status-check context glob + the required-context combine live in
// services/pull-automerge.ts (contextMatchesRequired /
// mergeRequiredContextsCommitStatus) — one port, two consumers: the box
// DISPLAYS the required-check state, the auto-merge consumer ENFORCES it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The loader — the prepareMergeBox projection over the landed merge state
// ---------------------------------------------------------------------------

/** The loader input — the rows the route prologue has already resolved
 *  (the repo row is the BASE repo; §2.5's resolution owns visibility) plus
 *  the request origin (the fork fetch line's HeadRepo.HTMLURL absolute half).
 *  `listTips` is the optional engine ref-read seam the branch-deletable tip
 *  checks ride (issue_view.go:632-648's HeadBranchCommitID/IsBranchExist
 *  reads): absent → the RENDER assumes the checks true (the POST seams
 *  re-check against the engine and refuse — the disclosed degradation).
 *  `reads` is the optional engine read bundle the squash body prefill's
 *  commit walk rides (GetSquashMergeCommitMessages' base..head log,
 *  services/pull/pull.go:723-775 — the same `engineReads(env, pair)`
 *  composition pull-commits.tsx builds): absent → the commit-list half of
 *  the squash body degrades to empty and the body carries only the
 *  Reviewed-on trailers, upstream's own GetDefaultMergeMessage error arm
 *  (the props stay "" on the err, pull_merge_form.go:71-83). */
export interface PullMergeBoxInput {
  repo: RepoRow;
  issue: IssueRow;
  pr: PullRequestRow;
  viewer: Viewer;
  origin: string;
  listTips?: (pair: { ownerNamespace: string; slug: string }) => Promise<RefsResult | null>;
  reads?: EngineReads;
}

/** Tolerant conflictedFiles decode (the engine check's JSON array). */
function conflictedFilesOf(pr: PullRequestRow): string[] {
  if (pr.conflictedFiles === null || pr.conflictedFiles === "") return [];
  try {
    const parsed: unknown = JSON.parse(pr.conflictedFiles);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** The locale interpolation the two approvals blockers need
 *  (`ctx.Locale.Tr("repo.pulls.blocked_by_approvals", granted, required)`). */
function blockedByApprovalsText(config: ProtectedBranchConfig, granted: number): string {
  const template = config.enableApprovalsWhitelist
    ? pullMergeBoxLocale.blocked_by_approvals_whitelisted
    : pullMergeBoxLocale.blocked_by_approvals;
  return template.replaceAll("{granted}", String(granted)).replaceAll("{required}", String(config.requiredApprovals));
}

/** The icon-class switch (pull_merge_box.go:52-87), upstream's exact order:
 *  normal-color arms → error → warning → blockers → mergeable → default.
 *  (The merged → purple arm is unreachable — merged PRs never render.)
 *  `pullCommitStatusState === null` is upstream's zero-value state (no
 *  statuses at all — CalcCommitStatus's nil); `requiredChecksState` follows
 *  MergeRequiredContextsCommitStatus (empty statuses → pending). */
function mergeBoxIconClass(state: {
  isClosed: boolean;
  isWorkInProgress: boolean;
  isEmpty: boolean;
  isConflicted: boolean;
  isChecking: boolean;
  pullCommitStatusState: CommitStatusState | null;
  requiredChecksState: CommitStatusState;
  enableStatusCheck: boolean;
  hasRequiredStatusContexts: boolean;
  hasBlockers: boolean;
  isMergeable: boolean;
}): string {
  const showAsNormalColor = state.isClosed || state.isWorkInProgress || state.isEmpty || state.isConflicted;
  const errorLike = (s: CommitStatusState): boolean => s === "error" || s === "failure";
  const warningLike = (s: CommitStatusState): boolean => s === "warning" || s === "pending";
  let showAsErrorColor = false;
  let showAsWarningColor = state.isChecking;
  if (state.pullCommitStatusState !== null) {
    showAsErrorColor = errorLike(state.pullCommitStatusState) || errorLike(state.requiredChecksState);
    showAsWarningColor =
      showAsWarningColor ||
      warningLike(state.pullCommitStatusState) ||
      ((state.enableStatusCheck || state.hasRequiredStatusContexts) && warningLike(state.requiredChecksState));
  }
  if (showAsNormalColor) return "tw-text-text-light";
  if (showAsErrorColor) return "tw-text-red";
  if (showAsWarningColor) return "tw-text-yellow";
  if (state.hasBlockers) return "tw-text-red";
  if (state.isMergeable) return "tw-text-green";
  return "tw-text-text-light";
}

/** `CommitStatusCheckPrompt` (pull.go:516-532) over the required checks'
 *  state and the plain combined state. */
function statusCheckPrompt(requiredChecksState: CommitStatusState, combined: CommitStatusState): string {
  if (requiredChecksState === "pending") return pullMergeBoxLocale.status_checking;
  if (requiredChecksState === "success") {
    if (combined === "failure") return pullMergeBoxLocale.status_checks_failure_optional;
    return pullMergeBoxLocale.status_checks_success;
  }
  if (requiredChecksState === "warning") return pullMergeBoxLocale.status_checks_warning;
  if (requiredChecksState === "failure") return pullMergeBoxLocale.status_checks_failure_required;
  if (requiredChecksState === "error") return pullMergeBoxLocale.status_checks_error;
  return pullMergeBoxLocale.status_checking;
}

/** The `headTarget` display string (setTemplateDataMergeTarget,
 *  routers/web/repo/pull.go:161-172): same-owner heads carry the bare branch,
 *  a deleted fork the "(deleted):branch" placeholder, a fork the
 *  `owner/name:branch` full name. */
export function headTargetOf(baseRepo: RepoRow, headRepo: { ownerNamespace: string; slug: string } | null, pr: PullRequestRow): string {
  if (headRepo === null) return `(deleted):${pr.headBranch}`; // "repo.pull.deleted_branch"
  if (pr.headRepoId === baseRepo.id || headRepo.ownerNamespace === baseRepo.ownerNamespace) return pr.headBranch;
  return `${headRepo.ownerNamespace}/${headRepo.slug}:${pr.headBranch}`;
}

/** The tip read over the optional engine seam (RefsResult → the ref's target,
 *  null-seam tolerant). */
function tipOf(refs: RefsResult | null, ref: string): string | undefined {
  return refs?.refs.find((entry) => entry.name === ref)?.target;
}

/**
 * `IsPullBranchDeletable` (prepareMergeBoxDeleteBranch,
 * routers/web/repo/issue_view.go:632-648) over the landed predicates:
 *
 *   canDelete (CanDeleteBranchWithPermission — the head write + the rule's
 *              CanUserDelete; the default branch never deletes)
 *   && HeadRepo != nil
 *   && (!HasMerged || HeadBranchCommitID == CompareInfo.HeadCommitID)
 *   && IsBranchExist(head branch)
 *   && (closed → no shared-head open PR, :642-647)
 *
 * `merged=true` is the cleanup button's gate (the merged arm above);
 * `merged=false` gates the merge form's delete checkbox (the open arm — the
 * tip equality and shared-head arms collapse away). The tip checks ride the
 * optional `listTips` engine seam; without it they are assumed-true for the
 * render — the POST seams re-check against the engine and refuse (the
 * disclosed degradation in the input's doc). The AGit flow has no head
 * branch to delete.
 */
async function pullBranchDeletable(
  d1: D1Database,
  input: PullMergeBoxInput,
  access: PrincipalAccess,
  headRepo: Awaited<ReturnType<typeof findRepositoryById>>,
  merged: boolean,
): Promise<boolean> {
  const { repo, issue, pr, viewer } = input;
  if (pr.flow !== PRFlow.Github) return false;
  if (headRepo === null) return false;
  if (pr.headBranch === headRepo.repo.defaultBranch) return false; // CanDeleteBranch's default arm
  // The write arm runs in the HEAD repo (a fork's own permission — the
  // maintainer-edit grant reaches the fork's CODE write only through a real
  // collaborator grant, the pull-engine fork-delete ladder's reading).
  let headAccess = access;
  if (pr.headRepoId !== repo.id) {
    headAccess =
      viewer.kind === "user"
        ? await principalAccessOfRow(d1, headRepo.repo, { id: viewer.id, username: viewer.username, isAdmin: viewer.isAdmin })
        : { userId: 0, write: false, admin: false };
  }
  if (!headAccess.write) return false;
  const rule = await findRule(d1, headRepo.repo.id, pr.headBranch);
  if (rule !== null && !(await canUserDelete(d1, parseRuleConfig(rule.rules), headAccess))) return false;
  // The closed arm's shared-head check (issue_view.go:642-647) — a merged PR
  // is closed, so the merged arm always pays it.
  if (issue.isClosed && (await hasUnmergedPullRequestsByHeadInfo(d1, pr.headRepoId, pr.headBranch, issue.id))) return false;
  if (merged && input.listTips !== undefined) {
    // HeadBranchCommitID == CompareInfo.HeadCommitID + IsBranchExist — the
    // base cell's pull ref must still point at the head branch's tip.
    const branchTip = tipOf(await input.listTips({ ownerNamespace: headRepo.repo.ownerNamespace, slug: headRepo.repo.slug }), `refs/heads/${pr.headBranch}`);
    if (branchTip === undefined) return false;
    const pullTip = tipOf(await input.listTips({ ownerNamespace: repo.ownerNamespace, slug: repo.slug }), `refs/pull/${pr.index}/head`);
    if (pullTip === undefined || pullTip !== branchTip) return false;
  }
  if (!merged && input.listTips !== undefined) {
    // IsBranchExist only (the unmerged arm's tip check collapses to true
    // upstream — `!HasMerged ||` short-circuits).
    const branchTip = tipOf(await input.listTips({ ownerNamespace: headRepo.repo.ownerNamespace, slug: headRepo.repo.slug }), `refs/heads/${pr.headBranch}`);
    if (branchTip === undefined) return false;
  }
  return true;
}

/**
 * `CheckUserAllowedToUpdate` (services/pull/update.go:132-190) over the
 * landed predicates: the head-branch push right = the HEAD repo's write +
 * (no rule → allowed | rule → canUserPush); rebase = canUserForcePush. The
 * PR-unit config gates (AllowMergeUpdate/AllowRebaseUpdate) have no D1 home →
 * upstream defaults (true — repo_unit.go:146-147). The maintainer-edit
 * inheritance (:163-186): when the PR allows maintainer edits and a style is
 * missing, a doer who may merge in the BASE (the merge route's two gates)
 * inherits the POSTER's head-branch push/force-push rights. The AGit flow
 * and the doer-less call answer all-false (:139, :161-162).
 */
export async function checkUserAllowedToUpdate(
  d1: D1Database,
  repo: RepoRow,
  headRepo: Awaited<ReturnType<typeof findRepositoryById>>,
  issue: IssueRow,
  pr: PullRequestRow,
  access: PrincipalAccess,
  viewer: Viewer,
): Promise<{ mergeAllowed: boolean; rebaseAllowed: boolean }> {
  if (pr.flow !== PRFlow.Github) return { mergeAllowed: false, rebaseAllowed: false };
  if (headRepo === null) return { mergeAllowed: false, rebaseAllowed: false };
  if (viewer.kind !== "user") return { mergeAllowed: false, rebaseAllowed: false };
  // The head-branch rule gates the push rights (isUserAllowedToPushOrForce
  // PushInRepoBranch, update.go:101-130); the doer's HEAD-repo access pair
  // re-resolves through the row-keyed bridge for fork heads.
  const headAccess =
    pr.headRepoId === repo.id
      ? access
      : await principalAccessOfRow(d1, headRepo.repo, { id: viewer.id, username: viewer.username, isAdmin: viewer.isAdmin });
  const headRule = await findRule(d1, headRepo.repo.id, pr.headBranch).then((rule) => (rule === null ? null : parseRuleConfig(rule.rules)));
  let mergeAllowed = headAccess.write && (headRule === null || (await canUserPush(d1, headRule, headAccess)));
  let rebaseAllowed = headAccess.write && (headRule === null || (await canUserForcePush(d1, headRule, headAccess)));
  // The maintainer-edit inheritance (:163-186): missing style + the flag +
  // the doer may merge in the base (the merge route's two gates) → the
  // POSTER's head-branch rights.
  if (pr.allowMaintainerEdit && (!mergeAllowed || !rebaseAllowed) && issue.posterId !== null) {
    const baseRule = await findRule(d1, repo.id, pr.baseBranch).then((rule) => (rule === null ? null : parseRuleConfig(rule.rules)));
    const doerMayMergeInBase = access.write && (baseRule === null || (await isUserMergeWhitelisted(d1, baseRule, access)));
    if (doerMayMergeInBase) {
      const posterRow = (await drizzle(d1).select().from(users).where(eq(users.id, issue.posterId)).get()) ?? null;
      if (posterRow !== null) {
        const posterAccess = await principalAccessOf(d1, headRepo.repo, { id: posterRow.id, login: posterRow.username, is_admin: posterRow.isAdmin });
        const posterRule = await findRule(d1, headRepo.repo.id, pr.headBranch).then((rule) => (rule === null ? null : parseRuleConfig(rule.rules)));
        mergeAllowed = posterAccess.write && (posterRule === null || (await canUserPush(d1, posterRule, posterAccess)));
        rebaseAllowed = posterAccess.write && (posterRule === null || (await canUserForcePush(d1, posterRule, posterAccess)));
      }
    }
  }
  return { mergeAllowed, rebaseAllowed };
}

// ---------------------------------------------------------------------------
// The merge message BODY prefill — the write-side ports the render re-issues
// (prepareMergeBoxFormProps:67-84 + the GetDefaultMergeMessage /
// GetSquashMergeCommitMessages / CommitMessageMerge family). Every helper
// here is a verbatim string-level port; the upstream vector tables
// (modules/git/commit_message_test.go TestCommitMessageTrailer /
// TestCommitMessageMerge) pin the two trailer primitives in this module's
// own suite.
// ---------------------------------------------------------------------------

/** `git.CommitMessageSplitTrailer` (modules/git/commit_message.go:82-94) —
 *  the interpret-trailers split (content + separator + trailer block). The
 *  regexp is upstream's verbatim (the copied-from-legacy shape, its own
 *  comment disclaims git-exactness); Go RE2's leftmost-lazy semantics agree
 *  with JS's preference order on this pattern — the vector table pins it.
 *  NormalizeStringEOL rides first (the Go helper's \r\n / \r fold). */
const COMMIT_MESSAGE_TRAILER_SPLIT =
  /^(?<content>.*?)(?<sep>^|^\n|^-{3,}\n+|\n+-{3,}\n+|\n{2,})(?<trailer>(?:[A-Za-z0-9][-\w]*:[^\n]*(\n\s+[^\n]*)*\n?)*\n*)$/s;

/** The triple as `[content, sep, trailer]` — content + sep + trailer
 *  reconstruct the original message (the Go contract). */
export function commitMessageSplitTrailer(message: string): [content: string, sep: string, trailer: string] {
  const s = message.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const groups = COMMIT_MESSAGE_TRAILER_SPLIT.exec(s)?.groups;
  const content = groups?.content;
  const sep = groups?.sep;
  const trailer = groups?.trailer;
  if (content === undefined || sep === undefined || trailer === undefined) return [s, "", ""];
  return [content, sep, trailer];
}

/** `git.CommitMessageMerge` (modules/git/commit_message.go:99-127) — the two
 *  messages joined at their trailers: contents body-joined, then one
 *  separator and both trailer blocks (the squash prefill composes the
 *  commit list with the Reviewed-on block through exactly this). */
export function commitMessageMerge(m1: string, m2: string): string {
  const [c1Raw, s1, t1Raw] = commitMessageSplitTrailer(m1);
  const [c2Raw, s2, t2Raw] = commitMessageSplitTrailer(m2);
  const c1 = c1Raw.trim();
  const t1 = t1Raw.trim();
  const c2 = c2Raw.trim();
  const t2 = t2Raw.trim();
  let out = "";
  if (c1 !== "" && c2 !== "") {
    out = `${c1}\n\n${c2}`;
  } else if (c1 !== "") {
    out = c1;
  } else if (c2 !== "") {
    out = c2;
  }
  if (t1 !== "" || t2 !== "") {
    let sep = t1 === "" ? s2 : s1;
    if (sep === "") sep = "\n\n";
    if (c1 !== "" || c2 !== "") out += sep;
    if (t1 !== "") out += t1;
    if (t1 !== "" && t2 !== "") out += "\n";
    if (t2 !== "") out += t2;
  }
  return out;
}

/** The settings defaults the prefill family reads (no D1 home — the global
 *  defaults ride, the module's AutodetectManualMerge posture):
 *  Repository.PullRequest.DefaultMergeMessageCommitsLimit and
 *  DefaultMergeMessageSize (modules/setting/repository.go:205-206). */
export const MERGE_MESSAGE_COMMITS_LIMIT = 50;
export const MERGE_MESSAGE_MAX_SIZE = 5 * 1024;
/** How much of the mergeBase..head range the newest-50 window read may
 *  materialize (the engine answers the WHOLE in-range set oldest-first and
 *  slices pages from that end — reading at the ceiling and tail-slicing
 *  MERGE_MESSAGE_COMMITS_LIMIT reproduces upstream's `rev-list --max-count
 *  50` newest window; ranges past the ceiling keep the oldest-first page,
 *  the module header's disclosed residual). */
export const MERGE_MESSAGE_COMMITS_WALK_CEILING = 1000;
/** `DefaultMergeMessageMaxApprovers` (:207) — GetApprovers' reviewer cap. */
const MERGE_MESSAGE_MAX_APPROVERS = 10;

/** UTF-8 byte length (upstream caps bytes; the TextEncoder is the exact
 *  counter — workerd Web-standard, no Node Buffer). */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** `formatSquashMergeCommitMessages` (services/pull/pull.go:850-880) — the
 *  GitHub-style `* {message}` bullet list, OLDEST commit first (the engine's
 *  listCommitsRange order — upstream's rev-list answer is newest-first and
 *  slices.Backward re-reverses it), blank messages skipped, the byte cap
 *  breaking the walk and truncating the result at a UTF-8 rune boundary
 *  with a literal "..." tail, then the trailing "\n\n". */
function formatSquashMergeCommitMessages(commits: CommitJson[]): string {
  let sb = "";
  for (const commit of commits) {
    const msg = commit.message.trim();
    if (msg === "") continue;
    sb += `* ${msg}\n\n`;
    if (utf8ByteLength(sb) >= MERGE_MESSAGE_MAX_SIZE) break;
  }
  let buf = sb.trim();
  if (utf8ByteLength(buf) > MERGE_MESSAGE_MAX_SIZE) {
    // the byte-accurate cut: truncate the UTF-8 bytes, then back off any
    // split multi-byte rune exactly like DecodeLastRune's RuneError arm.
    const bytes = new TextEncoder().encode(buf).slice(0, MERGE_MESSAGE_MAX_SIZE);
    let cut = bytes.length;
    while (cut > 0 && (bytes[cut - 1]! & 0xc0) === 0x80) cut -= 1; // continuation bytes
    if (cut > 0 && (bytes[cut - 1]! & 0x80) !== 0) cut -= 1; // the leading byte of a split rune
    buf = new TextDecoder().decode(bytes.slice(0, cut));
    buf += "...";
  }
  return `${buf}\n\n`;
}

/** `collectSquashMergeCommitCoAuthors` (services/pull/pull.go:790-815) over
 *  the walked commits — the DefaultMergeMessageAllAuthors=false default
 *  scans exactly the limited list (no remaining-author batches): unique
 *  author signature strings, the poster's own signature excluded, and the
 *  account-email twin excluded (GetUserByEmail — the same account under a
 *  private/second address must not co-author itself). The caller feeds the
 *  limited window in upstream's rev-list order (newest-first), so the
 *  emitted trailer lines match upstream's author order. The comparison
 *  derives BOTH ends the same way upstream does (NewGitSig on the poster,
 *  pull.go:798, and the commits' own stored author signatures): the
 *  commit-creation seams stamp `gitSigString` over the D1 row (the
 *  contents-route doerIdentity) so a displayName-differing poster still
 *  matches their own commits. */
async function collectSquashMergeCommitCoAuthors(
  d1: D1Database,
  commits: CommitJson[],
  poster: typeof users.$inferSelect | null,
): Promise<string[]> {
  const posterSig = poster === null ? null : gitSigString(poster);
  const uniqueAuthors = new Set<string>();
  const authors: string[] = [];
  for (const commit of commits) {
    const authorString = `${commit.author.name} <${commit.author.email}>`;
    const first = !uniqueAuthors.has(authorString);
    uniqueAuthors.add(authorString);
    if (!first) continue;
    if (posterSig !== null && authorString === posterSig) continue;
    if (poster !== null && commit.author.email !== null && commit.author.email !== "") {
      const row = (await drizzle(d1).select().from(users).where(eq(users.email, commit.author.email)).get()) ?? null;
      if (row !== null && row.id === poster.id) continue;
    }
    authors.push(authorString);
  }
  return authors;
}

/** `buildSquashMergeCommitMessages` (services/pull/pull.go:777-800) — the
 *  merge message plus the Co-authored-by trailer block, joined through the
 *  trailer-split seam (`---------` separator rule included). */
function buildSquashMergeCommitMessages(mergeMessage: string, coAuthors: string[]): string {
  if (coAuthors.length === 0) return mergeMessage;
  const [rawContent, rawSep, msgTrailer] = commitMessageSplitTrailer(mergeMessage);
  let msgContent = rawContent;
  let msgSep = rawSep;
  if ((msgSep === "" || msgSep === "\n\n") && msgTrailer === "") {
    msgContent = msgContent.replace(/\s+$/, ""); // TrimRightFunc(unicode.IsSpace)
    msgSep = msgContent === "" ? "" : "\n\n---------\n\n";
  }
  let out = msgContent + msgSep;
  const trailer = msgTrailer.trim();
  if (trailer !== "") out += `${trailer}\n`;
  for (const author of coAuthors) out += `Co-authored-by: ${author}\n`;
  return out;
}

/** `User.NewGitSig()`'s name/email pair — GitName is the display name with
 *  the username fallback (gitSafeName's charset fold is a no-op for the
 *  landed D1 names) and GetEmail's keep-private placeholder arm has no
 *  landed reader — the row's email verbatim (mergePerson's own posture),
 *  "" when null.
 *
 *  Shared seam: exported for the contents-route write path
 *  (api/routes/contents.ts doerIdentity) so the commit author stamps and
 *  the co-author exclusion derive from ONE NewGitSig port — upstream
 *  compares `commit.Author.String()` against `Poster.NewGitSig().String()`
 *  (pull.go:798) with both ends produced by NewGitSig (the files service
 *  stamps makeGitUserSignature's `doer.GitName()` / `doer.GetEmail()`,
 *  temp_repo.go:236-250). */
export function gitSigOf(user: { displayName: string | null; username: string; email: string | null }): { name: string; email: string } {
  return {
    name: user.displayName !== null && user.displayName !== "" ? user.displayName : user.username,
    email: user.email ?? "",
  };
}

/** `User.NewGitSig().String()` — `{GitName()} <{GetEmail()}>` over gitSigOf. */
export function gitSigString(user: { displayName: string | null; username: string; email: string | null }): string {
  const sig = gitSigOf(user);
  return `${sig.name} <${sig.email}>`;
}

/** `pr.GetApprovers` (models/issues/pull.go:351-384) — the "Reviewed-by: "
 *  lines for the PR's official approvers: FindLatestReviews' rows (official-
 *  only APPROVE reviews, the DefaultMergeMessageOfficialApproversOnly
 *  default; NOT dismissed-filtered — toCond touches dismissed only when
 *  set) — max(id) PER REVIEWER (review_list.go:141-145's `In("id", Select
 *  max(id) … GroupBy reviewer_id)`) read in Asc("created_unix"), Asc("id")
 *  order (:147-150), so each reviewer's position is their LATEST review's
 *  timestamp (first-review order drifts once re-reviews shuffle). The
 *  `reviewersWritten > maxReviewers` PRE-write break kept bug-for-bug
 *  (10 writes 11 upstream).
 *
 *  Shared seam: exported for the API merge's compose arm
 *  (api/services/pull-engine.ts — upstream's GetDefaultMergeMessage body
 *  half), the same api→page import precedent as squashMergeCommitMessages
 *  above. */
export async function reviewedByLines(d1: D1Database, issueId: number): Promise<string> {
  const rows = await drizzle(d1)
    .select({ id: pullReviews.id, reviewerId: pullReviews.reviewerId, createdAt: pullReviews.createdAt })
    .from(pullReviews)
    .where(and(eq(pullReviews.issueId, issueId), eq(pullReviews.type, ReviewType.Approve), eq(pullReviews.official, true)))
    .orderBy(pullReviews.id)
    .all();
  const latestPerReviewer = new Map<number, { id: number; reviewerId: number; createdAt: Date | null }>();
  for (const row of rows) {
    const known = latestPerReviewer.get(row.reviewerId);
    if (known === undefined || row.id > known.id) latestPerReviewer.set(row.reviewerId, row); // max id = the latest review
  }
  const ordered = [...latestPerReviewer.values()].sort((a, b) => {
    const at = a.createdAt?.getTime() ?? 0;
    const bt = b.createdAt?.getTime() ?? 0;
    return at !== bt ? at - bt : a.id - b.id; // Asc("created_unix"), Asc("id")
  });
  if (ordered.length === 0) return "";
  const reviewers = await drizzle(d1)
    .select({ id: users.id, displayName: users.displayName, username: users.username, email: users.email })
    .from(users)
    .all();
  const byId = new Map(reviewers.map((reviewer) => [reviewer.id, reviewer]));
  let out = "";
  let reviewersWritten = 0;
  for (const review of ordered) {
    if (reviewersWritten > MERGE_MESSAGE_MAX_APPROVERS) break; // the pre-write cap quirk
    const reviewer = byId.get(review.reviewerId);
    if (reviewer === undefined) continue; // LoadReviewer's vanished-row arm
    out += `Reviewed-by: ${gitSigString(reviewer)}\n`;
    reviewersWritten += 1;
  }
  return out;
}

/** `GetDefaultMergeMessage`'s template-less body (services/pull/merge.go:
 *  163-165) — `Reviewed-on: {absolute issue link}\n` + the Reviewed-by
 *  lines. It is the template-less arm's body: the
 *  `.gitea/default_merge_message/*.md` resolution that precedes it lives in
 *  getDefaultMergeMessageParts below (merge.go:116-122). Shared seam:
 *  exported for the API merge's compose arm (api/services/pull-engine.ts),
 *  the same api→page import precedent as the other exported builders. */
export function defaultMergeBodyOf(absoluteIssueLink: string, reviewedBy: string): string {
  return `Reviewed-on: ${absoluteIssueLink}\n${reviewedBy}`;
}

// --- the .gitea/default_merge_message template resolution (merge.go:100-166) --

/** `resolveMergeMessageTemplate` (services/pull/merge.go:150-166): the
 *  style-specific `.gitea/default_merge_message/{UPPER STYLE}_TEMPLATE.md`
 *  off the BASE repo's DEFAULT-BRANCH tip first, the generic
 *  DEFAULT_TEMPLATE.md the fallback; both missing → "" (the template-less
 *  defaults run). GetFileContent's DefaultMergeMessageSize cap truncates the
 *  read at MERGE_MESSAGE_MAX_SIZE bytes (merge.go:153/:160 — the same cap
 *  formatSquashMergeCommitMessages enforces). Engine read failures degrade
 *  to "" (the disclosed err-arm posture — a template read never fails the
 *  render/merge; upstream answers its APIErrorInternal, GetDefaultMergeMessage's
 *  callers log-and-continue on the web side, pull_merge_form.go:73-75). */
async function resolveMergeMessageTemplate(
  reads: EngineReads | undefined,
  repo: { defaultBranch: string },
  style: string,
): Promise<string> {
  if (reads === undefined || style === "") return "";
  const tip = await reads.readCommit(branchRef(repo.defaultBranch));
  if (tip === null) return "";
  for (const path of [`.gitea/default_merge_message/${style.toUpperCase()}_TEMPLATE.md`, ".gitea/default_merge_message/DEFAULT_TEMPLATE.md"]) {
    const blob = await reads.readBlob(tip.oid, path);
    if (blob === null) continue; // IsErrNotExist — the next candidate
    return new TextDecoder().decode(blob.data.slice(0, MERGE_MESSAGE_MAX_SIZE));
  }
  return "";
}

/** `vars.ExpandShellLike` (modules/templates/vars/vars.go:73-79) — `${VAR}`
 *  and `$VAR` replaced from the map, NON-existing keys kept verbatim. The
 *  regexp is upstream's verbatim (`(\$\{[a-zA-Z_]\w*\}|\$[a-zA-Z_]\w*)`); Go
 *  RE2 and JS agree on the leftmost scan and the `\w` class here. */
const SHELL_LIKE_VAR = /(\$\{[a-zA-Z_]\w*\}|\$[a-zA-Z_]\w*)/g;

function expandShellLike(template: string, vars: Record<string, string>): string {
  return template.replace(SHELL_LIKE_VAR, (match) => {
    const key = match.startsWith("${") ? match.slice(2, -1) : match.slice(1);
    const value = vars[key];
    return value === undefined ? match : value;
  });
}

/** `expandDefaultMergeMessage` (services/pull/merge.go:168-175) — the
 *  template's FIRST line is the message, the trimmed remainder the body;
 *  both shell-like expanded. */
function expandDefaultMergeMessage(template: string, vars: Record<string, string>): { title: string; body: string } {
  let title = template.trim();
  let body = "";
  const newline = title.indexOf("\n");
  if (newline !== -1) {
    body = title.slice(newline + 1).trim();
    title = title.slice(0, newline);
  }
  return { title: expandShellLike(title, vars), body: expandShellLike(body, vars) };
}

/** The template vars map (merge.go:88-99). PullRequestPosterName is the
 *  POSTER's username (upstream `pr.Issue.Poster.Name` — the login, not the
 *  git name); PullRequestReference is always `#N` (the external-tracker `!`
 *  arm has no landed source). ClosingIssues (merge.go:102-114) rides the
 *  xref comments: every comment whose ref target is THIS issue with a
 *  closes/reopens action, the LATEST per source issue kept
 *  (ResolveCrossReferences, issue_xref.go:341-366), the close-word "close"
 *  (CloseKeywords[0]), the sources' indices joined ", "; the empty list
 *  sets the var to "" (a template's ${ClosingIssues} renders empty, never
 *  literal — upstream's ResolveCrossReferences ERROR arm is the one that
 *  leaves the key unset and the literal standing). The xref writers are the
 *  push pipeline's open surface — until they land the var reads the rows
 *  that exist and answers "" like upstream's no-refs case. */
async function mergeMessageTemplateVars(
  d1: D1Database,
  repo: { id: string; ownerNamespace: string; slug: string },
  issue: IssueRow,
  pr: PullRequestRow,
  reviewedOn: string,
  reviewedBy: string,
): Promise<Record<string, string>> {
  const vars: Record<string, string> = {
    BaseRepoOwnerName: repo.ownerNamespace,
    BaseRepoName: repo.slug,
    BaseBranch: pr.baseBranch,
    HeadRepoOwnerName: "",
    HeadRepoName: "",
    HeadBranch: pr.headBranch,
    PullRequestTitle: issue.title,
    PullRequestDescription: issue.content ?? "",
    PullRequestPosterName: "",
    PullRequestIndex: String(pr.index),
    PullRequestReference: `#${pr.index}`,
    ReviewedOn: reviewedOn,
    ReviewedBy: reviewedBy,
  };
  const poster = issue.posterId === null ? null : ((await drizzle(d1).select().from(users).where(eq(users.id, issue.posterId)).get()) ?? null);
  vars.PullRequestPosterName = poster?.username ?? "";
  const head = await findRepositoryById(d1, pr.headRepoId);
  if (head !== null) {
    vars.HeadRepoOwnerName = head.repo.ownerNamespace;
    vars.HeadRepoName = head.repo.slug;
  }
  // The xref read guarded (merge.go:101-121): ResolveCrossReferences' ERROR
  // arm leaves vars["ClosingIssues"] UNSET — the template's ${ClosingIssues}
  // renders literal — and the merge message still composes. A failed read
  // here does the same: the key stays off the map, never a failed merge.
  try {
    const refRows = await drizzle(d1)
      .select({ issueId: comments.issueId, refAction: comments.refAction })
      .from(comments)
      .where(and(eq(comments.refRepoId, repo.id), eq(comments.refIssueId, issue.id), inArray(comments.refAction, [1, 2])))
      .orderBy(comments.id)
      .all();
    const latestActionPerSource = new Map<number, number>();
    for (const row of refRows) latestActionPerSource.set(row.issueId, row.refAction ?? 0); // the highest id wins
    const closeSourceIds = [...latestActionPerSource.entries()].filter(([, action]) => action === 1).map(([issueId]) => issueId);
    let closingIssues = "";
    if (closeSourceIds.length > 0) {
      const sources = await drizzle(d1).select({ id: issues.id, index: issues.index }).from(issues).where(inArray(issues.id, closeSourceIds)).all();
      const indexById = new Map(sources.map((row) => [row.id, row.index]));
      closingIssues = closeSourceIds.map((issueId) => `close #${indexById.get(issueId) ?? 0}`).join(", ");
    }
    vars.ClosingIssues = closingIssues;
  } catch {
    // the error arm: the key stays unset (the var-expander keeps the literal)
  }
  return vars;
}

/** `GetDefaultMergeMessage` (services/pull/merge.go:54-165) — the title/body
 *  PAIR both merge-message surfaces compose from: the template resolution
 *  first (resolveMergeMessageTemplate — a found template's first line IS the
 *  title and its remainder the body, merge.go:123-125, replacing the
 *  defaults wholesale), then the template-less defaults (rebase →
 *  `("", "")` — the fast-forward rebase amends nothing, :127-130; squash →
 *  `{title} (#{index})`, :132-134; else the merge sentence with the
 *  fork/deleted-head shapes, :136-148) over the `Reviewed-on`/`Reviewed-by`
 *  body (:163-165).
 *
 *  Shared seam: the merge box's render prefill (upstream's own box calls
 *  GetDefaultMergeMessage per style, pull_merge_form.go:70-81) and the API
 *  merge's compose arm (api/services/pull-engine.ts composeMergeMessage)
 *  consume this one builder so the two stay byte-equal (`pull.tests` pins
 *  it). The optional `reads` seam degrades the template resolution to the
 *  template-less path (the box loader's err-arm posture). */
export async function getDefaultMergeMessageParts(
  d1: D1Database,
  source: {
    repo: { id: string; ownerNamespace: string; slug: string; defaultBranch: string };
    issue: IssueRow;
    pr: PullRequestRow;
    reads?: EngineReads;
    origin: string;
  },
  style: string,
): Promise<{ title: string; body: string }> {
  const { repo, issue, pr, reads, origin } = source;
  const issueLink = `/${repo.ownerNamespace}/${repo.slug}/pulls/${pr.index}`;
  const reviewedOn = `Reviewed-on: ${origin}${issueLink}`;
  const reviewedBy = await reviewedByLines(d1, issue.id);

  const template = await resolveMergeMessageTemplate(reads, repo, style);
  if (template !== "") {
    const vars = await mergeMessageTemplateVars(d1, repo, issue, pr, reviewedOn, reviewedBy);
    return expandDefaultMergeMessage(template, vars);
  }

  if (style === "rebase") {
    // fast-forward rebase: upstream returns ("", "") — no amend, no message.
    return { title: "", body: "" };
  }
  const body = defaultMergeBodyOf(`${origin}${issueLink}`, reviewedBy);
  if (style === "squash") {
    return { title: `${issue.title} (#${pr.index})`, body };
  }
  if (pr.headRepoId === pr.baseRepoId) {
    return { title: `Merge pull request '${issue.title}' (#${pr.index}) from ${pr.headBranch} into ${pr.baseBranch}`, body };
  }
  const head = await findRepositoryById(d1, pr.headRepoId);
  const from = head === null ? `<deleted>:${pr.headBranch}` : `${head.repo.ownerNamespace}/${head.repo.slug}:${pr.headBranch}`;
  return { title: `Merge pull request '${issue.title}' (#${pr.index}) from ${from} into ${pr.baseBranch}`, body };
}

/** `GetSquashMergeCommitMessages` (services/pull/pull.go:723-775) over the
 *  optional `reads` seam — the mergeBase..head walk (the row's cached
 *  merge base first, the engine RPC the fallback: pullRequestDiff's own
 *  order, pull-commits.tsx's composition), then the
 *  DefaultSquashMergeMessage switch (COMMIT_MESSAGES bullet list | PR_BODY
 *  text | BLANK — models/repo/git.go:46-48) and the co-author trailers.
 *  Every unresolvable read degrades to "" exactly like upstream's err arm
 *  (the props stay "", pull_merge_form.go:77-83). The >50-commit window is
 *  upstream-exact within MERGE_MESSAGE_COMMITS_WALK_CEILING (the newest-50
 *  slice below); past the ceiling the oldest-first page survives as the
 *  module header's disclosed residual.
 *
 *  Shared seam: the API merge's compose arm (api/services/pull-engine.ts —
 *  upstream's routers/api/v1/repo/pull.go:969-983 GetSquashMergeCommitMessages
 *  call) consumes this exact builder, mirroring the established api→page
 *  import precedent (services/upload-staging.ts → pages/repo-editor-tails);
 *  the back-edge is lazy (call-time bindings only — pull-merge-box imports
 *  composeMergeMessage from the same module it exports to). The input is the
 *  minimal slice (issue/pr/reads) the walk reads, not the full box input. */
export async function squashMergeCommitMessages(
  d1: D1Database,
  seam: { issue: IssueRow; pr: PullRequestRow; reads?: EngineReads },
  defaultSquashMergeMessage: string,
): Promise<string> {
  const { issue, pr, reads } = seam;
  if (reads === undefined) return "";
  const baseTip = await reads.readCommit(branchRef(pr.baseBranch));
  const headCommit = await reads.readCommit(pullHeadRef(pr.index));
  if (baseTip === null || headCommit === null) return "";
  const mergeBase =
    pr.mergeBase ??
    (await (async () => {
      const merged = await reads.mergeBase(baseTip.oid, headCommit.oid);
      return merged !== null && merged.tag === "ok" ? merged.base : null;
    })());
  if (mergeBase === null) return ""; // unrelated histories: the empty range rule
  // The NEWEST-50 window (the walk-ceiling fix): upstream's walk is one
  // `rev-list --max-count 50 base..head` (pull.go:759-761 → CommitsBetween,
  // repo_commit.go:319-340 — newest-first, the newest 50 kept). The engine's
  // listCommitsRange answers the whole in-range set OLDEST-first and slices
  // pages from that end, so the window is carved by reading the range at the
  // WALK CEILING and taking the tail: exact for every range that fits the
  // ceiling (the old code read the oldest-first FIRST page and held the
  // oldest 50 — the bullet SET drifted past 50 commits). Ranges past the
  // ceiling keep the oldest-first page (the pre-fix posture, disclosed in
  // the module header — the ceiling bounds the CommitJson materialization;
  // the engine walk's own budget is 50k visits, unreachable here).
  const range = await reads.listCommitsRange(mergeBase, headCommit.oid, MERGE_MESSAGE_COMMITS_WALK_CEILING, 0);
  const window = (range?.commits ?? []).slice(-MERGE_MESSAGE_COMMITS_LIMIT);
  let mergeMessage: string;
  switch (defaultSquashMergeMessage) {
    case "COMMIT_MESSAGES":
      // Upstream formats slices.Backward over the newest-first rev-list
      // answer (pull.go:854-855) — the OLDEST-first emission the window
      // already carries.
      mergeMessage = formatSquashMergeCommitMessages(window);
      break;
    case "PR_BODY":
      mergeMessage = issue.content?.trim() ?? "";
      break;
    default:
      mergeMessage = ""; // "BLANK"
  }
  const poster =
    issue.posterId === null ? null : ((await drizzle(d1).select().from(users).where(eq(users.id, issue.posterId)).get()) ?? null);
  // The co-author scan iterates the LIMITED list in upstream's rev-list order
  // (newest-first — pull.go:796's plain `for _, commit := range limitedCommits`),
  // so the trailer lines carry the newest commit's author first.
  const coAuthors = await collectSquashMergeCommitCoAuthors(d1, window.slice().reverse(), poster);
  return buildSquashMergeCommitMessages(mergeMessage, coAuthors);
}

/** The scheduled auto-merge's render shape (GetScheduledMergeByPullID's doer
 *  join, pull_merge_form.go:55-65 — hasPendingPullRequestMerge + the tip's
 *  doer name and created stamp). */
async function pendingAutoMergeOf(d1: D1Database, issueId: number): Promise<{ doerName: string; createdUnix: number } | null> {
  const row = await getScheduledAutoMerge(d1, issueId);
  if (row === null) return null;
  const doer = (await drizzle(d1).select({ username: users.username }).from(users).where(eq(users.id, row.doerId)).get()) ?? null;
  return { doerName: doer?.username ?? "", createdUnix: row.createdUnix };
}

/**
 * Load the merge box's render inputs. `null` = the route does not render the
 * fragment: the issue is not a pull (upstream's 404), or the PR has merged
 * WITHOUT a deletable head branch (ShowMergeBox = `!HasMerged ||
 * IsPullBranchDeletable` — the merged arm above). Closed-unmerged PRs DO
 * render (the closed arm), exactly like upstream.
 */
export async function loadPullMergeBoxData(d1: D1Database, input: PullMergeBoxInput): Promise<PullMergeBoxData | null> {
  const { repo, issue, pr, viewer, origin } = input;
  if (!issue.isPull) return null; // ViewPullMergeBox's !issue.IsPull → NotFound

  const issueLink = `/${repo.ownerNamespace}/${repo.slug}/pulls/${issue.index}`;
  const isClosed = issue.isClosed;
  const isChecking = pr.status === PRStatus.Checking;
  const isConflicted = pr.status === PRStatus.Conflict; // IsFilesConflicted
  const isMergeable = pr.status === PRStatus.Mergeable; // IsStatusMergeable
  const isEmpty = pr.status === PRStatus.Empty; // IsEmpty
  const isAncestor = pr.status === PRStatus.Ancestor; // IsAncestor
  const isWorkInProgress = hasWorkInProgressPrefix(issue.title);

  // The head repo row (fork or same-repo). Missing row = the broken arm
  // (upstream's deleted-fork IsPullRequestBroken; module doc).
  const headRepo = await findRepositoryById(d1, pr.headRepoId);
  const headTarget = headTargetOf(repo, headRepo === null ? null : headRepo.repo, pr);

  // --- the doer's access pair (the merge route's own port,
  // principalAccessOfRow) — computed before the arm split now: the merged
  // arm's delete gate reads it too (upstream's prepareMergeBox resolves the
  // doer permission before any arm splits, issue_view.go:888-931).
  const access: PrincipalAccess =
    viewer.kind === "user"
      ? await principalAccessOfRow(d1, repo, { id: viewer.id, username: viewer.username, isAdmin: viewer.isAdmin })
      : { userId: 0, write: false, admin: false };

  // --- the MERGED arm (ShowMergeBox = !HasMerged || IsPullBranchDeletable,
  // issue_view.go:974): with the cleanup POST landed the box exists again for
  // a merged PR whose head branch can go — the merged ClosedInfo pair plus
  // the delete button (prepareMergeBoxInfoItems' merged arm,
  // pull_merge_box.go:93-97). A non-deletable merged PR answers null (the
  // ShowMergeBox=false empty fragment — "there is nothing to do",
  // issue_view.go:974's own comment).
  if (pr.hasMerged) {
    const deletable = await pullBranchDeletable(d1, input, access, headRepo, true);
    if (!deletable) return null;
    return {
      issueLink,
      reloadingInterval: 0,
      timelineIconClass: "tw-text-purple", // prepareMergeBoxIconColor's merged arm — reachable again
      closedInfo: {
        title: pullMergeWriteLocale.merged_success,
        bodyCode: { prefix: pullMergeWriteLocale.merged_info_prefix, code: headTarget, suffix: pullMergeWriteLocale.merged_info_suffix },
      },
      statusChecks: null,
      infoSections: [],
      isWorkInProgress,
      commands: null,
      mergeForm: null,
      updateBranch: null,
      deleteBranch: { link: `${issueLink}/cleanup`, headTarget },
    };
  }

  // --- the status-check section (prepareMergeBoxStatusCheckData, pull.go:397)
  // Open PRs with a resolvable head sha only (the headCommitID=="" and
  // IsClosed early returns).
  let statusChecks: PullMergeBoxStatusCheckData | null = null;
  let pullCommitStatusState: CommitStatusState | null = null; // "" upstream when no statuses
  let requiredChecksState: CommitStatusState = "pending"; // MergeRequiredContexts' empty-statuses arm
  let enableStatusCheck = false;
  let hasRequiredStatusContexts = false;
  const config: ProtectedBranchConfig | null = await findRule(d1, repo.id, pr.baseBranch).then((rule) =>
    rule === null ? null : parseRuleConfig(rule.rules),
  );
  if (!isClosed && pr.headSha !== null && pr.headSha !== "") {
    const statuses: CommitStatusRow[] = (await latestCommitStatuses(d1, repo.id, pr.headSha, 1, STATUS_CHECKS_LIMIT)).items;
    enableStatusCheck = config?.enableStatusCheck ?? false;
    hasRequiredStatusContexts = (config?.statusCheckContexts ?? []).length > 0;
    const requiredContexts = config?.statusCheckContexts ?? [];
    pullCommitStatusState = statuses.length > 0 ? combinedStateOf(statuses) : null;
    requiredChecksState = mergeRequiredContextsCommitStatus(statuses, requiredContexts);
    const showStatusCheck = enableStatusCheck || hasRequiredStatusContexts || statuses.length > 0;
    if (showStatusCheck) {
      statusChecks = {
        prompt: statusCheckPrompt(requiredChecksState, pullCommitStatusState ?? "pending"),
        items: statuses.map((row) => ({
          state: row.state,
          context: row.context,
          description: row.description ?? "",
          targetUrl: row.targetUrl ?? "",
          required: requiredContexts.some((pattern) => contextMatchesRequired(pattern, row.context)),
        })),
        missingRequired: requiredContexts.filter(
          (pattern) => !statuses.some((row) => contextMatchesRequired(pattern, row.context)),
        ),
      };
    }
  }

  // --- the closed arm (prepareMergeBoxInfoItems' early returns) ------------
  // Closed PRs render the ClosedInfo pair INSTEAD of every blocker/prompt
  // section; the status section already skipped above. The closed body's
  // cant_reopen_deleted_branch arm needs the deleted-branch check (an engine
  // read the loader declines) — reopen_to_merge always (module doc).
  if (isClosed) {
    return {
      issueLink,
      reloadingInterval: isChecking ? 5000 : 0,
      timelineIconClass: "tw-text-text-light", // showAsNormalColor wins first
      closedInfo: { title: pullMergeBoxLocale.closed, body: pullMergeBoxLocale.reopen_to_merge },
      statusChecks: null,
      infoSections: [],
      isWorkInProgress,
      commands: null, // ShowPullCommands requires the open state
      mergeForm: null,
      updateBranch: null,
      deleteBranch: null,
    };
  }

  // IsUserAllowedToMerge's landed shape (the API merge route's two gates):
  // base write always, then the rule's merge whitelist.
  const hasPermToMerge = access.write && (config === null || (await isUserMergeWhitelisted(d1, config, access)));

  // --- the protection blockers (prepareMergeBoxProtectionChecks) -----------
  // The four landed predicates in upstream's render order; the code-owner and
  // protected-file arms have no landed predicate (module doc). The individual
  // flags feed hasOverridableBlockers below (one evaluation, no re-queries).
  const commitBlockers: PullMergeBoxInfoItem[] = [];
  const protectionBlockers: PullMergeBoxInfoItem[] = [];
  const mergePrompts: PullMergeBoxInfoItem[] = [];

  let isBlockedByApprovals = false;
  let isBlockedByOutdatedBranch = false;
  if (config !== null && config.requiredApprovals > 0) {
    const granted = await grantedApprovalsCount(d1, issue.id, config);
    isBlockedByApprovals = granted < config.requiredApprovals;
    if (isBlockedByApprovals) {
      protectionBlockers.push({
        icon: "octicon-x",
        iconClass: "tw-text-red",
        info: blockedByApprovalsText(config, granted),
        listItems: [],
      });
    }
  }
  const isBlockedByRejection = await mergeBlockedByRejectedReview(d1, issue.id);
  if (isBlockedByRejection) {
    protectionBlockers.push({
      icon: "octicon-x",
      iconClass: "tw-text-red",
      info: pullMergeBoxLocale.blocked_by_rejection,
      listItems: [],
    });
  }
  const isBlockedByOfficialReviewRequests = await mergeBlockedByOfficialReviewRequests(d1, issue.id);
  if (isBlockedByOfficialReviewRequests) {
    protectionBlockers.push({
      icon: "octicon-x",
      iconClass: "tw-text-red",
      info: pullMergeBoxLocale.blocked_by_official_review_requests,
      listItems: [],
    });
  }
  if (config !== null) {
    isBlockedByOutdatedBranch = mergeBlockedByOutdatedBranch(config, pr.commitsBehind ?? 0);
  }
  if (isBlockedByOutdatedBranch) {
    protectionBlockers.push({
      icon: "octicon-x",
      iconClass: "tw-text-red",
      info: pullMergeBoxLocale.blocked_by_outdated_branch,
      listItems: [],
    });
  }
  // The required-check blocker items (pull.go:487-493) — the stored rule
  // config's state, DISPLAY of a gate our merge route does not enforce
  // (module doc).
  const hasStatusCheckBlocker =
    (enableStatusCheck || hasRequiredStatusContexts) &&
    (requiredChecksState === "failure" || requiredChecksState === "error");
  if (enableStatusCheck || hasRequiredStatusContexts) {
    if (hasStatusCheckBlocker) {
      protectionBlockers.push({
        icon: "octicon-x",
        iconClass: "tw-text-red",
        info: pullMergeBoxLocale.required_status_check_failed,
        listItems: [],
      });
    } else if (requiredChecksState !== "success") {
      protectionBlockers.push({
        icon: "octicon-x",
        iconClass: "tw-text-red",
        info: pullMergeBoxLocale.required_status_check_missing,
        listItems: [],
      });
    }
  }

  // --- the commit blockers (prepareMergeBoxInfoItems' first arms) ----------
  if (isConflicted) {
    const files = conflictedFilesOf(pr);
    let detailItems = files.slice(0, CONFLICTED_FILES_CAP);
    if (detailItems.length === 0) detailItems = [pullMergeBoxLocale.files_conflicted_no_listed_files];
    if (files.length > CONFLICTED_FILES_CAP) {
      detailItems = detailItems.slice(0, CONFLICTED_FILES_CAP);
      detailItems = [...detailItems, "..."];
    }
    commitBlockers.push({ icon: "octicon-x", info: pullMergeBoxLocale.files_conflicted, listItems: detailItems });
  }
  if (headRepo === null) {
    commitBlockers.push({ icon: "octicon-x", info: pullMergeBoxLocale.data_broken, listItems: [] });
  }
  if (isChecking) {
    commitBlockers.push({
      icon: "gitea-running",
      iconClass: "rotate-clockwise",
      info: pullMergeBoxLocale.is_checking,
      listItems: [],
    });
  }
  if (isAncestor) {
    commitBlockers.push({ icon: "octicon-alert", info: pullMergeBoxLocale.is_ancestor, listItems: [] });
  }
  if (isEmpty) {
    // The protection-level empty arm (pull_merge_box.go:144-151).
    protectionBlockers.push({ icon: "octicon-alert", info: pullMergeBoxLocale.is_empty, listItems: [] });
  } else if (!isMergeable && !isConflicted) {
    // The Error-class arm: !IsStatusMergeable past the conflicted/empty
    // special cases — the cannot-auto-merge pair.
    protectionBlockers.push({
      icon: "octicon-x",
      iconClass: "tw-text-red",
      info: pullMergeBoxLocale.cannot_auto_merge_desc,
      listItems: [],
    });
    protectionBlockers.push({ icon: "octicon-info", info: pullMergeBoxLocale.cannot_auto_merge_helper, listItems: [] });
  }
  if (!hasPermToMerge) {
    protectionBlockers.push({ icon: "octicon-info", info: pullMergeBoxLocale.no_merge_access, listItems: [] });
  }

  // --- canMergeNow (issue_view.go:1020-1026 over the landed gate) ----------
  // The signing half is dropped (module doc).
  const hasOverridableBlockers =
    isBlockedByApprovals || isBlockedByRejection || isBlockedByOfficialReviewRequests || isBlockedByOutdatedBranch || hasStatusCheckBlocker;
  // canBypassProtection (issue_view.go:1007-1015 over the landed predicate):
  // the force_merge escape's own port.
  const canBypassProtection = config !== null && (await canBypassBranchProtection(d1, config, access));
  const canMergeNow = !hasOverridableBlockers || canBypassProtection;

  if (canMergeNow && hasOverridableBlockers) {
    // The bypass prompt's text arm: the administrator form when the doer IS
    // the unblocked repo admin (upstream's ctx.Repo.Permission.IsAdmin —
    // owner/admin-collaborator/site-admin through the access pair), the
    // allowlist form otherwise (canBypassProtectionAsAdmin =
    // IsAdmin && !BlockAdminMergeOverride).
    const asAdmin = access.admin && !(config?.blockAdminMergeOverride ?? false);
    mergePrompts.push({
      icon: "octicon-dot-fill",
      info: asAdmin
        ? pullMergeBoxLocale.required_status_check_administrator
        : pullMergeBoxLocale.required_status_check_bypass_allowlist,
      listItems: [],
    });
  } else if (canMergeNow && (isMergeable || isEmpty)) {
    mergePrompts.push({ icon: "octicon-check", info: pullMergeBoxLocale.can_auto_merge_desc, listItems: [] });
  }

  // The template renders the FIRST non-empty collection only
  // (pull_merge_box.go:185-190).
  const infoSections: PullMergeBoxInfoItem[][] = [];
  infoSections.push(commitBlockers.length > 0 ? commitBlockers : protectionBlockers);
  infoSections.push(mergePrompts);

  const timelineIconClass = mergeBoxIconClass({
    isClosed,
    isWorkInProgress,
    isEmpty,
    isConflicted,
    isChecking,
    pullCommitStatusState,
    requiredChecksState,
    enableStatusCheck,
    hasRequiredStatusContexts,
    hasBlockers: commitBlockers.length > 0 || protectionBlockers.length > 0,
    isMergeable,
  });

  // --- the command instructions (ShowPullCommands) --------------------------
  // `pull.HeadRepo != nil && !HasMerged && !issue.IsClosed` — the head-repo
  // row doubles as the broken guard (broken PRs render no instructions,
  // exactly upstream's nil-HeadRepo arm).
  let commands: PullMergeBoxCommands | null = null;
  if (headRepo !== null) {
    // ShowMergeInstructions = canWriteToHeadRepo (issue_view.go:942): the
    // same-repo arm inherits the base write; a fork head needs the write IN
    // the head repo (maintainer-edit grants nothing there — the fork delete
    // arm's reading in pull-engine.ts).
    let canWriteToHeadRepo = pr.headRepoId === pr.baseRepoId && access.write;
    if (pr.headRepoId !== pr.baseRepoId) {
      const headAccess =
        viewer.kind === "user"
          ? await principalAccessOfRow(d1, headRepo.repo, { id: viewer.id, username: viewer.username, isAdmin: viewer.isAdmin })
          : { userId: 0, write: false, admin: false };
      canWriteToHeadRepo = headAccess.write;
    }
    // GetInstructionsCliArgs (models/issues/pull.go:410-423): the fork head's
    // local branch gains the `{ownerName}-` prefix (the owner name escaped
    // separately, exactly upstream's string concat).
    const baseBranchArg = shellEscape(pr.baseBranch);
    const headBranchArg = shellEscape(pr.headBranch);
    const isFork = pr.headRepoId !== pr.baseRepoId;
    const localBranchArg = isFork ? `${shellEscape(headRepo.repo.ownerNamespace)}-${headBranchArg}` : headBranchArg;
    const remote = pullMergeBoxLocale.git_guide_remote_name;
    // flow == Github: same-repo fetches the guide remote, a fork fetches the
    // fork's HTMLURL; the AGit flow fetches the PR ref directly
    // (pull_merge_instruction.tmpl:15-19).
    const checkoutLines =
      pr.flow !== PRFlow.Github
        ? [`git fetch -u ${remote} refs/pull/${pr.index}/head:${localBranchArg}`, `git checkout ${localBranchArg}`]
        : isFork
          ? [
              `git fetch -u ${origin}/${headRepo.repo.ownerNamespace}/${headRepo.repo.slug} ${headBranchArg}:${localBranchArg}`,
              `git checkout ${localBranchArg}`,
            ]
          : [`git fetch -u ${remote} ${headBranchArg}:${localBranchArg}`, `git checkout ${localBranchArg}`];
    const mergeBlocks: PullMergeBoxCommands["mergeBlocks"] = canWriteToHeadRepo
      ? [
          { style: "merge", lines: [`git checkout ${baseBranchArg}`, `git merge --no-ff ${localBranchArg}`], hidden: false },
          { style: "rebase", lines: [`git checkout ${baseBranchArg}`, `git merge --ff-only ${localBranchArg}`], hidden: true },
          {
            style: "rebase-merge",
            lines: [
              `git checkout ${localBranchArg}`,
              `git rebase ${baseBranchArg}`,
              `git checkout ${baseBranchArg}`,
              `git merge --no-ff ${localBranchArg}`,
            ],
            hidden: true,
          },
          { style: "squash", lines: [`git checkout ${baseBranchArg}`, `git merge --squash ${localBranchArg}`], hidden: true },
          { style: "fast-forward-only", lines: [`git checkout ${baseBranchArg}`, `git merge --ff-only ${localBranchArg}`], hidden: true },
          { style: "manually-merged", lines: [`git checkout ${baseBranchArg}`, `git merge ${localBranchArg}`], hidden: true },
        ]
      : [];
    commands = {
      checkoutLines,
      mergeBlocks,
      mergePushLine: canWriteToHeadRepo ? `git push ${remote} ${baseBranchArg}` : null,
      showMergeWarning: canWriteToHeadRepo, // AutodetectManualMerge has no source → upstream default false → warning on
    };
  }

  // --- the write-arm data (the census gap #2 section) ----------------------
  // The merge form's allowed styles — prepareMergeBoxFormProps's mergeStyles
  // array (pull_merge_form.go:126-170) over the STORED PR-unit allowlist
  // (repo_settings.ts's PullRequestsConfig, upstream repo_unit.go:119-137's
  // Go-marshal keys): each Allow* flag gates its entry, fast-forward-only
  // additionally needs CommitsBehind == 0 (:161), and manually-merged rides
  // canUseManualMerge = !WIP && !IsChecking && AllowManualMerge (:162-168).
  // The PR-unit config has its D1 home now (the repo_units config store), so
  // the old config-defaults reduction is retired.
  const prConfig = (await loadRepoSettings(d1, repo.id)).prUnit;
  const ffAllowed = (pr.commitsBehind ?? 0) === 0;
  // The five default styles render only for a status-mergeable or empty PR
  // (pull_merge_form.go:126's `IsStatusMergeable() || IsEmpty()` array gate);
  // manually-merged appends OUTSIDE it — the feature exists to close out
  // non-mergeable (conflicted) work, pull_merge_form.go:158-163.
  const stylesRenderable = isMergeable || isEmpty;
  const styleOptions: { name: string; text: string; hideMessageFields: boolean }[] = [
    ...(stylesRenderable && prConfig.AllowMerge ? [{ name: "merge", text: pullMergeWriteLocale.merge_pull_request, hideMessageFields: false }] : []),
    ...(stylesRenderable && prConfig.AllowRebase ? [{ name: "rebase", text: pullMergeWriteLocale.rebase_merge_pull_request, hideMessageFields: true }] : []),
    ...(stylesRenderable && prConfig.AllowRebaseMerge
      ? [{ name: "rebase-merge", text: pullMergeWriteLocale.rebase_merge_commit_pull_request, hideMessageFields: false }]
      : []),
    ...(stylesRenderable && prConfig.AllowSquash ? [{ name: "squash", text: pullMergeWriteLocale.squash_merge_pull_request, hideMessageFields: false }] : []),
    ...(stylesRenderable && prConfig.AllowFastForwardOnly && ffAllowed
      ? [{ name: "fast-forward-only", text: pullMergeWriteLocale.fast_forward_only_merge_pull_request, hideMessageFields: true }]
      : []),
    // The manual mark's render arm (pull_merge_form.go:162-168): the settings
    // gate AND the WIP/checking exclusions, hideMergeMessageTexts +
    // hideAutoMerge like upstream.
    ...(!isWorkInProgress && !isChecking && prConfig.AllowManualMerge
      ? [{ name: "manually-merged", text: pullMergeWriteLocale.merge_manually, hideMessageFields: true }]
      : []),
  ];
  // The preselected style — prepareMergeBoxFormProps's ladder (pull_merge_form
  // .go:29-46): the stored DefaultMergeStyle when allowed, else the first
  // allowed entry (the fallback walks merge → rebase → rebase-merge → squash
  // → fast-forward-only → manually-merged, which is styleOptions' own order).
  const defaultStyle = styleOptions.some((style) => style.name === prConfig.DefaultMergeStyle)
    ? prConfig.DefaultMergeStyle
    : (styleOptions[0]?.name ?? "");
  // An EMPTY allowlist renders no form: the no_merge_desc/no_merge_helper
  // blocker pair replaces it — pull_merge_form.go:171-180's `else if
  // (IsStatusMergeable || IsEmpty)` branch, so the pair explains a MERGEABLE
  // PR whose every style is disabled (a non-mergeable row's state blockers
  // already do; a non-writer sees only the access item, the builder's
  // hasPermToMerge early return).
  if (hasPermToMerge && styleOptions.length === 0 && stylesRenderable) {
    commitBlockers.push({ icon: "octicon-x", info: pullMergeWriteLocale.no_merge_desc, listItems: [] });
    commitBlockers.push({ icon: "octicon-info", info: pullMergeWriteLocale.no_merge_helper, listItems: [] });
    infoSections[0] = commitBlockers;
  }
  // The unresolved-dependency readiness gate — the write ladder's
  // issueNoDependenciesLeft arm (check.go:219-223, the merge POST's
  // ErrDependenciesLeft → pr_close_blocked flash, web pull.go:1088-1090),
  // surfaced as the commit-blocker item + the disabled submit below. Upstream's
  // box itself renders no deps item (the deps list is the issue sidebar's,
  // BlockedByDependencies over issue_dependencies.tmpl, issue_view.go:501-507);
  // this gate is the box's readiness face for the same condition the POST
  // refuses.
  const blockedByDependencies = hasPermToMerge && !(await issueNoDependenciesLeft(d1, issue.id));
  if (blockedByDependencies) {
    commitBlockers.push({
      icon: "octicon-x",
      iconClass: "tw-text-red",
      info: pullMergeWriteLocale.dependencies_left,
      listItems: [],
    });
    infoSections[0] = commitBlockers;
  }
  // The delete-branch checkbox + the merged-box twin's gate
  // (prepareMergeBoxDeleteBranch for the open arm: canDelete + the branch
  // exists — no tip check and no shared-head check until closed).
  const openBranchDeletable = await pullBranchDeletable(d1, input, access, headRepo, false);
  // The update-branch arm (ShowUpdatePullInfo, issue_view.go:889 + the
  // preparePullUpdateActions buttons): behind, open, past the checking/
  // conflicted states, unbroken, same-repo (updatePullRequestBranch's fork
  // refusal), and the doer holds at least one update style.
  const updateStyles = await checkUserAllowedToUpdate(d1, repo, headRepo, issue, pr, access, viewer);
  const showUpdatePullInfo =
    (pr.commitsBehind ?? 0) > 0 && !isChecking && !isConflicted && headRepo !== null && pr.headRepoId === pr.baseRepoId && (updateStyles.mergeAllowed || updateStyles.rebaseAllowed);
  const updateOptions: { style: "merge" | "rebase"; text: string; url: string }[] = [];
  if (showUpdatePullInfo) {
    if (updateStyles.mergeAllowed) {
      updateOptions.push({ style: "merge", text: pullMergeWriteLocale.update_branch, url: `${issueLink}/update?style=merge` });
    }
    if (updateStyles.rebaseAllowed) {
      updateOptions.push({ style: "rebase", text: pullMergeWriteLocale.update_branch_rebase, url: `${issueLink}/update?style=rebase` });
    }
  }

  // --- the merge message body prefill (prepareMergeBoxFormProps:67-84) ------
  // Upstream computes the defaults under `!prInfo.IsPullRequestBroken` (the
  // deleted-fork gate — merge.go's broken rows prefill NOTHING, titles
  // included); the body half carries that gate (headRepo !== null) while the
  // landed title keeps its unbroken shape (disclosed above the field). The
  // SELECTED style's GetDefaultMergeMessage PAIR rides the shared builder
  // (getDefaultMergeMessageParts — the template resolution first, the
  // template-less defaults over the Reviewed-on/Reviewed-by body), the same
  // builder the write path's composeMergeMessage consumes, so an unedited
  // no-JS submit stores upstream's message byte-for-byte (web pull.go:1126-
  // 1129 posts the field back verbatim). Body: merge/rebase-merge carry the
  // bare Reviewed-on trailer block, squash the
  // CommitMessageMerge(GetSquashMergeCommitMessages, body) composition
  // (pull_merge_form.go:122/137/145). The hidden-fields styles
  // (rebase/fast-forward-only/manually-merged) carry none. The builder runs
  // once, lazily — only when the body arm or the form actually needs it.
  let partsCache: Promise<{ title: string; body: string }> | null = null;
  const defaultPartsOf = () =>
    (partsCache ??= getDefaultMergeMessageParts(d1, { repo, issue, pr, reads: input.reads, origin }, defaultStyle));
  let defaultBody = "";
  if (headRepo !== null && (defaultStyle === "merge" || defaultStyle === "rebase-merge" || defaultStyle === "squash")) {
    defaultBody =
      defaultStyle === "squash"
        ? commitMessageMerge(await squashMergeCommitMessages(d1, input, prConfig.DefaultSquashMergeMessage), (await defaultPartsOf()).body)
        : (await defaultPartsOf()).body;
  }

  return {
    issueLink,
    reloadingInterval: isChecking ? 5000 : 0,
    timelineIconClass,
    closedInfo: null,
    statusChecks,
    infoSections,
    isWorkInProgress,
    commands,
    mergeForm: hasPermToMerge && styleOptions.length > 0
      ? {
          issueLink,
          headCommitId: pr.headSha ?? "",
          forceMerge: canMergeNow && hasOverridableBlockers, // the Vue forceMerge computed
          styles: styleOptions,
          defaultStyle,
          // The SELECTED style's composed default (getDefaultMergeMessageParts'
          // title — the template's first line, else the template-less shape):
          // merge/rebase-merge carry the merge sentence, squash the
          // `{title} (#{index})` shape, rebase "" (the hidden-fields styles
          // never show it).
          defaultTitle: (await defaultPartsOf()).title,
          // The SELECTED style's message BODY prefill (the mergeStyle
          // detail's mergeMessageFieldText, pull_merge_form.go:122/137/145 —
          // the CommitMessageMerge composition for squash, the bare
          // Reviewed-on block for merge/rebase-merge, "" for the
          // hidden-fields styles and the broken rows). The style-switch
          // swaps it alongside the title (defaultStyle drives both).
          defaultBody,
          isPullBranchDeletable: openBranchDeletable,
          headTarget,
          mergeWhenChecksSucceed: !canMergeNow, // the Vue autoMergeWhenSucceed reduction
          blockedByDependencies,
          pendingAutoMerge: await pendingAutoMergeOf(d1, issue.id),
        }
      : null,
    updateBranch: updateOptions.length > 0 ? { options: updateOptions } : null,
    deleteBranch: null,
  };
}

// ---------------------------------------------------------------------------
// The fragment render — pull_merge_box.tmpl arm for arm
// ---------------------------------------------------------------------------

/** One info item's line + optional detail list (the `{{range $infoItem}}`
 *  inner range: `.flex-text-block` icon+text, then `ul.tw-pl-[36px]`). */
function InfoItem(props: { item: PullMergeBoxInfoItem }) {
  return (
    <>
      <div class="flex-text-block">
        <MergeBoxSvg name={props.item.icon} extraClass={props.item.iconClass} /> {props.item.info}
      </div>
      {props.item.listItems.length > 0 ? (
        <ul class="tw-pl-[36px]">
          {props.item.listItems.map((listItem, index) => (
            <li key={index}>{listItem}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** One status row's state icon (`repo/icons/commit_status.tmpl`'s exact
 *  state→icon/color matrix; the `$actionStatus` Actions arm never renders —
 *  no Actions runs). */
function StatusItemIcon(props: { state: CommitStatusState }) {
  const [name, extraClass] =
    props.state === "pending"
      ? ["octicon-dot-fill", "tw-text-yellow"]
      : props.state === "success"
        ? ["octicon-check", "tw-text-green"]
        : props.state === "error"
          ? ["gitea-exclamation", "tw-text-red"]
          : props.state === "failure"
            ? ["octicon-x", "tw-text-red"]
            : props.state === "warning"
              ? ["gitea-exclamation", "tw-text-yellow"]
              : ["octicon-skip", "tw-text-text-light"]; // skipped
  return <MergeBoxSvg name={name} size={18} extraClass={`commit-status icon ${extraClass}`} />;
}

/**
 * The tplPullMergeBox fragment's DOM as a JSX component — the SECOND mount
 * of this module: the conversation page (pages/issue-detail.tsx) renders it
 * INLINE in its timeline (upstream view_content.tmpl:67-72 renders the
 * template server-side beside the fragment route, which only exists so the
 * bundle's reload loop can refetch). Byte-identical with
 * pullMergeBoxFragmentHtml's output by construction — the html builder wraps
 * this component in renderToString.
 */
/** The preselected style option (the Vue onMounted default: the default style
 *  when allowed, else the first allowed — pull_merge_form.go's default is
 *  always in the allowed set here). */
function selectedMergeStyle(form: NonNullable<PullMergeBoxData["mergeForm"]>): { name: string; text: string; hideMessageFields: boolean } {
  return form.styles.find((style) => style.name === form.defaultStyle) ?? form.styles[0]!;
}

export function PullMergeBoxFragment(props: { data: PullMergeBoxData }) {
  const data = props.data;
  return (
    <div
      class="timeline-item comment pull-merge-box"
      data-global-init="initRepoPullMergeBox"
      {...(data.reloadingInterval !== 0
        ? { "data-pull-merge-box-reloading-interval": String(data.reloadingInterval), "data-pull-link": data.issueLink }
        : {})}
    >
      <div class={`timeline-avatar ${data.timelineIconClass}`}>
        <MergeBoxSvg name="octicon-git-merge" size={40} />
      </div>
      <div class="content">
        <div class="ui segment fitted avatar-content-left-arrow">
          <div class="merge-section flex-divided-list items-px-default">
            {data.statusChecks !== null ? (
              <>
                <div class="item flex-left-right commit-status-toggle">
                  <div>{data.statusChecks.prompt}</div>
                  <button
                    type="button"
                    data-global-click="onCommitStatusChecksToggle"
                    class="btn interact-fg"
                    data-show-all={pullMergeBoxLocale.status_checks_show_all}
                    data-hide-all={pullMergeBoxLocale.status_checks_hide_all}
                  >
                    {pullMergeBoxLocale.status_checks_hide_all}
                  </button>
                </div>
                <div class="item tw-p-0">
                  <div class="commit-status-list flex-divided-list items-px-default">
                    {data.statusChecks.items.map((item, index) => (
                      <div class="item commit-status-item" key={index}>
                        <div class="flex-text-block tw-flex-1">
                          <StatusItemIcon state={item.state} />
                          <div class="gt-ellipsis">
                            {item.context} <span class="tw-text-text-light-2">{item.description}</span>
                          </div>
                        </div>
                        <div class="flex-text-block">
                          {item.required ? <div class="ui label">{pullMergeBoxLocale.status_checks_requested}</div> : null}
                          {item.targetUrl !== "" ? <a href={item.targetUrl}>{pullMergeBoxLocale.status_checks_details}</a> : null}
                        </div>
                      </div>
                    ))}
                    {data.statusChecks.missingRequired.map((context) => (
                      <div class="item commit-status-item" key={`missing-${context}`}>
                        <div class="flex-text-block tw-flex-1">
                          <MergeBoxSvg name="octicon-dot-fill" size={18} extraClass="commit-status icon tw-text-yellow" />
                          <div class="gt-ellipsis">{context}</div>
                        </div>
                        <div class="ui label">{pullMergeBoxLocale.status_checks_requested}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
            {data.closedInfo !== null ? (
              <div class="item flex-left-right">
                <div>
                  <h3 class="tw-mb-2">{data.closedInfo.title}</h3>
                  {data.closedInfo.bodyCode !== undefined ? (
                    <div>
                      {data.closedInfo.bodyCode.prefix}
                      <code>{data.closedInfo.bodyCode.code}</code>
                      {data.closedInfo.bodyCode.suffix}
                    </div>
                  ) : (
                    <div>{data.closedInfo.body}</div>
                  )}
                </div>
                {data.deleteBranch !== null ? (
                  // The cleanup button (pull_merge_box.tmpl's
                  // delete-branch-after-merge, `data-url="{DeleteBranchLink}}"`)
                  // as the no-JS form post — the POST is this module's
                  // cleanupPullRequestFromWeb seam.
                  <form action={data.deleteBranch.link} method="post">
                    <button type="submit" class="ui button link-action delete-branch-after-merge">
                      {pullMergeWriteLocale.branch_delete_button}
                    </button>
                  </form>
                ) : null}
              </div>
            ) : null}
            {data.infoSections
              .filter((section) => section.length > 0)
              .map((section, sectionIndex) => (
                <div class="item" key={sectionIndex}>
                  {section.map((item, itemIndex) => (
                    <InfoItem item={item} key={itemIndex} />
                  ))}
                </div>
              ))}
            {data.updateBranch !== null ? (
              // The update-branch arm (update_branch_by_merge.tmpl): the
              // alert line + the style buttons as no-JS form posts (upstream's
              // link-action buttons + JS dropdown reduced — the pull-reviews
              // select precedent's form twin).
              <div class="item">
                <div class="tw-w-full flex-left-right">
                  <div class="flex-text-block">
                    <MergeBoxSvg name="octicon-alert" /> {pullMergeWriteLocale.outdated_with_base_branch}
                  </div>
                  <div class="ui buttons">
                    {data.updateBranch.options.map((option) => (
                      <form action={option.url} method="post" key={option.style}>
                        <button type="submit" class="ui button link-action">
                          {option.text}
                        </button>
                      </form>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
            {data.isWorkInProgress ? (
              <div class="item flex-left-right">
                <div class="flex-text-block">
                  <MergeBoxSvg name="octicon-x" /> {pullMergeBoxLocale.cannot_merge_work_in_progress}
                </div>
              </div>
            ) : null}
            {data.mergeForm !== null ? (
              // The merge form (the #pull-request-merge-form island reduced to
              // the no-JS form — PullRequestMergeForm.vue's field names
              // verbatim: head_commit_id / merge_when_checks_succeed /
              // force_merge hidden, merge_title_field + merge_message_field,
              // the manually-merged merge_commit_id, the `do` select (the
              // style dropdown's no-JS stand-in) and the
              // delete_branch_after_merge checkbox). The MWCS hidden carries
              // the render's autoMergeWhenSucceed reduction; a scheduled row
              // renders the Vue's info message above the form and the cancel
              // form beside it (PullRequestMergeForm.vue:127 + 196-202).
              <div class="item">
                {data.mergeForm.pendingAutoMerge !== null ? (
                  <div class="ui info message">
                    {data.mergeForm.pendingAutoMerge.doerName}{" "}
                    {pullMergeWriteLocale.auto_merge_has_pending_schedule_prefix}{" "}
                    <relative-time
                      prefix=""
                      tense="past"
                      datetime={new Date(data.mergeForm.pendingAutoMerge.createdUnix * 1000).toISOString()}
                    >
                      {timeSinceParts(data.mergeForm.pendingAutoMerge.createdUnix, "+0000").text}
                    </relative-time>
                    {pullMergeWriteLocale.auto_merge_has_pending_schedule_suffix}
                  </div>
                ) : null}
                <form class="ui form form-fetch-action" action={`${data.mergeForm.issueLink}/merge`} method="post">
                  <input type="hidden" name="head_commit_id" value={data.mergeForm.headCommitId} />
                  <input type="hidden" name="merge_when_checks_succeed" value={data.mergeForm.mergeWhenChecksSucceed ? "true" : "false"} />
                  <input type="hidden" name="force_merge" value={data.mergeForm.forceMerge ? "true" : "false"} />
                  {selectedMergeStyle(data.mergeForm).hideMessageFields ? null : (
                    <>
                      <div class="field">
                        <input type="text" name="merge_title_field" value={data.mergeForm.defaultTitle} />
                      </div>
                      <div class="field">
                        {/* The prefill body rides as the textarea's content
                            (the variables-form precedent) — the SELECTED
                            style's mergeMessageFieldText. */}
                        <textarea name="merge_message_field" rows={5} placeholder={pullMergeWriteLocale.commit_message_desc}>
                          {data.mergeForm.defaultBody}
                        </textarea>
                      </div>
                    </>
                  )}
                  {selectedMergeStyle(data.mergeForm).name === "manually-merged" ? (
                    <div class="field">
                      <input type="text" name="merge_commit_id" placeholder={pullMergeWriteLocale.merge_commit_id} />
                    </div>
                  ) : null}
                  <div class="field">
                    <select name="do">
                      {data.mergeForm.styles.map((style) => (
                        <option value={style.name} selected={style.name === data.mergeForm?.defaultStyle} key={style.name}>
                          {style.text}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div class="flex-text-block tw-gap-3">
                    <button type="submit" class="ui primary button" disabled={data.mergeForm.blockedByDependencies}>
                      {selectedMergeStyle(data.mergeForm).text}
                      {data.mergeForm.mergeWhenChecksSucceed ? ` ${pullMergeWriteLocale.auto_merge_button_when_succeed}` : null}
                    </button>
                    {data.mergeForm.isPullBranchDeletable ? (
                      <div class="ui checkbox">
                        <input name="delete_branch_after_merge" type="checkbox" id="delete-branch-after-merge" value="true" />
                        <label for="delete-branch-after-merge">
                          {pullMergeWriteLocale.branch_delete_checkbox.replaceAll("{branch}", data.mergeForm.headTarget)}
                        </label>
                      </div>
                    ) : null}
                  </div>
                </form>
                {data.mergeForm.pendingAutoMerge !== null ? (
                  // The cancel button (PullRequestMergeForm.vue's
                  // hasPendingPullRequestMerge form → baseLink+'/cancel_auto_merge').
                  <form action={`${data.mergeForm.issueLink}/cancel_auto_merge`} method="post" class="tw-ml-4">
                    <button type="submit" class="ui button">
                      {pullMergeWriteLocale.auto_merge_cancel_schedule}
                    </button>
                  </form>
                ) : null}
              </div>
            ) : null}
            {data.commands !== null ? (
              <div class="item">
                <details>
                  <summary class="tw-pl-1">
                    <span class="tw-pl-2">{pullMergeBoxLocale.cmd_instruction_hint}</span>
                  </summary>
                  <div class="tw-my-[5px]">
                    <div>
                      <h3 class="tw-m-0">{pullMergeBoxLocale.cmd_instruction_checkout_title}</h3>
                      {pullMergeBoxLocale.cmd_instruction_checkout_desc}
                    </div>
                    <div class="ui secondary segment tw-font-mono">
                      {data.commands.checkoutLines.map((line) => (
                        <div>{line}</div>
                      ))}
                    </div>
                    {data.commands.mergeBlocks.length > 0 ? (
                      <>
                        <div>
                          <h3 class="tw-m-0">{pullMergeBoxLocale.cmd_instruction_merge_title}</h3>
                          {pullMergeBoxLocale.cmd_instruction_merge_desc}
                          {data.commands.showMergeWarning ? <div>{pullMergeBoxLocale.cmd_instruction_merge_warning}</div> : null}
                        </div>
                        <div class="ui secondary segment tw-font-mono">
                          {data.commands.mergeBlocks.map((block) => (
                            <div class={block.hidden ? "tw-hidden" : undefined} data-pull-merge-style={block.style}>
                              {block.lines.map((line) => (
                                <div>{line}</div>
                              ))}
                            </div>
                          ))}
                          {data.commands.mergePushLine !== null ? <div>{data.commands.mergePushLine}</div> : null}
                        </div>
                      </>
                    ) : null}
                  </div>
                </details>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The tplPullMergeBox fragment's bytes — the `.timeline-item.comment
 * .pull-merge-box` card, no layout. `null` renders the template's
 * ShowMergeBox=false arm: the EMPTY string (the reload loop's stop signal).
 */
export function pullMergeBoxFragmentHtml(data: PullMergeBoxData | null): string {
  if (data === null) return "";
  return renderToString(<PullMergeBoxFragment data={data} />);
}

/**
 * The fragment Response — ctx.HTML's `text/html; charset=utf-8`
 * (context_response.go:99) plus the web middleware's zero-option prod
 * Cache-Control (the blob-excerpt/lastcommit fragment twins).
 */
export function pullMergeBoxFragmentResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}

// ---------------------------------------------------------------------------
// The web write arms (census gap #2) — the POST handler ladders over the
// landed services. Response shapes are the house web-POST convention (the
// issue-comment POST posture): success → the redirect outcome (the mounted
// handler answers 303 onto the PR page — upstream JSONRedirect/Redirect's
// target), failure → the error outcome carrying the upstream flash text (the
// mounted handler re-renders the conversation page with it), the upstream
// NotFound arms → the not-found outcome (the 404 shell).
// ---------------------------------------------------------------------------

export type PullMergeBoxWriteOutcome =
  | { outcome: "redirect"; location: string }
  | { outcome: "error"; message: string }
  | { outcome: "not-found" };

/** The constructed context the seams take — the mounted route's `c` (the
 *  session prologue has resolved repo + viewer before the seam runs; the
 *  session gate precedes it) with the resolved rows. Tests construct it
 *  directly (`new Context(req, { env })` — the repo-grants precedent). */
export interface PullMergeBoxWriteContext {
  c: Context<{ Bindings: Env }>;
  /** The BASE repo row (the route prologue's resolution). */
  repo: RepoRow;
  issue: IssueRow;
  pr: PullRequestRow;
  /** The signed-in doer (the mounted handler's anonymous gate precedes). */
  viewer: Extract<Viewer, { kind: "user" }>;
}

// --- form parsers (the urlencoded fields the templates post) -----------------

/** `forms.MergePullRequestForm` (services/forms/repo_form.go:416-429) over
 *  PullRequestMergeForm.vue's input names: `do`, `merge_title_field`,
 *  `merge_message_field`, `merge_commit_id`, `head_commit_id`, `force_merge`,
 *  `merge_when_checks_succeed` (the hidden v-models render "true"/"false")
 *  and the `delete_branch_after_merge` checkbox (present = true — the *bool
 *  binding). */
export interface MergePullRequestWebForm {
  /** The bound style — "" when the field is missing/foreign (the enum's
   *  binding refusal maps to invalid_merge_option in the ladder). */
  do: (typeof MERGE_STYLE_ENUM)[number] | "";
  mergeTitleField: string;
  mergeMessageField: string;
  mergeCommitId: string;
  headCommitId: string;
  forceMerge: boolean;
  mergeWhenChecksSucceed: boolean;
  deleteBranchAfterMerge: boolean;
}

export function parseMergePullRequestWebForm(params: URLSearchParams): MergePullRequestWebForm {
  return {
    do: styleEnumOf(params.get("do") ?? ""),
    mergeTitleField: params.get("merge_title_field") ?? "",
    mergeMessageField: params.get("merge_message_field") ?? "",
    mergeCommitId: params.get("merge_commit_id") ?? "",
    headCommitId: params.get("head_commit_id") ?? "",
    forceMerge: (params.get("force_merge") ?? "") === "true",
    mergeWhenChecksSucceed: (params.get("merge_when_checks_succeed") ?? "") === "true",
    deleteBranchAfterMerge: params.has("delete_branch_after_merge"),
  };
}

/** `forms.UpdateAllowEditsForm` (repo_form.go:522-525): the sidebar JS posts
 *  `allow_maintainer_edit: String(checkbox.checked)` ("true"/"false"); the
 *  no-JS checkbox posts "on" or nothing. */
export function parseAllowMaintainerEditForm(params: URLSearchParams): { allowMaintainerEdit: boolean } {
  const raw = params.get("allow_maintainer_edit") ?? "";
  return { allowMaintainerEdit: raw === "true" || raw === "on" || raw === "1" };
}

/** `POST /pull/{index}/target_branch`'s `target_branch` field
 *  (ctx.FormTrim, pull.go:1517). */
export function parseTargetBranchForm(params: URLSearchParams): { targetBranch: string } {
  return { targetBranch: (params.get("target_branch") ?? "").trim() };
}

/** The update-branch style (the `?style=` query — upstream reads FormString
 *  with the user's default fallback; the no-JS forms post the style in the
 *  URL). */
export function parseUpdateBranchStyle(style: string | null): "merge" | "rebase" | null {
  return style === "rebase" ? "rebase" : style === "merge" ? "merge" : null;
}

// --- the seam plumbing --------------------------------------------------------

/** The api-service bridge (repo-grants/cherrypick precedent): a fresh
 *  `Context<ApiEnv>` over the same request + bindings carrying the doer's
 *  User projection — mergePerson's commit stamps read login+email, the access
 *  predicates read id/login/is_admin. */
function apiContextFor(ctx: PullMergeBoxWriteContext, doer: User): Context<ApiEnv> {
  const api = new Context<ApiEnv>(ctx.c.req.raw, { env: ctx.c.env });
  api.set("authUser", doer);
  return api;
}

/** The doer's UserRow → the minimal User projection the engine seams read
 *  (mergePerson: login/email; principalAccessOf: id/login/is_admin). The
 *  noreply fallback rides mergePerson's own hostname arm — the projection
 *  carries the row's email verbatim. */
async function doerProjection(ctx: PullMergeBoxWriteContext): Promise<User | null> {
  const row = (await drizzle(ctx.c.env.DB).select().from(users).where(eq(users.id, ctx.viewer.id)).get()) ?? null;
  if (row === null) return null; // the vanished session doer
  return { id: row.id, login: row.username, is_admin: row.isAdmin, email: row.email ?? undefined };
}

/** The engine ApiError → the flash text (the web handler's catch arms). */
function mergeEngineErrorMessage(message: string): string {
  if (message.includes("conflict")) return pullMergeWriteLocale.merge_conflict;
  if (message.startsWith("not a fast forward") || message.startsWith("The merge has failed, the base ref moved")) {
    return pullMergeWriteLocale.merge_out_of_date;
  }
  if (message.startsWith("The merge commit")) return pullMergeWriteLocale.wrong_commit_id;
  return message;
}

const MERGE_STYLE_ENUM = ["merge", "rebase", "rebase-merge", "squash", "fast-forward-only", "manually-merged"] as const;

/** The enum-bound style read (web.Bind's In() as a type guard — no cast:
 *  the union member returns only on a real match). */
function styleEnumOf(raw: string): (typeof MERGE_STYLE_ENUM)[number] | "" {
  for (const style of MERGE_STYLE_ENUM) {
    if (style === raw) return style;
  }
  return "";
}

/** The shared prologue the ladders repeat (getPullInfo's row checks + the
 *  doer/pair resolution). */
async function writePrologue(
  ctx: PullMergeBoxWriteContext,
): Promise<{ ok: true; pair: NonNullable<Awaited<ReturnType<typeof findRepositoryById>>>; doer: User; api: Context<ApiEnv>; issueLink: string } | { ok: false; outcome: PullMergeBoxWriteOutcome }> {
  if (!ctx.issue.isPull) {
    // getPullInfo's non-pull redirect (pull.go:136-139) — the issues twin.
    return { ok: false, outcome: { outcome: "redirect", location: `/${ctx.repo.ownerNamespace}/${ctx.repo.slug}/issues/${ctx.issue.index}` } };
  }
  const pair = await findRepositoryById(ctx.c.env.DB, ctx.repo.id);
  if (pair === null) return { ok: false, outcome: { outcome: "not-found" } };
  const doer = await doerProjection(ctx);
  if (doer === null) return { ok: false, outcome: { outcome: "not-found" } };
  return {
    ok: true,
    pair,
    doer,
    api: apiContextFor(ctx, doer),
    issueLink: `/${ctx.repo.ownerNamespace}/${ctx.repo.slug}/pulls/${ctx.issue.index}`,
  };
}

// --- POST /pulls/{index}/merge (web.go:1665 → pull.go:1044-1231) --------------

/**
 * The web merge ladder: CheckPullMergeable's arm order (check.go:142-207 —
 * merged, closed, the permission pair, [manual short-circuit], WIP,
 * mergeable state) with the MWCS schedule arm in the landed refusal's slot
 * (pull.go:1135-1149 — the Auto merge-check type skips the branch-protection
 * failure, check.go:184-186, so the schedule rides past approvals/outdated/
 * required-checks and merges when they clear; services/pull-automerge.ts's
 * consumer is the other half), the lazy-check precondition, the protection
 * gate with the force_merge bypass, composeMergeMessage, and the engine
 * merge — the API merge route's exact service seams with the web flash
 * mapping. The success webhook + feed action re-issue the route's private
 * emit arms over importable pieces (the payload assembly is
 * pullRequestPayload's §2.7 wrapper shape; the PR render the canonical
 * converter; the fan-out emitIssueEvent; the feed row the route's
 * pullActionDraft merge discriminant — closed + merged=true →
 * ActionType.MergePullRequest, content `index|title`).
 */
export async function mergePullRequestFromWeb(ctx: PullMergeBoxWriteContext, form: MergePullRequestWebForm): Promise<PullMergeBoxWriteOutcome> {
  const prologue = await writePrologue(ctx);
  if (!prologue.ok) return prologue.outcome;
  const { pair, doer, api, issueLink } = prologue;
  const db = ctx.c.env.DB;
  // The form binding's enum (web.Bind In() — repo_form.go:420).
  if (form.do === "") {
    return { outcome: "error", message: pullMergeWriteLocale.invalid_merge_option };
  }
  // CheckPullMergeable's order: merged, closed, then the permission pair.
  if (ctx.pr.hasMerged) return { outcome: "error", message: pullMergeWriteLocale.has_merged };
  if (ctx.issue.isClosed) return { outcome: "error", message: pullMergeWriteLocale.is_closed };
  const rule = await findRule(db, ctx.repo.id, ctx.pr.baseBranch);
  const access = await principalAccessOf(db, pair.repo, doer);
  if (!(access.write && (rule === null || (await isUserMergeWhitelisted(db, parseRuleConfig(rule.rules), access))))) {
    // ErrNoPermissionToMerge's flash (pull.go:1077).
    return { outcome: "error", message: pullMergeWriteLocale.update_not_allowed };
  }
  // The manual short-circuit (check.go:162-165): manually-merged skips the
  // WIP / mergeable-state / protection checks entirely (the MWCS branch never
  // reaches it — the manual mark returns before pull.go:1135 upstream) and
  // lands in MergedManually, whose FIRST gate is the style-allowed check —
  // gated below on the PR unit's AllowManualMerge.
  if (form.do !== "manually-merged") {
    if (hasWorkInProgressPrefix(ctx.issue.title)) {
      return { outcome: "error", message: pullMergeWriteLocale.no_merge_wip };
    }
    // The mergeable precondition runs the lazy check (the API route's pass).
    const checked = await ensurePullRequestChecked(api, pair, ctx.pr);
    if (checked.hasMerged) {
      return { outcome: "error", message: pullMergeWriteLocale.has_merged };
    }
    // Ancestor is NOT IsStatusMergeable (models/issues/pull.go:446-448) —
    // CheckPullMergeable answers it ErrNotMergeableState, whose flash is the
    // not-ready text (pull.go:1082-1088), NOT ErrHasMerged's has_merged.
    if (checked.status === PRStatus.Ancestor) {
      return { outcome: "error", message: pullMergeWriteLocale.no_merge_not_ready };
    }
    // THE SCHEDULE ARM (pull.go:1135-1149): merge_when_checks_succeed
    // schedules instead of merging — the Auto check type's one relaxation is
    // the branch-protection failure (check.go:184-186), so only the arms
    // above (merged/closed/permission/WIP) plus the mergeable state gate it;
    // an Empty PR schedules too (check.go:172's `&& !pr.IsEmpty()`). The
    // upstream handler deletes any existing schedule first (the re-schedule
    // reset), inserts the row + the type-34 comment (ScheduleAutoMerge's
    // transaction, services/automerge/automerge.go:84-99), flashes the
    // newly-scheduled text and redirects — the flash rides our bare 303 (the
    // reloaded box renders the pending message + the cancel button).
    // The Auto CheckPullMergeable call at pull.go:1056 runs the FULL ladder
    // before this branch — its FINAL deps arm (check.go:219-223) included —
    // so a deps-blocked PR refuses to schedule with the pr_close_blocked
    // flash (pull.go:1088-1090):
    if (!(await issueNoDependenciesLeft(db, ctx.issue.id))) {
      return { outcome: "error", message: pullMergeWriteLocale.dependencies_left };
    }
    if (form.mergeWhenChecksSucceed) {
      if (checked.status !== PRStatus.Mergeable && checked.status !== PRStatus.Empty) {
        return { outcome: "error", message: pullMergeWriteLocale.no_merge_not_ready };
      }
      const message = await composeMergeMessage(api, pair, ctx.issue, checked, {
        style: form.do,
        mergeTitleField: form.mergeTitleField,
        mergeMessageField: form.mergeMessageField,
      });
      const now = new Date();
      await scheduleAutoMergeRow(db, {
        issueId: ctx.issue.id,
        doerId: ctx.viewer.id,
        sha: checked.headSha ?? "",
        style: form.do,
        message,
        deleteBranchAfterMerge: form.deleteBranchAfterMerge,
      }, now);
      await createScheduledAutoMergeComment(db, ctx.issue.id, ctx.viewer.id, now);
      // The FIRST check (StartAutoMergeCheckByPullHead, automerge.go:100-103)
      // — best-effort on the standing queue; the cron producer re-probes
      // every tick regardless, so an unbound queue only delays a green merge.
      if (ctx.c.env.REPO_TASKS !== undefined) {
        try {
          await ctx.c.env.REPO_TASKS.send({ kind: "auto-merge-check", issueId: ctx.issue.id });
        } catch (error) {
          console.error(`[pull-merge-box] auto-merge check enqueue failed (issue ${ctx.issue.id}): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { outcome: "redirect", location: issueLink };
    }
    if (checked.status !== PRStatus.Mergeable) {
      return { outcome: "error", message: pullMergeWriteLocale.no_merge_not_ready };
    }
    if (rule !== null) {
      const failure = await checkPullBranchProtections(db, rule, { issueId: ctx.issue.id, commitsBehind: checked.commitsBehind ?? 0 });
      if (failure !== null) {
        const bypass = form.forceMerge && (await canBypassBranchProtection(db, parseRuleConfig(rule.rules), access));
        if (!bypass) {
          // ErrNotReadyToMerge's flash — the web handler maps the protection
          // refusal to the not-ready text (pull.go:1084-1086), not the API's
          // verbatim failure string.
          return { outcome: "error", message: pullMergeWriteLocale.no_merge_not_ready };
        }
      }
    }
    const message = await composeMergeMessage(api, pair, ctx.issue, checked, {
      style: form.do,
      mergeTitleField: form.mergeTitleField,
      mergeMessageField: form.mergeMessageField,
    });
    return runMergeLanding(ctx, {
      api,
      pair,
      doer,
      access,
      issueLink,
      checked,
      style: form.do,
      message,
      deleteBranchAfterMerge: form.deleteBranchAfterMerge,
      mergeCommitId: form.mergeCommitId === "" ? undefined : form.mergeCommitId,
    });
  }
  // The manual mark lands in MergedManually, whose FIRST gate is the
  // style-allowed check (merge.go:755-759): IsMergeStyleAllowed
  // (ManuallyMerged) = the PR unit's AllowManualMerge, the zero value FALSE
  // upstream's DefaultPullRequestsConfig never sets (repo_unit.go:139-155).
  // The web flash for the refusal is invalid_merge_option (pull.go:1101-1102's
  // IsErrInvalidMergeStyle arm).
  if (!(await loadRepoSettings(db, ctx.repo.id)).prUnit.AllowManualMerge) {
    return { outcome: "error", message: pullMergeWriteLocale.invalid_merge_option };
  }
  // Style allowed: MergedManually proceeds to the commit verification —
  // GetCommit(ref) then IsCommitInBranch (merge.go:761-775), both refusals
  // util.ErrInvalidArgument upstream (pull.go:1103-1105's wrong_commit_id
  // flash). The engine's manual arm answers the same class ("The merge
  // commit ..." ApiErrors — mergeEngineErrorMessage maps the prefix), and
  // MarkAsMerged lands the merged row without touching refs. The mark skips
  // every ladder arm above (the Manually check type's early return,
  // check.go:161-165) and never schedules (upstream returns at the mark,
  // pull.go:1098-1107, before the MWCS branch).
  return runMergeLanding(ctx, {
    api,
    pair,
    doer,
    access,
    issueLink,
    checked: ctx.pr,
    style: "manually-merged",
    message: "",
    deleteBranchAfterMerge: form.deleteBranchAfterMerge,
    mergeCommitId: form.mergeCommitId === "" ? undefined : form.mergeCommitId,
  });
}

/** The engine-merge call + its catch mapping + the webhook/feed arms (the
 *  shared tail of the merge ladder). */
async function runMergeLanding(
  ctx: PullMergeBoxWriteContext,
  input: {
    api: Context<ApiEnv>;
    pair: NonNullable<Awaited<ReturnType<typeof findRepositoryById>>>;
    doer: User;
    access: PrincipalAccess;
    issueLink: string;
    checked: PullRequestRow;
    style: (typeof MERGE_STYLE_ENUM)[number];
    message: string;
    deleteBranchAfterMerge: boolean;
    mergeCommitId: string | undefined;
  },
): Promise<PullMergeBoxWriteOutcome> {
  let commitOid: string | null;
  try {
    const landed = await mergePullRequest(input.api, input.pair, ctx.issue, input.checked, {
      style: input.style,
      message: input.message,
      deleteBranchAfterMerge: input.deleteBranchAfterMerge,
      mergeCommitId: input.mergeCommitId,
      doerId: ctx.viewer.id,
      now: new Date(),
    });
    commitOid = landed.commitOid;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { outcome: "error", message: mergeEngineErrorMessage(error.message) };
  }
  // The webhook + feed (see the seam's doc — the route arms re-issued).
  const merged = await findPullRequestByIndex(ctx.c.env.DB, ctx.repo.id, input.checked.index);
  if (merged !== null) {
    try {
      const origin = new URL(ctx.c.req.url).origin;
      const viewer = { origin, requester: input.doer };
      const diffStats = await pullRequestDiffShortStat(input.api, input.pair, merged.pullRequest);
      const rendered = await toApiPullRequest(ctx.c.env.DB, viewer, input.pair, merged.issue, merged.pullRequest, "payload", diffStats === null ? undefined : { diffStats });
      await emitIssueEvent(ctx.c, {
        repoId: ctx.repo.id,
        ownerId: ctx.repo.ownerId,
        eventType: "pull_request",
        payload: {
          action: "closed",
          number: merged.issue.index,
          pull_request: rendered,
          repository: toApiRepository(viewer, input.pair),
          sender: input.doer,
          commit_id: commitOid ?? "",
        },
      });
    } catch (error) {
      console.error(`[pull-merge-box] merge webhook failed (issue ${ctx.issue.id}): ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      // pullActionDraft's merge discriminant (routes/pulls.ts): closed +
      // merged=true → MergePullRequest, content `index|title`.
      await recordAction(ctx.c.env.DB, {
        actUserId: ctx.viewer.id,
        repoId: ctx.repo.id,
        opType: ActionType.MergePullRequest,
        isPrivate: ctx.repo.visibility === "private",
        content: `${merged.issue.index}|${merged.issue.title}`,
      });
    } catch (error) {
      console.error(`[pull-merge-box] merge action row failed (issue ${ctx.issue.id}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { outcome: "redirect", location: input.issueLink };
}

// --- POST /pulls/{index}/cancel_auto_merge (web.go:1666 → pull.go:1251-1290) --

/**
 * The cancel arm, real since migration 0059's `pull_auto_merges` landed:
 * GetScheduledMergeByPullID's `!exist` → NotFound; the scheduler-canceler
 * mismatch runs IsUserAllowedToMerge (the doer may cancel their own
 * schedule; a non-scheduler needs the merge right — pull.go:1270-1281, the
 * 403 mapped to the error outcome with the handler's own text); then
 * RemoveScheduledAutoMerge — the row delete + the type-35 comment — and the
 * redirect (the canceled_schedule flash rides it).
 */
export async function cancelAutoMergeFromWeb(ctx: PullMergeBoxWriteContext): Promise<PullMergeBoxWriteOutcome> {
  const prologue = await writePrologue(ctx);
  if (!prologue.ok) return prologue.outcome;
  const { pair, issueLink } = prologue;
  const db = ctx.c.env.DB;
  const scheduled = await getScheduledAutoMerge(db, ctx.issue.id);
  if (scheduled === null) return { outcome: "not-found" }; // pull.go:1263-1265
  if (ctx.viewer.id !== scheduled.doerId) {
    const access = await principalAccessOf(db, pair.repo, await doerProjection(ctx));
    const rule = await findRule(db, ctx.repo.id, ctx.pr.baseBranch);
    const allowed = access.write && (rule === null || (await isUserMergeWhitelisted(db, parseRuleConfig(rule.rules), access)));
    if (!allowed) {
      return { outcome: "error", message: pullMergeWriteLocale.cancel_permission_denied }; // pull.go:1278's HTTPError text
    }
  }
  await removeScheduledAutoMerge(db, ctx.issue, ctx.viewer.id, new Date());
  return { outcome: "redirect", location: issueLink };
}

// --- POST /pulls/{index}/update (web.go:1667 → pull.go:968-1041) --------------

/**
 * The update-branch arm: closed/merged → NotFound, CheckUserAllowedToUpdate's
 * landed predicate over the requested style (the default fallback is merge —
 * upstream's userUpdateStyles.DefaultUpdateStyle default, repo_unit.go:148),
 * then the engine execution with the handler's default message. Failure maps:
 * conflicts → the merge_conflict flash, everything else → the handler's
 * "Unable to update pull request" JSONError text.
 */
export async function updatePullRequestFromWeb(ctx: PullMergeBoxWriteContext, style: "merge" | "rebase"): Promise<PullMergeBoxWriteOutcome> {
  const prologue = await writePrologue(ctx);
  if (!prologue.ok) return prologue.outcome;
  const { pair, api, issueLink } = prologue;
  if (ctx.issue.isClosed || ctx.pr.hasMerged) return { outcome: "not-found" }; // pull.go:972-979
  const access = await principalAccessOf(ctx.c.env.DB, pair.repo, await doerProjection(ctx));
  const headRepo = await findRepositoryById(ctx.c.env.DB, ctx.pr.headRepoId);
  const styles = await checkUserAllowedToUpdate(ctx.c.env.DB, ctx.repo, headRepo, ctx.issue, ctx.pr, access, ctx.viewer);
  if (!(style === "rebase" ? styles.rebaseAllowed : styles.mergeAllowed)) {
    // The update_not_allowed flash (pull.go:995-997).
    return { outcome: "error", message: pullMergeWriteLocale.update_not_allowed };
  }
  // The handler's default message (pull.go:1000).
  const message = `Merge branch '${ctx.pr.baseBranch}' into ${ctx.pr.headBranch}`;
  try {
    await updatePullRequestBranch(api, pair, ctx.pr, { style, message, now: new Date() });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.message.includes("conflict")) return { outcome: "error", message: pullMergeWriteLocale.merge_conflict };
    return { outcome: "error", message: pullMergeWriteLocale.unable_to_update };
  }
  // The success flash ("Branch update was successful") rides the redirect —
  // the house's no-flash redirect (the reloaded page shows the fresh counts).
  return { outcome: "redirect", location: issueLink };
}

// --- POST /pulls/{index}/set_allow_maintainer_edit (web.go:1668 →
// pull.go:1579-1605 over services/pull/edits.go) -------------------------------

/**
 * The maintainer-edit toggle: SetAllowEdits' two refusals (edits.go:21-23 the
 * poster gate, :34-36 the HEAD repo's code write) — the upstream 403 maps to
 * the error outcome carrying the service's own ErrUserHasNoPermissionForAction
 * text (the re-render's message; upstream's 403 has no body). The write is
 * the bare column update (UpdateAllowEdits); the toggle 303s back (upstream's
 * JS updates the checkbox in place — the no-JS form reload).
 */
export async function setAllowMaintainerEditFromWeb(ctx: PullMergeBoxWriteContext, form: { allowMaintainerEdit: boolean }): Promise<PullMergeBoxWriteOutcome> {
  const prologue = await writePrologue(ctx);
  if (!prologue.ok) return prologue.outcome;
  const { pair, issueLink } = prologue;
  const headRepo = await findRepositoryById(ctx.c.env.DB, ctx.pr.headRepoId);
  if (headRepo === null) return { outcome: "not-found" }; // LoadHeadRepo's error arm
  const isPoster = ctx.issue.posterId !== null && ctx.issue.posterId === ctx.viewer.id;
  const headAccess =
    ctx.pr.headRepoId === ctx.repo.id
      ? await principalAccessOf(ctx.c.env.DB, pair.repo, await doerProjection(ctx))
      : await principalAccessOfRow(ctx.c.env.DB, headRepo.repo, { id: ctx.viewer.id, username: ctx.viewer.username, isAdmin: ctx.viewer.isAdmin });
  if (!isPoster || !headAccess.write) {
    return { outcome: "error", message: pullMergeWriteLocale.no_permission_for_action };
  }
  await drizzle(ctx.c.env.DB)
    .update(pullRequests)
    .set({ allowMaintainerEdit: form.allowMaintainerEdit })
    .where(eq(pullRequests.id, ctx.pr.id));
  return { outcome: "redirect", location: issueLink };
}

// --- POST /pulls/{index}/cleanup (web.go:1669 → pull.go:1457-1465) ------------

/**
 * The post-merge cleanup: deleteBranchAfterMergeAndFlashMessage's outcome
 * mapping — the failed arms re-render with the flash text, the deleted and
 * silently-skipped arms land back on the PR page (the deletion's durable
 * trace is the type-11 comment; the skip is silent upstream too,
 * pull.go:1237-1240).
 */
export async function cleanupPullRequestFromWeb(ctx: PullMergeBoxWriteContext): Promise<PullMergeBoxWriteOutcome> {
  const prologue = await writePrologue(ctx);
  if (!prologue.ok) return prologue.outcome;
  const result = await deleteBranchAfterMerge(prologue.api, prologue.pair, ctx.issue, ctx.pr, { doerId: ctx.viewer.id, now: new Date() });
  if (result.outcome === "failed") {
    return { outcome: "error", message: result.message };
  }
  return { outcome: "redirect", location: prologue.issueLink };
}

// --- POST /pull/{index}/target_branch (web.go:1439 → pull.go:1500-1576) -------

/**
 * The base-change form: GetActionIssue's poster-or-pulls-writer gate (the
 * labels-write 404-shell posture — upstream answers 403, the shell hides
 * it), the non-pull 404, the empty-target no-op (upstream's StatusNoContent —
 * the no-JS form reloads), then ChangeTargetBranch with its five refusal
 * texts as the error messages.
 */
export async function changeTargetBranchFromWeb(ctx: PullMergeBoxWriteContext, form: { targetBranch: string }): Promise<PullMergeBoxWriteOutcome> {
  const prologue = await writePrologue(ctx);
  if (!prologue.ok) return prologue.outcome;
  const { pair, api, issueLink } = prologue;
  const isPoster = ctx.issue.posterId !== null && ctx.issue.posterId === ctx.viewer.id;
  const access = await principalAccessOf(ctx.c.env.DB, pair.repo, await doerProjection(ctx));
  if (!isPoster && !access.write) return { outcome: "not-found" }; // pull.go:1512-1515's 403, shell-hidden
  if (form.targetBranch === "") return { outcome: "redirect", location: issueLink }; // StatusNoContent → reload
  try {
    await changePullRequestTargetBranch(api, pair, ctx.issue, ctx.pr, { targetBranch: form.targetBranch, now: new Date() });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { outcome: "error", message: error.message };
  }
  return { outcome: "redirect", location: issueLink };
}

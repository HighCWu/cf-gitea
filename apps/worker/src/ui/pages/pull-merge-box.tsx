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
 *   delete-branch button (`POST /{index}/cleanup`, not landed — the §2.5
 *   write-action rule); with that button dead, the merged box has no
 *   remaining purpose ("there is nothing to do", issue_view.go:971-974), so
 *   the loader answers null for merged PRs — the box renders for open and
 *   closed-unmerged rows exactly like upstream's non-deletable case;
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
 *   allowlist/default (`PullRequestsConfig`) has no D1 home — `repo_units`
 *   carries 'code' only, so the form carries the config DEFAULTS
 *   (repo_unit.go's DefaultPullRequestsConfig: merge/rebase/rebase-merge/
 *   squash/fast-forward-only allowed, manually-merged not, default style
 *   merge) instead of a per-repo allowlist; (c) the style dropdown is the
 *   pull-reviews select reduction (the Vue menu is JS-only).
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
 * 4. `loadPullMergeBoxData` → null (merged — upstream renders the
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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { RefsResult } from "@cf-gitea/git-engine";

import { latestCommitStatuses, combinedStateOf } from "../../api/services/commit-status";
import type { CommitStatusState } from "../../api/models/commit-status";
import { hasWorkInProgressPrefix } from "../../api/services/issues";
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
import { PRFlow, PRStatus, pullRequests, users, type CommitStatusRow } from "../../db/schema";
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
  /** The allowed styles (the PR-unit allowlist defaults: merge/rebase/
   *  rebase-merge/squash always, fast-forward-only when the row is not
   *  behind — pull_merge_form.go:147-163 over repo_unit.go's defaults;
   *  manually-merged stays excluded, AllowManualMerge defaults false). */
  styles: { name: string; text: string; hideMessageFields: boolean }[];
  /** The preselected `do` (the DefaultMergeStyle default, "merge"). */
  defaultStyle: string;
  /** The title field's prefill — the default style's composed default
   *  (composeMergeMessage's default arm, re-issued for the render). */
  defaultTitle: string;
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
 *  re-check against the engine and refuse — the disclosed degradation). */
export interface PullMergeBoxInput {
  repo: RepoRow;
  issue: IssueRow;
  pr: PullRequestRow;
  viewer: Viewer;
  origin: string;
  listTips?: (pair: { ownerNamespace: string; slug: string }) => Promise<RefsResult | null>;
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

/** The merge form's title prefill — composeMergeMessage's default-title arm
 *  re-issued for the render (the pull-reviews re-issue precedent: the same
 *  string-building over D1 rows, the write seam itself keeps the service as
 *  its single source of truth). `pull.tests` pins the two agree. */
function defaultMergeTitleOf(issue: IssueRow, pr: PullRequestRow, headRepo: { ownerNamespace: string; slug: string } | null, style: string): string {
  if (style === "rebase") return "";
  if (style === "squash") return `${issue.title} (#${pr.index})`;
  if (pr.headRepoId === pr.baseRepoId) {
    return `Merge pull request '${issue.title}' (#${pr.index}) from ${pr.headBranch} into ${pr.baseBranch}`;
  }
  const from = headRepo === null ? `<deleted>:${pr.headBranch}` : `${headRepo.ownerNamespace}/${headRepo.slug}:${pr.headBranch}`;
  return `Merge pull request '${issue.title}' (#${pr.index}) from ${from} into ${pr.baseBranch}`;
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
  // The merge form's allowed styles (prepareMergeBoxFormProps over the PR-unit
  // defaults — merge/rebase/rebase-merge/squash always, fast-forward-only
  // when the head is not behind, pull_merge_form.go:147-163;
  // manually-merged stays excluded, AllowManualMerge defaults false,
  // repo_unit.go:127). The preselected style is the DefaultMergeStyle
  // default ("merge", repo_unit.go:152-153).
  const ffAllowed = (pr.commitsBehind ?? 0) === 0;
  const styleOptions: { name: string; text: string; hideMessageFields: boolean }[] = [
    { name: "merge", text: pullMergeWriteLocale.merge_pull_request, hideMessageFields: false },
    { name: "rebase", text: pullMergeWriteLocale.rebase_merge_pull_request, hideMessageFields: true },
    { name: "rebase-merge", text: pullMergeWriteLocale.rebase_merge_commit_pull_request, hideMessageFields: false },
    { name: "squash", text: pullMergeWriteLocale.squash_merge_pull_request, hideMessageFields: false },
    ...(ffAllowed ? [{ name: "fast-forward-only", text: pullMergeWriteLocale.fast_forward_only_merge_pull_request, hideMessageFields: true }] : []),
  ];
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

  return {
    issueLink,
    reloadingInterval: isChecking ? 5000 : 0,
    timelineIconClass,
    closedInfo: null,
    statusChecks,
    infoSections,
    isWorkInProgress,
    commands,
    mergeForm: hasPermToMerge
      ? {
          issueLink,
          headCommitId: pr.headSha ?? "",
          forceMerge: canMergeNow && hasOverridableBlockers, // the Vue forceMerge computed
          styles: styleOptions,
          defaultStyle: "merge",
          defaultTitle: defaultMergeTitleOf(issue, pr, headRepo === null ? null : headRepo.repo, "merge"),
          isPullBranchDeletable: openBranchDeletable,
          headTarget,
          mergeWhenChecksSucceed: !canMergeNow, // the Vue autoMergeWhenSucceed reduction
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
                        <textarea name="merge_message_field" rows={5} placeholder={pullMergeWriteLocale.commit_message_desc} />
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
                    <button type="submit" class="ui primary button">
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
  // WIP / mergeable-state / protection checks entirely — and the MWCS branch
  // never reaches it (the manual mark returns before pull.go:1135 upstream).
  if (form.do !== "manually-merged") {
    if (hasWorkInProgressPrefix(ctx.issue.title)) {
      return { outcome: "error", message: pullMergeWriteLocale.no_merge_wip };
    }
    // The mergeable precondition runs the lazy check (the API route's pass).
    const checked = await ensurePullRequestChecked(api, pair, ctx.pr);
    if (checked.hasMerged || checked.status === PRStatus.Ancestor) {
      return { outcome: "error", message: pullMergeWriteLocale.has_merged };
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

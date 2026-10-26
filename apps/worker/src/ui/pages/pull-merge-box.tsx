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
 * - THE MERGE FORM (`$data.MergeFormProps`, the Vue island div
 *   `#pull-request-merge-form[data-merge-form-props]`) is NOT rendered:
 *   (a) it POSTs `/{index}/merge` on the web session — the landed merge write
 *   is the token-auth API route only (SPEC-0004 repoMergePullRequest), a
 *   form pointing there is a dead control (§2.4.1/§2.5); (b) the merge-style
 *   allowlist/default (`PullRequestsConfig`) has no D1 home — `repo_units`
 *   carries 'code' only, so `defaultMergeStyle`/`mergeStyles[].allowed` have
 *   no source; (c) the island payload rides upstream's pageData, which our
 *   shell emits as null (the issue-detail reduction's cite, verbatim).
 * - THE UPDATE-BRANCH ARM (`ShowUpdatePullInfo`, update_branch_by_merge.tmpl)
 *   is NOT rendered: `commitsBehind > 0` IS in the row, but the arm exists to
 *   carry the `POST ?/update?style=merge|rebase` buttons — write actions with
 *   no landed web route (§2.5). The `pull_requests.commits_behind` count
 *   stays available to the merge gate (`blockOnOutdatedBranch`).
 * - THE DELETE-BRANCH BUTTON (`IsPullBranchDeletable` +
 *   `data-url="{issue}/cleanup"`) is NOT rendered: `POST /cleanup` is not
 *   landed, and the deletable computation needs the engine branch-existence
 *   read the conversation loader has always declined (issue-detail header).
 *   Consequence stated above (merged → no box).
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
 * ## HANDOFF — the route (a later index.ts window; this wave is module-only)
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
 * the conversation page's timeline; the `pulls/{index}` conversation route
 * keeps rendering its own reduced summary box until this fragment's mount
 * wave replaces it (issue-detail.tsx's documented degradation).
 */

import { renderToString } from "hono/jsx/dom/server";

import { latestCommitStatuses, combinedStateOf } from "../../api/services/commit-status";
import type { CommitStatusState } from "../../api/models/commit-status";
import { hasWorkInProgressPrefix } from "../../api/services/issues";
import { findRepositoryById } from "../../api/services/repository";
import {
  canBypassBranchProtection,
  findRule,
  isUserMergeWhitelisted,
  mergeBlockedByOfficialReviewRequests,
  mergeBlockedByOutdatedBranch,
  mergeBlockedByRejectedReview,
  grantedApprovalsCount,
  parseRuleConfig,
  principalAccessOfRow,
  type PrincipalAccess,
  type ProtectedBranchConfig,
} from "../../services/branch-protection";
import { PRFlow, PRStatus, type CommitStatusRow } from "../../db/schema";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { ICON_PATHS } from "../icons";
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
  /** The closed arm (`ClosedInfoTitle`/`ClosedInfoBody`) — merged PRs never
   *  reach the render (the loader nulls them), so only the closed-unmerged
   *  shape exists. `null` = open PR. */
  closedInfo: { title: string; body: string } | null;
  statusChecks: PullMergeBoxStatusCheckData | null;
  /** The `InfoSections` — one section per `.item` div (the commit-blocker /
   *  protection-blocker / merge-prompt collection split, pull_merge_box.go:185-190);
   *  sections with no items render nothing (the template's own `{{if}}`). */
  infoSections: PullMergeBoxInfoItem[][];
  /** The WIP line renders when the title carries a prefix (the toggle button
   *  is not rendered — module doc). */
  isWorkInProgress: boolean;
  commands: PullMergeBoxCommands | null;
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
// The status-check context glob (glob.Compile's default-separator compile —
// the same walk branch-protection.ts ports for rule names, separators = []
// so `*` crosses `/` like upstream's status_check_contexts)
// ---------------------------------------------------------------------------

const GLOB_SPECIAL = "*?[]{}\\,";

function contextGlobRegExp(pattern: string): RegExp | null {
  let out = "^";
  for (let pos = 0; pos < pattern.length; pos++) {
    const c = pattern[pos]!;
    if (c === "*") {
      if (pattern[pos + 1] === "*") {
        pos += 1;
        out += ".*";
      } else {
        out += ".*"; // no separators — `*` crosses `/`
      }
    } else if (c === "?") {
      out += ".";
    } else if (c === "[") {
      let cls = "[";
      pos += 1;
      if (pattern[pos] === "!" || pattern[pos] === "^") {
        cls += "^";
        pos += 1;
      }
      let closed = false;
      for (; pos < pattern.length; pos++) {
        const cc = pattern[pos]!;
        if (cc === "]") {
          if (cls === "[" || cls === "[^") return null; // `[]`/`[^]` — the error path
          cls += "]";
          closed = true;
          break;
        }
        cls += cc === "\\" ? `\\${pattern[++pos] ?? ""}` : cc;
      }
      if (!closed) return null; // unterminated class
      out += cls;
    } else if (c === "{") {
      out += "(?:";
      // the {a,b} alternation — a single nesting level is all upstream's
      // status contexts ever carry; the walk matches branch-protection.ts's
      let depth = 1;
      let sub = "";
      for (pos += 1; pos < pattern.length; pos++) {
        const sc = pattern[pos]!;
        if (sc === "{") {
          depth += 1;
          sub += sc;
        } else if (sc === "}") {
          depth -= 1;
          if (depth === 0) break;
          sub += sc;
        } else {
          sub += GLOB_SPECIAL.includes(sc) && sc !== "," ? `\\${sc}` : sc;
        }
      }
      if (depth !== 0) return null; // unterminated `{...}`
      out += sub.replaceAll(",", "|");
      out += ")";
    } else if (GLOB_SPECIAL.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  try {
    return new RegExp(`${out}$`);
  } catch {
    return null; // the compile error path (createRequiredContextMatcher's fallback)
  }
}

/** `createRequiredContextMatcher` (pull.go:584-594): the glob compile, or the
 *  exact-string fallback for invalid patterns. */
function contextMatchesRequired(pattern: string, context: string): boolean {
  const compiled = contextGlobRegExp(pattern);
  return compiled === null ? pattern === context : compiled.test(context);
}

/** `MergeRequiredContextsCommitStatus` (services/pull/commit_status.go:26-68):
 *  no statuses → pending; no required contexts → the plain combine; otherwise
 *  the combine over the matched statuses, pending until EVERY context
 *  matched — unless the matched set already failed. */
function mergeRequiredContextsCommitStatus(statuses: CommitStatusRow[], requiredContexts: string[]): CommitStatusState {
  if (statuses.length === 0) return "pending";
  if (requiredContexts.length === 0) return combinedStateOf(statuses);
  const matched: CommitStatusRow[] = [];
  let allMatched = true;
  for (const pattern of requiredContexts) {
    let contextMatched = false;
    for (const status of statuses) {
      if (contextMatchesRequired(pattern, status.context)) {
        matched.push(status);
        contextMatched = true;
      }
    }
    allMatched = allMatched && contextMatched;
  }
  if (matched.length === 0) return "pending";
  const returned = combinedStateOf(matched);
  if (allMatched) return returned;
  return returned === "failure" ? "failure" : "pending";
}

// ---------------------------------------------------------------------------
// The loader — the prepareMergeBox projection over the landed merge state
// ---------------------------------------------------------------------------

/** The loader input — the rows the route prologue has already resolved
 *  (the repo row is the BASE repo; §2.5's resolution owns visibility) plus
 *  the request origin (the fork fetch line's HeadRepo.HTMLURL absolute half). */
export interface PullMergeBoxInput {
  repo: RepoRow;
  issue: IssueRow;
  pr: PullRequestRow;
  viewer: Viewer;
  origin: string;
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

/**
 * Load the merge box's render inputs. `null` = the route does not render the
 * fragment: the issue is not a pull (upstream's 404), or the PR has merged
 * (upstream's ShowMergeBox=false arm — its only content, the delete-branch
 * button, has no landed write route; module doc). Closed-unmerged PRs DO
 * render (the closed arm), exactly like upstream.
 */
export async function loadPullMergeBoxData(d1: D1Database, input: PullMergeBoxInput): Promise<PullMergeBoxData | null> {
  const { repo, issue, pr, viewer, origin } = input;
  if (!issue.isPull) return null; // ViewPullMergeBox's !issue.IsPull → NotFound
  if (pr.hasMerged) return null; // ShowMergeBox = !HasMerged || IsPullBranchDeletable (delete arm not landed)

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
    };
  }

  // --- the doer's access pair (open PRs only, like upstream's ctx.IsSigned
  // arms — the merge route's own port, principalAccessOfRow) ---------------
  const access: PrincipalAccess =
    viewer.kind === "user"
      ? await principalAccessOfRow(d1, repo, { id: viewer.id, username: viewer.username, isAdmin: viewer.isAdmin })
      : { userId: 0, write: false, admin: false };

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

  return {
    issueLink,
    reloadingInterval: isChecking ? 5000 : 0,
    timelineIconClass,
    closedInfo: null,
    statusChecks,
    infoSections,
    isWorkInProgress,
    commands,
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
 * The tplPullMergeBox fragment's bytes — the `.timeline-item.comment
 * .pull-merge-box` card, no layout. `null` renders the template's
 * ShowMergeBox=false arm: the EMPTY string (the reload loop's stop signal).
 */
export function pullMergeBoxFragmentHtml(data: PullMergeBoxData | null): string {
  if (data === null) return "";
  return renderToString(
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
                  <div>{data.closedInfo.body}</div>
                </div>
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
            {data.isWorkInProgress ? (
              <div class="item flex-left-right">
                <div class="flex-text-block">
                  <MergeBoxSvg name="octicon-x" /> {pullMergeBoxLocale.cannot_merge_work_in_progress}
                </div>
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
    </div>,
  );
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

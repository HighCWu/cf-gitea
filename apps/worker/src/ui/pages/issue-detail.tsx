/**
 * The issue detail page, `/{owner}/{repo}/issues/{index}` — and the PR twin,
 * `/{owner}/{repo}/pulls/{index}`, served by the same is_pull-aware component
 * (a PR IS an issue row with a `pull_requests` extension, SPEC-0005 §3.2).
 * Pages wave 3 (SPEC-0008 U3 extension).
 *
 * ## DOM contract (templates/repo/issue/view.tmpl + view_title.tmpl +
 *  view_content.tmpl + view_content/comments.tmpl + view_content/
 *  pull_merge_box.tmpl + view_content/sidebar.tmpl at the pin)
 *
 * `.page-content.repository.view.issue.pull` (upstream emits both
 * discriminators unconditionally — mirrored verbatim), then inside one
 * `.ui.container`: the `.issue-title-header` (`h1` title + `.index` span,
 * `.issue-title-meta` state label + poster line), the PR tab menu
 * (templates/repo/pulls/tab_menu.tmpl — Conversation + Commits + Files, the
 * three members in the template's order; the Commits tab links the live
 * commits page, pages/pull-commits.tsx), the
 * `.issue-content` two-column grid — `.issue-content-left > .comment-list`
 * holding the root issue comment (`#issue-{id}`), the timeline
 * (`.timeline-item.comment` cards for user comments,
 * `.timeline-item.event` lines with `.badge` state dots for close/reopen/
 * merge, the full `.pull-merge-box` card for non-archived unmerged PRs —
 * pages/pull-merge-box.tsx's fragment rendered INLINE, the webui-parity
 * top-drift 5 mount — and — wave 5 — the
 * signed-in comment form `.timeline-item.comment.form` with the
 * `#status-button` close/reopen toggle) — and
 * `.issue-content-right.ui.segment` (the reduced sidebar: labels + milestone,
 * plus the wave-5 admin label edit form).
 *
 * ## Cross-family URL semantics (upstream ViewIssue, issue_view.go:347-352)
 *
 * "Make sure type and URL matches": `/{issues}/{n}` of a PR row 303s onto
 * `/{pulls}/{n}` and the mirror image (upstream `ctx.Redirect` →
 * `Issue.Link()`; 303 See Other per `services/context/base.go:157`). Unknown
 * indexes 404-shell after the §2.5 repo resolution.
 *
 * ## Data
 *
 * Direct service reads (§3.2, never a self-fetch): `findIssueByRepoAndIndex`
 * + `issueLabelRows` + `listIssueTimeline` + `hasWorkInProgressPrefix`
 * (src/api/services/issues.ts), `findPullRequestByIndex`
 * (src/api/services/pulls.ts), and — PRs — the merge box projection
 * `loadPullMergeBoxData` (pages/pull-merge-box.tsx — the same state the
 * mounted fragment route serves, upstream's prepareMergeBox family), plus
 * one markdown-pipeline call per body and two batched D1 lookups (milestone,
 * person names). Anonymous, public repos only — the router resolved the row
 * before this loader runs (§2.5).
 *
 * ## Documented v1 degradations (data that has no landed source, §6 method)
 *
 * - The PR merge box is the FULL upstream card (pages/pull-merge-box.tsx's
 *   fragment rendered inline — the info items, the status-check section, the
 *   command-line instructions and the bundle's `initRepoPullMergeBox`
 *   reload hook), replacing the wave-3 one-line mergeability summary. What
 *   stays unrendered is the fragment's own documented reduction set: the
 *   merge FORM + update-branch + delete-branch + WIP-toggle are write
 *   actions or pageData islands with no landed web route (the module
 *   header's list, verbatim). Merged PRs render no box (the loader nulls
 *   them — upstream's ShowMergeBox=false arm with the delete button dead);
 *   closed-unmerged PRs render the ClosedInfo pair upstream renders.
 * - Timeline coverage: user comments (type 0) and the lifecycle events the
 *   landed write paths produce — close (2), reopen (1), merge (28). The
 *   remaining system-event types (labels/milestones/title/xrefs/…) are
 *   omitted rather than rendered with approximated text (the §2.4.1 dead-UI
 *   rule applied to prose); they land with their feature waves.
 * - Poster/merger names anchor the `/{username}` profile since wave 7 (the
 *   dead-link unlock — userLink; plain text before the page existed); the
 *   issue row's `original_author` (mirrored imports — no user row, no
 *   profile) still renders plain text / upstream's href-less authorlink
 *   anchor, winning over the user row exactly as upstream renders it.
 * - PR branch names render as `<code>` without links and without the commit
 *   count ("wants to merge X commits from … into …"): both need engine reads
 *   (branch existence, the PR commit range) deferred with the mergeability
 *   wave. The merge-event sha renders as plain short text — the
 *   `/commit/{sha}` page stays engine-owned (open question 1).
 * - Milestone links upstream's `/{repo}/milestone/{id}` (sidebar/
 *   milestone_list.tmpl:49). w129 batch-14 flip: it rendered plain text while
 *   the page was absent (the §2.4.1 dead-link rule won then) — the milestone
 *   detail page landed ui-parity-5 (ca4eb58) and the link went live with it.
 *   Label badges link into the LIVE list filters (`/{issues|pulls}?labels=
 *   {id}` — wave-2 QueryBuild parity). The sidebar's edit dropdowns were
 *   write actions — not rendered (§2.5) until census gap #1 (this window):
 *   the label form landed at wave 5 and the milestone/project/assignee
 *   selects + the header buttons (watch, deadline, pin, lock) land as the
 *   no-JS reductions posting to pages/issue-sidebar-writes.ts's routes (the
 *   routes themselves mount at the orchestrator's fold — that module's
 *   header carries the exact recipe; the sidebar renders regardless, since
 *   the controls' posture is writer/admin-gated by resolveIssueDetailAccess).
 * - Avatar images are not rendered (no avatar route exists; an `<img>` to a
 *   missing route is a dead link) — the timeline items keep the upstream
 *   content structure without the `.timeline-avatar` slots.
 * - The PR conversation tab menu (`repo/pulls/tab_menu.tmpl`) renders the
 *   three tabs (Conversation + Commits + Files — the commits page exists,
 *   pages/pull-commits.tsx). The engine-cost counts render upstream's empty
 *   branch ("-"): the Commits count would cost the commit-range read on
 *   every conversation view and the Files count the full diff read (the
 *   commits/files pages show the real counts — the wave-5 posture, now
 *   symmetric). The tab icons (octicon-comment-discussion / octicon-git-
 *   commit / octicon-diff) are outside the generated icon allowlist
 *   (scripts/gen-ui-icons.mjs is not a ui/ file) — the tabs render text +
 *   count labels only.
 * - The PR files count on the tab menu renders upstream's empty branch ("-"):
 *   the number would cost the full engine diff read on every conversation
 *   view (the files page shows the real count).
 * - Wave-5 writes (SPEC-0008 U3 extension, the second write wave):
 *   - The comment form (view_content.tmpl:71-136) renders for signed-in
 *     viewers; anonymous sees the upstream sign-in warning
 *     (`repo.issues.sign_in_require_desc` onto the /login round-trip), and
 *     archived repos show the upstream `repo.archive.*.nocomment` message.
 *     The combo markdown editor + attachments reduce to a plain
 *     `<textarea name="content">` (the new-issue reduction). POST routes:
 *     `/{owner}/{repo}/{issues|pulls}/{index}/comments` (upstream
 *     routers/web/web.go:1376) — handlers in index.ts, write helpers in this
 *     module (createCommentFromForm), success 303 onto the page with the
 *     `#issuecomment-{id}` anchor when a comment was created (upstream's
 *     `redirect += "#" + comment.HashTag()`, issue_comment.go:74-77).
 *   - The status button (`view_content.tmpl:86-107`) rides the same form
 *     (`name="status" value="close|reopen"`) for the poster or a write-
 *     capable viewer (upstream `CanWriteIssuesOrPulls || IsPoster`,
 *     issue_comment.go:100-102 — reduced to owner/site-admin/write-or-admin
 *     collaborator/poster; a read-mode collaborator misses the button).
 *     Merged PRs show the merged label only — no toggle (upstream's
 *     `!(issue.IsPull && issue.PullRequest.HasMerged)` guard).
 *   - The sidebar label edit form (`sidebar/label_list.tmpl` reduced to a
 *     no-JS two-control shape: the `label_ids` checkbox group + Save) posts
 *     `issue_ids` + `label_ids` to `/{owner}/{repo}/issues/labels` (the
 *     upstream `data-update-url` shape, sidebar/label_list.tmpl:4-6) and
 *     diffs the full set through the landed `IssuesService.replaceLabels`.
 *     The grant is the settings predicate (`canAdminRepo`), NOT upstream's
 *     `reqRepoIssuesOrPullsWriter` (web.go:1397) — the reduced matrix has no
 *     issue-write permission bit; owner/admin is the closest landed grant.
 *   - The status button's reopen glyph degrades: upstream
 *     `octicon-issue-reopened` is outside the generated icon allowlist — the
 *     landed `octicon-issue-opened` stands in (same green).
 * - Reactions, context menus, attachments and the rest of the comment-header
 *   chrome are write actions or signed-in JS features (§2.5) — not rendered.
 *   Content history no longer belongs in that list (w129 batch-14 sweep):
 *   its read fragments landed (cced424 — SPEC-0009's snapshot store) and the
 *   window-2e mount serves `/content-history/{overview,list,detail}` — what
 *   stays unrendered is the comment-header dropdown island that fetches
 *   them, still a signed-in JS feature per §2.5.
 * - Wave-11 (the review interactions, pages/pull-reviews.tsx): the sidebar
 *   leads with the Reviewers section for PRs (sidebar.tmpl:5-9), the
 *   comment form gains the review verdict form below it, and the two POST
 *   re-render paths thread the same data — see that module's header for the
 *   full contract.
 *
 * Bodies render through the SHARED markdown pipeline (§3.4 —
 * src/api/services/markdown.ts in upstream's `comment` mode): relative links
 * rewrite onto the branch-prefixed `/src/...` pages (the pipeline's
 * default-branch fallback), everything else passes; any pipeline failure
 * degrades to the plain no-content variant (markdown never breaks the page).
 */

import { and, asc, desc, eq, inArray, ne, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { renderMarkdownToHtml } from "../../api/services/markdown";
import { listRepoLabels } from "../../api/services/labels";
import {
  findIssueByRepoAndIndex,
  hasWorkInProgressPrefix,
  issueLabelRows,
  listIssueAssignees,
  listIssueTimeline,
} from "../../api/services/issues";
import { ALLOWED_REACTIONS, checkIssueSubscription, listTargetReactions, type ReactionRow } from "../../api/services/issue-extras";
import { findIssueByIdGlobally, listProjects, repoProjectScope, type ProjectRow } from "../../api/services/projects";
import {
  canViewRepositoryWithTeams,
  findRepositoriesByIds,
  findRepositoryById,
  type RepositoryRow,
  type RepositoryWithOwner,
  type UserRow,
  type Viewer as ApiViewer,
} from "../../api/services/repository";
import { collaboratorModeOf } from "../../api/services/repo-collaborators";
import { findPullRequestByIndex } from "../../api/services/pulls";
import { getRepoAssignees } from "../../services/mentions/repo-assignees";
import {
  issueDependencies,
  issuePins,
  issueStopwatches,
  issues as issuesTable,
  milestones,
  projectIssues,
  projects,
  reactions as reactionsTable,
  trackedTimes,
  users,
} from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import { IssuesService } from "../../issues/service";
import { IssueAlreadyChangedError, IssueError } from "../../issues/errors";
import { setIssueReadBy } from "../../services/mentions/carrier";
import type { CommentRow, IssueRow, LabelRow, MilestoneRow, PullRequestRow } from "../../issues/service";
import { canWriteRepo } from "./file-editor";
import { loadPullMergeBoxData, PullMergeBoxFragment, type PullMergeBoxData } from "./pull-merge-box";
import { TimeSince } from "../components/file-list";
import { userLink } from "../links";
import {
  loadPullReviewEntries,
  ReviewFormBlock,
  ReviewersSidebar,
  type PullReviewEntry,
} from "./pull-reviews";
import { LabelBadge } from "./issues-list";
import { canAdminRepo } from "./settings";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";

/** Page chrome text (component-local, the issuesLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const issueDetailLocale = {
  open_title: "Open", // "repo.issues.open_title"
  closed_title: "Closed", // "repo.issues.closed_title"
  merged: "Merged", // "repo.pulls.merged"
  draft_title: "Draft", // "repo.issues.draft_title"
  num_comments_1: "1 comment", // "repo.issues.num_comments_1"
  num_comments: "comments", // "repo.issues.num_comments" (count rendered ahead)
  commented_at: "commented", // "repo.issues.commented_at" (verb; the anchor carries the time)
  no_content: "No description provided.", // "repo.issues.no_content"
  labels: "Labels", // "repo.issues.new.labels"
  no_labels: "No labels", // "repo.issues.new.no_labels"
  milestone: "Milestone", // "repo.issues.new.milestone"
  no_milestone: "No Milestone", // "repo.issues.new.no_milestone"
  reopened_issue: "reopened this issue", // "repo.issues.reopened_at" verb
  closed_issue: "closed this issue", // "repo.issues.closed_at" verb
  reopened_pull: "reopened this pull request", // "repo.pulls.reopened_at" verb
  closed_pull: "closed this pull request", // "repo.pulls.closed_at" verb
  merged_commit: "merged commit", // "repo.issues.comment_pull_merged_at" fragment
  merged_into: "into", // "repo.issues.comment_pull_merged_at" fragment
  // Wave-5 write chrome — the upstream locale strings verbatim.
  create_comment: "Comment", // "repo.issues.create_comment"
  close_issue: "Close Issue", // "repo.issues.close"
  reopen_issue: "Reopen Issue", // "repo.issues.reopen_issue"
  close_pull: "Close Pull Request", // "repo.pulls.close"
  reopen_pull: "Reopen Pull Request", // "repo.pulls.reopen"
  comment_no_content: "No comment provided.", // "repo.issues.comment_no_content"
  comment_on_locked: "You cannot comment on a locked issue.", // "repo.issues.comment_on_locked"
  archive_issue_nocomment: "This repo is archived. You cannot comment on issues.", // "repo.archive.issue.nocomment"
  archive_pull_nocomment: "This repo is archived. You cannot comment on pull requests.", // "repo.archive.pull.nocomment"
  sign_in_require: " to join this conversation.", // "repo.issues.sign_in_require_desc" tail (the <a> prefix renders separately)
  // Tab menu ("repo.pulls.tab_conversation" / "repo.pulls.tab_commits" /
  // "repo.pulls.tab_files").
  tab_conversation: "Conversation",
  tab_commits: "Commits",
  tab_files: "Files Changed",
  save: "Save", // "repo.issues.save" (the no-JS label form's submit)
  comment_placeholder: "", // "repo.diff.comment.placeholder" left empty: the plain-textarea reduction (new-issue pattern)
  // Census gap #1 (the sidebar combo writes + header buttons — the upstream
  // locale strings verbatim; the POST routes live in pages/
  // issue-sidebar-writes.ts, the mount recipe is that module's header).
  projects: "Projects", // "repo.issues.new.projects"
  no_projects: "No projects", // "repo.issues.new.no_projects"
  open_projects: "Open Projects", // "repo.issues.new.open_projects"
  closed_projects: "Closed Projects", // "repo.issues.new.closed_projects"
  open_milestones: "Open", // "repo.issues.filter_milestone_open" (the select's optgroup label)
  closed_milestones: "Closed", // "repo.issues.filter_milestone_closed"
  assignees: "Assignees", // "repo.issues.new.assignees"
  no_assignees: "No Assignees", // "repo.issues.new.no_assignees"
  notifications: "Notifications", // "notification.notifications"
  subscribe: "Subscribe", // "repo.issues.subscribe"
  unsubscribe: "Unsubscribe", // "repo.issues.unsubscribe"
  due_date: "Due Date", // "repo.issues.due_date"
  due_date_not_set: "No due date set.", // "repo.issues.due_date_not_set"
  due_date_form: "yyyy-mm-dd", // "repo.issues.due_date_form"
  due_date_edit: "Edit", // "repo.issues.due_date_form_edit" (the submit button's label)
  due_date_remove: "Remove", // "repo.issues.due_date_form_remove" (the empty submit's label)
  due_date_overdue: "Overdue", // "repo.issues.due_date_overdue" (the tooltip text; renders as the red class's title)
  pin: "Pin", // "pin"
  unpin: "Unpin", // "unpin"
  lock: "Lock conversation", // "repo.issues.lock"
  unlock: "Unlock conversation", // "repo.issues.unlock"
  lock_reason: "Reason for locking", // "repo.issues.lock.reason"
  lock_confirm: "Lock", // "repo.issues.lock_confirm"
  unlock_confirm: "Unlock", // "repo.issues.unlock_confirm"
  // Census gap #1 part two (the timeline writes — the upstream locale
  // strings verbatim; the POST routes live in pages/
  // issue-timeline-writes.ts, the mount recipe is that module's header).
  no_ref: "No Branch/Tag Specified", // "repo.issues.no_ref"
  dependencies: "Dependencies", // "repo.issues.dependency.title"
  no_dependencies: "No dependencies set.", // "repo.issues.dependency.issue_no_dependencies" (the PR twin's string is identical)
  blocks_short: "Blocks", // "repo.issues.dependency.blocks_short"
  blocked_by_short: "Depends on", // "repo.issues.dependency.blocked_by_short"
  add_dependency: "Add dependency…", // "repo.issues.dependency.add"
  dependency_remove: "Remove", // "repo.issues.dependency.remove"
  dependency_hidden_1: "You do not have permission to read 1 dependency", // "repo.issues.dependency.no_permission_1"
  dependency_hidden_n: (n: number): string => `You do not have permission to read ${n} dependencies`, // "repo.issues.dependency.no_permission_n"
  dependency_hidden_can_remove: "You do not have permission to read this dependency but can remove this dependency", // "repo.issues.dependency.no_permission.can_remove"
  tracker: "Time Tracker", // "repo.issues.tracker"
  timer_start: "Start timer", // "repo.issues.timetracker_timer_start"
  timer_stop: "Stop timer", // "repo.issues.timetracker_timer_stop"
  timer_discard: "Discard timer", // "repo.issues.timetracker_timer_discard"
  timer_add: "Add Time", // "repo.issues.timetracker_timer_manually_add"
  add_time_manually: "Manually Add Time", // "repo.issues.add_time_manually"
  add_time_hours: "Hours", // "repo.issues.add_time_hours"
  add_time_minutes: "Minutes", // "repo.issues.add_time_minutes"
  time_estimate_set: "Set estimated time", // "repo.issues.time_estimate_set"
  time_estimate_display: "Estimate: ", // "repo.issues.time_estimate_display" prefix (the value renders after)
  tracking_already_started_prefix: "You have already started time tracking on ", // "repo.issues.tracking_already_started" head (the <a> renders mid-string)
  tracking_already_started_tail: "!", // the sentence tail
  total_time_spent: "Total Time Spent: ", // "repo.issues.time_spent_from_all_authors" prefix
  reactions: "Reactions", // "repo.reactions"
  edit_comment: "Edit", // "repo.issues.context.edit"
  delete_comment: "Delete", // "repo.issues.context.delete"
  delete_issue: "Delete", // "repo.issues.delete" (the issue_management trash button)
} as const;

/** `setting.Repository.Issue.MaxPinned` default (modules/setting/repository.go:223
 *  — the upstream cap the pin button's enabled arm and the write seam both
 *  enforce; the write seam is pages/issue-sidebar-writes.ts, which imports
 *  THIS constant — the render→write import direction keeps the pair acyclic). */
export const ISSUE_DETAIL_MAX_PINNED = 3;

/** The lock-reason dropdown's choices — upstream's default
 *  `setting.Repository.Issue.LockReasons` (modules/setting/repository.go:222). */
export const ISSUE_LOCK_REASONS: readonly string[] = ["Too heated", "Off-topic", "Spam", "Resolved"];

/** The reaction short-code → emoji rendering (upstream ReactionToEmoji,
 *  templates/helper.go:115 → modules/emoji's gemoji data — the instance
 *  default set's exact eight, public/assets/emoji.json). */
export const REACTION_EMOJI: Readonly<Record<string, string>> = {
  "+1": "👍",
  "-1": "👎",
  laugh: "😆",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};

/** One grouped reaction surface: the type, its count, and the reacting
 *  user ids (the render's has-reacted toggle reads the viewer against
 *  them — shared/reactions.tmpl's `$value.HasUser`). */
export interface ReactionGroup {
  type: string;
  count: number;
  userIds: number[];
}

/** GroupByType (models/issues/reaction.go) over the id-ordered rows — the
 *  first-appearance order the template renders in. */
export function groupReactions(rows: ReactionRow[]): ReactionGroup[] {
  const groups: ReactionGroup[] = [];
  const byType = new Map<string, ReactionGroup>();
  for (const row of rows) {
    let group = byType.get(row.type);
    if (group === undefined) {
      group = { type: row.type, count: 0, userIds: [] };
      byType.set(row.type, group);
      groups.push(group);
    }
    group.count += 1;
    group.userIds.push(row.userId);
  }
  return groups;
}

/** One dependency-list entry: the OTHER issue with its repo row and the
 *  viewer's read verdict (issue_dependencies.tmpl's
 *  BlockedBy/BlockingDependencies vs NotPermitted split). */
export interface DependencyEntry {
  issue: IssueRow;
  repo: RepositoryRow;
  permitted: boolean;
}

export interface IssueDependenciesData {
  /** The issues `issue` BLOCKS (the edge (other, issue) side). */
  blocking: DependencyEntry[];
  /** The issues `issue` DEPENDS ON (the edge (issue, other) side). */
  blockedBy: DependencyEntry[];
  blockingHidden: number;
  blockedByHidden: number;
}

/** Timeline cap (upstream renders the full timeline unpaginated; the cap
 *  bounds the render for pathological threads without changing the order). */
export const TIMELINE_LIMIT = 500;

// ---------------------------------------------------------------------------
// Census gap #1 part two reads (the timeline-write family's display inputs)
// ---------------------------------------------------------------------------

/** The doer's running stopwatch (HasUserStopwatch — models/issues/
 * stopwatch.go:31-42's per-user read; at most one row exists, so the
 * single-row probe is exact). The WRITE seams in pages/
 * issue-timeline-writes.ts import these reads (the render→write import
 * direction keeps the pair acyclic). */
export async function stopwatchOfUser(d1: D1Database, userId: number): Promise<{ id: number; issueId: number; createdAt: Date } | null> {
  const row = await drizzle(d1)
    .select({ id: issueStopwatches.id, issueId: issueStopwatches.issueId, createdAt: issueStopwatches.createdAt })
    .from(issueStopwatches)
    .where(eq(issueStopwatches.userId, userId))
    .limit(1)
    .then((rows) => rows[0]);
  return row ?? null;
}

/** The doer's stopwatch ON ONE ISSUE (getStopwatch, stopwatch.go:31-37). */
export async function stopwatchOfIssue(d1: D1Database, userId: number, issueId: number): Promise<{ id: number; createdAt: Date } | null> {
  const row = await drizzle(d1)
    .select({ id: issueStopwatches.id, createdAt: issueStopwatches.createdAt })
    .from(issueStopwatches)
    .where(and(eq(issueStopwatches.userId, userId), eq(issueStopwatches.issueId, issueId)))
    .limit(1)
    .then((rows) => rows[0]);
  return row ?? null;
}

/** The service-side identity of the session viewer (the packages module's
 *  conversion — the api Viewer's requester slice the repo-visibility
 *  predicates read; the file-private twin re-ported here). */
function detailApiUser(viewer: Viewer): ApiViewer["requester"] {
  return viewer.kind === "user" ? { id: viewer.id, login: viewer.username, is_admin: viewer.isAdmin } : null;
}

/** TotalTimesForEachUser (models/issues/tracked_time.go over the live
 *  rows — issue_view.go:614's WorkingUsers), username order. */
async function workingUsersOf(d1: D1Database, issueId: number): Promise<Array<{ user: UserRow; seconds: number }>> {
  const rows = await drizzle(d1)
    .select({ userId: trackedTimes.userId, seconds: trackedTimes.seconds })
    .from(trackedTimes)
    .where(and(eq(trackedTimes.issueId, issueId), eq(trackedTimes.deleted, false)))
    .all();
  if (rows.length === 0) return [];
  const sums = new Map<number, number>();
  for (const row of rows) {
    sums.set(row.userId, (sums.get(row.userId) ?? 0) + row.seconds);
  }
  const userRows = await drizzle(d1).select().from(users).where(inArray(users.id, [...sums.keys()])).orderBy(users.username).all();
  return userRows.map((user) => ({ user, seconds: sums.get(user.id) ?? 0 }));
}

/** SecToHours (the stopwatch/tracked-time chrome format — "1 hour 2
 *  minutes"; the landed issue-tables-t2 port's exact shape). The WRITE
 *  seams in pages/issue-timeline-writes.ts import this (the render→write
 *  import direction). */
export function secToHours(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const unit = (value: number, name: string): string =>
    value === 1 ? `1 ${name} ` : value > 1 ? `${value} ${name}s ` : "";
  let out = `${unit(hours, "hour")}${unit(minutes, "minute")}`;
  if (out === "" && totalSeconds > 0) {
    out = unit(totalSeconds, "second");
  }
  return out.replace(/ $/, "");
}

/** TimeEstimateString (modules/util/time_str.go:82-92): the compact
 *  "1h2m" chain, largest unit first — the estimate input's prefilled
 *  value and the sidebar's display line. */
export function timeEstimateString(amount: number): string {
  let rest = amount;
  let out = "";
  for (const [unit, num] of [
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ] as const) {
    if (rest >= num) {
      out += `${Math.floor(rest / num)}${unit}`;
      rest %= num;
    }
  }
  return out;
}

/** The dependency block's edge read (BlockedByDependencies /
 *  BlockingDependencies, issue.go:670-708): the edges touching this issue,
 *  the OTHER issues + their repo rows joined in, and the per-entry read
 *  verdict (same-repo always; foreign through the viewer-visibility
 *  predicate — the upstream GetDoerRepoPermission.CanReadIssuesOrPulls
 *  stand-in; the batched-verdict shape of the API port's
 *  prepareBlockerBatch). */
async function dependenciesOf(d1: D1Database, issue: IssueRow, origin: string, viewer: Viewer): Promise<IssueDependenciesData> {
  const edges = await drizzle(d1)
    .select({ issueId: issueDependencies.issueId, dependencyId: issueDependencies.dependencyId })
    .from(issueDependencies)
    .where(or(eq(issueDependencies.issueId, issue.id), eq(issueDependencies.dependencyId, issue.id)))
    .all();
  // blockedBy: the edges (issue, other) — this issue depends on them;
  // blocking: the edges (other, issue) — they depend on this one.
  const blockedByIds = edges.filter((edge) => edge.issueId === issue.id).map((edge) => edge.dependencyId);
  const blockingIds = edges.filter((edge) => edge.dependencyId === issue.id).map((edge) => edge.issueId);
  const otherIds = [...new Set([...blockedByIds, ...blockingIds])];
  const otherIssues = otherIds.length === 0 ? [] : await drizzle(d1).select().from(issuesTable).where(inArray(issuesTable.id, otherIds)).all();
  const repoIds = [...new Set(otherIssues.map((row) => row.repoId))];
  const pairs = repoIds.length === 0 ? new Map<string, RepositoryWithOwner>() : await findRepositoriesByIds(d1, repoIds);
  const byId = new Map(otherIssues.map((row) => [row.id, row]));
  const apiViewer: ApiViewer = { origin, requester: detailApiUser(viewer) };
  const canView = new Map<string, boolean>();
  for (const repoId of repoIds) {
    if (repoId === issue.repoId) continue;
    const pair = pairs.get(repoId);
    if (pair !== undefined) {
      canView.set(repoId, await canViewRepositoryWithTeams(d1, apiViewer, pair.repo));
    }
  }
  const build = (ids: number[]): DependencyEntry[] =>
    ids.flatMap((id) => {
      const other = byId.get(id);
      const pair = other === undefined ? undefined : pairs.get(other.repoId);
      if (other === undefined || pair === undefined) return [];
      return [{ issue: other, repo: pair.repo, permitted: other.repoId === issue.repoId || canView.get(other.repoId) === true }];
    });
  const blockedBy = build(blockedByIds);
  const blocking = build(blockingIds);
  return {
    blockedBy,
    blocking,
    blockedByHidden: blockedBy.filter((value) => !value.permitted).length,
    blockingHidden: blocking.filter((value) => !value.permitted).length,
  };
}

// ---------------------------------------------------------------------------
// Data loading (§3.2 direct service calls)
// ---------------------------------------------------------------------------

/** One rendered timeline entry: a user comment or a lifecycle event. */
export type TimelineEntry =
  | { kind: "comment"; comment: CommentRow; posterName: string | null; bodyHtml: string }
  | { kind: "reopen" | "close" | "merge"; comment: CommentRow; posterName: string | null };

/** The issue/PR detail page render inputs, loaded by loadIssueDetailData. */
export interface IssueDetailData {
  /** The URL family the page was addressed by (drives activeTab + verbs). */
  urlKind: "issues" | "pulls";
  issue: IssueRow;
  /** The `pull_requests` extension row — PRs only (§3.2). */
  pr: PullRequestRow | null;
  /** The merge box projection (PRs only — `loadPullMergeBoxData`):
   *  `null` = nothing renders (non-PR rows, archived repos, merged PRs —
   *  upstream's ShowMergeBox=false arm). */
  mergeBox: PullMergeBoxData | null;
  labels: LabelRow[];
  milestone: MilestoneRow | null;
  /** Census gap #1: the sidebar's assignee/project DISPLAY lists — upstream
   *  renders both for every reader (retrieveAssigneesData +
   *  retrieveProjectCardsForExistingIssue run unconditionally in
   *  issue_page_meta.go), so they load outside the writer gates. */
  assignees: UserRow[];
  projects: ProjectRow[];
  /** Display-cased poster username; `null` = no user row (mirrored imports). */
  posterName: string | null;
  mergerName: string | null;
  /** The description through the §3.4 pipeline; `""` = no-content variant. */
  bodyHtml: string;
  timeline: TimelineEntry[];
  /** Wave-11: the visible review rows (PRs only — the sidebar Reviewers
   *  section; the pending-privacy filter applied per the viewer). */
  reviews: PullReviewEntry[];
  /** Census gap #1 part two: the issue-surface reaction groups (commentId
   *  0 — view_content.tmpl:58-61's bar) and the timeline comment bars'
   *  groups keyed by comment row id (comments.tmpl:73-77). */
  issueReactions: ReactionGroup[];
  commentReactions: Map<number, ReactionGroup[]>;
  /** Census gap #1 part two: the signed viewer's running stopwatch
   *  (HasUserStopwatch — at most one row per user); `null` = anonymous.
   *  The sidebar timetracker block's running/other arms read it. */
  viewerStopwatch: { issueId: number; createdAt: Date } | null;
  /** Census gap #1 part two: the OtherStopwatchURL arm (stopwatch_
   *  timetracker.tmpl's warning link) — the canonical page of the OTHER
   *  issue the viewer's stopwatch runs on, `null` when it runs here (or
   *  nowhere, or its row/repo vanished). */
  otherStopwatchUrl: string | null;
  /** Census gap #1 part two: TotalTimesForEachUser over the live rows
   *  (issue_view.go:614 — the WorkingUsers list), username order. */
  workingUsers: Array<{ user: UserRow; seconds: number }>;
  /** Census gap #1 part two: the dependency block's two edge lists with
   *  the per-entry read verdict (issue_dependencies.tmpl). */
  dependencies: IssueDependenciesData;
  /** Census gap #1 part two: the dependency add-form's candidates — the
   *  same-repo issues excluding this one (upstream's search dropdown is a
   *  JS fetch; AllowCrossRepositoryDependencies defaults false), newest
   *  first, capped; `null` = not a writer (the form never renders). */
  dependencyCandidates: IssueRow[] | null;
}

/**
 * The §3.4 shared markdown pipeline in upstream's `comment` mode (the
 * issue-body/comment posture): relative links rewrite against the repo root
 * onto the branch-prefixed `/src/...` pages (markdown.ts's default-branch
 * fallback), the same accepted posture as the README render
 * (page-data.renderRepoMarkdown). Any pipeline failure degrades to `""` —
 * markdown never breaks the page.
 */
export function renderIssueMarkdown(input: { text: string; repo: RepoRow; origin: string }): string {
  if (input.text === "") return "";
  try {
    return renderMarkdownToHtml({
      text: input.text,
      mode: "comment",
      context: `/${input.repo.ownerNamespace}/${input.repo.slug}`,
      wiki: false,
      origin: input.origin,
    });
  } catch {
    return "";
  }
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** The milestones page's formatDueDate twin (pages/milestones.tsx:194 — the
 *  sibling-owned module this render deliberately does NOT import; the UTC
 *  "Jan 2, 2006" shape the sidebar's due-date line and upstream's
 *  DateUtils render share). */
function formatDueDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/**
 * Load one issue/PR with its render inputs. Returns `null` when the index
 * misses (the caller 404-shells) — the row is otherwise rendered as-is,
 * whatever its family; the caller owns the upstream type/URL redirect.
 * Wave-11: the viewer drives the review-row privacy filter (PENDING rows
 * are visible to their reviewer and site admins only — the landed list
 * arm's filter), so a PR's `reviews` load rides the same call.
 *
 * The §13.4 view arm (specs/email-outbound.md): a signed viewer's load
 * marks the issue read for THEM — upstream ViewIssue's
 * `if ctx.IsSigned { SetIssueReadBy(...) }` (issue_view.go:386-391), and
 * because this one loader serves both families, the PR twin
 * (pull.go:150-155) rides the same call. Both halves stamp (the carrier's
 * setIssueReadBy): issue_user.is_read and the derived mailbox's
 * read_at_unix = now. Anonymous loads skip it (ctx.IsSigned's negative).
 * Two deliberate over-fires against the pin's narrower placement, both
 * idempotent no-ops-or-equivalents: (1) the four POST-failure re-render
 * callers of this loader also mark, where upstream's POST handlers don't
 * — their SUCCESS paths 303 onto this page and mark through the view
 * anyway; (2) the mark precedes the caller's crossFamilyRedirect, so a
 * wrong-family URL marks before its 303 (upstream redirects first,
 * issue_view.go:347-352 — the redirect target's own view then marks once).
 * Error posture is upstream's: a failed mark fails the view
 * (issue_view.go:390-392, ctx.ServerError("ReadBy", err)).
 */
export async function loadIssueDetailData(
  d1: D1Database,
  repo: RepoRow,
  urlKind: "issues" | "pulls",
  index: number,
  origin: string,
  viewer: Viewer,
): Promise<IssueDetailData | null> {
  const issue = await findIssueByRepoAndIndex(d1, repo.id, index);
  if (issue === null) return null;

  // The view seam's read-mark — the signed viewer only (issue_view.go:386-
  // 391; the header note's over-fire inventory). Runs before the render
  // assembly, upstream's mark position ahead of the page metadata.
  if (viewer.kind === "user") {
    await setIssueReadBy(d1, issue.id, viewer.id, new Date());
  }

  const pr = issue.isPull ? ((await findPullRequestByIndex(d1, repo.id, index))?.pullRequest ?? null) : null;
  const reviews = pr === null ? [] : await loadPullReviewEntries(d1, issue.id, viewer);
  // The upstream conversation page computes the merge box server-side on
  // every view (prepareMergeBox, issue_view.go:413); the archived gate is
  // view_content.tmpl:67's `not $.Repository.IsArchived` — the fragment
  // loader itself stays repo-shape-only (the route arm carries no archive
  // refusal either).
  const mergeBox =
    issue.isPull && pr !== null && !repo.isArchived
      ? await loadPullMergeBoxData(d1, { repo, issue, pr, viewer, origin })
      : null;

  const [labels, timelineRows, milestoneRow, assigneeRows, projectRows] = await Promise.all([
    issueLabelRows(d1, issue.id),
    listIssueTimeline(d1, issue.id, null, null, 1, TIMELINE_LIMIT),
    issue.milestoneId === null
      ? Promise.resolve(null)
      : drizzle(d1)
          .select()
          .from(milestones)
          .where(eq(milestones.id, issue.milestoneId))
          .limit(1)
          .then((rows) => rows[0] ?? null),
    // The sidebar display lists (the census-gap-#1 note on IssueDetailData).
    listIssueAssignees(d1, issue.id),
    drizzle(d1)
      .select({ project: projects })
      .from(projectIssues)
      .innerJoin(projects, eq(projects.id, projectIssues.projectId))
      .where(eq(projectIssues.issueId, issue.id))
      .all()
      .then((rows) => rows.map((row) => row.project)),
  ]);

  // One batched name lookup for every person the render mentions (§3.2's
  // wave-2 batching pattern): poster, merger, timeline posters.
  const personIds = new Set<number>();
  if (issue.posterId !== null) personIds.add(issue.posterId);
  if (pr !== null && pr.hasMerged && pr.mergerId != null) personIds.add(pr.mergerId);
  for (const comment of timelineRows) {
    if (comment.posterId !== null) personIds.add(comment.posterId);
  }
  const names = new Map<number, string>();
  if (personIds.size > 0) {
    const rows = await drizzle(d1)
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, [...personIds]))
      .all();
    for (const row of rows) names.set(row.id, row.username);
  }
  const nameOf = (id: number | null): string | null => (id === null ? null : (names.get(id) ?? null));

  const timeline: TimelineEntry[] = [];
  for (const comment of timelineRows) {
    const posterName = nameOf(comment.posterId);
    if (comment.type === CommentType.Comment) {
      timeline.push({
        kind: "comment",
        comment,
        posterName,
        bodyHtml: renderIssueMarkdown({ text: comment.content ?? "", repo, origin }),
      });
    } else if (comment.type === CommentType.Reopen || comment.type === CommentType.Close || comment.type === CommentType.MergePull) {
      const kind = comment.type === CommentType.Reopen ? "reopen" : comment.type === CommentType.Close ? "close" : "merge";
      timeline.push({ kind, comment, posterName });
    }
    // Every other system-event type stays unrendered this wave (header
    // comment: omitted rather than approximated).
  }

  // Census gap #1 part two: the reaction bars (the issue surface + every
  // rendered comment's bar — one batched query over the rendered comment
  // ids, the landed listTargetReactions filter shape), the viewer's
  // running stopwatch, the WorkingUsers totals, and the dependency edges.
  const commentIds = timeline.filter((entry) => entry.kind === "comment").map((entry) => entry.comment.id);
  const [issueReactionRows, commentReactionRows, viewerStopwatch, workingUsers, dependencies] = await Promise.all([
    listTargetReactions(d1, issue.id, 0),
    commentIds.length === 0
      ? Promise.resolve([] as Array<{ id: number; userId: number; type: string; commentId: number }>)
      : drizzle(d1)
          .select({ id: reactionsTable.id, userId: reactionsTable.userId, type: reactionsTable.type, commentId: reactionsTable.commentId })
          .from(reactionsTable)
          .where(and(eq(reactionsTable.issueId, issue.id), inArray(reactionsTable.commentId, commentIds), eq(reactionsTable.releaseId, 0)))
          .orderBy(asc(reactionsTable.id))
          .all(),
    viewer.kind === "user" ? stopwatchOfUser(d1, viewer.id) : Promise.resolve(null),
    workingUsersOf(d1, issue.id),
    dependenciesOf(d1, issue, origin, viewer),
  ]);
  const commentReactions = new Map<number, ReactionGroup[]>();
  for (const row of commentReactionRows) {
    const groups = commentReactions.get(row.commentId) ?? [];
    const group = groups.find((candidate) => candidate.type === row.type);
    if (group === undefined) {
      groups.push({ type: row.type, count: 1, userIds: [row.userId] });
    } else {
      group.count += 1;
      group.userIds.push(row.userId);
    }
    commentReactions.set(row.commentId, groups);
  }

  // The OtherStopwatchURL arm — the OTHER issue the viewer's stopwatch
  // runs on (stopwatch_timetracker.tmpl's warning link). A missing row or
  // repo degrades to no link (the message renders without it only in the
  // logged-in block; a vanished row keeps the arm silent).
  let otherStopwatchUrl: string | null = null;
  if (viewerStopwatch !== null && viewerStopwatch.issueId !== issue.id) {
    const otherIssue = await findIssueByIdGlobally(d1, viewerStopwatch.issueId);
    const otherRepo = otherIssue === null ? null : await findRepositoryById(d1, otherIssue.repoId);
    if (otherIssue !== null && otherRepo !== null) {
      otherStopwatchUrl = `/${otherRepo.repo.ownerNamespace}/${otherRepo.repo.slug}/${otherIssue.isPull ? "pulls" : "issues"}/${otherIssue.index}`;
    }
  }

  return {
    urlKind,
    issue,
    pr,
    mergeBox,
    reviews,
    labels,
    milestone: milestoneRow,
    assignees: assigneeRows,
    projects: projectRows,
    posterName: nameOf(issue.posterId),
    mergerName: pr !== null && pr.hasMerged ? nameOf(pr.mergerId ?? null) : null,
    bodyHtml: renderIssueMarkdown({ text: issue.content ?? "", repo, origin }),
    timeline,
    issueReactions: groupReactions(issueReactionRows),
    commentReactions,
    viewerStopwatch,
    otherStopwatchUrl,
    workingUsers,
    dependencies,
    dependencyCandidates: null, // the writer-gated list fills in resolveIssueDetailAccess
  };
}

/**
 * Upstream ViewIssue's type/URL match (issue_view.go:347-352): the wrong URL
 * family for the row redirects onto `Issue.Link()`. Returns the target when
 * the families mismatch, `null` when the page can render in place.
 */
export function crossFamilyRedirect(
  urlKind: "issues" | "pulls",
  repoLink: string,
  index: number,
  isPull: boolean,
): string | null {
  const expected = isPull ? "pulls" : "issues";
  return urlKind === expected ? null : `${repoLink}/${expected}/${index}`;
}

// ---------------------------------------------------------------------------
// Wave-5 write paths (§3.2 — the landed services, never a self-fetch)
// ---------------------------------------------------------------------------

/** Sidebar picker cap (the new-issue page's NEW_ISSUE_PICKER_LIMIT pattern:
 *  one page read; the upstream dropdown pages too, through the JS path). */
export const ISSUE_DETAIL_PICKER_LIMIT = 100;

/** The per-viewer write grants the detail page's forms render against. */
export interface IssueDetailAccess {
  /** The status button's grant — upstream `CanWriteIssuesOrPulls ||
   *  IsPoster` (issue_comment.go:100-102), reduced to site admin / owner
   *  (case-folded namespace) / write-or-admin collaborator / poster. */
  canChangeState: boolean;
  /** The repo's labels for the admin edit form (`canAdminRepo` — the
   *  settings predicate); `null` = not an admin, the sidebar renders
   *  display-only exactly as before wave 5. */
  labelOptions: LabelRow[] | null;
  /** Wave-11: `CanDoerChangeReviewRequests` (the landed
   *  pull-reviews.ts:388-396 port) — gates the Reviewers section's
   *  request-review control. */
  canChangeReviewRequests: boolean;
  /** Wave-11: the repo-admin half of upstream `CanBeDismissed`
   *  (issue_page_meta.go:477-478 — `canAdminRepo`, the settings predicate,
   *  stands in for `ctx.Repo.Permission.IsAdmin()`). */
  canDismissReviews: boolean;
  /** Census gap #1: upstream `CanModifyIssueOrPull` (issue_page_meta.go:117
   *  — CanWriteIssuesOrPulls && !archived) over the SAME predicate the
   *  write seams enforce (`canWriteRepo`, the repo-grants.ts bridge rule);
   *  gates the milestone/project/assignee selects + the deadline form. */
  canModifyIssueOrPull: boolean;
  /** Census gap #1: the issue_management block's gate (sidebar/
   *  issue_management.tmpl's `and .IsRepoAdmin (not .Repository.IsArchived)`
   *  — `canAdminRepo` is the IsRepoAdmin stand-in). */
  canManageIssue: boolean;
  /** Census gap #1: the pin button's state (issue_view.go:645-659) —
   *  `pinned` (the issue_pins row exists) and `canAddPin` (upstream
   *  NewPinAllowed = IsNewPinAllowed: the type-half count sits under
   *  ISSUE_DETAIL_MAX_PINNED); `null` = not an admin (the block never
   *  renders, the reads stay unloaded). */
  pin: { pinned: boolean; canAddPin: boolean } | null;
  /** Census gap #1: the signed viewer's CheckIssueWatch state
   *  (issue_view.go:573-584 → the landed checkIssueSubscription); `null` =
   *  anonymous (the subscribe button never renders). */
  watching: boolean | null;
  /** Census gap #1: the milestone select's options — open + closed, the
   *  upstream retrieveMilestonesDataForIssueWriter grouping; `null` = not
   *  a writer (canModifyIssueOrPull false — the upstream gate that wraps
   *  the retrieval). */
  milestoneOptions: { open: MilestoneRow[]; closed: MilestoneRow[] } | null;
  /** Census gap #1: the project select's options — the repo-scope + owner-
   *  scope lists (retrieveProjectsInternal's two arms), open + closed;
   *  `null` = not a writer. */
  projectOptions: { open: ProjectRow[]; closed: ProjectRow[] } | null;
  /** Census gap #1: the assignee select's candidates — GetRepoAssignees
   *  (retrieveAssigneesData's enumeration); `null` = not a writer. */
  assigneeOptions: UserRow[] | null;
  /** Census gap #1 part two: the default-settings CanUseTimetracker
   *  (services/context/repo.go:270 — the timetracker has no settings
   *  module landed, so enabled + AllowOnlyContributorsToTrackTime=false
   *  hold and ANY signed-in viewer passes; the gate is the session +
   *  the live repo). Gates the sidebar timetracker block's write forms. */
  canUseTimetracker: boolean;
  /** Census gap #1 part two: the dependency add-form's candidates (same
   *  repo, excluding this issue, newest first — the module header's
   *  cross-repo-default note); `null` = not a writer. */
  dependencyCandidates: IssueRow[] | null;
}

/** Resolve both grants in one place (the settings gate's order: anonymous
 *  viewers never qualify). The admin arm rides the landed `isRepositoryAdmin`
 *  through `canAdminRepo` (../repo-grants.ts's bridge) — it needs the full
 *  `Env` the service predicates read; the issue-unit arms keep their D1-only
 *  collaborator/poster reads. Census gap #1 extends the same resolver with
 *  the sidebar writes' grants + their option lists (the writer/admin-gated
 *  reads stay inside this one seam so the GET page and every failure
 *  re-render carry identical data). */
export async function resolveIssueDetailAccess(
  env: Env,
  repo: RepoRow,
  viewer: Viewer,
  issue: IssueRow,
): Promise<IssueDetailAccess> {
  if (viewer.kind === "anonymous") {
    return {
      canChangeState: false,
      labelOptions: null,
      canChangeReviewRequests: false,
      canDismissReviews: false,
      canModifyIssueOrPull: false,
      canManageIssue: false,
      pin: null,
      watching: null,
      milestoneOptions: null,
      projectOptions: null,
      assigneeOptions: null,
      canUseTimetracker: false,
      dependencyCandidates: null,
    };
  }
  const d1 = env.DB;
  const isOwner = repo.ownerNamespace.toLowerCase() === viewer.username.toLowerCase();
  const collabMode: "none" | "read" | "write" | "admin" = isOwner
    ? "admin" // the owner outranks any collaborator row (canAdminRepo's owner line)
    : await collaboratorModeOf(d1, repo.id, viewer.id);
  const canChangeState =
    viewer.isAdmin || isOwner || issue.posterId === viewer.id || collabMode === "write" || collabMode === "admin";
  const admin = await canAdminRepo(env, repo, viewer);
  // Census gap #1: the writer grant rides the SAME predicate the write
  // seams enforce (canWriteRepo → canWriteRepository, the repo-grants.ts
  // rule) — the local owner/collab arms here would drop the §3.5 team arm.
  const [writer, labelOptions, pinRow] = await Promise.all([
    repo.isArchived ? Promise.resolve(false) : canWriteRepo(env, repo, viewer),
    admin ? listRepoLabels(d1, repo.id, "", 1, ISSUE_DETAIL_PICKER_LIMIT).then((page) => page.items) : Promise.resolve(null),
    admin
      ? drizzle(d1)
          .select({ pinOrder: issuePins.pinOrder })
          .from(issuePins)
          .where(eq(issuePins.issueId, issue.id))
          .limit(1)
          .get()
      : Promise.resolve(undefined),
  ]);
  const labelOptionsValue = labelOptions;
  // The option lists + assignee candidates load for writers only (upstream's
  // retrieve*ForIssueWriter gate); the pin STATE row loads for admins only
  // (the issue_management block is admin-gated — anonymous and plain readers
  // never see it, so the reads stay unloaded).
  const canModifyIssueOrPull = writer;
  const canManageIssue = admin && !repo.isArchived;
  const ownerProjectScope =
    canModifyIssueOrPull && repo.ownerId !== null
      ? await drizzle(d1)
          .select({ type: users.type })
          .from(users)
          .where(eq(users.id, repo.ownerId))
          .limit(1)
          .get()
      : undefined;
  const [openMilestones, closedMilestones, openProjects, closedProjects, ownerProjects, assigneeCandidates, currentAssignees, watching] =
    await Promise.all([
      canModifyIssueOrPull ? new IssuesService(d1).listMilestones(repo.id, "open") : Promise.resolve([]),
      canModifyIssueOrPull ? new IssuesService(d1).listMilestones(repo.id, "closed") : Promise.resolve([]),
      canModifyIssueOrPull ? listProjects(d1, repoProjectScope(repo.id), false, 1, ISSUE_DETAIL_PICKER_LIMIT).then((page) => page.items) : Promise.resolve([]),
      canModifyIssueOrPull ? listProjects(d1, repoProjectScope(repo.id), true, 1, ISSUE_DETAIL_PICKER_LIMIT).then((page) => page.items) : Promise.resolve([]),
      // retrieveProjectsInternal's owner arm: the owning user/org's own
      // projects (the scope kind follows the owner row's type).
      ownerProjectScope !== undefined && ownerProjectScope !== null
        ? listProjects(
            d1,
            { kind: ownerProjectScope.type === "org" ? "organization" : "individual", repoId: null, ownerId: repo.ownerId },
            false,
            1,
            ISSUE_DETAIL_PICKER_LIMIT,
          ).then((page) => page.items)
        : Promise.resolve([]),
      canModifyIssueOrPull ? getRepoAssignees(d1, { id: repo.id, ownerId: repo.ownerId }) : Promise.resolve([]),
      // The CURRENT assignees join the candidate set: upstream's combo value
      // is SelectedAssigneeIDs (every current assignee, candidate or not —
      // issue_page_meta.go:253-260), so an out-of-band assignee must stay
      // represented in the picker or a resubmit would silently detach them
      // (the diff's baseline is the full set, not the candidates).
      canModifyIssueOrPull ? listIssueAssignees(d1, issue.id) : Promise.resolve([]),
      checkIssueSubscription(d1, viewer.id, issue),
    ]);
  const assigneeOptions: UserRow[] = [...assigneeCandidates];
  for (const current of currentAssignees) {
    if (!assigneeOptions.some((candidate) => candidate.id === current.id)) {
      assigneeOptions.push(current);
    }
  }
  // Census gap #1 part two: the dependency candidates (same repo, this
  // issue excluded, newest first — the add-form select's options; upstream
  // cross-repo dependencies default off, the module header).
  const dependencyCandidates = canModifyIssueOrPull
    ? await drizzle(d1)
        .select()
        .from(issuesTable)
        .where(and(eq(issuesTable.repoId, repo.id), ne(issuesTable.id, issue.id)))
        .orderBy(desc(issuesTable.updatedAt))
        .limit(ISSUE_DETAIL_PICKER_LIMIT)
        .all()
    : null;
  return {
    canChangeState,
    labelOptions: labelOptionsValue,
    canChangeReviewRequests:
      !repo.isArchived &&
      (viewer.isAdmin || isOwner || issue.posterId === viewer.id || collabMode !== "none"),
    canDismissReviews: admin,
    canModifyIssueOrPull,
    canManageIssue,
    pin:
      admin && !repo.isArchived
        ? {
            pinned: pinRow !== undefined,
            canAddPin:
              pinRow !== undefined ? true : (await countTypePins(d1, repo.id, issue.isPull)) < ISSUE_DETAIL_MAX_PINNED,
          }
        : null,
    watching,
    milestoneOptions: canModifyIssueOrPull ? { open: openMilestones, closed: closedMilestones } : null,
    projectOptions: canModifyIssueOrPull ? { open: [...openProjects, ...ownerProjects], closed: closedProjects } : null,
    assigneeOptions: canModifyIssueOrPull ? assigneeOptions : null,
    canUseTimetracker: !repo.isArchived,
    dependencyCandidates,
  };
}

/** getPinnedIssuesNum's port (issue_pin.go:119-127 — the type-half count the
 *  NewPinAllowed arm reads; the write seam re-ports the max sibling). */
async function countTypePins(d1: D1Database, repoId: string, isPull: boolean): Promise<number> {
  const rows = await drizzle(d1)
    .select({ pinOrder: issuePins.pinOrder })
    .from(issuePins)
    .innerJoin(issuesTable, eq(issuesTable.id, issuePins.issueId))
    .where(and(eq(issuePins.repoId, repoId), eq(issuesTable.isPull, isPull)))
    .all();
  return rows.length;
}

/** The parsed `application/x-www-form-urlencoded` comment POST (`content`
 *  single-value, `status` single-value — the close/reopen submit button's
 *  field; anything else means a plain comment). */
export interface CommentForm {
  content: string;
  status: string;
}

export function parseCommentForm(params: URLSearchParams): CommentForm {
  return { content: params.get("content") ?? "", status: params.get("status") ?? "" };
}

export type CommentSubmitResult =
  | { outcome: "created"; comment: CommentRow; stateChanged: boolean }
  | { outcome: "state-only"; stateChanged: boolean }
  | { outcome: "invalid"; message: string };

/**
 * The comment/state write — upstream `NewComment`
 * (routers/web/repo/issue_comment.go:37-118) reduced to the landed services:
 *
 * - archived repos refuse the write (the `MustAllowUserComment`-family
 *   posture; the message cites the upstream `repo.archive.*.nocomment` text);
 * - a locked issue is commentable only by a state-capable viewer (the
 *   middleware's `IsLocked && !CanWrite && !IsAdmin` branch, issue.go:86-90);
 * - non-empty content creates through `IssuesService.addComment`;
 * - empty content with no `status` is the upstream "No comment provided."
 *   rejection (issue_comment.go:84-88);
 * - a `close`/`reopen` status from a state-capable viewer (never on a merged
 *   PR — issue_comment.go:101-102) runs `IssuesService.closeIssue` /
 *   `reopenIssue` with the viewer as actor; a CAS race (IssueAlreadyChanged)
 *   degrades to a plain redirect — the winner's state is already what the
 *   button asked for.
 */
export async function createCommentFromForm(
  d1: D1Database,
  repo: RepoRow,
  issue: IssueRow,
  pr: PullRequestRow | null,
  viewer: Viewer,
  access: IssueDetailAccess,
  form: CommentForm,
): Promise<CommentSubmitResult> {
  const archivedMessage = issue.isPull ? issueDetailLocale.archive_pull_nocomment : issueDetailLocale.archive_issue_nocomment;
  if (repo.isArchived) return { outcome: "invalid", message: archivedMessage };
  if (issue.isLocked && !access.canChangeState) {
    return { outcome: "invalid", message: issueDetailLocale.comment_on_locked };
  }

  const content = form.content;
  let comment: CommentRow | null = null;
  if (content !== "") {
    try {
      comment = await new IssuesService(d1).addComment({ issueId: issue.id, posterId: viewer.kind === "user" ? viewer.id : null, content });
    } catch (error) {
      if (error instanceof IssueError) return { outcome: "invalid", message: error.message };
      throw error;
    }
  } else if (form.status === "") {
    return { outcome: "invalid", message: issueDetailLocale.comment_no_content };
  }

  let stateChanged = false;
  if ((form.status === "close" || form.status === "reopen") && access.canChangeState && !(pr !== null && pr.hasMerged)) {
    const service = new IssuesService(d1);
    try {
      if (form.status === "close") await service.closeIssue(issue.id, { actorId: viewer.kind === "user" ? viewer.id : null });
      else await service.reopenIssue(issue.id, { actorId: viewer.kind === "user" ? viewer.id : null });
      stateChanged = true;
    } catch (error) {
      if (!(error instanceof IssueAlreadyChangedError)) throw error;
      // CAS loser: the requested state already holds (a concurrent toggle
      // won). Upstream tolerates the no-op and redirects; so do we.
      stateChanged = false;
    }
  }
  if (comment !== null) return { outcome: "created", comment, stateChanged };
  return { outcome: "state-only", stateChanged };
}

/** The parsed `/{owner}/{repo}/issues/labels` POST (`issue_ids` first value,
 *  `label_ids` multi-value — the upstream field names, sidebar/label_list.tmpl
 *  lines 4-6; non-numeric ids are dropped like parseNewIssueForm's). */
export interface IssueLabelForm {
  issueId: number | null;
  labelIds: number[];
}

export function parseIssueLabelForm(params: URLSearchParams): IssueLabelForm {
  const rawIssue = (params.get("issue_ids") ?? "").trim();
  return {
    issueId: /^\d+$/.test(rawIssue) ? Number.parseInt(rawIssue, 10) : null,
    labelIds: [...new Set(
      params
        .getAll("label_ids")
        .map((entry) => Number.parseInt(entry, 10))
        .filter((entry) => Number.isInteger(entry) && entry > 0),
    )],
  };
}

export type IssueLabelResult = { outcome: "applied" } | { outcome: "invalid"; message: string };

/**
 * The label add/remove write: the submitted set REPLACES the issue's labels
 * through `IssuesService.replaceLabels` — the service diffs attach/detach
 * with the closed-state-aware counter maintenance (upstream's per-id
 * attach/detach POSTs from repo-issue-sidebar-combolist.ts reduced to one
 * diff-based write with the same end state). A rejected label id (foreign
 * repo/org) surfaces the service's NoSuchLabel message inline.
 */
export async function applyIssueLabels(
  d1: D1Database,
  issue: IssueRow,
  form: IssueLabelForm,
): Promise<IssueLabelResult> {
  try {
    await new IssuesService(d1).replaceLabels(issue.id, form.labelIds, { ownerOrgId: null });
    return { outcome: "applied" };
  } catch (error) {
    if (error instanceof IssueError) return { outcome: "invalid", message: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The title-bar slice of IssueDetailData — the pull-files page rebuilds the
 *  same bar from its lighter loader (pulls/files.tmpl renders view_title
 *  above the tab menu). */
export type IssueTitleData = Pick<IssueDetailData, "issue" | "pr" | "posterName" | "mergerName">;

/** The state chip of view_title.tmpl, in the template's branch order:
 *  merged → closed → draft → open, with the exact label/icon pairs (the
 *  issue-state octicons render since the wave-4 multi-path Icon — the
 *  wave-3 degradation note is retired). */
export function IssueStateBadge(props: { data: IssueTitleData }) {
  const { issue, pr } = props.data;
  if (pr !== null && pr.hasMerged) {
    return (
      <div class="ui purple label issue-state-label">
        <Icon name="octicon-git-merge" class="tw-mr-1" /> {issueDetailLocale.merged}
      </div>
    );
  }
  if (issue.isClosed) {
    return (
      <div class="ui red label issue-state-label">
        <Icon name={issue.isPull ? "octicon-git-pull-request-closed" : "octicon-issue-closed"} />{" "}
        {issueDetailLocale.closed_title}
      </div>
    );
  }
  if (issue.isPull) {
    if (hasWorkInProgressPrefix(issue.title)) {
      return (
        <div class="ui grey label issue-state-label">
          <Icon name="octicon-git-pull-request-draft" /> {issueDetailLocale.draft_title}
        </div>
      );
    }
    return (
      <div class="ui green label issue-state-label">
        <Icon name="octicon-git-pull-request" /> {issueDetailLocale.open_title}
      </div>
    );
  }
  return (
    <div class="ui green label issue-state-label">
      <Icon name="octicon-issue-opened" /> {issueDetailLocale.open_title}
    </div>
  );
}

/** The issue meta line: "opened {time} by {poster} · {n} comments" — wave 7
 *  (the dead-link unlock): the poster anchors the `/{username}` profile
 *  (upstream view_title.tmpl:135-136's HomeLink shape); `original_author`
 *  (mirrored imports — no user row, no profile) wins as plain text exactly
 *  like upstream's opened_by_fake branch (view_title.tmpl:133-134). */
function IssueMetaLine(props: { data: IssueTitleData }) {
  const { issue, posterName } = props.data;
  const count =
    issue.numComments === 1 ? issueDetailLocale.num_comments_1 : `${issue.numComments} ${issueDetailLocale.num_comments}`;
  return (
    <span class="time-desc">
      opened{" "}
      {issue.createdAt !== null ? <TimeSince unixSeconds={unixSeconds(issue.createdAt)} tz="+0000" /> : null}
      {issue.originalAuthor !== null ? (
        <> by {issue.originalAuthor}</>
      ) : posterName !== null ? (
        <>
          {" "}by <a href={userLink(posterName)}>{posterName}</a>
        </>
      ) : null}
      {` · ${count}`}
    </span>
  );
}

/** The PR meta line: "{poster} wants to merge {head} into {base}" (merged:
 *  "{merger} merged … {time}") — the upstream pull-desc shape with the
 *  branch names as `<code>` text (branch links + commit count are engine
 *  reads; header comment). Wave 7: the actor anchors the `/{username}`
 *  profile (shared/user/authorlink.tmpl's HomeLink shape via userLink). */
function PullMetaLine(props: { data: IssueTitleData }) {
  const { pr, posterName, mergerName } = props.data;
  if (pr === null) return null;
  if (pr.hasMerged) {
    const actor = mergerName ?? posterName;
    return (
      <span id="pull-desc-display" class="pull-desc">
        {actor !== null ? (
          <a class="tw-font-semibold" href={userLink(actor)}>
            {actor}
          </a>
        ) : null}{" "}
        merged <code>{pr.headBranch}</code> {issueDetailLocale.merged_into} <code>{pr.baseBranch}</code>
        {pr.mergedAt !== null && pr.mergedAt !== undefined ? (
          <>
            {" "}
            <TimeSince unixSeconds={unixSeconds(pr.mergedAt)} tz="+0000" />
          </>
        ) : null}
      </span>
    );
  }
  return (
    <span id="pull-desc-display" class="pull-desc">
      {posterName !== null ? (
        <a class="tw-font-semibold" href={userLink(posterName)}>
          {posterName}
        </a>
      ) : null}{" "}
      wants to merge <code>{pr.headBranch}</code> {issueDetailLocale.merged_into} <code>{pr.baseBranch}</code>
    </span>
  );
}

/** `view_title.tmpl` reduced: the `h1` (#index included) and the state/meta
 *  line — the edit/New buttons are write actions, not rendered (§2.5). */
export function IssueTitleBar(props: { data: IssueTitleData }) {
  const { issue, pr } = props.data;
  return (
    <div class="issue-title-header">
      <div class="issue-title" id="issue-title-display">
        <h1>
          {issue.title} <span class="index">#{issue.index}</span>
        </h1>
      </div>
      <div class="issue-title-meta flex-text-block">
        <IssueStateBadge data={props.data} />
        <div class="flex-text-block">{pr === null ? <IssueMetaLine data={props.data} /> : <PullMetaLine data={props.data} />}</div>
      </div>
    </div>
  );
}

/** The PR tab menu (`repo/pulls/tab_menu.tmpl`, the three members in the
 *  template's order: Conversation + Commits + Files — the commits page is
 *  live, pages/pull-commits.tsx). The engine-cost counts render upstream's
 *  empty branch "-": the Commits count would cost the commit-range read on
 *  every conversation view, the Files count the full diff read (each page
 *  shows its own real count; the wave-5 posture, now symmetric). The tab
 *  octicons are outside the generated allowlist — text + count only. */
export function PullTabs(props: {
  repoLink: string;
  issue: IssueRow;
  active: "conversation" | "commits" | "files";
  commitsCount: number | null;
  filesCount: number | null;
}) {
  const base = `${props.repoLink}/pulls/${props.issue.index}`;
  return (
    <div class="ui pull tabs container">
      <div class="ui top attached pull tabular menu">
        <a class={props.active === "conversation" ? "active item" : "item"} href={base}>
          {issueDetailLocale.tab_conversation}
          <span class="ui small label">{props.issue.numComments}</span>
        </a>
        <a class={props.active === "commits" ? "active item" : "item"} href={`${base}/commits`}>
          {issueDetailLocale.tab_commits}
          <span class="ui small label">{props.commitsCount === null ? "-" : props.commitsCount}</span>
        </a>
        <a class={props.active === "files" ? "active item" : "item"} href={`${base}/files`}>
          {issueDetailLocale.tab_files}
          <span class="ui small label">{props.filesCount === null ? "-" : props.filesCount}</span>
        </a>
      </div>
      <div class="ui tabs divider" />
    </div>
  );
}

/** The comment header line both comment cards share: "{poster} commented
 *  {time}" — the upstream `commented_at` shape. Wave 7 (the dead-link
 *  unlock): the poster anchors the `/{username}` profile through
 *  shared/user/authorlink.tmpl's shape (`tw-font-semibold` + HomeLink);
 *  an original author (mirrored import — no user row, no profile) keeps
 *  upstream's href-less authorlink anchor (comments.tmpl:31-34). */
function CommentHeader(props: {
  hash: string;
  posterName: string | null;
  originalAuthor?: string | null;
  createdAt: Date | null;
}) {
  return (
    <div class="comment-header avatar-content-left-arrow" role="heading" aria-level="3">
      <div class="comment-header-left">
        <span class="tw-text-text-light muted-links">
          {props.originalAuthor != null ? (
            <a class="tw-font-semibold">{props.originalAuthor}</a>
          ) : props.posterName !== null ? (
            <a class="tw-font-semibold" href={userLink(props.posterName)}>
              {props.posterName}
            </a>
          ) : null}{" "}
          {issueDetailLocale.commented_at}{" "}
          {props.createdAt !== null ? (
            <a href={`#${props.hash}`}>
              <TimeSince unixSeconds={unixSeconds(props.createdAt)} tz="+0000" />
            </a>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** The render-content body both comment cards share (view_content.tmpl's
 *  `.ui.attached.segment.comment-body`): pipeline HTML, or the upstream
 *  no-content placeholder. */
function CommentBody(props: { bodyHtml: string }) {
  return (
    <div class="ui attached segment comment-body" role="article">
      {props.bodyHtml === "" ? (
        <div class="render-content markup">
          <span class="no-content">{issueDetailLocale.no_content}</span>
        </div>
      ) : (
        <div class="render-content markup" dangerouslySetInnerHTML={{ __html: props.bodyHtml }} />
      )}
    </div>
  );
}

/** The shared/reactions.tmpl bar reduced to no-JS forms (census gap #1
 *  part two): the grouped labels (each a toggle form when the viewer can
 *  react — POST `{actionUrl}/{unreact|react}` with the hidden `content`),
 *  a disabled label otherwise, and the picker reduced to a disclosure
 *  block of react forms (the tippy island replaced; the smiley octicon is
 *  outside the generated allowlist — the picker summary degrades to the
 *  emoji character). Upstream renders the bar when there are reactions OR
 *  the viewer can react (`{{if or .Reactions $canReact}}`); anonymous
 *  visitors see bare labels. */
export function ReactionBar(props: {
  actionUrl: string;
  groups: ReactionGroup[];
  viewer: Viewer;
  canReact: boolean;
}) {
  if (props.groups.length === 0 && !props.canReact) return null;
  const emojiOf = (type: string): string => REACTION_EMOJI[type] ?? `:${type}:`;
  const viewerId = props.viewer.kind === "user" ? props.viewer.id : null;
  return (
    <div class="bottom-reactions" data-action-url={props.actionUrl} role="group" aria-label={issueDetailLocale.reactions}>
      {props.canReact ? (
        <details class="select-reaction">
          <summary aria-label={issueDetailLocale.reactions} title={issueDetailLocale.reactions}>
            <span aria-hidden="true">🙂</span>
          </summary>
          <div class="reaction-picker">
            {[...ALLOWED_REACTIONS].map((value) => (
              <form class="item emoji" method="post" action={`${props.actionUrl}/react`}>
                <input type="hidden" name="content" value={value} />
                <button type="submit" aria-label={value} title={value}>
                  {emojiOf(value)}
                </button>
              </form>
            ))}
          </div>
        </details>
      ) : null}
      {props.groups.map((group) => {
        const reacted = viewerId !== null && group.userIds.includes(viewerId);
        const label = `${group.type}: ${group.count}`;
        return props.canReact ? (
          <form class="ui label basic" method="post" action={`${props.actionUrl}/${reacted ? "unreact" : "react"}`}>
            <input type="hidden" name="content" value={group.type} />
            <button type="submit" class="reaction" aria-label={label} title={label} data-has-reacted={reacted ? "true" : "false"} data-reaction-content={group.type}>
              <span class="reaction">{emojiOf(group.type)}</span> <span>{group.count}</span>
            </button>
          </form>
        ) : (
          <span class="ui label basic disabled" aria-label={label}>
            <span class="reaction">{emojiOf(group.type)}</span> <span>{group.count}</span>
          </span>
        );
      })}
    </div>
  );
}

/** The comment edit/delete arms (context_menu.tmpl reduced to no-JS
 *  forms — census gap #1 part two): the edit form carries the STRICT
 *  `content_version` CAS field (issue_comment.go:186-190's first arm) and
 *  a prefilled textarea; the delete posts `/comments/{id}/delete` (the
 *  upstream data-url, context_menu.tmpl:36). The confirm dialog reduces
 *  away — the no-JS submit IS the confirmation (the merged-cleanup-form
 *  precedent). The caller computes `canEdit` (poster-or-writer, the
 *  locked-issue writer arm, non-archived — the context menu's own gate). */
function CommentEditDeleteForms(props: { repoLink: string; comment: CommentRow }) {
  return (
    <div class="comment-edit-zone">
      <details class="comment-edit-details">
        <summary>{issueDetailLocale.edit_comment}</summary>
        <form class="ui form" method="post" action={`${props.repoLink}/comments/${props.comment.id}`}>
          <input type="hidden" name="content_version" value={String(props.comment.contentVersion)} />
          <div class="field">
            <textarea name="content" rows={5} aria-label={issueDetailLocale.edit_comment}>
              {props.comment.content ?? ""}
            </textarea>
          </div>
          <button type="submit" class="ui tiny primary button">
            {issueDetailLocale.save}
          </button>
        </form>
      </details>
      <form class="comment-delete-form" method="post" action={`${props.repoLink}/comments/${props.comment.id}/delete`}>
        <button type="submit" class="ui tiny button">{issueDetailLocale.delete_comment}</button>
      </form>
    </div>
  );
}

/** The root issue comment (`#issue-{id}`, view_content.tmpl's first
 *  `.timeline-item.comment.issue-content-comment`). Census gap #1 part
 *  two: the reaction bar mounts under the body (view_content.tmpl:58-61,
 *  ActionURL `{repoLink}/issues/{index}/reactions`). The root body's own
 *  edit is the /content tail — NOT this unit's surface, no edit form. */
function RootComment(props: { repoLink: string; data: IssueDetailData; viewer: Viewer; canReact: boolean }) {
  const { issue, posterName, bodyHtml } = props.data;
  const hash = `issue-${issue.id}`;
  return (
    <div id={hash} class="timeline-item comment issue-content-comment">
      <div class="content comment-container">
        <CommentHeader
          hash={hash}
          posterName={posterName}
          originalAuthor={issue.originalAuthor}
          createdAt={issue.createdAt}
        />
        <CommentBody bodyHtml={bodyHtml} />
        <ReactionBar
          actionUrl={`${props.repoLink}/issues/${issue.index}/reactions`}
          groups={props.data.issueReactions}
          viewer={props.viewer}
          canReact={props.canReact}
        />
      </div>
    </div>
  );
}

/** A timeline user comment (`comments.tmpl` type 0, `#issuecomment-{id}`).
 *  Census gap #1 part two: the reaction bar (comments.tmpl:73-77,
 *  ActionURL `{repoLink}/comments/{id}/reactions`) and the edit/delete
 *  forms ride the card for authorized viewers. */
function TimelineCommentCard(props: {
  repoLink: string;
  entry: Extract<TimelineEntry, { kind: "comment" }>;
  groups: ReactionGroup[];
  viewer: Viewer;
  canReact: boolean;
  canEdit: boolean;
}) {
  const { comment, posterName, bodyHtml } = props.entry;
  const hash = `issuecomment-${comment.id}`;
  return (
    <div id={hash} class="timeline-item comment">
      <div class="content comment-container">
        <CommentHeader hash={hash} posterName={posterName} createdAt={comment.createdAt} />
        <CommentBody bodyHtml={bodyHtml} />
        {props.canEdit ? <CommentEditDeleteForms repoLink={props.repoLink} comment={comment} /> : null}
        <ReactionBar
          actionUrl={`${props.repoLink}/comments/${comment.id}/reactions`}
          groups={props.groups}
          viewer={props.viewer}
          canReact={props.canReact}
        />
      </div>
    </div>
  );
}

/** A lifecycle event line (`comments.tmpl` types 1/2/28): the colored badge
 *  (close carries the 2-path octicon-issue-closed since the wave-4
 *  multi-path Icon) and the upstream verb. Upstream splits the DOM ids
 *  (comment.go:553-566 — HashTag vs EventTag): the ROW div carries
 *  `issuecomment-{id}` (HashTag, comments.tmpl:81/94/107 — `#issuecomment-N`
 *  deep links land here) while the inner time anchor carries `event-{id}`
 *  (EventTag, embedded by the locale strings' `<a id="%[1]s" href="#%[1]s">`
 *  — locale_en-US.json:1558-1559/1903-1904). Merge events (type 28,
 *  comments.tmpl:107-116) link the sha as `.ui.sha` over
 *  `{repoLink}/commit/{sha}` (ShortSha's 10-rune truncate, tool.go:31-34)
 *  and keep the time PLAIN (their locale sentence carries no anchor). */
function TimelineEvent(props: { data: IssueDetailData; entry: Extract<TimelineEntry, { kind: "reopen" | "close" | "merge" }>; repoLink: string }) {
  const { issue, pr } = props.data;
  const { kind, comment, posterName } = props.entry;
  const eventTag = `event-${comment.id}`;
  const verb =
    kind === "merge"
      ? null
      : kind === "reopen"
        ? issue.isPull
          ? issueDetailLocale.reopened_pull
          : issueDetailLocale.reopened_issue
        : issue.isPull
          ? issueDetailLocale.closed_pull
          : issueDetailLocale.closed_issue;
  const badge =
    kind === "reopen" ? (
      <Icon name="octicon-dot-fill" />
    ) : kind === "merge" ? (
      <Icon name="octicon-git-merge" />
    ) : (
      <Icon name="octicon-issue-closed" />
    );
  const badgeColor = kind === "reopen" ? "tw-bg-green" : kind === "merge" ? "tw-bg-purple" : "tw-bg-red";
  return (
    <div id={`issuecomment-${comment.id}`} class="timeline-item event">
      <span class={`badge ${badgeColor} tw-text-white`}>{badge}</span>
      <span class="comment-text-line">
        {posterName !== null ? (
          <a class="tw-font-semibold" href={userLink(posterName)}>
            {posterName}
          </a>
        ) : null}{" "}
        {kind === "merge" ? (
          <>
            {issueDetailLocale.merged_commit}{" "}
            {comment.commitSha !== null && comment.commitSha !== "" ? (
              <a class="ui sha" href={`${props.repoLink}/commit/${comment.commitSha}`}>
                <b>{comment.commitSha.slice(0, 10)}</b>
              </a>
            ) : (
              <b />
            )}{" "}
            {issueDetailLocale.merged_into} <b>{pr?.baseBranch ?? ""}</b>
          </>
        ) : (
          verb
        )}{" "}
        {comment.createdAt !== null ? (
          kind === "merge" ? (
            <TimeSince unixSeconds={unixSeconds(comment.createdAt)} tz="+0000" />
          ) : (
            <a id={eventTag} href={`#${eventTag}`}>
              <TimeSince unixSeconds={unixSeconds(comment.createdAt)} tz="+0000" />
            </a>
          )
        ) : null}
      </span>
    </div>
  );
}

/** The branch-selector field (templates/repo/issue/branch_selector_field.tmpl
 *  reduced — census gap #1 part two): the current ref display line for
 *  every reader (RefEndName / the No-Branch/Tag-Specified arm), and for a
 *  ref-capable viewer (`$canChangeRef := or .IsIssuePoster
 *  .HasIssuesOrPullsWritePermission`) a text-input form posting the
 *  upstream `ref` field to `{repoLink}/issues/{index}/ref` (the JS
 *  branch/tag picker island replaced — the picker's list browse is an
 *  engine read the detail page doesn't need). ISSUES ONLY — upstream's own
 *  gate wraps the whole template (`and (not .Issue.IsPull)`). */
function IssueRefBlock(props: { repoLink: string; data: IssueDetailData; access: IssueDetailAccess; viewer: Viewer }) {
  const { issue } = props.data;
  if (issue.isPull) return null;
  const canChangeRef =
    props.viewer.kind === "user" && (issue.posterId === props.viewer.id || props.access.canModifyIssueOrPull);
  return (
    <>
      <div class="divider" />
      <div class="branch-selector-dropdown">
        <div class="ui button branch-dropdown-button">
          <span class="text-branch-name gt-ellipsis">{issue.ref !== null && issue.ref !== "" ? issue.ref : issueDetailLocale.no_ref}</span>
        </div>
        {canChangeRef ? (
          <form class="ui form tw-mt-1" method="post" action={`${props.repoLink}/issues/${issue.index}/ref`}>
            <div class="field flex-text-block">
              <input name="ref" value={issue.ref ?? ""} placeholder="Filter branch or tag..." aria-label="Branch/Tag" />
              <button type="submit" class="ui tiny primary button">
                {issueDetailLocale.save}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </>
  );
}

/** The stopwatch timetracker block (templates/repo/issue/sidebar/
 *  stopwatch_timetracker.tmpl reduced — census gap #1 part two): the
 *  Start/Stop + Discard/Add-Time button pair through the no-JS forms
 *  (the link-action islands replaced), the already-tracking warning with
 *  the other issue's live link, the estimate line + the inline estimate
 *  form (the pencil modal reduced), and the WorkingUsers totals list —
 *  which renders for EVERY reader, outside the CanUseTimetracker gate
 *  (the template's own structure). */
function TimetrackerBlock(props: { repoLink: string; data: IssueDetailData; access: IssueDetailAccess; viewer: Viewer }) {
  const { issue, viewerStopwatch, otherStopwatchUrl, workingUsers } = props.data;
  const canonicalPath = `${props.repoLink}/${issue.isPull ? "pulls" : "issues"}/${issue.index}`;
  const running = viewerStopwatch !== null && viewerStopwatch.issueId === issue.id;
  const canUse = props.viewer.kind === "user" && props.access.canUseTimetracker;
  const totalSeconds = workingUsers.reduce((sum, entry) => sum + entry.seconds, 0);
  return (
    <>
      {canUse ? (
        <>
          <div class="divider" />
          <div>
            <div class="flex-text-block">
              <strong class="tw-flex-1">{issueDetailLocale.tracker}</strong>
            </div>
            <div class="ui buttons tw-mt-2 tw-w-full">
              {running ? (
                <>
                  <form class="tw-flex-1" method="post" action={`${canonicalPath}/times/stopwatch/stop`}>
                    <button type="submit" class="ui button tw-flex-1">
                      <Icon name="octicon-stopwatch" size={14} /> {issueDetailLocale.timer_stop}
                    </button>
                  </form>
                  <form method="post" action={`${canonicalPath}/times/stopwatch/cancel`}>
                    <button type="submit" class="ui icon button" aria-label={issueDetailLocale.timer_discard} title={issueDetailLocale.timer_discard}>
                      <Icon name="octicon-trash" size={14} />
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <form class="tw-flex-1" method="post" action={`${canonicalPath}/times/stopwatch/start`}>
                    <button type="submit" class="ui button tw-flex-1">
                      <Icon name="octicon-stopwatch" size={14} /> {issueDetailLocale.timer_start}
                    </button>
                  </form>
                  <details class="issue-add-time">
                    <summary class="ui icon button" aria-label={issueDetailLocale.timer_add} title={issueDetailLocale.add_time_manually}>
                      <Icon name="octicon-plus" size={14} />
                    </summary>
                    <form class="ui form" method="post" action={`${canonicalPath}/times/add`}>
                      <div class="field flex-text-block">
                        <input type="number" name="hours" min="0" max="1000" placeholder={issueDetailLocale.add_time_hours} aria-label={issueDetailLocale.add_time_hours} />
                        <span aria-hidden="true">:</span>
                        <input
                          type="number"
                          name="minutes"
                          min="0"
                          max="1000"
                          placeholder={issueDetailLocale.add_time_minutes}
                          aria-label={issueDetailLocale.add_time_minutes}
                        />
                      </div>
                      <button type="submit" class="ui tiny primary button">{issueDetailLocale.timer_add}</button>
                    </form>
                  </details>
                </>
              )}
            </div>
            {viewerStopwatch !== null && !running ? (
              <div class="ui warning message">
                {issueDetailLocale.tracking_already_started_prefix}
                {otherStopwatchUrl !== null ? <a href={otherStopwatchUrl}>another issue</a> : "another issue"}
                {issueDetailLocale.tracking_already_started_tail}
              </div>
            ) : null}
            {issue.timeEstimate > 0 ? (
              <div class="tw-my-2">
                {issueDetailLocale.time_estimate_display}
                {timeEstimateString(issue.timeEstimate)}
              </div>
            ) : null}
            <form class="ui form tw-mt-1" method="post" action={`${canonicalPath}/time_estimate`}>
              <div class="field flex-text-block">
                <input
                  name="time_estimate"
                  placeholder="1h 2m"
                  value={timeEstimateString(issue.timeEstimate)}
                  aria-label={issueDetailLocale.time_estimate_set}
                />
                <button type="submit" class="ui tiny primary button" aria-label={issueDetailLocale.time_estimate_set} title={issueDetailLocale.time_estimate_set}>
                  <Icon name="octicon-pencil" size={14} />
                </button>
              </div>
            </form>
          </div>
        </>
      ) : null}
      {workingUsers.length > 0 ? (
        <div class="tw-mt-2">
          {issueDetailLocale.total_time_spent}
          {secToHours(totalSeconds)}
          <div class="ui list flex-items-block">
            {workingUsers.map((entry) => (
              <div class="item">
                <a class="muted" href={userLink(entry.user.username)}>
                  {entry.user.username}
                </a>
                <div class="text">{secToHours(entry.seconds)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The dependencies block (templates/repo/issue/sidebar/
 *  issue_dependencies.tmpl reduced — census gap #1 part two): the empty
 *  arm carries the section title (upstream renders the title ONLY there),
 *  the Blocks/Depends-on lists with per-row remove forms (the confirm
 *  modal reduced to the direct submit), the NotPermitted count lines and
 *  the writer's redacted-but-removable rows (the lock octicon is outside
 *  the allowlist — the tooltip carries the can-remove note), and the add
 *  form's search dropdown reduced to a native select of the same-repo
 *  candidates posting `newDependency` (the issue ROW id — GetIssueByID's
 *  lookup). */
function DependenciesBlock(props: { repoLink: string; data: IssueDetailData; access: IssueDetailAccess }) {
  const { issue, dependencies, dependencyCandidates } = props.data;
  const canonicalPath = `${props.repoLink}/${issue.isPull ? "pulls" : "issues"}/${issue.index}`;
  const canCreate = props.access.canModifyIssueOrPull;
  const entryLink = (entry: DependencyEntry): string =>
    `/${entry.repo.ownerNamespace}/${entry.repo.slug}/${entry.issue.isPull ? "pulls" : "issues"}/${entry.issue.index}`;
  const removeForm = (entry: DependencyEntry, dependencyType: "blockedBy" | "blocking") => (
    <form class="issue-remove-dependency-form" method="post" action={`${canonicalPath}/dependency/delete`}>
      <input type="hidden" name="removeDependencyID" value={String(entry.issue.id)} />
      <input type="hidden" name="dependencyType" value={dependencyType} />
      <button type="submit" class="muted" aria-label={issueDetailLocale.dependency_remove} title={issueDetailLocale.dependency_remove}>
        <Icon name="octicon-trash" size={16} />
      </button>
    </form>
  );
  const entryRow = (entry: DependencyEntry, dependencyType: "blockedBy" | "blocking") => (
    <div class={`item ${entry.issue.isClosed ? "is-closed" : ""} flex-left-right`}>
      <div class="item-left">
        <a class="muted issue-dependency-title gt-ellipsis" href={entryLink(entry)}>
          #{entry.issue.index} {entry.issue.title}
        </a>
        <div class="tw-text-xs gt-ellipsis">
          {entry.repo.ownerNamespace}/{entry.repo.slug}
        </div>
      </div>
      <div class="item-right">{canCreate ? removeForm(entry, dependencyType) : null}</div>
    </div>
  );
  // The redacted-but-removable writer arm (issue_dependencies.tmpl's
  // BlockedByDependenciesNotPermitted range): no link, no emoji render,
  // the can-remove tooltip standing in for the ungenerated lock glyph.
  const hiddenRow = (entry: DependencyEntry) => (
    <div class={`item ${entry.issue.isClosed ? "is-closed" : ""} flex-left-right`}>
      <div class="item-left">
        <div class="gt-ellipsis">
          <span title={issueDetailLocale.dependency_hidden_can_remove}>#</span>
          <span class="gt-ellipsis issue-dependency-title">
            #{entry.issue.index} {entry.issue.title}
          </span>
        </div>
        <div class="tw-text-xs gt-ellipsis">
          {entry.repo.ownerNamespace}/{entry.repo.slug}
        </div>
      </div>
      <div class="item-right">{removeForm(entry, "blockedBy")}</div>
    </div>
  );
  const countLine = (n: number) =>
    n === 1 ? issueDetailLocale.dependency_hidden_1 : issueDetailLocale.dependency_hidden_n(n);
  const isEmpty =
    dependencies.blocking.length === 0 &&
    dependencies.blockedBy.length === 0 &&
    dependencies.blockingHidden === 0 &&
    dependencies.blockedByHidden === 0;
  return (
    <>
      <div class="divider" />
      <div class="ui depending">
        {isEmpty ? (
          <>
            <span class="text">
              <strong>{issueDetailLocale.dependencies}</strong>
            </span>
            <br />
            <p>{issueDetailLocale.no_dependencies}</p>
          </>
        ) : null}
        {dependencies.blocking.length > 0 ? (
          <>
            <span class="text">
              <strong>{issueDetailLocale.blocks_short}</strong>
            </span>
            <div class="flex-divided-list">
              {dependencies.blocking.map((entry) => entryRow(entry, "blocking"))}
            </div>
          </>
        ) : null}
        {dependencies.blockingHidden > 0 ? (
          <div class="item gt-ellipsis">
            <span>{countLine(dependencies.blockingHidden)}</span>
          </div>
        ) : null}
        {dependencies.blockedBy.length > 0 || (canCreate && dependencies.blockedByHidden > 0) ? (
          <>
            <span class="text">
              <strong>{issueDetailLocale.blocked_by_short}</strong>
            </span>
            <div class="flex-divided-list">
              {dependencies.blockedBy.filter((entry) => entry.permitted).map((entry) => entryRow(entry, "blockedBy"))}
              {canCreate
                ? dependencies.blockedBy
                    .filter((entry) => !entry.permitted)
                    .map((entry) => hiddenRow(entry))
                : null}
            </div>
          </>
        ) : null}
        {!canCreate && dependencies.blockedByHidden > 0 ? (
          <div class="item gt-ellipsis">
            <span>{countLine(dependencies.blockedByHidden)}</span>
          </div>
        ) : null}
        {canCreate ? (
          <div class="tw-mt-2">
            <form id="addDependencyForm" class="ui fluid action input" method="post" action={`${canonicalPath}/dependency/add`}>
              <select name="newDependency" aria-label={issueDetailLocale.add_dependency}>
                <option value="">{issueDetailLocale.add_dependency}</option>
                {(dependencyCandidates ?? []).map((candidate) => (
                  <option value={String(candidate.id)}>
                    #{candidate.index} {candidate.title}
                  </option>
                ))}
              </select>
              <button type="submit" class="ui icon button" aria-label={issueDetailLocale.add_dependency}>
                <Icon name="octicon-plus" size={16} />
              </button>
            </form>
          </div>
        ) : null}
      </div>
    </>
  );
}
/** The sidebar (`view_content/sidebar.tmpl`): the branch-selector field
 *  leads on issues (branch_selector_field — census gap #1 part two), PRs
 *  follow with the wave-11 Reviewers section (sidebar.tmpl:5-9 mounts
 *  reviewer_list first for is_pull rows), then the labels list (badges
 *  linking into the live list filters) and the milestone (upstream's
 *  `/milestone/{id}` link — w129 batch-14: the detail page landed at
 *  ca4eb58, so the name anchors it like milestone_list.tmpl:49). Wave 5:
 *  an admin viewer gets the no-JS label edit form above the badge list.
 *  Census gap #1: the sidebar combo writes + header buttons — the
 *  milestone select, the project select, the assignee select (the no-JS
 *  checkbox/select reductions of sidebar/{milestone_list,project_list,
 *  assignee_list}.tmpl's JS dropdowns, posting the upstream `issue_ids` +
 *  `id` field shapes to the routes pages/issue-sidebar-writes.ts serves),
 *  the Notifications subscribe toggle (sidebar/watch_notification.tmpl's
 *  button — the eye pair stands in for the ungenerated mute/unmute
 *  octicons) and the Due Date section (sidebar/due_date.tmpl — the remove
 *  affordance reduces to the empty submit: upstream's `required` input is
 *  dropped so a no-JS clear exists). Census gap #1 part two: the
 *  timetracker block (stopwatch_timetracker.tmpl — the stopwatch trio +
 *  manual add + estimate, pages/issue-timeline-writes.ts's routes), the
 *  dependencies block (issue_dependencies.tmpl — the add/remove pair) and
 *  the issue_management delete button ride the same module; the pin/lock
 *  forms stay the part-one surface. Everyone sees the display lists;
 *  Participants (participant_list), the reference link and the
 *  wip/allow-maintainer-edit switches stay unrendered (the later parts'
 *  surface — the §2.4.1 rule keeps them off rather than approximated). */
function IssueSidebar(props: {
  repoLink: string;
  data: IssueDetailData;
  /** The resolved repo row (the Reviewers section's archived gate). */
  repo: RepoRow;
  /** The projects unit toggle (ctx.repoHasProjects — the
   *  `{{if .IsProjectsEnabled}}` gate around project_list). */
  hasProjects: boolean;
  /** Repo labels for the edit form; `null` = display-only (non-admin). */
  labelOptions: LabelRow[] | null;
  /** Wave-11 grants (the Reviewers section's control + dismiss forms). */
  viewer: Viewer;
  canChangeReviewRequests: boolean;
  canDismissReviews: boolean;
  /** The re-rendered request-review failure (null = pristine GET). */
  reviewersError: string | null;
  /** Census gap #1: the sidebar-write grants + option lists. */
  access: IssueDetailAccess;
}) {
  const { labels, milestone, issue, pr } = props.data;
  const { access } = props;
  const listBase = `${props.repoLink}/${issue.isPull ? "pulls" : "issues"}`;
  const canonicalPath = `${props.repoLink}/${issue.isPull ? "pulls" : "issues"}/${issue.index}`;
  const selectedIds = new Set(labels.map((label) => label.id));
  const nowMs = Date.now();
  return (
    <div class="issue-content-right ui segment">
      {/* branch_selector_field leads the sidebar on issues (sidebar.tmpl's
          mount order — before the is_pull reviewer_list). */}
      <IssueRefBlock repoLink={props.repoLink} data={props.data} access={access} viewer={props.viewer} />
      {issue.isPull ? (
        <>
          <ReviewersSidebar
            repoLink={props.repoLink}
            issue={issue}
            pr={pr}
            repo={props.repo}
            viewer={props.viewer}
            entries={props.data.reviews}
            canDoerChange={props.canChangeReviewRequests}
            canDismiss={props.canDismissReviews}
            error={props.reviewersError}
          />
          <div class="divider" />
        </>
      ) : null}
      <div class="issue-sidebar-combo" data-selection-mode="multiple" data-update-algo="diff">
        <div class="fixed-text muted">
          <strong>{issueDetailLocale.labels}</strong>
        </div>
        {props.labelOptions !== null ? (
          <form class="ui form" action={`${props.repoLink}/issues/labels`} method="post">
            <input type="hidden" name="issue_ids" value={String(issue.id)} />
            {props.labelOptions.length === 0 ? (
              <span class="item empty-list">{issueDetailLocale.no_labels}</span>
            ) : (
              <div class="ui list labels-list">
                {props.labelOptions.map((label) => {
                  const id = `issue-label-${label.id}`;
                  return (
                    <div class="item">
                      <div class="ui checkbox">
                        <input id={id} name="label_ids" type="checkbox" value={String(label.id)} checked={selectedIds.has(label.id)} />
                        <label for={id}>
                          <LabelBadge label={label} />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div class="field">
              <button type="submit" class="ui tiny primary button">
                {issueDetailLocale.save}
              </button>
            </div>
          </form>
        ) : null}
        <div class="ui list labels-list">
          {labels.length === 0 ? (
            <span class="item empty-list">{issueDetailLocale.no_labels}</span>
          ) : (
            labels.map((label) => (
              <a class="item" href={`${listBase}?labels=${label.id}`}>
                <LabelBadge label={label} />
              </a>
            ))
          )}
        </div>
      </div>
      <div class="divider" />
      <div class="issue-sidebar-combo" data-selection-mode="single" data-update-algo="all">
        <div class="fixed-text muted">
          <strong>{issueDetailLocale.milestone}</strong>
        </div>
        {/* milestone_list.tmpl's JS dropdown reduced to the native select —
            the same single-`id` field the upstream combolist posts (the
            clear selection is the empty value). */}
        {access.milestoneOptions !== null ? (
          <form class="ui form" action={`${props.repoLink}/issues/milestone`} method="post">
            <input type="hidden" name="issue_ids" value={String(issue.id)} />
            <div class="field flex-text-block">
              <select name="id" class="ui selection dropdown" aria-label={issueDetailLocale.milestone}>
                <option value="">{issueDetailLocale.no_milestone}</option>
                {access.milestoneOptions.open.length > 0 ? (
                  <optgroup label={issueDetailLocale.open_milestones}>
                    {access.milestoneOptions.open.map((option) => (
                      <option value={String(option.id)} selected={issue.milestoneId === option.id}>
                        {option.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {access.milestoneOptions.closed.length > 0 ? (
                  <optgroup label={issueDetailLocale.closed_milestones}>
                    {access.milestoneOptions.closed.map((option) => (
                      <option value={String(option.id)} selected={issue.milestoneId === option.id}>
                        {option.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              <button type="submit" class="ui tiny primary button">
                {issueDetailLocale.save}
              </button>
            </div>
          </form>
        ) : null}
        <div class="ui list muted-links flex-items-block">
          {milestone === null ? (
            <span class="item empty-list">{issueDetailLocale.no_milestone}</span>
          ) : (
            // milestone_list.tmpl:49 — the name anchors the milestone page
            // (w129 batch-14: the page landed at ca4eb58, un-deadening the
            // previously plain-text span).
            <a class="item" href={`${props.repoLink}/milestone/${milestone.id}`}>
              <Icon name="octicon-milestone" size={18} class="tw-shrink-0" />
              <span class="tw-flex-1 tw-break-anywhere">{milestone.name}</span>
            </a>
          )}
        </div>
      </div>
      {props.hasProjects ? (
        <>
          <div class="divider" />
          {/* project_list.tmpl — the repo/owner project picker reduced to
              the checkbox group (upstream's multi-select "all" algo posts
              the comma-joined `id` set; the checkboxes post the same ids as
              separate values, both parse). The display list anchors the
              live board pages (repo-scope `/{owner}/{repo}/projects/{id}`,
              owner-scope `/{owner}/-/projects/{id}`). */}
          <div class="issue-sidebar-combo sidebar-project-combo" data-selection-mode="multiple" data-update-algo="all">
            <div class="fixed-text muted">
              <strong>{issueDetailLocale.projects}</strong>
            </div>
            {access.projectOptions !== null ? (
              <form class="ui form" action={`${props.repoLink}/issues/projects`} method="post">
                <input type="hidden" name="issue_ids" value={String(issue.id)} />
                {access.projectOptions.open.length === 0 && access.projectOptions.closed.length === 0 ? (
                  <span class="item empty-list">{issueDetailLocale.no_projects}</span>
                ) : (
                  <div class="ui list labels-list">
                    {access.projectOptions.open.length > 0 ? (
                      <div class="header">{issueDetailLocale.open_projects}</div>
                    ) : null}
                    {access.projectOptions.open.map((project) => (
                      <ProjectCheckbox key={project.id} project={project} checked={props.data.projects.some((p) => p.id === project.id)} />
                    ))}
                    {access.projectOptions.closed.length > 0 ? (
                      <div class="header">{issueDetailLocale.closed_projects}</div>
                    ) : null}
                    {access.projectOptions.closed.map((project) => (
                      <ProjectCheckbox key={project.id} project={project} checked={props.data.projects.some((p) => p.id === project.id)} />
                    ))}
                  </div>
                )}
                <div class="field">
                  <button type="submit" class="ui tiny primary button">
                    {issueDetailLocale.save}
                  </button>
                </div>
              </form>
            ) : null}
            <div class="ui list muted-links flex-items-block">
              {props.data.projects.length === 0 ? (
                <span class="item empty-list">{issueDetailLocale.no_projects}</span>
              ) : (
                props.data.projects.map((project) => (
                  <a class="item" href={projectBoardLink(props.repo, project)}>
                    <Icon name="octicon-project" size={16} class="tw-shrink-0" />
                    <span class="tw-flex-1 gt-ellipsis">{project.title}</span>
                  </a>
                ))
              )}
            </div>
          </div>
        </>
      ) : null}
      <div class="divider" />
      {/* assignee_list.tmpl — the candidate picker reduced to the checkbox
          group (upstream's multi-select "diff" algo posts per-item
          attach/detach toggles; the checkbox set diffs server-side — the
          labels-form reduction). The display list is upstream's (avatars
          stay unrendered — no avatar route). */}
      <div class="issue-sidebar-combo" data-selection-mode="multiple" data-update-algo="diff">
        <div class="fixed-text muted">
          <strong>{issueDetailLocale.assignees}</strong>
        </div>
        {access.assigneeOptions !== null ? (
          <form class="ui form" action={`${props.repoLink}/issues/assignee`} method="post">
            <input type="hidden" name="issue_ids" value={String(issue.id)} />
            {access.assigneeOptions.length === 0 ? (
              <span class="item empty-list">{issueDetailLocale.no_assignees}</span>
            ) : (
              <div class="ui list labels-list">
                {access.assigneeOptions.map((user) => {
                  const id = `issue-assignee-${user.id}`;
                  return (
                    <div class="item">
                      <div class="ui checkbox">
                        <input
                          id={id}
                          name="id"
                          type="checkbox"
                          value={String(user.id)}
                          checked={props.data.assignees.some((assignee) => assignee.id === user.id)}
                        />
                        <label for={id}>{user.username}</label>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div class="field">
              <button type="submit" class="ui tiny primary button">
                {issueDetailLocale.save}
              </button>
            </div>
          </form>
        ) : null}
        <div class="ui relaxed list muted-links flex-items-block">
          {props.data.assignees.length === 0 ? (
            <span class="item empty-list">{issueDetailLocale.no_assignees}</span>
          ) : (
            props.data.assignees.map((assignee) => (
              <span class="item flex-text-inline">
                <a class="muted flex-text-inline" href={userLink(assignee.username)}>
                  {assignee.username}
                </a>
              </span>
            ))
          )}
        </div>
      </div>
      {/* watch_notification.tmpl — the subscribe toggle, signed-in viewers
          on a live repo (upstream renders the block for every viewer but
          the write would nil-deref anonymous there; the session gate is the
          landed posture). The eye pair stands in for the ungenerated
          octicon-mute/unmute (the icon-allowlist degrade rule). */}
      {props.viewer.kind === "user" && !props.repo.isArchived ? (
        <>
          <div class="divider" />
          <div class="ui watching">
            <span class="text">
              <strong>{issueDetailLocale.notifications}</strong>
            </span>
            <div class="tw-mt-2">
              <form method="post" action={`${canonicalPath}/watch?watch=${access.watching ? "false" : "true"}`}>
                <button class="fluid ui button" type="submit">
                  <Icon name={access.watching ? "octicon-eye-closed" : "octicon-eye"} size={16} />{" "}
                  {access.watching ? issueDetailLocale.unsubscribe : issueDetailLocale.subscribe}
                </button>
              </form>
            </div>
          </div>
        </>
      ) : null}
      {/* due_date.tmpl — the display for everyone, the edit form for
          writers. The remove affordance reduces to the EMPTY submit (the
          upstream `required` attribute is dropped so a no-JS clear exists —
          the parser treats empty/unparseable as the remove arm, exactly
          upstream's ignored-parse-error posture). */}
      <div class="divider" />
      <span class="text">
        <strong>{issueDetailLocale.due_date}</strong>
      </span>
      <div class="ui form tw-mt-2">
        {issue.deadlineAt !== null ? (
          <div class="flex-left-right">
            <div
              class={`due-date ${issue.deadlineAt.getTime() < nowMs ? "tw-text-red" : ""}`}
              title={issue.deadlineAt.getTime() < nowMs ? issueDetailLocale.due_date_overdue : undefined}
            >
              <Icon name="octicon-calendar" size={16} /> {formatDueDate(issue.deadlineAt)}
            </div>
          </div>
        ) : (
          <div>{issueDetailLocale.due_date_not_set}</div>
        )}
        {access.canModifyIssueOrPull ? (
          <form class="ui fluid action input issue-due-form tw-mt-2" method="post" action={`${canonicalPath}/deadline`}>
            <input type="date" name="deadline" placeholder={issueDetailLocale.due_date_form} value={isoDueDate(issue.deadlineAt)} aria-label={issueDetailLocale.due_date} />
            <button
              type="submit"
              class="ui icon button"
              aria-label={issue.deadlineAt !== null ? issueDetailLocale.due_date_edit : issueDetailLocale.due_date_form}
            >
              <Icon name={issue.deadlineAt !== null ? "octicon-pencil" : "octicon-plus"} size={14} />
            </button>
          </form>
        ) : null}
      </div>
      {/* stopwatch_timetracker.tmpl — the stopwatch trio + the manual add
          + the estimate (census gap #1 part two; the WorkingUsers list is
          the block's reader-visible half, upstream's own structure). */}
      <TimetrackerBlock repoLink={props.repoLink} data={props.data} access={access} viewer={props.viewer} />
      {/* issue_dependencies.tmpl — the dependency add/remove pair (census
          gap #1 part two; the remove modal reduces to the per-row direct
          submit). */}
      <DependenciesBlock repoLink={props.repoLink} data={props.data} access={access} />
      {/* issue_management.tmpl — the pin toggle + the lock/unlock form +
          the delete button for repo admins on a live repo (census gap #1
          part two lands the delete arm — the confirm dialog reduces to the
          direct submit, the no-JS-submit-IS-the-confirmation posture). The
          lock modal reduces to the inline reason form; the key/lock
          octicons stand in as the single shield-lock glyph (the allowlist
          degrade). */}
      {access.canManageIssue && access.pin !== null ? (
        <>
          <div class="divider" />
          <form class="tw-mt-1 single-button-form" method="post" action={`${canonicalPath}/pin`}>
            <button type="submit" class="fluid ui button" disabled={!access.pin.canAddPin && !access.pin.pinned}>
              <Icon name="octicon-pin" size={16} /> {access.pin.pinned ? issueDetailLocale.unpin : issueDetailLocale.pin}
            </button>
          </form>
          <form class="ui form tw-mt-1" method="post" action={`${canonicalPath}/${issue.isLocked ? "unlock" : "lock"}`}>
            {!issue.isLocked ? (
              <div class="field">
                <label for="issue-lock-reason">{issueDetailLocale.lock_reason}</label>
                <select id="issue-lock-reason" name="reason" class="ui selection dropdown">
                  <option value="" />
                  {ISSUE_LOCK_REASONS.map((reason) => (
                    <option value={reason}>{reason}</option>
                  ))}
                </select>
              </div>
            ) : null}
            <button type="submit" class={`ui ${issue.isLocked ? "" : "red"} button`}>
              {issue.isLocked ? issueDetailLocale.unlock_confirm : issueDetailLocale.lock_confirm}
            </button>
          </form>
          <form class="tw-mt-1 single-button-form" method="post" action={`${canonicalPath}/delete`}>
            <button type="submit" class="fluid ui button">
              <Icon name="octicon-trash" size={16} /> {issueDetailLocale.delete_issue}
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
}

/** One project checkbox of the picker form (the label-form's checkbox
 *  anatomy — id + wrapping label so the click target is the row). */
function ProjectCheckbox(props: { project: ProjectRow; checked: boolean }) {
  const id = `issue-project-${props.project.id}`;
  return (
    <div class="item">
      <div class="ui checkbox">
        <input id={id} name="id" type="checkbox" value={String(props.project.id)} checked={props.checked} />
        <label for={id}>{props.project.title}</label>
      </div>
    </div>
  );
}

/** The live board page for a project row: repo-scope
 *  `/{owner}/{repo}/projects/{id}` (pages/repo-projects.tsx), owner-scope
 *  `/{owner}/-/projects/{id}` (pages/owner-project-board.tsx). */
function projectBoardLink(repo: RepoRow, project: ProjectRow): string {
  if (project.repoId !== "") return `/${repo.ownerNamespace}/${repo.slug}/projects/${project.id}`;
  return `/${repo.ownerNamespace}/-/projects/${project.id}`;
}

/** yyyy-mm-dd for the date input's pre-filled value (UTC — the parser's
 *  zone rule). */
function isoDueDate(deadline: Date | null): string | undefined {
  if (deadline === null) return undefined;
  const year = String(deadline.getUTCFullYear()).padStart(4, "0");
  const month = String(deadline.getUTCMonth() + 1).padStart(2, "0");
  const day = String(deadline.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The signed-in comment form (`view_content.tmpl:71-136` reduced: no
 *  avatar slot — no avatar route; the combo editor + attachments reduce to
 *  a plain textarea). The `#status-button` close/reopen toggle rides the
 *  same form (`name="status"`) exactly like upstream; it renders for the
 *  state-capable viewers only and never on a merged PR. Anonymous viewers
 *  get the upstream sign-in warning (a live /login round-trip link);
 *  archived repos the `repo.archive.*.nocomment` message. */
function CommentFormBlock(props: {
  ctx: UiContext;
  repoLink: string;
  data: IssueDetailData;
  access: IssueDetailAccess;
  /** The re-rendered submission ("", no error, on the plain GET). */
  form: { content: string; error: string | null };
}) {
  const { ctx, data, access } = props;
  const { issue, pr } = data;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("CommentFormBlock requires ctx.repo");
  const family = issue.isPull ? "pulls" : "issues";
  const action = `${props.repoLink}/${family}/${issue.index}/comments`;

  // view_content.tmpl:114-133: the ARCHIVE message serves BOTH viewer kinds
  // (the sign-in warning is the non-archived arm) — archive checks first.
  if (repo.isArchived) {
    return <div class="ui warning message tw-text-center">{issue.isPull ? issueDetailLocale.archive_pull_nocomment : issueDetailLocale.archive_issue_nocomment}</div>;
  }
  if (ctx.viewer.kind === "anonymous") {
    return (
      <div class="ui warning message">
        <a href={`/login?redirect_to=${encodeURIComponent(`${props.repoLink}/${family}/${issue.index}`)}`}>Sign in</a>
        {issueDetailLocale.sign_in_require}
      </div>
    );
  }
  if (issue.isLocked && !access.canChangeState) {
    // view_content.tmpl's else-if chain renders NOTHING for locked
    // non-writers on the plain GET (parity); the locked POST refusal
    // surfaces here as the re-rendered message (issue.go:80-92's flash —
    // the issueCommentSubmit 200+message convention).
    if (props.form.error === null) return null;
    return <div class="ui warning message">{props.form.error}</div>;
  }

  // The status button branch order and icon/color pairs are view_content.tmpl:88-107
  // verbatim; the issue reopen glyph degrades to the allowlisted
  // octicon-issue-opened (upstream octicon-issue-reopened is not generated).
  const closeState = !issue.isClosed;
  const statusValue = closeState ? "close" : "reopen";
  const statusText = closeState
    ? issue.isPull
      ? issueDetailLocale.close_pull
      : issueDetailLocale.close_issue
    : issue.isPull
      ? issueDetailLocale.reopen_pull
      : issueDetailLocale.reopen_issue;
  const statusIcon = closeState
    ? issue.isPull
      ? "octicon-git-pull-request-closed"
      : "octicon-issue-closed"
    : issue.isPull
      ? "octicon-git-pull-request"
      : "octicon-issue-opened";
  const statusIconColor = closeState ? "tw-text-red" : "tw-text-green";

  return (
    <div class="timeline-item comment form">
      <div class="content">
        <div class="ui segment avatar-content-left-arrow">
          <form class="ui form" id="comment-form" action={action} method="post">
            {props.form.error !== null ? <div class="ui negative message">{props.form.error}</div> : null}
            <div class="field">
              <textarea name="content" rows={10} placeholder={issueDetailLocale.comment_placeholder}>
                {props.form.content}
              </textarea>
            </div>
            <div class="field footer">
              <div class="flex-text-block tw-justify-end">
                {access.canChangeState && !(pr !== null && pr.hasMerged) ? (
                  <button type="submit" id="status-button" class="ui button" name="status" value={statusValue}>
                    <span class={`status-button-icon ${statusIconColor}`}>
                      <Icon name={statusIcon} />
                    </span>
                    <span class="status-button-text">{statusText}</span>
                  </button>
                ) : null}
                <button type="submit" id="comment-button" class="ui primary button">
                  {issueDetailLocale.create_comment}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component).
 *  `access`/`form` come from the router (the GET handler resolves the
 *  viewer's grants; the POST handlers re-render with the error + kept
 *  submission); omitted = the anonymous pristine GET shape. Wave-11 adds
 *  the review form's state and the Reviewers section's error channel. */
export function renderIssueDetailPage(
  ctx: UiContext,
  data: IssueDetailData,
  access?: IssueDetailAccess,
  form?: { content: string; error: string | null },
  reviewForm?: { content: string; error: string | null },
  reviewersError?: string | null,
): string {
  return renderPage(
    <IssueDetailPage
      ctx={ctx}
      data={data}
      access={
        access ?? {
          canChangeState: false,
          labelOptions: null,
          canChangeReviewRequests: false,
          canDismissReviews: false,
          canModifyIssueOrPull: false,
          canManageIssue: false,
          pin: null,
          watching: null,
          milestoneOptions: null,
          projectOptions: null,
          assigneeOptions: null,
          canUseTimetracker: false,
          dependencyCandidates: null,
        }
      }
      form={form ?? { content: "", error: null }}
      reviewForm={reviewForm ?? { content: "", error: null }}
      reviewersError={reviewersError ?? null}
    />,
  );
}

/** The issue/PR detail page (§2.4.1 discriminator: `repository view issue
 *  pull` — upstream view.tmpl:4 emits both classes unconditionally). */
export function IssueDetailPage(props: {
  ctx: UiContext;
  data: IssueDetailData;
  access: IssueDetailAccess;
  form: { content: string; error: string | null };
  /** Wave-11: the verdict form's kept draft + failure message. */
  reviewForm: { content: string; error: string | null };
  /** Wave-11: the Reviewers section's request-arm failure message. */
  reviewersError: string | null;
}) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("IssueDetailPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  // The comment block renders for EVERY viewer kind — its own arms carry
  // the archived/locked/anonymous refusals (view_content.tmpl's ladder);
  // gating the whole block here made those arms unreachable dead UI (the
  // issue-detail matrix's RED).
  const showForm = true;
  // Wave-11: the review verdict form — signed-in, non-archived PRs only
  // (the header's auth posture; upstream's diff-page combobox reduced).
  const showReviewForm =
    data.issue.isPull && data.pr !== null && ctx.viewer.kind === "user" && !repo.isArchived;
  // Census gap #1 part two: the reaction bars' grant (shared/reactions.tmpl
  // `$canReact := and $allowedReactions ctx.RootData.IsSigned (not
  // .Repository.IsArchived)`) and the comment edit/delete arms' grant
  // (context_menu.tmpl's $canEditContent reduced: poster-or-writer, the
  // locked-issue writer arm, the non-archived menu gate).
  const canReact = ctx.viewer.kind === "user" && !repo.isArchived;
  const canEditComments = (commentPosterId: number | null): boolean =>
    ctx.viewer.kind === "user" &&
    !repo.isArchived &&
    (commentPosterId === ctx.viewer.id || props.access.canModifyIssueOrPull) &&
    (!data.issue.isLocked || props.access.canModifyIssueOrPull);
  return (
    <BaseLayout
      ctx={ctx}
      title={`#${data.issue.index} - ${data.issue.title}`}
      pageClass="repository view issue pull"
      activeTab={data.urlKind === "pulls" ? "pulls" : "issues"}
    >
      <div class="ui container">
        <IssueTitleBar data={data} />
        {data.issue.isPull ? (
          <PullTabs repoLink={repoLink} issue={data.issue} active="conversation" commitsCount={null} filesCount={null} />
        ) : null}
        <div class="issue-content">
          <div class="issue-content-left">
            <div class="comment-list">
              <RootComment repoLink={repoLink} data={data} viewer={ctx.viewer} canReact={canReact} />
              {data.timeline.map((entry) =>
                entry.kind === "comment" ? (
                  <TimelineCommentCard
                    repoLink={repoLink}
                    entry={entry}
                    groups={data.commentReactions.get(entry.comment.id) ?? []}
                    viewer={ctx.viewer}
                    canReact={canReact}
                    canEdit={canEditComments(entry.comment.posterId)}
                  />
                ) : (
                  <TimelineEvent data={data} entry={entry} repoLink={repoLink} />
                ),
              )}
              <div class="timeline-item tw-hidden" id="timeline-comments-end" />
              {data.mergeBox !== null ? <PullMergeBoxFragment data={data.mergeBox} /> : null}
              {showForm ? (
                <CommentFormBlock ctx={ctx} repoLink={repoLink} data={data} access={props.access} form={props.form} />
              ) : null}
              {showReviewForm ? (
                <ReviewFormBlock
                  repoLink={repoLink}
                  issue={data.issue}
                  isPoster={ctx.viewer.kind === "user" && data.issue.posterId === ctx.viewer.id}
                  form={props.reviewForm}
                />
              ) : null}
            </div>
          </div>
          <IssueSidebar
            repoLink={repoLink}
            data={data}
            repo={repo}
            hasProjects={ctx.repoHasProjects === true}
            labelOptions={props.access.labelOptions}
            viewer={ctx.viewer}
            canChangeReviewRequests={props.access.canChangeReviewRequests}
            canDismissReviews={props.access.canDismissReviews}
            reviewersError={props.reviewersError}
            access={props.access}
          />
        </div>
      </div>
    </BaseLayout>
  );
}

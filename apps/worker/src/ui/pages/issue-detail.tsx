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
 *   {id}` — wave-2 QueryBuild parity). The sidebar's edit dropdowns (label/
 *   milestone pickers) are write actions — not rendered (§2.5); the section
 *   headings stay.
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

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { renderMarkdownToHtml } from "../../api/services/markdown";
import { listRepoLabels } from "../../api/services/labels";
import {
  findIssueByRepoAndIndex,
  hasWorkInProgressPrefix,
  issueLabelRows,
  listIssueTimeline,
} from "../../api/services/issues";
import { collaboratorModeOf } from "../../api/services/repo-collaborators";
import { findPullRequestByIndex } from "../../api/services/pulls";
import { milestones, users } from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import { IssuesService } from "../../issues/service";
import { IssueAlreadyChangedError, IssueError } from "../../issues/errors";
import type { CommentRow, IssueRow, LabelRow, MilestoneRow, PullRequestRow } from "../../issues/service";
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
} as const;

/** Timeline cap (upstream renders the full timeline unpaginated; the cap
 *  bounds the render for pathological threads without changing the order). */
export const TIMELINE_LIMIT = 500;

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
  /** Display-cased poster username; `null` = no user row (mirrored imports). */
  posterName: string | null;
  mergerName: string | null;
  /** The description through the §3.4 pipeline; `""` = no-content variant. */
  bodyHtml: string;
  timeline: TimelineEntry[];
  /** Wave-11: the visible review rows (PRs only — the sidebar Reviewers
   *  section; the pending-privacy filter applied per the viewer). */
  reviews: PullReviewEntry[];
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

/**
 * Load one issue/PR with its render inputs. Returns `null` when the index
 * misses (the caller 404-shells) — the row is otherwise rendered as-is,
 * whatever its family; the caller owns the upstream type/URL redirect.
 * Wave-11: the viewer drives the review-row privacy filter (PENDING rows
 * are visible to their reviewer and site admins only — the landed list
 * arm's filter), so a PR's `reviews` load rides the same call.
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

  const [labels, timelineRows, milestoneRow] = await Promise.all([
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

  return {
    urlKind,
    issue,
    pr,
    mergeBox,
    reviews,
    labels,
    milestone: milestoneRow,
    posterName: nameOf(issue.posterId),
    mergerName: pr !== null && pr.hasMerged ? nameOf(pr.mergerId ?? null) : null,
    bodyHtml: renderIssueMarkdown({ text: issue.content ?? "", repo, origin }),
    timeline,
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
}

/** Resolve both grants in one place (the settings gate's order: anonymous
 *  viewers never qualify). The admin arm rides the landed `isRepositoryAdmin`
 *  through `canAdminRepo` (../repo-grants.ts's bridge) — it needs the full
 *  `Env` the service predicates read; the issue-unit arms keep their D1-only
 *  collaborator/poster reads. */
export async function resolveIssueDetailAccess(
  env: Env,
  repo: RepoRow,
  viewer: Viewer,
  issue: IssueRow,
): Promise<IssueDetailAccess> {
  if (viewer.kind === "anonymous") {
    return { canChangeState: false, labelOptions: null, canChangeReviewRequests: false, canDismissReviews: false };
  }
  const d1 = env.DB;
  const isOwner = repo.ownerNamespace.toLowerCase() === viewer.username.toLowerCase();
  const collabMode: "none" | "read" | "write" | "admin" = isOwner
    ? "admin" // the owner outranks any collaborator row (canAdminRepo's owner line)
    : await collaboratorModeOf(d1, repo.id, viewer.id);
  const canChangeState =
    viewer.isAdmin || isOwner || issue.posterId === viewer.id || collabMode === "write" || collabMode === "admin";
  const admin = await canAdminRepo(env, repo, viewer);
  const labelOptions = admin ? (await listRepoLabels(d1, repo.id, "", 1, ISSUE_DETAIL_PICKER_LIMIT)).items : null;
  // Wave-11: the request predicate (pull-reviews.ts:388-396) — poster /
  // site admin / repo owner / collaborator, never on an archived repo.
  const canChangeReviewRequests =
    !repo.isArchived &&
    (viewer.isAdmin || isOwner || issue.posterId === viewer.id || collabMode !== "none");
  return { canChangeState, labelOptions, canChangeReviewRequests, canDismissReviews: admin };
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

/** The root issue comment (`#issue-{id}`, view_content.tmpl's first
 *  `.timeline-item.comment.issue-content-comment`). */
function RootComment(props: { data: IssueDetailData }) {
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
      </div>
    </div>
  );
}

/** A timeline user comment (`comments.tmpl` type 0, `#issuecomment-{id}`). */
function TimelineCommentCard(props: { entry: Extract<TimelineEntry, { kind: "comment" }> }) {
  const { comment, posterName, bodyHtml } = props.entry;
  const hash = `issuecomment-${comment.id}`;
  return (
    <div id={hash} class="timeline-item comment">
      <div class="content comment-container">
        <CommentHeader hash={hash} posterName={posterName} createdAt={comment.createdAt} />
        <CommentBody bodyHtml={bodyHtml} />
      </div>
    </div>
  );
}

/** A lifecycle event line (`comments.tmpl` types 1/2/28): the colored badge
 *  (close carries the 2-path octicon-issue-closed since the wave-4
 *  multi-path Icon) and the upstream verb with the `#event-{id}` time
 *  anchor. */
function TimelineEvent(props: { data: IssueDetailData; entry: Extract<TimelineEntry, { kind: "reopen" | "close" | "merge" }> }) {
  const { issue, pr } = props.data;
  const { kind, comment, posterName } = props.entry;
  const hash = `event-${comment.id}`;
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
    <div id={hash} class="timeline-item event">
      <span class={`badge ${badgeColor} tw-text-white`}>{badge}</span>
      <span class="comment-text-line">
        {posterName !== null ? (
          <a class="tw-font-semibold" href={userLink(posterName)}>
            {posterName}
          </a>
        ) : null}{" "}
        {kind === "merge" ? (
          <>
            {issueDetailLocale.merged_commit} <b>{comment.commitSha === null || comment.commitSha === "" ? "" : comment.commitSha.slice(0, 10)}</b>{" "}
            {issueDetailLocale.merged_into} <b>{pr?.baseBranch ?? ""}</b>
          </>
        ) : (
          verb
        )}{" "}
        {comment.createdAt !== null ? (
          <a id={hash} href={`#${hash}`}>
            <TimeSince unixSeconds={unixSeconds(comment.createdAt)} tz="+0000" />
          </a>
        ) : null}
      </span>
    </div>
  );
}

/** The reduced sidebar (`view_content/sidebar.tmpl`): PRs lead with the
 *  wave-11 Reviewers section (sidebar.tmpl:5-9 mounts reviewer_list first
 *  for is_pull rows), then the labels list (badges linking into the live
 *  list filters) and the milestone (upstream's `/milestone/{id}` link —
 *  w129 batch-14: the detail page landed at ca4eb58, so the name anchors it
 *  like milestone_list.tmpl:49; plain text before that). Wave 5: an admin
 *  viewer gets the no-JS label edit form above the badge list (the
 *  two-control reduction of sidebar/label_list.tmpl's JS dropdown — the
 *  upstream `issue_ids`/`label_ids` field names); everyone sees the badges
 *  re-rendered with ContrastColor as before. */
function IssueSidebar(props: {
  repoLink: string;
  data: IssueDetailData;
  /** The resolved repo row (the Reviewers section's archived gate). */
  repo: RepoRow;
  /** Repo labels for the edit form; `null` = display-only (non-admin). */
  labelOptions: LabelRow[] | null;
  /** Wave-11 grants (the Reviewers section's control + dismiss forms). */
  viewer: Viewer;
  canChangeReviewRequests: boolean;
  canDismissReviews: boolean;
  /** The re-rendered request-review failure (null = pristine GET). */
  reviewersError: string | null;
}) {
  const { labels, milestone, issue, pr } = props.data;
  const listBase = `${props.repoLink}/${issue.isPull ? "pulls" : "issues"}`;
  const selectedIds = new Set(labels.map((label) => label.id));
  return (
    <div class="issue-content-right ui segment">
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
    </div>
  );
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
      access={access ?? { canChangeState: false, labelOptions: null, canChangeReviewRequests: false, canDismissReviews: false }}
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
              <RootComment data={data} />
              {data.timeline.map((entry) =>
                entry.kind === "comment" ? (
                  <TimelineCommentCard entry={entry} />
                ) : (
                  <TimelineEvent data={data} entry={entry} />
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
            labelOptions={props.access.labelOptions}
            viewer={ctx.viewer}
            canChangeReviewRequests={props.access.canChangeReviewRequests}
            canDismissReviews={props.access.canDismissReviews}
            reviewersError={props.reviewersError}
          />
        </div>
      </div>
    </BaseLayout>
  );
}

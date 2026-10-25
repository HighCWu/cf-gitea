/**
 * The PR review interactions — pages wave 11 (SPEC-0008 U3 extension), the
 * third PR write family over the JUST-LANDED reviews API (migration 0018's
 * `pull_reviews`, the reviews-block contract rows):
 *
 *   POST /{owner}/{repo}/pulls/{index}/files/reviews/submit   the verdict form
 *                                            (upstream web.go:1678
 *                                            `m.Post("/submit", …)` under the
 *                                            pulls/{index}/files/reviews group,
 *                                            routers/web/repo/pull_review.go:222
 *                                            SubmitReview)
 *   POST /{owner}/{repo}/issues/request_review               request add/detach
 *                                            (web.go:1435 — repo-scoped, the
 *                                            issue id rides the form;
 *                                            pull_review.go:339
 *                                            UpdatePullReviewRequest)
 *   POST /{owner}/{repo}/issues/dismiss_review               dismiss a review
 *                                            (web.go:1436 — reqRepoAdmin;
 *                                            pull_review.go:280 DismissReview)
 *
 * plus the sidebar Reviewers section the PR detail page gains
 * (templates/repo/issue/sidebar/reviewer_list.tmpl, mounted by sidebar.tmpl:6
 * for is_pull rows) and the review verdict form on the conversation page.
 *
 * ## DOM contract (templates/repo/diff/new_review.tmpl + repo/issue/sidebar/
 *  reviewer_list.tmpl at the pin)
 *
 * - The verdict form is upstream's review combobox reduced honestly: the
 *   tippy button + popup panel (new_review.tmpl:9-60, a JS island) become an
 *   always-open `.review-box-panel > .ui.segment > form` with the upstream
 *   header text ("Submit review", repo.diff.review.header), a plain
 *   `<textarea name="content">` (placeholder "Review comment",
 *   repo.diff.review.placeholder) and ONE `<select name="type">` carrying the
 *   upstream's three submit buttons as options — `approve` / `comment` /
 *   `reject` (new_review.tmpl:42-56 over
 *   services/forms/repo_form.go:482-503 SubmitReviewForm.ReviewType(); the
 *   labels are the button strings repo.diff.review.approve/comment/reject).
 *   Upstream's DOM order (approve, comment, reject) is kept and `comment` is
 *   preselected — SubmitReviewForm.ReviewType's quick-submit default. The
 *   poster's approve/reject options render DISABLED with the upstream
 *   self_approve/self_reject tooltip strings as their labels (new_review.tmpl
 *   :38-56 renders disabled buttons + tooltips; the no-JS select puts the
 *   reason in the option text where a tooltip cannot reach). On a closed PR
 *   only the comment option renders (new_review.tmpl:39/49 `{{if not
 *   $.Issue.IsClosed}}`; merged rows are closed). Placement divergence
 *   (documented): upstream mounts the combobox on the FILES page only
 *   (diff/box.tmpl:48); cf-gitea renders it on the conversation page — the
 *   form needs no diff data and the files page keeps the upstream tippy
 *   island unrendered (its code-comment half has no landed UI).
 * - The Reviewers section is reviewer_list.tmpl reduced to its static list:
 *   `.issue-sidebar-combo` with the "Reviewers" heading
 *   (repo.issues.review.reviewers), the `.ui.relaxed.list.flex-items-block`
 *   carrying one `.item` PER VISIBLE review row (upstream
 *   routers/web/repo/issue_page_meta.go:422-489 builds CurrentPullReviewers
 *   one entry per review row — a reviewer who was requested AND then approved
 *   legitimately renders twice), "No Reviewers"
 *   (repo.issues.new.no_reviewers) when none, and each item's right column:
 *   the review-type glyph (`octicon-{Review.Type.Icon}` +
 *   `HTMLTypeColorClass`, models/issues/review.go:107-121/:210-229) with
 *   TooltipContent as its tooltip (review.go:232-249), the trash
 *   remove-request button for CanChange rows (reviewer_list.tmpl:69-75), and
 *   the admin dismiss control (reviewer_list.tmpl:60-65's X → the no-JS
 *   `<details>` form carrying upstream's modal fields verbatim:
 *   `review_id` + `message`, repo.issues.dismiss_review_warning +
 *   action.review_dismissed_reason + the red OK).
 *
 * ## Data (§3.2 — direct service reads, never a self-fetch)
 *
 * The reviews LIST read exists only inside the landed route module
 * (src/api/routes/pull-reviews.ts — repoListPullReviews' handler); its query
 * functions are module-private and importing the route module would drag the
 * zod-openapi graph into the UI bundle, so — exactly like pages/
 * notifications.tsx (wave 10) and pages/dashboard.tsx (wave 9) — this module
 * RE-ISSUES the landed semantics verbatim with citations:
 *
 * - the list read (pull-reviews.ts:1049-1055): all `pull_reviews` rows of the
 *   issue in FindReviews order (`created_unix` ASC, `id` ASC,
 *   review_list.go:120-137), PENDING rows visible to their reviewer and site
 *   admins only (convert/pull_review.go:69-73's list filter — hidden rows
 *   never render, the privacy posture the API list arm serves);
 * - `requestedReviewersOf` (pull-reviews.ts:952-965) stays the API route's
 *   consult — the sidebar re-derives the REQUEST rows from the same row set
 *   (type 4, reviewer_id > 0, id ASC) so the list and its remove buttons
 *   share one read;
 * - the SubmitReview pipeline (pull-reviews.ts:665-834 over
 *   models/issues/review.go:467-584): pending-row conversion, the official
 *   clear + recompute (base-repo write access decides — the protected-branch
 *   whitelist arm has no cf-gitea surface), the outstanding-REQUEST cleanup
 *   on every non-pending review, the previous-decision dismissal on
 *   approve/reject, the CommentTypeReview (22) system comment + num_comments
 *   bump in one batch, and the org-team REQUEST cleanup;
 * - preparePullReviewType (pull-reviews.ts:972-993 over
 *   routers/api/v1/repo/pull_review.go:675-707): the wire event map with the
 *   self-approval/self-rejection 422s and the REQUEST_CHANGES body
 *   requirement; the web form's `type` strings map onto the wire events
 *   (approve→APPROVED, comment→COMMENT, reject→REQUEST_CHANGES) before the
 *   port runs;
 * - the empty-commit default (pull-reviews.ts:1097-1102 over
 *   pull_review.go:521-536): an absent commit resolves the head ref tip
 *   through the engine read — the form posts no commit field;
 * - the request arms (pull-reviews.ts:846-945 over
 *   models/issues/review.go:697-820 AddReviewRequest/RemoveReviewRequest)
 *   and their isValidReviewRequest predicate (pull-reviews.ts:1544-1577 over
 *   services/issue/review_request.go:41-129): the already-requested silent
 *   skip, the closed/merged 403, the poster refusal, the reviewer-can-read
 *   check, CanDoerChangeReviewRequests (pull-reviews.ts:388-396 — poster /
 *   repo owner / site admin / collaborator; the org-team arm is the
 *   documented deviation) with upstream's two escapes (poster re-request
 *   after a review, reviewer self-request after their own approval), the
 *   official-flag clear/restore quirks, and the CommentTypeReviewRequest (27)
 *   comments;
 * - the dismissal arm (pull-reviews.ts:1376-1449 over pull_review.go
 *   :1048-1085 + services/pull/review.go:383-460): repo admin only,
 *   approve/reject rows only, closed/merged 403, the flag flip, the
 *   CommentTypeDismissReview (32) comment, silence (no webhook — upstream
 *   notifies mailer/feed only).
 *
 * Webhooks ride the shared emission seam (services/issue-events.ts
 * emitIssueEvent) with the landed payloads: submissions fire
 * `pull_request_review_{approved,rejected,comment}` per type — PENDING stays
 * silent (notifier.go:755-766) — and request add/remove fire
 * `pull_request_review_request` (notifier.go:793-815), both assembled from
 * the same converters the route module uses (toApiPullRequest /
 * toApiRepository / apiUserFromRow) with the session doer as sender.
 *
 * ## Auth + write posture (the wave-4..10 conventions)
 *
 * The GET page keeps its anonymous public read; the sidebar renders for
 * everyone (privacy-filtered). The verdict form renders for SIGNED-IN
 * viewers on non-archived repos (upstream new_review.tmpl's disabled-button
 * posture becomes the form's absence — the archive warning the comment form
 * renders covers the message); anonymous viewers see no review form.
 * request_review renders its no-JS control for CanDoerChangeReviewRequests
 * viewers only (the landed write predicate; upstream gates the combobox on
 * the same, issue_page_meta.go:362-371). All three POSTs run the §2.8
 * sameOriginGuard, then repo resolution (invisible → 404 shell), then
 * anonymous → the login 303 (upstream reqSignIn), then the archived refusal
 * as the 404 shell (upstream `context.RepoMustNotBeArchived()` wraps both
 * upstream groups, web.go:1419-1421/:1677 — NotFound per
 * services/context/repo.go:136-141). Submit/request failures re-render the
 * PR detail page at 200 with the upstream message and the kept draft (the
 * login failure convention); the dismiss arm answers the landed statuses in
 * the gate's plain-text shape (its control never renders the failure
 * states — upstream's own dismiss handler answers bare statuses too,
 * pull_review.go:288-291).
 *
 * ## Documented degradations (§6 method — arms the landed API lacks or the
 *  no-JS page cannot serve)
 *
 * - PENDING has no form surface: upstream creates pending reviews through
 *   per-line code comments (diff/comment_form.tmpl's `pending_review`
 *   button) and submits them through the SAME submit route; cf-gitea's
 *   verdict select carries exactly upstream's three buttons — the landed
 *   create arm's PENDING event (pull-reviews.ts:989-992) stays reachable
 *   only through the API. Pending rows that exist render in the sidebar
 *   (their reviewer sees them — the privacy filter), and the landed submit
 *   arm (POST /reviews/{id}) has no UI surface for the same reason.
 * - The candidates dropdown (reviewer_list.tmpl:9-44, the JS combobox over
 *   GetReviewers) is replaced by the username input; the upstream POST
 *   carries reviewer IDS (`id={{.ItemID}}`, reviewer_list.tmpl:73) while the
 *   no-JS attach posts the NAME — resolved by the landed arm's
 *   name-or-email resolver (pull-reviews.ts:1511-1519 over
 *   pull_review.go:826-865). Team reviewers have no input arm (the landed
 *   team arm needs an org-owned repo's team names; no UI surface) and TEAM
 *   request rows are not rendered in the list (user rows only, the
 *   requestedReviewersOf filter) — the upstream `octicon-people` team rows
 *   degrade away with the org-team deviation the landed module already
 *   records.
 * - The re-request control (reviewer_list.tmpl:77-81's `octicon-sync` link
 *   for CanChange non-requested rows) is not rendered — the glyph is outside
 *   the generated icon allowlist (scripts/gen-ui-icons.mjs is not a ui/
 *   file) and the flow is a nicety over the same attach arm.
 * - The stale hourglass (reviewer_list.tmpl:66-68) is not rendered —
 *   `octicon-hourglass` is outside the allowlist; staleness survives in the
 *   state glyph's color (official approvals go yellow, review.go:214-220)
 *   and the TooltipContent override (review.go:235-238).
 * - The undismissal arm (repoUnDismissPullReview) has no upstream sidebar
 *   surface (undismiss lives in the timeline conversation UI) — not
 *   rendered.
 * - The Cancel button of upstream's dismiss modal (reviewer_list.tmpl:124)
 *   is a JS modal control — the `<details>` toggle replaces it.
 * - Original-author review rows (mirrored imports) have no pull_reviews
 *   columns — nothing to render, nothing skipped.
 * - Icon degradations (the allowlist has 30 glyphs): the state glyphs
 *   octicon-diff (reject) and octicon-comment (comment AND upstream's
 *   pending default, review.go:107-121) are outside it — REQUEST_CHANGES
 *   renders octicon-git-pull-request-closed (the red PR glyph the state
 *   badge already uses) and COMMENT/PENDING render octicon-pencil (the
 *   landed octicon-pencil stands in, the wave-5 reopen-glyph precedent).
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { collaboratorModeOf } from "../../api/services/repo-collaborators";
import { engineReads } from "../../api/services/engine";
import {
  findPullRequestByIndex,
  pullHeadRefName,
  toApiPullRequest,
} from "../../api/services/pulls";
import {
  apiUserFromRow,
  canViewRepository,
  toApiRepository,
  type RepositoryWithOwner,
  type UserRow,
} from "../../api/services/repository";
import { CommentType } from "../../issues/comment-types";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { emitIssueEvent, type IssueEventRequest } from "../../services/issue-events";
import { comments, issues, pullReviews, ReviewType, teamMembers, users } from "../../db/schema";
import { userLink } from "../links";
import { Icon } from "../shell";
import type { RepoRow } from "../ui-context";
import type { Viewer } from "../viewer";

/** Page chrome text (component-local, the issueDetailLocale pattern — every
 *  string cites its upstream locale key). */
export const pullReviewLocale = {
  reviewers: "Reviewers", // "repo.issues.review.reviewers"
  no_reviewers: "No Reviewers", // "repo.issues.new.no_reviewers"
  remove_request_review: "Remove review request", // "repo.issues.remove_request_review"
  dismiss_review: "Dismiss Review", // "repo.issues.dismiss_review"
  dismiss_review_warning: "Are you sure you want to dismiss this review?", // "repo.issues.dismiss_review_warning"
  review_dismissed_reason: "Reason:", // "action.review_dismissed_reason"
  ok: "OK", // "ok"
  // The no-JS request control has no upstream string (the JS combobox posts
  // on selection) — cf-gitea labels, marked as additions.
  request_review_add: "Request review", // addition
  request_review_placeholder: "username", // addition
  request_review_label: "Request a review from a user", // addition (the input's aria-label)
  // The review form (repo.diff.review.*).
  review: "Review", // "repo.diff.review"
  review_header: "Submit review", // "repo.diff.review.header"
  review_placeholder: "Review comment", // "repo.diff.review.placeholder"
  review_approve: "Approve", // "repo.diff.review.approve"
  review_comment: "Comment", // "repo.diff.review.comment"
  review_reject: "Request changes", // "repo.diff.review.reject"
  review_self_approve: "Pull request authors can't approve their own pull request", // "repo.diff.review.self_approve"
  review_self_reject: "Pull request authors can't request changes on their own pull request", // "repo.diff.review.self_reject"
  // State tooltips (models/issues/review.go:232-249 TooltipContent's keys).
  state_official: "Approved", // "repo.issues.review.official"
  state_unofficial: "Uncounted approval", // "repo.issues.review.unofficial"
  state_stale: "Updated since approval", // "repo.issues.review.stale"
  state_commented: "Comment", // "repo.issues.review.commented"
  state_rejected: "Changes requested", // "repo.issues.review.rejected"
  state_requested: "Review pending", // "repo.issues.review.requested"
  state_pending: "Pending", // "repo.issues.review.pending"
} as const;

// ---------------------------------------------------------------------------
// The review-row read (the sidebar's single source — the re-issued list arm)
// ---------------------------------------------------------------------------

/** The wire `ReviewStateType` (modules/structs/pull_review.go:15-30). */
export type WireReviewState = "APPROVED" | "PENDING" | "COMMENT" | "REQUEST_CHANGES" | "REQUEST_REVIEW";

/** One sidebar entry: a visible review row plus its reviewer's display name.
 *  Rows whose reviewer is gone are skipped upstream (issue_page_meta.go:462)
 *  and skipped here — the list renders names. */
export interface PullReviewEntry {
  reviewId: number;
  /** The raw `ReviewType` (0 pending, 1 approve, 2 comment, 3 reject, 4 request). */
  type: number;
  reviewerId: number;
  reviewerName: string;
  official: boolean;
  stale: boolean;
  dismissed: boolean;
}

/**
 * The re-issued repoListPullReviews read (src/api/routes/pull-reviews.ts
 * :1049-1055 — FindReviews order `created_unix` ASC, `id` ASC
 * review_list.go:120-137), with the pending-privacy filter
 * (convert/pull_review.go:69-73: PENDING rows visible to their reviewer and
 * site admins only) and the reviewer-name join (upstream LoadReviewer's
 * ErrUserNotExist rows skip, issue_page_meta.go:462-467; team rows skip —
 * the header's degradation note).
 */
export async function loadPullReviewEntries(d1: D1Database, issueId: number, viewer: Viewer): Promise<PullReviewEntry[]> {
  const doerId = viewer.kind === "user" ? viewer.id : -1;
  const canSeePending = viewer.kind === "user" && viewer.isAdmin;
  const rows = await drizzle(d1)
    .select({ review: pullReviews, username: users.username })
    .from(pullReviews)
    .innerJoin(users, eq(users.id, pullReviews.reviewerId))
    .where(and(eq(pullReviews.issueId, issueId), sql`${pullReviews.reviewerId} > 0`))
    .orderBy(asc(pullReviews.createdAt), asc(pullReviews.id))
    .all();
  const entries: PullReviewEntry[] = [];
  for (const row of rows) {
    if (row.review.type === ReviewType.Pending && !canSeePending && row.review.reviewerId !== doerId) {
      continue; // pending rows are private to their reviewer (list filter)
    }
    entries.push({
      reviewId: row.review.id,
      type: row.review.type,
      reviewerId: row.review.reviewerId,
      reviewerName: row.username,
      official: row.review.official,
      stale: row.review.stale,
      dismissed: row.review.dismissed,
    });
  }
  return entries;
}

/** Map `ReviewType` → the wire state (pull-reviews.ts:443-456 over
 *  convert/pull_review.go:75-84). */
export function reviewStateOf(type: number): WireReviewState {
  switch (type) {
    case ReviewType.Approve:
      return "APPROVED";
    case ReviewType.Reject:
      return "REQUEST_CHANGES";
    case ReviewType.Comment:
      return "COMMENT";
    case ReviewType.Request:
      return "REQUEST_REVIEW";
    default:
      return "PENDING";
  }
}

/** The state glyph + color (review.go:107-121 Icon + :210-229
 *  HTMLTypeColorClass) with the allowlist degradations from the header. */
export function reviewStateGlyph(entry: PullReviewEntry): { icon: "octicon-check" | "octicon-pencil" | "octicon-git-pull-request-closed" | "octicon-dot-fill"; color: string } {
  switch (entry.type) {
    case ReviewType.Approve:
      // official → stale ? yellow : green; unofficial → text-light.
      return { icon: "octicon-check", color: !entry.official ? "tw-text-text-light" : entry.stale ? "tw-text-yellow" : "tw-text-green" };
    case ReviewType.Reject:
      return { icon: "octicon-git-pull-request-closed", color: "tw-text-red" }; // upstream octicon-diff — allowlist degradation
    case ReviewType.Request:
      return { icon: "octicon-dot-fill", color: entry.official ? "tw-text-yellow" : "tw-text-text-light" };
    default:
      // Comment AND the pending default (review.go:120-121) — upstream
      // octicon-comment, allowlist degradation.
      return { icon: "octicon-pencil", color: "tw-text-text-light" };
  }
}

/** TooltipContent (review.go:232-249) — the stale override first, upstream's
 *  own precedence. */
export function reviewStateTooltip(entry: PullReviewEntry): string {
  switch (entry.type) {
    case ReviewType.Approve:
      if (entry.stale) return pullReviewLocale.state_stale;
      return entry.official ? pullReviewLocale.state_official : pullReviewLocale.state_unofficial;
    case ReviewType.Reject:
      return pullReviewLocale.state_rejected;
    case ReviewType.Request:
      return pullReviewLocale.state_requested;
    case ReviewType.Pending:
      return pullReviewLocale.state_pending;
    default:
      return pullReviewLocale.state_commented;
  }
}

// ---------------------------------------------------------------------------
// The write predicates (the landed write arms' gates, re-issued verbatim)
// ---------------------------------------------------------------------------

/**
 * IsOfficialReviewer minus the protected-branch arm — the landed reduction
 * (pull-reviews.ts:367-375): base-repo write access decides. The session
 * viewer's columns: site admin, repo owner row, or a write/admin
 * collaborator.
 */
async function isOfficialReviewerUi(d1: D1Database, repo: RepoRow, reviewer: UserRow): Promise<boolean> {
  if (reviewer.isAdmin) return true;
  if (repo.ownerId !== null && repo.ownerId === reviewer.id) return true;
  const mode = await collaboratorModeOf(d1, repo.id, reviewer.id);
  return mode === "write" || mode === "admin";
}

/**
 * CanDoerChangeReviewRequests minus the org-team arm — the landed deviation
 * (pull-reviews.ts:388-396 over services/issue/review_request.go:186-226):
 * not archived, and poster / repo owner / site admin / collaborator.
 */
export async function canDoerChangeReviewRequests(
  d1: D1Database,
  repo: RepoRow,
  issue: IssueRow,
  viewer: Viewer,
): Promise<boolean> {
  if (viewer.kind !== "user") return false;
  if (repo.isArchived) return false;
  if (viewer.isAdmin) return true;
  if (issue.posterId !== null && viewer.id === issue.posterId) return true;
  if (repo.ownerId !== null && viewer.id === repo.ownerId) return true;
  return (await collaboratorModeOf(d1, repo.id, viewer.id)) !== "none";
}

// ---------------------------------------------------------------------------
// The SubmitReview pipeline (pull-reviews.ts:665-834 — verbatim port)
// ---------------------------------------------------------------------------

/** The ported arms' typed failure (the API's ApiError shape, message verbatim). */
export class PullReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The doer's full user row (pull-reviews.ts:378-381). */
async function doerRowOf(d1: D1Database, doerId: number): Promise<UserRow | null> {
  const rows = await drizzle(d1).select().from(users).where(eq(users.id, doerId)).limit(1).all();
  return rows[0] ?? null;
}

/** GetReviewByIssueIDAndUserID (review.go:586-604 — id DESC; the landed
 *  latestDecisionReview). */
async function latestDecisionReview(d1: D1Database, issueId: number, reviewerId: number) {
  const rows = await drizzle(d1)
    .select()
    .from(pullReviews)
    .where(
      and(
        eq(pullReviews.issueId, issueId),
        eq(pullReviews.reviewerId, reviewerId),
        inArray(pullReviews.type, [ReviewType.Approve, ReviewType.Reject, ReviewType.Request]),
      ),
    )
    .orderBy(sql`id desc`)
    .limit(1)
    .all();
  return rows[0] ?? null;
}

/** GetCurrentReview (review.go:430-447) — the latest PENDING row. */
async function currentPendingReview(d1: D1Database, issueId: number, reviewerId: number) {
  const rows = await drizzle(d1)
    .select()
    .from(pullReviews)
    .where(and(eq(pullReviews.issueId, issueId), eq(pullReviews.reviewerId, reviewerId), eq(pullReviews.type, ReviewType.Pending)))
    .orderBy(sql`id desc`)
    .limit(1)
    .all();
  return rows[0] ?? null;
}

/**
 * preparePullReviewType — verbatim port (pull-reviews.ts:972-993 over
 * routers/api/v1/repo/pull_review.go:675-707): the wire event → ReviewType
 * with the self-approval/self-rejection 422s and the REQUEST_CHANGES body
 * requirement.
 */
function preparePullReviewType(event: string, body: string, isPoster: boolean): number {
  switch (event) {
    case "APPROVED":
      if (isPoster) throw new PullReviewError(422, "approve your own pull is not allowed");
      return ReviewType.Approve;
    case "REQUEST_CHANGES":
      if (isPoster) throw new PullReviewError(422, "reject your own pull is not allowed");
      if (body.trim() === "") throw new PullReviewError(422, "review event REQUEST_CHANGES requires a body");
      return ReviewType.Reject;
    case "COMMENT":
      return ReviewType.Comment;
    default:
      // PENDING (upstream's default arm, :704-706) — unreachable from the
      // verdict select (three options only); kept for port parity.
      return ReviewType.Pending;
  }
}

/** ContentEmptyErr (review.go:455-465) — the routes' 422. */
function contentEmptyError(): PullReviewError {
  return new PullReviewError(422, "review requires a body or a comment");
}

export interface SubmitReviewResult {
  reviewId: number;
  reviewType: number;
  /** The CommentTypeReview system comment — upstream's redirect hashtag
   *  (`pulls/{index}#{comm.HashTag()}`, pull_review.go:270; CommentHashTag =
   *  `issuecomment-{id}`, models/issues/comment.go:554-556). */
  commentId: number;
}

/**
 * SubmitReview (models/issues/review.go:467-584) — the landed pipeline port
 * (pull-reviews.ts:665-834), line for line: the pending lookup, the
 * ContentEmpty guard (a pending row absorbs an empty comment body), the
 * closed-PR 422 on decisions, the official clear + recompute, the
 * outstanding-REQUEST cleanup on every non-pending review, the
 * previous-decision dismissal on approve/reject, the create-or-convert
 * insert, the CommentTypeReview (22) system comment + num_comments bump in
 * ONE batch (the returning carries the hashtag id), and the org-team
 * REQUEST cleanup.
 */
async function submitReviewPipeline(
  d1: D1Database,
  repo: RepoRow,
  input: { doerId: number; doerRow: UserRow; issue: IssueRow; reviewType: number; content: string; commitId: string },
): Promise<SubmitReviewResult> {
  const db = drizzle(d1);
  const now = new Date();
  const { doerId, issue } = input;
  const reviewType = input.reviewType;
  const isDecision = reviewType === ReviewType.Approve || reviewType === ReviewType.Reject;

  const pending = await currentPendingReview(d1, issue.id, doerId);
  if (pending === null && reviewType !== ReviewType.Approve && input.content.trim() === "") {
    throw contentEmptyError();
  }
  if (isDecision && issue.isClosed) {
    // ErrSubmitReviewOnClosedPR (services/pull/review.go:46-47 + :289-294).
    throw new PullReviewError(422, "can't submit review for a closed or merged PR");
  }

  let official = false;
  if (isDecision) {
    // Clear the reviewer's other official flags, then recompute (:524-542).
    await db
      .update(pullReviews)
      .set({ official: false })
      .where(and(eq(pullReviews.issueId, issue.id), eq(pullReviews.reviewerId, doerId)))
      .run();
    official = await isOfficialReviewerUi(d1, repo, input.doerRow);
  }

  const clearOutstandingRequests = reviewType !== ReviewType.Pending;
  const dismissPreviousDecisions = isDecision;

  let review: typeof pullReviews.$inferSelect;
  if (pending === null) {
    // CreateReview's transactional order (:396-428) — side effects first.
    if (clearOutstandingRequests) {
      await db
        .delete(pullReviews)
        .where(
          and(
            eq(pullReviews.issueId, issue.id),
            eq(pullReviews.reviewerId, doerId),
            eq(pullReviews.type, ReviewType.Request),
          ),
        )
        .run();
    }
    if (dismissPreviousDecisions) {
      await db
        .update(pullReviews)
        .set({ dismissed: true })
        .where(
          and(
            eq(pullReviews.issueId, issue.id),
            eq(pullReviews.reviewerId, doerId),
            inArray(pullReviews.type, [ReviewType.Approve, ReviewType.Reject]),
          ),
        )
        .run();
    }
    const inserted = await db
      .insert(pullReviews)
      .values({
        type: reviewType,
        reviewerId: doerId,
        issueId: issue.id,
        content: input.content,
        official,
        commitId: input.commitId,
        stale: false,
        dismissed: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();
    review = inserted[0]!;
  } else {
    // The pending-row conversion (:543-559) + its side effects (:560-566).
    if (clearOutstandingRequests) {
      await db
        .delete(pullReviews)
        .where(
          and(
            eq(pullReviews.issueId, issue.id),
            eq(pullReviews.reviewerId, doerId),
            eq(pullReviews.type, ReviewType.Request),
          ),
        )
        .run();
    }
    if (dismissPreviousDecisions) {
      await db
        .update(pullReviews)
        .set({ dismissed: true })
        .where(
          and(
            eq(pullReviews.issueId, issue.id),
            eq(pullReviews.reviewerId, doerId),
            inArray(pullReviews.type, [ReviewType.Approve, ReviewType.Reject]),
            sql`id != ${pending.id}`,
          ),
        )
        .run();
    }
    await db
      .update(pullReviews)
      .set({ type: reviewType, content: input.content, official, commitId: input.commitId, stale: false, updatedAt: now })
      .where(eq(pullReviews.id, pending.id))
      .run();
    review = { ...pending, type: reviewType, content: input.content, official, commitId: input.commitId, stale: false, updatedAt: now };
  }

  // The CommentTypeReview (22) system comment (:551-563) — the local
  // num_comments discipline bumps alongside every inserted comment.
  const batch = await db.batch([
    db
      .insert(comments)
      .values({
        type: CommentType.Review,
        posterId: doerId,
        issueId: issue.id,
        content: input.content,
        reviewId: review.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: comments.id }),
    db.update(issues).set({ numComments: sql`num_comments + 1`, updatedAt: now }).where(eq(issues.id, issue.id)),
  ] as const);
  const commentId = batch[0][0]?.id ?? 0;

  // Team-request cleanup on an org-owned repo (:563-584).
  if (repo.ownerId !== null && isDecision) {
    const doerTeams = await db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.orgId, repo.ownerId), eq(teamMembers.userId, doerId)))
      .all();
    if (doerTeams.length > 0) {
      await db
        .delete(pullReviews)
        .where(
          and(
            eq(pullReviews.issueId, issue.id),
            eq(pullReviews.type, ReviewType.Request),
            sql`${pullReviews.reviewerTeamId} > 0`,
            inArray(
              pullReviews.reviewerTeamId,
              doerTeams.map((team) => team.teamId),
            ),
          ),
        )
        .run();
    }
  }

  return { reviewId: review.id, reviewType: review.type, commentId };
}

/**
 * The UI submit arm — the landed create-review route's steps
 * (pull-reviews.ts:1087-1158) with the web form's `type` string mapped onto
 * the wire event first (SubmitReviewForm.ReviewType(),
 * services/forms/repo_form.go:492-503: approve/comment/reject). The form has
 * no code comments, so the create arm's CreateCodeComment loop is absent;
 * an empty commit_id resolves the head ref tip through the engine read
 * (pull-reviews.ts:1097-1102 over pull_review.go:521-536). The webhook fan
 * out rides emitIssueEvent (PENDING silent — notifier.go:763-766) and never
 * fails the write.
 */
export async function submitReviewFromForm(input: {
  request: IssueEventRequest;
  origin: string;
  pair: RepositoryWithOwner;
  repo: RepoRow;
  issue: IssueRow;
  pr: PullRequestRow;
  doerId: number;
  form: { type: string; content: string };
}): Promise<SubmitReviewResult> {
  const { request, origin, pair, repo, issue, pr, doerId } = input;
  const doerRow = await doerRowOf(request.env.DB, doerId);
  if (doerRow === null) throw new PullReviewError(404, "not found"); // the session doer vanished
  const isPoster = issue.posterId !== null && issue.posterId === doerId;
  // The web type → wire event map (SubmitReviewForm.ReviewType()'s three
  // names onto preparePullReviewType's enum).
  const wireEvent =
    input.form.type === "approve" ? "APPROVED" : input.form.type === "reject" ? "REQUEST_CHANGES" : input.form.type === "comment" ? "COMMENT" : "";
  if (wireEvent === "") {
    // Upstream's ReviewTypeUnknown arm answers ServerError (500) — a hand-
    // crafted POST re-renders instead (the select cannot emit it).
    throw new PullReviewError(422, `unknown review type: ${input.form.type}`);
  }
  const reviewType = preparePullReviewType(wireEvent, input.form.content, isPoster);
  const head = await engineReads(request.env, { ownerNamespace: repo.ownerNamespace, slug: repo.slug }).readCommit(
    pullHeadRefName(issue.index),
  );
  const result = await submitReviewPipeline(request.env.DB, repo, {
    doerId,
    doerRow,
    issue,
    reviewType,
    content: input.form.content,
    commitId: head?.oid ?? "",
  });

  // The PullRequestReview event (notifier.go:751-777) — PENDING stays
  // silent. Payload = the landed reviewEventPayload (pull-reviews.ts:573-592):
  // action "reviewed", requested_reviewer = sender = the doer.
  const eventType =
    reviewType === ReviewType.Approve
      ? "pull_request_review_approved"
      : reviewType === ReviewType.Reject
        ? "pull_request_review_rejected"
        : reviewType === ReviewType.Comment
          ? "pull_request_review_comment"
          : null;
  if (eventType !== null) {
    try {
      const viewer = { origin, requester: apiUserFromRow(doerRow, { origin, requester: null }) };
      await emitIssueEvent(request, {
        repoId: pair.repo.id,
        ownerId: pair.repo.ownerId,
        eventType,
        payload: {
          action: "reviewed",
          number: issue.index,
          pull_request: await toApiPullRequest(request.env.DB, viewer, pair, issue, pr, "single"),
          requested_reviewer: apiUserFromRow(doerRow, viewer),
          repository: toApiRepository(viewer, pair),
          sender: apiUserFromRow(doerRow, viewer),
          commit_id: "",
          review: { type: eventType, content: input.form.content },
        },
      });
    } catch {
      // Best-effort (the emitIssueEvent seam already contains its own
      // failures; the payload assembly must never fail the write).
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// The review-request arms (pull-reviews.ts:846-945 + :1498-1722 — ports)
// ---------------------------------------------------------------------------

/** AddReviewRequest (review.go:697-768) — the landed model arm verbatim
 *  (pull-reviews.ts:846-898). Returns null on the already-requested skip. */
async function addReviewRequest(
  d1: D1Database,
  repo: RepoRow,
  issue: IssueRow,
  pr: PullRequestRow,
  reviewer: UserRow,
  doerId: number,
): Promise<typeof pullReviews.$inferSelect | null> {
  const db = drizzle(d1);
  const now = new Date();

  const lastReview = await latestDecisionReview(d1, issue.id, reviewer.id);
  if (lastReview !== null && lastReview.type === ReviewType.Request) {
    return null; // already requested — silent skip (:706-710)
  }
  if (issue.isClosed || pr.hasMerged) {
    // ErrReviewRequestOnClosedPR (review.go:70-86) → 403.
    throw new PullReviewError(403, "cannot request a re-review on a closed or merged PR");
  }

  const official = await isOfficialReviewerUi(d1, repo, reviewer);
  if (official) {
    await db
      .update(pullReviews)
      .set({ official: false })
      .where(and(eq(pullReviews.issueId, issue.id), eq(pullReviews.reviewerId, reviewer.id)))
      .run();
  }

  const inserted = await db
    .insert(pullReviews)
    .values({ type: ReviewType.Request, reviewerId: reviewer.id, issueId: issue.id, content: "", createdAt: now, updatedAt: now })
    .returning()
    .all();
  const review = inserted[0]!;

  await db.batch([
    db.insert(comments).values({
      type: CommentType.ReviewRequest,
      posterId: doerId,
      issueId: issue.id,
      assigneeId: reviewer.id,
      removedAssignee: 0,
      reviewId: review.id,
      createdAt: now,
      updatedAt: now,
    }),
    db.update(issues).set({ numComments: sql`num_comments + 1`, updatedAt: now }).where(eq(issues.id, issue.id)),
  ]);

  return review;
}

/** RemoveReviewRequest (review.go:770-804) — the landed model arm verbatim
 *  (pull-reviews.ts:908-945). False = the silent no-op. */
async function removeReviewRequest(d1: D1Database, repo: RepoRow, issue: IssueRow, reviewer: UserRow, doerId: number): Promise<boolean> {
  const db = drizzle(d1);
  const now = new Date();

  const lastReview = await latestDecisionReview(d1, issue.id, reviewer.id);
  if (lastReview === null || lastReview.type !== ReviewType.Request) {
    return false; // nothing to remove — silent no-op (:777-780)
  }
  await db.delete(pullReviews).where(eq(pullReviews.id, lastReview.id)).run();

  if (await isOfficialReviewerUi(d1, repo, reviewer)) {
    const restored = await latestDecisionReview(d1, issue.id, reviewer.id);
    if (restored !== null) {
      await db.update(pullReviews).set({ official: true }).where(eq(pullReviews.id, restored.id)).run();
    }
  }

  await db.batch([
    db.insert(comments).values({
      type: CommentType.ReviewRequest,
      posterId: doerId,
      issueId: issue.id,
      assigneeId: reviewer.id,
      removedAssignee: 1,
      createdAt: now,
      updatedAt: now,
    }),
    db.update(issues).set({ numComments: sql`num_comments + 1`, updatedAt: now }).where(eq(issues.id, issue.id)),
  ]);
  return true;
}

export type ReviewRequestResult = { outcome: "applied" };

/**
 * The UI request arm — the landed reviewRequestArm's user half
 * (pull-reviews.ts:1498-1722 over pull_review.go:867-956). The attach
 * resolves the reviewer by NAME (the no-JS input) or email through the
 * landed resolver (pull-reviews.ts:1511-1519); the detach carries the
 * reviewer id (upstream's `id={{.ItemID}}` field). Team reviewers have no
 * UI arm (header note). Failures throw PullReviewError with the landed
 * messages; the notification split rides emitIssueEvent (user add AND
 * remove notify, action review_requested/review_request_removed —
 * notifier.go:793-815).
 */
export async function changeReviewRequestFromForm(input: {
  request: IssueEventRequest;
  origin: string;
  pair: RepositoryWithOwner;
  repo: RepoRow;
  issue: IssueRow;
  pr: PullRequestRow;
  doerId: number;
  form: { action: string; reviewerName: string; reviewerId: number | null };
}): Promise<ReviewRequestResult> {
  const { request, origin, pair, repo, issue, pr, doerId } = input;
  const isAdd = input.form.action === "attach";
  const doerRow = await doerRowOf(request.env.DB, doerId);
  if (doerRow === null) throw new PullReviewError(404, "not found");

  // Resolve ONE reviewer (the upstream loop degenerates to one entry per
  // arm through the no-JS controls). Detach keeps upstream's id field.
  let reviewer: UserRow;
  if (isAdd) {
    const name = input.form.reviewerName;
    const found = name.includes("@")
      ? (await drizzle(request.env.DB).select().from(users).where(eq(users.email, name)).limit(1).all())[0]
      : (await drizzle(request.env.DB).select().from(users).where(eq(users.usernameLower, name.toLowerCase())).limit(1).all())[0];
    if (found === undefined) throw new PullReviewError(404, `user doesn't exist: ${name}`);
    reviewer = found;
  } else {
    const id = input.form.reviewerId;
    const found =
      id === null ? null : ((await drizzle(request.env.DB).select().from(users).where(eq(users.id, id)).limit(1).all())[0] ?? null);
    if (found === null) throw new PullReviewError(404, `user doesn't exist: ${id ?? ""}`);
    reviewer = found;
  }

  // isValidReviewRequest (services/issue/review_request.go:41-129) — the
  // landed loop's per-reviewer guards (pull-reviews.ts:1548-1577). The
  // repo_id suffix renders the TEXT repo id verbatim (the landed module's
  // documented ErrNotValidReviewRequest rendering).
  if (reviewer.type === "org") {
    throw new PullReviewError(422, `Organization can't be added as reviewer [user_id: ${doerId}, repo_id: ${pair.repo.id}]`);
  }
  const canDoerChange = await canDoerChangeReviewRequests(request.env.DB, repo, issue, {
    kind: "user",
    id: doerId,
    username: doerRow.username,
    isAdmin: doerRow.isAdmin,
  });
  if (isAdd) {
    const reviewerViewer = { origin, requester: apiUserFromRow(reviewer, { origin, requester: null }) };
    const canRead =
      canViewRepository(reviewerViewer, pair.repo) ||
      (await collaboratorModeOf(request.env.DB, pair.repo.id, reviewer.id)) !== "none";
    if (!canRead) throw new PullReviewError(422, `Reviewer can't read [user_id: ${doerId}, repo_id: ${pair.repo.id}]`);
    if (issue.posterId !== null && reviewer.id === issue.posterId) {
      throw new PullReviewError(422, `poster of pr can't be reviewer [user_id: ${doerId}, repo_id: ${pair.repo.id}]`);
    }
    const lastReview = await latestDecisionReview(request.env.DB, issue.id, reviewer.id);
    const posterReRequest =
      issue.posterId !== null && doerId === issue.posterId && lastReview !== null && lastReview.type !== ReviewType.Request;
    const selfReRequest =
      !repo.isArchived && doerId === reviewer.id && lastReview !== null && lastReview.type === ReviewType.Approve;
    if (!canDoerChange && !posterReRequest && !selfReRequest) {
      throw new PullReviewError(422, `Doer can't choose reviewer [user_id: ${doerId}, repo_id: ${pair.repo.id}]`);
    }
  } else if (!canDoerChange) {
    const lastReview = await latestDecisionReview(request.env.DB, issue.id, reviewer.id);
    const selfDecline = lastReview !== null && lastReview.type === ReviewType.Request && lastReview.reviewerId === doerId;
    if (!selfDecline) {
      throw new PullReviewError(422, `Doer can't remove reviewer [user_id: ${doerId}, repo_id: ${pair.repo.id}]`);
    }
  }

  if (isAdd) {
    const created = await addReviewRequest(request.env.DB, repo, issue, pr, reviewer, doerId);
    if (created !== null) {
      // Per actually-created request (notifier.go:793-815).
      await emitReviewRequestEvent({ request, origin, pair, issue, pr, doerRow, reviewer, action: "review_requested" });
    }
    return { outcome: "applied" };
  }
  const removed = await removeReviewRequest(request.env.DB, repo, issue, reviewer, doerId);
  if (removed) {
    await emitReviewRequestEvent({ request, origin, pair, issue, pr, doerRow, reviewer, action: "review_request_removed" });
  }
  return { outcome: "applied" };
}

/** The pull_request_review_request fan-out (the landed request arms' payload
 *  — pull-reviews.ts:1590-1602/:1676-1688). */
async function emitReviewRequestEvent(input: {
  request: IssueEventRequest;
  origin: string;
  pair: RepositoryWithOwner;
  issue: IssueRow;
  pr: PullRequestRow;
  doerRow: UserRow;
  reviewer: UserRow;
  action: "review_requested" | "review_request_removed";
}): Promise<void> {
  try {
    const viewer = { origin: input.origin, requester: apiUserFromRow(input.doerRow, { origin: input.origin, requester: null }) };
    await emitIssueEvent(input.request, {
      repoId: input.pair.repo.id,
      ownerId: input.pair.repo.ownerId,
      eventType: "pull_request_review_request",
      payload: {
        action: input.action,
        number: input.issue.index,
        pull_request: await toApiPullRequest(input.request.env.DB, viewer, input.pair, input.issue, input.pr, "single"),
        requested_reviewer: apiUserFromRow(input.reviewer, viewer),
        repository: toApiRepository(viewer, input.pair),
        sender: apiUserFromRow(input.doerRow, viewer),
        commit_id: "",
      },
    });
  } catch {
    // Best-effort — the write already committed.
  }
}

// ---------------------------------------------------------------------------
// The dismissal arm (pull-reviews.ts:1376-1449 — the port)
// ---------------------------------------------------------------------------

export type DismissResult = { outcome: "dismissed"; commentId: number; issueIndex: number };

/**
 * The UI dismiss arm — the landed dismissReviewArm verbatim
 * (pull-reviews.ts:1376-1449 over pull_review.go:1048-1085 + services/pull/
 * review.go:383-460). The admin gate is the CALLER's (the route's
 * reqRepoAdmin / the settings predicate) — this port starts at the
 * type/closed guards. `priors` has no UI surface (upstream's modal carries
 * only the message field) and stays false.
 */
export async function dismissReviewFromForm(input: {
  request: IssueEventRequest;
  /** The dismissing repo — the review's issue must live here (upstream
   *  DismissReview scopes by ctx.Repo.Repository.ID). */
  repoId: string;
  doerId: number;
  reviewId: number;
  message: string;
}): Promise<DismissResult> {
  const db = drizzle(input.request.env.DB);
  const now = new Date();
  const row = (await db.select().from(pullReviews).where(eq(pullReviews.id, input.reviewId)).limit(1).all())[0];
  if (row === undefined) throw new PullReviewError(404, `review does not exist [id: ${input.reviewId}]`);
  // pull_review.go:1058-1061 — approve/reject rows only (the landed 403).
  if (row.type !== ReviewType.Approve && row.type !== ReviewType.Reject) {
    throw new PullReviewError(403, "not need to dismiss this review because it's type is not Approve or change request");
  }
  const issue = (await db.select().from(issues).where(eq(issues.id, row.issueId)).limit(1).all())[0];
  if (issue === undefined || issue.repoId !== input.repoId) throw new PullReviewError(404, "not found");
  const pr = issue.isPull
    ? ((await findPullRequestByIndex(input.request.env.DB, issue.repoId, issue.index))?.pullRequest ?? null)
    : null;
  if (issue.isClosed || pr?.hasMerged === true) {
    // ErrDismissRequestOnClosedPR (services/pull/review.go:404-417).
    throw new PullReviewError(403, "can't dismiss a review associated to a closed or merged PR");
  }

  if (row.dismissed !== true) {
    // DismissReview (review.go:638-652) — flip the flag.
    await db.update(pullReviews).set({ dismissed: true, updatedAt: now }).where(eq(pullReviews.id, row.id)).run();
  }
  // The CommentTypeDismissReview (32) comment (services/pull/review.go:443-456).
  const batch = await db.batch([
    db
      .insert(comments)
      .values({
        type: CommentType.DismissReview,
        posterId: input.doerId,
        issueId: issue.id,
        content: input.message,
        reviewId: row.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: comments.id }),
    db.update(issues).set({ numComments: sql`num_comments + 1`, updatedAt: now }).where(eq(issues.id, issue.id)),
  ] as const);
  // Silence arm: upstream has NO webhook on dismissal (mailer/feed only).
  return { outcome: "dismissed", commentId: batch[0][0]?.id ?? 0, issueIndex: issue.index };
}

// ---------------------------------------------------------------------------
// Form parsers (the urlencoded POST bodies — the wave-5 parsers' shape)
// ---------------------------------------------------------------------------

/** The verdict form (`content`, `type` — SubmitReviewForm's fields). */
export interface ReviewSubmitForm {
  content: string;
  type: string;
}

export function parseReviewSubmitForm(params: URLSearchParams): ReviewSubmitForm {
  return { content: params.get("content") ?? "", type: params.get("type") ?? "" };
}

/** The request-review POST (`action` attach|detach, `issue_ids`, `id`,
 *  `reviewer` — the upstream fields plus the no-JS name input). */
export interface ReviewRequestForm {
  action: string;
  issueId: number | null;
  reviewerId: number | null;
  reviewerName: string;
}

export function parseReviewRequestForm(params: URLSearchParams): ReviewRequestForm {
  const rawIssue = (params.get("issue_ids") ?? "").trim();
  const rawId = (params.get("id") ?? "").trim();
  return {
    action: params.get("action") ?? "",
    issueId: /^\d+$/.test(rawIssue) ? Number.parseInt(rawIssue, 10) : null,
    reviewerId: /^\d+$/.test(rawId) ? Number.parseInt(rawId, 10) : null,
    reviewerName: (params.get("reviewer") ?? "").trim(),
  };
}

/** The dismiss POST (`review_id`, `message` — the DismissReviewForm fields). */
export interface DismissReviewForm {
  reviewId: number | null;
  message: string;
}

export function parseDismissReviewForm(params: URLSearchParams): DismissReviewForm {
  const raw = (params.get("review_id") ?? "").trim();
  return { reviewId: /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null, message: params.get("message") ?? "" };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** Upstream CanChange (issue_page_meta.go:438-441) for one row: the
 *  request-change grant, or the reviewer's own request/approval rows. */
function rowCanChange(entry: PullReviewEntry, issue: IssueRow, repo: RepoRow, viewer: Viewer, canDoerChange: boolean): boolean {
  if (viewer.kind !== "user") return false;
  if (canDoerChange) return true;
  if (viewer.id !== entry.reviewerId) return false;
  if (entry.type === ReviewType.Request) return true;
  return entry.type === ReviewType.Approve && !issue.isClosed && !repo.isArchived;
}

/** Upstream CanBeDismissed (issue_page_meta.go:477-478): repo admin && the
 *  PR is open && a decision row. */
function rowCanBeDismissed(entry: PullReviewEntry, issue: IssueRow, pr: PullRequestRow | null, canDismiss: boolean): boolean {
  return canDismiss && !issue.isClosed && pr?.hasMerged !== true && (entry.type === ReviewType.Approve || entry.type === ReviewType.Reject);
}

/**
 * The Reviewers sidebar section (reviewer_list.tmpl reduced — the header's
 * DOM contract): the list of visible review rows with their state glyphs,
 * the CanChange remove buttons, the admin dismiss disclosures, and — for
 * CanDoerChangeReviewRequests viewers — the no-JS username input posting the
 * attach arm. `error` is the re-rendered attach/remove failure (the login
 * failure convention) shown under the control.
 */
export function ReviewersSidebar(props: {
  repoLink: string;
  issue: IssueRow;
  pr: PullRequestRow | null;
  repo: RepoRow;
  viewer: Viewer;
  entries: PullReviewEntry[];
  canDoerChange: boolean;
  canDismiss: boolean;
  error: string | null;
}) {
  const { repoLink, issue, pr, repo, viewer, entries, canDoerChange, canDismiss } = props;
  const requestAction = `${repoLink}/issues/request_review`;
  return (
    <div class="issue-sidebar-combo" data-selection-mode="multiple" data-update-algo="diff">
      <div class="fixed-text muted">
        <strong>{pullReviewLocale.reviewers}</strong>
      </div>
      {/* The re-rendered attach/remove failure renders regardless of the
          control's grant — an unprivileged viewer's 422 must stay visible
          (the re-render is the no-JS error channel). */}
      {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
      {viewer.kind === "user" && canDoerChange && !repo.isArchived ? (
        <form class="ui form" action={requestAction} method="post">
          <input type="hidden" name="action" value="attach" />
          <input type="hidden" name="issue_ids" value={String(issue.id)} />
          <div class="field">
            <div class="flex-text-block">
              <input
                name="reviewer"
                placeholder={pullReviewLocale.request_review_placeholder}
                aria-label={pullReviewLocale.request_review_label}
              />
              <button type="submit" class="ui tiny primary button">
                {pullReviewLocale.request_review_add}
              </button>
            </div>
          </div>
        </form>
      ) : null}
      <div class="ui relaxed list flex-items-block">
        {entries.length === 0 ? (
          <span class="item empty-list">{pullReviewLocale.no_reviewers}</span>
        ) : (
          entries.map((entry) => {
            const glyph = reviewStateGlyph(entry);
            const canChange = rowCanChange(entry, issue, repo, viewer, canDoerChange);
            const canBeDismissed = rowCanBeDismissed(entry, issue, pr, canDismiss);
            return (
              <div class="item" key={entry.reviewId}>
                <div class="flex-text-inline tw-flex-1">
                  <a class="muted flex-text-inline tw-gap-2" href={userLink(entry.reviewerName)}>
                    {entry.reviewerName}
                  </a>
                </div>
                <div class="flex-text-inline">
                  {canChange && entry.type === ReviewType.Request ? (
                    <form action={requestAction} method="post">
                      <input type="hidden" name="action" value="detach" />
                      <input type="hidden" name="issue_ids" value={String(issue.id)} />
                      <input type="hidden" name="id" value={String(entry.reviewerId)} />
                      <button
                        type="submit"
                        class="ui muted icon button"
                        aria-label={pullReviewLocale.remove_request_review}
                        data-tooltip-content={pullReviewLocale.remove_request_review}
                      >
                        <Icon name="octicon-trash" />
                      </button>
                    </form>
                  ) : null}
                  {canBeDismissed ? (
                    <details class="review-dismiss">
                      <summary class="ui muted button">{pullReviewLocale.dismiss_review}</summary>
                      <form action={`${repoLink}/issues/dismiss_review`} method="post">
                        <input type="hidden" name="review_id" value={String(entry.reviewId)} />
                        <div class="ui warning message">{pullReviewLocale.dismiss_review_warning}</div>
                        <div class="field">
                          <label for={`dismiss-message-${entry.reviewId}`}>{pullReviewLocale.review_dismissed_reason}</label>
                          <input id={`dismiss-message-${entry.reviewId}`} name="message" />
                        </div>
                        <button type="submit" class="ui red button">
                          {pullReviewLocale.ok}
                        </button>
                      </form>
                    </details>
                  ) : null}
                  <span class={glyph.color} data-tooltip-content={reviewStateTooltip(entry)}>
                    <Icon name={glyph.icon} size={16} />
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * The verdict form (new_review.tmpl reduced — the header's DOM contract).
 * Rendered for signed-in viewers on open-or-closed, non-archived PRs; the
 * poster's approve/reject options are disabled with the upstream reason
 * strings; a closed PR offers the comment verdict only. `form` carries the
 * re-rendered submission (the kept draft + the failure message).
 */
export function ReviewFormBlock(props: {
  repoLink: string;
  issue: IssueRow;
  isPoster: boolean;
  form: { content: string; error: string | null };
}) {
  const { repoLink, issue, isPoster } = props;
  const closed = issue.isClosed;
  const approveDisabled = isPoster; // new_review.tmpl:38-46 — the self-approve disable
  const rejectDisabled = isPoster; // :50-56 — the self-reject disable
  return (
    <div class="timeline-item comment form review-box">
      <div class="content">
        <div class="review-box-panel">
          <div class="ui segment">
            <form
              class="ui form"
              id="pull-review-form"
              action={`${repoLink}/pulls/${issue.index}/files/reviews/submit`}
              method="post"
            >
              <div class="field flex-text-block">
                <div class="tw-flex-1">{pullReviewLocale.review_header}</div>
              </div>
              {props.form.error !== null ? <div class="ui negative message">{props.form.error}</div> : null}
              <div class="field">
                <textarea name="content" rows={5} placeholder={pullReviewLocale.review_placeholder}>
                  {props.form.content}
                </textarea>
              </div>
              <div class="field footer">
                <div class="flex-text-block">
                  <label for="review-type">{pullReviewLocale.review}</label>
                  <select id="review-type" name="type">
                    {!closed ? (
                      <option value="approve" disabled={approveDisabled}>
                        {approveDisabled ? `${pullReviewLocale.review_approve} — ${pullReviewLocale.review_self_approve}` : pullReviewLocale.review_approve}
                      </option>
                    ) : null}
                    <option value="comment" selected>
                      {pullReviewLocale.review_comment}
                    </option>
                    {!closed ? (
                      <option value="reject" disabled={rejectDisabled}>
                        {rejectDisabled ? `${pullReviewLocale.review_reject} — ${pullReviewLocale.review_self_reject}` : pullReviewLocale.review_reject}
                      </option>
                    ) : null}
                  </select>
                  <button type="submit" class="ui tiny primary button">
                    {pullReviewLocale.review}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Handler glue (ui/index.ts calls these; kept here so the route module stays
// parse/respond only — the issue-comment handler's shape)
// ---------------------------------------------------------------------------

/** The detail page re-render input the two POST handlers share. */
export interface PullReviewReRender {
  /** The verdict form's kept draft + error (null = pristine). */
  reviewForm: { content: string; error: string | null };
  /** The Reviewers section's error (null = pristine). */
  reviewersError: string | null;
}

/** Pull a PullReviewError's message out of a caught failure (non-form
 *  failures rethrow — the 500 path). */
export function pullReviewErrorMessage(error: unknown): string | null {
  if (error instanceof PullReviewError) return error.message;
  return null;
}

/**
 * The pull-review write cores — the §14.6 extraction of
 * routes/pull-reviews.ts's review-submission + reviewer-request pipeline
 * (specs/email-outbound.md). Routes keep parse+validate+respond; the D1
 * writes live here, exactly the IssuesService(d1, mailEnv) precedent:
 *
 *   - `submitReview` — the SubmitReview port (models/issues/review.go
 *     :467–584): the pending-review fold or fresh row, the official-flag
 *     recompute, CreateReview's side effects (outstanding-request cleanup,
 *     previous-decision dismissal), the CommentTypeReview (22) system
 *     comment with its num_comments bump, and the org team-request cleanup.
 *   - `addReviewRequest` (models/issues/review.go:697–768) — the
 *     already-requested skip, the closed/merged 403, the official-flag
 *     clear, the REQUEST row, the CommentTypeReviewRequest (27) comment.
 *   - `removeReviewRequest` (models/issues/review.go:770–804) — the
 *     REQUEST-row-only removal, the restoreLatestOfficialReview quirk
 *     (:806–820), the removal comment.
 *
 * MAIL SEAM (the next wave rides this; this wave emits nothing): upstream
 * fires the family's mail receivers from the model/service layer AFTER the
 * writes commit, never the router —
 *   - `PullRequestReview` (services/mailer/notify.go:98–111) from
 *     SubmitReview (services/pull/review.go:316) over the review's type-22
 *     comment thread,
 *   - `PullRequestCodeComment` (notify.go:113–117, the MailMentionsComment
 *     mention resolution) from the same SubmitReview body (:323–331) over
 *     the submitted review's attached code comments,
 *   - `PullRequestReviewRequest` (notify.go:129–136, SendIssueAssignedMail
 *     "Requested to review <htmlurl>.") from the request model arm
 *     (services/issue/review_request.go:38 — `comment != nil`).
 * The marked SEAM comments below name each firing point; the constructor's
 * optional env (the IssuesService threading — routes pass `c.env`) arms
 * them. Absent env = arms off, the same fail-closed posture as
 * MAIL_ENABLED != "true", so today's callers are untouched.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { ReviewType, comments, issues, pullReviews, teamMembers } from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { findRule, isUserOfficialReviewer, parseRuleConfig, principalAccessOfRow } from "../../services/branch-protection";
import type { MailNotifyEnv } from "../../services/mail/notify";
import { ApiError } from "../errors";
import type { RepositoryWithOwner, UserRow } from "./repository";

/** The `pull_reviews` row (routes/pull-reviews.ts imports this alias). */
export type ReviewRow = typeof pullReviews.$inferSelect;

/**
 * IsOfficialReviewer (models/issues/review.go:276–306) over the SPEC-0013
 * rule service: the base branch's first-match rule decides — without a rule,
 * or without `enable_approvals_whitelist`, a reviewer with WRITE access on
 * the base repo makes official reviews; with the whitelist, the approvals
 * whitelist (user/team) only. Takes the reviewer's row — not the request
 * doer — because request arms evaluate the REVIEWER's officialness, and the
 * PR's base branch (the rule is matched against the BASE).
 */
async function isOfficialReviewer(d1: D1Database, found: RepositoryWithOwner, baseBranch: string, reviewer: UserRow | null): Promise<boolean> {
  if (reviewer === null) return false;
  const rule = await findRule(d1, found.repo.id, baseBranch);
  const access = await principalAccessOfRow(d1, found.repo, reviewer);
  return isUserOfficialReviewer(d1, rule === null ? null : parseRuleConfig(rule.rules), access);
}

/**
 * The reviewer's latest approve/reject/request review
 * (GetReviewByIssueIDAndUserID, models/issues/review.go:586–604 — id DESC).
 * Route-side consumers: the delete-review restore quirk and the
 * review-request validity checks.
 */
export async function latestDecisionReview(d1: D1Database, issueId: number, reviewerId: number): Promise<ReviewRow | null> {
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

/** GetCurrentReview (models/issues/review.go:430–447) — the latest PENDING row. */
export async function currentPendingReview(d1: D1Database, issueId: number, reviewerId: number): Promise<ReviewRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(pullReviews)
    .where(and(eq(pullReviews.issueId, issueId), eq(pullReviews.reviewerId, reviewerId), eq(pullReviews.type, ReviewType.Pending)))
    .orderBy(sql`id desc`)
    .limit(1)
    .all();
  return rows[0] ?? null;
}

/** ContentEmptyErr (models/issues/review.go:455–465) — the routes' 422. */
export class ContentEmptyError extends ApiError {
  constructor() {
    super(422, "review requires a body or a comment");
  }
}

export interface SubmitReviewInput {
  doerId: number;
  doerRow: UserRow | null;
  issue: IssueRow;
  /** The PR's base branch — the official predicate matches the rule on it. */
  baseBranch: string;
  reviewType: number;
  content: string;
  commitId: string;
}

export class PullReviewsService {
  private readonly db: DrizzleD1Database;
  private readonly d1: D1Database;
  /**
   * The mail-notify arms' env (specs/email-outbound.md §14.6): when present,
   * the write cores fan the review family's receivers — `submitReview` the
   * PullRequestReview + PullRequestCodeComment pair (upstream fires both
   * from SubmitReview, services/pull/review.go:316/:323–331),
   * `addReviewRequest`/`removeReviewRequest` the PullRequestReviewRequest
   * one (review_request.go:38) — notify fires from the model layer, never
   * the router. THE RECEIVERS ARE THE NEXT WAVE: this wave threads the env
   * only (the SEAM comments below mark each firing point), so every existing
   * construction site's posture stays byte-identical. Absent (or armed) the
   * writes below are identical — the arms are additive-only over this seam.
   */
  private readonly mailEnv?: MailNotifyEnv;

  constructor(d1: D1Database, mailEnv?: MailNotifyEnv) {
    this.d1 = d1;
    this.db = drizzle(d1);
    this.mailEnv = mailEnv;
  }

  /**
   * Port of SubmitReview: converts the doer's latest PENDING review (or
   * creates a fresh row), applies the CreateReview side-effects, lands the
   * CommentTypeReview system comment and returns the row. The OFFICIAL
   * computation needs the caller's repo pair (base-repo write access).
   */
  async submitReview(found: RepositoryWithOwner, input: SubmitReviewInput): Promise<ReviewRow> {
    const db = this.db;
    const now = new Date();
    const { doerId, issue } = input;
    const reviewType = input.reviewType;
    const isDecision = reviewType === ReviewType.Approve || reviewType === ReviewType.Reject;

    const pending = await currentPendingReview(this.d1, issue.id, doerId);
    if (pending === null && reviewType !== ReviewType.Approve && input.content.trim() === "") {
      throw new ContentEmptyError();
    }
    if (isDecision && issue.isClosed) {
      // ErrSubmitReviewOnClosedPR (services/pull/review.go:46–47 + :289–294 —
      // approve/reject on a closed or merged PR; comment/pending stay legal).
      throw new ApiError(422, "can't submit review for a closed or merged PR");
    }

    let official = false;
    if (isDecision) {
      // "Only reviewers latest review of type approve and reject shall count
      // as official" (:524–528 / :538–542) — clear, then recompute.
      await db
        .update(pullReviews)
        .set({ official: false })
        .where(and(eq(pullReviews.issueId, issue.id), eq(pullReviews.reviewerId, doerId)))
        .run();
      official = await isOfficialReviewer(this.d1, found, input.baseBranch, input.doerRow);
    }

    // CreateReview's side-effects (models/issues/review.go:396–428): a
    // non-pending review clears the reviewer's outstanding REQUEST rows
    // (:403–406); an approve/reject dismisses the previous decision rows
    // (:408–412). On the conversion arm the leftover-request cleanup repeats
    // after the update (:560–566).
    const clearOutstandingRequests = reviewType !== ReviewType.Pending;
    const dismissPreviousDecisions = isDecision;

    let review: ReviewRow;
    if (pending === null) {
      // CreateReview's transactional order (:396–428) — side effects first.
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
      // The pending-row conversion (:543–559) + its side effects (:560–566
      // and CreateReview's :408–412, scoped to the OTHER decision rows).
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
      review = {
        ...pending,
        type: reviewType,
        content: input.content,
        official,
        commitId: input.commitId,
        stale: false,
        updatedAt: now,
      };
    }

    // The CommentTypeReview (22) system comment (:551–563) — the local
    // num_comments discipline bumps alongside every inserted comment.
    await db.batch([
      db.insert(comments).values({
        type: CommentType.Review,
        posterId: doerId,
        issueId: issue.id,
        content: input.content,
        reviewId: review.id,
        createdAt: now,
        updatedAt: now,
      }),
      db.update(issues).set({ numComments: sql`num_comments + 1`, updatedAt: now }).where(eq(issues.id, issue.id)),
    ]);

    // Team-request cleanup on an org-owned repo (:563–584): an approve/reject
    // by a team member clears that team's REQUEST row.
    if (found.repo.ownerId !== null && isDecision) {
      const doerTeams = await db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(and(eq(teamMembers.orgId, found.repo.ownerId), eq(teamMembers.userId, doerId)))
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

    // SEAM (next wave — PullRequestReview, services/mailer/notify.go:98–111):
    // upstream fires it HERE, after the writes commit (SubmitReview
    // services/pull/review.go:316, over the type-22 comment `comm` this
    // method just landed + the doer's resolved mentions). The receiver
    // composes over the review's type-22/23/24/25 thread through the landed
    // hub core (§14.6); `this.mailEnv` arms it, absent = off.
    // SEAM (next wave — PullRequestCodeComment, notify.go:113–117): fired in
    // the SAME upstream body (:323–331) per code comment attached to the
    // submitted review — read this review's CommentType.Code rows and fan
    // the MailMentionsComment mention resolution (the parser half is landed,
    // §13). `this.mailEnv` arms it, absent = off.

    return review;
  }

  /**
   * AddReviewRequest (models/issues/review.go:697–768): the already-requested
   * skip, the closed/merged 403, the official-flag clear, the REQUEST row,
   * the CommentTypeReviewRequest (27) comment. Returns the created row or
   * null (skipped).
   */
  async addReviewRequest(
    found: RepositoryWithOwner,
    issue: IssueRow,
    pullRequest: PullRequestRow,
    reviewer: UserRow,
    doerId: number, // requireAuth guarantees the id (the route's `doer.id ?? 0`)
  ): Promise<ReviewRow | null> {
    const db = this.db;
    const now = new Date();

    const lastReview = await latestDecisionReview(this.d1, issue.id, reviewer.id);
    if (lastReview !== null && lastReview.type === ReviewType.Request) {
      return null; // already requested — silent skip (:706–710)
    }
    if (issue.isClosed || pullRequest.hasMerged) {
      // ErrReviewRequestOnClosedPR (review.go:70–86) → 403.
      throw new ApiError(403, "cannot request a re-review on a closed or merged PR");
    }

    const official = await isOfficialReviewer(this.d1, found, pullRequest.baseBranch, reviewer);
    if (official) {
      await db
        .update(pullReviews)
        .set({ official: false })
        .where(and(eq(pullReviews.issueId, issue.id), eq(pullReviews.reviewerId, reviewer.id)))
        .run();
    }

    // CreateReview carries the official flag ON the request row
    // (models/issues/review.go:759 `Official: official`) — the SPEC-0013
    // block_on_official_review_requests arm reads exactly it.
    const inserted = await db
      .insert(pullReviews)
      .values({ type: ReviewType.Request, reviewerId: reviewer.id, issueId: issue.id, content: "", official, createdAt: now, updatedAt: now })
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

    // SEAM (next wave — PullRequestReviewRequest, services/mailer/
    // notify.go:129–136): upstream fires it HERE for the USER request, after
    // the comment lands (services/issue/review_request.go:38 — `comment !=
    // nil`), SendIssueAssignedMail over `{ActionType: 0, Content: "Requested
    // to review <htmlurl>.", Comment: <this type-27 row>}` to the reviewer —
    // the notifyIssueAssigneeChanged shape with the review-request `ct`.
    // `this.mailEnv` arms it, absent = off.

    return review;
  }

  /**
   * RemoveReviewRequest (models/issues/review.go:770–804): the latest
   * approve/reject/request row must be a REQUEST row (else silent no-op);
   * the row is deleted, an official reviewer's latest decision review
   * restores its flag (restoreLatestOfficialReview :806–820, quirk faithful),
   * and a removal comment lands. Returns whether anything was removed (the
   * caller's webhook gate — upstream notifies only when a comment landed).
   */
  async removeReviewRequest(
    found: RepositoryWithOwner,
    issue: IssueRow,
    baseBranch: string,
    reviewer: UserRow,
    doerId: number, // requireAuth guarantees the id (the route's `doer.id ?? 0`)
  ): Promise<boolean> {
    const db = this.db;
    const now = new Date();

    const lastReview = await latestDecisionReview(this.d1, issue.id, reviewer.id);
    if (lastReview === null || lastReview.type !== ReviewType.Request) {
      return false; // nothing to remove — silent no-op (:777–780)
    }
    await db.delete(pullReviews).where(eq(pullReviews.id, lastReview.id)).run();

    if (await isOfficialReviewer(this.d1, found, baseBranch, reviewer)) {
      const restored = await latestDecisionReview(this.d1, issue.id, reviewer.id);
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

    // SEAM (next wave — PullRequestReviewRequest, services/mailer/
    // notify.go:129–136): upstream fires it HERE for the USER removal, when
    // the comment landed (review_request.go:38 `comment != nil`; the silent
    // no-op above returns before any of this) — the receiver self-gates the
    // removal off (notify.go:132 `!isRequest`, the IssueChangeAssignee
    // twin's posture). `this.mailEnv` arms it, absent = off.

    return true;
  }
}

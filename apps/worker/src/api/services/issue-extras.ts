import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { comments, issuePins, issueSubscriptions, issues, reactions, users } from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import type { IssueRow } from "../../issues/service";
import { findRepoCommentById } from "./issues";
import { getWatch, isWatchModeWatching } from "./repo-watchers";

/**
 * Tier-2 issue-family extras behind the T2 routes of the issue-extras batch
 * (SPEC-0004 appendix A category d rows: issue reactions ×2, issue
 * subscriptions, issue deadline, issue lock, pinned issues/pulls — upstream
 * routers/api/v1/repo/issue_reaction.go, issue_subscription.go, issue.go
 * EditIssueDeadline, issue_lock.go, issue_pin.go).
 *
 * Every table here landed with the generated migrations (0002: reactions,
 * issue_subscriptions, issue_pins) — no DDL bootstrap, Drizzle-only access per
 * the architecture boundary.
 *
 * Documented divergences (the no-column convention, same class as the star
 * counters in services/stars.ts):
 *   - reaction `LoadUsers` original-author halo (imports) is not modeled —
 *     reactions always join the acting user row;
 *   - upstream validates `content` against `setting.UI.Reactions` (the
 *     instance default set) and answers ErrForbiddenIssueReaction with 403;
 *     the same default set is enforced here (modules/setting/ui.go:102);
 *   - `IssueLockOptions.Reason` is accepted but not stored — the `issues`
 *     schema has no lock_reason column yet (the Lock/Unlock system comments
 *     still land, CommentType 23/24, so the timeline stays upstream-shaped).
 */

/** The instance's allowed reaction short-codes (setting.UI.Reactions default). */
export const ALLOWED_REACTIONS: ReadonlySet<string> = new Set([
  "+1",
  "-1",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
]);

export interface ReactionRow {
  id: number;
  userId: number;
  type: string;
  createdAt: Date | null;
}

/** FindReactions (models/issues/reaction.go) restricted to one target: the
 *  `comment_id=0` half is the issue surface, the release arm stays 0. */
export async function listTargetReactions(
  d1: D1Database,
  issueId: number,
  commentId: number,
): Promise<ReactionRow[]> {
  return drizzle(d1)
    .select({ id: reactions.id, userId: reactions.userId, type: reactions.type, createdAt: reactions.createdAt })
    .from(reactions)
    .where(and(eq(reactions.issueId, issueId), eq(reactions.commentId, commentId), eq(reactions.releaseId, 0)))
    .orderBy(asc(reactions.id))
    .all();
}

/** User rows for one reaction page (upstream reactions.LoadUsers), `users.id`
 *  order — the listing convention of the follow lists. */
export async function reactionUsers(d1: D1Database, rows: ReactionRow[]): Promise<Array<typeof users.$inferSelect>> {
  if (rows.length === 0) {
    return [];
  }
  return drizzle(d1)
    .select()
    .from(users)
    .where(inArray(users.id, rows.map((row) => row.userId)))
    .orderBy(asc(users.id))
    .all();
}

/** `user_id` map for the reaction render (ToAuthor pairs row → user). */
export function usersById(rows: Array<typeof users.$inferSelect>): Map<number, typeof users.$inferSelect> {
  return new Map(rows.map((row) => [row.id, row]));
}

export type ReactionChange = "created" | "exists";

/** CreateIssueReaction (issue_service) reduced to the modeled surface: one
 *  guarded insert — the `reactions_target_uq` unique tuple is the idempotence
 *  arbiter, the RETURNING probe answers created vs already-exists. */
export async function createIssueReaction(
  d1: D1Database,
  params: { userId: number; issueId: number; commentId: number; type: string },
  now: Date,
): Promise<ReactionChange> {
  const inserted = await drizzle(d1)
    .insert(reactions)
    .values({
      userId: params.userId,
      issueId: params.issueId,
      commentId: params.commentId,
      releaseId: 0,
      type: params.type,
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [reactions.userId, reactions.issueId, reactions.commentId, reactions.releaseId, reactions.type],
    })
    .returning({ id: reactions.id });
  return inserted.length > 0 ? "created" : "exists";
}

/** DeleteIssueReaction — upstream deletes silently (no rows is still 204). */
export async function deleteIssueReaction(
  d1: D1Database,
  params: { userId: number; issueId: number; commentId: number; type: string },
): Promise<void> {
  await drizzle(d1)
    .delete(reactions)
    .where(
      and(
        eq(reactions.userId, params.userId),
        eq(reactions.issueId, params.issueId),
        eq(reactions.commentId, params.commentId),
        eq(reactions.releaseId, 0),
        eq(reactions.type, params.type),
      ),
    );
}

/** The repo-scoped comment target of the comment-reaction and nested-comment
 *  routes: GetCommentWithRepoID (the comment must belong to THIS repo). */
export function findRepoComment(d1: D1Database, repoId: string, commentId: number) {
  return findRepoCommentById(d1, repoId, commentId);
}

// ---------------------------------------------------------------------------
// Issue subscriptions (models/issues/issue_watch.go)
// ---------------------------------------------------------------------------

/** GetIssueWatch + the repo-watch + participants fallbacks of CheckIssueWatch
 *  (models/issues/issue_watch.go:73-89): an explicit `issue_watch` row wins
 *  verbatim; the absence falls to the repo-watch read — `GetWatch`
 *  (models/repo/watch.go:57-69, the dummy mirror: an absent row IS mode
 *  None with every include true) decoded through `IsWatchModeWatching`
 *  (watch.go:104-106, mode ∉ {None, Dont}) AND the per-type include the
 *  issue's unit picks (`util.Iif(issue.IsPull, w.IncludePullRequests,
 *  w.IncludeIssues)`, issue_watch.go:85). A persisted Dont row (the
 *  ignore/mute state) therefore does NOT subscribe, and a Custom row
 *  subscribes only to its picked event types. The final arm is upstream's
 *  participants fallback (issue_watch.go:88 → IsUserParticipantsOfIssue,
 *  models/issues/issue.go:631-636 → GetParticipantIDsByIssue, issue.go:647-
 *  668): the issue poster plus the DISTINCT posters of the issue's comment
 *  types 0/21/22 (Comment/Code/Review) over active, non-login-prohibited
 *  users — the poster is appended WITHOUT the active filter (the poster
 *  always counts, issue.go:664-666). NOTE the pin reads NO mention arm
 *  here: `is_mentioned` (the issue_user carrier) is never consulted by
 *  CheckIssueWatch at fc493688 — a mentioned user does not subscribe to
 *  the thread through this read. */
export async function checkIssueSubscription(
  d1: D1Database,
  userId: number,
  issue: Pick<IssueRow, "id" | "repoId" | "isPull" | "posterId">,
): Promise<boolean> {
  const row = await drizzle(d1)
    .select({ isWatching: issueSubscriptions.isWatching })
    .from(issueSubscriptions)
    .where(and(eq(issueSubscriptions.userId, userId), eq(issueSubscriptions.issueId, issue.id)))
    .limit(1)
    .get();
  if (row !== undefined) {
    return row.isWatching;
  }
  const watch = await getWatch(d1, issue.repoId, userId);
  if (isWatchModeWatching(watch.mode) && (issue.isPull === true ? watch.watchPullRequests : watch.watchIssues)) {
    return true;
  }
  // The participants fallback: poster seat first (the unconditional append),
  // then the commented-participant probe (the INNER JOIN's active filter
  // collapses upstream's `is_active AND NOT prohibit_login` per the schema's
  // single `status` enum).
  if (issue.posterId !== null && issue.posterId === userId) {
    return true;
  }
  const participant = await drizzle(d1)
    .select({ posterId: comments.posterId })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.posterId))
    .where(
      and(
        eq(comments.issueId, issue.id),
        inArray(comments.type, [CommentType.Comment, CommentType.Code, CommentType.Review]),
        eq(users.status, "active"),
      ),
    )
    .limit(1)
    .get();
  return participant !== undefined;
}

/** The explicit issue subscribers (is_watching rows) rendered as users,
 *  `users.id` order (upstream GetIssueWatchers by issue_watch.id). */
export async function listIssueSubscribers(
  d1: D1Database,
  issueId: number,
): Promise<Array<typeof users.$inferSelect>> {
  return drizzle(d1)
    .select({ user: users })
    .from(issueSubscriptions)
    .innerJoin(users, eq(users.id, issueSubscriptions.userId))
    .where(and(eq(issueSubscriptions.issueId, issueId), eq(issueSubscriptions.isWatching, true)))
    .orderBy(asc(users.id))
    .all()
    .then((rows) => rows.map((row) => row.user));
}

export type SubscriptionChange = "changed" | "unchanged";

/** CreateOrUpdateIssueWatch + the upstream status split: the caller compares
 *  the current state first (200 unchanged / 201 changed), this upserts. */
export async function setIssueSubscription(
  d1: D1Database,
  params: { userId: number; issueId: number; watching: boolean },
  now: Date,
): Promise<void> {
  await drizzle(d1)
    .insert(issueSubscriptions)
    .values({
      userId: params.userId,
      issueId: params.issueId,
      isWatching: params.watching,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [issueSubscriptions.userId, issueSubscriptions.issueId],
      set: { isWatching: params.watching, updatedAt: now },
    });
}

// ---------------------------------------------------------------------------
// Pinned issues (models/issues/pin.go)
// ---------------------------------------------------------------------------

/** GetPinnedIssues restricted to one half of the issue/pull split, pin_order
 *  ASC (upstream orders by pin_order too). */
export async function listPinnedIssues(
  d1: D1Database,
  repoId: string,
  isPull: boolean,
): Promise<IssueRow[]> {
  return drizzle(d1)
    .select({ issue: issues })
    .from(issuePins)
    .innerJoin(issues, eq(issues.id, issuePins.issueId))
    .where(and(eq(issuePins.repoId, repoId), eq(issues.isPull, isPull)))
    .orderBy(asc(issuePins.pinOrder))
    .all()
    .then((rows) => rows.map((row) => row.issue));
}

// ---------------------------------------------------------------------------
// Lock / unlock (models/issues/lock.go) — the Lock/Unlock system comments ride
// the same num_comments discipline as the landed comment writes.
// ---------------------------------------------------------------------------

/** LockIssue: the is_locked flip + the Lock system comment in one batch (the
 *  already-locked arm is upstream's silent no-op — the route guards it). */
export async function lockIssue(d1: D1Database, issueId: number, actorId: number | null, now: Date): Promise<void> {
  await drizzle(d1).batch([
    drizzle(d1).update(issues).set({ isLocked: true, updatedAt: now }).where(eq(issues.id, issueId)),
    drizzle(d1).insert(comments).values({
      type: CommentType.Lock,
      posterId: actorId,
      issueId,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issueId)),
  ] as const);
}

/** UnlockIssue: the mirror flip + the Unlock system comment. */
export async function unlockIssue(d1: D1Database, issueId: number, actorId: number | null, now: Date): Promise<void> {
  await drizzle(d1).batch([
    drizzle(d1).update(issues).set({ isLocked: false, updatedAt: now }).where(eq(issues.id, issueId)),
    drizzle(d1).insert(comments).values({
      type: CommentType.Unlock,
      posterId: actorId,
      issueId,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issueId)),
  ] as const);
}

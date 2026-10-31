/**
 * The issue_user carrier — upstream's mention persistence, the wave the
 * email-outbound SPEC recorded as HANDOFF (specs/email-outbound.md §13.2).
 *
 * Ports (pin fc493688):
 *   - `UpdateIssueMentions` (models/issues/issue_update.go:515-527): the
 *     empty fast-path, then the user rows to ids.
 *   - `UpdateIssueUsersByMentions` (models/issues/issue_user.go:64-86):
 *     the per-uid Get→upsert. Upstream updates ONLY the `is_mentioned`
 *     column on an existing row (`Cols("is_mentioned")`, issue_user.go:77)
 *     — a user who already read the thread and gets mentioned again keeps
 *     `is_read` — and never un-mentions (the pin's whole models/services/
 *     routers tree writes `is_mentioned` only as true). The ON CONFLICT
 *     update carries the same single-column set.
 *   - `GetIssueMentionIDs` (models/issues/issue_user.go:89-96): the
 *     mentioned-uid read the search filter rides (issue_search.go:396-398).
 *
 * The callers thread this exactly where upstream runs
 * `FindAndUpdateIssueMentions`' persistence arm (issue_update.go:567):
 * the issue/comment/PR create services, before the notify fires —
 * services/issue/comments.go:81, services/issue/issue.go:68,
 * services/pull/pull.go:184.
 *
 * The table's third write is the NewIssueUsers SEED (issue_user.go:28-55):
 * at issue/PR create every repo assignee (GetRepoAssignees —
 * services/mentions/repo-assignees.ts) and the poster (when not already
 * among them) gets a zero-value row (`is_read`/`is_mentioned` default
 * false). Upstream runs it INSIDE the create transaction (issue_update.go:
 * 437) — the seed rides the create batch through newIssueUserSeedRows'
 * seat arithmetic; the mark-read consumer of `is_read`
 * (UpdateIssueUserByRead, issue_user.go:58-61) is UPDATE-only, so these
 * seeded seats are what make a later read-tracking write land at all.
 * That read-tracking write is `setIssueReadBy` below — the §13.4 mark-read
 * arm (the view seam + the API merge), added AFTER this module landed
 * (disclosed additive hunk, specs/email-outbound.md §13.4).
 */

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { issueUsers, notificationStates } from "../../db/schema";
import type { UserRow } from "../../api/services/repository";

/**
 * `UpdateIssueMentions` + `UpdateIssueUsersByMentions`: mark every given
 * user mentioned on the issue. Idempotent — a repeated mention re-fires the
 * same single-column update over the `(user_id, issue_id)` unique arbiter
 * (upstream's Get finds the row and re-updates the one column) — and
 * best-effort at the callers (a carrier failure degrades the notify
 * fan-out, never the create).
 */
export async function updateIssueMentions(d1: D1Database, issueId: number, users: UserRow[]): Promise<void> {
  if (users.length === 0) return; // upstream's empty fast-path, issue_update.go:517-519
  // The resolver dedupes by name case-fold, but two distinct raw names can
  // still fold to one id edge case-free; upstream loops per uid so a
  // repeated uid is a re-update, not a duplicate row — the VALUES list
  // collapses them to the same end state in one statement.
  const distinct = [...new Map(users.map((user) => [user.id, user])).values()];
  await drizzle(d1)
    .insert(issueUsers)
    .values(distinct.map((user) => ({ userId: user.id, issueId, isMentioned: true })))
    .onConflictDoUpdate({
      target: [issueUsers.userId, issueUsers.issueId],
      // Upstream's `Cols("is_mentioned")` — is_read stays untouched.
      set: { isMentioned: true },
    });
}

/** `GetIssueMentionIDs` (issue_user.go:89-96): the mentioned user ids of an
 *  issue, upstream's `Select("uid")` row order (rowid asc — the scan order
 *  of the issue-side index). */
export async function getIssueMentionIds(d1: D1Database, issueId: number): Promise<number[]> {
  const rows = await drizzle(d1)
    .select({ userId: issueUsers.userId })
    .from(issueUsers)
    .where(and(eq(issueUsers.issueId, issueId), eq(issueUsers.isMentioned, true)))
    .orderBy(asc(issueUsers.id))
    .all();
  return rows.map((row) => row.userId);
}

/**
 * `NewIssueUsers`' seat arithmetic (issue_user.go:33-53): every assignee
 * keeps a seat; "Poster can be anyone, append later if not one of
 * assignees" (:35-36) — the poster joins only when no assignee already
 * holds it (`isPosterAssignee`). A null poster (our nullable posterId;
 * upstream's PosterID is NOT NULL) simply brings no seat. The rows carry
 * the zero values — `is_read`/`is_mentioned` default false (issue_user.go:
 * 38-47 sets only IssueID + UID) — the pure shape lets the issue-create
 * service ride the rows through its creation batch (the upstream call is
 * in-transaction, issue_update.go:437).
 */
export function newIssueUserSeedRows(
  assignees: ReadonlyArray<Pick<UserRow, "id">>,
  posterId: number | null | undefined,
): Array<{ userId: number }> {
  const ids = assignees.map((user) => user.id);
  if (posterId !== null && posterId !== undefined && !ids.includes(posterId)) {
    ids.push(posterId);
  }
  return ids.map((userId) => ({ userId }));
}

/**
 * `NewIssueUsers` (issue_user.go:28-55) as a STANDALONE write — the
 * enumerated assignees plus the poster seat in one bulk insert of
 * zero-value rows. The issue-create service does NOT go through this
 * (the seed rides its creation batch, see newIssueUserSeedRows); this
 * shape exists for direct callers/tests that already hold an issue id.
 */
export async function seedIssueUsers(
  d1: D1Database,
  issueId: number,
  assignees: ReadonlyArray<Pick<UserRow, "id">>,
  posterId: number | null | undefined,
): Promise<void> {
  const rows = newIssueUserSeedRows(assignees, posterId);
  if (rows.length === 0) return;
  await drizzle(d1)
    .insert(issueUsers)
    .values(rows.map((row) => ({ ...row, issueId })));
}

/**
 * `SetIssueReadBy` (models/activities/notification.go:338-343) — the
 * mark-read write both of the §13.4 surfaces ride (specs/email-outbound.md):
 * the signed issue/PR page VIEW (routers/web/repo/issue_view.go:386-391 and
 * the PR twin pull.go:150-155, both `ctx.IsSigned`-gated, issue ID + doer
 * ID) and the API MERGE (routers/api/v1/repo/pull.go:909-914 — the merging
 * doer, never the poster or a reviewer). Upstream composes TWO halves in
 * one call and both of ours stamp both:
 *
 *   1. `UpdateIssueUserByRead` (models/issues/issue_user.go:58-61): the
 *      UPDATE-only `is_read` flip over the `(uid, issue_id)` arbiter. A
 *      viewer without a NewIssueUsers seat (the seed above) matches zero
 *      rows — no error, no row, exactly upstream's bare UPDATE semantics;
 *      the seeded seats are what make this half land at all.
 *   2. `setIssueNotificationStatusReadIfUnread` (notification.go:346-362):
 *      the notification-status twin. Upstream's half is materialized-row
 *      shaped — a GetIssueNotification miss no-ops, Pinned/Read statuses
 *      no-op, only Unread→Read writes. Our mailbox derives the same answer
 *      from `notification_states` (unread iff lastActivity > readAtUnix;
 *      later activity re-marks unread with no write-path hook), so the
 *      §13.4 decision note's compatible stamp is `read_at_unix = now` —
 *      an upsert over the same `(user_id, issue_id)` key the mark
 *      endpoints write (routes/notifications.ts markThreads' shape), with
 *      the divergence that keeps upstream's semantics: the conflict update
 *      sets ONLY the read marker + updatedAt, never `pinned` (upstream's
 *      view stamp skips Pinned rows untouched — only SetNotificationStatus,
 *      the endpoints' whole-status replace, clears a pin). A fresh row
 *      inserts around the column defaults; a state row for a mailbox
 *      non-recipient is inert (threads derive from the recipient
 *      predicate — the states only join).
 *
 * Upstream's bool result ("the unread count actually decreased, so callers
 * can skip a push on no-op", notification.go:336-337) has no consumer at
 * the pin's three call sites and none in this tree — dropped.
 */
export async function setIssueReadBy(d1: D1Database, issueId: number, userId: number, now: Date): Promise<void> {
  const db = drizzle(d1);
  const readAtUnix = Math.floor(now.getTime() / 1000);
  await db
    .update(issueUsers)
    .set({ isRead: true })
    .where(and(eq(issueUsers.userId, userId), eq(issueUsers.issueId, issueId)));
  await db
    .insert(notificationStates)
    .values({ userId, issueId, readAtUnix, updatedAt: now })
    .onConflictDoUpdate({
      target: [notificationStates.userId, notificationStates.issueId],
      // The view stamp never clears a pin (notification.go:351-353 — only
      // Unread→Read; the mark endpoints' `pinned: false` is SetNotification
      // Status's whole-status replace, a different upstream write).
      set: { readAtUnix, updatedAt: now },
    });
}

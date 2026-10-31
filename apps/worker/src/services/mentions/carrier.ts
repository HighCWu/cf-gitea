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
 */

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { issueUsers } from "../../db/schema";
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

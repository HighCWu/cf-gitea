import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

import {
  follows,
  issues,
  orgMembers,
  repositories,
  repoCollaborators,
  repoTransfer,
  repoWatchers,
  stars,
  userBlocking,
  users,
  issueAssignees,
} from "../../db/schema";
import type { UserRow } from "./repository";
import { ApiError } from "../errors";

/**
 * The `user_blocking` table + the user/org block service behind the
 * inventory batch 9 octet (upstream `routers/api/v1/user/block.go` +
 * `routers/api/v1/org/block.go` over `routers/api/v1/shared/block.go`,
 * `services/user/block.go`, and `models/user/block.go`):
 *
 *   user scope   GET /user/blocks (userListBlocks), GET
 *                /user/blocks/{username} (userCheckUserBlock), PUT
 *                /user/blocks/{username} (userBlockUser), DELETE …
 *                (userUnblockUser) — blocker = the authenticated doer
 *                (shared.BlockUser(ctx, ctx.Doer) / shared.UnblockUser(ctx,
 *                ctx.Doer, ctx.Doer)).
 *   org scope    the /orgs/{org}/blocks quartet (organizationListBlocks /
 *                organizationCheckUserBlock / organizationBlockUser /
 *                organizationUnblockUser) — blocker = the org
 *                (`ctx.Org.Organization.AsUser()`); the whole upstream group
 *                sits behind reqToken + reqOrgOwnership (api.go:1778-1786),
 *                ported as the routes' 401 middleware + the 403 ownership
 *                guard.
 *
 * Validation arms ported EXACTLY (status + message; upstream maps
 * ErrCanNotBlock / ErrCanNotUnblock / ErrBlockOrganization to
 * http.StatusBadRequest — services/context, shared/block.go:69-71, 87-89 —
 * a declared-422 vs runtime-400 swagger mismatch preserved verbatim, the
 * RUNTIME-ONLY convention):
 *   - unknown blockee (every write/check op): 404 "user does not exist [uid:
 *     0, name: X]" — ErrUserNotExist.Error() (models/user/error.go:45-46)
 *     via APIErrorAuto;
 *   - blockee is an organization: 400 "cannot block an organization"
 *     (ErrBlockOrganization — checked FIRST in both BlockUser and
 *     UnblockUser, services/user/block.go:97-99, 222-224), so blocking an
 *     org by name and an org blocking itself both land here;
 *   - CanBlockUser false: 400 "cannot block the user" — covers self-block
 *     (blocker==blockee), doer==blockee, the re-block of an existing pair
 *     (`IsUserBlockedBy(blockee, blocker.ID)`, block.go:47-53 — blocking is
 *     NOT idempotent upstream), an org blocking its own member, and (after
 *     the route gate) a non-owner doer;
 *   - CanUnblockUser false: 400 "cannot unblock the user" — covers
 *     doer==blockee, unblocking a pair that is not blocked, and (after the
 *     route gate) a non-owner doer.
 *
 * The BlockUser cascade (services/user/block.go:104-148) is ported over the
 * landed tables as one D1 batch (an implicit transaction): unfollow both
 * directions, unstar / unwatch / unassign / remove collaborations per
 * direction scoped to repos owned by the other party, and cancel pending
 * repository transfers between the pair (delete the `repo_transfer` row —
 * the repos/service.ts cancelTransfer convention; nothing else to reset —
 * no repositories status column tracks a pending transfer).
 *
 * DOCUMENTED FOLLOW-UPS (deliberately out of this batch's scope decision):
 *   - blocked-user VISIBILITY enforcement is not wired into any read path
 *     yet. Upstream enforces blocks at (map for the follow-up —
 *     `git grep -n "IsBlocked\|ErrBlockedUser" gitea/routers gitea/services`):
 *     follows (routers/api/v1/user/follower.go:235), stars
 *     (user/star.go:179), watches (user/watch.go:174), issue create/comment
 *     (repo/issue.go:625,780; issue_comment.go:387,574), reactions
 *     (issue_reaction.go:202,417), attachments
 *     (issue_comment_attachment.go:221), dependencies
 *     (CreateIssueDependency), assignees (repo/issue.go), collaborators
 *     (repo/collaborators.go:188), transfers (repo/transfer.go:118), team
 *     add-member (org/team.go:470), pulls (repo/pull.go:547,687), and the
 *     git push path (routers/private/hook_proc_receive.go:35, via
 *     IsUserBlockedBy in the receive hook). Those 403 "user is blocked"
 *     arms (ErrBlockedUser, models/user/block.go:21) are unreachable until
 *     that wiring lands.
 *   - the org-scope list renders blockees with the CALLER as the conversion
 *     doer; upstream passes the org row (`convert.ToUser(ctx, b.Blockee,
 *     blocker)` with blocker = the AsUser() org, shared/block.go:35) — with
 *     no keep_email_private column the landed toApiUser hides the email for
 *     non-self/non-admin viewers either way; the user scope is exact
 *     (blocker == doer upstream too).
 */

/** The exact upstream 400 arms (block.go:18-20 error strings). */
export const CANNOT_BLOCK_ORG_MESSAGE = "cannot block an organization";
export const CANNOT_BLOCK_MESSAGE = "cannot block the user";
export const CANNOT_UNBLOCK_MESSAGE = "cannot unblock the user";

/** The exact upstream unknown-user 404 body (models/user/error.go:45-46). */
export function userDoesNotExistMessage(name: string): string {
  return `user does not exist [uid: 0, name: ${name}]`;
}

/**
 * A blocking participant. Blocker may be an org; blockee is always an
 * individual (the org arm 400s before any row is written).
 */
export interface BlockParty {
  id: number;
  /** Upstream `IsOrganization()` — orgs ARE user rows (SPEC-0007 §3.2). */
  isOrg: boolean;
  /** Upstream `IsAdmin` — org rows are never site admins. */
  isAdmin: boolean;
}

export function blockPartyFromUserRow(row: UserRow): BlockParty {
  return { id: row.id, isOrg: row.type === "org", isAdmin: row.isAdmin };
}

/** The doer slice the permission checks need (the OrgProfileDoer shape). */
export interface BlockDoer {
  id: number;
  isAdmin: boolean;
}

export interface BlockListOptions {
  /** Effective (already clamped) pagination — the routes' parseListOptions. */
  page: number;
  pageSize: number;
}

export interface BlockListPage {
  items: UserRow[];
  total: number;
}

/**
 * `HasBlocking` (models/user/block.go:56-66): does `blockerId` block
 * `blockeeId` — a single EXISTS probe.
 */
export async function isBlockedBy(d1: D1Database, blockerId: number, blockeeId: number): Promise<boolean> {
  const row = await drizzle(d1)
    .select({ id: userBlocking.id })
    .from(userBlocking)
    .where(and(eq(userBlocking.blockerId, blockerId), eq(userBlocking.blockeeId, blockeeId)))
    .get();
  return row !== undefined;
}

/**
 * `FindBlockings(BlockerID)` + `BlockingList.LoadAttributes` +
 * `convert.ToUser` inputs (shared/block.go:11-40): the blocked users of one
 * blocker, joined to their user rows, ordered `id` ASC (the model's
 * `ToOrders` — block.go:74-76), paginated.
 */
export async function listBlockedUsers(
  d1: D1Database,
  blockerId: number,
  options: BlockListOptions,
): Promise<BlockListPage> {
  const db = drizzle(d1);
  const where = eq(userBlocking.blockerId, blockerId);
  const totalRow = await db
    .select({ total: sql<number>`count(*)` })
    .from(userBlocking)
    .where(where)
    .get();
  const rows = await db
    .select({ user: users })
    .from(userBlocking)
    .innerJoin(users, eq(users.id, userBlocking.blockeeId))
    .where(where)
    .orderBy(asc(userBlocking.id))
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize)
    .all();
  return { items: rows.map((row) => row.user), total: totalRow?.total ?? 0 };
}

/**
 * `CanBlockUser` (services/user/block.go:22-50) ported arm-for-arm; every
 * false arm surfaces as the shared 400 "cannot block the user". The
 * org-ownership arm (`org.IsOwnedBy(doer)` — org_members.role='owner', the
 * SPEC-0007 §3.3 Owners-team collapse, the same predicate
 * requireOrgOwnership's OrgService.isOrgOwner runs) is unreachable behind
 * the routes' reqOrgOwnership gate but ported so the service stands alone.
 */
async function canBlockUser(
  db: DrizzleD1Database,
  doer: BlockDoer,
  blocker: BlockParty,
  blockee: BlockParty,
): Promise<boolean> {
  if (blocker.id === blockee.id) return false;
  if (doer.id === blockee.id) return false;
  if (blockee.isOrg) return false;
  // `IsUserBlockedBy(blockee, blocker.ID)` (block.go:47-53): admins cannot
  // be blocked-by, so the re-block probe reads false for admin blockees and
  // an admin blockee can be (re-)blocked only via this arm's false.
  if (!blockee.isAdmin && (await isBlockedByDb(db, blocker.id, blockee.id))) return false;
  if (blocker.isOrg) {
    // An org never blocks its own member (block.go:37-39) — even a site
    // admin doer cannot (the member check precedes the ownership check).
    const member = await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, blocker.id), eq(orgMembers.userId, blockee.id)))
      .get();
    if (member !== undefined) return false;
    // `org.IsOwnedBy(doer)` (block.go:40-42).
    if (!doer.isAdmin) {
      const owner = await db
        .select({ id: orgMembers.id })
        .from(orgMembers)
        .where(
          and(eq(orgMembers.orgId, blocker.id), eq(orgMembers.userId, doer.id), eq(orgMembers.role, "owner")),
        )
        .get();
      if (owner === undefined) return false;
    }
  } else if (!doer.isAdmin && doer.id !== blocker.id) {
    return false;
  }
  return true;
}

/** isBlockedBy over an existing drizzle handle (the hot path above). */
async function isBlockedByDb(db: DrizzleD1Database, blockerId: number, blockeeId: number): Promise<boolean> {
  const row = await db
    .select({ id: userBlocking.id })
    .from(userBlocking)
    .where(and(eq(userBlocking.blockerId, blockerId), eq(userBlocking.blockeeId, blockeeId)))
    .get();
  return row !== undefined;
}

/**
 * `BlockUser` (services/user/block.go:97-148): the org-blockee arm, the
 * CanBlockUser gate, then the relation cascade + the blocking row in ONE
 * D1 batch (upstream's db.WithTx — D1 batch is an implicit transaction).
 * Throws the exact upstream 400 arms; 204s are the caller's.
 */
export async function blockUser(
  d1: D1Database,
  doer: BlockDoer,
  blocker: BlockParty,
  blockee: BlockParty,
  note: string,
): Promise<void> {
  if (blockee.isOrg) {
    throw new ApiError(400, CANNOT_BLOCK_ORG_MESSAGE);
  }
  const db = drizzle(d1);
  if (!(await canBlockUser(db, doer, blocker, blockee))) {
    throw new ApiError(400, CANNOT_BLOCK_MESSAGE);
  }
  const cleanup = cleanupBlockRelations(db, blocker.id, blockee.id);
  await db.batch([...cleanup, db.insert(userBlocking).values({ blockerId: blocker.id, blockeeId: blockee.id, note, createdAt: new Date() })]);
}

/**
 * `CanUnblockUser` (services/user/block.go:182-205) ported arm-for-arm;
 * every false arm surfaces as the shared 400 "cannot unblock the user".
 */
async function canUnblockUser(
  db: DrizzleD1Database,
  doer: BlockDoer,
  blocker: BlockParty,
  blockee: BlockParty,
): Promise<boolean> {
  if (doer.id === blockee.id) return false;
  if (!(await isBlockedByDb(db, blocker.id, blockee.id))) return false;
  if (blocker.isOrg) {
    if (!doer.isAdmin) {
      const owner = await db
        .select({ id: orgMembers.id })
        .from(orgMembers)
        .where(
          and(eq(orgMembers.orgId, blocker.id), eq(orgMembers.userId, doer.id), eq(orgMembers.role, "owner")),
        )
        .get();
      if (owner === undefined) return false;
    }
  } else if (!doer.isAdmin && doer.id !== blocker.id) {
    return false;
  }
  return true;
}

/**
 * `UnblockUser` (services/user/block.go:221-244): the org-blockee arm (the
 * SAME "cannot block an organization" message), the CanUnblockUser gate,
 * then the row delete (GetBlocking → DeleteByID). Not idempotent upstream:
 * unblocking a non-blocked pair is the 400, not a silent 204.
 */
export async function unblockUser(
  d1: D1Database,
  doer: BlockDoer,
  blocker: BlockParty,
  blockee: BlockParty,
): Promise<void> {
  if (blockee.isOrg) {
    throw new ApiError(400, CANNOT_BLOCK_ORG_MESSAGE);
  }
  const db = drizzle(d1);
  if (!(await canUnblockUser(db, doer, blocker, blockee))) {
    throw new ApiError(400, CANNOT_UNBLOCK_MESSAGE);
  }
  await db
    .delete(userBlocking)
    .where(and(eq(userBlocking.blockerId, blocker.id), eq(userBlocking.blockeeId, blockee.id)));
}

/**
 * The BlockUser cascade halves (services/user/block.go:105-145), both
 * directions of the (a, b) pair — upstream pages each direction at 25
 * rows/step; a set-based delete is the same end state in one statement:
 *   - unfollow each other (UnfollowUser ×2, block.go:110-114);
 *   - unstar each other's repos (unstarRepos — starrer × repos owned by the
 *     other, block.go:150-181);
 *   - unwatch each other's repositories (unwatchRepos, block.go:183-214);
 *   - unassign each other from issues on the other's repos (unassignIssues,
 *     block.go:259-289);
 *   - remove each other's collaborations on the other's repos
 *     (removeCollaborations, block.go:291-321);
 *   - cancel pending repository transfers between the pair
 *     (cancelRepositoryTransfers ×2, block.go:216-222 — sender/recipient in
 *     both directions; the cancel IS the row delete here, the
 *     repos/service.ts cancelTransfer convention).
 */
function cleanupBlockRelations(
  db: DrizzleD1Database,
  a: number,
  b: number,
): readonly [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] {
  const reposOwnedBy = (ownerId: number) =>
    db.select({ id: repositories.id }).from(repositories).where(eq(repositories.ownerId, ownerId));
  const issuesOnReposOf = (ownerId: number) =>
    db
      .select({ id: issues.id })
      .from(issues)
      .innerJoin(repositories, eq(issues.repoId, repositories.id))
      .where(eq(repositories.ownerId, ownerId));

  return [
    db.delete(follows).where(
      or(
        and(eq(follows.userId, a), eq(follows.followId, b)),
        and(eq(follows.userId, b), eq(follows.followId, a)),
      ),
    ),
    db.delete(stars).where(and(eq(stars.userId, a), inArray(stars.repoId, reposOwnedBy(b)))),
    db.delete(stars).where(and(eq(stars.userId, b), inArray(stars.repoId, reposOwnedBy(a)))),
    db.delete(repoWatchers).where(and(eq(repoWatchers.userId, a), inArray(repoWatchers.repoId, reposOwnedBy(b)))),
    db.delete(repoWatchers).where(and(eq(repoWatchers.userId, b), inArray(repoWatchers.repoId, reposOwnedBy(a)))),
    db.delete(issueAssignees).where(
      and(eq(issueAssignees.assigneeId, a), inArray(issueAssignees.issueId, issuesOnReposOf(b))),
    ),
    db.delete(issueAssignees).where(
      and(eq(issueAssignees.assigneeId, b), inArray(issueAssignees.issueId, issuesOnReposOf(a))),
    ),
    db.delete(repoCollaborators).where(
      and(eq(repoCollaborators.userId, a), inArray(repoCollaborators.repoId, reposOwnedBy(b))),
    ),
    db.delete(repoCollaborators).where(
      and(eq(repoCollaborators.userId, b), inArray(repoCollaborators.repoId, reposOwnedBy(a))),
    ),
    db.delete(repoTransfer).where(
      or(
        and(eq(repoTransfer.doerId, a), eq(repoTransfer.newOwnerId, b)),
        and(eq(repoTransfer.doerId, b), eq(repoTransfer.newOwnerId, a)),
      ),
    ),
  ];
}

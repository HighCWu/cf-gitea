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
 * no repositories status column tracks a pending transfer). The star/watch
 * removals also move the maintained `repositories.num_stars`/`num_watches`
 * counters (the cascade unstar/unwatch arms go through StarRepo(false)/
 * WatchRepoAuto(false) upstream — see cleanupBlockRelations).
 *
 * ENFORCEMENT WIRING (the wave-23 follow-up batch): the upstream 403
 * "user is blocked" arms (ErrBlockedUser, models/user/block.go:21 — a
 * permission-denied error, unwrapped to 403 by APIErrorAuto) are ported
 * where the landed route families own the seam:
 *   - issue create — assertNotBlockedForIssueCreate (services/issue/
 *     issue.go:33-34 via repo/issue.go:625), wired in routes/issues.ts;
 *   - issue title/content + comment create/edit —
 *     assertNotBlockedForIssueContent (issue.go:104-106, content.go:21-23,
 *     comments.go:63-65, 106-108 via issue.go:780 + issue_comment.go:387,
 *     574), wired in routes/issues.ts;
 *   - issue assignees — isUserBlockedBy(doer, assignee) (assignee.go:
 *     169-170 via issue_assignee.go:212), wired in routes/issue-tables-t2.ts;
 *   - comment attachments — assertNotBlockedForIssueContent
 *     (issue_comment_attachment.go:218-227 via UpdateComment), wired in
 *     routes/issue-attachments.ts;
 *   - collaborator add — the both-directions probe (collaboration.go:35-37
 *     via collaborators.go:188), wired in routes/collaborators.ts;
 *   - fork create — isUserBlockedBy(doer, source owner) (fork.go:64-66 via
 *     APIErrorAuto), wired in routes/forks.ts.
 *
 * REMAINING DOCUMENTED FOLLOW-UPS (seams outside this batch's file
 * ownership — each needs the named module's owner or the orchestrator):
 *   - follows (models/user/follow.go:39-40 via follower.go:235) — the write
 *     half PUT /user/following/{username} lives in routes/identity.ts;
 *   - stars (models/repo/star.go:34-35 via star.go:179) — routes/starred.ts;
 *   - watches (models/repo/watch.go:170-171 via watch.go:174) —
 *     routes/subscription.ts;
 *   - reactions (services/issue/reaction.go:20-21, 41-42 via
 *     issue_reaction.go:202,417) — routes/issue-t2.ts;
 *   - transfer create (services/repository/transfer.go:464-466 via
 *     transfer.go:118) — routes/repo.ts; the accept/reject seams
 *     (repo-extras-t2.ts) carry no upstream arm (transfer.go's accept
 *     handler has no ErrBlockedUser case);
 *   - pulls (services/pull/pull.go:64-65 via pull.go:547,687) —
 *     routes/pulls.ts;
 *   - team add-member (services/org/team.go:248-249 via org/team.go:470) —
 *     routes/org-teams.ts;
 *   - the git push path (routers/private/hook_proc_receive.go:35) — the
 *     git-http gate layer;
 *   - READ-side seams with no 403 arm: mention filtering skips users
 *     blocked by the doer (models/issues/issue_update.go:561) and xref
 *     resolution degrades to no-op (models/issues/issue_xref.go:225) — both
 *     land with the mention/xref engine seams; upstream has NO
 *     issue-list visibility filter for blocked users.
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

/**
 * The exact upstream 403 arm (ErrBlockedUser —
 * `util.NewPermissionDeniedErrorf("user is blocked")`, models/user/block.go:
 * 21; the permission-denied unwrap answers http.StatusForbidden through
 * APIErrorAuto, services/context/api.go:163-169).
 */
export const BLOCKED_USER_MESSAGE = "user is blocked";

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
 * `IsUserBlockedBy` (models/user/block.go:41-45): is `blockee` blocked by
 * ANY of `blockerIds` — the enforcement probe every upstream write arm
 * runs. A site-admin blockee is never blocked-by (the `blockee.IsAdmin`
 * short-circuit); `HasBlocking` below is the raw probe.
 */
export async function isUserBlockedBy(
  d1: D1Database,
  blockee: { id: number; isAdmin: boolean },
  ...blockerIds: number[]
): Promise<boolean> {
  if (blockee.isAdmin || blockerIds.length === 0) {
    return false;
  }
  const rows = await drizzle(d1)
    .select({ id: userBlocking.id })
    .from(userBlocking)
    .where(and(eq(userBlocking.blockeeId, blockee.id), inArray(userBlocking.blockerId, blockerIds)))
    .all();
  return rows.length > 0;
}

/**
 * The issue-content write arm shared by the issue title edit
 * (services/issue/issue.go:104-106), the issue content edit
 * (services/issue/content.go:21-23), the comment create (services/issue/
 * comments.go:63-65) and edit (:106-108), and the comment-attachment
 * create (issue_comment_attachment.go:218-227 — via UpdateComment): a doer
 * blocked by the issue poster OR the repo owner answers 403 "user is
 * blocked" UNLESS they are a repo admin (`access_model.IsUserRepoAdmin` —
 * the site-admin case is already covered by isUserBlockedBy's bypass, the
 * repo-admin flag is the caller's permission matrix). Throws; returns on
 * the clear path.
 */
export async function assertNotBlockedForIssueContent(
  d1: D1Database,
  doer: BlockDoer,
  isRepoAdmin: boolean,
  issuePosterId: number | null,
  repoOwnerId: number | null,
): Promise<void> {
  if (isRepoAdmin) {
    return;
  }
  const blockedBy = [issuePosterId, repoOwnerId].filter((id): id is number => id !== null && id !== doer.id);
  if (await isUserBlockedBy(d1, { id: doer.id, isAdmin: doer.isAdmin }, ...blockedBy)) {
    throw new ApiError(403, BLOCKED_USER_MESSAGE);
  }
}

/**
 * The NewIssue arm (services/issue/issue.go:33-34 via routers/api/v1/repo/
 * issue.go:625): the issue POSTER must not be blocked by the repo owner —
 * no repo-admin bypass on this arm (a repo admin blocked by the owner
 * cannot open issues either; only the site-admin short-circuit applies).
 * The `IsUserBlockedBy(poster, assigneeIDs...)` half of upstream's
 * condition rides the create-request assignee resolution, which the landed
 * POST /issues route drops (the issues.ts file-header deviation) — it
 * becomes reachable when that support lands.
 */
export async function assertNotBlockedForIssueCreate(
  d1: D1Database,
  doer: BlockDoer,
  repoOwnerId: number | null,
): Promise<void> {
  if (await isUserBlockedBy(d1, { id: doer.id, isAdmin: doer.isAdmin }, ...(repoOwnerId === null ? [] : [repoOwnerId]))) {
    throw new ApiError(403, BLOCKED_USER_MESSAGE);
  }
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
 *
 * Counter maintenance (the migration-0030 `repositories.num_stars` /
 * `num_watches` + 0031 `users.num_stars` columns): upstream's cascade
 * decrements THROUGH the same services the routes use — unstarRepos calls
 * StarRepo(false) per repo (block.go:172-175 → star.go:59's repo decrement
 * AND star.go:62's doer decrement — the per-USER twin moves with the same
 * removed edge) and unwatchRepos calls WatchRepoAuto(false) per repo
 * (block.go:206-209 → watch.go:153's repoWatchDelta) — so each removed edge
 * moves its repo's counter by exactly -1 and the starrer's user counter by
 * exactly -1. The set-based port matches that arithmetic: each edge delete
 * is PRECEDED by one counter UPDATE in the same batch (one implicit
 * transaction) that subtracts the still-present edge count for its own
 * (starrer/watcher, owner) scope — update-before-delete, because the count
 * subquery must see the rows its delete is about to remove. The (party,
 * owner) scopes are pairwise disjoint, so interleaving order is immaterial.
 * MAX(…, 0) floors the drift a pre-0030/0031 backfill row could carry
 * (counter 0 beneath surviving edges — the same floor posture as the route
 * arms in services/stars.ts / services/repo-watchers.ts).
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
  /** One counter UPDATE for a (party, repo-owner) scope: subtracts the
   *  edges the FOLLOWING delete in the batch removes. The subquery's
   *  `repositories AS owned` alias keeps the inner scan distinct from the
   *  UPDATE target. */
  const dropStarsFor = (party: number, ownerId: number) =>
    db
      .update(repositories)
      .set({
        numStars: sql`MAX(num_stars - (
          SELECT COUNT(*) FROM stars
          WHERE user_id = ${party}
            AND repo_id IN (SELECT owned.id FROM repositories AS owned WHERE owned.owner_id = ${ownerId})
        ), 0)`,
      })
      .where(inArray(repositories.id, reposOwnedBy(ownerId)));
  /** The per-USER twin (migration 0031 `users.num_stars`): upstream's
   *  unstarRepos → StarRepo(false) decrements the STARRER's tally with the
   *  same removed edges (star.go:62). Same update-before-delete posture as
   *  the repo arms; one row per party, disjoint from every other statement. */
  const dropUserStarsFor = (party: number, ownerId: number) =>
    db
      .update(users)
      .set({
        numStars: sql`MAX(num_stars - (
          SELECT COUNT(*) FROM stars
          WHERE user_id = ${party}
            AND repo_id IN (SELECT owned.id FROM repositories AS owned WHERE owned.owner_id = ${ownerId})
        ), 0)`,
      })
      .where(eq(users.id, party));
  const dropWatchesFor = (party: number, ownerId: number) =>
    db
      .update(repositories)
      .set({
        numWatches: sql`MAX(num_watches - (
          SELECT COUNT(*) FROM repo_watchers
          WHERE user_id = ${party}
            AND repo_id IN (SELECT owned.id FROM repositories AS owned WHERE owned.owner_id = ${ownerId})
        ), 0)`,
      })
      .where(inArray(repositories.id, reposOwnedBy(ownerId)));

  return [
    db.delete(follows).where(
      or(
        and(eq(follows.userId, a), eq(follows.followId, b)),
        and(eq(follows.userId, b), eq(follows.followId, a)),
      ),
    ),
    dropStarsFor(a, b),
    dropUserStarsFor(a, b),
    db.delete(stars).where(and(eq(stars.userId, a), inArray(stars.repoId, reposOwnedBy(b)))),
    dropStarsFor(b, a),
    dropUserStarsFor(b, a),
    db.delete(stars).where(and(eq(stars.userId, b), inArray(stars.repoId, reposOwnedBy(a)))),
    dropWatchesFor(a, b),
    db.delete(repoWatchers).where(and(eq(repoWatchers.userId, a), inArray(repoWatchers.repoId, reposOwnedBy(b)))),
    dropWatchesFor(b, a),
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

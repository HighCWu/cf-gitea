/**
 * The repo-assignee enumeration — the port of upstream's `GetRepoAssignees`
 * (gitea/models/repo/user_repo.go:117-152 at pin fc493688): every user that
 * can be assigned to the repo's issues/PRs, upstream's arms in upstream's
 * order.
 *
 *   1. the `access` arm (:126-133): users holding a repo access row at
 *      mode >= write — our landed interpretation of that arm is the
 *      `repo_collaborators` store's write/admin rows (the same fold the
 *      /assignees route records, api/services/repo-collaborators.ts
 *      listRepoAssignees; upstream's recalculated `access` table has no
 *      landed counterpart);
 *   2. the ORG-team arm (:135-141): when the owner is an organization,
 *      every member of a team joined to THIS repo (`team_repo` → our
 *      materialized `team_repo_access` rows) whose team grants READ on the
 *      issues or pulls units — `GetTeamUserIDsWithAccessToAnyRepoUnit`
 *      (models/organization/team_repo.go:85-96: `team.authorize >= read OR
 *      any team_unit(issues|pulls).access_mode >= read`, then the
 *      `team_user` expansion). The unit gate is the landed
 *      `teamUnitEnabled` collapse (services/mentions/resolve.ts —
 *      max(authorize, the unitsMap override), keys "repo.issues"/
 *      "repo.pulls" per structs/org_team.go:34), tested per unit key;
 *   3. active users only (:146-149 — upstream `is_active = true`; our
 *      `users.status = 'active'` is the tree's is_active + !prohibit_login
 *      collapse), `GetOrderByName` order (the landed username-ASC
 *      precedent, listRepoAssignees);
 *   4. the OWNER seat (:151-153): a NON-organization owner is appended
 *      unconditionally (never active-filtered, never sorted in — upstream
 *      appends `repo.Owner` raw) unless already enumerated; an org owner
 *      is NOT a seat (:151 `!repo.Owner.IsOrganization()`).
 *
 * CONSUMER: the NewIssueUsers seed (services/mentions/carrier.ts
 * newIssueUserSeedRows — issue_user.go:28-55) enumerates THIS list at
 * issue/PR create. Upstream serves the /repos/{owner}/{repo}/assignees
 * route from the SAME function; our route keeps its reduced
 * listRepoAssignees (collaborators + owner, no team arm) — the two read
 * this module's shape and the route's unification is the collaborators
 * owner's call (recorded in specs/email-outbound.md §13.4).
 */

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repoCollaborators, teamMembers, teamRepoAccess, teams, users } from "../../db/schema";
import type { UserRow } from "../../api/services/repository";

/** Access-mode rank (the landed TeamAccessMode ordering — resolve.ts shares it). */
const MODE_RANK: Record<string, number> = { none: 0, read: 1, write: 2, admin: 3, owner: 4 };

/** Upstream `perm.AccessModeRead` = 1 (perm/access_mode.go:17-22). */
const READ_RANK = 1;

/**
 * `GetTeamUserIDsWithAccessToAnyRepoUnit`'s team gate (team_repo.go:64-74):
 * the team qualifies when `authorize >= read` OR one of the two assignable
 * units carries an override >= read. `unitsMap` null = plain-permission
 * team — the authorize rank alone decides.
 */
function teamGrantsAnAssignableUnit(authorize: string, unitsMap: string | null): boolean {
  let rank = MODE_RANK[authorize] ?? 0;
  if (rank < READ_RANK && unitsMap !== null) {
    const overrides = JSON.parse(unitsMap) as Record<string, string>;
    for (const unitKey of ["repo.issues", "repo.pulls"]) {
      const overrideRank = MODE_RANK[overrides[unitKey] ?? ""] ?? 0;
      if (overrideRank > rank) rank = overrideRank;
    }
  }
  return rank >= READ_RANK;
}

/**
 * `GetRepoAssignees` (user_repo.go:117-152) — the enumerated rows in
 * upstream's shape: active collaborator/team users in username order, then
 * the non-org owner seat appended last.
 */
export async function getRepoAssignees(
  d1: D1Database,
  repo: { id: string; ownerId: number | null },
): Promise<UserRow[]> {
  const db = drizzle(d1);

  // Arm 1 — the write-or-above collaborators (user_repo.go:126-133).
  const collaboratorIds = (
    await db
      .select({ userId: repoCollaborators.userId })
      .from(repoCollaborators)
      .where(and(eq(repoCollaborators.repoId, repo.id), inArray(repoCollaborators.mode, ["write", "admin"])))
      .all()
  ).map((row) => row.userId);
  const uniqueIds = new Set(collaboratorIds);

  // Arm 2 — the org-team users (user_repo.go:135-141). The owner row is
  // loaded once: it decides the org branch AND the owner seat below.
  const owner = repo.ownerId === null ? undefined : await db.select().from(users).where(eq(users.id, repo.ownerId)).get();
  if (owner !== undefined && owner.type === "org") {
    const qualifyingTeams = (
      await db
        .select({ id: teams.id, authorize: teams.authorize, unitsMap: teams.unitsMap })
        .from(teams)
        .innerJoin(teamRepoAccess, eq(teamRepoAccess.teamId, teams.id))
        .where(and(eq(teams.orgId, owner.id), eq(teamRepoAccess.repoId, repo.id)))
        .all()
    ).filter((team) => teamGrantsAnAssignableUnit(team.authorize, team.unitsMap));
    if (qualifyingTeams.length > 0) {
      const teamUserIds = (
        await db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(inArray(teamMembers.teamId, qualifyingTeams.map((team) => team.id)))
          .all()
      ).map((row) => row.userId);
      for (const id of teamUserIds) uniqueIds.add(id);
    }
  }

  // Arm 3 — the active user rows, GetOrderByName order (username ASC).
  const enumerated: UserRow[] =
    uniqueIds.size === 0
      ? []
      : [...(await db.select().from(users).where(inArray(users.id, [...uniqueIds])).all())]
          .filter((user) => user.status === "active")
          .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));

  // Arm 4 — the non-org owner seat, appended raw (user_repo.go:151-153).
  if (owner !== undefined && owner.type !== "org" && !uniqueIds.has(owner.id)) {
    enumerated.push(owner);
  }
  return enumerated;
}

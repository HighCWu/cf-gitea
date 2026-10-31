/**
 * The mention RESOLUTION half — the port of upstream's
 * `ResolveIssueMentionsByVisibility` (gitea/models/issues/issue_update.go:
 * 575-696 at pin fc493688): turn the parser's raw names into the user rows
 * that count as mentioned, upstream's filters in upstream's order —
 *
 *   1. case-fold + dedupe through the `resolved` map (issue_update.go:583,
 *      :595-611 — keys are lower names, values "already resolved");
 *   2. the doer's own name pre-seeded as resolved (:595 — nobody is their
 *      own mention);
 *   3. TEAM mentions `@org/team` (:601-607): only on org-owned repos, only
 *      when the org prefix IS the repo owner, expanded through the teams
 *      joined to THIS repo (the `team_repo` join :613-619 → our
 *      `team_repo_access`), gated on the team's unit being enabled
 *      (`UnitEnabled(TypeIssues|TypePullRequests)` :629 — `UnitAccessModeEx`
 *      team.go:199-214: max(team.AccessMode, the unit override) > none; our
 *      per-unit overrides live in `teams.unitsMap`, the documented
 *      `team_unit` collapse — keys are upstream's unit names, "repo.issues"
 *      / "repo.pulls" per structs/org_team.go:34) and expanded to the
 *      members (:634-652 — active, not login-prohibited; our single
 *      `users.status = 'active'` collapses upstream's is_active +
 *      !prohibit_login per the schema);
 *   4. INDIVIDUAL users (:657-693): active, not the doer, not an
 *      organization (:681 `user.IsOrganization()`) and able to READ the
 *      issue (:685-691 `GetIndividualUserRepoPermission` — the INDIVIDUAL
 *      permission, repo_permission.go:426-491: deliberately WITHOUT team
 *      grants, so an org team member named directly must come through the
 *      team arm). Our gate is that function's core: site admin, the repo's
 *      owner, a public repo, or a collaborator row. Folded reduction: the
 *      upstream function's `HasOrgOrUserVisible` arm (repo_permission.go:
 *      459-464 — strangers lose a PUBLIC repo of a PRIVATE owner) has no
 *      single landed predicate; the mail arm one step downstream applies
 *      the landed CheckRepoUnitUser fold (`user.isAdmin || publicRepo ||
 *      doerRepoAccessMode`) to every survivor regardless, so the resolver
 *      folding that arm keeps both gates consistent with the landed
 *      posture (the mail side re-gates; nothing can leak through).
 *
 * NO database writes IN THIS MODULE: the resolver stays the pure
 * parse-to-users half. Upstream's `FindAndUpdateIssueMentions` persists
 * `issue_user.is_mentioned` (issue_update.go:567 → UpdateIssueUsersByMentions,
 * issue_user.go:64-86) — the carrier landed beside it (migration 0057's
 * `issue_user` table, services/mentions/carrier.ts): the callers run
 * resolve then persist, upstream's function shape. Our per-issue store is
 * `issue_subscriptions` = upstream's `issue_watch`, a DIFFERENT relation —
 * a mention never touches it at the pin, and the carrier rows are
 * `issue_user` rows, not subscription rows.
 *
 * The upstream `IsUserBlockedBy` filter (issue_update.go:559-565) is folded
 * onto the same reduction ledger: our schema carries no user-block table.
 */

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repoCollaborators, teamMembers, teamRepoAccess, teams, users } from "../../db/schema";
import type { RepositoryRow, UserRow } from "../../api/services/repository";

/** Access-mode rank (the landed TeamAccessMode ordering, repository.ts). */
const MODE_RANK: Record<string, number> = { none: 0, read: 1, write: 2, admin: 3, owner: 4 };

/**
 * Upstream `UnitEnabled` (team.go:194-214): max(team.AccessMode, the unit's
 * override) > none. `unitsMap` null = no overrides (the plain-permission
 * team) → the team's own mode decides; the override map is written by the
 * teams route exactly upstream-shaped (authorize 'none' + per-unit modes).
 */
function teamUnitEnabled(
  authorize: "none" | "read" | "write" | "admin" | "owner",
  unitsMap: string | null,
  unitKey: "repo.issues" | "repo.pulls",
): boolean {
  let rank = MODE_RANK[authorize] ?? 0;
  if (unitsMap !== null) {
    const override = (JSON.parse(unitsMap) as Record<string, string>)[unitKey];
    // An unknown override mode degrades to 'none' (0) — it can never lift.
    const overrideRank = override === undefined ? 0 : (MODE_RANK[override] ?? 0);
    if (overrideRank > rank) rank = overrideRank;
  }
  return rank > 0;
}

/** `GetIndividualUserRepoPermission`'s core read gate (repo_permission.go:
 * 426-491) — see the module header for the two folded arms. */
async function canReadIndividually(
  d1: D1Database,
  repo: Pick<RepositoryRow, "id" | "ownerId" | "visibility">,
  user: UserRow,
): Promise<boolean> {
  if (user.isAdmin) return true;
  if (repo.ownerId !== null && user.id === repo.ownerId) return true;
  if (repo.visibility === "public") return true;
  const collaborator = await drizzle(d1)
    .select({ mode: repoCollaborators.mode })
    .from(repoCollaborators)
    .where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.userId, user.id)))
    .get();
  return collaborator !== undefined;
}

export interface ResolveIssueMentionsInput {
  repo: Pick<RepositoryRow, "id" | "ownerId" | "visibility">;
  isPull: boolean;
  doer: UserRow;
  /** The parser's raw names, WITHOUT the @ prefix (findAllMentionsMarkdown). */
  mentions: string[];
}

/**
 * `ResolveIssueMentionsByVisibility` (issue_update.go:575-696) — the
 * survivor list in upstream's append order: team-expanded users first (the
 * team arm appends while teams resolve), then the individually-checked
 * survivors.
 */
export async function resolveIssueMentionsByVisibility(d1: D1Database, input: ResolveIssueMentionsInput): Promise<UserRow[]> {
  if (input.mentions.length === 0) return [];
  const db = drizzle(d1);

  const resolved = new Map<string, boolean>();
  // Team-user accumulation mirrors upstream's `users` slice (nil until the
  // team arm fills it — issue_update.go:644-652).
  let teamUsers: UserRow[] | null = null;

  // =========== Classify (issue_update.go:583-611) ===========
  // The repo owner row decides both the team-branch gate and the org skip.
  const owner = input.repo.ownerId === null ? undefined : await db.select().from(users).where(eq(users.id, input.repo.ownerId)).get();
  const repoOwnerIsOrg = owner !== undefined && owner.type === "org";
  const mentionTeams: string[] = [];

  resolved.set(input.doer.usernameLower, true);
  for (const name of input.mentions) {
    const lower = name.toLowerCase();
    if (resolved.has(lower)) continue;
    if (owner !== undefined && owner.type === "org" && lower.includes("/")) {
      const names = lower.split("/");
      if (names.length < 2 || names[0] !== owner.usernameLower) continue;
      mentionTeams.push(names[1]!);
      resolved.set(lower, true);
    } else {
      resolved.set(lower, false);
    }
  }

  // =========== Team expansion (issue_update.go:613-655) ===========
  if (repoOwnerIsOrg && mentionTeams.length > 0 && owner !== undefined) {
    // The team_repo join on THIS repo (issue_update.go:615-619) — our
    // materialized `team_repo_access` rows; includes-All teams read through
    // the same materialization (the schema's documented fan-out posture).
    const teamRows = await db
      .select({
        id: teams.id,
        lowerName: teams.lowerName,
        authorize: teams.authorize,
        unitsMap: teams.unitsMap,
      })
      .from(teams)
      .innerJoin(teamRepoAccess, eq(teamRepoAccess.teamId, teams.id))
      .where(and(eq(teams.orgId, owner.id), eq(teamRepoAccess.repoId, input.repo.id), inArray(teams.lowerName, mentionTeams)))
      .all();

    // The unit gate: TypeIssues for issues, TypePullRequests for pulls
    // (issue_update.go:624-627) — upstream's unit names (org_team.go:34).
    const unitKey = input.isPull ? "repo.pulls" : "repo.issues";
    const checked = teamRows.filter((team) => teamUnitEnabled(team.authorize, team.unitsMap, unitKey));
    for (const team of checked) {
      resolved.set(`${owner.usernameLower}/${team.lowerName}`, true);
    }

    if (checked.length > 0) {
      const teamUserRows = await db
        .select({ user: users })
        .from(users)
        .innerJoin(teamMembers, eq(teamMembers.userId, users.id))
        .where(and(inArray(teamMembers.teamId, checked.map((team) => team.id)), eq(users.status, "active")))
        .all();
      if (teamUserRows.length > 0) {
        teamUsers = [];
        for (const { user } of teamUserRows) {
          if (resolved.get(user.usernameLower) === true) continue;
          teamUsers.push(user);
          resolved.set(user.usernameLower, true);
        }
      }
    }
  }

  // =========== Individual survivors (issue_update.go:657-693) ===========
  const mentionUsers = [...resolved.entries()].filter(([, already]) => !already).map(([name]) => name);
  if (mentionUsers.length === 0) return teamUsers ?? [];

  const unchecked = await db
    .select()
    .from(users)
    .where(and(inArray(users.usernameLower, mentionUsers), eq(users.status, "active")))
    .all();
  const individuals: UserRow[] = [];
  for (const user of unchecked) {
    if (resolved.get(user.usernameLower) === true) continue;
    if (user.type === "org") continue;
    if (!(await canReadIndividually(d1, input.repo, user))) continue;
    individuals.push(user);
  }

  return [...(teamUsers ?? []), ...individuals];
}

import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { orgMembers, repositories, teamMembers, teamRepoAccess, teams, users, type TeamAccessMode } from "../../db/schema";
import { LastOrgOwnerError } from "../../services/orgs/errors";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { scrubTeamFromOrgRules } from "../../services/branch-protection";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { teamSchema, type Team } from "../models/team";
import { repositoryListSchema, repositorySchema } from "../models/repository";
import { userSchema, userListSchema } from "../models/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { BLOCKED_USER_MESSAGE, isUserBlockedBy } from "../services/blocks";
import { orgDoerOf, orgVisibleToDoer, toApiOrganization } from "../services/org-repos";
import { requireOrgMembership, requireOrgOwnership, resolveOrgForRequest, type OrgProfileDoer } from "../services/orgs";
import { isRepositoryAdmin, requireRepoAdmin, requireVisibleRepo } from "../services/repo-access";
import {
  findUserByName,
  toApiRepository,
  viewerOf,
  type RepositoryWithOwner,
  type Viewer,
} from "../services/repository";
import { toApiUser } from "../services/user";

/**
 * The org teams family (SPEC-0007 §3.5 — the deferred core landed; upstream
 * `routers/api/v1/org/team.go` + `routers/api/v1/repo/teams.go` over the
 * `models/organization/{team,team_user,team_repo}.go` join model). All TWENTY
 * contract-declared team ops in one module:
 *
 *   org CRUD          GET/POST /orgs/{org}/teams (orgListTeams/orgCreateTeam),
 *                     GET /orgs/{org}/teams/search (teamSearch),
 *                     GET/PATCH/DELETE /teams/{id} (orgGetTeam/orgEditTeam/
 *                     orgDeleteTeam)
 *   membership        GET /teams/{id}/members[/{username}] (orgListTeamMembers/
 *                     orgListTeamMember), PUT/DELETE …/{username}
 *                     (orgAddTeamMember/orgRemoveTeamMember), GET /user/teams
 *                     (userListTeams)
 *   repo access       GET /teams/{id}/repos[/{org}/{repo}]
 *                     (orgListTeamRepos/orgListTeamRepo), PUT/DELETE …
 *                     (orgAddTeamRepository/orgRemoveTeamRepository),
 *                     GET /repos/{owner}/{repo}/teams[/{team}]
 *                     (repoListTeams/repoCheckTeam), PUT/DELETE …/{team}
 *                     (repoAddTeam/repoDeleteTeam)
 *   feeds             GET /teams/{id}/activities/feeds
 *                     (orgListTeamActivityFeeds — honest-empty, no activity
 *                     model exists; cf. the misc-t3 empty-storage precedent)
 *
 * Ownership bridge (SPEC-0007 §3.3/§3.5 + open question 6): `org_members.role`
 * REMAINS the Owners-team representation — no owners team row is created for
 * any org (a DDL migration cannot backfill D1 rows) and `createTeam` answers
 * a create of `owners` with the upstream duplicate-422, because the org's
 * Owners team *is* the role row. Consequence: `team.IsOwnerTeam()` is always
 * false in this model and every team behaves as a non-owner team (upstream's
 * owner-team guards in the EditTeam handler are dead code here).
 *
 * Auth wiring mirrors api.go verbatim (reduced to the landed token middleware):
 *   - /orgs/{org}/teams group: reqToken + reqOrgMembership (api.go:1750–1753);
 *     create adds reqOrgOwnership (api.go:1752)
 *   - /teams/{teamid} group: reqToken (api.go:1802); reads under
 *     reqTeamReadAccess (api.go:1801), member/repo writes add
 *     reqOrgOwnership (api.go:1804–1805) / reqTeamMembership (1809–1810)
 *   - /repos/{owner}/{repo}/teams: reads reqAnyRepoReader (anonymous-capable
 *     on visible repos — optionalAuth), writes reqAdmin (api.go:1305–1307)
 *   - /user/teams: reqToken (api.go:1195)
 *
 * Declared responses mirror the vendored contract exactly. Runtime-only codes
 * the handlers can still emit (orchestrator-owned RUNTIME_ONLY_RESPONSES
 * table, same class as the /user 401 entry):
 *   - every requireAuth route:  401 (reqToken upstream, api.go:1802/1195/1750)
 *   - org-group routes:         307 renamed-org redirect (orgAssignment →
 *                               RedirectToUser; the landed routes/orgs.ts
 *                               precedent)
 *   - orgCreateTeam:            400 out-of-enum permission/visibility dies in
 *                               the request validator (upstream binding 422s)
 *   - orgEditTeam:              500 rename collision — upstream maps EVERY
 *                               UpdateTeam error through APIErrorInternal
 *                               (team.go:311–314), including
 *                               ErrTeamAlreadyExist; mirrored as a bare Error
 *   - orgCreateTeam/orgEditTeam 422: assignTeamPermissionUnits failures
 *                               ("no permission specified" /
 *                               "only one of units or units_map can be set",
 *                               team.go:156–186 → APIErrorAuto 422)
 *   - orgAddTeamMember:         403 blocked-user (user_model.ErrBlockedUser,
 *                               team.go:469–471) is LIVE — the user-blocks
 *                               model landed; the arm is wired at the
 *                               handler (the blocks-enforcement sweep)
 *
 * Enforced-in-this-module repo-access slice (the teams half of
 * GetDoerRepoPermission, models/perm/access/repo_permission.go): the
 * /teams/{id}/repos reads below honor team grants (explicit `team_repo_access`
 * rows OR `includes_all_repositories` coverage) when deciding whether the
 * doer may see a private repo — the same predicate the gate-level integration
 * needs (services/repository.ts canViewRepository/repositoryPermissions +
 * git-HTTP + push-create + deleteRepository cascade cleanup) — which is
 * OUTSIDE this module's ownership and reported to the orchestrator.
 *
 * Documented deviations (also in src/db/schema.ts): `authorize` is a TEXT
 * enum (upstream INTEGER `authorize`); unit overrides collapse onto
 * `teams.units_map` JSON (upstream `team_unit` table — no unit ACL exists to
 * enforce); `includes_all_repositories` fan-out is UNION-on-read (upstream
 * materializes `team_repo` rows at create/edit — org repos created later are
 * not materialized because the org-repo create path is not this module's
 * file); no `users.num_teams` counter (users table is frozen — nothing in
 * the API surface reads it); site-admin bypasses ride the landed guard
 * modules.
 */

// ---------------------------------------------------------------------------
// Request bodies — mirrors of the contract's CreateTeamOption/EditTeamOption
// (models/team.ts is the landed Team mirror; the option mirrors live here
// with the routes that bind them). Go binding tags (name Required,
// description MaxSize(255)) are not zod rejections — same policy as
// models/organization.ts: the validator failure is a runtime-only 400 where
// upstream binding 422s; the service raises the contract-declared 422s.
// ---------------------------------------------------------------------------

const teamOptionShape = {
  can_create_org_repo: z
    .boolean()
    .optional()
    .openapi({ description: "Whether the team can create repositories in the organization" }),
  description: z.string().optional().openapi({ description: "The description of the team" }),
  includes_all_repositories: z
    .boolean()
    .optional()
    .openapi({ description: "Whether the team has access to all repositories in the organization" }),
  name: z.string().optional().openapi({ description: "The name of the team" }),
  permission: z
    .enum(["read", "write", "admin"])
    .optional()
    .openapi({ description: "The permission of the team (read, write, admin)" }),
  units: z.array(z.string()).optional().openapi({
    description:
      "List of the unit types the team grants access to (empty = the permission applies to all units)",
  }),
  units_map: z.record(z.string(), z.string()).optional().openapi({
    description: "Per-unit permission overrides, keyed by unit type",
  }),
  visibility: z
    .enum(["public", "limited", "private"])
    .optional()
    .openapi({ description: "Team visibility within the organization (public, limited, private)" }),
} as const;

export const createTeamOptionSchema = z.object({
  ...teamOptionShape,
  name: z.string().openapi({ description: "The name of the team" }),
});
export type CreateTeamOption = z.infer<typeof createTeamOptionSchema>;

export const editTeamOptionSchema = z.object(teamOptionShape);
export type EditTeamOption = z.infer<typeof editTeamOptionSchema>;

/** `#/responses/TeamList`. */
const teamListSchema = z.array(teamSchema);

/** teamSearch's inline `ok`/`data` envelope (org/team.go:781–794). */
const teamSearchResponseSchema = z.object({ ok: z.boolean(), data: teamListSchema });

/**
 * Minimal `Activity` mirror for the feeds response — declared because the
 * contract declares the shape; the handler always answers the EMPTY array
 * (no activity model exists), so the embedding-heavy fields (repo, comment)
 * are never rendered.
 */
const activityFeedSchema = z.object({
  act_user_id: z.number().int().optional().openapi({ format: "int64" }),
  act_user: userSchema.optional(),
  content: z.string().optional().openapi({ description: "name of tag, branch or commit" }),
  created: z.string().optional().openapi({ format: "date-time" }),
  comment_id: z.number().int().optional().openapi({ format: "int64" }),
  id: z.number().int().optional().openapi({ format: "int64" }),
  is_private: z.boolean().optional(),
  op_type: z.string().optional(),
  ref_name: z.string().optional(),
  repo_id: z.number().int().optional().openapi({ format: "int64" }),
  repo: repositorySchema.optional(),
  user_id: z.number().int().optional().openapi({ format: "int64" }),
});
const activityFeedListSchema = z.array(activityFeedSchema);

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;
const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;
const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

/** Shared 404 (APIErrorNotFound upstream — missing org/user/team/repo). */
function notFound(): ApiError {
  return new ApiError(404, "not found");
}

/** The renamed-org 307 (orgAssignment → RedirectToUser; routes/orgs.ts seam). */
function renamedOrgRedirect(location: string): HTTPException {
  return new HTTPException(307, {
    res: new Response(null, { status: 307, headers: { Location: location } }),
  });
}

/** Path `id` parse — upstream `ctx.PathParamInt64` (non-numeric → 0 → miss). */
function intPathParam(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : -1;
}

// ---------------------------------------------------------------------------
// Team service half — the port of services/org/team.go +
// services/repository/repo_team.go over the three 0015 tables. Co-located
// with the routes (the wave's file ownership is routes/org-teams.ts only);
// the labels-t2 split (api/services/<family>.ts) is the natural follow-up at
// registration review.
// ---------------------------------------------------------------------------

/** `teams` row as selected (src/db/schema.ts). */
export type TeamRecord = typeof teams.$inferSelect;

/** NewTeam's typed 422s (services/org/team.go:43–70) — the route maps them. */
export class TeamNameEmptyError extends Error {
  constructor() {
    super("empty team name");
  }
}
export class TeamAlreadyExistsError extends Error {
  constructor(orgId: number, lowerName: string) {
    // ErrTeamAlreadyExist.Error() (models/organization/team.go:43–45)
    super(`team already exists [org_id: ${orgId}, name: ${lowerName}]`);
  }
}
/** assignTeamPermissionUnits' InvalidArgument 422s (team.go:156–186). */
export class TeamUnitsConflictError extends Error {
  constructor() {
    super("only one of units or units_map can be set");
  }
}
export class TeamPermissionMissingError extends Error {
  constructor() {
    super("no permission specified");
  }
}

/** D1 unique-violation probe (the services/orgs/orgs.ts cause-walk). */
function isUniqueViolation(error: unknown): boolean {
  let text = error instanceof Error ? error.message : String(error);
  let cause: unknown = error;
  while (cause instanceof Error && cause.cause !== undefined) {
    cause = cause.cause;
    text += ` ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return text.includes("UNIQUE constraint failed");
}

/** Upstream `ParseAccessMode` (perm/access_mode.go:46–62): unknown → 'none'. */
function parseAccessMode(permission: string): TeamAccessMode {
  return permission === "read" || permission === "write" || permission === "admin" || permission === "none"
    ? permission
    : "none";
}

/**
 * `assignTeamPermissionUnits` (routers/api/v1/org/team.go:156–186): resolve
 * the request's permission/units/units_map triple into the row's `authorize`
 * + `units_map`. Units given → authorize 'none' with the map stored (upstream
 * stores team_unit rows and zeroes authorize); plain permission → the enum
 * value with no map; neither → the "no permission specified" 422. The cf-gitea
 * unit handling is the documented collapse (see schema.ts `teams.unitsMap`).
 */
export function assignTeamPermission(
  permission: string | undefined,
  units: Array<string> | undefined,
  unitsMap: Record<string, string> | undefined,
): { authorize: TeamAccessMode; unitsMapJson: string | null } {
  const hasUnits = (units?.length ?? 0) > 0;
  const hasMap = unitsMap !== undefined && Object.keys(unitsMap).length > 0;
  if (hasUnits && hasMap) throw new TeamUnitsConflictError();
  let effectiveMap: Record<string, string> | undefined = unitsMap;
  if (hasUnits) {
    // units[] expands to the map at the request's blanket permission.
    const p = parseAccessMode(permission ?? "");
    effectiveMap = Object.fromEntries((units as Array<string>).map((unit) => [unit, p]));
  }
  if (effectiveMap !== undefined && Object.keys(effectiveMap).length > 0) {
    const normalized = Object.fromEntries(
      Object.entries(effectiveMap).map(([unit, mode]) => [unit, parseAccessMode(mode)]),
    );
    return { authorize: "none", unitsMapJson: JSON.stringify(normalized) };
  }
  const requested = parseAccessMode(permission ?? "");
  if (requested === "none") throw new TeamPermissionMissingError();
  return { authorize: requested, unitsMapJson: null };
}

/** `VisibleTeamVisibilitiesFor` (models/organization/team_list.go:101–110). */
function visibleTeamVisibilities(isOrgMember: boolean, isSignedIn: boolean): Array<"public" | "limited" | "private"> {
  if (isOrgMember) return ["limited", "public"];
  if (isSignedIn) return ["public"];
  return [];
}

export interface TeamListOptions {
  orgId?: number;
  /** The viewer's id — with `includeVisibilities`, own teams UNION the
   * visibility ladder (SearchTeamOptions.applyToSession,
   * team_list.go:83–89); without, own teams only (userListTeams,
   * team_list.go:90–93). */
  userId?: number;
  includeVisibilities?: Array<"public" | "limited" | "private">;
  keyword?: string;
  includeDesc?: boolean;
  page?: number;
  pageSize?: number;
}

export class TeamsService {
  private readonly db: DrizzleD1Database;
  /** The raw binding — the SPEC-0013 M4 scrub primitive takes D1Database. */
  private readonly d1: D1Database;
  private readonly orgs: OrgService;

  constructor(d1: D1Database) {
    this.d1 = d1;
    this.db = drizzle(d1);
    this.orgs = new OrgService(d1);
  }

  get orgService(): OrgService {
    return this.orgs;
  }

  /** `GetTeamByID` (models/organization/team.go:264–274). */
  async getTeamById(id: number): Promise<TeamRecord | null> {
    const row = await this.db.select().from(teams).where(eq(teams.id, id)).get();
    return row ?? null;
  }

  /** `GetTeam` by (org_id, lower_name) — case-insensitive (team.go:232–240). */
  async getTeamByName(orgId: number, name: string): Promise<TeamRecord | null> {
    const row = await this.db
      .select()
      .from(teams)
      .where(and(eq(teams.orgId, orgId), eq(teams.lowerName, name.toLowerCase())))
      .get();
    return row ?? null;
  }

  /** `IsTeamMember` (team_user.go:26–33) — row exists. */
  async isTeamMember(teamId: number, userId: number): Promise<boolean> {
    const row = await this.db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .get();
    return row !== undefined;
  }

  /**
   * `NewTeam` (services/org/team.go:43–105): validate, arbiter the (org,
   * lower_name) uniqueness on the constraint (upstream checks in-tx), then
   * ONE batch — team row + the includes-all fan-out (upstream
   * AddAllRepositoriesToTeam, repo_team.go:72–100, materialized here for
   * repos existing at create; repos created later are covered by the
   * read-side union instead). Deviations: `owners` is answered with the
   * duplicate-422 (the §3.3 role bridge IS the Owners team); the reserved
   * name `new` (IsUsableTeamName, team.go:222–229) propagates as a bare
   * error — upstream maps it through APIErrorInternal → 500 (team.go:229–235).
   */
  async createTeam(org: OrgRecord, input: CreateTeamOption): Promise<TeamRecord> {
    const name = input.name ?? "";
    if (name.length === 0) throw new TeamNameEmptyError();
    const lower = name.toLowerCase();
    if (lower === "owners") throw new TeamAlreadyExistsError(org.id, lower);
    if (lower === "new") throw new Error(`team name is reserved [name: ${lower}]`);
    const { authorize, unitsMapJson } = assignTeamPermission(input.permission, input.units, input.units_map);

    const includesAll = input.includes_all_repositories === true;
    const orgRepoIds = includesAll
      ? (
          await this.db
            .select({ id: repositories.id })
            .from(repositories)
            .where(eq(repositories.ownerId, org.id))
            .all()
        ).map((row) => row.id)
      : [];
    const teamIdExpr = sql`(select id from teams where org_id = ${org.id} and lower_name = ${lower})`;
    try {
      await this.db.batch([
        this.db.insert(teams).values({
          orgId: org.id,
          lowerName: lower,
          name,
          description: input.description ?? "",
          authorize,
          includesAllRepositories: includesAll,
          canCreateOrgRepo: input.can_create_org_repo === true,
          numRepos: orgRepoIds.length,
          numMembers: 0,
          // NormalizeTeamVisibility default (team.go:126–129): absent input
          // lands on 'private'; the zod enum keeps present values honest.
          visibility: input.visibility ?? "private",
          unitsMap: unitsMapJson,
        }),
        ...(orgRepoIds.length > 0
          ? [
              this.db.insert(teamRepoAccess).values(
                orgRepoIds.map((repoId) => ({
                  orgId: org.id,
                  teamId: teamIdExpr,
                  repoId,
                })),
              ),
            ]
          : []),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new TeamAlreadyExistsError(org.id, lower);
      throw error;
    }
    const team = await this.getTeamByName(org.id, name);
    if (team === null) throw new Error(`team lost after create [org_id: ${org.id}, name: ${lower}]`);
    return team;
  }

  /**
   * `EditTeam` handler body + `UpdateTeam` (team.go:246–322, 108–187):
   * apply only the fields the body presents (Go pointers), truncate the
   * description at 255 (team.go:113–115), recompute lower_name on rename and
   * let the UNIQUE arbiter answer a collision as a bare error — upstream
   * maps every UpdateTeam error through APIErrorInternal (team.go:311–314).
   * Permission/units changes ride `assignTeamPermission` (the hasPermFields
   * branch, team.go:296–304); the owner-team guards are dead code here
   * (bridge — no team is the owners team). The includes-all flag needs no
   * fan-out: coverage is unioned on read (module header).
   */
  async editTeam(team: TeamRecord, form: EditTeamOption): Promise<TeamRecord> {
    const patch: Partial<typeof teams.$inferInsert> = {};
    let lower = team.lowerName;
    if (form.name !== undefined && form.name.length > 0) {
      lower = form.name.toLowerCase();
      patch.name = form.name;
      patch.lowerName = lower;
    }
    if (form.description !== undefined) {
      patch.description = form.description.length > 255 ? form.description.slice(0, 255) : form.description;
    }
    if (form.visibility !== undefined) {
      patch.visibility = form.visibility;
    }
    if (form.can_create_org_repo !== undefined) {
      patch.canCreateOrgRepo = form.can_create_org_repo;
    }
    const hasPermFields =
      (form.permission?.length ?? 0) > 0 || (form.units?.length ?? 0) > 0 || (form.units_map !== undefined && Object.keys(form.units_map).length > 0);
    if (hasPermFields) {
      const parsed = assignTeamPermission(form.permission, form.units, form.units_map);
      patch.authorize = parsed.authorize;
      patch.unitsMap = parsed.unitsMapJson;
    }
    if (Object.keys(patch).length > 0) {
      try {
        await this.db.update(teams).set(patch).where(eq(teams.id, team.id));
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Upstream: ErrTeamAlreadyExist inside UpdateTeam → APIErrorInternal
          // (team.go:311–314) — a blanked 500, NOT the create path's 422.
          throw new Error(`team rename failed [org_id: ${team.orgId}, name: ${lower}]`, { cause: error });
        }
        throw error;
      }
    }
    return (await this.getTeamById(team.id)) ?? team;
  }

  /**
   * `DeleteTeam` (services/org/team.go:191–243): the team row's cascades
   * remove its member and repo-access rows, then each member left with no
   * other team in the org loses the ORG membership too
   * (`removeInvalidOrgUser` → `RemoveOrgUser`, team.go:366–382). Upstream
   * runs the whole delete in ONE transaction, so a refused membership
   * removal (`ErrLastOrgOwner`, the §4.3 blanked 500) rolls EVERYTHING back.
   * Ported as: the last-owner pre-check first (nothing deleted when it
   * fires), then the branch-protection scrub + ONE batch — team delete +
   * the guarded membership deletes (the `removeMember` guard SQL, orgs.ts) +
   * the member-counter decrements.
   *
   * The branch-protection scrub (SPEC-0013 M4) ports upstream's
   * "update branch protections" block (team.go:191–210, inside the tx BEFORE
   * the team row goes): the team id is stripped from every allowlist column
   * of every rule on the org's repos; running it before the batch keeps the
   * rollback shape (a failed scrub deletes nothing). Still-unmodeled upstream
   * cleanups: `team_invite` (no table), and the review-request rows —
   * upstream deletes Review{Type: Request, ReviewerTeamID: t.ID} in its
   * DeleteBeans (team.go:218–223) while our pull_reviews.reviewerTeamId rows
   * survive the delete (the reviews family's gap, not this module's).
   */
  async deleteTeam(team: TeamRecord): Promise<void> {
    const memberIds = (
      await this.db.select({ userId: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, team.id)).all()
    ).map((row) => row.userId);
    for (const userId of memberIds) {
      if (await this.removalLeavesOrgOwnerless(team.orgId, userId, team.id)) {
        // removeInvalidOrgUser → RemoveOrgUser → ErrLastOrgOwner — the whole
        // upstream tx rolls back; nothing is deleted here either.
        throw new LastOrgOwnerError(userId);
      }
    }
    // Branch-protection scrub (SPEC-0013 M4, team.go:191-210) — see above.
    await scrubTeamFromOrgRules(this.d1, team.orgId, team.id);
    const statements: BatchItem<"sqlite">[] = [
      // The batch is sequential: the team_members rows for this team are
      // already gone when the guards below evaluate.
      this.db.delete(teams).where(eq(teams.id, team.id)),
    ];
    for (const userId of memberIds) {
      statements.push(
        this.db
          .delete(orgMembers)
          .where(
            and(
              eq(orgMembers.orgId, team.orgId),
              eq(orgMembers.userId, userId),
              sql`(role != 'owner' or (select count(*) from org_members where org_id = ${team.orgId} and role = 'owner') > 1)`,
              sql`(select count(*) from team_members where org_id = ${team.orgId} and user_id = ${userId}) = 0`,
            ),
          )
          .returning({ userId: orgMembers.userId }),
        this.db
          .update(users)
          .set({ numMembers: sql`${users.numMembers} - 1` })
          .where(
            and(
              eq(users.id, team.orgId),
              sql`(select count(*) from org_members where org_id = ${team.orgId} and user_id = ${userId}) = 0`,
            ),
          ),
      );
    }
    // The leading team delete is unconditional, so the batch is never empty;
    // the tuple cast satisfies drizzle's non-empty batch signature.
    await this.db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }

  /**
   * The §4.3 pre-check shared by the membership removals: would removing the
   * user from this team drop their LAST org membership while they are the
   * org's only owner? Upstream raises ErrLastOrgOwner from inside the
   * transaction (services/org/user.go:36–52 via team.go:366–382); the
   * pre-check keeps the nothing-deleted rollback shape on D1.
   */
  private async removalLeavesOrgOwnerless(orgId: number, userId: number, leavingTeamId: number): Promise<boolean> {
    const remainingTeam = await this.db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(eq(teamMembers.orgId, orgId), eq(teamMembers.userId, userId), ne(teamMembers.teamId, leavingTeamId)),
      )
      .get();
    if (remainingTeam !== undefined) return false; // stays a member via another team
    const membership = await this.orgs.getMembership(orgId, userId);
    if (membership === null || membership.role !== "owner") return false;
    const owners = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "owner")))
      .get();
    return (owners?.total ?? 0) <= 1;
  }

  /**
   * `AddTeamMember` (services/org/team.go:247–310): already a member →
   * silent no-op; else ensure the ORG membership first (`AddOrgUser` — the
   * "user will have membership to given organization automatically"), then
   * the team row + counter in one batch. The blocked-user 403
   * (team.go:248–250, 469–471) is wired at the route handler above (the
   * blocks-enforcement sweep) — the service keeps its test-fixture
   * signature.
   */
  async addTeamMember(team: TeamRecord, userId: number): Promise<void> {
    if (await this.isTeamMember(team.id, userId)) return;
    await this.orgs.addMember(team.orgId, userId); // idempotent (false = already)
    try {
      await this.db.batch([
        this.db.insert(teamMembers).values({ orgId: team.orgId, teamId: team.id, userId }),
        this.db
          .update(teams)
          .set({ numMembers: sql`${teams.numMembers} + 1` })
          .where(eq(teams.id, team.id)),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) return; // concurrent add — upstream's in-tx re-check
      throw error;
    }
  }

  /**
   * `RemoveTeamMember` (services/org/team.go:312–364): non-member no-op;
   * delete + guarded counter decrement in one batch; then the
   * `removeInvalidOrgUser` scan — a member of no remaining team loses the org
   * membership (the guarded delete + counter pair in the same batch). The
   * §4.3 last-owner 500 fires from the pre-check BEFORE anything is deleted
   * (upstream's tx rollback shape — see `removalLeavesOrgOwnerless`).
   */
  async removeTeamMember(team: TeamRecord, userId: number): Promise<void> {
    if (!(await this.isTeamMember(team.id, userId))) return;
    if (await this.removalLeavesOrgOwnerless(team.orgId, userId, team.id)) {
      throw new LastOrgOwnerError(userId);
    }
    await this.db.batch([
      this.db
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId)))
        .returning({ userId: teamMembers.userId }),
      this.db
        .update(teams)
        .set({ numMembers: sql`${teams.numMembers} - 1` })
        .where(
          and(
            eq(teams.id, team.id),
            sql`(select count(*) from team_members where team_id = ${team.id} and user_id = ${userId}) = 0`,
          ),
        ),
      this.db
        .delete(orgMembers)
        .where(
          and(
            eq(orgMembers.orgId, team.orgId),
            eq(orgMembers.userId, userId),
            sql`(role != 'owner' or (select count(*) from org_members where org_id = ${team.orgId} and role = 'owner') > 1)`,
            sql`(select count(*) from team_members where org_id = ${team.orgId} and user_id = ${userId}) = 0`,
          ),
        )
        .returning({ userId: orgMembers.userId }),
      this.db
        .update(users)
        .set({ numMembers: sql`${users.numMembers} - 1` })
        .where(
          and(
            eq(users.id, team.orgId),
            sql`(select count(*) from org_members where org_id = ${team.orgId} and user_id = ${userId}) = 0`,
          ),
        ),
    ]);
  }

  /**
   * `SearchTeam` (models/organization/team_list.go:57–142): org/keyword/
   * member-or-visibility filters, ordered Owners-first-then-lower_name (the
   * CASE is the faithful port; no owners rows exist under the bridge).
   */
  async listTeams(options: TeamListOptions): Promise<{ items: TeamRecord[]; total: number }> {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.min(50, Math.max(1, Math.floor(options.pageSize ?? 30)));
    const conds: SQL[] = [];
    if (options.orgId !== undefined) conds.push(eq(teams.orgId, options.orgId));
    const keyword = options.keyword?.toLowerCase() ?? "";
    if (keyword.length > 0) {
      // NOT LIKE: D1 caps LIKE patterns at 50 bytes, so a long keyword threw
      // D1_ERROR and the route answered a plain 500. The substring goes
      // through instr() instead — the documented user-search precedent
      // (services/user.ts:192-211, the org-members 943e1e9 shape). The needle
      // pre-lowers for the case-insensitive pair (lowerName is stored
      // lowercase; description lower()s in SQL, exactly what the LIKE
      // wrapped).
      const keywordConds: SQL[] = [sql`instr(${teams.lowerName}, ${keyword}) > 0`];
      if (options.includeDesc !== false) {
        keywordConds.push(sql`instr(lower(${teams.description}), ${keyword}) > 0`);
      }
      conds.push(or(...keywordConds) as SQL);
    }
    const ownTeamIds =
      options.userId === undefined
        ? undefined
        : this.db.select({ id: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, options.userId));
    if (ownTeamIds !== undefined && (options.includeVisibilities?.length ?? 0) > 0) {
      // LEFT-join shape (team_list.go:83–89): own teams UNION the ladder.
      conds.push(
        or(
          inArray(teams.id, ownTeamIds),
          inArray(teams.visibility, options.includeVisibilities as Array<"public" | "limited" | "private">),
        ) as SQL,
      );
    } else if (ownTeamIds !== undefined) {
      // INNER-join shape (userListTeams): own teams only.
      conds.push(inArray(teams.id, ownTeamIds));
    } else if ((options.includeVisibilities?.length ?? 0) > 0) {
      conds.push(inArray(teams.visibility, options.includeVisibilities as Array<"public" | "limited" | "private">));
    }
    const where = conds.length > 0 ? and(...conds) : undefined;
    const rows = await this.db
      .select()
      .from(teams)
      .where(where)
      .orderBy(sql`CASE WHEN ${teams.name} = 'Owners' THEN '' ELSE ${teams.lowerName} END`)
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const totalRow = await this.db.select({ total: sql<number>`count(*)` }).from(teams).where(where).get();
    return { items: rows, total: totalRow?.total ?? 0 };
  }

  /**
   * `GetTeamMembers` (team_user.go:41–58): users joined through the team,
   * ordered `full_name, name` — `display_name, username` here.
   */
  async listTeamMemberRows(
    teamId: number,
    options: { page?: number; pageSize?: number },
  ): Promise<{ items: Array<typeof users.$inferSelect>; total: number }> {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.min(50, Math.max(1, Math.floor(options.pageSize ?? 30)));
    const rows = await this.db
      .select({ user: users })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(asc(users.displayName), asc(users.username))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items: rows.map((row) => row.user), total: rows.length };
  }

  /**
   * The team's covered repositories, as `{repo, owner}` pairs for the
   * Repository projection: explicit `team_repo_access` rows UNION the
   * includes-all coverage (the read-side union — upstream materializes the
   * same rows at create/edit, repo_team.go:72–100). Ordered by slug.
   */
  async listTeamRepoPairs(
    team: TeamRecord,
    options: { page?: number; pageSize?: number },
  ): Promise<{ items: RepositoryWithOwner[]; total: number }> {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.min(50, Math.max(1, Math.floor(options.pageSize ?? 30)));
    const coverage = team.includesAllRepositories
      ? eq(repositories.ownerId, team.orgId)
      : and(
          eq(repositories.ownerId, team.orgId),
          inArray(
            repositories.id,
            this.db.select({ id: teamRepoAccess.repoId }).from(teamRepoAccess).where(eq(teamRepoAccess.teamId, team.id)),
          ),
        );
    const rows = await this.db
      .select({ repo: repositories, owner: users })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(coverage)
      .orderBy(asc(repositories.slug))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const totalRow = await this.db.select({ total: sql<number>`count(*)` }).from(repositories).where(coverage).get();
    return { items: rows, total: totalRow?.total ?? 0 };
  }

  /** `HasRepository`/`HasTeamRepo` (repo_team.go:253–255) + the union. */
  async hasTeamRepo(team: TeamRecord, repoId: string): Promise<boolean> {
    if (team.includesAllRepositories) return true;
    const row = await this.db
      .select({ id: teamRepoAccess.id })
      .from(teamRepoAccess)
      .where(and(eq(teamRepoAccess.teamId, team.id), eq(teamRepoAccess.repoId, repoId)))
      .get();
    return row !== undefined;
  }

  /**
   * `TeamAddRepository` (repo_team.go:22–38) — silently no-op when covered.
   * An includes-all team is already covered by the union (upstream would
   * materialize a row; the flag makes it redundant here).
   */
  async addTeamRepo(team: TeamRecord, repoId: string): Promise<void> {
    if (team.includesAllRepositories || (await this.hasTeamRepo(team, repoId))) return;
    try {
      await this.db.batch([
        this.db.insert(teamRepoAccess).values({ orgId: team.orgId, teamId: team.id, repoId }),
        this.db
          .update(teams)
          .set({ numRepos: sql`${teams.numRepos} + 1` })
          .where(eq(teams.id, team.id)),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) return; // concurrent add — upstream's HasTeamRepo re-check
      throw error;
    }
  }

  /**
   * `RemoveRepositoryFromTeam` (repo_team.go:180–202): not covered or
   * includes-all → silent no-op (upstream team.go:185–187).
   */
  async removeTeamRepo(team: TeamRecord, repoId: string): Promise<void> {
    if (team.includesAllRepositories) return;
    await this.db.batch([
      this.db
        .delete(teamRepoAccess)
        .where(and(eq(teamRepoAccess.teamId, team.id), eq(teamRepoAccess.repoId, repoId)))
        .returning({ id: teamRepoAccess.id }),
      this.db
        .update(teams)
        .set({ numRepos: sql`${teams.numRepos} - 1` })
        .where(
          and(
            eq(teams.id, team.id),
            sql`(select count(*) from team_repo_access where team_id = ${team.id} and repo_id = ${repoId}) = 0`,
          ),
        ),
    ]);
  }

  /**
   * The repo's owner row within the TEAM's org — `getRepositoryByParams`
   * resolves by (team.OrgID, reponame) and IGNORES the path's {org} segment
   * (routers/api/v1/org/team.go:634–647). Ported verbatim.
   */
  async repoInOrg(orgId: number, slug: string): Promise<RepositoryWithOwner | null> {
    const rows = await this.db
      .select({ repo: repositories, owner: users })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(and(eq(repositories.ownerId, orgId), eq(repositories.slug, slug.toLowerCase())))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * ENFORCEMENT SLICE (module header): whether the user holds ANY effective
   * team grant over the repo in the repo's org — a team they belong to with
   * a non-'none' effective mode (authorize, or any unit override) covering
   * the repo (explicit row or includes-all). DELEGATE: the predicate lives
   * on OrgService (`teamRepoAccessMode` — the shared home every enforcement
   * seam reads: services/repository.ts visibility/permissions + git-HTTP);
   * this wrapper keeps the module's boolean shape. Upstream: the reduced
   * any-unit access arm of `HasAnyUnitAccessOrPublicAccess`
   * (org/team.go:569–577). (Delegate diff landed by the enforcement wave
   * under the orchestrator's extended grant — same query, one home.)
   */
  async doerHasTeamRepoAccess(repo: { id: string; ownerId: number | null }, userId: number): Promise<boolean> {
    return (await this.orgs.teamRepoAccessMode(repo, userId)) !== "none";
  }

  /**
   * `GetRepoTeams` (team_list.go:151–158): teams covering the repo — explicit
   * access rows UNION includes-all teams — Owners first, then name.
   */
  async listRepoTeams(orgId: number | null, repoId: string): Promise<TeamRecord[]> {
    if (orgId === null) return [];
    const rows = await this.db
      .selectDistinct({ team: teams })
      .from(teams)
      .leftJoin(teamRepoAccess, and(eq(teamRepoAccess.teamId, teams.id), eq(teamRepoAccess.repoId, repoId)))
      .where(and(eq(teams.orgId, orgId), or(eq(teamRepoAccess.repoId, repoId), eq(teams.includesAllRepositories, true))))
      .orderBy(sql`CASE WHEN ${teams.name} = 'Owners' THEN '' ELSE ${teams.lowerName} END`);
    return rows.map((row) => row.team);
  }
}

// ---------------------------------------------------------------------------
// Team guards — reqTeamReadAccess / reqTeamMembership / denyNonTeamMember
// (routers/api/v1/api.go:477–552) and CanDoerManageOrgRepoCollaboratorTeam
// (models/perm/access/repo_permission.go:751–757).
// ---------------------------------------------------------------------------

/**
 * `IsOrganizationOwner` under the bridge: the role='owner' membership —
 * `OrgService.isOrgOwner`, NOT the §3.4 create grant (repo creation without
 * ownership, org_user.go:66–77 vs 98–106): every caller here is an
 * ownership-grade arm (team manage/list trims), none a repo-create grant.
 */
async function isOrgOwner(orgs: OrgService, org: OrgRecord, doer: OrgProfileDoer): Promise<boolean> {
  if (doer.id === null) return false;
  return orgs.isOrgOwner(org.id, doer.id);
}

async function isOrgMember(orgs: OrgService, org: OrgRecord, doer: OrgProfileDoer): Promise<boolean> {
  if (doer.id === null) return false;
  return (await orgs.getMembership(org.id, doer.id)) !== null;
}

/** `denyNonTeamMember` (api.go:500–510): org member → 403, else the 404. */
async function denyNonTeamMember(orgs: OrgService, org: OrgRecord, doer: OrgProfileDoer): Promise<never> {
  if (await isOrgMember(orgs, org, doer)) {
    throw new ApiError(403, "Must be a team member");
  }
  throw notFound();
}

/** `teamAccessPrivileged` (api.go:474–496): site admin / org owner / team member. */
async function teamAccessPrivileged(
  service: TeamsService,
  org: OrgRecord,
  team: TeamRecord,
  doer: OrgProfileDoer,
): Promise<boolean> {
  if (doer.isAdmin) return true;
  if (await isOrgOwner(service.orgService, org, doer)) return true;
  if (doer.id === null) return false;
  return service.isTeamMember(team.id, doer.id);
}

/**
 * `reqTeamReadAccess` (api.go:511–537): privileged passes; else the team's
 * visibility tier admits — public needs the org visible
 * (`CanNonMemberReadMeta` public arm → `HasOrgOrUserVisible`), limited needs
 * org membership, private admits nobody outside the privileged set.
 */
async function requireTeamReadAccess(
  service: TeamsService,
  org: OrgRecord,
  team: TeamRecord,
  doer: OrgProfileDoer,
): Promise<void> {
  if (await teamAccessPrivileged(service, org, team, doer)) return;
  let visible: boolean;
  switch (team.visibility) {
    case "public":
      visible = await orgVisibleToDoer(service.orgService, org, doer);
      break;
    case "limited":
      visible = await isOrgMember(service.orgService, org, doer);
      break;
    default:
      visible = false;
  }
  if (!visible) {
    await denyNonTeamMember(service.orgService, org, doer);
  }
}

/** `reqTeamMembership` (api.go:538–552): privileged or the deny. */
async function requireTeamMembership(
  service: TeamsService,
  org: OrgRecord,
  team: TeamRecord,
  doer: OrgProfileDoer,
): Promise<void> {
  if (!(await teamAccessPrivileged(service, org, team, doer))) {
    await denyNonTeamMember(service.orgService, org, doer);
  }
}

/**
 * `CanDoerManageOrgRepoCollaboratorTeam` (repo_permission.go:751–757):
 * repo-permission owner (the org owner / site admin) always; a repo admin
 * (collaborator-admin here) only when the org's
 * `repo_admin_change_team_access` flag is set.
 */
async function canDoerManageOrgRepoTeam(
  c: Context<ApiEnv>,
  service: TeamsService,
  org: OrgRecord,
  doer: OrgProfileDoer,
  found: RepositoryWithOwner,
): Promise<boolean> {
  if (doer.isAdmin) return true;
  if (await isOrgOwner(service.orgService, org, doer)) return true;
  if (!org.repoAdminChangeTeamAccess) return false;
  return isRepositoryAdmin(c, found);
}

// ---------------------------------------------------------------------------
// Response conversion — `ToTeams` (services/convert/convert.go:953–991).
// ---------------------------------------------------------------------------

function toApiTeam(team: TeamRecord, options: { viewer: Viewer; org?: OrgRecord | null }): Team {
  const unitsMap = team.unitsMap === null ? {} : (JSON.parse(team.unitsMap) as Record<string, string>);
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    includes_all_repositories: team.includesAllRepositories,
    can_create_org_repo: team.canCreateOrgRepo,
    permission: team.authorize,
    // Go iterates the map unordered; sorted keys keep cf-gitea deterministic.
    units: Object.keys(unitsMap).sort(),
    units_map: unitsMap,
    visibility: team.visibility,
    organization:
      options.org === undefined || options.org === null
        ? undefined
        : toApiOrganization(options.org, { origin: options.viewer.origin, includeEmail: true }),
  };
}

// ---------------------------------------------------------------------------
// Route declarations — every response set is the vendored contract's verbatim.
// Path ids are z.string() carrying the int64 metadata (the landed labels/
// milestones convention) and parse through intPathParam.
// ---------------------------------------------------------------------------

/** `GET /orgs/{org}/teams` — reqToken + reqOrgMembership group; the listing
 *  filter is `ApplyTeamListFilter` (team_list.go:112–130). */
const orgListTeamsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/teams",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "List an organization's teams",
    operationId: "orgListTeams",
    request: {
      ...listQuery,
      params: z.object({ org: z.string().min(1).openapi({ description: "name of the organization" }) }),
    },
    responses: {
      200: { description: "TeamList", content: { "application/json": { schema: teamListSchema } } },
      404: notFoundResponse,
    },
  });

/** `POST /orgs/{org}/teams` — reqOrgOwnership. */
const orgCreateTeamRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/orgs/{org}/teams",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Create a team",
    operationId: "orgCreateTeam",
    request: {
      params: z.object({ org: z.string().min(1).openapi({ description: "name of the organization" }) }),
      body: { content: { "application/json": { schema: createTeamOptionSchema } } },
    },
    responses: {
      201: { description: "Team", content: { "application/json": { schema: teamSchema } } },
      404: notFoundResponse,
      422: { description: "validationError", content: { "application/json": { schema: apiErrorSchema } } },
    },
  });

/** `GET /orgs/{org}/teams/search` — the ok/data envelope. */
const teamSearchRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/teams/search",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Search for teams within an organization",
    operationId: "teamSearch",
    request: {
      params: z.object({ org: z.string().min(1).openapi({ description: "name of the organization" }) }),
      query: z.object({
        q: z.string().optional().openapi({ type: "string", description: "keywords to search" }),
        include_desc: z
          .string()
          .optional()
          .openapi({ type: "boolean", description: "include search within team description (defaults to true)" }),
        page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
        limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
      }),
    },
    responses: {
      200: {
        description: "SearchResults of a successful search",
        content: { "application/json": { schema: teamSearchResponseSchema } },
      },
      404: notFoundResponse,
    },
  });

const repoTeamParams = {
  params: z.object({
    owner: z.string().min(1).openapi({ description: "owner of the repo" }),
    repo: z.string().min(1).openapi({ description: "name of the repo" }),
    team: z.string().min(1).openapi({ description: "team name" }),
  }),
} as const;

/** `GET /repos/{owner}/{repo}/teams` — reqAnyRepoReader (anonymous-capable). */
const repoListTeamsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/teams",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "List a repository's teams",
    operationId: "repoListTeams",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo" }),
        repo: z.string().min(1).openapi({ description: "name of the repo" }),
      }),
    },
    responses: {
      200: { description: "TeamList", content: { "application/json": { schema: teamListSchema } } },
      404: notFoundResponse,
    },
  });

/** `GET /repos/{owner}/{repo}/teams/{team}` — reqAnyRepoReader; 405 for
 *  user-owned repos (repo/teams.go:92–95). */
const repoCheckTeamRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/teams/{team}",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Check if a team is assigned to a repository",
    operationId: "repoCheckTeam",
    request: repoTeamParams,
    responses: {
      200: { description: "Team", content: { "application/json": { schema: teamSchema } } },
      404: notFoundResponse,
      405: errorResponse,
    },
  });

/** `PUT /repos/{owner}/{repo}/teams/{team}` — reqAdmin + the manage gate. */
const repoAddTeamRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/repos/{owner}/{repo}/teams/{team}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Add a team to a repository",
    operationId: "repoAddTeam",
    request: repoTeamParams,
    responses: {
      204: { description: "empty" },
      403: forbiddenResponse,
      404: notFoundResponse,
      405: errorResponse,
      422: { description: "validationError", content: { "application/json": { schema: apiErrorSchema } } },
    },
  });

/** `DELETE /repos/{owner}/{repo}/teams/{team}` — reqAdmin + the manage gate. */
const repoDeleteTeamRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/teams/{team}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Delete a team from a repository",
    operationId: "repoDeleteTeam",
    request: repoTeamParams,
    responses: {
      204: { description: "empty" },
      403: forbiddenResponse,
      404: notFoundResponse,
      405: errorResponse,
      422: { description: "validationError", content: { "application/json": { schema: apiErrorSchema } } },
    },
  });

const teamIdParams = {
  params: z.object({
    id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the team" }),
  }),
} as const;

/** `GET /teams/{id}` — reqTeamReadAccess; the org embeds (`ToTeam(…, true)`). */
const orgGetTeamRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/teams/{id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Get a team",
    operationId: "orgGetTeam",
    request: teamIdParams,
    responses: {
      200: { description: "Team", content: { "application/json": { schema: teamSchema } } },
      404: notFoundResponse,
    },
  });

/** `DELETE /teams/{id}` — reqOrgOwnership. */
const orgDeleteTeamRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/teams/{id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Delete a team",
    operationId: "orgDeleteTeam",
    request: teamIdParams,
    responses: {
      204: { description: "team deleted" },
      404: notFoundResponse,
    },
  });

/** `PATCH /teams/{id}` — reqOrgOwnership + the EditTeamOption body. */
const orgEditTeamRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/teams/{id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Edit a team",
    operationId: "orgEditTeam",
    request: {
      ...teamIdParams,
      body: { content: { "application/json": { schema: editTeamOptionSchema } } },
    },
    responses: {
      200: { description: "Team", content: { "application/json": { schema: teamSchema } } },
      404: notFoundResponse,
    },
  });

/** `GET /teams/{id}/activities/feeds` — reqTeamReadAccess; honest-empty
 *  (no activity model — the misc-t3 empty-storage precedent). */
const orgListTeamActivityFeedsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/teams/{id}/activities/feeds",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "List a team's activity feeds",
    operationId: "orgListTeamActivityFeeds",
    request: {
      ...teamIdParams,
      query: z.object({
        date: z
          .string()
          .optional()
          .openapi({ type: "string", format: "date", description: "the date of the activities to be found" }),
        page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
        limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
      }),
    },
    responses: {
      200: { description: "ActivityFeedsList", content: { "application/json": { schema: activityFeedListSchema } } },
      404: notFoundResponse,
    },
  });

/** `GET /teams/{id}/members` — reqTeamReadAccess + reqOrgMembership. */
const orgListTeamMembersRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/teams/{id}/members",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "List a team's members",
    operationId: "orgListTeamMembers",
    request: {
      ...teamIdParams,
      ...listQuery,
    },
    responses: {
      200: { description: "UserList", content: { "application/json": { schema: userListSchema } } },
      404: notFoundResponse,
    },
  });

const teamMemberParams = {
  params: z.object({
    id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the team" }),
    username: z
      .string()
      .min(1)
      .openapi({ description: "username of the user to list, add to or remove from the team" }),
  }),
} as const;

/** `GET /teams/{id}/members/{username}` — 404 unless the target is a member. */
const orgListTeamMemberRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/teams/{id}/members/{username}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "List a particular member of team",
    operationId: "orgListTeamMember",
    request: teamMemberParams,
    responses: {
      200: { description: "User", content: { "application/json": { schema: userSchema } } },
      404: notFoundResponse,
    },
  });

/** `PUT /teams/{id}/members/{username}` — reqOrgOwnership. */
const orgAddTeamMemberRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/teams/{id}/members/{username}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Add a team member",
    operationId: "orgAddTeamMember",
    request: teamMemberParams,
    responses: {
      204: { description: "empty" },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

/** `DELETE /teams/{id}/members/{username}` — reqOrgOwnership. */
const orgRemoveTeamMemberRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/teams/{id}/members/{username}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Remove a team member",
    operationId: "orgRemoveTeamMember",
    request: teamMemberParams,
    responses: {
      204: { description: "empty" },
      404: notFoundResponse,
    },
  });

/** `GET /teams/{id}/repos` — reqTeamReadAccess; per-repo visibility trim. */
const orgListTeamReposRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/teams/{id}/repos",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "List a team's repos",
    operationId: "orgListTeamRepos",
    request: {
      ...teamIdParams,
      ...listQuery,
    },
    responses: {
      200: { description: "RepositoryList", content: { "application/json": { schema: repositoryListSchema } } },
      404: notFoundResponse,
    },
  });

const teamRepoParams = {
  params: z.object({
    id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the team" }),
    org: z.string().min(1).openapi({ description: "organization that owns the repo" }),
    repo: z.string().min(1).openapi({ description: "name of the repo" }),
  }),
} as const;

/** `GET /teams/{id}/repos/{org}/{repo}` — reqTeamReadAccess + coverage +
 *  access trim (all misses the shared 404). */
const orgListTeamRepoRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/teams/{id}/repos/{org}/{repo}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "List a particular repo of team",
    operationId: "orgListTeamRepo",
    request: teamRepoParams,
    responses: {
      200: { description: "Repository", content: { "application/json": { schema: repositorySchema } } },
      404: notFoundResponse,
    },
  });

/** `PUT /teams/{id}/repos/{org}/{repo}` — reqTeamMembership + the manage gate. */
const orgAddTeamRepositoryRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/teams/{id}/repos/{org}/{repo}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Add a repository to a team",
    operationId: "orgAddTeamRepository",
    request: teamRepoParams,
    responses: {
      204: { description: "empty" },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

/** `DELETE /teams/{id}/repos/{org}/{repo}` — reqTeamMembership + manage gate. */
const orgRemoveTeamRepositoryRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/teams/{id}/repos/{org}/{repo}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Remove a repository from a team",
    operationId: "orgRemoveTeamRepository",
    request: teamRepoParams,
    responses: {
      204: { description: "empty" },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

/** `GET /user/teams` — reqToken; own teams with the org embedded. */
const userListTeamsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/teams",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List all the teams a user belongs to",
    operationId: "userListTeams",
    request: listQuery,
    responses: {
      200: { description: "TeamList", content: { "application/json": { schema: teamListSchema } } },
    },
  });

// ---------------------------------------------------------------------------
// Registration — handlers. Guards run in handler order (upstream's middleware
// chain flattened; the routes stay thin: resolve → guard → service → project).
// ---------------------------------------------------------------------------

/**
 * The `/orgs/{org}` orgAssignment seam shared by this module's org-scoped
 * routes (resolveOrgForRequest → 307 on renames / the shared 404).
 */
async function resolveOrg(c: Context<ApiEnv>, orgName: string, doer: OrgProfileDoer | null): Promise<OrgRecord> {
  const url = new URL(c.req.url);
  const resolved = await resolveOrgForRequest(
    c.env.DB,
    orgName,
    doer,
    c.req.path,
    url.search.startsWith("?") ? url.search.slice(1) : url.search,
  );
  if (resolved.kind === "redirect") throw renamedOrgRedirect(resolved.location);
  if (resolved.kind === "missing") throw notFound();
  return resolved.org;
}

/** The 405 for user-owned repos (repo/teams.go:41–44, 92–95). */
function assertOrgOwnedRepo(ownerType: string): void {
  if (ownerType !== "org") {
    throw new ApiError(405, "repo is not owned by an organization");
  }
}

/** The ErrTeamNotExist 404 body getTeamByParam answers with (repo/teams.go:233–243). */
function teamNotExistError(orgId: number, name: string): ApiError {
  return new ApiError(404, `team does not exist [org_id ${orgId}, team_id 0, name: ${name}]`);
}

/**
 * Resolve the /teams/{id} context (orgAssignment's assignTeam half, api.go:
 * 645–660): team by id, then its org — either miss the shared 404.
 */
async function resolveTeamContext(service: TeamsService, teamId: number): Promise<{ team: TeamRecord; org: OrgRecord }> {
  const team = await service.getTeamById(teamId);
  if (team === null) throw notFound();
  const org = await service.orgService.getOrgById(team.orgId);
  if (org === null) throw notFound();
  return { team, org };
}

/** The base-visibility half of the trim, shared by both team-repo reads. */
function baseRepoVisible(viewer: Viewer, pair: RepositoryWithOwner): boolean {
  return (
    pair.repo.visibility === "public" ||
    (viewer.requester !== null &&
      (viewer.requester.is_admin === true ||
        (viewer.requester.login ?? "").toLowerCase() === pair.repo.ownerNamespace))
  );
}

export function registerOrgTeamsRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // The typed NewTeam/assignTeamPermissionUnits 422s (team.go:225–235 →
  // APIError 422 for already-exists, APIErrorAuto 422 for the invalid-arg
  // family) — everything else keeps propagating (the APIErrorInternal 500s).
  function mapTeam422(error: unknown): unknown {
    if (
      error instanceof TeamNameEmptyError ||
      error instanceof TeamAlreadyExistsError ||
      error instanceof TeamUnitsConflictError ||
      error instanceof TeamPermissionMissingError
    ) {
      return new ApiError(422, error.message);
    }
    return error;
  }

  /**
   * Upstream reqAdmin for ORG repos (api.go:1306 over the owner-team grant):
   * the landed `requireRepoAdmin` knows only owner-by-name/site-admin/
   * collaborator-admin — an ORG owner's admin grant rides the owners team
   * upstream, so this route-local seam adds the org-owner arm (the same
   * gate-level integration note as the module header; acl.ts is not this
   * module's file).
   */
  async function requireRepoTeamAdmin(
    c: Context<ApiEnv>,
    service: TeamsService,
    org: OrgRecord,
    doer: OrgProfileDoer,
    found: RepositoryWithOwner,
  ): Promise<void> {
    if (doer.id !== null && (await isOrgOwner(service.orgService, org, doer))) return;
    await requireRepoAdmin(c, found);
  }

  app.openapi(orgListTeamsRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const org = await resolveOrg(c, c.req.valid("param").org, doer);
    const service = new TeamsService(c.env.DB);
    // upstream api.go:1750–1753: reqOrgMembership gates the group.
    await requireOrgMembership(service.orgService, org, doer);
    // ApplyTeamListFilter (team_list.go:112–130): admin/org owners return
    // EARLY — no user filter, no visibility ladder (every team); the rest
    // see own teams UNION their visibility ladder.
    let includeVisibilities: Array<"public" | "limited" | "private"> | undefined;
    let userId: number | undefined = doer.id;
    if (doer.isAdmin || (await isOrgOwner(service.orgService, org, doer))) {
      userId = undefined;
    } else {
      includeVisibilities = visibleTeamVisibilities(await isOrgMember(service.orgService, org, doer), true);
    }
    const list = parseListOptions(new URL(c.req.url));
    const { items, total } = await service.listTeams({
      orgId: org.id,
      userId,
      includeVisibilities,
      page: list.page,
      pageSize: list.limit,
    });
    setPaginationHeaders(c, total, list);
    return c.json(items.map((team) => toApiTeam(team, { viewer: viewerOf(c) })), 200);
  });

  app.openapi(orgCreateTeamRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const org = await resolveOrg(c, c.req.valid("param").org, doer);
    const service = new TeamsService(c.env.DB);
    await requireOrgOwnership(service.orgService, org, doer);
    const form = c.req.valid("json");
    try {
      const team = await service.createTeam(org, form);
      return c.json(toApiTeam(team, { viewer: viewerOf(c), org }), 201);
    } catch (error) {
      throw mapTeam422(error);
    }
  });

  app.openapi(teamSearchRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const org = await resolveOrg(c, c.req.valid("param").org, doer);
    const service = new TeamsService(c.env.DB);
    await requireOrgMembership(service.orgService, org, doer);
    const query = c.req.valid("query");
    let includeVisibilities: Array<"public" | "limited" | "private"> | undefined;
    let userId: number | undefined = doer.id;
    if (doer.isAdmin || (await isOrgOwner(service.orgService, org, doer))) {
      userId = undefined;
    } else {
      includeVisibilities = visibleTeamVisibilities(await isOrgMember(service.orgService, org, doer), true);
    }
    const list = parseListOptions(new URL(c.req.url));
    const { items, total } = await service.listTeams({
      orgId: org.id,
      userId,
      includeVisibilities,
      keyword: query.q ?? "",
      // ctx.FormString("include_desc") == "" || ctx.FormBool (team.go:801):
      // ABSENT means true; "false" means false.
      includeDesc: query.include_desc === undefined || query.include_desc !== "false",
      page: list.page,
      pageSize: list.limit,
    });
    setPaginationHeaders(c, total, list);
    return c.json({ ok: true, data: items.map((team) => toApiTeam(team, { viewer: viewerOf(c) })) }, 200);
  });

  app.openapi(orgGetTeamRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const service = new TeamsService(c.env.DB);
    const { team, org } = await resolveTeamContext(service, intPathParam(c.req.valid("param").id));
    await requireTeamReadAccess(service, org, team, doer);
    return c.json(toApiTeam(team, { viewer: viewerOf(c), org }), 200);
  });

  app.openapi(orgEditTeamRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const service = new TeamsService(c.env.DB);
    const { team, org } = await resolveTeamContext(service, intPathParam(c.req.valid("param").id));
    await requireTeamReadAccess(service, org, team, doer);
    await requireOrgOwnership(service.orgService, org, doer);
    const form = c.req.valid("json");
    try {
      const updated = await service.editTeam(team, form);
      return c.json(toApiTeam(updated, { viewer: viewerOf(c), org }), 200);
    } catch (error) {
      throw mapTeam422(error);
    }
  });

  app.openapi(orgDeleteTeamRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const service = new TeamsService(c.env.DB);
    const { team, org } = await resolveTeamContext(service, intPathParam(c.req.valid("param").id));
    await requireTeamReadAccess(service, org, team, doer);
    await requireOrgOwnership(service.orgService, org, doer);
    await service.deleteTeam(team); // LastOrgOwnerError → the §4.3 blanked 500
    return c.body(null, 204);
  });

  app.openapi(orgListTeamMembersRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const service = new TeamsService(c.env.DB);
    const { team, org } = await resolveTeamContext(service, intPathParam(c.req.valid("param").id));
    await requireTeamReadAccess(service, org, team, doer);
    await requireOrgMembership(service.orgService, org, doer);
    const list = parseListOptions(new URL(c.req.url));
    const { items } = await service.listTeamMemberRows(team.id, { page: list.page, pageSize: list.limit });
    // Upstream totals from the maintained counter, not the page (team.go:392–393).
    setPaginationHeaders(c, team.numMembers, list);
    const viewer = viewerOf(c);
    return c.json(items.map((row) => toApiUser(viewer, row)), 200);
  });

  app.openapi(orgListTeamMemberRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const service = new TeamsService(c.env.DB);
    const { team, org } = await resolveTeamContext(service, intPathParam(c.req.valid("param").id));
    await requireTeamReadAccess(service, org, team, doer);
    await requireOrgMembership(service.orgService, org, doer);
    const user = await findUserByName(c.env.DB, c.req.valid("param").username);
    if (user === null) throw notFound();
    if (!(await service.isTeamMember(team.id, user.id))) throw notFound();
    return c.json(toApiUser(viewerOf(c), user), 200);
  });

  app.openapi(orgAddTeamMemberRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const service = new TeamsService(c.env.DB);
    const { team, org } = await resolveTeamContext(service, intPathParam(c.req.valid("param").id));
    await requireTeamReadAccess(service, org, team, doer);
    await requireOrgOwnership(service.orgService, org, doer);
    const user = await findUserByName(c.env.DB, c.req.valid("param").username);
    if (user === null) throw notFound();
    // AddTeamMember's blocked arm (services/org/team.go:248-249): a user
    // blocked by the ORG answers ErrBlockedUser BEFORE the already-member
    // no-op — orgAddTeamMember (org/team.go:470-474) unwraps it to the
    // declared 403 `err.Error()`. Carried in the handler (the service method
    // keeps its test-fixture signature); the isUserBlockedBy site-admin
    // short-circuit is upstream's `blockee.IsAdmin`.
    if (await isUserBlockedBy(c.env.DB, { id: user.id, isAdmin: user.isAdmin }, team.orgId)) {
      throw new ApiError(403, BLOCKED_USER_MESSAGE);
    }
    await service.addTeamMember(team, user.id);
    return c.body(null, 204);
  });

  app.openapi(orgRemoveTeamMemberRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const service = new TeamsService(c.env.DB);
    const { team, org } = await resolveTeamContext(service, intPathParam(c.req.valid("param").id));
    await requireTeamReadAccess(service, org, team, doer);
    await requireOrgOwnership(service.orgService, org, doer);
    const user = await findUserByName(c.env.DB, c.req.valid("param").username);
    if (user === null) throw notFound();
    await service.removeTeamMember(team, user.id); // LastOrgOwnerError → the §4.3 500
    return c.body(null, 204);
  });

  app.openapi(orgListTeamReposRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const service = new TeamsService(c.env.DB);
    const { team, org } = await resolveTeamContext(service, intPathParam(c.req.valid("param").id));
    await requireTeamReadAccess(service, org, team, doer);
    const list = parseListOptions(new URL(c.req.url));
    const { items, total } = await service.listTeamRepoPairs(team, { page: list.page, pageSize: list.limit });
    setPaginationHeaders(c, total, list);
    const viewer = viewerOf(c);
    // The org owner's full grant rides the owners team upstream
    // (GetDoerRepoPermission) — the bridge arm of the trim.
    const ownerArm = await isOrgOwner(service.orgService, org, doer);
    const visible = [];
    for (const pair of items) {
      // Upstream's per-repo trim (team.go:569–577): a team's repo list is
      // reachable by non-members through the team's visibility tier, so repos
      // the doer has no access to never render (the total header stays the
      // untrimmed count — upstream documents the same upper bound).
      if (
        baseRepoVisible(viewer, pair) ||
        ownerArm ||
        (doer.id !== null && (await service.doerHasTeamRepoAccess(pair.repo, doer.id)))
      ) {
        visible.push(toApiRepository(viewer, pair));
      }
    }
    return c.json(visible, 200);
  });

  app.openapi(orgListTeamRepoRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const service = new TeamsService(c.env.DB);
    const { team, org } = await resolveTeamContext(service, intPathParam(c.req.valid("param").id));
    await requireTeamReadAccess(service, org, team, doer);
    // The path's {org} is IGNORED upstream — the repo resolves within the
    // team's org (getRepositoryByParams, org/team.go:634–647).
    const found = await service.repoInOrg(team.orgId, c.req.valid("param").repo);
    if (found === null) throw notFound();
    if (!(await service.hasTeamRepo(team, found.repo.id))) throw notFound();
    const viewer = viewerOf(c);
    // The org owner's full grant rides the owners team upstream
    // (GetDoerRepoPermission) — the bridge arm of the trim.
    const ownerArm = await isOrgOwner(service.orgService, org, doer);
    if (!baseRepoVisible(viewer, found) && !ownerArm && (doer.id === null || !(await service.doerHasTeamRepoAccess(found.repo, doer.id)))) {
      // "don't confirm the existence of a repo the doer cannot access"
      // (org/team.go:624–629).
      throw notFound();
    }
    return c.json(toApiRepository(viewer, found), 200);
  });

  app.openapi(orgAddTeamRepositoryRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const service = new TeamsService(c.env.DB);
    const { team, org } = await resolveTeamContext(service, intPathParam(c.req.valid("param").id));
    await requireTeamReadAccess(service, org, team, doer);
    await requireTeamMembership(service, org, team, doer);
    const found = await service.repoInOrg(team.orgId, c.req.valid("param").repo);
    if (found === null) throw notFound();
    if (!(await canDoerManageOrgRepoTeam(c, service, org, doer, found))) {
      throw new ApiError(403, "Must have permission to manage team repository access");
    }
    await service.addTeamRepo(team, found.repo.id);
    return c.body(null, 204);
  });

  app.openapi(orgRemoveTeamRepositoryRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const service = new TeamsService(c.env.DB);
    const { team, org } = await resolveTeamContext(service, intPathParam(c.req.valid("param").id));
    await requireTeamReadAccess(service, org, team, doer);
    await requireTeamMembership(service, org, team, doer);
    const found = await service.repoInOrg(team.orgId, c.req.valid("param").repo);
    if (found === null) throw notFound();
    if (!(await canDoerManageOrgRepoTeam(c, service, org, doer, found))) {
      throw new ApiError(403, "Must have permission to manage team repository access");
    }
    await service.removeTeamRepo(team, found.repo.id); // silent no-op when uncovered
    return c.body(null, 204);
  });

  app.openapi(orgListTeamActivityFeedsRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const service = new TeamsService(c.env.DB);
    const { team, org } = await resolveTeamContext(service, intPathParam(c.req.valid("param").id));
    await requireTeamReadAccess(service, org, team, doer);
    const list = parseListOptions(new URL(c.req.url));
    // Honest-empty: no activity model exists (module header) — the upstream
    // GetFeeds over an empty set answers `[]` + zero totals.
    setPaginationHeaders(c, 0, list);
    return c.json([], 200);
  });

  app.openapi(userListTeamsRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const service = new TeamsService(c.env.DB);
    const list = parseListOptions(new URL(c.req.url));
    // SearchTeam({UserID}) — own teams only (team_list.go:90–93 INNER shape).
    const { items, total } = await service.listTeams({ userId: doer.id, page: list.page, pageSize: list.limit });
    setPaginationHeaders(c, total, list);
    const viewer = viewerOf(c);
    // ToTeams(loadOrgs=true): every team embeds its Organization (team.go:115).
    const orgs = new Map<number, OrgRecord | null>();
    const body = [];
    for (const team of items) {
      if (!orgs.has(team.orgId)) {
        orgs.set(team.orgId, await service.orgService.getOrgById(team.orgId));
      }
      body.push(toApiTeam(team, { viewer, org: orgs.get(team.orgId) }));
    }
    return c.json(body, 200);
  });

  app.openapi(repoListTeamsRoute(optionalAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    assertOrgOwnedRepo(found.owner.type);
    const service = new TeamsService(c.env.DB);
    const covering = await service.listRepoTeams(found.repo.ownerId, found.repo.id);
    return c.json(covering.map((team) => toApiTeam(team, { viewer: viewerOf(c) })), 200);
  });

  app.openapi(repoCheckTeamRoute(optionalAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    assertOrgOwnedRepo(found.owner.type);
    const service = new TeamsService(c.env.DB);
    const record = await service.getTeamByName(found.repo.ownerId ?? -1, c.req.valid("param").team);
    if (record === null) throw teamNotExistError(found.repo.ownerId ?? -1, c.req.valid("param").team);
    if (!(await service.hasTeamRepo(record, found.repo.id))) throw notFound();
    return c.json(toApiTeam(record, { viewer: viewerOf(c) }), 200);
  });

  app.openapi(repoAddTeamRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    assertOrgOwnedRepo(found.owner.type);
    const service = new TeamsService(c.env.DB);
    const org = await mustOrg(service, found);
    await requireRepoTeamAdmin(c, service, org, doer, found); // upstream reqAdmin (api.go:1306)
    const record = await service.getTeamByName(org.id, c.req.valid("param").team);
    if (record === null) throw teamNotExistError(org.id, c.req.valid("param").team);
    if (!(await canDoerManageOrgRepoTeam(c, service, org, doer, found))) {
      throw new ApiError(403, "No permission to change organization repository's team");
    }
    if (await service.hasTeamRepo(record, found.repo.id)) {
      throw new ApiError(422, `team '${record.name}' is already added to repo`);
    }
    await service.addTeamRepo(record, found.repo.id);
    return c.body(null, 204);
  });

  app.openapi(repoDeleteTeamRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    assertOrgOwnedRepo(found.owner.type);
    const service = new TeamsService(c.env.DB);
    const org = await mustOrg(service, found);
    await requireRepoTeamAdmin(c, service, org, doer, found);
    const record = await service.getTeamByName(org.id, c.req.valid("param").team);
    if (record === null) throw teamNotExistError(org.id, c.req.valid("param").team);
    if (!(await canDoerManageOrgRepoTeam(c, service, org, doer, found))) {
      throw new ApiError(403, "No permission to change organization repository's team");
    }
    if (!(await service.hasTeamRepo(record, found.repo.id))) {
      throw new ApiError(422, `team '${record.name}' was not added to repo`);
    }
    await service.removeTeamRepo(record, found.repo.id);
    return c.body(null, 204);
  });
}

/** The org record behind a repo's owner row (org-owned already asserted). */
async function mustOrg(service: TeamsService, found: RepositoryWithOwner): Promise<OrgRecord> {
  const org = found.repo.ownerId === null ? null : await service.orgService.getOrgById(found.repo.ownerId);
  if (org === null) throw notFound();
  return org;
}

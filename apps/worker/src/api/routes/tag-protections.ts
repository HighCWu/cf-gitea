import { and, eq, inArray, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import { protectedTags, teams, users } from "../../db/schema";
import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import {
  findProtectedTagById,
  findProtectedTagByNamePattern,
  listProtectedTags,
  parseAllowlistIds,
  serializeAllowlistIds,
  type ProtectedTagRow,
} from "../../services/tag-protection";
import { assertNotArchived, requireRepoAdmin, requireVisibleRepo } from "../services/repo-access";


/**
 * The `/repos/{owner}/{repo}/tag_protections` API family (inventory batch 8;
 * 5 frozen operations, the structural mirror of the branch-protections
 * family): repoListTagProtection, repoGetTagProtection,
 * repoCreateTagProtection, repoEditTagProtection, repoDeleteTagProtection —
 * the handlers are routers/api/v1/repo/tag.go:298-648, the group mounts
 * `reqToken(), reqAdmin()` (routers/api/v1/api.go:1339-1346) with
 * `mustNotBeArchived` on the POST and PATCH arms ONLY (upstream's DELETE arm
 * carries no mustNotBeArchived — unlike the branch family; the contract
 * agrees, declaring 423 on create/edit alone). Ours: [requireAuth] +
 * requireVisibleRepo (the 404 arm) + requireRepoAdmin (the 403 arm) +
 * assertNotArchived (423) on create/edit.
 *
 * RUNTIME-ONLY codes the handlers can emit that the vendored contract omits
 * (the orchestrator-owned RUNTIME_ONLY_RESPONSES table is not extended by
 * this module — the branch-protections batch pattern):
 *   - 401 on every op (upstream reqToken; this contract tag declares no 401);
 *   - 403 on the reads and edit/delete for a non-admin (reqAdmin; only the
 *     create declares 403);
 *   - 400 on create's two empty checks ("name_pattern are empty" — upstream's
 *     exact grammatical quirk, tag.go:417-419 — and "both
 *     whitelist_usernames and whitelist_teams are empty", :421-424).
 * Declared sets mirror the contract exactly: list {200}, get {200,404},
 * create {201,403,404,422,423}, edit {200,404,422,423}, delete {204,404}.
 *
 * ID PARAM — upstream parses with PathParamInt64 (services/context/
 * base_path.go:35: ParseInt failure → 0), so a non-integer id looks up id 0,
 * misses, and answers the plain shared 404; missing-vs-foreign are the same
 * plain 404 (`pt == nil || pt.RepoID != repo.ID`, tag.go:348-350/:488-492/
 * :628-631). Ported verbatim.
 *
 * CREATE semantics (tag.go:413-481): name_pattern is TrimSpace'd — empty →
 * the runtime 400 "name_pattern are empty"; BOTH whitelists empty (raw form
 * arrays, before any org scoping) → 400 "both whitelist_usernames and
 * whitelist_teams are empty"; the EXACT trimmed pattern already present →
 * 403 "Tag protection already exist" (no UNIQUE constraint backs it — the
 * table comment); usernames resolve via GetDoerUserIDsByNames — existence
 * only, allowSystemDoer=false so the system pseudo-users do NOT resolve here
 * (user.go:1237-1239; the 422 text carries the LOWERCASED name,
 * getDoerUsersByNames builds ErrUserNotExist{Name: nameLower}, user.go:1223,
 * rendered by error.go:46); teams resolve ONLY on org-owned repos and are
 * silently DROPPED otherwise (tag.go:440-448 — no error, unlike the branch
 * family). The stored ids pass NO access filter (protected_tag.go has no
 * whitelist sanitizer — the documented divergence from the branch family).
 *
 * EDIT semantics (tag.go:486-560): name_pattern is a POINTER — present means
 * REPLACE, verbatim, NO trim and NO empty check (an empty string is a legal
 * stored pattern; glob-compiles to ^$); whitelist_teams, when present, are
 * org-scoped-resolved (silently [] on user repos) and REPLACE; usernames,
 * when present, resolve and REPLACE; teams resolve BEFORE usernames (the
 * upstream order — a both-invalid body 422s on the team name first); absent
 * arrays keep the stored ids. No name_pattern collision check on edit
 * (upstream has none either).
 *
 * RENDER — ToTagProtection (services/convert/convert.go:1016-1039): id,
 * name_pattern, whitelist_usernames/whitelist_teams, created_at/updated_at.
 * Upstream filters the names through the repo's readers/reader-teams
 * (GetUsersWithAnyUnitAccess / GetTeamsWithAccessToAnyRepoUnit); this port
 * renders ids→names with vanished principals omitted — the branch-protections
 * family's documented render nuance, not a readers re-filter.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const repoArchivedResponse = {
  description: "repoArchivedError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

/** Body bind hook for the operations with a declared 422 (Go bind parity). */
const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Wire schemas (route-local: the module owns its contract shapes).
// ---------------------------------------------------------------------------

/** The rendered TagProtection (structs/repo_tag.go:63-78) — every field
 *  renders (Go structs carry no omitempty). */
export const tagProtectionSchema = z.object({
  id: z.number().int().openapi({ format: "int64", description: "The unique identifier of the tag protection" }),
  name_pattern: z.string().openapi({ description: "The pattern to match tag names for protection" }),
  whitelist_usernames: z.array(z.string()).openapi({ description: "List of usernames allowed to create/delete protected tags" }),
  whitelist_teams: z.array(z.string()).openapi({ description: "List of team names allowed to create/delete protected tags" }),
  created_at: z.string().openapi({ format: "date-time", description: "The date and time when the tag protection was created" }),
  updated_at: z.string().openapi({ format: "date-time", description: "The date and time when the tag protection was last updated" }),
});

/** CreateTagProtectionOption (structs/repo_tag.go:81-89) — no binding
 *  Required tags upstream, so absent fields decode as Go zeros (the two
 *  create 400s). */
const createOptionShape = {
  name_pattern: z.string().optional().openapi({ description: "The pattern to match tag names for protection" }),
  whitelist_usernames: z.array(z.string()).optional().openapi({ description: "List of usernames allowed to create/delete protected tags" }),
  whitelist_teams: z.array(z.string()).optional().openapi({ description: "List of team names allowed to create/delete protected tags" }),
} as const;

/** EditTagProtectionOption (structs/repo_tag.go:91-97) — name_pattern is a
 *  pointer (absent = keep); the arrays are plain slices (absent = keep,
 *  present — even empty — = replace). */
const editOptionShape = {
  name_pattern: z.string().optional().openapi({ description: "The pattern to match tag names for protection" }),
  whitelist_usernames: z.array(z.string()).optional().openapi({ description: "List of usernames allowed to create/delete protected tags" }),
  whitelist_teams: z.array(z.string()).optional().openapi({ description: "List of team names allowed to create/delete protected tags" }),
} as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

/** The {id} path param — declared integer (the contract), carried as the raw
 *  string so a non-integer value reaches the handler and 404s like upstream's
 *  PathParamInt64(→0)→miss (the releases.ts family convention). */
const tagProtectionIdParam = {
  id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the tag protection" }),
} as const;

// ---------------------------------------------------------------------------
// Handler helpers — the upstream ports, in handler order.
// ---------------------------------------------------------------------------

/** PathParamInt64 (base_path.go:35): ParseInt failure → 0 → the plain 404. */
function pathParamInt64(raw: string): number {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

/** ctx.APIErrorNotFound — the plain shared-404 (unknown repo is already gone
 *  behind requireVisibleRepo's anti-enumeration 404). */
function requireTag(rule: ProtectedTagRow | null): ProtectedTagRow {
  if (rule === null) {
    throw new ApiError(404, "not found");
  }
  return rule;
}

/**
 * GetDoerUserIDsByNames (user.go:1237-1239 → getDoerUsersByNames :1179-1226,
 * allowSystemDoer=false): case-insensitive name→id, EXISTENCE only; the
 * system pseudo-users do not resolve (no WithSystem arm here — unlike the
 * branch family), and the type filter `type IN (individual, bot)` excludes
 * orgs (our users.type ∈ {"user","org"}). The 422 text carries the
 * LOWERCASED name (ErrUserNotExist{Name: nameLower}, user.go:1223).
 */
async function resolveUserIds(d1: D1Database, names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const row = (
      await drizzle(d1)
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.usernameLower, lower), ne(users.type, "org")))
        .limit(1)
        .all()
    )[0];
    if (row === undefined) {
      throw new ApiError(422, `user does not exist [uid: 0, name: ${lower}]`);
    }
    ids.push(row.id);
  }
  return ids;
}

/** GetTeamIDsByNames (organization/team.go) — org-scoped, case-insensitive;
 *  the unknown-team 422 is upstream's exact ErrTeamNotExist text. */
async function resolveTeamIds(d1: D1Database, orgId: number, names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const row = (
      await drizzle(d1)
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.orgId, orgId), eq(teams.lowerName, name.toLowerCase())))
        .limit(1)
        .all()
    )[0];
    if (row === undefined) {
      throw new ApiError(422, `team does not exist [org_id ${orgId}, team_id 0, name: ${name}]`);
    }
    ids.push(row.id);
  }
  return ids;
}

/** ToTagProtection (convert.go:1016-1039) — ids→names, vanished principals
 *  render as nothing (the module-header note on the readers filter). */
async function renderProtection(d1: D1Database, row: ProtectedTagRow): Promise<z.infer<typeof tagProtectionSchema>> {
  const userIds = [...new Set(parseAllowlistIds(row.allowlistUserIds))].filter((id) => id > 0);
  const usernameMap = new Map<number, string>();
  if (userIds.length > 0) {
    for (const row of await drizzle(d1).select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds)).all()) {
      usernameMap.set(row.id, row.username);
    }
  }
  const teamIds = [...new Set(parseAllowlistIds(row.allowlistTeamIds))];
  const teamNameMap = new Map<number, string>();
  if (teamIds.length > 0) {
    for (const row of await drizzle(d1).select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamIds)).all()) {
      teamNameMap.set(row.id, row.name);
    }
  }
  return {
    id: row.id,
    name_pattern: row.namePattern,
    whitelist_usernames: userIds.map((id) => usernameMap.get(id)).filter((name): name is string => name !== undefined),
    whitelist_teams: teamIds.map((id) => teamNameMap.get(id)).filter((name): name is string => name !== undefined),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The routes.
// ---------------------------------------------------------------------------

export function registerTagProtectionRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/tag_protections (repoListTagProtection)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/tag_protections",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "List tag protections for a repository",
      operationId: "repoListTagProtection",
      request: {
        params: z.object(ownerRepoParams),
      },
      responses: {
        200: {
          description: "TagProtectionList",
          content: { "application/json": { schema: z.array(tagProtectionSchema) } },
        },
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      // GetProtectedTags (tag.go:314-317, protected_tag.go:117-121).
      const rows = await listProtectedTags(c.env.DB, pair.repo.id);
      const rendered = await Promise.all(rows.map((row) => renderProtection(c.env.DB, row)));
      return c.json(rendered, 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/tag_protections (repoCreateTagProtection)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/tag_protections",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Create a tag protections for a repository",
      operationId: "repoCreateTagProtection",
      request: {
        params: z.object(ownerRepoParams),
        body: { content: { "application/json": { schema: z.object(createOptionShape) } } },
      },
      responses: {
        201: { description: "TagProtection", content: { "application/json": { schema: tagProtectionSchema } } },
        403: forbiddenResponse,
        404: notFoundResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      assertNotArchived(pair);
      const form = c.req.valid("json");

      // TrimSpace + the empty arm (tag.go:416-419) — the exact upstream text,
      // grammatical quirk included.
      const namePattern = (form.name_pattern ?? "").trim();
      if (namePattern === "") {
        throw new ApiError(400, "name_pattern are empty");
      }
      // The raw-form empty check, BEFORE any org scoping (tag.go:421-424).
      if ((form.whitelist_usernames?.length ?? 0) === 0 && (form.whitelist_teams?.length ?? 0) === 0) {
        throw new ApiError(400, "both whitelist_usernames and whitelist_teams are empty");
      }
      // The EXACT-pattern collision pre-check (tag.go:426-431) — no UNIQUE
      // constraint backs it (the table comment).
      if ((await findProtectedTagByNamePattern(c.env.DB, pair.repo.id, namePattern)) !== null) {
        throw new ApiError(403, "Tag protection already exist");
      }
      // Usernames resolve before anything writes (tag.go:433-440).
      const whitelistUsers = await resolveUserIds(c.env.DB, form.whitelist_usernames ?? []);
      // Teams resolve on ORG-owned repos only, silently dropped otherwise
      // (tag.go:440-448 — no error for a user repo, unlike the branch family).
      const whitelistTeams = pair.owner.type === "org" ? await resolveTeamIds(c.env.DB, pair.owner.id, form.whitelist_teams ?? []) : [];

      const now = new Date();
      const result = await drizzle(c.env.DB)
        .insert(protectedTags)
        .values({
          repoId: pair.repo.id,
          namePattern,
          allowlistUserIds: serializeAllowlistIds(whitelistUsers),
          allowlistTeamIds: serializeAllowlistIds(whitelistTeams),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: protectedTags.id });
      // Reload from db to get the landed row (tag.go:462-476).
      const row = requireTag(await findProtectedTagById(c.env.DB, result[0]!.id));
      return c.json(await renderProtection(c.env.DB, row), 201);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/tag_protections/{id} (repoGetTagProtection)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/tag_protections/{id}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Get a specific tag protection for the repository",
      operationId: "repoGetTagProtection",
      request: {
        params: z.object({ ...ownerRepoParams, ...tagProtectionIdParam }),
      },
      responses: {
        200: { description: "TagProtection", content: { "application/json": { schema: tagProtectionSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      const row = await findProtectedTagById(c.env.DB, pathParamInt64(c.req.valid("param").id));
      // pt == nil || repo.ID != pt.RepoID — the same plain 404 (tag.go:348-351).
      if (row === null || row.repoId !== pair.repo.id) {
        throw new ApiError(404, "not found");
      }
      return c.json(await renderProtection(c.env.DB, row), 200);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /repos/{owner}/{repo}/tag_protections/{id} (repoEditTagProtection)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "patch",
      path: "/repos/{owner}/{repo}/tag_protections/{id}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Edit a tag protections for a repository. Only fields that are set will be changed",
      operationId: "repoEditTagProtection",
      request: {
        params: z.object({ ...ownerRepoParams, ...tagProtectionIdParam }),
        body: { content: { "application/json": { schema: z.object(editOptionShape) } } },
      },
      responses: {
        200: { description: "TagProtection", content: { "application/json": { schema: tagProtectionSchema } } },
        404: notFoundResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      assertNotArchived(pair);
      const form = c.req.valid("json");
      const row = await findProtectedTagById(c.env.DB, pathParamInt64(c.req.valid("param").id));
      // pt == nil || pt.RepoID != repo.ID (tag.go:495-499).
      if (row === null || row.repoId !== pair.repo.id) {
        throw new ApiError(404, "not found");
      }

      // name_pattern is a POINTER: present = REPLACE, verbatim — no trim, no
      // empty check (tag.go:501-503; an empty stored pattern glob-compiles
      // to ^$ and matches nothing but the empty tag name).
      if (form.name_pattern !== undefined) {
        row.namePattern = form.name_pattern;
      }
      // Teams resolve BEFORE usernames (the upstream order, tag.go:505-519
      // then :521-533); a present array replaces — org-scoped-resolved, or
      // silently [] on a user repo (GetTeamIDsByNames is never called).
      if (form.whitelist_teams !== undefined) {
        const whitelistTeams = pair.owner.type === "org" ? await resolveTeamIds(c.env.DB, pair.owner.id, form.whitelist_teams) : [];
        row.allowlistTeamIds = serializeAllowlistIds(whitelistTeams);
      }
      if (form.whitelist_usernames !== undefined) {
        const whitelistUsers = await resolveUserIds(c.env.DB, form.whitelist_usernames);
        row.allowlistUserIds = serializeAllowlistIds(whitelistUsers);
      }

      // UpdateProtectedTag (AllCols) + the reload (tag.go:535-553).
      await drizzle(c.env.DB)
        .update(protectedTags)
        .set({ namePattern: row.namePattern, allowlistUserIds: row.allowlistUserIds, allowlistTeamIds: row.allowlistTeamIds, updatedAt: new Date() })
        .where(eq(protectedTags.id, row.id));
      const updated = requireTag(await findProtectedTagById(c.env.DB, row.id));
      return c.json(await renderProtection(c.env.DB, updated), 200);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/tag_protections/{id}
  // (repoDeleteTagProtection) — 204. NO assertNotArchived: upstream's DELETE
  // arm carries no mustNotBeArchived (api.go:1344-1345), unlike the branch
  // family; the contract declares no 423 here either.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/tag_protections/{id}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Delete a specific tag protection for the repository",
      operationId: "repoDeleteTagProtection",
      request: {
        params: z.object({ ...ownerRepoParams, ...tagProtectionIdParam }),
      },
      responses: {
        204: { description: "empty" },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      const row = await findProtectedTagById(c.env.DB, pathParamInt64(c.req.valid("param").id));
      // pt == nil || pt.RepoID != repo.ID (tag.go:628-632).
      if (row === null || row.repoId !== pair.repo.id) {
        throw new ApiError(404, "not found");
      }
      await drizzle(c.env.DB).delete(protectedTags).where(eq(protectedTags.id, row.id));
      return c.body(null, 204);
    },
  );
}

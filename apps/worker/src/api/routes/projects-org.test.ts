/**
 * Org-scoped project-board routes (routes/projects-org.ts) on real D1 —
 * inventory batch 6 stage 2: the 21 `org*Project*` operations over
 * `/orgs/{org}/projects…` (gitea/routers/api/v1/api.go:1755-1757 over the
 * shared handlers, reusing the stage-1 store + service verbatim).
 *
 * Standalone mount (the projects-repo.test.ts convention): the register
 * function takes the requireAuth/optionalAuth pair and mounts on a fresh
 * OpenAPIHono with the stub resolver mapping `token u<id>` to the seeded D1
 * user rows.
 *
 * Pins asserted: the orgAssignment seam (unknown org 404, plain user under
 * /orgs 404, rename 307), the `reqProjectsUnitAccess` gates — BOTH arms 404
 * (api.go:754-768), the access ladder (org-owner bridge > team max > the
 * org-visibility fallback with the team-less-member blind spot), the
 * global-lookup issue arm with its per-issue archived 423 and repo-read 404
 * (shared/project.go:114-147), the owner-arm listing/count filtering
 * (outside-org issues stay assigned but never list), CanManageWorkflows' org
 * arm (Projects-unit writers that are not org owners 403 — workflow.go:33-39),
 * the cross-org 404s, and a full column/issue/workflow round trip.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  comments,
  issues,
  labels,
  orgMembers,
  projectColumns,
  projectIssues,
  projectWorkflows,
  projects,
  repositories,
  teamMembers,
  teams,
  userRedirects,
  users,
} from "../../db/schema";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerProjectsOrgRoutes } from "./projects-org";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";

beforeAll(applyAuthD1Migrations);

beforeEach(async () => {
  for (const table of [
    "comments",
    "project_workflows",
    "project_issues",
    "project_columns",
    "projects",
    "issue_labels",
    "issues",
    "labels",
    "team_repo_access",
    "team_members",
    "teams",
    "org_members",
    "user_redirects",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  seededUsers.clear();
});

const db = () => drizzle(env.DB);
const NOW = new Date("2026-01-05T00:00:00Z");

/** Seeded D1 users the test resolver authenticates as (`token u<id>`). */
const seededUsers = new Map<number, { id: number; username: string; isAdmin: boolean }>();

interface SeededUser {
  id: number;
  username: string;
}

async function seedUser(username: string, isAdmin = false, options?: { type?: "user" | "org"; visibility?: "public" | "limited" | "private" }): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin,
      status: "active",
      type: options?.type ?? "user",
      visibility: options?.visibility ?? "public",
      createdAt: NOW,
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin });
  return { id: user.id, username: user.username };
}

const authHeaders = (userId: number): Record<string, string> => ({
  Authorization: `token u${userId}`,
  "Content-Type": "application/json",
});

/** API `User` projection the resolver returns (the auth middleware's shape). */
function apiUser(user: { id: number; username: string; isAdmin: boolean }): User {
  return {
    id: user.id,
    login: user.username,
    email: `${user.username.toLowerCase()}@example.com`,
    full_name: "",
    avatar_url: "",
    html_url: "",
    language: "en-US",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: user.isAdmin,
    prohibit_login: false,
    restricted: false,
    login_name: "",
    source_id: 0,
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    created: "2026-01-01T00:00:00Z",
    last_login: "0001-01-01T00:00:00Z",
    type: "User",
    visibility: "public",
  };
}

const resolver: AuthResolver = {
  resolveToken(token) {
    const match = /^u(\d+)$/.exec(token);
    const user = match === null ? undefined : seededUsers.get(Number(match[1]));
    if (match === null || user === undefined) return Promise.resolve(null);
    return Promise.resolve(apiUser(user));
  },
};

/** Local mount of exactly the orchestrator one-liner's seam. */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerProjectsOrgRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

interface OrgSeed {
  org: SeededUser;
  owner: SeededUser; // org_members.role='owner'
  outsider: SeededUser; // no relationship with the org
  admin: SeededUser;
}

async function seedOrgAndActors(suffix: string, options?: { visibility?: "public" | "limited" | "private" }): Promise<OrgSeed> {
  const org = await seedUser(`org-${suffix}`, false, {
    type: "org",
    visibility: options?.visibility ?? "public",
  });
  const owner = await seedUser(`o-owner-${suffix}`);
  const outsider = await seedUser(`o-out-${suffix}`);
  const admin = await seedUser(`o-admin-${suffix}`, true);
  await db().insert(orgMembers).values({ orgId: org.id, userId: owner.id, role: "owner", createdAt: NOW });
  return { org, owner, outsider, admin };
}

async function seedOrgMembership(orgId: number, userId: number, role: "owner" | "member" = "member") {
  await db().insert(orgMembers).values({ orgId, userId, role, createdAt: NOW });
}

async function seedTeam(
  orgId: number,
  userId: number,
  authorize: "read" | "write" | "none",
  options?: { unitsMap?: Record<string, string>; includesAll?: boolean },
) {
  const teamRows = await db()
    .insert(teams)
    .values({
      orgId,
      lowerName: `t-${orgId}-${userId}-${authorize}`,
      name: `team-${authorize}`,
      authorize,
      includesAllRepositories: options?.includesAll ?? false,
      unitsMap: options?.unitsMap === undefined ? null : JSON.stringify(options.unitsMap),
    })
    .returning()
    .all();
  const team = teamRows[0];
  if (team === undefined) throw new Error("team seed failed");
  await db().insert(teamMembers).values({ orgId, teamId: team.id, userId });
  return team;
}

async function seedOrgRepo(
  org: SeededUser,
  slug: string,
  options?: { visibility?: "public" | "private"; isArchived?: boolean },
): Promise<string> {
  const repoId = `org-${slug}`;
  await db()
    .insert(repositories)
    .values({
      id: repoId,
      storageKey: `r_${repoId}`,
      ownerNamespace: org.username.toLowerCase(),
      ownerId: org.id,
      slug,
      visibility: options?.visibility ?? "public",
      isArchived: options?.isArchived ?? false,
      createdAt: NOW,
    });
  return repoId;
}

/** A repo owned by a plain user (the outside-org universe). */
async function seedUserRepo(owner: SeededUser, slug: string, visibility: "public" | "private" = "public"): Promise<string> {
  const repoId = `usr-${slug}`;
  await db()
    .insert(repositories)
    .values({
      id: repoId,
      storageKey: `r_${repoId}`,
      ownerNamespace: owner.username.toLowerCase(),
      ownerId: owner.id,
      slug,
      visibility,
      createdAt: NOW,
    });
  return repoId;
}

async function seedOrgProject(orgId: number, creatorId: number, overrides?: Partial<typeof projects.$inferInsert>) {
  const rows = await db()
    .insert(projects)
    .values({
      title: "Org Board",
      description: "",
      ownerId: orgId,
      creatorId,
      type: 3,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("project seed failed");
  return row;
}

async function seedColumn(projectId: number, overrides?: Partial<typeof projectColumns.$inferInsert>) {
  const rows = await db()
    .insert(projectColumns)
    .values({
      title: "To Do",
      projectId,
      creatorId: 1,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("column seed failed");
  return row;
}

async function seedIssue(repoId: string, index: number, overrides?: Partial<typeof issues.$inferInsert>) {
  const rows = await db()
    .insert(issues)
    .values({
      repoId,
      index,
      title: `Issue ${index}`,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("issue seed failed");
  return row;
}

async function seedMembership(issueId: number, projectId: number, columnId: number, sorting = 0) {
  await db().insert(projectIssues).values({ issueId, projectId, projectColumnId: columnId, sorting });
}

// ---------------------------------------------------------------------------
// Org resolution + the read gate
// ---------------------------------------------------------------------------

describe("org resolution (orgAssignment seam)", () => {
  it("404s unknown orgs and plain users under /orgs; lists a public org anonymously", async () => {
    const s = await seedOrgAndActors("res");
    await seedOrgProject(s.org.id, s.owner.id);
    const send = router();
    expect((await send("/orgs/nobody/projects")).status).toBe(404);
    const plain = await seedUser("plain-guy");
    // a plain user name under /orgs is a miss (SPEC-0007 §4.11 type filter)
    expect((await send(`/orgs/${plain.username}/projects`)).status).toBe(404);
    const anon = await send(`/orgs/${s.org.username}/projects`);
    expect(anon.status).toBe(200);
    expect(anon.headers.get("x-total-count")).toBe("1");
  });

  it("307-redirects renamed orgs onto the new path (RedirectToUser)", async () => {
    const s = await seedOrgAndActors("renamed");
    await db().insert(userRedirects).values({ lowerName: "old-org-name", redirectUserId: s.org.id });
    const send = router();
    const res = await send("/orgs/old-org-name/projects?state=all");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`/orgs/${s.org.username}/projects?state=all`);
  });
});

describe("the read gate (reqProjectsUnitAccess Read — always 404)", () => {
  it("private orgs: anonymous and unrelated callers 404; owner and site admin pass", async () => {
    const s = await seedOrgAndActors("privread", { visibility: "private" });
    await seedOrgProject(s.org.id, s.owner.id);
    const send = router();
    expect((await send(`/orgs/${s.org.username}/projects`)).status).toBe(404);
    expect((await send(`/orgs/${s.org.username}/projects`, { headers: authHeaders(s.outsider.id) })).status).toBe(404);
    expect((await send(`/orgs/${s.org.username}/projects`, { headers: authHeaders(s.owner.id) })).status).toBe(200);
    expect((await send(`/orgs/${s.org.username}/projects`, { headers: authHeaders(s.admin.id) })).status).toBe(200);
  });

  it("public orgs grant everyone read; private-org members WITHOUT teams read none (upstream blind spot)", async () => {
    const publicOrg = await seedOrgAndActors("pubread");
    await seedOrgProject(publicOrg.org.id, publicOrg.owner.id);
    const member = await seedUser("o-member-pub");
    await seedOrgMembership(publicOrg.org.id, member.id); // no team rows at all
    const send = router();
    expect((await send(`/orgs/${publicOrg.org.username}/projects`, { headers: authHeaders(member.id) })).status).toBe(200);

    const privateOrg = await seedOrgAndActors("privmem", { visibility: "private" });
    await seedOrgProject(privateOrg.org.id, privateOrg.owner.id);
    const hidden = await seedUser("o-member-priv");
    await seedOrgMembership(privateOrg.org.id, hidden.id); // team-less: AnyRepoUnitPermission falls to visibility
    expect((await send(`/orgs/${privateOrg.org.username}/projects`, { headers: authHeaders(hidden.id) })).status).toBe(404);
  });

  it("team grants rank: read teams read, write teams write, unitsMap overrides count", async () => {
    const s = await seedOrgAndActors("teams");
    await seedOrgProject(s.org.id, s.owner.id);
    const reader = await seedUser("o-team-read");
    const writer = await seedUser("o-team-write");
    const unitWriter = await seedUser("o-team-unit");
    await seedTeam(s.org.id, reader.id, "read");
    await seedTeam(s.org.id, writer.id, "write");
    await seedTeam(s.org.id, unitWriter.id, "none", { unitsMap: { "repo.projects": "write" } });
    const send = router();
    const base = `/orgs/${s.org.username}/projects`;
    expect((await send(base, { headers: authHeaders(reader.id) })).status).toBe(200);
    const readerWrite = await send(base, { method: "POST", headers: authHeaders(reader.id), body: JSON.stringify({ title: "x" }) });
    expect(readerWrite.status).toBe(404); // below write ⇒ the anti-enumeration 404, never 403
    const writerRes = await send(base, { method: "POST", headers: authHeaders(writer.id), body: JSON.stringify({ title: "Team Board" }) });
    expect(writerRes.status).toBe(201);
    const unitRes = await send(base, { method: "POST", headers: authHeaders(unitWriter.id), body: JSON.stringify({ title: "Unit Board" }) });
    expect(unitRes.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// orgCreateProject
// ---------------------------------------------------------------------------

describe("POST /orgs/{org}/projects (orgCreateProject)", () => {
  it("creates an organization-typed board; the 404 gate precedes the bind 422", async () => {
    const s = await seedOrgAndActors("create");
    const send = router();
    const res = await send(`/orgs/${s.org.username}/projects`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "Roadmap", description: "plans", template_type: "basic_kanban" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      title: "Roadmap",
      description: "plans",
      owner_id: s.org.id,
      repo_id: 0,
      creator_id: s.owner.id,
      state: "open",
      type: "organization",
      template_type: "basic_kanban",
      num_issues: 0,
      // ProjectLinkForOrg — the owner arm's `/-/projects/` shape.
      html_url: `https://example.com/${s.org.username}/-/projects/${String(body.id)}`,
    });
    const columns = await db().select().from(projectColumns).where(eq(projectColumns.projectId, Number(body.id))).all();
    expect(columns.map((c) => c.title).sort()).toEqual(["Backlog", "Done", "In Progress", "To Do"]);
    const backlog = columns.find((c) => c.title === "Backlog");
    expect(backlog?.isDefault).toBe(true);

    // Unknown org + title-less body → 404 (the gate precedes the bind).
    expect(
      (await send("/orgs/nobody/projects", { method: "POST", headers: authHeaders(s.owner.id), body: "{}" })).status,
    ).toBe(404);
    const noTitle = await send(`/orgs/${s.org.username}/projects`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ description: "no title" }),
    });
    expect(noTitle.status).toBe(422);
    // Anonymous write → 401 (requireAuth precedes the gate — the stage-1 shape).
    expect(
      (await send(`/orgs/${s.org.username}/projects`, { method: "POST", body: JSON.stringify({ title: "x" }) })).status,
    ).toBe(401);
    // The plain member (no grant) never sees a 403 — the write gate 404s.
    const member = await seedUser("o-member-create");
    await seedOrgMembership(s.org.id, member.id);
    expect(
      (await send(`/orgs/${s.org.username}/projects`, { method: "POST", headers: authHeaders(member.id), body: JSON.stringify({ title: "x" }) }))
        .status,
    ).toBe(404);
  });

  it("rejects invalid enums with the exact 422s", async () => {
    const s = await seedOrgAndActors("enum");
    const send = router();
    const bad = await send(`/orgs/${s.org.username}/projects`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "x", card_type: "rich" }),
    });
    expect(bad.status).toBe(422);
    expect((await bad.json<Record<string, string>>()).message).toBe(
      `invalid card_type "rich" (expected text_only, images_and_text)`,
    );
  });
});

// ---------------------------------------------------------------------------
// orgGetProject / orgEditProject / orgDeleteProject
// ---------------------------------------------------------------------------

describe("GET/PATCH/DELETE /orgs/{org}/projects/{id}", () => {
  it("gets one board with org-arm counts; another ORG's id 404s with the exact message", async () => {
    const s = await seedOrgAndActors("get");
    const other = await seedOrgAndActors("get2");
    const publicRepo = await seedOrgRepo(s.org, "lib");
    const privateRepo = await seedOrgRepo(s.org, "secret", { visibility: "private" });
    const project = await seedOrgProject(s.org.id, s.owner.id);
    const pubIssue = await seedIssue(publicRepo, 1);
    const privIssue = await seedIssue(privateRepo, 1, { isClosed: true });
    await seedMembership(pubIssue.id, project.id, 0);
    await seedMembership(privIssue.id, project.id, 0);
    const otherProject = await seedOrgProject(other.org.id, other.owner.id, { title: "Foreign" });

    const send = router();
    // Anonymous counts only the public-repo item (AllPublic arm).
    const anon = await send(`/orgs/${s.org.username}/projects/${project.id}`);
    expect(anon.status).toBe(200);
    expect(await anon.json<Record<string, unknown>>()).toMatchObject({
      id: project.id,
      type: "organization",
      num_open_issues: 1,
      num_closed_issues: 0,
      num_issues: 1,
    });
    // The org owner's counts cover the private repo too (Doer arm).
    const owned = await send(`/orgs/${s.org.username}/projects/${project.id}`, { headers: authHeaders(s.owner.id) });
    expect(await owned.json<Record<string, unknown>>()).toMatchObject({
      num_open_issues: 1,
      num_closed_issues: 1,
      num_issues: 2,
    });
    // Cross-org id → not found, upstream's exact rendering.
    const cross = await send(`/orgs/${s.org.username}/projects/${otherProject.id}`, { headers: authHeaders(s.owner.id) });
    expect(cross.status).toBe(404);
    expect((await cross.json<Record<string, string>>()).message).toBe(`projects does not exist [id: ${otherProject.id}]`);
  });

  it("patches tri-state (edit stays open on closed boards); deletes with the cascade", async () => {
    const s = await seedOrgAndActors("edit");
    const project = await seedOrgProject(s.org.id, s.owner.id, { title: "Before" });
    const column = await seedColumn(project.id);
    const send = router();
    const url = `/orgs/${s.org.username}/projects/${project.id}`;
    const res = await send(url, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "After", card_type: "images_and_text", state: "closed" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ title: "After", card_type: "images_and_text", state: "closed", type: "organization" });
    expect(body.closed_at).toBeTypeOf("string");
    // Editing the closed board itself is NOT the closed-project 403 (the
    // contract declares no 403 on orgEditProject).
    const editClosed = await send(url, { method: "PATCH", headers: authHeaders(s.owner.id), body: JSON.stringify({ description: "d" }) });
    expect(editClosed.status).toBe(200);
    const del = await send(url, { method: "DELETE", headers: authHeaders(s.owner.id) });
    expect(del.status).toBe(204);
    expect(await db().select().from(projects).where(eq(projects.id, project.id)).all()).toHaveLength(0);
    expect(await db().select().from(projectColumns).where(eq(projectColumns.id, column.id)).all()).toHaveLength(0);
    expect((await send(`/orgs/${s.org.username}/projects/424242`, { method: "DELETE", headers: authHeaders(s.owner.id) })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

describe("columns: list / create / get / edit / delete / default / move", () => {
  it("round-trips columns on an org board (orders by sorting,id; closed 403; default guard; move 422)", async () => {
    const s = await seedOrgAndActors("cols");
    const project = await seedOrgProject(s.org.id, s.owner.id);
    const closed = await seedOrgProject(s.org.id, s.owner.id, { title: "Closed", isClosed: true });
    const send = router();
    const base = `/orgs/${s.org.username}/projects`;

    const a = await send(`${base}/${project.id}/columns`, { method: "POST", headers: authHeaders(s.owner.id), body: JSON.stringify({ title: "A", color: "#00AAbb" }) });
    expect(a.status).toBe(201);
    const aBody = await a.json<{ id: number; title: string; color?: string; sorting: number; project_id: number }>();
    expect(aBody).toMatchObject({ title: "A", color: "#00AAbb", sorting: 0, project_id: project.id });
    const b = await send(`${base}/${project.id}/columns`, { method: "POST", headers: authHeaders(s.owner.id), body: JSON.stringify({ title: "B" }) });
    const bBody = await b.json<{ id: number }>();

    const list = await send(`${base}/${project.id}/columns`, { headers: authHeaders(s.owner.id) });
    expect(list.headers.get("x-total-count")).toBe("2");
    expect((await list.json<Array<Record<string, unknown>>>()).map((c) => c.title)).toEqual(["A", "B"]);

    // Closed project: the shared handler's 403 (not the gate's 404).
    const closedRes = await send(`${base}/${closed.id}/columns`, { method: "POST", headers: authHeaders(s.owner.id), body: JSON.stringify({ title: "x" }) });
    expect(closedRes.status).toBe(403);
    expect((await closedRes.json<Record<string, string>>()).message).toBe("project is closed");

    const badColor = await send(`${base}/${project.id}/columns/${bBody.id}`, { method: "PATCH", headers: authHeaders(s.owner.id), body: JSON.stringify({ color: "red" }) });
    expect(badColor.status).toBe(422);
    expect((await badColor.json<Record<string, string>>()).message).toBe(`invalid column color "red", expected a 6-digit hex string like #FF0000`);

    // Set B default, then A is deletable only while not default; B refuses.
    expect((await send(`${base}/${project.id}/columns/${bBody.id}/default`, { method: "POST", headers: authHeaders(s.owner.id) })).status).toBe(204);
    const delDefault = await send(`${base}/${project.id}/columns/${bBody.id}`, { method: "DELETE", headers: authHeaders(s.owner.id) });
    expect(delDefault.status).toBe(422);
    expect((await delDefault.json<Record<string, string>>()).message).toBe("cannot delete the default column");

    const badMove = await send(`${base}/${project.id}/columns/move`, { method: "POST", headers: authHeaders(s.owner.id), body: JSON.stringify({ column_ids: [aBody.id] }) });
    expect(badMove.status).toBe(422);
    expect((await badMove.json<Record<string, string>>()).message).toBe("column_ids must list every column of the project exactly once");
    const move = await send(`${base}/${project.id}/columns/move`, { method: "POST", headers: authHeaders(s.owner.id), body: JSON.stringify({ column_ids: [bBody.id, aBody.id] }) });
    expect(move.status).toBe(204);

    // Write gate below write → 404 (the org arm has no 403 writer gate).
    const reader = await seedUser("o-col-reader");
    await seedTeam(s.org.id, reader.id, "read");
    expect(
      (await send(`${base}/${project.id}/columns`, { method: "POST", headers: authHeaders(reader.id), body: JSON.stringify({ title: "x" }) })).status,
    ).toBe(404);
    // Cross-project column id under the same org → 404.
    const foreignColumn = await seedColumn(closed.id);
    const cross = await send(`${base}/${project.id}/columns/${foreignColumn.id}`, { headers: authHeaders(s.owner.id) });
    expect(cross.status).toBe(404);
    expect((await cross.json<Record<string, string>>()).message).toBe(`project column does not exist [id: ${foreignColumn.id}]`);
  });
});

// ---------------------------------------------------------------------------
// Column issues (the owner arms: global issue lookup, per-issue gates)
// ---------------------------------------------------------------------------

describe("column issues: add / list / remove / move (owner arms)", () => {
  it("adds org-repo and outside-org issues (global lookup), 423s archived, 404s invisible", async () => {
    const s = await seedOrgAndActors("add");
    const orgRepo = await seedOrgRepo(s.org, "lib");
    const archivedRepo = await seedOrgRepo(s.org, "old", { isArchived: true });
    const orgPrivate = await seedOrgRepo(s.org, "secret", { visibility: "private" });
    const stranger = await seedUser("o-stranger");
    const strangerPrivate = await seedUserRepo(stranger, "diary", "private");
    const issue = await seedIssue(orgRepo, 1);
    const archivedIssue = await seedIssue(archivedRepo, 1);
    const privateOrgIssue = await seedIssue(orgPrivate, 1);
    const strangerIssue = await seedIssue(strangerPrivate, 1);
    const project = await seedOrgProject(s.org.id, s.owner.id);
    await seedColumn(project.id, { title: "Backlog", isDefault: true });
    const target = await seedColumn(project.id, { title: "In Progress", sorting: 1 });
    const send = router();
    const base = `/orgs/${s.org.username}/projects/${project.id}/columns/${target.id}/issues`;

    // Unknown global id → ErrIssueNotExist{id, 0, 0}.
    const unknown = await send(`${base}/987654`, { method: "POST", headers: authHeaders(s.owner.id) });
    expect(unknown.status).toBe(404);
    expect((await unknown.json<Record<string, string>>()).message).toBe("issue does not exist [id: 987654, repo_id: 0, index: 0]");
    // The issue's archived repo → the per-issue 423 (no group mustNotBeArchived here).
    const locked = await send(`${base}/${archivedIssue.id}`, { method: "POST", headers: authHeaders(s.owner.id) });
    expect(locked.status).toBe(423);
    expect((await locked.json<Record<string, string>>()).message).toBe("repo is archived");
    // A repo the doer cannot READ (a stranger's private repo — the issue arm's
    // CanReadIssuesOrPulls miss) hides behind the plain 404.
    expect((await send(`${base}/${strangerIssue.id}`, { method: "POST", headers: authHeaders(s.owner.id) })).status).toBe(404);

    // Org-repo issue lands (201, the 30/31 system comments).
    expect((await send(`${base}/${issue.id}`, { method: "POST", headers: authHeaders(s.owner.id) })).status).toBe(201);
    const written = await db().select().from(comments).where(eq(comments.issueId, issue.id)).orderBy(comments.id).all();
    expect(written.map((c) => c.type)).toEqual([30, 31]);

    // The org's own PRIVATE repo is readable through the org-owner bridge
    // (SPEC-0007 §3.3) — the issue arm passes and the item lands.
    expect((await send(`${base}/${privateOrgIssue.id}`, { method: "POST", headers: authHeaders(s.owner.id) })).status).toBe(201);

    // Outside-org PUBLIC issue is addable (GetIssueByID is global).
    const publicRepo = await seedUserRepo(stranger, "publicthings");
    const outsideIssue = await seedIssue(publicRepo, 1);
    expect((await send(`${base}/${outsideIssue.id}`, { method: "POST", headers: authHeaders(s.owner.id) })).status).toBe(201);
  });

  it("lists the column's org-repo issues sorted; outside-org issues stay assigned but never list", async () => {
    const s = await seedOrgAndActors("listiss");
    const orgRepo = await seedOrgRepo(s.org, "lib");
    const orgPrivate = await seedOrgRepo(s.org, "secret", { visibility: "private" });
    const stranger = await seedUser("o-stranger-list");
    const publicRepo = await seedUserRepo(stranger, "publicthings");
    const project = await seedOrgProject(s.org.id, s.owner.id);
    const def = await seedColumn(project.id, { title: "Backlog", isDefault: true });
    const i1 = await seedIssue(orgRepo, 1);
    const i2 = await seedIssue(orgRepo, 2);
    const privIssue = await seedIssue(orgPrivate, 1);
    const outside = await seedIssue(publicRepo, 1);
    await seedMembership(i2.id, project.id, def.id, 0);
    await seedMembership(i1.id, project.id, 0, 5); // legacy-0 → claims via the default
    await seedMembership(privIssue.id, project.id, def.id);
    await seedMembership(outside.id, project.id, def.id); // assigned — but outside the org

    const send = router();
    // Anonymous: only the public org-repo issue survives the AllPublic arm.
    const anon = await send(`/orgs/${s.org.username}/projects/${project.id}/columns/${def.id}/issues`);
    expect(anon.status).toBe(200);
    expect(anon.headers.get("x-total-count")).toBe("2");
    expect((await anon.json<Array<Record<string, unknown>>>()).map((i) => i.number)).toEqual([2, 1]); // sorting ASC
    // The org owner sees the private-repo item too; the outside-org issue
    // never lists for anyone (issuesOpts.Owner).
    const owned = await send(`/orgs/${s.org.username}/projects/${project.id}/columns/${def.id}/issues`, {
      headers: authHeaders(s.owner.id),
    });
    expect(owned.headers.get("x-total-count")).toBe("3");
    // A team-granted member (includes-all read team) sees the private-repo
    // item as well — the Doer arm runs the landed team predicate.
    const member = await seedUser("o-team-list");
    await seedTeam(s.org.id, member.id, "read", { includesAll: true });
    const granted = await send(`/orgs/${s.org.username}/projects/${project.id}/columns/${def.id}/issues`, {
      headers: authHeaders(member.id),
    });
    expect(granted.headers.get("x-total-count")).toBe("3");
    const missing = await send(`/orgs/${s.org.username}/projects/${project.id}/columns/424242/issues`);
    expect(missing.status).toBe(404);
  });

  it("remove 404s outside the column, detaches with the comment; move validates target then membership", async () => {
    const s = await seedOrgAndActors("mviz");
    const orgRepo = await seedOrgRepo(s.org, "lib");
    const project = await seedOrgProject(s.org.id, s.owner.id);
    const a = await seedColumn(project.id, { title: "A", isDefault: true });
    const b = await seedColumn(project.id, { title: "B", sorting: 1 });
    const otherProject = await seedOrgProject(s.org.id, s.owner.id, { title: "Other" });
    const foreignColumn = await seedColumn(otherProject.id);
    const member = await seedIssue(orgRepo, 1);
    const outsider = await seedIssue(orgRepo, 2);
    await seedMembership(member.id, project.id, a.id);
    const send = router();
    const removeBase = `/orgs/${s.org.username}/projects/${project.id}/columns/${a.id}/issues`;

    const notInColumn = await send(`${removeBase}/${outsider.id}`, { method: "DELETE", headers: authHeaders(s.owner.id) });
    expect(notInColumn.status).toBe(404);
    expect((await notInColumn.json<Record<string, string>>()).message).toBe(`issue ${outsider.id} is not in column ${a.id}`);

    const moveUrl = `/orgs/${s.org.username}/projects/${project.id}/issues/${member.id}/move`;
    const foreign = await send(moveUrl, { method: "POST", headers: authHeaders(s.owner.id), body: JSON.stringify({ column_id: foreignColumn.id }) });
    expect(foreign.status).toBe(422);
    expect((await foreign.json<Record<string, string>>()).message).toBe("target column does not belong to this project");
    const noMember = await send(`/orgs/${s.org.username}/projects/${project.id}/issues/${outsider.id}/move`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ column_id: b.id }),
    });
    expect(noMember.status).toBe(422);
    expect((await noMember.json<Record<string, string>>()).message).toBe("all issues have to be added to a project first");

    const move = await send(moveUrl, { method: "POST", headers: authHeaders(s.owner.id), body: JSON.stringify({ column_id: b.id, sorting: 42 }) });
    expect(move.status).toBe(204);
    const membership = (await db().select().from(projectIssues).where(eq(projectIssues.issueId, member.id)).all())[0];
    expect(membership).toMatchObject({ projectColumnId: b.id, sorting: 42 });

    const remove = await send(`${removeBase}/${member.id}`, { method: "DELETE", headers: authHeaders(s.owner.id) });
    expect(remove.status).toBe(404); // member is in column B now, not A
    const removeB = await send(`/orgs/${s.org.username}/projects/${project.id}/columns/${b.id}/issues/${member.id}`, {
      method: "DELETE",
      headers: authHeaders(s.owner.id),
    });
    expect(removeB.status).toBe(204);
    expect(await db().select().from(projectIssues).where(eq(projectIssues.issueId, member.id)).all()).toHaveLength(0);
    // Comments: the A→B move wrote the type-31 column change; the removal
    // writes the type-30 detach ({old_project_id, project_id: 0}).
    const written = await db().select().from(comments).where(eq(comments.issueId, member.id)).orderBy(comments.id).all();
    expect(written.map((c) => c.type)).toEqual([31, 30]);
    expect(JSON.parse(written[0]?.content ?? "{}")).toEqual({
      project_id: project.id,
      project_column_id: b.id,
      project_column_title: "B",
    });
    expect(JSON.parse(written[1]?.content ?? "{}")).toEqual({ old_project_id: project.id, project_id: 0 });
  });
});

// ---------------------------------------------------------------------------
// Workflows (the org arm of CanManageWorkflows)
// ---------------------------------------------------------------------------

describe("workflows: the org-owner manage gate + CRUD", () => {
  it("a Projects-unit writer who is NOT an org owner fails CanManageWorkflows with the exact 403", async () => {
    const s = await seedOrgAndActors("wfgate");
    const project = await seedOrgProject(s.org.id, s.owner.id);
    const writer = await seedUser("o-wf-writer");
    await seedTeam(s.org.id, writer.id, "write"); // passes the write gate (404-avoided)…
    const send = router();
    const base = `/orgs/${s.org.username}/projects/${project.id}/workflows`;
    const res = await send(base, {
      method: "POST",
      headers: authHeaders(writer.id),
      body: JSON.stringify({ event: "item_added_to_project", actions: { issue_state: "close" } }),
    });
    expect(res.status).toBe(403);
    expect((await res.json<Record<string, string>>()).message).toBe("not allowed to manage the workflows of this project");
    // …while the org owner sails through and gets the capability validations.
    const badEvent = await send(base, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ event: "nonsense", actions: { issue_state: "close" } }),
    });
    expect(badEvent.status).toBe(422);
    expect((await badEvent.json<Record<string, string>>()).message).toBe("invalid event: nonsense");
  });

  it("round-trips a workflow with org-label validation, tri-state edit, foreign 404, delete", async () => {
    const s = await seedOrgAndActors("wf");
    const project = await seedOrgProject(s.org.id, s.owner.id);
    await seedColumn(project.id, { isDefault: true });
    const orgLabel = await db()
      .insert(labels)
      .values({ orgId: s.org.id, repoId: null, name: "org-bug", color: "#ff0000" })
      .returning()
      .all();
    const send = router();
    const base = `/orgs/${s.org.username}/projects/${project.id}/workflows`;

    const ok = await send(base, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ event: "item_added_to_project", actions: { issue_state: "close", add_label_ids: [orgLabel[0]?.id, orgLabel[0]?.id] } }),
    });
    expect(ok.status).toBe(201);
    const body = await ok.json<{ id: number; actions?: { add_label_ids?: number[] } }>();
    expect(body).toMatchObject({ event: "item_added_to_project", enabled: true, actions: { issue_state: "close" } });
    expect(body.actions?.add_label_ids).toEqual([orgLabel[0]?.id]); // deduped, org-pool validated

    const badLabel = await send(base, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ event: "item_added_to_project", actions: { add_label_ids: [424242] } }),
    });
    expect((await badLabel.json<Record<string, string>>()).message).toBe("invalid label: 424242");

    const list = await send(base, { headers: authHeaders(s.owner.id) });
    expect(list.headers.get("x-total-count")).toBe("1");

    // Foreign workflow id under this project → 404 BEFORE the manage check.
    const other = await seedOrgProject(s.org.id, s.owner.id, { title: "Other" });
    const foreignWf = await db()
      .insert(projectWorkflows)
      .values({
        projectId: other.id,
        event: "item_closed",
        filters: JSON.stringify({}),
        actions: JSON.stringify({ issue_state: "close" }),
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning()
      .all();
    const foreignId = foreignWf[0]?.id ?? 0;
    const foreign = await send(`${base}/${foreignId}`, { method: "PATCH", headers: authHeaders(s.owner.id), body: JSON.stringify({ enabled: false }) });
    expect(foreign.status).toBe(404);
    expect((await foreign.json<Record<string, string>>()).message).toBe(`ProjectWorkflow does not exist [id: ${foreignId}]`);

    const edit = await send(`${base}/${body.id}`, { method: "PATCH", headers: authHeaders(s.owner.id), body: JSON.stringify({ enabled: false }) });
    expect(edit.status).toBe(200);
    expect(await edit.json<Record<string, unknown>>()).toMatchObject({ id: body.id, enabled: false });
    const noop = await send(`${base}/${body.id}`, { method: "PATCH", headers: authHeaders(s.owner.id), body: JSON.stringify({}) });
    expect(noop.status).toBe(200);

    // Closed projects reject workflow mutations with the shared 403.
    const closed = await seedOrgProject(s.org.id, s.owner.id, { title: "Closed", isClosed: true });
    const closedRes = await send(`/orgs/${s.org.username}/projects/${closed.id}/workflows`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ event: "item_closed", actions: { issue_state: "close" } }),
    });
    expect(closedRes.status).toBe(403);
    expect((await closedRes.json<Record<string, string>>()).message).toBe("project is closed");

    const del = await send(`${base}/${body.id}`, { method: "DELETE", headers: authHeaders(s.owner.id) });
    expect(del.status).toBe(204);
    expect(await db().select().from(projectWorkflows).where(eq(projectWorkflows.id, body.id)).all()).toHaveLength(0);
  });
});

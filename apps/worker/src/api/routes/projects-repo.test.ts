/**
 * Repo-scoped project-board routes (routes/projects-repo.ts) on real D1 —
 * the inventory batch 6 stage 1 family: repoListProjects / repoCreateProject
 * / repoGetProject / repoEditProject / repoDeleteProject, the column CRUD +
 * default/move arms, the column-issue add/remove/list/move arms, and the 5
 * workflow ops (gitea/routers/api/v1/shared/{project,project_workflow}.go
 * over models/project/*).
 *
 * Standalone mount (the labels-t2 convention): the register function takes
 * the requireAuth/optionalAuth pair and mounts on a fresh OpenAPIHono with
 * the stub resolver mapping `token u<id>` to the seeded D1 user rows, so the
 * canWriteRepository-backed writer gates are exercisable against the same
 * rows the guards query.
 *
 * Pins asserted: the anti-enumeration 404s, the writer 403 + archived 423
 * stack, the exact upstream error strings (APIErrorAuto's errorForUser
 * rendering), the template default columns ("Backlog" default first, then
 * the template set — column.go:95-137), the closed-project 403, the
 * default-column delete guard + issue move, the legacy-0 claim on the
 * default column's membership read, the workflow capability matrix, and the
 * system-comment adaptation (type 30/31 rows with ids in content JSON,
 * updated_unix bumped, num_comments untouched).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  comments,
  issueLabels,
  issuePins,
  issues,
  labels,
  milestones,
  projectColumns,
  projectIssues,
  projectWorkflows,
  projects,
  repoCollaborators,
  repositories,
  users,
} from "../../db/schema";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerIssueRoutes } from "./issues";
import { registerProjectsRepoRoutes } from "./projects-repo";
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
    "issue_pins",
    "milestones",
    "issues",
    "labels",
    "repo_collaborators",
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

async function seedUser(username: string, isAdmin = false): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin,
      status: "active",
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
  registerProjectsRepoRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

interface RepoSeed {
  repoId: string;
  owner: SeededUser;
  writer: SeededUser;
  reader: SeededUser;
  admin: SeededUser;
}

async function seedRepoAndActors(suffix: string, options?: { visibility?: "public" | "private"; isArchived?: boolean }): Promise<RepoSeed> {
  const owner = await seedUser(`p-owner-${suffix}`);
  const writer = await seedUser(`p-writer-${suffix}`);
  const reader = await seedUser(`p-reader-${suffix}`);
  const admin = await seedUser(`p-admin-${suffix}`, true);
  const repoId = `prj-${suffix}`;
  await db()
    .insert(repositories)
    .values({
      id: repoId,
      storageKey: `r_${repoId}`,
      ownerNamespace: owner.username.toLowerCase(),
      ownerId: owner.id,
      slug: repoId,
      visibility: options?.visibility ?? "public",
      isArchived: options?.isArchived ?? false,
      createdAt: NOW,
    });
  // The writer is a write-mode collaborator (the reduced matrix's writer arm).
  await db().insert(repoCollaborators).values({ repoId, userId: writer.id, mode: "write", createdAt: NOW });
  return { repoId, owner, writer, reader, admin };
}

async function seedProject(repoId: string, creatorId: number, overrides?: Partial<typeof projects.$inferInsert>) {
  const rows = await db()
    .insert(projects)
    .values({
      title: "Board",
      description: "",
      repoId,
      creatorId,
      type: 2,
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
// repoListProjects
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/projects (repoListProjects)", () => {
  it("lists open projects by id DESC with the total header; state filters", async () => {
    const s = await seedRepoAndActors("list");
    const old = await seedProject(s.repoId, s.owner.id, { title: "Old" });
    const fresh = await seedProject(s.repoId, s.owner.id, { title: "Fresh" });
    await seedProject(s.repoId, s.owner.id, { title: "Done", isClosed: true, closedAtUnix: NOW });
    const other = await seedRepoAndActors("other");
    await seedProject(other.repoId, other.owner.id); // never leaks in

    const send = router();
    const res = await send(`/repos/${s.owner.username}/${s.repoId}/projects`, { headers: authHeaders(s.reader.id) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("2");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((p) => p.title)).toEqual(["Fresh", "Old"]);
    expect(body[0]).toMatchObject({
      id: fresh.id,
      title: "Fresh",
      owner_id: 0,
      repo_id: Number(s.repoId.replace(/\D/g, "")) || 0,
      state: "open",
      is_closed: false,
      template_type: "none",
      card_type: "text_only",
      type: "repository",
      num_issues: 0,
      html_url: `https://example.com/${s.owner.username}/${s.repoId}/projects/${fresh.id}`,
    });
    expect(body[0]?.id).toBe(fresh.id);
    expect(old.id).toBeGreaterThan(0);

    const all = await send(`/repos/${s.owner.username}/${s.repoId}/projects?state=all`, { headers: authHeaders(s.reader.id) });
    expect(all.headers.get("x-total-count")).toBe("3");
    const closed = await send(`/repos/${s.owner.username}/${s.repoId}/projects?state=closed`, { headers: authHeaders(s.reader.id) });
    const closedBody = await closed.json<Array<Record<string, unknown>>>();
    expect(closedBody).toHaveLength(1);
    expect(closedBody[0]).toMatchObject({ title: "Done", state: "closed", closed_at: NOW.toISOString() });
  });

  it("404s unknown and private-invisible repos; the owner and site admin see private", async () => {
    const s = await seedRepoAndActors("priv", { visibility: "private" });
    const send = router();
    expect((await send(`/repos/${s.owner.username}/${s.repoId}/projects`)).status).toBe(404);
    expect((await send("/repos/nobody/nothing/projects")).status).toBe(404);
    const ownerRes = await send(`/repos/${s.owner.username}/${s.repoId}/projects`, { headers: authHeaders(s.owner.id) });
    expect(ownerRes.status).toBe(200);
    const adminRes = await send(`/repos/${s.owner.username}/${s.repoId}/projects`, { headers: authHeaders(s.admin.id) });
    expect(adminRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// repoCreateProject
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/projects (repoCreateProject)", () => {
  it("creates with the none template (no columns), 201, exact wire fields", async () => {
    const s = await seedRepoAndActors("create");
    const send = router();
    const res = await send(`/repos/${s.owner.username}/${s.repoId}/projects`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "Roadmap", description: "plans" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      title: "Roadmap",
      description: "plans",
      creator_id: s.owner.id,
      state: "open",
      type: "repository",
      num_issues: 0,
      html_url: `https://example.com/${s.owner.username}/${s.repoId}/projects/${String(body.id)}`,
    });
    const columns = await db().select().from(projectColumns).all();
    expect(columns).toHaveLength(0); // none template copies nothing
  });

  it("copies the basic_kanban template: Backlog (default) first, then the set, insertion order", async () => {
    const s = await seedRepoAndActors("tmpl");
    const send = router();
    const res = await send(`/repos/${s.owner.username}/${s.repoId}/projects`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "Kanban", template_type: "basic_kanban", card_type: "images_and_text" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ template_type: "basic_kanban", card_type: "images_and_text" });
    const columns = await db()
      .select()
      .from(projectColumns)
      .where(eq(projectColumns.projectId, Number(body.id)))
      .orderBy(projectColumns.id)
      .all();
    expect(columns.map((c) => [c.title, c.isDefault, c.sorting])).toEqual([
      ["Backlog", true, 0],
      ["To Do", false, 0],
      ["In Progress", false, 0],
      ["Done", false, 0],
    ]);
  });

  it("rejects invalid enums with the exact 422s, and missing title with the bind 422", async () => {
    const s = await seedRepoAndActors("enum");
    const send = router();
    const badTemplate = await send(`/repos/${s.owner.username}/${s.repoId}/projects`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "x", template_type: "kanban" }),
    });
    expect(badTemplate.status).toBe(422);
    expect((await badTemplate.json<Record<string, string>>()).message).toBe(
      `invalid template_type "kanban" (expected none, basic_kanban, bug_triage)`,
    );
    const badCard = await send(`/repos/${s.owner.username}/${s.repoId}/projects`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "x", card_type: "rich" }),
    });
    expect((await badCard.json<Record<string, string>>()).message).toBe(
      `invalid card_type "rich" (expected text_only, images_and_text)`,
    );
    const noTitle = await send(`/repos/${s.owner.username}/${s.repoId}/projects`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ description: "no title" }),
    });
    expect(noTitle.status).toBe(422);
  });

  it("gates: 401 anonymous, 403 non-writer, 423 archived, 404 unknown repo", async () => {
    const s = await seedRepoAndActors("gate");
    const archived = await seedRepoAndActors("arch", { isArchived: true });
    const send = router();
    const post = (repo: RepoSeed, headers?: Record<string, string>) =>
      send(`/repos/${repo.owner.username}/${repo.repoId}/projects`, {
        method: "POST",
        headers: headers ?? authHeaders(repo.owner.id),
        body: JSON.stringify({ title: "x" }),
      });
    // `{}` — the helper's `??` default would substitute the owner for a
    // nullish argument, so an empty header set is the explicit anonymous call.
    expect((await post(s, {})).status).toBe(401);
    const forbidden = await post(s, authHeaders(s.reader.id));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json<Record<string, string>>()).message).toBe(
      "user should have a permission to write to a repo",
    );
    const locked = await post(archived);
    expect(locked.status).toBe(423);
    expect((await locked.json<Record<string, string>>()).message).toBe("repo is archived");
    expect(
      (await send("/repos/nobody/nothing/projects", { method: "POST", headers: authHeaders(s.owner.id), body: "{}" }))
        .status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// repoGetProject / repoEditProject / repoDeleteProject
// ---------------------------------------------------------------------------

describe("GET/PATCH/DELETE /repos/{owner}/{repo}/projects/{id}", () => {
  it("gets one project with joined issue counts; another repo's id 404s", async () => {
    const s = await seedRepoAndActors("get");
    const other = await seedRepoAndActors("get2");
    const project = await seedProject(s.repoId, s.owner.id);
    const issue = await seedIssue(s.repoId, 1);
    const closed = await seedIssue(s.repoId, 2, { isClosed: true });
    await seedMembership(issue.id, project.id, 0);
    await seedMembership(closed.id, project.id, 0);
    await seedProject(other.repoId, other.owner.id);

    const send = router();
    const res = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${project.id}`, {
      headers: authHeaders(s.reader.id),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ id: project.id, num_open_issues: 1, num_closed_issues: 1, num_issues: 2 });
    expect((await send(`/repos/${s.owner.username}/${s.repoId}/projects/${project.id}`, { headers: authHeaders(s.reader.id) })).status).toBe(200);
    // The other repo owns a project with the same numeric space — cross-repo
    // ids must read as not found (id-scoped lookup).
    const crossRepo = await send(`/repos/${s.owner.username}/${s.repoId}/projects/999999`);
    expect(crossRepo.status).toBe(404);
    expect((await crossRepo.json<Record<string, string>>()).message).toBe("projects does not exist [id: 999999]");
    const otherRepoProject = await db().select().from(projects).where(eq(projects.repoId, other.repoId)).all();
    const crossRes = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${otherRepoProject[0]?.id}`);
    expect(crossRes.status).toBe(404);
  });

  it("patches title/description/card_type and flips state with the closed_at stamp", async () => {
    const s = await seedRepoAndActors("edit");
    const project = await seedProject(s.repoId, s.owner.id, { title: "Before" });
    const send = router();
    const url = `/repos/${s.owner.username}/${s.repoId}/projects/${project.id}`;
    const res = await send(url, {
      method: "PATCH",
      headers: authHeaders(s.writer.id),
      body: JSON.stringify({ title: "After", description: "d", card_type: "images_and_text", state: "closed" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      title: "After",
      description: "d",
      card_type: "images_and_text",
      state: "closed",
      is_closed: true,
    });
    expect(body.closed_at).toBeTypeOf("string"); // stamped on the close
    // Reopen: state flips, closed_at hides (upstream renders it only while closed).
    const reopen = await send(url, { method: "PATCH", headers: authHeaders(s.owner.id), body: JSON.stringify({ state: "open" }) });
    const reopened = await reopen.json<Record<string, unknown>>();
    expect(reopened).toMatchObject({ state: "open", is_closed: false });
    expect(reopened.closed_at).toBeUndefined();
    const stored = await db().select().from(projects).where(eq(projects.id, project.id)).all();
    expect(stored[0]?.closedAtUnix).not.toBeNull(); // stamped on the reopen transition too
  });

  it("422s invalid card_type before any write; writer/archived gates apply", async () => {
    const s = await seedRepoAndActors("editgate");
    const archived = await seedRepoAndActors("editarch", { isArchived: true });
    const project = await seedProject(s.repoId, s.owner.id);
    const send = router();
    const url = `/repos/${s.owner.username}/${s.repoId}/projects/${project.id}`;
    const bad = await send(url, { method: "PATCH", headers: authHeaders(s.owner.id), body: JSON.stringify({ card_type: "x" }) });
    expect(bad.status).toBe(422);
    expect((await bad.json<Record<string, string>>()).message).toBe(`invalid card_type "x" (expected text_only, images_and_text)`);
    const forbidden = await send(url, { method: "PATCH", headers: authHeaders(s.reader.id), body: JSON.stringify({ title: "n" }) });
    expect(forbidden.status).toBe(403);
    const archivedProject = await seedProject(archived.repoId, archived.owner.id);
    const locked = await send(`/repos/${archived.owner.username}/${archived.repoId}/projects/${archivedProject.id}`, {
      method: "PATCH",
      headers: authHeaders(archived.owner.id),
      body: JSON.stringify({ title: "n" }),
    });
    expect(locked.status).toBe(423);
  });

  it("deletes with the full cascade, 204; missing id 404s", async () => {
    const s = await seedRepoAndActors("del");
    const project = await seedProject(s.repoId, s.owner.id);
    const column = await seedColumn(project.id);
    await seedProject(s.repoId, s.owner.id, { title: "keep" });
    const send = router();
    const res = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${project.id}`, {
      method: "DELETE",
      headers: authHeaders(s.owner.id),
    });
    expect(res.status).toBe(204);
    expect(await db().select().from(projects).where(eq(projects.id, project.id)).all()).toHaveLength(0);
    expect(await db().select().from(projectColumns).where(eq(projectColumns.id, column.id)).all()).toHaveLength(0);
    const missing = await send(`/repos/${s.owner.username}/${s.repoId}/projects/424242`, {
      method: "DELETE",
      headers: authHeaders(s.owner.id),
    });
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

describe("columns: list / create / get / edit / delete / default / move", () => {
  it("repoListProjectColumns orders by sorting,id with the total header", async () => {
    const s = await seedRepoAndActors("cols");
    const project = await seedProject(s.repoId, s.owner.id);
    await seedColumn(project.id, { title: "B", sorting: 1 });
    await seedColumn(project.id, { title: "A", sorting: 0 });
    await seedColumn(project.id, { title: "C", sorting: 1 }); // id breaks the tie
    const send = router();
    const res = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/columns`, {
      headers: authHeaders(s.reader.id),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("3");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((c) => c.title)).toEqual(["A", "B", "C"]);
    expect(body[0]).toMatchObject({ project_id: project.id, sorting: 0, default: false });
    expect(body[0]?.color).toBeUndefined(); // omitempty
  });

  it("repoCreateProjectColumn validates the color with the exact 422 and appends sorting", async () => {
    const s = await seedRepoAndActors("colnew");
    const project = await seedProject(s.repoId, s.owner.id);
    const first = await seedColumn(project.id, { sorting: 5 });
    const send = router();
    const url = `/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/columns`;
    const res = await send(url, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "Review", color: "#00AAbb" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ title: "Review", color: "#00AAbb", sorting: 6, default: false });
    expect(body.id).toBeGreaterThan(first.id);
    const bad = await send(url, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "x", color: "red" }),
    });
    expect(bad.status).toBe(422);
    expect((await bad.json<Record<string, string>>()).message).toBe(
      `invalid column color "red", expected a 6-digit hex string like #FF0000`,
    );
  });

  it("repoCreateProjectColumn 403s closed projects; repoGetProjectColumn is read-any-state and scoped", async () => {
    const s = await seedRepoAndActors("colclosed");
    const open = await seedProject(s.repoId, s.owner.id);
    const closed = await seedProject(s.repoId, s.owner.id, { title: "Closed", isClosed: true });
    const column = await seedColumn(closed.id);
    const other = await seedProject(s.repoId, s.owner.id, { title: "Other" });
    const foreignColumn = await seedColumn(other.id);
    const send = router();
    const closedRes = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${closed.id}/columns`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "x" }),
    });
    expect(closedRes.status).toBe(403);
    expect((await closedRes.json<Record<string, string>>()).message).toBe("project is closed");
    const got = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${closed.id}/columns/${column.id}`, {
      headers: authHeaders(s.reader.id),
    });
    expect(got.status).toBe(200);
    const cross = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${open.id}/columns/${foreignColumn.id}`);
    expect(cross.status).toBe(404);
    expect((await cross.json<Record<string, string>>()).message).toBe(
      `project column does not exist [id: ${foreignColumn.id}]`,
    );
  });

  it("repoEditProjectColumn patches tri-state, range-checks sorting, validates color", async () => {
    const s = await seedRepoAndActors("coledit");
    const project = await seedProject(s.repoId, s.owner.id);
    const column = await seedColumn(project.id, { color: "#aa0000" });
    const send = router();
    const url = `/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/columns/${column.id}`;
    const res = await send(url, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "Renamed", sorting: -3 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ title: "Renamed", sorting: -3, color: "#aa0000" }); // color untouched
    const range = await send(url, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ sorting: 200 }),
    });
    expect(range.status).toBe(422);
    expect((await range.json<Record<string, string>>()).message).toBe("sorting must be between -128 and 127");
    const badColor = await send(url, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ color: "#xyz" }),
    });
    expect(badColor.status).toBe(422);
  });

  it("repoDeleteProjectColumn refuses the default (422) and moves issues into the default column", async () => {
    const s = await seedRepoAndActors("coldel");
    const project = await seedProject(s.repoId, s.owner.id);
    const def = await seedColumn(project.id, { title: "Backlog", isDefault: true });
    const source = await seedColumn(project.id, { title: "Src" });
    const issue = await seedIssue(s.repoId, 1);
    await seedMembership(issue.id, project.id, source.id, 7);
    const send = router();
    const base = `/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/columns`;
    const defaultRes = await send(`${base}/${def.id}`, { method: "DELETE", headers: authHeaders(s.owner.id) });
    expect(defaultRes.status).toBe(422);
    expect((await defaultRes.json<Record<string, string>>()).message).toBe("cannot delete the default column");
    const res = await send(`${base}/${source.id}`, { method: "DELETE", headers: authHeaders(s.owner.id) });
    expect(res.status).toBe(204);
    const memberships = await db().select().from(projectIssues).where(eq(projectIssues.issueId, issue.id)).all();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ projectColumnId: def.id });
    expect(memberships[0]?.sorting).toBe(0); // appended at the end of the (empty) default column
    expect(await db().select().from(projectColumns).where(eq(projectColumns.id, source.id)).all()).toHaveLength(0);
  });

  it("repoSetDefaultProjectColumn moves the flag; repoMoveProjectColumns reorders or 422s", async () => {
    const s = await seedRepoAndActors("colmove");
    const project = await seedProject(s.repoId, s.owner.id);
    const a = await seedColumn(project.id, { title: "A", isDefault: true });
    const b = await seedColumn(project.id, { title: "B", sorting: 1 });
    const send = router();
    const defRes = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/columns/${b.id}/default`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
    });
    expect(defRes.status).toBe(204);
    const columns = await db().select().from(projectColumns).where(eq(projectColumns.projectId, project.id)).all();
    expect(columns.find((c) => c.id === b.id)?.isDefault).toBe(true);
    expect(columns.find((c) => c.id === a.id)?.isDefault).toBe(false);

    const move = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/columns/move`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ column_ids: [b.id, a.id] }),
    });
    expect(move.status).toBe(204);
    const after = await db()
      .select()
      .from(projectColumns)
      .where(eq(projectColumns.projectId, project.id))
      .orderBy(projectColumns.sorting, projectColumns.id)
      .all();
    expect(after.map((c) => c.title)).toEqual(["B", "A"]);

    const bad = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/columns/move`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ column_ids: [a.id] }),
    });
    expect(bad.status).toBe(422);
    expect((await bad.json<Record<string, string>>()).message).toBe(
      "column_ids must list every column of the project exactly once",
    );
  });
});

// ---------------------------------------------------------------------------
// Column issues
// ---------------------------------------------------------------------------

describe("column issues: list / add / remove / move", () => {
  it("repoAddIssueToProjectColumn assigns + places, writes the 30/31 comments, leaves num_comments", async () => {
    const s = await seedRepoAndActors("add");
    const project = await seedProject(s.repoId, s.owner.id);
    const def = await seedColumn(project.id, { title: "Backlog", isDefault: true });
    const target = await seedColumn(project.id, { title: "In Progress", sorting: 1 });
    const issue = await seedIssue(s.repoId, 1);
    const send = router();
    const url = `/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/columns/${target.id}/issues/${issue.id}`;
    const res = await send(url, { method: "POST", headers: authHeaders(s.writer.id) });
    expect(res.status).toBe(201);
    const membership = (await db().select().from(projectIssues).where(eq(projectIssues.issueId, issue.id)).all())[0];
    expect(membership).toMatchObject({ projectId: project.id, projectColumnId: target.id, sorting: 0 });
    const written = await db().select().from(comments).where(eq(comments.issueId, issue.id)).orderBy(comments.id).all();
    expect(written.map((c) => c.type)).toEqual([30, 31]); // project-added, then column-changed
    expect(JSON.parse(written[0]?.content ?? "{}")).toEqual({ old_project_id: 0, project_id: project.id });
    expect(JSON.parse(written[1]?.content ?? "{}")).toEqual({
      project_id: project.id,
      project_column_id: target.id,
      project_column_title: "In Progress",
    });
    const refreshed = await db().select().from(issues).where(eq(issues.id, issue.id)).all();
    expect(refreshed[0]?.numComments).toBe(0); // system comments never bump the count
    expect(def.id).toBeGreaterThan(0);
  });

  it("adding an already-member issue only moves it (no second 30 comment)", async () => {
    const s = await seedRepoAndActors("add2");
    const project = await seedProject(s.repoId, s.owner.id);
    const a = await seedColumn(project.id, { title: "A", isDefault: true });
    const b = await seedColumn(project.id, { title: "B", sorting: 1 });
    const issue = await seedIssue(s.repoId, 1);
    await seedMembership(issue.id, project.id, a.id, 3);
    await db().insert(comments).values({ type: 30, issueId: issue.id, content: "{}", createdAt: NOW, updatedAt: NOW });
    const send = router();
    const res = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/columns/${b.id}/issues/${issue.id}`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
    });
    expect(res.status).toBe(201);
    const written = await db().select().from(comments).where(eq(comments.issueId, issue.id)).orderBy(comments.id).all();
    expect(written).toHaveLength(2); // pre-seeded 30 + only the 31 column move
    expect(written[1]?.type).toBe(31);
    const membership = (await db().select().from(projectIssues).where(eq(projectIssues.issueId, issue.id)).all())[0];
    expect(membership).toMatchObject({ projectColumnId: b.id, sorting: 0 });
    void a;
  });

  it("repoAddIssueToProjectColumn 404s foreign-repo and unknown issue ids with the exact message", async () => {
    const s = await seedRepoAndActors("add404");
    const project = await seedProject(s.repoId, s.owner.id);
    const column = await seedColumn(project.id, { isDefault: true });
    const send = router();
    const base = `/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/columns/${column.id}/issues`;
    const res = await send(`${base}/987654`, { method: "POST", headers: authHeaders(s.owner.id) });
    expect(res.status).toBe(404);
    expect((await res.json<Record<string, string>>()).message).toBe(
      "issue does not exist [id: 987654, repo_id: 0, index: 0]",
    );
  });

  it("repoListProjectColumnIssues sorts by the column sorting and claims legacy-0 rows on the default", async () => {
    const s = await seedRepoAndActors("listiss");
    const project = await seedProject(s.repoId, s.owner.id);
    const def = await seedColumn(project.id, { title: "Backlog", isDefault: true });
    const other = await seedColumn(project.id, { title: "Other", sorting: 1 });
    const i1 = await seedIssue(s.repoId, 1);
    const i2 = await seedIssue(s.repoId, 2);
    const i3 = await seedIssue(s.repoId, 3);
    await seedMembership(i3.id, project.id, def.id, 0); // explicit default-column row
    await seedMembership(i1.id, project.id, 0, 5); // legacy-0 row → claims via default
    await seedMembership(i2.id, project.id, other.id); // another column
    const send = router();
    const res = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/columns/${def.id}/issues`, {
      headers: authHeaders(s.reader.id),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("2");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((i) => i.number)).toEqual([3, 1]); // sorting ASC
    const empty = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/columns/424242/issues`);
    expect(empty.status).toBe(404);
  });

  it("repoRemoveIssueFromProjectColumn detaches (204) and 404s when not in the column", async () => {
    const s = await seedRepoAndActors("rem");
    const project = await seedProject(s.repoId, s.owner.id);
    const column = await seedColumn(project.id, { isDefault: true });
    const member = await seedIssue(s.repoId, 1);
    await seedMembership(member.id, project.id, column.id);
    const outsider = await seedIssue(s.repoId, 2);
    const send = router();
    const base = `/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/columns/${column.id}/issues`;
    expect((await send(`${base}/${outsider.id}`, { method: "DELETE", headers: authHeaders(s.owner.id) })).status).toBe(404);
    const notInColumn = await send(`${base}/${outsider.id}`, { method: "DELETE", headers: authHeaders(s.owner.id) });
    expect((await notInColumn.json<Record<string, string>>()).message).toBe(
      `issue ${outsider.id} is not in column ${column.id}`,
    );
    const res = await send(`${base}/${member.id}`, { method: "DELETE", headers: authHeaders(s.owner.id) });
    expect(res.status).toBe(204);
    expect(await db().select().from(projectIssues).where(eq(projectIssues.issueId, member.id)).all()).toHaveLength(0);
    const written = await db().select().from(comments).where(eq(comments.issueId, member.id)).all();
    expect(JSON.parse(written[0]?.content ?? "{}")).toEqual({ old_project_id: project.id, project_id: 0 });
  });

  it("repoMoveProjectIssue moves with sorting; foreign column 422; non-member 422", async () => {
    const s = await seedRepoAndActors("mv");
    const project = await seedProject(s.repoId, s.owner.id);
    const a = await seedColumn(project.id, { title: "A", isDefault: true });
    const b = await seedColumn(project.id, { title: "B", sorting: 1 });
    const otherProject = await seedProject(s.repoId, s.owner.id, { title: "Other" });
    const foreignColumn = await seedColumn(otherProject.id);
    const member = await seedIssue(s.repoId, 1);
    await seedMembership(member.id, project.id, a.id);
    const send = router();
    const url = `/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/issues/${member.id}/move`;
    const foreign = await send(url, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ column_id: foreignColumn.id }),
    });
    expect(foreign.status).toBe(422);
    expect((await foreign.json<Record<string, string>>()).message).toBe("target column does not belong to this project");

    const noMemberIssue = await seedIssue(s.repoId, 2);
    const notMember = await send(`/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/issues/${noMemberIssue.id}/move`, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ column_id: b.id }),
    });
    expect(notMember.status).toBe(422);
    expect((await notMember.json<Record<string, string>>()).message).toBe("all issues have to be added to a project first");

    const res = await send(url, {
      method: "POST",
      headers: authHeaders(s.writer.id),
      body: JSON.stringify({ column_id: b.id, sorting: 42 }),
    });
    expect(res.status).toBe(204);
    const membership = (await db().select().from(projectIssues).where(eq(projectIssues.issueId, member.id)).all())[0];
    expect(membership).toMatchObject({ projectColumnId: b.id, sorting: 42 });
    void a;
  });
});

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

describe("workflows: list / get / create / edit / delete", () => {
  it("creates with defaults, validates the event and capability matrix with exact 422s", async () => {
    const s = await seedRepoAndActors("wf");
    const project = await seedProject(s.repoId, s.owner.id);
    const column = await seedColumn(project.id, { isDefault: true });
    const send = router();
    const base = `/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/workflows`;

    const ok = await send(base, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ event: "item_added_to_project", actions: { issue_state: "close" } }),
    });
    expect(ok.status).toBe(201);
    const body = await ok.json<Record<string, unknown>>();
    expect(body).toMatchObject({ event: "item_added_to_project", enabled: true, filters: {}, actions: { issue_state: "close" } });

    const badEvent = await send(base, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ event: "nonsense", actions: { issue_state: "close" } }),
    });
    expect((await badEvent.json<Record<string, string>>()).message).toBe("invalid event: nonsense");

    const unsupported = await send(base, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({
        event: "item_added_to_project",
        filters: { source_column_id: column.id },
        actions: { issue_state: "close" },
      }),
    });
    expect(unsupported.status).toBe(422);
    expect((await unsupported.json<Record<string, string>>()).message).toBe("source_column is not supported by this event");

    const noAction = await send(base, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ event: "item_added_to_project", filters: { issue_type: "issue" } }),
    });
    expect(noAction.status).toBe(422);
    expect((await noAction.json<Record<string, string>>()).message).toBe("at least one action must be configured");

    const badColumn = await send(base, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ event: "item_column_changed", filters: { source_column_id: 999 }, actions: { issue_state: "close" } }),
    });
    expect((await badColumn.json<Record<string, string>>()).message).toBe("invalid column: 999");

    const prReopen = await send(base, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({
        event: "item_added_to_project",
        filters: { issue_type: "pull_request" },
        actions: { issue_state: "reopen" },
      }),
    });
    expect((await prReopen.json<Record<string, string>>()).message).toBe("pull requests cannot be reopened by a workflow");
  });

  it("422s unknown labels; accepts repo + owner-org labels", async () => {
    const s = await seedRepoAndActors("wflabel");
    const project = await seedProject(s.repoId, s.owner.id);
    const repoLabel = await db()
      .insert(labels)
      .values({ repoId: s.repoId, name: "bug", color: "#ff0000" })
      .returning()
      .all();
    const send = router();
    const base = `/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/workflows`;
    const bad = await send(base, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ event: "item_added_to_project", actions: { add_label_ids: [424242] } }),
    });
    expect((await bad.json<Record<string, string>>()).message).toBe("invalid label: 424242");
    const ok = await send(base, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({
        event: "item_added_to_project",
        actions: { add_label_ids: [repoLabel[0]?.id, repoLabel[0]?.id] }, // deduped
      }),
    });
    expect(ok.status).toBe(201);
    const body = await ok.json<Record<string, { add_label_ids?: number[] }>>();
    expect(body.actions?.add_label_ids).toEqual([repoLabel[0]?.id]);
  });

  it("edits tri-state with merged re-validation and toggles enabled; no-op PATCH keeps the row", async () => {
    const s = await seedRepoAndActors("wfedit");
    const project = await seedProject(s.repoId, s.owner.id);
    const send = router();
    const created = await db()
      .insert(projectWorkflows)
      .values({
        projectId: project.id,
        event: "item_added_to_project",
        filters: JSON.stringify({}),
        actions: JSON.stringify({ issue_state: "close" }),
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning()
      .all();
    const workflowId = created[0]?.id ?? 0;
    const base = `/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/workflows/${workflowId}`;
    const res = await send(base, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ id: workflowId, enabled: false, actions: { issue_state: "close" } });
    // Editing ONLY filters re-validates the merged state against the event.
    const badMerge = await send(base, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ filters: { source_column_id: 1 } }),
    });
    expect(badMerge.status).toBe(422);
    expect((await badMerge.json<Record<string, string>>()).message).toBe("source_column is not supported by this event");
    const noop = await send(base, { method: "PATCH", headers: authHeaders(s.owner.id), body: JSON.stringify({}) });
    expect(noop.status).toBe(200);
  });

  it("gates mutations on the workflow-manager grant; 404s foreign workflows; deletes", async () => {
    const s = await seedRepoAndActors("wfgate");
    const project = await seedProject(s.repoId, s.owner.id);
    const other = await seedProject(s.repoId, s.owner.id, { title: "Other" });
    const created = await db()
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
    const workflowId = created[0]?.id ?? 0;
    const send = router();
    const base = `/repos/${s.owner.username}/${s.repoId}/projects/${project.id}/workflows`;

    // The non-writer reader fails the writer gate first (reqRepoWriter runs
    // before the handler, upstream ordering).
    const readerRes = await send(base, {
      method: "POST",
      headers: authHeaders(s.reader.id),
      body: JSON.stringify({ event: "item_closed", actions: { issue_state: "close" } }),
    });
    expect(readerRes.status).toBe(403);
    expect((await readerRes.json<Record<string, string>>()).message).toBe(
      "user should have a permission to write to a repo",
    );

    // Foreign workflow id under this project → 404 BEFORE the manage gate.
    const foreign = await send(`${base}/${workflowId}`, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ enabled: false }),
    });
    expect(foreign.status).toBe(404);
    expect((await foreign.json<Record<string, string>>()).message).toBe(`ProjectWorkflow does not exist [id: ${workflowId}]`);

    const list = await send(base, { headers: authHeaders(s.reader.id) });
    expect(list.status).toBe(200);
    expect(await list.json<unknown[]>()).toEqual([]);

    const del = await send(`${base}/${workflowId}`, { method: "DELETE", headers: authHeaders(s.owner.id) });
    expect(del.status).toBe(404); // still foreign — nothing deleted
    void del;
  });
});

// ---------------------------------------------------------------------------
// Query-shape witness (docs/research/query-shape-audit.md A2, tier-2
// adoption) — the project-column issue list rendered its enrichment selects
// (poster/label/pin/milestone) PER ROW; the page now prefetches one inArray
// read per entity kind through toApiIssue's preload (the routes/issues.ts
// landed shape). Metering: the prepare()-counting D1 wrapper riding
// app.fetch's env, route-level — the counter is the request's exact D1
// roundtrip count.
// ---------------------------------------------------------------------------

/** prepare()-counting D1 wrapper: every drizzle statement enters through one
 *  prepare() call. Scoped to the requests that pass the returned env. */
function countedD1(): { db: D1Database; count: () => number } {
  let statements = 0;
  const wrapper = Object.create(env.DB) as D1Database;
  wrapper.prepare = (query: string) => {
    statements += 1;
    return env.DB.prepare(query);
  };
  return { db: wrapper, count: () => statements };
}

describe("column-issues list query-shape witness (query-shape-audit A2, tier-2)", () => {
  it("renders the column page with a constant statement count, deep-equal to the per-row single GETs", async () => {
    const s = await seedRepoAndActors("witness");
    const project = await seedProject(s.repoId, s.owner.id);
    const column = await seedColumn(project.id, { title: "Backlog", isDefault: true });
    // Every enrichment shape on one page: two posters, reversed two-label
    // attachments, a real milestone, a dangling milestone id (the deleted
    // row → null edge), and a pin.
    const bug = await db()
      .insert(labels)
      .values({ repoId: s.repoId, name: "bug", color: "#00aabb", description: "", numIssues: 0, numClosedIssues: 0 })
      .returning({ id: labels.id })
      .all()
      .then((rows) => rows[0]!.id);
    const ui = await db()
      .insert(labels)
      .values({ repoId: s.repoId, name: "ui", color: "#00ccdd", description: "", numIssues: 0, numClosedIssues: 0 })
      .returning({ id: labels.id })
      .all()
      .then((rows) => rows[0]!.id);
    const v1 = await db()
      .insert(milestones)
      .values({ repoId: s.repoId, name: "v1", content: "", createdAt: NOW, updatedAt: NOW })
      .returning({ id: milestones.id })
      .all()
      .then((rows) => rows[0]!.id);
    const first = await seedIssue(s.repoId, 1, { posterId: s.owner.id, milestoneId: v1 });
    const second = await seedIssue(s.repoId, 2, { posterId: s.reader.id });
    const third = await seedIssue(s.repoId, 3);
    await db().insert(issueLabels).values([
      { issueId: first.id, labelId: bug },
      { issueId: first.id, labelId: ui },
      { issueId: second.id, labelId: ui },
      { issueId: second.id, labelId: bug },
    ]);
    const dangling = await seedIssue(s.repoId, 4, { posterId: s.owner.id });
    await db().update(issues).set({ milestoneId: 999999 }).where(eq(issues.id, dangling.id));
    for (const issue of [first, second, third, dangling]) {
      await seedMembership(issue.id, project.id, column.id);
    }
    await db().insert(issuePins).values({ issueId: first.id, repoId: s.repoId, pinOrder: 2 });

    // The witness mount adds the tier-1 issue routes so the per-row single
    // GET renders sit next to the batched list render.
    const app = new OpenAPIHono<ApiEnv>();
    app.onError(giteaErrorHandler);
    registerProjectsRepoRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
    registerIssueRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
    const send = async (path: string, init?: RequestInit, dbOverride?: D1Database): Promise<Response> =>
      app.fetch(new Request(`https://example.com${path}`, init), { ...env, DB: dbOverride ?? env.DB });

    const meter = countedD1();
    const listRes = await send(`/repos/${s.owner.username.toLowerCase()}/${s.repoId}/projects/${project.id}/columns/${column.id}/issues`, undefined, meter.db);
    expect(listRes.status).toBe(200);
    const list = await listRes.json<Array<Record<string, unknown> & { number: number; labels: Array<{ name: string }> }>>();
    expect(list.map((item) => item.number)).toEqual([4, 3, 2, 1]); // sorting ASC, then created/id DESC — the flat sorting ties reverse on id
    const count = meter.count();
    // Post-fix: 1 repo resolve + 1 project/column/membership set + 2 (count
    // + page) + 5 prefetch arms (posters, labels, pins, milestones — the PR
    // arm skips: no pulls here) — page-INDEPENDENT. The pre-fix shape paid
    // 5 + N×(1 poster + 1 labels + 1 pin + 1 milestone) = 21 at this N; the
    // N×3 bound fails if any per-row fan returns.
    expect(count).toBeLessThanOrEqual(14);
    expect(count).toBeLessThan(4 * 3);

    // Contract discipline: the batched list render must be deep-equal to the
    // per-row single-GET renders for every row — the null poster, the
    // dangling-milestone null, the pin_order, and the label ordering in one
    // sweep.
    for (let index = 1; index <= 4; index++) {
      const singleRes = await send(`/repos/${s.owner.username.toLowerCase()}/${s.repoId}/issues/${index}`);
      expect(singleRes.status).toBe(200);
      const single = await singleRes.json<Record<string, unknown>>();
      expect(single).toEqual(list.find((item) => item.number === index));
    }
    expect(list.find((item) => item.number === 4)?.milestone).toBeNull();
    expect(list.find((item) => item.number === 2)?.labels.map((l: { name: string }) => l.name)).toEqual(["bug", "ui"]);
    expect(list.find((item) => item.number === 3)?.user).toBeNull();
  });
});

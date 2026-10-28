/**
 * User-scoped project-board routes (routes/projects-user.ts) on real D1 —
 * inventory batch 6 stage 3: the 21 `userCurrent*` operations over
 * `/user/projects…` plus `userListProjects` over `/users/{username}/projects`
 * (gitea/routers/api/v1/api.go:1102-1104 and :1065-1066 over the shared
 * handlers, reusing the stage-1 store + service verbatim).
 *
 * Standalone mount (the projects-org.test.ts convention): the register
 * function takes the requireAuth/optionalAuth pair and mounts on a fresh
 * OpenAPIHono with the stub resolver mapping `token u<id>` to the seeded D1
 * user rows.
 *
 * Pins asserted: doer-owns-everything (the scope owner IS the doer — ids
 * scoped to doer.id make cross-user reads AND mutations the plain 404, and
 * the mutation group's only gate is reqToken's 401), the anonymous zero-owner
 * reads (200 [] / 404 — upstream's nil-owner latent deref, module header),
 * the closed-project 403 arms, the column family's 422s (default column,
 * move multiset, sorting range), the global-lookup issue arm (cross-repo
 * add, unreadable repo hidden behind 404, per-issue archived 423), the
 * CanManageWorkflows individual arm (owner equality), and the
 * `/users/{username}` matrix: UserAssignmentAPI's 404/307 seam and the
 * public-user listing with caller-filtered item counts.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  issueLabels,
  issuePins,
  issues,
  labels,
  milestones,
  projectColumns,
  projectIssues,
  projects,
  repositories,
  userRedirects,
  users,
} from "../../db/schema";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerIssueRoutes } from "./issues";
import { registerProjectsUserRoutes } from "./projects-user";
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

async function seedUser(username: string, isAdmin = false): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin,
      status: "active",
      type: "user",
      visibility: "public",
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
  registerProjectsUserRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

async function seedUserRepo(
  owner: SeededUser,
  slug: string,
  visibility: "public" | "private" = "public",
): Promise<string> {
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

async function seedUserProject(
  ownerId: number,
  creatorId: number,
  overrides?: Partial<typeof projects.$inferInsert>,
) {
  const rows = await db()
    .insert(projects)
    .values({
      title: "User Board",
      description: "",
      ownerId,
      creatorId,
      type: 1,
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
      isDefault: true, // a template-created board's first column is the default
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

interface BoardSeed {
  owner: SeededUser;
  other: SeededUser;
  admin: SeededUser;
  project: typeof projects.$inferSelect;
  column: typeof projectColumns.$inferSelect;
}

/** alice owns a board with a default column; bob and an admin exist. */
async function seedBoard(suffix: string, overrides?: Partial<typeof projects.$inferInsert>): Promise<BoardSeed> {
  const owner = await seedUser(`alice-${suffix}`);
  const other = await seedUser(`bob-${suffix}`);
  const admin = await seedUser(`admin-${suffix}`, true);
  const project = await seedUserProject(owner.id, owner.id, overrides);
  const column = await seedColumn(project.id);
  return { owner, other, admin, project, column };
}

// ---------------------------------------------------------------------------
// /user/projects — doer-owns-everything
// ---------------------------------------------------------------------------

describe("the doer scope (api.go:1102-1104 — addProjectRoutes(m, reqToken()))", () => {
  it("anonymous writes 401 (reqToken); anonymous reads resolve the zero owner", async () => {
    const send = router();
    const write = await send("/user/projects", { method: "POST", body: JSON.stringify({ title: "x" }) });
    expect(write.status).toBe(401);
    // Upstream passes anonymous reads into a NIL owner (the module header's
    // latent deref); ours answers the defined zero-owner result.
    const list = await send("/user/projects");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
    const get = await send("/user/projects/1");
    expect(get.status).toBe(404);
  });

  it("creates an individual board for the doer (type individual, owner html link)", async () => {
    const alice = await seedUser("creator-alice");
    const send = router();
    const res = await send("/user/projects", {
      method: "POST",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ title: "My Board", description: "mine", card_type: "images_and_text" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: number; html_url: string } & Record<string, unknown>>();
    expect(body.type).toBe("individual");
    expect(body.owner_id).toBe(alice.id);
    expect(body.repo_id).toBe(0);
    expect(body.html_url).toBe(`https://example.com/${alice.username}/-/projects/${body.id}`);
    expect(body.card_type).toBe("images_and_text");
    // a fresh board is empty
    expect(body.num_issues).toBe(0);
    // the doer's list shows it; another doer's does not
    const list = await send("/user/projects", { headers: authHeaders(alice.id) });
    expect(list.status).toBe(200);
    expect((await list.json<unknown[]>()).length).toBe(1);
    expect(list.headers.get("x-total-count")).toBe("1");
    const bob = await seedUser("nonowner-bob");
    const bobList = await send("/user/projects", { headers: authHeaders(bob.id) });
    expect((await bobList.json<unknown[]>()).length).toBe(0);
  });

  it("400s an unparseable body, 422s the bind and a bad template_type", async () => {
    const alice = await seedUser("bind-alice");
    const send = router();
    // unparseable JSON never reaches the bind hook — the framework's 400 arm
    const bad = await send("/user/projects", {
      method: "POST",
      headers: authHeaders(alice.id),
      body: "not json",
    });
    expect(bad.status).toBe(400);
    const badEnum = await send("/user/projects", {
      method: "POST",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ title: "x", template_type: "nope" }),
    });
    expect(badEnum.status).toBe(422);
    expect((await badEnum.json<Record<string, string>>()).message).toBe(
      `invalid template_type "nope" (expected none, basic_kanban, bug_triage)`,
    );
  });

  it("cross-user ids read as not found on reads AND mutations (GetProjectByIDAndOwner)", async () => {
    const s = await seedBoard("cross");
    const send = router();
    const base = `/user/projects/${s.project.id}`;
    expect((await send(base, { headers: authHeaders(s.other.id) })).status).toBe(404);
    expect(
      (await send(base, { method: "PATCH", headers: authHeaders(s.other.id), body: JSON.stringify({ title: "hijack" }) }))
        .status,
    ).toBe(404);
    expect((await send(base, { method: "DELETE", headers: authHeaders(s.other.id) })).status).toBe(404);
    // the owner passes
    expect((await send(base, { headers: authHeaders(s.owner.id) })).status).toBe(200);
  });

  it("edits title/description/card_type, closes and reopens (closed_at stamps on every transition)", async () => {
    const s = await seedBoard("edit");
    const send = router();
    const base = `/user/projects/${s.project.id}`;
    const patch = await send(base, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "Renamed", description: "d", card_type: "images_and_text", state: "closed" }),
    });
    expect(patch.status).toBe(200);
    const closed = await patch.json<{ title: string; is_closed: boolean; state: string; closed_at?: string | null }>();
    expect(closed.title).toBe("Renamed");
    expect(closed.is_closed).toBe(true);
    expect(closed.state).toBe("closed");
    expect(typeof closed.closed_at).toBe("string");
    // a closed board is still editable and deletable (no 403 arm — shared/project.go:607-646)
    const editClosed = await send(base, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "Still Mine" }),
    });
    expect(editClosed.status).toBe(200);
    const reopen = await send(base, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ state: "open" }),
    });
    const reopened = await reopen.json<{ is_closed: boolean; closed_at?: string | null }>();
    expect(reopened.is_closed).toBe(false);
    expect(reopened.closed_at).toBeUndefined();
  });

  it("lists default-open, honors state=closed|all, and deletes (204 → 404)", async () => {
    const alice = await seedUser("state-alice");
    const open = await seedUserProject(alice.id, alice.id, { title: "Open" });
    await seedUserProject(alice.id, alice.id, { title: "Shut", isClosed: true });
    const send = router();
    const def = await send("/user/projects", { headers: authHeaders(alice.id) });
    expect((await def.json<{ title: string }[]>()).map((p) => p.title)).toEqual(["Open"]);
    const closed = await send("/user/projects?state=closed", { headers: authHeaders(alice.id) });
    expect((await closed.json<{ title: string }[]>()).map((p) => p.title)).toEqual(["Shut"]);
    const all = await send("/user/projects?state=all", { headers: authHeaders(alice.id) });
    expect((await all.json<unknown[]>()).length).toBe(2);

    const del = await send(`/user/projects/${open.id}`, { method: "DELETE", headers: authHeaders(alice.id) });
    expect(del.status).toBe(204);
    expect((await send(`/user/projects/${open.id}`, { headers: authHeaders(alice.id) })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

describe("columns (userCurrent*ProjectColumn ops)", () => {
  it("round-trips create/list/get/edit with the declared errors", async () => {
    const s = await seedBoard("cols");
    const send = router();
    const base = `/user/projects/${s.project.id}/columns`;
    const created = await send(base, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "Doing", color: "#00aabb" }),
    });
    expect(created.status).toBe(201);
    const column = await created.json<{ id: number; title: string; color?: string } & Record<string, unknown>>();
    expect(column.title).toBe("Doing");
    expect(column.color).toBe("#00aabb");

    const list = await send(base, { headers: authHeaders(s.owner.id) });
    expect(list.headers.get("x-total-count")).toBe("2");
    const badColor = await send(base, {
      method: "POST",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "x", color: "red" }),
    });
    expect(badColor.status).toBe(422);

    const patched = await send(`${base}/${column.id}`, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ sorting: 200 }),
    });
    expect(patched.status).toBe(422); // sorting must fit int8
    const ok = await send(`${base}/${column.id}`, {
      method: "PATCH",
      headers: authHeaders(s.owner.id),
      body: JSON.stringify({ title: "Doing Now" }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json<Record<string, unknown>>()).title).toBe("Doing Now");
    expect((await send(`${base}/999999`, { headers: authHeaders(s.owner.id) })).status).toBe(404);
  });

  it("403s every mutating arm on a CLOSED board ('project is closed')", async () => {
    const s = await seedBoard("closed", { isClosed: true });
    const send = router();
    const base = `/user/projects/${s.project.id}`;
    const jsonHeaders = authHeaders(s.owner.id);
    const createCol = await send(`${base}/columns`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: "x" }) });
    expect(createCol.status).toBe(403);
    expect((await createCol.json<Record<string, string>>()).message).toBe("project is closed");
    expect(
      (await send(`${base}/columns/${s.column.id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ title: "y" }) }))
        .status,
    ).toBe(403);
    expect((await send(`${base}/columns/${s.column.id}`, { method: "DELETE", headers: jsonHeaders })).status).toBe(403);
    expect((await send(`${base}/columns/${s.column.id}/default`, { method: "POST", headers: jsonHeaders })).status).toBe(403);
    expect(
      (await send(`${base}/columns/move`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ column_ids: [s.column.id] }) }))
        .status,
    ).toBe(403);
    // reads stay open
    expect((await send(`${base}/columns`, { headers: jsonHeaders })).status).toBe(200);
  });

  it("guards the default column (set 204, delete default 422, delete other moves issues)", async () => {
    const s = await seedBoard("defaults");
    const send = router();
    const jsonHeaders = authHeaders(s.owner.id);
    const base = `/user/projects/${s.project.id}/columns`;
    const second = await (
      await send(base, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: "Second" }) })
    ).json<{ id: number }>();

    // the seeded column is the default; deleting it fails with upstream's 422
    const delDefault = await send(`${base}/${s.column.id}`, { method: "DELETE", headers: jsonHeaders });
    expect(delDefault.status).toBe(422);
    expect((await delDefault.json<Record<string, string>>()).message).toBe("cannot delete the default column");

    const repoId = await seedUserRepo(s.owner, "defaults-repo");
    const issue = await seedIssue(repoId, 1);
    await seedMembership(issue.id, s.project.id, s.column.id);

    const setDefault = await send(`${base}/${second.id}/default`, { method: "POST", headers: jsonHeaders });
    expect(setDefault.status).toBe(204);
    // now the OLD default is deletable and its issues move into the new default
    const del = await send(`${base}/${s.column.id}`, { method: "DELETE", headers: jsonHeaders });
    expect(del.status).toBe(204);
    const issues = await send(`${base}/${second.id}/issues`, { headers: jsonHeaders });
    expect(issues.headers.get("x-total-count")).toBe("1");
  });

  it("reorders columns exactly (move 204; a wrong multiset 422s)", async () => {
    const s = await seedBoard("move-cols");
    const send = router();
    const jsonHeaders = authHeaders(s.owner.id);
    const base = `/user/projects/${s.project.id}/columns`;
    const second = await (
      await send(base, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: "Second" }) })
    ).json<{ id: number }>();

    const wrong = await send(`${base}/move`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ column_ids: [s.column.id] }),
    });
    expect(wrong.status).toBe(422);
    const ok = await send(`${base}/move`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ column_ids: [second.id, s.column.id] }),
    });
    expect(ok.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Column issues — the global lookup arm
// ---------------------------------------------------------------------------

describe("column issues (the owner arm's global GetIssueByID — shared/project.go:114-147)", () => {
  it("adds a CROSS-REPO issue to a column (owner boards span repositories), removes it", async () => {
    const s = await seedBoard("issues");
    const repoId = await seedUserRepo(s.owner, "span");
    const otherRepoId = await seedUserRepo(s.owner, "span2");
    const mine = await seedIssue(repoId, 1);
    const other = await seedIssue(otherRepoId, 7);
    const send = router();
    const addUrl = `/user/projects/${s.project.id}/columns/${s.column.id}/issues`;
    const add = await send(`${addUrl}/${other.id}`, { method: "POST", headers: authHeaders(s.owner.id) });
    expect(add.status).toBe(201);
    const addMine = await send(`${addUrl}/${mine.id}`, { method: "POST", headers: authHeaders(s.owner.id) });
    expect(addMine.status).toBe(201);
    const list = await send(addUrl, { headers: authHeaders(s.owner.id) });
    expect(list.headers.get("x-total-count")).toBe("2");

    const remove = await send(`${addUrl}/${mine.id}`, { method: "DELETE", headers: authHeaders(s.owner.id) });
    expect(remove.status).toBe(204);
    expect((await send(addUrl, { headers: authHeaders(s.owner.id) })).headers.get("x-total-count")).toBe("1");
  });

  it("404s unknown issues and hides issues of repos the doer cannot read", async () => {
    const s = await seedBoard("hidden");
    const send = router();
    const addUrl = `/user/projects/${s.project.id}/columns/${s.column.id}/issues`;
    expect((await send(`${addUrl}/424242`, { method: "POST", headers: authHeaders(s.owner.id) })).status).toBe(404);
    // bob's PRIVATE repo issue — the global lookup hits but the read check hides it
    const bobRepo = await seedUserRepo(s.other, "secret", "private");
    const secret = await seedIssue(bobRepo, 1);
    expect((await send(`${addUrl}/${secret.id}`, { method: "POST", headers: authHeaders(s.owner.id) })).status).toBe(404);
  });

  it("423s issues in ARCHIVED repos per-issue (owner boards have no group mustNotBeArchived)", async () => {
    const s = await seedBoard("archived");
    await seedUserRepo(s.owner, "frozen", "public");
    await db().update(repositories).set({ isArchived: true }).where(eq(repositories.id, "usr-frozen"));
    const frozen = await seedIssue("usr-frozen", 3);
    const send = router();
    const addUrl = `/user/projects/${s.project.id}/columns/${s.column.id}/issues`;
    const res = await send(`${addUrl}/${frozen.id}`, { method: "POST", headers: authHeaders(s.owner.id) });
    expect(res.status).toBe(423);
    expect((await res.json<Record<string, string>>()).message).toBe("repo is archived");
  });

  it("moves an issue between columns; a foreign target column is the 422", async () => {
    const s = await seedBoard("move-issue");
    const repoId = await seedUserRepo(s.owner, "mover");
    const issue = await seedIssue(repoId, 1);
    await seedMembership(issue.id, s.project.id, s.column.id);
    const send = router();
    const jsonHeaders = authHeaders(s.owner.id);
    const target = await (
      await send(`/user/projects/${s.project.id}/columns`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: "Done" }) })
    ).json<{ id: number }>();

    const foreign = await send(`/user/projects/${s.project.id}/issues/${issue.id}/move`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ column_id: 987654 }),
    });
    expect(foreign.status).toBe(422);
    expect((await foreign.json<Record<string, string>>()).message).toBe("target column does not belong to this project");
    const ok = await send(`/user/projects/${s.project.id}/issues/${issue.id}/move`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ column_id: target.id }),
    });
    expect(ok.status).toBe(204);
    const listed = await send(`/user/projects/${s.project.id}/columns/${target.id}/issues`, { headers: jsonHeaders });
    expect(listed.headers.get("x-total-count")).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Workflows — CanManageWorkflows' individual arm (workflow.go:52)
// ---------------------------------------------------------------------------

describe("workflows (userCurrent*ProjectWorkflow ops)", () => {
  it("round-trips create/list/get/edit/delete with the invalid-event 422", async () => {
    const s = await seedBoard("wf");
    const send = router();
    const jsonHeaders = authHeaders(s.owner.id);
    const base = `/user/projects/${s.project.id}/workflows`;
    const bad = await send(base, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ event: "nope" }) });
    expect(bad.status).toBe(422);
    const created = await send(base, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ event: "item_added_to_project", actions: { issue_state: "close" } }),
    });
    expect(created.status).toBe(201);
    const workflow = await created.json<{ id: number; event: string }>();
    expect(workflow.event).toBe("item_added_to_project");

    const list = await send(base, { headers: jsonHeaders });
    expect(list.headers.get("x-total-count")).toBe("1");
    const got = await send(`${base}/${workflow.id}`, { headers: jsonHeaders });
    expect(got.status).toBe(200);
    const edited = await send(`${base}/${workflow.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    expect(edited.status).toBe(200);
    expect((await edited.json<Record<string, unknown>>()).enabled).toBe(false);
    expect((await send(`${base}/${workflow.id}`, { method: "DELETE", headers: jsonHeaders })).status).toBe(204);
    expect((await send(`${base}/999999`, { headers: jsonHeaders })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /users/{username}/projects — the UserAssignmentAPI matrix
// ---------------------------------------------------------------------------

describe("userListProjects (api.go:1065-1066)", () => {
  it("404s unknown users with upstream's redirect-miss text and 307s renamed ones", async () => {
    const send = router();
    const miss = await send("/users/ghost-user/projects");
    expect(miss.status).toBe(404);
    expect((await miss.json<Record<string, string>>()).message).toBe("user redirect does not exist [name: ghost-user]");
    const target = await seedUser("canonical-name");
    await db().insert(userRedirects).values({ lowerName: "former-name", redirectUserId: target.id });
    const redirect = await send("/users/former-name/projects?state=all");
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe(`/users/${target.username}/projects?state=all`);
  });

  it("lists ANY resolved (public) user's boards to ANYONE — visibility lives at the user level", async () => {
    const target = await seedUser("listable");
    const other = await seedUser("bystander");
    await seedUserProject(target.id, target.id, { title: "Visible" });
    await seedUserProject(target.id, target.id, { title: "Hidden By State", isClosed: true });
    const send = router();
    const anon = await send(`/users/${target.username}/projects`);
    expect(anon.status).toBe(200);
    expect((await anon.json<{ title: string }[]>()).map((p) => p.title)).toEqual(["Visible"]);
    expect(anon.headers.get("x-total-count")).toBe("1");
    const all = await send(`/users/${target.username}/projects?state=all`, { headers: authHeaders(other.id) });
    expect((await all.json<unknown[]>()).length).toBe(2);
  });

  it("filters the item counts by the CALLER's repo visibility (anonymous sees public only)", async () => {
    const target = await seedUser("counts");
    const publicRepo = await seedUserRepo(target, "pub");
    const privateRepo = await seedUserRepo(target, "priv", "private");
    const board = await seedUserProject(target.id, target.id);
    const column = await seedColumn(board.id, { title: "Inbox" });
    const pubIssue = await seedIssue(publicRepo, 1);
    const privIssue = await seedIssue(privateRepo, 1);
    await seedMembership(pubIssue.id, board.id, column.id);
    await seedMembership(privIssue.id, board.id, column.id);
    const send = router();

    const anon = await (await send(`/users/${target.username}/projects`)).json<Record<string, number>[]>();
    expect(anon).toHaveLength(1);
    expect(anon[0]?.num_issues).toBe(1); // only the public repo's item

    const self = await (
      await send(`/users/${target.username}/projects`, { headers: authHeaders(target.id) })
    ).json<Record<string, number>[]>();
    expect(self).toHaveLength(1);
    expect(self[0]?.num_issues).toBe(2); // the owner sees their private repo's item too

    const admin = await (
      await send(`/users/${target.username}/projects`, { headers: authHeaders((await seedUser("rooty", true)).id) })
    ).json<Record<string, number>[]>();
    expect(admin).toHaveLength(1);
    expect(admin[0]?.num_issues).toBe(2);

    // the column-issue listing follows the same filter
    const anonIssues = await send(`/user/projects/${board.id}/columns/${column.id}/issues`);
    expect(anonIssues.status).toBe(404); // /user/projects anonymous = zero owner: the board id is not theirs
    const selfIssues = await send(`/user/projects/${board.id}/columns/${column.id}/issues`, {
      headers: authHeaders(target.id),
    });
    expect(selfIssues.headers.get("x-total-count")).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// Query-shape witness (docs/research/query-shape-audit.md A2/A6, tier-2
// adoption) — the /user/projects column-issue list rendered its enrichment
// selects PER ROW; the page now prefetches one inArray read per entity kind
// through toApiIssue's preload, with the pairsById map serving the
// cross-repo rows. Metering: the prepare()-counting D1 wrapper riding
// app.fetch's env.
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

describe("user column-issues list query-shape witness (query-shape-audit A2/A6, tier-2)", () => {
  it("renders the cross-repo column page with a constant statement count, deep-equal to the per-row single GETs", async () => {
    const s = await seedBoard("witness");
    const repoA = await seedUserRepo(s.owner, "one");
    const repoB = await seedUserRepo(s.owner, "two");
    const poster2 = await seedUser("alice-witness-p2");
    const bug = await db()
      .insert(labels)
      .values({ repoId: repoA, name: "bug", color: "#00aabb", description: "", numIssues: 0, numClosedIssues: 0 })
      .returning({ id: labels.id })
      .all()
      .then((rows) => rows[0]!.id);
    const v1 = await db()
      .insert(milestones)
      .values({ repoId: repoA, name: "v1", content: "", createdAt: NOW, updatedAt: NOW })
      .returning({ id: milestones.id })
      .all()
      .then((rows) => rows[0]!.id);
    const first = await seedIssue(repoA, 1, { posterId: s.owner.id, milestoneId: v1 });
    const second = await seedIssue(repoA, 2, { posterId: poster2.id });
    const third = await seedIssue(repoB, 1); // another repo, null poster
    await db().insert(issueLabels).values([
      { issueId: first.id, labelId: bug },
      { issueId: second.id, labelId: bug },
    ]);
    for (const issue of [first, second, third]) {
      await seedMembership(issue.id, s.project.id, s.column.id);
    }
    await db().insert(issuePins).values({ issueId: first.id, repoId: repoA, pinOrder: 2 });

    // The tier-1 issue routes mount beside the user family so the per-row
    // single GETs sit next to the batched list render.
    const app = new OpenAPIHono<ApiEnv>();
    app.onError(giteaErrorHandler);
    registerProjectsUserRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
    registerIssueRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
    const send = async (path: string, init?: RequestInit, dbOverride?: D1Database): Promise<Response> =>
      app.fetch(new Request(`https://example.com${path}`, init), { ...env, DB: dbOverride ?? env.DB });

    const meter = countedD1();
    const listRes = await send(`/user/projects/${s.project.id}/columns/${s.column.id}/issues`, {
      headers: authHeaders(s.owner.id),
    }, meter.db);
    expect(listRes.status).toBe(200);
    const list = await listRes.json<Array<Record<string, unknown> & { number: number; labels: Array<{ name: string }>; repository: { full_name: string } }>>();
    expect(list).toHaveLength(3);
    expect(list.map((item) => item.repository.full_name).sort()).toEqual([
      `${s.owner.username.toLowerCase()}/one`,
      `${s.owner.username.toLowerCase()}/one`,
      `${s.owner.username.toLowerCase()}/two`,
    ]);
    const count = meter.count();
    // Post-fix: the route's fixed prefix (project + column + membership +
    // visible repos + count + page) + 5 prefetch arms — page-INDEPENDENT.
    // The pre-fix shape added N×(1 poster + 1 labels + 1 pin + 1 milestone)
    // = 12 at this N=3; the bound below fails if any per-row fan returns.
    expect(count).toBeLessThanOrEqual(20);
    expect(count).toBeLessThan(21);

    // Contract discipline: every batched render is deep-equal to the
    // per-row single GET of ITS repo (per-repo indexes).
    for (const [repoSlug, index] of [
      ["one", first.index],
      ["one", second.index],
      ["two", third.index],
    ] as const) {
      const singleRes = await send(`/repos/${s.owner.username.toLowerCase()}/${repoSlug}/issues/${index}`, { headers: authHeaders(s.owner.id) });
      expect(singleRes.status).toBe(200);
      const single = await singleRes.json<Record<string, unknown>>();
      expect(single).toEqual(list.find((item) => item.number === index && item.repository.full_name === `${s.owner.username.toLowerCase()}/${repoSlug}`));
    }
    expect(list.find((item) => item.repository.full_name === `${s.owner.username.toLowerCase()}/two`)?.user).toBeNull();
    expect(list.find((item) => item.number === 1 && item.repository.full_name === `${s.owner.username.toLowerCase()}/one`)?.labels.map((l: { name: string }) => l.name)).toEqual(["bug"]);
  });
});

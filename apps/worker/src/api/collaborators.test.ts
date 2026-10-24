/**
 * Tier-1 collaborator/assignee routes on real D1 (SPEC-0004 §2.4 rows
 * repoListCollaborators / repoCheckCollaborator / repoAddCollaborator /
 * repoDeleteCollaborator / repoGetAssignees; upstream
 * routers/api/v1/repo/collaborators.go over the raw-D1 `repo_collaborators`
 * store — services/repo-collaborators.ts documents the schema gap). Pins:
 * the reqToken-401, the anti-enumeration 404 for invisible repos, the
 * unknown-user 422 `user does not exist [uid: 0, name: X]`, the idempotent
 * upsert PUT (nil permission → write) and the idempotent 204 DELETE, the
 * admin gate (403 exact upstream message; collaborator-admin grant), the
 * insertion-order paginated list, and the assignees set (write-or-above
 * collaborators + owner, active only, name order, deduped).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { repositories, users } from "../db/schema";
import { createStubAuthResolver, createTokenAuthMiddleware, type AuthResolver } from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { registerCollaboratorRoutes } from "./routes/collaborators";
import { addOrUpdateCollaborator } from "./services/repo-collaborators";
import { applyRepoExtrasDdl, resetRepoExtrasTables } from "./testing/repo-ddl";

const TOKEN = "stub-token"; // resolves to STUB_USER (id 1)
const TOKEN_COLLAB = "collab-token"; // resolves to the seeded collaborator row
const ERROR_URL = "https://example.com/api/swagger";

let collaboratorUserId = 0;

function collaboratorIdentity() {
  return {
    id: collaboratorUserId,
    login: "collab",
    email: "",
    full_name: "Collab User",
    avatar_url: "",
    html_url: "",
    language: "en-US",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: false,
    prohibit_login: false,
    restricted: false,
    login_name: "",
    source_id: 0,
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    created: "2026-01-01T00:00:00Z",
    last_login: "0001-01-01T00:00:00Z",
    type: "User" as const,
    visibility: "public" as const,
  };
}

function makeApp(): (path: string, init?: RequestInit) => Promise<Response> {
  const resolver: AuthResolver = {
    resolveToken: (token) => {
      if (token === TOKEN) return createStubAuthResolver().resolveToken(token);
      if (token === TOKEN_COLLAB) return Promise.resolve(collaboratorIdentity());
      return Promise.resolve(null);
    },
  };
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerCollaboratorRoutes(app, createTokenAuthMiddleware(resolver));
  return (path, init) => Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

beforeAll(async () => {
  await applyRepoExtrasDdl();
});

beforeEach(async () => {
  await resetRepoExtrasTables();
  for (const table of ["repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // STUB_USER (id 1) owns the repo; 'collab' and 'carol' are candidates.
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  const collab = await drizzle(env.DB)
    .insert(users)
    .values({ username: "collab", usernameLower: "collab", status: "active", createdAt: new Date() })
    .returning({ id: users.id })
    .all();
  collaboratorUserId = collab[0]!.id;
  await drizzle(env.DB).insert(users).values({ username: "carol", usernameLower: "carol", status: "active", createdAt: new Date() });
  await drizzle(env.DB).insert(users).values({ username: "ghost-user", usernameLower: "ghost-user", status: "prohibited", createdAt: new Date() });
  await drizzle(env.DB).insert(repositories).values({
    id: "7201",
    storageKey: "r_7201",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "shared",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await drizzle(env.DB).insert(repositories).values({
    id: "7202",
    storageKey: "r_7202",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "private",
    visibility: "private",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
});

const auth = { Authorization: `token ${TOKEN}` };
const authCollab = { Authorization: `token ${TOKEN_COLLAB}` };
const repoPath = "/repos/cf-gitea-stub/shared";
const jsonAuth = { ...auth, "Content-Type": "application/json" };

describe("PUT /repos/{owner}/{repo}/collaborators/{collaborator} (repoAddCollaborator)", () => {
  it("adds a collaborator with the default write mode (nil permission)", async () => {
    const res = await makeApp()(`${repoPath}/collaborators/collab`, { method: "PUT", headers: jsonAuth, body: "{}" });
    expect(res.status).toBe(204);
    const { findCollaborator } = await import("./services/repo-collaborators");
    expect((await findCollaborator(env.DB, "7201", collaboratorUserId))?.mode).toBe("write");
  });

  it("upserts the requested mode", async () => {
    await makeApp()(`${repoPath}/collaborators/collab`, {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({ permission: "read" }),
    });
    await makeApp()(`${repoPath}/collaborators/collab`, {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({ permission: "admin" }),
    });
    const { findCollaborator } = await import("./services/repo-collaborators");
    expect((await findCollaborator(env.DB, "7201", collaboratorUserId))?.mode).toBe("admin");
  });

  it("422s an unknown user with the ErrUserNotExist message (NOT the 404 family)", async () => {
    const res = await makeApp()(`${repoPath}/collaborators/nobody`, { method: "PUT", headers: jsonAuth, body: "{}" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ message: "user does not exist [uid: 0, name: nobody]", url: ERROR_URL });
  });

  it("500s an inactive target account (upstream APIErrorInternal)", async () => {
    const res = await makeApp()(`${repoPath}/collaborators/ghost-user`, { method: "PUT", headers: jsonAuth, body: "{}" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: "", url: ERROR_URL });
  });

  it("403s a non-admin caller with the upstream reqAdmin message", async () => {
    const res = await makeApp()(`${repoPath}/collaborators/carol`, {
      method: "PUT",
      headers: { ...authCollab, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: "user should be an owner or a collaborator with admin write of a repository",
      url: ERROR_URL,
    });
  });

  it("grants the PUT to a collaborator holding the admin mode", async () => {
    await addOrUpdateCollaborator(env.DB, "7201", collaboratorUserId, "admin", new Date());
    const res = await makeApp()(`${repoPath}/collaborators/carol`, {
      method: "PUT",
      headers: { ...authCollab, "Content-Type": "application/json" },
      body: JSON.stringify({ permission: "read" }),
    });
    expect(res.status).toBe(204);
  });

  it("422s a permission outside the contract enum (bind hook)", async () => {
    const res = await makeApp()(`${repoPath}/collaborators/collab`, {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({ permission: "owner" }),
    });
    expect(res.status).toBe(422);
  });

  it("401s an anonymous caller", async () => {
    expect((await makeApp()(`${repoPath}/collaborators/collab`, { method: "PUT" })).status).toBe(401);
  });
});

describe("GET /repos/{owner}/{repo}/collaborators (repoListCollaborators)", () => {
  it("lists collaborators in insertion order with the pagination headers", async () => {
    await makeApp()(`${repoPath}/collaborators/carol`, { method: "PUT", headers: jsonAuth, body: "{}" });
    const collab = await drizzle(env.DB)
      .insert(users)
      .values({ username: "alan", usernameLower: "alan", status: "active", createdAt: new Date() })
      .returning({ id: users.id })
      .all();
    await addOrUpdateCollaborator(env.DB, "7201", collab[0]!.id, "read", new Date());

    const res = await makeApp()(`${repoPath}/collaborators?limit=1`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(res.headers.get("Link")).toContain('rel="next"');
    const body = await res.json<Array<{ login: string }>>();
    expect(body.map((u) => u.login)).toEqual(["carol"]); // insertion order (carol was added first)
  });

  it("404s an invisible private repo for a non-collaborator", async () => {
    const res = await makeApp()("/repos/cf-gitea-stub/private/collaborators", { headers: authCollab });
    expect(res.status).toBe(404);
  });
});

describe("GET /repos/{owner}/{repo}/collaborators/{collaborator} (repoCheckCollaborator)", () => {
  it("204s a collaborator, 404s a known non-collaborator, 422s an unknown user", async () => {
    await makeApp()(`${repoPath}/collaborators/collab`, { method: "PUT", headers: jsonAuth, body: "{}" });
    expect((await makeApp()(`${repoPath}/collaborators/collab`, { headers: auth })).status).toBe(204);
    expect((await makeApp()(`${repoPath}/collaborators/carol`, { headers: auth })).status).toBe(404);
    const res = await makeApp()(`${repoPath}/collaborators/nobody`, { headers: auth });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ message: "user does not exist [uid: 0, name: nobody]", url: ERROR_URL });
  });
});

describe("DELETE /repos/{owner}/{repo}/collaborators/{collaborator} (repoDeleteCollaborator)", () => {
  it("removes a collaborator (204) and stays a 204 when absent", async () => {
    await makeApp()(`${repoPath}/collaborators/collab`, { method: "PUT", headers: jsonAuth, body: "{}" });
    expect((await makeApp()(`${repoPath}/collaborators/collab`, { method: "DELETE", headers: auth })).status).toBe(204);
    const { isCollaborator } = await import("./services/repo-collaborators");
    expect(await isCollaborator(env.DB, "7201", collaboratorUserId)).toBe(false);
    // Upstream's unconditional DeleteCollaboration: zero rows deleted, still 204.
    expect((await makeApp()(`${repoPath}/collaborators/collab`, { method: "DELETE", headers: auth })).status).toBe(204);
  });

  it("422s an unknown user and 403s a non-admin", async () => {
    expect((await makeApp()(`${repoPath}/collaborators/nobody`, { method: "DELETE", headers: auth })).status).toBe(422);
    expect((await makeApp()(`${repoPath}/collaborators/carol`, { method: "DELETE", headers: authCollab })).status).toBe(403);
  });
});

describe("GET /repos/{owner}/{repo}/assignees (repoGetAssignees)", () => {
  it("lists the owner plus write-or-above collaborators, name order, active only", async () => {
    // read-mode collaborator: NOT an assignee.
    await addOrUpdateCollaborator(env.DB, "7201", collaboratorUserId, "read", new Date());
    const writer = await drizzle(env.DB)
      .insert(users)
      .values({ username: "zoe", usernameLower: "zoe", status: "active", createdAt: new Date() })
      .returning({ id: users.id })
      .all();
    await addOrUpdateCollaborator(env.DB, "7201", writer[0]!.id, "write", new Date());
    const inactive = await drizzle(env.DB)
      .insert(users)
      .values({ username: "inactive-guy", usernameLower: "inactive-guy", status: "prohibited", createdAt: new Date() })
      .returning({ id: users.id })
      .all();
    await addOrUpdateCollaborator(env.DB, "7201", inactive[0]!.id, "admin", new Date());

    const res = await makeApp()(`${repoPath}/assignees`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json<Array<{ login: string }>>();
    // name order: cf-gitea-stub < zoe; read-mode and inactive users dropped;
    // the owner appears exactly once.
    expect(body.map((u) => u.login)).toEqual(["cf-gitea-stub", "zoe"]);
  });

  it("404s an invisible repo", async () => {
    expect((await makeApp()("/repos/cf-gitea-stub/private/assignees", { headers: authCollab })).status).toBe(404);
  });

  it("401s an anonymous caller (reqToken)", async () => {
    expect((await makeApp()(`${repoPath}/assignees`)).status).toBe(401);
  });
});

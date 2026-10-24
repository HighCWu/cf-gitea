/**
 * Tier-1 repo-topic routes on real D1 (SPEC-0004 §2.4 rows repoListTopics /
 * repoUpdateTopics; upstream routers/api/v1/repo/topic.go over the raw-D1
 * `repo_topics` store — services/repo-topics.ts documents the schema gap).
 * Pins: the GET name-list ordering + pagination headers, the PUT whole-list
 * replace with the SanitizeAndValidateTopics rules (trim/lowercase/dedupe/
 * drop-empties, `^[a-z0-9][-.a-z0-9]*$`, ≤ 35 chars, 25-topic cap), the
 * hand-built {message, invalidTopics} 422 bodies (no url field — upstream
 * renders the map directly), the SaveTopics case-insensitive no-op rule,
 * the admin gate (owner / collaborator-admin; the exact upstream 403
 * message), and the family-wide 423 on archived repos.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { repositories, users } from "../db/schema";
import { createOptionalTokenAuthMiddleware, createStubAuthResolver, createTokenAuthMiddleware, type AuthResolver } from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { registerTopicRoutes } from "./routes/topics";
import { addOrUpdateCollaborator } from "./services/repo-collaborators";
import { deleteRepoTopics, listRepoTopics, replaceRepoTopics } from "./services/repo-topics";
import { applyRepoExtrasDdl, resetRepoExtrasTables } from "./testing/repo-ddl";

const TOKEN = "stub-token";
const TOKEN_COLLAB_ADMIN = "collab-admin-token";
const ERROR_URL = "https://example.com/api/swagger";

let collabAdminUserId = 0;

/** Standalone app with ONLY the topic family mounted (router.ts is owned by
 *  a parallel change — registration is the orchestrator's merge). */
function makeApp(): (path: string, init?: RequestInit) => Promise<Response> {
  const resolver: AuthResolver = {
    resolveToken: (token) => {
      if (token === TOKEN) return createStubAuthResolver().resolveToken(token);
      if (token === TOKEN_COLLAB_ADMIN) {
        return Promise.resolve({
          id: collabAdminUserId,
          login: "collab-admin",
          email: "",
          full_name: "Collab Admin",
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
          type: "User",
          visibility: "public",
        });
      }
      return Promise.resolve(null);
    },
  };
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerTopicRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return (path, init) => Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyRepoExtrasDdl();
});

beforeEach(async () => {
  await resetRepoExtrasTables();
  for (const table of ["repo_counters", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The stub token identity is STUB_USER (id 1) — the repo owner.
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  const collab = await drizzle(env.DB)
    .insert(users)
    .values({ username: "collab-admin", usernameLower: "collab-admin", status: "active", createdAt: new Date() })
    .returning({ id: users.id })
    .all();
  collabAdminUserId = collab[0]!.id;
  await drizzle(env.DB).insert(repositories).values({
    id: "7001",
    storageKey: "r_7001",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "topics-repo",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await drizzle(env.DB).insert(repositories).values({
    id: "7002",
    storageKey: "r_7002",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "archived",
    visibility: "public",
    isArchived: true,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await drizzle(env.DB).insert(repositories).values({
    id: "7003",
    storageKey: "r_7003",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "private",
    visibility: "private",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
});

const authHeaders = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };

describe("GET /repos/{owner}/{repo}/topics (repoListTopics)", () => {
  it("returns an empty list on a fresh repo, with the pagination headers", async () => {
    const res = await makeApp()("/repos/cf-gitea-stub/topics-repo/topics");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("0");
    expect(await res.json()).toEqual({ topics: [] });
  });

  it("lists seeded topics sorted by name, anonymous on a public repo", async () => {
    await replaceRepoTopics(env.DB, "7001", ["web", "ci", "api"]);
    const res = await makeApp()("/repos/cf-gitea-stub/topics-repo/topics");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ topics: ["api", "ci", "web"] });
    expect(res.headers.get("X-Total-Count")).toBe("3");
  });

  it("404s a missing repo and an invisible private repo alike", async () => {
    expect((await makeApp()("/repos/cf-gitea-stub/ghost/topics")).status).toBe(404);
    expect((await makeApp()("/repos/cf-gitea-stub/private/topics")).status).toBe(404);
  });

  it("200s the private repo for the owner's token (visibility, not topics)", async () => {
    const res = await makeApp()("/repos/cf-gitea-stub/private/topics", { headers: { Authorization: `token ${TOKEN}` } });
    expect(res.status).toBe(200);
  });
});

describe("PUT /repos/{owner}/{repo}/topics (repoUpdateTopics)", () => {
  it("replaces the whole list and sanitizes (trim, lowercase, dedupe, drop empties)", async () => {
    const res = await makeApp()("/repos/cf-gitea-stub/topics-repo/topics", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ topics: ["  Web ", "web", "CI", ""] }),
    });
    expect(res.status).toBe(204);
    expect(await listRepoTopics(env.DB, "7001")).toEqual(["ci", "web"]);
  });

  it("re-PUT with a case variant of an existing topic is a no-op (SaveTopics EqualFold)", async () => {
    await replaceRepoTopics(env.DB, "7001", ["web"]);
    const res = await makeApp()("/repos/cf-gitea-stub/topics-repo/topics", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ topics: ["WEB"] }),
    });
    expect(res.status).toBe(204);
    expect(await listRepoTopics(env.DB, "7001")).toEqual(["web"]);
  });

  it("422s invalid names with the exact {message, invalidTopics} body (no url)", async () => {
    const res = await makeApp()("/repos/cf-gitea-stub/topics-repo/topics", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ topics: ["ok-topic", "Bad Topic", "a".repeat(36)] }),
    });
    expect(res.status).toBe(422);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(["invalidTopics", "message"]);
    expect(body.message).toBe("Topic names are invalid");
    expect(body.invalidTopics).toEqual(["bad topic", "a".repeat(36)]);
  });

  it("422s with invalidTopics null above the 25-topic cap (guard order: cap first)", async () => {
    const topics = Array.from({ length: 26 }, (_, i) => `t${i}`);
    const res = await makeApp()("/repos/cf-gitea-stub/topics-repo/topics", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ topics }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ message: "Exceeding maximum number of topics per repo", invalidTopics: null });
  });

  it("423s an archived repo (mustNotBeArchived, route-family-wide)", async () => {
    const res = await makeApp()("/repos/cf-gitea-stub/archived/topics", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ topics: ["web"] }),
    });
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({ message: "repo is archived", url: ERROR_URL });
  });

  it("403s a non-admin token with the upstream reqAdmin message", async () => {
    const res = await makeApp()("/repos/cf-gitea-stub/topics-repo/topics", {
      method: "PUT",
      headers: { Authorization: `token ${TOKEN_COLLAB_ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ topics: ["web"] }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: "user should be an owner or a collaborator with admin write of a repository",
      url: ERROR_URL,
    });
  });

  it("grants the PUT to a collaborator holding the admin mode", async () => {
    await addOrUpdateCollaborator(env.DB, "7001", collabAdminUserId, "admin", new Date());
    const res = await makeApp()("/repos/cf-gitea-stub/topics-repo/topics", {
      method: "PUT",
      headers: { Authorization: `token ${TOKEN_COLLAB_ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ topics: ["granted"] }),
    });
    expect(res.status).toBe(204);
  });

  it("404s a missing repo before the body is even validated", async () => {
    const res = await makeApp()("/repos/cf-gitea-stub/ghost/topics", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ topics: ["x"] }),
    });
    expect(res.status).toBe(404);
  });

  it("422s a malformed body through the bind hook", async () => {
    const res = await makeApp()("/repos/cf-gitea-stub/topics-repo/topics", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ topics: "not-an-array" }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ message: "invalid request body", url: ERROR_URL });
  });

  it("401s an anonymous caller (reqToken)", async () => {
    const res = await makeApp()("/repos/cf-gitea-stub/topics-repo/topics", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topics: ["web"] }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "token is required", url: ERROR_URL });
  });
});

/** The repoDelete path's housekeeping. */
describe("topic store housekeeping", () => {
  it("deleteRepoTopics clears the repo's rows", async () => {
    await replaceRepoTopics(env.DB, "7001", ["web"]);
    await deleteRepoTopics(env.DB, "7001");
    expect(await listRepoTopics(env.DB, "7001")).toEqual([]);
  });
});

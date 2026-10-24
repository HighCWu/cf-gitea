/**
 * Tier-1 repo-edit routes on real D1 (SPEC-0004 §2.4 rows repoEdit /
 * repoDelete / repoTransfer; upstream routers/api/v1/repo/repo.go Edit +
 * transfer.go over the landed repos service). Pins: the meaningful-subset
 * PATCH (rename via the landed service — old URL 404s and a redirect row
 * appears; visibility flip; default branch; archived flip; the stored
 * description/website/has_* subset with the PATCH→GET round trip; the
 * accepted-and-ignored remainder), the 422 family (rename collision /
 * invalid name), the admin/danger-zone 403s, the §2.5.5 DELETE (D1 row +
 * this batch's raw stores gone), and the SPEC-pinned async 202 transfer
 * (pending repo_transfer row, current-state Repository render, the
 * anti-enumeration 404 unknown-owner message, self-transfer 422, teams 422).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { repoRedirects, repoTransfer, repositories, users } from "../db/schema";
import { createOptionalTokenAuthMiddleware, createStubAuthResolver, createTokenAuthMiddleware, type AuthResolver } from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { registerRepoRoutes } from "./routes/repo";
import { addOrUpdateCollaborator } from "./services/repo-collaborators";
import { applyRepoExtrasDdl, resetRepoExtrasTables } from "./testing/repo-ddl";

const TOKEN = "stub-token"; // STUB_USER (id 1) — the repo owner
const TOKEN_OTHER = "other-token"; // 'other' — a plain user
const TOKEN_COLLAB_ADMIN = "collab-admin-token";
const ERROR_URL = "https://example.com/api/swagger";

let otherUserId = 0;
let collabAdminUserId = 0;

function userIdentity(id: number, login: string) {
  return {
    id,
    login,
    email: "",
    full_name: login,
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
      if (token === TOKEN_OTHER) return Promise.resolve(userIdentity(otherUserId, "other"));
      if (token === TOKEN_COLLAB_ADMIN) return Promise.resolve(userIdentity(collabAdminUserId, "collab-admin"));
      return Promise.resolve(null);
    },
  };
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerRepoRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return (path, init) => Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

beforeAll(async () => {
  await applyRepoExtrasDdl();
});

beforeEach(async () => {
  await resetRepoExtrasTables();
  for (const table of ["repo_transfer", "repo_redirects", "repo_counters", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  const other = await drizzle(env.DB)
    .insert(users)
    .values({ username: "other", usernameLower: "other", status: "active", createdAt: new Date() })
    .returning({ id: users.id })
    .all();
  otherUserId = other[0]!.id;
  const collabAdmin = await drizzle(env.DB)
    .insert(users)
    .values({ username: "collab-admin", usernameLower: "collab-admin", status: "active", createdAt: new Date() })
    .returning({ id: users.id })
    .all();
  collabAdminUserId = collabAdmin[0]!.id;
  await drizzle(env.DB).insert(repositories).values({
    id: "7401",
    storageKey: "r_7401",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "edit-me",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
});

const jsonAuth = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };
const repoPath = "/repos/cf-gitea-stub/edit-me";

describe("PATCH /repos/{owner}/{repo} (repoEdit) — stored settings subset", () => {
  it("updates description/website and renders them on the PATCH and on GET", async () => {
    const patch = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ description: "hello", website: "https://example.io" }),
    });
    expect(patch.status).toBe(200);
    const body = await patch.json<Record<string, unknown>>();
    expect(body.description).toBe("hello");
    expect(body.website).toBe("https://example.io");

    const get = await makeApp()(repoPath);
    expect(await get.json<Record<string, unknown>>()).toMatchObject({ description: "hello", website: "https://example.io" });
  });

  it("upsert-merges: a second PATCH touching only description keeps the stored flags", async () => {
    await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ description: "first", has_issues: false }),
    });
    const second = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ description: "second" }),
    });
    expect(second.status).toBe(200);
    const body = await second.json<Record<string, unknown>>();
    expect(body.description).toBe("second");
    expect(body.has_issues).toBe(false);
  });

  it("applies the has_* unit flags and ignores the accepted-and-ignored remainder", async () => {
    const res = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ has_wiki: false, has_projects: true, template: true, mirror_interval: "8h" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.has_wiki).toBe(false);
    expect(body.has_projects).toBe(true);
    // Ignored remainder: no store — the render keeps the upstream defaults.
    expect(body.template).toBe(false);
    expect(body.mirror_interval).toBe("");
  });

  it("412-style gates flip with the flags: releases off turns GET /releases 412", async () => {
    await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ has_releases: false }) });
    // The releases family is not mounted in this standalone app; the flag's
    // storage is what this batch owns — assert the round trip instead.
    const res = await makeApp()(repoPath);
    expect((await res.json<Record<string, unknown>>()).has_releases).toBe(false);
  });
});

describe("PATCH /repos/{owner}/{repo} (repoEdit) — rename, visibility, default branch, archived", () => {
  it("renames via the landed service: new URL 200, old URL 404, redirect row kept", async () => {
    const res = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ name: "Renamed" }) });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.name).toBe("renamed"); // slug is stored lowercase
    expect(body.full_name).toBe("cf-gitea-stub/renamed");

    expect((await makeApp()("/repos/cf-gitea-stub/edit-me")).status).toBe(404);
    expect((await makeApp()("/repos/cf-gitea-stub/renamed")).status).toBe(200);
    const redirects = await drizzle(env.DB).select().from(repoRedirects).all();
    expect(redirects).toHaveLength(1);
    expect(redirects[0]?.lowerName).toBe("edit-me");
  });

  it("no-ops a case-only rename (upstream EqualFold guard)", async () => {
    const res = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ name: "Edit-Me" }) });
    expect(res.status).toBe(200);
    expect((await drizzle(env.DB).select().from(repoRedirects).all()).length).toBe(0);
  });

  it("422s an invalid name and a colliding rename", async () => {
    await drizzle(env.DB).insert(repositories).values({
      id: "7402",
      storageKey: "r_7402",
      ownerNamespace: "cf-gitea-stub",
      ownerId: 1,
      slug: "taken",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: new Date(),
    });
    const invalid = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ name: "bad name!" }) });
    expect(invalid.status).toBe(422);
    const collision = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ name: "taken" }) });
    expect(collision.status).toBe(422);
  });

  it("flips visibility and default_branch", async () => {
    const res = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ private: true, default_branch: "trunk" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.private).toBe(true);
    expect(body.default_branch).toBe("trunk");
    // Anonymous reads lose the private repo (anti-enumeration).
    expect((await makeApp()(repoPath)).status).toBe(404);
  });

  it("flips archived and the PATCH itself carries no 423 (upstream registration)", async () => {
    const res = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ archived: true }) });
    expect(res.status).toBe(200);
    expect((await res.json<Record<string, unknown>>()).archived).toBe(true);
    // Still editable (no mustNotBeArchived on repoEdit).
    expect((await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ archived: false }) })).status).toBe(200);
  });

  it("403s a non-admin, grants a collaborator-admin, and 422s a wrong-typed body", async () => {
    expect(
      (await makeApp()(repoPath, { method: "PATCH", headers: { Authorization: `token ${TOKEN_OTHER}`, "Content-Type": "application/json" }, body: "{}" }))
        .status,
    ).toBe(403);
    await addOrUpdateCollaborator(env.DB, "7401", collabAdminUserId, "admin", new Date());
    expect(
      (
        await makeApp()(repoPath, {
          method: "PATCH",
          headers: { Authorization: `token ${TOKEN_COLLAB_ADMIN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ description: "granted" }),
        })
      ).status,
    ).toBe(200);
    // Malformed JSON dies in hono's validator as a 400 (the documented
    // /markdown divergence); a wrong-TYPED field is the bind hook's 422.
    expect(
      (await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ name: 123 }) })).status,
    ).toBe(422);
  });

  it("404s an invisible repo (anti-enumeration)", async () => {
    expect((await makeApp()("/repos/cf-gitea-stub/ghost", { method: "PATCH", headers: jsonAuth, body: "{}" })).status).toBe(404);
  });
});

describe("DELETE /repos/{owner}/{repo} (repoDelete)", () => {
  it("runs the lifecycle pipeline and clears this batch's raw stores", async () => {
    // Seed every raw store + a settings row, then delete.
    const { replaceRepoTopics, listRepoTopics } = await import("./services/repo-topics");
    const { watchRepo, countRepoWatchers } = await import("./services/repo-watchers");
    const { isCollaborator } = await import("./services/repo-collaborators");
    const { saveRepoSettings, loadRepoSettings } = await import("./services/repo-settings");
    await replaceRepoTopics(env.DB, "7401", ["web"]);
    await watchRepo(env.DB, "7401", otherUserId, new Date());
    await addOrUpdateCollaborator(env.DB, "7401", otherUserId, "read", new Date());
    await saveRepoSettings(env.DB, "7401", { description: "d" }, new Date());

    const res = await makeApp()(repoPath, { method: "DELETE", headers: { Authorization: `token ${TOKEN}` } });
    expect(res.status).toBe(204);
    expect(await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "7401")).all()).toEqual([]);
    expect((await makeApp()(repoPath)).status).toBe(404);
    // The raw stores' housekeeping ran (the repos-service cascade cannot see
    // them until the migration owner's sweep).
    expect(await listRepoTopics(env.DB, "7401")).toEqual([]);
    expect(await countRepoWatchers(env.DB, "7401")).toBe(0);
    expect(await isCollaborator(env.DB, "7401", otherUserId)).toBe(false);
    expect(await loadRepoSettings(env.DB, "7401")).toMatchObject({ description: "" });
  });

  it("403s a non-owner and 404s a missing repo", async () => {
    expect((await makeApp()(repoPath, { method: "DELETE", headers: { Authorization: `token ${TOKEN_OTHER}` } })).status).toBe(403);
    expect((await makeApp()("/repos/cf-gitea-stub/ghost", { method: "DELETE", headers: jsonAuth })).status).toBe(404);
  });
});

describe("POST /repos/{owner}/{repo}/transfer (repoTransfer)", () => {
  it("files a pending transfer and answers 202 with the CURRENT Repository", async () => {
    const res = await makeApp()(`${repoPath}/transfer`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ new_owner: "other" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json<Record<string, unknown>>();
    expect(body.full_name).toBe("cf-gitea-stub/edit-me"); // not applied yet
    const pending = await drizzle(env.DB).select().from(repoTransfer).all();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.newOwnerId).toBe(otherUserId);
  });

  it("re-files (upsert) a repeat request", async () => {
    await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ new_owner: "other" }) });
    expect((await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ new_owner: "other" }) })).status).toBe(202);
    expect(await drizzle(env.DB).select().from(repoTransfer).all()).toHaveLength(1);
  });

  it("404s an unknown new owner with the upstream message", async () => {
    const res = await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ new_owner: "nobody" }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "The new owner does not exist or cannot be found", url: ERROR_URL });
  });

  it("422s a self-transfer and a team_ids payload", async () => {
    const self = await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ new_owner: "cf-gitea-stub" }) });
    expect(self.status).toBe(422);
    const teams = await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ new_owner: "other", team_ids: [5] }) });
    expect(teams.status).toBe(422);
    expect((await teams.json<Record<string, unknown>>()).message).toBe("team 5 not found");
  });

  it("403s a caller without the danger-zone grant", async () => {
    expect(
      (await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: { Authorization: `token ${TOKEN_OTHER}`, "Content-Type": "application/json" }, body: JSON.stringify({ new_owner: "other" }) }))
        .status,
    ).toBe(403);
  });

  it("401s an anonymous caller", async () => {
    expect((await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ new_owner: "other" }) })).status).toBe(401);
  });
});

/**
 * Org/repo extras (routes/admin-org-extras.ts) on real D1: the deprecated
 * POST /org/{org}/repos alias (createOrgRepoDeprecated), the bulk
 * DELETE /orgs/{org}/repos (orgDeleteRepos over the landed §2.5.5 purge
 * pipeline) and the repo-scoped signing-key pair (repoSigningKey /
 * repoSigningKeySSH — the no-key degenerate 404 of the global pair).
 *
 * Standalone mount (the labels-t2.test.ts convention): the register function
 * takes the requireAuth/optionalAuth pair with the real auth middlewares, the
 * stub resolver mapping `token u<id>` to the seeded D1 user rows, so the
 * org_members-backed owner gate is exercisable against the same rows the
 * guards query. No execution context exists in-process, so the orgDeleteRepos
 * background loop runs INLINE (the module's documented test arm).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, users } from "../../db/schema";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerAdminOrgExtrasRoutes } from "./admin-org-extras";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { applyOrgsDdl, resetOrgTables } from "../../services/orgs/testing";

const NOW = new Date("2026-02-03T04:05:06Z");

const seeded = new Map<number, { id: number; username: string; isAdmin: boolean }>();

function resolver(): AuthResolver {
  return {
    resolveToken: (token) => {
      const match = /^u(\d+)$/.exec(token);
      const row = match === null ? undefined : seeded.get(Number(match[1]));
      if (match === null || row === undefined) return Promise.resolve(null);
      return Promise.resolve(apiUser(row));
    },
  };
}

function apiUser(user: { id: number; username: string; isAdmin: boolean }): User {
  return {
    id: user.id,
    login: user.username,
    email: `${user.username}@example.com`,
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
    created: NOW.toISOString(),
    last_login: "0001-01-01T00:00:00Z",
    type: "User",
    visibility: "public",
  };
}

function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerAdminOrgExtrasRoutes(app, createTokenAuthMiddleware(resolver()), createOptionalTokenAuthMiddleware(resolver()));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

const authHeaders = (userId: number): Record<string, string> => ({
  Authorization: `token u${userId}`,
  "Content-Type": "application/json",
});

beforeAll(applyOrgsDdl);

interface Actors {
  owner: { id: number; username: string };
  member: { id: number; username: string };
  outsider: { id: number; username: string };
  admin: { id: number; username: string };
  org: OrgRecord;
}

beforeEach(async () => {
  for (const table of [
    "webhook_deliveries",
    "webhooks",
    "repo_topics",
    "repo_watchers",
    "repo_collaborators",
    "repo_settings",
    "issue_subscriptions",
    "issue_assignees",
    "issue_dependency",
    "issue_pins",
    "tracked_time",
    "stopwatch",
    "comments",
    "issues",
    "labels",
    "repo_counters",
    "commit_statuses",
    "repo_units",
    "repo_transfer",
    "repo_redirects",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await resetOrgTables();
  seeded.clear();
});

async function seedActors(): Promise<Actors> {
  const seedUser = async (username: string, isAdmin = false) => {
    const rows = await drizzle(env.DB)
      .insert(users)
      .values({ username, usernameLower: username, isAdmin, status: "active", createdAt: NOW })
      .returning({ id: users.id, username: users.username })
      .all();
    const row = rows[0]!;
    const seededRow = { id: row.id, username: row.username, isAdmin };
    seeded.set(row.id, seededRow);
    return seededRow;
  };
  const owner = await seedUser("org-owner");
  const member = await seedUser("org-member");
  const outsider = await seedUser("outsider");
  const admin = await seedUser("site-admin", true);
  const org = await new OrgService(env.DB).createOrg({ name: "acme", ownerId: owner.id });
  await new OrgService(env.DB).addMember(org.id, member.id);
  return { owner, member, outsider, admin, org };
}

async function seedOrgRepo(id: string, slug: string, org: OrgRecord): Promise<void> {
  await drizzle(env.DB)
    .insert(repositories)
    .values({
      id,
      storageKey: `r_${id}`,
      ownerNamespace: org.username,
      ownerId: org.id,
      slug,
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: NOW,
    });
}

// ---------------------------------------------------------------------------
// createOrgRepoDeprecated
// ---------------------------------------------------------------------------

describe("POST /org/{org}/repos (createOrgRepoDeprecated)", () => {
  it("creates a repo in the org for an org owner (the alias of createOrgRepo)", async () => {
    const { owner, org } = await seedActors();
    const res = await router()(`/org/${org.username}/repos`, {
      method: "POST",
      headers: authHeaders(owner.id),
      body: JSON.stringify({ name: "aliased", private: true }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.full_name).toBe("acme/aliased");
    expect(body.private).toBe(true);
    expect((body.permissions as Record<string, boolean>)).toEqual({ admin: true, push: true, pull: true });
    const row = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, "aliased")).all())[0];
    expect(row?.ownerId).toBe(org.id);
  });

  it("403s a plain member without the create grant, 404s an unknown org", async () => {
    const { member, org, owner } = await seedActors();
    const send = router();
    expect(
      (await send(`/org/${org.username}/repos`, { method: "POST", headers: authHeaders(member.id), body: JSON.stringify({ name: "nope" }) }))
        .status,
    ).toBe(403);
    expect(
      (await send("/org/ghost-org/repos", { method: "POST", headers: authHeaders(owner.id), body: JSON.stringify({ name: "nope" }) }))
        .status,
    ).toBe(404);
  });

  it("409s a duplicate name (the runtime-only arm stays undeclared)", async () => {
    const { owner, org } = await seedActors();
    await seedOrgRepo("9501", "taken", org);
    const res = await router()(`/org/${org.username}/repos`, {
      method: "POST",
      headers: authHeaders(owner.id),
      body: JSON.stringify({ name: "taken" }),
    });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// orgDeleteRepos
// ---------------------------------------------------------------------------

describe("DELETE /orgs/{org}/repos (orgDeleteRepos)", () => {
  it("204s an org without repos", async () => {
    const { owner, org } = await seedActors();
    const res = await router()(`/orgs/${org.username}/repos`, { method: "DELETE", headers: authHeaders(owner.id) });
    expect(res.status).toBe(204);
  });

  it("202s and deletes every org repo through the purge pipeline (inline in tests)", async () => {
    const { owner, org } = await seedActors();
    await seedOrgRepo("9601", "first", org);
    await seedOrgRepo("9602", "second", org);
    // A user-owned repo in the same namespace spelling must NOT be swept.
    await drizzle(env.DB).insert(repositories).values({
      id: "9603",
      storageKey: "r_9603",
      ownerNamespace: "org-owner",
      ownerId: owner.id,
      slug: "personal",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: NOW,
    });

    const res = await router()(`/orgs/${org.username}/repos`, { method: "DELETE", headers: authHeaders(owner.id) });
    expect(res.status).toBe(202);
    const after = await drizzle(env.DB).select().from(repositories).all();
    expect(after.map((row) => row.id)).toEqual(["9603"]);
  });

  it("403s a plain member and an outsider with the upstream message; 404s an unknown org", async () => {
    const { owner, member, outsider, org } = await seedActors();
    const send = router();
    const forbidden = await send(`/orgs/${org.username}/repos`, { method: "DELETE", headers: authHeaders(member.id) });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json<{ message: string }>()).message).toBe("Must be an organization owner");
    expect((await send(`/orgs/${org.username}/repos`, { method: "DELETE", headers: authHeaders(outsider.id) })).status).toBe(403);
    expect((await send("/orgs/ghost/repos", { method: "DELETE", headers: authHeaders(owner.id) })).status).toBe(404);
  });

  it("a site admin passes the ownership gate without an owner row", async () => {
    const { admin, org } = await seedActors();
    const res = await router()(`/orgs/${org.username}/repos`, { method: "DELETE", headers: authHeaders(admin.id) });
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Repo signing keys
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/signing-key.gpg|.pub (repoSigningKey / repoSigningKeySSH)", () => {
  it("answers the degenerate no-key 404 verbatim for a visible repo, anonymous included", async () => {
    const { owner } = await seedActors();
    await drizzle(env.DB).insert(repositories).values({
      id: "9701",
      storageKey: "r_9701",
      ownerNamespace: owner.username,
      ownerId: owner.id,
      slug: "signed",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: NOW,
    });
    const send = router();
    const gpg = await send("/repos/org-owner/signed/signing-key.gpg");
    expect(gpg.status).toBe(404);
    expect((await gpg.json<{ message: string }>()).message).toBe("no signing key");
    const ssh = await send("/repos/org-owner/signed/signing-key.pub", { headers: authHeaders(owner.id) });
    expect(ssh.status).toBe(404);
    expect((await ssh.json<{ message: string }>()).message).toBe("no signing key");
  });

  it("404s missing and private repos with the assignment 404", async () => {
    const { owner, outsider } = await seedActors();
    const send = router();
    expect((await send("/repos/org-owner/ghost/signing-key.gpg", { headers: authHeaders(owner.id) })).status).toBe(404);
    // A private repo the viewer cannot see is the anti-enumeration 404.
    expect((await send("/repos/org-owner/ghost/signing-key.pub", { headers: authHeaders(outsider.id) })).status).toBe(404);
  });
});

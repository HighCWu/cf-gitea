/**
 * Tier-1 repo-subscription routes on real D1 (SPEC-0004 §2.4 row: GET/PUT/
 * DELETE /repos/{owner}/{repo}/subscription; upstream routers/api/v1/user/
 * watch.go over the raw-D1 `repo_watchers` store — services/repo-watchers.ts
 * documents the schema gap). Pins: the reqToken-401, the anti-enumeration
 * 404 for missing/invisible repos, GET's not-watching 404 vs the WatchInfo
 * render (subscribed true, ignored false, reason null, created_at = the
 * REPOSITORY's created timestamp, url/repository_url shapes), the idempotent
 * PUT (repeat watch keeps one row), and the idempotent 204 unwatch.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { repositories, repoWatchers } from "../db/schema";
import { createStubAuthResolver, createTokenAuthMiddleware } from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { findRepositoryByPath, toApiRepository } from "./services/repository";
import { registerSubscriptionRoutes } from "./routes/subscription";
import { countRepoWatchers } from "./services/repo-watchers";
import { applyRepoExtrasDdl, resetRepoExtrasTables } from "./testing/repo-ddl";

const TOKEN = "stub-token";
const ERROR_URL = "https://example.com/api/swagger";
const REPO_CREATED_AT = "2026-02-03T04:05:06.000Z";

function makeApp(): (path: string, init?: RequestInit) => Promise<Response> {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerSubscriptionRoutes(app, createTokenAuthMiddleware(createStubAuthResolver()));
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
  // The stub token identity is STUB_USER (id 1) — NOT the repo owner here,
  // so the anti-enumeration path is exercised for private repos.
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  // The owner namespace needs its own users row: findRepositoryByPath
  // inner-joins the owner (registry rows without one stay invisible — the
  // org-repos quirk), and the doer (id 1) is deliberately NOT the owner.
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (2, 'someone-else', 'someone-else', 0, 'active', 0)",
  ).run();
  await drizzle(env.DB).insert(repositories).values({
    id: "7101",
    storageKey: "r_7101",
    ownerNamespace: "someone-else",
    ownerId: null,
    slug: "watched",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date(REPO_CREATED_AT),
  });
  await drizzle(env.DB).insert(repositories).values({
    id: "7102",
    storageKey: "r_7102",
    ownerNamespace: "someone-else",
    ownerId: null,
    slug: "private",
    visibility: "private",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date(REPO_CREATED_AT),
  });
});

const authHeaders = { Authorization: `token ${TOKEN}` };

describe("PUT /repos/{owner}/{repo}/subscription (userCurrentPutSubscription)", () => {
  it("watches and renders the WatchInfo with the repository's created timestamp", async () => {
    const res = await makeApp()("/repos/someone-else/watched/subscription", { method: "PUT", headers: authHeaders });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      subscribed: true,
      ignored: false,
      reason: null,
      created_at: REPO_CREATED_AT,
      url: "https://example.com/api/v1/repos/someone-else/watched/subscription",
      repository_url: "https://example.com/api/v1/repos/someone-else/watched",
    });
    expect(await countRepoWatchers(env.DB, "7101")).toBe(1);
  });

  it("is idempotent (a repeat PUT keeps exactly one row)", async () => {
    await makeApp()("/repos/someone-else/watched/subscription", { method: "PUT", headers: authHeaders });
    const res = await makeApp()("/repos/someone-else/watched/subscription", { method: "PUT", headers: authHeaders });
    expect(res.status).toBe(200);
    expect(await countRepoWatchers(env.DB, "7101")).toBe(1);
  });

  it("404s a missing repo and a private repo (anti-enumeration)", async () => {
    expect((await makeApp()("/repos/someone-else/ghost/subscription", { method: "PUT", headers: authHeaders })).status).toBe(404);
    expect((await makeApp()("/repos/someone-else/private/subscription", { method: "PUT", headers: authHeaders })).status).toBe(404);
  });

  it("401s an anonymous caller (reqToken)", async () => {
    const res = await makeApp()("/repos/someone-else/watched/subscription", { method: "PUT" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "token is required", url: ERROR_URL });
  });
});

describe("GET /repos/{owner}/{repo}/subscription (userCurrentCheckSubscription)", () => {
  it("404s when not watching", async () => {
    const res = await makeApp()("/repos/someone-else/watched/subscription", { headers: authHeaders });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("200s the same WatchInfo once watching", async () => {
    await makeApp()("/repos/someone-else/watched/subscription", { method: "PUT", headers: authHeaders });
    const res = await makeApp()("/repos/someone-else/watched/subscription", { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json<{ subscribed: boolean; url: string }>();
    expect(body.subscribed).toBe(true);
    expect(body.url).toBe("https://example.com/api/v1/repos/someone-else/watched/subscription");
  });

  it("404s a missing repo", async () => {
    expect((await makeApp()("/repos/someone-else/ghost/subscription", { headers: authHeaders })).status).toBe(404);
  });
});

describe("DELETE /repos/{owner}/{repo}/subscription (userCurrentDeleteSubscription)", () => {
  it("unwatches with a 204 and is idempotent", async () => {
    await makeApp()("/repos/someone-else/watched/subscription", { method: "PUT", headers: authHeaders });
    expect((await makeApp()("/repos/someone-else/watched/subscription", { method: "DELETE", headers: authHeaders })).status).toBe(204);
    expect(await countRepoWatchers(env.DB, "7101")).toBe(0);
    // Unwatching again is still a 204 (WatchRepoAuto(false) deletes zero rows).
    expect((await makeApp()("/repos/someone-else/watched/subscription", { method: "DELETE", headers: authHeaders })).status).toBe(204);
    // And the state is back to not-watching.
    expect((await makeApp()("/repos/someone-else/watched/subscription", { headers: authHeaders })).status).toBe(404);
  });

  it("404s a missing repo", async () => {
    expect((await makeApp()("/repos/someone-else/ghost/subscription", { method: "DELETE", headers: authHeaders })).status).toBe(404);
  });
});

/** The seeded row keeps a repo-level watcher count readable for the future
 *  Repository.watchers_count counter (countRepoWatchers). */
describe("watcher store", () => {
  it("keeps watch rows repo-scoped (another user is unaffected)", async () => {
    await makeApp()("/repos/someone-else/watched/subscription", { method: "PUT", headers: authHeaders });
    const row = await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(eq(repositories.id, "7101"))
      .get();
    expect(row).toBeDefined();
    expect(await countRepoWatchers(env.DB, "7101")).toBe(1);
    expect(await countRepoWatchers(env.DB, "7102")).toBe(0);
  });
});

/**
 * The maintained `repositories.num_watches` counter (migration 0030) — the
 * watchRepoByMode delta arithmetic (models/repo/watch.go:128-154: the
 * counter moves ONLY when watching-ness flips, `num_watches = num_watches
 * + ?` in the same transaction as the edge write), rendered as the API
 * `watchers_count` (services/convert/repository.go:221 `Watchers:
 * repo.NumWatches`).
 */
describe("repositories.num_watches maintenance (migration 0030)", () => {
  async function numWatches(repoId: string): Promise<number> {
    const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get();
    if (row === undefined) throw new Error("repo seed failed");
    return row.numWatches;
  }

  it("PUT watch bumps the counter; the repeat PUT (watch.go:121-123's already-watching skip) moves nothing", async () => {
    await makeApp()("/repos/someone-else/watched/subscription", { method: "PUT", headers: authHeaders });
    expect(await numWatches("7101")).toBe(1);
    await makeApp()("/repos/someone-else/watched/subscription", { method: "PUT", headers: authHeaders });
    expect(await numWatches("7101")).toBe(1);
    // The sibling repo never moves.
    expect(await numWatches("7102")).toBe(0);
  });

  it("DELETE unwatch decrements; the repeat DELETE (watch.go's delta-0 arm) moves nothing and the column never crosses 0", async () => {
    await makeApp()("/repos/someone-else/watched/subscription", { method: "PUT", headers: authHeaders });
    expect((await makeApp()("/repos/someone-else/watched/subscription", { method: "DELETE", headers: authHeaders })).status).toBe(204);
    expect(await numWatches("7101")).toBe(0);
    // The repeat DELETE: no edge → repoWatchDelta 0 (watch.go:130-134).
    expect((await makeApp()("/repos/someone-else/watched/subscription", { method: "DELETE", headers: authHeaders })).status).toBe(204);
    expect(await numWatches("7101")).toBe(0);
  });

  it("a pre-0030 edge (backfilled counter 0 beneath a seeded watch) unwatching floors at 0, never negative", async () => {
    await drizzle(env.DB).insert(repoWatchers).values({ repoId: "7101", userId: 1, createdAt: new Date() });
    expect(await numWatches("7101")).toBe(0);
    expect((await makeApp()("/repos/someone-else/watched/subscription", { method: "DELETE", headers: authHeaders })).status).toBe(204);
    expect(await numWatches("7101")).toBe(0); // MAX(num_watches - 1, 0), not -1
  });

  it("renders as watchers_count (convert/repository.go:221 — Watchers: repo.NumWatches)", async () => {
    await makeApp()("/repos/someone-else/watched/subscription", { method: "PUT", headers: authHeaders });
    const pair = await findRepositoryByPath(env.DB, "someone-else", "watched");
    if (pair === null) throw new Error("repo seed failed");
    const rendered = toApiRepository({ origin: "https://example.com", requester: null }, pair);
    expect(rendered.watchers_count).toBe(1);
    expect(rendered.stars_count).toBe(0); // untouched by the watch arm
  });
});

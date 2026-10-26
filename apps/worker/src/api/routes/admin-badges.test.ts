/**
 * The /admin/users/{username}/badges family (long-tail batch), route-level
 * on real D1 (the tag-protections.test.ts standalone-mount convention; the
 * family is pure D1 — no engine cells).
 *
 * Matrix: the list render shape (Badge, structs/user.go:120-125, X-Total-Count
 * included), the site-admin 403 ("user should be the site admin") on every
 * op, the UserAssignmentAPI 404 on an unknown target, the 307 redirect seam,
 * the add arms (204 happy, 500 "badge does not exist [slug: x]" for an
 * unknown slug, 500 "user badge already exists [user_id: ..., badge_id: ...]"
 * on the duplicate pair, 422 on a body missing badge_slugs, 204 on the
 * empty-array body Go's binding:"Required" lets through), and the delete
 * arms (204 removes, 204 silently absorbs unknown slugs — RemoveUserBadges'
 * no-op, 422 without a body).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import type { ApiEnv } from "../env";
import { giteaErrorHandler } from "../errors";
import { registerAdminBadgeRoutes } from "./admin-badges";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["user_badge", "badge", "user_redirects", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const [id, username, isAdmin, type] of [
    [1, "doer", 0, "user"], // a plain authenticated non-admin
    [2, "bob", 0, "user"], // the badge target
    [3, "chief", 1, "user"], // site admin
    [20, "acme", 0, "org"], // an org row (a valid ContextUser)
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (?, ?, ?, ?, 'active', ?, 0)",
    )
      .bind(id, username, username, isAdmin, type)
      .run();
  }
  for (const [slug, description] of [
    ["badge1", "First badge"],
    ["badge2", null],
  ] as const) {
    await env.DB.prepare("INSERT INTO badge (slug, description, image_url) VALUES (?, ?, 'https://img.example/x.png')").bind(slug, description).run();
  }
});

const DOER_TOKEN = "token-doer";
const CHIEF_TOKEN = "token-chief";

const IDENTITY_TOKENS: Record<string, { id: number; login: string; is_admin: boolean }> = {
  [DOER_TOKEN]: { id: 1, login: "doer", is_admin: false },
  [CHIEF_TOKEN]: { id: 3, login: "chief", is_admin: true },
};

const resolver: AuthResolver = { resolveToken: (token: string) => Promise.resolve(IDENTITY_TOKENS[token] ?? null) };

/** Local mount of the orchestrator's registration seam (requireAuth only —
 *  the site-admin gate is route middleware). Paths strip the /api/v1 prefix. */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerAdminBadgeRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const authed = (token: string, init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers ?? {}), Authorization: `token ${token}`, "Content-Type": "application/json" },
});

describe("GET /admin/users/{username}/badges (adminListUserBadges)", () => {
  it("lists the user's badges with the full Badge render + the total-count header", async () => {
    const post = await router()("/api/v1/admin/users/bob/badges", authed(CHIEF_TOKEN, { method: "POST", body: JSON.stringify({ badge_slugs: ["badge2", "badge1"] }) }));
    expect(post.status).toBe(204);

    const res = await router()("/api/v1/admin/users/bob/badges", authed(CHIEF_TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    const body = await res.json<Array<{ id: number; slug: string; description: string; image_url: string }>>();
    // insertion order (user_badge.id), and EVERY field renders (no omitempty)
    expect(body.map((b) => b.slug)).toEqual(["badge2", "badge1"]);
    expect(body[1]).toEqual({ id: body[1]!.id, slug: "badge1", description: "First badge", image_url: "https://img.example/x.png" });
    expect(body[0]!.description).toBe(""); // NULL renders as Go's zero string
  });

  it("answers [] for a badge-less user", async () => {
    const res = await router()("/api/v1/admin/users/bob/badges", authed(CHIEF_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("403s a non-site-admin and 404s an unknown target (admin-first order)", async () => {
    const res = await router()("/api/v1/admin/users/bob/badges", authed(DOER_TOKEN));
    expect(res.status).toBe(403);
    expect((await res.json<{ message: string }>()).message).toBe("user should be the site admin");

    const ghost = await router()("/api/v1/admin/users/ghost/badges", authed(CHIEF_TOKEN));
    expect(ghost.status).toBe(404);
    expect((await ghost.json<{ message: string }>()).message).toBe("user redirect does not exist [name: ghost]");
  });

  it("307s a renamed target to its canonical name (UserAssignmentAPI redirect arm)", async () => {
    await env.DB.prepare("INSERT INTO user_redirects (lower_name, redirect_user_id) VALUES ('oldbob', 2)").run();
    const res = await router()("/api/v1/admin/users/oldbob/badges", authed(CHIEF_TOKEN));
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("/admin/users/bob/badges");
  });

  it("401s an anonymous caller (runtime-only arm — the contract declares none)", async () => {
    const res = await router()("/api/v1/admin/users/bob/badges");
    expect(res.status).toBe(401);
  });
});

describe("POST /admin/users/{username}/badges (adminAddUserBadges)", () => {
  it("adds every listed badge and answers 204", async () => {
    const res = await router()(
      "/api/v1/admin/users/bob/badges",
      authed(CHIEF_TOKEN, { method: "POST", body: JSON.stringify({ badge_slugs: ["badge1", "badge2"] }) }),
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const rows = await env.DB.prepare("SELECT badge_id, user_id FROM user_badge ORDER BY id").all<{ badge_id: number; user_id: number }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((row) => row.user_id === 2)).toBe(true);
  });

  it("accepts the empty array (Go binding:Required passes non-nil empty slices)", async () => {
    const res = await router()(
      "/api/v1/admin/users/bob/badges",
      authed(CHIEF_TOKEN, { method: "POST", body: JSON.stringify({ badge_slugs: [] }) }),
    );
    expect(res.status).toBe(204);
  });

  it("422s a body without badge_slugs (runtime-only arm — the contract declares it only on DELETE)", async () => {
    const res = await router()("/api/v1/admin/users/bob/badges", authed(CHIEF_TOKEN, { method: "POST", body: JSON.stringify({}) }));
    expect(res.status).toBe(422);
  });

  it("500s an unknown slug with upstream's exact internal-error text", async () => {
    const res = await router()(
      "/api/v1/admin/users/bob/badges",
      authed(CHIEF_TOKEN, { method: "POST", body: JSON.stringify({ badge_slugs: ["nope"] }) }),
    );
    expect(res.status).toBe(500);
    expect((await res.json<{ message: string }>()).message).toBe("badge does not exist [slug: nope]");
  });

  it("500s a duplicate pair with upstream's exact internal-error text", async () => {
    const first = await router()(
      "/api/v1/admin/users/bob/badges",
      authed(CHIEF_TOKEN, { method: "POST", body: JSON.stringify({ badge_slugs: ["badge1"] }) }),
    );
    expect(first.status).toBe(204);
    const second = await router()(
      "/api/v1/admin/users/bob/badges",
      authed(CHIEF_TOKEN, { method: "POST", body: JSON.stringify({ badge_slugs: ["badge1"] }) }),
    );
    expect(second.status).toBe(500);
    const badgeId = (await env.DB.prepare("SELECT id FROM badge WHERE slug = 'badge1'").first<{ id: number }>())!.id;
    expect((await second.json<{ message: string }>()).message).toBe(
      `user badge already exists [user_id: 2, badge_id: ${badgeId}]`,
    );
  });

  it("403s a non-site-admin before the user lookup", async () => {
    const res = await router()(
      "/api/v1/admin/users/ghost/badges",
      authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ badge_slugs: ["badge1"] }) }),
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /admin/users/{username}/badges (adminDeleteUserBadges)", () => {
  it("removes only the listed edges and answers 204", async () => {
    await router()("/api/v1/admin/users/bob/badges", authed(CHIEF_TOKEN, { method: "POST", body: JSON.stringify({ badge_slugs: ["badge1", "badge2"] }) }));
    const res = await router()(
      "/api/v1/admin/users/bob/badges",
      authed(CHIEF_TOKEN, { method: "DELETE", body: JSON.stringify({ badge_slugs: ["badge1"] }) }),
    );
    expect(res.status).toBe(204);
    const slugs = await env.DB.prepare("SELECT b.slug FROM user_badge ub JOIN badge b ON b.id = ub.badge_id").all<{ slug: string }>();
    expect(slugs.results.map((r) => r.slug)).toEqual(["badge2"]);
  });

  it("silently absorbs unknown slugs (RemoveUserBadges' no-op arm)", async () => {
    await router()("/api/v1/admin/users/bob/badges", authed(CHIEF_TOKEN, { method: "POST", body: JSON.stringify({ badge_slugs: ["badge1"] }) }));
    const res = await router()(
      "/api/v1/admin/users/bob/badges",
      authed(CHIEF_TOKEN, { method: "DELETE", body: JSON.stringify({ badge_slugs: ["missing", "badge1"] }) }),
    );
    expect(res.status).toBe(204);
    const count = await env.DB.prepare("SELECT count(*) AS n FROM user_badge").first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("422s a body without badge_slugs (the contract's declared validation arm)", async () => {
    const res = await router()("/api/v1/admin/users/bob/badges", authed(CHIEF_TOKEN, { method: "DELETE", body: JSON.stringify({}) }));
    expect(res.status).toBe(422);
  });

  it("403s a non-site-admin", async () => {
    const res = await router()(
      "/api/v1/admin/users/bob/badges",
      authed(DOER_TOKEN, { method: "DELETE", body: JSON.stringify({ badge_slugs: ["badge1"] }) }),
    );
    expect(res.status).toBe(403);
  });
});

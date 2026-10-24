/**
 * Tier-1 user-directory routes on real D1 (SPEC-0004 §2.4 rows: userGet /
 * userSearch). Seeds `users` rows through Drizzle, boots the API router with
 * the stub auth resolver, and asserts the User field set against the frozen
 * vendored contract, the email visibility rule (self/admin only), the
 * upstream anti-enumeration 404, and the runtime pagination headers.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../db/schema";
import { STUB_USER } from "./auth";
import { createApiRouter } from "./router";
import contract from "../compat/contract/v1-swagger.generated.json";

// The vitest plugin's per-test storage isolation discards setupFiles-era D1
// writes; schema from `beforeAll` migrations persists for the file (same
// pattern as the SPEC-0002 suites, shared helper).
beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM users").run();
});

const db = () => drizzle(env.DB);

const SWAGGER_USER_FIELDS = Object.keys(contract.definitions.User.properties).sort();

/** Indexed access under noUncheckedIndexedAccess — explicit guard instead of `!`. */
function firstOf<T>(items: T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error("expected a non-empty array");
  return first;
}

const STUB_LOGIN = STUB_USER.login ?? "cf-gitea-stub";
const TOKEN = "stub-token";
const authHeaders = { Authorization: `token ${TOKEN}` };
const ERROR_URL = "https://example.com/api/swagger";

async function seedUser(
  username: string,
  opts: { email?: string; displayName?: string; isAdmin?: boolean } = {},
): Promise<{ id: number; usernameLower: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      email: opts.email ?? null,
      displayName: opts.displayName ?? null,
      isAdmin: opts.isAdmin ?? false,
      status: "active",
      createdAt: new Date("2026-01-02T03:04:05Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, usernameLower: user.usernameLower };
}

/**
 * The plain `app.request()` helper builds requests WITHOUT worker bindings
 * (`c.env.DB` would be undefined); `app.fetch(request, env)` injects the real
 * test-worker bindings, matching how src/index.ts mounts the router.
 */
const router = () => {
  const app = createApiRouter();
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
};

describe("GET /users/{username} (userGet)", () => {
  it("mirrors the frozen contract's User field set for an anonymous caller", async () => {
    await seedUser("Alice", { email: "alice@example.com", displayName: "Alice Doe" });

    const res = await router()("/users/Alice");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(SWAGGER_USER_FIELDS);
  });

  it("fills D1-sourced fields, hides the email, and reports public visibility", async () => {
    const alice = await seedUser("Alice", { email: "alice@example.com", displayName: "Alice Doe" });

    const res = await router()("/users/Alice");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();

    expect(body).toMatchObject({
      id: alice.id,
      login: "Alice",
      login_name: "",
      full_name: "Alice Doe",
      email: "", // primary email only for self/admin (upstream convert.ToUser)
      avatar_url: "https://example.com/avatars/alice", // TODO(SPEC-0005): avatar storage
      html_url: "https://example.com/Alice",
      created: "2026-01-02T03:04:05.000Z",
      type: "User",
      visibility: "public", // TODO(SPEC-0007): visibility column — everyone public
      restricted: false, // TODO(SPEC-0007): restricted is a visibility concept
      active: false, // authed-gated upstream — Go-zero for anonymous viewers
      is_admin: false,
      prohibit_login: false,
      last_login: "0001-01-01T00:00:00Z",
      followers_count: 0,
      following_count: 0,
      starred_repos_count: 0,
    });
  });

  it("looks users up case-insensitively", async () => {
    await seedUser("Alice");
    const res = await router()("/users/aLiCe");
    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({ login: "Alice" });
  });

  it("shows the email and gated fields to the user themself", async () => {
    await seedUser(STUB_LOGIN, { email: "stub@example.com" });

    const res = await router()(`/users/${STUB_LOGIN}`, { headers: authHeaders });

    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({
      login: STUB_LOGIN,
      email: "stub@example.com",
      active: true,
      prohibit_login: false,
    });
  });

  it("shows the email and is_admin to a site admin", async () => {
    await seedUser("Alice", { email: "alice@example.com" });
    const admin = { ...STUB_USER, login: "root", is_admin: true };
    const adminApp = createApiRouter({
      auth: { resolveToken: (token) => Promise.resolve(token === "admin-token" ? admin : null) },
    });
    const adminRouter = async (path: string, init?: RequestInit): Promise<Response> =>
      adminApp.fetch(new Request(`https://example.com${path}`, init), env);

    const res = await adminRouter("/users/Alice", {
      headers: { Authorization: "token admin-token" },
    });

    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({
      login: "Alice",
      email: "alice@example.com",
    });
  });

  it("404s a missing user with the exact Gitea body", async () => {
    const res = await router()("/users/ghost");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

describe("GET /users/search (userSearch)", () => {
  it("returns {data, ok:true} with X-Total-Count and the User field set", async () => {
    const alice = await seedUser("Alice");

    const res = await router()("/users/search?q=lic");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("1");
    expect(res.headers.get("Link")).toBeNull();
    const body = await res.json<{ ok: boolean; data: Array<Record<string, unknown>> }>();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(Object.keys(firstOf(body.data)).sort()).toEqual(SWAGGER_USER_FIELDS);
    expect(firstOf(body.data)).toMatchObject({ id: alice.id, login: "Alice" });
  });

  it("matches username_lower substrings case-insensitively", async () => {
    await seedUser("Alice");
    await seedUser("Bob");

    const hit = await router()("/users/search?q=LIC");
    expect(hit.headers.get("X-Total-Count")).toBe("1");
    expect((await hit.json<{ data: Array<{ login: string }> }>()).data.map((u) => u.login)).toEqual(["Alice"]);

    const miss = await router()("/users/search?q=carol");
    expect(miss.headers.get("X-Total-Count")).toBe("0");
    expect((await miss.json<{ ok: boolean; data: unknown[] }>()).data).toEqual([]);
  });

  it("treats q literally — LIKE wildcards are not special (D1 instr match)", async () => {
    await seedUser("a_b");
    await seedUser("axb");

    // A LIKE pattern 'a_b' would match axb too ('_' = any char); the literal
    // substring match matches only a_b.
    const res = await router()("/users/search?q=a_b");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("1");
    expect((await res.json<{ data: Array<{ login: string }> }>()).data.map((u) => u.login)).toEqual(["a_b"]);
  });

  it("orders alphabetically by lower_name", async () => {
    await seedUser("carol");
    await seedUser("Bob");
    await seedUser("alice");

    const res = await router()("/users/search");
    const body = await res.json<{ data: Array<{ login: string }> }>();
    expect(body.data.map((u) => u.login)).toEqual(["alice", "Bob", "carol"]);
  });

  it("paginates with clamps, Link relations, and X-Total-Count", async () => {
    await seedUser("alice");
    await seedUser("bob");
    await seedUser("carol");

    // page/limit clamps: 0-values silently become page=1, limit=30 (upstream
    // ToCorrectPageSize) — never a 422.
    const clamped = await router()("/users/search?page=0&limit=0");
    expect(clamped.status).toBe(200);
    expect(clamped.headers.get("X-Total-Count")).toBe("3");
    expect(clamped.headers.get("Link")).toBeNull();
    expect((await clamped.json<{ data: unknown[] }>()).data).toHaveLength(3);

    const first = await router()("/users/search?limit=2");
    expect(first.headers.get("X-Total-Count")).toBe("3");
    expect(first.headers.get("Link")).toBe(
      '<https://example.com/users/search?limit=2&page=2>; rel="next",' +
        '<https://example.com/users/search?limit=2&page=2>; rel="last"',
    );
    expect((await first.json<{ data: Array<{ login: string }> }>()).data.map((u) => u.login)).toEqual([
      "alice",
      "bob",
    ]);

    const second = await router()("/users/search?limit=2&page=2");
    expect(second.headers.get("Link")).toContain('rel="prev"');
    expect(second.headers.get("Link")).toContain('rel="first"');
    expect((await second.json<{ data: Array<{ login: string }> }>()).data.map((u) => u.login)).toEqual([
      "carol",
    ]);
  });

  it("pins the result to the uid user; keyword still applies (upstream AND)", async () => {
    await seedUser("Alice");
    const bob = await seedUser("Bob");

    const byUid = await router()(`/users/search?uid=${bob.id}`);
    expect(byUid.headers.get("X-Total-Count")).toBe("1");
    expect((await byUid.json<{ data: Array<{ login: string }> }>()).data.map((u) => u.login)).toEqual(["Bob"]);

    const uidAndKeyword = await router()(`/users/search?uid=${bob.id}&q=ali`);
    expect(uidAndKeyword.headers.get("X-Total-Count")).toBe("0");

    const unknownUid = await router()("/users/search?uid=999999");
    expect(unknownUid.headers.get("X-Total-Count")).toBe("0");

    // Negative uids select upstream system users (Ghost/Actions) — none exist.
    const systemUid = await router()("/users/search?uid=-1");
    expect(systemUid.headers.get("X-Total-Count")).toBe("0");
  });

  it("returns no next/last past the end, but keeps upstream's first/prev for page > 1", async () => {
    // genAPILinks (services/context/api.go:180) emits first/prev whenever the
    // current page is past the first — regardless of the total.
    const res = await router()("/users/search?limit=5&page=2");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("0");
    expect(res.headers.get("Link")).toBe(
      '<https://example.com/users/search?limit=5&page=1>; rel="first",' +
        '<https://example.com/users/search?limit=5&page=1>; rel="prev"',
    );
  });
});

/**
 * Tier-1 user-directory routes on real D1 (SPEC-0004 §2.4 rows: userGet /
 * userSearch). Seeds `users` rows through Drizzle, boots the API router with
 * the stub auth resolver, and asserts the User field set against the frozen
 * vendored contract, the email visibility rule (self/admin only), the
 * upstream anti-enumeration 404, the `IsUserVisibleToViewer` ladder
 * (services/user.ts), the directory search's Types filter + viewer ceiling,
 * and the runtime pagination headers.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { follows, orgMembers, users } from "../db/schema";
import { STUB_USER } from "./auth";
import { createApiRouter } from "./router";
import { contractModelProperties } from "../compat/contract/frozen-contract";

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
  seededById.clear();
});

const db = () => drizzle(env.DB);

const SWAGGER_USER_FIELDS = Object.keys(contractModelProperties("User")).sort();

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
const SEED_NOW = new Date("2026-01-02T03:04:05Z");

/** Seeded rows by numeric id — feeds the ladder suite's per-user token resolver. */
const seededById = new Map<number, { username: string; isAdmin: boolean }>();

type SeedOptions = {
  email?: string;
  displayName?: string;
  isAdmin?: boolean;
  visibility?: "public" | "limited" | "private";
};

async function seedUser(
  username: string,
  opts: SeedOptions = {},
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
      visibility: opts.visibility ?? "public",
      createdAt: SEED_NOW,
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededById.set(user.id, { username: user.username, isAdmin: user.isAdmin });
  return { id: user.id, usernameLower: user.usernameLower };
}

/** An org user row (`type: 'org'`, SPEC-0007 §3.2's org-as-user-row model). */
async function seedOrg(
  username: string,
  opts: { visibility?: "public" | "limited" | "private" } = {},
): Promise<{ id: number }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      type: "org",
      visibility: opts.visibility ?? "public",
      createdAt: SEED_NOW,
    })
    .returning()
    .all();
  const org = rows[0];
  if (org === undefined) throw new Error("org seed failed");
  return { id: org.id };
}

async function addOrgMember(orgId: number, userId: number): Promise<void> {
  await db().insert(orgMembers).values({ orgId, userId, isPublic: true, role: "member", createdAt: SEED_NOW });
}

/** `userId` follows `followId` (the follows table's direction). */
async function addFollow(userId: number, followId: number): Promise<void> {
  await db().insert(follows).values({ userId, followId, createdAt: SEED_NOW });
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

/**
 * Ladder-suite router: `token u<id>` resolves to the SEEDED row's identity
 * (follows.test.ts's resolver pattern) so the visibility arms can act as an
 * arbitrary signed-in doer; unknown tokens degrade to anonymous.
 */
const ladderRouter = () => {
  const app = createApiRouter({
    auth: {
      resolveToken(token) {
        const match = /^u(\d+)$/.exec(token);
        const seeded = match === null ? undefined : seededById.get(Number(match[1]));
        if (match === null || seeded === undefined) return Promise.resolve(null);
        return Promise.resolve({
          ...STUB_USER,
          id: Number(match[1]),
          login: seeded.username,
          is_admin: seeded.isAdmin,
        });
      },
    },
  });
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
};

const doerHeaders = (id: number): Record<string, string> => ({ Authorization: `token u${id}` });

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
      visibility: "public", // the real users.visibility column (seeded default)
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

describe("GET /users/{username} — the IsUserVisibleToViewer ladder (services/user.ts)", () => {
  it("fake-404s a private user for anonymous callers, body identical to a miss", async () => {
    await seedUser("secret", { visibility: "private" });

    const res = await router()("/users/secret");

    expect(res.status).toBe(404);
    // Indistinguishable from a missing user (anti-enumeration, user.go:114–117).
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("fake-404s a limited user for anonymous callers (limited needs a signed-in doer)", async () => {
    await seedUser("quiet", { visibility: "limited" });

    const res = await router()("/users/quiet");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("fake-404s a private user for a signed-in stranger", async () => {
    await seedUser("secret", { visibility: "private" });
    const stranger = await seedUser("stranger");

    const res = await ladderRouter()("/users/secret", { headers: doerHeaders(stranger.id) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("200s a limited user for any signed-in doer and renders the real visibility", async () => {
    await seedUser("quiet", { visibility: "limited", email: "quiet@example.com" });
    const viewer = await seedUser("viewer");

    const res = await ladderRouter()("/users/quiet", { headers: doerHeaders(viewer.id) });

    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({
      login: "quiet",
      visibility: "limited",
      email: "", // authed-gated: a stranger sees no email
    });
  });

  it("200s the private user themself with the gated fields and real visibility", async () => {
    const self = await seedUser("secret", { visibility: "private", email: "secret@example.com" });

    const res = await ladderRouter()("/users/secret", { headers: doerHeaders(self.id) });

    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({
      login: "secret",
      visibility: "private",
      email: "secret@example.com",
      active: true,
    });
  });

  it("200s a private user for a site admin", async () => {
    await seedUser("secret", { visibility: "private" });
    const admin = await seedUser("root", { isAdmin: true });

    const res = await ladderRouter()("/users/secret", { headers: doerHeaders(admin.id) });

    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({ login: "secret", visibility: "private" });
  });

  it("200s a private user for a viewer they follow (the IsFollowing private arm)", async () => {
    const secret = await seedUser("secret", { visibility: "private" });
    const viewer = await seedUser("viewer");
    await addFollow(secret.id, viewer.id); // secret follows viewer

    const res = await ladderRouter()("/users/secret", { headers: doerHeaders(viewer.id) });

    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({ login: "secret" });
  });

  it("200s a private user for an org co-member (the shared-org private arm)", async () => {
    const secret = await seedUser("secret", { visibility: "private" });
    const viewer = await seedUser("viewer");
    const org = await seedOrg("acme");
    await addOrgMember(org.id, secret.id);
    await addOrgMember(org.id, viewer.id);

    const res = await ladderRouter()("/users/secret", { headers: doerHeaders(viewer.id) });

    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({ login: "secret" });
  });

  it("renders org rows with type Organization through the same ladder (GetInfo gates every row)", async () => {
    const org = await seedOrg("acme");
    const member = await seedUser("member");
    await addOrgMember(org.id, member.id);
    await seedUser("stranger");

    const anonOrg = await router()("/users/acme");
    expect(anonOrg.status).toBe(200);
    expect(await anonOrg.json<Record<string, unknown>>()).toMatchObject({
      login: "acme",
      type: "Organization", // UserTypeToString over the org user row
    });

    const privateOrg = await seedOrg("clandestine", { visibility: "private" });
    await addOrgMember(privateOrg.id, member.id);

    const anonPrivate = await router()("/users/clandestine");
    expect(anonPrivate.status).toBe(404); // GetInfo's ladder gates org rows too

    const memberView = await ladderRouter()("/users/clandestine", { headers: doerHeaders(member.id) });
    expect(memberView.status).toBe(200);
    expect(await memberView.json<Record<string, unknown>>()).toMatchObject({
      login: "clandestine",
      type: "Organization",
      visibility: "private",
    });

    const strangerView = await ladderRouter()("/users/clandestine", {
      headers: doerHeaders((await seedUser("outsider")).id),
    });
    expect(strangerView.status).toBe(404);
  });
});

describe("GET /users/search — the Types filter and the viewer's can-see ceiling", () => {
  it("excludes org rows (upstream Types: UserTypeIndividual)", async () => {
    await seedUser("alice");
    await seedUser("bob");
    await seedOrg("zorg"); // alphabetically last, would paginate in without the filter

    const res = await router()("/users/search");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    const body = await res.json<{ data: Array<{ login: string }> }>();
    expect(body.data.map((u) => u.login)).toEqual(["alice", "bob"]);
  });

  it("anonymous sees public users only — limited and private rows are hidden", async () => {
    await seedUser("alice");
    await seedUser("bob", { visibility: "limited" });
    await seedUser("carol", { visibility: "private" });

    const res = await router()("/users/search");

    expect(res.headers.get("X-Total-Count")).toBe("1");
    expect((await res.json<{ data: Array<{ login: string }> }>()).data.map((u) => u.login)).toEqual(["alice"]);
  });

  it("a signed-in doer adds limited rows and themself, never strangers' private rows", async () => {
    await seedUser("alice");
    const bob = await seedUser("bob", { visibility: "limited" });
    await seedUser("carol", { visibility: "private" }); // a private stranger
    await seedUser("dave", { visibility: "private" }); // another private stranger

    const res = await ladderRouter()("/users/search", { headers: doerHeaders(bob.id) });

    // bob sees alice (public) and bob (the self arm); the private strangers
    // stay hidden for a non-admin doer.
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect((await res.json<{ data: Array<{ login: string }> }>()).data.map((u) => u.login)).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("a private user appears in their own search results (the self arm)", async () => {
    await seedUser("alice");
    const dave = await seedUser("dave", { visibility: "private" });

    const res = await ladderRouter()("/users/search", { headers: doerHeaders(dave.id) });

    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect((await res.json<{ data: Array<{ login: string }> }>()).data.map((u) => u.login)).toEqual([
      "alice",
      "dave",
    ]);
  });

  it("a site admin sees every row regardless of visibility", async () => {
    await seedUser("alice");
    await seedUser("bob", { visibility: "limited" });
    await seedUser("carol", { visibility: "private" });
    const root = await seedUser("root", { isAdmin: true });

    const res = await ladderRouter()("/users/search", { headers: doerHeaders(root.id) });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("4");
  });

  it("a uid pinning an invisible user yields an empty page, not a leak (uid ANDed after the ceiling)", async () => {
    const carol = await seedUser("carol", { visibility: "private" });

    const res = await router()(`/users/search?uid=${carol.id}`);

    expect(res.headers.get("X-Total-Count")).toBe("0");
    expect((await res.json<{ data: unknown[] }>()).data).toEqual([]);
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

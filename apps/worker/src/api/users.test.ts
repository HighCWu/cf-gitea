/**
 * Tier-1 user-directory routes on real D1 (SPEC-0004 §2.4 rows: userGet /
 * userSearch). Seeds `users` rows through Drizzle, boots the API router with
 * the stub auth resolver, and asserts the User field set against the frozen
 * vendored contract, the email visibility rule (self/admin only), the
 * upstream anti-enumeration 404, the `IsUserVisibleToViewer` ladder
 * (services/user.ts), the directory search's Types filter + viewer ceiling,
 * and the runtime pagination headers.
 *
 * The mounted-chain suite at the bottom exercises the REAL worker composition
 * through `SELF` — src/index.ts's /api/v1 mount hunks (`resolveAuth` →
 * `sudo()` → the `rejectPublicOnly`/userAssignment-arm guards) — with D1
 * minted tokens: the sudo() route-level trio and the public-only route arms
 * (upstream api.go:111–146 / 249–257 / services/context/user.go:61–64).
 */

import { SELF, applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { follows, orgMembers, users } from "../db/schema";
import { STUB_USER } from "./auth";
import { createApiRouter } from "./router";
import { contractModelProperties } from "../compat/contract/frozen-contract";
import type { Viewer } from "./services/repository";
import { toApiUserWithCounts } from "./services/user";
import { followUser } from "./services/follows";
import { mintFor, resetAuthTables } from "../auth/testing/seeds";
import { mintSession, SESSION_COOKIE_NAME } from "../ui/session";

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

/**
 * The declared field set PLUS the one runtime-only key upstream marshals onto
 * every User payload without declaring it — `User.MarshalJSON`'s `username`
 * alias of `login` (modules/structs/user.go:67-73). Our zod schema declares
 * it for exactly this reason (models/user.ts); the frozen contract cannot
 * see it, so the exact-field-set assertions splice it in here.
 */
const USER_WIRE_FIELDS = [...SWAGGER_USER_FIELDS, "username"].sort();

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
    expect(Object.keys(body).sort()).toEqual(USER_WIRE_FIELDS);
  });

  it("fills D1-sourced fields, hides the email, and reports public visibility", async () => {
    const alice = await seedUser("Alice", { email: "alice@example.com", displayName: "Alice Doe" });

    const res = await router()("/users/Alice");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();

    expect(body).toMatchObject({
      id: alice.id,
      login: "Alice",
      username: "Alice", // the MarshalJSON compat key == login (user.go:67-73)
      login_name: "",
      full_name: "Alice Doe",
      // The noreply PLACEHOLDER (convert/user.go:86 — `%d+%s@%s` over
      // {ID}+{LowerName}@{NoReplyAddress}, models/user/user.go:241-243); the
      // real email only for self/admin (convert/user.go:101-104).
      email: `${alice.id}+alice@users.noreply.gitea.invalid`,
      avatar_url: "https://example.com/avatars/alice", // TODO(SPEC-0005): avatar storage
      html_url: "https://example.com/Alice",
      created: "2026-01-02T03:04:05.000Z",
      type: "User",
      visibility: "public", // the real users.visibility column (seeded default)
      restricted: false, // TODO(SPEC-0007): restricted is a visibility concept
      active: false, // authed-gated upstream — Go-zero for anonymous viewers
      is_admin: false,
      prohibit_login: false,
      last_login: "0001-01-01T00:00:00Z", // authed-gated (convert/user.go:118-124); this seeded row is never minted into — NULL = Go zero time
      followers_count: 0, // the sync route render — toApiUserWithCounts carries the per-viewer totals
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

// ---------------------------------------------------------------------------
// The serializer's follow counts (toApiUserWithCounts →
// resolveApiUserFollowCounts, services/repository.ts) — the SAME
// visibility-filtered FindAndCount the profile page renders
// (upstream profile.go:118-138 over GetUserFollowers/GetUserFollowing,
// models/user/user.go:357-402; upstream's API converter renders maintained
// num_followers/num_following columns that the D1 users row does not have,
// so the API renders the requester-visible totals instead —
// ApiUserFollowCounts' docstring). Service-level pins: the routes keep the
// query-flat sync render (the zero-defaults above); the wiring is the route
// owner's one-line swap, the toApiRepositoryFull precedent.
// ---------------------------------------------------------------------------

const VIEWER_ORIGIN = "https://example.com";
const anonViewer: Viewer = { origin: VIEWER_ORIGIN, requester: null };
const doerViewer = (id: number, login: string, isAdmin = false): Viewer => ({
  origin: VIEWER_ORIGIN,
  requester: { id, login, is_admin: isAdmin },
});

describe("GET /users/{username} — the last_login authed gate (P3-7)", () => {
  const LOGIN_AT = new Date("2026-03-04T05:06:07Z");

  /** Seed a user whose row carries a real last-login instant (the
   *  mintSession write — pinned in ui/session.test.ts; set directly here so
   *  the ROUTE render is isolated from the mint). */
  async function seedLogged(
    username: string,
    opts: SeedOptions = {},
  ): Promise<{ id: number; usernameLower: string }> {
    const user = await seedUser(username, opts);
    await db().update(users).set({ lastLoginAt: LOGIN_AT }).where(eq(users.id, user.id));
    return user;
  }

  it("the user themself sees the real last-login instant (convert/user.go:118's authed arm)", async () => {
    const alice = await seedLogged("Alice");

    const res = await ladderRouter()("/users/Alice", { headers: doerHeaders(alice.id) });
    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({
      login: "Alice",
      last_login: "2026-03-04T05:06:07.000Z",
    });
  });

  it("a site admin sees another user's instant", async () => {
    await seedLogged("Alice");
    const admin = await seedLogged("Root", { isAdmin: true });

    const res = await ladderRouter()("/users/Alice", { headers: doerHeaders(admin.id) });
    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({
      login: "Alice",
      last_login: "2026-03-04T05:06:07.000Z",
    });
  });

  it("a signed stranger and an anonymous caller get Go zero time even when the column is set", async () => {
    await seedLogged("Alice");
    const stranger = await seedLogged("Stranger");

    const strangerRes = await ladderRouter()("/users/Alice", { headers: doerHeaders(stranger.id) });
    expect(strangerRes.status).toBe(200);
    expect(await strangerRes.json<Record<string, unknown>>()).toMatchObject({
      login: "Alice",
      last_login: "0001-01-01T00:00:00Z",
    });

    const anonRes = await router()("/users/Alice");
    expect(anonRes.status).toBe(200);
    expect(await anonRes.json<Record<string, unknown>>()).toMatchObject({
      login: "Alice",
      last_login: "0001-01-01T00:00:00Z",
    });
  });
});

describe("the serializer's follow counts (toApiUserWithCounts — per-requester visibility)", () => {
  /** alice's followers: Bob (public), Lim (limited), Priv (private — and Priv
   *  FOLLOWS alice, the listing's followers-of-viewer arm). alice follows Bob
   *  and the org (following includes orgs — user.go:379-398). Carol is the
   *  unrelated stranger/admin. */
  async function seedCountGraph() {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const lim = await seedUser("Lim", { visibility: "limited" });
    const priv = await seedUser("Priv", { visibility: "private" });
    const carol = await seedUser("Carol");
    const admin = await seedUser("root", { isAdmin: true });
    const org = await seedOrg("acme");
    await addFollow(bob.id, alice.id); // Bob → alice
    await addFollow(lim.id, alice.id); // Lim → alice
    await addFollow(priv.id, alice.id); // Priv → alice (priv follows alice)
    await addFollow(alice.id, bob.id); // alice → Bob
    await addFollow(alice.id, org.id); // alice → acme (org among the followed)
    const rows = await db().select().from(users).where(eq(users.usernameLower, "alice")).all();
    const aliceRow = rows[0];
    if (aliceRow === undefined) throw new Error("alice row missing after seed");
    return { alice, bob, lim, priv, carol, admin, org, aliceRow };
  }

  it("anonymous counts public-type followers only (the listing ceiling)", async () => {
    const { aliceRow } = await seedCountGraph();

    const user = await toApiUserWithCounts(env.DB, anonViewer, aliceRow);

    expect(user.followers_count).toBe(1); // Bob; Lim + Priv fail the public-only ceiling
    expect(user.following_count).toBe(2); // Bob + the org (both public)
  });

  it("the self viewer counts everything visible to them — the private follower included", async () => {
    const { alice, aliceRow } = await seedCountGraph();

    const user = await toApiUserWithCounts(env.DB, doerViewer(alice.id, "Alice"), aliceRow);

    // Bob + Lim (non-private) + Priv (Priv follows alice — the
    // followers-of-viewer arm admits them to the self view).
    expect(user.followers_count).toBe(3);
    expect(user.following_count).toBe(2);
  });

  it("a signed-in stranger counts the non-private followers, not the unrelated private one", async () => {
    const { carol, aliceRow } = await seedCountGraph();

    const user = await toApiUserWithCounts(env.DB, doerViewer(carol.id, "Carol"), aliceRow);

    expect(user.followers_count).toBe(2); // Bob + Lim; Priv relates to Carol in no way
    expect(user.following_count).toBe(2);
  });

  it("a site admin counts every follower regardless of visibility", async () => {
    const { admin, aliceRow } = await seedCountGraph();

    const user = await toApiUserWithCounts(env.DB, doerViewer(admin.id, "root", true), aliceRow);

    expect(user.followers_count).toBe(3); // no filter (followVisibilityCond's admin arm)
    expect(user.following_count).toBe(2);
  });

  it("the gated fields still render on the async twin (self view keeps the authed arm)", async () => {
    const alice = await seedUser("Alone", { email: "alone@example.com" });
    const rows = await db().select().from(users).where(eq(users.usernameLower, "alone")).all();
    const row = rows[0];
    if (row === undefined) throw new Error("row missing after seed");

    const user = await toApiUserWithCounts(env.DB, doerViewer(alice.id, "Alone"), row);

    expect(user.email).toBe("alone@example.com"); // the authed arm still applies
    expect(user.followers_count).toBe(0); // no edges — honest zero, not a skip
    expect(user.last_login).toBe("0001-01-01T00:00:00Z"); // no users column yet (see apiUserFromRow)
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
    const quiet = await seedUser("quiet", { visibility: "limited", email: "quiet@example.com" });
    const viewer = await seedUser("viewer");

    const res = await ladderRouter()("/users/quiet", { headers: doerHeaders(viewer.id) });

    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({
      login: "quiet",
      visibility: "limited",
      // A signed stranger gets the noreply placeholder, not the primary email
      // (convert/user.go:101-104 — `signed && (!KeepEmailPrivate || authed)`;
      // with no keep_email_private column the placeholder arm stands, the
      // serializer's documented TODO(SPEC-0005) gap).
      email: `${quiet.id}+quiet@users.noreply.gitea.invalid`,
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
    expect(Object.keys(firstOf(body.data)).sort()).toEqual(USER_WIRE_FIELDS);
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

describe("mounted chain (SELF — src/index.ts's /api/v1 mounts): sudo trio", () => {
  beforeEach(async () => {
    // The mounted chain verifies REAL D1 tokens (unlike the stub-resolver
    // suites above); credential tables get the same reset the auth suites use.
    await resetAuthTables();
    seededById.clear();
  });

  it("admin + Sudo header impersonates — GET /user answers the TARGET's login", async () => {
    const admin = await seedUser("SudoAdmin", { isAdmin: true });
    await seedUser("Impersonated");
    const minted = await mintFor(admin.id, "sudo-admin", "all");

    const res = await SELF.fetch("https://example.com/api/v1/user", {
      headers: { Authorization: `token ${minted.plaintext}`, Sudo: "impersonated" },
    });

    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({ login: "Impersonated" });
  });

  it("non-admin with ?sudo → 403, upstream message verbatim", async () => {
    const peon = await seedUser("SudoPeon");
    const minted = await mintFor(peon.id, "peon-token", "all");

    const res = await SELF.fetch("https://example.com/api/v1/user?sudo=someone", {
      headers: { Authorization: `token ${minted.plaintext}` },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "Only administrators allowed to sudo.", url: ERROR_URL });
  });

  it("admin sudo onto an unknown target → 404 not found", async () => {
    const admin = await seedUser("SudoAdminGhost", { isAdmin: true });
    const minted = await mintFor(admin.id, "ghost-admin", "all");

    const res = await SELF.fetch("https://example.com/api/v1/user?sudo=ghost", {
      headers: { Authorization: `token ${minted.plaintext}` },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("a browser session cookie never authenticates the API — ?sudo= on cookie-only credentials → 403 (the UI/API seam, wave-matrix-15)", async () => {
    // The seam behind the sudo mount (32eaa73): the API resolves credentials
    // from the Authorization header ONLY (resolveAuth), so an admin's web
    // session cannot ride into /api/v1 — and ?sudo= therefore evaluates the
    // ANONYMOUS doer, refused before the route's own 401 gate.
    const admin = await seedUser("SudoSessionAdmin", { isAdmin: true });
    const cookieValue = await mintSession(env.DB, admin.id);

    const sudoed = await SELF.fetch("https://example.com/api/v1/user?sudo=someone", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` },
    });
    expect(sudoed.status).toBe(403); // anonymous doer — "Only administrators allowed to sudo."
    expect(await sudoed.json()).toEqual({ message: "Only administrators allowed to sudo.", url: ERROR_URL });

    // The no-sudo contrast: the same cookie-only request is plain anonymous
    // at the route gate (401), never the admin identity.
    const plain = await SELF.fetch("https://example.com/api/v1/user", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` },
    });
    expect(plain.status).toBe(401);
  });
});

describe("mounted chain (SELF): GET /user renders row truth (api review drift 1)", () => {
  beforeEach(async () => {
    await resetAuthTables();
    seededById.clear();
  });

  it("the auth-shape conversion renders the canonical row-derived fields, username == login", async () => {
    // The dedicated auth serializer used to hardcode avatar_url/html_url "",
    // visibility "public", type "User" and starred_repos_count 0; identityFrom
    // now delegates to the canonical converter with the request origin, so a
    // LIMITED user's self-view carries the row's own values.
    const doer = await seedUser("RowTruth", { email: "truth@example.com", visibility: "limited" });
    await db().update(users).set({ numStars: 3 }).where(eq(users.id, doer.id));
    const minted = await mintFor(doer.id, "row-truth", "all");

    const res = await SELF.fetch("https://example.com/api/v1/user", {
      headers: { Authorization: `token ${minted.plaintext}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({
      id: doer.id,
      login: "RowTruth",
      username: "RowTruth", // the MarshalJSON compat key == login (user.go:67-73)
      email: "truth@example.com", // self view renders the real email
      avatar_url: "https://example.com/avatars/rowtruth",
      html_url: "https://example.com/RowTruth",
      visibility: "limited", // the row's column, not the old hardcoded "public"
      type: "User",
      starred_repos_count: 3, // the row's maintained counter, not the old hardcoded 0
      is_admin: false,
      active: true,
    });
  });

  it("the self view renders the follower/following counts (the raw-column seam upstream renders here)", async () => {
    // Upstream's GET /user carries NumFollowers/NumFollowing (convert/
    // user.go:107-111); our seam renders the requester-visible live totals —
    // for the SELF viewer every follower counts, private included.
    const doer = await seedUser("CountSelf");
    const follower = await seedUser("CountFollower", { visibility: "private" });
    await followUser(env.DB, follower.id, doer.id);
    const minted = await mintFor(doer.id, "count-self", "all");

    const res = await SELF.fetch("https://example.com/api/v1/user", {
      headers: { Authorization: `token ${minted.plaintext}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({
      login: "CountSelf",
      followers_count: 1, // the self view sees the private follower
      following_count: 0,
    });
  });

  it("the self view renders the row's last_login_at (P3-7 — the rowToUser→authUserToApiUser carry)", async () => {
    // The doer's own User projection reads the last-login instant through the
    // auth identity conversion (authUserToApiUser over the AuthUser slice
    // rowToUser mapped WHERE THE ROW WAS IN HAND) — upstream's authed arm
    // (convert/user.go:118, `ToUser(ctx.Doer, ctx.Doer)` at userGetCurrent).
    const doer = await seedUser("LoginTruth");
    await db().update(users).set({ lastLoginAt: new Date("2026-03-04T05:06:07Z") }).where(eq(users.id, doer.id));
    const minted = await mintFor(doer.id, "login-truth", "all");

    const res = await SELF.fetch("https://example.com/api/v1/user", {
      headers: { Authorization: `token ${minted.plaintext}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({
      login: "LoginTruth",
      last_login: "2026-03-04T05:06:07.000Z",
    });
  });

  it("GET /user degrades to the sync render when the counts seam has no binding (9f883d0)", async () => {
    // api.test.ts's bare rig (app.request with NO env — c.env is undefined)
    // used to 500 on the counts block's c.env.DB read; 9f883d0 made the whole
    // seam best-effort. The dedicated pin asserts the FALLBACK CONTENT: the
    // identity answer is the middleware's sync render (the stub identity,
    // which carries the zero counts), never a 500 for the counts.
    const bare = createApiRouter(); // stub resolver, no env injected

    const res = await bare.request("https://example.com/user", {
      headers: { Authorization: `token ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      id: STUB_USER.id,
      login: STUB_LOGIN,
      username: STUB_LOGIN,
      followers_count: 0, // the sync render's zero — the async twin never ran
      following_count: 0,
    });
  });
});

describe("mounted chain (SELF): public-only route arms", () => {
  beforeEach(async () => {
    await resetAuthTables();
    seededById.clear();
  });

  /** A doer holding a `public-only` token (`rejectPublicOnly`, api.go:249–257). */
  async function seedPublicOnlyDoer(username: string): Promise<string> {
    const doer = await seedUser(username);
    const minted = await mintFor(doer.id, `${username.toLowerCase()}-po`, "public-only,read:user");
    return minted.plaintext;
  }

  it("public-only token vs a limited user → masked redirect 404 (userAssignment arm)", async () => {
    await seedUser("quiet", { visibility: "limited" });
    const token = await seedPublicOnlyDoer("PoVisitor");

    const res = await SELF.fetch("https://example.com/api/v1/users/quiet", {
      headers: { Authorization: `token ${token}` },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      message: "user redirect does not exist [name: quiet]",
      url: ERROR_URL,
    });
  });

  it("public-only token vs a public user → 200", async () => {
    await seedUser("open");
    const token = await seedPublicOnlyDoer("PoVisitor");

    const res = await SELF.fetch("https://example.com/api/v1/users/open", {
      headers: { Authorization: `token ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({ login: "open", visibility: "public" });
  });

  it("admin group refusal per upstream's placement (api.go:1867)", async () => {
    const token = await seedPublicOnlyDoer("PoVisitor");

    const res = await SELF.fetch("https://example.com/api/v1/admin/users", {
      headers: { Authorization: `token ${token}` },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: "this endpoint is not available for public-only tokens",
      url: ERROR_URL,
    });
  });

  it("notifications refusal per upstream's placement (api.go:1051)", async () => {
    const token = await seedPublicOnlyDoer("PoVisitor");

    const res = await SELF.fetch("https://example.com/api/v1/notifications", {
      headers: { Authorization: `token ${token}` },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: "this endpoint is not available for public-only tokens",
      url: ERROR_URL,
    });
  });

  it("POST /user/repos refuses, the sibling GET stays public-only-visible (api.go:1181)", async () => {
    // GET /user/repos sits in upstream's nested group that requires `user`
    // AND `repository` (api.go:1181) — the tree-wide scope gate (auth-parity
    // H1, api/scope-gate.ts) enforces both, so the token carries
    // read:repository and the test's point stays the PUBLIC-ONLY flag: it
    // does not itself 403 the sibling GET.
    const doer = await seedUser("PoRepoOwner");
    const minted = await mintFor(doer.id, "porepoowner-po", "public-only,read:user,read:repository");
    const token = minted.plaintext;

    const post = await SELF.fetch("https://example.com/api/v1/user/repos", {
      method: "POST",
      headers: { Authorization: `token ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    });
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({
      message: "this endpoint is not available for public-only tokens",
      url: ERROR_URL,
    });

    const get = await SELF.fetch("https://example.com/api/v1/user/repos", {
      headers: { Authorization: `token ${token}` },
    });
    expect(get.status).toBe(200);
    // userCurrentListRepos answers a bare RepositoryList — the doer owns no
    // repos here; the point is the absence of the public-only 403.
    expect(await get.json<unknown[]>()).toEqual([]);
  });
});

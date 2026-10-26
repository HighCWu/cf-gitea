/**
 * The identity self-service routes on real D1 (SPEC-0004 appendix A, the
 * follow-self appendix row + the key listings):
 * `GET /user/followers` (userCurrentListFollowers), `PUT/DELETE
 * /user/following/{username}` (userCurrentPutFollow / userCurrentDeleteFollow)
 * and the REAL key listings `GET /users/{username}/keys` (userListKeys) +
 * `GET /users/{username}/gpg_keys` (userListGPGKeys) over the migration-0016
 * `public_keys`/`gpg_keys` tables. Same bootstrap as follows.test.ts: org
 * migrations (which apply the full generated migration set, 0016 included)
 * + the raw `follows` DDL (the table has no generated migration yet —
 * services/follows.ts header), edges/rows seeded and probed through raw D1.
 *
 * Covered upstream shapes: the doer-anchored follower listing (visibility
 * cond included); FollowUser's silent no-ops (self / already following) and
 * the UserAssignmentAPI 404; UnfollowUser's idempotent 204; the key
 * listings' upstream visibility rule — the keys are PUBLIC (any
 * authenticated caller lists any assigned user's keys, key.go
 * listPublicKeys / gpg_key.go ListGPGKeys), with the private fields
 * (owner/read_only/key_type) reserved to the owner or a site admin; the
 * empty (200 []) vs missing (404) distinction, orgs own no keys; the
 * fingerprint filter scoped to the target. All five routes reqToken upstream
 * (401 runtime-only for anonymous).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { gpgKeys, publicKeys, userBlocking, users } from "../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "./auth";
import contract from "../compat/contract/v1-swagger.generated.json";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import type { User } from "./models/user";
import { registerIdentityRoutes } from "./routes/identity";
import { FOLLOWS_DDL_STATEMENTS, followUser, isFollowing, unfollowUser } from "./services/follows";
import { OrgService } from "../services/orgs/orgs";
import { applyOrgsDdl, resetOrgTables } from "../services/orgs/testing";
import { GO_ZERO_TIME } from "./services/repository";

beforeAll(async () => {
  await applyOrgsDdl();
  for (const statement of FOLLOWS_DDL_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM follows").run();
  await env.DB.prepare("DELETE FROM gpg_keys").run();
  await env.DB.prepare("DELETE FROM public_keys").run();
  await resetOrgTables();
  seededUsers.clear();
});

const db = () => drizzle(env.DB);

const USER_FIELDS = Object.keys(contract.definitions.User.properties);

/** Seeded D1 users the test resolver can authenticate as (`token u<id>`). */
const seededUsers = new Map<number, { id: number; username: string; isAdmin: boolean }>();

interface SeededUser {
  id: number;
  username: string;
}

async function seedUser(username: string, options: { isAdmin?: boolean } = {}): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: options.isAdmin ?? false,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin: options.isAdmin ?? false });
  return { id: user.id, username: user.username };
}

const authHeaders = (userId: number): Record<string, string> => ({ Authorization: `token u${userId}` });

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
  registerIdentityRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

/** Raw edge probe (the table's Drizzle twin does not exist yet). */
function edgeCount(userId: number, followId: number): Promise<number> {
  return env.DB.prepare("SELECT count(*) AS n FROM follows WHERE user_id = ? AND follow_id = ?")
    .bind(userId, followId)
    .first<{ n: number }>()
    .then((row) => row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** bob follows alice; carol follows nobody; `acme` is alice's org. */
async function seedFollowGraph(): Promise<{
  alice: SeededUser;
  bob: SeededUser;
  carol: SeededUser;
  orgId: number;
}> {
  const alice = await seedUser("alice");
  const bob = await seedUser("bob");
  const carol = await seedUser("carol");
  const org = await new OrgService(env.DB).createOrg({
    name: "acme",
    ownerId: alice.id,
    now: new Date("2026-01-02T00:00:00Z"),
  });
  await followUser(env.DB, bob.id, alice.id); // bob → alice
  return { alice, bob, carol, orgId: org.id };
}

// ---------------------------------------------------------------------------
// Key fixtures — direct row inserts (the listings read, they do not parse)
// ---------------------------------------------------------------------------

const KEY_SEEDED_AT = new Date("2026-02-01T00:00:00Z");
const GPG_CREATED_AT = new Date("2026-01-15T00:00:00Z");

/** Raw `public_keys` row (migration 0016 columns; the write path's parsing
 *  is misc-t3's concern — the identity listings only read). */
async function seedPublicKey(
  ownerId: number,
  fields: { name: string; fingerprint: string; content: string; mode?: number },
): Promise<{ id: number }> {
  const rows = await db()
    .insert(publicKeys)
    .values({
      ownerId,
      name: fields.name,
      fingerprint: fields.fingerprint,
      content: fields.content,
      mode: fields.mode ?? 2,
      type: 1,
      loginSourceId: 0,
      verified: false,
      createdAt: KEY_SEEDED_AT,
      updatedAt: KEY_SEEDED_AT,
    })
    .returning({ id: publicKeys.id })
    .all();
  return rows[0]!;
}

/** Raw `gpg_keys` row — a primary when `primaryKeyId` is absent, a subkey
 *  when it names the parent's key id (upstream stores subkeys as rows with
 *  primary_key_id set). */
async function seedGpgKey(
  ownerId: number,
  fields: { keyId: string; primaryKeyId?: string; content?: string },
): Promise<{ id: number }> {
  const rows = await db()
    .insert(gpgKeys)
    .values({
      ownerId,
      keyId: fields.keyId,
      primaryKeyId: fields.primaryKeyId ?? "",
      content: fields.content ?? "dGVzdC1wdWJsaWMta2V5",
      verified: false,
      canSign: true,
      canEncryptComms: false,
      canEncryptStorage: false,
      canCertify: true,
      createdAt: GPG_CREATED_AT,
      expiresAt: null,
      addedAt: KEY_SEEDED_AT,
    })
    .returning({ id: gpgKeys.id })
    .all();
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// GET /user/followers (userCurrentListFollowers)
// ---------------------------------------------------------------------------

describe("GET /user/followers (userCurrentListFollowers)", () => {
  it("lists the authenticated user's followers in contract User shapes", async () => {
    const seed = await seedFollowGraph();
    const response = await router()("/user/followers", { headers: authHeaders(seed.alice.id) });
    expect(response.status).toBe(200);
    const body: Array<Record<string, unknown>> = await response.json();
    for (const entry of body) {
      expect(Object.keys(entry).every((key) => USER_FIELDS.includes(key))).toBe(true);
    }
    // alice's only follower is bob (orgs never appear among followers).
    expect(body.map((entry) => entry.login)).toEqual(["bob"]);
    expect(response.headers.get("X-Total-Count")).toBe("1");
  });

  it("paginates with the runtime headers", async () => {
    const seed = await seedFollowGraph();
    await followUser(env.DB, seed.carol.id, seed.alice.id);
    const response = await router()("/user/followers?limit=1", { headers: authHeaders(seed.alice.id) });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Total-Count")).toBe("2");
    const link = response.headers.get("Link") ?? "";
    expect(link).toContain('rel="next"');
    expect(link).toContain('rel="last"');
  });

  it("200s an empty list and 401s anonymous callers (runtime-only; upstream reqToken)", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    const empty = await send("/user/followers", { headers: authHeaders(seed.carol.id) });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
    expect((await send("/user/followers")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PUT /user/following/{username} (userCurrentPutFollow)
// ---------------------------------------------------------------------------

describe("PUT /user/following/{username} (userCurrentPutFollow)", () => {
  it("204s and creates the edge; a repeat follow stays a single edge", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    const first = await send(`/user/following/${seed.carol.username}`, { method: "PUT", headers: authHeaders(seed.alice.id) });
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    expect(await edgeCount(seed.alice.id, seed.carol.id)).toBe(1);
    const repeat = await send(`/user/following/${seed.carol.username}`, { method: "PUT", headers: authHeaders(seed.alice.id) });
    expect(repeat.status).toBe(204);
    expect(await edgeCount(seed.alice.id, seed.carol.id)).toBe(1);
  });

  it("204s a self-follow as the upstream silent no-op (no edge)", async () => {
    const seed = await seedFollowGraph();
    const response = await router()(`/user/following/${seed.alice.username}`, {
      method: "PUT",
      headers: authHeaders(seed.alice.id),
    });
    expect(response.status).toBe(204);
    expect(await edgeCount(seed.alice.id, seed.alice.id)).toBe(0);
  });

  it("follows an org target through the type-blind assignment (the listing includes it)", async () => {
    const seed = await seedFollowGraph();
    const response = await router()("/user/following/acme", { method: "PUT", headers: authHeaders(seed.bob.id) });
    expect(response.status).toBe(204);
    expect(await isFollowing(env.DB, seed.bob.id, seed.orgId)).toBe(true);
  });

  it("404s a missing target and 401s anonymous callers", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    const missing = await send("/user/following/ghost", { method: "PUT", headers: authHeaders(seed.alice.id) });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: "https://example.com/api/swagger" });
    expect((await send("/user/following/ghost", { method: "PUT" })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PUT /user/following/{username}: the FollowUser blocked arm (the
// blocks-enforcement sweep — models/user/follow.go:38-40 via follower.go:235)
// ---------------------------------------------------------------------------

describe("PUT /user/following/{username}: the FollowUser blocked arm", () => {
  /** A nested wipe — the shared beforeEach above owns the other tables. */
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM user_blocking").run();
  });

  const block = (blockerId: number, blockeeId: number) =>
    db().insert(userBlocking).values({ blockerId, blockeeId, note: "", createdAt: new Date() });

  it("403s \"user is blocked\" when the doer is blocked by the target (follow.go:38-39 via follower.go:235)", async () => {
    const seed = await seedFollowGraph();
    await block(seed.alice.id, seed.carol.id);
    const response = await router()(`/user/following/${seed.alice.username}`, {
      method: "PUT",
      headers: authHeaders(seed.carol.id),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "user is blocked", url: "https://example.com/api/swagger" });
    expect(await edgeCount(seed.carol.id, seed.alice.id)).toBe(0);
  });

  it("403s in the reverse direction too — the target blocked by the doer (follow.go:39-40)", async () => {
    const seed = await seedFollowGraph();
    await block(seed.carol.id, seed.alice.id);
    const response = await router()(`/user/following/${seed.carol.username}`, {
      method: "PUT",
      headers: authHeaders(seed.alice.id),
    });
    expect(response.status).toBe(403);
    expect(await edgeCount(seed.alice.id, seed.carol.id)).toBe(0);
  });

  it("self and repeat follows stay silent 204s even with a blocking row (follow.go:33-35 precedes the probe)", async () => {
    const seed = await seedFollowGraph(); // bob already follows alice
    await block(seed.alice.id, seed.bob.id);
    const send = router();
    const repeat = await send(`/user/following/${seed.alice.username}`, {
      method: "PUT",
      headers: authHeaders(seed.bob.id),
    });
    expect(repeat.status).toBe(204);
    const self = await send(`/user/following/${seed.bob.username}`, {
      method: "PUT",
      headers: authHeaders(seed.bob.id),
    });
    expect(self.status).toBe(204);
    expect(await edgeCount(seed.bob.id, seed.alice.id)).toBe(1);
  });

  it("a site-admin doer bypasses the block (IsUserBlockedBy's blockee.IsAdmin short-circuit)", async () => {
    const seed = await seedFollowGraph();
    const admin = await seedUser("root", { isAdmin: true });
    await block(seed.alice.id, admin.id);
    const response = await router()(`/user/following/${seed.alice.username}`, {
      method: "PUT",
      headers: authHeaders(admin.id),
    });
    expect(response.status).toBe(204);
    expect(await edgeCount(admin.id, seed.alice.id)).toBe(1);
  });

  it("204s once no blocking row relates the pair (the arm lifts with the block)", async () => {
    const seed = await seedFollowGraph();
    await block(seed.alice.id, seed.carol.id);
    await env.DB.prepare("DELETE FROM user_blocking").run();
    const response = await router()(`/user/following/${seed.alice.username}`, {
      method: "PUT",
      headers: authHeaders(seed.carol.id),
    });
    expect(response.status).toBe(204);
    expect(await edgeCount(seed.carol.id, seed.alice.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DELETE /user/following/{username} (userCurrentDeleteFollow)
// ---------------------------------------------------------------------------

describe("DELETE /user/following/{username} (userCurrentDeleteFollow)", () => {
  it("204s and removes an existing edge; a not-followed target stays 204", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    await followUser(env.DB, seed.alice.id, seed.bob.id);
    const removed = await send(`/user/following/${seed.bob.username}`, { method: "DELETE", headers: authHeaders(seed.alice.id) });
    expect(removed.status).toBe(204);
    expect(await edgeCount(seed.alice.id, seed.bob.id)).toBe(0);
    const notFollowed = await send(`/user/following/${seed.carol.username}`, {
      method: "DELETE",
      headers: authHeaders(seed.alice.id),
    });
    expect(notFollowed.status).toBe(204);
  });

  it("204s a self-unfollow as the upstream silent no-op", async () => {
    const seed = await seedFollowGraph();
    const response = await router()(`/user/following/${seed.alice.username}`, {
      method: "DELETE",
      headers: authHeaders(seed.alice.id),
    });
    expect(response.status).toBe(204);
  });

  it("404s a missing target and 401s anonymous callers", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    expect((await send("/user/following/ghost", { method: "DELETE", headers: authHeaders(seed.alice.id) })).status).toBe(404);
    expect((await send("/user/following/ghost", { method: "DELETE" })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /users/{username}/keys (userListKeys — real public_keys rows)
// ---------------------------------------------------------------------------

describe("GET /users/{username}/keys (userListKeys, real rows)", () => {
  const ALICE_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICQgLhusngED6SvOcMDWHg9wVjgOJ4QTN77gPol4OtTU ed25519-comment user@host";
  const ALICE_FP = "SHA256:nBIbxZfae58Hod5zlVgetQGtfn2OhEymkNryw9sEXR8";

  it("renders the target's keys in the ToPublicKey shape; the self view carries the private fields", async () => {
    const seed = await seedFollowGraph();
    const key = await seedPublicKey(seed.alice.id, { name: "laptop", fingerprint: ALICE_FP, content: ALICE_KEY });
    const response = await router()(`/users/${seed.alice.username}/keys`, { headers: authHeaders(seed.alice.id) });
    expect(response.status).toBe(200);
    const body: Array<Record<string, unknown>> = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: key.id,
      key: ALICE_KEY,
      url: `https://example.com/api/v1/user/keys/${key.id}`,
      title: "laptop",
      fingerprint: ALICE_FP,
      created_at: KEY_SEEDED_AT.toISOString(),
      last_used_at: KEY_SEEDED_AT.toISOString(),
    });
    const first = body[0]!;
    // appendPrivateInformation (key.go:26-47) — owner + read_only + key_type.
    expect(first.key_type).toBe("user");
    expect(first.read_only).toBe(false);
    expect((first.user as Record<string, unknown>).login).toBe("alice");
    // the pagination header reports the REAL total (was the stub's 0).
    expect(response.headers.get("X-Total-Count")).toBe("1");
  });

  it("another user lists the same keys WITHOUT the private fields (upstream: keys are public, key.go:96-99)", async () => {
    const seed = await seedFollowGraph();
    await seedPublicKey(seed.alice.id, { name: "laptop", fingerprint: ALICE_FP, content: ALICE_KEY });
    const response = await router()(`/users/${seed.alice.username}/keys`, { headers: authHeaders(seed.bob.id) });
    expect(response.status).toBe(200);
    const body: Array<Record<string, unknown>> = await response.json();
    expect(body.map((entry) => entry.fingerprint)).toEqual([ALICE_FP]);
    const first = body[0]!;
    expect(first.title).toBe("laptop");
    expect(first).not.toHaveProperty("user");
    expect(first).not.toHaveProperty("read_only");
    expect(first).not.toHaveProperty("key_type");
  });

  it("a site admin gets the private fields on another user's keys", async () => {
    const seed = await seedFollowGraph();
    await seedPublicKey(seed.alice.id, { name: "laptop", fingerprint: ALICE_FP, content: ALICE_KEY });
    const admin = await seedUser("root", { isAdmin: true });
    const response = await router()(`/users/${seed.alice.username}/keys`, { headers: authHeaders(admin.id) });
    expect(response.status).toBe(200);
    const body: Array<Record<string, unknown>> = await response.json();
    const first = body[0]!;
    expect(first.key_type).toBe("user");
    expect(first.read_only).toBe(false);
    expect((first.user as Record<string, unknown>).login).toBe("alice");
  });

  it("the fingerprint filter scopes to the target (key.go:59-70: the named-user arm stays restricted)", async () => {
    const seed = await seedFollowGraph();
    await seedPublicKey(seed.alice.id, { name: "laptop", fingerprint: ALICE_FP, content: ALICE_KEY });
    const BOB_FP = "SHA256:I5plbz5CJDzZiBSGXjZBVDpAS8c0FI3jzxrjbQSfaaU";
    await seedPublicKey(seed.bob.id, { name: "bob-key", fingerprint: BOB_FP, content: "ssh-rsa AAAAB3NzaC1yc2E bob" });
    const send = router();
    const viewer = authHeaders(seed.alice.id);
    // Own key by fingerprint.
    const own = await send(`/users/${seed.alice.username}/keys?fingerprint=${encodeURIComponent(ALICE_FP)}`, { headers: viewer });
    expect(await own.json()).toMatchObject([{ fingerprint: ALICE_FP }]);
    // Bob's fingerprint through alice's route filters to EMPTY — it must not
    // leak another owner's key ("Querying not just listing" is /user/keys'
    // unrestricted arm; the named-user route keeps OwnerID = target).
    const foreign = await send(`/users/${seed.alice.username}/keys?fingerprint=${encodeURIComponent(BOB_FP)}`, { headers: viewer });
    expect(await foreign.json()).toEqual([]);
  });

  it("distinguishes empty (200 []) from missing (404); orgs own no keys → []", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    const viewer = authHeaders(seed.carol.id);
    const empty = await send(`/users/${seed.alice.username}/keys`, { headers: viewer });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
    const org = await send("/users/acme/keys", { headers: viewer });
    expect(org.status).toBe(200);
    expect(await org.json()).toEqual([]);
    for (const viewerId of [seed.alice.id]) {
      expect((await send("/users/ghost/keys", { headers: authHeaders(viewerId) })).status).toBe(404);
    }
    expect((await send("/users/ghost/keys")).status).toBe(401); // runtime-only reqToken 401
  });
});

// ---------------------------------------------------------------------------
// GET /users/{username}/gpg_keys (userListGPGKeys — real gpg_keys rows)
// ---------------------------------------------------------------------------

describe("GET /users/{username}/gpg_keys (userListGPGKeys, real rows)", () => {
  const PRIMARY_ID = "4ECAE2C6059CEC8C";
  const SUBKEY_ID = "0123456789ABCDEF";

  it("lists primary keys with subkeys attached in the ToGPGKey shape (subkey rows never render top-level)", async () => {
    const seed = await seedFollowGraph();
    const primary = await seedGpgKey(seed.alice.id, { keyId: PRIMARY_ID });
    const subkey = await seedGpgKey(seed.alice.id, { keyId: SUBKEY_ID, primaryKeyId: PRIMARY_ID });
    const response = await router()(`/users/${seed.alice.username}/gpg_keys`, { headers: authHeaders(seed.alice.id) });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Total-Count")).toBe("1");
    const body: Array<Record<string, unknown>> = await response.json();
    expect(body).toHaveLength(1); // the subkey row is folded into `subkeys`
    expect(body[0]).toMatchObject({
      id: primary.id,
      primary_key_id: "",
      key_id: PRIMARY_ID,
      emails: [],
      can_sign: true,
      can_encrypt_comms: false,
      can_encrypt_storage: false,
      can_certify: true,
      verified: false,
      created_at: GPG_CREATED_AT.toISOString(),
      expires_at: GO_ZERO_TIME, // never expires renders Go's zero time
    });
    const first = body[0]!;
    expect(first.subkeys).toEqual([
      {
        id: subkey.id,
        primary_key_id: PRIMARY_ID,
        key_id: SUBKEY_ID,
        public_key: "dGVzdC1wdWJsaWMta2V5",
        emails: [],
        subkeys: [],
        can_sign: true,
        can_encrypt_comms: false,
        can_encrypt_storage: false,
        can_certify: true,
        verified: false,
        created_at: GPG_CREATED_AT.toISOString(),
        expires_at: GO_ZERO_TIME,
      },
    ]);
  });

  it("another user's gpg keys are listable (upstream ListGPGKeys has no viewer filter)", async () => {
    const seed = await seedFollowGraph();
    await seedGpgKey(seed.alice.id, { keyId: PRIMARY_ID });
    const response = await router()(`/users/${seed.alice.username}/gpg_keys`, { headers: authHeaders(seed.bob.id) });
    expect(response.status).toBe(200);
    const body: Array<Record<string, unknown>> = await response.json();
    expect(body.map((entry) => entry.key_id)).toEqual([PRIMARY_ID]);
  });

  it("distinguishes empty (200 []) from missing (404)", async () => {
    const seed = await seedFollowGraph();
    const send = router();
    const viewer = authHeaders(seed.carol.id);
    const empty = await send(`/users/${seed.alice.username}/gpg_keys`, { headers: viewer });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
    expect((await send("/users/ghost/gpg_keys", { headers: viewer })).status).toBe(404);
    expect((await send("/users/ghost/gpg_keys")).status).toBe(401);
  });
});

// Service-level no-op guards (the routes' 204 halves) — pinned here so the
// contract shapes cannot regress into edge writes.
describe("follow service no-op guards", () => {
  it("followUser/unfollowUser leave no self edge and are idempotent", async () => {
    const seed = await seedFollowGraph();
    await followUser(env.DB, seed.alice.id, seed.alice.id);
    expect(await edgeCount(seed.alice.id, seed.alice.id)).toBe(0);
    await unfollowUser(env.DB, seed.alice.id, seed.orgId); // never followed
    expect(await edgeCount(seed.alice.id, seed.orgId)).toBe(0);
  });

  it("unfollowUser removes an existing edge", async () => {
    const seed = await seedFollowGraph();
    await followUser(env.DB, seed.alice.id, seed.bob.id);
    await unfollowUser(env.DB, seed.alice.id, seed.bob.id);
    expect(await isFollowing(env.DB, seed.alice.id, seed.bob.id)).toBe(false);
  });
});

/**
 * The OAuth2 application CRUD family (routes/oauth2-apps.ts — the long-tail
 * inventory batch `wave-api-oauth2-apps`) on real D1 (migration 0026's
 * `oauth2_application`): all 5 contract ops over the standalone-mount
 * convention (the routes ARE registered in router.ts by the orchestrator
 * after this batch).
 *
 * Per-arm verification: create {201,400} (+ the runtime-only binder 422s),
 * list {200}, get {200,404}, patch {200,400,404} (+ the runtime-only 500 the
 * UID mismatch's plain error produces — upstream maps it to APIErrorInternal,
 * NOT 404), delete {204,404}; 401 on every op (reqToken). The declared ⊆
 * contract check is the throwaway mount script's job (check-openapi.mjs stays
 * the gate); the runtime-only codes are asserted as behavior here.
 *
 * The secret flow is pinned end-to-end: the create/patch bodies carry a
 * `gto_`-prefixed plaintext (52 base32-lower chars after the prefix) that is
 * rendered EXACTLY ONCE — list and get blank it, a foreign user's app is an
 * indistinguishable 404 on get/delete, patch ROTATES the secret (the old
 * plaintext stops verifying against the stored hash), and the at-rest column
 * holds only the PBKDF2 hash (services/oauth2-apps.ts module header for the
 * bcrypt divergence).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { auditEvents, oauth2Applications, users } from "../../db/schema";
import type { AuthInfo } from "../../auth/auth-context";
import { ScopeSet } from "../../auth/scopes";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerOAuth2AppRoutes } from "./oauth2-apps";
import { verifyClientSecret } from "../services/oauth2-apps";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["audit_event", "oauth2_application", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  seededUsers.clear();
});

const db = () => drizzle(env.DB);

// ---------------------------------------------------------------------------
// Auth rig — the `u<id>` token scheme (secrets-variables.test.ts's pattern):
// tokens bind to seeded D1 users, so the ownership checks read what the seeds
// wrote. Ids are NEVER hardcoded — every test reads the seeded ids back.
// ---------------------------------------------------------------------------

interface SeededUser {
  id: number;
  username: string;
}

const seededUsers = new Map<number, SeededUser>();

async function seedUser(username: string): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username });
  return { id: user.id, username: user.username };
}

/** API `User` projection the resolver returns (the auth middleware's shape).
 *  `username` rides — the canonical converter (apiUserFromRow) renders the
 *  upstream MarshalJSON alias on EVERY User payload, so a resolver-shaped
 *  User carries it (the audit arms read it). */
function apiUser(user: SeededUser): User {
  return {
    id: user.id,
    login: user.username,
    username: user.username,
    email: `${user.username.toLowerCase()}@example.com`,
    full_name: "",
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

const authHeaders = (userId: number): Record<string, string> => ({
  Authorization: `token u${userId}`,
  "Content-Type": "application/json",
});

/** Local mount of exactly the orchestrator one-liner's seam. The registry
 *  paths are relative to the /api/v1 mount, so fetched paths strip the
 *  prefix (the secrets-variables.test.ts convention). */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerOAuth2AppRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const get = (path: string, userId?: number): Promise<Response> =>
  router()(path, { headers: userId === undefined ? {} : authHeaders(userId) });

const post = (path: string, body: unknown, userId?: number): Promise<Response> =>
  router()(path, {
    method: "POST",
    headers: userId === undefined ? { "Content-Type": "application/json" } : authHeaders(userId),
    body: JSON.stringify(body),
  });

const patch = (path: string, body: unknown, userId: number): Promise<Response> =>
  router()(path, { method: "PATCH", headers: authHeaders(userId), body: JSON.stringify(body) });

const del = (path: string, userId?: number): Promise<Response> =>
  router()(path, { method: "DELETE", headers: userId === undefined ? {} : authHeaders(userId) });

async function jsonBody<T extends object = Record<string, unknown>>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

const messageOf = async (res: Response): Promise<string> => (await jsonBody<{ message: string }>(res)).message;

// ---------------------------------------------------------------------------
// Seeds + shapes.
// ---------------------------------------------------------------------------

let userSeq = 9100;

async function seedWorld(): Promise<{ alice: SeededUser; bob: SeededUser }> {
  const alice = await seedUser(`alice${userSeq}`);
  const bob = await seedUser(`bob${userSeq}`);
  userSeq += 1;
  return { alice, bob };
}

interface OAuth2AppWire {
  id: number;
  name: string;
  client_id: string;
  client_secret: string;
  confidential_client: boolean;
  skip_secondary_authorization: boolean;
  redirect_uris: string[];
  created: string;
}

/** The canonical create body. */
const createBody = {
  name: "my app",
  redirect_uris: ["https://example.com/callback", "http://127.0.0.1:7869/callback"],
  confidential_client: true,
  skip_secondary_authorization: false,
};

/** Create through the API and return the 201 wire body. */
async function createApp(userId: number, overrides: Partial<typeof createBody> = {}): Promise<OAuth2AppWire> {
  const res = await post("/api/v1/user/applications/oauth2", { ...createBody, ...overrides }, userId);
  expect(res.status).toBe(201);
  return jsonBody<OAuth2AppWire>(res);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** "gto_" + 52 lowercased base32 chars (32 random bytes, no padding). */
const SECRET_RE = /^gto_[a-z234567]{52}$/;

// ---------------------------------------------------------------------------
// POST /user/applications/oauth2 (userCreateOAuth2Application) — {201,400}.
// ---------------------------------------------------------------------------

describe("POST /user/applications/oauth2 (userCreateOAuth2Application)", () => {
  it("creates an app and renders the plaintext secret exactly once (201)", async () => {
    const { alice } = await seedWorld();
    const body = await createApp(alice.id);

    expect(body.name).toBe("my app");
    expect(body.client_id).toMatch(UUID_RE);
    expect(body.client_secret).toMatch(SECRET_RE);
    expect(body.confidential_client).toBe(true);
    expect(body.skip_secondary_authorization).toBe(false);
    expect(body.redirect_uris).toEqual(["https://example.com/callback", "http://127.0.0.1:7869/callback"]);
    expect(new Date(body.created).toISOString()).toBe(body.created);

    // At rest: the HASH, never the plaintext — and the hash verifies.
    const rows = await db().select().from(oauth2Applications).where(eq(oauth2Applications.uid, alice.id)).all();
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row!.clientId).toBe(body.client_id);
    expect(row!.clientSecret).not.toContain(body.client_secret);
    expect(row!.clientSecret.startsWith("pbkdf2-sha256$")).toBe(true);
    expect(await verifyClientSecret(row!.clientSecret, body.client_secret)).toBe(true);
    expect(await verifyClientSecret(row!.clientSecret, "gto_wrong")).toBe(false);
  });

  it("defaults confidential_client to false (the Go zero value) and accepts an empty URI list", async () => {
    const { alice } = await seedWorld();
    const body = await createApp(alice.id, { confidential_client: undefined, redirect_uris: [] });
    expect(body.confidential_client).toBe(false);
    expect(body.redirect_uris).toEqual([]);
  });

  it("400s an invalid redirect URI with the first offender inline (both arms)", async () => {
    const { alice } = await seedWorld();
    // No scheme colon at all.
    const noScheme = await post("/api/v1/user/applications/oauth2", { ...createBody, redirect_uris: ["https://ok.example/cb", "invalid"] }, alice.id);
    expect(noScheme.status).toBe(400);
    expect(await messageOf(noScheme)).toBe("invalid redirect URI: invalid");
    // Scheme but not http/https (upstream CustomSchemes defaults to empty).
    const ftp = await post("/api/v1/user/applications/oauth2", { ...createBody, redirect_uris: ["ftp://foo"] }, alice.id);
    expect(ftp.status).toBe(400);
    expect(await messageOf(ftp)).toBe("invalid redirect URI: ftp://foo");
  });

  it("422s the Go binder's Required fields with the exact texts", async () => {
    const { alice } = await seedWorld();
    const noName = await post("/api/v1/user/applications/oauth2", { redirect_uris: ["https://example.com/cb"] }, alice.id);
    expect(noName.status).toBe(422);
    expect(await messageOf(noName)).toBe("Name: Required");
    const noUris = await post("/api/v1/user/applications/oauth2", { name: "x" }, alice.id);
    expect(noUris.status).toBe(422);
    expect(await messageOf(noUris)).toBe("RedirectURIs: Required");
    const nullUris = await post("/api/v1/user/applications/oauth2", { name: "x", redirect_uris: null }, alice.id);
    expect(nullUris.status).toBe(422);
    expect(await messageOf(nullUris)).toBe("RedirectURIs: Required");
    // A type violation is Go's unmarshal-error class — the hook's 422.
    const badType = await post("/api/v1/user/applications/oauth2", { name: 5, redirect_uris: [] }, alice.id);
    expect(badType.status).toBe(422);
    expect(await messageOf(badType)).toBe("invalid request body");
  });

  it("401s an anonymous caller", async () => {
    const res = await post("/api/v1/user/applications/oauth2", createBody);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /user/applications/oauth2 (userGetOauth2Application) — {200}.
// ---------------------------------------------------------------------------

describe("GET /user/applications/oauth2 (userGetOauth2Application)", () => {
  it("lists the doer's apps, newest first, with the secret hidden and pagination headers", async () => {
    const { alice, bob } = await seedWorld();
    const first = await createApp(alice.id);
    const second = await createApp(alice.id);
    await createApp(bob.id); // another owner's row must not leak

    const res = await get("/api/v1/user/applications/oauth2", alice.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    const list = await jsonBody<OAuth2AppWire[]>(res);
    expect(list.map((app) => app.id)).toEqual([second.id, first.id]); // id DESC
    for (const app of list) {
      expect(app.client_secret).toBe(""); // "Hide secret on application list"
      expect(app.client_id).toMatch(UUID_RE);
    }
  });

  it("paginates with page/limit like upstream's silent clamping", async () => {
    const { alice } = await seedWorld();
    await createApp(alice.id);
    await createApp(alice.id);
    await createApp(alice.id);

    const res = await get("/api/v1/user/applications/oauth2?page=2&limit=2", alice.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("3");
    const list = await jsonBody<OAuth2AppWire[]>(res);
    expect(list).toHaveLength(1);
  });

  it("401s an anonymous caller", async () => {
    const res = await get("/api/v1/user/applications/oauth2");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /user/applications/oauth2/{id} (userGetOAuth2Application) — {200,404}.
// ---------------------------------------------------------------------------

describe("GET /user/applications/oauth2/{id} (userGetOAuth2Application)", () => {
  it("returns the app with the secret blanked (200)", async () => {
    const { alice } = await seedWorld();
    const created = await createApp(alice.id);

    const res = await get(`/api/v1/user/applications/oauth2/${created.id}`, alice.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<OAuth2AppWire>(res);
    expect(body).toEqual({ ...created, client_secret: "" });
  });

  it("404s a missing id, a garbage id, and a foreign user's app alike", async () => {
    const { alice, bob } = await seedWorld();
    const created = await createApp(alice.id);

    const missing = await get("/api/v1/user/applications/oauth2/99999", alice.id);
    expect(missing.status).toBe(404);
    expect(await messageOf(missing)).toBe("not found");
    const garbage = await get("/api/v1/user/applications/oauth2/not-a-number", alice.id);
    expect(garbage.status).toBe(404); // PathParamInt64 → 0 → miss
    const foreign = await get(`/api/v1/user/applications/oauth2/${created.id}`, bob.id);
    expect(foreign.status).toBe(404); // the UID check hides existence
    expect(await messageOf(foreign)).toBe("not found");
  });

  it("401s an anonymous caller", async () => {
    const res = await get("/api/v1/user/applications/oauth2/1");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PATCH /user/applications/oauth2/{id} (userUpdateOAuth2Application) —
// {200,400,404}; every patch rotates the client secret.
// ---------------------------------------------------------------------------

describe("PATCH /user/applications/oauth2/{id} (userUpdateOAuth2Application)", () => {
  it("updates fields, rotates the secret, and invalidates the old plaintext (200)", async () => {
    const { alice } = await seedWorld();
    const created = await createApp(alice.id);

    const res = await patch(
      `/api/v1/user/applications/oauth2/${created.id}`,
      { name: "renamed", redirect_uris: ["https://new.example/cb"], confidential_client: false, skip_secondary_authorization: true },
      alice.id,
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<OAuth2AppWire>(res);
    expect(body.name).toBe("renamed");
    expect(body.redirect_uris).toEqual(["https://new.example/cb"]);
    expect(body.confidential_client).toBe(false);
    expect(body.skip_secondary_authorization).toBe(true);
    expect(body.client_id).toBe(created.client_id); // the client id never rotates
    expect(body.client_secret).toMatch(SECRET_RE);
    expect(body.client_secret).not.toBe(created.client_secret);

    // The old plaintext stopped verifying; the new one verifies.
    const rows = await db().select().from(oauth2Applications).all();
    const row = rows.find((r) => r.id === body.id)!;
    expect(await verifyClientSecret(row.clientSecret, created.client_secret)).toBe(false);
    expect(await verifyClientSecret(row.clientSecret, body.client_secret)).toBe(true);
  });

  it("400s an invalid redirect URI", async () => {
    const { alice } = await seedWorld();
    const created = await createApp(alice.id);
    const res = await patch(
      `/api/v1/user/applications/oauth2/${created.id}`,
      { name: "x", redirect_uris: ["my-app:"] },
      alice.id,
    );
    expect(res.status).toBe(400);
    expect(await messageOf(res)).toBe("invalid redirect URI: my-app:");
  });

  it("422s the binder's Required fields", async () => {
    const { alice } = await seedWorld();
    const created = await createApp(alice.id);
    const res = await patch(`/api/v1/user/applications/oauth2/${created.id}`, {}, alice.id);
    expect(res.status).toBe(422);
    expect(await messageOf(res)).toBe("Name: Required");
  });

  it("404s a missing app and 500s (not 404s) a foreign user's app — upstream's plain-error arm", async () => {
    const { alice, bob } = await seedWorld();
    const created = await createApp(alice.id);

    const missing = await patch("/api/v1/user/applications/oauth2/99999", { ...createBody }, alice.id);
    expect(missing.status).toBe(404);
    expect(await messageOf(missing)).toBe("not found");

    // oauth2.go:328's plain "UID mismatch" error → APIErrorInternal → the
    // repo-wide handler's 500 body (errors.ts) — deliberately NOT a 404.
    const foreign = await patch(`/api/v1/user/applications/oauth2/${created.id}`, { ...createBody }, bob.id);
    expect(foreign.status).toBe(500);
    expect(await messageOf(foreign)).toBe("internal server error");
  });

  it("401s an anonymous caller", async () => {
    const res = await patch("/api/v1/user/applications/oauth2/1", createBody, 1);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DELETE /user/applications/oauth2/{id} (userDeleteOAuth2Application) —
// {204,404}.
// ---------------------------------------------------------------------------

describe("DELETE /user/applications/oauth2/{id} (userDeleteOAuth2Application)", () => {
  it("deletes the doer's app (204) and 404s the repeat", async () => {
    const { alice } = await seedWorld();
    const created = await createApp(alice.id);

    const res = await del(`/api/v1/user/applications/oauth2/${created.id}`, alice.id);
    expect(res.status).toBe(204);
    const rows = await db().select().from(oauth2Applications).all();
    expect(rows).toHaveLength(0);

    const repeat = await del(`/api/v1/user/applications/oauth2/${created.id}`, alice.id);
    expect(repeat.status).toBe(404);
  });

  it("404s a missing id and a foreign user's app (which survives)", async () => {
    const { alice, bob } = await seedWorld();
    const created = await createApp(alice.id);

    const missing = await del("/api/v1/user/applications/oauth2/99999", alice.id);
    expect(missing.status).toBe(404);

    // The (id, uid) delete's 0-rows arm: bob's delete hits nothing.
    const foreign = await del(`/api/v1/user/applications/oauth2/${created.id}`, bob.id);
    expect(foreign.status).toBe(404);
    const rows = await db().select().from(oauth2Applications).all();
    expect(rows).toHaveLength(1); // alice's app survived bob's delete
  });

  it("401s an anonymous caller", async () => {
    const res = await del("/api/v1/user/applications/oauth2/1");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The audit arms (v1.5.2 ledger F3 — user/app.go:278/:460/:360): each write
// emits its UserOAuth2Application* row through
// services/oauth2/audit-arms.ts (actor = scope = the doer, origin "api");
// the failure arms emit nothing.
// ---------------------------------------------------------------------------

describe("the audit arms (F3 — user/app.go:278/:460/:360)", () => {
  it("create emits UserOAuth2ApplicationAdd: actor = scope = the doer, the rendered template", async () => {
    const { alice } = await seedWorld();
    const created = await createApp(alice.id);

    const rows = await db().select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("user:oauth2application:add");
    expect(row.actorId).toBe(alice.id);
    expect(row.actorName).toBe(alice.username);
    expect(row.actorCredential).toBeNull(); // this rig's resolver carries no token row
    expect(row.scopeType).toBe("user");
    expect(row.scopeId).toBe(String(alice.id));
    expect(row.scopeName).toBe(alice.username);
    expect(row.origin).toBe("api");
    expect(row.message).toBe(`Added OAuth2 application ${created.name} for user ${alice.username}.`);
    expect(JSON.parse(row.metadata ?? "null")).toEqual({ oauth2_application: created.name });
  });

  it("the failure arms emit nothing (invalid URI, Required binder)", async () => {
    const { alice } = await seedWorld();
    const badUri = await post("/api/v1/user/applications/oauth2", { ...createBody, redirect_uris: ["not-a-url"] }, alice.id);
    expect(badUri.status).toBe(400);
    const missingName = await post("/api/v1/user/applications/oauth2", { redirect_uris: ["https://example.com/cb"] }, alice.id);
    expect(missingName.status).toBe(422);
    expect(await db().select().from(auditEvents).all()).toHaveLength(0);
  });

  it("patch emits UserOAuth2ApplicationUpdate; delete emits UserOAuth2ApplicationRemove", async () => {
    const { alice } = await seedWorld();
    const created = await createApp(alice.id);

    const patched = await patch(
      `/api/v1/user/applications/oauth2/${created.id}`,
      { name: "renamed", redirect_uris: ["https://example.com/cb"] },
      alice.id,
    );
    expect(patched.status).toBe(200);
    const removed = await del(`/api/v1/user/applications/oauth2/${created.id}`, alice.id);
    expect(removed.status).toBe(204);

    const rows = await db().select().from(auditEvents).all();
    // the create's own add row leads (createApp rode the audited handler)
    expect(rows.map((r) => r.action)).toEqual([
      "user:oauth2application:add",
      "user:oauth2application:update",
      "user:oauth2application:remove",
    ]);
    const [, update, remove] = rows;
    expect(update!.actorId).toBe(alice.id);
    expect(update!.scopeId).toBe(String(alice.id));
    expect(update!.message).toBe(`Updated OAuth2 application renamed of user ${alice.username}.`);
    expect(remove!.message).toBe(`Removed OAuth2 application renamed of user ${alice.username}.`);
  });

  it("a foreign user's 404 delete emits nothing", async () => {
    const { alice, bob } = await seedWorld();
    const created = await createApp(alice.id);
    expect(await db().select().from(auditEvents).all()).toHaveLength(1); // the create's add row
    const foreign = await del(`/api/v1/user/applications/oauth2/${created.id}`, bob.id);
    expect(foreign.status).toBe(404);
    expect(await db().select().from(auditEvents).all()).toHaveLength(1); // the 404 arm emitted nothing
  });
});

// ---------------------------------------------------------------------------
// The v1.5.5 R3 arms (M3 — the calling credential; L3 — the builtin lock).
// ---------------------------------------------------------------------------

describe("the R3-M3 credential arm (event.go:123 → GetDoerCredential)", () => {
  /** A GRANT-carrier auth snapshot — the auth middleware's oauth2CredentialAuth
   *  shape (name "oauth2-grant", prefix ""). The user slice rides too: the
   *  api auth seam derives authUser FROM the snapshot when `auth` is set. */
  const grantAuthSnapshot = (userId: number, username: string, grantId: number): AuthInfo => ({
    user: {
      id: userId,
      username,
      usernameLower: username.toLowerCase(),
      email: null,
      displayName: null,
      location: null,
      website: null,
      description: null,
      isAdmin: false,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    token: {
      id: grantId,
      userId,
      name: "oauth2-grant",
      prefix: "",
      scopes: "all",
      expiresAt: null,
      lastUsedAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    scope: ScopeSet.parseLenient("all"),
    isBasicAuth: false,
  });

  it("a grant-carrier request stamps oauth2-grant:<grantId>, not access-token:<id>", async () => {
    const { alice } = await seedWorld();
    const created = await createApp(alice.id);
    const app = new OpenAPIHono<ApiEnv>();
    app.onError(giteaErrorHandler);
    app.use("/user/applications/oauth2/*", async (c, next) => {
      c.set("auth", grantAuthSnapshot(alice.id, alice.username, 4242));
      await next();
    });
    registerOAuth2AppRoutes(app, createTokenAuthMiddleware(resolver));
    const res = await app.fetch(
      new Request(`https://example.com/user/applications/oauth2/${created.id}`, {
        method: "DELETE",
        headers: authHeaders(alice.id),
      }),
      env,
    );
    expect(res.status).toBe(204);
    const rows = await db().select().from(auditEvents).all();
    expect(rows).toHaveLength(2); // the createApp add + the remove
    expect(rows[1]!.actorCredential).toBe("oauth2-grant:4242");
  });
});

describe("the R3-L3 builtin lock (models/auth/oauth2.go:392-394)", () => {
  const seedBuiltin = async (uid: number): Promise<number> => {
    const [row] = await db()
      .insert(oauth2Applications)
      .values({
        uid,
        name: "git-credential-oauth",
        clientId: "a4792ccc-144e-407e-86c9-5e7d8d9c3269",
        clientSecret: "",
        confidentialClient: false,
        redirectUris: '["http://127.0.0.1","https://127.0.0.1"]',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning()
      .all();
    return row!.id;
  };

  it("the owner's delete → the locked 500 (upstream's plain error → APIErrorInternal)", async () => {
    const { alice } = await seedWorld();
    const id = await seedBuiltin(alice.id);
    const res = await del(`/api/v1/user/applications/oauth2/${id}`, alice.id);
    expect(res.status).toBe(500);
    expect(await messageOf(res)).toBe("internal server error");
    // the row survives
    expect(await db().select().from(oauth2Applications).all()).toHaveLength(1);
  });

  it("the lock fires BEFORE the uid scoping: a foreign caller locks out too (not the 404)", async () => {
    const { alice, bob } = await seedWorld();
    const id = await seedBuiltin(alice.id);
    const foreign = await del(`/api/v1/user/applications/oauth2/${id}`, bob.id);
    expect(foreign.status).toBe(500);
    expect(await db().select().from(oauth2Applications).all()).toHaveLength(1);
    // the failure arm emits nothing (no createApp rode this test)
    expect(await db().select().from(auditEvents).all()).toHaveLength(0);
  });

  it("a NON-builtin app keeps the foreign-404 arm", async () => {
    const { alice, bob } = await seedWorld();
    const created = await createApp(alice.id);
    const foreign = await del(`/api/v1/user/applications/oauth2/${created.id}`, bob.id);
    expect(foreign.status).toBe(404);
  });
});

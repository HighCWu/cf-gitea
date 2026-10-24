/**
 * Token-management router tests — SPEC-0002 §2.3 surface through
 * `/users/{username}/tokens`, replicating upstream guard order
 * (tokenRequiresScopes(user) → UserAssignmentAPI → reqSelfOrAdmin →
 * reqBasicOrRevProxyAuth → reqToken) and response shapes
 * (modules/structs/user_app.go:12–27).
 */

import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthEnv } from "./auth-context";
import { resolveAuth } from "./middleware";
import { tokenRouter } from "./router";
import { basicHeader, basicTokenHeader, mintFor, resetAuthTables, seedVerifiedUser } from "./testing/seeds";
import { TokenService } from "./token-service";
import { applyAuthD1Migrations } from "./testing/apply-d1-migrations";

beforeAll(applyAuthD1Migrations);
beforeEach(resetAuthTables);

const SWAGGER_URL = "https://example.com/api/swagger";
const svc = (): TokenService => new TokenService(env.DB);

const buildApp = (): Hono<AuthEnv> => {
  const app = new Hono<AuthEnv>();
  app.use("*", resolveAuth());
  app.route("/api/v1", tokenRouter);
  return app;
};

const app = buildApp();

/** app.request needs the bindings passed explicitly in tests. */
const call = async (path: string, init?: RequestInit): Promise<Response> =>
  await app.request(path, init, env);

interface Harness {
  userId: number;
  /** Basic-auth credential for Alice (token as username, empty password). */
  aliceBasic: string;
  plaintext: string;
  /** Last-8 of the listed token's prefix (its 8 hex chars). */
  mainTokenLastEight: string;
}

async function seedAlice(): Promise<Harness> {
  const user = await seedVerifiedUser({ username: "Alice" });
  // The credential ("all"-scoped) is distinct from the listed token so that
  // authenticating the list request does not touch the listed token's
  // last_used_at.
  const credential = await svc().mint({ userId: user.id, name: "alice-credential", scopes: "all" });
  const listed = await svc().mint({ userId: user.id, name: "alice-main", scopes: "all" });
  return {
    userId: user.id,
    aliceBasic: basicTokenHeader(credential.plaintext),
    plaintext: credential.plaintext,
    mainTokenLastEight: listed.prefix.slice(-8),
  };
}

async function mintBasicCredential(userId: number, name: string, scopes = "read:user"): Promise<string> {
  const minted = await svc().mint({ userId, name, scopes });
  return minted.plaintext;
}

describe("guard order (upstream api.go:1060–1071)", () => {
  it("unknown username → 404 not found (no existence leak)", async () => {
    const harness = await seedAlice();
    const response = await call("https://example.com/api/v1/users/ghost/tokens", {
      headers: { Authorization: harness.aliceBasic },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "not found", url: SWAGGER_URL });
  });

  it("anonymous list → 403 from reqSelfOrAdmin (not 401, matching upstream)", async () => {
    await seedVerifiedUser({ username: "AnonTarget" });
    const response = await call("https://example.com/api/v1/users/anontarget/tokens");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      message: "doer should be the site admin or be same as the contextUser",
      url: SWAGGER_URL,
    });
  });

  it("another user's tokens → 403 from reqSelfOrAdmin", async () => {
    const harness = await seedAlice();
    await seedVerifiedUser({ username: "OtherUser" });
    const response = await call("https://example.com/api/v1/users/otheruser/tokens", {
      headers: { Authorization: harness.aliceBasic },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      message: "doer should be the site admin or be same as the contextUser",
      url: SWAGGER_URL,
    });
  });

  it("token-authenticated (not Basic) request → 401 auth required", async () => {
    const harness = await seedAlice();
    const response = await call("https://example.com/api/v1/users/Alice/tokens", {
      headers: { Authorization: `token ${harness.plaintext}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: "auth required", url: SWAGGER_URL });
  });

  it("scope-less token (even via Basic) → 403 tokenRequiresScopes(user)", async () => {
    const user = await seedVerifiedUser({ username: "ScopelessCrud" });
    const plaintext = await mintBasicCredential(user.id, "scopeless", "no-token-scope");
    const response = await call("https://example.com/api/v1/users/scopelesscrud/tokens", {
      headers: { Authorization: basicTokenHeader(plaintext) },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      message:
        "token does not have at least one of required scope(s), required=[read:user], token scope=no-token-scope",
      url: SWAGGER_URL,
    });
  });
});

describe("list (GET /users/{username}/tokens)", () => {
  it("returns the upstream AccessToken JSON shape without a plaintext sha1", async () => {
    const harness = await seedAlice();
    const response = await call("https://example.com/api/v1/users/Alice/tokens", {
      headers: { Authorization: harness.aliceBasic },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Total-Count")).toBe("2");
    const body = await response.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(2);
    const token = body.find((entry) => entry.name === "alice-main");
    if (token === undefined) throw new Error("alice-main not listed");
    expect(Object.keys(token)).toEqual([
      "id",
      "name",
      "sha1",
      "token_last_eight",
      "scopes",
      "created_at",
      "last_used_at",
    ]);
    expect(token.name).toBe("alice-main");
    expect(token.sha1).toBe("");
    expect(token.scopes).toEqual(["all"]);
    expect(token.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(token.last_used_at).toBeNull();
    // token_last_eight = the 8 hex chars of the stored prefix, which appear
    // verbatim inside the minted plaintext.
    expect(token.token_last_eight).toBe(harness.mainTokenLastEight);
  });

  it("is paged (page/limit) with X-Total-Count", async () => {
    const user = await seedVerifiedUser({ username: "Pager" });
    const credential = await mintBasicCredential(user.id, "pager-credential", "read:user");
    for (let i = 0; i < 5; i++) {
      await svc().mint({ userId: user.id, name: `page-token-${i}`, scopes: "read:user" });
    }

    const page1 = await call("https://example.com/api/v1/users/pager/tokens?page=1&limit=2", {
      headers: { Authorization: basicTokenHeader(credential) },
    });
    expect(page1.status).toBe(200);
    expect(page1.headers.get("X-Total-Count")).toBe("6");
    expect((await page1.json<unknown[]>()).length).toBe(2);

    const page3 = await call("https://example.com/api/v1/users/pager/tokens?page=3&limit=2", {
      headers: { Authorization: basicTokenHeader(credential) },
    });
    expect((await page3.json<unknown[]>()).length).toBe(2);

    const page4 = await call("https://example.com/api/v1/users/pager/tokens?page=4&limit=2", {
      headers: { Authorization: basicTokenHeader(credential) },
    });
    expect((await page4.json<unknown[]>()).length).toBe(0);
  });
});

describe("create (POST /users/{username}/tokens)", () => {
  const post = async (authorization: string, body: unknown): Promise<Response> =>
    await call("https://example.com/api/v1/users/Alice/tokens", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("mints and returns the plaintext exactly once in the sha1 field", async () => {
    const harness = await seedAlice();
    const response = await post(harness.aliceBasic, { name: "new-token", scopes: ["read:user", "write:user"] });
    expect(response.status).toBe(201);
    const body = await response.json<Record<string, unknown>>();
    expect(body.name).toBe("new-token");
    expect(body.sha1).toMatch(/^cfg_[0-9a-f]{8}_[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{32}$/);
    expect(body.scopes).toEqual(["write:user"]);
    expect(body.token_last_eight).toBe((body.sha1 as string).slice(4, 12));

    // Plaintext verifies end-to-end and is stored only as a digest.
    const verified = await svc().verify(body.sha1 as string);
    expect(verified?.user.id).toBe(harness.userId);
    const rows = await env.DB.prepare("SELECT sha256_digest FROM personal_access_tokens WHERE name = 'new-token'").all<{
      sha256_digest: string;
    }>();
    expect(rows.results[0]?.sha256_digest).not.toContain(body.sha1);
  });

  it("duplicate name → 400 exact upstream message", async () => {
    const harness = await seedAlice();
    const response = await post(harness.aliceBasic, { name: "alice-main", scopes: ["read:user"] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "access token name has been used already",
      url: SWAGGER_URL,
    });
  });

  it("invalid scope → 400 with the wrapped upstream message", async () => {
    const harness = await seedAlice();
    const response = await post(harness.aliceBasic, { name: "bad-scope", scopes: ["banana"] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "invalid access token scope provided: invalid access token scope: banana",
      url: SWAGGER_URL,
    });
  });

  it("empty scope list → 400 access token must have a scope", async () => {
    const harness = await seedAlice();
    const response = await post(harness.aliceBasic, { name: "no-scopes", scopes: [] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "access token must have a scope",
      url: SWAGGER_URL,
    });
  });

  it("missing name → 422 binding error in the upstream format", async () => {
    const harness = await seedAlice();
    const response = await post(harness.aliceBasic, { scopes: ["read:user"] });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ message: "[Name]: Required", url: SWAGGER_URL });
  });

  it("token-authenticated parent cannot mint a broader scope → 403", async () => {
    const user = await seedVerifiedUser({ username: "NarrowParent" });
    // write:user passes the route's requireScope(user) for POST, but cannot
    // mint the broader write:admin (upstream CanCreateChildScope).
    const parent = await svc().mint({ userId: user.id, name: "parent", scopes: "write:user" });
    const response = await call("https://example.com/api/v1/users/narrowparent/tokens", {
      method: "POST",
      headers: {
        Authorization: basicHeader(parent.plaintext, "x-oauth-basic"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "escalated", scopes: ["write:admin"] }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      message: "cannot create an access token with a broader scope than the authenticating token",
      url: SWAGGER_URL,
    });
  });

  it("public-only parent carries the restriction onto the child", async () => {
    const user = await seedVerifiedUser({ username: "PublicParent" });
    const parent = await svc().mint({ userId: user.id, name: "parent", scopes: "write:user,public-only" });
    const response = await call("https://example.com/api/v1/users/publicparent/tokens", {
      method: "POST",
      headers: { Authorization: basicTokenHeader(parent.plaintext), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "child", scopes: ["read:user"] }),
    });
    expect(response.status).toBe(201);
    expect((await response.json<Record<string, unknown>>()).scopes).toEqual(["public-only", "read:user"]);
  });

  it("an admin may mint for another user (reqSelfOrAdmin)", async () => {
    await seedVerifiedUser({ username: "TargetUser" });
    const admin = await seedVerifiedUser({ username: "MintingAdmin", isAdmin: true });
    const credential = await mintBasicCredential(admin.id, "admin-minting", "all");
    const response = await call("https://example.com/api/v1/users/targetuser/tokens", {
      method: "POST",
      headers: { Authorization: basicTokenHeader(credential), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "on-behalf", scopes: ["read:user"] }),
    });
    expect(response.status).toBe(201);
    const owned = await svc().getUserByName("targetuser");
    if (owned === null) throw new Error("target user vanished");
    const list = await svc().list(owned.id, 1, 10);
    expect(list.tokens.map((token) => token.name)).toContain("on-behalf");
  });
});

describe("delete (DELETE /users/{username}/tokens/{id})", () => {
  it("revokes by numeric id and the token stops verifying", async () => {
    const harness = await seedAlice();
    const minted = await mintFor(harness.userId, "doomed");
    const response = await call(`https://example.com/api/v1/users/Alice/tokens/${minted.id}`, {
      method: "DELETE",
      headers: { Authorization: harness.aliceBasic },
    });
    expect(response.status).toBe(204);
    expect(await svc().verify(minted.plaintext)).toBeNull();
  });

  it("falls back to name lookup, 404 for unknown names", async () => {
    const user = await seedVerifiedUser({ username: "NameDeleter" });
    // DELETE derives the write level: the credential needs write:user. It is
    // a token other than the deleted ones (deleting revokes it).
    const credential = basicTokenHeader(await mintBasicCredential(user.id, "deleter-credential", "write:user"));
    await svc().mint({ userId: user.id, name: "twin", scopes: "read:user" });

    const byName = await call("https://example.com/api/v1/users/namedeleter/tokens/twin", {
      method: "DELETE",
      headers: { Authorization: credential },
    });
    expect(byName.status).toBe(204);

    const missing = await call("https://example.com/api/v1/users/namedeleter/tokens/never-existed", {
      method: "DELETE",
      headers: { Authorization: credential },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: SWAGGER_URL });
  });

  it("someone else's token id → 404 (scoped to the context user)", async () => {
    const harness = await seedAlice();
    const other = await seedVerifiedUser({ username: "TokenOwner" });
    const minted = await mintFor(other.id, "theirs");
    const response = await call(`https://example.com/api/v1/users/Alice/tokens/${minted.id}`, {
      method: "DELETE",
      headers: { Authorization: harness.aliceBasic },
    });
    expect(response.status).toBe(404);
    expect(await svc().verify(minted.plaintext)).not.toBeNull();
  });
});

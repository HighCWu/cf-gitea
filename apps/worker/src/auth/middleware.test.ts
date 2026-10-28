/**
 * Middleware behavior matrix — every `/api/v1` row of SPEC-0002 §2.6 as an
 * assertion, byte-comparing `message`/`url` against the literal upstream
 * strings (port of api.go behaviors at the vendored pin).
 */

import { Hono } from "hono";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../db/schema";
import type { AuthEnv } from "./auth-context";
import type { RateLimitHook } from "./failure-limiter";
import {
  PUBLIC_ONLY_FORBIDDEN_MESSAGE,
  requireScope,
  requireToken,
  requireSiteAdmin,
  requireContextUser,
  rejectPublicOnly,
  rejectPublicOnlyUserAssignment,
  resolveAuth,
  sudo,
  userRedirectDoesNotExist,
  type UserVisibility,
} from "./middleware";
import { basicHeader, basicTokenHeader, mintFor, resetAuthTables, seedVerifiedUser } from "./testing/seeds";
import { TokenService } from "./token-service";
import { applyAuthD1Migrations } from "./testing/apply-d1-migrations";

beforeAll(applyAuthD1Migrations);
beforeEach(resetAuthTables);

const SWAGGER_URL = "https://example.com/api/swagger";
const INVALID_CREDENTIALS = { message: "invalid username, password or token", url: SWAGGER_URL };

const buildApp = (): Hono<AuthEnv> => {
  const app = new Hono<AuthEnv>();
  app.use("*", resolveAuth());
  app.get("/_repo", requireScope("repository"), requireToken(), (c) => c.json({ ok: true }));
  app.post("/_repo", requireScope("repository"), requireToken(), (c) => c.json({ ok: true }));
  app.get("/_admin", requireToken(), requireSiteAdmin(), (c) => c.json({ ok: true }));
  app.get("/_whoami", sudo(), (c) => {
    const auth = c.get("auth");
    return c.json({ user: auth?.user?.username ?? null, scope: auth?.scope?.toString() ?? null });
  });
  // The ungated sibling GET mirrors upstream POST /user/repos (api.go:1181):
  // only the POST arm carries rejectPublicOnly; the GET route has no gate.
  app.get("/_gated", (c) => c.json({ ok: true }));
  app.post("/_gated", rejectPublicOnly("POST"), (c) => c.json({ ok: true }));
  app.get("/_always_gated", rejectPublicOnly(), (c) => c.json({ ok: true }));
  app.get("/_users/:username", rejectPublicOnlyUserAssignment(), (c) => c.json({ ok: true }));
  app.get("/_users/:username/tokens", requireContextUser(), (c) =>
    c.json({ user: c.get("contextUser").username }),
  );
  return app;
};

const app = buildApp();

/** app.request needs the bindings passed explicitly in tests. */
const call = async (path: string, init?: RequestInit): Promise<Response> =>
  await app.request(path, init, env);

const scopeErrorMessage = (required: string, tokenScope: string): string =>
  `token does not have at least one of required scope(s), required=[${required}], token scope=${tokenScope}`;

interface Seeded {
  userId: number;
  token: string;
}

async function seedWithToken(
  username: string,
  scopes: string,
  userOptions?: { isAdmin?: boolean; status?: "active" | "prohibited" },
): Promise<Seeded> {
  const user = await seedVerifiedUser({ username, ...userOptions });
  const minted = await mintFor(user.id, `${username.toLowerCase()}-token`, scopes);
  return { userId: user.id, token: minted.plaintext };
}

describe("401: authentication challenge vs bad credentials", () => {
  it("no credentials on a token-required route → 401 token is required", async () => {
    const response = await call("https://example.com/_repo");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: "token is required", url: SWAGGER_URL });
  });

  it("unknown token → 401 invalid username, password or token", async () => {
    const response = await call("https://example.com/_repo", {
      headers: { Authorization: "token cfg_00000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(INVALID_CREDENTIALS);
  });

  it("revoked token → same 401", async () => {
    const user = await seedVerifiedUser({ username: "Revoker" });
    const minted = await mintFor(user.id, "revoked-later");
    await new TokenService(env.DB).revoke(user.id, minted.id);

    const response = await call("https://example.com/_repo", {
      headers: { Authorization: `token ${minted.plaintext}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(INVALID_CREDENTIALS);
  });

  it("expired token → same 401 (no scope-leaking expiry message)", async () => {
    const user = await seedVerifiedUser({ username: "ExpiryUser" });
    const minted = await new TokenService(env.DB).mint({
      userId: user.id,
      name: "expired-at-past",
      scopes: "all",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const response = await call("https://example.com/_repo", {
      headers: { Authorization: `token ${minted.plaintext}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(INVALID_CREDENTIALS);
  });

  it("Basic with unknown credentials → 401", async () => {
    const response = await call("https://example.com/_repo", {
      headers: { Authorization: basicHeader("alice", "wrong-password") },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(INVALID_CREDENTIALS);
  });
});

describe("malformed Authorization parses as anonymous (→ 401 on token routes)", () => {
  const cases = ["Basic !!!", "token a b", "Bearer", "Unknown scheme value", `Basic ${btoa("no-colon")}`];

  for (const header of cases) {
    it(`"${header}" → 401 token is required`, async () => {
      const response = await call("https://example.com/_repo", { headers: { Authorization: header } });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ message: "token is required", url: SWAGGER_URL });
    });
  }
});

describe("403: scope enforcement via HTTP method", () => {
  it("valid token, missing scope (GET → read) → exact upstream 403", async () => {
    const seeded = await seedWithToken("ScopelessUser", "read:user");
    const response = await call("https://example.com/_repo", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      message: scopeErrorMessage("read:repository", "read:user"),
      url: SWAGGER_URL,
    });
  });

  it("write requirement derived from POST", async () => {
    const seeded = await seedWithToken("ReadOnlyRepo", "read:repository");
    const post = await call("https://example.com/_repo", {
      method: "POST",
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({
      message: scopeErrorMessage("write:repository", "read:repository"),
      url: SWAGGER_URL,
    });

    const get = await call("https://example.com/_repo", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(get.status).toBe(200);
  });

  it("no-token-scope authenticates but grants zero permissions", async () => {
    const seeded = await seedWithToken("ScopelessToken", "no-token-scope");
    const response = await call("https://example.com/_repo", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      message: scopeErrorMessage("read:repository", "no-token-scope"),
      url: SWAGGER_URL,
    });
  });

  it("all and write:repository pass their levels", async () => {
    const allToken = await seedWithToken("AllToken", "all");
    for (const method of ["GET", "POST"]) {
      const response = await call("https://example.com/_repo", {
        method,
        headers: { Authorization: `token ${allToken.token}` },
      });
      expect(response.status).toBe(200);
    }

    const writeToken = await seedWithToken("WriteRepoToken", "write:repository");
    const get = await call("https://example.com/_repo", {
      headers: { Authorization: `token ${writeToken.token}` },
    });
    expect(get.status).toBe(200);
  });
});

describe("403: admin routes and prohibited accounts", () => {
  it("non-admin on an admin route → user should be the site admin", async () => {
    const seeded = await seedWithToken("PlainUser", "all");
    const response = await call("https://example.com/_admin", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "user should be the site admin", url: SWAGGER_URL });
  });

  it("admin token passes the admin route", async () => {
    const seeded = await seedWithToken("AdminUser", "all", { isAdmin: true });
    const response = await call("https://example.com/_admin", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(response.status).toBe(200);
  });

  it("prohibited account → upstream prohibited message", async () => {
    const seeded = await seedWithToken("BannedUser", "all", { status: "prohibited" });
    const response = await call("https://example.com/_repo", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      message: "This account is prohibited from signing in, please contact your site administrator.",
      url: SWAGGER_URL,
    });
  });
});

describe("sudo (SPEC-0002 §4.2)", () => {
  it("non-admin using sudo → exact upstream 403", async () => {
    const seeded = await seedWithToken("SudoPeon", "all");
    const response = await call("https://example.com/_whoami?sudo=target", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "Only administrators allowed to sudo.", url: SWAGGER_URL });
  });

  it("admin sudo onto an unknown target → 404 not found", async () => {
    const admin = await seedWithToken("SudoAdmin", "all", { isAdmin: true });
    const response = await call("https://example.com/_whoami?sudo=ghost", {
      headers: { Authorization: `token ${admin.token}` },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "not found", url: SWAGGER_URL });
  });

  it("admin sudo swaps the doer but keeps the admin token's scope", async () => {
    await seedVerifiedUser({ username: "Impersonated", isAdmin: false });
    const admin = await seedWithToken("SudoScopeAdmin", "read:user", { isAdmin: true });

    const response = await call("https://example.com/_whoami?sudo=impersonated", {
      headers: { Authorization: `token ${admin.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: "Impersonated", scope: "read:user" });

    // The swapped doer cannot exceed the admin token's scopes.
    const repo = await call("https://example.com/_repo?sudo=impersonated", {
      headers: { Authorization: `token ${admin.token}` },
    });
    expect(repo.status).toBe(403);
    expect(await repo.json()).toEqual({
      message: scopeErrorMessage("read:repository", "read:user"),
      url: SWAGGER_URL,
    });
  });

  it("Sudo header form works and resolves targets case-insensitively", async () => {
    await seedVerifiedUser({ username: "HeaderTarget" });
    const admin = await seedWithToken("HeaderAdmin", "all", { isAdmin: true });
    const response = await call("https://example.com/_whoami", {
      headers: { Authorization: `token ${admin.token}`, Sudo: "headertarget" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: "HeaderTarget", scope: "all" });
  });

  it("admin without sudo keeps their own identity", async () => {
    const admin = await seedWithToken("SoloAdmin", "all", { isAdmin: true });
    const response = await call("https://example.com/_whoami", {
      headers: { Authorization: `token ${admin.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: "SoloAdmin", scope: "all" });
  });
});

describe("public-only enforcement (rejectPublicOnly + the userAssignment arm)", () => {
  const PUBLIC_ONLY_403 = { message: PUBLIC_ONLY_FORBIDDEN_MESSAGE, url: SWAGGER_URL };

  /** Flip a seeded user's `users.visibility` (seeds default to public). */
  async function setVisibility(usernameLower: string, visibility: UserVisibility): Promise<void> {
    await drizzle(env.DB).update(users).set({ visibility }).where(eq(users.usernameLower, usernameLower));
  }

  async function seedPublicOnly(username: string): Promise<Seeded> {
    return seedWithToken(username, "public-only,read:user");
  }

  it("public-only token on a gated route → exact upstream 403", async () => {
    const seeded = await seedPublicOnly("GatePeon");
    const response = await call("https://example.com/_always_gated", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(PUBLIC_ONLY_403);
  });

  it("anonymous and regular-scope tokens pass the gate", async () => {
    const anon = await call("https://example.com/_always_gated");
    expect(anon.status).toBe(200);

    const regular = await seedWithToken("RegularDoer", "read:user");
    const response = await call("https://example.com/_always_gated", {
      headers: { Authorization: `token ${regular.token}` },
    });
    expect(response.status).toBe(200);
  });

  it("method-scoped arm: the sibling GET passes, the POST arm refuses", async () => {
    const seeded = await seedPublicOnly("MethodPeon");
    const get = await call("https://example.com/_gated", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(get.status).toBe(200);

    const post = await call("https://example.com/_gated", {
      method: "POST",
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual(PUBLIC_ONLY_403);
  });

  it("requireContextUser: public-only token vs a limited target → masked redirect 404", async () => {
    await seedVerifiedUser({ username: "LimitedUser" });
    await setVisibility("limiteduser", "limited");
    const seeded = await seedPublicOnly("PoVisitor");

    const response = await call("https://example.com/_users/LimitedUser/tokens", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(response.status).toBe(404);
    // Raw path param in the message, upstream ErrUserRedirectNotExist verbatim.
    expect(await response.json()).toEqual({
      message: userRedirectDoesNotExist("LimitedUser"),
      url: SWAGGER_URL,
    });
  });

  it("requireContextUser: a public target resolves contextUser for a public-only token", async () => {
    await seedVerifiedUser({ username: "OpenUser" });
    const seeded = await seedPublicOnly("PoVisitor");

    const response = await call("https://example.com/_users/openuser/tokens", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: "OpenUser" });
  });

  it("requireContextUser: the arm covers the SELF visit of a limited public-only doer", async () => {
    const self = await seedWithToken("ShySelf", "public-only,read:user");
    await setVisibility("shyself", "limited");

    const response = await call("https://example.com/_users/ShySelf/tokens", {
      headers: { Authorization: `token ${self.token}` },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      message: userRedirectDoesNotExist("ShySelf"),
      url: SWAGGER_URL,
    });
  });

  it("requireContextUser: a non-public-only doer visits a limited target untouched", async () => {
    await seedVerifiedUser({ username: "LimitedUser" });
    await setVisibility("limiteduser", "limited");
    const seeded = await seedWithToken("NormalVisitor", "read:user");

    const response = await call("https://example.com/_users/limiteduser/tokens", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: "LimitedUser" });
  });

  it("mount-shaped arm: limited target → masked 404; unknown target falls through", async () => {
    await seedVerifiedUser({ username: "LimitedUser" });
    await setVisibility("limiteduser", "limited");
    const seeded = await seedPublicOnly("PoVisitor");

    const masked = await call("https://example.com/_users/LimitedUser", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(masked.status).toBe(404);
    expect(await masked.json()).toEqual({
      message: userRedirectDoesNotExist("LimitedUser"),
      url: SWAGGER_URL,
    });

    // An unknown target is the route's own 404 — the arm stays silent.
    const unknown = await call("https://example.com/_users/ghost", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ ok: true });
  });

  it("mount-shaped arm: the static /users/search shape is skipped (static-over-param)", async () => {
    const seeded = await seedPublicOnly("PoVisitor");
    const response = await call("https://example.com/_users/search", {
      headers: { Authorization: `token ${seeded.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("Basic token forms (services/auth/basic.go:44–68)", () => {
  it("Basic <token>: (empty password) authenticates", async () => {
    const seeded = await seedWithToken("BasicFormUser", "all");
    const response = await call("https://example.com/_repo", {
      headers: { Authorization: basicTokenHeader(seeded.token) },
    });
    expect(response.status).toBe(200);
  });

  it("Basic <token>:x-oauth-basic authenticates", async () => {
    const seeded = await seedWithToken("OauthBasicUser", "all");
    const response = await call("https://example.com/_repo", {
      headers: { Authorization: basicHeader(seeded.token, "x-oauth-basic") },
    });
    expect(response.status).toBe(200);
  });

  it("Basic user:<token> (password as token) authenticates", async () => {
    const seeded = await seedWithToken("PasswordFormUser", "all");
    const response = await call("https://example.com/_repo", {
      headers: { Authorization: basicHeader("someone", seeded.token) },
    });
    expect(response.status).toBe(200);
  });
});

describe("failure limiter fails open (production finding ef2c049)", () => {
  /** Limiter hook whose every backend call rejects — the production D1
   *  intermittent-throw shape. */
  const brokenLimiter = (): RateLimitHook => {
    const blip = () => new Error("d1 concurrency blip");
    return {
      check: () => Promise.reject(blip()),
      recordFailure: () => Promise.reject(blip()),
      reset: () => Promise.reject(blip()),
    };
  };

  const buildBrokenApp = (): Hono<AuthEnv> => {
    const app = new Hono<AuthEnv>();
    app.use("*", resolveAuth({ failureLimiter: () => brokenLimiter() }));
    app.get("/_repo", requireToken(), (c) => c.json({ ok: true }));
    return app;
  };

  it("limiter.check throwing does not block a valid credential (200, not 500/429)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const seeded = await seedWithToken("FailOpenValid", "all");
    const response = await buildBrokenApp().request(
      "https://example.com/_repo",
      {
        headers: { Authorization: `token ${seeded.token}`, "CF-Connecting-IP": "203.0.113.9" },
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    // Both limiter ops on the success path (check + reset) failed open and
    // logged one line each with the IP and the error — the request itself
    // never noticed.
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("check failed for ip=203.0.113.9");
    expect(consoleError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect(String(consoleError.mock.calls[1]?.[0])).toContain("reset failed for ip=203.0.113.9");
  });

  it("limiter.recordFailure throwing still answers the 401 challenge", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await buildBrokenApp().request("https://example.com/_repo", {
      headers: { Authorization: "token cfg_00000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    }, env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(INVALID_CREDENTIALS);
  });

  it("a broken limiter D1 (dropped table) proceeds through the DEFAULT limiter wiring", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Production-faithful breakage: the limiter's own table is gone, so the
    // default D1FailureLimiter throws on check/recordFailure/reset while the
    // credential tables stay healthy.
    await env.DB.prepare("DROP TABLE auth_failures").run();
    try {
      const seeded = await seedWithToken("FailOpenDropped", "all");
      const ok = await call("https://example.com/_repo", {
        headers: { Authorization: `token ${seeded.token}` },
      });
      expect(ok.status).toBe(200);

      const bad = await call("https://example.com/_repo", {
        headers: { Authorization: "token cfg_00000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      });
      expect(bad.status).toBe(401);
      expect(await bad.json()).toEqual(INVALID_CREDENTIALS);
    } finally {
      // Restore the shared schema — this file's beforeEach DELETEs from
      // auth_failures and sibling tests need the table present.
      await env.DB.prepare(
        "CREATE TABLE `auth_failures` (`ip` text PRIMARY KEY NOT NULL, `window_start` integer NOT NULL, `count` integer DEFAULT 0 NOT NULL)",
      ).run();
    }
  });
});

/**
 * Failure-limiter tests — SPEC-0002 §2.7/§4.4 (20 failures / 5 min / IP,
 * +0–20% deterministic jitter, window rotation, success reset, API 429 +
 * Retry-After), on real D1.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { D1FailureLimiter, fnv1a32 } from "./failure-limiter";
import { resolveAuth, requireToken } from "./middleware";
import { Hono } from "hono";
import type { AuthEnv } from "./auth-context";
import { applyAuthD1Migrations } from "./testing/apply-d1-migrations";
import { resetAuthTables, seedVerifiedUser, mintFor } from "./testing/seeds";

beforeAll(applyAuthD1Migrations);
beforeEach(resetAuthTables);

const BASE_LIMIT = 20;

const limitFor = (ip: string): number => BASE_LIMIT + (fnv1a32(ip) % (Math.ceil(BASE_LIMIT * 0.2) + 1));

describe("D1FailureLimiter", () => {
  it("blocks after the jittered per-IP threshold in the window", async () => {
    const limiter = new D1FailureLimiter(env.DB);
    const ip = "10.1.0.1";
    const now = new Date("2026-10-01T00:00:00Z");
    const limit = limitFor(ip);

    for (let i = 0; i < limit - 1; i++) {
      await limiter.recordFailure(ip, now);
    }
    const before = await limiter.check(ip, now);
    expect(before.blocked).toBe(false);

    await limiter.recordFailure(ip, now);
    const verdict = await limiter.check(ip, new Date(now.getTime() + 1000));
    expect(verdict.blocked).toBe(true);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(5 * 60);
  });

  it("does not leak state across IPs", async () => {
    const limiter = new D1FailureLimiter(env.DB);
    const now = new Date("2026-10-02T00:00:00Z");
    const hot = "10.2.0.1";
    const other = "10.2.0.2";
    for (let i = 0; i < limitFor(hot); i++) {
      await limiter.recordFailure(hot, now);
    }
    expect((await limiter.check(hot, now)).blocked).toBe(true);
    expect((await limiter.check(other, now)).blocked).toBe(false);
  });

  it("rotates an expired window lazily", async () => {
    const limiter = new D1FailureLimiter(env.DB);
    const ip = "10.3.0.1";
    const firstFailure = new Date("2026-10-03T00:00:00Z");
    for (let i = 0; i < limitFor(ip); i++) {
      await limiter.recordFailure(ip, firstFailure);
    }
    // Outside the 5-minute window: stale state does not block...
    const after = new Date(firstFailure.getTime() + 6 * 60 * 1000);
    expect((await limiter.check(ip, after)).blocked).toBe(false);
    // ...and the next failure starts a fresh window (count reset).
    await limiter.recordFailure(ip, after);
    const row = await env.DB.prepare("SELECT count, window_start FROM auth_failures WHERE ip = ?")
      .bind(ip)
      .first<{ count: number; window_start: number }>();
    expect(row?.count).toBe(1);
    expect(row?.window_start).toBe(Math.floor(after.getTime() / 1000));
  });

  it("clears the counter on success", async () => {
    const limiter = new D1FailureLimiter(env.DB);
    const ip = "10.4.0.1";
    const now = new Date("2026-10-04T00:00:00Z");
    for (let i = 0; i < limitFor(ip) - 1; i++) {
      await limiter.recordFailure(ip, now);
    }
    await limiter.reset(ip);
    expect((await limiter.check(ip, now)).blocked).toBe(false);
    // One more failure after the reset must not block.
    await limiter.recordFailure(ip, now);
    expect((await limiter.check(ip, now)).blocked).toBe(false);
  });
});

describe("resolveAuth failure limiting (API surface)", () => {
  const buildApp = (): Hono<AuthEnv> => {
    const app = new Hono<AuthEnv>();
    app.use("*", resolveAuth());
    app.get("/protected", requireToken(), (c) => c.json({ ok: true }));
    return app;
  };

  /** app.request needs the bindings passed explicitly in tests. */
  const call = async (app: Hono<AuthEnv>, path: string, init?: RequestInit): Promise<Response> =>
    await app.request(path, init, env);

  it("answers the 20th+ failure with 429 and Retry-After; other IPs unaffected", async () => {
    const app = buildApp();
    const ip = "10.5.0.1";
    const headers = { Authorization: "token cfg_ffffffff_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "CF-Connecting-IP": ip };
    const limit = limitFor(ip);

    let blockedResponse: Response | null = null;
    for (let i = 0; i <= limit; i++) {
      const response = await call(app, "https://example.com/protected", { headers });
      if (response.status === 429) {
        blockedResponse = response;
        break;
      }
      expect(response.status).toBe(401);
    }
    expect(blockedResponse).not.toBeNull();
    const retryAfter = Number(blockedResponse?.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(300);
    const body = (await blockedResponse?.json()) as { message: string; url: string };
    expect(body.url).toBe("https://example.com/api/swagger");

    // A different IP keeps normal behavior.
    const clean = await call(app, "https://example.com/protected", {
      headers: { ...headers, "CF-Connecting-IP": "10.5.0.2" },
    });
    expect(clean.status).toBe(401);
  });

  it("a successful authentication clears the failure counter", async () => {
    const ip = "10.6.0.1";
    const user = await seedVerifiedUser({ username: "LimiterUser" });
    const { plaintext } = await mintFor(user.id, "limiter-token");

    const app = buildApp();
    const badHeaders = { Authorization: "token cfg_ffffffff_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "CF-Connecting-IP": ip };
    for (let i = 0; i < limitFor(ip) - 1; i++) {
      const response = await call(app, "https://example.com/protected", { headers: badHeaders });
      expect(response.status).toBe(401);
    }

    // Success resets the counter...
    const ok = await call(app, "https://example.com/protected", {
      headers: { Authorization: `token ${plaintext}`, "CF-Connecting-IP": ip },
    });
    expect(ok.status).toBe(200);

    // ...so the next failure is answered with a plain 401 again, not 429.
    const next = await call(app, "https://example.com/protected", { headers: badHeaders });
    expect(next.status).toBe(401);
  });
});

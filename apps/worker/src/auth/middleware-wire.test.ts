/**
 * The API Basic PASSWORD arm on the WIRE (SPEC-0002 §6.2 API-Basic row) —
 * the real `resolveAuth` mounted on a bare Hono app (the
 * repo-actions.test.ts rig posture: local mount, real middleware, seeded D1
 * rows), closing the seam middleware.test.ts leaves open (it pins the token
 * arms + one wrong-password sample; the 2FA ladder, the WebAuthn hard-reject,
 * the OTP atomicity and the synthetic all-scope token downstream never went
 * over the wire).
 *
 * Every expectation cites the pin: upstream
 * gitea/services/auth/basic.go:135-197 (the Basic Verify over the password
 * pair) answered through routers/api/v1/api.go:862-869 (the generic 401
 * fallback: "invalid username, password or token" in the APIError
 * {message, url} envelope) and api.go:155-160 (ctx.APIError's envelope — the
 * WebAuthn hard-reject's ErrUserAuthMessage body, basic.go:155).
 */

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "./testing/apply-d1-migrations";
import { basicHeader } from "./testing/seeds";
import { totpCode } from "./totp";
import {
  applyTwofaEnrollment,
  generateTotpSecret,
  mintPendingTicket,
} from "./two-factor";
import { newPasswordRecord } from "./password";
import type { AuthEnv, AuthInfo } from "./auth-context";
import { resolveAuth, requireScope, requireToken } from "./middleware";
import { createCredential } from "../web/webauthn-store";
import { encodeCoseKey } from "../web/webauthn-ceremony";
import { auditEvents, authFailures, users } from "../db/schema";

beforeAll(applyAuthD1Migrations);

beforeEach(async () => {
  // two_factor + webauthn_credentials ride the 2FA ladders below;
  // system_keystore is NOT wiped (the module caches persist per-file —
  // session.test.ts's posture).
  for (const table of [
    "personal_access_tokens",
    "auth_failures",
    "users",
    "two_factor",
    "webauthn_credentials",
    "audit_event",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the rig: the REAL resolveAuth on a bare Hono app -------------------------

const ORIGIN = "https://example.com";

/** Downstream seam: echo the attached auth state (the matrix's observable
 *  half) plus scope-gated routes for the synthetic token row. */
const app = new Hono<AuthEnv>();
app.use("*", resolveAuth());
app.get("/_whoami", (c) => {
  const auth: AuthInfo | undefined = c.get("auth");
  return c.json({
    user: auth?.user?.username ?? null,
    userId: auth?.user?.id ?? null,
    isBasicAuth: auth?.isBasicAuth ?? false,
    token: auth?.token === null ? null : { ...auth.token, createdAt: "elided" },
    scope: auth?.scope?.toString() ?? null,
  });
});
app.get("/_repo", requireScope("repository"), requireToken(), (c) => c.json({ ok: true }));
app.post("/_repo", requireScope("repository"), requireToken(), (c) => c.json({ ok: true }));

/** app.request needs the bindings passed explicitly in tests. */
const call = async (path: string, init?: RequestInit): Promise<Response> =>
  await app.request(`${ORIGIN}${path}`, init, env);

// --- fixtures (session.test.ts's seedPassword / TOTP enroll patterns) --------

async function seedUser(username: string): Promise<{ id: number; username: string }> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({ username, usernameLower: username.toLowerCase(), createdAt: new Date() })
    .returning({ id: users.id, username: users.username })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  return row;
}

/** A login-able PASSWORD on `user` (SPEC-0002 §6.2 — the row gains the hashed
 *  password columns under the configured pbkdf2 arm). Returns the plaintext. */
async function seedPassword(user: { id: number }, password = "correct horse battery staple"): Promise<string> {
  const record = await newPasswordRecord(password);
  const updated = await drizzle(env.DB)
    .update(users)
    .set({ passwd: record.passwd, salt: record.salt, passwdHashAlgo: record.passwdHashAlgo })
    .where(eq(users.id, user.id))
    .returning({ id: users.id })
    .all();
  if (updated.length === 0) throw new Error("password seed failed");
  return password;
}

/** A live TOTP enrollment through the REAL enrollment seam (the secret never
 *  touches a test constant — session.test.ts's seedEnrolled shape). */
async function seedTotp(user: { id: number }): Promise<{ secret: string }> {
  const secret = generateTotpSecret();
  const ticket = await mintPendingTicket(env.DB, { kind: "enroll", secret });
  const outcome = await applyTwofaEnrollment(env.DB, user.id, await totpCode(secret, Date.now() / 1000), ticket);
  if (outcome.outcome !== "enrolled") throw new Error(`enroll fixture failed: ${outcome.outcome}`);
  return { secret };
}

/** A WebAuthn credential row (the gate reads EXISTENCE — real COSE bytes so
 *  the store's row view parses, session.test.ts's dual-enrollment fixture). */
async function seedWebAuthn(user: { id: number }): Promise<void> {
  const x = crypto.getRandomValues(new Uint8Array(32));
  const y = crypto.getRandomValues(new Uint8Array(32));
  await createCredential(env.DB, user.id, "security key", {
    credentialId: crypto.getRandomValues(new Uint8Array(16)),
    coseKey: { kty: "EC2", x, y },
    publicKeyRaw: encodeCoseKey({ kty: "EC2", x, y }),
    attestationType: "none",
    aaguid: new Uint8Array(16),
    signCount: 0,
    transports: null,
    userPresent: true,
    userVerified: true,
  });
}

const SWAGGER_URL = `${ORIGIN}/api/swagger`;
/** api.go:862-869 — the generic fallback swallowing every non-ErrUserAuthMessage
 *  Basic failure, in the APIError envelope (api.go:155-160). */
const GENERIC_401 = { message: "invalid username, password or token", url: SWAGGER_URL };

const failureCountFor = async (ip: string): Promise<number> =>
  (await drizzle(env.DB).select().from(authFailures).where(eq(authFailures.ip, ip)).get())?.count ?? 0;

// -----------------------------------------------------------------------------
// The happy password pair over the wire
// -----------------------------------------------------------------------------

describe("HTTP Basic (username, password) → the password sign-in (basic.go:135-146)", () => {
  it("valid pair authenticates: the doer attaches with the synthetic all-scope token row", async () => {
    const alice = await seedUser("Alice");
    const pw = await seedPassword(alice);

    const res = await call("/_whoami", { headers: { Authorization: basicHeader("Alice", pw) } });
    expect(res.status).toBe(200);
    const body = await res.json<{
      user: string | null;
      userId: number | null;
      isBasicAuth: boolean;
      token: { id: number; userId: number; name: string; prefix: string; scopes: string } | null;
      scope: string | null;
    }>();

    expect(body.user).toBe("Alice");
    expect(body.userId).toBe(alice.id);
    expect(body.isBasicAuth).toBe(true);
    // The synthetic row (middleware.ts:220-237): NO personal_access_tokens
    // row exists — upstream's GetDoerTokenScope misses the ExtDoerData arm
    // and GetAccessScope answers AccessTokenScopeAll via the LoginMethod
    // check (basic.go:186-197) — the synthetic row renders it identically.
    expect(body.token).toEqual({
      id: -1,
      userId: alice.id,
      name: "basic-password",
      prefix: "",
      scopes: "all",
      expiresAt: null,
      lastUsedAt: null,
      createdAt: "elided",
    });
    expect(body.scope).toBe("all");
  });

  it("the synthetic row passes the downstream scope gate at BOTH levels (all ⊇ read:repository + write:repository)", async () => {
    const alice = await seedUser("Alice");
    const pw = await seedPassword(alice);
    const headers = { Authorization: basicHeader("Alice", pw) };

    const read = await call("/_repo", { headers });
    expect(read.status).toBe(200);
    const write = await call("/_repo", { method: "POST", headers });
    expect(write.status).toBe(200);
  });

  it("the password pair is tried only after the token arms miss: a password that happens to parse as a token candidate still signs in", async () => {
    // basic.go:44-68 parseAuthBasic — a non-empty password IS the token
    // candidate first; VerifyAuthToken misses it (no PAT row), then the
    // password sign-in answers on the same pair. A PASSWORD CONTAINING A DOT
    // would dispatch to the OAuth2 arm instead (middleware.ts:186) — pinned
    // as the boundary the other direction: a dotless password always lands here.
    const alice = await seedUser("Alice");
    const pw = await seedPassword(alice, "dotless passphrase ok");
    expect(pw.includes(".")).toBe(false);

    const res = await call("/_whoami", { headers: { Authorization: basicHeader("Alice", pw) } });
    expect(res.status).toBe(200);
    expect((await res.json<{ user: string | null }>()).user).toBe("Alice");
  });
});

// -----------------------------------------------------------------------------
// The generic failure class — byte-exactness (api.go:862-869)
// -----------------------------------------------------------------------------

describe("the generic 401: byte-exact body on every Basic password miss", () => {
  it("wrong password", async () => {
    const alice = await seedUser("Alice");
    await seedPassword(alice);

    const res = await call("/_whoami", { headers: { Authorization: basicHeader("Alice", "wrong-password") } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(GENERIC_401);
  });

  it("unknown user (existence never disclosed)", async () => {
    const res = await call("/_whoami", { headers: { Authorization: basicHeader("Ghost", "whatever") } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(GENERIC_401);
  });

  it("password never set (the users row's empty passwd default fails closed)", async () => {
    await seedUser("NoPass"); // no seedPassword — the row carries the "" default
    const res = await call("/_whoami", { headers: { Authorization: basicHeader("NoPass", "") } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(GENERIC_401);
  });
});

// -----------------------------------------------------------------------------
// The 2FA ladder (basic.go:148-161 + validateTOTP :169-187)
// -----------------------------------------------------------------------------

describe("the TOTP ladder on the wire (X-Gitea-OTP)", () => {
  it("wrong OTP → generic 401 + the audit row (basic.go:182's RecordAs; the OTP text stays OFF the wire)", async () => {
    const alice = await seedUser("Alice");
    const pw = await seedPassword(alice);
    await seedTotp(alice);

    const res = await call("/_whoami", {
      headers: { Authorization: basicHeader("Alice", pw), "X-Gitea-OTP": "000000" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(GENERIC_401);

    // The audit row is fire-and-forget (`void emitAudit`) — poll for it.
    await vi.waitFor(async () => {
      const rows = await drizzle(env.DB).select().from(auditEvents).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe("user:authentication:fail:twofactor");
      expect(rows[0]?.actorId).toBe(alice.id);
      expect(rows[0]?.origin).toBe("api");
    });
  });

  it("ABSENT OTP → the same generic 401 + audit row", async () => {
    const alice = await seedUser("Alice");
    const pw = await seedPassword(alice);
    await seedTotp(alice);

    const res = await call("/_whoami", { headers: { Authorization: basicHeader("Alice", pw) } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(GENERIC_401);

    await vi.waitFor(async () => {
      expect(await drizzle(env.DB).select().from(auditEvents).all()).toHaveLength(1);
    });
  });

  it("valid OTP authenticates", async () => {
    const alice = await seedUser("Alice");
    const pw = await seedPassword(alice);
    const { secret } = await seedTotp(alice);

    const res = await call("/_whoami", {
      headers: { Authorization: basicHeader("Alice", pw), "X-Gitea-OTP": await totpCode(secret, Date.now() / 1000) },
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ user: string | null }>()).user).toBe("Alice");
    expect(await drizzle(env.DB).select().from(auditEvents).all()).toHaveLength(0);
  });

  it("a REPLAYED OTP within its window fails — the consume is atomic (twofactor.go:127-143)", async () => {
    const alice = await seedUser("Alice");
    const pw = await seedPassword(alice);
    const { secret } = await seedTotp(alice);
    const otp = await totpCode(secret, Date.now() / 1000);
    const headers = { Authorization: basicHeader("Alice", pw), "X-Gitea-OTP": otp };

    const first = await call("/_whoami", { headers });
    expect(first.status).toBe(200);

    // The identical pair, ms later, same 30 s period: the conditional
    // last_used_passcode_period guard matches zero rows → totp-fail → the
    // generic 401 + the audit row. A captured OTP cannot replay.
    const replay = await call("/_whoami", { headers });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual(GENERIC_401);

    await vi.waitFor(async () => {
      const rows = await drizzle(env.DB).select().from(auditEvents).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe("user:authentication:fail:twofactor");
    });
  });
});

// -----------------------------------------------------------------------------
// The WebAuthn hard-reject (basic.go:153-156)
// -----------------------------------------------------------------------------

describe("WebAuthn-enrolled hard-reject (basic.go:153-156)", () => {
  it("401 with the VERBATIM ErrUserAuthMessage in the APIError envelope (api.go:155-160)", async () => {
    const alice = await seedUser("Alice");
    const pw = await seedPassword(alice);
    await seedWebAuthn(alice);

    const res = await call("/_whoami", { headers: { Authorization: basicHeader("Alice", pw) } });
    expect(res.status).toBe(401);
    // The message IS the wire body — the one Basic failure that escapes
    // api.go:867's generic fallback (ErrAsUserAuthMessage matches).
    expect(await res.json()).toEqual({
      message: "basic authorization is not allowed while WebAuthn enrolled",
      url: SWAGGER_URL,
    });
  });

  it("WebAuthn + TOTP BOTH enrolled: the WebAuthn reject precedes the TOTP ladder — even a VALID OTP cannot get through (basic.go:148-161's order)", async () => {
    const alice = await seedUser("Alice");
    const pw = await seedPassword(alice);
    const { secret } = await seedTotp(alice);
    await seedWebAuthn(alice);

    const res = await call("/_whoami", {
      headers: { Authorization: basicHeader("Alice", pw), "X-Gitea-OTP": await totpCode(secret, Date.now() / 1000) },
    });
    expect(res.status).toBe(401);
    expect(((await res.json<{ message: string }>()).message)).toBe(
      "basic authorization is not allowed while WebAuthn enrolled",
    );
  });
});

// -----------------------------------------------------------------------------
// The failure limiter on the wire (SPEC-0002 §2.7 — no upstream pin: the IP
// limiter is a cf-gitea addition upstream's basic.go does not have; only the
// status + Retry-After posture is specified, SPEC-0002 §2.7)
// -----------------------------------------------------------------------------

describe("the failure-limiter interplay on the wire", () => {
  it("a failed password attempt records ONE failure for the presented IP", async () => {
    const alice = await seedUser("Alice");
    await seedPassword(alice);

    const res = await call("/_whoami", {
      headers: { Authorization: basicHeader("Alice", "nope"), "CF-Connecting-IP": "203.0.113.9" },
    });
    expect(res.status).toBe(401);
    expect(await failureCountFor("203.0.113.9")).toBe(1);
  });

  it("a SUCCESSFUL password attempt resets the counter (the verified-credential arm)", async () => {
    const alice = await seedUser("Alice");
    const pw = await seedPassword(alice);
    await drizzle(env.DB).insert(authFailures).values({ ip: "203.0.113.10", windowStart: new Date(), count: 7 });

    const res = await call("/_whoami", {
      headers: { Authorization: basicHeader("Alice", pw), "CF-Connecting-IP": "203.0.113.10" },
    });
    expect(res.status).toBe(200);
    expect(await failureCountFor("203.0.113.10")).toBe(0);
  });

  it("an IP at threshold is answered 429 + Retry-After BEFORE the credential is tested", async () => {
    const alice = await seedUser("Alice");
    const pw = await seedPassword(alice);
    await drizzle(env.DB).insert(authFailures).values({ ip: "203.0.113.11", windowStart: new Date(), count: 999 });

    const res = await call("/_whoami", {
      headers: { Authorization: basicHeader("Alice", pw), "CF-Connecting-IP": "203.0.113.11" },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
    // SPEC-0002 §2.7's pinned status class; the message is the unpinned
    // house constant (middleware.ts:38-39 — "only status + Retry-After are
    // specified").
    expect(((await res.json<{ message: string }>()).message)).toBe("too many authentication failures, retry later");
  });
});

/**
 * The forgot/reset password machinery's WEB wire (SPEC-0002 §6.2 reset row,
 * PWD-2) — the module-suite pattern (user-settings-account.test.tsx): DOM
 * contract over hono/jsx renderToString, then the sessionRouter route arms
 * through the locally-mounted app (session.test.ts's posture with the
 * synthetic manifest fixture), seeds through applyAuthD1Migrations + direct
 * service calls.
 *
 * Pins (upstream routers/web/auth/password.go at the submodule):
 *   - the forgot-REQUEST arm stays GATED OFF (no Workers mailer): the GET
 *     renders the IsResetDisable state (password.go:40-45) and the POST is
 *     the non-browser arm (password.go:53-57) — the LANDED 404 (the PWD-WIRE
 *     finding cured 2026-11-04; the pin below);
 *   - the reset link verifies BEFORE the form renders (commonResetPassword,
 *     password.go:110-160) over the HMAC time-limit code
 *     (models/user/user.go:920-973 at our auth/reset-code.ts port): bad
 *     signature / expired window / unknown-user tail all collapse into the
 *     invalid-code re-render at 200;
 *   - the POST ladder (ResetPasswdPost, password.go:164-265): the TOTP
 *     passcode/scratch arms BEFORE the apply, the UpdateAuth validation
 *     re-check (services/user/update.go:247-265 — no old-password check: a
 *     valid code IS the credential), the passwd/rands-bound code's DE FACTO
 *     one-time invalidation (user.go:948-950 — the hash data no longer
 *     recomputes after SetPassword), then the sign-in state (handleSignIn,
 *     auth.go:632 — mint + cookie + "/") or the WebAuthn-only park
 *     (password.go:246-258).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { renderToString } from "hono/jsx/dom/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { userSignInPassword } from "../../auth/password-auth";
import { newPasswordRecord } from "../../auth/password";
import { totpCode } from "../../auth/totp";
import { applyTwofaEnrollment, generateTotpSecret, mintPendingTicket } from "../../auth/two-factor";
import { generateUserTimeLimitCode, verifyUserTimeLimitCode, TIME_LIMIT_CODE_LENGTH } from "../../auth/reset-code";
import { createCredential } from "../../web/webauthn-store";
import { encodeCoseKey, WEBAUTHN_COOKIE_NAME } from "../../web/webauthn-ceremony";
import { demoModeEnabled } from "../../services/demo-sweep";
import { sessions, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  REMEMBER_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  sessionRouter,
} from "../session";
import { ForgotPasswordPage, passwordResetLocale, renderForgotPasswordPage, ResetPasswordPage } from "./password-reset";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
};

const viewer: Viewer = { kind: "anonymous" };
const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

// The demo render gate pinned to the ABSENT arm (session.test.ts's posture —
// an armed local DEMO_MODE shifts every BaseLayout render; the generated Env
// carries the example's literal, so the widened shape is the cast).
const testEnv: Env = { ...env };
(testEnv as { DEMO_MODE?: string }).DEMO_MODE = undefined;
if (demoModeEnabled(testEnv)) {
  throw new Error("password-reset goldens: the demo render gate pin failed — demoModeEnabled(env) must be false");
}

// The local app: the sessionRouter carries the reset routes (production
// mounts it next to the uiRouter; these arms never dispatch into the latter).
const app = new Hono<{ Bindings: Env }>();
app.route("/", sessionRouter);

/** Route-level request with a REAL execution context so every waitUntil
 *  side-effect settles before assertions (session.test.ts's helper). */
async function request(path: string, init?: RequestInit): Promise<Response> {
  const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`${ORIGIN}${path}`, init), testEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

const cookieHeader = (response: Response): string => response.headers.get("set-cookie") ?? "";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // system_keystore NOT wiped — the reset-code signing secret persists
  // per-file (the module posture; session.test.ts's comment).
  for (const table of [
    "user_redirects",
    "email_addresses",
    "sessions",
    "personal_access_tokens",
    "auth_failures",
    "two_factor",
    "webauthn_credentials",
    "audit_event",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- seeds -------------------------------------------------------------------

interface SeedUser {
  id: number;
  username: string;
  usernameLower: string;
}

async function seedUser(username: string, email: string | null = null): Promise<SeedUser> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({ username, usernameLower: username.toLowerCase(), email, createdAt: new Date() })
    .returning({ id: users.id, username: users.username, usernameLower: users.usernameLower })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  return row;
}

/** A login-able PASSWORD on `user` (the session.test.ts seedPassword shape). */
async function seedPassword(user: SeedUser, password = "correct horse battery staple"): Promise<string> {
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

/** The full users row (the code machinery binds passwd/rands — the data hash
 *  MUST recompute from the row, user.go:948-950). */
async function userRow(id: number): Promise<typeof users.$inferSelect> {
  const row = await drizzle(env.DB).select().from(users).where(eq(users.id, id)).get();
  if (row === undefined) throw new Error(`user ${id} missing`);
  return row;
}

/** A live TOTP enrollment through the REAL enrollment seam. */
async function seedTotp(user: SeedUser): Promise<{ secret: string; scratchToken: string }> {
  const secret = generateTotpSecret();
  const ticket = await mintPendingTicket(env.DB, { kind: "enroll", secret });
  const outcome = await applyTwofaEnrollment(env.DB, user.id, await totpCode(secret, Date.now() / 1000), ticket);
  if (outcome.outcome !== "enrolled") throw new Error(`enroll fixture failed: ${outcome.outcome}`);
  return { secret, scratchToken: outcome.scratchToken };
}

async function seedWebAuthn(user: SeedUser): Promise<void> {
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

/** A reset link code minted through the real generator (user.go:952-963). */
async function mintCode(user: SeedUser, options?: { now?: Date; minutes?: number }): Promise<string> {
  return generateUserTimeLimitCode(env.DB, "reset_password", await userRow(user.id), options);
}

/** Corrupt one hex char of the HMAC segment (stamp 12 + minutes 6 + hash 40
 *  ⇒ the hash occupies [18, 58)) while keeping the tail — the signature
 *  compare must fail, user.go:965-973. */
function tamperSignature(code: string): string {
  const at = TIME_LIMIT_CODE_LENGTH - 30; // 28 — inside the hash segment
  const ch = code[at];
  if (ch === undefined) throw new Error("code shorter than the pin layout");
  const flipped = ch === "0" ? "1" : "0";
  return code.slice(0, at) + flipped + code.slice(at + 1);
}

/** The hex(lowerName) tail of a user that does not exist (user.go:920-936's
 *  GetVerifyUser miss). */
const hexTail = (name: string): string =>
  [...new TextEncoder().encode(name)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Passes the all-classes default policy (lower + upper + digit + spec). */
const NEW_PASSWORD = "Fresh-Horse-Battery-Staple-42";

// -----------------------------------------------------------------------------
// The module-level DOM contract (the reduced template posture)
// -----------------------------------------------------------------------------

describe("the page renders (forgot_password.tmpl / reset_password.tmpl's reduced forms)", () => {
  it("ForgotPasswordPage renders the no-mailer disabled posture (password.go:40-45's IsResetDisable)", () => {
    const html = renderToString(<ForgotPasswordPage ctx={ctx} />);
    expect(html).toContain("Forgot Password");
    expect(html).toContain(passwordResetLocale.reset_disabled);
    // The disabled state renders NO request form: without a mailer there is
    // nothing the instance can send (the upstream template's IsResetDisable
    // branch — reduced render, the template is not vendored).
    expect(html).not.toContain("<form");
  });

  it("renderForgotPasswordPage is the string wrapper of the page", () => {
    expect(renderForgotPasswordPage(ctx)).toContain(passwordResetLocale.reset_disabled);
  });

  it("ResetPasswordPage: the code rides a hidden field, no passcode field without TOTP", () => {
    const html = renderToString(
      <ResetPasswordPage ctx={ctx} code="abc123" error={null} twoFactor={false} />,
    );
    expect(html).toContain('name="code" value="abc123"');
    expect(html).toContain('action="/user/reset_password"');
    expect(html).toContain('name="password"');
    expect(html).toContain('name="retype"');
    expect(html).toContain('name="remember"');
    expect(html).not.toContain('name="passcode"');
    expect(html).not.toContain('name="scratch_code"');
  });

  it("ResetPasswordPage: a TOTP-enrolled account's form carries the passcode field (reset_password.tmpl)", () => {
    const html = renderToString(
      <ResetPasswordPage ctx={ctx} code="abc123" error={null} twoFactor={true} />,
    );
    expect(html).toContain('name="passcode"');
    expect(html).toContain("Auth passcode");
  });

  it("ResetPasswordPage: the error flash renders the failure message", () => {
    const html = renderToString(
      <ResetPasswordPage ctx={ctx} code="abc123" error={passwordResetLocale.invalid_code} twoFactor={false} />,
    );
    expect(html).toContain(passwordResetLocale.invalid_code);
  });
});

// -----------------------------------------------------------------------------
// GET /user/forgot_password — the disabled posture on the wire
// -----------------------------------------------------------------------------

describe("GET/POST /user/forgot_password (password.go:40-57)", () => {
  it("GET renders the reset-disabled state at 200 (no mailer ⇒ IsResetDisable)", async () => {
    const res = await request("/user/forgot_password");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Forgot Password");
    expect(html).toContain(passwordResetLocale.reset_disabled);
    expect(html).not.toContain("<form");
  });

  it("POST is the non-browser arm: upstream's NotFound(nil) — 404 plain `Not found.` without an HTML Accept (password.go:53-57)", async () => {
    // LANDED-WIRE (the PWD-WIRE finding cured, 2026-11-04): the arm used to
    // answer the 500 server-error shell; it now answers upstream's
    // ctx.NotFound(nil) exactly (password.go:53-57 → notFoundInternal,
    // services/context/context_response.go:130-155): without `text/html` in
    // the Accept, plainTextInternal's literal body at 404.
    const res = await request("/user/forgot_password", { method: "POST", body: "email=alice@example.com", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("Not found.\n");
  });

  it("POST with an HTML Accept renders the 404 shell (notFoundInternal's text/html arm)", async () => {
    const res = await request("/user/forgot_password", {
      method: "POST",
      body: "email=alice@example.com",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html,application/xhtml+xml" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Page Not Found");
  });
});

// -----------------------------------------------------------------------------
// GET /user/reset_password — the code verifies BEFORE the form renders
// (commonResetPassword, password.go:110-160)
// -----------------------------------------------------------------------------

describe("GET /user/reset_password?code=… — the validation arms (user.go:920-973)", () => {
  it("a VALID code renders the recovery form, error-free, with the code echoed back", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const code = await mintCode(alice);

    const res = await request(`/user/reset_password?code=${code}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(passwordResetLocale.invalid_code);
    expect(html).toContain(`name="code" value="${code}"`);
    expect(html).not.toContain('name="passcode"'); // no TOTP enrollment
  });

  it("a TOTP-enrolled account's form carries the passcode field (password.go:144-151's has_two_factor)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    await seedTotp(alice);
    const code = await mintCode(alice);

    const res = await request(`/user/reset_password?code=${code}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="passcode"');
  });

  it("NO code (or empty) → the invalid-code render at 200 (password.go:125-130's len(code)==0 arm)", async () => {
    const noCode = await request("/user/reset_password");
    expect(noCode.status).toBe(200);
    expect(await noCode.text()).toContain(passwordResetLocale.invalid_code);

    const emptyCode = await request("/user/reset_password?code=");
    expect(emptyCode.status).toBe(200);
    expect(await emptyCode.text()).toContain(passwordResetLocale.invalid_code);
  });

  it("a TAMPERED signature → the invalid-code render (the recomputed HMAC misses, user.go:965-973)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const code = await mintCode(alice);
    // The tampered code must fail at the MODULE too — the arms below derive
    // from the same verdict (verifyUserTimeLimitCode → null).
    expect(await verifyUserTimeLimitCode(env.DB, "reset_password", tamperSignature(code))).toBeNull();

    const res = await request(`/user/reset_password?code=${tamperSignature(code)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(passwordResetLocale.invalid_code);
  });

  it("an EXPIRED code (window closed) → the invalid-code render (tool.go:53's now < start+minutes)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    // ACTIVE_CODE_LIVES_MINUTES is 180 (service.go:146): mint at T-4h ⇒ the
    // whole window lies in the past.
    const code = await mintCode(alice, { now: new Date(Date.now() - 4 * 60 * 60 * 1000) });
    expect(await verifyUserTimeLimitCode(env.DB, "reset_password", code)).toBeNull();

    const res = await request(`/user/reset_password?code=${code}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(passwordResetLocale.invalid_code);
  });

  it("an UNKNOWN-user tail → the invalid-code render (GetVerifyUser's tail miss, user.go:920-936)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const code = await mintCode(alice);
    const ghostCode = code.slice(0, TIME_LIMIT_CODE_LENGTH) + hexTail("ghost");
    expect(await verifyUserTimeLimitCode(env.DB, "reset_password", ghostCode)).toBeNull();

    const res = await request(`/user/reset_password?code=${ghostCode}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(passwordResetLocale.invalid_code);
  });
});

// -----------------------------------------------------------------------------
// POST /user/reset_password — the reset ladder (ResetPasswdPost, :164-265)
// -----------------------------------------------------------------------------

describe("POST /user/reset_password — the apply ladder", () => {
  it("the happy path: 303 /, the session cookie minted, the password applied (no old-password check — a valid code IS the credential)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const oldPw = await seedPassword(alice, "previous horse battery staple");
    const code = await mintCode(alice);

    const res = await request("/user/reset_password", form({ code, password: NEW_PASSWORD, retype: NEW_PASSWORD }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(cookieHeader(res)).toContain(SESSION_COOKIE_NAME);

    // UpdateAuth landed: the row's hash columns moved off the old record and
    // the NEW pair signs in while the OLD one stopped (userSignInPassword).
    const row = await userRow(alice.id);
    const oldRecord = await newPasswordRecord(oldPw);
    expect(row.passwd).not.toBe(oldRecord.passwd);
    expect(await userSignInPassword(env.DB, "alice", NEW_PASSWORD)).toMatchObject({ ok: true });
    expect((await userSignInPassword(env.DB, "alice", oldPw)).ok).toBe(false);

    // handleSignIn's mint: remember off ⇒ a session-scope cookie + row.
    expect(cookieHeader(res)).not.toContain("Max-Age");
    const sessionRow = (await drizzle(env.DB).select().from(sessions).all())[0];
    expect(sessionRow?.userId).toBe(alice.id);
    expect(sessionRow?.remember).toBe(false);
  });

  it("remember=on persists: Max-Age=2678400 on the cookie, remember=true on the row", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const code = await mintCode(alice);

    const res = await request(
      "/user/reset_password",
      form({ code, password: NEW_PASSWORD, retype: NEW_PASSWORD, remember: "on" }),
    );
    expect(res.status).toBe(303);
    expect(cookieHeader(res)).toContain(`Max-Age=${REMEMBER_MAX_AGE_SECONDS}`);
    const sessionRow = (await drizzle(env.DB).select().from(sessions).all())[0];
    expect(sessionRow?.remember).toBe(true);
  });

  it("the passwd-bound code is ONE-TIME: after a successful reset the same link stops verifying (user.go:948-950's data hash no longer recomputes)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const code = await mintCode(alice);
    expect(await verifyUserTimeLimitCode(env.DB, "reset_password", code)).not.toBeNull();

    const res = await request("/user/reset_password", form({ code, password: NEW_PASSWORD, retype: NEW_PASSWORD }));
    expect(res.status).toBe(303);

    // No store clears the code — SetPassword moved the row's passwd, and the
    // hash data binds passwd|rands: the verify now derives null de facto.
    expect(await verifyUserTimeLimitCode(env.DB, "reset_password", code)).toBeNull();
    const replay = await request("/user/reset_password", form({ code, password: "another staple 42", retype: "another staple 42" }));
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain(passwordResetLocale.invalid_code);
  });

  it("the retype mismatch re-renders with the match message, password UNTOUCHED (UpdateAuth's ladder)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const code = await mintCode(alice);
    const before = await userRow(alice.id);

    const res = await request("/user/reset_password", form({ code, password: NEW_PASSWORD, retype: "different staple 42" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The passwords do not match.");

    const after = await userRow(alice.id);
    expect(after.passwd).toBe(before.passwd);
    expect(after.salt).toBe(before.salt);
    // The code SURVIVES a failed apply (nothing consumed it).
    expect(await verifyUserTimeLimitCode(env.DB, "reset_password", code)).not.toBeNull();
  });

  it("the policy re-check runs on the POST arm: below-minimum and complexity failures re-render, password untouched (update.go:247-265)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const code = await mintCode(alice);

    const short = await request("/user/reset_password", form({ code, password: "sh0rt", retype: "sh0rt" }));
    expect(short.status).toBe(200);
    expect(await short.text()).toContain("Password length cannot be less than 8 characters.");

    const weak = await request("/user/reset_password", form({ code, password: "alllowercasepass", retype: "alllowercasepass" }));
    expect(weak.status).toBe(200);
    // BuildComplexityError's all-classes default (password.go:86-96): the
    // upper/digit classes missing.
    expect(await weak.text()).toContain("Password does not pass complexity requirements:");

    const after = await userRow(alice.id);
    expect(after.passwd).toBe("");
  });

  it("a missing / invalid code on POST → the invalid-code re-render (password.go:171-176's commonResetPassword miss)", async () => {
    await seedUser("Alice", "alice@example.com");

    const noCode = await request("/user/reset_password", form({ password: NEW_PASSWORD, retype: NEW_PASSWORD }));
    expect(noCode.status).toBe(200);
    expect(await noCode.text()).toContain(passwordResetLocale.invalid_code);

    const alice = await seedUser("Bob", "bob@example.com");
    const code = await mintCode(alice);
    const bad = await request("/user/reset_password", form({ code: `${code}zz`, password: NEW_PASSWORD, retype: NEW_PASSWORD }));
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain(passwordResetLocale.invalid_code);
  });

  it("the apply clears the admin-set must_change_password flag (password.go:204-207's MustChangePassword: optional.Some(false) — the PWD-4 exit)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    await drizzle(env.DB).update(users).set({ mustChangePassword: true }).where(eq(users.id, alice.id)).run();
    const code = await mintCode(alice);

    const res = await request("/user/reset_password", form({ code, password: NEW_PASSWORD, retype: NEW_PASSWORD }));
    expect(res.status).toBe(303);
    const row = await userRow(alice.id);
    expect(row.mustChangePassword).toBe(false);
    expect(await userSignInPassword(env.DB, "alice", NEW_PASSWORD)).toMatchObject({ ok: true });
  });
});

// -----------------------------------------------------------------------------
// The 2FA arms of the ladder (password.go:170-204 — BEFORE the apply)
// -----------------------------------------------------------------------------

describe("POST /user/reset_password — the TOTP/scratch arms", () => {
  it("TOTP-enrolled + NO passcode → the invalid-code re-render, password untouched (twofa_passcode_incorrect's arm)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    await seedTotp(alice);
    const code = await mintCode(alice);

    const res = await request("/user/reset_password", form({ code, password: NEW_PASSWORD, retype: NEW_PASSWORD }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(passwordResetLocale.invalid_code);
    expect((await userRow(alice.id)).passwd).toBe("");
  });

  it("TOTP-enrolled + VALID passcode → the reset applies and signs in", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const { secret } = await seedTotp(alice);
    const code = await mintCode(alice);

    const res = await request(
      "/user/reset_password",
      form({ code, password: NEW_PASSWORD, retype: NEW_PASSWORD, passcode: await totpCode(secret, Date.now() / 1000) }),
    );
    expect(res.status).toBe(303);
    expect(await userSignInPassword(env.DB, "alice", NEW_PASSWORD)).toMatchObject({ ok: true });
  });

  it("the SCRATCH code arm: a valid scratch token replaces the passcode (password.go:171-181's FormBool arm)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const { scratchToken } = await seedTotp(alice);
    const code = await mintCode(alice);

    const res = await request(
      "/user/reset_password",
      form({ code, password: NEW_PASSWORD, retype: NEW_PASSWORD, scratch_code: scratchToken }),
    );
    expect(res.status).toBe(303);
    expect(await userSignInPassword(env.DB, "alice", NEW_PASSWORD)).toMatchObject({ ok: true });
  });

  it("a WRONG scratch token → the invalid-code re-render, password untouched", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    await seedTotp(alice);
    const code = await mintCode(alice);

    const res = await request(
      "/user/reset_password",
      form({ code, password: NEW_PASSWORD, retype: NEW_PASSWORD, scratch_code: "AAAAAAAAAAAA" }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(passwordResetLocale.invalid_code);
    expect((await userRow(alice.id)).passwd).toBe("");
  });
});

// -----------------------------------------------------------------------------
// The WebAuthn-only park (password.go:246-258 — the apply PRECEDES the park)
// -----------------------------------------------------------------------------

describe("POST /user/reset_password — the WebAuthn-only park", () => {
  it("a WebAuthn-enrolled (no TOTP) user resets fine, then finishes on /user/webauthn with the pending carrier", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    await seedWebAuthn(alice);
    const code = await mintCode(alice);

    const res = await request("/user/reset_password", form({ code, password: NEW_PASSWORD, retype: NEW_PASSWORD }));
    // The reset APPLIED first (UpdateAuth precedes handleTwoFactorRequired).
    expect(await userSignInPassword(env.DB, "alice", NEW_PASSWORD)).toMatchObject({ ok: true });
    // …then the park: 303 /user/webauthn + the pending ticket cookie.
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/user/webauthn");
    expect(cookieHeader(res)).toContain(WEBAUTHN_COOKIE_NAME);
    // The park does NOT mint the session — the ceremony owns the sign-in.
    expect(await drizzle(env.DB).select().from(sessions).all()).toHaveLength(0);
  });
});

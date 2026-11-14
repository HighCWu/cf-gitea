/**
 * The forgot/reset password machinery's WEB wire (SPEC-0002 §6.2 reset row,
 * PWD-2) — the module-suite pattern (user-settings-account.test.tsx): DOM
 * contract over hono/jsx renderToString, then the sessionRouter route arms
 * through the locally-mounted app (session.test.ts's posture with the
 * synthetic manifest fixture), seeds through applyAuthD1Migrations + direct
 * service calls.
 *
 * Pins (upstream routers/web/auth/password.go at the submodule):
 *   - the forgot-REQUEST arm's DISABLED twins (no Workers mailer — the
 *     injected test env carries MAIL_ENABLED="false"): the GET renders the
 *     IsResetDisable state (password.go:40-45) and the POST is the
 *     non-browser arm (password.go:53-57) — the LANDED 404 (the PWD-WIRE
 *     finding cured 2026-11-04);
 *   - the forgot-REQUEST arm's LIVE ladder (B-84, password.go:53-106, over
 *     MAIL_ENABLED="true"): the request form, the ANTI-ENUMERATION sent
 *     render (byte-identical for a known and an unknown submission — no
 *     existence oracle, no account-derived data beyond the submission echo),
 *     the outbox row + the minted code's 180-minute TTL on the exists
 *     branch, the org fold into the silent arm, the secondary-email lookup
 *     mailing the PRIMARY address (EmailTo parity), the 180 s resend
 *     throttle, the non-local refusal flash, the UserPasswordResetRequest
 *     audit row, and the /user/recover_account route alias (web.go:761-762 —
 *     the mail link's path, the form's {{.Link}} action);
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
 *     (password.go:246-258);
 *   - the wrong-user refusal (B-83, commonResetPassword password.go:144-146):
 *     a signed-in viewer on ANOTHER account's link gets the
 *     reset_password_wrong_user flash and the reset does NOT apply — the GET
 *     renders the page WITH the flash, the POST stops BEFORE the TOTP
 *     consume (GetTwoFactorByUID precedes the guard upstream), no session is
 *     minted, nothing is consumed.
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { renderToString } from "hono/jsx/dom/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { userSignInPassword } from "../../auth/password-auth";
import { newPasswordRecord, verifyPassword } from "../../auth/password";
import { totpCode } from "../../auth/totp";
import { applyTwofaEnrollment, generateTotpSecret, mintPendingTicket } from "../../auth/two-factor";
import { generateUserTimeLimitCode, verifyUserTimeLimitCode, TIME_LIMIT_CODE_LENGTH } from "../../auth/reset-code";
import { createCredential } from "../../web/webauthn-store";
import { encodeCoseKey, WEBAUTHN_COOKIE_NAME } from "../../web/webauthn-ceremony";
import { demoModeEnabled } from "../../services/demo-sweep";
import { enqueueMailOutbox } from "../../services/mail/outbox";
import {
  MAIL_RESEND_LIMIT_SECONDS,
  RESET_PWD_CODE_LIVES_FRIENDLY,
} from "../../services/mail/reset-notify";
import { auditEvents, emailAddresses, emailOutbox, externalLoginUsers, loginSources, sessions, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  mintSession,
  MUST_CHANGE_PASSWORD_PATH,
  REMEMBER_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  sessionRouter,
} from "../session";
import {
  ForgotPasswordPage,
  passwordResetLocale,
  renderForgotPasswordPage,
  resetWrongUserMessage,
  ResetPasswordPage,
} from "./password-reset";

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
 *  side-effect settles before assertions (session.test.ts's helper). An
 *  explicit `requestEnv` overrides the injected vars (the live-mail pins —
 *  the generated Env types MAIL_ENABLED as the example's literal, so the
 *  widened shape is the house cast pattern). */
async function request(path: string, init?: RequestInit, requestEnv?: Env): Promise<Response> {
  const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`${ORIGIN}${path}`, init), requestEnv ?? testEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** The live-mail env slice: MAIL_ENABLED="true" (the MailService!=nil
 *  posture) with a parseable MAIL_FROM. */
function liveMailEnv(): Env {
  const live: Env = { ...env };
  (live as { MAIL_ENABLED?: string }).MAIL_ENABLED = "true";
  (live as { MAIL_FROM?: string }).MAIL_FROM = "Gitea <gitea@test.local>";
  return live;
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
    "email_outbox",
    "sessions",
    "personal_access_tokens",
    "auth_failures",
    "two_factor",
    "webauthn_credentials",
    "audit_event",
    "external_login_user",
    "login_source",
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

  it("the policy re-check runs on the POST arm: below-minimum re-renders, a WEAK single-class password APPLIES at the default config, password stored (update.go:247-265; B-87's attributed cross-edit — upstream's unset PASSWORD_COMPLEXITY is checking OFF, security.go:209-218 + app.example.ini:503; the pre-B-87 all-classes arm mis-derived the default and the ARMED re-render shape pins in admin-t2.test.ts's knob battery)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const code = await mintCode(alice);

    const short = await request("/user/reset_password", form({ code, password: "sh0rt", retype: "sh0rt" }));
    expect(short.status).toBe(200);
    expect(await short.text()).toContain("Password length cannot be less than 8 characters.");

    const weak = await request("/user/reset_password", form({ code, password: "alllowercasepass", retype: "alllowercasepass" }));
    expect(weak.status).toBe(303);
    const after = await userRow(alice.id);
    // The weak-but-long password now APPLIES (the code consumed, the record
    // stored — the reset arm's normal success shape).
    expect(after.passwd).not.toBe("");
    expect(after.passwdHashAlgo).toBe("pbkdf2$50000$50");
    expect(await verifyUserTimeLimitCode(env.DB, "reset_password", code)).toBeNull();
  });

  it("the apply stores under the CONFIGURED spec: PASSWORD_HASH_ALGO=pbkdf2_v1 arms the reset route's SetPassword target to pbkdf2$10000$50 (B-87's route-glue half, sixth site — ResetPasswdPost's apply is UpdateAuth under the LOADED settings, password.go:203-207 + update.go:256-264 + security.go:175)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const oldPw = await seedPassword(alice, "previous horse battery staple");
    const code = await mintCode(alice);

    // The knob rides the helper's PER-REQUEST env override (the live-mail
    // pins' pattern — a fresh copy, so nothing to restore; app.fetch hands
    // this object to the handlers; the generated Env types the var as the
    // example's literal, so the widened assignment cast is the house shape).
    const specEnv: Env = { ...testEnv };
    (specEnv as { PASSWORD_HASH_ALGO?: string }).PASSWORD_HASH_ALGO = "pbkdf2_v1";
    const res = await request("/user/reset_password", form({ code, password: NEW_PASSWORD, retype: NEW_PASSWORD }), specEnv);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");

    const row = await userRow(alice.id);
    // The stored record is under the DEALIASED configured spec — NOT the
    // landed pbkdf2$50000$50 default (the route's env-resolution half; the
    // service-level store pins live in user-accounts.test.ts).
    expect(row.passwdHashAlgo).toBe("pbkdf2$10000$50");
    // Verified against the STORED algo only — a plain userSignInPassword
    // would rehash-on-login under the DEFAULT spec and rewrite the row
    // (the change-password battery's model).
    expect(await verifyPassword(NEW_PASSWORD, row.passwd, row.salt, row.passwdHashAlgo)).toBe(true);
    expect(await verifyPassword(oldPw, row.passwd, row.salt, row.passwdHashAlgo)).toBe(false);
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

// -----------------------------------------------------------------------------
// The wrong-user refusal (B-83 — commonResetPassword, password.go:144-146):
// a signed-in viewer opening ANOTHER account's reset link gets upstream's
// reset_password_wrong_user flash (auth.reset_password_wrong_user) and the
// reset does NOT apply. Both arms render tplResetPassword at 200 — the GET
// continues past the guard (ResetPasswd), the POST takes the `u == nil`
// arm (password.go:167-171) — and the POST stops BEFORE the TOTP consume
// (GetTwoFactorByUID precedes the guard upstream; the consume is
// ResetPasswdPost's business). The presented session is the doer probe;
// anonymous viewers keep the code as the sole authority (upstream-true).
// -----------------------------------------------------------------------------

/** A POST body with the signed-in viewer's session cookie riding along. */
const formAs = (cookieValue: string, fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    cookie: `${SESSION_COOKIE_NAME}=${cookieValue}`,
  },
  body: new URLSearchParams(fields).toString(),
});

const asViewer = (cookieValue: string): RequestInit => ({
  headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` },
});

const WRONG_USER_FLASH_FRAGMENT = "but the account recovery link is meant for";

describe("the wrong-user refusal (password.go:144-146, B-83)", () => {
  it("the flash text composes upstream's %s pair, safe against $ replacement patterns", () => {
    expect(resetWrongUserMessage("bob@example.com", "alice@example.com")).toBe(
      "You are signed in as bob@example.com, but the account recovery link is meant for alice@example.com",
    );
    expect(resetWrongUserMessage("$&x@evil.test", "a$1b@ok.test")).toBe(
      "You are signed in as $&x@evil.test, but the account recovery link is meant for a$1b@ok.test",
    );
  });

  it("GET: a signed-in viewer on ANOTHER account's link renders the reset page WITH the flash (ResetPasswd continues past the guard)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const bob = await seedUser("Bob", "bob@example.com");
    const code = await mintCode(alice);
    const bobCookie = await mintSession(env.DB, bob.id, { remember: false });

    const res = await request(`/user/reset_password?code=${code}`, asViewer(bobCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(resetWrongUserMessage("bob@example.com", "alice@example.com"));
    // The form still renders (upstream keeps Code in Data past the guard).
    expect(html).toContain(`name="code" value="${code}"`);
  });

  it("GET: the RIGHT-user viewer and the anonymous viewer render WITHOUT the flash (the guard does not apply)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const code = await mintCode(alice);
    const aliceCookie = await mintSession(env.DB, alice.id, { remember: false });

    const own = await request(`/user/reset_password?code=${code}`, asViewer(aliceCookie));
    expect(own.status).toBe(200);
    expect(await own.text()).not.toContain(WRONG_USER_FLASH_FRAGMENT);

    const anonymous = await request(`/user/reset_password?code=${code}`);
    expect(anonymous.status).toBe(200);
    expect(await anonymous.text()).not.toContain(WRONG_USER_FLASH_FRAGMENT);
  });

  it("POST: the refusal applies to the submit — 200 + flash, password UNTOUCHED, NO session minted, code unconsumed", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const bob = await seedUser("Bob", "bob@example.com");
    await seedPassword(alice, "previous horse battery staple");
    const code = await mintCode(alice);
    const before = await userRow(alice.id);
    const bobCookie = await mintSession(env.DB, bob.id, { remember: false });

    const res = await request(
      "/user/reset_password",
      formAs(bobCookie, { code, password: NEW_PASSWORD, retype: NEW_PASSWORD }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(resetWrongUserMessage("bob@example.com", "alice@example.com"));

    // NOTHING happened: the row is byte-identical (no apply), the passwd-bound
    // code still verifies (nothing consumed it — user.go:948-950's data hash
    // recomputes), and the only session row is Bob's own presented one (no
    // handleSignIn mint for anyone).
    const after = await userRow(alice.id);
    expect(after.passwd).toBe(before.passwd);
    expect(after.salt).toBe(before.salt);
    expect(await verifyUserTimeLimitCode(env.DB, "reset_password", code)).not.toBeNull();
    const sessionRows = await drizzle(env.DB).select().from(sessions).all();
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.userId).toBe(bob.id);
  });

  it("a TOTP-enrolled target: the refusal renders WITH the passcode field and the enrollment is never consumed", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const bob = await seedUser("Bob", "bob@example.com");
    const { scratchToken } = await seedTotp(alice);
    const code = await mintCode(alice);
    const bobCookie = await mintSession(env.DB, bob.id, { remember: false });

    const res = await request(
      "/user/reset_password",
      formAs(bobCookie, { code, password: NEW_PASSWORD, retype: NEW_PASSWORD, scratch_code: scratchToken }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(resetWrongUserMessage("bob@example.com", "alice@example.com"));
    // has_two_factor precedes the guard upstream (password.go:131-143) — the
    // refusal render keeps the passcode field.
    expect(html).toContain('name="passcode"');

    // The VALID scratch token was NOT consumed by the refused POST: the same
    // link resets fine anonymously right after (scratch verify is read-only;
    // the burn lives past the apply).
    const replay = await request(
      "/user/reset_password",
      form({ code, password: NEW_PASSWORD, retype: NEW_PASSWORD, scratch_code: scratchToken }),
    );
    expect(replay.status).toBe(303);
    expect(await userSignInPassword(env.DB, "alice", NEW_PASSWORD)).toMatchObject({ ok: true });
  });

  it("the RIGHT-user POST still applies and signs in (the guard's doer==target early-out)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const code = await mintCode(alice);
    const aliceCookie = await mintSession(env.DB, alice.id, { remember: false });

    const res = await request(
      "/user/reset_password",
      formAs(aliceCookie, { code, password: NEW_PASSWORD, retype: NEW_PASSWORD }),
    );
    expect(res.status).toBe(303);
    expect(await userSignInPassword(env.DB, "alice", NEW_PASSWORD)).toMatchObject({ ok: true });
  });
});

// -----------------------------------------------------------------------------
// The forgot-REQUEST arm's LIVE render states (B-84 — forgot_passwd.tmpl's
// request/sent arms over the reduced house render)
// -----------------------------------------------------------------------------

const SENT_PROMPT_FRAGMENT = "A confirmation email has been sent to";

describe("the live forgot page renders (forgot_passwd.tmpl's arms, B-84)", () => {
  it("the request state renders the email form with the prefill, no disabled message", () => {
    const html = renderToString(
      <ForgotPasswordPage ctx={ctx} arm={{ state: "request", email: "alice@example.com" }} />,
    );
    expect(html).toContain('action="/user/forgot_password"');
    expect(html).toContain('name="email"');
    expect(html).toContain('value="alice@example.com"');
    expect(html).toContain('type="email"');
    expect(html).toContain("Email Address");
    expect(html).toContain(passwordResetLocale.send_reset_mail);
    expect(html).not.toContain(passwordResetLocale.reset_disabled);
    expect(html).not.toContain(SENT_PROMPT_FRAGMENT);
    // The field div carries no error class without Err_Email (password.go:82).
    expect(html).not.toContain('field error"');
  });

  it("the non-local refusal: Err_Email's field class + the non_local_account flash (password.go:81-85)", () => {
    const html = renderToString(
      <ForgotPasswordPage
        ctx={ctx}
        arm={{ state: "request", email: "ldap@x.test", errEmail: true, error: passwordResetLocale.non_local_account }}
      />,
    );
    expect(html).toContain('field error"');
    expect(html).toContain(passwordResetLocale.non_local_account);
    expect(html).toContain('name="email"');
  });

  it("the sent state: the mail-sent prompt with the SUBMITTED email bolded and the 3-hour lives, NO form", () => {
    const html = renderToString(
      <ForgotPasswordPage ctx={ctx} arm={{ state: "sent", email: "ghost@x.test", lives: RESET_PWD_CODE_LIVES_FRIENDLY }} />,
    );
    expect(html).toContain(SENT_PROMPT_FRAGMENT);
    expect(html).toContain(`<b>ghost@x.test</b>`);
    expect(html).toContain("3 hours");
    expect(html).toContain("to complete the account recovery process");
    // IsResetSent wins the template chain — no request form, no disabled note.
    expect(html).not.toContain("<form");
    expect(html).not.toContain(passwordResetLocale.reset_disabled);
  });

  it("renderForgotPasswordPage threads the arm state (the wrapper)", () => {
    expect(renderForgotPasswordPage(ctx, { state: "sent", email: "a@b.test", lives: "3 hours" })).toContain(
      SENT_PROMPT_FRAGMENT,
    );
    expect(renderForgotPasswordPage(ctx)).toContain(passwordResetLocale.reset_disabled);
  });

  it("ResetPasswordPage's action mirrors {{.Link}} — the served path (context.go:59): /user/recover_account posts back there", () => {
    const html = renderToString(
      <ResetPasswordPage ctx={ctx} code="abc" error={null} twoFactor={false} action="/user/recover_account" />,
    );
    expect(html).toContain('action="/user/recover_account"');
    const def = renderToString(<ResetPasswordPage ctx={ctx} code="abc" error={null} twoFactor={false} />);
    expect(def).toContain('action="/user/reset_password"');
  });
});

// -----------------------------------------------------------------------------
// POST/GET /user/forgot_password — the LIVE ladder (B-84, password.go:53-106
// over MAIL_ENABLED="true"): lookup → org fold → non-local refusal → 180 s
// resend throttle → code mint + outbox mail + audit → the anti-enumeration
// sent render.
// -----------------------------------------------------------------------------

describe("the live forgot-REQUEST ladder (password.go:53-106, B-84)", () => {
  it("GET with a mailer renders the REQUEST form (IsResetRequest), honoring the ?email= prefill (password.go:46)", async () => {
    const res = await request("/user/forgot_password", undefined, liveMailEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="email"');
    expect(html).toContain(passwordResetLocale.send_reset_mail);
    expect(html).not.toContain(passwordResetLocale.reset_disabled);
    expect(html).not.toContain(SENT_PROMPT_FRAGMENT);

    const prefilled = await request("/user/forgot_password?email=pri%40x.test", undefined, liveMailEnv());
    expect(await prefilled.text()).toContain('value="pri@x.test"');
  });

  it("an UNKNOWN account answers the sent render at 200 — the silent arm, NOTHING enqueued, NO audit row (password.go:69-74)", async () => {
    const res = await request("/user/forgot_password", form({ email: "ghost@x.test" }), liveMailEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(SENT_PROMPT_FRAGMENT);
    expect(html).toContain("<b>ghost@x.test</b>");
    expect(html).toContain("3 hours");
    expect(await drizzle(env.DB).select().from(emailOutbox).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(auditEvents).all()).toHaveLength(0);
  });

  it("ANTI-ENUMERATION: the SAME submission answers BYTE-IDENTICALLY whether the account exists or not (password.go:69-74 vs :103-105)", async () => {
    const alice = await seedUser("Alice", "pri@x.test");
    const known = await request("/user/forgot_password", form({ email: "pri@x.test" }), liveMailEnv());
    expect(known.status).toBe(200);
    const bodyA = await known.text();
    expect(bodyA).toContain(SENT_PROMPT_FRAGMENT);

    // The account vanishes; the identical submission must render the identical bytes.
    await drizzle(env.DB).delete(users).where(eq(users.id, alice.id));
    const unknown = await request("/user/forgot_password", form({ email: "pri@x.test" }), liveMailEnv());
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toBe(bodyA);
  });

  it("the EXISTS branch mints the code + enqueues the reset mail (the outbox row, upstream Info/To/subject, fresh code per send)", async () => {
    const alice = await seedUser("Alice", "pri@x.test");
    await seedPassword(alice);

    const res = await request("/user/forgot_password", form({ email: "pri@x.test" }), liveMailEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(SENT_PROMPT_FRAGMENT);

    const rows = await drizzle(env.DB).select().from(emailOutbox).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.info).toBe(`UID: ${alice.id}, recover account`); // sendUserMail's fmt, mail_user.go:49
    expect(row.toAddr).toBe("pri@x.test"); // u.EmailTo() — the PRIMARY address
    expect(row.subject).toBe("Recover your account"); // mail.reset_password, no prefix in the draft
    expect(row.fromAddress).toBe("gitea@test.local");
    expect(row.fromDisplayName).toBe("Gitea");
    expect(row.dedupeKey).toBeNull(); // every allowed POST sends a FRESH code
    expect(row.bodyHtml).toContain("/user/recover_account?code=");
    expect(row.bodyHtml).toContain("Hi <b>Alice</b>,"); // mail.hi_user_x over the display name
    expect(row.bodyHtml).toContain("within <b>3 hours</b>:");
    // The link's code VERIFIES against the row (the SAME HMAC machinery the
    // reset-COMPLETE arm verifies — user.go:965-973).
    const code = row.bodyHtml.match(/recover_account\?code=([0-9a-f]+)"/)?.[1];
    expect(code).toBeDefined();
    expect((await verifyUserTimeLimitCode(env.DB, "reset_password", code!))?.id).toBe(alice.id);
    // …and the TTL is the 180-minute window (service.go:147's default; the
    // verify's now < start+minutes arm, tool.go:53).
    const mintedAt = Date.now();
    expect(
      (await verifyUserTimeLimitCode(env.DB, "reset_password", code!, { now: new Date(mintedAt + 179 * 60_000) }))?.id,
    ).toBe(alice.id);
    expect(
      await verifyUserTimeLimitCode(env.DB, "reset_password", code!, { now: new Date(mintedAt + 181 * 60_000) }),
    ).toBeNull();
  });

  it("the audit row lands on the exists branch (user:password:resetrequest, actor=scope=the target — password.go:97's RecordAs)", async () => {
    const alice = await seedUser("Alice", "pri@x.test");
    await request("/user/forgot_password", form({ email: "pri@x.test" }), liveMailEnv());

    const rows = await drizzle(env.DB).select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("user:password:resetrequest"); // action.go:77, verbatim
    expect(row.actorId).toBe(alice.id);
    expect(row.scopeId).toBe(String(alice.id));
    expect(row.scopeName).toBe("Alice");
    expect(row.origin).toBe("ui");
    expect(row.ipAddress).toBe("unknown"); // no cf-connecting-ip on the synthetic request
    expect(row.message).toContain("Requested password reset for user Alice");
  });

  it("an ORG submission folds into the silent arm (password.go:66-68's !IsIndividual ⇒ not-exist) — sent bytes, no mail, no audit", async () => {
    await drizzle(env.DB).insert(users).values({
      username: "TheOrg",
      usernameLower: "theorg",
      email: "org@x.test",
      type: "org",
      createdAt: new Date(),
    });
    const res = await request("/user/forgot_password", form({ email: "org@x.test" }), liveMailEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(SENT_PROMPT_FRAGMENT);
    expect(html).toContain("<b>org@x.test</b>");
    expect(await drizzle(env.DB).select().from(emailOutbox).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(auditEvents).all()).toHaveLength(0);
  });

  it("a SECONDARY address resolves the account but the mail rides the PRIMARY (GetUserByEmail's email_address arm + EmailTo parity)", async () => {
    const alice = await seedUser("Alice", "pri@x.test");
    await drizzle(env.DB)
      .insert(emailAddresses)
      .values({ userId: alice.id, email: "sec@x.test", lowerEmail: "sec@x.test", isActivated: true, isPrimary: false });

    const res = await request("/user/forgot_password", form({ email: "sec@x.test" }), liveMailEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    // The response echoes ONLY the submission — no primary-address, no
    // username leak (the anti-enumeration render's data shape).
    expect(html).toContain("<b>sec@x.test</b>");
    expect(html).not.toContain("pri@x.test");
    expect(html).not.toContain("Alice");

    const rows = await drizzle(env.DB).select().from(emailOutbox).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toAddr).toBe("pri@x.test"); // u.EmailTo() — upstream mails the primary
  });

  it("the RESEND throttle: a second POST inside 180 s re-renders the FORM with no message, no mail, no audit (password.go:87-91)", async () => {
    await seedUser("Alice", "pri@x.test");
    await request("/user/forgot_password", form({ email: "pri@x.test" }), liveMailEnv());
    expect(await drizzle(env.DB).select().from(emailOutbox).all()).toHaveLength(1);

    const second = await request("/user/forgot_password", form({ email: "pri@x.test" }), liveMailEnv());
    expect(second.status).toBe(200);
    const html = await second.text();
    // IsResetRequest stays in Data — the template's (dead) ResendLimited
    // branch never wins the chain, the form re-renders silently.
    expect(html).toContain('name="email"');
    expect(html).not.toContain(SENT_PROMPT_FRAGMENT);
    expect(await drizzle(env.DB).select().from(emailOutbox).all()).toHaveLength(1);
    expect(await drizzle(env.DB).select().from(auditEvents).all()).toHaveLength(1);
  });

  it("the throttle EXPIRES after 180 s: the ledger row outside the window arms nothing, the mail sends again (password.go:99's TTL)", async () => {
    const alice = await seedUser("Alice", "pri@x.test");
    // A ledger row from 181 s ago (MailResendLimit's Put TTL, password.go:99).
    await enqueueMailOutbox(
      { DB: env.DB },
      {
        info: `UID: ${alice.id}, recover account`,
        fromAddress: "gitea@test.local",
        fromDisplayName: "Gitea",
        toAddr: "pri@x.test",
        replyTo: null,
        subject: "Recover your account",
        bodyHtml: "stale",
        headers: null,
        dedupeKey: null,
      },
      { now: new Date(Date.now() - (MAIL_RESEND_LIMIT_SECONDS + 1) * 1000) },
    );

    const res = await request("/user/forgot_password", form({ email: "pri@x.test" }), liveMailEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SENT_PROMPT_FRAGMENT);
    const rows = await drizzle(env.DB).select().from(emailOutbox).all();
    expect(rows).toHaveLength(2); // the stale row + the fresh mail
    expect(rows.filter((r) => r.bodyHtml !== "stale")).toHaveLength(1);
  });

  it("the NON-LOCAL refusal: an external (non-OAuth2) link flashes non_local_account with Err_Email, nothing sent (password.go:81-85)", async () => {
    const alice = await seedUser("Alice", "ldap@x.test");
    const src = (
      await drizzle(env.DB)
        .insert(loginSources)
        .values({
          type: 2, // LDAP — NOT Plain(0)/OAuth2(6): the refused class
          name: "corp-ldap",
          isActive: true,
          cfg: "{}",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: loginSources.id })
    )[0]!;
    await drizzle(env.DB).insert(externalLoginUsers).values({
      externalId: "u-1",
      loginSourceId: src.id,
      userId: alice.id,
      provider: "ldap",
    });

    const res = await request("/user/forgot_password", form({ email: "ldap@x.test" }), liveMailEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(passwordResetLocale.non_local_account);
    expect(html).toContain('field error"');
    expect(html).toContain('value="ldap@x.test"'); // the submission stays prefilled
    expect(html).not.toContain(SENT_PROMPT_FRAGMENT);
    expect(await drizzle(env.DB).select().from(emailOutbox).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(auditEvents).all()).toHaveLength(0);
  });

  it("the MUST-CHANGE gate precedes the live ladder: a flagged session's POST redirects, no mail, no audit (the middleware order)", async () => {
    const alice = await seedUser("Alice", "pri@x.test");
    await drizzle(env.DB).update(users).set({ mustChangePassword: true }).where(eq(users.id, alice.id));
    const cookie = await mintSession(env.DB, alice.id, { remember: false });

    const res = await request(
      "/user/forgot_password",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
        body: "email=pri@x.test",
      },
      liveMailEnv(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(MUST_CHANGE_PASSWORD_PATH);
    expect(await drizzle(env.DB).select().from(emailOutbox).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(auditEvents).all()).toHaveLength(0);
  });

  it("a CROSS-ORIGIN POST is rejected before the ladder (the same-origin guard — upstream's CSRF middleware precedence)", async () => {
    await seedUser("Alice", "pri@x.test");
    const res = await request(
      "/user/forgot_password",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test" }, body: "email=pri@x.test" },
      liveMailEnv(),
    );
    expect(res.status).toBe(403);
    expect(await drizzle(env.DB).select().from(emailOutbox).all()).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// The /user/recover_account alias (web.go:761-762 — the reset MAIL's link
// binds the SAME handlers; the form's {{.Link}} posts back to this path).
// -----------------------------------------------------------------------------

describe("/user/recover_account — the reset handlers' second binding (B-84)", () => {
  it("GET renders the reset form WITH the code and the recover-path action (the mail link's landing)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const code = await mintCode(alice);

    const res = await request(`/user/recover_account?code=${code}`, undefined, liveMailEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`name="code" value="${code}"`);
    expect(html).toContain('action="/user/recover_account"'); // {{.Link}} — the served path
    expect(html).not.toContain(passwordResetLocale.invalid_code);
  });

  it("POST applies the reset through the SAME ladder (303 /, the new password signs in)", async () => {
    const alice = await seedUser("Alice", "alice@example.com");
    const code = await mintCode(alice);

    const res = await request(
      "/user/recover_account",
      form({ code, password: NEW_PASSWORD, retype: NEW_PASSWORD }),
      liveMailEnv(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(await userSignInPassword(env.DB, "alice", NEW_PASSWORD)).toMatchObject({ ok: true });
  });

  it("GET /user/recover_account without a code answers the SAME invalid-code render (one handler, both paths)", async () => {
    const res = await request("/user/recover_account", undefined, liveMailEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(passwordResetLocale.invalid_code);
  });
});

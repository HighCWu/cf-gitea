/**
 * The MUST-CHANGE password page's WEB wire (SPEC-0002 §6.3 — the PWD-4
 * enforcement half's web arm): the module-suite pattern
 * (password-reset.test.tsx) over the uiRouter mounts. DOM contract over
 * hono/jsx renderToString, then the route arms through the locally-mounted
 * app (session.test.ts's posture: sessionRouter + uiRouter at "/", the
 * synthetic manifest fixture), seeds through applyAuthD1Migrations + direct
 * service calls.
 *
 * Pins (upstream routers/web/auth/password.go:267-327 over web.go:637-638
 * at the submodule):
 *   - the GET page is reqSignIn-gated (web.go's /user/settings group) and
 *     the middleware-equivalent gate carves THIS path out of the tree-wide
 *     redirect (web.go:198's literal);
 *   - a signed-in user WITHOUT the need is redirected to "/" — web.go:
 *     206-210's else-if ("make sure that the form cannot be accessed by
 *     users who don't need this");
 *   - the POST applies MustChangePasswordPost's arms (password.go:277-327):
 *     NO old-password field (forms/user_form.go:92-96 — the live session is
 *     the credential), the retype check, the validation ladder, the SHARED
 *     UpdateAuth arm with the MustChangePassword=false clear
 *     (password.go:298-301), success → redirectAfterAuth's default "/" and
 *     failures re-render at 200;
 *   - the tree-wide gate (web.go:197-206): every OTHER uiRouter page a
 *     flagged session visits 303s onto the change page — the sessionRouter
 *     gate arms are session.test.ts's.
 */

import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { renderToString } from "hono/jsx/dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { userSignInPassword } from "../../auth/password-auth";
import { newPasswordRecord, verifyPassword } from "../../auth/password";
import { changeOwnPassword } from "../../services/user-accounts";
import { auditEvents, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { uiRouter, type UiAssetsFetcher } from "../index";
import { lookupValidSession, mintSession, sessionRouter, sessionSetCookie } from "../session";
import { changePasswordLocale, MustChangePasswordPage, renderMustChangePasswordPage } from "./change-password";

// --- fixtures (password-reset.test.tsx / session.test.ts posture) -------------

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
// an armed local DEMO_MODE shifts every BaseLayout render).
(env as { DEMO_MODE?: string }).DEMO_MODE = undefined;

const fakeAssets: UiAssetsFetcher = {
  fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })),
};
const testEnv: Omit<Env, "ASSETS"> & { ASSETS: UiAssetsFetcher } = { ...env, ASSETS: fakeAssets };

// The local app: the production registration shape — BOTH routers at "/"
// (the change_password routes live on the uiRouter; the gate's session
// arms are session.test.ts's).
const app = new Hono<{ Bindings: Env }>();
app.route("/", sessionRouter);
app.route("/", uiRouter);

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
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    body: new URLSearchParams(fields).toString(),
  };
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // system_keystore NOT wiped (the module caches persist per-file —
  // session.test.ts's posture).
  for (const table of ["sessions", "email_addresses", "audit_event", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- seeds -------------------------------------------------------------------

interface SeedUser {
  id: number;
  username: string;
  usernameLower: string;
}

async function seedUser(username: string, options: { password?: string } = {}): Promise<SeedUser> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({ username, usernameLower: username.toLowerCase(), createdAt: new Date() })
    .returning({ id: users.id, username: users.username, usernameLower: users.usernameLower })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  if (options.password !== undefined) {
    const record = await newPasswordRecord(options.password);
    await drizzle(env.DB)
      .update(users)
      .set({ passwd: record.passwd, salt: record.salt, passwdHashAlgo: record.passwdHashAlgo })
      .where(eq(users.id, row.id))
      .run();
  }
  return row;
}

/** The admin-set flag (the admin-API arm landed in 50dce36; the clears are
 *  the change arms under test). */
async function flagMustChange(userId: number): Promise<void> {
  await drizzle(env.DB).update(users).set({ mustChangePassword: true }).where(eq(users.id, userId)).run();
}

async function userRow(id: number): Promise<typeof users.$inferSelect> {
  const row = await drizzle(env.DB).select().from(users).where(eq(users.id, id)).get();
  if (row === undefined) throw new Error(`user ${id} missing`);
  return row;
}

/** A signed-in session cookie directive for `user`. */
async function loginAs(user: SeedUser): Promise<string> {
  return sessionSetCookie(await mintSession(env.DB, user.id, { remember: false }), false);
}

/** Passes the all-classes default policy (lower + upper + digit + spec). */
const NEW_PASSWORD = "Fresh-Horse-Battery-Staple-42";
const TEMP_PASSWORD = "temp horse battery staple";

// -----------------------------------------------------------------------------
// The module-level DOM contract (change_passwd.tmpl + change_passwd_inner.tmpl)
// -----------------------------------------------------------------------------

describe("the page renders (change_passwd.tmpl's reduced form)", () => {
  it("MustChangePasswordPage renders the header + the new-password pair, NO old-password field (forms/user_form.go:92-96)", () => {
    const html = renderToString(<MustChangePasswordPage ctx={ctx} error={null} />);
    expect(html).toContain(changePasswordLocale.must_change_password);
    expect(html).toContain(changePasswordLocale.change_password);
    expect(html).toContain('action="/user/settings/change_password"');
    expect(html).toContain('name="password"');
    expect(html).toContain('name="retype"');
    expect(html).toContain('autocomplete="new-password"');
    expect(html).not.toContain('name="old_password"');
    expect(html).not.toContain('name="remember"');
  });

  it("the error flash renders above the form (RenderWithErrDeprecated's slot)", () => {
    const html = renderToString(<MustChangePasswordPage ctx={ctx} error="The passwords do not match." />);
    expect(html).toContain("The passwords do not match.");
    expect(html).toContain('name="password"');
  });

  it("renderMustChangePasswordPage is the string wrapper of the page", () => {
    expect(renderMustChangePasswordPage({ ctx, error: null })).toContain(changePasswordLocale.change_password);
  });
});

// -----------------------------------------------------------------------------
// GET /user/settings/change_password — the page arms (web.go:637 + 206-210)
// -----------------------------------------------------------------------------

describe("GET /user/settings/change_password", () => {
  it("a flagged session renders the form at 200 (the gate's carve-out — web.go:198's literal)", async () => {
    const alice = await seedUser("Alice", { password: TEMP_PASSWORD });
    await flagMustChange(alice.id);
    const res = await request("/user/settings/change_password", { headers: { cookie: await loginAs(alice) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(changePasswordLocale.change_password);
    expect(html).toContain('name="password"');
    expect(html).not.toContain('name="old_password"');
  });

  it("an UNFLAGGED session is redirected to / (web.go:206-210 — the form cannot be accessed by users who don't need this)", async () => {
    const alice = await seedUser("Alice", { password: TEMP_PASSWORD });
    const res = await request("/user/settings/change_password", { headers: { cookie: await loginAs(alice) } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("an anonymous visitor is redirected onto the login round-trip (the reqSignIn group's RedirectForLogin)", async () => {
    const res = await request("/user/settings/change_password");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/user/settings/change_password")}`,
    );
  });
});

// -----------------------------------------------------------------------------
// POST /user/settings/change_password — MustChangePasswordPost (password.go:
// 277-327) over the SHARED UpdateAuth arm (password.go:298-301)
// -----------------------------------------------------------------------------

describe("POST /user/settings/change_password", () => {
  it("the happy path: 303 /, the flag CLEARED, the password applied, the (non-remember) session survives", async () => {
    const alice = await seedUser("Alice", { password: TEMP_PASSWORD });
    await flagMustChange(alice.id);
    const cookie = await mintSession(env.DB, alice.id, { remember: false });

    const res = await request("/user/settings/change_password", {
      ...form({ password: NEW_PASSWORD, retype: NEW_PASSWORD }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: sessionSetCookie(cookie, false) },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");

    const row = await userRow(alice.id);
    expect(row.mustChangePassword).toBe(false);
    expect(await userSignInPassword(env.DB, "alice", NEW_PASSWORD)).toMatchObject({ ok: true });
    expect((await userSignInPassword(env.DB, "alice", TEMP_PASSWORD)).ok).toBe(false);
    // The live session continues (the invalidation is remember-me rows ONLY
    // — upstream DeleteAuthTokensByUserID).
    expect(await lookupValidSession(env.DB, cookie)).not.toBeNull();
  });

  it("the user:password row stamps the request's CF-Connecting-IP; the credential stays null (AUDITCTX — the applyPasswordReset arm's ui submit, the session ride)", async () => {
    const alice = await seedUser("Alice", { password: TEMP_PASSWORD });
    await flagMustChange(alice.id);
    const cookie = await mintSession(env.DB, alice.id, { remember: false });

    const res = await request("/user/settings/change_password", {
      ...form({ password: NEW_PASSWORD, retype: NEW_PASSWORD }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        cookie: sessionSetCookie(cookie, false),
        "CF-Connecting-IP": "203.0.113.9",
      },
    });
    expect(res.status).toBe(303);

    // The row emits detached (`void emitAudit`) — poll, the
    // middleware-wire.test.ts posture for fire-and-forget rows.
    await vi.waitFor(async () => {
      const rows = await drizzle(env.DB).select().from(auditEvents).orderBy(asc(auditEvents.id)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "user:password",
        actorId: alice.id,
        actorCredential: null,
        scopeType: "user",
        scopeId: String(alice.id),
        origin: "ui",
        ipAddress: "203.0.113.9",
      });
    });
  });

  it("the apply stores under the CONFIGURED spec: PASSWORD_HASH_ALGO=pbkdf2_v1 arms the route's SetPassword target to pbkdf2$10000$50 (B-87's route-glue half — the shared UpdateAuth arm reads the deploy config, update.go:256-264 + security.go:175)", async () => {
    const alice = await seedUser("Alice", { password: TEMP_PASSWORD });
    await flagMustChange(alice.id);

    // The knob slice rides the harness env (the session.test.ts pattern —
    // app.fetch passes this object to the handlers).
    const specEnv = testEnv as Omit<Env, "PASSWORD_HASH_ALGO"> & { PASSWORD_HASH_ALGO?: string };
    specEnv.PASSWORD_HASH_ALGO = "pbkdf2_v1";
    try {
      const res = await request("/user/settings/change_password", {
        ...form({ password: NEW_PASSWORD, retype: NEW_PASSWORD }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: await loginAs(alice) },
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    } finally {
      delete specEnv.PASSWORD_HASH_ALGO;
    }

    const row = await userRow(alice.id);
    // The stored record is under the DEALIASED configured spec — NOT the
    // landed default (the service-level store pins live in
    // user-accounts.test.ts; THIS is the route's env-resolution half).
    expect(row.passwdHashAlgo).toBe("pbkdf2$10000$50");
    expect(row.mustChangePassword).toBe(false);
    // Verify through the STORED algo only (a plain userSignInPassword would
    // rehash-on-login under the DEFAULT spec and rewrite the row).
    expect(await verifyPassword(NEW_PASSWORD, row.passwd, row.salt, row.passwdHashAlgo)).toBe(true);
    expect(await verifyPassword(TEMP_PASSWORD, row.passwd, row.salt, row.passwdHashAlgo)).toBe(false);
  });

  it("the retype mismatch re-renders at 200 with the match message, password + flag UNTOUCHED (password.go:292-296)", async () => {
    const alice = await seedUser("Alice", { password: TEMP_PASSWORD });
    await flagMustChange(alice.id);
    const before = await userRow(alice.id);

    const res = await request("/user/settings/change_password", {
      ...form({ password: NEW_PASSWORD, retype: "different staple 42" }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: await loginAs(alice) },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The passwords do not match.");
    const after = await userRow(alice.id);
    expect(after.passwd).toBe(before.passwd);
    expect(after.salt).toBe(before.salt);
    expect(after.mustChangePassword).toBe(true);
  });

  it("the policy ladder re-renders at 200, password untouched (password.go:304-306's ErrMinLength arm)", async () => {
    const alice = await seedUser("Alice", { password: TEMP_PASSWORD });
    await flagMustChange(alice.id);
    const before = await userRow(alice.id);

    const res = await request("/user/settings/change_password", {
      ...form({ password: "sh0rt", retype: "sh0rt" }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: await loginAs(alice) },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Password length cannot be less than 8 characters.");
    const after = await userRow(alice.id);
    expect(after.passwd).toBe(before.passwd);
    expect(after.mustChangePassword).toBe(true);
  });

  it("an UNFLAGGED session's POST is redirected to / (web.go:206-210 at the middleware-equivalent layer — the race re-enters here)", async () => {
    const alice = await seedUser("Alice", { password: TEMP_PASSWORD });
    const before = await userRow(alice.id);
    const res = await request("/user/settings/change_password", {
      ...form({ password: NEW_PASSWORD, retype: NEW_PASSWORD }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: await loginAs(alice) },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const after = await userRow(alice.id);
    expect(after.passwd).toBe(before.passwd);
    expect(after.salt).toBe(before.salt);
  });
});

// -----------------------------------------------------------------------------
// The tree-wide gate (web.go:197-206) over the uiRouter pages
// -----------------------------------------------------------------------------

describe("the gate redirects every other uiRouter page for a flagged session", () => {
  it("GET /user/settings/account answers 303 onto the change page; unflagged renders", async () => {
    const alice = await seedUser("Alice");
    await flagMustChange(alice.id);
    const gated = await request("/user/settings/account", { headers: { cookie: await loginAs(alice) } });
    expect(gated.status).toBe(303);
    expect(gated.headers.get("location")).toBe("/user/settings/change_password");

    const bob = await seedUser("Bob");
    const open = await request("/user/settings/account", { headers: { cookie: await loginAs(bob) } });
    expect(open.status).toBe(200);
  });

  it("a real page gates ahead of its handler (the arm lives in resolveUiSession; /explore's bare redirect precedes any session work upstream-faithfully — web.go's middleware is the only session-aware hop there)", async () => {
    const alice = await seedUser("Alice");
    await flagMustChange(alice.id);
    const res = await request("/explore/repos", { headers: { cookie: await loginAs(alice) } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/user/settings/change_password");
  });
});

// -----------------------------------------------------------------------------
// The settings-tab arm clears the flag too (account.go:78 — changeOwnPassword).
// The WIRE cannot reach it while flagged (upstream's own middleware redirects
// a flagged doer away from the whole settings tree — the gate precedence
// above), so the arm's clear is pinned at the SERVICE level directly, with
// the wire shape of the precedence kept as its own assertion.
// -----------------------------------------------------------------------------

describe("the settings-tab arm's mcp clear (account.go:78 — changeOwnPassword)", () => {
  it("the service arm clears the flag on any own-password change", async () => {
    const alice = await seedUser("Alice", { password: TEMP_PASSWORD });
    await flagMustChange(alice.id);

    const outcome = await changeOwnPassword(env.DB, alice.id, {
      oldPassword: TEMP_PASSWORD,
      newPassword: NEW_PASSWORD,
      retype: NEW_PASSWORD,
    });
    expect(outcome.outcome).toBe("changed");
    const row = await userRow(alice.id);
    expect(row.mustChangePassword).toBe(false);
    expect(await userSignInPassword(env.DB, "alice", NEW_PASSWORD)).toMatchObject({ ok: true });
  });

  it("the WIRE keeps upstream's gate precedence: a flagged session's settings POST redirects to the change page (web.go:197-206 — the settings arm is unreachable while flagged)", async () => {
    const alice = await seedUser("Alice", { password: TEMP_PASSWORD });
    await flagMustChange(alice.id);

    const res = await request("/user/settings/account", {
      ...form({ old_password: TEMP_PASSWORD, password: NEW_PASSWORD, retype: NEW_PASSWORD }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: await loginAs(alice) },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/user/settings/change_password");
    // Nothing applied — the gate preceded the handler (upstream's own shape:
    // verifyAuthWithOptionsWeb precedes AccountPost the same way).
    const before = await userRow(alice.id);
    expect(before.mustChangePassword).toBe(true);
    expect(await userSignInPassword(env.DB, "alice", TEMP_PASSWORD)).toMatchObject({ ok: true });
  });

  it("the settings route stores under the CONFIGURED spec: an UNFLAGGED session's POST /user/settings/account under PASSWORD_HASH_ALGO=pbkdf2_v1 writes pbkdf2$10000$50 (B-87's route-glue half — the changeOwnPassword caller threads the env-resolved spec, account.go:78's UpdateAuth reads the settings)", async () => {
    const alice = await seedUser("Alice", { password: TEMP_PASSWORD }); // NOT flagged — the settings tree is reachable

    const specEnv = testEnv as Omit<Env, "PASSWORD_HASH_ALGO"> & { PASSWORD_HASH_ALGO?: string };
    specEnv.PASSWORD_HASH_ALGO = "pbkdf2_v1";
    try {
      const res = await request("/user/settings/account", {
        ...form({ old_password: TEMP_PASSWORD, password: NEW_PASSWORD, retype: NEW_PASSWORD }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: await loginAs(alice) },
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/user/settings/account");
    } finally {
      delete specEnv.PASSWORD_HASH_ALGO;
    }

    const row = await userRow(alice.id);
    expect(row.passwdHashAlgo).toBe("pbkdf2$10000$50");
    // Verify through the STORED algo (a plain userSignInPassword would
    // rehash-on-login under the DEFAULT spec and rewrite the row).
    expect(await verifyPassword(NEW_PASSWORD, row.passwd, row.salt, row.passwdHashAlgo)).toBe(true);
    expect(await verifyPassword(TEMP_PASSWORD, row.passwd, row.salt, row.passwdHashAlgo)).toBe(false);
  });

  it("the user:password row stamps the request's CF-Connecting-IP; the credential stays null (AUDITCTX — the changeOwnPassword arm's ui submit, the session ride)", async () => {
    const alice = await seedUser("Alice", { password: TEMP_PASSWORD }); // NOT flagged — the settings tree is reachable

    const res = await request("/user/settings/account", {
      ...form({ old_password: TEMP_PASSWORD, password: NEW_PASSWORD, retype: NEW_PASSWORD }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        cookie: await loginAs(alice),
        "CF-Connecting-IP": "198.51.100.7",
      },
    });
    expect(res.status).toBe(303);

    // The row emits detached (`void emitAudit`) — poll, the
    // middleware-wire.test.ts posture for fire-and-forget rows.
    await vi.waitFor(async () => {
      const rows = await drizzle(env.DB).select().from(auditEvents).orderBy(asc(auditEvents.id)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "user:password",
        actorId: alice.id,
        actorCredential: null,
        scopeType: "user",
        scopeId: String(alice.id),
        origin: "ui",
        ipAddress: "198.51.100.7",
      });
    });
  });
});

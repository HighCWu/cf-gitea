/**
 * SPEC-0010 §6 first-run suite — the admin-init window + ALLOW_SIGNUP
 * registration, on real D1 (workerd), exercising the handlers directly
 * (the house pattern — the module lands complete-but-unmounted, see the
 * first-run.ts HANDOFF NOTE):
 *
 * - The gate: `allowSignup` absent-safety (false unless explicitly on) and
 *   the 404-hiding of GET/POST /user/sign_up while closed.
 * - The admin-init happy path: empty table → is_admin row + minted session
 *   + Set-Cookie, the viewer carries isAdmin, and the window is gone after
 *   (GET /install 303s, POST re-renders the already-initialized verdict).
 * - THE RACE: two concurrent first-submissions → exactly one admin (the
 *   count-guarded insert's changes==0 arm), the loser's clear verdict.
 * - The non-empty table: no form, the route refuses, no row is created.
 * - Signup on/off, the shared validation ladder (usable-username/email/
 *   retype reuse, taken name/email), the live-redirect consumption, and
 *   the session integration: the init-created admin logs in with a PAT and
 *   resolveViewer carries isAdmin (§2.5 seam).
 * - The login page extension: default render (no panel, no link — the
 *   committed golden stays byte-stable), the panel, the register link.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";

// The demo render gate pinned to the ABSENT arm (the goldens unit's
// diagnosis: an armed local DEMO_MODE shifts every BaseLayout render
// +850 bytes; the sign-up page's chrome must not depend on the
// operator's local config surface). Self-checked through the REAL gate.
import { demoModeEnabled } from "../services/demo-sweep";
(env as { DEMO_MODE?: string }).DEMO_MODE = undefined;
if (demoModeEnabled(env)) {
  throw new Error("first-run: the demo render gate pin failed — demoModeEnabled(env) must be false");
}

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { TokenService } from "../auth/token-service";
import { sessions, userRedirects, users } from "../db/schema";
import { allowSignup, initWindowOpen } from "../services/user-accounts";
import { firstRunRouter } from "./first-run";
import { sessionRouter, SESSION_COOKIE_NAME } from "./session";
import { renderLoginPage } from "./pages/login";
import { resolveViewer } from "./viewer";
import { type UiAssetsFetcher } from "./index";
import type { UiManifest } from "./manifest";
import { shellAssetsFromManifest } from "./ui-context";
import loginGolden from "./session-goldens/login.html?raw";

// --- the local app (the HANDOFF NOTE's registration shape) ----------------------

const app = new Hono<{ Bindings: Env }>();
app.route("/", sessionRouter);
app.route("/", firstRunRouter);

/** Synthetic manifest (fixed pseudo-hashes) — page renders are byte-stable
 *  without the real asset build (the session.test.ts harness). */
const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": {
    file: "js/index.deadbeef.js",
    imports: ["web_src/js/secondary.ts"],
    css: ["css/index.1111aaaa.css"],
  },
  "web_src/js/secondary.ts": { file: "js/secondary.2222bbbb.js", css: ["css/secondary.3333cccc.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const fakeAssets: UiAssetsFetcher = {
  fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })),
};

type UiTestEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

/** Route-level request with a REAL execution context (the session.test.ts
 *  pattern): any `waitUntil` side-effect is awaited before assertions.
 *  `allowSignup` toggles the env var the way the deployment's `vars` block
 *  would. */
async function request(
  path: string,
  init?: RequestInit,
  options?: { allowSignup?: string },
): Promise<Response> {
  const testEnv: Omit<UiTestEnv, "ALLOW_SIGNUP"> & { ALLOW_SIGNUP?: string } = {
    ...env,
    ASSETS: fakeAssets,
    ALLOW_SIGNUP: options?.allowSignup,
  };
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`https://test.local${path}`, init), testEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** The `application/x-www-form-urlencoded` body helper. */
function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

const cookieHeader = (response: Response): string => response.headers.get("set-cookie") ?? "";

async function userCount(): Promise<number> {
  return (await drizzle(env.DB).select({ id: users.id }).from(users).all()).length;
}

async function adminRows(): Promise<typeof users.$inferSelect[]> {
  return drizzle(env.DB).select().from(users).where(eq(users.isAdmin, true)).all();
}

beforeAll(applyAuthD1Migrations);

beforeEach(async () => {
  for (const table of ["sessions", "personal_access_tokens", "auth_failures", "user_redirects", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// ---------------------------------------------------------------------------------
// The gate — allowSignup absent-safety
// ---------------------------------------------------------------------------------

describe("allowSignup — the absent-safe gate", () => {
  it("defaults FALSE for absent/empty/unrecognized values (the self-host posture)", () => {
    const probe = (raw: string | undefined): boolean => allowSignup({ ...env, ALLOW_SIGNUP: raw });
    expect(probe(undefined)).toBe(false);
    expect(probe("")).toBe(false);
    expect(probe("false")).toBe(false);
    expect(probe("False")).toBe(false);
    expect(probe("0")).toBe(false);
    expect(probe("yes")).toBe(false);
  });

  it("turns on only for explicit true/1 (any case)", () => {
    const probe = (raw: string): boolean => allowSignup({ ...env, ALLOW_SIGNUP: raw });
    expect(probe("true")).toBe(true);
    expect(probe("TRUE")).toBe(true);
    expect(probe("1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------
// The admin-init window
// ---------------------------------------------------------------------------------

describe("POST /install — the one-shot admin init", () => {
  it("creates the admin atomically, mints a session, and the viewer carries isAdmin", async () => {
    expect(await initWindowOpen(env.DB)).toBe(true);

    const res = await request("/install", form({ admin_name: "Root", email: "root@example.com", admin_passwd: "ignored", retype: "ignored" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    // Session-scope cookie (the install form has no remember field): the
    // exact §2.3 flag set without Max-Age.
    const directive = cookieHeader(res);
    const parts = new Map(
      directive.split(";").map((part) => {
        const at = part.indexOf("=");
        return at < 0 ? [part.trim(), ""] : [part.slice(0, at).trim(), part.slice(at + 1)];
      }),
    );
    expect(parts.has(SESSION_COOKIE_NAME)).toBe(true);
    expect(parts.get("Path")).toBe("/");
    expect(parts.get("HttpOnly")).toBe("");
    expect(parts.get("Secure")).toBe("");
    expect(parts.get("SameSite")).toBe("Lax");
    expect(parts.has("Max-Age")).toBe(false);

    // Exactly one user row: the admin, the adminCreateUser insert shape.
    expect(await userCount()).toBe(1);
    const admins = await adminRows();
    expect(admins).toHaveLength(1);
    const admin = admins[0]!;
    expect(admin.username).toBe("Root");
    expect(admin.usernameLower).toBe("root");
    expect(admin.email).toBe("root@example.com");
    expect(admin.status).toBe("active");
    expect(admin.type).toBe("user");
    expect(admin.visibility).toBe("public");
    expect(admin.displayName).toBeNull();

    // The minted session belongs to the admin (install.go's auto-login).
    const rows = await drizzle(env.DB).select().from(sessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(admin.id);

    // The §2.5 viewer seam: the cookie resolves to the admin principal.
    const cookieValue = directive.split(";")[0]?.split("=").slice(1).join("=") ?? "";
    const resolution = await resolveViewer(env, new Request("https://test.local/", { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` } }));
    expect(resolution.viewer).toEqual({ kind: "user", id: admin.id, username: "Root", isAdmin: true });
  });

  it("the window closes after the first admin: GET /install 303s and POST re-renders the verdict", async () => {
    const first = await request("/install", form({ admin_name: "Root", email: "root@example.com", admin_passwd: "x", retype: "x" }));
    expect(first.status).toBe(303);

    expect(await initWindowOpen(env.DB)).toBe(false);

    const gone = await request("/install");
    expect(gone.status).toBe(303);
    expect(gone.headers.get("location")).toBe("/");

    const refusal = await request("/install", form({ admin_name: "Second", email: "second@example.com", admin_passwd: "x", retype: "x" }));
    expect(refusal.status).toBe(200);
    const html = await refusal.text();
    expect(html).not.toContain('action="/install"');
    expect(html).toContain("This instance is already initialized");
    expect(await userCount()).toBe(1);
  });

  it("THE RACE: two concurrent first-submissions resolve to exactly one admin", async () => {
    const a = request("/install", form({ admin_name: "Alice", email: "alice@example.com", admin_passwd: "x", retype: "x" }));
    const b = request("/install", form({ admin_name: "Bob", email: "bob@example.com", admin_passwd: "x", retype: "x" }));
    const [ra, rb] = await Promise.all([a, b]);

    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 303]); // one winner, one re-render

    // Exactly one admin exists — the count-guarded insert is the arbiter.
    expect(await userCount()).toBe(1);
    const admins = await adminRows();
    expect(admins).toHaveLength(1);
    const winnerName = admins[0]!.username;

    // The loser gets the clear verdict with the form gone; the winner's
    // browser is signed in.
    const loser = winnerName === "Alice" ? rb : ra;
    const winner = winnerName === "Alice" ? ra : rb;
    expect(await loser.text()).toContain("This instance is already initialized");
    expect(cookieHeader(loser)).toBe("");
    expect(cookieHeader(winner)).toContain(SESSION_COOKIE_NAME);
    expect(await drizzle(env.DB).select().from(sessions).all()).toHaveLength(1);
  });

  it("a validation failure re-renders with the message and leaves the window open", async () => {
    const res = await request("/install", form({ admin_name: "bad..name", email: "root@example.com", admin_passwd: "x", retype: "x" }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/install"');
    expect(html).toContain("name is invalid");
    expect(await userCount()).toBe(0);
    expect(await initWindowOpen(env.DB)).toBe(true);
  });

  it("an empty username re-renders (the HTML5-required miss from non-browser clients)", async () => {
    const res = await request("/install", form({ admin_name: "", email: "root@example.com", admin_passwd: "x", retype: "x" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("must be valid alpha or numeric");
    expect(await userCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------
// Registration — the ALLOW_SIGNUP gate on /user/sign_up
// ---------------------------------------------------------------------------------

describe("GET/POST /user/sign_up — the ALLOW_SIGNUP gate", () => {
  it("404s while closed (absent var)", async () => {
    const page = await request("/user/sign_up");
    expect(page.status).toBe(404);
    const submit = await request("/user/sign_up", form({ user_name: "Alice", email: "a@example.com", password: "x", retype: "x" }));
    expect(submit.status).toBe(404);
    expect(await userCount()).toBe(0);
  });

  it("404s for explicit false/empty values", async () => {
    expect((await request("/user/sign_up", undefined, { allowSignup: "false" })).status).toBe(404);
    expect((await request("/user/sign_up", undefined, { allowSignup: "" })).status).toBe(404);
    expect((await request("/user/sign_up", undefined, { allowSignup: "0" })).status).toBe(404);
  });

  it("renders the page while open (upstream signup shape, action + fields)", async () => {
    const res = await request("/user/sign_up", undefined, { allowSignup: "true" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/user/sign_up"');
    expect(html).toContain('name="user_name"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain('name="retype"');
    expect(html).toContain("Already have an account?");
  });

  it("creates a plain member account + session on submit (handleSignIn parity)", async () => {
    const res = await request(
      "/user/sign_up",
      form({ user_name: "Alice", email: "alice@example.com", password: "ignored", retype: "ignored" }),
      { allowSignup: "true" },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(await userCount()).toBe(1);
    const admins = await adminRows();
    expect(admins).toHaveLength(0); // plain member — is_admin=false
    const alice = (await drizzle(env.DB).select().from(users).all())[0]!;
    expect(alice.usernameLower).toBe("alice");
    expect(alice.isAdmin).toBe(false);
    expect((await drizzle(env.DB).select().from(sessions).all())[0]?.userId).toBe(alice.id);
  });

  it("reuses the shared validation ladder: invalid name / email / retype re-render at 200", async () => {
    const invalidName = await request(
      "/user/sign_up",
      form({ user_name: "a..b", email: "a@example.com", password: "x", retype: "x" }),
      { allowSignup: "true" },
    );
    expect(invalidName.status).toBe(200);
    expect(await invalidName.text()).toContain("name is invalid");

    const invalidEmail = await request(
      "/user/sign_up",
      form({ user_name: "Alice", email: "not-an-email", password: "x", retype: "x" }),
      { allowSignup: "true" },
    );
    expect(await invalidEmail.text()).toContain("email address is invalid: not-an-email");

    const retype = await request(
      "/user/sign_up",
      form({ user_name: "Alice", email: "a@example.com", password: "x", retype: "y" }),
      { allowSignup: "true" },
    );
    expect(await retype.text()).toContain("password and re-type do not match");

    expect(await userCount()).toBe(0);
  });

  it("refuses a taken name (case-folded) and a used email with upstream's web copy", async () => {
    await request("/user/sign_up", form({ user_name: "Alice", email: "alice@example.com", password: "x", retype: "x" }), {
      allowSignup: "true",
    });

    const nameTaken = await request(
      "/user/sign_up",
      form({ user_name: "ALICE", email: "other@example.com", password: "x", retype: "x" }),
      { allowSignup: "true" },
    );
    expect(nameTaken.status).toBe(200);
    expect(await nameTaken.text()).toContain("The username is already taken.");

    const emailTaken = await request(
      "/user/sign_up",
      form({ user_name: "Bob", email: "alice@example.com", password: "x", retype: "x" }),
      { allowSignup: "true" },
    );
    expect(await emailTaken.text()).toContain("The email address is already used.");

    expect(await userCount()).toBe(1);
  });

  it("consumes a live user_redirect on create (user.go:798 parity)", async () => {
    await request("/user/sign_up", form({ user_name: "Old", email: "old@example.com", password: "x", retype: "x" }), {
      allowSignup: "true",
    });
    const old = (await drizzle(env.DB).select().from(users).all())[0]!;
    await drizzle(env.DB)
      .insert(userRedirects)
      .values({ lowerName: "former", redirectUserId: old.id })
      .run();

    const res = await request(
      "/user/sign_up",
      form({ user_name: "Former", email: "former@example.com", password: "x", retype: "x" }),
      { allowSignup: "true" },
    );
    expect(res.status).toBe(303);
    const redirects = await drizzle(env.DB).select().from(userRedirects).all();
    expect(redirects).toHaveLength(0);
    const rows = await drizzle(env.DB).select().from(users).all();
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------
// The session integration — the init-created admin logs in
// ---------------------------------------------------------------------------------

describe("session integration — the init-created admin", () => {
  it("logs in with a PAT (POST /login shape) and holds is_admin in the viewer", async () => {
    const init = await request("/install", form({ admin_name: "Root", email: "root@example.com", admin_passwd: "x", retype: "x" }));
    const initCookie = cookieHeader(init).split(";")[0] ?? "";
    const admin = (await adminRows())[0]!;

    // The admin mints a PAT (settings surface path) and signs in with it.
    const pat = (await new TokenService(env.DB).mint({ userId: admin.id, name: "web", scopes: "all" })).plaintext;
    const login = await request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: pat }).toString(),
    });
    expect(login.status).toBe(303);
    const cookie = cookieHeader(login).split(";")[0] ?? "";
    expect(cookie.startsWith(SESSION_COOKIE_NAME)).toBe(true);

    // The viewer seam carries isAdmin for the new cookie.
    const resolution = await resolveViewer(env, new Request("https://test.local/", { headers: { cookie } }));
    expect(resolution.viewer).toEqual({ kind: "user", id: admin.id, username: "Root", isAdmin: true });

    // The signed-in browser never sees the first-run surfaces again.
    expect((await request("/install", { headers: { cookie } })).status).toBe(303);
    expect(initCookie).toContain(SESSION_COOKIE_NAME); // the init session was real
  });
});

// ---------------------------------------------------------------------------------
// The login-page extension — golden-stable default, panel + link when asked
// ---------------------------------------------------------------------------------

describe("login page extension", () => {
  const ctx = {
    viewer: { kind: "anonymous" } as const,
    origin: "https://test.local",
    assets: shellAssetsFromManifest(manifest),
  };

  it("the default render is unchanged (no panel, no link — the committed golden)", () => {
    const html = renderLoginPage({ ctx, redirectTo: null, error: null });
    expect(html).not.toContain('action="/install"');
    expect(html).not.toContain("/user/sign_up");
    expect(html).not.toContain("Administrator Account Settings");
    // The committed golden (session.test.ts asserts byte-equality too) —
    // re-check the sentinel here so a default-render drift fails HERE.
    if (loginGolden !== "") {
      expect(html).toBe(loginGolden);
    }
  });

  it("renders the admin-init form when the window is open", () => {
    const html = renderLoginPage({ ctx, redirectTo: null, error: null, adminInit: { open: true, error: null } });
    expect(html).toContain('action="/install"');
    expect(html).toContain("Administrator Account Settings");
    expect(html).toContain('name="admin_name"');
    expect(html).toContain('name="admin_email"');
    expect(html).toContain('name="admin_passwd"');
  });

  it("renders the already-initialized message without the form for the race loser", () => {
    const html = renderLoginPage({
      ctx,
      redirectTo: null,
      error: null,
      adminInit: { open: false, error: "This instance is already initialized — sign in instead." },
    });
    expect(html).toContain("This instance is already initialized");
    expect(html).not.toContain('action="/install"');
  });

  it("renders the register link when the gate is on", () => {
    const html = renderLoginPage({ ctx, redirectTo: null, error: null, signUpLink: true });
    expect(html).toContain('href="/user/sign_up"');
    expect(html).toContain("Register now.");
  });
});

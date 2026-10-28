/**
 * SPEC-0010 §5 — the web-session suite on real D1 (workerd):
 *
 * - Login (POST /login): the happy path's Set-Cookie flags verbatim, the
 *   `redirect_to` validation, every failure re-render at 200 + one limiter
 *   failure, the shared 429 block, and the success reset.
 * - Viewer + repo resolution: the §2.6 matrix end-to-end through the real
 *   uiRouter pipeline (anonymous / owner / site admin / unrelated /
 *   limited-owner rows), with the navbar chrome delta asserted.
 * - Rotation / reuse (§2.4) with time travel: fresh verify, forced rotation
 *   (digest + grace columns + new Set-Cookie), the 60 s stale-cookie grace,
 *   beyond-grace and wrong-secret deletions, the CAS-loses race outcome,
 *   the throttled `last_seen_at`.
 * - Logout: valid / cookieless / forged presentations (§2.7: forged logout
 *   leaves rows untouched — reuse detection owns mismatch deletion).
 * - Boundary (§2.9): a session cookie authorizes nothing on /api/v1 or
 *   git-HTTP.
 * - The login page golden (deterministic render, committed bytes) + the §5.5
 *   a11y smoke over it.
 *
 * The routes run on a locally-mounted app mirroring the production
 * registration (`sessionRouter` + `uiRouter`, both at "/"), with the
 * synthetic manifest fixture so page renders never depend on the asset
 * build; the capturing ExecutionContext makes every `waitUntil` side-effect
 * observable (awaited before assertions).
 */

import { SELF, env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { fnv1a32 } from "../auth/failure-limiter";
import { sha256Hex } from "../auth/digest";
import { TokenService } from "../auth/token-service";
import { authFailures, repositories, sessions, users } from "../db/schema";
import { uiRouter, type UiAssetsFetcher } from "./index";
import type { UiManifest } from "./manifest";
import {
  REMEMBER_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  clearSessionSetCookie,
  deleteSessionBySecret,
  lookupValidSession,
  mintSession,
  rotateSession,
  safeRedirectTarget,
  sessionRouter,
  sessionSetCookie,
  sweepExpiredSessions,
  verifySession,
} from "./session";
import { runA11y } from "./__tests__/a11y";
import loginGolden from "./session-goldens/login.html?raw";

// --- the local app (production registration shape) ------------------------------

const app = new Hono<{ Bindings: Env }>();
app.route("/", sessionRouter);
app.route("/", uiRouter);

/** Synthetic manifest (fixed pseudo-hashes) — page renders are byte-stable
 *  without the real asset build (the harness.ts pattern). */
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
// The demo render gate pinned to the ABSENT arm — the login golden's bytes
// must not depend on the operator's local config surface (an armed local
// DEMO_MODE shifts every BaseLayout render +850 bytes; the goldens unit's
// diagnosis, 2026-10-28). Self-checked through the REAL gate function.
import { demoModeEnabled } from "../services/demo-sweep";
(env as { DEMO_MODE?: string }).DEMO_MODE = undefined;
if (demoModeEnabled(env)) {
  throw new Error("session goldens: the demo render gate pin failed — demoModeEnabled(env) must be false");
}
const testEnv: UiTestEnv = { ...env, ASSETS: fakeAssets };

/** Route-level request with a REAL execution context from the vitest
 *  plugin: every `ctx.waitUntil` side-effect is awaited before the response
 *  returns, so row-level assertions are deterministic. */
async function request(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`https://test.local${path}`, init), testEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** The `application/x-www-form-urlencoded` login body (§2.2), with optional
 *  extra headers (x-forwarded-for pins the limiter's per-IP bucket). */
function form(fields: Record<string, string>, extraHeaders: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
    body: new URLSearchParams(fields).toString(),
  };
}

/** Split a Set-Cookie header into its name=value / flag parts. */
function cookieParts(header: string): Map<string, string> {
  return new Map(
    header.split(";").map((part) => {
      const at = part.indexOf("=");
      return at < 0 ? [part.trim(), ""] : [part.slice(0, at).trim(), part.slice(at + 1)];
    }),
  );
}

const cookieHeader = (response: Response): string => response.headers.get("set-cookie") ?? "";

// --- fixtures ---------------------------------------------------------------------

interface SeedUser {
  id: number;
  username: string;
  usernameLower: string;
}

async function seedUser(
  options: {
    username?: string;
    isAdmin?: boolean;
    status?: "active" | "prohibited";
    visibility?: "public" | "limited" | "private";
  } = {},
): Promise<SeedUser> {
  const username = options.username ?? "Alice";
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: options.isAdmin ?? false,
      status: options.status ?? "active",
      visibility: options.visibility ?? "public",
      createdAt: new Date(),
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  return { id: row.id, username: row.username, usernameLower: row.usernameLower };
}

async function seedRepo(owner: SeedUser, slug: string, visibility: "public" | "private"): Promise<void> {
  const id = `r_${owner.usernameLower}_${slug}`;
  await drizzle(env.DB)
    .insert(repositories)
    .values({
      id,
      storageKey: id,
      ownerNamespace: owner.usernameLower,
      ownerId: owner.id,
      slug,
      visibility,
    })
    .run();
}

/** A login-able PAT (`all` — the everyday token) for `user`. */
async function seedToken(user: SeedUser, name: string, scopes = "all"): Promise<string> {
  return (await new TokenService(env.DB).mint({ userId: user.id, name, scopes })).plaintext;
}

const failureCount = async (ip: string): Promise<number> =>
  (await drizzle(env.DB).select().from(authFailures).where(eq(authFailures.ip, ip)).get())?.count ?? 0;

beforeAll(applyAuthD1Migrations);

beforeEach(async () => {
  for (const table of ["sessions", "personal_access_tokens", "auth_failures", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// ---------------------------------------------------------------------------------
// §5 login — POST /login
// ---------------------------------------------------------------------------------

describe("POST /login — the happy path (§2.2)", () => {
  it("mints a row and sets the gitea_session cookie with the exact flag set (no remember)", async () => {
    const alice = await seedUser({ username: "Alice" });
    const pat = await seedToken(alice, "web");

    const before = Date.now();
    const res = await request("/login", form({ password: pat }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");

    const parts = cookieParts(cookieHeader(res));
    const value = parts.get(SESSION_COOKIE_NAME) ?? "";
    expect(value).toMatch(/^[a-zA-Z0-9]{10}:[0-9a-f]{64}$/);
    expect(parts.get("Path")).toBe("/");
    expect(parts.get("HttpOnly")).toBe("");
    expect(parts.get("Secure")).toBe("");
    expect(parts.get("SameSite")).toBe("Lax");
    expect(parts.has("Max-Age")).toBe(false); // session cookie: dies with the browser

    // The row mirrors upstream's auth_token shape: sha256 at rest, unrotated,
    // 24 h TTL, last_seen stamped at mint.
    const rows = await drizzle(env.DB).select().from(sessions).all();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.userId).toBe(alice.id);
    expect(row?.sha256Digest).toBe(await sha256Hex(value.split(":")[1] ?? ""));
    expect(row?.previousSha256Digest).toBeNull();
    expect(row?.remember).toBe(false); // session-scope login → rotations stay session-scope
    const ttl = (row?.expiresAt.getTime() ?? 0) - before;
    expect(ttl).toBeGreaterThan(24 * 60 * 60 * 1000 - 5000);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(row?.rotatedAt.getTime()).toBe(row?.lastSeenAt.getTime());
  });

  it("remember toggles ONLY the cookie persistence: Max-Age=2678400 (31 days)", async () => {
    const alice = await seedUser();
    const pat = await seedToken(alice, "web");
    const res = await request("/login", form({ password: pat, remember: "on" }));
    expect(res.status).toBe(303);
    expect(cookieParts(cookieHeader(res)).get("Max-Age")).toBe(String(REMEMBER_MAX_AGE_SECONDS));
    expect(sessionSetCookie("a:b", true)).toContain(`Max-Age=${REMEMBER_MAX_AGE_SECONDS}`);
    expect(sessionSetCookie("a:b", false)).not.toContain("Max-Age");
    // The decision persists on the row: rotations re-read it (§2.3).
    const row = (await drizzle(env.DB).select().from(sessions).all())[0];
    expect(row?.remember).toBe(true);
  });

  it("accepts `token` as the field alias and an optional case-insensitive matching user_name", async () => {
    const alice = await seedUser({ username: "Alice" });
    const pat = await seedToken(alice, "web");

    const alias = await request("/login", form({ token: pat }));
    expect(alias.status).toBe(303);

    const named = await request("/login", form({ password: pat, user_name: "ALICE" }));
    expect(named.status).toBe(303);
  });

  it("parses `remember` by presence: empty value stays a session cookie, any non-empty value persists", async () => {
    // parseLoginForm (§2.2): `(params.get("remember") ?? "") !== ""` — the
    // checkbox's canonical "on" is covered above; here the parse rule's two
    // edges: an explicitly empty field is absence, ANY other value persists.
    const alice = await seedUser();
    const pat = await seedToken(alice, "web");

    const empty = await request("/login", form({ password: pat, remember: "" }));
    expect(empty.status).toBe(303);
    expect(cookieParts(cookieHeader(empty)).has("Max-Age")).toBe(false);

    const anyValue = await request("/login", form({ password: pat, remember: "yes" }));
    expect(anyValue.status).toBe(303);
    expect(cookieParts(cookieHeader(anyValue)).get("Max-Age")).toBe(String(REMEMBER_MAX_AGE_SECONDS));
  });

  it("honors a path-absolute ?redirect_to and rejects scheme-relative/scheme/control-char targets (§4.6)", async () => {
    const alice = await seedUser();
    const pat = await seedToken(alice, "web");

    const ok = await request("/login", form({ password: pat, redirect_to: "/alice/repo" }));
    expect(ok.headers.get("location")).toBe("/alice/repo");

    for (const hostile of ["//evil.example/x", "https://evil.example/x", "/\tmeta", "relative/path", ""]) {
      const res = await request("/login", form({ password: pat, redirect_to: hostile }));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  it("resets the per-IP limiter on success (§2.2 step 5)", async () => {
    const alice = await seedUser();
    const pat = await seedToken(alice, "web");
    const ip = "10.9.9.9";
    for (let i = 0; i < 19; i++) {
      await request("/login", form({ password: "nope" }, { "x-forwarded-for": ip }));
    }
    expect(await failureCount(ip)).toBe(19);

    const res = await request("/login", form({ password: pat }, { "x-forwarded-for": ip }));
    expect(res.status).toBe(303);
    expect(await failureCount(ip)).toBe(0); // limiter.reset ran via waitUntil
  });
});

describe("POST /login — failure paths re-render at 200 and count one limiter failure (§2.2, §4.11)", () => {
  const ip = "10.1.1.1";
  const post = async (fields: Record<string, string>): Promise<Response> => request("/login", form(fields, { "x-forwarded-for": ip }));

  it("unknown / malformed / missing PAT → the non-committal invalid-token error", async () => {
    const res = await post({ password: "cfg_00000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("The token is not valid.");
    expect(html).toContain("ui negative message");
    expect(html).toContain('action="/login"');
    expect(await failureCount(ip)).toBe(1);

    expect((await post({})).status).toBe(200); // no fields at all
    expect(await failureCount(ip)).toBe(2);
  });

  it("bad PAT shapes — sub-gate short, wrong-shape cfg_, and the imported 40-hex look-alike — fail like unknown credentials", async () => {
    // tokenLookupPrefix's gates (token-format.ts): a value under the 8-char
    // upstream gate never reaches a lookup; a `cfg_`-prefixed but malformed
    // value and a 40-hex imported-shape value take the 12-char prefix lookup
    // and miss the index — all render the same non-committal failure and
    // count exactly one limiter failure each (§4.11's indistinguishability).
    const short = await post({ password: "abc" });
    expect(short.status).toBe(200);
    expect(await short.text()).toContain("The token is not valid.");
    expect(await failureCount(ip)).toBe(1);

    const wrongShape = await post({ password: "cfg_zzzz_not-quite-a-token" });
    expect(wrongShape.status).toBe(200);
    expect(await wrongShape.text()).toContain("The token is not valid.");
    expect(await failureCount(ip)).toBe(2);

    const importedHex = await post({ password: "0123456789abcdef0123456789abcdef01234567" });
    expect(importedHex.status).toBe(200);
    expect(await importedHex.text()).toContain("The token is not valid.");
    expect(await failureCount(ip)).toBe(3);
  });

  it("carries redirect_to through the failure re-render (the round-trip survives a bad credential)", async () => {
    // The POST → failure → resubmit loop keeps the hidden field filled, so
    // a user who mistypes their token does not lose their deep link (§2.2).
    const res = await post({ password: "nope", redirect_to: "/alice/repo" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="redirect_to" value="/alice/repo"');
    expect(await failureCount(ip)).toBe(1);
  });

  it("a wrong user_name is a login failure that reveals nothing", async () => {
    const alice = await seedUser({ username: "Alice" });
    const pat = await seedToken(alice, "web");
    const res = await post({ password: pat, user_name: "not-alice" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The token is not valid.");
    expect(await failureCount(ip)).toBe(1);
  });

  it("an expired PAT verifies as unknown", async () => {
    const alice = await seedUser();
    const minted = await new TokenService(env.DB).mint({
      userId: alice.id,
      name: "expired",
      scopes: "all",
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await post({ password: minted.plaintext });
    expect(res.status).toBe(200);
    expect(await failureCount(ip)).toBe(1);
  });

  it("public-only, no-token-scope, and missing-repository-scope PATs cannot mint (§2.2 step 3)", async () => {
    const alice = await seedUser();
    for (const [name, scopes] of [
      ["po", "public-only"],
      ["ns", "no-token-scope"],
      ["ru", "read:user"],
    ] as const) {
      const pat = await seedToken(alice, name, scopes);
      const res = await post({ password: pat });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("does not grant repository read access");
    }
    expect(await failureCount(ip)).toBe(3);
  });

  it("a prohibited account gets the form, no row, no cookie (§2.2 step 4)", async () => {
    const mallory = await seedUser({ username: "Mallory", status: "prohibited" });
    const pat = await seedToken(mallory, "web");
    const res = await post({ password: pat });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("prohibited from signing in");
    expect(await failureCount(ip)).toBe(1);
    expect(await drizzle(env.DB).select().from(sessions).all()).toHaveLength(0);
    expect(cookieHeader(res)).toBe("");
  });
});

describe("POST /login — the shared per-IP limiter blocks (§2.2 step 1, §4.7)", () => {
  it("answers 429 + Retry-After in the gate's plain-text shape once the window budget is spent", async () => {
    const ip = "10.2.2.2";
    // The threshold is deterministically jittered +0-20% per IP (SPEC-0002 §2.7).
    const threshold = 20 + (fnv1a32(ip) % 5);
    let blocked: Response | null = null;
    for (let attempt = 0; attempt < threshold + 1; attempt++) {
      const res = await request(
        "/login",
        form({ password: "cfg_00000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, { "x-forwarded-for": ip }),
      );
      if (res.status === 429) {
        blocked = res;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(blocked).not.toBeNull();
    expect(blocked?.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/);
    expect(await blocked?.text()).toContain("too many authentication failures");

    // The check runs FIRST: even a valid credential stays blocked.
    const alice = await seedUser();
    const pat = await seedToken(alice, "web");
    const valid = await request("/login", form({ password: pat }, { "x-forwarded-for": ip }));
    expect(valid.status).toBe(429);
    expect(await drizzle(env.DB).select().from(sessions).all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------
// §2.8 — the Origin check on every non-GET UI route
// ---------------------------------------------------------------------------------

describe("CSRF layer 2 — the Origin check (§2.8)", () => {
  it("rejects cross-origin POST /login and POST /logout with 403 plain text", async () => {
    const login = await request("/login", form({ password: "x" }, { origin: "https://evil.example" }));
    expect(login.status).toBe(403);
    expect(await login.text()).toContain("cross-origin request rejected");

    const logout = await request("/logout", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(logout.status).toBe(403);
  });

  it("falls back to Referer and allows same-origin requests (and header-less non-browser clients)", async () => {
    const sameReferer = await request("/login", form({ password: "x" }, { referer: "https://test.local/login" }));
    expect(sameReferer.status).toBe(200); // failure render, not 403

    const evilReferer = await request("/login", form({ password: "x" }, { referer: "https://evil.example/login" }));
    expect(evilReferer.status).toBe(403);

    const noHeaders = await request("/login", form({ password: "x" }));
    expect(noHeaders.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------
// §2.1 GET /login + §2.7 logout
// ---------------------------------------------------------------------------------

describe("GET /login (§2.1)", () => {
  it("renders the form in the anonymous shell (the navbar gains the Sign in link)", async () => {
    const res = await request("/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/login"');
    expect(html).toContain('id="password"');
    expect(html).toContain('name="remember"');
    expect(html).toContain('<a class="item" href="/login">Sign In</a>');
    expect(html).not.toContain("negative message");
  });

  it("carries ?redirect_to through the hidden field", async () => {
    const res = await request("/login?redirect_to=/alice/repo");
    expect(await res.text()).toContain('name="redirect_to" value="/alice/repo"');
  });

  it("carries a hostile ?redirect_to RAW into the hidden field — the guard fires only at POST use time", async () => {
    // safeRedirectTarget (§2.2 step 6) validates at SUBMISSION; the GET form
    // is the round-trip carrier, so the unsanitized value rides verbatim and
    // the open-redirect refusal happens when the form posts back.
    const res = await request(`/login?redirect_to=${encodeURIComponent("//evil.example/x")}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="redirect_to" value="//evil.example/x"');
  });

  it("redirects a valid session to / and clears a garbage cookie", async () => {
    const alice = await seedUser();
    const cookieValue = await mintSession(env.DB, alice.id);
    const valid = await request("/login", { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` } });
    expect(valid.status).toBe(303);
    expect(valid.headers.get("location")).toBe("/");

    const garbage = await request("/login", { headers: { cookie: `${SESSION_COOKIE_NAME}=nonsense` } });
    expect(garbage.status).toBe(200);
    expect(cookieParts(cookieHeader(garbage)).get("Max-Age")).toBe("0");
  });
});

// ---------------------------------------------------------------------------------
// §2.4 step 5 at route level — the GET /login rotation round-trip
// ---------------------------------------------------------------------------------

describe("GET /login — the rotation round-trip", () => {
  /** Backdate the rotation clock on a live row: rotated ≥ 24 h ago, unexpired. */
  async function backdateRotation(cookieValue: string, when: Date): Promise<void> {
    const id = cookieValue.slice(0, cookieValue.indexOf(":"));
    await drizzle(env.DB)
      .update(sessions)
      .set({ rotatedAt: when, lastSeenAt: when })
      .where(eq(sessions.id, id))
      .run();
  }

  it("a rotation-due visit answers the FULL wrapped directive and the adopted cookie authenticates the next request", async () => {
    const alice = await seedUser();
    const oldCookie = await mintSession(env.DB, alice.id);
    const oldSecret = oldCookie.split(":")[1] ?? "";
    const id = oldCookie.split(":")[0] ?? "";
    await backdateRotation(oldCookie, new Date(Date.now() - 25 * 60 * 60 * 1000));

    const res = await request("/login", { headers: { cookie: `${SESSION_COOKIE_NAME}=${oldCookie}` } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");

    // The full gitea_session directive — the review's HIGH #1: the raw
    // id:secret here had no name/flags, so the browser never adopted the
    // rotated secret and past the 60 s grace reuse detection DELETED the
    // row (forced logout on the next visit after 24 h).
    const parts = cookieParts(cookieHeader(res));
    const adoptedSecret = parts.get(SESSION_COOKIE_NAME) ?? "";
    expect(adoptedSecret).toMatch(new RegExp(`^${id}:[0-9a-f]{64}$`)); // same id, fresh secret
    expect(parts.get("Path")).toBe("/");
    expect(parts.get("HttpOnly")).toBe("");
    expect(parts.get("Secure")).toBe("");
    expect(parts.get("SameSite")).toBe("Lax");
    expect(parts.has("Max-Age")).toBe(false); // non-remembered: stays session-scope

    // The row was rewritten with the CAS shape, and the cookie a browser
    // would now present authenticates the next request.
    const row = await drizzle(env.DB).select().from(sessions).where(eq(sessions.id, id)).get();
    expect(row?.sha256Digest).toBe(await sha256Hex(adoptedSecret.split(":")[1] ?? ""));
    expect(row?.previousSha256Digest).toBe(await sha256Hex(oldSecret));
    expect(row?.rotatedAt.getTime()).toBe(row?.lastSeenAt.getTime()); // rotation clock reset

    const next = await request("/login", { headers: { cookie: `${SESSION_COOKIE_NAME}=${adoptedSecret}` } });
    expect(next.status).toBe(303); // the rotated secret is live
    expect(cookieHeader(next)).toBe(""); // rotation no longer due — no Set-Cookie races it
  });

  it("a remembered session's rotation keeps Max-Age=2678400 (upstream re-sets the remember cookie, auth.go:127)", async () => {
    const alice = await seedUser();
    const login = await request("/login", form({ password: await seedToken(alice, "web"), remember: "on" }));
    expect(login.status).toBe(303);
    const remembered = cookieParts(cookieHeader(login)).get(SESSION_COOKIE_NAME) ?? "";
    await backdateRotation(remembered, new Date(Date.now() - 25 * 60 * 60 * 1000));

    const res = await request("/login", { headers: { cookie: `${SESSION_COOKIE_NAME}=${remembered}` } });
    expect(res.status).toBe(303);
    expect(cookieParts(cookieHeader(res)).get("Max-Age")).toBe(String(REMEMBER_MAX_AGE_SECONDS)); // stays persistent
  });

  it("verifySession surfaces the row's remember bit for the wrap (service level)", async () => {
    const alice = await seedUser();
    const remembered = await mintSession(env.DB, alice.id, { remember: true });
    await backdateRotation(remembered, new Date(Date.now() - 25 * 60 * 60 * 1000));
    const yes = await verifySession(env.DB, remembered);
    expect(yes.outcome).toBe("authenticated");
    if (yes.outcome === "authenticated") {
      expect(yes.remember).toBe(true);
      expect(yes.setCookie).not.toBeNull();
    }

    const plain = await mintSession(env.DB, alice.id);
    await backdateRotation(plain, new Date(Date.now() - 25 * 60 * 60 * 1000));
    const no = await verifySession(env.DB, plain);
    expect(no.outcome).toBe("authenticated");
    if (no.outcome === "authenticated") expect(no.remember).toBe(false);
  });
});

describe("POST /logout (§2.7)", () => {
  it("deletes the row (id AND digest), clears the cookie, redirects — idempotent", async () => {
    const alice = await seedUser();
    const cookieValue = await mintSession(env.DB, alice.id);

    const res = await request("/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(cookieHeader(res)).toBe(clearSessionSetCookie());
    expect(await drizzle(env.DB).select().from(sessions).all()).toHaveLength(0);

    // Logging out again (stale cookie, row gone) is still a clean redirect.
    const again = await request("/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` },
    });
    expect(again.status).toBe(303);
  });

  it("cookieless logout is a clean redirect; a FORGED cookie leaves rows untouched (§2.7, §5)", async () => {
    const alice = await seedUser();
    const cookieValue = await mintSession(env.DB, alice.id);
    const id = cookieValue.split(":")[0] ?? "";

    const cookieless = await request("/logout", { method: "POST" });
    expect(cookieless.status).toBe(303);
    expect(await drizzle(env.DB).select().from(sessions).all()).toHaveLength(1);

    // Wrong secret on a live id: reuse detection owns mismatch deletion — a
    // forged logout must not become a lockout lever.
    const forged = await request("/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${id}:${"f".repeat(64)}` },
    });
    expect(forged.status).toBe(303);
    expect(await drizzle(env.DB).select().from(sessions).all()).toHaveLength(1);

    // The session itself still works (the row survived).
    expect(await lookupValidSession(env.DB, cookieValue)).not.toBeNull();
  });

  it("the deleted session no longer authenticates pages", async () => {
    const alice = await seedUser();
    await seedRepo(alice, "private", "private");
    const cookieValue = await mintSession(env.DB, alice.id);
    expect(await deleteSessionBySecret(env.DB, cookieValue)).toBe(true);
    const res = await request("/alice/private", { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` } });
    expect(res.status).toBe(404); // back to anonymous: existence stays hidden
  });

  it("clears the cookie on EVERY arm — cookieless and forged logouts both carry the Max-Age=0 directive", async () => {
    // §2.7: "either way the cookie is cleared" — the valid arm pins the exact
    // directive above; here the no-row arms carry it too (a stale or forged
    // cookie must not survive the POST /logout round-trip).
    const alice = await seedUser();
    const cookieValue = await mintSession(env.DB, alice.id);
    const id = cookieValue.split(":")[0] ?? "";

    const cookieless = await request("/logout", { method: "POST" });
    expect(cookieless.status).toBe(303);
    expect(cookieHeader(cookieless)).toBe(clearSessionSetCookie());

    const forged = await request("/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${id}:${"f".repeat(64)}` },
    });
    expect(forged.status).toBe(303);
    expect(cookieHeader(forged)).toBe(clearSessionSetCookie());
    // The forged arm still leaves the row untouched (asserted above in the
    // forged arm's own test) — the clear directive is response-side only.
    expect(await drizzle(env.DB).select().from(sessions).all()).toHaveLength(1);
  });
});

describe("safeRedirectTarget — the §2.2 step 6 unit arms behind both /login arms", () => {
  it("passes only path-absolute same-origin targets; everything else folds to /", () => {
    expect(safeRedirectTarget(null)).toBe("/"); // absent field
    expect(safeRedirectTarget(undefined)).toBe("/");
    expect(safeRedirectTarget("")).toBe("/");
    expect(safeRedirectTarget("/")).toBe("/"); // length < 2: nothing to redirect to
    expect(safeRedirectTarget("/issues/7")).toBe("/issues/7"); // the pass-through shape
    // The open-redirect refusals: scheme-relative, absolute-scheme, and
    // relative targets all fold onto the origin root.
    expect(safeRedirectTarget("//evil.example/x")).toBe("/");
    expect(safeRedirectTarget("https://evil.example/x")).toBe("/");
    expect(safeRedirectTarget("relative/path")).toBe("/");
    // Control characters are refused outright (defence in depth behind the
    // header API's CRLF rejection — module doc).
    expect(safeRedirectTarget("/\nmeta")).toBe("/");
    expect(safeRedirectTarget("/\tmeta")).toBe("/");
  });
});

// ---------------------------------------------------------------------------------
// §5 viewer + repo resolution — the §2.6 matrix end-to-end
// ---------------------------------------------------------------------------------

describe("§2.6 matrix — pages resolve through the gate's own grant lines", () => {
  const as = (cookieValue: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` } });

  /** alice: public owner with public+private repos; bob: unrelated user;
   *  Root: site admin; Limbo: limited owner with a public repo. */
  async function seedMatrix(): Promise<{ alice: SeedUser; bob: SeedUser; admin: SeedUser }> {
    const alice = await seedUser({ username: "Alice" });
    const bob = await seedUser({ username: "Bob" });
    const admin = await seedUser({ username: "Root", isAdmin: true });
    const limitedOwner = await seedUser({ username: "Limbo", visibility: "limited" });
    await seedRepo(alice, "public", "public");
    await seedRepo(alice, "private", "private");
    await seedRepo(limitedOwner, "showcase", "public");
    return { alice, bob, admin };
  }

  it("anonymous: public repo renders, private 404-shells (existence hidden)", async () => {
    const { alice } = await seedMatrix();
    expect((await request("/alice/public")).status).toBe(200);
    const shell = await request("/alice/private");
    expect(shell.status).toBe(404);
    expect(await shell.text()).toContain("404 Not Found");
    expect(alice.username).toBe("Alice");
  });

  it("owner session on a private repo renders with the signed-in navbar chrome", async () => {
    const { alice } = await seedMatrix();
    const res = await request("/alice/private", as(await mintSession(env.DB, alice.id)));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="navbar-username"');
    expect(html).toContain('method="post" action="/logout"');
    expect(html).not.toContain('href="/login"');
  });

  it("site admin on a private repo renders; an unrelated user 404-shells", async () => {
    const { alice, bob, admin } = await seedMatrix();
    expect((await request("/alice/private", as(await mintSession(env.DB, admin.id)))).status).toBe(200);
    const unrelated = await request("/alice/private", as(await mintSession(env.DB, bob.id)));
    expect(unrelated.status).toBe(404);
    expect(await unrelated.text()).toContain("404 Not Found");
    expect(alice.id).not.toBe(bob.id);
  });

  it("a limited owner's public repo is authenticated-only (anonymous 404, any session 200)", async () => {
    const { alice, bob, admin } = await seedMatrix();
    expect((await request("/limbo/showcase")).status).toBe(404);
    for (const viewer of [alice, bob, admin]) {
      const res = await request("/limbo/showcase", as(await mintSession(env.DB, viewer.id)));
      expect(res.status).toBe(200);
    }
  });

  it("a session whose user later becomes prohibited de-escalates to anonymous (§2.4 step 4)", async () => {
    const { alice } = await seedMatrix();
    const cookieValue = await mintSession(env.DB, alice.id);
    expect((await request("/alice/private", as(cookieValue))).status).toBe(200);
    await drizzle(env.DB).update(users).set({ status: "prohibited" }).where(eq(users.id, alice.id));
    const res = await request("/alice/private", as(cookieValue));
    expect(res.status).toBe(404);
    expect(cookieParts(cookieHeader(res)).get("Max-Age")).toBe("0"); // cookie cleared
  });
});

// ---------------------------------------------------------------------------------
// §2.4/§5 — verification, rotation, reuse detection (time travel at the service)
// ---------------------------------------------------------------------------------

const T = 1_700_000_000_000; // fixed epoch for the time-travel tests

/** Insert a session row with a KNOWN secret so tests can craft cookies. */
async function insertSession(input: {
  id: string;
  userId: number;
  secret: string;
  rotatedAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  previous?: string;
  remember?: boolean;
}): Promise<string> {
  await drizzle(env.DB)
    .insert(sessions)
    .values({
      id: input.id,
      userId: input.userId,
      sha256Digest: await sha256Hex(input.secret),
      previousSha256Digest: input.previous ?? null,
      rotatedAt: input.rotatedAt,
      expiresAt: input.expiresAt,
      lastSeenAt: input.lastSeenAt,
      remember: input.remember ?? false,
    })
    .run();
  return `${input.id}:${input.secret}`;
}

describe("§2.4 verification, rotation, reuse detection", () => {
  it("a fresh session verifies to its owner with no rotation and no background work", async () => {
    const alice = await seedUser();
    const cookieValue = await mintSession(env.DB, alice.id, { now: new Date(T) });
    const result = await verifySession(env.DB, cookieValue, { now: new Date(T + 1000) });
    expect(result.outcome).toBe("authenticated");
    if (result.outcome !== "authenticated") return;
    expect(result.user.id).toBe(alice.id);
    expect(result.user.username).toBe("Alice");
    expect(result.setCookie).toBeNull();
    expect(result.background).toHaveLength(0); // last_seen still fresh
  });

  it("an expired session de-escalates anonymously and its row is GC'd (§2.4 step 2)", async () => {
    const alice = await seedUser();
    const cookieValue = await mintSession(env.DB, alice.id, { now: new Date(T) });
    const result = await verifySession(env.DB, cookieValue, { now: new Date(T + 24 * 60 * 60 * 1000 + 1000) });
    expect(result.outcome).toBe("anonymous");
    if (result.outcome !== "anonymous") return;
    expect(result.clearCookie).toBe(true);
    await Promise.all(result.background); // the lazy GC write
    expect(await drizzle(env.DB).select().from(sessions).all()).toHaveLength(0);
  });

  it("forced rotation rewrites the digest + grace columns and returns a fresh Set-Cookie (§2.4 step 5)", async () => {
    const alice = await seedUser();
    const secret = "a".repeat(64);
    const cookieValue = await insertSession({
      id: "abcdefghij",
      userId: alice.id,
      secret,
      rotatedAt: new Date(T - 25 * 60 * 60 * 1000),
      expiresAt: new Date(T + 60 * 60 * 1000),
      lastSeenAt: new Date(T - 25 * 60 * 60 * 1000),
    });
    const result = await verifySession(env.DB, cookieValue, { now: new Date(T) });
    expect(result.outcome).toBe("authenticated");
    if (result.outcome !== "authenticated") return;
    expect(result.setCookie).toMatch(/^abcdefghij:[0-9a-f]{64}$/);

    const row = (await drizzle(env.DB).select().from(sessions).all())[0];
    const newSecret = result.setCookie?.split(":")[1] ?? "";
    expect(row?.sha256Digest).toBe(await sha256Hex(newSecret));
    expect(row?.previousSha256Digest).toBe(await sha256Hex(secret));
    expect(row?.rotatedAt.getTime()).toBe(T);
    expect(row?.expiresAt.getTime()).toBe(T + 24 * 60 * 60 * 1000); // TTL extended
  });

  it("rotation preserves the row's remember bit (the CAS rewrite leaves persistence alone, §2.3)", async () => {
    const alice = await seedUser();
    const cookieValue = await insertSession({
      id: "rememb1234",
      userId: alice.id,
      secret: "5".repeat(64),
      rotatedAt: new Date(T - 25 * 60 * 60 * 1000),
      expiresAt: new Date(T + 60 * 60 * 1000),
      lastSeenAt: new Date(T - 25 * 60 * 60 * 1000),
      remember: true,
    });
    const result = await verifySession(env.DB, cookieValue, { now: new Date(T) });
    expect(result.outcome).toBe("authenticated");
    if (result.outcome !== "authenticated") return;
    expect(result.remember).toBe(true); // the wrap source survives rotation
    expect(result.setCookie).not.toBeNull();
    const row = (await drizzle(env.DB).select().from(sessions).all())[0];
    expect(row?.remember).toBe(true);
  });

  it("the previous secret inside the 60 s grace must not authenticate but the row SURVIVES (§2.4 step 3)", async () => {
    const alice = await seedUser();
    const oldSecret = "b".repeat(64);
    await insertSession({
      id: "grace12345",
      userId: alice.id,
      secret: "c".repeat(64),
      previous: await sha256Hex(oldSecret),
      rotatedAt: new Date(T - 30_000),
      expiresAt: new Date(T + 60 * 60 * 1000),
      lastSeenAt: new Date(T),
    });
    const result = await verifySession(env.DB, `grace12345:${oldSecret}`, { now: new Date(T) });
    expect(result.outcome).toBe("anonymous");
    if (result.outcome !== "anonymous") return;
    expect(result.clearCookie).toBe(false); // no Set-Cookie races the rotation
    expect(await drizzle(env.DB).select().from(sessions).all()).toHaveLength(1);
  });

  it("beyond the grace a stale secret is the compromise response: the row is deleted", async () => {
    const alice = await seedUser();
    const oldSecret = "d".repeat(64);
    await insertSession({
      id: "stale12345",
      userId: alice.id,
      secret: "e".repeat(64),
      previous: await sha256Hex(oldSecret),
      rotatedAt: new Date(T - 61_000),
      expiresAt: new Date(T + 60 * 60 * 1000),
      lastSeenAt: new Date(T),
    });
    const result = await verifySession(env.DB, `stale12345:${oldSecret}`, { now: new Date(T) });
    expect(result.outcome).toBe("anonymous");
    if (result.outcome !== "anonymous") return;
    expect(result.clearCookie).toBe(true);
    expect(await drizzle(env.DB).select().from(sessions).all()).toHaveLength(0);
  });

  it("a wrong secret deletes the row (attacker and victim both locked out)", async () => {
    const alice = await seedUser();
    await insertSession({
      id: "wrong12345",
      userId: alice.id,
      secret: "f".repeat(64),
      rotatedAt: new Date(T),
      expiresAt: new Date(T + 60 * 60 * 1000),
      lastSeenAt: new Date(T),
    });
    const result = await verifySession(env.DB, `wrong12345:${"0".repeat(64)}`, { now: new Date(T) });
    expect(result.outcome).toBe("anonymous");
    expect(await drizzle(env.DB).select().from(sessions).all()).toHaveLength(0);
  });

  it("a malformed cookie value is anonymous with zero rows touched", async () => {
    expect((await verifySession(env.DB, "nonsense", { now: new Date(T) })).outcome).toBe("anonymous");
    expect((await verifySession(env.DB, "idonly:", { now: new Date(T) })).outcome).toBe("anonymous");
    expect((await verifySession(env.DB, ":secret", { now: new Date(T) })).outcome).toBe("anonymous");
  });

  it("the rotation CAS losing (changes == 0) sends nothing and leaves the row alone (§4.4)", async () => {
    const alice = await seedUser();
    await insertSession({
      id: "caslost123",
      userId: alice.id,
      secret: "1".repeat(64),
      rotatedAt: new Date(T),
      expiresAt: new Date(T + 60 * 60 * 1000),
      lastSeenAt: new Date(T),
    });
    // A concurrent request rotated first: the caller's verified digest is no
    // longer the stored one.
    const staleDigest = await sha256Hex("9".repeat(64));
    expect(await rotateSession(env.DB, "caslost123", staleDigest, { now: new Date(T) })).toBeNull();
    const row = (await drizzle(env.DB).select().from(sessions).all())[0];
    expect(row?.sha256Digest).toBe(await sha256Hex("1".repeat(64))); // untouched
    expect(row?.previousSha256Digest).toBeNull();
  });

  it("last_seen_at is throttled to once per hour (§3)", async () => {
    const alice = await seedUser();
    const fresh = await insertSession({
      id: "seenfresh1",
      userId: alice.id,
      secret: "2".repeat(64),
      rotatedAt: new Date(T),
      expiresAt: new Date(T + 60 * 60 * 1000),
      lastSeenAt: new Date(T - 30 * 60 * 1000),
    });
    expect((await verifySession(env.DB, fresh, { now: new Date(T) })).background).toHaveLength(0);

    const due = await insertSession({
      id: "seendue123",
      userId: alice.id,
      secret: "3".repeat(64),
      rotatedAt: new Date(T),
      expiresAt: new Date(T + 60 * 60 * 1000),
      lastSeenAt: new Date(T - 2 * 60 * 60 * 1000),
    });
    const result = await verifySession(env.DB, due, { now: new Date(T) });
    expect(result.background).toHaveLength(1);
    await Promise.all(result.background);
    const row = await drizzle(env.DB).select().from(sessions).where(eq(sessions.id, "seendue123")).get();
    expect(row?.lastSeenAt.getTime()).toBe(T);
  });

  it("the login GC sweep removes expired rows only (§2.2 step 5, §3)", async () => {
    const alice = await seedUser();
    await mintSession(env.DB, alice.id, { now: new Date(T - 25 * 60 * 60 * 1000) });
    await insertSession({
      id: "gcalive123",
      userId: alice.id,
      secret: "4".repeat(64),
      rotatedAt: new Date(T),
      expiresAt: new Date(T + 60 * 60 * 1000),
      lastSeenAt: new Date(T),
    });
    await sweepExpiredSessions(env.DB, new Date(T));
    const rows = await drizzle(env.DB).select().from(sessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("gcalive123");
  });
});

// ---------------------------------------------------------------------------------
// §2.9 — the boundary: sessions never authorize /api/v1 or git-HTTP
// ---------------------------------------------------------------------------------

describe("§2.9 boundary (the real dispatcher via SELF)", () => {
  it("a session-cookie-only request to /api/v1/user is anonymous → the SPEC-0002 401 JSON", async () => {
    const alice = await seedUser();
    const cookieValue = await mintSession(env.DB, alice.id);
    const res = await SELF.fetch("https://example.com/api/v1/user", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("token is required");
  });

  it("a session-cookie-only info/refs on a private repo gets the 401 Basic challenge", async () => {
    const alice = await seedUser();
    await seedRepo(alice, "private", "private");
    const cookieValue = await mintSession(env.DB, alice.id);
    const res = await SELF.fetch("https://example.com/alice/private.git/info/refs?service=git-upload-pack", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Gitea"');
  });
});

// ---------------------------------------------------------------------------------
// The login page golden + §5.5 a11y smoke (SPEC-0008 §5.2 style, committed bytes)
// ---------------------------------------------------------------------------------

describe("login page golden (deterministic render)", () => {
  it("renders byte-identical to the committed golden and passes the a11y smoke", async () => {
    // The golden pins the WINDOW-CLOSED render (SPEC-0010 §6): a user exists,
    // so the first-run admin-init panel is absent and the page is byte-stable.
    // The window-open variant (the panel present) is pinned in first-run.test.
    await seedUser({ username: "GoldenAnchor" });
    const res = await request("/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    if (loginGolden === "") {
      // Regeneration path (the update-goldens.mjs pattern): print the
      // marker-framed render, then fail loudly — the operator asked for it.
      console.log(`@@GOLDEN:login.html\n${html}\n@@END-GOLDEN@@`);
      throw new Error(
        "session-goldens/login.html is empty — paste the marker-framed render from: " +
          "pnpm exec vitest run src/ui/session.test.ts --disable-console-intercept",
      );
    }
    expect(html).toBe(loginGolden);
    expect(runA11y(html)).toEqual([]);
  });

  it("renders identical bytes twice (no request-state bleed)", async () => {
    await seedUser({ username: "GoldenAnchor" });
    const first = await request("/login");
    const second = await request("/login");
    expect(await second.text()).toBe(await first.text());
  });
});

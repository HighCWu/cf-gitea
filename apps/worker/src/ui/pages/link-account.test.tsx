/**
 * The LINK-ACCOUNT suite (specs/external-auth-sources.md §8 "Resolution +
 * linking" arms + §5.5.3): the W5 page and its two POST arms over REAL D1
 * with the W2 fetch-stub IdP — the FULL ladders end-to-end
 * (dance → anonymous-miss link page → credential arm → the RE-DANCE → the
 * callback completes the link against the IdP-RE-ASSERTED identity), the
 * 2FA gate on the signin arm (oauth2LinkAccount's deliberate
 * HasTwoFactorOrWebAuthn park — enrolled users do NOT mint; the TOTP and
 * WebAuthn gate completions resume the re-dance and the link completes
 * post-assertion), the gate matrix (the init-window refusal BEFORE
 * credential work on BOTH arms, ALLOW_SIGNUP's 404 polarity, the
 * untrusted-hint 404s), the credential ladder's failure re-renders, and the
 * DOM contract of the page render (link_account.tmpl +
 * signup_inner/signin_inner at the pin).
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";

import { TWOFA_COOKIE_NAME, applyTwofaEnrollment, generateTotpSecret, mintPendingTicket, verifyPendingTicket } from "../../auth/two-factor";
import { totpCode } from "../../auth/totp";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { TokenService } from "../../auth/token-service";
import { runA11y } from "../__tests__/a11y";
import { OAUTH2_DANCE_COOKIE_NAME } from "../../services/auth-sources/identity";
import { serializeOAuth2SourceConfig } from "../../services/auth-sources/cfg";
import { createLoginSource, getActiveOAuth2SourceByName, LoginSourceType } from "../../services/auth-sources/store";
import { createOAuth2LoginRouter } from "../../web/oauth2-login";
import { buildAssertionResponse, buildAuthData, clientDataJson, FLAG_UP, FLAG_UV, makeEcFixture, signWith, type EcFixture } from "../../web/webauthn-fixtures";
import { WEBAUTHN_COOKIE_NAME, verifyCeremonyState } from "../../web/webauthn-ceremony";
import { createWebAuthnRouter } from "../../web/webauthn";
import { createCredential } from "../../web/webauthn-store";
import { sha256 } from "../../web/webauthn-cose";
import { SESSION_COOKIE_NAME, sessionRouter } from "../session";
import { createLinkAccountRouter } from "./link-account-router";
import { linkAccountLocale, loadLinkAccountPageData } from "./link-account";

// -- the stub IdP (the W2 harness shape) ---------------------------------------

const ISSUER = "https://idp.example.com";

async function generateRs256(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) throw new Error("keygen did not return a pair");
  return {
    privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
    publicJwk: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey,
  };
}

interface StubIdp {
  tokenResponse: Record<string, unknown> | null;
  fetchImpl: typeof fetch;
}

async function stubIdp(): Promise<StubIdp> {
  const idp: StubIdp = { tokenResponse: null, fetchImpl: (): Promise<Response> => Promise.reject(new Error("unreached")) };
  const rs = await generateRs256();
  const { importSigningKey } = await import("../../services/oauth2/jws");
  const key = await importSigningKey("RS256", rs.privateJwk);
  idp.fetchImpl = (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(`${ISSUER}/.well-known/openid-configuration`)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks.json`,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url === `${ISSUER}/jwks.json`) {
      // The PUBLIC half the verifier kid-matches (the W2 stub's shape).
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [{ ...rs.publicJwk, kid: "k1", alg: "RS256" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url === `${ISSUER}/token`) {
      return Promise.resolve(new Response(JSON.stringify(idp.tokenResponse ?? {}), { status: 200, headers: { "content-type": "application/json" } }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  // The signed id_token mints lazily per test (the claims carry the dance
  // nonce, only knowable after the start leg).
  (idp as StubIdp & { _key?: typeof key })._key = key;
  return idp;
}

async function signIdToken(idp: StubIdp, claims: Record<string, unknown>): Promise<string> {
  const key = (idp as StubIdp & { _key?: CryptoKey })._key!;
  const { signJws } = await import("../../services/oauth2/jws");
  return signJws({ alg: "RS256", key, claims, kid: "k1" });
}

const baseClaims = (): Record<string, unknown> => ({
  iss: ISSUER,
  aud: "client-id",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000) - 5,
  sub: "sub-123",
  email: "jane@example.com",
  name: "Jane Doe",
  preferred_username: "jane",
});

// -- fixtures -------------------------------------------------------------------

let idp: StubIdp;
let linkRouter: ReturnType<typeof createLinkAccountRouter>;
// The W2 flow router — the re-dance's other half (the ladders run through it).
let flowRouter: ReturnType<typeof createOAuth2LoginRouter>;

/** The gate is DETERMINISTIC in the tests: the operator's local generated
 *  env may carry ALLOW_SIGNUP either way, so both arms pin the polarity
 *  explicitly (the first-run.test.ts annotated testEnv pattern — no casts). */
type GateTestEnv = Omit<typeof env, "ALLOW_SIGNUP"> & { ALLOW_SIGNUP?: string };
const SIGNUP_ENV: GateTestEnv = { ...env, ALLOW_SIGNUP: "true" };
const CLOSED_ENV: GateTestEnv = { ...env, ALLOW_SIGNUP: "false" };

beforeEach(async () => {
  await applyAuthD1Migrations();
  // `two_factor` + `webauthn_credentials` ride the signin arm's 2FA gate
  // (the describe below).
  for (const table of ["external_login_user", "login_source", "sessions", "users", "personal_access_tokens", "two_factor", "webauthn_credentials"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  idp = await stubIdp();
  linkRouter = createLinkAccountRouter();
  flowRouter = createOAuth2LoginRouter({ fetchImpl: idp.fetchImpl });
});

/** The link-router request (an optional env override for the gate pins) —
 *  the session.test.ts shape (an explicit Request through router.fetch):
 *  Hono's `request(path, init, env)` convenience drops the POST body in
 *  this workerd pool, so the form arms would parse EMPTY. */
const req = async (path: string, init?: RequestInit, envOverride?: GateTestEnv): Promise<Response> =>
  linkRouter.fetch(new Request(path, init), envOverride ?? env);

/** The W2 flow-router request (the dance legs). */
const freq = async (path: string, init?: RequestInit): Promise<Response> => flowRouter.fetch(new Request(path, init), env);

async function seedUserRow(options: { name: string; email?: string; status?: "active" | "prohibited" }): Promise<number> {
  const result = await env.DB
    .prepare("INSERT INTO users (username, username_lower, email, status, type, created_at) VALUES (?, ?, ?, ?, 'user', unixepoch())")
    .bind(options.name, options.name.toLowerCase(), options.email ?? null, options.status ?? "active")
    .run();
  return Number(result.meta.last_row_id);
}

async function seedOidcSource(name = "OIDC"): Promise<{ id: number; name: string }> {
  const cfg = serializeOAuth2SourceConfig({
    v: 1,
    provider: "openidConnect",
    clientId: "client-id",
    clientSecret: "client-secret",
    discoveryUrl: ISSUER,
  });
  const row = await createLoginSource(env.DB, { type: LoginSourceType.OAuth2, name, isActive: true, cfg });
  const check = await getActiveOAuth2SourceByName(env.DB, name);
  console.log("SEED-CHECK:", JSON.stringify(row), "lookup:", check === null ? "MISS" : `hit ${check.id}`);
  return { id: row.id, name: row.name };
}

async function mintPat(userId: number, scopes = "all"): Promise<string> {
  return (await new TokenService(env.DB).mint({ userId, name: "link-arm", scopes })).plaintext;
}

const sessionCount = async (): Promise<number> => {
  const { results } = await env.DB.prepare("SELECT count(*) AS n FROM sessions").all<{ n: number }>();
  return results[0]?.n ?? 0;
};

/** Form-post the signin/signup arms. */
function formPost(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

/** Run the anonymous dance up to the link-page redirect; returns the hints
 *  the callback parked on the redirect (the W2 anonymous-miss arm). */
async function runToLinkPage(redirectTarget?: string): Promise<URL> {
  const startQuery = redirectTarget !== undefined ? `?redirect_to=${encodeURIComponent(redirectTarget)}` : "";
  const start = await freq(`https://app.example.com/user/oauth2/OIDC${startQuery}`);
  expect(start.status).toBe(303);
  const danceCookie = (start.headers.get("set-cookie") ?? "")
    .split(/(?=gitea_oauth2_state=)/)
    .find((directive) => directive.includes(OAUTH2_DANCE_COOKIE_NAME) && !directive.includes("Max-Age=0"));
  expect(danceCookie).toBeDefined();
  const authorizeUrl = new URL(start.headers.get("location")!);
  const state = authorizeUrl.searchParams.get("state") ?? "";

  idp.tokenResponse = {
    access_token: "at",
    token_type: "Bearer",
    id_token: await signIdToken(idp, { ...baseClaims(), nonce: authorizeUrl.searchParams.get("nonce") }),
  };
  const callback = await freq(`https://app.example.com/user/oauth2/OIDC/callback?code=the-code&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `${OAUTH2_DANCE_COOKIE_NAME}=${danceCookie!.split(";")[0]!.split("=").slice(1).join("=")}` },
  });
  expect(callback.status).toBe(303);
  const location = callback.headers.get("location")!;
  expect(location.startsWith("/user/link_account?")).toBe(true);
  return new URL(`https://app.example.com${location}`);
}

// ---------------------------------------------------------------------------
// The GET page
// ---------------------------------------------------------------------------

describe("GET /user/link_account (link_account.tmpl at the pin)", () => {
  it("the bare page renders both tabs with the signup tab active and empty prefills", async () => {
    const res = await req("https://app.example.com/user/link_account", undefined, SIGNUP_ENV);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content user link-account");
    expect(html).toContain(linkAccountLocale.signup_tab);
    expect(html).toContain(linkAccountLocale.signin_tab);
    expect(html).toContain('class="item active" data-tab="auth-link-signup-tab"');
    expect(html).toContain('class="item" data-tab="auth-link-signin-tab"');
    expect(html).toContain('action="/user/link_account_signup"');
    expect(html).toContain('action="/user/link_account_signin"');
    expect(html).toContain(linkAccountLocale.signup_title);
    expect(html).toContain(linkAccountLocale.signin_title);
    expect(html).toContain(linkAccountLocale.signup_submit);
    expect(html).toContain(linkAccountLocale.signin_submit);
    // No parked identity exists: the email prefills EMPTY (the module
    // header's reduction), the username hint is empty too.
    expect(html).not.toContain('value="jane"');
  });

  it("the untrusted hints prefill: the username hint sanitized, the source + validated target into the hidden inputs", async () => {
    const res = await req(
      "https://app.example.com/user/link_account?oauth2_source=OIDC&oauth2_username_hint=" +
        encodeURIComponent("ja ne!x") +
        "&redirect_to=%2Fafter",
      undefined,
      SIGNUP_ENV,
    );
    const html = await res.text();
    // sanitizeSuggestedUsername: the space and '!' become underscores, the
    // leading run strips.
    expect(html).toContain('name="user_name" type="text" value="ja_ne_x"');
    expect(html).toContain('name="oauth2_source" value="OIDC"');
    expect(html).toContain('name="redirect_to" value="/after"');
  });

  it("an off-site redirect_to hint validates away (the hidden input renders empty)", async () => {
    const res = await req(
      "https://app.example.com/user/link_account?oauth2_source=OIDC&redirect_to=" + encodeURIComponent("https://evil.example/phish"),
      undefined,
      SIGNUP_ENV,
    );
    const html = await res.text();
    expect(html).toContain('name="redirect_to" value=""');
    expect(html).not.toContain("evil.example");
  });

  it("the user_exists probe flips the SIGNIN tab active (linkaccount.go:85-94's username arm)", async () => {
    await seedUserRow({ name: "jane" });
    const res = await req(
      "https://app.example.com/user/link_account?oauth2_source=OIDC&oauth2_username_hint=jane",
      undefined,
      SIGNUP_ENV,
    );
    const html = await res.text();
    expect(html).toContain('class="item" data-tab="auth-link-signup-tab"');
    expect(html).toContain('class="item active" data-tab="auth-link-signin-tab"');
    expect(html).toContain('class="ui tab" data-tab="auth-link-signup-tab"');
    expect(html).toContain('class="ui tab active" data-tab="auth-link-signin-tab"');
  });

  it("ALLOW_SIGNUP closed renders NO signup tab (the gate's render half)", async () => {
    const res = await req("https://app.example.com/user/link_account", undefined, CLOSED_ENV);
    const html = await res.text();
    expect(html).not.toContain("auth-link-signup-tab");
    expect(html).not.toContain(linkAccountLocale.signup_tab);
    expect(html).toContain('action="/user/link_account_signin"');
  });

  it("the render passes the a11y smoke (SPEC §8)", async () => {
    const res = await req("https://app.example.com/user/link_account?oauth2_source=OIDC&oauth2_username_hint=jane", undefined, SIGNUP_ENV);
    expect(runA11y(await res.text())).toEqual([]);
  });

  it("the loader seam: the sanitized hint + the probe + the option overrides", async () => {
    await seedUserRow({ name: "bob" });
    const data = await loadLinkAccountPageData(env.DB, {
      oauth2Source: "OIDC",
      oauth2UsernameHint: "Bob",
      redirectTo: "/x",
    });
    expect(data.userName).toBe("Bob");
    expect(data.activeTab).toBe("signin"); // bob exists (the probe lowercases too)
    const stranger = await loadLinkAccountPageData(env.DB, {
      oauth2Source: "OIDC",
      oauth2UsernameHint: "nobody",
      redirectTo: "/x",
    });
    expect(stranger.activeTab).toBe("signup");
    const withOptions = await loadLinkAccountPageData(
      env.DB,
      { oauth2Source: "OIDC", oauth2UsernameHint: "", redirectTo: "" },
      { allowSignup: false, error: "boom", typedEmail: "typed@x" },
    );
    expect(withOptions).toMatchObject({ allowSignup: false, error: "boom", email: "typed@x", activeTab: "signup" });
  });
});

// ---------------------------------------------------------------------------
// The signin arm — the full ladder + the failure matrix
// ---------------------------------------------------------------------------

describe("POST /user/link_account_signin (LinkAccountPostSignIn's ladder)", () => {
  it("FULL LADDER e2e: dance → link page → valid PAT → re-dance → the callback links the IdP-RE-ASSERTED identity onto returnTo", async () => {
    const source = await seedOidcSource();
    const userId = await seedUserRow({ name: "jane", email: "jane@example.com" });
    const pat = await mintPat(userId);
    const before = await sessionCount();

    // Step 1-2: the anonymous dance dies at the ladder's miss arm — the
    // link page redirect.
    const linkPage = await runToLinkPage("/after");
    expect(linkPage.searchParams.get("oauth2_username_hint")).toBe("jane");

    // Step 3: the signin arm — the PAT + username cross-check.
    const post = await req(
      "https://app.example.com/user/link_account_signin",
      formPost({
        user_name: "jane",
        password: pat,
        oauth2_source: linkPage.searchParams.get("oauth2_source") ?? "",
        redirect_to: linkPage.searchParams.get("redirect_to") ?? "",
      }),
    );
    expect(post.status).toBe(303);
    // The re-dance contract string (W2's recorded shape): the target + the
    // continuation marker, the source NAME riding the path.
    expect(post.headers.get("location")).toBe("/user/oauth2/OIDC?redirect_to=%2Fafter&oauth2_continue=signin-link");
    // A FRESH session row minted (the fixation posture) + the cookie set.
    expect(await sessionCount()).toBe(before + 1);
    const sessionCookie = (post.headers.get("set-cookie") ?? "").split(";")[0]!;

    // Step 4: the re-dance — the start leg parks the state on the NEW
    // session's row carrier and the marker rides the parked state.
    const start = await freq(`https://app.example.com${post.headers.get("location")}`, {
      headers: { cookie: sessionCookie },
    });
    expect(start.status).toBe(303);
    const authorizeUrl = new URL(start.headers.get("location")!);

    // Step 5: the callback — the IdP re-asserts (the same sub) and the
    // signed-in doer arm completes the LINK (the marker discriminates: the
    // destination is the parked returnTo, NOT settings/security).
    const cookieValue = sessionCookie.split("=")[1]!;
    const sessionId = cookieValue.slice(0, cookieValue.indexOf(":"));
    const { results } = await env.DB
      .prepare("SELECT oauth2_login_state FROM sessions WHERE id = ?")
      .bind(sessionId)
      .all<{ oauth2_login_state: string | null }>();
    const parked = JSON.parse(results[0]!.oauth2_login_state!) as { expectedState: string; nonce: string; continue: string };
    expect(parked.continue).toBe("signin-link");
    expect(parked.expectedState).toBe(authorizeUrl.searchParams.get("state"));

    idp.tokenResponse = {
      access_token: "at",
      token_type: "Bearer",
      id_token: await signIdToken(idp, { ...baseClaims(), nonce: parked.nonce }),
    };
    const done = await freq(
      `https://app.example.com/user/oauth2/OIDC/callback?code=the-code&state=${encodeURIComponent(parked.expectedState)}`,
      { headers: { cookie: sessionCookie } },
    );
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/after");
    const { results: links } = await env.DB
      .prepare("SELECT user_id FROM external_login_user WHERE external_id = ? AND login_source_id = ?")
      .bind("sub-123", String(source.id))
      .all<{ user_id: number }>();
    expect(links[0]?.user_id).toBe(userId);
  });

  it("a wrong credential re-renders at 200 with the incorrect message; no session minted", async () => {
    await seedOidcSource();
    const userId = await seedUserRow({ name: "jane" });
    await mintPat(userId);
    const before = await sessionCount();

    const post = await req(
      "https://app.example.com/user/link_account_signin",
      formPost({ user_name: "jane", password: "gitea_wrong_token", oauth2_source: "OIDC" }),
    );
    expect(post.status).toBe(200);
    const html = await post.text();
    expect(html).toContain(linkAccountLocale.username_password_incorrect);
    expect(html).toContain('class="ui tab active" data-tab="auth-link-signin-tab"'); // the failed arm's tab
    expect(await sessionCount()).toBe(before);
  });

  it("a valid token with a MISMATCHED username is the incorrect arm (the owner cross-check)", async () => {
    await seedOidcSource();
    const userId = await seedUserRow({ name: "jane" });
    const pat = await mintPat(userId);
    const post = await req(
      "https://app.example.com/user/link_account_signin",
      formPost({ user_name: "mallory", password: pat, oauth2_source: "OIDC" }),
    );
    expect(post.status).toBe(200);
    expect(await post.text()).toContain(linkAccountLocale.username_password_incorrect);
  });

  it("a scope-less PAT answers the scope arm (the login POST's capability gate)", async () => {
    await seedOidcSource();
    const userId = await seedUserRow({ name: "jane" });
    const pat = await mintPat(userId, "write:package");
    const post = await req(
      "https://app.example.com/user/link_account_signin",
      formPost({ user_name: "jane", password: pat, oauth2_source: "OIDC" }),
    );
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("The token cannot sign in");
  });

  it("a prohibited account's PAT answers the prohibited arm", async () => {
    await seedOidcSource();
    // The email matters: a prohibited EMAIL-LESS row is exactly the
    // migration-seeded SYSTEM shape (services/user-accounts.ts's
    // NON_SYSTEM_USER_ROW), so it would keep the init window open and the
    // guard would outrank the ladder. A prohibit-logged HUMAN (email set)
    // closes the window — the service's recorded premise.
    const userId = await seedUserRow({ name: "suspended", status: "prohibited", email: "suspended@example.com" });
    const pat = await mintPat(userId);
    const post = await req(
      "https://app.example.com/user/link_account_signin",
      formPost({ user_name: "suspended", password: pat, oauth2_source: "OIDC" }),
    );
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("prohibited from signing in");
  });

  it("the init-window guard runs FIRST — an open window 303s /user/login before credential work", async () => {
    await seedOidcSource();
    // NO user rows: the zero-user window is open. A VALID-looking post
    // (wrong source, wrong credential — neither may be consulted).
    const post = await req(
      "https://app.example.com/user/link_account_signin",
      formPost({ user_name: "x", password: "gitea_nope", oauth2_source: "NOPE" }),
    );
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/user/login");
    expect(await sessionCount()).toBe(0);
  });

  it("an unknown/deactivated source hint answers the 404 shell (the hint is untrusted)", async () => {
    const userId = await seedUserRow({ name: "jane" });
    const pat = await mintPat(userId);

    await seedOidcSource("Sleepy");
    await env.DB.prepare("UPDATE login_source SET is_active = 0 WHERE name = 'Sleepy'").run();
    for (const sourceName of ["Ghost", "Sleepy"]) {
      const post = await req(
        "https://app.example.com/user/link_account_signin",
        formPost({ user_name: "jane", password: pat, oauth2_source: sourceName }),
      );
      expect(post.status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// The signup arm — the full ladder + the gate matrix
// ---------------------------------------------------------------------------

describe("POST /user/link_account_signup (LinkAccountPostRegister's ladder)", () => {
  it("FULL LADDER e2e: dance → link page → signup → the account creates + the re-dance links it", async () => {
    const source = await seedOidcSource();
    // A human row exists (the instance is past the init window): the
    // anonymous-miss arm is unreachable on a zero-user instance (no admin
    // ⇒ no sources), so the ladder's precondition is a closed window.
    await seedUserRow({ name: "seed-admin", email: "seed@example.com" });
    const before = await sessionCount();

    const linkPage = await runToLinkPage("/welcome");
    const post = await req(
      "https://app.example.com/user/link_account_signup",
      formPost({
        user_name: "external-jane",
        email: "external-jane@example.com",
        oauth2_source: linkPage.searchParams.get("oauth2_source") ?? "",
        redirect_to: linkPage.searchParams.get("redirect_to") ?? "",
      }),
      SIGNUP_ENV,
    );
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/user/oauth2/OIDC?redirect_to=%2Fwelcome&oauth2_continue=signup");

    // The account: created active, non-admin, through the shared ladder.
    const { results: rows } = await env.DB
      .prepare("SELECT id, is_admin, status, type FROM users WHERE username_lower = 'external-jane'")
      .all<{ id: number; is_admin: number; status: string; type: string }>();
    const created = rows[0]!;
    expect(created.status).toBe("active");
    expect(created.is_admin).toBe(0);
    expect(created.type).toBe("user");
    expect(await sessionCount()).toBe(before + 1);
    const sessionCookie = (post.headers.get("set-cookie") ?? "").split(";")[0]!;

    // The re-dance completes the link onto the NEW account.
    const start = await freq(`https://app.example.com${post.headers.get("location")}`, {
      headers: { cookie: sessionCookie },
    });
    expect(start.status).toBe(303);
    const cookieValue = sessionCookie.split("=")[1]!;
    const { results } = await env.DB
      .prepare("SELECT oauth2_login_state FROM sessions WHERE id = ?")
      .bind(cookieValue.slice(0, cookieValue.indexOf(":")))
      .all<{ oauth2_login_state: string | null }>();
    const parked = JSON.parse(results[0]!.oauth2_login_state!) as { expectedState: string; nonce: string; continue: string };
    expect(parked.continue).toBe("signup");
    idp.tokenResponse = {
      access_token: "at",
      token_type: "Bearer",
      id_token: await signIdToken(idp, { ...baseClaims(), nonce: parked.nonce }),
    };
    const done = await freq(
      `https://app.example.com/user/oauth2/OIDC/callback?code=the-code&state=${encodeURIComponent(parked.expectedState)}`,
      { headers: { cookie: sessionCookie } },
    );
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/welcome");
    const { results: links } = await env.DB
      .prepare("SELECT user_id FROM external_login_user WHERE external_id = ? AND login_source_id = ?")
      .bind("sub-123", String(source.id))
      .all<{ user_id: number }>();
    expect(links[0]?.user_id).toBe(created.id);
  });

  it("ALLOW_SIGNUP closed 404s the POST (the gate's exact polarity) — no account row", async () => {
    await seedOidcSource();
    await seedUserRow({ name: "seed-admin", email: "seed@example.com" }); // close the init window
    const post = await req(
      "https://app.example.com/user/link_account_signup",
      formPost({ user_name: "jane", email: "jane@example.com", oauth2_source: "OIDC" }),
      CLOSED_ENV,
    );
    expect(post.status).toBe(404);
    const { results } = await env.DB.prepare("SELECT id FROM users WHERE username_lower = 'jane'").all();
    expect(results).toHaveLength(0);
  });

  it("the taken-name / used-email / invalid arms re-render at 200 (the shared ladder's messages)", async () => {
    await seedOidcSource();
    await seedUserRow({ name: "jane", email: "jane@example.com" });

    const nameTaken = await req(
      "https://app.example.com/user/link_account_signup",
      formPost({ user_name: "Jane", email: "other@example.com", oauth2_source: "OIDC" }),
      SIGNUP_ENV,
    );
    expect(nameTaken.status).toBe(200);
    expect(await nameTaken.text()).toContain("The username is already taken.");

    const emailTaken = await req(
      "https://app.example.com/user/link_account_signup",
      formPost({ user_name: "other", email: "jane@example.com", oauth2_source: "OIDC" }),
      SIGNUP_ENV,
    );
    expect(emailTaken.status).toBe(200);
    expect(await emailTaken.text()).toContain("The email address is already used.");

    const invalid = await req(
      "https://app.example.com/user/link_account_signup",
      formPost({ user_name: "x", email: "not-an-email", oauth2_source: "OIDC" }),
      SIGNUP_ENV,
    );
    expect(invalid.status).toBe(200);
    const html = await invalid.text();
    expect(html).toContain("email address is invalid");
    expect(html).toContain('value="not-an-email"'); // the typed value re-fills
    expect(html).toContain('class="ui tab active" data-tab="auth-link-signup-tab"');
  });

  it("the init-window guard outranks the ALLOW_SIGNUP gate (the guard-first order)", async () => {
    await seedOidcSource();
    // Zero human rows: the window is open, SIGNUP_ENV is armed — the guard
    // wins with the login redirect, the gate's 404 never fires.
    const post = await req(
      "https://app.example.com/user/link_account_signup",
      formPost({ user_name: "x", email: "x@example.com", oauth2_source: "OIDC" }),
      SIGNUP_ENV,
    );
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/user/login");
  });

  it("an unknown source hint answers the 404 shell", async () => {
    await seedUserRow({ name: "seed" }); // close the init window
    const post = await req(
      "https://app.example.com/user/link_account_signup",
      formPost({ user_name: "x", email: "x@example.com", oauth2_source: "Ghost" }),
      SIGNUP_ENV,
    );
    expect(post.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// THE SIGNIN ARM'S 2FA GATE — oauth2LinkAccount's deliberate
// HasTwoFactorOrWebAuthn check (linkaccount.go:149-176, "We deliberately
// ignore the skip local 2fa setting here because we are linking to a
// previous user here"): an enrolled user's verified PAT does NOT mint a
// session. The park is ui/session.ts's login-gate pattern (the WebAuthn
// pending carrier / the `gitea_twofa` gate ticket / the dual-carrier park)
// with the RE-DANCE URL parked as the post-gate target, so the gate's mint
// arms (sessionRouter's POST /user/two_factor, the webauthn assertion)
// resume at the dance start leg and the callback completes the link
// post-assertion — our substrate's completePendingLinks
// (linkaccount.go:265-272's parity).
// ---------------------------------------------------------------------------

/** The mint arms' app: the sessionRouter registration shape (the TOTP gate
 *  half of the completion chain). */
const gateApp = new Hono<{ Bindings: Env }>();
gateApp.route("/", sessionRouter);
const greq = async (path: string, init?: RequestInit): Promise<Response> => {
  const context = createExecutionContext();
  const response = await gateApp.fetch(new Request(`https://app.example.com${path}`, init), env, context);
  await waitOnExecutionContext(context);
  return response;
};

/** The webauthn router (the assertion legs). The RP derives from the
 *  request URL — router.request synthesizes http://localhost, the origin
 *  the fixtures sign for (webauthn.test.ts's posture). */
const webRouter = createWebAuthnRouter();
const wreq = async (path: string, init?: RequestInit): Promise<Response> => webRouter.request(path, init, env);

/** Split a multi-directive Set-Cookie header (our directives carry no
 *  Expires dates, so `, ` splits cleanly — session.test.ts's shape). */
function setCookieDirectives(response: Response): string[] {
  const header = response.headers.get("set-cookie") ?? "";
  return header === "" ? [] : header.split(/, (?=[A-Za-z0-9_-]+=)/);
}

/** The FIRST directive's value for `name` (undefined when the cookie is
 *  absent). */
function cookieValueOf(response: Response, name: string): string | undefined {
  for (const directive of setCookieDirectives(response)) {
    const pair = directive.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim() === name) return pair.slice(at + 1);
  }
  return undefined;
}

/** A live TOTP enrollment through the REAL enrollment seam (the session
 *  suite's seedEnrolled shape — the secret never touches a constant). */
async function enrollTotp(userId: number): Promise<string> {
  const secret = generateTotpSecret();
  const ticket = await mintPendingTicket(env.DB, { kind: "enroll", secret });
  const outcome = await applyTwofaEnrollment(env.DB, userId, await totpCode(secret, Date.now() / 1000), ticket);
  if (outcome.outcome !== "enrolled") throw new Error(`totp fixture failed: ${outcome.outcome}`);
  return secret;
}

/** An enrolled WebAuthn credential row over a REAL EC fixture (the
 *  assertion ladder verifies signatures — synthetic-key bytes). */
async function enrollWebAuthn(userId: number, ec: EcFixture): Promise<Uint8Array> {
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  await createCredential(env.DB, userId, "link key", {
    credentialId,
    coseKey: ec.cose,
    publicKeyRaw: ec.coseBytes,
    attestationType: "none",
    aaguid: new Uint8Array(16),
    signCount: 0,
    transports: null,
    userPresent: true,
    userVerified: true,
  });
  return credentialId;
}

/** The synthetic assertion body for the enrolled credential (webauthn.test.ts's
 *  helper shape): UP|UV flags, a count-1 signature over authData‖clientHash. */
async function assertionBody(ec: EcFixture, credentialId: Uint8Array, challenge: string): Promise<Record<string, unknown>> {
  const authData = await buildAuthData({ rpId: "localhost", flags: FLAG_UP | FLAG_UV, signCount: 1 });
  const clientData = clientDataJson("webauthn.get", challenge, "http://localhost");
  const clientHash = await sha256(clientData);
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData, 0);
  signed.set(clientHash, authData.length);
  const signature = await signWith(ec, signed);
  return buildAssertionResponse({ credentialId, authData, clientData, signature, userHandle: null });
}

/** The link-signin POST for the gate fixtures (the seeded user is `jane`). */
async function signinPost(pat: string): Promise<Response> {
  return req(
    "https://app.example.com/user/link_account_signin",
    formPost({ user_name: "jane", password: pat, oauth2_source: "OIDC", redirect_to: "/after" }),
  );
}

const DANCE_TARGET = "/user/oauth2/OIDC?redirect_to=%2Fafter&oauth2_continue=signin-link";

describe("the signin arm's 2FA gate (oauth2LinkAccount parity — the F1 fix)", () => {
  it("a TOTP-enrolled user does NOT mint: the park arms the gate ticket carrying the re-dance URL, 303 /user/two_factor", async () => {
    await seedOidcSource();
    const userId = await seedUserRow({ name: "jane", email: "jane@example.com" });
    const pat = await mintPat(userId);
    await enrollTotp(userId);
    const before = await sessionCount();

    const post = await signinPost(pat);
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/user/two_factor");
    // The bypass is closed: no session row, no session cookie.
    expect(await sessionCount()).toBe(before);
    expect(cookieValueOf(post, SESSION_COOKIE_NAME)).toBeUndefined();
    // The gate ticket decodes with the parked principal AND the pending-link
    // state (the re-dance URL is the post-gate target).
    const ticket = await verifyPendingTicket(env.DB, cookieValueOf(post, TWOFA_COOKIE_NAME) ?? "", "gate");
    expect(ticket).toEqual({ kind: "gate", userId, remember: false, redirectTo: DANCE_TARGET });
  });

  it("a DUAL enrollment parks BOTH carriers at the webauthn prompt (handleTwoFactorRequired's hasWebAuthn-first order)", async () => {
    await seedOidcSource();
    const userId = await seedUserRow({ name: "jane", email: "jane@example.com" });
    const pat = await mintPat(userId);
    await enrollTotp(userId);
    await enrollWebAuthn(userId, await makeEcFixture());

    const post = await signinPost(pat);
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/user/webauthn");
    expect(await sessionCount()).toBe(0);
    // The pending carrier: the pre-auth principal + the dance target.
    const pending = await verifyCeremonyState(env.DB, cookieValueOf(post, WEBAUTHN_COOKIE_NAME) ?? "", "pending");
    expect(pending).toMatchObject({ k: "pending", uid: userId, ch: "", rem: false, to: DANCE_TARGET });
    // The gate ticket rides beside it (the TOTP fallback's authority).
    const ticket = await verifyPendingTicket(env.DB, cookieValueOf(post, TWOFA_COOKIE_NAME) ?? "", "gate");
    expect(ticket).toMatchObject({ kind: "gate", userId, remember: false, redirectTo: DANCE_TARGET });
  });

  it("a WebAuthn-only enrollment parks the pending carrier alone, 303 /user/webauthn, no ticket", async () => {
    await seedOidcSource();
    const userId = await seedUserRow({ name: "jane", email: "jane@example.com" });
    const pat = await mintPat(userId);
    await enrollWebAuthn(userId, await makeEcFixture());

    const post = await signinPost(pat);
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/user/webauthn");
    expect(await sessionCount()).toBe(0);
    const pending = await verifyCeremonyState(env.DB, cookieValueOf(post, WEBAUTHN_COOKIE_NAME) ?? "", "pending");
    expect(pending).toMatchObject({ k: "pending", uid: userId, to: DANCE_TARGET });
    expect(cookieValueOf(post, TWOFA_COOKIE_NAME)).toBeUndefined();
  });

  it("COMPLETION via the TOTP gate: the passcode mints AND resumes the re-dance; the callback links the re-asserted identity onto returnTo", async () => {
    const source = await seedOidcSource();
    const userId = await seedUserRow({ name: "jane", email: "jane@example.com" });
    const pat = await mintPat(userId);
    const secret = await enrollTotp(userId);

    const park = await signinPost(pat);
    const gateCookie = `${TWOFA_COOKIE_NAME}=${cookieValueOf(park, TWOFA_COOKIE_NAME)}`;
    const submit = await greq("/user/two_factor", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: gateCookie },
      body: new URLSearchParams({ passcode: await totpCode(secret, Date.now() / 1000) }).toString(),
    });
    expect(submit.status).toBe(303);
    // The mint arm resumed at the parked target — the dance start leg — and
    // the fresh session cookie rides it.
    expect(submit.headers.get("location")).toBe(DANCE_TARGET);
    expect(await sessionCount()).toBe(1);
    const sessionCookie = cookieValueOf(submit, SESSION_COOKIE_NAME);
    expect(sessionCookie).toBeDefined();
    // the gate carrier died with the mint (the Max-Age=0 clear directive)
    expect(setCookieDirectives(submit).some((directive) => directive.startsWith(`${TWOFA_COOKIE_NAME}=; Path=/; Max-Age=0`))).toBe(true);

    // The dance completes the link onto the GATE-MINTED session (the W2
    // chain — our completePendingLinks).
    const bearer = `${SESSION_COOKIE_NAME}=${sessionCookie}`;
    const start = await freq(`https://app.example.com${submit.headers.get("location")}`, { headers: { cookie: bearer } });
    expect(start.status).toBe(303);
    const { results } = await env.DB.prepare("SELECT oauth2_login_state FROM sessions").all<{ oauth2_login_state: string | null }>();
    const parked = JSON.parse(results[0]!.oauth2_login_state!) as { expectedState: string; nonce: string; continue: string };
    expect(parked.continue).toBe("signin-link");
    idp.tokenResponse = {
      access_token: "at",
      token_type: "Bearer",
      id_token: await signIdToken(idp, { ...baseClaims(), nonce: parked.nonce }),
    };
    const done = await freq(
      `https://app.example.com/user/oauth2/OIDC/callback?code=the-code&state=${encodeURIComponent(parked.expectedState)}`,
      { headers: { cookie: bearer } },
    );
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/after");
    const { results: links } = await env.DB
      .prepare("SELECT user_id FROM external_login_user WHERE external_id = ? AND login_source_id = ?")
      .bind("sub-123", String(source.id))
      .all<{ user_id: number }>();
    expect(links[0]?.user_id).toBe(userId);
  });

  it("COMPLETION via the WebAuthn gate: the assertion mints AND answers the re-dance; the link completes", async () => {
    const source = await seedOidcSource();
    const userId = await seedUserRow({ name: "jane", email: "jane@example.com" });
    const pat = await mintPat(userId);
    const ec = await makeEcFixture();
    const credentialId = await enrollWebAuthn(userId, ec);

    const park = await signinPost(pat);
    const pending = cookieValueOf(park, WEBAUTHN_COOKIE_NAME)!;
    const optionsRes = await wreq("/user/webauthn/assertion", {
      headers: { cookie: `${WEBAUTHN_COOKIE_NAME}=${encodeURIComponent(pending)}` },
    });
    expect(optionsRes.status).toBe(200);
    const assertCookie = (optionsRes.headers.get("set-cookie") ?? "").split(";")[0]!;
    const state = await verifyCeremonyState(env.DB, decodeURIComponent(assertCookie.split("=").slice(1).join("=")), "assert");
    expect(state).not.toBeNull();
    const verifyRes = await wreq("/user/webauthn/assertion", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        cookie: `${WEBAUTHN_COOKIE_NAME}=${encodeURIComponent(pending)}; ${assertCookie}`,
      },
      body: JSON.stringify(await assertionBody(ec, credentialId, state!.ch)),
    });
    expect(verifyRes.status).toBe(200);
    // The mint arm answered the parked dance target.
    expect((await verifyRes.json<{ redirect: string }>()).redirect).toBe(DANCE_TARGET);
    expect(await sessionCount()).toBe(1);
    const cleared = verifyRes.headers.getSetCookie ? verifyRes.headers.getSetCookie() : [verifyRes.headers.get("set-cookie") ?? ""];
    const sessionDirective = cleared.find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(sessionDirective).toBeDefined();
    const sessionCookie = sessionDirective!.split(";")[0]!.split("=").slice(1).join("=");

    // The dance completes the link onto the GATE-MINTED session.
    const bearer = `${SESSION_COOKIE_NAME}=${sessionCookie}`;
    const start = await freq(`https://app.example.com${DANCE_TARGET}`, { headers: { cookie: bearer } });
    expect(start.status).toBe(303);
    const { results } = await env.DB.prepare("SELECT oauth2_login_state FROM sessions").all<{ oauth2_login_state: string | null }>();
    const parked = JSON.parse(results[0]!.oauth2_login_state!) as { expectedState: string; nonce: string; continue: string };
    expect(parked.continue).toBe("signin-link");
    idp.tokenResponse = {
      access_token: "at",
      token_type: "Bearer",
      id_token: await signIdToken(idp, { ...baseClaims(), nonce: parked.nonce }),
    };
    const done = await freq(
      `https://app.example.com/user/oauth2/OIDC/callback?code=the-code&state=${encodeURIComponent(parked.expectedState)}`,
      { headers: { cookie: bearer } },
    );
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/after");
    const { results: links } = await env.DB
      .prepare("SELECT user_id FROM external_login_user WHERE external_id = ? AND login_source_id = ?")
      .bind("sub-123", String(source.id))
      .all<{ user_id: number }>();
    expect(links[0]?.user_id).toBe(userId);
  });

  it("a non-enrolled user links directly — the happy path is byte-unchanged (no gate step, direct mint + re-dance)", async () => {
    await seedOidcSource();
    const userId = await seedUserRow({ name: "jane", email: "jane@example.com" });
    const pat = await mintPat(userId);

    const post = await signinPost(pat);
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe(DANCE_TARGET);
    expect(await sessionCount()).toBe(1);
    expect(cookieValueOf(post, SESSION_COOKIE_NAME)).toBeDefined();
    expect(cookieValueOf(post, TWOFA_COOKIE_NAME)).toBeUndefined();
    expect(cookieValueOf(post, WEBAUTHN_COOKIE_NAME)).toBeUndefined();
  });
});

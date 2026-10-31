/**
 * The OAuth2 client-flow suite (specs/external-auth-sources.md §8 "Flow"):
 * the /user/oauth2/{source} start + callback legs over REAL D1 with the
 * fetch-stub IdP and REAL WebCrypto-signed id_tokens. Pins: the honest 404
 * for unknown/inactive sources (the recorded §5.2 divergence), the state
 * dance round-trip on BOTH carriers (the session-row column for signed-in
 * visitors, the gitea_oauth2_state cookie for anonymous ones — the
 * identity.ts header's recorded adaptation), the errCallback flash mapping
 * (oauth.go:111-130 as /login?oauth2_error={code}), the ladder rungs
 * through the route (join hit ⇒ fresh-row mint + returnTo; signed-in link
 * arm ⇒ settings/security; the re-dance continuation ⇒ returnTo; the
 * anonymous miss ⇒ the link-page redirect with untrusted hints), the
 * prohibited arm, the PathEscape'd source-name parity, and the one-time
 * state spend on every terminal outcome.
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { signJws, importSigningKey } from "../services/oauth2/jws";
import { serializeOAuth2SourceConfig } from "../services/auth-sources/cfg";
import { decodeOAuth2LoginState, OAUTH2_DANCE_COOKIE_NAME } from "../services/auth-sources/identity";
import { ensureExternalLogin, createLoginSource, LoginSourceType } from "../services/auth-sources/store";
import { mintSession, SESSION_COOKIE_NAME } from "../ui/session";
import { createOAuth2LoginRouter } from "./oauth2-login";

const ISSUER = "https://idp.example.com";

// -- the stub IdP -------------------------------------------------------------

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
  discovery: Record<string, unknown>;
  jwks: { keys: (JsonWebKey & { kid?: string })[] };
  /** Set per test AFTER the dance start (the nonce is only knowable then). */
  tokenResponse: Record<string, unknown> | null;
  calls: string[];
  fetchImpl: typeof fetch;
}

async function stubIdp(): Promise<StubIdp> {
  const rs = await generateRs256();
  const idp: StubIdp = {
    discovery: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks.json`,
    },
    jwks: { keys: [{ ...rs.publicJwk, kid: "k1", alg: "RS256" }] },
    tokenResponse: null,
    calls: [],
    fetchImpl: (): Promise<Response> => Promise.reject(new Error("unreached")),
  };
  const privateRs = rs.privateJwk;
  idp.fetchImpl = (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    idp.calls.push(url);
    if (url.startsWith(`${ISSUER}/.well-known/openid-configuration`)) {
      return Promise.resolve(new Response(JSON.stringify(idp.discovery), { status: 200, headers: { "content-type": "application/json" } }));
    }
    if (url === `${ISSUER}/jwks.json`) {
      return Promise.resolve(new Response(JSON.stringify(idp.jwks), { status: 200, headers: { "content-type": "application/json" } }));
    }
    if (url === `${ISSUER}/token`) {
      return Promise.resolve(new Response(JSON.stringify(idp.tokenResponse ?? {}), { status: 200, headers: { "content-type": "application/json" } }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  (idp as StubIdp & { _privateRs?: JsonWebKey })._privateRs = privateRs;
  return idp;
}

/** Mint the stub's id_token with the dance nonce the start leg parked. */
async function signIdToken(idp: StubIdp, claims: Record<string, unknown>): Promise<string> {
  const privateJwk = (idp as StubIdp & { _privateRs?: JsonWebKey })._privateRs!;
  const key = await importSigningKey("RS256", privateJwk);
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

// -- the fixture scaffolding --------------------------------------------------

let idp: StubIdp;
let router: ReturnType<typeof createOAuth2LoginRouter>;

beforeEach(async () => {
  await applyAuthD1Migrations();
  for (const table of ["external_login_user", "login_source", "sessions", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  idp = await stubIdp();
  router = createOAuth2LoginRouter({ fetchImpl: idp.fetchImpl });
});

/** Every route request carries the test env (Hono's request(input, init, env)). */
const req = async (path: string, init?: RequestInit): Promise<Response> => router.request(path, init, env);

async function seedUserRow(options: { name: string; status?: "active" | "prohibited"; email?: string }): Promise<number> {
  const result = await env.DB
    .prepare("INSERT INTO users (username, username_lower, email, status, type, created_at) VALUES (?, ?, ?, ?, 'user', unixepoch())")
    .bind(options.name, options.name.toLowerCase(), options.email ?? null, options.status ?? "active")
    .run();
  return Number(result.meta.last_row_id);
}

async function seedOidcSource(name = "OIDC", cfgExtra: Record<string, unknown> = {}): Promise<{ id: number; name: string }> {
  const cfg = serializeOAuth2SourceConfig({
    v: 1,
    provider: "openidConnect",
    clientId: "client-id",
    clientSecret: "client-secret",
    discoveryUrl: ISSUER,
    ...cfgExtra,
  });
  const row = await createLoginSource(env.DB, { type: LoginSourceType.OAuth2, name, isActive: true, cfg });
  return { id: row.id, name: row.name };
}

const sessionCount = async (): Promise<number> => {
  const { results } = await env.DB.prepare("SELECT count(*) AS n FROM sessions").all<{ n: number }>();
  return results[0]?.n ?? 0;
};

interface DanceStart {
  response: Response;
  authorizeUrl: URL;
  /** The state as the IdP echoes it. */
  stateParam: string;
  /** The parsed parked state (from whichever carrier the response carries). */
  parked: ReturnType<typeof decodeOAuth2LoginState>;
  /** The cookie jar to present at the callback. */
  cookieHeader: string | null;
}

/** Run the start leg and unpack the dance. */
async function startDance(options: { sourceName: string; sessionCookie?: string | null; startQuery?: string }): Promise<DanceStart> {
  const headers: Record<string, string> = {};
  if (options.sessionCookie) headers.cookie = `${SESSION_COOKIE_NAME}=${options.sessionCookie}`;
  const response = await req(
    `https://app.example.com/user/oauth2/${encodeURIComponent(options.sourceName)}${options.startQuery ?? ""}`,
    { headers },
  );
  expect(response.status).toBe(303);
  const location = response.headers.get("location");
  if (location === null || !location.startsWith("https://idp.example.com/authorize")) {
    return { response, authorizeUrl: new URL("https://idp.example.com/authorize"), stateParam: "", parked: null, cookieHeader: null };
  }
  const authorizeUrl = new URL(location);
  const stateParam = authorizeUrl.searchParams.get("state") ?? "";
  const danceCookie = response.headers.get("set-cookie")?.split("\n").find((directive) => directive.includes(OAUTH2_DANCE_COOKIE_NAME)) ?? null;
  const rawValue =
    danceCookie !== null && !danceCookie.includes("Max-Age=0")
      ? decodeURIComponent(danceCookie.split(";")[0]!.split("=").slice(1).join("="))
      : null;
  let parked = decodeOAuth2LoginState(rawValue);
  let cookieHeader = danceCookie !== null && !danceCookie.includes("Max-Age=0") ? `${OAUTH2_DANCE_COOKIE_NAME}=${danceCookie.split(";")[0]!.split("=").slice(1).join("=")}` : null;
  if (parked === null && options.sessionCookie) {
    const sessionId = options.sessionCookie.slice(0, options.sessionCookie.indexOf(":"));
    const { results } = await env.DB.prepare("SELECT oauth2_login_state FROM sessions WHERE id = ?").bind(sessionId).all<{ oauth2_login_state: string | null }>();
    parked = decodeOAuth2LoginState(results[0]?.oauth2_login_state ?? null);
    cookieHeader = `${SESSION_COOKIE_NAME}=${options.sessionCookie}`;
  }
  return { response, authorizeUrl, stateParam, parked, cookieHeader };
}

/** Complete the dance at the callback with a signed id_token. */
async function completeDance(start: DanceStart, options: { callbackQuery?: string; identityClaims?: Record<string, unknown> } = {}): Promise<Response> {
  const nonce = start.parked?.nonce;
  const claims = { ...baseClaims(), ...(options.identityClaims ?? {}) };
  if (nonce !== undefined) claims.nonce = nonce;
  idp.tokenResponse = { access_token: "at", token_type: "Bearer", id_token: await signIdToken(idp, claims) };
  const headers: Record<string, string> = {};
  if (start.cookieHeader !== null) headers.cookie = start.cookieHeader;
  return req(`https://app.example.com/user/oauth2/OIDC/callback?code=the-code&state=${encodeURIComponent(start.stateParam)}${options.callbackQuery ?? ""}`, {
    headers,
  });
}

function setCookieDirectives(response: Response): string[] {
  const raw = response.headers.get("set-cookie");
  return raw === null ? [] : raw.split(/(?=gitea_session=|gitea_oauth2_state=)/).map((directive) => directive.trim());
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

describe("the start leg (GET /user/oauth2/{source})", () => {
  it("unknown and inactive sources answer the honest 404 (the §5.2 divergence)", async () => {
    expect((await req("https://app.example.com/user/oauth2/nobody")).status).toBe(404);

    await seedOidcSource("Sleepy");
    await env.DB.prepare("UPDATE login_source SET is_active = 0 WHERE name = 'Sleepy'").run();
    expect((await req("https://app.example.com/user/oauth2/Sleepy")).status).toBe(404);
  });

  it("anonymous: 303 to the authorize URL with the full parameter set; the dance parks in the COOKIE", async () => {
    const source = await seedOidcSource();
    const start = await startDance({ sourceName: source.name, startQuery: "?redirect_to=%2Fsome%2Fpage" });

    expect(start.authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(start.authorizeUrl.searchParams.get("client_id")).toBe("client-id");
    expect(start.authorizeUrl.searchParams.get("redirect_uri")).toBe("https://app.example.com/user/oauth2/OIDC/callback");
    expect(start.authorizeUrl.searchParams.get("scope")).toBe("openid");
    expect(start.authorizeUrl.searchParams.get("nonce")).toMatch(/^[0-9a-f-]{36}$/);
    // The carrier round-trip: the cookie decodes to the parked state whose
    // expectedState IS the authorize URL's state param.
    expect(start.cookieHeader).toContain(OAUTH2_DANCE_COOKIE_NAME);
    expect(start.parked).toMatchObject({ sourceId: source.id, provider: "openidConnect", returnTo: "/some/page" });
    expect(start.parked?.expectedState).toBe(start.stateParam);
    expect(start.parked?.nonce).toBe(start.authorizeUrl.searchParams.get("nonce"));
  });

  it("a source name with a space resolves through the PathEscape'd href (the button parity)", async () => {
    const source = await seedOidcSource("My Source");
    const start = await startDance({ sourceName: source.name });
    expect(start.authorizeUrl.searchParams.get("client_id")).toBe("client-id");
    expect(start.parked?.sourceId).toBe(source.id);
  });

  it("the Referer fallback parks a same-origin non-/user/ path (rememberAuthRedirectLink)", async () => {
    const source = await seedOidcSource();
    const response = await req(`https://app.example.com/user/oauth2/${encodeURIComponent(source.name)}`, {
      headers: { referer: "https://app.example.com/whatever/feed" },
    });
    const directive = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
    const parked = decodeOAuth2LoginState(decodeURIComponent(directive.split("=").slice(1).join("=")));
    expect(parked?.returnTo).toBe("/whatever/feed");

    // A /user/ referer is skipped (upstream's auth-pages rule) — no park.
    const skipped = await req(`https://app.example.com/user/oauth2/${encodeURIComponent(source.name)}`, {
      headers: { referer: "https://app.example.com/user/login" },
    });
    const skippedDirective = (skipped.headers.get("set-cookie") ?? "").split(";")[0]!;
    const skippedParked = decodeOAuth2LoginState(decodeURIComponent(skippedDirective.split("=").slice(1).join("=")));
    expect(skippedParked?.returnTo).toBeUndefined();
  });

  it("signed-in: the dance parks on the SESSION ROW and the dance cookie is CLEARED (the row carrier wins)", async () => {
    const source = await seedOidcSource();
    const userId = await seedUserRow({ name: "jane", email: "jane@example.com" });
    const session = await mintSession(env.DB, userId);
    const start = await startDance({ sourceName: source.name, sessionCookie: session });

    const directives = setCookieDirectives(start.response);
    expect(directives.some((directive) => directive.startsWith(`${OAUTH2_DANCE_COOKIE_NAME}=;`) && directive.includes("Max-Age=0"))).toBe(true);
    const sessionId = session.slice(0, session.indexOf(":"));
    const { results } = await env.DB.prepare("SELECT oauth2_login_state FROM sessions WHERE id = ?").bind(sessionId).all<{ oauth2_login_state: string | null }>();
    const parked = decodeOAuth2LoginState(results[0]?.oauth2_login_state ?? null);
    expect(parked?.expectedState).toBe(start.stateParam);
  });

  it("a github source rides the W3 simple arm — the authorize redirect, no discovery, no nonce", async () => {
    const cfg = serializeOAuth2SourceConfig({ v: 1, provider: "github", clientId: "g", clientSecret: "s" });
    await createLoginSource(env.DB, { type: LoginSourceType.OAuth2, name: "GH", isActive: true, cfg });
    const response = await req("https://app.example.com/user/oauth2/GH");
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    // The registry's endpoint set straight (no discovery fetch); the dance
    // state parks with NO nonce; the source-NAME-bound redirect_uri.
    expect(location.startsWith("https://github.com/login/oauth/authorize?")).toBe(true);
    expect(location).toContain("client_id=g");
    expect(location).toContain(`redirect_uri=${encodeURIComponent("https://app.example.com/user/oauth2/GH/callback")}`);
    expect(location).not.toContain("nonce");
    expect(location).not.toContain("scope"); // no default scopes (user:email is auto-reg-deferred)
  });

  it("a discovery failure answers the failure arm (§7.5)", async () => {
    idp.discovery = { issuer: ISSUER }; // shape-incomplete
    const source = await seedOidcSource();
    const response = await req(`https://app.example.com/user/oauth2/${encodeURIComponent(source.name)}`);
    expect(response.headers.get("location")).toBe("/login?oauth2_error=internal");
  });
});

describe("the callback leg (GET /user/oauth2/{source}/callback)", () => {
  it("provider error params map to the errCallback codes (oauth.go:111-130)", async () => {
    const source = await seedOidcSource();
    const start = await startDance({ sourceName: source.name });

    for (const [providerError, expected] of [
      ["access_denied", "access_denied"],
      ["temporarily_unavailable", "temporarily_unavailable"],
      ["server_error", "internal"],
    ] as const) {
      const response = await req(`https://app.example.com/user/oauth2/OIDC/callback?error=${providerError}&state=${encodeURIComponent(start.stateParam)}`, {
        headers: start.cookieHeader ? { cookie: start.cookieHeader } : {},
      });
      expect(response.headers.get("location")).toBe(`/login?oauth2_error=${expected}`);
      // The state is spent and the carrier cleared: the browser adopts the
      // Max-Age=0 clearance, so the SECOND callback presents no cookie and
      // finds no carrier.
      const second = await req(`https://app.example.com/user/oauth2/OIDC/callback?code=x&state=${encodeURIComponent(start.stateParam)}`);
      expect(second.headers.get("location")).toBe("/login?oauth2_error=state");
      expect(setCookieDirectives(second).some((directive) => directive.includes(`${OAUTH2_DANCE_COOKIE_NAME}=;`))).toBe(true);
    }
  });

  it("the state compare: mismatch, absence, and a spent carrier all answer the state arm + cleared cookie", async () => {
    const source = await seedOidcSource();
    const start = await startDance({ sourceName: source.name });

    // Tampered state value.
    const tampered = await req(`https://app.example.com/user/oauth2/OIDC/callback?code=c&state=forged`, {
      headers: start.cookieHeader ? { cookie: start.cookieHeader } : {},
    });
    expect(tampered.headers.get("location")).toBe("/login?oauth2_error=state");
    expect(setCookieDirectives(tampered).some((directive) => directive.includes(`${OAUTH2_DANCE_COOKIE_NAME}=;`) && directive.includes("Max-Age=0"))).toBe(true);

    // No parked carrier at all (no cookie presented).
    const carrierless = await req(`https://app.example.com/user/oauth2/OIDC/callback?code=c&state=${encodeURIComponent(start.stateParam)}`);
    expect(carrierless.headers.get("location")).toBe("/login?oauth2_error=state");
  });

  it("anonymous + unlinked identity ⇒ the link-account redirect with the UNTRUSTED hints; no session minted", async () => {
    const source = await seedOidcSource();
    const start = await startDance({ sourceName: source.name, startQuery: "?redirect_to=%2Fafter" });
    const before = await sessionCount();

    const response = await completeDance(start);
    expect(response.status).toBe(303);
    const location = new URL("https://app.example.com" + response.headers.get("location"));
    expect(location.pathname).toBe("/user/link_account");
    expect(location.searchParams.get("oauth2_source")).toBe("OIDC");
    expect(location.searchParams.get("oauth2_username_hint")).toBe("jane"); // preferred_username wins the pre-fill
    expect(location.searchParams.get("redirect_to")).toBe("/after");
    expect(setCookieDirectives(response).some((directive) => directive.includes(`${OAUTH2_DANCE_COOKIE_NAME}=;`))).toBe(true);
    expect(await sessionCount()).toBe(before);
  });

  it("anonymous + LINKED identity ⇒ fresh-row mint (the fixation posture), last-login bump, returnTo redirect", async () => {
    const source = await seedOidcSource();
    const userId = await seedUserRow({ name: "jane", email: "jane@example.com" });
    await ensureExternalLogin(env.DB, { externalId: "sub-123", loginSourceId: source.id, userId, provider: "openidConnect" });

    const start = await startDance({ sourceName: source.name, startQuery: "?redirect_to=%2Frepo%2Ftrunk" });
    const before = await sessionCount();
    const response = await completeDance(start);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/repo/trunk");
    const directives = setCookieDirectives(response);
    expect(directives.some((directive) => directive.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
    expect(directives.some((directive) => directive.includes(`${OAUTH2_DANCE_COOKIE_NAME}=;`) && directive.includes("Max-Age=0"))).toBe(true);

    // A NEW session row per sign-in, and the last-login bump rode the mint.
    expect(await sessionCount()).toBe(before + 1);
    const { results } = await env.DB.prepare("SELECT last_login_at FROM users WHERE id = ?").bind(String(userId)).all<{ last_login_at: number }>();
    expect(results[0]?.last_login_at).not.toBeNull();
  });

  it("a prohibited linked identity signs into NOTHING (the mint-time posture)", async () => {
    const source = await seedOidcSource();
    const userId = await seedUserRow({ name: "suspended", status: "prohibited" });
    await ensureExternalLogin(env.DB, { externalId: "sub-123", loginSourceId: source.id, userId, provider: "openidConnect" });

    const start = await startDance({ sourceName: source.name });
    const before = await sessionCount();
    const response = await completeDance(start);
    expect(response.headers.get("location")).toBe("/login?oauth2_error=prohibited");
    expect(await sessionCount()).toBe(before);
  });

  it("signed-in doer + unknown identity ⇒ link to the CURRENT account + settings/security (oauth.go:133-141)", async () => {
    const source = await seedOidcSource();
    const userId = await seedUserRow({ name: "jane", email: "jane@example.com" });
    const session = await mintSession(env.DB, userId);
    const start = await startDance({ sourceName: source.name, sessionCookie: session });

    const response = await completeDance(start);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/user/settings/security");
    const { results } = await env.DB.prepare("SELECT user_id FROM external_login_user WHERE external_id = ?").bind("sub-123").all<{ user_id: number }>();
    expect(results[0]?.user_id).toBe(userId);
  });

  it("the re-dance continuation (W5's arms): the link completes onto the returnTo, NOT settings/security", async () => {
    const source = await seedOidcSource();
    const userId = await seedUserRow({ name: "jane", email: "jane@example.com" });
    const session = await mintSession(env.DB, userId);
    const start = await startDance({
      sourceName: source.name,
      sessionCookie: session,
      startQuery: `?redirect_to=${encodeURIComponent("/after/signup")}&oauth2_continue=signup`,
    });
    expect(start.parked?.continue).toBe("signup");

    const response = await completeDance(start);
    expect(response.headers.get("location")).toBe("/after/signup");
    const { results } = await env.DB.prepare("SELECT user_id FROM external_login_user WHERE external_id = ?").bind("sub-123").all<{ user_id: number }>();
    expect(results[0]?.user_id).toBe(userId);
  });

  it("an expired session mid-dance: the row carrier is gone and no cookie remains ⇒ the state arm", async () => {
    const source = await seedOidcSource();
    const userId = await seedUserRow({ name: "jane", email: "jane@example.com" });
    const session = await mintSession(env.DB, userId);
    const start = await startDance({ sourceName: source.name, sessionCookie: session });
    expect(start.parked).not.toBeNull();

    // The session dies mid-dance.
    const sessionId = session.slice(0, session.indexOf(":"));
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();

    const response = await completeDance(start);
    expect(response.headers.get("location")).toBe("/login?oauth2_error=state");
  });

  it("an id_token verify failure at the callback answers the failure arm (no half-state)", async () => {
    const source = await seedOidcSource();
    const start = await startDance({ sourceName: source.name });

    // A token whose iss does not match the discovery document.
    idp.tokenResponse = {
      access_token: "at",
      token_type: "Bearer",
      id_token: await signIdToken(idp, { ...baseClaims(), iss: "https://evil.example.com", nonce: start.parked?.nonce }),
    };
    const response = await req(`https://app.example.com/user/oauth2/OIDC/callback?code=c&state=${encodeURIComponent(start.stateParam)}`, {
      headers: start.cookieHeader ? { cookie: start.cookieHeader } : {},
    });
    expect(response.headers.get("location")).toBe("/login?oauth2_error=internal");
    // The dance is spent even on the failure arm — the browser adopted the
    // clearance, so the replay finds no carrier.
    const second = await req(`https://app.example.com/user/oauth2/OIDC/callback?code=c&state=${encodeURIComponent(start.stateParam)}`);
    expect(second.headers.get("location")).toBe("/login?oauth2_error=state");
  });

  it("a source deactivated mid-dance answers the honest 404 (§7.2)", async () => {
    const source = await seedOidcSource();
    const start = await startDance({ sourceName: source.name });

    await env.DB.prepare("UPDATE login_source SET is_active = 0 WHERE id = ?").bind(String(source.id)).run();
    const response = await req(`https://app.example.com/user/oauth2/OIDC/callback?code=c&state=${encodeURIComponent(start.stateParam)}`, {
      headers: start.cookieHeader ? { cookie: start.cookieHeader } : {},
    });
    expect(response.status).toBe(404);
  });

  it("an unknown source at the callback answers 404 even with a valid-looking state", async () => {
    const response = await req("https://app.example.com/user/oauth2/Ghost/callback?code=c&state=x");
    expect(response.status).toBe(404);
  });
});

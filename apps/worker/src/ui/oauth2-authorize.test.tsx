/**
 * The OAuth2 authorize-dance suite (SPEC specs/oauth2-provider.md §5
 * "Authorize dance" — W3) on real D1 (workerd):
 *
 * - the §2.2 decision table handler-level through the real router: the
 *   anonymous login redirect, unknown client, unregistered redirect URI,
 *   unsupported response_type / challenge method, public-no-PKCE, the
 *   auto-consent path (code mint + the 10-minute window + PKCE carry),
 *   the consent path (page render + the oauth_state stash), the denied
 *   path, the session-mismatch 400, the read-and-clear one-shot, the
 *   added-scope re-consent;
 * - the `containsRedirectURI` units (oauth2.go:164-205): exact match after
 *   ASCII-lowercase + one-slash trim, the public-client loopback port
 *   variance (RFC 8252 §7.3) incl. IPv6, and the confidential-client
 *   refusal of it;
 * - the scope normalization pins (access_token.go:87-134): verbatim general
 *   scopes, dropped invalid words → no-token-scope, the legacy-`all` default;
 * - the golden DOM snapshots (SPEC-0008 §5.2 style, committed bytes) for the
 *   consent page and the grant_error page + the §5.5 a11y smoke (the error
 *   page pins its single expected R2 violation — the upstream h1→h3 shape).
 *
 * The routes run on a locally-mounted app (the sessionRouter test's shape)
 * with the synthetic manifest fixture; the capturing ExecutionContext makes
 * every `waitUntil` side-effect observable. Sessions are minted directly
 * (mintSession) — the login POST itself is SPEC-0010's suite.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { normalizeScope } from "../auth/scopes";
import { containsRedirectURI } from "../api/services/oauth2-apps";
import {
  getAuthorizationByCode,
  getGrantByUserID,
  type OAuth2ApplicationRow,
} from "../services/oauth2/grants";
import { oauth2Applications, oauth2AuthorizationCodes, oauth2Grants, sessions, users } from "../db/schema";
import { demoModeEnabled } from "../services/demo-sweep";
import type { UiAssetsFetcher } from "./index";
import type { UiManifest } from "./manifest";
import { mintSession } from "./session";
import {
  grantAdditionalScopes,
  normalizeGrantScope,
  oauth2AuthorizeRouter,
} from "./oauth2-authorize";
import { runA11y } from "./__tests__/a11y";
import grantGolden from "./oauth2-goldens/oauth2-grant.html?raw";
import grantErrorGolden from "./oauth2-goldens/oauth2-grant-error.html?raw";

// --- the local app (production registration shape) ------------------------------

const app = new Hono<{ Bindings: Env }>();
app.route("/", oauth2AuthorizeRouter);

/** Synthetic manifest (the session.test.ts fixture — byte-stable renders). */
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
// The demo render gate pinned OFF — the goldens must not depend on the
// operator's local config surface (the session.test.ts discipline).
(env as { DEMO_MODE?: string }).DEMO_MODE = undefined;
if (demoModeEnabled(env)) {
  throw new Error("oauth2 goldens: the demo render gate pin failed — demoModeEnabled(env) must be false");
}
const testEnv: UiTestEnv = { ...env, ASSETS: fakeAssets };

async function request(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`https://test.local${path}`, init), testEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

const formBody = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  origin: "https://test.local",
} as const;

/** The signed-in cookie for a seeded user (mintSession returns id:secret). */
async function seedUser(username = "Alice"): Promise<{ id: number; username: string; cookie: string }> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      visibility: "public",
      createdAt: new Date(),
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  const cookie = await mintSession(env.DB, row.id);
  return { id: row.id, username: row.username, cookie };
}

interface SeedAppOptions {
  clientId: string;
  name?: string;
  confidential?: boolean;
  uid?: number;
  redirectUris?: string[];
}

async function seedApp(options: SeedAppOptions): Promise<OAuth2ApplicationRow> {
  const rows = await drizzle(env.DB)
    .insert(oauth2Applications)
    .values({
      uid: options.uid ?? 0,
      name: options.name ?? "Test App",
      clientId: options.clientId,
      clientSecret: "",
      confidentialClient: options.confidential ?? false,
      skipSecondaryAuthorization: false,
      redirectUris: JSON.stringify(options.redirectUris ?? ["https://app.example/cb"]),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("app seed failed");
  return row;
}

async function seedGrant(userId: number, applicationId: number, scope: string): Promise<void> {
  await drizzle(env.DB).insert(oauth2Grants).values({ userId, applicationId, scope, createdAt: new Date(), updatedAt: new Date() });
}

/** The session row's oauth_state (null when absent). */
const oauthStateOf = async (cookie: string): Promise<string | null> => {
  const id = cookie.split(":")[0] ?? "";
  const row = await drizzle(env.DB).select({ oauthState: sessions.oauthState }).from(sessions).where(eq(sessions.id, id)).get();
  return row?.oauthState ?? null;
};

const AUTH_URL =
  "/login/oauth/authorize?response_type=code&client_id=client-a&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=st1";

beforeAll(applyAuthD1Migrations);

beforeEach(async () => {
  for (const table of ["oauth2_authorization_code", "oauth2_grant", "oauth2_application", "sessions", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// ---------------------------------------------------------------------------------
// containsRedirectURI (oauth2.go:164-205)
// ---------------------------------------------------------------------------------

describe("containsRedirectURI (oauth2.go:164-205)", () => {
  it("matches exactly after ASCII-lowercase and ONE trailing-slash trim", async () => {
    const app = await seedApp({ clientId: "c1", confidential: true, redirectUris: ["https://App.Example.com/CB/"] });
    expect(containsRedirectURI(app, "https://app.example.com/cb")).toBe(true);
    // the registered slash already trimmed — a double slash does not match
    const double = await seedApp({ clientId: "c2", confidential: true, redirectUris: ["https://app.example.com/cb//"] });
    expect(containsRedirectURI(double, "https://app.example.com/cb")).toBe(false);
    expect(containsRedirectURI(double, "https://app.example.com/cb/")).toBe(false); // only ONE trim upstream
  });

  it("rejects an unregistered URI (the open-redirect posture)", async () => {
    const app = await seedApp({ clientId: "c3", confidential: true, redirectUris: ["https://app.example.com/cb"] });
    expect(containsRedirectURI(app, "https://evil.example.com/cb")).toBe(false);
    expect(containsRedirectURI(app, "https://app.example.com/cb?extra=1")).toBe(false);
    expect(containsRedirectURI(app, "https://app.example.com/other")).toBe(false);
  });

  it("strips the port of a loopback http URI for PUBLIC clients only (RFC 8252 §7.3)", async () => {
    const pub = await seedApp({ clientId: "p1", confidential: false, redirectUris: ["http://127.0.0.1"] });
    expect(containsRedirectURI(pub, "http://127.0.0.1:49152")).toBe(true);
    expect(containsRedirectURI(pub, "http://127.0.0.1:49152/oauth/callback")).toBe(false); // path must still match
    // the GCM pair — https loopback registered verbatim
    const gcm = await seedApp({ clientId: "p2", confidential: false, redirectUris: ["http://127.0.0.1", "https://127.0.0.1"] });
    expect(containsRedirectURI(gcm, "http://127.0.0.1:8231")).toBe(true);
    expect(containsRedirectURI(gcm, "https://127.0.0.1:8231")).toBe(false); // https gets NO port variance

    const conf = await seedApp({ clientId: "p3", confidential: true, redirectUris: ["http://127.0.0.1"] });
    expect(containsRedirectURI(conf, "http://127.0.0.1:49152")).toBe(false);
    expect(containsRedirectURI(conf, "http://127.0.0.1")).toBe(true);
  });

  it("recognizes the IPv6 loopback with the port stripped", async () => {
    // The pin's fixture registers the BARE address (oauth2_test.go:87-106 —
    // Go's Hostname() re-spell emits brackets-off; the comparison itself never
    // de-brackets, so the bracketed registration form is a DIFFERENT string).
    const app = await seedApp({ clientId: "p4", confidential: false, redirectUris: ["http://::1"] });
    expect(containsRedirectURI(app, "http://[::1]:9000")).toBe(true);
  });

  it("refuses the port variance for non-loopback hosts and portless URIs", async () => {
    const app = await seedApp({ clientId: "p5", confidential: false, redirectUris: ["http://app.example.com"] });
    expect(containsRedirectURI(app, "http://app.example.com:8080")).toBe(false);
    const ip = await seedApp({ clientId: "p6", confidential: false, redirectUris: ["http://10.0.0.1"] });
    expect(containsRedirectURI(ip, "http://10.0.0.1:9000")).toBe(false);
    // loopback without a port needs no variance — but an unregistered host path fails
    const lo = await seedApp({ clientId: "p7", confidential: false, redirectUris: ["http://127.0.0.1/cb"] });
    expect(containsRedirectURI(lo, "http://127.0.0.1/cb")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------
// The scope normalization pins (access_token.go:87-134)
// ---------------------------------------------------------------------------------

describe("normalizeGrantScope / grantAdditionalScopes (access_token.go:87-134)", () => {
  it("keeps general scopes verbatim and expands comma-joined access words", () => {
    expect(normalizeGrantScope("openid profile")).toBe("openid profile");
    expect(normalizeGrantScope("openid read:repository")).toBe("openid read:repository");
    // write bakes its read (the landed normalizer's write⇒read rule)
    expect(normalizeGrantScope("read:repository,write:issue")).toBe(normalizeScope("read:repository,write:issue,read:issue").split(",").join(" "));
    expect(normalizeGrantScope("groups email write:issue")).toBe(`groups email ${normalizeScope("write:issue,read:issue").split(",").join(" ")}`);
  });

  it("drops invalid words; an all-invalid access part lands on no-token-scope", () => {
    expect(normalizeGrantScope("openid bogus-scope")).toBe("openid no-token-scope");
    expect(normalizeGrantScope("garbage")).toBe("no-token-scope");
    // upstream's per-word drop: the general scope survives the comma word's failure
    expect(normalizeGrantScope("openid,nope")).toBe("no-token-scope");
  });

  it("keeps the legacy `all` default for an absent access part (since 1.22)", () => {
    expect(grantAdditionalScopes("")).toBe("all");
    expect(grantAdditionalScopes("openid profile")).toBe("all");
    expect(grantAdditionalScopes("read:repository")).toBe("read:repository");
    // `all` normalizes to the literal all — the description line still shows
    expect(grantAdditionalScopes("all")).toBe("all");
    expect(normalizeGrantScope("all")).toBe("all");
  });
});

// ---------------------------------------------------------------------------------
// The §2.2 decision table — GET/POST /login/oauth/authorize
// ---------------------------------------------------------------------------------

describe("GET /login/oauth/authorize — the validation ladder", () => {
  it("redirects an anonymous browser to /login with the dance resume (reqSignIn, web.go:623)", async () => {
    await seedApp({ clientId: "client-a" });
    const res = await request(AUTH_URL);
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/login?redirect_to=")).toBe(true);
    expect(location).toContain(encodeURIComponent("/login/oauth/authorize?response_type=code&client_id=client-a"));
  });

  it("answers unknown client_id with the grant_error PAGE at 400 (unauthorized_client)", async () => {
    const user = await seedUser();
    const res = await request(`${AUTH_URL}&client_id=nosuch`, { headers: { cookie: `gitea_session=${user.cookie}` } });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Authorization failed");
    expect(html).toContain("Client ID not registered");
    expect(await oauthStateOf(user.cookie)).toBeNull();
  });

  it("answers an unregistered redirect URI with the PAGE at 400 — never a redirect to it", async () => {
    const user = await seedUser();
    await seedApp({ clientId: "client-a", confidential: true });
    const res = await request(
      "/login/oauth/authorize?response_type=code&client_id=client-a&redirect_uri=" + encodeURIComponent("https://evil.example.com/cb") + "&state=st1",
      { headers: { cookie: `gitea_session=${user.cookie}` } },
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Unregistered Redirect URI");
    expect(res.headers.get("location")).toBeNull();
  });

  it("answers response_type=token with the error REDIRECT (303) — the URI is validated by then", async () => {
    const user = await seedUser();
    await seedApp({ clientId: "client-a", confidential: true });
    const res = await request(
      "/login/oauth/authorize?response_type=token&client_id=client-a&redirect_uri=" + encodeURIComponent("https://app.example/cb") + "&state=st1",
      { headers: { cookie: `gitea_session=${user.cookie}` } },
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://app.example/cb?")).toBe(true);
    expect(location).toContain("error=unsupported_response_type");
    expect(location).toContain("error_description=Only+code+response+type+is+supported.");
    expect(location).toContain("state=st1");
  });

  it("answers an unsupported code challenge method with invalid_request (RFC 7636 §4.4.1)", async () => {
    const user = await seedUser();
    await seedApp({ clientId: "client-a", confidential: true });
    const res = await request(`${AUTH_URL}&code_challenge_method=S256X`, { headers: { cookie: `gitea_session=${user.cookie}` } });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=invalid_request");
    expect(location).toContain("error_description=unsupported+code+challenge+method");
  });

  it("answers a PKCE-less public client with invalid_request (RFC 7636 §4.4.1 / RFC 8252 §8.1)", async () => {
    const user = await seedUser();
    await seedApp({ clientId: "client-a", confidential: false });
    const res = await request(AUTH_URL, { headers: { cookie: `gitea_session=${user.cookie}` } });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=invalid_request");
    expect(location).toContain("error_description=PKCE+is+required+for+public+clients");
  });

  it("renders the consent page for a public client WITH PKCE and stashes the dance state", async () => {
    const user = await seedUser();
    await seedApp({ clientId: "client-a", confidential: false, name: "Tea Client" });
    const res = await request(`${AUTH_URL}&code_challenge_method=S256&code_challenge=abc&nonce=n1&scope=openid+profile`, {
      headers: { cookie: `gitea_session=${user.cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Tea Client");
    expect(html).toContain("With scopes:");
    expect(html).toContain('name="client_id" value="client-a"');
    expect(html).not.toContain('name="code_challenge"'); // PKCE never rides the form
    const state = await oauthStateOf(user.cookie);
    expect(state).not.toBeNull();
    const parsed = JSON.parse(state ?? "{}") as { code_challenge_method: string; code_challenge: string; nonce: string };
    expect(parsed.code_challenge_method).toBe("S256");
    expect(parsed.code_challenge).toBe("abc");
    expect(parsed.nonce).toBe("n1");
  });
});

describe("the auto-consent path (oauth2_provider.go:339-359)", () => {
  it("confidential client + existing grant + unchanged scope mints the code immediately", async () => {
    const user = await seedUser();
    const app = await seedApp({ clientId: "client-a", confidential: true });
    await seedGrant(user.id, app.id, "read:repository");
    const before = Date.now();
    const res = await request(AUTH_URL, { headers: { cookie: `gitea_session=${user.cookie}` } });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://app.example/cb?code=gta_")).toBe(true);
    expect(location.endsWith("&state=st1")).toBe(true);

    const codeValue = location.split("code=")[1]?.split("&")[0] ?? "";
    const loaded = await getAuthorizationByCode(env.DB, codeValue);
    expect(loaded).not.toBeNull();
    const ttl = (loaded?.code.validUntil.getTime() ?? 0) - before;
    expect(ttl).toBeGreaterThan(10 * 60 * 1000 - 5000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(loaded?.code.codeChallenge).toBe(""); // no PKCE on this request
    // no dance state stashed on the auto-consent path
    expect(await oauthStateOf(user.cookie)).toBeNull();
  });

  it("carries the PKCE challenge onto the code from the FORM values", async () => {
    const user = await seedUser();
    const app = await seedApp({ clientId: "client-a", confidential: true });
    await seedGrant(user.id, app.id, "");
    const res = await request(`${AUTH_URL}&code_challenge_method=plain&code_challenge=verifier-abc`, {
      headers: { cookie: `gitea_session=${user.cookie}` },
    });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    const loaded = await getAuthorizationByCode(env.DB, location.split("code=")[1]?.split("&")[0] ?? "");
    expect(loaded?.code.codeChallenge).toBe("verifier-abc");
    expect(loaded?.code.codeChallengeMethod).toBe("plain");
  });

  it("updates the grant nonce on the auto-consent path", async () => {
    const user = await seedUser();
    const app = await seedApp({ clientId: "client-a", confidential: true });
    await seedGrant(user.id, app.id, "read:repository");
    await request(`${AUTH_URL}&nonce=fresh-nonce`, { headers: { cookie: `gitea_session=${user.cookie}` } });
    const grant = await getGrantByUserID(env.DB, user.id, app.id);
    expect(grant?.nonce).toBe("fresh-nonce");
  });

  it("NEVER auto-consents a public client even with an unchanged scope (RFC 6749 §10.2)", async () => {
    const user = await seedUser();
    const app = await seedApp({ clientId: "client-a", confidential: false });
    await seedGrant(user.id, app.id, "read:repository");
    const res = await request(`${AUTH_URL}&scope=read%3Arepository&code_challenge_method=S256&code_challenge=x`, {
      headers: { cookie: `gitea_session=${user.cookie}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="authorize-app"');
  });

  it("an empty requested scope inherits the granted scope (oauth2_provider.go:325-327)", async () => {
    const user = await seedUser();
    const app = await seedApp({ clientId: "client-a", confidential: true });
    await seedGrant(user.id, app.id, "openid profile");
    const res = await request(`${AUTH_URL}&scope=`, { headers: { cookie: `gitea_session=${user.cookie}` } });
    expect(res.status).toBe(303);
    const grant = await getGrantByUserID(env.DB, user.id, app.id);
    expect(grant?.scope).toBe("openid profile");
  });
});

describe("the consent-page render arms", () => {
  it("hides the description and shows New scopes when the scope CHANGES (re-consent)", async () => {
    const user = await seedUser();
    const app = await seedApp({ clientId: "client-a", confidential: true });
    await seedGrant(user.id, app.id, "read:repository");
    const res = await request(`${AUTH_URL}&scope=read%3Arepository+write%3Aissue`, {
      headers: { cookie: `gitea_session=${user.cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("New scopes:");
    // the added word(s) render space-joined in bold
    expect(html).toMatch(/<b>[^<]*write:issue[^<]*<\/b>/);
  });

  it("renders the instance creator arm for a uid=0 application", async () => {
    const user = await seedUser();
    await seedApp({ clientId: "client-a", confidential: false, uid: 0 });
    const res = await request(`${AUTH_URL}&code_challenge_method=plain&code_challenge=x`, {
      headers: { cookie: `gitea_session=${user.cookie}` },
    });
    const html = await res.text();
    expect(html).toContain('href="/">cf-gitea</a>');
  });

  it("renders the @user creator arm for a user-owned application", async () => {
    const user = await seedUser("AppOwner");
    await seedApp({ clientId: "client-a", confidential: false, uid: user.id });
    const viewer = await seedUser("Bob");
    const res = await request(`${AUTH_URL}&code_challenge_method=plain&code_challenge=x`, {
      headers: { cookie: `gitea_session=${viewer.cookie}` },
    });
    const html = await res.text();
    expect(html).toContain('href="/AppOwner">@AppOwner</a>');
  });

  it("accepts the POST arm with the same handler (web.go:629-630)", async () => {
    const user = await seedUser();
    const app = await seedApp({ clientId: "client-a", confidential: true });
    await seedGrant(user.id, app.id, "read:repository");
    const res = await request("/login/oauth/authorize", {
      method: "POST",
      headers: { ...FORM_HEADERS, cookie: `gitea_session=${user.cookie}` },
      body: formBody({ response_type: "code", client_id: "client-a", redirect_uri: "https://app.example/cb", state: "st1" }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("code=gta_");
  });

});

// ---------------------------------------------------------------------------------
// POST /login/oauth/grant (oauth2_provider.go:405-479)
// ---------------------------------------------------------------------------------

/** Drive GET /authorize to the consent page and harvest the hidden form
 *  fields — the consent POST's canonical setup. The caller seeds the
 *  application (public by default, so PKCE is required and the page
 *  renders). */
async function harvestConsentForm(
  user: { cookie: string },
  options: { clientId?: string; query?: string } = {},
): Promise<Record<string, string>> {
  const clientId = options.clientId ?? "client-a";
  const query = options.query ?? "&code_challenge_method=S256&code_challenge=abc";
  const res = await request(
    `/login/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://app.example/cb")}&state=st1${query}`,
    { headers: { cookie: `gitea_session=${user.cookie}` } },
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  const field = (name: string): string => {
    const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
    if (match === null) throw new Error(`consent form field ${name} missing`);
    return match[1] ?? "";
  };
  return {
    client_id: field("client_id"),
    state: field("state"),
    scope: field("scope"),
    nonce: field("nonce"),
    redirect_uri: field("redirect_uri"),
  };
}

/** The standard consent fixture: a public app + the PKCE authorize GET. */
async function seedConsentFixture(options: { clientId?: string; confidential?: boolean } = {}): Promise<OAuth2ApplicationRow> {
  return seedApp({
    clientId: options.clientId ?? "client-a",
    confidential: options.confidential ?? false,
    redirectUris: ["https://app.example/cb"],
  });
}

describe("POST /login/oauth/grant", () => {
  it("the full consent dance: form → 303 with code + state → grant row + nonce + cleared state", async () => {
    const user = await seedUser();
    await seedConsentFixture();
    const fields = await harvestConsentForm(user, { query: "&scope=openid%20profile&nonce=n9&code_challenge_method=S256&code_challenge=abc" });
    const res = await request("/login/oauth/grant", {
      method: "POST",
      headers: { ...FORM_HEADERS, cookie: `gitea_session=${user.cookie}` },
      body: formBody({ ...fields, granted: "true" }),
    });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://app.example/cb?code=gta_")).toBe(true);
    expect(location.endsWith("&state=st1")).toBe(true);

    const appRow = await drizzle(env.DB).select().from(oauth2Applications).all();
    const grant = await getGrantByUserID(env.DB, user.id, appRow[0]?.id ?? 0);
    expect(grant?.scope).toBe("openid profile");
    expect(grant?.nonce).toBe("n9");

    // the PKCE challenge rode the STASHED state, not the form
    const codeValue = location.split("code=")[1]?.split("&")[0] ?? "";
    const loaded = await getAuthorizationByCode(env.DB, codeValue);
    expect(loaded?.code.codeChallenge).toBe("abc");
    expect(loaded?.code.codeChallengeMethod).toBe("S256");

    expect(await oauthStateOf(user.cookie)).toBeNull();
  });

  it("granted=false answers the access_denied REDIRECT ('the request is denied')", async () => {
    const user = await seedUser();
    await seedConsentFixture();
    const fields = await harvestConsentForm(user);
    const res = await request("/login/oauth/grant", {
      method: "POST",
      headers: { ...FORM_HEADERS, cookie: `gitea_session=${user.cookie}` },
      body: formBody({ ...fields, granted: "false" }),
    });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://app.example/cb?")).toBe(true);
    expect(location).toContain("error=access_denied");
    expect(location).toContain("error_description=the+request+is+denied");
    expect(location).toContain("state=st1");
    // no grant, no code
    const grants = await drizzle(env.DB).select().from(oauth2Grants).all();
    expect(grants).toHaveLength(0);
    const codes = await drizzle(env.DB).select().from(oauth2AuthorizationCodes).all();
    expect(codes).toHaveLength(0);
  });

  it("a mismatched form (state tampered) is a plain 400 — and consumes the state", async () => {
    const user = await seedUser();
    await seedConsentFixture();
    const fields = await harvestConsentForm(user);
    const res = await request("/login/oauth/grant", {
      method: "POST",
      headers: { ...FORM_HEADERS, cookie: `gitea_session=${user.cookie}` },
      body: formBody({ ...fields, state: "tampered", granted: "true" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Bad Request");
    expect(await oauthStateOf(user.cookie)).toBeNull();
  });

  it("the consent form is one-shot: a second identical POST takes the 400 arm", async () => {
    const user = await seedUser();
    await seedConsentFixture();
    const fields = await harvestConsentForm(user);
    const first = await request("/login/oauth/grant", {
      method: "POST",
      headers: { ...FORM_HEADERS, cookie: `gitea_session=${user.cookie}` },
      body: formBody({ ...fields, granted: "true" }),
    });
    expect(first.status).toBe(303);
    const second = await request("/login/oauth/grant", {
      method: "POST",
      headers: { ...FORM_HEADERS, cookie: `gitea_session=${user.cookie}` },
      body: formBody({ ...fields, granted: "true" }),
    });
    expect(second.status).toBe(400);
  });

  it("a cross-origin consent POST is rejected 403 (the sameOriginGuard layer)", async () => {
    const user = await seedUser();
    await seedConsentFixture();
    const fields = await harvestConsentForm(user);
    const res = await request("/login/oauth/grant", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie: `gitea_session=${user.cookie}` },
      body: formBody({ ...fields, granted: "true" }),
    });
    expect(res.status).toBe(403);
  });

  it("re-consent with a changed scope UPDATES the grant in place (one row per pair)", async () => {
    const user = await seedUser();
    const app = await seedConsentFixture();
    await seedGrant(user.id, app.id, "read:repository");
    const fields = await harvestConsentForm(user, { query: `&scope=${encodeURIComponent("read:repository write:issue")}&code_challenge_method=S256&code_challenge=abc` });
    const res = await request("/login/oauth/grant", {
      method: "POST",
      headers: { ...FORM_HEADERS, cookie: `gitea_session=${user.cookie}` },
      body: formBody({ ...fields, granted: "true" }),
    });
    expect(res.status).toBe(303);
    const grants = await drizzle(env.DB).select().from(oauth2Grants).all();
    expect(grants).toHaveLength(1);
    expect(grants[0]?.scope).toBe(normalizeScope("read:repository,write:issue,read:issue").split(",").join(" "));
  });
});

// ---------------------------------------------------------------------------------
// The goldens (SPEC-0008 §5.2 style, committed bytes) + §5.5 a11y smoke
// ---------------------------------------------------------------------------------

describe("oauth2 grant page goldens (deterministic render)", () => {
  it("renders the consent page byte-identical to the committed golden and passes the a11y smoke", async () => {
    const user = await seedUser("GoldenAnchor");
    await seedApp({
      clientId: "golden-client-0000-0001",
      name: "Golden App",
      confidential: false,
      redirectUris: ["https://app.example/cb"],
    });
    const res = await request(
      "/login/oauth/authorize?response_type=code&client_id=golden-client-0000-0001&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=golden-state&scope=openid+profile&code_challenge_method=S256&code_challenge=golden",
      { headers: { cookie: `gitea_session=${user.cookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    if (grantGolden === "") {
      console.log(`@@GOLDEN:oauth2-grant.html\n${html}\n@@END-GOLDEN@@`);
      throw new Error("oauth2-goldens/oauth2-grant.html is empty — paste the marker-framed render from: pnpm exec vitest run src/ui/oauth2-authorize.test.tsx --disable-console-intercept");
    }
    expect(html).toBe(grantGolden);
    expect(runA11y(html)).toEqual([]);
  });

  it("renders identical bytes twice (no request-state bleed)", async () => {
    const user = await seedUser("GoldenAnchor");
    await seedApp({
      clientId: "golden-client-0000-0001",
      name: "Golden App",
      confidential: false,
      redirectUris: ["https://app.example/cb"],
    });
    const init = {
      headers: { cookie: `gitea_session=${user.cookie}` },
    } as const;
    const url =
      "/login/oauth/authorize?response_type=code&client_id=golden-client-0000-0001&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=golden-state&scope=openid+profile&code_challenge_method=S256&code_challenge=golden";
    const first = await request(url, init);
    const second = await request(url, init);
    expect(await second.text()).toBe(await first.text());
  });

  it("renders the grant_error page byte-identical; pins the single expected R2 violation (upstream h1→h3)", async () => {
    const user = await seedUser("GoldenAnchor");
    const res = await request("/login/oauth/authorize?response_type=code&client_id=nosuch&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=golden-state", {
      headers: { cookie: `gitea_session=${user.cookie}` },
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    if (grantErrorGolden === "") {
      console.log(`@@GOLDEN:oauth2-grant-error.html\n${html}\n@@END-GOLDEN@@`);
      throw new Error("oauth2-goldens/oauth2-grant-error.html is empty — paste the marker-framed render from: pnpm exec vitest run src/ui/oauth2-authorize.test.tsx --disable-console-intercept");
    }
    expect(html).toBe(grantErrorGolden);
    const violations = runA11y(html);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("R2-no-skip");
    expect(violations[0]?.detail).toContain("<h1> followed by <h3>");
  });
});

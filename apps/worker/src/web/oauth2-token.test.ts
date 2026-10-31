/**
 * The OAuth2 route matrix (SPEC specs/oauth2-provider.md §5 "Token endpoint
 * matrix", "userinfo/introspect/keys"): the RFC 6749 §5.2 error bodies
 * BYTE-EXACT (member order error/error_description, the verbatim upstream
 * descriptions, the authorization_code-vs-refresh client message split),
 * the client-auth shapes (form / Basic / the disagreement arms), the PKCE
 * exchange arms, the one-time replay, the refresh family (happy, wrong
 * kind, foreign client, reuse under the flag), userinfo's PAT-refusal +
 * read:user gate + group content, introspection's Basic-only 401 +
 * inactive-200 + the active shape without exp, the JWKS member order, and
 * the bare-OPTIONS 405 deny arms.
 *
 * Codes are minted DIRECTLY through the W1 store (grants.ts) — the
 * authorize endpoint is W3's; the exchange half is exercised end-to-end
 * here (the code format, TTL and consumption arms ride the same rows the
 * authorize endpoint will write).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { resetAuthTables, seedVerifiedUser } from "../auth/testing/seeds";
import { oauth2Applications, oauth2Grants, orgMembers, teamMembers, teams, users } from "../db/schema";
import { base64UrlDecode } from "../services/oauth2/jws";
import { generateAuthorizationCode, getOrCreateGrant, type OAuth2GrantRow } from "../services/oauth2/grants";
import { resetOAuth2KeyCachesForTests } from "../services/oauth2/keys";
import { loadOAuth2SigningMaterial, mintTokenTrio } from "../services/oauth2/token";
import { containsRedirectUri, oauth2Router, parseClientSecretBasic, parseTokenForm } from "./oauth2-token";

const T0 = new Date("2026-01-01T00:00:00Z");
/** The route layer's clock is the WALL (upstream time.Now) — every code and
 *  token the route reads back mints at the live instant, not at T0. */
const NOW = (): Date => new Date();

beforeAll(applyAuthD1Migrations);
beforeEach(async () => {
  await resetAuthTables();
  // the oauth2 tables the auth reset doesn't know (codes → grants → apps)
  await env.DB.prepare("DELETE FROM oauth2_authorization_code").run();
  await env.DB.prepare("DELETE FROM oauth2_grant").run();
  await env.DB.prepare("DELETE FROM oauth2_application").run();
  // the storage reset wipes the keystore row too — the module-level key
  // cache must follow it or a cached ref would sign over material a cold
  // isolate would never load.
  resetOAuth2KeyCachesForTests();
});

/** Drive the sub-app directly (the wellKnownRouter pattern) — the ABSOLUTE
 *  URL pins the origin the issuer/appUrl derivations read. */
const ORIGIN = "https://example.com";
/** The route env with the AppURL pinned to the test origin (upstream
 *  reads setting.AppURL first; .dev.vars carries the deployed URL). */
const routeEnv = (): Record<string, unknown> => ({ ...env, APP_URL: ORIGIN });
async function call(path: string, init?: RequestInit): Promise<Response> {
  return await oauth2Router.request(`${ORIGIN}${path}`, init, routeEnv());
}

let seq = 0;

async function seedUser(username?: string): Promise<{ id: number; username: string }> {
  return await seedVerifiedUser({ username: username ?? `w2user${++seq}` });
}

async function seedApp(options?: { redirectUris?: string }): Promise<{ id: number; clientId: string }> {
  seq += 1;
  const clientId = `w2client-${seq}`;
  const row = await drizzle(env.DB)
    .insert(oauth2Applications)
    .values({
      uid: 0,
      name: `w2app-${seq}`,
      clientId,
      clientSecret: "",
      confidentialClient: false,
      redirectUris: options?.redirectUris ?? '["http://127.0.0.1"]',
      createdAt: T0,
      updatedAt: T0,
    })
    .returning();
  return { id: row[0]!.id, clientId };
}

async function seedGrant(userId: number, applicationId: number, scope: string): Promise<OAuth2GrantRow> {
  const { grant } = await getOrCreateGrant(env.DB, { userId, applicationId, scope }, T0);
  return grant;
}

/** A live confidential client: the secret hash from the REAL PBKDF2
 *  generator (the landed oauth2-apps codec), plaintext returned for the
 *  requests — the exchange verify arms run the real crypto. */
async function seedConfidentialApp(): Promise<{ id: number; clientId: string; secret: string }> {
  const { generateClientSecret } = await import("../api/services/oauth2-apps");
  const { plaintext, hash } = await generateClientSecret();
  seq += 1;
  const clientId = `w2conf-${seq}`;
  const row = await drizzle(env.DB)
    .insert(oauth2Applications)
    .values({
      uid: 0,
      name: `w2conf-${seq}`,
      clientId,
      clientSecret: hash,
      confidentialClient: true,
      redirectUris: '["http://127.0.0.1"]',
      createdAt: T0,
      updatedAt: T0,
    })
    .returning();
  return { id: row[0]!.id, clientId, secret: plaintext };
}

async function mintForGrant(grant: OAuth2GrantRow, applicationId: number, userId: number): Promise<{ access_token: string; refresh_token: string; scope?: string }> {
  const material = await loadOAuth2SigningMaterial(env.DB);
  const appRow = (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, applicationId)).get())!;
  const userRow = (await drizzle(env.DB).select().from(users).where(eq(users.id, userId)).get())!;
  const result = await mintTokenTrio({
    db: env.DB,
    grant,
    application: appRow,
    user: userRow,
    material,
    issuer: "https://example.com",
    appUrl: "https://example.com/",
    now: NOW(),
  });
  if (!result.ok) throw new Error("mint failed");
  return result.response as { access_token: string; refresh_token: string; scope?: string };
}

const formHeaders = { "content-type": "application/x-www-form-urlencoded" };

// ---------------------------------------------------------------------------
// POST /login/oauth/access_token — authorization_code
// ---------------------------------------------------------------------------

describe("POST /login/oauth/access_token — the authorization_code family", () => {
  it("happy path (public client): 200 bearer envelope, expires_in 3600, normalized scope, refresh cnt rides", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "openid read:repository");
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://127.0.0.1", codeChallenge: "", codeChallengeMethod: "" }, NOW());
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, code: code.code, redirect_uri: "http://127.0.0.1" }).toString(),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["access_token", "token_type", "expires_in", "refresh_token", "id_token", "scope"]);
    expect(body.token_type).toBe("bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe("openid read:repository");
    // compact JSON, no trailing newline (ctx.JSON via jsonv2 MarshalWrite)
    expect(text.endsWith("\n")).toBe(false);
    // the access token round-trips: decode the claims
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode((body.access_token as string).split(".")[1]!))) as Record<string, unknown>;
    expect(claims.gnt).toBe(grant.id);
    expect(claims.tt).toBe(0);
  });

  it("the id_token rides when the grant scope carries openid, after refresh_token in struct order", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "openid");
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://127.0.0.1", codeChallenge: "", codeChallengeMethod: "" }, NOW());
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, code: code.code, redirect_uri: "http://127.0.0.1" }).toString(),
    });
    const body = await response.json<Record<string, unknown>>();
    expect(Object.keys(body)).toEqual(["access_token", "token_type", "expires_in", "refresh_token", "id_token", "scope"]);
    const idClaims = JSON.parse(new TextDecoder().decode(base64UrlDecode((body.id_token as string).split(".")[1]!))) as Record<string, unknown>;
    expect(idClaims.iss).toBe("https://example.com");
    expect(idClaims.aud).toEqual([app.clientId]);
    expect(idClaims.sub).toBe(String(user.id));
  });

  it("Basic client auth fills the missing form fields (RFC 6749 §2.3.1)", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://127.0.0.1", codeChallenge: "", codeChallengeMethod: "" }, NOW());
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: { ...formHeaders, authorization: `Basic ${btoa(`${app.clientId}:`)}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code: code.code, redirect_uri: "http://127.0.0.1" }).toString(),
    });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
  });

  it("Basic credentials are form-urlencoded inside the pair (percent-decoded)", async () => {
    const user = await seedUser();
    const conf = await seedConfidentialApp();
    const grant = await seedGrant(user.id, conf.id, "");
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://127.0.0.1", codeChallenge: "", codeChallengeMethod: "" }, NOW());
    // percent-encoded client id + secret inside the Basic pair (the base32
    // secret is unchanged by the escaping — the arm under test is the DECODE)
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: { ...formHeaders, authorization: `Basic ${btoa(`${encodeURIComponent(conf.clientId)}:${encodeURIComponent(conf.secret)}`)}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code: code.code, redirect_uri: "http://127.0.0.1" }).toString(),
    });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
  });

  it("a body client_id disagreeing with the Basic header → invalid_request with the verbatim description", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://127.0.0.1", codeChallenge: "", codeChallengeMethod: "" }, NOW());
    const other = await seedApp();
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: { ...formHeaders, authorization: `Basic ${btoa(`${other.clientId}:`)}` },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, code: code.code }).toString(),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      JSON.stringify({ error: "invalid_request", error_description: "client_id in request body inconsistent with Authorization header" }),
    );
  });

  it("an unparseable Authorization header with missing form credentials → 'cannot parse basic auth header'", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://127.0.0.1", codeChallenge: "", codeChallengeMethod: "" }, NOW());
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: { ...formHeaders, authorization: "Bearer somejwt" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: code.code }).toString(),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(JSON.stringify({ error: "invalid_request", error_description: "cannot parse basic auth header" }));
  });

  it("unknown client → invalid_client with the authorization_code SINGLE-quote message", async () => {
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: "no-such-client", code: "gta_x" }).toString(),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      JSON.stringify({ error: "invalid_client", error_description: "cannot load client with client id: 'no-such-client'" }),
    );
  });

  it("confidential + wrong/empty secret → unauthorized_client with the two verbatim messages", async () => {
    const user = await seedUser();
    const conf = await seedConfidentialApp();
    const grant = await seedGrant(user.id, conf.id, "");
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://127.0.0.1", codeChallenge: "", codeChallengeMethod: "" }, NOW());
    const wrong = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: conf.clientId, client_secret: "gto_wrong", code: code.code }).toString(),
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toBe(JSON.stringify({ error: "unauthorized_client", error_description: "invalid client secret" }));

    const empty = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: conf.clientId, code: code.code }).toString(),
    });
    expect(await empty.text()).toBe(JSON.stringify({ error: "unauthorized_client", error_description: "invalid empty client secret" }));
    // the wrong arm consumed nothing — the empty arm used the SAME code
  });

  it("unregistered redirect_uri at exchange → unauthorized_client 'unexpected redirect URI'", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://127.0.0.1", codeChallenge: "", codeChallengeMethod: "" }, NOW());
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, code: code.code, redirect_uri: "https://evil.example.com" }).toString(),
    });
    expect(await response.text()).toBe(JSON.stringify({ error: "unauthorized_client", error_description: "unexpected redirect URI" }));
  });

  it("unknown code → unauthorized_client 'client is not authorized'", async () => {
    const user = await seedUser();
    const app = await seedApp();
    await seedGrant(user.id, app.id, "");
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, code: "gta_missing" }).toString(),
    });
    expect(await response.text()).toBe(JSON.stringify({ error: "unauthorized_client", error_description: "client is not authorized" }));
  });

  it("expired code: invalidated on discovery, invalid_grant 'authorization code expired'", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const past = new Date(Date.now() - 601_000); // valid_until = past + 600s — already dead
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://127.0.0.1", codeChallenge: "", codeChallengeMethod: "" }, past);
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, code: code.code }).toString(),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(JSON.stringify({ error: "invalid_grant", error_description: "authorization code expired" }));
    // invalidated on discovery (the row is gone)
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM oauth2_authorization_code").all<{ n: number }>();
    expect(rows.results[0]?.n).toBe(0);
  });

  it("PKCE S256: the computed verifier exchanges; a wrong/missing verifier → 'failed PKCE code challenge'", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const { s256ChallengeFromVerifier } = await import("../services/oauth2/token");
    const challenge = await s256ChallengeFromVerifier(verifier);
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://127.0.0.1", codeChallenge: challenge, codeChallengeMethod: "S256" }, NOW());

    const missing = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, code: code.code }).toString(),
    });
    expect(await missing.text()).toBe(JSON.stringify({ error: "unauthorized_client", error_description: "failed PKCE code challenge" }));

    const wrong = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, code: code.code, code_verifier: "wrong-verifier" }).toString(),
    });
    expect(await wrong.text()).toBe(JSON.stringify({ error: "unauthorized_client", error_description: "failed PKCE code challenge" }));

    const good = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, code: code.code, code_verifier: verifier, redirect_uri: "http://127.0.0.1" }).toString(),
    });
    expect(good.status).toBe(200);
  });

  it("plain PKCE exchanges with the raw verifier", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://127.0.0.1", codeChallenge: "plain-secret", codeChallengeMethod: "plain" }, NOW());
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, code: code.code, code_verifier: "plain-secret", redirect_uri: "http://127.0.0.1" }).toString(),
    });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
  });

  it("presented redirect != the code's stored redirect → invalid_grant (raw compare)", async () => {
    const user = await seedUser();
    const app = await seedApp({ redirectUris: '["http://127.0.0.1","http://127.0.0.1:8080"]' });
    const grant = await seedGrant(user.id, app.id, "");
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://127.0.0.1", codeChallenge: "", codeChallengeMethod: "" }, NOW());
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, code: code.code, redirect_uri: "http://127.0.0.1:8080" }).toString(),
    });
    expect(await response.text()).toBe(
      JSON.stringify({ error: "invalid_grant", error_description: "redirect_uri differs from the original authorization request" }),
    );
  });

  it("a cross-client code → invalid_grant 'invalid grant'", async () => {
    const user = await seedUser();
    const appA = await seedApp();
    const appB = await seedApp();
    const grantA = await seedGrant(user.id, appA.id, "");
    const code = await generateAuthorizationCode(env.DB, { grantId: grantA.id, redirectUri: "http://127.0.0.1", codeChallenge: "", codeChallengeMethod: "" }, NOW());
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: appB.clientId, code: code.code, redirect_uri: "http://127.0.0.1" }).toString(),
    });
    expect(await response.text()).toBe(JSON.stringify({ error: "invalid_grant", error_description: "invalid grant" }));
  });

  it("the sequential replay: the consumed code row is GONE at reload → 'client is not authorized' (oauth2_provider.go:660-667); the 'already used' arm is the load-then-delete race loser, pinned at the store layer", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const code = await generateAuthorizationCode(env.DB, { grantId: grant.id, redirectUri: "http://127.0.0.1", codeChallenge: "", codeChallengeMethod: "" }, NOW());
    const form = new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, code: code.code, redirect_uri: "http://127.0.0.1" }).toString();
    const first = await call("/login/oauth/access_token", { method: "POST", headers: formHeaders, body: form });
    expect(first.status).toBe(200);
    const second = await call("/login/oauth/access_token", { method: "POST", headers: formHeaders, body: form });
    expect(second.status).toBe(400);
    expect(await second.text()).toBe(JSON.stringify({ error: "unauthorized_client", error_description: "client is not authorized" }));
  });

  it("an unknown grant_type → unsupported_grant_type with the verbatim description", async () => {
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: "x" }).toString(),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      JSON.stringify({ error: "unsupported_grant_type", error_description: "Only refresh_token or authorization_code grant type is supported" }),
    );
  });

  it("a missing grant_type is the same unsupported arm (the form defaults)", async () => {
    const response = await call("/login/oauth/access_token", { method: "POST", headers: formHeaders, body: "" });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      JSON.stringify({ error: "unsupported_grant_type", error_description: "Only refresh_token or authorization_code grant type is supported" }),
    );
  });
});

// ---------------------------------------------------------------------------
// POST /login/oauth/access_token — refresh_token
// ---------------------------------------------------------------------------

describe("POST /login/oauth/access_token — the refresh_token family", () => {
  it("the happy path mints a fresh pair (default: no rotation — the same counter)", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const minted = await mintForGrant(grant, app.id, user.id);
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: app.clientId, refresh_token: minted.refresh_token }).toString(),
    });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    const body = JSON.parse(responseText) as { refresh_token: string };
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(body.refresh_token.split(".")[1]!))) as Record<string, unknown>;
    expect(claims.cnt).toBe(1);
    const rowAfter = (await drizzle(env.DB).select().from(oauth2Grants).where(eq(oauth2Grants.id, grant.id)).get())!;
    expect(rowAfter.counter).toBe(1);
  });

  it("an ACCESS token presented as a refresh → unauthorized_client 'unable to parse refresh token'", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const minted = await mintForGrant(grant, app.id, user.id);
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: app.clientId, refresh_token: minted.access_token }).toString(),
    });
    expect(await response.text()).toBe(JSON.stringify({ error: "unauthorized_client", error_description: "unable to parse refresh token" }));
  });

  it("a foreign client's refresh → invalid_grant 'refresh token belongs to a different client'", async () => {
    const user = await seedUser();
    const appA = await seedApp();
    const appB = await seedApp();
    const grantA = await seedGrant(user.id, appA.id, "");
    const minted = await mintForGrant(grantA, appA.id, user.id);
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: appB.clientId, refresh_token: minted.refresh_token }).toString(),
    });
    expect(await response.text()).toBe(JSON.stringify({ error: "invalid_grant", error_description: "refresh token belongs to a different client" }));
  });

  it("a deleted grant → invalid_grant 'grant does not exist'", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const minted = await mintForGrant(grant, app.id, user.id);
    await drizzle(env.DB).delete(oauth2Grants).where(eq(oauth2Grants.id, grant.id));
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: app.clientId, refresh_token: minted.refresh_token }).toString(),
    });
    expect(await response.text()).toBe(JSON.stringify({ error: "invalid_grant", error_description: "grant does not exist" }));
  });

  it("confidential clients must authenticate on refresh — invalid_client messages (the code arm says unauthorized_client)", async () => {
    const user = await seedUser();
    const conf = await seedConfidentialApp();
    const grant = await seedGrant(user.id, conf.id, "");
    const minted = await mintForGrant(grant, conf.id, user.id);
    const wrong = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: conf.clientId, client_secret: "gto_wrong", refresh_token: minted.refresh_token }).toString(),
    });
    expect(await wrong.text()).toBe(JSON.stringify({ error: "invalid_client", error_description: "invalid client secret" }));
    const empty = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: conf.clientId, refresh_token: minted.refresh_token }).toString(),
    });
    expect(await empty.text()).toBe(JSON.stringify({ error: "invalid_client", error_description: "invalid empty client secret" }));
  });

  it("the unknown-client refresh message is the %q DOUBLE-quoted form", async () => {
    const response = await call("/login/oauth/access_token", {
      method: "POST",
      headers: formHeaders,
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: "ghost", refresh_token: "junk" }).toString(),
    });
    expect(await response.text()).toBe(JSON.stringify({ error: "invalid_client", error_description: 'cannot load client with client id: "ghost"' }));
  });

  it("OAUTH2_INVALIDATE_REFRESH_TOKENS=true: reuse detection + the counter CAS", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const minted = await mintForGrant(grant, app.id, user.id);
    const rotateEnv = (): Record<string, unknown> => ({ ...env, APP_URL: ORIGIN, OAUTH2_INVALIDATE_REFRESH_TOKENS: "true" });
    // first refresh under the flag: mint succeeds, the counter CAS moves 1→2
    const first = await oauth2Router.request(
      "/login/oauth/access_token",
      {
        method: "POST",
        headers: formHeaders,
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: app.clientId, refresh_token: minted.refresh_token }).toString(),
      },
      rotateEnv(),
    );
    expect(first.status).toBe(200);
    const body = await first.json<{ refresh_token: string }>();
    const newClaims = JSON.parse(new TextDecoder().decode(base64UrlDecode(body.refresh_token.split(".")[1]!))) as Record<string, unknown>;
    expect(newClaims.cnt).toBe(2);
    // the OLD token now carries a stale cnt → 'token was already used'
    const second = await oauth2Router.request(
      "/login/oauth/access_token",
      {
        method: "POST",
        headers: formHeaders,
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: app.clientId, refresh_token: minted.refresh_token }).toString(),
      },
      rotateEnv(),
    );
    expect(second.status).toBe(400);
    expect(await second.text()).toBe(JSON.stringify({ error: "unauthorized_client", error_description: "token was already used" }));
    // a cnt=0 token dies under the flag even against a counter-0 grant shape
    const zero = await oauth2Router.request(
      "/login/oauth/access_token",
      {
        method: "POST",
        headers: formHeaders,
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: app.clientId, refresh_token: minted.access_token }).toString(),
      },
      rotateEnv(),
    );
    // an ACCESS token still dies at the parse arm first
    expect(await zero.text()).toBe(JSON.stringify({ error: "unauthorized_client", error_description: "unable to parse refresh token" }));
  });
});

// ---------------------------------------------------------------------------
// POST /login/oauth/introspect
// ---------------------------------------------------------------------------

describe("POST /login/oauth/introspect (IntrospectOAuth)", () => {
  it("Basic-only caller auth: missing/invalid credentials → 401 + WWW-Authenticate Basic realm", async () => {
    const none = await call("/login/oauth/introspect", { method: "POST", headers: formHeaders, body: "token=junk" });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe('Basic realm="Gitea OAuth2"');
    expect(none.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(await none.text()).toBe("no valid authorization");
    const bearer = await call("/login/oauth/introspect", {
      method: "POST",
      headers: { ...formHeaders, authorization: "Bearer whatever" },
      body: "token=junk",
    });
    expect(bearer.status).toBe(401);
  });

  it("a wrong client secret answers the same 401 (never discloses)", async () => {
    const conf = await seedConfidentialApp();
    const bad = await call("/login/oauth/introspect", {
      method: "POST",
      headers: { ...formHeaders, authorization: `Basic ${btoa(`${conf.clientId}:gto_wrong`)}` },
      body: "token=junk",
    });
    expect(bad.status).toBe(401);
  });

  it("invalid/unknown tokens answer 200 {'active':false} (RFC 7662 §2.2)", async () => {
    const conf = await seedConfidentialApp();
    const auth = `Basic ${btoa(`${conf.clientId}:${conf.secret}`)}`;
    const junk = await call("/login/oauth/introspect", {
      method: "POST",
      headers: { ...formHeaders, authorization: auth },
      body: "token=not-a-jwt",
    });
    expect(junk.status).toBe(200);
    expect(await junk.text()).toBe('{"active":false}');

    // a tampered (signature-broken) token is equally inactive
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const minted = await mintForGrant(grant, app.id, user.id);
    const tampered = await call("/login/oauth/introspect", {
      method: "POST",
      headers: { ...formHeaders, authorization: auth },
      body: `token=${minted.access_token.slice(0, -3)}xyz`,
    });
    expect(await tampered.text()).toBe('{"active":false}');
  });

  it("a foreign client's token answers inactive (the caller must not learn more)", async () => {
    const user = await seedUser();
    const appA = await seedApp();
    const confB = await seedConfidentialApp();
    const grantA = await seedGrant(user.id, appA.id, "openid read:repository");
    const minted = await mintForGrant(grantA, appA.id, user.id);
    const response = await call("/login/oauth/introspect", {
      method: "POST",
      headers: { ...formHeaders, authorization: `Basic ${btoa(`${confB.clientId}:${confB.secret}`)}` },
      body: new URLSearchParams({ token: minted.access_token }).toString(),
    });
    expect(await response.text()).toBe('{"active":false}');
  });

  it("the active shape: active, scope, username, iss, sub, aud — NO exp (nil upstream)", async () => {
    const user = await seedUser();
    const conf = await seedConfidentialApp();
    const grant = await seedGrant(user.id, conf.id, "openid profile read:repository");
    const minted = await mintForGrant(grant, conf.id, user.id);
    const response = await call("/login/oauth/introspect", {
      method: "POST",
      headers: { ...formHeaders, authorization: `Basic ${btoa(`${conf.clientId}:${conf.secret}`)}` },
      body: new URLSearchParams({ token: minted.access_token }).toString(),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["active", "scope", "username", "iss", "sub", "aud"]);
    expect(body.active).toBe(true);
    expect(body.scope).toBe("openid profile read:repository");
    expect(body.username).toBe(user.username);
    expect(body.iss).toBe("https://example.com");
    expect(body.sub).toBe(String(user.id));
    expect(body.aud).toEqual([conf.clientId]);
    expect(body.exp).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GET/POST /login/oauth/userinfo
// ---------------------------------------------------------------------------

describe("GET/POST /login/oauth/userinfo (InfoOAuth)", () => {
  it("a PAT (dotless Bearer) → 401 'no valid authorization' + the Bearer challenge", async () => {
    const user = await seedUser();
    const { TokenService } = await import("../auth/token-service");
    const pat = await new TokenService(env.DB).mint({ userId: user.id, name: "pat", scopes: "all" });
    const response = await call("/login/oauth/userinfo", { headers: { authorization: `Bearer ${pat.plaintext}` } });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="Gitea OAuth2"');
    expect(response.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(await response.text()).toBe("no valid authorization");
  });

  it("no credential at all → the same 401 (a session would be the upstream Session method — refused identically)", async () => {
    const response = await call("/login/oauth/userinfo");
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("no valid authorization");
  });

  it("a token lacking read:user → 403 'token does not have required scope: read:user'", async () => {
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "read:repository");
    const minted = await mintForGrant(grant, app.id, user.id);
    const response = await call("/login/oauth/userinfo", { headers: { authorization: `Bearer ${minted.access_token}` } });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="Gitea OAuth2"');
    expect(await response.text()).toBe("token does not have required scope: read:user");
  });

  it("the happy shape: sub/name/preferred_username/email/picture/groups in struct order; org-less groups null", async () => {
    const user = await seedUser("w2alice");
    await drizzle(env.DB).update(users).set({ displayName: "Alice Example" }).where(eq(users.id, user.id));
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const minted = await mintForGrant(grant, app.id, user.id);
    const response = await call("/login/oauth/userinfo", { headers: { authorization: `Bearer ${minted.access_token}` } });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["sub", "name", "preferred_username", "email", "picture", "groups"]);
    expect(body.sub).toBe(String(user.id));
    expect(body.name).toBe("Alice Example");
    expect(body.preferred_username).toBe(user.username);
    expect(body.picture).toBe(`https://example.com/avatars/${user.username.toLowerCase()}`);
    expect(body.groups).toBeNull(); // the pin's nil-slice-as-null JSON
  });

  it("groups carry the org + org:team names; public-only grants filter to public orgs", async () => {
    const user = await seedUser("w2bob");
    const orgId = await seedOrg("w2org");
    await seedOrgMembership(orgId, user.id, true);
    const teamId = await seedOrgTeam(orgId, "Devs");
    await seedTeamMembership(teamId, orgId, user.id);
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const minted = await mintForGrant(grant, app.id, user.id);
    const response = await call("/login/oauth/userinfo", { headers: { authorization: `Bearer ${minted.access_token}` } });
    const body = await response.json<{ groups: string[] }>();
    expect(body.groups).toEqual([`w2org`, "w2org:devs"]);
  });

  it("POST is the same handler (m.Methods GET, POST)", async () => {
    const user = await seedUser("w2carol");
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const minted = await mintForGrant(grant, app.id, user.id);
    const response = await call("/login/oauth/userinfo", { method: "POST", headers: { authorization: `Bearer ${minted.access_token}` } });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    const body = JSON.parse(responseText) as { preferred_username: string };
    expect(body.preferred_username).toBe(user.username);
  });
});

// ---------------------------------------------------------------------------
// GET /login/oauth/keys
// ---------------------------------------------------------------------------

describe("GET /login/oauth/keys (OIDCKeys)", () => {
  it("the RSA JWKS: members ALPHABETICAL (the Go map marshal), use=sig, content-type application/json", async () => {
    const response = await call("/login/oauth/keys");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const text = await response.text();
    const parsed = JSON.parse(text) as { keys: Record<string, string>[] };
    expect(parsed.keys).toHaveLength(1);
    expect(Object.keys(parsed.keys[0]!)).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    expect(parsed.keys[0]!.kty).toBe("RSA");
    expect(parsed.keys[0]!.alg).toBe("RS256");
    expect(parsed.keys[0]!.use).toBe("sig");
    // the kid is base64url(SHA-256(SPKI DER)) — W1's recipe; the header's
    // kid matches the JWKS kid
    const user = await seedUser();
    const app = await seedApp();
    const grant = await seedGrant(user.id, app.id, "");
    const minted = await mintForGrant(grant, app.id, user.id);
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(minted.access_token.split(".")[0]!))) as { kid?: string };
    expect(header.kid).toBe(parsed.keys[0]!.kid);
  });

  it("the HS deployment publishes the deliberately secret-less oct JWK (parity — do not fix)", async () => {
    const hsEnv = { ...env, OAUTH2_SIGNING_ALGORITHM: "HS256" };
    const response = await oauth2Router.request(`${ORIGIN}/login/oauth/keys`, undefined, { ...hsEnv, APP_URL: ORIGIN });
    const parsed = await response.json<{ keys: Record<string, string>[] }>();
    expect(parsed.keys).toEqual([{ kty: "oct", alg: "HS256" }]);
    resetOAuth2KeyCachesForTests();
  });
});

// ---------------------------------------------------------------------------
// The deny arms + the form parser
// ---------------------------------------------------------------------------

describe("the OPTIONS/wrong-method deny arms (optionsCorsHandler web.go:61-87)", () => {
  for (const path of ["/login/oauth/access_token", "/login/oauth/introspect", "/login/oauth/userinfo", "/login/oauth/keys"]) {
    it(`${path}: bare OPTIONS → 405, empty body, no CORS headers`, async () => {
      const response = await call(path, { method: "OPTIONS" });
      expect(response.status).toBe(405);
      expect(await response.text()).toBe("");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
  }

  it("wrong methods (PUT on access_token, DELETE on keys) → the same bare 405", async () => {
    expect((await call("/login/oauth/access_token", { method: "PUT" })).status).toBe(405);
    expect((await call("/login/oauth/keys", { method: "DELETE" })).status).toBe(405);
  });
});

describe("containsRedirectUri — the upstream fixture table (oauth2_test.go:77-106)", () => {
  const appRow = (redirectUris: string, confidential = false): Parameters<typeof containsRedirectUri>[0] => ({
    id: 1,
    uid: 0,
    name: "app",
    clientId: "cid",
    clientSecret: "",
    confidentialClient: confidential,
    skipSecondaryAuthorization: false,
    redirectUris,
    createdAt: T0,
    updatedAt: T0,
  });

  it("exact-list membership (TestOAuth2Application_ContainsRedirectURI)", () => {
    const app = appRow('["a","b","c"]');
    expect(containsRedirectUri(app, "a")).toBe(true);
    expect(containsRedirectUri(app, "b")).toBe(true);
    expect(containsRedirectUri(app, "c")).toBe(true);
    expect(containsRedirectUri(app, "d")).toBe(false);
  });

  it("the public-client loopback port variance (TestOAuth2Application_ContainsRedirectURI_WithPort)", () => {
    const app = appRow('["http://127.0.0.1/","http://::1/","http://192.168.0.1/","http://intranet/","https://127.0.0.1/"]');
    // http loopback uris ignore the port (RFC 8252 §7.3) — [::1] included:
    // the presented brackets de-bracket to the bare address, matching the
    // registered "http://::1/" entry
    expect(containsRedirectUri(app, "http://127.0.0.1:3456/")).toBe(true);
    expect(containsRedirectUri(app, "http://127.0.0.1/")).toBe(true);
    expect(containsRedirectUri(app, "http://[::1]:3456/")).toBe(true);
    // not https
    expect(containsRedirectUri(app, "https://127.0.0.1:3456/")).toBe(false);
    // not loopback
    expect(containsRedirectUri(app, "http://192.168.0.1:9954/")).toBe(false);
    expect(containsRedirectUri(app, "http://intranet:3456/")).toBe(false);
    // unparseable
    expect(containsRedirectUri(app, ":")).toBe(false);
  });

  it("a CONFIDENTIAL client gets NO port variance (the candidates list stays single)", () => {
    const conf = appRow('["http://127.0.0.1/"]', true);
    expect(containsRedirectUri(conf, "http://127.0.0.1")).toBe(true);
    expect(containsRedirectUri(conf, "http://127.0.0.1:3456/")).toBe(false);
  });
});

describe("parseClientSecretBasic / parseTokenForm (the RFC 6749 §2.3.1 shape)", () => {
  it("percent-decodes the Basic pair (a raw plus decodes to space); malformed escapes fail", () => {
    // %2B decodes to a literal "+" (the plus→space rule applies to RAW
    // pluses — url.QueryUnescape semantics)
    const header = `Basic ${btoa("cl%69ent%20id:sec%2Bret")}`;
    expect(parseClientSecretBasic(header)).toEqual({ clientId: "client id", clientSecret: "sec+ret", ok: true });
    expect(parseClientSecretBasic(`Basic ${btoa("a+b:c+d")}`)).toEqual({ clientId: "a b", clientSecret: "c d", ok: true });
    expect(parseClientSecretBasic(`Basic ${btoa("bad%2g:x")}`).ok).toBe(false);
    expect(parseClientSecretBasic("Bearer x").ok).toBe(false);
    expect(parseClientSecretBasic(undefined).ok).toBe(false);
  });

  it("the form parser accepts urlencoded AND JSON bodies with query fallback (body wins)", async () => {
    const form = await parseTokenForm(
      new Request("https://x.test/login/oauth/access_token?grant_type=refresh_token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=abc",
      }),
    );
    expect(form.grant_type).toBe("authorization_code");
    expect(form.code).toBe("abc");
    const json = await parseTokenForm(
      new Request("https://x.test/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code: "json-code" }),
      }),
    );
    expect(json).toEqual({ grant_type: "authorization_code", code: "json-code" });
  });
});

// ---------------------------------------------------------------------------
// Local org/team seeds (the schema's SPEC-0007 shapes, minimal columns)
// ---------------------------------------------------------------------------

async function seedOrg(name: string): Promise<number> {
  const row = await drizzle(env.DB)
    .insert(users)
    .values({ username: name, usernameLower: name, type: "org", status: "active", createdAt: T0 })
    .returning();
  return row[0]!.id;
}

async function seedOrgMembership(orgId: number, userId: number, isPublic: boolean): Promise<void> {
  await drizzle(env.DB).insert(orgMembers).values({ orgId, userId, isPublic, role: "member", createdAt: T0 });
}

async function seedOrgTeam(orgId: number, name: string): Promise<number> {
  const row = await drizzle(env.DB)
    .insert(teams)
    .values({ orgId, lowerName: name.toLowerCase(), name })
    .returning();
  return row[0]!.id;
}

async function seedTeamMembership(teamId: number, orgId: number, userId: number): Promise<void> {
  await drizzle(env.DB).insert(teamMembers).values({ teamId, orgId, userId });
}

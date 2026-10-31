/**
 * W4's suites (SPEC specs/oauth2-provider.md §5 "userinfo/introspect/keys/
 * well-known" + "Gate"): the discovery document's byte shape (the pin's
 * map marshal — SORTED top-level keys, arrays in declaration order, compact
 * ctx.JSON bytes), the issuer equality with the id_token (one source —
 * oauth2Issuer), the configured-alg publication, and THE GATE — the
 * OAUTH2_ENABLED 403 wrap over the whole /login/oauth group (both routers,
 * every endpoint, the OPTIONS probes included) plus the well-known's own
 * 404 arm, and the git-HTTP realm pair (githttp.go:146-159's conditional).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { resetAuthTables, seedVerifiedUser } from "../auth/testing/seeds";
import { oauth2Applications, users } from "../db/schema";
import { base64UrlDecode } from "../services/oauth2/jws";
import { getOrCreateGrant } from "../services/oauth2/grants";
import { resetOAuth2KeyCachesForTests } from "../services/oauth2/keys";
import { loadOAuth2SigningMaterial, mintTokenTrio, oauth2FeatureEnabled, oauth2Issuer } from "../services/oauth2/token";
import { basicChallenge, BASIC_AUTH_CHALLENGE, OAUTH2_BASIC_CHALLENGE } from "../git-http/respond";
import { oauth2Router } from "./oauth2-token";
import { oauth2WellKnownRouter, type OAuth2WellKnownEnv } from "./oauth2-wellknown";
import { oauth2AuthorizeRouter } from "../ui/oauth2-authorize";

const ORIGIN = "https://example.com";
const WELL_KNOWN_URL = `${ORIGIN}/.well-known/openid-configuration`;

const NOW = (): Date => new Date();

beforeAll(applyAuthD1Migrations);
beforeEach(async () => {
  await resetAuthTables();
  await env.DB.prepare("DELETE FROM oauth2_authorization_code").run();
  await env.DB.prepare("DELETE FROM oauth2_grant").run();
  await env.DB.prepare("DELETE FROM oauth2_application").run();
  // the storage reset wipes the keystore row — the module-level key cache
  // must follow it (the token suite's discipline).
  resetOAuth2KeyCachesForTests();
});

/** The well-known route's env slice (the router's own alias — the generated
 *  Env may not type the vars yet; the overrides pin each test's polarity). */
const wellKnownEnv = (overrides: Record<string, string | undefined> = {}): OAuth2WellKnownEnv => ({
  ...env,
  APP_URL: ORIGIN,
  OAUTH2_ENABLED: undefined,
  OAUTH2_SIGNING_ALGORITHM: undefined,
  OAUTH2_JWT_CLAIM_ISSUER: undefined,
  ...overrides,
});

/** The authorize router reads `Env` — the gate's var rides the same widened
 *  alias shape (Omit + widen, the OAuth2TokenEnv posture; the generated Env
 *  types the var as its literal, so the alias drops the literal member). */
type AuthorizeTestEnv = Omit<Env, "OAUTH2_ENABLED"> & { OAUTH2_ENABLED?: string };
const authorizeEnv = (oauth2Enabled?: string): AuthorizeTestEnv => ({ ...env, OAUTH2_ENABLED: oauth2Enabled });

async function callWellKnown(overrides: Record<string, string> = {}): Promise<Response> {
  return await oauth2WellKnownRouter.request(WELL_KNOWN_URL, undefined, wellKnownEnv(overrides));
}

// ---------------------------------------------------------------------------
// The discovery document (oauth2_wellknown.go:16-69)
// ---------------------------------------------------------------------------

describe("GET /.well-known/openid-configuration — the document shape", () => {
  it("emits the pin's map marshal: sorted top-level keys, exact member set, compact ctx.JSON bytes", async () => {
    const response = await callWellKnown();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const text = await response.text();
    // ctx.JSON (base.go:114-120) is compact with NO trailing newline.
    expect(text.endsWith("\n")).toBe(false);
    expect(text).not.toContain("\n");
    const doc = JSON.parse(text) as Record<string, unknown>;
    // Go map[string]any over jsonv2: members emitted in SORTED key order.
    expect(Object.keys(doc)).toEqual(
      Object.keys(doc).slice().sort(),
    );
    expect(Object.keys(doc)).toEqual([
      "authorization_endpoint",
      "claims_supported",
      "code_challenge_methods_supported",
      "grant_types_supported",
      "id_token_signing_alg_values_supported",
      "introspection_endpoint",
      "issuer",
      "jwks_uri",
      "response_types_supported",
      "scopes_supported",
      "subject_types_supported",
      "token_endpoint",
      "userinfo_endpoint",
    ]);
    // Slices keep the pin's declaration order verbatim (:32-66).
    expect(doc.claims_supported).toEqual([
      "aud",
      "exp",
      "iat",
      "iss",
      "sub",
      "name",
      "preferred_username",
      "profile",
      "picture",
      "website",
      "locale",
      "updated_at",
      "email",
      "email_verified",
      "groups",
    ]);
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.subject_types_supported).toEqual(["public"]);
    expect(doc.scopes_supported).toEqual(["openid", "profile", "email", "groups"]);
    expect(doc.code_challenge_methods_supported).toEqual(["plain", "S256"]);
    expect(doc.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });

  it("issuer = AppURL minus the trailing slash; endpoints AppURL-absolute", async () => {
    const doc = await (await callWellKnown()).json<Record<string, unknown>>();
    expect(doc.issuer).toBe("https://example.com");
    expect(doc.authorization_endpoint).toBe(`${ORIGIN}/login/oauth/authorize`);
    expect(doc.token_endpoint).toBe(`${ORIGIN}/login/oauth/access_token`);
    expect(doc.jwks_uri).toBe(`${ORIGIN}/login/oauth/keys`);
    expect(doc.userinfo_endpoint).toBe(`${ORIGIN}/login/oauth/userinfo`);
    expect(doc.introspection_endpoint).toBe(`${ORIGIN}/login/oauth/introspect`);
  });

  it("OAUTH2_JWT_CLAIM_ISSUER moves ONLY the issuer member (the endpoints stay AppURL-derived)", async () => {
    const doc = await (await callWellKnown({ OAUTH2_JWT_CLAIM_ISSUER: "https://sso.example.internal" })).json<
      Record<string, unknown>
    >();
    expect(doc.issuer).toBe("https://sso.example.internal");
    expect(doc.token_endpoint).toBe(`${ORIGIN}/login/oauth/access_token`);
  });

  it("id_token_signing_alg_values_supported publishes exactly the configured alg (default RS256)", async () => {
    const doc = await (await callWellKnown()).json<Record<string, unknown>>();
    expect(doc.id_token_signing_alg_values_supported).toEqual(["RS256"]);
    const esDoc = await (await callWellKnown({ OAUTH2_SIGNING_ALGORITHM: "ES256" })).json<Record<string, unknown>>();
    expect(esDoc.id_token_signing_alg_values_supported).toEqual(["ES256"]);
  });

  it("the discovery issuer and the id_token iss share one source (oauth2Issuer)", async () => {
    const overrides = { OAUTH2_JWT_CLAIM_ISSUER: "https://id.example.internal" };
    const user = (await seedVerifiedUser({ username: "issueruser" })).id;
    const appRow = (
      await drizzle(env.DB)
        .insert(oauth2Applications)
        .values({
          uid: 0,
          name: "issuer-app",
          clientId: "issuer-client",
          clientSecret: "",
          confidentialClient: false,
          redirectUris: '["http://127.0.0.1"]',
          createdAt: NOW(),
          updatedAt: NOW(),
        })
        .returning()
    )[0]!;
    const { grant } = await getOrCreateGrant(env.DB, { userId: user, applicationId: appRow.id, scope: "openid" }, NOW());
    const userRow = (await drizzle(env.DB).select().from(users).where(eq(users.id, user)).get())!;
    const material = await loadOAuth2SigningMaterial(env.DB);
    const result = await mintTokenTrio({
      db: env.DB,
      grant,
      application: appRow,
      user: userRow,
      material,
      issuer: oauth2Issuer({ ...env, ...overrides }, ORIGIN),
      appUrl: `${ORIGIN}/`,
      now: NOW(),
    });
    if (!result.ok) throw new Error("mint failed");
    const idClaims = JSON.parse(
      new TextDecoder().decode(base64UrlDecode((result.response.id_token as string).split(".")[1]!)),
    ) as { iss: string };
    const doc = await (await callWellKnown(overrides)).json<{ issuer: string }>();
    // openid-connect-discovery §4 / access_token.go:136-152: the iss claim
    // and the discovery issuer are the SAME string.
    expect(idClaims.iss).toBe("https://id.example.internal");
    expect(doc.issuer).toBe(idClaims.iss);
  });

  it("the disabled provider answers Go http.NotFound — 404 page not found, not 403", async () => {
    const response = await callWellKnown({ OAUTH2_ENABLED: "false" });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("404 page not found\n");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

// ---------------------------------------------------------------------------
// THE GATE — oauth2Enabled over the /login/oauth group (web.go:373-378, 631)
// ---------------------------------------------------------------------------

/** The provider family's every endpoint, both routers — the disabled arm
 *  403s them all BEFORE any handler logic (upstream's group middleware is
 *  outermost: reqSignIn and optionsCorsHandler never run). */
const TOKEN_ENDPOINTS: Array<{ path: string; init: RequestInit }> = [
  { path: "/login/oauth/access_token", init: { method: "POST", body: "grant_type=authorization_code" } },
  { path: "/login/oauth/introspect", init: { method: "POST", body: "token=x" } },
  { path: "/login/oauth/userinfo", init: { method: "GET" } },
  { path: "/login/oauth/userinfo", init: { method: "POST" } },
  { path: "/login/oauth/keys", init: { method: "GET" } },
];

describe("the OAUTH2_ENABLED gate — the /login/oauth group 403 (both routers)", () => {
  it("403 Forbidden on every W2 endpoint when disabled — OPTIONS probes included", async () => {
    for (const endpoint of TOKEN_ENDPOINTS) {
      const response = await oauth2Router.request(`${ORIGIN}${endpoint.path}`, endpoint.init, wellKnownEnv({ OAUTH2_ENABLED: "false" }));
      expect(response.status, endpoint.path).toBe(403);
      expect(await response.text()).toBe("Forbidden\n");
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    // The bare-OPTIONS probe rides the group wrap too (upstream:
    // oauth2Enabled is the group's option — it runs BEFORE
    // optionsCorsHandler, so a disabled provider never reaches the 405).
    const options = await oauth2Router.request(`${ORIGIN}/login/oauth/keys`, { method: "OPTIONS" }, wellKnownEnv({ OAUTH2_ENABLED: "false" }));
    expect(options.status).toBe(403);
    expect(await options.text()).toBe("Forbidden\n");
  });

  it("403 before any session read on the W3 authorize/grant pair when disabled", async () => {
    for (const [path, init] of [
      ["/login/oauth/authorize", { method: "GET" }],
      ["/login/oauth/authorize", { method: "POST", body: "client_id=x" }],
      ["/login/oauth/grant", { method: "POST", body: "client_id=x" }],
    ] as const) {
      const response = await oauth2AuthorizeRouter.request(
        `${ORIGIN}${path}`,
        { ...init, headers: { "content-type": "application/x-www-form-urlencoded" } },
        authorizeEnv("false"),
      );
      expect(response.status, path).toBe(403);
      expect(await response.text()).toBe("Forbidden\n");
    }
  });

  it("enabled (the default polarity): the same requests pass the gate — keys 200, OPTIONS 405, authorize 303", async () => {
    const keys = await oauth2Router.request(`${ORIGIN}/login/oauth/keys`, undefined, wellKnownEnv());
    expect(keys.status).toBe(200);
    // bare OPTIONS → the deny arm (405), NOT the gate's 403.
    const options = await oauth2Router.request(`${ORIGIN}/login/oauth/keys`, { method: "OPTIONS" }, wellKnownEnv());
    expect(options.status).toBe(405);
    // anonymous authorize → the reqSignIn 303 (the gate let it through).
    const authorize = await oauth2AuthorizeRouter.request(`${ORIGIN}/login/oauth/authorize?response_type=code`, undefined, authorizeEnv(undefined));
    expect(authorize.status).toBe(303);
    expect(authorize.headers.get("location")).toContain("/login");
    // userinfo without credentials → the handler's own 401 (not 403).
    const userinfo = await oauth2Router.request(`${ORIGIN}/login/oauth/userinfo`, undefined, wellKnownEnv());
    expect(userinfo.status).toBe(401);
  });

  it("the gate reads strict polarity — ONLY the exact string 'false' disables", () => {
    expect(oauth2FeatureEnabled({})).toBe(true);
    expect(oauth2FeatureEnabled({ OAUTH2_ENABLED: undefined })).toBe(true);
    expect(oauth2FeatureEnabled({ OAUTH2_ENABLED: "true" })).toBe(true);
    expect(oauth2FeatureEnabled({ OAUTH2_ENABLED: "false" })).toBe(false);
    // The DEMO_MODE class: every other spelling is truthy (fail-open parity
    // with upstream's boolean default true).
    expect(oauth2FeatureEnabled({ OAUTH2_ENABLED: "False" })).toBe(true);
    expect(oauth2FeatureEnabled({ OAUTH2_ENABLED: "0" })).toBe(true);
    expect(oauth2FeatureEnabled({ OAUTH2_ENABLED: "" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The git-HTTP realm pair (githttp.go:146-159 — SPEC §2.11's flip)
// ---------------------------------------------------------------------------

describe("the git-HTTP 401 challenge realm follows the provider gate", () => {
  it("enabled ⇒ Basic realm=\"Gitea\" (the GCM built-in-application bait); disabled ⇒ the (Basic Auth) fallback", async () => {
    const enabled = basicChallenge(true);
    expect(enabled.headers.get("www-authenticate")).toBe(OAUTH2_BASIC_CHALLENGE);
    expect(OAUTH2_BASIC_CHALLENGE).toBe('Basic realm="Gitea"');
    const disabled = basicChallenge(false);
    expect(disabled.headers.get("www-authenticate")).toBe(BASIC_AUTH_CHALLENGE);
    expect(BASIC_AUTH_CHALLENGE).toBe('Basic realm="Gitea (Basic Auth)"');
    // The challenge body stays the landed 401 shape (respond.ts plainText —
    // Gitea's PlainText spelling, NO space in the type).
    for (const challenge of [enabled, disabled]) {
      expect(challenge.status).toBe(401);
      expect(await challenge.text()).toBe("Unauthorized\n");
      expect(challenge.headers.get("content-type")).toBe("text/plain;charset=utf-8");
      expect(challenge.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

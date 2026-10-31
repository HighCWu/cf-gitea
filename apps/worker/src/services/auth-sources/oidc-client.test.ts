/**
 * The OIDC client suite (specs/external-auth-sources.md §8 "Flow" — the
 * client arms): discovery fetch/parse with the freshness-hint memo, the
 * discovery-URL join rule, the authorize-URL parameter set, and the code
 * exchange + id_token VERIFY MATRIX over the landed JWS substrate — REAL
 * WebCrypto-signed tokens (RS256/ES256/HS256), no fake-signing shortcut
 * (the pin's own fake IdP uses alg:none because goth never verifies —
 * auth_oauth2_test.go:305-315; §5.4 makes real verification our recorded
 * hardening, so the matrix proves the wiring with genuine signatures).
 *
 * The IdP is a URL-keyed fetch stub (SPEC §8): discovery, JWKS, and token
 * endpoints served from in-test fixtures; every request recorded.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { signJws, importSigningKey, type JwsAlgorithm } from "../oauth2/jws";
import { parseOAuth2SourceConfig, serializeOAuth2SourceConfig } from "./cfg";
import {
  buildOidcAuthorizeUrl,
  discoveryDocumentUrl,
  exchangeOidcCode,
  fetchOidcDiscovery,
  type JwksKey,
  OidcVerifyError,
  resetOidcDiscoveryCacheForTests,
  resolveOAuth2Client,
} from "./oidc-client";

const T0 = 1767225600; // 2026-01-01T00:00:00Z, unix seconds

async function generateAsymmetric(alg: JwsAlgorithm): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const suffix = alg.slice(2) as "256" | "384" | "512";
  const hash: "SHA-256" | "SHA-384" | "SHA-512" = `SHA-${suffix}`;
  const params =
    alg[0] === "R"
      ? ({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash } as const)
      : ({ name: "ECDSA", namedCurve: suffix === "256" ? "P-256" : suffix === "384" ? "P-384" : "P-521" } as const);
  const pair = await crypto.subtle.generateKey(params, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("keygen did not return a pair");
  return {
    privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
    publicJwk: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey,
  };
}

interface RecordedRequest {
  url: string;
  method: string;
  body: string | null;
}

interface StubIdp {
  discovery: Record<string, unknown>;
  jwks: { keys: JwksKey[] };
  tokenResponse: Record<string, unknown>;
  /** Override the discovery/JWKS/token answers per test. */
  status?: { discovery?: number; jwks?: number; token?: number };
  calls: RecordedRequest[];
  fetchImpl: typeof fetch;
}

function stubIdp(overrides: Partial<StubIdp> = {}): StubIdp {
  const idp: StubIdp = {
    discovery: {
      issuer: "https://idp.example.com",
      authorization_endpoint: "https://idp.example.com/authorize",
      token_endpoint: "https://idp.example.com/token",
      jwks_uri: "https://idp.example.com/jwks.json",
    },
    jwks: { keys: [] },
    tokenResponse: {},
    calls: [],
    fetchImpl: (): Promise<Response> => Promise.reject(new Error("unreached")),
    ...overrides,
  };
  idp.fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    idp.calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
    const respond = (payload: unknown, status: number): Promise<Response> =>
      Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }));
    if (url.startsWith("https://idp.example.com/.well-known/openid-configuration")) {
      return respond(idp.discovery, idp.status?.discovery ?? 200);
    }
    if (url === "https://idp.example.com/jwks.json") {
      return respond(idp.jwks, idp.status?.jwks ?? 200);
    }
    if (url === "https://idp.example.com/token") {
      return respond(idp.tokenResponse, idp.status?.token ?? 200);
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return idp;
}

interface SignedToken {
  token: string;
  /** The public half for the stub's JWKS — null for the HMAC arms (the
   *  secret, not the JWKS, is the key). */
  publicJwk: JsonWebKey | null;
  alg: JwsAlgorithm;
}

async function signIdToken(options: {
  alg: JwsAlgorithm;
  claims: Record<string, unknown>;
  kid?: string;
  hmacSecret?: string;
  key?: { privateJwk: JsonWebKey; publicJwk: JsonWebKey };
}): Promise<SignedToken> {
  if (options.alg.startsWith("HS")) {
    const secret = options.hmacSecret ?? "client-secret";
    const key = await importSigningKey(options.alg, secret);
    return { token: await signJws({ alg: options.alg, key, claims: options.claims, kid: options.kid }), publicJwk: null, alg: options.alg };
  }
  const pair = options.key ?? (await generateAsymmetric(options.alg));
  const key = await importSigningKey(options.alg, pair.privateJwk);
  return { token: await signJws({ alg: options.alg, key, claims: options.claims, kid: options.kid }), publicJwk: pair.publicJwk, alg: options.alg };
}

const baseClaims = (): Record<string, unknown> => ({
  iss: "https://idp.example.com",
  aud: "client-id",
  exp: T0 + 3600,
  iat: T0 - 10,
  sub: "sub-123",
  email: "jane@example.com",
  name: "Jane Doe",
  preferred_username: "jane",
  given_name: "Jane",
  family_name: "Doe",
  picture: "https://idp.example.com/a/jane.png",
});

const oidcCfg = (extra: Record<string, unknown> = {}): string =>
  serializeOAuth2SourceConfig({
    v: 1,
    provider: "openidConnect",
    clientId: "client-id",
    clientSecret: "client-secret",
    discoveryUrl: "https://idp.example.com",
    ...extra,
  });

/** Run a full exchange against the stub with a signed id_token. */
async function runExchange(options: {
  idp: StubIdp;
  /** `null` = the stub answers with NO id_token (the missing-field arm). */
  token: string | null;
  expectedNonce?: string;
  nowSec?: number;
  cfg?: string;
  discoveryOverrides?: Record<string, unknown>;
  redirectUri?: string;
}) {
  const idp = options.idp;
  idp.tokenResponse =
    options.token === null
      ? { access_token: "at", token_type: "Bearer" }
      : { access_token: "at", token_type: "Bearer", id_token: options.token };
  if (options.discoveryOverrides !== undefined) idp.discovery = { ...idp.discovery, ...options.discoveryOverrides };
  const discovery = await fetchOidcDiscovery(idp.fetchImpl, "row:1", "https://idp.example.com");
  return exchangeOidcCode({
    fetchImpl: idp.fetchImpl,
    document: discovery.document,
    entry: discovery.entry,
    cfg: parseOAuth2SourceConfig(options.cfg ?? oidcCfg()),
    redirectUri: options.redirectUri ?? "https://app.example.com/user/oauth2/OIDC/callback",
    code: "the-code",
    expectedNonce: options.expectedNonce,
    nowSec: options.nowSec ?? T0,
  });
}

beforeEach(() => {
  resetOidcDiscoveryCacheForTests();
});

describe("discoveryDocumentUrl (the goth join rule)", () => {
  it("appends the well-known suffix, trimming trailing slashes", () => {
    expect(discoveryDocumentUrl("https://idp.example.com")).toBe("https://idp.example.com/.well-known/openid-configuration");
    expect(discoveryDocumentUrl("https://idp.example.com/")).toBe("https://idp.example.com/.well-known/openid-configuration");
  });

  it("uses verbatim a URL already ending in the well-known path (goth New)", () => {
    expect(discoveryDocumentUrl("https://idp.example.com/adfs/.well-known/openid-configuration")).toBe(
      "https://idp.example.com/adfs/.well-known/openid-configuration",
    );
  });
});

describe("fetchOidcDiscovery (fetch/parse + the freshness-hint memo)", () => {
  it("fetches the joined document and parses the four consumed fields", async () => {
    const idp = stubIdp();
    const { document } = await fetchOidcDiscovery(idp.fetchImpl, "row:1", "https://idp.example.com");
    expect(document).toEqual({
      issuer: "https://idp.example.com",
      authorizationEndpoint: "https://idp.example.com/authorize",
      tokenEndpoint: "https://idp.example.com/token",
      jwksUri: "https://idp.example.com/jwks.json",
    });
    expect(idp.calls.map((call) => call.url)).toEqual(["https://idp.example.com/.well-known/openid-configuration"]);
  });

  it("memoizes per rowKey — a second call with the same key makes NO fetch", async () => {
    const idp = stubIdp();
    await fetchOidcDiscovery(idp.fetchImpl, "row:1", "https://idp.example.com");
    await fetchOidcDiscovery(idp.fetchImpl, "row:1", "https://idp.example.com");
    expect(idp.calls).toHaveLength(1);
    // A different rowKey (a row edit — updatedAt moved) re-fetches.
    await fetchOidcDiscovery(idp.fetchImpl, "row:2", "https://idp.example.com");
    expect(idp.calls).toHaveLength(2);
  });

  it("a non-2xx discovery answer is the discovery-fetch failure", async () => {
    const idp = stubIdp({ status: { discovery: 503 } });
    await expect(fetchOidcDiscovery(idp.fetchImpl, "row:1", "https://idp.example.com")).rejects.toThrow(OidcVerifyError);
    try {
      await fetchOidcDiscovery(idp.fetchImpl, "row:9", "https://idp.example.com");
    } catch (error) {
      expect((error as OidcVerifyError).code).toBe("discovery-fetch");
    }
  });

  it("a shape-incomplete document is the discovery-shape failure", async () => {
    const idp = stubIdp({ discovery: { issuer: "https://idp.example.com", authorization_endpoint: "https://x" } });
    await expect(fetchOidcDiscovery(idp.fetchImpl, "row:1", "https://idp.example.com")).rejects.toMatchObject({
      name: "OidcVerifyError",
      code: "discovery-shape",
    });
  });

  it("a network-level refusal (transport error) is discovery-fetch", async () => {
    const idp = stubIdp();
    idp.fetchImpl = (): Promise<Response> => Promise.reject(new Error("dns failure"));
    await expect(fetchOidcDiscovery(idp.fetchImpl, "row:1", "https://idp.example.com")).rejects.toMatchObject({ code: "discovery-fetch" });
  });
});

describe("buildOidcAuthorizeUrl (goth GetAuthURL's parameter set)", () => {
  const discovery = {
    issuer: "https://idp.example.com",
    authorizationEndpoint: "https://idp.example.com/authorize",
    tokenEndpoint: "https://idp.example.com/token",
    jwksUri: "https://idp.example.com/jwks.json",
  };

  it("carries response_type/client_id/redirect_uri/scope/state/nonce", () => {
    const url = new URL(
      buildOidcAuthorizeUrl(discovery, parseOAuth2SourceConfig(oidcCfg()), "https://app.example.com/cb", "state-1", "nonce-1"),
    );
    expect(url.origin + url.pathname).toBe("https://idp.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/cb");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("nonce")).toBe("nonce-1");
  });

  it("the source's scopes join space-separated; EMPTY scopes default to openid", () => {
    const withScopes = new URL(
      buildOidcAuthorizeUrl(discovery, parseOAuth2SourceConfig(oidcCfg({ scopes: ["email", "profile"] })), "https://cb", "s", "n"),
    );
    expect(withScopes.searchParams.get("scope")).toBe("email profile");
    const defaultScope = new URL(
      buildOidcAuthorizeUrl(discovery, parseOAuth2SourceConfig(oidcCfg()), "https://cb", "s", "n"),
    );
    expect(defaultScope.searchParams.get("scope")).toBe("openid");
  });

  it("an endpoint already carrying a query joins with &", () => {
    const url = buildOidcAuthorizeUrl(
      { ...discovery, authorizationEndpoint: "https://idp.example.com/authorize?prompt=login" },
      parseOAuth2SourceConfig(oidcCfg()),
      "https://cb",
      "s",
      "n",
    );
    expect(url).toContain("prompt=login&");
  });
});

describe("exchangeOidcCode — the wire shape", () => {
  it("POSTs the form-encoded code exchange (grant_type/code/redirect_uri/client_id/client_secret)", async () => {
    const idp = stubIdp();
    const signed = await signIdToken({ alg: "RS256", claims: baseClaims(), kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1", alg: "RS256" }] };
    await runExchange({ idp, token: signed.token });

    const tokenCall = idp.calls.find((call) => call.url === "https://idp.example.com/token");
    expect(tokenCall?.method).toBe("POST");
    const params = new URLSearchParams(tokenCall?.body ?? "");
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("the-code");
    expect(params.get("redirect_uri")).toBe("https://app.example.com/user/oauth2/OIDC/callback");
    expect(params.get("client_id")).toBe("client-id");
    expect(params.get("client_secret")).toBe("client-secret");
  });

  it("a non-2xx token answer is the token-fetch failure", async () => {
    const idp = stubIdp({ status: { token: 400 } });
    const signed = await signIdToken({ alg: "RS256", claims: baseClaims(), kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    await expect(runExchange({ idp, token: signed.token })).rejects.toMatchObject({ code: "token-fetch" });
  });

  it("a token answer without id_token is the id-token-missing failure", async () => {
    const idp = stubIdp();
    await expect(runExchange({ idp, token: null })).rejects.toMatchObject({ code: "id-token-missing" });
  });
});

describe("id_token verify matrix (SPEC §8 Flow — good arms first)", () => {
  it("RS256: good token with kid match resolves the identity claims", async () => {
    const idp = stubIdp();
    const signed = await signIdToken({ alg: "RS256", claims: baseClaims(), kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    const result = await runExchange({ idp, token: signed.token, expectedNonce: undefined });
    expect(result.identity).toEqual({
      externalId: "sub-123",
      email: "jane@example.com",
      name: "Jane Doe",
      nickName: "jane",
      avatarUrl: "https://idp.example.com/a/jane.png",
      firstName: "Jane",
      lastName: "Doe",
    });
    expect(result.header.alg).toBe("RS256");
  });

  it("ES256: good token verifies (the JOSE raw r||s alignment rides jws.ts's suite)", async () => {
    const idp = stubIdp();
    const signed = await signIdToken({ alg: "ES256", claims: baseClaims(), kid: "k2" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k2" }] };
    const result = await runExchange({ idp, token: signed.token });
    expect(result.identity.externalId).toBe("sub-123");
  });

  it("HS256: the id_token verifies against the CLIENT SECRET as the HMAC key", async () => {
    const idp = stubIdp();
    const signed = await signIdToken({ alg: "HS256", claims: baseClaims(), hmacSecret: "client-secret" });
    // No JWKS key would match an HS token — the secret, not the JWKS, is the key.
    idp.jwks = { keys: [{ kty: "EC", crv: "P-256", x: "a", y: "b" }] };
    const result = await runExchange({ idp, token: signed.token });
    expect(result.identity.externalId).toBe("sub-123");
  });

  it("kid miss: a header kid with no JWKS twin is jwks-key-miss", async () => {
    const idp = stubIdp();
    const signed = await signIdToken({ alg: "RS256", claims: baseClaims(), kid: "nope" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    await expect(runExchange({ idp, token: signed.token })).rejects.toMatchObject({ code: "jwks-key-miss" });
  });

  it("kidless header against a single keyless JWKS entry matches (the single-IdP-key shape)", async () => {
    const idp = stubIdp();
    const signed = await signIdToken({ alg: "RS256", claims: baseClaims() });
    idp.jwks = { keys: [signed.publicJwk!] };
    const result = await runExchange({ idp, token: signed.token });
    expect(result.identity.externalId).toBe("sub-123");
  });

  it("wrong iss: the claim must equal the DISCOVERY issuer exactly", async () => {
    const idp = stubIdp();
    const claims = { ...baseClaims(), iss: "https://evil.example.com" };
    const signed = await signIdToken({ alg: "RS256", claims, kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    await expect(runExchange({ idp, token: signed.token })).rejects.toMatchObject({ code: "issuer-mismatch" });
  });

  it("wrong aud: the source client_id must be among the audiences", async () => {
    const idp = stubIdp();
    const claims = { ...baseClaims(), aud: "someone-else" };
    const signed = await signIdToken({ alg: "RS256", claims, kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    await expect(runExchange({ idp, token: signed.token })).rejects.toMatchObject({ code: "claims" });
  });

  it("aud array containing the client_id passes", async () => {
    const idp = stubIdp();
    const claims = { ...baseClaims(), aud: ["other", "client-id"] };
    const signed = await signIdToken({ alg: "RS256", claims, kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    const result = await runExchange({ idp, token: signed.token });
    expect(result.identity.externalId).toBe("sub-123");
  });

  it("expired (exp < now, zero leeway) is the claims failure", async () => {
    const idp = stubIdp();
    const claims = { ...baseClaims(), exp: T0 - 1 };
    const signed = await signIdToken({ alg: "RS256", claims, kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    await expect(runExchange({ idp, token: signed.token })).rejects.toMatchObject({ code: "claims" });
  });

  it("iat in the future (iat > now, zero leeway) is the claims failure", async () => {
    const idp = stubIdp();
    const claims = { ...baseClaims(), iat: T0 + 60 };
    const signed = await signIdToken({ alg: "RS256", claims, kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    await expect(runExchange({ idp, token: signed.token })).rejects.toMatchObject({ code: "claims" });
  });

  it("nonce mismatch is the nonce failure", async () => {
    const idp = stubIdp();
    const claims = { ...baseClaims(), nonce: "other-nonce" };
    const signed = await signIdToken({ alg: "RS256", claims, kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    await expect(runExchange({ idp, token: signed.token, expectedNonce: "parked-nonce" })).rejects.toMatchObject({ code: "nonce" });
  });

  it("the parked nonce matching passes", async () => {
    const idp = stubIdp();
    const claims = { ...baseClaims(), nonce: "parked-nonce" };
    const signed = await signIdToken({ alg: "RS256", claims, kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    const result = await runExchange({ idp, token: signed.token, expectedNonce: "parked-nonce" });
    expect(result.identity.externalId).toBe("sub-123");
  });

  it("alg confusion `none` is rejected BEFORE any key work (no JWKS fetch)", async () => {
    const idp = stubIdp();
    const header = btoa(JSON.stringify({ alg: "none" })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const payload = btoa(JSON.stringify(baseClaims())).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const noneToken = `${header}.${payload}.`;
    await expect(runExchange({ idp, token: noneToken })).rejects.toMatchObject({ code: "alg-unsupported" });
    // The rejection happened before the JWKS endpoint was ever contacted.
    expect(idp.calls.filter((call) => call.url.endsWith("/jwks.json"))).toHaveLength(0);
  });

  it("the HS-with-public-key confusion attempt is structurally dead: the HMAC key is ALWAYS the client secret, never a JWKS entry", async () => {
    const idp = stubIdp();
    // The RFC 8724-class attack — the attacker signs HS256 with a secret
    // of their choosing and publishes the matching key material in the
    // JWKS, hoping the verifier takes the HMAC key from there. This client
    // never does: an HS id_token verifies against the source's
    // client_secret, so the attacker-signed token simply fails the
    // signature gate (the import-refusal arm jws.ts carries guards the
    // direct-JWK path; the client never routes a JWK into the HMAC key).
    const signed = await signIdToken({ alg: "HS256", claims: baseClaims(), hmacSecret: "attacker-chosen" });
    idp.jwks = { keys: [{ kty: "EC", crv: "P-256", x: "a", y: "b" }] };
    await expect(runExchange({ idp, token: signed.token })).rejects.toMatchObject({ code: "signature" });
  });

  it("a tampered payload fails the signature gate", async () => {
    const idp = stubIdp();
    const signed = await signIdToken({ alg: "RS256", claims: baseClaims(), kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    const [h, , s] = signed.token.split(".");
    const forgedPayload = btoa(JSON.stringify({ ...baseClaims(), sub: "admin-victim" }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    await expect(runExchange({ idp, token: `${h}.${forgedPayload}.${s}` })).rejects.toMatchObject({ code: "signature" });
  });

  it("unsupported-but-table-adjacent algs (EdDSA, RS256D) are alg-unsupported", async () => {
    const idp = stubIdp();
    const header = btoa(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const payload = btoa(JSON.stringify(baseClaims())).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    await expect(runExchange({ idp, token: `${header}.${payload}.sig` })).rejects.toMatchObject({ code: "alg-unsupported" });
  });

  it("missing sub (and no externalIdClaim) is external-id-missing", async () => {
    const idp = stubIdp();
    const claims = { ...baseClaims() };
    delete claims.sub;
    const signed = await signIdToken({ alg: "RS256", claims, kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    await expect(runExchange({ idp, token: signed.token })).rejects.toMatchObject({ code: "external-id-missing" });
  });

  it("externalIdClaim override: the admin's single claim wins over sub (providers_openid.go:55-59)", async () => {
    const idp = stubIdp();
    const claims = { ...baseClaims(), oid: "tenant-oid-7" };
    const signed = await signIdToken({ alg: "RS256", claims, kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    const result = await runExchange({ idp, token: signed.token, cfg: oidcCfg({ externalIdClaim: "oid" }) });
    expect(result.identity.externalId).toBe("tenant-oid-7");
  });

  it("externalIdClaim configured but absent from the token falls back to sub", async () => {
    const idp = stubIdp();
    const signed = await signIdToken({ alg: "RS256", claims: baseClaims(), kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    const result = await runExchange({ idp, token: signed.token, cfg: oidcCfg({ externalIdClaim: "oid" }) });
    expect(result.identity.externalId).toBe("sub-123");
  });

  it("issuer-mismatch between the token and a REFETCHED document re-fetches (the §5.3.1 re-fetch arm is the route's freshness hint)", async () => {
    // The memo returns the SAME document for the same rowKey; the route's
    // rowKey changes with the row edit. Here: a new rowKey + a changed
    // discovery issuer must be visible to the verify gate.
    const idp = stubIdp();
    const signed = await signIdToken({ alg: "RS256", claims: baseClaims(), kid: "k1" });
    idp.jwks = { keys: [{ ...signed.publicJwk!, kid: "k1" }] };
    idp.tokenResponse = { access_token: "at", token_type: "Bearer", id_token: signed.token };
    await fetchOidcDiscovery(idp.fetchImpl, "row:1", "https://idp.example.com");
    const discovery = await fetchOidcDiscovery(idp.fetchImpl, "row:1-edited", "https://idp.example.com");
    await expect(
      exchangeOidcCode({
        fetchImpl: idp.fetchImpl,
        document: { ...discovery.document, issuer: "https://rotated.example.com" },
        entry: discovery.entry,
        cfg: parseOAuth2SourceConfig(oidcCfg()),
        redirectUri: "https://cb",
        code: "c",
        expectedNonce: undefined,
        nowSec: T0,
      }),
    ).rejects.toMatchObject({ code: "issuer-mismatch" });
  });
});

describe("resolveOAuth2Client (the §5.1 seam's W2 slice)", () => {
  it("openidConnect resolves the oidc arm; github/gplus answer not-implemented in W2", () => {
    expect(resolveOAuth2Client(oidcCfg())).toMatchObject({ kind: "oidc" });
    const github = serializeOAuth2SourceConfig({ v: 1, provider: "github", clientId: "g", clientSecret: "s" });
    expect(resolveOAuth2Client(github)).toMatchObject({ kind: "not-implemented", provider: "github" });
    const gplus = serializeOAuth2SourceConfig({ v: 1, provider: "gplus", clientId: "g", clientSecret: "s" });
    expect(resolveOAuth2Client(gplus)).toMatchObject({ kind: "not-implemented", provider: "gplus" });
  });

  it("an unparsable cfg is a dead source (the codec's contract)", () => {
    expect(() => resolveOAuth2Client("{not json")).toThrow();
  });
});

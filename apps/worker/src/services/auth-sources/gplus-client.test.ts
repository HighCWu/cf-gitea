/**
 * The gplus (Google) client suite (specs/external-auth-sources.md §8 — the
 * provider-client arms of the fetch-stub plan): the authorize-URL parameter
 * set (x/oauth2 AuthCodeURL + goth's fixed `access_type=offline` option,
 * NO nonce, the `["email"]` default CONCATENATED ahead of the source's
 * scopes — providers_simple.go:32-37), the token-exchange wire shape at
 * x/oauth2 v0.27.0 google.Endpoint's TokenURL, the userinfo fetch with the
 * access token as the QUERY parameter (goth v1.82.0 google.go:103 — the
 * pinned wire shape), the googleUser identity mapping (NickName = Name,
 * :127), and the error arms.
 *
 * The provider is a URL-keyed fetch stub (SPEC §8); every request recorded.
 */

import { describe, expect, it } from "vitest";

import { parseOAuth2SourceConfig, serializeOAuth2SourceConfig, type OAuth2SourceConfig } from "./cfg";
import { buildGplusAuthorizeUrl, exchangeGplusCode } from "./gplus-client";

interface RecordedRequest {
  url: string;
  method: string;
  body: string | null;
  authHeader: string | null;
}

interface StubGoogle {
  tokenStatus: number;
  tokenPayload: Record<string, unknown>;
  profileStatus: number;
  profilePayload: Record<string, unknown> | string;
  calls: RecordedRequest[];
  fetchImpl: typeof fetch;
}

function stubGoogle(overrides: Partial<StubGoogle> = {}): StubGoogle {
  const stub: StubGoogle = {
    tokenStatus: 200,
    tokenPayload: { access_token: "ya29.token", token_type: "Bearer", refresh_token: "1//refresh", expires_in: 3599 },
    profileStatus: 200,
    profilePayload: {
      id: "1174856918291",
      email: "person@gmail.com",
      name: "A Person",
      given_name: "A",
      family_name: "Person",
      picture: "https://lh3.googleusercontent.com/a/photo",
      hd: "dropped — no slot in the bounded slice",
    },
    calls: [],
    fetchImpl: (): Promise<Response> => Promise.reject(new Error("unreached")),
    ...overrides,
  };
  stub.fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = init?.headers ?? {};
    stub.calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      authHeader: (headers as Record<string, string>).authorization ?? null,
    });
    const respond = (payload: unknown, status: number): Promise<Response> =>
      Promise.resolve(new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }));
    if (url === "https://oauth2.googleapis.com/token") {
      return respond(stub.tokenPayload, stub.tokenStatus);
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) {
      return respond(stub.profilePayload, stub.profileStatus);
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return stub;
}

/** A cfg record through the codec's serialize→parse round trip — the wire
 *  shape the admin CRUD writes is what the client consumes. */
function gplusCfg(overrides: Partial<OAuth2SourceConfig> = {}): OAuth2SourceConfig {
  return parseOAuth2SourceConfig(
    serializeOAuth2SourceConfig({
      v: 1,
      provider: "gplus",
      clientId: "cid",
      clientSecret: "secret",
      ...overrides,
    }),
  );
}

const REDIRECT = "https://gitea.example.com/user/oauth2/google/callback";

describe("buildGplusAuthorizeUrl (x/oauth2 AuthCodeURL + goth's access_type=offline option)", () => {
  it("carries response_type/client_id/redirect_uri/scope/state/access_type on the pinned auth URL, and NO nonce", () => {
    const url = new URL(buildGplusAuthorizeUrl(gplusCfg(), REDIRECT, "st-1"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("access_type")).toBe("offline"); // goth google.go:29-34
    expect(url.searchParams.has("nonce")).toBe(false);
  });

  it("the constructor's ['email'] default rides AHEAD of the source's scopes (providers_simple.go:32-37 appends, never replaces)", () => {
    expect(new URL(buildGplusAuthorizeUrl(gplusCfg(), REDIRECT, "s")).searchParams.get("scope")).toBe("email");
    const withExtra = new URL(buildGplusAuthorizeUrl(gplusCfg({ scopes: ["profile"] }), REDIRECT, "s"));
    expect(withExtra.searchParams.get("scope")).toBe("email profile");
  });
});

describe("exchangeGplusCode — the wire shape", () => {
  it("POSTs the form-encoded exchange to the v0.27.0 Endpoint TokenURL (Google's pinned AuthStyleInParams == the §5.3.3 body), then fetches userinfo with the token as the QUERY param", async () => {
    const stub = stubGoogle();
    await exchangeGplusCode({ fetchImpl: stub.fetchImpl, cfg: gplusCfg(), redirectUri: REDIRECT, code: "abc" });
    expect(stub.calls).toHaveLength(2);

    const tokenCall = stub.calls[0]!;
    expect(tokenCall.url).toBe("https://oauth2.googleapis.com/token"); // NOT the dead !go1.9 legacy host
    expect(tokenCall.method).toBe("POST");
    const body = new URLSearchParams(tokenCall.body ?? "");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("abc");
    expect(body.get("redirect_uri")).toBe(REDIRECT);
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("secret");

    const profileCall = stub.calls[1]!;
    expect(profileCall.url).toBe("https://www.googleapis.com/oauth2/v2/userinfo?access_token=ya29.token"); // google.go:103's query-param shape
    expect(profileCall.method).toBe("GET");
    expect(profileCall.authHeader).toBeNull(); // the pinned wire carries the token in the URL, not a Bearer header
  });

  it("maps googleUser (google.go:118-134): id STRING external id, NickName = Name, given/family/picture/email carried", async () => {
    const stub = stubGoogle();
    const { identity } = await exchangeGplusCode({ fetchImpl: stub.fetchImpl, cfg: gplusCfg(), redirectUri: REDIRECT, code: "c" });
    expect(identity).toEqual({
      externalId: "1174856918291",
      email: "person@gmail.com",
      name: "A Person",
      nickName: "A Person",
      avatarUrl: "https://lh3.googleusercontent.com/a/photo",
      firstName: "A",
      lastName: "Person",
    });
  });

  it("absent profile fields normalize to null — including the NickName=N arm (no name ⇒ no nickname)", async () => {
    const stub = stubGoogle({ profilePayload: { id: "77" } });
    const { identity } = await exchangeGplusCode({ fetchImpl: stub.fetchImpl, cfg: gplusCfg(), redirectUri: REDIRECT, code: "c" });
    expect(identity).toEqual({
      externalId: "77",
      email: null,
      name: null,
      nickName: null,
      avatarUrl: null,
      firstName: null,
      lastName: null,
    });
  });
});

describe("error arms (every failure a GplusClientError code — the route's default failure arm)", () => {
  it("token endpoint non-2xx ⇒ token-fetch", async () => {
    const stub = stubGoogle({ tokenStatus: 400 });
    await expect(exchangeGplusCode({ fetchImpl: stub.fetchImpl, cfg: gplusCfg(), redirectUri: REDIRECT, code: "c" })).rejects.toMatchObject({ code: "token-fetch" });
  });

  it("token 200 without access_token ⇒ token-shape", async () => {
    const stub = stubGoogle({ tokenPayload: { error: "invalid_grant" } });
    await expect(exchangeGplusCode({ fetchImpl: stub.fetchImpl, cfg: gplusCfg(), redirectUri: REDIRECT, code: "c" })).rejects.toMatchObject({ code: "token-shape" });
  });

  it("profile non-2xx ⇒ profile-fetch (google.go:109-111's non-200 arm)", async () => {
    const stub = stubGoogle({ profileStatus: 401 });
    await expect(exchangeGplusCode({ fetchImpl: stub.fetchImpl, cfg: gplusCfg(), redirectUri: REDIRECT, code: "c" })).rejects.toMatchObject({ code: "profile-fetch" });
  });

  it("profile non-JSON ⇒ profile-shape", async () => {
    const stub = stubGoogle({ profilePayload: "<html>" });
    await expect(exchangeGplusCode({ fetchImpl: stub.fetchImpl, cfg: gplusCfg(), redirectUri: REDIRECT, code: "c" })).rejects.toMatchObject({ code: "profile-shape" });
  });

  it("userinfo without an id ⇒ external-id-missing (upstream's UserID==\"\" missing-field arm, oauth.go:147 — an identity with no external id cannot link)", async () => {
    const stub = stubGoogle({ profilePayload: { email: "ghost@gmail.com" } });
    await expect(exchangeGplusCode({ fetchImpl: stub.fetchImpl, cfg: gplusCfg(), redirectUri: REDIRECT, code: "c" })).rejects.toMatchObject({
      code: "external-id-missing",
    });
  });
});

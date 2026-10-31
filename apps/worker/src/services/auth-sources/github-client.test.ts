/**
 * The GitHub client suite (specs/external-auth-sources.md §8 — the
 * provider-client arms of the fetch-stub plan): the authorize-URL
 * parameter set (x/oauth2 AuthCodeURL shape, NO nonce, scope omitted when
 * empty), the CustomURLMapping override resolution (OverrideWith's
 * non-empty-wins, urlmapping.go:60-74), the token-exchange wire shape, the
 * userFromReader identity mapping (external id = the NUMERIC id string,
 * login → NickName — goth v1.82.0 github.go:157-182), and the scope-gated
 * primary/verified email arm (github.go:143-153, :184-215) with its error
 * arms.
 *
 * The provider is a URL-keyed fetch stub (SPEC §8): token, profile, and
 * email endpoints served from in-test fixtures; every request recorded
 * (method, URL, headers, body).
 */

import { describe, expect, it } from "vitest";

import { parseOAuth2SourceConfig, serializeOAuth2SourceConfig, type OAuth2SourceConfig } from "./cfg";
import { buildGithubAuthorizeUrl, exchangeGithubCode } from "./github-client";

interface RecordedRequest {
  url: string;
  method: string;
  body: string | null;
  authHeader: string | null;
}

interface StubGithub {
  tokenStatus: number;
  tokenPayload: Record<string, unknown>;
  profileStatus: number;
  profilePayload: Record<string, unknown> | string;
  emailStatus: number;
  emailPayload: unknown;
  calls: RecordedRequest[];
  fetchImpl: typeof fetch;
}

function stubGithub(overrides: Partial<StubGithub> = {}): StubGithub {
  const stub: StubGithub = {
    tokenStatus: 200,
    tokenPayload: { access_token: "gho_token123", token_type: "bearer", scope: "" },
    profileStatus: 200,
    profilePayload: {
      id: 9001,
      login: "octocat",
      name: "The Octocat",
      email: null,
      avatar_url: "https://avatars.githubusercontent.com/u/9001",
      bio: "dropped — no slot in the bounded slice",
      location: "dropped — no slot in the bounded slice",
    },
    emailStatus: 200,
    emailPayload: [],
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
    if (url === "https://github.com/login/oauth/access_token" || url === "https://ghe.example.com/api/v3/access_token") {
      return respond(stub.tokenPayload, stub.tokenStatus);
    }
    if (url === "https://api.github.com/user" || url === "https://ghe.example.com/api/v3/user") {
      return respond(stub.profilePayload, stub.profileStatus);
    }
    if (url === "https://api.github.com/user/emails" || url === "https://ghe.example.com/api/v3/user/emails") {
      return respond(stub.emailPayload, stub.emailStatus);
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return stub;
}

/** A cfg record exactly as the store would persist it: through the codec's
 *  serialize→parse round trip, so the suites prove the client consumes the
 *  wire shape the admin CRUD writes. */
function githubCfg(overrides: Partial<OAuth2SourceConfig> = {}): OAuth2SourceConfig {
  return parseOAuth2SourceConfig(
    serializeOAuth2SourceConfig({
      v: 1,
      provider: "github",
      clientId: "cid",
      clientSecret: "secret",
      ...overrides,
    }),
  );
}

const REDIRECT = "https://gitea.example.com/user/oauth2/gh/callback";

describe("buildGithubAuthorizeUrl (x/oauth2 AuthCodeURL's parameter set)", () => {
  it("carries response_type/client_id/redirect_uri/state on the goth default auth URL, and NO nonce", () => {
    const url = new URL(buildGithubAuthorizeUrl(githubCfg(), REDIRECT, "st-1"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.has("nonce")).toBe(false);
  });

  it("joins the source's scopes space-separated; EMPTY scopes omit the scope param entirely (x/oauth2 sets the key only when non-empty)", () => {
    const withScopes = new URL(buildGithubAuthorizeUrl(githubCfg({ scopes: ["repo", "user:email"] }), REDIRECT, "s"));
    expect(withScopes.searchParams.get("scope")).toBe("repo user:email");
    const withoutScopes = new URL(buildGithubAuthorizeUrl(githubCfg(), REDIRECT, "s"));
    expect(withoutScopes.searchParams.has("scope")).toBe(false);
  });

  it("a customUrlMapping.authUrl override rides (OverrideWith's non-empty-wins, urlmapping.go:60-74)", () => {
    const url = new URL(
      buildGithubAuthorizeUrl(githubCfg({ customUrlMapping: { authUrl: "https://ghe.example.com/login/oauth/authorize" } }), REDIRECT, "s"),
    );
    expect(url.origin + url.pathname).toBe("https://ghe.example.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
  });
});

describe("exchangeGithubCode — the wire shape", () => {
  it("POSTs the form-encoded exchange to the goth default token URL, then Bearer-fetches the goth default profile URL", async () => {
    const stub = stubGithub();
    const { identity } = await exchangeGithubCode({ fetchImpl: stub.fetchImpl, cfg: githubCfg(), redirectUri: REDIRECT, code: "abc" });
    expect(stub.calls).toHaveLength(2);

    const tokenCall = stub.calls[0]!;
    expect(tokenCall.url).toBe("https://github.com/login/oauth/access_token");
    expect(tokenCall.method).toBe("POST");
    const body = new URLSearchParams(tokenCall.body ?? "");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("abc");
    expect(body.get("redirect_uri")).toBe(REDIRECT);
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("secret");

    const profileCall = stub.calls[1]!;
    expect(profileCall.url).toBe("https://api.github.com/user");
    expect(profileCall.method).toBe("GET");
    expect(profileCall.authHeader).toBe("Bearer gho_token123");

    expect(identity.email).toBeNull(); // public profile email null, no email scope ⇒ no email fetch (call count asserts it)
  });

  it("maps userFromReader (github.go:157-182): external id = NUMERIC id string, login → NickName, names/emails/avatar carried, no firstName/lastName", async () => {
    const stub = stubGithub({ profilePayload: { id: 42, login: "torvalds", name: null, email: "pub@example.com", avatar_url: null } });
    const { identity } = await exchangeGithubCode({ fetchImpl: stub.fetchImpl, cfg: githubCfg(), redirectUri: REDIRECT, code: "c" });
    expect(identity).toEqual({
      externalId: "42",
      email: "pub@example.com",
      name: null,
      nickName: "torvalds",
      avatarUrl: null,
      firstName: null,
      lastName: null,
    });
  });

  it("honors ALL FOUR custom URL overrides (the GHE shape, providers_custom.go:66's NewCustomisedURL arms)", async () => {
    const stub = stubGithub({
      profilePayload: { id: 7, login: "ghe-user", email: null },
      emailPayload: [{ email: "priv@ghe.example.com", primary: true, verified: true }],
    });
    const cfg = githubCfg({
      scopes: ["user:email"],
      customUrlMapping: {
        authUrl: "https://ghe.example.com/login/oauth/authorize",
        tokenUrl: "https://ghe.example.com/api/v3/access_token",
        profileUrl: "https://ghe.example.com/api/v3/user",
        emailUrl: "https://ghe.example.com/api/v3/user/emails",
      },
    });
    const { identity } = await exchangeGithubCode({ fetchImpl: stub.fetchImpl, cfg, redirectUri: REDIRECT, code: "c" });
    expect(stub.calls.map((c) => c.url)).toEqual([
      "https://ghe.example.com/api/v3/access_token",
      "https://ghe.example.com/api/v3/user",
      "https://ghe.example.com/api/v3/user/emails",
    ]);
    expect(identity.externalId).toBe("7");
    expect(identity.email).toBe("priv@ghe.example.com");
  });
});

describe("the email arm (github.go:143-153 — scope-gated, primary AND verified)", () => {
  it("a present public profile email short-circuits: the email endpoint is NEVER fetched", async () => {
    const stub = stubGithub({ profilePayload: { id: 1, login: "a", email: "public@example.com" }, emailPayload: [{ email: "x@example.com", primary: true, verified: true }] });
    const { identity } = await exchangeGithubCode({ fetchImpl: stub.fetchImpl, cfg: githubCfg({ scopes: ["user:email"] }), redirectUri: REDIRECT, code: "c" });
    expect(identity.email).toBe("public@example.com");
    expect(stub.calls).toHaveLength(2);
  });

  it("an empty profile email WITHOUT the user/user:email scope leaves email null and fetches nothing more (v1 default scopes = none; the auto-reg add is deferred)", async () => {
    const stub = stubGithub({ profilePayload: { id: 1, login: "a", email: null } });
    const { identity } = await exchangeGithubCode({ fetchImpl: stub.fetchImpl, cfg: githubCfg(), redirectUri: REDIRECT, code: "c" });
    expect(identity.email).toBeNull();
    expect(stub.calls).toHaveLength(2);
  });

  it("scope user:email (and user) gates the arm: picks the FIRST primary+verified entry in list order", async () => {
    const decoys = [
      { email: "secondary@example.com", primary: false, verified: true },
      { email: "unverified-primary@example.com", primary: true, verified: false },
      { email: "the-one@example.com", primary: true, verified: true },
      { email: "never-reached@example.com", primary: true, verified: true },
    ];
    for (const scopes of [["user:email"], ["user"], [" user "], ["repo", "user:email"]]) {
      const stub = stubGithub({ profilePayload: { id: 1, login: "a", email: null }, emailPayload: decoys });
      const { identity } = await exchangeGithubCode({ fetchImpl: stub.fetchImpl, cfg: githubCfg({ scopes }), redirectUri: REDIRECT, code: "c" });
      expect(identity.email).toBe("the-one@example.com");
      expect(stub.calls[2]!.url).toBe("https://api.github.com/user/emails");
      expect(stub.calls[2]!.authHeader).toBe("Bearer gho_token123");
    }
  });

  it("no primary+verified entry ⇒ ErrNoVerifiedGitHubPrimaryEmail (:214) — the FetchUser FAILS upstream, so the exchange fails here", async () => {
    const stub = stubGithub({ profilePayload: { id: 1, login: "a", email: null }, emailPayload: [{ email: "nope@example.com", primary: true, verified: false }] });
    await expect(exchangeGithubCode({ fetchImpl: stub.fetchImpl, cfg: githubCfg({ scopes: ["user:email"] }), redirectUri: REDIRECT, code: "c" })).rejects.toMatchObject({
      code: "no-verified-email",
    });
  });
});

describe("error arms (every failure a GithubClientError code — the route's default failure arm)", () => {
  it("token endpoint non-2xx ⇒ token-fetch", async () => {
    const stub = stubGithub({ tokenStatus: 500 });
    await expect(exchangeGithubCode({ fetchImpl: stub.fetchImpl, cfg: githubCfg(), redirectUri: REDIRECT, code: "c" })).rejects.toMatchObject({ code: "token-fetch" });
  });

  it("token 200 without access_token ⇒ token-shape", async () => {
    const stub = stubGithub({ tokenPayload: { error: "bad_verification_code" } });
    await expect(exchangeGithubCode({ fetchImpl: stub.fetchImpl, cfg: githubCfg(), redirectUri: REDIRECT, code: "c" })).rejects.toMatchObject({ code: "token-shape" });
  });

  it("profile non-2xx ⇒ profile-fetch (github.go:124-126's non-200 arm)", async () => {
    const stub = stubGithub({ profileStatus: 401 });
    await expect(exchangeGithubCode({ fetchImpl: stub.fetchImpl, cfg: githubCfg(), redirectUri: REDIRECT, code: "c" })).rejects.toMatchObject({ code: "profile-fetch" });
  });

  it("profile non-JSON ⇒ profile-shape", async () => {
    const stub = stubGithub({ profilePayload: "<html>" });
    await expect(exchangeGithubCode({ fetchImpl: stub.fetchImpl, cfg: githubCfg(), redirectUri: REDIRECT, code: "c" })).rejects.toMatchObject({ code: "profile-shape" });
  });

  it("profile without a numeric id ⇒ external-id-missing (goth would coerce Go's zero value to \"0\"; the honest failure is the recorded adaptation)", async () => {
    const stub = stubGithub({ profilePayload: { login: "ghost" } });
    await expect(exchangeGithubCode({ fetchImpl: stub.fetchImpl, cfg: githubCfg(), redirectUri: REDIRECT, code: "c" })).rejects.toMatchObject({
      code: "external-id-missing",
    });
  });

  it("email endpoint non-2xx ⇒ email-fetch (github.go:196-198)", async () => {
    const stub = stubGithub({ profilePayload: { id: 1, login: "a", email: null }, emailStatus: 403 });
    await expect(exchangeGithubCode({ fetchImpl: stub.fetchImpl, cfg: githubCfg({ scopes: ["user:email"] }), redirectUri: REDIRECT, code: "c" })).rejects.toMatchObject({
      code: "email-fetch",
    });
  });
});

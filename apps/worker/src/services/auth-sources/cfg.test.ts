/**
 * The cfg codec suite (specs/external-auth-sources.md §8 "Store/codec"):
 * per-provider round-trips whose field sets mirror the pin
 * (services/auth/source/oauth2/source.go:15-35 + the three constructor
 * files), the version gate, the structural-absence rule (deferred sync
 * fields are REJECTED, never zero-valued), and the per-provider field
 * boundaries (discoveryUrl OIDC-only, customUrlMapping github-only,
 * externalIdClaim OIDC-only).
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  OAUTH2_PROVIDER_KEYS,
  OAUTH2_SOURCE_CONFIG_VERSION,
  OAuth2ConfigError,
  parseOAuth2SourceConfig,
  serializeOAuth2SourceConfig,
  type OAuth2SourceConfig,
} from "./cfg";

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof OAuth2ConfigError) return err.code;
    throw err;
  }
  throw new Error("expected OAuth2ConfigError, none thrown");
};

describe("cfg codec — round-trips per provider type (the pin field sets)", () => {
  it("openidConnect: the full v1 field set (source.go:15-35 minus the deferred sync fields)", () => {
    const config: OAuth2SourceConfig = {
      v: 1,
      provider: "openidConnect",
      clientId: "oidc-client",
      clientSecret: "oidc-secret",
      discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
      externalIdClaim: "oid",
      iconUrl: "https://idp.example.com/icon.png",
      scopes: ["openid", "profile", "email"],
    };
    const wire = serializeOAuth2SourceConfig(config);
    expect(parseOAuth2SourceConfig(wire)).toEqual(config);
  });

  it("github: the four custom-URL overrides (providers_custom.go:55-64 / urlmapping.go:7-13)", () => {
    const config: OAuth2SourceConfig = {
      v: 1,
      provider: "github",
      clientId: "gh-client",
      clientSecret: "gh-secret",
      customUrlMapping: {
        authUrl: "https://gh.example.com/login/oauth/authorize",
        tokenUrl: "https://gh.example.com/login/oauth/access_token",
        profileUrl: "https://api.gh.example.com/user",
        emailUrl: "https://api.gh.example.com/user/emails",
      },
      scopes: ["read:user"],
    };
    expect(parseOAuth2SourceConfig(serializeOAuth2SourceConfig(config))).toEqual(config);
  });

  it("gplus: the minimal record — clientId/secret only (the scopes stay the provider default)", () => {
    const config: OAuth2SourceConfig = {
      v: 1,
      provider: "gplus",
      clientId: "gp-client",
      clientSecret: "gp-secret",
    };
    expect(parseOAuth2SourceConfig(serializeOAuth2SourceConfig(config))).toEqual(config);
    expect(JSON.parse(serializeOAuth2SourceConfig(config))).toEqual(config);
  });

  it("wire key order is fixed (deterministic bytes for diffs and tests)", () => {
    const wire = serializeOAuth2SourceConfig({
      v: 1,
      provider: "openidConnect",
      clientId: "c",
      clientSecret: "s",
      discoveryUrl: "https://d",
      scopes: ["openid"],
      iconUrl: "https://i",
    });
    expect(Object.keys(JSON.parse(wire) as Record<string, unknown>)).toEqual([
      "v",
      "provider",
      "clientId",
      "clientSecret",
      "discoveryUrl",
      "iconUrl",
      "scopes",
    ]);
  });

  it("the provider key union is exactly the ratified v1 set (SPEC §2.3)", () => {
    expect([...OAUTH2_PROVIDER_KEYS]).toEqual(["openidConnect", "github", "gplus"]);
    expect(OAUTH2_SOURCE_CONFIG_VERSION).toBe(1);
    expectTypeOf<OAuth2SourceConfig["provider"]>().toEqualTypeOf<"openidConnect" | "github" | "gplus">();
  });
});

describe("cfg codec — the version gate and structural absence (SPEC §1/§4.2)", () => {
  it("rejects a foreign/missing version before any field read", () => {
    expect(codeOf(() => parseOAuth2SourceConfig(JSON.stringify({ v: 2, provider: "gplus", clientId: "c", clientSecret: "s" })))).toBe(
      "version",
    );
    expect(codeOf(() => parseOAuth2SourceConfig(JSON.stringify({ provider: "gplus", clientId: "c", clientSecret: "s" })))).toBe("version");
  });

  it("rejects the DEFERRED sync fields — structurally absent, not zero-valued (source.go:26-34)", () => {
    for (const field of ["groupTeamMap", "requiredClaimName", "adminGroup", "restrictedGroup", "sshPublicKeyClaimName"]) {
      const blob = JSON.stringify({ v: 1, provider: "openidConnect", clientId: "c", clientSecret: "s", discoveryUrl: "https://d", [field]: "x" });
      expect(codeOf(() => parseOAuth2SourceConfig(blob))).toBe("unknown-field");
    }
  });

  it("rejects a DEFERRED provider key (the lattice is recorded; gitlab has no client module)", () => {
    const blob = JSON.stringify({ v: 1, provider: "gitlab", clientId: "c", clientSecret: "s" });
    expect(codeOf(() => parseOAuth2SourceConfig(blob))).toBe("provider-invalid");
  });

  it("rejects non-object and unparsable JSON", () => {
    for (const blob of ["[]", '"x"', "null", "3", "{", ""]) {
      expect(() => parseOAuth2SourceConfig(blob)).toThrow(OAuth2ConfigError);
    }
    expect(codeOf(() => parseOAuth2SourceConfig("["))).toBe("json");
    expect(codeOf(() => parseOAuth2SourceConfig("[]"))).toBe("shape");
  });

  it("rejects empty credentials and an unknown provider", () => {
    expect(codeOf(() => serializeOAuth2SourceConfig({ v: 1, provider: "gplus", clientId: "", clientSecret: "s" }))).toBe("clientId-required");
    expect(codeOf(() => serializeOAuth2SourceConfig({ v: 1, provider: "gplus", clientId: "c", clientSecret: "" }))).toBe("clientSecret-required");
    expect(codeOf(() => serializeOAuth2SourceConfig({ v: 1, provider: "bogus" as never, clientId: "c", clientSecret: "s" }))).toBe(
      "provider-invalid",
    );
  });
});

describe("cfg codec — per-provider field boundaries", () => {
  const base = { v: 1 as const, clientId: "c", clientSecret: "s" };

  it("discoveryUrl: REQUIRED for openidConnect (providers_openid.go:53-58), forbidden elsewhere", () => {
    expect(
      codeOf(() => serializeOAuth2SourceConfig({ ...base, provider: "openidConnect" as const })),
    ).toBe("discovery-required");
    expect(
      codeOf(() => serializeOAuth2SourceConfig({ ...base, provider: "github" as const, discoveryUrl: "https://d" })),
    ).toBe("discovery-forbidden");
    expect(
      codeOf(() => serializeOAuth2SourceConfig({ ...base, provider: "gplus" as const, discoveryUrl: "https://d" })),
    ).toBe("discovery-forbidden");
  });

  it("externalIdClaim: OIDC-only (providers_openid.go:55-59)", () => {
    expect(
      codeOf(() => serializeOAuth2SourceConfig({ ...base, provider: "github" as const, externalIdClaim: "oid" })),
    ).toBe("claim-forbidden");
    // Present-and-empty is invalid on OIDC too.
    expect(
      codeOf(() => serializeOAuth2SourceConfig({ ...base, provider: "openidConnect" as const, discoveryUrl: "https://d", externalIdClaim: "" })),
    ).toBe("claim-invalid");
    const wire = serializeOAuth2SourceConfig({ ...base, provider: "openidConnect" as const, discoveryUrl: "https://d", externalIdClaim: "oid" });
    expect(parseOAuth2SourceConfig(wire).externalIdClaim).toBe("oid");
  });

  it("customUrlMapping: github-only; unknown sub-fields rejected (Tenant is azureadv2, deferred)", () => {
    expect(
      codeOf(() => serializeOAuth2SourceConfig({ ...base, provider: "gplus" as const, customUrlMapping: { authUrl: "https://a" } })),
    ).toBe("urls-forbidden");
    expect(
      codeOf(() =>
        serializeOAuth2SourceConfig({
          ...base,
          provider: "github" as const,
          customUrlMapping: { tenant: "x" } as never,
        }),
      ),
    ).toBe("unknown-field");
    expect(
      codeOf(() =>
        serializeOAuth2SourceConfig({ ...base, provider: "github" as const, customUrlMapping: { authUrl: 3 } as never }),
      ),
    ).toBe("urls-invalid");
  });

  it("customUrlMapping: empty-string entries drop (OverrideWith's len>0 rule, urlmapping.go:60-74)", () => {
    const wire = serializeOAuth2SourceConfig({
      ...base,
      provider: "github",
      customUrlMapping: { authUrl: "https://a", tokenUrl: "", profileUrl: undefined, emailUrl: "" },
    });
    expect(parseOAuth2SourceConfig(wire).customUrlMapping).toEqual({ authUrl: "https://a" });
    // A mapping that normalizes to nothing is absent, not {}.
    const empty = serializeOAuth2SourceConfig({ ...base, provider: "github", customUrlMapping: { authUrl: "" } });
    expect("customUrlMapping" in parseOAuth2SourceConfig(empty)).toBe(false);
  });

  it("iconUrl: empty drops (providers.go:53-55's `!= \"\"` check)", () => {
    const wire = serializeOAuth2SourceConfig({ ...base, provider: "gplus", iconUrl: "" });
    expect("iconUrl" in parseOAuth2SourceConfig(wire)).toBe(false);
    expect(codeOf(() => serializeOAuth2SourceConfig({ ...base, provider: "gplus", iconUrl: 5 as never }))).toBe("icon-invalid");
  });

  it("scopes: array of non-empty strings; empty array normalizes to absent (the provider default)", () => {
    const wire = serializeOAuth2SourceConfig({ ...base, provider: "gplus", scopes: [] });
    expect("scopes" in parseOAuth2SourceConfig(wire)).toBe(false);
    expect(
      codeOf(() => serializeOAuth2SourceConfig({ ...base, provider: "gplus", scopes: ["email", ""] })),
    ).toBe("scopes-invalid");
    expect(codeOf(() => serializeOAuth2SourceConfig({ ...base, provider: "gplus", scopes: "email" as never }))).toBe("scopes-invalid");
    expect(parseOAuth2SourceConfig(serializeOAuth2SourceConfig({ ...base, provider: "gplus", scopes: ["email"] })).scopes).toEqual(["email"]);
  });
});

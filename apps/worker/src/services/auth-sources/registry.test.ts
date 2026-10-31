/**
 * The provider-registry skeleton suite (specs/external-auth-sources.md §2.3):
 * the lattice keys are the pin's goth set, exactly three providers are
 * executable in v1 (the ratified set), and the executable entries carry the
 * pin's constructor field sets (scopes / custom URLs / the OIDC-only flags).
 */

import { describe, expect, it } from "vitest";

import { getProviderDescriptor, listExecutableProviders, PROVIDER_LATTICE } from "./registry";

describe("provider registry skeleton (SPEC §2.3's recorded lattice)", () => {
  it("keys are unique and the lattice carries the full recorded set", () => {
    const keys = PROVIDER_LATTICE.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    // The 17-entry lattice of SPEC §2.3 — the recorded answer to "which
    // providers exist at the pin", so it is never re-derived.
    expect(keys).toEqual([
      "openidConnect",
      "github",
      "gplus",
      "gitlab",
      "gitea",
      "nextcloud",
      "mastodon",
      "azureadv2",
      "aws-cognito",
      "bitbucket",
      "dropbox",
      "facebook",
      "twitter",
      "discord",
      "yandex",
      "azuread",
      "microsoftonline",
    ]);
  });

  it("exactly the ratified v1 set is executable, sorted by key (providers.go:148-150)", () => {
    expect(listExecutableProviders().map((p) => p.key)).toEqual(["github", "gplus", "openidConnect"]);
  });

  it("openidConnect: discovery arm, no custom URLs, SSH-key + ExternalIDClaim support, no default scopes", () => {
    const oidc = getProviderDescriptor("openidConnect")!;
    expect(oidc.kind).toBe("oidc");
    expect(oidc.customUrlSettings).toBeNull();
    expect(oidc.supportsSshPublicKey).toBe(true);
    expect(oidc.externalIdClaim).toBe(true);
    // The OPENID_CONNECT_SCOPES setting default is EMPTY
    // (modules/setting/oauth2.go:66); source.Scopes is the fallback
    // (providers_openid.go:45-50).
    expect(oidc.defaultScopes).toEqual([]);
  });

  it("github: the four AVAILABLE custom URLs with the goth v1.82.0 defaults (providers_custom.go:55-70)", () => {
    const gh = getProviderDescriptor("github")!;
    expect(gh.kind).toBe("custom-url");
    expect(gh.customUrlSettings).toEqual({
      authUrl: { value: "https://github.com/login/oauth/authorize", available: true, required: false },
      tokenUrl: { value: "https://github.com/login/oauth/access_token", available: true, required: false },
      profileUrl: { value: "https://api.github.com/user", available: true, required: false },
      emailUrl: { value: "https://api.github.com/user/emails", available: true, required: false },
    });
    // No default scopes; the auto-reg `user:email` add is deferred.
    expect(gh.defaultScopes).toEqual([]);
    expect(gh.supportsSshPublicKey).toBe(false);
    expect(gh.externalIdClaim).toBe(false);
  });

  it("gplus: the simple arm with scopes ['email'] (providers_simple.go:72-79; the profile add is deferred)", () => {
    const gp = getProviderDescriptor("gplus")!;
    expect(gp.kind).toBe("simple");
    expect(gp.customUrlSettings).toBeNull();
    expect(gp.defaultScopes).toEqual(["email"]);
    expect(gp.displayName).toBe("Google");
  });

  it("deferred entries never render executable and carry no custom URLs", () => {
    const deferred = PROVIDER_LATTICE.filter((p) => !p.executable);
    expect(deferred.length).toBe(14);
    for (const entry of deferred) {
      expect(entry.customUrlSettings).toBeNull();
      expect(entry.externalIdClaim).toBe(false);
    }
  });
});

/**
 * The LOGIN PAGE's external-auth buttons (specs/external-auth-sources.md
 * §5.6, W4): the `oauth2Sources` option's render arms over the pin's
 * markup — signin_inner.tmpl:50-56's divider+navigator on the login page,
 * signup_inner.tmpl:50-56's inside-the-form block on the signup page,
 * external_auth_methods.tmpl's anchor shape (icon-or-fallback glyph +
 * "Sign in with {name}", the href `/user/oauth2/{Source.Name}`).
 *
 * Covered here:
 *   - the mapper (oauth2LoginSourceButtons): the cfg projection (provider +
 *     iconUrl), the name-order passthrough, the DEAD-cfg skip;
 *   - the login render: no option / empty list = byte-stable vs the
 *     option-less render (the §5 golden posture), the block's exact
 *     position after the form, the divider, the hrefs;
 *   - the signup render: the block INSIDE the form, gated the same way;
 *   - the icon arms: the img override (cfg IconURL, providers.go:63-70's
 *     markup), the three brand glyphs, the globe fallback;
 *   - the §8 a11y smoke on the with-sources render.
 */

import { describe, expect, it } from "vitest";

import { serializeOAuth2SourceConfig } from "../../services/auth-sources/cfg";
import { runA11y } from "../__tests__/a11y";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  oauth2LoginSourceButtons,
  renderLoginPage,
} from "./login";
import { renderSignUpPage } from "./first-run";

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "root", isAdmin: true };
const ctx: UiContext = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };

const ANON_CTX: UiContext = {
  viewer: { kind: "anonymous" },
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

function sourceCfg(provider: "openidConnect" | "github" | "gplus", iconUrl?: string): string {
  return serializeOAuth2SourceConfig({
    v: 1,
    provider,
    clientId: "client",
    clientSecret: "secret",
    ...(provider === "openidConnect" ? { discoveryUrl: "https://idp/.well-known/openid-configuration" } : {}),
    ...(iconUrl !== undefined ? { iconUrl } : {}),
  });
}

describe("oauth2LoginSourceButtons (the ACTIVE rows' projection)", () => {
  it("projects provider + iconUrl, keeps the read's name order", () => {
    const buttons = oauth2LoginSourceButtons([
      { name: "alpha-oidc", cfg: sourceCfg("openidConnect") },
      { name: "beta-github", cfg: sourceCfg("github", "https://icons/icon.png") },
      { name: "gamma-gplus", cfg: sourceCfg("gplus") },
    ]);
    expect(buttons.map((b) => b.name)).toEqual(["alpha-oidc", "beta-github", "gamma-gplus"]);
    expect(buttons[0]!.provider).toBe("openidConnect");
    expect(buttons[0]!.iconUrl).toBeNull();
    expect(buttons[1]!.iconUrl).toBe("https://icons/icon.png");
    expect(buttons[2]!.provider).toBe("gplus");
  });

  it("a dead cfg renders NO button (the dead-source rule)", () => {
    const buttons = oauth2LoginSourceButtons([
      { name: "live", cfg: sourceCfg("github") },
      { name: "dead", cfg: "not-json" },
    ]);
    expect(buttons.map((b) => b.name)).toEqual(["live"]);
  });
});

describe("the login page's social block (signin_inner.tmpl:50-56)", () => {
  const sources = [
    { name: "corp-oidc", provider: "openidConnect", iconUrl: null },
    { name: "hub", provider: "github", iconUrl: null },
  ] as const;

  it("no option / an empty list renders byte-stable vs the option-less render", () => {
    const base = renderLoginPage({ ctx: ANON_CTX, redirectTo: null, error: null });
    const withEmpty = renderLoginPage({ ctx: ANON_CTX, redirectTo: null, error: null, oauth2Sources: [] });
    expect(withEmpty).toBe(base);
    expect(base).not.toContain("external-login-navigator");
    expect(base).not.toContain("divider divider-text");
  });

  it("the non-empty list renders the divider + the navigator AFTER the form, inside the segment", () => {
    const html = renderLoginPage({ ctx: ANON_CTX, redirectTo: null, error: null, oauth2Sources: [...sources] });
    expect(html).toContain('<div class="divider divider-text">or</div>');
    expect(html).toContain('<div id="external-login-navigator" class="tw-py-1 tw-flex tw-flex-col tw-gap-3">');
    // The anchor shape: upstream's classes + attributes, the source NAME as
    // the URL token.
    expect(html).toContain('class="ui button external-login-link tw-gap-3" data-require-appurl-check="true" rel="nofollow" href="/user/oauth2/corp-oidc"');
    expect(html).toContain('href="/user/oauth2/hub"');
    expect(html).toContain("Sign in with corp-oidc");
    expect(html).toContain("Sign in with hub");
    // The block sits after the sign-in form's close (signin_inner's shape):
    // the form's submit button precedes the divider.
    expect(html.indexOf('name="remember"')).toBeLessThan(html.indexOf("divider divider-text"));
    expect(html.indexOf("divider divider-text")).toBeLessThan(html.indexOf("external-login-navigator"));
  });

  it("the icon arms: the img override, the three brand glyphs, the globe fallback", () => {
    const html = renderLoginPage({
      ctx: ANON_CTX,
      redirectTo: null,
      error: null,
      oauth2Sources: [
        { name: "ico", provider: "github", iconUrl: "https://icons/icon.png" },
        { name: "gh", provider: "github", iconUrl: null },
        { name: "gg", provider: "gplus", iconUrl: null },
        { name: "oidc", provider: "openidConnect", iconUrl: null },
        { name: "foreign", provider: "azureadv2", iconUrl: null },
      ],
    });
    // providers.go:63-70's img arm verbatim (alt = DisplayName).
    expect(html).toContain('<img class="tw-object-contain" width="24" height="24" src="https://icons/icon.png" alt="ico"');
    // The brand glyph classes/paths (the embedded submodule bytes).
    expect(html).toContain('d="M6.766 11.328'); // octicon-mark-github
    expect(html).toContain("#4285f4"); // gitea-google
    expect(html).toContain('viewBox="0 0 2400 2400"'); // gitea-openid
    expect(html).toContain('class="svg octicon-globe"'); // the fallback
  });

  it("the with-sources render passes the a11y smoke (SPEC §8)", () => {
    const html = renderLoginPage({ ctx: ANON_CTX, redirectTo: null, error: null, oauth2Sources: [...sources] });
    expect(runA11y(html)).toEqual([]);
  });
});

describe("the signup page's social block (signup_inner.tmpl:50-56)", () => {
  it("the block renders INSIDE the form; absent renders nothing", () => {
    const withSources = renderSignUpPage({
      ctx,
      error: null,
      oauth2Sources: [{ name: "corp-oidc", provider: "openidConnect", iconUrl: null }],
    });
    expect(withSources).toContain('action="/user/sign_up" method="post"');
    expect(withSources).toContain('<div class="divider divider-text">or</div>');
    expect(withSources).toContain('href="/user/oauth2/corp-oidc"');
    // INSIDE the form: the divider precedes the form's close (lastIndexOf —
    // the navbar's logout form closes earlier in the document).
    expect(withSources.indexOf("divider divider-text")).toBeLessThan(withSources.lastIndexOf("</form>"));
    const noSources = renderSignUpPage({ ctx, error: null });
    expect(noSources).not.toContain("external-login-navigator");
    expect(noSources).not.toContain("divider divider-text");
  });
});

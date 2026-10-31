/**
 * The user settings SECURITY tab's tests (the bench-row module, MOUNTED at
 * 0c2b151 — the repo-settings-wiki.test.tsx harness): the derived-posture
 * loader over real D1 (generated migrations in beforeAll) and the DOM
 * contract of the page render — hono/jsx renderToString, the module driven
 * directly (the GET arm's route is the module header's mount record; the
 * write arms stay unmounted except the W5 unlink, whose seams run here and
 * whose route hunks are the module header's HANDOFF).
 *
 * The EXTERNAL AUTH W5 arms (specs/external-auth-sources.md §2.5/§5.5): the
 * account-links section's guard (absent at zero links AND zero active
 * sources — the wave-56 bytes stay), the linked render (accountlinks.tmpl's
 * rows: icon, source name, the Active badge, the Remove form), the
 * Link-Account buttons (the OrderedOAuth2Names arm), the missing-source
 * skip arm (security.go's `err == nil`), the dead-cfg degrade, and the
 * unlink seams (parse + apply — removed / not-exist).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { runA11y } from "../__tests__/a11y";
import { serializeOAuth2SourceConfig } from "../../services/auth-sources/cfg";
import {
  createLoginSource,
  ensureExternalLogin,
  getLoginSource,
  LoginSourceType,
} from "../../services/auth-sources/store";
import { UserSettingsNavbar } from "../components/settings-nav";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  applyAccountLinkUnlink,
  loadUserSettingsSecurityPageData,
  parseAccountLinkUnlinkForm,
  renderUserSettingsSecurityPage,
  UserSettingsSecurityPage,
  userSettingsSecurityLocale,
} from "./user-settings-security";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };

const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM external_login_user").run();
  await env.DB.prepare("DELETE FROM login_source").run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
});

async function pageHtml(): Promise<string> {
  const data = await loadUserSettingsSecurityPageData(env.DB, 1);
  return renderToString(<UserSettingsSecurityPage ctx={ctx} data={data} />);
}

async function seedSource(name: string, options: { isActive?: boolean; provider?: "openidConnect" | "github"; iconUrl?: string } = {}) {
  const provider = options.provider ?? "openidConnect";
  const cfg = serializeOAuth2SourceConfig({
    v: 1,
    provider,
    clientId: "client-id",
    clientSecret: "client-secret",
    // The codec rejects a discoveryUrl for a non-OIDC provider (the W4
    // discovery-forbidden rule) — the field is the OIDC arm's alone.
    ...(provider === "openidConnect" ? { discoveryUrl: "https://idp.example.com" } : {}),
    ...(options.iconUrl !== undefined ? { iconUrl: options.iconUrl } : {}),
  });
  const row = await createLoginSource(env.DB, {
    type: LoginSourceType.OAuth2,
    name,
    isActive: options.isActive ?? true,
    cfg,
  });
  return row;
}

// --- the loader (the derived posture) -----------------------------------------

describe("loadUserSettingsSecurityPageData (the derived TOTP posture)", () => {
  it("answers not-enrolled with EMPTY link projections for every doer — no two_factor store exists (SPEC-0002 §1); a clean instance renders no section", async () => {
    const clean = await loadUserSettingsSecurityPageData(env.DB, 1);
    expect(clean).toEqual({ totpEnrolled: false, accountLinks: [], linkButtons: [] });
    expect(await loadUserSettingsSecurityPageData(env.DB, 999)).toEqual({ totpEnrolled: false, accountLinks: [], linkButtons: [] });
  });

  it("projects the doer's links joined to their sources, login_source_id DESC (security.go's OrderBy)", async () => {
    const first = await seedSource("oidc-corp");
    const second = await seedSource("gh-hub", { provider: "github", isActive: false });
    await ensureExternalLogin(env.DB, { externalId: "sub-1", loginSourceId: first.id, userId: 1, provider: "openidConnect" });
    await ensureExternalLogin(env.DB, { externalId: "12345", loginSourceId: second.id, userId: 1, provider: "github" });

    const data = await loadUserSettingsSecurityPageData(env.DB, 1);
    expect(data.accountLinks.map((link) => [link.loginSourceId, link.sourceName, link.isActive])).toEqual([
      [second.id, "gh-hub", false], // login_source_id DESC — upstream's settings-list order
      [first.id, "oidc-corp", true],
    ]);
    expect(data.accountLinks[0]).toMatchObject({ provider: "github", displayName: "GitHub", iconUrl: null });
    // The ACTIVE sources' buttons ride the same load (name order, the dead
    // cfg dropped): only oidc-corp is active.
    expect(data.linkButtons.map((button) => [button.name, button.displayName])).toEqual([["oidc-corp", "OpenID Connect"]]);
    // Another doer's rows stay out.
    const other = await loadUserSettingsSecurityPageData(env.DB, 999);
    expect(other.accountLinks).toEqual([]);
    expect(other.linkButtons.map((button) => button.name)).toEqual(["oidc-corp"]);
  });

  it("a link whose source row is GONE drops from the list (security.go's skip arm)", async () => {
    const source = await seedSource("oidc-corp");
    await ensureExternalLogin(env.DB, { externalId: "sub-1", loginSourceId: source.id, userId: 1, provider: "openidConnect" });
    await env.DB.prepare("DELETE FROM login_source WHERE id = ?").bind(String(source.id)).run();
    const data = await loadUserSettingsSecurityPageData(env.DB, 1);
    expect(data.accountLinks).toEqual([]);
  });

  it("a dead stored cfg degrades the row (globe fallback, source-name label) and renders NO button", async () => {
    const dead = await createLoginSource(env.DB, { type: LoginSourceType.OAuth2, name: "dead-src", isActive: true, cfg: "not-json" });
    await ensureExternalLogin(env.DB, { externalId: "sub-9", loginSourceId: dead.id, userId: 1, provider: "" });
    const data = await loadUserSettingsSecurityPageData(env.DB, 1);
    expect(data.accountLinks[0]).toMatchObject({ sourceName: "dead-src", provider: "", displayName: "dead-src", iconUrl: null });
    expect(data.linkButtons).toEqual([]);
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the security page DOM (security.tmpl + twofa.tmpl at the pin)", () => {
  it("renders the page discriminator, the navbar with Security active, and the Actions disclosure", async () => {
    const html = await pageHtml();
    expect(html).toContain("user settings security"); // layout_head's pageClass
    expect(html).toContain('class="active item" href="/user/settings/security"');
    expect(html).toContain('href="/user/settings"'); // the live Profile item
    expect(html).toContain("<details"); // navbar.tmpl:40's Actions disclosure
    expect(html).toContain('href="/user/settings/actions/secrets"'); // the live Secrets sub-item
    expect(html).toContain("user-setting-content"); // security.tmpl:3's wrapper
  });

  it("renders the not-enrolled posture arm's three paragraphs (twofa.tmpl:16-22)", async () => {
    const html = await pageHtml();
    expect(html).toContain("ui top attached header"); // twofa.tmpl:1
    expect(html).toContain(userSettingsSecurityLocale.twofa);
    expect(html).toContain(userSettingsSecurityLocale.twofa_desc.replaceAll('"', "&quot;")); // the escaped render
    expect(html).toContain(userSettingsSecurityLocale.twofa_recovery_tip);
    expect(html).toContain(userSettingsSecurityLocale.twofa_not_enrolled);
  });

  it("renders no dead controls — no enroll link, no settings forms, no modals", async () => {
    const html = await pageHtml();
    expect(html).not.toContain("two_factor"); // the enroll/regenerate/disable arms
    expect(html).not.toContain('action="/user/settings/security'); // no upstream form arm targets the group
    expect(html).not.toContain("show-modal"); // the #disable-twofa dialog pair
    expect(html).not.toContain("<dialog");
  });

  it("renders none of the store-less sections (webauthn/accountlinks/openid) — the W5 guard's EMPTY arm", async () => {
    const html = await pageHtml();
    expect(html).not.toContain("webauthn");
    expect(html).not.toContain("WebAuthn");
    expect(html).not.toContain("Linked Accounts"); // accountlinks.tmpl's header — the guard's both-operands-empty arm
    expect(html).not.toContain("OpenID");
  });

  it("the full-document render path matches the component path", async () => {
    const data = await loadUserSettingsSecurityPageData(env.DB, 1);
    const html = renderUserSettingsSecurityPage(ctx, data);
    expect(html).toContain("user settings security");
    expect(html).toContain(userSettingsSecurityLocale.twofa_not_enrolled);
  });

  // STALE-PIN UPDATE (wave-114 nav swap): the page's local three-item
  // UserSettingsSecurityNav was deleted for the shared
  // components/settings-nav UserSettingsNavbar — the active-discrimination
  // pins re-aim at the shared component (its full matrix lives in
  // components/settings-nav.test.tsx).
  it("the shared navbar renders the active discrimination for all three items (the mount scaffolding)", () => {
    expect(renderToString(<UserSettingsNavbar active="profile" />)).toContain(
      'class="active item" href="/user/settings"',
    );
    expect(renderToString(<UserSettingsNavbar active="security" />)).toContain(
      'class="active item" href="/user/settings/security"',
    );
    const secretsActive = renderToString(<UserSettingsNavbar active="secrets" />);
    expect(secretsActive).toContain('class="active item" href="/user/settings/actions/secrets"');
    expect(secretsActive).toContain("open"); // navbar.tmpl:40's open arm
  });
});

// --- the W5 account-links section (accountlinks.tmpl at the pin) --------------

describe("the W5 account-links section (accountlinks.tmpl)", () => {
  it("the LINKED render: the header, the desc, the row (icon arm, name, the Active badge), the Remove form, and the confirm dialog", async () => {
    const source = await seedSource("oidc-corp");
    await ensureExternalLogin(env.DB, { externalId: "sub-1", loginSourceId: source.id, userId: 1, provider: "openidConnect" });
    const html = await pageHtml();

    expect(html).toContain(userSettingsSecurityLocale.manage_account_links); // the section header
    expect(html).toContain(userSettingsSecurityLocale.manage_account_links_desc);
    // The row: the source name (upstream's item-title) + the Active badge.
    expect(html).toContain('data-tooltip-content="OpenID Connect"');
    expect(html).toContain("oidc-corp");
    expect(html).toContain(userSettingsSecurityLocale.active);
    // The Remove control: the plain-form POST (the no-JS unlink), the id
    // wire field, upstream's data-modal-confirm hook.
    expect(html).toContain('action="/user/settings/security/account_link" method="post"');
    expect(html).toContain(`name="id" value="${String(source.id)}"`);
    expect(html).toContain('data-modal-confirm="#delete-account-link"');
    expect(html).toContain(userSettingsSecurityLocale.remove);
    // The dialog bytes (upstream's shape).
    expect(html).toContain('<dialog class="modal-dialog" id="delete-account-link">');
    expect(html).toContain(userSettingsSecurityLocale.remove_account_link_desc);
    // The Link-Account button (the ACTIVE source rides the same render).
    expect(html).toContain('href="/user/oauth2/oidc-corp"');
    expect(html).toContain("OpenID Connect"); // the Link-Account button text (the provider display name)
  });

  it("the buttons-only render: an ACTIVE source with zero links shows the section + the Link-Account anchor, no rows", async () => {
    await seedSource("gh-hub", { provider: "github" });
    const html = await pageHtml();
    expect(html).toContain(userSettingsSecurityLocale.manage_account_links);
    expect(html).toContain('href="/user/oauth2/gh-hub"');
    expect(html).toContain("GitHub");
    expect(html).not.toContain('name="id"'); // no rows — no Remove forms
    expect(html).toContain(userSettingsSecurityLocale.manage_account_links_desc); // the desc item renders
  });

  it("the icon arms: the cfg iconUrl renders the img override (providers.go:63-70)", async () => {
    await seedSource("ico-src", { iconUrl: "https://icons/icon.png" });
    const html = await pageHtml();
    expect(html).toContain('<img class="tw-object-contain" width="20" height="20" src="https://icons/icon.png"');
  });

  it("an INACTIVE linked source renders no Active badge and no Link-Account anchor", async () => {
    const source = await seedSource("sleepy-src", { isActive: false });
    await ensureExternalLogin(env.DB, { externalId: "sub-2", loginSourceId: source.id, userId: 1, provider: "openidConnect" });
    const html = await pageHtml();
    expect(html).toContain("sleepy-src");
    expect(html).not.toContain('class="flex-text-body tw-text-primary"'); // the badge arm's exact class
    expect(html).not.toContain('href="/user/oauth2/'); // the button block's guard
    expect(html).toContain('action="/user/settings/security/account_link"'); // the row is still removable
  });

  it("the notice option renders the unlink POST's re-render slot (the negative kind)", () => {
    const html = renderUserSettingsSecurityPage(ctx, { totpEnrolled: false, accountLinks: [], linkButtons: [] }, {
      notice: { kind: "negative", message: userSettingsSecurityLocale.unlink_missing },
    });
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain(userSettingsSecurityLocale.unlink_missing);
  });

  it("the linked render passes the a11y smoke (SPEC §8)", async () => {
    const source = await seedSource("oidc-corp");
    await ensureExternalLogin(env.DB, { externalId: "sub-1", loginSourceId: source.id, userId: 1, provider: "openidConnect" });
    const data = await loadUserSettingsSecurityPageData(env.DB, 1);
    const html = renderUserSettingsSecurityPage(ctx, data);
    expect(html).toContain("Manage Linked Accounts");
    expect(html).not.toContain("<table"); // the section is a divided list, no R6 surface
    expect(runA11y(html)).toEqual([]);
  });
});

// --- the W5 unlink seams (security.go:50-70's DeleteAccountLink) ---------------

describe("the unlink seams (parse + apply)", () => {
  it("parseAccountLinkUnlinkForm: digits pass, 0/junk/absent are the not-given arm (security.go:52-55)", () => {
    expect(parseAccountLinkUnlinkForm(new URLSearchParams("id=7"))).toEqual({ id: 7 });
    expect(parseAccountLinkUnlinkForm(new URLSearchParams("id=0"))).toEqual({ id: null });
    expect(parseAccountLinkUnlinkForm(new URLSearchParams("id=abc"))).toEqual({ id: null });
    expect(parseAccountLinkUnlinkForm(new URLSearchParams(""))).toEqual({ id: null });
    expect(parseAccountLinkUnlinkForm(new URLSearchParams("id=-3"))).toEqual({ id: null });
  });

  it("applyAccountLinkUnlink: the owned pair removes (removed); a foreign pair is not-exist (the ErrExternalLoginUserNotExist arm)", async () => {
    const source = await seedSource("oidc-corp");
    await ensureExternalLogin(env.DB, { externalId: "sub-1", loginSourceId: source.id, userId: 1, provider: "openidConnect" });

    // Not the doer's link: not-exist, and the row SURVIVES.
    expect(await applyAccountLinkUnlink(env.DB, 999, source.id)).toEqual({ outcome: "not-exist" });
    expect(await getLoginSource(env.DB, source.id)).not.toBeNull();

    // The doer's link: removed — the row is gone.
    expect(await applyAccountLinkUnlink(env.DB, 1, source.id)).toEqual({ outcome: "removed" });
    const data = await loadUserSettingsSecurityPageData(env.DB, 1);
    expect(data.accountLinks).toEqual([]);
  });

  it("the pin carries NO last-link guard: the only link unlinks too (the recorded posture)", async () => {
    const source = await seedSource("only-link");
    await ensureExternalLogin(env.DB, { externalId: "sub-1", loginSourceId: source.id, userId: 1, provider: "openidConnect" });
    expect(await applyAccountLinkUnlink(env.DB, 1, source.id)).toEqual({ outcome: "removed" });
  });
});


// --- the DOM --------------------------------------------------------------------

describe("the security page DOM (security.tmpl + twofa.tmpl at the pin)", () => {
  it("renders the page discriminator, the navbar with Security active, and the Actions disclosure", async () => {
    const html = await pageHtml();
    expect(html).toContain("user settings security"); // layout_head's pageClass
    expect(html).toContain('class="active item" href="/user/settings/security"');
    expect(html).toContain('href="/user/settings"'); // the live Profile item
    expect(html).toContain("<details"); // navbar.tmpl:40's Actions disclosure
    expect(html).toContain('href="/user/settings/actions/secrets"'); // the live Secrets sub-item
    expect(html).toContain("user-setting-content"); // security.tmpl:3's wrapper
  });

  it("renders the not-enrolled posture arm's three paragraphs (twofa.tmpl:16-22)", async () => {
    const html = await pageHtml();
    expect(html).toContain("ui top attached header"); // twofa.tmpl:1
    expect(html).toContain(userSettingsSecurityLocale.twofa);
    expect(html).toContain(userSettingsSecurityLocale.twofa_desc.replaceAll('"', "&quot;")); // the escaped render
    expect(html).toContain(userSettingsSecurityLocale.twofa_recovery_tip);
    expect(html).toContain(userSettingsSecurityLocale.twofa_not_enrolled);
  });

  it("renders no dead controls — no enroll link, no settings forms, no modals", async () => {
    const html = await pageHtml();
    expect(html).not.toContain("two_factor"); // the enroll/regenerate/disable arms
    expect(html).not.toContain('action="/user/settings/security'); // no upstream form arm targets the group
    expect(html).not.toContain("show-modal"); // the #disable-twofa dialog pair
    expect(html).not.toContain("<dialog");
  });

  it("renders none of the store-less sections (webauthn/accountlinks/openid)", async () => {
    const html = await pageHtml();
    expect(html).not.toContain("webauthn");
    expect(html).not.toContain("WebAuthn");
    expect(html).not.toContain("Linked Accounts"); // accountlinks.tmpl's header — its guard renders nothing
    expect(html).not.toContain("OpenID");
  });

  it("the full-document render path matches the component path", async () => {
    const data = await loadUserSettingsSecurityPageData(env.DB, 1);
    const html = renderUserSettingsSecurityPage(ctx, data);
    expect(html).toContain("user settings security");
    expect(html).toContain(userSettingsSecurityLocale.twofa_not_enrolled);
  });

  // STALE-PIN UPDATE (wave-114 nav swap): the page's local three-item
  // UserSettingsSecurityNav was deleted for the shared
  // components/settings-nav UserSettingsNavbar — the active-discrimination
  // pins re-aim at the shared component (its full matrix lives in
  // components/settings-nav.test.tsx).
  it("the shared navbar renders the active discrimination for all three items (the mount scaffolding)", () => {
    expect(renderToString(<UserSettingsNavbar active="profile" />)).toContain(
      'class="active item" href="/user/settings"',
    );
    expect(renderToString(<UserSettingsNavbar active="security" />)).toContain(
      'class="active item" href="/user/settings/security"',
    );
    const secretsActive = renderToString(<UserSettingsNavbar active="secrets" />);
    expect(secretsActive).toContain('class="active item" href="/user/settings/actions/secrets"');
    expect(secretsActive).toContain("open"); // navbar.tmpl:40's open arm
  });
});

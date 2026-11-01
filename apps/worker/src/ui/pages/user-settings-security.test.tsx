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
import { cborEncode } from "../../web/webauthn-fixtures";
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
  await env.DB.prepare("DELETE FROM two_factor").run(); // the 2FA arms' clean slate (the enrolled describes re-seed)
  await env.DB.prepare("DELETE FROM webauthn_credentials").run(); // the webauthn arms' clean slate (the enrolled describe re-seeds)
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

// --- the loader (the LIVE TOTP posture) ---------------------------------------

describe("loadUserSettingsSecurityPageData (the live TOTP posture + the W5 projections)", () => {
  it("answers not-enrolled with EMPTY link projections for a clean instance — the real two_factor read (HasTwoFactorByUID)", async () => {
    const clean = await loadUserSettingsSecurityPageData(env.DB, 1);
    expect(clean).toEqual({ totpEnrolled: false, accountLinks: [], linkButtons: [], webauthnCredentials: [] });
    expect(await loadUserSettingsSecurityPageData(env.DB, 999)).toEqual({
      totpEnrolled: false,
      accountLinks: [],
      linkButtons: [],
      webauthnCredentials: [],
    });
  });

  it("answers enrolled when the doer's two_factor row exists (the 2FA unit's flip)", async () => {
    await env.DB.prepare(
      "INSERT INTO two_factor (user_id, secret, scratch_salt, scratch_hash, last_used_passcode_period, created_unix, updated_unix) VALUES (1, 'JBSWY3DPEHPK3PXP', 'salt', 'hash', 0, unixepoch(), unixepoch())",
    ).run();
    const data = await loadUserSettingsSecurityPageData(env.DB, 1);
    expect(data.totpEnrolled).toBe(true);
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

  it("renders the not-enrolled arm's paragraphs plus the LIVE Enroll button (twofa.tmpl:16-22)", async () => {
    const html = await pageHtml();
    expect(html).toContain("ui top attached header"); // twofa.tmpl:1
    expect(html).toContain(userSettingsSecurityLocale.twofa);
    expect(html).toContain(userSettingsSecurityLocale.twofa_desc.replaceAll('"', "&quot;")); // the escaped render
    expect(html).toContain(userSettingsSecurityLocale.twofa_recovery_tip);
    expect(html).toContain(userSettingsSecurityLocale.twofa_not_enrolled);
    // the enroll arm is LIVE now (the dead-link rule retired with the
    // enroll page): the button anchors the enroll route
    expect(html).toContain('href="/user/settings/security/two_factor/enroll"');
    expect(html).toContain(userSettingsSecurityLocale.twofa_enroll_button);
  });

  it("STALE-PIN FLIP (the 2FA unit): the not-enrolled arm carries the enroll link and the inert dialog — the enrolled arm's FORMS stay absent", async () => {
    // The wave-56 pin ("no two_factor anywhere") is retired: the store
    // exists, the enroll page exists, and upstream's #disable-twofa dialog
    // renders UNCONDITIONALLY (twofa.tmpl sits it outside the {{if}}) —
    // inert no-JS exactly like the accountlinks dialog's markup.
    const html = await pageHtml();
    expect(html).toContain('href="/user/settings/security/two_factor/enroll"'); // the LIVE enroll arm
    expect(html).not.toContain('action="/user/settings/security/two_factor/regenerate_scratch"'); // the enrolled arm's forms
    expect(html).not.toContain('action="/user/settings/security/two_factor/disable"');
    expect(html).toContain('id="disable-twofa"'); // upstream's unconditional dialog (inert, no trigger here)
    expect(html).toContain(userSettingsSecurityLocale.twofa_disable_desc);
  });

  it("the not-enrolled render (with the new dialog bytes) passes the a11y smoke", async () => {
    const data = await loadUserSettingsSecurityPageData(env.DB, 1);
    const html = renderUserSettingsSecurityPage(ctx, data);
    expect(runA11y(html)).toEqual([]);
  });

  it("renders the webauthn section LIVE and none of the store-less sections (accountlinks/openid) — the W5 guard's EMPTY arm (the webauthn pin flipped: the WebAuthn unit's section is live)", async () => {
    const html = await pageHtml();
    expect(html).toContain(userSettingsSecurityLocale.webauthn); // webauthn.tmpl's header — LIVE
    expect(html).toContain('id="register-webauthn"'); // the vendored bundle's activation button
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

// --- the ENROLLED arm (twofa.tmpl's {{if .TOTPEnrolled}} — the 2FA unit) -------

describe("the enrolled arm (twofa.tmpl:6-14 + the disable dialog)", () => {
  /** A live enrollment for doer 1 (the row shape is the seam's business —
   *  here only the existence matters). */
  async function seedEnrolled(): Promise<void> {
    await env.DB.prepare("DELETE FROM two_factor").run();
    await env.DB.prepare(
      "INSERT INTO two_factor (user_id, secret, scratch_salt, scratch_hash, last_used_passcode_period, created_unix, updated_unix) VALUES (1, 'JBSWY3DPEHPK3PXP', 'salt', 'hash', 0, unixepoch(), unixepoch())",
    ).run();
  }

  it("renders the enrolled line's <strong> emphasis (twofa.tmpl:6, the no-raw-HTML split)", async () => {
    await seedEnrolled();
    const html = await pageHtml();
    expect(html).toContain(
      `${userSettingsSecurityLocale.twofa_is_enrolled_prefix}<strong>${userSettingsSecurityLocale.twofa_is_enrolled_strong}</strong>${userSettingsSecurityLocale.twofa_is_enrolled_suffix}`,
    );
    expect(html).not.toContain(userSettingsSecurityLocale.twofa_not_enrolled); // the other arm's text
  });

  it("renders the regenerate form (twofa.tmpl:7-10, the multipart enctype dropped) and the disable form with the REQUIRED passcode", async () => {
    await seedEnrolled();
    const html = await pageHtml();
    expect(html).toContain(
      '<form class="ui form" action="/user/settings/security/two_factor/regenerate_scratch" method="post">',
    );
    expect(html).toContain(userSettingsSecurityLocale.regenerate_scratch_token_desc);
    expect(html).toContain(userSettingsSecurityLocale.twofa_scratch_token_regenerate);
    // THE MISSION'S DIVERGENCE: the disable form demands a code (upstream
    // is a bare dialog) — the one-time-code autocomplete, required.
    expect(html).toContain('<form class="ui form form-fetch-action" action="/user/settings/security/two_factor/disable" method="post">');
    expect(html).toContain(userSettingsSecurityLocale.twofa_disable_note);
    expect(html).toContain('id="disable-passcode" name="passcode"');
    expect(html).toContain('autocomplete="one-time-code"');
    expect(html).toContain('data-modal-confirm="#disable-twofa"');
    expect(html).toContain(userSettingsSecurityLocale.twofa_disable);
  });

  it("the disable dialog bytes render (upstream's unconditional markup)", async () => {
    await seedEnrolled();
    const html = await pageHtml();
    expect(html).toContain('<dialog class="modal-dialog" id="disable-twofa">');
    expect(html).toContain(userSettingsSecurityLocale.twofa_disable_desc);
    expect(html).toContain(userSettingsSecurityLocale.modal_no);
    expect(html).toContain(userSettingsSecurityLocale.modal_yes);
  });

  it("the enrolled render passes the a11y smoke", async () => {
    await seedEnrolled();
    const data = await loadUserSettingsSecurityPageData(env.DB, 1);
    const html = renderUserSettingsSecurityPage(ctx, data);
    expect(runA11y(html)).toEqual([]);
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
    expect(html).not.toContain('action="/user/settings/security/account_link"'); // no link rows — no Remove forms
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
    const html = renderUserSettingsSecurityPage(ctx, { totpEnrolled: false, accountLinks: [], linkButtons: [], webauthnCredentials: [] }, {
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

  it("renders the not-enrolled arm's paragraphs plus the LIVE Enroll button (twofa.tmpl:16-22)", async () => {
    const html = await pageHtml();
    expect(html).toContain("ui top attached header"); // twofa.tmpl:1
    expect(html).toContain(userSettingsSecurityLocale.twofa);
    expect(html).toContain(userSettingsSecurityLocale.twofa_desc.replaceAll('"', "&quot;")); // the escaped render
    expect(html).toContain(userSettingsSecurityLocale.twofa_recovery_tip);
    expect(html).toContain(userSettingsSecurityLocale.twofa_not_enrolled);
    // the enroll arm is LIVE now (the dead-link rule retired with the
    // enroll page): the button anchors the enroll route
    expect(html).toContain('href="/user/settings/security/two_factor/enroll"');
    expect(html).toContain(userSettingsSecurityLocale.twofa_enroll_button);
  });

  it("STALE-PIN FLIP (the 2FA unit): the not-enrolled arm carries the enroll link and the inert dialog — the enrolled arm's FORMS stay absent", async () => {
    // The wave-56 pin ("no two_factor anywhere") is retired: the store
    // exists, the enroll page exists, and upstream's #disable-twofa dialog
    // renders UNCONDITIONALLY (twofa.tmpl sits it outside the {{if}}) —
    // inert no-JS exactly like the accountlinks dialog's markup.
    const html = await pageHtml();
    expect(html).toContain('href="/user/settings/security/two_factor/enroll"'); // the LIVE enroll arm
    expect(html).not.toContain('action="/user/settings/security/two_factor/regenerate_scratch"'); // the enrolled arm's forms
    expect(html).not.toContain('action="/user/settings/security/two_factor/disable"');
    expect(html).toContain('id="disable-twofa"'); // upstream's unconditional dialog (inert, no trigger here)
    expect(html).toContain(userSettingsSecurityLocale.twofa_disable_desc);
  });

  it("the not-enrolled render (with the new dialog bytes) passes the a11y smoke", async () => {
    const data = await loadUserSettingsSecurityPageData(env.DB, 1);
    const html = renderUserSettingsSecurityPage(ctx, data);
    expect(runA11y(html)).toEqual([]);
  });

  it("renders the webauthn section LIVE and none of the store-less sections (accountlinks/openid) (the webauthn pin flipped: the WebAuthn unit's section is live)", async () => {
    const html = await pageHtml();
    expect(html).toContain(userSettingsSecurityLocale.webauthn); // webauthn.tmpl's header — LIVE
    expect(html).not.toContain("Linked Accounts"); // accountlinks.tmpl's header — its guard renders nothing
    expect(html).not.toContain("OpenID");
  });

  it("the webauthn section renders the register entry with an EMPTY key list (the enrolled arm stays absent)", async () => {
    const html = await pageHtml();
    expect(html).toContain('id="register-webauthn"'); // the bundle's activation button
    expect(html).toContain('id="nickname"'); // webAuthnRegisterRequest's input
    expect(html).toContain('id="webauthn-error"'); // the error box the bundle fills
    expect(html).toContain('data-webauthn-error-msg="duplicated"'); // the error ladder's typed spans
    expect(html).not.toContain('action="/user/settings/security/webauthn/delete"'); // no keys — no delete forms
  });

  it("the enrolled render lists the keys with the delete forms and the rename dialog (webauthn.tmpl's rows)", async () => {
    // The store parses the COSE key on read — the fixture carries a
    // well-formed EC2 map (parse-only; the coordinates are dummies).
    const coseKey = cborEncode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(32).fill(1)],
        [-3, new Uint8Array(32).fill(2)],
      ]),
    );
    const sec = Math.floor(Date.now() / 1000);
    await env.DB
      .prepare(
        "INSERT INTO webauthn_credentials (user_id, name, lower_name, credential_id, public_key, attestation_type, aaguid, sign_count, clone_warning, created_unix, updated_unix) VALUES (1, 'Work Key', 'work key', x'C0FFEE', ?, 'none', NULL, 4, 0, ?, ?)",
      )
      .bind(coseKey, sec, sec)
      .run();
    const data = await loadUserSettingsSecurityPageData(env.DB, 1);
    expect(data.webauthnCredentials).toHaveLength(1);
    expect(data.webauthnCredentials[0]?.name).toBe("Work Key");
    const html = await pageHtml();
    expect(html).toContain("Work Key"); // the item-title
    expect(html).toContain("Added on"); // settings.added_on
    expect(html).toContain('action="/user/settings/security/webauthn/delete"'); // the plain-form remove
    expect(html).toContain('data-modal="#rename-webauthn-nickname"'); // the show-modal trigger
    expect(html).toContain('id="rename-webauthn-nickname"'); // the dialog
    expect(html).toContain('id="delete-registration"'); // the delete confirm dialog
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

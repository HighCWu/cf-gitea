/**
 * The user settings SECURITY tab's tests (the bench-row UNMOUNTED module —
 * the repo-settings-wiki.test.tsx harness): the derived-posture loader over
 * real D1 (generated migrations in beforeAll) and the DOM contract of the
 * page render — hono/jsx renderToString, the module driven directly (no route
 * yet, the HANDOFF NOTE in the module header).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { UserSettingsNavbar } from "../components/settings-nav";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  loadUserSettingsSecurityPageData,
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
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
});

async function pageHtml(): Promise<string> {
  const data = await loadUserSettingsSecurityPageData(env.DB, 1);
  return renderToString(<UserSettingsSecurityPage ctx={ctx} data={data} />);
}

// --- the loader (the derived posture) -----------------------------------------

describe("loadUserSettingsSecurityPageData (the derived TOTP posture)", () => {
  it("answers not-enrolled for every doer — no two_factor store exists (SPEC-0002 §1)", async () => {
    expect(await loadUserSettingsSecurityPageData(env.DB, 1)).toEqual({ totpEnrolled: false });
    expect(await loadUserSettingsSecurityPageData(env.DB, 999)).toEqual({ totpEnrolled: false });
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

/**
 * The shared settings navbar's tests (the wave-64 consolidation bench row
 * `wave-settings-shared-nav`): the component is a pure function of its
 * props — no D1, no bindings — so this is the shell.test.tsx harness
 * (hono/jsx `renderToString`, no server) rather than the D1 module harness.
 * Asserted: the exact upstream item ORDER (both templates at the pin), the
 * dead-link rule's absences, the active discrimination for every tab of
 * both unions, the Actions <details> open arm, and the viewer-independence
 * contract (the signed-in gate is the route prologue's, never the nav's).
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { OrgSettingsNavbar, UserSettingsNavbar, settingsNavLocale } from "./settings-nav";
import type { UserSettingsNavTab } from "./settings-nav";

// --- fixtures ----------------------------------------------------------------

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const assets = shellAssetsFromManifest(manifest);
const ORIGIN = "https://test.local";

// --- the user settings navbar ---------------------------------------------------

/** The user navbar's landed/committed hrefs in user/settings/navbar.tmpl
 *  order (dead items dropped) — the full quoted attributes so the Profile
 *  needle cannot match a longer sibling href. */
const USER_HREF_ORDER = [
  'href="/user/settings"',
  'href="/user/settings/account"',
  'href="/user/settings/notifications"',
  'href="/user/settings/appearance"',
  'href="/user/settings/security"',
  'href="/user/settings/applications"',
  'href="/user/settings/keys"',
  'href="/user/settings/actions/secrets"',
  'href="/user/settings/actions/variables"',
  'href="/user/settings/hooks"',
  'href="/user/settings/organization"',
];

/** Every href must appear in strictly increasing positions — upstream's
 *  item ORDER, not merely the item SET (the appearance module's open issue:
 *  the local copies disagree on order as well as coverage). */
function assertHrefOrder(html: string, hrefs: string[]): void {
  let cursor = 0;
  for (const href of hrefs) {
    const at = html.indexOf(href, cursor);
    expect(at, `${href} expected after offset ${cursor} (navbar.tmpl order)`).toBeGreaterThanOrEqual(cursor);
    expect(at, `${href} missing from the rendered nav`).toBeGreaterThanOrEqual(0);
    cursor = at + 1;
  }
}

describe("UserSettingsNavbar (user/settings/navbar.tmpl reduced)", () => {
  it("renders the header and every landed item text (the pin's locale strings)", () => {
    const html = renderToString(<UserSettingsNavbar active="profile" />);
    expect(html).toContain('class="flex-container-nav"');
    expect(html).toContain(`<div class="header item">${settingsNavLocale.user_settings}</div>`); // "user.settings"
    for (const text of [
      settingsNavLocale.profile, // "settings.profile"
      settingsNavLocale.account, // "settings.account"
      settingsNavLocale.notifications, // "notifications"
      settingsNavLocale.appearance, // "settings.appearance"
      settingsNavLocale.security, // "settings.security"
      settingsNavLocale.applications, // "settings.applications"
      settingsNavLocale.ssh_gpg_keys, // "settings.ssh_gpg_keys"
      settingsNavLocale.actions, // "actions.actions" (the summary)
      settingsNavLocale.secrets, // "secrets.secrets"
      settingsNavLocale.variables, // "actions.variables"
      settingsNavLocale.hooks, // "repo.settings.hooks"
      settingsNavLocale.organization, // "settings.organization"
    ]) {
      expect(html).toContain(text);
    }
  });

  it("renders the landed items in upstream order (navbar.tmpl:4-73, dead items dropped)", () => {
    assertHrefOrder(renderToString(<UserSettingsNavbar active="profile" />), USER_HREF_ORDER);
  });

  it("renders NO dead items — the unlanded upstream targets are omitted, never dead anchors", () => {
    const html = renderToString(<UserSettingsNavbar active="profile" />);
    // Account (:7-11) and Notifications (:12-16) RENDER (their pages landed);
    // Blocked users (:25-27), Audit (:36-38), Packages (:61-65), Repos
    // (:74-76) stay omitted.
    for (const dead of [
      'href="/user/settings/blocked_users"',
      'href="/user/settings/audit_logs"',
      'href="/user/settings/packages"',
      'href="/user/settings/repos"',
    ]) {
      expect(html).not.toContain(dead);
    }
    // The Actions General/Runners/Scoped-workflows sub-items (:43-48,
    // :55-57) have no landed pages either.
    for (const deadSub of [
      'href="/user/settings/actions/general"',
      'href="/user/settings/actions/runners"',
      'href="/user/settings/actions/scoped-workflows"',
    ]) {
      expect(html).not.toContain(deadSub);
    }
  });

  it("marks exactly the active tab's anchor (every union member)", () => {
    const expectations: Record<UserSettingsNavTab, string> = {
      profile: 'href="/user/settings"',
      account: 'href="/user/settings/account"',
      notifications: 'href="/user/settings/notifications"',
      appearance: 'href="/user/settings/appearance"',
      security: 'href="/user/settings/security"',
      applications: 'href="/user/settings/applications"',
      keys: 'href="/user/settings/keys"',
      secrets: 'href="/user/settings/actions/secrets"',
      variables: 'href="/user/settings/actions/variables"',
      hooks: 'href="/user/settings/hooks"',
      organization: 'href="/user/settings/organization"',
    };
    for (const [tab, href] of Object.entries(expectations)) {
      const html = renderToString(<UserSettingsNavbar active={tab as UserSettingsNavTab} />);
      expect(html, `active=${tab}`).toContain(`class="active item" ${href}`);
      // Exactly ONE active anchor per render:
      expect(html.match(/class="active item" href=/g)?.length, `active=${tab}`).toBe(1);
    }
  });

  it("opens the Actions disclosure while a secrets/variables page renders, closed otherwise (navbar.tmpl:40)", () => {
    expect(renderToString(<UserSettingsNavbar active="secrets" />)).toContain('<details class="item" open');
    expect(renderToString(<UserSettingsNavbar active="variables" />)).toContain('<details class="item" open');
    const closed = renderToString(<UserSettingsNavbar active="profile" />);
    expect(closed).toContain('<details class="item">'); // no open attribute
    expect(closed).not.toContain("open");
  });

  it("is viewer-independent — byte-identical under an anonymous and a signed-in viewer", () => {
    // The signed-in gate is the ROUTE prologue's (resolveUiSession: an
    // anonymous request 303s onto the login round-trip before any settings
    // page renders; a session doer without a D1 row 404-shells) — the nav
    // itself never branches on the viewer. The swap shape a settings page
    // uses: ctx feeds the page shell only, the nav takes just the tab.
    const anonCtx: UiContext = { viewer: { kind: "anonymous" } satisfies Viewer, origin: ORIGIN, assets };
    const signedCtx: UiContext = {
      viewer: { kind: "user", id: 1, username: "alice", isAdmin: false } satisfies Viewer,
      origin: ORIGIN,
      assets,
    };
    const navHtml = renderToString(<UserSettingsNavbar active="profile" />);
    const stub = (ctx: UiContext): string =>
      renderToString(
        <div data-page-viewer={ctx.viewer.kind}>
          <UserSettingsNavbar active="profile" />
        </div>,
      );
    expect(stub(anonCtx)).toContain(navHtml);
    expect(stub(signedCtx)).toContain(navHtml);
    expect(navHtml).not.toContain("alice"); // no viewer-derived chrome
    expect(navHtml).not.toContain("avatar");
  });
});

// --- the org settings navbar ------------------------------------------------------

describe("OrgSettingsNavbar (org/settings/navbar.tmpl reduced)", () => {
  it("renders the header and every landed item text (the pin's locale strings)", () => {
    const html = renderToString(<OrgSettingsNavbar orgLink="/acme" active="options" />);
    expect(html).toContain('class="flex-container-nav"');
    expect(html).toContain(`<div class="header item">${settingsNavLocale.org_settings}</div>`); // "org.settings"
    for (const text of [
      settingsNavLocale.org_options, // "org.settings.options"
      settingsNavLocale.hooks, // "repo.settings.hooks"
      settingsNavLocale.labels, // "repo.labels"
      settingsNavLocale.blocked_users, // "user.block.list"
      settingsNavLocale.actions, // "actions.actions"
      settingsNavLocale.secrets, // "secrets.secrets"
      settingsNavLocale.variables, // "actions.variables"
    ]) {
      expect(html).toContain(text);
    }
  });

  it("renders the landed items in upstream order (navbar.tmpl:4-48, dead items dropped)", () => {
    assertHrefOrder(renderToString(<OrgSettingsNavbar orgLink="/acme" active="options" />), [
      'href="/acme/settings"',
      'href="/acme/settings/hooks"',
      'href="/acme/labels"', // the wave-14 divergence — upstream: /settings/labels
      'href="/acme/settings/blocked_users"',
      'href="/acme/settings/actions/secrets"',
      'href="/acme/settings/actions/variables"',
    ]);
  });

  it("keeps the documented Labels href divergence (the landed /{org}/labels target, org-settings.tsx's header)", () => {
    const html = renderToString(<OrgSettingsNavbar orgLink="/acme" active="options" />);
    expect(html).toContain('href="/acme/labels"');
    expect(html).not.toContain('href="/acme/settings/labels"');
  });

  it("renders NO dead items — Applications/Packages/Audit and the General/Runners/Scoped-workflows sub-items are omitted", () => {
    const html = renderToString(<OrgSettingsNavbar orgLink="/acme" active="options" />);
    for (const dead of [
      'href="/acme/settings/applications"', // navbar.tmpl:15-19
      'href="/acme/settings/packages"', // :23-27
      'href="/acme/settings/audit_logs"', // :50-52
      'href="/acme/settings/actions"', // the General sub-item, :32-34
      'href="/acme/settings/actions/runners"', // :35-37
      'href="/acme/settings/actions/scoped-workflows"', // :44-46
    ]) {
      expect(html).not.toContain(dead);
    }
  });

  it("marks exactly the active tab's anchor (every union member)", () => {
    const expectations: Record<string, string> = {
      options: 'href="/acme/settings"',
      hooks: 'href="/acme/settings/hooks"',
      labels: 'href="/acme/labels"',
      blocked: 'href="/acme/settings/blocked_users"',
      secrets: 'href="/acme/settings/actions/secrets"',
      variables: 'href="/acme/settings/actions/variables"',
    };
    for (const [tab, href] of Object.entries(expectations)) {
      const html = renderToString(
        <OrgSettingsNavbar orgLink="/acme" active={tab as "options" | "hooks" | "labels" | "blocked" | "secrets" | "variables"} />,
      );
      expect(html, `active=${tab}`).toContain(`class="active item" ${href}`);
      expect(html.match(/class="active item" href=/g)?.length, `active=${tab}`).toBe(1);
    }
  });

  it("opens the Actions disclosure while a secrets/variables page renders, closed otherwise (navbar.tmpl:29)", () => {
    expect(renderToString(<OrgSettingsNavbar orgLink="/acme" active="secrets" />)).toContain('<details class="item" open');
    expect(renderToString(<OrgSettingsNavbar orgLink="/acme" active="variables" />)).toContain('<details class="item" open');
    const closed = renderToString(<OrgSettingsNavbar orgLink="/acme" active="blocked" />);
    expect(closed).toContain('<details class="item">');
    expect(closed).not.toContain("open");
  });

  it("carries the orgLink verbatim into every href (the family's OrgLink = /{org})", () => {
    const html = renderToString(<OrgSettingsNavbar orgLink="/Org-With-Caps" active="options" />);
    expect(html).toContain('href="/Org-With-Caps/settings"');
    expect(html).toContain('href="/Org-With-Caps/settings/hooks"');
    expect(html).toContain('href="/Org-With-Caps/labels"');
    expect(html).toContain('href="/Org-With-Caps/settings/blocked_users"');
  });
});

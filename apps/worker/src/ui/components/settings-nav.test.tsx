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
  'href="/user/settings/blocked_users"', // lit by the user blocked-users tab's module (pages/user-settings-blocked.tsx)
  'href="/user/settings/applications"',
  'href="/user/settings/keys"',
  'href="/user/settings/actions/general"', // lit by the user general page's module (P2-1)
  'href="/user/settings/actions/secrets"',
  'href="/user/settings/actions/variables"',
  'href="/user/settings/actions/scoped-workflows"', // lit by the store wave's mount (pages/user-settings-actions-scoped-workflows.tsx)
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
      settingsNavLocale.blocked_users, // "user.block.list" (lit by the user blocked-users tab's module)
      settingsNavLocale.applications, // "settings.applications"
      settingsNavLocale.ssh_gpg_keys, // "settings.ssh_gpg_keys"
      settingsNavLocale.actions, // "actions.actions" (the summary)
      settingsNavLocale.actions_general, // "actions.general" (lit by the user general page's module)
      settingsNavLocale.secrets, // "secrets.secrets"
      settingsNavLocale.variables, // "actions.variables"
      settingsNavLocale.scoped_workflows, // "actions.scoped_workflows" (lit by the store wave's mount)
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
    // Account (:7-11), Notifications (:12-16), Blocked users (:25-27) and
    // Repos (:74-76) RENDER (their pages landed — blocked-users with
    // pages/user-settings-blocked.tsx); Audit (:36-38) stays omitted;
    // Packages (:61-65) landed with the user packages tab's mount.
    for (const dead of ['href="/user/settings/audit_logs"']) {
      expect(html).not.toContain(dead);
    }
    // The Actions Scoped-workflows sub-item (:55-56) RENDERED with the
    // store wave's mount (pages/user-settings-actions-scoped-workflows.tsx
    // — the href-order pin above carries it).
  });

  it("marks exactly the active tab's anchor (every union member)", () => {
    const expectations: Record<UserSettingsNavTab, string> = {
      profile: 'href="/user/settings"',
      account: 'href="/user/settings/account"',
      notifications: 'href="/user/settings/notifications"',
      appearance: 'href="/user/settings/appearance"',
      "actions-general": 'href="/user/settings/actions/general"', // the user general page (P2-1)
      runners: 'href="/user/settings/actions/runners"',
      packages: 'href="/user/settings/packages"',
      security: 'href="/user/settings/security"',
      "blocked-users": 'href="/user/settings/blocked_users"', // the user blocked-users tab's module (committed-unmounted at its writing)
      applications: 'href="/user/settings/applications"',
      keys: 'href="/user/settings/keys"',
      secrets: 'href="/user/settings/actions/secrets"',
      variables: 'href="/user/settings/actions/variables"',
      "actions-scoped-workflows": 'href="/user/settings/actions/scoped-workflows"', // the store wave's page
      hooks: 'href="/user/settings/hooks"',
      organization: 'href="/user/settings/organization"',
      repos: 'href="/user/settings/repos"',
    };
    for (const [tab, href] of Object.entries(expectations)) {
      const html = renderToString(<UserSettingsNavbar active={tab as UserSettingsNavTab} />);
      expect(html, `active=${tab}`).toContain(`class="active item" ${href}`);
      // Exactly ONE active anchor per render:
      expect(html.match(/class="active item" href=/g)?.length, `active=${tab}`).toBe(1);
    }
  });

  it("opens the Actions disclosure while an actions-group page renders, closed otherwise (navbar.tmpl:40)", () => {
    expect(renderToString(<UserSettingsNavbar active="actions-general" />)).toContain('<details class="item" open');
    expect(renderToString(<UserSettingsNavbar active="secrets" />)).toContain('<details class="item" open');
    expect(renderToString(<UserSettingsNavbar active="variables" />)).toContain('<details class="item" open');
    expect(renderToString(<UserSettingsNavbar active="actions-scoped-workflows" />)).toContain('<details class="item" open');
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
    const html = renderToString(<OrgSettingsNavbar orgLink="/org/acme" active="options" />);
    expect(html).toContain('class="flex-container-nav"');
    expect(html).toContain(`<div class="header item">${settingsNavLocale.org_settings}</div>`); // "org.settings"
    for (const text of [
      settingsNavLocale.org_options, // "org.settings.options"
      settingsNavLocale.hooks, // "repo.settings.hooks"
      settingsNavLocale.labels, // "repo.labels"
      settingsNavLocale.applications, // "settings.applications" (lit by the R20-a applications tab's mount)
      settingsNavLocale.blocked_users, // "user.block.list"
      settingsNavLocale.actions, // "actions.actions"
      settingsNavLocale.actions_general, // "actions.general"/"settings.general" (lit by the org general page's module, P2-2)
      settingsNavLocale.runners, // "actions.runners" (lit by the C7 org twin's mount)
      settingsNavLocale.secrets, // "secrets.secrets"
      settingsNavLocale.variables, // "actions.variables"
      settingsNavLocale.scoped_workflows, // "actions.scoped_workflows" (lit by the store wave's org mount)
      settingsNavLocale.audit, // "audit.title" (lit by the census R13 org arm's mount)
    ]) {
      expect(html).toContain(text);
    }
  });

  it("renders the landed items in upstream order (navbar.tmpl:4-48 + the Audit item, dead items dropped)", () => {
    assertHrefOrder(renderToString(<OrgSettingsNavbar orgLink="/org/acme" active="options" />), [
      'href="/org/acme/settings"',
      'href="/org/acme/settings/hooks"',
      'href="/org/acme/settings/labels"', // the wave-14 divergence — upstream: /settings/labels
      'href="/org/acme/settings/applications"', // lit by the R20-a applications tab's mount
      'href="/org/acme/settings/blocked_users"',
      'href="/org/acme/settings/actions"', // lit by the org general page's module (P2-2) — navbar.tmpl:32-34's BARE actions URL, before Runners
      'href="/org/acme/settings/actions/runners"', // lit by the C7 org twin's mount — navbar.tmpl:35-37, before Secrets
      'href="/org/acme/settings/actions/secrets"',
      'href="/org/acme/settings/actions/variables"',
      'href="/org/acme/settings/actions/scoped-workflows"', // lit by the store wave's org mount — navbar.tmpl:44-45
      'href="/org/acme/settings/audit_logs"', // lit by the census R13 org arm's mount — LAST, navbar.tmpl:50-52
    ]);
  });

  it("renders the Labels item at upstream's settings/labels subtree (the wave-14 divergence retired — ledger B3)", () => {
    const html = renderToString(<OrgSettingsNavbar orgLink="/org/acme" active="options" />);
    expect(html).toContain('href="/org/acme/settings/labels"'); // upstream navbar.tmpl:12-14's `{.OrgLink}/settings/labels`
    expect(html).not.toContain('href="/org/acme/labels"'); // the retired bare /{org}/labels target — never rendered
  });

  it("renders NO dead items — every Actions sub-item is landed (Applications landed with the R20-a tab, Audit with the census R13 org arm, Runners with the C7 org twin's mount, Packages with the org settings packages tab's mount, General with the org general page's module, Scoped-workflows with the store wave's org mount)", () => {
    const html = renderToString(<OrgSettingsNavbar orgLink="/org/acme" active="options" />);
    // The General sub-item (:32-34) renders with upstream's own bare
    // `{OrgLink}/settings/actions` href — the quoted attribute shape
    // disambiguates it from the landed tails' longer hrefs.
    expect(html).toContain('href="/org/acme/settings/actions"');
    // The Scoped-workflows sub-item (:44-45) rendered with the store wave's
    // mount (pages/org-settings-actions-scoped-workflows.tsx).
    expect(html).toContain('href="/org/acme/settings/actions/scoped-workflows"');
  });

  it("marks exactly the active tab's anchor (every union member)", () => {
    const expectations: Record<string, string> = {
      options: 'href="/org/acme/settings"',
      hooks: 'href="/org/acme/settings/hooks"',
      labels: 'href="/org/acme/settings/labels"',
      applications: 'href="/org/acme/settings/applications"',
      blocked: 'href="/org/acme/settings/blocked_users"',
      "actions-general": 'href="/org/acme/settings/actions"', // the org general page (P2-2) — the bare actions URL
      runners: 'href="/org/acme/settings/actions/runners"',
      secrets: 'href="/org/acme/settings/actions/secrets"',
      variables: 'href="/org/acme/settings/actions/variables"',
      "actions-scoped-workflows": 'href="/org/acme/settings/actions/scoped-workflows"', // the store wave's org page
      audit: 'href="/org/acme/settings/audit_logs"',
    };
    for (const [tab, href] of Object.entries(expectations)) {
      const html = renderToString(
        <OrgSettingsNavbar
          orgLink="/org/acme"
          active={
            tab as
              | "options"
              | "hooks"
              | "labels"
              | "applications"
              | "blocked"
              | "actions-general"
              | "runners"
              | "secrets"
              | "variables"
              | "actions-scoped-workflows"
              | "audit"
          }
        />,
      );
      expect(html, `active=${tab}`).toContain(`class="active item" ${href}`);
      expect(html.match(/class="active item" href=/g)?.length, `active=${tab}`).toBe(1);
    }
  });

  it("opens the Actions disclosure while an actions-group page renders, closed otherwise (navbar.tmpl:29)", () => {
    expect(renderToString(<OrgSettingsNavbar orgLink="/org/acme" active="actions-general" />)).toContain('<details class="item" open');
    expect(renderToString(<OrgSettingsNavbar orgLink="/org/acme" active="runners" />)).toContain('<details class="item" open');
    expect(renderToString(<OrgSettingsNavbar orgLink="/org/acme" active="secrets" />)).toContain('<details class="item" open');
    expect(renderToString(<OrgSettingsNavbar orgLink="/org/acme" active="variables" />)).toContain('<details class="item" open');
    expect(renderToString(<OrgSettingsNavbar orgLink="/org/acme" active="actions-scoped-workflows" />)).toContain('<details class="item" open');
    const closed = renderToString(<OrgSettingsNavbar orgLink="/org/acme" active="blocked" />);
    expect(closed).toContain('<details class="item">');
    expect(closed).not.toContain("open");
  });

  it("carries the orgLink verbatim into every href (the family's OrgLink = /org/{org} — upstream OrganisationLink, user.go:351-355)", () => {
    const html = renderToString(<OrgSettingsNavbar orgLink="/org/Org-With-Caps" active="options" />);
    expect(html).toContain('href="/org/Org-With-Caps/settings"');
    expect(html).toContain('href="/org/Org-With-Caps/settings/hooks"');
    expect(html).toContain('href="/org/Org-With-Caps/settings/labels"');
    expect(html).toContain('href="/org/Org-With-Caps/settings/applications"');
    expect(html).toContain('href="/org/Org-With-Caps/settings/blocked_users"');
  });
});

/**
 * The user settings NOTIFICATIONS tab module's tests (the
 * preference-matrix wave, the bench row `wave-settings-notifications` —
 * specs/user-notification-settings.md §6): the two write arms over the
 * `user_settings` side store's notification columns (migration 0034) with
 * real D1 (generated migrations in beforeAll), the exact-match catalog
 * membership checks, the sibling-column non-clobbering proof (SPEC §4.2,
 * executed against the landed saveUserSettings), and the DOM contract of
 * the page render — hono/jsx renderToString, the module driven directly.
 *
 * The module is TWO-STAGE UNMOUNTED at this wave's gates (the route rides
 * the index.ts window; the module's HANDOFF NOTE carries the deferred
 * route matrix — the anonymous 303s, the two saved 303 targets, the
 * guard-first cross-origin 403, the nav-swap assertion — the
 * appearance/organizations mounted matrices' pattern). The saved outcome
 * is asserted against the wiring wave's 303 target constant,
 * USER_SETTINGS_NOTIFICATIONS_REDIRECT below.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { saveUserSettings } from "../../api/services/user-settings";
import type { EmailNotificationsPreference } from "../../api/services/user-notification-prefs";
import { userSettings } from "../../db/schema";
import {
  ACTIONS_EMAIL_NOTIFICATION_PREFERENCES,
  applyUserSettingsNotificationsActionsForm,
  applyUserSettingsNotificationsEmailForm,
  EMAIL_NOTIFICATION_PREFERENCES,
  invalidDataMessage,
  loadUserSettingsNotificationsPageData,
  parseUserSettingsNotificationsActionsForm,
  parseUserSettingsNotificationsEmailForm,
  renderUserSettingsNotificationsPage,
  UserSettingsNotificationsPage,
  userSettingsNotificationsLocale,
} from "./user-settings-notifications";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";

// --- fixtures ----------------------------------------------------------------

/** The saved outcome's 303 Location — upstream's
 *  `ctx.Redirect(setting.AppSubURL + "/user/settings/notifications")`
 *  (notifications.go:54,65,81,88); the wiring wave's handlers must answer
 *  exactly this (the HANDOFF NOTE's recipes). */
const USER_SETTINGS_NOTIFICATIONS_REDIRECT = "/user/settings/notifications";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const ctx: UiContext = {
  viewer: { kind: "user", id: 1, username: "alice", isAdmin: false },
  origin: "https://test.local",
  assets: shellAssetsFromManifest(manifest),
};

async function pageHtml(explicitData?: NonNullable<Awaited<ReturnType<typeof loadUserSettingsNotificationsPageData>>>): Promise<string> {
  const data = explicitData ?? (await loadUserSettingsNotificationsPageData(env.DB, 1))!;
  return renderToString(<UserSettingsNotificationsPage ctx={ctx} data={data} error={null} />);
}

/** The FULL side-store row (every column — the non-clobbering assertions
 *  read it wholesale). */
async function storedRow() {
  return drizzle(env.DB).select().from(userSettings).where(eq(userSettings.userId, 1)).get();
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user_settings").run();
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
});

// --- the loader ---------------------------------------------------------------

describe("loadUserSettingsNotificationsPageData", () => {
  it("renders upstream's creation defaults when no side-store row exists ('enabled' / 'failure-only')", async () => {
    expect(await loadUserSettingsNotificationsPageData(env.DB, 1)).toEqual({
      emailNotificationsPreference: "enabled",
      actionsEmailNotificationsPreference: "failure-only",
    });
  });

  it("returns null when the doer has no users row (the silent-auth-failure 404 input)", async () => {
    expect(await loadUserSettingsNotificationsPageData(env.DB, 999)).toBeNull();
  });

  it("reads the stored preferences after a save (the side store, not the users row)", async () => {
    await applyUserSettingsNotificationsEmailForm(env.DB, 1, { preference: "onmention" });
    await applyUserSettingsNotificationsActionsForm(env.DB, 1, { preference: "all" });
    expect(await loadUserSettingsNotificationsPageData(env.DB, 1)).toEqual({
      emailNotificationsPreference: "onmention",
      actionsEmailNotificationsPreference: "all",
    });
  });

  it("reads a pre-0034 row's backfilled defaults as the same values (the migration's backfill)", async () => {
    await env.DB.prepare("INSERT INTO user_settings (user_id) VALUES (1)").run();
    expect(await loadUserSettingsNotificationsPageData(env.DB, 1)).toEqual({
      emailNotificationsPreference: "enabled",
      actionsEmailNotificationsPreference: "failure-only",
    });
  });
});

// --- the parsers ----------------------------------------------------------------

describe("the form parsers (the readUrlEncodedForm convention — upstream's single `preference` field)", () => {
  it("parses both POSTs (the routes distinguish the arms, as upstream)", () => {
    expect(parseUserSettingsNotificationsEmailForm(new URLSearchParams("preference=onmention"))).toEqual({ preference: "onmention" });
    expect(parseUserSettingsNotificationsActionsForm(new URLSearchParams("preference=failure-only"))).toEqual({ preference: "failure-only" });
  });

  it("parses an absent field as \"\" (which fails both catalogs — the invalid arm)", () => {
    expect(parseUserSettingsNotificationsEmailForm(new URLSearchParams())).toEqual({ preference: "" });
    expect(parseUserSettingsNotificationsActionsForm(new URLSearchParams())).toEqual({ preference: "" });
  });
});

// --- the email write (upstream NotificationsEmailPost) ----------------------------

describe("applyUserSettingsNotificationsEmailForm", () => {
  it("stores each of the four catalog members (upstream user.go:84-91)", async () => {
    for (const preference of EMAIL_NOTIFICATION_PREFERENCES) {
      expect(await applyUserSettingsNotificationsEmailForm(env.DB, 1, { preference })).toEqual({ outcome: "saved" });
      expect(await storedRow()).toMatchObject({ emailNotificationsPreference: preference });
    }
  });

  it("answers invalid_data with the raw value for a non-member — including the ACTIONS-family value", async () => {
    expect(await applyUserSettingsNotificationsEmailForm(env.DB, 1, { preference: "failure-only" })).toEqual({
      outcome: "invalid",
      message: "Invalid data: failure-only",
    });
    expect(await storedRow()).toBeUndefined();
  });

  it("matches the catalog exactly — a case-variant spelling is a non-member (upstream's exact-match semantics)", async () => {
    expect(await applyUserSettingsNotificationsEmailForm(env.DB, 1, { preference: "Enabled" })).toEqual({
      outcome: "invalid",
      message: invalidDataMessage("Enabled"),
    });
    expect(await applyUserSettingsNotificationsEmailForm(env.DB, 1, { preference: "" })).toEqual({
      outcome: "invalid",
      message: "Invalid data: ",
    });
    expect(await storedRow()).toBeUndefined();
  });

  it("writes ONLY its own column — the first insert materializes upstream's creation defaults for the rest", async () => {
    await applyUserSettingsNotificationsEmailForm(env.DB, 1, { preference: "disabled" });
    expect(await storedRow()).toEqual({
      userId: 1,
      theme: "gitea-auto",
      language: "",
      diffViewStyle: "",
      hideEmail: false,
      hideActivity: false,
      emailNotificationsPreference: "disabled",
      actionsEmailNotificationsPreference: "failure-only",
    });
  });

  it("keeps the sibling columns (and the actions pref) on a re-save (the targeted upsert)", async () => {
    await saveUserSettings(env.DB, 1, { theme: "gitea-dark", language: "ja-JP" });
    await applyUserSettingsNotificationsActionsForm(env.DB, 1, { preference: "all" });
    await applyUserSettingsNotificationsEmailForm(env.DB, 1, { preference: "andyourown" });
    expect(await storedRow()).toMatchObject({
      theme: "gitea-dark",
      language: "ja-JP",
      emailNotificationsPreference: "andyourown",
      actionsEmailNotificationsPreference: "all",
    });
  });

  it("survives a sibling saveUserSettings write (the non-clobbering proof, SPEC §4.2 — executed)", async () => {
    await applyUserSettingsNotificationsEmailForm(env.DB, 1, { preference: "onmention" });
    await applyUserSettingsNotificationsActionsForm(env.DB, 1, { preference: "disabled" });
    await saveUserSettings(env.DB, 1, { theme: "gitea-light" });
    expect(await storedRow()).toMatchObject({
      theme: "gitea-light",
      emailNotificationsPreference: "onmention",
      actionsEmailNotificationsPreference: "disabled",
    });
  });
});

// --- the actions write (upstream NotificationsActionsEmailPost) --------------------

describe("applyUserSettingsNotificationsActionsForm", () => {
  it("stores each of the three catalog members (upstream setting_options.go:22-24)", async () => {
    for (const preference of ACTIONS_EMAIL_NOTIFICATION_PREFERENCES) {
      expect(await applyUserSettingsNotificationsActionsForm(env.DB, 1, { preference })).toEqual({ outcome: "saved" });
      expect(await storedRow()).toMatchObject({ actionsEmailNotificationsPreference: preference });
    }
  });

  it("answers invalid_data for a non-member — including the EMAIL-family value 'enabled'", async () => {
    expect(await applyUserSettingsNotificationsActionsForm(env.DB, 1, { preference: "enabled" })).toEqual({
      outcome: "invalid",
      message: "Invalid data: enabled",
    });
    expect(await applyUserSettingsNotificationsActionsForm(env.DB, 1, { preference: "andyourown" })).toEqual({
      outcome: "invalid",
      message: "Invalid data: andyourown",
    });
    expect(await storedRow()).toBeUndefined();
  });

  it("writes ONLY its own column (the targeted upsert, first insert)", async () => {
    await applyUserSettingsNotificationsActionsForm(env.DB, 1, { preference: "failure-only" });
    expect(await storedRow()).toEqual({
      userId: 1,
      theme: "gitea-auto",
      language: "",
      diffViewStyle: "",
      hideEmail: false,
      hideActivity: false,
      emailNotificationsPreference: "enabled",
      actionsEmailNotificationsPreference: "failure-only",
    });
  });
});

// --- the catalogs -----------------------------------------------------------------

describe("the catalogs (the pin's data, in the template's dropdown order)", () => {
  it("carries the four email values in notifications.tmpl:18-21 order", () => {
    expect([...EMAIL_NOTIFICATION_PREFERENCES]).toEqual(["enabled", "andyourown", "onmention", "disabled"]);
  });

  it("carries the three actions values in notifications.tmpl:48-50 order", () => {
    expect([...ACTIONS_EMAIL_NOTIFICATION_PREFERENCES]).toEqual(["all", "failure-only", "disabled"]);
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the notifications page DOM (notifications.tmpl + layout_head.tmpl at the pin)", () => {
  it("renders the page discriminator (the literal `user settings`), the scaffolding nav with Notifications active, and the wrapper", async () => {
    const html = await pageHtml();
    expect(html).toContain('class="page-content user settings"');
    expect(html).toContain('class="active item" href="/user/settings/notifications"'); // navbar.tmpl:12-16, active
    expect(html).toContain('href="/user/settings"'); // the live Profile item
    expect(html).toContain('href="/user/settings/appearance"');
    expect(html).toContain('class="user-setting-content"');
  });

  it("renders both forms with the exact upstream actions and the shared `preference` field name", async () => {
    const html = await pageHtml();
    expect(html).toContain('action="/user/settings/notifications/email"');
    expect(html).toContain('action="/user/settings/notifications/actions"');
    expect(html.match(/name="preference"/g)?.length).toBe(2);
  });

  it("renders the section headers, description, and submit texts (the locale keys)", async () => {
    const html = await pageHtml();
    expect(html).toContain(">Notifications</h4>"); // Tr "notifications" — the email section header
    expect(html).toContain(">Actions</h4>"); // Tr "actions.actions"
    expect(html).toContain(userSettingsNotificationsLocale.email_desc); // settings.email_desc
    expect(html).toContain(userSettingsNotificationsLocale.actions_desc_prefix); // the actions description text
    expect(html).toContain('href="https://docs.gitea.com/usage/actions/overview/"'); // the locale's embedded anchor, external
    expect(html.match(/>Set Email Preference<\/button>/g)?.length).toBe(2); // settings.email_notifications.submit, both forms
  });

  it("renders the email select's four options in template order with the stored value selected", async () => {
    const html = await pageHtml();
    const emailSlice = html.slice(html.indexOf('action="/user/settings/notifications/email"'), html.indexOf('action="/user/settings/notifications/actions"'));
    expect(emailSlice).toContain('<option value="enabled" selected="">');
    expect(emailSlice).toContain("<option value=\"andyourown\">And Your Own Notifications</option>");
    expect(emailSlice).toContain("<option value=\"onmention\">Only Email on Mention and Custom Watches</option>");
    expect(emailSlice).toContain("<option value=\"disabled\">Disable Email Notifications</option>");
    expect(emailSlice.match(/selected=""/g)?.length).toBe(1); // exactly the stored one
  });

  it("renders the actions select's three options in template order with the stored value selected", async () => {
    const html = await pageHtml({
      emailNotificationsPreference: "onmention",
      actionsEmailNotificationsPreference: "all",
    });
    const actionsSlice = html.slice(html.indexOf('action="/user/settings/notifications/actions"'));
    expect(actionsSlice).toContain('<option value="all" selected="">');
    expect(actionsSlice).toContain("<option value=\"failure-only\">Only notify for failed workflow runs</option>");
    expect(actionsSlice).toContain("<option value=\"disabled\">Disabled</option>");
    expect(html).toContain('<option value="onmention" selected="">'); // the email select (above this slice) keeps its own stored value
    expect(actionsSlice).not.toContain('<option value="failure-only" selected=""');
  });

  it("renders an out-of-catalog stored value as an extra selected option (never silently rewritten)", async () => {
    // A hand-edited D1 value cannot arrive through the typed insert path —
    // the render input is built the way the loader would hand it on
    // (string → the column's union, the drizzle row's own narrowing).
    const stray: string = "legacy-value";
    const html = await pageHtml({
      emailNotificationsPreference: stray as EmailNotificationsPreference,
      actionsEmailNotificationsPreference: "failure-only",
    });
    expect(html).toContain('<option value="legacy-value" selected="">');
    expect(html).toContain('<option value="enabled"'); // the catalog still renders after it
  });

  it("routes the invalid re-render's message to the submitting form only (the carried-form convention)", () => {
    const html = renderToString(
      <UserSettingsNotificationsPage
        ctx={ctx}
        data={{ emailNotificationsPreference: "enabled", actionsEmailNotificationsPreference: "failure-only" }}
        error={{ form: "email", message: invalidDataMessage("failure-only") }}
      />,
    );
    const emailSlice = html.slice(html.indexOf('action="/user/settings/notifications/email"'), html.indexOf('action="/user/settings/notifications/actions"'));
    const actionsSlice = html.slice(html.indexOf('action="/user/settings/notifications/actions"'));
    expect(emailSlice).toContain('class="ui negative message"');
    expect(emailSlice).toContain("Invalid data: failure-only");
    expect(actionsSlice).not.toContain("ui negative message"); // the other form stays clean
    expect(actionsSlice).not.toContain("Invalid data: failure-only");

    const html2 = renderToString(
      <UserSettingsNotificationsPage
        ctx={ctx}
        data={{ emailNotificationsPreference: "enabled", actionsEmailNotificationsPreference: "failure-only" }}
        error={{ form: "actions", message: invalidDataMessage("Enabled") }}
      />,
    );
    const actionsSlice2 = html2.slice(html2.indexOf('action="/user/settings/notifications/actions"'));
    expect(actionsSlice2).toContain("Invalid data: Enabled");
    expect(html2.slice(html2.indexOf('action="/user/settings/notifications/email"'), html2.indexOf('action="/user/settings/notifications/actions"'))).not.toContain(
      "Invalid data: Enabled",
    );
  });

  it("renders no message lines on the plain GET (renderUserSettingsNotificationsPage's null error default)", () => {
    // The exported full-document wrapper (the wiring wave's render call).
    const html = renderUserSettingsNotificationsPage(ctx, {
      emailNotificationsPreference: "enabled",
      actionsEmailNotificationsPreference: "failure-only",
    });
    expect(html).not.toContain("ui negative message");
    expect(html).toContain('action="/user/settings/notifications/email"'); // the wrapper renders the full document
  });
});

// --- the wiring contract -----------------------------------------------------------

describe("the wiring contract (the HANDOFF NOTE's constant — the route matrix is deferred to the index.ts window)", () => {
  it("pins the saved outcome's 303 target (upstream's redirect, notifications.go:65/88)", () => {
    expect(USER_SETTINGS_NOTIFICATIONS_REDIRECT).toBe("/user/settings/notifications");
  });
});

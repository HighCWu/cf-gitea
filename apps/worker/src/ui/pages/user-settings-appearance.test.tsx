/**
 * The user settings APPEARANCE tab module's tests (pages wave 57, the bench
 * row `wave-user-appearance-module` — the repo-settings-wiki /
 * user-settings-security UNMOUNTED harness): the write arms over the landed
 * `user_settings` side store with real D1 (generated migrations in
 * beforeAll), the theme catalog + language catalog membership checks, and
 * the DOM contract of the page render — hono/jsx renderToString, the module
 * driven directly (no route yet, the HANDOFF NOTE in the module header).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { userSettings } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  applyUserSettingsAppearanceLanguageForm,
  applyUserSettingsAppearanceThemeForm,
  AVAILABLE_LANGUAGES,
  AVAILABLE_THEMES,
  loadUserSettingsAppearancePageData,
  parseUserSettingsAppearanceLanguageForm,
  parseUserSettingsAppearanceThemeForm,
  renderUserSettingsAppearancePage,
  UserSettingsAppearanceNav,
  UserSettingsAppearancePage,
  userSettingsAppearanceLocale,
} from "./user-settings-appearance";

// --- fixtures ----------------------------------------------------------------

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const selfViewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };
const ctx: UiContext = {
  viewer: selfViewer,
  origin: "https://test.local",
  assets: shellAssetsFromManifest(manifest),
};

async function pageHtml(explicitData?: NonNullable<Awaited<ReturnType<typeof loadUserSettingsAppearancePageData>>>): Promise<string> {
  const data = explicitData ?? (await loadUserSettingsAppearancePageData(env.DB, 1))!;
  return renderToString(<UserSettingsAppearancePage ctx={ctx} data={data} error={null} />);
}

async function storedSettings(): Promise<{ theme: string; language: string }> {
  const row = await drizzle(env.DB).select().from(userSettings).where(eq(userSettings.userId, 1)).get();
  return { theme: row?.theme ?? "(no row)", language: row?.language ?? "(no row)" };
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

describe("loadUserSettingsAppearancePageData", () => {
  it("renders upstream's creation defaults when no side-store row exists", async () => {
    expect(await loadUserSettingsAppearancePageData(env.DB, 1)).toEqual({ theme: "gitea-auto", language: "" });
  });

  it("returns null when the doer has no users row (the silent-auth-failure 404 input)", async () => {
    expect(await loadUserSettingsAppearancePageData(env.DB, 999)).toBeNull();
  });

  it("reads the stored preferences after a save (the side store, not the users row)", async () => {
    await applyUserSettingsAppearanceThemeForm(env.DB, 1, { theme: "gitea-dark" });
    await applyUserSettingsAppearanceLanguageForm(env.DB, 1, { language: "zh-CN" });
    expect(await loadUserSettingsAppearancePageData(env.DB, 1)).toEqual({ theme: "gitea-dark", language: "zh-CN" });
  });
});

// --- the parsers ----------------------------------------------------------------

describe("the form parsers (the readUrlEncodedForm convention)", () => {
  it("parses the theme POST (upstream forms.UpdateThemeForm's single field)", () => {
    expect(parseUserSettingsAppearanceThemeForm(new URLSearchParams("theme=gitea-dark"))).toEqual({ theme: "gitea-dark" });
    expect(parseUserSettingsAppearanceThemeForm(new URLSearchParams())).toEqual({ theme: "" });
  });

  it("parses the language POST (upstream forms.UpdateLanguageForm's single field)", () => {
    expect(parseUserSettingsAppearanceLanguageForm(new URLSearchParams("language=zh-CN"))).toEqual({ language: "zh-CN" });
    expect(parseUserSettingsAppearanceLanguageForm(new URLSearchParams())).toEqual({ language: "" });
  });
});

// --- the theme write (upstream UpdateUIThemePost) --------------------------------

describe("applyUserSettingsAppearanceThemeForm", () => {
  it("stores a catalog member through saveUserSettings (upstream UpdateOptions.Theme)", async () => {
    expect(await applyUserSettingsAppearanceThemeForm(env.DB, 1, { theme: "gitea-dark" })).toEqual({ outcome: "saved" });
    expect(await storedSettings()).toMatchObject({ theme: "gitea-dark" });
  });

  it("answers the Required binder arm for an empty theme", async () => {
    const result = await applyUserSettingsAppearanceThemeForm(env.DB, 1, { theme: "" });
    expect(result).toEqual({ outcome: "invalid", message: "Theme: Required" });
    expect(await drizzle(env.DB).select().from(userSettings).where(eq(userSettings.userId, 1)).get()).toBeUndefined();
  });

  it("answers theme_update_error for a non-member (webtheme.GetThemeMetaInfo nil)", async () => {
    const result = await applyUserSettingsAppearanceThemeForm(env.DB, 1, { theme: "not-a-theme" });
    expect(result).toEqual({ outcome: "invalid", message: userSettingsAppearanceLocale.theme_update_error });
    expect(await storedSettings()).toMatchObject({ theme: "(no row)" });
  });

  it("re-saving over an existing row keeps the rest of the side store (the upsert merge)", async () => {
    await applyUserSettingsAppearanceLanguageForm(env.DB, 1, { language: "ja-JP" });
    await applyUserSettingsAppearanceThemeForm(env.DB, 1, { theme: "gitea-light" });
    expect(await storedSettings()).toEqual({ theme: "gitea-light", language: "ja-JP" });
  });
});

// --- the language write (upstream UpdateUserLang) ---------------------------------

describe("applyUserSettingsAppearanceLanguageForm", () => {
  it("stores a catalog member (upstream UpdateOptions.Language)", async () => {
    expect(await applyUserSettingsAppearanceLanguageForm(env.DB, 1, { language: "zh-CN" })).toEqual({ outcome: "saved" });
    expect(await storedSettings()).toMatchObject({ language: "zh-CN" });
  });

  it("allows the empty value and stores it (upstream's `if form.Language != \"\"` guard)", async () => {
    await applyUserSettingsAppearanceLanguageForm(env.DB, 1, { language: "zh-CN" });
    expect(await applyUserSettingsAppearanceLanguageForm(env.DB, 1, { language: "" })).toEqual({ outcome: "saved" });
    expect(await storedSettings()).toMatchObject({ language: "" });
  });

  it("answers update_language_not_found with the quoted lang for a non-member", async () => {
    const result = await applyUserSettingsAppearanceLanguageForm(env.DB, 1, { language: "xx-XX" });
    expect(result).toEqual({ outcome: "invalid", message: 'Language "xx-XX" is not available.' });
    expect(await storedSettings()).toMatchObject({ language: "(no row)" });
  });
});

// --- the catalogs -----------------------------------------------------------------

describe("the catalogs (the pin's data, in webtheme.go / i18n.go order)", () => {
  it("carries the nine built themes in upstream's sort order (default first, then colorblind, then name)", () => {
    expect(AVAILABLE_THEMES.map((theme) => theme.internalName)).toEqual([
      "gitea-auto",
      "gitea-dark",
      "gitea-light",
      "gitea-auto-tritanopia",
      "gitea-dark-tritanopia",
      "gitea-light-tritanopia",
      "gitea-auto-protanopia-deuteranopia",
      "gitea-dark-protanopia-deuteranopia",
      "gitea-light-protanopia-deuteranopia",
    ]);
  });

  it("carries upstream's default 28-language list in defaultI18nLangNames order", () => {
    expect(AVAILABLE_LANGUAGES.length).toBe(28);
    expect(AVAILABLE_LANGUAGES[0]).toEqual({ lang: "en-US", name: "English" });
    expect(AVAILABLE_LANGUAGES[AVAILABLE_LANGUAGES.length - 1]).toEqual({ lang: "ml-IN", name: "മലയാളം" });
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the appearance page DOM (appearance.tmpl + layout_head.tmpl at the pin)", () => {
  it("renders the page discriminator (the literal `user settings`), the navbar with Appearance active, and the wrapper", async () => {
    const html = await pageHtml();
    expect(html).toContain('class="page-content user settings"'); // appearance.tmpl:1's dict — NOT "user settings appearance"
    expect(html).toContain('class="active item" href="/user/settings/appearance"');
    expect(html).toContain('href="/user/settings"'); // the live Profile item
    expect(html).toContain('href="/user/settings/security"');
    expect(html).toContain('href="/user/settings/applications"');
    expect(html).toContain('href="/user/settings/keys"');
    expect(html).toContain("<details"); // the Actions disclosure
    expect(html).toContain('href="/user/settings/actions/secrets"');
    expect(html).toContain("user-setting-content"); // appearance.tmpl:2's wrapper
    expect(html).toContain("flex-container-main"); // layout_head's content column
  });

  it("renders the theme section: header, GitHub themes link with its tooltip, select over the nine themes, submit", async () => {
    const html = await pageHtml();
    expect(html).toContain(userSettingsAppearanceLocale.manage_themes); // settings.manage_themes
    expect(html).toContain(userSettingsAppearanceLocale.theme_desc);
    expect(html).toContain('href="https://github.com/go-gitea/gitea/blob/main/web_src/css/themes/"');
    expect(html).toContain(userSettingsAppearanceLocale.theme_colorblindness_help);
    expect(html).toContain(userSettingsAppearanceLocale.theme_colorblindness_prompt.replaceAll('"', "&quot;")); // the tooltip's escaped render
    expect(html).toContain('action="/user/settings/appearance/theme" method="post"');
    expect(html).toContain('name="theme"');
    expect(html).toContain('<option value="gitea-auto"'); // the default theme is an option
    expect(html).toContain("Red-green colorblind friendly"); // the colorblind description carrier
    expect(html).toContain("Blue-yellow colorblind friendly");
    expect(html).toContain(userSettingsAppearanceLocale.update_theme);
  });

  it("marks the stored theme selected (upstream's hidden input value)", async () => {
    await applyUserSettingsAppearanceThemeForm(env.DB, 1, { theme: "gitea-dark" });
    const html = await pageHtml();
    expect(html).toContain('<option value="gitea-dark" selected="">');
  });

  it("renders the language section: upstream's id, the empty first option, the 28 members, submit", async () => {
    const html = await pageHtml();
    expect(html).toContain('id="language" name="language"'); // appearance.tmpl:45's dropdown id
    expect(html).toContain('action="/user/settings/appearance/language" method="post"');
    expect(html).toContain('<option value="" selected=""></option>'); // the never-set user's ""
    expect(html).toContain('<option value="en-US"'); // English
    expect(html).toContain('<option value="zh-CN"'); // 简体中文
    expect(html).toContain(userSettingsAppearanceLocale.update_language);
  });

  it("marks the stored language selected", async () => {
    await applyUserSettingsAppearanceLanguageForm(env.DB, 1, { language: "de-DE" });
    const html = await pageHtml();
    expect(html).toContain('<option value="de-DE" selected="">');
    expect(html).not.toContain('<option value="" selected');
  });

  it("renders a stored value outside a catalog as an extra selected option (never silently rewritten)", async () => {
    await drizzle(env.DB)
      .insert(userSettings)
      .values({ userId: 1, theme: "legacy-theme", language: "xx-XX" })
      .onConflictDoUpdate({ target: userSettings.userId, set: { theme: "legacy-theme", language: "xx-XX" } });
    const html = await pageHtml();
    expect(html).toContain('<option value="legacy-theme" selected="">'); // submitting it answers theme_update_error
    expect(html).toContain('<option value="xx-XX" selected="">'); // submitting it answers update_language_not_found
  });

  it("routes a failed POST's error line into its own form (the keys-module kind convention)", () => {
    const themeError = renderToString(
      <UserSettingsAppearancePage ctx={ctx} data={{ theme: "gitea-auto", language: "" }} error={{ form: "theme", message: userSettingsAppearanceLocale.theme_update_error }} />,
    );
    expect(themeError).toContain(`ui negative message">${userSettingsAppearanceLocale.theme_update_error}`);
    const languageError = renderToString(
      <UserSettingsAppearancePage ctx={ctx} data={{ theme: "gitea-auto", language: "" }} error={{ form: "language", message: 'Language "xx-XX" is not available.' }} />,
    );
    expect(languageError).toContain("ui negative message");
    expect(languageError).toContain("Language &quot;xx-XX&quot; is not available.");
  });

  it("renders NO dead controls — the hidden-comment-types section is unrendered (no landed store)", async () => {
    const html = await pageHtml();
    expect(html).not.toContain("hidden_comments"); // the unmounted POST arm
    expect(html).not.toContain("Hidden comment types"); // settings.hidden_comment_types header
    expect(html).not.toContain('name="reference"'); // the 14 checkbox groups
    expect(html).not.toContain('name="time_tracking"');
    expect(html).not.toContain("comment_type_group");
    expect(html).not.toContain("show-panel"); // no tw-hidden panel toggles anywhere
    expect(html).not.toContain("<dialog");
  });

  it("the full-document render path matches the component path", async () => {
    const data = await loadUserSettingsAppearancePageData(env.DB, 1);
    const html = renderUserSettingsAppearancePage(ctx, data!);
    expect(html).toContain('class="page-content user settings"');
    expect(html).toContain(userSettingsAppearanceLocale.manage_themes);
  });
});

// --- the nav (the mount scaffolding) ---------------------------------------------

describe("UserSettingsAppearanceNav", () => {
  it("renders the active discrimination for the family items", () => {
    expect(renderToString(<UserSettingsAppearanceNav active="appearance" />)).toContain(
      'class="active item" href="/user/settings/appearance"',
    );
    expect(renderToString(<UserSettingsAppearanceNav active="profile" />)).toContain(
      'class="active item" href="/user/settings"',
    );
    const secretsActive = renderToString(<UserSettingsAppearanceNav active="secrets" />);
    expect(secretsActive).toContain('class="active item" href="/user/settings/actions/secrets"');
    expect(secretsActive).toContain("open"); // navbar.tmpl's open arm
  });
});

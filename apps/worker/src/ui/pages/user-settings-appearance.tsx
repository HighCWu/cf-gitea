/**
 * The user settings APPEARANCE tab, `/user/settings/appearance` — pages wave
 * 57 (bench row `wave-user-appearance-module`, MOUNTED at 0c2b151 — the
 * route lives in `index.ts`).
 *
 * PREMISE VERIFIED: `templates/user/settings/appearance.tmpl` exists at the
 * pin (fc49368, 2026-10-24) and renders THREE forms — the theme select
 * (POST `{{.Link}}/theme`), the language select (POST `/language`) and the
 * hidden-comment-types checkbox grid (POST `/hidden_comments`); the routes
 * are web.go:646-651 with handlers in routers/web/user/setting/profile.go
 * (Appearance :328, UpdateUIThemePost :349, UpdateUserLang :379,
 * UpdateUserHiddenComments :409 — there is no appearance.go at the pin).
 *
 * ## Mount record (MOUNTED at 0c2b151 — the wiring HANDOFF is retired)
 *
 * Upstream's route group is web.go:646-651 (inside the reqSignIn
 * `/user/settings` group). The theme + language arms mount; the
 * hidden_comments arm does NOT (no landed store — the reductions):
 *
 *   GET /user/settings/appearance → resolveUiSession (the signed-in gate,
 *                the user-settings.tsx pattern; anonymous 303s onto the
 *                login round-trip) → loadUserSettingsAppearancePageData →
 *                null 404-shells (the silent-auth-failure convention) →
 *                renderUserSettingsAppearancePage.
 *   POST /user/settings/appearance/theme    → the sameOriginGuard + the
 *                signed-in gate + the null loader gate, `readUrlEncodedForm`,
 *                `parseUserSettingsAppearanceThemeForm`,
 *                `applyUserSettingsAppearanceThemeForm`. `outcome: "saved"`
 *                303s back onto `/user/settings/appearance` (upstream's
 *                redirect; the no-session-flash reduction —
 *                settings.theme_update_success never renders). An
 *                `outcome: "invalid"` re-renders the FULL page at 200 with
 *                the `error` line routed to the theme form (upstream's
 *                Flash.Error + redirect arm reduced — the keys-module
 *                RenderWithErrDeprecated analog).
 *   POST /user/settings/appearance/language → the same prologue with
 *                `parseUserSettingsAppearanceLanguageForm` +
 *                `applyUserSettingsAppearanceLanguageForm`; the outcome
 *                error routes to the language form. Upstream's
 *                SetLocaleCookie arm (profile.go:402) is NOT ported — no
 *                locale-cookie machinery exists (the session cookie in
 *                auth/session.ts is the only cookie writer; server pages
 *                render English — locale.ts's slice-1 note).
 *   POST /user/settings/appearance/hidden_comments → UNMOUNTED: upstream
 *                stores the bitset in the `user_setting` KV table under
 *                `issue.hidden_comment_types` (models/user/setting_options.go
 *                :8, SetUserSetting/GetUserSetting); cf-gitea has no
 *                user_setting KV table — the landed `userSettings` side
 *                store is a fixed five-column store (src/db/schema.ts) with
 *                no hidden-comment-types column — so the section renders
 *                nothing and the route stays unmounted until a store lands.
 *
 * ## Data (§3.2 — the landed stores, never a self-fetch)
 *
 *   Theme    the `user_settings` side store's `theme` column via
 *            `loadUserSettings`/`saveUserSettings` (api/services/
 *            user-settings.ts — the user settings update family; migration
 *            0008). Upstream keeps the same value on the `user` row
 *            (user_service.UpdateOptions.Theme, profile.go:361-368); the
 *            PATCH route (PATCH /user/settings) writes the identical
 *            column, so the two surfaces agree by construction.
 *   Language the same side store's `language` column (upstream
 *            UpdateOptions.Language). Upstream defaults every user to
 *            Language "" (the server default locale); the side store's
 *            default matches (DEFAULT_USER_SETTINGS).
 *   AllThemes upstream discovers themes by scanning the built assets for
 *            `theme-*.css` and parsing each file's `gitea-theme-meta-info`
 *            block (services/webtheme/webtheme.go loadThemesFromAssets,
 *            default `[ui] THEMES` unset = every found file). The served
 *            frontend IS the official Gitea build at the pin, whose nine
 *            theme files (web_src/css/themes/) carry the meta values in
 *            AVAILABLE_THEMES below, in webtheme.go's sort order (default
 *            theme first, then colorblind type, then display name). The
 *            table is static per pin — an asset-driven re-scan would only
 *            swap the table's source, not the validation shape
 *            (GetThemeMetaInfo(form.Theme) == nil → theme_update_error).
 *   AllLangs upstream `setting.Langs`/`Names` defaults (modules/setting/
 *            i18n.go defaultI18nLangNames — 28 lang/name pairs; the pin's
 *            options/locale ships exactly those 28 JSON files).
 *
 * ## DOM contract (templates/user/settings/{appearance,layout_head,navbar}.
 *  tmpl at the pin)
 *
 * layout_head's pageClass is the literal `user settings` (appearance.tmpl:1's
 * dict — NOT "user settings appearance"); navbar + `.flex-container-main` +
 * `.user-setting-content` wrapping the sections: each is the
 * `h4.ui.top.attached.header` (settings.manage_themes / settings.language)
 * over the `.ui.attached.segment` carrying the form.
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The hidden-comment-types section (appearance.tmpl:62-160) is UNRENDERED:
 *   no landed store (the mount record's hidden_comments arm). Upstream's 14
 *   checkbox groups (reference/label/milestone/assignee/title/branch/
 *   time_tracking/deadline/dependency/lock/review_request/pull_request_push/
 *   project/issue_ref → the big.Int bitset, forms/user_form_hidden_comments.go)
 *   and the settings.hidden_comment_types* strings land with the store.
 * - The Fomantic `ui selection dropdown`s reduce to native `<select>`s (the
 *   repo-fork/new-issue reduction): the theme dropdown's hidden input +
 *   JS menu becomes `<select name="theme">`, options = the nine themes
 *   (value = internal name; colorblind variants carry their
 *   GetDescription() text after the shared display name — three options
 *   per base share "Auto"/"Dark"/"Light" upstream, distinguished by the
 *   extra icon + description). The colorblind extra icons
 *   (gitea-colorblind-redgreen/blueyellow) are not in the icon allowlist —
 *   the description text is the no-JS carrier. The language dropdown
 *   (id="language", upstream's own id) becomes `<select id="language"
 *   name="language">` with an empty-value first option (upstream's hidden
 *   input carries "" for the never-set user; the empty .text div renders
 *   nothing).
 * - A stored theme/language outside the catalog renders as an extra
 *   selected option (upstream's hidden input keeps the raw value the same
 *   way); submitting it answers theme_update_error /
 *   update_language_not_found exactly as upstream's validation does — the
 *   stored value is never silently rewritten.
 * - The success flashes (settings.theme_update_success /
 *   settings.update_language_success) never render — no session-flash
 *   plumbing exists (the keys-module reduction); the error flashes render
 *   inline in the submitting form (the `ui negative message` line, the
 *   keys-module RenderWithErrDeprecated analog).
 * - The theme_desc field's GitHub themes link
 *   (https://github.com/go-gitea/gitea/blob/main/web_src/css/themes/ with
 *   the settings.theme_colorblindness_prompt tooltip) renders upstream's
 *   literal external anchor — not an app-internal dead link.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { loadUserSettings, saveUserSettings } from "../../api/services/user-settings";
import { users } from "../../db/schema";
import { UserSettingsNavbar } from "../components/settings-nav";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const userSettingsAppearanceLocale = {
  appearance: "Appearance", // "settings.appearance" (the Title + the shared navbar item)
  manage_themes: "Select default theme", // "settings.manage_themes"
  theme_desc: "This will be your default theme across the site.", // "settings.theme_desc"
  theme_colorblindness_prompt:
    "Gitea only has a few themes with basic color blindness support, which only have a few colors defined. The work is still in progress. More improvements could be made by defining more colors in the theme CSS files.", // "settings.theme_colorblindness_prompt"
  theme_colorblindness_help: "Color blindness Theme Support", // "settings.theme_colorblindness_help"
  ui: "Theme", // "settings.ui" (the theme field label)
  update_theme: "Update Theme", // "settings.update_theme"
  language: "Language", // "settings.language" (the section header)
  update_language: "Update Language", // "settings.update_language"
  // The write-path messages the apply functions answer (upstream flash
  // error texts — the handler renders the `error` line with them).
  theme_update_error: "The selected theme does not exist.", // "settings.theme_update_error"
  update_language_not_found: `Language "%s" is not available.`, // "settings.update_language_not_found" (%s = the lang)
} as const;

// ---------------------------------------------------------------------------
// The theme catalog (upstream GetAvailableThemes at default config — see the
// header's Data section; sort order is webtheme.go's: the default theme
// first, then colorblind type ascending, then display name)
// ---------------------------------------------------------------------------

export interface AppearanceThemeMeta {
  /** The stored value (the theme CSS file's internal name). */
  internalName: string;
  /** `--theme-display-name` from the file's meta-info block. */
  displayName: string;
  /** GetDescription() — the colorblind-friendliness line, null for the
   *  three base themes. */
  description: string | null;
}

export const AVAILABLE_THEMES: readonly AppearanceThemeMeta[] = [
  { internalName: "gitea-auto", displayName: "Auto", description: null }, // theme-gitea-auto.css (the default theme — sorts first)
  { internalName: "gitea-dark", displayName: "Dark", description: null }, // theme-gitea-dark.css
  { internalName: "gitea-light", displayName: "Light", description: null }, // theme-gitea-light.css
  { internalName: "gitea-auto-tritanopia", displayName: "Auto", description: "Blue-yellow colorblind friendly" }, // --theme-colorblind-type: "blue-yellow"
  { internalName: "gitea-dark-tritanopia", displayName: "Dark", description: "Blue-yellow colorblind friendly" },
  { internalName: "gitea-light-tritanopia", displayName: "Light", description: "Blue-yellow colorblind friendly" },
  { internalName: "gitea-auto-protanopia-deuteranopia", displayName: "Auto", description: "Red-green colorblind friendly" }, // "red-green"
  { internalName: "gitea-dark-protanopia-deuteranopia", displayName: "Dark", description: "Red-green colorblind friendly" },
  { internalName: "gitea-light-protanopia-deuteranopia", displayName: "Light", description: "Red-green colorblind friendly" },
];

/** The UI language catalog — upstream `setting.Langs`/`Names` defaults
 *  (modules/setting/i18n.go defaultI18nLangNames, in its order; the pin's
 *  options/locale ships exactly these 28 files). */
export const AVAILABLE_LANGUAGES: readonly { lang: string; name: string }[] = [
  { lang: "en-US", name: "English" },
  { lang: "zh-CN", name: "简体中文" },
  { lang: "zh-HK", name: "繁體中文（香港）" },
  { lang: "zh-TW", name: "繁體中文（台灣）" },
  { lang: "de-DE", name: "Deutsch" },
  { lang: "fr-FR", name: "Français" },
  { lang: "ga-IE", name: "Gaeilge" },
  { lang: "nl-NL", name: "Nederlands" },
  { lang: "lv-LV", name: "Latviešu" },
  { lang: "ru-RU", name: "Русский" },
  { lang: "uk-UA", name: "Українська" },
  { lang: "ja-JP", name: "日本語" },
  { lang: "es-ES", name: "Español" },
  { lang: "pt-BR", name: "Português do Brasil" },
  { lang: "pt-PT", name: "Português de Portugal" },
  { lang: "pl-PL", name: "Polski" },
  { lang: "bg-BG", name: "Български" },
  { lang: "it-IT", name: "Italiano" },
  { lang: "fi-FI", name: "Suomi" },
  { lang: "tr-TR", name: "Türkçe" },
  { lang: "cs-CZ", name: "Čeština" },
  { lang: "sv-SE", name: "Svenska" },
  { lang: "ko-KR", name: "한국어" },
  { lang: "el-GR", name: "Ελληνικά" },
  { lang: "fa-IR", name: "فارسی" },
  { lang: "hu-HU", name: "Magyar nyelv" },
  { lang: "id-ID", name: "Bahasa Indonesia" },
  { lang: "ml-IN", name: "മലയാളം" },
];

// ---------------------------------------------------------------------------
// The page data (upstream Appearance's AllThemes + SignedUser.{Theme,Language}
// over the landed side store)
// ---------------------------------------------------------------------------

/** The appearance tab's render inputs: the stored preferences. */
export interface UserSettingsAppearancePageData {
  theme: string;
  language: string;
}

/**
 * The page load: the users-row gate read first (null = the session doer has
 * no D1 row — the silent-auth-failure 404 input, the
 * loadUserSettingsPageData slice), then the side store (an absent
 * `user_settings` row renders DEFAULT_USER_SETTINGS — theme "gitea-auto",
 * language "").
 */
export async function loadUserSettingsAppearancePageData(d1: D1Database, userId: number): Promise<UserSettingsAppearancePageData | null> {
  // The two reads are independent (PK lookups on different tables) — issue
  // them concurrently; the serial depth cost is the F1 latency finding
  // (the profile tab's twin landed the same shape).
  const [row, settings] = await Promise.all([
    drizzle(d1).select({ id: users.id }).from(users).where(eq(users.id, userId)).get(),
    loadUserSettings(d1, userId),
  ]);
  if (row === undefined) return null;
  return { theme: settings.theme, language: settings.language };
}

// ---------------------------------------------------------------------------
// The write arms (upstream UpdateUIThemePost / UpdateUserLang over the landed
// saveUserSettings)
// ---------------------------------------------------------------------------

/** The theme POST body (upstream forms.UpdateThemeForm — `theme` Required;
 *  the MaxSize(255) limit is accepted-and-ignored, the profile-page
 *  binding-limits note). */
export interface UserSettingsAppearanceThemeForm {
  theme: string;
}

/** Parse the urlencoded theme POST (the readUrlEncodedForm convention). */
export function parseUserSettingsAppearanceThemeForm(params: URLSearchParams): UserSettingsAppearanceThemeForm {
  return { theme: params.get("theme") ?? "" };
}

/** The language POST body (upstream forms.UpdateLanguageForm — no Required
 *  binding: empty is legal and stores "" = the server default). */
export interface UserSettingsAppearanceLanguageForm {
  language: string;
}

/** Parse the urlencoded language POST. */
export function parseUserSettingsAppearanceLanguageForm(params: URLSearchParams): UserSettingsAppearanceLanguageForm {
  return { language: params.get("language") ?? "" };
}

/** The theme POST outcomes (`invalid` re-renders with the message in the
 *  theme form's negative message line). */
export type AppearanceThemeOutcome = { outcome: "saved" } | { outcome: "invalid"; message: string };

/**
 * The theme write — upstream UpdateUIThemePost (profile.go:349-376): the
 * Required binder arm first (the binder's "Theme: Required" spelling), the
 * catalog check (webtheme.GetThemeMetaInfo nil → theme_update_error), then
 * the store write (UpdateOptions.Theme). The success flash never renders
 * (the no-flash reduction) — "saved" means the 303.
 */
export async function applyUserSettingsAppearanceThemeForm(d1: D1Database, userId: number, form: UserSettingsAppearanceThemeForm): Promise<AppearanceThemeOutcome> {
  if (form.theme === "") {
    return { outcome: "invalid", message: "Theme: Required" };
  }
  if (!AVAILABLE_THEMES.some((theme) => theme.internalName === form.theme)) {
    return { outcome: "invalid", message: userSettingsAppearanceLocale.theme_update_error };
  }
  await saveUserSettings(d1, userId, { theme: form.theme });
  return { outcome: "saved" };
}

/** The language POST outcomes. */
export type AppearanceLanguageOutcome = { outcome: "saved" } | { outcome: "invalid"; message: string };

/**
 * The language write — upstream UpdateUserLang (profile.go:379-407): empty
 * passes and stores "" (upstream's `if form.Language != ""` guard), a
 * non-member answers update_language_not_found with the quoted lang, a
 * member stores. The SetLocaleCookie arm is NOT ported (the header's
 * reduction).
 */
export async function applyUserSettingsAppearanceLanguageForm(d1: D1Database, userId: number, form: UserSettingsAppearanceLanguageForm): Promise<AppearanceLanguageOutcome> {
  if (form.language !== "" && !AVAILABLE_LANGUAGES.some((entry) => entry.lang === form.language)) {
    return { outcome: "invalid", message: userSettingsAppearanceLocale.update_language_not_found.replace("%s", form.language) };
  }
  await saveUserSettings(d1, userId, { language: form.language });
  return { outcome: "saved" };
}

// ---------------------------------------------------------------------------
// The render (templates/user/settings/appearance.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The failed POST's re-render routing: `form` picks the negative message
 *  line (the keys-module `kind` convention). */
export type AppearancePageError = { form: "theme" | "language"; message: string };

/** The settings navbar: the SHARED components/settings-nav UserSettingsNavbar
 *  (the wave-114 swap — the local six-item copy deleted; the shared
 *  component carries the whole landed family in navbar.tmpl's order). */

/** The full-document render (the render.tsx pattern). `error` carries the
 *  failed POST's outcome (null on the plain GET). */
export function renderUserSettingsAppearancePage(ctx: UiContext, data: UserSettingsAppearancePageData, error: AppearancePageError | null = null): string {
  return renderPage(<UserSettingsAppearancePage ctx={ctx} data={data} error={error} />);
}

/** The appearance page (§2.4.1 discriminator: the literal `user settings` —
 *  appearance.tmpl:1's pageClass dict). */
export function UserSettingsAppearancePage(props: { ctx: UiContext; data: UserSettingsAppearancePageData; error: AppearancePageError | null }) {
  const { ctx, data } = props;
  const themeError = props.error?.form === "theme" ? props.error : null;
  const languageError = props.error?.form === "language" ? props.error : null;
  // A stored value outside the catalog renders as an extra selected option
  // (the header's unknown-stored-value arm — submitting it answers the
  // upstream validation error verbatim; it is never silently rewritten).
  const storedThemeKnown = AVAILABLE_THEMES.some((theme) => theme.internalName === data.theme);
  const storedLanguageKnown = data.language === "" || AVAILABLE_LANGUAGES.some((entry) => entry.lang === data.language);
  return (
    <BaseLayout ctx={ctx} title={userSettingsAppearanceLocale.appearance} pageClass="user settings">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="appearance" />
        <div class="flex-container-main">
          <div class="user-setting-content">
            {/* ------------------------------------------------ Theme (appearance.tmpl:4-36) */}
            <h4 class="ui top attached header">{userSettingsAppearanceLocale.manage_themes}</h4>
            <div class="ui attached segment">
              <form class="ui form" action="/user/settings/appearance/theme" method="post">
                {themeError !== null ? <div class="ui negative message">{themeError.message}</div> : null}
                <div class="field">
                  {userSettingsAppearanceLocale.theme_desc}{" "}
                  {/* The literal GitHub themes link — an external anchor,
                      not an app-internal dead link (the header). */}
                  <a
                    class="muted"
                    target="_blank"
                    href="https://github.com/go-gitea/gitea/blob/main/web_src/css/themes/"
                    data-tooltip-content={userSettingsAppearanceLocale.theme_colorblindness_prompt}
                  >
                    <Icon name="octicon-question" /> {userSettingsAppearanceLocale.theme_colorblindness_help}
                  </a>
                </div>
                <div class="field">
                  <label>{userSettingsAppearanceLocale.ui}</label>
                  {/* The Fomantic dropdown's hidden input reduces to the
                      native select (the repo-fork reduction). Upstream's
                      label carries no for= — the hidden input could not
                      take one. */}
                  <select name="theme" class="ui selection dropdown">
                    {!storedThemeKnown && data.theme !== "" ? <option value={data.theme} selected>{data.theme}</option> : null}
                    {AVAILABLE_THEMES.map((theme) => (
                      <option
                        value={theme.internalName}
                        selected={data.theme === theme.internalName}
                      >
                        {theme.description === null ? theme.displayName : `${theme.displayName} — ${theme.description}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div class="field">
                  <button type="submit" class="ui primary button">
                    {userSettingsAppearanceLocale.update_theme}
                  </button>
                </div>
              </form>
            </div>
            {/* --------------------------------------------- Language (appearance.tmpl:38-60) */}
            <h4 class="ui top attached header">{userSettingsAppearanceLocale.language}</h4>
            <div class="ui attached segment">
              <form class="ui form" action="/user/settings/appearance/language" method="post">
                {languageError !== null ? <div class="ui negative message">{languageError.message}</div> : null}
                <div class="field">
                  {/* Upstream's own id="language" on the dropdown; the
                      leading empty option is the never-set user's "" value
                      (the header's dropdown reduction). */}
                  <select id="language" name="language" class="ui language selection dropdown">
                    {!storedLanguageKnown ? <option value={data.language} selected>{data.language}</option> : null}
                    <option value="" selected={data.language === ""}></option>
                    {AVAILABLE_LANGUAGES.map((entry) => (
                      <option value={entry.lang} selected={data.language === entry.lang}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div class="field">
                  <button type="submit" class="ui primary button">
                    {userSettingsAppearanceLocale.update_language}
                  </button>
                </div>
              </form>
            </div>
            {/* ----------------------- Hidden comment types (appearance.tmpl:62-160): UNRENDERED
                — no landed store (the header's reductions + the mount record's
                hidden_comments arm). */}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

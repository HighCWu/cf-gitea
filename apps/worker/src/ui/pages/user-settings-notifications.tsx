/**
 * The user settings NOTIFICATIONS tab, `/user/settings/notifications` — the
 * preference-matrix wave (bench row `wave-settings-notifications`, TWO-STAGE
 * UNMOUNTED — the route rides the index.ts window; `index.ts` is
 * orchestrator/sibling-owned). specs/user-notification-settings.md is this
 * module's SPEC.
 *
 * PREMISE VERIFIED: at the pin (fc49368, 2026-10-24) the routes are
 * web.go:653-657 — `m.Get("", Notifications)`,
 * `m.Post("/email", NotificationsEmailPost)`,
 * `m.Post("/actions", NotificationsActionsEmailPost)` — all in
 * routers/web/user/setting/notifications.go (the whole file, :21-39 /
 * :42-66 / :69-89), rendering templates/user/settings/notifications.tmpl.
 * The stored shape at this pin is TWO preferences (older Gitea's
 * `User.NotificationConfig` struct does not exist here — verified by
 * grep): the four-value email preference on the
 * `users.email_notifications_preference` column (user.go:103, default
 * 'enabled' via DEFAULT_EMAIL_NOTIFICATIONS, admin.go:32) and the
 * three-value Gitea Actions preference in the `user_setting` KV under
 * `email_notification.gitea_actions` (setting_options.go:21-24, default
 * 'failure-only'). Both halves land in the `user_settings` side store's
 * two new columns (migration 0034) behind
 * api/services/user-notification-prefs.ts — the SPEC §4 rationale.
 *
 * ## HANDOFF NOTE (for the wiring wave)
 *
 * Three diffs, all in shared files this wave does not own:
 *
 *   1. ui/index.ts — the route recipes (the userSettingsTabPrologue pair,
 *      the appearance handlers' exact shape — GET without the origin
 *      guard, POSTs with sameOriginGuard first; anonymous 303s onto the
 *      login round-trip; a session viewer without a D1 users row
 *      404-shells the render arms):
 *
 *        GET  /user/settings/notifications
 *          → userSettingsTabPrologue(c, false)
 *          → loadUserSettingsNotificationsPageData(c.env.DB, p.viewer.id)
 *          → null 404-shells (renderNotFound) →
 *            p.respond(c.html(renderUserSettingsNotificationsPage(p.ctx, data), 200))
 *        POST /user/settings/notifications/email
 *          → userSettingsTabPrologue(c, true) →
 *            readUrlEncodedForm → parseUserSettingsNotificationsEmailForm
 *            → applyUserSettingsNotificationsEmailForm.
 *            `saved` 303s onto `/user/settings/notifications` (upstream's
 *            redirect; the success flash
 *            settings.email_preference_set_success never renders — no
 *            session-flash plumbing, the appearance reduction). `invalid`
 *            re-renders the FULL page at 200 with
 *            { form: "email", message } — the upstream
 *            Flash.Error(Tr("invalid_data", preference)) + redirect arm
 *            reduced (the keys-module RenderWithErrDeprecated analog).
 *        POST /user/settings/notifications/actions
 *          → the same prologue with parseUserSettingsNotificationsActionsForm
 *            + applyUserSettingsNotificationsActionsForm; the error routes
 *            as { form: "actions", message }. Upstream's
 *            Actions.Enabled/UnitGlobalDisabled 404 gate (notifications.go:70)
 *            reduces to always-mounted — the Actions family (user secrets/
 *            variables) is unconditionally mounted here (the SPEC §3).
 *        Upstream's EnableNotifyMail 404 gate on ALL THREE routes
 *        (notifications.go:22,43) likewise reduces to always-mounted —
 *        no mailer, no service-config registry (the SPEC §3).
 *
 *      Plus the index.ts plumbing the window owns: the
 *      `UserSettingsTabRoute.family` union gains
 *      "user-settings-notifications" | "user-settings-notifications-email"
 *      | "user-settings-notifications-actions" (the exact literals, `id:
 *      null`), parseUiRoute claims them ahead of the repo parse (the
 *      appearance families' registration), the three handlers register,
 *      and the module's exports join the appearance block's import list.
 *
 *   2. ui/components/settings-nav.tsx — the nav item diff (NEVER applied by
 *      this wave): `UserSettingsNavTab` gains `| "notifications"`, and the
 *      USER navbar inserts the item between Profile and Appearance —
 *      upstream navbar.tmpl:12-16, EnableNotifyMail-gated (always-on here,
 *      the SPEC §3 reduction):
 *
 *          [jsx comment: navbar.tmpl:12-16 — the notifications tab]
 *          <a class={item("notifications")} href="/user/settings/notifications">
 *            {settingsNavLocale.notifications}
 *          </a>
 *
 *      with `settingsNavLocale` gaining `notifications: "Notifications"`
 *      (the "notifications" key — the item's Tr text). LANDED in the mount
 *      window: the shared nav carries the item and this module renders
 *      `UserSettingsNavbar active="notifications"` (the module-local
 *      scaffolding nav was DELETED — the shared nav's own swap list,
 *      entries 9/12/13).
 *
 *   3. The deferred route test matrix (the appearance/organizations
 *      pattern — this wave's test file is module-direct because the
 *      routes are unmounted at its gates): anonymous login 303 on GET and
 *      both POSTs; the two exact saved 303 targets
 *      (/user/settings/notifications); the invalid re-render's per-form
 *      error routing through the real handlers; the guard-first
 *      cross-origin 403; the nav-swap assertion (the item renders exactly
 *      once, marked active).
 *
 * ## Data (§4 — the landed stores, never a self-fetch)
 *
 *   Email pref   the `user_settings` side store's
 *                `email_notifications_preference` column (upstream keeps
 *                it on the `users` row — user.go:103 — the side-store
 *                reduction, SPEC §4).
 *   Actions pref the same store's `actions_email_notifications_preference`
 *                column (upstream: the user_setting KV row,
 *                setting_options.go:21).
 *   Both behind api/services/user-notification-prefs.ts (targeted upserts;
 *                the non-clobbering proof is that module's header).
 *
 * ## DOM contract (templates/user/settings/notifications.tmpl +
 *  user/settings/{layout_head,navbar}.tmpl at the pin)
 *
 * layout_head's pageClass is the literal `user settings`; navbar +
 * `.flex-container-main` + `.user-setting-content` wrapping TWO sections,
 * each the `h4.ui.top.attached.header` over the `.ui.attached.segment`
 * carrying one form: the email form (header Tr "notifications", description
 * settings.email_desc, POST `/user/settings/notifications/email`) and the
 * actions form (header Tr "actions.actions" = "Actions", description
 * settings.email_notifications.actions.desc with its external docs link,
 * POST `/user/settings/notifications/actions`). Upstream renders the
 * actions section only under `.EnableActions` — always here (above). Both
 * dropdowns carry `name="preference"`.
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The Fomantic `ui selection dropdown`s reduce to native `<select
 *   name="preference">`s (the appearance-module reduction); the hidden
 *   input + JS menu become the select's options in the template's order.
 * - A stored value outside the catalog renders as an extra selected option
 *   (upstream's hidden input keeps the raw value the same way); submitting
 *   it answers the invalid arm verbatim — never silently rewritten.
 * - The success flashes never render (no session-flash plumbing — the
 *   keys-module reduction); the error flashes render inline in the
 *   submitting form (the `ui negative message` line).
 * - The actions description's locale-embedded anchor
 *   (<a href="https://docs.gitea.com/usage/actions/overview/">Gitea
 *   Actions</a>) renders as the literal external anchor (the
 *   appearance-module GitHub-link pattern) — not an app-internal link.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  ACTIONS_EMAIL_NOTIFICATION_PREFERENCES,
  EMAIL_NOTIFICATION_PREFERENCES,
  loadUserNotificationPrefs,
  saveActionsEmailNotificationsPreference,
  saveEmailNotificationsPreference,
  type ActionsEmailNotificationsPreference,
  type EmailNotificationsPreference,
} from "../../api/services/user-notification-prefs";
import { users } from "../../db/schema";
import { UserSettingsNavbar } from "../components/settings-nav";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const userSettingsNotificationsLocale = {
  notifications: "Notifications", // "notifications" (the Title, the email section header, the nav item's text)
  actions: "Actions", // "actions.actions" (the actions section header, notifications.tmpl:38)
  email_desc: "Your primary email address will be used for notifications, password recovery and, provided that it is not hidden, web-based Git operations.", // "settings.email_desc"
  actions_desc_prefix: "Notifications for workflow runs on repositories set up with ", // "settings.email_notifications.actions.desc" (the text before the embedded anchor)
  actions_desc_link_text: "Gitea Actions", // the locale string's embedded <a> text; href = https://docs.gitea.com/usage/actions/overview/ (the template's %s argument)
  actions_desc_suffix: ".", // the locale string's trailing period after the anchor
  submit: "Set Email Preference", // "settings.email_notifications.submit" (both forms' button)
  // The option labels — the email four (notifications.tmpl:18-21) and the
  // actions three (:48-50), keyed by their stored values.
  email_labels: {
    enabled: "Enable Email Notifications", // "settings.email_notifications.enable"
    andyourown: "And Your Own Notifications", // "settings.email_notifications.andyourown"
    onmention: "Only Email on Mention and Custom Watches", // "settings.email_notifications.onmention_and_custom"
    disabled: "Disable Email Notifications", // "settings.email_notifications.disable"
  },
  actions_labels: {
    all: "All", // "all"
    "failure-only": "Only notify for failed workflow runs", // "settings.email_notifications.actions.failure_only"
    disabled: "Disabled", // "disabled"
  },
  // The write-path message the apply functions answer (upstream's flash
  // error text — the handler renders the `error` line with it).
  invalid_data: `Invalid data: %v`, // "invalid_data" (%v = the raw preference)
} as const;

/** The invalid-preference message — upstream Tr("invalid_data", preference)
 *  (notifications.go:53,80) with the raw form value interpolated. */
export function invalidDataMessage(preference: string): string {
  return userSettingsNotificationsLocale.invalid_data.replace("%v", preference);
}

// Re-exported for the wiring wave's route tests (the catalogs are the
// apply arms' validators — importing them from the service keeps one
// source of truth with the schema's enum sets).
export { ACTIONS_EMAIL_NOTIFICATION_PREFERENCES, EMAIL_NOTIFICATION_PREFERENCES };

// ---------------------------------------------------------------------------
// The page data (upstream Notifications' template data over the side store)
// ---------------------------------------------------------------------------

/** The notifications tab's render inputs: the two stored preferences. */
export interface UserSettingsNotificationsPageData {
  emailNotificationsPreference: EmailNotificationsPreference;
  actionsEmailNotificationsPreference: ActionsEmailNotificationsPreference;
}

/**
 * The page load: the users-row gate read first (null = the session doer has
 * no D1 row — the silent-auth-failure 404 input, the
 * loadUserSettingsAppearancePageData slice), then the side store (an absent
 * `user_settings` row renders upstream's creation defaults — 'enabled' /
 * 'failure-only', the service's DEFAULT constants).
 */
export async function loadUserSettingsNotificationsPageData(d1: D1Database, userId: number): Promise<UserSettingsNotificationsPageData | null> {
  const row = await drizzle(d1).select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (row === undefined) return null;
  const prefs = await loadUserNotificationPrefs(d1, userId);
  return {
    emailNotificationsPreference: prefs.emailNotificationsPreference,
    actionsEmailNotificationsPreference: prefs.actionsEmailNotificationsPreference,
  };
}

// ---------------------------------------------------------------------------
// The write arms (upstream NotificationsEmailPost :42-66 /
// NotificationsActionsEmailPost :69-89 over the landed prefs service)
// ---------------------------------------------------------------------------

/** Either POST body (upstream reads the single `preference` form field,
 *  notifications.go:48,75 — no binding struct). */
export interface UserSettingsNotificationsPreferenceForm {
  preference: string;
}

/** Parse the urlencoded POST (the readUrlEncodedForm convention); an absent
 *  field parses as "" (which fails both catalogs — the invalid arm). */
export function parseUserSettingsNotificationsEmailForm(params: URLSearchParams): UserSettingsNotificationsPreferenceForm {
  return { preference: params.get("preference") ?? "" };
}

/** Parse the urlencoded actions POST (the same single field — the two arms
 *  are distinguished by their routes, as upstream). */
export function parseUserSettingsNotificationsActionsForm(params: URLSearchParams): UserSettingsNotificationsPreferenceForm {
  return { preference: params.get("preference") ?? "" };
}

/** The email POST outcomes (`invalid` re-renders with the message in the
 *  email form's negative message line; `saved` is the wiring wave's 303). */
export type NotificationsEmailOutcome = { outcome: "saved" } | { outcome: "invalid"; message: string };

/**
 * The email write — upstream NotificationsEmailPost: the exact-match
 * membership check against the four constants (case-sensitive Go string
 * comparison), invalid → the invalid_data message and NOTHING stored,
 * valid → the store write. The success flash never renders (the no-flash
 * reduction) — "saved" means the 303.
 */
export async function applyUserSettingsNotificationsEmailForm(d1: D1Database, userId: number, form: UserSettingsNotificationsPreferenceForm): Promise<NotificationsEmailOutcome> {
  if (!EMAIL_NOTIFICATION_PREFERENCES.some((value) => value === form.preference)) {
    return { outcome: "invalid", message: invalidDataMessage(form.preference) };
  }
  await saveEmailNotificationsPreference(d1, userId, form.preference as EmailNotificationsPreference);
  return { outcome: "saved" };
}

/** The actions POST outcomes (the same contract against the actions
 *  catalog). */
export type NotificationsActionsOutcome = { outcome: "saved" } | { outcome: "invalid"; message: string };

/**
 * The actions write — upstream NotificationsActionsEmailPost: membership
 * against the three actions constants (a valid EMAIL value like "enabled"
 * is invalid HERE — the catalogs are disjoint), then the store write.
 */
export async function applyUserSettingsNotificationsActionsForm(d1: D1Database, userId: number, form: UserSettingsNotificationsPreferenceForm): Promise<NotificationsActionsOutcome> {
  if (!ACTIONS_EMAIL_NOTIFICATION_PREFERENCES.some((value) => value === form.preference)) {
    return { outcome: "invalid", message: invalidDataMessage(form.preference) };
  }
  await saveActionsEmailNotificationsPreference(d1, userId, form.preference as ActionsEmailNotificationsPreference);
  return { outcome: "saved" };
}

// ---------------------------------------------------------------------------
// The render (templates/user/settings/notifications.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The failed POST's re-render routing: `form` picks the negative message
 *  line (the keys-module `kind` convention). */
export type NotificationsPageError = { form: "email" | "actions"; message: string };

/** The full-document render (the render.tsx pattern). `error` carries the
 *  failed POST's outcome (null on the plain GET). */
export function renderUserSettingsNotificationsPage(ctx: UiContext, data: UserSettingsNotificationsPageData, error: NotificationsPageError | null = null): string {
  return renderPage(<UserSettingsNotificationsPage ctx={ctx} data={data} error={error} />);
}

/** The notifications page (§2.4.1 discriminator: the literal `user settings`
 *  — layout_head's pageClass dict). */
export function UserSettingsNotificationsPage(props: { ctx: UiContext; data: UserSettingsNotificationsPageData; error: NotificationsPageError | null }) {
  const { ctx, data } = props;
  const emailError = props.error?.form === "email" ? props.error : null;
  const actionsError = props.error?.form === "actions" ? props.error : null;
  // A stored value outside the catalog renders as an extra selected option
  // (the header's unknown-stored-value arm — submitting it answers the
  // upstream validation error verbatim; it is never silently rewritten).
  const storedEmailKnown = EMAIL_NOTIFICATION_PREFERENCES.some((value) => value === data.emailNotificationsPreference);
  const storedActionsKnown = ACTIONS_EMAIL_NOTIFICATION_PREFERENCES.some((value) => value === data.actionsEmailNotificationsPreference);
  return (
    <BaseLayout ctx={ctx} title={userSettingsNotificationsLocale.notifications} pageClass="user settings">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="notifications" />
        <div class="flex-container-main">
          <div class="user-setting-content">
            {/* ----------------------------------------- Email preference (notifications.tmpl:4-36) */}
            <h4 class="ui top attached header">{userSettingsNotificationsLocale.notifications}</h4>
            <div class="ui attached segment">
              <form class="ui form" action="/user/settings/notifications/email" method="post">
                {emailError !== null ? <div class="ui negative message">{emailError.message}</div> : null}
                <div class="field">
                  <label>{userSettingsNotificationsLocale.email_desc}</label>
                  {/* The Fomantic dropdown's hidden input reduces to the
                      native select (the appearance-module reduction);
                      option order is the template's. */}
                  <select name="preference" class="ui selection dropdown">
                    {!storedEmailKnown ? <option value={data.emailNotificationsPreference} selected>{data.emailNotificationsPreference}</option> : null}
                    {EMAIL_NOTIFICATION_PREFERENCES.map((value) => (
                      <option value={value} selected={data.emailNotificationsPreference === value}>
                        {userSettingsNotificationsLocale.email_labels[value]}
                      </option>
                    ))}
                  </select>
                </div>
                <div class="field">
                  <button type="submit" class="ui primary button">
                    {userSettingsNotificationsLocale.submit}
                  </button>
                </div>
              </form>
            </div>
            {/* ----------------- Actions email preference (notifications.tmpl:37-64, .EnableActions always-on here) */}
            <h4 class="ui top attached header">{userSettingsNotificationsLocale.actions}</h4>
            <div class="ui attached segment">
              <form class="ui form" action="/user/settings/notifications/actions" method="post">
                {actionsError !== null ? <div class="ui negative message">{actionsError.message}</div> : null}
                <div class="field">
                  <label>
                    {/* The locale string's embedded anchor renders as the
                        literal external docs link (the appearance-module
                        GitHub-link pattern). */}
                    {userSettingsNotificationsLocale.actions_desc_prefix}
                    <a class="muted" target="_blank" href="https://docs.gitea.com/usage/actions/overview/">
                      {userSettingsNotificationsLocale.actions_desc_link_text}
                    </a>
                    {userSettingsNotificationsLocale.actions_desc_suffix}
                  </label>
                  <select name="preference" class="ui selection dropdown">
                    {!storedActionsKnown ? <option value={data.actionsEmailNotificationsPreference} selected>{data.actionsEmailNotificationsPreference}</option> : null}
                    {ACTIONS_EMAIL_NOTIFICATION_PREFERENCES.map((value) => (
                      <option value={value} selected={data.actionsEmailNotificationsPreference === value}>
                        {userSettingsNotificationsLocale.actions_labels[value]}
                      </option>
                    ))}
                  </select>
                </div>
                <div class="field">
                  <button type="submit" class="ui primary button">
                    {userSettingsNotificationsLocale.submit}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

# SPEC: User Settings — Notifications tab

Wave: `wave-settings-notifications` (2026-10-27). Upstream pin: `gitea/` at
fc4936884584a41931906553d96c2601d750e6ef (v29.0.0-dev-208).

## 1. Problem and scope

The user settings family has no Notifications tab. Upstream renders
`GET /user/settings/notifications` (template
`templates/user/settings/notifications.tmpl`) as a two-section preference
matrix and exposes two write arms. This SPEC ports the tab over the landed
`user_settings` side store.

**In scope**

- `GET /user/settings/notifications` — the preference matrix page (page
  module `apps/worker/src/ui/pages/user-settings-notifications.tsx`).
- `POST /user/settings/notifications/email` — the primary email-notification
  preference (4 values).
- `POST /user/settings/notifications/actions` — the Gitea Actions email
  preference (3 values).
- Storage: two new columns on the landed `user_settings` side store
  (additive migration 0034) + a new prefs service
  (`apps/worker/src/api/services/user-notification-prefs.ts`).

**Out of scope (reductions, never dead controls)**

- Route/handler wiring in `ui/index.ts` and the SettingsNav item: shared
  files owned by the wiring window — the exact diffs ride the module's
  HANDOFF NOTE. The page module ships with a module-local scaffolding nav
  (the documented mount-scaffolding precedent) that the wiring wave swaps
  for the shared `UserSettingsNavbar` in the same window it applies the nav
  diff.
- The upstream success flashes (`settings.email_preference_set_success`) —
  no session-flash plumbing (the appearance-module reduction); the invalid
  arms render inline instead (below).
- Watch/subscription management: the per-repo watch edges
  (`repo_watchers`) and issue-level subscriptions
  (`notification-subscriptions` module) are LANDED elsewhere — this tab is
  the global preference matrix only.
- Actual email delivery: cf-gitea has no mailer. The preferences are stored
  exactly as upstream stores them so the notification fan-out (when it
  lands) reads the same switches; nothing sends mail today.

## 2. Upstream source of truth (verified at the pin)

- Routes: `gitea/routers/web/web.go:653-657`, inside the signed-in
  `/user/settings` group:
  - `m.Get("", user_setting.Notifications)` → `GET /user/settings/notifications`
  - `m.Post("/email", user_setting.NotificationsEmailPost)` → `POST /user/settings/notifications/email`
  - `m.Post("/actions", user_setting.NotificationsActionsEmailPost)` → `POST /user/settings/notifications/actions`
- Handler: `gitea/routers/web/user/setting/notifications.go` (the whole
  file, 89 lines):
  - `Notifications` (:21-39): 404 unless `setting.Service.EnableNotifyMail`;
    renders `user/settings/notifications` with
    `EmailNotificationsPreference = ctx.Doer.EmailNotificationsPreference`
    and `ActionsEmailNotificationsPreference =
    GetUserSetting(ctx, id, SettingsKeyEmailNotificationGiteaActions,
    SettingEmailNotificationGiteaActionsFailureOnly)`.
  - `NotificationsEmailPost` (:42-66): reads form field `preference`;
    membership check against the four constants; invalid →
    `Flash.Error(Tr("invalid_data", preference))` + 303 redirect back;
    valid → `user.UpdateUser{EmailNotificationsPreference}` + success flash
    + 303 redirect back.
  - `NotificationsActionsEmailPost` (:69-89): gated additionally on
    `setting.Actions.Enabled && !unit.TypeActions.UnitGlobalDisabled()`;
    membership check against the three actions constants; invalid → flash
    error + redirect; valid →
    `SetUserSetting(id, SettingsKeyEmailNotificationGiteaActions, preference)`
    + success flash + redirect.
- **Storage shape at this pin** (the shape changed over versions — older
  Gitea had a `User.NotificationConfig` struct; there is **no**
  `NotificationConfig` anywhere at this pin, verified by grep over
  models/modules/routers):
  - Primary preference: the `users` table column
    `email_notifications_preference VARCHAR(20) NOT NULL DEFAULT 'enabled'`
    (`models/user/user.go:103`); creation default
    `setting.Admin.DefaultEmailNotification` = `"enabled"`
    (`modules/setting/admin.go:32`, user.go:709). Values:
    `enabled` / `onmention` / `disabled` / `andyourown`
    (user.go:84-91).
  - Actions preference: the `user_setting` KV table under key
    `email_notification.gitea_actions`
    (`models/user/setting_options.go:21`), values `all` / `failure-only` /
    `disabled` (:22-24), default `failure-only`.
- Template: `templates/user/settings/notifications.tmpl` — two
  `h4.ui.top.attached.header` + `.ui.attached.segment` sections; each a
  form POSTing `preference` through a Fomantic selection dropdown:
  - email form → `{{AppSubUrl}}/user/settings/notifications/email`, options
    in template order `enabled`, `andyourown`, `onmention`, `disabled`
    (labels `settings.email_notifications.{enable,andyourown,
    onmention_and_custom,disable}`); section header `Tr("notifications")`;
    description `settings.email_desc`.
  - actions form → `.../notifications/actions`, options `all` (`Tr("all")`
    = "All"), `failure-only`, `disabled` ("Disabled"); rendered only when
    `.EnableActions`; description
    `settings.email_notifications.actions.desc` (an external docs link
    baked into the locale string).
- Navbar: `templates/user/settings/navbar.tmpl:12-16` — the Notifications
  item sits between Profile (:4-6) and Appearance (:17-19), gated by the
  same `EnableNotifyMail`.
- Locale strings (options/locale/locale_en-US.json): `notifications` =
  "Notifications"; `settings.email_desc`; the four email labels;
  `settings.email_notifications.submit` = "Set Email Preference";
  `settings.email_notifications.actions.desc` /
  `.actions.failure_only` = "Only notify for failed workflow runs";
  `all` = "All"; `disabled` = "Disabled";
  `settings.email_preference_set_success`; `invalid_data` = "Invalid data: %v".

## 3. API surface (cf-gitea)

Same URLs as upstream, mounted by the wiring wave through
`userSettingsTabPrologue` (the family pattern: GET without the origin
guard, POST with `sameOriginGuard` first; anonymous → login 303; session
viewer without a D1 users row → 404 shell):

- `GET /user/settings/notifications` → `loadUserSettingsNotificationsPageData`
  → `renderUserSettingsNotificationsPage` (200).
- `POST /user/settings/notifications/email` → parse → apply →
  saved: `303` Location `/user/settings/notifications` (upstream's
  redirect; the success flash never renders);
  invalid: re-render the FULL page at 200 with the message in the email
  form's `ui negative message` line (upstream's
  `Flash.Error("Invalid data: <pref>")` + redirect arm, reduced — the
  keys-module `RenderWithErrDeprecated` analog).
- `POST /user/settings/notifications/actions` → same shape; the error
  routes to the actions form's message line.

**Reduction — the EnableNotifyMail gate.** Upstream 404s the whole tab and
hides the nav item unless `[service] ENABLE_NOTIFY_MAIL` (app.example.ini
default **false**). cf-gitea has no mailer and no service-config registry;
the gate reduces to always-enabled (the tab always renders). Documented
divergence: a default upstream install would 404 here.

**Reduction — the Actions gate.** Upstream additionally 404s the actions
section when Actions are globally disabled. The Actions family (org/user
secrets + variables pages) is unconditionally mounted in cf-gitea, so the
`.EnableActions` conditional reduces to always-render (matching the
secrets/variables pages' posture).

**Reduction — the dropdowns.** The Fomantic `ui selection dropdown`s reduce
to native `<select name="preference">` elements (the appearance-module
reduction); a stored value outside the catalog renders as an extra selected
option and submitting it answers the upstream invalid arm verbatim (never
silently rewritten).

## 4. Data model

**Chosen: two additive columns on the landed `userSettings` side store**
(D1 table `user_settings`, `apps/worker/src/db/schema.ts`, migration 0008)
— NOT new columns on `users`, NOT a new table.

| column | drizzle field | type/default | upstream source |
|---|---|---|---|
| `email_notifications_preference` | `emailNotificationsPreference` | TEXT NOT NULL DEFAULT `'enabled'` | `users.email_notifications_preference` (user.go:103) |
| `actions_email_notifications_preference` | `actionsEmailNotificationsPreference` | TEXT NOT NULL DEFAULT `'failure-only'` | `user_setting` KV `email_notification.gitea_actions` (setting_options.go:21-24) |

Why the side store over a `users` column:

1. **Precedent.** The side store is the established home for upstream
   per-user preference fields whose values this port keeps in D1 rather
   than on the hot `users` row (theme, language, diff_view_style,
   hide_email, hide_activity — api/services/user-settings.ts). Upstream
   itself splits these two prefs the same way (users column + KV row); we
   collapse both halves into the one landed store.
2. **Collision safety under concurrency.** `users` is touched by many
   in-flight waves; `user_settings` edits are column-additive and the
   existing service is provably non-interfering:
   `loadUserSettings`/`saveUserSettings` (api/services/user-settings.ts)
   map EXPLICIT columns, so the new columns never enter their merge, and
   the upsert's `onConflictDoUpdate` set only ever contains the five known
   fields — an update cannot clobber the notification prefs, and a
   first-row insert falls back to the column defaults, which equal
   upstream's creation values. Symmetrically, the new prefs service writes
   ONLY its own two columns (same targeted-upsert shape).
3. **One migration, no new FK/cascade surface.** `user_settings` is
   already 1:1 on the user row with `ON DELETE CASCADE` and is
   user-scoped (never deleted by the repo cascade).

Migration: generated drizzle-kit migration **0034** (journal slot taken
after the sibling content-history wave's 0033), two
`ALTER TABLE user_settings ADD COLUMN` statements — SQLite legal with
constant literal defaults; existing rows backfill to upstream's creation
values.

No R2/DO involvement (metadata only, D1 is the source of truth).

## 5. Edge cases, limits, failure modes

- **Absent `user_settings` row** → the service returns upstream's creation
  defaults (`enabled` / `failure-only`) without creating a row (the
  `DEFAULT_USER_SETTINGS` read pattern); the first write upserts.
- **Invalid `preference` value** (not in the catalog, including empty and
  the wrong family's value — e.g. `failure-only` POSTed to the email arm):
  upstream's `invalid_data` message with the raw value interpolated,
  re-rendered inline; nothing is stored.
- **Stored value outside the catalog** (hand-edited D1, future catalog
  change): renders as an extra selected `<option>` (first in the select),
  preserving upstream's hidden-input behavior; POSTing it back answers the
  invalid arm; the value is never silently rewritten.
- **Case sensitivity**: the catalogs are exact-match (upstream compares Go
  string constants); `Enabled` ≠ `enabled` → invalid arm.
- **Concurrent writes**: both arms are single-row targeted upserts on the
  `user_id` PK — last-write-wins per column, no read-modify-write race.
- **The email/actions catalogs are disjoint**: each POST arm validates
  against its own catalog only.
- **Users row missing** (session doer without a D1 row): the loader
  returns null → the route 404-shells (the silent-auth-failure convention)
  — the loader reads the users row as its gate, the prefs read second.

## 6. Testing plan

Module-direct (the module is unmounted at this wave's gates — index.ts and
the nav are the wiring wave's; the route matrix below is deferred to that
window and specified in the module's HANDOFF NOTE):

1. **Loader** over real D1 (generated migrations in `beforeAll`, the
   appearance-module harness): absent row → the creation defaults;
   stored values round-trip; missing users row → null.
2. **Parsers**: `preference` extraction; absent field → `""`.
3. **Apply arms**:
   - email: each of the four valid values persists and answers
     `saved`; `failure-only` (a valid ACTIONS value) and `Enabled`
     (wrong case) and `""` answer invalid with
     `Invalid data: <value>` and store nothing.
   - actions: `all` / `failure-only` / `disabled` persist; `enabled`
     (a valid EMAIL value) answers invalid; store nothing on invalid.
   - cross-column safety: writing one pref leaves the other (and the five
     sibling columns) untouched; a sibling `saveUserSettings` write leaves
     both prefs untouched (the §4.2 non-interference proof, executed).
4. **DOM contract** (hono/jsx `renderToString`, module-driven): the
   `user settings` pageClass; two forms with the exact upstream actions
   (`/user/settings/notifications/email`, `/actions`); each select's
   option set in template order with the stored value selected; the
   section headers/labels/description strings; the invalid re-render
   routes the message to the submitting form's negative message line only.

Deferred to the wiring window (HANDOFF): the anonymous login 303, the two
saved 303 targets, the guard-first cross-origin 403, the nav item swap
assertion.

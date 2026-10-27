import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { userSettings } from "../../db/schema";

/**
 * The user settings NOTIFICATIONS tab's two email preferences
 * (specs/user-notification-settings.md) over the landed `user_settings`
 * side store's two notification columns (migration 0034). Upstream at the
 * pin fc49368 stores the pair split across two places —
 * `users.email_notifications_preference` (models/user/user.go:103,
 * `VARCHAR(20) NOT NULL DEFAULT 'enabled'`) and the `user_setting` KV
 * `email_notification.gitea_actions` (models/user/setting_options.go:21-24)
 * — and this port collapses both halves into the one landed side store, the
 * theme/language precedent (api/services/user-settings.ts's header).
 *
 * Isolation contract (specs/user-notification-settings.md §4.2): this
 * module's writes are TARGETED upserts on the `user_id` PK that set ONLY
 * their own column — a first insert lets the sibling columns fall back to
 * their DDL defaults (which equal upstream's creation values:
 * DEFAULT_USER_SETTINGS + the two defaults below), and a conflict update
 * cannot touch them. Symmetrically api/services/user-settings.ts's
 * loadUserSettings/saveUserSettings map explicit columns, so neither
 * module's write can clobber the other's.
 */

/** Upstream's four email-notification constants — models/user/user.go:84-91
 *  (`EmailNotificationsEnabled` "enabled", `EmailNotificationsAndYourOwn`
 *  "andyourown", `EmailNotificationsOnMention` "onmention",
 *  `EmailNotificationsDisabled` "disabled"), in the settings template's
 *  dropdown order (notifications.tmpl:18-21). */
export const EMAIL_NOTIFICATION_PREFERENCES = ["enabled", "andyourown", "onmention", "disabled"] as const;

/** Upstream's three Gitea Actions email constants — models/user/
 *  setting_options.go:22-24 (`SettingEmailNotificationGiteaActionsAll`
 *  "all", `...FailureOnly` "failure-only", `...Disabled` "disabled"), in
 *  the actions dropdown's template order (notifications.tmpl:48-50). */
export const ACTIONS_EMAIL_NOTIFICATION_PREFERENCES = ["all", "failure-only", "disabled"] as const;

export type EmailNotificationsPreference = (typeof EMAIL_NOTIFICATION_PREFERENCES)[number];
export type ActionsEmailNotificationsPreference = (typeof ACTIONS_EMAIL_NOTIFICATION_PREFERENCES)[number];

/** Upstream's creation default — `setting.Admin.DefaultEmailNotification`
 *  = "enabled" (modules/setting/admin.go:32, applied at user.go:709). */
export const DEFAULT_EMAIL_NOTIFICATIONS_PREFERENCE: EmailNotificationsPreference = "enabled";

/** Upstream's actions KV default — GetUserSetting's `def...` argument in
 *  routers/web/user/setting/notifications.go:31
 *  (`SettingEmailNotificationGiteaActionsFailureOnly`). */
export const DEFAULT_ACTIONS_EMAIL_NOTIFICATIONS_PREFERENCE: ActionsEmailNotificationsPreference = "failure-only";

/** The two stored preferences of one user — the notifications tab's render
 *  inputs (upstream's `EmailNotificationsPreference` +
 *  `ActionsEmailNotificationsPreference` template data). */
export interface UserNotificationPrefs {
  emailNotificationsPreference: EmailNotificationsPreference;
  actionsEmailNotificationsPreference: ActionsEmailNotificationsPreference;
}

/** The stored preferences; an absent `user_settings` row renders upstream's
 *  creation defaults without creating one (the DEFAULT_USER_SETTINGS read
 *  pattern). A row written before migration 0034 reads its backfilled
 *  defaults — the same values. */
export async function loadUserNotificationPrefs(d1: D1Database, userId: number): Promise<UserNotificationPrefs> {
  const row = await drizzle(d1)
    .select({ email: userSettings.emailNotificationsPreference, actions: userSettings.actionsEmailNotificationsPreference })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .get();
  if (row === undefined) {
    return {
      emailNotificationsPreference: DEFAULT_EMAIL_NOTIFICATIONS_PREFERENCE,
      actionsEmailNotificationsPreference: DEFAULT_ACTIONS_EMAIL_NOTIFICATIONS_PREFERENCE,
    };
  }
  return {
    emailNotificationsPreference: row.email,
    actionsEmailNotificationsPreference: row.actions,
  };
}

/** The email-preference write — upstream `NotificationsEmailPost`'s
 *  `user.UpdateUser{EmailNotificationsPreference}` arm
 *  (routers/web/user/setting/notifications.go:57-63) reduced onto the side
 *  store. Targeted upsert: sets ONLY this column (the header's isolation
 *  contract). */
export async function saveEmailNotificationsPreference(
  d1: D1Database,
  userId: number,
  value: EmailNotificationsPreference,
): Promise<void> {
  await drizzle(d1)
    .insert(userSettings)
    .values({ userId, emailNotificationsPreference: value })
    .onConflictDoUpdate({ target: userSettings.userId, set: { emailNotificationsPreference: value } });
}

/** The actions-preference write — upstream
 *  `NotificationsActionsEmailPost`'s
 *  `SetUserSetting(id, SettingsKeyEmailNotificationGiteaActions, preference)`
 *  arm (notifications.go:83) reduced onto the side store column (upstream's
 *  SetUserSetting is itself a KV upsert). Targeted upsert, as above. */
export async function saveActionsEmailNotificationsPreference(
  d1: D1Database,
  userId: number,
  value: ActionsEmailNotificationsPreference,
): Promise<void> {
  await drizzle(d1)
    .insert(userSettings)
    .values({ userId, actionsEmailNotificationsPreference: value })
    .onConflictDoUpdate({ target: userSettings.userId, set: { actionsEmailNotificationsPreference: value } });
}

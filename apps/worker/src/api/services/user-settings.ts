import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { userSettings, users } from "../../db/schema";

/**
 * User account settings behind `GET/PATCH /user/settings` (SPEC-0004 §2.4 row;
 * upstream routers/api/v1/user/settings.go GetUserSettings / UpdateUserSettings
 * over user_service.UpdateOptions). The nine contract fields split across two
 * stores:
 *   - the landed `users` profile columns (src/db/schema.ts): `full_name`
 *     (users.display_name — the column every `User.full_name` projection
 *     reads, services/repository.ts apiUserFromRow), `description`,
 *     `website`, `location`;
 *   - the five preference fields with NO landed column (`theme`, `language`,
 *     `diff_view_style`, `hide_email`, `hide_activity`) live in the
 *     `user_settings` side store (`userSettings`, src/db/schema.ts).
 *
 * The table lives in the Drizzle schema and landed as migration 0008 (the
 * fourth raw-DDL sweep, the 0005/0007 supersede pattern); D1 access goes
 * through Drizzle per the architecture boundary (no hand-written SQL in
 * services). Superseded: the bootstrap `USER_SETTINGS_DDL_STATEMENTS` block
 * was deleted with the sweep — the generated migration is authoritative now.
 *
 * Defaults are upstream's creation values (user.go:706–711 + the xorm column
 * defaults: KeepEmailPrivate = setting.Service.DefaultKeepEmailPrivate, whose
 * app.example.ini default is false; Theme = setting.UI.DefaultTheme =
 * "gitea-auto"; DiffViewStyle '' / Language '' / KeepActivityPrivate false) —
 * declared as the schema's column defaults AND mirrored by
 * DEFAULT_USER_SETTINGS for the rowless read. Unknown-key settings cannot
 * occur — the PATCH body schema is the exact contract mirror
 * (models/user-settings.ts), so every presented key has a store; the
 * documented no-store divergence is Go's MaxSize/ValidUrl binding limits
 * (accepted-and-ignored, the createOrgRepo precedent).
 */

/** The five stored preference fields (the not-yet-swept user columns). */
export interface UserPreferenceSettings {
  theme: string;
  language: string;
  diffViewStyle: string;
  hideEmail: boolean;
  hideActivity: boolean;
}

/** Upstream's creation defaults — what every user renders before a PATCH. */
export const DEFAULT_USER_SETTINGS: UserPreferenceSettings = {
  theme: "gitea-auto",
  language: "",
  diffViewStyle: "",
  hideEmail: false,
  hideActivity: false,
};

/** The stored preferences of one user; an absent row renders the defaults. */
export async function loadUserSettings(d1: D1Database, userId: number): Promise<UserPreferenceSettings> {
  const row = await drizzle(d1).select().from(userSettings).where(eq(userSettings.userId, userId)).get();
  if (row === undefined) {
    return DEFAULT_USER_SETTINGS;
  }
  return {
    theme: row.theme,
    language: row.language,
    diffViewStyle: row.diffViewStyle,
    hideEmail: row.hideEmail,
    hideActivity: row.hideActivity,
  };
}

/** The PATCH write for the preference half: upsert only the fields the body
 *  set (others keep their stored value — read-then-apply, the
 *  saveRepoSettings shape, via the `user_id` PK conflict clause). Keys
 *  carrying `undefined` were absent from the body (the Go pointer semantics)
 *  and are dropped BEFORE the merge, so they cannot clobber the defaults. */
export async function saveUserSettings(
  d1: D1Database,
  userId: number,
  patch: Partial<UserPreferenceSettings>,
): Promise<void> {
  const present = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<UserPreferenceSettings>;
  const merged = { ...(await loadUserSettings(d1, userId)), ...present };
  await drizzle(d1)
    .insert(userSettings)
    .values({ userId, ...merged })
    .onConflictDoUpdate({ target: userSettings.userId, set: merged });
}

/**
 * The PATCH write for the profile half — the four landed `users` columns
 * (upstream UpdateUser → user_service.UpdateOptions FullName/Description/
 * Website/Location). Only PRESENTED keys land (the Go pointer semantics):
 * keys carrying `undefined` were absent from the body and must keep their
 * stored value, so they are dropped before the update (an all-`undefined`
 * patch is the no-op it is upstream).
 */
export async function saveUserProfileColumns(
  d1: D1Database,
  userId: number,
  patch: Partial<Pick<typeof users.$inferInsert, "displayName" | "description" | "website" | "location">>,
): Promise<void> {
  const present = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(present).length === 0) {
    return;
  }
  await drizzle(d1)
    .update(users)
    .set(present)
    .where(eq(users.id, userId));
}

/**
 * `convert.User2UserSettings` (services/convert/user.go:121–133): the nine
 * fields from the two stores. NOTE the upstream naming quirk the converter
 * bakes in: `hide_email` renders `user.KeepEmailPrivate` — the SAME switch
 * the PATCH body's `hide_email` writes, so PATCH→GET round-trips 1:1.
 */
export function toApiUserSettings(
  row: Pick<typeof users.$inferSelect, "displayName" | "description" | "website" | "location">,
  settings: UserPreferenceSettings,
): {
  description: string;
  diff_view_style: string;
  full_name: string;
  hide_activity: boolean;
  hide_email: boolean;
  language: string;
  location: string;
  theme: string;
  website: string;
} {
  return {
    full_name: row.displayName ?? "",
    website: row.website ?? "",
    location: row.location ?? "",
    description: row.description ?? "",
    theme: settings.theme,
    language: settings.language,
    hide_email: settings.hideEmail,
    hide_activity: settings.hideActivity,
    diff_view_style: settings.diffViewStyle,
  };
}

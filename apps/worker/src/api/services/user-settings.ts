import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../../db/schema";

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
 *     `user_settings` side store below.
 *
 * PENDING MIGRATION — raw-D1 bootstrap, the superseded `FOLLOWS_DDL_STATEMENTS`
 * pattern inverted (services/follows.ts): `user_settings` is NOT in the
 * Drizzle schema yet (src/db is owned by the migration wave), so this module
 * carries the DDL block for the schema owner (below) and reads through
 * parameterized raw D1 until the table lands in src/db/schema.ts + a generated
 * migration. When it does: delete `USER_SETTINGS_DDL_STATEMENTS` and port the
 * two queries to Drizzle (1:1 on `user_id`, the `repo_settings` sweep shape).
 * The AGENTS.md boundary ("D1 access goes through Drizzle ORM only") is
 * honored in spirit: every statement lives HERE, parameterized, mirroring one
 * upstream read/write.
 *
 * Defaults are upstream's creation values (user.go:706–711 + the xorm column
 * defaults: KeepEmailPrivate = setting.Service.DefaultKeepEmailPrivate, whose
 * app.example.ini default is false; Theme = setting.UI.DefaultTheme =
 * "gitea-auto"; DiffViewStyle '' / Language '' / KeepActivityPrivate false).
 * Unknown-key settings cannot occur — the PATCH body schema is the exact
 * contract mirror (models/user-settings.ts), so every presented key has a
 * store; the documented no-store divergence is Go's MaxSize/ValidUrl binding
 * limits (accepted-and-ignored, the createOrgRepo precedent).
 */

/**
 * DDL for the migration owner (report verbatim). Port of the upstream `user`
 * preference columns (models/user/user.go:171–173 + :102 + :119): 1:1 on the
 * user row, FK cascade like the rest of the users-adjacent tables. Booleans
 * are the repo-convention INTEGERs.
 */
export const USER_SETTINGS_DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'gitea-auto',
  language TEXT NOT NULL DEFAULT '',
  diff_view_style TEXT NOT NULL DEFAULT '',
  hide_email INTEGER NOT NULL DEFAULT 0,
  hide_activity INTEGER NOT NULL DEFAULT 0
)`,
];

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

/** Raw snake_case projection of the `user_settings` row. */
interface RawUserSettingsRow {
  theme: string;
  language: string;
  diff_view_style: string;
  hide_email: number;
  hide_activity: number;
}

/** Row → settings; integers → booleans. */
function rawToSettings(raw: RawUserSettingsRow): UserPreferenceSettings {
  return {
    theme: raw.theme,
    language: raw.language,
    diffViewStyle: raw.diff_view_style,
    hideEmail: raw.hide_email === 1,
    hideActivity: raw.hide_activity === 1,
  };
}

/** The stored preferences of one user; an absent row renders the defaults. */
export async function loadUserSettings(d1: D1Database, userId: number): Promise<UserPreferenceSettings> {
  const row = await d1
    .prepare("SELECT theme, language, diff_view_style, hide_email, hide_activity FROM user_settings WHERE user_id = ?1")
    .bind(userId)
    .first<RawUserSettingsRow>();
  return row === null ? DEFAULT_USER_SETTINGS : rawToSettings(row);
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
  await d1
    .prepare(
      "INSERT INTO user_settings (user_id, theme, language, diff_view_style, hide_email, hide_activity) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
        "ON CONFLICT (user_id) DO UPDATE SET theme = ?2, language = ?3, diff_view_style = ?4, hide_email = ?5, hide_activity = ?6",
    )
    .bind(
      userId,
      merged.theme,
      merged.language,
      merged.diffViewStyle,
      merged.hideEmail ? 1 : 0,
      merged.hideActivity ? 1 : 0,
    )
    .run();
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

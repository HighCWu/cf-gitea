/**
 * The OWNER-level ActionsConfig store (the actions-general owner page's
 * token-permission + cross-repo settings; services/actions/config.ts is the
 * REPO-scope twin's store — this module is the OWNER scope upstream pairs
 * with it).
 *
 * Upstream pin fc4936884584a41931906553d96c2601d750e6ef:
 *
 *   - STORE: the generic `user_setting` KV (models/user/setting.go:22-29 —
 *     `Setting{ID, UserID, SettingKey varchar(255), SettingValue text}`,
 *     the composite UNIQUE `key_userid` over (user_id, setting_key)).
 *     Landed home: `user_settings_kv` (schema.ts, migration 0048) —
 *     column-for-column with upstream; the typed `user_settings` side store
 *     stays the collapse of upstream's user-PREFERENCE keys (theme/language,
 *     the email-notification pair) and never touches this table. Upstream
 *     ships eight distinct keys on the one KV (setting_options.go:8-26),
 *     so the generic table is the parity move, not a per-key column.
 *
 *   - THE KEY: `SettingsKeyActionsConfig = "actions.config"`
 *     (setting_options.go:26). The value is the OwnerActionsConfig JSON
 *     (models/actions/config.go:20-33): TokenPermissionMode,
 *     MaxTokenPermissions, AllowedCrossRepoIDs — every field tagged
 *     `omitempty`, so the Go zero config marshals `{}` and a saved default
 *     marshals `{"token_permission_mode":"permissive"}`. ONE row per owner:
 *     upstream orgs and users share the users table, and both scopes write
 *     the SAME key with the owner's id (getRunnersCtx's OwnerID,
 *     routers/web/shared/actions/runners.go:82-91) — the house `users.type`
 *     collapse matches, so one (user_id, key) tuple covers org and user
 *     owners alike.
 *
 *   - SERIALIZATION: SetUserSettingJSON / GetUserSettingJSON
 *     (models/user/setting.go:210-232). OwnerActionsConfig implements
 *     ConversionFrom ONLY (config.go:36-37 — no ConversionTo), so the WRITE
 *     side is Go's plain json.Marshal of the struct: declaration order,
 *     omitempty on all three tagged fields (a "" mode, a nil max, an
 *     empty/nil allowed list serialize nothing), and the embedded
 *     ActionsTokenPermissions marshals as
 *     `{"unit_access_modes":{...},"id_token":bool}` with the SAME omitempty
 *     arms (repo_unit_actions.go:29-33). Go sorts JSON MAP keys
 *     lexically by their encoded string form (encoding/json's mapEncoder),
 *     so the integer-keyed unit map orders "1","10","2",… — the READ side
 *     is lenient either way (parse below), but the bytes are upstream's.
 *     SLICES marshal in order (no sort) — the allowed list keeps insertion
 *     order.
 *
 *   - THE ABSENT ROW: GetUserSettingJSON with no row reads "" and STILL
 *     runs the type's ConversionFrom.FromDB on the empty bytes
 *     (setting.go:217-223); OwnerActionsConfig.FromDB is the ignored-error
 *     Unmarshal + `EnumValue` mode normalization (config.go:38-45) —
 *     modules/util/util.go:302-310 answers enums[0] for anything invalid,
 *     and permissive is EnumValues[0] (repo_unit_actions.go:23-25). A fresh
 *     owner's loaded config therefore reads mode "permissive", max nil,
 *     allowed nil — the page modules' OWNER_ACTIONS_GENERAL_FRESH_DATA
 *     posture. Junk bytes take the same road (the `_ =` on Unmarshal).
 *
 *   - THE UPSERT: SetUserSetting → upsertUserSettingValue
 *     (setting.go:186-208) — upstream's portable UPDATE-then-check-then-
 *     INSERT dance inside a tx. SQLite arbitrates the same insert-or-update
 *     in one statement (INSERT … ON CONFLICT(user_id, setting_key) DO
 *     UPDATE), which is what drizzle emits here; the (user_id, setting_key)
 *     UNIQUE is the arbitration point either way.
 *
 *   - WRITES: upstream UpdateGeneralSettings
 *     (routers/web/shared/actions/general.go:100-161) loads with
 *     GetOwnerActionsConfig (:115-118), mutates (the cross-repo add/remove
 *     arms :119-139, the EnumValue-gated mode/max block :142-152 — an
 *     INVALID mode is silently IGNORED, keeping the stored values: the
 *     owner arm has no repo-style refusal), then SetOwnerActionsConfig
 *     (:154-157). The page modules' applyOwnerActionsGeneralForms ports
 *     that sequence; this module is the store half.
 *
 *   - ID-SPACE NOTE (the one adaptation): upstream ids are int64; this
 *     deployment's repositories.id is TEXT (schema.ts — the SPEC-0003 uuid
 *     convention), so `allowed_cross_repo_ids` carries STRING elements and
 *     the cross_repo_remove_target_id form field parses as a string. The
 *     KEY, the JSON shape and the omitempty arms are upstream's; the
 *     element type follows the house id space (the same adaptation every
 *     TEXT-repo-id surface carries).
 */

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, userSettingsKv } from "../../db/schema";
import {
  ACTIONS_TOKEN_PERMISSION_MODES,
  type ActionsAccessMode,
  type ActionsTokenPermissionMode,
  type ActionsTokenPermissions,
} from "./config";

/** Upstream `SettingsKeyActionsConfig` (models/user/setting_options.go:26). */
export const SETTINGS_KEY_ACTIONS_CONFIG = "actions.config";

/** The OWNER ActionsConfig (models/actions/config.go:20-33). TS fields are
 *  camelCase; `serialize` emits upstream's exact Go-marshal keys. */
export interface OwnerActionsConfig {
  tokenPermissionMode: ActionsTokenPermissionMode;
  maxTokenPermissions: ActionsTokenPermissions | null;
  /** The allowed cross-repo TARGET repositories (upstream
   *  AllowedCrossRepoIDs []int64 — TEXT element ids here, the header's
   *  id-space note). Insertion order preserved. */
  allowedCrossRepoIds: string[];
}

/** The FromDB arm (config.go:38-45 over setting.go:210-232): lenient JSON
 *  read — unparseable bytes yield the zero config, never a throw (upstream
 *  ignores the Unmarshal error; an absent row's "" bytes take the same
 *  path) — then the EnumValue mode normalization: anything absent or
 *  invalid becomes "permissive" (util.go:302-310 — invalid answers
 *  enums[0]). The returned mode is therefore always valid — the Go zero
 *  literal's "" never survives a load. */
export function parseOwnerActionsConfig(raw: string | null): OwnerActionsConfig {
  let mode = "";
  let maxTokenPermissions: ActionsTokenPermissions | null = null;
  let allowedCrossRepoIds: string[] = [];
  if (raw !== null && raw !== "") {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.token_permission_mode === "string") mode = parsed.token_permission_mode;
      if (parsed.max_token_permissions !== null && typeof parsed.max_token_permissions === "object") {
        const max = parsed.max_token_permissions as { unit_access_modes?: Record<string, number>; id_token?: boolean };
        maxTokenPermissions = {
          unitAccessModes: Object.fromEntries(
            Object.entries(max.unit_access_modes ?? {}).map(([unitType, accessMode]) => [Number(unitType), accessMode as ActionsAccessMode]),
          ),
          idToken: max.id_token === true,
        };
      }
      if (Array.isArray(parsed.allowed_cross_repo_ids)) allowedCrossRepoIds = parsed.allowed_cross_repo_ids.map(String);
    } catch {
      // upstream's `_ = json.Unmarshal(...)` — junk bytes are the zero config
    }
  }
  const tokenPermissionMode: ActionsTokenPermissionMode = ACTIONS_TOKEN_PERMISSION_MODES.includes(mode as ActionsTokenPermissionMode)
    ? (mode as ActionsTokenPermissionMode) // EnumValue's pass-through valid arm
    : "permissive"; // EnumValue's enums[0] fallback
  return { tokenPermissionMode, maxTokenPermissions, allowedCrossRepoIds };
}

/** Go's JSON map-key sort: encoding/json orders object keys by their
 *  encoded STRING form, so integer keys run "1","10","2","3"… (lexical,
 *  not numeric). Only maps sort — slices marshal in order. */
function goJsonKeySort(entries: Array<[string, unknown]>): Array<[string, unknown]> {
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The write half (setting.go:227-232's SetUserSettingJSON with NO
 *  ConversionTo — Go json.Marshal's exact bytes): declaration order
 *  (token_permission_mode, max_token_permissions, allowed_cross_repo_ids),
 *  omitempty on all three (a null max and an empty allowed list serialize
 *  nothing), the embedded permissions object's own omitempty arms (an empty
 *  unit map and a false id_token serialize nothing — repo_unit_actions.go:
 *  29-33), and the unit map's keys in Go's lexical map-key order. The ""
 *  mode WOULD omit its key (the Go zero literal), but that value never
 *  survives parseOwnerActionsConfig (EnumValue normalization — the mode
 *  field's type carries that invariant), so a serialized config's mode
 *  always emits. */
export function serializeOwnerActionsConfig(cfg: OwnerActionsConfig): string {
  const parts: string[] = [];
  parts.push(`"token_permission_mode":${JSON.stringify(cfg.tokenPermissionMode)}`);
  if (cfg.maxTokenPermissions !== null) {
    const units = goJsonKeySort(
      Object.entries(cfg.maxTokenPermissions.unitAccessModes).map(([unitType, accessMode]) => [unitType, accessMode] as const),
    );
    const inner: string[] = [];
    if (units.length > 0) inner.push(`"unit_access_modes":{${units.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")}}`);
    if (cfg.maxTokenPermissions.idToken) inner.push(`"id_token":true`);
    parts.push(`"max_token_permissions":{${inner.join(",")}}`);
  }
  if (cfg.allowedCrossRepoIds.length > 0) parts.push(`"allowed_cross_repo_ids":${JSON.stringify(cfg.allowedCrossRepoIds)}`);
  return `{${parts.join(",")}}`;
}

/** GetOwnerActionsConfig (models/actions/config.go:40-47): the row read,
 *  the absent row answering the default config (the FromDB-on-empty-bytes
 *  chain in the header — mode permissive, max null, allowed empty). */
export async function getOwnerActionsConfig(d1: D1Database, ownerId: number): Promise<OwnerActionsConfig> {
  const row = await drizzle(d1)
    .select({ settingValue: userSettingsKv.settingValue })
    .from(userSettingsKv)
    .where(and(eq(userSettingsKv.userId, ownerId), eq(userSettingsKv.settingKey, SETTINGS_KEY_ACTIONS_CONFIG)))
    .get();
  return parseOwnerActionsConfig(row?.settingValue ?? null);
}

/** SetOwnerActionsConfig (models/actions/config.go:49-51): the row upsert —
 *  SQLite's ON CONFLICT arbitrating setting.go:186-208's
 *  update-then-insert dance at the (user_id, setting_key) UNIQUE. */
export async function setOwnerActionsConfig(d1: D1Database, ownerId: number, cfg: OwnerActionsConfig): Promise<void> {
  const settingValue = serializeOwnerActionsConfig(cfg);
  await drizzle(d1)
    .insert(userSettingsKv)
    .values({ userId: ownerId, settingKey: SETTINGS_KEY_ACTIONS_CONFIG, settingValue })
    .onConflictDoUpdate({ target: [userSettingsKv.userId, userSettingsKv.settingKey], set: { settingValue } });
}

/** GetOwnerRepositoriesByIDs (models/repo/repo_list.go:844-850) — the
 *  allowed-repo rows for the owner page's Target Repositories list: an
 *  EMPTY id list answers an empty list WITHOUT a query (:845-847); the
 *  query is owner-pinned (owner_id = ? AND id IN ids) with NO order clause
 *  (upstream's Find default — SQLite's rowid order). Reduced to the render
 *  triple (the page module's OwnerActionsGeneralAllowedRepo shape: id +
 *  FullName + Link — `$repo.FullName` = "owner/repo", `$repo.Link` =
 *  "/owner/repo"). */
export async function getOwnerRepositoriesByIDs(
  d1: D1Database,
  ownerId: number,
  repoIds: string[],
): Promise<Array<{ id: string; fullName: string; link: string }>> {
  if (repoIds.length === 0) return [];
  const rows = await drizzle(d1)
    .select({ id: repositories.id, ownerNamespace: repositories.ownerNamespace, slug: repositories.slug })
    .from(repositories)
    .where(and(eq(repositories.ownerId, ownerId), inArray(repositories.id, repoIds)))
    .all();
  return rows.map((row) => ({
    id: row.id,
    fullName: `${row.ownerNamespace}/${row.slug}`,
    link: `/${row.ownerNamespace}/${row.slug}`,
  }));
}

/** GetRepositoryByName (models/repo/repo.go:763-780) — the add arm's
 *  within-owner resolution: owner-pinned (owner_id = ?) and case-folded
 *  (lower_name = lower(name); the house slug IS the lower_name). No
 *  visibility/status arm — upstream's settings-page lookup is past the
 *  ownership gate and checks nothing else. null = ErrRepoNotExist (the
 *  caller renders general.go:125's JSONError). */
export async function getRepositoryByName(
  d1: D1Database,
  ownerId: number,
  name: string,
): Promise<{ id: string } | null> {
  const row = await drizzle(d1)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerId, ownerId), eq(repositories.slug, name.toLowerCase())))
    .get();
  return row ?? null;
}

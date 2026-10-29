/**
 * The repo ActionsConfig store (SPEC-0012's recorded migration gap — the
 * actions-general settings page's token-permissions + collaborative-owners
 * sections; the landed page kept them documented-unrendered until this
 * store existed).
 *
 * Upstream pin fc4936884584a41931906553d96c2601d750e6ef:
 *
 *   - STORE: the actions `repo_unit` row's `config` TEXT column
 *     (models/repo/repo_unit.go:32 `Config convert.Conversion
 *     xorm:"TEXT"`), holding the ActionsConfig JSON
 *     (models/repo/repo_unit_actions.go:76-93): CollaborativeOwnerIDs,
 *     TokenPermissionMode, MaxTokenPermissions, OverrideOwnerConfig plus
 *     the workflow-disable maps (DisabledWorkflows, DisabledScopedWorkflows
 *     — carried for round-trip fidelity; their write arms are the
 *     workflow-list pages, not this store's settings arms). Landed
 *     home: `repo_units.config` (schema.ts, migration 0043) —
 *     column-for-column with upstream, on the same row the landed unit
 *     toggle already maintains in lockstep (repo-settings.ts
 *     saveRepoSettings), so the config's LIFETIME matches upstream's too:
 *     disabling Actions deletes the unit row (UpdateRepositoryUnits'
 *     delete arm) and wipes the config; re-enabling starts fresh
 *     (ActionsUnitPost's newRepoUnit(repo, TypeActions, nil)).
 *
 *   - SERIALIZATION: upstream's xorm Conversion — ToDB is Go's
 *     json.Marshal of the struct (repo_unit_actions.go:186-189), FromDB an
 *     ignored-error Unmarshal + EnumValue mode normalization
 *     (:177-183); xorm's BeforeSet calls FromDB(nil) for a NULL column
 *     "to set default values" (repo_unit.go:288-292), so a NULL config
 *     loads as the zero config with the mode NORMALIZED — EnumValue
 *     answers enums[0] for anything invalid (modules/util/util.go:304-310),
 *     and permissive is EnumValues[0] (repo_unit_actions.go:26) — the
 *     loaded zero config's mode is "permissive", never "".
 *
 *   - WRITES: the settings handlers mutate a loaded ActionsConfig and
 *     persist with UpdateRepoUnitConfig (repo_unit.go:368-370 — a
 *     `COLS("config")` update by the unit row's id):
 *       - UpdateTokenPermissions (routers/web/repo/setting/actions.go:
 *         139-191): OverrideOwnerConfig := FormBool; WHEN overriding, the
 *         mode must be a valid enum value or the save is REFUSED (invalid
 *         flash + redirect, :161-167), and max permissions are
 *         enable_max_permissions ? ParseMaxTokenPermissions : nil (:169-177);
 *         when NOT overriding the stored mode/max are left untouched.
 *       - AddCollaborativeOwner / DeleteCollaborativeOwner (:103-137):
 *         append-if-absent / remove-all of the owner id, the delete
 *         refusing an id that is not a collaborative owner
 *         (IsCollaborativeOwner → JSONErrorNotFound).
 *
 *   - THE OWNER FALLBACK IS NOT THIS STORE: upstream's not-overriding
 *     render reads the OWNER-level OwnerActionsConfig (models/actions/
 *     config.go:40-47 — a `user_setting` 'actions.config' JSON row via
 *     GetUserSettingJSON, whose ConversionFrom FromDB normalizes the mode
 *     the same way). That store has no landed home (the owner
 *     token-permission page is the census row's org/user scopes, not this
 *     module); upstream renders the same values for an owner without a
 *     saved setting — mode permissive, max = MakeWriteAllActionsTokenPermissions
 *     (repo_unit_actions.go:162-168), EnableMaxTokenPermissions false —
 *     and the page module renders exactly that fresh-owner posture.
 *
 *   - DEFAULTS the runner/token-mint side will consume when that arm lands
 *     (ported here for the store's completeness, repo_unit_actions.go:
 *     150-174): GetDefaultTokenPermissions — restricted →
 *     MakeRestrictedPermissions (all none except code/packages/releases
 *     read), permissive → all write; GetMaxTokenPermissions — explicit or
 *     the write-all default; ClampPermissions — per-unit min + id-token
 *     AND. perm.AccessMode is none=0, read=1, write=2 (the
 *     permissions_table_unit.tmpl radios key on 1/2).
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repoUnits } from "../../db/schema";

// ---------------------------------------------------------------------------
// The enum/values (models/repo/repo_unit_actions.go:15-26, 30-56)
// ---------------------------------------------------------------------------

/** ActionsTokenPermissionMode — the two valid enum values (EnumValues
 *  order: permissive first, the EnumValue normalization default). */
export type ActionsTokenPermissionMode = "permissive" | "restricted";

export const ACTIONS_TOKEN_PERMISSION_MODES: readonly ActionsTokenPermissionMode[] = [
  "permissive",
  "restricted",
];

/** perm.AccessMode as the token-permission radios spell it (none=0, read=1,
 *  write=2 — permissions_table_unit.tmpl's `eq .UnitAccessMode 1/2`). */
export type ActionsAccessMode = 0 | 1 | 2;

/** ActionsTokenUnitTypes (repo_unit_actions.go:38-47) — code, issues,
 *  pull_requests, packages, actions, wiki, releases, projects (models/unit/
 *  unit.go:24-34's iota values). ParseMaxTokenPermissions parses a form
 *  field per type; absent fields parse none (shared/actions
 *  ParseMaxTokenPermissions' default arm). */
export const ACTIONS_TOKEN_UNIT_TYPES: readonly number[] = [1, 2, 3, 9, 10, 5, 4, 8];

/** The unit rows permissions_table.tmpl renders — the same list MINUS
 *  packages: the template simply has no packages row (the table's own
 *  omission, mirrored faithfully; the packages ceiling still parses — as
 *  none — because ParseMaxTokenPermissions loops all of
 *  ACTIONS_TOKEN_UNIT_TYPES and the field is absent from the form). */
export const TOKEN_PERMISSIONS_TABLE_UNIT_TYPES: readonly number[] = [1, 2, 3, 5, 4, 8, 10];

/** ActionsTokenPermissions (repo_unit_actions.go:29-33): the per-unit
 *  ceiling map + the OIDC id-token grant. Serialized under upstream's
 *  `unit_access_modes` / `id_token` keys, both omitempty. */
export interface ActionsTokenPermissions {
  unitAccessModes: { [unitType: number]: ActionsAccessMode };
  idToken: boolean;
}

/** MakeActionsTokenPermissions (repo_unit_actions.go:46-52) — every unit at
 *  one access mode. */
export function makeActionsTokenPermissions(mode: ActionsAccessMode): ActionsTokenPermissions {
  const unitAccessModes: { [unitType: number]: ActionsAccessMode } = {};
  for (const unitType of ACTIONS_TOKEN_UNIT_TYPES) unitAccessModes[unitType] = mode;
  return { unitAccessModes, idToken: false };
}

/** MakeWriteAllActionsTokenPermissions (:54-57) — the GetMaxTokenPermissions
 *  default ceiling: everything write, id-token granted. */
export function makeWriteAllActionsTokenPermissions(): ActionsTokenPermissions {
  return { ...makeActionsTokenPermissions(2), idToken: true };
}

/** MakeRestrictedPermissions (:71-78) — all none except code, packages and
 *  releases read; id-token never. */
export function makeRestrictedPermissions(): ActionsTokenPermissions {
  const ret = makeActionsTokenPermissions(0);
  ret.unitAccessModes[1] = 1;
  ret.unitAccessModes[9] = 1;
  ret.unitAccessModes[4] = 1;
  return ret;
}

/** GetDefaultTokenPermissions (repo_unit_actions.go:150-159) — the mode's
 *  default grant (callers clamp against the ceiling; the runner-side
 *  consumer lands with the token-mint arm). The default (mode-less) case
 *  answers the empty permissions — unreachable after FromDB normalization
 *  (a loaded mode is always permissive/restricted). */
export function getDefaultTokenPermissions(mode: ActionsTokenPermissionMode): ActionsTokenPermissions {
  switch (mode) {
    case "restricted":
      return makeRestrictedPermissions();
    case "permissive":
      return makeActionsTokenPermissions(2);
  }
}

/** GetMaxTokenPermissions (:162-168) — the explicit ceiling or write-all. */
export function getMaxTokenPermissions(cfg: Pick<RepoActionsConfig, "maxTokenPermissions">): ActionsTokenPermissions {
  return cfg.maxTokenPermissions ?? makeWriteAllActionsTokenPermissions();
}

/** ClampActionsTokenPermissions (:60-68) — per-unit min + id-token AND. */
export function clampActionsTokenPermissions(p1: ActionsTokenPermissions, p2: ActionsTokenPermissions): ActionsTokenPermissions {
  const unitAccessModes: { [unitType: number]: ActionsAccessMode } = {};
  for (const unitType of ACTIONS_TOKEN_UNIT_TYPES) {
    unitAccessModes[unitType] = Math.min(p1.unitAccessModes[unitType] ?? 0, p2.unitAccessModes[unitType] ?? 0) as ActionsAccessMode;
  }
  return { unitAccessModes, idToken: p1.idToken && p2.idToken };
}

// ---------------------------------------------------------------------------
// The config record + its upstream-shaped JSON serialization
// (repo_unit_actions.go:76-93 struct, :177-189 Conversion)
// ---------------------------------------------------------------------------

/** The repo ActionsConfig. TS fields are camelCase; `serialize` emits
 *  upstream's exact Go-marshal keys — the untagged Go fields marshal under
 *  their Go names (`DisabledWorkflows`, `DisabledScopedWorkflows`,
 *  `CollaborativeOwnerIDs`, nil slices as null, no omitempty), the tagged
 *  fields under their snake_case keys with omitempty. */
export interface RepoActionsConfig {
  disabledWorkflows: string[];
  /** Keyed by the SOURCE repo id (Go's map[int64][]string — JSON string keys). */
  disabledScopedWorkflows: Record<string, string[]>;
  collaborativeOwnerIds: number[];
  tokenPermissionMode: ActionsTokenPermissionMode;
  maxTokenPermissions: ActionsTokenPermissions | null;
  overrideOwnerConfig: boolean;
}

/** The FromDB arm (repo_unit_actions.go:177-183): lenient JSON read —
 *  unparseable bytes yield the zero config, never a throw (upstream ignores
 *  the Unmarshal error) — then the EnumValue mode normalization: anything
 *  absent or invalid becomes "permissive" (modules/util/util.go:304-310 —
 *  invalid answers enums[0]; xorm's BeforeSet runs this very path for a
 *  NULL column, repo_unit.go:288-292, so even a fresh unit's loaded config
 *  reads permissive). The returned mode is therefore always valid —
 *  upstream's Go zero literal's "" mode never survives a load. */
export function parseRepoActionsConfig(raw: string | null): RepoActionsConfig {
  const cfg: RepoActionsConfig = {
    disabledWorkflows: [],
    disabledScopedWorkflows: {},
    collaborativeOwnerIds: [],
    tokenPermissionMode: "permissive",
    maxTokenPermissions: null,
    overrideOwnerConfig: false,
  };
  if (raw !== null && raw !== "") {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(parsed.DisabledWorkflows)) cfg.disabledWorkflows = parsed.DisabledWorkflows.map(String);
      if (parsed.DisabledScopedWorkflows !== null && typeof parsed.DisabledScopedWorkflows === "object") {
        const scoped: Record<string, string[]> = {};
        for (const [key, value] of Object.entries(parsed.DisabledScopedWorkflows as Record<string, unknown>)) {
          if (Array.isArray(value)) scoped[key] = value.map(String);
        }
        cfg.disabledScopedWorkflows = scoped;
      }
      if (Array.isArray(parsed.CollaborativeOwnerIDs)) cfg.collaborativeOwnerIds = parsed.CollaborativeOwnerIDs.map(Number);
      if (typeof parsed.token_permission_mode === "string") cfg.tokenPermissionMode = parsed.token_permission_mode as ActionsTokenPermissionMode;
      if (parsed.max_token_permissions !== null && typeof parsed.max_token_permissions === "object") {
        const max = parsed.max_token_permissions as { unit_access_modes?: Record<string, number>; id_token?: boolean };
        cfg.maxTokenPermissions = {
          unitAccessModes: Object.fromEntries(
            Object.entries(max.unit_access_modes ?? {}).map(([unitType, accessMode]) => [Number(unitType), accessMode as ActionsAccessMode]),
          ),
          idToken: max.id_token === true,
        };
      }
      if (parsed.override_owner_config === true) cfg.overrideOwnerConfig = true;
    } catch {
      // upstream's `_ = json.Unmarshal(...)` — junk bytes are the zero config
    }
  }
  if (!ACTIONS_TOKEN_PERMISSION_MODES.includes(cfg.tokenPermissionMode)) {
    cfg.tokenPermissionMode = "permissive"; // EnumValue's enums[0] fallback
  }
  return cfg;
}

/** The ToDB arm (repo_unit_actions.go:185-189): Go json.Marshal's exact
 *  bytes — struct-field declaration order, nil slices as explicit nulls on
 *  the untagged fields, omitempty on the tagged three (a "" mode, a nil max
 *  and a false override serialize nothing). Integer-keyed maps serialize
 *  string keys in ascending numeric order, Go's own map-key sort. */
export function serializeRepoActionsConfig(cfg: RepoActionsConfig): string {
  const parts: string[] = [
    `"DisabledWorkflows":${cfg.disabledWorkflows.length === 0 ? "null" : JSON.stringify(cfg.disabledWorkflows)}`,
    `"DisabledScopedWorkflows":${
      Object.keys(cfg.disabledScopedWorkflows).length === 0
        ? "null"
        : JSON.stringify(Object.fromEntries(Object.entries(cfg.disabledScopedWorkflows).sort(([a], [b]) => Number(a) - Number(b))))
    }`,
    `"CollaborativeOwnerIDs":${
      cfg.collaborativeOwnerIds.length === 0 ? "null" : JSON.stringify([...cfg.collaborativeOwnerIds].sort((a, b) => a - b))
    }`,
  ];
  // The tagged omitempty keys: the Go zero literal's "" mode would omit
  // token_permission_mode, but that value never survives parseRepoActionsConfig
  // (EnumValue normalization) — a serialized config's mode is always valid.
  parts.push(`"token_permission_mode":${JSON.stringify(cfg.tokenPermissionMode)}`);
  if (cfg.maxTokenPermissions !== null) {
    const entries = Object.entries(cfg.maxTokenPermissions.unitAccessModes)
      .map(([unitType, accessMode]) => [Number(unitType), accessMode] as const)
      .sort(([a], [b]) => a - b)
      .map(([unitType, accessMode]) => `${JSON.stringify(String(unitType))}:${accessMode}`);
    const maxParts: string[] = [];
    if (entries.length > 0) maxParts.push(`"unit_access_modes":{${entries.join(",")}}`); // omitempty on the map
    if (cfg.maxTokenPermissions.idToken) maxParts.push(`"id_token":true`); // omitempty on the flag
    parts.push(`"max_token_permissions":{${maxParts.join(",")}}`);
  }
  if (cfg.overrideOwnerConfig) parts.push(`"override_owner_config":true`);
  return `{${parts.join(",")}}`;
}

// ---------------------------------------------------------------------------
// The store (GetUnit's read + UpdateRepoUnitConfig's write)
// ---------------------------------------------------------------------------

/** The actions unit row's raw config column: `undefined` = no row, `null` =
 *  a row with a NULL column. */
async function loadRepoActionsUnitConfig(d1: D1Database, repoId: string): Promise<string | null | undefined> {
  const row = await drizzle(d1)
    .select({ config: repoUnits.config })
    .from(repoUnits)
    .where(and(eq(repoUnits.repoId, repoId), eq(repoUnits.type, "actions")))
    .get();
  return row?.config;
}

/** The actions unit row's config; a missing row or NULL column loads the
 *  normalized zero config (upstream: BeforeSet's FromDB(nil) — the mode
 *  normalizes to permissive even then). Repo-scoped: `type='actions'`. */
export async function loadRepoActionsConfig(d1: D1Database, repoId: string): Promise<RepoActionsConfig> {
  return parseRepoActionsConfig((await loadRepoActionsUnitConfig(d1, repoId)) ?? null);
}

/** UpdateRepoUnitConfig (repo_unit.go:368-370) — the config-column write on
 *  the actions unit row. `"missing"` answers for a unit-less repo: the
 *  POST route group rides MustEnableActions upstream (web.go:1266-1278), so
 *  the handler never sees a unit-less repo — this outcome is the gate's
 *  404 expressed at the store seam. */
export async function saveRepoActionsConfig(d1: D1Database, repoId: string, cfg: RepoActionsConfig): Promise<"saved" | "missing"> {
  const result = await drizzle(d1)
    .update(repoUnits)
    .set({ config: serializeRepoActionsConfig(cfg) })
    .where(and(eq(repoUnits.repoId, repoId), eq(repoUnits.type, "actions")))
    .run();
  return result.meta.changes > 0 ? "saved" : "missing";
}

// ---------------------------------------------------------------------------
// The write arms (routers/web/repo/setting/actions.go:103-191)
// ---------------------------------------------------------------------------

/** AddCollaborativeOwner (:124-137) — append-if-absent, then persist. */
export async function addRepoActionsCollaborativeOwner(d1: D1Database, repoId: string, ownerUserId: number): Promise<"added" | "missing"> {
  const cfg = await loadRepoActionsConfig(d1, repoId);
  if (cfg.collaborativeOwnerIds.includes(ownerUserId)) return "added"; // AddCollaborativeOwner's contains-guard
  cfg.collaborativeOwnerIds.push(ownerUserId);
  return (await saveRepoActionsConfig(d1, repoId, cfg)) === "saved" ? "added" : "missing";
}

/** DeleteCollaborativeOwner (:114-137) — the unit must exist (upstream's
 *  GetUnit arm precedes the ownership check and answers the error first),
 *  then IsCollaborativeOwner must hold (the route answers
 *  JSONErrorNotFound otherwise), then remove-all. */
export async function removeRepoActionsCollaborativeOwner(
  d1: D1Database,
  repoId: string,
  ownerUserId: number,
): Promise<"removed" | "not-an-owner" | "missing"> {
  const raw = await loadRepoActionsUnitConfig(d1, repoId);
  if (raw === undefined) return "missing"; // GetUnit's not-exist arm, checked FIRST
  const cfg = parseRepoActionsConfig(raw);
  if (!cfg.collaborativeOwnerIds.includes(ownerUserId)) return "not-an-owner";
  cfg.collaborativeOwnerIds = cfg.collaborativeOwnerIds.filter((id) => id !== ownerUserId);
  return (await saveRepoActionsConfig(d1, repoId, cfg)) === "saved" ? "removed" : "missing";
}

/** The token_permissions POST body (UpdateTokenPermissions' form reads):
 *  the raw per-unit radio strings, validated/normalized in the apply. */
export interface RepoTokenPermissionsForm {
  overrideOwnerConfig: boolean;
  tokenPermissionMode: string;
  enableMaxPermissions: boolean;
  /** `max_unit_access_mode_{unitType}` raw values ("none" | "read" | "write" | junk). */
  maxUnitAccessModes: Record<number, string>;
  /** `max_id_token` raw value ("write" grants, everything else refuses — :72's `== "write"`). */
  maxIdToken: string;
}

/** UpdateTokenPermissions (:139-191): override flag always written; the
 *  mode + max ceiling only WHEN overriding (the `shouldUpdate` gate — an
 *  unchecking save keeps the stored mode/max); an invalid mode REFUSES the
 *  save (upstream's flash-error redirect — `"invalid-mode"`), enable-max
 *  false stores nil (:176's "ensure any sent permissions are ignored").
 *  `"missing"` is the unit gate (see saveRepoActionsConfig). */
export async function applyRepoTokenPermissionsForm(d1: D1Database, repoId: string, form: RepoTokenPermissionsForm): Promise<"saved" | "invalid-mode" | "missing"> {
  const cfg = await loadRepoActionsConfig(d1, repoId);
  cfg.overrideOwnerConfig = form.overrideOwnerConfig;
  if (cfg.overrideOwnerConfig) {
    if (!ACTIONS_TOKEN_PERMISSION_MODES.includes(form.tokenPermissionMode as ActionsTokenPermissionMode)) {
      return "invalid-mode"; // :162-167 — EnumValue-invalid: flash + redirect, NO save
    }
    cfg.tokenPermissionMode = form.tokenPermissionMode as ActionsTokenPermissionMode;
    // ParseMaxTokenPermissions (routers/web/shared/actions/...:38-55):
    // write/read keywords, everything else none; id-token on the literal "write".
    if (form.enableMaxPermissions) {
      const unitAccessModes: { [unitType: number]: ActionsAccessMode } = {};
      for (const unitType of ACTIONS_TOKEN_UNIT_TYPES) {
        const raw = form.maxUnitAccessModes[unitType];
        unitAccessModes[unitType] = raw === "write" ? 2 : raw === "read" ? 1 : 0;
      }
      cfg.maxTokenPermissions = { unitAccessModes, idToken: form.maxIdToken === "write" };
    } else {
      cfg.maxTokenPermissions = null;
    }
  }
  return (await saveRepoActionsConfig(d1, repoId, cfg)) === "saved" ? "saved" : "missing";
}

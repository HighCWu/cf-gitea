import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import { repoSettings, repoUnits, repositories } from "../../db/schema";

/**
 * Upstream `PullRequestsConfig` (models/repo/repo_unit.go:119-137) — the
 * `TypePullRequests` unit's serialized config. Field names are the GO
 * MARSHAL names on purpose: `ToDB` is Go's `json.Marshal` of the struct
 * (repo_unit.go:167-170), so the `repo_units.config` JSON must carry exactly
 * these keys to stay column-for-column compatible with upstream rows — the
 * same convention the ActionsConfig store keeps (services/actions/config.ts).
 */
export interface PullRequestsConfig {
  IgnoreWhitespaceConflicts: boolean;
  AllowMerge: boolean;
  AllowRebase: boolean;
  AllowRebaseMerge: boolean;
  AllowSquash: boolean;
  AllowFastForwardOnly: boolean;
  AllowManualMerge: boolean;
  AutodetectManualMerge: boolean;
  AllowMergeUpdate: boolean;
  AllowRebaseUpdate: boolean;
  /** "merge" | "rebase" — upstream `UpdateStyle`. */
  DefaultUpdateStyle: string;
  DefaultDeleteBranchAfterMerge: boolean;
  /** "merge" | "rebase" | "rebase-merge" | "squash" | "fast-forward-only" |
   *  "manually-merged" — upstream `MergeStyle` (models/repo/git.go:17-27). */
  DefaultMergeStyle: string;
  /** "PR_BODY" | "COMMIT_MESSAGES" | "BLANK" — upstream `SquashMergeMessage`
   *  (models/repo/git.go:43-52). */
  DefaultSquashMergeMessage: string;
  DefaultAllowMaintainerEdit: boolean;
  DefaultTargetBranch: string;
}

/** `DefaultPullRequestsConfig` (repo_unit.go:139-156): the seven allow flags
 *  true, update style merge, maintainer edit true; the rest ride the app
 *  defaults (delete-after-merge false, merge style "merge", squash message
 *  "PR_BODY" — modules/setting/repository.go:204-210) and stay zero-valued.
 *  NOTE `AllowManualMerge` is the zero value FALSE here — upstream's
 *  missing-unit fallback in convert (repository.go:103) renders true, but
 *  every real repo carries the unit and its default config, so false is the
 *  normal-repo wire value. */
export const DEFAULT_PULL_REQUESTS_CONFIG: PullRequestsConfig = {
  IgnoreWhitespaceConflicts: false,
  AllowMerge: true,
  AllowRebase: true,
  AllowRebaseMerge: true,
  AllowSquash: true,
  AllowFastForwardOnly: true,
  AllowManualMerge: false,
  AutodetectManualMerge: false,
  AllowMergeUpdate: true,
  AllowRebaseUpdate: true,
  DefaultUpdateStyle: "merge",
  DefaultDeleteBranchAfterMerge: false,
  DefaultMergeStyle: "merge",
  DefaultSquashMergeMessage: "PR_BODY",
  DefaultAllowMaintainerEdit: true,
  DefaultTargetBranch: "",
};

/** The three valid `squash_merge_commit_message` values
 *  (SquashMergeMessage.IsValid, models/repo/git.go:51-53). */
export const SQUASH_MERGE_MESSAGES: readonly string[] = ["BLANK", "COMMIT_MESSAGES", "PR_BODY"];

/** The valid `projects_mode` values (upstream binding `In(repo,owner,all)`,
 *  structs/repo.go; ProjectsMode constants repo_unit.go:216-221). */
export const PROJECTS_MODES: readonly string[] = ["repo", "owner", "all"];

/**
 * `PullRequestsConfig.FromDB` (repo_unit.go:158-166): defaults first, then
 * the stored JSON overlay — a corrupted blob is IGNORED (upstream swallows
 * the unmarshal error "don't let corrupted database value cause unnecessary
 * 500 error"), a NULL config loads the plain defaults (xorm's BeforeSet
 * FromDB(nil) pass). The FromDB tail also re-arms DefaultUpdateStyle's
 * IfZero to "merge".
 */
export function pullRequestsConfigFromJson(raw: string | null): PullRequestsConfig {
  const config: PullRequestsConfig = { ...DEFAULT_PULL_REQUESTS_CONFIG };
  if (raw === null || raw === "") {
    return config;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      Object.assign(config, parsed);
    }
  } catch {
    // upstream's lenient unmarshal: keep the defaults
  }
  if (config.DefaultUpdateStyle !== "merge" && config.DefaultUpdateStyle !== "rebase") {
    config.DefaultUpdateStyle = "merge";
  }
  return config;
}

/**
 * `ValidateUpdateSettings` (repo_unit.go:194-206) — the update-style trio is
 * mutually consistent. Message texts verbatim; upstream answers them through
 * `APIErrorAuto` → `ErrInvalidArgument` = HTTP 400 (modules/util/error.go:24).
 */
export function validatePullRequestsUpdateSettings(config: PullRequestsConfig): string | null {
  if (config.DefaultUpdateStyle !== "merge" && config.DefaultUpdateStyle !== "rebase") {
    return "default update style must be merge or rebase";
  }
  if (!config.AllowMergeUpdate && !config.AllowRebaseUpdate) {
    return "at least one pull request branch update style must be enabled";
  }
  // IsUpdateStyleAllowed (repo_unit.go:183-191)
  const allowed = config.DefaultUpdateStyle === "merge" ? config.AllowMergeUpdate : config.AllowRebaseUpdate;
  if (!allowed) {
    return "default update style must be enabled";
  }
  return null;
}

/**
 * Repo-edit stored subset (SPEC-0004 §2.4 row: `PATCH /repos/{owner}/{repo}`
 * — the `EditRepoOption` fields that have no landed `repositories` column but
 * must survive a PATCH→GET round trip): description, website, and the has_*
 * unit flags. Everything else in the 39-field body is either applied through
 * the landed repos service (name/default_branch/private/archived — the route)
 * or accepted-and-ignored with the documented remainder (the model file).
 *
 * The table lives in the Drizzle schema (`repoSettings`, src/db/schema.ts)
 * and landed as migration 0007; D1 access goes through Drizzle per the
 * architecture boundary (no hand-written SQL in services). Superseded:
 * `REPO_SETTINGS_DDL_STATEMENTS` below is kept only as the historical record
 * of the pre-migration bootstrap (the batch-7 schema gap) — the generated
 * migration is authoritative now. The sweep kept the side table (1:1 on
 * `repo_id`, upstream keeps the columns on the repository row) so the hot
 * `repositories` schema stays untouched.
 *
 * Defaults: upstream arms the full DefaultRepoUnits at creation (code/
 * issues/pulls/releases/wiki/projects/packages/actions — models/unit/
 * unit.go:66-75), and since the 2026-10-29 upstream-parity flip the
 * creation writer does too: every repo is born with a seeded settings row
 * whose has_actions/has_packages follow upstream's per-kind unit lists
 * (actions + packages armed for normal creates; forks get neither;
 * mirrors get packages only — the DefaultRepoUnits switch,
 * services/repository/create.go:349-355; the seeding lives in
 * repos/service.ts create, one batch with the repository row). Projects
 * remains the one documented house divergence at creation (still false).
 * DEFAULT_REPO_SETTINGS below is deliberately the PRE-FLIP posture: it is
 * the missing-row fallback, and a missing row means a repo created before
 * the flip (or a hand-seeded row) — the on-disk posture of existing repos
 * is preserved, exactly as upstream's unit rows are written at creation
 * only.
 */

/**
 * SUPERSEDED by migration 0007 (`repoSettings` in src/db/schema.ts) — kept
 * only so pre-migration scratch databases can still be bootstrapped by hand.
 * Do not extend; change the schema + regenerate instead (AGENTS.md).
 */
export const REPO_SETTINGS_DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS repo_settings (
  repo_id TEXT NOT NULL PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  has_issues INTEGER NOT NULL DEFAULT 1,
  has_wiki INTEGER NOT NULL DEFAULT 1,
  has_pull_requests INTEGER NOT NULL DEFAULT 1,
  has_releases INTEGER NOT NULL DEFAULT 1,
  has_projects INTEGER NOT NULL DEFAULT 0,
  has_packages INTEGER NOT NULL DEFAULT 0,
  has_actions INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
)`,
];

/** The stored/rendered settings of one repository (upstream's unit flags +
 *  profile columns, plus the repo_units config stores: the pull_requests
 *  unit's config JSON rides `prUnit`, the projects unit's
 *  `ProjectsConfig.ProjectsMode` rides `projectsMode`). Missing row = the
 *  defaults. NOT carried here: `has_code` — upstream's presence-based
 *  UnitEnabled needs the CREATION-seeded code unit row (repos/service.ts
 *  create batch, outside this module's write paths) to distinguish "never
 *  disabled" from "disabled"; until that seed lands the flag stays
 *  accepted-and-ignored (the E1/E3 review drift stays open on it). */
export interface RepoSettings {
  description: string;
  website: string;
  hasIssues: boolean;
  hasWiki: boolean;
  hasPullRequests: boolean;
  hasReleases: boolean;
  hasProjects: boolean;
  hasPackages: boolean;
  hasActions: boolean;
  /** The TypePullRequests unit's stored config (services/repository.ts
   *  renders it as the allow_-prefixed and default_-prefixed wire family). */
  prUnit: PullRequestsConfig;
  /** The TypeProjects unit's `ProjectsConfig.ProjectsMode`
   *  (repo_unit.go:227-229) — "repo" | "owner" | "all". */
  projectsMode: string;
}

/** The missing-row fallback settings — deliberately the PRE-FLIP posture
 *  (actions/packages off, PR-unit + projects defaults). Repos created since
 *  the 2026-10-29 default-units flip carry a seeded row (repos/service.ts
 *  create) whose stored flags win; this fallback renders only for
 *  rows-missing repos (pre-flip creations, hand-seeded rows), preserving
 *  their on-disk posture. */
export const DEFAULT_REPO_SETTINGS: RepoSettings = {
  description: "",
  website: "",
  hasIssues: true,
  hasWiki: true,
  hasPullRequests: true,
  hasReleases: true,
  hasProjects: false,
  hasPackages: false,
  hasActions: false,
  prUnit: DEFAULT_PULL_REQUESTS_CONFIG,
  projectsMode: "all",
};

/** The unit rows' carried config stores: the two JSONs (one indexed read —
 *  the repoEdit parity wave folded the unit reads into this loader). */
function settingsFromUnitRows(rows: { type: string; config: string | null }[]): {
  prUnit: PullRequestsConfig;
  projectsMode: string;
} {
  let prUnitRaw: string | null = null;
  let projectsRaw: string | null = null;
  for (const row of rows) {
    if (row.type === "pull_requests") prUnitRaw = row.config;
    else if (row.type === "projects") projectsRaw = row.config;
  }
  let projectsMode = "all";
  if (projectsRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(projectsRaw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "ProjectsMode" in parsed &&
        typeof parsed.ProjectsMode === "string"
      ) {
        projectsMode = parsed.ProjectsMode;
      }
    } catch {
      // upstream's lenient unmarshal: keep the default mode
    }
  }
  return { prUnit: pullRequestsConfigFromJson(prUnitRaw), projectsMode };
}

/** The row → settings read; an absent row renders the defaults. */
export async function loadRepoSettings(d1: D1Database, repoId: string): Promise<RepoSettings> {
  const [row, unitRows] = await Promise.all([
    drizzle(d1).select().from(repoSettings).where(eq(repoSettings.repoId, repoId)).get(),
    drizzle(d1)
      .select({ type: repoUnits.type, config: repoUnits.config })
      .from(repoUnits)
      .where(eq(repoUnits.repoId, repoId))
      .all(),
  ]);
  const units = settingsFromUnitRows(unitRows);
  if (row === undefined) {
    return { ...DEFAULT_REPO_SETTINGS, ...units };
  }
  return {
    description: row.description,
    website: row.website,
    hasIssues: row.hasIssues,
    hasWiki: row.hasWiki,
    hasPullRequests: row.hasPullRequests,
    hasReleases: row.hasReleases,
    hasProjects: row.hasProjects,
    hasPackages: row.hasPackages,
    hasActions: row.hasActions,
    prUnit: units.prUnit,
    projectsMode: units.projectsMode,
  };
}

/** The PATCH write: upsert only the fields the body set (others keep their
 *  stored value — the merged row is computed read-then-apply and written via
 *  the `repo_id` PK conflict clause, preserving SQLite's single-row upsert).
 *
 *  The Actions unit-row maintenance rides the same write (upstream
 *  ActionsUnitPost, routers/web/repo/setting/actions.go:67-93: enable →
 *  `UpdateRepositoryUnits(ctx, repo, [newRepoUnit(repo, TypeActions, nil)], nil)`
 *  inserts the repo_unit row; disable → the deleteUnitTypes arm deletes it —
 *  services/repository/setting.go:19-52, one transaction). The row's presence
 *  IS the enabled state upstream (UnitEnabled reads the repo_unit rows,
 *  models/repo/repo.go:385-387), and our landed owner-scope runner scan gates
 *  on the SAME join (services/actions `scopeRepoIds`, the models/actions/
 *  task.go:280-284 port) — so a has_actions write that left the row unwritten
 *  made the scan blind to every production repo (the C9 unit-row gap). A
 *  packages write carries no row duty: its gate is the documented
 *  `has_packages` flag reduction (schema.ts's MustEnableRepoPackages note)
 *  with no row reader.
 *
 *  Both unit states ride ONE batch (a single SQLite transaction on D1), so
 *  the flag and the row can never commit divergently. The row write is
 *  unconditional in the unit's direction — insert is conflict-tolerant and
 *  delete affects zero rows when absent (upstream likewise rewrites the unit
 *  list on every toggle without consulting the previous state) — which also
 *  heals any pre-fix flag/row divergence on the next save.
 *
 *  The repoEdit parity wave rides the same lockstep for the two config
 *  carriers (upstream updateRepoUnits, routers/api/v1/repo/repo.go:754-985):
 *  `prUnit` writes the TypePullRequests row's config JSON (the
 *  `optional.AssignPtrValue` merges happen caller-side on the LOADED config
 *  — this store persists the full merged object); `hasPullRequests: false`
 *  DELETES that row (upstream's deleteUnitTypes arm wipes the config —
 *  re-enabling starts fresh at the defaults, repo.go:843-846) and
 *  `hasPullRequests: true` ensures it exists with the current-or-default
 *  config (the mustInsertPullRequestUnit arm, repo.go:955-965);
 *  `projectsMode` / `hasProjects` do the same for the TypeProjects row's
 *  `{"ProjectsMode": …}` JSON (repo.go:968-989). `has_code` stays unwritten
 *  (see the RepoSettings note). All writes batch with the settings upsert —
 *  one SQLite transaction for the whole PATCH. */

/** The PATCH write's patch shape: the repo_settings columns, plus the
 *  unit-config carriers. `prUnit` is a PARTIAL — merged over the stored
 *  config here (the caller hands the form's present fields only), matching
 *  upstream's per-field `optional.AssignPtrValue` arms. */
export interface RepoSettingsPatch {
  description?: string;
  website?: string;
  hasIssues?: boolean;
  hasWiki?: boolean;
  hasPullRequests?: boolean;
  hasReleases?: boolean;
  hasProjects?: boolean;
  hasPackages?: boolean;
  hasActions?: boolean;
  prUnit?: Partial<PullRequestsConfig>;
  projectsMode?: string;
}

export async function saveRepoSettings(
  d1: D1Database,
  repoId: string,
  patch: RepoSettingsPatch,
  now: Date,
): Promise<void> {
  const current = await loadRepoSettings(d1, repoId);
  const merged: RepoSettings = {
    ...current,
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.website !== undefined ? { website: patch.website } : {}),
    ...(patch.hasIssues !== undefined ? { hasIssues: patch.hasIssues } : {}),
    ...(patch.hasWiki !== undefined ? { hasWiki: patch.hasWiki } : {}),
    ...(patch.hasPullRequests !== undefined ? { hasPullRequests: patch.hasPullRequests } : {}),
    ...(patch.hasReleases !== undefined ? { hasReleases: patch.hasReleases } : {}),
    ...(patch.hasProjects !== undefined ? { hasProjects: patch.hasProjects } : {}),
    ...(patch.hasPackages !== undefined ? { hasPackages: patch.hasPackages } : {}),
    ...(patch.hasActions !== undefined ? { hasActions: patch.hasActions } : {}),
    ...(patch.prUnit !== undefined ? { prUnit: { ...current.prUnit, ...patch.prUnit } } : {}),
    ...(patch.projectsMode !== undefined ? { projectsMode: patch.projectsMode } : {}),
  };
  // The settings ROW carries only its own columns — the unit-config carriers
  // live on repo_units and are stripped from the upsert values.
  const values = {
    description: merged.description,
    website: merged.website,
    hasIssues: merged.hasIssues,
    hasWiki: merged.hasWiki,
    hasPullRequests: merged.hasPullRequests,
    hasReleases: merged.hasReleases,
    hasProjects: merged.hasProjects,
    hasPackages: merged.hasPackages,
    hasActions: merged.hasActions,
    updatedAt: now,
  };
  const db = drizzle(d1);
  const upsert = db
    .insert(repoSettings)
    .values({ repoId, ...values })
    .onConflictDoUpdate({ target: repoSettings.repoId, set: values });

  const unitWrites: BatchItem<"sqlite">[] = [];
  if (patch.hasActions !== undefined) {
    unitWrites.push(
      patch.hasActions === true
        ? db.insert(repoUnits).values({ repoId, type: "actions" }).onConflictDoNothing()
        : db.delete(repoUnits).where(and(eq(repoUnits.repoId, repoId), eq(repoUnits.type, "actions"))),
    );
  }
  if (patch.hasPullRequests !== undefined || patch.prUnit !== undefined) {
    if (patch.hasPullRequests === false) {
      // upstream's mustDeletePullRequestUnit arm: the unit (and its config)
      // goes; the merge-flag arms never ran for this PATCH (the route skips
      // them — repo.go:844 short-circuits the config block on delete).
      unitWrites.push(
        db.delete(repoUnits).where(and(eq(repoUnits.repoId, repoId), eq(repoUnits.type, "pull_requests"))),
      );
    } else {
      // Insert-with-current-config (has_pull_requests=true without flags —
      // mustInsertPullRequestUnit) or the merged config (the AssignPtr arms).
      unitWrites.push(
        db
          .insert(repoUnits)
          .values({ repoId, type: "pull_requests", config: JSON.stringify(merged.prUnit) })
          .onConflictDoUpdate({
            target: [repoUnits.repoId, repoUnits.type],
            set: { config: JSON.stringify(merged.prUnit) },
          }),
      );
    }
  }
  if (patch.hasProjects !== undefined || patch.projectsMode !== undefined) {
    if (patch.hasProjects === false) {
      unitWrites.push(
        db.delete(repoUnits).where(and(eq(repoUnits.repoId, repoId), eq(repoUnits.type, "projects"))),
      );
    } else {
      const config = JSON.stringify({ ProjectsMode: merged.projectsMode });
      unitWrites.push(
        db
          .insert(repoUnits)
          .values({ repoId, type: "projects", config })
          .onConflictDoUpdate({ target: [repoUnits.repoId, repoUnits.type], set: { config } }),
      );
    }
  }

  if (unitWrites.length === 0) {
    await upsert;
    return;
  }
  await db.batch([upsert, ...unitWrites] as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

/** Repo-scoped settings delete (the api repoDelete path's housekeeping; the
 *  deleteRepository cascade covers the same rows through the schema table). */
export async function deleteRepoSettings(d1: D1Database, repoId: string): Promise<void> {
  await drizzle(d1).delete(repoSettings).where(eq(repoSettings.repoId, repoId));
}

/**
 * The archived flip (upstream SetArchiveRepo — the settings danger zone's
 * archive/unarchive POST, routers/web/repo/setting/setting.go:1005-1064, and
 * the API PATCH arm's `form.archived` update). The `repositories.is_archived`
 * column is the whole stored state at this pin (no archived_unix column
 * landed); the caller owns upstream's mirror refusal
 * (`repo.settings.archive.error_ismirror` — handleSettingsPostArchive:1009)
 * because it needs the mirror read, so this arm is the unconditional write.
 */
export async function setRepoArchived(d1: D1Database, repoId: string, archived: boolean, now: Date): Promise<void> {
  await drizzle(d1)
    .update(repositories)
    .set({ isArchived: archived, updatedAt: now })
    .where(eq(repositories.id, repoId));
}

/**
 * The template flag flip (upstream updateBasicProperties —
 * routers/api/v1/repo/repo.go:699-701 `if opts.Template != nil { repo.IsTemplate
 * = *opts.Template }`, persisted by UpdateRepository; the web settings basic
 * form's `template` checkbox posts it). The `repositories.is_template` column
 * gates generate-repo's eligibility check and the template badge render —
 * D1-only, no engine seam.
 */
export async function setRepoTemplate(d1: D1Database, repoId: string, isTemplate: boolean, now: Date): Promise<void> {
  await drizzle(d1)
    .update(repositories)
    .set({ isTemplate, updatedAt: now })
    .where(eq(repositories.id, repoId));
}

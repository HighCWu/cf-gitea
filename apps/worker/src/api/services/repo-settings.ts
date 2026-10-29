import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";

import { repoSettings, repoUnits, repositories } from "../../db/schema";

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
 * Defaults are the landed house posture: code/issues/pulls/releases/wiki
 * enabled, projects/packages/actions disabled (upstream's DefaultRepoUnits at
 * the pin actually enables projects, packages AND actions —
 * models/unit/unit.go:60-72; the disabled-on-arrival trio is a documented
 * house divergence, the default-false render posture), with empty
 * description/website.
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
 *  profile columns). Missing row = the defaults. */
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
}

/** The upstream-default settings (what every repo renders before a PATCH). */
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
};

/** The row → settings read; an absent row renders the defaults. */
export async function loadRepoSettings(d1: D1Database, repoId: string): Promise<RepoSettings> {
  const row = await drizzle(d1)
    .select()
    .from(repoSettings)
    .where(eq(repoSettings.repoId, repoId))
    .get();
  if (row === undefined) {
    return DEFAULT_REPO_SETTINGS;
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
 *  heals any pre-fix flag/row divergence on the next save. */
export async function saveRepoSettings(
  d1: D1Database,
  repoId: string,
  patch: Partial<RepoSettings>,
  now: Date,
): Promise<void> {
  const current = await loadRepoSettings(d1, repoId);
  const merged = { ...current, ...patch };
  const values = { ...merged, updatedAt: now };
  const db = drizzle(d1);
  const upsert = db
    .insert(repoSettings)
    .values({ repoId, ...values })
    .onConflictDoUpdate({ target: repoSettings.repoId, set: values });
  if (patch.hasActions === undefined) {
    await upsert;
    return;
  }
  const unitWrite =
    patch.hasActions === true
      ? db.insert(repoUnits).values({ repoId, type: "actions" }).onConflictDoNothing()
      : db.delete(repoUnits).where(and(eq(repoUnits.repoId, repoId), eq(repoUnits.type, "actions")));
  await db.batch([upsert, unitWrite]);
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

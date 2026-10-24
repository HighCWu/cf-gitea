/**
 * Repo-edit stored subset (SPEC-0004 §2.4 row: `PATCH /repos/{owner}/{repo}`
 * — the `EditRepoOption` fields that have no landed `repositories` column but
 * must survive a PATCH→GET round trip): description, website, and the has_*
 * unit flags. Everything else in the 39-field body is either applied through
 * the landed repos service (name/default_branch/private/archived — the route)
 * or accepted-and-ignored with the documented remainder (the model file).
 *
 * SCHEMA GAP (the raw-D1 + DDL-comment pattern of SPEC-0006's LFS
 * bootstrap): `src/db/schema.ts` is owned by a parallel change this batch and
 * migrations must not be hand-edited, so this column set lives OUTSIDE the
 * Drizzle schema for now, accessed with prepared statements from this mapper
 * (never in routes). DDL for the migration owner's sweep is
 * `REPO_SETTINGS_DDL_STATEMENTS`; the sweep folds these into `repositories`
 * columns (upstream keeps them on the repository row itself) or a dedicated
 * table, adds it to the delete cascade, and deletes this mapper.
 *
 * Defaults are upstream's: `DefaultRepoUnits` (code/issues/pulls/releases
 * enabled, wiki enabled, projects/packages/actions disabled — the exact
 * values services/repository.ts renders today) with empty description/
 * website.
 */

/**
 * Pre-migration bootstrap DDL (superseded by the schema entry the migration
 * owner lands; kept exactly like `LFS_OBJECTS_DDL_STATEMENTS`).
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
  const row = await d1
    .prepare(
      `SELECT description, website, has_issues, has_wiki, has_pull_requests,
              has_releases, has_projects, has_packages, has_actions
       FROM repo_settings WHERE repo_id = ?1`,
    )
    .bind(repoId)
    .first<{
      description: string;
      website: string;
      has_issues: number;
      has_wiki: number;
      has_pull_requests: number;
      has_releases: number;
      has_projects: number;
      has_packages: number;
      has_actions: number;
    }>();
  if (row === null) {
    return DEFAULT_REPO_SETTINGS;
  }
  return {
    description: row.description,
    website: row.website,
    hasIssues: row.has_issues === 1,
    hasWiki: row.has_wiki === 1,
    hasPullRequests: row.has_pull_requests === 1,
    hasReleases: row.has_releases === 1,
    hasProjects: row.has_projects === 1,
    hasPackages: row.has_packages === 1,
    hasActions: row.has_actions === 1,
  };
}

/** The PATCH write: upsert only the fields the body set (others keep their
 *  stored value — SQLite preserves them via the ON CONFLICT clause). */
export async function saveRepoSettings(
  d1: D1Database,
  repoId: string,
  patch: Partial<RepoSettings>,
  now: Date,
): Promise<void> {
  const current = await loadRepoSettings(d1, repoId);
  const merged = { ...current, ...patch };
  await d1
    .prepare(
      `INSERT INTO repo_settings (repo_id, description, website, has_issues, has_wiki,
                                  has_pull_requests, has_releases, has_projects, has_packages,
                                  has_actions, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (repo_id) DO UPDATE SET
         description = ?2, website = ?3, has_issues = ?4, has_wiki = ?5,
         has_pull_requests = ?6, has_releases = ?7, has_projects = ?8,
         has_packages = ?9, has_actions = ?10, updated_at = ?11`,
    )
    .bind(
      repoId,
      merged.description,
      merged.website,
      merged.hasIssues ? 1 : 0,
      merged.hasWiki ? 1 : 0,
      merged.hasPullRequests ? 1 : 0,
      merged.hasReleases ? 1 : 0,
      merged.hasProjects ? 1 : 0,
      merged.hasPackages ? 1 : 0,
      merged.hasActions ? 1 : 0,
      Math.floor(now.getTime() / 1000),
    )
    .run();
}

/** Repo-scoped settings delete (the api repoDelete path's housekeeping). */
export async function deleteRepoSettings(d1: D1Database, repoId: string): Promise<void> {
  await d1.prepare("DELETE FROM repo_settings WHERE repo_id = ?1").bind(repoId).run();
}

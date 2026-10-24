import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { repoSettings } from "../../db/schema";

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
 * Defaults are upstream's: `DefaultRepoUnits` (code/issues/pulls/releases
 * enabled, wiki enabled, projects/packages/actions disabled — the exact
 * values services/repository.ts renders today) with empty description/
 * website.
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
 *  the `repo_id` PK conflict clause, preserving SQLite's single-row upsert). */
export async function saveRepoSettings(
  d1: D1Database,
  repoId: string,
  patch: Partial<RepoSettings>,
  now: Date,
): Promise<void> {
  const current = await loadRepoSettings(d1, repoId);
  const merged = { ...current, ...patch };
  const values = { ...merged, updatedAt: now };
  await drizzle(d1)
    .insert(repoSettings)
    .values({ repoId, ...values })
    .onConflictDoUpdate({ target: repoSettings.repoId, set: values });
}

/** Repo-scoped settings delete (the api repoDelete path's housekeeping; the
 *  deleteRepository cascade covers the same rows through the schema table). */
export async function deleteRepoSettings(d1: D1Database, repoId: string): Promise<void> {
  await drizzle(d1).delete(repoSettings).where(eq(repoSettings.repoId, repoId));
}

import { env } from "cloudflare:workers";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";

/**
 * Test bootstrap for the batch-7 raw-D1 stores — retired into the migration
 * path by the 0007 sweep (the 0005 consolidation pattern): the five tables
 * the four batch-7 services plus `follows` used to bootstrap by hand
 * (repo_topics, repo_watchers, repo_collaborators, repo_settings, follows)
 * are in the generated migrations now, so this module just applies them. The
 * historical name (`applyRepoExtrasDdl`) stays so callers need not change;
 * the per-service DDL constants survive only as superseded records.
 *
 * The vitest plugin's per-file storage isolation retains schema created in
 * `beforeAll` for every test in the file; `IF NOT EXISTS` semantics are
 * inherited from the migration ledger (d1_migrations), not needed here.
 */
export async function applyRepoExtrasDdl(): Promise<void> {
  await applyAuthD1Migrations();
}

/** Clear the batch-7 stores between tests (schema persists; only rows are
 *  per-test scratch). */
export async function resetRepoExtrasTables(): Promise<void> {
  for (const table of ["repo_topics", "repo_watchers", "repo_collaborators", "repo_settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

import { env } from "cloudflare:workers";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { REPO_COLLABORATORS_DDL_STATEMENTS } from "../services/repo-collaborators";
import { REPO_SETTINGS_DDL_STATEMENTS } from "../services/repo-settings";
import { REPO_TOPICS_DDL_STATEMENTS } from "../services/repo-topics";
import { REPO_WATCHERS_DDL_STATEMENTS } from "../services/repo-watchers";

/**
 * Test bootstrap for the batch-7 raw-D1 stores (the LFS `testing.ts`
 * pattern): the generated migrations cover the landed tables; the four
 * batch-7 stores (repo_topics, repo_watchers, repo_collaborators,
 * repo_settings) are the documented SCHEMA GAP and bootstrap from their
 * services' DDL statements until the migration owner's sweep lands them in
 * schema.ts. `IF NOT EXISTS` keeps repeat applications (per-file isolation)
 * idempotent.
 */
export async function applyRepoExtrasDdl(): Promise<void> {
  await applyAuthD1Migrations();
  for (const statement of [
    ...REPO_TOPICS_DDL_STATEMENTS,
    ...REPO_WATCHERS_DDL_STATEMENTS,
    ...REPO_COLLABORATORS_DDL_STATEMENTS,
    ...REPO_SETTINGS_DDL_STATEMENTS,
  ]) {
    await env.DB.prepare(statement).run();
  }
}

/** Clear the batch-7 raw stores between tests (schema persists). */
export async function resetRepoExtrasTables(): Promise<void> {
  for (const table of ["repo_topics", "repo_watchers", "repo_collaborators", "repo_settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

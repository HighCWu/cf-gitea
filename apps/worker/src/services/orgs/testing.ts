/**
 * Test bootstrap for the SPEC-0007 suites (the LFS `testing.ts` pattern):
 * real D1 from the wrangler.jsonc binding, no mocks.
 *
 * The org schema is in the generated migrations (migration 0005), so the
 * bootstrap applies the migrations — the vitest plugin's per-file storage
 * isolation retains schema created in `beforeAll` for every test in the
 * file. The function keeps its historical name (`applyOrgsDdl`) so callers
 * need not change; the pre-migration DDL bootstrap it replaced lives on only
 * as the superseded `ORG_DDL_STATEMENTS` constant.
 */

import { env } from "cloudflare:workers";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";

/** Apply the generated Drizzle migrations (creates the org tables). */
export async function applyOrgsDdl(): Promise<void> {
  await applyAuthD1Migrations();
}

/** Clear rows between tests (schema persists; only rows are per-test scratch).
 *  The seeded 'assets' reservation row (migration 0003) is preserved — it is
 *  load-bearing for the reserved-name tests. `team_repo_access` is swept
 *  explicitly (repo_id declares no FK); `teams`/`team_members` cascade with
 *  the users rows. */
export async function resetOrgTables(): Promise<void> {
  for (const table of [
    "team_repo_access",
    "org_members",
    "user_redirects",
    "repo_units",
    "repo_counters",
    "repo_redirects",
    "repo_transfer",
    "repositories",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
}

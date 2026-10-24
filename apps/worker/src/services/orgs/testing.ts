/**
 * Test bootstrap for the SPEC-0007 suites (the LFS `testing.ts` pattern):
 * real D1 from the wrangler.jsonc binding, no mocks.
 *
 * The org schema is not in the generated migrations yet (schema.ts is owned
 * by another change), so suites apply the landed migrations
 * (`applyAuthD1Migrations`) plus `ORG_DDL_STATEMENTS` in a top-level
 * `beforeAll` — the vitest plugin's per-file storage isolation retains
 * schema created in `beforeAll` for every test in the file. TODO: delete
 * this module once the drizzle migration lands and migrations cover the
 * tables.
 */

import { env } from "cloudflare:workers";

import { ORG_DDL_STATEMENTS } from "./orgs";

export async function applyOrgsDdl(): Promise<void> {
  for (const statement of ORG_DDL_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
}

/** Clear rows between tests (schema persists; only rows are per-test scratch).
 *  The seeded 'assets' reservation row (migration 0003) is preserved — it is
 *  load-bearing for the reserved-name tests. */
export async function resetOrgTables(): Promise<void> {
  for (const table of [
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

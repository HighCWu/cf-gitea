/**
 * Apply the generated Drizzle migrations (src/db/migrations) to the test
 * worker's real local D1 — the src/issues test-side of the pattern proven by
 * src/auth/testing/apply-d1-migrations.ts. The migration list is injected by
 * vitest.config.ts via `readD1Migrations` on the Node side (plain
 * `TEST_MIGRATIONS` binding — wrangler.jsonc stays untouched).
 *
 * Test files call `applyIssuesD1Migrations()` from a top-level `beforeAll`:
 * the vitest plugin's per-test storage isolation discards writes made in
 * `setupFiles`, but schema applied in `beforeAll` persists for every test in
 * the file.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

export async function applyIssuesD1Migrations(): Promise<void> {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

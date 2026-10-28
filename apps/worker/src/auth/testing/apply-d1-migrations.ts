/**
 * Apply the generated Drizzle migrations (src/db/migrations) to the test
 * worker's real local D1. The migration list is injected by vitest.config.ts
 * via `readD1Migrations` on the Node side (plain `TEST_MIGRATIONS` binding —
 * wrangler.jsonc stays untouched).
 *
 * Integration test files call `applyAuthD1Migrations()` from a top-level
 * `beforeAll`. Caution: the vitest plugin's storage isolation is per test —
 * on the current @cloudflare/vitest-plugin it resets the isolated storage
 * (D1 schema included) between tests, so schema applied in `beforeAll` does
 * NOT persist for every test in the file (an earlier "persists" note here was
 * empirically falsified: a test observed the reset and had to re-apply the
 * migrations itself). Callers must not assume persistence across tests —
 * re-apply (or otherwise provision the schema) wherever a test needs it.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

export async function applyAuthD1Migrations(): Promise<void> {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

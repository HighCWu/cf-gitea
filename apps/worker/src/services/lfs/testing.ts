/**
 * Test bootstrap for the SPEC-0006 suites (the auth `testing/` pattern):
 * real D1 + real R2 from wrangler.jsonc bindings, no mocks.
 *
 * `lfs_objects` is not in the generated migrations yet (schema.ts is owned by
 * another change), so suites create it from `LFS_OBJECTS_DDL_STATEMENTS` in a
 * top-level `beforeAll` — the vitest plugin's per-file storage isolation
 * discards other files' writes but retains schema created in `beforeAll` for
 * every test in the file. TODO: delete this module once the drizzle migration
 * lands and migrations cover the table.
 */

import { env } from "cloudflare:workers";

import { LFS_OBJECTS_DDL_STATEMENTS } from "./state";

export async function applyLfsObjectsDdl(): Promise<void> {
  for (const statement of LFS_OBJECTS_DDL_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
}

/** Clear rows between tests (schema persists; only rows are per-test scratch). */
export async function resetLfsTables(): Promise<void> {
  await env.DB.prepare("DELETE FROM lfs_objects").run();
}

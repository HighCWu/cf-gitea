/**
 * Test bootstrap for the SPEC-0006 suites (the auth `testing/` pattern):
 * real D1 + real R2 from wrangler.jsonc bindings, no mocks.
 *
 * `lfs_objects` is in the generated migrations (migration 0005), so the
 * bootstrap applies the migrations — the vitest plugin's per-file storage
 * isolation discards other files' writes but retains schema created in
 * `beforeAll` for every test in the file. The function keeps its historical
 * name (`applyLfsObjectsDdl`) so callers need not change; the pre-migration
 * DDL bootstrap it replaced lives on only as the superseded
 * `LFS_OBJECTS_DDL_STATEMENTS` constant.
 */

import { env } from "cloudflare:workers";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";

/** Apply the generated Drizzle migrations (creates `lfs_objects`). */
export async function applyLfsObjectsDdl(): Promise<void> {
  await applyAuthD1Migrations();
}

/** Clear rows between tests (schema persists; only rows are per-test scratch). */
export async function resetLfsTables(): Promise<void> {
  await env.DB.prepare("DELETE FROM lfs_objects").run();
}

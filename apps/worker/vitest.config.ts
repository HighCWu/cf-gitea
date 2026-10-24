import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run in workerd against the real local bindings declared in
// wrangler.jsonc (D1, R2, DOs) — per ADR-0001 D4. @cloudflare/vitest-plugin
// is the stable successor of the deprecated @cloudflare/vitest-pool-workers
// (same miniflare under the hood; AGENTS.md dependency policy: current
// stable, never alpha/beta).
export default defineConfig(async () => {
  // SPEC-0002: real-D1 auth tests run against the generated Drizzle
  // migrations. The migration list is read on the Node side and injected as
  // a plain binding; integration test files apply it in a top-level
  // beforeAll via src/auth/testing/apply-d1-migrations.ts (the plugin's
  // per-test storage isolation discards setupFiles-era D1 writes).
  const migrations = await readD1Migrations("./src/db/migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
  };
});

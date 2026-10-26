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
    // Full-suite runs spawn >100 isolated workerd workers on one box; under
    // that contention the 5s default produced mass timeout flakes in
    // engine/git-http/UI files that pass solo (observed 2026-10-26: 65-75
    // failures across three full runs, zero real assertions). 20s keeps the
    // bound meaningful while absorbing the contention spike.
    test: { testTimeout: 20_000 },
  };
});

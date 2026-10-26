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
    // Full-suite runs spawn one isolated workerd (Miniflare) per test file
    // (~150 per run); under that contention the 5s default produced mass
    // timeout flakes in engine/git-http/UI files that pass solo (observed
    // 2026-10-26: 65-75 failures across three full runs, zero real
    // assertions). wave-27 measurements: hookTimeout 20s eliminated the
    // whole-file hook-timeout class (10/8/4 files per run -> 0), but the
    // heavy closure-walk tests (invariants "deleting a tree's pack" =
    // 13.6s on a quiet box) still crossed 20s under load (1.48x inflation
    // observed), and 4 beforeAll hooks crossed 20s in one run. 30s gives
    // the known-heavy fixtures/walks ~2.2x their quiet-time headroom while
    // still bounding genuine hangs.
    test: { testTimeout: 30_000, hookTimeout: 30_000 },
    // vitest's default for `vitest run` is availableParallelism() - 1 — 31
    // concurrent Miniflare instances on the 32-core dev box. Each instance is
    // a workerd process warming up at once (startup ~1.7s quiet, ~3.2s under
    // load), which is the contention behind hook timeouts, 20s+ test
    // timeouts (invariants evictRepo fixtures), and workerd "internal error"
    // / WebSocket 1009 / kj-pipe abort noise. 8 keeps ~4x headroom for
    // sibling agents' gates on the shared box at a modest wall-clock cost.
    maxWorkers: 8,
  };
});

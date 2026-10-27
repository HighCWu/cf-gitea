import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig, type Plugin } from "vitest/config";

// Tests run in workerd against the real local bindings declared in
// wrangler.jsonc (D1, R2, DOs) — per ADR-0001 D4. @cloudflare/vitest-plugin
// is the stable successor of the deprecated @cloudflare/vitest-pool-workers
// (same miniflare under the hood; AGENTS.md dependency policy: current
// stable, never alpha/beta).

/**
 * B-lever from docs/research/ws1009-graph-sizing.md (§4.B): stop shipping
 * dev-transform sourcemaps in the vitest run.
 *
 * The pool's `fetchWarmModules` reply ships every module's fsModuleCache file
 * verbatim as `code`; vite's dev-SSR transform inlines a base64 sourcemap
 * comment into that code (13.09 MB of the 21.28 MB per-alias core payload,
 * 61.5% — the single biggest byte family behind the workerd WebSocket 1009
 * "Message is too large" deaths). There is no first-class knob for dev-SSR
 * map emission, so this plugin zeroes the map at the last transform stage
 * instead.
 *
 * Mechanism (verified against installed vite 8.3.5 / vitest 5.0.5 sources):
 * 1. A transform hook that returns `{ code, map: { mappings: "" } }` makes
 *    vite's `_getCombinedSourcemap()` discard the whole accumulated chain
 *    (`mappings === ""` short-circuits to `{ mappings: "" }`).
 * 2. vite's `ssrTransformScript` propagates that verbatim
 *    (`if (inMap?.mappings === "") map = inMap`), so the module graph's
 *    `transformResult.map` is `{ mappings: "" }`.
 * 3. vitest's `inlineSourceMap()` bails on maps without a `version` key, so
 *    no `//# sourceMappingURL=data:...` comment is ever appended, and
 *    `saveCachedModule` writes the map-less code (metadata records
 *    `mappings: true`; read-back stays consistent).
 *
 * Tradeoff (accepted, CI-only): failure stack traces in full-run mode lose
 * original-position mapping (frames point at transformed code). Solo/local
 * dev runs keep sourcemaps — the strip is fully gated on the env var.
 *
 * The plugin name encodes the mode on purpose: vitest's fsModuleCache key
 * hashes the resolved plugin-name list, so flipping the env var invalidates
 * stale cache entries instead of serving them (a cache file written with
 * maps would otherwise keep shipping them after the flag flips).
 */
function sourcemapStripPlugin(): Plugin {
  const active = process.env.CF_TEST_STRIP_SOURCEMAPS === "1";
  return {
    name: active
      ? "cf-strip-test-sourcemaps:strip"
      : "cf-strip-test-sourcemaps:keep",
    // Runs after every core/user transform (esbuild, import analysis, ...),
    // so the accumulated esbuild/SSR map chain is already in place when the
    // empty map kills it. Code is passed through untouched.
    enforce: "post",
    transform: {
      order: "post",
      handler(code) {
        if (!active) return null;
        return { code, map: { mappings: "" } };
      },
    },
  };
}

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
      sourcemapStripPlugin(),
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

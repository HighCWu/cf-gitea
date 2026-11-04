/**
 * miniflare-resolve.mjs — locate the repo's pinned miniflare for the
 * hash-bench workerd runner.
 *
 * The workerd measurements in docs/research/hash-bench-phase-b.md run in the
 * SAME local runtime the repo's own dev/test loops use: the miniflare 5.x
 * pin that wrangler/vite-plugin/vitest-plugin coordinate on
 * (`miniflare 5.20261023.0-beta` -> workerd 1.20261023.1, matching
 * apps/worker/wrangler.jsonc's compatibility_date 2026-10-23; see AGENTS.md
 * "Dependencies -> Intentional holds" and docs/research/miniflare-beta-pin.md).
 *
 * miniflare is a TRANSITIVE dep of apps/worker (via wrangler), so under
 * pnpm's isolated layout it lives in the .pnpm store, not at
 * apps/worker/node_modules/miniflare. We resolve it by globbing the store —
 * no new dependency is added anywhere (this harness imports it in place).
 *
 * Zero npm deps. Node >= 22.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(thisDir, "..", "..", "..");

/**
 * The pinned version the repo coordinates on (wrangler.jsonc comment:
 * "wrangler 4.153.0 pairs miniflare 5.20261023.0-beta / workerd
 * 1.20261023.1"). Kept as a literal so a store re-shape fails LOUDLY here
 * instead of silently measuring on some other workerd.
 */
export const PINNED_MINIFLARE = "5.20261023.0-beta";

/**
 * Resolve the pinned miniflare package directory.
 * @returns {Promise<{dir: string, version: string, entryUrl: URL}>}
 */
export async function resolveMiniflare() {
  const pnpmStore = path.join(repoRoot, "node_modules", ".pnpm");
  const candidates = [];
  if (fs.existsSync(pnpmStore)) {
    // Prefer the exact pin; fall back to whatever miniflare@5.x the store
    // carries (sorted desc), so a future coordinated bump keeps the harness
    // working — the report always prints the version it measured on.
    const entries = fs
      .readdirSync(pnpmStore)
      .filter((e) => e.startsWith("miniflare@"))
      .sort();
    for (const wanted of [PINNED_MINIFLARE, null]) {
      for (const e of entries) {
        if (wanted !== null && !e.startsWith(`miniflare@${wanted}_`)) continue;
        const dir = path.join(pnpmStore, e, "node_modules", "miniflare");
        if (fs.existsSync(path.join(dir, "package.json"))) candidates.push(dir);
      }
      if (candidates.length > 0) break;
    }
  }
  // Last resort: a hoisted/minified layout where miniflare IS resolvable.
  const hoisted = path.join(repoRoot, "node_modules", "miniflare");
  if (fs.existsSync(path.join(hoisted, "package.json"))) candidates.push(hoisted);

  if (candidates.length === 0) {
    throw new Error(
      `miniflare not found in ${pnpmStore} — run \`pnpm install\` at the repo root first ` +
        `(the harness imports the repo's OWN pinned miniflare; it never installs anything)`,
    );
  }

  const dir = candidates[0];
  const pkg = JSON.parse(
    await fs.promises.readFile(path.join(dir, "package.json"), "utf8"),
  );
  // miniflare 5: ESM entry under dist/src/index.js (module field) or via
  // exports.import. Prefer both known shapes, then main.
  const entryRels = [
    pkg.exports?.["."]?.import,
    pkg.module,
    pkg.main,
  ].filter(Boolean);
  for (const rel of entryRels) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs)) {
      return {
        dir,
        version: pkg.version,
        entryUrl: pathToFileURL(abs),
      };
    }
  }
  throw new Error(`cannot locate miniflare entry in ${dir} (exports/module/main all missing)`);
}

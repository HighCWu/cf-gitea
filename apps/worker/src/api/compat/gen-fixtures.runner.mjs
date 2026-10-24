#!/usr/bin/env node
/**
 * Runner that regenerates `apps/worker/src/api/compat/tier1-fixtures.json`
 * from the frozen contract (one-liner, no package.json script):
 *
 *   node apps/worker/src/api/compat/gen-fixtures.runner.mjs
 *
 * Same mechanism as scripts/check-openapi.mjs: the pure TypeScript generator
 * (apps/worker/src/api/compat/gen-fixtures.ts) is bundled with the
 * workspace's existing vite into a temporary ESM file and imported — vite
 * handles TypeScript, extensionless imports and the `?raw` SPEC import. The
 * runner itself only does I/O (read contract, write fixtures), which the
 * generator deliberately avoids so it stays importable from the workerd test
 * pool.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import console from "node:console";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

// compat/ → api/ → src/ → apps/worker/ → apps/ → repo root.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const WORKER_DIR = path.join(repoRoot, "apps", "worker");
const GENERATOR_ENTRY = "src/api/compat/gen-fixtures.ts";
const CONTRACT = path.join(repoRoot, "apps", "worker", "src", "compat", "contract", "v1-swagger.generated.json");
const OUTPUT = path.join(repoRoot, "apps", "worker", "src", "api", "compat", "tier1-fixtures.json");

async function loadGenerator() {
  const workerRequire = createRequire(pathToFileURL(path.join(WORKER_DIR, "package.json")));
  const { build } = await import(workerRequire.resolve("vite"));

  const outDir = await mkdtemp(path.join(tmpdir(), "cf-gitea-fixtures-"));
  try {
    await build({
      root: WORKER_DIR,
      configFile: false,
      logLevel: "warn",
      build: { ssr: GENERATOR_ENTRY, outDir, emptyOutDir: true, minify: false },
      ssr: { noExternal: true },
    });
    return await import(pathToFileURL(path.join(outDir, "gen-fixtures.js")).href);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

const { generateTier1Fixtures, parseSwagger2Contract } = await loadGenerator();
const contract = parseSwagger2Contract(await readFile(CONTRACT, "utf8"));
const fixtures = generateTier1Fixtures(contract);
await writeFile(OUTPUT, `${JSON.stringify(fixtures, null, 2)}\n`, "utf8");
console.log(
  `wrote ${path.relative(repoRoot, OUTPUT)}: ${fixtures.meta.counts.operations} operations across ${fixtures.meta.counts.paths} paths`,
);

#!/usr/bin/env node
/**
 * One-click deploy bootstrap (docs/ops/deploy-notes.md):
 *   1. verify wrangler login;
 *   2. ensure D1 `cf-gitea` exists (create if missing) and read its database_id;
 *   3. ensure R2 bucket `cf-gitea-packs` exists (create if missing);
 *   4. fill the real database_id into apps/worker/wrangler.jsonc (comment-preserving
 *      single-line swap of the placeholder — wrangler.jsonc is committed and is the
 *      single source of truth; only the account-specific id is patched);
 *   5. apply remote D1 migrations.
 *
 * Idempotent: safe to re-run; existing resources are reused, an already-filled
 * database_id is left untouched. `--check` runs everything read-only (login +
 * resource detection + placeholder presence) and exits non-zero on drift — used
 * by CI/orchestration. Run via the root script: `pnpm setup:deploy`.
 *
 * Design note (AGENTS.md Structure Rules): wrangler.jsonc stays COMMITTED with a
 * placeholder id until self-hosting ships; the example-file model (wrangler.jsonc
 * gitignored + deterministic installer) is the planned graduation, per gitorange.
 */
import { execFileSync } from "node:child_process";
import console from "node:console";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "apps", "worker");
const WRANGLER_CONFIG = path.join(workerDir, "wrangler.jsonc");
const D1_NAME = "cf-gitea";
const R2_NAME = "cf-gitea-packs";
const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const CHECK = process.argv.includes("--check");

const wrangler = (args) =>
  JSON.parse(execFileSync("pnpm", ["exec", "wrangler", ...args, "--json"], {
    cwd: workerDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));

/** `wrangler r2 bucket list` has no --json — parse its plain-text output. */
const r2BucketNames = () => {
  const out = execFileSync("pnpm", ["exec", "wrangler", "r2", "bucket", "list"], {
    cwd: workerDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return [...out.matchAll(/^name:\s+(\S+)\s*$/gm)].map((m) => m[1]);
};

const fail = (msg) => {
  console.error(`[fail] ${msg}`);
  process.exit(1);
};

// 1. login check (whoami has no --json; treat non-zero exit as not logged in)
try {
  execFileSync("pnpm", ["exec", "wrangler", "whoami"], { cwd: workerDir, encoding: "utf8", stdio: "ignore" });
} catch {
  fail("wrangler is not authenticated — run `npx wrangler login` first");
}

// 2. D1
const databases = wrangler(["d1", "list"]);
let db = databases.find((d) => d.name === D1_NAME);
if (!db) {
  if (CHECK) fail(`D1 ${D1_NAME} missing (check mode — run without --check to create)`);
  console.log(`creating D1 ${D1_NAME}...`);
  db = wrangler(["d1", "create", D1_NAME]);
}
const databaseId = db.database_id ?? db.uuid ?? db.id ?? fail("could not read database_id from wrangler output");
console.log(`[ok] D1 ${D1_NAME} (${databaseId})`);

// 3. R2
const buckets = r2BucketNames();
if (!buckets.includes(R2_NAME)) {
  if (CHECK) fail(`R2 ${R2_NAME} missing (check mode — run without --check to create)`);
  console.log(`creating R2 bucket ${R2_NAME}...`);
  execFileSync("pnpm", ["exec", "wrangler", "r2", "bucket", "create", R2_NAME], {
    cwd: workerDir,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (!r2BucketNames().includes(R2_NAME)) fail(`R2 ${R2_NAME} did not appear after create`);
}
console.log(`[ok] R2 ${R2_NAME}`);

// 4. patch wrangler.jsonc (single-line swap, comments preserved)
const config = await readFile(WRANGLER_CONFIG, "utf8");
if (config.includes(`"database_id": "${databaseId}"`)) {
  console.log("[ok] wrangler.jsonc already carries the real database_id");
} else {
  const needle = `"database_id": "${PLACEHOLDER}"`;
  if (!config.includes(needle)) {
    fail(`wrangler.jsonc has neither the real id nor the expected placeholder ${PLACEHOLDER} — patch manually`);
  }
  if (CHECK) fail("wrangler.jsonc still has the placeholder database_id (check mode — run without --check to fill)");
  await writeFile(WRANGLER_CONFIG, config.replace(needle, `"database_id": "${databaseId}"`));
  console.log(`[ok] wrangler.jsonc database_id → ${databaseId}`);
}

// 5. remote migrations
if (CHECK) {
  console.log("[check] skipping migrations (read-only mode) — next step: pnpm db:migrate:remote && pnpm deploy");
} else {
  console.log("applying remote D1 migrations...");
  execFileSync("pnpm", ["db:migrate:remote"], { cwd: repoRoot, encoding: "utf8", stdio: "inherit" });
  console.log("\nDone. Deploy with: pnpm deploy");
}

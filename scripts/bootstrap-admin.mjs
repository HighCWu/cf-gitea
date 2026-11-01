#!/usr/bin/env node
/**
 * Bootstrap the first admin user + an all-scopes PAT (the "make the product
 * usable" step — the users table starts empty).
 *
 *   node scripts/bootstrap-admin.mjs <username> [email] [--remote]
 *
 * - Creates the user (is_admin=1, active) if missing, then mints a PAT with
 *   scope `all` and prints the plaintext token EXACTLY ONCE (it is never
 *   stored — only the sha256 digest lands in D1, SPEC-0002 §3).
 * - Idempotent per (user, token name): a re-run skips the mint when a
 *   'bootstrap' token already exists for that user (duplicate-per-user
 *   guard, exit 1 with the existing row's id).
 * - Token generation replicates apps/worker/src/auth/token-format.ts bit for
 *   bit (cfg_<8hex>_<32base32>); digest = hex(sha256(token value)).
 * - Runs against LOCAL D1 by default (dev/miniflare state); pass --remote for
 *   the production database (requires wrangler auth + the migrated DB —
 *   `pnpm setup:deploy` does both).
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import console from "node:console";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "apps", "worker");
const REMOTE = process.argv.includes("--remote");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const username = args[0];
const email = args[1] ?? `${username ?? ""}@localhost`;

if (!username || !/^[a-zA-Z0-9_.-]{1,64}$/.test(username)) {
  console.error("usage: node scripts/bootstrap-admin.mjs <username> [email] [--remote]");
  console.error("       username: 1-64 chars of [a-zA-Z0-9_.-]");
  process.exit(1);
}

const BASE32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const bytes = randomBytes(24);
let hex = "";
for (let i = 0; i < 4; i++) {
  hex += (bytes[i] >> 4).toString(16) + (bytes[i] & 0xf).toString(16);
}
let bits = 0, value = 0, b32 = "";
for (const byte of bytes.subarray(4)) {
  value = (value << 8) | byte;
  bits += 8;
  while (bits >= 5) {
    b32 += BASE32[(value >>> (bits - 5)) & 31];
    bits -= 5;
  }
}
const token = `cfg_${hex}_${b32}`;
const prefix = `cfg_${hex}`;
const digest = createHash("sha256").update(token, "utf8").digest("hex");
const now = Math.floor(Date.now() / 1000);

const sql = (text) => text.replace(/'/g, "''");
const scope = REMOTE ? ["--remote"] : ["--local"];
const d1 = (command) =>
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "cf-gitea", ...scope, "--command", command], {
    cwd: workerDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const existing = d1(`SELECT id FROM users WHERE username_lower = '${sql(username.toLowerCase())}'`);
const userId = existing.includes("id")
  ? JSON.parse(execFileSync("pnpm", [
      "exec", "wrangler", "d1", "execute", "cf-gitea", ...scope, "--json",
      "--command", `SELECT id FROM users WHERE username_lower = '${sql(username.toLowerCase())}'`,
    ], { cwd: workerDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
      .at(-1)?.results?.[0]?.id
  : null;

if (userId === null || userId === undefined) {
  d1(
    `INSERT INTO users (username, username_lower, email, display_name, is_admin, status, created_at) ` +
    `VALUES ('${sql(username)}', '${sql(username.toLowerCase())}', '${sql(email)}', '${sql(username)}', 1, 'active', ${now})`
  );
  console.log(`[ok] created admin user ${username} (${REMOTE ? "remote" : "local"} D1)`);
} else {
  console.log(`[ok] user ${username} already exists (id ${userId}) — minting token only`);
}

// Duplicate-per-user guard — ports the API-layer reject this direct-SQL mint
// bypassed (0219256: "bootstrap-admin's direct-SQL mint has no
// duplicate-per-user guard, bypassing the API layer's reject — each retry
// adds a row"; the standing PAT count drifted 2 → 10 across probe retries).
// Same rule as TokenService.mint (apps/worker/src/auth/token-service.ts:86–93)
// and upstream AccessTokenByNameExists (gitea/models/auth/access_token.go:129–132,
// enforced at routers/api/v1/user/app.go:108–117): one token per (user_id,
// name). An existing 'bootstrap' token is skipped, never duplicated —
// idempotent re-runs leave the token count stable.
const dup = JSON.parse(execFileSync("pnpm", [
  "exec", "wrangler", "d1", "execute", "cf-gitea", ...scope, "--json",
  "--command",
  `SELECT id, prefix FROM personal_access_tokens WHERE user_id = ` +
  `(SELECT id FROM users WHERE username_lower = '${sql(username.toLowerCase())}') AND name = 'bootstrap' ` +
  `ORDER BY id LIMIT 1`,
], { cwd: workerDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).at(-1)?.results?.[0];

if (dup) {
  console.error(`[skip] a 'bootstrap' token already exists for ${username} (id ${dup.id}, prefix ${dup.prefix}) — not minting a duplicate (the API layer rejects the same request with 400 "access token name has been used already").`);
  console.error("The plaintext cannot be re-shown (only the sha256 digest is stored). Reuse your stored token, or delete the row by id and re-run:");
  console.error(`  curl -X DELETE -H "Authorization: token <PAT>" <host>/api/v1/users/${username}/tokens/${dup.id}`);
  process.exit(1);
}

d1(
  `INSERT INTO personal_access_tokens (user_id, name, prefix, sha256_digest, scopes, last_used_at, expires_at, created_at) ` +
  `SELECT id, 'bootstrap', '${prefix}', '${digest}', 'all', NULL, NULL, ${now} FROM users WHERE username_lower = '${sql(username.toLowerCase())}'`
);

console.log(`
PAT minted (scope: all). This plaintext is shown ONCE:

  ${token}

Git (write access):
  git remote add origin http://${username}:${token}@<host>/${username}/<repo>.git
API:
  curl -H "Authorization: token ${token}" <host>/api/v1/user
`);

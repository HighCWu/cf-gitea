#!/usr/bin/env node
/**
 * ADR-0002 guard: the frozen API contract copy must stay a verbatim copy of the
 * vendored swagger at the pinned submodule commit. Fails when either side drifts:
 *   (a) frozen copy ≠ submodule swagger (accidental edit, or the submodule moved
 *       without a deliberate re-pin);
 *   (b) frozen copy ≠ sha256 recorded in the contract README (tamper check).
 *
 * A failure means: either restore the copy (`cp gitea/templates/swagger/... .`),
 * or execute the ADR-0002 re-pin procedure and update the recorded sha256.
 * Run via the root script: `pnpm check:contract`.
 */
import { createHash } from "node:crypto";
import console from "node:console";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FROZEN = path.join(repoRoot, "apps", "worker", "src", "compat", "contract", "v1-swagger.generated.json");
const SUBMODULE = path.join(repoRoot, "gitea", "templates", "swagger", "v1-swagger.generated.json");
const README = path.join(repoRoot, "apps", "worker", "src", "compat", "contract", "README.md");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

let failed = false;
const [frozen, submodule, readme] = await Promise.all([
  readFile(FROZEN),
  readFile(SUBMODULE).catch(() => null),
  readFile(README, "utf8"),
]);
const frozenSha = sha256(frozen);

console.log(`frozen contract sha256: ${frozenSha}`);

const recorded = readme.match(/sha256:\s*`([0-9a-f]{64})`/)?.[1];
if (recorded !== frozenSha) {
  console.error(`[fail] frozen copy does not match the sha256 recorded in its README (${recorded ?? "none found"})`);
  failed = true;
} else {
  console.log("[ok] matches the sha256 recorded in the contract README");
}

if (submodule === null) {
  console.warn("[warn] gitea submodule not checked out — skip (a); run `git submodule update --init`");
} else {
  const subSha = sha256(submodule);
  if (subSha !== frozenSha) {
    console.error(`[fail] submodule swagger drifted from the frozen copy (${subSha}) — accidental submodule move or local edit; see ADR-0002 re-pin procedure`);
    failed = true;
  } else {
    console.log("[ok] verbatim match with the pinned submodule swagger");
  }
}

process.exit(failed ? 1 : 0);

#!/usr/bin/env node
/**
 * Contract check for the `/api/v1` skeleton against the vendored Gitea swagger
 * (SPEC-0004 §5.1 stage 1 — route-contract check; ADR-0001 D3 contract
 * discipline).
 *
 * What it asserts (hard failures exit non-zero):
 *   (a) every path+method declared by our router exists in the frozen contract
 *       copy `apps/worker/src/compat/contract/v1-swagger.generated.json`
 *       (verbatim copy of the vendored swagger at the pinned submodule commit,
 *       per ADR-0002 — never edited; regenerate on re-pin);
 *   (b) our declared response codes per operation are a subset of the
 *       contract's, except responses listed in RUNTIME_ONLY_RESPONSES below
 *       (upstream sends them at runtime but the vendored swagger omits them —
 *       those are warned, never skipped silently);
 *   (c) prints tier-1 coverage (N/78 paths, M/129 operations) parsed from the
 *       SPEC-0004 appendix A table, so "what is still missing" is a query.
 *       Coverage is informational while tier 1 is under construction; pass
 *       `--strict-tier1` to fail unless coverage is complete (use once tier 1
 *       ships).
 *
 * How the TypeScript router runs from plain node (no new deps): the script
 * bundles `apps/worker/src/api/openapi.ts` with the workspace's existing vite
 * (apps/worker devDependency) into a temporary ESM file and imports it. Vite
 * already handles TypeScript and extensionless imports — the same pipeline
 * vitest uses — and the bundled module exports `getGeneratedSpec()`. Run via
 * the root script: `pnpm check:api`.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = path.join(repoRoot, "apps", "worker");
const SPEC_ENTRY = "src/api/openapi.ts";
const VENDORED_SWAGGER = path.join(repoRoot, "apps", "worker", "src", "compat", "contract", "v1-swagger.generated.json");
const SPEC_DOC = path.join(repoRoot, "specs", "0004-api-v1-core.md");

/** HTTP methods that can carry an operation in an OpenAPI paths object. */
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch"]);

/**
 * Declared responses upstream really sends at runtime but the vendored swagger
 * omits (SPEC-0004 §2.5). Warned as documented exceptions, not failures.
 */
const RUNTIME_ONLY_RESPONSES = {
  "/packages/{owner}/{type}/{name}/-/unlink": {
    post: {
      // Upstream's own handler answers ctx.Status(http.StatusNoContent) on
      // success (gitea/routers/api/v1/packages/package.go:465) while its
      // swagger block documents "201 empty" (package.go:439-440) — the
      // runtime-faithful 204 is what we ship; the frozen contract carries
      // the never-emitted 201.
      204: "upstream UnlinkPackage answers StatusNoContent at runtime; its swagger documents 201 empty (package.go:465 vs :439)",
    },
  },
  "/user": {
    get: {
      // reqToken() 401s anonymous callers (gitea/routers/api/v1/api.go); the
      // contract documents only 200 for userGetCurrent.
      401: "upstream reqToken() rejects anonymous callers; swagger documents only 200",
    },
  },
  "/repositories/{id}": {
    get: {
      401: "upstream reqToken() (token required for repoGetByID); contract documents 200/404 only",
    },
  },
  "/user/repos": {
    get: {
      401: "upstream reqToken() (token required for userCurrentListRepos); contract documents 200 only",
    },
  },
  "/markdown": {
    post: {
      401: "upstream reqToken() (routers/api/v1/api.go:1018); contract documents 200/422 only",
      400: "hono validator rejects malformed JSON before route mapping (upstream bind 422s everything, api.go:841-844) — documented divergence",
    },
  },
  "/markdown/raw": {
    post: {
      401: "upstream reqToken() (routers/api/v1/api.go:1018); contract documents 200/422 only",
    },
  },
  "/repos/{owner}/{repo}/statuses/{sha}": {
    post: {
      422: "non-full-length sha input rejected at runtime (upstream resolves refs via the engine and 500s on unknown — neither reproducible without engine ref resolution); declared set stays {201,400,404}",
    },
  },
  "/user/followers": {
    get: { 401: "upstream reqToken(); contract documents 200 only" },
  },
  "/user/following/{username}": {
    put: { 401: "upstream reqToken(); contract documents 204/404 only" },
    delete: { 401: "upstream reqToken(); contract documents 204/404 only" },
  },
  "/users/{username}/keys": {
    get: { 401: "upstream reqToken(); contract documents 200 only" },
  },
  "/users/{username}/gpg_keys": {
    get: { 401: "upstream reqToken(); contract documents 200 only" },
  },
  "/repos/{owner}/{repo}/milestones/{id}": {
    patch: {
      400: "due_on parse failure returns upstream's 'invalid date format' at runtime; undeclared in the vendored contract (same class as /user 401)",
    },
  },
  "/signing-key.gpg": {
    get: {
      404: "cf-gitea has no signing-key configuration, so the format is blank and upstream's own handler answers APIErrorNotFound(\"no signing key\") at runtime (gitea/routers/api/v1/misc/signing.go:14-24); the contract documents only the 200 text/plain",
    },
  },
  "/signing-key.pub": {
    get: {
      404: "same helper as /signing-key.gpg — SigningKeySSH feeds the SSH expected format into getSigningKey (gitea/routers/api/v1/misc/signing.go:100), so with no signing-key configuration the blank-format arm answers APIErrorNotFound(\"no signing key\") verbatim (signing.go:19-21); the contract documents only the 200 text/plain",
    },
  },
  "/repos/{owner}/{repo}/signing-key.gpg": {
    get: {
      404: "repo arm of the same getSigningKey helper (misc/signing.go:14-24 via api.go:1530) — cf-gitea has no signing-key configuration, so the blank-format arm answers APIErrorNotFound(\"no signing key\") like the landed global pair; the contract documents only the 200 text/plain",
    },
  },
  "/repos/{owner}/{repo}/signing-key.pub": {
    get: {
      404: "repo arm of SigningKeySSH (misc/signing.go:100 via api.go:1531) — same blank-format answer as /repos/{owner}/{repo}/signing-key.gpg; the contract documents only the 200 text/plain",
    },
  },
  "/repos/{owner}/{repo}/hooks/git": {
    get: {
      401: "upstream reqToken() (gitea/routers/api/v1/api.go:1276) rejects anonymous callers; the contract declares {200,404} only",
      403: "upstream reqAdmin (api.go:383-390) — the repo-admin gate 403s before the handler; the contract documents no 403 on the list (routes/git-hooks.ts)",
    },
  },
  "/repos/{owner}/{repo}/hooks/git/{id}": {
    get: {
      401: "same reqToken class as the list (api.go:1276); contract documents {200,404} only",
      403: "reqAdmin (api.go:383-390); contract documents {200,404} only",
    },
    patch: {
      401: "same reqToken class as the list (api.go:1276)",
      403: "reqAdmin (api.go:383-390)",
      422: "Go bind → APIErrorValidation on a schema-invalid body",
    },
    delete: {
      401: "same reqToken class as the list (api.go:1276)",
      403: "reqAdmin (api.go:383-390); contract documents {204,404} only",
    },
  },
  "/admin/users/{username}/keys": {
    post: {
      401: "upstream reqToken() runs inside the admin group's tokenRequiresScopes(admin) chain (gitea/routers/api/v1/api.go:1824-); the admin tag declares no 401 anywhere (routes/misc-t3.ts admin wiring note)",
      404: "the /users/{username} subgroup's context.UserAssignmentAPI() answers 404 'user redirect does not exist [name: …]' for an unknown username at runtime (gitea/services/context/user.go userAssignment; emitted by routes/misc-t3.ts resolveAdminTargetRow); the contract documents {201,403,422} only",
    },
  },
  "/admin/cron/{task}": {
    post: {
      403: "the /admin group's reqSiteAdmin 403s non-admins before the handler runs (gitea/routers/api/v1/api.go:1824-); upstream's own swagger comment for adminCronRun documents only {204,404} while its sibling adminCronList DOES declare the 403 (admin/cron.go) — a doc-comment gap upstream sends anyway; declared by routes/admin-degenerate.ts",
    },
  },
  "/admin/unadopted/{owner}/{repo}": {
    delete: {
      404: "upstream's DeleteUnadoptedRepository answers APIErrorNotFound() at runtime for an unknown owner, an already-adopted repo and a repo absent from disk — every branch of the handler (gitea/routers/api/v1/admin/adopt.go) — though its swagger documents only {204,403}; in cf-gitea the absent-from-disk branch is EVERY call (no filesystem — routes/admin-degenerate.ts), so the 404 is the operation's one reachable outcome behind the gates",
    },
  },
  "/user/avatar": {
    post: {
      400: "base64 decode failure answers upstream's exact ctx.APIError(400, err) text (user/avatar.go:33-37); at/over the 262144-byte origin cap cf-gitea 400s (no image pipeline — documented divergence, services/avatars.ts)",
      401: "reqToken() 401s anonymous callers; the contract documents only 204",
      413: "the MAX_AVATAR_WIRE_BYTES guard middleware rejects an over-cap declared Content-Length before any body byte (routes/avatars.ts)",
      422: "zod body bind failures",
      500: "unknown/corrupt/oversized-dimension image is upstream's APIErrorInternal (image.DecodeConfig arms) — the landed constant-fallback convention (routes/avatars.ts header)",
    },
  },
  "/orgs/{org}/avatar": {
    post: {
      400: "same base64/origin-cap arms as /user/avatar (the org arm is user_service.UploadAvatar(org.AsUser()) — org/avatar.go:46)",
      401: "reqToken(); contract documents only 204",
      403: "reqOrgOwnership 403s non-owners (upstream's exact message) — the contract documents only 204",
      404: "org assignment miss (rename-307 seam's terminal arm)",
      413: "the wire-cap guard (as /user/avatar)",
      422: "zod body bind failures",
      500: "the image arms (as /user/avatar)",
    },
  },
  "/repos/{owner}/{repo}/avatar": {
    post: {
      400: "same base64/origin-cap arms (the repo arm shares the upload service)",
      401: "reqToken(); contract documents only 204",
      403: "requireRepoAdmin 403s non-admins (upstream's exact message)",
      404: "repo resolution miss (anti-enumeration)",
      413: "the wire-cap guard",
      422: "zod body bind failures",
      500: "the image arms",
    },
  },
};

/**
 * Tier-1 totals documented in SPEC-0004 §2.3. The appendix table is re-counted
 * on every run; a mismatch is a warning that the SPEC drifted, not a contract
 * violation.
 */
const TIER1_EXPECTED_PATHS = 78;
const TIER1_EXPECTED_OPERATIONS = 129;

/** The mount prefix routes are served under (stripped before comparison). */
const MOUNT_PREFIX = "/api/v1";

function normalizePath(declaredPath) {
  const withoutPrefix =
    declaredPath === MOUNT_PREFIX ? "/"
      : declaredPath.startsWith(`${MOUNT_PREFIX}/`) ? declaredPath.slice(MOUNT_PREFIX.length)
      : declaredPath;
  return withoutPrefix === "" ? "/" : withoutPrefix;
}

/**
 * Bundle the spec entry with the workspace's vite and import it. Returns
 * `getGeneratedSpec()`'s OpenAPI document. (Mechanism documented in the file
 * header.)
 */
async function loadGeneratedSpec() {
  const workerRequire = createRequire(pathToFileURL(path.join(WORKER_DIR, "package.json")));
  const { build } = await import(workerRequire.resolve("vite"));

  const outDir = await mkdtemp(path.join(tmpdir(), "cf-gitea-openapi-"));
  // The bundled api graph reaches the vendored engine's SOURCES (the package
  // entry is src/mod.ts, and the api layer imports its commit serializers at
  // value level), and engine sources `import { DurableObject } from
  // "cloudflare:workers"` — a workerd-virtual module plain-node vite can
  // neither resolve nor execute. Merely marking it external would leave a
  // static import this script's `await import()` cannot serve. getGeneratedSpec()
  // only walks the route registry (no handler runs, no Durable Object is ever
  // constructed), so the module stands in as the bare base class the engine
  // DO classes extend. The stub lives in its own temp dir, removed below.
  const stubDir = await mkdtemp(path.join(tmpdir(), "cf-gitea-openapi-stub-"));
  const workersStub = path.join(stubDir, "cloudflare-workers.mjs");
  await writeFile(workersStub, "export class DurableObject {}\n");
  try {
    await build({
      root: WORKER_DIR,
      configFile: false,
      logLevel: "warn",
      build: { ssr: SPEC_ENTRY, outDir, emptyOutDir: true, minify: false },
      resolve: { alias: [{ find: /^cloudflare:workers$/, replacement: workersStub }] },
      ssr: { noExternal: true },
    });
    const module = await import(pathToFileURL(path.join(outDir, "openapi.js")).href);
    return module.getGeneratedSpec();
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  }
}

function declaredOperations(doc) {
  const operations = [];
  for (const [declaredPath, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (!HTTP_METHODS.has(method)) {
        continue;
      }
      const responses = Object.keys(pathItem[method]?.responses ?? {});
      operations.push({
        path: normalizePath(declaredPath),
        method,
        responses: new Set(responses),
        operation: pathItem[method]?.operationId ?? "(no operationId)",
      });
    }
  }
  return operations;
}

function contractResponsesFor(gitea, opPath, method) {
  const pathItem = gitea.paths?.[opPath];
  const operation = pathItem?.[method];
  return operation === undefined ? null : new Set(Object.keys(operation.responses ?? {}));
}

/** Parse the tier-1 rows (| T1 |) of SPEC-0004 appendix A → Map path → methods[]. */
async function parseTier1Table() {
  const markdown = await readFile(SPEC_DOC, "utf8");
  const tier1 = new Map();
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*([A-Z, ]+?)\s*\|\s*[a-z]\s*\|\s*T1\s*\|$/u.exec(line);
    if (match === null) {
      continue;
    }
    const [, contractPath, methods] = match;
    tier1.set(contractPath, methods.split(",").map((method) => method.trim().toLowerCase()));
  }
  return tier1;
}

async function main() {
  const strictTier1 = process.argv.includes("--strict-tier1");
  const hardFailures = [];
  const warnings = [];

  const [doc, gitea, tier1] = await Promise.all([
    loadGeneratedSpec(),
    readFile(VENDORED_SWAGGER, "utf8").then((raw) => JSON.parse(raw)),
    parseTier1Table(),
  ]);
  const operations = declaredOperations(doc);

  console.log("cf-gitea /api/v1 contract check (frozen copy: apps/worker/src/compat/contract/v1-swagger.generated.json)");
  console.log(`  declared: ${operations.length} operation(s) across ${doc.paths ? Object.keys(doc.paths).length : 0} path(s)`);

  // (a) every declared path+method exists in the vendored contract.
  // (b) declared response codes ⊆ contract's, modulo documented runtime-only
  //     exceptions. The contract's error family declares {message,url} as
  //     response headers (swagger-go artifact) while we declare them as the
  //     JSON body — a body-shape conversion note per SPEC-0004 §2.5, not a
  //     status-code difference, so the subset check is unaffected.
  for (const op of operations) {
    const contractCodes = contractResponsesFor(gitea, op.path, op.method);
    if (contractCodes === null) {
      hardFailures.push(`(a) ${op.method.toUpperCase()} ${op.path} (${op.operation}) has no entry in the vendored contract`);
      continue;
    }
    const extraCodes = [...op.responses].filter((code) => !contractCodes.has(code));
    for (const code of extraCodes) {
      const exceptions = RUNTIME_ONLY_RESPONSES[op.path]?.[op.method];
      const reason = exceptions?.[code];
      if (reason !== undefined) {
        warnings.push(`(b) ${op.method.toUpperCase()} ${op.path} response ${code} not in contract {${[...contractCodes].join(", ")}} — documented runtime-only exception: ${reason}`);
      } else {
        hardFailures.push(`(b) ${op.method.toUpperCase()} ${op.path} declares response ${code}; contract has {${[...contractCodes].join(", ")}} and no documented exception covers it`);
      }
    }
    console.log(`  [ok] ${op.method.toUpperCase()} ${op.path} (${op.operation}) responses {${[...op.responses].join(", ")}} ⊆ contract {${[...contractCodes].join(", ")}}`);
  }

  // (c) tier-1 coverage, parsed from the SPEC appendix so it cannot drift
  //     from the documented tiering.
  if (tier1.size !== TIER1_EXPECTED_PATHS) {
    warnings.push(`(c) SPEC-0004 appendix A parses as ${tier1.size} tier-1 paths, SPEC §2.3 documents ${TIER1_EXPECTED_PATHS} — tiering drifted, re-verify on re-pin`);
  }
  const tier1Operations = [...tier1.values()].reduce((sum, methods) => sum + methods.length, 0);
  if (tier1Operations !== TIER1_EXPECTED_OPERATIONS) {
    warnings.push(`(c) SPEC-0004 appendix A parses as ${tier1Operations} tier-1 operations, SPEC §2.3 documents ${TIER1_EXPECTED_OPERATIONS}`);
  }
  const declared = new Map(operations.map((op) => [`${op.method} ${op.path}`, op.responses]));
  let coveredPaths = 0;
  let coveredOperations = 0;
  const missing = [];
  for (const [contractPath, methods] of tier1) {
    const have = methods.filter((method) => declared.has(`${method} ${contractPath}`));
    coveredOperations += have.length;
    if (have.length === methods.length) {
      coveredPaths += 1;
    } else {
      missing.push(`${contractPath} (have: ${have.length ? have.join(",") : "none"}; need: ${methods.join(",")})`);
    }
  }
  console.log(`  tier-1 coverage: ${coveredPaths}/${tier1.size} paths, ${coveredOperations}/${tier1Operations} operations`);
  if (missing.length > 0 && missing.length <= 10) {
    console.log(`  missing tier-1 paths:\n    ${missing.join("\n    ")}`);
  } else if (missing.length > 0) {
    console.log(`  missing tier-1 paths: ${missing.length} (first few: ${missing.slice(0, 5).join(" | ")})`);
  }
  if (strictTier1 && coveredPaths !== tier1.size) {
    hardFailures.push(`(c) --strict-tier1: tier-1 coverage incomplete (${coveredPaths}/${tier1.size} paths)`);
  }

  for (const warning of warnings) {
    console.warn(`  [warn] ${warning}`);
  }
  if (hardFailures.length > 0) {
    console.error("CONTRACT CHECK FAILED:");
    for (const failure of hardFailures) {
      console.error(`  [fail] ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("PASS");
}

main().catch((error) => {
  console.error("contract check crashed:", error);
  process.exitCode = 1;
});

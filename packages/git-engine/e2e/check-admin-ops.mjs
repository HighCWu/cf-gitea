// SPEC-0011 §5.1/§2 amendment (2026-11-25) — the pack-maintenance ADMIN HTTP
// surface: POST /compact (compactNow) and POST /pack-gc (gcNow) over the REAL
// workerd runtime (miniflare, the same shape as check-delete-husk.mjs). The
// RPC bodies' semantics (threshold/lease/window gates, merge correctness) are
// pinned by check-compaction.mjs / check-gc.mjs over the DO RPCs; THIS check
// pins the HTTP layer: the routes exist, the authorize hook gates them
// EXACTLY like POST /gc (anonymous → 401 Basic challenge, wrong token → 401,
// the configured GIT_TOKEN → 200 JSON), the shapes are POST-only (a GET is a
// page shape and 404s BEFORE auth in headless mode), and `force` rides the
// JSON body to bypass only the threshold. Run with tsx (or plain node):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-admin-ops.mjs
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = resolve(ENGINE_ROOT, "../..");
const PNPM_STORE = join(REPO_ROOT, "node_modules", ".pnpm");

/** Locate a package under the pnpm store (same mechanism as the gates' tsx
 * invocation — version-pinned, resolved by prefix so patch bumps survive;
 * the NEWEST matching store entry wins). */
function findInStore(prefix, sub) {
  const hit = readdirSync(PNPM_STORE)
    .filter((d) => d.startsWith(prefix))
    .sort()
    .at(-1);
  if (!hit) throw new Error(`cannot locate ${prefix} under ${PNPM_STORE} — run pnpm install first`);
  return join(PNPM_STORE, hit, "node_modules", sub);
}

const esbuildUrl = pathToFileURL(findInStore("esbuild@", "esbuild/lib/main.js")).href;
const miniflareUrl = pathToFileURL(findInStore("miniflare@5.", "miniflare/dist/src/index.js")).href;

function readCompatibilityDate() {
  for (const file of ["wrangler.jsonc", "wrangler.jsonc.example"]) {
    const text = readFileSync(join(REPO_ROOT, "apps", "worker", file), "utf8");
    const hit = text.match(/"compatibility_date"\s*:\s*"([^"]+)"/);
    if (hit) return hit[1];
  }
  throw new Error("cannot read compatibility_date from apps/worker/wrangler.jsonc{,.example}");
}
const compatibilityDate = readCompatibilityDate();

// The engine the check runs is THIS tree's source, bundled for workerd by
// esbuild — headless (`ui: false`) exactly like the embedding Worker, so the
// GET-pre-auth-404 arm of the classification is exercised too.
const scratch = mkdtempSync(join(tmpdir(), "check-admin-ops-"));
const entry = `
import { createDurableGit, RepoCell, Registry } from ${JSON.stringify(join(ENGINE_ROOT, "src", "mod.ts"))};
export { RepoCell, Registry };
const engine = createDurableGit({ namespaces: true, ui: false });
export default {
  async fetch(req, env, ctx) {
    return engine.fetch(req, env, ctx);
  },
};
`;
const entryPath = join(scratch, "entry.ts");
writeFileSync(entryPath, entry);
const bundledPath = join(scratch, "worker.mjs");
const esbuild = (await import(esbuildUrl)).default;
await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  format: "esm",
  platform: "neutral",
  external: ["cloudflare:workers"],
  outfile: bundledPath,
  logLevel: "silent",
});
const script = readFileSync(bundledPath, "utf8");

const STATE = join(scratch, "state");
rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });

const { Miniflare, convertV4MiniflareOptions } = await import(miniflareUrl);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    resourcePersistencePath: STATE,
    workers: [
      {
        name: "check-admin-ops",
        script,
        modules: true,
        compatibilityDate,
        durableObjects: {
          REPO: { className: "RepoCell", useSQLite: true },
          REGISTRY: { className: "Registry", useSQLite: true },
        },
        r2Buckets: ["REPO_PACKS"],
        bindings: { GIT_TOKEN: "devtoken" },
      },
    ],
  })
);

const AUTH = "Basic " + Buffer.from("x:devtoken").toString("base64");
const BAD_AUTH = "Basic " + Buffer.from("x:wrong").toString("base64");
const BASE = "https://example.com";
const REPO = "ops/demo";
let planned = 0;
const failures = [];
async function check(name, fn) {
  planned++;
  try {
    await fn();
    console.log(`ok: ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function req(label, path, init = {}) {
  const res = await mf.dispatchFetch(BASE + path, init);
  const body = await res.text();
  if (process.env.VERBOSE) console.log(`  [${label}] status=${res.status} body=${JSON.stringify(body.slice(0, 160))}`);
  return { status: res.status, body };
}
const post = (path, headers = {}, body) =>
  req("POST", path, { method: "POST", headers: { ...headers }, body });

async function main() {
  await check("setup: create the repo through the admin config surface (token)", async () => {
    const res = await req("PUT config", `/${REPO}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: AUTH },
      body: JSON.stringify({ description: "admin-ops fixture", owner: "ops", private: false }),
    });
    if (res.status !== 200) throw new Error(`config PUT failed: ${res.status} ${res.body}`);
  });

  await check("POST /compact: anonymous is a 401 Basic challenge", async () => {
    const res = await post(`/${REPO}/compact`);
    if (res.status !== 401) throw new Error(`status ${res.status}`);
    if (!/^Basic realm=/.test(res.body) && !/auth required/.test(res.body)) {
      throw new Error(`body does not read as the Basic challenge: ${JSON.stringify(res.body)}`);
    }
  });

  await check("POST /compact: a wrong token is a 401 (never a silent pass)", async () => {
    const res = await post(`/${REPO}/compact`, { authorization: BAD_AUTH });
    if (res.status !== 401) throw new Error(`status ${res.status}`);
  });

  await check("POST /compact (token, empty repo): threshold-gated skip, DO RPC reached", async () => {
    const res = await post(`/${REPO}/compact`, { authorization: AUTH });
    if (res.status !== 200) throw new Error(`status ${res.status} body ${res.body}`);
    const json = JSON.parse(res.body);
    if (json.tag !== "skipped" || json.reason !== "below_threshold") {
      throw new Error(`unexpected result ${res.body}`);
    }
    if (json.activePacks !== 0) throw new Error(`activePacks ${json.activePacks}`);
  });

  await check("POST /compact {force:true}: the body flag bypasses ONLY the threshold", async () => {
    const res = await post(`/${REPO}/compact`, { authorization: AUTH, "content-type": "application/json" }, JSON.stringify({ force: true }));
    if (res.status !== 200) throw new Error(`status ${res.status} body ${res.body}`);
    const json = JSON.parse(res.body);
    // force past the threshold on an EMPTY catalog: the window bound is the
    // next gate (0 packs < the two-pack minimum) — the skip reason PROVES the
    // flag rode through to runCompaction
    if (json.tag !== "skipped" || json.reason !== "window_too_small") {
      throw new Error(`unexpected result ${res.body}`);
    }
  });

  await check("POST /pack-gc: anonymous 401, wrong token 401", async () => {
    const anon = await post(`/${REPO}/pack-gc`);
    if (anon.status !== 401) throw new Error(`anon status ${anon.status}`);
    const bad = await post(`/${REPO}/pack-gc`, { authorization: BAD_AUTH });
    if (bad.status !== 401) throw new Error(`bad-token status ${bad.status}`);
  });

  await check("POST /pack-gc (token): the M3.4 manual pass answers with its tagged union", async () => {
    const res = await post(`/${REPO}/pack-gc`, { authorization: AUTH });
    if (res.status !== 200) throw new Error(`status ${res.status} body ${res.body}`);
    const json = JSON.parse(res.body);
    // an empty catalog: a collected pass with zero work (or a named skip —
    // either is the DO RPC's honest answer; both prove the route reached it)
    if (json.tag !== "collected" && json.tag !== "skipped") {
      throw new Error(`unexpected result ${res.body}`);
    }
  });

  await check("GET /compact: not an admin shape — a headless page shape 404s BEFORE auth", async () => {
    const anon = await req("GET", `/${REPO}/compact`);
    if (anon.status !== 404) throw new Error(`anon status ${anon.status} (want pre-auth 404)`);
    const authed = await req("GET authed", `/${REPO}/compact`, { headers: { authorization: AUTH } });
    if (authed.status !== 404) throw new Error(`authed status ${authed.status} (POST-only shape)`);
  });

  await check("never-created repo: the admin shapes keep the POST /gc family's semantics (parity, not a special case)", async () => {
    // mod.ts's long-standing rule — "only pushes and admin ops may touch
    // repos that don't exist yet" — routes an admin shape on an unknown name
    // to the (empty) cell. /compact and /pack-gc must answer EXACTLY what
    // POST /gc answers there (an empty cell's honest no-op), never a
    // divergent verdict: parity is the contract, no new special case.
    const gc = await post("/ops/never-created/gc", { authorization: AUTH });
    const compact = await post("/ops/never-created/compact", { authorization: AUTH });
    const packGc = await post("/ops/never-created/pack-gc", { authorization: AUTH });
    if (compact.status !== gc.status) {
      throw new Error(`/compact status ${compact.status} != /gc status ${gc.status}`);
    }
    if (packGc.status !== gc.status) {
      throw new Error(`/pack-gc status ${packGc.status} != /gc status ${gc.status}`);
    }
    if (gc.status !== 200) throw new Error(`/gc itself answered ${gc.status}: ${gc.body}`);
  });

  await mf.dispose();
}

await main();
if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} admin-ops checks passed`);

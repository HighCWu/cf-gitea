// SPEC-0003 §2.5.5 + scripts/mirror-e2e.README.md "Known red" 3 — the delete
// surface's HUSK semantics, pinned on the REAL dev runtime (miniflare/workerd,
// the same runtime `pnpm dev` runs). This check CANNOT run on the node:sqlite
// harness the other check-*.mjs scripts use: the failure it pins is a property
// of the runtime's SQLite storage (SQLITE_LOCKED on DROP TABLE against a
// database reopened by a newer runtime session), which the draining NodeSql
// helper never reproduces. Run with tsx (or plain node):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-delete-husk.mjs
//
// What it pins:
//   - a COMPLETED async purge (tombstone + destroy, the queue consumer's
//     steps) leaves the cell file as an empty husk; an engine DELETE of that
//     name — the shape the git-http gate's D1-missing admin passthrough
//     forwards VERBATIM — answers 200 `deleted\n` (no-op success), NOT the
//     historical 500 `database table is locked: SQLITE_LOCKED`;
//   - the SECOND DELETE answers the SAME verdict (idempotent-delete
//     semantics — the transitional population's cleanup contract), and a
//     third DELETE after a further restart too;
//   - a content-bearing cell still takes the real wipe path (in-session) and
//     still answers 200 — the no-op branch is husk-only, not a blanket skip;
//   - a never-populated cell deletes 200 in-session (registry-independent
//     admin semantics mod.ts has always kept);
//   - a store CONSTRUCTED by a fresh session over an EXISTING database can
//     still run DDL — CREATE, then DROP of a table that EXISTS — pinning the
//     cursor-drain root-cause fix: the construction-time tableExists probe
//     must drain its SELECT cursor (an un-drained SqlStorage cursor bricks
//     every subsequent DROP TABLE of an existing table on the connection for
//     the session; docs/research/workerd-ddl-cross-session-locked.md,
//     workerd#959 — the pre-drain leak re-bricked DDL at every open).
//
// The purge driver below replays the queue consumer's exact steps
// (markDeleted → destroy, SPEC-0003 §2.5.5 steps 2+4) through the real DO RPCs.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

// The engine the check runs is THIS tree's source, bundled for workerd by
// esbuild (workerd does not parse TS).
const scratch = mkdtempSync(join(tmpdir(), "check-delete-husk-"));
const entry = `
import { createDurableGit, RepoCell, Registry } from ${JSON.stringify(join(ENGINE_ROOT, "src", "mod.ts"))};
export { RepoCell, Registry };
const engine = createDurableGit({ namespaces: true });
// check-only subclass: the seed/probe side channel needs in-instance access
// to the store's sqlite (a stub cannot reach the store field over RPC)
class CheckRepoCell extends RepoCell {
  async __sql(q) {
    try {
      const c = this.store.sql.exec(q);
      return { rows: c.toArray().slice(0, 5) };
    } catch (e) {
      return { error: e.message };
    }
  }
}
export { CheckRepoCell as RepoCell2 };
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/__purge") {
      // the queue consumer's SPEC-0003 §2.5.5 steps 2+4 (tombstone, then
      // destroy after the R2 purge — R2 is empty here, destroy never touches it)
      const name = url.searchParams.get("name");
      const mark = await env.REPO.getByName(name).markDeleted();
      const destroyed = await env.REPO.getByName(name).destroy();
      return Response.json({ mark, destroyed });
    }
    if (url.pathname === "/__sql") {
      const stub = env.REPO.getByName(url.searchParams.get("name"));
      return Response.json(await stub.__sql(url.searchParams.get("q")));
    }
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

// Fresh per-run persistence: the check needs REAL process restarts between
// phases (that is the whole point), so state must persist to disk — and be
// thrown away so a rerun starts from a clean slate.
const STATE = join(scratch, "state");
rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });

const { Miniflare, convertV4MiniflareOptions } = await import(miniflareUrl);
function makeMf() {
  return new Miniflare(
    convertV4MiniflareOptions({
      resourcePersistencePath: STATE,
      workers: [
        {
          name: "check-delete-husk",
          script,
          modules: true,
          // the repo's compatibility_date (apps/worker/wrangler.jsonc) — the
          // runtime under test is exactly the dev server's
          compatibilityDate: "2026-10-19",
          durableObjects: {
            REPO: { className: "RepoCell2", useSQLite: true },
            REGISTRY: { className: "Registry", useSQLite: true },
          },
          r2Buckets: ["REPO_PACKS"],
          bindings: { GIT_TOKEN: "devtoken" },
        },
      ],
    })
  );
}

const AUTH = "Basic " + Buffer.from("x:devtoken").toString("base64");
const BASE = "https://example.com";
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
async function req(mf, label, path, init = {}) {
  const res = await mf.dispatchFetch(BASE + path, init);
  const body = await res.text();
  if (process.env.VERBOSE) console.log(`  [${label}] status=${res.status} body=${JSON.stringify(body.slice(0, 160))}`);
  return { status: res.status, body };
}
const del = (mf, name) => req(mf, `DELETE ${name}`, `/${name}`, { method: "DELETE", headers: { authorization: AUTH } });
async function create(mf, name) {
  return req(mf, `PUT config ${name}`, `/${name}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: AUTH },
    body: JSON.stringify({ description: "d", owner: "o", private: false }),
  });
}
async function purge(mf, name) {
  const res = await req(mf, "purge", `/__purge?name=${encodeURIComponent(name)}`, { method: "POST" });
  if (res.status !== 200) throw new Error(`purge steps failed: ${res.status} ${res.body}`);
  return res;
}
async function sql(mf, name, q) {
  const res = await req(mf, "sql", `/__sql?name=${encodeURIComponent(name)}&q=${encodeURIComponent(q)}`);
  return JSON.parse(res.body);
}

async function main() {
  // Phase 1: create + complete the async purge, then RESTART the runtime —
  // the cell is now a purged husk hit by a fresh dev-server session.
  await check("purged husk: engine DELETE after a dev-server restart answers 200 (Known-red 3)", async () => {
    const mf1 = makeMf();
    const created = await create(mf1, "husk/e2e");
    if (created.status !== 200) throw new Error(`setup create failed: ${created.status} ${created.body}`);
    await purge(mf1, "husk/e2e");
    await mf1.dispose(); // restart: the DELETE below constructs the cell fresh

    const mf2 = makeMf();
    const res = await del(mf2, "husk/e2e");
    await mf2.dispose();
    if (res.status !== 200 || res.body !== "deleted\n") {
      throw new Error(`expected 200 "deleted\\n", got ${res.status} ${JSON.stringify(res.body)} — the pre-fix 500 was "error: database table is locked: SQLITE_LOCKED\\n"`);
    }
  });

  await check("purged husk: the SECOND DELETE answers the same verdict (idempotent)", async () => {
    const mf = makeMf();
    const res = await del(mf, "husk/e2e");
    await mf.dispose();
    if (res.status !== 200 || res.body !== "deleted\n") {
      throw new Error(`expected 200 "deleted\\n", got ${res.status} ${JSON.stringify(res.body)}`);
    }
  });

  await check("purged husk: still 200 after a further restart, and the name is re-creatable", async () => {
    const mf3 = makeMf();
    const res = await del(mf3, "husk/e2e");
    if (res.status !== 200 || res.body !== "deleted\n") {
      throw new Error(`expected 200 "deleted\\n", got ${res.status} ${JSON.stringify(res.body)}`);
    }
    const recreated = await create(mf3, "husk/e2e");
    await mf3.dispose();
    if (recreated.status !== 200) throw new Error(`re-create after husk delete failed: ${recreated.status} ${recreated.body}`);
  });

  await check("content-bearing cell still takes the wipe path and answers 200 in-session", async () => {
    const mf = makeMf();
    const created = await create(mf, "husk/contentful");
    if (created.status !== 200) throw new Error(`setup create failed: ${created.status} ${created.body}`);
    // seed a ref row directly: hasAnyContent() must see it and route the
    // DELETE through the real wipe, not the no-op branch
    const seeded = await sql(mf, "husk/contentful", "INSERT INTO refs (name, oid, peeled, updated_at) VALUES ('refs/heads/main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL, 1)");
    if (seeded.error) throw new Error(`seed failed: ${seeded.error}`);
    const res = await del(mf, "husk/contentful");
    if (res.status !== 200 || res.body !== "deleted\n") throw new Error(`expected 200, got ${res.status} ${JSON.stringify(res.body)}`);
    const refs = await sql(mf, "husk/contentful", "SELECT COUNT(*) AS n FROM refs");
    if (refs.error) throw new Error(`post-wipe probe failed: ${refs.error}`);
    if (refs.rows[0].n !== 0) throw new Error(`wipe did not clear the seeded ref: ${JSON.stringify(refs.rows)}`);
    await mf.dispose();
  });

  await check("never-populated cell: DELETE is 200 in-session (registry-independent admin shape)", async () => {
    const mf = makeMf();
    const created = await create(mf, "husk/empty");
    if (created.status !== 200) throw new Error(`setup create failed: ${created.status} ${created.body}`);
    const res = await del(mf, "husk/empty");
    await mf.dispose();
    if (res.status !== 200 || res.body !== "deleted\n") throw new Error(`expected 200, got ${res.status} ${JSON.stringify(res.body)}`);
  });

  await check("constructed store over an EXISTING database: DROP of an existing table still works (the construction probe drains its cursor)", async () => {
    // Session A populates the database: engine tables + a populated migration
    // journal EXIST from here on.
    const mf1 = makeMf();
    const created = await create(mf1, "husk/ddlpin");
    if (created.status !== 200) throw new Error(`setup create failed: ${created.status} ${created.body}`);
    await mf1.dispose();

    // Session B's FIRST touch constructs the cell over the existing database —
    // exactly where the constructor's table-existence probe runs over tables
    // that exist (on a fresh database the probe throws before any cursor
    // exists, so only this shape can leak). Pre-drain, the probe discarded one
    // SELECT cursor per open and workerd bricked every later DROP of an
    // existing table on the connection (CREATE and DML keep working, and
    // `DROP TABLE IF EXISTS <nonexistent>` succeeds — the lock bites only
    // drops of tables that exist), so the scratch table's DROP below failed
    // with `database table is locked: SQLITE_LOCKED`.
    const mf2 = makeMf();
    try {
      const probe = await sql(mf2, "husk/ddlpin", "CREATE TABLE ddl_pin_probe (id TEXT)");
      if (probe.error) throw new Error(`CREATE probe failed: ${probe.error}`);
      const dropped = await sql(mf2, "husk/ddlpin", "DROP TABLE ddl_pin_probe");
      if (dropped.error) {
        throw new Error(
          `DROP of an existing table failed after a fresh-session construction: ${dropped.error} ` +
            `— the construction-time probe leaked its SELECT cursor (an un-drained SqlStorage cursor ` +
            `bricks every subsequent DROP TABLE of an existing table for the session)`
        );
      }
      // idempotent tail: the now-nonexistent table drops as a no-op
      const again = await sql(mf2, "husk/ddlpin", "DROP TABLE IF EXISTS ddl_pin_probe");
      if (again.error) throw new Error(`idempotent DROP IF EXISTS failed: ${again.error}`);
    } finally {
      await mf2.dispose();
    }
  });

  if (failures.length) {
    console.log(`\n${failures.length} check(s) FAILED`);
    rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`\nall ${planned} engine checks passed`);
  rmSync(scratch, { recursive: true, force: true });
}

main();

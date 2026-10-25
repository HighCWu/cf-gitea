// SPEC-0011 §8 M3.0 — DO SQLite forward-migration mechanism checks over a
// REAL GitStore (node:sqlite backend, real BEGIN/COMMIT transactions — see
// helpers/lib.mjs). Run with tsx:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-migrations.mjs
//
// Covers: fresh-DO baseline replay (journal built, store usable), in-place
// adoption of a populated `0001a-step4` dev-scratch database (rows intact,
// journal + demonstrator index rebuilt), re-run no-op (journal and schema
// byte-stable), the 0002 demonstrator applying exactly once (and its index
// showing up in EXPLAIN QUERY PLAN), the LOUD fail-closed posture for
// unrecognized pre-baseline states (with and without the explicit reset
// flag), the forward-only downgrade tripwire, the registry-side baseline
// (fresh + legacy column vintage), and the wipe-path journal rebuild.
//
// Honesty note: the legacy databases below are built by executing the exact
// baseline DDL the pre-M3.0 constructors ran (the same statements the old
// `SCHEMA_VERSION = "0001a-step4"` guard shipped with — the constants in
// migrations.ts ARE that DDL, single-sourced) and stamped with the legacy
// meta marker; the code that created them no longer exists, so this is the
// faithful reconstruction. Seeding on the adopt path always goes through the
// real store APIs.
import { DatabaseSync } from "node:sqlite";
import { assert, assertEq, NodeSql } from "./helpers/lib.mjs";
import { GitStore } from "../src/git/store.ts";
import {
  LEGACY_SCHEMA_VERSION,
  REPO_MIGRATIONS,
  REPO_PACK_BASELINE_SQL,
  REPO_STORE_BASELINE_SQL,
  REGISTRY_MIGRATIONS,
  dropRepoSchema,
  runRegistryMigrations,
  runRepoMigrations,
} from "../src/git/migrations.ts";

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

const BASELINE_IDS = REPO_MIGRATIONS.map((m) => m.id);
const DEMO_STEP = "0002-pack-objects-pack-oid-index";
const DEMO_INDEX = "idx_pack_objects_pack_oid";

function openDb() {
  const db = new DatabaseSync(":memory:");
  return { db, sql: new NodeSql(db) };
}

/** Counting transaction wrapper (RepoCell passes ctx.storage.transactionSync;
 * this proves the runner engages the caller's transactions). */
function countingTx(counter) {
  return (fn) => {
    counter.begin++;
    counter.db.exec("BEGIN");
    try {
      fn();
      counter.db.exec("COMMIT");
    } catch (err) {
      counter.db.exec("ROLLBACK");
      throw err;
    }
  };
}

function journalRows(sql) {
  return sql.exec("SELECT id, applied_at FROM schema_migrations ORDER BY id").toArray();
}

function journalIds(sql) {
  return journalRows(sql).map((r) => r.id);
}

function tableNames(sql) {
  // node:sqlite CAN read sqlite_master (tests only — the production runner
  // probes tables by SELECT so it also works under workerd)
  return new Set(
    sql.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
  );
}

function indexNames(sql) {
  return new Set(
    sql.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name)
  );
}

function queryPlan(sql, query, ...params) {
  return sql
    .exec("EXPLAIN QUERY PLAN " + query, ...params)
    .toArray()
    .map((r) => r.detail)
    .join("\n");
}

/** Seed a store through its REAL APIs: loose objects, a ref, HEAD, a lease,
 * a pack (index rows + catalog row). */
function seedStore(store) {
  const blob = new TextEncoder().encode("hello migration world");
  store.put("1111111111111111111111111111111111111111", "blob", blob);
  store.setRef("refs/heads/main", "2222222222222222222222222222222222222222");
  store.setHead("refs/heads/main");
  store.createLease("lease-tok-1", "receive", Date.now() + 60_000, '{"packKey":"pack-abc"}');
  store.packs.putRows("pack-abc", [
    {
      oid: "3333333333333333333333333333333333333333",
      offset: 0,
      dataOff: 12,
      dataLen: 30,
      type: "blob",
      size: 21,
      entrySize: 34,
      baseOid: null,
      crc32: 7,
    },
  ]);
  store.packs.recordPack("pack-abc", 4096, 256);
}

/** Build a faithful pre-M3.0 (`0001a-step4`) database: the exact baseline
 * DDL the old constructors ran + the legacy marker; no journal, no
 * demonstrator index. */
function makeLegacyDb(marker = LEGACY_SCHEMA_VERSION) {
  const { db, sql } = openDb();
  sql.exec(REPO_STORE_BASELINE_SQL);
  sql.exec(REPO_PACK_BASELINE_SQL);
  sql.exec("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", marker);
  return { db, sql };
}

async function main() {
  await check("fresh DO: constructor applies baseline + steps uniformly", async () => {
    const { sql } = openDb();
    const store = new GitStore(sql);
    assertEq(
      store.schemaState,
      { applied: BASELINE_IDS, adopted: false, reset: false, refused: null },
      "outcome reports every step applied"
    );
    assertEq(journalIds(sql), BASELINE_IDS, "journal holds every step in order");
    const tables = tableNames(sql);
    for (const t of [
      "objects", "chunks", "refs", "meta", "reachable", "peeled", "stats_cache", "leases",
      "pack_catalog", "pack_data", "pack_objects", "fork_import", "schema_migrations",
    ]) {
      assert(tables.has(t), `table ${t} exists after baseline`);
    }
    // the store is immediately usable
    const blob = new TextEncoder().encode("fresh");
    store.put("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "blob", blob);
    const got = await store.get("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assertEq(got.data, blob, "object round-trips after fresh baseline");
    // the rollback-safety marker is recorded for pre-M3.0 builds
    assertEq(store.getMeta("schema_version"), LEGACY_SCHEMA_VERSION, "legacy marker recorded");
  });

  await check("fresh schema = legacy constructors' DDL + 0002 index + journal", async () => {
    const { db } = openDb();
    new GitStore(new NodeSql(db));
    const legacy = openDb(); // what a pre-M3.0 constructor left behind
    legacy.sql.exec(REPO_STORE_BASELINE_SQL);
    legacy.sql.exec(REPO_PACK_BASELINE_SQL);
    const objectsOf = (handle) =>
      handle.db
        .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((r) => `${r.type}:${r.name}`);
    const fresh = objectsOf({ db });
    const old = objectsOf(legacy);
    const missing = old.filter((x) => !fresh.includes(x));
    const extra = fresh.filter((x) => !old.includes(x));
    assertEq(missing, [], "fresh schema missing nothing the legacy constructors built");
    assertEq(
      extra.sort(),
      [`index:${DEMO_INDEX}`, "table:schema_migrations"].sort(),
      "the only additions are the 0002 demonstrator index and the journal"
    );
  });

  await check("populated 0001a-step4 DO: adopts in place, data intact, journal + index rebuilt", async () => {
    // Phase 1: seed through the real store APIs on a fresh DB.
    const seeded = openDb();
    const seedStore0 = new GitStore(seeded.sql);
    seedStore(seedStore0);
    // Phase 2: demote the persisted state to its exact 0001a-step4 shape —
    // journal gone, demonstrator index gone, legacy marker in place.
    seeded.sql.exec("DROP TABLE schema_migrations");
    seeded.sql.exec(`DROP INDEX IF EXISTS ${DEMO_INDEX}`);
    seeded.sql.exec("UPDATE meta SET value = ? WHERE key = 'schema_version'", LEGACY_SCHEMA_VERSION);
    assert(!indexNames(seeded.sql).has(DEMO_INDEX), "demoted db lacks the demonstrator index (sanity)");
    // Phase 3: the new engine opens the same database.
    const txCounter = { begin: 0, db: seeded.db };
    const upgraded = new GitStore(seeded.sql, { tx: countingTx(txCounter) });
    assertEq(upgraded.schemaState.adopted, true, "outcome says adopted");
    assertEq(upgraded.schemaState.reset, false, "no reset on the adopt path");
    assertEq(upgraded.schemaState.applied, BASELINE_IDS, "both steps applied on adopt");
    assertEq(journalIds(seeded.sql), BASELINE_IDS, "journal rebuilt with every step");
    assert(txCounter.begin >= 2, "steps ran inside the caller's transactions");
    // data intact — rows seeded through the real APIs survive untouched
    assertEq(
      upgraded.getRef("refs/heads/main"),
      "2222222222222222222222222222222222222222",
      "ref intact"
    );
    assertEq(upgraded.head(), "refs/heads/main", "HEAD intact");
    const obj = await upgraded.get("1111111111111111111111111111111111111111");
    assertEq(obj.type, "blob", "loose object intact");
    assertEq(new TextDecoder().decode(obj.data), "hello migration world", "loose object content intact");
    assert(upgraded.getLease("lease-tok-1") !== null, "lease row intact");
    assertEq(upgraded.packs.countPackRows("pack-abc"), 1, "pack index row intact");
    const catalog = seeded.sql.exec("SELECT pack_key, state, location FROM pack_catalog").toArray();
    assertEq(catalog, [{ pack_key: "pack-abc", state: "active", location: "r2" }], "catalog row intact");
    // demonstrator index rebuilt
    assert(indexNames(seeded.sql).has(DEMO_INDEX), "demonstrator index recreated on adopt");
  });

  await check("demonstrator 0002: planner upgrade proven before/after on the keyset query", async () => {
    // BEFORE (legacy-shaped database, no 0002): the oid keyset page cannot
    // use the oid primary key through the pack filter nor (pack_key, offset)
    // through the oid range/order — no index seek on (pack_key, oid).
    const legacy = openDb();
    legacy.sql.exec(REPO_STORE_BASELINE_SQL);
    legacy.sql.exec(REPO_PACK_BASELINE_SQL);
    const before = queryPlan(
      legacy.sql,
      "SELECT oid FROM pack_objects WHERE pack_key = ? AND oid > ? ORDER BY oid LIMIT 5",
      "pack-abc",
      ""
    );
    assert(!before.includes(DEMO_INDEX), `pre-0002 plan must not use the index, got: ${before}`);
    // AFTER: the same query seeks the demonstrator index.
    const { sql } = openDb();
    new GitStore(sql);
    const after = queryPlan(
      sql,
      "SELECT oid FROM pack_objects WHERE pack_key = ? AND oid > ? ORDER BY oid LIMIT 5",
      "pack-abc",
      ""
    );
    assert(after.includes(DEMO_INDEX), `post-0002 plan uses the index, got: ${after}`);
  });

  await check("re-open is a no-op: journal and schema untouched", async () => {
    const { sql } = openDb();
    const first = new GitStore(sql);
    seedStore(first);
    const snapshot = () => ({
      journal: journalRows(sql),
      master: sql.db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
      refs: sql.exec("SELECT name, oid FROM refs").toArray(),
      catalog: sql.exec("SELECT * FROM pack_catalog").toArray(),
      objects: sql.exec("SELECT oid FROM objects").toArray(),
      meta: sql.exec("SELECT key, value FROM meta ORDER BY key").toArray(),
    });
    const before = snapshot();
    const second = new GitStore(sql);
    assertEq(second.schemaState.applied, [], "second open applies nothing");
    assertEq(second.schemaState.adopted, false, "second open is not an adopt");
    assertEq(snapshot(), before, "journal (incl. applied_at stamps), schema and rows identical");
  });

  await check("demonstrator 0002 applies exactly once across many opens", async () => {
    const { sql } = openDb();
    for (let i = 0; i < 3; i++) new GitStore(sql);
    const rows = journalRows(sql).filter((r) => r.id === DEMO_STEP);
    assertEq(rows.length, 1, "exactly one journal row for 0002");
    assert(indexNames(sql).has(DEMO_INDEX), "index present");
  });

  await check("unrecognized pre-baseline state FAILS CLOSED: sealed store, data byte-untouched", async () => {
    const { sql } = makeLegacyDb("0001a-step3"); // an older dev-scratch generation
    sql.exec("INSERT INTO refs (name, oid, peeled, updated_at) VALUES ('refs/heads/main', 'aa', NULL, 1)");
    const store = new GitStore(sql);
    assert(store.schemaState.refused !== null, "outcome carries the refusal");
    assert(
      /unrecognized pre-baseline schema state/.test(store.schemaState.refused),
      `refusal names the state model, got: ${store.schemaState.refused}`
    );
    assert(/allowUnknownSchemaReset/.test(store.schemaState.refused), "refusal names the explicit flag");
    // posture (a): every data read/write refuses with the DISTINCT diagnostic
    for (const probe of [
      () => store.getMeta("head"),
      () => store.setMeta("x", "y"),
      () => store.get("1111111111111111111111111111111111111111"),
      () => store.put("1111111111111111111111111111111111111111", "blob", new TextEncoder().encode("x")),
      () => store.refs(),
      () => store.setRef("refs/heads/x", "aa"),
      () => store.createLease("t", "receive", 1, "{}"),
      () => store.packs.putRows("pack-x", []),
      () => store.packs.recordPack("pack-x", 1, 1),
    ]) {
      let err = null;
      try {
        await probe();
      } catch (e) {
        err = e;
      }
      assert(err !== null, "data access refused");
      assert(
        err.message.startsWith("[schema sealed]"),
        `distinct sealed diagnostic, got: ${err.message}`
      );
    }
    // the database is byte-untouched: rows intact, no journal ever created
    assertEq(
      sql.exec("SELECT COUNT(*) AS n FROM refs").one().n,
      1,
      "ref row survived the sealed open"
    );
    assert(!tableNames(sql).has("schema_migrations"), "refusal wrote nothing (no journal created)");
    assert(!indexNames(sql).has(DEMO_INDEX), "refusal created no index");
  });

  await check("posture (b): explicit DELETE (wipe) recovers a sealed cell, re-creatable after", async () => {
    const { sql } = makeLegacyDb("0001a-step3");
    sql.exec("INSERT INTO refs (name, oid, peeled, updated_at) VALUES ('refs/heads/main', 'aa', NULL, 1)");
    const store = new GitStore(sql);
    assert(store.schemaState.refused !== null, "opened sealed (sanity)");
    // the DELETE endpoint's wipe: unseals, rebuilds at head, journal truthful
    store.wipe();
    assertEq(store.schemaState.refused, null, "wiped store is no longer sealed");
    assertEq(journalIds(sql), BASELINE_IDS, "journal rebuilt at head after the recovery wipe");
    assert(indexNames(sql).has(DEMO_INDEX), "demonstrator index rebuilt");
    assertEq(sql.exec("SELECT COUNT(*) AS n FROM refs").one().n, 0, "stale state actually wiped");
    // the cell is re-creatable: normal store APIs work end to end afterward
    const blob = new TextEncoder().encode("recreated after sealed wipe");
    store.put("dddddddddddddddddddddddddddddddddddddddd", "blob", blob);
    const got = await store.get("dddddddddddddddddddddddddddddddddddddddd");
    assertEq(got.data, blob, "recreated object round-trips");
    store.setRef("refs/heads/main", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    assertEq(store.getRef("refs/heads/main"), "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "re-created ref lands");
    // and a fresh construction over the recovered database is a normal no-op open
    const reopened = new GitStore(sql);
    assertEq(reopened.schemaState, { applied: [], adopted: false, reset: false, refused: null }, "clean re-open");
  });

  await check("unrecognized state + explicit flag: LOUD reset, store usable after", async () => {
    const { sql } = makeLegacyDb("0001a-step3");
    sql.exec("INSERT INTO refs (name, oid, peeled, updated_at) VALUES ('refs/heads/main', 'aa', NULL, 1)");
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    let store;
    try {
      store = new GitStore(sql, { allowUnknownSchemaReset: true });
    } finally {
      console.error = origError;
    }
    assertEq(store.schemaState.reset, true, "outcome says reset");
    assertEq(store.schemaState.adopted, false, "a reset is not an adopt");
    assertEq(journalIds(sql), BASELINE_IDS, "journal rebuilt from scratch");
    assert(
      errors.some((line) => /LOUD dev-scratch reset/.test(line)),
      `reset logged loudly, got: ${JSON.stringify(errors)}`
    );
    assertEq(sql.exec("SELECT COUNT(*) AS n FROM refs").one().n, 0, "scratch rows are gone (reset)");
    // and the store is fully usable afterward
    const blob = new TextEncoder().encode("after reset");
    store.put("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "blob", blob);
    const got = await store.get("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assertEq(got.data, blob, "store usable after the loud reset");
  });

  await check("forward-only tripwire: a journal ahead of the build seals the store", async () => {
    const { sql } = openDb();
    new GitStore(sql);
    sql.exec("INSERT INTO schema_migrations (id, applied_at) VALUES ('0009-future-step', 1)");
    const store = new GitStore(sql);
    assert(store.schemaState.refused !== null, "opened sealed");
    assert(
      /newer than the running build/.test(store.schemaState.refused),
      `refusal explains the downgrade posture, got: ${store.schemaState.refused}`
    );
    // the DELETE recovery applies here too
    store.wipe();
    assertEq(store.schemaState.refused, null, "wipe recovers the downgraded-against cell");
    assertEq(journalIds(sql), BASELINE_IDS, "journal rebuilt at head");
  });

  await check("registry fresh DO: baseline applies, journal recorded, re-open no-op", async () => {
    const { sql } = openDb();
    const first = runRegistryMigrations(sql);
    assertEq(first.applied, REGISTRY_MIGRATIONS.map((m) => m.id), "registry baseline applied");
    // the table is immediately usable through a GitStore-shaped exec
    sql.exec(
      "INSERT INTO repos (name, idle, ver) VALUES ('demo', 42, 1)"
    );
    const second = runRegistryMigrations(sql);
    assertEq(second.applied, [], "second run applies nothing");
    assertEq(journalIds(sql), REGISTRY_MIGRATIONS.map((m) => m.id), "journal stable");
    assertEq(
      sql.exec("SELECT name, idle FROM repos").toArray(),
      [{ name: "demo", idle: 42 }],
      "registry row survived re-open"
    );
  });

  await check("registry legacy column vintage: ALTER baseline adds columns, rows survive", async () => {
    const { sql } = openDb();
    // a registry db from before section/priv/ver existed
    sql.exec(`
      CREATE TABLE repos (
        name TEXT PRIMARY KEY,
        desc TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        idle INTEGER NOT NULL DEFAULT 0
      );
    `);
    sql.exec("INSERT INTO repos (name, idle) VALUES ('oldrepo', 7)");
    const outcome = runRegistryMigrations(sql);
    assertEq(outcome.applied, REGISTRY_MIGRATIONS.map((m) => m.id), "baseline recorded");
    const cols = sql.db.prepare("PRAGMA table_info(repos)").all().map((c) => c.name);
    for (const c of ["section", "priv", "ver"]) assert(cols.includes(c), `column ${c} added`);
    assertEq(
      sql.exec("SELECT name, idle, priv, ver FROM repos").toArray(),
      [{ name: "oldrepo", idle: 7, priv: 0, ver: 1 }],
      "legacy row survived with defaulted new columns"
    );
  });

  await check("wipe returns the store to schema head with a truthful journal", async () => {
    const { sql } = openDb();
    const store = new GitStore(sql);
    seedStore(store);
    store.wipe();
    assertEq(journalIds(sql), BASELINE_IDS, "journal rebuilt at head after wipe");
    assert(indexNames(sql).has(DEMO_INDEX), "demonstrator index rebuilt after wipe");
    assertEq(store.getMeta("schema_version"), LEGACY_SCHEMA_VERSION, "rollback marker re-recorded");
    assertEq(sql.exec("SELECT COUNT(*) AS n FROM refs").one().n, 0, "data actually wiped");
    // the wiped store stays fully usable
    const blob = new TextEncoder().encode("recreated");
    store.put("cccccccccccccccccccccccccccccccccccccccc", "blob", blob);
    const got = await store.get("cccccccccccccccccccccccccccccccccccccccc");
    assertEq(got.data, blob, "object round-trips after wipe");
  });

  await check("pack-only reset (gc path): journal replay keeps schema truthful", async () => {
    const { sql } = openDb();
    const store = new GitStore(sql);
    seedStore(store);
    store.packs.reset(); // drops ONLY the pack tables
    assertEq(journalIds(sql), BASELINE_IDS, "journal rebuilt (0001 + 0002) after pack reset");
    assert(indexNames(sql).has(DEMO_INDEX), "demonstrator index rebuilt after pack reset");
    const tables = tableNames(sql);
    for (const t of ["pack_catalog", "pack_data", "pack_objects", "fork_import"]) {
      assert(tables.has(t), `pack table ${t} recreated`);
    }
    assertEq(sql.exec("SELECT COUNT(*) AS n FROM refs").one().n, 1, "GitStore data untouched");
    // packs are push-ready again
    store.packs.putRows("pack-xyz", [
      {
        oid: "4444444444444444444444444444444444444444",
        offset: 0,
        dataOff: 12,
        dataLen: 30,
        type: "blob",
        size: 21,
        entrySize: 34,
        baseOid: null,
        crc32: 9,
      },
    ]);
    store.packs.recordPack("pack-xyz", 4096, 256);
    assertEq(store.packs.countPackRows("pack-xyz"), 1, "pack writes work after reset");
  });

  await check("journal loss converges: marker classifies as adopted, replay rebuilds", async () => {
    // a post-M3 database that somehow lost its journal must NOT fail closed:
    // the legacy marker classifies it as adopted and the idempotent replay
    // rebuilds the journal
    const { sql } = openDb();
    const store = new GitStore(sql);
    seedStore(store);
    sql.exec("DROP TABLE schema_migrations");
    const reopened = new GitStore(sql);
    assertEq(reopened.schemaState.adopted, true, "classified as adopted via the marker");
    assertEq(journalIds(sql), BASELINE_IDS, "journal rebuilt");
    assertEq(
      reopened.getRef("refs/heads/main"),
      "2222222222222222222222222222222222222222",
      "data intact through the journal-loss replay"
    );
  });

  await check("runRepoMigrations standalone matches the constructor path", async () => {
    const { sql } = makeLegacyDb();
    const counter = { begin: 0, db: sql.db };
    const outcome = runRepoMigrations(sql, { tx: countingTx(counter) });
    assertEq(outcome.adopted, true, "standalone runner adopts the legacy marker");
    assertEq(outcome.applied, BASELINE_IDS, "standalone runner applies every step");
    assertEq(journalIds(sql), BASELINE_IDS, "journal recorded by the standalone runner");
  });

  await check("dropRepoSchema clears every generation incl. scratch tables", async () => {
    const { sql } = makeLegacyDb();
    sql.exec("CREATE TABLE IF NOT EXISTS pack_meta (id INTEGER PRIMARY KEY)"); // pre-Step-4 scratch
    dropRepoSchema(sql);
    const tables = tableNames(sql);
    assertEq(tables.size, 0, "nothing left after the drop");
  });

  if (failures.length) {
    console.log(`\n${failures.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log(`\nall ${planned} engine checks passed`);
}

main();

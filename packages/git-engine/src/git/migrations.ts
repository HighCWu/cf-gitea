/**
 * DO SQLite schema migrations (SPEC-0011 §8, milestone M3.0).
 *
 * Before this module the engine's only schema guard was the dev-scratch
 * `SCHEMA_VERSION` meta check in store.ts: any mismatch wiped the database
 * (SPEC-0001a §3 Step 4 — legitimate while "no production data exists
 * pre-M1" held). M3 changes the schema (pack lifecycle states, lease payload
 * v2) against databases that now hold production data, so the engine gets a
 * REAL forward-only migration mechanism.
 *
 * Design (the journal choice): each Durable Object owns one SQLite database
 * whose entire contents belong to the engine, so a dedicated journal table is
 * strictly more informative than a single `schema_version` meta row:
 *
 * - Every applied migration is recorded BY ID (`schema_migrations`), so the
 *   upgrade decision per step is "is this id in the journal" — no central
 *   version arithmetic, and a partially-upgraded database (a migration that
 *   committed, then the isolate died before the next one) is represented
 *   exactly and resumes correctly.
 * - A single scalar version cannot distinguish "baseline only" from
 *   "baseline + steps 1-3" without an ordering side channel; the journal IS
 *   the ordering record.
 * - The journal doubles as the downgrade tripwire: an id the running build
 *   does not know means the database is AHEAD of the code (rollback past a
 *   schema step) — fail closed rather than improvise against a newer schema.
 *
 * Rules, normative:
 *
 * 1. FORWARD-ONLY. Steps are an ordered list; a step runs only when its id is
 *    missing from the journal ("guarded by the journal"). There is no down
 *    path — rollback past a migration is unsupported by design.
 * 2. EVERY STEP IDEMPOTENT. `CREATE TABLE/INDEX IF NOT EXISTS`, guarded
 *    `ALTER TABLE ADD COLUMN`, backfills with WHERE guards. This is the crash
 *    story: a step + its journal insert run inside one transaction when the
 *    caller supplies a `tx` runner (`ctx.storage.transactionSync` at the DO
 *    construction sites), so production never sees a half-applied step; and
 *    even without the wrapper a replay converges instead of corrupting.
 * 3. BASELINE ADOPTION. Migration `0001` is the baseline snapshot: the exact
 *    CREATE TABLE set the engine ships today (store.ts + packstore.ts init(),
 *    the state the dev-scratch guard called `0001a-step4`). A fresh DO
 *    replays baseline + steps uniformly; an existing `0001a-step4` DO (every
 *    production DO — two green deploys at that generation) adopts the journal
 *    with ZERO data movement: the idempotent baseline no-ops against its
 *    tables and the steps apply on top, in place.
 * 4. RESET POSTURE (the dev-scratch transition). The only states that exist
 *    in the wild are "fresh" and "0001a-step4". A database carrying engine
 *    tables whose `meta.schema_version` says anything else — including the
 *    marker-less databases predating the Step-4 marker — is an older
 *    DEV-SCRATCH generation (no production deploy ever ran one: every
 *    Step-4+ build stamped the marker at every open, so a production DB
 *    always carries it). Such a state FAILS CLOSED as a SEALED store: the
 *    migration decision touches nothing, the store is handed back sealed
 *    (`schemaState.refused`, see schemaSealedError), and EVERY data access
 *    raises the sealed diagnostic — nothing is ever served from an
 *    unrecognized schema. The old silent wipe is gone; it must never destroy
 *    a production repo's data on a mis-detected version. Two recoveries
 *    remain, both explicit: the repo's DELETE endpoint (the DO's wipe path
 *    unseals and rebuilds at head — a sealed store is always deletable, so
 *    the failure never bricks the cell) and the `allowUnknownSchemaReset`
 *    GitStore flag, which resets at construction and logs LOUDLY
 *    (`console.error`) before dropping anything. Wipe paths that legitimately
 *    rebuild the schema (repo delete, gc's pack reset) go through
 *    `replayRepoSchema`, which re-applies the idempotent list and rebuilds
 *    the journal — never through the reset flag.
 */

/** Journal table: one row per applied migration. Lives in the SAME SQLite
 * database as the schema it describes (both the repo DO's and the registry
 * DO's — they are separate databases, each with its own journal). */
export const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";

/**
 * The dev-scratch generation marker that maps to the baseline snapshot: the
 * `meta.schema_version` value the pre-M3.0 guard (store.ts's old
 * `SCHEMA_VERSION`) wrote. A database carrying it adopts the journal without
 * touching a single row.
 */
export const LEGACY_SCHEMA_VERSION = "0001a-step4";

/** Transaction wrapper a DO construction site passes
 * (`ctx.storage.transactionSync`) so each migration + its journal insert is
 * atomic. Absent, steps run autocommit — safe because every step is
 * idempotent (rule 2). */
export type TxRunner = (fn: () => void) => void;

export interface SchemaMigrationStep {
  /** Stable, ordered id ("0001-...", "0002-...", ...). NEVER renamed or
   * reused once shipped — the journal keys on it. */
  id: string;
  /** The upgrade, idempotent by contract (rule 2). */
  up(sql: SqlStorage): void;
}

/** Transaction options a migration runner accepts. */
export interface MigrationOptions {
  /** Wraps each step + its journal insert in one transaction (rule 2). */
  tx?: TxRunner;
  /** LOUD dev-scratch escape hatch: when an unrecognized pre-baseline state
   * is detected, wipe + replay instead of throwing (rule 4). Default false. */
  allowUnknownSchemaReset?: boolean;
}

export interface SchemaMigrationOutcome {
  /** Ids this call applied, in order (empty = journal already current). */
  applied: string[];
  /** The database carried pre-migration `0001a-step4` data and adopted the
   * journal in place (baseline no-op'd, data untouched). */
  adopted: boolean;
  /** An unrecognized pre-baseline state was LOUDLY reset (flagged path only). */
  reset: boolean;
  /** Refusal reason for an unrecognized pre-baseline state (or a journal
   * ahead of this build) opened WITHOUT `allowUnknownSchemaReset`. The store
   * constructs SEALED: nothing was read or written, every data access fails,
   * and only an explicit wipe (the repo's DELETE endpoint) recovers the DO —
   * null when the store is open normally. */
  refused: string | null;
}

// ---------------------------------------------------------------------------
// Baseline snapshot — the single source of truth for the CREATE TABLE set.
// store.ts and packstore.ts delegate their init() DDL to these constants, so
// the baseline migration and the constructors can never drift apart.
// ---------------------------------------------------------------------------

/** GitStore-owned tables (store.ts init(), SPEC-0001 §4 as aligned at
 * SPEC-0001a §3 Step 4). Verbatim. */
export const REPO_STORE_BASELINE_SQL = `
  CREATE TABLE IF NOT EXISTS objects (
    oid TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    size INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks (
    oid TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (oid, seq)
  );
  CREATE TABLE IF NOT EXISTS refs (
    name TEXT PRIMARY KEY,
    oid TEXT NOT NULL,
    peeled TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reachable (
    oid TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS peeled (
    oid TEXT PRIMARY KEY,
    target TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stats_cache (
    tip_oid TEXT NOT NULL,
    period TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (tip_oid, period)
  );
  CREATE TABLE IF NOT EXISTS leases (
    lease_token TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
`;

/** PackStore-owned tables (packstore.ts init(), SPEC-0001 §4 / SPEC-0001a
 * §3 Step 4 shape, `state` per the M3 four-state lifecycle). Verbatim. */
export const REPO_PACK_BASELINE_SQL = `
  CREATE TABLE IF NOT EXISTS pack_catalog (
    pack_key TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'receive',
    state TEXT NOT NULL DEFAULT 'active',
    location TEXT NOT NULL DEFAULT 'r2',
    object_count INTEGER NOT NULL,
    pack_bytes INTEGER NOT NULL,
    idx_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    superseded_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pack_catalog_seq ON pack_catalog(seq);
  CREATE TABLE IF NOT EXISTS pack_data (
    pack_key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (pack_key, seq)
  );
  CREATE TABLE IF NOT EXISTS pack_objects (
    oid TEXT PRIMARY KEY,
    pack_key TEXT NOT NULL,
    offset INTEGER NOT NULL,
    data_off INTEGER NOT NULL,
    data_len INTEGER NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    entry_size INTEGER NOT NULL,
    base_oid TEXT,
    crc32 INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_pack_objects_loc ON pack_objects(pack_key, offset);
  CREATE TABLE IF NOT EXISTS fork_import (
    pack_key TEXT PRIMARY KEY,
    object_count INTEGER NOT NULL,
    pack_bytes INTEGER NOT NULL,
    idx_bytes INTEGER NOT NULL,
    staged_at INTEGER NOT NULL
  );
`;

/** The baseline step: the complete current-generation CREATE set. Idempotent
 * by construction — on a fresh database it builds everything; on an adopted
 * `0001a-step4` database every statement no-ops.
 *
 * The step ALSO records the legacy `meta.schema_version` marker (only when
 * absent): the PRE-M3.0 build's constructor wipes any database whose marker
 * is not `0001a-step4`, so a post-M3.0 database with no marker would be
 * silently destroyed by a rollback deploy. Keeping the marker at the legacy
 * value makes every step that ships under it openable by the old build
 * (additive DDL only — an extra index is invisible to it). The journal, not
 * the marker, is authoritative for the new code; a database that somehow
 * loses its journal classifies as `adopted` through this marker and
 * converges by idempotent replay instead of failing closed. If a future step
 * is NOT old-build-safe, revisit this contract in the same change. */
export function applyRepoBaseline(sql: SqlStorage): void {
  sql.exec(REPO_STORE_BASELINE_SQL);
  sql.exec(REPO_PACK_BASELINE_SQL);
  sql.exec(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING",
    LEGACY_SCHEMA_VERSION
  );
}

/**
 * The ordered, forward-only upgrade list for a repo DO's SQLite schema.
 *
 * 0001 — baseline snapshot (see above). Fresh DOs build it; existing
 *        `0001a-step4` DOs adopt it as already-applied (data preserved).
 * 0002 — DEMONSTRATOR (SPEC-0011 §8 M3.0): secondary index
 *        `idx_pack_objects_pack_oid` on pack_objects(pack_key, oid).
 *        Provably safe (a secondary index changes no query result, only the
 *        planner's access path) and useful today: the pack-keyed OID KEYSET
 *        pages — `packOidsAfter` / `indexRowsAfter`
 *        (`WHERE pack_key = ? AND oid > ? ORDER BY oid LIMIT ?`, the
 *        cached-fast-forward walk on every push and the fork-replication row
 *        pages) and `sweepPackRows`' DELETE — key on (pack_key, oid), which
 *        no existing index fronted: the oid primary key cannot serve the
 *        pack filter, and (pack_key, offset) cannot serve the oid
 *        range/order. The check script pins the planner change
 *        (EXPLAIN QUERY PLAN): a pre-0002 database scans/sorts, a post-0002
 *        database seeks the index.
 * 0003 — PACK LIFECYCLE GOES LIVE (SPEC-0011 §2/§5.2, M3.3): the pack_catalog
 *        lifecycle columns are ACTIVATED for compaction's publish transition.
 *        Honesty note: the Step-4 alignment RESERVED `state` (NOT NULL
 *        DEFAULT 'active') and `superseded_by` on pack_catalog, so every
 *        database the Step-4+ builds ever created already carries both
 *        physically — this step makes their activation EXPLICIT and
 *        journal-recorded (per the M3.0 contract: a schema change lands as a
 *        step, never as another version bump), guards their presence with
 *        idempotent ALTERs for any vintage that somehow predates them, and
 *        backfills NULLs to 'active' (§2: every pre-compaction row is
 *        implicitly ACTIVE). Compaction's single-transaction publish — new
 *        row ACTIVE, superseded inputs → RETIRED with `superseded_by` — is
 *        the first writer of a non-default state.
 */
export const REPO_MIGRATIONS: SchemaMigrationStep[] = [
  { id: "0001-repo-baseline", up: applyRepoBaseline },
  {
    id: "0002-pack-objects-pack-oid-index",
    up: (sql) => {
      sql.exec("CREATE INDEX IF NOT EXISTS idx_pack_objects_pack_oid ON pack_objects(pack_key, oid)");
    },
  },
  {
    id: "0003-pack-catalog-state-live",
    up: (sql) => {
      // the try/ALTER chain follows the registry baseline's precedent: a
      // duplicate-column error is statement-local and leaves the transaction
      // usable, so the step stays idempotent (journal-guarded anyway)
      for (const col of ["state TEXT NOT NULL DEFAULT 'active'", "superseded_by TEXT"]) {
        try {
          sql.exec(`ALTER TABLE pack_catalog ADD COLUMN ${col}`);
        } catch {
          // column already exists (the common case — reserved at Step 4)
        }
      }
      sql.exec("UPDATE pack_catalog SET state = 'active' WHERE state IS NULL");
    },
  },
];

/**
 * Every table a repo DO's database can carry: the current generation, the
 * journal, and the pre-Step-4 scratch generations (`pack_meta`/
 * `pack_pending`/`push_edges`) the old clean-cutover wipe dropped. Only
 * `dropRepoSchema` (wipes, flagged resets) ever touches the full list.
 */
export const REPO_TABLES = [
  // current generation (GitStore)
  "objects",
  "chunks",
  "refs",
  "meta",
  "reachable",
  "peeled",
  "stats_cache",
  "leases",
  // current generation (PackStore)
  "pack_catalog",
  "pack_data",
  "pack_objects",
  "fork_import",
  // the journal itself
  SCHEMA_MIGRATIONS_TABLE,
  // pre-Step-4 generations (dev-scratch)
  "pack_meta",
  "pack_pending",
  "push_edges",
];

/** Registry DO schema steps. There was never a registry version marker (the
 * constructor ran unconditional idempotent DDL + try-ALTER column adds), so
 * every existing registry database — whatever its column vintage — flows
 * through the same idempotent baseline; there is no unrecognized state and
 * no reset posture on this side. */
export const REGISTRY_MIGRATIONS: SchemaMigrationStep[] = [
  {
    id: "0001-registry-baseline",
    up: (sql) => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS repos (
          name TEXT PRIMARY KEY,
          desc TEXT NOT NULL DEFAULT '',
          owner TEXT NOT NULL DEFAULT '',
          section TEXT NOT NULL DEFAULT '',
          priv INTEGER NOT NULL DEFAULT 0,
          idle INTEGER NOT NULL DEFAULT 0,
          ver INTEGER NOT NULL DEFAULT 1
        );
      `);
      // upgrade path for databases created by earlier versions (the exact
      // try-ALTER chain the constructor ran pre-M3.0; a duplicate-column
      // error is statement-local and leaves the transaction usable)
      for (const col of [
        "section TEXT NOT NULL DEFAULT ''",
        "priv INTEGER NOT NULL DEFAULT 0",
        "ver INTEGER NOT NULL DEFAULT 1",
      ]) {
        try {
          sql.exec(`ALTER TABLE repos ADD COLUMN ${col}`);
        } catch {
          // column already exists
        }
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Runner machinery
// ---------------------------------------------------------------------------

function ensureJournalTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
}

/** Journal contents WITHOUT creating the table — classification and refusal
 * decisions must not write anything to a database we may refuse to open. */
function readJournal(sql: SqlStorage): Set<string> {
  if (!tableExists(sql, SCHEMA_MIGRATIONS_TABLE)) return new Set();
  const rows = sql.exec<{ id: string }>(`SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE}`).toArray();
  return new Set(rows.map((r) => r.id));
}

function recordApplied(sql: SqlStorage, id: string): void {
  sql.exec(
    `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`,
    id,
    Date.now()
  );
}

/** Table existence without sqlite_master (workerd's DO SQLite does not
 * document metadata relations): a probe SELECT either parses or throws.
 * `name` is engine-controlled — never user input.
 *
 * The probe cursor MUST be drained. workerd bricks every subsequent
 * `DROP TABLE` of an EXISTING table on the connection with
 * `database table is locked: SQLITE_LOCKED` for the rest of the runtime
 * session when a `SqlStorage` SELECT cursor is discarded un-drained
 * (docs/research/workerd-ddl-cross-session-locked.md — the DDL distillation;
 * workerd#959). This probe runs at EVERY store construction over a database
 * whose tables exist (the common case — every session after first creation),
 * so the discarded cursor re-leaked once per open and re-bricked DDL in
 * every new session; on a fresh database the probed table is absent and the
 * prepare throws before any cursor exists, which is why creation sessions
 * never showed it. Drain by `.toArray()` — at most the one LIMIT 1 row —
 * the same idiom every other engine `sql.exec(<SELECT>)` uses and the exact
 * shape the distillation's CLEAN discriminator verified at runtime. There is
 * no close()/return() on `SqlStorageCursor` (types @cloudflare/workers-types
 * 5.20261025.1): `next()`/`toArray()`/`one()`/full iteration are the only
 * drains. Engine discipline: EVERY `sql.exec(<SELECT>)` cursor is drained;
 * only DDL/DML (which produce no row cursor) may discard. */
function tableExists(sql: SqlStorage, name: string): boolean {
  try {
    sql.exec(`SELECT 1 FROM ${name} LIMIT 1`).toArray();
    return true;
  } catch {
    return false;
  }
}

/**
 * The distinct diagnostic a SEALED store raises on any data access (see
 * SchemaMigrationOutcome.refused): an unrecognized pre-baseline schema state
 * was detected and the store refused to open — data access fails closed
 * until the DO is explicitly wiped (the repo's DELETE endpoint) or the
 * store is constructed with `allowUnknownSchemaReset`.
 */
export function schemaSealedError(reason: string): Error {
  return new Error(
    `[schema sealed] store refused to open and is read/write-sealed: ${reason} ` +
      `Every data access fails closed (SPEC-0011 §8). Recovery: DELETE the repo through its ` +
      `delete endpoint (the explicit wipe rebuilds the schema), or construct the store with ` +
      `\`allowUnknownSchemaReset\` to reset LOUDLY.`
  );
}

/**
 * Classify a repo database with an empty journal. "fresh" carries no engine
 * table at all; "adopted" is the `0001a-step4` dev-scratch marker every
 * production DO carries (mapped to the baseline, rule 3); anything else with
 * engine tables present is an older dev-scratch generation ("unrecognized",
 * rule 4).
 */
function classifyRepoState(sql: SqlStorage): "fresh" | "adopted" | "unrecognized" {
  const engineTables = REPO_TABLES.filter((t) => t !== SCHEMA_MIGRATIONS_TABLE);
  const present = engineTables.filter((t) => tableExists(sql, t));
  if (present.length === 0) return "fresh";
  if (!tableExists(sql, "meta")) return "unrecognized";
  const rows = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'").toArray();
  return rows[0]?.value === LEGACY_SCHEMA_VERSION ? "adopted" : "unrecognized";
}

/** Shared forward-only runner. Applies every journal-missing step in order,
 * each step + its journal insert under `opts.tx` when supplied. Called only
 * after the state decision — it may write. */
function runSteps(
  sql: SqlStorage,
  steps: SchemaMigrationStep[],
  opts: MigrationOptions,
  tx: TxRunner
): string[] {
  ensureJournalTable(sql);
  const done = readJournal(sql);
  assertJournalKnown(done, steps);
  const applied: string[] = [];
  for (const step of steps) {
    if (done.has(step.id)) continue; // guarded by the journal
    tx(() => {
      step.up(sql);
      recordApplied(sql, step.id);
    });
    applied.push(step.id);
  }
  return applied;
}

/** Downgrade tripwire: a journal id this build does not know means the
 * database was written by a NEWER engine — never open it with older code.
 * Throws (the registry path has no seal/recovery channel; the repo path
 * handles the same condition as a sealed refusal BEFORE reaching here). */
function assertJournalKnown(done: Set<string>, steps: SchemaMigrationStep[]): void {
  const known = new Set(steps.map((s) => s.id));
  for (const id of done) {
    if (!known.has(id)) {
      throw new Error(
        `[schema] journal contains unknown migration '${id}': this database is newer than the running ` +
          `build. Rolling back past a schema migration is unsupported (forward-only); redeploy the ` +
          `newer build.`
      );
    }
  }
}

/**
 * The repo-schema entry point, invoked at RepoCell construction (via the
 * GitStore constructor) BEFORE any store use. See the module header for the
 * state model.
 *
 * Never throws for state reasons and never writes anything before the state
 * decision is made: an unrecognized pre-baseline database (or one whose
 * journal is ahead of this build) opened WITHOUT `allowUnknownSchemaReset`
 * comes back `refused` — the caller seals the store (every data access
 * fails closed) while leaving the database byte-untouched, so the DO's
 * explicit DELETE endpoint stays reachable and wipes it as the user asked.
 */
export function runRepoMigrations(sql: SqlStorage, opts: MigrationOptions = {}): SchemaMigrationOutcome {
  const tx = opts.tx ?? ((fn: () => void) => fn());
  const done = readJournal(sql);

  // downgrade tripwire — the database is AHEAD of this build (rollback past
  // a schema migration); refuse sealed, recoverable the same way
  const known = new Set(REPO_MIGRATIONS.map((s) => s.id));
  for (const id of done) {
    if (!known.has(id)) {
      return {
        applied: [],
        adopted: false,
        reset: false,
        refused:
          `journal contains unknown migration '${id}': this database is newer than the running ` +
          `build. Rolling back past a schema migration is unsupported (forward-only); redeploy ` +
          `the newer build.`,
      };
    }
  }

  // fast path: journal already current — touch nothing else
  if (REPO_MIGRATIONS.every((s) => done.has(s.id))) {
    return { applied: [], adopted: false, reset: false, refused: null };
  }

  const state = done.size === 0 ? classifyRepoState(sql) : "partial";
  if (state === "unrecognized") {
    if (!opts.allowUnknownSchemaReset) {
      const rows = tableExists(sql, "meta")
        ? sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'").toArray()
        : [];
      return {
        applied: [],
        adopted: false,
        reset: false,
        refused:
          `unrecognized pre-baseline schema state (meta.schema_version=` +
          `${JSON.stringify(rows[0]?.value ?? null)}, engine tables present). This is an older ` +
          `dev-scratch generation — no production data ever carried it, and the automatic ` +
          `scratch wipe was removed (SPEC-0011 §8): it must never silently destroy a repo. ` +
          `Recovery: DELETE the repo (the explicit wipe rebuilds at head), or construct the ` +
          `store with \`allowUnknownSchemaReset\` to reset LOUDLY.`,
      };
    }
    // LOUD dev-scratch reset: the only path in the engine that destroys
    // data without an explicit user action, and it announces itself first
    console.error(
      "[schema] LOUD dev-scratch reset: unrecognized pre-baseline schema state detected — " +
        "dropping ALL engine tables and replaying the migration list. Data is being destroyed " +
        "by explicit flag (allowUnknownSchemaReset)."
    );
    tx(() => {
      dropRepoSchema(sql);
      ensureJournalTable(sql);
    });
    const applied = runSteps(sql, REPO_MIGRATIONS, opts, tx);
    return { applied, adopted: false, reset: true, refused: null };
  }

  // fresh, adopted and partially-applied databases take the SAME uniform
  // replay: the baseline is idempotent (builds a fresh schema, no-ops an
  // existing one) and the steps apply on top — an adopted DO never has a row
  // touched, and a journal missing later ids simply resumes forward
  const applied = runSteps(sql, REPO_MIGRATIONS, opts, tx);
  return { applied, adopted: state === "adopted", reset: false, refused: null };
}

/**
 * Re-apply the WHOLE idempotent migration list, rebuilding the journal from
 * scratch. This is the WIPE-path primitive (GitStore.wipe / PackStore.wipe):
 * after tables are dropped the journal over-reports, so it is cleared and
 * every step re-applied — the rebuilt schema and journal are truthful and at
 * the current head. Never used for data-bearing upgrades.
 */
export function replayRepoSchema(sql: SqlStorage, opts: MigrationOptions = {}): string[] {
  const tx = opts.tx ?? ((fn: () => void) => fn());
  ensureJournalTable(sql);
  sql.exec(`DELETE FROM ${SCHEMA_MIGRATIONS_TABLE}`);
  const applied: string[] = [];
  for (const step of REPO_MIGRATIONS) {
    tx(() => {
      step.up(sql);
      recordApplied(sql, step.id);
    });
    applied.push(step.id);
  }
  return applied;
}

/** Drop EVERY table a repo DO's database can carry (see REPO_TABLES). Used
 * by GitStore.wipe and the flagged scratch reset; always followed by a
 * baseline rebuild (init()/replay), never left empty. */
export function dropRepoSchema(sql: SqlStorage): void {
  for (const t of REPO_TABLES) {
    sql.exec(`DROP TABLE IF EXISTS ${t}`);
  }
}

/**
 * The registry-schema entry point, invoked at Registry construction before
 * any use. Same journal machinery, registry step list; no unrecognized-state
 * handling (see REGISTRY_MIGRATIONS) — the one refusal case (a journal ahead
 * of this build) throws: a site-wide singleton DO with no delete channel
 * fails the deployment loudly instead of sealing quietly.
 */
export function runRegistryMigrations(sql: SqlStorage, opts: MigrationOptions = {}): SchemaMigrationOutcome {
  const tx = opts.tx ?? ((fn: () => void) => fn());
  const applied = runSteps(sql, REGISTRY_MIGRATIONS, opts, tx);
  return { applied, adopted: false, reset: false, refused: null };
}

import { concat, te, sha1hex } from "./util";
import { deflate, inflate } from "./zlib";
import { ObjType, parseTag } from "./objects";
import { OidSet } from "./oidset";
import { PackStore, LOOSE_LOOKUP_CAP, type ReadGate } from "./packstore";
import { ObjCache, ObjRec } from "../receive/objcache";
import type { LookupObjectHit, LookupObjectResult } from "../control-plane";
import {
  REPO_STORE_BASELINE_SQL,
  dropRepoSchema,
  runRepoMigrations,
  schemaSealedError,
  type SchemaMigrationOutcome,
} from "./migrations";

/**
 * Options for opening a GitStore. The schema itself is owned by the
 * forward-only migration journal (src/git/migrations.ts, SPEC-0011 §8) —
 * constructed DBs are versioned by the `schema_migrations` journal table, not
 * a single version scalar.
 */
export interface GitStoreOptions {
  /** Wraps each schema migration + its journal insert in ONE transaction —
   * pass `ctx.storage.transactionSync` at the DO construction site. Absent,
   * the idempotent steps run autocommit. The SAME runner is kept on the store
   * (see `tx()`) so read-lease plan/renew pairs run atomically too
   * (SPEC-0011 §3). */
  tx?: <T>(fn: () => T) => T;
  /**
   * LOUD dev-scratch escape hatch (default FALSE): an unrecognized
   * pre-baseline schema state (an older dev-scratch generation's
   * `meta.schema_version`) opens the store SEALED — every data access fails
   * CLOSED until the DO is explicitly wiped — unless this flag resets it at
   * construction, logging loudly before dropping anything. It must never
   * silently destroy a production repo's data (SPEC-0011 §8).
   */
  allowUnknownSchemaReset?: boolean;
}

/** A ref row (SPEC-0001 §4 `refs`). `peeled` caches a tag tip's commit target
 * (null for branches and lightweight tags); `updatedAt` feeds lease/sweep
 * diagnostics. HEAD is NOT a row — it lives in `meta.head`. */
export interface RefRow {
  name: string;
  oid: string;
  /** commit target when this ref is an annotated tag (resolved once, at first
   * peel), else null */
  peeled: string | null;
  /** unix millis of the last write */
  updatedAt: number;
}

/** A reachable pack entry, streamed in storage order by `reachablePackedAfter`.
 *  The `size` field of a full PackedEntry is not needed to emit the pack, so it
 *  is left unselected. */
export interface PackedReachable {
  oid: string;
  packKey: string;
  offset: number;
  dataOff: number;
  dataLen: number;
  type: ObjType;
  entrySize: number;
  baseOid: string | null;
}

const CHUNK = 1024 * 1024; // stay well under the DO SQLite per-row limit
// serving cache: Workers isolates have a hard 128MB total, so stay modest
// there; self-hosted celld nodes run with multi-GB heaps
const CACHE_BUDGET = typeof caches !== "undefined" ? 16 * 1024 * 1024 : 128 * 1024 * 1024;

/** A receive/compaction lease row (SPEC-0001 §4 `leases`). */
export interface LeaseRow {
  leaseToken: string;
  kind: string;
  /** unix millis */
  expiresAt: number;
  /** small JSON (staging key), so sweeps reclaim R2 objects without a request */
  payload: string;
}

/**
 * Git object database + refs, stored in a Durable Object's SQLite database.
 * Small/legacy objects live loose (zlib-deflated, chunked across rows);
 * pushed packs are kept verbatim and served through the PackStore index.
 *
 * Schema (SPEC-0001 §4, aligned at SPEC-0001a §3 Step 4): refs(name, oid,
 * peeled, updated_at) with HEAD in meta.head; meta(key, value) carrying the
 * formal key set `head`, `refs_version`, `next_pack_seq`,
 * `compaction_wanted_at` (plus legacy UI keys until the content split);
 * pack_catalog/pack_objects/pack_data (see packstore.ts); leases. The
 * `reachable`/`peeled`/`stats_cache` tables are kept per the amendment's
 * decision table (M4 clone fast path / oid peel cache / UI stats). Since
 * SPEC-0011 §8 (M3.0) the schema is versioned by the forward-only
 * `schema_migrations` journal (src/git/migrations.ts) — schema changes land
 * as ordered migration steps, never as another dev-scratch version bump.
 */
export class GitStore {
  readonly packs: PackStore;
  readonly cache = new ObjCache(CACHE_BUDGET);
  /** The constructor migration's outcome (diagnostics/tests): what the
   * journal did when this store opened. `refused` non-null means the store
   * is SEALED (see below) — mutable so `wipe()` can clear the posture after
   * rebuilding the schema. */
  schemaState: SchemaMigrationOutcome;
  /** Sealed posture (SPEC-0011 §8): an unrecognized pre-baseline schema was
   * detected and the store refuses every data access until an explicit wipe
   * (the repo's DELETE endpoint) rebuilds it. */
  private sealed: boolean;
  /** The caller's transaction wrapper (ctx.storage.transactionSync at the DO
   * construction site; identity when absent). Multi-statement invariant pairs
   * — read-lease plan+register, renew check+extend — run inside it. */
  private readonly txRunner: <T>(fn: () => T) => T;
  /**
   * Whether the loose `objects` table holds anything. A pushed repo is
   * pack-native — loose objects only appear after a gc migration (see
   * runGc) — so on the normal path this is false and every get/has/typeAndSize
   * skips a guaranteed-miss loose SELECT and goes straight to the pack index.
   * Cached in memory and mirrored to the `has-loose` meta row so it survives
   * isolate eviction; back-filled once for repos that predate the flag.
   */
  private hasLoose: boolean;

  constructor(private sql: SqlStorage, opts: GitStoreOptions = {}) {
    this.txRunner = opts.tx ?? (<T>(fn: () => T): T => fn());
    // SPEC-0011 §8 (M3.0): the forward-only migration journal runs BEFORE any
    // store use. A fresh DO replays baseline + steps uniformly; an existing
    // `0001a-step4` DO (every pre-M3 database) adopts the journal in place
    // with its data untouched; an unrecognized pre-baseline state — or a
    // journal ahead of this build — returns refused and the store opens
    // SEALED (below). The decision itself writes nothing, so a refused
    // database is byte-untouched and the DO's DELETE endpoint (which wipes)
    // stays reachable. See migrations.ts for the state model.
    this.schemaState = runRepoMigrations(sql, opts);
    this.sealed = this.schemaState.refused !== null;
    this.packs = new PackStore(sql, (oid) => this.getLoose(oid), this.sealed);
    if (this.sealed) {
      // touch nothing: the probe would read tables of an unrecognized layout
      this.hasLoose = false;
      return;
    }
    const flag = this.getMeta("has-loose");
    if (flag === null) {
      // back-fill: a repo migrated by an older build may already hold loose
      // objects with no flag set — probe once and record the answer
      const any = this.sql.exec("SELECT 1 FROM objects LIMIT 1").toArray().length > 0;
      this.setMeta("has-loose", any ? "1" : "0");
      this.hasLoose = any;
    } else {
      this.hasLoose = flag === "1";
    }
  }

  /** The distinct sealed-posture diagnostic — thrown by every data access on
   * a store whose schema was unrecognized (schemaState.refused carries the
   * reason; the error text names the recoveries). */
  private assertOpen(): void {
    if (this.sealed) throw schemaSealedError(this.schemaState.refused!);
  }

  /** Create this store's tables (idempotent). The DDL is the migration
   * baseline's GitStore half — one copy lives in migrations.ts so the
   * constructors and the baseline step can never drift apart. A sealed store
   * creates nothing (an unrecognized database is never written). */
  private init(): void {
    if (this.sealed) return;
    this.sql.exec(REPO_STORE_BASELINE_SQL);
  }

  has(oid: string): boolean {
    this.assertOpen();
    if (this.hasLoose && this.sql.exec("SELECT 1 FROM objects WHERE oid = ?", oid).toArray().length > 0) return true;
    return this.packs.typeAndSize(oid) !== null;
  }

  typeAndSize(oid: string): { type: ObjType; size: number } | null {
    this.assertOpen();
    if (this.hasLoose) {
      const rows = this.sql
        .exec<{ type: ObjType; size: number }>("SELECT type, size FROM objects WHERE oid = ?", oid)
        .toArray();
      if (rows[0]) return rows[0];
    }
    return this.packs.typeAndSize(oid);
  }

  private getLoose(oid: string): ObjRec | null {
    if (!this.hasLoose) return null;
    const rows = this.sql
      .exec<{ type: ObjType; size: number }>("SELECT type, size FROM objects WHERE oid = ?", oid)
      .toArray();
    if (!rows.length) return null;
    const chunks = this.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM chunks WHERE oid = ? ORDER BY seq", oid)
      .toArray();
    const packed = concat(chunks.map((r) => new Uint8Array(r.data)));
    return { type: rows[0].type, data: inflate(packed) };
  }

  /**
   * Resolve an object: loose storage first, then packs. `gate` (the serve
   * paths' per-segment read authorization, SPEC-0011 §4.1) reaches pack reads
   * only — loose objects live in SQLite, where there is no R2 GET to gate.
   */
  async get(oid: string, gate?: ReadGate): Promise<{ type: ObjType; data: Uint8Array } | null> {
    this.assertOpen();
    return this.getLoose(oid) ?? (await this.packs.getObject(oid, this.cache, gate));
  }

  /**
   * Bind (or clear) the R2 pack backend. Absent binding keeps every pack in
   * SQLite (celld / Workers without the binding). Idempotent and cheap; the
   * DO is per-repo, so this is set on each request. R2 keys are built by
   * src/git/r2keys.ts from the persisted storage key, not from a repo name.
   */
  setR2(bucket: R2Bucket | undefined, storageKey: string): void {
    this.packs.setR2(bucket, storageKey);
  }

  put(oid: string, type: ObjType, data: Uint8Array): void {
    this.assertOpen();
    if (this.sql.exec("SELECT 1 FROM objects WHERE oid = ?", oid).toArray().length > 0) return;
    const packed = deflate(data);
    this.sql.exec("INSERT INTO objects (oid, type, size) VALUES (?, ?, ?)", oid, type, data.length);
    for (let seq = 0, off = 0; off < packed.length || seq === 0; seq++, off += CHUNK) {
      const slice = packed.slice(off, off + CHUNK);
      this.sql.exec("INSERT INTO chunks (oid, seq, data) VALUES (?, ?, ?)", oid, seq, slice.buffer);
    }
    // the repo now has at least one loose object (gc migration path): the
    // loose probe can no longer be skipped
    if (!this.hasLoose) {
      this.hasLoose = true;
      this.setMeta("has-loose", "1");
    }
  }

  objectCount(): number {
    this.assertOpen();
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM objects").one().n + this.packs.countObjects();
  }

  /** Whether the repo holds ANY content — a ref, a catalog row, an index row
   * or a loose object. beginForkImport's empty-target check (SPEC-0001b §5.3:
   * a fork target that already finalized its import must never re-begin). */
  hasAnyContent(): boolean {
    this.assertOpen();
    return (
      this.refs().length > 0 ||
      this.sql.exec("SELECT 1 FROM pack_catalog LIMIT 1").toArray().length > 0 ||
      this.sql.exec("SELECT 1 FROM pack_objects LIMIT 1").toArray().length > 0 ||
      this.sql.exec("SELECT 1 FROM objects LIMIT 1").toArray().length > 0
    );
  }

  // --- Worker object lookups (SPEC-0001a §3 Step 2) --------------------------
  // Thin-pack base resolution and the receive connectivity anti-check run in
  // the Worker; this is their only window into the object database. Packed
  // hits return the pack key + entry range (the Worker R2-reads the bytes
  // itself); loose hits ship their content inline, because loose bytes live in
  // DO SQLite where the Worker cannot reach.

  /** Aligned with the input oids; packed hits first, loose content as fallback. */
  lookupObjectsForWorker(oids: string[]): LookupObjectResult[] {
    this.assertOpen();
    const packed = this.packs.lookupPacked(oids);
    const out: LookupObjectResult[] = new Array(oids.length);
    for (let i = 0; i < oids.length; i++) {
      const hit = packed[i];
      if (hit) {
        out[i] = hit;
        continue;
      }
      out[i] = this.lookupLooseForWorker(oids[i]);
    }
    return out;
  }

  private lookupLooseForWorker(oid: string): LookupObjectResult {
    if (!this.hasLoose) return { found: false };
    const rows = this.sql
      .exec<{ type: ObjType; size: number }>("SELECT type, size FROM objects WHERE oid = ?", oid)
      .toArray();
    if (!rows.length) return { found: false };
    const hit: LookupObjectHit = {
      found: true,
      packKey: "", // loose: no pack entry; the Worker cannot range-read SQLite
      offset: -1,
      dataOff: -1,
      dataLen: rows[0].size,
      type: rows[0].type,
      baseOid: null,
    };
    if (rows[0].size <= LOOSE_LOOKUP_CAP) {
      const chunks = this.sql
        .exec<{ data: ArrayBuffer }>("SELECT data FROM chunks WHERE oid = ? ORDER BY seq", oid)
        .toArray();
      hit.data = inflate(concat(chunks.map((r) => new Uint8Array(r.data))));
    }
    return hit;
  }

  // --- receive leases (SPEC-0001a §3 Step 1) --------------------------------
  // One exclusive receive lease serializes pushes (T7): a second beginReceive
  // busy-waits (503 Retry-After) until finalize/release/expiry. Payloads are
  // small JSON (staging key) so the sweep can reclaim R2 objects without a
  // request. beginReceive sweeps expired rows lazily; the alarm is the
  // backstop for repos that receive no further pushes.

  toLeaseRow(row: { lease_token: string; kind: string; expires_at: number; payload: string }): LeaseRow {
    return { leaseToken: row.lease_token, kind: row.kind, expiresAt: row.expires_at, payload: row.payload };
  }

  createLease(leaseToken: string, kind: string, expiresAt: number, payload: string): void {
    this.assertOpen();
    this.sql.exec(
      "INSERT INTO leases (lease_token, kind, expires_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(lease_token) DO UPDATE SET kind = excluded.kind, expires_at = excluded.expires_at, payload = excluded.payload",
      leaseToken,
      kind,
      expiresAt,
      payload
    );
  }

  getLease(leaseToken: string): LeaseRow | null {
    this.assertOpen();
    const rows = this.sql
      .exec<{ lease_token: string; kind: string; expires_at: number; payload: string }>(
        "SELECT lease_token, kind, expires_at, payload FROM leases WHERE lease_token = ?",
        leaseToken
      )
      .toArray();
    return rows[0] ? this.toLeaseRow(rows[0]) : null;
  }

  deleteLease(leaseToken: string): void {
    this.assertOpen();
    this.sql.exec("DELETE FROM leases WHERE lease_token = ?", leaseToken);
  }

  /** Persist new lease payload JSON (the Worker's first putIndexRows batch
   * allocates the pack; finalize and the sweeps read it from here). */
  updateLeasePayload(leaseToken: string, payload: string): void {
    this.assertOpen();
    this.sql.exec("UPDATE leases SET payload = ? WHERE lease_token = ?", payload, leaseToken);
  }

  hasActiveReceiveLease(now: number): boolean {
    return this.hasActiveLease("receive", now);
  }

  /** Whether any UNEXPIRED lease of `kind` exists — the mutual-exclusion
   * probe. Receives block compaction (SPEC-0011 §5.1); a compaction lease
   * blocks concurrent compactions (§5.2 step 1). */
  hasActiveLease(kind: string, now: number): boolean {
    this.assertOpen();
    return (
      this.sql.exec("SELECT 1 FROM leases WHERE kind = ? AND expires_at > ? LIMIT 1", kind, now).toArray().length > 0
    );
  }

  expiredLeases(now: number): LeaseRow[] {
    this.assertOpen();
    return this.sql
      .exec<{ lease_token: string; kind: string; expires_at: number; payload: string }>(
        "SELECT lease_token, kind, expires_at, payload FROM leases WHERE expires_at <= ?",
        now
      )
      .toArray()
      .map((r) => this.toLeaseRow(r));
  }

  /**
   * Run `fn` inside the caller's DO transaction (the constructor's `tx`
   * runner — `ctx.storage.transactionSync` in the cell). The read-lease
   * primitives (src/read-leases.ts) use this so their catalog-read +
   * row-write pairs are ONE SQLite transaction: plan+lease are atomic
   * (SPEC-0011 §3.1), and a renewal's liveness/state check cannot interleave
   * with a GC transition.
   */
  tx<T>(fn: () => T): T {
    return this.txRunner(fn);
  }

  /** Live read-lease rows (kind='read', unexpired), raw payload included —
   * the payload JSON is parsed by src/read-leases.ts. */
  readLeases(now: number): LeaseRow[] {
    this.assertOpen();
    return this.sql
      .exec<{ lease_token: string; kind: string; expires_at: number; payload: string }>(
        "SELECT lease_token, kind, expires_at, payload FROM leases WHERE kind = 'read' AND expires_at > ?",
        now
      )
      .toArray()
      .map((r) => this.toLeaseRow(r));
  }

  // --- refs_version (T4 edge-cache key, formal meta key per SPEC-0001 §4) ----
  // Bumped by every committed ref change (finalizeReceive's transaction, the
  // API commit builder, setHead), so a push invalidates every refs cache
  // entry at once.

  refsVersion(): string {
    const current = this.getMeta("refs_version");
    if (current !== null) return current;
    // first reader initializes; a repo always has a version from its first
    // lease on, and the counter only ever moves forward
    this.setMeta("refs_version", "1");
    return "1";
  }

  bumpRefsVersion(): void {
    const next = Number(this.refsVersion()) + 1;
    this.setMeta("refs_version", String(next));
  }

  /**
   * The formal meta key set (SPEC-0001 §4):
   *   head                 — the HEAD symref target ("refs/heads/main")
   *   refs_version         — monotonic counter, bumped by every ref change
   *   next_pack_seq        — pack_catalog sequence allocator (catalog order
   *                          only; never an R2 name — SPEC-0001a §3 Step 3)
   *   compaction_wanted_at — M3 compaction trigger stamp; written alongside
   *                          the M2 `gc-pending` flag today, consumed by M3
   * Legacy keys (`description`, `owner`, `section`, `private`, `has-loose`,
   * `reachable-version`, `repo`, `storage_key`, `created`, `last-push`,
   * `gc-pending`, `schema_version`, `deleted`) are retained until the
   * UI/content split moves them (SPEC-0001a §3 Step 4 decision table).
   */

  /** The pack_catalog sequence (meta `next_pack_seq`), allocated monotonically. */
  nextPackSeq(): number {
    const current = Number(this.getMeta("next_pack_seq") ?? "0") || 0;
    this.setMeta("next_pack_seq", String(current + 1));
    return current + 1;
  }

  /** Resolve an abbreviated oid; null if unknown or ambiguous. */
  findOid(prefix: string): string | null {
    this.assertOpen();
    if (!/^[0-9a-f]{4,40}$/.test(prefix)) return null;
    const loose = this.hasLoose
      ? this.sql
          .exec<{ oid: string }>("SELECT oid FROM objects WHERE oid LIKE ? LIMIT 2", prefix + "%")
          .toArray()
          .map((r) => r.oid)
      : [];
    const all = [...new Set([...loose, ...this.packs.findOidPrefix(prefix)])];
    return all.length === 1 ? all[0] : null;
  }

  allOids(): string[] {
    this.assertOpen();
    return this.sql.exec<{ oid: string }>("SELECT oid FROM objects").toArray().map((r) => r.oid);
  }

  deleteObject(oid: string): void {
    this.assertOpen();
    this.sql.exec("DELETE FROM objects WHERE oid = ?", oid);
    this.sql.exec("DELETE FROM chunks WHERE oid = ?", oid);
  }

  dbSize(): number {
    return this.sql.databaseSize;
  }

  /**
   * Drop EVERY table this store owns — the current schema generation, the
   * migration journal, and any older layouts a pre-cutover store may carry —
   * then rebuild at the CURRENT schema head. Synchronous end to end so a
   * caller can run it inside ONE `storage.transactionSync` (the delete wipe;
   * Rule 3 — the last blockConcurrencyWhile on this path). The instance stays
   * usable afterward: in-memory caches are reset and the fresh (empty)
   * schema is in place, so a re-creating push finds its tables. This is also
   * the SEALED-store recovery (SPEC-0011 §8): the repo DELETE endpoint is the
   * one request path a sealed DO still serves, and wiping it unseals the
   * instance — an unrecognized-schema cell is always deletable, never bricked.
   * The journal is rebuilt by `replayRepoSchema` (via packs.wipe) rather than
   * the detection runner: after a drop the idempotent list is simply
   * re-applied and re-recorded — a wiped repo comes back at head, never via
   * the unrecognized-state machinery. Deliberately NOT storage.deleteAll():
   * on celld, deleteAll sweeps the ltx replication control tables too and
   * permanently breaks WAL capture for the cell (patch submitted upstream).
   */
  wipe(): void {
    this.sealed = false; // the explicit wipe recovers a sealed store
    this.schemaState = { applied: [], adopted: false, reset: false, refused: null };
    dropRepoSchema(this.sql);
    this.init();
    // drops the pack tables, clears the caches, then replayRepoSchema
    // rebuilds the pack schema, the baseline no-ops and the journal —
    // store + pack tables and the journal all end at head, together
    this.packs.wipe();
    // meta (with the flag) is gone; a fresh empty repo has no loose objects
    this.hasLoose = false;
  }

  // --- refs (SPEC-0001 §4 `refs(name PK, oid, peeled, updated_at)`) ----------
  // HEAD is NOT a ref row: it is the meta.head symref target (moved out of the
  // table at the Step 4 schema alignment). All refs methods below exclude it
  // by construction.

  /** All refs, sorted by name. */
  refs(): RefRow[] {
    this.assertOpen();
    return this.sql
      .exec<{ name: string; oid: string; peeled: string | null; updated_at: number }>(
        "SELECT name, oid, peeled, updated_at FROM refs ORDER BY name"
      )
      .toArray()
      .map((r) => ({ name: r.name, oid: r.oid, peeled: r.peeled, updatedAt: r.updated_at }));
  }

  getRef(name: string): string | null {
    this.assertOpen();
    const rows = this.sql
      .exec<{ oid: string }>("SELECT oid FROM refs WHERE name = ?", name)
      .toArray();
    return rows[0]?.oid ?? null;
  }

  setRef(name: string, oid: string): void {
    this.assertOpen();
    this.sql.exec(
      "INSERT INTO refs (name, oid, peeled, updated_at) VALUES (?, ?, NULL, ?) ON CONFLICT(name) DO UPDATE SET oid = excluded.oid, peeled = NULL, updated_at = excluded.updated_at",
      name,
      oid,
      Date.now()
    );
  }

  delRef(name: string): void {
    this.assertOpen();
    this.sql.exec("DELETE FROM refs WHERE name = ?", name);
  }

  /** Cache a tag ref's peeled commit target on its row (SPEC-0001 §4 `peeled`):
   * the first peel after a tag lands pays the object reads, every later
   * advertisement/ls-refs reads the column instead. Guarded on the tip still
   * being `oid`, so a concurrent ref move never caches a stale peel. */
  setRefPeeled(name: string, oid: string, peeled: string): void {
    this.sql.exec("UPDATE refs SET peeled = ? WHERE name = ? AND oid = ? AND peeled IS NULL", peeled, name, oid);
  }

  /**
   * The peeled commit target of ref `name` (or of the oid itself for a
   * non-ref peel): follows tag objects down to the commit, caching the answer
   * on the refs row when the oid is a current ref tip. null when the object
   * chain does not reach a commit.
   */
  async peeledRefTarget(name: string, oid: string): Promise<string | null> {
    const rows = this.sql.exec<{ oid: string; peeled: string | null }>(
      "SELECT oid, peeled FROM refs WHERE name = ?",
      name
    ).toArray();
    if (rows[0]) {
      if (rows[0].oid !== oid) return null; // moved underneath: nothing to cache
      if (rows[0].peeled) return rows[0].peeled;
      if (this.typeAndSize(oid)?.type !== "tag") return null; // lightweight/branch
    }
    let cur = oid;
    for (let i = 0; i < 10; i++) {
      const obj = await this.get(cur);
      if (!obj) return null;
      if (obj.type === "commit") {
        if (cur !== oid && rows[0]) this.setRefPeeled(name, oid, cur);
        return cur;
      }
      if (obj.type === "tag") {
        cur = parseTag(obj.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** HEAD symref target, e.g. "refs/heads/main" (meta.head; the instance
   * default when never set). */
  head(): string {
    return this.getMeta("head") ?? "refs/heads/main";
  }

  /** Point HEAD at a branch (meta.head — SPEC-0001 §4). */
  setHead(refName: string): void {
    this.setMeta("head", refName);
  }

  /** Resolve HEAD to an oid, or null for an empty/unborn repo. */
  resolveHead(): string | null {
    return this.getRef(this.head());
  }

  getMeta(key: string): string | null {
    this.assertOpen();
    const rows = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray();
    return rows[0]?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.assertOpen();
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value
    );
  }

  /**
   * Cached peel target for an arbitrary oid (tag -> ... -> commit). Tag oids
   * are content-addressed and immutable, so a hit never needs a version
   * check. (Tag TIPS additionally cache on their refs row — peeledRefTarget.)
   */
  getPeeled(oid: string): string | null {
    this.assertOpen();
    const rows = this.sql.exec<{ target: string }>("SELECT target FROM peeled WHERE oid = ?", oid).toArray();
    return rows[0]?.target ?? null;
  }

  setPeeled(oid: string, target: string): void {
    this.assertOpen();
    this.sql.exec("INSERT OR IGNORE INTO peeled (oid, target) VALUES (?, ?)", oid, target);
  }

  /**
   * Cached commit-activity aggregation for a (tip commit oid, period) pair.
   * Keyed on the tip's oid rather than a ref name: history under a fixed
   * commit oid is immutable, so no version check is needed for a hit.
   */
  getStatsCache(tipOid: string, period: string): string | null {
    this.assertOpen();
    const rows = this.sql
      .exec<{ data: string }>("SELECT data FROM stats_cache WHERE tip_oid = ? AND period = ?", tipOid, period)
      .toArray();
    return rows[0]?.data ?? null;
  }

  setStatsCache(tipOid: string, period: string, data: string): void {
    this.assertOpen();
    this.sql.exec(
      "INSERT OR REPLACE INTO stats_cache (tip_oid, period, data) VALUES (?, ?, ?)",
      tipOid,
      period,
      data
    );
  }

  /**
   * A tag over the current ref state (names + tips + HEAD). The cached
   * reachable object set is keyed on it: any push, ref delete, or gc changes
   * a tip and so bumps the version, which is exactly when the set can change.
   * A sha1 hex string never collides with the "" invalidation sentinel. This
   * hash is also the clone-cache key's refsVersionHash (r2keys.ts).
   */
  reachableVersion(): string {
    const parts: string[] = [];
    for (const r of this.refs()) parts.push(`${r.name}\0${r.oid}`);
    parts.push(`HEAD\0${this.head()}`);
    return sha1hex(te.encode(parts.join("\n")));
  }

  /**
   * The cached reachable object set as an OidSet with every entry marked (so
   * markedSize/markedAtHex/isMarkedHex feed the pack-emission path directly),
   * or null when the cache is missing or its version no longer matches current
   * refs. The version check is the only correctness gate — a stale set is
   * never returned, so the fast path can never serve unreachable objects.
   */
  loadReachable(): OidSet | null {
    if (this.getMeta("reachable-version") !== this.reachableVersion()) return null;
    const rows = this.sql.exec<{ oid: string }>("SELECT oid FROM reachable").toArray();
    if (!rows.length) return null;
    const set = new OidSet(rows.length);
    for (const r of rows) set.markHex(r.oid);
    return set;
  }

  /**
   * Persist the marked sub-set of `set` (a full clone's reachable object set)
   * and stamp it with the current ref version. Yields periodically so a large
   * write never monopolizes the event loop; if refs change mid-write (a push
   * landing during a cold clone) the version guard abandons the stamp, leaving
   * the half-written table unversioned and thus ignored until it is rebuilt.
   */
  async saveReachable(set: OidSet): Promise<void> {
    const version = this.reachableVersion();
    this.sql.exec("DELETE FROM reachable");
    const n = set.markedSize;
    for (let i = 0; i < n; i++) {
      this.sql.exec("INSERT OR IGNORE INTO reachable (oid) VALUES (?)", set.markedAtHex(i));
      if ((i & 8191) === 8191) {
        if (this.reachableVersion() !== version) return;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (this.reachableVersion() !== version) return;
    this.setMeta("reachable-version", version);
  }

  /**
   * Fold every oid in `set` into the cached reachable set and re-stamp it with
   * the current ref version. Used on a fast-forward push, where the receive
   * connectivity walk already visited exactly the newly connected objects:
   * union with the prior (validated) set yields the new reachable set without
   * a fresh graph walk. Only sound when no object became unreachable — the
   * caller must have a valid prior cache and no stranded history.
   */
  extendReachable(set: OidSet): void {
    for (let i = 0; i < set.size; i++) {
      this.sql.exec("INSERT OR IGNORE INTO reachable (oid) VALUES (?)", set.atHex(i));
    }
    this.setMeta("reachable-version", this.reachableVersion());
  }

  /** Drop the version stamp so the next full clone rebuilds the set by walking. */
  invalidateReachable(): void {
    this.setMeta("reachable-version", "");
  }

  /**
   * True when the persisted reachable set still matches the current refs, so a
   * full clone can stream its objects straight from storage (see
   * `reachablePackedAfter`) instead of loading the whole set into an OidSet and
   * walking. The version check is the same correctness gate `loadReachable`
   * uses — a stale set is never streamed.
   */
  reachableCacheValid(): boolean {
    return this.getMeta("reachable-version") === this.reachableVersion();
  }

  /** Size of the cached reachable set — the exact object count a warm full
   *  clone declares in its pack header. */
  reachableCount(): number {
    this.assertOpen();
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM reachable").one().n;
  }

  /** Whether `oid` is in the cached reachable set. On the warm full-clone path a
   *  stored delta ships as a ref-delta only when its base is also being sent,
   *  i.e. also reachable; otherwise that object is inflated whole. */
  reachableHas(oid: string): boolean {
    this.assertOpen();
    return this.sql.exec("SELECT 1 FROM reachable WHERE oid = ? LIMIT 1", oid).toArray().length > 0;
  }

  /**
   * Reachable objects that live in a pack, one keyset page at a time in
   * (pack_key, offset) order — the SPEC-0001 §4 keyset ordering. Marching each
   * pack sequentially keeps the raw-chunk cache hitting, and the (pack_key,
   * offset) cursor holds no per-object state in the isolate — so a warm full
   * clone streams in O(page) memory no matter how many objects the repo has,
   * replacing the OidSet and parallel typed arrays the walk path builds.
   */
  reachablePackedAfter(afterPack: string, afterOffset: number, limit: number): PackedReachable[] {
    this.assertOpen();
    return this.sql
      .exec<{
        oid: string;
        pack_key: string;
        offset: number;
        data_off: number;
        data_len: number;
        type: ObjType;
        entry_size: number;
        base_oid: string | null;
      }>(
        `SELECT p.oid, p.pack_key, p.offset, p.data_off, p.data_len, p.type, p.entry_size, p.base_oid
           FROM reachable r JOIN pack_objects p ON p.oid = r.oid
          WHERE p.pack_key > ? OR (p.pack_key = ? AND p.offset > ?)
          ORDER BY p.pack_key, p.offset
          LIMIT ?`,
        afterPack,
        afterPack,
        afterOffset,
        limit,
      )
      .toArray()
      .map((r) => ({
        oid: r.oid,
        packKey: r.pack_key,
        offset: r.offset,
        dataOff: r.data_off,
        dataLen: r.data_len,
        type: r.type,
        entrySize: r.entry_size,
        baseOid: r.base_oid,
      }));
  }

  /** Reachable objects with no pack entry (loose), ordered by oid — streamed
   *  after every packed object so a warm full clone has a stable total order. */
  reachableLooseAfter(afterOid: string, limit: number): string[] {
    this.assertOpen();
    return this.sql
      .exec<{ oid: string }>(
        `SELECT r.oid FROM reachable r
          WHERE NOT EXISTS (SELECT 1 FROM pack_objects p WHERE p.oid = r.oid) AND r.oid > ?
          ORDER BY r.oid LIMIT ?`,
        afterOid,
        limit,
      )
      .toArray()
      .map((r) => r.oid);
  }
}

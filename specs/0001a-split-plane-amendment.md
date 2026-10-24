# SPEC-0001a: Split-Plane Amendment (receive data plane → Worker)

Status: draft · Date: 2026-10-24 · Amends: SPEC-0001 (milestone M2 scope)
Governs: `packages/git-engine/` (vendored durable-git @ `d5eba04`, see NOTICE.md).
All `file:line` references below point at the vendored state of the engine sources.

This amendment is the design-of-record for M2 ("move receive data plane into the
Worker"). It contains: the current DO method inventory (§1), a gap analysis against
SPEC-0001 §2 hard rules (§2), the refactor sequence with test checkpoints (§3), the
API-side commit builder required by SPEC-0004 §3.4 (§4), what stays untouched (§5),
effort/risk per step (§6), NOTICE discipline (§7), and the corrections SPEC-0001
itself needs (§8).

## 1. DO method inventory

### 1.1 RepoCell (per-repository cell, `src/repo.ts`)

| Surface | Purpose | Plane | Current callers |
|---|---|---|---|
| `fetch()` → `POST /git-receive-pack` (`repo.ts:235`, `receive`/`processReceive` `repo.ts:653-836`) | Full push pipeline: pkt-line command parse, pack ingest (stream store + scan + delta resolve + SHA-1), connectivity check, ref CAS commit, report-status | **Data** (pack bytes through the DO; heavy CPU: inflate/delta/hash; R2 writes from the DO) | `mod.ts:591` — the Worker forwards the raw push body via `stub.fetch()` |
| `fetch()` → `POST /git-upload-pack` (`repo.ts:204`, `protocol.ts uploadPack`) | Fetch negotiation + pack generation and streaming (walk, raw-entry copy, sideband mux) | **Data** (pack bytes; heavy CPU) | `mod.ts:591` (after the Worker's R2 full-clone fast-path misses) |
| `fetch()` → `GET /info/refs` (`repo.ts:191`, `protocol.ts advertisement`) | Smart-HTTP ref advertisement | Control (refs read; tiny output) | `mod.ts:591` |
| `fetch()` → `PUT /config`, `PUT /description` (`repo.ts:239-244`) | Repo metadata (meta table) | Control | `mod.ts:591`; Worker then syncs Registry (`mod.ts:617-640`) |
| `fetch()` → `DELETE /` (`repo.ts:245-264`) | Wipe SQLite + R2 purge | Control (+R2 deletes) | `mod.ts:591`; Worker then `registry.remove` (`mod.ts:641-643`) |
| `fetch()` → `POST /gc` (`repo.ts:265-267`, `runGc` `repo.ts:351-421`) | Reachability walk, pack→loose migration, orphan delete | Data-ish (heavy CPU walk; R2 deletes) — replaced by queue compaction in M3 | `mod.ts:591` (admin op) |
| `fetch()` → `GET /…` UI pages + `/api/*` JSON (`repo.ts:860-887`, `api()` `repo.ts:544-579`) | cgit-style pages, content API (log/tree/diff/blob/blame/snapshot) | Data today (graph walks + inflate in the DO); SPEC-0001 does not move these in M2 — they become Worker-side catalog+R2 reads in a later milestone | `mod.ts:591` |
| `alarm()` (`repo.ts:277-300`) | Deferred GC trigger | Maintenance/control | Runtime (alarm) |
| `currentPackKey(repo, wants)` (`repo.ts:430-433`) | Full-clone probe: returns versioned R2 key iff wants == current tips | Control | `mod.ts:327` (`serveCloneFromR2`, Workers RPC) |
| `listRefs()` (`repo.ts:451`) | Refs + HEAD + peeled tags | Control | HTTP `/api/refs` (`repo.ts:549`); available as Workers RPC to same-account Workers (`repo.ts:436-439`) |
| `readCommit(id?)` (`repo.ts:466`) | One commit JSON | Data (inflate+parse) | HTTP `/api/commit`; Workers RPC |
| `listLog(ref?, opts)` (`repo.ts:474`) | Commit walk with filters | Data | HTTP `/api/log`; Workers RPC |
| `listTree(ref?, path)` (`repo.ts:485`) | Tree listing with sizes | Data | HTTP `/api/tree`; Workers RPC |
| `readDiff(id?, id2?)` (`repo.ts:505`) | Tree-scope diff | Data | HTTP `/api/diff`; Workers RPC |
| `readBlob(ref, path)` (`repo.ts:530`) | Blob bytes | Data | HTTP `/api/blob`; Workers RPC |

Internal but architecturally relevant: `receiveChain` promise serialization
(`repo.ts:163`, `repo.ts:662-668`) — today's push concurrency control; replaced by DO
leases in Step 1. `packCacheFor()` (`repo.ts:588-616`) and `purgePackCache()`
(`repo.ts:620-635`) are the DO's R2 write/purge adapters.

### 1.2 Registry (site-wide singleton, `src/registry.ts`)

| Method | Purpose | Plane | Current callers |
|---|---|---|---|
| `upsert(name, idle)` (`registry.ts:48`) | Create/touch repo row, bump cache version | Control | `mod.ts:604` (after push), `mod.ts:626` (after config on create) |
| `setConfig(name, cfg, idle?)` (`registry.ts:59`) | Metadata update, bump version | Control | `mod.ts:627` |
| `remove(name)` (`registry.ts:73`) | Delete row | Control | `mod.ts:642` |
| `get(name)` → `RepoInfo \| null` (`registry.ts:77`) | Existence + privacy + cache version probe | Control | `mod.ts:278` (`repoInfo`, per request) |
| `list(limit?, ns?)` (`registry.ts:87`) | Index feed (excludes private) | Control | `mod.ts:237` (index page), `mod.ts:446` (`/api/repos`) |

Registry is **not** touched by M2 (see §5). SPEC-0001 leaves repo-registry concerns to
SPEC-0002/0003 (D1 `repositories` table becomes the source of truth there; Registry DO
stays until that migration).

## 2. Gap analysis vs SPEC-0001 §2 hard rules

### Rule 1 — "push indexing runs in the Worker, never in the DO" / "pack bytes never pass through the DO"

**Where:** the entire receive path lives in the DO. The Worker forwards the push body
verbatim to the cell (`mod.ts:583-591`); `RepoCell.receive` → `processReceive`
(`repo.ts:653-836`) parses pkt-lines, and `PackStore.ingest` (`packstore.ts:479-887`)
streams the body into R2 (`beginRawMultipart` at `packstore.ts:547`) or SQLite
`pack_data`, then scans (phase B), resolves deltas (phase B eager + phase C straggler
pass), hashes every object, and writes `pack_objects` rows — all inside the DO.

**What breaks:** the DO pays the full CPU bill (inflate, delta, SHA-1) on its
single-threaded event loop, so every concurrent `info/refs`/clone on that repo stalls
(T4's "data plane never enters the DO" is unmet); the same 5-minute CPU ceiling and
128 MiB isolate the receive quota exists to respect (T1, T2) now bind the DO, whose
eviction mid-ingest also risks the atomicity the design relies on; subrequest budget
is spent inside the DO where the Queue/Worker split planned for T3 cannot be
instrumented as designed.

**Fix:** Steps 1–2 of §3. Worker parses the command section, streams pack bytes
straight into R2 staging, then runs the two-pass scan and idx emission reading the
staging object from R2 directly. The DO shrinks to `beginReceive`/`finalizeReceive`
plus index-row batches (control-plane data only).

### Rule 2 — "DO RPC returns tagged unions (`committed | ref_conflict | lease_mismatch`), never throws across the boundary"

**Where:** the receive contract is an HTTP response decorated with headers:
`x-changed`, `x-commit-time`, `x-ref-updates` (`repo.ts:679-703`) parsed back by the
Worker (`mod.ts:361-370`, `mod.ts:600-616`). The `x-ref-updates` channel is lossy by
design (8 KiB cap, truncation loop `repo.ts:694-701`). Errors cross the boundary as
`500 error: <free text>` (`repo.ts:271-274`). The typed content methods
(`listRefs`…`readBlob`) return `null`-or-throw: any store/R2 fault escapes as a raw
exception over RPC. There is no lease concept, so no `lease_mismatch` can even be
expressed.

**What breaks:** the Worker cannot distinguish "push applied" from "cell hiccup"
without string-matching headers; a thrown error after the pack landed leaves no way to
report per-command status; the truncated header silently drops ref updates from the
`onPush` hook (acceptable for hooks, not as the only success channel); no typed variant
exists for the SPEC-mandated outcomes.

**Fix:** Step 1 replaces the header channel with `beginReceive`/`finalizeReceive`/
`releaseReceive` RPCs whose results are tagged unions (exact signatures in §3 Step 1).
Note the rule needs one clarification, recorded in §8: *application* errors must be
returned as tagged union variants; transport failures (network, DO eviction) still
surface as RPC exceptions to the caller, which must treat them as retryable-unknown —
that is precisely why finalize is idempotent-on-`lease_mismatch` and the lease expiry
sweep exists.

### Rule 3 — "no `blockConcurrencyWhile` in RPC"

**Where:** `RepoCell.fetch` `DELETE /` wraps wipe + re-init in
`ctx.blockConcurrencyWhile` (`repo.ts:248-258`); `gc()` chains onto `receiveChain` and
then wraps `runGc` in `blockConcurrencyWhile` (`repo.ts:307-319`), reachable via
`POST /gc` and `alarm()`.

**What breaks:** `blockConcurrencyWhile` blocks the whole DO, including in-flight
`uploadPack` ReadableStream pulls — a long GC freezes every active clone stream and
can hold the admission-control slots (`activeUploads`) open; combined with
`receiveChain` ordering it is a self-deadlock hazard if any awaited callback inside
touches the chain.

**Fix:** the `DELETE /` wipe is rewritten as one `storage.transactionSync` (schema
alignment in Step 4 forces the rewrite anyway; drop + recreate inside one transaction
is atomic for callers). `POST /gc`/`alarm` stay until M3 **by explicit scope decision**
— they are not part of the receive path — and are deleted wholesale when compaction
moves to Queue consumers (SPEC-0001 §5/M3). This amendment marks Rule 3 as *closed for
the receive path* at Step 1 (receiveChain is replaced by leases) and *scheduled for M3*
for GC.

### Rule 4 — "no Worker→DO→R2 transitive streaming"

**Where (four distinct flows):**
1. **Receive write:** pack bytes arrive at the Worker and are forwarded to the DO,
   which writes them to R2 (`packstore.ts:544-644`) — the canonical violation.
2. **Receive read-back:** the DO reads the just-stored pack from R2 in ~1 MiB range
   GETs while indexing/serving (`PackStore.chunk`, `packstore.ts:383-415`) and again
   during `validatePush` connectivity reads (`protocol.ts:1225-1288` via
   `store.get` → `getObject`).
3. **Clone-miss write:** on a full-clone cache MISS the DO *generates* the pack and
   tees it into R2 multipart while streaming to the client (`protocol.ts:798-802`,
   `warmFullClone` `protocol.ts:979-1051`, `MultipartCapture`) — pack bytes through
   the DO on the serve side.
4. **Serve read-back:** every DO-served clone/fetch reads raw entries from R2
   (`readRaw` → `chunk`).

**What breaks:** doubles latency on every byte (client→DO→R2), spends the DO's
subrequest and egress budget, defeats T3's model ("DO calls = lease + finalize only"),
and makes T4's DO-request-counter check impossible while flows 2–4 run per request.
Flow 3 additionally serializes the DO event loop for the length of a clone.

**Fix:** flows 1–2 are Steps 1–2 (Worker↔R2 directly; DO sees rows, not bytes). Flow 4
is the *existing* M4 plan (Worker-side upload-pack serving; the compliant HIT path
already exists at `mod.ts:307-342` + `protocol.ts streamingCloneResponse`). Flow 3
belongs to the clone-cache write side and is deferred with the clone cache per
SPEC-0001 §10 — M2 does not touch the serve path (§5), so flow 3 survives M2 by scope
and is closed at M4.

## 3. Refactor sequence

Each step lands independently, keeps `pnpm test` + engine e2e green, and is followed
by `pnpm typecheck` (regenerates `dist-types/`, the worker-facing boundary; eslint
ignores `packages/**`). No production data exists pre-M1, so Steps 3–4 are clean
cutovers (dev repos may be wiped; the engine e2e recreates fixtures) — no dual-layout
code is carried.

### Step 1 — receive-in-Worker with lease RPC (bytes leave the DO)

The Worker's git-HTTP adapter parses **only** the pkt-line command section (strict
`PktParser` rules, SPEC-0001 §7), calls `beginReceive`, streams the pack remainder
straight into R2 staging (16 MiB multipart, `FixedLengthStream` when Content-Length is
known — the existing `MultipartCapture` mechanics move to the Worker unchanged), then
calls `finalizeReceive`. The DO's ingest keeps its current logic in this step but
reads its input from the R2 staging object instead of the request stream (ingest's
`feed()` loop consumes an R2 body reader; phase A storage switches to
"staging object is the store" — `packstore.ts` keeps `pack_data` only for the
no-R2/celld fallback, which is dead code on Workers). `receiveChain` serialization and
the `x-changed`/`x-commit-time`/`x-ref-updates` header channel are deleted; report-status
rendering stays byte-identical.

New engine module `src/control-plane.ts` carries the RPC contract (these are public
methods on `RepoCell`, exposed as Workers RPC; record the new file in NOTICE.md per §7).

```ts
import type { PushCommand } from "./git/protocol"; // { old: string; next: string; ref: string }
import type { RefUpdate } from "./mod";            // { ref: string; old: string; new: string }

/** Per-command outcome, one per input command, in order. */
export interface ReceiveCommandResult {
  ref: string;
  ok: boolean;
  /** ng message on failure: "fetch first", "funny refname", "missing necessary objects" */
  message?: string;
}

/** Open a receive lease. Commands/caps are parsed by the Worker (SPEC-0001 §5). */
export interface BeginReceiveInput {
  commands: PushCommand[];
  capabilities: string[];
  /** remaining byte count (Content-Length minus command section), null when chunked */
  packBytesHint: number | null;
}

export type BeginReceiveOk = {
  tag: "ok";
  leaseToken: string;
  /** repos/<storage_key>/staging/pack-rx-<leaseToken>.pack (SPEC-0001 §3) */
  stagingKey: string;
  /** immutable storage key (r_<id>); the Worker needs it to build R2 keys */
  storageKey: string;
  /** pre-push refs_version, echoed back to finalize for the CAS guard */
  refsVersion: string;
  /** current ref tips, for thin-pack base resolution in the Worker (Step 2) */
  refTips: { name: string; oid: string }[];
  /** unix millis; the Worker must finalize before this or the sweep reclaims */
  leaseExpiresAt: number;
};
export type BeginReceiveBusy = {
  tag: "busy";
  /** value for the 503 Retry-After header (T7: 10) */
  retryAfterSeconds: number;
};
export type BeginReceiveRejected = {
  tag: "rejected";
  /** per-command refname-validation failures (checked BEFORE any byte streams) */
  results: ReceiveCommandResult[];
};
export type BeginReceiveResult = BeginReceiveOk | BeginReceiveBusy | BeginReceiveRejected;

export interface FinalizedPack {
  /** final pack key: repos/<storage_key>/packs/<packName>.pack — the Worker has
   * already copied staging → packs/ BEFORE calling finalize (see ordering note) */
  packKey: string;
  /** the pack's own SHA-1 trailer (computed during the Worker's stream) */
  packSha1: string;
  packBytes: number;
  objectCount: number;
  idxBytes: number;
}

export interface FinalizeReceiveInput {
  leaseToken: string;
  /** refsVersion from beginReceive; mismatch ⇒ ref_conflict (a push landed in between) */
  expectedRefsVersion: string;
  commands: PushCommand[];
  newTips: (string | null)[]; // null = delete command; index-aligned with commands
  pack: FinalizedPack;
  /** unpacker/scan failure text, null on success — forces every command to fail */
  unpackError: string | null;
}

export type FinalizeCommitted = {
  tag: "committed";
  results: ReceiveCommandResult[];
  /** post-commit refs_version (edge cache key, T4) */
  refsVersion: string;
  /** newest committer date, for the Worker's registry upsert */
  commitTime: number;
  /** applied updates for the onPush hook — no truncation, unlike x-ref-updates */
  updates: RefUpdate[];
};
export type FinalizeRefConflict = {
  tag: "ref_conflict";
  /** per-command CAS outcomes ("fetch first" per stale command) */
  results: ReceiveCommandResult[];
};
export type FinalizeLeaseMismatch = { tag: "lease_mismatch" };
export type FinalizeReceiveResult =
  | FinalizeCommitted
  | FinalizeRefConflict
  | FinalizeLeaseMismatch;

/** Abandon a lease (scan failure, client gone, size cap hit). Sweeps staging. */
export interface ReleaseReceiveInput {
  leaseToken: string;
  /** true also removes the staging object's catalog trace (T1 failure path) */
  sweep: boolean;
}
export type ReleaseReceiveResult = { tag: "released" } | { tag: "lease_mismatch" };
```

Method signatures on `RepoCell`:

```ts
async beginReceive(input: BeginReceiveInput): Promise<BeginReceiveResult>;
async finalizeReceive(input: FinalizeReceiveInput): Promise<FinalizeReceiveResult>;
async releaseReceive(input: ReleaseReceiveInput): Promise<ReleaseReceiveResult>;
```

Semantics locked here: `finalizeReceive` runs per-command CAS re-check + multi-ref
commit + `pack_catalog` row + `refs_version` bump in **one** `storage.transactionSync`,
and additionally verifies every non-null `newTips[i]` is present in the object index —
the DO-side guard for "no ref may point into unindexed storage" (the Worker-side
connectivity walk arrives in Step 2; until then the DO's existing
`packComplete` check still runs against its index). **Copy-before-finalize ordering:**
the Worker moves staging → `packs/` (R2 copy) *before* `finalizeReceive`, so a crash
between the copy and finalize leaves an unreferenced `packs/` object the orphan sweep
reclaims, while the reverse order would let a committed ref point at a missing object.

**Test checkpoint (gate to merge):** T7 (two concurrent pushes: exactly one
`503 Retry-After: 10`, stock git retries and succeeds); stale `oldOid` → `fetch first`
via `ref_conflict`; atomic multi-ref (half-moved branches impossible); crash-between-
stages sweep (kill after staging, after copy, after finalize — no dangling refs, next
lease reclaims); `git fsck` clean after push (serve path untouched); report-status
byte-shape unchanged on the wire (golden fixture); T3 partial instrumentation (DO calls
per push counted and asserted ≤ begin + index-write + finalize).

### Step 2 — pack scan / delta resolution stream from R2 in the Worker

The two-pass pipeline of `PackStore.ingest` phases B/C moves to Worker modules
(`src/receive/scan.ts`, `src/receive/delta.ts`, `src/receive/idx.ts`): pass 1 = one
streaming GET of the staging object (per-entry CRC-32, pako `Inflate` raw, inflate
output bounds), pass 2 = REF_DELTA/ofs-delta base resolution to a fixpoint with chain
caps and cycle detection, then idx v2 emission byte-equivalent to `git index-pack`.
The Worker writes `packs/<packName>.pack` + `.idx` and pushes index rows to the DO in
bounded control-plane batches:

```ts
export interface IndexRow {
  oid: string;
  offset: number;
  dataOff: number;   // kept: verbatim entry re-emission needs it (see §8 correction)
  dataLen: number;
  type: ObjType;
  size: number;
  entrySize: number;
  baseOid: string | null;
  crc32: number;     // idx v2 field
}
async putIndexRows(leaseToken: string, rows: IndexRow[]): Promise<
  { tag: "ok" } | { tag: "lease_mismatch" }>;
async lookupObjects(leaseToken: string, oids: string[]): Promise<(
  { found: true; packKey: string; offset: number; dataOff: number; dataLen: number;
    type: ObjType; baseOid: string | null }
  | { found: false }
)[]>; // thin-pack/cross-pack base resolution; Worker then R2-reads entry bytes itself
```

`pack_pending` and `push_edges` tables and the DO-side eager/straggler delta machinery
are deleted (the Worker resolves everything before `finalizeReceive`; connectivity
membership becomes batched `lookupObjects` anti-checks instead of `push_edges` SQL).
`ObjCache`/`OidSet` and the SHA-1 streaming utilities move with the scan (pure
functions, no DO state). The DO keeps: leases, catalog, refs, `refs_version`,
finalize transaction, alarm-based lease-expiry sweep.

**Test checkpoint:** T1 (1.1 GiB synthetic pack → clean protocol-level rejection, zero
ref changes, staging swept); T2 (42 MiB real fixture + 500 MiB synthetic complete with
recorded peak memory; decompression-bomb fixture rejected); T3 (instrumented 1 GiB
push < 200 subrequests; DO calls = begin + N bounded index batches + finalize);
idx v2 byte-equivalence vs `git index-pack` on fixtures; thin push resolves and `git
fsck` passes; `format-patch` roundtrip (correctness gate list, SPEC-0001 §6).

### Step 3 — R2 key layout switch to SPEC-0001 §3

Introduce one key-builder module (`src/git/r2keys.ts`) and route **every** construction
site through it. Complete enumeration of current sites (vendored line numbers):

| # | Site | Current key | Target key |
|---|---|---|---|
| 1 | `packstore.ts:197-199` `rawKey(packId)` | `raw/<repo>/<packId>` | `repos/<storage_key>/packs/<packName>.pack` |
| 2 | `packstore.ts:285-294` `deleteR2Packs` (via `rawKey`) | `raw/…` | packs keys (via builder) |
| 3 | `packstore.ts:392-399` `chunk()` R2 range GET (via `rawKey`) | `raw/…` | packs `.pack` key |
| 4 | `packstore.ts:519-525` ingest orphan-sweep delete (via `rawKey`) | `raw/…` | packs/staging keys (via builder) |
| 5 | `packstore.ts:547` `beginRawMultipart(bucket, rawKey(packId))` | `raw/…` | `repos/<storage_key>/staging/pack-rx-<leaseToken>.pack` during receive; final packs key at copy |
| 6 | `repo.ts:430-433` `currentPackKey` | `pack/<repo>/<reachableVersion>` | `repos/<storage_key>/clone-cache/<refsVersionHash>.pack` |
| 7 | `protocol.ts:643-644` `r2Key` (duplicate of #6) | `pack/<repo>/<reachableVersion>` | clone-cache key (via builder; single definition) |
| 8 | `repo.ts:620-635` `purgePackCache` list prefixes | `pack/<repo>/`, `raw/<repo>/` | `repos/<storage_key>/` (one prefix) |
| 9 | `repo.ts:588-616` `packCacheFor.beginMultipart(key, objects)` | passthrough of #7 | passthrough; must keep `customMetadata.objects` (`mod.ts:339` reads it) |
| 10 | `mod.ts:313-341` `serveCloneFromR2` `bucket.get(key)` | key from RPC #6 | unchanged mechanics; key now clone-cache layout |
| 11 | `env.ts:8` `PACK_CACHE` binding vs `apps/worker/wrangler.jsonc` `REPO_PACKS` | name mismatch (engine would silently run bucketless once the worker mounts it) | rename engine Env field to `REPO_PACKS` (wrangler.jsonc is the single source of truth) |

`<packName>` = `pack-<packSha1>` (the pack's own trailer hash, already computed in
Step 1/2 — deterministic, dedupes identical repacks); `next_pack_seq` (SPEC-0001 §4) allocates
`pack_catalog` sequence, not the R2 name. `<storage_key>` reaches the engine as
`storageKey` from `beginReceive` and is persisted in `meta` (the existing
`meta.repo` pattern at `repo.ts:177-180` becomes `meta.storage_key`) so alarm/sweep
paths can rebuild keys without a request.

**Test checkpoint:** T6 (32 MiB pack → R2 object present at
`repos/<storage_key>/packs/…`, DO storage growth < idx size); delete-repo e2e purges
exactly the repo's subtree; lease-expiry sweep reclaims staging under the new layout;
full-clone fast path still hits (`x-pack-cache: hit` observed) after the key change;
full correctness suite re-run.

### Step 4 — RepoDO schema alignment to SPEC-0001 §4

Decision per table (keep dgit name / rename — with justification):

| dgit table | SPEC-0001 §4 | Decision | Why |
|---|---|---|---|
| `refs(name, target)` | `refs(name PK, oid, peeled, updated_at)` | **Keep name** `refs`; rename `target`→`oid`, add `peeled`, `updated_at`; move HEAD out of the table into `meta.head` (HEAD is a symref row today, `store.ts:271-284`) | spec names it; `peeled` on the refs row kills per-request tag peels in `advertisement`/`lsRefs`; `updated_at` feeds lease/sweep diagnostics |
| `meta(key, value)` | `meta(key, value)`: `head`, `refs_version`, `next_pack_seq`, `compaction_wanted_at` | **Keep name**; add the four spec keys; retain legacy keys (`description`, `owner`, `section`, `private`, `has-loose`, `reachable-version`, …) until the UI/content split (later milestone) | shape already matches; keys are additive |
| `pack_meta(pack_id, size, count, created, store)` | `pack_catalog(pack_key PK, kind, state, object_count, pack_bytes, idx_bytes, created_at, superseded_by)` | **RENAME** to `pack_catalog`; integer `pack_id` → string `pack_key` (= R2 pack name) everywhere (index rows, chunk LRU keys, `readRaw` args) | the shape diverges materially (lifecycle `kind/state/superseded_by` for M3 compaction); keeping the old name would lie; integer ids leak engine internals into keys |
| `pack_objects(oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid)` | object index rows, "dgit `pack_objects` shape": oid → (pack_key, offset, type, size, base_oid), `(pack_key, offset)` keyset | **Keep name** `pack_objects`; `pack_id`→`pack_key`; **keep `data_off`/`data_len`/`entry_size`/`crc32`** (§8 correction — the spec's column list cannot re-emit a pack without a rescan); keep the `(pack_key, offset)` index (exists as `idx_pack_objects_loc`) | spec explicitly adopts this shape; verbatim entry copy is the serve path's core trick |
| `pack_pending` | — | **DROP** (at Step 2) | Worker resolves all deltas pre-finalize |
| `push_edges` | — | **DROP** (at Step 2) | connectivity membership moves to batched `lookupObjects` |
| `pack_data` | — (§3: "Packs ≥16 MiB exist only in R2") | **Keep** as the small-pack (<16 MiB) local store; `pack_catalog.location 'r2'\|'sqlite'` added (§8 correction) | the 16 MiB threshold implies small packs may stay local; latency win for tiny repos is real |
| `leases` | `leases(lease_token PK, kind, expires_at, payload)` | **NEW** (created in Step 1) | receive leases (T7); `kind='receive'` now, compaction leases M3 |
| `objects`/`chunks` (loose) | — | **Keep** | GC migration target + thin-pack bases; swept in M3 |
| `reachable`, `peeled`, `stats_cache` | — | **Keep** (`reachable` = M4 clone fast path; `peeled` stays as the arbitrary-oid peel cache; refs-row `peeled` covers tag tips) | none of them contradict SPEC-0001 §4; removal is M4/M3 business |

`DELETE /` wipe is rewritten here as a single `transactionSync` (closes the remaining
`blockConcurrencyWhile` use on that path, Rule 3). Lease-expiry sweep lands on the
alarm (`alarm()` gains the lease check ahead of the M3 compaction re-arm).

**Test checkpoint:** full engine e2e + worker `pnpm test` green from an empty DO;
`refs_version` present and bumped by `finalizeReceive` (assert via a debug RPC or
`/api/refs` payload version) — groundwork for T4's M4 cache test; T6 re-run (SQLite
holds rows only); lease-expiry alarm sweep test (expired lease + staging object both
gone); every SPEC-0001 §6 correctness gate re-run after the schema cutover.

## 4. API-side commit builder (SPEC-0004 §3.4 write endpoints)

SPEC-0004's tier-1 write endpoints (`POST/PUT/DELETE
/repos/{owner}/{repo}/contents/{path}`, batch `POST /contents`, `POST /diffpatch`,
`POST /branches`, `POST /tags`, release-implied tag creation) must construct commits
**without a git push**. SPEC-0001 has no such entry point today — the only writer of
objects/refs is receive-pack. This section adds one, on the same split-plane terms:
object construction (data plane) in the Worker, ref CAS (control plane) in the DO,
reusing the Step 1 lease/CAS/`refs_version` machinery.

### 4.1 Reuse audit of upstream durable-git

What upstream already has (reusable as-is):

- `GitStore.put(oid, type, data)` (`store.ts:136-150`) — the loose-object storage
  primitive (deflate + 1 MiB chunked SQLite rows + `has-loose` flag). Today its only
  caller is the GC migration path (`repo.ts:401`); it is exactly the write side the
  builder needs.
- `hashObject(type, data)` / `objectHeader` (`objects.ts:20-22`, `objects.ts:16-18`) —
  one-shot oid computation; the Worker uses the `crypto.subtle` variant of
  `hashObjectAsync` (`packstore.ts:124-131`) for speed, the DO's re-verification may
  use either (identical oid).
- Parsers `parseCommit` / `parseTree` / `parseTag` (`objects.ts`) — needed to read the
  base tree/commit during contents edits.
- `deflate` (`zlib.ts:5`) — used inside `GitStore.put`.

What upstream lacks (net-new, Worker-side): tree/commit/tag **serializers** and
path-apply (cascading tree rewrite) logic. No upstream path builds git objects — the
UI is read-only and `snapshot.ts` builds tar/zip archives, not git objects. New code
is small: a `src/commit/serialize.ts` module (~250 LOC: entries→sorted tree bytes,
commit/tag serialization, path upsert/delete with bottom-up tree cascade).

### 4.2 Shape decision: Worker builder + two DO control-plane RPCs

Considered and rejected: synthesizing a mini-pack and routing it through the receive
pipeline. That would take the receive lease (blocking concurrent pushes — an explicit
non-goal), drag scan/idx/catalog machinery over a handful of objects, and pollute
`pack_catalog` with trivial packs. Instead:

- **Worker (data plane, bounded payloads):** authorize via SPEC-0002/0004, read the
  base tree (M2: via the existing `listTree`/`readBlob` content RPCs — small outputs;
  M4: direct R2 reads once the content surface moves), serialize the new
  blob/tree/commit/tag objects, compute oids, write them via `putApiObjects`, then
  move the ref via `commitApiChange`.
- **DO (control plane):** verify + store the objects into the existing loose
  `objects`/`chunks` tables (`GitStore.put`), and run refname validation + presence
  check + CAS + `refs_version` bump + HEAD fixup in one `storage.transactionSync`.

The lighter connectivity gate (tip + root-tree presence, not the full closure walk
receive runs) is deliberate: the caller is a same-account Worker over a service
binding — trusted infrastructure (`repo.ts:436-439`), unlike a client-supplied pack —
and `putApiObjects` cryptographically verifies every object it stores.

### 4.3 RPC surface (exact TypeScript signatures)

Lives in `src/control-plane.ts` alongside the receive RPCs (§3 Step 1).

```ts
import type { ObjType } from "./git/objects";

/** One canonical git object built in the Worker. `data` is the canonical git
 * serialization (NOT zlib-deflated — storage deflation is GitStore.put's job). */
export interface ApiObject {
  /** Worker-computed sha1(header + content); the DO re-verifies before storing */
  oid: string;
  type: ObjType;
  data: Uint8Array;
}

/** Per-call budget. Total bytes across one call, default 8 MiB
 * (config: API_COMMIT_MAX_BYTES); a single blob is additionally capped by
 * SPEC-0004's max content size — larger files are LFS territory (out of scope). */
export interface PutApiObjectsInput {
  objects: ApiObject[];
}
export type PutApiObjectsResult =
  | { tag: "ok"; stored: number }
  | { tag: "too_large"; limitBytes: number }
  | { tag: "invalid"; reason: string }; // oid/type mismatch or oversized object

export interface CommitApiChangeInput {
  /** full ref name; must pass the same refname validation as receive
   * (protocol.ts BAD_REF rules) */
  ref: string;
  /** CAS base: the ref tip the caller built on; ZERO_OID = create-on-empty
   * (new branch/tag on an empty or unborn repo) */
  expectedOldOid: string;
  /** target oid; must already be stored (by putApiObjects, or pre-existing for
   * POST /branches) */
  newOid: string;
}
export type CommitApiCommitted = {
  tag: "committed";
  ref: string;
  oldOid: string;      // actual pre-commit tip (== expectedOldOid)
  newOid: string;
  /** post-commit refs_version — same edge-cache key a push bumps (T4) */
  refsVersion: string;
  /** newest committer date, for the Worker's registry upsert */
  commitTime: number;
};
export type CommitApiRefConflict = {
  tag: "ref_conflict";
  /** current tip, so the caller can retry atop it (SPEC-0004 maps to 409) */
  currentOid: string;
};
export type CommitApiInvalid = { tag: "invalid"; reason: string };
export type CommitApiChangeResult =
  | CommitApiCommitted
  | CommitApiRefConflict
  | CommitApiInvalid;
```

Method signatures on `RepoCell`:

```ts
async putApiObjects(objects: ApiObject[]): Promise<PutApiObjectsResult>;
async commitApiChange(input: CommitApiChangeInput): Promise<CommitApiChangeResult>;
```

DO-side semantics, locked here:

- `putApiObjects` re-hashes each object (one-shot `crypto.subtle`, optional SHA1DC
  per the existing `SHA1DC` env flag) and stores via `GitStore.put` — idempotent
  (content-addressed; an existing oid is a no-op), so retries and concurrent writers
  are safe. Partial writes from a transport failure are harmless: unreferenced loose
  objects are reclaimed by the sweep (GC today, M3 compaction).
- `commitApiChange` runs in ONE `transactionSync`: refname validation → presence check
  (`store.has(newOid)`; for a commit target also its root tree) → CAS
  (`current === expectedOldOid`, else `ref_conflict` with the live tip) → ref write +
  `updated_at` (+ `peeled` for tag targets) → `refs_version` bump → the same HEAD
  fixup rule as `commitPush` (`protocol.ts:1326-1333`: first branch on an unborn HEAD,
  prefer main/master) → `commitTime` from the new tip.
- Non-fast-forward protection is the CAS itself: the API caller supplies the tip it
  edited against; a moved ref is `ref_conflict`, and merge resolution is Gitea
  web-UI/SPEC-0004 territory, not the engine's.

### 4.4 SPEC-0004 endpoint mapping

| Endpoint (SPEC-0004 §3.4) | Builder flow |
|---|---|
| `PUT/POST/DELETE /contents/{path}` | Worker reads base tree (`listTree`/`readBlob`), applies path create/update/delete, serializes modified trees bottom-up + commit → `putApiObjects` → `commitApiChange(refs/heads/<b>, base tip)` |
| batch `POST /contents` | Same, N paths in one tree cascade, ONE commit |
| `POST /diffpatch` | Worker applies the patch text to the blob, then the contents flow (no `git apply` machinery in the engine) |
| `POST /branches` | No new objects; `commitApiChange(refs/heads/<name>, expectedOld=ZERO_OID or current, newOid=existing commit)` |
| `POST /tags` (annotated) | Worker serializes the tag object → `putApiObjects` → `commitApiChange(refs/tags/<name>, newOid=tag oid)`; lightweight tag = direct CAS to the commit oid |
| release-implied tag | Same as `POST /tags`, invoked by the release service |

### 4.5 Interaction with the receive lease (concurrency matrix)

The builder takes **no** receive lease — an API commit must never block a concurrent
push, and vice versa. Correctness rests on CAS + content addressing:

| Race | Outcome |
|---|---|
| push vs push (same repo) | receive lease serializes (T7 unchanged) |
| push vs API write (same ref) | both CAS at commit; exactly one wins — receive sees `ref_conflict`/"fetch first", API sees `ref_conflict` + `currentOid` |
| API write vs API write (same ref) | CAS decides; loser retries atop `currentOid` |
| any vs any (different refs) | independent; multi-ref atomicity is per-`commitApiChange` call (single ref each) |

Object writes never conflict (content-addressed, idempotent). Every
`commitApiChange` bumps `refs_version`, so edge-cache invalidation behaves exactly as
for a push (T4). There is no staging and no lease cleanup: a conflict loser's objects
are ordinary unreferenced loose objects reclaimed by the sweep.

### 4.6 Memory / CPU notes

- Payloads are bounded by the per-call cap (8 MiB default) and the SPEC-0004 content
  cap; the Worker holds one object at a time for serialization/hashing. No inflate, no
  deltas, no streaming — orders of magnitude cheaper than pack ingest; the 5-minute
  CPU and 128 MiB isolate concerns (T1/T2) do not bind here.
- DO cost per API write: one-shot SHA-1 re-verify per object + `GitStore.put`
  (deflate + chunked rows) + one small transaction. Two DO calls total per API write
  (`putApiObjects` + `commitApiChange`) vs receive's begin + N index batches +
  finalize.
- SQLite growth from API loose objects is bounded by the sweep; **M3 note:** API
  commits are a steady-state source of loose objects beyond the GC-migration path —
  compaction must fold them into packs like any other loose object.
- Base-tree reads ride the existing content RPCs in M2; after M4 they become direct
  Worker R2 reads and the DO is out of the read path entirely.

## 5. What stays untouched in M2

- **upload-pack serve path**: `protocol.ts` `uploadPack`, `warmFullClone`,
  `streamingCloneResponse`, `advertisement`, `lsRefs`, negotiation/shallow logic;
  `mod.ts` `serveCloneFromR2` and the Worker's clone fast path. M2 changes only the
  *key constant* they read (Step 3) — no behavioral change. Flow 3 (clone-cache MISS
  tee) and full Worker-side serving are M4.
- **Registry** (`registry.ts`) and all Worker↔Registry bookkeeping in `mod.ts`.
- **UI/content surface**: `repo.ts` pages and the typed content methods
  (`listRefs`…`readBlob`) — heavy CPU remains in the DO for M2; they migrate to
  Worker-side catalog+R2 reads in a later milestone and are explicitly out of scope
  here (SPEC-0001 §1 scope: receive + serve paths).
- **GC/compaction touchpoints for M3+**: `runGc`, `gc()`, `alarm()`'s gc-pending
  branch, `DO_STORAGE_CAP` headroom logic, `packs.reset()`, `r2PackIds()`/
  `deleteR2Packs` semantics. M2 must not regress them (they keep working over the new
  catalog/keys) but does not redesign them.
- **Protocol/fuzz surfaces**: pkt-line strictness, refname validation rules,
  SHA-1DC screening flag, `Sha1Dc` tables — moved (Step 2) but not redesigned;
  SPEC-0001 §7 fuzzing lands in M5.

## 6. Effort / risk per step

| Step | Files (engine unless noted) | Size | Risk class | Guarding tests |
|---|---|---|---|---|
| 1. Receive-in-Worker + lease RPC | new `src/control-plane.ts`; `repo.ts` (receive rewrite, header-channel deletion); `mod.ts` (body streaming to R2 staging, typed RPC results); `git/store.ts` (leases table, `refs_version`); `git/packstore.ts` (ingest from R2 body; drop `receiveChain` coupling); `git/multipart.ts` (reused as-is) | ~700–1000 LOC changed | **Medium** — wire protocol must stay byte-identical; new crash windows (staging/copy/finalize) need the sweep to be right from day one | T7; stale-`oldOid` gate; atomic multi-ref; crash-sweep gate; fsck-clean after push; report-status golden; T3 partial counter |
| 2. Scan/delta/idx in Worker | new `src/receive/{scan,delta,idx}.ts` (logic moved from `packstore.ts`); `control-plane.ts` (+`putIndexRows`/`lookupObjects`); `packstore.ts` (delete phases B/C, `pack_pending`, `push_edges`); `store.ts` (drop push_edges helpers) | ~1500–2500 LOC (mostly relocation) | **High** — T1/T2/T3 all bind here; idx byte-equivalence and bomb/fuzz bounds are the core correctness risk | T1; T2 (peak memory + bomb fixture); T3 (<200 subrequests, DO-call cap); idx v2 byte-equivalence; thin-pack fsck; format-patch roundtrip |
| 3. R2 key layout | new `src/git/r2keys.ts`; `packstore.ts`; `repo.ts`; `git/protocol.ts`; `mod.ts`; `env.ts` (binding rename `PACK_CACHE`→`REPO_PACKS`; `apps/worker/wrangler.jsonc` already correct) | ~200–300 LOC | **Low–Medium** — mechanical, but a missed site silently forks the namespace; the purge/sweep paths must agree with the builder | T6; delete-purge e2e; orphan sweep under new layout; clone fast-path hit; full suite re-run |
| 4. DO schema alignment | `git/store.ts`; `git/packstore.ts`; `src/control-plane.ts`; `repo.ts` (wipe-as-transaction) | ~400–600 LOC | **Medium** — touches every read; clean cutover (no dual-schema) keeps it tractable | Full e2e from empty DO; `refs_version` bump assertion (T4 groundwork); lease-expiry alarm sweep; all SPEC-0001 §6 correctness gates |
| 5. API-side commit builder (§4) | new `src/commit/serialize.ts`; `src/control-plane.ts` (+`putApiObjects`/`commitApiChange`); reuses `GitStore.put`, `hashObject` | ~300–400 LOC | **Low–Medium** — git serialization byte-format correctness is the risk; CAS/`refs_version` reuse is proven machinery from Steps 1/4 | `git fsck` clean after API commit; clone-after-API-commit roundtrip (client sees identical history); concurrent API-write + push CAS conflict test; `refs_version` bump assertion; refname-validation parity with receive; oid-verification rejection; landing order: after Step 4, required before SPEC-0004 tier-1 content endpoints ship |

Sequencing note: Steps 3 and 4 are order-independent; the fixed order (keys then
schema) is fine because Step 3's `storage_key` persistence lands in `meta` first and
`pack_catalog` formalizes it in Step 4.

## 7. NOTICE discipline (`packages/git-engine/NOTICE.md`)

Per the vendoring policy (SPEC-0001 §8, NOTICE provenance rule), every deviation lands
as one line (date, file(s), reason) in "Local adaptations". Categories that M2 will
generate, each of which **must** be recorded:

1. **New files** — `src/control-plane.ts`, `src/git/r2keys.ts`,
   `src/receive/{scan,delta,idx}.ts`, `src/commit/serialize.ts`: added, one line
   each, with the split-plane reason.
2. **Modified upstream files** — `mod.ts`, `repo.ts`, `git/protocol.ts`,
   `git/packstore.ts`, `git/store.ts`, `env.ts`: one line per file per logical change
   (not per hunk): e.g. "receive moved to Worker per SPEC-0001a §3 Step 1".
3. **Deletions of upstream mechanisms** — `receiveChain` serialization;
   `x-changed`/`x-commit-time`/`x-ref-updates` header channel; `pack_pending`,
   `push_edges` tables; `blockConcurrencyWhile` in the DELETE wipe; celld fallback
   branches that become dead on our Workers (if removed rather than kept): recorded as
   removals with the replacing mechanism named.
4. **Renames / constant changes with no structural move** — `pack_meta`→`pack_catalog`,
   `pack_id`→`pack_key`, R2 key layout `raw/<repo>/<id>`→`repos/<storage_key>/…`,
   binding `PACK_CACHE`→`REPO_PACKS`: each gets a line; these are the easiest to skip
   and the most important for upstream-diff reviewability.
5. **Interface additions on exported classes** — new public RPC methods
   (`beginReceive`/`finalizeReceive`/`releaseReceive`/`putIndexRows`/`lookupObjects`,
   plus the commit builder's `putApiObjects`/`commitApiChange`) change the generated
   `dist-types/` boundary consumed by the worker: note that `pnpm typecheck`
   regeneration is part of each landing.

Not NOTICE-eligible: pure code motion between engine files with no behavioral change
still gets one line when it removes upstream code (category 3); reformat-only diffs
are avoided entirely (upstream diff must stay reviewable). Provenance rule continues
to apply: no ziggit (GPL-2.0) code; gitoxide-derived snippets only with attribution
comment.

## 8. SPEC-0001 corrections surfaced by this amendment

To be folded into SPEC-0001 when this amendment is accepted:

1. **§4 `pack_objects` column list is insufficient.** Re-emitting stored entries
   verbatim (the serve path's core) needs `data_off`, `data_len`, `entry_size` and idx
   needs `crc32`, beyond the listed `oid → (pack_key, offset, type, size, base_oid)`.
   Amend §4 to the full column list; the `(pack_key, offset)` keyset ordering stays.
2. **§4 `pack_catalog` lacks a storage-location column.** §3's "Packs ≥16 MiB exist
   only in R2" implies small packs may remain in DO SQLite; `pack_catalog` needs
   `location 'r2' | 'sqlite'` (carries dgit's proven `store` column forward).
3. **§2 tagged-union rule needs a transport clarification.** The DO returns
   application outcomes as tagged unions; transport failures still throw to the
   caller and must be handled as retryable-unknown (lease expiry sweep makes this
   safe). Without this the rule is unimplementable literally over Workers RPC.
4. **§3 staging key vs. worker Env binding name.** The worker binding is
   `REPO_PACKS` (wrangler.jsonc, single source of truth); engine `Env.PACK_CACHE` is
   renamed to match (recorded per §7).
5. **§5 wording** "finalizeReceive inside the DO" should add the copy-before-finalize
   ordering (staging → `packs/` copy precedes the commit transaction; §3 Step 1
   above) — the reverse order admits a committed ref pointing at a missing object
   under crash.
6. **New write entry point.** SPEC-0001 should record (cross-ref SPEC-0004 §3.4)
   that API-side endpoints construct commits without a push: objects land in the
   existing loose `objects`/`chunks` tables via `putApiObjects`, refs move via
   `commitApiChange` under the same CAS/`refs_version` machinery as receive (§4
   above). No §3 R2-key change is required (no R2 objects are written); the DO-side
   lighter connectivity gate (tip + root-tree presence) is acceptable because the
   caller is a same-account Worker over a service binding. M3 compaction must treat
   API-written loose objects as a steady-state input, not just GC-migration debris.

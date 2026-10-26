# SPEC-0011: Pack compaction & garbage collection (read leases, four-state pack lifecycle)

Status: **accepted — ratified 2026-10-25** (the M2 stability gate is met: two
production deploys green — cf93d51f and 15802991 — with 1854/1854 attributed
gates, smoke 5/0/2 incl. the anon-401 and DELETE-cascade validations, and the
P0 review package delivered with same-deployment-state probe evidence;
reviewer verdict: engineering-verified, independent audit pending as a
separate track). Implementation begins at milestone M3.0 (the DO schema
migration mechanism — §9); the fault-injection gate (§7) is the acceptance
bar. · Date: 2026-10-24 · Ratified: 2026-10-25
Depends on: SPEC-0001 (storage engine, incl. 0001a lease RPCs), SPEC-0003 (git-HTTP serve paths), `docs/design/m3-design-inputs.md` (normative inputs, adopted verbatim where cited)
Owns: pack lifecycle states, DO read leases, compaction algorithm & publish ordering, GC triggers & deletion, the M3 fault-injection acceptance suite.

## 1. Problem and scope

Every push lands a new pack (`packages/git-engine/src/receive/`, catalog rows in
`pack_catalog` — `PackCatalogRow`, `packages/git-engine/src/git/packstore.ts:91`).
Nothing ever merges or removes them. Three costs grow without bound:

1. **Fetch cost** — serving a ref can require walking many packs (the invariants
   suite already exercises a seven-pack repo); object reads fan out per pack.
2. **Storage cost** — packs and immutable clone-cache packs (keyed by
   `refs_version`) accumulate forever.
3. **Induction-premise erosion** — SPEC-0001's copy-before-finalize guarantees a
   ref's closure was complete *at push time*. Any deletion mechanism that removes
   ref-reachable objects breaks the premise every later verification leans on.

M3 adds **compaction** (merge packs, supersede the inputs) and **GC** (delete packs
no plan can reference), both concurrent with live fetches and pushes, without
violating the premise. The v1 property choice is **safety (Property A), not
availability (Property B)** — any *successfully completed* fetch is complete,
parseable, and protocol-valid; lease failure or object unavailability must never
be reported as success. Availability-under-GC is explicitly NOT promised (rounds
4–5, adopted).

Out of scope for v1: partial-clone `filter` support (unadvertised today),
mid-pack resume-from-byte-offset, RECLAIMABLE recovery transactions, hidden-refs
predicate refinement (§4.3).

## 2. Pack lifecycle — four states

```
ACTIVE ──(catalog publish supersedes it)──▶ RETIRED ──(zero live read leases)──▶ RECLAIMABLE ──(R2 delete + catalog cleanup)──▶ DELETED
```

State lives in `pack_catalog` as a new `state` column (`active` | `retired` |
`reclaimable`; `deleted` = row gone). Today's rows have no state column — every
row is implicitly ACTIVE. Transitions:

| Transition | Actor | Preconditions | Crash semantics |
|---|---|---|---|
| ACTIVE→RETIRED | compaction's catalog publish (single DO SQLite txn) | successor pack written to R2 and verified in the SAME txn that flips both rows | txn is atomic: publish either happened or not; old pack never deletable before successor publish |
| RETIRED→RECLAIMABLE | GC scan (DO txn) | zero live read leases reference the pack AND receive-finalize premise check cannot need it (§6) | idempotent re-scan; sweeper converges by catalog state, never by assumption |
| RECLAIMABLE→DELETED | GC delete (after R2 DELETE ack) | RETIRED ∧ zero leases ∧ RECLAIMABLE recorded | R2 DELETE retried idempotently; partial multipart aborts must be recoverable; catalog row removed only after ack |

Invariants (m3-design-inputs §"Pack lifecycle", adopted):
- RETIRED packs serve **existing** readers but are excluded from **new** plans.
- Fixed grace periods are INSUFFICIENT for streaming fetches: response wall time
  is unbounded (slow client + backpressure), so bytes/CPU bounds do not bound
  read duration — hence leases, not timers, gate RECLAIMABLE.
- **RECLAIMABLE is irreversible in v1**: a late renewal for a RECLAIMABLE pack is
  rejected → reader aborts (terminate-and-retry). Re-marking readable is an
  explicit recovery transaction, out of scope.

`location: "sqlite"` packs (small-pack path, `packstore.ts:126`) participate in
compaction as merge INPUTS but compaction always emits `location: "r2"` outputs
(§5.2). Open question Q3 covers sqlite-row cleanup.

## 3. Read leases — DO-issued, renewed inline, durable

The leases table already exists (`leases`: `lease_token`, `kind`, `expires_at`,
`payload` — `packages/git-engine/src/git/store.ts:280`); `kind` is a free string
with `receive` in use and `compaction` reserved (SPEC-0001a). M3 adds
`kind = 'read'`.

1. **Plan + lease are atomic.** `planFetch` (the negotiated-closure planner,
   round-6 closure-policy separation) registers the read lease in the SAME DO
   SQLite transaction that reads the catalog — closes the register-after-check
   race (round 4, adopted).
2. **Lease payload**: the protected pack key set, the plan generation id, and
   expiry. Lease rows persist in DO SQLite; **DO restart preserves unexpired
   leases**; renewal and GC eligibility evaluate in the same serialized control
   domain (the DO).
3. **Renewal protocol (read-safety, round 4)**: no R2 GET segment may start
   without a lease whose expiry the Worker has CONFIRMED covers the segment.
   `renewAndAuthorizeRead(planId, packKey, byteRange)` is awaited INLINE in the
   sideband re-framing loop before the next segment is pulled — the Worker paces
   the stream, so a slow renewal back-pressures the client instead of racing GC.
   A rejected or expired renewal aborts the response (terminate-and-retry
   posture; git clients tolerate a failed fetch and re-fetch).
   - Fencing honesty: R2 does not check DO tokens — the Worker's pre-read check
     IS the enforcement point. Under Property A a missed check can fail a fetch
     but cannot corrupt one (round 4, adopted).
   - Renewal cadence: per segment (bounded size, §4.1) — no separate timer shape.
4. **Release semantics (round 5)**: leases protect the R2-read dependency, NOT
   the HTTP response lifetime. Release when all dependent R2 reads completed AND
   no future read will target the protected packs — after the last Range GET
   (segmented path) or at stream end (fast path). Buffered bytes streaming to a
   slow client need no pack protection — this decouples GC from transfer time.
5. **Expiry mid-stream**: the reader stops using the old plan — replan only at a
   safe boundary (before any byte of that pack was sent) or terminate the
   response. Mid-pack resume is NOT required in v1 (documented choice).

## 4. Serve paths under leases

### 4.1 Segmented path (multi-pack union serve)

Per-catalog-entry **bounded R2 Range GETs**, each triggered only after a
confirmed `renewAndAuthorizeRead`. Segment sizes are bounded for the 128 MiB
isolate. Read segments are explicit Range GETs, NOT stream-chunk pauses —
pausing `reader.read()` does not provably stop underlying R2 I/O
(prefetch/buffer) and is no longer an assumption we rely on (round 5, adopted).

### 4.2 Fast path (clone-cache whole-pack stream)

The clone cache (`serveCloneFromR2`) serves ONE long-lived GET; the lease covers
the entire stream duration. If a concurrent delete truncates it, the fetch fails
whole — Property A holds. Availability on this path rests on clone-cache
immutability: packs are keyed by `refs_version`, deleted only with the version
they serve; GC of a cache entry makes future plans not reference it, and
in-flight streams are covered by the same overlap-safety argument.

### 4.3 Hit predicate (unchanged, now load-bearing)

Exact-full-clone ONLY: wants == current tips ∧ no haves ∧ done ∧ no shallow ∧ no
filter (seven conditions at the call site incl. the protocol-shape guard, round
7 finding 2). "Full pack is a superset" is NOT an acceptable hit rationale. When
SPEC-0003 hidden-refs lands, the predicate gains a documented per-ref visibility
constraint (today: repo-granular ACL, strict set equality against ALL refs).

## 5. Compaction algorithm

### 5.1 Trigger policy

Compaction runs as a DO-scheduled task behind a `kind = 'compaction'` lease
(receive leases already exclude it — `store.ts:316` blocks on `kind='receive'`).
Triggers (Q1 holds the numbers): pack-count threshold per repo from the catalog,
post-push-N heuristic, or manual RPC. Cron enqueues; the DO consumer works
("crons enqueue, consumers work" — the standing Workers pattern).

### 5.2 Algorithm

1. Hold the compaction lease (excludes concurrent receive finalize AND concurrent
   compaction).
2. Read the ACTIVE set (bounded input window; single compaction never must touch
   every pack).
3. Merge objects (dedupe by OID; keep newest/base deltas), write the new pack to
   R2 (`repos/<key>/packs/pack-<sha1>.pack` layout unchanged), build its index
   rows.
4. **Publish** in ONE DO SQLite transaction: new pack row ACTIVE, superseded
   inputs RETIRED, `reachable`/`peeled` untouched (object-level truth does not
   move).
5. GC later reclaims (§2) once leases drain.

### 5.3 Publish ordering & crash windows (normative)

write new pack to R2 → single-txn catalog publish → lease-gated delete of
RETIRED. Crash windows:

- New pack written, catalog unpublished = **orphan** — sweepable, safe (prefix +
  catalog state converge; never assumed).
- Old pack is NEVER deletable before its successor's catalog publish.
- Partial R2 delete (multipart abort) must be idempotent-recoverable; the
  sweeper converges by prefix + catalog state, not by assumption (adopted).

### 5.4 Finalize-window safety (round 3, adopted)

Receive leases exclude compaction while live; at finalize the DO rechecks that
the verification's **dependency packs are still available** — a premise check,
NOT a version compare (an unrelated pack add must not invalidate a verification).

## 6. Invariants (normative, all CI-enforced where mechanically checkable)

1. **Ref closure availability**: `∀ r ∈ Refs: Closure(r) ⊆ AvailableObjects`
   (readable, verified, parseable from R2 — not merely an index row).
2. **Induction premise stability**: closure validated at push stays valid — GC/
   compaction/re-index preserve it across every transition.
3. **Separated read invariants**: (a) catalog-switch atomicity — no single DB
   read sees a partial update; (b) fetch-plan validity — every pack referenced
   by an in-flight plan stays readable for the plan's lifetime, across catalog
   generations (mixed-generation plans are legal; each location must be).
4. **The quartet**: copy-before-finalize · CAS-before-ref-update ·
   lease-before-read · **validate-before-plan**.
5. **Safety proposition**: any successful fetch's output object set is complete,
   parseable, and Git-pack-protocol-valid; lease expiry or unavailability is
   never reported as success.
6. **GC isolation proposition**: while a valid read authorization protects a
   fetch's dependency set, GC must not make those packs unavailable.
7. **Overlap-safety rewording (round 5)**: we do NOT prove "R2 reads never
   overlap legal GC deletes" — inline renewal proves `t_GET-start < t_expiry`,
   not `t_GET-end`. We prove "any overlap never produces a wrongly-successful
   fetch": a GET spanning lease expiry either completes (fine) or fails
   (whole-fetch failure, never false success).
8. **Server-owned negotiated closure**: `SuccessfulFetch ⇒ ValidPack ∧
   ValidNegotiatedObjectClosure` — the closure is guaranteed SERVER-side by the
   plan's wants−haves closure walk; client connectivity checks are
   defense-in-depth. Failure discipline is structural: full data → checksum
   trailer → flush; an aborted stream can never carry a success-completing tail.
9. **Two-layer success (round 6)**: `ServerSuccess = ValidNegotiatedObjectClosure
   ∧ CompletePackEmission ∧ ValidProtocolTermination`; `ClientSuccess =
   ServerSuccess ∧ ClientValidation`. The structural tail proves transport only —
   plan correctness is the load-bearing half.

## 7. Acceptance — fault-injection suite (the gate)

The suite attempts every history the review constructed; the closing
counter-example (§7.1) is the acceptance gate. All in the engine e2e harness
(real DO + R2 local, fault injection at RPC/IO seams).

### 7.1 The closing counter-example (must attempt explicitly)

Construct: every individual transaction succeeds, every Worker obeys its
protocol, every R2 operation succeeds — and yet a concurrent fetch reads a pack
that was legally GC'd. The lease design intends the proof: plan+lease atomic;
delete requires RETIRED ∧ zero live leases; therefore a pack being read has a
live lease and cannot be deleted. The suite must FAIL to construct it.

### 7.2 Matrix (rounds 4–6 additions)

| # | Fault | Asserted outcome |
|---|---|---|
| 1 | fetch × compaction concurrency | both succeed or fetch aborts cleanly; never false success |
| 2 | slow-client (throttled) fetch during GC | completes or aborts; leases outlive transfer (release = last R2 read, not response end) |
| 3 | lease expiry mid-stream | reader abandons plan or replans at safe boundary |
| 4 | compaction crash before publish | orphan pack swept; catalog unchanged; fetches unaffected |
| 5 | compaction crash after publish, mid-delete | delete retried idempotently; converges |
| 6 | (A) renewal-late — DO processing delayed so GC pre-empts | renewal REJECTED, reader abandons the plan |
| 7 | (B) DO restart mid-fetch | unexpired leases still block deletion |
| 8 | (C) delete vs renewal race — GC pauses at RECLAIMABLE before R2 DELETE | the system NEVER grants both the renewal and the delete |
| 9 | GET spanning lease expiry (start before, end after) | complete-or-fail, never false success |
| 10 | stream prefetch probe | nothing depends on pause-stops-I/O |
| 11 | valid-but-incomplete pack (correct checksum, missing negotiated objects) | server-side plan rejection is the contract (client rejection defense-in-depth) |
| 12 | early lease release (last R2 read done, HTTP still sending) | GC may reclaim; the fetch still completes correctly |

### 7.3 CI additions (correctness tier)

99/101 MB boundary pushes (decimal), newTip-exists-tree-missing injection,
finalize-success-response-lost retry convergence, full clone with cross-pack
delta bases, incremental fetch relying on REF_DELTA + negotiated haves; the
six-row clone-cache mismatch matrix (depth=1, filter=blob:none, different wants,
different capabilities, stale-version-no-false-hit, deepen-family poisoning);
capability matrix **test-generated** (`AdvertisedFeature ⇒ ParsedAndHandled` —
round 8's consistency gate; never hand-maintained); cheap differential testing
vs a real Gitea instance (diffs explainable by declared compatibility rules).

## 8. Engine schema evolution — LANDED as M3.0 (commit eab5cf2)

The mechanism (as built, replacing the original note below): a dedicated
`schema_migrations (id, applied_at)` journal table — per-step records
represent partially-upgraded databases exactly (an isolate death mid-upgrade
resumes correctly), the journal doubles as the downgrade tripwire (an id the
running build does not know = DB ahead of code → refuse; rollback past a
step is unsupported by design), and steps run ordered, idempotent, each with
its journal insert atomic under the caller's `transactionSync`. Baseline 0001
keeps `meta.schema_version = "0001a-step4"` so a rollback deploy to the
pre-M3.0 build (whose constructor wipes on marker mismatch) never wipes a
migrated DB. Unrecognized pre-baseline states are **sealed stores**: the
decision writes nothing, every data access raises a distinct
`[schema sealed]` diagnostic, and exactly one request is served — the
explicit DELETE (the sanctioned destroy channel), which wipes loudly and
unseals; `rpcBind`/`alarm` stay sealed-aware so a sealed cell is never
undeletable. Constructor-time auto-reset exists only under an explicit
`allowUnknownSchemaReset` option, logging loudly first. Demonstrator 0002 is
a real secondary index (`pack_objects(pack_key, oid)`) with the planner
change pinned by EXPLAIN QUERY PLAN. All future schema changes land as
ordered steps in `REPO_MIGRATIONS`/`REGISTRY_MIGRATIONS` — never another
version-bump-and-wipe. Verified by `e2e/check-migrations.mjs` (17 checks).

*Original note (superseded):* `SCHEMA_VERSION` (`store.ts:16`, currently
`"0001a-step4"`) was a dev-scratch guard, not a migration mechanism
(`store.ts:91` treated mismatch as scratch state). M3 needed the first REAL
DO schema migration: `pack_catalog.state`, lease payload v2, and a
forward-only migration path with an upgrade txn.

## 9. Milestones

- **M3.0** — DO schema migration mechanism (upgrade txn, versioned, testable on
  populated scratch state) + `pack_catalog.state` column backfill.
- **M3.1** — read leases: `kind='read'` rows, `planFetch` atomic plan+lease,
  `renewAndAuthorizeRead` RPC, release-on-last-read.
- **M3.2** — segmented serve path lease integration (bounded Range GETs after
  confirmed renewal); fast-path whole-stream lease.
- **M3.3** — compaction: lease-gated merge, publish ordering, orphan sweeper.
- **M3.4** — GC: RETIRED→RECLAIMABLE→DELETED, idempotent R2 delete, premise
  check at receive finalize.
- **M3.5** — fault-injection suite (§7) + test-generated capability matrix +
  differential harness; the review-facing state-transition table regenerated
  from code.

## 10. Open questions (resolve at M3.0/M3.1 design review)

1. Compaction trigger thresholds (pack count / byte size / push count) —
   bench-informed; start conservative.
2. Lease TTL and segment-size constants (renewal cadence) — bounded by RPC cost
   vs GC latency; must keep a slow client's stream alive indefinitely via
   renewal (that is the point of leases).
3. Do `location:"sqlite"` packs get compacted into `r2` eagerly (cleanup of
   sqlite rows/chunks) or only when their size crosses the small-pack
   threshold?
4. Clone-cache GC policy: version-window retention (N previous refs_versions)
   vs lease-drain-only.
5. Whether `listPackCatalog` gains a `state` filter in v1 or stays
   worker-internal.

## As-built records (landed milestones)

- **M3.2 (e359e44, 2026-10-25)**: the segmented path's gap was real — the DO
  serve arms renewed PLAN-level only at batch boundaries; the R2 Range GET
  seam inside `PackStore.chunk()` had no per-pack authorization. Landed:
  `ReadGate` invoked synchronously immediately before every Range GET on a
  chunk-LRU miss (cache hits consult nothing), `SERVE_SEGMENT_BYTES =
  PACK_CHUNK` (1 MiB — ~4 orders under the isolate bound; ≤1 renewal txn per
  MiB), rejection throws → the pull loop errors the stream before any flush
  (fail-stop per Property A), installed at every emission read site of both
  DO arms. The Worker fast path was already M3.1-correct and is unchanged.
  Verified by `e2e/check-segmented-serve.mjs` (10 checks: renew-then-read
  ordering via counting-stub event timeline, mid-stream RECLAIMABLE flip,
  mixed-generation plans, segment bounds). Plan-time reads (negotiation/
  closure computation before planFetch) remain ungated by reviewed M3.1
  posture — GC flips there fail the fetch whole.

- **M3.3 (0303f5d, 2026-10-25)**: triggers `COMPACTION_ACTIVE_PACK_THRESHOLD=8`
  (above the invariants seven-pack fixture by design; a 9-pack repo converges
  in one round), window = oldest-first ≤8 packs / 32 MiB / 50k objects, lease
  TTL 10 min no-renewal (crashed holder expires into the sweep), manual RPC
  `compactNow({force?})`. The `state` column lands as migration step
  `0003-pack-catalog-state-live` — the Step-4 alignment had physically
  reserved the columns, so the step journal-records activation +
  guarded-ALTERs older vintages + backfills ACTIVE (never a version bump).
  Crash windows: lease payload names output keys BEFORE the R2 write; publish
  is one transactionSync re-guarded on lease liveness; the sweep converges by
  payload + catalog state (unpublished output → deleted; published output
  kept). Inputs are never deleted here (M3.4 owns deletion). Finalize premise
  holds across ACTIVE→RETIRED (publish only re-points identical content
  atomically); `renewAndAuthorizeRead` membership is now state-aware
  (non-member ACTIVE = the re-pointed successor → authorized). Verified by
  `e2e/check-compaction.mjs` (8 checks: byte-identical closure walks over
  fulls/cross-pack REF/OFS/loose-base deltas, determinism, both crash
  windows, RETIRED-serves-readers mixed-generation clone, lease exclusion).

- **M3.4 (b4bab63, 2026-10-25)**: `gc.ts` — RETIRED→RECLAIMABLE in one DO txn
  guarded by (a) zero live read leases and (b) the as-built premise guard,
  which STRENGTHENS the spec: the sweeper transitively VERIFIES the
  supersession chain reaches an ACTIVE pack (a direct-successor check would
  strand rows forever when the successor is itself retired by the next round
  — found by check-compaction's chained-cadence scenario; unverifiable
  chains stay RETIRED as `premiseUnsafe`, retried). RECLAIMABLE→DELETED
  removes the catalog row only after the R2 DELETE resolves (unbound-host
  adapter throws so an ack means deleted); idempotent retry; defensive
  zero-lease re-check before delete (fault C's never-grant-both,
  structural). RECLAIMABLE irreversibility pinned by test. Trigger:
  `gc_wanted_at` stamped by every RETIRED-producing compaction round and
  every committed ref change; alarm order sweep → M2 gc → compaction → GC;
  manual `RepoCell.gcNow()`. Clone-cache GC: lease-drain-only (OQ4's
  conservative half; version-window retention stays open for M3.5).
  **§7.1 closing counter-example: construction FAILED as designed** — a
  real uploadPack stream interleaved with mid-stream GC passes (publish,
  flips, R2 deletes, row removals all succeed) never sees a deleted pack;
  the mid-stream pass is lease-blocked; the stream completes with its flush
  tail (never a false success); post-hoc closure walk byte-identical.
  Verified by `e2e/check-gc.mjs` (8 checks); all 12 engine check scripts
  green (223 checks total).

**Implementation milestones M3.0–M3.5 COMPLETE (2026-10-25).**

- **M3.5 (2026-10-25)**: the acceptance-hardening tail — §7.2 rows 1-5
  completed, §7.3's correctness-tier additions landed as engine checks, and
  the capability matrix made TEST-GENERATED (round 8's consistency gate).
  All 15 engine check scripts green, **260 checks total** (was 12 scripts /
  223 checks at M3.4; +3 scripts, +37 checks). (Post-M3.5 growth: SPEC-0013's
  `check-validate-push.mjs` makes 16 scripts / 269 checks on disk — the
  2026-10-26 health sweep's verified count, docs/research/
  engine-e2e-health-2026-10-26.md.)

  **§7.2 rows 1-5 — per-row audit and completion.**
  - Row 1 (fetch × compaction concurrency): WAS covered for
    compaction-then-fetch (check-compaction §2/§5.4: a pre-compaction plan
    keeps reading; both succeed). ADDED (`check-fault-matrix.mjs`): a REAL
    `runCompaction` publish interleaved INTO an in-flight segmented fetch at
    the segment-GET seam — both succeed, the per-segment seam guard stays
    armed across the publish (every post-publish GET lease-protected), the
    flush tail stands, the closure is byte-identical, retired inputs keep
    serving mid-stream. The abort-cleanly leg is row 3/C's landed posture.
  - Row 2 (slow-client throttled fetch during GC): WAS covered half-landed —
    check-read-leases §4.2/§3.4 pins release-exactly-at-last-R2-read for a
    slow client (no GC running); check-gc §7.1 runs GC mid-stream with a
    fast drain. ADDED: a GC pass MID-TRANSFER of a paced fetch — every flip
    blocked (`blockedByLeases`), bytes untouched, transfer completes — plus
    row 12's early-release overlap on the same timeline: GC flips and
    reclaims WHILE the response is still draining and the drain still
    delivers its flush tail.
  - Row 3 (lease expiry mid-stream): WAS covered as units (check-read-leases
    §3.3 fault A + the fast-path rejected-renewal termination;
    check-segmented-serve §3.3 unit + fault-C mid-stream flip). ADDED: a
    REAL mid-stream expiry on the segmented path — a deterministic clock
    crossing the TTL between segments, the inline confirmed renewal REJECTED
    (fault A), the reader abandoning the plan: stream errors BEFORE the
    flush tail, lease released, never a false success.
  - Row 4 (compaction crash before publish): WAS landed (check-compaction
    §5.3: orphan swept by payload + catalog state, catalog byte-unchanged,
    next round succeeds). The row's remaining assertion — "fetches
    unaffected" — APPENDED to that check: a full clone straight after the
    sweep completes with its flush tail and leaves the catalog
    byte-unchanged.
  - Row 5 (crash after publish, mid-delete): WAS landed in outcome
    (check-gc §2 crash-mid-R2-delete + delete-failing-whole: idempotent
    retry converges) but on a SQL-fabricated retired row. ADDED: the full
    composition — a REAL publish lands, the first GC delete pass crashes
    mid-R2-batch (per-pack deletes are independent: the crashed pack stays
    RECLAIMABLE awaiting its ack while the others reclaim in-pass), the
    retry converges, the successor stays ACTIVE and serves, closure
    identical.

  **§7.3 correctness-tier CI additions** — audited: none existed as
  automated checks (bench fixtures cover throughput only; e2e.sh needs a
  running Worker). Landed as `check-correctness-tier.mjs` (7 checks), which
  drives the REAL Worker-side receive flow — `createDurableGit().fetch` with
  the real `parsePushRequest`/`stagePack`/scan/`finalizeReceive` pipeline,
  the DO RPCs executed by the real control plane over node:sqlite, R2
  staged in memory — plus real `git` as the serve oracle:
  - 99/101 MB boundary pushes: the ~100 MB decimal cap is the Cloudflare
    PROXY's (SPEC-0001 §6 T1 — >100 MB histories must use the import
    channel), so the engine-side contract is pinned size-parametrized at
    `MAX_PUSH_MB=1` MiB: under-cap lands; an over-cap DECLARED length is a
    413 BEFORE any DO RPC or R2 write; an over-cap UNDECLARED body aborts AT
    the cap mid-staging (multipart aborted, staging swept) with every
    command ng in report-status and zero refs touched.
  - newTip-exists-tree-missing injection: a pack carrying only the tip
    commit — the scan's connectivity anti-check flags the missing tree,
    finalize rejects "missing necessary objects", no ref moves, staging
    swept.
  - finalize-success-response-lost retry convergence: the retried finalize
    and the Worker's `releaseReceive(sweep)` both return `lease_mismatch`
    WITHOUT un-applying anything — ref, catalog row, index rows and packs/
    bytes survive; the new tip serves with its flush tail.
  - full clone with cross-pack delta bases: the served pack ships every
    cross-pack REF-delta base — real `git index-pack` WITHOUT `--fix-thin`
    accepts it, `git verify-pack -v` shows the delta shipped AS a delta over
    the cross-pack base, `git fsck --strict` is clean over the cloned refs.
  - incremental fetch relying on REF_DELTA + negotiated haves: the
    `multi_ack_detailed` ACK/last-ACK shape, the exact new-object set (new
    tip, its tree, its new blob — haves-side objects never re-sent, and
    never a thin delta against an unshipped base), then the real-client
    validation: the pack drops onto a repo holding only the haves' objects
    and `git fsck --strict` is clean.
  - The six-row clone-cache mismatch matrix: deepen-family poisoning +
    parse-struct rows were landed (check-cache-unreachable G3-direct,
    mutation-tested + check-deepen-parse); the CAPABILITY row is now
    directly pinned (a non-side-band full clone satisfying every other
    predicate makes ZERO planCloneStream RPCs and zero R2 reads — appended
    to check-cache-unreachable, now 19 checks); different-wants →
    not-all-tips miss was landed (check-read-leases RepoCell); filter →
    rejected at parse (check-deepen-parse + the capability matrix's
    contrapositive); stale-version-no-false-hit holds by construction (the
    probe key derives from the LIVE `reachableVersion` — a stale entry is a
    different key that is never probed) with the stale-entry lifecycle
    pinned by check-gc §4.2's drain check.
  - Differential testing vs a real Gitea instance: the harness and battery
    were already landed outside the engine (scripts/diff-test.mjs +
    scripts/diff-cases/ with declared rules; CI job `diff-battery`,
    ours-only since the 2026-10-25 no-egress attempt) — nothing added here.

  **Test-generated capability matrix** (`check-capability-matrix.mjs`, 18
  checks): the advertised-capability table is derived from the LIVE
  handshakes — v0 upload-pack, v0 receive-pack, protocol v2 — by parsing
  the advertisement BYTES; every advertised token must resolve to a
  REGISTERED PROOF that drives the real request path (uploadPack / the
  control plane / the receive scanner) and asserts its semantics:
  `multi_ack_detailed` (ACK common + final ACK), `no-done` (ready+NAK+ACK
  and the pack in the same response), `shallow` (deepen <n> handled;
  deepen-since/not/relative rejected fail-closed), `side-band-64k` (band-1
  data + band-2 progress + flush tail; push-side report-status framing),
  `symref=HEAD:<target>` (advertisement value == live HEAD == ls-refs
  symref-target), `agent=<name>/<version>` (key=value wire form;
  capability updates never fetch arguments), `version 2` (a v2 fetch
  answers `packfile`), `ls-refs` (listing + symrefs), `fetch=shallow` (v2
  shallow-info section), `report-status` (per-command ok/ng rendering),
  `delete-refs` (a delete command removes the ref), `ofs-delta` (the
  scanner resolves type-6 OFS entries end to end). An edit that advertises
  a capability without a handler proof FAILS the gate. Contrapositive
  pins: `filter` NOT advertised anywhere and rejected in both v0 and v2;
  unknown arguments fail closed; the empty-repo `capabilities^{}`
  advertisement well-formed.

  Gates observed with my own eyes: all 15 scripts green (totals per
  script: cache-unreachable 19, capability-matrix 18, catalog-rpc 10,
  compaction 8, correctness-tier 7, deepen-parse 16, fault-matrix 4,
  fork-replicate 50, gc 8, merge-engine 29, merge-graph 14, merge-tree 25,
  migrations 17, read-leases 25, segmented-serve 10); engine
  `tsc -p tsconfig.build.json` clean. (The workspace `pnpm typecheck`
  failure at commit time is a SIBLING WAVE's mid-flight apps/worker change
  — untracked pull-reviews.test.ts importing not-yet-landed modules —
  outside engine ownership; not this milestone's gate.)

- **Content-path lease coverage (2fce4cd, 2026-10-25 — closes M3.2's known
  follow-up)**: every R2 content read is now lease-covered or provably
  clean-fail. `withContentLease` at the engine's RPC boundary wraps the six
  typed content RPCs (readBlob/readCommit/listLog/listTree/readDiff +
  listRefs) and the ui() page renders (one lease per render; `/api/*`
  routed around the double-lease) with the M3.2 `serveReadGate` threaded to
  every chunk read and release in `finally` — zero worker-side changes (the
  boundary covers all EngineClient consumers transitively). The v2 ls-refs
  peel arm is leased (its silent missing-`peeled:` line was the other real
  wrong-partial, alongside snapshot's silent file omission — both now
  impossible). Plan-construction reads (want-validation, closure walks,
  `commitApiChange`/merge validation) remain ungated BY PROOF: every such
  caller converts a mid-GC null into a conservative whole-response outcome
  (want rejected / plan throws / CAS aborted / mergeability degrades to
  error) — never a wrong success. Verified by check-read-leases' five
  CONTENT checks (25 total), incl. concurrent-GC flip-blocking at the R2
  seam and post-reclaim whole-refusal.

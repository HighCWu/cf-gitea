# M3 state-transition table — pack lifecycle, regenerated from code

SPEC-0011 §9 (milestone M3.5) deliverable: the review-facing state-transition
table, regenerated from the CURRENT tree — not the hand-written §2 draft in the
spec (`specs/0011-compaction-gc.md:40-54`). Per state and per transition this
document names the actor (the exact code path), the preconditions, the crash
semantics (what a crash mid-transition leaves behind and how recovery treats
it), and the pinning evidence: a code citation (`file:line`) plus, where one
exists, the engine e2e check that pins the row.

Provenance: written 2026-10-28 by a read-only docs unit against HEAD
`4d039cb` (no engine commit since `bff7fdc`, the HEAD of the verified
2026-10-26 health sweep — `docs/research/engine-e2e-health-2026-10-26.md`).
Every `file:line` below is from the current tree. Writers cited:

- `packages/git-engine/src/gc.ts` — the ONLY writer of `reclaimable` and the
  only remover of catalog rows (module header, `gc.ts:1-81`; NOTICE.md:132).
- `packages/git-engine/src/compaction.ts` + `publishCompaction`
  (`src/git/packstore.ts:929-974`) — the sole ACTIVE→RETIRED writer (the
  single `transactionSync` publish; spec §8 M3.3 record,
  `specs/0011-compaction-gc.md:322-339`; NOTICE.md:125-126).
- `packages/git-engine/src/read-leases.ts` — the eligibility substrate every
  transition consults (`hasLiveReadLeaseFor`, `read-leases.ts:120-126`;
  NOTICE.md:112).

Amended same-day by the D3 engine-fix unit (compaction.ts touched — the T1
row's compaction.ts/check-compaction.mjs line cites were refreshed to the
post-fix tree; D3 marked FIXED; §6 item 1 resolved) — the fix is commit
`6545edd`, the rows-10/11 pins are commit `849885e`, and the README
script-list housekeeping (§6 item 3's remainder) landed in `f9a63ec`.
Re-verified 2026-10-31 (board row P3-4 closure): the fix and pins confirmed
against the tree unchanged, the FULL 30-script engine e2e family green
(PASS=30 FAIL=0, incl. check-compaction 10/10 and check-fault-matrix 6/6),
engine `tsc -p tsconfig.build.json` clean with dist-types regenerated.

## 1. The states as the code holds them

State lives in `pack_catalog.state` (`src/git/packstore.ts:109` —
`PackState = "active" | "retired" | "reclaimable" | "deleted"`; columns
physically reserved at the Step-4 alignment, activated by migration step
`0003-pack-catalog-state-live`, `src/git/migrations.ts`, spec §8 M3.0/M3.3).
No row is ever written with `state = 'deleted'`: DELETED is represented by
row absence (`deleteReclaimablePack` DELETEs the row,
`packstore.ts:853`); the `"deleted"` member of the union exists only so the
fork-replication surface can describe the lifecycle externally
(`src/fork/types.ts`, NOTICE.md:93).

Who reads which states:

- **Readable set** (`active` + `retired`): `readableCatalogKeys()`
  (`packstore.ts:671-679`) is both `planFetch`'s default protected set
  (`read-leases.ts:164-185`) and `renewAndAuthorizeRead`'s re-check gate
  (`read-leases.ts:268,289-302`). RECLAIMABLE/DELETED rows are excluded —
  this single SELECT is what makes RECLAIMABLE irreversible for readers.
- **Compaction inputs** (`active` only): `activePackCount()`
  (`packstore.ts:863-866`) and `activeCatalogWindow()`
  (`packstore.ts:876-908`).
- **GC scan listings** (`retired`, `reclaimable`): `catalogRowsInState()`
  (`packstore.ts:792-819`).
- **Fork replication** hides every non-ACTIVE row (compaction debris a fork
  must not copy — `listCatalogPage` pages `state='active'` only;
  `src/fork/types.ts`, NOTICE.md:93).

The lifecycle graph (§2 of the spec, as built — three transitions, one
direction each):

```
             compaction publish                GC scan                  GC delete
ACTIVE ────────────────────────▶ RETIRED ─────────────────▶ RECLAIMABLE ──────────────▶ DELETED
 (receive / fork / publish)      (superseded_by set)      (zero live leases)          (row gone)
```

Reversal is impossible in v1: no method writes `retired → active` or
`reclaimable → retired` (`packstore.ts:826-828` states this invariant over
the whole catalog surface), and RECLAIMABLE is irreversible
(`read-leases.ts:289-293` rejects late renewals; spec §2, adopted).

## 2. Entry into ACTIVE (context — not a §2 transition)

Three actors create ACTIVE rows; none is a lifecycle *transition*, but the
table is incomplete without them:

| Actor | Code | Crash semantics |
|---|---|---|
| Receive finalize | `recordPack` inside the finalize commit transaction (`src/control-plane.ts:707`; the copy-before-finalize ordering puts bytes in R2 before this — `src/mod.ts`, NOTICE.md:42) | Row + refs + index rows land in ONE transaction with the ref CAS — a crash leaves nothing servable; a retry hits `lease_mismatch` and re-runs cleanly (pinned: check-correctness-tier finalize-retry row, `e2e/check-correctness-tier.mjs`) |
| Fork-import finalize | `finalizeForkImport` — staged `fork_import` rows become catalog rows inside the ONE transaction that also writes refs (`src/control-plane.ts:1345`; NOTICE.md:95) | Crash before finalize leaves staging only; idempotent re-run converges (pinned: `e2e/check-fork-replicate.mjs` crash injection between adopt pages) |
| Compaction publish | the successor row INSERT inside `publishCompaction` (`packstore.ts:935-945`) — covered as the ACTIVE→RETIRED transition below | Same transaction as the retirement — atomic, see T1 |

## 3. The transition table

Notation: "pin" = the engine e2e check (and assertion line) that fails if the
row's behavior regresses. Check ids are the scripts' own §-labeled titles.

### T1 — ACTIVE→RETIRED (compaction publish)

| | As built |
|---|---|
| **Actor** | `runCompaction` (`src/compaction.ts:178-279`), triggered by the DO alarm threshold consumer (`maybeCompactFromAlarm`, `src/repo.ts:437-481`, `activePackCount() > 8` — `compaction.ts:62`) or the manual `RepoCell.compactNow` (`repo.ts:514-530`). The flip itself is `publishCompaction` (`packstore.ts:964-970`: `UPDATE … SET state='retired', superseded_by=? WHERE pack_key=? AND state='active'`) inside the ONE `transactionSync` at `compaction.ts:242-251`. |
| **Preconditions** | (a) no live `receive` lease and no live `compaction` lease (`compaction.ts:183-188`, `hasActiveLease`, `src/git/store.ts`; pinned: check-compaction §5.1 exclusion, `e2e/check-compaction.mjs:885`); (b) threshold exceeded unless `force` (`compaction.ts:191-194`); (c) bounded input window of ≥2 oldest ACTIVE packs (`compaction.ts:197-204`, `packstore.ts:876-908`); (d) the compaction lease still live **inside the publish transaction** — `compaction.ts:243-245` re-reads the lease row in the same txn and refuses to publish otherwise (`lease_lost`). Every precondition re-evaluates under DO serialization: there is no check-then-act window against leases. |
| **Crash semantics** | The publish is atomic (`transactionSync` = one SQLite txn): crash leaves the whole pre-publish world or the whole post-publish world. Ordering: lease payload names the output R2 keys BEFORE the R2 write (`compaction.ts:227-235`) → write pack+idx to R2 (`:237-238`) → publish (`:242-251`). **Window W1 — crash before/during the publish txn** (isolate death; the `finally` at `:275-279` never runs): catalog unchanged; successor bytes exist in R2 unpublished (an ORPHAN); an unexpired compaction lease whose payload names the output keys survives. Recovery: the lease-expiry sweep deletes the orphan **by payload + catalog state** — an output whose catalog row does not exist is deleted, never assumed (`sweepExpiredLeases`, `src/control-plane.ts:423-429`) — and drops the stale lease row. Pinned: check-compaction §5.3 crash-before-publish, `e2e/check-compaction.mjs:562` (catalog byte-unchanged, payload names keys, orphan swept, next round succeeds) + the §7.2 row-4 append ("fetches unaffected": post-crash full clone completes with its flush tail, catalog byte-unchanged — `check-compaction.mjs:610-618`). **Window W2 — crash after the publish, before the lease release**: successor ACTIVE, inputs RETIRED, stale compaction lease expires → sweep keeps the output (row exists) and deletes only the lease row (`control-plane.ts:423-429`; pinned: check-compaction §5.3 crash-after-publish, `e2e/check-compaction.mjs:624`). **Window W3 — lease expires mid-round, no crash** (`lease_lost`, `compaction.ts:252-257`): the GRACEFUL failure exit — and since D3's fix it is equivalent to W1: the `finally` releases the lease only when the publish landed (`compaction.ts:277`, the `published` flag), so the failed round KEEPS the row and the same sweep converges the orphan within the TTL (pinned: check-compaction §5.3 graceful failure exits, `e2e/check-compaction.mjs:674,723` — see D3). |
| **Invariant carried** | Retired inputs keep their bytes and serve existing readers THROUGH the successor's identical content: the publish re-points every merged `pack_objects` row onto the successor (guarded per-oid UPDATE, `packstore.ts:946-963`) and flips inputs RETIRED in the same txn, so no index row ever names a retired input and `store.has(tip)` at receive finalize resolves through the successor at every instant (§5.4 premise; finalize check `control-plane.ts:711-716`). Renewal is state-aware: a live plan re-directed onto the successor (a pack its payload never named) is authorized because the successor is ACTIVE (`read-leases.ts:270-287`). Pinned: check-compaction §5.2 publish rows (`e2e/check-compaction.mjs:443`), determinism (`:536`), §2/§5.4 plan-before-compaction mixed-generation clone (`:772`); check-segmented-serve mixed generations (`e2e/check-segmented-serve.mjs:399`). |
| **Pin** | check-compaction §5.2/§5.3 rows above; check-fault-matrix §7.2 row 1 (`e2e/check-fault-matrix.mjs:489` — a REAL publish lands MID-STREAM between segment GETs, both succeed, seam guard holds, closure byte-identical). |

### T2 — RETIRED→RECLAIMABLE (GC scan)

| | As built |
|---|---|
| **Actor** | `runGcPass` (`src/gc.ts:152-277`), the ONLY writer of `'reclaimable'` (`gc.ts:1-9`; sole write site `markPackReclaimable`, `packstore.ts:830-833`). Triggered by the DO alarm consumer (`maybeGcFromAlarm`, `src/repo.ts:551-583`) over the `gc_wanted_at` stamp — stamped by every RETIRED-producing compaction round (`repo.ts:467`) and every committed ref change (`control-plane.ts:749-756`) — with 30 s re-arm while pending (`GC_RETRY_MS`, `gc.ts:91`), or manually via `RepoCell.gcNow` (`repo.ts:619-629`). Both entry points sweep expired leases first (`repo.ts:388,624`), so a crashed holder's lease stops blocking within one pass; the alarm order is sweep → M2 gc → compaction → GC (`repo.ts:380-432`). |
| **Preconditions** | ALL re-evaluated inside ONE `transactionSync` per scan (`gc.ts:166-188`): (a) the row is still `retired` — state re-read in the txn (`gc.ts:170` via `catalogStateOf`, `packstore.ts:769-775`), covering the listing→txn window (the listing at `gc.ts:161` is outside the txn on purpose; a row that moved is skipped, not assumed); (b) the supersession premise verifies — `successorPremiseHolds` follows `superseded_by` TRANSITIVELY (bounded at depth 64, cycle-safe by construction) until it reaches an ACTIVE row; a chain that terminates in a missing row leaves the pack RETIRED as `premiseUnsafe`, retried next pass (`gc.ts:171-177,302-312`); (c) ZERO live read leases reference the pack — `hasLiveReadLeaseFor` (`read-leases.ts:120-126`) consulted in the same txn (`gc.ts:179`), so a lease registration/renewal cannot interleave between the check and the flip (same serialized DO). The flip itself is a guarded UPDATE `WHERE state='retired'` (`packstore.ts:832`) — idempotent under re-scan. |
| **Crash semantics** | The scan is ONE transaction: an isolate death mid-flip flips nothing (SQLite txn atomicity); the next pass re-runs the whole scan idempotently (spec §2 "sweeper converges by catalog state, never by assumption"). A crash between the flip txn and the delete phase leaves RECLAIMABLE rows — the delete phase is a separate loop and converges independently (see T3). A fabricated/corrupt `superseded_by` can never cause reclamation: the unverifiable chain stays RETIRED (`premiseUnsafe`). Pinned: check-gc §2 lifecycle (lease-blocked flips, then zero-lease flips, idempotent re-scan — `e2e/check-gc.mjs:412`), §2 successor premise (fabricated link stays RETIRED, flips once it holds — `check-gc.mjs:546`), §2 chained compactions (transitive walk through a retired successor — `check-gc.mjs:576`). |
| **Note** | A pack flipped RETIRED by a plan taken in the same instant stays protected: the plan registered racing the publish is exactly the "existing reader" of §2 — `readableCatalogKeys` includes RETIRED (`packstore.ts:661-679`), and the flip's zero-live-lease check runs in the same DO that inserted that lease (`read-leases.ts:164-206`). Pinned end-to-end: check-gc §7.1 — a real stream spanning publish, flips, R2 deletes and row removals never sees a deleted pack and the construction of the closing counter-example FAILS (`e2e/check-gc.mjs:757`). |
| **Pin** | check-gc §2 rows above; check-read-leases §6.6 GC substrate (`e2e/check-read-leases.mjs:269`); check-fault-matrix rows 2+12 (`e2e/check-fault-matrix.mjs:563` — every flip lease-blocked mid-transfer). |

### T3 — RECLAIMABLE→DELETED (GC delete)

| | As built |
|---|---|
| **Actor** | The second loop of the same `runGcPass` (`gc.ts:191-222`); the row removal is `deleteReclaimablePack` (`packstore.ts:845-858`) — the ONLY remover of catalog rows (`gc.ts:1-9`). Same triggers as T2. |
| **Preconditions** | (a) zero live read leases — checked AGAIN at the delete site, defensively (`gc.ts:198`): a live lease can never legitimately name a RECLAIMABLE pack (the flip required zero; new plans exclude RECLAIMABLE from `readableCatalogKeys`), so this re-check is the structural form of §7.2 fault C's never-grant-both (NOTICE.md:132); (b) an R2 DELETE ack BEFORE any catalog removal (`gc.ts:202-207`) — the `GcHost.deletePackObjects` adapter MUST throw when no R2 backend is bound (`gc.ts:103-109`; `repo.ts:589-597` throws; `maybeGcFromAlarm`/`gcNow` skip without the binding, `repo.ts:560-565,622`), so an ack means deleted and a host without R2 never reaches this transition; (c) row removal guarded `WHERE state='reclaimable'` inside ONE transaction with a state re-read (`gc.ts:218-220`; `packstore.ts:847-853`) — an already-moved/gone row removes nothing (idempotent). `location:'sqlite'` rows skip (a)/(b) entirely — they have no R2 bytes; their `pack_data` chunks die with the row (`packstore.ts:851-852`; divergence D5). |
| **Crash semantics** | **Window W1 — crash before/during the R2 delete** (partial batch: pack gone, idx not): row stays RECLAIMABLE, bytes partially in place; the retry deletes again — R2 DELETE of a missing object succeeds (idempotent) — then removes the row. Pinned: check-gc §2 crash mid-R2-delete (`e2e/check-gc.mjs:631`) and delete-failing-whole (`:667`); the full composition (REAL publish → first delete pass crashes mid-R2-batch → retry converges, successor stays ACTIVE and serves) is §7.2 row 5, `e2e/check-fault-matrix.mjs:716`. **Window W2 — crash after the R2 ack, before the row removal**: row RECLAIMABLE, bytes gone; the retry's delete trivially succeeds and the row is removed. Same pins. **A live lease appears between flip and delete**: the defensive re-check blocks the delete AND the row's renewal is rejected — never both granted (`gc.ts:198`; pinned: check-gc `:667` "a leased RECLAIMABLE row is never deleted AND its renewal is rejected"). Convergence is probed by catalog state after the pass (`gc.ts:261-264`), and a pass with pending work keeps the `gc_wanted_at` stamp and re-arms (`repo.ts:576-582`; pinned: check-gc RepoCell cadence, `check-gc.mjs:841`). |
| **Irreversibility** | RECLAIMABLE is terminal for readers: `renewAndAuthorizeRead` re-reads the readable set (active+retired) in the renewal txn and rejects a pack that left it (`read-leases.ts:289-293`; plan-level renewal kills the whole plan if ANY dependency left — `read-leases.ts:295-302`). The reader's posture is terminate-and-retry; re-marking readable would be an explicit recovery transaction, out of scope for v1 (spec §2). Pinned: check-read-leases per-pack/plan-level fault C (`e2e/check-read-leases.mjs:209,199`), fast-path fault A/C termination (`:506`), segmented fault-C mid-stream flip (`e2e/check-segmented-serve.mjs:419`). |
| **Pin** | check-gc §2 crash windows + RepoCell cadence; check-fault-matrix row 5. |

### Side ledger — clone-cache entries (§4.2; stateless, no catalog rows)

Clone-cache packs (keyed by `refs_version`) are not catalog rows; their GC is
LEASE-DRAIN-ONLY (`gc.ts:224-258`): an entry is deleted only when (a) its
version is no longer the current `reachableVersion()` (new plans can never
name it — `planCloneStream` keys on the current version) AND (b) no live
read lease (a `cache` lease; renewal checks membership only —
`read-leases.ts:74-85,236-238`) still reads it. In-flight streams are
additionally covered by the overlap argument (a delete racing a GET
completes or fails the fetch whole, never a false success — §4.2/§6.7), but
the lease gate keeps the common case off that argument. Foreign key shapes
parse to null and are never touched (`gc.ts:240-241`). Pinned: check-gc §4.2
drain (`e2e/check-gc.mjs:713` — current version never collected; stale entry
kept while its stream's lease is live, deleted after release; foreign shapes
untouched); OQ4 (version-window retention vs lease-drain-only) is recorded
STILL OPEN in the module header (`gc.ts:50-53`) — v1 adopted the
conservative half (spec §8 M3.4).

### Side ledger — read leases (the eligibility substrate)

The substrate all three transitions consult, with its own lifecycle
(also crash-relevant, hence listed):

| Event | Code | Crash semantics / pin |
|---|---|---|
| Plan+lease | `planFetch` — dependency-set SELECT + lease INSERT in ONE `store.tx` (`read-leases.ts:164-206`; default set = `readableCatalogKeys`) | Atomic: a GC transition serializes fully before (excluded from the set) or after (blocked). Pinned: `e2e/check-read-leases.mjs:130,150` (rollback proof). |
| Inline renewal | `renewAndAuthorizeRead` — all checks + extension in ONE txn (`read-leases.ts:242-310`); TTL 60 s, renew margin 30 s (`read-leases.ts:58,66`); every R2 GET segment passes it inline (`ReadGate`, `packstore.ts:35`; NOTICE.md:120-122) | Expired → rejected (fault A); pack left the readable set → rejected (fault C). Pinned: `check-read-leases.mjs:224,209,199`; `check-segmented-serve.mjs:283,296,311`; fault-matrix row 3 (`check-fault-matrix.mjs:662`). |
| Durability | Rows persist in DO SQLite (`read-leases.ts:25-27`) | DO restart preserves unexpired leases (fault B). Pinned: `check-read-leases.mjs:287` (file-backed SQLite restart). |
| Release | `releaseReadLease` — after the last R2 read, NOT the HTTP response lifetime (`read-leases.ts:314-327`) | Idempotent; post-release renewal rejected. Pinned: `check-read-leases.mjs:250,260,447`; fault-matrix rows 2+12 (`check-fault-matrix.mjs:563`). |
| Expiry sweep | expired rows dropped by `sweepExpiredLeases` / alarm ordering (`control-plane.ts:415-431`; `repo.ts:388`) | A crashed holder's lease dies within TTL and stops blocking T2/T3. Pinned: `check-read-leases.mjs:316`. |

## 4. Divergences — where code and SPEC disagree, or the SPEC is silent

This section is the review-facing point of the document. Items D1, D2, D6 are
already recorded in the spec's §8 as-built records (the §2/§5 normative text
was simply never updated to match); D3 WAS a genuine crash-semantics gap —
FIXED 2026-10-28 (keep-lease-row-on-failed-publish; see its entry); D4/D5 are
spec-wording mismatches with no code counterpart.

### D1 — §2's RETIRED→RECLAIMABLE precondition (b) cites a check that §6 does not define

The spec's normative table says the flip requires "zero live read leases AND
the receive-finalize premise check cannot need it **(§6)**"
(`specs/0011-compaction-gc.md:53`). §6 defines no such check — the closest
normative text is §5.4's finalize-window safety ("the DO rechecks that the
verification's dependency packs are still available"). The AS-BUILT guard is
neither: GC itself verifies the supersession chain transitively reaches an
ACTIVE row (`successorPremiseHolds`, `gc.ts:302-312`), while the
receive-finalize premise is the `store.has(tip)` probe inside finalize's own
commit transaction (`control-plane.ts:711-716`), which holds across T1 by
publish atomicity and needs no GC-side coordination. The §8 M3.4 record
documents the strengthening ("a direct-successor check would strand rows
forever…"; `specs/0011-compaction-gc.md:341-351`) — but the §2 table a
reviewer reads first still carries the stale pointer. Recommendation: amend
§2's precondition (b) wording to name the transitive supersession-chain
verification (spec edit; this unit does not edit specs).

### D2 — §5.2 step 4's "object-level truth does not move" vs the as-built re-point

Spec §5.2 step 4 publishes "new pack row ACTIVE, superseded inputs RETIRED,
`reachable`/`peeled` untouched (object-level truth does not move)"
(`specs/0011-compaction-gc.md:150-152`). As built, the publish RE-POINTS
every merged `pack_objects` row onto the successor (`packstore.ts:946-963`):
object-level *content* does not move (identical bytes re-served through the
successor) but index-row *attribution* moves wholesale — that re-point is
precisely what makes T2's premise walk and T3's "index rows are debris by
definition" cleanup (`packstore.ts:840-843`) true. The refs' `reachable`/
`peeled` columns are indeed untouched. The §8 M3.3 record documents the
guarded re-points (`specs/0011-compaction-gc.md:330-334`; NOTICE.md:126);
the §5.2 parenthetical reads as if index rows were copied rather than moved
and should be re-worded (recommendation only).

### D3 — FIXED: graceful error exits of T1 now keep the lease row so the sweep converges the orphan (was: stranding)

**Status: FIXED (2026-10-28, commit `6545edd`).** The original gap: the orphan convergence of
§5.3 ("prefix + catalog state converge; never assumed") is implemented as
**payload + catalog state** — the only sweeper that can delete an unpublished
compaction output is the compaction branch of `sweepExpiredLeases`, which acts
solely on an EXPIRED COMPACTION LEASE ROW's payload
(`control-plane.ts:415-431`, compaction branch `:423-429`: an output whose
catalog row does not exist has its pack + idx R2 keys deleted and the lease
row dropped; there is no prefix-scan sweeper for `repos/<key>/packs/` — the
only prefix purge is repo destroy). `runCompaction`'s
`finally { store.deleteLease(leaseToken) }` ran UNCONDITIONALLY, including on
the graceful failure exits: the publish's in-transaction lease-liveness
re-read refusing (`lease_lost`) and a failed/thrown R2 PUT after the pack
bytes landed. In both cases the catalog had no row, the sweep later found no
lease, and the bytes were unreachable by any sweeper until repo destroy. The
pinned crash window (isolate death — `deleteLease` stubbed to a no-op "so the
crashed state is faithful", `e2e/check-compaction.mjs` §5.3
crash-before-publish) was already the SAFE half of this posture.

**The fix** (orchestrator decision: keep-lease-row-on-failed-publish; NOTICE.md
2026-10-28): a `published` flag — set ONLY when the publish transaction
commits (`compaction.ts:216`, `:242`) — gates the release
(`compaction.ts:277`): the SUCCESS path deletes the lease exactly as before;
a FAILED round (lease_lost, a failed idx PUT after the landed pack PUT, a
thrown publish txn) KEEPS the row, whose payload is the orphan's only sweeper
pointer, so the existing expired-lease sweep removes the staged bytes + the
row within the TTL (`COMPACTION_LEASE_TTL_MS`, 10 min) — graceful failure is
now semantically identical to the already-pinned crash window. Until expiry
the live row defers later rounds (`compaction_in_flight`), exactly like a
crashed holder's.

**Pinned** (check-compaction §5.3 graceful failure exits,
`e2e/check-compaction.mjs:674` and `:723`): a graceful `lease_lost` round
(lease expired mid-round, NO crash — the publish refuses and RETURNS) and a
graceful mid-write failure (idx PUT throws after the pack PUT) each assert
the lease row SURVIVES with its payload naming the output keys and the
catalog + index rows byte-unchanged, then a sweep pass removes the staged
bytes + the row (idx absent in the partial-output case deletes fine) and the
next round succeeds. Mutation-tested: both checks FAIL against the pre-fix
unconditional `deleteLease`. The SPEC's §5.3 orphan bullet records the
as-built posture (`specs/0011-compaction-gc.md`, amended in the same change).

### D4 — "Partial multipart aborts" has no counterpart in the transition code

The spec's T3 crash-semantics cell and §5.3 both require "partial multipart
aborts must be recoverable" (`specs/0011-compaction-gc.md:54,163`). The
as-built GC delete path issues only plain `bucket.delete(keys)` of COMPLETED
objects (`gc.ts:207`; idempotent by R2 semantics — deleting a missing object
succeeds, relied on at `gc.ts:35-37`), and the packs layout contains no
multipart objects (multipart capture exists only on the receive STAGING
path, whose abort/sweep is owned by the receive-lease branch of
`sweepExpiredLeases` — `control-plane.ts:419-422` — outside this
lifecycle). The spec wording maps to no code in any transition; it is
either dead text or a requirement aimed at the receive path. Record-only;
no code change implied.

### D5 — `location:'sqlite'` rows take a different T3 with no R2 ack, and the SPEC is silent

Spec §2 notes sqlite-location packs participate as merge INPUTS (and
compaction always emits r2 outputs), but the T3 row of the spec table
speaks only of R2 DELETE acks. As built, a RECLAIMABLE sqlite-location row
skips the delete-ack gate entirely (`gc.ts:202`) and reaches DELETED by row
removal alone, its `pack_data` chunks deleted with it
(`packstore.ts:851-852`). Sound (there are no R2 bytes to outlive the row)
but unpinned: no check fabricates a sqlite-location row through T2/T3 (the
fork script fabricates one for rehydration, `e2e/check-fork-replicate.mjs`,
but never GCs it). Recommendation: a one-assertion append to check-gc
(sqlite-location row flipped and reclaimed, `pack_data` gone) if the
orchestrator wants T3 covered for both locations. Related open question Q3
(sqlite-row cleanup) remains open in spec §10 — the as-built answers it
implicitly here.

### D6 — Elaborations the spec table does not name (all recorded in §8, listed for completeness)

- The T1 publish re-guards compaction-lease liveness INSIDE the publish
  transaction (`compaction.ts:243-245`) — the spec's T1 cell does not
  mention the lease-loss window (its orphan window covers it incidentally;
  D3's graceful path now converges identically — see the D3 entry).
- The defensive zero-live-lease re-check before the T3 delete (`gc.ts:198`)
  — §7.2 fault C's never-grant-both made structural (NOTICE.md:132; §8 M3.4
  record `specs/0011-compaction-gc.md:349-351`).
- Renewal's STATE-AWARE non-member authorization: a live plan re-pointed by
  a T1 publish onto the ACTIVE successor (a pack its payload never named) is
  authorized because active packs are never reclaimable; every other
  non-member state rejects (`read-leases.ts:270-287`; §8 M3.3 record,
  `specs/0011-compaction-gc.md:335-338`; NOTICE.md:127). This is how §2's
  "RETIRED packs serve existing readers" invariant survives chained
  publishes.
- The successor-premise walk's transitivity itself (D1's as-built guard) and
  the in-transaction state re-reads covering every listing→write window
  (`gc.ts:158-170`) — §2's "converges by catalog state, never by assumption"
  states the property; the mechanism is these re-reads.

## 5. §7.2 rows 10 and 11 — status and the landed pins

Both rows were never claimed by the M3.5 as-built record (its audit covers
rows 1–5, `specs/0011-compaction-gc.md:375-412`). Status per the M3.5 state
assessment (`docs/research/spec-0011-m35-state.md:107-128`), restated here
with the pinning work as landed (both pinned 2026-10-28, see the Pinned
records below).

### Row 10 — stream prefetch probe ("nothing depends on pause-stops-I/O"): PINNED (2026-10-28, commit `849885e`; was structural, unpinned)

The design eliminated the assumption rather than testing it: reads are
explicit bounded R2 Range GETs, not stream-chunk pauses ("pausing
`reader.read()` does not provably stop underlying R2 I/O … no longer an
assumption we rely on", spec §4.1, `specs/0011-compaction-gc.md:109-113`).
The code path never pauses mid-read: every segment GET is an explicit
bounded aligned request issued only after a confirmed renewal. What exists:
check-segmented-serve asserts every GET is ≤ `SERVE_SEGMENT_BYTES` and
`PACK_CHUNK`-aligned (`e2e/check-segmented-serve.mjs:382,394-395,489`), and
check-fault-matrix row 1 exercises reads across a live publish. Nothing
asserts the negative ("no read path pauses and assumes I/O stops") as such.

Pinned (2026-10-28, commit `849885e`, `e2e/check-fault-matrix.mjs:823`,
engine source untouched) as the row-10 check, both prescribed halves: (a) the runtime
probe — a 74-object fixture (12 × 6 chunk-spread packed entries + loose
tree/commit, deliberately above one pull batch's 64-object bound so emission
is genuinely mid-stream) is read until the response's queue holds exactly one
unread batch frame (`desiredSize <= 0` — the actual stall: a ReadableStream
pulls eagerly only under its high-water mark, so with a frame pending the
emission loop never fires again); the virtual clock then blows past the
renew margin AND the whole 60 s lease TTL (17 s/call steps, then 120 s
pumps), and across a settle window of real event-loop turns the R2 GET count
and the lease-event timeline stay FROZEN (no background prefetch exists to
race GC — an EXPIRED mid-stream plan provably re-fetches nothing), the
stalled reader's lease stays live (GC protection persists through the
stall), and `reader.cancel()` releases it; every GET that did happen was
seam-guard verified (exactly-one live lease, plan member). (b) the tripwire
— a grep-level assertion inside the check over
`src/git/protocol.ts`/`src/git/packstore.ts` that no non-comment line
contains `pause()`/`releaseLock()` plumbing. (a) is the load-bearing half;
(b) is the tripwire, as prescribed.

### Row 11 — valid-but-incomplete pack ("server-side plan rejection is the contract"): PINNED (2026-10-28, commit `849885e`; was partial, unpinned)

No serve-side fixture constructs a pack whose checksum is correct but whose
negotiated-object closure is incomplete. What exists covers the
degenerate and receive-side cases: a want that is unreachable makes ZERO
plan RPCs (check-cache-unreachable G3, `e2e/check-cache-unreachable.mjs`,
19 checks incl. the capability row at `:283-301`), and the receive-side
analogue (newTip-exists-tree-missing → finalize rejects "missing necessary
objects", check-correctness-tier). The general case — want resolvable, one
closure object's bytes missing while the plan is being computed → the
SERVER-side plan/walk rejects before any byte ships — is unpinned.

Pinned (2026-10-28, commit `849885e`, `e2e/check-fault-matrix.mjs:917`): the row-11 check
drives the REAL `uploadPack` arm at BOTH failure depths of the one
corruption (closure bytes deleted from the R2 stub — packed storage has no
per-object R2 addressability, so the pack object holding the closure
entries' bytes is the deletable unit — with refs + index rows intact so the
want still resolves): (i) a closure TREE's bytes missing (the four-pack
fixture's PACK_D) → the closure walk inflates it mid-BFS and `uploadPack`
THROWS `missing R2 object` BEFORE `planFetch` — no Response ever exists
(zero bytes ship to a client; the walk's own inflation reads from the
INTACT packs are fine and asserted to never touch the missing pack), no
lease ever taken, zero live leases; (ii) closure BLOB bytes missing (the
union fixture's PACK_A — blobs are walk-membership-only, so the walk
passes) → the plan leases, emission starts, and the first missing read
errors the stream BEFORE the flush tail, with the error path releasing the
lease (§6.8's failure discipline: an aborted stream can never carry a
success-completing tail). Both depths are pinned because the prescription's
assertion list spans them: "the walk throws" happens pre-lease, "with the
lease released" is meaningful only post-plan — together they pin
"server-side plan rejection is the contract" with client validation as
defense-in-depth.

## 6. Open issues for the next wave

1. **D3 — RESOLVED (2026-10-28, commit `6545edd`)**: the T1 graceful-error
   orphan-stranding gap
   is fixed (keep-lease-row-on-failed-publish; `compaction.ts:216,242,277`) and
   pinned by the two §5.3 graceful-failure checks
   (`e2e/check-compaction.mjs:674,723`, mutation-tested) + the NOTICE.md
   deviation rows and the SPEC-0011 §5.3 as-built amendment. Nothing open.
2. **D1/D2**: §2/§5 normative-text amendments (spec edit; owner: the spec).
3. **Row 10/11 pins** (§5 above): RESOLVED (2026-10-28, commit `849885e`) —
   both landed as
   checks in `e2e/check-fault-matrix.mjs` (4 → 6 checks; the §5 Pinned
   records). The item's remaining housekeeping is ALSO closed: the three
   M3.5 scripts were added to `packages/git-engine/e2e/README.md`'s script
   list by `f9a63ec` (the check-fault-matrix / check-correctness-tier /
   check-capability-matrix section). Nothing open.
4. **OQ4** (clone-cache retention policy) and **Q3** (sqlite-row cleanup)
   remain open in spec §10; the as-built postures are lease-drain-only and
   row-removal-with-`pack_data` respectively (§3 side ledger, D5).

# M3 design inputs — external review constraints (compaction/GC)

Constraints and invariants collected from the external architecture review
(2026-10-24, three rounds). The M3 compaction/GC design and its reviewer-facing
documents (state-transition table, schema, publish ordering, GC triggers) MUST
answer every item here; the closing counter-example is the acceptance gate.

## Invariants (adopted verbatim)

1. **Ref closure availability**: `∀ r ∈ Refs: Closure(r) ⊆ AvailableObjects`,
   where Available = the object is readable, verified, and parseable from R2 —
   not merely present as an index row.
2. **Induction premise stability**: "closure validated at its own push" holds
   only while storage never removes ref-reachable objects — GC/compaction/
   re-index must preserve this across their transitions.
3. **Separated read invariants** (not interchangeable):
   a. catalog-switch atomicity — no single DB read sees a partial update
      (single DO SQLite transaction);
   b. fetch-plan validity — every pack referenced by an in-flight plan stays
      readable for the plan's lifetime, even if the plan spans catalog
      generations (mixed-generation plans are legal; each location must be).
4. **Finalize-window safety**: the Worker-side closure verification
   (M2 Step 2) → DO finalize window must not be invalidated by concurrent
   compaction/GC. Mechanism: per-repo leases exclude compaction while a
   receive lease is live (leases.kind already reserves 'compaction'); the DO
   rechecks at finalize that the verification's dependency packs are still
   available (premise check, not version compare — an unrelated pack add
   must not invalidate a verification).

## Pack lifecycle (four states, adopted)

ACTIVE (referable by new plans) → RETIRED (no new plans; existing readers
continue) → RECLAIMABLE (no live read leases depend on it) → DELETED (R2
object gone, catalog cleaned). Fixed grace periods are INSUFFICIENT for
streaming fetches: response wall time is unbounded (slow client + network
backpressure), so bytes/CPU bounds do not bound read duration.

## Read leases (the chosen mechanism)

- Fetch plans are **DO-issued**: catalog read + lease registration in ONE DO
  transaction (atomic — closes the register-after-check race).
- Leases carry expiry + renewal. Renewal point: the Worker's sideband
  re-framing loop executes continuously while streaming — renew per N bytes
  or T seconds at chunk boundaries (no extra RPC traffic shape).
- GC deletes a RETIRED pack only when zero live leases reference it.
- Lease expiry mid-stream: the reader must stop using the old plan —
  either replan (only at a safe boundary: before any byte of that pack was
  sent) or terminate the response (client retries the fetch; git protocol
  tolerates a failed fetch and re-fetches). Mid-pack resume-from-byte-offset
  is NOT required for v1 — document the terminate-and-retry choice.

## Compaction publish ordering (crash-safe)

write new pack to R2 → single-txn catalog publish (supersede old = RETIRED,
activate new) → lease-gated delete of RETIRED. Crash windows: new pack
written but catalog unpublished = orphan (sweepable, safe); old pack is never
deletable before its successor's catalog publish. Deleting an R2 object
mid-way (multipart abort / partial delete) must be idempotent-recoverable;
the sweeper converges by prefix + catalog state, not by assumption.

## Acceptance gate (the reviewer's counter-example)

Construct (or prove impossible): every individual transaction succeeds, every
Worker obeys its protocol, every R2 operation succeeds — and yet a concurrent
fetch reads a pack that was legally GC'd. The lease design intends the proof:
plan+lease are atomic in the DO; GC delete requires RETIRED ∧ zero live
leases; therefore a pack being read has a live lease and cannot be deleted.
The M3 fault-injection suite must attempt this history explicitly, alongside:
fetch×compaction concurrency, slow-client (throttled) fetch during GC,
lease-expiry mid-stream, compaction crash before/after publish, delete crash
mid-R2-operation.

## CI test-matrix additions (correctness tier)

99/101 MB boundary pushes (decimal), newTip-exists-tree-missing injection,
finalize-success-response-lost retry convergence, fetch×compaction race,
full clone with cross-pack delta bases, incremental fetch relying on
REF_DELTA + negotiated haves.

## Round-4 additions (lease-expiry vs R2-delete protocol)

**Accepted counter-example (renewal in flight, lease expired)**: "periodically
sending renewals" ≠ "holding a valid lease" — GC may observe zero live leases
while a renewal RPC is still in flight, delete the pack, and the reader then
reads a deleted object with no component having violated the (implicit,
under-specified) protocol.

**v1 property choice: SAFETY (its Proposition A), not availability.** Any
successfully completed fetch has complete, parseable, protocol-valid output;
lease failure or object unavailability must never be reported as success.
Rationale: git clients already verify packs end-to-end (index-pack rejects
truncated/missing-object packs), so safety is doubly guaranteed (our abort
discipline + protocol-level client verification). Availability-under-GC (B)
is explicitly NOT promised in v1.

**Read-safety protocol (closes the counter-example deterministically)**: no
R2 GET segment may start without a lease whose expiry the Worker has
CONFIRMED covers the segment. The re-framing loop awaits the renewal RPC
inline before pulling the next chunk (the Worker paces the stream, so a
slow renewal back-pressures the client instead of racing GC); a rejected or
expired renewal aborts the response (terminate-and-retry posture). Fencing
tokens are honest about their boundary: R2 does not check DO tokens — the
Worker's pre-read check is the enforcement point, which is sufficient under
Property A (a missed check can fail a fetch but cannot corrupt one).

**Lease durability & state rules**: read leases persist in DO SQLite (the
leases table); DO restart preserves unexpired leases; renewal and GC
eligibility evaluate in the same serialized control domain; RECLAIMABLE is
irreversible in v1 (a late renewal for a RECLAIMABLE pack is rejected →
reader aborts; re-marking readable requires an explicit recovery
transaction, out of scope); R2 DELETE failures retry idempotently.

**Two-proposition acceptance (verbatim from the review)**:
- Safety invariant: any successful fetch's output object set is complete,
  parseable, and Git-pack-protocol-valid; lease expiry or unavailability is
  never reported as success.
- GC isolation invariant: while a valid read authorization protects a
  fetch's dependency set, GC must not make those packs unavailable.

**Fault-injection additions**: (A) renewal-late — delay DO processing so GC
pre-empts; assert renewal rejected, reader abandons the plan; (B) DO restart
mid-fetch — assert unexpired leases still block deletion; (C) delete vs
renewal race — GC pauses at RECLAIMABLE before R2 DELETE; assert the system
never grants both the renewal and the delete.

## Round-5 additions (final): read-protection precision

**Accepted residual window**: inline renewal proves `t_GET-start < t_expiry`,
not `t_GET-end < t_expiry`. The v1 safety proposition is therefore REWORDED:
we do NOT prove "R2 reads never overlap legal GC deletes"; we prove "any
overlap never produces a wrongly-successful fetch". A GET spanning lease
expiry either completes (fine) or fails (whole-fetch failure, never false
success). Renewal-confirmed and read-fully-protected are two separate
propositions; v1 claims only the first + the overlap-safety rewording.

**Read segments are explicit R2 Range GETs, not stream chunks.** Pausing
`reader.read()` does not provably stop underlying R2 I/O (prefetch/buffer) —
we no longer rely on that assumption. Two serve paths, both defined:
- segmented (multi-pack union): per-entry bounded Range GETs, each triggered
  after a confirmed `renewAndAuthorizeRead` (the reviewer's readPackRange
  sketch is the reference shape); segment sizes bounded for the 128 MiB
  isolate.
- fast path (whole-pack clone-cache stream): ONE long-lived GET; the lease
  covers the entire stream duration; if a concurrent delete truncates it,
  the fetch fails whole — Property A holds, availability for that path
  relies on clone-cache packs being immutable (they are: keyed by
  refs_version, deleted only with the version they serve — GC of a
  clone-cache entry makes future plans not reference it, in-flight streams
  are the only readers, and the same overlap-safety covers them).

**Server owns negotiated closure (correction to our index-pack claim)**:
`SuccessfulFetch ⇒ ValidPack ∧ ValidNegotiatedObjectClosure` — the closure
is guaranteed SERVER-side by the serve plan's wants−haves closure walk (the
same closure machinery receive validation uses); the client's connectivity
check is defense-in-depth, not the guarantee (a self-consistent pack
missing negotiated objects may pass bare pack verification on some
client paths — shallow boundaries). Failure discipline: fetch "success" is
structural — full data, then checksum trailer, then flush; an aborted or
truncated stream can never carry a success-completing tail.

**Lease release semantics**: leases protect R2-read dependency, NOT the
HTTP response lifetime. Release when "all dependent R2 reads completed AND
no future reads will target the protected packs" — for segmented serve,
after the last Range GET; for the fast path, at stream end. This decouples
GC from slow-client transfer (buffered bytes need no pack protection).

**Round-5 fault-injection additions**: GET spanning lease expiry (start
before, end after — assert complete-or-fail, never false success); stream
prefetch probe (assert nothing depends on pause-stops-I/O); valid-but-
incomplete pack (correct checksum, missing negotiated objects — assert
server-side plan rejection OR client connectivity rejection; server-side
is the contract); early lease release (last R2 read done, HTTP still
sending — assert GC may reclaim and the fetch still completes correctly).

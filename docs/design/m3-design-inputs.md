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

## Round-6 additions: fetch protocol correctness as its own acceptance line

**Two-layer success (adopted)**: `ServerSuccess = ValidNegotiatedObjectClosure
∧ CompletePackEmission ∧ ValidProtocolTermination`; `ClientSuccess =
ServerSuccess ∧ ClientValidation` (end-to-end goal; server cannot observe
client validation). The structural tail (data+checksum+flush) proves
transport/format only — a complete, checksummed stream CAN be semantically
wrong if the PLAN is wrong; plan correctness is the load-bearing half.

**clone-cache responsibility split**: immutability (refs_version keying)
guarantees content-version correctness; read-lease/abort-on-failure
guarantees safety under concurrent deletion. Different jobs, both required.
**Hit condition is exact-full-clone ONLY** (already the design): wants ==
current tips ∧ no haves ∧ done ∧ no shallow ∧ no filter — any other
negotiation shape takes the segmented planning path and never touches the
cache. The M4 cache work must ship this hit-condition as code + the
reviewer's mismatch test matrix (depth=1, filter=blob:none, different
wants, different capabilities, stale-version-no-false-hit). "Full pack is a
superset" is NOT an acceptable hit rationale — shallow/filter semantics
change the client's interpretation of boundaries and missing objects.

**Closure policy separation (formalized)**: `validateReceiveClosure()`
(prove new refs' closure exists complete) vs `planNegotiatedFetchClosure()`
(determine the send set under negotiation semantics: haves/common
ancestors, shallow boundaries, filters, thin bases, tag peeling, format).
Shared graph primitives; DIFFERENT boundary conditions. Partial-clone
omissions and shallow-outside boundaries are NOT missing objects.

**Capability matrix (required deliverable)**: current serve surface — v0
and v2 fetch, shallow/deepen/unshallow (e2e-green), sideband-64k; filter
(partial clone) is NOT advertised → clients decline gracefully to full
transfer (explicit non-support, not wrong-support). The matrix ships with
M3/M4 docs; unadvertised-and-rejected beats plausible-but-wrong.

**Round-6 tests (top priority)**: the six-row cache-mismatch matrix above.

**Next review agenda (code-level, four artifacts)**: fetch planning entry
(wants/haves/shallow/filter/capability parsing), clone-cache hit predicate,
the R2 read + sideband re-frame loop ordering (get → read → renew → emit →
fail-stop), and the GC RETIRED→RECLAIMABLE transaction with renewal race.

## Round-7: code-level findings (three artifacts read)

1. **Cache stores RAW pack bytes; framing regenerated per request** —
   streamingCloneResponse emits `v2 ? "packfile\n" : "NAK\n"` at serve time,
   then sideband-frames pack chunks; error path `ctrl.error` (stream error =
   truncated fetch), FLUSH+close only on reader completion (structural
   success). The reviewer's CachedClonePack boundary matches reality.
2. **Hit predicate is SEVEN conditions at the call site** (mod.ts
   serveCloneFromR2): wants>0 ∧ all-OIDs ∧ haves=0 ∧ done ∧ deepen=0 ∧
   clientShallows=0 ∧ protocol-shape guard (`v2 fetch command OR
   side-band-64k` — v0-without-sideband never hits the cache). Stronger
   than the five previously described. wantsAreAllTips = strict set
   equality against ALL refs — no per-ref visibility exists today
   (repo-granular ACL); SPEC-0003 hidden-refs becomes a documented
   predicate constraint when it lands.
3. **NormalizedFetchRequest effectively exists** (UploadRequest struct) —
   the predicate reads the struct, not raw pkt-lines. Reviewer's
   recommendation already implemented in shape.
4. **BUG FOUND (reviewer's predicted class)**: parseUploadRequest handles
   only `deepen <n>`; `deepen-since`/`deepen-not`/`deepen-relative` fall
   through the else-if chain and are silently DROPPED — while the v2
   advertisement's `shallow` capability implies the whole deepen family.
   `git fetch --shallow-since` silently receives a full clone with no
   shallow boundary: valid pack, valid checksum, WRONG semantics.
   **Fix direction**: parse the deepen-family args; respond with an
   explicit ERR (v2 permits server-side error) or implement them — never
   silently ignore. e2e addition: --shallow-since must fail cleanly (or
   behave correctly), never silently return a non-shallow result.
   Ownership: next engine wave (with the LIFECYCLE gap list).
5. Narrow note: v2 packfile section framed in sideband unconditionally —
   valid for stock git (always requests sideband when advertised, e2e
   green); a non-sideband v2 client is outside the tested envelope —
   document the assumption in the capability matrix.

## Round-8: the forbidden pattern + P0 stopgap (dispatched)

**Forbidden pattern (CI-enforced from now on)**: protocol parser silently
ignoring unknown semantic input → normalized request losing constraints →
cache predicate misjudging → format-valid, semantics-wrong response. The
deepen-family bug is its first instance; the parser must be fail-closed
(phase-aware: capability/command/section lines exempt; unknown FETCH
arguments rejected with protocol-shaped errors, never dropped, never 500).

**Ordering constraint**: Parse → ValidateCapabilities → Normalize →
Authorize → Plan/CacheHit → Emit — semantics-affecting fields MUST be
resolved before Plan/CacheHit (an error after output starts can only
abort; an error after a cache hit may be too late).

**Correction accepted**: "advertising shallow promises the whole deepen
family" was overclaimed — the universal principle is the stronger rule:
any uninterpretable semantics-changing parameter must never be silently
ignored into success. Persistent rejection of advertised standard
features is a transitional state only, not a compatible end-state.

**Consistency gate**: `AdvertisedFeature ⇒ ParsedAndHandled` (Handled =
correct execution or explicit protocol rejection; never silent drop) —
the capability matrix becomes test-generated, not hand-maintained.

**Regression matrix (param-level, not just one e2e)**: deepen<n> correct;
deepen-since/-not/-relative correct-or-explicit-reject; shallow<oid>
recognized; filter never silently accepted when unadvertised; unknown
fetch args rejected; combinations must not poison the clone-cache —
especially deepen-since + no-haves + wants=allTips. Plus cheap
differential testing: same repo, same git CLI commands, vs a real Gitea
instance; diffs must be explainable by declared compatibility rules.

**P0 dispatched**: the stopgap + fail-closed dispatch + ordering assertion
+ poisoning-combo tests went into the in-flight engine wave's landing
gates (ownership respected — the wave owns those files).

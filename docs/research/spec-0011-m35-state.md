# SPEC-0011 M3.5 state assessment — 2026-10-28

Read-only verification unit. Purpose: establish the TRUE state of SPEC-0011's
M3.5 milestone, because the specs ledger still reads "M3.5 in flight"
(`specs/README.md:47`) while the spec's own as-built record claims completion.
Method: static analysis only — no test runs, no builds; evidence is git
archaeology (`git show` / `git log`), file reads, and the committed 2026-10-26
health sweep. Tree state at assessment: HEAD `4d039cb`; **no commit has
touched `packages/git-engine/` since `bff7fdc`** (2026-10-26 20:58), the HEAD
the health sweep ran at — so every sweep verdict below is still valid at
current HEAD (verified: `git log bff7fdc..HEAD -- packages/git-engine` is
empty).

**Verdict (one line): PARTIAL — but only against §9's full milestone text;
every deliverable the ledger names as "in flight" is LANDED, COMMITTED
(157e74e), independently re-verified green (16 scripts / 269 checks,
2026-10-26 sweep), and already recorded in §8 — the ledger line is stale by
three days; the sole genuinely absent §9 clause is the "review-facing
state-transition table regenerated from code", plus two soft §7.2 rows (10,
11) nobody has ever claimed.** If the orchestrator formally descopes the
table, the verdict degrades to COMPLETE-BUT-UNRECORDED and only the ledger
line changes. Details and the exact update text in §5–§6 below.

## 1. What M3.5 promised (the spec text)

Three places define the deliverables; they are not identical in scope, which
is the root of the ambiguity.

**§7.2 fault-injection matrix** (`specs/0011-compaction-gc.md:218-233`) — a
12-row table of fault/ asserted-outcome pairs ("rounds 4–6 additions"). Rows
1–5 (fetch × compaction concurrency; slow-client fetch during GC; lease
expiry mid-stream; compaction crash before publish; crash after publish,
mid-delete), rows 6–8 (faults A/B/C: renewal-late; DO restart mid-fetch;
delete-vs-renewal race), rows 9–12 (GET spanning lease expiry — "complete-or-
fail, never false success"; stream prefetch probe — "nothing depends on
pause-stops-I/O"; valid-but-incomplete pack — "server-side plan rejection is
the contract"; early lease release — "GC may reclaim; the fetch still
completes correctly"). §7 frames the whole suite as "the acceptance gate",
run in "the engine e2e harness (real DO + R2 local, fault injection at
RPC/IO seams)" (`specs/0011-compaction-gc.md:204-208`).

**§7.3 CI additions, correctness tier** (`specs/0011-compaction-gc.md:235-244`):
99/101 MB boundary pushes; newTip-exists-tree-missing injection;
finalize-success-response-lost retry convergence; full clone with cross-pack
delta bases; incremental fetch on REF_DELTA + negotiated haves; the six-row
clone-cache mismatch matrix; "capability matrix **test-generated**
(`AdvertisedFeature ⇒ ParsedAndHandled` — round 8's consistency gate; never
hand-maintained)"; "cheap differential testing vs a real Gitea instance
(diffs explainable by declared compatibility rules)".

**§9 milestone M3.5** (`specs/0011-compaction-gc.md:286-288`) — FOUR clauses:
"fault-injection suite (§7) + test-generated capability matrix + differential
harness; **the review-facing state-transition table regenerated from code**."

## 2. Deliverable-by-deliverable mapping to tree reality

### D1 — §7.2 fault-injection matrix: EXISTS-COMPLETE for rows 1–5 (the M3.5 scope), rows 6–9/12 landed earlier, rows 10–11 soft

The dedicated harness exists: `packages/git-engine/e2e/check-fault-matrix.mjs`
(778 lines, landed in 157e74e). Its header (lines 8–47) is a written per-row
audit mapping every row to "landed check" vs "added here", and its four checks
are row-labeled at the assertion site:

- `check-fault-matrix.mjs:489` — row 1: a REAL `runCompaction` publish lands
  MID-STREAM between segment GETs; "both succeed, seam guard holds across the
  publish, closure byte-identical".
- `check-fault-matrix.mjs:563` — rows 2+12: a GC pass MID-TRANSFER is fully
  lease-blocked; release lands at the last R2 read; GC reclaims while the
  response still drains and the drain delivers its flush tail.
- `check-fault-matrix.mjs:662` — row 3: deterministic clock crosses the TTL
  between segments; inline renewal REJECTED; stream errors BEFORE the flush
  tail; plan released.
- `check-fault-matrix.mjs:716` — row 5: REAL publish → GC delete crashes
  mid-R2-batch → retry converges idempotently; successor ACTIVE and serving.
- Row 4 was landed by APPENDING its missing assertion ("fetches unaffected")
  to the existing check-compaction §5.3 orphan-sweep check (157e74e stat:
  `check-compaction.mjs +11/-1`; the M3.5 §8 record,
  `specs/0011-compaction-gc.md:399-404`, describes exactly this append).

That is 4 checks in the new script + 1 append — matching the §8 record's
per-script totals ("fault-matrix 4", compaction stays 8,
`specs/0011-compaction-gc.md:486-489`) and the independent sweep
(`docs/research/engine-e2e-health-2026-10-26.md:43,41`).

Rows 6–8 (faults A/B/C) predate M3.5 and are documented in NOTICE.md:
fault A expired-renewal rejection + fault C reclaimable rejection per-pack and
plan-level (`packages/git-engine/NOTICE.md:118`, check-read-leases), fault B
DO-restart survival — "unexpired leases survive, still block deletion, renewal
still authorized" (`NOTICE.md:118`), fault C's never-grant-both also
structural in GC's defensive zero-lease re-check before delete
(`NOTICE.md:132`; spec §8 M3.4 record, `specs/0011-compaction-gc.md:349-351`).
Row 12's release-semantics half is pinned in check-read-leases §4.2/§3.4 per
the M3.5 record (`specs/0011-compaction-gc.md:386-388`) and overlapped onto
the fault-matrix timeline (cite above).

Row 9 (GET spanning expiry — complete-or-fail, never false success): the
FAIL leg is pinned at three assertion sites —
`packages/git-engine/e2e/check-segmented-serve.mjs:419` (§7 fault C
mid-stream flip: "aborts before the flush — terminate-and-retry, never false
success"), `check-read-leases.mjs:405` (emission failure releases + errors:
"Property A, never false success"), `check-read-leases.mjs:506` (§3.3 fast
path fault A/C: rejected renewal terminates — "never a false success") — and
the COMPLETE leg (GET spanning expiry that succeeds cleanly) is exercised by
the §7.1 counter-example stream in check-gc (spec §8,
`specs/0011-compaction-gc.md:356-361`). No check is NAMED "row 9"; coverage is
by composition. Verdict for the row: holds, pinned indirectly.

Row 10 (stream prefetch probe — "nothing depends on pause-stops-I/O"):
**EXISTS-STRUCTURALLY, no explicit probe.** The design eliminated the
assumption itself — reads are explicit bounded R2 Range GETs, "NOT
stream-chunk pauses — pausing `reader.read()` does not provably stop
underlying R2 I/O … no longer an assumption we rely on"
(`specs/0011-compaction-gc.md:110-112`), and check-segmented-serve asserts
every segment is an explicit bounded aligned GET (NOTICE.md:123). Grep for
`prefetch`/`pause-stops` across `packages/git-engine/e2e/*.mjs` finds no
dedicated probe test. Nothing false can depend on the abandoned assumption
because the code path never pauses mid-read — but if the orchestrator wants
the matrix literally closed row-by-row, this is the thinnest row.

Row 11 (valid-but-incomplete pack → server-side plan rejection): **EXISTS-
PARTIAL.** No serve-side fixture constructs a pack with a correct checksum
whose negotiated-object set is incomplete. What exists: the degenerate case
(an unreachable want makes ZERO plan RPCs — `check-cache-unreachable.mjs`,
the G3 direct-evidence gate, 19 checks) and the receive-side analogue
(newTip-exists-tree-missing in check-correctness-tier, below). The general
"want resolvable except one closure object missing → plan rejects" case is
unpinned. Note: the M3.5 §8 record never claims row 11 either — it audits
rows 1–5 only (`specs/0011-compaction-gc.md:375`).

### D2 — Test-generated capability matrix: EXISTS-COMPLETE

`packages/git-engine/e2e/check-capability-matrix.mjs` (550 lines, landed in
157e74e). Header (lines 1–18): "the advertised-capability table is derived
from the LIVE handshakes — v0 upload-pack, v0 receive-pack and protocol-v2
(`advertisement()` over a real store) — and every advertised feature is
mechanically required to map onto a REGISTERED PROOF … A future edit that
advertises a capability without a handler proof FAILS this check". This is
exactly §7.3's "`AdvertisedFeature ⇒ ParsedAndHandled` … never
hand-maintained" gate. 18 checks, independently verified green
(`docs/research/engine-e2e-health-2026-10-26.md:39`), with the contrapositive
pins (filter never advertised, rejected in v0 and v2; unknown args fail
closed) recorded in the §8 record
(`specs/0011-compaction-gc.md:463-483`). VERDICT: EXISTS-COMPLETE.

### D3 — §7.3 correctness-tier additions: EXISTS-COMPLETE

`packages/git-engine/e2e/check-correctness-tier.mjs` (879 lines, landed in
157e74e). Header (lines 1–33) enumerates all five primary items and states
the audit finding ("None of these existed as automated checks before M3.5");
it drives the REAL Worker-side receive flow (`createDurableGit().fetch`,
real `parsePushRequest`/`stagePack`/scan/`finalizeReceive`) with real `git`
as the serve oracle. 7 checks, verified green
(`docs/research/engine-e2e-health-2026-10-26.md:42`). The six-row
clone-cache mismatch matrix is closed across existing scripts with the
capability row appended at `check-cache-unreachable.mjs:283-301`
("planCloneStream RPC called ZERO times for a non-side-band clone"; script
now 19 checks per the sweep, line 38), and the per-row where-lived mapping is
in the §8 record (`specs/0011-compaction-gc.md:444-457`). VERDICT:
EXISTS-COMPLETE. (One pedantic note: §7.3 says "99/101 MB"; the as-built
pins the contract size-parametrized at 1 MiB because the ~100 MB cap is the
Cloudflare PROXY's, documented at `specs/0011-compaction-gc.md:420-429` — an
amended interpretation, recorded, not a silent divergence.)

### D4 — Differential harness / wiring: EXISTS-COMPLETE (pre-existing; correctly claimed as "nothing added")

`scripts/diff-test.mjs` + `scripts/diff-cases/` (7 files: index, seed,
cases-read, cases-write, cases-protocol, cases-push, rules.mjs + README.md)
exist. The declared-rules requirement is real:
`scripts/diff-cases/README.md:1-8` — "every legitimate divergence must be
covered by a rule in `rules.mjs`, anything else is UNEXPLAINED and fails
`--compare`". CI wiring exists: job `diff-battery` at
`.github/workflows/ci.yml:410-445`, ours-only with the exit code as the whole
gate, and the ci.yml comment (lines 404-409) records the 2026-10-25
no-egress attempt that made the theirs half manual. Landed BEFORE M3.5:
48903f8 (2026-10-24 21:27, "differential harness — ours/theirs git-CLI
battery (10 cases)") and ec5f7c9 (2026-10-25 08:11, "battery expansion … +
capability-matrix dump + rules (Round-8)"). The M3.5 §8 record says exactly
this: "the harness and battery were already landed outside the engine …
nothing added here" (`specs/0011-compaction-gc.md:458-461`). VERDICT:
EXISTS-COMPLETE, accurately recorded. (Residual known limitation, already
recorded: the `--theirs` run against a real Gitea instance is
manual/local-only for lack of CI egress — an environmental constraint, not
missing work.)

### D5 — "Review-facing state-transition table regenerated from code": ABSENT

The §9 M3.5 clause (`specs/0011-compaction-gc.md:287-288`) has no artifact
anywhere:

- The only state-transition table in the repo is the hand-written §2 table in
  the spec itself (`specs/0011-compaction-gc.md:40-54`), drafted 2026-10-24 —
  not "regenerated from code".
- `docs/design/` contains only m3-design-inputs.md (which DEMANDS the
  reviewer-facing documents answer its items — `docs/design/m3-design-inputs.md:4-6`),
  the P0 evidence package, and no lifecycle table
  (greps for `state-transition`/`RETIRED` across `docs/` hit only the inputs
  doc, the P0 deep-dive bug file, release notes, and the UI parity survey —
  none is a regenerated table).
- `docs/research/` has no such document (file listing verified).
- The §8 M3.5 record does NOT claim it — its scope line is "the acceptance-
  hardening tail — §7.2 rows 1-5 completed, §7.3's correctness-tier additions
  … and the capability matrix" (`specs/0011-compaction-gc.md:366-368`). So
  the record is honest; the milestone definition simply has an unmet clause.
- The check scripts do not print or regenerate such a table either (grep for
  `transition` in e2e hits only an unrelated assertion title in
  check-compaction.mjs:439).

VERDICT: ABSENT. Nothing references, plans, or half-built it — it was dropped
on the floor between the §9 milestone text and the as-built record.

## 3. §8 as-built records vs the ledger — the staleness question

The §8 M3.5 as-built record is COMMITTED, and it landed in the SAME commit as
the code it records: **157e74e** ("test(engine): M3.5 — fault-injection
matrix completed + test-generated capability matrix (SPEC-0011 §7 gate)",
2026-10-25 15:50:15 +0800) — 6 files: the three new scripts, the two appended
scripts, and `specs/0011-compaction-gc.md` (+130 lines, i.e. the entire M3.5
as-built entry). The spec file also carries, since that commit, the banner
"**Implementation milestones M3.0–M3.5 COMPLETE (2026-10-25)**"
(`specs/0011-compaction-gc.md:364`) and the record's own gate statement:
"Gates observed with my own eyes: all 15 scripts green" with per-script
totals (`specs/0011-compaction-gc.md:485-489`). A follow-up docs commit
84cf4c9 annotated the post-M3.5 count growth (16 scripts / 269 on disk;
`specs/0011-compaction-gc.md:369-373`).

Independent verification: the committed 2026-10-26 health sweep ran all 16
scripts at HEAD bff7fdc — 269/269 green, with per-script counts IDENTICAL to
the M3.5 record for all 15 M3.5-era scripts and zero drift
(`docs/research/engine-e2e-health-2026-10-26.md:8-12,33-53,55-61`). The
engine has had zero commits since (verified empty `git log bff7fdc..HEAD --
packages/git-engine`), so that verdict stands at today's HEAD 4d039cb.

Meanwhile the ledger says: "M3.5 in flight (§7.2 fault-injection matrix +
test-generated capability matrix + differential wiring)"
(`specs/README.md:47`) and the TIER-2 progress line lists "SPEC-0011 M3.5
acceptance-hardening tail" among in-flight waves (`specs/README.md:24`).
Both are STALE — written before 157e74e (2026-10-25 15:50) and never
revisited. The ledger even contradicts the spec it indexes, whose own §8
record and banner claim completion.

Answering the brief's named commits: 53fc835 is the M3.4 as-built docs commit
("§7.1 counter-example failed to construct (the gate)", 2026-10-25 14:00,
`specs/0011-compaction-gc.md` +27) — the §7.1 gate, not M3.5; 2fce4cd is the
content-path lease coverage ("closes M3.2's known gap", 2026-10-25 15:39, 5
engine files) — a pre-M3.5 tail with its own §8 record
(`specs/0011-compaction-gc.md:495-512`). Neither is the M3.5 landing; 157e74e
is, and the ledger never named it.

## 4. Archaeology notes (NOTICE.md and deviations)

- `packages/git-engine/NOTICE.md` carries per-milestone entries for the M3.1
  leases substrate (line 112, incl. the schema NOTE that read leases needed NO
  migration step) and the M3.4 gc.ts semantics (line 132, incl. OQ4
  clone-cache retention recorded STILL OPEN in the module header). No
  M3.5-specific NOTICE entry exists — correct, since the three new files are
  NEW e2e checks, and NOTICE's convention is to log source deviations; the
  e2e corpus is described in `packages/git-engine/e2e/README.md` instead.
  That README, however, was last updated by 2fce4cd and does NOT list the
  three M3.5 scripts (grep count 0 for all three names) — a small doc gap.
- One recorded workspace-level deviation in the M3.5 record: the workspace
  `pnpm typecheck` failure at commit time was a SIBLING WAVE's mid-flight
  apps/worker change (untracked pull-reviews.test.ts), explicitly declared
  outside engine ownership (`specs/0011-compaction-gc.md:489-493`). Nothing
  relevant to M3.5 is buried there.

## 5. Exact ledger updates (required regardless of verdict)

1. `specs/README.md:47` — replace the trailing clause
   `M3.5 in flight (§7.2 fault-injection matrix + test-generated capability matrix + differential wiring)`
   with, e.g.:
   `M3.0–M3.5 COMPLETE (M3.5 acceptance-hardening tail 157e74e, 2026-10-25: §7.2 rows 1-5 via check-fault-matrix.mjs 4 checks + the row-4 append to check-compaction, §7.3 correctness tier as check-correctness-tier.mjs 7 checks, capability matrix TEST-GENERATED check-capability-matrix.mjs 18 checks; 15 scripts / 260 checks green at the gate, re-verified 16/269 by docs/research/engine-e2e-health-2026-10-26.md; differential pre-existing — scripts/diff-test.mjs + CI diff-battery, ours-only. Residual: §9's review-facing state-transition table regenerated from code remains ABSENT — specs/0011 §7.2 rows 10-11 hold structurally/partially, unpinned by dedicated checks)`
2. `specs/README.md:24` — drop `SPEC-0011 M3.5 acceptance-hardening tail` from
   the "In flight at this writing" list.

## 6. Remaining-work brief (if the orchestrator closes M3.5 properly rather than descoping)

One S-sized unit, single owner, no dependencies (engine is frozen; this is
docs + one optional check append; nothing else in flight owns these paths):

1. (S) Write the review-facing state-transition table regenerated from code —
   the one genuinely absent §9 deliverable. Suggested shape: a
   `docs/design/m3-state-transitions.md` whose four-state table (ACTIVE/
   RETIRED/RECLAIMABLE/DELETED: actor, preconditions, crash semantics) cites
   the code sites and the pinning check per row — the writers are
   `src/gc.ts` (sole `reclaimable` writer/row remover, NOTICE.md:132),
   the compaction publish (single transactionSync, spec §8 M3.3 record),
   and `read-leases.ts` (the eligibility substrate, NOTICE.md:112). Owner:
   an engine-adjacent docs unit; touches ONLY `docs/` — no shared files.
2. (S, optional) Append explicit §7.2 row-10/row-11 pins to
   `check-fault-matrix.mjs` (or a row-annotated comment closing them by
   composition): row 10 as an assertion that no read path pauses mid-stream
   (every GET is an explicit bounded Range GET — partially asserted already
   in check-segmented-serve), row 11 as a want-whose-closure-is-partially-
   missing → plan-rejection fixture. Touches
   `packages/git-engine/e2e/check-fault-matrix.mjs` ONLY; engine source
   untouched; re-run the script + `tsc -p tsconfig.build.json`.
3. (XS, optional) Add the three M3.5 scripts to
   `packages/git-engine/e2e/README.md`'s script list (housekeeping suggested
   by the health sweep's open-issues section,
   `docs/research/engine-e2e-health-2026-10-26.md:149-156`, which also lists
   the count touch-up — already done by 84cf4c9).

If the orchestrator instead declares the table descoped (nothing in the
record contradicts that reading — the as-built entry simply narrows M3.5 to
the acceptance-hardening tail), then apply §5's ledger updates alone and
close: that is the COMPLETE-BUT-UNRECORDED path, and the two optional items
become standing follow-ups rather than milestone debt.

## Source index (all cites used)

- Spec: `specs/0011-compaction-gc.md` — §7.2 matrix :218-233; §7.3 :235-244;
  §9 M3.5 :286-288; banner :364; M3.5 as-built :366-493 (per-row audit
  :375-412, correctness tier :414-461, capability matrix :463-483, gate
  statement :485-493); 2fce4cd record :495-512; M3.4 record :341-362; M3.2
  record :307-320.
- Ledger: `specs/README.md:24,47`.
- Code/checks: `packages/git-engine/e2e/check-fault-matrix.mjs:489,563,662,716`
  (+ header audit :8-47); `check-capability-matrix.mjs:1-18`;
  `check-correctness-tier.mjs:1-33`; `check-cache-unreachable.mjs:283-301`;
  `check-read-leases.mjs:405,506`; `check-segmented-serve.mjs:419`.
- NOTICE: `packages/git-engine/NOTICE.md:112,118,123,132`.
- Verification: `docs/research/engine-e2e-health-2026-10-26.md:8-12,33-53,55-61,149-156`.
- Differential: `scripts/diff-test.mjs`; `scripts/diff-cases/README.md:1-8`;
  `.github/workflows/ci.yml:404-445`; commits 48903f8, ec5f7c9.
- Commits: 157e74e (M3.5 landing incl. spec record), 84cf4c9 (count
  annotation), 53fc835 (M3.4 as-built), 2fce4cd (content-path leases).

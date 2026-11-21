# ADR-0009 data archive — the FIRST re-pin (fc49368845 → 099abf5db4)

Recorded 2026-11-21 (freeze chain L71 resume), per ADR-0009 §Decision-4's
data-collection obligation ("At every re-pin: run `pnpm drift --current`, and
record ACTUAL hours in five categories"). This is the protocol's first real
data point; the preview map it measures against is
`docs/compat/upstream-drift-preview.md`.

## The window

- From `fc4936884584a41931906553d96c2601d750e6ef` (the v1.5.x era pin,
  describe `v29.0.0-dev-208-gfc49368845`) to
  `099abf5db47dd5cf797d8898f6aaa06ccdf77c24` (describe
  `v29.0.0-dev-439-g099abf5db4`): **231 upstream commits**, 1635 files
  (+45,840/−56,964 upstream-side).
- Our side: the 2026-11-20 re-pin campaign, `0a97aed..085884b` — 28 commits,
  221 files changed (+24,940/−6,879), migration 0080
  (`repositories.latest_release_id`) staged by RELEASE2 (`5e4de1b`).

## Actual hours (the five-category ledger, as recorded per unit commit)

19 of the 28 campaign commits carry the `HOURS (ADR-0009)` ledger line; the
other 8 are riders/folds/docs-only landings whose cost rode their sibling
units (08b1d2b goldens rebaseline, 353b4f8 reconciliation tail, 9678cb9
one-line rider, aac3c6e schema adoption, 7ed8e18 ACTIONS2, 513542e fold,
63df8f6 orphaned hunk, 8594d11 recorded "pure category (iv)+(v)" without a
number). Total recorded: **53.2h**.

| Commit | Family | h | Recorded split |
|---|---|---|---|
| 0a97aed | REPIN-ROUTES | 3.0 | structure 0.8 / ViewModel 0.7 / helpers 0.1 / behavior 0.6 / test 0.8 |
| 57a4619 | REPIN-ISSUE | 3.5 | structure 0.9 / ViewModel 0.3 / helpers 0.4 / behavior 1.3 / test 0.6 |
| 086679d | ADMINUSER2 | 2.6 | structure 0.9 / ViewModel 0.2 / helpers 0.1 / behavior 0.2 / test 0.4 / cite-verification reading 0.8 |
| 5e4de1b | RELEASE2 | 2.6 | structure 0.2 / behavior 0.4 / cite-sweep 1.3 / census+staging 0.4 / gates 0.3 |
| f38e277 | CODESRCH2 | 4.5 | structure 0.5 / wire models 0.4 / helpers 0.9 / behavior 0.9 / test 0.7 / derivation reading 1.2 |
| 6e2c586 | PULL2 | 1.2* | structure 0.4 / helpers 0.1 / behavior 0.4 / test 0.3 (session-recorded) |
| 441b5c5 | REPIN-REPO | 4.2 | structure 1.2 / ViewModel 0.8 / helpers 0.3 / behavior 1.2 / test 0.7 |
| 9f9b47f | ORGWIRE | 1.7 | reading 0.6 / wiring 0.4 / pins 0.4 / gates 0.3 |
| 655c504 | REPIN-NOTIFY | 1.7 | structure 0.5 / behavior 0.8 / test 0.4 |
| 3831c20 | REPIN-WATCH | 1.0 | structure 0.55 / ViewModel 0.10 / behavior 0.25 / test 0.10 |
| 1150e4e | ROUTESWAP | 0.9 | structure 0.25 / behavior 0.25 / test 0.25 / gates 0.1 / helpers 0.05 |
| c9ef680 | WATCHSHELL | 0.9 | reading 0.35 / edits 0.2 / pins 0.2 / gates+golden 0.15 |
| e3e0b8c | REPIN-OAUTH | 11.0 | structure 3.5 / ViewModel 1.5 / helpers 1.0 / behavior 2.0 / test 3.0 |
| f67e9b9 | TRANSFERHOOK | 1.9 | derivation 0.7 / wiring 0.3 / behavior 0.4 / test 0.5 |
| c9202b1 | REPIN-PKG | 4.0 | structure 0.7 / ViewModel 0.2 / helpers 0.4 / behavior 1.6 / test 1.1 |
| cb2cbfb | TWOFALIM | 3.0 | reading 1.4 / behavior 0.7 / pins 0.6 / gates 0.3 |
| 9dbbd33 | SMALLS6 | 3.0 | reading 0.7 / edits 0.6 / pins 0.8 / gates 0.9 |
| 09c2b92 | CHECKER | 1.6 | triage tooling 0.5 / rule 0.3 / entries 0.5 / verification 0.3 |
| 085884b | GATEFIX | 0.9 | triage 0.3 / ports 0.25 / pins 0.2 / gates 0.15 |

*PULL2's 1.2h is the session-scoped slice (the family's fuller cost rode
its sibling landings aac3c6e/085884b).

### Category aggregation (honest mapping note)

The per-commit slice names vary (reading/wiring/pins/gates are each unit's
own vocabulary). Mapped conservatively onto ADR-0009's five categories using
ONLY the explicitly-named slices:

- (i) pure template-structure sync — the `structure` slices: **≈10.4h
  (≈20%)**
- (ii) ViewModel adaptation — the `ViewModel` slices: ≈4.5h
- (iii) helpers/locals — the `helpers` slices: ≈3.7h
- (iv) permission/behavior changes — `behavior`/`wiring`/`ports` slices:
  ≈11.6h
- (v) test/golden repair — `test`/`pins`/`gates` slices: ≈14.5h
- unmapped (`reading`/`derivation`/`cite-sweep`/`triage`/`rule`/`entries`):
  ≈8.5h

## Trigger verdict

Category (i) share ≈ **20%** — far below ADR-0009's ~50% investigation
trigger, on the most conservative reading (every unnamed or reading-named
slice excluded from (i); even attributing ALL unmapped hours to (i) reaches
only ≈36%). **The trigger does NOT fire**: no template-engine POC; the TSX
render path stays per ADR-0009 Decision 1/2/5.

## `pnpm drift --current` at the new pin (2026-11-21)

Cite side: **to** — the campaign re-anchored the tree's citations at
`099abf5db4` (the drift analyzer confirms: our cites are valid at the TO
endpoint; residual verdicts are moved-only rows). Window
`fc49368845..099abf5db4`: upstream 874 files touched (793 modified / 53
added / 28 deleted); our citation index 28,602 sites in 1,023 files;
(a) moved-only 7,967 sites / 761 files, (b) region-changed 2,800 sites /
535 files (all re-derived by the campaign's units), (c) 81 files added/
removed. The residual follow-up is the moved-only cite refresh (~60 sites
recorded as REPIN-PKG's carry-over) — cite-hygiene, not behavior.

Baseline regeneration for the NEXT window
(`docs/compat/upstream-drift-baseline.md` is still mapped at
fc49368845) is deliberately NOT part of this archive: it belongs to the
next drift run that opens a new window, not to closing this one.

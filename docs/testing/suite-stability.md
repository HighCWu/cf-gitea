# Suite stability ledger — full `apps/worker` vitest runs at the wrap-redeploy gate

Measured 2026-10-27 by wave-126 (`wave-suite-stability`, QA/hygiene). Tree state
for the baseline runs: HEAD `9468587` (working tree clean, 13:56-14:10 local,
before the mount-window edits began; earliest window file mtime 14:27:29).
Companion analysis: `docs/research/workers-vitest-ws1009-issue.md` (wave-31/32,
mechanism + minimal repro). This file is the failure ledger and the mitigation
verdict for the "full worker suite green in one run" wrap-redeploy requirement.

## Executive summary

- The suite does not complete at the current scale: in two clean full runs,
  **204 of 258 test files (79%) lost their runner at startup** to the workerd
  WebSocket 1009 "Message is too large" pool death, deterministically. Their
  tests never run; vitest reports them only as unhandled errors and exits 1.
- **Zero real regressions.** Every test that actually failed (26, then 24) is a
  30-second timeout in the known git-engine-adjacent heavy six, inflated 13-17x
  past their solo wall time by the death churn — plus one delivery-timing race
  in `webhooks-push.test.ts` that flapped between runs. All ten suspect files
  pass solo.
- The death count exploded 17 → 204 between wave-31's measurement yesterday
  (153 files) and today (258 files) because the **common import graph crossed
  the 32 MiB warm-snapshot boundary** as feature waves landed modules into it.
  This gets worse with every landed wave until the mechanism is fixed upstream
  or the graph shrinks.
- **No cheap, safe `vitest.config.ts` mitigation exists.** `isolate: false` was
  A/B-tested and rejected (below). `vitest.config.ts` is intentionally left
  untouched.

## Failure ledger (baseline runs, `maxWorkers: 8`, isolation default)

| Metric | Run 1 (13:56) | Run 2 (14:04) |
|---|---|---|
| Wall | 308.75s | 318.55s |
| Runner deaths (`Errors`) | 204 | 204 |
| 1009 protocol-error lines (÷3 = events) | 612 = 204 | 612 = 204 |
| Doomed-file set overlap across runs | 192 of 204 files identical in both runs | - |
| Test files failed | 6 | 6 |
| Tests | 26 failed \| 1425 passed \| 5 skipped (1456) | 24 failed \| 1349 passed \| 5 skipped (1378) |
| Assertion failures | 1 (delivery race) | 0 |
| Exit code | 1 | 1 |

(The 1456-vs-1378 test-total delta is the 12 files whose doom flapped between
runs — their tests count only when the file survives.)

Failed tests per file (all `Test timed out 30000ms` unless noted):

| File | Run 1 | Run 2 | Solo verdict |
|---|---|---|---|
| `src/invariants/invariants.test.ts` | 8 | 8 | 17/17 pass, 19s wall |
| `src/services/webhooks-push.test.ts` | 7 (6 timeouts + 1 race) | 5 | 19/19 pass, 16s wall |
| `src/api/pull-engine.test.ts` | 5 | 4 | 25/25 pass, 9s wall |
| `src/repos/lifecycle.test.ts` | 3 | 3 | 37/37 pass, 8s wall |
| `src/api/services/pulls-head-repo.test.ts` | 3 | 4 | 14/14 pass, 11s wall |
| `src/issues/webhooks.test.ts` | 1 | 1 | 10/10 pass, 5s wall |

Per-file wall inflation under death churn: 257-270s in-suite vs 4-19s solo
(13-17x) — the 30s `testTimeout`/`hookTimeout` (wave-27 tuning) has ample
headroom on a run that is not churning 204 replacement runner spawns.

The one assertion failure (`webhooks-push.test.ts` "a first push emits the
zero-commit push event + create event per created ref", 1745ms) is a
delivery-timing race: it asserts delivery rows are still `pending` immediately
after the push, but under load the DO delivery completes first (`delivered`).
It flapped between the two runs. Recommendation for the owning agent: poll or
await the delivery waitUntil deterministically instead of asserting the
pre-delivery state. Not fixed here (test-expectation edits are out of my
ownership).

## Solo adjudication

Every file that failed anywhere was run alone (`npx vitest run <file>`):
the six above, plus the four files that only failed in the window-overlapped
A/B run — `src/ui/pages/admin-monitor.test.tsx` (30/30), `src/api/mirror.test.ts`
(23/23), `src/services/mirror/sync.test.ts` (12/12), `src/repos/delete-actions.test.ts`
(2/2). **All ten exit 0. Nothing is a real regression** — including the recent
landings named in the brief (`c66fe23`, `9ad5d15`, `cced424`, `df82166`,
`0968117`): none of their surfaces appear in any failure set.

## Mechanism (confirmed in-suite; full treatment in the research doc)

`docs/research/workers-vitest-ws1009-issue.md` (wave-31/32) measured the exact
protocol: each file's runner requests `fetchWarmModules`; the pool answers with
the **whole already-transformed import graph as ONE WebSocket message** (code +
inline sourcemap per module, duplicated under `url` and `id` aliases). The local
workerd enforces a 32 MiB incoming-message cap on that socket (measured
boundary 33,309,508 B pass / 33,654,312 B die); an over-cap message closes with
1009 and the runner dies "during started state". The snapshot is empty only for
the first file to connect a given graph on the shared Vite server, which is why
the crash set is deterministic per scheduling order and why solo/subset runs are
always clean (a 12-file probe of known-doomed files passes 12/12).

Yesterday's ledger: 17 deaths/run out of 153 files (the swagger-JSON importer
set). Today: 204/258 — the shared app-entry graph crossed 32 MiB of
transformed+aliased+sourcemapped payload as the mount-window-era waves kept
adding modules to it. Absent a fix, this number grows with every landing.

Size proxy at HEAD `9468587`: non-test `src/` (ts/tsx/json/svg, tests excluded)
totals 14,486,633 B — at wave-32's calibrated "~13 MB of connected source"
snapshot boundary, consistent with the observed whole-graph-sharer die-off.
Four data modules account for 2.8 MB of it (`v1-swagger.generated.json` 983,702,
`material-icon-svgs.json` 998,898 — both already on the safe `?raw`/dynamic
posture — `material-icon-rules.json` 461,498, `tier1-fixtures.json` 373,398).

The `src/ui/fileicon` posture is confirmed load-bearing: both large JSONs ride
Vite's `?raw` transform (no sourcemap inflation) and are dynamically imported;
do not convert them to normal-form JSON imports.

## Mitigation A/B

- **Candidate: `isolate: false`** (vitest reuses runners; wave-32's repro showed
  a memoized empty snapshot that cannot crash). Subset run (15 files, including
  the heavy three): 15/15 pass, 0 deaths, 47s. Full run: **rejected** — 186
  runner deaths persisted (558 1009 lines), and its 10 failed files /
  67 failed tests include every file the concurrent mount-window had mid-edit
  (`ui/index.ts` was modified mid-run), so the run is contaminated as evidence
  in both directions. Runner reuse additionally depends on plugin storage
  isolation semantics that are unverified at suite scale. Not adoptable; not
  left in the tree.
- **`maxWorkers` retuning**: wave-31 already measured the death count constant
  across `maxWorkers` 31 and 8 (structural, not load-raced), and the wave-32
  repro measured MORE deaths at `maxWorkers` 1 (17) than at 8 (10) — a warmer
  shared server means larger snapshots. No value of this knob fixes the class.
- **`dangerouslyIgnoreUnhandledErrors`**: would flip the exit code to 0 while
  204 files silently never run. Strictly worse; rejected without a run.
- **Timeout raises**: the timeouts are downstream of the death churn, not an
  independent class (13-17x inflation vs solo). Raising them past 30s would
  only lengthen a run that is already losing 79% of its files.

Conclusion: `vitest.config.ts` unchanged. The levers that actually fix the
suite are upstream or product-side:

1. **Upstream (preferred)**: the workers-sdk issue is fully prepared in
   `docs/research/workers-vitest-ws1009-issue.md` with a filed-ready minimal
   repro (`docs/research/ws1009-repro.tar.gz`). The fix directions there
   (chunked transfers / cap parity / lazy sourcemaps) all resolve this class.
2. **Product-side stopgap**: shrink the app-entry import graph back under the
   snapshot boundary (aux-fragment the heaviest statically-imported modules the
   way tree-view/fileicon already are). Requires re-running wave-32's
   instrumented snapshot measurement on HEAD to size the gap before spending
   refactors — the boundary moves with every wave.
3. **Operational composite gate (works today)**: run the full suite, parse the
   "Worker exited unexpectedly … running test file X" attributions from the
   log, re-run exactly that file list (small batches pass deterministically —
   the 12-file probe and the ten solo runs above), and require pass 2 to be
   green with zero unhandled errors. That is the only honest "everything ran
   and passed" signal available at the current graph size.

## Reproduction

```bash
cd apps/worker
npx vitest run                      # baseline: ~5.2 min, 204 deaths, exit 1
npx vitest run src/invariants/invariants.test.ts   # solo: green, exit 0
grep -c "protocolError.statusCode = 1009" <log>    # ÷3 = death events
```

Baseline logs (scratch, not committed): `/tmp/wave126/run{1,2}.log`,
`run3-isolfalse.log`, `ab-subset-isolfalse.log`, `probe12.log`, `solo-*.log`.

## Appendix (2026-10-27, wave-composite-gate + the wrap wiring): the gate tool + two parser traps

`scripts/full-suite-gate.mjs` (run as `pnpm test:full`) implements the composite
gate with `--solo` adjudication:

- **Death signature (text reporter)**: `Worker exited unexpectedly during
  started state while running test file <abs-path>` — exactly one line per
  death (3× `protocolError.statusCode = 1009` lines each); validated against
  the baseline logs at exactly 204/258.
- **JSON reporter trap 1 — stubs**: vitest 5.0.5 emits a `testResults` entry
  (`status: "passed"`, zero `assertionResults`) for every discovered file that
  never ran — counting JSON entries as "ran" silently absorbs ALL deaths.
  Death lines always win over JSON presence.
- **JSON reporter trap 2 — lossy failed suites**: a `beforeAll` timeout marks
  tests "skipped" with NO failure message in the JSON; the text log's FAIL
  blocks are the only message source. Timeout-class only if EVERY message
  matches `(Test|Hook) timed out in \d+ms`.
- **Death-on-rebatch does NOT converge** (measured, 4 real invocations):
  batch re-runs shrink 169 → 138 → 115 but never reach 0 — every batch
  re-ships the same ~cap-sized common core. The batch-mode guard therefore
  FAILS honestly; the structural cure is `--solo`: each pending file runs as
  its OWN vitest process (a fresh process first-connects an EMPTY warm
  snapshot — solo runs are immune by construction). A solo death is retried
  once, then fails; solo assertion/timeout failures fail immediately.
  Consistent with the falsified Plan A in `docs/research/ws1009-graph-sizing.md`
  §4.A: no graph-shape trick escapes the executed-edge BFS.

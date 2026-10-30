# Gate pre-run: the full-suite composite gate at v1.3.1 HEAD

Pre-run verdict: **GATE-GREEN** — `verdict: PASS` (gate exit 0). Zero solo-reds;
every phase-1 red adjudicated into a known harness/load class by the gate's own
`--solo` machinery. No code was changed anywhere; nothing was committed.

- Pre-run date: 2026-10-30
- Pinned HEAD: `d2fd6f0eba03fbb6229e685687b19ec4559f8b71` (main's tip at dispatch;
  the shared tree was mid-flight with sibling units, so the run executed in a
  detached worktree — exactly the committed state, immune to sibling edits).
- Gate: `scripts/full-suite-gate.mjs --solo` per ADR-0006
  (`docs/decisions/0006-full-suite-composite-gate.md`), strip mode
  (`CF_TEST_STRIP_SOURCEMAPS=1`) as the standing `pnpm test:full` posture.
- Known flake classes referenced for attribution:
  `docs/usability/reverify-convergence.md` (Class A: broad-run beforeAll hook
  timeouts; Class B: cross-file D1 bleed / contention-shaped state failures).

## Method

Detached worktree at the pin, account-local state copied in per the verified
copy-list (same posture as `docs/usability/reverify-convergence.md`):

```
git worktree add --detach /tmp/cf-gitea-gate d2fd6f0eba03fbb6229e685687b19ec4559f8b71
# copies: apps/worker/wrangler.jsonc, apps/worker/.dev.vars,
#         apps/worker/src/ui/icons.generated.ts, apps/worker/public/assets/ (17 MB bundle —
#         load-bearing for UI pins; a bare worktree without it 503s the UI-page suites)
# symlinks: apps/worker/node_modules -> main tree, gitea/ -> main tree (read-only reference)
```

Command, from the worktree's `apps/worker`:

```
CF_TEST_STRIP_SOURCEMAPS=1 node /tmp/cf-gitea-gate/scripts/full-suite-gate.mjs \
  --solo --baseline-json /tmp/gate-prerun-v131/baseline.json
```

The gate's tree-state line reported `2 dirty file(s)` — both are the setup
artifacts themselves (` T gitea`, `?? apps/worker/node_modules`, i.e. the two
symlinks), not code edits; the worktree's tracked tree was otherwise exactly the
pin. The gate's NOTE is quoted here for honesty:

```
[gate] tree: HEAD d2fd6f0eba03fbb6229e685687b19ec4559f8b71, 2 dirty file(s); expected test files: 342; artifacts: /tmp/gate-prerun-v131
[gate] NOTE dirty tree — the verdict is for this working tree, not a clean HEAD.
```

Environmental disclosure: the shared runner box was mid-flight with sibling
smoke units booting dev servers during this run — i.e. this pre-run executed
under MORE contention than a quiet tag-time gate, which biases toward the
load class, not against it.

## The gate's own verdict lines (quoted verbatim)

Phase 1 summary from the vitest text log (`phase1-full-suite.log`):

```
 Test Files  3 failed | 339 passed (342)
      Tests  3 failed | 7740 passed | 42 skipped (7785)
   Duration  492.71s (tests 61%, transform 33%, import 5%, worker 1%)

    Isolate  342 workers spawned · ~4.36s startup each (spawn + environment, per file)
```

Gate progression lines (`gate.log`):

```
[gate] phase1-full-suite: exit 1, wall 494.1s — ran 342, pass 339, timeout-files 2, assert-files 1, deaths 0, missing 0, unhandled ?
[gate] solo adjudication: 3 file(s), 4 concurrent process(es) — each file runs in its OWN vitest process (empty first-connect snapshot)
[gate] phase2-solo/002: exit 0, wall 13.4s — ran 1, pass 1, timeout-files 0, assert-files 0, deaths 0, missing 0, unhandled ?
[gate] phase2-solo/001: exit 0, wall 14.1s — ran 1, pass 1, timeout-files 0, assert-files 0, deaths 0, missing 0, unhandled ?
[gate] phase2-solo/000: exit 0, wall 39.6s — ran 1, pass 1, timeout-files 0, assert-files 0, deaths 0, missing 0, unhandled ?
[gate] solo 3/3: ok src/api/pull-engine.test.ts
[gate] every file ran green across 4 phase(s) (345 file-runs total)
```

Final table and verdict:

```
== full-suite gate ==
phase1-full-suite          ran  342  pass  339  timeout-files   2  assert-files   1  deaths    0  missing   0  unhandled    ?  wall 494.1s
phase2-solo/002            ran    1  pass    1  timeout-files   0  assert-files   0  deaths    0  missing   0  unhandled    ?  wall 13.4s
phase2-solo/001            ran    1  pass    1  timeout-files   0  assert-files   0  deaths    0  missing   0  unhandled    ?  wall 14.1s
phase2-solo/000            ran    1  pass    1  timeout-files   0  assert-files   0  deaths    0  missing   0  unhandled    ?  wall 39.6s
total wall 533.9s
verdict: PASS
  - phase1: 1 assertion file(s) enter solo adjudication (--solo) — solo red fails (real regression); solo green is recorded load-attributed
```

Gate exit code: `0`. Evidence record: `/tmp/gate-prerun-v131/baseline.json`
(phase logs + raw vitest JSON alongside it in `/tmp/gate-prerun-v131/`).

## Structural posture: zero ws1009 deaths at 342 files

Phase 1 ran the full suite in ONE invocation with **0 runner deaths, 0 missing
files** (all 342 discovered files ran; attribution accounting closed cleanly).
The strip-mode era (ADR-0006 postscript + addendum) still holds at the current
scale — 342 files now vs 262 at the 2026-10-28 addendum measurement.

## Per-red adjudication (3 phase-1 reds, all adjudicated)

Per ADR-0006: solo-reds are REAL (the gate re-runs them standalone);
parallel-only reds that pass solo are the harness class.

### Red 1 — `src/ui/__tests__/pages-wave6.test.ts` (parallel-only red → harness class)

- Phase-1 failure: `Error: Hook timed out in 30000ms.` (suite-dead in `beforeAll`
  under 342-worker spawn contention, ~4.36 s startup per worker).
- Solo (own vitest process): `Test Files  1 passed (1)` / `Tests  23 passed (23)`,
  wall 14.1 s — the same hook completes in ~1 s quiet.
- Attribution: **harness class** — the Class A family (beforeAll hook timeouts
  under broad-run workerd spawn contention; the vitest.config.ts hookTimeout
  comment's "beforeAll hooks crossed 20s in one run" family). Not a regression.

### Red 2 — `src/ui/__tests__/pages-wave7.test.ts` (parallel-only red → harness class)

- Phase-1 failure: `Error: Hook timed out in 30000ms.` (same shape as Red 1).
- Solo: `Test Files  1 passed (1)` / `Tests  14 passed (14)`, wall 13.4 s.
- Attribution: **harness class** — same Class A family. Not a regression.

### Red 3 — `src/api/pull-engine.test.ts` (parallel-only red → contention-shaped, load-attributed)

- Phase-1 failures (3 failed tests, the file the gate routed to solo as the
  assert-class file):
  1. `keeps the FORK's default branch as a fork PR head — the default arm reads
     the head repo's default` — `Error: Test timed out in 90000ms.`
  2. `keeps the fork's head branch when the doer holds no write on the fork —
     the write arm is the head repo's` — `Error: Test timed out in 90000ms.`
  3. `the PR-head sync round-trip — a second push moves refs/pull/N/head and the
     merge eats the NEW tip > create PR → push again → ref/head_sha/checking/
     comment move → merge lands the SECOND commit` —
     `AssertionError: expected [] to have a length of 1 but got +0`
     (at `src/api/pull-engine.test.ts:1582`).
- Solo: `Test Files  1 passed (1)` / `Tests  39 passed (39)`, wall 39.6 s.
- Attribution: **contention-shaped flake, the documented Class B sibling** —
  `docs/usability/reverify-convergence.md` reproduces this EXACT failure shape
  in the prior round ("pull-engine.test.ts:1291 — push-comment rows `[]`
  instead of 1 (the PR-head sync round-trip); solo `Tests  39 passed (39)`";
  the line moved 1291 → 1582 as the file evolved, the test and shape are
  identical, and that round's solo arm was also 39/39 green). Under a 342-way
  parallel run the PR-head sync round-trip's push-comment row lands outside the
  await window; solo it lands. Not a regression — solo-green, recorded
  load-attributed per the gate's own `--solo` refinement line above.

## Final call

**GATE-GREEN.** The composite gate at pinned HEAD `d2fd6f0` exits 0 with its own
`verdict: PASS`: every one of the 342 test files ran green across 4 phases
(345 file-runs total), zero runner deaths, zero missing files, zero solo-reds —
therefore **REDS-NEEDING-FIXES: (none)**. The tag-time `pnpm test:full` run by
the orchestrator is expected to reproduce this verdict; if it produces
parallel-only hook-timeout or pull-engine contention reds, this document is the
attribution record to adjudicate them against.

## Cleanup

The detached worktree `/tmp/cf-gitea-gate` was removed after the run
(`git worktree remove --force` — the copies and symlinks are untracked
account-local artifacts; the main tree was never touched), `git worktree prune`
run, and the removal verified via `git worktree list`. No code, config, test,
or spec file was edited anywhere; nothing was committed.

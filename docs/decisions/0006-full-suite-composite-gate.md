# ADR-0006: The full-suite gate is the composite gate (`pnpm test:full`), not single-pass vitest

Status: accepted · Date: 2026-10-27 · Refines ADR-0005 (verification strategy):
the layer stack's unit layer needs a defined "full suite is green" verdict at
the ws1009 scale.

## Context

The full `apps/worker` vitest suite cannot run green in one invocation, and the
cause is upstream infrastructure, not our tests: at the measured scale
(2026-10-27, HEAD `9468587`) workerd kills **204 of 258 test files at runner
startup** with WebSocket 1009 "Message is too large" — `@cloudflare/vitest-plugin`'s
`fetchWarmModules` answers each runner with the **whole already-transformed
import graph as ONE WebSocket message**, and local workerd enforces a 32 MiB
inbound cap on that socket. The crash set is deterministic per scheduling
order; the dead files never run and vitest reports them only as unhandled
errors while exiting 1. Mechanism + measurements:
`docs/testing/suite-stability.md`; per-module payload sizing (the common core
is 321 modules / 44 MB wire, sourcemaps 61.5% of the raw payload):
`docs/research/ws1009-graph-sizing.md`; filing-ready upstream report (draft,
not yet filed): `docs/research/ws1009-upstream-issue-draft.md`; the original
wave-31/32 mechanism + minimal repro: `docs/research/workers-vitest-ws1009-issue.md`.

The decision is not how to fix ws1009 (upstream's to make) but **what counts as
"the suite is green" while it exists** — and the honest answer requires
adjudicating the deaths, because a dead file neither passes nor fails.

## Decision

The standing gate for "everything ran and passed" is the **composite gate**,
`pnpm test:full` (`scripts/full-suite-gate.mjs`, 9b16913):

1. **Phase 1 — one full run, exact attribution.** Every discovered file is
   attributed to exactly one of {ran, died-at-startup, failed-tests}, with
   cross-checks against the measured vitest 5.0.5 reporter traps: death
   attribution comes only from the text log's "Worker exited unexpectedly …
   while running test file" lines; JSON stub entries (status "passed", zero
   assertions) for never-run files never count as "ran"; unhandled errors must
   not exceed the attributed death count; a file absent from both results and
   deaths fails the gate. **Assertion failures (and collection-time failures)
   are fatal and never retried away.**
2. **Phase 2 — `--solo` adjudication.** Every death/timeout file re-runs in
   its **OWN vitest process**. This is structurally immune to ws1009: a fresh
   process first-connects an **empty** warm snapshot, so the over-cap message
   cannot exist. A solo death is retried once, then fails honestly. Timeout
   class failures re-run (they are downstream churn of the deaths, measured
   13–17x solo wall); assertion failures fail immediately.

Batch re-runs were tried first and are **measured non-convergent**: 169 → 138 →
115 pending files across re-batches, never 0 — every batch re-ships the same
~cap-sized common core. Solo is not an optimization; it is the only mode that
terminates.

**Rule: a green single-pass `vitest run` proves nothing about suite health at
this scale** — it silently omits the ~79% of files whose runners died. It
remains the fast local loop for a file or scope; it is never cited as "full
suite green". CI/landing verdicts use `pnpm test:full`.

## Considered and falsified (do not re-try without new mechanism knowledge)

- **`isolate: false`** — A/B-tested (`docs/testing/suite-stability.md`): 186
  runner deaths persisted in the full run; the green subset A/B proves nothing
  at scale. Rejected.
- **`maxWorkers` retuning** — death count constant across 31/8 and *higher* at
  1 (17 vs 10 in the repro): a warmer shared server means larger snapshots.
  Structural, not load-raced. Rejected.
- **`dangerouslyIgnoreUnhandledErrors`** — flips exit to 0 while 204 files
  silently never run. Strictly worse; rejected without a run.
- **Plan A graph-shape (de-static the UI mount) — falsified by EXECUTION**
  (add4b80; full record in `docs/research/ws1009-graph-sizing.md` §4.A). The
  static-edge model predicted 0/259 deaths; the change was implemented
  behavior-preserving, all gates green — **and the death count stayed 204**
  (195/204 doomed-set overlap). Mechanism discovered by trying it:
  `fetchWarmModules` BFS-walks `node.importedModules` with **dynamic edges
  included once executed** — the plugin's virtual `cloudflare:test` module
  imports `src/index` (the main module), so any lazily-mounted edge sits on
  that universal node and re-enters every later file's warm message the moment
  any test executes a request through it. **No within-ownership graph shape
  escapes this; do not re-try Plan-A-class ideas** (lazy mounts, aux-fragment
  splits of statically-imported main-module paths) *expecting death
  reductions*. The change was reverted at landing review (complexity carried
  for zero ws1009 gain). The surviving shrink levers are B (strip dev-transform
  sourcemaps, −26 MB core) and the upstream fix.

## Consequences

- **Honest signal, priced.** "Everything ran and passed" is true when the gate
  exits 0, at ~15–20 min wall (vs ~5 min for the single pass that lies). The
  price is paid at gates that claim suite-wide health, not on every local loop.
- **The death count stays visible.** Phase-1 attribution is recorded in every
  baseline/evidence run (`--baseline-json`), so the structural damage is never
  normalized into a green checkmark.
- **Revisit triggers.** The gate collapses back to plain `vitest run` when
  either (a) the upstream chunked-warm-modules fix lands
  (`docs/research/ws1009-upstream-issue-draft.md` — file when the orchestrator
  schedules it), or (b) lever B (sourcemap strip, `docs/research/ws1009-graph-sizing.md`
  §4.B) makes the single-pass message fit under the cap again. Re-measure the
  graph after any landing — the boundary moves with every wave.
- **The gate is read-only** wrt the repo: it never edits `vitest.config.ts`,
  tests, or source (the suite-stability A/B discipline keeps the config
  untouched; every config-side "fix" above was measured and rejected).

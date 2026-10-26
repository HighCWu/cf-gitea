# Engine e2e health sweep — 2026-10-26

Full health sweep of the vendored engine's own e2e corpus at current HEAD.
Read-only verification unit (wave-47 `wave-engine-e2e-sweep`): every script
under `packages/git-engine/e2e/` executed sequentially, nothing fixed, nothing
edited outside this document.

**Verdict: clean bill.** 16/16 `check-*.mjs` scripts green — **269/269
checks**, ~7.5 s total — and the live-Worker protocol suite `e2e.sh` stands at
its documented steady state (34 pass / 35 fail with the failure set **set-equal
to the CI allowlist**, diff-verified line by line). No engine regression, no
environmental flake, no fixture drift from today's app-side work.

## Provenance

- Tree state: HEAD `bff7fdc` (docs tick-7), with sibling waves' in-flight,
  uncommitted app-UI edits present in the working tree
  (`apps/worker/src/ui/components/file-list.tsx`, `apps/worker/src/ui/index.ts`
  modified; `apps/worker/src/ui/pages/repo-blob-excerpt-fragment.tsx`
  untracked). All app-side; none imported by the engine checks.
- Engine untouched today: last commit touching `packages/git-engine/src` is
  `d7fdc49` (2026-10-25, SPEC-0013 M2 validatePush seam); last touching
  `packages/git-engine/e2e` is `3e49974` (2026-10-25, allowlist
  re-verification). The engine has been frozen since SPEC-0013 M2 landed.
- Environment: Linux, node v25.9.0, tsx 4.23.15 (`node_modules/.pnpm/tsx@4.23.15/.../cli.mjs`,
  the invocation pattern from each script's header), git 2.43.0.
- Method: scripts run strictly sequentially (each `node <tsx> <script>`
  awaited before the next; no parallel workers), stdout+stderr captured to
  per-script logs, exit codes and `^ok:` counts recorded, wall time via
  `date +%s.%N` around each run. Raw logs preserved at
  `/tmp/engine-e2e-sweep-2026-10-26/` (ephemeral).

## Matrix — check-*.mjs family (tsx, self-contained harnesses)

| # | Script | Checks | Verdict | Duration | Closing summary line (verbatim) |
|---|--------|-------:|---------|---------:|---------------------------------|
| 1 | check-deepen-parse.mjs | 16 | GREEN | 0.137 s | `all deepen-parse checks passed` |
| 2 | check-cache-unreachable.mjs | 19 | GREEN | 0.177 s | `all cache-unreachable checks passed` |
| 3 | check-capability-matrix.mjs | 18 | GREEN | 0.140 s | `all 18 capability-matrix checks passed` |
| 4 | check-catalog-rpc.mjs | 10 | GREEN | 0.110 s | `all 10 catalog RPC checks passed` |
| 5 | check-compaction.mjs | 8 | GREEN | 0.218 s | `all 8 compaction checks passed` |
| 6 | check-correctness-tier.mjs | 7 | GREEN | 0.486 s | `all 7 correctness-tier checks passed` |
| 7 | check-fault-matrix.mjs | 4 | GREEN | 0.197 s | `all 4 fault-matrix checks passed` |
| 8 | check-fork-replicate.mjs | 50 | GREEN | 0.891 s | `RESULT: 50 passed, 0 failed (workdir /tmp/fork-e2e-0nxBqv)` |
| 9 | check-gc.mjs | 8 | GREEN | 0.218 s | `all 8 checks passed` |
| 10 | check-merge-engine.mjs | 29 | GREEN | 0.435 s | `all 29 engine checks passed` |
| 11 | check-merge-graph.mjs | 14 | GREEN | 1.497 s | `all 14 graph checks passed` |
| 12 | check-merge-tree.mjs | 25 | GREEN | 1.696 s | `all 25 tree/diff3 checks passed` |
| 13 | check-migrations.mjs | 17 | GREEN | 0.137 s | `all 17 engine checks passed` |
| 14 | check-read-leases.mjs | 25 | GREEN | 0.645 s | `all 25 engine checks passed` |
| 15 | check-segmented-serve.mjs | 10 | GREEN | 0.263 s | `all 10 segmented-serve checks passed` |
| 16 | check-validate-push.mjs | 9 | GREEN | 0.225 s | `check-validate-push: 9/9 checks passed` |
| | **Total** | **269** | **16/16** | **7.47 s** | every exit code 0 |

Baseline comparison (SPEC-0011 §8 M3.5 record, 2026-10-25: "all 15 engine
check scripts green, 260 checks total"): identical per-script counts for all
15 M3.5-era scripts — zero drift in coverage — plus `check-validate-push.mjs`
(9 checks), which landed AFTER that record as the SPEC-0013 M2 gate
(`specs/0013-protected-branches.md` §6: "Verified by check-validate-push.mjs
(9)"). That is why the brief's "15 scripts / ~260 checks" reads 16 / 269 on
disk today: the corpus grew, nothing shrank.

Scripted negative-case lines that appear in otherwise-green logs (deliberate
fail-closed fixtures, each followed by its passing assertion — NOT failures):
`check-validate-push.log` `[receive r0] FAILED: Error: rule store unavailable`
(the hook throws mid-check to prove the gate fails closed);
`check-gc.log` six `simulated R2 delete failure (whole)` / `isolate death
mid-R2-delete` lines (fault-injection rows); `check-correctness-tier.log`
`staging failed: Error: pack exceeds maximum push size` (the over-cap 413
case).

## e2e.sh — live-Worker protocol suite

Invoked per `e2e/README.md` against a fresh `pnpm dev` (vite dev, workerd,
`.dev.vars` GIT_TOKEN, healthz 200 in 1 s), shim on PATH:

```
PATH="$PWD/packages/git-engine/e2e/shim:$PATH" \
  packages/git-engine/e2e/e2e.sh http://127.0.0.1:5173/demo devtoken
```

- Wall time 3 s. Closing line: `=== RESULT: 34 passed, 35 failed (workdir
  /tmp/cgit-e2e.bF42CR) ===`, exit 1 (expected — the suite's exit code counts
  the by-design UI failures; CI's allowlist step is the real gate).
- The 35-failure set was extracted exactly the way CI does it
  (`grep '^FAIL:' | sed 's/ (got.*//' | sort`) and diffed against the heredoc
  allowlist in `.github/workflows/ci.yml` (job `e2e`): **set-equal, 35/35,
  empty diff**. The protocol core — push, full/shallow/unshallow clone +
  `fsck --strict`, thin incremental fetch, sideband progress, force push,
  branch create/delete, non-ff rejection, empty-pack branch create, private
  repo clone semantics, repo deletion, auth 401/404 hard checks — is fully
  green against the working tree at HEAD.
- The failure set remains exactly the documented permanently-by-design dgit-UI
  sections (README § "Sections and applicability": 8 snapshots, 9
  patch/rawdiff, 10 UI pages, 11 index-reading assertions, 12's one
  trailing-slash 401-vs-404 check) — unchanged from `3e49974`'s
  re-verification yesterday. Note the dev Worker answered these probes while
  carrying the sibling waves' uncommitted UI edits, further evidence the
  engine passthrough surface is untouched by them.

## Drift note — app-side changes vs engine expectations

Today's headline app-side change, `8828f43` (generate/fork git-wire: the
Worker's `replicateRepoCopy` brokers §5.3 itself — paged copy → unconditional
loose carry with budgeted packed-commit descent ≤64 → finalize), is **app-side
only**: it touches `apps/worker/src/repos/{carry,fork-task,lifecycle.test}.ts`
and `apps/worker/src/api/{routes,services}/generate-repo*`. Verified
implications for this corpus:

1. **No engine script imports app code.** `check-fork-replicate.mjs` — the
   closest neighbor — imports only engine sources (`../src/fork/replicate.ts`,
   `../src/git/*`, `../src/receive/*`) plus the node:sqlite helper. The
   redesign cannot have moved its target, and it is green (50/50). Its pass
   at HEAD positively verifies the engine-level §5.3 primitives
   (`replicateForkCatalog`/`copyObject`, thin-pack parent population through
   the real receive pipeline) that the redesigned app-side broker consumes —
   i.e. the substrate under `8828f43` is healthy.
2. **The redesign deliberately did NOT take the engine alternative**
   (SPEC-0001b §5.3 as-built record, `640c202`: "the deliberately-NOT-taken
   engine alternative") — so there is no engine-behavior delta for the checks
   to have missed. Fixture drift: none.
3. `check-catalog-rpc.mjs`'s comment "a superseded row is listed — the fork
   replication's active-only pages hide it on purpose" describes the ENGINE
   `listPackCatalog` contract (all-states visibility; consumers filter), not
   the app broker's copy loop — still accurate after `8828f43`. Green (10/10).
4. Today's other app-side waves (repo-projects UI `ae32b1a`, lastcommit
   fragment `3502ee4`, blob-excerpt machinery `0db7087`, wrangler svg Text
   rules `4ed30cc`/`52a1f52`) live entirely in the app/Tier-2-UI layer the
   engine checks never import and `e2e.sh` never probes (its UI sections
   scrape the removed dgit URL space, 404 by design). No expectation in any
   script references behavior those commits changed.

**Conclusion: zero failures, zero drift attributable to engine, environment,
or fixture.** The entire corpus at HEAD behaves exactly as recorded at the
2026-10-25 M3.5 gate.

## Timing baseline (for future regression triage)

Same machine, warm FS cache, sequential runs — use ratios, not absolutes:
catalog-rpc 0.110 s < deepen-parse 0.137 s ≈ migrations 0.137 s <
capability-matrix 0.140 s < cache-unreachable 0.177 s < fault-matrix 0.197 s <
compaction ≈ gc 0.218 s < validate-push 0.225 s < segmented-serve 0.263 s <
merge-engine 0.435 s < correctness-tier 0.486 s < read-leases 0.645 s <
fork-replicate 0.891 s < merge-graph 1.497 s < merge-tree 1.696 s.
Family total 7.47 s for 269 checks; `e2e.sh` ~3 s against a warm local dev
Worker. The two slowest scripts are the real-`git`-oracle fixture builders
(`git merge-tree --write-tree` / multi-commit graph fixtures) — expected.

## Open issues

- None engine-side.
- Housekeeping: the M3.5 record in `specs/0011-compaction-gc.md` ("All 15
  engine check scripts green, 260 checks total") predates
  `check-validate-push.mjs`; the canonical count is now 16 scripts / 269
  checks. Candidate one-line touch-up for the next docs/specs wave (not done
  here — verification unit, and that file is outside this unit's ownership).
- The sweep's raw per-script logs live in `/tmp/engine-e2e-sweep-2026-10-26/`
  and will not survive a reboot; the tables above quote every closing summary
  line, which is the durable record.

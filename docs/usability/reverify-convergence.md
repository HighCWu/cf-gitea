# Re-verification: the v1.3.1 convergence wave's test coverage

Re-verified: 2026-10-30, the test-coverage claims of the convergence wave's landed
commits (`fe6d1a8..29ecd1d`, 53 commits — the wave kept moving and
the pin below is the tip as of the first run). Method: every landed fix commit's
suite files executed SOLO (per-cluster `npx vitest run <files>` batches from
`apps/worker`, plus one broad parallel `src/api` run for the flake classes), with
every `Tests` line in this document quoted from THIS verification's own runs. The
full composite gate was deliberately NOT run — the orchestrator runs
`pnpm test:full` at tag time (ADR-0006); solo runs are cheaper and attributable.

## Method and the pinned-worktree disclosure

The main working tree is SHARED and was mid-flight during this verification (sibling
units had uncommitted edits to `packages*`, `issues*`, `pulls*`, `lfs/locks`, a new
staged `services/packages/serve-content.*`, and shared SUT files like `src/index.ts`
and `api/models/repository.ts`). Running the LANDED fixes there would have mixed
landed and unlanded code. So every run below executed in a DETACHED git worktree
pinned at the snapshot tip:

- `git worktree add --detach /tmp/cf-gitea-reverify 29ecd1d` — exactly the committed
  state, immune to sibling edits (the in-flight `0045` migration and staged packages
  files verified absent).
- Account-local gitignored files copied in to match the working posture:
  `wrangler.jsonc`, `.dev.vars` (ADR-0005 D3), `src/ui/icons.generated.ts` (codegen
  output), and `public/assets/` (the 17 MB built asset bundle — see the honest note
  on the 503 below). `node_modules` symlinked from the main tree.
- Command shape: `npx vitest run <files>` from the worktree's `apps/worker`, against
  the repo's `vitest.config.ts` (workerd via @cloudflare/vitest-plugin, real local
  D1/R2 bindings, `hookTimeout`/`testTimeout` 30 s, `maxWorkers: 8`).
- The worktree was removed after verification; no code or test was edited anywhere;
  nothing was committed.

## Headline numbers

- 98 distinct test files executed with a green verdict across the solo batches;
  2,551 individual test results, all passing.
- Per-cluster solo verdicts: ALL PASS (auth 392/392, actions 196/196, api 310/310,
  ui 700/700 across two batches, packages 191/191, plus 56/56 and 372/372 and
  191/191 supplemental batches covering the remaining fix-commits' pin files).
- Flake class "api broad-run beforeAll hook timeouts": REPRODUCED (2 files).
- Flake class "cross-file D1 bleed (pulls-head-repo review POST 500s)": NOT
  reproduced this round — pulls-head-repo passed in BOTH arms; but the broad run
  produced 53 workerd worker deaths and 3 state-shaped test failures in OTHER files
  that all vanish solo (matrix below).
- Coverage gaps found: one landed HIGH-parity fix with ZERO pins anywhere
  (`4e6d1cc`, the archive POST arm); one fix whose degrade arm has no dedicated pin
  (`9f883d0`); one fix whose pins live outside every convergence run list
  (`f8362b1` — found and run green, 56/56).

## Per-cluster tables (commit, suites, solo Tests line, verdict)

Every Tests line below is quoted from this verification's own runs in the pinned
worktree. "Pin files" lists the suites the commit itself touched (from
`git show --name-only`); suites marked (supp) ran in the supplemental batches that
sweep every fix-commit pin file falling outside the cluster lists.

### Cluster 1 — auth (auth/ + git-http/ + session) — PASS

Command: `npx vitest run src/auth src/git-http src/ui/session.test.ts`
→ `Test Files  15 passed (15)` / `Tests  392 passed (392)` / 41.84 s.

| Commit | Fix | Pin files in run |
|---|---|---|
| 56109ec | token-scope gate mounted TREE-WIDE (auth-parity H1) | scope-gate.test.ts (final), misc-t2.test.ts (final), repo-mutation-registry.test.ts (final), api-create-registry.test.ts (final), lifecycle.test.ts (final) |
| 85fa2ff | deploy-key tokens admitted + the GCM-hostile realm switched | deploy-token-service.test.ts, git-http/gate.test.ts, index.test.ts, lifecycle.test.ts (final), push-create.test.ts (final) |
| 69036c8 | session validity idle-sliding + decoupled rotation | ui/session.test.ts |
| 058d76e | B-1 signup/login token-flow disclosure | ui/first-run.test.ts (supp) |
| 1703bc6 | R-1 token-identity self reader profile trio | routes/misc-t2.test.ts (final) |
| cf269f4 | /user serializer seam + username compat key | users.test.ts, follows.test.ts, identity.test.ts, compat/suite.test.ts (api cluster), orgs.test.ts (final), auth/testing/identities.test.ts (auth cluster) |

Verdict: PASS — all 15 auth-cluster files and every auth-fix pin file green.

### Cluster 2 — actions (services/actions/) — PASS

Command: `npx vitest run src/services/actions`
→ `Test Files  10 passed (10)` / `Tests  196 passed (196)` / 29.67 s.

| Commit | Fix | Pin files in run |
|---|---|---|
| e4b9f66 | state machine cancel mapping + the three always-on sweeps | dispatch.test.ts, model.test.ts, sweeps.test.ts |
| e3b55a8 | OIDC audience/subject malformation + dispatch bind ceiling | artifacts.test.ts, dispatch.test.ts, model.test.ts |

Verdict: PASS — all 10 actions suites green (config, ingest, routes, secrets, wire
and the rest ride the same batch).

### Cluster 3 — api (users / follows / identity / releases / tags / compat) — PASS

Command: `npx vitest run src/api/users.test.ts src/api/follows.test.ts
src/api/identity.test.ts src/api/releases.test.ts src/api/routes/tags.test.ts
src/api/compat`
→ `Test Files  7 passed (7)` / `Tests  310 passed (310)` / 28.47 s.

| Commit | Fix | Pin files in run |
|---|---|---|
| 29ecd1d | UpdateRelease ported whole (createTag on every edit, the fill, tri-rule) | releases.test.ts (52/52 of its 310), ui releases.matrix (cluster 4) |
| efd1916 | release row fills sha1/num_commits/created from the TAGGED COMMIT | releases.test.ts |
| 6b2bedc | release with fresh tag_name CREATES its git tag (findings-links N2) | releases.test.ts, compat/suite.test.ts, ui releases.matrix (cluster 4) |
| 40120ae | GET /user renders the self follower/following counts | users.test.ts |
| 9f883d0 | the counts seam degrades instead of 500-ing without a binding | no pin of its own — see coverage gaps |
| 58283bd | topics/licenses stored sets + counts seam + identities swap | follows.test.ts, identity.test.ts, users.test.ts, repository-topics-licenses.test.ts (final) |
| 5365236 | archive export-ignore + zip DEFLATE | api/archive.test.ts (cluster 4), pages-wave32 (cluster 4) |

Verdict: PASS — 310/310. (First cluster attempt pre-asset-copy had releases.test.ts
1/52 red — a WORKTREE ARTIFACT, not landed code; see honest notes.)

### Cluster 4 — ui — PASS (two batches, 22 files)

Commands: `npx vitest run <issues-list.matrix render.test releases.matrix
branches.matrix pages.test index.test goldens a11y api/archive.test wave32>` →
`Test Files  10 passed (10)` / `Tests  517 passed (517)` / 34.12 s; then the 12
`admin-*.matrix.test.tsx` files enumerated explicitly →
`Test Files  12 passed (12)` / `Tests  183 passed (183)` / 27.16 s.
Cluster total: 22 files, 700/700.

| Commit | Fix | Pin files in run |
|---|---|---|
| 7f9241e | branches list order + followers-count premise correction | branches.matrix.test.tsx (22/22), pages-wave17.test.ts (supp), user-profile.matrix.test.ts (supp) |
| 56df8a6 / d52361b | collaborator write-grant + pulls New-PR button + empty-repo arms | issues-list.matrix.test.tsx (31/31), render.test.tsx (24/24) |
| b6abd2a | the link-crawl's four real dead links | admin-orgs.matrix, admin-users.matrix (12/12 each in the admin batch), repo-activity.matrix.test.tsx (supp) |
| 9c4c71a | empty-repo arm flip's two missed pins | ui/index.test.ts (181/181), pages.test.ts (15/15) |
| c69f901 | /api/swagger + spec JSON arms | api-swagger.test.tsx (supp) |
| f561d92 | usability terminal batch (shell/a11y/goldens waves) | a11y.test.ts (88/88), goldens.test.ts (91/91), render, shell.test.tsx (supp), wiki.matrix, forks.matrix, raw-files.matrix, repo-header-actions.test.tsx (supp), repo-wiki.smoke.test.tsx (supp) |
| 0bd9bac | audit sort-arrow negative scope | settings-audit-logs.matrix.test.tsx (supp) |
| 64ebfa9 | cron monitor census + per-arm tick state | cron-state.test.ts (supp), admin-monitor.test.tsx (supp) |
| 1677dbb | git-e2e minors (F6/F9) | routes/user-repos.test.ts (supp), releases.matrix.test.tsx (34/34) |
| 4e6d1cc | archive POST arm (InitiateDownload) | NO pin exists — see coverage gaps; the GET arm is pinned by api/archive.test.ts (20/20) and wave32 (11/11) |
| 65f95f1 | web repo-create demo quota | pages-wave19.test.ts (supp) |
| 74df9ad | USER-scope Packages settings twin + route-clock seam | user-settings-packages.test.tsx (supp), goldens, a11y, settings-nav.test.tsx (final) |

Verdict: PASS — 700/700 across the two batches.

### Cluster 5 — packages (routes/packages* + services/packages/) — PASS

Command: `npx vitest run src/api/routes/packages.test.ts packages-helm
packages-npm packages-nuget packages-pypi src/services/packages`
→ `Test Files  9 passed (9)` / `Tests  191 passed (191)` / 28.13 s.
(The landed tree has 4 services files — `serve-content.*` is a sibling's staged
UNLANDED work and correctly absent at the pin.)

| Commit | Fix | Pin files in run |
|---|---|---|
| 3571fe8 | parity D-1/D-2/D-3 wave | packages.test.ts, packages-helm/-npm/-nuget/-pypi.test.ts, services/packages/blobs.test.ts |
| f8362b1 | cleanup-rule create/edit gate tautological (reverify B-1) | pins live OUTSIDE this cluster — org-settings-packages.test.tsx + user-settings-packages.test.tsx, run separately: `Test Files  2 passed (2)` / `Tests  56 passed (56)` (matches the commit's own "56/56" claim) |

Verdict: PASS — 191/191 + the cleanup-gate pair 56/56.

### Supplemental + final sweep — every remaining fix-commit pin file — PASS

Two batches sweeping all pin files of landed fixes not covered above (the perf
collapse 06b3384 and the security-headers layer cebefa0 among them):

- `npx vitest run` (18 files: first-run, api-swagger, repo-activity.matrix,
  settings-audit-logs.matrix, pages-wave17, pages-wave19, user-profile.matrix,
  shell, wiki.matrix, forks.matrix, raw-files.matrix, repo-header-actions,
  repo-wiki.smoke, admin-monitor, cron-state, routes/user-repos,
  services/repository, routes/pulls) → `Test Files  18 passed (18)` /
  `Tests  372 passed (372)` / 28.45 s.
- `npx vitest run` (10 files: routes/misc-t2, repo-mutation-registry, scope-gate,
  api-create-registry, lifecycle, push-create, orgs, repository-topics-licenses,
  web/security-headers, settings-nav) → `Test Files  10 passed (10)` /
  `Tests  191 passed (191)` / 41.35 s.

With these, EVERY landed fix commit in `fe6d1a8..29ecd1d` that touched a test file
has had its pin files executed green by this verification. The doc/parity-review
commits (0fdc267, 71f56f2, 3646b72, 27654cb, db020f9, 9032c92, e9358fd, d605d3e,
72cc1e0, 4c7e076, 560f0df, 27353a2, b9f537a, 1e17fca, bac61a8) and the two lint-only
commits (c8fbda2, c77effe) have no test surface by nature.

## Flake classes — reproduction evidence and the parallel-vs-solo matrix

Both known classes were exercised with ONE broad parallel run — the exact recorded
trigger condition — followed by solo adjudication of every flagged file:

Command: `npx vitest run src/api` (the full api directory, 89 files, parallel,
`maxWorkers: 8` per vitest.config.ts) →

```
 Test Files  4 failed | 32 passed (89)
      Tests  3 failed | 1144 passed | 56 skipped (1203)
     Errors  53 errors
   Duration  244.81s
    Isolate  89 workers spawned · ~6.24s startup each (spawn + environment, per file)
```

### Class A — "api broad-run beforeAll hook timeouts": REPRODUCED

Two suites died in their `beforeAll` at the 30 s `hookTimeout`, exactly the recorded
class:

- `src/api/routes/activity-feeds.test.ts` — `Error: Hook timed out in 30000ms.` at
  `activity-feeds.test.ts:124` (`beforeAll` applying the D1 migrations).
- `src/api/routes/misc-t3.test.ts` — same error at `misc-t3.test.ts:75`.

SOLO verdicts (own runs): activity-feeds `Tests  19 passed (19)` (11.19 s);
misc-t3 `Tests  37 passed (37)` (10.52 s). Both GREEN solo — the hook that times
out under 89-way workerd spawn contention (~6.24 s startup each) completes in ~2 s
quiet.

### Class B — "cross-file D1 bleed (pulls-head-repo review POST 500s)": NOT reproduced this round

`src/api/services/pulls-head-repo.test.ts` PASSED in the broad run
(`✓ ... (14 tests)` — but at 128,420 ms, 9.6x its 13.33 s solo time: the
contention is visible even where the verdict holds) and passed solo
(`Tests  14 passed (14)`, 13.33 s). No review-POST 500 surfaced in either arm this
round. The class's underlying stressor, however, is real and showed up in its
sibling form:

- 53 of the 89 files lost their workerd worker outright — `Vitest caught 53
  unhandled errors`: `Worker exited unexpectedly during started state while running
  test file ...` (one each, incl. users.test.ts and routes/tags.test.ts — both of
  which PASS in solo and small-batch runs). Those files get NO verdict from a broad
  run; 32 + 4 + 53 = 89.
- 3 state-shaped test failures in surviving files, ALL green solo:
  - `pull-engine.test.ts:1291` — push-comment rows `[]` instead of 1 (the
    PR-head sync round-trip); solo `Tests  39 passed (39)` (43.01 s).
  - `repo-edit.test.ts` — both license re-scan arms; solo
    `Tests  34 passed (34)` (18.66 s).

### The matrix (honest form)

| File | Broad parallel (89-file run) | Solo | Verdict |
|---|---|---|---|
| routes/activity-feeds.test.ts | suite dead (beforeAll hook timeout) | 19/19 | flake (Class A) |
| routes/misc-t3.test.ts | suite dead (beforeAll hook timeout) | 37/37 | flake (Class A) |
| pull-engine.test.ts | 1 test red (push-comment rows) | 39/39 | flake (contention-shaped) |
| repo-edit.test.ts | 2 tests red (license re-scan arms) | 34/34 | flake (contention-shaped) |
| services/pulls-head-repo.test.ts | 14/14 PASS (128.4 s) | 14/14 (13.3 s) | green both arms; 9.6x inflation |
| 53 further files | worker death, NO verdict | green (cluster/supplemental batches) | workerd spawn noise |

Reading: the composite gate's design (per-file attribution + solo re-runs, ADR-0006)
is doing exactly what it was built for — every broad-run red this round adjudicates
green solo, and the two hook-timeout files are the same class the vitest.config.ts
hookTimeout comment records (its "4 beforeAll hooks crossed 20s in one run" family).
No new real (solo-stable) failure was found anywhere in the wave's surface.

## Coverage gaps (features landed today with thin pins)

1. **`4e6d1cc` — the archive POST arm has ZERO pins.** The fix (the parity review's
   one adapter-owned HIGH: the web bundle's archive button POSTs
   `/{owner}/{repo}/archive/*` first and aborted on the GET-only mount) added 28
   lines to `src/ui/index.ts` and touched NO test file. A corpus-wide grep of the
   pinned tree finds no suite issuing the POST or asserting the upstream fast-path
   `{"complete":true}` body — every "archived POST" hit in the suites is the
   UNRELATED archived-REPO refusal family. The GET download arm is well pinned
   (api/archive.test.ts 20/20 incl. the DEFLATE/CRC round-trip; wave32 11/11), so a
   regression of the POST mount would pass every suite silently. Recommended: one
   pin in ui/index.test.ts (POST → 200 + JSON body, sameOriginGuard arm).
2. **`9f883d0` — the counts-seam degrade arm has no dedicated pin.** The fix makes
   the `/user` follower/following counts best-effort (no binding / lookup failure →
   the auth middleware's sync render, never 500). It is exercised only INCIDENTALLY:
   api.test.ts's no-env rig would 500 without the fix (that is how the bug was
   caught), but no pin asserts the fallback CONTENT (counts absent/degraded under a
   missing binding, present under a real one). Thin, not absent.
3. **`06b3384` — the /user/settings perf collapse is measured, not pinned.** No pin
   guards the page's D1 round-count; the page's behavioral pins predate the change
   and stayed green (user-profile.matrix, supp batch). Acceptable for a perf-only
   change; noted so the 3-4x win has no regression tripwire.
4. **`f8362b1` — the cleanup-gate fix's pins live outside every convergence run
   list.** The tautological-gate fix's actual pins are
   org-settings-packages.test.tsx + user-settings-packages.test.tsx (56/56, verified
   here green) — neither file was in the wave's cluster definitions. Not a missing
   pin; a reminder that cluster run-lists under-sample UI settings suites.

## Honest notes

- The api cluster's FIRST run (before the built-asset copy) failed
  releases.test.ts:392 1/52: `expected 503 to be 200` on the full-worker
  `SELF.fetch` of `/src/tag/n2-ui`. Root cause was the WORKTREE, not the landed
  code: the UI shell's asset manifest maps a missing bundle to the 503
  "assets not built" answer (`ui/manifest.ts` AssetBuildError path), and
  `public/assets/` is gitignored build output absent from a fresh worktree. After
  copying the bundle, releases.test.ts passes solo (`Tests  52 passed (52)`) and the
  whole api cluster re-ran green (`Tests  310 passed (310)`). Recorded because it is
  a real property of the product: any UI-page pin is one missing assets dir away
  from a 503, and a bare checkout cannot run the UI-page suites without a build.
- The broad run ended with vitest's teardown warning "Tests closed successfully but
  something prevents 2 Vite servers from exiting" — the same workerd-contention
  noise as the worker deaths, cosmetic here.
- The 56 skipped tests in the broad run are the suites' designed skip arms, not
  failures.
- Solo batch wall-times are quiet-box figures; the broad run's 128 s
  pulls-head-repo file shows the contention factor (~2-10x) the shared runner box
  can add during the composite gate.
- No fixes were applied and nothing was committed from this verification. The
  pinned worktree at /tmp/cf-gitea-reverify was removed after the last run.
